// R_InitSkyTexCoords/MakeSkyVec, id Software renderer/tr_sky.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { cloudTexCoord, SkyBuilder, skyVector } from "../src/render/sky.ts";
import type { Vec2 } from "../src/core/math.ts";
import type { DeformGeometry } from "../src/render/deform.ts";

function coordinateHash(coordinates: readonly Vec2[]): number {
  const word = new DataView(new ArrayBuffer(4)); let hash = 2166136261;
  for (const coordinate of coordinates) for (const value of [coordinate.x, coordinate.y]) {
    if (Number.isNaN(value)) word.setUint32(0, 0x7fc00000, true);
    else word.setFloat32(0, value, true);
    for (let byte = 0; byte < 4; byte++) hash = Math.imul(hash ^ word.getUint8(byte), 16777619);
  }
  return hash >>> 0;
}

const zero = { x: 0, y: 0, z: 0 };
function cube(): readonly DeformGeometry[] {
  return Array.from({ length: 6 }, (_, face) => ({
    vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(pair => {
      const s = pair[0], t = pair[1]; if (s === undefined || t === undefined) throw new Error("fixture sky corner missing");
      return { position: skyVector(face, s, t, 100), normal: zero, texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 }, color: { x: 0, y: 0, z: 0, w: 0 } };
    }), indices: [0, 1, 2, 0, 2, 3],
  }));
}

test("complete native cloud tables preserve source float operations, zero height and negative-height NaNs", () => {
  // Unchanged tr_sky.c + q_math.c + common.c, GCC16.2.1 x86_64 SSE,
  // -O2 -fno-fast-math -ffp-contract=off. FNV-1a over little-endian UV words;
  // only NaN payload/sign are canonicalized, since those are not portable values.
  const cases = [
    { height: 512, hash: 936260825, nan: 0 }, { height: 128, hash: 2470918145, nan: 0 },
    { height: 1024, hash: 2525540189, nan: 0 }, { height: 0, hash: 1913681953, nan: 0 },
    { height: -128, hash: 3245862449, nan: 216 }, { height: -4096, hash: 1483045029, nan: 968 },
    { height: -8192, hash: 891264741, nan: 0 },
  ];
  for (const fixture of cases) {
    const table = Array.from({ length: 6 }, (_, face) => Array.from({ length: 81 }, (_, index) =>
      cloudTexCoord(face, (index % 9 - 4) / 4, (Math.floor(index / 9) - 4) / 4, fixture.height))).flat();
    expect(table).toHaveLength(486);
    expect(coordinateHash(table)).toBe(fixture.hash);
    expect(table.flatMap(value => [value.x, value.y]).filter(Number.isNaN)).toHaveLength(fixture.nan);
  }
});

test("renderer-global BSS table is overwritten on every initialization and prior geometry stays owned", () => {
  const sky = new SkyBuilder(), portals = cube();
  sky.clip(portals, zero);
  const bss = sky.build(zero, 1024);
  expect(bss.box.map(face => face.face)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(bss.clouds.vertices).toHaveLength(405);
  expect(bss.clouds.vertices.every(vertex => vertex.texCoord.x === 0 && vertex.texCoord.y === 0)).toBe(true);
  sky.initializeCloudCoordinates(512);
  const first = sky.build(zero, 1024), firstHash = coordinateHash(first.clouds.vertices.map(vertex => vertex.texCoord));
  sky.initializeCloudCoordinates(-128);
  const second = sky.build(zero, 1024);
  expect(second.clouds.vertices.some(vertex => Number.isNaN(vertex.texCoord.x))).toBe(true);
  expect(coordinateHash(second.clouds.vertices.map(vertex => vertex.texCoord))).not.toBe(firstHash);
  expect(coordinateHash(first.clouds.vertices.map(vertex => vertex.texCoord))).toBe(firstHash);
  sky.initializeCloudCoordinates(512);
  expect(sky.build(zero, 1024)).toEqual(first);
  sky.initializeCloudCoordinates(0);
  expect(coordinateHash(sky.build(zero, 1024).clouds.vertices.map(vertex => vertex.texCoord))).not.toBe(firstHash);
  expect(bss.clouds.vertices.every(vertex => vertex.texCoord.x === 0 && vertex.texCoord.y === 0)).toBe(true);
});

test("MakeSkyVec stores float32 box size and products before axis mapping", () => {
  const size = Math.fround(1024 / 1.75), product = Math.fround(Math.fround(0.1) * size);
  expect(skyVector(0, 0.1, -0.1, 1024 / 1.75)).toEqual({ x: size, y: -product, z: -product });
  const sky = new SkyBuilder(); sky.clip(cube(), zero);
  const geometry = sky.build(zero, 1024);
  expect(geometry.box[0]?.geometry.vertices[0]?.position).toEqual({ x: size, y: size, z: -size });
  expect(geometry.box[0]?.strips).toHaveLength(8);
  expect(geometry.box[0]?.strips[0]).toEqual([0, 9, 1, 10, 2, 11, 3, 12, 4, 13, 5, 14, 6, 15, 7, 16, 8, 17]);
  expect(() => sky.initializeCloudCoordinates(Number.NaN)).toThrow("finite float32");
  expect(() => sky.initializeCloudCoordinates(Number.POSITIVE_INFINITY)).toThrow("finite float32");
});

test("sky clipping owns per-surface bounds separately from subsequent geometry generation", () => {
  const sky = new SkyBuilder();
  sky.clip(cube(), zero);
  const first = sky.build(zero, 1024);
  sky.clip([], zero);
  expect(sky.build(zero, 1024)).toEqual({ box: [], clouds: { vertices: [], indices: [] } });
  expect(first.box).toHaveLength(6);
  sky.clip(cube(), zero);
  expect(sky.build(zero, 1024)).toEqual(first);
  expect(() => sky.clip([{ vertices: [], indices: [0, 1, 2] }], zero)).toThrow("sky index 0 outside 0");
});

test("source sky bounds retain faces whose row or column collapses only after subdivision clamping", () => {
  // Every source clip-plane distance stays within ON_EPSILON. The positive-Y
  // face wins the sum; the negative-Y point is skipped by DrawSkyPolygon.
  const cases = [
    { points: [{ x: 3 / 128, y: 1 / 128, z: 1 / 256 }, { x: 4 / 128, y: 2 / 128, z: 1 / 256 }, { x: -7 / 128, y: -1 / 512, z: 0 }],
      expected: [{ x: 1, y: 1, z: 0.25 }, { x: 1, y: 1, z: 0.5 }], strips: [[0, 1]] },
    { points: [{ x: 1 / 256, y: 1 / 128, z: 3 / 128 }, { x: 1 / 256, y: 2 / 128, z: 4 / 128 }, { x: 0, y: -1 / 512, z: -7 / 128 }],
      expected: [{ x: 0.25, y: 1, z: 1 }, { x: 0.5, y: 1, z: 1 }], strips: [] },
  ];
  for (const fixture of cases) {
    const sky = new SkyBuilder();
    sky.clip([{ vertices: fixture.points.map(position => ({ position, normal: zero, texCoord: { x: 0, y: 0 },
      lightmapCoord: { x: 0, y: 0 }, color: { x: 0, y: 0, z: 0, w: 0 } })), indices: [0, 1, 2] }], zero);
    const geometry = sky.build(zero, 1.75);
    expect(geometry.box.map(face => face.face)).toEqual([2]);
    expect(geometry.box[0]?.geometry.vertices.map(vertex => vertex.position)).toEqual(fixture.expected);
    expect(geometry.box[0]?.geometry.indices).toEqual([]);
    expect(geometry.box[0]?.strips).toEqual(fixture.strips);
    expect(geometry.clouds.vertices.map(vertex => vertex.position)).toEqual(fixture.expected);
    expect(geometry.clouds.indices).toEqual([]);
  }
});
