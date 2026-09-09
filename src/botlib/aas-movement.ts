/* Movement prediction from id Software's code/botlib/be_aas_move.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 * Botlib uses native float expressions, including double unsuffixed literals. */
import type { Bounds, Vec3 } from "../core/math.ts";
import { add3, angleVectors, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { AasReachability, AasWorld } from "./aas.ts";
import type { AasAreaCrossing, AasSpatialHost, AasTrace } from "./spatial.ts";

/** The source static aassettings record survives AAS world replacement and shutdown. */
export class AasMovementSettings {
  gravityDirection: Vec3 = vec3(0, 0, 0);
  friction = 0; stopSpeed = 0; gravity = 0; waterFriction = 0; waterGravity = 0;
  maxVelocity = 0; maxWalkVelocity = 0; maxCrouchVelocity = 0; maxSwimVelocity = 0;
  walkAccelerate = 0; airAccelerate = 0; swimAccelerate = 0;
  maxStep = 0; maxSteepness = 0; maxWaterJump = 0; maxBarrier = 0;
  jumpVelocity = 0; fallDelta5 = 0; fallDelta10 = 0;
  waterJumpTime = 0; teleportTime = 0; barrierJumpTime = 0; startCrouchTime = 0;
  startGrappleTime = 0; startWalkOffLedgeTime = 0; startJumpTime = 0;
  rocketJumpTime = 0; bfgJumpTime = 0; jumpPadTime = 0; airControlledJumpPadTime = 0;
  funcBobTime = 0; startElevatorTime = 0; fallDamage5Time = 0; fallDamage10Time = 0;
  maxFallHeight = 0; maxJumpFallHeight = 0;
}
export type AasLibVarValue = (name: string, defaultValue: string) => number;
/** AAS_InitSettings reads LibVarValue once, in source order; later cvar writes need another init. */
export function initAasMovementSettings(value: AasLibVarValue, settings: AasMovementSettings = new AasMovementSettings()): AasMovementSettings {
  const read = (name: string, initial: string) => Math.fround(value(name, initial));
  settings.gravityDirection = vec3(0, 0, -1);
  settings.friction = read("phys_friction", "6"); settings.stopSpeed = read("phys_stopspeed", "100"); settings.gravity = read("phys_gravity", "800");
  settings.waterFriction = read("phys_waterfriction", "1"); settings.waterGravity = read("phys_watergravity", "400");
  settings.maxVelocity = read("phys_maxvelocity", "320"); settings.maxWalkVelocity = read("phys_maxwalkvelocity", "320");
  settings.maxCrouchVelocity = read("phys_maxcrouchvelocity", "100"); settings.maxSwimVelocity = read("phys_maxswimvelocity", "150");
  settings.walkAccelerate = read("phys_walkaccelerate", "10"); settings.airAccelerate = read("phys_airaccelerate", "1"); settings.swimAccelerate = read("phys_swimaccelerate", "4");
  settings.maxStep = read("phys_maxstep", "19"); settings.maxSteepness = read("phys_maxsteepness", "0.7"); settings.maxWaterJump = read("phys_maxwaterjump", "18");
  settings.maxBarrier = read("phys_maxbarrier", "33"); settings.jumpVelocity = read("phys_jumpvel", "270");
  settings.fallDelta5 = read("phys_falldelta5", "40"); settings.fallDelta10 = read("phys_falldelta10", "60");
  settings.waterJumpTime = read("rs_waterjump", "400"); settings.teleportTime = read("rs_teleport", "50"); settings.barrierJumpTime = read("rs_barrierjump", "100");
  settings.startCrouchTime = read("rs_startcrouch", "300"); settings.startGrappleTime = read("rs_startgrapple", "500");
  settings.startWalkOffLedgeTime = read("rs_startwalkoffledge", "70"); settings.startJumpTime = read("rs_startjump", "300");
  settings.rocketJumpTime = read("rs_rocketjump", "500"); settings.bfgJumpTime = read("rs_bfgjump", "500"); settings.jumpPadTime = read("rs_jumppad", "250");
  settings.airControlledJumpPadTime = read("rs_aircontrolledjumppad", "300"); settings.funcBobTime = read("rs_funcbob", "300");
  settings.startElevatorTime = read("rs_startelevator", "50"); settings.fallDamage5Time = read("rs_falldamage5", "300");
  settings.fallDamage10Time = read("rs_falldamage10", "500"); settings.maxFallHeight = read("rs_maxfallheight", "0"); settings.maxJumpFallHeight = read("rs_maxjumpfallheight", "450");
  return settings;
}
/** Source initial values for controlled fixtures; production calls init with the actual LibVar owner. */
export const DEFAULT_AAS_MOVEMENT_SETTINGS: Readonly<AasMovementSettings> = Object.freeze({ ...initAasMovementSettings((_name, initial) => Number(initial)) });
export enum AasStopEvent {
  NONE = 0, HIT_GROUND = 1, LEAVE_GROUND = 2, ENTER_WATER = 4, ENTER_SLIME = 8, ENTER_LAVA = 16,
  HIT_GROUND_DAMAGE = 32, GAP = 64, TOUCH_JUMP_PAD = 128, TOUCH_TELEPORTER = 256,
  ENTER_AREA = 512, HIT_GROUND_AREA = 1024, HIT_BOUNDING_BOX = 2048, TOUCH_CLUSTER_PORTAL = 4096,
}
export interface AasMovementQueries {
  readonly world: AasWorld;
  readonly host: Pick<AasSpatialHost, "trace" | "pointContents">;
  pointArea(origin: Vec3): number;
  pointPresenceType(origin: Vec3): number;
  presenceBounds(presence: number): Bounds;
  traceClientBBox(start: Vec3, end: Vec3, presence: number, passEntity: number): AasTrace;
  traceAreas(start: Vec3, end: Vec3, maximum: number): readonly AasAreaCrossing[];
  pointInsideFace(face: number, point: Vec3, epsilon: number): boolean;
}
export type AasMovementDebug = { readonly kind: "disabled" } | {
  readonly kind: "enabled";
  line(start: Vec3, end: Vec3, color: "red" | "blue"): void;
  print(message: string): void;
  clearLines(): void;
};
export interface AasClientMove {
  readonly end: Vec3; readonly endArea: number; readonly velocity: Vec3; readonly trace: AasTrace;
  readonly presence: number; readonly stopEvent: number; readonly endContents: number;
  readonly time: number; readonly frames: number;
}
export type AasClientMoveOutput = { -readonly [Field in keyof AasClientMove]: AasClientMove[Field] }
  & { clear(): undefined };
export interface AasMovementRequest {
  readonly entityNum: number; readonly origin: Vec3; readonly presence: number; readonly onGround: boolean;
  readonly velocity: Vec3; readonly commandMove: Vec3; readonly commandFrames: number;
  readonly maxFrames: number; readonly frameTime: number; readonly visualize: boolean;
}
export interface AasPredictionRequest extends AasMovementRequest { readonly stopEvents: number; readonly stopArea: number }
export interface AasMovementPrediction { readonly success: boolean; readonly move: AasClientMove }
const f = Math.fround, ZERO = vec3(0, 0, 0), axes: readonly (keyof Vec3)[] = ["x", "y", "z"];
function at<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`AAS movement index ${index} outside ${values.length}`); return value; }
function ma(start: Vec3, amount: number, direction: Vec3): Vec3 { return add3(start, scale3(direction, amount)); }
// VectorMA(v, -DotProduct(v, normal), normal, v) reevaluates the dot after each component write.
function projectSourceMacro(velocity: Vec3, normal: Vec3): Vec3 {
  let result = vec3(velocity.x, velocity.y, velocity.z);
  for (const axis of axes) result = { ...result, [axis]: f(result[axis] + f(normal[axis] * -dot3(result, normal))) };
  return result;
}
function finite(value: Vec3): void { if (![value.x, value.y, value.z].every(n => Number.isFinite(f(n)))) throw new RangeError("AAS movement requires finite float32 vectors"); }
function integer(value: number): void { if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("AAS movement requires signed 32-bit integers"); }
function zeroTrace(): AasTrace { return { startSolid: false, fraction: 0, end: vec3(0, 0, 0), entityNum: 0, lastArea: 0, area: 0, plane: 0 }; }
function zeroMove(): AasClientMove { return { end: vec3(0, 0, 0), endArea: 0, velocity: vec3(0, 0, 0), trace: zeroTrace(), presence: 0, stopEvent: 0, endContents: 0, time: 0, frames: 0 }; }

export function aasSwimming(origin: Vec3, pointContents: AasSpatialHost["pointContents"]): boolean {
  return (pointContents(vec3(origin.x, origin.y, origin.z - 2)) & 56) !== 0;
}

/** Pure return value replaces the source's explicit output-vector mutation. */
export function aasAccelerate(velocity: Vec3, frameTime: number, wishDirection: Vec3, wishSpeed: number, acceleration: number): Vec3 {
  const addSpeed = f(wishSpeed - dot3(velocity, wishDirection));
  if (addSpeed <= 0) return vec3(velocity.x, velocity.y, velocity.z);
  return ma(velocity, Math.min(f(f(acceleration * frameTime) * wishSpeed), addSpeed), wishDirection);
}
export function aasApplyFriction(velocity: Vec3, friction: number, stopSpeed: number, frameTime: number): Vec3 {
  const speed = f(Math.sqrt(f(f(velocity.x * velocity.x) + f(velocity.y * velocity.y))));
  if (speed === 0) return vec3(velocity.x, velocity.y, velocity.z);
  const control = speed < stopSpeed ? stopSpeed : speed;
  const scale = f(Math.max(0, f(speed - f(f(frameTime * control) * friction))) / speed);
  return vec3(f(velocity.x * scale), f(velocity.y * scale), velocity.z);
}
/** The original AAS_AirControl computes an unused local direction and changes no output. */
export function aasAirControl(_start: Vec3, _end: Vec3, _velocity: Vec3, _commandMove: Vec3): void {}
export function aasSetMoveDirection(angles: Vec3): Vec3 {
  if (angles.x === 0 && angles.z === 0 && angles.y === -1) return vec3(0, 0, 1);
  if (angles.x === 0 && angles.z === 0 && angles.y === -2) return vec3(0, 0, -1);
  return angleVectors(angles).forward;
}

export class AasMovement {
  readonly settings: AasMovementSettings;
  constructor(readonly queries: AasMovementQueries, settings: Readonly<AasMovementSettings>, readonly debug: AasMovementDebug) {
    this.settings = settings instanceof AasMovementSettings ? settings
      : { ...settings, gravityDirection: vec3(settings.gravityDirection.x, settings.gravityDirection.y, settings.gravityDirection.z) };
  }
  initSettings(value: AasLibVarValue): void { initAasMovementSettings(value, this.settings); }
  dropToFloor(origin: Vec3, bounds: Bounds): { readonly success: boolean; readonly origin: Vec3 } {
    const trace = this.queries.host.trace(origin, vec3(origin.x, origin.y, origin.z - 100), bounds, 0, 1);
    return trace.solidity === "clear" ? { success: true, origin: trace.end } : { success: false, origin };
  }
  swimming(origin: Vec3): boolean { return aasSwimming(origin, point => this.queries.host.pointContents(point)); }
  onGround(origin: Vec3, presence: number, passEntity: number): boolean {
    const trace = this.queries.traceClientBBox(origin, vec3(origin.x, origin.y, origin.z - 10), presence, passEntity);
    return !trace.startSolid && trace.fraction < 1 && f(origin.z - trace.end.z) <= 10
      && at(this.queries.world.planes, trace.plane).normal.z >= this.settings.maxSteepness;
  }
  againstLadder(origin: Vec3): boolean {
    const world = this.queries.world;
    let point = origin, area = world.pointArea(point);
    if (area === 0) { point = vec3(point.x + 1, point.y, point.z); area = world.pointArea(point); }
    if (area === 0) { point = vec3(point.x, point.y + 1, point.z); area = world.pointArea(point); }
    if (area === 0) { point = vec3(point.x - 2, point.y, point.z); area = world.pointArea(point); }
    if (area === 0) { point = vec3(point.x, point.y - 2, point.z); area = world.pointArea(point); }
    if (area === 0) return false;
    const settings = at(world.areaSettings, area), record = at(world.areas, area);
    if ((settings.flags & 2) === 0 || (settings.presenceType & 2) === 0) return false;
    for (let i = 0; i < record.faceCount; i++) {
      const faceNumber = at(world.faceIndexes, record.firstFace + i), face = at(world.faces, Math.abs(faceNumber));
      if ((face.flags & 2) === 0) continue;
      const plane = at(world.planes, face.plane ^ (faceNumber < 0 ? 1 : 0));
      const distance = Math.trunc(f(dot3(plane.normal, origin) - plane.distance));
      integer(distance); // Source calls integer abs, not fabs, on this float expression.
      if (Math.abs(distance) < 3 && this.queries.pointInsideFace(Math.abs(faceNumber), origin, f(0.1))) return true;
    }
    return false;
  }
  weaponJumpZVelocity(origin: Vec3, radiusDamage: number): number {
    const { forward, right } = angleVectors(vec3(90, 0, 0));
    const start = vec3(f(origin.x + f(f(forward.x * 8) + f(right.x * 8))),
      f(origin.y + f(f(forward.y * 8) + f(right.y * 8))), f(f(origin.z + 8) + f(f(f(forward.z * 8) + f(right.z * 8)) - 8)));
    const trace = this.queries.host.trace(start, ma(start, 500, forward), null, 1, 1);
    const distance = length3(sub3(trace.end, vec3(origin.x, origin.y, origin.z + 4)));
    const points = f(Math.max(0, f(radiusDamage - 0.5 * distance)) * 0.5);
    const direction = normalize3(sub3(origin, trace.end)), multiplier = 1600 * points / 200;
    return f(f(direction.z * multiplier) + this.settings.jumpVelocity);
  }
  rocketJumpZVelocity(origin: Vec3): number { return this.weaponJumpZVelocity(origin, 120); }
  bfgJumpZVelocity(origin: Vec3): number { return this.weaponJumpZVelocity(origin, 120); }
  horizontalVelocityForJump(zVelocity: number, start: Vec3, end: Vec3): { readonly success: boolean; readonly velocity: number } {
    const gravity = this.settings.gravity, maximum = this.settings.maxVelocity, ascent = f(zVelocity / gravity);
    const maximumJump = f(0.5 * gravity * ascent * ascent), height = f(f(start.z + maximumJump) - end.z);
    if (height < 0) return { success: false, velocity: maximum };
    const time = f(Math.sqrt(height / (0.5 * gravity))), denominator = f(time + ascent);
    if (denominator === 0) return { success: false, velocity: maximum };
    const direction = sub3(end, start), speed = f(Math.sqrt(f(f(direction.x * direction.x) + f(direction.y * direction.y))) / denominator);
    return speed > maximum ? { success: false, velocity: maximum } : { success: true, velocity: speed };
  }
  clipToBBox(trace: AasTrace, start: Vec3, end: Vec3, presence: number, bounds: Bounds): { readonly hit: boolean; readonly trace: AasTrace } {
    const client = this.queries.presenceBounds(presence), minimum = sub3(bounds.min, client.max), maximum = sub3(bounds.max, client.min);
    const missed = { ...trace, end, fraction: 1 };
    for (const axis of axes) if ((start[axis] < minimum[axis] && end[axis] < minimum[axis]) || (start[axis] > maximum[axis] && end[axis] > maximum[axis])) return { hit: false, trace: missed };
    const direction = sub3(end, start);
    for (const [index, axis] of axes.entries()) {
      const distance = direction[axis] > 0 ? minimum[axis] : maximum[axis], front = f(start[axis] - distance), back = f(end[axis] - distance);
      const fraction = f(front / f(front - back)), next = at(axes, (index + 1) % 3), last = at(axes, (index + 2) % 3);
      const a = f(start[next] + f(direction[next] * fraction)), b = f(start[last] + f(direction[last] * fraction));
      if (a > minimum[next] && a < maximum[next] && b > minimum[last] && b < maximum[last]) return {
        hit: true, trace: { startSolid: false, fraction, end: ma(start, fraction, direction), entityNum: 0, plane: 0, area: 0, lastArea: 0 },
      };
    }
    return { hit: false, trace: missed };
  }
  predictClientMovement(request: AasPredictionRequest, output?: AasClientMoveOutput): AasMovementPrediction {
    return this.clientMovementPrediction(request, null, output);
  }
  clientMovementHitBBox(request: AasMovementRequest, bounds: Bounds): AasMovementPrediction {
    return this.clientMovementPrediction({ ...request, stopEvents: AasStopEvent.HIT_BOUNDING_BOX, stopArea: 0 }, bounds);
  }
  clientMovementPrediction(request: AasPredictionRequest, bounds: Bounds | null, output?: AasClientMoveOutput): AasMovementPrediction {
    for (const value of [request.entityNum, request.commandFrames, request.maxFrames, request.stopEvents, request.stopArea]) integer(value);
    const settings = { ...this.settings }, storedFrameTime = f(request.frameTime);
    const dt = storedFrameTime <= 0 ? f(0.1) : storedFrameTime, inverseTime = f(1 / dt);
    if (!Number.isFinite(dt)) throw new RangeError("Invalid AAS frame time");
    output?.clear();
    finite(request.origin); finite(request.velocity);
    let origin = vec3(request.origin.x, request.origin.y, request.origin.z + 0.25), velocity = scale3(request.velocity, dt);
    let onGround = request.onGround, presence = request.presence, jumpFrame = -1, trace = zeroTrace();
    const stop = (end: Vec3, event: number, frame: number, storedTrace = trace, contents = 0, scaled = true, area: number | null = null): AasMovementPrediction => {
      if (output !== undefined) output.end = end;
      const endVelocity = scaled ? scale3(velocity, inverseTime) : velocity;
      if (output !== undefined && (event === 512 || event === 128)) output.velocity = endVelocity;
      const endArea = area === null ? this.queries.pointArea(end) : area;
      const move: AasClientMove = { end, endArea, velocity: endVelocity, trace: storedTrace,
        presence, stopEvent: event, endContents: contents, time: f(frame * dt), frames: frame };
      if (output !== undefined) {
        output.endArea = endArea;
        if (event !== 512 && event !== 128) output.velocity = endVelocity;
        if (event !== 0 && (event & (4 | 8 | 16)) === 0) output.trace = storedTrace;
        output.stopEvent = event;
        output.presence = presence;
        output.endContents = contents;
        output.time = move.time;
        output.frames = frame;
      }
      return { success: true, move };
    };
    let frame = 0;
    for (; frame < request.maxFrames; frame++) {
      const swimming = this.swimming(origin), gravity = swimming ? settings.waterGravity : settings.gravity;
      velocity = vec3(velocity.x, velocity.y, velocity.z - gravity * 0.1 * dt);
      if (onGround || swimming) velocity = scale3(aasApplyFriction(scale3(velocity, inverseTime), swimming ? settings.friction : settings.waterFriction, settings.stopSpeed, dt), dt);
      let crouch = false;
      if (frame < request.commandFrames) {
        finite(request.commandMove);
        let maximum = settings.maxWalkVelocity, acceleration = settings.airAccelerate, wish = request.commandMove;
        if (onGround) {
          if (wish.z < -300) { crouch = true; maximum = settings.maxCrouchVelocity; }
          if (!swimming && wish.z > 1) { velocity = vec3(velocity.x, velocity.y, f(settings.jumpVelocity * dt) - gravity * 0.1 * dt + 5); jumpFrame = frame; }
          else acceleration = settings.walkAccelerate;
        }
        if (swimming) { maximum = settings.maxSwimVelocity; acceleration = settings.swimAccelerate; }
        else wish = vec3(wish.x, wish.y, 0);
        const speed = Math.min(length3(wish), maximum), direction = normalize3(wish);
        velocity = scale3(aasAccelerate(scale3(velocity, inverseTime), dt, direction, speed, acceleration), dt);
      }
      if (crouch) presence = 4;
      else if (presence === 4 && (this.queries.pointPresenceType(origin) & 2) !== 0) presence = 2;
      const lastOrigin = origin;
      let remaining = velocity, collisions = 0;
      do {
        const end = add3(origin, remaining);
        trace = this.queries.traceClientBBox(origin, end, presence, request.entityNum);
        if (request.visualize && this.debug.kind === "disabled") throw new Error("AAS movement visualization requires actual debug imports");
        if (request.visualize && this.debug.kind === "enabled") { if (trace.startSolid) this.debug.print("PredictMovement: start solid\n"); this.debug.line(origin, trace.end, "red"); }
        if ((request.stopEvents & (512 | 128 | 256 | 4096)) !== 0) for (const crossing of this.queries.traceAreas(origin, trace.end, 20)) {
          const contents = at(this.queries.world.areaSettings, crossing.area).contents;
          if ((request.stopEvents & 512) !== 0 && crossing.area === request.stopArea) return stop(crossing.point, 512, frame, trace, 0, true, crossing.area);
          if ((request.stopEvents & 128) !== 0 && frame !== 0 && (contents & 128) !== 0) return stop(crossing.point, 128, frame, trace, 0, true, crossing.area);
          if ((request.stopEvents & 256) !== 0 && (contents & 64) !== 0) return stop(crossing.point, 256, frame, trace, 0, true, crossing.area);
          if ((request.stopEvents & 4096) !== 0 && (contents & 8) !== 0) return stop(crossing.point, 4096, frame, trace, 0, true, crossing.area);
        }
        if ((request.stopEvents & 2048) !== 0) {
          if (bounds === null) throw new Error("AAS_PredictClientMovement has no initialized bounding box; use clientMovementHitBBox");
          const clipped = this.clipToBBox(trace, origin, trace.end, presence, bounds); trace = clipped.trace;
          if (clipped.hit) return stop(trace.end, 2048, frame);
        }
        origin = trace.end;
        if (trace.fraction < 1) {
          const plane = at(this.queries.world.planes, trace.plane);
          if ((request.stopEvents & 1024) !== 0 && plane.normal.z > settings.maxSteepness) {
            const start = vec3(origin.x, origin.y, origin.z + 0.5);
            if (this.queries.pointArea(start) === request.stopArea) return stop(start, 1024, frame, trace, 0, true, request.stopArea);
          }
          let stepped = false;
          if (plane.normal.z === 0 && (jumpFrame < 0 || frame - jumpFrame > 2)) {
            const stepEnd = ma(origin, -0.25, plane.normal), start = vec3(stepEnd.x, stepEnd.y, stepEnd.z + settings.maxStep);
            const stepTrace = this.queries.traceClientBBox(start, stepEnd, presence, request.entityNum);
            if (!stepTrace.startSolid && at(this.queries.world.planes, stepTrace.plane).normal.z > settings.maxSteepness) {
              const left = sub3(end, stepTrace.end); remaining = vec3(left.x, left.y, 0); velocity = vec3(velocity.x, velocity.y, 0);
              if (request.visualize && this.debug.kind === "enabled" && f(stepTrace.end.z - origin.z) > 0.125) this.debug.line(origin, vec3(origin.x, origin.y, stepTrace.end.z), "blue");
              origin = vec3(origin.x, origin.y, stepTrace.end.z); stepped = true;
            }
          }
          if (!stepped) {
            remaining = projectSourceMacro(remaining, plane.normal);
            const oldVelocity = velocity; velocity = projectSourceMacro(velocity, plane.normal);
            if (plane.normal.z > settings.maxSteepness) onGround = true;
            if ((request.stopEvents & 32) !== 0) {
              let delta = oldVelocity.z < 0 && velocity.z > oldVelocity.z && !onGround ? oldVelocity.z : onGround ? f(velocity.z - oldVelocity.z) : 0;
              if (delta !== 0) { delta = f(delta * 10); delta = f(f(delta * delta) * 0.0001); if (swimming) delta = 0; }
              if (delta > 40) return stop(origin, 32, frame, trace, 0, false);
            }
          }
        }
        if (++collisions > 20) return { success: false, move: zeroMove() };
      } while (trace.fraction < 1);
      if (velocity.z <= 10) {
        const contents = this.queries.host.pointContents(vec3(origin.x, origin.y, origin.z - 22));
        const area = this.queries.pointArea(origin), areaContents = at(this.queries.world.areaSettings, area).contents;
        let event = ((contents & 8) !== 0 || (areaContents & 2) !== 0 ? 16 : 0)
          | ((contents & 16) !== 0 || (areaContents & 4) !== 0 ? 8 : 0) | ((contents & 32) !== 0 || (areaContents & 1) !== 0 ? 4 : 0);
        event &= request.stopEvents;
        if (event !== 0) return stop(origin, event, frame, zeroTrace(), contents, true, area);
      }
      onGround = this.onGround(origin, presence, request.entityNum);
      if (onGround) { if ((request.stopEvents & 1) !== 0) return stop(origin, 1, frame); }
      else if ((request.stopEvents & 2) !== 0) return stop(origin, 2, frame);
      else if ((request.stopEvents & 64) !== 0) {
        const end = vec3(origin.x, origin.y, origin.z - f(48 + this.settings.maxBarrier));
        const gap = this.queries.traceClientBBox(origin, end, 4, -1);
        if (!gap.startSolid && gap.end.z < f(f(origin.z - this.settings.maxStep) - 1) && (this.queries.host.pointContents(end) & 32) === 0) return stop(lastOrigin, 64, frame);
      }
    }
    return stop(origin, 0, frame, zeroTrace());
  }
  jumpReachRunStart(reach: Pick<AasReachability, "start" | "end">): Vec3 {
    const direction = normalize3(vec3(f(reach.start.x - reach.end.x), f(reach.start.y - reach.end.y), 0));
    const start = vec3(reach.start.x, reach.start.y, reach.start.z + 1);
    const result = this.predictClientMovement({ entityNum: -1, origin: start, presence: 2, onGround: true,
      velocity: ZERO, commandMove: scale3(direction, 400), commandFrames: 1, maxFrames: 2, frameTime: f(0.1),
      stopEvents: 4 | 8 | 16 | 32 | 64, stopArea: 0, visualize: false });
    return (result.move.stopEvent & (8 | 16 | 32)) !== 0 ? start : result.move.end;
  }
  testMovementPrediction(entityNum: number, origin: Vec3, direction: Vec3): { readonly direction: Vec3; readonly prediction: AasMovementPrediction } {
    if (this.debug.kind === "disabled") throw new Error("AAS test prediction requires actual debug imports");
    const normalized = normalize3(this.swimming(origin) ? direction : vec3(direction.x, direction.y, 0)), command = scale3(normalized, 400);
    this.debug.clearLines();
    const prediction = this.predictClientMovement({ entityNum, origin, presence: 2, onGround: true, velocity: ZERO,
      commandMove: vec3(command.x, command.y, 224), commandFrames: 13, maxFrames: 13, frameTime: f(0.1), stopEvents: 1, stopArea: 0, visualize: true });
    if ((prediction.move.stopEvent & 2) !== 0) this.debug.print("leave ground\n");
    return { direction: normalized, prediction };
  }
}
