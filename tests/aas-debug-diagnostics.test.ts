import { expect, test } from "bun:test";
import type { AasWorld } from "../src/botlib/aas.ts";
import { printAasFileInfo } from "../src/botlib/aas-file.ts";
import { AasRouting } from "../src/botlib/routing.ts";
import type { AreaTravelTimeQuery } from "../src/botlib/routing.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { AasDebugGeometry } from "../src/botlib/aas-debug-geometry.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { vec3 } from "../src/core/math.ts";

function world(): AasWorld {
  const zero = vec3(0, 0, 0), bounds = { min: zero, max: vec3(1, 1, 1) };
  return {
    source: "debug fixture", version: 4, bspChecksum: 0, bboxes: [],
    vertices: [zero, vec3(1, 0, 0), vec3(0, 1, 0)], planes: [],
    edges: [{ vertices: [0, 1] }, { vertices: [1, 2] }, { vertices: [2, 0] }], edgeIndexes: [0, 1, 2],
    faces: [{ plane: 0, flags: 4, edgeCount: 3, firstEdge: 0, frontArea: 2, backArea: 0 }], faceIndexes: [0],
    areas: Array.from({ length: 4 }, (_, areaNumber) => ({ areaNumber, faceCount: areaNumber === 2 ? 1 : 0, firstFace: 0, bounds, center: zero })),
    areaSettings: Array.from({ length: 4 }, (_, area) => ({ contents: 0, flags: area === 2 ? 1 : 0, presenceType: 2,
      cluster: 0, clusterAreaNumber: 0, reachableAreaCount: area === 2 ? 1 : 0, firstReachableArea: 0 })),
    reachability: [], nodes: [], portals: [], portalIndex: [], clusters: [],
    pointArea: () => 0, areaReachabilities: () => [], areaBounds: () => bounds,
  };
}

test("AAS_FileInfo emits source labels, byte strides, fixed version and grounded count", () => {
  const output: string[] = [];
  printAasFileInfo(world(), (severity, text) => { expect(severity).toBe(1); output.push(text); });
  expect(output).toEqual([
    "version = 5\n", "numvertexes = 3\n", "numplanes = 0\n", "numedges = 3\n", "edgeindexsize = 3\n",
    "numfaces = 1\n", "faceindexsize = 1\n", "numareas = 4\n", "numareasettings = 4\n",
    "reachabilitysize = 0\n", "numnodes = 0\n", "numportals = 0\n", "portalindexsize = 0\n",
    "numclusters = 0\n", "num grounded areas = 1\n", "planes size 0 bytes\n", "areas size 192 bytes\n",
    "areasettings size 112 bytes\n", "nodes size 0 bytes\n", "reachability size 0 bytes\n",
    "portals size 0 bytes\n", "clusters size 0 bytes\n", "optimzed size 0 KB\n",
  ]);
});

class CostFixtureRouting extends AasRouting {
  override areaTravelTimeToGoal(query: AreaTravelTimeQuery): number {
    return query.area === 1 && query.goalArea === 3 ? 100 : 50;
  }
}

test("DEBUG times real reversed and travel-table initialization in source order", () => {
  const base = world();
  const input: AasWorld = { ...base, areaSettings: base.areaSettings.map(settings => ({ ...settings, reachableAreaCount: 0 })) };
  const unexpected = (): never => { throw new Error("Unexpected spatial host call"); };
  const heap = new AasLinkHeap(unexpected); heap.initialize(() => 6144);
  const spatial = new AasSpatial(input, new AasBspEntities(unexpected), {
    print: unexpected, trace: unexpected, pointContents: unexpected, entityTrace: unexpected,
    entityModelIndex: unexpected, modelBounds: unexpected,
  }, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), heap, { kind: "disabled" }, () => 0);
  const events: string[] = []; let time = 0;
  const routing = new AasRouting(input, { routingDebug: {
    milliseconds: () => { events.push("clock"); time += 3; return time; },
    print: (severity, text) => { events.push(`${severity}:${text}`); },
  } });
  routing.initializeRouting(spatial, () => 4096, () => 0);
  expect(events).toEqual(["clock", "clock", "1:reversed reachability 3 msec\n", "clock", "clock", "1:area travel times 3 msec\n"]);
  routing.shutdownRouting();
  events.length = 0;
  const ordinary = new AasRouting(input, { milliseconds: () => { events.push("clock"); return 0; } });
  ordinary.initializeRouting(spatial, () => 4096, () => 0);
  expect(events).toEqual(["clock"]);
  ordinary.shutdownRouting();
});

test("ALTROUTE_DEBUG samples before early return and draws real chosen area before elapsed print", () => {
  const events: string[] = [], memory = new BotMemory();
  const lines = new AasDebugLines({ lineCreate: () => 1, lineShow: () => {}, lineDelete: () => {} }, () => {});
  const geometry = new AasDebugGeometry(lines, {
    polygonCreate(color, count, points) { events.push(`polygon:${color}:${count}`); expect(points).toHaveLength(3); return 1; },
    polygonDelete: () => {}, print: () => {}, debugBuild: false, memory: () => memory,
  });
  let clock = 100;
  const routing = new CostFixtureRouting(world(), { alternativeRouteDebug: {
    milliseconds: () => { events.push("clock"); clock += 7; return clock; },
    print: (severity, text) => { events.push(`${severity}:${text}`); },
    showAreaPolygons: (world, area, color, ground) => geometry.showAreaPolygons(world, area, color, ground),
  } });
  routing.initializeAlternativeRouting({ write: () => {} });
  const query = { start: vec3(0, 0, 0), startArea: 1, goal: vec3(0, 0, 0), goalArea: 3, travelFlags: 0, type: 1, maximumGoals: 1 };
  expect(routing.writeAlternativeRouteGoals({ ...query, startArea: 0 }, () => undefined)).toBe(0);
  expect(events.splice(0)).toEqual(["clock"]);
  expect(routing.writeAlternativeRouteGoals(query, goal => { events.push(`goal:${goal.area}`); })).toBe(1);
  expect(events).toEqual(["clock", "goal:2", "polygon:1:3", "clock", "1:alternative route goals in 7 msec\n"]);
  routing.shutdownAlternativeRouting();
});
