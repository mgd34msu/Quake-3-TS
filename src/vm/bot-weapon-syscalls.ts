/*
 * Bot weapon traps from id Software's server/sv_game.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { WeaponAi } from "../botlib/weapons.ts";
import { QVM_WEAPON_INFO_BYTES, writeQvmWeaponInfo } from "./bot-weapon-record.ts";
import type { QvmMemory } from "./memory.ts";

export function qvmBotWeaponSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, weapons: WeaponAi,
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 558: {
      const handle = words.getInt32(4, true), inventoryWord = words.getInt32(8, true);
      return weapons.chooseBestFightWeapon(handle, index =>
        memory.view(inventoryWord, 4, index * 4).getInt32(0, true));
    }
    case 559: {
      const handle = words.getInt32(4, true), weaponNumber = words.getInt32(8, true);
      const destinationWord = words.getInt32(12, true);
      const info = weapons.weaponInfoBytes(handle, weaponNumber);
      if (info !== undefined) writeQvmWeaponInfo(memory.view(destinationWord, QVM_WEAPON_INFO_BYTES), info);
      return 0;
    }
    case 560: {
      const handle = words.getInt32(4, true), filenameWord = words.getInt32(8, true);
      return weapons.loadWeights(handle, () => memory.readString(filenameWord));
    }
    case 561: return weapons.allocateState();
    case 562: {
      const handle = words.getInt32(4, true);
      weapons.freeState(handle);
      return 0;
    }
    case 563: {
      const handle = words.getInt32(4, true);
      weapons.resetState(handle);
      return 0;
    }
    default: return null;
  }
}
