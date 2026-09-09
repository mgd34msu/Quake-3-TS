/*
 * Translated numeric semantics from Quake III Arena's q_math.c, q_shared.h,
 * and qcommon/vm_interpreted.c OP_CVFI.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface RandomStep {
  readonly seed: number;
  readonly value: number;
}

/** Converts a JavaScript number with C-style signed 32-bit wraparound. */
export function int32(value: number): number {
  return value | 0;
}

/** Converts a JavaScript number with C-style unsigned 32-bit wraparound. */
export function uint32(value: number): number {
  return value >>> 0;
}

/** Rounds a number to the nearest representable IEEE-754 binary32 value. */
export function float32(value: number): number {
  return Math.fround(value);
}

/** QVM CVFI4 consumes binary32 and returns INT_MIN for NaN and out-of-range input. */
export function qvmFloatToInt(value: number): number {
  const stored = Math.fround(value);
  return stored >= -2147483648 && stored < 2147483648 ? Math.trunc(stored) + 0 : -2147483648;
}

export function float32ToBits(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

export function bitsToFloat32(bits: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, uint32(bits), true);
  return view.getFloat32(0, true);
}

/** Returns the updated seed produced by Quake's Q_rand. */
export function qRand(seed: number): number {
  return int32(Math.imul(69069, int32(seed)) + 1);
}

/** Performs one Q_rand update and returns Quake's [0, 1) random fraction. */
export function qRandom(seed: number): RandomStep {
  const nextSeed = qRand(seed);
  return {
    seed: nextSeed,
    value: (nextSeed & 0xffff) / 0x10000,
  };
}

/** Performs one Q_rand update and returns Quake's [-1, 1) random fraction. */
export function qCrandom(seed: number): RandomStep {
  const step = qRandom(seed);
  return {
    seed: step.seed,
    value: 2 * (step.value - 0.5),
  };
}
