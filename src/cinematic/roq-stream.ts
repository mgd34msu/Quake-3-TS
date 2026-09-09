// Ported from id Software's code/client/cl_cin.c: CIN_PlayCinematic, RoQInterrupt and RoQReset.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { FileHandle } from "../assets/file-handles.ts";
import type { VirtualFileSystem } from "../assets/vfs.ts";
import { BinaryError, BinaryReader } from "../core/binary.ts";

interface ChunkHeader { readonly id: number; readonly size: number; readonly flags: number }
export interface RoqStreamChunk extends ChunkHeader { readonly reader: BinaryReader }
type StreamFile = { readonly kind: "open"; readonly files: () => VirtualFileSystem; readonly handle: FileHandle }
  | { readonly kind: "missing"; readonly files: () => VirtualFileSystem }
  | { readonly kind: "bytes"; readonly data: Uint8Array }
  | { readonly kind: "closed" };

interface PendingChunk { readonly header: ChunkHeader; readonly offset: number; readonly buffered: boolean }

/** One unique source file, with only the current payload and following header in cin.file. */
export class RoqStream {
  private file: StreamFile;
  private readonly length: number;
  private position = 0;
  private played = 24;
  private header: Uint8Array | null = null;
  private nextHeader: ChunkHeader | null = null;
  private invalidLookahead = false;
  private retainedEof = false;
  private resetHeader = false;
  private inMemory = 0;
  private bufferedNext = false;
  private chunkOffset = 0;
  private bufferOffset = 0;
  private bufferedLength = 0;
  private pending: PendingChunk | null = null;

  private constructor(readonly source: string, length: number, file: StreamFile,
    private readonly buffer: Uint8Array, private readonly endPolicy: "complete" | "cinematic-lookahead") {
    this.file = file;
    this.length = length;
  }

  static open(files: () => VirtualFileSystem, source: string, buffer: Uint8Array): RoqStream | undefined {
    const opened = files().openUniqueRead(source);
    if (opened === undefined) return undefined;
    // CIN_Play leaves zero-length acquisitions in the common handle table.
    if (opened.length === 0) return undefined;
    return new RoqStream(source, opened.length, { kind: "open", files, handle: opened.file }, buffer, "cinematic-lookahead");
  }

  /** Diagnostic bytes use the same interrupt framing as the retained file owner. */
  static fromBytes(data: Uint8Array, source: string, buffer: Uint8Array,
    endPolicy: "complete" | "cinematic-lookahead" = "complete"): RoqStream {
    return new RoqStream(source, data.length, { kind: "bytes", data }, buffer, endPolicy);
  }

  initialize(): Uint8Array {
    if (this.header !== null) return this.header;
    const count = this.read(16);
    if (count !== 16 && !(this.file.kind === "bytes" && count === 8 && this.length === 8)) {
      throw new BinaryError(this.source, this.position, "truncated RoQ header");
    }
    this.bufferOffset = this.position - count;
    this.bufferedLength = count;
    this.header = this.buffer.slice(0, 8);
    this.nextHeader = count === 8 ? null : this.parseHeader(8);
    if (this.nextHeader !== null && this.nextHeader.size > 65536) throw new BinaryError(this.source, 10, "RoQ chunk exceeds 65536 bytes");
    return this.header;
  }

  /** CIN_Play resumes after its menu callback with a fresh read at the live file position. */
  beginPlayback(): void {
    this.header = null;
    this.resetHeader = false;
    this.played = 24;
    this.invalidLookahead = false;
    this.retainedEof = false;
    this.bufferedNext = false;
    this.pending = null;
    this.initialize();
  }

  get initializedByReset(): boolean { return this.resetHeader; }

  get hasInvalidLookahead(): boolean { return this.invalidLookahead; }

  get inPacket(): boolean { return this.bufferedNext; }

  nextChunk(): RoqStreamChunk | null {
    if (this.pending !== null) throw new Error("RoQ chunk dispatch has not completed");
    if (this.invalidLookahead) return null;
    if (this.header === null) throw new Error("RoQ stream has not been initialized");
    const header = this.nextHeader;
    if (header === null) return null;
    if (!this.bufferedNext) {
      const offset = this.position;
      const count = this.read(header.size + 8);
      // RoQInterrupt performs this read even when RoQPlayed already names EOF.
      if (this.endPolicy === "cinematic-lookahead" && this.played >= this.length) return null;
      if (this.endPolicy === "complete") {
        if (count < header.size) throw new BinaryError(this.source, offset + count, "truncated RoQ payload");
        this.bufferedLength = count;
      } else {
        if (count < header.size + 8) {
          // Leading audio can leave a complete final payload and retained lookahead in cin.file.
          if (count === header.size && this.position === this.length) this.retainedEof = true;
          else if (count !== 0 || !this.retainedEof)
            throw new BinaryError(this.source, offset + count, "truncated RoQ payload or lookahead header");
        }
        if (count === header.size + 8 && this.position === this.length) this.retainedEof = true;
        this.bufferedLength = header.size + 8;
      }
      this.bufferOffset = offset;
      this.chunkOffset = 0;
    }
    const offset = this.chunkOffset;
    const decodedSize = header.id === 0x1030 || header.id === 0x1013 ? 0 : header.size;
    const limit = this.bufferedNext ? Math.min(this.buffer.length, 65536) : this.bufferedLength;
    if (offset + decodedSize > limit) {
      throw new BinaryError(this.source, this.bufferOffset + offset, "RoQ packet payload exceeds source scratch buffer");
    }
    this.pending = { header, offset, buffered: this.bufferedNext };
    // decodeCodeBook follows its entry counts beyond the chunk into retained cin.file bytes.
    const end = header.id === 0x1002 && this.endPolicy === "cinematic-lookahead"
      ? Math.min(this.buffer.length, 65536) : offset + decodedSize;
    return { ...header, reader: new BinaryReader(this.buffer.subarray(offset, end), `${this.source}@${this.bufferOffset + offset}`) };
  }

  /** Finish the reached dispatch before selecting its next header or issuing another read. */
  completeChunk(ended = false): void {
    const pending = this.pending;
    if (pending === null) throw new Error("RoQ has no pending chunk dispatch");
    const { header, offset } = pending;
    if (header.id === 0x1030) this.inMemory = header.flags;
    const following = offset + (header.id === 0x1030 || header.id === 0x1013 ? 0 : header.size);
    if (this.endPolicy === "complete" && following === this.bufferedLength && this.inMemory === 0) {
      this.nextHeader = null;
      this.bufferedNext = false;
      this.pending = null;
      return;
    }
    // Redump may reach retained bytes after a reset; CIN_Play initialized the whole allocation.
    const limit = pending.buffered ? Math.min(this.buffer.length, 65536) : this.bufferedLength;
    if (following + 8 > limit) {
      throw new BinaryError(this.source, this.bufferOffset + following, "truncated RoQ packet or lookahead header");
    }
    this.nextHeader = this.parseHeader(following);
    this.invalidLookahead = this.nextHeader.size > 65536 || this.nextHeader.id === 0x1084;
    this.pending = null;
    this.bufferedNext = false;
    if (this.invalidLookahead) return;
    if (this.inMemory !== 0 && !ended) {
      this.inMemory--;
      this.chunkOffset = following + 8;
      this.bufferedNext = true;
    } else this.played += this.nextHeader.size + 8;
  }

  rewind(): void {
    const file = this.file;
    if (file.kind === "closed") throw new Error("Cannot reset a closed RoQ file");
    if (file.kind !== "bytes") {
      this.close();
      const opened = file.files().openUniqueRead(this.source);
      this.file = opened === undefined ? { kind: "missing", files: file.files } : { kind: "open", files: file.files, handle: opened.file };
    }
    this.position = 0;
    this.played = 24;
    this.invalidLookahead = false;
    this.retainedEof = false;
    this.bufferedNext = false;
    this.pending = null;
    // RoQReset ignores the read count, including FS_Read(handle=0), and does
    // not recheck the magic, size word or first chunk size before RoQ_init.
    const count = this.read(16);
    this.bufferOffset = 0;
    this.bufferedLength = 16;
    this.header = this.buffer.slice(0, 8);
    this.nextHeader = file.kind === "bytes" && count === 8 && this.length === 8 ? null : this.parseHeader(8);
    this.resetHeader = true;
  }

  close(): void {
    const file = this.file;
    if (file.kind === "closed") return;
    if (file.kind === "open") file.files().closeFile(file.handle);
    this.file = { kind: "closed" };
  }

  /** Common owns final table closure; retirement cannot call into its ended lifetime. */
  retire(): void { this.file = { kind: "closed" }; }

  private read(length: number): number {
    const file = this.file;
    if (file.kind === "closed") throw new Error("RoQ file is closed");
    if (length > this.buffer.length) throw new BinaryError(this.source, this.position, "RoQ chunk exceeds source scratch buffer");
    let count: number;
    if (file.kind === "bytes") {
      const data = file.data.subarray(this.position, this.position + length);
      this.buffer.set(data);
      count = data.length;
    } else count = file.kind === "missing" ? 0 : file.files().readInto(file.handle, this.buffer.subarray(0, length));
    this.position += count;
    return count;
  }

  private parseHeader(offset: number): ChunkHeader {
    const reader = new BinaryReader(this.buffer.subarray(offset, offset + 8), `${this.source}@${this.bufferOffset + offset}`);
    const id = reader.u16();
    // cl_cin reads three size bytes and skips the fourth.
    const size = reader.u32() & 0xffffff;
    const flags = reader.u16();
    return { id, size, flags };
  }
}
