/*
 * Scalar traps from Quake III Arena cl_cgame.c, cl_ui.c and sv_game.c;
 * Q_acos from qcommon/common.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { float32ToBits } from "../core/numeric.ts";

/** Null means this trap belongs to another service, not a successful zero result. */
export function qvmMathSyscall(role: "game" | "cgame" | "ui", words: DataView): number | null {
  const trap = words.getInt32(0, true);
  switch (trap) {
    case 103: return float32ToBits(Math.sin(words.getFloat32(4, true))) | 0;
    case 104: return float32ToBits(Math.cos(words.getFloat32(4, true))) | 0;
    case 105: return float32ToBits(Math.atan2(words.getFloat32(4, true), words.getFloat32(8, true))) | 0;
    case 106: return float32ToBits(Math.sqrt(words.getFloat32(4, true))) | 0;
    case 107:
      return role === "game" ? null : float32ToBits(Math.floor(words.getFloat32(4, true))) | 0;
    case 108:
      return role === "game" ? null : float32ToBits(Math.ceil(words.getFloat32(4, true))) | 0;
    case 110:
      return role === "game" ? float32ToBits(Math.floor(words.getFloat32(4, true))) | 0 : null;
    case 111: {
      if (role === "ui") return null;
      if (role === "game") return float32ToBits(Math.ceil(words.getFloat32(4, true))) | 0;
      const angle = Math.fround(Math.acos(words.getFloat32(4, true)));
      // Source clamps the result, not the input, and returns +PI for either end.
      return float32ToBits(angle > Math.PI || angle < -Math.PI ? Math.PI : angle) | 0;
    }
    default: return null;
  }
}
