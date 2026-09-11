// Port of id Software's botlib/l_memory.c with optional managed debug records,
// and server/sv_bot.c memory imports. Release32 uses a four-byte allocation ID.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import { captureAllocationProvenance } from "../core/allocation-provenance.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import { ZoneTag } from "../core/zone.ts";
import type { AllocationProvenance, ZoneAllocation, ZoneArena } from "../core/zone.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";

const MEM_ID = 0x12345678;
const HUNK_ID = 0x87654321;
const PREFIX_BYTES = 4;

export interface BotMemoryAllocation {
  /** Borrow for the current operation; a previously obtained view cannot be revoked. */
  readonly bytes: Uint8Array;
}

/** MEMORYMANEGER/MEMDEBUG operations over release32 storage. Reports count
 * payload and backing bytes; managed record overhead has no fixed byte size. */
export interface BotMemoryDebugProfile {
  readonly kind: "manager" | "debug";
  print(severity: "message" | "fatal", text: string): void;
  writeLog(text: string): void;
}

type SourceHunkProfile = Extract<HunkAccountingProfile, { readonly kind: "source-hunk" }>;
type Storage =
  | { readonly kind: "heap" | "diagnostic-hunk"; readonly bytes: Uint8Array }
  | { readonly kind: "source-heap"; readonly zone: ZoneArena; readonly allocation: ZoneAllocation }
  | { readonly kind: "source-hunk"; readonly profile: SourceHunkProfile; readonly allocation: HunkAllocation }
  | { readonly kind: "freed" };
interface AllocationRecord {
  storage: Storage;
  payload: Uint8Array | null;
  readonly size: number;
  readonly provenance: AllocationProvenance | null;
}

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
  private readonly tracked = new Map<BotMemoryAllocation, AllocationRecord>();

  constructor(readonly hunk: HunkAccountingProfile = { kind: "unaccounted" }, readonly zone?: ZoneArena,
    private readonly debug?: BotMemoryDebugProfile) {}

  /** AvailableMemory borrows botimport.AvailableMemory, supplied by Z_AvailableMemory. */
  availableMemory(): number {
    if (this.zone === undefined) {
      throw new Error("Bot AvailableMemory requires a source zone; unaccounted heap storage has no available-memory query");
    }
    return this.zone.memoryRemaining();
  }

  /** The managed profile counts real payload/storage bytes, excluding JS overhead. */
  printUsedMemorySize(): void {
    if (this.debug === undefined) return;
    this.discardExpired();
    let allocated = 0, total = 0;
    for (const record of this.tracked.values()) {
      allocated = (allocated + record.size) | 0;
      total = (total + record.size + PREFIX_BYTES) | 0;
    }
    this.debug.print("message", `total allocated memory: ${allocated >> 10} KB\n`);
    this.debug.print("message", `total botlib memory: ${total >> 10} KB\n`);
    this.debug.print("message", `total memory blocks: ${this.tracked.size}\n`);
  }

  printMemoryLabels(): void {
    if (this.debug === undefined) return;
    this.printUsedMemorySize();
    this.debug.writeLog("============= Botlib memory log ==============\r\n");
    this.debug.writeLog("\r\n");
    if (this.debug.kind !== "debug") return;
    let index = 0;
    for (const record of [...this.tracked.values()].reverse()) {
      const storage = record.storage;
      const kind = storage.kind === "source-hunk" || storage.kind === "diagnostic-hunk" ? "hunk" : "heap";
      const origin = record.provenance;
      const location = origin === null ? "<unattributed>" : `${origin.file.padStart(24)} line ${String(origin.line).padStart(6)}: ${origin.label}`;
      this.debug.writeLog(`${String(index++).padStart(6)}, ${kind}, ${String(record.size + PREFIX_BYTES).padStart(8)}: ${location}\r\n`);
    }
  }

  private discardExpired(): void {
    for (const [allocation, record] of this.tracked) {
      const storage = record.storage;
      if (storage.kind === "source-hunk" && !storage.profile.accounting.arena.ownsLiveAllocation(storage.allocation)) {
        this.tracked.delete(allocation);
      } else if (storage.kind === "source-heap" && !storage.zone.ownsLiveAllocation(storage.allocation)) {
        this.tracked.delete(allocation);
      }
    }
  }

  /** GetMemory/GetHunkMemory and their cleared variants, including the source ID. */
  allocate(size: number, kind: "heap" | "hunk", clear: boolean, provenance: AllocationProvenance | null = null): BotMemoryAllocation {
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
        allocation: this.zone.allocate(size + PREFIX_BYTES, ZoneTag.Botlib, false, provenance) };
    } else {
      storage = { kind: kind === "heap" ? "heap" : "diagnostic-hunk", bytes: new Uint8Array(size + PREFIX_BYTES) };
    }
    const bytes = blockBytes(storage);
    new DataView(bytes.buffer, bytes.byteOffset, PREFIX_BYTES).setUint32(0, kind === "heap" ? MEM_ID : HUNK_ID, true);
    if (clear) bytes.fill(0, PREFIX_BYTES);
    const record: AllocationRecord = { storage, payload: null, size,
      provenance: this.debug?.kind !== "debug" ? null : provenance === null
        ? captureAllocationProvenance(kind === "heap" ? (clear ? "GetClearedMemory" : "GetMemory")
          : (clear ? "GetClearedHunkMemory" : "GetHunkMemory")) : { ...provenance } };
    const allocation = new MemoryAllocation(record);
    this.allocations.set(allocation, record);
    if (this.debug !== undefined) this.tracked.set(allocation, record);
    return allocation;
  }

  /** FreeMemory leaves hunk blocks allocated; only the actual MEM_ID owns a heap free. */
  free(allocation: BotMemoryAllocation | null): void {
    if (this.debug !== undefined) {
      const record = this.debugBlock(allocation, "FreeMemory");
      if (record === null || allocation === null) return;
      this.tracked.delete(allocation);
      const storage = record.storage;
      if (storage.kind === "source-hunk" || storage.kind === "diagnostic-hunk") return;
    }
    if (allocation === null) throw new Error("Bot memory allocation belongs to another owner");
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

  private debugBlock(allocation: BotMemoryAllocation | null, operation: string): AllocationRecord | null {
    if (allocation === null) {
      if (this.debug?.kind === "debug") this.debug.print("fatal", `${operation}: NULL pointer\n`);
      return null;
    }
    this.discardExpired();
    const record = this.tracked.get(allocation);
    if (record === undefined) {
      this.debug?.print("fatal", `${operation}: invalid memory block\n`);
      return null;
    }
    const bytes = blockBytes(record.storage);
    const id = new DataView(bytes.buffer, bytes.byteOffset, PREFIX_BYTES).getUint32(0, true);
    if (id !== MEM_ID && id !== HUNK_ID) {
      this.debug?.print("fatal", `${operation}: invalid memory block\n`);
      return null;
    }
    const hunk = record.storage.kind === "source-hunk" || record.storage.kind === "diagnostic-hunk";
    if ((id === HUNK_ID) !== hunk) {
      this.debug?.print("fatal", `${operation}: memory block pointer invalid\n`);
      return null;
    }
    return record;
  }

  memoryByteSize(allocation: BotMemoryAllocation | null): number {
    if (this.debug === undefined) throw new Error("MemoryByteSize requires the bot memory manager profile");
    const record = this.debugBlock(allocation, "MemoryByteSize");
    return record === null ? 0 : record.size + PREFIX_BYTES;
  }

  dumpMemory(): void {
    if (this.debug === undefined) throw new Error("DumpMemory requires the bot memory manager profile");
    this.discardExpired();
    for (const allocation of [...this.tracked.keys()].reverse()) this.free(allocation);
  }
}
