import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import { parseAas } from "../src/botlib/aas.ts";
import { AasMovement, AasStopEvent, DEFAULT_AAS_MOVEMENT_SETTINGS, aasAccelerate, aasApplyFriction, aasAirControl,
  aasSetMoveDirection, initAasMovementSettings } from "../src/botlib/aas-movement.ts";
import type { AasMovementPrediction, AasPredictionRequest, AasMovementQueries } from "../src/botlib/aas-movement.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import type { AasSpatialHost, AasTrace } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import type { Vec3 } from "../src/core/math.ts";
import { add3, dot3, scale3, sub3, vec3 } from "../src/core/math.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const zero = vec3(0, 0, 0), f = Math.fround;
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing movement fixture value"); return value; }
function bits(value: number): number { const data = new DataView(new ArrayBuffer(4)); data.setFloat32(0, value, true); return data.getUint32(0, true); }
function vectorBits(value: Vec3): number[] { return [bits(value.x), bits(value.y), bits(value.z)]; }
function packed(result: AasMovementPrediction): number[] {
  const m = result.move, t = m.trace;
  return [Number(result.success), ...vectorBits(m.end), m.endArea, ...vectorBits(m.velocity), m.presence,
    m.stopEvent, m.endContents, bits(m.time), m.frames, Number(t.startSolid), bits(t.fraction), ...vectorBits(t.end), t.entityNum, t.lastArea, t.area, t.plane];
}
function fixture(contents = 0, areaContents = 0) {
  const messages: string[] = [], traceCalls: { start: Vec3; end: Vec3; pass: number; mask: number }[] = [];
  const world: AasWorld = {
    source: "native-floor-fixture", version: 5, bspChecksum: 0, vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    planes: [{ normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: -0, type: 2 }],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, 0] }],
    areas: [0, 1].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds: { min: vec3(-10000, -10000, 0), max: vec3(10000, 10000, 10000) }, center: vec3(0, 0, 32) })),
    areaSettings: [0, 1].map(i => ({ contents: i === 0 ? 0 : areaContents, flags: i === 0 ? 0 : 1, presenceType: i === 0 ? 0 : 6, cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 })),
    reachability: [], portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea: point => point.z > 0 ? 1 : 0, areaReachabilities: () => [], areaBounds: () => ({ min: zero, max: zero }),
  };
  const bsp: BspMap = { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [], models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const host: AasSpatialHost = {
    print: text => { messages.push(text); }, pointContents: () => contents,
    trace(start, end, bounds, pass, mask) {
      traceCalls.push({ start, end, pass, mask });
      const floor = bounds === null ? 0 : -bounds.min.z, solid = start.z < floor;
      const fraction = solid ? 0 : end.z < floor ? f(f(start.z - floor) / f(start.z - end.z)) : 1;
      return { fraction, end: solid ? start : add3(start, scale3(sub3(end, start), fraction)), solidity: solid ? "start-solid" : "clear", contact: { kind: "none" }, entityNum: 0, contents: 0, surfaceFlags: 0 };
    },
    entityTrace: () => { throw new Error("No linked entities in floor fixture"); }, entityModelIndex: () => { throw new Error("No model lookup in floor fixture"); },
    modelBounds: () => { throw new Error("No model bounds in floor fixture"); },
  };
  const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); }), modelTypes = new BotBrushModelTypes(), links = linkHeap();
  bspEntities.load(bsp.entities);
  const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, modelTypes, links, { kind: "disabled" }, () => 0);
  return { world, bsp, bspEntities, modelTypes, links, host, spatial, movement: spatial.movement, messages, traceCalls };
}
function request(values: Partial<AasPredictionRequest> = {}): AasPredictionRequest {
  return { entityNum: -1, origin: vec3(0, 0, 24), presence: 2, onGround: false, velocity: zero, commandMove: zero,
    commandFrames: 0, maxFrames: 30, frameTime: f(0.1), visualize: false, stopEvents: 0, stopArea: 0, ...values };
}
function shapedFixture(kind: "slope" | "step") {
  const base = fixture();
  const planes: AasWorld["planes"] = kind === "slope"
    ? [{ normal: vec3(.6, 0, .8), distance: 0, type: 3 }, { normal: vec3(-.6, 0, -.8), distance: 0, type: 3 }]
    : [...base.world.planes, { normal: vec3(1, 0, 0), distance: 10, type: 0 }, { normal: vec3(-1, 0, 0), distance: -10, type: 0 },
      { normal: vec3(0, 0, 1), distance: 8, type: 2 }, { normal: vec3(0, 0, -1), distance: -8, type: 2 }];
  const nodes: AasWorld["nodes"] = kind === "slope" ? base.world.nodes : [{ plane: 0, children: [0, 0] }, { plane: 2, children: [2, 3] }, { plane: 4, children: [-2, 0] }, { plane: 0, children: [-1, 0] }];
  const world: AasWorld = { ...base.world, planes, nodes,
    areas: [...base.world.areas, { ...required(base.world.areas[1]), areaNumber: 2 }], areaSettings: [...base.world.areaSettings, required(base.world.areaSettings[1])],
    pointArea(point) { let node = 1; while (node > 0) { const entry = required(nodes[node]), plane = required(planes[entry.plane]); node = entry.children[f(dot3(point, plane.normal) - plane.distance) > 0 ? 0 : 1]; } return -node; },
  };
  return new AasSpatial(world, base.bspEntities, base.host, DEFAULT_AAS_MOVEMENT_SETTINGS, base.modelTypes, base.links, { kind: "disabled" }, () => 0);
}
interface Case { readonly name: string; readonly contents: number; readonly areaContents: number; readonly request: AasPredictionRequest }
const cases: readonly Case[] = [
  { name: "freefall", contents: 0, areaContents: 0, request: request() },
  { name: "walk", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, 1), onGround: true, commandMove: vec3(400, 0, 0), commandFrames: 10, maxFrames: 10 }) },
  { name: "air", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, 300), velocity: vec3(43.3, -12.75, 80.1), commandMove: vec3(200, 350, 0), commandFrames: 7, maxFrames: 9, frameTime: f(0.037) }) },
  { name: "jump", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, 1), onGround: true, commandMove: vec3(400, 0, 224), commandFrames: 1, stopEvents: 1 }) },
  { name: "crouch", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, 1), onGround: true, commandMove: vec3(400, 0, -400), commandFrames: 8, maxFrames: 8 }) },
  { name: "uncrouch", contents: 0, areaContents: 0, request: request({ presence: 4, maxFrames: 1 }) },
  { name: "watermove", contents: 32, areaContents: 0, request: request({ commandMove: vec3(250, 50, 90), velocity: vec3(150, 12, 9), commandFrames: 8, maxFrames: 8 }) },
  { name: "damage", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, 100), velocity: vec3(90, 40, -1100), stopEvents: 32 }) },
  { name: "groundarea", contents: 0, areaContents: 0, request: request({ stopEvents: 1024, stopArea: 1 }) },
  { name: "leaveground", contents: 0, areaContents: 0, request: request({ stopEvents: 2 }) },
  { name: "gap", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, 200), stopEvents: 64 }) },
  { name: "watergap", contents: 32, areaContents: 0, request: request({ origin: vec3(0, 0, 200), stopEvents: 64, maxFrames: 2 }) },
  { name: "enterarea", contents: 0, areaContents: 200, request: request({ stopEvents: 512 | 128 | 256 | 4096, stopArea: 1 }) },
  { name: "jumppad", contents: 0, areaContents: 128, request: request({ stopEvents: 128 }) },
  { name: "teleport", contents: 0, areaContents: 72, request: request({ stopEvents: 256 | 4096 }) },
  { name: "cluster", contents: 0, areaContents: 8, request: request({ stopEvents: 4096 }) },
  { name: "liquidarea", contents: 0, areaContents: 7, request: request({ stopEvents: 4 | 8 | 16 }) },
  { name: "liquidbsp", contents: 56, areaContents: 0, request: request({ stopEvents: 4 | 8 | 16 }) },
  { name: "zeroFrames", contents: 0, areaContents: 0, request: request({ maxFrames: 0, frameTime: 0, velocity: vec3(1, 2, 3) }) },
  { name: "negativeFrames", contents: 0, areaContents: 0, request: request({ maxFrames: -1, frameTime: -5 }) },
  { name: "startsolid", contents: 0, areaContents: 0, request: request({ origin: vec3(0, 0, -20) }) },
];
function input(mode: number, data: Case): string {
  const r = data.request;
  return [mode, data.contents, data.areaContents, r.presence, Number(r.onGround), r.commandFrames, r.maxFrames, r.stopEvents, r.stopArea, r.frameTime,
    r.origin.x, r.origin.y, r.origin.z, r.velocity.x, r.velocity.y, r.velocity.z, r.commandMove.x, r.commandMove.y, r.commandMove.z].join(" ");
}
const oracle = process.env["Q3_AAS_MOVEMENT_ORACLE"];
async function reference(lines: readonly string[], args: readonly string[] = []): Promise<readonly number[][]> {
  if (oracle === undefined) throw new Error("Q3_AAS_MOVEMENT_ORACLE required");
  const process = Bun.spawn([oracle, ...args], { stdin: new Blob([lines.join("\n") + "\n"]), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text(), errors = await new Response(process.stderr).text();
  expect(await process.exited).toBe(0); expect(errors).toBe("");
  return output.trim().split("\n").map(line => {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === "number")) throw new Error("Invalid native movement result");
    const values: readonly unknown[] = parsed, result: number[] = [];
    for (const item of values) { if (typeof item !== "number") throw new Error("Invalid native scalar"); result.push(item); }
    return result;
  });
}

describe("AAS movement source contracts", () => {
  test("reads all 36 settings in order and refreshes the same settings owner", () => {
    const reads: string[] = [], initial = initAasMovementSettings((name, value) => { reads.push(`${name}=${value}`); return Number(value); });
    expect(reads).toHaveLength(36); expect(reads.slice(0, 5)).toEqual(["phys_friction=6", "phys_stopspeed=100", "phys_gravity=800", "phys_waterfriction=1", "phys_watergravity=400"]);
    expect(reads.slice(-3)).toEqual(["rs_falldamage10=500", "rs_maxfallheight=0", "rs_maxjumpfallheight=450"]);
    const { movement } = fixture(), saved = movement.settings;
    movement.initSettings((name, value) => name === "phys_gravity" ? 700.1 : Number(value));
    expect(movement.settings).toBe(saved); expect(saved.gravity).toBe(f(700.1)); expect(initial.gravity).toBe(800);
  });
  test("settings initialization publishes each completed read before a later LibVar failure", () => {
    const { movement } = fixture(), saved = movement.settings, observations: number[][] = [];
    saved.gravityDirection = vec3(1, 2, 3);
    expect(() => movement.initSettings((name, initial) => {
      observations.push([saved.gravityDirection.x, saved.gravityDirection.y, saved.gravityDirection.z, saved.friction, saved.stopSpeed, saved.gravity]);
      if (name === "phys_gravity") throw new Error("settings read interrupted");
      return Number(initial) + 0.1;
    })).toThrow("settings read interrupted");
    expect(observations).toEqual([
      [0, 0, -1, 6, 100, 800],
      [0, 0, -1, f(6.1), 100, 800],
      [0, 0, -1, f(6.1), f(100.1), 800],
    ]);
    expect(movement.settings).toBe(saved);
    expect([saved.friction, saved.stopSpeed, saved.gravity, saved.waterFriction]).toEqual([f(6.1), f(100.1), 800, 1]);
    expect(DEFAULT_AAS_MOVEMENT_SETTINGS.friction).toBe(6);
  });
  test("zero-frame output is initialized and owned; unsupported source-uninitialized bbox is explicit", () => {
    const { movement } = fixture(), a = movement.predictClientMovement(request({ maxFrames: 0 })), b = movement.predictClientMovement(request({ maxFrames: 0 }));
    expect(a.move.end).toEqual(vec3(0, 0, 24.25)); expect(a.move.trace.fraction).toBe(0); expect(a.move.trace).not.toBe(b.move.trace); expect(a.move.trace.end).not.toBe(b.move.trace.end);
    expect(() => movement.predictClientMovement(request({ stopEvents: 2048 }))).toThrow("initialized bounding box");
    expect(() => movement.predictClientMovement(request({ visualize: true }))).toThrow("debug imports");
    expect(() => movement.predictClientMovement(request({ frameTime: NaN }))).toThrow();
  });
  test("source float argument storage precedes the nonpositive frame-time fallback", () => {
    const movement = fixture().movement;
    expect(packed(movement.predictClientMovement(request({ frameTime: 1e-100 })))).toEqual(packed(movement.predictClientMovement(request({ frameTime: 0 }))));
  });
  test("nonpositive frame times default before rejecting nonfinite frame times", () => {
    const movement = fixture().movement;
    const expected = packed(movement.predictClientMovement(request({ frameTime: 0.1 })));
    for (const frameTime of [-Infinity, -5, 0]) {
      expect(packed(movement.predictClientMovement(request({ frameTime })))).toEqual(expected);
    }
    for (const frameTime of [Infinity, Number.MAX_VALUE, NaN]) {
      expect(() => movement.predictClientMovement(request({ frameTime }))).toThrow("Invalid AAS frame time");
    }
  });
  test("ClipToBBox miss overwrites only fraction/end; successful hit clears retained trace fields", () => {
    const { movement } = fixture(), retained: AasTrace = { startSolid: true, fraction: .25, end: zero, entityNum: 19, lastArea: 4, area: 8, plane: 1 };
    const start = vec3(0, 0, 50), end = vec3(50, 0, 50);
    const miss = movement.clipToBBox(retained, start, end, 2, { min: vec3(100, -5, 30), max: vec3(120, 5, 70) });
    expect(miss).toEqual({ hit: false, trace: { ...retained, fraction: 1, end } });
    const hit = movement.clipToBBox(retained, start, end, 2, { min: vec3(30, -5, 30), max: vec3(40, 5, 70) });
    expect(hit.hit).toBe(true); expect(vectorBits(hit.trace.end)).toEqual([1097859073, 0, 1112014848]); expect(hit.trace.entityNum).toBe(0); expect(hit.trace.startSolid).toBe(false);
  });
  test("source integer ladder distance and plane winding use actual face geometry", () => {
    const base = fixture();
    const world: AasWorld = { ...base.world, planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }, { normal: vec3(-1, 0, 0), distance: 0, type: 0 }],
      vertices: [vec3(0, -10, -10), vec3(0, 10, -10), vec3(0, 10, 10), vec3(0, -10, 10)],
      edges: [{ vertices: [1, 0] }, { vertices: [2, 1] }, { vertices: [3, 2] }, { vertices: [0, 3] }], edgeIndexes: [0, 1, 2, 3],
      faces: [{ plane: 0, flags: 2, edgeCount: 4, firstEdge: 0, frontArea: 1, backArea: 0 }], faceIndexes: [0],
      areas: base.world.areas.map(area => ({ ...area, faceCount: 1 })), areaSettings: base.world.areaSettings.map(area => ({ ...area, flags: 2 })), pointArea: () => 1 };
    const spatial = new AasSpatial(world, base.bspEntities, base.host, DEFAULT_AAS_MOVEMENT_SETTINGS, base.modelTypes, base.links, { kind: "disabled" }, () => 0);
    expect(spatial.movement.againstLadder(vec3(2.99, 0, 0))).toBe(true); expect(spatial.movement.againstLadder(vec3(3, 0, 0))).toBe(false);
    expect(spatial.movement.againstLadder(vec3(0, 11, 0))).toBe(false);
  });
  test("original AirControl has no observable vector mutation", () => {
    const direction = vec3(1, 2, 3); aasAirControl(zero, direction, direction, direction); expect(direction).toEqual(vec3(1, 2, 3));
    expect(aasSetMoveDirection(vec3(0, -1, 0))).toEqual(vec3(0, 0, 1)); expect(aasSetMoveDirection(vec3(0, -2, 0))).toEqual(vec3(0, 0, -1));
  });
  test("area stop priority, jump-pad first-frame exclusion, liquid trace retention and damage velocity units", () => {
    const run = (name: string) => { const c = required(cases.find(c => c.name === name)); return fixture(c.contents, c.areaContents).movement.predictClientMovement(c.request).move; };
    expect(run("enterarea").stopEvent).toBe(AasStopEvent.ENTER_AREA);
    expect(run("jumppad").frames).toBe(1); expect(run("teleport").stopEvent).toBe(AasStopEvent.TOUCH_TELEPORTER);
    expect(run("liquidarea").stopEvent).toBe(28); expect(run("liquidarea").trace.fraction).toBe(0); expect(run("liquidbsp").endContents).toBe(56);
    expect(run("damage").velocity).toEqual(vec3(9, 4, 0));
    expect(run("startsolid").presence).toBe(0);
  });
  test("captured native full-prediction fingerprint is independent of optional oracle availability", () => {
    // Untouched be_aas_move.c + be_aas_sample.c + q_math.c, GCC15 x86_64, -O0 -ffp-contract=off -fexcess-precision=standard.
    const result = cases.map(c => packed(fixture(c.contents, c.areaContents).movement.predictClientMovement(c.request)));
    expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe("1c7be4f234e9a42efb4824910815938f0906ea676be79be63d52b8b9191682a7");
  });
  test("sloped collision preserves native VectorMA dot-product reevaluation after each component write", async () => {
    const spatial = shapedFixture("slope"), r = request({ origin: vec3(10, 0, 50), velocity: vec3(-20, 30, -900), maxFrames: 1 });
    const expected = [1,1116475266,1083797511,3260135664,1,1142295416,1106247680,3286328292,2,0,0,1036831949,1,0,0,0,0,0,0,0,0,0];
    expect(packed(spatial.movement.predictClientMovement(r))).toEqual(expected);
    if (oracle !== undefined) expect(await reference([input(8, { name: "slope", contents: 0, areaContents: 0, request: r })])).toEqual([expected]);
  });
  test("step ascent and recent jump exclusion match actual AAS source traces", async () => {
    const spatial = shapedFixture("step"), r = request({ origin: vec3(0, 0, 1), onGround: true, commandMove: vec3(400, 0, 0), commandFrames: 1, maxFrames: 1 });
    const expected = [1,1108378578,0,1090781184,2,1134559232,0,0,2,0,0,1036831949,1,0,0,0,0,0,0,0,0,0];
    expect(packed(spatial.movement.predictClientMovement(r))).toEqual(expected);
    const jump = { ...r, commandMove: vec3(400, 0, 224) }, jumpExpected = [1,1078774989,0,1103757312,1,1107296256,0,1131413504,2,0,0,1036831949,1,0,0,0,0,0,0,0,0,0];
    expect(packed(spatial.movement.predictClientMovement(jump))).toEqual(jumpExpected);
    if (oracle !== undefined) expect(await reference([r, jump].map(request => input(9, { name: "step", contents: 0, areaContents: 0, request })))).toEqual([expected, jumpExpected]);
    const lines: string[] = [];
    const movement = new AasMovement(spatial, DEFAULT_AAS_MOVEMENT_SETTINGS, { kind: "enabled", line: (_start, _end, color) => { lines.push(color); }, print: message => { lines.push(message); }, clearLines: () => { lines.push("clear"); } });
    movement.predictClientMovement({ ...r, visualize: true }); expect(lines).toContain("blue"); expect(lines[0]).toBe("red");
    lines.length = 0; const tested = movement.testMovementPrediction(-1, vec3(0, 0, 1), vec3(5, 0, 10));
    expect(tested.direction).toEqual(vec3(1, 0, 0)); expect(lines[0]).toBe("clear");
  });
  test("21 collision attempts return source-zero output, without retained prior prediction fields", () => {
    const base = fixture(), queries: AasMovementQueries = { ...base.spatial, world: base.world, host: base.host,
      pointArea: origin => base.spatial.pointArea(origin), pointPresenceType: origin => base.spatial.pointPresenceType(origin),
      presenceBounds: presence => base.spatial.presenceBounds(presence), traceAreas: () => [], pointInsideFace: () => false,
      traceClientBBox: start => ({ startSolid: true, fraction: 0, end: start, plane: 0, entityNum: 0, area: 0, lastArea: 0 }) };
    const result = new AasMovement(queries, DEFAULT_AAS_MOVEMENT_SETTINGS, { kind: "disabled" }).predictClientMovement(request());
    expect(packed(result)).toEqual(Array.from({ length: 22 }, () => 0));
  });
  test.skipIf(oracle === undefined)("all stop events, crouch, water, air and command frames match untouched native source bit for bit", async () => {
    const results = await reference(cases.map(c => input(0, c)));
    for (const [index, c] of cases.entries()) expect(packed(fixture(c.contents, c.areaContents).movement.predictClientMovement(c.request)), c.name).toEqual(required(results[index]));
    expect(createHash("sha256").update(JSON.stringify(results)).digest("hex")).toBe("1c7be4f234e9a42efb4824910815938f0906ea676be79be63d52b8b9191682a7");
  });
  test.skipIf(oracle === undefined)("native helper arithmetic corpus preserves native double literal intermediates", async () => {
    const entries: { mode: number; data: Case; actual: readonly number[] }[] = [];
    const movement = fixture().movement;
    for (let i = 0; i < 96; i++) {
      const velocity = vec3(i * 2.31 - 81.4, i * -.91 + .11, i * .07), direction = vec3(f(Math.sin(i) * .7), f(Math.cos(i) * .7), f(.1));
      const dt = f(.008 + i * .001), origin = vec3(43.1 + i, 1.1 + i * .02, 27 + i * 2);
      const data: Case = { name: `helper${i}`, contents: 0, areaContents: 0, request: request({ origin, velocity, commandMove: direction, frameTime: dt }) };
      entries.push({ mode: 1, data, actual: vectorBits(aasAccelerate(velocity, dt, direction, origin.x, origin.y)) });
      entries.push({ mode: 2, data, actual: vectorBits(aasApplyFriction(velocity, origin.x, origin.y, dt)) });
      const horizontal = movement.horizontalVelocityForJump(direction.x, origin, velocity);
      entries.push({ mode: 3, data, actual: [Number(horizontal.success), bits(horizontal.velocity)] });
      entries.push({ mode: 4, data, actual: [bits(movement.rocketJumpZVelocity(origin)), bits(movement.bfgJumpZVelocity(origin))] });
      entries.push({ mode: 5, data, actual: vectorBits(aasSetMoveDirection(origin)) });
      entries.push({ mode: 6, data, actual: vectorBits(movement.jumpReachRunStart({ start: origin, end: velocity })) });
    }
    const expected = await reference(entries.map(entry => input(entry.mode, entry.data)));
    for (const [index, entry] of entries.entries()) expect(entry.actual, `${entry.data.name} mode${entry.mode}`).toEqual(required(expected[index]));
  });
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("both-product retail AAS prediction uses real BSP liquids and linked spatial traversal", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const maps: readonly { product: "baseq3" | "missionpack"; map: string }[] = [{ product: "baseq3", map: "q3dm1" }, { product: "missionpack", map: "mpteam1" }];
  for (const entry of maps) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: entry.product }), bsp = parseBsp(await vfs.read(`maps/${entry.map}.bsp`)), world = parseAas(await vfs.read(`maps/${entry.map}.aas`));
    const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" }), messages: string[] = [];
    const host: AasSpatialHost = { print: text => { messages.push(text); },
      trace: (start, end, bounds, _pass, mask) => ({ ...collision.trace({ start, end, shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }), entityNum: 1022 }),
      pointContents: point => collision.pointContents(point), entityTrace: () => { throw new Error("No dynamic entities linked"); },
      entityModelIndex: () => { throw new Error("No dynamic models linked"); }, modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }) };
    const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
    bspEntities.load(bsp.entities);
    const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
    let predictions = 0;
    const inputs: string[] = [], outputs: number[][] = [];
    for (const area of world.areas.slice(1, 129)) for (const commandMove of [vec3(300, 50, 224), vec3(-310, 110, 0), vec3(150, -270, -400), zero]) {
      const r = request({ origin: area.center, onGround: true, commandMove, commandFrames: 5, maxFrames: 15, stopEvents: 1 | 4 | 8 | 16 | 32 });
      const result = spatial.movement.predictClientMovement(r);
      inputs.push(input(0, { name: entry.map, contents: 0, areaContents: 0, request: r })); outputs.push(packed(result));
      if (result.success) { expect(result.move.frames).toBeLessThanOrEqual(15); expect(Number.isFinite(result.move.end.z)).toBe(true); predictions++; }
    }
    expect(predictions).toBeGreaterThan(40); expect(messages).toEqual([]);
    if (oracle !== undefined) {
      const directory = await mkdtemp(join(tmpdir(), "q3-aas-movement-retail-"));
      try {
        const aasPath = join(directory, "map.aas"), bspPath = join(directory, "map.bsp");
        await writeFile(aasPath, await vfs.read(`maps/${entry.map}.aas`)); await writeFile(bspPath, await vfs.read(`maps/${entry.map}.bsp`));
        const expected = await reference(inputs, [aasPath, bspPath]);
        for (const [index, result] of outputs.entries()) {
          if (JSON.stringify(result) !== JSON.stringify(required(expected[index]))) {
            const area = required(world.areas[Math.floor(index / 4) + 1]), commandMove = required([vec3(300, 50, 224), vec3(-310, 110, 0), vec3(150, -270, -400), zero][index % 4]);
            const prefixes = Array.from({ length: 15 }, (_, frame) => request({ origin: area.center, onGround: true, commandMove, commandFrames: 5, maxFrames: frame + 1, stopEvents: 1 | 4 | 8 | 16 | 32 }));
            const prefixExpected = await reference(prefixes.map(r => input(0, { name: "prefix", contents: 0, areaContents: 0, request: r })), [aasPath, bspPath]);
            for (const [frame, r] of prefixes.entries()) expect(packed(spatial.movement.predictClientMovement(r)), `${entry.map} case${index} prefix${frame + 1} origin${JSON.stringify(area.center)}`).toEqual(required(prefixExpected[frame]));
          }
          expect(result, `${entry.map} case${index}`).toEqual(required(expected[index]));
        }
      } finally { await rm(directory, { recursive: true }); }
    }
  }
});
