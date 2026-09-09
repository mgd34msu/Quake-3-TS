/*
 * Retained token_t storage from Quake III Arena botlib/l_script.h and l_script.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { ScriptToken, ScriptTokenRecord } from "./lexer.ts";

export const SOURCE_TOKEN_BYTES = 1068;
const STRING_BYTES = 1024;
const TYPE = 1024;
const SUBTYPE = 1028;
const INTEGER = 1032;
const FLOAT = 1036;
const WHITESPACE = 1048;
const END_WHITESPACE = 1052;
const LINE = 1056;
const LINES_CROSSED = 1060;
const NEXT = 1064;

export interface SourceTokenContext {
  readonly path: string;
  readonly column: number;
  readonly leadingWhitespace: string;
}

interface TokenSnapshot {
  readonly storage: SourceTokenMemory;
  readonly record: ScriptTokenRecord;
  readonly context: SourceTokenContext;
}

const snapshots = new WeakMap<ScriptToken, TokenSnapshot>();

function tokenType(token: ScriptToken): number {
  switch (token.kind) {
    case "primitive": return 0;
    case "string": return 1;
    case "literal": return 2;
    case "number": return 3;
    case "name": return 4;
    case "punctuation": return 5;
  }
}

function tokenSubtype(token: ScriptToken): number {
  switch (token.kind) {
    case "primitive": return 0;
    case "string": case "literal": case "name": return token.length;
    case "number": return token.flags;
    case "punctuation": return token.punctuation;
  }
}

/** The supported numeric profile is binary64. Its value is represented exactly
 * in the Linux i386 ten-byte x87 value; the two ABI padding bytes are untouched. */
function writeFloat(view: DataView, value: number, offset = FLOAT): void {
  const binary = new DataView(new ArrayBuffer(8));
  binary.setFloat64(0, value, true);
  const bits = binary.getBigUint64(0, true);
  const sign = Number(bits >> 63n) << 15;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  let significand: bigint;
  let extendedExponent: number;
  if (exponent === 0 && fraction === 0n) {
    significand = 0n;
    extendedExponent = 0;
  } else if (exponent === 0) {
    const highestBit = fraction.toString(2).length - 1;
    significand = fraction << BigInt(63 - highestBit);
    extendedExponent = highestBit - 1074 + 16383;
  } else {
    significand = (fraction | 0x10000000000000n) << 11n;
    extendedExponent = exponent === 0x7ff ? 0x7fff : exponent - 1023 + 16383;
  }
  view.setBigUint64(offset, significand, true);
  view.setUint16(offset + 8, sign | extendedExponent, true);
}

function readFloat(view: DataView): number {
  const significand = view.getBigUint64(FLOAT, true);
  const word = view.getUint16(FLOAT + 8, true);
  const exponent = word & 0x7fff;
  const negative = (word & 0x8000) !== 0;
  if (exponent === 0 && significand === 0n) return negative ? -0 : 0;
  if (exponent === 0x7fff && significand === 0x8000000000000000n) return negative ? -Infinity : Infinity;
  if (exponent === 0x7fff && significand > 0x8000000000000000n) return NaN;
  const power = exponent - 16383;
  const fraction = Number(significand) / 0x8000000000000000;
  const magnitude = power < -1022
    ? fraction * 2 ** (power + 1022) * 2 ** -1022
    : fraction * 2 ** power;
  const value = negative ? -magnitude : magnitude;
  const check = new DataView(new ArrayBuffer(10));
  writeFloat(check, value, 0);
  if (check.getBigUint64(0, true) !== significand || check.getUint16(8, true) !== word) {
    throw new RangeError("token_t long double exceeds the supported binary64 numeric profile");
  }
  return value;
}

/** A view of supplied token_t bytes, with no allocation ownership. Pointer words
 * are interpreted by the owning source. Typed text extent preserves escaped NUL
 * payloads without duplicating bytes. */
export class SourceTokenMemory {
  private textExtent: number | null = null;
  private snapshot: TokenSnapshot | null = null;
  private cachedView: DataView | null = null;

  constructor(private readonly borrow: () => Uint8Array) {}

  get bytes(): Uint8Array {
    const bytes = this.borrow();
    if (bytes.length !== SOURCE_TOKEN_BYTES) throw new RangeError("token_t requires exactly 1068 source bytes");
    return bytes;
  }

  private get view(): DataView {
    const bytes = this.bytes;
    let view = this.cachedView;
    if (view === null || view.buffer !== bytes.buffer || view.byteOffset !== bytes.byteOffset || view.byteLength !== bytes.byteLength) {
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.cachedView = view;
    }
    return view;
  }

  clear(): void {
    this.bytes.fill(0);
    this.textExtent = null;
    this.snapshot = null;
  }

  copyFrom(other: SourceTokenMemory): void {
    this.bytes.set(other.bytes);
    this.textExtent = other.textExtent;
    this.snapshot = other.snapshot;
  }

  get type(): number { return this.view.getInt32(TYPE, true); }
  set type(value: number) { this.view.setInt32(TYPE, value, true); }
  get subtype(): number { return this.view.getInt32(SUBTYPE, true); }
  set subtype(value: number) { this.view.setInt32(SUBTYPE, value, true); }
  get integerValue(): number { return this.view.getUint32(INTEGER, true); }
  set integerValue(value: number) { this.view.setUint32(INTEGER, value, true); }
  get floatValue(): number { return readFloat(this.view); }
  set floatValue(value: number) { writeFloat(this.view, value); }
  get whitespaceStart(): number { return this.view.getUint32(WHITESPACE, true); }
  set whitespaceStart(value: number) { this.view.setUint32(WHITESPACE, value, true); }
  get whitespaceEnd(): number { return this.view.getUint32(END_WHITESPACE, true); }
  set whitespaceEnd(value: number) { this.view.setUint32(END_WHITESPACE, value, true); }
  get line(): number { return this.view.getInt32(LINE, true); }
  set line(value: number) { this.view.setInt32(LINE, value, true); }
  get linesCrossed(): number { return this.view.getInt32(LINES_CROSSED, true); }
  set linesCrossed(value: number) { this.view.setInt32(LINES_CROSSED, value, true); }
  get whitespaceBefore(): boolean { return this.whitespaceEnd - this.whitespaceStart > 0; }
  clearWhitespace(): void { this.whitespaceStart = 0; this.whitespaceEnd = 0; this.linesCrossed = 0; }
  get next(): number { return this.view.getUint32(NEXT, true); }
  set next(value: number) { this.view.setUint32(NEXT, value, true); }

  get string(): string {
    const bytes = this.bytes;
    let text = "";
    for (let index = 0; index < STRING_BYTES; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("token_t string is outside its allocation");
      if (byte === 0) return text;
      text += String.fromCharCode(byte);
    }
    throw new RangeError("token_t string lacks a terminator within its 1024-byte field");
  }

  writeString(text: string): void {
    if (text.length >= STRING_BYTES) throw new RangeError("token_t string exceeds its 1024-byte field");
    for (let index = 0; index < text.length; index++) this.setStringByte(index, text.charCodeAt(index));
    this.setStringByte(text.length, 0);
    this.textExtent = text.includes("\0") ? text.length : null;
  }

  setStringByte(index: number, value: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= STRING_BYTES) throw new RangeError("token_t string byte is outside its field");
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("token_t string requires source bytes");
    this.bytes[index] = value;
  }

  /** Whole-record copies retain padding, pointer words and bytes after NUL. */
  writeRecord(record: ScriptTokenRecord): void {
    const captured = snapshots.get(record.token);
    if (captured === undefined) this.clear();
    else this.copyFrom(captured.storage);
    this.writeString(record.token.text);
    this.type = tokenType(record.token);
    this.subtype = record.subtype;
    this.integerValue = record.integerValue;
    this.floatValue = record.floatValue;
    this.line = record.token.location.line;
    this.linesCrossed = record.token.linesCrossed;
  }

  writeToken(token: ScriptToken): void {
    const captured = snapshots.get(token);
    if (captured !== undefined) {
      this.writeRecord(captured.record);
      return;
    }
    this.writeRecord({ token, subtype: tokenSubtype(token),
      integerValue: token.kind === "number" ? token.integerValue : 0,
      floatValue: token.kind === "number" ? token.floatValue : 0 });
  }

  readRecord(context: SourceTokenContext, textExtent?: number): ScriptTokenRecord {
    if (textExtent !== undefined) {
      if (!Number.isInteger(textExtent) || textExtent < 0 || textExtent >= STRING_BYTES) {
        throw new RangeError("typed token text extent exceeds its source string field");
      }
      this.textExtent = this.string.length < textExtent ? textExtent : null;
    }
    const previous = this.snapshot;
    if (previous !== null && previous.context.path === context.path && previous.context.column === context.column
      && previous.context.leadingWhitespace === context.leadingWhitespace && this.sameValue(previous.storage)) {
      return previous.record;
    }
    let text = this.string;
    if (this.textExtent !== null && this.textExtent > text.length) {
      if (!Number.isInteger(this.textExtent) || this.textExtent < 0 || this.textExtent >= STRING_BYTES) {
        throw new RangeError("typed token text extent exceeds its source string field");
      }
      text = "";
      const bytes = this.bytes;
      for (let index = 0; index < this.textExtent; index++) {
        const byte = bytes[index];
        if (byte === undefined) throw new RangeError("typed token text exceeds its source allocation");
        text += String.fromCharCode(byte);
      }
    }
    const base = { text, location: Object.freeze({ path: context.path, line: this.line, column: context.column }),
      leadingWhitespace: context.leadingWhitespace, linesCrossed: this.linesCrossed };
    const subtype = this.subtype, integerValue = this.integerValue, floatValue = this.floatValue;
    let token: ScriptToken;
    switch (this.type) {
      case 0: token = Object.freeze({ ...base, kind: "primitive", value: text }); break;
      case 1: token = Object.freeze({ ...base, kind: "string", value: text.slice(1, -1), length: text.length }); break;
      case 2: token = Object.freeze({ ...base, kind: "literal", value: text.slice(1, -1), length: text.length }); break;
      case 3: token = Object.freeze({ ...base, kind: "number", flags: subtype, integerValue, floatValue }); break;
      case 4: token = Object.freeze({ ...base, kind: "name", value: text, length: text.length }); break;
      case 5:
        token = Object.freeze({ ...base, kind: "punctuation", value: text, punctuation: subtype }); break;
      default: throw new RangeError("token_t has no completed typed token");
    }
    const record = Object.freeze({ token, subtype, integerValue, floatValue });
    const bytes = Uint8Array.from(this.bytes);
    const storage = new SourceTokenMemory(() => bytes);
    storage.copyFrom(this);
    const snapshot: TokenSnapshot = { storage, record, context };
    storage.snapshot = snapshot;
    snapshots.set(token, snapshot);
    this.snapshot = snapshot;
    return record;
  }

  private sameValue(other: SourceTokenMemory): boolean {
    if (this.textExtent !== other.textExtent) return false;
    const left = this.bytes, right = other.bytes;
    for (let index = 0; index < SOURCE_TOKEN_BYTES; index++) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
}
