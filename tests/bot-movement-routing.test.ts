import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasWorld, AasReachability } from "../src/botlib/aas.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import type { BotGoal } from "../src/botlib/goals.ts";
import { BotMoveStateStore } from "../src/botlib/movement-state.ts";
import { addToMovementTarget, avoidMovementSpots, BotMovementRouting, distanceFromLineSquared, movementAngleDifference } from "../src/botlib/movement-routing.ts";
import type { MovementReachabilityQuery } from "../src/botlib/movement-routing.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { vec3 } from "../src/core/math.ts";
import { BinaryWriter } from "../src/core/binary.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const zero = vec3(0, 0, 0), bounds: Bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
function at<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new Error(`Missing fixture index ${index}`); return value; }
interface Link { readonly from: number; readonly to: number; readonly type?: number; readonly time?: number; readonly start?: Vec3; readonly end?: Vec3 }
function graph(count: number, links: readonly Link[], contents: readonly number[] = []): AasWorld {
  const reachability: AasReachability[] = [{ area: 0, face: 0, edge: 0, start: zero, end: zero, travelType: 0, travelTime: 0, padding: 0 }];
  const areaSettings = Array.from({ length: count + 1 }, (_, area) => {
    const outgoing = links.filter(link => link.from === area), first = reachability.length;
    for (const link of outgoing) reachability.push({ area: link.to, face: 1, edge: 0, start: link.start ?? zero,
      end: link.end ?? zero, travelType: link.type ?? TravelType.WALK, travelTime: link.time ?? 10, padding: 0 });
    return { contents: contents[area] ?? 0, flags: area === 0 ? 0 : 1, presenceType: area === 0 ? 0 : 6, cluster: area === 0 ? 0 : 1,
      clusterAreaNumber: area === 0 ? 0 : area - 1, reachableAreaCount: outgoing.length, firstReachableArea: first };
  });
  const areas = areaSettings.map((_, area) => ({ areaNumber: area, faceCount: 0, firstFace: 0, bounds, center: zero }));
  return { source: "bot-movement-graph", version: 5, bspChecksum: 0, vertices: [], planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    areas, areaSettings, reachability, nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [0, 0] }], portals: [], portalIndex: [], bboxes: [],
    clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 }, { areaCount: count, reachabilityAreaCount: count, portalCount: 0, firstPortal: 0 }],
    pointArea: () => { throw new Error("This routing-only graph has no point-sampling tree"); },
    areaReachabilities: area => { const settings = at(areaSettings, area); return reachability.slice(settings.firstReachableArea, settings.firstReachableArea + settings.reachableAreaCount); },
    areaBounds: area => at(areas, area).bounds };
}
function bsp(brush: Bounds | null = null): BspMap {
  const model = { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: brush === null ? 0 : 1 };
  return { entities: "", entityRecords: [], shaders: [{ name: "solid", surfaceFlags: 0, contentFlags: 1 }],
    planes: brush === null ? [] : [
      { normal: vec3(1, 0, 0), distance: brush.max.x }, { normal: vec3(-1, 0, 0), distance: -brush.min.x },
      { normal: vec3(0, 1, 0), distance: brush.max.y }, { normal: vec3(0, -1, 0), distance: -brush.min.y },
      { normal: vec3(0, 0, 1), distance: brush.max.z }, { normal: vec3(0, 0, -1), distance: -brush.min.z }],
    nodes: [], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: model.brushCount }],
    leafSurfaces: [], leafBrushes: brush === null ? [] : [0], models: [model, { ...model, bounds: brush ?? bounds }],
    brushes: brush === null ? [] : [{ firstSide: 0, sideCount: 6, shader: 0 }],
    brushSides: brush === null ? [] : Array.from({ length: 6 }, (_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function goal(area: number, origin = zero): BotGoal { return { area, origin, mins: zero, maxs: zero, entity: 7, number: 0, flags: 0, itemInfo: 0 }; }
function fixture(world: AasWorld, map = bsp(), modelEntity = 1022) {
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }), messages: string[] = [], traceCalls: { start: Vec3; end: Vec3; pass: number; mask: number; bounds: Bounds | null }[] = [];
  let now = 10, moverOrigin: Vec3 | null = zero;
  const host: AasSpatialHost = {
    print: text => { messages.push(text); },
    trace: (start, end, box, pass, mask) => {
      traceCalls.push({ start, end, pass, mask, bounds: box });
      const result = collision.trace({ start, end, shape: box === null ? { kind: "point" } : { kind: "box", mins: box.min, maxs: box.max }, mask });
      return { ...result, entityNum: result.fraction < 1 || result.solidity !== "clear" ? modelEntity : 1023 };
    },
    pointContents: point => collision.pointContents(point),
    entityTrace: (entity, start, end, box, mask) => ({ ...collision.trace({ start, end, shape: { kind: "box", mins: box.min, maxs: box.max }, mask, modelIndex: entity === modelEntity ? 1 : 0 }), entityNum: entity }),
    entityModelIndex: entity => entity === modelEntity ? 1 : 0,
    modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }),
  };
  const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
  bspEntities.load(map.entities);
  const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  spatial.setBrushModelTypes(host.print);
  const states = new BotMoveStateStore({ time: () => now, print: (severity, text) => { messages.push(`${severity}:${text}`); },
    libVar: () => { throw new Error("Routing does not request LibVars"); }, setBrushModelTypes: () => spatial.setBrushModelTypes(host.print) });
  const handle = states.allocate(), state = states.fromHandle(handle); if (state === null) throw new Error("Missing allocated move state");
  const aasRouting = new AasRouting(world);
  aasRouting.initializeRouting(spatial, () => 16 * 1024 * 1024, () => now);
  const routing = new BotMovementRouting(states, spatial, aasRouting, { originOfMoverWithModelNum: () => moverOrigin, entityModelNum: host.entityModelIndex });
  const query = (destination = goal(world.areas.length - 1), overrides: Partial<MovementReachabilityQuery> = {}): MovementReachabilityQuery => {
    return { origin: zero, area: 1, lastArea: 0, lastGoalArea: 0, avoid: state, goal: destination, travelFlags: TravelFlags.DEFAULT,
      moveTravelFlags: TravelFlags.DEFAULT, avoidSpots: state.avoidSpots, numAvoidSpots: state.numAvoidSpots, flags: 0, ...overrides };
  };
  return { routing, spatial, states, state, handle, query, collision, messages, traceCalls, time: (value: number) => { now = value; }, mover: (value: Vec3 | null) => { moverOrigin = value; } };
}

describe("source movement route selection", () => {
  test("native iterator visits the first record even for zero count, then stops", () => {
    const env = fixture(graph(2, [{ from: 2, to: 1 }]));
    expect(env.routing.spatial.world.areaSettings[1]?.reachableAreaCount).toBe(0);
    expect(env.routing.nextAreaReachability(1, 0)).toBe(1);
    expect(env.routing.nextAreaReachability(1, 1)).toBe(0);
    expect(env.routing.getReachabilityToGoal(env.query(goal(1)))).toEqual({ reachability: 1, flags: 0 });
    expect(env.routing.nextAreaReachability(0, 0)).toBe(0);
    expect(env.messages).toEqual(["3:AAS_NextAreaReachability: areanum 0 out of range\n"]);
  });
  test("zero-count first at table end clears lookup and preserves source iterator diagnostics", () => {
    const env = fixture(graph(2, [{ from: 1, to: 2 }, { from: 1, to: 2 }]));
    const end = env.routing.spatial.world.reachability.length;
    expect(env.routing.nextAreaReachability(2, 0)).toBe(end);
    expect(env.routing.nextAreaReachability(2, end)).toBe(0);
    expect(env.routing.reachabilityFromNum(end)).toEqual({ area: 0, face: 0, edge: 0, start: zero, end: zero, travelType: 0, travelTime: 0, padding: 0 });
    expect(env.routing.reachabilityFromNum(-1)).toEqual(env.routing.reachabilityFromNum(end));
    expect(env.routing.reachabilityFromNum(0)).toEqual(at(env.routing.spatial.world.reachability, 0));
    expect(env.routing.reachabilityFromNum(0)).not.toBe(at(env.routing.spatial.world.reachability, 0));
    expect(env.routing.getReachabilityToGoal(env.query(goal(1), { area: 2 }))).toEqual({ reachability: 0, flags: 0 });
    expect(env.routing.nextAreaReachability(2, 1)).toBe(0);
    expect(env.messages).toEqual(["4:AAS_NextAreaReachability: reachnum < settings->firstreachableara"]);
  });
  test("reachability lookup copies scalar and vector cells from the retained AAS allocation", () => {
    const source = graph(2, [{ from: 1, to: 2, start: vec3(1, 2, 3), end: vec3(4, 5, 6) }]);
    const world = new AasWorldState(source);
    world.allocateReachability(source.reachability.length);
    for (const [index, reach] of source.reachability.entries()) Object.assign(world.reachabilityRecord(index), reach);
    const env = fixture(world), original = at(source.reachability, 1), retained = env.routing.reachabilityFromNum(1);
    expect(retained).toEqual(original);
    const record = world.reachabilityRecord(1);
    record.area = 1; record.start.x = 90; record.end.z = 80; record.travelTime = 70;
    expect(retained).toEqual(original);
    expect(env.routing.reachabilityFromNum(1)).toEqual({ ...original, area: 1, start: vec3(90, 2, 3), end: vec3(4, 5, 80), travelTime: 70 });
  });
  test("ranks real routes, ignores start distance, preserves first ties and incoming flags", () => {
    const f = fixture(graph(3, [{ from: 1, to: 3, start: vec3(10000, 0, 0) }, { from: 1, to: 3 }]));
    expect(f.routing.getReachabilityToGoal(f.query())).toEqual({ reachability: 1, flags: 0 });
    expect(f.routing.getReachabilityToGoal(f.query(goal(3), { flags: 4 }))).toEqual({ reachability: 1, flags: 4 });
    expect(f.routing.getReachabilityToGoal(f.query(goal(3), { area: 0, flags: 8 }))).toEqual({ reachability: 0, flags: 8 });
    expect(f.routing.getReachabilityToGoal(f.query(goal(3), { lastGoalArea: 3, lastArea: 3 })).reachability).toBe(0);
    expect(f.routing.getReachabilityToGoal(f.query(goal(3), { lastGoalArea: 2, lastArea: 3 })).reachability).toBe(1);
  });
  test("avoid retries exclude only above four, include the expiry instant and clear after it", () => {
    const f = fixture(graph(2, [{ from: 1, to: 2 }, { from: 1, to: 2, time: 20 }]));
    f.state.avoidReach[0] = 1; f.state.avoidReachTimes[0] = 10; f.state.avoidReachTries[0] = 4;
    expect(f.routing.getReachabilityToGoal(f.query()).reachability).toBe(1);
    f.state.avoidReachTries[0] = 5; expect(f.routing.getReachabilityToGoal(f.query()).reachability).toBe(2);
    f.time(10.01); expect(f.routing.getReachabilityToGoal(f.query()).reachability).toBe(1);
  });
  test("travel and destination flags are separate and DONOTENTER is enabled only at either endpoint", () => {
    const f = fixture(graph(3, [{ from: 1, to: 2 }, { from: 2, to: 3 }], [0, 0, 256, 0]));
    expect(f.routing.getReachabilityToGoal(f.query()).reachability).toBe(0);
    expect(f.routing.getReachabilityToGoal(f.query(goal(2))).reachability).toBe(1);
    expect(f.routing.validTravel(zero, at(f.spatial.world.reachability, 1), TravelFlags.DEFAULT)).toBe(false);
    const rocket = fixture(graph(2, [{ from: 1, to: 2, type: TravelType.ROCKETJUMP }]));
    expect(rocket.routing.getReachabilityToGoal(rocket.query()).reachability).toBe(0);
    expect(rocket.routing.getReachabilityToGoal(rocket.query(goal(2), { moveTravelFlags: TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP })).reachability).toBe(1);
  });
  test("a DONTBLOCK spot still rejects its route and accumulates the result flag before an alternative wins", () => {
    const f = fixture(graph(2, [{ from: 1, to: 2, start: vec3(10, 0, 0) }, { from: 1, to: 2, start: vec3(0, 10, 0) }]));
    f.states.addAvoidSpot(f.handle, vec3(5, 0, 0), 1, 2);
    expect(f.routing.getReachabilityToGoal(f.query(goal(2), { flags: 8 }))).toEqual({ reachability: 2, flags: 264 });
  });
});

describe("native movement geometry and look-ahead", () => {
  test("angle subtraction is one adjustment, not full angle normalization; segment endpoints clamp", () => {
    expect(movementAngleDifference(720, 0)).toBe(360); expect(movementAngleDifference(0, 720)).toBe(-360);
    expect(movementAngleDifference(180, 0)).toBe(180); expect(movementAngleDifference(0, 180)).toBe(-180);
    expect(distanceFromLineSquared(vec3(15, 4, 0), zero, vec3(10, 0, 0))).toBe(41);
    expect(distanceFromLineSquared(vec3(5, 4, 0), zero, vec3(10, 0, 0))).toBe(16);
    expect(distanceFromLineSquared(vec3(5, 4, 0), zero, zero)).toBe(41);
    const target = { value: vec3(99, 99, 99), distance: 0 };
    expect(addToMovementTarget(zero, vec3(3, 4, 0), 10, target)).toBe(false); expect(target).toEqual({ value: vec3(3, 4, 0), distance: 5 });
    expect(addToMovementTarget(vec3(3, 4, 0), vec3(9, 12, 0), 10, target)).toBe(true); expect(target).toEqual({ value: vec3(6, 8, 0), distance: 10 });
  });
  test("retains the discarded discontinuous end-distance result and strict radius equality", () => {
    const reach = at(graph(2, [{ from: 1, to: 2, start: vec3(10, 0, 0), end: vec3(20, 0, 0) }]).reachability, 1);
    const behind = [{ origin: vec3(0, 1, 0), radius: 2, type: 1 }], endpoint = [{ origin: reach.end, radius: 2, type: 1 }];
    expect(avoidMovementSpots(zero, reach, behind, 1)).toBe(0);
    expect(avoidMovementSpots(zero, { ...reach, travelType: TravelType.JUMP }, behind, 1)).toBe(1);
    expect(avoidMovementSpots(zero, reach, endpoint, 1)).toBe(1);
    expect(avoidMovementSpots(zero, { ...reach, travelType: TravelType.JUMP }, endpoint, 1)).toBe(0);
    expect(avoidMovementSpots(zero, reach, [{ origin: vec3(5, 2, 0), radius: 2, type: 1 }], 1)).toBe(0);
  });
  test("false can have a written target, but missing state/goal/reach and zero lookahead do not write", () => {
    const f = fixture(graph(3, [{ from: 1, to: 2, start: vec3(10, 0, 0), end: vec3(20, 0, 0) }])), target = { value: vec3(-1, -1, -1) };
    expect(f.routing.movementViewTarget(f.handle, goal(3), TravelFlags.DEFAULT, 100, target)).toBe(false); expect(target.value.x).toBe(-1);
    f.state.lastReachability = 1;
    expect(f.routing.movementViewTarget(f.handle, null, TravelFlags.DEFAULT, 100, target)).toBe(false);
    expect(f.routing.movementViewTarget(f.handle, goal(3), TravelFlags.DEFAULT, 0, target)).toBe(false); expect(target.value.x).toBe(-1);
    expect(f.routing.movementViewTarget(f.handle, goal(3), TravelFlags.DEFAULT, 100, target)).toBe(false); expect(target.value).toEqual(vec3(20, 0, 0));
  });
  test("teleport/weapon jumps stop at start; lift, bob and jump-pad distances are excluded", () => {
    for (const [type, expected] of [[TravelType.TELEPORT, 10], [TravelType.ROCKETJUMP, 10], [TravelType.BFGJUMP, 10],
      [TravelType.WALK, 15], [TravelType.JUMPPAD, 105], [TravelType.ELEVATOR, 105], [TravelType.FUNCBOB, 105]]) {
      if (type === undefined || expected === undefined) throw new Error("Missing view fixture");
      const f = fixture(graph(2, [{ from: 1, to: 2, type, start: vec3(10, 0, 0), end: vec3(100, 0, 0) }])), target = { value: zero };
      f.state.lastReachability = 1;
      expect(f.routing.movementViewTarget(f.handle, goal(2, vec3(110, 0, 0)), TravelFlags.DEFAULT, 15, target)).toBe(true);
      expect(target.value).toEqual(vec3(expected, 0, 0));
    }
  });
});

describe("movement visibility and mover queries against collision", () => {
  const wall: Bounds = { min: vec3(29, -100, -100), max: vec3(31, 100, 100) };
  test("checks start then end from goal origin with the goal entity passed through", () => {
    const f = fixture(graph(2, [{ from: 1, to: 2, start: vec3(10, 0, 0), end: vec3(40, 0, 0) }]), bsp(wall)), target = { value: zero };
    expect(f.routing.predictVisiblePosition(zero, 1, goal(2, vec3(50, 0, 0)), TravelFlags.DEFAULT, target)).toBe(true);
    expect(target.value).toEqual(vec3(40, 0, 0)); expect(f.traceCalls).toHaveLength(2);
    expect(f.traceCalls.map(trace => [trace.start.x, trace.end.x, trace.pass, trace.mask, trace.bounds])).toEqual([[50, 10, 7, 65537, null], [50, 40, 7, 65537, null]]);
    expect(f.routing.visible(7, vec3(50, 0, 0), vec3(10, 0, 0))).toBe(false);
  });
  test("goal-area end wins even when both probes are blocked; same-area input leaves output untouched", () => {
    const f = fixture(graph(2, [{ from: 1, to: 2, start: vec3(10, 0, 0), end: vec3(20, 0, 0) }]), bsp(wall)), target = { value: vec3(-1, 0, 0) };
    expect(f.routing.predictVisiblePosition(zero, 2, goal(2, vec3(50, 0, 0)), TravelFlags.DEFAULT, target)).toBe(false); expect(target.value.x).toBe(-1);
    expect(f.routing.predictVisiblePosition(zero, 1, goal(2, vec3(50, 0, 0)), TravelFlags.DEFAULT, target)).toBe(true); expect(target.value.x).toBe(20);
  });
  test("the twenty-hop limit stops before a twenty-first link and leaves output untouched", () => {
    const links = Array.from({ length: 21 }, (_, index) => ({ from: index + 1, to: index + 2, start: zero, end: zero }));
    const f = fixture(graph(22, links), bsp(wall)), target = { value: vec3(-1, 0, 0) };
    expect(f.routing.predictVisiblePosition(zero, 1, goal(22, vec3(50, 0, 0)), TravelFlags.DEFAULT, target)).toBe(false);
    expect(f.traceCalls).toHaveLength(40); expect(target.value.x).toBe(-1);
  });
  test("mover traces use source dimensions, model low bits, strict height and missing-model print-return", () => {
    const floor: Bounds = { min: vec3(-50, -50, -10), max: vec3(50, 50, 0) };
    const f = fixture(graph(2, [{ from: 1, to: 2, start: vec3(0, 0, 2) }]), bsp(floor), 42);
    const reach = { ...at(f.spatial.world.reachability, 1), face: 0x10001 };
    expect(f.routing.onMover(vec3(0, 0, 24), 7, reach)).toBe(true);
    expect(at(f.traceCalls, 0)).toEqual({ start: vec3(0, 0, 48), end: vec3(0, 0, -24), pass: 7, mask: 65537, bounds: { min: vec3(-16, -16, -8), max: vec3(16, 16, 8) } });
    expect(f.routing.onMover(vec3(68, 0, 24), 7, reach)).toBe(false); expect(f.traceCalls).toHaveLength(1);
    expect(f.routing.moverDown(reach)).toBe(true); f.mover(vec3(0, 0, 1)); expect(f.routing.moverDown(reach)).toBe(false);
    f.state.origin = vec3(0, 0, 25); f.state.presenceType = 2; f.state.entityNum = 7; expect(f.routing.onTopOfEntity(f.state)).toBe(42);
    f.state.origin = vec3(0, 0, 20); expect(f.routing.onTopOfEntity(f.state)).toBe(-1);
    f.mover(null); expect(f.routing.moverDown(reach)).toBe(false); expect(f.routing.onMover(zero, 7, reach)).toBe(false);
    expect(f.messages.slice(-2)).toEqual(["1:no entity with model 1\n", "1:no entity with model 1\n"]);
  });
});

const retailPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
function bits(value: number): number { const data = new DataView(new ArrayBuffer(4)); data.setFloat32(0, value, true); return data.getUint32(0, true); }
function vectorBits(value: Vec3): string { return `${bits(value.x)} ${bits(value.y)} ${bits(value.z)}`; }
function nativeOracle(bytes: Uint8Array, command: string): readonly string[] {
  const executable = Bun.env["Q3_BOT_MOVEMENT_ORACLE"]; if (executable === undefined) throw new Error("Missing external movement oracle");
  const text = new TextEncoder().encode(`${command}\n`), input = new BinaryWriter(4 + bytes.length + text.length);
  input.u32(bytes.length); input.bytes(bytes); input.bytes(text);
  const result = Bun.spawnSync([executable], { stdin: input.finish(), timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(`Movement oracle failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim().split("\n");
}
test("matches all2000 native explicit-binary32 geometry output records", () => {
  let seed = 12345;
  function random(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.fround((seed / 4294967296 - 0.5) * 4000); }
  const commands: string[] = [], output: string[] = [];
  for (let index = 0; index < 1000; index++) {
    const a = vec3(random(), random(), random()), b = vec3(random(), random(), random()), c = vec3(random(), random(), random());
    const maximum = Math.abs(random()), distance = Math.fround(Math.abs(random()) / 3);
    const values = `${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${c.x} ${c.y} ${c.z} ${maximum} ${distance}`;
    commands.push(`1 ${values}`, `2 ${values}`); output.push(String(bits(distanceFromLineSquared(a, b, c))));
    const target = { value: zero, distance }, result = addToMovementTarget(a, b, maximum, target);
    output.push(`${result ? 1 : 0} ${bits(target.distance)} ${vectorBits(target.value)}`);
  }
  const serialized = `${output.join("\n")}\n`;
  // GCC x86_64 -O0 -fno-fast-math -ffp-contract=off -fexcess-precision=standard,
  // original DistanceFromLineSquared/AAS_ProjectPointOntoVector/BotAddToTarget/q_math.c.
  expect(new Bun.CryptoHasher("sha256").update(serialized).digest("hex")).toBe("6cf9eb9bab747197382463864bc6dd7585c7d91318b505e6f7e2a1351aa509ee");
  const executable = Bun.env["Q3_BOT_MOVEMENT_ORACLE"];
  if (executable !== undefined) {
    const result = Bun.spawnSync([executable, "geometry"], { stdin: new TextEncoder().encode(`${commands.join("\n")}\n`), timeout: 60_000 });
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(serialized);
    const avoids = ["3 0 1 0 10 0 0 20 0 0 2 2", "3 0 1 0 10 0 0 20 0 0 5 2", "3 20 0 0 10 0 0 20 0 0 2 2", "3 20 0 0 10 0 0 20 0 0 5 2"];
    const avoided = Bun.spawnSync([executable, "geometry"], { stdin: new TextEncoder().encode(`${avoids.join("\n")}\n`), timeout: 60_000 });
    expect(avoided.exitCode).toBe(0); expect(avoided.stdout.toString()).toBe("0\n1\n1\n0\n");
  }
});
test.skipIf(!existsSync(join(retailPath, "missionpack/pak0.pk3")))("retail base and mission-pack routes feed actual look-ahead and BSP visibility", async () => {
  const files = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "missionpack" });
  // Unchanged x86_64 -O0 explicit-binary32 be_ai_move.c plus be_aas_route.c and q_math.c,
  // both products: bash /tmp/quake3-bot-routing-oracle-kFcJuY/run.sh.
  const captured: readonly (readonly [string, number, number, string, string, string])[] = [
    ["q3dm1", 175, 5, "2070b35b34b9820b84a5e1e1cbdcd50791fb091f15d04aa68692ab561e7b44cc",
      "VIEW 327 0 1 1143658100 1154119804 1103126748", "VISIBLE 1 7 1143472128 1157538611 1103101952"],
    ["mpteam1", 426, 5811, "6b1893bbfd9c31de2eb4c1fa946b7caf43ff83f651dd001e4a811db3f7978e5f",
      "VIEW 609 0 1 3255914686 1161227299 1125650466", "VISIBLE 0 40 3351465856 0 0"],
  ];
  for (const [name, area, destination, hash, expectedView, expectedVisible] of captured) {
    const bytes = await files.read(`maps/${name}.aas`), aas = parseAas(bytes), map = parseBsp(await files.read(`maps/${name}.bsp`));
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(hash);
    const f = fixture(aas, map), start = at(aas.areas, area).center, destinationGoal = goal(destination, at(aas.areas, destination).center);
    f.state.origin = start; f.state.area = area; f.state.lastGoalArea = destination;
    const selected = f.routing.getReachabilityToGoal(f.query(destinationGoal, { area, origin: start, travelFlags: 0x1fffffff, moveTravelFlags: 0x1fffffff }));
    expect(selected.reachability).toBeGreaterThan(0); expect(selected.flags).toBe(0);
    f.state.lastReachability = selected.reachability;
    const target = { value: vec3(-99999, 0, 0) };
    expect(f.routing.movementViewTarget(f.handle, destinationGoal, 0x1fffffff, 100, target)).toBe(true);
    expect(Number.isFinite(target.value.x + target.value.y + target.value.z)).toBe(true);
    const viewLine = `VIEW ${selected.reachability} ${selected.flags} 1 ${vectorBits(target.value)}`;
    target.value = vec3(-99999, 0, 0);
    const visible = f.routing.predictVisiblePosition(start, area, destinationGoal, 0x1fffffff, target);
    const visibleLine = `VISIBLE ${visible ? 1 : 0} ${f.traceCalls.length} ${vectorBits(target.value)}`;
    expect(viewLine).toBe(expectedView); expect(visibleLine).toBe(expectedVisible);
    if (Bun.env["Q3_BOT_MOVEMENT_ORACLE"] !== undefined) {
      expect(nativeOracle(bytes, `3 ${area} ${destination} 536870911 100`)).toEqual([viewLine]);
      const fractions = f.traceCalls.map(trace => f.collision.trace({ start: trace.start, end: trace.end, shape: { kind: "point" }, mask: trace.mask }).fraction);
      const traceLines = f.traceCalls.map(trace => `TRACE ${vectorBits(trace.start)} ${vectorBits(trace.end)} ${trace.pass} ${trace.mask}`);
      expect(nativeOracle(bytes, `4 ${area} ${destination} 536870911 100 ${fractions.length} ${fractions.join(" ")}`)).toEqual([...traceLines, visibleLine]);
    }
    expect(f.traceCalls.length).toBeGreaterThan(0); expect(f.traceCalls.length).toBeLessThanOrEqual(40);
    expect(aas.reachability[selected.reachability]).toBeDefined();
  }
}, 60_000);
