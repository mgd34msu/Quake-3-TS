/*
 * Script storage from Quake III Arena botlib/l_script.c and l_script.h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { SOURCE_TOKEN_BYTES, SourceTokenMemory } from "./token-memory.ts";

export interface ScriptMemoryAllocation {
  /** Borrow for one operation; an already returned view cannot be revoked. */
  readonly bytes: Uint8Array;
}

/** Supplied by the actual bot memory owner in runtime compositions. */
export interface ScriptMemory {
  allocate(size: number, kind: "heap", clear: boolean): ScriptMemoryAllocation;
  free(allocation: ScriptMemoryAllocation): void;
}

// Linux i386: four-byte pointers/longs, 12-byte long double aligned to four.
// token_t begins at 1076 and occupies 1068 bytes; script_t.next is at 2144.
// Numeric arithmetic retains the lexer's existing typed profile.
export const SOURCE_SCRIPT_BYTES = 2148;
export const SOURCE_PUNCTUATION_TABLE_BYTES = 256 * 4;

const FILENAME_BYTES = 1024;
const BUFFER = 1024;
const SCRIPT_POINTER = 1028;
const END_POINTER = 1032;
const LAST_SCRIPT_POINTER = 1036;
const WHITESPACE_POINTER = 1040;
const END_WHITESPACE_POINTER = 1044;
const LENGTH = 1048;
const LINE = 1052;
const LAST_LINE = 1056;
const TOKEN_AVAILABLE = 1060;
const FLAGS = 1064;
const PUNCTUATIONS = 1068;
const PUNCTUATION_TABLE = 1072;
const TOKEN = 1076;
const NEXT_SCRIPT = 2144;

/** One LoadScriptFile/LoadScriptMemory allocation and its punctuation table.
 * Buffer pointer words are offsets in this block. Punctuation words resolve
 * owner-local IDs to the lexer's actual static punctuation records. */
export class SourceScriptStorage {
  private punctuationTable: ScriptMemoryAllocation | null = null;
  private disposed = false;
  readonly token: SourceTokenMemory;

  private constructor(
    readonly memory: ScriptMemory,
    private readonly allocation: ScriptMemoryAllocation,
  ) {
    this.token = new SourceTokenMemory(() => this.bytes.subarray(TOKEN, TOKEN + SOURCE_TOKEN_BYTES));
  }

  static allocate(length: number, path: string, memory: ScriptMemory): SourceScriptStorage {
    if (!Number.isInteger(length) || length < 0 || length > 0x7fffffff - SOURCE_SCRIPT_BYTES - 1) {
      throw new RangeError("script allocation must fit its nonnegative source signed size");
    }
    const allocation = memory.allocate(SOURCE_SCRIPT_BYTES + length + 1, "heap", true);
    const script = new SourceScriptStorage(memory, allocation);
    const bytes = allocation.bytes;
    bytes.fill(0, 0, SOURCE_SCRIPT_BYTES);
    for (let index = 0; ; index++) {
      const character = index < path.length ? path.charCodeAt(index) : 0;
      if (index >= FILENAME_BYTES) {
        throw new RangeError("LoadScript filename exceeds its 1024-byte source allocation");
      }
      if (character > 255) throw new RangeError("LoadScript filename requires source byte characters");
      bytes[index] = character;
      if (character === 0) break;
    }
    const view = script.view;
    view.setUint32(BUFFER, SOURCE_SCRIPT_BYTES, true);
    bytes[SOURCE_SCRIPT_BYTES + length] = 0;
    view.setInt32(LENGTH, length, true);
    view.setUint32(SCRIPT_POINTER, SOURCE_SCRIPT_BYTES, true);
    view.setUint32(LAST_SCRIPT_POINTER, SOURCE_SCRIPT_BYTES, true);
    view.setUint32(END_POINTER, SOURCE_SCRIPT_BYTES + length, true);
    view.setInt32(TOKEN_AVAILABLE, 0, true);
    view.setInt32(LINE, 1, true);
    view.setInt32(LAST_LINE, 1, true);
    return script;
  }

  /** SetScriptPunctuations allocates, clears and populates before publishing its set. */
  setDefaultPunctuations(heads: readonly number[]): void {
    if (heads.length !== 256) throw new RangeError("script punctuation table requires 256 heads");
    const view = this.view;
    if (view.getUint32(PUNCTUATION_TABLE, true) === 0) {
      this.punctuationTable = this.memory.allocate(SOURCE_PUNCTUATION_TABLE_BYTES, "heap", false);
      view.setUint32(PUNCTUATION_TABLE, 1, true);
    }
    if (view.getUint32(PUNCTUATION_TABLE, true) !== 1 || this.punctuationTable === null) {
      throw new RangeError("script punctuation pointer does not identify its table allocation");
    }
    const table = this.punctuationTable.bytes;
    table.fill(0);
    const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
    for (let index = 0; index < heads.length; index++) {
      const head = heads[index];
      if (head === undefined) throw new Error("script punctuation head is missing");
      tableView.setUint32(index * 4, head, true);
    }
    view.setUint32(PUNCTUATIONS, 1, true);
  }

  get path(): string {
    const bytes = this.bytes;
    let result = "";
    for (let index = 0; index < FILENAME_BYTES; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("script filename is outside its allocation");
      if (byte === 0) return result;
      result += String.fromCharCode(byte);
    }
    throw new RangeError("script filename lacks its source terminator");
  }

  /** Compatibility observation; scanners retain this storage, never this copy. */
  get text(): string {
    const bytes = this.buffer;
    let text = "";
    for (const byte of bytes) {
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  /** FS_Read borrows the original length, excluding the initialized NUL byte. */
  get buffer(): Uint8Array {
    const bytes = this.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = view.getUint32(BUFFER, true);
    const end = view.getUint32(END_POINTER, true);
    if (start !== SOURCE_SCRIPT_BYTES || end < start || end >= bytes.length) {
      throw new RangeError("script buffer pointers are outside their allocation");
    }
    return bytes.subarray(start, end);
  }

  get length(): number { return this.view.getInt32(LENGTH, true); }
  get nextScript(): number { return this.view.getUint32(NEXT_SCRIPT, true); }
  set nextScript(value: number) { this.view.setUint32(NEXT_SCRIPT, value, true); }
  get offset(): number { return this.view.getUint32(SCRIPT_POINTER, true) - SOURCE_SCRIPT_BYTES; }
  set offset(value: number) { this.view.setUint32(SCRIPT_POINTER, SOURCE_SCRIPT_BYTES + value, true); }
  get lastOffset(): number { return this.view.getUint32(LAST_SCRIPT_POINTER, true) - SOURCE_SCRIPT_BYTES; }
  get linesCrossed(): number { return this.line - this.view.getInt32(LAST_LINE, true); }
  nextWhitespaceChar(): number {
    const view = this.view, pointer = view.getUint32(WHITESPACE_POINTER, true);
    if (pointer === view.getUint32(END_WHITESPACE_POINTER, true)) return 0;
    const byte = this.bytes[pointer];
    if (byte === undefined || pointer < SOURCE_SCRIPT_BYTES) throw new RangeError("script whitespace pointer exceeds its source allocation");
    view.setUint32(WHITESPACE_POINTER, pointer + 1, true);
    return byte < 128 ? byte : byte - 256;
  }
  get line(): number { return this.view.getInt32(LINE, true); }
  set line(value: number) { this.view.setInt32(LINE, value, true); }
  get flags(): number { return this.view.getInt32(FLAGS, true); }
  set flags(value: number) { this.view.setInt32(FLAGS, value, true); }
  get tokenAvailable(): boolean { return this.view.getInt32(TOKEN_AVAILABLE, true) !== 0; }
  set tokenAvailable(value: boolean) { this.view.setInt32(TOKEN_AVAILABLE, value ? 1 : 0, true); }

  beginToken(): void {
    const view = this.view;
    const pointer = view.getUint32(SCRIPT_POINTER, true);
    view.setUint32(LAST_SCRIPT_POINTER, pointer, true);
    view.setInt32(LAST_LINE, view.getInt32(LINE, true), true);
    view.setUint32(WHITESPACE_POINTER, pointer, true);
  }

  endWhitespace(): void {
    const view = this.view;
    view.setUint32(END_WHITESPACE_POINTER, view.getUint32(SCRIPT_POINTER, true), true);
  }

  punctuationHead(character: number): number {
    const view = this.view;
    if (view.getUint32(PUNCTUATIONS, true) !== 1 || view.getUint32(PUNCTUATION_TABLE, true) !== 1
      || this.punctuationTable === null) {
      throw new RangeError("script punctuation pointer does not identify its default table");
    }
    if (!Number.isInteger(character) || character < 0 || character > 255) {
      throw new RangeError("script punctuation lookup requires a source byte");
    }
    const bytes = this.punctuationTable.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(character * 4, true);
  }

  /** LoadScriptMemory copies after both allocations and punctuation publication. */
  copyText(text: string): void {
    const buffer = this.buffer;
    if (text.length !== buffer.length) throw new RangeError("script text does not match its allocated length");
    for (let index = 0; index < text.length; index++) {
      const byte = text.charCodeAt(index);
      if (byte > 255) throw new RangeError(`LoadScriptMemory input is not a source byte at ${index}`);
      buffer[index] = byte;
    }
  }

  /** COM_Compress writes back into the loaded buffer without moving end_p. */
  compress(): void {
    const bytes = this.bytes;
    const start = this.view.getUint32(BUFFER, true);
    let input = start;
    let output = start;
    let newline = false;
    let whitespace = false;
    const read = (offset: number): number => {
      const byte = bytes[offset];
      if (byte === undefined) throw new RangeError("COM_Compress read outside its script allocation");
      return byte;
    };
    let byte: number;
    while ((byte = read(input)) !== 0) {
      if (byte === 47 && read(input + 1) === 47) {
        while ((byte = read(input)) !== 0 && byte !== 10) input++;
      } else if (byte === 47 && read(input + 1) === 42) {
        while (read(input) !== 0 && (read(input) !== 42 || read(input + 1) !== 47)) input++;
        if (read(input) !== 0) input += 2;
      } else if (byte === 10 || byte === 13) {
        newline = true;
        input++;
      } else if (byte === 32 || byte === 9) {
        whitespace = true;
        input++;
      } else {
        if (newline) { bytes[output++] = 10; newline = false; whitespace = false; }
        if (whitespace) { bytes[output++] = 32; whitespace = false; }
        bytes[output++] = read(input++);
        if (byte === 34) {
          while ((byte = read(input)) !== 0 && byte !== 34) bytes[output++] = read(input++);
          if (byte === 34) bytes[output++] = read(input++);
        }
      }
    }
    bytes[output] = 0;
    this.view.setInt32(LENGTH, output - start, true);
  }

  reset(): void {
    const view = this.view;
    const pointer = view.getUint32(BUFFER, true);
    view.setUint32(SCRIPT_POINTER, pointer, true);
    view.setUint32(LAST_SCRIPT_POINTER, pointer, true);
    view.setUint32(WHITESPACE_POINTER, 0, true);
    view.setUint32(END_WHITESPACE_POINTER, 0, true);
    view.setInt32(TOKEN_AVAILABLE, 0, true);
    view.setInt32(LINE, 1, true);
    view.setInt32(LAST_LINE, 1, true);
    this.token.clear();
  }

  /** FreeScript frees the punctuation table before its containing script block. */
  dispose(): void {
    if (this.disposed) return;
    const pointer = this.view.getUint32(PUNCTUATION_TABLE, true);
    if (pointer !== 0) {
      if (pointer !== 1 || this.punctuationTable === null) {
        throw new RangeError("script punctuation pointer does not identify its table allocation");
      }
      this.memory.free(this.punctuationTable);
    }
    this.memory.free(this.allocation);
    this.disposed = true;
  }

  private get bytes(): Uint8Array {
    if (this.disposed) throw new Error("script storage has been freed");
    return this.allocation.bytes;
  }

  private get view(): DataView {
    const bytes = this.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}
