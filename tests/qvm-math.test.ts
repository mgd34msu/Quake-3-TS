import { expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { qvmAngleMod, qvmAngleVectors, qvmAnglesToAxis, qvmRotatePointAroundVector } from "../src/core/qvm-math.ts";

function bits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function vectorBits(value: Vec3): readonly [number, number, number] {
  return [bits(value.x), bits(value.y), bits(value.z)];
}

test("QVM AngleMod rounds before integer conversion at actual weapon spin transitions", () => {
  // Untouched cg_weapons/q_math executed in the original VM interpreter:
  // /tmp/quake3-cg-weapons-reference-EJwrco/runtime/cgweapons/qconsole.log, VECTOR 30.
  expect(bits(qvmAngleMod(187.53111267089844))).toBe(1127974904);
  expect(bits(qvmAngleMod(195.46873474121094))).toBe(1128495104);
});

test("QVM AngleMod keeps angle16 wrapping and positive zero", () => {
  for (const angle of [0, -0, 360, -360, 720]) expect(bits(qvmAngleMod(angle))).toBe(0);
  expect(qvmAngleMod(360 / 65536)).toBe(360 / 65536);
  expect(qvmAngleMod(-360 / 65536)).toBe(65535 * 360 / 65536);
  expect(qvmAngleMod(90)).toBe(90);
});

test("QVM AngleMod uses CVFI4 indefinite conversion outside the signed range", () => {
  // Original interpreter CVFI4 returns INT_MIN here, whose angle16 mask is zero.
  for (const angle of [12000001, -12000001, Infinity, -Infinity, NaN]) {
    expect(bits(qvmAngleMod(angle))).toBe(0);
  }
});

test("QVM AngleVectors uses the q3lcc folded float32 degrees constant", () => {
  // Original q3lcc q_math.asm: CNSTF4 1016003125, MULF4; cg_ents time47.
  expect(bits(qvmAngleVectors(vec3(0, 8.26171875, 0)).forward.y)).toBe(0x3e1324ca);
});

test("QVM AnglesToAxis subtracts right from positive zero", () => {
  const axis = qvmAnglesToAxis(vec3(0, 0, 0));
  expect(bits(axis[1].x)).toBe(0);
  expect(bits(axis[1].z)).toBe(0);
  expect(bits(axis[0].z)).toBe(0x80000000);
});

// Unchanged pinned q_math.c, compiled by original q3lcc/q3asm and executed with
// cg_syscalls in the original VM interpreter. /tmp/q3-cg-ents-math-oracle-aVPcrQ
// output.latest.log SHA256 d1f9304785441c8e11d092e9a4d379b5670da203f367270bb4080f0d0018d34a.
// Shipped base/mission cgame constants also match: AngleVectors at20261/91712,
// rotation at16332/87237; /tmp/q3-qvm-angle-retail-i6QNZc/inspect.ts.
const angleFixtures: readonly {
  readonly name: string;
  readonly angles: Vec3;
  readonly forward: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly left: readonly [number, number, number];
}[] = [
  { name: "zero", angles: vec3(0, 0, 0),
    forward: [0x3f800000, 0, 0x80000000], right: [0, 0xbf800000, 0x80000000],
    up: [0, 0, 0x3f800000], left: [0, 0x3f800000, 0] },
  { name: "runtime negative zero", angles: vec3(-0, -0, -0),
    forward: [0x3f800000, 0x80000000, 0], right: [0x80000000, 0xbf800000, 0],
    up: [0, 0, 0x3f800000], left: [0, 0x3f800000, 0] },
  { name: "item clock 47", angles: vec3(0, 8.26171875, 0),
    forward: [0x3f7d57de, 0x3e1324ca, 0x80000000], right: [0x3e1324ca, 0xbf7d57de, 0x80000000],
    up: [0, 0, 0x3f800000], left: [0xbe1324ca, 0x3f7d57de, 0] },
  { name: "near axes", angles: vec3(0.000001, 89.99999, -0.000001),
    forward: [0x345110b4, 0x3f800000, 0xb295ec32], right: [0x3f800000, 0xb45110b4, 0x3295ec32],
    up: [0xb295ec30, 0x3295ec34, 0x3f800000], left: [0xbf800000, 0x345110b4, 0xb295ec32] },
  { name: "non-axis", angles: vec3(23, -47, 81),
    forward: [0x3f20b660, 0xbf2c57cb, 0xbec80de9], right: [0xbec15598, 0x3e33c50d, 0xbf68bf7e],
    up: [0xbf2e3ff1, 0xbf37e2d6, 0x3e137466], left: [0x3ec15598, 0xbe33c50d, 0x3f68bf7e] },
  { name: "negative and complete turns", angles: vec3(-180, 360, -720),
    forward: [0xbf800000, 0xb43bbd2e, 0xb3bbbd2e], right: [0x343bbd30, 0xbf800000, 0xb4bbbd2e],
    up: [0x33bbbd25, 0x34bbbd2f, 0xbf800000], left: [0xb43bbd30, 0x3f800000, 0x34bbbd2e] },
  { name: "large angles", angles: vec3(36000.25, -65536.5, 1048576),
    forward: [0x3f7575e5, 0xbe91617f, 0xbb8e628e], right: [0x3d950b28, 0x3e6c70c6, 0x3f786274],
    up: [0x3e8c8ada, 0x3f6e3d54, 0xbe77ddd6], left: [0xbd950b28, 0xbe6c70c6, 0xbf786274] },
];

for (const fixture of angleFixtures) {
  test(`original QVM raw angle vectors and axes: ${fixture.name}`, () => {
    const vectors = qvmAngleVectors(fixture.angles);
    expect(vectorBits(vectors.forward)).toEqual(fixture.forward);
    expect(vectorBits(vectors.right)).toEqual(fixture.right);
    expect(vectorBits(vectors.up)).toEqual(fixture.up);
    const axis = qvmAnglesToAxis(fixture.angles);
    expect(axis.map(vectorBits)).toEqual([fixture.forward, fixture.left, fixture.up]);
  });
}

const rotationFixtures: readonly {
  readonly name: string;
  readonly direction: Vec3;
  readonly degrees: number;
  readonly expected: readonly [number, number, number];
}[] = [
  { name: "Z item angle", direction: vec3(0, 0, 1), degrees: 8.26171875, expected: [0x401a42d5, 0xc02b9d4d, 0x40a00000] },
  { name: "Z negative", direction: vec3(0, 0, 1), degrees: -123.5, expected: [0xc066c106, 0xbc43f780, 0x40a00000] },
  { name: "Z large", direction: vec3(0, 0, 1), degrees: 36000.25, expected: [0x4000d842, 0xc03f6f23, 0x40a00000] },
  { name: "X item angle", direction: vec3(1, 0, 0), degrees: 8.26171875, expected: [0x40000000, 0xc06bfd66, 0x40908b78] },
  { name: "X negative", direction: vec3(1, 0, 0), degrees: -123.5, expected: [0x40000000, 0x40ba685e, 0xbe841c20] },
  { name: "X large", direction: vec3(1, 0, 0), degrees: 36000.25, expected: [0x40000000, 0xc041687c, 0x409f9350] },
  { name: "non-axis item angle", direction: vec3(0.26726124, 0.53452248, 0.8017837), degrees: 8.26171875, expected: [0x402de494, 0xc03a817d, 0x40968511] },
  { name: "non-axis negative", direction: vec3(0.26726124, 0.53452248, 0.8017837), degrees: -123.5, expected: [0xc083ce54, 0x4077c9fe, 0x401d583a] },
  { name: "non-axis large", direction: vec3(0.26726124, 0.53452248, 0.8017837), degrees: 36000.25, expected: [0x40016e65, 0xc03febfa, 0x409fbc42] },
];

for (const fixture of rotationFixtures) {
  test(`original QVM raw rotation: ${fixture.name}`, () => {
    expect(vectorBits(qvmRotatePointAroundVector(fixture.direction, vec3(2, -3, 5), fixture.degrees))).toEqual(fixture.expected);
  });
}

test("all 2048 item-clock axes match the original QVM raw-float fingerprint", () => {
  // Native oracle rows: clock0..2047, axis0..2, x/y/z, uint32 little-endian.
  const data = new Uint8Array(2048 * 9 * 4);
  const view = new DataView(data.buffer);
  let offset = 0;
  for (let clock = 0; clock < 2048; clock++) {
    const axis = qvmAnglesToAxis(vec3(0, clock * 360 / 2048, 0));
    for (const vector of axis) for (const value of vectorBits(vector)) {
      view.setUint32(offset, value, true);
      offset += 4;
    }
  }
  expect(Bun.CryptoHasher.hash("sha256", data, "hex"))
    .toBe("63612d776a6ab0fffd56704a8525e88cbc221f92e94a95ed4749e672dfcaeee5");
});
