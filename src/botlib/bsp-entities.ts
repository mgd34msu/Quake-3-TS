/*
 * BSP entity observations from Quake III Arena botlib/be_aas_bspq3.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { Vec3 } from "../core/math.ts";
import { nativeAtof, nativeAtoi } from "../core/native-numeric.ts";
import { LexerFlag, ScriptLanguageError, ScriptLexer, type ScriptToken } from "../script/lexer.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";

export type AasBspNumberResult =
  | { readonly found: false; readonly value: 0 }
  | { readonly found: true; readonly value: number };

export type AasBspVectorResult =
  | { readonly found: false; readonly value: { readonly x: 0; readonly y: 0; readonly z: 0 } }
  | { readonly found: true; readonly value: Vec3 };

export type AasBspPrint = (severity: 1 | 2 | 3, text: string) => undefined;
/** strcmp consumes a borrowed key only when an actual epair is compared. */
export type AasBspKey = string | ((candidate: string) => boolean);

interface Entity {
  pairs: number;
}

const MAX_ENTITIES = 2048;
const MAX_EPAIRKEY = 128;

function int32(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new RangeError("BSP entity numbers must be signed 32-bit integers");
  }
}

function byteString(text: string): string {
  const terminator = text.indexOf("\0");
  const result = terminator < 0 ? text : text.slice(0, terminator);
  for (let index = 0; index < result.length; index++) {
    if (result.charCodeAt(index) > 255) throw new RangeError("BSP entity strings require byte characters");
  }
  return result;
}

function decimalInteger(text: string): number {
  const prefix = /^[\t\n\v\f\r ]*([+-]?)([0-9]+)/.exec(text);
  if (prefix !== null) {
    const sign = prefix[1];
    const digits = prefix[2];
    if (sign === undefined || digits === undefined) throw new Error("Integer prefix capture is absent");
    const magnitude = BigInt(digits);
    if (magnitude > (sign === "-" ? 2147483648n : 2147483647n)) {
      throw new RangeError("AAS integer epair conversion exceeds the source-defined int32 range");
    }
  }
  return nativeAtoi(text);
}

function digit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function hexDigit(character: string | undefined): boolean {
  return digit(character) || (character !== undefined
    && ((character >= "a" && character <= "f") || (character >= "A" && character <= "F")));
}

interface ScannedFloat {
  readonly value: number;
  readonly end: number;
}

// C-locale glibc 2.44 %lf consumption, followed by native atof conversion.
// Unlike atof, an incomplete exponent/infinity/payload fails this conversion.
function scanFloat(text: string, start: number): ScannedFloat | null {
  let cursor = start;
  while (cursor < text.length && /[\t\n\v\f\r ]/.test(text.charAt(cursor))) cursor++;
  const beginning = cursor;
  if (text[cursor] === "+" || text[cursor] === "-") cursor++;
  const word = text.slice(cursor).toLowerCase();
  if (word.startsWith("inf")) {
    if (word.charAt(3) === "i") {
      if (!word.startsWith("infinity")) return null;
      cursor += 8;
    } else cursor += 3;
  } else if (word.startsWith("nan")) {
    cursor += 3;
    if (text[cursor] === "(") {
      cursor++;
      while (cursor < text.length && /[a-zA-Z0-9_]/.test(text.charAt(cursor))) cursor++;
      if (text[cursor] !== ")") return null;
      cursor++;
    }
  } else {
    const hexadecimal = word.startsWith("0x");
    if (hexadecimal) cursor += 2;
    const isDigit = hexadecimal ? hexDigit : digit;
    let digits = 0;
    while (isDigit(text[cursor])) { cursor++; digits++; }
    if (text[cursor] === ".") {
      cursor++;
      while (isDigit(text[cursor])) { cursor++; digits++; }
    }
    if (digits === 0) return null;
    const exponent = text.charAt(cursor).toLowerCase();
    if (exponent === (hexadecimal ? "p" : "e")) {
      cursor++;
      if (text[cursor] === "+" || text[cursor] === "-") cursor++;
      const exponentStart = cursor;
      while (digit(text[cursor])) cursor++;
      if (cursor === exponentStart) return null;
    }
  }
  return { value: nativeAtof(text.slice(beginning, cursor)), end: cursor };
}

/** One bot-library lifetime's copied BSP entity text and epair observations. */
export class AasBspEntities {
  private readonly entities: Entity[] = Array.from({ length: MAX_ENTITIES }, () => ({ pairs: 0 }));
  private entityCount = 0;
  // Release32 pointer cells hold owner-local IDs. The table resolves them to
  // actual allocations; strings and links are read from those allocations.
  private readonly allocations = new Map<number, BotMemoryAllocation>();
  private nextAllocation = 1;
  private entityText: BotMemoryAllocation | null = null;
  private isLoaded = false;

  constructor(private readonly print: AasBspPrint, private readonly memory = new BotMemory()) {}

  get loaded(): boolean { return this.isLoaded; }

  load(entityText: string): 0 {
    this.dump();
    const text = byteString(entityText);
    this.entityText = this.memory.allocate(text.length + 1, "hunk", true);
    this.writeString(this.entityText, text);
    const lexer = new ScriptLexer(`${this.readString(this.entityText)}\0`, "entdata", {
      flags: LexerFlag.NoStringConcatenation | LexerFlag.NoStringEscapes,
      memory: this.memory,
    });
    this.parse(lexer);
    lexer.dispose();
    this.isLoaded = true;
    return 0;
  }

  dump(): void {
    this.freeEntities();
    if (this.entityText !== null) this.memory.free(this.entityText);
    this.entityText = null;
    this.isLoaded = false;
    for (const entity of this.entities) entity.pairs = 0;
  }

  nextEntity(after: number): number {
    int32(after);
    if (after === 2147483647) throw new RangeError("AAS_NextBSPEntity would overflow signed int");
    const next = after + 1;
    return next < 1 || next >= this.entityCount ? 0 : next;
  }

  value(entity: number, key: AasBspKey, output: Uint8Array, size = output.length): boolean {
    int32(entity);
    if (output.length === 0) throw new RangeError("AAS_ValueForBSPEpairKey requires its first output byte");
    output[0] = 0;
    if (entity <= 0 || entity >= this.entityCount) {
      this.print(1, "bsp entity out of range\n");
      return false;
    }
    const record = this.entities[entity];
    if (record === undefined) throw new Error("BSP entity allocation is absent");
    for (let pair = record.pairs; pair !== 0; pair = this.pointer(pair, 8)) {
      const keyPointer = this.pointer(pair, 0);
      if (keyPointer === 0) throw new RangeError("BSP epair lookup would consume an uninitialized source key");
      const candidate = this.readString(this.allocation(keyPointer));
      if (!(typeof key === "string" ? candidate === byteString(key) : key(candidate))) continue;
      const valuePointer = this.pointer(pair, 4);
      if (valuePointer === 0) throw new RangeError("BSP epair lookup would consume an uninitialized source value");
      if (!Number.isInteger(size) || size < 1 || size > output.length) {
        throw new RangeError("AAS_ValueForBSPEpairKey matched output exceeds its allocation or has an invalid size");
      }
      output.fill(0, 0, size);
      const value = this.readString(this.allocation(valuePointer));
      for (let index = 0; index < Math.min(value.length, size - 1); index++) output[index] = value.charCodeAt(index);
      return true;
    }
    return false;
  }

  vector(entity: number, key: AasBspKey): AasBspVectorResult {
    const text = this.numericText(entity, key);
    if (text === null) return { found: false, value: { x: 0, y: 0, z: 0 } };
    const result = { x: 0, y: 0, z: 0 };
    const axes: readonly ("x" | "y" | "z")[] = ["x", "y", "z"];
    let cursor = 0;
    for (const axis of axes) {
      const scanned = scanFloat(text, cursor);
      if (scanned === null) break;
      result[axis] = Math.fround(scanned.value);
      cursor = scanned.end;
    }
    return { found: true, value: result };
  }

  float(entity: number, key: AasBspKey): AasBspNumberResult {
    const text = this.numericText(entity, key);
    return text === null ? { found: false, value: 0 } : { found: true, value: Math.fround(nativeAtof(text)) };
  }

  int(entity: number, key: AasBspKey): AasBspNumberResult {
    const text = this.numericText(entity, key);
    return text === null ? { found: false, value: 0 } : { found: true, value: decimalInteger(text) };
  }

  private numericText(entity: number, key: AasBspKey): string | null {
    const buffer = new Uint8Array(MAX_EPAIRKEY);
    if (!this.value(entity, key, buffer)) return null;
    let text = "";
    for (const byte of buffer) {
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  private allocate(size: number, clear: boolean): number {
    if (this.nextAllocation > 0xffffffff) throw new RangeError("BSP allocation IDs exceed release32 pointer cells");
    const allocation = this.memory.allocate(size, "hunk", clear);
    const pointer = this.nextAllocation++;
    this.allocations.set(pointer, allocation);
    return pointer;
  }

  private allocation(pointer: number): BotMemoryAllocation {
    const allocation = this.allocations.get(pointer);
    if (allocation === undefined) throw new RangeError("BSP epair pointer does not identify an owned allocation");
    return allocation;
  }

  private pointer(pair: number, offset: number): number {
    const bytes = this.allocation(pair).bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  }

  private setPointer(pair: number, offset: number, pointer: number): void {
    const bytes = this.allocation(pair).bytes;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, pointer, true);
  }

  private readString(allocation: BotMemoryAllocation): string {
    let text = "";
    for (const byte of allocation.bytes) {
      if (byte === 0) return text;
      text += String.fromCharCode(byte);
    }
    throw new RangeError("BSP string has no terminator within its allocation");
  }

  private writeString(allocation: BotMemoryAllocation, text: string): void {
    const bytes = allocation.bytes;
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    bytes[text.length] = 0;
  }

  private freeEntities(): void {
    for (let index = 1; index < this.entityCount; index++) {
      const entity = this.entities[index];
      if (entity === undefined) throw new Error("BSP entity allocation is absent");
      for (let pair = entity.pairs; pair !== 0;) {
        const next = this.pointer(pair, 8);
        const key = this.pointer(pair, 0);
        if (key !== 0) this.memory.free(this.allocation(key));
        const value = this.pointer(pair, 4);
        if (value !== 0) this.memory.free(this.allocation(value));
        this.memory.free(this.allocation(pair));
        pair = next;
      }
    }
    this.entityCount = 0;
  }

  private read(lexer: ScriptLexer): ScriptToken | undefined {
    try { return lexer.next(); }
    catch (error) {
      if (!(error instanceof ScriptLanguageError)) throw error;
      for (const issue of error.diagnostics) {
        this.print(issue.severity === "error" ? 3 : 2,
          `file ${issue.location.path}, line ${issue.location.line}: ${issue.message}\n`);
      }
      return undefined;
    }
  }

  private error(lexer: ScriptLexer, message: string): void {
    const location = lexer.currentLocation;
    this.print(3, `file ${location.path}, line ${location.line}: ${message}\n`);
  }

  private parse(lexer: ScriptLexer): void {
    this.entityCount = 1;
    while (true) {
      const opening = this.read(lexer);
      if (opening === undefined) return;
      if (opening.text !== "{") {
        this.error(lexer, `invalid ${opening.text}\n`);
        this.freeEntities();
        return;
      }
      if (this.entityCount >= MAX_ENTITIES) {
        this.print(1, "too many entities in BSP file\n");
        return;
      }
      const entity = this.entities[this.entityCount++];
      if (entity === undefined) throw new Error("BSP entity allocation is absent");
      entity.pairs = 0;
      while (true) {
        const key = this.read(lexer);
        if (key === undefined) {
          this.error(lexer, "missing }\n");
          this.freeEntities();
          return;
        }
        if (key.text === "}") break;
        const pair = this.allocate(12, true);
        this.setPointer(pair, 8, entity.pairs);
        entity.pairs = pair;
        if (key.kind !== "string") {
          this.error(lexer, `invalid ${key.text}\n`);
          this.freeEntities();
          return;
        }
        // Managed quote removal corrects source StripDoubleQuotes' overlapping strcpy.
        const keyPointer = this.allocate(key.value.length + 1, false);
        this.setPointer(pair, 0, keyPointer);
        this.writeString(this.allocation(keyPointer), key.value);
        const value = this.read(lexer);
        if (value === undefined || value.kind !== "string") {
          this.error(lexer, value === undefined ? "couldn't read expected token" : `expected a string, found ${value.text}`);
          this.freeEntities();
          return;
        }
        const valuePointer = this.allocate(value.value.length + 1, false);
        this.setPointer(pair, 4, valuePointer);
        this.writeString(this.allocation(valuePointer), value.value);
      }
    }
  }
}
