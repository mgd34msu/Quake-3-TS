/*
 * Vector traps from Quake III Arena sv_game.c and game/q_math.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { angleVectors, dot3, perpendicularVector, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { QvmMemory } from "./memory.ts";

function readVector(view: DataView): Vec3 {
  return vec3(view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true));
}

function writeVector(view: DataView, value: Vec3): void {
  view.setFloat32(0, value.x, true);
  view.setFloat32(4, value.y, true);
  view.setFloat32(8, value.z, true);
}

function optionalVector(memory: QvmMemory, word: number): DataView | null {
  return word === 0 ? null : memory.view(word, 12);
}

/**
 * Host SSE binary32 profile, with the double M_PI angle constant and no FMA.
 * These are engine calls, not the q3lcc arithmetic in core/qvm-math.ts.
 * Required spans preflight before writes; null means another service owns the trap.
 */
export function qvmVectorSyscall(
  role: "game" | "cgame" | "ui",
  words: DataView,
  memory: QvmMemory,
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 107: {
      const left = memory.view(words.getInt32(4, true), 36);
      const right = memory.view(words.getInt32(8, true), 36);
      const output = memory.view(words.getInt32(12, true), 36);
      // C has no restrict here. Each assignment can change later input reads.
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
          const a = vec3(
            left.getFloat32(row * 12, true),
            left.getFloat32(row * 12 + 4, true),
            left.getFloat32(row * 12 + 8, true),
          );
          const b = vec3(
            right.getFloat32(column * 4, true),
            right.getFloat32(column * 4 + 12, true),
            right.getFloat32(column * 4 + 24, true),
          );
          output.setFloat32(row * 12 + column * 4, dot3(a, b), true);
        }
      }
      return 0;
    }
    case 108: {
      const angles = memory.view(words.getInt32(4, true), 12);
      const forward = optionalVector(memory, words.getInt32(8, true));
      const right = optionalVector(memory, words.getInt32(12, true));
      const up = optionalVector(memory, words.getInt32(16, true));
      // Source captures every angle before publishing forward, right, then up.
      const result = angleVectors(readVector(angles));
      if (forward !== null) writeVector(forward, result.forward);
      if (right !== null) writeVector(right, result.right);
      if (up !== null) writeVector(up, result.up);
      return 0;
    }
    case 109: {
      const destination = memory.view(words.getInt32(4, true), 12);
      const source = readVector(memory.view(words.getInt32(8, true), 12));
      // q_math.c's non-Q3_VM assertion rejects a zero projection denominator.
      // As in the source, callers supply a normalized vector; NaN is not zero.
      if (dot3(source, source) === 0) {
        throw new RangeError("QVM PerpendicularVector has a zero projection denominator");
      }
      writeVector(destination, perpendicularVector(source));
      return 0;
    }
    default: return null;
  }
}
