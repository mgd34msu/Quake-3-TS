// SPDX-License-Identifier: GPL-2.0-or-later
// Replaces unix/unix_net.c Sys_GetPacket/Sys_SendPacket with owned Bun UDP sockets.
import type { udp } from "bun";
import { getSystemErrorName } from "node:util";
import { MAX_MESSAGE_LENGTH } from "../protocol/message.ts";
import { readSocksDatagram, SocksAssociation, socksDatagram } from "./socks.ts";
import type { SocksOptions } from "./socks.ts";

// Sys_GetPacket rejects a receive filling sys_packetReceived[MAX_MSGLEN].
export const MAX_DATAGRAM_LENGTH = MAX_MESSAGE_LENGTH - 1;
// Adaptation of unix_main.c Sys_QueEvent: a packet-only queue, not its mixed queue.
export const MAX_QUEUED_DATAGRAMS = 256;
export type Ipv4Host = readonly [number, number, number, number];
export interface Ipv4Address { readonly kind: "ipv4"; readonly host: Ipv4Host; readonly port: number }
export interface UdpBindOptions {
  readonly host: Ipv4Host;
  readonly port: number;
  readonly now?: () => number;
  readonly print?: (text: string) => undefined;
}
export type UdpReceiveEvent =
  | { readonly kind: "packet"; readonly from: Ipv4Address; readonly payload: Uint8Array; readonly receivedAt: number }
  | { readonly kind: "error"; readonly error: Error };
type QueuedReceive = UdpReceiveEvent | { readonly kind: "oversize"; readonly from: Ipv4Address; readonly prefix: Uint8Array };
export interface UdpStatistics {
  readonly received: number;
  readonly oversizeDropped: number;
  readonly overflowDropped: number;
  readonly errors: number;
  readonly pending: number;
}

/** Native callback data/clock failures are not recoverable socket receive errors. */
export class UdpReceiveInvariantError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "UdpReceiveInvariantError";
  }
}

/** Bun 1.3.14 supplies error first at runtime; its declarations put it second. */
export function normalizeUdpError(first: unknown, second: unknown): Error {
  if (first instanceof Error) return first;
  if (second instanceof Error) return second;
  return new UdpReceiveInvariantError(new Error("Bun UDP callback supplied no Error"));
}

function isNativeSendError(error: unknown): error is Error {
  return error instanceof Error && !(error instanceof TypeError) && !(error instanceof RangeError)
    && "syscall" in error && error.syscall === "send"
    && "errno" in error && typeof error.errno === "number" && Number.isSafeInteger(error.errno) && error.errno < 0
    && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code)
    && getSystemErrorName(error.errno) === error.code;
}

function checkedAddress(host: Ipv4Host, port: number, allowZeroPort: boolean): Ipv4Address {
  if (host.length !== 4 || host.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) throw new RangeError("IPv4 host must have four integer octets in 0..255");
  if (!Number.isInteger(port) || port < (allowZeroPort ? 0 : 1) || port > 65535) throw new RangeError("IPv4 port is outside the valid range");
  const owned: Ipv4Host = [host[0], host[1], host[2], host[3]];
  return Object.freeze({ kind: "ipv4", host: Object.freeze(owned), port });
}

function nativeAddress(hostname: string, port: number): Ipv4Address {
  const parts = hostname.split(".");
  const [a, b, c, d] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined || parts.some(part => !/^\d{1,3}$/.test(part))) throw new Error(`UDP supplied a non-IPv4 address: ${hostname}`);
  return checkedAddress([Number(a), Number(b), Number(c), Number(d)], port, false);
}

class ReceivedPackets {
  private events: QueuedReceive[] = [];
  private readonly readableListeners = new Set<() => undefined>();
  private closed = false;
  private lastTime = -Infinity;
  private received = 0;
  private oversizeDropped = 0;
  private overflowDropped = 0;
  private errors = 0;

  constructor(private readonly now: () => number) {}

  accept(payload: Uint8Array, port: number, hostname: string, truncated: boolean): void {
    if (this.closed) return;
    let event: QueuedReceive;
    try {
      const from = nativeAddress(hostname, port);
      if (truncated || payload.byteLength > MAX_DATAGRAM_LENGTH) {
        this.oversizeDropped++;
        event = { kind: "oversize", from, prefix: payload.slice(0, 10) };
      } else {
        const receivedAt = this.now();
        if (!Number.isFinite(receivedAt) || receivedAt < 0 || receivedAt < this.lastTime) throw new Error("UDP receive clock must be finite, nonnegative and monotonic");
        this.lastTime = receivedAt;
        this.received++;
        event = { kind: "packet", from, payload: new Uint8Array(payload), receivedAt };
      }
    } catch (error) { this.fail(new UdpReceiveInvariantError(error)); return; }
    // A listener failure is not a receive error and must not recursively notify it.
    this.append(event);
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.errors++;
    this.append({ kind: "error", error });
  }

  private append(event: QueuedReceive): void {
    if (this.events.length === MAX_QUEUED_DATAGRAMS) {
      this.events.shift();
      this.overflowDropped++;
    }
    this.events.push(event);
    for (const listener of [...this.readableListeners]) {
      if (this.readableListeners.has(listener)) listener();
    }
  }

  subscribeReadable(listener: () => undefined): () => undefined {
    const subscription = (): undefined => listener();
    this.readableListeners.add(subscription);
    return () => { this.readableListeners.delete(subscription); };
  }

  poll(): QueuedReceive | null { return this.events.shift() ?? null; }
  get statistics(): UdpStatistics {
    return { received: this.received, oversizeDropped: this.oversizeDropped, overflowDropped: this.overflowDropped, errors: this.errors, pending: this.events.length };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.events = [];
    const listeners = [...this.readableListeners];
    this.readableListeners.clear();
    const errors: unknown[] = [];
    for (const listener of listeners) { try { listener(); } catch (error) { errors.push(error); } }
    if (errors.length > 0) throw new AggregateError(errors, "UDP readable close notification failed");
  }
}

export class UdpTransport {
  private closed = false;
  private socks: SocksAssociation | null = null;
  private constructor(private readonly socket: udp.Socket<"uint8array">, private readonly received: ReceivedPackets,
    readonly address: Ipv4Address, private readonly print: (text: string) => undefined) {}

  static async bind(options: UdpBindOptions): Promise<UdpTransport> {
    const bindAddress = checkedAddress(options.host, options.port, true);
    const received = new ReceivedPackets(options.now ?? (() => performance.now()));
    let socket: udp.Socket<"uint8array"> | null = null;
    try {
      socket = await Bun.udpSocket({
        hostname: bindAddress.host.join("."), port: bindAddress.port, binaryType: "uint8array",
        socket: {
          data(_socket, payload, port, hostname, flags) { received.accept(payload, port, hostname, flags.truncated); },
          error(first: unknown, second: unknown) { received.fail(normalizeUdpError(first, second)); },
        },
      });
      // Unix NET_IPSocket enables SO_BROADCAST before bind; Bun exposes it only on the bound socket.
      if (!socket.setBroadcast(true)) throw new Error("UDP socket could not enable SO_BROADCAST");
      return new UdpTransport(socket, received, nativeAddress(socket.hostname, socket.port),
        options.print ?? (text => { process.stdout.write(text); }));
    } catch (error) { received.close(); socket?.close(); throw error; }
  }

  private opened(): void { if (this.closed) throw new Error("UDP transport is closed"); }

  /** Counters last for this socket's lifetime; close clears only pending events. */
  get statistics(): UdpStatistics { return this.received.statistics; }

  /** NET_OpenSocks failure retains the direct UDP socket. */
  async connectSocks(options: SocksOptions): Promise<void> {
    this.opened();
    this.socks?.close();
    const association = new SocksAssociation();
    this.socks = association;
    this.print("Opening connection to SOCKS server.\n");
    try { await association.open(options, this.address.port); this.opened(); }
    catch {
      association.close();
      if (this.socks === association) this.socks = null;
      this.opened();
      this.print("NET_OpenSocks: negotiation failed\n");
    }
  }

  send(to: Ipv4Address, payload: Uint8Array): boolean {
    this.opened();
    let destination = checkedAddress(to.host, to.port, true);
    if (payload.byteLength > MAX_DATAGRAM_LENGTH) throw new RangeError("UDP datagram exceeds the source receive limit");
    // The owned copy also isolates caller mutations while the native send completes.
    const relay = this.socks?.relay;
    const proxied = relay !== undefined && relay !== null && !destination.host.every(octet => octet === 255);
    const bytes = proxied ? socksDatagram(destination, payload) : new Uint8Array(payload);
    if (proxied) destination = relay;
    const hostname = destination.host.join(".");
    try { return this.socket.send(bytes, destination.port, hostname); }
    catch (error) {
      if (!isNativeSendError(error)) throw error;
      // Sys_SendPacket reports every sendto failure, including ECONNREFUSED.
      this.print(`NET_SendPacket ERROR: ${error.message} to ${hostname}:${destination.port}\n`);
      return false;
    }
  }

  poll(): UdpReceiveEvent | null {
    this.opened();
    const event = this.received.poll();
    const relay = this.socks?.relay;
    const fromRelay = event !== null && event.kind !== "error" && relay !== undefined && relay !== null
      && event.from.port === relay.port && event.from.host.every((octet, index) => octet === relay.host[index]);
    if (event?.kind === "oversize") {
      const from = fromRelay ? readSocksDatagram(event.prefix)?.from : event.from;
      if (from !== undefined) this.print(`Oversize packet from ${from.host.join(".")}:${from.port}\n`);
      return null;
    }
    if (event?.kind === "packet" && fromRelay) {
      const packet = readSocksDatagram(event.payload);
      return packet === null ? null : { kind: "packet", ...packet, receivedAt: event.receivedAt };
    }
    return event;
  }

  /** Edge notification only: inspect pending after subscribing. Close also wakes readers. */
  subscribeReadable(listener: () => undefined): () => undefined {
    this.opened();
    return this.received.subscribeReadable(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socks?.close(); this.socks = null;
    try { this.received.close(); }
    finally { this.socket.close(); }
  }
}
