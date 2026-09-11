// Port of id Software's botlib/be_ai_move.c movement execution and dispatch.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, dot3, length3, normalize3, normalize3OrZero, scale3, sub3, vec2, vec3 } from "../core/math.ts";
import type { Bounds, Vec2, Vec3 } from "../core/math.ts";
import { finishCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { AasReachability } from "./aas.ts";
import type { BotActionBuffer } from "./actions.ts";
import type { BotGoal } from "./goals.ts";
import type { BotMovementRouting } from "./movement-routing.ts";
import { BotMoveFlag, BotMoveResult, BotMoveResultFlag, BotMoveResultType, BotMoveType } from "./movement-state.ts";
import type { BotMoveState, BotMoveStateStore, BotMoveVariable } from "./movement-state.ts";
import { TravelFlags, TravelType, travelFlagForType } from "./routing.ts";
import type { BotRandom } from "./weights.ts";
import { finishTravelBarrierJump, finishTravelJump, finishTravelJumpPad, finishTravelWalkOffLedge,
  finishTravelWaterJump, travelBarrierJump, travelCrouch, travelJump, travelJumpPad, travelLadder,
  travelSwim, travelTeleport, travelWalk, travelWalkOffLedge, travelWaterJump } from "./movement-travel-ground.ts";
import { finishTravelElevator, finishTravelFuncBobbing, finishTravelWeaponJump, resetGrappleCalls,
  travelBFGJump, travelElevator, travelFuncBobbing, travelGrappleCalls, travelRocketJump } from "./movement-travel-special.ts";

const f = Math.fround;
const SOLID = 1, WATER = 32, PLAYERCLIP = 0x10000, BODY = 0x2000000;
const WORLD_ENTITY = 1022, NO_ENTITY = 1023;
const ZERO = vec3(0, 0, 0);

export interface BotMovementHost {
  readonly random: BotRandom;
  developer(): boolean;
  nextEntity(after: number): number;
  entityType(entity: number): number;
  entityWeapon(entity: number): number;
}
export type BotMovementVariableName = "svMaxStep" | "svMaxBarrier" | "svGravity" | "rocketLauncherIndex"
  | "bfgIndex" | "grappleIndex" | "missileEntityType" | "offhandGrapple" | "grappleOnCommand" | "grappleOffCommand";

export interface BotMovementDebugOptions {
  readonly debug?: boolean;
  readonly aiMove?: boolean;
  readonly elevator?: boolean;
  readonly funcBob?: boolean;
  readonly grapple?: boolean;
  clearLines(): void;
  printTravelType(type: number): void;
  showReachability(reach: AasReachability): void;
  lineCreate(): number;
  lineShow(line: number, start: Vec3, end: Vec3, color: number): void;
}
export class BotMovementDebugState {
  grappleLine = 0;
}

/** Borrowed services for the travel modules, created only by the movement owner. */
export interface BotTravelContext {
  readonly routing: BotMovementRouting;
  readonly actions: BotActionBuffer;
  readonly host: BotMovementHost;
  readonly diagnostics?: {
    readonly elevator: boolean;
    readonly funcBob: boolean;
    readonly grapple: boolean;
    showGrapple(reach: AasReachability): void;
  };
  variable(name: BotMovementVariableName): BotMoveVariable;
  vectorToAngles(direction: Vec3): Vec3;
  gapDistance(origin: Vec3, horizontalDirection: Vec3, entity: number): number;
  checkBarrierJump(state: BotMoveState, direction: Vec3, speed: number): boolean;
  checkBlocked(state: BotMoveState, direction: Vec3, checkBottom: boolean, result: BotMoveResult): void;
  airControl(origin: Vec3, velocity: Vec3, goal: Vec3): { readonly controlled: boolean; readonly direction: Vec3; readonly speed: number };
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Bot movement index ${index} outside ${values.length} entries`);
  return value;
}
function ma(origin: Vec3, distance: number, direction: Vec3): Vec3 { return add3(origin, scale3(direction, distance)); }
function clearMoveResult(result: BotMoveResult): void {
  result.failure = false; result.type = 0; result.blocked = false;
  result.blockEntity = 0; result.travelType = 0; result.flags = 0;
}
function copyMoveResult(target: BotMoveResult, source: BotMoveResult): void {
  target.failure = source.failure; target.type = source.type; target.blocked = source.blocked;
  target.blockEntity = source.blockEntity; target.travelType = source.travelType; target.flags = source.flags;
  target.weapon = source.weapon; target.moveDirection = source.moveDirection; target.idealViewAngles = source.idealViewAngles;
}
/** Native q_math.c vectoangles, not the game QVM's staged atan2 arithmetic. */
function vectorToAngles(value: Vec3): Vec3 {
  let yaw: number, pitch: number;
  if (value.y === 0 && value.x === 0) { yaw = 0; pitch = value.z > 0 ? 90 : 270; }
  else {
    yaw = value.x !== 0 ? f(Math.atan2(value.y, value.x) * 180 / Math.PI) : value.y > 0 ? 90 : 270;
    if (yaw < 0) yaw = f(yaw + 360);
    const forward = f(Math.sqrt(f(f(value.x * value.x) + f(value.y * value.y))));
    pitch = f(Math.atan2(value.z, forward) * 180 / Math.PI);
    if (pitch < 0) pitch = f(pitch + 360);
  }
  return vec3(-pitch, yaw, 0);
}

/** Source Intersection uses infinite lines and stores integer-truncated coordinates. */
export function movementIntersection(first: Vec2, second: Vec2, third: Vec2, fourth: Vec2): Vec2 | null {
  const dx1 = f(second.x - first.x), dy1 = f(second.y - first.y);
  const dx2 = f(fourth.x - third.x), dy2 = f(fourth.y - third.y);
  const denominator = f(f(dy1 * dx2) - f(dx1 * dy2));
  if (denominator === 0) return null;
  const x1 = f(f(first.y * dx1) - f(first.x * dy1)), x2 = f(f(third.y * dx2) - f(third.x * dy2));
  const x = f(f(f(dx1 * x2) - f(dx2 * x1)) / denominator), y = f(f(f(dy1 * x2) - f(dy2 * x1)) / denominator);
  if (!(x >= -2147483648 && x < 2147483648 && y >= -2147483648 && y < 2147483648)) {
    throw new RangeError("Bot movement intersection exceeds defined source integer conversion");
  }
  return vec2(Math.trunc(x) + 0, Math.trunc(y) + 0);
}

/** Executes against the existing state pool, AAS world/routes and EA input buffer. */
export class BotMovement {
  private readonly context: BotTravelContext;

  constructor(readonly routing: BotMovementRouting, readonly actions: BotActionBuffer, readonly host: BotMovementHost,
    private readonly diagnostics?: BotMovementDebugOptions, debugState = new BotMovementDebugState()) {
    this.context = { routing, actions, host, variable: name => this.variable(name), vectorToAngles,
      ...(diagnostics === undefined ? {} : { diagnostics: {
        elevator: diagnostics.elevator === true, funcBob: diagnostics.funcBob === true, grapple: diagnostics.grapple === true,
        showGrapple: (reach: AasReachability) => {
          if (debugState.grappleLine === 0) debugState.grappleLine = diagnostics.lineCreate();
          diagnostics.lineShow(debugState.grappleLine, reach.start, reach.end, 3);
        },
      } }),
      gapDistance: (origin, direction, entity) => this.gapDistance(origin, direction, entity),
      checkBarrierJump: (state, direction, speed) => this.checkBarrierJump(state, direction, speed),
      checkBlocked: (state, direction, bottom, result) => this.checkBlocked(state, direction, bottom, result),
      airControl: (origin, velocity, goal) => this.airControl(origin, velocity, goal) };
  }

  private variable(name: BotMovementVariableName): BotMoveVariable {
    const variable = this.routing.states[name];
    if (variable === null) throw new Error(`Bot movement variable ${name} requires movement-state setup`);
    return variable;
  }
  private reachability(number: number): AasReachability {
    return this.routing.reachabilityFromNum(number);
  }
  private areaReachability(area: number): number { return at(this.routing.spatial.world.areaSettings, area).reachableAreaCount; }

  private gapDistance(origin: Vec3, horizontalDirection: Vec3, entity: number): number {
    const spatial = this.routing.spatial;
    let trace = spatial.traceClientBBox(origin, vec3(origin.x, origin.y, origin.z - 60), 4, entity);
    if (trace.fraction >= 1) return 1;
    let startZ = f(trace.end.z + 1);
    for (let distance = 8; distance <= 100; distance += 8) {
      const horizontal = ma(origin, distance, horizontalDirection), start = vec3(horizontal.x, horizontal.y, startZ + 24);
      const end = vec3(start.x, start.y, start.z - f(48 + this.variable("svMaxBarrier").value));
      trace = spatial.traceClientBBox(start, end, 4, entity);
      if (!trace.startSolid) {
        if (trace.end.z < f(f(startZ - this.variable("svMaxStep").value) - 8)) {
          if ((spatial.host.pointContents(vec3(trace.end.x, trace.end.y, trace.end.z - 20)) & WATER) !== 0) break;
          return distance;
        }
        startZ = trace.end.z;
      }
    }
    return 0;
  }

  private checkBarrierJump(state: BotMoveState, direction: Vec3, speed: number): boolean {
    const spatial = this.routing.spatial;
    let end = vec3(state.origin.x, state.origin.y, state.origin.z + this.variable("svMaxBarrier").value);
    let trace = spatial.traceClientBBox(state.origin, end, 2, state.entityNum);
    if (trace.startSolid || f(trace.end.z - state.origin.z) < this.variable("svMaxStep").value) return false;
    const horizontal = normalize3(vec3(direction.x, direction.y, 0));
    // The source VectorMA macro retains the double literal0.5 until each component assignment.
    const distance = f(state.thinkTime * speed) * 0.5;
    end = vec3(state.origin.x + distance * horizontal.x, state.origin.y + distance * horizontal.y, trace.end.z);
    trace = spatial.traceClientBBox(trace.end, end, 2, state.entityNum);
    if (trace.startSolid) return false;
    end = vec3(trace.end.x, trace.end.y, state.origin.z);
    trace = spatial.traceClientBBox(trace.end, end, 2, state.entityNum);
    if (trace.startSolid || trace.fraction >= 1 || f(trace.end.z - state.origin.z) < this.variable("svMaxStep").value) return false;
    this.actions.jump(state.client); this.actions.move(state.client, horizontal, speed);
    state.moveFlags |= BotMoveFlag.BARRIERJUMP;
    return true;
  }

  moveInDirection(handle: number, direction: Vec3, speed: number, type: number): boolean {
    return BotMovement.moveInDirection(handle, direction, speed, type, this.routing.states, () => this);
  }

  static moveInDirection(
    handle: number, direction: Vec3, speed: number, type: number,
    states: BotMoveStateStore, currentMovement: () => BotMovement,
  ): boolean {
    const state = states.fromHandle(handle);
    if (state === null) return false;
    return currentMovement().moveStateInDirection(state, direction, speed, type);
  }

  private moveStateInDirection(state: BotMoveState, direction: Vec3, speed: number, type: number): boolean {
    speed = f(speed);
    const movement = this.routing.spatial.movement;
    if (movement.swimming(state.origin)) { this.actions.move(state.client, normalize3(direction), speed); return true; }
    if (movement.onGround(state.origin, state.presenceType, state.entityNum)) state.moveFlags |= BotMoveFlag.ONGROUND;
    if ((state.moveFlags & BotMoveFlag.ONGROUND) !== 0) {
      if (this.checkBarrierJump(state, direction, speed)) return true;
      state.moveFlags &= ~BotMoveFlag.BARRIERJUMP;
      const presence = (type & BotMoveType.CROUCH) !== 0 && (type & BotMoveType.JUMP) === 0 ? 4 : 2;
      const horizontal = normalize3(vec3(direction.x, direction.y, 0));
      if ((type & BotMoveType.JUMP) === 0 && this.gapDistance(state.origin, horizontal, state.entityNum) > 0) type |= BotMoveType.JUMP;
      let command = scale3(horizontal, speed);
      const jumping = (type & BotMoveType.JUMP) !== 0;
      if (jumping) command = vec3(command.x, command.y, 400);
      const maximumFrames = jumping ? 30 : 2;
      const prediction = movement.predictClientMovement({ entityNum: state.entityNum,
        origin: vec3(state.origin.x, state.origin.y, state.origin.z + 0.5), presence, onGround: true,
        velocity: state.velocity, commandMove: command, commandFrames: jumping ? 1 : 2, maxFrames: maximumFrames,
        frameTime: f(0.1), stopEvents: (jumping ? 1 : 0) | 32 | 4 | 8 | 16, stopArea: 0, visualize: false }).move;
      if (jumping && prediction.frames >= maximumFrames) return false;
      if ((prediction.stopEvent & (8 | 16 | 32)) !== 0) return false;
      if ((prediction.stopEvent & 1) !== 0) {
        if (this.gapDistance(prediction.end, normalize3OrZero(prediction.velocity), state.entityNum) > 0) return false;
        if (this.gapDistance(prediction.end, horizontal, state.entityNum) > 0) return false;
      }
      const displacement = vec3(prediction.end.x - state.origin.x, prediction.end.y - state.origin.y, 0);
      if (length3(displacement) < f(speed * state.thinkTime) * 0.5) return false;
      if ((type & BotMoveType.JUMP) !== 0) this.actions.jump(state.client);
      if ((type & BotMoveType.CROUCH) !== 0) this.actions.crouch(state.client);
      this.actions.move(state.client, horizontal, speed);
      return true;
    }
    if ((state.moveFlags & BotMoveFlag.BARRIERJUMP) !== 0 && state.velocity.z < 50) this.actions.move(state.client, direction, speed);
    return true;
  }

  private checkBlocked(state: BotMoveState, direction: Vec3, checkBottom: boolean, result: BotMoveResult): void {
    const spatial = this.routing.spatial;
    const boundsForState = (): Bounds => spatial.presenceBounds(state.presenceType);
    let bounds = boundsForState();
    if (Math.abs(dot3(direction, vec3(0, 0, 1))) < 0.7) bounds = {
      min: vec3(bounds.min.x, bounds.min.y, bounds.min.z + this.variable("svMaxStep").value),
      max: vec3(bounds.max.x, bounds.max.y, bounds.max.z - 10) };
    let trace = spatial.host.trace(state.origin, ma(state.origin, 3, direction), bounds, state.entityNum, SOLID | PLAYERCLIP | BODY);
    if (trace.solidity === "clear" && trace.entityNum !== WORLD_ENTITY && trace.entityNum !== NO_ENTITY) {
      result.blocked = true; result.blockEntity = trace.entityNum;
    } else if (checkBottom && this.areaReachability(state.area) === 0) {
      trace = spatial.host.trace(state.origin, vec3(state.origin.x, state.origin.y, state.origin.z - 3), boundsForState(), state.entityNum, SOLID | PLAYERCLIP);
      if (trace.solidity === "clear" && trace.entityNum !== WORLD_ENTITY && trace.entityNum !== NO_ENTITY) {
        result.blocked = true; result.blockEntity = trace.entityNum; result.flags |= BotMoveResultFlag.ONTOPOFOBSTACLE;
      }
    }
  }

  private airControl(origin: Vec3, velocity: Vec3, goal: Vec3): { readonly controlled: boolean; readonly direction: Vec3; readonly speed: number } {
    let position = origin, step = scale3(velocity, 0.1);
    for (let index = 0; index < 50; index++) {
      step = vec3(step.x, step.y, step.z - this.variable("svGravity").value * 0.01);
      if (step.z < 0 && f(position.z + step.z) < goal.z) {
        step = scale3(step, f(f(goal.z - position.z) / step.z));
        position = add3(position, step);
        const direction = sub3(goal, position), distance = Math.min(length3(direction), 32);
        return { controlled: true, direction: normalize3(direction), speed: f(400 - f(400 - f(13 * distance))) };
      }
      position = add3(position, step);
    }
    return { controlled: false, direction: ZERO, speed: 400 };
  }

  private reachabilityTime(reach: AasReachability): number {
    switch (reach.travelType & TravelType.MASK) {
      case TravelType.WALK: case TravelType.CROUCH: case TravelType.BARRIERJUMP: case TravelType.WALKOFFLEDGE:
      case TravelType.JUMP: case TravelType.SWIM: case TravelType.WATERJUMP: case TravelType.TELEPORT: return 5;
      case TravelType.LADDER: case TravelType.ROCKETJUMP: case TravelType.BFGJUMP: return 6;
      case TravelType.ELEVATOR: case TravelType.JUMPPAD: case TravelType.FUNCBOB: return 10;
      case TravelType.GRAPPLEHOOK: return 8;
      default: this.routing.states.host.print(3, `travel type ${reach.travelType} not implemented yet\n`); return 8;
    }
  }

  private moveInGoalArea(state: BotMoveState, goal: BotGoal): BotMoveResult {
    const result = new BotMoveResult(), swimming = (state.moveFlags & BotMoveFlag.SWIMMING) !== 0;
    const delta = vec3(goal.origin.x - state.origin.x, goal.origin.y - state.origin.y, swimming ? goal.origin.z - state.origin.z : 0);
    result.travelType = swimming ? TravelType.SWIM : TravelType.WALK;
    const direction = normalize3(delta), distance = Math.min(length3(delta), 100);
    let speed = f(400 - f(400 - f(4 * distance))); if (speed < 10) speed = 0;
    this.checkBlocked(state, direction, true, result);
    this.actions.move(state.client, direction, speed); result.moveDirection = direction;
    if (swimming) { result.idealViewAngles = vectorToAngles(direction); result.flags |= BotMoveResultFlag.SWIMVIEW; }
    state.lastReachability = 0; state.lastArea = 0; state.lastGoalArea = goal.area;
    state.lastOrigin = vec3(state.origin.x, state.origin.y, state.origin.z);
    return result;
  }

  private *travel(state: BotMoveState, reach: AasReachability, airborne: boolean): CallSteps<BotMoveResult | null> {
    const context = this.context;
    switch (reach.travelType & TravelType.MASK) {
      case TravelType.WALK: return travelWalk(context, state, reach);
      case TravelType.CROUCH: return airborne ? null : travelCrouch(context, state, reach);
      case TravelType.BARRIERJUMP: return airborne ? finishTravelBarrierJump(context, state, reach) : travelBarrierJump(context, state, reach);
      case TravelType.LADDER: return travelLadder(context, state, reach);
      case TravelType.WALKOFFLEDGE: return airborne ? finishTravelWalkOffLedge(context, state, reach) : travelWalkOffLedge(context, state, reach);
      case TravelType.JUMP: return airborne ? finishTravelJump(context, state, reach) : travelJump(context, state, reach);
      case TravelType.SWIM: return travelSwim(context, state, reach);
      case TravelType.WATERJUMP: return airborne ? finishTravelWaterJump(context, state, reach) : travelWaterJump(context, state, reach);
      case TravelType.TELEPORT: return airborne ? null : travelTeleport(context, state, reach);
      case TravelType.ELEVATOR: return airborne ? finishTravelElevator(context, state, reach) : travelElevator(context, state, reach);
      case TravelType.GRAPPLEHOOK: return yield* travelGrappleCalls(context, state, reach);
      case TravelType.ROCKETJUMP: return airborne ? finishTravelWeaponJump(context, state, reach) : travelRocketJump(context, state, reach);
      case TravelType.BFGJUMP: return airborne ? finishTravelWeaponJump(context, state, reach) : travelBFGJump(context, state, reach);
      case TravelType.JUMPPAD: return airborne ? finishTravelJumpPad(context, state, reach) : travelJumpPad(context, state, reach);
      case TravelType.FUNCBOB: return airborne ? finishTravelFuncBobbing(context, state, reach) : travelFuncBobbing(context, state, reach);
      default:
        this.routing.states.host.print(4, `${airborne ? "(last) " : ""}travel type ${reach.travelType & TravelType.MASK} not implemented yet\n`);
        return null;
    }
  }

  moveToGoal(result: BotMoveResult, handle: number, goal: BotGoal | null, travelFlags: number): void {
    BotMovement.moveToGoal(result, handle, goal, travelFlags, this.routing.states, () => this);
  }

  static moveToGoal(
    result: BotMoveResult, handle: number, goal: BotGoal | null, travelFlags: number,
    states: BotMoveStateStore, currentMovement: () => BotMovement,
  ): void {
    finishCalls(BotMovement.moveToGoalCalls(result, handle, goal, travelFlags, states, currentMovement));
  }

  static *moveToGoalCalls(
    result: BotMoveResult, handle: number, goal: BotGoal | null, travelFlags: number,
    states: BotMoveStateStore, currentMovement: () => BotMovement,
  ): CallSteps<undefined> {
    clearMoveResult(result);
    const state = states.fromHandle(handle); if (state === null) return;
    yield* currentMovement().moveStateToGoal(result, state, goal, travelFlags);
  }

  private *moveStateToGoal(result: BotMoveResult, state: BotMoveState, goal: BotGoal | null, travelFlags: number): CallSteps<undefined> {
    yield* resetGrappleCalls(this.context, state);
    if (goal === null) {
      if (this.diagnostics?.debug) this.routing.states.host.print(1, `client ${state.client}: movetogoal -> no goal\n`);
      result.failure = true; return;
    }
    const spatial = this.routing.spatial, movement = spatial.movement;
    state.moveFlags &= ~(BotMoveFlag.SWIMMING | BotMoveFlag.AGAINSTLADDER);
    if (movement.onGround(state.origin, state.presenceType, state.entityNum)) state.moveFlags |= BotMoveFlag.ONGROUND;
    if ((state.moveFlags & BotMoveFlag.ONGROUND) !== 0) {
      const entity = this.routing.onTopOfEntity(state);
      if (entity !== -1) {
        const model = spatial.host.entityModelIndex(entity);
        if (model >= 0 && model < 256) {
          const modelType = spatial.brushModelType(model);
          if (modelType === 1 || modelType === 2) {
            const reach = this.reachability(state.lastReachability), travelType = modelType === 1 ? TravelType.ELEVATOR : TravelType.FUNCBOB;
            if ((reach.travelType & TravelType.MASK) !== travelType || (reach.face & 0xffff) !== model) {
              const number = this.routing.routing.nextModelReachability(0, model);
              if (number !== 0) {
                state.lastReachability = number;
                state.reachabilityTime = f(f(this.routing.states.host.time()) + this.reachabilityTime(this.reachability(number)));
              } else {
                if (this.host.developer()) this.routing.states.host.print(1, `client ${state.client}: on ${modelType === 1 ? "func_plat" : "func_bobbing"} without reachability\n`);
                result.blocked = true; result.blockEntity = entity; result.flags |= BotMoveResultFlag.ONTOPOFOBSTACLE; return;
              }
            }
            result.flags |= modelType === 1 ? BotMoveResultFlag.ONTOPOF_ELEVATOR : BotMoveResultFlag.ONTOPOF_FUNCBOB;
          } else if (modelType === 3 || modelType === 4) {
            state.area = spatial.fuzzyPointReachabilityArea(state.origin);
            if (this.areaReachability(state.area) === 0) {
              result.blocked = true; result.blockEntity = entity; result.flags |= BotMoveResultFlag.ONTOPOFOBSTACLE; return;
            }
          } else { result.blocked = true; result.blockEntity = entity; result.flags |= BotMoveResultFlag.ONTOPOFOBSTACLE; return; }
        }
      }
    }
    if (movement.swimming(state.origin)) state.moveFlags |= BotMoveFlag.SWIMMING;
    if (movement.againstLadder(state.origin)) state.moveFlags |= BotMoveFlag.AGAINSTLADDER;
    if ((state.moveFlags & (BotMoveFlag.ONGROUND | BotMoveFlag.SWIMMING | BotMoveFlag.AGAINSTLADDER)) !== 0) {
      this.reachability(state.lastReachability);
      state.area = spatial.fuzzyPointReachabilityArea(state.origin);
      if (state.area === 0) {
        result.failure = true; result.blocked = true; result.blockEntity = 0; result.type = BotMoveResultType.INSOLIDAREA; return;
      }
      if (state.area === goal.area) { copyMoveResult(result, this.moveInGoalArea(state, goal)); return; }
      let number = state.lastReachability;
      if (number !== 0) {
        const reach = this.reachability(number), type = reach.travelType & TravelType.MASK;
        if ((travelFlagForType(reach.travelType) & travelFlags) === 0) number = 0;
        else if (type === TravelType.GRAPPLEHOOK) {
          if (state.reachabilityTime < f(this.routing.states.host.time()) || (state.moveFlags & BotMoveFlag.GRAPPLERESET) !== 0) number = 0;
        } else if (type === TravelType.ELEVATOR || type === TravelType.FUNCBOB) {
          // Both source operands test FUNCBOB. Elevator is intentionally not included.
          if ((result.flags & BotMoveResultFlag.ONTOPOF_FUNCBOB) !== 0) state.reachabilityTime = f(f(this.routing.states.host.time()) + 5);
          if (state.area === reach.area || state.reachabilityTime < f(this.routing.states.host.time())) number = 0;
        } else {
          if (this.diagnostics?.debug && this.host.developer() && state.reachabilityTime < f(this.routing.states.host.time())) {
            this.routing.states.host.print(1, `client ${state.client}: reachability timeout in `);
            this.diagnostics.printTravelType(reach.travelType & TravelType.MASK);
            this.routing.states.host.print(1, "\n");
          }
          if (state.lastGoalArea !== goal.area || state.reachabilityTime < f(this.routing.states.host.time()) || state.lastArea !== state.area) number = 0;
        }
      }
      let resultFlags = 0;
      if (number === 0) {
        if (this.areaReachability(state.area) === 0 && this.diagnostics?.debug && this.host.developer()) {
          this.routing.states.host.print(1, `area ${state.area} no reachability\n`);
        }
        const selected = this.routing.getReachabilityToGoal({ origin: state.origin, area: state.area,
          lastGoalArea: state.lastGoalArea, lastArea: state.lastArea, avoid: state, goal, travelFlags,
          moveTravelFlags: travelFlags, avoidSpots: state.avoidSpots, numAvoidSpots: state.numAvoidSpots, flags: 0 });
        number = selected.reachability; resultFlags = selected.flags;
        state.reachArea = state.area; state.jumpReach = 0; state.moveFlags &= ~BotMoveFlag.GRAPPLERESET;
        let selectedArea = 0;
        if (number !== 0) {
          const now = f(this.routing.states.host.time());
          const reach = this.reachability(number);
          selectedArea = reach.area;
          state.reachabilityTime = f(now + this.reachabilityTime(reach));
          this.routing.states.addToAvoidReach(state, number, 6);
        }
        if (this.diagnostics?.debug) {
          if (number === 0 && this.host.developer()) this.routing.states.host.print(1, "goal not reachable\n");
          if (this.host.developer() && state.lastGoalArea === goal.area && state.lastArea === selectedArea) {
            this.routing.states.host.print(1, "same goal, going back to previous area\n");
          }
        }
      }
      state.lastReachability = number; state.lastGoalArea = goal.area; state.lastArea = state.area;
      let usedTravelType = 0;
      if (number !== 0) {
        const reach = this.reachability(number); result.travelType = reach.travelType;
        usedTravelType = reach.travelType;
        if (this.diagnostics?.aiMove) {
          this.diagnostics.clearLines();
          this.diagnostics.printTravelType(reach.travelType & TravelType.MASK);
          this.diagnostics.showReachability(reach);
        }
        const moved = yield* this.travel(state, reach, false); if (moved !== null) copyMoveResult(result, moved);
        result.travelType = reach.travelType; result.flags |= resultFlags;
      } else { result.failure = true; result.flags |= resultFlags; }
      if (this.diagnostics?.debug && this.host.developer() && result.failure) {
        this.routing.states.host.print(1, `client ${state.client}: movement failure in `);
        this.diagnostics.printTravelType(usedTravelType & TravelType.MASK);
        this.routing.states.host.print(1, "\n");
      }
    } else {
      let foundJumpPad = false;
      const end = ma(state.origin, f(-2 * state.thinkTime), state.velocity), areas = spatial.traceAreas(state.origin, end, 16);
      for (let index = areas.length - 1; index >= 0; index--) {
        const area = at(areas, index).area, settings = at(spatial.world.areaSettings, area);
        if ((settings.contents & 128) === 0) continue;
        foundJumpPad = true;
        let number = this.routing.getReachabilityToGoal({ origin: end, area, lastGoalArea: state.lastGoalArea,
          lastArea: state.lastArea, avoid: state, goal, travelFlags, moveTravelFlags: TravelFlags.JUMPPAD,
          avoidSpots: state.avoidSpots, numAvoidSpots: state.numAvoidSpots, flags: 0 }).reachability;
        if (number === 0) for (let candidate = this.routing.nextAreaReachability(area, 0); candidate !== 0;
          candidate = this.routing.nextAreaReachability(area, candidate)) {
          if ((this.reachability(candidate).travelType & TravelType.MASK) === TravelType.JUMPPAD) { number = candidate; break; }
        }
        if (number !== 0) { state.lastReachability = number; state.lastArea = area; break; }
      }
      if (this.host.developer() && foundJumpPad && state.lastReachability === 0) this.routing.states.host.print(1, `client ${state.client} didn't find jumppad reachability\n`);
      if (state.lastReachability !== 0) {
        const reach = this.reachability(state.lastReachability); result.travelType = reach.travelType;
        const moved = yield* this.travel(state, reach, true); if (moved !== null) copyMoveResult(result, moved);
        result.travelType = reach.travelType;
        if (this.diagnostics?.debug && this.host.developer() && result.failure) {
          this.routing.states.host.print(1, `client ${state.client}: movement failure in finish `);
          this.diagnostics.printTravelType(reach.travelType & TravelType.MASK);
          this.routing.states.host.print(1, "\n");
        }
      }
    }
    if (result.blocked) state.reachabilityTime = f(state.reachabilityTime - f(10 * state.thinkTime));
    state.lastOrigin = vec3(state.origin.x, state.origin.y, state.origin.z);
  }
}
