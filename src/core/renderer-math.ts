/*
 * Renderer lookup and fast-normalization math translated from id Software's
 * code/renderer/tr_init.c and code/game/q_math.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { dot3, scale3 } from "./math.ts";
import type { Vec3 } from "./math.ts";
import { bitsToFloat32, float32ToBits, int32 } from "./numeric.ts";

const FUNCTION_TABLE_SIZE = 1024;
const FUNCTION_TABLE_MASK = FUNCTION_TABLE_SIZE - 1;
const sineTable = Array.from({ length: FUNCTION_TABLE_SIZE }, (_, index) => {
  const degrees = Math.fround(index * 360 / (FUNCTION_TABLE_SIZE - 1));
  return Math.fround(Math.sin(degrees * Math.PI / 180));
});

/** Returns tr.sinTable[index & FUNCTABLE_MASK]. */
export function rendererSine(index: number): number {
  if (!Number.isSafeInteger(index) || index !== int32(index)) {
    throw new RangeError("renderer sine index must be a signed 32-bit integer");
  }
  const value = sineTable[index & FUNCTION_TABLE_MASK];
  if (value === undefined) {
    throw new Error("renderer sine table is incomplete");
  }
  return value;
}

/** q_math.c Q_rsqrt with the original 32-bit alias and one refinement. */
export function inverseSqrt32(square: number): number {
  square = Math.fround(square);
  const sourceBits = int32(float32ToBits(square));
  const approximateBits = int32(0x5f3759df - (sourceBits >> 1));
  let inverse = bitsToFloat32(approximateBits);
  const halfSquare = Math.fround(square * 0.5);
  const halfTimesInverse = Math.fround(halfSquare * inverse);
  const correctionProduct = Math.fround(halfTimesInverse * inverse);
  const correction = Math.fround(1.5 - correctionProduct);
  inverse = Math.fround(inverse * correction);
  return inverse;
}

/** q_math.c VectorNormalizeFast with the original single Q_rsqrt iteration. */
export function normalizeFast3(value: Vec3): Vec3 {
  return scale3(value, inverseSqrt32(dot3(value, value)));
}
