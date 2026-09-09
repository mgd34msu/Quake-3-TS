import { describe, expect, test } from "bun:test";
import { CollisionMapSettings, CollisionWorld } from "../src/collision/world.ts";
import { CollisionCounters } from "../src/collision/counters.ts";
import { SourceClipModels } from "../src/collision/clip-models.ts";
import { CollisionMapResource, diagnosticCollisionMap } from "../src/collision/map-resource.ts";
import { CollisionDebugSurface, generatePatchCollide, positionInPatch, tracePatch } from "../src/collision/patch.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec2, vec3, vec4 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import type { BspMap, BspPlane } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

const patchPoint = { kind: "point", mins: vec3(0, 0, 0), extents: vec3(0, 0, 0) } satisfies Parameters<typeof tracePatch>[3];

function boxMap(): BspMap {
  const bounds = { min: vec3(-10, -10, -10), max: vec3(10, 10, 10) };
  const planes: BspPlane[] = [
    { normal: vec3(-1, 0, 0), distance: 10 }, { normal: vec3(1, 0, 0), distance: 10 },
    { normal: vec3(0, -1, 0), distance: 10 }, { normal: vec3(0, 1, 0), distance: 10 },
    { normal: vec3(0, 0, -1), distance: 10 }, { normal: vec3(0, 0, 1), distance: 10 },
  ];
  return {
    entities: "", entityRecords: [], shaders: [{ name: "solid", surfaceFlags: 8, contentFlags: 1 }], planes,
    nodes: [{ plane: 1, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [
      { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 },
      { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 },
    ], brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

function expectCollisionDrop(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CommonError);
    expect(error).toMatchObject({ code: "drop", message });
    return;
  }
  throw new Error("collision operation did not throw");
}

describe("source collision error dispatch", () => {
  test("patch dimensions drop in source order before reading point storage", () => {
    expectCollisionDrop(() => generatePatchCollide(2, 3, []), "CM_GeneratePatchFacets: bad parameters: (2, 3, managed points)");
    expectCollisionDrop(() => generatePatchCollide(131, 2, []), "CM_GeneratePatchFacets: bad parameters: (131, 2, managed points)");
    for (const [width, height] of [[4, 3], [130, 3], [131, 4]] satisfies readonly (readonly [number, number])[]) {
      expectCollisionDrop(() => generatePatchCollide(width, height, []), "CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes");
    }
    expectCollisionDrop(() => generatePatchCollide(4, 3, flatPatchPoints().concat([vec3(96, 0, 0), vec3(96, 32, 0), vec3(96, 64, 0)])),
      "CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes");
    for (const [width, height] of [[131, 3], [3, 131]] satisfies readonly (readonly [number, number])[]) {
      expectCollisionDrop(() => generatePatchCollide(width, height, []), "CM_GeneratePatchFacets: source is > MAX_GRID_SIZE");
    }
    expect(() => generatePatchCollide(3.5, 3, [])).toThrow(RangeError);
    expect(() => generatePatchCollide(3, 3, [])).toThrow(RangeError);
  });

  test("patch facet capacity accepts its final cell then drops on the next cell", () => {
    const points = (width: number) => Array.from({ length: width * 65 }, (_, index) => vec3(index % width * 32, Math.floor(index / width) * 32, 0));
    expect(generatePatchCollide(65, 65, points(65)).facets).toHaveLength(1024);
    expectCollisionDrop(() => generatePatchCollide(67, 65, points(67)), "MAX_FACETS");
  });

  test("patch plane capacity drops with the source error", () => {
    const width = 65;
    const points = Array.from({ length: width * width }, (_, index) =>
      vec3(index % width * 32, Math.floor(index / width) * 32, index * 17 % 31 - 15));
    expectCollisionDrop(() => generatePatchCollide(width, width, points), "MAX_PATCH_PLANES");
  });

  test("clip handles preserve each source drop message and signed addition", () => {
    const world = new CollisionWorld(boxMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const clips = new SourceClipModels(world);
    for (const index of [-1, 2]) expectCollisionDrop(() => clips.inlineModel(index), "CM_InlineModel: bad number");
    for (const [handle, message] of [
      [-1, "CM_ClipHandleToModel: bad handle -1"],
      [2, "CM_ClipHandleToModel: bad handle 2 < 2 < 256"],
      [254, "CM_ClipHandleToModel: bad handle 2 < 254 < 256"],
      [256, "CM_ClipHandleToModel: bad handle 512"],
      [2147483647, "CM_ClipHandleToModel: bad handle -2147483393"],
    ] satisfies readonly (readonly [number, string])[]) {
      expectCollisionDrop(() => clips.modelBounds(handle), message);
    }
    expect(clips.inlineModel(1)).toBe(1);
    expect(clips.modelBounds(255)).toEqual({ min: vec3(0, 0, 0), max: vec3(0, 0, 0) });
    expect(() => clips.inlineModel(0.5)).toThrow(RangeError);
    expect(() => clips.modelBounds(-0.5)).toThrow(RangeError);
  });

  test("no-node contents bypasses invalid handles while trace drops before counting", () => {
    const world = new CollisionWorld({ ...boxMap(), nodes: [] }, { kind: "unaccounted" }, { kind: "disabled" });
    const clips = new SourceClipModels(world), point = vec3(0, 0, 0);
    expect(clips.pointContents(point, -1)).toBe(0);
    expect(clips.transformedPointContents(point, -1, point, point)).toBe(0);
    expectCollisionDrop(() => clips.traceWithoutNodes(-1), "CM_ClipHandleToModel: bad handle -1");
    expect(world.counters.c_traces).toBe(0);
  });

  test("leaf access distinguishes source bounds errors from managed fractional indexes", () => {
    const world = new CollisionWorld(boxMap(), { kind: "unaccounted" }, { kind: "disabled" });
    for (const index of [-1, 1]) {
      expectCollisionDrop(() => world.leafArea(index), "CM_LeafArea: bad number");
      expectCollisionDrop(() => world.leafCluster(index), "CM_LeafCluster: bad number");
    }
    expect(world.leafArea(0)).toBe(0);
    expect(world.leafCluster(0)).toBe(0);
    expect(() => world.leafArea(-0.5)).toThrow(RangeError);
    expect(() => world.leafCluster(0.5)).toThrow(RangeError);
  });

  test("area drops follow negative-area and no-area returns without mutating portals", () => {
    const map = boxMap(), leaf = map.leaves[0];
    if (leaf === undefined) throw new Error("fixture leaf missing");
    const data = diagnosticCollisionMap({ ...map, leaves: [leaf, { ...leaf, area: 1 }] }, null);
    const world = new CollisionWorld(data, { kind: "unaccounted" }, { kind: "disabled" });
    for (const [area1, area2] of [[2, 0], [0, 2]] satisfies readonly (readonly [number, number])[]) {
      expectCollisionDrop(() => world.adjustAreaPortalState(area1, area2, true), "CM_ChangeAreaPortalState: bad area number");
      expectCollisionDrop(() => world.areasConnected(area1, area2), "area >= cm.numAreas");
    }
    world.adjustAreaPortalState(-1, 2, false);
    world.adjustAreaPortalState(2, -1, false);
    expect(world.areasConnected(-1, 2)).toBe(false);
    expect(world.areasConnected(2, -1)).toBe(false);
    expect([0, 1, 2, 3].map(index => data.portals.at(index))).toEqual([0, 0, 0, 0]);
    expect(() => world.adjustAreaPortalState(0.5, 0, true)).toThrow(RangeError);
    expect(() => world.areasConnected(0, 0.5)).toThrow(RangeError);
    expect(() => world.areaBits(2)).toThrow(RangeError);
    expect(() => world.clusterPVS(0).byteAt(999)).toThrow(RangeError);
    world.setNoAreas(true);
    expect(world.areasConnected(2, 2)).toBe(true);
  });

  test("portal underflow retains both decrements and skips reflooding", () => {
    const map = boxMap(), leaf = map.leaves[0];
    if (leaf === undefined) throw new Error("fixture leaf missing");
    const data = diagnosticCollisionMap({ ...map, leaves: [leaf, { ...leaf, area: 1 }] }, null);
    const world = new CollisionWorld(data, { kind: "unaccounted" }, { kind: "disabled" });
    const floods = data.areas.map(area => ({ ...area }));
    expectCollisionDrop(() => world.adjustAreaPortalState(0, 1, false), "CM_AdjustAreaPortalState: negative reference count");
    expect(data.portals.at(1)).toBe(-1);
    expect(data.portals.at(2)).toBe(-1);
    expect(data.areas).toEqual(floods);
    expectCollisionDrop(() => world.adjustAreaPortalState(0, 0, false), "CM_AdjustAreaPortalState: negative reference count");
    expect(data.portals.at(0)).toBe(-2);
    expect(data.areas).toEqual(floods);
  });

  test("reflooding an earlier component preserves reached area writes before dropping", () => {
    const map = boxMap(), leaf = map.leaves[0];
    if (leaf === undefined) throw new Error("fixture leaf missing");
    const data = diagnosticCollisionMap({ ...map, leaves: [leaf, { ...leaf, area: 1 }] }, null);
    data.portals.set(2, 1);
    expectCollisionDrop(() => new CollisionWorld(data, { kind: "unaccounted" }, { kind: "disabled" }), "FloodArea_r: reflooded");
    expect(data.areas).toEqual([{ flood: 1, floodValid: 1 }, { flood: 2, floodValid: 1 }]);
  });
});

describe("source brush collision", () => {
  const world = new CollisionWorld(boxMap(), { kind: "unaccounted" }, { kind: "disabled" });
  test("point contents includes boundary and unions contents independently of PVS", () => {
    expect(world.pointContents(vec3(0, 0, 0))).toBe(1);
    expect(world.pointContents(vec3(10, 10, 10))).toBe(1);
    expect(world.pointContents(vec3(10.001, 0, 0))).toBe(0);
    expect(world.pointContents(vec3(0, 0, 0), 1)).toBe(1);
    const original = boxMap();
    const leaf = original.leaves[0];
    if (leaf === undefined) throw new Error("fixture leaf missing");
    const overlap = new CollisionWorld({ ...original, shaders: [...original.shaders, { name: "water", contentFlags: 32, surfaceFlags: 0 }],
      brushes: [...original.brushes, { firstSide: 0, sideCount: 6, shader: 1 }], leafBrushes: [0, 1], leaves: [{ ...leaf, brushCount: 2, cluster: -1 }] }, { kind: "unaccounted" }, { kind: "disabled" });
    expect(overlap.pointContents(vec3(0, 0, 0))).toBe(33);
  });
  test("point entry uses source one-eighth-unit push off", () => {
    const hit = world.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 1 });
    expect(hit.fraction).toBe(Math.fround(9.875 / 20));
    expect(hit.end.x).toBe(10.125);
    expect(hit.contact).toEqual({ kind: "plane", plane: { normal: vec3(1, 0, 0), distance: 10 } });
    expect(hit.solidity).toBe("clear"); expect(hit.contents).toBe(1); expect(hit.surfaceFlags).toBe(8);
  });
  test("asymmetric box bounds preserve the caller origin", () => {
    const hit = world.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "box", mins: vec3(-3, -2, -2), maxs: vec3(1, 2, 2) }, mask: 1 });
    expect(hit.end.x).toBe(13.125);
    expect(hit.fraction).toBe(Math.fround(6.875 / 20));
  });
  test("capsule radius and vertical offset expand brush planes", () => {
    const shape = { kind: "capsule", mins: vec3(-2, -2, -6), maxs: vec3(2, 2, 6) } satisfies Parameters<CollisionWorld["trace"]>[0]["shape"];
    expect(world.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape, mask: 1 }).end.x).toBe(12.125);
    expect(world.trace({ start: vec3(0, 0, 30), end: vec3(0, 0, 0), shape, mask: 1 }).end.z).toBe(16.125);
  });
  test("sloped brush plane separates capsule support from box support", () => {
    const original = boxMap();
    const normal = vec3(Math.SQRT1_2, 0, Math.SQRT1_2);
    const slope = new CollisionWorld({ ...original, planes: [...original.planes, { normal, distance: 0 }],
      brushes: [{ firstSide: 0, sideCount: 7, shader: 0 }], brushSides: [...original.brushSides, { plane: 6, shader: 0 }] }, { kind: "unaccounted" }, { kind: "disabled" });
    const mins = vec3(-1, -1, -3), maxs = vec3(1, 1, 3);
    const box = slope.trace({ start: vec3(5, 0, 5), end: vec3(-5, 0, -5), shape: { kind: "box", mins, maxs }, mask: 1 });
    const capsule = slope.trace({ start: vec3(5, 0, 5), end: vec3(-5, 0, -5), shape: { kind: "capsule", mins, maxs }, mask: 1 });
    expect(box.contact.kind).toBe("plane"); expect(capsule.contact.kind).toBe("plane");
    expect(box.fraction).toBeCloseTo((10 * Math.SQRT1_2 - 4 * Math.SQRT1_2 - 0.125) / (20 * Math.SQRT1_2), 6);
    expect(capsule.fraction).toBeCloseTo((10 * Math.SQRT1_2 - 1 - 2 * Math.SQRT1_2 - 0.125) / (20 * Math.SQRT1_2), 6);
  });
  test("exit, all-solid, stationary overlap and mask rejection remain distinct", () => {
    const exiting = world.trace({ start: vec3(0, 0, 0), end: vec3(20, 0, 0), shape: { kind: "point" }, mask: 1 });
    expect(exiting.solidity).toBe("start-solid"); expect(exiting.fraction).toBe(1); expect(exiting.contact.kind).toBe("none"); expect(exiting.contents).toBe(0);
    const trapped = world.trace({ start: vec3(0, 0, 0), end: vec3(1, 0, 0), shape: { kind: "point" }, mask: 1 });
    expect(trapped.solidity).toBe("all-solid"); expect(trapped.fraction).toBe(0); expect(trapped.contact.kind).toBe("none");
    const stationary = world.trace({ start: vec3(0, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 1 });
    expect(stationary.solidity).toBe("all-solid");
    const masked = world.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 32 });
    expect(masked.fraction).toBe(1); expect(masked.solidity).toBe("clear");
  });
  test("parallel and outward near-face sweeps do not collide", () => {
    for (const end of [vec3(10.05, 20, 0), vec3(20, 0, 0)]) {
      const result = world.trace({ start: vec3(10.05, 0, 0), end, shape: { kind: "point" }, mask: 1 });
      expect(result.fraction).toBe(1);
    }
  });
  test("translated and yaw-rotated inline model traces return world normals", () => {
    const hit = world.transformedTrace({ start: vec3(100, 20, 0), end: vec3(100, 0, 0), shape: { kind: "point" }, mask: 1, modelIndex: 1 }, vec3(100, 0, 0), vec3(0, 90, 0));
    expect(hit.end.y).toBe(10.125);
    expect(hit.contact.kind).toBe("plane");
    if (hit.contact.kind !== "plane") throw new Error("missing impact plane");
    expect(hit.contact.plane.normal.y).toBeCloseTo(1, 6);
    expect(world.transformedPointContents(vec3(100, 0, 0), 1, vec3(100, 0, 0), vec3(0, 90, 0))).toBe(1);
  });
  test("direct inline model255 contents and traces retain the source no-rotation branch", () => {
    const map = boxMap(), model = map.models[1];
    if (model === undefined) throw new Error("fixture inline model missing");
    const collision = new CollisionWorld({ ...map, models: Array.from({ length: 256 }, () => model) },
      { kind: "unaccounted" }, { kind: "disabled" });
    const clips = new SourceClipModels(collision);
    const origin = vec3(100, 0, 0), angles = vec3(0, 45, 0), point = vec3(109, 9, 0);
    expect(collision.transformedPointContents(point, 255, origin, angles)).toBe(1);
    expect(collision.transformedPointContents(point, 1, origin, angles)).toBe(0);
    expect(clips.transformedPointContents(point, 255, origin, angles)).toBe(1);
    const query = { start: vec3(120, 9, 0), end: vec3(100, 9, 0), shape: { kind: "point" }, mask: 1,
      modelIndex: 255 } satisfies Parameters<CollisionWorld["transformedTraceSource"]>[0];
    const trace = collision.transformedTraceSource(query, origin, angles);
    expect(trace.fraction).toBe(Math.fround(9.875 / 20));
    expect(trace.end).toEqual(vec3(110.125, 9, 0));
    expect(trace.plane.normal).toEqual(vec3(1, 0, 0));
    expect(clips.transformedTrace(query, 255, origin, angles)).toEqual(trace);
    expect(collision.transformedTraceSource({ ...query, modelIndex: 1 }, origin, angles).fraction).not.toBe(trace.fraction);
  });
  test("direct inline model254 traces retain capsule dispatch and the actual shared box storage", () => {
    for (const modelCount of [255, 256]) {
      const original = renderBspFixture([{ shader: "test/wall", lightmap: -1 }, { shader: "test/wall", lightmap: -1 }], []);
      const bytes = new Uint8Array(original.length + modelCount * 40);
      bytes.set(original);
      const data = new DataView(bytes.buffer);
      data.setInt32(8 + 7 * 8, original.length, true);
      data.setInt32(12 + 7 * 8, modelCount * 40, true);
      for (let index = 0; index < modelCount; index++) {
        for (const [axis, value] of [-9, -9, -19, 9, 9, 19].entries()) data.setFloat32(original.length + index * 40 + axis * 4, value, true);
      }
      const resource = new CollisionMapResource("inline-handles.bsp", { kind: "unaccounted" }, null);
      resource.load(bytes);
      resource.initializeBoxHull();
      const collision = new CollisionWorld(resource, { kind: "unaccounted" }, { kind: "disabled" });
      const clips = new SourceClipModels(collision), storage = collision.boxStorage;
      if (storage === null) throw new Error("source fixture box storage missing");
      clips.tempBoxModel(vec3(-30, -30, -30), vec3(30, 30, 30), false);
      const retainedBounds = storage.bounds, retainedPlane = storage.readSide(0).plane;
      const query = { start: vec3(30, 0, 0), end: vec3(0, 0, 0), mask: 0, modelIndex: 254,
        shape: { kind: "capsule", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) } } satisfies Parameters<CollisionWorld["traceSource"]>[0];
      const capsule = collision.traceSource(query);
      expect(capsule.end.x).toBeCloseTo(13, 3);
      expect(capsule.contents).toBe(0x02000000);
      expect(storage.bounds).toBe(retainedBounds);
      expect(retainedPlane.distance).toBe(30);
      expect(collision.pointContents(vec3(0, 0, 0), 254)).toBe(0);
      const boxQuery = { ...query, mask: 0x02000000, shape: { ...query.shape, kind: "box" } } satisfies Parameters<CollisionWorld["traceSource"]>[0];
      const box = collision.traceSource(boxQuery);
      expect(box.end.x).toBe(modelCount === 255 ? 12.125 : 0);
      expect(box.fraction === 1).toBe(modelCount === 256);
      expect(collision.boxStorage).toBe(storage);
      expect(storage.bounds).toEqual({ min: query.shape.mins, max: query.shape.maxs });
      expect(storage.brush.bounds).toEqual(storage.bounds);
      expect(retainedPlane.distance).toBe(2);
      if (modelCount === 255) expect(clips.modelBounds(255)).toEqual(storage.bounds);
      clips.tempBoxModel(vec3(-30, -30, -30), vec3(30, 30, 30), false);
      const transformed = collision.transformedTraceSource({ ...boxQuery, start: vec3(100, 30, 0), end: vec3(100, 0, 0) },
        vec3(100, 0, 0), vec3(0, 90, 0));
      expect(transformed.end.y).toBe(modelCount === 255 ? 12.125 : 0);
      expect(storage.bounds).toEqual({ min: query.shape.mins, max: query.shape.maxs });
      expect(retainedPlane.distance).toBe(2);
      const stationary = collision.traceSource({ ...boxQuery, start: query.end });
      expect(stationary.allSolid).toBe(modelCount === 255);
      expect(collision.counters.c_traces).toBe(4);
      expect(collision.counters.c_brush_traces).toBe(modelCount === 255 ? 2 : 0);
    }
  });
  test("rejects invalid queries", () => {
    expect(() => world.pointContents(vec3(NaN, 0, 0))).toThrow();
    expect(() => world.trace({ start: vec3(0, 0, 0), end: vec3(1, 0, 0), shape: { kind: "box", mins: vec3(1, 0, 0), maxs: vec3(-1, 0, 0) }, mask: 1 })).toThrow();
    expect(() => world.pointContents(vec3(0, 0, 0), 99)).toThrow();
  });
});

describe("independent patch facets", () => {
  const points = Array.from({ length: 9 }, (_, i) => vec3((i % 3) * 32, Math.floor(i / 3) * 32, 0));
  const flat = generatePatchCollide(3, 3, points);
  test("flat grid collapses to a bounded quad with opposite plane", () => {
    expect(flat.facets.length).toBe(1);
    expect(flat.facets[0]?.borders.length).toBe(5);
    expect(flat.bounds).toEqual({ min: vec3(-1, -1, -1), max: vec3(65, 65, 1) });
    const hit = tracePatch(flat, vec3(32, 32, 20), vec3(32, 32, -20), patchPoint);
    expect(hit?.fraction).toBe(Math.fround(19.875 / 40));
    expect(hit?.plane.normal).toEqual(vec3(0, 0, 1));
    expect(tracePatch(flat, vec3(32, 32, -20), vec3(32, 32, 20), patchPoint)).toBeNull();
    expect(tracePatch(flat, vec3(80, 32, 20), vec3(80, 32, -20), patchPoint)).toBeNull();
  });
  test("source point classification retains nonzero upper corners in patch traces", () => {
    const original = patchMap(0);
    const world = new CollisionWorld({ ...original, nodes: boxMap().nodes,
      vertices: original.vertices.map(vertex => ({ ...vertex,
        position: vec3(64 - vertex.position.x, vertex.position.y, 0), normal: vec3(0, 0, -1) })) },
    { kind: "unaccounted" }, { kind: "disabled" });
    for (const kind of ["box", "capsule"] satisfies readonly ("box" | "capsule")[]) {
      const result = world.traceSource({ start: vec3(32, 32, -16777224), end: vec3(32, 32, -16777208),
        shape: { kind, mins: vec3(0, 0, 16777216), maxs: vec3(0, 0, 16777218) }, mask: 1 });
      // size[0] is zero, but the -Z plane reads size[1].z=2, giving d1=6 and d2=-10.
      expect(result.fraction).toBe(0.3671875);
      expect(result.end).toEqual(vec3(32, 32, -16777218));
      expect(result.plane.normal).toEqual(vec3(0, 0, -1));
    }
    const point = world.traceSource({ start: vec3(32, 32, -8), end: vec3(32, 32, 8), shape: { kind: "point" }, mask: 1 });
    expect(point.fraction).toBe(0.4921875);
    expect(point.end).toEqual(vec3(32, 32, -0.125));
  });
  test("box and capsule sweep and position tests use volume-expanded facets", () => {
    const box = { kind: "box", mins: vec3(-2, -2, -4), extents: vec3(2, 2, 4) } satisfies Parameters<typeof tracePatch>[3];
    const hit = tracePatch(flat, vec3(32, 32, 20), vec3(32, 32, -20), box);
    expect(hit?.fraction).toBe(Math.fround(15.875 / 40));
    expect(tracePatch(flat, vec3(32, 32, -20), vec3(32, 32, 20), box)).toBeNull();
    expect(positionInPatch(flat, vec3(32, 32, 3), box)).toBe(true);
    expect(positionInPatch(flat, vec3(32, 32, 5), box)).toBe(false);
    expect(positionInPatch(flat, vec3(32, 32, 0), patchPoint)).toBe(false);
    const capsule = { kind: "capsule", extents: vec3(2, 2, 4), radius: 2, offset: vec3(0, 0, 2) } satisfies Parameters<typeof tracePatch>[3];
    expect(tracePatch(flat, vec3(32, 32, 20), vec3(32, 32, -20), capsule)?.fraction).toBe(hit?.fraction);
  });
  test("16-unit curve threshold subdivides independently of rendering", () => {
    const below = generatePatchCollide(3, 3, points.map((p, i) => vec3(p.x, p.y, i % 3 === 1 ? 31 : 0)));
    const atThreshold = generatePatchCollide(3, 3, points.map((p, i) => vec3(p.x, p.y, i % 3 === 1 ? 32 : 0)));
    expect(below.facets.length).toBe(1);
    expect(atThreshold.facets.length).toBe(2);
    expect(atThreshold.bounds.max.z).toBe(17);
    expect(atThreshold.facets.every(facet => facet.borders.length > 5)).toBe(true);
  });
  test("degenerate grids collapse without fabricated collision", () => {
    const patch = generatePatchCollide(3, 3, Array.from({ length: 9 }, () => vec3(0, 0, 0)));
    expect(patch.facets).toHaveLength(0);
    expect(() => generatePatchCollide(2, 3, points)).toThrow();
    expect(() => generatePatchCollide(3, 3, points.slice(1))).toThrow();
  });
});

function debugFixture() {
  const cvars = new CvarRegistry(), prints: string[] = [], warnings: string[] = [];
  const owner = new CollisionDebugSurface({ cvars, print: text => { prints.push(text); }, developerPrint: text => { warnings.push(text); } });
  const settings = new CollisionMapSettings(cvars);
  settings.registerMap();
  return { owner, cvars, settings, prints, warnings };
}

function debugPolygons(owner: CollisionDebugSurface) {
  const polygons: { readonly color: number; readonly count: number; readonly points: readonly Vec3[] }[] = [];
  owner.draw((color, count, points) => { polygons.push({ color, count, points: points.slice(0, count) }); });
  return polygons;
}

function flatPatchPoints(z = 0): Vec3[] {
  return Array.from({ length: 9 }, (_, index) => vec3(index % 3 * 32, Math.floor(index / 3) * 32, z));
}

function patchMap(z: number): BspMap {
  const bounds = { min: vec3(-1, -1, z - 1), max: vec3(65, 65, z + 1) };
  return { ...boxMap(), nodes: [], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 1, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [0], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 1, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [],
    vertices: flatPatchPoints(z).map(position => ({ position, texCoord: vec2(0, 0), lightmapCoord: vec2(0, 0), normal: vec3(0, 0, 1), color: vec4(255, 255, 255, 255) })),
    surfaces: [{ type: "patch", shader: 0, fog: -1, firstVertex: 0, vertexCount: 9, firstIndex: 0, indexCount: 0,
      lightmap: -1, lightmapX: 0, lightmapY: 0, lightmapWidth: 0, lightmapHeight: 0, lightmapOrigin: vec3(0, 0, 0),
      lightmapVectors: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 1)], patchWidth: 3, patchHeight: 3 }] };
}

describe("source collision statistics", () => {
  test("brush traces count reached moving brushes once despite repeated BSP leaf references", () => {
    const world = new CollisionWorld(boxMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const query = { start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 1 } satisfies Parameters<typeof world.trace>[0];
    world.trace(query);
    expect(world.counters.c_traces).toBe(1);
    expect(world.counters.c_brush_traces).toBe(1);
    world.trace({ ...query, start: query.end });
    world.trace({ ...query, mask: 32 });
    expect(world.counters.c_traces).toBe(3);
    expect(world.counters.c_brush_traces).toBe(1);
    world.transformedTrace({ ...query, modelIndex: 1 }, vec3(0, 0, 0), vec3(0, 90, 0));
    expect(world.counters.c_traces).toBe(4);
    expect(world.counters.c_brush_traces).toBe(2);
    const emptyBrush = new CollisionWorld({ ...boxMap(), brushes: [{ firstSide: 0, sideCount: 0, shader: 0 }] },
      { kind: "unaccounted" }, { kind: "disabled" }, world.counters);
    emptyBrush.trace(query);
    expect(world.counters.c_traces).toBe(5);
    expect(world.counters.c_brush_traces).toBe(2);
    expect(world.counters.c_pointcontents).toBe(0);
  });

  test("point contents counter records leaf lookup completion only", () => {
    const world = new CollisionWorld(boxMap(), { kind: "unaccounted" }, { kind: "disabled" });
    const clips = new SourceClipModels(world), point = vec3(0, 0, 0);
    world.pointLeafnum(point);
    world.pointContents(point);
    world.transformedPointContents(point, 0, point, point);
    expect(world.counters.c_pointcontents).toBe(3);
    world.pointContents(point, 1);
    world.transformedPointContents(point, 1, point, point);
    clips.pointContents(point, clips.tempBoxModel(vec3(-1, -1, -1), vec3(1, 1, 1), false));
    world.boxLeafnums({ min: vec3(-1, -1, -1), max: vec3(1, 1, 1) });
    expect(world.counters.c_pointcontents).toBe(3);
    const unloaded = new CollisionWorld({ ...boxMap(), nodes: [] }, { kind: "unaccounted" }, { kind: "disabled" }, world.counters);
    unloaded.pointLeafnum(point);
    expect(world.counters.c_pointcontents).toBe(3);
  });

  test("moving patches count before player clipping and bounds rejection, after contents and noCurves gates", () => {
    const { owner, cvars, settings } = debugFixture();
    const map = patchMap(0);
    const world = new CollisionWorld({ ...map, nodes: boxMap().nodes }, { kind: "unaccounted" }, { kind: "shared", owner, settings });
    const query = { start: vec3(32, 32, 20), end: vec3(32, 32, -20), shape: { kind: "point" }, mask: 1 } satisfies Parameters<typeof world.trace>[0];
    world.trace(query);
    expect(world.counters.c_patch_traces).toBe(1);
    cvars.set("cm_playerCurveClip", "0", true);
    expect(world.trace(query).fraction).toBe(1);
    expect(world.counters.c_patch_traces).toBe(2);
    world.trace({ ...query, start: query.end });
    world.trace({ ...query, mask: 32 });
    cvars.set("cm_noCurves", "1", true);
    world.trace(query);
    expect(world.counters.c_patch_traces).toBe(2);
    cvars.set("cm_noCurves", "0", true);
    cvars.set("cm_playerCurveClip", "1", true);
    world.trace({ ...query, start: vec3(90, 90, 20), end: vec3(90, 90, -20) });
    expect(world.counters.c_patch_traces).toBe(3);
    expect(world.counters.c_traces).toBe(6);
    expect(world.counters.c_brush_traces).toBe(0);
  });

  test("unloaded trace entries count after handle resolution and before no-node return", () => {
    const counters = new CollisionCounters();
    const world = new CollisionWorld({ ...boxMap(), nodes: [] }, { kind: "unaccounted" }, { kind: "disabled" }, counters);
    const clips = new SourceClipModels(world), point = vec3(0, 0, 0);
    const query = { start: point, end: vec3(1, 0, 0), shape: { kind: "point" }, mask: 1 } satisfies Parameters<typeof clips.trace>[0];
    expect(() => clips.trace(query, -1)).toThrow("bad handle");
    expect(counters.c_traces).toBe(0);
    clips.trace(query, 0);
    clips.transformedTrace(query, 0, point, point);
    clips.traceWithoutNodes(0);
    expect(counters.c_traces).toBe(3);
    expect(counters.c_brush_traces).toBe(0);
    expect(counters.c_patch_traces).toBe(0);
    expect(counters.c_pointcontents).toBe(0);
  });

  test("capsule replacement enters one trace and counts only reached moving brush work", () => {
    const original = boxMap(), model = original.models[0];
    if (model === undefined) throw new Error("fixture model missing");
    for (const modelCount of [255, 256]) {
      const world = new CollisionWorld({ ...original, models: Array.from({ length: modelCount }, () => model) },
        { kind: "unaccounted" }, { kind: "disabled" });
      const clips = new SourceClipModels(world);
      const query = { start: vec3(30, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: -1 } satisfies Parameters<typeof clips.trace>[0];
      clips.trace(query, 254);
      expect(world.counters.c_traces).toBe(1);
      expect(world.counters.c_brush_traces).toBe(1);
      clips.transformedTrace(query, 254, vec3(0, 0, 0), vec3(0, 90, 0));
      expect(world.counters.c_traces).toBe(2);
      expect(world.counters.c_brush_traces).toBe(2);
      clips.trace({ ...query, start: query.end }, 254);
      expect(world.counters.c_traces).toBe(3);
      expect(world.counters.c_brush_traces).toBe(2);
    }
  });
});

describe("live collision map controls", () => {
  test("map registration preserves configured values and source defaults and flags", () => {
    const cvars = new CvarRegistry();
    const settings = new CollisionMapSettings(cvars);
    expect(cvars.snapshots()).toEqual([]);
    expect(() => settings.noCurves).toThrow("not registered");
    cvars.set("cm_playerCurveClip", "0");
    settings.registerMap();
    expect(cvars.get("cm_noAreas")?.flags).toBe(CvarFlag.Cheat);
    expect(cvars.get("cm_noCurves")?.flags).toBe(CvarFlag.Cheat);
    expect(cvars.get("cm_playerCurveClip")?.flags).toBe(CvarFlag.Archive | CvarFlag.Cheat);
    expect(cvars.get("cm_playerCurveClip")?.resetValue).toBe("1");
    expect(settings.playerCurveClip).toBe(false);
    cvars.set("cm_noCurves", "-2", true);
    settings.registerMap();
    expect(settings.noCurves).toBe(true);
    expect(settings.playerCurveClip).toBe(false);
  });

  test("cm_noCurves disables moving and stationary patches for world and inline models, retaining brushes", () => {
    const { owner, cvars, settings } = debugFixture();
    const map = patchMap(0), model = map.models[0];
    if (model === undefined) throw new Error("fixture model missing");
    const profile = { kind: "shared", owner, settings } satisfies ConstructorParameters<typeof CollisionWorld>[2];
    const world = new CollisionWorld({ ...map, models: [model, model] }, { kind: "unaccounted" }, profile);
    const brush = new CollisionWorld(boxMap(), { kind: "unaccounted" }, profile);
    const shapes: readonly Parameters<CollisionWorld["trace"]>[0]["shape"][] = [
      { kind: "point" }, { kind: "box", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) },
      { kind: "capsule", mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) },
    ];
    for (const value of ["0", "1", "0"]) {
      cvars.set("cm_noCurves", value, true);
      for (const modelIndex of [0, 1]) {
        for (const shape of shapes) {
          const sweep = world.trace({ start: vec3(32, 32, 20), end: vec3(32, 32, -20), shape, modelIndex, mask: 1 });
          expect(sweep.fraction < 1).toBe(value === "0");
          const position = world.trace({ start: vec3(32, 32, 0), end: vec3(32, 32, 0), shape, modelIndex, mask: 1 });
          expect(position.solidity).toBe(value === "0" ? "all-solid" : "clear");
        }
        expect(world.pointContents(vec3(32, 32, 0), modelIndex)).toBe(0);
      }
      expect(brush.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 1 }).fraction).toBe(Math.fround(9.875 / 20));
      expect(brush.pointContents(vec3(0, 0, 0))).toBe(1);
    }
  });

  test("cm_playerCurveClip gates only moving point shapes, including zero-size boxes and capsules", () => {
    const { owner, cvars, settings } = debugFixture();
    const world = new CollisionWorld(patchMap(0), { kind: "unaccounted" }, { kind: "shared", owner, settings });
    const points: readonly Parameters<CollisionWorld["trace"]>[0]["shape"][] = [
      { kind: "point" }, { kind: "box", mins: vec3(0, 0, 0), maxs: vec3(0, 0, 0) },
      { kind: "capsule", mins: vec3(0, 0, 0), maxs: vec3(0, 0, 0) },
    ];
    for (const value of ["1", "0", "-1"]) {
      cvars.set("cm_playerCurveClip", value, true);
      for (const shape of points) {
        expect(world.trace({ start: vec3(32, 32, 20), end: vec3(32, 32, -20), shape, mask: 1 }).fraction < 1).toBe(value !== "0");
        expect(world.trace({ start: vec3(32, 32, 0), end: vec3(32, 32, 0), shape, mask: 1 }).solidity).toBe("all-solid");
      }
      for (const kind of ["box", "capsule"] satisfies readonly ("box" | "capsule")[]) {
        const shape = { kind, mins: vec3(-2, -2, -4), maxs: vec3(2, 2, 4) };
        expect(world.trace({ start: vec3(32, 32, 20), end: vec3(32, 32, -20), shape, mask: 1 }).fraction).toBe(Math.fround(15.875 / 40));
        expect(world.trace({ start: vec3(32, 32, 3), end: vec3(32, 32, 3), shape, mask: 1 }).solidity).toBe("all-solid");
      }
      expect(world.pointContents(vec3(32, 32, 0))).toBe(0);
    }
  });

  test("cm_noAreas affects live connectivity and padded visibility without changing portal references", () => {
    const { owner, cvars, settings } = debugFixture();
    const map = boxMap(), leaf = map.leaves[0];
    if (leaf === undefined) throw new Error("fixture leaf missing");
    const world = new CollisionWorld({ ...map, leaves: [leaf, { ...leaf, area: 1 }] }, { kind: "unaccounted" }, { kind: "shared", owner, settings });
    expect(world.areasConnected(0, 1)).toBe(false);
    expect(world.areaBits(0)).toEqual(new Uint8Array([1]));
    cvars.set("cm_noAreas", "1", true);
    expect(world.areasConnected(-1, 999)).toBe(true);
    const buffer = new Uint8Array([0, 17]);
    expect(world.writeAreaBits(buffer, 999)).toBe(1);
    expect(buffer).toEqual(new Uint8Array([255, 17]));
    expect(world.areaBits(999)).toEqual(new Uint8Array([255]));
    world.adjustAreaPortalState(0, 1, true);
    cvars.set("cm_noAreas", "0", true);
    expect(world.areasConnected(0, 1)).toBe(true);
    world.adjustAreaPortalState(0, 1, false);
    expect(world.areasConnected(0, 1)).toBe(false);
    expect(world.areaBits(0)).toEqual(new Uint8Array([1]));
  });
});

describe("retained collision debug surfaces", () => {
  test("point hits emit source border order, fixed box expansion and both zero-initialized block triangles", () => {
    const { owner, cvars, prints } = debugFixture();
    const patch = generatePatchCollide(3, 3, flatPatchPoints(), owner);
    expect(cvars.get("r_debugSurfaceUpdate")).toBeUndefined();
    expect(debugPolygons(owner)).toEqual([]);
    expect(cvars.get("cm_debugSize")).toBeUndefined();
    tracePatch(patch, vec3(32, 32, 20), vec3(32, 32, -20), patchPoint, 0.5, owner);
    const polygons = debugPolygons(owner);
    // The 0..64 quad expands by 15 + 2 in x/y and by 28 + 2 in z.
    // CM_DrawDebugSurface visits left, far, right, near, back, surface.
    expect(polygons).toEqual([
      { color: 4, count: 4, points: [vec3(-17, -17, 30), vec3(-17, -17, -30), vec3(-17, 81, -30), vec3(-17, 81, 30)] },
      { color: 4, count: 4, points: [vec3(-17, 81, 30), vec3(-17, 81, -30), vec3(81, 81, -30), vec3(81, 81, 30)] },
      { color: 4, count: 4, points: [vec3(81, 81, 30), vec3(81, 81, -30), vec3(81, -17, -30), vec3(81, -17, 30)] },
      { color: 4, count: 4, points: [vec3(81, -17, 30), vec3(81, -17, -30), vec3(-17, -17, -30), vec3(-17, -17, 30)] },
      { color: 4, count: 4, points: [vec3(81, 81, -30), vec3(-17, 81, -30), vec3(-17, -17, -30), vec3(81, -17, -30)] },
      { color: 4, count: 4, points: [vec3(-17, -17, 30), vec3(-17, 81, 30), vec3(81, 81, 30), vec3(81, -17, 30)] },
      { color: 2, count: 3, points: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)] },
      { color: 2, count: 3, points: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)] },
    ]);
    expect(cvars.get("r_debugSurfaceUpdate")?.resetValue).toBe("1");
    expect(cvars.get("cm_debugSize")?.resetValue).toBe("2");
    expect(prints).toEqual([]);
  });

  test("misses do not register update, point capture respects update and box/capsule hits require a closer fraction", () => {
    const { owner, cvars } = debugFixture();
    const patch = generatePatchCollide(3, 3, flatPatchPoints(), owner);
    tracePatch(patch, vec3(80, 32, 20), vec3(80, 32, -20), patchPoint, 1, owner);
    expect(cvars.get("r_debugSurfaceUpdate")).toBeUndefined();
    cvars.set("r_debugSurfaceUpdate", "0");
    tracePatch(patch, vec3(32, 32, 20), vec3(32, 32, -20), patchPoint, 1, owner);
    expect(debugPolygons(owner)).toEqual([]);
    expect(cvars.get("cm_debugSize")).toBeUndefined();
    cvars.set("r_debugSurfaceUpdate", "1");
    const box = { kind: "box", mins: vec3(-2, -2, -4), extents: vec3(2, 2, 4) } satisfies Parameters<typeof tracePatch>[3];
    tracePatch(patch, vec3(32, 32, 20), vec3(32, 32, -20), box, Math.fround(15.875 / 40), owner);
    expect(debugPolygons(owner)).toEqual([]);
    tracePatch(patch, vec3(32, 32, 20), vec3(32, 32, -20), box, 1, owner);
    expect(debugPolygons(owner)).toHaveLength(8);
    owner.clearLevelPatches();
    const capsule = { kind: "capsule", extents: vec3(2, 2, 4), radius: 2, offset: vec3(0, 0, 2) } satisfies Parameters<typeof tracePatch>[3];
    tracePatch(patch, vec3(32, 32, 20), vec3(32, 32, -20), capsule, 1, owner);
    expect(debugPolygons(owner)).toHaveLength(8);
  });

  test("draw callbacks observe later live float sizes and clear only the selected facet while finishing the retained patch", () => {
    const { owner, cvars } = debugFixture();
    const patch = generatePatchCollide(3, 3, flatPatchPoints(), owner);
    tracePatch(patch, vec3(32, 32, 20), vec3(32, 32, -20), patchPoint, 1, owner);
    const polygons: { color: number; points: readonly Vec3[] }[] = [];
    owner.draw((color, count, points) => {
      polygons.push({ color, points: points.slice(0, count) });
      if (polygons.length === 1) {
        cvars.set("cm_debugSize", "3.5");
        owner.clearLevelPatches();
      }
    });
    expect(polygons).toHaveLength(8);
    expect(polygons[0]?.color).toBe(4);
    expect(polygons[1]).toEqual({ color: 1, points: [vec3(-18.5, 82.5, 31.5), vec3(-18.5, 82.5, -31.5), vec3(82.5, 82.5, -31.5), vec3(82.5, 82.5, 31.5)] });
    expect(debugPolygons(owner)).toEqual([]);
  });

  test("shared world observations retain misses and stationary tests until a later enabled moving hit", () => {
    const { owner, cvars, settings } = debugFixture();
    const first = new CollisionWorld(patchMap(0), { kind: "unaccounted" }, { kind: "shared", owner, settings });
    const query = { start: vec3(32, 32, 20), end: vec3(32, 32, -20), shape: { kind: "point" }, mask: 1 } satisfies Parameters<CollisionWorld["trace"]>[0];
    first.trace(query);
    const firstPolygons = debugPolygons(owner);
    const second = new CollisionWorld(patchMap(100), { kind: "unaccounted" }, { kind: "shared", owner, settings });
    expect(debugPolygons(owner)).toEqual(firstPolygons);
    second.trace({ ...query, start: vec3(32, 32, 100), end: vec3(32, 32, 100) });
    second.trace({ ...query, start: vec3(32, 32, 80), end: vec3(32, 32, 120) });
    expect(debugPolygons(owner)).toEqual(firstPolygons);
    cvars.set("r_debugSurfaceUpdate", "0");
    second.trace({ ...query, start: vec3(32, 32, 120), end: vec3(32, 32, 80) });
    expect(debugPolygons(owner)).toEqual(firstPolygons);
    cvars.set("r_debugSurfaceUpdate", "-1");
    second.trace({ ...query, start: vec3(32, 32, 120), end: vec3(32, 32, 80) });
    expect(debugPolygons(owner)[5]?.points).toEqual([vec3(-17, -17, 130), vec3(-17, 81, 130), vec3(81, 81, 130), vec3(81, -17, 130)]);
    owner.clearLevelPatches();
    expect(debugPolygons(owner)).toEqual([]);
  });

  test("draw includes unselected facets and source diagnostics for completely clipped windings", () => {
    const { owner, cvars, prints } = debugFixture();
    const patch = generatePatchCollide(3, 3, flatPatchPoints().map((point, index) => vec3(point.x, point.y, index % 3 === 1 ? 32 : 0)), owner);
    tracePatch(patch, vec3(16, 32, 60), vec3(16, 32, -40), patchPoint, 1, owner);
    expect(patch.facets).toHaveLength(2);
    const polygons = debugPolygons(owner);
    expect(polygons.some(polygon => polygon.color === 4)).toBe(true);
    expect(polygons.some(polygon => polygon.color === 1)).toBe(true);
    const flat = generatePatchCollide(3, 3, flatPatchPoints(), owner);
    tracePatch(flat, vec3(32, 32, 20), vec3(32, 32, -20), patchPoint, 1, owner);
    cvars.set("cm_debugSize", "-100");
    prints.length = 0;
    expect(debugPolygons(owner).map(polygon => polygon.color)).toEqual([2, 2]);
    expect(prints).toEqual(Array.from({ length: 6 }, () => "winding chopped away by border planes\n"));
  });

  test("the first concave grid block is copied at generation and survives collision map clearing", () => {
    const { owner, warnings, settings } = debugFixture();
    // Bilinear control rows collapse to the concave clockwise quad
    // (0,0), (0,64), (20,20), (64,0), whose middle borders bisect it.
    const points = [vec3(0, 0, 0), vec3(32, 0, 0), vec3(64, 0, 0), vec3(0, 32, 0), vec3(21, 21, 0),
      vec3(42, 10, 0), vec3(0, 64, 0), vec3(10, 42, 0), vec3(20, 20, 0)];
    const noncolliding = new CollisionWorld({ ...patchMap(0), shaders: [{ name: "noncolliding", surfaceFlags: 0, contentFlags: 0 }],
      vertices: points.map(position => ({ position, texCoord: vec2(0, 0), lightmapCoord: vec2(0, 0), normal: vec3(0, 0, 1), color: vec4(255, 255, 255, 255) })) },
    { kind: "unaccounted" }, { kind: "shared", owner, settings });
    expect(noncolliding.trace({ start: vec3(10, 10, 20), end: vec3(10, 10, -20), shape: { kind: "point" }, mask: -1 }).fraction).toBe(1);
    expect(warnings).toEqual(["WARNING: CM_SetBorderInward: mixed plane sides\n", "WARNING: CM_SetBorderInward: mixed plane sides\n"]);
    owner.clearLevelPatches();
    expect(debugPolygons(owner)).toEqual([]);
    generatePatchCollide(3, 3, points.map(point => vec3(point.x + 500, point.y, point.z)), owner);
    const flat = generatePatchCollide(3, 3, flatPatchPoints(), owner);
    tracePatch(flat, vec3(32, 32, 20), vec3(32, 32, -20), patchPoint, 1, owner);
    expect(debugPolygons(owner).slice(-2)).toEqual([
      { color: 2, count: 3, points: [vec3(0, 0, 0), vec3(0, 64, 0), vec3(20, 20, 0)] },
      { color: 2, count: 3, points: [vec3(20, 20, 0), vec3(64, 0, 0), vec3(0, 0, 0)] },
    ]);
  });
});

test("retail q3dm1 spawn-to-floor sweeps hit brush or patch collision", async () => {
  const root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  const file = `${root}/baseq3/pak0.pk3`;
  if (!(await Bun.file(file).exists())) return;
  using archive = await Pk3Archive.open(file);
  const map = parseBsp(await archive.read("maps/q3dm1.bsp"));
  const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const worldModel = map.models[0];
  if (worldModel === undefined) throw new Error("retail world model missing");
  const exhaustive = new CollisionWorld({ ...map, models: [...map.models, worldModel] }, { kind: "unaccounted" }, { kind: "disabled" });
  const spawns = map.entityRecords.filter(entity => entity.get("classname") === "info_player_deathmatch");
  expect(spawns.length).toBeGreaterThan(0);
  for (const spawn of spawns) {
    const origin = spawn.get("origin");
    if (origin === undefined) throw new Error("spawn has no origin");
    const components = origin.split(/\s+/).map(Number);
    const [x, y, z] = components;
    if (x === undefined || y === undefined || z === undefined) throw new Error("invalid spawn origin");
    // SelectSpawnPoint raises the stored map origin by nine units.
    const start = vec3(x, y, z + 9);
    expect(world.pointContents(start) & 1).toBe(0);
    const hit = world.trace({ start, end: vec3(x, y, z - 4096), shape: { kind: "box", mins: vec3(-15, -15, -24), maxs: vec3(15, 15, 32) }, mask: 1 | 0x10000 });
    expect(hit.fraction).toBeLessThan(1);
    expect(hit.solidity).toBe("clear");
    expect(hit.contact.kind).toBe("plane");
    if (hit.contact.kind !== "plane") throw new Error("floor sweep has no contact");
    expect(hit.contact.plane.normal.z).toBeGreaterThan(0.7);
    expect(hit.end.z).toBeLessThan(start.z);
    const stationary = world.trace({ start: hit.end, end: hit.end, shape: { kind: "box", mins: vec3(-15, -15, -24), maxs: vec3(15, 15, 32) }, mask: 1 | 0x10000 });
    expect(stationary.solidity).toBe("clear");
    for (const direction of [vec3(1024, 0, 0), vec3(-1024, 0, 0), vec3(0, 1024, 0), vec3(0, -1024, 0), vec3(0, 0, 1024), vec3(0, 0, -1024)]) {
      const query = { start, end: vec3(start.x + direction.x, start.y + direction.y, start.z + direction.z),
        shape: { kind: "box", mins: vec3(-15, -15, -24), maxs: vec3(15, 15, 32) }, mask: 1 | 0x10000 } satisfies Parameters<CollisionWorld["trace"]>[0];
      const traversed = world.trace(query);
      const all = exhaustive.trace({ ...query, modelIndex: map.models.length });
      expect(traversed.fraction).toBe(all.fraction);
      expect(traversed.solidity).toBe(all.solidity);
    }
  }
});

test.skipIf(process.env["QUAKE3_COLLISION_CORPUS"] !== "1")("generate collision for every baseq3 and missionpack pak0 map", async () => {
  const root = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
  let count = 0;
  for (const product of ["baseq3", "missionpack"]) {
    using archive = await Pk3Archive.open(`${root}/${product}/pak0.pk3`);
    for (const path of archive.list().filter(path => path.endsWith(".bsp"))) {
      const map = parseBsp(await archive.read(path));
      const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
      expect(Number.isInteger(world.pointContents(vec3(0, 0, 0)))).toBe(true);
      count++;
    }
  }
  expect(count).toBe(52);
}, 30_000);
