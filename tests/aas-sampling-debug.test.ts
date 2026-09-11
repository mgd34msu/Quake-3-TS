import { expect, test } from "bun:test";
import type { AasNode, AasWorld } from "../src/botlib/aas.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { vec3 } from "../src/core/math.ts";

const zero = vec3(0, 0, 0), front = vec3(1, 0, 0), back = vec3(-1, 0, 0);
function fixture(child = -1, plane = 0): AasWorld {
  const bounds = { min: back, max: front };
  return {
    source: "sampling debug fixture", version: 5, bspChecksum: 0, bboxes: [],
    vertices: [], planes: [{ normal: front, distance: 0, type: 0 }], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    areas: Array.from({ length: 2 }, (_, areaNumber) => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: zero })),
    areaSettings: Array.from({ length: 2 }, () => ({ contents: 0, flags: 0, presenceType: 2,
      cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 })),
    nodes: [{ plane: 0, children: [0, 0] }, { plane, children: [child, -1] }],
    reachability: [], portals: [], portalIndex: [], clusters: [],
    pointArea: () => { throw new Error("Use the actual world sampler"); }, areaReachabilities: () => [], areaBounds: () => bounds,
  };
}
function spatial(world: AasWorld, debug: boolean, events: string[]): AasSpatial {
  const unexpected = (): never => { throw new Error("Unexpected host service"); };
  const links = new AasLinkHeap(unexpected); links.initialize(() => 6144);
  return new AasSpatial(world, new AasBspEntities(unexpected), {
    print: (text, severity) => { events.push(`${severity}:${text}`); }, trace: unexpected, pointContents: unexpected,
    entityTrace: unexpected, entityModelIndex: unexpected, modelBounds: unexpected,
  }, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0, debug);
}

test("AAS_SAMPLE_DEBUG point guards print exact source diagnostics and return zero", () => {
  for (const [world, message] of [
    [{ ...fixture(), nodes: [] }, "nodenum = 1 >= aasworld.numnodes = 0\n"],
    [fixture(2), "nodenum = 2 >= aasworld.numnodes = 2\n"],
    [fixture(-1, -1), "node->planenum = -1 >= aasworld.numplanes = 1\n"],
    [fixture(-1, 1), "node->planenum = 1 >= aasworld.numplanes = 1\n"],
  ] satisfies [AasWorld, string][]) {
    const output: string[] = [];
    const debug = new AasWorldState(world, (severity, text) => { output.push(`${severity}:${text}`); });
    expect(debug.pointArea(front)).toBe(0);
    expect(output).toEqual([`3:${message}`]);
    expect(() => new AasWorldState(world).pointArea(front)).toThrow(RangeError);
  }
});

test("AAS_SAMPLE_DEBUG solid message is gated without changing valid point results", () => {
  const output: string[] = [];
  const world = fixture(0), ordinary = new AasWorldState(world);
  const debug = new AasWorldState(world, (severity, text) => { output.push(`${severity}:${text}`); });
  expect(debug.pointArea(front)).toBe(ordinary.pointArea(front));
  expect(debug.pointArea(back)).toBe(ordinary.pointArea(back));
  expect(output).toEqual(["1:in solid\n"]);
});

test("trace guards retain exact greater-than comparisons and source zero trace", () => {
  for (const [world, suffix] of [
    [{ ...fixture(), nodes: [] }, "nodenum out of range\n"],
    [fixture(3), "nodenum out of range\n"],
    [fixture(-3), "-nodenum out of range\n"],
  ] satisfies [AasWorld, string][]) {
    const events: string[] = [], sampler = spatial(world, true, events);
    expect(sampler.traceClientBBox(front, front, 2, -1)).toEqual({ startSolid: false, fraction: 0,
      end: zero, entityNum: 0, lastArea: 0, area: 0, plane: 0 });
    expect(events).toEqual([`3:AAS_TraceBoundingBox: ${suffix}`]);
    expect(() => spatial(world, false, []).traceClientBBox(front, front, 2, -1)).toThrow(RangeError);
  }
  for (const world of [fixture(2), fixture(-2)]) {
    const events: string[] = [];
    expect(() => spatial(world, true, events).traceClientBBox(front, front, 2, -1)).toThrow(RangeError);
    expect(events).toEqual([]);
  }
});

test("trace area debug returns already published crossings and bbox retains lastarea", () => {
  const emptyEvents: string[] = [];
  expect(spatial({ ...fixture(), nodes: [] }, true, emptyEvents).traceAreas(front, front, 10)).toEqual([]);
  expect(emptyEvents).toEqual(["3:AAS_TraceAreas: nodenum out of range\n"]);
  for (const [badChild, diagnostic] of [[3, "nodenum out of range\n"], [-3, "-nodenum = 3 out of range\n"]] satisfies [number, string][]) {
    const nodes: AasNode[] = [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, badChild] }];
    const world = { ...fixture(), nodes }, events: string[] = [], sampler = spatial(world, true, events);
    const crossings = sampler.traceAreas(front, back, 10);
    expect(crossings).toEqual([{ area: 1, point: front }]);
    expect(events).toEqual([`3:AAS_TraceAreas: ${diagnostic}`]);
    events.length = 0;
    expect(sampler.traceClientBBox(front, back, 2, -1)).toEqual({ startSolid: false, fraction: 0,
      end: zero, entityNum: 0, lastArea: 1, area: 0, plane: 0 });
    expect(events).toEqual([`3:AAS_TraceBoundingBox: ${badChild < 0 ? "-nodenum" : "nodenum"} out of range\n`]);
  }
  const events: string[] = [];
  expect(spatial(fixture(-2), true, events).traceAreas(front, front, 10)).toEqual([{ area: 2, point: front }]);
  expect(events).toEqual([]);
  expect(spatial(fixture(-3), false, events).traceAreas(front, front, 10)).toEqual([{ area: 3, point: front }]);
  expect(events).toEqual([]);
  expect(() => spatial(fixture(2), true, events).traceAreas(front, front, 10)).toThrow(RangeError);
  expect(events).toEqual([]);
});

test("valid sampling is invariant and winding diagnostics reach all spatial face callers", () => {
  const world = new AasWorldState(fixture()), output: string[] = [];
  const debug = spatial(world, true, output), ordinary = spatial(world, false, output);
  expect(debug.traceAreas(front, back, 10)).toEqual(ordinary.traceAreas(front, back, 10));
  expect(debug.traceClientBBox(front, back, 2, -1)).toEqual(ordinary.traceClientBBox(front, back, 2, -1));
  expect(output).toEqual([]);
  const base = fixture(), point = vec3(0.5, 0.5, 0);
  const geometry: AasWorld = { ...base,
    vertices: [zero, zero, vec3(1, 0, 0), vec3(1, 1, 0), vec3(0, 1, 0)],
    planes: [{ normal: vec3(0, 0, -1), distance: 0, type: 2 }],
    edges: [{ vertices: [1, 2] }, { vertices: [3, 4] }], edgeIndexes: [0, 1],
    faces: [{ plane: 0, flags: 4, edgeCount: 2, firstEdge: 0, frontArea: 1, backArea: 0 }], faceIndexes: [0],
    areas: base.areas.map(area => ({ ...area, faceCount: 1 })),
  };
  const trace = { startSolid: false, fraction: 0.5, end: point, entityNum: 0, lastArea: 1, area: 0, plane: 0 };
  const face = geometry.faces[0];
  if (face === undefined) throw new Error("Sampling fixture requires its ground face");
  for (const enabled of [false, true]) {
    output.length = 0;
    const sampler = spatial(geometry, enabled, output);
    expect(sampler.pointInsideFace(0, point, 0.01)).toBe(true);
    expect(sampler.areaGroundFace(1, point)).toEqual(face);
    expect(sampler.traceEndFace(trace)).toEqual(face);
    expect(output).toEqual(enabled ? Array<string>(3).fill("1:winding not counter clockwise\n") : []);
  }
});
