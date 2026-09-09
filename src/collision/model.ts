/* Owned temporary collision hulls translated from id Software's cm_load.c and
 * cm_trace.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
import type { Bounds, Vec3 } from "../core/math.ts";
import { add3, anglesToAxis, dot3, length3, scale3, sub3, vec3 } from "../core/math.ts";
import { bitsToFloat32, float32ToBits } from "../core/numeric.ts";
import { emptySourceTrace, sourceTraceEnd, sourceTraceView } from "./world.ts";
import { CollisionCounters } from "./counters.ts";
import type { CollisionWorld, SourceTracePlane, SourceTraceResult, TraceQuery, TraceResult, TraceShape } from "./world.ts";
import type { CollisionBoxStorage } from "./map-resource.ts";

export type TemporaryTraceQuery = Omit<TraceQuery, "modelIndex">;
interface PreparedShape {
  readonly center: Vec3;
  readonly mins: Vec3;
  readonly extents: Vec3;
  readonly capsule: boolean;
  readonly radius: number;
  readonly halfheight: number;
  readonly offset: Vec3;
}
type TemporaryModelData = { readonly kind: "box"; readonly bounds: Bounds }
  | { readonly kind: "capsule"; readonly bounds: Bounds; readonly target: PreparedShape };
interface TraceWork {
  fraction: number;
  allSolid: boolean;
  startSolid: boolean;
  plane: SourceTracePlane;
  surfaceFlags: number;
  contents: number;
}
const BODY = 0x02000000;
const f32 = Math.fround;

function finite(point: Vec3): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z); }
function validateBounds(bounds: Bounds): void {
  if (!finite(bounds.min) || !finite(bounds.max) || bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z) throw new RangeError("temporary hull requires finite ordered bounds");
}
function prepare(shape: TraceShape): PreparedShape {
  if (shape.kind === "point") return { center: vec3(0, 0, 0), mins: vec3(0, 0, 0), extents: vec3(0, 0, 0), capsule: false, radius: 0, halfheight: 0, offset: vec3(0, 0, 0) };
  validateBounds({ min: shape.mins, max: shape.maxs });
  const center = scale3(add3(shape.mins, shape.maxs), 0.5);
  const mins = sub3(shape.mins, center);
  const extents = sub3(shape.maxs, center);
  const radius = Math.min(extents.x, extents.z);
  return { center, mins, extents, capsule: shape.kind === "capsule", radius, halfheight: extents.z, offset: vec3(0, 0, f32(extents.z - radius)) };
}
function computedBoxPlane(bounds: Bounds, index: number): SourceTracePlane {
  switch (index) {
    case 0: return { normal: vec3(1, 0, 0), distance: bounds.max.x, type: 0, signbits: 0 };
    case 1: return { normal: vec3(-1, 0, 0), distance: -bounds.min.x, type: 3, signbits: 1 };
    case 2: return { normal: vec3(0, 1, 0), distance: bounds.max.y, type: 1, signbits: 0 };
    case 3: return { normal: vec3(0, -1, 0), distance: -bounds.min.y, type: 4, signbits: 2 };
    case 4: return { normal: vec3(0, 0, 1), distance: bounds.max.z, type: 2, signbits: 0 };
    case 5: return { normal: vec3(0, 0, -1), distance: -bounds.min.z, type: 5, signbits: 4 };
    default: throw new RangeError("computed temporary box side outside six planes");
  }
}
function traceBox(work: TraceWork, bounds: Bounds, start: Vec3, end: Vec3, shape: PreparedShape, stationary: boolean, mask: number,
  counters: CollisionCounters, storage: CollisionBoxStorage | null = null, retainedPositionBounds: Bounds | null = null): void {
  const brush = storage === null ? null : storage.brush;
  if (storage !== null && brush !== null) {
    if (brush.checkCount === storage.checkCount) return;
    brush.checkCount = storage.checkCount;
  }
  if ((mask & (brush === null ? BODY : brush.contents)) === 0 || (brush !== null && brush.sideCount === 0)) return;
  if (stationary) {
    const min = retainedPositionBounds !== null ? retainedPositionBounds.min : shape.capsule
      ? vec3(start.x - Math.abs(shape.offset.x) - shape.radius, start.y - Math.abs(shape.offset.y) - shape.radius, start.z - Math.abs(shape.offset.z) - shape.radius)
      : add3(start, shape.mins);
    const max = retainedPositionBounds !== null ? retainedPositionBounds.max : shape.capsule
      ? vec3(start.x + Math.abs(shape.offset.x) + shape.radius, start.y + Math.abs(shape.offset.y) + shape.radius, start.z + Math.abs(shape.offset.z) + shape.radius)
      : add3(start, shape.extents);
    const brushBounds = brush === null ? bounds : brush.bounds;
    if (min.x > brushBounds.max.x || min.y > brushBounds.max.y || min.z > brushBounds.max.z
      || max.x < brushBounds.min.x || max.y < brushBounds.min.y || max.z < brushBounds.min.z) return;
  }
  if (!stationary) counters.c_brush_traces = (counters.c_brush_traces + 1) | 0;
  let enter = -1, leave = 1, startOut = false, getOut = false;
  let lead: { readonly plane: SourceTracePlane; readonly side: ReturnType<CollisionBoxStorage["readSide"]> } | null = null;
  for (let index = stationary ? 6 : 0; index < (brush === null ? 6 : brush.sideCount); index++) {
    const side = storage === null ? { plane: computedBoxPlane(bounds, index), surfaceFlags: 0 } : storage.readSide(index);
    const plane = side.plane;
    const n = plane.normal;
    let expansion = shape.radius;
    if (!shape.capsule) {
      const signs = plane.signbits;
      if (signs >= 8) throw new RangeError("CM brush plane signbits outside trace offsets");
      expansion = -dot3(n, vec3((signs & 1) !== 0 ? shape.extents.x : shape.mins.x,
        (signs & 2) !== 0 ? shape.extents.y : shape.mins.y, (signs & 4) !== 0 ? shape.extents.z : shape.mins.z));
    }
    const distance = f32(plane.distance + expansion);
    let first = start, last = end;
    if (shape.capsule) {
      const offset = dot3(n, shape.offset) > 0 ? scale3(shape.offset, -1) : shape.offset;
      first = add3(start, offset); last = add3(end, offset);
    }
    const d1 = f32(dot3(first, n) - distance);
    if (stationary) {
      if (d1 > 0) return;
      continue;
    }
    const d2 = f32(dot3(last, n) - distance);
    if (d1 > 0) startOut = true;
    if (d2 > 0) getOut = true;
    if (d1 > 0 && (d2 >= 0.125 || d2 >= d1)) return;
    if (d1 <= 0 && d2 <= 0) continue;
    if (d1 > d2) {
      const fraction = Math.max(0, f32(f32(d1 - 0.125) / f32(d1 - d2)));
      if (fraction > enter) { enter = fraction; lead = { plane, side }; }
    } else leave = Math.min(leave, Math.min(1, f32(f32(d1 + 0.125) / f32(d1 - d2))));
  }
  if (!startOut) {
    work.startSolid = true;
    if (!getOut) { work.allSolid = true; work.fraction = 0; work.contents = brush === null ? BODY : brush.contents; }
  } else if (enter < leave && enter > -1 && enter < work.fraction && lead !== null) {
    work.fraction = Math.max(0, enter);
    const plane = lead.plane;
    work.plane = { normal: vec3(plane.normal.x, plane.normal.y, plane.normal.z), distance: plane.distance, type: plane.type, signbits: plane.signbits };
    work.surfaceFlags = lead.side.surfaceFlags;
    work.contents = brush === null ? BODY : brush.contents;
  }
}

/** The source capsule quadratic uses two inverse-square-root Newton steps. */
function capsuleSquareRoot(number: number): number {
  const x = f32(number * 0.5);
  let y = bitsToFloat32(0x5f3759df - (float32ToBits(number) >> 1));
  y = f32(y * f32(1.5 - f32(f32(x * y) * y)));
  y = f32(y * f32(1.5 - f32(f32(x * y) * y)));
  return f32(number * y);
}
function distanceFromLineSquared(point: Vec3, start: Vec3, end: Vec3, direction: Vec3): number {
  const projection = add3(start, scale3(direction, dot3(sub3(point, start), direction)));
  for (const [projected, first, last] of [[projection.x, start.x, end.x], [projection.y, start.y, end.y], [projection.z, start.z, end.z]]) {
    if (projected === undefined || first === undefined || last === undefined) throw new Error("line component tuple invariant");
    if ((projected > first && projected > last) || (projected < first && projected < last)) {
      const delta = sub3(point, Math.abs(projected - first) < Math.abs(projected - last) ? start : end);
      return dot3(delta, delta);
    }
  }
  const delta = sub3(point, projection);
  return dot3(delta, delta);
}
function traceRounded(work: TraceWork, origin: Vec3, radius: number, halfheight: number | null, start: Vec3, end: Vec3, modelOrigin: Vec3): void {
  const cylinder = halfheight !== null;
  const start2d = cylinder ? vec3(start.x, start.y, 0) : start;
  const end2d = cylinder ? vec3(end.x, end.y, 0) : end;
  const origin2d = cylinder ? vec3(origin.x, origin.y, 0) : origin;
  const delta = sub3(start2d, origin2d);
  if ((halfheight === null || (start.z <= f32(origin.z + halfheight) && start.z >= f32(origin.z - halfheight))) && dot3(delta, delta) < f32(radius * radius)) {
    work.fraction = 0;
    work.startSolid = true;
    const endDelta = sub3(end2d, origin2d);
    if (dot3(endDelta, endDelta) < f32(radius * radius)) work.allSolid = true;
    return;
  }
  const movement = sub3(end2d, start2d);
  const length = length3(movement);
  const direction = length === 0 ? vec3(0, 0, 0) : scale3(movement, f32(1 / length));
  const closest = distanceFromLineSquared(origin2d, start2d, end2d, direction);
  const endDelta = sub3(end2d, origin2d);
  const nearRadius = f32(radius + 0.125);
  if (closest >= f32(radius * radius) && dot3(endDelta, endDelta) > f32(nearRadius * nearRadius)) return;
  const inflated = f32(radius + 1);
  const b = f32(2 * dot3(direction, delta));
  const c = f32(dot3(delta, delta) - f32(inflated * inflated));
  const determinant = f32(f32(b * b) - f32(4 * c));
  if (determinant <= 0) return;
  let fraction = f32(f32(-b - capsuleSquareRoot(determinant)) * 0.5);
  fraction = fraction < 0 ? 0 : f32(fraction / length);
  if (!(fraction < work.fraction)) return;
  const intersection = sourceTraceEnd(start, end, fraction);
  if (halfheight !== null && (intersection.z > f32(origin.z + halfheight) || intersection.z < f32(origin.z - halfheight))) return;
  let normal = sub3(intersection, origin);
  if (cylinder) normal = vec3(normal.x, normal.y, 0);
  normal = scale3(normal, f32(1 / inflated));
  work.fraction = fraction;
  work.plane = { ...work.plane, normal, distance: dot3(normal, add3(modelOrigin, intersection)) };
  work.contents = BODY;
}

function positionCapsule(work: TraceWork, target: PreparedShape, start: Vec3, shape: PreparedShape): void {
  const top = add3(start, shape.offset), bottom = sub3(start, shape.offset);
  const upper = add3(target.center, target.offset), lower = sub3(target.center, target.offset);
  const radius = f32(shape.radius + target.radius), squared = f32(radius * radius);
  for (const endpoint of [top, bottom]) for (const targetEndpoint of [upper, lower]) {
    const delta = sub3(targetEndpoint, endpoint);
    if (dot3(delta, delta) < squared) { work.allSolid = true; work.startSolid = true; work.fraction = 0; }
  }
  // Preserve CM_TestCapsuleInCapsule's original upper/lower comparison order.
  if ((top.z >= upper.z && top.z <= lower.z) || (bottom.z >= upper.z && bottom.z <= lower.z)) {
    const delta = vec3(top.x - upper.x, top.y - upper.y, 0);
    if (dot3(delta, delta) < squared) { work.allSolid = true; work.startSolid = true; work.fraction = 0; }
  }
}

export class TemporaryCollisionModel {
  readonly #model: TemporaryModelData;

  constructor(kind: "box" | "capsule", bounds: Bounds, readonly counters = new CollisionCounters(),
    private readonly storage: CollisionBoxStorage | null = null) {
    const owned = { min: vec3(bounds.min.x, bounds.min.y, bounds.min.z), max: vec3(bounds.max.x, bounds.max.y, bounds.max.z) };
    if (kind === "box") {
      // CM_TempBoxModel stores raw plane distances, including CG's transient zero-solid hull.
      if (!finite(owned.min) || !finite(owned.max)) throw new RangeError("temporary box requires finite plane distances");
      this.#model = storage === null ? { kind, bounds: owned } : { kind, get bounds(): Bounds { return storage.brush.bounds; } };
    } else {
      validateBounds(bounds);
      this.#model = { kind, bounds: owned, target: prepare({ kind: "capsule", mins: owned.min, maxs: owned.max }) };
    }
  }

  get kind(): "box" | "capsule" { return this.#model.kind; }
  get bounds(): Bounds {
    const { min, max } = this.#model.bounds;
    return { min: vec3(min.x, min.y, min.z), max: vec3(max.x, max.y, max.z) };
  }

  pointContents(point: Vec3): number {
    if (!finite(point)) throw new RangeError("point contents requires finite coordinates");
    if (this.storage !== null) {
      const brush = this.storage.brush;
      let index = 0;
      for (; index < brush.sideCount; index++) {
        const plane = this.storage.readSide(index).plane;
        if (dot3(point, plane.normal) > plane.distance) break;
      }
      return index === brush.sideCount ? brush.contents : 0;
    }
    // The source point-contents path tests the temporary box brush, including
    // capsule handles. Each owned model initializes that brush from its bounds.
    const { min, max } = this.#model.bounds;
    return point.x >= min.x && point.x <= max.x && point.y >= min.y && point.y <= max.y && point.z >= min.z && point.z <= max.z ? BODY : 0;
  }

  transformedPointContents(point: Vec3, origin: Vec3, angles: Vec3): number {
    if (!finite(origin) || !finite(angles)) throw new RangeError("model transform requires finite coordinates");
    let local = sub3(point, origin);
    if (this.kind === "capsule") {
      const axis = anglesToAxis(angles);
      local = vec3(dot3(local, axis[0]), dot3(local, axis[1]), dot3(local, axis[2]));
    }
    return this.pointContents(local);
  }

  trace(query: TemporaryTraceQuery): TraceResult {
    return sourceTraceView(this.traceSource(query));
  }

  traceSource(query: TemporaryTraceQuery): SourceTraceResult {
    return this.#source(query, null, null);
  }

  transformedTrace(query: TemporaryTraceQuery, origin: Vec3, angles: Vec3): TraceResult {
    return sourceTraceView(this.transformedTraceSource(query, origin, angles));
  }

  transformedTraceSource(query: TemporaryTraceQuery, origin: Vec3, angles: Vec3): SourceTraceResult {
    return this.#source(query, { origin, angles }, null);
  }

  /** The source capsule swap can resolve its box handle to actual submodel255. */
  traceCapsuleReplacementSource(query: TemporaryTraceQuery, world: CollisionWorld,
    transform: { readonly origin: Vec3; readonly angles: Vec3 } | null): SourceTraceResult {
    return this.#source(query, transform, world);
  }

  #source(query: TemporaryTraceQuery, transform: { readonly origin: Vec3; readonly angles: Vec3 } | null,
    replacement: CollisionWorld | null): SourceTraceResult {
    const origin = transform === null ? vec3(0, 0, 0) : transform.origin;
    const angles = transform === null ? vec3(0, 0, 0) : transform.angles;
    if (transform !== null && (!finite(origin) || !finite(angles))) throw new RangeError("model transform requires finite coordinates");
    let shape = prepare(query.shape);
    const axis = this.kind !== "box" && (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) ? anglesToAxis(angles) : null;
    const rotate = (point: Vec3): Vec3 => axis === null ? point : vec3(dot3(point, axis[0]), dot3(point, axis[1]), dot3(point, axis[2]));
    if (axis !== null) shape = { ...shape, offset: vec3(axis[0].z * shape.offset.z, -axis[1].z * shape.offset.z, axis[2].z * shape.offset.z) };
    const centeredStart = add3(query.start, shape.center), centeredEnd = add3(query.end, shape.center);
    let start = transform === null ? centeredStart : rotate(sub3(centeredStart, origin));
    let finish = transform === null ? centeredEnd : rotate(sub3(centeredEnd, origin));
    const stationary = transform === null
      ? query.start.x === query.end.x && query.start.y === query.end.y && query.start.z === query.end.z
      : start.x === finish.x && start.y === finish.y && start.z === finish.z;
    if (transform !== null) {
      // CM_Trace centers CM_TransformedBoxTrace's stored bounds a second time.
      const center = scale3(add3(shape.mins, shape.extents), 0.5);
      shape = { ...shape, mins: sub3(shape.mins, center), extents: sub3(shape.extents, center) };
      start = add3(start, center); finish = add3(finish, center);
    }
    const result = this.#trace(query, start, finish, shape, stationary, origin, replacement);
    if (transform === null) return result;
    const end = sourceTraceEnd(query.start, query.end, result.fraction);
    if (axis === null || result.fraction === 1) return { ...result, end };
    const n = result.plane.normal;
    return { ...result, end, plane: { ...result.plane,
      normal: vec3(f32(f32(axis[0].x * n.x) + f32(axis[1].x * n.y)) + f32(axis[2].x * n.z),
        f32(f32(axis[0].y * n.x) + f32(axis[1].y * n.y)) + f32(axis[2].y * n.z),
        f32(f32(axis[0].z * n.x) + f32(axis[1].z * n.y)) + f32(axis[2].z * n.z)),
    } };
  }

  #trace(query: TemporaryTraceQuery, start: Vec3, end: Vec3, shape: PreparedShape, stationary: boolean, modelOrigin: Vec3,
    replacement: CollisionWorld | null): SourceTraceResult {
    if (!finite(query.start) || !finite(query.end) || !Number.isInteger(query.mask)) throw new RangeError("trace requires finite coordinates and integer contents mask");
    this.counters.c_traces = (this.counters.c_traces + 1) | 0;
    const work: TraceWork = { fraction: 1, allSolid: false, startSolid: false, plane: emptySourceTrace().plane, surfaceFlags: 0, contents: 0 };
    const model = this.#model;
    if (model.kind === "box") traceBox(work, model.bounds, start, end, shape, stationary, query.mask, this.counters, this.storage);
    else if (!shape.capsule) {
      // CM_TraceBoundingBoxThroughCapsule swaps the stationary box and capsule.
      const target = model.target;
      if (replacement !== null) {
        return replacement.traceCapsuleReplacementSource(query, {
          start: sub3(start, target.center), end: sub3(end, target.center),
          mins: shape.mins, extents: shape.extents, radius: target.radius, offset: target.offset,
          bounds: { min: add3(start, shape.mins), max: add3(start, shape.extents) }, stationary,
          pointTrace: shape.mins.x === 0 && shape.mins.y === 0 && shape.mins.z === 0,
        });
      } else if (this.storage !== null) {
        traceBox(work, this.storage.brush.bounds, sub3(start, target.center), sub3(end, target.center), target,
          stationary, query.mask, this.counters, this.storage, { min: add3(start, shape.mins), max: add3(start, shape.extents) });
      } else if (stationary) {
        // CM_TestBoundingBoxInCapsule retains the original trace bounds while
        // replacing the brush with size[0]/size[1]. CM_TestBoxInBrush tests those bounds
        // and skips all six axial planes; retain this stationary source case.
        const min = add3(start, shape.mins), max = add3(start, shape.extents);
        if ((query.mask & BODY) !== 0 && min.x <= shape.extents.x && min.y <= shape.extents.y && min.z <= shape.extents.z
          && max.x >= shape.mins.x && max.y >= shape.mins.y && max.z >= shape.mins.z) {
          work.fraction = 0; work.allSolid = true; work.startSolid = true; work.contents = BODY;
        }
      } else traceBox(work, { min: shape.mins, max: shape.extents }, sub3(start, target.center), sub3(end, target.center), target, stationary, query.mask, this.counters);
    } else if (stationary) positionCapsule(work, model.target, start, shape);
    else {
      const sweepMin = vec3(Math.min(start.x, end.x) - Math.abs(shape.offset.x) - shape.radius,
        Math.min(start.y, end.y) - Math.abs(shape.offset.y) - shape.radius, Math.min(start.z, end.z) - Math.abs(shape.offset.z) - shape.radius);
      const sweepMax = vec3(Math.max(start.x, end.x) + Math.abs(shape.offset.x) + shape.radius,
        Math.max(start.y, end.y) + Math.abs(shape.offset.y) + shape.radius, Math.max(start.z, end.z) + Math.abs(shape.offset.z) + shape.radius);
      const { min, max } = model.bounds;
      if (!(sweepMin.x > f32(max.x + 1) || sweepMin.y > f32(max.y + 1) || sweepMin.z > f32(max.z + 1)
        || sweepMax.x < f32(min.x - 1) || sweepMax.y < f32(min.y - 1) || sweepMax.z < f32(min.z - 1))) {
        const target = model.target;
        const radius = f32(target.radius + shape.radius);
        const halfheight = f32(f32(target.halfheight + shape.halfheight) - radius);
        if ((start.x !== end.x || start.y !== end.y) && halfheight > 0) traceRounded(work, target.center, radius, halfheight, start, end, modelOrigin);
        traceRounded(work, add3(target.center, target.offset), radius, null, sub3(start, shape.offset), sub3(end, shape.offset), modelOrigin);
        traceRounded(work, sub3(target.center, target.offset), radius, null, add3(start, shape.offset), add3(end, shape.offset), modelOrigin);
      }
    }
    return { ...work, end: work.fraction === 1 ? query.end : sourceTraceEnd(query.start, query.end, work.fraction) };
  }
}

export function createBoxModel(bounds: Bounds, counters = new CollisionCounters(), storage: CollisionBoxStorage | null = null): TemporaryCollisionModel {
  return new TemporaryCollisionModel("box", bounds, counters, storage);
}
export function createCapsuleModel(bounds: Bounds, counters = new CollisionCounters(), storage: CollisionBoxStorage | null = null): TemporaryCollisionModel {
  return new TemporaryCollisionModel("capsule", bounds, counters, storage);
}
