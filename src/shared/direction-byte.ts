// Ported from id Software's code/game/q_math.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { dot3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";

const NUM_VERTEX_NORMALS = 162;

function direction(x: number, y: number, z: number): Vec3 {
  return Object.freeze(vec3(x, y, z));
}

const BYTE_DIRECTIONS: readonly Vec3[] = Object.freeze([
  direction(-0.525731, 0.000000, 0.850651),
  direction(-0.442863, 0.238856, 0.864188),
  direction(-0.295242, 0.000000, 0.955423),
  direction(-0.309017, 0.500000, 0.809017),
  direction(-0.162460, 0.262866, 0.951056),
  direction(0.000000, 0.000000, 1.000000),
  direction(0.000000, 0.850651, 0.525731),
  direction(-0.147621, 0.716567, 0.681718),
  direction(0.147621, 0.716567, 0.681718),
  direction(0.000000, 0.525731, 0.850651),
  direction(0.309017, 0.500000, 0.809017),
  direction(0.525731, 0.000000, 0.850651),
  direction(0.295242, 0.000000, 0.955423),
  direction(0.442863, 0.238856, 0.864188),
  direction(0.162460, 0.262866, 0.951056),
  direction(-0.681718, 0.147621, 0.716567),
  direction(-0.809017, 0.309017, 0.500000),
  direction(-0.587785, 0.425325, 0.688191),
  direction(-0.850651, 0.525731, 0.000000),
  direction(-0.864188, 0.442863, 0.238856),
  direction(-0.716567, 0.681718, 0.147621),
  direction(-0.688191, 0.587785, 0.425325),
  direction(-0.500000, 0.809017, 0.309017),
  direction(-0.238856, 0.864188, 0.442863),
  direction(-0.425325, 0.688191, 0.587785),
  direction(-0.716567, 0.681718, -0.147621),
  direction(-0.500000, 0.809017, -0.309017),
  direction(-0.525731, 0.850651, 0.000000),
  direction(0.000000, 0.850651, -0.525731),
  direction(-0.238856, 0.864188, -0.442863),
  direction(0.000000, 0.955423, -0.295242),
  direction(-0.262866, 0.951056, -0.162460),
  direction(0.000000, 1.000000, 0.000000),
  direction(0.000000, 0.955423, 0.295242),
  direction(-0.262866, 0.951056, 0.162460),
  direction(0.238856, 0.864188, 0.442863),
  direction(0.262866, 0.951056, 0.162460),
  direction(0.500000, 0.809017, 0.309017),
  direction(0.238856, 0.864188, -0.442863),
  direction(0.262866, 0.951056, -0.162460),
  direction(0.500000, 0.809017, -0.309017),
  direction(0.850651, 0.525731, 0.000000),
  direction(0.716567, 0.681718, 0.147621),
  direction(0.716567, 0.681718, -0.147621),
  direction(0.525731, 0.850651, 0.000000),
  direction(0.425325, 0.688191, 0.587785),
  direction(0.864188, 0.442863, 0.238856),
  direction(0.688191, 0.587785, 0.425325),
  direction(0.809017, 0.309017, 0.500000),
  direction(0.681718, 0.147621, 0.716567),
  direction(0.587785, 0.425325, 0.688191),
  direction(0.955423, 0.295242, 0.000000),
  direction(1.000000, 0.000000, 0.000000),
  direction(0.951056, 0.162460, 0.262866),
  direction(0.850651, -0.525731, 0.000000),
  direction(0.955423, -0.295242, 0.000000),
  direction(0.864188, -0.442863, 0.238856),
  direction(0.951056, -0.162460, 0.262866),
  direction(0.809017, -0.309017, 0.500000),
  direction(0.681718, -0.147621, 0.716567),
  direction(0.850651, 0.000000, 0.525731),
  direction(0.864188, 0.442863, -0.238856),
  direction(0.809017, 0.309017, -0.500000),
  direction(0.951056, 0.162460, -0.262866),
  direction(0.525731, 0.000000, -0.850651),
  direction(0.681718, 0.147621, -0.716567),
  direction(0.681718, -0.147621, -0.716567),
  direction(0.850651, 0.000000, -0.525731),
  direction(0.809017, -0.309017, -0.500000),
  direction(0.864188, -0.442863, -0.238856),
  direction(0.951056, -0.162460, -0.262866),
  direction(0.147621, 0.716567, -0.681718),
  direction(0.309017, 0.500000, -0.809017),
  direction(0.425325, 0.688191, -0.587785),
  direction(0.442863, 0.238856, -0.864188),
  direction(0.587785, 0.425325, -0.688191),
  direction(0.688191, 0.587785, -0.425325),
  direction(-0.147621, 0.716567, -0.681718),
  direction(-0.309017, 0.500000, -0.809017),
  direction(0.000000, 0.525731, -0.850651),
  direction(-0.525731, 0.000000, -0.850651),
  direction(-0.442863, 0.238856, -0.864188),
  direction(-0.295242, 0.000000, -0.955423),
  direction(-0.162460, 0.262866, -0.951056),
  direction(0.000000, 0.000000, -1.000000),
  direction(0.295242, 0.000000, -0.955423),
  direction(0.162460, 0.262866, -0.951056),
  direction(-0.442863, -0.238856, -0.864188),
  direction(-0.309017, -0.500000, -0.809017),
  direction(-0.162460, -0.262866, -0.951056),
  direction(0.000000, -0.850651, -0.525731),
  direction(-0.147621, -0.716567, -0.681718),
  direction(0.147621, -0.716567, -0.681718),
  direction(0.000000, -0.525731, -0.850651),
  direction(0.309017, -0.500000, -0.809017),
  direction(0.442863, -0.238856, -0.864188),
  direction(0.162460, -0.262866, -0.951056),
  direction(0.238856, -0.864188, -0.442863),
  direction(0.500000, -0.809017, -0.309017),
  direction(0.425325, -0.688191, -0.587785),
  direction(0.716567, -0.681718, -0.147621),
  direction(0.688191, -0.587785, -0.425325),
  direction(0.587785, -0.425325, -0.688191),
  direction(0.000000, -0.955423, -0.295242),
  direction(0.000000, -1.000000, 0.000000),
  direction(0.262866, -0.951056, -0.162460),
  direction(0.000000, -0.850651, 0.525731),
  direction(0.000000, -0.955423, 0.295242),
  direction(0.238856, -0.864188, 0.442863),
  direction(0.262866, -0.951056, 0.162460),
  direction(0.500000, -0.809017, 0.309017),
  direction(0.716567, -0.681718, 0.147621),
  direction(0.525731, -0.850651, 0.000000),
  direction(-0.238856, -0.864188, -0.442863),
  direction(-0.500000, -0.809017, -0.309017),
  direction(-0.262866, -0.951056, -0.162460),
  direction(-0.850651, -0.525731, 0.000000),
  direction(-0.716567, -0.681718, -0.147621),
  direction(-0.716567, -0.681718, 0.147621),
  direction(-0.525731, -0.850651, 0.000000),
  direction(-0.500000, -0.809017, 0.309017),
  direction(-0.238856, -0.864188, 0.442863),
  direction(-0.262866, -0.951056, 0.162460),
  direction(-0.864188, -0.442863, 0.238856),
  direction(-0.809017, -0.309017, 0.500000),
  direction(-0.688191, -0.587785, 0.425325),
  direction(-0.681718, -0.147621, 0.716567),
  direction(-0.442863, -0.238856, 0.864188),
  direction(-0.587785, -0.425325, 0.688191),
  direction(-0.309017, -0.500000, 0.809017),
  direction(-0.147621, -0.716567, 0.681718),
  direction(-0.425325, -0.688191, 0.587785),
  direction(-0.162460, -0.262866, 0.951056),
  direction(0.442863, -0.238856, 0.864188),
  direction(0.162460, -0.262866, 0.951056),
  direction(0.309017, -0.500000, 0.809017),
  direction(0.147621, -0.716567, 0.681718),
  direction(0.000000, -0.525731, 0.850651),
  direction(0.425325, -0.688191, 0.587785),
  direction(0.587785, -0.425325, 0.688191),
  direction(0.688191, -0.587785, 0.425325),
  direction(-0.955423, 0.295242, 0.000000),
  direction(-0.951056, 0.162460, 0.262866),
  direction(-1.000000, 0.000000, 0.000000),
  direction(-0.850651, 0.000000, 0.525731),
  direction(-0.955423, -0.295242, 0.000000),
  direction(-0.951056, -0.162460, 0.262866),
  direction(-0.864188, 0.442863, -0.238856),
  direction(-0.951056, 0.162460, -0.262866),
  direction(-0.809017, 0.309017, -0.500000),
  direction(-0.864188, -0.442863, -0.238856),
  direction(-0.951056, -0.162460, -0.262866),
  direction(-0.809017, -0.309017, -0.500000),
  direction(-0.681718, 0.147621, -0.716567),
  direction(-0.681718, -0.147621, -0.716567),
  direction(-0.850651, 0.000000, -0.525731),
  direction(-0.688191, 0.587785, -0.425325),
  direction(-0.587785, 0.425325, -0.688191),
  direction(-0.425325, 0.688191, -0.587785),
  direction(-0.425325, -0.688191, -0.587785),
  direction(-0.587785, -0.425325, -0.688191),
  direction(-0.688191, -0.587785, -0.425325),
]);

if (BYTE_DIRECTIONS.length !== NUM_VERTEX_NORMALS) {
  throw new Error(`Direction-byte table has ${BYTE_DIRECTIONS.length} entries, expected ${NUM_VERTEX_NORMALS}`);
}

const ZERO_DIRECTION = direction(0, 0, 0);

export function directionToByte(value: Vec3 | null): number {
  if (value === null) return 0;
  let bestDot = 0;
  let best = 0;
  for (let index = 0; index < BYTE_DIRECTIONS.length; index++) {
    const candidate = BYTE_DIRECTIONS[index];
    if (candidate === undefined) throw new Error("Direction-byte table index is invalid");
    const dot = dot3(value, candidate);
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  }
  return best;
}

export function byteToDirection(byte: number): Vec3 {
  if (!Number.isSafeInteger(byte)) throw new RangeError(`Direction byte ${byte} is not a safe integer`);
  if (byte < 0 || byte >= BYTE_DIRECTIONS.length) return ZERO_DIRECTION;
  const value = BYTE_DIRECTIONS[byte];
  if (value === undefined) throw new Error("Direction-byte table index is invalid");
  return value;
}
