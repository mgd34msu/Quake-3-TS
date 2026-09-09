// Renderer counters and R_PerformanceCounters, id Software tr_local.h/tr_cmds.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export class RendererFrontEndCounters {
  c_sphere_cull_patch_in = 0;
  c_sphere_cull_patch_clip = 0;
  c_sphere_cull_patch_out = 0;
  c_box_cull_patch_in = 0;
  c_box_cull_patch_clip = 0;
  c_box_cull_patch_out = 0;
  c_sphere_cull_md3_in = 0;
  c_sphere_cull_md3_clip = 0;
  c_sphere_cull_md3_out = 0;
  c_box_cull_md3_in = 0;
  c_box_cull_md3_clip = 0;
  c_box_cull_md3_out = 0;
  c_leafs = 0;
  c_dlightSurfaces = 0;
  c_dlightSurfacesCulled = 0;
}

export class RendererBackEndCounters {
  c_surfaces = 0;
  c_shaders = 0;
  c_vertexes = 0;
  c_indexes = 0;
  c_totalIndexes = 0;
  c_overDraw = 0;
  c_dlightVertexes = 0;
  c_dlightIndexes = 0;
  // The selected tr_surface.c flare handler and dynamic-light flare producer are inactive.
  c_flareAdds = 0;
  c_flareTests = 0;
  c_flareRenders = 0;
  msec = 0;
}

export interface RendererFrameTimings {
  readonly frontEndMsec: number;
  readonly backEndMsec: number;
}

/** Source arguments are binary32. Scaling by 100 remains exact in binary64. */
function fixed(value: number, decimals: 0 | 2): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  const scale = decimals === 0 ? 1 : 100;
  const scaled = Math.abs(value) * scale, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = BigInt(lower) + (fraction > 0.5 || (fraction === 0.5 && lower % 2 !== 0) ? 1n : 0n);
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  if (decimals === 0) return `${sign}${rounded}`;
  return `${sign}${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
}

export class RendererPerformanceCounters {
  readonly frontEnd = new RendererFrontEndCounters();
  readonly backEnd = new RendererBackEndCounters();
  viewCluster = 0;
  zFar = 0;
  frontEndMsec = 0;

  /** R_IssueRenderCommands calls this before starting the newly issued backend work. */
  report(mode: number, width: number, height: number, sumOfUsedImages: () => number,
    print: (text: string) => undefined): void {
    const front = this.frontEnd, back = this.backEnd;
    if (mode === 1) {
      const megatexels = Math.fround(Math.fround(sumOfUsedImages()) / 1_000_000);
      const overdraw = Math.fround(back.c_overDraw / Math.fround((width * height) | 0));
      print(`${back.c_shaders}/${back.c_surfaces} shaders/surfs ${front.c_leafs} leafs ${back.c_vertexes} verts `
        + `${Math.trunc(back.c_indexes / 3)}/${Math.trunc(back.c_totalIndexes / 3)} tris ${fixed(megatexels, 2)} mtex ${fixed(overdraw, 2)} dc\n`);
    } else if (mode === 2) {
      print(`(patch) ${front.c_sphere_cull_patch_in} sin ${front.c_sphere_cull_patch_clip} sclip  ${front.c_sphere_cull_patch_out} sout `
        + `${front.c_box_cull_patch_in} bin ${front.c_box_cull_patch_clip} bclip ${front.c_box_cull_patch_out} bout\n`);
      print(`(md3) ${front.c_sphere_cull_md3_in} sin ${front.c_sphere_cull_md3_clip} sclip  ${front.c_sphere_cull_md3_out} sout `
        + `${front.c_box_cull_md3_in} bin ${front.c_box_cull_md3_clip} bclip ${front.c_box_cull_md3_out} bout\n`);
    } else if (mode === 3) {
      print(`viewcluster: ${this.viewCluster}\n`);
    } else if (mode === 4) {
      if (back.c_dlightVertexes !== 0) print(`dlight srf:${front.c_dlightSurfaces}  culled:${front.c_dlightSurfacesCulled}  `
        + `verts:${back.c_dlightVertexes}  tris:${Math.trunc(back.c_dlightIndexes / 3)}\n`);
    } else if (mode === 5) {
      print(`zFar: ${fixed(this.zFar, 0)}\n`);
    } else if (mode === 6) {
      print(`flare adds:${back.c_flareAdds} tests:${back.c_flareTests} renders:${back.c_flareRenders}\n`);
    }
    Object.assign(front, new RendererFrontEndCounters());
    Object.assign(back, new RendererBackEndCounters());
  }

  /** RE_EndFrame publishes and clears timing separately from performance counter reset. */
  finishFrame(): RendererFrameTimings {
    const timings = { frontEndMsec: this.frontEndMsec, backEndMsec: this.backEnd.msec };
    this.frontEndMsec = 0;
    this.backEnd.msec = 0;
    return timings;
  }
}
