import { describe, expect, test } from "bun:test";
import { CollisionWorld } from "../src/collision/world.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { vec3 } from "../src/core/math.ts";

function topologyMap(): BspMap {
  const bounds = { min: vec3(-100, -100, -100), max: vec3(100, 100, 100) };
  return {
    entities: "", entityRecords: [], shaders: [], planes: [
      { normal: vec3(1, 0, 0), distance: 0 }, { normal: vec3(0, 1, 0), distance: 0 },
    ], nodes: [{ plane: 0, children: [1, 2], bounds },
      { plane: 1, children: [-1, -2], bounds }, { plane: 1, children: [-3, -4], bounds }],
    leaves: [0, 1, 2, 3].map(area => ({ cluster: area === 3 ? -1 : area, area, bounds,
      firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 })),
    leafBrushes: [], leafSurfaces: [], brushes: [], brushSides: [],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    surfaces: [], vertices: [], indices: [], fogs: [], lightmaps: [], lightGrid: [],
    visibility: { clusterCount: 3, bytesPerCluster: 1, bits: new Uint8Array([0b011, 0b111, 0b110]) },
  };
}

describe("BSP leaf topology", () => {
  test("point classification uses the positive side on an exact plane", () => {
    const world = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    expect(world.pointLeafnum(vec3(0, 0, 0))).toBe(0);
    expect(world.pointLeafnum(vec3(1, -1, 0))).toBe(1);
    expect(world.pointLeafnum(vec3(-1, 1, 0))).toBe(2);
    expect(world.pointLeafnum(vec3(-1, -1, 0))).toBe(3);
    expect(world.leafArea(3)).toBe(3); expect(world.leafCluster(3)).toBe(-1);
    expect(world.modelBounds(0)).toEqual({ min: vec3(-101, -101, -101), max: vec3(101, 101, 101) });
    expect(() => world.leafArea(4)).toThrow();
  });
  test("bounded leaf listing preserves front-first order, topnode and overflow lastLeaf", () => {
    const world = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const bounds = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
    expect(world.boxLeafnums(bounds)).toEqual({ leaves: [0, 1, 2, 3], topnode: 0, lastLeaf: 2, overflowed: false });
    expect(world.boxLeafnums(bounds, 2)).toEqual({ leaves: [0, 1], topnode: 0, lastLeaf: 2, overflowed: true });
    expect(world.boxLeafnums(bounds, 0)).toEqual({ leaves: [], topnode: 0, lastLeaf: 2, overflowed: true });
    expect(world.boxLeafnums({ min: vec3(0, 0, 0), max: vec3(1, 1, 1) })).toEqual({ leaves: [0], topnode: null, lastLeaf: 0, overflowed: false });
    expect(world.boxLeafnums({ min: vec3(-1, -1, -1), max: vec3(0, 0, 0) }).leaves).toEqual([3]);
    expect(world.boxLeafnums({ min: vec3(1, -1, -1), max: vec3(2, 1, 1) }).topnode).toBe(1);
    expect(() => world.boxLeafnums(bounds, -1)).toThrow();
  });
  test("slanted split uses sign-dependent corners", () => {
    const map = topologyMap();
    const world = new CollisionWorld({ ...map, planes: [{ normal: vec3(Math.SQRT1_2, -Math.SQRT1_2, 0), distance: 0 }, ...map.planes.slice(1)] }, { kind: "unaccounted" }, { kind: "disabled" });
    expect(world.boxLeafnums({ min: vec3(3, 0, -1), max: vec3(4, 1, 1) }).leaves).toEqual([0]);
    expect(world.boxLeafnums({ min: vec3(0, 3, -1), max: vec3(1, 4, 1) }).leaves).toEqual([2]);
    expect(world.boxLeafnums({ min: vec3(0, 0, -1), max: vec3(1, 1, 1) }).leaves).toEqual([0, 2]);
  });
  test("PVS reads keep invalid-source allocation-start semantics and valid visibility bits", () => {
    const world = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    expect(world.clusterCount).toBe(3);
    expect(world.clusterPVS(2).byteAt(0)).toBe(6);
    expect(world.clusterPVS(-1).byteAt(0)).toBe(3);
    expect(world.clusterPVS(999).byteAt(0)).toBe(3);
    expect(world.clusterPVS(-1).byteAt(2)).toBe(6);
    expect(world.clusterPVS(999).byteAt(2)).toBe(6);
    expect(world.clusterVisible(0, 1)).toBe(true); expect(world.clusterVisible(0, 2)).toBe(false);
    expect(world.clusterVisible(1, 2)).toBe(true); expect(world.clusterVisible(1, -1)).toBe(false);
    expect(() => world.clusterPVS(0.5)).toThrow("cluster must be an integer");
  });
  test("PVS no-vis reads use the retained source allocation for every source cluster", () => {
    const noVis = new CollisionWorld({ ...topologyMap(), visibility: null }, { kind: "unaccounted" }, { kind: "disabled" });
    for (const source of [-1, 0, 2, 999]) {
      const pvs = noVis.clusterPVS(source);
      expect(Array.from({ length: 32 }, (_, offset) => pvs.byteAt(offset))).toEqual(new Array<number>(32).fill(255));
      expect(() => pvs.byteAt(-1)).toThrow("outside stored visibility allocation");
      expect(() => pvs.byteAt(32)).toThrow("outside stored visibility allocation");
    }
    expect(noVis.clusterVisible(0, 2)).toBe(true);
  });
  test("PVS accessors read collision-owned loader storage independently of BSP input bytes", () => {
    for (const bits of [new Uint8Array([3, 7, 6]), Buffer.from([3, 7, 6])]) {
      const world = new CollisionWorld({ ...topologyMap(), visibility: { clusterCount: 3, bytesPerCluster: 1, bits } }, { kind: "unaccounted" }, { kind: "disabled" });
      const pvs = world.clusterPVS(1);
      expect(pvs.byteAt(0)).toBe(7);
      expect(world.clusterVisible(1, 2)).toBe(true);
      bits[1] = 0;
      expect(pvs.byteAt(0)).toBe(7);
      expect(world.clusterPVS(1).byteAt(0)).toBe(7);
      expect(world.clusterVisible(1, 2)).toBe(true);
    }
  });
  test("PVS source row stride and visibility presence are captured at collision load", () => {
    const visibility = { clusterCount: 3, bytesPerCluster: 1, bits: new Uint8Array([3, 7, 6]) };
    const map = { ...topologyMap() };
    map.visibility = visibility;
    const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
    const pvs = world.clusterPVS(1);
    visibility.bytesPerCluster = 2;
    visibility.clusterCount = 1;
    expect(pvs.byteAt(0)).toBe(7);
    expect(world.clusterPVS(1).byteAt(0)).toBe(7);
    expect(world.clusterPVS(2).byteAt(0)).toBe(6);
    expect(world.clusterCount).toBe(3);
    map.visibility = null;
    expect(world.clusterPVS(1).byteAt(0)).toBe(7);
    expect(world.clusterVisible(0, 2)).toBe(false);
    const noVis = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
    map.visibility = visibility;
    expect(noVis.clusterPVS(1).byteAt(0)).toBe(255);
    expect(noVis.clusterPVS(1).byteAt(31)).toBe(255);
    expect(noVis.clusterVisible(0, 2)).toBe(true);
  });
  test("PVS pointer offsets cross rows and reject only outside the stored allocation", () => {
    const bits = new Uint8Array([0x80, 7, 6]);
    const world = new CollisionWorld({ ...topologyMap(), visibility: { clusterCount: 3, bytesPerCluster: 1, bits } }, { kind: "unaccounted" }, { kind: "disabled" });
    const middle = world.clusterPVS(1), last = world.clusterPVS(2);
    expect(middle.byteAt(-1)).toBe(0x80);
    expect(middle.byteAt(-1 >> 3) & (1 << (-1 & 7))).toBe(0x80);
    expect(middle.byteAt(1)).toBe(6);
    expect(last.byteAt(-2)).toBe(0x80);
    expect(() => middle.byteAt(-2)).toThrow("PVS byte -1 outside stored visibility allocation of 11 bytes");
    for (let offset = 2; offset < 10; offset++) expect(middle.byteAt(offset)).toBe(0);
    expect(last.byteAt(8)).toBe(0);
    expect(() => middle.byteAt(10)).toThrow("PVS byte 11 outside stored visibility allocation of 11 bytes");
    expect(() => last.byteAt(9)).toThrow("PVS byte 11 outside stored visibility allocation of 11 bytes");
    expect(() => world.clusterPVS(-1).byteAt(-1)).toThrow("outside stored visibility allocation");
    for (const offset of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => middle.byteAt(offset)).toThrow("PVS byte offset must be a safe integer");
    }
  });
});

describe("area portal flooding", () => {
  test("parallel portal references preserve paths until the final close", () => {
    const world = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    expect(world.areaCount).toBe(4);
    expect(world.areasConnected(0, 0)).toBe(true); expect(world.areasConnected(0, 1)).toBe(false);
    world.adjustAreaPortalState(0, 1, true);
    world.adjustAreaPortalState(1, 0, true);
    world.adjustAreaPortalState(1, 2, true);
    expect(world.areasConnected(0, 2)).toBe(true);
    world.adjustAreaPortalState(0, 1, false);
    expect(world.areasConnected(0, 2)).toBe(true);
    world.adjustAreaPortalState(0, 1, false);
    expect(world.areasConnected(0, 2)).toBe(false);
    expect(world.areasConnected(1, 2)).toBe(true);
    expect(() => world.adjustAreaPortalState(0, 1, false)).toThrow("negative reference count");
    world.adjustAreaPortalState(0, 1, true);
    expect(world.areasConnected(0, 2)).toBe(false);
    world.adjustAreaPortalState(0, 1, true);
    expect(world.areasConnected(0, 2)).toBe(true);
    world.adjustAreaPortalState(-1, 99, true);
    expect(world.areasConnected(-1, 0)).toBe(false);
    expect(() => world.areasConnected(4, 0)).toThrow();
  });
  test("cycles reflood after a bridge closes and state belongs to each world", () => {
    const a = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" }), b = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    for (const [x, y] of [[0, 1], [1, 2], [2, 0], [2, 3]]) {
      if (x === undefined || y === undefined) throw new Error("portal fixture pair missing");
      a.adjustAreaPortalState(x, y, true);
    }
    expect(a.areasConnected(0, 3)).toBe(true); expect(b.areasConnected(0, 3)).toBe(false);
    a.adjustAreaPortalState(0, 1, false);
    expect(a.areasConnected(0, 1)).toBe(true);
    a.adjustAreaPortalState(2, 3, false);
    expect(a.areasConnected(0, 3)).toBe(false);
    a.adjustAreaPortalState(3, 3, true); a.adjustAreaPortalState(3, 3, false);
    expect(() => a.adjustAreaPortalState(3, 3, false)).toThrow();
  });
  test("area bits OR viewpoints and noAreas writes padded all-visible bits", () => {
    const world = new CollisionWorld(topologyMap(), { kind: "unaccounted" }, { kind: "disabled" });
    world.adjustAreaPortalState(0, 2, true);
    expect(world.areaBits(0)).toEqual(new Uint8Array([5]));
    const buffer = new Uint8Array([0x80, 0x12]);
    expect(world.writeAreaBits(buffer, 0)).toBe(1);
    expect(buffer).toEqual(new Uint8Array([0x85, 0x12]));
    world.writeAreaBits(buffer, 1);
    expect(buffer).toEqual(new Uint8Array([0x87, 0x12]));
    expect(world.areaBits(-1)).toEqual(new Uint8Array([255]));
    expect(() => world.writeAreaBits(new Uint8Array(0), 0)).toThrow();
    world.setNoAreas(true);
    expect(world.areasConnected(-1, 999)).toBe(true);
    expect(world.areaBits(999)).toEqual(new Uint8Array([255]));
    world.setNoAreas(false);
    expect(world.areasConnected(0, 1)).toBe(false);
  });
});
