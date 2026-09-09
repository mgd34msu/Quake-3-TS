// Port of id Software's code/qcommon/net_chan.c NET_SendLoopPacket/NET_GetLoopPacket.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { MAX_PACKET_LENGTH } from "./netchan.ts";
import type { ChannelRole } from "./netchan.ts";

export const MAX_LOOPBACK_PACKETS = 16;
export interface LoopbackAddress { readonly kind: "loopback" }
export interface LoopbackPacket { readonly from: LoopbackAddress; readonly payload: Uint8Array }

class LoopbackQueue {
  private readonly slots: (Uint8Array | null)[] = Array.from({ length: MAX_LOOPBACK_PACKETS }, () => null);
  private read = 0;
  private write = 0;
  private count = 0;

  send(payload: Uint8Array): void {
    this.slots[this.write] = new Uint8Array(payload);
    this.write = (this.write + 1) & (MAX_LOOPBACK_PACKETS - 1);
    // Equivalent to NET_GetLoopPacket advancing get to send - MAX_LOOPBACK.
    if (this.count === MAX_LOOPBACK_PACKETS) this.read = this.write;
    else this.count++;
  }

  poll(): Uint8Array | null {
    if (this.count === 0) return null;
    const packet = this.slots[this.read];
    if (packet === null || packet === undefined) throw new Error("Loopback queue slot is empty");
    this.slots[this.read] = null;
    this.read = (this.read + 1) & (MAX_LOOPBACK_PACKETS - 1);
    this.count--;
    return packet;
  }
}

export class LoopbackTransport {
  private readonly client = new LoopbackQueue();
  private readonly server = new LoopbackQueue();

  send(from: ChannelRole, payload: Uint8Array): void {
    if (payload.length > MAX_PACKET_LENGTH) throw new RangeError("Loopback packet exceeds MAX_PACKETLEN");
    (from === "client" ? this.server : this.client).send(payload);
  }

  poll(endpoint: ChannelRole): LoopbackPacket | null {
    const payload = (endpoint === "client" ? this.client : this.server).poll();
    return payload === null ? null : { from: { kind: "loopback" }, payload };
  }
}
