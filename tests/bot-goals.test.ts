import { BotScriptSources, type BotScriptReader } from "../src/botlib/script-sources.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BotGoalLibrary, GoalError, GoalFlags, MAX_AVOID_GOALS, loadItemConfig, touchingGoal, type BotGoal, type GoalEntityInfo, type GoalWorldHost } from "../src/botlib/goals.ts";
import { parseBsp, type BspMap } from "../src/assets/bsp.ts";
import { parseAas, type AasWorld } from "../src/botlib/aas.ts";
import { AasRouting, TravelFlags } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes, type AasSpatialHost, type AasBspTrace } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { vec3, type Vec3 } from "../src/core/math.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import { ScriptLanguageError } from "../src/script/lexer.ts";
import type { IncludeRequest, ScriptSource } from "../src/script/preprocessor.ts";
import type { Product } from "../src/shared/definitions.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

class Resolver implements BotScriptReader {
  readonly globals = new ScriptGlobalDefines();
  readonly sources = new Map<string, string>();
  readonly reads: string[] = [];
  beforeRead: (path: string) => void = () => {};
  resolveRoot(path: string): ScriptSource | undefined {
    this.reads.push(path);
    const text = this.sources.get(path);
    this.beforeRead(path);
    return text === undefined ? undefined : { path, text };
  }
  resolve(request: IncludeRequest): ScriptSource | undefined {
    return this.resolveRoot(request.requestedPath);
  }
}

const ITEM_SOURCE = 'iteminfo "item_health" { name "Health" modelindex 5 respawntime 35 mins {-15,-15,-15} maxs {15,15,15} }';
const WEIGHT_SOURCE = 'weight "item_health" { return balance(10, 1, 20); }';

function fixture(memory?: BotMemory, weightMemory?: BotMemory) {
  const resolver = new Resolver();
  resolver.sources.set("items.c", ITEM_SOURCE);
  resolver.sources.set("weights.c", WEIGHT_SOURCE);
  const store = new WeightConfigStore(resolver, { reloadCharacters: true, ...(weightMemory === undefined ? {} : { memory: weightMemory }) });
  const runtime = { time: 0, gameType: 0, maxItemInfo: 256, maxLevelItems: 256, droppedWeight: 1000, randomCalls: 0 };
  const log: string[] = [];
  const library = new BotGoalLibrary({ ...(memory === undefined ? {} : { memory }), resolver, weightStore: store, log: { write: text => { log.push(text); } }, clock: () => runtime.time, gameType: () => runtime.gameType, maxItemInfo: { get: () => runtime.maxItemInfo, set: value => { runtime.maxItemInfo = value; } }, maxLevelItems: () => runtime.maxLevelItems, droppedWeight: () => runtime.droppedWeight, random: { nextInt: () => { runtime.randomCalls++; return 0; } } });
  return { resolver, store, runtime, library, log };
}

function goal(number: number): BotGoal {
  return { number, origin: { x: number, y: 2, z: 3 }, mins: { x: -1, y: -2, z: -3 }, maxs: { x: 1, y: 2, z: 3 }, area: 1, entity: 7, flags: 1, itemInfo: 0 };
}

function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error("missing goal fixture value"); return value; }
function emptyBsp(entityRecords: BspMap["entityRecords"]): BspMap {
  const entities = entityRecords.map(record => `{ ${Array.from(record, ([key, value]) => `"${key}" "${value}"`).join(" ")} }`).join("\n");
  return { entities, entityRecords, shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [], models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function testAas(): AasWorld {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const reachability = [0, 1, 2].map(index => ({ area: index === 0 ? 0 : index === 1 ? 2 : 1, face: 0, edge: 0, start: vec3(0, 0, 0), end: vec3(0, 0, 0), travelType: 2, travelTime: 100, padding: 0 }));
  return { source: "goal-fixture", version: 5, bspChecksum: 0, vertices: [], planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    areas: [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: vec3(areaNumber === 1 ? 100 : -100, 0, 20) })),
    areaSettings: [0, 1, 2].map(index => ({ contents: 0, flags: 1, presenceType: 6, cluster: index === 0 ? 0 : 1, clusterAreaNumber: index === 0 ? 0 : index - 1, reachableAreaCount: index === 0 ? 0 : 1, firstReachableArea: index })),
    reachability, nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -2] }], portals: [], portalIndex: [], clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 }, { areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 }], bboxes: [],
    pointArea: point => point.x > 0 ? 1 : 2, areaBounds: () => bounds, areaReachabilities: area => area === 0 ? [] : [required(reachability[area])],
  };
}
function mapEntity(classname: string, origin: string, extra: readonly (readonly [string, string])[] = []): ReadonlyMap<string, string> { return new Map([["classname", classname], ["origin", origin], ...extra]); }
function entityInfo(origin: Vec3, modelIndex = 5, type = 2, lastUpdateTime = 0): GoalEntityInfo { return { type, modelIndex, origin, lastVisibleOrigin: origin, lastUpdateTime }; }
function clearTrace(end: Vec3): AasBspTrace { return { fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 }; }
function mapFixture(records: BspMap["entityRecords"]) {
  const bsp = emptyBsp(records), aas = testAas(), entities = new Map<number, GoalEntityInfo>();
  const traceTargets: Vec3[] = [], messages: string[] = [];
  const host: GoalWorldHost & AasSpatialHost = {
    print: text => { messages.push(text); },
    trace: (_start, end, bounds) => { traceTargets.push(end); return bounds === null ? clearTrace(end) : { ...clearTrace(vec3(end.x, end.y, 15)), fraction: 0.5, entityNum: 1022 }; },
    pointContents: () => 0, entityTrace: (_entity, _start, end) => clearTrace(end), entityModelIndex: number => entities.get(number)?.modelIndex ?? 0,
    modelBounds: () => ({ bounds: { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) }, origin: vec3(0, 0, 0) }),
    nextEntity: after => [...entities.keys()].sort((a, b) => a - b).find(number => number > after) ?? 0,
    entityInfo: number => required(entities.get(number)),
  };
  const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); }), modelTypes = new BotBrushModelTypes(), links = linkHeap();
  bspEntities.load(bsp.entities);
  const spatial = new AasSpatial(aas, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, modelTypes, links, { kind: "disabled" }, () => 0), routing = new AasRouting(aas);
  routing.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 0);
  return { bsp, bspEntities, modelTypes, links, spatial, routing, navigation: { spatial, routing }, pointArea: (point: Vec3) => aas.pointArea(point), host, entities, traceTargets, messages };
}

describe("item configuration", () => {
  test("top-level source read failure finalizes parsed items", () => {
    const resolver = new Resolver();
    resolver.sources.set("items", `${ITEM_SOURCE}\n#error stopped\nunknown {}`);
    const messages: string[] = [];
    const config = loadItemConfig(resolver, "items", { report: diagnostic => { messages.push(diagnostic.message); return undefined; } });
    expect(config.items[0]?.classname).toBe("item_health");
    expect(messages).toEqual(["file items, line 2: #error directive: stopped\n", "loaded items\n"]);
  });

  test("preprocessor, source field order, repeat overlays, signed int16 and float32 storage", async () => {
    const resolver = new Resolver();
    resolver.sources.set("inv.h", "#define MODEL 32767\n");
    resolver.sources.set("items", '#include "inv.h"\niteminfo "thing" { mins {1,2,3} mins {9} maxs {} modelindex MODEL type -32768 index 3 respawntime 0.1 name "first" name "last" } iteminfo "empty" {}');
    const config = await loadItemConfig(resolver, "items");
    expect(config.items).toEqual([
      { classname: "thing", name: "last", model: "", modelIndex: 32767, type: -32768, index: 3, respawnTime: Math.fround(0.1), mins: { x: 9, y: 2, z: 3 }, maxs: { x: 0, y: 0, z: 0 }, number: 0 },
      { classname: "empty", name: "", model: "", modelIndex: 0, type: 0, index: 0, respawnTime: 0, mins: { x: 0, y: 0, z: 0 }, maxs: { x: 0, y: 0, z: 0 }, number: 1 },
    ]);
  });
  test("rejects malformed definitions and over-capacity input", async () => {
    const resolver = new Resolver();
    for (const source of ['unknown "a" {}', 'iteminfo name {}', 'iteminfo "a" { bad 1 }', 'iteminfo "a" { index 32768 }', 'iteminfo "a" { index 1.5 }', 'iteminfo "a" { mins {1 2} }', 'iteminfo "a" {']) {
      resolver.sources.set("bad", source);
      expect(() => loadItemConfig(resolver, "bad")).toThrow(ScriptLanguageError);
    }
    resolver.sources.set("bad", ITEM_SOURCE);
    expect(() => loadItemConfig(resolver, "bad", { maxItems: 0 })).toThrow("more than 0");
    expect(() => loadItemConfig(resolver, "missing")).toThrow("couldn't load");
  });
  test("truncates source string fields and reports empty configuration", async () => {
    const resolver = new Resolver();
    resolver.sources.set("long", `iteminfo "${"c".repeat(40)}" { name "${"n".repeat(90)}" model "${"m".repeat(90)}" }`);
    const config = await loadItemConfig(resolver, "long");
    expect(config.items[0]?.classname).toHaveLength(31);
    expect(config.items[0]?.name).toHaveLength(79);
    expect(config.items[0]?.model).toHaveLength(79);
    resolver.sources.set("empty", "");
    expect((await loadItemConfig(resolver, "empty")).diagnostics[0]?.message).toBe("no item info loaded");
  });
});

class GoalMemory extends BotMemory {
  readonly blocks: BotMemoryAllocation[] = [];
  readonly freed: BotMemoryAllocation[] = [];
  readonly events: string[] = [];
  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    this.events.push(`allocate ${kind} ${size} ${clear}`);
    const allocation = super.allocate(size, kind, clear);
    this.blocks.push(allocation);
    return allocation;
  }
  override free(allocation: BotMemoryAllocation): void {
    this.events.push(`free ${allocation.bytes.length}`);
    super.free(allocation);
    this.freed.push(allocation);
  }
}

describe("goal source heap storage", () => {
  test("item capacities above one million reach the hunk after source opening", () => {
    const arena = new HunkArena(8192, () => {});
    const memory = new GoalMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const { library, runtime, resolver } = fixture(memory);
    runtime.maxItemInfo = 1_000_001;
    expect(library.setup("missing.c")).toBe(GoalError.CannotLoadItemConfig);
    expect(resolver.reads).toEqual(["missing.c"]);
    expect(memory.events).toEqual([]);
    expect(() => library.setup()).toThrow("Hunk_Alloc failed on 236000256");
    expect(resolver.reads).toEqual(["missing.c", "items.c"]);
    expect(memory.events).toEqual(["allocate hunk 236000244 true"]);
    expect(arena.memoryRemaining()).toBe(8192);
    expect(library.itemConfig).toBeNull();
    library.shutdown();
  });

  test("level capacities above one million reach the real zone allocator", () => {
    const zone = new ZoneArena(8192), memory = new GoalMemory(undefined, zone);
    const { library, runtime } = fixture(memory);
    runtime.maxLevelItems = 1_000_001;
    try {
      expect(() => library.initLevelItems(mapFixture([]))).toThrow("Z_Malloc");
      expect(memory.events).toEqual(["allocate heap 60000060 true"]);
      expect(zone.memoryRemaining()).toBe(8192);
      zone.checkHeap();
    } finally { library.shutdown(); zone.dispose(); }
  });

  test("goal allocation sizes still reject signed source size overflow", () => {
    const memory = new GoalMemory(), { library, runtime, resolver } = fixture(memory);
    runtime.maxItemInfo = 10_000_000;
    expect(() => library.setup()).toThrow("nonnegative source signed size");
    expect(resolver.reads).toEqual(["items.c"]);
    runtime.maxLevelItems = 40_000_000;
    expect(() => library.initLevelItems(mapFixture([]))).toThrow("nonnegative source signed size");
    expect(memory.events).toEqual(["allocate hunk 2360000008 true", "allocate heap 2400000000 true"]);
    library.shutdown();
  });

  test("goal shutdown frees the still-published item config before states", () => {
    const memory = new GoalMemory(), { library } = fixture(memory);
    expect(library.setup()).toBe(0);
    const config = required(library.itemConfig), configBytes = required(memory.blocks[0]);
    library.allocGoalState(1);
    const state = required(memory.blocks[1]), free = memory.free.bind(memory);
    memory.free = allocation => {
      if (allocation === configBytes) expect(library.itemConfig).toBe(config);
      if (allocation === state) expect(library.itemConfig).toBeNull();
      free(allocation);
    };
    library.shutdown();
    expect(memory.freed).toEqual([configBytes, state]);
  });

  test("item configuration retains high source bytes and clears each reached item record", () => {
    class DirtyItemsMemory extends GoalMemory {
      override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
        const allocation = super.allocate(size, kind, clear);
        if (kind === "hunk") allocation.bytes.fill(0x7f, 8);
        return allocation;
      }
    }
    const memory = new DirtyItemsMemory(), resolver = new Resolver();
    resolver.sources.set("items", 'iteminfo "c\xff" { name "n\xfe" model "m\xfd" }');
    const config = loadItemConfig(resolver, "items", { memory, maxItems: 1 });
    const item = required(config.items[0]), bytes = required(memory.blocks[0]).bytes;
    expect([item.classname, item.name, item.model]).toEqual(["c\xff", "n\xfe", "m\xfd"]);
    expect(Array.from(bytes.subarray(8, 11))).toEqual([99, 255, 0]);
    expect(Array.from(bytes.subarray(40, 43))).toEqual([110, 254, 0]);
    expect(item.modelIndex).toBe(0);
    expect(item.respawnTime).toBe(0);
  });

  test("config source frees include storage and root storage before loaded publication", () => {
    const memory = new GoalMemory();
    const resolver = new Resolver();
    resolver.sources.set("items", '#include "fields"\niteminfo "health" {}');
    resolver.sources.set("fields", "#define UNUSED 1\n");
    const config = loadItemConfig(resolver, "items", { memory, preprocessor: { memory }, report: diagnostic => {
      if (diagnostic.severity === "message") {
        expect(() => required(memory.blocks[0]).bytes).toThrow("freed");
        expect(() => required(memory.blocks[5]).bytes).toThrow("freed");
      }
      return undefined;
    } });
    expect(config.items[0]?.classname).toBe("health");
    const releaseOrder = [6, 5, 9, 10, 1, 0, 8, 7, 3, 2];
    expect(memory.freed).toHaveLength(releaseOrder.length);
    for (const [index, block] of releaseOrder.entries()) expect(memory.freed[index]).toBe(memory.blocks[block]);
  });

  test("config errors report before frees and the classname source-record free retains scripts", () => {
    for (const source of ['unknown {}', 'iteminfo "health" { bad 1 }', 'iteminfo health {}', '#if 1\niteminfo health {}\n#endif\n']) {
      const memory = new GoalMemory(), resolver = new Resolver();
      const tokenFrees = source.startsWith("#if") ? [5, 6] : source.includes('"health"') ? [5] : [];
      resolver.sources.set("items", source);
      expect(() => loadItemConfig(resolver, "items", { memory, preprocessor: { memory }, report: diagnostic => {
        if (diagnostic.severity === "error") expect(memory.freed).toEqual(tokenFrees.map(index => required(memory.blocks[index])));
        return undefined;
      } })).toThrow(ScriptLanguageError);
      if (source.includes('iteminfo health {}')) {
        expect(memory.freed).toHaveLength(tokenFrees.length + 2);
        expect(memory.freed[tokenFrees.length]).toBe(memory.blocks[4]);
        expect(memory.freed[tokenFrees.length + 1]).toBe(memory.blocks[2]);
        expect(() => required(memory.blocks[2]).bytes).toThrow("freed");
        expect(required(memory.blocks[0]).bytes.length).toBeGreaterThan(2148);
        expect(required(memory.blocks[1]).bytes).toHaveLength(1024);
        expect(required(memory.blocks[3]).bytes).toHaveLength(4096);
        if (source.startsWith("#if")) expect(required(memory.blocks[7]).bytes).toHaveLength(16);
      } else {
        const releaseOrder = [...tokenFrees, 4, 1, 0, 3, 2];
        expect(memory.freed).toHaveLength(releaseOrder.length);
        for (const [index, block] of releaseOrder.entries()) expect(memory.freed[index]).toBe(memory.blocks[block]);
      }
    }
  });

  test("config warnings report before later token reads and are not replayed on failure", () => {
    const memory = new GoalMemory(), resolver = new Resolver();
    resolver.sources.set("items", '#pragma ignored\niteminfo "health" { bad 1 }');
    const diagnostics: string[] = [];
    expect(() => loadItemConfig(resolver, "items", {
      memory, preprocessor: { memory }, report: diagnostic => {
        diagnostics.push(diagnostic.severity);
        if (diagnostic.severity === "warning") {
          expect(memory.freed).toEqual([]);
          expect(memory.blocks).toHaveLength(5);
        } else if (diagnostic.severity === "error") {
          expect(memory.freed).toEqual([required(memory.blocks[5]), required(memory.blocks[6])]);
        }
        return undefined;
      },
    })).toThrow("unknown structure field bad");
    expect(diagnostics).toEqual(["warning", "error"]);
    const releaseOrder = [5, 6, 4, 1, 0, 3, 2];
    expect(memory.freed).toHaveLength(releaseOrder.length);
    for (const [index, block] of releaseOrder.entries()) expect(memory.freed[index]).toBe(memory.blocks[block]);
  });

  test("config diagnostic and allocation aborts retain the reached source storage", () => {
    const diagnostic = { severity: "error", message: "callback abort", location: { path: "callback", line: 1, column: 1 } } satisfies ConstructorParameters<typeof ScriptLanguageError>[0];
    const aborted = new ScriptLanguageError(diagnostic, [diagnostic]);
    for (const duringPreprocessing of [false, true]) {
      const memory = new GoalMemory(), resolver = new Resolver();
      resolver.sources.set("items", duringPreprocessing ? "iteminfo\n#error stop\n" : "unknown {}");
      let thrown: unknown;
      try {
        loadItemConfig(resolver, "items", {
          memory,
          preprocessor: { memory, report: () => { if (duringPreprocessing) throw aborted; } },
          report: () => { throw aborted; },
        });
      } catch (error) { thrown = error; }
      expect(thrown).toBe(aborted);
      expect(memory.events.some(event => event.startsWith("free"))).toBe(false);
      expect(required(memory.blocks[0]).bytes.length).toBeGreaterThan(2148);
    }
    const memory = new GoalMemory(), resolver = new Resolver();
    resolver.sources.set("items", "");
    const allocate = memory.allocate.bind(memory);
    memory.allocate = (size, kind, clear) => {
      if (kind === "hunk") throw aborted;
      return allocate(size, kind, clear);
    };
    expect(() => loadItemConfig(resolver, "items", { memory, preprocessor: { memory } })).toThrow(aborted);
    expect(memory.blocks).toHaveLength(4);
    expect(memory.events.some(event => event.startsWith("free"))).toBe(false);
  });

  test("stack sentinel, float32 goals and avoidance consume the actual state bytes", () => {
    const zone = new ZoneArena(8192), memory = new GoalMemory(undefined, zone);
    const { library, runtime } = fixture(memory), handle = library.allocGoalState(123);
    const block = required(memory.blocks[0]), bytes = block.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    expect(memory.events).toEqual(["allocate heap 2516 true"]);
    expect(view.getInt32(8, true)).toBe(123);
    library.pushGoal(handle, { ...goal(5), origin: vec3(0.1, -0, 16777217) });
    expect(view.getInt32(464, true)).toBe(1);
    expect([...bytes.subarray(16, 72)]).toEqual(Array.from({ length: 56 }, () => 0));
    expect(view.getInt32(116, true)).toBe(5);
    expect(library.getTopGoal(handle)?.origin).toEqual(vec3(Math.fround(0.1), -0, 16777216));
    view.setInt32(116, 77, true);
    expect(library.getTopGoal(handle)?.number).toBe(77);
    library.emptyGoalStack(handle);
    expect(view.getInt32(116, true)).toBe(77);
    view.setInt32(464, 1, true);
    expect(library.getTopGoal(handle)?.number).toBe(77);
    runtime.time = 1;
    library.setAvoidGoalTime(handle, 21, 0.1);
    expect(view.getInt32(468, true)).toBe(21);
    expect(view.getFloat32(1492, true)).toBe(Math.fround(1 + Math.fround(0.1)));
    view.setInt32(468, 22, true); view.setFloat32(1492, 10, true);
    expect(library.avoidGoalTime(handle, 22)).toBe(9);
    view.setInt32(12, 9, true);
    library.resetGoalState(handle);
    expect(bytes.subarray(16).every(value => value === 0)).toBe(true);
    expect(view.getInt32(12, true)).toBe(9);
    library.freeGoalState(handle);
    expect(() => block.bytes).toThrow("freed");
    expect(zone.memoryRemaining()).toBe(8192);
    expect(library.allocGoalState(321)).toBe(handle);
    expect(library.getTopGoal(handle)).toBeNull();
    library.shutdown(); zone.checkHeap(); zone.dispose();
  });
  test("item selection reads allocated weight indexes and frees them before the state", () => {
    const zone = new ZoneArena(8192), memory = new GoalMemory(undefined, zone);
    const { library, runtime } = fixture(memory);
    library.setup();
    const handle = library.allocGoalState(0), state = required(memory.blocks.at(-1));
    expect(library.loadItemWeights(handle, "weights.c")).toBe(0);
    const indexes = required(memory.blocks.at(-1)), bytes = indexes.bytes;
    expect(bytes.length).toBe(4);
    const indexView = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const stateView = new DataView(state.bytes.buffer, state.bytes.byteOffset, state.bytes.length);
    expect(stateView.getUint32(0, true)).toBeGreaterThan(0);
    expect(stateView.getUint32(4, true)).toBeGreaterThan(0);
    const world = mapFixture([mapEntity("item_health", "100 0 20")]);
    runtime.maxLevelItems = 1;
    library.initLevelItems(world); world.entities.set(1, entityInfo(vec3(100, 0, 15)));
    library.updateEntityItems(); runtime.time = 1;
    indexView.setInt32(0, -1, true);
    expect(library.chooseLTGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT)).toBe(false);
    indexView.setInt32(0, 0, true);
    expect(library.chooseLTGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT)).toBe(true);
    memory.events.length = 0;
    library.freeGoalState(handle);
    expect(memory.events).toEqual(["free 4", "free 2516"]);
    expect(() => indexes.bytes).toThrow("freed"); expect(() => state.bytes).toThrow("freed");
    expect(zone.memoryRemaining()).toBeLessThan(8192);
    library.shutdown(); expect(zone.memoryRemaining()).toBe(8192); zone.checkHeap(); zone.dispose();
  });
  test("failed index allocation retains the loaded weight pointer and an empty index pointer", () => {
    const zone = new ZoneArena(2576), memory = new GoalMemory(undefined, zone);
    const { library, runtime } = fixture(memory);
    library.setup();
    const handle = library.allocGoalState(0), state = required(memory.blocks.at(-1));
    expect(() => library.loadItemWeights(handle, "weights.c")).toThrow("Z_Malloc");
    const view = new DataView(state.bytes.buffer, state.bytes.byteOffset, state.bytes.length);
    expect(view.getUint32(0, true)).toBeGreaterThan(0);
    expect(view.getUint32(4, true)).toBe(0);
    library.mutateGoalFuzzyLogic(handle);
    expect(runtime.randomCalls).toBeGreaterThan(0);
    library.shutdown(); expect(zone.memoryRemaining()).toBe(2576); zone.dispose();
  });
  test("item-weight source failures return the source code while callback aborts retain the prior state", () => {
    for (const callbackAbort of [false, true]) {
      const memory = new GoalMemory(), { library, resolver } = fixture(memory);
      library.setup();
      const handle = library.allocGoalState(0), state = required(memory.blocks.at(-1));
      expect(library.loadItemWeights(handle, "weights.c")).toBe(GoalError.None);
      const indexes = required(memory.blocks.at(-1));
      const view = new DataView(state.bytes.buffer, state.bytes.byteOffset, state.bytes.length);
      const oldWeight = view.getUint32(0, true), oldIndexes = view.getUint32(4, true);
      const aborted = new ScriptLanguageError({ severity: "error", message: "host callback abort",
        location: { path: "host.c", line: 1, column: 1 } }, []);
      resolver.sources.set("bad.c", callbackAbort
        ? 'weight "item_health" return\n#include "host.c"'
        : 'weight "item_health" return $evalfloat(FS_ARMOR);');
      resolver.beforeRead = path => { if (path === "host.c") throw aborted; };
      let result: number | null = null, thrown: unknown = null;
      try { result = library.loadItemWeights(handle, "bad.c"); }
      catch (error) { thrown = error; }
      if (callbackAbort) {
        expect(thrown).toBe(aborted);
        expect(result).toBeNull();
        expect(view.getUint32(0, true)).toBe(oldWeight);
      } else {
        expect(thrown).toBeNull();
        expect(result).toBe(GoalError.CannotLoadItemWeights);
        expect(view.getUint32(0, true)).toBe(0);
        expect(library.diagnostics.at(-1)?.message).toBe("couldn't load weights\n");
      }
      expect(view.getUint32(4, true)).toBe(oldIndexes);
      expect(indexes.bytes.length).toBe(4);
      library.shutdown();
    }
  });
  test("empty configurations allocate a zero-length index block and repeated loads retain the overwritten block", () => {
    const zone = new ZoneArena(8192), memory = new GoalMemory(undefined, zone);
    const { library, resolver } = fixture(memory);
    resolver.sources.set("items.c", ""); library.setup();
    const handle = library.allocGoalState(0);
    expect(library.loadItemWeights(handle, "weights.c")).toBe(0);
    const first = required(memory.blocks.at(-1));
    expect(first.bytes.length).toBe(0);
    expect(library.loadItemWeights(handle, "weights.c")).toBe(0);
    const second = required(memory.blocks.at(-1));
    expect(second).not.toBe(first);
    library.freeItemWeights(handle);
    expect(() => second.bytes).toThrow("freed");
    expect(first.bytes.length).toBe(0);
    library.shutdown();
    expect(zone.memoryRemaining()).toBeLessThan(8192);
    // The source overwrites itemweightindex without freeing the old pointer.
    memory.free(first); expect(zone.memoryRemaining()).toBe(8192); zone.checkHeap(); zone.dispose();
  });
  test("shutdown frees handles in numeric order after reuse", () => {
    const zone = new ZoneArena(16384), memory = new GoalMemory(undefined, zone);
    const { library } = fixture(memory);
    const first = library.allocGoalState(1);
    library.allocGoalState(2); library.freeGoalState(first); library.allocGoalState(3);
    const secondState = required(memory.blocks[1]), reusedState = required(memory.blocks[2]);
    const freed: BotMemoryAllocation[] = [];
    const free = memory.free.bind(memory);
    memory.free = allocation => { freed.push(allocation); free(allocation); };
    library.shutdown();
    expect(freed[0]).toBe(reusedState); expect(freed[1]).toBe(secondState);
    expect(zone.memoryRemaining()).toBe(16384); zone.checkHeap(); zone.dispose();
  });
});

describe("goal map heap storage", () => {
  test("level list links, live fields and expired-slot reuse consume the contiguous heap", () => {
    const zone = new ZoneArena(8192), memory = new GoalMemory(undefined, zone);
    const { library, runtime } = fixture(memory);
    runtime.maxLevelItems = 4; library.setup();
    const world = mapFixture([mapEntity("item_health", "100 0 20"), mapEntity("item_health", "200 0 20")]);
    library.initLevelItems(world);
    const heap = required(memory.blocks.at(-1)), bytes = heap.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    expect(bytes.length).toBe(240);
    expect(view.getInt32(0, true)).toBe(1); expect(view.getInt32(60, true)).toBe(2);
    expect(view.getUint32(52, true)).toBe(2); expect(view.getUint32(56, true)).toBe(0);
    expect(view.getUint32(112, true)).toBe(0); expect(view.getUint32(116, true)).toBe(1);
    expect(view.getUint32(176, true)).toBe(4); expect(view.getUint32(236, true)).toBe(0);
    view.setInt32(60, 77, true); view.setFloat32(92, 0.1, true); view.setInt32(88, 19, true);
    expect(library.getLevelItemGoal(-1, "Health")?.number).toBe(77);
    expect(library.getLevelItemGoal(-1, "Health")?.origin.x).toBe(Math.fround(0.1));
    expect(library.getLevelItemGoal(-1, "Health")?.area).toBe(19);
    view.setUint32(116, 0, true);
    expect(library.getLevelItemGoal(77, "Health")).toBeNull();
    view.setUint32(116, 1, true);
    world.entities.set(1, entityInfo(vec3(100, 0, 15))); world.entities.set(2, entityInfo(vec3(200, 0, 15)));
    world.entities.set(9, entityInfo(vec3(500, 0, 15))); runtime.time = 1;
    library.updateEntityItems();
    expect(view.getInt32(120, true)).toBe(11); expect(view.getInt32(164, true)).toBe(9);
    expect(view.getFloat32(168, true)).toBe(31);
    world.entities.delete(9); runtime.time = 32; library.updateEntityItems();
    expect(view.getUint32(176, true)).toBe(4);
    view.setInt32(128, -1, true); view.setFloat32(132, 99, true);
    world.entities.set(10, entityInfo(vec3(600, 0, 15))); library.updateEntityItems();
    expect(view.getInt32(120, true)).toBe(12); expect(view.getInt32(164, true)).toBe(10);
    expect(view.getInt32(128, true)).toBe(0); expect(view.getFloat32(132, true)).toBe(0);
    expect(view.getFloat32(168, true)).toBe(62);
    library.shutdown(); expect(() => heap.bytes).toThrow("freed");
    expect(zone.memoryRemaining()).toBe(8192); zone.checkHeap(); zone.dispose();
  });
  test("info records allocate before area callbacks, read live names and links, and free in source order", () => {
    const zone = new ZoneArena(8192), memory = new GoalMemory(undefined, zone);
    const { resolver, store } = fixture(memory);
    const library = new BotGoalLibrary({ memory, resolver, weightStore: store, log: { write: () => {} }, clock: () => 0,
      random: { nextInt: () => 0 }, gameType: () => 0, report: diagnostic => { memory.events.push(diagnostic.message.trim()); return undefined; } });
    const world = mapFixture([
      mapEntity("target_location", "1 2 3", [["message", "First"]]),
      mapEntity("info_camp", "2 3 4", [["message", "Camp"], ["range", "0.1"], ["weight", "2"], ["wait", "3"], ["random", "4"]]),
      mapEntity("target_location", "3 4 5", [["message", "Last"]]),
      mapEntity("info_camp", "4 5 6"),
      mapEntity("info_camp", "999 -0.25 0.25"),
    ]);
    world.pointArea = origin => {
      const block = required(memory.blocks.at(-1)), bytes = block.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      expect(view.getFloat32(0, true)).toBe(origin.x);
      expect(view.getInt32(12, true)).toBe(0);
      memory.events.push(`area ${origin.x}`);
      return origin.x === 999 ? 0 : origin.x;
    };
    library.initInfoEntities(world);
    expect(memory.events).toEqual(["allocate heap 148 true", "area 1", "allocate heap 164 true", "area 2",
      "allocate heap 148 true", "area 3", "allocate heap 164 true", "area 4", "allocate heap 164 true", "area 999",
      "camp spot at 999.0 -0.2 0.2 in solid", "free 164"]);
    const first = required(memory.blocks[0]), camp = required(memory.blocks[1]), last = required(memory.blocks[2]);
    const lastCamp = required(memory.blocks[3]), solidCamp = required(memory.blocks[4]);
    const lastView = new DataView(last.bytes.buffer, last.bytes.byteOffset, last.bytes.length);
    const campView = new DataView(camp.bytes.buffer, camp.bytes.byteOffset, camp.bytes.length);
    expect(campView.getFloat32(144, true)).toBe(Math.fround(0.1));
    expect(campView.getFloat32(148, true)).toBe(2); expect(campView.getFloat32(152, true)).toBe(3); expect(campView.getFloat32(156, true)).toBe(4);
    expect(lastView.getUint32(144, true)).toBe(1);
    last.bytes[16] = 80; lastView.setInt32(12, 17, true); lastView.setFloat32(0, 0.1, true);
    expect(library.getMapLocationGoal("Past")?.area).toBe(17);
    expect(library.getMapLocationGoal("Past")?.origin.x).toBe(Math.fround(0.1));
    lastView.setUint32(144, 0, true); expect(library.getMapLocationGoal("First")).toBeNull(); lastView.setUint32(144, 1, true);
    expect(library.getNextCampSpotGoal(0)?.goal.area).toBe(4); expect(library.getNextCampSpotGoal(1)?.goal.area).toBe(2);
    expect(() => solidCamp.bytes).toThrow("freed");
    const freed: BotMemoryAllocation[] = [], free = memory.free.bind(memory);
    memory.free = allocation => { freed.push(allocation); free(allocation); };
    library.freeInfoEntities();
    expect(freed[0]).toBe(last); expect(freed[1]).toBe(first); expect(freed[2]).toBe(lastCamp); expect(freed[3]).toBe(camp);
    expect(library.getMapLocationGoal("Past")).toBeNull(); expect(library.getNextCampSpotGoal(0)).toBeNull();
    expect(zone.memoryRemaining()).toBe(8192); zone.checkHeap(); zone.dispose();
  });
  test("a reached floor-trace abort retains the allocated item and its preceding field writes", () => {
    const zone = new ZoneArena(2048), memory = new GoalMemory(undefined, zone);
    const { library, runtime } = fixture(memory);
    runtime.maxLevelItems = 1; library.setup();
    const world = mapFixture([mapEntity("item_health", "100 0 20", [["notteam", "1"]])]);
    const trace = world.host.trace;
    world.host.trace = () => {
      const heap = required(memory.blocks.at(-1)), bytes = heap.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      expect(bytes.length).toBe(60); expect(view.getInt32(0, true)).toBe(1); expect(view.getInt32(8, true)).toBe(2);
      expect(view.getFloat32(16, true)).toBe(0); expect(view.getInt32(44, true)).toBe(0);
      throw new Error("stop at floor trace");
    };
    expect(() => library.initLevelItems(world)).toThrow("stop at floor trace");
    expect(library.getLevelItemGoal(-1, "Health")).toBeNull();
    world.host.trace = trace; world.entities.set(9, entityInfo(vec3(500, 0, 15)));
    library.updateEntityItems();
    expect(library.diagnostics.at(-1)?.message).toBe("out of level items\n");
    library.shutdown(); expect(zone.memoryRemaining()).toBe(2048); zone.checkHeap(); zone.dispose();
  });
  test("level heap replacement frees before the limit read and allocation failure keeps source partial ownership", () => {
    const zone = new ZoneArena(2048), memory = new GoalMemory(undefined, zone);
    const { resolver, store } = fixture(memory);
    let maximum = 2, previous: BotMemoryAllocation | null = null;
    const library = new BotGoalLibrary({ memory, resolver, weightStore: store, log: { write: () => {} }, clock: () => 0,
      random: { nextInt: () => 0 }, gameType: () => 0, maxLevelItems: () => {
        if (previous !== null) expect(() => previous?.bytes).toThrow("freed");
        memory.events.push("limit"); return maximum;
      } });
    const world = mapFixture([]);
    library.initLevelItems(world); previous = required(memory.blocks.at(-1));
    memory.events.length = 0; maximum = 3; library.initLevelItems(world);
    expect(memory.events).toEqual(["free 120", "limit", "allocate heap 180 true"]);
    previous = required(memory.blocks.at(-1)); memory.events.length = 0; maximum = 100;
    expect(() => library.initLevelItems(world)).toThrow("Z_Malloc");
    expect(memory.events).toEqual(["free 180", "limit", "allocate heap 6000 true"]);
    expect(() => previous?.bytes).toThrow("freed"); expect(zone.memoryRemaining()).toBe(2048);
    // Source assignment never replaces the old pointer when allocation aborts.
    expect(() => library.shutdown()).toThrow("freed"); zone.checkHeap(); zone.dispose();
  });
});

describe("goal handles, stacks and avoidance", () => {
  test("stores nonfinite avoid durations and skips NaN in source comparisons", () => {
    const { library, runtime } = fixture(), handle = library.allocGoalState(0);
    runtime.time = 1;
    library.setAvoidGoalTime(handle, 1, NaN);
    expect(library.avoidGoalTime(handle, 1)).toBe(0);
    expect(library.dumpAvoidGoals(handle)).toEqual([]);
    library.setAvoidGoalTime(handle, 2, Infinity);
    expect(library.avoidGoalTime(handle, 2)).toBe(Infinity);
    expect(library.dumpAvoidGoals(handle)).toEqual([{ number: 2, remaining: Infinity }]);
  });
  test("push increments the retained stack top before reading the source goal", () => {
    const { library } = fixture(), handle = library.allocGoalState(0);
    library.pushGoal(handle, goal(1));
    const failure = new Error("goal source read failed");
    expect(() => library.pushGoal(handle, () => {
      expect(library.getSecondGoal(handle)).toEqual(goal(1));
      throw failure;
    })).toThrow(failure);
    expect(library.getSecondGoal(handle)).toEqual(goal(1));
    expect(library.dumpGoalStack(handle)).toHaveLength(2);
  });
  test("lowest-free handles, copied seven-entry stacks, and invalid-handle diagnostics", () => {
    const { library } = fixture();
    for (let handle = 1; handle <= 64; handle++) expect(library.allocGoalState(handle + 100)).toBe(handle);
    expect(library.allocGoalState(0)).toBe(0);
    library.freeGoalState(3);
    expect(library.allocGoalState(7)).toBe(3);
    for (let number = 1; number <= 8; number++) library.pushGoal(3, goal(number));
    expect(library.dumpGoalStack(3)).toHaveLength(7);
    expect(library.getTopGoal(3)).toEqual(goal(7));
    expect(library.getSecondGoal(3)).toEqual(goal(6));
    const original = goal(30);
    library.emptyGoalStack(3);
    library.pushGoal(3, original);
    expect(library.getTopGoal(3)).not.toBe(original);
    expect(library.getTopGoal(3)?.origin).not.toBe(original.origin);
    library.popGoal(3); library.popGoal(3);
    expect(library.getSecondGoal(3)).toBeNull();
    expect(library.getTopGoal(65)).toBeNull();
    expect(library.getTopGoal(0)).toBeNull();
    library.freeGoalState(3);
    expect(library.getTopGoal(3)).toBeNull();
    expect(library.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(["error", "fatal", "fatal", "fatal"]);
  });
  test("source strict expiration, zero-number special case, float32 duration and full list", () => {
    const { library, runtime } = fixture();
    const handle = library.allocGoalState(0);
    library.setAvoidGoalTime(handle, 5, 10);
    expect(library.avoidGoalTime(handle, 5)).toBe(0);
    expect(library.dumpAvoidGoals(handle)).toHaveLength(256);
    library.setAvoidGoalTime(handle, 0, 10);
    expect(library.avoidGoalTime(handle, 0)).toBe(10);
    library.resetAvoidGoals(handle);
    runtime.time = 1;
    for (let number = 1; number <= MAX_AVOID_GOALS; number++) library.setAvoidGoalTime(handle, number, 2);
    library.setAvoidGoalTime(handle, 300, 10);
    expect(library.avoidGoalTime(handle, 300)).toBe(0);
    runtime.time = 3;
    library.setAvoidGoalTime(handle, 300, 10);
    expect(library.avoidGoalTime(handle, 300)).toBe(0);
    library.removeFromAvoidGoals(handle, 1);
    library.setAvoidGoalTime(handle, 300, 0.1);
    expect(library.avoidGoalTime(handle, 300)).toBe(Math.fround(Math.fround(3 + Math.fround(0.1)) - 3));
    library.setAvoidGoalTime(handle, 2, 9);
    expect(library.avoidGoalTime(handle, 2)).toBe(9);
    library.resetGoalState(handle);
    expect(library.avoidGoalTime(handle, 2)).toBe(0);
  });
  test("setup snapshots game type and reads current definition limit", async () => {
    const { library, runtime } = fixture();
    runtime.gameType = 4;
    expect(await library.setup()).toBe(GoalError.None);
    runtime.gameType = 1;
    expect(library.gameType).toBe(4);
    runtime.maxItemInfo = 0;
    expect(await library.setup()).toBe(GoalError.CannotLoadItemConfig);
    runtime.maxItemInfo = -1;
    expect(await library.setup()).toBe(GoalError.None);
    expect(runtime.maxItemInfo).toBe(256);
    expect(library.gameType).toBe(1);
  });
});

describe("weight ownership and synchronous reentry", () => {
  test("reset preserves weights, mutation ignores range, save performs no I/O", () => {
    const { library, runtime, resolver } = fixture();
    expect(library.setup()).toBe(0);
    const handle = library.allocGoalState(1);
    expect(library.loadItemWeights(handle, "weights.c")).toBe(0);
    library.resetGoalState(handle);
    library.mutateGoalFuzzyLogic(handle, Number.NaN);
    expect(runtime.randomCalls).toBeGreaterThan(0);
    const reads = [...resolver.reads];
    library.saveGoalFuzzyLogic(handle, "never-written.c");
    expect(resolver.reads).toEqual(reads);
    library.freeItemWeights(handle); library.freeItemWeights(handle);
    library.mutateGoalFuzzyLogic(handle, 0);
    expect(library.diagnostics.at(-1)?.message).toContain("requires loaded");
  });
  test("reentrant shutdown cannot publish the previous source setup", () => {
    const { library, resolver } = fixture();
    resolver.beforeRead = () => { resolver.beforeRead = () => {}; library.shutdown(); };
    expect(library.setup()).toBe(10);
    expect(library.itemConfig).toBeNull();
    expect(library.setup()).toBe(0);
  });
  test("reentrant weights cannot occupy a reused handle; the shared store survives shutdown", () => {
    const { library, resolver, store } = fixture();
    library.setup();
    const external = store.load("weights.c");
    const handle = library.allocGoalState(1);
    resolver.sources.set("slow.c", WEIGHT_SOURCE);
    resolver.beforeRead = path => {
      if (path !== "slow.c") return;
      resolver.beforeRead = () => {}; library.shutdown();
      expect(library.allocGoalState(2)).toBe(handle);
    };
    expect(library.loadItemWeights(handle, "slow.c")).toBe(9);
    expect(external.evaluate(0, [0])).toBe(10);
    library.mutateGoalFuzzyLogic(handle, 0);
    expect(library.diagnostics.at(-1)?.message).toContain("requires loaded");
    store.free(external);
  });
  test("synchronous reentrant loads publish when each read returns", () => {
    const { library, resolver, runtime } = fixture();
    library.setup();
    const handle = library.allocGoalState(1);
    resolver.sources.set("first.c", 'weight "unmatched" { return balance(10, 1, 20); }'); resolver.sources.set("second.c", WEIGHT_SOURCE);
    resolver.beforeRead = path => {
      if (path !== "first.c") return;
      resolver.beforeRead = () => {};
      expect(library.loadItemWeights(handle, "second.c")).toBe(0);
    };
    expect(library.loadItemWeights(handle, "first.c")).toBe(0);
    const world = mapFixture([mapEntity("item_health", "100 0 20")]);
    library.initLevelItems(world);
    world.entities.set(1, entityInfo(vec3(100, 0, 15)));
    library.updateEntityItems();
    expect(library.chooseLTGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT)).toBe(false);
    library.mutateGoalFuzzyLogic(handle, 0);
    expect(runtime.randomCalls).toBeGreaterThan(0);
    library.shutdown();
  });
  test("map replacement preserves caller weights and current loading ownership", () => {
    const { library, resolver, runtime } = fixture();
    library.setup();
    const handle = library.allocGoalState(0);
    library.pushGoal(handle, goal(99));
    resolver.sources.set("map-current.c", WEIGHT_SOURCE);
    resolver.beforeRead = path => {
      if (path !== "map-current.c") return;
      library.initLevelItems(mapFixture([mapEntity("item_health", "100 0 20")]));
      library.initLevelItems(mapFixture([]));
    };
    expect(library.loadItemWeights(handle, "map-current.c")).toBe(0);
    expect(library.getTopGoal(handle)?.number).toBe(99);
    library.mutateGoalFuzzyLogic(handle, 0);
    expect(runtime.randomCalls).toBeGreaterThan(0);
    library.shutdown();
  });
});

describe("map items and real AAS selection", () => {
  test("item setup logs source model, classname and jumppad diagnostics in order", () => {
    const { library, resolver, log } = fixture();
    resolver.sources.set("items.c", ITEM_SOURCE + ' iteminfo "unmodelled" {}');
    expect(library.setup()).toBe(GoalError.None);
    const world = mapFixture([
      mapEntity("unknown", "100 0 20"),
      mapEntity("item_health", "100 0 200", [["spawnflags", "1"]]),
    ]);
    world.host.trace = (_start, end) => {
      expect(log).toEqual([
        "item unmodelled has modelindex 0",
        "entity unknown unknown item\r\n",
      ]);
      return clearTrace(end);
    };
    library.initLevelItems(world);
    expect(log).toEqual([
      "item unmodelled has modelindex 0",
      "entity unknown unknown item\r\n",
      "item item_health reachable from jumppad area 0\r\n",
    ]);
    expect(library.getLevelItemGoal(-1, "Health")).toBeNull();
    log.length = 0;
    library.initLevelItems({ ...world, navigation: null });
    expect(log).toEqual([]);
  });

  test("registration prepends items, filters game modes and preserves prior output fields", async () => {
    const { library, runtime } = fixture();
    await library.setup();
    const world = mapFixture([
      mapEntity("item_health", "100 0 20"), mapEntity("item_health", "200 0 20", [["notfree", "1"]]),
      mapEntity("item_health", "300 0 20", [["notbot", "1"]]), mapEntity("item_health", "400 0 20"),
      mapEntity("target_location", "100 0 20", [["message", "First"]]), mapEntity("target_location", "-100 0 20", [["message", "FIRST"]]),
      mapEntity("info_camp", "100 0 20"), mapEntity("info_camp", "-100 0 20"),
    ]);
    library.initLevelItems(world);
    const prior = { ...goal(99), flags: 77, itemInfo: 42 };
    const top = required(library.getLevelItemGoal(-1, "HEALTH", prior));
    expect(top.number).toBe(4); expect(top.itemInfo).toBe(42); expect(top.flags).toBe(GoalFlags.Item);
    expect(library.getLevelItemGoal(4, "Health")?.number).toBe(1);
    expect(library.getLevelItemGoal(1, "Health")).toBeNull();
    expect(library.getLevelItemGoal(0, "Health")).toBeNull();
    expect(library.goalName(2)).toBe("Health");
    expect(library.getMapLocationGoal("first", prior)).toMatchObject({ area: 2, origin: vec3(-100, 0, 20), number: 99, flags: 77, itemInfo: 42 });
    expect(library.getMapLocationGoal("first")).toMatchObject({ number: 0, flags: 0, itemInfo: 0 });
    expect(library.getNextCampSpotGoal(-1, prior)).toMatchObject({ next: 1, goal: { area: 2, number: 99 } });
    expect(library.getNextCampSpotGoal(1)?.goal.area).toBe(1);
    expect(library.getNextCampSpotGoal(2)).toBeNull();
    const handle = library.allocGoalState(0);
    runtime.time = 1;
    library.setAvoidGoalTime(handle, 1, -1);
    expect(library.avoidGoalTime(handle, 1)).toBe(35);
    library.initLevelItems(mapFixture([]));
    expect(library.getLevelItemGoal(-1, "Health")).toBeNull();
    expect(library.getMapLocationGoal("first")).toBeNull();
    expect(library.avoidGoalTime(handle, 1)).toBe(35);
  });
  test("stationary entity linking, source last-match lookup, dropped expiry and reused model numbers", async () => {
    const { library, runtime, resolver } = fixture();
    resolver.sources.set("items.c", ITEM_SOURCE + ' iteminfo "armor" { name "Armor" modelindex 6 mins {-15,-15,-15} maxs {15,15,15} }');
    await library.setup();
    const world = mapFixture([mapEntity("item_health", "100 0 20")]);
    library.initLevelItems(world);
    world.entities.set(4, entityInfo(vec3(100, 0, 15))); world.entities.set(8, entityInfo(vec3(110, 0, 15)));
    library.findEntityForLevelItem(1);
    expect(library.getLevelItemGoal(-1, "Health")?.entity).toBe(8);
    library.initLevelItems(world);
    library.updateEntityItems();
    expect(library.getLevelItemGoal(-1, "Health")).toMatchObject({ number: 9, entity: 8, flags: 5 });
    expect(library.getLevelItemGoal(9, "Health")).toMatchObject({ number: 1, entity: 4 });
    world.entities.clear(); runtime.time = 30;
    library.updateEntityItems();
    expect(library.goalName(9)).toBe("Health");
    runtime.time = 30.001; library.updateEntityItems();
    expect(library.goalName(9)).toBe("");
    world.entities.set(4, entityInfo(vec3(100, 0, 15), 6));
    library.updateEntityItems();
    expect(library.goalName(1)).toBe("");
    expect(library.getLevelItemGoal(-1, "Armor")).toMatchObject({ number: 5, entity: 4, flags: 5 });
  });
  test("LTG ties follow list order, avoidance alternates and NBG time bound is strict", async () => {
    const { library, runtime } = fixture();
    await library.setup();
    const handle = library.allocGoalState(0);
    await library.loadItemWeights(handle, "weights.c");
    const world = mapFixture([mapEntity("item_health", "100 0 20"), mapEntity("item_health", "200 0 20")]);
    library.initLevelItems(world);
    const origin = vec3(50, 0, 20);
    expect(library.chooseLTGItem(handle, origin, [0], TravelFlags.DEFAULT)).toBe(false);
    world.entities.set(1, entityInfo(vec3(100, 0, 15))); world.entities.set(2, entityInfo(vec3(200, 0, 15)));
    library.updateEntityItems(); runtime.time = 1;
    expect(library.chooseNBGItem(handle, origin, [0], TravelFlags.DEFAULT, null, NaN)).toBe(false);
    expect(library.chooseNBGItem(handle, origin, [0], TravelFlags.DEFAULT, null, 1)).toBe(false);
    expect(library.chooseLTGItem(handle, origin, [0], TravelFlags.DEFAULT)).toBe(true);
    expect(library.getTopGoal(handle)?.number).toBe(2);
    expect(library.avoidGoalTime(handle, 2)).toBe(35);
    expect(library.chooseLTGItem(handle, origin, [0], TravelFlags.DEFAULT)).toBe(true);
    expect(library.getTopGoal(handle)?.number).toBe(1);
    expect(library.chooseLTGItem(handle, origin, [0], TravelFlags.DEFAULT)).toBe(false);
    library.resetAvoidGoals(handle);
    expect(library.chooseNBGItem(handle, origin, [0], TravelFlags.DEFAULT, null, 2)).toBe(true);
    expect(library.getTopGoal(handle)?.number).toBe(2);
    library.resetAvoidGoals(handle);
    for (let i = 0; i < 8; i++) library.pushGoal(handle, goal(99));
    expect(library.chooseLTGItem(handle, origin, [0], TravelFlags.DEFAULT)).toBe(true);
    expect(library.getTopGoal(handle)?.number).toBe(99);
    expect(library.avoidGoalTime(handle, 2)).toBe(35);
  });
  test("live dropped bonus, roam multiplication and capacity diagnostics", async () => {
    const { library, runtime, resolver } = fixture();
    resolver.sources.set("items.c", ITEM_SOURCE + ' iteminfo "item_botroam" { name "Roam" }');
    resolver.sources.set("weights.c", WEIGHT_SOURCE + ' weight "item_botroam" { return 20; }');
    await library.setup();
    const handle = library.allocGoalState(0); await library.loadItemWeights(handle, "weights.c");
    const world = mapFixture([mapEntity("item_botroam", "100 0 20", [["weight", "2"]])]);
    library.initLevelItems(world); runtime.time = 1;
    world.entities.set(8, entityInfo(vec3(200, 0, 15))); library.updateEntityItems();
    runtime.droppedWeight = 0;
    expect(library.chooseLTGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT)).toBe(true);
    expect(library.getTopGoal(handle)).toMatchObject({ number: 1, flags: 3 });
    library.resetAvoidGoals(handle); runtime.droppedWeight = 1000;
    expect(library.chooseLTGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT)).toBe(true);
    expect(library.getTopGoal(handle)).toMatchObject({ number: 9, flags: 5 });
    expect(library.avoidGoalTime(handle, 9)).toBe(10);
    runtime.maxLevelItems = 1;
    library.initLevelItems(world); library.updateEntityItems();
    expect(library.diagnostics.at(-1)?.message).toBe("out of level items\n");
  });
  test("LTG and NBG skip fuzzy NaN from source float32 mutation overflow", () => {
    const memory = new GoalMemory();
    const { library, resolver, runtime } = fixture(undefined, memory);
    resolver.sources.set("weights.c", 'weight "item_health" return balance(1, 0, 1);');
    expect(library.setup()).toBe(GoalError.None);
    const handle = library.allocGoalState(0);
    expect(library.loadItemWeights(handle, "weights.c")).toBe(GoalError.None);
    const separator = required(memory.blocks.find(block => block.bytes.length === 32));
    const bytes = separator.bytes, fields = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    fields.setFloat32(12, 3e38, true);
    fields.setFloat32(20, 3e38, true);
    const world = mapFixture([mapEntity("item_health", "100 0 20")]);
    library.initLevelItems(world);
    world.entities.set(1, entityInfo(vec3(100, 0, 15)));
    library.updateEntityItems();
    runtime.time = 1;
    // Two -1 mutations leave bounds [-3e38, 3e38]. Undecided evaluation then
    // computes -3e38 + 0 * Infinity, and the source's weight > 0 rejects NaN.
    library.mutateGoalFuzzyLogic(handle);
    library.mutateGoalFuzzyLogic(handle);
    expect(runtime.randomCalls).toBe(4);
    expect(library.chooseLTGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT)).toBe(false);
    expect(library.chooseNBGItem(handle, vec3(50, 0, 20), [0], TravelFlags.DEFAULT, null, 100)).toBe(false);
    expect(runtime.randomCalls).toBe(6);
    expect(library.getTopGoal(handle)).toBeNull();
    expect(library.avoidGoalTime(handle, 1)).toBe(0);
  });

  test("NBG preserves source acceptance of an unreachable return leg", async () => {
    const { library } = fixture(); await library.setup();
    const handle = library.allocGoalState(0); await library.loadItemWeights(handle, "weights.c");
    const base = mapFixture([mapEntity("item_health", "-100 0 15", [["spawnflags", "1"]])]);
    const original = base.spatial.world;
    const oneWay: AasWorld = { ...original, areaSettings: original.areaSettings.map((settings, area) => area === 2 ? { ...settings, reachableAreaCount: 0 } : settings), areaReachabilities: area => area === 2 ? [] : original.areaReachabilities(area) };
    const spatial = new AasSpatial(oneWay, base.bspEntities, base.host, DEFAULT_AAS_MOVEMENT_SETTINGS, base.modelTypes, base.links, { kind: "disabled" }, () => 0), routing = new AasRouting(oneWay);
    routing.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 0);
    const world = { ...base, spatial, routing, navigation: { spatial, routing }, pointArea: (point: Vec3) => oneWay.pointArea(point) };
    library.initLevelItems(world); world.entities.set(1, entityInfo(vec3(-100, 0, 15))); library.updateEntityItems();
    const candidate = required(library.getLevelItemGoal(-1, "Health"));
    expect(world.routing.route({ area: 2, origin: candidate.origin, goalArea: 1, travelFlags: TravelFlags.DEFAULT }).kind).toBe("unreachable");
    expect(library.chooseNBGItem(handle, vec3(100, 0, 15), [0], TravelFlags.DEFAULT, { ...goal(99), area: 1 }, 99999)).toBe(true);
    expect(library.getTopGoal(handle)?.number).toBe(1);
  });
  test("touching uses normal player bounds and visibility traces the source minimum corner", async () => {
    const { library, runtime } = fixture(); await library.setup();
    const world = mapFixture([]); library.initLevelItems(world);
    const item = goal(100);
    expect(touchingGoal(vec3(84, 2, 3), item)).toBe(true);
    expect(touchingGoal(vec3(83.99, 2, 3), item)).toBe(false);
    world.entities.set(item.entity, entityInfo(item.origin)); runtime.time = 1;
    expect(library.itemGoalInVisButNotVisible(9, vec3(0, 0, 0), vec3(9, 9, 9), item)).toBe(true);
    expect(world.traceTargets.at(-1)).toEqual(vec3(99, 0, 0));
    runtime.time = 0.5;
    expect(library.itemGoalInVisButNotVisible(9, vec3(0, 0, 0), vec3(0, 0, 0), item)).toBe(false);
  });
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const nativeOracle = process.env["Q3_GOAL_ORACLE"];
const oracleTest = nativeOracle === undefined ? test.skip : test;
oracleTest("native LTG/NBG decisions with prepared item records and real routing times", async () => {
  if (nativeOracle === undefined) throw new Error("oracle path required");
  const commands = ["0 0", "1 1"], expected = ["1"];
  for (let scenario = 0; scenario < 96; scenario++) {
    const { library, resolver, runtime } = fixture();
    runtime.time = 1; runtime.gameType = required([0, 2, 3, 4][scenario % 4]);
    runtime.droppedWeight = scenario % 3 === 0 ? -100 : scenario % 3 === 1 ? 0 : 1000;
    const respawn = scenario % 3 === 0 ? 0 : scenario % 3 === 1 ? 3 : Math.fround(35.1);
    resolver.sources.set("items.c", `iteminfo "item_health" { name "Health" modelindex 5 respawntime ${respawn} mins {-15,-15,-15} maxs {15,15,15} } iteminfo "armor" { name "Armor" modelindex 6 respawntime 25 mins {-15,-15,-15} maxs {15,15,15} } iteminfo "item_botroam" { name "Roam" }`);
    resolver.sources.set("weights.c", 'weight "item_health" { return 10; } weight "armor" { return 25; } weight "item_botroam" { return 20; }');
    await library.setup();
    const handle = library.allocGoalState(0); await library.loadItemWeights(handle, "weights.c");
    const notBot = scenario % 5 === 0 ? 8 : 0;
    const roamModeFlag = required([0, 1, 2, 4][scenario % 4]);
    const roamKey = required(["unused", "notfree", "notteam", "notsingle"][scenario % 4]);
    const roamWeight = Math.fround((scenario % 7) / 3);
    const world = mapFixture([
      mapEntity("item_health", "100 0 15", [["spawnflags", "1"], ["notbot", notBot === 0 ? "0" : "1"]]),
      mapEntity("armor", "-100 0 15", [["spawnflags", "1"]]),
      mapEntity("item_botroam", "100 0 15", [["spawnflags", "1"], ["weight", String(roamWeight)], [roamKey, "1"]]),
    ]);
    library.initLevelItems(world);
    world.entities.set(1, entityInfo(vec3(100, 0, 15))); world.entities.set(2, entityInfo(vec3(-100, 0, 15), 6)); world.entities.set(7, entityInfo(vec3(-100, 0, 15)));
    library.updateEntityItems();
    commands.push(`11 ${runtime.gameType} ${runtime.droppedWeight}`, `12 0 ${respawn} 10`, "12 1 25 25", "12 2 0 20");
    const health = required(library.getLevelItemGoal(-1, "Health"));
    expect(health.number).toBe(10);
    const armor = required(library.getLevelItemGoal(-1, "Armor"));
    const healthPosition = world.spatial.bestReachableArea(vec3(100, 0, 15), { min: vec3(-15, -15, -15), max: vec3(15, 15, 15) });
    const roamPosition = world.spatial.bestReachableArea(vec3(100, 0, 15), { min: vec3(0, 0, 0), max: vec3(0, 0, 0) });
    const addNativeItem = (number: number, info: number, flags: number, weight: number, area: number, entity: number, timeout: number, origin: Vec3) => commands.push(`13 ${number} ${info} ${flags} ${weight} ${area} ${entity} ${timeout} ${origin.x} ${origin.y} ${origin.z}`);
    addNativeItem(1, 0, notBot, 0, 1, 1, 0, healthPosition.origin);
    addNativeItem(2, 1, 0, 0, 2, 2, 0, armor.origin);
    addNativeItem(3, 2, 16 | roamModeFlag, roamWeight, 1, 0, 0, roamPosition.origin);
    addNativeItem(10, 0, 0, 0, 2, 7, 31, health.origin);
    const flags = scenario % 8 === 0 ? 0 : TravelFlags.DEFAULT;
    for (const from of [1, 2]) for (const to of [1, 2]) {
      const origin = from === 1 ? healthPosition.origin : armor.origin;
      const route = world.routing.route({ area: from, origin, goalArea: to, travelFlags: flags });
      commands.push(`14 ${from} ${to} ${route.kind === "found" ? route.travelTime : 0}`);
    }
    const near = scenario % 2 !== 0, ltgArea = scenario % 3, maxTime = required([1, 50, 200, 99999][scenario % 4]);
    const ltg = ltgArea === 0 ? null : { ...goal(99), area: ltgArea };
    for (let choice = 0; choice < 4; choice++) {
      const found = near ? library.chooseNBGItem(handle, healthPosition.origin, [0], flags, ltg, maxTime) : library.chooseLTGItem(handle, healthPosition.origin, [0], flags);
      const selected = library.getTopGoal(handle);
      commands.push(`15 ${near ? 1 : 0} ${flags} ${ltgArea} ${maxTime} ${healthPosition.origin.x} ${healthPosition.origin.y} ${healthPosition.origin.z}`);
      expected.push(`${found ? 1 : 0} ${selected?.number ?? 0} ${selected?.flags ?? 0} ${selected?.itemInfo ?? 0}`);
    }
    library.shutdown();
  }
  const process = Bun.spawn([nativeOracle], { stdin: new Blob([commands.join("\n") + "\n"]), stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(process.stdout).text(), stderr = await new Response(process.stderr).text();
  expect(await process.exited, stderr).toBe(0);
  expect(stdout.trim().split("\n")).toEqual(expected);
});
oracleTest("seeded stack and avoidance operations match unchanged native be_ai_goal.c", async () => {
  if (nativeOracle === undefined) throw new Error("oracle path required");
  const { library, runtime } = fixture();
  const commands: string[] = [], expected: string[] = [];
  const handle = library.allocGoalState(7);
  commands.push("0 7"); expected.push(String(handle));
  let seed = 0x77334411;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const floatBits = (value: number) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
  for (let iteration = 0; iteration < 2000; iteration++) {
    const choice = random() % 9, number = random() % 280;
    if (choice === 0) {
      runtime.time = Math.fround(iteration / 73);
      commands.push(`1 ${runtime.time}`);
    } else if (choice < 4) {
      const duration = Math.fround((random() % 100) / 13);
      commands.push(`2 ${handle} ${number} ${duration}`);
      library.setAvoidGoalTime(handle, number, duration);
    } else if (choice === 4) {
      commands.push(`4 ${handle} ${number}`); library.removeFromAvoidGoals(handle, number);
    } else if (choice === 5) {
      commands.push(`5 ${handle} ${number}`); library.pushGoal(handle, goal(number));
    } else if (choice === 6) {
      commands.push(`9 ${handle}`); library.popGoal(handle);
    } else if (choice === 7) {
      commands.push(`7 ${handle}`); library.resetGoalState(handle);
    } else {
      commands.push(`6 ${handle}`);
      const top = library.getTopGoal(handle); expected.push(top === null ? "0 0" : `1 ${top.number}`);
    }
    commands.push(`3 ${handle} ${number}`); expected.push(String(floatBits(library.avoidGoalTime(handle, number))));
  }
  const process = Bun.spawn([nativeOracle], { stdin: new Blob([commands.join("\n") + "\n"]), stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  expect(await process.exited, stderr).toBe(0);
  expect(stdout.trim().split("\n")).toEqual(expected);
});
const retailTest = existsSync(dataPath) ? test : test.skip;
for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  retailTest(`installed ${product} item config and item weights`, async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const resolver = new BotScriptSources(vfs, new ScriptGlobalDefines(), (_severity, text) => { throw new Error(text); }, (_text: string): undefined => undefined);
    const config = await loadItemConfig(resolver, "items.c");
    expect(config.items.length).toBeGreaterThan(30);
    expect(config.items.some(item => item.classname === "item_health")).toBe(true);
    expect(config.items.some(item => item.classname === "weapon_rocketlauncher")).toBe(true);
    const store = new WeightConfigStore(resolver);
    const weights = await store.load("bots/sarge_i.c");
    expect(weights.find("item_health")).toBeGreaterThanOrEqual(0);
    store.shutdown();
  });
  for (const map of product === "baseq3" ? ["q3dm1", "q3dm17"] : ["mpteam1", "mpteam4"]) {
  retailTest(`installed ${product}/${map} registration, collision placement and item routing`, async () => {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const resolver = new BotScriptSources(vfs, new ScriptGlobalDefines(), (_severity, text) => { throw new Error(text); }, (_text: string): undefined => undefined);
    const store = new WeightConfigStore(resolver);
    const log: string[] = [];
    const library = new BotGoalLibrary({ resolver, weightStore: store, log: { write: text => { log.push(text); } }, clock: () => 1, gameType: () => product === "baseq3" ? 0 : 4, random: { nextInt: () => 0 } });
    expect(await library.setup()).toBe(0);
    const bsp = parseBsp(await vfs.read(`maps/${map}.bsp`));
    const aas = parseAas(await vfs.read(`maps/${map}.aas`));
    const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
    const entities = new Map<number, GoalEntityInfo>();
    const messages: string[] = [];
    const host: GoalWorldHost & AasSpatialHost = {
      print: text => { messages.push(text); },
      trace: (start, end, bounds, _pass, mask) => ({ ...collision.trace({ start, end, shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }), entityNum: 1022 }),
      pointContents: point => collision.pointContents(point),
      entityTrace: () => { throw new Error("retail fixture contains only non-solid item entities"); },
      entityModelIndex: number => entities.get(number)?.modelIndex ?? 0,
      modelBounds: index => ({ bounds: collision.modelBounds(index), origin: vec3(0, 0, 0) }),
      nextEntity: after => [...entities.keys()].find(number => number > after) ?? 0,
      entityInfo: number => required(entities.get(number)),
    };
    const bspEntities = new AasBspEntities((_severity, text) => { host.print(text); });
    bspEntities.load(bsp.entities);
    const spatial = new AasSpatial(aas, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
    const routing = new AasRouting(aas);
    library.initLevelItems({ bspEntities, navigation: { spatial, routing }, host, pointArea: point => aas.pointArea(point) });
    spatial.setBrushModelTypes(host.print);
    routing.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 0);
    let number = 1;
    const config = required(library.itemConfig);
    for (const entity of bsp.entityRecords) {
      const item = config.items.find(info => info.classname === entity.get("classname"));
      const coordinates = entity.get("origin")?.trim().split(/\s+/).map(Number);
      if (item === undefined || coordinates === undefined || item.modelIndex === 0) continue;
      const origin = vec3(required(coordinates[0]), required(coordinates[1]), required(coordinates[2]));
      const stationary = (Number(entity.get("spawnflags") ?? 0) & 1) !== 0 ? origin : spatial.dropToFloor(origin, { min: item.mins, max: item.maxs }).origin;
      entities.set(number++, entityInfo(stationary, item.modelIndex, 2, 1));
    }
    library.updateEntityItems();
    const handle = library.allocGoalState(0);
    expect(await library.loadItemWeights(handle, "bots/sarge_i.c")).toBe(0);
    const inventory = Array.from({ length: 256 }, () => 0);
    const starts = bsp.entityRecords.filter(entity => entity.get("classname") === "info_player_deathmatch").slice(0, 12);
    expect(starts.length).toBeGreaterThan(0);
    let choices = 0;
    for (const start of starts) {
      const coordinates = required(start.get("origin")).trim().split(/\s+/).map(Number);
      const origin = vec3(required(coordinates[0]), required(coordinates[1]), required(coordinates[2]));
      library.resetGoalState(handle);
      if (!library.chooseLTGItem(handle, origin, inventory, TravelFlags.DEFAULT)) continue;
      choices++;
      const chosen = required(library.getTopGoal(handle));
      expect(chosen.entity).toBeGreaterThan(0);
      expect(chosen.area).toBeGreaterThan(0);
      expect(library.goalName(chosen.number)).not.toBe("");
      const area = spatial.reachabilityArea(origin, 0);
      expect(routing.route({ area, origin, goalArea: chosen.area, travelFlags: TravelFlags.DEFAULT }).kind).toBe("found");
      library.resetAvoidGoals(handle);
      expect(library.chooseNBGItem(handle, origin, inventory, TravelFlags.DEFAULT, chosen, 99999)).toBe(true);
    }
    expect(choices).toBeGreaterThan(0);
    library.shutdown(); store.shutdown();
  });
  }
}
