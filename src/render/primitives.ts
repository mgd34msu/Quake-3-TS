// Translated from id Software's renderer/tr_shade.c:R_DrawElements/R_DrawStripElements.
// Copyright (C) 1999-2005 Id Software, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later

export type SourcePrimitiveMode = "elements" | "array-strips" | "discrete-strips" | "none";

export function sourcePrimitiveMode(requested: number, compiledArrays: boolean): SourcePrimitiveMode {
  switch (requested) {
    case 0: return compiledArrays ? "elements" : "array-strips";
    case 1: return "array-strips";
    case 2: return "elements";
    case 3: return "discrete-strips";
    default: return "none";
  }
}

export interface SourceStripEmitter {
  begin(): undefined;
  element(index: number): undefined;
  end(): undefined;
}

export function emitSourceTriangleStrips(indices: readonly number[], emit: SourceStripEmitter): void {
  if (indices.length === 0) return;
  if (indices.length % 3 !== 0) throw new RangeError("Source triangle strips require complete index triples");
  let lastA = indices[0], lastB = indices[1], lastC = indices[2];
  if (lastA === undefined || lastB === undefined || lastC === undefined)
    throw new RangeError("Source triangle strips require allocated index triples");

  emit.begin();
  emit.element(lastA);
  emit.element(lastB);
  emit.element(lastC);
  let even = false;

  for (let i = 3; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a === undefined || b === undefined || c === undefined)
      throw new RangeError("Source triangle strips require allocated index triples");
    const continues = even ? a === lastA && b === lastC : a === lastC && b === lastB;
    if (continues) {
      emit.element(c);
      even = !even;
    } else {
      emit.end();
      emit.begin();
      emit.element(a);
      emit.element(b);
      emit.element(c);
      even = false;
    }
    lastA = a;
    lastB = b;
    lastC = c;
  }
  emit.end();
}
