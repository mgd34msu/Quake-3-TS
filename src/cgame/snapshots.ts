// Snapshot transitions from id Software's code/cgame/cg_snapshot.c,
// and the CL_GetSnapshot boundary from code/client/cl_cgame.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import type { Snapshot } from "../protocol/server-message.ts";
import { MAX_PARSE_ENTITIES } from "../protocol/parse-entities.ts";
import { EntityType } from "../shared/definitions.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import { playerStateToEntityState } from "../shared/snapshot-state.ts";
import { buildSolidList } from "./prediction.ts";
import { retailSnapshot } from "./retail-snapshot.ts";
import { SnapshotHistory } from "./snapshot-history.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";

export interface SnapshotSource {
  current(): { readonly number: number; readonly serverTime: number };
  read(number: number): Snapshot | null;
}

export class HistorySnapshotSource implements SnapshotSource {
  constructor(readonly history: SnapshotHistory, private readonly parseEntitiesNumber: () => number,
    private readonly debugPrint: (message: string) => void) {}
  current(): { readonly number: number; readonly serverTime: number } {
    const latest = this.history.latest;
    return latest === null ? { number: 0, serverTime: 0 } : { number: latest.messageNumber, serverTime: latest.serverTime };
  }
  read(number: number) {
    if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff) {
      throw new RangeError("Snapshot request number must be int32");
    }
    const latest = this.history.latest;
    const latestNumber = latest?.messageNumber ?? 0;
    if (number > latestNumber) throw new CommonError("drop", "CL_GetSnapshot: snapshotNumber > cl.snapshot.messageNum");
    if (((latestNumber - number) | 0) >= 32 || latest === null) return null;
    const entry = this.history.borrowSlot(number, latest.playerState.product);
    if (entry.status !== "valid") return null;
    const snapshot = entry.snapshot;
    const retained = this.history.parseEntities;
    const parseEntitiesNumber = retained === null ? this.parseEntitiesNumber() : retained.number;
    if (((parseEntitiesNumber - snapshot.parseEntitiesNumber) | 0) >= MAX_PARSE_ENTITIES) return null;
    const areaMask = new Uint8Array(32);
    areaMask.set(snapshot.areaMask);
    const output = {
      messageNumber: snapshot.messageNumber,
      serverTime: snapshot.serverTime,
      deltaNumber: snapshot.deltaNumber,
      flags: snapshot.flags,
      serverCommandNumber: snapshot.serverCommandNumber,
      parseEntitiesNumber: snapshot.parseEntitiesNumber,
      areaMask,
      playerState: snapshot.playerState.copy(),
    };
    let count = snapshot.entities.length;
    if (count > 256) {
      this.debugPrint(`CL_GetSnapshot: truncated ${count} entities to 256\n`);
      count = 256;
    }
    const entities = retained === null ? snapshot.entities.slice(0, count).map(entity => entity.copy())
      : Array.from({ length: count }, (_, index) => retained.at(snapshot.parseEntitiesNumber + index).copy());
    return { ...output, entities };
  }
}

export interface SnapshotHost {
  readonly source: SnapshotSource;
  readonly demoPlayback: boolean;
  readonly noPredict: boolean;
  readonly synchronousClients: boolean;
  executeServerCommands(sequence: number): Promise<void>;
  respawn(): void;
  resetPlayerEntity(entity: ClientEntity): void;
  checkEvents(entity: ClientEntity): Promise<void>;
  transitionPlayerState(current: SourcePlayerState, previous: SourcePlayerState): Promise<void>;
  lagometerSnapshot(snapshot: Snapshot | null): void;
  warn(message: string): void;
}

export class SnapshotRuntime {
  private transitioning = false;
  constructor(readonly state: ClientGameState, readonly host: SnapshotHost) {}
  private async exclusive(operation: () => Promise<void>): Promise<void> {
    if (this.transitioning) throw new Error("Snapshot transition already in progress");
    this.transitioning = true;
    try { await operation(); } finally { this.transitioning = false; }
  }
  setInitialSnapshot(input: Snapshot): Promise<void> { return this.exclusive(() => this.initialSnapshot(input)); }
  transitionSnapshot(): Promise<void> { return this.exclusive(() => this.transition()); }
  processSnapshots(): Promise<void> { return this.exclusive(() => this.process()); }
  private resetEntity(entity: ClientEntity, snapshot: Snapshot): void {
    if (entity.snapshotTime < ((this.state.time - 300) | 0)) entity.previousEvent = 0;
    entity.trailTime = snapshot.serverTime;
    entity.lerpOrigin = { ...entity.currentState.origin };
    entity.lerpAngles = { ...entity.currentState.angles };
    if (entity.currentState.eType === EntityType.ET_PLAYER) this.host.resetPlayerEntity(entity);
  }
  private async initialSnapshot(input: Snapshot): Promise<void> {
    const snapshot = retailSnapshot(input);
    this.state.snap = snapshot;
    playerStateToEntityState(snapshot.playerState, this.state.entityAt(snapshot.playerState.clientNum).currentState, false);
    buildSolidList(this.state);
    await this.host.executeServerCommands(snapshot.serverCommandNumber);
    this.host.respawn();
    for (const entry of snapshot.entities) {
      const entity = this.state.entityAt(entry.number);
      entity.currentState = entry.copy();
      entity.interpolate = false;
      entity.currentValid = true;
      this.resetEntity(entity, snapshot);
      await this.host.checkEvents(entity);
    }
  }
  setNextSnapshot(input: Snapshot): void {
    if (this.transitioning) throw new Error("Snapshot transition already in progress");
    this.nextSnapshot(input);
  }
  private nextSnapshot(input: Snapshot): void {
    const previous = this.state.snap;
    if (previous === null) throw new Error("CG_SetNextSnap requires cg.snap");
    const snapshot = retailSnapshot(input);
    this.state.nextSnap = snapshot;
    playerStateToEntityState(snapshot.playerState, this.state.entityAt(snapshot.playerState.clientNum).nextState, false);
    this.state.entityAt(previous.playerState.clientNum).interpolate = true;
    for (const entry of snapshot.entities) {
      const entity = this.state.entityAt(entry.number);
      entity.nextState = entry.copy();
      entity.interpolate = entity.currentValid && ((entity.currentState.eFlags ^ entry.eFlags) & 4) === 0;
    }
    this.state.nextFrameTeleport = ((snapshot.playerState.eFlags ^ previous.playerState.eFlags) & 4) !== 0
      || snapshot.playerState.clientNum !== previous.playerState.clientNum || ((snapshot.flags ^ previous.flags) & 4) !== 0;
    buildSolidList(this.state);
  }
  private async transition(): Promise<void> {
    const previous = this.state.snap;
    const next = this.state.nextSnap;
    if (previous === null) throw new CommonError("drop", "CG_TransitionSnapshot: NULL cg.snap");
    if (next === null) throw new CommonError("drop", "CG_TransitionSnapshot: NULL cg.nextSnap");
    await this.host.executeServerCommands(next.serverCommandNumber);
    for (const entry of previous.entities) this.state.entityAt(entry.number).currentValid = false;
    this.state.snap = next;
    const local = this.state.entityAt(next.playerState.clientNum);
    playerStateToEntityState(next.playerState, local.currentState, false);
    local.interpolate = false;
    for (const entry of next.entities) {
      const entity = this.state.entityAt(entry.number);
      entity.currentState = entity.nextState.copy();
      entity.currentValid = true;
      if (!entity.interpolate) this.resetEntity(entity, next);
      entity.interpolate = false;
      await this.host.checkEvents(entity);
      entity.snapshotTime = next.serverTime;
    }
    this.state.nextSnap = null;
    if (((next.playerState.eFlags ^ previous.playerState.eFlags) & 4) !== 0) this.state.thisFrameTeleport = true;
    if (this.host.demoPlayback || (next.playerState.pmFlags & 4096) !== 0 || this.host.noPredict || this.host.synchronousClients) {
      await this.host.transitionPlayerState(next.playerState, previous.playerState);
    }
  }
  private readNextSnapshot(): Snapshot | null {
    if (this.state.latestSnapshotNum > ((this.state.processedSnapshotNum + 1000) | 0)) {
      this.host.warn(`WARNING: CG_ReadNextSnapshot: way out of range, ${this.state.latestSnapshotNum} > ${this.state.processedSnapshotNum}`);
    }
    while (this.state.processedSnapshotNum < this.state.latestSnapshotNum) {
      this.state.processedSnapshotNum = (this.state.processedSnapshotNum + 1) | 0;
      const snapshot = this.host.source.read(this.state.processedSnapshotNum);
      this.host.lagometerSnapshot(snapshot);
      if (snapshot !== null) return snapshot;
    }
    return null;
  }
  private async process(): Promise<void> {
    const latest = this.host.source.current();
    this.state.latestSnapshotTime = latest.serverTime;
    if (latest.number < this.state.latestSnapshotNum) throw new CommonError("drop", "CG_ProcessSnapshots: n < cg.latestSnapshotNum");
    this.state.latestSnapshotNum = latest.number;
    while (this.state.snap === null) {
      const snapshot = this.readNextSnapshot();
      if (snapshot === null) return;
      if ((snapshot.flags & 2) === 0) await this.initialSnapshot(snapshot);
    }
    for (;;) {
      if (this.state.nextSnap === null) {
        const snapshot = this.readNextSnapshot();
        if (snapshot === null) break;
        this.nextSnapshot(snapshot);
        if (snapshot.serverTime < this.state.snap.serverTime) throw new CommonError("drop", "CG_ProcessSnapshots: Server time went backwards");
      }
      const next = this.state.nextSnap;
      if (next === null) throw new Error("CG_ProcessSnapshots: missing next snapshot");
      if (this.state.time >= this.state.snap.serverTime && this.state.time < next.serverTime) break;
      await this.transition();
    }
    if (this.state.time < this.state.snap.serverTime) this.state.time = this.state.snap.serverTime;
    if (this.state.nextSnap !== null && this.state.nextSnap.serverTime <= this.state.time) {
      throw new CommonError("drop", "CG_ProcessSnapshots: cg.nextSnap->serverTime <= cg.time");
    }
  }
}
