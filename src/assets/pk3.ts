// Ported from id Software's code/qcommon/files.c and code/qcommon/unzip.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { closeSync, fstatSync, openSync, readSync as nodeReadSync } from "node:fs";
import { blockChecksum, blockChecksumKey } from "../core/md4.ts";
import { RawInflateError, RawInflateReader } from "./inflate.ts";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;
const MAX_COMMENT_LENGTH = 0xffff;
const UNZ_BUFFER_SIZE = 65_536;
const MAX_DIAGNOSTIC_ENTRY_BYTES = 128 * 1024 * 1024;

export interface Pk3Entry {
  readonly path: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compressionMethod: 0 | 8;
  readonly crc32: number;
}

export interface Pk3FileInformation {
  readonly version: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly dosDate: number;
  readonly date: { readonly second: number; readonly minute: number; readonly hour: number;
    readonly day: number; readonly month: number; readonly year: number };
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly nameLength: number;
  readonly extraLength: number;
  readonly commentLength: number;
  readonly diskStart: number;
  readonly internalAttributes: number;
  readonly externalAttributes: number;
}

export interface Pk3InformationBuffers {
  readonly name?: Uint8Array;
  readonly extra?: Uint8Array;
  readonly comment?: Uint8Array;
}

/** unzStringFileNameCompare: Unix default is sensitive; other nonzero values fold ASCII. */
export function compareZipFileNames(first: string, second: string, sensitivity = 0): number {
  if (!Number.isInteger(sensitivity)) throw new RangeError("ZIP case sensitivity requires an integer");
  const code = (text: string, offset: number): number => {
    const value = offset >= text.length ? 0 : text.charCodeAt(offset);
    if (value > 255) throw new RangeError("ZIP filename comparison requires source bytes");
    return value;
  };
  for (let offset = 0;; offset++) {
    let a = code(first, offset), b = code(second, offset);
    if (sensitivity === 0 || sensitivity === 1) {
      if (a !== b || a === 0) return a - b;
    } else {
      if (a === 0) return b === 0 ? 0 : -1;
      if (b === 0) return 1;
      if (a >= 97 && a <= 122) a -= 32;
      if (b >= 97 && b <= 122) b -= 32;
      a = (a << 24) >> 24; b = (b << 24) >> 24;
      if (a !== b) return a < b ? -1 : 1;
    }
  }
}

export type Pk3SourceName =
  | { readonly kind: "supported"; readonly rawName: string; readonly name: string }
  | { readonly kind: "unsupported"; readonly rawName: string; readonly reason: "name-too-long" };

interface IndexedEntry {
  readonly publicEntry: Pk3Entry;
  readonly flags: number;
  readonly centralHeaderOffset: number;
  readonly localHeaderOffset: number;
  readonly zipOffset: number;
  readonly rawName: Uint8Array;
  readonly information: Pk3FileInformation;
}

interface EndOfCentralDirectory {
  readonly offset: number;
  readonly entryCount: number;
  readonly centralSize: number;
  readonly centralOffset: number;
  readonly zipOffset: number;
  readonly commentLength: number;
}

interface LocalEntryLayout {
  readonly nameLength: number;
  readonly variableLength: number;
}

export class Pk3Error extends Error {
  constructor(
    readonly source: string,
    readonly offset: number,
    message: string,
  ) {
    super(`${source}:${offset}: ${message}`);
    this.name = "Pk3Error";
  }
}

/** Rejections reached before unzip.c unzOpen can return an archive handle. */
export class Pk3OpenError extends Pk3Error {}

function checkedRange(source: string, length: number, offset: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
    || offset < 0 || size < 0 || offset > length - size) {
    throw new Pk3Error(source, offset, `range of ${size} bytes exceeds ${length}-byte input`);
  }
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(source: string, bytes: Uint8Array, offset: number): number {
  checkedRange(source, bytes.byteLength, offset, 2);
  return viewOf(bytes).getUint16(offset, true);
}

function u32(source: string, bytes: Uint8Array, offset: number): number {
  checkedRange(source, bytes.byteLength, offset, 4);
  return viewOf(bytes).getUint32(offset, true);
}

function fileInformation(source: string, header: Uint8Array): Pk3FileInformation {
  const dosDate = u32(source, header, 12), date = dosDate >>> 16;
  return Object.freeze({ version: u16(source, header, 4), versionNeeded: u16(source, header, 6),
    flags: u16(source, header, 8), compressionMethod: u16(source, header, 10), dosDate,
    date: Object.freeze({ second: 2 * (dosDate & 31), minute: (dosDate & 0x7e0) >>> 5,
      hour: (dosDate & 0xf800) >>> 11, day: date & 31, month: (((date & 0x1e0) >>> 5) - 1) >>> 0,
      year: ((date & 0xfe00) >>> 9) + 1980 }),
    crc32: u32(source, header, 16), compressedSize: u32(source, header, 20), uncompressedSize: u32(source, header, 24),
    nameLength: u16(source, header, 28), extraLength: u16(source, header, 30), commentLength: u16(source, header, 32),
    diskStart: u16(source, header, 34), internalAttributes: u16(source, header, 36), externalAttributes: u32(source, header, 38) });
}

async function readSlice(file: Bun.BunFile, source: string, offset: number, size: number): Promise<Uint8Array> {
  checkedRange(source, file.size, offset, size);
  const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
  if (bytes.byteLength !== size) throw new Pk3Error(source, offset, `short read: expected ${size} bytes, got ${bytes.byteLength}`);
  return bytes;
}

function readSliceSync(
  descriptor: number,
  source: string,
  fileSize: number,
  offset: number,
  size: number,
): Uint8Array {
  checkedRange(source, fileSize, offset, size);
  const bytes = new Uint8Array(size);
  readIntoSliceSync(descriptor, source, fileSize, offset, bytes);
  return bytes;
}

function readIntoSliceSync(
  descriptor: number,
  source: string,
  fileSize: number,
  offset: number,
  destination: Uint8Array,
): void {
  const size = destination.byteLength;
  checkedRange(source, fileSize, offset, size);
  let total = 0;
  while (total < size) {
    const count = nodeReadSync(descriptor, destination, total, size - total, offset + total);
    if (count === 0) break;
    total += count;
  }
  if (total !== size) throw new Pk3Error(source, offset, `short read: expected ${size} bytes, got ${total}`);
}

function asciiLower(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    result += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return result;
}

function sourceName(bytes: Uint8Array): Pk3SourceName {
  let rawName = "";
  for (const byte of bytes) rawName += String.fromCharCode(byte);
  // unzGetCurrentFileInfo leaves a full MAX_ZPATH buffer unterminated.
  if (bytes.byteLength >= 256) return Object.freeze({ kind: "unsupported", rawName, reason: "name-too-long" });
  // The Linux C-locale glibc profile preserves high bytes passed as signed
  // char to Q_strlwr's tolower, including 255 promoted to EOF.
  return Object.freeze({ kind: "supported", rawName, name: asciiLower(rawName) });
}

export function normalizeAssetPath(path: string): string {
  if (path.length === 0) throw new RangeError("Asset path must not be empty");
  if (path.includes("\0")) throw new RangeError("Asset path contains NUL");
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    throw new RangeError(`Asset path must be relative: ${JSON.stringify(path)}`);
  }
  if (path.includes(":")) throw new RangeError(`Asset path contains an invalid separator: ${JSON.stringify(path)}`);
  const separated = path.replaceAll("\\", "/");
  if (separated.includes("..")) throw new RangeError(`Asset path contains traversal: ${JSON.stringify(path)}`);
  const parts = separated.split("/");
  for (const part of parts) {
    if (part.length === 0 || part === ".") throw new RangeError(`Asset path contains an empty or relative component: ${JSON.stringify(path)}`);
  }
  return asciiLower(separated);
}

function normalizeAssetPrefix(prefix: string): string {
  if (prefix.length === 0) return "";
  const separated = prefix.replaceAll("\\", "/");
  if (!separated.endsWith("/")) return normalizeAssetPath(separated);
  const path = separated.slice(0, -1);
  return `${normalizeAssetPath(path)}/`;
}

function decodeName(source: string, offset: number, bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Pk3Error(source, offset, "entry name contains NUL");
  // unzip.c reads filename bytes verbatim, including when ZIP bit 11 is set.
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function checkedEntryPath(source: string, offset: number, rawName: Uint8Array): string | undefined {
  const name = decodeName(source, offset, rawName);
  const directory = name.endsWith("/") || name.endsWith("\\");
  const candidate = directory ? name.slice(0, -1) : name;
  try {
    const normalized = normalizeAssetPath(candidate);
    return directory ? undefined : normalized;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Pk3Error(source, offset, `unsafe entry name: ${detail}`);
  }
}

function findEndRecord(source: string, fileSize: number, tail: Uint8Array, tailOffset: number): EndOfCentralDirectory {
  for (let offset = tail.byteLength - EOCD_LENGTH; offset >= 0; offset--) {
    if (u32(source, tail, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = u16(source, tail, offset + 20);
    if (offset + EOCD_LENGTH + commentLength !== tail.byteLength) continue;
    const disk = u16(source, tail, offset + 4);
    const centralDisk = u16(source, tail, offset + 6);
    const diskEntryCount = u16(source, tail, offset + 8);
    const entryCount = u16(source, tail, offset + 10);
    const centralSize = u32(source, tail, offset + 12);
    const centralOffset = u32(source, tail, offset + 16);
    const absoluteOffset = tailOffset + offset;
    if (disk !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
      throw new Pk3Error(source, absoluteOffset, "multi-disk ZIP archives are not supported");
    }
    if (centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Pk3Error(source, absoluteOffset, "ZIP64 archives are not supported");
    }
    checkedRange(source, fileSize, centralOffset, centralSize);
    if (centralOffset + centralSize > absoluteOffset) {
      throw new Pk3Error(source, absoluteOffset, "central directory extends beyond the end record");
    }
    const zipOffset = absoluteOffset - centralOffset - centralSize;
    return { offset: absoluteOffset, entryCount, centralSize, centralOffset: centralOffset + zipOffset, zipOffset, commentLength };
  }
  throw new Pk3Error(source, Math.max(0, fileSize - tail.byteLength), "ZIP end-of-central-directory record not found");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) {
    const value = CRC_TABLE[(crc ^ byte) & 0xff];
    if (value === undefined) throw new Error("CRC table index outside byte range");
    crc = value ^ (crc >>> 8);
  }
  return crc;
}

function validateCrc32(source: string, dataOffset: number, expected: number, crc: number): void {
  const actual = (crc ^ 0xffffffff) >>> 0;
  if (actual !== expected) {
    throw new Pk3Error(source, dataOffset, `CRC32 ${actual.toString(16)} does not match ${expected.toString(16)}`);
  }
}

function validateLocalHeader(source: string, entry: IndexedEntry, header: Uint8Array): LocalEntryLayout {
  if (u32(source, header, 0) !== LOCAL_SIGNATURE) {
    throw new Pk3Error(source, entry.localHeaderOffset, "invalid local file header signature");
  }
  const flags = u16(source, header, 6);
  const method = u16(source, header, 8);
  const localCrc = u32(source, header, 14);
  const localCompressedSize = u32(source, header, 18);
  const localUncompressedSize = u32(source, header, 22);
  const nameLength = u16(source, header, 26);
  const extraLength = u16(source, header, 28);
  if (flags !== entry.flags || method !== entry.publicEntry.compressionMethod) {
    throw new Pk3Error(source, entry.localHeaderOffset, "local header disagrees with central directory");
  }
  if ((flags & 8) === 0 && (localCrc !== entry.publicEntry.crc32
    || localCompressedSize !== entry.publicEntry.compressedSize
    || localUncompressedSize !== entry.publicEntry.uncompressedSize)) {
    throw new Pk3Error(source, entry.localHeaderOffset, "local sizes or CRC disagree with central directory");
  }
  if ((flags & 8) !== 0 && ((localCrc !== 0 && localCrc !== entry.publicEntry.crc32)
    || (localCompressedSize !== 0 && localCompressedSize !== entry.publicEntry.compressedSize)
    || (localUncompressedSize !== 0 && localUncompressedSize !== entry.publicEntry.uncompressedSize))) {
    throw new Pk3Error(source, entry.localHeaderOffset, "local data-descriptor fields disagree with central directory");
  }
  return Object.freeze({ nameLength, variableLength: nameLength + extraLength });
}

function entryDataOffset(
  source: string,
  centralOffset: number,
  entry: IndexedEntry,
  layout: LocalEntryLayout,
  variable: Uint8Array,
): number {
  if (!sameBytes(variable.subarray(0, layout.nameLength), entry.rawName)) {
    throw new Pk3Error(source, entry.localHeaderOffset + LOCAL_LENGTH, "local entry name disagrees with central directory");
  }
  const dataOffset = entry.localHeaderOffset + LOCAL_LENGTH + layout.variableLength;
  if (dataOffset > centralOffset - entry.publicEntry.compressedSize) {
    throw new Pk3Error(source, dataOffset, "entry data overlaps central directory");
  }
  return dataOffset;
}

function decodeEntry(source: string, dataOffset: number, entry: Pk3Entry, compressed: Uint8Array): Uint8Array {
  let position = 0;
  const output = entry.compressionMethod === 0 ? compressed : inflateEntry(source, dataOffset, entry, () => {
    const byte = compressed[position];
    if (byte !== undefined) position++;
    return byte;
  });
  validateCrc32(source, dataOffset, entry.crc32, updateCrc32(0xffffffff, output));
  return output;
}

function checkDiagnosticReadSize(source: string, offset: number, entry: Pk3Entry): void {
  if (entry.compressedSize > MAX_DIAGNOSTIC_ENTRY_BYTES || entry.uncompressedSize > MAX_DIAGNOSTIC_ENTRY_BYTES) {
    throw new Pk3Error(source, offset, `diagnostic whole-entry read exceeds ${MAX_DIAGNOSTIC_ENTRY_BYTES} bytes`);
  }
}

function readInflated(source: string, dataOffset: number, reader: RawInflateReader, destination: Uint8Array): number {
  try {
    return reader.readInto(destination);
  } catch (error) {
    if (error instanceof RawInflateError) {
      throw new Pk3Error(source, dataOffset, `deflate stream failed: ${error.message}`);
    }
    throw error;
  }
}

function inflateEntry(source: string, dataOffset: number, entry: Pk3Entry, readByte: () => number | undefined): Uint8Array {
  const reader = new RawInflateReader(readByte);
  const output = new Uint8Array(entry.uncompressedSize);
  const count = readInflated(source, dataOffset, reader, output);
  if (count !== output.byteLength) {
    throw new Pk3Error(source, dataOffset, `inflated size ${count} does not match ${entry.uncompressedSize}`);
  }
  // Whole-file asset reads retain their stricter size/end validation. Source
  // unzReadCurrentFile stops at the declared size without this terminal probe.
  if (readInflated(source, dataOffset, reader, new Uint8Array(1)) !== 0) {
    throw new Pk3Error(source, dataOffset, `deflate stream failed: output exceeds ${entry.uncompressedSize} bytes`);
  }
  return output;
}

interface OpenedEntry {
  readonly descriptor: number;
  readonly fileSize: number;
  readonly dataOffset: number;
  readonly entry: Pk3Entry;
  readonly centralOffset: number;
  readonly indexed: IndexedEntry;
  readonly localExtraOffset: number;
  readonly localExtraLength: number;
}

function rereadEntryInformation(source: string, descriptor: number, fileSize: number, centralOffset: number, indexed: IndexedEntry): IndexedEntry {
  return readEntryInformation(source, descriptor, fileSize, centralOffset, indexed.centralHeaderOffset, indexed.zipOffset, indexed.publicEntry.path);
}

function readEntryInformation(source: string, descriptor: number, fileSize: number, centralOffset: number,
  offset: number, zipOffset: number, path: string | null): IndexedEntry {
  const header = readSliceSync(descriptor, source, fileSize, offset, CENTRAL_LENGTH);
  if (u32(source, header, 0) !== CENTRAL_SIGNATURE) throw new Pk3Error(source, offset, "invalid central directory signature");
  const flags = u16(source, header, 8);
  const method = u16(source, header, 10);
  const crc32 = u32(source, header, 16);
  const compressedSize = u32(source, header, 20);
  const uncompressedSize = u32(source, header, 24);
  const nameLength = u16(source, header, 28);
  const localHeaderOffset = u32(source, header, 42) + zipOffset;
  if ((flags & 1) !== 0) throw new Pk3Error(source, offset, "encrypted entries are not supported");
  if (method !== 0 && method !== 8) throw new Pk3Error(source, offset, `unsupported compression method ${method}`);
  if (u16(source, header, 34) !== 0) throw new Pk3Error(source, offset, "entry starts on another disk");
  if (method === 0 && compressedSize !== uncompressedSize) {
    throw new Pk3Error(source, offset, "stored entry has different compressed and uncompressed sizes");
  }
  checkedRange(source, centralOffset, localHeaderOffset, LOCAL_LENGTH);
  const rawName = readSliceSync(descriptor, source, fileSize, offset + CENTRAL_LENGTH, nameLength);
  const selectedPath = path ?? checkedEntryPath(source, offset + CENTRAL_LENGTH, rawName)
    ?? decodeName(source, offset + CENTRAL_LENGTH, rawName);
  const publicEntry = Object.freeze({ path: selectedPath, compressedSize, uncompressedSize,
    compressionMethod: method, crc32 } satisfies Pk3Entry);
  return Object.freeze({ publicEntry, flags, centralHeaderOffset: offset, localHeaderOffset, zipOffset, rawName,
    information: fileInformation(source, header) });
}

function validateOpenedEntry(source: string, descriptor: number, centralOffset: number, indexed: IndexedEntry,
  informationSource: "indexed" | "current" = "indexed"): OpenedEntry {
  const information = fstatSync(descriptor);
  if (!information.isFile()) throw new Pk3Error(source, 0, "archive is no longer a regular file");
  const entry = informationSource === "current"
    ? rereadEntryInformation(source, descriptor, information.size, centralOffset, indexed)
    : indexed;
  const header = readSliceSync(descriptor, source, information.size, entry.localHeaderOffset, LOCAL_LENGTH);
  const layout = validateLocalHeader(source, entry, header);
  const variable = readSliceSync(descriptor, source, information.size,
    entry.localHeaderOffset + LOCAL_LENGTH, layout.variableLength);
  const dataOffset = entryDataOffset(source, centralOffset, entry, layout, variable);
  checkedRange(source, information.size, dataOffset, entry.publicEntry.compressedSize);
  return { descriptor, fileSize: information.size, dataOffset, entry: entry.publicEntry, centralOffset, indexed: entry,
    localExtraOffset: entry.localHeaderOffset - entry.zipOffset + LOCAL_LENGTH + layout.nameLength,
    localExtraLength: layout.variableLength - layout.nameLength };
}

function openEntrySync(source: string, nativePath: Buffer, centralOffset: number, selectEntry: () => IndexedEntry): OpenedEntry {
  const descriptor = openSync(nativePath, "r");
  try {
    return validateOpenedEntry(source, descriptor, centralOffset, selectEntry());
  } catch (error) {
    try {
      closeSync(descriptor);
    } finally {
      // Keep the acquisition failure if descriptor cleanup also fails.
      throw error;
    }
  }
}

function readOpenedEntry(source: string, opened: OpenedEntry): Uint8Array {
  const input = new Pk3EntryInput(source, opened);
  let output: Uint8Array;
  if (opened.entry.compressionMethod === 0) {
    output = new Uint8Array(opened.entry.uncompressedSize);
    input.readInto(output);
  } else {
    output = inflateEntry(source, opened.dataOffset, opened.entry, () => input.readByte());
  }
  validateCrc32(source, opened.dataOffset, opened.entry.crc32, updateCrc32(0xffffffff, output));
  return output;
}

class Pk3EntryInput {
  private readonly buffer = new Uint8Array(UNZ_BUFFER_SIZE);
  private readonly bytes = new DataView(this.buffer.buffer);
  private position = 0;
  private available = 0;
  private loaded = 0;

  constructor(private readonly source: string, private readonly opened: OpenedEntry) {}

  private refill(): boolean {
    if (this.position < this.available) return true;
    const count = Math.min(this.buffer.byteLength, this.opened.entry.compressedSize - this.loaded);
    if (count === 0) return false;
    readIntoSliceSync(this.opened.descriptor, this.source, this.opened.fileSize,
      this.opened.dataOffset + this.loaded, this.buffer.subarray(0, count));
    this.loaded += count;
    this.position = 0;
    this.available = count;
    return true;
  }

  readByte(): number | undefined {
    if (!this.refill()) return undefined;
    return this.bytes.getUint8(this.position++);
  }

  readInto(destination: Uint8Array): number {
    let count = 0;
    while (count < destination.byteLength && this.refill()) {
      const copied = Math.min(destination.byteLength - count, this.available - this.position);
      destination.set(this.buffer.subarray(this.position, this.position + copied), count);
      this.position += copied;
      count += copied;
    }
    return count;
  }
}

type ReaderState =
  | { readonly kind: "pending"; readonly opened: OpenedEntry }
  | { readonly kind: "reading"; readonly opened: OpenedEntry; readonly reader: Pk3EntryInput | RawInflateReader; offset: number }
  | { readonly kind: "closed" };

// FS_FOpenFileByMode(FS_READ) uses an independent unzReOpen cursor. This
// reader retains the source 64 KiB compressed buffer and incremental decoder.
// Both CRC accumulation and the close-time CRC check are disabled in unzip.c.
class RetainedPk3Reader {
  private entryLength: number;
  private state: ReaderState;

  constructor(private readonly source: string, opened: OpenedEntry, private readonly ownership: "independent" | "shared") {
    this.entryLength = opened.entry.uncompressedSize;
    this.state = { kind: "pending", opened };
  }

  get length(): number { return this.entryLength; }

  get position(): number {
    const state = this.state;
    if (state.kind === "closed") throw new Pk3Error(this.source, 0, "entry reader is closed");
    return state.kind === "pending" ? 0 : state.offset;
  }

  get eof(): boolean { return this.position === this.entryLength; }

  /** Source never advances this cursor and reads the full extra field even for a smaller len. */
  readLocalExtraField(destination: Uint8Array | null, length = destination?.byteLength ?? 0): number {
    const state = this.state;
    if (state.kind === "closed") throw new Pk3Error(this.source, 0, "entry reader is closed");
    const { opened } = state, remaining = opened.localExtraLength;
    if (destination === null) return remaining;
    if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) throw new RangeError("Local extra length requires a source unsigned int");
    const copied = Math.min(length, remaining);
    if (copied === 0) return 0;
    if (destination.byteLength < remaining) throw new RangeError("Source local extra read would overflow its destination");
    // unzGetLocalExtrafield omits byte_before_the_zipfile from this seek.
    readIntoSliceSync(opened.descriptor, this.source, opened.fileSize, opened.localExtraOffset, destination.subarray(0, remaining));
    return copied;
  }

  /** FS_Seek rereads the saved central record before unzOpenCurrentFile. */
  rewind(): number {
    const state = this.state;
    if (state.kind === "closed") throw new Pk3Error(this.source, 0, "entry reader is closed");
    try {
      const previous = state.opened;
      const opened = validateOpenedEntry(this.source, previous.descriptor, previous.centralOffset, previous.indexed, "current");
      this.state = { kind: "pending", opened };
      this.entryLength = opened.entry.uncompressedSize;
      return 0;
    } catch (error) {
      try { this.close(); } finally { throw error; }
    }
  }

  readInto(destination: Uint8Array): number {
    let state = this.state;
    if (state.kind === "closed") throw new Pk3Error(this.source, 0, "entry reader is closed");
    if (destination.byteLength === 0) return 0;
    try {
      if (state.kind === "pending") {
        const input = new Pk3EntryInput(this.source, state.opened);
        const reader = state.opened.entry.compressionMethod === 0 ? input : new RawInflateReader(() => input.readByte());
        state = { kind: "reading", opened: state.opened, reader, offset: 0 };
        this.state = state;
      }
      const requested = destination.subarray(0, Math.min(destination.byteLength, this.length - state.offset));
      const count = state.reader instanceof RawInflateReader
        ? readInflated(this.source, state.opened.dataOffset, state.reader, requested)
        : state.reader.readInto(requested);
      state.offset += count;
      return count;
    } catch (error) {
      try {
        this.close();
      } finally {
        // A failed read consumes its descriptor without hiding the read error.
        throw error;
      }
    }
  }

  close(): void {
    const state = this.state;
    if (state.kind === "closed") return;
    this.state = { kind: "closed" };
    if (this.ownership === "independent") closeSync(state.opened.descriptor);
  }
}

class SharedPk3Reader {
  constructor(private readonly owner: SharedPk3Entries,
    private readonly centralOffset: number, private readonly entry: IndexedEntry) {}

  get length(): number { return this.owner.length; }
  get position(): number { return this.owner.currentReader.position; }
  get eof(): boolean { return this.owner.currentReader.eof; }

  readLocalExtraField(destination: Uint8Array | null, length = destination?.byteLength ?? 0): number {
    return this.owner.currentReader.readLocalExtraField(destination, length);
  }

  rewind(): number {
    return this.owner.rewind(this.centralOffset, this.entry);
  }

  readInto(destination: Uint8Array): number {
    return this.owner.readInto(destination);
  }

  close(): void {
    this.owner.closeEntry();
  }
}

// Source unique=false handles all address the archive's current entry. Closing
// one entry leaves the backing archive descriptor for its next transaction.
class SharedPk3Entries {
  private state: { readonly descriptor: number; current: RetainedPk3Reader | undefined; length: number | undefined } | undefined;
  private directory: { position: number; number: number;
    information: { readonly kind: "valid"; readonly entry: IndexedEntry } | { readonly kind: "invalid" } };

  constructor(private readonly source: string, descriptor: number, private readonly end: EndOfCentralDirectory,
    last: IndexedEntry | null) {
    this.state = { descriptor, current: undefined, length: last?.publicEntry.uncompressedSize };
    // FS_LoadZipFile's two enumeration passes leave the archive on its final record.
    this.directory = { position: (last?.centralHeaderOffset ?? end.centralOffset) - end.zipOffset,
      number: Math.max(0, end.entryCount - 1), information: last === null ? { kind: "invalid" } : { kind: "valid", entry: last } };
  }

  requireOpen() {
    const state = this.state;
    if (state === undefined) throw new Pk3Error(this.source, 0, "archive is closed");
    return state;
  }

  open(centralOffset: number, entry: IndexedEntry): SharedPk3Reader {
    const state = this.requireOpen();
    try {
      const information = this.selectFileInformation(centralOffset, entry);
      this.closeEntry();
      const opened = validateOpenedEntry(this.source, state.descriptor, centralOffset, information);
      state.current = new RetainedPk3Reader(this.source, opened, "shared");
      return new SharedPk3Reader(this, centralOffset, entry);
    } catch (error) {
      try {
        this.closeEntry();
      } finally {
        throw error;
      }
    }
  }

  get currentReader(): RetainedPk3Reader {
    const current = this.requireOpen().current;
    if (current === undefined) throw new Pk3Error(this.source, 0, "shared entry reader is closed");
    return current;
  }

  get position(): number { this.requireOpen(); return this.directory.position; }

  private selectPosition(position: number): IndexedEntry {
    const state = this.requireOpen();
    this.directory.position = position;
    this.directory.information = { kind: "invalid" };
    const entry = readEntryInformation(this.source, state.descriptor, fstatSync(state.descriptor).size,
      this.end.centralOffset, position + this.end.zipOffset, this.end.zipOffset, null);
    this.directory.information = { kind: "valid", entry };
    state.length = entry.publicEntry.uncompressedSize;
    return entry;
  }

  firstFile(): void {
    this.directory.number = 0;
    this.selectPosition(this.end.centralOffset - this.end.zipOffset);
  }

  nextFile(): boolean {
    this.requireOpen();
    const selection = this.directory.information;
    if (selection.kind === "invalid" || this.directory.number + 1 === this.end.entryCount) return false;
    const info = selection.entry.information;
    this.directory.number++;
    this.selectPosition(this.directory.position + CENTRAL_LENGTH + info.nameLength + info.extraLength + info.commentLength);
    return true;
  }

  setPosition(position: number): void {
    this.requireOpen();
    if (!Number.isInteger(position) || position < 0 || position > 0xffffffff) throw new RangeError("ZIP central position requires a source unsigned long");
    try { this.selectPosition(position); }
    catch (error) { if (!(error instanceof Pk3Error)) throw error; }
    // unzSetCurrentFileInfoPosition returns OK even when its metadata read failed.
  }

  currentInformation(buffers: Pk3InformationBuffers): Pk3FileInformation {
    const state = this.requireOpen(), size = fstatSync(state.descriptor).size;
    const offset = this.directory.position + this.end.zipOffset;
    const entry = readEntryInformation(this.source, state.descriptor, size, this.end.centralOffset, offset, this.end.zipOffset, null);
    const info = entry.information;
    const copy = (destination: Uint8Array | undefined, start: number, length: number, terminate: boolean): void => {
      if (destination === undefined) return;
      if (terminate && length < destination.byteLength) destination[length] = 0;
      const count = Math.min(length, destination.byteLength);
      if (count > 0) readIntoSliceSync(state.descriptor, this.source, size, start, destination.subarray(0, count));
    };
    copy(buffers.name, offset + CENTRAL_LENGTH, info.nameLength, true);
    copy(buffers.extra, offset + CENTRAL_LENGTH + info.nameLength, info.extraLength, false);
    copy(buffers.comment, offset + CENTRAL_LENGTH + info.nameLength + info.extraLength, info.commentLength, true);
    return info;
  }

  locateFile(filename: string, sensitivity: number): boolean {
    this.requireOpen();
    const terminator = filename.indexOf("\0"), requested = terminator < 0 ? filename : filename.slice(0, terminator);
    if (requested.length >= 256) throw new RangeError("unzLocateFile name must be shorter than 256 bytes");
    compareZipFileNames(requested, requested, sensitivity);
    if (this.directory.information.kind === "invalid") return false;
    const position = this.directory.position, number = this.directory.number;
    this.firstFile();
    for (;;) {
      const name = new Uint8Array(256);
      const info = this.currentInformation({ name });
      if (info.nameLength >= name.byteLength) throw new RangeError("Source locate filename buffer is unterminated");
      let currentName = "";
      for (const byte of name) { if (byte === 0) break; currentName += String.fromCharCode(byte); }
      if (compareZipFileNames(currentName, requested, sensitivity) === 0) return true;
      if (!this.nextFile()) break;
    }
    // Source restores positions, but deliberately leaves the last scanned cached metadata.
    this.directory.position = position; this.directory.number = number;
    return false;
  }

  openCurrent(): SharedPk3Reader {
    const state = this.requireOpen(), selection = this.directory.information;
    if (selection.kind === "invalid") throw new Pk3Error(this.source, 0, "archive has no valid current file information");
    this.closeEntry();
    const opened = validateOpenedEntry(this.source, state.descriptor, this.end.centralOffset, selection.entry);
    state.current = new RetainedPk3Reader(this.source, opened, "shared");
    return new SharedPk3Reader(this, this.end.centralOffset, selection.entry);
  }

  globalComment(destination: Uint8Array): number {
    const state = this.requireOpen(), count = Math.min(destination.byteLength, this.end.commentLength);
    if (count > 0) {
      destination[0] = 0;
      readIntoSliceSync(state.descriptor, this.source, fstatSync(state.descriptor).size,
        this.end.offset + EOCD_LENGTH, destination.subarray(0, count));
    }
    if (destination.byteLength > this.end.commentLength) destination[this.end.commentLength] = 0;
    return count;
  }

  get length(): number {
    const length = this.state?.length;
    if (length === undefined) throw new Pk3Error(this.source, 0, "shared archive has no current file information");
    return length;
  }

  selectFileInformation(centralOffset: number, entry: IndexedEntry): IndexedEntry {
    const state = this.requireOpen();
    this.directory.position = entry.centralHeaderOffset - entry.zipOffset;
    this.directory.information = { kind: "invalid" };
    const information = rereadEntryInformation(this.source, state.descriptor,
      fstatSync(state.descriptor).size, centralOffset, entry);
    this.directory.information = { kind: "valid", entry: information };
    state.length = information.publicEntry.uncompressedSize;
    return information;
  }

  rewind(centralOffset: number, entry: IndexedEntry): number {
    if (this.state === undefined) throw new Pk3Error(this.source, 0, "shared archive reader is closed");
    this.open(centralOffset, entry);
    return 0;
  }

  readInto(destination: Uint8Array): number {
    const current = this.state?.current;
    if (current === undefined) throw new Pk3Error(this.source, 0, "shared entry reader is closed");
    try {
      return current.readInto(destination);
    } catch (error) {
      try {
        this.closeEntry();
      } finally {
        throw error;
      }
    }
  }

  closeEntry(): void {
    const state = this.state;
    if (state === undefined) return;
    state.current?.close();
    state.current = undefined;
  }

  close(): void {
    const state = this.state;
    if (state === undefined) return;
    this.state = undefined;
    state.current?.close();
    closeSync(state.descriptor);
  }
}

export type Pk3FileReader = RetainedPk3Reader | SharedPk3Reader;

export class Pk3Archive implements Disposable {
  readonly entries: readonly Pk3Entry[];
  readonly sourceNames: readonly Pk3SourceName[];
  private readonly sharedEntries: SharedPk3Entries;

  private constructor(
    readonly path: string,
    private readonly nativePath: Buffer<ArrayBuffer>,
    private readonly file: Bun.BunFile,
    entries: readonly Pk3Entry[],
    sourceNames: readonly Pk3SourceName[],
    private readonly index: ReadonlyMap<string, IndexedEntry>,
    private readonly end: EndOfCentralDirectory,
    readonly checksum: number,
    private readonly checksumBytes: Uint8Array,
    mountedDescriptor: number,
    last: IndexedEntry | null,
  ) {
    this.entries = entries;
    this.sourceNames = sourceNames;
    this.sharedEntries = new SharedPk3Entries(path, mountedDescriptor, end, last);
  }

  private get centralOffset(): number { return this.end.centralOffset; }

  get globalInformation(): { readonly entryCount: number; readonly commentLength: number } {
    this.sharedEntries.requireOpen();
    return { entryCount: this.end.entryCount, commentLength: this.end.commentLength };
  }

  readGlobalComment(destination: Uint8Array): number { return this.sharedEntries.globalComment(destination); }
  get currentFilePosition(): number { return this.sharedEntries.position; }
  setCurrentFilePosition(position: number): void { this.sharedEntries.setPosition(position); }
  firstFile(): void { this.sharedEntries.firstFile(); }
  nextFile(): boolean { return this.sharedEntries.nextFile(); }
  locateFile(filename: string, sensitivity = 0): boolean { return this.sharedEntries.locateFile(filename, sensitivity); }
  getCurrentFileInformation(buffers: Pk3InformationBuffers = {}): Pk3FileInformation {
    return this.sharedEntries.currentInformation(buffers);
  }
  openCurrentRead(): Pk3FileReader { return this.sharedEntries.openCurrent(); }

  static async open(path: string, nativePath: Buffer = Buffer.from(path)): Promise<Pk3Archive> {
    const ownedNativePath = Buffer.from(nativePath);
    const file = Bun.file(ownedNativePath);
    if (!await file.exists()) throw new Pk3OpenError(path, 0, "archive does not exist");
    const descriptor = openSync(ownedNativePath, "r");
    try {
      return await Pk3Archive.readDirectory(path, ownedNativePath, descriptor);
    } catch (error) {
      try { closeSync(descriptor); } finally { throw error; }
    }
  }

  private static async readDirectory(path: string, nativePath: Buffer<ArrayBuffer>, descriptor: number): Promise<Pk3Archive> {
    const file = Bun.file(descriptor);
    if (file.size < EOCD_LENGTH) throw new Pk3OpenError(path, 0, "archive is shorter than a ZIP end record");

    const tailSize = Math.min(file.size, EOCD_LENGTH + MAX_COMMENT_LENGTH);
    const tailOffset = file.size - tailSize;
    const tail = await readSlice(file, path, tailOffset, tailSize);
    const end = findEndRecord(path, file.size, tail, tailOffset);
    const publicEntries: Pk3Entry[] = [];
    const sourceNames: Pk3SourceName[] = [];
    const index = new Map<string, IndexedEntry>();
    const checksumCrcs: number[] = [];
    let last: IndexedEntry | null = null;
    let cursor = 0;

    for (let entryNumber = 0; entryNumber < end.entryCount; entryNumber++) {
      const absoluteOffset = end.centralOffset + cursor;
      checkedRange(path, end.centralSize, cursor, CENTRAL_LENGTH);
      const header = readSliceSync(descriptor, path, file.size, absoluteOffset, CENTRAL_LENGTH);
      if (u32(path, header, 0) !== CENTRAL_SIGNATURE) throw new Pk3Error(path, absoluteOffset, "invalid central directory signature");
      const flags = u16(path, header, 8);
      const method = u16(path, header, 10);
      const expectedCrc = u32(path, header, 16);
      const compressedSize = u32(path, header, 20);
      const uncompressedSize = u32(path, header, 24);
      const nameLength = u16(path, header, 28);
      const extraLength = u16(path, header, 30);
      const commentLength = u16(path, header, 32);
      const diskStart = u16(path, header, 34);
      const localHeaderOffset = u32(path, header, 42) + end.zipOffset;
      const recordLength = CENTRAL_LENGTH + nameLength + extraLength + commentLength;
      checkedRange(path, end.centralSize, cursor, recordLength);
      if ((flags & 1) !== 0) throw new Pk3Error(path, absoluteOffset, "encrypted entries are not supported");
      if (method !== 0 && method !== 8) throw new Pk3Error(path, absoluteOffset, `unsupported compression method ${method}`);
      if (diskStart !== 0) throw new Pk3Error(path, absoluteOffset, "entry starts on another disk");
      if (method === 0 && compressedSize !== uncompressedSize) {
        throw new Pk3Error(path, absoluteOffset, "stored entry has different compressed and uncompressed sizes");
      }
      if (uncompressedSize > 0) checksumCrcs.push(expectedCrc);
      checkedRange(path, end.centralOffset, localHeaderOffset, LOCAL_LENGTH);
      const rawName = readSliceSync(descriptor, path, file.size, absoluteOffset + CENTRAL_LENGTH, nameLength);
      const normalized = checkedEntryPath(path, absoluteOffset + CENTRAL_LENGTH, rawName);
      sourceNames.push(sourceName(rawName));
      const compressionMethod = method === 0 ? 0 : 8;
      const publicEntry = Object.freeze({
        path: normalized ?? decodeName(path, absoluteOffset + CENTRAL_LENGTH, rawName),
        compressedSize,
        uncompressedSize,
        compressionMethod,
        crc32: expectedCrc,
      } satisfies Pk3Entry);
      const indexed = Object.freeze({ publicEntry, flags, centralHeaderOffset: absoluteOffset, localHeaderOffset,
        zipOffset: end.zipOffset, rawName, information: fileInformation(path, header) } satisfies IndexedEntry);
      last = indexed;
      if (normalized !== undefined) {
        publicEntries.push(publicEntry);
        index.set(normalized, indexed);
      }
      cursor += recordLength;
    }
    if (cursor !== end.centralSize) throw new Pk3Error(path, end.centralOffset + cursor, "central directory size does not match its entries");
    const checksumBytes = new Uint8Array(checksumCrcs.length * 4);
    const checksumView = new DataView(checksumBytes.buffer);
    for (let index = 0; index < checksumCrcs.length; index++) {
      const crc = checksumCrcs[index];
      if (crc === undefined) throw new Error("PK3 checksum CRC index is invalid");
      checksumView.setUint32(index * 4, crc, true);
    }
    return new Pk3Archive(
      path,
      nativePath,
      Bun.file(nativePath),
      Object.freeze(publicEntries),
      Object.freeze(sourceNames),
      index,
      end,
      blockChecksum(checksumBytes),
      checksumBytes,
      descriptor,
      last,
    );
  }

  pureChecksum(checksumFeed: number): number {
    return blockChecksumKey(this.checksumBytes, checksumFeed);
  }

  has(path: string): boolean {
    return this.index.has(normalizeAssetPath(path));
  }

  list(prefix = ""): readonly string[] {
    const normalizedPrefix = normalizeAssetPrefix(prefix);
    return Object.freeze([...this.index.keys()].filter((path) => path.startsWith(normalizedPrefix)).sort());
  }

  private findEntry(path: string): IndexedEntry {
    const normalized = normalizeAssetPath(path);
    const entry = this.index.get(normalized);
    if (entry === undefined) throw new Pk3Error(this.path, 0, `entry not found: ${JSON.stringify(path)}`);
    return entry;
  }

  openRead(path: string): Pk3FileReader {
    const entry = this.findEntry(path);
    this.sharedEntries.requireOpen();
    const opened = openEntrySync(this.path, this.nativePath, this.centralOffset,
      () => this.sharedEntries.selectFileInformation(this.centralOffset, entry));
    return new RetainedPk3Reader(this.path, opened, "independent");
  }

  openSharedRead(path: string): Pk3FileReader {
    return this.sharedEntries.open(this.centralOffset, this.findEntry(path));
  }

  close(): void {
    this.sharedEntries.close();
  }

  [Symbol.dispose](): void { this.close(); }

  /** Diagnostic whole-entry allocation and CRC validation; runtime uses retained readers. */
  async read(path: string): Promise<Uint8Array> {
    this.sharedEntries.requireOpen();
    const entry = this.findEntry(path);

    const header = await readSlice(this.file, this.path, entry.localHeaderOffset, LOCAL_LENGTH);
    const layout = validateLocalHeader(this.path, entry, header);
    const variable = await readSlice(this.file, this.path,
      entry.localHeaderOffset + LOCAL_LENGTH, layout.variableLength);
    const dataOffset = entryDataOffset(this.path, this.centralOffset, entry, layout, variable);
    checkDiagnosticReadSize(this.path, dataOffset, entry.publicEntry);
    const compressed = await readSlice(this.file, this.path, dataOffset, entry.publicEntry.compressedSize);
    return decodeEntry(this.path, dataOffset, entry.publicEntry, compressed);
  }

  /** Diagnostic counterpart to read; not the source FS_ReadFile allocation path. */
  readSync(path: string): Uint8Array {
    this.sharedEntries.requireOpen();
    const entry = this.findEntry(path);
    const opened = openEntrySync(this.path, this.nativePath, this.centralOffset, () => entry);
    try {
      checkDiagnosticReadSize(this.path, opened.dataOffset, opened.entry);
      return readOpenedEntry(this.path, opened);
    } finally {
      closeSync(opened.descriptor);
    }
  }
}
