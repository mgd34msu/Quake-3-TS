/*
 * Key traps from Quake III Arena client/cl_ui.c and client/cl_cgame.c.
 * Key state remains owned by the translated client/cl_keys.c implementation.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { keynumToString } from "../engine/client-keys.ts";
import type { ClientKeys } from "../engine/client-keys.ts";
import type { QvmMemory } from "./memory.ts";

export function qvmKeySyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, keys: ClientKeys,
): number | Promise<number> | null {
  if (role === "game") return null;
  const trap = words.getInt32(0, true);
  if (role === "cgame") {
    switch (trap) {
      case 60: return keys.isDown(words.getInt32(4, true)) ? 1 : 0;
      case 61: return keys.getCatcher();
      case 62: keys.setCatcher(words.getInt32(4, true)); return 0;
      case 63: {
        const pointer = words.getInt32(4, true);
        return keys.getKey(pointer === 0 ? null : memory.readString(pointer));
      }
      default: return null;
    }
  }
  switch (trap) {
    case 33: {
      const key = words.getInt32(4, true), destination = words.getInt32(8, true), capacity = words.getInt32(12, true);
      memory.writeString(destination, keynumToString(key), capacity);
      return 0;
    }
    case 34: {
      const key = words.getInt32(4, true), destination = words.getInt32(8, true), capacity = words.getInt32(12, true);
      const binding = keys.getBinding(key);
      // The source null-binding branch ignores capacity and writes only *buf.
      if (binding === null) memory.view(destination, 1).setUint8(0, 0);
      else memory.writeString(destination, binding, capacity);
      return 0;
    }
    case 35: {
      const key = words.getInt32(4, true), pointer = words.getInt32(8, true);
      keys.setBinding(key, key === -1 ? "" : memory.readString(pointer));
      return 0;
    }
    case 36: return keys.isDown(words.getInt32(4, true)) ? 1 : 0;
    case 37: return keys.getOverstrikeMode();
    case 38: keys.setOverstrikeMode(words.getInt32(4, true)); return 0;
    case 39: return keys.clearStates().then(() => 0);
    case 40: return keys.getCatcher();
    case 41: keys.setCatcher(words.getInt32(4, true)); return 0;
    default: return null;
  }
}
