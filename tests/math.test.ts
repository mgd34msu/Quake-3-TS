import { describe, expect, test } from "bun:test";

import {
  add3,
  addPointToBounds,
  angleDelta,
  angleMod,
  angleNormalize180,
  angleNormalize360,
  angleVectors,
  anglesToAxis,
  boxOnPlaneSide,
  clampShort,
  colorBytes3,
  cross3,
  distanceToPlane,
  dot3,
  emptyBounds,
  identityMat4,
  length3,
  lerp3,
  lookAtMat4,
  multiplyMat4,
  normalize3,
  normalize3OrZero,
  normalizeColor,
  perpendicularVector,
  perspectiveMat4,
  planeFromPoints,
  projectPointOnPlane,
  qLog2,
  radiusFromBounds,
  rotatePointAroundVector,
  scale3,
  sub3,
  transformVec4,
  vec2,
  vec3,
  vec4,
  vectorToAngles,
} from "../src/core/math.ts";
import type { Bounds, Mat4, Vec3, Vec4 } from "../src/core/math.ts";

function expectVec3Close(actual: Vec3, expected: Vec3): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
}

function expectVec4Close(actual: Vec4, expected: Vec4): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.z).toBeCloseTo(expected.z, 6);
  expect(actual.w).toBeCloseTo(expected.w, 6);
}

describe("q_math integer and color helpers", () => {
  test("ClampShort preserves the signed int domain and clamps both short limits", () => {
    for (const value of [-2147483648, -32769, -32768]) expect(clampShort(value)).toBe(-32768);
    for (const value of [32767, 32768, 2147483647]) expect(clampShort(value)).toBe(32767);
    for (const value of [-32767, -1, 0, 1, 32766]) expect(clampShort(value)).toBe(value);
    expect(clampShort(-0)).toBe(0);
    for (const value of [-2147483649, 2147483648, 0.5, NaN, Infinity]) {
      expect(() => clampShort(value)).toThrow("signed 32-bit integer");
    }
  });

  test("Q_log2 shifts nonnegative source ints and reports its nonterminating domain", () => {
    expect(qLog2(0)).toBe(0);
    expect(qLog2(-0)).toBe(0);
    expect(qLog2(1)).toBe(0);
    expect(qLog2(2)).toBe(1);
    expect(qLog2(3)).toBe(1);
    expect(qLog2(1023)).toBe(9);
    expect(qLog2(1024)).toBe(10);
    expect(qLog2(2147483647)).toBe(30);
    for (const value of [-1, -2147483648]) expect(() => qLog2(value)).toThrow("does not terminate");
    for (const value of [2147483648, 1.5, NaN, Infinity]) expect(() => qLog2(value)).toThrow("signed 32-bit integer");
  });

  test("NormalizeColor divides by the ordered maximum, including aliased negative input", () => {
    const output = { x: 9, y: 9, z: 9 };
    expect(normalizeColor(vec3(5, 6, 0), output)).toBe(6);
    expect(output).toEqual({ x: 0.8333333134651184, y: 1, z: 0 });
    const aliased = { x: -8, y: -2, z: -4 };
    expect(normalizeColor(aliased, aliased)).toBe(-2);
    expect(aliased).toEqual({ x: 4, y: 1, z: 2 });
    expect(normalizeColor(vec3(-2, -0, -1), output)).toBe(-0);
    expect(output).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("NormalizeColor preserves ordered NaN comparisons and nonfinite division results", () => {
    const output = { x: 9, y: 9, z: 9 };
    expect(normalizeColor(vec3(2, NaN, 1), output)).toBe(2);
    expect(output).toEqual({ x: 1, y: NaN, z: 0.5 });
    expect(normalizeColor(vec3(NaN, 2, 1), output)).toBeNaN();
    expect(output).toEqual({ x: NaN, y: NaN, z: NaN });
    expect(normalizeColor(vec3(-1, Infinity, 1), output)).toBe(Infinity);
    expect(output).toEqual({ x: -0, y: NaN, z: 0 });
  });

  test("ColorBytes3 writes RGB into the caller's word and retains its fourth byte", () => {
    const bytes = new Uint8Array([91, 92, 93, 94, 0xab, 96]);
    const storage = new DataView(bytes.buffer, 1, 4);
    expect(colorBytes3(0.5, 0.1, 0.75, storage)).toBe(0xabbf197f);
    expect(bytes).toEqual(new Uint8Array([91, 127, 25, 191, 0xab, 96]));
    expect(colorBytes3(-0.001, 1.001, 0, storage)).toBe(0xab00ff00);
    expect(colorBytes3(0, 0, 1 - Math.pow(2, -25), storage)).toBe(0xabff0000);
  });

  test("ColorBytes3 explicitly rejects undefined conversions at the reached channel", () => {
    for (const invalid of [-1, 2, NaN, Infinity, -Infinity]) {
      const bytes = new Uint8Array([11, 22, 33, 44]);
      expect(() => colorBytes3(1, invalid, 0, new DataView(bytes.buffer))).toThrow("outside its defined range");
      expect(bytes).toEqual(new Uint8Array([255, 22, 33, 44]));
    }
    expect(() => colorBytes3(0, 0, 0, new DataView(new ArrayBuffer(3)))).toThrow("retained four-byte word");
  });
});

describe("float vectors", () => {
  test("constructs named vectors at float32 storage boundaries", () => {
    expect(vec2(0.1, 2)).toEqual({ x: Math.fround(0.1), y: 2 });
    expect(vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    expect(vec4(1, 2, 3, 4)).toEqual({ x: 1, y: 2, z: 3, w: 4 });
  });

  test("adds, subtracts, scales, dots, crosses, and interpolates", () => {
    const a = vec3(1, 2, 3);
    const b = vec3(4, -5, 6);
    expect(add3(a, b)).toEqual(vec3(5, -3, 9));
    expect(sub3(a, b)).toEqual(vec3(-3, 7, -3));
    expect(scale3(a, 2.5)).toEqual(vec3(2.5, 5, 7.5));
    expect(dot3(a, b)).toBe(12);
    expect(cross3(a, b)).toEqual(vec3(27, 6, -13));
    expect(lerp3(a, b, 0.25)).toEqual(vec3(1.75, 0.25, 3.75));
  });

  test("measures and normalizes, retaining Quake's zero-vector result", () => {
    expect(length3(vec3(3, 4, 0))).toBe(5);
    expect(normalize3(vec3(3, 4, 0))).toEqual(vec3(0.6, 0.8, 0));
    expect(normalize3(vec3(0, 0, 0))).toEqual(vec3(0, 0, 0));
  });

  test("VectorNormalize2 clears zero-length output including signed zeros and underflow", () => {
    // q_math.c:1111 clears out when its stored length is zero.
    for (const input of [vec3(0, 0, 0), vec3(-0, -0, -0), vec3(1e-30, -0, 0)]) {
      expect(normalize3OrZero(input)).toEqual({ x: 0, y: 0, z: 0 });
    }
  });

  test("VectorNormalize2 scales ordinary and overflowed lengths by the stored reciprocal", () => {
    expect(normalize3OrZero(vec3(3, 4, -0))).toEqual({ x: Math.fround(0.6), y: Math.fround(0.8), z: -0 });
    expect(normalize3OrZero(vec3(1, 2, 3))).toEqual({ x: 0.26726123690605164, y: 0.5345224738121033, z: 0.8017836809158325 });
    // Finite components whose squared length overflows still take the scaling branch.
    expect(normalize3OrZero(vec3(1e20, -1e20, -0))).toEqual({ x: 0, y: -0, z: -0 });
  });
});

// Golden outputs from untouched q_math.c/q_shared.h at source commit
// dbe4ddb10315479fc00086f08e25d968b4b43c49, compiled with GCC gnu99 -O0.
// Oracle driver and binary: /tmp/quake3-math-reference-0yf80F/reference{.c,}.
// GNU math.h provides double M_PI; float expressions use SSE without contraction.
describe("native q_math float32 fixtures", () => {
  test("dot products round each multiply and left-associated addition", () => {
    expect(dot3(vec3(12345.678, -0.0001234, 99.75), vec3(-0.1234567, 89123.4, 1 / 3))).toBe(-1501.9044189453125);
    expect(dot3(vec3(1.0000001192092896, 1, 1), vec3(1.0000001192092896, -1, -0.0000002384185791015625))).toBe(0);
  });

  test("normalization stores length and reciprocal before scaling", () => {
    expect(length3(vec3(127, -127, 0))).toBe(179.60511779785156);
    expect(normalize3(vec3(127, -127, 0))).toEqual({ x: 0.7071067690849304, y: -0.7071067690849304, z: 0 });
    expect(length3(vec3(0.1, 0.2, 0.3))).toBe(0.37416577339172363);
    expect(normalize3(vec3(0.1, 0.2, 0.3))).toEqual({ x: 0.26726123690605164, y: 0.5345224738121033, z: 0.8017836809158325 });
    expect(length3(vec3(1, 2, 3))).toBe(3.7416574954986572);
    expect(normalize3(vec3(1, 2, 3))).toEqual({ x: 0.26726123690605164, y: 0.5345224738121033, z: 0.8017836809158325 });
  });

  test("VectorNormalize leaves signed zeros and underflowed input unchanged", () => {
    const small = vec3(1e-30, -0, 0);
    expect(length3(small)).toBe(0);
    expect(normalize3(small)).toEqual({ x: 1.0000000031710769e-30, y: -0, z: 0 });
    expect(normalize3(vec3(0, -0, 0))).toEqual({ x: 0, y: -0, z: 0 });
  });

  test("flat movement angles preserve the native zero pitch signs", () => {
    expect(normalize3(vec3(127, 0, 0))).toEqual({ x: 1, y: 0, z: 0 });
    expect(angleVectors(vec3(0, 0, 0))).toEqual({
      forward: { x: 1, y: 0, z: -0 }, right: { x: 0, y: -1, z: -0 }, up: { x: 0, y: 0, z: 1 },
    });
  });

  test("AngleVectors stores radians and trigonometric values before products", () => {
    expect(angleVectors(vec3(0, 90, 0))).toEqual({
      forward: { x: -4.371138828673793e-8, y: 1, z: -0 },
      right: { x: 1, y: 4.371138828673793e-8, z: -0 },
      up: { x: 0, y: 0, z: 1 },
    });
    expect(angleVectors(vec3(-17.35, 123.456, 21.5))).toEqual({
      forward: { x: -0.5262129306793213, y: 0.7963491678237915, z: 0.29820796847343445 },
      right: { x: 0.7160030603408813, y: 0.6041205525398254, z: -0.34982573986053467 },
      up: { x: 0.45873701572418213, y: -0.029434993863105774, z: 0.8880844712257385 },
    });
  });

  test("vectoangles stores negative yaw before adding 360 at a feedback byte boundary", () => {
    const angles = vectorToAngles(vec3(
      0.00009999999747378752,
      -0.004073592834174633,
      0,
    ));
    expect(angles).toEqual({ x: -0, y: 271.40625, z: 0 });
    expect(Math.trunc(angles.y / 360 * 256) | 0).toBe(193);
  });

  test("QVM vectoangles stores the horizontal length before pitch and feedback conversion", () => {
    const angles = vectorToAngles(vec3(
      0.00009999999747378752,
      0.00003333333370392211,
      0.0000025876518066070275,
    ));
    // Native GCC produced {-1.40625, 18.43494987487793, 0} and byte -1.
    // The canonical 32-bit QVM stores the atan2 results before its float ops.
    expect(angles).toEqual({ x: -1.4062498807907104, y: 18.434947967529297, z: 0 });
    expect(Math.trunc(angles.x / 360 * 256) | 0).toBe(0);
  });

  test("vectoangles preserves source signs, axes, diagonals, and float32 extremes", () => {
    expect(Object.is(vectorToAngles(vec3(1, 0, 0)).x, -0)).toBe(true);
    expect(Object.is(vectorToAngles(vec3(1, 0, -0)).x, 0)).toBe(true);
    expect(vectorToAngles(vec3(-0, 0, 1))).toEqual({ x: -90, y: 0, z: 0 });
    expect(vectorToAngles(vec3(0, 0, 0))).toEqual({ x: -270, y: 0, z: 0 });
    expect(vectorToAngles(vec3(1, 1, 1))).toEqual({
      x: -35.26438903808594,
      y: 45,
      z: 0,
    });
    expect(vectorToAngles(vec3(3.4028234663852886e+38, 3.4028234663852886e+38, 1)))
      .toEqual({ x: -0, y: 45, z: 0 });
    expect(vectorToAngles(vec3(2 ** -149, 2 ** -149, 2 ** -149)))
      .toEqual({ x: -90, y: 45, z: 0 });
  });

  test("native 1000ms movement replay first and last command angles", () => {
    expect(angleVectors(vec3(0, 100 * 360 / 65536, 0))).toEqual({
      forward: { x: 0.9999540448188782, y: 0.009587232954800129, z: -0 },
      right: { x: 0.009587232954800129, y: -0.9999540448188782, z: -0 },
      up: { x: 0, y: 0, z: 1 },
    });
    expect(angleVectors(vec3(0, 12500 * 360 / 65536, 0))).toEqual({
      forward: { x: 0.363827645778656, y: 0.931466281414032, z: -0 },
      right: { x: 0.931466281414032, y: -0.363827645778656, z: -0 },
      up: { x: 0, y: 0, z: 1 },
    });
  });

  test("cross and projection preserve intermediate float results and nonunit behavior", () => {
    expect(cross3(vec3(12345.678, -0.0001234, 99.75), vec3(-0.1234567, 89123.4, 1 / 3))).toEqual({ x: -8890059, y: -4127.541015625, z: 1100288768 });
    expect(cross3(vec3(1, 1.0000001192092896, 1), vec3(0, 1.0000001192092896, 1.000000238418579))).toEqual({ x: 2.384185791015625e-7, y: -1.000000238418579, z: 1.0000001192092896 });
    expect(projectPointOnPlane(vec3(123.456, -78.9, 0.123), vec3(0.2, 0.3, 0.4))).toEqual({ x: 120.91046142578125, y: -82.71830749511719, z: -4.968072891235352 });
    expect(projectPointOnPlane(vec3(1, 2, 3), vec3(0, 0, 2))).toEqual({ x: 1, y: 2, z: 2.25 });
  });

  test("rotation follows the source's two matrix multiplications", () => {
    const direction = vec3(0.26726123690605164, 0.5345224738121033, 0.8017836809158325);
    const point = vec3(123.456, -78.9, 0.123);
    expect(perpendicularVector(direction)).toEqual({ x: 0.963624119758606, y: -0.14824987947940826, z: -0.2223748415708542 });
    expect(rotatePointAroundVector(direction, point, 37)).toEqual({ x: 136.218505859375, y: -4.438802719116211, z: -53.771976470947266 });
    expect(rotatePointAroundVector(vec3(0, 0, 2), point, 37)).toEqual({ x: 193.56275939941406, y: -103.45404052734375, z: 0.492000013589859 });
    expect(rotatePointAroundVector(vec3(0, 0, 1), vec3(1, 0, 0), 90)).toEqual({ x: -4.371138828673793e-8, y: 1, z: 0 });
  });
});

describe("Quake angle conventions", () => {
  test("zero angles face +x with right -y and up +z", () => {
    const vectors = angleVectors(vec3(0, 0, 0));
    expectVec3Close(vectors.forward, vec3(1, 0, 0));
    expectVec3Close(vectors.right, vec3(0, -1, 0));
    expectVec3Close(vectors.up, vec3(0, 0, 1));
  });

  test("yaw, pitch, and axis handedness match q_math.c", () => {
    const yaw = angleVectors(vec3(0, 90, 0));
    expectVec3Close(yaw.forward, vec3(0, 1, 0));
    expectVec3Close(yaw.right, vec3(1, 0, 0));

    const pitch = angleVectors(vec3(90, 0, 0));
    expectVec3Close(pitch.forward, vec3(0, 0, -1));

    const axis = anglesToAxis(vec3(0, 90, 0));
    expectVec3Close(axis[0], vec3(0, 1, 0));
    expectVec3Close(axis[1], vec3(-1, 0, 0));
    expectVec3Close(axis[2], vec3(0, 0, 1));
  });

  test("converts direction vectors to Quake pitch, yaw, roll", () => {
    expectVec3Close(vectorToAngles(vec3(1, 0, 0)), vec3(0, 0, 0));
    expectVec3Close(vectorToAngles(vec3(0, 1, 0)), vec3(0, 90, 0));
    expectVec3Close(vectorToAngles(vec3(0, 0, 1)), vec3(-90, 0, 0));
    expectVec3Close(vectorToAngles(vec3(0, 0, 0)), vec3(-270, 0, 0));
  });

  test("uses Quake's 16-bit angular quantization", () => {
    expect(angleMod(360)).toBe(0);
    expect(angleNormalize360(-1)).toBe(359.000244140625);
    expect(angleNormalize180(181)).toBe(-179.000244140625);
    expect(angleDelta(10, 350)).toBe(20.0006103515625);
  });
});

describe("planes, rotation, and bounds", () => {
  test("preserves q_math.c projection semantics for a non-unit normal", () => {
    expect(projectPointOnPlane(vec3(1, 2, 3), vec3(0, 0, 2))).toEqual(vec3(1, 2, 2.25));
  });

  test("finds and rotates perpendicular vectors", () => {
    expectVec3Close(perpendicularVector(vec3(1, 0, 0)), vec3(0, 1, 0));
    expectVec3Close(
      rotatePointAroundVector(vec3(0, 0, 1), vec3(1, 0, 0), 90),
      vec3(0, 1, 0),
    );
  });

  test("grows cleared bounds and computes their enclosing radius", () => {
    let bounds = emptyBounds();
    bounds = addPointToBounds(bounds, vec3(-2, 3, 1));
    bounds = addPointToBounds(bounds, vec3(4, -1, -6));
    expect(bounds).toEqual({ min: vec3(-2, -1, -6), max: vec3(4, 3, 1) });
    expect(radiusFromBounds(bounds)).toBeCloseTo(Math.sqrt(61), 6);
  });

  test("AddPointToBounds retains signed-zero bounds when comparisons are equal", () => {
    const bounds = { min: vec3(0, -0, 0), max: vec3(0, -0, 0) };
    expect(addPointToBounds(bounds, vec3(-0, 0, -0))).toEqual(bounds);
  });

  test("AddPointToBounds leaves unordered coordinates unchanged", () => {
    // q_math.c:1070 updates each bound only after its strict comparison succeeds.
    const bounds = { min: vec3(-1, -2, -3), max: vec3(1, 2, 3) };
    expect(addPointToBounds(bounds, vec3(NaN, -4, 4))).toEqual({
      min: vec3(-1, -4, -3), max: vec3(1, 2, 4),
    });
    expect(addPointToBounds(bounds, vec3(-Infinity, Infinity, NaN))).toEqual({
      min: vec3(-Infinity, -2, -3), max: vec3(1, Infinity, 3),
    });
    expect(addPointToBounds({ min: vec3(NaN, -2, -3), max: vec3(1, NaN, 3) }, vec3(-4, 4, 0)))
      .toEqual({ min: vec3(NaN, -2, -3), max: vec3(1, NaN, 3) });
  });

  test("RadiusFromBounds selects the maximum bound after an unordered comparison", () => {
    // q_math.c:1050 chooses b when fabs(mins[i]) > fabs(maxs[i]) is false.
    expect(radiusFromBounds({ min: vec3(NaN, -4, 0), max: vec3(3, 0, 0) })).toBe(5);
    expect(radiusFromBounds({ min: vec3(-3, NaN, 0), max: vec3(0, 4, 0) })).toBe(5);
    expect(radiusFromBounds({ min: vec3(-3, 0, NaN), max: vec3(0, 0, 4) })).toBe(5);
    expect(radiusFromBounds({ min: vec3(-3, -4, 0), max: vec3(NaN, 0, 0) })).toBeNaN();
  });

  test("builds clockwise planes and rejects degenerate triangles", () => {
    const plane = planeFromPoints(vec3(0, 0, 2), vec3(1, 0, 2), vec3(0, 1, 2));
    expect(plane).toEqual({ normal: vec3(0, 0, -1), distance: -2 });
    if (plane !== null) {
      expect(distanceToPlane(plane, vec3(0, 0, 1))).toBe(1);
    }
    expect(planeFromPoints(vec3(0, 0, 0), vec3(1, 1, 1), vec3(2, 2, 2))).toBeNull();
  });

  test("PlaneFromPoints rejects zero and underflowed original normal lengths", () => {
    const origin = vec3(0, 0, 0);
    expect(planeFromPoints(origin, origin, origin)).toBeNull();
    expect(planeFromPoints(origin, vec3(1e-15, 0, 0), vec3(0, 1e-15, 0))).toBeNull();
  });

  test("PlaneFromPoints accepts an infinite original length even when normalization produces zero", () => {
    // q_math.c:326 tests VectorNormalize's returned length, not its output vector.
    // The finite cross product's square overflows, giving reciprocal +0.
    expect(planeFromPoints(vec3(0, 0, 0), vec3(1e10, 0, 0), vec3(0, 1e10, 0))).toEqual({
      normal: { x: 0, y: 0, z: -0 }, distance: 0,
    });
  });

  test("classifies boxes with Quake's plane-side bitmask", () => {
    const plane = { normal: vec3(1, 0, 0), distance: 0 };
    const front: Bounds = { min: vec3(0, -1, -1), max: vec3(2, 1, 1) };
    const back: Bounds = { min: vec3(-2, -1, -1), max: vec3(-0.1, 1, 1) };
    const crossing: Bounds = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
    expect(boxOnPlaneSide(front, plane)).toBe(1);
    expect(boxOnPlaneSide(back, plane)).toBe(2);
    expect(boxOnPlaneSide(crossing, plane)).toBe(3);
  });
});

describe("column-major matrices", () => {
  test("identity leaves vectors and matrices unchanged", () => {
    const identity = identityMat4();
    const value = vec4(1, 2, 3, 1);
    expect(transformVec4(identity, value)).toEqual(value);
    expect(multiplyMat4(identity, identity)).toEqual(identity);
  });

  test("multiplies transforms in documented column-vector order", () => {
    const translation: Mat4 = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      10, 20, 30, 1,
    ];
    const scale: Mat4 = [
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 4, 0,
      0, 0, 0, 1,
    ];
    const combined = multiplyMat4(translation, scale);
    expect(transformVec4(combined, vec4(1, 1, 1, 1))).toEqual(vec4(12, 23, 34, 1));
  });

  test("lookAt maps the eye to origin and target down -z", () => {
    const view = lookAtMat4(vec3(0, 0, 5), vec3(0, 0, 0), vec3(0, 1, 0));
    expectVec4Close(transformVec4(view, vec4(0, 0, 5, 1)), vec4(0, 0, 0, 1));
    expectVec4Close(transformVec4(view, vec4(0, 0, 0, 1)), vec4(0, 0, -5, 1));
  });

  test("perspective maps near and far planes to OpenGL NDC depth", () => {
    const projection = perspectiveMat4(90, 1, 1, 11);
    const near = transformVec4(projection, vec4(0, 0, -1, 1));
    const far = transformVec4(projection, vec4(0, 0, -11, 1));
    expect(near.z / near.w).toBeCloseTo(-1, 6);
    expect(far.z / far.w).toBeCloseTo(1, 6);
  });
});
