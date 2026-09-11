// Ported from id Software's code/qcommon/files.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { closeSync, fstatSync, readSync } from "node:fs";
import { nativeFileOperations } from "../platform/file-native.ts";
import { Buffer } from "node:buffer";
import { CommonError } from "../core/common-error.ts";
import type { Pk3FileReader } from "./pk3.ts";

class FileHandle {
  constructor(readonly slot: number, private readonly owner: SourceFileHandles) { Object.freeze(this); }

  belongsTo(owner: SourceFileHandles): boolean { return this.owner === owner; }
}

export type { FileHandle };

export class FileHandleExhaustionError extends CommonError {
  constructor() {
    super("drop", "FS_HandleForFile: none free");
    this.name = "FileHandleExhaustionError";
  }
}

class WriteFileLifetime {
  constructor(private readonly state: { closed: boolean }) { Object.freeze(this); }
  get closed(): boolean { return this.state.closed; }
}

export type { WriteFileLifetime };

export type FileSeekOrigin = "set" | "current" | "end";

export interface BorrowedLooseRead {
  readonly descriptor: number;
  readonly root: Buffer;
  assertCurrent(): void;
  readInto(destination: Uint8Array): number;
  close(): void;
}

interface WriteResource {
  readonly kind: "write";
  readonly descriptor: number;
  readonly lifetime: { closed: boolean };
  readonly append: boolean;
  /** Append opens and successful seeks need a FILE cursor separate from the descriptor offset. */
  position: number | null;
}

interface LooseReadResource {
  readonly kind: "loose-read";
  readonly descriptor: number;
  readonly downloadRoot: Buffer | null;
  position: number | null;
}

type FileResource =
  | LooseReadResource
  | { readonly kind: "packed-read"; readonly reader: Pk3FileReader }
  | WriteResource;

interface FileRow {
  readonly handle: FileHandle;
  name: string;
  resource: FileResource | null;
  fileSize: number;
  baseOffset: number;
  streamed: boolean;
  handleSync: boolean;
}

/** The source fsh[64] lifetime; only rows 1 through 63 are allocatable. */
export class SourceFileHandles {
  private readonly rows: readonly FileRow[];
  private serverZero: FileResource | null = null;
  private readonly displaced: FileResource[] = [];
  private disposed = false;
  private requestedReadCount = 0;

  constructor() {
    this.rows = Array.from({ length: 63 }, (_, index): FileRow => ({
      handle: new FileHandle(index + 1, this),
      name: "",
      resource: null,
      fileSize: 0,
      baseOffset: 0,
      streamed: false,
      handleSync: false,
    }));
  }

  get readCount(): number { return this.requestedReadCount; }
  get closed(): boolean { return this.disposed; }

  /** Untrusted VM integers resolve to this owner's existing source slot identities. */
  fromSlot(slot: number): FileHandle | null {
    this.assertActive();
    if (!Number.isInteger(slot) || slot < 0 || slot > this.rows.length) {
      throw new CommonError("drop", "FS_FileForHandle: out of reange");
    }
    if (slot === 0) return null;
    const row = this.rows[slot - 1];
    if (row === undefined) throw new RangeError("File handle table is incomplete");
    return row.handle;
  }

  setName(file: FileHandle, name: string): void {
    this.row(file).name = name.slice(0, 255);
  }

  printOpenFiles(print: (text: string) => void): void {
    for (const row of this.rows) {
      this.assertActive();
      if (row.resource !== null) print(`handle ${row.handle.slot}: ${row.name}\n`);
    }
  }

  assertActive(): void {
    if (this.disposed) throw new Error("Filesystem handles are closed");
  }

  /** Selection does not reserve a slot. Callers acquire and attach synchronously. */
  selectFree(): FileHandle {
    this.assertActive();
    for (const row of this.rows) if (row.resource === null) return row.handle;
    throw new FileHandleExhaustionError();
  }

  private row(file: FileHandle): FileRow {
    this.assertActive();
    const row = this.rows[file.slot - 1];
    if (!file.belongsTo(this) || row === undefined || row.handle !== file) {
      throw new RangeError("File handle belongs to a different filesystem");
    }
    return row;
  }

  private attach(file: FileHandle, resource: FileResource): FileRow {
    const row = this.row(file);
    if (row.resource !== null) throw new Error(`File handle ${file.slot} is already occupied`);
    row.resource = resource;
    return row;
  }

  attachLooseRead(file: FileHandle, descriptor: number): void {
    this.attach(file, { kind: "loose-read", descriptor, downloadRoot: null, position: null });
  }

  /** FS_SV_FOpenFileRead can assign fsh[0] after losing its selected handle. */
  assignServerRead(file: FileHandle | null, descriptor: number | undefined, downloadRoot: Buffer | null = null): void {
    this.assertActive();
    const resource: FileResource | null = descriptor === undefined ? null : {
      kind: "loose-read", descriptor, downloadRoot: downloadRoot === null ? null : Buffer.from(downloadRoot), position: null,
    };
    const row = file === null ? null : this.row(file);
    const previous = row === null ? this.serverZero : row.resource;
    if (previous !== null) {
      this.displaced.push(previous);
      if (previous.kind === "write") previous.lifetime.closed = true;
    }
    if (row === null) this.serverZero = resource;
    else { row.resource = resource; row.handleSync = false; }
  }

  serverReadOccupied(file: FileHandle | null): boolean {
    this.assertActive();
    return (file === null ? this.serverZero : this.row(file).resource) !== null;
  }

  /** FS_FCloseFile(0) can close the retained FS_SV_FOpenFileRead fallback. */
  closeZeroHandle(): void {
    this.assertActive();
    const resource = this.serverZero;
    this.serverZero = null;
    if (resource === null) return;
    if (resource.kind === "write") resource.lifetime.closed = true;
    if (resource.kind === "packed-read") resource.reader.close();
    else closeSync(resource.descriptor);
  }

  /** The mod description uses fread directly, without FS_Read accounting or retry. */
  readLooseDirect(file: FileHandle, destination: Uint8Array): number {
    const resource = this.row(file).resource;
    if (resource?.kind !== "loose-read") throw new Error("File handle is not a loose read");
    try {
      const count = readSync(resource.descriptor, destination, 0, destination.byteLength, resource.position);
      if (resource.position !== null) resource.position += count;
      return count;
    }
    catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string"
        && "errno" in error && typeof error.errno === "number" && "syscall" in error && error.syscall === "read") return 0;
      throw error;
    }
  }

  captureLooseLength(file: FileHandle): number {
    const resource = this.row(file).resource;
    if (resource?.kind !== "loose-read") throw new Error("File handle is not a loose read");
    const information = fstatSync(resource.descriptor);
    if (!information.isFile()) throw new Error("Opened loose asset is not a regular file");
    return information.size;
  }

  borrowLooseRead(file: FileHandle): BorrowedLooseRead {
    const row = this.row(file), resource = row.resource;
    if (resource?.kind !== "loose-read" || resource.downloadRoot === null) throw new Error("File handle is not a contained download read");
    const assertCurrent = (): void => {
      this.assertActive();
      if (row.resource !== resource) throw new Error("Borrowed loose file is closed or replaced");
    };
    return {
      descriptor: resource.descriptor,
      root: Buffer.from(resource.downloadRoot),
      assertCurrent,
      readInto: destination => { assertCurrent(); return this.readInto(file, destination); },
      close: () => { if (!this.disposed && row.resource === resource) this.closeFile(file); },
    };
  }

  attachPackedRead(file: FileHandle, reader: Pk3FileReader): void {
    this.attach(file, { kind: "packed-read", reader });
  }

  attachWrite(file: FileHandle, descriptor: number, synchronous: boolean, append: boolean): WriteFileLifetime {
    const lifetime = { closed: false };
    const position = append ? fstatSync(descriptor).size : null;
    const row = this.attach(file, { kind: "write", descriptor, lifetime, append, position });
    row.handleSync = synchronous;
    return new WriteFileLifetime(lifetime);
  }

  private writeResource(file: FileHandle): WriteResource {
    const resource = this.row(file).resource;
    if (resource?.kind !== "write") throw new Error("File handle is not writable");
    return resource;
  }

  private regularResource(resource: FileResource | null): LooseReadResource | WriteResource {
    if (resource === null) throw new CommonError("drop", "FS_FileForHandle: NULL");
    if (resource.kind === "packed-read") throw new CommonError("drop", "FS_FileForHandle: can't get FILE on zip file");
    return resource;
  }

  writeDescriptor(file: FileHandle): number { return this.regularResource(this.row(file).resource).descriptor; }

  writePosition(file: FileHandle): number | null {
    const resource = this.regularResource(this.row(file).resource);
    return resource.kind === "write" && resource.append ? null : resource.position;
  }

  advanceWrite(file: FileHandle, written: number): void {
    const resource = this.regularResource(this.row(file).resource);
    if (resource.kind === "write" && resource.append) resource.position = null;
    else if (resource.position !== null) resource.position += written;
  }

  tellWrite(file: FileHandle): number {
    return this.tellRegular(this.writeResource(file));
  }

  private tellRegular(resource: LooseReadResource | WriteResource): number {
    let offset = resource.position;
    if (offset === null) {
      offset = nativeFileOperations().descriptorPosition(resource.descriptor);
    }
    if (!Number.isSafeInteger(offset)) throw new RangeError("Writable file position exceeds safe integer range");
    return offset;
  }

  /** Regular-file FS_Seek. The source FILE position is shared by every borrowed view. */
  seekWrite(file: FileHandle, offset: number, origin: FileSeekOrigin): number {
    return this.seekRegular(this.writeResource(file), offset, origin);
  }

  private seekRegular(resource: LooseReadResource | WriteResource, offset: number, origin: FileSeekOrigin): number {
    if (!Number.isSafeInteger(offset)) return -1;
    let position: number;
    try {
      const information = fstatSync(resource.descriptor);
      if (!information.isFile()) return -1;
      const base = origin === "set" ? 0 : origin === "end" ? information.size : this.tellRegular(resource);
      position = base + offset;
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string"
        && "errno" in error && typeof error.errno === "number" && "syscall" in error
        && typeof error.syscall === "string") return -1;
      throw error;
    }
    if (!Number.isSafeInteger(position) || position < 0) return -1;
    resource.position = position;
    return 0;
  }

  /** Unix Sys_StreamSeek calls FS_Seek, then the original FS_Seek continues. */
  seek(file: FileHandle | null, offset: number, origin: number): number {
    this.assertActive();
    const row = file === null ? null : this.row(file);
    if (row?.streamed === true) {
      row.streamed = false;
      this.seek(file, offset, origin);
      row.streamed = true;
    }
    const resource = row === null ? this.serverZero : row.resource;
    if (resource?.kind === "packed-read") {
      if (offset >= 65536) throw new CommonError("fatal", "ZIP FILE FSEEK NOT YET IMPLEMENTED\n");
      if (!Number.isInteger(offset) || offset < 0) throw new RangeError("Negative ZIP seek exceeds the source scratch buffer");
      const result = resource.reader.rewind();
      if (offset === 0 && origin === 2) return result;
      if (file === null) throw new Error("Packed read cannot occupy the server zero row");
      return this.readInto(file, new Uint8Array(offset));
    }
    const regular = this.regularResource(resource);
    switch (origin) {
      case 0: return this.seekRegular(regular, offset, "current");
      case 1: return this.seekRegular(regular, offset, "end");
      case 2: return this.seekRegular(regular, offset, "set");
      default: throw new CommonError("fatal", "Bad origin in FS_Seek\n");
    }
  }

  setWriteMode(file: FileHandle): void {
    const row = this.row(file);
    row.baseOffset = this.tellWrite(file);
    row.fileSize = 0;
    row.streamed = false;
  }

  setReadMode(file: FileHandle, length: number): void {
    const row = this.row(file);
    if (row.resource === null || row.resource.kind === "write") throw new Error("File handle is not readable");
    row.fileSize = length;
    row.baseOffset = 0;
    row.streamed = true;
    row.handleSync = false;
  }

  readInto(file: FileHandle, destination: Uint8Array): number {
    return this.read(file, destination, false);
  }

  private read(file: FileHandle, destination: Uint8Array, sourceErrors: boolean): number {
    const resource = this.row(file).resource;
    this.requestedReadCount = (this.requestedReadCount + destination.byteLength) | 0;
    if (resource === null || (resource.kind === "write" && !sourceErrors)) throw new Error("File handle is not readable");
    if (resource.kind === "packed-read") return resource.reader.readInto(destination);
    let total = 0;
    let retriedZero = false;
    while (total < destination.byteLength) {
      let count: number;
      try { count = readSync(resource.descriptor, destination, total, destination.byteLength - total, resource.position); }
      catch (error) {
        if (!sourceErrors || !(error instanceof Error) || !("code" in error) || typeof error.code !== "string"
          || !("errno" in error) || typeof error.errno !== "number" || !("syscall" in error) || error.syscall !== "read") throw error;
        count = 0;
      }
      if (count === 0) {
        if (retriedZero) return total;
        retriedZero = true;
      }
      if (resource.position !== null) resource.position += count;
      total += count;
    }
    return total;
  }

  /** FS_Read2 toggles the existing source stream flag around Unix's direct read. */
  read2(file: FileHandle | null, destination: Uint8Array): number {
    this.assertActive();
    if (file === null) return 0;
    const row = this.row(file);
    if (row.resource === null) throw new CommonError("drop", "FS_FileForHandle: NULL");
    const streamed = row.streamed;
    row.streamed = false;
    const result = this.read(file, destination, true);
    row.streamed = streamed;
    return result;
  }

  /** Whole-file convenience reads retain the existing changed-size rejection. */
  validateWholeRead(file: FileHandle, expectedSize: number, copied: number): void {
    const resource = this.row(file).resource;
    if (resource?.kind === "packed-read" && expectedSize === 0) {
      if (resource.reader.readInto(new Uint8Array(1)) !== 0) {
        throw new Error("Empty packed asset returned unexpected payload bytes");
      }
      return;
    }
    if (resource?.kind !== "loose-read") return;
    const extra = new Uint8Array(1);
    const extraCount = readSync(resource.descriptor, extra, 0, 1, resource.position);
    if (resource.position !== null) resource.position += extraCount;
    const finalSize = fstatSync(resource.descriptor).size;
    if (copied !== expectedSize || extraCount !== 0 || finalSize !== expectedSize) {
      throw new Error(`Loose asset changed size while being read: expected ${expectedSize} bytes, copied ${copied}, final size ${finalSize}`);
    }
  }

  closeFile(file: FileHandle): void {
    const row = this.row(file);
    const resource = row.resource;
    row.resource = null;
    row.name = "";
    row.fileSize = 0;
    row.baseOffset = 0;
    row.streamed = false;
    row.handleSync = false;
    if (resource === null) return;
    if (resource.kind === "write") resource.lifetime.closed = true;
    if (resource.kind === "packed-read") resource.reader.close();
    else closeSync(resource.descriptor);
  }

  closeSizedFiles(): void {
    this.assertActive();
    const failures: unknown[] = [];
    for (const row of this.rows) {
      if (row.fileSize === 0) continue;
      try { this.closeFile(row.handle); } catch (error) { failures.push(error); }
    }
    if (failures.length !== 0) throw new AggregateError(failures, "Failed to close filesystem read handles", { cause: failures[0] });
  }

  close(): void {
    if (this.disposed) return;
    const failures: unknown[] = [];
    try {
      for (const row of this.rows) {
        try { this.closeFile(row.handle); } catch (error) { failures.push(error); }
      }
      if (this.serverZero !== null) this.displaced.push(this.serverZero);
      this.serverZero = null;
      for (const resource of this.displaced.splice(0)) {
        try {
          if (resource.kind === "write") resource.lifetime.closed = true;
          if (resource.kind === "packed-read") resource.reader.close();
          else closeSync(resource.descriptor);
        } catch (error) { failures.push(error); }
      }
    } finally {
      this.disposed = true;
    }
    if (failures.length !== 0) throw new AggregateError(failures, "Failed to close filesystem handles", { cause: failures[0] });
  }
}
