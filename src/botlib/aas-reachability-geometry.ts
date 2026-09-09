/*
 * Area geometry and ordinary reachabilities from id Software's
 * code/botlib/be_aas_reach.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Bounds, Vec3 } from "../core/math.ts";
import { add3, cross3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { AasFace, AasPlane, AasWorld } from "./aas.ts";
import type { AasMovementSettings } from "./aas-movement.ts";
import { AasStopEvent } from "./aas-movement.ts";
import type { AasLinkedReachability, AasReachabilityContext } from "./aas-reachability.ts";
import { TravelType } from "./routing.ts";

const f = Math.fround;
const ZERO = vec3(0, 0, 0), UP = vec3(0, 0, 1);
const AXES: readonly (keyof Vec3)[] = ["x", "y", "z"];

export function aasAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`AAS reachability index ${index} outside ${values.length}`);
  return value;
}

function ma(start: Vec3, scale: number, direction: Vec3): Vec3 { return add3(start, scale3(direction, scale)); }
function maDouble(start: Vec3, scale: number, direction: Vec3): Vec3 {
  return vec3(start.x + scale * direction.x, start.y + scale * direction.y, start.z + scale * direction.z);
}
function z(point: Vec3, height: number): Vec3 { return vec3(point.x, point.y, height); }
function sourceInteger(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError("AAS reachability numeric conversion exceeds source signed integer range");
  }
  return integer + 0;
}
function integerAbs(value: number): number {
  const integer = sourceInteger(value);
  if (integer === -2147483648) throw new RangeError("AAS reachability abs of INT_MIN is undefined");
  return Math.abs(integer);
}
function closeBounds(a: Bounds, b: Bounds, vertical: boolean): boolean {
  for (const axis of AXES) {
    if (!vertical && axis === "z") continue;
    if (a.min[axis] > f(b.max[axis] + 10) || a.max[axis] < f(b.min[axis] - 10)) return false;
  }
  return true;
}

export function aasFaceArea(world: AasWorld, face: AasFace): number {
  const first = aasAt(world.edgeIndexes, face.firstEdge), edge = aasAt(world.edges, Math.abs(first));
  const origin = aasAt(world.vertices, edge.vertices[first < 0 ? 1 : 0]);
  let total = 0;
  for (let i = 1; i < face.edgeCount - 1; i++) {
    const number = aasAt(world.edgeIndexes, face.firstEdge + i), current = aasAt(world.edges, Math.abs(number));
    const firstVertex = aasAt(world.vertices, current.vertices[number < 0 ? 1 : 0]);
    const lastVertex = aasAt(world.vertices, current.vertices[number < 0 ? 0 : 1]);
    total = f(total + 0.5 * length3(cross3(sub3(firstVertex, origin), sub3(lastVertex, origin))));
  }
  return total;
}

export function aasAreaVolume(world: AasWorld, areaNumber: number): number {
  const area = aasAt(world.areas, areaNumber);
  const firstFace = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area.firstFace)));
  const edge = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, firstFace.firstEdge)));
  const corner = aasAt(world.vertices, edge.vertices[0]);
  let volume = 0;
  for (let i = 0; i < area.faceCount; i++) {
    const face = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area.firstFace + i)));
    const plane = aasAt(world.planes, face.plane ^ (face.backArea !== areaNumber ? 1 : 0));
    const distance = -f(dot3(corner, plane.normal) - plane.distance);
    volume = f(volume + f(distance * aasFaceArea(world, face)));
  }
  return f(volume / 3);
}

export function aasAreaGroundFaceArea(world: AasWorld, areaNumber: number): number {
  const area = aasAt(world.areas, areaNumber);
  let total = 0;
  for (let i = 0; i < area.faceCount; i++) {
    const face = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area.firstFace + i)));
    if ((face.flags & 4) !== 0) total = f(total + aasFaceArea(world, face));
  }
  return total;
}

export function aasFaceCenter(world: AasWorld, faceNumber: number): Vec3 {
  const face = aasAt(world.faces, faceNumber);
  let center = ZERO;
  for (let i = 0; i < face.edgeCount; i++) {
    const edge = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, face.firstEdge + i)));
    center = add3(center, aasAt(world.vertices, edge.vertices[0]));
    center = add3(center, aasAt(world.vertices, edge.vertices[1]));
  }
  return scale3(center, f(0.5 / face.edgeCount));
}

export function aasFallDamageDistance(settings: AasMovementSettings): number {
  const velocity = f(Math.sqrt(30 * 10000)), time = f(velocity / settings.gravity);
  return sourceInteger(0.5 * settings.gravity * time * time);
}

export function aasFallDelta(settings: AasMovementSettings, distance: number): number {
  const time = f(Math.sqrt(Math.abs(distance) * 2 / settings.gravity)), delta = f(time * settings.gravity);
  return f(f(delta * delta) * 0.0001);
}

export function aasMaxJumpHeight(settings: AasMovementSettings, velocity: number): number {
  const time = f(velocity / settings.gravity);
  return f(0.5 * settings.gravity * time * time);
}

export function aasMaxJumpDistance(settings: AasMovementSettings, velocity: number): number {
  const time = f(Math.sqrt(settings.maxJumpFallHeight / (0.5 * settings.gravity)));
  return f(settings.maxVelocity * f(time + f(velocity / settings.gravity)));
}

export function aasBarrierJumpTravelTime(settings: AasMovementSettings): number {
  return sourceInteger(settings.jumpVelocity / (settings.gravity * 0.1)) & 0xffff;
}

export interface AasClosestEdgeRange {
  readonly start1: Vec3; readonly end1: Vec3; readonly start2: Vec3; readonly end2: Vec3;
}
export interface AasClosestEdgeState { range: AasClosestEdgeRange | null }

/** Active AAS_ClosestEdgePoints, including its original horizontal projection formula. */
export function aasClosestEdgePoints(v1: Vec3, v2: Vec3, v3: Vec3, v4: Vec3,
  plane1: AasPlane, plane2: AasPlane, state: AasClosestEdgeState, bestDistance: number): number {
  const direction1 = z(sub3(v2, v1), 0), direction2 = z(sub3(v4, v3), 0);
  function projection(point: Vec3, edgeStart: Vec3, direction: Vec3, plane: AasPlane): Vec3 {
    let flat: Vec3;
    if (direction.x !== 0) {
      const a = f(direction.y / direction.x), b = f(edgeStart.y - f(a * edgeStart.x));
      const x = f(f(dot3(point, direction) - f(f(a * direction.x) + f(b * direction.y))) / direction.x);
      flat = vec3(x, f(f(a * x) + b), 0);
    } else flat = vec3(edgeStart.x, point.y, 0);
    return z(flat, f(f(plane.distance - dot3(plane.normal, flat)) / plane.normal.z));
  }
  const p1 = projection(v1, v3, direction2, plane2), p2 = projection(v2, v3, direction2, plane2);
  const p3 = projection(v3, v1, direction1, plane1), p4 = projection(v4, v1, direction1, plane1);
  const distance = (a: Vec3, b: Vec3): number => length3(sub3(b, a));
  const between = (point: Vec3, a: Vec3, b: Vec3): boolean => dot3(sub3(point, a), sub3(point, b)) <= 0;
  function update(start: Vec3, end: Vec3, allowRange: boolean): void {
    const current = distance(start, end);
    if (allowRange && current > bestDistance - 0.5 && current < bestDistance + 0.5) {
      const range = state.range;
      if (range === null) throw new Error("AAS_ClosestEdgePoints reads an uninitialized closest-point range");
      let { start1, start2, end1, end2 } = range;
      const firstStart = distance(start1, start), secondStart = distance(start2, start);
      if (firstStart > secondStart) {
        if (firstStart > distance(start1, start2)) start2 = start;
      } else if (secondStart > distance(start1, start2)) start1 = start;
      const firstEnd = distance(end1, end), secondEnd = distance(end2, end);
      if (firstEnd > secondEnd) {
        if (firstEnd > distance(end1, end2)) end2 = end;
      } else if (secondEnd > distance(end1, end2)) end1 = end;
      state.range = { start1, start2, end1, end2 };
    } else if (current < bestDistance) {
      bestDistance = current;
      state.range = { start1: start, start2: start, end1: end, end2: end };
    }
  }
  let found = false;
  if (between(p1, v3, v4)) { update(v1, p1, true); found = true; }
  if (between(p2, v3, v4)) { update(v2, p2, true); found = true; }
  if (between(p3, v1, v2)) { update(p3, v3, true); found = true; }
  if (between(p4, v1, v2)) { update(p4, v4, true); found = true; }
  if (!found) { update(v1, v3, false); update(v1, v4, false); update(v2, v3, false); update(v2, v4, false); }
  return bestDistance;
}

interface StepCandidate {
  readonly distance: number; readonly length: number; readonly edge: number;
  readonly start: Vec3; readonly end: Vec3; readonly normal: Vec3;
}

export class AasReachabilityGeometry {
  constructor(private readonly context: AasReachabilityContext) {}
  private grounded(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).flags & 1) !== 0; }
  private swimArea(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).flags & 4) !== 0; }
  private crouch(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).presenceType & 2) === 0; }
  private ladderArea(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).flags & 2) !== 0; }
  private link(area: number, reach: AasLinkedReachability): void {
    reach.next = aasAt(this.context.heads, area);
    this.context.heads[area] = reach;
  }

  nearbySolidOrGap(start: Vec3, end: Vec3): boolean {
    const { world } = this.context;
    const direction = normalize3(z(sub3(end, start), 0));
    let point = ma(end, 48, direction), area = world.pointArea(point);
    if (area === 0) {
      point = z(point, point.z + 16);
      area = world.pointArea(point);
      if (area === 0) return true;
    }
    area = world.pointArea(ma(end, 64, direction));
    return area !== 0 && !this.swimArea(area) && !this.grounded(area);
  }

  swim(from: number, to: number): boolean {
    const { world, spatial } = this.context;
    if (!this.swimArea(from) || !this.swimArea(to) || this.crouch(to)) return false;
    const area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to);
    if (!closeBounds(area1.bounds, area2.bounds, true)) return false;
    for (let i = 0; i < area1.faceCount; i++) {
      const signedFace = aasAt(world.faceIndexes, area1.firstFace + i), faceNumber = Math.abs(signedFace);
      for (let j = 0; j < area2.faceCount; j++) {
        if (faceNumber !== Math.abs(aasAt(world.faceIndexes, area2.firstFace + j))) continue;
        const start = aasFaceCenter(world, faceNumber);
        if ((spatial.host.pointContents(start) & 56) === 0) continue;
        const face = aasAt(world.faces, faceNumber), reach = this.context.allocate();
        if (reach === null) return false;
        reach.area = to; reach.face = faceNumber; reach.edge = 0; reach.start = start;
        reach.end = ma(start, -2, aasAt(world.planes, face.plane ^ (signedFace < 0 ? 1 : 0)).normal);
        reach.travelType = TravelType.SWIM; reach.travelTime = 1;
        if (aasAreaVolume(world, to) < 800) reach.travelTime += 200;
        this.link(from, reach);
        return true;
      }
    }
    return false;
  }

  equalFloorHeight(from: number, to: number): boolean {
    const { world, settings } = this.context;
    if (!this.grounded(from) || !this.grounded(to)) return false;
    const area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to);
    if (!closeBounds(area1.bounds, area2.bounds, false) || area2.bounds.min.z > area1.bounds.max.z) return false;
    let best: { readonly height: number; readonly length: number; readonly edge: number; readonly start: Vec3; readonly end: Vec3 } | null = null;
    for (let i = 0; i < area1.faceCount; i++) {
      const face1 = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area1.firstFace + i)));
      if ((face1.flags & 4) === 0) continue;
      for (let j = 0; j < area2.faceCount; j++) {
        const face2 = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area2.firstFace + j)));
        if ((face2.flags & 4) === 0) continue;
        for (let first = 0; first < face1.edgeCount; first++) for (let second = 0; second < face2.edgeCount; second++) {
          const number = aasAt(world.edgeIndexes, face1.firstEdge + first);
          if (Math.abs(number) !== Math.abs(aasAt(world.edgeIndexes, face2.firstEdge + second))) continue;
          const edge = aasAt(world.edges, Math.abs(number));
          const v0 = aasAt(world.vertices, edge.vertices[0]), v1 = aasAt(world.vertices, edge.vertices[1]);
          const length = length3(sub3(v1, v0)), midpoint = scale3(add3(v0, v1), 0.5);
          const edgeVector = number < 0 ? sub3(v1, v0) : sub3(v0, v1);
          const normal = normalize3(cross3(edgeVector, aasAt(world.planes, face2.plane).normal));
          const start = maDouble(midpoint, 0.1, normal), rawEnd = ma(midpoint, 5, normal), end = z(rawEnd, rawEnd.z + 0.125);
          const height = dot3(UP, start), bestHeight = best === null ? 99999 : best.height, bestLength = best === null ? 0 : best.length;
          if (height < bestHeight || (height < f(bestHeight + 1) && length > bestLength)) best = { height, length, edge: number, start, end };
        }
      }
    }
    if (best === null) return false;
    const reach = this.context.allocate();
    if (reach === null) return false;
    reach.area = to; reach.face = 0; reach.edge = best.edge; reach.start = best.start; reach.end = best.end;
    reach.travelType = TravelType.WALK; reach.travelTime = 1;
    this.link(from, reach);
    if (!this.crouch(from) && this.crouch(to)) reach.travelTime = f(reach.travelTime + settings.startCrouchTime);
    return true;
  }

  stepBarrierWaterJumpWalkOffLedge(from: number, to: number): boolean {
    const { world, spatial, settings } = this.context;
    if ((!this.grounded(from) && !this.swimArea(from)) || (!this.grounded(to) && !this.swimArea(to))) return false;
    const area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to), swim1 = this.swimArea(from);
    if (!closeBounds(area1.bounds, area2.bounds, false)) return false;
    let ground: StepCandidate | null = null, water: StepCandidate | null = null;
    for (let i = 0; i < area1.faceCount; i++) {
      const faceNumber = aasAt(world.faceIndexes, area1.firstFace + i), faceSide = faceNumber < 0;
      const face1 = aasAt(world.faces, Math.abs(faceNumber));
      if ((face1.flags & 4) === 0) {
        if (!swim1 || dot3(aasAt(world.planes, face1.plane ^ (faceSide ? 0 : 1)).normal, UP) < 0.7) continue;
      }
      for (let k = 0; k < face1.edgeCount; k++) {
        const signedEdge = aasAt(world.edgeIndexes, face1.firstEdge + k), edgeNumber = Math.abs(signedEdge);
        let side = signedEdge < 0;
        if ((face1.flags & 4) === 0) side = side === faceSide;
        const edge1 = aasAt(world.edges, edgeNumber);
        let v1 = aasAt(world.vertices, edge1.vertices[side ? 0 : 1]), v2 = aasAt(world.vertices, edge1.vertices[side ? 1 : 0]);
        const normal = normalize3(cross3(sub3(v2, v1), UP));
        // Source reuses dist for the vertical separation inside the nested edge loop.
        let dist = dot3(normal, v1);
        for (let j = 0; j < area2.faceCount; j++) {
          const face2 = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area2.firstFace + j)));
          if ((face2.flags & 4) === 0) continue;
          for (let l = 0; l < face2.edgeCount; l++) {
            const edge2 = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, face2.firstEdge + l)));
            let v3 = aasAt(world.vertices, edge2.vertices[0]), v4 = aasAt(world.vertices, edge2.vertices[1]);
            const diff1 = f(dot3(normal, v3) - dist), diff2 = f(dot3(normal, v4) - dist);
            if (diff1 < -0.1 || diff1 > 0.1 || diff2 < -0.1 || diff2 > 0.1) continue;
            const ort = cross3(UP, normal), ortDot = dot3(ort, ort);
            let y1 = v1.z, y2 = v2.z, y3 = v3.z, y4 = v4.z;
            let x1 = f(dot3(v1, ort) / ortDot), x2 = f(dot3(v2, ort) / ortDot);
            let x3 = f(dot3(v3, ort) / ortDot), x4 = f(dot3(v4, ort) / ortDot);
            if (x1 > x2) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1]; [v1, v2] = [v2, v1]; }
            if (x3 > x4) { [x3, x4] = [x4, x3]; [y3, y4] = [y4, y3]; [v3, v4] = [v4, v3]; }
            if (x2 <= x3 || x4 <= x1) continue;
            let dist1: number, dist2: number, p11: Vec3, p12: Vec3, p21: Vec3, p22: Vec3;
            if (x1 - 0.5 < x3 && x4 < x2 + 0.5 && x3 - 0.5 < x1 && x2 < x4 + 0.5) {
              dist1 = f(y3 - y1); dist2 = f(y4 - y2); p11 = v1; p21 = v2; p12 = v3; p22 = v4;
            } else {
              if (x1 > x3 - 0.1 && x1 < x3 + 0.1) { dist1 = f(y3 - y1); p11 = v1; p12 = v3; }
              else if (x1 < x3) {
                const y = f(y1 + f(f(f(x3 - x1) * f(y2 - y1)) / f(x2 - x1)));
                dist1 = f(y3 - y); p11 = z(v3, y); p12 = v3;
              } else {
                const y = f(y3 + f(f(f(x1 - x3) * f(y4 - y3)) / f(x4 - x3)));
                dist1 = f(y - y1); p11 = v1; p12 = z(v1, y);
              }
              if (x2 > x4 - 0.1 && x2 < x4 + 0.1) { dist2 = f(y4 - y2); p21 = v2; p22 = v4; }
              else if (x2 < x4) {
                const y = f(y3 + f(f(f(x2 - x3) * f(y4 - y3)) / f(x4 - x3)));
                dist2 = f(y - y2); p21 = v2; p22 = z(v2, y);
              } else {
                const y = f(y1 + f(f(f(x4 - x1) * f(y2 - y1)) / f(x2 - x1)));
                dist2 = f(y4 - y); p21 = z(v4, y); p22 = v4;
              }
            }
            let start: Vec3, end: Vec3;
            if (dist1 > f(dist2 - 1) && dist1 < f(dist2 + 1)) {
              dist = dist1; start = scale3(add3(p11, p21), 0.5); end = scale3(add3(p12, p22), 0.5);
            } else if (dist1 < dist2) { dist = dist1; start = p11; end = p12; }
            else { dist = dist2; start = p21; end = p22; }
            const length = length3(sub3(p22, p12)), prior = (face1.flags & 4) !== 0 ? ground : water;
            const bestDist = prior === null ? 99999 : prior.distance, bestLength = prior === null ? 0 : prior.length;
            if (dist < bestDist || (dist < f(bestDist + 1) && length > bestLength)) {
              const candidate: StepCandidate = { distance: dist, length, edge: edgeNumber, start, end, normal };
              if ((face1.flags & 4) !== 0) ground = candidate;
              else water = candidate;
            }
          }
        }
      }
    }
    if (ground !== null && ground.distance >= 0 && ground.distance < settings.maxStep) {
      const reach = this.context.allocate();
      if (reach === null) return false;
      reach.area = to; reach.face = 0; reach.edge = ground.edge;
      reach.start = maDouble(ground.start, 0.1, ground.normal); reach.end = ma(ground.end, 5, ground.normal);
      reach.travelType = TravelType.WALK; reach.travelTime = 0;
      if (!this.crouch(from) && this.crouch(to)) reach.travelTime = f(reach.travelTime + settings.startCrouchTime);
      this.link(from, reach);
      return true;
    }
    if (water !== null) {
      const point = ma(water.end, -2, water.normal), testPoint = z(point, f(point.z - settings.maxWaterJump));
      if (this.swimArea(world.pointArea(testPoint)) && water.distance < f(settings.maxWaterJump + 24)
        && !this.crouch(from) && !this.crouch(to)) {
        const reach = this.context.allocate();
        if (reach === null) return false;
        reach.area = to; reach.face = 0; reach.edge = water.edge; reach.start = water.start;
        reach.end = ma(water.end, 15, water.normal); reach.travelType = TravelType.WATERJUMP; reach.travelTime = settings.waterJumpTime;
        this.link(from, reach);
        return true;
      }
    }
    if (ground !== null && ground.distance > 0 && ground.distance < settings.maxBarrier
      && (water === null || f(ground.distance - water.distance) < 16) && !this.crouch(from) && !this.crouch(to)) {
      const reach = this.context.allocate();
      if (reach === null) return false;
      reach.area = to; reach.face = 0; reach.edge = ground.edge;
      reach.start = maDouble(ground.start, 0.1, ground.normal); reach.end = ma(ground.end, 5, ground.normal);
      reach.travelType = TravelType.BARRIERJUMP; reach.travelTime = settings.barrierJumpTime;
      this.link(from, reach);
      return true;
    }
    if (ground === null || ground.distance >= 0) return false;
    if (ground.distance > -settings.maxStep) {
      const reach = this.context.allocate();
      if (reach === null) return false;
      reach.area = to; reach.face = 0; reach.edge = ground.edge;
      reach.start = maDouble(ground.start, 0.1, ground.normal); reach.end = ma(ground.end, 5, ground.normal);
      reach.travelType = TravelType.WALK; reach.travelTime = 1;
      this.link(from, reach);
      return true;
    }
    if (settings.maxFallHeight !== 0 && !(Math.abs(ground.distance) < settings.maxFallHeight)) return false;
    const groundEnd = ma(ground.end, 2, ground.normal), start = z(groundEnd, ground.start.z), end = z(groundEnd, groundEnd.z + 4);
    const trace = spatial.traceClientBBox(start, end, 2, -1);
    if (trace.startSolid || !(trace.fraction >= 1) || world.pointArea(z(trace.end, trace.end.z + 1)) !== to) return false;
    for (const crossing of spatial.traceAreas(start, end, 10)) if ((aasAt(world.areaSettings, crossing.area).contents & 8) !== 0) return false;
    const reach = this.context.allocate();
    if (reach === null) return false;
    reach.area = to; reach.face = 0; reach.edge = ground.edge; reach.start = ground.start; reach.end = groundEnd;
    reach.travelType = TravelType.WALKOFFLEDGE;
    reach.travelTime = settings.startWalkOffLedgeTime + Math.abs(ground.distance) * 50 / settings.gravity;
    if (!this.swimArea(to) && (aasAt(world.areaSettings, to).contents & 128) === 0) {
      if (aasFallDelta(settings, ground.distance) > settings.fallDelta5) reach.travelTime = f(reach.travelTime + settings.fallDamage5Time);
      if (aasFallDelta(settings, ground.distance) > settings.fallDelta10) reach.travelTime = f(reach.travelTime + settings.fallDamage10Time);
    }
    this.link(from, reach);
    return true;
  }

  jump(from: number, to: number): boolean {
    const { world, spatial, settings } = this.context;
    if (!this.grounded(from) || !this.grounded(to) || this.crouch(from) || this.crouch(to)) return false;
    const area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to);
    const maximumDistance = f(2 * aasMaxJumpDistance(settings, settings.jumpVelocity));
    for (const axis of AXES) {
      if (axis === "z") continue;
      if (area1.bounds.min[axis] > f(area2.bounds.max[axis] + maximumDistance)
        || area1.bounds.max[axis] < f(area2.bounds.min[axis] - maximumDistance)) return false;
    }
    if (area2.bounds.min.z > f(area1.bounds.max.z + aasMaxJumpHeight(settings, settings.jumpVelocity))) return false;
    let bestDistance = 999999;
    const state: AasClosestEdgeState = { range: null };
    for (let i = 0; i < area1.faceCount; i++) {
      const face1 = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area1.firstFace + i)));
      if ((face1.flags & 4) === 0) continue;
      for (let j = 0; j < area2.faceCount; j++) {
        const face2 = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area2.firstFace + j)));
        if ((face2.flags & 4) === 0) continue;
        for (let k = 0; k < face1.edgeCount; k++) {
          const edge1 = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, face1.firstEdge + k)));
          for (let l = 0; l < face2.edgeCount; l++) {
            const edge2 = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, face2.firstEdge + l)));
            bestDistance = aasClosestEdgePoints(aasAt(world.vertices, edge1.vertices[0]), aasAt(world.vertices, edge1.vertices[1]),
              aasAt(world.vertices, edge2.vertices[0]), aasAt(world.vertices, edge2.vertices[1]),
              aasAt(world.planes, face1.plane), aasAt(world.planes, face2.plane), state, bestDistance);
          }
        }
      }
    }
    // The source calculates unused midpoints before this gate, even when optimized AAS has no ground edges.
    if (!(bestDistance > 4 && bestDistance < maximumDistance)) return false;
    const range = state.range;
    if (range === null) throw new Error("AAS_Reachability_Jump reads uninitialized closest edge points");
    const bestStart = scale3(add3(range.start1, range.start2), 0.5), bestEnd = scale3(add3(range.end1, range.end2), 0.5);
    let speed: number, travelType: number;
    if (bestDistance <= 48 && Math.abs(f(bestStart.z - bestEnd.z)) < 8) {
      speed = 400; travelType = TravelType.WALKOFFLEDGE;
    } else {
      const fallVelocity = spatial.movement.horizontalVelocityForJump(0, bestStart, bestEnd);
      if (fallVelocity.success) { speed = f(fallVelocity.velocity * f(1.2)); travelType = TravelType.WALKOFFLEDGE; }
      else {
        const jumpVelocity = spatial.movement.horizontalVelocityForJump(settings.jumpVelocity, bestStart, bestEnd);
        if (!jumpVelocity.success) return false;
        speed = f(jumpVelocity.velocity * f(1.05)); travelType = TravelType.JUMP;
        if (length3(z(sub3(bestEnd, bestStart), 0)) < 10) return false;
      }
    }
    let direction = normalize3(sub3(bestEnd, bestStart));
    for (const testStart of [ma(bestStart, 1, direction), ma(bestEnd, -1, direction)]) {
      const trace = spatial.traceClientBBox(testStart, z(testStart, testStart.z - 100), 2, -1);
      if (trace.startSolid) return false;
      if (trace.fraction < 1 && dot3(aasAt(world.planes, trace.plane).normal, UP) >= 0.7
        && (spatial.host.pointContents(trace.end) & 24) === 0 && f(testStart.z - trace.end.z) <= settings.maxBarrier) return false;
    }
    const command = vec3(0, 0, (travelType & TravelType.MASK) === TravelType.JUMP ? settings.jumpVelocity : 0);
    direction = normalize3(z(sub3(bestEnd, bestStart), 0));
    const sideways = cross3(direction, UP);
    let stopEvents = AasStopEvent.HIT_GROUND | AasStopEvent.ENTER_WATER | AasStopEvent.ENTER_SLIME
      | AasStopEvent.ENTER_LAVA | AasStopEvent.HIT_GROUND_DAMAGE;
    if ((aasAt(world.areaSettings, from).contents & 8) === 0 && (aasAt(world.areaSettings, to).contents & 8) === 0) {
      stopEvents |= AasStopEvent.TOUCH_CLUSTER_PORTAL;
    }
    let testEnd = bestEnd, found = false;
    for (let i = 0; i < 3; i++) {
      if (i === 1) testEnd = add3(testEnd, sideways);
      else if (i === 2) testEnd = sub3(bestEnd, sideways);
      else testEnd = bestEnd;
      direction = normalize3(z(sub3(testEnd, bestStart), 0));
      const move = spatial.movement.predictClientMovement({ entityNum: -1, origin: bestStart, presence: 2, onGround: true,
        velocity: scale3(direction, speed), commandMove: command, commandFrames: 3, maxFrames: 30, frameTime: f(0.1),
        stopEvents, stopArea: 0, visualize: false }).move;
      if (move.frames >= 30 || (move.stopEvent & (AasStopEvent.ENTER_SLIME | AasStopEvent.ENTER_LAVA | AasStopEvent.TOUCH_CLUSTER_PORTAL)) !== 0) return false;
      const testStart = ma(move.end, -64, direction);
      found = spatial.traceAreas(move.end, z(testStart, testStart.z + 1), 10).some(crossing => crossing.area === to);
      if (found) break;
    }
    if (!found) return false;
    const reach = this.context.allocate();
    if (reach === null) return false;
    reach.area = to; reach.face = 0; reach.edge = 0; reach.start = bestStart; reach.end = bestEnd; reach.travelType = travelType;
    const delta = sub3(bestEnd, bestStart), height = delta.z;
    if ((travelType & TravelType.MASK) === TravelType.WALKOFFLEDGE && height > length3(z(delta, 0))) {
      reach.travelTime = f(settings.startWalkOffLedgeTime + f(f(height * 50) / settings.gravity));
    } else reach.travelTime = f(settings.startJumpTime + f(f(length3(sub3(bestStart, bestEnd)) * 240) / settings.maxWalkVelocity));
    if ((aasAt(world.areaSettings, to).contents & 128) === 0) {
      if (aasFallDelta(settings, f(bestStart.z - bestEnd.z)) > settings.fallDelta5) reach.travelTime = f(reach.travelTime + settings.fallDamage5Time);
      else if (aasFallDelta(settings, f(bestStart.z - bestEnd.z)) > settings.fallDelta10) reach.travelTime = f(reach.travelTime + settings.fallDamage10Time);
    }
    this.link(from, reach);
    // The source returns false even after publishing a jump reachability.
    return false;
  }

  ladder(from: number, to: number): boolean {
    const { world, settings, spatial } = this.context;
    if (!this.ladderArea(from) || !this.ladderArea(to)) return false;
    const maximumHeight = aasMaxJumpHeight(settings, settings.jumpVelocity), area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to);
    let best: { readonly face1: AasFace; readonly face2: AasFace; readonly number1: number; readonly number2: number;
      readonly area1: number; readonly area2: number; readonly edge: number } | null = null;
    for (let i = 0; i < area1.faceCount; i++) {
      const number1 = aasAt(world.faceIndexes, area1.firstFace + i), face1 = aasAt(world.faces, Math.abs(number1));
      if ((face1.flags & 2) === 0) continue;
      for (let j = 0; j < area2.faceCount; j++) {
        const number2 = aasAt(world.faceIndexes, area2.firstFace + j), face2 = aasAt(world.faces, Math.abs(number2));
        if ((face2.flags & 2) === 0) continue;
        let shared = false;
        for (let k = 0; k < face1.edgeCount; k++) {
          const edge1 = aasAt(world.edgeIndexes, face1.firstEdge + k);
          for (let l = 0; l < face2.edgeCount; l++) {
            if (Math.abs(edge1) !== Math.abs(aasAt(world.edgeIndexes, face2.firstEdge + l))) continue;
            const surface1 = aasFaceArea(world, face1), surface2 = aasFaceArea(world, face2);
            if (surface1 > (best === null ? -9999 : best.area1) && surface2 > (best === null ? -9999 : best.area2)) {
              best = { face1, face2, number1, number2, area1: surface1, area2: surface2, edge: edge1 };
            }
            shared = true; break;
          }
          if (shared) break;
        }
      }
    }
    if (best === null) return false;
    const edge = aasAt(world.edges, Math.abs(best.edge));
    const v1 = aasAt(world.vertices, edge.vertices[best.edge < 0 ? 1 : 0]), v2 = aasAt(world.vertices, edge.vertices[best.edge < 0 ? 0 : 1]);
    const midpoint = scale3(add3(v1, v2), 0.5), sharedEdge = sub3(v2, v1);
    let plane1 = aasAt(world.planes, best.face1.plane ^ (best.number1 < 0 ? 1 : 0));
    const plane2 = aasAt(world.planes, best.face2.plane ^ (best.number2 < 0 ? 1 : 0));
    const direction = normalize3(cross3(plane1.normal, sharedEdge)), point1 = ma(midpoint, -32, direction), point2 = ma(midpoint, 32, direction);
    const vertical1 = integerAbs(dot3(plane1.normal, UP)) < 0.1, vertical2 = integerAbs(dot3(plane2.normal, UP)) < 0.1;
    if (!vertical1 && !vertical2) return false;
    if (vertical1 && vertical2 && dot3(plane1.normal, plane2.normal) > 0.7 && integerAbs(dot3(sharedEdge, UP)) < 0.7) {
      const first = this.context.allocate();
      if (first === null) return false;
      first.area = to; first.face = best.number1; first.edge = Math.abs(best.edge); first.start = point1;
      first.end = ma(point2, -3, plane1.normal); first.travelType = TravelType.LADDER; first.travelTime = 10;
      this.link(from, first);
      const second = this.context.allocate();
      if (second === null) return false;
      second.area = from; second.face = best.number2; second.edge = Math.abs(best.edge); second.start = point2;
      second.end = ma(point1, -3, plane1.normal); second.travelType = TravelType.LADDER; second.travelTime = 10;
      this.link(to, second);
      return true;
    }
    if (vertical1 && (best.face2.flags & 4) !== 0) {
      const first = this.context.allocate();
      if (first === null) return false;
      first.area = to; first.face = best.number1; first.edge = Math.abs(best.edge); first.start = point1;
      first.end = ma(z(point2, point2.z + 16), -15, plane1.normal); first.travelType = TravelType.LADDER; first.travelTime = 10;
      this.link(from, first);
      const second = this.context.allocate();
      if (second === null) return false;
      second.area = from; second.face = best.number2; second.edge = Math.abs(best.edge); second.start = point2;
      second.end = point1; second.travelType = TravelType.WALKOFFLEDGE; second.travelTime = 10;
      this.link(to, second);
      return true;
    }
    if (!vertical1) return false;
    let lowest: { readonly point: Vec3; readonly edge: number } | null = null;
    for (let i = 0; i < best.face1.edgeCount; i++) {
      const edgeNumber = Math.abs(aasAt(world.edgeIndexes, best.face1.firstEdge + i)), current = aasAt(world.edges, edgeNumber);
      const point = scale3(add3(aasAt(world.vertices, current.vertices[0]), aasAt(world.vertices, current.vertices[1])), 0.5);
      if (point.z < (lowest === null ? 99999 : lowest.point.z)) lowest = { point, edge: edgeNumber };
    }
    plane1 = aasAt(world.planes, best.face1.plane);
    if (lowest === null) throw new Error("AAS_Reachability_Ladder reads an uninitialized lowest point");
    const offset = ma(lowest.point, 5, plane1.normal), start = z(offset, offset.z + 5), end = z(offset, offset.z - 100);
    const trace = spatial.traceClientBBox(start, end, 2, -1), traceEnd = z(trace.end, trace.end.z + 1), destination = world.pointArea(traceEnd);
    const destinationArea = aasAt(world.areas, destination);
    for (let i = 0; i < destinationArea.faceCount; i++) {
      const face = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, destinationArea.firstFace + i)));
      if ((face.flags & 2) !== 0 && integerAbs(dot3(aasAt(world.planes, face.plane).normal, UP)) < 0.1) return false;
    }
    if (destination === from || this.context.exists(from, destination) || this.context.exists(destination, from)
      || !(f(start.z - traceEnd.z) < maximumHeight)) return false;
    const first = this.context.allocate();
    if (first === null) return false;
    first.area = destination; first.face = best.number1; first.edge = lowest.edge; first.start = lowest.point;
    first.end = traceEnd; first.travelType = TravelType.LADDER; first.travelTime = 10;
    this.link(from, first);
    const second = this.context.allocate();
    if (second === null) return false;
    second.area = from; second.face = best.number1; second.edge = lowest.edge; second.start = traceEnd;
    const finish = ma(lowest.point, -5, plane1.normal);
    second.end = z(finish, finish.z + 10); second.travelType = TravelType.JUMP; second.travelTime = 10;
    this.link(destination, second);
    return true;
  }

  walkOffLedge(areaNumber: number): void {
    const { world, settings, spatial } = this.context;
    if (!this.grounded(areaNumber) || this.swimArea(areaNumber)) return;
    const area = aasAt(world.areas, areaNumber);
    for (let i = 0; i < area.faceCount; i++) {
      const face1 = aasAt(world.faces, Math.abs(aasAt(world.faceIndexes, area.firstFace + i)));
      if ((face1.flags & 4) === 0) continue;
      for (let k = 0; k < face1.edgeCount; k++) {
        const edgeNumber = aasAt(world.edgeIndexes, face1.firstEdge + k);
        for (let j = 0; j < area.faceCount; j++) {
          const number2 = aasAt(world.faceIndexes, area.firstFace + j), face2 = aasAt(world.faces, Math.abs(number2));
          if ((face2.flags & 4) !== 0) continue;
          for (let l = 0; l < face2.edgeCount; l++) {
            if (Math.abs(edgeNumber) !== Math.abs(aasAt(world.edgeIndexes, face2.firstEdge + l))) continue;
            const other = face2.frontArea === areaNumber ? face2.backArea : face2.frontArea, otherArea = aasAt(world.areas, other);
            if (this.grounded(other)) {
              let gap = false, shared = false;
              for (let n = 0; n < otherArea.faceCount; n++) {
                const number3 = aasAt(world.faceIndexes, otherArea.firstFace + n);
                if (Math.abs(number3) === Math.abs(number2)) continue;
                const face3 = aasAt(world.faces, Math.abs(number3));
                for (let m = 0; m < face3.edgeCount; m++) {
                  if (Math.abs(aasAt(world.edgeIndexes, face3.firstEdge + m)) !== Math.abs(edgeNumber)) continue;
                  gap = (face3.flags & 1) === 0 || (face3.flags & 4) === 0;
                  shared = true; break;
                }
                if (shared) break;
              }
              if (!gap) break;
            }
            const edge = aasAt(world.edges, Math.abs(edgeNumber));
            const v1 = aasAt(world.vertices, edge.vertices[edgeNumber < 0 ? 1 : 0]), v2 = aasAt(world.vertices, edge.vertices[edgeNumber < 0 ? 0 : 1]);
            const direction = normalize3(cross3(aasAt(world.planes, face1.plane).normal, sub3(v2, v1)));
            const midpoint = ma(scale3(add3(v1, v2), 0.5), 8, direction), testEnd = z(midpoint, midpoint.z - 1000);
            const trace = spatial.traceClientBBox(midpoint, testEnd, 4, -1);
            if (trace.startSolid) break;
            const destination = world.pointArea(trace.end);
            if (destination === areaNumber || this.context.exists(areaNumber, destination)
              || (!this.grounded(destination) && !this.swimArea(destination)) || (aasAt(world.areaSettings, destination).contents & 6) !== 0) break;
            if (spatial.traceAreas(midpoint, testEnd, 10).some(crossing => (aasAt(world.areaSettings, crossing.area).contents & 8) !== 0)) break;
            const distance = f(midpoint.z - trace.end.z);
            if (settings.maxFallHeight !== 0 && Math.abs(distance) > settings.maxFallHeight) break;
            const reach = this.context.allocate();
            if (reach === null) break;
            reach.area = destination; reach.face = 0; reach.edge = edgeNumber; reach.start = midpoint; reach.end = trace.end;
            reach.travelType = TravelType.WALKOFFLEDGE;
            reach.travelTime = settings.startWalkOffLedgeTime + Math.abs(distance) * 50 / settings.gravity;
            if (!this.swimArea(destination) && (aasAt(world.areaSettings, destination).contents & 128) === 0) {
              if (aasFallDelta(settings, distance) > settings.fallDelta5) reach.travelTime = f(reach.travelTime + settings.fallDamage5Time);
              else if (aasFallDelta(settings, distance) > settings.fallDelta10) reach.travelTime = f(reach.travelTime + settings.fallDamage10Time);
            }
            this.link(areaNumber, reach);
          }
        }
      }
    }
  }
}
