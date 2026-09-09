// RB_DrawSun, id Software code/renderer/tr_sky.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { add3, cross3, perpendicularVector, scale3, sub3, vec2, vec3 } from "../core/math.ts";
import type { Vec3, Vec4 } from "../core/math.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { RendererSettings } from "./settings.ts";
import type { SourceTessState } from "./tess-state.ts";
import type { SurfaceViewOperation } from "./types.ts";

export interface SunView {
  readonly skyRendered: boolean;
  readonly far: number;
  readonly direction: Vec3;
  /** Loaded world model matrix translated by the current view origin. */
  readonly project: (position: Vec3) => Vec4;
}

/** The original RB_RenderDrawSurfList caller remains disabled. */
export function* drawSun(tess: SourceTessState, shader: MaterialRecord, view: SunView,
  settings: Pick<RendererSettings["runtime"], "drawSun">,
  endSurface: () => Iterable<SurfaceViewOperation, unknown, unknown>): Generator<SurfaceViewOperation, void, unknown> {
  if (!view.skyRendered) return;
  if (settings.drawSun === 0) return;
  tess.setProjector(view.project);
  const distance = Math.fround(view.far / 1.75), size = Math.fround(distance * 0.4);
  const origin = scale3(view.direction, distance), perpendicular = perpendicularVector(view.direction);
  const first = scale3(perpendicular, size), second = scale3(cross3(view.direction, perpendicular), size);
  tess.setDepthRange([1, 1]);
  yield { kind: "depth-range", range: tess.actualDepthRange };
  tess.beginSurface(shader, tess.fog, tess.floatTime);
  const positions = [sub3(sub3(origin, first), second), sub3(add3(origin, first), second),
    add3(add3(origin, first), second), add3(sub3(origin, first), second)];
  tess.appendGeometry({ vertices: positions.map((position, index) => ({ position,
    texCoord: vec2(index >= 2 ? 1 : 0, index === 1 || index === 2 ? 1 : 0),
    normal: vec3(0, 0, 0), lightmapCoord: vec2(0, 0), color: { x: 255, y: 255, z: 255, w: 0 } })),
    indices: [0, 1, 2, 0, 2, 3] }, "rail");
  yield* endSurface();
  tess.setDepthRange([0, 1]);
  yield { kind: "depth-range", range: tess.actualDepthRange };
}
