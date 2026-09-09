// tr_shader.c infoParms/ParseSurfaceParm. Renderer flags start at zero;
// clearSolid belongs to q3map and is compiled out in the renderer.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { ShaderDefinition } from "./material.ts";

const FLAGS: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["water", [0, 32]], ["slime", [0, 16]], ["lava", [0, 8]],
  ["playerclip", [0, 0x10000]], ["monsterclip", [0, 0x20000]], ["nodrop", [0, 0x80000000]],
  ["nonsolid", [0x4000, 0]], ["origin", [0, 0x1000000]], ["trans", [0, 0x20000000]],
  ["detail", [0, 0x8000000]], ["structural", [0, 0x10000000]], ["areaportal", [0, 0x8000]],
  ["clusterportal", [0, 0x100000]], ["donotenter", [0, 0x200000]], ["fog", [0, 64]],
  ["sky", [4, 0]], ["lightfilter", [0x8000, 0]], ["alphashadow", [0x10000, 0]], ["hint", [0x100, 0]],
  ["slick", [2, 0]], ["noimpact", [0x10, 0]], ["nomarks", [0x20, 0]], ["ladder", [8, 0]],
  ["nodamage", [1, 0]], ["metalsteps", [0x1000, 0]], ["flesh", [0x40, 0]], ["nosteps", [0x2000, 0]],
  ["nodraw", [0x80, 0]], ["pointlight", [0x800, 0]], ["nolightmap", [0x400, 0]],
  ["nodlight", [0x20000, 0]], ["dust", [0x40000, 0]],
]);

export function materialFlags(definition: ShaderDefinition | null): { readonly surfaceFlags: number; readonly contentFlags: number } {
  let surfaceFlags = 0, contentFlags = 0;
  for (const parm of definition?.surfaceParms ?? []) {
    const flags = FLAGS.get(parm);
    if (flags !== undefined) { surfaceFlags |= flags[0]; contentFlags |= flags[1]; }
  }
  return { surfaceFlags, contentFlags };
}
