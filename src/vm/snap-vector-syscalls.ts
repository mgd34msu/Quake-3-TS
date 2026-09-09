/*
 * Sys_SnapVector from unix/snapvector.nasm, reached through G_SNAPVECTOR in
 * server/sv_game.c and CG_SNAPVECTOR in client/cl_cgame.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Selected Linux i386 x87 profile: cw037F nearest-even, masked exceptions,
 * signed dword fistp/fild, then binary32 fstp. This is not the C rint profile.
 */
import type { QvmMemory } from "./memory.ts";

function snapComponent(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  const integer = fraction < 0.5 ? lower
    : fraction > 0.5 ? lower + 1
    : lower % 2 === 0 ? lower : lower + 1;
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    return -2147483648;
  }
  return integer === 0 ? 0 : integer;
}

export function qvmSnapVectorSyscall(
  role: "game" | "cgame" | "ui",
  words: DataView,
  memory: QvmMemory,
): number | null {
  if (role === "ui") return null;
  if (words.getInt32(0, true) !== (role === "game" ? 42 : 71)) return null;
  const pointer = memory.pointer(words.getInt32(4, true));
  if (pointer === null) throw new RangeError("QVM SnapVector requires a nonnull pointer");
  const vector = new DataView(pointer.buffer, pointer.byteOffset, pointer.byteLength);
  // Mask only the base; publish each component before reaching the next read.
  for (let offset = 0; offset < 12; offset += 4) {
    vector.setFloat32(offset, snapComponent(vector.getFloat32(offset, true)), true);
  }
  return 0;
}
