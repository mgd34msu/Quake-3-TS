/* Collision tracing translated from id Software's cm_trace.c and cm_test.c.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later */
import type { BspMap } from "../assets/bsp.ts";
import { add3, sub3, scale3, dot3, lerp3, vec3, anglesToAxis } from "../core/math.ts";
import type { Vec3, Plane, Bounds } from "../core/math.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { tracePatch, positionInPatch } from "./patch.ts";
import type { CollisionDebugSurface, PatchShape } from "./patch.ts";
import { CollisionTopology } from "./topology.ts";
import { CollisionCounters } from "./counters.ts";
import { SOURCE_BOX_MODEL_HANDLE, SOURCE_CAPSULE_MODEL_HANDLE, SourceClipModels } from "./clip-models.ts";
import type { BoxLeafList, SourceClusterPVS } from "./topology.ts";
import type { CollisionHunkProfile } from "../render/hunk-accounting.ts";
import { CollisionMapResource, diagnosticCollisionMap } from "./map-resource.ts";
import type { CollisionBoxStorage, CollisionIndexes, CollisionMapData, CollisionPlane } from "./map-resource.ts";
export type { BoxLeafList } from "./topology.ts";

/** CM_LoadMap registers these common-lived controls before reading or reusing a map. */
export class CollisionMapSettings {
  constructor(private readonly cvars: CvarRegistry) {}

  registerMap(): undefined {
    this.cvars.register("cm_noAreas", "0", CvarFlag.Cheat);
    this.cvars.register("cm_noCurves", "0", CvarFlag.Cheat);
    this.cvars.register("cm_playerCurveClip", "1", CvarFlag.Archive | CvarFlag.Cheat);
  }

  get noAreas(): boolean { return this.enabled("cm_noAreas"); }
  get noCurves(): boolean { return this.enabled("cm_noCurves"); }
  get playerCurveClip(): boolean { return this.enabled("cm_playerCurveClip"); }

  private enabled(name: string): boolean {
    const value = this.cvars.get(name);
    if (value === undefined) throw new Error(`Collision map cvar ${name} is not registered`);
    return value.integerValue !== 0;
  }
}

export type CollisionWorldProfile = {
  readonly kind: "shared";
  readonly owner: CollisionDebugSurface;
  readonly settings: CollisionMapSettings;
} | { readonly kind: "disabled" };

export type TraceShape = { readonly kind: "point" }
  | { readonly kind: "box"; readonly mins: Vec3; readonly maxs: Vec3 }
  | { readonly kind: "capsule"; readonly mins: Vec3; readonly maxs: Vec3 };
export interface TraceQuery {
  readonly start: Vec3; readonly end: Vec3; readonly shape: TraceShape;
  readonly mask: number; readonly modelIndex?: number;
}
export type TraceContact = { readonly kind: "none" } | { readonly kind: "plane"; readonly plane: Plane };
export interface TraceResult {
  readonly fraction: number; readonly end: Vec3;
  readonly solidity: "clear" | "start-solid" | "all-solid";
  readonly contact: TraceContact; readonly contents: number; readonly surfaceFlags: number;
}

export interface SourceTracePlane extends Plane {
  readonly type: number;
  readonly signbits: number;
}

/** CM trace work retains the complete plane even after that plane becomes invalid. */
export interface SourceTraceResult {
  readonly allSolid: boolean;
  readonly startSolid: boolean;
  readonly fraction: number;
  readonly end: Vec3;
  readonly plane: SourceTracePlane;
  readonly surfaceFlags: number;
  readonly contents: number;
}

interface CapsuleReplacementTrace {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly mins: Vec3;
  readonly extents: Vec3;
  readonly radius: number;
  readonly offset: Vec3;
  readonly bounds: Bounds;
  readonly stationary: boolean;
  readonly pointTrace: boolean;
}

export function emptySourceTrace(): SourceTraceResult {
  return { allSolid: false, startSolid: false, fraction: 1, end: vec3(0, 0, 0),
    plane: { normal: vec3(0, 0, 0), distance: 0, type: 0, signbits: 0 },
    surfaceFlags: 0, contents: 0 };
}

/** Gameplay receives an impact plane only when the source plane is valid. */
export function sourceTraceView(source: SourceTraceResult): TraceResult {
  const normal = source.plane.normal;
  const contact: TraceContact = source.allSolid || source.fraction === 1
    || (normal.x === 0 && normal.y === 0 && normal.z === 0)
    ? { kind: "none" }
    : { kind: "plane", plane: { normal, distance: source.plane.distance } };
  return { fraction: source.fraction, end: source.end,
    solidity: source.allSolid ? "all-solid" : source.startSolid ? "start-solid" : "clear",
    contact, surfaceFlags: source.surfaceFlags, contents: source.contents };
}

/** CM_Trace and CM_TransformedBoxTrace store each source float operation. */
export function sourceTraceEnd(start: Vec3, end: Vec3, fraction: number): Vec3 {
  const f32 = Math.fround;
  return vec3(start.x + f32(fraction * f32(end.x - start.x)),
    start.y + f32(fraction * f32(end.y - start.y)),
    start.z + f32(fraction * f32(end.z - start.z)));
}

function bspTracePlane(plane: CollisionPlane): SourceTracePlane {
  return { normal: vec3(plane.normal.x, plane.normal.y, plane.normal.z), distance: plane.distance,
    type: plane.type, signbits: plane.signbits };
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`collision index ${index} out of range`);
  return value;
}
function finite(point: Vec3): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z); }
/** CM_VectorDistanceSquared, including the stored binary32 displacement. */
export function collisionVectorDistanceSquared(first: Vec3, second: Vec3): number {
  const delta = sub3(second, first);
  return dot3(delta, delta);
}
function shapeInfo(shape: TraceShape): { center: Vec3; mins: Vec3; shape: PatchShape } {
  if (shape.kind === "point") return { center: vec3(0, 0, 0), mins: vec3(0, 0, 0),
    shape: { kind: "point", mins: vec3(0, 0, 0), extents: vec3(0, 0, 0) } };
  if (!finite(shape.mins) || !finite(shape.maxs) || shape.mins.x > shape.maxs.x || shape.mins.y > shape.maxs.y || shape.mins.z > shape.maxs.z) {
    throw new RangeError("trace shape requires finite ordered bounds");
  }
  const center = scale3(add3(shape.mins, shape.maxs), 0.5);
  const mins = sub3(shape.mins, center);
  const extents = sub3(shape.maxs, center);
  if (shape.kind === "capsule") {
    const radius = Math.min(extents.x, extents.z);
    return { center, mins, shape: { kind: "capsule", extents, radius, offset: vec3(0, 0, extents.z - radius) } };
  }
  return { center, mins, shape: { kind: "box", mins, extents } };
}
function expansion(shape: PatchShape, plane: CollisionPlane): number {
  if (shape.kind === "point") return 0;
  if (shape.kind === "capsule") return shape.radius + Math.abs(dot3(plane.normal, shape.offset));
  const normal = plane.normal, signs = plane.signbits;
  if (signs >= 8) throw new RangeError("CM brush plane signbits outside trace offsets");
  return -dot3(normal, vec3((signs & 1) !== 0 ? shape.extents.x : shape.mins.x,
    (signs & 2) !== 0 ? shape.extents.y : shape.mins.y, (signs & 4) !== 0 ? shape.extents.z : shape.mins.z));
}

export class CollisionWorld {
  readonly #map: CollisionMapData;
  readonly #topology: CollisionTopology;
  readonly #debug: CollisionDebugSurface | null;
  readonly #settings: CollisionMapSettings | null;
  #sourceModels: SourceClipModels | null = null;

  constructor(map: BspMap | CollisionMapData, hunk: CollisionHunkProfile, debug: CollisionWorldProfile,
    readonly counters = new CollisionCounters()) {
    this.#debug = debug.kind === "shared" ? debug.owner : null;
    this.#settings = debug.kind === "shared" ? debug.settings : null;
    if ("kind" in map) this.#map = map;
    else if (hunk.kind === "source-hunk") {
      const resource = new CollisionMapResource(hunk.source, hunk, this.#debug);
      const file = hunk.fileLifetime === "detached" ? hunk.accounting.beginFile(hunk.source, hunk.fileBytes) : null;
      resource.load(file === null ? hunk.fileBytes : file.bytes);
      if (file !== null) hunk.accounting.endFile(hunk.source, file);
      resource.initializeBoxHull();
      this.#map = resource;
    } else {
      this.#map = diagnosticCollisionMap(map, this.#debug);
    }
    this.#topology = new CollisionTopology(this.#map, counters);
  }

  get areaCount(): number { return this.#topology.areaCount; }
  get clusterCount(): number { return this.#topology.clusterCount; }
  get modelCount(): number { return this.#map.models.length; }
  get hasNodes(): boolean { return this.#map.nodes.length !== 0; }
  get boxStorage(): CollisionBoxStorage | null { return this.#map.box; }
  advanceCheckCount(): void { this.#map.checkCount = (this.#map.checkCount + 1) | 0; }
  modelBounds(index: number): Bounds {
    const bounds = at(this.#map.models, index).bounds;
    return { min: vec3(bounds.min.x, bounds.min.y, bounds.min.z), max: vec3(bounds.max.x, bounds.max.y, bounds.max.z) };
  }
  pointLeafnum(point: Vec3): number { return this.#topology.pointLeafnum(point); }
  boxLeafnums(bounds: Bounds, maxLeaves = 1024): BoxLeafList { return this.#topology.boxLeafnums(bounds, maxLeaves); }
  boxBrushes(bounds: Bounds, maxBrushes = 1024): ReturnType<CollisionTopology["boxBrushes"]> { return this.#topology.boxBrushes(bounds, maxBrushes); }
  leafArea(index: number): number { return this.#topology.leafArea(index); }
  leafCluster(index: number): number { return this.#topology.leafCluster(index); }
  clusterPVS(cluster: number): SourceClusterPVS { return this.#topology.clusterPVS(cluster); }
  clusterVisible(from: number, to: number): boolean { return this.#topology.clusterVisible(from, to); }
  adjustAreaPortalState(area1: number, area2: number, open: boolean): void { this.#topology.adjustAreaPortalState(area1, area2, open); }
  areasConnected(area1: number, area2: number): boolean {
    if (this.#settings !== null) this.#topology.setNoAreas(this.#settings.noAreas);
    return this.#topology.areasConnected(area1, area2);
  }
  writeAreaBits(buffer: Uint8Array, area: number): number {
    if (this.#settings !== null) this.#topology.setNoAreas(this.#settings.noAreas);
    return this.#topology.writeAreaBits(buffer, area);
  }
  areaBits(area: number): Uint8Array {
    if (this.#settings !== null) this.#topology.setNoAreas(this.#settings.noAreas);
    return this.#topology.areaBits(area);
  }
  setNoAreas(enabled: boolean): void {
    if (this.#settings !== null) throw new Error("Shared collision worlds read cm_noAreas from their common cvars");
    this.#topology.setNoAreas(enabled);
  }

  pointContents(point: Vec3, modelIndex = 0): number {
    if (!finite(point)) throw new RangeError("point contents requires finite coordinates");
    const map = this.#map;
    const model = at(map.models, modelIndex);
    let brushes: CollisionIndexes;
    if (modelIndex !== 0) brushes = model.brushes;
    else {
      const leaf = at(map.leaves, this.pointLeafnum(point));
      brushes = { length: leaf.brushCount, at(index: number): number { return map.leafBrushes.at(leaf.firstBrush + index); } };
    }
    let contents = 0;
    for (let index = 0; index < brushes.length; index++) {
      const brush = at(map.brushes, brushes.at(index));
      let inside = true;
      for (let i = 0; i < brush.sideCount; i++) {
        const plane = at(map.planes, at(map.brushSides, brush.firstSide + i).plane);
        if (dot3(point, plane.normal) > plane.distance) { inside = false; break; }
      }
      if (inside) contents |= brush.contents;
    }
    return contents;
  }

  transformedPointContents(point: Vec3, modelIndex: number, origin: Vec3, angles: Vec3): number {
    const local = sub3(point, origin);
    if (modelIndex === SOURCE_BOX_MODEL_HANDLE || (angles.x === 0 && angles.y === 0 && angles.z === 0)) return this.pointContents(local, modelIndex);
    const axis = anglesToAxis(angles);
    return this.pointContents(vec3(dot3(local, axis[0]), dot3(local, axis[1]), dot3(local, axis[2])), modelIndex);
  }

  trace(query: TraceQuery): TraceResult {
    return sourceTraceView(this.traceSource(query));
  }

  #sourceClipModels(): SourceClipModels {
    if (this.#sourceModels === null) this.#sourceModels = new SourceClipModels(this);
    return this.#sourceModels;
  }

  traceSource(query: TraceQuery): SourceTraceResult {
    if (query.modelIndex === SOURCE_CAPSULE_MODEL_HANDLE) return this.#sourceClipModels().trace(query, SOURCE_CAPSULE_MODEL_HANDLE);
    const info = shapeInfo(query.shape);
    const stationary = query.start.x === query.end.x && query.start.y === query.end.y && query.start.z === query.end.z;
    return this.#trace(query, add3(query.start, info.center), add3(query.end, info.center), info.shape, info.mins, stationary, null);
  }

  /** CM_TraceBoundingBoxThroughCapsule resolves handle255 back to a real leaf. */
  traceCapsuleReplacementSource(query: TraceQuery, prepared: CapsuleReplacementTrace): SourceTraceResult {
    const shape: PatchShape = { kind: "capsule", extents: prepared.extents,
      radius: prepared.radius, offset: prepared.offset };
    return this.#trace({ ...query, modelIndex: 255 }, prepared.start, prepared.end, shape, prepared.mins, prepared.stationary, prepared);
  }

  transformedTrace(query: TraceQuery, origin: Vec3, angles: Vec3): TraceResult {
    return sourceTraceView(this.transformedTraceSource(query, origin, angles));
  }

  transformedTraceSource(query: TraceQuery, origin: Vec3, angles: Vec3): SourceTraceResult {
    if (query.modelIndex === SOURCE_CAPSULE_MODEL_HANDLE) return this.#sourceClipModels().transformedTrace(query, SOURCE_CAPSULE_MODEL_HANDLE, origin, angles);
    if (!finite(origin) || (query.modelIndex !== SOURCE_BOX_MODEL_HANDLE && !finite(angles))) throw new RangeError("model transform requires finite coordinates");
    const info = shapeInfo(query.shape);
    const axis = query.modelIndex !== SOURCE_BOX_MODEL_HANDLE && (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) ? anglesToAxis(angles) : null;
    const rotate = (point: Vec3): Vec3 => axis === null ? point : vec3(dot3(point, axis[0]), dot3(point, axis[1]), dot3(point, axis[2]));
    const start = rotate(sub3(add3(query.start, info.center), origin));
    const finish = rotate(sub3(add3(query.end, info.center), origin));
    const stationary = start.x === finish.x && start.y === finish.y && start.z === finish.z;
    const firstExtents = info.shape.extents;
    const center = scale3(add3(info.mins, firstExtents), 0.5);
    const mins = sub3(info.mins, center);
    let shape = info.shape;
    if (shape.kind === "capsule") {
      // CM_Trace retains the supplied sphere while centering the stored sizes again.
      const offset = axis === null ? shape.offset : vec3(axis[0].z * shape.offset.z, -axis[1].z * shape.offset.z, axis[2].z * shape.offset.z);
      shape = { ...shape, extents: sub3(firstExtents, center), offset };
    } else if (shape.kind === "box") {
      shape = { ...shape, mins, extents: sub3(firstExtents, center) };
    }
    const result = this.#trace(query, add3(start, center), add3(finish, center), shape, mins, stationary, null);
    const end = sourceTraceEnd(query.start, query.end, result.fraction);
    if (result.fraction === 1 || axis === null) return { ...result, end };
    const n = result.plane.normal;
    const normal = add3(add3(scale3(axis[0], n.x), scale3(axis[1], n.y)), scale3(axis[2], n.z));
    return { ...result, end, plane: { ...result.plane, normal } };
  }

  #trace(query: TraceQuery, start: Vec3, end: Vec3, shape: PatchShape, sizeMins: Vec3, stationary: boolean, replacement: CapsuleReplacementTrace | null): SourceTraceResult {
    if (!finite(query.start) || !finite(query.end) || !Number.isInteger(query.mask)) throw new RangeError("trace requires finite coordinates and integer contents mask");
    const map = this.#map;
    const modelIndex = query.modelIndex ?? 0;
    const model = at(map.models, modelIndex);
    // Capsule replacement continues the original CM_Trace through another leaf.
    if (replacement === null) {
      this.advanceCheckCount();
      this.counters.c_traces = (this.counters.c_traces + 1) | 0;
    }
    let fraction = 1;
    let allSolid = false, startSolid = false;
    let tracePlane = emptySourceTrace().plane;
    let contents = 0;
    let surfaceFlags = 0;
    const pointTrace = !stationary && sizeMins.x === 0 && sizeMins.y === 0 && sizeMins.z === 0;
    let positionBounds: Bounds | null = null;
    if (stationary) {
      if (replacement !== null) positionBounds = replacement.bounds;
      else if (shape.kind === "capsule") {
        positionBounds = {
          min: vec3(start.x - Math.abs(shape.offset.x) - shape.radius, start.y - Math.abs(shape.offset.y) - shape.radius, start.z - Math.abs(shape.offset.z) - shape.radius),
          max: vec3(start.x + Math.abs(shape.offset.x) + shape.radius, start.y + Math.abs(shape.offset.y) + shape.radius, start.z + Math.abs(shape.offset.z) + shape.radius),
        };
      } else {
        const extents = shape.kind === "point" ? vec3(0, 0, 0) : shape.extents;
        positionBounds = { min: add3(start, sizeMins), max: add3(start, extents) };
      }
    }

    const brushTrace = (index: number): void => {
      const brush = at(map.brushes, index);
      if (brush.checkCount === map.checkCount) return;
      brush.checkCount = map.checkCount;
      const flags = brush.contents;
      if ((flags & query.mask) === 0 || brush.sideCount === 0) return;
      if (!stationary) this.counters.c_brush_traces = (this.counters.c_brush_traces + 1) | 0;
      let enter = -1, leave = 1, startOut = false, getOut = false;
      let lead: { plane: CollisionPlane; surfaceFlags: number } | null = null;
      if (positionBounds !== null) {
        // CM_TestBoxInBrush reads retained bounds, including the capsule swap's original bounds.
        const bounds = positionBounds;
        const brushBounds = brush.bounds;
        if (bounds.min.x > brushBounds.max.x || bounds.min.y > brushBounds.max.y || bounds.min.z > brushBounds.max.z
          || bounds.max.x < brushBounds.min.x || bounds.max.y < brushBounds.min.y || bounds.max.z < brushBounds.min.z) return;
      }
      for (let i = stationary ? 6 : 0; i < brush.sideCount; i++) {
        const side = at(map.brushSides, brush.firstSide + i);
        const plane = at(map.planes, side.plane);
        const distance = Math.fround(plane.distance + (shape.kind === "capsule" ? shape.radius : expansion(shape, plane)));
        let first = start, last = end;
        if (shape.kind === "capsule") {
          if (dot3(plane.normal, shape.offset) > 0) {
            first = sub3(start, shape.offset); last = sub3(end, shape.offset);
          } else {
            first = add3(start, shape.offset); last = add3(end, shape.offset);
          }
        }
        const d1 = Math.fround(dot3(first, plane.normal) - distance);
        if (stationary) {
          if (d1 > 0) return;
          continue;
        }
        const d2 = Math.fround(dot3(last, plane.normal) - distance);
        if (d1 > 0) startOut = true;
        if (d2 > 0) getOut = true;
        if (d1 > 0 && (d2 >= 0.125 || d2 >= d1)) return;
        if (d1 <= 0 && d2 <= 0) continue;
        if (d1 > d2) {
          const f = Math.max(0, Math.fround(Math.fround(d1 - 0.125) / Math.fround(d1 - d2)));
          if (f > enter) { enter = f; lead = { plane, surfaceFlags: side.surfaceFlags }; }
        } else leave = Math.min(leave, Math.min(1, Math.fround(Math.fround(d1 + 0.125) / Math.fround(d1 - d2))));
      }
      if (!startOut) {
        startSolid = true;
        if (!getOut) { allSolid = true; fraction = 0; contents = flags; }
        return;
      }
      if (enter < leave && enter > -1 && enter < fraction && lead !== null) {
        fraction = Math.max(0, enter); tracePlane = bspTracePlane(lead.plane); contents = flags; surfaceFlags = lead.surfaceFlags;
      }
    };
    const patchTrace = (index: number): void => {
      const surface = map.patch(index);
      if (surface === null) return;
      if (surface.checkCount === map.checkCount) return;
      surface.checkCount = map.checkCount;
      if ((surface.contents & query.mask) === 0) return;
      if (stationary) {
        const patch = surface.collide;
        // CM_Trace sets isPoint only for moving traces; zero-size position tests use the box path.
        const positionShape: PatchShape = shape.kind === "point" ? { kind: "box", mins: shape.mins, extents: shape.extents } : shape;
        if (positionInPatch(patch, start, positionShape)) { allSolid = true; startSolid = true; fraction = 0; contents = surface.contents; }
      } else {
        this.counters.c_patch_traces = (this.counters.c_patch_traces + 1) | 0;
        // cm_patch.c gates only CM_TracePointThroughPatchCollide, despite the cvar's name.
        const patchShape: PatchShape = (replacement === null ? pointTrace : replacement.pointTrace)
          ? { kind: "point", mins: sizeMins, extents: shape.extents } : shape;
        if (patchShape.kind === "point" && this.#settings !== null && !this.#settings.playerCurveClip) return;
        const patch = surface.collide;
        const hit = tracePatch(patch, start, end, patchShape, fraction, this.#debug);
        if (hit !== null) {
          fraction = hit.fraction;
          tracePlane = { ...tracePlane, normal: vec3(hit.plane.normal.x, hit.plane.normal.y, hit.plane.normal.z), distance: hit.plane.distance };
          contents = surface.contents; surfaceFlags = surface.surfaceFlags;
        }
      }
    };
    const leafTrace = (index: number): void => {
      const leaf = at(map.leaves, index);
      for (let i = 0; i < leaf.brushCount; i++) { brushTrace(map.leafBrushes.at(leaf.firstBrush + i)); if (fraction === 0) return; }
      if (this.#settings !== null && this.#settings.noCurves) return;
      for (let i = 0; i < leaf.surfaceCount; i++) { patchTrace(map.leafSurfaces.at(leaf.firstSurface + i)); if (fraction === 0) return; }
    };
    const treeTrace = (index: number, p1f: number, p2f: number, p1: Vec3, p2: Vec3): void => {
      if (fraction <= p1f) return;
      if (index < 0) { leafTrace(-1 - index); return; }
      const node = at(map.nodes, index);
      const plane = at(map.planes, node.plane);
      const t1 = Math.fround((plane.type === 0 ? p1.x : plane.type === 1 ? p1.y
        : plane.type === 2 ? p1.z : dot3(p1, plane.normal)) - plane.distance);
      const t2 = Math.fround((plane.type === 0 ? p2.x : plane.type === 1 ? p2.y
        : plane.type === 2 ? p2.z : dot3(p2, plane.normal)) - plane.distance);
      let offset = 0;
      if (!pointTrace && shape.kind !== "point") {
        offset = plane.type === 0 ? shape.extents.x : plane.type === 1 ? shape.extents.y : plane.type === 2 ? shape.extents.z : 2048;
      }
      if (t1 >= offset + 1 && t2 >= offset + 1) { treeTrace(node.children[0], p1f, p2f, p1, p2); return; }
      if (t1 < -offset - 1 && t2 < -offset - 1) { treeTrace(node.children[1], p1f, p2f, p1, p2); return; }
      let side: 0 | 1 = 0, f1 = 1, f2 = 0;
      if (t1 < t2) { side = 1; f2 = (t1 + offset + 0.125) / (t1 - t2); f1 = (t1 - offset + 0.125) / (t1 - t2); }
      else if (t1 > t2) { f2 = (t1 - offset - 0.125) / (t1 - t2); f1 = (t1 + offset + 0.125) / (t1 - t2); }
      f1 = Math.max(0, Math.min(1, Math.fround(f1))); f2 = Math.max(0, Math.min(1, Math.fround(f2)));
      treeTrace(node.children[side], p1f, Math.fround(p1f + (p2f - p1f) * f1), p1, lerp3(p1, p2, f1));
      treeTrace(node.children[side === 0 ? 1 : 0], Math.fround(p1f + (p2f - p1f) * f2), p2f, lerp3(p1, p2, f2), p2);
    };
    if (modelIndex !== 0) {
      for (let i = 0; i < model.brushes.length && fraction !== 0; i++) brushTrace(model.brushes.at(i));
      if (fraction !== 0 && (this.#settings === null || !this.#settings.noCurves)) {
        for (let i = 0; i < model.surfaces.length && fraction !== 0; i++) patchTrace(model.surfaces.at(i));
      }
    } else if (stationary) {
      const extents = shape.kind === "point" ? vec3(0, 0, 0) : shape.extents;
      const leafBounds = { min: sub3(add3(start, sizeMins), vec3(1, 1, 1)), max: add3(add3(start, extents), vec3(1, 1, 1)) };
      const leaves = this.#topology.boxLeafnums(leafBounds, 1024).leaves;
      this.advanceCheckCount();
      for (const leaf of leaves) {
        leafTrace(leaf);
        if (allSolid) break;
      }
    } else treeTrace(map.nodes.length === 0 ? -1 : 0, 0, 1, start, end);
    return { fraction, end: fraction === 1 ? query.end : sourceTraceEnd(query.start, query.end, fraction),
      allSolid, startSolid, plane: tracePlane, contents, surfaceFlags };
  }
}
