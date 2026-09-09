// Translated from id Software's code/qcommon/cm_polylib.c and cm_polylib.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";
import { add3, sub3, scale3, vec3 } from "../core/math.ts";
import type { Bounds, Plane, Vec3 } from "../core/math.ts";
import type { ZoneAllocation } from "../core/zone.ts";
import { float32ToBits } from "../core/numeric.ts";

export interface CollisionWindingMemory {
  allocate(bytes: number): ZoneAllocation;
  free(allocation: ZoneAllocation): void;
}
export enum WindingSide { Front = 0, Back = 1, On = 2, Cross = 3 }
const ON_EPSILON = Math.fround(0.1);
const MAX_MAP_BOUNDS = 65535;

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Winding point ${index} outside allocation`);
  return value;
}
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a: Vec3, b: Vec3): Vec3 { return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
function normalize(value: Vec3): Vec3 {
  const length = Math.sqrt(dot(value, value));
  return length === 0 ? vec3(0, 0, 0) : scale3(value, 1 / length);
}
function fixed(value: number, digits: 1 | 6): string {
  const bits = float32ToBits(value), negative = (bits >>> 31) !== 0, exponent = (bits >>> 23) & 255;
  if (exponent === 255) return Number.isNaN(value) ? negative ? "-nan" : "nan" : negative ? "-inf" : "inf";
  const mantissa = BigInt((bits & 0x7fffff) | (exponent === 0 ? 0 : 0x800000));
  const shift = exponent === 0 ? -149 : exponent - 150;
  let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift); else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator;
  const remainder = (numerator % denominator) * 2n;
  if (remainder > denominator || (remainder === denominator && (rounded & 1n) !== 0n)) rounded++;
  const text = rounded.toString().padStart(digits + 1, "0");
  return `${negative ? "-" : ""}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** The count and float cells live in the source allocation, including unused capacity. */
export class CollisionWinding {
  #freed = false;
  constructor(readonly allocation: ZoneAllocation, readonly capacity: number) {}
  private view(): DataView {
    if (this.#freed) throw new RangeError("Winding allocation is freed");
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get numPoints(): number { return this.view().getInt32(0, true); }
  set numPoints(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > this.capacity) throw new RangeError("Winding count outside allocation");
    this.view().setInt32(0, value, true);
  }
  get points(): readonly Vec3[] { return Array.from({ length: this.numPoints }, (_, index) => this.point(index)); }
  point(index: number): Vec3 {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacity) throw new RangeError(`Winding point ${index} outside allocation`);
    const data = this.view(), offset = 4 + index * 12;
    return vec3(data.getFloat32(offset, true), data.getFloat32(offset + 4, true), data.getFloat32(offset + 8, true));
  }
  setPoint(index: number, point: Vec3): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacity) throw new RangeError(`Winding point ${index} outside allocation`);
    const data = this.view(), offset = 4 + index * 12;
    data.setFloat32(offset, point.x, true); data.setFloat32(offset + 4, point.y, true); data.setFloat32(offset + 8, point.z, true);
  }
  append(point: Vec3): void { const index = this.numPoints; this.setPoint(index, point); this.numPoints = index + 1; }
  markFreed(): void {
    if (this.#freed || this.view().getUint32(0, true) === 0xdeaddead) throw new CommonError("fatal", "FreeWinding: freed a freed winding");
    this.view().setUint32(0, 0xdeaddead, true);
    this.#freed = true;
  }
}

/** Common-lived counters and the actual zone used by patch generation and debug drawing. */
export class CollisionWindingLibrary {
  c_active_windings = 0;
  c_peak_windings = 0;
  c_winding_allocs = 0;
  c_winding_points = 0;
  c_removed = 0;
  constructor(private readonly memory: CollisionWindingMemory | null = null) {}

  alloc(points: number): CollisionWinding {
    this.c_winding_allocs = (this.c_winding_allocs + 1) | 0;
    this.c_winding_points = (this.c_winding_points + points) | 0;
    this.c_active_windings = (this.c_active_windings + 1) | 0;
    if (this.c_active_windings > this.c_peak_windings) this.c_peak_windings = this.c_active_windings;
    if (!Number.isInteger(points) || points < 0 || points > (0x7fffffff - 4) / 12) throw new RangeError("Invalid winding allocation size");
    const size = 4 + points * 12;
    const allocation = this.memory === null ? { bytes: new Uint8Array(size) } : this.memory.allocate(size);
    allocation.bytes.fill(0);
    return new CollisionWinding(allocation, points);
  }
  free(winding: CollisionWinding): void {
    winding.markFreed();
    this.c_active_windings = (this.c_active_windings - 1) | 0;
    this.memory?.free(winding.allocation);
  }
  pw(winding: CollisionWinding, print: (text: string) => void): void {
    for (const p of winding.points) print(`(${fixed(p.x, 1).padStart(5)}, ${fixed(p.y, 1).padStart(5)}, ${fixed(p.z, 1).padStart(5)})\n`);
  }
  copy(winding: CollisionWinding): CollisionWinding {
    const copy = this.alloc(winding.numPoints);
    copy.allocation.bytes.set(winding.allocation.bytes.subarray(0, 4 + winding.numPoints * 12));
    return copy;
  }
  reverse(winding: CollisionWinding): CollisionWinding {
    const copy = this.alloc(winding.numPoints);
    for (let i = winding.numPoints - 1; i >= 0; i--) copy.append(winding.point(i));
    return copy;
  }
  removeColinearPoints(winding: CollisionWinding): void {
    const points = winding.points, kept: Vec3[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = at(points, i);
      const a = normalize(sub3(at(points, (i + 1) % points.length), p));
      const b = normalize(sub3(p, at(points, (i + points.length - 1) % points.length)));
      if (dot(a, b) < 0.999) kept.push(p);
    }
    if (kept.length === points.length) return;
    this.c_removed = (this.c_removed + points.length - kept.length) | 0;
    winding.numPoints = kept.length;
    for (const [i, p] of kept.entries()) winding.setPoint(i, p);
  }
  plane(winding: CollisionWinding): Plane {
    const p = winding.point(0);
    const normal = normalize(cross(sub3(winding.point(2), p), sub3(winding.point(1), p)));
    return { normal, distance: Math.fround(dot(p, normal)) };
  }
  area(winding: CollisionWinding): number {
    let total = 0;
    for (let i = 2; i < winding.numPoints; i++) {
      const c = cross(sub3(winding.point(i - 1), winding.point(0)), sub3(winding.point(i), winding.point(0)));
      total = Math.fround(total + 0.5 * Math.sqrt(dot(c, c)));
    }
    return total;
  }
  bounds(winding: CollisionWinding): Bounds { return windingBounds(winding.points); }
  center(winding: CollisionWinding): Vec3 {
    let sum = vec3(0, 0, 0);
    for (const p of winding.points) sum = add3(p, sum);
    return scale3(sum, Math.fround(1 / winding.numPoints));
  }
  baseForPlane(plane: Plane): CollisionWinding {
    const n = plane.normal;
    let maximum = -MAX_MAP_BOUNDS, major = -1;
    for (const [axis, component] of [n.x, n.y, n.z].entries()) {
      const magnitude = Math.abs(component);
      if (magnitude > maximum) { maximum = magnitude; major = axis; }
    }
    if (major === -1) throw new CommonError("drop", "BaseWindingForPlane: no axis found");
    const initial = major === 2 ? vec3(1, 0, 0) : vec3(0, 0, 1);
    const projected = dot(initial, n);
    const up = normalize(vec3(initial.x - projected * n.x, initial.y - projected * n.y, initial.z - projected * n.z));
    // Preserve the retained i386 x87 spill and extended reciprocal profile.
    const right = vec3((Math.fround(up.y * n.z) - up.z * n.y) * 65535, (up.z * n.x - up.x * n.z) * 65535, (up.x * n.y - up.y * n.x) * 65535);
    const vertical = scale3(up, 65535), origin = scale3(n, plane.distance);
    const result = this.alloc(4);
    result.append(vec3(origin.x - right.x + vertical.x, origin.y - right.y + vertical.y, origin.z - right.z + vertical.z));
    result.append(vec3(origin.x + right.x + vertical.x, origin.y + right.y + vertical.y, origin.z + right.z + vertical.z));
    result.append(vec3(origin.x + right.x - vertical.x, origin.y + right.y - vertical.y, origin.z + right.z - vertical.z));
    result.append(vec3(origin.x - right.x - vertical.x, origin.y - right.y - vertical.y, origin.z - right.z - vertical.z));
    return result;
  }

  clip(winding: CollisionWinding, plane: Plane, epsilon: number): { readonly front: CollisionWinding | null; readonly back: CollisionWinding | null } {
    const points = winding.points, distances = points.map(p => Math.fround(dot(p, plane.normal) - plane.distance));
    if (!distances.some(d => d > epsilon)) return { front: null, back: this.copy(winding) };
    if (!distances.some(d => d < -epsilon)) return { front: this.copy(winding), back: null };
    const front = this.alloc(points.length + 4), back = this.alloc(points.length + 4);
    this.split(points, distances, plane, epsilon, front, back);
    this.checkClipCounts(front, back);
    return { front, back };
  }
  chopInPlace(winding: CollisionWinding, plane: Plane, epsilon = ON_EPSILON): CollisionWinding | null {
    const points = winding.points, distances = points.map(p => Math.fround(dot(p, plane.normal) - plane.distance));
    if (!distances.some(d => d > epsilon)) { this.free(winding); return null; }
    if (!distances.some(d => d < -epsilon)) return winding;
    const front = this.alloc(points.length + 4);
    this.split(points, distances, plane, epsilon, front, null);
    this.checkClipCounts(front, null);
    this.free(winding);
    return front;
  }
  private split(points: readonly Vec3[], distances: readonly number[], plane: Plane, epsilon: number,
    front: CollisionWinding, back: CollisionWinding | null): void {
    for (let i = 0; i < points.length; i++) {
      const p = at(points, i), d1 = at(distances, i), next = (i + 1) % points.length, d2 = at(distances, next);
      const side1 = d1 > epsilon ? WindingSide.Front : d1 < -epsilon ? WindingSide.Back : WindingSide.On;
      const side2 = d2 > epsilon ? WindingSide.Front : d2 < -epsilon ? WindingSide.Back : WindingSide.On;
      if (side1 === WindingSide.On) { front.append(p); back?.append(p); continue; }
      if (side1 === WindingSide.Front) front.append(p); else back?.append(p);
      if (side2 === WindingSide.On || side1 === side2) continue;
      const q = at(points, next), fraction = d1 / (d1 - d2), n = plane.normal;
      const mid = vec3(n.x === 1 ? plane.distance : n.x === -1 ? -plane.distance : p.x + fraction * (q.x - p.x),
        n.y === 1 ? plane.distance : n.y === -1 ? -plane.distance : p.y + fraction * (q.y - p.y),
        n.z === 1 ? plane.distance : n.z === -1 ? -plane.distance : p.z + fraction * (q.z - p.z));
      front.append(mid); back?.append(mid);
    }
  }
  private checkClipCounts(front: CollisionWinding, back: CollisionWinding | null): void {
    if (front.numPoints > front.capacity || (back !== null && back.numPoints > back.capacity)) throw new CommonError("drop", "ClipWinding: points exceeded estimate");
    if (front.numPoints > 64 || (back !== null && back.numPoints > 64)) throw new CommonError("drop", "ClipWinding: MAX_POINTS_ON_WINDING");
  }
  chop(winding: CollisionWinding, plane: Plane): CollisionWinding | null {
    const { front, back } = this.clip(winding, plane, ON_EPSILON);
    this.free(winding);
    if (back !== null) this.free(back);
    return front;
  }
  onPlaneSide(winding: CollisionWinding, plane: Plane): WindingSide {
    let front = false, back = false;
    for (const p of winding.points) {
      const d = Math.fround(dot(p, plane.normal) - plane.distance);
      if (d < -ON_EPSILON) { if (front) return WindingSide.Cross; back = true; continue; }
      if (d > ON_EPSILON) { if (back) return WindingSide.Cross; front = true; }
    }
    return back ? WindingSide.Back : front ? WindingSide.Front : WindingSide.On;
  }
  check(winding: CollisionWinding): void {
    if (winding.numPoints < 3) throw new CommonError("drop", `CheckWinding: ${winding.numPoints} points`);
    const area = this.area(winding);
    if (area < 1) throw new CommonError("drop", `CheckWinding: ${fixed(area, 6)} area`);
    const face = this.plane(winding), points = winding.points;
    for (const [i, p] of points.entries()) {
      for (const value of [p.x, p.y, p.z]) if (value > MAX_MAP_BOUNDS || value < -MAX_MAP_BOUNDS) throw new CommonError("drop", `CheckFace: BUGUS_RANGE: ${fixed(value, 6)}`);
      const distance = Math.fround(dot(p, face.normal) - face.distance);
      if (distance < -ON_EPSILON || distance > ON_EPSILON) throw new CommonError("drop", "CheckWinding: point off plane");
      const dir = sub3(at(points, (i + 1) % points.length), p);
      if (Math.sqrt(dot(dir, dir)) < ON_EPSILON) throw new CommonError("drop", "CheckWinding: degenerate edge");
      const edgeNormal = normalize(cross(face.normal, dir));
      const edgeDistance = Math.fround(Math.fround(dot(p, edgeNormal)) + ON_EPSILON);
      for (const [j, q] of points.entries()) if (j !== i && Math.fround(dot(q, edgeNormal)) > edgeDistance) throw new CommonError("drop", "CheckWinding: non-convex");
    }
  }
  addToConvexHull(winding: CollisionWinding, hull: CollisionWinding | null, normal: Vec3): CollisionWinding {
    if (hull === null) return this.copy(winding);
    let points = hull.points;
    for (const p of winding.points) {
      const directions = points.map((q, j) => cross(normal, normalize(sub3(at(points, (j + 1) % points.length), q))));
      const distances = points.map((q, j) => Math.fround(dot(sub3(p, q), at(directions, j))));
      if (!distances.some(d => d >= ON_EPSILON)) continue;
      const sides = distances.map(d => d >= -ON_EPSILON);
      const transition = sides.findIndex((side, j) => !side && at(sides, (j + 1) % sides.length));
      if (transition === -1) continue;
      const next: Vec3[] = [p], start = (transition + 1) % points.length;
      for (let k = 0; k < points.length; k++) {
        if (at(sides, (start + k) % points.length) && at(sides, (start + k + 1) % points.length)) continue;
        next.push(at(points, (start + k + 1) % points.length));
      }
      if (next.length > 128) throw new RangeError("Winding convex hull exceeds MAX_HULL_POINTS");
      points = next;
    }
    this.free(hull);
    const result = this.alloc(points.length);
    for (const p of points) result.append(p);
    return result;
  }
}

/** WindingBounds also serves patch grid bounds before there is a winding allocation. */
export function windingBounds(points: readonly Vec3[]): Bounds {
  let min = vec3(MAX_MAP_BOUNDS, MAX_MAP_BOUNDS, MAX_MAP_BOUNDS), max = vec3(-MAX_MAP_BOUNDS, -MAX_MAP_BOUNDS, -MAX_MAP_BOUNDS);
  for (const p of points) {
    min = vec3(p.x < min.x ? p.x : min.x, p.y < min.y ? p.y : min.y, p.z < min.z ? p.z : min.z);
    max = vec3(p.x > max.x ? p.x : max.x, p.y > max.y ? p.y : max.y, p.z > max.z ? p.z : max.z);
  }
  return { min, max };
}
