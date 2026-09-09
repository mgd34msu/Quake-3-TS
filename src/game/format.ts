/*
 * Game-side formatting translated from id Software's code/game/bg_lib.c
 * AddInt, AddFloat, AddString and vsprintf, with code/game/q_shared.c
 * Com_sprintf destination bounds.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { int32 } from "../core/numeric.ts";

export type GameFormatArgument = number | string | null;

const BIG_BUFFER_BYTES = 32_000;
const LADJUST = 0x04;
const ZEROPAD = 0x80;

class FormatOutput {
  private value = "";

  appendByte(byte: number): void {
    this.reserve(1);
    this.value += String.fromCharCode(byte & 255);
  }

  appendBytes(value: string, length: number): void {
    this.reserve(length);
    this.value += value.slice(0, length);
  }

  appendRepeated(byte: number, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("game format padding count is unsafe");
    }
    this.reserve(count);
    this.value += String.fromCharCode(byte & 255).repeat(count);
  }

  finish(maxBytes: number): string {
    const nul = this.value.indexOf("\0");
    const visible = nul < 0 ? this.value : this.value.slice(0, nul);
    return visible.slice(0, maxBytes - 1);
  }

  private reserve(bytes: number): void {
    if (this.value.length + bytes >= BIG_BUFFER_BYTES) {
      throw new RangeError("game format exceeds the 32000-byte Com_sprintf buffer");
    }
  }
}

function byteLength(value: string, limit: number): number {
  const end = Math.min(value.length, limit);
  for (let index = 0; index < end; index++) {
    const byte = value.charCodeAt(index);
    if (byte === 0) return index;
    if (byte > 255) {
      throw new RangeError("game format strings must contain byte-valued code units");
    }
  }
  return end;
}

function argumentAt(
  args: readonly GameFormatArgument[],
  index: number,
  specifier: string,
): GameFormatArgument {
  const value = args[index];
  if (value === undefined) {
    throw new RangeError(`missing argument ${index} for %${specifier}`);
  }
  return value;
}

function integerArgument(value: GameFormatArgument, index: number, specifier: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`argument ${index} for %${specifier} must be a number`);
  }
  if (!Number.isSafeInteger(value) || value !== int32(value)) {
    throw new RangeError(`argument ${index} for %${specifier} must be a signed 32-bit integer`);
  }
  return value;
}

function floatArgument(value: GameFormatArgument, index: number): number {
  if (typeof value !== "number") {
    throw new TypeError(`argument ${index} for %f must be a number`);
  }
  const stored = Math.fround(value);
  if (!Number.isFinite(stored) || Math.abs(stored) > 2_147_483_647) {
    throw new RangeError(`argument ${index} for %f is outside the source's safe int-cast range`);
  }
  return stored;
}

function reversedIntegerBytes(value: number): number[] {
  const signedValue = value;
  let remaining = value < 0 ? int32(-value) : value;
  const bytes: number[] = [];
  do {
    bytes.push(48 + remaining % 10);
    remaining = Math.trunc(remaining / 10);
  } while (remaining !== 0);
  if (signedValue < 0) bytes.push(45);
  return bytes;
}

function addInt(output: FormatOutput, value: number, width: number, flags: number): void {
  const reversed = reversedIntegerBytes(value);
  if ((flags & LADJUST) === 0) {
    const padding = width > reversed.length ? width - reversed.length : 0;
    output.appendRepeated((flags & ZEROPAD) !== 0 ? 48 : 32, padding);
  }
  for (let index = reversed.length - 1; index >= 0; index--) {
    const byte = reversed[index];
    if (byte === undefined) throw new Error("integer formatter lost a digit");
    output.appendByte(byte);
  }
  if ((flags & LADJUST) !== 0) {
    const remainingWidth = int32(width - reversed.length);
    if (remainingWidth < 0) {
      throw new RangeError("left-adjusted integer width would enter the source's negative padding loop");
    }
    output.appendRepeated((flags & ZEROPAD) !== 0 ? 48 : 32, remainingWidth);
  }
}

function addFloat(output: FormatOutput, value: number, width: number, precision: number): void {
  const signedValue = value;
  let remaining = value < 0 ? Math.fround(-value) : value;
  const integer = Math.trunc(remaining);
  const reversed = reversedIntegerBytes(integer);
  if (signedValue < 0) reversed.push(45);

  const padding = width > reversed.length ? width - reversed.length : 0;
  output.appendRepeated(32, padding);
  for (let index = reversed.length - 1; index >= 0; index--) {
    const byte = reversed[index];
    if (byte === undefined) throw new Error("float formatter lost an integer digit");
    output.appendByte(byte);
  }

  const digits = precision < 0 ? 6 : precision;
  if (digits > 32) {
    throw new RangeError("float precision would overflow AddFloat's 32-byte digit buffer");
  }
  if (digits === 0) return;
  output.appendByte(46);
  for (let index = 0; index < digits; index++) {
    remaining = Math.fround(remaining - Math.trunc(remaining));
    remaining = Math.fround(remaining * 10);
    output.appendByte(48 + Math.trunc(remaining) % 10);
  }
}

function addString(output: FormatOutput, value: string | null, width: number, precision: number): void {
  const text = value === null ? "(null)" : value;
  const effectivePrecision = value === null ? -1 : precision;
  const length = byteLength(text, effectivePrecision < 0 ? text.length : effectivePrecision);
  output.appendBytes(text, length);
  const padding = int32(width - length);
  if (padding > 0) output.appendRepeated(32, padding);
}

function formatByte(format: string, index: number): number | null {
  if (index >= format.length) return null;
  const byte = format.charCodeAt(index);
  if (byte === 0) return null;
  if (byte > 255) {
    throw new RangeError("game format strings must contain byte-valued code units");
  }
  return byte;
}

/** Formats byte strings with the QVM bg_lib.c rules, then applies Q_strncpyz bounds. */
export function gameFormat(
  format: string,
  args: readonly GameFormatArgument[],
  maxBytes = BIG_BUFFER_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("game format destination capacity must be a positive safe integer");
  }

  const output = new FormatOutput();
  let cursor = 0;
  let argumentIndex = 0;
  while (true) {
    const literal = formatByte(format, cursor);
    if (literal === null) break;
    if (literal !== 37) {
      output.appendByte(literal);
      cursor += 1;
      continue;
    }
    cursor += 1;

    let flags = 0;
    let width = 0;
    let precision = -1;
    while (true) {
      const specifierByte = formatByte(format, cursor);
      if (specifierByte === null) {
        throw new RangeError("unterminated game format specifier");
      }
      cursor += 1;
      if (specifierByte === 45) {
        flags |= LADJUST;
        continue;
      }
      if (specifierByte === 46) {
        let parsed = 0;
        while (true) {
          const digit = formatByte(format, cursor);
          if (digit === null || digit < 48 || digit > 57) break;
          parsed = int32(Math.imul(10, parsed) + digit - 48);
          cursor += 1;
        }
        precision = parsed < 0 ? -1 : parsed;
        continue;
      }
      if (specifierByte === 48) {
        flags |= ZEROPAD;
        continue;
      }
      if (specifierByte >= 49 && specifierByte <= 57) {
        let parsed = 0;
        let digit = specifierByte;
        while (digit >= 48 && digit <= 57) {
          parsed = int32(Math.imul(10, parsed) + digit - 48);
          const next = formatByte(format, cursor);
          if (next === null) {
            throw new RangeError("unterminated game format specifier");
          }
          cursor += 1;
          digit = next;
        }
        width = parsed;
        cursor -= 1;
        continue;
      }

      const specifier = String.fromCharCode(specifierByte);
      if (specifierByte === 37) {
        output.appendByte(37);
        break;
      }
      const argument = argumentAt(args, argumentIndex, specifier);
      if (specifierByte === 100 || specifierByte === 105) {
        addInt(output, integerArgument(argument, argumentIndex, specifier), width, flags);
      } else if (specifierByte === 102) {
        addFloat(output, floatArgument(argument, argumentIndex), width, precision);
      } else if (specifierByte === 115) {
        if (typeof argument !== "string" && argument !== null) {
          throw new TypeError(`argument ${argumentIndex} for %s must be a string or null`);
        }
        addString(output, argument, width, precision);
      } else {
        output.appendByte(integerArgument(argument, argumentIndex, specifier));
      }
      argumentIndex += 1;
      break;
    }
  }
  return output.finish(maxBytes);
}
