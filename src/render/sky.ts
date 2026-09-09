// Sky polygon projection, cube subdivision and spherical cloud coordinates
// translated from id Software's GPL-2.0-or-later code/renderer/tr_sky.c.
import type { BspVertex } from "../assets/bsp.ts";
import { add3, dot3, normalize3, scale3, sub3 } from "../core/math.ts";
import type { Vec2, Vec3 } from "../core/math.ts";
import type { DeformGeometry } from "./deform.ts";

export interface SkyFace {
  readonly face: number;
  readonly geometry: DeformGeometry;
  readonly strips: readonly (readonly number[])[];
}
export interface SkyGeometry { readonly box: readonly SkyFace[]; readonly clouds: DeformGeometry }
interface FaceBounds { minS: number; minT: number; maxS: number; maxT: number }
const CLIP_PLANES: readonly Vec3[] = [{ x: 1, y: 1, z: 0 }, { x: 1, y: -1, z: 0 }, { x: 0, y: -1, z: 1 },
  { x: 0, y: 1, z: 1 }, { x: 1, y: 0, z: 1 }, { x: -1, y: 0, z: 1 }];

/** Face order follows sky_texorder, including the source's bk/lf permutation. */
export const SKY_FACE_SUFFIXES: readonly string[] = ["rt", "lf", "bk", "ft", "up", "dn"];

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new RangeError(`sky index ${index} outside ${items.length}`);
  return value;
}

export function skyVector(face: number, s: number, t: number, size = 1): Vec3 {
  size = Math.fround(size);
  const horizontal = Math.fround(Math.fround(s) * size), vertical = Math.fround(Math.fround(t) * size);
  switch (face) {
    case 0: return { x: size, y: -horizontal, z: vertical };
    case 1: return { x: -size, y: horizontal, z: vertical };
    case 2: return { x: horizontal, y: size, z: vertical };
    case 3: return { x: -horizontal, y: -size, z: vertical };
    case 4: return { x: -vertical, y: -horizontal, z: size };
    case 5: return { x: vertical, y: -horizontal, z: -size };
    default: throw new RangeError("sky face must be 0..5");
  }
}

function projectPolygon(points: readonly Vec3[], bounds: readonly FaceBounds[]): void {
  let sum = { x: 0, y: 0, z: 0 };
  for (const point of points) sum = add3(sum, point);
  const x = Math.abs(sum.x), y = Math.abs(sum.y), z = Math.abs(sum.z);
  const face = x > y && x > z ? sum.x < 0 ? 1 : 0 : y > z && y > x ? sum.y < 0 ? 3 : 2 : sum.z < 0 ? 5 : 4;
  const range = at(bounds, face);
  for (const point of points) {
    let divisor: number, s: number, t: number;
    switch (face) {
      case 0: divisor = point.x; s = -point.y; t = point.z; break;
      case 1: divisor = -point.x; s = point.y; t = point.z; break;
      case 2: divisor = point.y; s = point.x; t = point.z; break;
      case 3: divisor = -point.y; s = -point.x; t = point.z; break;
      case 4: divisor = point.z; s = -point.y; t = -point.x; break;
      case 5: divisor = -point.z; s = -point.y; t = point.x; break;
      default: throw new RangeError("invalid sky projection face");
    }
    if (divisor < 0.001) continue;
    s = Math.fround(s / divisor); t = Math.fround(t / divisor);
    range.minS = Math.min(range.minS, s); range.minT = Math.min(range.minT, t);
    range.maxS = Math.max(range.maxS, s); range.maxT = Math.max(range.maxT, t);
  }
}

function clipPolygon(points: readonly Vec3[], stage: number, bounds: readonly FaceBounds[]): void {
  if (points.length > 62) throw new RangeError("sky polygon exceeds source clip vertex limit");
  if (stage === 6) { projectPolygon(points, bounds); return; }
  const normal = at(CLIP_PLANES, stage), distances = points.map(point => dot3(point, normal));
  const sides = distances.map(distance => distance > Math.fround(0.1) ? 1 : distance < -Math.fround(0.1) ? -1 : 0);
  if (!sides.includes(1) || !sides.includes(-1)) { clipPolygon(points, stage + 1, bounds); return; }
  const front: Vec3[] = [], back: Vec3[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = at(points, i), next = (i + 1) % points.length, side = at(sides, i), nextSide = at(sides, next);
    if (side >= 0) front.push(point);
    if (side <= 0) back.push(point);
    if (side === 0 || nextSide === 0 || nextSide === side) continue;
    const distance = at(distances, i), fraction = Math.fround(distance / Math.fround(distance - at(distances, next)));
    const intersection = add3(point, scale3(sub3(at(points, next), point), fraction));
    front.push(intersection); back.push(intersection);
  }
  clipPolygon(front, stage + 1, bounds); clipPolygon(back, stage + 1, bounds);
}

export function cloudTexCoord(face: number, s: number, t: number, height: number): Vec2 {
  const f = Math.fround;
  height = f(height);
  if (!Number.isFinite(height)) throw new RangeError("sky cloud height must be finite float32");
  const direction = skyVector(face, s, t, 1024 / 1.75), radius = 4096;
  const xx = f(direction.x * direction.x), yy = f(direction.y * direction.y), zz = f(direction.z * direction.z), hh = f(height * height);
  // R_InitSkyTexCoords evaluates this float sum before promotion into sqrt(double).
  let discriminant = f(zz * f(radius * radius));
  discriminant = f(discriminant + f(f(f(2 * xx) * radius) * height));
  discriminant = f(discriminant + f(xx * hh));
  discriminant = f(discriminant + f(f(f(2 * yy) * radius) * height));
  discriminant = f(discriminant + f(yy * hh));
  discriminant = f(discriminant + f(f(f(2 * zz) * radius) * height));
  discriminant = f(discriminant + f(zz * hh));
  const inverse = f(1 / f(2 * dot3(direction, direction)));
  const p = f(inverse * (f(f(-2 * direction.z) * radius) + 2 * Math.sqrt(discriminant)));
  const intersection = normalize3({ x: f(direction.x * p), y: f(direction.y * p), z: f(f(direction.z * p) + radius) });
  // Q_acos does not clamp its input; negative cloud heights can leave NaN coordinates.
  return { x: f(Math.acos(intersection.x)), y: f(Math.acos(intersection.y)) };
}

/** Renderer-global source cloud table; every parsed skyParms height overwrites it. */
export class SkyBuilder {
  private cloudCoords: readonly (readonly Vec2[])[] = Array.from({ length: 6 }, () => Array.from({ length: 81 }, () => ({ x: 0, y: 0 })));
  private bounds: readonly FaceBounds[] = [];

  initializeCloudCoordinates(height: number): void {
    if (!Number.isFinite(Math.fround(height))) throw new RangeError("sky cloud height must be finite float32");
    this.cloudCoords = Array.from({ length: 6 }, (_, face) => Array.from({ length: 81 }, (_, index) => cloudTexCoord(face, (index % 9 - 4) / 4, (Math.floor(index / 9) - 4) / 4, height)));
  }

  clip(meshes: readonly DeformGeometry[], origin: Vec3): void {
    const bounds: FaceBounds[] = Array.from({ length: 6 }, () => ({ minS: 9999, minT: 9999, maxS: -9999, maxT: -9999 }));
    this.bounds = bounds;
    for (const mesh of meshes) for (let index = 0; index < mesh.indices.length; index += 3) {
      const points = [0, 1, 2].map(offset => sub3(at(mesh.vertices, at(mesh.indices, index + offset)).position, origin));
      clipPolygon(points, 0, bounds);
    }
  }

  build(origin: Vec3, far: number): SkyGeometry {
    const box: SkyFace[] = [], cloudVertices: BspVertex[] = [], cloudIndices: number[] = [];
    for (const [face, boundsForFace] of this.bounds.entries()) {
      const clamp = (value: number): number => Math.max(-4, Math.min(4, value));
      const rawMinS = Math.floor(boundsForFace.minS * 4), rawMinT = Math.floor(boundsForFace.minT * 4);
      const rawMaxS = Math.ceil(boundsForFace.maxS * 4), rawMaxT = Math.ceil(boundsForFace.maxT * 4);
      if (rawMinS >= rawMaxS || rawMinT >= rawMaxT) continue;
      const minS = clamp(rawMinS), minT = clamp(rawMinT), maxS = clamp(rawMaxS), maxT = clamp(rawMaxT);
      const vertices: BspVertex[] = [], indices: number[] = [], width = maxS - minS + 1;
      for (let t = minT; t <= maxT; t++) for (let s = minS; s <= maxS; s++) {
        const direction = skyVector(face, s / 4, t / 4, far / 1.75), position = add3(direction, origin);
        vertices.push({ position, normal: normalize3(scale3(direction, -1)), texCoord: { x: (s / 4 + 1) / 2, y: 1 - (t / 4 + 1) / 2 },
          lightmapCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } });
      }
      const strips: number[][] = [];
      for (let t = 0; t < maxT - minT; t++) {
        const strip: number[] = [];
        for (let s = 0; s < width; s++) strip.push(s + t * width, s + (t + 1) * width);
        strips.push(strip);
        for (let s = 0; s < maxS - minS; s++) {
          const index = s + t * width;
          indices.push(index, index + width, index + 1, index + width, index + width + 1, index + 1);
        }
      }
      box.push({ face, geometry: { vertices, indices }, strips });
      if (face === 5) continue;
      const cloudStart = cloudVertices.length;
      for (let t = minT; t <= maxT; t++) for (let s = minS; s <= maxS; s++) {
        const vertex = at(vertices, s - minS + (t - minT) * width);
        cloudVertices.push({ ...vertex, texCoord: at(at(this.cloudCoords, face), (s + 4) + (t + 4) * 9) });
      }
      for (const index of indices) cloudIndices.push(cloudStart + index);
    }
    return { box, clouds: { vertices: cloudVertices, indices: cloudIndices } };
  }
}
