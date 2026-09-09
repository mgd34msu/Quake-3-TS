/* Independent patch collision translated from id Software's cm_patch.c and cm_polylib.c.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later */
import { vec3, add3, sub3, scale3, dot3, length3, lerp3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec3, Plane, Bounds } from "../core/math.ts";
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import { CollisionWindingLibrary, windingBounds } from "./polylib.ts";
import type { CollisionWinding, CollisionWindingMemory } from "./polylib.ts";

interface Border { readonly plane: number; readonly inward: boolean; readonly noAdjust: boolean }
interface Facet { readonly surface: number; readonly borders: readonly Border[] }
export interface PatchCollide { readonly planes: readonly Plane[]; readonly facets: readonly Facet[]; readonly bounds: Bounds }
export type PatchAllocator = (source: "CM_GeneratePatchCollide" | "CM_PatchCollideFromGrid:facets" | "CM_PatchCollideFromGrid:planes", bytes: number) => HunkAllocation;
export type PatchShape = { readonly kind: "point"; readonly mins: Vec3; readonly extents: Vec3 }
  | { readonly kind: "box"; readonly mins: Vec3; readonly extents: Vec3 }
  | { readonly kind: "capsule"; readonly extents: Vec3; readonly radius: number; readonly offset: Vec3 };
export type CollisionDebugPolygon = (color: number, numPoints: number, points: readonly Vec3[]) => undefined;
interface CollisionDebugHost {
  readonly cvars: CvarRegistry;
  readonly print: (text: string) => undefined;
  readonly developerPrint: (text: string) => undefined;
  readonly windings?: CollisionWindingMemory;
}
type DebugBlock = readonly [Vec3, Vec3, Vec3, Vec3];

/** The common CM owner borrows this state across server and client collision worlds. */
export class CollisionDebugSurface {
  readonly windings: CollisionWindingLibrary;
  c_totalPatchBlocks = 0;
  c_totalPatchSurfaces = 0;
  c_totalPatchEdges = 0;
  #hit: { readonly patch: PatchCollide; readonly facet: Facet } | null = null;
  #debugBlock = false;
  #debugBlockPoints: DebugBlock = [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)];
  #pointUpdateRegistered = false;
  #shapeUpdateRegistered = false;
  #sizeRegistered = false;

  constructor(private readonly host: CollisionDebugHost) { this.windings = new CollisionWindingLibrary(host.windings ?? null); }

  printWinding(winding: CollisionWinding): void { this.windings.pw(winding, this.host.print); }
  print(text: string): void { this.host.print(text); }
  developerPrint(text: string): void { this.host.developerPrint(text); }

  clearLevelPatches(): undefined { this.#hit = null; }

  recordTrace(patch: PatchCollide, facet: Facet, isPoint: boolean): undefined {
    if (isPoint ? !this.#pointUpdateRegistered : !this.#shapeUpdateRegistered) {
      this.host.cvars.register("r_debugSurfaceUpdate", "1");
      if (isPoint) this.#pointUpdateRegistered = true;
      else this.#shapeUpdateRegistered = true;
    }
    if (this.cvar("r_debugSurfaceUpdate").integerValue !== 0) this.#hit = { patch, facet };
  }

  recordMixedBorder(points: DebugBlock): undefined {
    this.host.developerPrint("WARNING: CM_SetBorderInward: mixed plane sides\n");
    if (this.#debugBlock) return;
    this.#debugBlock = true;
    this.#debugBlockPoints = [vec3(points[0].x, points[0].y, points[0].z), vec3(points[1].x, points[1].y, points[1].z),
      vec3(points[2].x, points[2].y, points[2].z), vec3(points[3].x, points[3].y, points[3].z)];
  }

  /** CM_DrawDebugSurface's r_debugSurface == 1 branch; the engine owns bot routing. */
  draw(drawPoly: CollisionDebugPolygon): undefined {
    if (this.#hit === null) return;
    if (!this.#sizeRegistered) {
      this.host.cvars.register("cm_debugSize", "2");
      this.#sizeRegistered = true;
    }
    const patch = this.#hit.patch;
    for (const facet of patch.facets) {
      const planes: readonly Border[] = [...facet.borders, { plane: facet.surface, inward: false, noAdjust: false }];
      for (const border of planes) {
        const original = at(patch.planes, border.plane);
        let winding: CollisionWinding | null = this.windings.baseForPlane(this.debugPlane(original, border.inward, 1));
        for (const clip of planes) {
          if (winding === null) break;
          if (clip.plane === border.plane) continue;
          const clipPlane = at(patch.planes, clip.plane);
          winding = this.windings.chopInPlace(winding, this.debugPlane(clipPlane, !clip.inward, -1), Math.fround(0.1));
        }
        if (winding !== null) {
          drawPoly(facet === this.#hit?.facet ? 4 : 1, winding.numPoints, winding.points);
          this.windings.free(winding);
        }
        else this.host.print("winding chopped away by border planes\n");
      }
    }
    let points = this.#debugBlockPoints;
    drawPoly(2, 3, [vec3(points[0].x, points[0].y, points[0].z), vec3(points[1].x, points[1].y, points[1].z),
      vec3(points[2].x, points[2].y, points[2].z)]);
    points = this.#debugBlockPoints;
    drawPoly(2, 3, [vec3(points[2].x, points[2].y, points[2].z), vec3(points[3].x, points[3].y, points[3].z),
      vec3(points[0].x, points[0].y, points[0].z)]);
  }

  private debugPlane(plane: Plane, flip: boolean, direction: 1 | -1): Plane {
    const normal = flip ? sub3(vec3(0, 0, 0), plane.normal) : plane.normal;
    const corner = vec3(normal.x > 0 ? 15 : -15, normal.y > 0 ? 15 : -15, normal.z > 0 ? 28 : -28);
    const distance = Math.fround((flip ? -plane.distance : plane.distance) + direction * this.cvar("cm_debugSize").numericValue);
    return { normal, distance: Math.fround(distance + direction * Math.abs(patchDot(corner, scale3(normal, -1)))) };
  }

  private cvar(name: string): CvarSnapshot {
    const value = this.host.cvars.get(name);
    if (value === undefined) throw new Error(`Collision debug cvar ${name} is not registered`);
    return value;
  }
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`patch index ${index} out of range`);
  return value;
}
function negate(plane: Plane): Plane { return { normal: scale3(plane.normal, -1), distance: -plane.distance }; }
// Engine-side generation follows the native i386 gcc -O2 reference, not game QVM
// vector arithmetic: x87 keeps expression intermediates until float-array stores.
function patchDot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function patchCross(a: Vec3, b: Vec3): Vec3 { return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
function normalizePatchVector(value: Vec3): Vec3 {
  const length = Math.sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
  return length === 0 ? value : scale3(value, 1 / length);
}
function curveMidpoint(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return vec3(0.5 * (0.5 * (a.x + b.x) + 0.5 * (b.x + c.x)),
    0.5 * (0.5 * (a.y + b.y) + 0.5 * (b.y + c.y)), 0.5 * (0.5 * (a.z + b.z) + 0.5 * (b.z + c.z)));
}
function fromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const normal = normalizePatchVector(patchCross({ x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }, { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }));
  return length3(normal) === 0 ? null : { normal, distance: Math.fround(patchDot(a, normal)) };
}
function closePoints(a: Vec3, b: Vec3, epsilon = 0.1): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon && Math.abs(a.z - b.z) <= epsilon;
}
function planeEqual(a: Plane, b: Plane): boolean {
  return Math.abs(a.normal.x - b.normal.x) < 0.0001 && Math.abs(a.normal.y - b.normal.y) < 0.0001
    && Math.abs(a.normal.z - b.normal.z) < 0.0001 && Math.abs(a.distance - b.distance) < 0.02;
}
const storageViews = new WeakMap<HunkAllocation, { readonly bytes: Uint8Array; readonly view: DataView }>();
function storageView(allocation: HunkAllocation): DataView {
  const bytes = allocation.bytes;
  const cached = storageViews.get(allocation);
  if (cached !== undefined && cached.bytes === bytes) return cached.view;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  storageViews.set(allocation, { bytes, view });
  return view;
}
function storedVector(allocation: HunkAllocation, offset: number): Vec3 {
  return {
    get x(): number { return storageView(allocation).getFloat32(offset, true); },
    get y(): number { return storageView(allocation).getFloat32(offset + 4, true); },
    get z(): number { return storageView(allocation).getFloat32(offset + 8, true); },
  };
}
function normalSignbits(normal: Vec3): number {
  return Number(normal.x < 0) | (Number(normal.y < 0) << 1) | (Number(normal.z < 0) << 2);
}
class GeneratedPatchPlane implements Plane {
  readonly #signbits: number;
  constructor(readonly normal: Vec3, readonly distance: number) { this.#signbits = normalSignbits(normal); }
  get signbits(): number { return this.#signbits; }
}
class AllocatedPatchPlane implements Plane {
  readonly normal: Vec3;
  readonly #allocation: HunkAllocation;
  readonly #offset: number;
  constructor(allocation: HunkAllocation, offset: number) {
    this.#allocation = allocation; this.#offset = offset;
    this.normal = storedVector(allocation, offset);
  }
  get distance(): number { return storageView(this.#allocation).getFloat32(this.#offset + 12, true); }
  get signbits(): number { return storageView(this.#allocation).getInt32(this.#offset + 16, true); }
}
function planeSignbits(plane: Plane): number {
  if (plane instanceof GeneratedPatchPlane || plane instanceof AllocatedPatchPlane) return plane.signbits;
  // Diagnostic Plane literals have geometry only; generated patches retain the source field.
  return normalSignbits(plane.normal);
}
function storedRows<T>(rows: readonly T[], count: number): readonly T[] {
  if (count < 0 || count > rows.length) throw new RangeError("Patch count outside source allocation");
  return count === rows.length ? rows : rows.slice(0, count);
}
function storePatch(allocate: PatchAllocator, allocation: HunkAllocation, planes: readonly GeneratedPatchPlane[], facets: readonly Facet[]): PatchCollide {
  const record = storageView(allocation);
  record.setInt32(24, planes.length, true);
  record.setInt32(32, facets.length, true);
  const facetAllocation = allocate("CM_PatchCollideFromGrid:facets", facets.length * 320);
  record.setUint32(36, facetAllocation.byteOffset, true);
  const facetData = storageView(facetAllocation);
  for (const [index, facet] of facets.entries()) {
    const offset = index * 320;
    facetData.setInt32(offset, facet.surface, true);
    facetData.setInt32(offset + 4, facet.borders.length, true);
    for (const [borderIndex, border] of facet.borders.entries()) {
      if (borderIndex >= 26) throw new RangeError("Patch border outside source facet allocation");
      facetData.setInt32(offset + 8 + borderIndex * 4, border.plane, true);
      facetData.setInt32(offset + 112 + borderIndex * 4, Number(border.inward), true);
      facetData.setInt32(offset + 216 + borderIndex * 4, Number(border.noAdjust), true);
    }
  }
  const planeAllocation = allocate("CM_PatchCollideFromGrid:planes", planes.length * 20);
  record.setUint32(28, planeAllocation.byteOffset, true);
  const planeData = storageView(planeAllocation);
  for (const [index, plane] of planes.entries()) {
    const offset = index * 20, normal = plane.normal;
    planeData.setFloat32(offset, normal.x, true);
    planeData.setFloat32(offset + 4, normal.y, true);
    planeData.setFloat32(offset + 8, normal.z, true);
    planeData.setFloat32(offset + 12, plane.distance, true);
    planeData.setInt32(offset + 16, plane.signbits, true);
  }
  const storedPlanes = planes.map((_, index) => new AllocatedPatchPlane(planeAllocation, index * 20));
  const storedFacets = facets.map((_, index) => {
    const borders = Array.from({ length: 26 }, (_, border) => ({
      get plane(): number { return storageView(facetAllocation).getInt32(index * 320 + 8 + border * 4, true); },
      get inward(): boolean { return storageView(facetAllocation).getInt32(index * 320 + 112 + border * 4, true) !== 0; },
      get noAdjust(): boolean { return storageView(facetAllocation).getInt32(index * 320 + 216 + border * 4, true) !== 0; },
    }));
    return {
      get surface(): number { return storageView(facetAllocation).getInt32(index * 320, true); },
      get borders(): readonly Border[] { return storedRows(borders, storageView(facetAllocation).getInt32(index * 320 + 4, true)); },
    };
  });
  return {
    bounds: { min: storedVector(allocation, 0), max: storedVector(allocation, 12) },
    get planes(): readonly Plane[] {
      const data = storageView(allocation);
      if (data.getUint32(28, true) !== planeAllocation.byteOffset) throw new RangeError("Patch plane pointer outside source allocation");
      return storedRows(storedPlanes, data.getInt32(24, true));
    },
    get facets(): readonly Facet[] {
      const data = storageView(allocation);
      if (data.getUint32(36, true) !== facetAllocation.byteOffset) throw new RangeError("Patch facet pointer outside source allocation");
      return storedRows(storedFacets, data.getInt32(32, true));
    },
  };
}

export function generatePatchCollide(width: number, height: number, points: readonly Vec3[], debug: CollisionDebugSurface | null = null,
  allocate: PatchAllocator | null = null): PatchCollide {
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new RangeError("collision patch requires integer dimensions");
  if (width <= 2 || height <= 2) throw new CommonError("drop", `CM_GeneratePatchFacets: bad parameters: (${width}, ${height}, managed points)`);
  if (width % 2 === 0 || height % 2 === 0) throw new CommonError("drop", "CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes");
  if (width > 129 || height > 129) throw new CommonError("drop", "CM_GeneratePatchFacets: source is > MAX_GRID_SIZE");
  if (points.length !== width * height) throw new RangeError("collision patch requires a complete control grid");
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) throw new RangeError("nonfinite patch control point");
  let columns: Vec3[][] = Array.from({ length: width }, (_, x) => Array.from({ length: height }, (_, y) => at(points, y * width + x)));
  const wrapped = (): boolean => at(columns, 0).every((p, y) => closePoints(p, at(at(columns, columns.length - 1), y)));
  const wrapHeight = wrapped();
  const subdivide = (): void => {
    for (let i = 0; i < columns.length - 2;) {
      const a = at(columns, i), b = at(columns, i + 1), c = at(columns, i + 2);
      const needed = a.some((p, y) => length3(sub3(curveMidpoint(p, at(b, y), at(c, y)), lerp3(p, at(c, y), 0.5))) >= 16);
      if (!needed) { columns.splice(i + 1, 1); i++; continue; }
      if (columns.length + 2 > 129) throw new RangeError("collision subdivision exceeds MAX_GRID_SIZE");
      const first = a.map((p, y) => lerp3(p, at(b, y), 0.5));
      const last = b.map((p, y) => lerp3(p, at(c, y), 0.5));
      columns.splice(i + 1, 1, first, a.map((p, y) => curveMidpoint(p, at(b, y), at(c, y))), last);
    }
    for (let i = 0; i < columns.length - 1;) {
      if (at(columns, i).every((p, y) => closePoints(p, at(at(columns, i + 1), y)))) columns.splice(i + 1, 1);
      else i++;
    }
  };
  subdivide();
  const old = columns;
  columns = Array.from({ length: height }, (_, y) => old.map(column => at(column, y)));
  const wrapWidth = wrapped();
  subdivide();
  width = columns.length; height = at(columns, 0).length;
  const allocation = allocate === null ? null : allocate("CM_GeneratePatchCollide", 40);
  const bounds = windingBounds(columns.flat());
  if (allocation !== null) {
    const target = storageView(allocation);
    for (const [index, value] of [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].entries()) {
      target.setFloat32(index * 4, value, true);
    }
  }
  if (debug !== null) debug.c_totalPatchBlocks = (debug.c_totalPatchBlocks + (width - 1) * (height - 1)) | 0;
  const windings = debug?.windings ?? new CollisionWindingLibrary();
  const p = (x: number, y: number): Vec3 => at(at(columns, x), y);
  const planes: GeneratedPatchPlane[] = [];
  const findPlane = (a: Vec3, b: Vec3, c: Vec3): number => {
    const plane = fromPoints(a, b, c);
    if (plane === null) return -1;
    const found = planes.findIndex(existing => patchDot(plane.normal, existing.normal) >= 0 && [a, b, c].every(point => Math.abs(Math.fround(patchDot(point, existing.normal) - existing.distance)) <= 0.1));
    if (found !== -1) return found;
    if (planes.length === 2048) throw new CommonError("drop", "MAX_PATCH_PLANES");
    planes.push(new GeneratedPatchPlane(plane.normal, plane.distance)); return planes.length - 1;
  };
  const findPlane2 = (plane: Plane): Border => {
    for (const [index, existing] of planes.entries()) {
      if (planeEqual(existing, plane)) return { plane: index, inward: false, noAdjust: false };
      if (planeEqual(existing, negate(plane))) return { plane: index, inward: true, noAdjust: false };
    }
    if (planes.length === 2048) throw new CommonError("drop", "MAX_PATCH_PLANES");
    planes.push(new GeneratedPatchPlane(plane.normal, plane.distance)); return { plane: planes.length - 1, inward: false, noAdjust: false };
  };
  const gridPlanes: (readonly [number, number])[][] = Array.from({ length: width - 1 }, (_, x) =>
    Array.from({ length: height - 1 }, (_, y) => [findPlane(p(x, y), p(x + 1, y), p(x + 1, y + 1)), findPlane(p(x + 1, y + 1), p(x, y + 1), p(x, y))]));
  const gp = (x: number, y: number, triangle: 0 | 1): number => at(at(gridPlanes, x), y)[triangle];
  const edgePlane = (x: number, y: number, edge: number): number => {
    let a: Vec3, b: Vec3, base: Vec3, triangle: 0 | 1;
    switch (edge) {
      case 0: a = p(x, y); b = p(x + 1, y); base = a; triangle = 0; break;
      case 1: a = p(x + 1, y); b = p(x + 1, y + 1); base = a; triangle = 0; break;
      case 2: b = p(x, y + 1); a = p(x + 1, y + 1); base = b; triangle = 1; break;
      case 3: b = p(x, y); a = p(x, y + 1); base = b; triangle = 1; break;
      case 4: a = p(x + 1, y + 1); b = p(x, y); base = a; triangle = 0; break;
      case 5: a = p(x, y); b = p(x + 1, y + 1); base = a; triangle = 1; break;
      default: throw new RangeError("unknown patch edge");
    }
    let planeIndex = gp(x, y, triangle);
    if (planeIndex === -1) planeIndex = gp(x, y, triangle === 0 ? 1 : 0);
    if (planeIndex === -1) {
      debug?.print("WARNING: CM_GridPlane unresolvable\n");
      return -1;
    }
    return findPlane(a, b, add3(base, scale3(at(planes, planeIndex).normal, 4)));
  };
  const facets: Facet[] = [];
  const makeFacet = (surface: number, rawBorders: readonly number[], noAdjust: readonly boolean[], vertices: readonly Vec3[], block: DebugBlock): void => {
    const borders: Border[] = [];
    for (const [borderIndex, index] of rawBorders.entries()) {
      if (index === -1) { borders.push({ plane: -1, inward: false, noAdjust: at(noAdjust, borderIndex) }); continue; }
      const plane = at(planes, index);
      const ds = vertices.map(point => Math.fround(patchDot(point, plane.normal) - plane.distance));
      const front = ds.some(d => d > 0.1), back = ds.some(d => d < -0.1);
      if (!front && !back) { borders.push({ plane: -1, inward: false, noAdjust: at(noAdjust, borderIndex) }); continue; }
      if (front && back) debug?.recordMixedBorder(block);
      borders.push({ plane: index, inward: front && !back, noAdjust: at(noAdjust, borderIndex) });
    }
    if (surface === -1) return;
    let winding: CollisionWinding | null = windings.baseForPlane(at(planes, surface));
    for (const border of borders) {
      if (winding === null) break;
      // CM_ValidateFacet leaves this allocation live when a border is invalid.
      if (border.plane === -1) return;
      winding = windings.chopInPlace(winding, border.inward ? at(planes, border.plane) : negate(at(planes, border.plane)));
    }
    if (winding === null) return;
    const bounds = windings.bounds(winding);
    windings.free(winding);
    const delta = sub3(bounds.max, bounds.min);
    if (delta.x > 65535 || delta.y > 65535 || delta.z > 65535 || bounds.min.x >= 65535 || bounds.min.y >= 65535 || bounds.min.z >= 65535 || bounds.max.x <= -65535 || bounds.max.y <= -65535 || bounds.max.z <= -65535) return;
    // CM_AddFacetBevels starts a second winding after validation frees the first.
    winding = windings.baseForPlane(at(planes, surface));
    for (const border of borders) {
      if (winding === null) break;
      if (border.plane === surface) continue;
      winding = windings.chopInPlace(winding, border.inward ? at(planes, border.plane) : negate(at(planes, border.plane)));
    }
    if (winding === null) { facets.push({ surface, borders }); return; }
    const bevelBounds = windings.bounds(winding), windingPoints = winding.points;
    const duplicate = (plane: Plane): boolean => [surface, ...borders.map(border => border.plane)].some(index => planeEqual(at(planes, index), plane) || planeEqual(at(planes, index), negate(plane)));
    const axes = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    for (const axis of axes) for (const direction of [-1, 1]) {
      const normal = scale3(axis, direction);
      const distance = direction === 1 ? dot3(normal, bevelBounds.max) : dot3(normal, bevelBounds.min);
      const plane = { normal, distance };
      if (!duplicate(plane)) {
        if (borders.length > 26) debug?.print("ERROR: too many bevels\n");
        borders.push(findPlane2(plane));
      }
    }
    for (let j = 0; j < windingPoints.length; j++) {
      const difference = sub3(at(windingPoints, j), at(windingPoints, (j + 1) % windingPoints.length));
      if (length3(difference) < 0.5) continue;
      let edge = normalizePatchVector(difference);
      for (const axis of axes) {
        const component = dot3(edge, axis);
        if (Math.abs(component - 1) < 0.0001) { edge = axis; break; }
        if (Math.abs(component + 1) < 0.0001) { edge = scale3(axis, -1); break; }
      }
      if (Math.abs(edge.x) === 1 || Math.abs(edge.y) === 1 || Math.abs(edge.z) === 1) continue;
      for (const axis of axes) for (const direction of [-1, 1]) {
        const rawNormal = patchCross(edge, scale3(axis, direction));
        if (length3(rawNormal) < 0.5) continue;
        const normal = normalizePatchVector(rawNormal);
        const plane: Plane = { normal, distance: Math.fround(patchDot(at(windingPoints, j), normal)) };
        if (windingPoints.some(point => Math.fround(patchDot(point, normal) - plane.distance) > 0.1) || duplicate(plane)) continue;
        if (borders.length > 26) debug?.print("ERROR: too many bevels\n");
        const border = findPlane2(plane);
        for (const existing of borders) if (existing.plane === border.plane) debug?.print("WARNING: bevel plane already used\n");
        const clipped = windings.chopInPlace(windings.copy(winding), border.inward ? at(planes, border.plane) : negate(at(planes, border.plane)));
        if (clipped === null) { debug?.developerPrint("WARNING: CM_AddFacetBevels... invalid bevel\n"); continue; }
        windings.free(clipped);
        borders.push(border);
      }
    }
    windings.free(winding);
    borders.push({ plane: surface, inward: true, noAdjust: false });
    if (borders.length > 27) throw new RangeError("collision patch exceeds facet border storage");
    facets.push({ surface, borders });
  };
  for (let x = 0; x < width - 1; x++) for (let y = 0; y < height - 1; y++) {
    const first = gp(x, y, 0), second = gp(x, y, 1);
    let top = y > 0 ? gp(x, y - 1, 1) : wrapHeight ? gp(x, height - 2, 1) : -1;
    let bottom = y < height - 2 ? gp(x, y + 1, 0) : wrapHeight ? gp(x, 0, 0) : -1;
    let left = x > 0 ? gp(x - 1, y, 0) : wrapWidth ? gp(width - 2, y, 0) : -1;
    let right = x < width - 2 ? gp(x + 1, y, 1) : wrapWidth ? gp(0, y, 1) : -1;
    const noTop = top === first, noBottom = bottom === second, noLeft = left === second, noRight = right === first;
    if (top === -1 || top === first) top = edgePlane(x, y, 0);
    if (bottom === -1 || bottom === second) bottom = edgePlane(x, y, 2);
    if (left === -1 || left === second) left = edgePlane(x, y, 3);
    if (right === -1 || right === first) right = edgePlane(x, y, 1);
    if (facets.length === 1024) throw new CommonError("drop", "MAX_FACETS");
    const block: DebugBlock = [p(x, y), p(x + 1, y), p(x + 1, y + 1), p(x, y + 1)];
    if (first === second) {
      if (first !== -1) makeFacet(first, [top, right, bottom, left], [noTop, noRight, noBottom, noLeft], block, block);
    }
    else {
      makeFacet(first, [top, right, second !== -1 ? second : bottom !== -1 ? bottom : edgePlane(x, y, 4)], [noTop, noRight, false], [p(x, y), p(x + 1, y), p(x + 1, y + 1)], block);
      if (facets.length === 1024) throw new CommonError("drop", "MAX_FACETS");
      makeFacet(second, [bottom, left, first !== -1 ? first : top !== -1 ? top : edgePlane(x, y, 5)], [noBottom, noLeft, false], [p(x + 1, y + 1), p(x, y + 1), p(x, y)], block);
    }
  }
  if (allocation !== null && allocate !== null) {
    const patch = storePatch(allocate, allocation, planes, facets);
    const target = storageView(allocation);
    for (let axis = 0; axis < 3; axis++) target.setFloat32(axis * 4, target.getFloat32(axis * 4, true) - 1, true);
    for (let axis = 0; axis < 3; axis++) target.setFloat32(12 + axis * 4, target.getFloat32(12 + axis * 4, true) + 1, true);
    return patch;
  }
  return { planes, facets, bounds: { min: sub3(bounds.min, vec3(1, 1, 1)), max: add3(bounds.max, vec3(1, 1, 1)) } };
}

function boxOffset(plane: Plane, normal: Vec3, mins: Vec3, extents: Vec3): number {
  const signbits = planeSignbits(plane);
  if (signbits < 0 || signbits >= 8) throw new RangeError("CM patch plane signbits outside trace offsets");
  // cm_trace.c's eight centered-box corners, indexed by the original plane's stored signs.
  return patchDot({ x: (signbits & 1) !== 0 ? extents.x : mins.x,
    y: (signbits & 2) !== 0 ? extents.y : mins.y, z: (signbits & 4) !== 0 ? extents.z : mins.z }, normal);
}
function expanded(source: Plane, shape: PatchShape, border: Border | null = null): Plane {
  const plane = border?.inward === true ? negate(source) : source;
  if (shape.kind === "point") return plane;
  const n = plane.normal;
  if (shape.kind === "capsule") {
    const offset = shape.radius + Math.abs(dot3(n, shape.offset));
    return { normal: n, distance: Math.fround(plane.distance + offset) };
  }
  const offset = boxOffset(source, n, shape.mins, shape.extents);
  return { normal: n, distance: Math.fround(plane.distance + (border === null ? -offset : Math.abs(offset))) };
}

export function positionInPatch(patch: PatchCollide, start: Vec3, shape: PatchShape): boolean {
  if (shape.kind === "point") return false;
  return patch.facets.some(facet => {
    const surface = expanded(at(patch.planes, facet.surface), shape);
    if (dot3(start, surface.normal) > surface.distance) return false;
    return facet.borders.every(border => {
      const plane = expanded(at(patch.planes, border.plane), shape, border);
      return dot3(start, plane.normal) <= plane.distance;
    });
  });
}

export function tracePatch(patch: PatchCollide, start: Vec3, end: Vec3, shape: PatchShape, maxFraction = 1, debug: CollisionDebugSurface | null = null): { readonly fraction: number; readonly plane: Plane } | null {
  let result: { fraction: number; plane: Plane } | null = null;
  let fraction = maxFraction;
  if (shape.kind === "point") {
    const relationships = patch.planes.map(plane => {
      const offset = boxOffset(plane, plane.normal, shape.mins, shape.extents);
      const d1 = Math.fround(dot3(start, plane.normal) - plane.distance + offset), d2 = Math.fround(dot3(end, plane.normal) - plane.distance + offset);
      const crossing = d1 === d2 ? 99999 : Math.fround(d1 / (d1 - d2));
      return { front: d1 > 0, intersection: crossing <= 0 ? 99999 : crossing };
    });
    for (const facet of patch.facets) {
      const surface = at(relationships, facet.surface);
      if (!surface.front || surface.intersection > fraction) continue;
      if (!facet.borders.every(border => {
        const side = at(relationships, border.plane);
        return side.front !== border.inward ? side.intersection <= surface.intersection : side.intersection >= surface.intersection;
      })) continue;
      debug?.recordTrace(patch, facet, true);
      const plane = at(patch.planes, facet.surface), offset = boxOffset(plane, plane.normal, shape.mins, shape.extents);
      const d1 = Math.fround(dot3(start, plane.normal) - plane.distance + offset), d2 = Math.fround(dot3(end, plane.normal) - plane.distance + offset);
      fraction = Math.max(0, Math.fround((d1 - 0.125) / (d1 - d2)));
      result = { fraction, plane: { normal: vec3(plane.normal.x, plane.normal.y, plane.normal.z), distance: plane.distance } };
    }
    return result;
  }
  for (const facet of patch.facets) {
    let enter = -1, leave = 1, hitIndex = -1;
    let best: Plane | null = null;
    const clip = (plane: Plane, index: number): boolean => {
      const d1 = Math.fround(dot3(start, plane.normal) - plane.distance), d2 = Math.fround(dot3(end, plane.normal) - plane.distance);
      if (d1 > 0 && (d2 >= 0.125 || d2 >= d1)) return false;
      if (d1 <= 0 && d2 <= 0) return true;
      if (d1 > d2) {
        const f = Math.max(0, Math.fround((d1 - 0.125) / (d1 - d2)));
        if (f > enter) {
          enter = f; hitIndex = index;
          best = shape.kind === "capsule" ? { normal: plane.normal, distance: Math.fround(plane.distance - Math.abs(dot3(plane.normal, shape.offset))) } : plane;
        }
      } else leave = Math.min(leave, Math.min(1, Math.fround((d1 + 0.125) / (d1 - d2))));
      return true;
    };
    if (!clip(expanded(at(patch.planes, facet.surface), shape), -1)) continue;
    let valid = true;
    for (const [index, border] of facet.borders.entries()) {
      const plane = at(patch.planes, border.plane);
      if (!clip(expanded(plane, shape, border), index)) { valid = false; break; }
    }
    if (valid && hitIndex !== facet.borders.length - 1 && enter < leave && enter >= 0 && enter < fraction && best !== null) {
      debug?.recordTrace(patch, facet, false);
      fraction = enter; result = { fraction, plane: best };
    }
  }
  return result;
}
