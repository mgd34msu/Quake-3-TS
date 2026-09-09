// ProjectDlightTexture, R_TransformDlights, R_DlightSurface and R_DlightBmodel,
// id Software renderer/tr_shade.c, tr_world.c and tr_light.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { dot3, sub3, vec3 } from "../core/math.ts";
import type { Axis, Bounds, Plane, Vec3, Vec4 } from "../core/math.ts";
import type { DeformGeometry } from "./deform.ts";
import type { RendererImage } from "./image-resource.ts";
import type { DynamicLight } from "./lighting.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { RendererPerformanceCounters } from "./performance.ts";
import type { DrawBatch, RenderState } from "./types.ts";

const f = Math.fround;

export function transformDlights(lights: readonly DynamicLight[], origin: Vec3, axis: Axis): readonly DynamicLight[] {
  return lights.map(light => {
    const relative = sub3(light.origin, origin);
    return { ...light, origin: vec3(dot3(relative, axis[0]), dot3(relative, axis[1]), dot3(relative, axis[2])) };
  });
}

export function splitDlightMask(lights: readonly DynamicLight[], mask: number, plane: Plane): readonly [number, number] {
  if (mask === 0) return [0, 0];
  let front = 0, back = 0;
  for (const [index, light] of lights.entries()) {
    const bit = 1 << index;
    if ((mask & bit) === 0) continue;
    const distance = f(dot3(light.origin, plane.normal) - plane.distance);
    if (distance > -light.radius) front |= bit;
    if (distance < light.radius) back |= bit;
  }
  return [front, back];
}

export function faceDlightMask(lights: readonly DynamicLight[], mask: number, plane: Plane): number {
  for (const [index, light] of lights.entries()) {
    const bit = 1 << index;
    if ((mask & bit) === 0) continue;
    const distance = f(dot3(light.origin, plane.normal) - plane.distance);
    if (distance < -light.radius || distance > light.radius) mask &= ~bit;
  }
  return mask;
}

export function gridDlightMask(lights: readonly DynamicLight[], mask: number, bounds: Bounds): number {
  for (const [index, light] of lights.entries()) {
    const bit = 1 << index;
    if ((mask & bit) === 0) continue;
    const origin = light.origin, radius = light.radius;
    if (f(origin.x - radius) > bounds.max.x || f(origin.x + radius) < bounds.min.x
      || f(origin.y - radius) > bounds.max.y || f(origin.y + radius) < bounds.min.y
      || f(origin.z - radius) > bounds.max.z || f(origin.z + radius) < bounds.min.z) mask &= ~bit;
  }
  return mask;
}

/** Bmodel culling uses transformed origins and a different subtraction order. */
export function bmodelDlightMask(lights: readonly DynamicLight[], bounds: Bounds): number {
  let mask = 0;
  for (const [index, light] of lights.entries()) {
    const origin = light.origin, radius = light.radius;
    if (f(origin.x - bounds.max.x) > radius || f(bounds.min.x - origin.x) > radius
      || f(origin.y - bounds.max.y) > radius || f(bounds.min.y - origin.y) > radius
      || f(origin.z - bounds.max.z) > radius || f(bounds.min.z - origin.z) > radius) continue;
    mask |= 1 << index;
  }
  return mask;
}

/** The two optimized source iterators do not repeat the generic surface-flag gate. */
export function receivesProjectedDlights(material: MaterialRecord): boolean {
  if (material.finished.sort > 3) return false;
  const iterator = material.finished.iterator.kind;
  // Sky clouds call the generic iterator; skyParms alone does not set SURF_SKY.
  return (iterator !== "generic" && iterator !== "sky")
    || !material.definition?.surfaceParms.some(flag => flag === "nodlight" || flag === "sky");
}

export function projectDlightTexture(geometry: DeformGeometry, mask: number, lights: readonly DynamicLight[],
  image: RendererImage, project: (position: Vec3) => Vec4, cull: RenderState["cull"], performance?: RendererPerformanceCounters): readonly DrawBatch[] {
  return Array.from(iterateProjectedDlights(geometry, mask, lights, image, project, cull, performance));
}

export function* iterateProjectedDlights(geometry: DeformGeometry, mask: number, lights: readonly DynamicLight[],
  image: RendererImage, project: (position: Vec3) => Vec4, cull: RenderState["cull"], performance?: RendererPerformanceCounters): Generator<DrawBatch, void, unknown> {
  for (const [index, light] of lights.entries()) {
    if ((mask & (1 << index)) === 0) continue;
    const radius = light.radius, scale = f(1 / radius), color = vec3(light.color.x * 255, light.color.y * 255, light.color.z * 255);
    const clipBits: number[] = [];
    const vertices = geometry.vertices.map(vertex => {
      if (performance !== undefined) performance.backEnd.c_dlightVertexes = (performance.backEnd.c_dlightVertexes + 1) | 0;
      const distance = sub3(light.origin, vertex.position);
      const texCoord = { x: f(0.5 + f(distance.x * scale)), y: f(0.5 + f(distance.y * scale)) };
      let clip = (texCoord.x < 0 ? 1 : texCoord.x > 1 ? 2 : 0) | (texCoord.y < 0 ? 4 : texCoord.y > 1 ? 8 : 0);
      let modulate: number;
      if (distance.z > radius) { clip |= 16; modulate = 0; }
      else if (distance.z < -radius) { clip |= 32; modulate = 0; }
      else {
        const height = Math.abs(distance.z);
        modulate = height < f(radius * 0.5) ? 1 : f(f(2 * f(radius - height)) * scale);
      }
      clipBits.push(clip);
      // Linux myftol is truncation; assignment to byte preserves the low eight bits.
      const byte = (component: number): number => (Math.trunc(f(component * modulate)) & 255) / 255;
      return { position: project(vertex.position), texCoord, color: { x: byte(color.x), y: byte(color.y), z: byte(color.z), w: 1 } };
    });
    const indices: number[] = [];
    for (let offset = 0; offset < geometry.indices.length; offset += 3) {
      const a = geometry.indices[offset], b = geometry.indices[offset + 1], c = geometry.indices[offset + 2];
      if (a === undefined || b === undefined || c === undefined) throw new Error("dlight triangle indices are incomplete");
      const ac = clipBits[a], bc = clipBits[b], cc = clipBits[c];
      if (ac === undefined || bc === undefined || cc === undefined) throw new Error("ProjectDlightTexture: triangle has no active clipBits entry; inactive source scratch is indeterminate");
      if ((ac & bc & cc) === 0) indices.push(a, b, c);
    }
    const numIndexes = indices.length;
    if (numIndexes === 0) continue;
    yield { texturing: "single", primitive: "triangles", vertices, indices, texture: { kind: "bind-image", image },
      state: { blend: { source: light.additive === true ? "one" : "dst-color", destination: "one" },
        depthTest: "equal", depthWrite: false, alphaTest: "none", cull } };
    if (performance !== undefined) {
      performance.backEnd.c_totalIndexes = (performance.backEnd.c_totalIndexes + numIndexes) | 0;
      performance.backEnd.c_dlightIndexes = (performance.backEnd.c_dlightIndexes + numIndexes) | 0;
    }
  }
}
