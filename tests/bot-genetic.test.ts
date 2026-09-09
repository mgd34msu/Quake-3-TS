import { describe, expect, test } from "bun:test";

import { geneticParentsAndChildSelection } from "../src/botlib/genetic.ts";
import type { BotRandom } from "../src/botlib/weights.ts";

class SequenceRandom implements BotRandom {
  private readonly values: readonly number[];
  private position = 0;

  constructor(values: readonly number[]) {
    this.values = values;
  }

  get calls(): number {
    return this.position;
  }

  nextInt(): number {
    const value = this.values[this.position];
    if (value === undefined) {
      throw new Error("genetic random fixture exhausted");
    }
    this.position++;
    return value;
  }
}

// Golden outputs from untouched be_ai_gen.c at source commit
// dbe4ddb10315479fc00086f08e25d968b4b43c49. GCC oracle and output:
// /tmp/q3-bot-genetic-oracle-VV1DMn/fixture.c and output.log.
describe("GeneticParentsAndChildSelection native fixtures", () => {
  test("preserves the source's weighted selection order and exclusions", () => {
    const standardRandom = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection([10, 20, 30, 40], standardRandom)).toEqual({
      kind: "selected",
      parent1: 3,
      parent2: 2,
      child: 0,
    });
    expect(standardRandom.calls).toBe(3);

    const sparseRandom = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection([5, -1, 5, 0, -2, 2], sparseRandom)).toEqual({
      kind: "selected",
      parent1: 5,
      parent2: 2,
      child: 3,
    });
    expect(sparseRandom.calls).toBe(3);
  });

  test("uses the inclusive 32767 denominator for zero ranks and cyclic fallback", () => {
    const zeroRandom = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection([0, 0, 0, 0], zeroRandom)).toEqual({
      kind: "selected",
      parent1: 0,
      parent2: 2,
      child: 3,
    });

    const maskedRandom = new SequenceRandom([32_768, 49_152, 65_534]);
    expect(geneticParentsAndChildSelection([0, 0, 0, 0], maskedRandom)).toEqual({
      kind: "selected",
      parent1: 0,
      parent2: 2,
      child: 3,
    });

    const wrappedRandom = new SequenceRandom([8_192, 8_192, 8_192]);
    expect(geneticParentsAndChildSelection([0, -1, 0, 0], wrappedRandom)).toEqual({
      kind: "selected",
      parent1: 2,
      parent2: 3,
      child: 0,
    });
    expect(wrappedRandom.calls).toBe(3);
  });

  test("reverses tied parent ranks to zero before choosing the child", () => {
    const random = new SequenceRandom([123, 456, 0]);
    expect(geneticParentsAndChildSelection([5, 5, 5, 5], random)).toEqual({
      kind: "selected",
      parent1: 3,
      parent2: 2,
      child: 0,
    });
    expect(random.calls).toBe(3);
  });

  test("matches source comparisons for signed zero, NaN, and infinity", () => {
    const signedZeroRandom = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection([-0, 0, 0], signedZeroRandom)).toEqual({
      kind: "selected",
      parent1: 0,
      parent2: 1,
      child: 2,
    });

    const nanRandom = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection([Number.NaN, 1, 2, 3], nanRandom)).toEqual({
      kind: "selected",
      parent1: 1,
      parent2: 2,
      child: 3,
    });

    const allNanRandom = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection(
      [Number.NaN, Number.NaN, Number.NaN],
      allNanRandom,
    )).toEqual({ kind: "selected", parent1: 0, parent2: 0, child: 0 });

    const infinityRandom = new SequenceRandom([0, 0, 123, 0]);
    expect(geneticParentsAndChildSelection(
      [Number.POSITIVE_INFINITY, 1, 2],
      infinityRandom,
    )).toEqual({ kind: "selected", parent1: 0, parent2: 2, child: 1 });
    expect(infinityRandom.calls).toBe(4);
  });

  test("returns source errors without consuming random values", () => {
    const cases: readonly (readonly number[])[] = [
      [],
      [1, 2],
      [1, -1, -2, 2],
      [-1, -2, -3],
    ];
    for (const ranks of cases) {
      const random = new SequenceRandom([]);
      expect(geneticParentsAndChildSelection(ranks, random)).toEqual({
        kind: "error",
        reason: "too-few-valid-ranks",
      });
      expect(random.calls).toBe(0);
    }

    const random = new SequenceRandom([]);
    expect(geneticParentsAndChildSelection(new Array<number>(257).fill(1), random)).toEqual({
      kind: "error",
      reason: "too-many-ranks",
    });
    expect(random.calls).toBe(0);
  });

  test("accepts the source maximum of 256 ranks", () => {
    const ranks = new Array<number>(256).fill(-1);
    ranks[253] = 1;
    ranks[254] = 2;
    ranks[255] = 3;
    const random = new SequenceRandom([0, 16_384, 32_766]);
    expect(geneticParentsAndChildSelection(ranks, random)).toEqual({
      kind: "selected",
      parent1: 255,
      parent2: 254,
      child: 253,
    });
    expect(random.calls).toBe(3);
  });

  test("reports the source's undefined one-past random endpoint", () => {
    const immediate = new SequenceRandom([32_767]);
    expect(geneticParentsAndChildSelection([0, 0, 0], immediate)).toEqual({
      kind: "error",
      reason: "undefined-random-index",
    });
    expect(immediate.calls).toBe(1);

    const afterParents = new SequenceRandom([32_767, 32_767, 32_767]);
    expect(geneticParentsAndChildSelection([5, 5, 5], afterParents)).toEqual({
      kind: "error",
      reason: "undefined-random-index",
    });
    expect(afterParents.calls).toBe(3);
  });

  test("independent random owners reproduce the same selection", () => {
    const first = new SequenceRandom([1, 2, 3]);
    const second = new SequenceRandom([1, 2, 3]);
    const firstResult = geneticParentsAndChildSelection([2, 4, 8, 16], first);
    const secondResult = geneticParentsAndChildSelection([2, 4, 8, 16], second);
    expect(firstResult).toEqual(secondResult);
    expect(first.calls).toBe(3);
    expect(second.calls).toBe(3);
  });

  test("validates the injected random boundary", () => {
    expect(() => geneticParentsAndChildSelection(
      [0, 0, 0],
      new SequenceRandom([0.5]),
    )).toThrow(RangeError);
    expect(() => geneticParentsAndChildSelection(
      [0, 0, 0],
      new SequenceRandom([0x1_0000_0000]),
    )).toThrow(RangeError);
  });
});
