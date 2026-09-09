// refdef_t from id Software's code/cgame/tr_types.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { Axis, Vec3 } from "../core/math.ts";

export type RenderText = readonly [string, string, string, string, string, string, string, string];

/** refdef_t has eight 32-byte rows. Unbounded strlen on an unterminated row is outside the supported source domain. */
export function copyRenderText(source: RenderText): RenderText {
  if (source.length !== 8) throw new RangeError("refdef requires eight render strings");
  for (const row of source) {
    if (row.length > 32 || row.length === 32 && !row.includes("\0")) throw new RangeError("refdef render string requires a NUL within 32 bytes");
    for (let index = 0; index < row.length; index++) {
      if (row.charCodeAt(index) > 255) throw new RangeError("refdef render strings require byte characters");
    }
  }
  return [source[0], source[1], source[2], source[3], source[4], source[5], source[6], source[7]];
}
export const RDF_NOWORLDMODEL = 1;
export const RDF_HYPERSPACE = 4;

export interface Refdef {
  x: number;
  y: number;
  width: number;
  height: number;
  fovX: number;
  fovY: number;
  viewOrigin: Vec3;
  viewAxis: Axis;
  time: number;
  renderFlags: number;
  areaMask: Uint8Array;
  text: RenderText;
}

export function createRefdef(): Refdef {
  return { x: 0, y: 0, width: 0, height: 0, fovX: 0, fovY: 0,
    viewOrigin: vec3(0, 0, 0), viewAxis: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)],
    time: 0, renderFlags: 0, areaMask: new Uint8Array(32), text: ["", "", "", "", "", "", "", ""] };
}

/** Scene publication owns arrays and preserves the caller's exact basis and FOV. */
export function copyRefdef(source: Refdef): Refdef {
  if (source.areaMask.length !== 32) throw new RangeError("refdef requires 32 area-mask bytes");
  return { ...source, viewOrigin: { ...source.viewOrigin },
    viewAxis: [{ ...source.viewAxis[0] }, { ...source.viewAxis[1] }, { ...source.viewAxis[2] }],
    areaMask: new Uint8Array(source.areaMask),
    text: copyRenderText(source.text) };
}
