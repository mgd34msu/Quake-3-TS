// Info_ValueForKey/Info_SetValueForKey from id Software's code/game/q_shared.c.
// Info_Print is from code/qcommon/common.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "./common-error.ts";

export function printInfo(text: string, print: (text: string) => void): void {
  let cursor = text.startsWith("\\") ? 1 : 0;
  while (cursor < text.length) {
    const separator = text.indexOf("\\", cursor);
    const key = text.slice(cursor, separator < 0 ? text.length : separator);
    if (key.length >= 512) throw new RangeError("Info_Print would overflow its source key buffer");
    print(key.padEnd(20, " "));
    if (separator < 0) { print("MISSING VALUE\n"); return; }
    const next = text.indexOf("\\", separator + 1);
    const value = text.slice(separator + 1, next < 0 ? text.length : next);
    if (value.length >= 512) throw new RangeError("Info_Print would overflow its source value buffer");
    print(`${value}\n`);
    cursor = next < 0 ? text.length : next + 1;
  }
}

/** C byte strings end at NUL; this reader returns the first ASCII-insensitive key. */
export function infoValueForKey(input: string, wanted: string, maximumLength = 8192): string {
  if (!Number.isInteger(maximumLength) || maximumLength < 1 || maximumLength > 8192) throw new RangeError("Invalid source info-string bound");
  const end = input.indexOf("\0"), keyEnd = wanted.indexOf("\0");
  const text = end < 0 ? input : input.slice(0, end), key = keyEnd < 0 ? wanted : wanted.slice(0, keyEnd);
  if (text.length >= maximumLength) throw new CommonError("drop", "Info_ValueForKey: oversize infostring");
  for (const value of [text, key]) for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) throw new RangeError("Info_ValueForKey requires byte characters");
  }
  const fold = (value: string) => value.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
  let cursor = text.startsWith("\\") ? 1 : 0;
  while (cursor < text.length) {
    const separator = text.indexOf("\\", cursor);
    if (separator < 0) return "";
    const next = text.indexOf("\\", separator + 1), valueEnd = next < 0 ? text.length : next;
    if (fold(text.slice(cursor, separator)) === fold(key)) return text.slice(separator + 1, valueEnd);
    cursor = valueEnd + 1;
  }
  return "";
}

/** Ordinary Info_SetValueForKey prepends; the separate _Big source routine appends. */
export function infoSetValueForKey(input: string, key: string, value: string, print: (text: string) => void): string {
  return setInfoValue(input, key, value, print, 1024);
}

export function infoSetValueForKeyBig(input: string, key: string, value: string, print: (text: string) => void): string {
  return setInfoValue(input, key, value, print, 8192);
}

function setInfoValue(input: string, key: string, value: string, print: (text: string) => void, capacity: 1024 | 8192): string {
  const bytes = (text: string): string => {
    const nul = text.indexOf("\0"), result = nul < 0 ? text : text.slice(0, nul);
    for (let index = 0; index < result.length; index++) if (result.charCodeAt(index) > 255) throw new RangeError("Info_SetValueForKey requires byte characters");
    return result;
  };
  const info = bytes(input), name = bytes(key), text = bytes(value);
  if (info.length >= capacity) throw new CommonError("drop", "Info_SetValueForKey: oversize infostring");
  for (const [character, message] of [["\\", "Can't use keys or values with a \\"] , [";", "Can't use keys or values with a semicolon"], ['"', 'Can\'t use keys or values with a "']] satisfies readonly (readonly [string, string])[]) {
    if (name.includes(character) || text.includes(character)) { print(`${message}\n`); return info; }
  }
  let result = info, cursor = 0;
  while (cursor < info.length) {
    const start = cursor;
    if (info.charAt(cursor) === "\\") cursor++;
    const separator = info.indexOf("\\", cursor);
    if (separator < 0) break;
    const next = info.indexOf("\\", separator + 1), end = next < 0 ? info.length : next;
    if (info.slice(cursor, separator) === name) { result = info.slice(0, start) + info.slice(end); break; }
    cursor = end;
  }
  if (text.length === 0) return result;
  const completePrefix = `\\${name}\\${text}`;
  if (completePrefix.length >= capacity) print(`Com_sprintf: overflow of ${completePrefix.length} in ${capacity}\n`);
  const prefix = completePrefix.slice(0, capacity - 1);
  if (prefix.length + result.length > capacity) {
    print(capacity === 8192 ? "BIG Info string length exceeded\n" : "Info string length exceeded\n");
    return result;
  }
  if (prefix.length + result.length === capacity) throw new RangeError("Info_SetValueForKey would overflow its source terminator");
  return capacity === 8192 ? result + prefix : prefix + result;
}
