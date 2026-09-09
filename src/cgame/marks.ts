/*
 * Impact mark lifetime and texture mapping translated from id Software's
 * cgame/cg_marks.c:CG_InitMarkPolys through CG_AddMarks. Appended particles are separate.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import { cross3, dot3, normalize3OrZero, perpendicularVector, scale3, sub3, vec2, vec3, type Vec3, type Vec4 } from "../core/math.ts";
import { qvmRotatePointAroundVector } from "../core/qvm-math.ts";
import { BspMarkProjector } from "../render/marks.ts";
import type { RefPoly, RefPolyVertex, SceneShader } from "../render/ref-entity.ts";

export const MAX_MARK_POLYS = 256;
export const MAX_MARK_POLY_VERTICES = 10;
export const MAX_MARK_FRAGMENTS = 128;
export const MAX_MARK_POINTS = 384;
export const MARK_TOTAL_TIME = 10000;
export const MARK_FADE_TIME = 1000;

export interface ImpactMarkRequest {
  readonly shader: SceneShader | null;
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly orientation: number;
  readonly color: Vec4;
  readonly alphaFade: boolean;
  readonly radius: number;
  readonly temporary: boolean;
}
export interface ImpactMarkOptions {
  readonly clock: () => number;
  readonly enabled: () => boolean;
  readonly energyShader: () => SceneShader | null;
}
interface StoredMark {
  readonly time: number;
  readonly shader: SceneShader | null;
  readonly alphaFade: boolean;
  readonly color: Vec4;
  vertices: readonly RefPolyVertex[];
}

function finite(value: number, name: string): number {
  const result = Math.fround(value);
  if (!Number.isFinite(result)) throw new RangeError(`${name} must be finite float32`);
  return result;
}
function position(value: Vec3): Vec3 { return vec3(finite(value.x, "mark coordinate"), finite(value.y, "mark coordinate"), finite(value.z, "mark coordinate")); }
function byte(value: number): number { return Math.trunc(Math.fround(value)) & 255; }
function poly(shader: SceneShader | null, vertices: readonly RefPolyVertex[]): RefPoly {
  return { shader, vertices: vertices.map(vertex => ({ position: { ...vertex.position }, texCoord: { ...vertex.texCoord }, color: { ...vertex.color } })) };
}
function unitColor(value: number): number {
  const result = finite(value, "mark color");
  if (result < 0 || result > 1) throw new RangeError("mark colors must be in [0, 1]");
  return result;
}

export class ImpactMarkSystem {
  private readonly active: StoredMark[] = [];

  constructor(private readonly projector: BspMarkProjector, private readonly options: ImpactMarkOptions) {}

  reset(): void { this.active.length = 0; }
  get activeMarkCount(): number { return this.active.length; }

  impactMark(request: ImpactMarkRequest): readonly RefPoly[] {
    if (!this.options.enabled()) return [];
    const radius = finite(request.radius, "mark radius");
    if (radius <= 0) throw new RangeError("CG_ImpactMark called with <= 0 radius");
    const origin = position(request.origin), direction = position(request.direction);
    // Q3_VM omits ProjectPointOnPlane's zero-normal assertion. Its NaN axes
    // reach the renderer with zero projection, which rejects every face/grid.
    if (dot3(direction, direction) === 0) return [];
    const normal = normalize3OrZero(direction);
    const axis2 = qvmRotatePointAroundVector(normal, perpendicularVector(normal), finite(request.orientation, "mark orientation"));
    const axis1 = cross3(normal, axis2), scale = Math.fround(0.5 / radius);
    const point = (first: number, second: number): Vec3 => vec3(
      Math.fround(origin.x + Math.fround(first * Math.fround(radius * axis1.x))) + Math.fround(second * Math.fround(radius * axis2.x)),
      Math.fround(origin.y + Math.fround(first * Math.fround(radius * axis1.y))) + Math.fround(second * Math.fround(radius * axis2.y)),
      Math.fround(origin.z + Math.fround(first * Math.fround(radius * axis1.z))) + Math.fround(second * Math.fround(radius * axis2.z)),
    );
    const fragments = this.projector.markFragments({ points: [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)], projection: scale3(direction, -20), maxPoints: MAX_MARK_POINTS, maxFragments: MAX_MARK_FRAGMENTS });
    const color = { x: unitColor(request.color.x), y: unitColor(request.color.y), z: unitColor(request.color.z), w: unitColor(request.color.w) };
    const modulate = { x: byte(color.x * 255), y: byte(color.y * 255), z: byte(color.z * 255), w: byte(color.w * 255) };
    const temporary: RefPoly[] = [];
    for (const fragment of fragments.fragments) {
      const vertices = fragments.points.slice(fragment.firstPoint, fragment.firstPoint + Math.min(fragment.pointCount, MAX_MARK_POLY_VERTICES)).map(point => {
        const delta = sub3(point, origin);
        return { position: { ...point }, texCoord: vec2(0.5 + Math.fround(dot3(delta, axis1) * scale), 0.5 + Math.fround(dot3(delta, axis2) * scale)), color: { ...modulate } };
      });
      if (request.temporary) { temporary.push(poly(request.shader, vertices)); continue; }
      if (this.active.length === MAX_MARK_POLYS) {
        const oldest = this.active.at(-1);
        if (oldest === undefined) throw new Error("full mark pool has no oldest polygon");
        // Stop at the list boundary; source mistakenly frees its timestamp-zero sentinel.
        while (this.active.at(-1)?.time === oldest.time) this.active.pop();
      }
      this.active.unshift({ time: this.now(), shader: request.shader, alphaFade: request.alphaFade, color, vertices });
    }
    return temporary;
  }

  addMarks(): readonly RefPoly[] {
    if (!this.options.enabled()) return [];
    const output: RefPoly[] = [], now = this.now();
    for (let index = 0; index < this.active.length;) {
      const mark = this.active[index];
      if (mark === undefined) throw new Error("mark pool contains a missing polygon");
      const expires = (mark.time + MARK_TOTAL_TIME) | 0;
      if (now > expires) { this.active.splice(index, 1); continue; }
      if (mark.shader === this.options.energyShader()) {
        // cg_marks' Q3_VM expression emits SUBI4, CVIF4, DIVF4, MULF4,
        // SUBF4, CVFI4. Native double promotion changes visible byte values.
        const age = Math.fround((now - mark.time) | 0);
        const fade = Math.trunc(Math.fround(450 - Math.fround(450 * Math.fround(age / 3000))));
        const first = mark.vertices[0];
        if (fade < 255 && first !== undefined && first.color.x !== 0) this.fadeRgb(mark, Math.max(0, fade));
      }
      const remaining = (expires - now) | 0;
      if (remaining < MARK_FADE_TIME) {
        const fade = Math.trunc(Math.imul(255, remaining) / MARK_FADE_TIME);
        if (mark.alphaFade) mark.vertices = mark.vertices.map(vertex => ({ ...vertex, color: { ...vertex.color, w: fade & 255 } }));
        else this.fadeRgb(mark, fade);
      }
      output.push(poly(mark.shader, mark.vertices));
      index++;
    }
    return output;
  }

  private fadeRgb(mark: StoredMark, fade: number): void {
    const color = { x: byte(mark.color.x * fade), y: byte(mark.color.y * fade), z: byte(mark.color.z * fade) };
    mark.vertices = mark.vertices.map(vertex => ({ ...vertex, color: { ...vertex.color, ...color } }));
  }
  private now(): number {
    const time = this.options.clock();
    if (!Number.isInteger(time) || time < -0x80000000 || time > 0x7fffffff) throw new RangeError("mark clock must be signed 32-bit milliseconds");
    return time;
  }
}
