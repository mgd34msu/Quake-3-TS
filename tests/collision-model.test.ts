import { describe, expect, test } from "bun:test";
import { createBoxModel, createCapsuleModel } from "../src/collision/model.ts";
import { CollisionCounters } from "../src/collision/counters.ts";
import { SourceClipModels } from "../src/collision/clip-models.ts";
import { generatePatchCollide, positionInPatch, tracePatch } from "../src/collision/patch.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds } from "../src/core/math.ts";
import type { BspMap } from "../src/assets/bsp.ts";

const bounds = { min: vec3(-10, -10, -20), max: vec3(10, 10, 20) };
const body = 0x02000000;

function boxWorld(bounds: Bounds, modelCount = 2): CollisionWorld {
  const planes = [
    { normal: vec3(-1, 0, 0), distance: -bounds.min.x }, { normal: vec3(1, 0, 0), distance: bounds.max.x },
    { normal: vec3(0, -1, 0), distance: -bounds.min.y }, { normal: vec3(0, 1, 0), distance: bounds.max.y },
    { normal: vec3(0, 0, -1), distance: -bounds.min.z }, { normal: vec3(0, 0, 1), distance: bounds.max.z },
  ];
  const map: BspMap = {
    entities: "", entityRecords: [], shaders: [{ name: "solid", surfaceFlags: 8, contentFlags: 1 }], planes,
    nodes: [{ plane: 1, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: Array.from({ length: modelCount }, () => ({ bounds,
      firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 })),
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
  return new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
}

describe("owned temporary collision models", () => {
  test("temporary collision statistics share the supplied owner across replaced boxes and capsules", () => {
    const counters = new CollisionCounters();
    const box = createBoxModel(bounds, counters), capsule = createCapsuleModel(bounds, counters);
    const query = { start: vec3(30, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: body } satisfies Parameters<typeof box.trace>[0];
    box.trace(query);
    box.transformedTrace(query, vec3(0, 0, 0), vec3(0, 90, 0));
    capsule.trace(query);
    expect(counters.c_traces).toBe(3);
    expect(counters.c_brush_traces).toBe(3);
    box.trace({ ...query, start: query.end });
    box.trace({ ...query, mask: 1 });
    capsule.trace({ ...query, shape: { kind: "capsule", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) } });
    box.pointContents(query.end);
    capsule.pointContents(query.end);
    expect(counters.c_traces).toBe(6);
    expect(counters.c_brush_traces).toBe(3);
    expect(counters.c_pointcontents).toBe(0);
    expect(counters.c_patch_traces).toBe(0);
    expect(createBoxModel(bounds).counters).not.toBe(counters);
  });
  test("source temporary box planes retain the inverted zero-solid hull and expand per moving shape", () => {
    const raw = { min: vec3(0, 0, 0), max: vec3(0, 0, -32) }, box = createBoxModel(raw);
    expect(box.bounds).toEqual(raw);
    expect(box.pointContents(vec3(0, 0, -16))).toBe(0);
    const start = vec3(0, 0, 10), end = vec3(0, 0, -50);
    expect(box.trace({ start, end, shape: { kind: "point" }, mask: body }).fraction).toBe(1);
    const shape = { kind: "box", mins: vec3(-15, -15, -24), maxs: vec3(15, 15, 32) } satisfies Parameters<typeof box.trace>[0]["shape"];
    const trace = box.trace({ start, end, shape, mask: body });
    expect(trace.end.z).toBeCloseTo(-7.875, 5);
    expect(trace.contact).toEqual({ kind: "plane", plane: { normal: vec3(0, 0, 1), distance: -32 } });
    expect(box.trace({ start: vec3(0, 0, -20), end: vec3(0, 0, -20), shape, mask: body }).solidity).toBe("all-solid");
  });
  test("differently sized box and capsule queries never alias the last temporary hull", () => {
    const big = createBoxModel(bounds);
    const small = createBoxModel({ min: vec3(-1, -1, -1), max: vec3(1, 1, 1) });
    const capsule = createCapsuleModel(bounds);
    expect(big.pointContents(vec3(5, 0, 0))).toBe(body);
    expect(small.pointContents(vec3(5, 0, 0))).toBe(0);
    // Explicit correction: owned capsule contents use its bounds-backed hull,
    // not stale planes left behind by another CM_TempBoxModel call.
    expect(capsule.pointContents(vec3(10, 10, 20))).toBe(body);
    expect(big.pointContents(vec3(5, 0, 0))).toBe(body);
    expect(small.pointContents(vec3(0, 0, 0))).toBe(body);
    const query = { start: vec3(30, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: body } satisfies Parameters<typeof big.trace>[0];
    expect(big.trace(query).end.x).toBeCloseTo(10.125, 5);
    expect(small.trace(query).end.x).toBeCloseTo(1.125, 5);
    expect(big.trace(query).end.x).toBeCloseTo(10.125, 5);
  });
  test("box hull includes touching contents, source epsilon and distinct exit/occupancy", () => {
    const box = createBoxModel(bounds);
    expect(box.pointContents(vec3(-10, -10, -20))).toBe(body);
    const result = box.trace({ start: vec3(30, 0, 0), end: vec3(0, 0, 0), shape: { kind: "box", mins: vec3(-2, -3, -4), maxs: vec3(2, 3, 4) }, mask: body });
    expect(result.end.x).toBeCloseTo(12.125, 5); expect(result.contents).toBe(body);
    expect(result.contact).toEqual({ kind: "plane", plane: { normal: vec3(1, 0, 0), distance: 10 } });
    const exit = box.trace({ start: vec3(0, 0, 0), end: vec3(30, 0, 0), shape: { kind: "point" }, mask: body });
    expect(exit.solidity).toBe("start-solid"); expect(exit.fraction).toBe(1); expect(exit.contact.kind).toBe("none");
    const stationary = box.trace({ start: vec3(0, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: body });
    expect(stationary.solidity).toBe("all-solid"); expect(stationary.contact.kind).toBe("none");
    expect(box.trace({ start: vec3(30, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 1 }).fraction).toBe(1);
  });
  test("brush and patch boxes retain independently rounded lower corners", () => {
    const target = { min: vec3(0, -1, -1), max: vec3(0, 1, 1) };
    const query = { start: vec3(0.1, 0, 0), end: vec3(-1, 0, 0),
      shape: { kind: "box", mins: vec3(0.1, 0, 0), maxs: vec3(0.3, 0, 0) }, mask: -1 } satisfies Parameters<CollisionWorld["trace"]>[0];
    expect(createBoxModel(target).traceSource(query).fraction).toBe(0.0681818351149559);
    expect(boxWorld(target).traceSource({ ...query, modelIndex: 1 }).fraction).toBe(0.0681818351149559);
    const patch = generatePatchCollide(3, 3, Array.from({ length: 9 }, (_, index) => vec3(index % 3 * 32, Math.floor(index / 3) * 32, 0)));
    const shape = { kind: "box", mins: vec3(0, 0, -0.10000000149011612), extents: vec3(0, 0, 0.10000000894069672) } satisfies Parameters<typeof tracePatch>[3];
    expect(positionInPatch(patch, vec3(32, 32, 0.10000000894069672), shape)).toBe(false);
    expect(tracePatch(patch, vec3(32, 32, 1), vec3(32, 32, -1), shape)?.plane.distance).toBe(0.10000000149011612);
  });
  test("transformed box traces perform the second source centering before clipping", () => {
    const target = { min: vec3(0, -1, -1), max: vec3(1, 1, 1) };
    const query = { start: vec3(4, 0, 0), end: vec3(0, 0, 0),
      shape: { kind: "box", mins: vec3(16777216, -1, -1), maxs: vec3(16777218, 1, 1) }, mask: -1 } satisfies Parameters<CollisionWorld["trace"]>[0];
    const origin = vec3(16777216, 0, 0), angles = vec3(0, 0, 0);
    // First stored x sizes are [0, 2]; CM_Trace then stores [-1, 1].
    for (const result of [createBoxModel(target).transformedTraceSource(query, origin, angles),
      boxWorld(target).transformedTraceSource({ ...query, modelIndex: 1 }, origin, angles)]) {
      expect(result.fraction).toBe(0.71875);
      expect(result.end).toEqual(vec3(1.125, 0, 0));
      expect(result.plane.normal).toEqual(vec3(1, 0, 0));
      expect(result.plane.distance).toBe(1);
    }
    const line = { ...query, shape: { kind: "box", mins: vec3(16777216, 0, 0), maxs: vec3(16777218, 0, 0) } } satisfies Parameters<CollisionWorld["trace"]>[0];
    expect(boxWorld(target).transformedTraceSource({ ...line, modelIndex: 1 }, origin, angles).fraction).toBe(0.71875);
  });
  test("transformed capsule replacement writes the second centered bounds and reaches the actual box leaf", () => {
    const target = { min: vec3(0, -1, -1), max: vec3(1, 1, 1) };
    const query = { start: vec3(4, 0, 0), end: vec3(0, 0, 0),
      shape: { kind: "box", mins: vec3(16777216, -1, -1), maxs: vec3(16777218, 1, 1) }, mask: body } satisfies Parameters<CollisionWorld["trace"]>[0];
    const origin = vec3(16777216, 0, 0), angles = vec3(0, 0, 0);
    const temporary = new SourceClipModels(boxWorld(target, 255));
    const hit = temporary.transformedTrace(query, 254, origin, angles);
    expect(hit.fraction).toBe(0.46875);
    expect(hit.end).toEqual(vec3(2.125, 0, 0));
    expect(temporary.modelBounds(255)).toEqual({ min: vec3(-1, -1, -1), max: vec3(1, 1, 1) });
    temporary.trace(query, 254);
    expect(temporary.modelBounds(255)).toEqual({ min: vec3(0, -1, -1), max: vec3(2, 1, 1) });
    const inline = new SourceClipModels(boxWorld(target, 256));
    expect(inline.transformedTrace(query, 254, origin, angles).fraction).toBe(1);
    const actualLeaf = inline.transformedTrace({ ...query, mask: 1 }, 254, origin, angles);
    expect(actualLeaf.fraction).toBe(0.46875);
    expect(actualLeaf.contents).toBe(1);
    expect(actualLeaf.surfaceFlags).toBe(8);
  });
  test("capsule rotation retains the sphere computed before the second box centering", () => {
    const capsule = createCapsuleModel({ min: vec3(-2, -2, -5), max: vec3(2, 2, 5) });
    const result = capsule.transformedTraceSource({ start: vec3(8, 0, 0), end: vec3(0, 0, 0),
      shape: { kind: "capsule", mins: vec3(16777216, -3, -3), maxs: vec3(16777218, 3, 3) }, mask: body },
    vec3(16777216, 0, 0), vec3(0, 90, 0));
    // The retained radius is 2. The radius-5 expanded cylinder is crossed at y=-sqrt(24).
    expect(result.fraction).toBeCloseTo((8 - Math.sqrt(24)) / 8, 4);
    expect(result.end.x).toBeCloseTo(Math.sqrt(24), 4);
    expect(result.plane.normal.x).toBeCloseTo(Math.sqrt(24) / 5, 4);
    expect(result.plane.normal.y).toBeCloseTo(0.2, 6);
    expect(result.plane.type).toBe(0);
    expect(result.plane.signbits).toBe(0);
  });
  test("source moving traces stay moving when centering rounds both endpoints to the same value", () => {
    const box = createBoxModel({ min: vec3(99999992, -1, -1), max: vec3(100000008, 1, 1) });
    const result = box.traceSource({ start: vec3(0, 0, 0), end: vec3(1, 0, 0),
      shape: { kind: "box", mins: vec3(100000000, 0, 0), maxs: vec3(100000000, 0, 0) }, mask: body });
    expect(result.allSolid).toBe(true);
    expect(box.counters.c_brush_traces).toBe(1);
  });
  test("capsule cylinder and endcap use source one-unit radius inflation", () => {
    const capsule = createCapsuleModel(bounds);
    const shape = { kind: "capsule", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) } satisfies Parameters<typeof capsule.trace>[0]["shape"];
    const side = capsule.trace({ start: vec3(30, 0, 0), end: vec3(0, 0, 0), shape, mask: body });
    expect(side.end.x).toBeCloseTo(13, 3);
    expect(side.contact.kind).toBe("plane"); expect(side.solidity).toBe("clear");
    const top = capsule.trace({ start: vec3(0, 0, 40), end: vec3(0, 0, 0), shape, mask: body });
    expect(top.end.z).toBeCloseTo(25, 3);
    expect(top.contents).toBe(body);
    const miss = capsule.trace({ start: vec3(30, 30, 0), end: vec3(30, -30, 0), shape, mask: body });
    expect(miss.fraction).toBe(1);
    const overlap = capsule.trace({ start: vec3(0, 0, 0), end: vec3(30, 0, 0), shape, mask: body });
    expect(overlap.solidity).toBe("start-solid"); expect(overlap.fraction).toBe(0); expect(overlap.contact.kind).toBe("none");
  });
  test("capsule geometry rejects a diagonal corner that its contents hull includes", () => {
    const capsule = createCapsuleModel(bounds);
    const shape = { kind: "capsule", mins: vec3(-1, -1, -1), maxs: vec3(1, 1, 1) } satisfies Parameters<typeof capsule.trace>[0]["shape"];
    expect(capsule.pointContents(vec3(10, 10, 20))).toBe(body);
    expect(capsule.trace({ start: vec3(10, 10, 20), end: vec3(10, 10, 21), shape, mask: body }).fraction).toBe(1);
  });
  test("capsule cylinder height comparisons round to source floats and retain allsolid without an end-height check", () => {
    const capsule = createCapsuleModel({ min: vec3(-1, -1, 16777212), max: vec3(1, 1, 16777220) });
    const result = capsule.traceSource({ start: vec3(0, 0, 16777220), end: vec3(1, 0, 16777228),
      shape: { kind: "capsule", mins: vec3(-1, -1, -1), maxs: vec3(1, 1, 1) }, mask: body });
    // The expanded cylinder has h=3, so its binary32 upper bound is 16777220.
    expect(result.startSolid).toBe(true);
    expect(result.allSolid).toBe(true);
    expect(result.fraction).toBe(0);
    expect(result.end).toEqual(vec3(0, 0, 16777220));
    expect(result.contents).toBe(0);
    expect(result.plane.normal).toEqual(vec3(0, 0, 0));
  });
  test("box model transforms ignore angles while capsule transforms rotate queries", () => {
    const narrow = { min: vec3(-1, -2, -8), max: vec3(1, 2, 8) };
    const box = createBoxModel(narrow), capsule = createCapsuleModel(narrow);
    expect(box.transformedPointContents(vec3(105, 0, 0), vec3(100, 0, 0), vec3(90, 0, 0))).toBe(0);
    expect(capsule.transformedPointContents(vec3(105, 0, 0), vec3(100, 0, 0), vec3(90, 0, 0))).toBe(body);
    const query = { start: vec3(105, 0, 0), end: vec3(100, 0, 0), shape: { kind: "point" }, mask: body } satisfies Parameters<typeof box.trace>[0];
    expect(box.transformedTrace(query, vec3(100, 0, 0), vec3(90, 0, 0)).end.x).toBe(101.125);
  });
  test("stationary box-versus-capsule preserves original retained-bounds behavior", () => {
    const capsule = createCapsuleModel({ min: vec3(-5, -5, -20), max: vec3(5, 5, 20) });
    const result = capsule.transformedTrace({ start: vec3(0, 0, 0), end: vec3(0, 0, 0),
      shape: { kind: "box", mins: vec3(17, -1, -1), maxs: vec3(19, 1, 1) }, mask: -1 }, vec3(0, 0, 0), vec3(90, 0, 0));
    expect(result.fraction).toBe(1); expect(result.solidity).toBe("clear");
  });
  test("model bounds are copied at the external boundary", () => {
    const mutable = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
    const box = createBoxModel(mutable);
    mutable.max.x = 999;
    expect(box.pointContents(vec3(10, 0, 0))).toBe(0);
    expect(box.bounds).toEqual({ min: vec3(-1, -1, -1), max: vec3(1, 1, 1) });
    expect(() => createBoxModel({ min: vec3(Number.NaN, 0, 0), max: vec3(1, 0, 0) })).toThrow("finite");
    expect(() => createCapsuleModel({ min: vec3(2, 0, 0), max: vec3(1, 0, 0) })).toThrow("ordered");
    expect(() => box.trace({ start: vec3(0, 0, 0), end: vec3(1, 0, 0),
      shape: { kind: "box", mins: vec3(2, 0, 0), maxs: vec3(1, 0, 0) }, mask: body })).toThrow("ordered");
  });
});
