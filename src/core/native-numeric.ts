/*
 * Numeric parsing used by the native Quake III engine. The engine source calls
 * the platform atoi and atof rather than the QVM implementations in
 * game/bg_lib.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const INT32_MAX = 2147483647;
const INT32_MIN_MAGNITUDE = 2147483648;
const DOUBLE_FRACTION_BITS = 52n;
const DOUBLE_QUIET_NAN_BIT = 1n << 51n;
const DOUBLE_FRACTION_MASK = (1n << DOUBLE_FRACTION_BITS) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

function isSpace(byte: number): boolean {
  return byte === 32 || (byte >= 9 && byte <= 13);
}

function validateByteText(text: string): void {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("Native numbers require byte characters");
  }
}

/** Parse a source byte string with the observed i386 glibc atoi profile. */
export function nativeAtoi(text: string): number {
  validateByteText(text);

  let offset = 0;
  while (offset < text.length && isSpace(text.charCodeAt(offset))) offset++;

  let negative = false;
  const sign = text.charCodeAt(offset);
  if (sign === 43 || sign === 45) {
    negative = sign === 45;
    offset++;
  }

  const limit = negative ? INT32_MIN_MAGNITUDE : INT32_MAX;
  let magnitude = 0;
  let overflow = false;
  while (offset < text.length) {
    const byte = text.charCodeAt(offset);
    if (byte === 0 || byte < 48 || byte > 57) break;
    const digit = byte - 48;
    if (!overflow) {
      if (magnitude > Math.floor((limit - digit) / 10)) {
        magnitude = limit;
        overflow = true;
      } else {
        magnitude = magnitude * 10 + digit;
      }
    }
    offset++;
  }

  if (magnitude === 0) return 0;
  return negative ? -magnitude : magnitude;
}

function lowerAscii(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

function matchesAsciiWord(text: string, offset: number, word: string): boolean {
  if (offset + word.length > text.length) return false;
  for (let index = 0; index < word.length; index++) {
    const byte = text.charCodeAt(offset + index);
    if (byte === 0 || lowerAscii(byte) !== word.charCodeAt(index)) return false;
  }
  return true;
}

function doubleFromBits(bits: bigint): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function signedZero(negative: boolean): number {
  return negative ? doubleFromBits(1n << 63n) : 0;
}

function infinity(negative: boolean): number {
  const sign = negative ? 1n << 63n : 0n;
  return doubleFromBits(sign | (0x7ffn << DOUBLE_FRACTION_BITS));
}

function nanWithPayload(negative: boolean, payload: bigint): number {
  // Bun canonicalizes NaN values at the JavaScript number boundary. Retaining
  // the glibc payload construction here still keeps its accepted payload syntax
  // explicit, but callers can observe only the NaN classification.
  const sign = negative ? 1n << 63n : 0n;
  const fraction = DOUBLE_QUIET_NAN_BIT | (payload & (DOUBLE_QUIET_NAN_BIT - 1n));
  return doubleFromBits(sign | (0x7ffn << DOUBLE_FRACTION_BITS) | fraction);
}

function digitValue(byte: number, radix: number): number {
  let value = -1;
  if (byte >= 48 && byte <= 57) value = byte - 48;
  else if (byte >= 65 && byte <= 70) value = byte - 65 + 10;
  else if (byte >= 97 && byte <= 102) value = byte - 97 + 10;
  return value < radix ? value : -1;
}

function parseNanPayload(text: string, offset: number): bigint {
  if (text.charCodeAt(offset) !== 40) return 0n;
  let end = offset + 1;
  while (end < text.length) {
    const byte = text.charCodeAt(end);
    const isPayloadCharacter =
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      byte === 95 ||
      (byte >= 97 && byte <= 122);
    if (!isPayloadCharacter) break;
    end++;
  }
  if (text.charCodeAt(end) !== 41 || end === offset + 1) return 0n;

  let cursor = offset + 1;
  let radix = 10;
  if (text.charCodeAt(cursor) === 48) {
    if ((text.charCodeAt(cursor + 1) === 120 || text.charCodeAt(cursor + 1) === 88) &&
        digitValue(text.charCodeAt(cursor + 2), 16) >= 0) {
      radix = 16;
      cursor += 2;
    } else {
      radix = 8;
    }
  }

  let payload = 0n;
  let sawDigit = false;
  for (; cursor < end; cursor++) {
    const digit = digitValue(text.charCodeAt(cursor), radix);
    if (digit < 0) return 0n;
    sawDigit = true;
    if (payload < UINT64_MAX) {
      const next = payload * BigInt(radix) + BigInt(digit);
      payload = next > UINT64_MAX ? UINT64_MAX : next;
    }
  }
  return sawDigit ? payload : 0n;
}

function roundRightToEven(value: bigint, shift: number): bigint {
  if (shift <= 0) return value << BigInt(-shift);
  const bitLength = value.toString(2).length;
  if (shift > bitLength) return 0n;
  if (shift === bitLength) return value === 1n << BigInt(bitLength - 1) ? 0n : 1n;

  const shiftBits = BigInt(shift);
  const quotient = value >> shiftBits;
  const remainder = value - (quotient << shiftBits);
  const halfway = 1n << BigInt(shift - 1);
  if (remainder > halfway || (remainder === halfway && (quotient & 1n) !== 0n)) return quotient + 1n;
  return quotient;
}

function finiteDouble(negative: boolean, exponent: number, fraction: bigint): number {
  const sign = negative ? 1n << 63n : 0n;
  return doubleFromBits(sign | (BigInt(exponent) << DOUBLE_FRACTION_BITS) | fraction);
}

function convertHex(significand: bigint, exponent2: bigint, negative: boolean): number {
  if (significand === 0n) return signedZero(negative);

  const bitLength = significand.toString(2).length;
  let binaryExponent = BigInt(bitLength - 1) + exponent2;
  if (binaryExponent > 1023n) return infinity(negative);
  if (binaryExponent < -1075n) return signedZero(negative);

  if (binaryExponent >= -1022n) {
    let rounded = roundRightToEven(significand, bitLength - 53);
    if (rounded === 1n << 53n) {
      rounded >>= 1n;
      binaryExponent++;
      if (binaryExponent > 1023n) return infinity(negative);
    }
    const exponentField = Number(binaryExponent) + 1023;
    return finiteDouble(negative, exponentField, rounded - (1n << 52n));
  }

  const subnormalShift = exponent2 + 1074n;
  const fraction = subnormalShift >= 0n
    ? significand << subnormalShift
    : roundRightToEven(significand, Number(-subnormalShift));
  if (fraction === 0n) return signedZero(negative);
  if (fraction === 1n << 52n) return finiteDouble(negative, 1, 0n);
  return finiteDouble(negative, 0, fraction & DOUBLE_FRACTION_MASK);
}

function parseSignedDecimalExponent(text: string, offset: number): bigint {
  let cursor = offset;
  let negative = false;
  const sign = text.charCodeAt(cursor);
  if (sign === 43 || sign === 45) {
    negative = sign === 45;
    cursor++;
  }
  let value = 0n;
  while (cursor < text.length) {
    const byte = text.charCodeAt(cursor);
    if (byte < 48 || byte > 57) break;
    value = value * 10n + BigInt(byte - 48);
    cursor++;
  }
  return negative ? -value : value;
}

function parseHex(text: string, offset: number, negative: boolean): number | null {
  if (text.charCodeAt(offset) !== 48 ||
      (text.charCodeAt(offset + 1) !== 120 && text.charCodeAt(offset + 1) !== 88)) return null;

  let cursor = offset + 2;
  let significand = 0n;
  let fractionDigits = 0;
  let afterPoint = false;
  let sawPoint = false;
  let sawDigit = false;
  while (cursor < text.length) {
    const byte = text.charCodeAt(cursor);
    const digit = digitValue(byte, 16);
    if (digit >= 0) {
      significand = significand * 16n + BigInt(digit);
      if (afterPoint) fractionDigits++;
      sawDigit = true;
      cursor++;
    } else if (byte === 46 && !sawPoint) {
      sawPoint = true;
      afterPoint = true;
      cursor++;
    } else {
      break;
    }
  }
  if (!sawDigit) return null;

  let parsedExponent = 0n;
  if (text.charCodeAt(cursor) === 112 || text.charCodeAt(cursor) === 80) {
    let exponentDigits = cursor + 1;
    if (text.charCodeAt(exponentDigits) === 43 || text.charCodeAt(exponentDigits) === 45) exponentDigits++;
    const firstExponentDigit = text.charCodeAt(exponentDigits);
    if (firstExponentDigit >= 48 && firstExponentDigit <= 57) {
      parsedExponent = parseSignedDecimalExponent(text, cursor + 1);
    }
  }
  return convertHex(significand, parsedExponent - BigInt(fractionDigits) * 4n, negative);
}

/** Parse a C-locale source byte string with the observed glibc atof profile. */
export function nativeAtof(text: string): number {
  validateByteText(text);

  let offset = 0;
  while (offset < text.length && isSpace(text.charCodeAt(offset))) offset++;

  const signedStart = offset;
  let negative = false;
  const sign = text.charCodeAt(offset);
  if (sign === 43 || sign === 45) {
    negative = sign === 45;
    offset++;
  }

  if (matchesAsciiWord(text, offset, "inf")) return infinity(negative);
  if (matchesAsciiWord(text, offset, "nan")) {
    return nanWithPayload(negative, parseNanPayload(text, offset + 3));
  }

  const hexadecimal = parseHex(text, offset, negative);
  if (hexadecimal !== null) return hexadecimal;

  let cursor = offset;
  let sawDigit = false;
  while (cursor < text.length) {
    const byte = text.charCodeAt(cursor);
    if (byte < 48 || byte > 57) break;
    sawDigit = true;
    cursor++;
  }
  if (text.charCodeAt(cursor) === 46) {
    cursor++;
    while (cursor < text.length) {
      const byte = text.charCodeAt(cursor);
      if (byte < 48 || byte > 57) break;
      sawDigit = true;
      cursor++;
    }
  }
  if (!sawDigit) return 0;

  if (text.charCodeAt(cursor) === 101 || text.charCodeAt(cursor) === 69) {
    let exponentDigits = cursor + 1;
    if (text.charCodeAt(exponentDigits) === 43 || text.charCodeAt(exponentDigits) === 45) exponentDigits++;
    const firstExponentDigit = text.charCodeAt(exponentDigits);
    if (firstExponentDigit >= 48 && firstExponentDigit <= 57) {
      cursor = exponentDigits + 1;
      while (cursor < text.length) {
        const byte = text.charCodeAt(cursor);
        if (byte < 48 || byte > 57) break;
        cursor++;
      }
    }
  }
  return Number(text.slice(signedStart, cursor));
}
