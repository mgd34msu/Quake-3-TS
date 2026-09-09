import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { parseAas } from "../src/botlib/aas.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { AasRuntime } from "../src/botlib/aas-runtime.ts";
import type { AasMapInput, AasMapSpatialHost, AasRuntimeMap } from "../src/botlib/aas-runtime.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import type { BotEntityUpdate } from "../src/botlib/entity.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import { TravelFlags, TravelType } from "../src/botlib/routing.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { radiusFromBounds, vec3 } from "../src/core/math.ts";
import { blockChecksum } from "../src/core/md4.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { EntityPool } from "../src/game/entities.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { Product } from "../src/shared/definitions.ts";

const checksum = -123456789;
const zero = vec3(0, 0, 0);
const fixtureReads: { readonly directory: string; readonly handles: SourceFileHandles }[] = [];

afterEach(() => {
  for (const fixture of fixtureReads.splice(0)) {
    fixture.handles.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture(version: 4 | 5 = 4, areaFlags = 1): Uint8Array {
  const lumps: Uint8Array[] = Array.from({ length: 14 }, () => new Uint8Array(0));
  function put(index: number, write: (writer: BinaryWriter) => void): void {
    const writer = new BinaryWriter(256); write(writer); lumps[index] = writer.finish();
  }
  function vector(writer: BinaryWriter, x: number, y = 0, z = 0): void { writer.f32(x); writer.f32(y); writer.f32(z); }
  put(1, writer => vector(writer, 0));
  put(2, writer => { vector(writer, 1); writer.f32(0); writer.i32(0); });
  put(3, writer => { writer.i32(0); writer.i32(0); });
  put(5, writer => writer.bytes(new Uint8Array(24)));
  put(7, writer => {
    for (let area = 0; area < 3; area++) {
      writer.i32(area); writer.i32(0); writer.i32(0);
      vector(writer, -100, -100, -100); vector(writer, 100, 100, 100); vector(writer, area === 1 ? 30 : -30);
    }
  });
  put(8, writer => {
    for (let area = 0; area < 3; area++) {
      writer.i32(0); writer.i32(areaFlags); writer.i32(2); writer.i32(area === 0 ? 0 : 1);
      writer.i32(area === 2 ? 1 : 0); writer.i32(area === 1 ? 1 : 0); writer.i32(area === 0 ? 0 : area);
    }
  });
  put(9, writer => {
    writer.bytes(new Uint8Array(44));
    writer.i32(2); writer.i32(0); writer.i32(0); vector(writer, 1); vector(writer, -1);
    writer.i32(TravelType.WALK); writer.u16(10); writer.u16(0xbeef);
  });
  put(10, writer => {
    writer.bytes(new Uint8Array(12)); writer.i32(0); writer.i32(-1); writer.i32(-2);
  });
  put(13, writer => {
    writer.bytes(new Uint8Array(16)); writer.i32(2); writer.i32(2); writer.i32(0); writer.i32(0);
  });
  const output = new BinaryWriter(124 + lumps.reduce((total, lump) => total + lump.length, 0));
  output.u32(0x53414145); output.i32(version); output.i32(checksum);
  let offset = 124;
  for (const lump of lumps) { output.i32(offset); output.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) output.bytes(lump);
  const bytes = output.finish();
  if (version === 5) {
    for (const [index, byte] of bytes.subarray(8, 124).entries()) bytes[8 + index] = byte ^ ((index * 119) & 255);
  }
  return bytes;
}

function bsp(text: string): BspMap {
  return { entities: text, entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [], leafSurfaces: [], leafBrushes: [],
    models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}

function loadedMap(aas: AasRuntime): AasRuntimeMap {
  const phase = aas.phase;
  if (phase.kind !== "loaded" && phase.kind !== "ready") throw new Error("Expected a loaded test map");
  return phase.map;
}

class RuntimeMemory extends BotMemory {
  readonly entities: BotMemoryAllocation[] = [];
  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const allocation = super.allocate(size, kind, clear);
    if (kind === "hunk" && size === 4 * 148) this.entities.push(allocation);
    return allocation;
  }
}

function runtime(print: (text: string) => undefined = () => undefined, writeAvailable = true, memory?: BotMemory,
  commonPrint: (text: string) => undefined = text => { throw new Error(`Unexpected common print: ${text}`); }) {
  const variables = new BotLibVars();
  variables.set("maxentities", "4"); variables.set("sv_mapChecksum", String(checksum));
  const messages: string[] = [], files = new Map([["maps/one.aas", fixture(5)], ["maps/two.aas", fixture()]]);
  const writeRequests: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "quake3-aas-runtime-read-")), handles = new SourceFileHandles();
  fixtureReads.push({ directory, handles });
  const debug = new BotDebugPolygons(); debug.initialize(2);
  const debugLines = new AasDebugLines(debug, text => { messages.push(text); });
  const aas = new AasRuntime({ ...(memory === undefined ? {} : { memory }), variables, print: (_severity, text) => { messages.push(text); return print(text); },
    commonPrint,
    log: { write: text => { messages.push(text); } }, developer: () => false, milliseconds: () => 0,
    permanentLine: (start, end, color) => { debug.permanentLine(start, end, color); }, movementDebug: debugLines.movement,
    openWrite: filename => {
      writeRequests.push(filename);
      if (!writeAvailable) return null;
      let cursor = 0, content = new Uint8Array(0);
      files.set(filename, content);
      return {
        writeBytes: bytes => {
          const next = new Uint8Array(Math.max(content.length, cursor + bytes.length));
          next.set(content); next.set(bytes, cursor); content = next; cursor += bytes.length;
          files.set(filename, content);
          return bytes.length;
        },
        seek: (offset, origin) => {
          if (origin !== "set") throw new Error("This AAS fixture only expects absolute seek");
          cursor = offset; return 0;
        },
        close: () => { messages.push(`closed ${filename}\n`); },
      };
    } });
  const unavailable = (): never => { throw new Error("This fixture does not provide BSP collision"); };
  const spatialHost: AasSpatialHost = { print: text => { messages.push(text); }, trace: unavailable,
    pointContents: unavailable, entityTrace: unavailable, entityModelIndex: unavailable, modelBounds: unavailable };
  function input(name: string | null = "one", text = '{ "marker" "1" }'): AasMapInput {
    return { name, bsp: bsp(text), spatialHost, assets: {
      readSync: path => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error(`Asset not found: ${path}`);
        return bytes;
      },
      openRead: path => {
        const bytes = files.get(path);
        if (bytes === undefined) return undefined;
        const file = handles.selectFree(), filename = join(directory, `handle-${file.slot}.bin`);
        writeFileSync(filename, bytes);
        handles.setName(file, path); handles.attachLooseRead(file, openSync(filename, "r"));
        handles.setReadMode(file, bytes.length);
        return { file, length: bytes.length };
      },
      readInto: (file, bytes) => handles.readInto(file, bytes),
      seekFile: (file, offset, origin) => handles.seek(file, offset, origin),
      closeFile: file => { handles.closeFile(file); },
    } };
  }
  return { aas, variables, messages, files, input, writeRequests, handles };
}

function entity(): BotEntityUpdate {
  return { type: 4, flags: 0, origin: vec3(30, 0, 0), angles: zero, oldOrigin: zero, mins: vec3(-1, -1, -1), maxs: vec3(1, 1, 1),
    groundEntity: 1022, solid: 2, modelIndex: 1, modelIndex2: 0, frame: 0, event: 0, eventParameter: 0,
    powerups: 0, weapon: 0, legsAnimation: 0, torsoAnimation: 0 };
}

test("AAS and route-cache filename warnings precede reads and writes at the 64-byte boundary", () => {
  for (const length of [54, 55]) {
    const name = "é".repeat(length);
    const aasFilename = `maps/${name}${length === 54 ? ".aas" : ".aa"}`;
    const cacheFilename = `maps/${name}${length === 54 ? ".rcd" : ".rc"}`;
    const events: string[] = [];
    const { aas, input, files, variables, writeRequests } = runtime(text => {
      events.push(text);
    }, true, undefined, text => { events.push(`common:${text}`); });
    files.set(aasFilename, fixture());
    const map = input(name + "\0ignored");
    const assets: AasMapInput["assets"] = { ...map.assets,
      readSync: path => { events.push(`read:${path}`); return map.assets.readSync(path); },
      openRead: path => { events.push(`open:${path}`); return map.assets.openRead(path); },
    };
    expect(aas.loadMap({ ...map, assets })).toBe(0);
    expect(aas.name).toBe(name);
    expect(aas.filename).toBe(aasFilename);
    expect(events.slice(0, length === 54 ? 2 : 3)).toEqual([
      ...(length === 54 ? [] : ["common:Com_sprintf: overflow of 64 in 64\n"]),
      `trying to load ${aasFilename}\n`, `open:${aasFilename}`,
    ]);
    events.length = 0;
    aas.startFrame(1);
    expect(events.slice(-2 - (length === 54 ? 0 : 1))).toEqual([
      ...(length === 54 ? [] : ["common:Com_sprintf: overflow of 64 in 64\n"]),
      `open:${cacheFilename}`, "AAS initialized.\n",
    ]);
    events.length = 0;
    variables.set("saveroutingcache", "1");
    aas.startFrame(2);
    expect(events[0]).toBe(length === 54 ? `\nroute cache written to ${cacheFilename}\n` : "common:Com_sprintf: overflow of 64 in 64\n");
    expect(writeRequests).toEqual([cacheFilename]);
    expect(files.has(cacheFilename)).toBe(true);
    expect(variables.getValue("saveroutingcache")).toBe(0);
  }
});

test("an AAS filename warning abort retains the new name and BSP but does not unload the old data", () => {
  const failure = new CommonError("drop", "AAS filename warning aborted");
  const name = "a".repeat(55);
  const { aas, input, messages } = runtime(() => undefined, true, undefined, text => {
    expect(text).toBe("Com_sprintf: overflow of 64 in 64\n");
    expect(aas.name).toBe(name);
    expect(aas.filename).toBe("maps/one.aas");
    expect(aas.entities.entityAreas(1)).toEqual([]);
    expect(aas.bspEntities.int(1, "marker").value).toBe(2);
    throw failure;
  });
  aas.loadMap(input()); aas.startFrame(1); aas.updateEntity(1, entity());
  const old = loadedMap(aas);
  messages.length = 0;
  const next = input(name, '{ "marker" "2" }');
  expect(() => aas.loadMap({ ...next, assets: { ...next.assets,
    openRead: () => { throw new Error("AAS read must follow the warning"); },
  } })).toThrow(failure);
  expect(loadedMap(aas)).toBe(old);
  expect(aas.phase.kind).toBe("loaded");
  expect(messages).not.toContain(`trying to load maps/${name}.aa\n`);
  expect(old.world.areas).toHaveLength(3);
});

test("route-cache reads use the retained source map name after an interrupted replacement", () => {
  const failure = new CommonError("drop", "route-cache filename warning aborted");
  const name = "b".repeat(55);
  const events: string[] = [];
  let interrupt = true;
  const { aas, input } = runtime(() => undefined, true, undefined, text => {
    events.push(text);
    if (interrupt) throw failure;
  });
  const first = input();
  aas.loadMap({ ...first, assets: { ...first.assets,
    openRead: path => { events.push(`open:${path}`); return first.assets.openRead(path); },
  } });
  expect(() => aas.loadMap(input(name))).toThrow(failure);
  const old = loadedMap(aas);
  expect(old.name).toBe("one");
  expect(aas.name).toBe(name);
  events.length = 0;
  expect(() => aas.startFrame(1)).toThrow(failure);
  expect(events).toEqual(["Com_sprintf: overflow of 64 in 64\n"]);
  expect(aas.initialized).toBe(false);
  expect(aas.frameNumber()).toBe(0);
  interrupt = false;
  events.length = 0;
  aas.startFrame(2);
  expect(events).toEqual(["Com_sprintf: overflow of 64 in 64\n", `open:maps/${name}.rc`]);
  expect(aas.initialized).toBe(true);
});

test("route-cache writes count before filename warnings and serialize live records after the open", () => {
  const name = "c".repeat(55), filename = `maps/${name}.rc`;
  const failure = new CommonError("drop", "route-cache save warning aborted");
  let stage: "load" | "abort" | "add-cache" = "load";
  const { aas, input, files, variables, writeRequests } = runtime(() => undefined, true, undefined, () => {
    if (stage === "abort") throw failure;
    if (stage === "add-cache") {
      expect(writeRequests).toEqual([]);
      expect(loadedMap(aas).routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2,
        travelFlags: TravelFlags.DEFAULT })).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
    }
  });
  files.set(`maps/${name}.aa`, fixture());
  aas.loadMap(input(name)); aas.startFrame(1);
  variables.set("saveroutingcache", "1");
  stage = "abort";
  expect(() => aas.startFrame(2)).toThrow(failure);
  expect(writeRequests).toEqual([]);
  expect(variables.getValue("saveroutingcache")).toBe(1);
  expect(aas.frameNumber()).toBe(1);
  stage = "add-cache";
  aas.startFrame(3);
  const bytes = files.get(filename);
  if (bytes === undefined) throw new Error("Missing route cache output");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(header.getInt32(24, true)).toBe(0);
  expect(header.getInt32(28, true)).toBe(0);
  expect(bytes.length).toBeGreaterThan(32);
  expect(loadedMap(aas).routing.cacheStatistics.entries).toBe(1);
  expect(writeRequests).toEqual([filename]);
  expect(variables.getValue("saveroutingcache")).toBe(0);
});

test("AAS load, first frame, actual routing and omitted observations use one history and clock", () => {
  const { aas, input, variables } = runtime();
  expect(aas.updateEntity(1, entity())).toBe(3);
  expect(variables.get("max_aaslinks")).toBeNull();
  expect(aas.loadMap(input())).toBe(0);
  expect(aas.linkHeap.capacity).toBe(6144);
  const map = loadedMap(aas);
  expect(aas.initialized).toBe(false);
  expect(variables.get("max_routingcache")).toBeNull();
  expect(variables.get("bot_visualizejumppads")).toBeNull();
  expect(map.spatial.bestReachableFromJumpPadArea(zero, { min: zero, max: zero })).toBe(0);
  expect(variables.getString("bot_visualizejumppads")).toBe("0");
  expect(map.routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT })).toEqual({ kind: "unreachable" });
  aas.startFrame(1 / 3);
  expect(aas.initialized).toBe(true);
  expect(aas.time()).toBe(Math.fround(1 / 3));
  expect(aas.frameNumber()).toBe(1);
  expect(map.routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT }))
    .toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  expect(map.routing.frameRoutingUpdates).toBe(1);
  aas.updateEntity(1, entity());
  expect(aas.entities.entityAreas(1)).toEqual([1]);
  aas.startFrame(2);
  expect(map.routing.frameRoutingUpdates).toBe(0);
  expect(aas.entities.info(1).valid).toBe(false);
  expect(aas.entities.entityAreas(1)).toEqual([1]);
  aas.startFrame(3);
  expect(aas.entities.entityAreas(1)).toEqual([]);
});

test("map replacement retires links and caches before the AAS read and retains BSP failure residue", () => {
  const { aas, input, variables } = runtime();
  aas.loadMap(input()); aas.startFrame(1); aas.updateEntity(1, entity());
  const old = loadedMap(aas), history = aas.entities;
  expect(aas.linkHeap.freeCount).toBe(6143);
  variables.set("max_aaslinks", "2");
  old.routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT });
  const second = input("missing", '{ "marker" "2" }');
  const observations: { initialized: boolean; loaded: boolean; caches: number; links: readonly number[]; marker: number }[] = [];
  expect(aas.loadMap({ ...second, assets: { ...second.assets, openRead: () => {
    observations.push({ initialized: aas.initialized, loaded: aas.loaded, caches: old.routing.cacheStatistics.entries,
      links: aas.entities.entityAreas(1), marker: aas.bspEntities.int(1, "marker").value });
    return undefined;
  } } })).toBe(4);
  expect(observations).toEqual([{ initialized: false, loaded: false, caches: 0, links: [], marker: 2 }]);
  expect(aas.phase.kind).toBe("unloaded");
  expect(aas.entities).toBe(history);
  expect(aas.entities.entityOrigin(1)).toEqual(vec3(30, 0, 0));
  expect(aas.filename).toBe("maps/one.aas");
  expect(aas.linkHeap.freeCount).toBe(6143);
  expect(aas.loadMap(input("two"))).toBe(0);
  expect(aas.linkHeap.capacity).toBe(6144);
  expect(aas.linkHeap.freeCount).toBe(6144);
  expect(loadedMap(aas)).not.toBe(old);
  expect(aas.entities).toBe(history);
});

test("retained movement settings publish the source prefix across failed map load and survive shutdown", () => {
  const { aas, input, variables } = runtime();
  aas.loadMap(input());
  const firstMovement = loadedMap(aas).spatial.movement, settings = firstMovement.settings;
  settings.gravityDirection = vec3(1, 2, 3);
  variables.set("phys_friction", "2.25"); variables.set("phys_stopspeed", "50");
  variables.set("phys_gravity", "600"); variables.set("phys_maxvelocity", "123");
  const value = variables.value.bind(variables), reads: string[] = [];
  variables.value = (name, initial) => {
    reads.push(name);
    if (name === "phys_gravity") throw new Error("settings read interrupted");
    return value(name, initial);
  };
  expect(() => aas.loadMap(input("two"))).toThrow("settings read interrupted");
  expect(aas.phase.kind).toBe("data-loaded");
  expect(reads).toEqual(["phys_friction", "phys_stopspeed", "phys_gravity"]);
  expect(settings.gravityDirection).toEqual(vec3(0, 0, -1));
  expect([settings.friction, settings.stopSpeed, settings.gravity, settings.maxVelocity]).toEqual([2.25, 50, 800, 320]);
  variables.value = value;
  aas.shutdown(); aas.setup();
  expect(aas.loadMap(input("two"))).toBe(0);
  expect(loadedMap(aas).spatial.movement.settings).toBe(settings);
  expect(settings.gravity).toBe(600);
  expect(firstMovement.horizontalVelocityForJump(270, zero, vec3(0, 0, 10000))).toEqual({ success: false, velocity: 123 });
  const other = runtime(); other.aas.loadMap(other.input());
  expect(loadedMap(other.aas).spatial.movement.settings).not.toBe(settings);
  expect(loadedMap(other.aas).spatial.movement.settings.maxVelocity).toBe(320);
  variables.set("phys_gravity", "500");
  expect(aas.loadMap(input())).toBe(0);
  expect(loadedMap(aas).spatial.movement.settings).toBe(settings);
  expect(settings.gravity).toBe(500);
});

test("retry after a data-loaded abort resets retained heads before reading and keeps history and settings", () => {
  const memory = new RuntimeMemory();
  let interrupt = true;
  const failure = new CommonError("drop", "test loaded-map retry");
  const { aas, input } = runtime(text => {
    if (interrupt && text === "loaded maps/two.aas\n") throw failure;
    return undefined;
  }, true, memory);
  const allocation = memory.entities[0];
  if (allocation === undefined) throw new Error("Missing runtime entity allocation");
  const bytes = allocation.bytes, records = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  aas.loadMap(input()); aas.startFrame(1); aas.updateEntity(1, entity());
  const old = loadedMap(aas), history = aas.entities, settings = old.spatial.movement.settings;
  old.routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT });
  expect(aas.entities.entityAreas(1)).toEqual([1]);
  expect(records.getInt32(148 + 140, true)).toBe(1);
  records.setInt32(148 + 144, 17, true);
  expect(() => aas.loadMap(input("two"))).toThrow(failure);
  expect(aas.phase.kind).toBe("data-loaded");
  expect(aas.entities.entityAreas(1)).toEqual([]);
  expect(records.getInt32(148 + 140, true)).toBe(0);
  expect(records.getInt32(148 + 144, true)).toBe(0);
  expect(aas.linkHeap.freeCount).toBe(6143);
  records.setInt32(148 + 140, 1, true); records.setInt32(148 + 144, 29, true);
  expect(history.entityAreas(1)).toEqual([1]);
  interrupt = false;
  const retry = input("two"); let reads = 0;
  expect(aas.loadMap({ ...retry, assets: { ...retry.assets, openRead: path => {
    reads++;
    expect(aas.loaded).toBe(false);
    expect(aas.entities).toBe(history);
    expect(aas.entities.entityAreas(1)).toEqual([]);
    expect(records.getInt32(148 + 140, true)).toBe(0);
    expect(records.getInt32(148 + 144, true)).toBe(0);
    expect(aas.linkHeap.freeCount).toBe(6143);
    expect(old.routing.cacheStatistics.entries).toBe(0);
    expect(history.entityOrigin(1)).toEqual(vec3(30, 0, 0));
    return retry.assets.openRead(path);
  } } })).toBe(0);
  expect(reads).toBe(1);
  expect(loadedMap(aas).spatial.movement.settings).toBe(settings);
  expect(aas.entities).toBe(history);
  expect(aas.linkHeap.freeCount).toBe(6144);
  aas.startFrame(2);
  expect(aas.initialized).toBe(true);
  expect(loadedMap(aas).routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT }))
    .toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  aas.updateEntity(1, { ...entity(), origin: vec3(31, 0, 0) });
  expect(records.getInt32(148 + 140, true)).toBe(1);
  expect(history.entityAreas(1)).toEqual([1]);
});

test("AAS header and lump failures return source error numbers without restoring the old map", () => {
  for (const [offset, value, expected] of [[0, 0, 5], [4, 9, 6], [8, 0, 6], [12, 0x7fffffff, 7]]) {
    if (offset === undefined || value === undefined || expected === undefined) throw new Error("Incomplete corruption case");
    const { aas, files, input } = runtime();
    aas.loadMap(input()); aas.startFrame(1);
    const corrupt = fixture();
    new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength).setInt32(offset, value, true);
    files.set("maps/two.aas", corrupt);
    expect(aas.loadMap(input("two"))).toBe(expected);
    expect(aas.phase.kind).toBe("unloaded");
  }
});

test("incremental reachability publishes into the borrowed world and clusters only after its storing frame", () => {
  const { aas, variables, input, messages, files, writeRequests } = runtime();
  files.set("maps/one.aas", fixture(5, 0));
  variables.set("forcereachability", "1"); aas.loadMap(input());
  const map = loadedMap(aas), world = map.world;
  if (!(world instanceof AasWorldState)) throw new Error("Runtime did not install its canonical mutable world");
  expect(map.spatial.world).toBe(world);
  expect(world.areaReachabilities(1)).toHaveLength(1);
  expect(world.numReachabilityAreas).toBe(1);
  expect(world.saveFile).toBe(true);
  aas.startFrame(1);
  expect(world.numReachabilityAreas).toBe(2);
  aas.startFrame(2);
  expect(world.numReachabilityAreas).toBe(4);
  aas.startFrame(3);
  expect(world.numReachabilityAreas).toBe(5);
  expect(world.areaReachabilities(1)).toEqual([]);
  expect(world.reachability).toHaveLength(1);
  expect(world.reachabilityRecord(0).padding).toBe(0);
  expect(world.numClusters).toBe(2);
  expect(aas.initialized).toBe(false);
  expect(writeRequests).toEqual([]);
  expect(variables.get("max_routingcache")).toBeNull();
  aas.startFrame(4);
  expect(aas.initialized).toBe(true);
  expect(loadedMap(aas).world).toBe(world);
  expect(world.numClusters).toBe(1);
  expect(writeRequests).toEqual(["maps/one.aas"]);
  expect(messages.indexOf("calculating clusters...\n")).toBeLessThan(messages.indexOf("writing maps/one.aas\n"));
  const written = files.get("maps/one.aas");
  if (written === undefined) throw new Error("Missing generated AAS write");
  expect(parseAas(written).areaSettings).toEqual(world.areaSettings);
});

test("forced clustering and optimized writing complete before routing uses the same map", () => {
  for (const variable of ["forceclustering", "forcewrite"]) {
    const { aas, variables, input, messages, files, writeRequests } = runtime();
    variables.set(variable, "1"); variables.set("aasoptimize", "1"); aas.loadMap(input());
    const map = loadedMap(aas), originalReachability = map.world.reachability[1];
    aas.startFrame(1);
    expect(aas.initialized).toBe(true);
    expect(loadedMap(aas)).toBe(map);
    expect(map.spatial.world).toBe(map.world);
    expect(map.world.reachability[1]).toBe(originalReachability);
    expect(map.world.vertices).toHaveLength(0);
    expect(writeRequests).toEqual(["maps/one.aas"]);
    expect(messages.indexOf("closed maps/one.aas\n")).toBeLessThan(messages.indexOf("AAS initialized.\n"));
    const written = files.get("maps/one.aas");
    if (written === undefined) throw new Error("Missing optimized AAS write");
    expect(parseAas(written).reachability[1]?.padding).toBe(0xbeef);
    const route = map.routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT });
    if (variable === "forceclustering") {
      expect(map.world.clusters[1]?.reachabilityAreaCount).toBe(1);
      expect(route).toEqual({ kind: "unreachable" });
    } else {
      expect(route).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
    }
  }
});

test("write acquisition failures still initialize routing and reset the source routing-save request", () => {
  const denied = runtime(() => undefined, false);
  denied.variables.set("forcewrite", "1"); denied.aas.loadMap(denied.input()); denied.aas.startFrame(1);
  expect(denied.aas.initialized).toBe(true);
  expect(denied.messages).toContain("error opening maps/one.aas\n");
  expect(denied.messages).toContain("couldn't write maps/one.aas\n");
  denied.variables.set("saveroutingcache", "1"); denied.aas.startFrame(2);
  expect(denied.messages).toContain("Unable to open file: maps/one.rcd\n");
  expect(denied.variables.getValue("saveroutingcache")).toBe(0);
  expect(denied.aas.frameNumber()).toBe(2);
});

test("nonsequential AAS lumps warn and seek using the source cumulative offset", () => {
  const events: string[] = [];
  const { aas, input, files, handles } = runtime(text => { if (text.includes("not sequentially")) events.push("warning"); });
  const original = fixture(), bytes = new Uint8Array(original.length + 8);
  bytes.set(original.subarray(0, 124)); bytes.set(original.subarray(124), 132);
  const header = new DataView(bytes.buffer), expected: string[] = ["read:124"];
  for (let index = 0; index < 14; index++) {
    const length = header.getInt32(16 + index * 8, true);
    if (length === 0) continue;
    const offset = header.getInt32(12 + index * 8, true) + 8;
    header.setInt32(12 + index * 8, offset, true);
    expected.push("warning", `seek:${offset}:2`, `read:${length}`);
  }
  files.set("maps/one.aas", bytes);
  const map = input();
  expect(aas.loadMap({ ...map, assets: { ...map.assets,
    readSync: () => { throw new Error("AAS must read its actual handle"); },
    readInto: (file, destination) => { events.push(`read:${destination.length}`); return map.assets.readInto(file, destination); },
    seekFile: (file, offset, origin) => { events.push(`seek:${offset}:${origin}`); return map.assets.seekFile(file, offset, origin); },
    closeFile: file => { expect(aas.loaded).toBe(true); expect(aas.initialized).toBe(false);
      expect(aas.phase.kind).toBe("data-loaded"); events.push("close"); map.assets.closeFile(file); },
  } })).toBe(0);
  expect(events).toEqual([...expected, "close"]);
  expect(handles.readCount).toBe(original.length);
  expect(handles.selectFree().slot).toBe(1);
  expect(loadedMap(aas).world.clusters[1]?.reachabilityAreaCount).toBe(2);
});

test("short AAS lump reads leave the actual cleared hunk tail and ignore the returned count", () => {
  const { aas, input, handles } = runtime();
  const map = input();
  let shortReads = 0;
  expect(aas.loadMap({ ...map, assets: { ...map.assets, readInto: (file, destination) => {
    if (destination.length !== 32) return map.assets.readInto(file, destination);
    shortReads++;
    return map.assets.readInto(file, destination.subarray(0, 28));
  } } })).toBe(0);
  expect(shortReads).toBe(1);
  expect(handles.readCount).toBe(fixture().length - 4);
  expect(loadedMap(aas).world.clusters[1]).toEqual({ areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 });
  expect(handles.selectFree().slot).toBe(1);
});

test("a failed AAS lump seek reports the error and closes before returning the source error code", () => {
  const { aas, input, files, handles, messages } = runtime();
  const original = fixture(), bytes = new Uint8Array(original.length + 8);
  bytes.set(original.subarray(0, 124)); bytes.set(original.subarray(124), 132);
  const header = new DataView(bytes.buffer);
  for (let index = 0; index < 14; index++) {
    if (header.getInt32(16 + index * 8, true) > 0) {
      header.setInt32(12 + index * 8, header.getInt32(12 + index * 8, true) + 8, true);
    }
  }
  files.set("maps/one.aas", bytes);
  const map = input();
  expect(aas.loadMap({ ...map, assets: { ...map.assets, seekFile: (_file, offset, origin) => {
    expect(offset).toBe(132); expect(origin).toBe(2); return -1;
  } } })).toBe(7);
  expect(messages.slice(-2)).toEqual(["AAS file not sequentially read\n", "can't seek to aas lump\n"]);
  expect(handles.readCount).toBe(124);
  expect(handles.selectFree().slot).toBe(1);
  expect(aas.loaded).toBe(false);
});

test("interrupted AAS read callbacks retain the reached file handle", () => {
  const { aas, input, handles } = runtime();
  const map = input(), failure = new Error("read interrupted");
  expect(() => aas.loadMap({ ...map, assets: { ...map.assets, readInto: () => { throw failure; } } })).toThrow(failure);
  expect(aas.loaded).toBe(false);
  expect(handles.selectFree().slot).toBe(2);
});

test("interrupted AAS close callbacks retain the published loaded data", () => {
  const { aas, input, handles } = runtime();
  const map = input(), failure = new Error("close interrupted");
  expect(() => aas.loadMap({ ...map, assets: { ...map.assets, closeFile: () => { throw failure; } } })).toThrow(failure);
  expect(aas.loaded).toBe(true);
  expect(aas.phase.kind).toBe("data-loaded");
  expect(aas.initialized).toBe(false);
  expect(handles.selectFree().slot).toBe(2);
});

test("a rejected route-cache header is ignored for readiness and retains the actual read handle", () => {
  const { aas, input, files, handles, messages } = runtime();
  files.set("maps/one.rcd", new Uint8Array(32));
  aas.loadMap(input()); aas.startFrame(1);
  expect(aas.initialized).toBe(true);
  expect(messages).toContain("maps/one.rcd is not a route cache dump\n");
  expect(handles.selectFree().slot).toBe(2);
  expect(handles.readCount).toBe(fixture().length + 32);
});

test("route-cache save and reload use source frame time and restored entries without rebuilding them", () => {
  const { aas, variables, input, files, handles, writeRequests } = runtime();
  aas.loadMap(input()); aas.startFrame(1 / 3);
  const request = { area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT };
  expect(loadedMap(aas).routing.route(request)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  variables.set("saveroutingcache", "1"); aas.startFrame(2);
  const saved = files.get("maps/one.rcd");
  if (saved === undefined) throw new Error("Runtime did not write its route cache");
  const savedView = new DataView(saved.buffer, saved.byteOffset, saved.byteLength);
  expect(savedView.getInt32(0, true)).toBe(0x4352454d);
  expect(savedView.getInt32(28, true)).toBe(1);
  expect(savedView.getFloat32(32 + 4, true)).toBe(Math.fround(1 / 3));
  expect(variables.getValue("saveroutingcache")).toBe(0);
  expect(writeRequests).toEqual(["maps/one.rcd"]);
  aas.loadMap(input()); aas.startFrame(3);
  const routing = loadedMap(aas).routing;
  expect(aas.initialized).toBe(true);
  expect(routing.cacheStatistics.entries).toBe(1);
  expect(routing.cacheStatistics.areaUpdates).toBe(0);
  expect(handles.selectFree().slot).toBe(1);
  expect(handles.readCount).toBe(2 * fixture().length + saved.length);
  variables.set("saveroutingcache", "1"); aas.startFrame(4);
  const untouched = files.get("maps/one.rcd");
  if (untouched === undefined) throw new Error("Runtime lost its restored route cache");
  expect(new DataView(untouched.buffer, untouched.byteOffset, untouched.byteLength).getFloat32(36, true)).toBe(Math.fround(1 / 3));
  expect(routing.route(request)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  expect(routing.cacheStatistics.areaUpdates).toBe(0);
  variables.set("saveroutingcache", "1"); aas.startFrame(5);
  const touched = files.get("maps/one.rcd");
  if (touched === undefined) throw new Error("Runtime lost its touched route cache");
  expect(new DataView(touched.buffer, touched.byteOffset, touched.byteLength).getFloat32(36, true)).toBe(4);
});

test("a truncated later route-cache record preserves its loaded prefix and stops the frame", () => {
  const { aas, variables, input, files, handles } = runtime();
  aas.loadMap(input()); aas.startFrame(1);
  const routing = loadedMap(aas).routing;
  for (const travelFlags of [TravelFlags.DEFAULT, TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP]) {
    expect(routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags }).kind).toBe("found");
  }
  variables.set("saveroutingcache", "1"); aas.startFrame(2);
  const saved = files.get("maps/one.rcd");
  if (saved === undefined) throw new Error("Runtime did not write its route-cache records");
  const view = new DataView(saved.buffer, saved.byteOffset, saved.byteLength);
  expect(view.getInt32(28, true)).toBe(2);
  const firstSize = view.getInt32(32 + 8, true);
  files.set("maps/one.rcd", saved.slice(0, 32 + firstSize + 11));
  aas.loadMap(input());
  expect(() => aas.startFrame(3)).toThrow(BinaryError);
  expect(aas.phase.kind).toBe("loaded");
  expect(aas.frameNumber()).toBe(2);
  expect(aas.time()).toBe(3);
  expect(loadedMap(aas).routing.cacheStatistics.entries).toBe(1);
  expect(handles.selectFree().slot).toBe(2);
});

test("zero-data route saves use the current map name without resurrecting the retired map", () => {
  const { aas, variables, files, input } = runtime();
  variables.set("saveroutingcache", "1"); aas.startFrame(1);
  const empty = files.get("maps/.rcd");
  if (empty === undefined) throw new Error("No-map route cache was not written");
  expect(empty).toHaveLength(32);
  expect([...new Int32Array(empty.buffer, empty.byteOffset, 8)]).toEqual([0x4352454d, 2, 0, 0, 65535, 65535, 0, 0]);
  expect(variables.getValue("saveroutingcache")).toBe(0);
  aas.loadMap(input()); aas.startFrame(2);
  loadedMap(aas).routing.route({ area: 1, origin: vec3(1, 0, 0), goalArea: 2, travelFlags: TravelFlags.DEFAULT });
  expect(aas.loadMap(input("missing"))).toBe(4);
  variables.set("saveroutingcache", "1"); aas.startFrame(3);
  expect(files.get("maps/missing.rcd")).toEqual(empty);
  expect(aas.loaded).toBe(false);
});

test("source diagnostic aborts preserve the reached phase and stop frame advancement", () => {
  const failure = new CommonError("drop", "test AAS diagnostic control");
  let interrupt = true;
  const first = runtime(text => { if (interrupt && text === "loaded maps/one.aas\n") throw failure; return undefined; });
  expect(() => first.aas.loadMap(first.input())).toThrow(failure);
  expect(first.aas.phase.kind).toBe("data-loaded");
  expect(first.aas.loaded).toBe(true);
  expect(first.aas.filename).toBe("");
  expect(first.variables.get("phys_friction")).toBeNull();
  interrupt = false;
  expect(first.aas.loadMap(first.input())).toBe(0);
  expect(first.aas.phase.kind).toBe("loaded");
  first.aas.disposeResources(); first.aas.disposeResources();
  const second = runtime(text => { if (text === "AAS initialized.\n") throw failure; return undefined; });
  second.aas.loadMap(second.input());
  expect(() => second.aas.startFrame(4)).toThrow(failure);
  expect(second.aas.initialized).toBe(true);
  expect(second.aas.time()).toBe(4);
  expect(second.aas.frameNumber()).toBe(0);
});

test("null map loads retain state and repeated source setup replaces only the history allocation", () => {
  const { aas, input } = runtime();
  aas.loadMap(input()); aas.startFrame(3); aas.updateEntity(1, entity());
  const map = loadedMap(aas), history = aas.entities;
  expect(aas.loadMap(input(null))).toBe(0);
  expect(loadedMap(aas)).toBe(map);
  expect(aas.frameNumber()).toBe(1);
  expect(aas.setup()).toBe(0);
  expect(loadedMap(aas)).toBe(map);
  expect(aas.entities).not.toBe(history);
  expect(aas.entities.info(1).origin).toEqual(zero);
  expect(aas.entities.entityAreas(1)).toEqual([]);
  expect(history.entityAreas(1)).toEqual([1]);
  expect(aas.linkHeap.freeCount).toBe(6143);
  expect(aas.time()).toBe(3);
  expect(aas.frameNumber()).toBe(0);
  aas.updateEntity(1, entity());
  expect(aas.entities.entityAreas(1)).toEqual([]);
  expect(aas.linkHeap.freeCount).toBe(6143);
  aas.shutdown();
  expect(aas.phase.kind).toBe("unloaded");
  expect(aas.bspEntities.loaded).toBe(false);
  expect(aas.maxEntities).toBe(0);
  expect(aas.linkHeap.capacity).toBe(0);
});

test("failed source setup allocation retains the previous entity records and heads", () => {
  const arena = new HunkArena(1024 * 1024, () => {});
  const memory = new BotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
  const { aas, input } = runtime(() => undefined, true, memory);
  aas.loadMap(input()); aas.startFrame(3); aas.updateEntity(1, entity());
  const history = aas.entities, map = loadedMap(aas);
  arena.setMark();
  expect(() => aas.setup()).toThrow("SV_Bot_HunkAlloc: Alloc with marks already set");
  expect(aas.entities).toBe(history);
  expect(aas.entities.entityAreas(1)).toEqual([1]);
  expect(aas.entities.info(1).origin).toEqual(vec3(30, 0, 0));
  expect(aas.linkHeap.freeCount).toBe(6143);
  expect(loadedMap(aas)).toBe(map);
  expect(aas.frameNumber()).toBe(1);
});

test("a smaller source count after setup abort limits history and head reset to the retained prefix", () => {
  const arena = new HunkArena(1024 * 1024, () => {});
  const memory = new RuntimeMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
  const { aas, input, variables } = runtime(() => undefined, true, memory);
  aas.loadMap(input()); aas.startFrame(3); aas.updateEntity(1, entity());
  aas.updateEntity(3, { ...entity(), modelIndex: 2, origin: vec3(-30, 0, 0) });
  const allocation = memory.entities[0];
  if (allocation === undefined) throw new Error("Missing retained runtime entity allocation");
  const bytes = allocation.bytes, records = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  records.setInt32(148 + 144, 17, true); records.setInt32(3 * 148 + 144, 29, true);
  const history = aas.entities;
  variables.set("maxentities", "2"); arena.setMark();
  expect(() => aas.setup()).toThrow("SV_Bot_HunkAlloc: Alloc with marks already set");
  expect(aas.entities).toBe(history); expect(aas.maxEntities).toBe(2);
  expect(history.entityModelIndex(3)).toBe(0);
  expect(history.nextEntity(1)).toBe(0);
  expect(history.originOfMoverWithModelNum(2)).toBeNull();
  expect(history.nearestEntity(zero, 2)).toBe(0);
  history.invalidateEntities(); history.unlinkInvalidEntities(); history.resetEntityLinks();
  expect(records.getInt32(148, true)).toBe(0);
  expect(records.getInt32(148 + 140, true)).toBe(0);
  expect(records.getInt32(148 + 144, true)).toBe(0);
  expect(records.getInt32(3 * 148, true)).toBe(1);
  expect(records.getInt32(3 * 148 + 140, true)).toBe(2);
  expect(records.getInt32(3 * 148 + 144, true)).toBe(29);
  expect(aas.linkHeap.freeCount).toBe(6143);
});

test("a larger source count after setup abort rejects at the physical boundary after earlier head writes", () => {
  const arena = new HunkArena(1024 * 1024, () => {});
  const memory = new RuntimeMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
  const { aas, input, variables } = runtime(() => undefined, true, memory);
  aas.loadMap(input()); aas.startFrame(3); aas.updateEntity(1, entity());
  const allocation = memory.entities[0];
  if (allocation === undefined) throw new Error("Missing retained runtime entity allocation");
  const bytes = allocation.bytes, records = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let entity = 0; entity < 4; entity++) records.setInt32(entity * 148 + 144, 17, true);
  const history = aas.entities;
  variables.set("maxentities", "5"); arena.setMark();
  expect(() => aas.setup()).toThrow("SV_Bot_HunkAlloc: Alloc with marks already set");
  expect(aas.entities).toBe(history); expect(aas.maxEntities).toBe(5);
  expect(() => history.entityOrigin(4)).toThrow("source entity allocation");
  expect(() => history.resetEntityLinks()).toThrow("source entity allocation");
  for (let entity = 0; entity < 4; entity++) {
    expect(records.getInt32(entity * 148 + 140, true)).toBe(0);
    expect(records.getInt32(entity * 148 + 144, true)).toBe(0);
  }
  expect(aas.linkHeap.freeCount).toBe(6143);
});

test("canonical world point sampling keeps the source float cancellation branch", () => {
  const bytes = fixture(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const plane = view.getInt32(12 + 2 * 8, true);
  view.setFloat32(plane + 4, 1, true); view.setFloat32(plane + 12, 16777216, true);
  const parsed = parseAas(bytes), world = new AasWorldState(parsed);
  expect(world.pointArea(vec3(16777216, 1, 0))).toBe(2);
  expect(parsed.pointArea(vec3(16777216, 1, 0))).toBe(2);
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailMaps: readonly { readonly product: Product; readonly name: string }[] = [
  { product: "baseq3", name: "q3dm1" }, { product: "missionpack", name: "mpteam1" },
];

for (const { product, name } of retailMaps) {
  test.skipIf(!existsSync(join(retailRoot, product, "pak0.pk3")))(`runtime generates, writes and reloads installed ${product}/${name} through actual server collision`, async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "quake3-aas-runtime-"));
    const handles = new SourceFileHandles();
    const writable = new WritableFileSystem({ homePath: outputRoot, product, handles, print: () => undefined });
    const random = new LinuxNativeRandom(1);
    const assets = await VirtualFileSystem.openTracked({ dataPath: retailRoot, homePath: outputRoot, cdPath: null, product,
      handles, references: { checksumFeed: 0, random: () => Math.fround((random.next() & 0x7fff) / 32767) } });
    const variables = new BotLibVars(), messages: string[] = [];
    const debug = new BotDebugPolygons(); debug.initialize(100);
    const debugLines = new AasDebugLines(debug, text => { messages.push(text); });
    const aas = new AasRuntime({ variables, print: (_severity, text) => { messages.push(text); },
      commonPrint: text => { messages.push(text); },
      log: { write: text => { messages.push(text); } }, developer: () => false,
      milliseconds: () => { const usage = process.cpuUsage(); return Math.trunc((usage.user + usage.system) / 1000); },
      openWrite: filename => writable.openBinaryWrite(filename),
      permanentLine: (start, end, color) => { debug.permanentLine(start, end, color); }, movementDebug: debugLines.movement });
    try {
      const bspBytes = assets.readSync(`maps/${name}.bsp`), bspMap = parseBsp(bspBytes);
      const collision = new CollisionWorld(bspMap, { kind: "unaccounted" }, { kind: "disabled" });
      const entities = new EntityPool({ print: text => { messages.push(text); }, product, maxClients: 8, mapStartTime: 0, time: () => 0,
        link: entity => { server.link(entity); }, unlink: entity => { server.unlink(entity.slot); } });
      const server = new ServerWorld(collision, collision.modelBounds(0), number => entities.get(number),
        { loading: false, print: text => { messages.push(text); }, developerPrint: text => { messages.push(text); } });
      const spatialHost: AasMapSpatialHost = {
        print: text => { messages.push(text); },
        trace: (start, end, bounds, passEntity, mask) => ({ ...server.trace({ start, end, passEntityNum: passEntity, mask,
          shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } }), contents: 0 }),
        entityTrace: (entity, start, end, bounds, mask) => ({ ...server.traceEntity(entity,
          { start, end, mask, shape: { kind: "box", mins: bounds.min, maxs: bounds.max } }), contents: 0 }),
        pointContents: point => server.pointContents(point, -1),
        modelBounds: (model, angles) => {
          let bounds = collision.modelBounds(model);
          if (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) {
            const radius = radiusFromBounds(bounds);
            bounds = { min: vec3(-radius, -radius, -radius), max: vec3(radius, radius, radius) };
          }
          return { bounds, origin: zero };
        },
      };
      variables.set("sv_mapChecksum", String(blockChecksum(bspBytes) | 0));
      variables.set("forcereachability", "1"); variables.set("aasoptimize", "1");
      variables.set("bot_visualizejumppads", "1");
      expect(aas.loadMap({ name, bsp: bspMap, spatialHost, assets })).toBe(0);
      const map = loadedMap(aas), world = map.world, history = aas.entities;
      expect(world).toBeInstanceOf(AasWorldState);
      expect(map.spatial.world).toBe(world);
      expect(map.spatial.movement.debug).toBe(debugLines.movement);
      let frames = 0;
      while (!aas.initialized) {
        aas.startFrame(++frames / 10);
        if (frames > world.areas.length + 3) throw new Error(`${name} AAS initialization did not finish`);
      }
      expect(frames).toBeGreaterThan(2);
      expect(loadedMap(aas).world).toBe(world);
      expect(world.reachability.length).toBeGreaterThan(0);
      expect(world.areaSettings.reduce((total, settings) => total + settings.reachableAreaCount, 0)).toBe(world.reachability.length - 1);
      expect(world.reachability.every(reach => reach.padding === 0)).toBe(true);
      if (product === "missionpack") {
        expect(debugLines.numDebugLines).toBeGreaterThan(0);
        expect(debug.rows.some(row => row.inuse && row.numPoints === 4 && (row.color === 1 || row.color === 3))).toBe(true);
      }
      const outputFilename = `maps/${name}.aas`, outputBytes = new Uint8Array(readFileSync(join(outputRoot, product, outputFilename)));
      const written = parseAas(outputBytes, "generated runtime AAS");
      expect(written.reachability).toEqual(world.reachability);
      expect(written.areaSettings).toEqual(world.areaSettings);
      expect(written.clusters).toEqual(world.clusters);
      expect(messages.indexOf(`${outputFilename} written succesfully\n`)).toBeLessThan(messages.indexOf("AAS initialized.\n"));
      expect(handles.selectFree().slot).toBe(1);
      for (let area = 1; area < world.areas.length; area++) {
        const first = world.areaReachabilities(area)[0];
        if (first === undefined) continue;
        map.routing.route({ area, origin: first.start, goalArea: first.area,
          travelFlags: TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP });
      }
      const cacheEntries = map.routing.cacheStatistics.entries;
      variables.set("saveroutingcache", "1"); aas.startFrame(++frames / 10);
      const cacheBytes = new Uint8Array(readFileSync(join(outputRoot, product, `maps/${name}.rcd`)));
      expect(cacheBytes.length).toBeGreaterThanOrEqual(32);
      expect(variables.getValue("saveroutingcache")).toBe(0);
      variables.set("forcereachability", "0");
      expect(assets.readSync(outputFilename)).toEqual(outputBytes);
      expect(aas.loadMap({ name, bsp: bspMap, spatialHost, assets })).toBe(0);
      aas.startFrame(++frames / 10);
      expect(aas.initialized).toBe(true);
      expect(aas.entities).toBe(history);
      expect(loadedMap(aas).world.reachability).toEqual(written.reachability);
      expect(loadedMap(aas).routing.cacheStatistics.entries).toBe(cacheEntries);
      expect(loadedMap(aas).routing.cacheStatistics.areaUpdates).toBe(0);
      expect(handles.selectFree().slot).toBe(1);
      expect(messages.filter(text => text === `writing ${outputFilename}\n`)).toHaveLength(1);
    } finally {
      aas.disposeResources(); assets.close(); writable.closeAll(); handles.close();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }, 30_000);
}
