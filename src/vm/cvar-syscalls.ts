/*
 * Cvar traps from Quake III Arena sv_game.c, cl_cgame.c and cl_ui.c;
 * vmCvar_t registration/update and value formatting from qcommon/cvar.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { CvarVmStringError } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { float32ToBits } from "../core/numeric.ts";
import type { QvmMemory } from "./memory.ts";

function update(pointer: number, memory: QvmMemory, cvars: CvarRegistry): void {
  const record = memory.view(pointer, 272);
  const source = cvars.readVm(record.getInt32(0, true));
  if (source === undefined || source.modificationCount === record.getInt32(4, true)) return;
  record.setInt32(4, source.modificationCount, true);
  if (source.value.length > 255) throw new CvarVmStringError(source.value);
  const text = new Uint8Array(record.buffer, record.byteOffset + 16, 256);
  text.fill(0);
  for (let index = 0; index < source.value.length; index++) text[index] = source.value.charCodeAt(index);
  record.setFloat32(8, source.numericValue, true);
  record.setInt32(12, source.integerValue, true);
}

function register(words: DataView, memory: QvmMemory, cvars: CvarRegistry): void {
  const pointer = words.getInt32(4, true);
  const handle = cvars.bindVm(memory.readString(words.getInt32(8, true)),
    memory.readString(words.getInt32(12, true)), words.getInt32(16, true));
  if (memory.pointer(pointer) === null) return;
  const record = memory.view(pointer, 272);
  record.setInt32(0, handle, true);
  record.setInt32(4, -1, true);
  update(pointer, memory, cvars);
}

function set(words: DataView, memory: QvmMemory, cvars: CvarRegistry): void {
  const name = memory.readString(words.getInt32(4, true));
  const pointer = words.getInt32(8, true);
  if (memory.pointer(pointer) === null) cvars.reset(name, true);
  else cvars.set(name, memory.readString(pointer), true);
}

function variableString(words: DataView, memory: QvmMemory, cvars: CvarRegistry): void {
  const source = cvars.get(memory.readString(words.getInt32(4, true)));
  const pointer = words.getInt32(8, true);
  // Cvar_VariableStringBuffer's missing-name branch ignores the capacity.
  if (source === undefined) memory.view(pointer, 1).setUint8(0, 0);
  else memory.writeString(pointer, source.value, words.getInt32(12, true));
}

/** Trap numbers come from g_public.h, cg_public.h and ui_public.h. */
export function qvmCvarSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, cvars: CvarRegistry,
): number | null {
  const trap = words.getInt32(0, true);
  if (role !== "ui") {
    switch (trap) {
      case 3: register(words, memory, cvars); return 0;
      case 4: update(words.getInt32(4, true), memory, cvars); return 0;
      case 5: set(words, memory, cvars); return 0;
      case 6: {
        if (role === "cgame") { variableString(words, memory, cvars); return 0; }
        const source = cvars.get(memory.readString(words.getInt32(4, true)));
        return source === undefined ? 0 : source.integerValue;
      }
      case 7:
        if (role === "cgame") return null;
        variableString(words, memory, cvars); return 0;
      default: return null;
    }
  }
  switch (trap) {
    case 3: set(words, memory, cvars); return 0;
    case 4: {
      const source = cvars.get(memory.readString(words.getInt32(4, true)));
      return float32ToBits(source === undefined ? 0 : source.numericValue) | 0;
    }
    case 5: variableString(words, memory, cvars); return 0;
    case 6:
      cvars.setValue(memory.readString(words.getInt32(4, true)), words.getFloat32(8, true));
      return 0;
    case 7: cvars.reset(memory.readString(words.getInt32(4, true))); return 0;
    case 8:
      cvars.register(memory.readString(words.getInt32(4, true)), memory.readString(words.getInt32(8, true)),
        words.getInt32(12, true));
      return 0;
    case 9: {
      const flags = words.getInt32(4, true), destination = words.getInt32(8, true), capacity = words.getInt32(12, true);
      memory.writeString(destination, cvars.infoString(flags), capacity);
      return 0;
    }
    case 50: register(words, memory, cvars); return 0;
    case 51: update(words.getInt32(4, true), memory, cvars); return 0;
    default: return null;
  }
}
