/*
 * Library replacement strings from id Software's code/game/q_shared.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { CommonError } from "./common-error.ts";

/** A callback borrows live byte storage and is invoked only at reached reads. */
export type SourceString = string | Uint8Array | ((index: number) => number);

function byteAt(text: SourceString, index: number): number {
  const byte = typeof text === "function" ? text(index)
    : typeof text === "string" ? index === text.length ? 0 : text.charCodeAt(index)
      : text[index];
  if (byte === undefined || !Number.isInteger(byte) || byte < 0 || byte > 255) {
    throw new RangeError("Source string read requires an allocated byte");
  }
  return byte;
}

export function qIsprint(c: number): 0 | 1 { return c >= 0x20 && c <= 0x7e ? 1 : 0; }
export function qIslower(c: number): 0 | 1 { return c >= 97 && c <= 122 ? 1 : 0; }
export function qIsupper(c: number): 0 | 1 { return c >= 65 && c <= 90 ? 1 : 0; }
export function qIsalpha(c: number): 0 | 1 { return qIslower(c) || qIsupper(c); }

export function qStrrchr(text: SourceString, c: number): number | null {
  const character = c & 255;
  let found: number | null = null;
  let index = 0;
  for (let byte = byteAt(text, index); byte !== 0; byte = byteAt(text, ++index)) {
    if (byte === character) found = index;
  }
  return character === 0 ? index : found;
}

export function qStrncpyz(destination: Uint8Array | null, source: SourceString | null, size: number): void {
  if (destination === null) throw new CommonError("fatal", "Q_strncpyz: NULL dest");
  if (source === null) throw new CommonError("fatal", "Q_strncpyz: NULL src");
  if (size < 1) throw new CommonError("fatal", "Q_strncpyz: destsize < 1");
  if (!Number.isInteger(size) || size > destination.length) {
    throw new RangeError("Q_strncpyz destination exceeds its allocation");
  }
  let index = 0;
  for (; index < size - 1; index++) {
    const byte = byteAt(source, index);
    destination[index] = byte;
    if (byte === 0) break;
  }
  destination.fill(0, index, size);
}

export function qStricmpn(first: SourceString | null, second: SourceString | null, count: number): -1 | 0 | 1 {
  if (first === null) return second === null ? 0 : -1;
  if (second === null) return 1;
  let index = 0;
  let remaining = count | 0;
  do {
    let a = byteAt(first, index) << 24 >> 24;
    let b = byteAt(second, index++) << 24 >> 24;
    const prior = remaining;
    remaining = remaining - 1 | 0;
    if (prior === 0) return 0;
    if (a !== b) {
      if (qIslower(a)) a -= 32;
      if (qIslower(b)) b -= 32;
      if (a !== b) return a < b ? -1 : 1;
    }
    if (a === 0) return 0;
  } while (true);
}

export function qStrncmp(first: SourceString, second: SourceString, count: number): -1 | 0 | 1 {
  let index = 0;
  let remaining = count | 0;
  do {
    const a = byteAt(first, index) << 24 >> 24;
    const b = byteAt(second, index++) << 24 >> 24;
    const prior = remaining;
    remaining = remaining - 1 | 0;
    if (prior === 0) return 0;
    if (a !== b) return a < b ? -1 : 1;
    if (a === 0) return 0;
  } while (true);
}

export function qStricmp(first: SourceString | null, second: SourceString | null): -1 | 0 | 1 {
  return first !== null && second !== null ? qStricmpn(first, second, 99999) : -1;
}

export function qStrlwr(text: Uint8Array): Uint8Array {
  for (let index = 0, byte = byteAt(text, 0); byte !== 0; byte = byteAt(text, ++index)) {
    text[index] = qIsupper(byte) ? byte + 32 : byte;
  }
  return text;
}

export function qStrupr(text: Uint8Array): Uint8Array {
  for (let index = 0, byte = byteAt(text, 0); byte !== 0; byte = byteAt(text, ++index)) {
    text[index] = qIslower(byte) ? byte - 32 : byte;
  }
  return text;
}

export function qStrcat(destination: Uint8Array, size: number, source: SourceString | null): void {
  let length = 0;
  while (byteAt(destination, length) !== 0) length++;
  if (length >= size) throw new CommonError("fatal", "Q_strcat: already overflowed");
  qStrncpyz(destination.subarray(length), source, size - length);
}

export function qPrintStrlen(text: SourceString | null): number {
  if (text === null) return 0;
  let length = 0;
  for (let index = 0, byte = byteAt(text, 0); byte !== 0; byte = byteAt(text, index)) {
    if (byte === 94) {
      const next = byteAt(text, index + 1);
      if (next !== 0 && next !== 94) { index += 2; continue; }
    }
    index++;
    length++;
  }
  return length;
}

export function qCleanStr(text: Uint8Array): Uint8Array {
  let destination = 0;
  for (let source = 0, byte = byteAt(text, 0); byte !== 0; byte = byteAt(text, ++source)) {
    if (byte === 94 && byteAt(text, source + 1) !== 0 && byteAt(text, source + 1) !== 94) {
      source++;
    } else if (qIsprint(byte)) {
      text[destination++] = byte;
    }
  }
  text[destination] = 0;
  return text;
}
