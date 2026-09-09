import { describe, expect, test } from "bun:test";

import {
  bitsToFloat32,
  float32,
  float32ToBits,
  int32,
  qCrandom,
  qRand,
  qRandom,
  qvmFloatToInt,
  uint32,
} from "../src/core/numeric.ts";

describe("32-bit numeric storage", () => {
  test("QVM float-to-int matches actual CVFI4 bit fixtures without changing integer wrap", () => {
    // Original vm_game=1 interpreter, weapon reference CVFI0..16. Output encoded as two uint16 halves.
    const cases: readonly (readonly [number, number])[] = [[0,0],[0x80000000,0],[0x3f7fffff,0],[0xbf7fffff,0],
      [0x3fc00000,1],[0xbfc00000,-1],[0x4effffff,2147483520],[0xceffffff,-2147483520],
      [0x4f000000,-2147483648],[0xcf000000,-2147483648],[0x4f800000,-2147483648],[0xcf800000,-2147483648],
      [0x7f800000,-2147483648],[0xff800000,-2147483648],[0x7fc00000,-2147483648],[1,0],[0x80000001,0]];
    for (const [bits, expected] of cases) {
      const result = qvmFloatToInt(bitsToFloat32(bits));
      expect(result).toBe(expected); expect(Object.is(result, -0)).toBe(false);
    }
    expect(qvmFloatToInt(16777217)).toBe(16777216);
    expect(qvmFloatToInt(2147483583)).toBe(2147483520);
    expect(qvmFloatToInt(2147483584)).toBe(-2147483648);
    expect(qvmFloatToInt(-2147483649)).toBe(-2147483648);
    expect(int32(4294967296)).toBe(0); expect(qvmFloatToInt(4294967296)).toBe(-2147483648);
  });
  test("wraps signed and unsigned integers like C 32-bit values", () => {
    expect(int32(0xffff_ffff)).toBe(-1);
    expect(int32(0x8000_0000)).toBe(-2_147_483_648);
    expect(int32(4_294_967_297)).toBe(1);
    expect(int32(-1.75)).toBe(-1);

    expect(uint32(-1)).toBe(0xffff_ffff);
    expect(uint32(4_294_967_297)).toBe(1);
    expect(uint32(-1.75)).toBe(0xffff_ffff);
  });

  test("rounds at binary32 boundaries", () => {
    expect(float32(0.1)).toBe(0.10000000149011612);
    expect(float32(2 ** 128)).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(float32(-0), -0)).toBe(true);
  });

  test("converts binary32 bit patterns in both directions", () => {
    expect(float32ToBits(1)).toBe(0x3f80_0000);
    expect(float32ToBits(-0)).toBe(0x8000_0000);
    expect(float32ToBits(Number.POSITIVE_INFINITY)).toBe(0x7f80_0000);
    expect(bitsToFloat32(0x3f80_0000)).toBe(1);
    expect(Object.is(bitsToFloat32(0x8000_0000), -0)).toBe(true);
    expect(bitsToFloat32(0x7f80_0000)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(bitsToFloat32(0x7fc0_0000))).toBe(true);
  });
});

describe("Quake seeded random", () => {
  test("matches the q_math.c signed seed sequence", () => {
    const expected = [
      1,
      69_070,
      475_628_535,
      -1_017_563_188,
      772_999_773,
      -417_135_238,
      -473_131_853,
      1_662_200_408,
    ];
    let seed = 0;
    for (const next of expected) {
      seed = qRand(seed);
      expect(seed).toBe(next);
    }
  });

  test("returns the updated seed and low-16-bit Q_random fraction", () => {
    expect(qRandom(0)).toEqual({ seed: 1, value: 1 / 65_536 });
    expect(qRandom(1)).toEqual({ seed: 69_070, value: 3_534 / 65_536 });

    const wrapped = qRandom(475_628_535);
    expect(wrapped.seed).toBe(-1_017_563_188);
    expect(wrapped.value).toBe(14_284 / 65_536);
  });

  test("maps Q_random to Q_crandom's [-1, 1) interval", () => {
    expect(qCrandom(0)).toEqual({
      seed: 1,
      value: -0.999969482421875,
    });
    expect(qCrandom(69_070)).toEqual({
      seed: 475_628_535,
      value: 0.030975341796875,
    });
  });
});
