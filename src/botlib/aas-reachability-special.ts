/*
 * Entity, grapple and weapon-jump reachability from id Software's
 * code/botlib/be_aas_reach.c, AAS_TravelFlagsForTeam through
 * AAS_Reachability_WeaponJump.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Bounds, Vec3 } from "../core/math.ts";
import { add3, angleVectors, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { float32ToBits } from "../core/numeric.ts";
import type { AasPlane } from "./aas.ts";
import type { AasClientMove } from "./aas-movement.ts";
import { AasStopEvent } from "./aas-movement.ts";
import type { AasLinkedReachability, AasReachabilityContext } from "./aas-reachability.ts";
import type { AasClosestEdgeState } from "./aas-reachability-geometry.ts";
import { aasAt, aasClosestEdgePoints, aasFaceCenter, aasFallDamageDistance, aasMaxJumpDistance } from "./aas-reachability-geometry.ts";
import { TravelType } from "./routing.ts";

const f = Math.fround;
const ZERO = vec3(0, 0, 0), UP = vec3(0, 0, 1), DOWN = vec3(0, 0, -1);
const AXES: readonly (keyof Vec3)[] = ["x", "y", "z"];
const MAX_EPAIRKEY = 128, FACE_SOLID = 1, FACE_GROUND = 4, AREA_WEAPONJUMP = 8192;
const LAND_EVENTS = AasStopEvent.HIT_GROUND | AasStopEvent.ENTER_WATER | AasStopEvent.ENTER_SLIME
  | AasStopEvent.ENTER_LAVA | AasStopEvent.HIT_GROUND_DAMAGE | AasStopEvent.TOUCH_JUMP_PAD | AasStopEvent.TOUCH_TELEPORTER;
const HAZARD_EVENTS = AasStopEvent.ENTER_SLIME | AasStopEvent.ENTER_LAVA | AasStopEvent.HIT_GROUND_DAMAGE;
const WEAPON_JUMP_ITEMS = new Set([
  "item_armor_body", "item_armor_combat", "item_health_mega", "weapon_grenadelauncher", "weapon_rocketlauncher",
  "weapon_lightning", "weapon_plasmagun", "weapon_railgun", "weapon_bfg", "item_quad", "item_regen", "item_invulnerability",
]);

function z(point: Vec3, height: number): Vec3 { return vec3(point.x, point.y, height); }
function ma(point: Vec3, scale: number, direction: Vec3): Vec3 { return add3(point, scale3(direction, scale)); }
function middle(a: Vec3, b: Vec3): Vec3 { return scale3(add3(a, b), 0.5); }
function epairText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) { if (byte === 0) break; text += String.fromCharCode(byte); }
  return text;
}
function sourceInt(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError("AAS special reachability float-to-int conversion is undefined");
  }
  return integer + 0;
}
// C printf promotes these stored float coordinates to double and rounds ties to even.
function fixed(value: number, digits: 0 | 1 | 6): string {
  const bits = float32ToBits(value), negative = (bits >>> 31) !== 0, exponent = (bits >>> 23) & 255;
  if (exponent === 255) return Number.isNaN(value) ? "nan" : negative ? "-inf" : "inf";
  const mantissa = BigInt((bits & 0x7fffff) | (exponent === 0 ? 0 : 0x800000));
  const shift = exponent === 0 ? -149 : exponent - 150;
  let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift);
  else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator;
  const remainder = (numerator % denominator) * 2n;
  if (remainder > denominator || (remainder === denominator && (rounded & 1n) !== 0n)) rounded++;
  const text = rounded.toString().padStart(digits + 1, "0"), sign = negative ? "-" : "";
  return digits === 0 ? sign + text : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}
function perimeter(min: Vec3, mid: Vec3, max: Vec3): readonly Vec3[] {
  return [vec3(min.x, mid.y, 0), vec3(mid.x, max.y, 0), vec3(max.x, mid.y, 0), vec3(mid.x, min.y, 0),
    vec3(min.x, max.y, 0), vec3(max.x, max.y, 0), vec3(max.x, min.y, 0), vec3(min.x, min.y, 0)];
}

export class AasReachabilitySpecial {
  constructor(private readonly context: AasReachabilityContext) {}

  private grounded(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).flags & 1) !== 0; }
  private swimArea(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).flags & 4) !== 0; }
  private teleportArea(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).contents & 64) !== 0; }
  private jumpPadArea(area: number): boolean { return (aasAt(this.context.world.areaSettings, area).contents & 128) !== 0; }
  private link(area: number, reach: AasLinkedReachability): void {
    reach.next = aasAt(this.context.heads, area);
    this.context.heads[area] = reach;
  }

  travelFlagsForTeam(entity: number): number {
    const notTeam = this.context.bspEntities.int(entity, "bot_notteam");
    if (!notTeam.found) return 0;
    return notTeam.value === 1 ? TravelType.NOTTEAM1 : notTeam.value === 2 ? TravelType.NOTTEAM2 : 0;
  }

  teleport(): void {
    const { bspEntities, spatial, world, settings, print } = this.context;
    const classnameBuffer = new Uint8Array(MAX_EPAIRKEY), modelBuffer = new Uint8Array(MAX_EPAIRKEY);
    const targetBuffer = new Uint8Array(MAX_EPAIRKEY), targetNameBuffer = new Uint8Array(MAX_EPAIRKEY);
    let modelBufferInitialized = false;
    for (let entity = bspEntities.nextEntity(0); entity !== 0; entity = bspEntities.nextEntity(entity)) {
      if (!bspEntities.value(entity, "classname", classnameBuffer)) continue;
      const classname = epairText(classnameBuffer);
      if (classname !== "trigger_multiple" && classname !== "trigger_teleport") continue;
      if (bspEntities.value(entity, "model", modelBuffer)) modelBufferInitialized = true;
      print(1, `${classname} model = "${epairText(modelBuffer)}"\n`);
      if (!modelBufferInitialized) throw new RangeError("AAS_Reachability_Teleport would read an uninitialized model suffix");
      const model = spatial.host.modelBounds(nativeAtoi(epairText(modelBuffer.subarray(1))), ZERO);
      if (!bspEntities.value(entity, "target", targetBuffer)) {
        print(3, `${classname} at ${fixed(model.origin.x, 0)} ${fixed(model.origin.y, 0)} ${fixed(model.origin.z, 0)} without target\n`);
        continue;
      }
      if (classname === "trigger_multiple") {
        let relay = bspEntities.nextEntity(0);
        for (; relay !== 0; relay = bspEntities.nextEntity(relay)) {
          if (!bspEntities.value(relay, "classname", classnameBuffer) || epairText(classnameBuffer) !== "target_teleporter") continue;
          if (bspEntities.value(relay, "targetname", targetNameBuffer) && epairText(targetNameBuffer) === epairText(targetBuffer)) break;
        }
        if (relay === 0) continue;
        if (!bspEntities.value(relay, "target", targetBuffer)) { print(3, "target_teleporter without target\n"); continue; }
      }
      const target = epairText(targetBuffer);
      let destination = bspEntities.nextEntity(0);
      for (; destination !== 0; destination = bspEntities.nextEntity(destination)) {
        if (bspEntities.value(destination, "targetname", targetNameBuffer) && epairText(targetNameBuffer) === target) break;
      }
      if (destination === 0) { print(3, `teleporter without misc_teleporter_dest (${target})\n`); continue; }
      const parsedOrigin = bspEntities.vector(destination, "origin");
      if (!parsedOrigin.found) { print(3, `teleporter destination (${target}) without origin\n`); continue; }
      let destinationOrigin = parsedOrigin.value, destinationArea = world.pointArea(destinationOrigin);
      if (!this.teleportArea(destinationArea) && !this.jumpPadArea(destinationArea)) {
        const trace = spatial.traceClientBBox(destinationOrigin, z(destinationOrigin, destinationOrigin.z - 64), 4, -1);
        if (trace.startSolid) { print(3, `teleporter destination (${target}) in solid\n`); continue; }
        destinationArea = world.pointArea(trace.end);
        const angle = bspEntities.float(destination, "angle").value;
        const velocity = angle !== 0 ? scale3(angleVectors(vec3(0, angle, 0)).forward, 400) : ZERO;
        const move = spatial.movement.predictClientMovement({ entityNum: -1, origin: destinationOrigin, presence: 2, onGround: false,
          velocity, commandMove: ZERO, commandFrames: 0, maxFrames: 30, frameTime: f(0.1), stopEvents: LAND_EVENTS,
          stopArea: 0, visualize: false }).move;
        destinationArea = world.pointArea(move.end);
        if ((move.stopEvent & (AasStopEvent.ENTER_SLIME | AasStopEvent.ENTER_LAVA)) !== 0) print(2, `teleported into slime or lava at dest ${target}\n`);
        destinationOrigin = move.end;
      }
      const bounds = { min: add3(model.origin, model.bounds.min), max: add3(model.origin, model.bounds.max) };
      const midpoint = middle(bounds.min, bounds.max), areas = spatial.linkClientBounds(-1, bounds, 4);
      if (areas === null) print(1, "trigger_multiple not in any area\n");
      for (let link = areas; link !== null; link = link.nextArea) {
        if (!this.teleportArea(link.area)) continue;
        const reach = this.context.allocate();
        if (reach === null) break;
        reach.area = destinationArea; reach.face = 0; reach.edge = 0;
        reach.start = midpoint; reach.end = destinationOrigin;
        reach.travelType = TravelType.TELEPORT;
        reach.travelType |= this.travelFlagsForTeam(entity);
        reach.travelTime = settings.teleportTime;
        this.link(link.area, reach);
      }
      spatial.unlinkFromAreas(areas);
    }
  }

  elevator(): void {
    const { bspEntities, spatial, world, settings, print } = this.context;
    const classnameBuffer = new Uint8Array(MAX_EPAIRKEY), modelBuffer = new Uint8Array(MAX_EPAIRKEY);
    for (let entity = bspEntities.nextEntity(0); entity !== 0; entity = bspEntities.nextEntity(entity)) {
      if (!bspEntities.value(entity, "classname", classnameBuffer) || epairText(classnameBuffer) !== "func_plat") continue;
      if (!bspEntities.value(entity, "model", modelBuffer)) { print(3, "func_plat without model\n"); continue; }
      const modelNumber = nativeAtoi(epairText(modelBuffer).slice(1));
      if (modelNumber <= 0) { print(3, "func_plat with invalid model number\n"); continue; }
      const model = spatial.host.modelBounds(modelNumber, ZERO), origin = bspEntities.vector(entity, "origin").value;
      let min = model.bounds.min, max = model.bounds.max;
      let lip = bspEntities.float(entity, "lip").value;
      if (lip === 0) lip = 8;
      let height = bspEntities.float(entity, "height").value;
      if (height === 0) height = f(f(max.z - min.z) - lip);
      let speed = bspEntities.float(entity, "speed").value;
      if (speed === 0) speed = 200;
      const pos2 = z(origin, origin.z - height);
      const sum = add3(min, max), center = vec3(pos2.x + 0.5 * sum.x, pos2.y + 0.5 * sum.y, pos2.z + 0.5 * sum.z);
      const platformBottom = z(center, f(max.z - f(origin.z - pos2.z)) + 2), platformTop = z(center, max.z + 2);
      min = sub3(min, vec3(1, 1, 1)); max = add3(max, vec3(1, 1, 1));
      const mid = middle(min, max), bottomSides = perimeter(min, mid, max);
      for (let i = 0; i < 9; i++) {
        let bottomOrigin: Vec3, area1: number;
        if (i < 8) {
          const offset = aasAt(bottomSides, i);
          bottomOrigin = vec3(origin.x + offset.x, origin.y + offset.y, platformBottom.z + 16);
          area1 = world.pointArea(bottomOrigin);
          let k = 0;
          for (; k < 16; k++) {
            if (area1 !== 0 && (this.grounded(area1) || this.swimArea(area1))) break;
            bottomOrigin = z(bottomOrigin, bottomOrigin.z + 4);
            area1 = world.pointArea(bottomOrigin);
          }
          if (k >= 16) continue;
        } else {
          bottomOrigin = z(platformTop, platformTop.z + 24);
          area1 = world.pointArea(bottomOrigin);
          if (area1 === 0) continue;
          bottomOrigin = z(platformBottom, platformBottom.z + 24);
        }
        for (let n = 0; n < 3; n++) {
          min = sub3(min, vec3(4, 4, 4)); max = add3(max, vec3(4, 4, 4));
          const topSides = perimeter(min, mid, max);
          for (let j = 0; j < 8; j++) {
            const offset = aasAt(topSides, j);
            let topOrigin = vec3(origin.x + offset.x, origin.y + offset.y, platformTop.z + 16);
            let area2 = world.pointArea(topOrigin), l = 0;
            for (; l < 16; l++) {
              if (area2 !== 0 && (this.grounded(area2) || this.swimArea(area2))) {
                const trace = spatial.traceClientBBox(z(platformTop, platformTop.z + 32), z(topOrigin, topOrigin.z + 1), 4, -1);
                if (trace.fraction >= 1) break;
              }
              topOrigin = z(topOrigin, topOrigin.z + 4);
              area2 = world.pointArea(topOrigin);
            }
            if (l >= 16 || area2 === area1 || !this.grounded(area2) || this.context.exists(area1, area2)) continue;
            const outward = normalize3(sub3(bottomOrigin, platformBottom));
            const start = vec3(bottomOrigin.x + f(24 * outward.x), bottomOrigin.y + f(24 * outward.y), bottomOrigin.z);
            if (!AXES.some(axis => start[axis] < f(origin[axis] + min[axis]) || start[axis] > f(origin[axis] + max[axis]))) continue;
            const reach = this.context.allocate();
            if (reach === null) continue;
            reach.area = area2; reach.face = modelNumber; reach.edge = sourceInt(height);
            reach.start = start; reach.end = topOrigin; reach.travelType = TravelType.ELEVATOR;
            reach.travelType |= this.travelFlagsForTeam(entity);
            reach.travelTime = f(settings.startElevatorTime + f(f(height * 100) / speed));
            this.link(area1, reach);
            n = 9999;
          }
        }
      }
    }
  }

  private findFaceReachabilities(points: readonly Vec3[], plane: AasPlane, towardsFace: boolean): AasLinkedReachability | null {
    const { world, spatial, settings } = this.context;
    let links: AasLinkedReachability | null = null;
    let bestFace = 0, bestPlane: AasPlane | null = null;
    const state: AasClosestEdgeState = { range: null };
    for (let areaNumber = 1; areaNumber < world.areas.length; areaNumber++) {
      const area = aasAt(world.areas, areaNumber);
      let bestDistance = 999999;
      for (let j = 0; j < area.faceCount; j++) {
        const faceNumber = aasAt(world.faceIndexes, area.firstFace + j), face = aasAt(world.faces, Math.abs(faceNumber));
        if ((face.flags & FACE_GROUND) === 0) continue;
        const facePlane = aasAt(world.planes, face.plane);
        for (let k = 0; k < face.edgeCount; k++) {
          const edge = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, face.firstEdge + k)));
          const v1 = aasAt(world.vertices, edge.vertices[0]), v2 = aasAt(world.vertices, edge.vertices[1]);
          for (let l = 0; l < points.length; l++) {
            const distance = aasClosestEdgePoints(v1, v2, aasAt(points, l), aasAt(points, (l + 1) % points.length),
              facePlane, plane, state, bestDistance);
            if (distance < bestDistance) { bestFace = faceNumber; bestPlane = facePlane; bestDistance = distance; }
          }
        }
      }
      if (bestDistance > 192) continue;
      if (state.range === null || bestPlane === null) throw new RangeError("AAS_FindFaceReachabilities would read uninitialized closest-edge points");
      let start = middle(state.range.start1, state.range.start2), end = middle(state.range.end1, state.range.end2);
      if (!towardsFace) [start, end] = [end, start];
      state.range = { start1: start, end1: end, start2: state.range.start2, end2: state.range.end2 };
      const horizontalDistance = length3(z(sub3(end, start), 0));
      if (horizontalDistance > f(2 * aasMaxJumpDistance(settings, settings.jumpVelocity))) continue;
      if (f(end.z - 32) > start.z || end.z < f(start.z - 128)) continue;
      if (horizontalDistance > 32 && !spatial.movement.horizontalVelocityForJump(0, start, end).success) continue;
      start = z(start, start.z + 1); end = z(end, end.z + 1);
      state.range = { start1: start, end1: end, start2: state.range.start2, end2: state.range.end2 };
      const test = z(towardsFace ? end : start, 0);
      const testPoint = z(test, f(bestPlane.distance - dot3(bestPlane.normal, test)) / bestPlane.normal.z);
      if (!spatial.pointInsideFace(bestFace, testPoint, f(0.1)) && f(end.z - 16) > start.z) continue;
      const reach = this.context.allocate();
      if (reach === null) return links;
      reach.area = areaNumber; reach.face = 0; reach.edge = 0; reach.start = start; reach.end = end;
      reach.travelType = 0; reach.travelTime = 0; reach.next = links; links = reach;
      this.context.permanentLine(reach.start, reach.end, towardsFace ? 1 : 2);
    }
    return links;
  }

  funcBobbing(): void {
    const { bspEntities, spatial, world, settings, print } = this.context;
    const classnameBuffer = new Uint8Array(MAX_EPAIRKEY), modelBuffer = new Uint8Array(MAX_EPAIRKEY);
    for (let entity = bspEntities.nextEntity(0); entity !== 0; entity = bspEntities.nextEntity(entity)) {
      if (!bspEntities.value(entity, "classname", classnameBuffer) || epairText(classnameBuffer) !== "func_bobbing") continue;
      let height = bspEntities.float(entity, "height").value;
      if (height === 0) height = 32;
      if (!bspEntities.value(entity, "model", modelBuffer)) { print(3, "func_bobbing without model\n"); continue; }
      const modelNumber = nativeAtoi(epairText(modelBuffer).slice(1));
      if (modelNumber <= 0) { print(3, "func_bobbing with invalid model number\n"); continue; }
      const origin = bspEntities.vector(entity, "origin").value, model = spatial.host.modelBounds(modelNumber, ZERO);
      const min = add3(model.bounds.min, origin), max = add3(model.bounds.max, origin), mid = middle(min, max);
      const spawnFlags = bspEntities.int(entity, "spawnflags").value;
      const axis = (spawnFlags & 1) !== 0 ? "x" : (spawnFlags & 2) !== 0 ? "y" : "z";
      const moveStart = { ...mid, [axis]: f(mid[axis] - height) }, moveEnd = { ...mid, [axis]: f(mid[axis] + height) };
      this.context.log(`funcbob model ${modelNumber}, start = {${fixed(moveStart.x, 1)}, ${fixed(moveStart.y, 1)}, ${fixed(moveStart.z, 1)}} end = {${fixed(moveEnd.x, 1)}, ${fixed(moveEnd.y, 1)}, ${fixed(moveEnd.z, 1)}}\n`);
      const makeFace = (point: Vec3): readonly [Vec3, Vec3, Vec3, Vec3] => {
        const top = f(f(point.z + f(max.z - mid.z)) + 24);
        return [vec3(point.x + f(max.x - mid.x), point.y + f(max.y - mid.y), top),
          vec3(point.x + f(max.x - mid.x), point.y + f(min.y - mid.y), top),
          vec3(point.x + f(min.x - mid.x), point.y + f(min.y - mid.y), top),
          vec3(point.x + f(min.x - mid.x), point.y + f(max.y - mid.y), top)];
      };
      const startPoints = makeFace(moveStart), endPoints = makeFace(moveEnd);
      const startPlane: AasPlane = { normal: UP, distance: startPoints[0].z, type: 2 };
      const endPlane: AasPlane = { normal: UP, distance: endPoints[0].z, type: 2 };
      const topOffset = f(f(max.z - mid.z) + 24), startTop = z(moveStart, moveStart.z + topOffset), endTop = z(moveEnd, moveEnd.z + topOffset);
      if (world.pointArea(startTop) === 0 || world.pointArea(endTop) === 0) continue;
      for (let direction = 0; direction < 2; direction++) {
        const starts = this.findFaceReachabilities(direction === 0 ? startPoints : endPoints, direction === 0 ? startPlane : endPlane, true);
        const ends = this.findFaceReachabilities(direction === 0 ? endPoints : startPoints, direction === 0 ? endPlane : startPlane, false);
        let nextStart: AasLinkedReachability | null = null, nextEnd: AasLinkedReachability | null = null;
        for (let startReach = starts; startReach !== null; startReach = nextStart) {
          nextStart = startReach.next;
          for (let endReach = ends; endReach !== null; endReach = nextEnd) {
            nextEnd = endReach.next;
            this.context.log(`funcbob reach from area ${startReach.area} to ${endReach.area}\n`);
            const outward = normalize3(z(sub3(startReach.start, direction === 0 ? startTop : endTop), 0));
            let start = ma(startReach.start, 1, outward), end = ma(startReach.start, 16, outward);
            start = z(start, start.z + 1); end = z(end, end.z + 1);
            const crossings = spatial.traceAreas(start, end, 10);
            if (crossings.length === 0) continue;
            startReach.start = crossings.length > 1 ? aasAt(crossings, 1).point : end;
            if (world.pointArea(startReach.start) === 0 || world.pointArea(endReach.end) === 0) continue;
            const reach = this.context.allocate();
            if (reach === null) throw new RangeError("AAS_Reachability_FuncBobbing would dereference a failed reachability allocation");
            reach.area = endReach.area;
            reach.edge = direction === 0 ? (sourceInt(moveStart[axis]) << 16) | (sourceInt(moveEnd[axis]) & 0xffff)
              : (sourceInt(moveEnd[axis]) << 16) | (sourceInt(moveStart[axis]) & 0xffff);
            reach.face = (spawnFlags << 16) | modelNumber; reach.start = startReach.start; reach.end = endReach.end;
            reach.travelType = TravelType.FUNCBOB; reach.travelType |= this.travelFlagsForTeam(entity);
            reach.travelTime = settings.funcBobTime; this.link(startReach.area, reach);
          }
        }
        for (let link = starts; link !== null;) { const next = link.next; this.context.free(link); link = next; }
        for (let link = ends; link !== null;) { const next = link.next; this.context.free(link); link = next; }
        if ((spawnFlags & 3) === 0) break;
      }
    }
  }

  jumpPad(): void {
    const { bspEntities, spatial, world, settings, print, variables } = this.context;
    const visualizeJumpPads = sourceInt(variables.value("bot_visualizejumppads", "0")) !== 0;
    const classnameBuffer = new Uint8Array(MAX_EPAIRKEY);
    for (let entity = bspEntities.nextEntity(0); entity !== 0; entity = bspEntities.nextEntity(entity)) {
      if (!bspEntities.value(entity, "classname", classnameBuffer) || epairText(classnameBuffer) !== "trigger_push") continue;
      const pad = spatial.getJumpPadInfo(entity);
      if (pad === null) continue;
      let start = pad.start, velocity = pad.velocity;
      const areas = spatial.linkClientBounds(-1, pad.bounds, 4);
      let padLink = areas;
      while (padLink !== null && !this.jumpPadArea(padLink.area)) padLink = padLink.nextArea;
      if (padLink === null) {
        print(1, "trigger_push not in any jump pad area\n");
        spatial.unlinkFromAreas(areas);
        continue;
      }
      print(1, `found a trigger_push with velocity ${fixed(velocity.x, 6)} ${fixed(velocity.y, 6)} ${fixed(velocity.z, 6)}\n`);
      if (velocity.x !== 0 || velocity.y !== 0) {
        let move: AasClientMove | null = null, destinationArea = 0, frame = 0;
        for (; frame < 20; frame++) {
          move = spatial.movement.predictClientMovement({ entityNum: -1, origin: start, presence: 2, onGround: false,
            velocity, commandMove: ZERO, commandFrames: 0, maxFrames: 30, frameTime: f(0.1), stopEvents: LAND_EVENTS,
            stopArea: 0, visualize: visualizeJumpPads }).move;
          destinationArea = move.endArea;
          let sourceLink = areas;
          for (; sourceLink !== null; sourceLink = sourceLink.nextArea) {
            if (this.jumpPadArea(sourceLink.area) && sourceLink.area === destinationArea) break;
          }
          if (sourceLink === null) break;
          start = move.end; velocity = move.velocity;
        }
        if (destinationArea !== 0 && frame < 20) {
          if (move === null) throw new Error("Jump-pad movement has no prediction output");
          for (let link = areas; link !== null; link = link.nextArea) {
            if (!this.jumpPadArea(link.area) || this.context.exists(link.area, destinationArea)) continue;
            const reach = this.context.allocate();
            if (reach === null) { spatial.unlinkFromAreas(areas); return; }
            reach.area = destinationArea; reach.face = sourceInt(velocity.z);
            reach.edge = sourceInt(Math.sqrt(f(f(velocity.x * velocity.x) + f(velocity.y * velocity.y))));
            reach.start = start; reach.end = move.end; reach.travelType = TravelType.JUMPPAD;
            reach.travelType |= this.travelFlagsForTeam(entity); reach.travelTime = settings.jumpPadTime;
            this.link(link.area, reach);
          }
        }
      }
      // This source continue retains the actual temporary area links.
      if (Math.abs(velocity.x) > 100 || Math.abs(velocity.y) > 100) continue;
      for (let destinationArea = 1; destinationArea < world.areas.length; destinationArea++) {
        let sourceLink = areas;
        for (; sourceLink !== null; sourceLink = sourceLink.nextArea) {
          if (this.context.exists(sourceLink.area, destinationArea)
            || (this.jumpPadArea(sourceLink.area) && sourceLink.area === destinationArea)) break;
        }
        if (sourceLink !== null) continue;
        const area = aasAt(world.areas, destinationArea);
        for (let i = 0; i < area.faceCount; i++) {
          const faceNumber = aasAt(world.faceIndexes, area.firstFace + i), face = aasAt(world.faces, Math.abs(faceNumber));
          if ((face.flags & FACE_GROUND) === 0) continue;
          const faceCenter = aasFaceCenter(world, faceNumber);
          if (faceCenter.z < start.z) continue;
          const jump = spatial.movement.horizontalVelocityForJump(velocity.z, start, faceCenter);
          if (!(jump.success && jump.velocity < 150)) continue;
          const direction = normalize3(z(sub3(faceCenter, start), 0)), command = scale3(direction, jump.velocity);
          const move = spatial.movement.predictClientMovement({ entityNum: -1, origin: start, presence: 2, onGround: false,
            velocity, commandMove: command, commandFrames: 30, maxFrames: 30, frameTime: f(0.1),
            stopEvents: (LAND_EVENTS & ~AasStopEvent.HIT_GROUND) | AasStopEvent.HIT_GROUND_AREA,
            stopArea: destinationArea, visualize: false }).move;
          if (move.frames >= 30 || (move.stopEvent & HAZARD_EVENTS) !== 0
            || (move.stopEvent & (AasStopEvent.HIT_GROUND_AREA | AasStopEvent.TOUCH_JUMP_PAD | AasStopEvent.TOUCH_TELEPORTER)) === 0) continue;
          let returnLink = areas;
          while (returnLink !== null && returnLink.area !== move.endArea) returnLink = returnLink.nextArea;
          if (returnLink !== null) continue;
          for (let link = areas; link !== null; link = link.nextArea) {
            if (!this.jumpPadArea(link.area) || this.context.exists(link.area, destinationArea)) continue;
            const reach = this.context.allocate();
            if (reach === null) { spatial.unlinkFromAreas(areas); return; }
            reach.area = move.endArea; reach.face = sourceInt(velocity.z);
            reach.edge = sourceInt(Math.sqrt(f(f(command.x * command.x) + f(command.y * command.y))));
            reach.start = start; reach.end = faceCenter; reach.travelType = TravelType.JUMPPAD;
            reach.travelType |= this.travelFlagsForTeam(entity); reach.travelTime = settings.airControlledJumpPadTime;
            this.link(link.area, reach);
          }
        }
      }
      spatial.unlinkFromAreas(areas);
    }
  }

  grapple(from: number, to: number): boolean {
    const { world, spatial, settings } = this.context;
    if ((!this.grounded(from) && !this.swimArea(from)) || (aasAt(world.areaSettings, from).presenceType & 2) === 0) return false;
    if (this.swimArea(from)) return false;
    const area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to);
    if (area2.bounds.max.z < area1.bounds.min.z) return false;
    if (world.pointArea(area1.center) === 0) this.context.log(`area ${from} center ${fixed(area1.center.x, 6)} ${fixed(area1.center.y, 6)} ${fixed(area1.center.z, 6)} in solid?\r\n`);
    const floor = spatial.traceClientBBox(area1.center, z(area1.center, area1.center.z - 1000), 4, -1);
    if (floor.startSolid) return false;
    const areaStart = floor.end;
    for (let i = 0; i < area2.faceCount; i++) {
      const faceNumber = aasAt(world.faceIndexes, area2.firstFace + i), face = aasAt(world.faces, Math.abs(faceNumber));
      if ((face.flags & FACE_SOLID) === 0) continue;
      const edge = aasAt(world.edges, Math.abs(aasAt(world.edgeIndexes, face.firstEdge)));
      const vertex = aasAt(world.vertices, edge.vertices[0]), plane = aasAt(world.planes, face.plane);
      if (dot3(plane.normal, sub3(vertex, areaStart)) > 0) continue;
      const faceCenter = aasFaceCenter(world, faceNumber);
      if (faceCenter.z < f(areaStart.z + 64) || dot3(plane.normal, DOWN) < 0) continue;
      const delta = sub3(faceCenter, areaStart), horizontalDistance = length3(z(delta, 0));
      if (horizontalDistance === 0 || horizontalDistance > 2000 || f(delta.z / horizontalDistance) < Math.tan(2 * Math.PI * 15 / 360)) continue;
      const bspTrace = spatial.host.trace(faceCenter, ma(faceCenter, -500, plane.normal), null, 0, 1);
      if ((bspTrace.surfaceFlags & 4) !== 0 || f(bspTrace.fraction * 500) > 32) continue;
      const start = ma(areaStart, 4, normalize3(sub3(faceCenter, areaStart)));
      const approach = spatial.traceClientBBox(start, bspTrace.end, 2, -1);
      if (length3(sub3(approach.end, faceCenter)) > 24) continue;
      const landing = spatial.traceClientBBox(approach.end, z(approach.end, approach.end.z - aasFallDamageDistance(settings)), 2, -1);
      if (landing.fraction >= 1) continue;
      const destinationArea = world.pointArea(landing.end);
      if ((aasAt(world.areaSettings, destinationArea).contents & (2 | 4)) !== 0 || destinationArea === from
        || this.context.exists(from, destinationArea) || !this.grounded(destinationArea)) continue;
      const crossings = spatial.traceAreas(areaStart, bspTrace.end, 20);
      if (crossings.length >= 20 || crossings.some(crossing => (aasAt(world.areaSettings, crossing.area).contents & 8) !== 0)) continue;
      const reach = this.context.allocate();
      if (reach === null) return false;
      reach.area = destinationArea; reach.face = faceNumber; reach.edge = 0; reach.start = areaStart; reach.end = bspTrace.end;
      reach.travelType = TravelType.GRAPPLEHOOK; reach.travelTime = settings.startGrappleTime + length3(sub3(reach.end, reach.start)) * 0.25;
      this.link(from, reach);
    }
    return false;
  }

  setWeaponJumpAreaFlags(): void {
    const { world, spatial, bspEntities, print } = this.context;
    const bounds: Bounds = { min: vec3(-15, -15, -15), max: vec3(15, 15, 15) };
    const classnameBuffer = new Uint8Array(MAX_EPAIRKEY);
    let count = 0;
    for (let entity = bspEntities.nextEntity(0); entity !== 0; entity = bspEntities.nextEntity(entity)) {
      if (!bspEntities.value(entity, "classname", classnameBuffer)) continue;
      const classname = epairText(classnameBuffer);
      if (!WEAPON_JUMP_ITEMS.has(classname)) continue;
      const parsed = bspEntities.vector(entity, "origin");
      if (!parsed.found) continue;
      let origin = parsed.value;
      if ((bspEntities.int(entity, "spawnflags").value & 1) === 0) {
        const dropped = spatial.dropToFloor(origin, bounds);
        origin = dropped.origin;
        if (!dropped.success) print(1, `${classname} in solid at (${fixed(origin.x, 1)} ${fixed(origin.y, 1)} ${fixed(origin.z, 1)})\n`);
      }
      const area = spatial.bestReachableArea(origin, bounds).area;
      world.areaSettingsRecord(area).flags |= AREA_WEAPONJUMP;
      count++;
    }
    for (let area = 1; area < world.areas.length; area++) {
      if (!this.jumpPadArea(area)) continue;
      world.areaSettingsRecord(area).flags |= AREA_WEAPONJUMP;
      count++;
    }
    print(1, `${count} weapon jump areas\n`);
  }

  weaponJump(from: number, to: number): boolean {
    const { world, spatial, settings } = this.context;
    if (!this.grounded(from) || this.swimArea(from) || !this.grounded(to)
      || (aasAt(world.areaSettings, to).flags & AREA_WEAPONJUMP) === 0) return false;
    const area1 = aasAt(world.areas, from), area2 = aasAt(world.areas, to);
    if (area2.bounds.max.z < area1.bounds.min.z) return false;
    if (world.pointArea(area1.center) === 0) this.context.log(`area ${from} center ${fixed(area1.center.x, 6)} ${fixed(area1.center.y, 6)} ${fixed(area1.center.z, 6)} in solid?\r\n`);
    const floor = spatial.traceClientBBox(area1.center, z(area1.center, area1.center.z - 1000), 4, -1);
    if (floor.startSolid) return false;
    const start = floor.end;
    for (let i = 0; i < area2.faceCount; i++) {
      const faceNumber = aasAt(world.faceIndexes, area2.firstFace + i), face = aasAt(world.faces, Math.abs(faceNumber));
      if ((face.flags & FACE_GROUND) === 0) continue;
      const faceCenter = aasFaceCenter(world, faceNumber);
      if (faceCenter.z < f(start.z + 64)) continue;
      // The compiled source loop permits only n == 0, the rocket-jump branch.
      const velocity = spatial.movement.rocketJumpZVelocity(start), jump = spatial.movement.horizontalVelocityForJump(velocity, start, faceCenter);
      if (!(jump.success && jump.velocity < 300)) continue;
      const command = scale3(normalize3(z(sub3(faceCenter, start), 0)), jump.velocity);
      const move = spatial.movement.predictClientMovement({ entityNum: -1, origin: start, presence: 2, onGround: true,
        velocity: vec3(0, 0, velocity), commandMove: command, commandFrames: 30, maxFrames: 30, frameTime: f(0.1),
        stopEvents: (LAND_EVENTS & ~AasStopEvent.TOUCH_TELEPORTER) | AasStopEvent.HIT_GROUND_AREA,
        stopArea: to, visualize: false }).move;
      if (move.frames >= 30 || (move.stopEvent & HAZARD_EVENTS) !== 0
        || (move.stopEvent & (AasStopEvent.HIT_GROUND_AREA | AasStopEvent.TOUCH_JUMP_PAD)) === 0) continue;
      const reach = this.context.allocate();
      if (reach === null) return false;
      reach.area = to; reach.face = 0; reach.edge = 0; reach.start = start; reach.end = faceCenter;
      reach.travelType = TravelType.ROCKETJUMP; reach.travelTime = settings.rocketJumpTime;
      this.link(from, reach);
      return true;
    }
    return false;
  }
}
