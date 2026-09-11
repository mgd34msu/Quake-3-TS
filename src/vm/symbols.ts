/*
 * Symbol lookup/loading, ParseHex and VM_VmProfile_f from id Software's qcommon/vm.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";

export interface QvmSymbolLoadOptions {
  readonly name: string;
  readonly developer: number;
  readonly files: Pick<RetainedFileReader, "readFileRetainedSync" | "freeFile">;
  readonly print: (text: string) => void;
}

export interface QvmSymbol {
  readonly value: number;
  readonly name: string;
  readonly profileCount: number;
}

export interface QvmFunctionSymbol extends QvmSymbol {
  profileCount: number;
}

interface SymbolRecord extends QvmFunctionSymbol {
  readonly data: DataView;
}

const nullSymbol: QvmFunctionSymbol = { value: 0, name: "", profileCount: 0 };

function parseHex(text: string): number {
  let value = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) value = (value * 16 + code - 48) | 0;
    else if (code >= 97 && code <= 102) value = (value * 16 + code - 87) | 0;
    else if (code >= 65 && code <= 70) value = (value * 16 + code - 55) | 0;
  }
  return value;
}

function byteText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** Symbol records use the existing release32 hunk profile; links remain owned TypeScript references. */
export class QvmSymbols {
  private records: SymbolRecord[] = [];
  private parsedCount = 0;
  private print: (text: string) => void = () => undefined;

  constructor(
    private readonly instructionPointers: Int32Array,
    private readonly allocate: (bytes: number, resource: string) => Uint8Array,
    private readonly assertLive: () => void,
  ) {}

  get count(): number { this.assertLive(); return this.parsedCount; }

  get entries(): readonly QvmSymbol[] {
    this.assertLive();
    return this.records.map(record => ({ value: record.data.getInt32(4, true), name: record.name,
      profileCount: record.data.getInt32(8, true) }));
  }

  valueToFunctionSymbol(value: number): QvmFunctionSymbol {
    this.assertLive();
    let symbol = this.records[0];
    if (symbol === undefined) return nullSymbol;
    for (let index = 1; index < this.records.length; index++) {
      const next = this.records[index];
      if (next === undefined) break;
      if (next.value > value) break;
      symbol = next;
    }
    return symbol;
  }

  valueToSymbol(value: number): string {
    this.assertLive();
    if (this.records.length === 0) return "NO SYMBOLS";
    const symbol = this.valueToFunctionSymbol(value);
    if (value === symbol.value) return symbol.name;
    const text = `${symbol.name}+${(value - symbol.value) | 0}`;
    if (text.length >= 1024) this.print(`Com_sprintf: overflow of ${text.length} in 1024\n`);
    return text.slice(0, 1023);
  }

  symbolToValue(name: string): number {
    this.assertLive();
    const nul = name.indexOf("\0"), symbolName = nul < 0 ? name : name.slice(0, nul);
    return this.records.find(symbol => symbol.name === symbolName)?.value ?? 0;
  }

  load(options: QvmSymbolLoadOptions): void {
    if (options.developer === 0) return;
    this.assertLive();
    this.print = options.print;
    const nul = options.name.indexOf("\0");
    const name = nul < 0 ? options.name : options.name.slice(0, nul);
    const dot = name.indexOf(".");
    const requested = `vm/${dot < 0 ? name : name.slice(0, dot)}.map`;
    if (requested.length >= 64) options.print(`Com_sprintf: overflow of ${requested.length} in 64\n`);
    const path = requested.slice(0, 63);
    const file = options.files.readFileRetainedSync(path);
    if (file === undefined) {
      options.print(`Couldn't load symbol file: ${path}\n`);
      return;
    }
    const cursor = new CommonParseCursor(byteText(file.terminatedBytes)), parser = new CommonParseState();
    let count = 0;
    for (;;) {
      const segment = parser.parse(cursor);
      if (segment.length === 0) break;
      if (parseHex(segment) !== 0) { parser.parse(cursor); parser.parse(cursor); continue; }
      const address = parser.parse(cursor);
      if (address.length === 0) { options.print("WARNING: incomplete line at end of file\n"); break; }
      let value = parseHex(address);
      const symbolName = parser.parse(cursor);
      if (symbolName.length === 0) { options.print("WARNING: incomplete line at end of file\n"); break; }
      // vmSymbol_t is 16 bytes in the selected release32 profile, including symName[1] and tail padding.
      const bytes = this.allocate(16 + symbolName.length, path);
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const assertLive = this.assertLive;
      const record: SymbolRecord = { name: symbolName, data,
        get value(): number { assertLive(); return data.getInt32(4, true); },
        get profileCount(): number { assertLive(); return data.getInt32(8, true); },
        set profileCount(count: number) { assertLive(); data.setInt32(8, count, true); },
      };
      if (count === 0) this.records = [];
      this.records.push(record);
      if (value >= 0 && value < this.instructionPointers.length) {
        const pc = this.instructionPointers[value];
        if (pc === undefined) throw new RangeError("VM symbol instruction is outside its prepared table");
        value = pc;
      }
      data.setInt32(4, value, true);
      for (let index = 0; index < symbolName.length; index++) bytes[12 + index] = symbolName.charCodeAt(index);
      count++;
    }
    this.parsedCount = count;
    options.print(`${count} symbols parsed from ${path}\n`);
    options.files.freeFile(file);
  }

  printProfile(print: (text: string) => void, debugEnabled = false): void {
    this.assertLive();
    if (this.parsedCount === 0) return;
    const sorted = this.records.slice(0, this.parsedCount);
    let total = 0;
    for (const record of sorted) total += record.data.getInt32(8, true);
    sorted.sort((left, right) => left.data.getInt32(8, true) - right.data.getInt32(8, true));
    if (total === 0) {
      // C's NaN-to-int conversion has no defined percentage, including after resetting a debug profile.
      print(debugEnabled
        ? "vmprofile: percentages are undefined with zero total instructions.\n"
        : "vmprofile: percentages are undefined with zero total instructions; DEBUG_VM is disabled.\n");
    }
    for (const record of sorted) {
      this.assertLive();
      const count = record.data.getInt32(8, true);
      const prefix = total === 0 ? "    " : `${Math.trunc(Math.fround(100 * Math.fround(count)) / total).toString().padStart(2)}% `;
      print(`${prefix}${count.toString().padStart(9)} ${record.name}\n`);
      this.assertLive();
      record.data.setInt32(8, 0, true);
    }
    print(`    ${total.toFixed(0).padStart(9)} total\n`);
  }
}
