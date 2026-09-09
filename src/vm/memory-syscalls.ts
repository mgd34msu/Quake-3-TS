/*
 * Memory traps from server/sv_game.c, client/cl_cgame.c and client/cl_ui.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { QvmMemory } from "./memory.ts";

function rejectOverlap(destination: Uint8Array, source: Uint8Array): void {
  if (destination.byteLength !== 0 && source.byteLength !== 0
    && destination.byteOffset < source.byteOffset + source.byteLength
    && source.byteOffset < destination.byteOffset + destination.byteLength) {
    throw new RangeError("Overlapping QVM memcpy/strncpy ranges are unsupported");
  }
}

/**
 * All roles share these trap numbers and return zero from memset/memcpy.
 * The typed strncpy profile returns the original signed destination word.
 * Source returns a host pointer cast to int; its address bits are not reproduced.
 * Undefined overlapping copies and negative counts reject before mutation.
 */
export function qvmMemorySyscall(_role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory): number | null {
  const trap = words.getInt32(0, true);
  if (trap !== 100 && trap !== 101 && trap !== 102) return null;
  const destinationWord = words.getInt32(4, true);
  const sourceWord = words.getInt32(8, true);
  const count = words.getInt32(12, true);
  const destination = memory.span(destinationWord, count);
  if (trap === 100) {
    destination.fill(sourceWord & 255);
    return 0;
  }
  if (trap === 101) {
    const source = memory.span(sourceWord, count);
    rejectOverlap(destination, source);
    destination.set(source);
    return 0;
  }
  const source = memory.pointer(sourceWord);
  if (source === null) throw new RangeError("QVM strncpy requires a nonnull source pointer");
  const terminator = source.subarray(0, count).indexOf(0);
  const copiedLength = terminator < 0 ? count : terminator;
  const consumed = memory.span(sourceWord, terminator < 0 ? count : terminator + 1);
  rejectOverlap(destination, consumed);
  destination.set(source.subarray(0, copiedLength));
  destination.fill(0, copiedLength);
  return destinationWord;
}
