/*
 * Ported from id Software's code/game/bg_lib.c and q_shared.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qRand } from "../core/numeric.ts";

export interface GameFloatScan {
  readonly value: number;
  readonly nextOffset: number;
}

/** A byte string owns its terminating NUL, but no adjacent VM memory. */
class NumberInput {
  offset: number;

  constructor(readonly text: string, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
      throw new RangeError("Game number cursor is outside its backing string");
    }
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) > 255) throw new RangeError("Game numbers require byte characters");
    }
    this.offset = offset;
  }

  byte(): number {
    if (this.offset > this.text.length) throw new RangeError("Game number scan reads beyond its backing string");
    if (this.offset === this.text.length) return 0;
    const byte = this.text.charCodeAt(this.offset);
    return byte < 128 ? byte : byte - 256;
  }

  take(): number {
    const byte = this.byte();
    this.offset++;
    return byte;
  }

  skipWhitespace(): void {
    while (this.byte() <= 32 && this.byte() !== 0) this.offset++;
  }

  sign(): number {
    const byte = this.byte();
    if (byte !== 43 && byte !== 45) return 1;
    this.offset++;
    return byte === 45 ? -1 : 1;
  }
}

function readFloat(input: NumberInput, mode: "scalar" | "scan"): number {
  input.skipWhitespace();
  if (input.byte() === 0) return 0;
  const sign = input.sign();
  let value = 0, character = mode === "scalar" ? input.byte() : 48;
  if (input.byte() !== 46) {
    while (true) {
      character = input.take();
      if (character < 48 || character > 57) break;
      value = Math.fround(Math.fround(value * 10) + (character - 48));
    }
  } else if (mode === "scalar") input.offset++;

  if (character === 46) {
    let fraction = Math.fround(0.1);
    while (true) {
      character = input.take();
      if (character < 48 || character > 57) break;
      value = Math.fround(value + Math.fround((character - 48) * fraction));
      fraction = Math.fround(fraction * Math.fround(0.1));
    }
  }
  return Math.fround(value * sign);
}

/** bg_lib atof: decimal prefix only; lcc emits separate binary32 MULF/ADDF operations. */
export function gameAtof(text: string): number {
  return readFloat(new NumberInput(text), "scalar");
}

/** bg_lib atoi: wrap every integer digit operation, including inputs beyond JS precision. */
export function gameAtoi(text: string): number {
  const input = new NumberInput(text);
  input.skipWhitespace();
  if (input.byte() === 0) return 0;
  const sign = input.sign();
  let value = 0;
  while (true) {
    const character = input.take();
    if (character < 48 || character > 57) break;
    value = (Math.imul(value, 10) + character - 48) | 0;
  }
  return Math.imul(value, sign);
}

/**
 * bg_lib _atof consumes the first delimiter, even NUL, and leaves a leading dot.
 * The pinned/baseq3 c='0' initialization stabilizes missionpack's stale-stack case.
 * Reads outside the supplied string are rejected instead of borrowing VM memory.
 */
export function scanGameFloat(text: string, offset = 0): GameFloatScan {
  const input = new NumberInput(text, offset);
  const value = readFloat(input, "scan");
  return { value, nextOffset: input.offset };
}

/** QVM sscanf("%f %f %f") always writes all three destinations. */
export function scanGameVector(text: string): Vec3 {
  const input = new NumberInput(text);
  const x = readFloat(input, "scan"), y = readFloat(input, "scan"), z = readFloat(input, "scan");
  return vec3(x, y, z);
}

/** Instance-owned bg_lib rand/srand and game random/crandom, distinct from Q_random. */
export class GameRandom {
  #seed = 0;

  constructor(seed = 0) { this.reset(seed); }

  get seed(): number { return this.#seed; }

  reset(seed: number): void {
    if (!Number.isSafeInteger(seed)) throw new RangeError("Game random seed must be a safe integer");
    this.#seed = seed | 0;
  }

  rand(): number {
    this.#seed = qRand(this.#seed);
    return this.#seed & 0x7fff;
  }

  random(): number { return Math.fround(this.rand() / 0x7fff); }

  crandom(): number { return Math.fround(2 * Math.fround(this.random() - 0.5)); }
}
