/*
 * Translated vector and angle routines from Quake III Arena's q_math.c and
 * q_shared.h. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Vec4 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface Plane {
  readonly normal: Vec3;
  readonly distance: number;
}

/** Quake axes are ordered forward, left, up. */
export type Axis = readonly [Vec3, Vec3, Vec3];

export interface AngleVectors {
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

/**
 * A column-major 4x4 matrix for column vectors. Element order matches OpenGL.
 * multiplyMat4(a, b) returns a * b, so b transforms a vector first.
 */
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

const DEGREES_TO_RADIANS = Math.PI * 2 / 360;

export function vec2(x: number, y: number): Vec2 {
  return { x: Math.fround(x), y: Math.fround(y) };
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x: Math.fround(x), y: Math.fround(y), z: Math.fround(z) };
}

export function vec4(x: number, y: number, z: number, w: number): Vec4 {
  return {
    x: Math.fround(x),
    y: Math.fround(y),
    z: Math.fround(z),
    w: Math.fround(w),
  };
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale3(value: Vec3, scale: number): Vec3 {
  return vec3(value.x * scale, value.y * scale, value.z * scale);
}

export function dot3(a: Vec3, b: Vec3): number {
  return Math.fround(Math.fround(Math.fround(a.x * b.x) + Math.fround(a.y * b.y)) + Math.fround(a.z * b.z));
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return vec3(
    Math.fround(a.y * b.z) - Math.fround(a.z * b.y),
    Math.fround(a.z * b.x) - Math.fround(a.x * b.z),
    Math.fround(a.x * b.y) - Math.fround(a.y * b.x),
  );
}

export function length3(value: Vec3): number {
  return Math.fround(Math.sqrt(dot3(value, value)));
}

export function normalize3(value: Vec3): Vec3 {
  const length = length3(value);
  if (length === 0) {
    return vec3(value.x, value.y, value.z);
  }
  return scale3(value, Math.fround(1 / length));
}

/** q_math.c VectorNormalize2 clears its output when the stored length is zero. */
export function normalize3OrZero(value: Vec3): Vec3 {
  const length = length3(value);
  if (length === 0) {
    return vec3(0, 0, 0);
  }
  return scale3(value, Math.fround(1 / length));
}

function mathSignedInteger(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new RangeError("q_math integer argument must be a signed 32-bit integer");
  }
  return value | 0;
}

/** q_math.c ClampShort consumes an int, not a floating-point conversion. */
export function clampShort(value: number): number {
  const integer = mathSignedInteger(value);
  if (integer < -32768) return -32768;
  if (integer > 32767) return 32767;
  return integer;
}

/** Q_log2 returns zero for zero; negative arithmetic shifts never terminate. */
export function qLog2(value: number): number {
  let integer = mathSignedInteger(value);
  if (integer < 0) throw new RangeError("Q_log2 does not terminate for negative source integers");
  let answer = 0;
  while ((integer >>= 1) !== 0) answer++;
  return answer;
}

/** NormalizeColor retains its ordered maximum and supports in-place output. */
export function normalizeColor(input: Vec3, output: { x: number; y: number; z: number }): number {
  let maximum = Math.fround(input.x);
  if (Math.fround(input.y) > maximum) maximum = Math.fround(input.y);
  if (Math.fround(input.z) > maximum) maximum = Math.fround(input.z);
  if (maximum === 0) {
    output.x = 0;
    output.y = 0;
    output.z = 0;
  } else {
    output.x = Math.fround(Math.fround(input.x) / maximum);
    output.y = Math.fround(Math.fround(input.y) / maximum);
    output.z = Math.fround(Math.fround(input.z) / maximum);
  }
  return maximum;
}

function nativeColorByte(value: number): number {
  const integer = Math.trunc(Math.fround(Math.fround(value) * 255));
  if (!Number.isFinite(integer) || integer < 0 || integer > 255) {
    throw new RangeError("ColorBytes3 native float-to-byte conversion is outside its defined range");
  }
  return integer;
}

/** Native little-endian ColorBytes3; the caller supplies the retained fourth byte. */
export function colorBytes3(red: number, green: number, blue: number, storage: DataView): number {
  if (storage.byteLength < 4) throw new RangeError("ColorBytes3 requires a retained four-byte word");
  storage.setUint8(0, nativeColorByte(red));
  storage.setUint8(1, nativeColorByte(green));
  storage.setUint8(2, nativeColorByte(blue));
  return storage.getUint32(0, true);
}

export function lerp3(from: Vec3, to: Vec3, fraction: number): Vec3 {
  return vec3(
    from.x + fraction * (to.x - from.x),
    from.y + fraction * (to.y - from.y),
    from.z + fraction * (to.z - from.z),
  );
}

/** Angles use x = pitch, y = yaw, z = roll, in degrees. */
export function angleVectors(angles: Vec3): AngleVectors {
  const yaw = Math.fround(angles.y * DEGREES_TO_RADIANS);
  const pitch = Math.fround(angles.x * DEGREES_TO_RADIANS);
  const roll = Math.fround(angles.z * DEGREES_TO_RADIANS);
  const sy = Math.fround(Math.sin(yaw));
  const cy = Math.fround(Math.cos(yaw));
  const sp = Math.fround(Math.sin(pitch));
  const cp = Math.fround(Math.cos(pitch));
  const sr = Math.fround(Math.sin(roll));
  const cr = Math.fround(Math.cos(roll));

  return {
    forward: vec3(cp * cy, cp * sy, -sp),
    right: vec3(
      Math.fround(Math.fround(-sr * sp) * cy) + Math.fround(-cr * -sy),
      Math.fround(Math.fround(-sr * sp) * sy) + Math.fround(-cr * cy),
      -sr * cp,
    ),
    up: vec3(
      Math.fround(Math.fround(cr * sp) * cy) + Math.fround(-sr * -sy),
      Math.fround(Math.fround(cr * sp) * sy) + Math.fround(-sr * cy),
      cr * cp,
    ),
  };
}

export function anglesToAxis(angles: Vec3): Axis {
  const vectors = angleVectors(angles);
  return [vectors.forward, scale3(vectors.right, -1), vectors.up];
}

export function vectorToAngles(value: Vec3): Vec3 {
  const qvmPi = Math.fround(Math.PI);
  let yaw: number;
  let pitch: number;

  if (value.y === 0 && value.x === 0) {
    yaw = 0;
    pitch = value.z > 0 ? 90 : 270;
  } else {
    if (value.x !== 0) {
      const yawRadians = Math.fround(Math.atan2(value.y, value.x));
      yaw = Math.fround(Math.fround(yawRadians * 180) / qvmPi);
    } else {
      yaw = value.y > 0 ? 90 : 270;
    }
    if (yaw < 0) {
      yaw = Math.fround(yaw + 360);
    }

    const xSquared = Math.fround(value.x * value.x);
    const ySquared = Math.fround(value.y * value.y);
    const forwardSquared = Math.fround(xSquared + ySquared);
    const forward = Math.fround(Math.sqrt(forwardSquared));
    const pitchRadians = Math.fround(Math.atan2(value.z, forward));
    pitch = Math.fround(Math.fround(pitchRadians * 180) / qvmPi);
    if (pitch < 0) {
      pitch = Math.fround(pitch + 360);
    }
  }

  return vec3(-pitch, yaw, 0);
}

export function angleMod(angle: number): number {
  return (360 / 65536) * ((angle * (65536 / 360)) & 65535);
}

export function angleNormalize360(angle: number): number {
  return angleMod(angle);
}

export function angleNormalize180(angle: number): number {
  const normalized = angleNormalize360(angle);
  return normalized > 180 ? normalized - 360 : normalized;
}

export function angleDelta(angle1: number, angle2: number): number {
  return angleNormalize180(angle1 - angle2);
}

/** Preserves q_math.c semantics, whose normal is expected to be nonzero. */
export function projectPointOnPlane(point: Vec3, normal: Vec3): Vec3 {
  const inverseDenominator = Math.fround(1 / dot3(normal, normal));
  const distance = Math.fround(dot3(normal, point) * inverseDenominator);
  const scaledNormal = scale3(normal, inverseDenominator);
  return sub3(point, scale3(scaledNormal, distance));
}

/** The source vector must be normalized, matching q_math.c. */
export function perpendicularVector(source: Vec3): Vec3 {
  let axis = vec3(1, 0, 0);
  let minimum = 1;

  if (Math.abs(source.x) < minimum) {
    minimum = Math.abs(source.x);
    axis = vec3(1, 0, 0);
  }
  if (Math.abs(source.y) < minimum) {
    minimum = Math.abs(source.y);
    axis = vec3(0, 1, 0);
  }
  if (Math.abs(source.z) < minimum) {
    axis = vec3(0, 0, 1);
  }

  return normalize3(projectPointOnPlane(axis, source));
}

/** The rotation direction must be normalized, matching q_math.c. */
export function rotatePointAroundVector(
  direction: Vec3,
  point: Vec3,
  degrees: number,
): Vec3 {
  const radial = perpendicularVector(direction);
  const vertical = cross3(radial, direction);
  const radians = Math.fround(Math.fround(degrees) * Math.PI / 180);
  const cosine = Math.fround(Math.cos(radians));
  const sine = Math.fround(Math.sin(radians));
  const basis: Mat3 = [
    vec3(radial.x, vertical.x, direction.x),
    vec3(radial.y, vertical.y, direction.y),
    vec3(radial.z, vertical.z, direction.z),
  ];
  const zRotation: Mat3 = [vec3(cosine, sine, 0), vec3(-sine, cosine, 0), vec3(0, 0, 1)];
  const inverse: Mat3 = [radial, vertical, direction];
  const rotation = multiplyMat3(multiplyMat3(basis, zRotation), inverse);
  return vec3(dot3(rotation[0], point), dot3(rotation[1], point), dot3(rotation[2], point));
}

type Mat3 = readonly [Vec3, Vec3, Vec3];

/** q_math.c MatrixMultiply stores each product sum in its row-major float matrix. */
function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const x = vec3(b[0].x, b[1].x, b[2].x);
  const y = vec3(b[0].y, b[1].y, b[2].y);
  const z = vec3(b[0].z, b[1].z, b[2].z);
  return [
    vec3(dot3(a[0], x), dot3(a[0], y), dot3(a[0], z)),
    vec3(dot3(a[1], x), dot3(a[1], y), dot3(a[1], z)),
    vec3(dot3(a[2], x), dot3(a[2], y), dot3(a[2], z)),
  ];
}

export function emptyBounds(): Bounds {
  return {
    min: vec3(99999, 99999, 99999),
    max: vec3(-99999, -99999, -99999),
  };
}

export function addPointToBounds(bounds: Bounds, point: Vec3): Bounds {
  return {
    min: vec3(
      point.x < bounds.min.x ? point.x : bounds.min.x,
      point.y < bounds.min.y ? point.y : bounds.min.y,
      point.z < bounds.min.z ? point.z : bounds.min.z,
    ),
    max: vec3(
      point.x > bounds.max.x ? point.x : bounds.max.x,
      point.y > bounds.max.y ? point.y : bounds.max.y,
      point.z > bounds.max.z ? point.z : bounds.max.z,
    ),
  };
}

export function radiusFromBounds(bounds: Bounds): number {
  const minX = Math.abs(bounds.min.x);
  const minY = Math.abs(bounds.min.y);
  const minZ = Math.abs(bounds.min.z);
  const maxX = Math.abs(bounds.max.x);
  const maxY = Math.abs(bounds.max.y);
  const maxZ = Math.abs(bounds.max.z);
  return length3(vec3(
    minX > maxX ? minX : maxX,
    minY > maxY ? minY : maxY,
    minZ > maxZ ? minZ : maxZ,
  ));
}

/** Returns null for a degenerate triangle. Clockwise points produce an outward normal. */
export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const firstEdge = sub3(b, a);
  const secondEdge = sub3(c, a);
  const cross = cross3(secondEdge, firstEdge);
  const length = length3(cross);
  if (length === 0) {
    return null;
  }
  const normal = scale3(cross, Math.fround(1 / length));
  return { normal, distance: dot3(a, normal) };
}

export function distanceToPlane(plane: Plane, point: Vec3): number {
  return dot3(plane.normal, point) - plane.distance;
}

/** Returns Quake's front/back bitmask: 1 front, 2 back, or 3 crossing. */
export function boxOnPlaneSide(bounds: Bounds, plane: Plane): number {
  const frontCorner = vec3(
    plane.normal.x < 0 ? bounds.min.x : bounds.max.x,
    plane.normal.y < 0 ? bounds.min.y : bounds.max.y,
    plane.normal.z < 0 ? bounds.min.z : bounds.max.z,
  );
  const backCorner = vec3(
    plane.normal.x < 0 ? bounds.max.x : bounds.min.x,
    plane.normal.y < 0 ? bounds.max.y : bounds.min.y,
    plane.normal.z < 0 ? bounds.max.z : bounds.min.z,
  );
  const frontDistance = distanceToPlane(plane, frontCorner);
  const backDistance = distanceToPlane(plane, backCorner);
  let sides = 0;
  if (frontDistance >= 0) {
    sides = 1;
  }
  if (backDistance < 0) {
    sides |= 2;
  }
  return sides;
}

export function identityMat4(): Mat4 {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  return [
    a[0] * b[0] + a[4] * b[1] + a[8] * b[2] + a[12] * b[3],
    a[1] * b[0] + a[5] * b[1] + a[9] * b[2] + a[13] * b[3],
    a[2] * b[0] + a[6] * b[1] + a[10] * b[2] + a[14] * b[3],
    a[3] * b[0] + a[7] * b[1] + a[11] * b[2] + a[15] * b[3],
    a[0] * b[4] + a[4] * b[5] + a[8] * b[6] + a[12] * b[7],
    a[1] * b[4] + a[5] * b[5] + a[9] * b[6] + a[13] * b[7],
    a[2] * b[4] + a[6] * b[5] + a[10] * b[6] + a[14] * b[7],
    a[3] * b[4] + a[7] * b[5] + a[11] * b[6] + a[15] * b[7],
    a[0] * b[8] + a[4] * b[9] + a[8] * b[10] + a[12] * b[11],
    a[1] * b[8] + a[5] * b[9] + a[9] * b[10] + a[13] * b[11],
    a[2] * b[8] + a[6] * b[9] + a[10] * b[10] + a[14] * b[11],
    a[3] * b[8] + a[7] * b[9] + a[11] * b[10] + a[15] * b[11],
    a[0] * b[12] + a[4] * b[13] + a[8] * b[14] + a[12] * b[15],
    a[1] * b[12] + a[5] * b[13] + a[9] * b[14] + a[13] * b[15],
    a[2] * b[12] + a[6] * b[13] + a[10] * b[14] + a[14] * b[15],
    a[3] * b[12] + a[7] * b[13] + a[11] * b[14] + a[15] * b[15],
  ];
}

/** Builds a right-handed OpenGL perspective matrix with NDC depth [-1, 1]. */
export function perspectiveMat4(
  verticalFieldOfViewDegrees: number,
  aspectRatio: number,
  near: number,
  far: number,
): Mat4 {
  const focalLength = 1 / Math.tan(verticalFieldOfViewDegrees * DEGREES_TO_RADIANS / 2);
  const depthScale = 1 / (near - far);
  return [
    focalLength / aspectRatio, 0, 0, 0,
    0, focalLength, 0, 0,
    0, 0, (far + near) * depthScale, -1,
    0, 0, 2 * far * near * depthScale, 0,
  ];
}

/** Builds a right-handed world-to-view matrix. */
export function lookAtMat4(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const backward = normalize3(sub3(eye, target));
  const right = normalize3(cross3(up, backward));
  const cameraUp = cross3(backward, right);
  return [
    right.x, cameraUp.x, backward.x, 0,
    right.y, cameraUp.y, backward.y, 0,
    right.z, cameraUp.z, backward.z, 0,
    -dot3(right, eye), -dot3(cameraUp, eye), -dot3(backward, eye), 1,
  ];
}

export function transformVec4(matrix: Mat4, value: Vec4): Vec4 {
  return vec4(
    matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z + matrix[12] * value.w,
    matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z + matrix[13] * value.w,
    matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z + matrix[14] * value.w,
    matrix[3] * value.x + matrix[7] * value.y + matrix[11] * value.z + matrix[15] * value.w,
  );
}
