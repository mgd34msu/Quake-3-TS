/*
 * Bot character traps from id Software's server/sv_game.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotCharacterLibrary } from "../botlib/character.ts";
import { float32ToBits } from "../core/numeric.ts";
import type { QvmMemory } from "./memory.ts";

export function qvmBotCharacterSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, characters: BotCharacterLibrary,
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 500: {
      const filenameWord = words.getInt32(4, true), skill = words.getFloat32(8, true);
      return characters.load(() => memory.readString(filenameWord), skill);
    }
    case 501: {
      const handle = words.getInt32(4, true);
      characters.free(handle);
      return 0;
    }
    case 502: {
      const handle = words.getInt32(4, true), index = words.getInt32(8, true);
      return float32ToBits(characters.float(handle, index)) | 0;
    }
    case 503: {
      const handle = words.getInt32(4, true), index = words.getInt32(8, true);
      const minimum = words.getFloat32(12, true), maximum = words.getFloat32(16, true);
      return float32ToBits(characters.boundedFloat(handle, index, minimum, maximum)) | 0;
    }
    case 504: {
      const handle = words.getInt32(4, true), index = words.getInt32(8, true);
      return characters.integer(handle, index);
    }
    case 505: {
      const handle = words.getInt32(4, true), index = words.getInt32(8, true);
      const minimum = words.getInt32(12, true), maximum = words.getInt32(16, true);
      return characters.boundedInteger(handle, index, minimum, maximum);
    }
    case 506: {
      const handle = words.getInt32(4, true), index = words.getInt32(8, true);
      const destinationWord = words.getInt32(12, true), capacity = words.getInt32(16, true);
      characters.writeString(handle, index, text => {
        memory.writeBoundedString(destinationWord, text, capacity);
      });
      return 0;
    }
    default: return null;
  }
}
