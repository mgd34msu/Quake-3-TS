import { describe, expect, test } from "bun:test";

import { vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { inverseSqrt32, normalizeFast3, rendererSine } from "../src/core/renderer-math.ts";
import { evaluateTexCoords, parseShaderScript } from "../src/render/material.ts";
import type { ShaderStage } from "../src/render/material.ts";

function environmentStage(): ShaderStage {
  const shader = parseShaderScript("fixture { { map test tcGen environment } }")[0];
  if (shader === undefined) throw new Error("Missing environment shader fixture");
  const stage = shader.stages[0];
  if (stage === undefined) throw new Error("Missing environment stage fixture");
  return stage;
}

describe("renderer source math integration", () => {
  test("environment mapping uses float32 DotProduct before Q_rsqrt", () => {
    const result = evaluateTexCoords(
      environmentStage(),
      { x: 0, y: 0 },
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      0,
      { viewOrigin: vec3(1024.2432861328125, -308.6097412109375, -1875.3720703125) },
    );
    expect(result).toEqual({ x: 0.5714577436447144, y: 0.06576260924339294 });
  });
});

describe("tr_init.c renderer sine table", () => {
  test("matches all 1024 native float entries", () => {
    let hash = 2_166_136_261;
    let bitSum = 0n;
    for (let index = 0; index < 1024; index++) {
      const degrees = Math.fround(index * 360 / 1023);
      const expected = Math.fround(Math.sin(degrees * Math.PI / 180));
      const actual = rendererSine(index);
      expect(actual).toBe(expected);

      const bits = float32ToBits(actual);
      bitSum += BigInt(bits);
      for (let shift = 0; shift < 32; shift += 8) {
        hash = Math.imul((hash ^ ((bits >>> shift) & 255)) >>> 0, 16_777_619) >>> 0;
      }
    }
    // Untouched tr_init.c table on GCC x86-64. Hash consumes each float's
    // little-endian bytes; the sum gives an independent aggregate check.
    expect(hash).toBe(0xea8df29e);
    expect(bitSum).toBe(0x1fb9365664cn);
    expect([0, 256, 512, 768, 1023].map(index => float32ToBits(rendererSine(index))))
      .toEqual([0x00000000, 0x3f7fffec, 0xbb4940ec, 0xbf7fff4e, 0xa58d3132]);
  });

  test("wraps signed source indices and rejects values outside C int", () => {
    expect(rendererSine(-1)).toBe(rendererSine(1023));
    expect(rendererSine(1024)).toBe(rendererSine(0));
    expect(() => rendererSine(0.5)).toThrow("signed 32-bit integer");
    expect(() => rendererSine(2_147_483_648)).toThrow("signed 32-bit integer");
  });
});

describe("q_math.c VectorNormalizeFast", () => {
  test("exposes the same scalar inverse for source dot-then-scale specular calculations", () => {
    expect(inverseSqrt32(1)).toBe(0.9983071684837341);
    expect(inverseSqrt32(4)).toBe(0.49915358424186707);
    expect(inverseSqrt32(25)).toBe(0.19968976080417633);
  });
  // The native oracle substitutes int32_t for Q_rsqrt's source `long` alias.
  // That preserves the reference ILP32 layout without invoking x64 long UB.
  test("matches the labelled 32-bit Q_rsqrt oracle", () => {
    expect(normalizeFast3(vec3(3, 4, 0))).toEqual({
      x: 0.5990692973136902,
      y: 0.7987590432167053,
      z: 0,
    });
    expect(normalizeFast3(vec3(
      1024.2432861328125,
      -308.6097412109375,
      -1875.3720703125,
    ))).toEqual({
      x: 0.474321573972702,
      y: -0.1429155170917511,
      z: -0.8684747815132141,
    });
    expect(normalizeFast3(vec3(1e-20, -2e-20, 3e-20))).toEqual({
      x: 0.1757265329360962,
      y: -0.3514530658721924,
      z: 0.5271795988082886,
    });
  });

  test("does not special-case a zero vector and preserves its component signs", () => {
    expect(normalizeFast3(vec3(0, -0, 0))).toEqual({ x: 0, y: -0, z: 0 });
  });
});
