// Port of id Software's botlib/l_memory.c without MEMORYMANEGER or MEMDEBUG,
// and server/sv_bot.c memory imports. Release32 uses a four-byte allocation ID.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import { ZoneTag } from "../core/zone.ts";
import type { ZoneAllocation, ZoneArena } from "../core/zone.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";

const MEM_ID = 0x12345678;
const HUNK_ID = 0x87654321;
const PREFIX_BYTES = 4;

export interface BotMemoryAllocation {
  /** Borrow for the current operation; a previously obtained view cannot be revoked. */
  readonly bytes: Uint8Array;
}

type SourceHunkProfile = Extract<HunkAccountingProfile, { readonly kind: "source-hunk" }>;
type Storage =
  | { readonly kind: "heap" | "diagnostic-hunk"; readonly bytes: Uint8Array }
  | { readonly kind: "source-heap"; readonly zone: ZoneArena; readonly allocation: ZoneAllocation }
  | { readonly kind: "source-hunk"; readonly profile: SourceHunkProfile; readonly allocation: HunkAllocation }
  | { readonly kind: "freed" };
interface AllocationRecord { storage: Storage; payload: Uint8Array | null }

function blockBytes(storage: Storage): Uint8Array {
  switch (storage.kind) {
    case "heap": case "diagnostic-hunk": return storage.bytes;
    case "source-heap": return storage.allocation.bytes;
    case "source-hunk":
      if (!storage.profile.accounting.arena.ownsLiveAllocation(storage.allocation)) {
        throw new Error("Bot hunk allocation is no longer valid");
      }
      return storage.allocation.bytes;
    case "freed": throw new Error("Bot heap allocation has been freed");
  }
}

class MemoryAllocation implements BotMemoryAllocation {
  constructor(private readonly record: AllocationRecord) {}

  get bytes(): Uint8Array {
    const current = blockBytes(this.record.storage);
    this.record.payload ??= current.subarray(PREFIX_BYTES);
    return this.record.payload;
  }
}

/** Source heap and hunk callers borrow their common-owned arenas. Omitted
 * arena profiles retain managed storage for diagnostic compositions. */
export class BotMemory {
  private readonly allocations = new WeakMap<BotMemoryAllocation, AllocationRecord>();

  constructor(readonly hunk: HunkAccountingProfile = { kind: "unaccounted" }, readonly zone?: ZoneArena) {}

  /** AvailableMemory borrows botimport.AvailableMemory, supplied by Z_AvailableMemory. */
  availableMemory(): number {
    if (this.zone === undefined) {
      throw new Error("Bot AvailableMemory requires a source zone; unaccounted heap storage has no available-memory query");
    }
    return this.zone.memoryRemaining();
  }

  /** PrintUsedMemorySize is empty in the selected non-MEMORYMANEGER source. */
  printUsedMemorySize(): void {}

  /** PrintMemoryLabels is empty in the selected non-MEMORYMANEGER source. */
  printMemoryLabels(): void {}

  /** GetMemory/GetHunkMemory and their cleared variants, including the source ID. */
  allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff - PREFIX_BYTES) {
      throw new RangeError("Bot memory allocation must fit a nonnegative source signed size with its four-byte prefix");
    }
    let storage: Storage;
    const hunk = this.hunk;
    if (kind === "hunk" && hunk.kind === "source-hunk") {
      const accounting = hunk.accounting;
      if (accounting.arena.checkMark()) {
        throw new CommonError("drop", "SV_Bot_HunkAlloc: Alloc with marks already set\n");
      }
      storage = { kind: "source-hunk", profile: hunk,
        allocation: accounting.reserve(clear ? "GetClearedHunkMemory" : "GetHunkMemory", "<botlib>", size + PREFIX_BYTES, "high") };
    } else if (kind === "heap" && this.zone !== undefined) {
      storage = { kind: "source-heap", zone: this.zone,
        allocation: this.zone.allocate(size + PREFIX_BYTES, ZoneTag.Botlib) };
    } else {
      storage = { kind: kind === "heap" ? "heap" : "diagnostic-hunk", bytes: new Uint8Array(size + PREFIX_BYTES) };
    }
    const bytes = blockBytes(storage);
    new DataView(bytes.buffer, bytes.byteOffset, PREFIX_BYTES).setUint32(0, kind === "heap" ? MEM_ID : HUNK_ID, true);
    if (clear) bytes.fill(0, PREFIX_BYTES);
    const record: AllocationRecord = { storage, payload: null };
    const allocation = new MemoryAllocation(record);
    this.allocations.set(allocation, record);
    return allocation;
  }

  /** FreeMemory leaves hunk blocks allocated; only the actual MEM_ID owns a heap free. */
  free(allocation: BotMemoryAllocation): void {
    const record = this.allocations.get(allocation);
    if (record === undefined) throw new Error("Bot memory allocation belongs to another owner");
    const storage = record.storage;
    const bytes = blockBytes(storage);
    if (new DataView(bytes.buffer, bytes.byteOffset, PREFIX_BYTES).getUint32(0, true) !== MEM_ID) return;
    if (storage.kind === "source-heap") storage.zone.free(storage.allocation);
    else if (storage.kind === "heap") bytes.fill(0xaa);
    else throw new Error("Bot memory heap ID does not belong to a heap allocation");
    record.storage = { kind: "freed" };
    record.payload = null;
  }
}
