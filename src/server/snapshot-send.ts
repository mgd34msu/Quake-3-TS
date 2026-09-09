// Port of id Software's server/sv_snapshot.c snapshot sending and rate scheduling.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarRegistry } from "../core/cvar.ts";
import { MAX_MESSAGE_LENGTH, MessageWriter } from "../protocol/message.ts";
import { ServerOpcode } from "../protocol/server-message.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { ServerDownloadRuntime } from "./downloads.ts";
import type { ServerNetChannelRuntime, ServerPacketAddress } from "./net-channel.ts";
import type { ServerSnapshotRuntime } from "./snapshots.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerClient } from "./state.ts";

export interface ServerSnapshotSendHost {
  readonly cvars: Pick<CvarRegistry, "get" | "set">;
  readonly downloads: Pick<ServerDownloadRuntime, "writeToClient">;
  isLanAddress(address: ServerPacketAddress): boolean;
  print(text: string): void;
}

/** Scheduling reads the live source cvars/time and never owns a second client or frame ring. */
export class ServerSnapshotSendRuntime {
  constructor(readonly snapshots: ServerSnapshotRuntime, readonly channel: ServerNetChannelRuntime, readonly host: ServerSnapshotSendHost) {
    if (snapshots.staticState !== channel.state) throw new Error("Snapshot sender and channel must share server state");
  }
  private connection(client: ServerClient) {
    if (this.snapshots.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this snapshot sender");
    if (client.connection.kind !== "initialized") throw new Error("Snapshot sender client channel is uninitialized");
    return client.connection;
  }
  private integer(name: string): number {
    const cvar = this.host.cvars.get(name);
    if (cvar === undefined) throw new Error(`Snapshot sender requires registered cvar ${name}`);
    return cvar.integerValue;
  }
  rateMsec(client: ServerClient, messageSize: number): number {
    this.connection(client);
    if (!Number.isInteger(messageSize) || messageSize < 0 || messageSize > 0x7fffffff) throw new RangeError("Snapshot rate requires a nonnegative int32 message size");
    if (messageSize > 1500) messageSize = 1500;
    let rate = client.rate;
    if (this.integer("sv_maxRate") !== 0) {
      if (this.integer("sv_maxRate") < 1000) this.host.cvars.set("sv_MaxRate", "1000", true);
      if (this.integer("sv_maxRate") < rate) rate = this.integer("sv_maxRate");
    }
    if (rate === 0) throw new RangeError("Snapshot rate division by zero");
    return Math.trunc(Math.imul((messageSize + 48) | 0, 1000) / rate) | 0;
  }

  sendMessageToClient(client: ServerClient, message: MessageWriter): void {
    const initial = this.connection(client), statics = this.snapshots.staticState;
    const frame = client.frames[initial.netchan.outgoingSequence & 31];
    if (frame === undefined) throw new Error("Missing server packet frame");
    frame.messageSize = message.byteLength; frame.messageSent = statics.time; frame.messageAcked = -1;
    this.channel.transmit(client, { kind: "writer", message });
    const address = this.connection(client).address;
    if (address.kind === "loopback" || (this.integer("sv_lanForceRate") !== 0 && address.kind !== "bot" && this.host.isLanAddress(address))) {
      client.nextSnapshotTime = (statics.time - 1) | 0;
      return;
    }
    let rateMsec = this.rateMsec(client, message.byteLength);
    if (rateMsec < client.snapshotMsec) { rateMsec = client.snapshotMsec; client.rateDelayed = false; }
    else client.rateDelayed = true;
    client.nextSnapshotTime = (statics.time + rateMsec) | 0;
    if (client.phase !== ServerClientPhase.Active && !client.download.name && client.nextSnapshotTime < ((statics.time + 1000) | 0)) {
      client.nextSnapshotTime = (statics.time + 1000) | 0;
    }
  }

  sendClientSnapshot(client: ServerClient): void {
    this.snapshots.buildClientSnapshot(client);
    const entity = this.snapshots.world.gameEntity(client);
    if (entity !== null && (entity.r.svFlags & ServerEntityFlags.BOT)) return;
    const message = new MessageWriter("bitstream", MAX_MESSAGE_LENGTH, this.channel.sourceState);
    message.writeLong(client.lastClientCommand);
    for (let sequence = client.reliable.acknowledge + 1; sequence <= client.reliable.sequence; sequence++) {
      message.writeByte(ServerOpcode.Command);
      message.writeLong(sequence);
      message.writeString(client.reliable.lookupMasked(sequence));
    }
    client.reliableSent = client.reliable.sequence;
    this.snapshots.writeSnapshotToClient(client, message);
    for (let index = 0; index < this.integer("sv_padPackets"); index++) message.writeByte(ServerOpcode.Nop);
    this.host.downloads.writeToClient(client, message);
    if (message.overflowed) { this.host.print(`WARNING: msg overflowed for ${client.name}\n`); message.clear(); }
    this.sendMessageToClient(client, message);
  }

  sendClientMessages(): void {
    const statics = this.snapshots.staticState;
    for (let index = 0; index < this.integer("sv_maxclients"); index++) {
      const client = statics.clients[index];
      if (client === undefined) throw new RangeError("sv_maxclients exceeds canonical server client storage");
      if (client.phase === ServerClientPhase.Free || statics.time < client.nextSnapshotTime) continue;
      const connection = this.connection(client);
      if (connection.netchan.hasUnsentFragments) {
        client.nextSnapshotTime = (statics.time + this.rateMsec(client, connection.netchan.remainingUnsentBytes)) | 0;
        this.channel.transmitNextFragment(client);
        continue;
      }
      this.sendClientSnapshot(client);
    }
  }
}
