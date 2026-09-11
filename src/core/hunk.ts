// Port of id Software's code/qcommon/common.c allocator with managed debug metadata.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "./common-error.ts";
import { captureAllocationProvenance } from "./allocation-provenance.ts";
import type { AllocationProvenance } from "./zone.ts";

const HUNK_MAGIC = 0x89537892;
const HUNK_FREE_MAGIC = 0x89537893;
const HEADER_BYTES = 8;
const MEBIBYTE = 1024 * 1024;

export type HunkPreference = "low" | "high" | "dontcare";
/** Managed metadata over release32 reservations; no native debug header is charged. */
export interface HunkDebugProfile {
  writeLog(text: string): void;
}
export interface HunkAllocation {
  readonly kind: "permanent" | "temporary";
  readonly byteOffset: number;
  readonly byteLength: number;
  /** Views already obtained cannot be revoked; do not retain them beyond this allocation's lifetime. */
  readonly bytes: Uint8Array;
}

interface Bank {
  mark: number;
  permanent: number;
  temp: number;
  tempHighwater: number;
}

export interface HunkSnapshot {
  readonly byteLength: number;
  readonly low: Readonly<Bank>;
  readonly high: Readonly<Bank>;
  readonly permanentBank: "low" | "high";
  readonly temporaryBank: "low" | "high";
}

interface CommonClearHost {
  shutdownGameProgs(): void;
  clearVm(): void;
}
export type HunkClearHost =
  | (CommonClearHost & { readonly kind: "dedicated" })
  | (CommonClearHost & {
    readonly kind: "client";
    shutdownCGame(): void;
    shutdownUi(): void;
    closeAllVideos(): void;
  });

interface CommonAsyncClearHost {
  shutdownGameProgs(): void | Promise<void>;
  clearVm(): void;
}
export type HunkAsyncClearHost =
  | (CommonAsyncClearHost & { readonly kind: "dedicated" })
  | (CommonAsyncClearHost & {
    readonly kind: "client";
    shutdownCGame(): void | Promise<void>;
    shutdownUi(): void | Promise<void>;
    closeAllVideos(): void | Promise<void>;
  });

interface AllocationRecord {
  readonly bank: Bank;
  readonly start: number;
  readonly size: number;
  readonly end: number;
  readonly kind: "permanent" | "temporary";
  readonly provenance: AllocationProvenance | null;
  valid: boolean;
}

function bank(): Bank { return { mark: 0, permanent: 0, temp: 0, tempHighwater: 0 }; }
function signedInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError(`${label} must be a signed 32-bit integer`);
}
function alignedSize(size: number, alignment: number, extra: number): number {
  signedInteger(size, "Hunk allocation size");
  if (size < 0) throw new RangeError("Hunk allocation size must not be negative");
  const rounded = Math.ceil(size / alignment) * alignment + extra;
  if (rounded > 0x7fffffff) throw new RangeError("Aligned hunk allocation exceeds signed 32-bit size");
  return rounded;
}

/** Owns actual byte storage. Unrelated JS objects and external buffers are not charged to this arena. */
export class HunkArena {
  private readonly storage: ArrayBuffer;
  private readonly data: Uint8Array;
  private readonly headers: DataView;
  private readonly low = bank();
  private readonly high = bank();
  private permanent = this.low;
  private temporary = this.high;
  private readonly allocations = new Map<HunkAllocation, AllocationRecord>();
  private clearing = false;

  constructor(readonly byteLength: number, private readonly print: (text: string) => void, private readonly debug?: HunkDebugProfile) {
    signedInteger(byteLength, "Hunk capacity");
    if (byteLength <= 0 || byteLength % 32 !== 0) throw new RangeError("Hunk capacity must be positive and 32-byte aligned");
    this.storage = new ArrayBuffer(byteLength);
    this.data = new Uint8Array(this.storage);
    this.headers = new DataView(this.storage);
  }

  get debugEnabled(): boolean { return this.debug !== undefined; }

  private swapBanks(): void {
    if (this.temporary.temp !== this.temporary.permanent) return;
    if (this.temporary.tempHighwater - this.temporary.permanent > this.permanent.tempHighwater - this.permanent.permanent) {
      const previous = this.temporary;
      this.temporary = this.permanent;
      this.permanent = previous;
    }
  }

  private allocation(record: AllocationRecord, offset: number, size: number): HunkAllocation {
    const storage = this.storage;
    let bytes: Uint8Array | undefined;
    const handle: HunkAllocation = {
      kind: record.kind, byteOffset: offset, byteLength: size,
      get bytes(): Uint8Array {
        if (!record.valid) throw new Error("Hunk allocation is no longer valid");
        bytes ??= new Uint8Array(storage, offset, size);
        return bytes;
      },
    };
    this.allocations.set(handle, record);
    return handle;
  }

  allocate(size: number, preference: HunkPreference, provenance: AllocationProvenance | null = null): HunkAllocation {
    const rounded = alignedSize(size, 32, 0);
    // Even an explicit side preference only asks the original high-water heuristic to swap.
    if (preference === "dontcare" || this.temporary.temp !== this.temporary.permanent) this.swapBanks();
    else if ((preference === "low" && this.permanent !== this.low) || (preference === "high" && this.permanent !== this.high)) this.swapBanks();
    if (this.low.temp + this.high.temp + rounded > this.byteLength) {
      if (this.debug !== undefined) {
        this.log(text => this.debug?.writeLog(text));
        this.log(text => this.debug?.writeLog(text), true);
      }
      throw new CommonError("drop", `Hunk_Alloc failed on ${rounded}`);
    }
    const selected = this.permanent;
    const start = selected === this.low ? selected.permanent : this.byteLength - selected.permanent - rounded;
    selected.permanent += rounded;
    selected.temp = selected.permanent;
    this.data.fill(0, start, start + rounded);
    return this.allocation({ bank: selected, start, size: rounded, end: selected.permanent, kind: "permanent", valid: true,
      provenance: this.debug === undefined ? null : provenance === null
        ? captureAllocationProvenance("Hunk_Alloc") : { ...provenance } }, start, size);
  }

  allocateTemp(size: number): HunkAllocation {
    const rounded = alignedSize(size, 4, HEADER_BYTES);
    this.swapBanks();
    if (this.temporary.temp + this.permanent.permanent + rounded > this.byteLength) throw new CommonError("drop", `Hunk_AllocateTempMemory: failed on ${rounded}`);
    const selected = this.temporary;
    const start = selected === this.low ? selected.temp : this.byteLength - selected.temp - rounded;
    selected.temp += rounded;
    if (selected.temp > selected.tempHighwater) selected.tempHighwater = selected.temp;
    this.headers.setUint32(start, HUNK_MAGIC, true);
    this.headers.setInt32(start + 4, rounded, true);
    return this.allocation({ bank: selected, start, size: rounded, end: selected.temp, kind: "temporary", valid: true, provenance: null }, start + HEADER_BYTES, size);
  }

  freeTemp(handle: HunkAllocation): void {
    const record = this.allocations.get(handle);
    if (record === undefined || !record.valid || record.kind !== "temporary") throw new Error("Hunk_FreeTempMemory: invalid, foreign or expired temporary allocation");
    if (this.headers.getUint32(record.start, true) !== HUNK_MAGIC) throw new CommonError("fatal", "Hunk_FreeTempMemory: bad magic");
    if (this.headers.getInt32(record.start + 4, true) !== record.size) throw new CommonError("fatal", "Hunk_FreeTempMemory: corrupt block size");
    this.headers.setUint32(record.start, HUNK_FREE_MAGIC, true);
    record.valid = false;
    this.allocations.delete(handle);
    const final = this.temporary === this.low
      ? record.start === this.temporary.temp - record.size
      : record.start === this.byteLength - this.temporary.temp;
    if (final) this.temporary.temp -= record.size;
    else this.print("Hunk_FreeTempMemory: not the final block\n");
  }

  private invalidate(predicate: (record: AllocationRecord) => boolean): void {
    for (const [handle, record] of this.allocations) {
      if (predicate(record)) { record.valid = false; this.allocations.delete(handle); }
    }
  }

  clearTemp(): void {
    this.invalidate(record => record.kind === "temporary");
    this.temporary.temp = this.temporary.permanent;
  }

  setMark(): void {
    this.low.mark = this.low.permanent;
    this.high.mark = this.high.permanent;
  }

  clearToMark(): void {
    this.invalidate(record => record.kind === "temporary" || record.end > record.bank.mark);
    this.low.permanent = this.low.temp = this.low.mark;
    this.high.permanent = this.high.temp = this.high.mark;
  }

  checkMark(): boolean { return this.low.mark !== 0 || this.high.mark !== 0; }

  ownsLiveAllocation(allocation: HunkAllocation): boolean {
    return this.allocations.get(allocation)?.valid === true;
  }

  memoryRemaining(): number {
    return this.byteLength - Math.max(this.low.permanent, this.low.temp) - Math.max(this.high.permanent, this.high.temp);
  }

  /** Com_TouchMemory retains the source high-bank upper bound, even when it skips that bank. */
  touchMemory(): number {
    let sum = 0;
    const lowEnd = this.low.permanent >> 2;
    for (let index = 0; index < lowEnd; index += 64) {
      sum = (sum + this.headers.getInt32(index * 4, true)) | 0;
    }
    const highEnd = this.high.permanent >> 2;
    for (let index = (this.byteLength - this.high.permanent) >> 2; index < highEnd; index += 64) {
      sum = (sum + this.headers.getInt32(index * 4, true)) | 0;
    }
    return sum;
  }

  snapshot(): HunkSnapshot {
    return { byteLength: this.byteLength, low: { ...this.low }, high: { ...this.high },
      permanentBank: this.permanent === this.low ? "low" : "high", temporaryBank: this.temporary === this.low ? "low" : "high" };
  }

  /** Newest first, grouped by case-insensitive file and line in Hunk_SmallLog.
   * Retired managed allocations are omitted, including after clearToMark. */
  log(write: (text: string) => void, small = false): void {
    write(`\r\n================\r\nHunk ${small ? "Small log" : "log"}\r\n================\r\n`);
    let total = 0, count = 0;
    if (this.debug !== undefined) {
      const records = [...this.allocations.values()].filter(record => record.kind === "permanent").reverse();
      const printed = new Set<AllocationRecord>();
      for (const record of records) {
        if (printed.has(record)) continue;
        printed.add(record);
        let size = record.size;
        const origin = record.provenance;
        if (small && origin !== null) {
          for (const other of records) {
            if (!printed.has(other) && other.provenance !== null && other.provenance.line === origin.line
              && other.provenance.file.toLowerCase() === origin.file.toLowerCase()) {
              printed.add(other); size = (size + other.size) | 0;
            }
          }
        }
        total = (total + size) | 0; count++;
        const location = origin === null ? "<unattributed>" : `${origin.file}, line: ${origin.line} (${origin.label})`;
        write(`size = ${String(size).padStart(8)}: ${location}\r\n`);
      }
    }
    write(`${total} Hunk memory\r\n`);
    write(`${count} hunk blocks\r\n`);
  }

  private reset(): void {
    this.invalidate(() => true);
    for (const selected of [this.low, this.high]) {
      selected.mark = 0; selected.permanent = 0; selected.temp = 0; selected.tempHighwater = 0;
    }
    this.permanent = this.low;
    this.temporary = this.high;
    this.print("Hunk_Clear: reset the hunk ok\n");
  }

  /** A null host is common startup before client/server module owners exist. */
  clear(host: HunkClearHost | null): void {
    if (this.clearing) throw new Error("Hunk clear cannot reenter its lifecycle callbacks");
    this.clearing = true;
    try {
      if (host?.kind === "client") { host.shutdownCGame(); host.shutdownUi(); }
      host?.shutdownGameProgs();
      if (host?.kind === "client") host.closeAllVideos();
      this.reset();
      host?.clearVm();
    } finally { this.clearing = false; }
  }

  async clearAsync(host: HunkAsyncClearHost): Promise<void> {
    if (this.clearing) throw new Error("Hunk clear cannot reenter its lifecycle callbacks");
    this.clearing = true;
    try {
      if (host.kind === "client") {
        const cgame = host.shutdownCGame(); if (cgame !== undefined) await cgame;
        const ui = host.shutdownUi(); if (ui !== undefined) await ui;
      }
      const game = host.shutdownGameProgs(); if (game !== undefined) await game;
      if (host.kind === "client") {
        const videos = host.closeAllVideos(); if (videos !== undefined) await videos;
      }
      this.reset();
      host.clearVm();
    } finally { this.clearing = false; }
  }
}

/** Engine owns com_hunkMegs registration/latching. Preinitialization Z_Malloc is a separate zone lifetime. */
export function initializeHunk(
  options: { readonly megs: number; readonly dedicated: boolean; readonly filesystemLoadStack: number; readonly debug?: HunkDebugProfile },
  print: (text: string) => void,
  host: HunkClearHost | null,
  adopt?: (arena: HunkArena) => void,
): HunkArena {
  signedInteger(options.megs, "com_hunkMegs");
  if (options.filesystemLoadStack !== 0) throw new CommonError("fatal", "Hunk initialization failed. File system load stack not zero");
  const minimum = options.dedicated ? 1 : 56;
  const megs = Math.max(options.megs, minimum);
  if (options.megs < minimum) print(options.dedicated
    ? `Minimum com_hunkMegs for a dedicated server is ${minimum}, allocating ${megs} megs.\n`
    : `Minimum com_hunkMegs is ${minimum}, allocating ${megs} megs.\n`);
  const arena = new HunkArena(megs * MEBIBYTE, print, options.debug);
  adopt?.(arena);
  arena.clear(host);
  return arena;
}
