import { describe, expect, test } from "bun:test";
import { dot3, vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { byteToDirection, directionToByte } from "../src/shared/direction-byte.ts";

const NUM_VERTEX_NORMALS = 162;

function directionTable(): readonly Vec3[] {
  const directions: Vec3[] = [];
  for (let byte = 0; byte < NUM_VERTEX_NORMALS; byte++) directions.push(byteToDirection(byte));
  return directions;
}

function tableHash(directions: readonly Vec3[]): number {
  const bytes = new Uint8Array(directions.length * 12);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < directions.length; index++) {
    const direction = directions[index];
    if (direction === undefined) throw new Error("Missing direction fixture");
    view.setFloat32(index * 12, direction.x, true);
    view.setFloat32(index * 12 + 4, direction.y, true);
    view.setFloat32(index * 12 + 8, direction.z, true);
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

describe("Quake direction-byte codec", () => {
  test("contains all 162 source normals with exact float32 values and order", () => {
    const directions = directionTable();
    expect(directions).toHaveLength(NUM_VERTEX_NORMALS);
    expect(tableHash(directions)).toBe(0x32826cc9);
    expect(directions[0]).toEqual(vec3(-0.525731, 0, 0.850651));
    expect(directions[161]).toEqual(vec3(-0.688191, -0.587785, -0.425325));
    for (const direction of directions) expect(Object.isFrozen(direction)).toBe(true);
  });

  test("round-trips every source normal to its original byte", () => {
    const directions = directionTable();
    for (let byte = 0; byte < directions.length; byte++) {
      const direction = directions[byte];
      if (direction === undefined) throw new Error("Missing direction fixture");
      expect(directionToByte(direction)).toBe(byte);
    }
  });

  test("matches native q_math.c fixtures", () => {
    const fixtures: readonly (readonly [Vec3, number])[] = [
      [vec3(1, 0, 0), 52],
      [vec3(0, 1, 0), 32],
      [vec3(0, 0, 1), 5],
      [vec3(-1, 0, 0), 143],
      [vec3(0.2, -0.7, 0.5), 108],
      [vec3(-0.61, 0.18, -0.77), 153],
      [vec3(1, 1, 1), 50],
    ];
    for (const [direction, byte] of fixtures) expect(directionToByte(direction)).toBe(byte);
  });

  test("keeps the first index when maximum float32 dots tie", () => {
    const tieDirection = vec3(-0.525731 + -0.262866, 0.951056, 0.850651 + -0.162460);
    const first = byteToDirection(21);
    const second = byteToDirection(24);
    expect(dot3(tieDirection, first)).toBe(dot3(tieDirection, second));
    expect(directionToByte(tieDirection)).toBe(21);
  });

  test("maps null and the zero vector to byte zero", () => {
    expect(directionToByte(null)).toBe(0);
    expect(directionToByte(vec3(0, 0, 0))).toBe(0);
  });

  test("returns the zero vector for every safe out-of-range integer", () => {
    for (const byte of [-1, NUM_VERTEX_NORMALS, 255, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      expect(byteToDirection(byte)).toEqual(vec3(0, 0, 0));
    }
  });

  test("rejects values that cannot represent a source integer argument", () => {
    for (const byte of [0.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => byteToDirection(byte)).toThrow(RangeError);
    }
  });
});
