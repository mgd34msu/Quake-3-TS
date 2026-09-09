import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { writeAasFile } from "../src/botlib/aas-file.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasLinkedReachability, AasReachabilityGenerator } from "../src/botlib/aas-reachability.ts";
import type { AasReachabilityOptions } from "../src/botlib/aas-reachability.ts";
import { aasBarrierJumpTravelTime, aasClosestEdgePoints, aasFaceArea, aasFaceCenter, aasFallDamageDistance, aasFallDelta, aasMaxJumpHeight,
  AasReachabilityGeometry } from "../src/botlib/aas-reachability-geometry.ts";
import type { AasClosestEdgeState } from "../src/botlib/aas-reachability-geometry.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import { TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { vec3 } from "../src/core/math.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";

const zero = vec3(0, 0, 0), f = Math.fround;
function cell<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Test fixture index ${index}`);
  return value;
}

class RecordedReachabilityMemory extends BotMemory {
  readonly requests: { readonly size: number; readonly kind: "heap" | "hunk";
    readonly clear: boolean; readonly allocation: BotMemoryAllocation }[] = [];
  readonly events: string[] = [];

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    this.events.push(`allocate:${this.requests.length}:${size}`);
    this.requests.push({ size, kind, clear, allocation });
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    super.free(allocation);
    this.events.push(`free:${this.requests.findIndex(request => request.allocation === allocation)}`);
  }

  bytes(index: number): Uint8Array { return cell(this.requests, index).allocation.bytes; }
  view(index: number): DataView {
    const bytes = this.bytes(index);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

function loadedFixture(input: AasWorld, memory: BotMemory): AasWorld {
  let bytes = new Uint8Array(0), cursor = 0;
  const written = writeAasFile(input, "reachability-fixture.aas", {
    print: () => undefined,
    openWrite: () => ({
      writeBytes(chunk) {
        if (cursor + chunk.length > bytes.length) {
          const grown = new Uint8Array(cursor + chunk.length); grown.set(bytes); bytes = grown;
        }
        bytes.set(chunk, cursor); cursor += chunk.length; return chunk.length;
      },
      seek(offset) { cursor = offset; return 0; },
      close() {},
    }),
  });
  expect(written).toBe(true);
  return parseAas(bytes, "reachability-fixture.aas", memory);
}

function fixture(height = 0, stored: readonly AasReachability[] = [], ladder = false,
  options: { readonly memory?: BotMemory; readonly onPrint?: AasReachabilityOptions["print"] } = {}) {
  const vertices = ladder
    ? [zero, vec3(0, -10, -20), vec3(0, -10, 0), vec3(0, 10, 0), vec3(0, 10, -20),
      vec3(0, -10, 0), vec3(0, -10, 20), vec3(0, 10, 20), vec3(0, 10, 0)]
    : [zero, vec3(-10, -10, 0), vec3(-10, 10, 0), vec3(0, 10, 0), vec3(0, -10, 0),
      vec3(0, -10, height), vec3(0, 10, height), vec3(10, 10, height), vec3(10, -10, height)];
  const worldInput: AasWorld = {
    source: "source reachability rectangles", version: 5, bspChecksum: 0, vertices,
    planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }, { normal: vec3(-1, 0, 0), distance: 0, type: 0 },
      { normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: 0, type: 2 },
      { normal: vec3(0, 0, 1), distance: height, type: 2 }, { normal: vec3(0, 0, -1), distance: -height, type: 2 }],
    edges: [{ vertices: [0, 0] }, { vertices: [1, 2] }, { vertices: [2, 3] }, { vertices: [3, 4] }, { vertices: [4, 1] },
      { vertices: [5, 6] }, { vertices: [6, 7] }, { vertices: [7, 8] }, { vertices: [8, 5] }],
    edgeIndexes: ladder ? [1, 2, 3, 4, 5, 6, 7, -2] : [1, 2, 3, 4, height === 0 ? -3 : 5, 6, 7, 8],
    faces: [{ plane: 0, flags: 0, edgeCount: 0, firstEdge: 0, frontArea: 0, backArea: 0 },
      { plane: ladder ? 0 : 2, flags: ladder ? 2 : 4, edgeCount: 4, firstEdge: 0, frontArea: 1, backArea: 0 },
      { plane: ladder ? 0 : 4, flags: ladder ? 2 : 4, edgeCount: 4, firstEdge: 4, frontArea: 2, backArea: 0 }],
    faceIndexes: [1, 2],
    areas: [{ areaNumber: 0, faceCount: 0, firstFace: 0, bounds: { min: zero, max: zero }, center: zero },
      { areaNumber: 1, faceCount: 1, firstFace: 0, bounds: { min: vec3(-10, -10, 0), max: vec3(0, 10, 80) }, center: vec3(-5, 0, 40) },
      { areaNumber: 2, faceCount: 1, firstFace: 1, bounds: { min: vec3(0, -10, height), max: vec3(10, 10, height + 80) }, center: vec3(5, 0, height + 40) }],
    areaSettings: Array.from({ length: 3 }, (_, area) => ({ contents: 0, flags: area === 0 ? 0 : ladder ? 2 : 1, presenceType: 2,
      cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 })),
    reachability: stored,
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-2, -1] }], portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea: point => point.x > 0 ? 2 : 1,
    areaReachabilities: () => [],
    areaBounds: area => ({ min: vec3(area === 1 ? -10 : 0, -10, 0), max: vec3(area === 1 ? 0 : 10, 10, 80) }),
  };
  const world = new AasWorldState(options.memory === undefined ? worldInput : loadedFixture(worldInput, options.memory));
  const variables = new BotLibVars(), messages: string[] = [];
  const bspEntities = new AasBspEntities((_severity, text) => { messages.push(text); });
  bspEntities.load("");
  const unavailable = (): never => { throw new Error("Rectangle fixture does not supply BSP traces"); };
  const host: AasSpatialHost = { print: text => { messages.push(text); }, pointContents: () => 0, trace: unavailable,
    entityTrace: unavailable, entityModelIndex: unavailable, modelBounds: unavailable };
  const links = new AasLinkHeap(unavailable); links.initialize(() => 32);
  const debug = new BotDebugPolygons(); debug.initialize(100);
  const debugLines = new AasDebugLines(debug, text => { host.print(text); });
  const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links,
    debugLines.movement, () => variables.value("bot_visualizejumppads", "0"));
  const generator = new AasReachabilityGenerator({ world, spatial, bspEntities, variables,
    print: (severity, text) => { messages.push(text); options.onPrint?.(severity, text); }, log: text => { messages.push(text); },
    permanentLine: (start, end, color) => { debug.permanentLine(start, end, color); }, milliseconds: () => 0 });
  return { world, variables, messages, generator, geometry: new AasReachabilityGeometry(generator) };
}

test("reachability geometry preserves source areas, centers, ballistic float storage and closest-edge range", () => {
  const { world } = fixture();
  expect(aasFaceArea(world, cell(world.faces, 1))).toBe(200);
  expect(aasFaceCenter(world, 1)).toEqual(vec3(-5, 0, 0));
  expect(aasMaxJumpHeight({ ...DEFAULT_AAS_MOVEMENT_SETTINGS }, 270)).toBe(45.5625);
  expect(aasFallDelta({ ...DEFAULT_AAS_MOVEMENT_SETTINGS }, 250)).toBe(f(40.0000025));
  expect(aasBarrierJumpTravelTime({ ...DEFAULT_AAS_MOVEMENT_SETTINGS })).toBe(3);
  expect(aasFallDamageDistance({ ...DEFAULT_AAS_MOVEMENT_SETTINGS })).toBe(187);
  expect(() => aasFallDamageDistance({ ...DEFAULT_AAS_MOVEMENT_SETTINGS, gravity: 0 })).toThrow("source signed integer range");
  const state: AasClosestEdgeState = { range: null }, plane = cell(world.planes, 2);
  expect(aasClosestEdgePoints(vec3(0, 0, 0), vec3(0, 10, 0), vec3(10, 0, 0), vec3(10, 10, 0), plane, plane, state, 999999)).toBe(10);
  expect(state.range).toEqual({ start1: vec3(0, 10, 0), start2: zero, end1: vec3(10, 10, 0), end2: vec3(10, 0, 0) });
  const oblique: AasClosestEdgeState = { range: null };
  expect(aasClosestEdgePoints(vec3(0, 10, 0), vec3(0, 11, 0), zero, vec3(10, 10, 0), plane, plane, oblique, 999999)).toBe(f(Math.sqrt(82)));
  expect(oblique.range).toEqual({ start1: vec3(0, 10, 0), start2: vec3(0, 10, 0), end1: vec3(9, 9, 0), end2: vec3(9, 9, 0) });
});

test("equal floors publish signed shared-edge points and entering crouch adds source delay", () => {
  const { world, generator, geometry } = fixture(); generator.initialize();
  world.areaSettingsRecord(2).presenceType = 4;
  expect(geometry.equalFloorHeight(1, 2)).toBe(true);
  const reach = cell(generator.heads, 1);
  expect(reach).not.toBeNull();
  if (reach === null) throw new Error("Expected equal-floor reachability");
  expect([reach.area, reach.face, reach.edge, reach.travelType, reach.travelTime]).toEqual([2, 0, 3, TravelType.WALK, 301]);
  expect(reach.start).toEqual(vec3(0.1, 0, 0));
  expect(reach.end).toEqual(vec3(5, 0, 0.125));
});

test("step and barrier thresholds retain zero-time stepping and configured barrier time", () => {
  for (const height of [18, 19, 32]) {
    const { generator, geometry } = fixture(height); generator.initialize();
    expect(geometry.equalFloorHeight(1, 2)).toBe(false);
    expect(geometry.stepBarrierWaterJumpWalkOffLedge(1, 2)).toBe(true);
    const reach = cell(generator.heads, 1);
    if (reach === null) throw new Error("Expected raised-floor reachability");
    expect([reach.edge, reach.travelType, reach.travelTime]).toEqual([3, height < 19 ? TravelType.WALK : TravelType.BARRIERJUMP, height < 19 ? 0 : 100]);
    expect(reach.start).toEqual(vec3(0.1, 0, 0)); expect(reach.end).toEqual(vec3(5, 0, height));
  }
});

test("ladder publishes both directions and retains the first when the second allocation fails", () => {
  const { generator, geometry, messages } = fixture(0, [], true); generator.initialize();
  expect(geometry.ladder(1, 2)).toBe(true);
  const first = cell(generator.heads, 1), second = cell(generator.heads, 2);
  if (first === null || second === null) throw new Error("Expected reciprocal ladder links");
  expect([first.area, first.face, first.edge, first.travelType, first.travelTime]).toEqual([2, 1, 2, TravelType.LADDER, 10]);
  expect([second.area, second.face, second.edge, second.travelType, second.travelTime]).toEqual([1, 2, 2, TravelType.LADDER, 10]);
  expect(first.start).toEqual(vec3(0, 0, -32)); expect(first.end).toEqual(vec3(-3, 0, 32));
  expect(second.start).toEqual(vec3(0, 0, 32)); expect(second.end).toEqual(vec3(-3, 0, -32));
  generator.initialize();
  for (let i = 0; i < 65535; i++) {
    if (generator.allocate() === null) throw new Error("Source reachability heap exhausted early");
  }
  expect(geometry.ladder(1, 2)).toBe(false);
  expect(cell(generator.heads, 1)).not.toBeNull(); expect(cell(generator.heads, 2)).toBeNull();
  expect(messages.at(-1)).toBe("AAS_MAX_REACHABILITYSIZE"); expect(generator.allocatedReachabilityCount).toBe(65536);
});

test("incremental generation publishes once in area/list order and requires the final extra frame", () => {
  const { world, generator, messages } = fixture(), settings = world.areaSettingsRecord(1);
  generator.initialize(); expect(world.saveFile).toBe(true); expect(world.numReachabilityAreas).toBe(1);
  expect(generator.continueInitialization(0)).toBe(true);
  expect(world.numReachabilityAreas).toBe(2); expect(world.reachabilitySize).toBe(0); expect(settings.reachableAreaCount).toBe(0);
  expect(generator.continueInitialization(0.1)).toBe(true); expect(world.numReachabilityAreas).toBe(4);
  expect(world.reachabilitySize).toBe(0);
  expect(generator.continueInitialization(0.2)).toBe(true); expect(world.numReachabilityAreas).toBe(5);
  expect(generator.continueInitialization(0.3)).toBe(false);
  expect(world.areaSettingsRecord(1)).toBe(settings);
  expect([world.reachabilitySize, settings.firstReachableArea, settings.reachableAreaCount]).toEqual([3, 1, 1]);
  expect(world.areaReachabilities(1).map(reach => [reach.area, reach.edge, reach.travelTime, reach.padding])).toEqual([[2, 3, 1, 0]]);
  expect(world.areaReachabilities(2).map(reach => [reach.area, reach.edge, reach.travelTime, reach.padding])).toEqual([[1, -3, 1, 0]]);
  expect(generator.allocatedReachabilityCount).toBe(0);
  expect(messages).toEqual(["0 weapon jump areas\n", "calculating reachability...\n", "\r  66.6%", "\r 100.0%", "\nplease wait while storing reachability...\n", "calculating clusters...\n"]);
});

test("source existing-data path avoids allocation and forced replacement clears output padding", () => {
  const old = { area: 0, face: 0, edge: 0, start: zero, end: zero, travelType: 0, travelTime: 0, padding: 0xbeef };
  const { generator, world, variables, messages } = fixture(0, [old]);
  generator.initialize(); expect(generator.continueInitialization(0)).toBe(false); expect(world.saveFile).toBe(false);
  expect(cell(world.reachability, 0).padding).toBe(0xbeef); expect(messages).toEqual([]);
  variables.set("forcereachability", "1"); generator.initialize();
  while (generator.continueInitialization(0)) { /* source progresses a bounded number of areas per call */ }
  expect(world.reachability.map(reach => reach.padding)).toEqual([0, 0, 0]);
});

test("temporary reachability free zeroes the cell and unsigned-short writes truncate and wrap", () => {
  const { generator } = fixture(); generator.initialize();
  const link = generator.allocate(); if (link === null) throw new Error("Expected reachability allocation");
  link.area = 2; link.face = -3; link.edge = 4; link.start = vec3(1, 2, 3); link.travelTime = 65537.75;
  expect(link.travelTime).toBe(1); link.travelTime += 65535; expect(link.travelTime).toBe(0);
  generator.free(link); expect(generator.allocatedReachabilityCount).toBe(0);
  expect(generator.allocate()).toBe(link);
  expect([link.area, link.face, link.edge, link.travelTime]).toEqual([0, 0, 0, 0]); expect(link.start).toEqual(zero);
  expect(() => { new AasLinkedReachability().travelTime = Number.NaN; }).toThrow("source integer conversion range");
});

test("temporary pool and area heads store live source bytes across frames and free after committed output", () => {
  const zone = new ZoneArena(8 * 1024 * 1024), memory = new RecordedReachabilityMemory({ kind: "unaccounted" }, zone);
  const { generator, world } = fixture(0, [], false, { memory });
  const available = zone.memoryRemaining();
  expect(memory.requests).toHaveLength(14);
  generator.initialize();
  expect(memory.requests.slice(14).map(request => [request.size, request.kind, request.clear]))
    .toEqual([[3145728, "heap", true], [12, "heap", true]]);
  expect(memory.view(14).getUint32(44, true)).toBe(2);
  expect(memory.view(14).getUint32(65535 * 48 + 44, true)).toBe(0);
  const first = generator.allocate(), second = generator.allocate(), heads = generator.heads;
  if (first === null || second === null) throw new Error("Expected two source pool cells");
  const start = first.start;
  first.area = 0x100000002; first.face = -3; first.edge = 4;
  first.start = { x: 0.1, y: 0.2, z: 0.3 }; first.end = { x: -0.1, y: -0.2, z: -0.3 };
  first.travelType = 0x1000002; first.travelTime = 65537.75; first.next = second;
  second.area = 2; second.next = null; heads[1] = first;
  expect([memory.view(14).getInt32(0, true), memory.view(14).getInt32(4, true), memory.view(14).getInt32(8, true)])
    .toEqual([2, -3, 4]);
  expect(Array.from({ length: 6 }, (_, index) => memory.view(14).getFloat32(12 + index * 4, true)))
    .toEqual([0.1, 0.2, 0.3, -0.1, -0.2, -0.3].map(f));
  expect(memory.view(14).getInt32(36, true)).toBe(0x1000002);
  expect(memory.view(14).getUint16(40, true)).toBe(1);
  expect(memory.view(14).getUint32(44, true)).toBe(2);
  expect(memory.view(15).getUint32(4, true)).toBe(1);
  memory.view(14).setFloat32(12, 0.25, true); memory.view(15).setUint32(4, 2, true);
  expect(start.x).toBe(0.25); expect(heads[1]).toBe(second); expect(generator.exists(1, 2)).toBe(true);
  heads[1] = null;
  memory.view(14).setUint16(42, 0xabcd, true);
  generator.free(first);
  expect(memory.bytes(14).subarray(0, 44).every(byte => byte === 0)).toBe(true);
  expect(memory.view(14).getUint32(44, true)).toBe(3);
  generator.free(second); expect(generator.allocate()).toBe(second); generator.free(second);
  generator.continueInitialization(0);
  expect(world.numReachabilityAreas).toBe(2); expect(memory.events.some(event => event.startsWith("free:"))).toBe(false);
  while (generator.continueInitialization(0)) { /* finish the remaining source frames */ }
  expect(memory.events.slice(14)).toEqual(["allocate:14:3145728", "allocate:15:12", "free:9",
    "allocate:16:528", "free:14", "free:15"]);
  expect(generator.allocatedReachabilityCount).toBe(0); expect(world.reachabilitySize).toBe(3);
  for (const read of [() => first.area, () => start.x, () => first.next, () => heads[1]]) expect(read).toThrow("freed");
  expect(available - zone.memoryRemaining()).toBe(556);
  world.dumpData(); expect(zone.memoryRemaining()).toBe(available); zone.checkHeap();
});

test("last-cell diagnostics reread the free list after callback insertion and preserve throws before allocation", () => {
  const memory = new RecordedReachabilityMemory();
  let onLimit: () => undefined = () => undefined;
  const { generator } = fixture(0, [], false, { memory,
    onPrint: (severity, text) => { if (severity === 4 && text === "AAS_MAX_REACHABILITYSIZE") onLimit(); },
  });
  generator.initialize();
  const first = generator.allocate();
  if (first === null || first.next === null) throw new Error("Expected initialized free list");
  const second = first.next;
  memory.view(14).setUint32(48 + 44, 0, true);
  onLimit = () => { expect(generator.allocatedReachabilityCount).toBe(1); generator.free(first); return undefined; };
  expect(generator.allocate()).toBe(first); expect(generator.allocatedReachabilityCount).toBe(1);
  onLimit = () => { throw new Error("stop at last source cell"); };
  expect(() => generator.allocate()).toThrow("stop at last source cell");
  expect(generator.allocatedReachabilityCount).toBe(1);
  onLimit = () => undefined;
  expect(generator.allocate()).toBe(second); expect(generator.allocate()).toBeNull();
  expect(generator.allocatedReachabilityCount).toBe(2);
});

test("area-head allocation failure retains the initialized source pool and prior progress writes", () => {
  const zone = new ZoneArena(3145728 + 28 + 32), memory = new RecordedReachabilityMemory({ kind: "unaccounted" }, zone);
  const { generator, world, messages } = fixture(0, [], false, { memory });
  expect(() => generator.initialize()).toThrow("Z_Malloc: failed on allocation of 40 bytes from the main zone");
  expect(memory.requests).toHaveLength(15); expect(memory.events.some(event => event.startsWith("free:"))).toBe(false);
  expect([world.saveFile, world.numReachabilityAreas, generator.allocatedReachabilityCount]).toEqual([true, 1, 0]);
  expect(generator.heads).toHaveLength(0); expect(messages).toEqual([]);
  const first = generator.allocate();
  if (first === null) throw new Error("Expected retained source pool after area-head allocation failure");
  expect(first.next).not.toBeNull(); expect(memory.view(14).getUint32(44, true)).toBe(2);
  memory.free(cell(memory.requests, 14).allocation);
  expect(zone.memoryRemaining()).toBe(3145728 + 28 + 32); zone.checkHeap();
});

test("reinitialization preserves the source's overwritten unfinished pool allocations", () => {
  const zone = new ZoneArena(8 * 1024 * 1024), memory = new RecordedReachabilityMemory({ kind: "unaccounted" }, zone);
  const { generator, world } = fixture(0, [], false, { memory }), available = zone.memoryRemaining();
  generator.initialize();
  const old = generator.allocate(), heads = generator.heads;
  if (old === null) throw new Error("Expected original source pool cell");
  old.area = 2; old.next = null; heads[1] = old;
  generator.initialize();
  expect(memory.requests).toHaveLength(18); expect(memory.events.some(event => event.startsWith("free:"))).toBe(false);
  expect(old.area).toBe(2); expect(heads[1]).toBe(old); expect(generator.heads[1]).toBeNull();
  while (generator.continueInitialization(0)) { /* finish only the current source allocations */ }
  world.dumpData();
  expect(available - zone.memoryRemaining()).toBe(3145796);
  expect(old.area).toBe(2); expect(heads[1]).toBe(old);
  memory.free(cell(memory.requests, 14).allocation); memory.free(cell(memory.requests, 15).allocation);
  expect(zone.memoryRemaining()).toBe(available); zone.checkHeap();
});

const retailRoot = process.env["Q3_DATA"];
test.skipIf(retailRoot === undefined)("both-product retail forced reachability generation uses real AAS, BSP collision and debug ownership", async () => {
  if (retailRoot === undefined) throw new Error("Q3_DATA required");
  const maps: readonly { readonly product: "baseq3" | "missionpack"; readonly name: string }[] = [
    { product: "baseq3", name: "q3dm1" }, { product: "missionpack", name: "mpteam1" },
  ];
  for (const map of maps) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: map.product });
    try {
    const bsp = parseBsp(await vfs.read(`maps/${map.name}.bsp`));
    const world = new AasWorldState(parseAas(await vfs.read(`maps/${map.name}.aas`)));
    const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" }), messages: string[] = [];
    const unavailable = (): never => { throw new Error("No dynamic entity linked during retail generation"); };
    const host: AasSpatialHost = {
      print: text => { messages.push(text); },
      trace: (start, end, bounds, _pass, mask) => ({ ...collision.trace({ start, end,
        shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }), entityNum: 1022 }),
      pointContents: point => collision.pointContents(point), entityTrace: unavailable, entityModelIndex: unavailable,
      modelBounds: model => ({ bounds: collision.modelBounds(model), origin: zero }),
    };
    const bspEntities = new AasBspEntities((_severity, text) => { messages.push(text); }); bspEntities.load(bsp.entities);
    const links = new AasLinkHeap(() => { throw new Error("Retail reachability exhausted AAS links"); }); links.initialize(() => 6144);
    const debug = new BotDebugPolygons(); debug.initialize(100);
    const variables = new BotLibVars(); variables.set("forcereachability", "1");
    const debugLines = new AasDebugLines(debug, text => { host.print(text); });
    const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links,
      debugLines.movement, () => variables.value("bot_visualizejumppads", "0"));
    const generator = new AasReachabilityGenerator({ world, spatial, bspEntities, variables,
      print: (_severity, text) => { messages.push(text); }, log: text => { messages.push(text); },
      permanentLine: (start, end, color) => { debug.permanentLine(start, end, color); },
      milliseconds: () => { const usage = process.cpuUsage(); return Math.trunc((usage.user + usage.system) / 1000); } });
    generator.initialize();
    let calls = 0;
    while (generator.continueInitialization(f(calls / 10))) {
      calls++;
      if (calls > world.areas.length + 3) throw new Error(`${map.name} reachability did not finish`);
    }
    expect(world.numReachabilityAreas).toBe(world.areas.length + 2);
    expect(world.saveFile).toBe(true); expect(calls).toBeGreaterThan(1);
    expect(world.reachabilitySize).toBeGreaterThan(0);
    expect(world.reachability.every(reach => reach.padding === 0 && Number.isInteger(reach.travelTime)
      && reach.travelTime >= 0 && reach.travelTime <= 65535)).toBe(true);
    expect(world.areaSettings.reduce((total, settings) => total + settings.reachableAreaCount, 0)).toBe(world.reachabilitySize - 1);
    expect(messages.at(-1)).toBe("calculating clusters...\n");
    } finally { vfs.close(); }
  }
}, 60000);
