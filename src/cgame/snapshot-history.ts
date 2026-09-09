// Port of id Software's client/cl_parse.c CL_ParseSnapshot history publication.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { ServerOperation, Snapshot, SnapshotHistoryEntry } from "../protocol/server-message.ts";
import type { SourceParseEntities } from "../protocol/parse-entities.ts";
import type { Product } from "../shared/definitions.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../shared/entity-state.ts";
import { PlayerStateRecord } from "../shared/player-state.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";

export const SNAPSHOT_BACKUP = 32;
type SnapshotOperation = Extract<ServerOperation, { kind: "snapshot" }>;
interface OwnedSnapshot extends Snapshot {
  readonly playerState: SourcePlayerState;
  readonly entities: readonly SourceEntityState[];
}
type RetainedSnapshot = { -readonly [Key in keyof OwnedSnapshot]: OwnedSnapshot[Key] };
interface RetainedSnapshotEntry {
  status: SnapshotHistoryEntry["status"];
  readonly snapshot: RetainedSnapshot;
  present: boolean;
}

function zeroSnapshot(product: Product): RetainedSnapshot {
  return { messageNumber: 0, serverTime: 0, deltaNumber: 0, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32),
    playerState: new PlayerStateRecord<number, number, number>(product, 0, 0, 0), entities: [] };
}

function copyEntity(source: Readonly<EntityStateFields>): SourceEntityState {
  const entity = new EntityStateRecord<number>(0);
  entity.copyFrom(source);
  return entity;
}

function copyIntoSnapshot(destination: RetainedSnapshot, source: Snapshot): void {
  destination.messageNumber = source.messageNumber;
  destination.serverTime = source.serverTime;
  destination.deltaNumber = source.deltaNumber;
  destination.flags = source.flags;
  destination.serverCommandNumber = source.serverCommandNumber;
  destination.parseEntitiesNumber = source.parseEntitiesNumber;
  destination.areaMask.fill(0);
  destination.areaMask.set(source.areaMask);
  destination.playerState.copyFrom(source.playerState);
  destination.entities = source.entities.map(copyEntity);
}

/** Published state never aliases the simulation, decoder, or another consumer. */
export function copySnapshot(snapshot: Snapshot): OwnedSnapshot {
  const playerState = new PlayerStateRecord<number, number, number>(snapshot.playerState.product, 0, 0, 0);
  playerState.copyFrom(snapshot.playerState);
  return {
    ...snapshot,
    areaMask: new Uint8Array(snapshot.areaMask),
    playerState,
    entities: snapshot.entities.map(copyEntity),
  };
}

function checkMessageNumber(number: number): void {
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff) {
    throw new RangeError("Snapshot message number must be an int32 sequence");
  }
}

export class SnapshotHistory {
  private readonly slots: (RetainedSnapshotEntry | null)[] = Array.from({ length: SNAPSHOT_BACKUP }, () => null);
  private current: OwnedSnapshot | null = null;

  constructor(readonly parseEntities: SourceParseEntities | null = null) {}

  get latest(): OwnedSnapshot | null { return this.current === null ? null : copySnapshot(this.current); }

  readCurrentPlayerState(): SourcePlayerState | null { return this.current === null ? null : this.current.playerState.copy(); }

  /** Detached history inspection. Source parsing borrows its actual slot instead. */
  readSlot(messageNumber: number): { readonly status: SnapshotHistoryEntry["status"]; readonly snapshot: OwnedSnapshot } | null {
    checkMessageNumber(messageNumber);
    const entry = this.slots[messageNumber & (SNAPSHOT_BACKUP - 1)];
    if (entry === undefined) throw new Error("Missing snapshot ring slot");
    return entry === null || !entry.present ? null : { status: entry.status, snapshot: copySnapshot(entry.snapshot) };
  }

  /** cl.snapshots retains a zero invalid record even before its first publication. */
  borrowSlot(messageNumber: number, product: Product): Omit<RetainedSnapshotEntry, "present"> {
    checkMessageNumber(messageNumber);
    const index = messageNumber & (SNAPSHOT_BACKUP - 1);
    let entry = this.slots[index];
    if (entry === undefined) throw new Error("Missing snapshot ring slot");
    if (entry === null) {
      entry = { status: "invalid", snapshot: zeroSnapshot(product), present: false };
      this.slots[index] = entry;
    } else if (!entry.present && entry.snapshot.playerState.product !== product) {
      entry.snapshot.playerState.copyFrom(new PlayerStateRecord<number, number, number>(product, 0, 0, 0));
    }
    return entry;
  }

  publish(operation: SnapshotOperation): boolean {
    if (operation.validity.kind === "invalid") return false;
    const incoming = operation.snapshot;
    checkMessageNumber(incoming.messageNumber);
    const previousNumber = this.current?.messageNumber ?? 0;
    const snapshot = copySnapshot(incoming);
    let skipped = (previousNumber + 1) | 0;
    if (((snapshot.messageNumber - skipped) | 0) >= SNAPSHOT_BACKUP) skipped = (snapshot.messageNumber - (SNAPSHOT_BACKUP - 1)) | 0;
    // Once every masked slot is invalid, additional source iterations have no effect.
    for (let cleared = 0; skipped < snapshot.messageNumber && cleared < SNAPSHOT_BACKUP; skipped = (skipped + 1) | 0, cleared++) {
      const index = skipped & (SNAPSHOT_BACKUP - 1);
      const entry = this.slots[index];
      if (entry === undefined) throw new Error("Missing snapshot ring slot");
      if (entry !== null) entry.status = "invalid";
    }
    this.current = snapshot;
    const index = snapshot.messageNumber & (SNAPSHOT_BACKUP - 1);
    const entry = this.slots[index];
    if (entry === undefined) throw new Error("Missing snapshot ring slot");
    if (entry === null) {
      const retained = zeroSnapshot(snapshot.playerState.product);
      copyIntoSnapshot(retained, snapshot);
      this.slots[index] = { status: "valid", snapshot: retained, present: true };
    } else {
      copyIntoSnapshot(entry.snapshot, snapshot);
      entry.status = "valid";
      entry.present = true;
    }
    return true;
  }

  clear(): void {
    for (const entry of this.slots) {
      if (entry === null) continue;
      copyIntoSnapshot(entry.snapshot, zeroSnapshot(entry.snapshot.playerState.product));
      entry.status = "invalid";
      entry.present = false;
    }
    this.current = null;
  }
}
