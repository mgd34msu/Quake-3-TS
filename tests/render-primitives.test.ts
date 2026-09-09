// Source fixtures for id Software's renderer/tr_shade.c:R_DrawElements/R_DrawStripElements.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { emitSourceTriangleStrips, sourcePrimitiveMode } from "../src/render/primitives.ts";
import type { SourceStripEmitter } from "../src/render/primitives.ts";

type StripCall = "begin" | "end" | number;

function recordStripCalls(indices: readonly number[]): StripCall[] {
  const calls: StripCall[] = [];
  emitSourceTriangleStrips(indices, {
    begin() { calls.push("begin"); },
    element(index) { calls.push(index); },
    end() { calls.push("end"); },
  });
  return calls;
}

describe("source primitive selection", () => {
  test("default follows actual compiled-array availability", () => {
    expect(sourcePrimitiveMode(0, false)).toBe("array-strips");
    expect(sourcePrimitiveMode(0, true)).toBe("elements");
  });

  test("explicit selections do not depend on compiled arrays", () => {
    for (const compiledArrays of [false, true]) {
      expect(sourcePrimitiveMode(1, compiledArrays)).toBe("array-strips");
      expect(sourcePrimitiveMode(2, compiledArrays)).toBe("elements");
      expect(sourcePrimitiveMode(3, compiledArrays)).toBe("discrete-strips");
    }
  });

  test("other values select no drawing without integer coercion", () => {
    for (const compiledArrays of [false, true]) {
      for (const requested of [-2147483648, -2, -1, 4, 2147483647, 0.5, 1.5, 2.5, 3.5, NaN, Infinity, -Infinity])
        expect(sourcePrimitiveMode(requested, compiledArrays)).toBe("none");
    }
  });
});

describe("source triangle strip emission", () => {
  test("empty input performs no callbacks", () => {
    expect(recordStripCalls([])).toEqual([]);
  });

  test("a single triangle preserves order and its provoking vertex", () => {
    expect(recordStripCalls([0, 1, 2])).toEqual(["begin", 0, 1, 2, "end"]);
  });

  test("alternating source orientations form one strip", () => {
    expect(recordStripCalls([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]))
      .toEqual(["begin", 0, 1, 2, 3, 4, 5, "end"]);
  });

  test("a shared edge in the wrong order starts another strip", () => {
    expect(recordStripCalls([0, 1, 2, 0, 2, 3]))
      .toEqual(["begin", 0, 1, 2, "end", "begin", 0, 2, 3, "end"]);
  });

  test("an odd-parity break resets parity and caches the restarted triangle", () => {
    expect(recordStripCalls([0, 1, 2, 7, 8, 9, 9, 8, 10]))
      .toEqual(["begin", 0, 1, 2, "end", "begin", 7, 8, 9, 10, "end"]);
  });

  test("an even-parity break resets parity and caches the restarted triangle", () => {
    expect(recordStripCalls([0, 1, 2, 2, 1, 3, 7, 8, 9, 9, 8, 10]))
      .toEqual(["begin", 0, 1, 2, 3, "end", "begin", 7, 8, 9, 10, "end"]);
  });

  test("repeated and degenerate triangles still submit their elements", () => {
    expect(recordStripCalls([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1]))
      .toEqual(["begin", 0, 0, 0, 0, 1, 1, 1, "end"]);
    expect(recordStripCalls([0, 1, 2, 0, 1, 2]))
      .toEqual(["begin", 0, 1, 2, "end", "begin", 0, 1, 2, "end"]);
  });

  test("uint32 indices pass through without narrowing to an active vertex count", () => {
    expect(recordStripCalls([4294967293, 4294967294, 4294967295, 4294967295, 4294967294, 0]))
      .toEqual(["begin", 4294967293, 4294967294, 4294967295, 0, "end"]);
  });

  test("incomplete triples fail explicitly before emission", () => {
    const calls: StripCall[] = [];
    const emit: SourceStripEmitter = {
      begin() { calls.push("begin"); },
      element(index) { calls.push(index); },
      end() { calls.push("end"); },
    };
    for (const indices of [[0], [0, 1], [0, 1, 2, 3], [0, 1, 2, 3, 4]])
      expect(() => emitSourceTriangleStrips(indices, emit)).toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  test("unallocated triple entries fail instead of supplying undefined elements", () => {
    expect(() => recordStripCalls(new Array<number>(3))).toThrow(RangeError);
    const indices = [0, 1, 2];
    indices.length = 6;
    expect(() => recordStripCalls(indices)).toThrow(RangeError);
  });
});
