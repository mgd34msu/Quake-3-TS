import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AasNode, AasPlane, AasWorld } from "../src/botlib/aas.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasBspTrace, AasSpatialHost } from "../src/botlib/spatial.ts";
import { AasSpatial, BotBrushModelTypes, presenceTypeBounds } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { AasEntityHistory } from "../src/botlib/entity.ts";
import type { BotEntityUpdate } from "../src/botlib/entity.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { add3, dot3, scale3, vec3 } from "../src/core/math.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { ServerTraceResult } from "../src/server/world.ts";
import { EntityShared } from "../src/shared/entity-shared.ts";
import { EntityState } from "../src/shared/entity-state.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const zero = vec3(0, 0, 0);
const tiny: Bounds = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
const sourcePlanes: readonly AasPlane[] = [{ normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: 0, type: 2 }];

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing AAS spatial test value"); return value; }
function fixtureWorld(planes = sourcePlanes, children: readonly [number, number] = [-1, 0]): AasWorld {
  const nodes: readonly AasNode[] = [{ plane: 0, children: [0, 0] }, { plane: 0, children }];
  const count = Math.max(-children[0], -children[1]) + 1;
  const settings = Array.from({ length: count }, (_, i) => ({ contents: 0, flags: i === 0 ? 0 : 1, presenceType: i === 0 ? 0 : 6,
    cluster: 0, clusterAreaNumber: 0, reachableAreaCount: i === 0 ? 0 : 1, firstReachableArea: 0 }));
  const areas = settings.map((_, i) => ({ areaNumber: i, faceCount: 0, firstFace: 0, bounds: { min: vec3(-100, -100, -100), max: vec3(100, 100, 100) }, center: vec3(0, 0, 20) }));
  return {
    source: "synthetic-spatial", version: 5, bspChecksum: 0, vertices: [], planes, edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    areas, areaSettings: settings, reachability: [], nodes, portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea(point) {
      let node = 1;
      while (node > 0) {
        const entry = required(nodes[node]), plane = required(planes[entry.plane]);
        node = entry.children[Math.fround(dot3(point, plane.normal) - plane.distance) > 0 ? 0 : 1];
      }
      return -node;
    },
    areaReachabilities: () => [],
    areaBounds: area => required(areas[area]).bounds,
  };
}
function fixtureBsp(entityRecords: BspMap["entityRecords"] = []): BspMap {
  const entities = entityRecords.map(record => `{ ${Array.from(record, ([key, value]) => `"${key}" "${value}"`).join(" ")} }`).join("\n");
  return { entities, entityRecords, shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [], models: [],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function clear(end: Vec3, fraction = 1, entityNum = 1023): AasBspTrace {
  return { fraction, end, entityNum, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0 };
}
function host(): AasSpatialHost {
  const messages: string[] = [];
  return {
    print: text => { messages.push(text); },
    trace: (_start, end) => clear(end), pointContents: () => 0,
    entityTrace: (_entity, _start, end) => clear(end), entityModelIndex: () => 0,
    modelBounds: () => ({ bounds: tiny, origin: zero }),
  };
}
function spatial(world = fixtureWorld(), imports = host(), bsp = fixtureBsp(), links = linkHeap()): AasSpatial {
  const entities = new AasBspEntities((_severity, text) => { imports.print(text); });
  entities.load(bsp.entities);
  const result = new AasSpatial(world, entities, imports, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
  result.setBrushModelTypes(imports.print);
  return result;
}

describe("source AAS area and presence traces", () => {
  test("uses the source fixed normal/crouch client dimensions", () => {
    expect(presenceTypeBounds(2)).toEqual({ min: vec3(-15, -15, -24), max: vec3(15, 15, 32) });
    expect(presenceTypeBounds(4)).toEqual({ min: vec3(-15, -15, -24), max: vec3(15, 15, 8) });
  });
  test("TraceAreas visits crossed leaves in order and ignores solid leaves", () => {
    const aas = spatial(fixtureWorld(sourcePlanes, [-1, -2]));
    expect(aas.traceAreas(vec3(0, 0, 10), vec3(0, 0, -10), 10)).toEqual([{ area: 1, point: vec3(0, 0, 10) }, { area: 2, point: zero }]);
    expect(aas.traceAreas(vec3(0, 0, -10), vec3(0, 0, 10), 1)).toEqual([{ area: 2, point: vec3(0, 0, -10) }]);
    expect(aas.traceAreas(zero, zero, 10)).toEqual([{ area: 2, point: zero }]);
    expect(spatial().traceAreas(vec3(0, 0, -10), vec3(0, 0, 10), 10)).toEqual([{ area: 1, point: zero }]);
    expect(aas.traceAreas(zero, zero, 0)).toEqual([]);
  });
  test("TraceClientBBox applies split/backoff separately and preserves last area", () => {
    const aas = spatial();
    expect(aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, -10), 2, -1)).toEqual({
      startSolid: false, fraction: Math.fround(0.49375), end: vec3(0, 0, 0.25), entityNum: 0, lastArea: 1, area: 0, plane: 0,
    });
    expect(aas.traceClientBBox(vec3(0, 0, -10), vec3(0, 0, 10), 2, -1)).toEqual({
      startSolid: true, fraction: 0, end: vec3(0, 0, -10), entityNum: 0, lastArea: 0, area: 0, plane: 0,
    });
    expect(aas.traceClientBBox(zero, zero, 2, -1).lastArea).toBe(1);
    const world = fixtureWorld();
    const crouchOnly = { ...world, areaSettings: world.areaSettings.map(value => ({ ...value, presenceType: 4 })) };
    expect(spatial(crouchOnly).traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 2, -1).area).toBe(1);
    expect(spatial(crouchOnly).traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 4, -1).fraction).toBe(1);
  });
  test("reverses collision-plane orientation and handles negative-facing axial planes", () => {
    const planes: readonly AasPlane[] = [{ normal: vec3(0, 0, -1), distance: 0, type: 2 }, { normal: vec3(0, 0, 1), distance: 0, type: 2 }];
    const aas = spatial(fixtureWorld(planes, [0, -1]));
    const trace = aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, -10), 2, -1);
    expect(trace.plane).toBe(1);
    expect(trace.end).toEqual(vec3(0, 0, 0.25));
    expect(aas.bboxAreas({ min: vec3(-1, -1, -10), max: vec3(1, 1, -1) })).toEqual([]);
  });
});

describe("source AAS links and best reachable areas", () => {
  test("BotImport EntityTrace uses real inline clipping and zeroes only represented contents", () => {
    const bounds: Bounds = { min: vec3(-10, -2, -3), max: vec3(10, 2, 3) };
    const worldBounds: Bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
    const planes = [
      { normal: vec3(1, 0, 0), distance: 10 }, { normal: vec3(-1, 0, 0), distance: 10 },
      { normal: vec3(0, 1, 0), distance: 2 }, { normal: vec3(0, -1, 0), distance: 2 },
      { normal: vec3(0, 0, 1), distance: 3 }, { normal: vec3(0, 0, -1), distance: 3 },
    ];
    const bsp: BspMap = { ...fixtureBsp(), planes, shaders: [{ name: "inline", contentFlags: 1, surfaceFlags: 8 }],
      models: [{ bounds: worldBounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 },
        { bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
      brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
    const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
    const target = { s: new EntityState(), r: new EntityShared() };
    target.s.modelindex = 1;
    target.s.number = 7; target.r.model = { kind: "inline", index: 1 }; target.r.contents = 1;
    target.r.currentOrigin = vec3(60, 0, 10);
    const worldPrints: string[] = [];
    const world = new ServerWorld(collision, worldBounds, number => number === 7 ? target : undefined, { loading: false, print: text => { worldPrints.push(text); }, developerPrint: text => { worldPrints.push(text); } });
    const raw: ServerTraceResult[] = [], converted: AasBspTrace[] = [], masks: number[] = [];
    const entityTrace: AasSpatialHost["entityTrace"] = (number, start, end, shape, mask) => {
      const hit = world.traceEntity(number, { start, end, shape: { kind: "box", mins: shape.min, maxs: shape.max }, mask });
      const result = { ...hit, contents: 0 };
      raw.push(hit); converted.push(result); masks.push(mask); return result;
    };
    // Only entity collision is under test; unrelated AAS services retain the existing controlled fixture.
    const aas = spatial(fixtureWorld(), { ...host(), entityTrace }, bsp);
    aas.linkClientBounds(7, { min: vec3(50, -2, 7), max: vec3(70, 2, 13) }, 2);
    const hit = aas.traceClientBBox(vec3(0, 0, 10), vec3(100, 0, 10), 2, 0);
    expect(hit.entityNum).toBe(7); expect(hit.end).toEqual(vec3(34.875, 0, 10));
    expect(hit.fraction).toBe(Math.fround(34.875 / 100)); expect(hit.startSolid).toBe(false);
    expect(masks).toEqual([0x10001]); expect(required(raw[0]).contents).toBe(1);
    expect(required(raw[0]).surfaceFlags).toBe(8); expect(required(raw[0]).contact.kind).toBe("plane");
    expect(required(converted[0])).toEqual({ ...required(raw[0]), contents: 0 });
    const end = { x: -100, y: 0, z: 10 };
    const miss = entityTrace(7, vec3(0, 0, 10), end, presenceTypeBounds(2), 0x10001);
    expect(miss.fraction).toBe(1); expect(miss.entityNum).toBe(0); expect(miss.contents).toBe(0);
    end.x = -200; expect(miss.end.x).toBe(-100);
    const exit = aas.traceClientBBox(vec3(60, 0, 10), vec3(100, 0, 10), 2, 0);
    expect(required(raw[2]).solidity).toBe("start-solid"); expect(required(raw[2]).fraction).toBe(1);
    expect(required(raw[2]).entityNum).toBe(0);
    expect(exit.fraction).toBe(1); expect(exit.end).toEqual(vec3(100, 0, 10)); expect(exit.entityNum).toBe(0);
    expect(world.linkState(7)).toBeUndefined();
  });

  test("brush model refresh uses source atoi/case folding, clears old classifications, and rejects undefined slot256", () => {
    const first = new Map([["classname", "FUNC_BOBBING"], ["model", "*7suffix"]]);
    const records = [first, new Map([["classname", "ignored"], ["model", "*7"]]), new Map([["classname", "func_static"], ["model", "*255"]]),
      ...[-1, 256, 257].map(index => new Map([["classname", "func_door"], ["model", `*${index}`]]))];
    const messages: string[] = [], imports = { ...host(), print: (text: string) => { messages.push(text); } };
    const entities = new AasBspEntities((_severity, text) => { imports.print(text); });
    entities.load(fixtureBsp(records).entities);
    const aas = new AasSpatial(fixtureWorld(), entities, imports, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
    aas.setBrushModelTypes(imports.print);
    expect(aas.host).toBe(imports); expect(aas.brushModelType(7)).toBe(2); expect(aas.brushModelType(255)).toBe(4); expect(aas.brushModelType(256)).toBe(0);
    expect(messages).toEqual(Array.from({ length: 3 }, () => "entity func_door model number out of range\n"));
    first.set("model", "*9"); entities.load(fixtureBsp(records).entities);
    const refreshed: string[] = []; aas.setBrushModelTypes(text => { refreshed.push(text); });
    expect(aas.brushModelType(7)).toBe(0); expect(aas.brushModelType(9)).toBe(2); expect(refreshed).toEqual(messages);
  });
  test("bounding box links preserve source prepend order and grounded/liquid preference", () => {
    const world = fixtureWorld(sourcePlanes, [-1, -2]), aas = spatial(world);
    expect(aas.bboxAreas(tiny)).toEqual([1, 2]);
    expect(aas.bestReachableLinkArea([2, 1])).toBe(2);
    const upperAir = spatial({ ...world, areaSettings: world.areaSettings.map((value, i) => ({ ...value, flags: i === 1 ? 0 : 4 })) });
    expect(upperAir.bestReachableLinkArea([1, 2])).toBe(2);
    const air = spatial({ ...world, areaSettings: world.areaSettings.map(value => ({ ...value, flags: 0, reachableAreaCount: 0 })) });
    expect(air.bestReachableLinkArea([1, 2])).toBe(1);
    expect(air.bestReachableLinkArea([])).toBe(0);
    expect(aas.clientBBoxAreas({ min: vec3(0, 0, 5), max: vec3(1, 1, 6) }, 4)).toEqual([1, 2]);
  });
  test("entity relink/unlink is reusable and nearest collision ties follow newest link order", () => {
    const calls: number[] = [], imports = host(), links = linkHeap();
    const aas = spatial(fixtureWorld(), { ...imports, entityTrace(entity, start, end) { calls.push(entity); return clear(scale3(add3(start, end), 0.5), 0.5, entity); } }, fixtureBsp(), links);
    const history = new AasEntityHistory(1024, { maxEntities: 1024, map: () => ({ kind: "ready", spatial: aas }),
      time: () => 0, frameNumber: () => 1, print: (_severity, text) => { imports.print(text); } }, links);
    const bounds = { min: vec3(-1, -1, 20), max: vec3(1, 1, 30) };
    const state: BotEntityUpdate = { type: 0, flags: 0, origin: zero, angles: zero, oldOrigin: zero,
      mins: bounds.min, maxs: bounds.max, groundEntity: 0, solid: 2, modelIndex: 0, modelIndex2: 0,
      frame: 0, event: 0, eventParameter: 0, powerups: 0, weapon: 0, legsAnimation: 0, torsoAnimation: 0 };
    history.update(1, state); history.update(2, state);
    expect(history.entityAreas(1)).toEqual([1]);
    const trace = aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 2, 0);
    expect(trace.entityNum).toBe(2);
    expect(trace.fraction).toBe(0.5);
    expect(calls).toEqual([2, 1]);
    history.update(1, state);
    expect(aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 2, 0).entityNum).toBe(1);
    expect(aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 2, 1).entityNum).toBe(2);
    expect(aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 2, -1).fraction).toBe(1);
    history.update(1, null); history.update(1, null); history.update(2, null);
    expect(history.entityAreas(1)).toEqual([]);
    expect(aas.traceClientBBox(vec3(0, 0, 10), vec3(0, 0, 20), 2, 0).fraction).toBe(1);
    history.update(1, state);
    expect(history.entityAreas(1)).toEqual([1]);
    history.update(1, { ...state, mins: vec3(-1, -1, -100), maxs: vec3(1, 1, -90) });
    expect(history.entityAreas(1)).toEqual([]);
    history.update(1022, state);
    expect(history.entityAreas(1022)).toEqual([]);
  });
  test("BestReachableArea drops in AAS space, fudges solid origins, then links the item bbox", () => {
    const aas = spatial();
    expect(aas.bestReachableArea(vec3(0, 0, 20), tiny)).toEqual({ area: 1, origin: vec3(0, 0, 0.25) });
    expect(aas.bestReachableArea(vec3(0, 0, -2), tiny).area).toBe(1);
    expect(aas.bestReachableArea(vec3(0, 0, -100), { min: vec3(-1, -1, -1), max: vec3(1, 1, 120) })).toEqual({ area: 1, origin: vec3(0, 0, -100) });
    const world = fixtureWorld();
    const blocked = spatial({ ...world, areaSettings: world.areaSettings.map(value => ({ ...value, presenceType: 2 })) });
    expect(blocked.bestReachableArea(vec3(0, 0, 20), tiny)).toEqual({ area: 1, origin: vec3(0, 0, 20.25) });
  });
  test("fuzzy sampling finds nearby reachable areas but retains an unreachable first area", () => {
    const world = fixtureWorld(sourcePlanes, [-1, -2]);
    const aas = spatial({ ...world, areaSettings: world.areaSettings.map((value, i) => ({ ...value, reachableAreaCount: i === 1 ? 1 : 0 })) });
    expect(aas.fuzzyPointReachabilityArea(vec3(0, 0, -3))).toBe(1);
    expect(aas.fuzzyPointReachabilityArea(vec3(0, 0, -10))).toBe(1);
    expect(aas.fuzzyPointReachabilityArea(vec3(0, 0, -30))).toBe(2);
  });
  test("platform reachability uses model travel records and DropToFloor uses the real host trace", () => {
    const world = fixtureWorld(sourcePlanes, [-1, -2]);
    const reaches = [0, 1].map(i => ({ area: i === 0 ? 0 : 2, face: 7, edge: 0, start: zero, end: zero, travelType: 11, travelTime: 0, padding: 0 }));
    const traces: { readonly start: Vec3; readonly end: Vec3; readonly pass: number; readonly mask: number }[] = [];
    const imports: AasSpatialHost = { ...host(), entityModelIndex: () => 7, trace(start, end, _bounds, pass, mask) { traces.push({ start, end, pass, mask }); return clear(end, 0.5, 3); } };
    const aas = spatial({ ...world, reachability: reaches }, imports, fixtureBsp([new Map([["classname", "func_plat"], ["model", "*7"]])]));
    expect(aas.reachabilityArea(vec3(0, 0, 20), 9)).toBe(2);
    expect(traces[0]).toEqual({ start: vec3(0, 0, 20), end: vec3(0, 0, 17), pass: 9, mask: 0x10001 });
    expect(aas.dropToFloor(vec3(0, 0, 20), tiny)).toEqual({ success: true, origin: vec3(0, 0, -80) });
    expect(traces[1]).toEqual({ start: vec3(0, 0, 20), end: vec3(0, 0, -80), pass: 0, mask: 1 });
    const solid = spatial(world, { ...host(), trace: (start) => ({ ...clear(start, 0), solidity: "all-solid" }) });
    expect(solid.dropToFloor(vec3(0, 0, 20), tiny)).toEqual({ success: false, origin: vec3(0, 0, 20) });
    const bob = spatial({ ...world, reachability: reaches.map(reach => ({ ...reach, travelType: 19, face: 0x11220007 })) }, imports,
      fixtureBsp([new Map([["classname", "func_bobbing"], ["model", "*7"]])]));
    expect(bob.reachabilityArea(vec3(0, 0, 20), 9)).toBe(2);
  });
  test("standing on a non-mover entity drops to reachable AAS ground unless swimming", () => {
    const planes: readonly AasPlane[] = [{ normal: vec3(0, 0, 1), distance: 100, type: 2 }, { normal: vec3(0, 0, -1), distance: -100, type: 2 }];
    const world = fixtureWorld(planes, [-2, -1]);
    const regions = { ...world, areaSettings: world.areaSettings.map((value, i) => ({ ...value, reachableAreaCount: i === 1 ? 1 : 0 })) };
    const imports: AasSpatialHost = { ...host(), trace: (_start, end) => clear(end, 0.5, 3) };
    const origin = vec3(0, 0, 130);
    expect(spatial(regions, imports).reachabilityArea(origin, 9)).toBe(1);
    expect(spatial(regions, { ...imports, pointContents: () => 32 }).reachabilityArea(origin, 9)).toBe(2);
    expect(spatial(regions, { ...imports, trace: (_start, end) => clear(end, 0.5, 1022) }).reachabilityArea(origin, 9)).toBe(2);
    expect(spatial(regions, { ...imports, trace: (start) => ({ ...clear(start, 0, 3), solidity: "start-solid" }) }).reachabilityArea(origin, 9)).toBe(2);
  });
});

function bits(value: number): number { const buffer = new ArrayBuffer(4), view = new DataView(buffer); view.setFloat32(0, value, true); return view.getUint32(0, true); }

describe("source jump-pad bounding-box movement specialization", () => {
  test("matches unchanged native source misses, including collision fraction reset", () => {
    // /tmp reference links untouched be_aas_sample.c, be_aas_move.c and
    // q_math.c, gcc -O0 -ffp-contract=off, against actual source headers.
    const aas = spatial();
    for (const x of [90, 1000]) {
      const result = aas.predictJumpPadHit(vec3(0, 0, 24), vec3(100, 0, 200), { min: vec3(x, -8, 90), max: vec3(x + 20, 8, 110) }, false);
      expect(result.frames).toBe(30);
      expect(result.stopEvent).toBe(0);
      expect([bits(result.end.x), bits(result.end.y), bits(result.end.z)]).toEqual([0x424d257f, 0, 0x3e800000]);
      expect([bits(result.velocity.x), bits(result.velocity.y), bits(result.velocity.z)]).toEqual([0, 0, 0xc5098000]);
      expect(bits(result.time)).toBe(0x40400000);
      expect(result.trace.fraction).toBe(0);
    }
  });
  test("detects a reached item through the source expanded bounding box", () => {
    const result = spatial().predictJumpPadHit(vec3(0, 0, 24), vec3(100, 0, 200), { min: vec3(30, -8, 50), max: vec3(50, 8, 70) }, false);
    expect(result.frames).toBe(1);
    expect(result.stopEvent).toBe(2048);
    expect(result.end).toEqual(vec3(15, 0, 38.25));
    expect(result.velocity).toEqual(vec3(100, 0, 40));
    expect(result.trace.fraction).toBe(0.5);
    expect(bits(result.time)).toBe(0x3dcccccd);
  });
  test("launches from BSP trigger targets and preserves optimized-area zero-volume ties", () => {
    const world = fixtureWorld(sourcePlanes, [-1, -2]);
    const pads = { ...world, areaSettings: world.areaSettings.map(value => ({ ...value, contents: 128 })) };
    const bsp = fixtureBsp([
      new Map([["classname", "trigger_push"], ["model", "*1"], ["target", "apex"]]),
      new Map([["classname", "target_position"], ["targetname", "apex"], ["origin", "100 0 100"]]),
    ]);
    const aas = spatial(pads, { ...host(), modelBounds: () => ({ bounds: { min: vec3(-5, -5, -5), max: vec3(5, 5, 5) }, origin: zero }) }, bsp);
    const itemBounds = { min: vec3(-15, -15, -15), max: vec3(15, 15, 15) };
    expect(aas.bestReachableFromJumpPadArea(vec3(35, 0, 20), itemBounds)).toBe(2);
    expect(aas.bestReachableFromJumpPadArea(vec3(10000, 0, 20), itemBounds)).toBe(0);
    expect(spatial(pads, host(), fixtureBsp([required(bsp.entityRecords[0])])).bestReachableFromJumpPadArea(vec3(35, 0, 20), itemBounds)).toBe(0);
    // A real tetrahedron of volume 2*2*2/6 beats the zero-face second area.
    // This exercises source face-fan area and plane-distance volume ranking.
    const normal = vec3(1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3));
    const planes: readonly AasPlane[] = [...sourcePlanes,
      { normal: vec3(0, -1, 0), distance: 0, type: 1 }, { normal: vec3(0, 1, 0), distance: 0, type: 1 },
      { normal: vec3(-1, 0, 0), distance: 0, type: 0 }, { normal: vec3(1, 0, 0), distance: 0, type: 0 },
      { normal, distance: Math.fround(2 * normal.x), type: 3 }, { normal: scale3(normal, -1), distance: Math.fround(-2 * normal.x), type: 3 },
    ];
    const edges: AasWorld["edges"] = [
      { vertices: [0, 0] }, { vertices: [0, 2] }, { vertices: [2, 1] }, { vertices: [1, 0] },
      { vertices: [0, 1] }, { vertices: [1, 3] }, { vertices: [3, 0] }, { vertices: [0, 3] },
      { vertices: [3, 2] }, { vertices: [2, 0] }, { vertices: [1, 2] }, { vertices: [2, 3] }, { vertices: [3, 1] },
    ];
    const tetra: AasWorld = {
      ...pads, planes, vertices: [zero, vec3(2, 0, 0), vec3(0, 2, 0), vec3(0, 0, 2)], edges,
      edgeIndexes: Array.from({ length: 12 }, (_, i) => i + 1), faceIndexes: [1, 2, 3, 4],
      faces: [0, 1, 2, 4, 6].map((plane, i) => ({ plane, flags: 0, firstEdge: Math.max(0, (i - 1) * 3), edgeCount: i === 0 ? 0 : 3, frontArea: 0, backArea: 1 })),
      areas: pads.areas.map((area, i) => ({ ...area, faceCount: i === 1 ? 4 : 0 })),
    };
    const tetraAas = spatial(tetra, { ...host(), modelBounds: () => ({ bounds: { min: vec3(-5, -5, -5), max: vec3(5, 5, 5) }, origin: zero }) }, bsp);
    expect(tetraAas.bestReachableFromJumpPadArea(vec3(35, 0, 20), itemBounds)).toBe(1);
  });
});

function retailHost(collision: CollisionWorld): AasSpatialHost {
  const messages: string[] = [];
  return {
    print: text => { messages.push(text); },
    trace: (start, end, bounds, _passEntity, mask) => {
      const result = collision.trace({ start, end, shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask });
      return { ...result, entityNum: result.fraction < 1 || result.solidity !== "clear" ? 1022 : 1023 };
    },
    pointContents: point => collision.pointContents(point), entityTrace: (_entity, _start, end) => clear(end), entityModelIndex: () => 0,
    modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }),
  };
}

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail AAS/BSP area traces and item floor sampling run on every mounted AAS world", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const products: readonly ("baseq3" | "missionpack")[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    let count = 0;
    for (const path of vfs.list("maps/").filter(path => path.endsWith(".aas"))) {
      const bspPath = path.replace(/\.aas$/, ".bsp");
      if (!vfs.has(bspPath)) continue;
      const world = parseAas(await vfs.read(path), path), bsp = parseBsp(await vfs.read(bspPath), bspPath), collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
      const imports = retailHost(collision);
      const aas = spatial(world, imports, bsp);
      const stride = Math.max(1, Math.floor(world.areas.length / 100));
      for (let area = 1; area < world.areas.length; area += stride) {
        const center = required(world.areas[area]).center;
        const crossings = aas.traceAreas(center, vec3(center.x + 64, center.y - 64, center.z - 64), 20);
        for (const crossing of crossings) expect(crossing.area).toBeGreaterThan(0);
        const trace = aas.traceClientBBox(center, vec3(center.x, center.y, center.z - 50), 4, -1);
        expect(Number.isFinite(trace.fraction)).toBe(true);
        expect([trace.end.x, trace.end.y, trace.end.z].every(Number.isFinite)).toBe(true);
        const goal = aas.bestReachableArea(center, tiny);
        expect(goal.area).toBeGreaterThanOrEqual(0);
        expect(goal.area).toBeLessThan(world.areas.length);
        const reachable = aas.fuzzyPointReachabilityArea(center);
        expect(reachable).toBeGreaterThanOrEqual(0);
        expect(reachable).toBeLessThan(world.areas.length);
      }
      count++;
    }
    expect(count).toBeGreaterThan(30);
  }
}, 60000);

test.skipIf(dataPath === undefined)("real q3dm17 and mpteam4 floating items are reached from actual jump-pad areas", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  for (const name of ["q3dm17", "mpteam4"]) {
    const world = parseAas(await vfs.read(`maps/${name}.aas`)), bsp = parseBsp(await vfs.read(`maps/${name}.bsp`));
    const aas = spatial(world, retailHost(new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" })), bsp);
    let count = 0;
    for (const entity of bsp.entityRecords) {
      if ((Number(entity.get("spawnflags")) & 1) === 0 || !/^(item_|weapon_)/.test(entity.get("classname") ?? "")) continue;
      const coordinates = required(entity.get("origin")).split(/\s+/).map(Number);
      const origin = vec3(required(coordinates[0]), required(coordinates[1]), required(coordinates[2]));
      const area = aas.bestReachableFromJumpPadArea(origin, { min: vec3(-15, -15, -15), max: vec3(15, 15, 15) });
      expect(area).toBeGreaterThan(0);
      expect(required(world.areaSettings[area]).contents & 128).toBe(128);
      expect(required(world.areas[area]).faceCount).toBe(0);
      count++;
    }
    expect(count).toBe(name === "q3dm17" ? 8 : 6);
  }
});
