/*
 * Q3_VM numeric profile of id Software's code/game/q_math.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { cross3, dot3, perpendicularVector, sub3, vec3 } from "./math.ts";
import type { AngleVectors, Axis, Vec3 } from "./math.ts";
import { qvmFloatToInt } from "./numeric.ts";

const f32 = Math.fround;
// q3lcc folds AngleVectors' parenthesized expression to CNSTF4 1016003125.
const ANGLE_RADIANS = f32(Math.PI * 2 / 360);
const QVM_PI = f32(Math.PI);

/** AngleMod's QVM MULF4 precedes truncation and the unsigned angle16 mask. */
export function qvmAngleMod(angle: number): number {
  const scaled = f32(f32(angle) * f32(65536 / 360));
  return f32((qvmFloatToInt(scaled) & 65535) * f32(360 / 65536));
}

/** QVM float inputs, x = pitch, y = yaw, z = roll, in degrees. */
export function qvmAngleVectors(angles: Vec3): AngleVectors {
  const yaw = f32(f32(angles.y) * ANGLE_RADIANS);
  const pitch = f32(f32(angles.x) * ANGLE_RADIANS);
  const roll = f32(f32(angles.z) * ANGLE_RADIANS);
  const sy = f32(Math.sin(yaw));
  const cy = f32(Math.cos(yaw));
  const sp = f32(Math.sin(pitch));
  const cp = f32(Math.cos(pitch));
  const sr = f32(Math.sin(roll));
  const cr = f32(Math.cos(roll));

  return {
    forward: vec3(cp * cy, cp * sy, -sp),
    right: vec3(
      f32(f32(-sr * sp) * cy) + f32(-cr * -sy),
      f32(f32(-sr * sp) * sy) + f32(-cr * cy),
      -sr * cp,
    ),
    up: vec3(
      f32(f32(cr * sp) * cy) + f32(-sr * -sy),
      f32(f32(cr * sp) * sy) + f32(-sr * cy),
      cr * cp,
    ),
  };
}

export function qvmAnglesToAxis(angles: Vec3): Axis {
  const vectors = qvmAngleVectors(angles);
  return [vectors.forward, sub3(vec3(0, 0, 0), vectors.right), vectors.up];
}

type Matrix3 = readonly [Vec3, Vec3, Vec3];

function matrixMultiply(a: Matrix3, b: Matrix3): Matrix3 {
  const x = vec3(b[0].x, b[1].x, b[2].x);
  const y = vec3(b[0].y, b[1].y, b[2].y);
  const z = vec3(b[0].z, b[1].z, b[2].z);
  return [
    vec3(dot3(a[0], x), dot3(a[0], y), dot3(a[0], z)),
    vec3(dot3(a[1], x), dot3(a[1], y), dot3(a[1], z)),
    vec3(dot3(a[2], x), dot3(a[2], y), dot3(a[2], z)),
  ];
}

/** Direction must be normalized, as required by the original QVM routine. */
export function qvmRotatePointAroundVector(direction: Vec3, point: Vec3, degrees: number): Vec3 {
  const forward = vec3(direction.x, direction.y, direction.z);
  const input = vec3(point.x, point.y, point.z);
  // These helpers already round each QVM multiply/add/divide and sqrt return.
  const radial = perpendicularVector(forward);
  const vertical = cross3(radial, forward);
  // DEG2RAD emits MULF4 by float32 PI followed by DIVF4, not AngleVectors' constant.
  const radians = f32(f32(f32(degrees) * QVM_PI) / 180);
  const cosine = f32(Math.cos(radians));
  const sine = f32(Math.sin(radians));
  const basis: Matrix3 = [
    vec3(radial.x, vertical.x, forward.x),
    vec3(radial.y, vertical.y, forward.y),
    vec3(radial.z, vertical.z, forward.z),
  ];
  const zRotation: Matrix3 = [vec3(cosine, sine, 0), vec3(-sine, cosine, 0), vec3(0, 0, 1)];
  const inverse: Matrix3 = [radial, vertical, forward];
  const rotation = matrixMultiply(matrixMultiply(basis, zRotation), inverse);
  return vec3(dot3(rotation[0], input), dot3(rotation[1], input), dot3(rotation[2], input));
}
