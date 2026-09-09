import { describe, expect, expectTypeOf, test } from "bun:test";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasEntityHistory } from "../src/botlib/entity.ts";
import { BotGoalLibrary } from "../src/botlib/goals.ts";
import type { GoalWorldHost } from "../src/botlib/goals.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasNode, AasPlane } from "../src/botlib/aas.ts";
import { AasRouting, AlternativeRouteType, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import type { AlternativeGoal, AlternativeRouteQuery, AreaTravelTimeQuery } from "../src/botlib/routing.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { vec3 } from "../src/core/math.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const ZERO = vec3(0, 0, 0), ALL_FLAGS = 0x1fffffff;
const BOUNDS: Bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing fixture index ${index}`); return value;
}
interface Area { readonly cluster: number; readonly contents?: number; readonly flags?: number; readonly presence?: number; readonly center?: Vec3; readonly faceIndexes?: readonly number[] }
interface Link { readonly from: number; readonly to: number; readonly time?: number; readonly type?: number; readonly start?: Vec3; readonly end?: Vec3 }
interface Portal { readonly area: number; readonly front: number; readonly back: number }
interface Graph {
  readonly areas: readonly Area[]; readonly links: readonly Link[]; readonly portals?: readonly Portal[];
  /** Actual ordered BSP leaves along z; repetitions deliberately test duplicate crossings. */
  readonly leaves?: readonly number[];
  readonly faces?: readonly (readonly [number, number])[];
  readonly dummyCenter?: Vec3;
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
  const faces = graph.faces ?? [];
  const areaFaces = [[], ...areas.map((area, index) => area.faceIndexes ?? faces.flatMap((face, ordinal) =>
    face[0] === index + 1 ? [ordinal + 1] : face[1] === index + 1 ? [-ordinal - 1] : []))];
  lumps[5] = encode((faces.length + 1) * 24, writer => {
    writer.bytes(new Uint8Array(24));
    for (const face of faces) { writer.i32(0); writer.i32(0); writer.i32(0); writer.i32(0); writer.i32(face[0]); writer.i32(face[1]); }
  });
  lumps[6] = encode(areaFaces.flat().length * 4, writer => { for (const list of areaFaces) for (const face of list) writer.i32(face); });
  lumps[7] = encode((areas.length + 1) * 48, writer => {
    let firstFace = 0;
    for (let area = 0; area <= areas.length; area++) {
      const faces = at(areaFaces, area);
      writer.i32(area); writer.i32(faces.length); writer.i32(firstFace); firstFace += faces.length;
      vector(writer, BOUNDS.min); vector(writer, BOUNDS.max);
      vector(writer, area === 0 ? graph.dummyCenter ?? ZERO : at(areas, area - 1).center ?? vec3(0, 0, area * 10 - 5));
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

function word(value: number): number { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); }
function position(point: Vec3): string { return `${word(point.x)} ${word(point.y)} ${word(point.z)}`; }
/** Boundary observer only: all time answers and caches come from the actual owner. */
class ObservedRouting extends AasRouting {
  readonly events: string[] = [];
  override areaTravelTimeToGoal(query: AreaTravelTimeQuery): number {
    const time = super.areaTravelTimeToGoal(query);
    this.events.push(`TIME ${query.area} ${query.goalArea} ${query.travelFlags | 0} ${query.origin === null ? "0" : `1 ${position(query.origin)}`} ${time}`);
    return time;
  }
}
function setup(bytes: Uint8Array, initialize = true, maximumCacheBytes = 16 * 1024 * 1024) {
  const world = parseAas(bytes), routing = new ObservedRouting(world);
  const unexpected = (): never => { throw new Error("Routing graph fixture requested BSP host services"); };
  const entities = new AasBspEntities(unexpected);
  entities.load("");
  const spatial = new AasSpatial(world, entities, { print: unexpected, trace: unexpected, pointContents: unexpected,
    entityTrace: unexpected, entityModelIndex: unexpected, modelBounds: unexpected }, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  routing.initializeRouting(spatial, () => maximumCacheBytes, () => 0);
  const log = { write: (text: string): void => { routing.events.push(`LOG ${text}`); } };
  if (initialize) routing.initializeAlternativeRouting(log);
  return { world, routing, log };
}
function query(overrides: Partial<AlternativeRouteQuery> = {}): AlternativeRouteQuery {
  return { start: ZERO, startArea: 1, goal: ZERO, goalArea: 5, travelFlags: ALL_FLAGS,
    maximumGoals: 32, type: AlternativeRouteType.ALL, ...overrides };
}
function diamond(): Graph {
  return { areas: [{ cluster: 1 }, { cluster: 1, contents: 8 }, { cluster: 1, contents: 512 }, { cluster: 1 }, { cluster: 1 }],
    links: [{ from: 1, to: 2, time: 30 }, { from: 1, to: 3, time: 30 }, { from: 1, to: 4, time: 45 },
      { from: 2, to: 5, time: 20 }, { from: 3, to: 5, time: 20 }, { from: 4, to: 5, time: 20 }],
    faces: [[2, 3]] };
}
function threshold(goalTime: number, startTime: number, endTime: number): Graph {
  return { areas: [{ cluster: 1 }, { cluster: 1 }, { cluster: 1 }], links: [
    { from: 1, to: 3, time: goalTime - 2 }, { from: 1, to: 2, time: startTime - 2 }, { from: 2, to: 3, time: endTime - 1 },
  ] };
}
function portalChain(): Graph {
  return { areas: [{ cluster: 1 }, { cluster: -1, contents: 8 }, { cluster: 2, contents: 512 }, { cluster: -2, contents: 8 }, { cluster: 3 }],
    links: [{ from: 1, to: 2, time: 30 }, { from: 2, to: 3, time: 10 }, { from: 3, to: 4, time: 10 }, { from: 4, to: 5, time: 10 }],
    portals: [{ area: 2, front: 1, back: 2 }, { area: 4, front: 2, back: 3 }], faces: [[2, 3], [3, 4]] };
}
function goalLine(goal: AlternativeGoal): string {
  return `GOAL ${goal.area} ${position(goal.origin)} ${goal.startTravelTime} ${goal.goalTravelTime} ${goal.extraTravelTime}`;
}
function execute(routing: ObservedRouting, request: AlternativeRouteQuery): void {
  const goals = routing.alternativeRouteGoals(request);
  routing.events.push(`ALT ${goals.length}`, ...goals.map(goalLine));
}
const oraclePath = process.env["Q3_ALTERNATIVE_ROUTE_ORACLE"];
function oracle(bytes: Uint8Array, commands: readonly string[]): readonly string[] {
  if (oraclePath === undefined) throw new Error("Set Q3_ALTERNATIVE_ROUTE_ORACLE to the explicitly repaired time-projection oracle");
  parseAas(bytes);
  const encoded = new TextEncoder().encode(`${commands.join("\n")}\n`), input = new Uint8Array(4 + bytes.length + encoded.length);
  new DataView(input.buffer).setUint32(0, bytes.length, true); input.set(bytes, 4); input.set(encoded, bytes.length + 4);
  const child = Bun.spawnSync([oraclePath], { stdin: input, stdout: "pipe", stderr: "pipe" });
  const diagnostics = new TextDecoder().decode(child.stderr).trim().split("\n");
  expect(diagnostics.length).toBe(2);
  expect(at(diagnostics, 0)).toMatch(/^Opened log \/tmp\/quake3-alt-log-/);
  expect(at(diagnostics, 1)).toMatch(/^Closed log \/tmp\/quake3-alt-log-/);
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return new TextDecoder().decode(child.stdout).trim().split("\n");
}
function command(request: AlternativeRouteQuery): string {
  function coordinate(value: number): string { return Object.is(value, -0) ? "-0" : String(value); }
  return `6 ${request.startArea} ${request.goalArea} ${request.travelFlags | 0} ${request.maximumGoals} ${request.type | 0} ${coordinate(request.start.x)} ${coordinate(request.start.y)} ${coordinate(request.start.z)} ${coordinate(request.goal.x)} ${coordinate(request.goal.y)} ${coordinate(request.goal.z)}`;
}
function compare(bytes: Uint8Array, requests: readonly AlternativeRouteQuery[]): readonly string[] {
  const env = setup(bytes);
  for (const request of requests) execute(env.routing, request);
  const native = oracle(bytes, requests.map(command));
  expect(native.length).toBe(env.routing.events.length);
  for (const [index, line] of native.entries()) expect(at(env.routing.events, index), `native event ${index}`).toBe(line);
  return native;
}

describe("source AAS alternative-route goals", () => {
  test("real face components, strict centroid ties, exact times and logs", () => {
    const env = setup(fixture(diamond()));
    expectTypeOf<AlternativeRouteQuery["goal"]>().toEqualTypeOf<Vec3>();
    expect(env.routing.alternativeRouteGoals(query())).toEqual([
      { origin: vec3(0, 0, 15), area: 2, startTravelTime: 32, goalTravelTime: 21, extraTravelTime: 0 },
      { origin: vec3(0, 0, 35), area: 4, startTravelTime: 47, goalTravelTime: 21, extraTravelTime: 15 },
    ]);
    expect(env.routing.events.filter(event => event.startsWith("LOG "))).toEqual(["LOG 0 midrange area 2", "LOG 1 midrange area 3", "LOG 2 midrange area 4"]);
  });

  test("filter bits, zero type, post-output limits and full candidate logging", () => {
    for (const maximumGoals of [-0x80000000, -1, 0, 1, 2, 32]) {
      const env = setup(fixture(diamond()));
      expect(env.routing.alternativeRouteGoals(query({ maximumGoals })).map(goal => goal.area)).toEqual(maximumGoals <= 1 ? [2] : [2, 4]);
      expect(env.routing.events.filter(event => event.startsWith("LOG ")).length).toBe(3);
    }
    for (const [type, areas] of [[0, []], [2, [2]], [4, [3]], [6, [2]], [7, [2, 4]], [-1, [2, 4]]] satisfies readonly [number, readonly number[]][]) {
      const env = setup(fixture(diamond()));
      expect(env.routing.alternativeRouteGoals(query({ type })).map(goal => goal.area)).toEqual(areas);
      if (type === 0) expect(env.routing.events).toEqual([`TIME 1 5 ${ALL_FLAGS} 1 0 0 0 53`]);
    }
  });

  test("zero areas return before lifetime and ignored arguments; missing scratch follows the first cache query", () => {
    const env = setup(fixture(diamond()), false);
    const ignored = query({ start: vec3(Infinity, NaN, 0), goal: vec3(NaN, Infinity, 0), maximumGoals: NaN, type: NaN, travelFlags: NaN });
    expect(env.routing.alternativeRouteGoals({ ...ignored, startArea: 0 })).toEqual([]);
    expect(env.routing.alternativeRouteGoals({ ...ignored, goalArea: 0 })).toEqual([]);
    expect(env.routing.events).toEqual([]);
    expect(() => env.routing.alternativeRouteGoals(query())).toThrow("not been initialized");
    expect(env.routing.events).toEqual([`TIME 1 5 ${ALL_FLAGS} 1 0 0 0 53`]);
    expect(env.routing.cacheStatistics.entries).toBe(1);
    env.routing.initializeAlternativeRouting(env.log);
    expect(env.routing.alternativeRouteGoals(query({ goal: vec3(NaN, Infinity, -Infinity) })).length).toBe(2);
    env.routing.shutdownAlternativeRouting(); env.routing.shutdownAlternativeRouting();
    expect(env.routing.alternativeRouteGoals({ ...ignored, startArea: 0 })).toEqual([]);
    expect(() => env.routing.alternativeRouteGoals(query())).toThrow("not been initialized");
  });

  test("zero initial time still visits candidate routes, and nonzero invalid areas use canonical route rejection", () => {
    const env = setup(fixture(diamond()));
    expect(env.routing.alternativeRouteGoals(query({ travelFlags: 0 }))).toEqual([]);
    expect(env.routing.events.length).toBe(5);
    for (const startArea of [-1, 6, 0x7fffffff, -0x80000000]) expect(env.routing.alternativeRouteGoals(query({ startArea }))).toEqual([]);
    for (const goalArea of [-1, 6]) expect(env.routing.alternativeRouteGoals(query({ goalArea }))).toEqual([]);
    expect(() => env.routing.alternativeRouteGoals(query({ startArea: 0x100000000 }))).toThrow("signed int32");
    expect(() => env.routing.alternativeRouteGoals(query({ maximumGoals: 0.5 }))).toThrow("signed int32");
    expect(() => env.routing.alternativeRouteGoals(query({ type: 0x100000000 }))).toThrow("32-bit integer");
  });

  test("float32 threshold equality accepts, adjacent integer costs reject", () => {
    for (const [start, end, accepted] of [[110, 80, true], [111, 80, false], [110, 81, false]] satisfies readonly [number, number, boolean][]) {
      const bytes = fixture(threshold(100, start, end)), env = setup(bytes), request = query({ goalArea: 3 });
      expect(env.routing.alternativeRouteGoals(request)).toEqual(accepted ? [
        { area: 2, origin: vec3(0, 0, 15), startTravelTime: 110, goalTravelTime: 80, extraTravelTime: 90 },
      ] : []);
      if (oraclePath !== undefined) compare(bytes, [request]);
    }
  });

  test("full time passes threshold before Uint16 stores and negative extra wraps", () => {
    const bytes = fixture({ areas: [{ cluster: 1, flags: 5 }, { cluster: 1 }, { cluster: 1 }], links: [
      { from: 1, to: 3, time: 500 }, { from: 1, to: 2, time: 1000 }, { from: 2, to: 3, time: 20 },
    ] });
    const request = query({ goalArea: 3, start: vec3(-65000, 0, 0) }), env = setup(bytes);
    expect(env.routing.alternativeRouteGoals(request)).toEqual([
      { area: 1, origin: vec3(0, 0, 5), startTravelTime: 1, goalTravelTime: 501, extraTravelTime: 537 },
      { area: 2, origin: vec3(0, 0, 15), startTravelTime: 465, goalTravelTime: 21, extraTravelTime: 521 },
    ]);
    expect(env.routing.events).toContain(`TIME 1 2 ${ALL_FLAGS} 1 ${position(request.start)} 66001`);
    if (oraclePath !== undefined) compare(bytes, [request]);
  });

  test("distance sentinel preserves dummy-area coordinates and zero times, including float overflow", () => {
    for (const centers of [[vec3(2000000, 0, 0), vec3(-2000000, 0, 0)],
      [vec3(3e38, 0, 0), vec3(3e38, 0, 0)]] satisfies readonly [Vec3, Vec3][]) {
      const graph = diamond(), bytes = fixture({ ...graph, areas: graph.areas.map((area, index) => index === 1 || index === 2
        ? { ...area, center: at(centers, index - 1) } : area), dummyCenter: vec3(7, -0, 9) });
      const env = setup(bytes), request = query({ type: 6 });
      expect(env.routing.alternativeRouteGoals(request)).toEqual([
        { area: 0, origin: vec3(7, -0, 9), startTravelTime: 0, goalTravelTime: 0, extraTravelTime: 65483 },
      ]);
      if (oraclePath !== undefined) compare(bytes, [request]);
    }
  });

  test("ordered recursive face traversal, signed repeats and disconnected components", () => {
    const graph = diamond();
    for (const faceOrder of [[2, 1, 2], [1, 2, 1]]) {
      const bytes = fixture({ ...graph, areas: graph.areas.map((area, index) => index === 1 ? { ...area, faceIndexes: faceOrder }
        : index === 2 ? { ...area, center: vec3(0, 0, 35) } : index === 3 ? { ...area, center: vec3(0, 0, 35) } : area),
      faces: [[2, 3], [2, 4], [3, 4], [2, 0]] });
      const env = setup(bytes);
      // Both near-center candidates are identical, so their DFS order resolves the tie.
      expect(env.routing.alternativeRouteGoals(query()).map(goal => goal.area)).toEqual(faceOrder[0] === 2 ? [4] : [3]);
      if (oraclePath !== undefined) compare(bytes, [query()]);
    }
  });

  test("same-owner lifetime, disabled-area invalidation, warmed routes and independent owners", () => {
    const bytes = fixture(portalChain()), env = setup(bytes), request = query();
    const goals = env.routing.alternativeRouteGoals(request), warmed = env.routing.cacheStatistics;
    expect(goals.length).toBe(1);
    env.routing.route({ area: 1, origin: ZERO, goalArea: 5, travelFlags: ALL_FLAGS });
    expect(env.routing.cacheStatistics).toEqual(warmed);
    env.routing.initializeAlternativeRouting(env.log);
    expect(env.routing.alternativeRouteGoals(request)).toEqual(goals);
    expect(env.routing.cacheStatistics).toEqual(warmed);
    env.routing.shutdownAlternativeRouting();
    expect(env.routing.cacheStatistics).toEqual(warmed);
    env.routing.initializeAlternativeRouting(env.log);
    expect(env.routing.setAreaEnabled(2, false)).toBe(true);
    expect(env.routing.alternativeRouteGoals(request)).toEqual([]);
    expect(env.routing.setAreaEnabled(2, true)).toBe(false);
    expect(env.routing.alternativeRouteGoals(request)).toEqual(goals);
    expect(setup(bytes).routing.cacheStatistics.entries).toBe(0);
  });

  test("centroid uses double reciprocal after binary32 accumulation", () => {
    const graph = diamond(), centers = [vec3(0.369, 0, 0), vec3(0.494, 0, 0), vec3(0.4315, 0.5, 0)];
    const bytes = fixture({ ...graph, faces: [[2, 3], [3, 4]], areas: graph.areas.map((area, index) => index >= 1 && index <= 3
      ? { ...area, center: at(centers, index - 1) } : area) });
    // Rounding 1/3 before multiplication changes the selected goal to area 3.
    expect(setup(bytes).routing.alternativeRouteGoals(query()).map(goal => goal.area)).toEqual([2]);
    if (oraclePath !== undefined) compare(bytes, [query()]);
  });

  test("centroid rounds each sum in recursive face order", () => {
    const centers = [ZERO, vec3(0.125, 0, 0), vec3(16777216, 0, 0), vec3(-16777216, 0, 0), vec3(-0.125, 0, 0), ZERO];
    const graph: Graph = { areas: centers.map(center => ({ cluster: 1, center })), links: [
      ...[2, 3, 4, 5].map(to => ({ from: 1, to, time: 30 })), ...[2, 3, 4, 5].map(from => ({ from, to: 6, time: 20 })),
    ], faces: [[2, 3], [3, 4], [4, 5]] };
    const bytes = fixture(graph), request = query({ goalArea: 6 });
    expect(setup(bytes).routing.alternativeRouteGoals(request).map(goal => goal.area)).toEqual([5]);
    if (oraclePath !== undefined) compare(bytes, [request]);
    const reordered = fixture({ ...graph, faces: [[2, 5], [5, 3], [3, 4]] });
    expect(setup(reordered).routing.alternativeRouteGoals(request).map(goal => goal.area)).toEqual([2]);
    if (oraclePath !== undefined) compare(reordered, [request]);
  });

  test("alternative queries participate in the existing bounded-cache eviction policy", () => {
    const env = setup(fixture(diamond()), true, 2 * (64 + 3 * 5));
    const goals = env.routing.alternativeRouteGoals(query());
    expect(goals.length).toBe(2);
    expect(env.routing.cacheStatistics).toEqual({ areaUpdates: 4, portalUpdates: 0, entries: 2, bytes: 158 });
    env.routing.route({ area: 1, origin: ZERO, goalArea: 5, travelFlags: ALL_FLAGS });
    env.routing.route({ area: 1, origin: ZERO, goalArea: 4, travelFlags: ALL_FLAGS });
    expect(env.routing.cacheStatistics.areaUpdates).toBe(4);
    env.routing.route({ area: 1, origin: ZERO, goalArea: 2, travelFlags: ALL_FLAGS });
    expect(env.routing.cacheStatistics.areaUpdates).toBe(5);
    expect(env.routing.alternativeRouteGoals(query())).toEqual(goals);
    if (oraclePath !== undefined) {
      const records = oracle(fixture(diamond()), [command(query()), "9", "5 2", `4 1 5 ${ALL_FLAGS} 0 0 0`, "9"]);
      // Actual source LRU before and after the supplied memory-pressure boundary.
      expect(records.filter(line => line.startsWith("CACHE"))).toEqual(["CACHE 1:1:2 1:1:3 1:1:4 1:1:5", "CACHE 1:1:4 1:1:5"]);
      expect(records).toContain("ROUTE 1 53 2");
    }
  });
});

test.skipIf(oraclePath === undefined)("native all masks, maximum quirks, ignored goal and actual cache call order", () => {
  const requests: AlternativeRouteQuery[] = [];
  for (const type of [0, 1, 2, 4, 6, 7, -1]) for (const maximumGoals of [-1, 0, 1, 2, 32]) requests.push(query({ type, maximumGoals }));
  requests.push(query({ travelFlags: 0 }), query({ startArea: 0 }), query({ goalArea: 0 }),
    query({ startArea: -1 }), query({ goalArea: -1 }), query({ goal: vec3(NaN, Infinity, -Infinity) }));
  compare(fixture(diamond()), requests);
});

test.skipIf(oraclePath === undefined)("native normalized null-time candidates span nonportal intercluster and start-portal branches", () => {
  const requests: AlternativeRouteQuery[] = [];
  for (const startArea of [1, 2, 3, 4]) for (const goalArea of [1, 2, 3, 4, 5]) for (const type of [1, 2, 4, 6]) requests.push(query({ startArea, goalArea, type }));
  compare(fixture(portalChain()), requests);
});

test.skipIf(oraclePath === undefined)("native initialization and shutdown leave shared route caches intact", () => {
  const bytes = fixture(portalChain()), env = setup(bytes), request = query(), commands: string[] = [];
  commands.push(command(request)); execute(env.routing, request);
  commands.push("7"); env.routing.initializeAlternativeRouting(env.log); env.routing.events.push("ALTINIT");
  commands.push(command(request)); execute(env.routing, request);
  commands.push("1 2 0"); env.routing.events.push(`ENABLE ${env.routing.setAreaEnabled(2, false) ? 1 : 0}`);
  commands.push(command(request)); execute(env.routing, request);
  commands.push("1 2 1"); env.routing.events.push(`ENABLE ${env.routing.setAreaEnabled(2, true) ? 1 : 0}`);
  commands.push(command(request)); execute(env.routing, request);
  commands.push("8", command(query({ startArea: 0 })), "7");
  env.routing.shutdownAlternativeRouting(); env.routing.events.push("ALTSHUTDOWN"); execute(env.routing, query({ startArea: 0 }));
  env.routing.initializeAlternativeRouting(env.log); env.routing.events.push("ALTINIT");
  commands.push(command(request)); execute(env.routing, request);
  expect(oracle(bytes, commands)).toEqual(env.routing.events);
});

test.skipIf(oraclePath === undefined)("native binary32 threshold boundary sweep uses actual graph costs", () => {
  for (const goalTime of [10, 100, 1001, 8191, 16383, 32767, 59001]) {
    const startBoundary = Math.floor(Math.fround(Math.fround(1.1) * goalTime));
    const endBoundary = Math.floor(Math.fround(Math.fround(0.8) * goalTime));
    for (const startDelta of [-1, 0, 1]) for (const endDelta of [-1, 0, 1]) {
      compare(fixture(threshold(goalTime, startBoundary + startDelta, endBoundary + endDelta)), [query({ goalArea: 3 })]);
    }
  }
});

const retailData = process.env["Q3_DATA"];
test.skipIf(retailData === undefined)("recorded retail route candidates preserve every goal and native cache-call event", async () => {
  if (retailData === undefined) throw new Error("Set Q3_DATA to the installed data root");
  const files = await VirtualFileSystem.openInspection({ dataPath: retailData, homePath: retailData, cdPath: null, product: "missionpack" });
  for (const name of ["q3dm1", "mpteam1"]) {
    const bytes = files.readSync(`maps/${name}.aas`), env = setup(bytes);
    const incoming = new Uint32Array(env.world.areas.length);
    for (const reach of env.world.reachability) {
      const count = incoming[reach.area]; if (count === undefined) throw new Error("invalid parsed reach area");
      incoming[reach.area] = count + 1;
    }
    // The unchanged native cache seed has only 128 entries. These assets avoid
    // the separately accepted large-incoming-count repair exercised elsewhere.
    expect(Math.max(...incoming)).toBeLessThanOrEqual(128);
    const areas = env.world.areaSettings.flatMap((settings, area) => settings.cluster !== 0 && settings.reachableAreaCount > 0 ? [area] : []);
    let seed = 0x1984;
    function random(maximum: number): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; }
    const requests: AlternativeRouteQuery[] = [];
    for (let index = 0; index < 32; index++) {
      const startArea = at(areas, random(areas.length)), goalArea = at(areas, random(areas.length));
      requests.push(query({ startArea, start: at(env.world.areas, startArea).center, goalArea, goal: at(env.world.areas, goalArea).center,
        type: index % 2 === 0 ? 1 : 6, travelFlags: index % 3 === 0 ? ALL_FLAGS : TravelFlags.DEFAULT,
        maximumGoals: at([-1, 0, 1, 32], index % 4) }));
    }
    for (const request of requests) execute(env.routing, request);
    if (oraclePath !== undefined) compare(bytes, requests);
    const recorded = name === "q3dm1" ? { count: 12732, events: "cf345db058232890fca441ae340456e085c2bddae4bccecaf9932faf334fe3cd" }
      : { count: 56784, events: "0a9b7c4d60c0c51d21da1faf0c9e5a11dd3d0ecc4abf5e6ac4c202c95973a3c0" };
    expect(env.routing.events.length).toBe(recorded.count);
    expect(new Bun.CryptoHasher("sha256").update(`${env.routing.events.join("\n")}\n`).digest("hex")).toBe(recorded.events);
  }
}, 60_000);

test.skipIf(retailData === undefined)("retail objective goals use real item placement, spatial metadata and the same routing owner", async () => {
  if (retailData === undefined) throw new Error("Set Q3_DATA to the installed data root");
  const files = await VirtualFileSystem.openInspection({ dataPath: retailData, homePath: retailData, cdPath: null, product: "missionpack" });
  for (const name of ["mpteam1", "mpteam4"]) {
    const bytes = files.readSync(`maps/${name}.aas`), bsp = parseBsp(files.readSync(`maps/${name}.bsp`));
    const env = setup(bytes), collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" }), messages: string[] = [];
    const host: AasSpatialHost & GoalWorldHost = {
      print: text => { messages.push(text); },
      trace: (start, end, bounds, _pass, mask) => ({ ...collision.trace({ start, end, mask,
        shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } }), entityNum: 1022 }),
      pointContents: point => collision.pointContents(point),
      // Static BSP item initialization occurs before this fixture links any entities.
      entityTrace: () => { throw new Error("unexpected trace of an unlinked fixture entity"); },
      entityModelIndex: number => history.entityModelIndex(number),
      modelBounds: model => ({ bounds: collision.modelBounds(model), origin: ZERO }),
      nextEntity: after => history.nextEntity(after), entityInfo: number => history.info(number),
    };
    const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
    bspEntities.load(bsp.entities);
    const links = linkHeap();
    const spatial = new AasSpatial(env.world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
    const history = new AasEntityHistory(1024, { maxEntities: 1024, map: () => ({ kind: "ready", spatial }), time: () => 1,
      frameNumber: () => 1, print: (_severity, text) => { messages.push(text); } }, links);
    env.routing.initializeReachabilityAreas(spatial);
    const resolver = new BotScriptSources(files, new ScriptGlobalDefines(), (_severity, text) => { host.print(text); return undefined; }, text => { host.print(text); return undefined; }), store = new WeightConfigStore(resolver), random = new LinuxNativeRandom(1);
    const requests: AlternativeRouteQuery[] = [];
    for (const gameType of [4, 5, 6, 7]) {
      const library = new BotGoalLibrary({ resolver, weightStore: store, log: { write: text => { messages.push(text); } }, clock: () => 1, gameType: () => gameType, random: { nextInt: () => random.next() } });
      expect(library.setup()).toBe(0);
      library.initLevelItems({ bspEntities, navigation: { spatial, routing: env.routing }, host, pointArea: point => env.world.pointArea(point) });
      const suffix = gameType <= 5 ? "Flag" : "Obelisk", start = library.getLevelItemGoal(-1, `Neutral ${suffix}`);
      if (start === null) throw new Error(`${name} has no real Neutral ${suffix} goal`);
      expect(start.area).toBeGreaterThan(0);
      for (const team of ["Red", "Blue"]) {
        const goal = library.getLevelItemGoal(-1, `${team} ${suffix}`);
        if (goal === null) throw new Error(`${name} has no real ${team} ${suffix} goal`);
        expect(goal.area).toBeGreaterThan(0);
        requests.push(query({ start: start.origin, startArea: start.area, goal: goal.origin, goalArea: goal.area, travelFlags: TravelFlags.DEFAULT, type: 6 }));
      }
      library.shutdown();
    }
    const output: string[] = [];
    for (const request of requests) {
      const goals = env.routing.alternativeRouteGoals(request);
      output.push(command(request), `ALT ${goals.length}`, ...goals.map(goalLine));
      const before = env.routing.cacheStatistics;
      const prediction = env.routing.predictRoute({ area: request.startArea, origin: request.start, goalArea: request.goalArea,
        travelFlags: request.travelFlags, maximumAreas: 100, maximumTime: 0, stopEvent: 0, stopArea: 0, stopContents: 0, stopTravelFlags: 0 });
      if (oraclePath !== undefined) {
        const native = oracle(bytes, [`0 ${request.startArea} ${request.goalArea} ${request.travelFlags} 100 0 0 0 0 0 1234 ${request.start.x} ${request.start.y} ${request.start.z}`]);
        expect(native).toEqual([`PREDICT ${prediction.succeeded ? 1 : 0} ${prediction.stopEvent} ${prediction.endArea} ${prediction.endContents} ${prediction.endTravelFlags} ${prediction.time} ${position(prediction.endPosition)} 1234`]);
      }
      env.routing.initializeAlternativeRouting(env.log);
      expect(env.routing.alternativeRouteGoals(request)).toEqual(goals);
      expect(env.routing.cacheStatistics.areaUpdates).toBe(before.areaUpdates);
      expect(env.routing.cacheStatistics.portalUpdates).toBe(before.portalUpdates);
    }
    expect(messages).toEqual([]);
    if (oraclePath !== undefined) compare(bytes, requests);
    const recorded = name === "mpteam1"
      ? { aas: "6b1893bbfd9c31de2eb4c1fa946b7caf43ff83f651dd001e4a811db3f7978e5f", goals: "5e803ade2459bc5475b036dc71df55fa57b93c3b7442cedba9aa0cf0dec3174e" }
      : { aas: "2a2fb21170daed0b2d12af9c40e355fa7b68a66a6875b8b8e66bbf40693ab478", goals: "f12403c39c8495d2cf9aa02f47e92cbcb890398dda2c06f84a68b96d222437f0" };
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(recorded.aas);
    expect(new Bun.CryptoHasher("sha256").update(`${output.join("\n")}\n`).digest("hex")).toBe(recorded.goals);
    store.shutdown();
  }
}, 60_000);
