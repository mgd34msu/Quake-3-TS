// Port of id Software's common.c/unix_main.c sysEvent_t payload ownership.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import { sourceCommandText } from "../core/text.ts";
import { ZoneTag } from "../core/zone.ts";
import type { ZoneAllocation, ZoneArena } from "../core/zone.ts";
import type { Ipv4Address } from "../platform/network.ts";
import type { CommonSystemEvent } from "./common-events.ts";

export const COMMON_EVENT_ADDRESS_BYTES = 20;
type QueuedEvent = Exclude<CommonSystemEvent, { readonly kind: "none" }>;
type ConsoleEvent = Extract<CommonSystemEvent, { readonly kind: "console" }>;
type PacketEvent = Extract<CommonSystemEvent, { readonly kind: "packet" }>;

export interface CommonEventAllocation {
  readonly arena: ZoneArena;
  readonly block: ZoneAllocation;
}

function consoleText(pointer: CommonEventAllocation | null): string {
  if (pointer === null) throw new CommonError("fatal", "Console event has no payload pointer");
  const bytes = pointer.block.bytes, end = bytes.indexOf(0);
  if (end === -1) throw new CommonError("fatal", "Journal console event has no terminating NUL");
  let text = "";
  for (const byte of bytes.subarray(0, end)) text += String.fromCharCode(byte);
  return text;
}

function packetBytes(pointer: CommonEventAllocation | null): Uint8Array {
  if (pointer === null) throw new CommonError("fatal", "Packet event has no payload pointer");
  const bytes = pointer.block.bytes;
  if (bytes.byteLength < COMMON_EVENT_ADDRESS_BYTES) throw new CommonError("fatal", "Journal packet event has a truncated netadr_t");
  return bytes;
}

function packetAddress(pointer: CommonEventAllocation | null): Ipv4Address {
  const bytes = packetBytes(pointer), view = new DataView(bytes.buffer, bytes.byteOffset, COMMON_EVENT_ADDRESS_BYTES);
  const family = view.getInt32(0, true);
  if (family !== 4) throw new CommonError("fatal", `Journal packet address type ${family} is unsupported by the IPv4 system event owner`);
  return { kind: "ipv4", host: [view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)], port: view.getUint16(18, false) };
}

/** Shared main-zone pointers survive sysEvent_t value copies until a reached Z_Free. */
export class CommonEventMemory {
  private readonly pointers = new WeakMap<CommonSystemEvent, CommonEventAllocation | null>();

  constructor(private readonly mainZone: () => ZoneArena) {}

  allocatePayload(length: number): CommonEventAllocation {
    const arena = this.mainZone();
    return { arena, block: arena.allocate(length, ZoneTag.General, true) };
  }

  payload(event: CommonSystemEvent): Uint8Array | null { return this.pointers.get(event)?.block.bytes ?? null; }

  free(event: CommonSystemEvent): void {
    const pointer = this.pointers.get(event);
    if (pointer !== undefined && pointer !== null) pointer.arena.free(pointer.block);
  }

  console(time: number, input: string): ConsoleEvent {
    const text = sourceCommandText(input), pointer = this.allocatePayload(text.length + 1), bytes = pointer.block.bytes;
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return this.consolePointer(time, pointer);
  }

  packet(time: number, from: Ipv4Address, payload: Uint8Array): PacketEvent {
    const pointer = this.allocatePayload(COMMON_EVENT_ADDRESS_BYTES + payload.byteLength), bytes = pointer.block.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, COMMON_EVENT_ADDRESS_BYTES);
    view.setInt32(0, 4, true);
    bytes.set(from.host, 4);
    view.setUint16(18, from.port, false);
    bytes.set(payload, COMMON_EVENT_ADDRESS_BYTES);
    return this.packetPointer(time, pointer);
  }

  /** Diagnostic event sources enter the production owner at Com_GetRealEvent. */
  own(event: CommonSystemEvent): CommonSystemEvent {
    if (this.pointers.has(event)) return event;
    if (event.kind === "console") return this.console(event.time, event.text);
    if (event.kind === "packet") return this.packet(event.time, event.from, event.payload);
    return event;
  }

  copy(event: QueuedEvent, time?: number): QueuedEvent;
  copy(event: CommonSystemEvent, time?: number): CommonSystemEvent;
  copy(event: CommonSystemEvent, time = event.time): CommonSystemEvent {
    const pointer = this.pointers.get(event);
    let copied: CommonSystemEvent;
    switch (event.kind) {
      case "none": copied = Object.freeze({ kind: "none", time }); break;
      case "key": copied = Object.freeze({ kind: "key", time, key: event.key, down: event.down }); break;
      case "character": copied = Object.freeze({ kind: "character", time, character: event.character }); break;
      case "mouse": copied = Object.freeze({ kind: "mouse", time, dx: event.dx, dy: event.dy }); break;
      case "joystick": copied = Object.freeze({ kind: "joystick", time, axis: event.axis, value: event.value }); break;
      case "console": return pointer === undefined ? Object.freeze({ kind: "console", time, text: event.text }) : this.consolePointer(time, pointer);
      case "packet": return pointer === undefined ? Object.freeze({ kind: "packet", time, from: event.from, payload: event.payload }) : this.packetPointer(time, pointer);
    }
    return this.retain(copied, pointer ?? null);
  }

  journalEvent(header: DataView, pointer: CommonEventAllocation | null): CommonSystemEvent {
    const time = header.getInt32(0, true), type = header.getInt32(4, true);
    const value = header.getInt32(8, true), value2 = header.getInt32(12, true);
    let event: CommonSystemEvent;
    switch (type) {
      case 0: event = { kind: "none", time }; break;
      case 1: event = { kind: "key", time, key: value, down: value2 !== 0 }; break;
      case 2: event = { kind: "character", time, character: value }; break;
      case 3: event = { kind: "mouse", time, dx: value, dy: value2 }; break;
      case 4: event = { kind: "joystick", time, axis: value, value: value2 }; break;
      case 5: return this.consolePointer(time, pointer);
      case 6: return this.packetPointer(time, pointer);
      default: throw new CommonError("fatal", `Unsupported journal event type ${type}`);
    }
    return this.retain(Object.freeze(event), pointer);
  }

  private consolePointer(time: number, pointer: CommonEventAllocation | null): ConsoleEvent {
    return this.retain(Object.freeze({ kind: "console", time, get text() { return consoleText(pointer); } }), pointer);
  }

  private packetPointer(time: number, pointer: CommonEventAllocation | null): PacketEvent {
    return this.retain(Object.freeze({ kind: "packet", time, get from() { return packetAddress(pointer); },
      get payload() { return packetBytes(pointer).subarray(COMMON_EVENT_ADDRESS_BYTES); } }), pointer);
  }

  private retain<T extends CommonSystemEvent>(event: T, pointer: CommonEventAllocation | null): T {
    this.pointers.set(event, pointer);
    return event;
  }
}
