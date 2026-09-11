// Port of id Software's botlib/be_ai_move.c route selection and movement view queries.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { dot3, length3, normalize3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { AasReachability } from "./aas.ts";
import type { BotGoal } from "./goals.ts";
import { BotAvoidSpotType, BotMoveResultFlag } from "./movement-state.ts";
import type { BotAvoidSpot, BotMoveState, BotMoveStateStore } from "./movement-state.ts";
import { AasRouting, areaContentsTravelFlags, travelFlagForType, TravelFlags, TravelType } from "./routing.ts";
import { AasSpatial } from "./spatial.ts";

const f = Math.fround;
const TRACE_MASK = 1 | 0x10000;
const ZERO_REACHABILITY: AasReachability = { area: 0, face: 0, edge: 0, start: vec3(0, 0, 0), end: vec3(0, 0, 0), travelType: 0, travelTime: 0, padding: 0 };
const axes: readonly (keyof Vec3)[] = ["x", "y", "z"];
const discontinuousTravel: readonly number[] = [TravelType.WALKOFFLEDGE, TravelType.JUMP, TravelType.TELEPORT, TravelType.ELEVATOR,
  TravelType.GRAPPLEHOOK, TravelType.ROCKETJUMP, TravelType.BFGJUMP, TravelType.JUMPPAD, TravelType.FUNCBOB];
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new RangeError(`Bot movement index ${index} outside ${values.length} entries`); return value;
}
function ma(start: Vec3, distance: number, direction: Vec3): Vec3 {
  return vec3(start.x + f(distance * direction.x), start.y + f(distance * direction.y), start.z + f(distance * direction.z));
}
export function movementAngleDifference(first: number, second: number): number {
  first = f(first); second = f(second); let difference = f(first - second);
  if (first > second) { if (difference > 180) difference = f(difference - 360); }
  else if (difference < -180) difference = f(difference + 360);
  return difference;
}
export function movementDistanceSquared(first: Vec3, second: Vec3): number { const direction = sub3(second, first); return dot3(direction, direction); }
export function distanceFromLineSquared(point: Vec3, start: Vec3, end: Vec3): number {
  // AAS_ProjectPointOntoVector, followed by the source's first-outside-axis endpoint choice.
  const direction = normalize3(sub3(end, start)), projection = ma(start, dot3(sub3(point, start), direction), direction);
  for (const axis of axes) {
    if ((projection[axis] > start[axis] && projection[axis] > end[axis]) || (projection[axis] < start[axis] && projection[axis] < end[axis])) {
      return movementDistanceSquared(point, Math.abs(f(projection[axis] - start[axis])) < Math.abs(f(projection[axis] - end[axis])) ? start : end);
    }
  }
  return movementDistanceSquared(point, projection);
}

export function avoidMovementSpots(origin: Vec3, reach: AasReachability, spots: readonly BotAvoidSpot[], count: number): number {
  const type = reach.travelType & TravelType.MASK;
  const checkBetween = !discontinuousTravel.includes(type);
  let result: number = BotAvoidSpotType.CLEAR;
  for (let index = 0; index < count; index++) {
    const spot = at(spots, index), squaredRadius = f(spot.radius * spot.radius);
    let squaredDistance = distanceFromLineSquared(spot.origin, origin, reach.start);
    if (squaredDistance < squaredRadius && movementDistanceSquared(spot.origin, origin) > squaredDistance) result = spot.type;
    else if (checkBetween) {
      squaredDistance = distanceFromLineSquared(spot.origin, reach.start, reach.end);
      if (squaredDistance < squaredRadius && movementDistanceSquared(spot.origin, reach.start) > squaredDistance) result = spot.type;
    } else {
      // Source discards this result; the following comparison still uses origin→start distance.
      movementDistanceSquared(spot.origin, reach.end);
      if (squaredDistance < squaredRadius && movementDistanceSquared(spot.origin, reach.start) > squaredDistance) result = spot.type;
    }
    if (result === BotAvoidSpotType.ALWAYS) return result;
  }
  return result;
}

export interface MovementTarget { value: Vec3 }
export interface MovementTargetProgress extends MovementTarget { distance: number }
export function addToMovementTarget(start: Vec3, end: Vec3, maximum: number, progress: MovementTargetProgress): boolean {
  return writeMovementTarget(start, end, maximum, progress, value => {
    progress.value = vec3(value.x, value.y, value.z); return undefined;
  });
}
function writeMovementTarget(
  start: Vec3, end: Vec3, maximum: number, progress: Pick<MovementTargetProgress, "distance">,
  writeTarget: (value: Vec3) => undefined,
): boolean {
  const direction = sub3(end, start), distance = length3(direction), normalized = normalize3(direction);
  maximum = f(maximum);
  if (f(progress.distance + distance) < maximum) { writeTarget(end); progress.distance = f(progress.distance + distance); return false; }
  writeTarget(ma(start, f(maximum - progress.distance), normalized)); progress.distance = maximum; return true;
}
export type AvoidReachState = Pick<BotMoveState, "avoidReach" | "avoidReachTimes" | "avoidReachTries">;
export interface MovementReachabilityQuery {
  readonly origin: Vec3;
  readonly area: number;
  readonly lastGoalArea: number;
  readonly lastArea: number;
  readonly avoid: AvoidReachState;
  readonly goal: BotGoal;
  readonly travelFlags: number;
  readonly moveTravelFlags: number;
  readonly avoidSpots: readonly BotAvoidSpot[];
  readonly numAvoidSpots: number;
  readonly flags: number;
}
export interface BotMovementRoutingHost {
  originOfMoverWithModelNum(model: number): Vec3 | null;
  entityModelNum(entity: number): number;
}
export interface BotMovementRoutingDebug {
  readonly debug: boolean;
  developer(): boolean;
}

export class BotMovementRouting {
  constructor(readonly states: BotMoveStateStore, readonly spatial: AasSpatial, readonly routing: AasRouting, readonly host: BotMovementRoutingHost,
    private readonly diagnostics?: BotMovementRoutingDebug) {}
  /** AAS_ReachabilityFromNum copies slot zero and clears out-of-range results. */
  reachabilityFromNum(number: number): AasReachability {
    const stored = this.spatial.world.reachability[number], reach = stored === undefined ? ZERO_REACHABILITY : stored;
    return { area: reach.area, face: reach.face, edge: reach.edge,
      start: vec3(reach.start.x, reach.start.y, reach.start.z), end: vec3(reach.end.x, reach.end.y, reach.end.z),
      travelType: reach.travelType, travelTime: reach.travelTime, padding: reach.padding };
  }
  /** The source returns firstReachableArea on the first call even when count is0. */
  nextAreaReachability(area: number, previous: number): number {
    const settings = this.spatial.world.areaSettings;
    if (area <= 0 || area >= settings.length) {
      this.states.host.print(3, `AAS_NextAreaReachability: areanum ${area} out of range\n`); return 0;
    }
    const record = at(settings, area);
    if (previous === 0) return record.firstReachableArea;
    if (previous < record.firstReachableArea) {
      this.states.host.print(4, "AAS_NextAreaReachability: reachnum < settings->firstreachableara"); return 0;
    }
    const next = (previous + 1) | 0;
    return next >= record.firstReachableArea + record.reachableAreaCount ? 0 : next;
  }
  validTravel(_origin: Vec3, reach: AasReachability, travelFlags: number): boolean {
    if (travelFlagForType(reach.travelType) & ~travelFlags) return false;
    return (areaContentsTravelFlags(at(this.spatial.world.areaSettings, reach.area)) & ~travelFlags) === 0;
  }
  getReachabilityToGoal(query: MovementReachabilityQuery): { readonly reachability: number; readonly flags: number } {
    let flags = query.flags;
    if (query.area === 0) return { reachability: 0, flags };
    const world = this.spatial.world, settings = at(world.areaSettings, query.area);
    let travelFlags = query.travelFlags, moveFlags = query.moveTravelFlags;
    if ((settings.contents | at(world.areaSettings, query.goal.area).contents) & 256) { travelFlags |= TravelFlags.DONOTENTER; moveFlags |= TravelFlags.DONOTENTER; }
    let bestTime = 0, bestReachability = 0;
    for (let number = this.nextAreaReachability(query.area, 0); number !== 0; number = this.nextAreaReachability(query.area, number)) {
      if (query.avoid.avoidReach[0] === number && query.avoid.avoidReachTimes[0] >= f(this.states.host.time()) && query.avoid.avoidReachTries[0] > 4) {
        if (this.diagnostics?.debug && this.diagnostics.developer()) this.states.host.print(1, `avoiding reachability ${query.avoid.avoidReach[0]}\n`);
        continue;
      }
      const reach = this.reachabilityFromNum(number);
      if (query.lastGoalArea === query.goal.area && reach.area === query.lastArea) continue;
      if (!this.validTravel(query.origin, reach, moveFlags)) continue;
      const route = this.routing.route({ area: reach.area, origin: reach.end, goalArea: query.goal.area, travelFlags });
      if (route.kind === "unreachable" || route.travelTime === 0) continue;
      if (avoidMovementSpots(query.origin, reach, query.avoidSpots, query.numAvoidSpots)) { flags |= BotMoveResultFlag.BLOCKEDBYAVOIDSPOT; continue; }
      const time = (route.travelTime + reach.travelTime) | 0;
      if (bestTime === 0 || time < bestTime) { bestTime = time; bestReachability = number; }
    }
    return { reachability: bestReachability, flags };
  }
  movementViewTarget(handle: number, goal: BotGoal | null, travelFlags: number, lookahead: number, target: MovementTarget): boolean {
    return BotMovementRouting.writeMovementViewTarget(handle, goal, travelFlags, lookahead, value => {
      target.value = vec3(value.x, value.y, value.z); return undefined;
    }, this.states, () => this);
  }
  static movementViewTarget(
    handle: number, goal: BotGoal | null, travelFlags: number, lookahead: number, target: MovementTarget,
    states: BotMoveStateStore, currentRouting: () => BotMovementRouting,
  ): boolean {
    return BotMovementRouting.writeMovementViewTarget(handle, goal, travelFlags, lookahead, value => {
      target.value = value; return undefined;
    }, states, currentRouting);
  }
  private static writeMovementViewTarget(
    handle: number, goal: BotGoal | null, travelFlags: number, lookahead: number,
    writeTarget: (value: Vec3) => undefined, states: BotMoveStateStore, currentRouting: () => BotMovementRouting,
  ): boolean {
    const state = states.fromHandle(handle); if (state === null) return false;
    if (!state.lastReachability || goal === null) return false;
    let reachability = state.lastReachability, end = vec3(state.origin.x, state.origin.y, state.origin.z), lastArea = state.lastArea;
    const progress = { distance: 0 };
    lookahead = f(lookahead);
    while (reachability && progress.distance < lookahead) {
      const routing = currentRouting(), reach = routing.reachabilityFromNum(reachability), type = reach.travelType & TravelType.MASK;
      const finishedStart = writeMovementTarget(end, reach.start, lookahead, progress, writeTarget);
      if (finishedStart || type === TravelType.TELEPORT || type === TravelType.ROCKETJUMP || type === TravelType.BFGJUMP) return true;
      if (type !== TravelType.JUMPPAD && type !== TravelType.ELEVATOR && type !== TravelType.FUNCBOB) {
        const finishedEnd = writeMovementTarget(reach.start, reach.end, lookahead, progress, writeTarget);
        if (finishedEnd) return true;
      }
      reachability = routing.getReachabilityToGoal({ origin: reach.end, area: reach.area, lastGoalArea: state.lastGoalArea, lastArea,
        avoid: state, goal, travelFlags, moveTravelFlags: travelFlags, avoidSpots: [], numAvoidSpots: 0, flags: 0 }).reachability;
      end = reach.end; lastArea = reach.area;
      if (lastArea === goal.area) { writeMovementTarget(reach.end, goal.origin, lookahead, progress, writeTarget); return true; }
    }
    return false;
  }
  visible(entity: number, eye: Vec3, target: Vec3): boolean { return this.spatial.host.trace(eye, target, null, entity, TRACE_MASK).fraction >= 1; }
  predictVisiblePosition(origin: Vec3, area: number, goal: BotGoal | null, travelFlags: number, target: MovementTarget): boolean {
    return BotMovementRouting.predictVisiblePosition(origin, area, goal, travelFlags, target, () => this);
  }
  static predictVisiblePosition(
    origin: Vec3, area: number, goal: BotGoal | null, travelFlags: number, target: MovementTarget,
    currentRouting: () => BotMovementRouting,
  ): boolean {
    if (goal === null || area === 0 || goal.area === 0) return false;
    const avoid: AvoidReachState = { avoidReach: [0], avoidReachTimes: [0], avoidReachTries: [0] };
    const lastGoalArea = goal.area; let lastArea = area, end = vec3(origin.x, origin.y, origin.z);
    for (let index = 0; index < 20 && area !== goal.area; index++) {
      const routing = currentRouting();
      const number = routing.getReachabilityToGoal({ origin: end, area, lastGoalArea, lastArea, avoid, goal, travelFlags,
        moveTravelFlags: travelFlags, avoidSpots: [], numAvoidSpots: 0, flags: 0 }).reachability;
      if (!number) return false;
      const reach = routing.reachabilityFromNum(number);
      if (routing.visible(goal.entity, goal.origin, reach.start)) { target.value = vec3(reach.start.x, reach.start.y, reach.start.z); return true; }
      if (routing.visible(goal.entity, goal.origin, reach.end) || reach.area === goal.area) { target.value = vec3(reach.end.x, reach.end.y, reach.end.z); return true; }
      lastArea = area; area = reach.area; end = reach.end;
    }
    return false;
  }
  onMover(origin: Vec3, entity: number, reach: AasReachability): boolean {
    const model = reach.face & 0xffff, bounds = this.spatial.host.modelBounds(model, vec3(0, 0, 0)).bounds;
    const modelOrigin = this.host.originOfMoverWithModelNum(model);
    if (modelOrigin === null) { this.states.host.print(1, `no entity with model ${model}\n`); return false; }
    for (const axis of ["x", "y"] satisfies readonly (keyof Vec3)[]) {
      if (origin[axis] > f(f(modelOrigin[axis] + bounds.max[axis]) + 16) || origin[axis] < f(f(modelOrigin[axis] + bounds.min[axis]) - 16)) return false;
    }
    const trace = this.spatial.host.trace(vec3(origin.x, origin.y, origin.z + 24), vec3(origin.x, origin.y, origin.z - 48),
      { min: vec3(-16, -16, -8), max: vec3(16, 16, 8) }, entity, TRACE_MASK);
    return trace.solidity === "clear" && trace.entityNum !== 1023 && this.host.entityModelNum(trace.entityNum) === model;
  }
  moverDown(reach: AasReachability): boolean {
    const model = reach.face & 0xffff, bounds = this.spatial.host.modelBounds(model, vec3(0, 0, 0)).bounds;
    const origin = this.host.originOfMoverWithModelNum(model);
    if (origin === null) { this.states.host.print(1, `no entity with model ${model}\n`); return false; }
    return f(origin.z + bounds.max.z) < reach.start.z;
  }
  onTopOfEntity(state: BotMoveState): number {
    const bounds = this.spatial.presenceBounds(state.presenceType);
    const trace = this.spatial.host.trace(state.origin, vec3(state.origin.x, state.origin.y, state.origin.z - 3), bounds, state.entityNum, TRACE_MASK);
    return trace.solidity === "clear" && trace.entityNum !== 1022 && trace.entityNum !== 1023 ? trace.entityNum : -1;
  }
}
