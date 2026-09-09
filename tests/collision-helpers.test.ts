// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { collisionChecksum, collisionLumpChecksum } from "../src/collision/checksum.ts";
import type { CollisionChecksumLump } from "../src/collision/checksum.ts";
import { blockChecksum } from "../src/core/md4.ts";
import { CollisionWorld, collisionVectorDistanceSquared } from "../src/collision/world.ts";
import { diagnosticCollisionMap } from "../src/collision/map-resource.ts";
import type { CollisionBrush } from "../src/collision/map-resource.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { vec3 } from "../src/core/math.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

function brushWorld() {
  const source = parseBsp(renderBspFixture([{ shader: "fixture", lightmap: -1 }, { shader: "fixture", lightmap: -1 }], []));
  const data = diagnosticCollisionMap(source, null);
  const bounds = { min: vec3(-2, -2, -2), max: vec3(2, 2, 2) };
  const brushes: CollisionBrush[] = Array.from({ length: 5 }, () => ({ bounds, shader: 0, contents: 1, firstSide: 0, sideCount: 0, checkCount: 0 }));
  const reads: number[] = [], leafBrushes = [0, 1, 2, 1, 3, 4];
  const map = { ...data, brushes,
    planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0, signbits: 0 }],
    nodes: [{ plane: 0, children: [ -1, -2 ] satisfies readonly [number, number] }],
    leaves: [0, 3].map(firstBrush => ({ firstBrush, brushCount: 3, firstSurface: 0, surfaceCount: 0, area: 0, cluster: 0 })),
    leafBrushes: { length: leafBrushes.length, at(index: number): number {
      reads.push(index); const brush = leafBrushes[index]; if (brush === undefined) throw new RangeError("Fixture leaf brush missing"); return brush;
    } },
  };
  const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  return { world, map, brushes, reads, bounds: { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) } };
}

test("CM_VectorDistanceSquared stores the displacement before its squared sum", () => {
  expect(collisionVectorDistanceSquared(vec3(-2, 5, 8), vec3(1, 9, 8))).toBe(25);
  expect(collisionVectorDistanceSquared(vec3(2, 3, 4), vec3(2, 3, 4))).toBe(0);
  // 2^24 - (-1) rounds back to 2^24 at the source vector store.
  expect(collisionVectorDistanceSquared(vec3(-1, 0, 0), vec3(16777216, 0, 0))).toBe(281474976710656);
});

test("CM_BoxBrushes visits front first, deduplicates actual brush records and advances the world checkcount once", () => {
  const { world, map, brushes, reads, bounds } = brushWorld();
  const selected = world.boxBrushes(bounds);
  expect(selected).toHaveLength(5);
  for (const [index, brush] of selected.entries()) {
    const original = brushes[index];
    if (original === undefined) throw new Error("Missing borrowed brush fixture");
    expect(brush).toBe(original);
  }
  expect(reads).toEqual([0, 1, 2, 3, 4, 5]);
  expect(map.checkCount).toBe(1); expect(brushes.map(brush => brush.checkCount)).toEqual([1, 1, 1, 1, 1]);
  expect(world.counters.c_pointcontents).toBe(0); expect(world.counters.c_brush_traces).toBe(0);
  world.boxLeafnums(bounds); expect(map.checkCount).toBe(2);
  const second = world.boxBrushes(bounds); expect(second).toHaveLength(5); expect(map.checkCount).toBe(3);
});

test("CM_StoreBrushes marks the overflow candidate, stops that leaf and keeps visiting sibling leaves", () => {
  const { world, map, brushes, reads, bounds } = brushWorld();
  expect(world.boxBrushes(bounds, 1)).toEqual(brushes.slice(0, 1));
  expect(reads).toEqual([0, 1, 3, 4]);
  expect(brushes.map(brush => brush.checkCount)).toEqual([1, 1, 0, 1, 0]);
  reads.length = 0;
  expect(world.boxBrushes(bounds, 0)).toEqual([]);
  expect(reads).toEqual([0, 3]);
  expect(map.checkCount).toBe(2);
  expect(brushes.map(brush => brush.checkCount)).toEqual([2, 2, 0, 1, 0]);
});

test("CM_StoreBrushes excludes exact touching bounds and still marks rejected brushes", () => {
  const { world, brushes, bounds } = brushWorld();
  const first = brushes[0];
  if (first === undefined) throw new Error("Missing brush fixture");
  brushes[0] = { ...first, bounds: { min: vec3(1, -2, -2), max: vec3(4, 2, 2) } };
  expect(world.boxBrushes(bounds)).toEqual(brushes.slice(1));
  expect(brushes[0]?.checkCount).toBe(1);
  brushes[0] = { ...first, bounds: { min: vec3(-4, -2, -2), max: vec3(-1, 2, 2) } };
  expect(world.boxBrushes(bounds)).toEqual(brushes.slice(1));
  expect(brushes[0]?.checkCount).toBe(2);
  expect(world.boxBrushes(bounds, -1)).toEqual([]);
  expect(() => world.boxBrushes(bounds, 0.5)).toThrow("brush capacity");
});

test("CM_BoxBrushes preserves defined inverted and nonfinite bounds comparisons", () => {
  const { world, brushes } = brushWorld();
  expect(world.boxBrushes({ min: vec3(1, 1, 1), max: vec3(-1, -1, -1) })).toEqual(brushes.slice(0, 3));
  expect(world.boxBrushes({ min: vec3(-Infinity, -Infinity, -Infinity), max: vec3(Infinity, Infinity, Infinity) })).toEqual(brushes);
  expect(world.boxBrushes({ min: vec3(NaN, NaN, NaN), max: vec3(NaN, NaN, NaN) })).toEqual(brushes);
});

test("CM_BoxBrushes preserves earlier checkcount writes when a later BSP child is invalid", () => {
  const { world, map, brushes, bounds } = brushWorld();
  const firstNode = map.nodes[0];
  if (firstNode === undefined) throw new Error("Missing BSP fixture root");
  map.nodes[0] = { ...firstNode, children: [-1, 999] };
  expect(() => world.boxBrushes(bounds)).toThrow("collision topology index 999");
  expect(brushes.map(brush => brush.checkCount)).toEqual([1, 1, 1, 0, 0]);
});

test("CM_LumpChecksum folds the selected borrowed byte range and keeps unsigned output", () => {
  const raw = new TextEncoder().encode("prefixabcending");
  expect(collisionLumpChecksum(raw, { offset: 6, length: 3 })).toBe(0x5da10e2e);
  expect(collisionLumpChecksum(raw, { offset: raw.length, length: 0 })).toBe(0xc6f640b7);
  const container = new Uint8Array(raw.length + 9); container.set(raw, 5);
  expect(collisionLumpChecksum(container.subarray(5, 5 + raw.length), { offset: 6, length: 3 })).toBe(0x5da10e2e);
  for (const lump of [{ offset: -1, length: 1 }, { offset: 0, length: -1 }, { offset: raw.length, length: 1 }, { offset: 0.5, length: 1 }]) {
    expect(() => collisionLumpChecksum(raw, lump)).toThrow("lump outside source allocation");
  }
});

test("CM_Checksum checks exactly eleven collision lumps in source order, independently of the map header and ignored payloads", () => {
  const bytes = Uint8Array.from({ length: 51 }, (_, index) => index + 1);
  const lumps: CollisionChecksumLump[] = Array.from({ length: 17 }, (_, index) => ({ offset: index * 3, length: 3 }));
  const checksum = collisionChecksum(bytes, lumps);
  for (let index = 0; index < 17; index++) {
    const changed = bytes.slice(); changed[index * 3] = 255;
    const relevant = ![0, 11, 12, 14, 15, 16].includes(index);
    expect(collisionChecksum(changed, lumps) === checksum).toBe(!relevant);
  }
  // RFC 1320 "abc" folded digest, encoded little-endian eleven times.
  const allSame: CollisionChecksumLump[] = Array.from({ length: 17 }, () => ({ offset: 0, length: 3 }));
  const expected = Uint8Array.from({ length: 44 }, (_, index) => {
    switch (index % 4) { case 0: return 0x2e; case 1: return 0x0e; case 2: return 0xa1; default: return 0x5d; }
  });
  expect(collisionChecksum(new TextEncoder().encode("abc"), allSame)).toBe(blockChecksum(expected));
  expect(checksum).not.toBe(blockChecksum(bytes));
  const order = [1, 4, 6, 5, 2, 9, 8, 7, 3, 13, 10], calls: number[] = [];
  const header: CollisionChecksumLump[] = Array.from({ length: 17 }, (_, index) => ({
    get offset(): number { calls.push(index); return index * 3; }, length: 3,
  }));
  expect(collisionChecksum(bytes, header)).toBe(checksum); expect(calls).toEqual(order);
  // Irrelevant malformed entries are never read by this compiled helper.
  allSame[0] = { offset: -1, length: -1 };
  expect(collisionChecksum(new TextEncoder().encode("abc"), allSame)).toBe(blockChecksum(expected));
  expect(() => collisionChecksum(bytes, [])).toThrow("missing header lump 1");
});
