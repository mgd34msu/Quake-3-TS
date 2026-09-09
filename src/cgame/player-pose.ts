/*
 * Player pose angles translated from Quake III Arena's cgame/cg_players.c
 * CG_SwingAngles, CG_PlayerAngles and CG_AddPainTwitch.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { PlayerAnimationConfig } from "../assets/animation.ts";
import { CommonError } from "../core/common-error.ts";
import { dot3, length3, normalize3, vec3 } from "../core/math.ts";
import { qvmAngleMod, qvmAnglesToAxis } from "../core/qvm-math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import type { EntityState } from "../shared/entity-state.ts";
import { PlayerAnimation } from "../shared/player-state.ts";
import { ANIMATION_TOGGLE_BIT, createLerpFrame } from "./animation.ts";
import type { LerpFrame } from "./animation.ts";

const PAIN_TWITCH_TIME = 200;
const MAX_CLIENTS = 64;
const DEAD_ENTITY_FLAG = 1;
const MOVEMENT_OFFSETS: readonly number[] = [0, 22, 45, -22, 0, 22, -45, -22];

export interface PoseLerpFrame extends LerpFrame {
  yawAngle: number;
  yawing: boolean;
  pitchAngle: number;
  pitching: boolean;
}

export interface PlayerPoseState {
  readonly legs: PoseLerpFrame;
  readonly torso: PoseLerpFrame;
  painTime: number;
  painDirection: boolean;
}

export interface SwingAnglesInput {
  readonly destination: number;
  readonly swingTolerance: number;
  readonly clampTolerance: number;
  readonly speed: number;
  readonly frameTimeMs: number;
  readonly angle: number;
  readonly swinging: boolean;
}

export interface SwingAnglesResult {
  readonly angle: number;
  readonly swinging: boolean;
}

export interface PainTwitchInput {
  readonly timeMs: number;
  readonly painTime: number;
  readonly painDirection: boolean;
}

export type PoseEntityState = Pick<
  EntityState,
  "eFlags" | "pos" | "angles2" | "clientNum" | "legsAnim" | "torsoAnim"
>;

export interface CalculatePlayerPoseInput {
  readonly entity: PoseEntityState;
  readonly animationConfig: Pick<PlayerAnimationConfig, "fixedLegs" | "fixedTorso">;
  readonly lerpAngles: Vec3;
  readonly timeMs: number;
  readonly frameTimeMs: number;
  readonly swingSpeed: number;
}

export interface PlayerPose {
  readonly legs: Axis;
  readonly torso: Axis;
  readonly head: Axis;
}

function createPoseLerpFrame(): PoseLerpFrame {
  return { ...createLerpFrame(), yawAngle: 0, yawing: false, pitchAngle: 0, pitching: false };
}

export function createPlayerPoseState(): PlayerPoseState {
  return { legs: createPoseLerpFrame(), torso: createPoseLerpFrame(), painTime: 0, painDirection: false };
}

function float32(value: number, name: string): number {
  const result = Math.fround(value);
  if (!Number.isFinite(result)) throw new RangeError(`${name} must be a finite float32 value`);
  return result;
}

function milliseconds(value: number, name: string, allowNegative: boolean): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff || (!allowNegative && value < 0)) {
    throw new RangeError(`${name} must be ${allowNegative ? "an int32" : "a non-negative int32"} millisecond value`);
  }
  return value;
}

function angleSubtract(first: number, second: number): number {
  let angle = Math.fround(first - second);
  while (angle > 180) angle = Math.fround(angle - 360);
  while (angle < -180) angle = Math.fround(angle + 360);
  return angle;
}

function sourceAngleMod(angle: number): number {
  return qvmAngleMod(angle);
}

/** Swing one float32 angle toward its destination using the current cgame frame time. */
export function swingAngles(input: SwingAnglesInput): SwingAnglesResult {
  const destination = float32(input.destination, "swing destination");
  const swingTolerance = float32(input.swingTolerance, "swing tolerance");
  const clampTolerance = float32(input.clampTolerance, "clamp tolerance");
  const speed = float32(input.speed, "swing speed");
  const frameTimeMs = milliseconds(input.frameTimeMs, "frame time", false);
  let angle = float32(input.angle, "swing angle");
  let swinging = input.swinging;
  if (swingTolerance < 0 || clampTolerance < 1 || speed < 0) {
    throw new RangeError("swing tolerances and speed are outside source ranges");
  }
  if (!swinging) {
    const swing = angleSubtract(angle, destination);
    if (swing > swingTolerance || swing < -swingTolerance) swinging = true;
  }
  if (!swinging) return { angle, swinging };

  let swing = angleSubtract(destination, angle);
  const distance = Math.abs(swing);
  const scale = distance < Math.fround(swingTolerance * 0.5) ? 0.5 : distance < swingTolerance ? 1 : 2;
  if (swing >= 0) {
    let move = Math.fround(Math.fround(frameTimeMs * scale) * speed);
    if (move >= swing) {
      move = swing;
      swinging = false;
    }
    angle = sourceAngleMod(Math.fround(angle + move));
  } else {
    let move = Math.fround(Math.fround(frameTimeMs * scale) * Math.fround(-speed));
    if (move <= swing) {
      move = swing;
      swinging = false;
    }
    angle = sourceAngleMod(Math.fround(angle + move));
  }

  swing = angleSubtract(destination, angle);
  if (swing > clampTolerance) angle = sourceAngleMod(Math.fround(destination - Math.fround(clampTolerance - 1)));
  else if (swing < -clampTolerance) angle = sourceAngleMod(Math.fround(destination + Math.fround(clampTolerance - 1)));
  return { angle, swinging };
}

/** Add the decaying 200ms pain roll to a torso angle vector. */
export function addPainTwitch(torsoAngles: Vec3, input: PainTwitchInput): Vec3 {
  const timeMs = milliseconds(input.timeMs, "pose time", true);
  const painTime = milliseconds(input.painTime, "pain time", true);
  const elapsed = (timeMs - painTime) | 0;
  if (elapsed >= PAIN_TWITCH_TIME) return vec3(torsoAngles.x, torsoAngles.y, torsoAngles.z);
  const fraction = Math.fround(1 - Math.fround(Math.fround(elapsed) / PAIN_TWITCH_TIME));
  const roll = Math.fround(20 * fraction);
  return vec3(torsoAngles.x, torsoAngles.y, input.painDirection ? torsoAngles.z + roll : torsoAngles.z - roll);
}

function subtractAngles(first: Vec3, second: Vec3): Vec3 {
  return vec3(
    angleSubtract(first.x, second.x),
    angleSubtract(first.y, second.y),
    angleSubtract(first.z, second.z),
  );
}

function movementOffset(entity: PoseEntityState): number {
  if ((entity.eFlags & DEAD_ENTITY_FLAG) !== 0) return 0;
  const direction = qvmFloatToInt(entity.angles2.y);
  if (direction < 0 || direction >= MOVEMENT_OFFSETS.length) {
    throw new CommonError("drop", "Bad player movement angle");
  }
  const offset = MOVEMENT_OFFSETS[direction];
  if (offset === undefined) throw new RangeError(`missing player movement offset ${direction}`);
  return offset;
}

function updateYaw(state: PoseLerpFrame, destination: number, tolerance: number, input: CalculatePlayerPoseInput): number {
  const result = swingAngles({
    destination,
    swingTolerance: tolerance,
    clampTolerance: 90,
    speed: input.swingSpeed,
    frameTimeMs: input.frameTimeMs,
    angle: state.yawAngle,
    swinging: state.yawing,
  });
  state.yawAngle = result.angle;
  state.yawing = result.swinging;
  return result.angle;
}

/** Compute hierarchical legs, torso and head axes while updating owned swing state. */
export function calculatePlayerPose(state: PlayerPoseState, input: CalculatePlayerPoseInput): PlayerPose {
  milliseconds(input.timeMs, "pose time", true);
  milliseconds(input.frameTimeMs, "frame time", false);
  const swingSpeed = float32(input.swingSpeed, "swing speed");
  if (swingSpeed < 0) throw new RangeError("swing speed must be non-negative");
  const headAngles = vec3(input.lerpAngles.x, sourceAngleMod(input.lerpAngles.y), input.lerpAngles.z);
  let legsAngles = vec3(0, 0, 0);
  let torsoAngles = vec3(0, 0, 0);

  if ((input.entity.legsAnim & ~ANIMATION_TOGGLE_BIT) !== PlayerAnimation.LEGS_IDLE
    || (input.entity.torsoAnim & ~ANIMATION_TOGGLE_BIT) !== PlayerAnimation.TORSO_STAND) {
    state.torso.yawing = true;
    state.torso.pitching = true;
    state.legs.yawing = true;
  }

  const offset = movementOffset(input.entity);
  const legsDestination = Math.fround(headAngles.y + offset);
  const torsoDestination = Math.fround(headAngles.y + Math.fround(0.25 * offset));
  const torsoYaw = updateYaw(state.torso, torsoDestination, 25, input);
  const legsYaw = updateYaw(state.legs, legsDestination, 40, input);
  torsoAngles = vec3(0, torsoYaw, 0);
  legsAngles = vec3(0, legsYaw, 0);

  const pitchDestination = headAngles.x > 180
    ? Math.fround(Math.fround(-360 + headAngles.x) * 0.75)
    : Math.fround(headAngles.x * 0.75);
  const pitch = swingAngles({
    destination: pitchDestination,
    swingTolerance: 15,
    clampTolerance: 30,
    speed: 0.1,
    frameTimeMs: input.frameTimeMs,
    angle: state.torso.pitchAngle,
    swinging: state.torso.pitching,
  });
  state.torso.pitchAngle = pitch.angle;
  state.torso.pitching = pitch.swinging;
  torsoAngles = vec3(pitch.angle, torsoAngles.y, torsoAngles.z);

  const clientHasConfig = input.entity.clientNum >= 0 && input.entity.clientNum < MAX_CLIENTS;
  if (clientHasConfig && input.animationConfig.fixedTorso) torsoAngles = vec3(0, torsoAngles.y, torsoAngles.z);

  const speed = length3(input.entity.pos.delta);
  if (speed !== 0) {
    const velocity = normalize3(input.entity.pos.delta);
    const leanSpeed = Math.fround(speed * Math.fround(0.05));
    const legsAxis = qvmAnglesToAxis(legsAngles);
    const side = Math.fround(leanSpeed * dot3(velocity, legsAxis[1]));
    const forward = Math.fround(leanSpeed * dot3(velocity, legsAxis[0]));
    legsAngles = vec3(legsAngles.x + forward, legsAngles.y, legsAngles.z - side);
  }

  if (clientHasConfig && input.animationConfig.fixedLegs) legsAngles = vec3(0, torsoAngles.y, 0);
  torsoAngles = addPainTwitch(torsoAngles, {
    timeMs: input.timeMs,
    painTime: state.painTime,
    painDirection: state.painDirection,
  });
  const headLocal = subtractAngles(headAngles, torsoAngles);
  const torsoLocal = subtractAngles(torsoAngles, legsAngles);
  return {
    legs: qvmAnglesToAxis(legsAngles),
    torso: qvmAnglesToAxis(torsoLocal),
    head: qvmAnglesToAxis(headLocal),
  };
}
