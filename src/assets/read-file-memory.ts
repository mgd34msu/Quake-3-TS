// FS_ReadFile / FS_FreeFile from id Software's code/qcommon/files.c and common.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { CommonError } from "../core/common-error.ts";
import type { HunkAllocation, HunkArena } from "../core/hunk.ts";
import { ZoneTag } from "../core/zone.ts";
import type { ZoneAllocation, ZoneArena } from "../core/zone.ts";

export interface RetainedFileBuffer {
  readonly length: number;
  /** The file contents borrow the allocation until FS_FreeFile. */
  readonly bytes: Uint8Array;
  /** Includes the source's extra trailing NUL byte. */
  readonly terminatedBytes: Uint8Array;
}

export interface RetainedFileReader {
  readFileRetained(path: string): Promise<RetainedFileBuffer | undefined>;
  readFileRetainedSync(path: string): RetainedFileBuffer | undefined;
  freeFile(buffer: RetainedFileBuffer): void;
}

type FileStorage =
  | { readonly kind: "diagnostic"; readonly bytes: Uint8Array }
  | { readonly kind: "zone"; readonly arena: ZoneArena; readonly allocation: ZoneAllocation }
  | { readonly kind: "hunk"; readonly allocation: HunkAllocation };

interface FileRecord {
  storage: FileStorage | null;
}

/** The common FS_LoadStack survives mount replacement. Null mainZone selects standalone diagnostic storage. */
export class ReadFileMemory {
  private readonly active = new Map<RetainedFileBuffer, FileRecord>();
  private stack = 0;
  private count = 0;
  private disposed = false;

  constructor(
    private readonly hunk: () => HunkArena | null = () => null,
    private readonly mainZone: (() => ZoneArena) | null = null,
  ) {}

  get loadStack(): number { return this.stack; }
  get loadCount(): number { return this.count; }

  read(length: number, fill: (bytes: Uint8Array) => void, origin: "filesystem" | "journal" = "filesystem"): RetainedFileBuffer {
    if (this.disposed) throw new Error("FS_ReadFile memory owner is disposed");
    if (!Number.isInteger(length) || length < 0 || length >= 0x7fffffff) throw new RangeError("Invalid FS_ReadFile allocation length");
    if (origin === "filesystem") { this.count++; this.stack++; }
    const arena = this.hunk();
    let storage: FileStorage;
    if (arena !== null) storage = { kind: "hunk", allocation: arena.allocateTemp(length + 1) };
    else if (this.mainZone !== null) {
      const zone = this.mainZone();
      storage = { kind: "zone", arena: zone, allocation: zone.allocate(length + 1, ZoneTag.General, true) };
    } else storage = { kind: "diagnostic", bytes: new Uint8Array(length + 1) };
    const record: FileRecord = { storage };
    const allocatedBytes = (): Uint8Array => {
      const current = record.storage;
      if (current === null) throw new Error("FS_ReadFile buffer is no longer valid");
      return current.kind === "diagnostic" ? current.bytes : current.allocation.bytes;
    };
    const buffer: RetainedFileBuffer = {
      length,
      get bytes(): Uint8Array { return allocatedBytes().subarray(0, length); },
      get terminatedBytes(): Uint8Array { return allocatedBytes(); },
    };
    this.active.set(buffer, record);
    fill(buffer.bytes);
    if (origin === "journal") { this.count++; this.stack++; }
    buffer.terminatedBytes[length] = 0;
    return buffer;
  }

  freeFile(buffer: RetainedFileBuffer): void {
    if (this.disposed) throw new Error("FS_ReadFile memory owner is disposed");
    const record = this.active.get(buffer);
    if (record === undefined || record.storage === null) throw new CommonError("fatal", "FS_FreeFile: invalid or freed buffer");
    const storage = record.storage;
    this.stack--;
    const arena = this.hunk();
    if (storage.kind === "zone") {
      // After Hunk_Init, the source reads the zone's prev/id words as its hunk header.
      if (arena !== null) throw new CommonError("fatal", "Hunk_FreeTempMemory: bad magic");
      storage.arena.free(storage.allocation);
    } else if (storage.kind === "hunk") {
      if (arena === null) throw new CommonError("fatal", "Z_Free: freed a pointer without ZONEID");
      arena.freeTemp(storage.allocation);
    }
    record.storage = null;
    this.active.delete(buffer);
    if (this.stack === 0) this.hunk()?.clearTemp();
  }

  /** Terminal managed retirement, without source frees, hunk callbacks, or counter resets. */
  disposeResources(): void {
    this.disposed = true;
    for (const record of this.active.values()) record.storage = null;
    this.active.clear();
  }
}
