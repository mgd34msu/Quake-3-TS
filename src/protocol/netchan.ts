// Port of id Software's qcommon/net_chan.c, client/cl_net_chan.c and server/sv_net_chan.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { MAX_MESSAGE_LENGTH, MessageReader, MessageWriter } from "./message.ts";
import type { SourceMessageState } from "./message.ts";

export const FRAGMENT_SIZE = 1300;
export const MAX_PACKET_LENGTH = 1400;
export type ChannelRole = "client" | "server";
export interface ChannelDelivery {
  readonly sourceState?: SourceMessageState;
  send(datagram: Uint8Array): undefined;
  trace(message: string): undefined;
}
export interface ChannelDiagnostics {
  readonly showPackets: boolean;
  readonly showDrop: boolean;
  readonly remoteAddress: string;
  print(message: string): undefined;
}
export type ChannelResult =
  | { readonly kind: "accepted"; readonly sequence: number; readonly qport: number | null; readonly dropped: number; readonly payload: Uint8Array }
  | { readonly kind: "fragment"; readonly sequence: number; readonly received: number }
  | { readonly kind: "rejected"; readonly reason: "malformed" | "sequence" | "fragment-order" | "fragment-length" };

export class Netchannel {
  private incoming = 0;
  private outgoing = 1;
  private dropped = 0;
  private fragmentSequence = 0;
  private fragmentLength = 0;
  private readonly fragments = new Uint8Array(MAX_MESSAGE_LENGTH);
  private readonly unsentBuffer = new Uint8Array(MAX_MESSAGE_LENGTH);
  private unsentLength = 0;
  private unsentStart = 0;
  private unsentFragments = false;
  private delivering = false;

  constructor(readonly role: ChannelRole, readonly qport = 0, private readonly transmitQport: () => number = () => qport) {
    if (!Number.isInteger(qport) || qport < 0 || qport > 65535) throw new RangeError("qport must be an unsigned short");
  }
  /** A cleared client_t bot channel never passes through Netchan_Setup. */
  static sourceZero(): Netchannel {
    const channel = new Netchannel("client");
    channel.outgoing = 0;
    return channel;
  }
  get incomingSequence(): number { return this.incoming; }
  get outgoingSequence(): number { return this.outgoing; }
  get hasUnsentFragments(): boolean { return this.unsentFragments; }
  get remainingUnsentBytes(): number { return this.unsentLength - this.unsentStart; }

  /** Netchan_Transmit emits only the first fragment; the owner controls subsequent pacing. */
  beginTransmit(payload: Uint8Array, delivery: ChannelDelivery): undefined {
    this.assertDeliveryEntry();
    if (payload.length > MAX_MESSAGE_LENGTH) throw new RangeError("Netchannel message too large");
    if (this.outgoing > 0x7fffffff) throw new RangeError("Netchannel sequence exhausted; reconnect required");
    this.unsentStart = 0;
    if (payload.length >= FRAGMENT_SIZE) {
      this.unsentFragments = true;
      this.unsentLength = payload.length;
      this.unsentBuffer.set(payload);
      this.transmitNextFragment(delivery);
      return;
    }
    const packet = this.packet(payload, false, 0, delivery.sourceState ?? null);
    this.outgoing++;
    this.delivering = true;
    try {
      delivery.send(packet);
      delivery.trace(`${this.role} send ${String(packet.length).padStart(4)} : s=${this.outgoing - 1} ack=${this.incoming}\n`);
    } finally { this.delivering = false; }
  }

  private assertDeliveryEntry(): void {
    if (this.delivering) throw new Error("Cannot reenter channel delivery");
  }

  transmitNextFragment(delivery: ChannelDelivery): boolean {
    this.assertDeliveryEntry();
    const length = Math.min(FRAGMENT_SIZE, this.unsentLength - this.unsentStart);
    const packet = this.packet(this.unsentBuffer.subarray(this.unsentStart, this.unsentStart + length), true, this.unsentStart, delivery.sourceState ?? null);
    this.delivering = true;
    try {
      delivery.send(packet);
      delivery.trace(`${this.role} send ${String(packet.length).padStart(4)} : s=${this.outgoing} fragment=${this.unsentStart},${length}\n`);
    } finally { this.delivering = false; }
    this.unsentStart += length;
    if (this.unsentStart === this.unsentLength && length !== FRAGMENT_SIZE) {
      this.outgoing++;
      this.unsentFragments = false;
    }
    return true;
  }

  /** Convenience for loopback/testing owners that can send all fragments immediately. */
  transmit(payload: Uint8Array): Uint8Array[] {
    const packets: Uint8Array[] = [], traces: string[] = [];
    const delivery: ChannelDelivery = { send: packet => { packets.push(packet); }, trace: message => { traces.push(message); } };
    this.beginTransmit(payload, delivery);
    while (this.hasUnsentFragments) this.transmitNextFragment(delivery);
    return packets;
  }

  private packet(payload: Uint8Array, fragmented: boolean, start: number, sourceState: SourceMessageState | null): Uint8Array {
    const message = new MessageWriter("oob", MAX_PACKET_LENGTH, sourceState);
    message.writeLong(this.outgoing | (fragmented ? 0x80000000 : 0));
    if (this.role === "client") message.writeShort(this.transmitQport());
    if (fragmented) {
      message.writeShort(start);
      message.writeShort(payload.length);
    }
    message.writeData(payload);
    return message.toBytes();
  }

  /** Address and qport routing precede this operation, just as in the engine packet dispatch. */
  receive(packet: Uint8Array, diagnostics: ChannelDiagnostics | null = null): ChannelResult {
    const baseHeader = this.role === "server" ? 6 : 4;
    if (packet.length < baseHeader || packet.length > MAX_MESSAGE_LENGTH) return { kind: "rejected", reason: "malformed" };
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const wireSequence = view.getUint32(0, true);
    const fragmented = (wireSequence & 0x80000000) !== 0;
    const sequence = wireSequence & 0x7fffffff;
    const qport = this.role === "server" ? view.getUint16(4, true) : null;
    if (fragmented && packet.length < baseHeader + 4) return { kind: "rejected", reason: "malformed" };
    const start = fragmented ? view.getInt16(baseHeader, true) : 0;
    const length = fragmented ? view.getInt16(baseHeader + 2, true) : 0;
    if (diagnostics !== null && diagnostics.showPackets) {
      diagnostics.print(fragmented
        ? `${this.role} recv ${String(packet.length).padStart(4)} : s=${sequence} fragment=${start},${length}\n`
        : `${this.role} recv ${String(packet.length).padStart(4)} : s=${sequence}\n`);
    }
    if (sequence <= this.incoming) {
      if (diagnostics !== null && (diagnostics.showDrop || diagnostics.showPackets))
        diagnostics.print(`${diagnostics.remoteAddress}:Out of order packet ${sequence} at ${this.incoming}\n`);
      return { kind: "rejected", reason: "sequence" };
    }
    this.dropped = sequence - (this.incoming + 1);
    if (this.dropped > 0 && diagnostics !== null && (diagnostics.showDrop || diagnostics.showPackets))
      diagnostics.print(`${diagnostics.remoteAddress}:Dropped ${this.dropped} packets at ${sequence}\n`);
    if (!fragmented) {
      this.incoming = sequence;
      return { kind: "accepted", sequence, qport, dropped: this.dropped, payload: new Uint8Array(packet.subarray(baseHeader)) };
    }
    if (sequence !== this.fragmentSequence) {
      this.fragmentSequence = sequence;
      this.fragmentLength = 0;
    }
    if (start !== this.fragmentLength) {
      if (diagnostics !== null && (diagnostics.showDrop || diagnostics.showPackets))
        diagnostics.print(`${diagnostics.remoteAddress}:Dropped a message fragment\n`);
      return { kind: "rejected", reason: "fragment-order" };
    }
    const header = baseHeader + 4;
    if (length < 0 || length > packet.length - header || this.fragmentLength + length > MAX_MESSAGE_LENGTH) {
      if (diagnostics !== null && (diagnostics.showDrop || diagnostics.showPackets))
        diagnostics.print(`${diagnostics.remoteAddress}:illegal fragment length\n`);
      return { kind: "rejected", reason: "fragment-length" };
    }
    this.fragments.set(packet.subarray(header, header + length), this.fragmentLength);
    this.fragmentLength += length;
    if (length === FRAGMENT_SIZE) return { kind: "fragment", sequence, received: this.fragmentLength };
    const payload = this.fragments.slice(0, this.fragmentLength);
    this.fragmentLength = 0;
    this.incoming = sequence;
    return { kind: "accepted", sequence, qport, dropped: this.dropped, payload };
  }
}

function xorPayload(payload: Uint8Array, start: number, initialKey: number, command: string): Uint8Array {
  const output = new Uint8Array(payload);
  const view = new DataView(output.buffer);
  const nul = command.indexOf("\0");
  const length = nul === -1 ? command.length : nul;
  let key = initialKey & 255;
  let index = 0;
  for (let i = start; i < output.length; i++) {
    if (index >= length) index = 0;
    const char = length === 0 ? 0 : command.charCodeAt(index);
    key ^= ((char > 127 || char === 37 ? 46 : char) << (i & 1)) & 255;
    index++;
    view.setUint8(i, view.getUint8(i) ^ key);
  }
  return output;
}

/** CL_Encode / SV_Decode on a payload without the even-length netchannel header. */
export function xorClientMessage(payload: Uint8Array, challenge: number, serverCommand: (reliableAcknowledge: number) => string): Uint8Array {
  if (payload.length <= 12) return new Uint8Array(payload);
  const reader = new MessageReader(payload);
  const serverId = reader.readLong();
  const acknowledge = reader.readLong();
  const reliable = reader.readLong();
  return xorPayload(payload, 12, challenge ^ serverId ^ acknowledge, serverCommand(reliable));
}

/** SV_Encode / CL_Decode; callers select the acknowledged client command from connection history. */
export function xorServerMessage(payload: Uint8Array, challenge: number, sequence: number, clientCommand: string): Uint8Array {
  return xorPayload(payload, 4, challenge ^ sequence, clientCommand);
}
