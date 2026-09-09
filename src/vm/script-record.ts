// Port of id Software game/q_shared.h:pc_token_t, botlib/l_precomp.c:PC_ReadTokenHandle
// and botlib/l_script.c:StripDoubleQuotes. Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import type { ScriptToken, ScriptTokenRecord } from "../script/lexer.ts";
import { SourceTokenMemory } from "../script/token-memory.ts";

export const QVM_SCRIPT_TOKEN_BYTES = 1040;

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

function stringLength(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const byte = text.charCodeAt(index);
    if (byte === 0) return index;
    if (index >= 1023) throw new RangeError("QVM pc_token_t string exceeds 1023 source bytes");
    if (byte > 255) throw new RangeError("QVM pc_token_t requires source byte characters");
  }
  return text.length;
}

/** Writes PC_ReadToken's output, including its defined partial false result.
 * Invalid handles belong to the caller. Undefined source token fields and
 * unsigned-long values beyond JavaScript's exact integer range are unsupported.
 */
export function writeQvmScriptToken(view: DataView, value: ScriptTokenRecord | SourceTokenMemory): void {
  if (view.byteLength < QVM_SCRIPT_TOKEN_BYTES) {
    throw new BinaryError("QVM pc_token_t", 0,
      `record requires ${QVM_SCRIPT_TOKEN_BYTES} bytes, received ${view.byteLength}`);
  }
  const text = value instanceof SourceTokenMemory ? value.string : value.token.text;
  const length = stringLength(text);
  const type = value instanceof SourceTokenMemory ? value.type : tokenType(value.token);
  if (!Number.isInteger(value.subtype) || value.subtype < -2147483648 || value.subtype > 2147483647) {
    throw new RangeError("QVM pc_token_t requires an int32 source subtype");
  }
  if (!Number.isSafeInteger(value.integerValue)) {
    throw new RangeError("QVM pc_token_t requires an exactly represented source integer");
  }
  const leadingQuote = type === 1 && text.charCodeAt(0) === 34;
  const strippedLength = length - Number(leadingQuote);
  if (type === 1 && strippedLength === 0) {
    throw new RangeError("QVM pc_token_t cannot encode undefined empty StripDoubleQuotes input");
  }

  // strcpy touches only the source C string and its terminating NUL.
  for (let index = 0; index < length; index++) view.setUint8(16 + index, text.charCodeAt(index));
  view.setUint8(16 + length, 0);
  view.setInt32(0, type, true);
  view.setInt32(4, value.subtype, true);
  view.setInt32(8, value.integerValue, true);
  view.setFloat32(12, value.floatValue, true);
  if (leadingQuote) {
    for (let index = 0; index < length; index++) view.setUint8(16 + index, view.getUint8(17 + index));
  }
  if (type === 1 && view.getUint8(16 + strippedLength - 1) === 34) {
    view.setUint8(16 + strippedLength - 1, 0);
  }
}
