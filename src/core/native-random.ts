/*
 * Instance-owned translation of glibc's default TYPE_3 rand/srand state.
 * Copyright (C) Free Software Foundation, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

const DEGREE = 31;
const SEPARATION = 3;
const UINT32_MAX = 0xffff_ffff;
const PARK_MILLER_MODULUS = 2_147_483_647;

function requireSeed(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError("native random seed must be an unsigned 32-bit integer");
  }
}

/** Linux glibc rand/srand using the default 128-byte TYPE_3 state profile. */
export class LinuxNativeRandom {
  private readonly state = new Int32Array(DEGREE);
  private front = SEPARATION;
  private rear = 0;

  constructor(initialSeed: number) {
    this.seed(initialSeed);
  }

  seed(value: number): void {
    requireSeed(value);
    const sourceSeed = value === 0 ? 1 : value;
    let word = sourceSeed | 0;
    this.state[0] = word;
    for (let index = 1; index < DEGREE; index++) {
      const quotient = Math.trunc(word / 127_773);
      const remainder = word % 127_773;
      word = 16_807 * remainder - 2_836 * quotient;
      if (word < 0) word += PARK_MILLER_MODULUS;
      this.state[index] = word;
    }

    this.front = SEPARATION;
    this.rear = 0;
    for (let index = 0; index < DEGREE * 10; index++) this.nextValue();
  }

  next(): number {
    return this.nextValue();
  }

  private stateValue(index: number): number {
    const value = this.state[index];
    if (value === undefined) throw new Error(`native random state index ${index} is unavailable`);
    return value;
  }

  private nextValue(): number {
    const sum = (this.stateValue(this.front) + (this.stateValue(this.rear) >>> 0)) >>> 0;
    this.state[this.front] = sum | 0;
    const result = sum >>> 1;

    this.front++;
    if (this.front >= DEGREE) {
      this.front = 0;
      this.rear++;
    } else {
      this.rear++;
      if (this.rear >= DEGREE) this.rear = 0;
    }
    return result;
  }
}
