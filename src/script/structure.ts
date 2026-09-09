/*
 * Structure field reader translated from id Software's
 * code/botlib/l_struct.c and l_struct.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
  NumberFlag,
  Punctuation,
  ScriptLanguageError,
  type ScriptDiagnostic,
  type ScriptToken,
  type SourceLocation,
} from "./lexer.ts";
import { float32ToBits } from "../core/numeric.ts";

const SOURCE_INT_MIN = -32_768;
const SOURCE_INT_MAX = 32_767;
const DEFAULT_STRING_BYTES = 79;

export const MAX_STRINGFIELD = 80;
export enum StructureFieldType {
  Char = 1, Int = 2, Float = 3, String = 4, Struct = 6,
  Type = 0xff, Array = 0x100, Bounded = 0x200, Unsigned = 0x400,
}

export interface StructureFieldDefinition {
  readonly name: string;
  readonly offset: number;
  readonly type: number;
  readonly maxarray: number;
  readonly floatmin: number;
  readonly floatmax: number;
  readonly substruct: StructureDefinition | null;
}

export interface StructureDefinition {
  readonly size: number;
  readonly fields: readonly StructureFieldDefinition[];
}

/** fprintf-compatible result: a negative count stops the source writer. */
export type StructureWrite = (text: string) => number;

export function findStructureField(fields: readonly StructureFieldDefinition[], name: string): StructureFieldDefinition | undefined {
  return fields.find(field => cString(field.name) === cString(name));
}

function cString(value: string): string {
  const end = value.indexOf("\0");
  return end < 0 ? value : value.slice(0, end);
}

function structureFloat(value: number): number {
  const result = Math.fround(value);
  if (Number.isFinite(value) && !Number.isFinite(result)) throw new RangeError("structure value exceeds the source float conversion range");
  return result;
}

export interface StructureTokenSource {
  next(): ScriptToken | undefined;
  unread(token: ScriptToken): void;
  isSourceFailure?(error: unknown): boolean;
}

export interface StructureField {
  readonly name: string;
  readonly location: SourceLocation;
}

interface StructureNumber {
  readonly value: number;
  readonly location: SourceLocation;
}

function frozenLocation(location: SourceLocation): SourceLocation {
  return Object.freeze({ path: location.path, line: location.line, column: location.column });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function byteString(value: string, maximumBytes: number): string {
  const text = cString(value).slice(0, maximumBytes);
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("structure strings require source bytes");
  }
  return text;
}

export class StructureReader {
  private readonly source: StructureTokenSource;
  private readonly path: string;
  private readonly reported: ScriptDiagnostic[];
  private readonly sourceFailures = new WeakSet<ScriptLanguageError>();

  constructor(
    source: StructureTokenSource,
    path: string,
    priorDiagnostics: readonly ScriptDiagnostic[] = [],
    private readonly report?: (diagnostic: ScriptDiagnostic) => void,
  ) {
    if (path.length === 0) {
      throw new RangeError("structure source path cannot be empty");
    }
    this.source = source;
    this.path = path;
    this.reported = [...priorDiagnostics];
  }

  get diagnostics(): readonly ScriptDiagnostic[] {
    return Object.freeze([...this.reported]);
  }

  begin(): void {
    this.expectText("{");
  }

  nextField(): StructureField | undefined {
    const token = this.expectAny("expected structure field or closing brace");
    if (this.isPunctuation(token, Punctuation.BraceClose)) {
      return undefined;
    }
    return Object.freeze({ name: token.text, location: frozenLocation(token.location) });
  }

  rejectField(field: StructureField): never {
    this.fail(`unknown structure field ${field.name}`, field.location);
  }

  readInt(): number {
    const number = this.readNumber(false);
    if (!Number.isInteger(number.value) || number.value < SOURCE_INT_MIN || number.value > SOURCE_INT_MAX) {
      this.fail(
        `value ${number.value} out of range [${SOURCE_INT_MIN}, ${SOURCE_INT_MAX}]`,
        number.location,
      );
    }
    return number.value;
  }

  readFloat(): number {
    const parsed = this.readNumber(true);
    return structureFloat(parsed.value);
  }

  readString(maximumBytes = DEFAULT_STRING_BYTES): string {
    positiveInteger(maximumBytes, "maximum string bytes");
    const token = this.expectAny("expected string");
    if (token.kind !== "string") {
      this.fail(`expected string, found ${token.text}`, token.location);
    }
    const terminator = token.value.indexOf("\0");
    const value = terminator < 0 ? token.value : token.value.slice(0, terminator);
    return byteString(value, maximumBytes);
  }

  /** ReadStructure writes the caller's allocation, including successful prefixes on failure. */
  readStructure(definition: StructureDefinition, bytes: Uint8Array, base = 0): boolean {
    try {
      this.expectText("{");
      while (true) {
        const token = this.expectAny("couldn't read expected token");
        if (token.text === "}") return true;
        const field = findStructureField(definition.fields, token.text);
        if (field === undefined) this.fail(`unknown structure field ${token.text}`, token.location);
        const array = (field.type & StructureFieldType.Array) !== 0;
        if (array) this.expectText("{");
        let offset = base + field.offset;
        for (let remaining = array ? field.maxarray : 1; remaining-- > 0;) {
          if (array && this.checkText("}")) break;
          switch (field.type & StructureFieldType.Type) {
            case StructureFieldType.Char: this.readCharField(field, bytes, offset); offset++; break;
            case StructureFieldType.Int:
            case StructureFieldType.Float: this.readNumberField(field, bytes, offset); offset += 4; break;
            case StructureFieldType.String: {
              const value = this.readString();
              const target = fieldView(bytes, offset, MAX_STRINGFIELD);
              for (let index = 0; index < MAX_STRINGFIELD; index++) {
                target.setUint8(index, index < value.length ? value.charCodeAt(index) : 0);
              }
              offset += MAX_STRINGFIELD;
              break;
            }
            case StructureFieldType.Struct:
              if (field.substruct === null) this.fail("BUG: no sub structure defined", token.location);
              // The source intentionally ignores this return value.
              this.readStructure(field.substruct, bytes, offset);
              offset += field.substruct.size;
              break;
          }
          if (array) {
            const separator = this.expectAny("couldn't read expected token");
            if (separator.text === "}") break;
            if (separator.text !== ",") this.fail(`expected a comma, found ${separator.text}`, separator.location);
          }
        }
      }
    } catch (error) {
      if (error instanceof ScriptLanguageError && this.sourceFailures.has(error)
        || this.source.isSourceFailure?.(error) === true) return false;
      throw error;
    }
  }

  private checkText(text: string): boolean {
    const token = this.source.next();
    if (token === undefined) return false;
    if (token.text === text) return true;
    this.source.unread(token);
    return false;
  }

  private readCharField(field: StructureFieldDefinition, bytes: Uint8Array, offset: number): void {
    const token = this.expectAny("couldn't read expected token");
    if (token.kind === "literal") {
      const text = byteString(token.value, 1);
      fieldView(bytes, offset, 1).setUint8(0, text.length === 0 ? 0 : text.charCodeAt(0));
    } else {
      this.source.unread(token);
      this.readNumberField(field, bytes, offset);
    }
  }

  private readNumberField(field: StructureFieldDefinition, bytes: Uint8Array, offset: number): void {
    let token = this.expectAny("couldn't read expected token");
    const unsigned = (field.type & StructureFieldType.Unsigned) !== 0;
    const bounded = (field.type & StructureFieldType.Bounded) !== 0;
    const type = field.type & StructureFieldType.Type;
    let negative = false;
    if (token.kind === "punctuation") {
      if (unsigned) this.fail(`expected unsigned value, found ${token.text}`, token.location);
      if (token.text !== "-") this.fail(`unexpected punctuation ${token.text}`, token.location);
      negative = true;
      token = this.expectAny("couldn't read expected token");
    }
    if (token.kind !== "number") this.fail(`expected number, found ${token.text}`, token.location);
    const float = (token.flags & NumberFlag.Float) !== 0;
    if (float && type !== StructureFieldType.Float) this.fail("unexpected float", token.location);
    const raw = float ? token.floatValue : token.integerValue | 0;
    if (!float && negative && raw === -2147483648) throw new RangeError("structure negation exceeds the source signed-long range");
    const value = negative ? -raw : raw;
    const minimum = Math.fround(field.floatmin), maximum = Math.fround(field.floatmax);
    if (type === StructureFieldType.Char || type === StructureFieldType.Int) {
      let low = unsigned ? 0 : type === StructureFieldType.Char ? -128 : -32768;
      let high = type === StructureFieldType.Char ? unsigned ? 255 : 127 : unsigned ? 65535 : 32767;
      if (bounded) { low = Math.trunc(Math.max(low, minimum)); high = Math.trunc(Math.min(high, maximum)); }
      if (value < low || value > high) this.fail(`value ${value} out of range [${low}, ${high}]`, token.location);
    } else if (bounded && (value < minimum || value > maximum)) {
      const bounds = `[${structureDecimal(minimum)}, ${structureDecimal(maximum)}]`;
      this.fail(float ? `float out of range ${bounds}` : `value ${value} out of range ${bounds}`, token.location);
    }
    const target = fieldView(bytes, offset, type === StructureFieldType.Char ? 1 : 4);
    if (type === StructureFieldType.Char) target.setUint8(0, value);
    else if (type === StructureFieldType.Int) target.setInt32(0, value, true);
    else if (type === StructureFieldType.Float) target.setFloat32(0, structureFloat(value), true);
  }

  readFloatArray(maximumValues: number): readonly number[] {
    positiveInteger(maximumValues, "maximum array values");
    this.expectText("{");
    const values: number[] = [];
    while (values.length < maximumValues) {
      const token = this.expectAny("expected array value or closing brace");
      if (this.isPunctuation(token, Punctuation.BraceClose)) {
        return Object.freeze(values);
      }
      this.source.unread(token);
      values.push(this.readFloat());
      const separator = this.expectAny("expected comma or closing brace");
      if (this.isPunctuation(separator, Punctuation.BraceClose)) {
        return Object.freeze(values);
      }
      if (!this.isPunctuation(separator, Punctuation.Comma)) {
        this.fail(`expected a comma, found ${separator.text}`, separator.location);
      }
    }
    return Object.freeze(values);
  }

  private readNumber(floatField: boolean): StructureNumber {
    let token = this.expectAny("expected number");
    let negative = false;
    if (token.kind === "punctuation") {
      if (token.punctuation !== Punctuation.Subtract) {
        this.fail(`unexpected punctuation ${token.text}`, token.location);
      }
      negative = true;
      token = this.expectAny("expected number after minus sign");
    }
    if (token.kind !== "number") {
      this.fail(`expected number, found ${token.text}`, token.location);
    }
    if (!floatField && (token.flags & NumberFlag.Float) !== 0) {
      this.fail("unexpected float", token.location);
    }
    const value = (token.flags & NumberFlag.Float) !== 0 ? token.floatValue : token.integerValue | 0;
    if ((token.flags & NumberFlag.Float) === 0 && negative && value === -2147483648) throw new RangeError("structure negation exceeds the source signed-long range");
    return Object.freeze({ value: negative ? -value : value, location: frozenLocation(token.location) });
  }

  private expectText(text: string): void {
    const token = this.expectAny(`expected ${text}`);
    if (token.text !== text) {
      this.fail(`expected ${text}, found ${token.text}`, token.location);
    }
  }

  private expectAny(message: string): ScriptToken {
    const token = this.source.next();
    if (token === undefined) {
      this.fail(message, { path: this.path, line: 1, column: 1 });
    }
    return token;
  }

  private isPunctuation(token: ScriptToken, punctuation: Punctuation): boolean {
    return token.kind === "punctuation" && token.punctuation === punctuation;
  }

  private fail(message: string, location: SourceLocation): never {
    const diagnostic: ScriptDiagnostic = Object.freeze({
      severity: "error",
      message,
      location: frozenLocation(location),
    });
    this.reported.push(diagnostic);
    this.report?.(diagnostic);
    const failure = new ScriptLanguageError(diagnostic, this.reported);
    this.sourceFailures.add(failure);
    throw failure;
  }
}

function fieldView(bytes: Uint8Array, offset: number, size: number): DataView {
  if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length) {
    throw new RangeError("structure field exceeds its source allocation");
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, size);
}

/** sprintf %f on a promoted binary32, with the source's default rounding mode. */
function structureDecimal(value: number): string {
  const bits = float32ToBits(value), exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff;
  const sign = bits >>> 31 === 0 ? "" : "-";
  if (exponent === 255) return `${sign}${fraction === 0 ? "inf" : "nan"}`;
  const significand = BigInt(exponent === 0 ? fraction : fraction + 0x800000);
  const shift = exponent === 0 ? -149 : exponent - 150;
  const scaled = significand * 1000000n;
  let rounded: bigint;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), lower = scaled / divisor, remainder = scaled % divisor;
    rounded = remainder * 2n > divisor || remainder * 2n === divisor && lower % 2n !== 0n ? lower + 1n : lower;
  }
  return `${sign}${rounded / 1000000n}.${String(rounded % 1000000n).padStart(6, "0")}`;
}

export function writeIndent(write: StructureWrite, indent: number): boolean {
  for (let remaining = indent; remaining-- > 0;) if (write("\t") < 0) return false;
  return true;
}

export function writeFloat(write: StructureWrite, value: number): boolean {
  let text = structureDecimal(value);
  for (let index = text.length - 1; index > 0; index--) {
    const character = text.charAt(index);
    if (character !== "0" && character !== ".") break;
    text = text.slice(0, index);
    if (character === ".") break;
  }
  return write(text) >= 0;
}

export function writeStructWithIndent(write: StructureWrite, definition: StructureDefinition,
  bytes: Uint8Array, indent: number, base = 0): boolean {
  if (!writeIndent(write, indent) || write("{\r\n") < 0) return false;
  indent++;
  for (const field of definition.fields) {
    if (!writeIndent(write, indent) || write(`${cString(field.name)}\t`) < 0) return false;
    let offset = base + field.offset;
    const array = (field.type & StructureFieldType.Array) !== 0;
    if (array && write("{") < 0) return false;
    for (let remaining = array ? field.maxarray : 1; remaining-- > 0;) {
      switch (field.type & StructureFieldType.Type) {
        case StructureFieldType.Char:
          if (write(String(fieldView(bytes, offset, 1).getInt8(0))) < 0) return false;
          offset++; break;
        case StructureFieldType.Int:
          if (write(String(fieldView(bytes, offset, 4).getInt32(0, true))) < 0) return false;
          offset += 4; break;
        case StructureFieldType.Float:
          if (!writeFloat(write, fieldView(bytes, offset, 4).getFloat32(0, true))) return false;
          offset += 4; break;
        case StructureFieldType.String: {
          let text = "";
          for (let index = offset; ; index++) {
            const byte = fieldView(bytes, index, 1).getUint8(0);
            if (byte === 0) break;
            text += String.fromCharCode(byte);
          }
          if (write(`"${text}"`) < 0) return false;
          offset += MAX_STRINGFIELD; break;
        }
        case StructureFieldType.Struct:
          if (field.substruct === null) throw new RangeError("WriteStructWithIndent: null source substructure");
          // l_struct.c passes structure, not p, including every array element.
          if (!writeStructWithIndent(write, field.substruct, bytes, indent, base)) return false;
          offset += field.substruct.size; break;
      }
      if (array && write(remaining > 0 ? "," : "}") < 0) return false;
    }
    if (write("\r\n") < 0) return false;
  }
  return writeIndent(write, indent - 1) && write("}\r\n") >= 0;
}

export function writeStructure(write: StructureWrite, definition: StructureDefinition, bytes: Uint8Array): boolean {
  return writeStructWithIndent(write, definition, bytes, 0);
}
