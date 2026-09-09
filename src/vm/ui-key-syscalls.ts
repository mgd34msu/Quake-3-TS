/*
 * UI key traps from id Software code/client/cl_ui.c and cl_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { validateCdKey } from "../engine/cd-key.ts";
import type { CommonCdKeyState } from "../engine/cd-key.ts";
import type { QvmMemory } from "./memory.ts";

export function qvmUiKeySyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory,
  keys: CommonCdKeyState, usesUniqueKey: () => number | Promise<number>,
): number | Promise<number> | null {
  if (role !== "ui") return null;
  switch (words.getInt32(0, true)) {
    case 53: {
      const outputWord = words.getInt32(4, true);
      // CLUI_GetCDKey ignores buflen and always copies sixteen bytes plus NUL.
      return keys.readUiForModule(usesUniqueKey, () => memory.span(outputWord, 17)).then(() => 0);
    }
    case 54: {
      const inputWord = words.getInt32(4, true);
      return keys.writeUiForModule(usesUniqueKey, () => memory.span(inputWord, 16)).then(() => 0);
    }
    case 81: {
      const keyWord = words.getInt32(4, true), checksumWord = words.getInt32(8, true);
      const key = memory.readString(keyWord);
      if (key.length !== 16) return 0;
      const checksum = memory.pointer(checksumWord) === null ? null : memory.readString(checksumWord);
      return Number(validateCdKey(key, checksum));
    }
    case 87: return 0;
    default: return null;
  }
}
