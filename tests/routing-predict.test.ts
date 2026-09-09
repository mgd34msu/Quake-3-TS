import { describe, expect, expectTypeOf, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasNode, AasPlane } from "../src/botlib/aas.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasRouting, RouteStopEvent, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import type { PredictRouteQuery, PredictedRoute } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { vec3 } from "../src/core/math.ts";
import { ZoneArena } from "../src/core/zone.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const ZERO = vec3(0, 0, 0), ALL_FLAGS = 0x1fffffff;
const TRACED_TYPES: readonly number[] = [TravelType.BARRIERJUMP, TravelType.WATERJUMP, TravelType.WALKOFFLEDGE, TravelType.GRAPPLEHOOK];
const TEST_TYPES: readonly number[] = Array.from({ length: 22 }, (_, type) => type);
const BOUNDS: Bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing fixture index ${index}`); return value;
}
interface Area { readonly cluster: number; readonly contents?: number; readonly flags?: number; readonly presence?: number }
interface Link { readonly from: number; readonly to: number; readonly time?: number; readonly type?: number; readonly start?: Vec3; readonly end?: Vec3 }
interface Portal { readonly area: number; readonly front: number; readonly back: number }
interface Graph {
  readonly areas: readonly Area[]; readonly links: readonly Link[]; readonly portals?: readonly Portal[];
  /** Actual ordered BSP leaves along z; repetitions deliberately test duplicate crossings. */
  readonly leaves?: readonly number[];
  readonly geometry?: { readonly planes: readonly AasPlane[]; readonly nodes: readonly AasNode[] };
}

function fixture(graph: Graph): Uint8Array {
  const { areas, links } = graph, portals = graph.portals ?? [];
  const leaves = graph.leaves ?? areas.map((_, index) => index + 1);
  if (leaves.length < 2) throw new Error("Fixture needs at least two spatial leaves");
  const clusterCount = Math.max(1, ...areas.map(area => area.cluster), ...portals.flatMap(portal => [portal.front, portal.back]));
  const members = Array.from({ length: clusterCount + 1 }, (_, cluster) => areas.flatMap((area, index) => {
    const portal = portals.find(portal => portal.area === index + 1);
    return area.cluster === cluster || (portal !== undefined && (portal.front === cluster || portal.back === cluster)) ? [index + 1] : [];
  }));
  const grouped = areas.map((_, index) => links.filter(link => link.from === index + 1));
  function encode(size: number, write: (writer: BinaryWriter) => void): Uint8Array {
    const writer = new BinaryWriter(size); write(writer); return writer.finish();
  }
  function vector(writer: BinaryWriter, point: Vec3): void { writer.f32(point.x); writer.f32(point.y); writer.f32(point.z); }
  const lumps: Uint8Array[] = Array.from({ length: 14 }, () => new Uint8Array(0));
  const planes = graph.geometry?.planes ?? Array.from({ length: leaves.length - 1 }, (_, index) => ({ normal: vec3(0, 0, 1), distance: (index + 1) * 10, type: 2 }));
  lumps[2] = encode(planes.length * 20, writer => {
    for (const plane of planes) { vector(writer, plane.normal); writer.f32(plane.distance); writer.i32(plane.type); }
  });
  lumps[7] = encode((areas.length + 1) * 48, writer => {
    for (let area = 0; area <= areas.length; area++) {
      writer.i32(area); writer.i32(0); writer.i32(0); vector(writer, BOUNDS.min); vector(writer, BOUNDS.max);
      vector(writer, vec3(0, 0, area * 10 - 5));
    }
  });
  lumps[8] = encode((areas.length + 1) * 28, writer => {
    writer.bytes(new Uint8Array(28)); let first = 1;
    for (const [index, area] of areas.entries()) {
      const outgoing = at(grouped, index);
      writer.i32(area.contents ?? 0); writer.i32(area.flags ?? 1); writer.i32(area.presence ?? 2); writer.i32(area.cluster);
      writer.i32(area.cluster > 0 ? at(members, area.cluster).indexOf(index + 1) : 0);
      writer.i32(outgoing.length); writer.i32(first); first += outgoing.length;
    }
  });
  lumps[9] = encode((links.length + 1) * 44, writer => {
    writer.bytes(new Uint8Array(44));
    for (const outgoing of grouped) for (const link of outgoing) {
      writer.i32(link.to); writer.i32(0); writer.i32(0); vector(writer, link.start ?? ZERO); vector(writer, link.end ?? ZERO);
      writer.i32(link.type ?? TravelType.WALK); writer.u16(link.time ?? 10); writer.u16(0);
    }
  });
  const nodes: readonly AasNode[] = graph.geometry?.nodes ?? Array.from({ length: leaves.length }, (_, index) => index === 0
    ? { plane: 0, children: [0, 0] } : { plane: index - 1, children: [index === leaves.length - 1 ? -at(leaves, index) : index + 1, -at(leaves, index - 1)] });
  lumps[10] = encode(nodes.length * 12, writer => {
    for (const node of nodes) {
      writer.i32(node.plane); writer.i32(node.children[0]); writer.i32(node.children[1]);
    }
  });
  lumps[11] = encode((portals.length + 1) * 20, writer => {
    writer.bytes(new Uint8Array(20));
    for (const portal of portals) {
      writer.i32(portal.area); writer.i32(portal.front); writer.i32(portal.back);
      writer.i32(at(members, portal.front).indexOf(portal.area)); writer.i32(at(members, portal.back).indexOf(portal.area));
    }
  });
  const portalLists = members.map((_, cluster) => portals.flatMap((portal, index) => portal.front === cluster || portal.back === cluster ? [index + 1] : []));
  lumps[12] = encode(portalLists.flat().length * 4, writer => { for (const list of portalLists) for (const portal of list) writer.i32(portal); });
  lumps[13] = encode(members.length * 16, writer => {
    let first = 0;
    for (const [cluster, list] of members.entries()) {
      const clusterPortals = at(portalLists, cluster);
      writer.i32(list.length); writer.i32(list.length); writer.i32(clusterPortals.length); writer.i32(first); first += clusterPortals.length;
    }
  });
  const writer = new BinaryWriter(124 + lumps.reduce((sum, lump) => sum + lump.length, 0));
  writer.u32(0x53414145); writer.i32(4); writer.i32(0); let offset = 124;
  for (const lump of lumps) { writer.i32(offset); writer.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) writer.bytes(lump);
  return writer.finish();
}

function emptyBsp(): BspMap {
  return { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds: BOUNDS, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds: BOUNDS, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function setup(bytes: Uint8Array, map = emptyBsp(), memory?: BotMemory) {
  const world = parseAas(bytes), collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const messages: string[] = [];
  const host: AasSpatialHost = {
    print: message => { messages.push(message); },
    trace: (start, end, bounds, _pass, mask) => ({
      ...collision.trace({ start, end, shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }), entityNum: 1022,
    }),
    pointContents: point => collision.pointContents(point),
    entityTrace: (entityNum, start, end, bounds, mask) => ({
      ...collision.trace({ start, end, shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, mask, modelIndex: entityNum }), entityNum,
    }),
    entityModelIndex: entity => entity,
    modelBounds: model => ({ bounds: collision.modelBounds(model), origin: ZERO }),
  };
  const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); }), modelTypes = new BotBrushModelTypes(), links = linkHeap();
  bspEntities.load(map.entities);
  const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, modelTypes, links, { kind: "disabled" }, () => 0);
  const routing = new AasRouting(world, memory === undefined ? {} : { memory });
  spatial.setBrushModelTypes(host.print);
  routing.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 0);
  return { world, bspEntities, modelTypes, links, collision, spatial, routing, messages };
}
function query(overrides: Partial<PredictRouteQuery> = {}): PredictRouteQuery {
  return { area: 1, origin: ZERO, goalArea: 3, travelFlags: ALL_FLAGS, maximumAreas: 0, maximumTime: 0,
    stopEvent: 0, stopContents: 0, stopTravelFlags: 0, stopArea: 0, ...overrides };
}
function chain(): Graph {
  return { areas: [{ cluster: 1 }, { cluster: 1 }, { cluster: 1, contents: 1 }], links: [
    { from: 1, to: 2, time: 10, start: vec3(3, 0, 0), end: vec3(90, 0, 0) },
    { from: 2, to: 3, time: 20, type: TravelType.SWIM, start: vec3(100, 0, 0), end: vec3(110, 0, 0) },
  ] };
}
function portalCycle(areaCount: number, reachTime = 10, start = ZERO): Graph {
  return { areas: Array.from({ length: areaCount }, (_, index) => ({ cluster: index === 0 ? -1 : index === 1 ? -2 : index === 2 ? 2 : 0, flags: 5 })),
    leaves: [1, 2, 3], links: [{ from: 1, to: 2, time: reachTime, start }, { from: 2, to: 1, time: reachTime, start }],
    portals: [{ area: 1, front: 1, back: 2 }, { area: 2, front: 1, back: 2 }] };
}
function threeDimensional(type: number): Graph {
  return { areas: Array.from({ length: 5 }, () => ({ cluster: 1 })),
    links: [{ from: 1, to: 5, type, start: vec3(5, 5, 5), end: vec3(15, 15, 15) }],
    geometry: { planes: [{ normal: vec3(1, 0, 0), distance: 10, type: 0 }, { normal: vec3(0, 1, 0), distance: 10, type: 1 },
      { normal: vec3(0, 0, 1), distance: 10, type: 2 }], nodes: [{ plane: 0, children: [0, 0] },
      { plane: 0, children: [-4, 2] }, { plane: 1, children: [-3, 3] }, { plane: 2, children: [-2, -1] }] } };
}

describe("source AAS route prediction", () => {
  test("reports exact initial-origin time, all written fields, and no invented area count", () => {
    const env = setup(fixture(chain()));
    expectTypeOf<PredictRouteQuery["origin"]>().toEqualTypeOf<Vec3>();
    expect(env.routing.predictRoute(query())).toEqual({ succeeded: true, stopEvent: 0, endArea: 3,
      endContents: 1, endTravelFlags: TravelFlags.SWIM, endPosition: vec3(110, 0, 0), time: 64 });
    expect(env.messages).toEqual([]);
  });

  test("source-defined equal and invalid int32 areas preserve initialization and loop ordering", () => {
    const env = setup(fixture(chain()));
    for (const area of [0, -1, 4, 0x7fffffff, -0x80000000, 1]) {
      expect(env.routing.predictRoute(query({ area, goalArea: area, origin: vec3(0.1, -0, 3) }))).toEqual({ succeeded: true,
        stopEvent: 0, endArea: area, endContents: 0, endTravelFlags: 0, endPosition: vec3(0.1, -0, 3), time: 0 });
    }
    for (const [area, goalArea] of [[0, 3], [1, 0], [-1, 3], [1, 4]] satisfies readonly [number, number][]) {
      expect(env.routing.predictRoute(query({ area, goalArea }))).toEqual({ succeeded: false, stopEvent: 1, endArea: goalArea,
        endContents: 0, endTravelFlags: 0, endPosition: ZERO, time: 0 });
      expect(env.routing.predictRoute(query({ area, goalArea, maximumAreas: -1 }))).toEqual({ succeeded: false, stopEvent: 0,
        endArea: goalArea, endContents: 0, endTravelFlags: 0, endPosition: ZERO, time: 0 });
    }
    expect(env.routing.cacheStatistics.entries).toBe(0);
  });

  test("hop and strict time limits publish partial fields before deciding success", () => {
    const env = setup(fixture(chain()));
    const partial: PredictedRoute = { succeeded: false, stopEvent: 0, endArea: 2, endContents: 0,
      endTravelFlags: TravelFlags.WALK, endPosition: vec3(90, 0, 0), time: 11 };
    expect(env.routing.predictRoute(query({ maximumAreas: 1 }))).toEqual(partial);
    expect(env.routing.predictRoute(query({ maximumTime: 10 }))).toEqual(partial);
    expect(env.routing.predictRoute(query({ maximumTime: -1 }))).toEqual(partial);
    expect(env.routing.predictRoute(query({ maximumTime: 11 })).succeeded).toBe(true);
    expect(env.routing.predictRoute(query({ maximumAreas: 2, maximumTime: 63 })).time).toBe(64);
    expect(env.routing.predictRoute(query({ maximumAreas: 2, maximumTime: 63 })).succeeded).toBe(true);
    expect(env.routing.predictRoute(query({ maximumAreas: -1 }))).toEqual({ succeeded: false, stopEvent: 0, endArea: 3,
      endContents: 0, endTravelFlags: 0, endPosition: ZERO, time: 0 });
  });

  test("type and destination-contents travel flags precede crossing stops", () => {
    const env = setup(fixture(chain()));
    expect(env.routing.predictRoute(query({ stopEvent: 14, stopTravelFlags: TravelFlags.WALK, stopContents: 1, stopArea: 2 }))).toEqual({
      succeeded: true, stopEvent: 2, endArea: 1, endContents: 0, endTravelFlags: TravelFlags.WALK, endPosition: vec3(3, 0, 0), time: 0,
    });
    expect(env.routing.predictRoute(query({ stopEvent: 14, stopTravelFlags: TravelFlags.WATER, stopContents: 1, stopArea: 3 }))).toEqual({
      succeeded: true, stopEvent: 2, endArea: 3, endContents: 1, endTravelFlags: TravelFlags.WATER, endPosition: vec3(110, 0, 0), time: 64,
    });
    expect(env.routing.predictRoute(query({ stopEvent: 14, stopTravelFlags: TravelFlags.SWIM, stopContents: 1, stopArea: 3 }))).toEqual({
      succeeded: true, stopEvent: 2, endArea: 2, endContents: 0, endTravelFlags: TravelFlags.SWIM, endPosition: vec3(100, 0, 0), time: 11,
    });
  });

  test("contents and area stops retain prior travel flags but differ in position and time", () => {
    const env = setup(fixture(chain()));
    expect(env.routing.predictRoute(query({ stopEvent: 12, stopContents: 1, stopArea: 3 }))).toEqual({ succeeded: true,
      stopEvent: 4, endArea: 3, endContents: 1, endTravelFlags: TravelFlags.WALK, endPosition: vec3(110, 0, 0), time: 64 });
    expect(env.routing.predictRoute(query({ stopEvent: 8, stopArea: 3 }))).toEqual({ succeeded: true,
      stopEvent: 8, endArea: 3, endContents: 1, endTravelFlags: TravelFlags.WALK, endPosition: vec3(100, 0, 0), time: 11 });
    expect(env.routing.predictRoute(query({ stopEvent: 8, stopArea: 2 }))).toEqual({ succeeded: true,
      stopEvent: 8, endArea: 2, endContents: 0, endTravelFlags: 0, endPosition: vec3(3, 0, 0), time: 0 });
  });

  test("all preprocessing travel types use real geometry, with masks and 32-crossing truncation", () => {
    for (const type of TEST_TYPES) {
      const traced = TRACED_TYPES.includes(type);
      const bytes = fixture({ areas: Array.from({ length: 35 }, () => ({ cluster: 1 })), links: [
        { from: 1, to: 35, type: type | TravelType.NOTTEAM1, start: vec3(7, 8, 5), end: vec3(19, 20, 345) },
      ] });
      const env = setup(bytes);
      for (const stopArea of [1, 2, 31, 32, 33, 34, 35]) {
        const result = env.routing.predictRoute(query({ goalArea: 35, stopEvent: 8, stopArea }));
        expect(result.stopEvent).toBe(stopArea === 35 || (traced && stopArea <= 32) ? 8 : 0);
        expect(result.endArea).toBe(result.stopEvent === 8 ? stopArea : 35);
      }
    }
  });

  test("crossed contents stop uses reach end, and traversal order beats destination", () => {
    const env = setup(fixture({ areas: [{ cluster: 1 }, { cluster: 1, contents: 512 }, { cluster: 1 }],
      leaves: [1, 2, 1, 3], links: [{ from: 1, to: 3, type: TravelType.GRAPPLEHOOK, start: vec3(0, 0, 5), end: vec3(0, 0, 35) }] }));
    expect(env.spatial.traceAreas(vec3(0, 0, 5), vec3(0, 0, 35), 32).map(crossing => crossing.area)).toEqual([1, 2, 1, 3]);
    expect(env.routing.predictRoute(query({ stopEvent: 12, stopContents: 512, stopArea: 3 }))).toEqual({ succeeded: true,
      stopEvent: 4, endArea: 2, endContents: 512, endTravelFlags: 0, endPosition: vec3(0, 0, 35), time: 11 });
    expect(env.routing.predictRoute(query({ stopEvent: 12, stopContents: 512, stopArea: 1 })).endArea).toBe(1);
  });

  test("vertical preprocessing uses the correct endpoint x/y through actual 3-D planes", () => {
    for (const type of TRACED_TYPES) {
      const bytes = fixture(threeDimensional(type)), env = setup(bytes);
      const expected = type === TravelType.WALKOFFLEDGE ? [4] : type === TravelType.GRAPPLEHOOK ? [1, 4] : [1, 2];
      const queries = Array.from({ length: 5 }, (_, index) => query({ goalArea: 5, stopEvent: 8, stopArea: index + 1 }));
      for (const request of queries) {
        const result = env.routing.predictRoute(request);
        expect(result.stopEvent).toBe(expected.includes(request.stopArea) || request.stopArea === 5 ? 8 : 0);
      }
      if (oraclePath !== undefined) {
        expect(oracle(bytes, ["2"])).toEqual(["CROSS 0 0", `CROSS 1 0 ${expected.join(" ")}`]);
        compare(bytes, queries);
      }
    }
  });

  test("metadata has explicit same-world lifetime and reinitialization preserves cache identity", () => {
    const bytes = fixture(chain()), env = setup(bytes), fresh = new AasRouting(env.world);
    expect(() => fresh.predictRoute(query())).toThrow("not been initialized");
    expect(() => fresh.initializeReachabilityAreas(setup(bytes).spatial)).toThrow("same AAS world");
    fresh.initializeRouting(env.spatial, () => 16 * 1024 * 1024, () => 0);
    const expected = fresh.predictRoute(query()), statistics = fresh.cacheStatistics;
    fresh.initializeReachabilityAreas(env.spatial);
    expect(fresh.cacheStatistics).toEqual(statistics);
    expect(fresh.predictRoute(query())).toEqual(expected);
    expect(fresh.cacheStatistics).toEqual(statistics);
    expect(fresh.areaTravelTimeToGoal({ area: 1, goalArea: 3, origin: null, travelFlags: ALL_FLAGS })).toBeGreaterThan(0);
    expect(fresh.cacheStatistics).toEqual(statistics);
    expect(fresh.setAreaEnabled(2, false)).toBe(true);
    expect(fresh.predictRoute(query()).stopEvent).toBe(RouteStopEvent.NO_ROUTE);
    expect(fresh.setAreaEnabled(2, true)).toBe(false);
    expect(fresh.predictRoute(query())).toEqual(expected);
  });

  test("prediction consumes actual crossing first/count/index cells from the common zone", () => {
    class RoutingMemory extends BotMemory {
      readonly blocks: BotMemoryAllocation[] = [];
      override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
        const block = super.allocate(size, kind, clear); this.blocks.push(block); return block;
      }
    }
    const capacity = 2 * 1024 * 1024, zone = new ZoneArena(capacity), memory = new RoutingMemory(undefined, zone);
    const env = setup(fixture(threeDimensional(TravelType.BARRIERJUMP)), emptyBsp(), memory);
    const records = memory.blocks[8], index = memory.blocks[9];
    if (records === undefined || index === undefined) throw new Error("Missing actual crossing allocations");
    expect([records.bytes.length, index.bytes.length]).toEqual([16, 256]);
    const recordView = new DataView(records.bytes.buffer, records.bytes.byteOffset, records.bytes.byteLength);
    const indexView = new DataView(index.bytes.buffer, index.bytes.byteOffset, index.bytes.byteLength);
    expect([recordView.getInt32(8, true), recordView.getInt32(12, true), indexView.getInt32(0, true), indexView.getInt32(4, true)])
      .toEqual([0, 2, 1, 2]);
    const request = query({ goalArea: 5, stopEvent: RouteStopEvent.ENTER_AREA, stopArea: 2 });
    const expected = env.routing.predictRoute(request);
    expect(expected.stopEvent).toBe(RouteStopEvent.ENTER_AREA);
    recordView.setInt32(12, 1, true);
    expect(env.routing.predictRoute(request).stopEvent).toBe(RouteStopEvent.NONE);
    recordView.setInt32(12, 2, true); indexView.setInt32(4, 3, true);
    expect(env.routing.predictRoute(request).stopEvent).toBe(RouteStopEvent.NONE);
    expect(env.routing.predictRoute({ ...request, stopArea: 3 }).endArea).toBe(3);
    recordView.setInt32(8, 1, true);
    expect(env.routing.predictRoute({ ...request, stopArea: 1 }).stopEvent).toBe(RouteStopEvent.NONE);
    recordView.setInt32(8, 0, true); indexView.setInt32(4, 2, true);
    expect(env.routing.predictRoute(request)).toEqual(expected);
    env.routing.shutdownRouting();
    expect(() => records.bytes).toThrow("freed"); expect(() => index.bytes).toThrow("freed");
    expect(zone.memoryRemaining()).toBe(capacity); zone.checkHeap(); zone.dispose();
  });

  test("failed rebuild retains newly allocated crossing records and leaves route caches intact", () => {
    const env = setup(fixture(threeDimensional(TravelType.BARRIERJUMP)));
    // Explicit synchronous error injection at the geometry boundary; every
    // successful call still executes canonical traversal, never a crossing tape.
    class FailingSpatial extends AasSpatial {
      fail = false;
      override traceAreas(start: Vec3, end: Vec3, maximumAreas: number) {
        if (this.fail) throw new Error("injected spatial preprocessing failure");
        return super.traceAreas(start, end, maximumAreas);
      }
    }
    const spatial = new FailingSpatial(env.world, env.bspEntities, env.spatial.host, DEFAULT_AAS_MOVEMENT_SETTINGS, env.modelTypes, env.links, { kind: "disabled" }, () => 0);
    env.routing.initializeReachabilityAreas(spatial);
    const request = query({ goalArea: 5, stopEvent: 8, stopArea: 2 }), expected = env.routing.predictRoute(request);
    const warmed = env.routing.cacheStatistics;
    spatial.fail = true;
    expect(() => env.routing.initializeReachabilityAreas(spatial)).toThrow("injected spatial");
    expect(env.routing.predictRoute(request)).toEqual({ succeeded: true, stopEvent: 0, endArea: 5,
      endContents: 0, endTravelFlags: TravelFlags.BARRIERJUMP, endPosition: vec3(15, 15, 15), time: 12 });
    expect(env.routing.cacheStatistics).toEqual(warmed);
    spatial.fail = false; env.routing.initializeReachabilityAreas(spatial);
    expect(env.routing.predictRoute(request)).toEqual(expected);
    expect(env.routing.cacheStatistics).toEqual(warmed);
  });

  test("successful zero-cache portal routes preserve later NO_ROUTE partial output and world hop cap", () => {
    const partialBytes = fixture({ areas: [{ cluster: -1 }, { cluster: 1 }, { cluster: 2 }],
      links: [{ from: 1, to: 2, start: vec3(3, 0, 0), end: vec3(9, 0, 0) }], portals: [{ area: 1, front: 1, back: 2 }] });
    const partial = setup(partialBytes);
    expect(partial.routing.route(query())).toEqual({ kind: "found", travelTime: 0, nextReachability: 1 });
    expect(partial.routing.predictRoute(query())).toEqual({ succeeded: false, stopEvent: 1, endArea: 2,
      endContents: 0, endTravelFlags: TravelFlags.WALK, endPosition: vec3(9, 0, 0), time: 11 });
    const cycleBytes = fixture(portalCycle(6)), cycle = setup(cycleBytes);
    expect(cycle.routing.predictRoute(query())).toEqual({ succeeded: false, stopEvent: 0, endArea: 2,
      endContents: 0, endTravelFlags: TravelFlags.WALK, endPosition: ZERO, time: 77 });
    if (oraclePath !== undefined) {
      compare(partialBytes, [query(), query({ maximumAreas: 1 }), query({ stopEvent: 8, stopArea: 2 })]);
      compare(cycleBytes, [query(), query({ maximumAreas: 2 }), query({ maximumTime: 11 }), query({ travelFlags: 0 })]);
    }
  });

  test("zero next reachability is NO_ROUTE even when the source route call succeeds", () => {
    const bytes = fixture({ areas: [{ cluster: -1 }, { cluster: 1 }, { cluster: 2 }], links: [],
      portals: [{ area: 1, front: 1, back: 2 }] });
    const view = new DataView(bytes.buffer), settingsOffset = view.getInt32(12 + 8 * 8, true);
    // Source-valid empty portal starts at the dummy reachability, not table end.
    view.setInt32(settingsOffset + 28 + 24, 0, true);
    const env = setup(bytes);
    expect(env.routing.route(query())).toEqual({ kind: "found", travelTime: 0, nextReachability: 0 });
    expect(env.routing.predictRoute(query())).toEqual({ succeeded: false, stopEvent: 1, endArea: 3,
      endContents: 0, endTravelFlags: 0, endPosition: ZERO, time: 0 });
    if (oraclePath !== undefined) compare(bytes, [query()]);
  });

  test("rejects each undefined signed-int time overflow instead of wrapping it", () => {
    // These calls are deliberately not sent to C: the overflowing addition has
    // no defined native value. The preceding portal cycles are source-grounded.
    for (const [count, start] of [[16385, vec3(65535, 0, 0)], [32768, ZERO]] satisfies readonly [number, Vec3][]) {
      const env = setup(fixture(portalCycle(count, 65535, start)));
      expect(() => env.routing.predictRoute(query())).toThrow("predicted route time exceeds source int range");
    }
  });

  test("keeps initial-area crouch or liquid speed factor for every hop", () => {
    for (const first of [{ cluster: 1, presence: 4 }, { cluster: 1, flags: 5 }] satisfies readonly Area[]) {
      const graph = chain(), bytes = fixture({ ...graph, areas: [first, at(graph.areas, 1), at(graph.areas, 2)] }), env = setup(bytes);
      expect(env.routing.predictRoute(query()).time).toBe(first.presence === 4 ? 163 : 133);
      if (oraclePath !== undefined) compare(bytes, [query(), query({ stopEvent: 4, stopContents: 1 }), query({ stopEvent: 8, stopArea: 3 })]);
    }
  });

  test("checks only the qualified integer and float input boundaries", () => {
    const env = setup(fixture(chain()));
    for (const value of [NaN, Infinity, 0.5, 0x80000000]) {
      expect(() => env.routing.predictRoute(query({ maximumAreas: value }))).toThrow("signed 32-bit");
      expect(() => env.routing.predictRoute(query({ area: value }))).toThrow("signed 32-bit");
    }
    expect(() => env.routing.predictRoute(query({ stopEvent: 0x100000000 }))).toThrow("32-bit masks");
    expect(() => env.routing.predictRoute(query({ origin: vec3(Infinity, 0, 0) }))).toThrow("finite float32");
    expect(env.routing.predictRoute(query({ stopEvent: 0xffffffff, stopArea: -1 })).succeeded).toBe(true);
  });
});

const oraclePath = process.env["Q3_PREDICT_ROUTE_ORACLE"];
function oracle(bytes: Uint8Array, commands: readonly string[]): readonly string[] {
  if (oraclePath === undefined) throw new Error("Set Q3_PREDICT_ROUTE_ORACLE to the unchanged source executable");
  parseAas(bytes);
  const encoded = new TextEncoder().encode(`${commands.join("\n")}\n`), input = new Uint8Array(4 + bytes.length + encoded.length);
  new DataView(input.buffer).setUint32(0, bytes.length, true); input.set(bytes, 4); input.set(encoded, bytes.length + 4);
  const child = Bun.spawnSync([oraclePath], { stdin: input, stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(child.stderr)).toBe(""); expect(child.exitCode).toBe(0);
  return new TextDecoder().decode(child.stdout).trim().split("\n");
}
function command(query: PredictRouteQuery, numAreas: number): string {
  function coordinate(value: number): string { return Object.is(value, -0) ? "-0" : String(value); }
  return `0 ${query.area} ${query.goalArea} ${query.travelFlags | 0} ${query.maximumAreas} ${query.maximumTime} ${query.stopEvent | 0} ${query.stopContents | 0} ${query.stopTravelFlags | 0} ${query.stopArea} ${numAreas} ${coordinate(query.origin.x)} ${coordinate(query.origin.y)} ${coordinate(query.origin.z)}`;
}
function resultLine(result: PredictedRoute, untouchedNumAreas: number): string {
  function word(value: number): number { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); }
  return `PREDICT ${result.succeeded ? 1 : 0} ${result.stopEvent} ${result.endArea} ${result.endContents} ${result.endTravelFlags} ${result.time} ${word(result.endPosition.x)} ${word(result.endPosition.y)} ${word(result.endPosition.z)} ${untouchedNumAreas}`;
}
function expectLines(actual: readonly string[], expected: readonly string[], label: string): void {
  expect(actual.length, `${label} line count`).toBe(expected.length);
  for (const [index, line] of expected.entries()) expect(at(actual, index), `${label} line ${index}`).toBe(line);
}
function compare(bytes: Uint8Array, queries: readonly PredictRouteQuery[], map = emptyBsp()): void {
  const env = setup(bytes, map), commands: string[] = [], expected: string[] = [];
  for (const [index, request] of queries.entries()) {
    const seed = index % 2 === 0 ? 0x12345678 : -12345;
    commands.push(command(request, seed)); expected.push(resultLine(env.routing.predictRoute(request), seed));
  }
  expectLines(oracle(bytes, commands), expected, "native predictor");
  expect(env.messages).toEqual([]);
}
function crossingLines(env: ReturnType<typeof setup>): readonly string[] {
  let first = 0;
  return env.world.reachability.map((reach, index) => {
    const type = reach.travelType & TravelType.MASK;
    const start = type === TravelType.WALKOFFLEDGE ? vec3(reach.end.x, reach.end.y, reach.start.z) : reach.start;
    const end = type === TravelType.BARRIERJUMP || type === TravelType.WATERJUMP ? vec3(reach.start.x, reach.start.y, reach.end.z) : reach.end;
    const crossing = TRACED_TYPES.includes(type) ? env.spatial.traceAreas(start, end, 32).map(crossing => crossing.area) : [];
    const line = `CROSS ${index} ${first}${crossing.length > 0 ? ` ${crossing.join(" ")}` : ""}`;
    first += crossing.length;
    return line;
  });
}

test.skipIf(oraclePath === undefined)("matches unchanged native predictor, partial outputs and untouched numareas", () => {
  const queries: PredictRouteQuery[] = [query()];
  for (const maximumAreas of [-1, 0, 1, 2, 100]) for (const maximumTime of [-1, 0, 10, 11, 63, 64]) {
    for (const stopEvent of [0, 1, 2, 4, 8, 12, 14, -1]) queries.push(query({ maximumAreas, maximumTime, stopEvent, stopContents: 1, stopTravelFlags: TravelFlags.WATER, stopArea: 3 }));
  }
  for (const area of [0, -1, 4, 0x7fffffff, -0x80000000]) {
    queries.push(query({ area, goalArea: area }), query({ area }), query({ area, maximumAreas: -1 }));
  }
  queries.push(query({ area: 0, goalArea: 0, origin: { x: 0.1, y: -0, z: 1.00000007 } }));
  for (const [area, goalArea] of [[1, 0], [1, -1], [1, 4]] satisfies readonly [number, number][]) {
    queries.push(query({ area, goalArea }), query({ area, goalArea, maximumAreas: -1 }));
  }
  for (const stopTravelFlags of [TravelFlags.WALK, TravelFlags.SWIM, TravelFlags.AIR, TravelFlags.WATER, ALL_FLAGS]) {
    queries.push(query({ stopEvent: 14, stopTravelFlags, stopArea: 2, stopContents: 1 }));
  }
  compare(fixture(chain()), queries);
});

test.skipIf(oraclePath === undefined)("matches unchanged preprocessing and stop queries for all travel types", () => {
  for (const type of TEST_TYPES) {
    const graph: Graph = { areas: Array.from({ length: 35 }, (_, index) => ({ cluster: 1, contents: index === 17 ? 512 : 0 })),
      links: [{ from: 1, to: 35, type: type | TravelType.NOTTEAM2, start: vec3(7, 8, 5), end: vec3(19, 20, 345) }] };
    const bytes = fixture(graph), env = setup(bytes);
    expectLines(oracle(bytes, ["2"]), crossingLines(env), "native synthetic crossings");
    compare(bytes, Array.from({ length: 36 }, (_, stopArea) => query({ goalArea: 35, stopArea, stopEvent: 12, stopContents: 512 })));
  }
});

test.skipIf(oraclePath === undefined)("native reinitialization and disabled-area transitions share the actual route caches", () => {
  const bytes = fixture(chain()), env = setup(bytes), request = query(), seed = 1234;
  const route = env.routing.route(request);
  if (route.kind !== "found") throw new Error("Fixture route must exist");
  const commands = [`4 1 3 ${ALL_FLAGS} 0 0 0`, command(request, seed), "3", command(request, seed), "1 2 0", command(request, seed), "1 2 1", command(request, seed)];
  const warmed = env.routing.cacheStatistics, result = env.routing.predictRoute(request);
  expect(env.routing.cacheStatistics).toEqual(warmed);
  env.routing.initializeReachabilityAreas(env.spatial);
  expect(env.routing.predictRoute(request)).toEqual(result);
  expect(env.routing.cacheStatistics).toEqual(warmed);
  const expected = [`ROUTE 1 ${route.travelTime} ${route.nextReachability}`, resultLine(result, seed), "INIT", resultLine(result, seed)];
  expected.push(`ENABLE ${env.routing.setAreaEnabled(2, false) ? 1 : 0}`, resultLine(env.routing.predictRoute(request), seed));
  expected.push(`ENABLE ${env.routing.setAreaEnabled(2, true) ? 1 : 0}`, resultLine(env.routing.predictRoute(request), seed));
  expect(oracle(bytes, commands)).toEqual(expected);
});

const retailData = process.env["Q3_DATA"];
// Unchanged pinned C, GCC binary32 O0/O2. These cover all crossing records and
// the 300 queries per map below; x87 is a separate, nonmatching profile.
const RETAIL_RECORDINGS: readonly { readonly name: string; readonly aas: string; readonly crossings: string; readonly predictions: string }[] = [
  { name: "q3dm1", aas: "2070b35b34b9820b84a5e1e1cbdcd50791fb091f15d04aa68692ab561e7b44cc",
    crossings: "84db14c31a0c1dbd9dce60341e84383a1769a7d03f80ecada5917284cf452e76",
    predictions: "58773bf3d29534bfc275b8c4e53b901c31dea908151dbfb7195274a36fde45b2" },
  { name: "mpteam1", aas: "6b1893bbfd9c31de2eb4c1fa946b7caf43ff83f651dd001e4a811db3f7978e5f",
    crossings: "1509175d92ea12f5030e97e7ed4cf0c891c973fb1ce3c40f50c24e7784f5c46d",
    predictions: "65c8f65e040177bcc435b64da3f8d8794278af39c64070f960907dd09089d55e" },
];
test.skipIf(retailData === undefined)("matches recorded retail spatial preprocessing and predictions, with optional live native comparison", async () => {
  if (retailData === undefined) throw new Error("Set Q3_DATA to the installed data root");
  expect(existsSync(join(retailData, "missionpack/pak0.pk3"))).toBe(true);
  const files = await VirtualFileSystem.openInspection({ dataPath: retailData, homePath: retailData, cdPath: null, product: "missionpack" });
  for (const recording of RETAIL_RECORDINGS) {
    const name = recording.name;
    const bytes = await files.read(`maps/${name}.aas`), map = parseBsp(await files.read(`maps/${name}.bsp`));
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(recording.aas);
    const env = setup(bytes, map), candidates = env.world.areaSettings.flatMap((settings, area) => settings.cluster !== 0 && settings.reachableAreaCount > 0 ? [area] : []);
    const crossings = crossingLines(env);
    expect(new Bun.CryptoHasher("sha256").update(`${crossings.join("\n")}\n`).digest("hex")).toBe(recording.crossings);
    if (oraclePath !== undefined) expectLines(oracle(bytes, ["2"]), crossings, `${name} native crossings`);
    let seed = 0x1984;
    function random(maximum: number): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; }
    const queries: PredictRouteQuery[] = [];
    for (let i = 0; i < 300; i++) {
      const area = at(candidates, random(candidates.length)), goalArea = at(candidates, random(candidates.length));
      queries.push(query({ area, goalArea, origin: at(env.world.areas, area).center, travelFlags: i % 2 === 0 ? ALL_FLAGS : TravelFlags.DEFAULT,
        maximumAreas: i % 5 === 0 ? 1 : 100, maximumTime: i % 3 === 0 ? 1000 : 0,
        stopEvent: at([0, 2, 4, 8, 14], i % 5), stopContents: 32 | 512 | 1, stopTravelFlags: TravelFlags.ELEVATOR | TravelFlags.FUNCBOB | TravelFlags.BRIDGE,
        stopArea: i % 2 === 0 ? goalArea : area }));
    }
    const predicted = queries.map(request => resultLine(env.routing.predictRoute(request), 1234));
    expect(new Bun.CryptoHasher("sha256").update(`${predicted.join("\n")}\n`).digest("hex")).toBe(recording.predictions);
    expect(env.messages).toEqual([]);
    if (oraclePath !== undefined) compare(bytes, queries, map);
  }
}, 60_000);
