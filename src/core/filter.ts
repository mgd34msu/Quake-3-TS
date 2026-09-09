// Port of id Software's common.c Com_Filter/Com_StringContains.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { sourceCommandText } from "./text.ts";

function byte(text: string, index: number): number {
  if (index > text.length) throw new RangeError("Source filter reads beyond a string terminator");
  return index === text.length ? 0 : text.charCodeAt(index);
}
function upper(value: number): number {
  // Signed char 0xff promotes to EOF, the one defined negative ctype input.
  if (value === 255) return -1;
  return value >= 97 && value <= 122 ? value - 32 : value;
}
function signed(value: number): number { return value > 127 ? value - 256 : value; }

/** Source matching accepts a prefix and searches star runs without backtracking. */
export function sourceFilter(filterText: string, nameText: string, caseSensitive: boolean): boolean {
  const filter = sourceCommandText(filterText), name = sourceCommandText(nameText);
  const fold = caseSensitive ? signed : upper;
  let pattern = 0, cursor = 0;
  while (byte(filter, pattern) !== 0) {
    if (byte(filter, pattern) === 42) {
      pattern++;
      const start = pattern;
      while (byte(filter, pattern) !== 0 && byte(filter, pattern) !== 42 && byte(filter, pattern) !== 63) pattern++;
      const segment = filter.slice(start, pattern);
      if (segment.length >= 1024) throw new RangeError("Source filter star run exceeds its scratch buffer");
      if (segment.length > 0) {
        let found = -1;
        for (let index = cursor; index <= name.length - segment.length; index++) {
          let matches = true;
          for (let character = 0; character < segment.length; character++) {
            if (fold(byte(name, index + character)) !== fold(byte(segment, character))) { matches = false; break; }
          }
          if (matches) { found = index; break; }
        }
        if (found < 0) return false;
        cursor = found + segment.length;
      }
    } else if (byte(filter, pattern) === 63) {
      byte(name, cursor);
      pattern++; cursor++;
    } else if (byte(filter, pattern) === 91 && byte(filter, pattern + 1) === 91) {
      pattern++;
    } else if (byte(filter, pattern) === 91) {
      pattern++;
      let found = false;
      while (byte(filter, pattern) !== 0 && !found) {
        if (byte(filter, pattern) === 93 && byte(filter, pattern + 1) !== 93) break;
        if (byte(filter, pattern + 1) === 45 && byte(filter, pattern + 2) !== 0
          && (byte(filter, pattern + 2) !== 93 || byte(filter, pattern + 3) === 93)) {
          const current = fold(byte(name, cursor));
          if (current >= fold(byte(filter, pattern)) && current <= fold(byte(filter, pattern + 2))) found = true;
          pattern += 3;
        } else {
          if (fold(byte(filter, pattern)) === fold(byte(name, cursor))) found = true;
          pattern++;
        }
      }
      if (!found) return false;
      while (byte(filter, pattern) !== 0) {
        if (byte(filter, pattern) === 93 && byte(filter, pattern + 1) !== 93) break;
        pattern++;
      }
      pattern++; cursor++;
    } else {
      if (fold(byte(filter, pattern)) !== fold(byte(name, cursor))) return false;
      pattern++; cursor++;
    }
  }
  return true;
}
