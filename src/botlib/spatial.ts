/*
 * AAS sampling and item reachability translated from id Software's
 * be_aas_sample.c, be_aas_reach.c, be_aas_move.c and be_ai_move.c.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { TraceResult } from "../collision/world.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { add3, cross3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { AasFace, AasPlane, AasWorld } from "./aas.ts";
import { aasInsideFace, aasAreaGroundFace, aasFacePlane, aasTraceEndFace } from "./aas-sample-queries.ts";
import type { AasLink, AasLinkHeads, AasLinkHeap } from "./aas-links.ts";
import type { AasBspEntities } from "./bsp-entities.ts";
import { TravelType } from "./routing.ts";
import { AasMovement } from "./aas-movement.ts";
import type { AasMovementSettings, AasClientMove, AasMovementDebug } from "./aas-movement.ts";

export type AasPresence = 2 | 4;
export interface AasBspTrace extends TraceResult { readonly entityNum: number }
/** Genuine botimport services; AAS traversal and area/entity linking stay here. */
export interface AasSpatialHost {
  print(text: string, severity?: 1 | 3 | 4): void;
  trace(start: Vec3, end: Vec3, bounds: Bounds | null, passEntity: number, mask: number): AasBspTrace;
  pointContents(point: Vec3): number;
  entityTrace(entityNum: number, start: Vec3, end: Vec3, bounds: Bounds, mask: number): AasBspTrace;
  entityModelIndex(entityNum: number): number;
  modelBounds(modelIndex: number, angles: Vec3): { readonly bounds: Bounds; readonly origin: Vec3 };
}
export interface AasTrace {
  readonly startSolid: boolean;
  readonly fraction: number;
  readonly end: Vec3;
  readonly entityNum: number;
  readonly lastArea: number;
  readonly area: number;
  /** Source AAS plane index; zero is the source sentinel, not a BSP hit plane. */
  readonly plane: number;
}
export interface AasAreaCrossing { readonly area: number; readonly point: Vec3 }
export interface AasGoalPosition { readonly area: number; readonly origin: Vec3 }
export interface AasJumpPadInfo { readonly start: Vec3; readonly bounds: Bounds; readonly velocity: Vec3 }

const f = Math.fround;
const zero = vec3(0, 0, 0);
const WORLD_ENTITY = 1022, NO_ENTITY = 1023;
const SOLID = 1, PLAYERCLIP = 0x10000;
const MAX_EPAIRKEY = 128;

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`AAS spatial index ${index} outside ${values.length} entries`);
  return value;
}
function finiteVector(value: Vec3): void {
  if (![value.x, value.y, value.z].every(n => Number.isFinite(f(n)))) throw new RangeError("AAS spatial coordinates must be finite float32 values");
}
function same(a: Vec3, b: Vec3): boolean { return a.x === b.x && a.y === b.y && a.z === b.z; }
function ma(a: Vec3, factor: number, b: Vec3): Vec3 { return add3(a, scale3(b, factor)); }
function clearTrace(end: Vec3, lastArea = 0): AasTrace { return { startSolid: false, fraction: 1, end, entityNum: 0, lastArea, area: 0, plane: 0 }; }
function epairText(value: Uint8Array): string {
  let text = "";
  for (const byte of value) { if (byte === 0) break; text += String.fromCharCode(byte); }
  return text;
}

/** Source fixed client sizes, independent of the file's compiler bbox list. */
export function presenceTypeBounds(presence: AasPresence): Bounds {
  return { min: vec3(-15, -15, -24), max: vec3(15, 15, presence === 2 ? 32 : 8) };
}

interface TracePiece { readonly start: Vec3; readonly end: Vec3; readonly node: number; readonly plane: number }
function boxSide(bounds: Bounds, plane: AasPlane): number {
  const near = vec3(plane.normal.x < 0 ? bounds.min.x : bounds.max.x, plane.normal.y < 0 ? bounds.min.y : bounds.max.y, plane.normal.z < 0 ? bounds.min.z : bounds.max.z);
  const far = vec3(plane.normal.x < 0 ? bounds.max.x : bounds.min.x, plane.normal.y < 0 ? bounds.max.y : bounds.min.y, plane.normal.z < 0 ? bounds.max.z : bounds.min.z);
  return (f(dot3(plane.normal, near) - plane.distance) >= 0 ? 1 : 0) | (f(dot3(plane.normal, far) - plane.distance) < 0 ? 2 : 0);
}

/** be_ai_move.c modeltypes survives maps until BotSetBrushModelTypes clears it. */
export class BotBrushModelTypes {
  private readonly modelTypes = new Map<number, 1 | 2 | 3 | 4>();

  set(bspEntities: AasBspEntities, print: (text: string) => void): void {
    this.modelTypes.clear();
    const classnameBuffer = new Uint8Array(MAX_EPAIRKEY), modelBuffer = new Uint8Array(MAX_EPAIRKEY);
    for (let entity = bspEntities.nextEntity(0); entity !== 0; entity = bspEntities.nextEntity(entity)) {
      if (!bspEntities.value(entity, "classname", classnameBuffer)) continue;
      if (!bspEntities.value(entity, "model", modelBuffer)) continue;
      const classname = epairText(classnameBuffer), model = epairText(modelBuffer);
      const index = model.length === 0 ? 0 : nativeAtoi(model.slice(1));
      // Source permits 256 then writes outside modeltypes[MAX_MODELS]. Reject that undefined write.
      if (index < 0 || index >= 256) { print(`entity ${classname} model number out of range\n`); continue; }
      const kind = classname.toLowerCase();
      if (kind === "func_bobbing") this.modelTypes.set(index, 2);
      else if (kind === "func_plat") this.modelTypes.set(index, 1);
      else if (kind === "func_door") this.modelTypes.set(index, 3);
      else if (kind === "func_static") this.modelTypes.set(index, 4);
    }
  }
  get(model: number): 0 | 1 | 2 | 3 | 4 { return this.modelTypes.get(model) ?? 0; }
}

/** Owns map area heads and borrows the retained AAS link heap and BSP owners. */
export class AasSpatial {
  readonly movement: AasMovement;
  private readonly linkedEntities: AasLinkHeads;

  constructor(
    readonly world: AasWorld,
    private readonly bspEntities: AasBspEntities,
    readonly host: AasSpatialHost,
    settings: Readonly<AasMovementSettings>,
    private readonly modelTypes: BotBrushModelTypes,
    private readonly linkHeap: AasLinkHeap,
    debug: AasMovementDebug,
    private readonly visualizeJumpPads: () => number,
    private readonly sampleDebug = false,
  ) {
    this.movement = new AasMovement(this, settings, debug);
    this.linkedEntities = linkHeap.createAreaHeads(world.areas.length);
  }

  setBrushModelTypes(print: (text: string) => void): void { this.modelTypes.set(this.bspEntities, print); }
  brushModelType(model: number): 0 | 1 | 2 | 3 | 4 { return this.modelTypes.get(model); }

  pointArea(origin: Vec3): number { return this.world.pointArea(origin); }
  pointPresenceType(origin: Vec3): number {
    const area = this.pointArea(origin);
    return area === 0 ? 0 : at(this.world.areaSettings, area).presenceType;
  }

  traceAreas(start: Vec3, end: Vec3, maximumAreas: number): readonly AasAreaCrossing[] {
    if (!Number.isInteger(maximumAreas) || maximumAreas < 0) throw new RangeError("Invalid AAS trace area capacity");
    if (maximumAreas === 0) return [];
    const result: AasAreaCrossing[] = [];
    this.writeTraceAreas(start, end, maximumAreas, crossing => { result.push(crossing); return undefined; });
    return result;
  }

  /** The public source call tests capacity after publishing each crossing. */
  writeTraceAreas(start: Vec3, end: Vec3, maximumAreas: number,
    publish: (crossing: AasAreaCrossing, index: number) => undefined): number {
    return AasSpatial.writeWorldTraceAreas(this.world, start, end, maximumAreas, publish,
      text => { this.host.print(text, 3); }, this.sampleDebug);
  }

  /** Sampling needs only the parsed tree, including the source data-loaded phase. */
  static writeWorldTraceAreas(world: AasWorld, start: Vec3, end: Vec3, maximumAreas: number,
    publish: (crossing: AasAreaCrossing, index: number) => undefined, print: (text: string) => void, sampleDebug = false): number {
    const first = vec3(start.x, start.y, start.z), last = vec3(end.x, end.y, end.z);
    finiteVector(first); finiteVector(last);
    const stack: TracePiece[] = [{ start: first, end: last, node: 1, plane: 0 }];
    const push = (piece: TracePiece): boolean => {
      stack.push(piece);
      if (stack.length < 127) return true;
      print("AAS_TraceAreas: stack overflow\n");
      return false;
    };
    let count = 0;
    while (stack.length > 0) {
      const piece = stack.pop();
      if (piece === undefined) break;
      if (piece.node < 0) {
        if (sampleDebug && -piece.node > world.areaSettings.length) {
          print(`AAS_TraceAreas: -nodenum = ${-piece.node} out of range\n`);
          return count;
        }
        publish({ area: -piece.node, point: piece.start }, count++);
        if (count >= maximumAreas) break;
      } else if (piece.node > 0) {
        if (sampleDebug && piece.node > world.nodes.length) {
          print("AAS_TraceAreas: nodenum out of range\n");
          return count;
        }
        const node = at(world.nodes, piece.node), plane = at(world.planes, node.plane);
        const front = f(dot3(piece.start, plane.normal) - plane.distance), back = f(dot3(piece.end, plane.normal) - plane.distance);
        if (front > 0 && back > 0) { if (!push({ ...piece, node: node.children[0] })) return count; }
        else if (front <= 0 && back <= 0) { if (!push({ ...piece, node: node.children[1] })) return count; }
        else {
          const fraction = Math.max(0, Math.min(1, f(front / f(front - back))));
          const middle = ma(piece.start, fraction, sub3(piece.end, piece.start));
          const side = front < 0 ? 1 : 0;
          if (!push({ start: middle, end: piece.end, node: node.children[side === 0 ? 1 : 0], plane: node.plane })) return count;
          if (!push({ start: piece.start, end: middle, node: node.children[side], plane: piece.plane })) return count;
        }
      }
    }
    return count;
  }

  presenceBounds(presence: number): Bounds {
    if (presence !== 2 && presence !== 4) {
      this.host.print("AAS_PresenceTypeBoundingBox: unknown presence type\n", 4);
      return presenceTypeBounds(4);
    }
    return presenceTypeBounds(presence);
  }

  traceClientBBox(start: Vec3, end: Vec3, presence: number, passEntity: number): AasTrace {
    return AasSpatial.traceWorldClientBBox(this.world, start, end, presence, passEntity,
      (area, segmentStart, segmentEnd) => this.traceAreaEntityCollision(area, segmentStart, segmentEnd,
        this.presenceBounds(presence), passEntity,
        (entity, entityStart, entityEnd, bounds, mask) => this.host.entityTrace(entity, entityStart, entityEnd, bounds, mask)),
      text => { this.host.print(text, 3); }, this.sampleDebug);
  }

  traceAreaEntityCollision(area: number, start: Vec3, end: Vec3, bounds: Bounds, passEntity: number,
    entityTrace: AasSpatialHost["entityTrace"]): AasBspTrace | null {
    let best: AasBspTrace | null = null;
    for (let link = this.linkedEntities.get(area); link !== null; link = link.nextEntity) {
      if (link.entity === passEntity) continue;
      const hit = entityTrace(link.entity, start, end, bounds, SOLID | PLAYERCLIP);
      if (hit.fraction < (best === null ? 1 : best.fraction)) best = hit;
    }
    return best;
  }

  static traceWorldClientBBox(world: AasWorld, start: Vec3, end: Vec3, presence: number, passEntity: number,
    traceEntities: (area: number, start: Vec3, end: Vec3) => AasBspTrace | null,
    print: (message: string) => void, sampleDebug = false): AasTrace {
    finiteVector(start); finiteVector(end);
    const stack: TracePiece[] = [{ start: vec3(start.x, start.y, start.z), end: vec3(end.x, end.y, end.z), node: 1, plane: 0 }];
    let lastArea = 0;
    const push = (piece: TracePiece): boolean => {
      stack.push(piece);
      if (stack.length < 127) return true;
      print("AAS_TraceBoundingBox: stack overflow\n");
      return false;
    };
    const overflow = (): AasTrace => ({ startSolid: false, fraction: 0, end: vec3(0, 0, 0), entityNum: 0,
      lastArea, area: 0, plane: 0 });
    while (stack.length > 0) {
      const piece = stack.pop();
      if (piece === undefined) break;
      if (piece.node <= 0) {
        if (sampleDebug && -piece.node > world.areaSettings.length) {
          print("AAS_TraceBoundingBox: -nodenum out of range\n");
          return overflow();
        }
        if (piece.node === 0 || (at(world.areaSettings, -piece.node).presenceType & presence) === 0) {
          const startSolid = same(piece.start, start), direction = startSolid ? zero : normalize3(sub3(end, start));
          const fraction = startSolid ? 0 : f(length3(sub3(piece.start, start)) / length3(sub3(end, start)));
          const hitEnd = startSolid ? piece.start : ma(piece.start, -0.125, direction);
          const plane = dot3(direction, at(world.planes, piece.plane).normal) > 0 ? piece.plane ^ 1 : piece.plane;
          return { startSolid, fraction, end: hitEnd, entityNum: 0, lastArea, area: piece.node === 0 ? 0 : -piece.node, plane };
        }
        if (passEntity >= 0) {
          const best = traceEntities(-piece.node, piece.start, piece.end);
          if (best !== null) {
            const startSolid = best.solidity !== "clear";
            return { startSolid, fraction: startSolid ? 0 : f(length3(sub3(best.end, start)) / length3(sub3(end, start))),
              end: best.end, entityNum: best.entityNum, lastArea, area: 0, plane: 0 };
          }
        }
        lastArea = -piece.node;
        continue;
      }
      if (sampleDebug && piece.node > world.nodes.length) {
        print("AAS_TraceBoundingBox: nodenum out of range\n");
        return overflow();
      }
      const node = at(world.nodes, piece.node), plane = at(world.planes, node.plane);
      let front = f(dot3(piece.start, plane.normal) - plane.distance);
      const back = f(dot3(piece.end, plane.normal) - plane.distance);
      if (front >= 0 && back >= 0) { if (!push({ ...piece, node: node.children[0] })) return overflow(); }
      else if (front < 0 && back < 0) { if (!push({ ...piece, node: node.children[1] })) return overflow(); }
      else {
        if (front === back) front = f(front - f(0.001));
        let fraction = f((front < 0 ? front + 0.125 : front - 0.125) / f(front - back));
        if (fraction < 0) fraction = f(0.001);
        else if (fraction > 1) fraction = f(0.999);
        const middle = ma(piece.start, fraction, sub3(piece.end, piece.start)), side = front < 0 ? 1 : 0;
        if (!push({ start: middle, end: piece.end, node: node.children[side === 0 ? 1 : 0], plane: node.plane })) return overflow();
        if (!push({ start: piece.start, end: middle, node: node.children[side], plane: piece.plane })) return overflow();
      }
    }
    return clearTrace(end, lastArea);
  }

  /** AAS_AASLinkEntity returns the partial area chain if its retained heap fills. */
  private linkEntityBounds(entity: number, bounds: Bounds): AasLink | null {
    finiteVector(bounds.min); finiteVector(bounds.max);
    const stack = [1];
    let areas: AasLink | null = null;
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) break;
      if (index < 0) {
        const firstEntity = this.linkedEntities.get(-index);
        let existing = firstEntity;
        while (existing !== null && existing.entity !== entity) existing = existing.nextEntity;
        if (existing !== null) continue;
        const link = this.linkHeap.allocate();
        if (link === null) return areas;
        link.entity = entity;
        link.area = -index;
        link.previousArea = null;
        link.nextArea = areas;
        if (areas !== null) areas.previousArea = link;
        areas = link;
        link.previousEntity = null;
        link.nextEntity = firstEntity;
        if (firstEntity !== null) firstEntity.previousEntity = link;
        this.linkedEntities.set(-index, link);
      } else if (index > 0) {
        const node = at(this.world.nodes, index), side = boxSide(bounds, at(this.world.planes, node.plane));
        if ((side & 1) !== 0) stack.push(node.children[0]);
        if (stack.length >= 127) { this.host.print("AAS_LinkEntity: stack overflow\n", 3); break; }
        if ((side & 2) !== 0) stack.push(node.children[1]);
        if (stack.length >= 127) { this.host.print("AAS_LinkEntity: stack overflow\n", 3); break; }
      }
    }
    return areas;
  }

  linkClientBounds(entity: number, bounds: Bounds, presence: AasPresence): AasLink | null {
    const client = presenceTypeBounds(presence);
    return this.linkEntityBounds(entity, { min: sub3(bounds.min, client.max), max: sub3(bounds.max, client.min) });
  }

  private areasForLinks(links: AasLink | null): readonly number[] {
    const areas: number[] = [];
    for (let link = links; link !== null; link = link.nextArea) areas.push(link.area);
    return areas;
  }

  unlinkFromAreas(areas: AasLink | null): void {
    let link = areas;
    while (link !== null) {
      const next = link.nextArea;
      if (link.previousEntity !== null) link.previousEntity.nextEntity = link.nextEntity;
      else this.linkedEntities.set(link.area, link.nextEntity);
      if (link.nextEntity !== null) link.nextEntity.previousEntity = link.previousEntity;
      this.linkHeap.release(link);
      link = next;
    }
  }

  /** AAS_BBoxAreas borrows actual heap cells under the source temporary entity -1. */
  bboxAreas(bounds: Bounds): readonly number[] {
    const areas: number[] = [];
    this.writeBBoxAreas(bounds, 2147483647, area => { areas.push(area); return undefined; });
    return areas;
  }

  /** Writes while the temporary links still belong to the actual source heap. */
  writeBBoxAreas(bounds: Bounds, maximumAreas: number,
    publish: (area: number, index: number) => undefined): number {
    const links = this.linkEntityBounds(-1, bounds);
    let count = 0;
    for (let link = links; link !== null; link = link.nextArea) {
      publish(link.area, count++);
      if (count >= maximumAreas) break;
    }
    this.unlinkFromAreas(links);
    return count;
  }

  clientBBoxAreas(bounds: Bounds, presence: AasPresence): readonly number[] {
    const links = this.linkClientBounds(-1, bounds, presence), areas = this.areasForLinks(links);
    this.unlinkFromAreas(links);
    return areas;
  }

  /** AAS_FreeAASLinkedEntities frees only the map's area-to-entity head allocation. */
  freeLinkedEntities(): void { this.linkedEntities.free(); }

  bestReachableLinkArea(areas: readonly number[]): number {
    for (const area of areas) if ((at(this.world.areaSettings, area).flags & (1 | 4)) !== 0) return area;
    // Source returns the first nonzero linked area even without reachabilities.
    for (const area of areas) if (area !== 0) return area;
    return 0;
  }

  bestReachableArea(origin: Vec3, bounds: Bounds): AasGoalPosition {
    let start = origin, area = this.world.pointArea(start);
    for (let i = 0; i < 5 && area === 0; i++) for (let j = 0; j < 5 && area === 0; j++) {
      for (let k = -1; k <= 1 && area === 0; k++) for (let l = -1; l <= 1 && area === 0; l++) {
        start = vec3(origin.x + j * 4 * k, origin.y + j * 4 * l, origin.z + i * 4);
        area = this.world.pointArea(start);
      }
    }
    if (area !== 0) {
      const end = vec3(start.x, start.y, start.z - 50);
      start = vec3(start.x, start.y, start.z + 0.25);
      const trace = this.traceClientBBox(start, end, 4, -1);
      if (trace.startSolid) return { area, origin: start };
      area = this.world.pointArea(trace.end);
      if (area !== 0) return { area, origin: trace.end };
    }
    const links = this.linkClientBounds(-1, { min: add3(origin, bounds.min), max: add3(origin, bounds.max) }, 4);
    const bestArea = this.bestReachableLinkArea(this.areasForLinks(links));
    this.unlinkFromAreas(links);
    return { area: bestArea, origin };
  }

  fuzzyPointReachabilityArea(origin: Vec3): number {
    let firstArea = this.world.pointArea(origin);
    if (firstArea !== 0 && this.hasReachability(firstArea)) return firstArea;
    for (const crossing of this.traceAreas(origin, vec3(origin.x, origin.y, origin.z + 4), 10)) {
      if (this.hasReachability(crossing.area)) return crossing.area;
    }
    let bestDistance = 999999, bestArea = 0;
    for (let z = 1; z >= -1; z--) {
      for (let x = 1; x >= -1; x--) for (let y = 1; y >= -1; y--) {
        for (const crossing of this.traceAreas(origin, vec3(origin.x + x * 8, origin.y + y * 8, origin.z + z * 12), 10)) {
          if (this.hasReachability(crossing.area)) {
            const distance = length3(sub3(crossing.point, origin));
            if (distance < bestDistance) { bestDistance = distance; bestArea = crossing.area; }
          }
          if (firstArea === 0) firstArea = crossing.area;
        }
      }
      if (bestArea !== 0) return bestArea;
    }
    return firstArea;
  }

  reachabilityArea(origin: Vec3, client: number): number {
    const trace = this.host.trace(origin, vec3(origin.x, origin.y, origin.z - 3), presenceTypeBounds(4), client, SOLID | PLAYERCLIP);
    if (trace.solidity === "clear" && trace.fraction < 1 && trace.entityNum !== NO_ENTITY) {
      if (trace.entityNum === WORLD_ENTITY) return this.fuzzyPointReachabilityArea(origin);
      const model = this.host.entityModelIndex(trace.entityNum), kind = this.brushModelType(model);
      if (kind === 1 || kind === 2) {
        for (let i = 1; i < this.world.reachability.length; i++) {
          const reach = at(this.world.reachability, i), travel = reach.travelType & TravelType.MASK;
          if ((travel === TravelType.ELEVATOR && reach.face === model) || (travel === TravelType.FUNCBOB && (reach.face & 0xffff) === model)) return reach.area;
        }
      }
      if (this.movement.swimming(origin)) return this.fuzzyPointReachabilityArea(origin);
      const area = this.fuzzyPointReachabilityArea(origin);
      if (area !== 0 && this.hasReachability(area)) return area;
      const floor = this.traceClientBBox(origin, vec3(origin.x, origin.y, origin.z - 800), 4, -1);
      return this.fuzzyPointReachabilityArea(floor.startSolid ? origin : floor.end);
    }
    return this.fuzzyPointReachabilityArea(origin);
  }

  dropToFloor(origin: Vec3, bounds: Bounds): { readonly success: boolean; readonly origin: Vec3 } {
    return this.movement.dropToFloor(origin, bounds);
  }

  private hasReachability(area: number): boolean { return at(this.world.areaSettings, area).reachableAreaCount !== 0; }
  private modelIndex(model: string): number { return nativeAtoi(model.slice(1)); }

  /** Exact GoalAI invocation, now using the complete authoritative predictor. */
  predictJumpPadHit(origin: Vec3, velocity: Vec3, bounds: Bounds, visualize: boolean): AasClientMove {
    return this.movement.clientMovementHitBBox({ entityNum: -1, origin, velocity, presence: 2, onGround: false,
      commandMove: zero, commandFrames: 0, maxFrames: 30, frameTime: f(0.1), visualize }, bounds).move;
  }

  /** AAS_PointInsideFace from be_aas_sample.c; this owner always contains a loaded world. */
  pointInsideFace(faceNumber: number, point: Vec3, epsilon: number): boolean {
    const face = at(this.world.faces, faceNumber), plane = at(this.world.planes, face.plane);
    return aasInsideFace(this.world, face, plane.normal, point, epsilon, this.sampleDebug ? text => this.host.print(text, 1) : null);
  }

  areaGroundFace(area: number, point: Vec3): AasFace | null {
    return aasAreaGroundFace(this.world, area, point, this.sampleDebug ? text => this.host.print(text, 1) : null);
  }
  traceEndFace(trace: AasTrace): AasFace | null {
    return aasTraceEndFace(this.world, trace, this.sampleDebug ? text => this.host.print(text, 1) : null);
  }
  facePlane(face: number): AasPlane { return aasFacePlane(this.world, face); }

  /** AAS_GetJumpPadInfo is shared by goal sampling and reachability generation. */
  getJumpPadInfo(entity: number): AasJumpPadInfo | null {
    const valueBuffer = new Uint8Array(MAX_EPAIRKEY), targetBuffer = new Uint8Array(MAX_EPAIRKEY), targetNameBuffer = new Uint8Array(MAX_EPAIRKEY);
    this.bspEntities.float(entity, "speed");
    this.bspEntities.value(entity, "model", valueBuffer);
    const model = epairText(valueBuffer), modelIndex = model.length === 0 ? 0 : this.modelIndex(model);
    const modelInfo = this.host.modelBounds(modelIndex, zero);
    const absolute = { min: add3(modelInfo.origin, modelInfo.bounds.min), max: add3(modelInfo.origin, modelInfo.bounds.max) };
    const center = scale3(add3(absolute.min, absolute.max), 0.5);
    const trace = this.traceClientBBox(vec3(center.x, center.y, center.z + 64), center, 4, -1);
    if (trace.startSolid) this.host.print("trigger_push start solid\n");
    const bottom = trace.startSolid ? center : trace.end, start = vec3(bottom.x, bottom.y, bottom.z + 0.125);
    this.bspEntities.value(entity, "target", targetBuffer);
    const targetName = epairText(targetBuffer);
    let target = this.bspEntities.nextEntity(0);
    for (; target !== 0; target = this.bspEntities.nextEntity(target)) {
      if (!this.bspEntities.value(target, "targetname", targetNameBuffer)) continue;
      if (epairText(targetNameBuffer) === targetName) break;
    }
    if (target === 0) { this.host.print(`trigger_push without target entity ${targetName}\n`); return null; }
    const destination = this.bspEntities.vector(target, "origin").value;
    const height = f(destination.z - center.z), time = f(Math.sqrt(height / (0.5 * f(this.movement.settings.gravity))));
    if (time === 0) { this.host.print("trigger_push without time\n"); return null; }
    if (!Number.isFinite(time)) throw new RangeError("Jump-pad target produces a non-finite source flight time");
    const delta = sub3(destination, center), distance = length3(delta);
    const forward = f(f(distance / time) * f(1.1));
    const push = scale3(normalize3(delta), forward), velocity = vec3(push.x, push.y, time * f(this.movement.settings.gravity));
    return { start, bounds: absolute, velocity };
  }

  bestReachableFromJumpPadArea(origin: Vec3, bounds: Bounds): number {
    const setting = Math.trunc(this.visualizeJumpPads());
    if (!Number.isInteger(setting) || setting < -2147483648 || setting > 2147483647) {
      throw new RangeError("Jump-pad visualization setting exceeds the source signed integer range");
    }
    const visualize = setting !== 0;
    const targetBounds = { min: add3(origin, bounds.min), max: add3(origin, bounds.max) };
    const valueBuffer = new Uint8Array(MAX_EPAIRKEY);
    for (let entity = this.bspEntities.nextEntity(0); entity !== 0; entity = this.bspEntities.nextEntity(entity)) {
      if (!this.bspEntities.value(entity, "classname", valueBuffer) || epairText(valueBuffer) !== "trigger_push") continue;
      const info = this.getJumpPadInfo(entity);
      if (info === null) continue;
      const { start, bounds: absolute, velocity } = info;
      const links = this.linkClientBounds(-1, absolute, 4);
      let jumpPadLink = links;
      while (jumpPadLink !== null && (at(this.world.areaSettings, jumpPadLink.area).contents & 128) === 0) jumpPadLink = jumpPadLink.nextArea;
      if (jumpPadLink === null) {
        this.host.print("trigger_push not in any jump pad area\n");
        this.unlinkFromAreas(links);
        continue;
      }
      if (this.predictJumpPadHit(start, velocity, targetBounds, visualize).frames >= 30) {
        this.unlinkFromAreas(links);
        continue;
      }
      let bestArea = 0, bestVolume = 0;
      for (let link = links; link !== null; link = link.nextArea) {
        const area = link.area;
        if ((at(this.world.areaSettings, area).contents & 128) === 0) continue;
        const volume = this.areaVolume(area);
        if (volume >= bestVolume) { bestArea = area; bestVolume = volume; }
      }
      this.unlinkFromAreas(links);
      return bestArea;
    }
    return 0;
  }

  private areaVolume(areaNumber: number): number {
    const area = at(this.world.areas, areaNumber);
    // Optimized retail AAS areas have no faces. AAS_LoadAASLump allocates
    // cleared dummy records for empty lumps; the source's corner reads are
    // unused and its zero-iteration volume sum returns zero.
    if (area.faceCount === 0) return 0;
    const firstFace = at(this.world.faces, Math.abs(at(this.world.faceIndexes, area.firstFace)));
    const firstEdge = at(this.world.edges, Math.abs(at(this.world.edgeIndexes, firstFace.firstEdge)));
    const corner = at(this.world.vertices, firstEdge.vertices[0]);
    let volume = 0;
    for (let i = 0; i < area.faceCount; i++) {
      const face = at(this.world.faces, Math.abs(at(this.world.faceIndexes, area.firstFace + i)));
      const plane = at(this.world.planes, face.plane ^ (face.backArea !== areaNumber ? 1 : 0));
      const distance = -f(dot3(corner, plane.normal) - plane.distance);
      const edgeIndex = at(this.world.edgeIndexes, face.firstEdge), edge = at(this.world.edges, Math.abs(edgeIndex));
      const vertex = at(this.world.vertices, edge.vertices[edgeIndex < 0 ? 1 : 0]);
      let surfaceArea = 0;
      for (let j = 1; j < face.edgeCount - 1; j++) {
        const signedEdge = at(this.world.edgeIndexes, face.firstEdge + j), current = at(this.world.edges, Math.abs(signedEdge)), side = signedEdge < 0 ? 1 : 0;
        const d1 = sub3(at(this.world.vertices, current.vertices[side]), vertex);
        const d2 = sub3(at(this.world.vertices, current.vertices[side === 0 ? 1 : 0]), vertex);
        surfaceArea = f(surfaceArea + 0.5 * length3(cross3(d1, d2)));
      }
      volume = f(volume + f(distance * surfaceArea));
    }
    return f(volume / 3);
  }
}
