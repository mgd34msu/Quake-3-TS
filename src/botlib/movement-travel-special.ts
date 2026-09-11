// Port of id Software's botlib/be_ai_move.c mover, grapple and weapon travel.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, dot3, length3, normalize3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { finishCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { AasReachability } from "./aas.ts";
import type { BotTravelContext } from "./movement.ts";
import { movementAngleDifference } from "./movement-routing.ts";
import { BotMoveFlag, BotMoveResult, BotMoveResultFlag, BotMoveResultType } from "./movement-state.ts";
import type { BotMoveState } from "./movement-state.ts";
import { TravelType } from "./routing.ts";

const f = Math.fround;

function moverBottomCenter(context: BotTravelContext, reach: AasReachability): Vec3 {
  const model = reach.face & 0xffff;
  const modelInfo = context.routing.spatial.host.modelBounds(model, vec3(0, 0, 0));
  const moverOrigin = context.routing.host.originOfMoverWithModelNum(model);
  if (moverOrigin === null) context.routing.states.host.print(1, `no entity with model ${model}\n`);
  const origin = moverOrigin === null ? modelInfo.origin : moverOrigin;
  const middle = add3(modelInfo.bounds.min, modelInfo.bounds.max);
  return vec3(origin.x + 0.5 * middle.x, origin.y + 0.5 * middle.y, reach.start.z);
}

export function travelElevator(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  if (context.routing.onMover(state.origin, state.entityNum, reach)) {
    if (context.diagnostics?.elevator) context.routing.states.host.print(1, "bot on elevator\n");
    // The source calls integer abs(), truncating the float subtraction first.
    if (Math.abs(Math.trunc(f(state.origin.z - reach.end.z))) < context.variable("svMaxBarrier").value) {
      if (context.diagnostics?.elevator) context.routing.states.host.print(1, "bot moving to end\n");
      const direction = normalize3(vec3(reach.end.x - state.origin.x, reach.end.y - state.origin.y, 0));
      if (!context.checkBarrierJump(state, direction, 100)) context.actions.move(state.client, direction, 400);
      result.moveDirection = direction;
    } else {
      const center = moverBottomCenter(context, reach);
      const offset = vec3(center.x - state.origin.x, center.y - state.origin.y, 0);
      let distance = length3(offset);
      const direction = normalize3(offset);
      if (distance > 10) {
        if (context.diagnostics?.elevator) context.routing.states.host.print(1, "bot moving to center\n");
        if (distance > 100) distance = 100;
        context.actions.move(state.client, direction, f(400 - f(400 - f(4 * distance))));
        result.moveDirection = direction;
      }
    }
    return result;
  }
  if (context.diagnostics?.elevator) context.routing.states.host.print(1, "bot not on elevator\n");
  let direction = sub3(reach.end, state.origin);
  let distance = length3(direction);
  if (distance < 64) {
    if (distance > 60) distance = 60;
    const speed = f(360 - f(360 - f(6 * distance)));
    if ((state.moveFlags & BotMoveFlag.SWIMMING) || !context.checkBarrierJump(state, direction, 50)) {
      if (speed > 5) context.actions.move(state.client, direction, speed);
    }
    result.moveDirection = direction;
    if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
    state.reachabilityTime = 0;
    return result;
  }
  const startOffset = sub3(reach.start, state.origin);
  const startDirection = state.moveFlags & BotMoveFlag.SWIMMING ? startOffset : vec3(startOffset.x, startOffset.y, 0);
  const startDistance = length3(startDirection), first = normalize3(startDirection);
  if (!context.routing.moverDown(reach)) {
    if (context.diagnostics?.elevator) context.routing.states.host.print(1, "elevator not down\n");
    distance = startDistance;
    direction = first;
    context.checkBlocked(state, direction, false, result);
    if (distance > 60) distance = 60;
    const speed = f(360 - f(360 - f(6 * distance)));
    if (!(state.moveFlags & BotMoveFlag.SWIMMING) && !context.checkBarrierJump(state, direction, 50)) {
      if (speed > 5) context.actions.move(state.client, direction, speed);
    }
    result.moveDirection = direction;
    if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
    result.type = BotMoveResultType.ELEVATORUP;
    result.flags |= BotMoveResultFlag.WAITING;
    return result;
  }
  const centerOffset = sub3(moverBottomCenter(context, reach), state.origin);
  const centerDirection = state.moveFlags & BotMoveFlag.SWIMMING ? centerOffset : vec3(centerOffset.x, centerOffset.y, 0);
  const centerDistance = length3(centerDirection), second = normalize3(centerDirection);
  if (startDistance < 20 || centerDistance < startDistance || dot3(first, second) < 0) {
    if (context.diagnostics?.elevator) context.routing.states.host.print(1, "bot moving to center\n");
    distance = centerDistance;
    direction = second;
  } else {
    if (context.diagnostics?.elevator) context.routing.states.host.print(1, "bot moving to start\n");
    distance = startDistance;
    direction = first;
  }
  context.checkBlocked(state, direction, false, result);
  if (distance > 60) distance = 60;
  const speed = f(400 - f(400 - f(6 * distance)));
  if (!(state.moveFlags & BotMoveFlag.SWIMMING) && !context.checkBarrierJump(state, direction, 50)) {
    context.actions.move(state.client, direction, speed);
  }
  result.moveDirection = direction;
  if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
  return result;
}

export function finishTravelElevator(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  const bottomDirection = sub3(moverBottomCenter(context, reach), state.origin);
  const topDirection = sub3(reach.end, state.origin);
  const direction = Math.abs(bottomDirection.z) < Math.abs(topDirection.z) ? bottomDirection : topDirection;
  context.actions.move(state.client, normalize3(direction), 300);
  return result;
}

function funcBobStartEnd(context: BotTravelContext, reach: AasReachability): {
  readonly start: Vec3; readonly end: Vec3; readonly origin: Vec3 | null;
} {
  const model = reach.face & 0xffff;
  const origin = context.routing.host.originOfMoverWithModelNum(model);
  if (origin === null) {
    context.routing.states.host.print(1, `BotFuncBobStartEnd: no entity with model ${model}\n`);
    return { start: vec3(0, 0, 0), end: vec3(0, 0, 0), origin: null };
  }
  const bounds = context.routing.spatial.host.modelBounds(model, vec3(0, 0, 0)).bounds;
  const sum = add3(bounds.min, bounds.max), middle = vec3(sum.x * 0.5, sum.y * 0.5, sum.z * 0.5);
  const flags = reach.face >> 16;
  const first = reach.edge >> 16, second = (reach.edge << 16) >> 16;
  if (flags & 1) return {
    start: vec3(first, middle.y, middle.z), end: vec3(second, middle.y, middle.z),
    origin: vec3(origin.x + middle.x, middle.y, middle.z),
  };
  if (flags & 2) return {
    start: vec3(middle.x, first, middle.z), end: vec3(middle.x, second, middle.z),
    origin: vec3(middle.x, origin.y + middle.y, middle.z),
  };
  return {
    start: vec3(middle.x, middle.y, first), end: vec3(middle.x, middle.y, second),
    origin: vec3(middle.x, middle.y, origin.z + middle.z),
  };
}

export function travelFuncBobbing(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), bob = funcBobStartEnd(context, reach);
  if (context.routing.onMover(state.origin, state.entityNum, reach)) {
    if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot on func_bobbing\n");
    if (bob.origin === null) throw new Error("BotTravel_FuncBobbing consumes an undefined mover origin");
    if (length3(sub3(bob.origin, bob.end)) < 24) {
      if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot moving to reachability end\n");
      const direction = normalize3(vec3(reach.end.x - state.origin.x, reach.end.y - state.origin.y, 0));
      if (!context.checkBarrierJump(state, direction, 100)) context.actions.move(state.client, direction, 400);
      result.moveDirection = direction;
    } else {
      const center = moverBottomCenter(context, reach);
      const offset = vec3(center.x - state.origin.x, center.y - state.origin.y, 0);
      let distance = length3(offset);
      const direction = normalize3(offset);
      if (distance > 10) {
        if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot moving to func_bobbing center\n");
        if (distance > 100) distance = 100;
        context.actions.move(state.client, direction, f(400 - f(400 - f(4 * distance))));
        result.moveDirection = direction;
      }
    }
    return result;
  }
  if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot not ontop of func_bobbing\n");
  let direction = sub3(reach.end, state.origin);
  let distance = length3(direction);
  if (distance < 64) {
    if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot moving to end\n");
    if (distance > 60) distance = 60;
    const speed = f(360 - f(360 - f(6 * distance)));
    if ((state.moveFlags & BotMoveFlag.SWIMMING) || !context.checkBarrierJump(state, direction, 50)) {
      if (speed > 5) context.actions.move(state.client, direction, speed);
    }
    result.moveDirection = direction;
    if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
    state.reachabilityTime = 0;
    return result;
  }
  const startOffset = sub3(reach.start, state.origin);
  const startDirection = state.moveFlags & BotMoveFlag.SWIMMING ? startOffset : vec3(startOffset.x, startOffset.y, 0);
  const startDistance = length3(startDirection), first = normalize3(startDirection);
  if (bob.origin === null) throw new Error("BotTravel_FuncBobbing consumes an undefined mover origin");
  if (length3(sub3(bob.origin, bob.start)) > 16) {
    if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "func_bobbing not at start\n");
    distance = startDistance;
    direction = first;
    context.checkBlocked(state, direction, false, result);
    if (distance > 60) distance = 60;
    const speed = f(360 - f(360 - f(6 * distance)));
    if (!(state.moveFlags & BotMoveFlag.SWIMMING) && !context.checkBarrierJump(state, direction, 50)) {
      if (speed > 5) context.actions.move(state.client, direction, speed);
    }
    result.moveDirection = direction;
    if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
    result.type = BotMoveResultType.WAITFORFUNCBOBBING;
    result.flags |= BotMoveResultFlag.WAITING;
    return result;
  }
  const centerOffset = sub3(moverBottomCenter(context, reach), state.origin);
  const centerDirection = state.moveFlags & BotMoveFlag.SWIMMING ? centerOffset : vec3(centerOffset.x, centerOffset.y, 0);
  const centerDistance = length3(centerDirection), second = normalize3(centerDirection);
  if (startDistance < 20 || centerDistance < startDistance || dot3(first, second) < 0) {
    if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot moving to func_bobbing center\n");
    distance = centerDistance;
    direction = second;
  } else {
    if (context.diagnostics?.funcBob) context.routing.states.host.print(1, "bot moving to reachability start\n");
    distance = startDistance;
    direction = first;
  }
  context.checkBlocked(state, direction, false, result);
  if (distance > 60) distance = 60;
  const speed = f(400 - f(400 - f(6 * distance)));
  if (!(state.moveFlags & BotMoveFlag.SWIMMING) && !context.checkBarrierJump(state, direction, 50)) {
    context.actions.move(state.client, direction, speed);
  }
  result.moveDirection = direction;
  if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
  return result;
}

export function finishTravelFuncBobbing(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult(), bob = funcBobStartEnd(context, reach);
  if (bob.origin === null) throw new Error("BotFinishTravel_FuncBobbing consumes an undefined mover origin");
  const direction = sub3(bob.origin, bob.end);
  if (length3(direction) < 16) {
    const offset = sub3(reach.end, state.origin);
    let distance = length3(state.moveFlags & BotMoveFlag.SWIMMING ? offset : vec3(offset.x, offset.y, 0));
    if (distance > 60) distance = 60;
    const speed = f(360 - f(360 - f(6 * distance)));
    // Source consumes dir here, not the normalized hordir.
    if (speed > 5) context.actions.move(state.client, direction, speed);
    result.moveDirection = direction;
    if (state.moveFlags & BotMoveFlag.SWIMMING) result.flags |= BotMoveResultFlag.SWIMVIEW;
  } else {
    const offset = sub3(moverBottomCenter(context, reach), state.origin);
    const horizontal = state.moveFlags & BotMoveFlag.SWIMMING ? offset : vec3(offset.x, offset.y, 0);
    let distance = length3(horizontal);
    const normalized = normalize3(horizontal);
    if (distance > 5) {
      if (distance > 100) distance = 100;
      context.actions.move(state.client, normalized, f(400 - f(400 - f(4 * distance))));
      result.moveDirection = normalized;
    }
  }
  return result;
}

function grappleState(context: BotTravelContext, state: BotMoveState): 0 | 1 | 2 {
  if (state.moveFlags & BotMoveFlag.GRAPPLEPULL) return 2;
  for (let entity = context.host.nextEntity(0); entity !== 0; entity = context.host.nextEntity(entity)) {
    if (context.host.entityType(entity) === Math.trunc(context.variable("missileEntityType").value)) {
      if (context.host.entityWeapon(entity) === Math.trunc(context.variable("grappleIndex").value)) return 1;
    }
  }
  return 0;
}

export function resetGrapple(context: BotTravelContext, state: BotMoveState): void {
  finishCalls(resetGrappleCalls(context, state));
}

export function* resetGrappleCalls(context: BotTravelContext, state: BotMoveState): CallSteps<undefined> {
  const reach = context.routing.spatial.world.reachability[state.lastReachability];
  // AAS_ReachabilityFromNum zeroes its result when the number is out of range.
  if (reach === undefined || (reach.travelType & TravelType.MASK) !== TravelType.GRAPPLEHOOK) {
    if ((state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE) || state.grappleVisibleTime !== 0) {
      if (context.variable("offhandGrapple").value !== 0) yield* context.actions.commandCalls(state.client, context.variable("grappleOffCommand").string);
      state.moveFlags &= ~BotMoveFlag.ACTIVEGRAPPLE;
      state.grappleVisibleTime = 0;
      if (context.diagnostics?.grapple) context.routing.states.host.print(1, "reset grapple\n");
    }
  }
}

export function travelGrapple(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  return finishCalls(travelGrappleCalls(context, state, reach));
}

export function* travelGrappleCalls(context: BotTravelContext, state: BotMoveState, reach: AasReachability): CallSteps<BotMoveResult> {
  if (context.diagnostics?.grapple) context.diagnostics.showGrapple(reach);
  const result = new BotMoveResult();
  if (state.moveFlags & BotMoveFlag.GRAPPLERESET) {
    if (context.variable("offhandGrapple").value !== 0) yield* context.actions.commandCalls(state.client, context.variable("grappleOffCommand").string);
    state.moveFlags &= ~BotMoveFlag.ACTIVEGRAPPLE;
    return result;
  }
  if (Math.trunc(context.variable("offhandGrapple").value) === 0) {
    result.weapon = Math.trunc(context.variable("grappleIndex").value) + 0;
    result.flags |= BotMoveResultFlag.MOVEMENTWEAPON;
  }
  if (state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE) {
    if (context.diagnostics?.grapple) context.routing.states.host.print(1, "BotTravel_Grapple: active grapple\n");
    const hookState = grappleState(context, state);
    const distance = length3(vec3(reach.end.x - state.origin.x, reach.end.y - state.origin.y, 0));
    if (hookState !== 0 && distance < 48) {
      if (f(state.lastGrappleDistance - distance) < 1) {
        if (context.diagnostics?.grapple) context.routing.states.host.print(3, "grapple normal end\n");
        if (context.variable("offhandGrapple").value !== 0) yield* context.actions.commandCalls(state.client, context.variable("grappleOffCommand").string);
        state.moveFlags &= ~BotMoveFlag.ACTIVEGRAPPLE;
        state.moveFlags |= BotMoveFlag.GRAPPLERESET;
        state.reachabilityTime = 0;
        return result;
      }
    } else if (hookState === 0 || (hookState === 2 && distance > f(state.lastGrappleDistance - 2))) {
      if (state.grappleVisibleTime < f(context.routing.states.host.time()) - 0.4) {
        if (context.diagnostics?.grapple) context.routing.states.host.print(3, "grapple not visible\n");
        if (context.variable("offhandGrapple").value !== 0) yield* context.actions.commandCalls(state.client, context.variable("grappleOffCommand").string);
        state.moveFlags &= ~BotMoveFlag.ACTIVEGRAPPLE;
        state.moveFlags |= BotMoveFlag.GRAPPLERESET;
        state.reachabilityTime = 0;
        return result;
      }
    } else {
      state.grappleVisibleTime = f(context.routing.states.host.time());
    }
    if (Math.trunc(context.variable("offhandGrapple").value) === 0) context.actions.attack(state.client);
    state.lastGrappleDistance = distance;
  } else {
    if (context.diagnostics?.grapple) context.routing.states.host.print(1, "BotTravel_Grapple: inactive grapple\n");
    state.grappleVisibleTime = f(context.routing.states.host.time());
    const offset = sub3(reach.start, state.origin);
    const moveOffset = state.moveFlags & BotMoveFlag.SWIMMING ? offset : vec3(offset.x, offset.y, 0);
    const viewDirection = sub3(reach.end, add3(state.origin, state.viewOffset));
    const distance = length3(moveOffset), direction = normalize3(moveOffset);
    result.idealViewAngles = context.vectorToAngles(viewDirection);
    result.flags |= BotMoveResultFlag.MOVEMENTVIEW;
    if (distance < 5 && Math.abs(movementAngleDifference(result.idealViewAngles.x, state.viewAngles.x)) < 2
      && Math.abs(movementAngleDifference(result.idealViewAngles.y, state.viewAngles.y)) < 2) {
      if (context.diagnostics?.grapple) context.routing.states.host.print(1, "BotTravel_Grapple: activating grapple\n");
      const trace = context.routing.spatial.host.trace(add3(state.origin, state.viewOffset), reach.end, null, state.entityNum, 1);
      if (length3(sub3(reach.end, trace.end)) > 16) { result.failure = true; return result; }
      if (context.variable("offhandGrapple").value !== 0) yield* context.actions.commandCalls(state.client, context.variable("grappleOnCommand").string);
      else context.actions.attack(state.client);
      state.moveFlags |= BotMoveFlag.ACTIVEGRAPPLE;
      state.lastGrappleDistance = 999999;
    } else {
      const speed = distance < 70 ? f(300 - f(300 - f(4 * distance))) : 400;
      context.checkBlocked(state, direction, true, result);
      context.actions.move(state.client, direction, speed);
      result.moveDirection = direction;
    }
    const area = context.routing.spatial.world.pointArea(state.origin);
    if (area !== 0 && area !== state.reachArea) state.reachabilityTime = 0;
  }
  return result;
}

export function travelRocketJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  const offset = vec3(reach.start.x - state.origin.x, reach.start.y - state.origin.y, 0);
  let distance = length3(offset), direction = normalize3(offset);
  const initialAngles = context.vectorToAngles(direction);
  result.idealViewAngles = vec3(90, initialAngles.y, initialAngles.z);
  if (distance < 5 && Math.abs(movementAngleDifference(result.idealViewAngles.x, state.viewAngles.x)) < 5
    && Math.abs(movementAngleDifference(result.idealViewAngles.y, state.viewAngles.y)) < 5) {
    direction = normalize3(vec3(reach.end.x - state.origin.x, reach.end.y - state.origin.y, 0));
    context.actions.jump(state.client);
    context.actions.attack(state.client);
    context.actions.move(state.client, direction, 800);
    state.jumpReach = state.lastReachability;
  } else {
    if (distance > 80) distance = 80;
    context.actions.move(state.client, direction, f(400 - f(400 - f(5 * distance))));
  }
  const angles = context.vectorToAngles(direction);
  result.idealViewAngles = vec3(90, angles.y, angles.z);
  context.actions.view(state.client, result.idealViewAngles);
  result.flags |= BotMoveResultFlag.MOVEMENTVIEWSET;
  context.actions.selectWeapon(state.client, Math.trunc(context.variable("rocketLauncherIndex").value) + 0);
  result.weapon = Math.trunc(context.variable("rocketLauncherIndex").value) + 0;
  result.flags |= BotMoveResultFlag.MOVEMENTWEAPON;
  result.moveDirection = direction;
  return result;
}

export function travelBFGJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  const offset = vec3(reach.start.x - state.origin.x, reach.start.y - state.origin.y, 0);
  let distance = length3(offset), direction = normalize3(offset);
  // Approved correction: initialize the source's indeterminate aim before its check,
  // using the same pre-check calculation as the neighboring RocketJump function.
  const initialAngles = context.vectorToAngles(direction);
  result.idealViewAngles = vec3(90, initialAngles.y, initialAngles.z);
  if (distance < 5 && Math.abs(movementAngleDifference(result.idealViewAngles.x, state.viewAngles.x)) < 5
    && Math.abs(movementAngleDifference(result.idealViewAngles.y, state.viewAngles.y)) < 5) {
    direction = normalize3(vec3(reach.end.x - state.origin.x, reach.end.y - state.origin.y, 0));
    context.actions.jump(state.client);
    context.actions.attack(state.client);
    context.actions.move(state.client, direction, 800);
    state.jumpReach = state.lastReachability;
  } else {
    if (distance > 80) distance = 80;
    context.actions.move(state.client, direction, f(400 - f(400 - f(5 * distance))));
  }
  const angles = context.vectorToAngles(direction);
  result.idealViewAngles = vec3(90, angles.y, angles.z);
  context.actions.view(state.client, result.idealViewAngles);
  result.flags |= BotMoveResultFlag.MOVEMENTVIEWSET;
  context.actions.selectWeapon(state.client, Math.trunc(context.variable("bfgIndex").value) + 0);
  result.weapon = Math.trunc(context.variable("bfgIndex").value) + 0;
  result.flags |= BotMoveResultFlag.MOVEMENTWEAPON;
  result.moveDirection = direction;
  return result;
}

export function finishTravelWeaponJump(context: BotTravelContext, state: BotMoveState, reach: AasReachability): BotMoveResult {
  const result = new BotMoveResult();
  if (state.jumpReach === 0) return result;
  const control = context.airControl(state.origin, state.velocity, reach.end);
  const direction = control.controlled ? control.direction : normalize3(vec3(reach.end.x - state.origin.x, reach.end.y - state.origin.y, 0));
  context.actions.move(state.client, direction, control.controlled ? control.speed : 400);
  result.moveDirection = direction;
  return result;
}
