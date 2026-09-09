// Draw-surface sorting from id Software renderer/tr_main.c: qsortFast, shortsort.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later

export interface SourceDrawSortRange {
  readonly length: number;
  getSort(index: number): number;
  setSort(index: number, sort: number): void;
  swap(first: number, second: number): void;
}

interface SortInterval {
  readonly lo: number;
  readonly hi: number;
}

function deferInterval(stack: SortInterval[], lo: number, hi: number): void {
  if (stack.length >= 30) {
    throw new RangeError("qsortFast exceeds the source 30-entry work stack");
  }
  stack.push({ lo, hi });
}

function shortsort(range: SourceDrawSortRange, lo: number, hi: number): void {
  while (hi > lo) {
    let max = lo;
    for (let p = lo + 1; p <= hi; p++) {
      if (range.getSort(p) > range.getSort(max)) max = p;
    }
    range.swap(max, hi);
    hi--;
  }
}

/** The caller supplies unsigned sort words and swaps both words and the surface binding. */
export function sortDrawSurfs(range: SourceDrawSortRange): void {
  if (range.length < 2) return;

  const stack: SortInterval[] = [];
  let lo = 0;
  let hi = range.length - 1;

  for (;;) {
    const size = hi - lo + 1;
    if (size <= 8) {
      shortsort(range, lo, hi);
    } else {
      const mid = lo + Math.floor(size / 2);
      range.swap(mid, lo);
      let loguy = lo;
      let higuy = hi + 1;

      for (;;) {
        do {
          loguy++;
        } while (loguy <= hi && range.getSort(loguy) <= range.getSort(lo));

        do {
          higuy--;
        } while (higuy > lo && range.getSort(higuy) >= range.getSort(lo));

        if (higuy < loguy) break;
        range.swap(loguy, higuy);
      }

      range.swap(lo, higuy);

      // The source subtracts one byte here, not one drawSurf_t. Keep its byte comparison.
      if ((higuy - lo) * 8 - 1 >= (hi - loguy) * 8) {
        if (lo + 1 < higuy) deferInterval(stack, lo, higuy - 1);
        if (loguy < hi) {
          lo = loguy;
          continue;
        }
      } else {
        if (loguy < hi) deferInterval(stack, loguy, hi);
        if (lo + 1 < higuy) {
          hi = higuy - 1;
          continue;
        }
      }
    }

    const pending = stack.pop();
    if (pending === undefined) return;
    lo = pending.lo;
    hi = pending.hi;
  }
}
