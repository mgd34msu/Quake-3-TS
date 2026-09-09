/*
 * Genetic bot traps from id Software's server/sv_game.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotLibrary } from "../botlib/library.ts";
import type { QvmMemory } from "./memory.ts";

export function qvmBotGeneticSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory,
  library: Pick<BotLibrary, "goals" | "geneticSelection">,
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 545:
      library.goals.saveGoalFuzzyLogic(words.getInt32(4, true));
      return 0;
    case 564: {
      const count = words.getInt32(4, true), ranksWord = words.getInt32(8, true);
      const parent1Word = words.getInt32(12, true), parent2Word = words.getInt32(16, true);
      const childWord = words.getInt32(20, true);
      const result = library.geneticSelection({
        count,
        rank: index => memory.view(ranksWord, index * 4 + 4).getFloat32(index * 4, true),
        write: (target, value) => {
          const pointer = target === "parent1" ? parent1Word : target === "parent2" ? parent2Word : childWord;
          memory.view(pointer, 4).setInt32(0, value, true);
        },
      });
      if (result.kind === "selected") return 1;
      if (result.reason === "undefined-random-index") {
        throw new RangeError("genetic selection reached the source's undefined one-past random index");
      }
      return 0;
    }
    case 565:
      library.goals.interbreedGoalFuzzyLogic(words.getInt32(4, true), words.getInt32(8, true), words.getInt32(12, true));
      return 0;
    case 566:
      library.goals.mutateGoalFuzzyLogic(words.getInt32(4, true));
      return 0;
    default: return null;
  }
}
