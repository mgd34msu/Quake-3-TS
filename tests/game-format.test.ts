import { describe, expect, test } from "bun:test";

import { gameFormat } from "../src/game/format.ts";

// Golden strings were emitted by untouched bg_lib.c at source commit
// dbe4ddb10315479fc00086f08e25d968b4b43c49, compiled with the pinned Q3 LCC
// and q3asm toolchain and executed by the original 32-bit QVM interpreter.
describe("bg_lib.c game formatting", () => {
  test("formats literals, percent, characters, and signed decimal integers", () => {
    expect(gameFormat("score %d/%i %c %%", [12, -7, 65])).toBe("score 12/-7 A %");
    expect(gameFormat("%d", [-2_147_483_648])).toBe("-./,),(-*,(");
  });

  test("uses source integer padding and sign order", () => {
    expect(gameFormat("[%5d][%05d][%-5d][%-05d]", [12, -12, 12, 12]))
      .toBe("[   12][00-12][12   ][12000]");
  });

  test("truncates float digits with float32 operations and counts only the integer for width", () => {
    expect(gameFormat(
      "[%f][%.8f][%8.2f][%08.2f][%.0f]",
      [2.67, 3.12456789, -12.345, -12.345, 1.9],
    )).toBe("[2.670000][3.12456798][     -12.34][     -12.34][1]");
    expect(gameFormat("[%f][%.8f][%.8f]", [-0, 1.345, 3.134]))
      .toBe("[0.000000][1.34500002][3.13400006]");
  });

  test("right-pads strings, truncates by precision, and expands null regardless of precision", () => {
    expect(gameFormat("[%5s][%-5s][%05.2s][%2.3s]", ["ab", "ab", "abcd", null]))
      .toBe("[ab   ][ab   ][ab   ][(null)]");
  });

  test("preserves defined unknown-specifier and integer-wrap behavior", () => {
    expect(gameFormat("%q/%*d/%%", [65, 66])).toBe("A/Bd/%");
    expect(gameFormat("[%2147483648d][%.2147483648f]", [7, 1.25]))
      .toBe("[7][1.250000]");
  });

  test("treats strings as NUL-terminated byte sequences", () => {
    expect(gameFormat("before\0%d", [])).toBe("before");
    expect(gameFormat("%s", ["two\0ignored\u{100}"])).toBe("two");
    expect(gameFormat("%cignored", [256])).toBe("");
    expect(gameFormat("%c", [255])).toBe("\u00ff");
    expect(() => gameFormat("%s", ["not-byte-\u{100}"])).toThrow("byte-valued");
    expect(() => gameFormat("not-byte-\u{100}", [])).toThrow("byte-valued");
  });
});

describe("Com_sprintf bounds and unsafe source cases", () => {
  test("uses destination capacity including the trailing NUL", () => {
    expect(gameFormat("abcdef", [], 7)).toBe("abcdef");
    expect(gameFormat("abcdef", [], 4)).toBe("abc");
    expect(gameFormat("abcdef", [], 1)).toBe("");
    expect(() => gameFormat("x", [], 0)).toThrow("positive safe integer");
    expect(() => gameFormat("x", [], -1)).toThrow("positive safe integer");
    expect(() => gameFormat("x", [], 1.5)).toThrow("positive safe integer");
  });

  test("accepts the last safe bigbuffer length and rejects its source overflow", () => {
    expect(gameFormat("x".repeat(31_999), [])).toHaveLength(31_999);
    expect(() => gameFormat("x".repeat(32_000), [])).toThrow("32000-byte");
  });

  test("rejects missing or incompatible arguments", () => {
    expect(() => gameFormat("%d", [])).toThrow("missing argument 0");
    expect(() => gameFormat("%d", ["1"])).toThrow("must be a number");
    expect(() => gameFormat("%d", [2_147_483_648])).toThrow("signed 32-bit integer");
    expect(() => gameFormat("%s", [1])).toThrow("string or null");
    expect(() => gameFormat("%f", [null])).toThrow("must be a number");
    expect(gameFormat("literal", ["unused"])).toBe("literal");
  });

  test("rejects parsing and AddFloat operations that overrun source storage", () => {
    expect(() => gameFormat("trailing %", [])).toThrow("unterminated");
    expect(() => gameFormat("%.33f", [1])).toThrow("32-byte digit buffer");
    expect(() => gameFormat("%f", [Number.NaN])).toThrow("safe int-cast range");
    expect(() => gameFormat("%f", [Number.POSITIVE_INFINITY])).toThrow("safe int-cast range");
    expect(() => gameFormat("%f", [2_147_483_648])).toThrow("safe int-cast range");
  });

  test("rejects AddInt's negative left-padding loop", () => {
    expect(() => gameFormat("%-2d", [123])).toThrow("negative padding loop");
    expect(() => gameFormat("%-d", [1])).toThrow("negative padding loop");
  });
});
