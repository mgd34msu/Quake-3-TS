/* Ground and air travel from id Software's botlib/be_ai_move.c, lines 1345-2081
 * and 2910-2965. Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 * Active native botlib branches use float32 stores and double literal promotion. */
import { add3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { AasReachability } from "./aas.ts";
import type { BotTravelContext } from "./movement.ts";
import { BotMoveFlag, BotMoveResult, BotMoveResultFlag } from "./movement-state.ts";
import type { BotMoveState } from "./movement-state.ts";

const f = Math.fround;
function horizontal(from: Vec3, to: Vec3): Vec3 { return vec3(to.x - from.x, to.y - from.y, 0); }
function ma(origin: Vec3, distance: number, direction: Vec3): Vec3 { return add3(origin, scale3(direction, distance)); }
function centeredRandom(context: BotTravelContext): number {
  return 2.0 * (f((context.host.random.nextInt() & 0x7fff) / 0x7fff) - 0.5);
}
function areaPresence(context: BotTravelContext, area: number): number {
  const settings = context.routing.spatial.world.areaSettings;
  const record = settings[area];
  if (area <= 0 || area >= settings.length || record === undefined) {
    context.routing.states.host.print(3, "AAS_AreaPresenceType: invalid area number\n");
    return 0;
  }
  return record.presenceType;
}

export function travelWalk(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  let direction = horizontal(state.origin, reach.start), distance = length3(direction);
  direction = normalize3(direction);
  context.checkBlocked(state, direction, true, result);
  if (distance < 10) {
    direction = horizontal(state.origin, reach.end);
    distance = length3(direction);
    direction = normalize3(direction);
  }
  if ((areaPresence(context, reach.area) & 2) === 0 && distance < 20) context.actions.crouch(state.client);
  const gap = context.gapDistance(state.origin, direction, state.entityNum);
  let speed: number;
  if ((state.moveFlags & BotMoveFlag.WALK) !== 0) {
    speed = gap > 0 ? f(200 - f(180 - f(1 * gap))) : 200;
    context.actions.walk(state.client);
  } else speed = gap > 0 ? f(400 - f(360 - f(2 * gap))) : 400;
  context.actions.move(state.client, direction, speed);
  result.moveDirection = direction;
  return result;
}

export function finishTravelWalk(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), direction = horizontal(state.origin, reach.end);
  const distance = Math.min(length3(direction), 100), normalized = normalize3(direction);
  context.actions.move(state.client, normalized, f(400 - f(400 - f(3 * distance))));
  result.moveDirection = normalized;
  return result;
}

export function travelCrouch(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), direction = normalize3(horizontal(state.origin, reach.end));
  context.checkBlocked(state, direction, true, result);
  context.actions.crouch(state.client);
  context.actions.move(state.client, direction, 400);
  result.moveDirection = direction;
  return result;
}

export function travelBarrierJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), horizontalDirection = horizontal(state.origin, reach.start);
  const distance = length3(horizontalDirection), direction = normalize3(horizontalDirection);
  context.checkBlocked(state, direction, true, result);
  if (distance < 9) context.actions.jump(state.client);
  else context.actions.move(state.client, direction, f(360 - f(360 - f(6 * Math.min(distance, 60)))));
  result.moveDirection = direction;
  return result;
}

export function finishTravelBarrierJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  if (state.velocity.z < 250) {
    const direction = normalize3(horizontal(state.origin, reach.end));
    context.checkBlocked(state, direction, true, result);
    context.actions.move(state.client, direction, 400);
    result.moveDirection = direction;
  }
  return result;
}

export function travelSwim(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), direction = normalize3(sub3(reach.start, state.origin));
  context.checkBlocked(state, direction, true, result);
  context.actions.move(state.client, direction, 400);
  result.moveDirection = direction;
  result.idealViewAngles = context.vectorToAngles(direction);
  result.flags |= BotMoveResultFlag.SWIMVIEW;
  return result;
}

export function travelWaterJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), offset = sub3(reach.end, state.origin);
  const horizontalDistance = length3(vec3(offset.x, offset.y, 0));
  const direction = normalize3(vec3(offset.x, offset.y, offset.z + (15 + centeredRandom(context) * 40)));
  context.actions.moveForward(state.client);
  if (horizontalDistance < 40) context.actions.moveUp(state.client);
  result.idealViewAngles = context.vectorToAngles(direction);
  result.flags |= BotMoveResultFlag.MOVEMENTVIEW;
  result.moveDirection = direction;
  return result;
}

export function finishTravelWaterJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  if ((state.moveFlags & BotMoveFlag.WATERJUMP) !== 0) return result;
  if ((context.routing.spatial.host.pointContents(vec3(state.origin.x, state.origin.y, state.origin.z - 32)) & 56) === 0) return result;
  const offset = sub3(reach.end, state.origin);
  const x = f(offset.x + centeredRandom(context) * 10);
  const y = f(offset.y + centeredRandom(context) * 10);
  const z = f(offset.z + (70 + centeredRandom(context) * 10));
  const direction = normalize3(vec3(x, y, z));
  context.actions.move(state.client, direction, 400);
  result.idealViewAngles = context.vectorToAngles(direction);
  result.flags |= BotMoveResultFlag.MOVEMENTVIEW;
  result.moveDirection = direction;
  return result;
}

export function travelWalkOffLedge(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  context.checkBlocked(state, normalize3(sub3(reach.start, state.origin)), true, result);
  const reachDistance = length3(horizontal(reach.start, reach.end));
  const startDirection = horizontal(state.origin, reach.start), distance = length3(startDirection);
  let direction = normalize3(startDirection), speed: number;
  if (distance < 48) {
    direction = normalize3(horizontal(state.origin, reach.end));
    if (reachDistance < 20) speed = 100;
    else {
      const velocity = context.routing.spatial.movement.horizontalVelocityForJump(0, reach.start, reach.end);
      speed = velocity.success ? velocity.velocity : 400;
    }
  } else speed = reachDistance < 20 ? f(400 - f(256 - f(4 * Math.min(distance, 64)))) : 400;
  context.checkBlocked(state, direction, true, result);
  context.actions.move(state.client, direction, speed);
  result.moveDirection = direction;
  return result;
}

export function finishTravelWalkOffLedge(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), direction = sub3(reach.end, state.origin);
  context.checkBlocked(state, direction, true, result);
  const horizontalDirection = horizontal(state.origin, reach.end), distance = length3(horizontalDirection);
  const end = distance > 16 ? ma(reach.end, 16, normalize3(horizontalDirection)) : reach.end;
  const control = context.airControl(state.origin, state.velocity, end);
  const moveDirection = control.controlled ? control.direction : normalize3(vec3(direction.x, direction.y, 0));
  context.actions.move(state.client, moveDirection, control.controlled ? control.speed : 400);
  result.moveDirection = moveDirection;
  return result;
}

/** The third Jump body is the active source implementation; the first two are comments. */
export function travelJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  let runStart = context.routing.spatial.movement.jumpReachRunStart(reach);
  let direction = normalize3(horizontal(reach.start, runStart));
  const start = vec3(reach.start.x, reach.start.y, reach.start.z + 1);
  runStart = ma(reach.start, 80, direction);
  let scanDistance = 0;
  for (; scanDistance < 80; scanDistance += 10) {
    const end = ma(start, scanDistance + 10, direction);
    if (context.routing.spatial.world.pointArea(vec3(end.x, end.y, end.z + 1)) !== state.reachArea) break;
  }
  if (scanDistance < 80) runStart = ma(reach.start, scanDistance, direction);
  const fromStart = horizontal(reach.start, state.origin), fromRunStart = horizontal(runStart, state.origin);
  const startDistance = length3(fromStart), runDistance = length3(fromRunStart);
  if (dot3(normalize3(fromStart), normalize3(fromRunStart)) < -0.8 || runDistance < 5) {
    direction = normalize3(horizontal(state.origin, reach.end));
    if (startDistance < 24) context.actions.jump(state.client);
    else if (startDistance < 32) context.actions.delayedJump(state.client);
    context.actions.move(state.client, direction, 600);
    state.jumpReach = state.lastReachability;
  } else {
    direction = normalize3(horizontal(state.origin, runStart));
    context.actions.move(state.client, direction, f(400 - f(400 - f(5 * Math.min(runDistance, 80)))));
  }
  result.moveDirection = direction;
  return result;
}

export function finishTravelJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  if (state.jumpReach === 0) return result;
  const offset = horizontal(state.origin, reach.end), distance = length3(offset), direction = normalize3(offset);
  if (dot3(direction, normalize3(horizontal(reach.start, reach.end))) < -0.5 && distance < 24) return result;
  context.actions.move(state.client, direction, 800);
  result.moveDirection = direction;
  return result;
}

export function travelLadder(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), direction = normalize3(sub3(reach.end, state.origin));
  result.idealViewAngles = context.vectorToAngles(vec3(direction.x, direction.y, 3 * direction.z));
  context.actions.move(state.client, vec3(0, 0, 0), 0);
  context.actions.moveForward(state.client);
  result.flags |= BotMoveResultFlag.MOVEMENTVIEW;
  result.moveDirection = direction;
  return result;
}

export function travelTeleport(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  if ((state.moveFlags & BotMoveFlag.TELEPORTED) !== 0) return result;
  const offset = (state.moveFlags & BotMoveFlag.SWIMMING) !== 0 ? sub3(reach.start, state.origin) : horizontal(state.origin, reach.start);
  const distance = length3(offset), direction = normalize3(offset);
  context.checkBlocked(state, direction, true, result);
  context.actions.move(state.client, direction, distance < 30 ? 200 : 400);
  if ((state.moveFlags & BotMoveFlag.SWIMMING) !== 0) result.flags |= BotMoveResultFlag.SWIMVIEW;
  result.moveDirection = direction;
  return result;
}

export function travelJumpPad(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), direction = normalize3(horizontal(state.origin, reach.start));
  context.checkBlocked(state, direction, true, result);
  context.actions.move(state.client, direction, 400);
  result.moveDirection = direction;
  return result;
}

export function finishTravelJumpPad(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), control = context.airControl(state.origin, state.velocity, reach.end);
  const direction = control.controlled ? control.direction : normalize3(horizontal(state.origin, reach.end));
  context.checkBlocked(state, direction, true, result);
  context.actions.move(state.client, direction, control.controlled ? control.speed : 400);
  result.moveDirection = direction;
  return result;
}
