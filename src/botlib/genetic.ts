/*
 * Genetic bot selection translated from id Software's
 * code/botlib/be_ai_gen.c and code/game/be_ai_gen.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { BotRandom } from "./weights.ts";

const MAX_RANKS = 256;
const INT32_MIN = -0x8000_0000;
const UINT32_MAX = 0xffff_ffff;
const RANDOM_MASK = 0x7fff;

export type GeneticSelectionResult =
  | {
    readonly kind: "selected";
    readonly parent1: number;
    readonly parent2: number;
    readonly child: number;
  }
  | {
    readonly kind: "error";
    readonly reason:
      | "too-many-ranks"
      | "too-few-valid-ranks"
      | "undefined-random-index";
  };

type RankSelectionResult =
  | { readonly kind: "selected"; readonly index: number }
  | { readonly kind: "undefined-random-index" };

export interface GeneticSelectionRequest {
  readonly count: number;
  readonly rank: (index: number) => number;
  readonly write: (target: "parent1" | "parent2" | "child", value: number) => void;
}

export type GeneticSelectionInput = readonly number[] | GeneticSelectionRequest;

function rankAt(rankings: readonly number[], index: number): number {
  const ranking = rankings[index];
  if (ranking === undefined) {
    throw new RangeError(`rank index ${index} is outside ${rankings.length} entries`);
  }
  return ranking;
}

function sourceUnitRandom(random: BotRandom): number {
  const raw = random.nextInt();
  if (!Number.isInteger(raw) || raw < INT32_MIN || raw > UINT32_MAX) {
    throw new RangeError("bot random nextInt must return an int32 or uint32 value");
  }
  return Math.fround((raw & RANDOM_MASK) / Math.fround(RANDOM_MASK));
}

function consumeUnusedWeightedDraw(random: BotRandom, sum: number): void {
  Math.fround(sourceUnitRandom(random) * sum);
}

function selectRank(rankings: readonly number[], random: BotRandom): RankSelectionResult {
  let sum = 0;
  for (const ranking of rankings) {
    if (ranking < 0) {
      continue;
    }
    sum = Math.fround(sum + ranking);
  }

  if (sum > 0) {
    // The source computes this threshold but never uses it.
    consumeUnusedWeightedDraw(random, sum);
    for (let index = 0; index < rankings.length; index++) {
      const ranking = rankAt(rankings, index);
      if (ranking < 0) {
        continue;
      }
      sum = Math.fround(sum - ranking);
      if (sum <= 0) {
        return { kind: "selected", index };
      }
    }
  }

  const scaledIndex = Math.fround(
    sourceUnitRandom(random) * Math.fround(rankings.length),
  );
  let index = Math.trunc(scaledIndex);
  if (index === rankings.length) {
    return { kind: "undefined-random-index" };
  }
  for (let count = 0; count < rankings.length; count++) {
    if (rankAt(rankings, index) >= 0) {
      return { kind: "selected", index };
    }
    index = (index + 1) % rankings.length;
  }
  return { kind: "selected", index: 0 };
}

export function geneticParentsAndChildSelection(
  ranks: GeneticSelectionInput,
  random: BotRandom,
  warning?: (text: string) => void,
): GeneticSelectionResult {
  const count = "count" in ranks ? ranks.count : ranks.length;
  if (!Number.isInteger(count) || count < INT32_MIN || count > 0x7fff_ffff) {
    throw new RangeError("genetic rank count must be an int32");
  }
  const readRank = (index: number): number => Math.fround(
    "count" in ranks ? ranks.rank(index) : rankAt(ranks, index),
  );
  const write = (target: "parent1" | "parent2" | "child", value: number): void => {
    if ("count" in ranks) ranks.write(target, value);
  };
  if (count > MAX_RANKS) {
    warning?.("GeneticParentsAndChildSelection: too many bots\n");
    write("child", 0);
    write("parent2", 0);
    write("parent1", 0);
    return { kind: "error", reason: "too-many-ranks" };
  }

  let validCount = 0;
  for (let index = 0; index < count; index++) {
    if (readRank(index) < 0) {
      continue;
    }
    validCount++;
  }
  if (validCount < 3) {
    warning?.("GeneticParentsAndChildSelection: too few valid bots\n");
    write("child", 0);
    write("parent2", 0);
    write("parent1", 0);
    return { kind: "error", reason: "too-few-valid-ranks" };
  }
  const rankings: number[] = [];
  for (let index = 0; index < count; index++) rankings.push(readRank(index));

  const firstParent = selectRank(rankings, random);
  if (firstParent.kind === "undefined-random-index") {
    return { kind: "error", reason: firstParent.kind };
  }
  write("parent1", firstParent.index);
  rankings[firstParent.index] = -1;

  const secondParent = selectRank(rankings, random);
  if (secondParent.kind === "undefined-random-index") {
    return { kind: "error", reason: secondParent.kind };
  }
  write("parent2", secondParent.index);
  rankings[secondParent.index] = -1;

  let maximum = 0;
  for (const ranking of rankings) {
    if (ranking < 0) {
      continue;
    }
    if (ranking > maximum) {
      maximum = ranking;
    }
  }
  for (let index = 0; index < rankings.length; index++) {
    const ranking = rankAt(rankings, index);
    if (ranking < 0) {
      continue;
    }
    rankings[index] = Math.fround(maximum - ranking);
  }

  const child = selectRank(rankings, random);
  if (child.kind === "undefined-random-index") {
    return { kind: "error", reason: child.kind };
  }
  write("child", child.index);
  return {
    kind: "selected",
    parent1: firstParent.index,
    parent2: secondParent.index,
    child: child.index,
  };
}
