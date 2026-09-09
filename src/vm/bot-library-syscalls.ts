/*
 * Bot library traps from id Software's server/sv_game.c, sv_bot.c and botlib/be_interface.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotLibrary, BotLibraryMapInput } from "../botlib/library.ts";
import { QVM_BOT_ENTITY_STATE_BYTES, borrowQvmBotEntityState } from "./bot-entity-record.ts";
import type { QvmMemory } from "./memory.ts";

export interface QvmBotLibraryImports {
  enabled(): boolean;
  mapInput(name: string | null): BotLibraryMapInput;
}

export function qvmBotLibrarySyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory,
  library: BotLibrary, imports: QvmBotLibraryImports,
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 200: return imports.enabled() ? library.setup() : 0;
    case 201: return library.shutdown();
    case 202: {
      const nameWord = words.getInt32(4, true), valueWord = words.getInt32(8, true);
      library.variables.setByNameBytes(
        nameWord === 0 ? null : index => memory.view(nameWord, index + 1).getUint8(index),
        () => memory.readString(nameWord), () => memory.readString(valueWord),
      );
      return 0;
    }
    case 203: {
      const nameWord = words.getInt32(4, true), valueWord = words.getInt32(8, true);
      const size = words.getInt32(12, true);
      const value = library.variables.getStringByNameBytes(nameWord === 0 ? null
        : index => memory.view(nameWord, index + 1).getUint8(index));
      // The source strncpy(size - 1) followed by value[size - 1] = 0 pads the full span.
      memory.writeBoundedString(valueWord, value, size);
      return 0;
    }
    case 205: {
      const time = words.getFloat32(4, true);
      return library.startFrame(time);
    }
    case 206: {
      const nameWord = words.getInt32(4, true);
      return library.loadMap(() => imports.mapInput(nameWord === 0 ? null : memory.readString(nameWord)));
    }
    case 207: {
      const entity = words.getInt32(4, true), stateWord = words.getInt32(8, true);
      return library.updateEntity(entity, () => stateWord === 0 ? null
        : borrowQvmBotEntityState(memory.view(stateWord, QVM_BOT_ENTITY_STATE_BYTES)));
    }
    case 208: return library.test();
    default: return null;
  }
}
