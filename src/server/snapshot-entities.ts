// Port of id Software's server/sv_init.c and sv_snapshot.c snapshot entity storage.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { HunkAllocation } from "../core/hunk.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import type { EntityStateFields, SourceEntityState } from "../shared/entity-state.ts";
import { QVM_ENTITY_STATE_BYTES, readQvmEntityState, writeQvmEntityState } from "../vm/entity-record.ts";

type SnapshotStorage =
  | { readonly kind: "source-hunk"; readonly allocation: HunkAllocation }
  | { readonly kind: "diagnostic-owned"; bytes: Uint8Array | null };

/** The source 208-byte records, with detached reads and copy-by-value writes. */
export class ServerSnapshotEntities {
  private readonly storage: SnapshotStorage;

  constructor(readonly length: number, profile: HunkAccountingProfile) {
    if (!Number.isInteger(length) || length < 0 || length > 64 * 32 * 64) {
      throw new RangeError("Server snapshot storage length outside 0..131072");
    }
    this.storage = profile.kind === "source-hunk"
      ? { kind: "source-hunk", allocation: profile.accounting.reserve(
        "SV_SpawnServer:snapshotEntities", "<server snapshots>", length * QVM_ENTITY_STATE_BYTES, "high") }
      : { kind: "diagnostic-owned", bytes: null };
  }

  private record(index: number): DataView {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Server snapshot index ${index} outside ${this.length}`);
    }
    // Startup and max-client changes only need the count until SV_SpawnServer allocates.
    const bytes = this.storage.kind === "source-hunk" ? this.storage.allocation.bytes
      : this.storage.bytes ??= new Uint8Array(this.length * QVM_ENTITY_STATE_BYTES);
    return new DataView(bytes.buffer, bytes.byteOffset + index * QVM_ENTITY_STATE_BYTES, QVM_ENTITY_STATE_BYTES);
  }

  get(index: number): SourceEntityState { return readQvmEntityState(this.record(index)); }
  set(index: number, entity: Readonly<EntityStateFields>): void { writeQvmEntityState(this.record(index), entity); }
}
