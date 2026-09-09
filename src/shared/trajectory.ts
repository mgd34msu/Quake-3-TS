// Ported from id Software's code/game/bg_misc.c, BG_EvaluateTrajectory/Delta,
// and code/game/q_shared.h, trType_t. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.

import { add3, scale3, vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec3 } from "../core/math.ts";
import { DEFAULT_GRAVITY } from "./definitions.ts";

export enum TrajectoryType {
  TR_STATIONARY = 0,
  TR_INTERPOLATE = 1,
  TR_LINEAR = 2,
  TR_LINEAR_STOP = 3,
  TR_SINE = 4,
  TR_GRAVITY = 5,
}

export interface Trajectory<T extends number = TrajectoryType> {
  readonly type: T;
  readonly time: number;
  readonly duration: number;
  readonly base: Vec3;
  readonly delta: Vec3;
}

// The game/cgame QVM converts integers and every arithmetic result to binary32.
function seconds(milliseconds: number): number {
  return Math.fround(Math.fround(milliseconds) * Math.fround(0.001));
}

function periodicRadians(tr: Trajectory<number>, atTime: number): number {
  const fraction = Math.fround(Math.fround((atTime - tr.time) | 0) / Math.fround(tr.duration));
  return Math.fround(Math.fround(fraction * Math.fround(Math.PI)) * 2);
}

export function evaluateTrajectory(tr: Trajectory<number>, atTime: number): Vec3 {
  switch (tr.type) {
    case TrajectoryType.TR_STATIONARY:
    case TrajectoryType.TR_INTERPOLATE:
      return vec3(tr.base.x, tr.base.y, tr.base.z);
    case TrajectoryType.TR_LINEAR: {
      const deltaTime = seconds((atTime - tr.time) | 0);
      return add3(tr.base, scale3(tr.delta, deltaTime));
    }
    case TrajectoryType.TR_SINE: {
      const phase = Math.fround(Math.sin(periodicRadians(tr, atTime)));
      return add3(tr.base, scale3(tr.delta, phase));
    }
    case TrajectoryType.TR_LINEAR_STOP: {
      const end = (tr.time + tr.duration) | 0;
      const time = atTime > end ? end : atTime;
      const deltaTime = Math.max(0, seconds((time - tr.time) | 0));
      return add3(tr.base, scale3(tr.delta, deltaTime));
    }
    case TrajectoryType.TR_GRAVITY: {
      const deltaTime = seconds((atTime - tr.time) | 0);
      const result = add3(tr.base, scale3(tr.delta, deltaTime));
      const fall = Math.fround(Math.fround(0.5 * DEFAULT_GRAVITY * deltaTime) * deltaTime);
      return vec3(result.x, result.y, result.z - fall);
    }
    default:
      throw new CommonError("drop", `BG_EvaluateTrajectory: unknown trType: ${tr.time}`);
  }
}

export function evaluateTrajectoryDelta(tr: Trajectory<number>, atTime: number): Vec3 {
  switch (tr.type) {
    case TrajectoryType.TR_STATIONARY:
    case TrajectoryType.TR_INTERPOLATE:
      return vec3(0, 0, 0);
    case TrajectoryType.TR_LINEAR:
      return vec3(tr.delta.x, tr.delta.y, tr.delta.z);
    case TrajectoryType.TR_SINE: {
      // The source uses a half-amplitude cosine, independent of duration.
      const phase = Math.fround(Math.fround(Math.cos(periodicRadians(tr, atTime))) * 0.5);
      return scale3(tr.delta, phase);
    }
    case TrajectoryType.TR_LINEAR_STOP:
      return atTime > ((tr.time + tr.duration) | 0) ? vec3(0, 0, 0) : vec3(tr.delta.x, tr.delta.y, tr.delta.z);
    case TrajectoryType.TR_GRAVITY: {
      const deltaTime = seconds((atTime - tr.time) | 0);
      return vec3(tr.delta.x, tr.delta.y, tr.delta.z - Math.fround(DEFAULT_GRAVITY * deltaTime));
    }
    default:
      throw new CommonError("drop", `BG_EvaluateTrajectoryDelta: unknown trType: ${tr.time}`);
  }
}
