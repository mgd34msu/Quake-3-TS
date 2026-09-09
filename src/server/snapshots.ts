// Port of id Software's server/sv_snapshot.c and sv_init.c:SV_CreateBaseline.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { dot3, sub3, vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec3 } from "../core/math.ts";
import type { CollisionWorld } from "../collision/world.ts";
import type { MessageWriter } from "../protocol/message.ts";
import { ServerOpcode } from "../protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation, Snapshot, SnapshotHistoryEntry } from "../protocol/server-message.ts";
import { writeDeltaEntity, writeDeltaPlayerState } from "../protocol/state-delta.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../shared/entity-state.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { PlayerStateRecord } from "../shared/player-state.ts";
import type { ServerGame } from "./game.ts";
import type { ServerWorld } from "./world.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerClient, ServerClientFrame, ServerStaticState, ServerWorldState } from "./state.ts";

export interface ServerSnapshotHost {
  readonly collision: CollisionWorld;
  readonly spatial: ServerWorld;
  debugPrint(text: string): void;
}
type SnapshotOperation = Extract<ServerOperation, { kind: "snapshot" }>;
const PACKET_MASK = 31, MAX_SNAPSHOT_ENTITIES = 1024;

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (!Number.isInteger(index) || value === undefined) throw new RangeError(`Server snapshot index ${index} outside ${values.length}`);
  return value;
}
function copyEntityState(entity: Readonly<EntityStateFields>): SourceEntityState {
  const result = new EntityStateRecord<number>(0);
  result.copyFrom(entity);
  return result;
}
function copySnapshot(snapshot: Snapshot): Snapshot {
  const playerState = new PlayerStateRecord<number, number, number>(snapshot.playerState.product, 0, 0, 0);
  playerState.copyFrom(snapshot.playerState);
  return { ...snapshot, playerState, areaMask: new Uint8Array(snapshot.areaMask), entities: snapshot.entities.map(copyEntityState) };
}

/** Owns no second server ring. Returned protocol records are detached encoder inputs. */
export class ServerSnapshotRuntime {
  constructor(readonly world: ServerWorldState, readonly staticState: ServerStaticState, readonly host: ServerSnapshotHost) {
    if (world.product !== staticState.product) throw new Error("Server snapshot product mismatch");
  }
  private game(): ServerGame {
    const game = this.world.game;
    if (game === null) throw new Error("Server snapshot requires a current game runtime");
    if (game.product !== this.world.product) throw new Error("Server game snapshot product mismatch");
    return game;
  }
  private sequence(client: ServerClient): number {
    if (this.staticState.clients[client.slot] !== client) throw new Error("Foreign server snapshot client");
    if (client.connection.kind !== "initialized") throw new Error("Server snapshot client has no initialized channel");
    return client.connection.netchan.outgoingSequence;
  }
  private frame(client: ServerClient): ServerClientFrame { return at(client.frames, this.sequence(client) & PACKET_MASK); }

  createBaselines(): void {
    const game = this.game();
    for (let number = 1; number < game.data.numEntities; number++) {
      const entity = game.data.entity(number);
      if (!entity.r.linked) continue;
      entity.s.number = number;
      this.world.baselines[number] = copyEntityState(entity.s);
    }
  }

  private addEntity(number: number, selected: number[]): void {
    if (this.world.entitySnapshotCounters[number] === this.world.snapshotCounter) return;
    this.world.entitySnapshotCounters[number] = this.world.snapshotCounter;
    if (selected.length === MAX_SNAPSHOT_ENTITIES) return;
    if (number < 0 || number >= 1024) throw new RangeError("Server snapshot entity outside source storage");
    selected.push(number);
  }

  private visibleFrom(origin: Vec3, frame: ServerClientFrame, selected: number[]): void {
    if (this.world.state === "dead") return;
    const game = this.game(), collision = this.host.collision;
    const leaf = collision.pointLeafnum(origin), area = collision.leafArea(leaf);
    frame.areaBytes = collision.writeAreaBits(frame.areaBits, area);
    const pvs = collision.clusterPVS(collision.leafCluster(leaf));
    const visible = (cluster: number): boolean => {
      const byte = pvs.byteAt(cluster >> 3);
      return (byte & (1 << (cluster & 7))) !== 0;
    };
    for (let number = 0; number < game.data.numEntities; number++) {
      const entity = game.data.entity(number);
      if (!entity.r.linked) continue;
      if (entity.s.number !== number) { this.host.debugPrint("FIXING ENT->S.NUMBER!!!\n"); entity.s.number = number; }
      const flags = entity.r.svFlags;
      if (flags & ServerEntityFlags.NOCLIENT) continue;
      if ((flags & ServerEntityFlags.SINGLECLIENT) && entity.r.singleClient !== frame.playerState.clientNum) continue;
      if ((flags & ServerEntityFlags.NOTSINGLECLIENT) && entity.r.singleClient === frame.playerState.clientNum) continue;
      if (flags & ServerEntityFlags.CLIENTMASK) {
        if (frame.playerState.clientNum >= 32) throw new CommonError("drop", "SVF_CLIENTMASK: cientNum > 32\n");
        if (~entity.r.singleClient & (1 << frame.playerState.clientNum)) continue;
      }
      if (this.world.entitySnapshotCounters[number] === this.world.snapshotCounter) continue;
      if (flags & ServerEntityFlags.BROADCAST) { this.addEntity(number, selected); continue; }
      const link = this.host.spatial.linkState(number);
      if (link === undefined) continue;
      if (!collision.areasConnected(area, link.areanum) && !collision.areasConnected(area, link.areanum2)) continue;
      if (link.clusters.length === 0) continue;
      let cluster = 0, index = 0;
      for (; index < link.clusters.length; index++) {
        cluster = at(link.clusters, index);
        if (visible(cluster)) break;
      }
      if (index === link.clusters.length) {
        if (!link.lastCluster) continue;
        for (; cluster <= link.lastCluster; cluster++) if (visible(cluster)) break;
        // Source tests equality, not greater-than: a fully invisible overflow can still be sent.
        if (cluster === link.lastCluster) continue;
      }
      this.addEntity(number, selected);
      if (flags & ServerEntityFlags.PORTAL) {
        if (entity.s.generic1) {
          const delta = sub3(entity.s.origin, origin), distance = Math.fround(Math.fround(entity.s.generic1) * Math.fround(entity.s.generic1));
          if (dot3(delta, delta) > distance) continue;
        }
        this.visibleFrom(entity.s.origin2, frame, selected);
      }
    }
  }

  buildClientSnapshot(client: ServerClient): ServerClientFrame {
    this.sequence(client);
    this.world.snapshotCounter = (this.world.snapshotCounter + 1) | 0;
    const frame = this.frame(client), selected: number[] = [];
    frame.areaBits.fill(0); frame.numEntities = 0;
    if (client.gameEntity === null || client.phase === ServerClientPhase.Zombie) return frame;
    const game = this.game(), ps = game.data.copyPlayerState(client.slot);
    frame.playerState = ps;
    const clientNum = frame.playerState.clientNum;
    if (!Number.isInteger(clientNum) || clientNum < 0 || clientNum >= 1024) throw new CommonError("drop", "SV_SvEntityForGentity: bad gEnt");
    this.world.entitySnapshotCounters[clientNum] = this.world.snapshotCounter;
    this.visibleFrom(vec3(ps.origin.x, ps.origin.y, Math.fround(ps.origin.z + Math.fround(ps.viewheight))), frame, selected);
    selected.sort((a, b) => { if (a === b) throw new CommonError("drop", "SV_QsortEntityStates: duplicated entity"); return a < b ? -1 : 1; });
    for (let index = 0; index < 32; index++) frame.areaBits[index] = at(frame.areaBits, index) ^ 255;
    frame.firstEntity = this.staticState.nextSnapshotEntities;
    for (const number of selected) {
      const index = this.staticState.nextSnapshotEntities % this.staticState.numSnapshotEntities;
      this.staticState.snapshotEntities.set(index, game.data.entity(number).s);
      this.staticState.nextSnapshotEntities++;
      if (this.staticState.nextSnapshotEntities >= 0x7ffffffe) throw new CommonError("fatal", "svs.nextSnapshotEntities wrapped");
      frame.numEntities++;
    }
    return frame;
  }

  private delta(client: ServerClient, report: boolean): number {
    const sequence = this.sequence(client);
    if (client.deltaMessage <= 0 || client.phase !== ServerClientPhase.Active) return -1;
    if (sequence - client.deltaMessage >= 29) {
      if (report) this.host.debugPrint(`${client.name}: Delta request from out of date packet.\n`);
      return -1;
    }
    const old = at(client.frames, client.deltaMessage & PACKET_MASK);
    if (old.firstEntity <= this.staticState.nextSnapshotEntities - this.staticState.numSnapshotEntities) {
      if (report) this.host.debugPrint(`${client.name}: Delta request from out of date entities.\n`);
      return -1;
    }
    return client.deltaMessage;
  }
  private emitPacketEntities(writer: MessageWriter, previous: ServerClientFrame | null, current: ServerClientFrame): void {
    let oldIndex = 0, newIndex = 0;
    while (newIndex < current.numEntities || (previous !== null && oldIndex < previous.numEntities)) {
      const next = newIndex >= current.numEntities ? null
        : this.staticState.snapshotEntities.get((current.firstEntity + newIndex) % this.staticState.numSnapshotEntities);
      const old = previous === null || oldIndex >= previous.numEntities ? null
        : this.staticState.snapshotEntities.get((previous.firstEntity + oldIndex) % this.staticState.numSnapshotEntities);
      if (next !== null && old !== null && next.number === old.number) {
        writeDeltaEntity(writer, old, next, false);
        oldIndex++; newIndex++;
      } else if (next !== null && (old === null || next.number < old.number)) {
        writeDeltaEntity(writer, at(this.world.baselines, next.number), next, true);
        newIndex++;
      } else if (old !== null) {
        writeDeltaEntity(writer, old, null, true);
        oldIndex++;
      } else throw new Error("Missing server packet entity during merge");
    }
    writer.writeBits(1023, 10);
  }
  /** SV_WriteSnapshotToClient consumes the physical ring even after the current frame wraps it. */
  writeSnapshotToClient(client: ServerClient, writer: MessageWriter): void {
    const frame = this.frame(client), sequence = this.sequence(client), delta = this.delta(client, true);
    const old = delta < 0 ? null : at(client.frames, delta & PACKET_MASK);
    if (frame.areaBytes < 0 || frame.areaBytes > 32) throw new RangeError("Server snapshot area byte count outside 0..32");
    writer.writeByte(ServerOpcode.Snapshot);
    writer.writeLong(this.staticState.time);
    writer.writeByte(delta < 0 ? 0 : sequence - delta);
    writer.writeByte(this.staticState.snapFlagServerBit | (client.rateDelayed ? 1 : 0) | (client.phase !== ServerClientPhase.Active ? 2 : 0));
    writer.writeByte(frame.areaBytes);
    writer.writeData(frame.areaBits.subarray(0, frame.areaBytes));
    writeDeltaPlayerState(writer, old === null ? null : old.playerState, frame.playerState);
    this.emitPacketEntities(writer, old, frame);
  }
  private snapshot(client: ServerClient, frame: ServerClientFrame, sequence: number, delta: number): Snapshot {
    if (frame.areaBytes < 0 || frame.areaBytes > 32) throw new RangeError("Server snapshot area byte count outside 0..32");
    const entities: SourceEntityState[] = [];
    for (let index = 0; index < frame.numEntities; index++) {
      const entity = this.staticState.snapshotEntities.get((frame.firstEntity + index) % this.staticState.numSnapshotEntities);
      if (entity.number < 0 || entity.number >= 1023) throw new RangeError("Server snapshot entity collides with protocol sentinel 1023");
      entities.push(entity);
    }
    return { messageNumber: sequence, serverTime: this.staticState.time, deltaNumber: delta,
      flags: this.staticState.snapFlagServerBit | (client.rateDelayed ? 1 : 0) | (client.phase !== ServerClientPhase.Active ? 2 : 0),
      serverCommandNumber: client.reliable.sequence, parseEntitiesNumber: frame.firstEntity,
      areaMask: new Uint8Array(frame.areaBits.subarray(0, frame.areaBytes)), playerState: frame.playerState.copy(), entities };
  }
  snapshotOperation(client: ServerClient): SnapshotOperation {
    return { kind: "snapshot", validity: { kind: "valid" }, snapshot: this.snapshot(client, this.frame(client), this.sequence(client), this.delta(client, true)) };
  }
  /** Encoder-only view: the protocol adapter does not claim archived wire envelope metadata. */
  messageContext(client: ServerClient): ServerMessageContext {
    const sequence = this.sequence(client), delta = this.delta(client, false);
    const baselines = this.world.baselines.map(entity => entity.copy());
    const old = delta < 0 ? null : this.snapshot(client, at(client.frames, delta & PACKET_MASK), delta, -1);
    return { product: this.world.product, messageNumber: sequence, reliableSequence: client.lastClientCommand,
      serverCommandSequence: client.reliable.sequence, parseEntitiesNumber: this.frame(client).firstEntity,
      baseline: number => at(baselines, number).copy(),
      history: (number): SnapshotHistoryEntry | null => old === null || number !== delta ? null : { status: "valid", snapshot: copySnapshot(old) } };
  }
}
