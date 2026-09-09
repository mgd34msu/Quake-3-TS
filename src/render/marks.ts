/*
 * World decal projection translated from id Software's renderer/tr_marks.c.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BspVertex } from "../assets/bsp.ts";
import type { RendererBspMap } from "./bsp-resource.ts";
import { add3, boxOnPlaneSide, cross3, dot3, normalize3OrZero, scale3, sub3, vec3, type Bounds, type Plane, type Vec3 } from "../core/math.ts";
import { normalizeFast3 } from "../core/renderer-math.ts";
import type { PatchMesh } from "./patch.ts";

export type MarkSurface = { readonly kind: "skip" }
  | { readonly kind: "face"; readonly surfaceFlags: number; readonly contentFlags: number; readonly plane: Plane; readonly vertices: readonly BspVertex[]; readonly indices: readonly number[] }
  | { readonly kind: "grid"; readonly surfaceFlags: number; readonly contentFlags: number; readonly mesh: PatchMesh };

/** Same surface indices and prepared grids as the renderer, before frame-dependent LOD. */
export interface MarkGeometry {
  readonly map: Pick<RendererBspMap, "nodes" | "planes" | "leaves" | "leafSurfaces"> & { readonly surfaces: readonly unknown[] };
  readonly surfaces: readonly MarkSurface[];
}
export interface MarkFragment { readonly firstPoint: number; readonly pointCount: number }
export interface MarkFragments { readonly points: readonly Vec3[]; readonly fragments: readonly MarkFragment[] }
export interface MarkProjection {
  readonly points: readonly Vec3[];
  readonly projection: Vec3;
  readonly maxPoints: number;
  readonly maxFragments: number;
}
/** Borrowed inputs and reached R_AddMarkFragments output stores. */
export interface SourceMarkProjection {
  readonly pointCount: number;
  readonly maxPoints: number;
  readonly maxFragments: number;
  readPoint(index: number): Vec3;
  readProjection(): Vec3;
  writeFragment(index: number, fragment: MarkFragment): undefined;
  writePoints(firstPoint: number, points: readonly Vec3[]): undefined;
}

const MAX_CLIP_VERTICES = 64;
const MAX_MARK_SURFACES = 64;
const CLIP_EPSILON = 0.5;
const f = Math.fround;

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`mark geometry index ${index} outside ${values.length}`);
  return value;
}
function finiteVector(value: Vec3): Vec3 {
  if (![value.x, value.y, value.z].every(component => Number.isFinite(f(component)))) throw new RangeError("mark coordinates must be finite float32 values");
  return vec3(value.x, value.y, value.z);
}
function capacity(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) throw new RangeError("mark buffer capacity must be an integer in [0, 1000000]");
}
function boxSide(bounds: Bounds, plane: Plane): number {
  // q_math.c's axial fast path treats max == plane distance as entirely behind.
  const axis = plane.normal.x === 1 ? "x" : plane.normal.y === 1 ? "y" : plane.normal.z === 1 ? "z" : null;
  if (axis !== null) {
    if (plane.distance <= bounds.min[axis]) return 1;
    if (plane.distance >= bounds.max[axis]) return 2;
    return 3;
  }
  return boxOnPlaneSide(bounds, plane);
}

/** R_ChopPolyBehindPlane drops all-on-plane polygons and refuses 62+ input vertices. */
function chop(points: readonly Vec3[], plane: Plane): Vec3[] {
  if (points.length >= MAX_CLIP_VERTICES - 2) return [];
  const distances = points.map(point => f(dot3(point, plane.normal) - plane.distance));
  const sides = distances.map(distance => distance > CLIP_EPSILON ? 0 : distance < -CLIP_EPSILON ? 1 : 2);
  if (!sides.includes(0)) return [];
  if (!sides.includes(1)) return [...points];
  const result: Vec3[] = [];
  for (let index = 0; index < points.length; index++) {
    const first = at(points, index), side = at(sides, index), next = (index + 1) % points.length;
    if (side === 2) { result.push(first); continue; }
    if (side === 0) result.push(first);
    const nextSide = at(sides, next);
    if (nextSide === 2 || nextSide === side) continue;
    const difference = f(at(distances, index) - at(distances, next));
    const fraction = difference === 0 ? 0 : f(at(distances, index) / difference);
    result.push(add3(first, scale3(sub3(at(points, next), first), fraction)));
  }
  return result;
}

export class BspMarkProjector {
  constructor(readonly geometry: MarkGeometry) {
    if (geometry.surfaces.length !== geometry.map.surfaces.length) throw new RangeError("mark geometry must retain every BSP surface index");
  }

  markFragments(query: MarkProjection): MarkFragments {
    const points: Vec3[] = [], fragments: MarkFragment[] = [];
    this.markFragmentsRecord({
      pointCount: query.points.length, maxPoints: query.maxPoints, maxFragments: query.maxFragments,
      readPoint: index => at(query.points, index), readProjection: () => query.projection,
      writeFragment: (_index, fragment) => { fragments.push(fragment); },
      writePoints: (_firstPoint, values) => { points.push(...values); },
    });
    return { points, fragments };
  }

  markFragmentsRecord(query: SourceMarkProjection): number {
    capacity(query.maxPoints); capacity(query.maxFragments);
    if (!Number.isInteger(query.pointCount) || query.pointCount < 1) throw new RangeError("mark projection requires at least one input point");
    const projection = finiteVector(query.readProjection());
    const direction = normalize3OrZero(projection);
    const points: Vec3[] = [];
    const minimum = { x: 99999, y: 99999, z: 99999 }, maximum = { x: -99999, y: -99999, z: -99999 };
    // R_MarkFragments consumes projection first and bounds every input point before its plane clamp.
    for (let index = 0; index < query.pointCount; index++) {
      const point = finiteVector(query.readPoint(index));
      if (index < MAX_CLIP_VERTICES) points.push(point);
      for (const boundPoint of [point, add3(point, projection), add3(point, scale3(direction, -20))]) {
        minimum.x = Math.min(minimum.x, boundPoint.x); minimum.y = Math.min(minimum.y, boundPoint.y); minimum.z = Math.min(minimum.z, boundPoint.z);
        maximum.x = Math.max(maximum.x, boundPoint.x); maximum.y = Math.max(maximum.y, boundPoint.y); maximum.z = Math.max(maximum.z, boundPoint.z);
      }
    }
    // Source maxFragments == 0 can write beyond its output array; a zero-capacity query owns no slots.
    if (query.maxFragments === 0 || query.maxPoints === 0) return 0;
    const count = points.length, planes: Plane[] = [];
    for (let index = 0; index < count; index++) {
      const point = at(points, index), edge = sub3(at(points, (index + 1) % count), point);
      const reverseProjection = sub3(point, add3(point, projection));
      const normal = normalizeFast3(cross3(edge, reverseProjection));
      planes.push({ normal, distance: dot3(normal, point) });
    }
    const first = at(points, 0), inverseDirection = scale3(direction, -1);
    planes.push({ normal: direction, distance: f(dot3(direction, first) - 32) }, { normal: inverseDirection, distance: f(dot3(inverseDirection, first) - 20) });
    const surfaces = this.boxSurfaces({ min: minimum, max: maximum }, direction);
    let returnedPoints = 0, returnedFragments = 0;
    const append = (triangle: readonly Vec3[]): void => {
      let clipped = [...triangle];
      for (const plane of planes) { clipped = chop(clipped, plane); if (clipped.length === 0) return; }
      if (clipped.length + returnedPoints > query.maxPoints) return;
      query.writeFragment(returnedFragments, { firstPoint: returnedPoints, pointCount: clipped.length });
      query.writePoints(returnedPoints, clipped);
      returnedPoints += clipped.length;
      returnedFragments++;
    };
    for (const surface of surfaces) {
      if (surface.kind === "face") {
        if (dot3(surface.plane.normal, direction) > -0.5) continue;
        for (let index = 0; index < surface.indices.length; index += 3) {
          // MARKER_OFFSET is zero, but source VectorMA still normalizes signed
          // zero coordinates through its multiply/add operation.
          append([0, 1, 2].map(offset => add3(at(surface.vertices, at(surface.indices, index + offset)).position, scale3(surface.plane.normal, 0))));
          if (returnedFragments === query.maxFragments) return returnedFragments;
        }
      } else if (surface.kind === "grid") {
        const mesh = surface.mesh;
        for (let row = 0; row < mesh.height - 1; row++) for (let column = 0; column < mesh.width - 1; column++) {
          const base = row * mesh.width + column;
          for (const triangle of [{ indexes: [base, base + mesh.width, base + 1], threshold: -0.1 }, { indexes: [base + 1, base + mesh.width, base + mesh.width + 1], threshold: -0.05 }]) {
            const vertices = triangle.indexes.map(index => {
              const vertex = at(mesh.vertices, index);
              return add3(vertex.position, scale3(vertex.normal, 0));
            });
            const normal = normalizeFast3(cross3(sub3(at(vertices, 0), at(vertices, 1)), sub3(at(vertices, 2), at(vertices, 1))));
            if (dot3(normal, direction) >= triangle.threshold) continue;
            append(vertices);
            if (returnedFragments === query.maxFragments) return returnedFragments;
          }
        }
      }
    }
    return returnedFragments;
  }

  private boxSurfaces(bounds: Bounds, direction: Vec3): MarkSurface[] {
    const map = this.geometry.map, visited = new Set<number>(), result: MarkSurface[] = [];
    const stack = map.nodes.length === 0 ? (map.leaves.length === 0 ? [] : [-1]) : [0];
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) break;
      if (index >= 0) {
        const node = at(map.nodes, index), side = boxSide(bounds, at(map.planes, node.plane));
        if ((side & 2) !== 0) stack.push(node.children[1]);
        if ((side & 1) !== 0) stack.push(node.children[0]);
        continue;
      }
      const leaf = at(map.leaves, -index - 1);
      for (let offset = 0; offset < leaf.surfaceCount; offset++) {
        if (result.length >= MAX_MARK_SURFACES) break;
        const surfaceIndex = at(map.leafSurfaces, leaf.firstSurface + offset);
        if (visited.has(surfaceIndex)) continue;
        visited.add(surfaceIndex);
        const surface = at(this.geometry.surfaces, surfaceIndex);
        if (surface.kind === "skip" || (surface.surfaceFlags & 0x30) !== 0 || (surface.contentFlags & 64) !== 0) continue;
        if (surface.kind === "face" && (boxSide(bounds, surface.plane) !== 3 || dot3(surface.plane.normal, direction) > -0.5)) continue;
        result.push(surface);
      }
    }
    return result;
  }
}
