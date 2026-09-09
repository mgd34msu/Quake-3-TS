// Port of id Software's botlib/be_aas_route.c auxiliary routing queries.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { float32ToBits } from "../core/numeric.ts";
import type { AasWorld } from "./aas.ts";
import type { BotMemory, BotMemoryAllocation } from "./memory.ts";
import type { AasSpatial, AasGoalPosition } from "./spatial.ts";
import type { RoutingStorage, RoutingUpdate, RoutingUpdateTable } from "./routing-storage.ts";
import { routingAreaTravelTime } from "./routing-storage.ts";
import { TravelType, travelFlagForType } from "./routing.ts";
import type { AasRouting } from "./routing.ts";
import { aasAreaGroundFaceArea } from "./aas-reachability-geometry.ts";

function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new RangeError(`AAS route query index ${index} exceeds source allocation ${rows.length}`);
  return row;
}

function coordinateText(value: number): string {
  const bits = float32ToBits(value), exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff;
  const sign = bits >>> 31 === 0 ? "" : "-";
  if (exponent === 255) return `${sign}${fraction === 0 ? "inf" : "nan"}`;
  const significand = BigInt(exponent === 0 ? fraction : fraction + 0x800000);
  const shift = exponent === 0 ? -149 : exponent - 150, scaled = significand * 1000000n;
  let rounded: bigint;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), lower = scaled / divisor, remainder = scaled % divisor;
    rounded = remainder * 2n > divisor || remainder * 2n === divisor && lower % 2n !== 0n ? lower + 1n : lower;
  }
  return `${sign}${rounded / 1000000n}.${String(rounded % 1000000n).padStart(6, "0")}`;
}

export function aasProjectPointOntoVector(point: Vec3, start: Vec3, end: Vec3): Vec3 {
  const pointVector = sub3(point, start), direction = normalize3(sub3(end, start));
  return add3(start, scale3(direction, dot3(pointVector, direction)));
}

export function aasDistancePointToLine(start: Vec3, end: Vec3, point: Vec3): number {
  return length3(sub3(point, aasProjectPointOntoVector(point, start, end)));
}

/** These source functions intentionally have no visibility or bridge implementation. */
export function aasAreaVisible(_source: number, _destination: number): boolean { return false; }
export function aasBridgeWalkable(_area: number): boolean { return false; }

export function aasNextModelReachability(world: AasWorld, previous: number, model: number): number {
  let first: number;
  if (previous <= 0) first = 1;
  else if (previous >= world.reachability.length) return 0;
  else first = (previous + 1) | 0;
  for (let index = first; index < world.reachability.length; index++) {
    const reach = at(world.reachability, index), type = reach.travelType & TravelType.MASK;
    if (type === TravelType.ELEVATOR && reach.face === model) return index;
    if (type === TravelType.FUNCBOB && (reach.face & 0xffff) === model) return index;
  }
  return 0;
}

export function aasRandomGoalArea(spatial: AasSpatial, routing: AasRouting, area: number, travelFlags: number,
  random: () => number, log: (message: string) => void): AasGoalPosition | null {
  const world = spatial.world;
  if (at(world.areaSettings, area).reachableAreaCount === 0) return null;
  let candidate = Math.trunc(Math.fround(world.areas.length * Math.fround(random())));
  for (let index = 0; index < world.areas.length; index++, candidate++) {
    if (candidate <= 0 || candidate >= world.areas.length) candidate = 1;
    const settings = at(world.areaSettings, candidate);
    if (settings.reachableAreaCount === 0) continue;
    const time = routing.areaTravelTimeToGoal({ area, origin: at(world.areas, area).center, goalArea: candidate, travelFlags });
    if (time <= 0) continue;
    const center = at(world.areas, candidate).center;
    if ((settings.flags & 4) !== 0) return { area: candidate, origin: vec3(center.x, center.y, center.z) };
    if (spatial.pointArea(center) === 0) log(`area ${candidate} center ${coordinateText(center.x)} ${coordinateText(center.y)} ${coordinateText(center.z)} in solid?`);
    const trace = spatial.traceClientBBox(center, vec3(center.x, center.y, center.z - 300), 4, -1);
    if (!trace.startSolid && trace.fraction < 1 && spatial.pointArea(trace.end) === candidate
      && aasAreaGroundFaceArea(world, candidate) > 300) return { area: candidate, origin: trace.end };
  }
  return null;
}

function updateStart(table: RoutingUpdateTable, update: RoutingUpdate): Vec3 {
  const view = table.view, offset = update.offset + 8;
  return vec3(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
}

function setUpdateStart(table: RoutingUpdateTable, update: RoutingUpdate, point: Vec3): void {
  const view = table.view, offset = update.offset + 8;
  view.setFloat32(offset, point.x, true); view.setFloat32(offset + 4, point.y, true); view.setFloat32(offset + 8, point.z, true);
}

/** Source static hide times survive routing teardown and retain their first allocation size. */
export class AasHideRouting {
  private hideTimes: BotMemoryAllocation | null = null;

  constructor(private readonly memory: BotMemory) {}

  nearestHideArea(world: AasWorld, storage: RoutingStorage, origin: Vec3, area: number,
    enemyOrigin: Vec3, enemyArea: number, travelFlags: number): number {
    const size = world.areas.length * 2;
    if (this.hideTimes === null) this.hideTimes = this.memory.allocate(size, "heap", true);
    else {
      if (size > this.hideTimes.bytes.length) throw new RangeError("AAS_NearestHideArea exceeds its retained source hide-times allocation");
      this.hideTimes.bytes.fill(0, 0, size);
    }
    const bytes = this.hideTimes.bytes, times = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const updates = storage.areaUpdates, current = updates.at(area);
    current.area = area;
    setUpdateStart(updates, current, origin);
    current.areaTimesPointer = storage.areaTimePointer(area, 0);
    current.time = 0;
    current.next = null; current.prev = null;
    let head: RoutingUpdate | null = current, tail: RoutingUpdate | null = current;
    let bestTime = 0, bestArea = 0;
    while (head !== null) {
      const update: RoutingUpdate = head;
      const next = update.next;
      if (next !== null) next.prev = null;
      else tail = null;
      head = next;
      update.inList = false;
      const settings = at(world.areaSettings, update.area);
      for (let index = 0; index < settings.reachableAreaCount; index++) {
        const reach = at(world.reachability, settings.firstReachableArea + index);
        if ((travelFlagForType(reach.travelType) & ~travelFlags) !== 0 || (storage.contentsFlags(reach.area) & ~travelFlags) !== 0) continue;
        const nextArea = reach.area;
        if (nextArea === enemyArea) continue;
        const start = updateStart(updates, update);
        let time = (update.time + routingAreaTravelTime(at(world.areaSettings, update.area), start, reach.start) + reach.travelTime) & 0xffff;
        const projection = aasProjectPointOntoVector(enemyOrigin, start, reach.end);
        const outside = (["x", "y", "z"] satisfies readonly (keyof Vec3)[]).some(axis =>
          (projection[axis] > start[axis] && projection[axis] > reach.end[axis])
          || (projection[axis] < start[axis] && projection[axis] < reach.end[axis]));
        const distance = length3(sub3(enemyOrigin, outside ? reach.end : projection));
        if (distance < 40) continue;
        const oldDistance = length3(sub3(enemyOrigin, start));
        if (distance < oldDistance) time = Math.trunc(Math.fround(time + Math.fround(Math.fround(oldDistance - distance) * 10))) & 0xffff;
        if (bestTime !== 0 && time >= bestTime) continue;
        const previous = times.getUint16(nextArea * 2, true);
        if (previous !== 0 && previous <= time) continue;
        if (!aasAreaVisible(enemyArea, nextArea)) { bestTime = time; bestArea = nextArea; }
        times.setUint16(nextArea * 2, time, true);
        const destination = updates.at(nextArea);
        destination.area = nextArea;
        destination.time = time;
        setUpdateStart(updates, destination, reach.end);
        if (!destination.inList) {
          destination.next = null; destination.prev = tail;
          if (tail !== null) tail.next = destination;
          else head = destination;
          tail = destination;
          destination.inList = true;
        }
      }
    }
    return bestArea;
  }
}
