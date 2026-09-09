// Authored cases for sv_game.c lifecycle traps and botlib/be_interface.c gates.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { afterEach, describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import type { FileHandle } from "../src/assets/file-handles.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import type { BotLibraryMapInput } from "../src/botlib/library.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmBotLibrarySyscall } from "../src/vm/bot-library-syscalls.ts";
import { QVM_BOT_ENTITY_STATE_BYTES, readQvmBotEntityState } from "../src/vm/bot-entity-record.ts";

const libraries: BotLibrary[] = [];
afterEach(() => { for (const library of libraries.splice(0)) library.disposeResources(); });

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

// Minimal authored split world, with retained reachability and cluster data.
function aasBytes(): Uint8Array {
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
      writer.i32(0); writer.i32(1); writer.i32(2); writer.i32(area === 0 ? 0 : 1);
      writer.i32(area === 2 ? 1 : 0); writer.i32(area === 1 ? 1 : 0); writer.i32(area === 0 ? 0 : area);
    }
  });
  put(9, writer => {
    writer.bytes(new Uint8Array(44)); writer.i32(2); writer.i32(0); writer.i32(0);
    vector(writer, 1); vector(writer, -1); writer.i32(2); writer.u16(10); writer.u16(0);
  });
  put(10, writer => { writer.bytes(new Uint8Array(12)); writer.i32(0); writer.i32(-1); writer.i32(-2); });
  put(13, writer => { writer.bytes(new Uint8Array(16)); writer.i32(2); writer.i32(2); writer.i32(0); writer.i32(0); });
  const output = new BinaryWriter(124 + lumps.reduce((total, lump) => total + lump.length, 0));
  output.u32(0x53414145); output.i32(4); output.i32(0);
  let offset = 124;
  for (const lump of lumps) { output.i32(offset); output.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) output.bytes(lump);
  return output.finish();
}

function unexpected(): never { throw new Error("Unexpected service in authored lifecycle fixture"); }

function fixture() {
  const encoder = new TextEncoder();
  const files = new Map([
    ["botfiles/weapons.c", encoder.encode('projectileinfo { name "bolt" } weaponinfo { number 1 name "Alpha" projectile "bolt" }')],
    ["botfiles/items.c", encoder.encode('iteminfo "item_health" { name "Health" modelindex 5 }')],
    ["botfiles/syn.c", encoder.encode("")], ["botfiles/rnd.c", encoder.encode("")],
    ["botfiles/match.c", encoder.encode("")], ["botfiles/rchat.c", encoder.encode("")],
    ["maps/authored.aas", aasBytes()],
  ]);
  const handles = new SourceFileHandles();
  const cursors = new Map<FileHandle, { readonly bytes: Uint8Array; offset: number }>();
  const reads: string[] = [], prints: string[] = [], mapNames: (string | null)[] = [];
  const control = { enabled: true, enabledCalls: 0, beforePrint: (_text: string): void => {}, beforeModelBounds: (): void => {} };
  const assets = {
    openRead: (path: string) => {
      reads.push(path);
      const bytes = files.get(path);
      if (bytes === undefined) return undefined;
      for (let slot = 1; slot <= 63; slot++) {
        const file = handles.fromSlot(slot);
        if (file !== null && !cursors.has(file)) {
          cursors.set(file, { bytes, offset: 0 });
          return { file, length: bytes.length };
        }
      }
      throw new Error("Authored file slots exhausted");
    },
    readInto: (file: FileHandle, destination: Uint8Array): number => {
      const cursor = cursors.get(file);
      if (cursor === undefined) throw new Error("Authored file is closed");
      const count = Math.max(0, Math.min(destination.length, cursor.bytes.length - cursor.offset));
      destination.set(cursor.bytes.subarray(cursor.offset, cursor.offset + count));
      cursor.offset += count;
      return count;
    },
    seekFile: (file: FileHandle, offset: number, origin: number): number => {
      const cursor = cursors.get(file);
      if (cursor === undefined) throw new Error("Authored file is closed");
      if (origin !== 0 && origin !== 1 && origin !== 2) throw new Error("Bad authored file seek origin");
      const position = (origin === 0 ? cursor.offset : origin === 1 ? cursor.bytes.length : 0) + offset;
      if (!Number.isSafeInteger(position) || position < 0) return -1;
      cursor.offset = position;
      return 0;
    },
    closeFile: (file: FileHandle): void => {
      if (!cursors.delete(file)) throw new Error("Authored file is already closed");
    },
    readSync: (path: string): Uint8Array => {
      reads.push(path);
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`Authored file missing: ${path}`);
      return bytes.slice();
    },
  };
  const polygons = new BotDebugPolygons();
  const debug = new AasDebugLines(polygons, unexpected);
  const library = new BotLibrary({ assets: () => assets, random: new LinuxNativeRandom(1),
    print: (_severity, text) => { prints.push(text); control.beforePrint(text); return undefined; },
    commonPrint: text => { prints.push(text); return undefined; },
    openLog: unexpected, openWrite: unexpected, milliseconds: () => 0,
    permanentLine: unexpected, movementDebug: debug.movement, clientCommand: unexpected });
  libraries.push(library);
  library.variables.set("maxclients", "2"); library.variables.set("maxentities", "4");
  const bsp: BspMap = { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds: { min: { x: -1, y: -2, z: -3 }, max: { x: 1, y: 2, z: 3 } },
      firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], brushes: [], brushSides: [], vertices: [], indices: [],
    fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const imports = {
    enabled: (): boolean => { control.enabledCalls++; return control.enabled; },
    mapInput: (name: string | null): BotLibraryMapInput => {
      mapNames.push(name);
      return { name, bsp, spatialHost: { print: text => { prints.push(text); }, trace: unexpected,
        pointContents: unexpected, entityTrace: unexpected, modelBounds: model => {
          const definition = bsp.models[model];
          if (definition === undefined) throw new Error("Authored BSP model is absent");
          control.beforeModelBounds();
          return { bounds: definition.bounds, origin: { x: 0, y: 0, z: 0 } };
        } } };
    },
  };
  const memory = new QvmMemory(new Uint8Array(2048).fill(0xa5));
  memory.writeString(32, "authored", 16);
  const call = (args: DataView): number | null => qvmBotLibrarySyscall("game", args, memory, library, imports);
  return { library, imports, memory, call, reads, prints, files, control, mapNames, cursors };
}

function entityBytes(memory: QvmMemory, pointer: number): void {
  const record = memory.view(pointer, 112);
  record.setInt32(0, 4, true); record.setInt32(4, -1, true);
  for (let index = 0; index < 15; index++) record.setFloat32(8 + index * 4, index + 0.25, true);
  record.setFloat32(8, 30, true);
  record.setFloat32(44, -1, true); record.setFloat32(48, -2, true); record.setFloat32(52, -3, true);
  record.setFloat32(56, 1, true); record.setFloat32(60, 2, true); record.setFloat32(64, 3, true);
  for (let index = 0; index < 11; index++) record.setInt32(68 + index * 4, index - 20, true);
  record.setInt32(72, 2, true);
}

describe("QVM game bot library lifecycle traps", () => {
  test("ignores roles and unrelated traps before argument or service access", () => {
    const { library, imports, memory, call, control } = fixture();
    const empty = new DataView(new ArrayBuffer(0));
    expect(qvmBotLibrarySyscall("ui", empty, memory, library, imports)).toBeNull();
    expect(qvmBotLibrarySyscall("cgame", empty, memory, library, imports)).toBeNull();
    for (const trap of [0, 199, 204, 209, 210, 211, -1]) expect(call(words(trap))).toBeNull();
    expect(control.enabledCalls).toBe(0);
    expect(library.setupStage).toBe("none");
  });

  test("TEST retains the selected empty source body without reading unused words or pointers", () => {
    const { library, call, reads, prints, control } = fixture();
    expect(call(words(208))).toBe(0);
    expect(call(words(208, -1, 0, 2047, 0))).toBe(0);
    expect(library.isSetup).toBe(false);
    expect(reads).toEqual([]); expect(prints).toEqual([]); expect(control.enabledCalls).toBe(0);
  });

  test("setup follows the live server enable gate and initializes the actual owners", () => {
    const { library, call, reads, control, cursors } = fixture();
    control.enabled = false;
    expect(call(words(200))).toBe(0);
    expect(library.isSetup).toBe(false); expect(reads).toEqual([]);
    control.enabled = true;
    expect(call(words(200))).toBe(0);
    expect(library.isSetup).toBe(true); expect(library.setupStage).toBe("complete");
    expect(library.maxClients).toBe(2); expect(library.maxEntities).toBe(4);
    expect(library.actions.maxClients).toBe(2);
    expect(library.weapons.config?.weapons[1]?.name).toBe("Alpha");
    expect(library.goals.itemConfig?.items[0]?.name).toBe("Health");
    expect(cursors.size).toBe(0); expect(control.enabledCalls).toBe(2);
    const globals = library.globals;
    globals.add("AUTHORED 7");
    expect(call(words(201))).toBe(0);
    expect(library.isSetup).toBe(false); expect(globals.snapshot()).toEqual({ definitions: [] });
    expect(library.variables.get("maxclients")).toBeNull();
  });

  test("source return codes precede invalid pointers and unavailable AAS getters", () => {
    const { library, memory, call, prints, mapNames } = fixture();
    const before = memory.bytes.slice();
    expect(call(words(201))).toBe(1);
    expect(call(words(205, 0x7fc00000))).toBe(1);
    expect(call(words(206, 2047))).toBe(1);
    expect(call(words(207, -1, 2047))).toBe(1);
    expect(mapNames).toEqual([]);
    expect(prints).toEqual([
      "BotLibShutdown: bot library used before being setup\n", "BotStartFrame: bot library used before being setup\n",
      "BotLoadMap: bot library used before being setup\n", "BotUpdateEntity: bot library used before being setup\n",
    ]);
    expect(call(words(200))).toBe(0);
    expect(call(words(207, -1, 2047))).toBe(2);
    expect(call(words(207, 5, 2047))).toBe(2);
    expect(call(words(207, 1, 2047))).toBe(3);
    expect(call(words(207, 4, 2047))).toBe(3);
    expect(call(words(207, 1, 0))).toBe(3);
    expect(library.aas.loaded).toBe(false);
    expect(memory.bytes).toEqual(before);
  });

  test("libvars share the actual owner and exact padded bounded byte writes", () => {
    const { library, memory, call } = fixture();
    memory.writeString(64, "Authored", 16); memory.writeString(96, "123.5\xff", 16);
    expect(call(words(202, 64, 96))).toBe(0);
    expect(library.variables.getString("AUTHORED")).toBe("123.5\xff");
    expect(call(words(203, 64, -1792, 4))).toBe(0);
    expect(Array.from(memory.bytes.subarray(255, 261))).toEqual([165, 49, 50, 51, 0, 165]);
    library.variables.set("authored", "\xff");
    expect(call(words(203, 64, 272, 4))).toBe(0);
    expect(Array.from(memory.bytes.subarray(271, 277))).toEqual([165, 255, 0, 0, 0, 165]);
    expect(call(words(203, 64, 288, 1))).toBe(0);
    expect(memory.bytes[288]).toBe(0); expect(memory.bytes[289]).toBe(165);
    memory.writeString(128, "missing", 16);
    expect(call(words(203, 128, 304, 4))).toBe(0);
    expect(memory.span(304, 4)).toEqual(new Uint8Array(4));
    expect(library.variables.get("missing")).toBeNull();
    const before = memory.bytes.slice();
    const invalid: readonly (readonly [number, number])[] = [[0, 4], [2047, 2], [320, 0], [320, -1]];
    for (const [pointer, size] of invalid) {
      expect(() => call(words(203, 64, pointer, size))).toThrow(RangeError);
    }
    expect(memory.bytes).toEqual(before);
  });

  test("libvar queries accept NULL names and do not read names from an empty list", () => {
    const { library, memory, call } = fixture();
    expect(call(words(203, 0, 256, 4))).toBe(0);
    expect(memory.span(256, 4)).toEqual(new Uint8Array(4));
    library.variables.clear();
    expect(call(words(203, 2047, 272, 4))).toBe(0);
    expect(memory.span(272, 4)).toEqual(new Uint8Array(4));
    expect(library.variables.getStringByNameBytes(unexpected)).toBe("");
  });

  test("libvar queries stop on mismatches before an unterminated allocation edge", () => {
    const { library, memory, call } = fixture();
    library.variables.clear();
    library.variables.set("aaa", "older");
    library.variables.set("b", "middle");
    library.variables.set("az", "newer");
    library.variables.set("B", "updated");
    memory.bytes.set([65, 88], 2046);
    expect(call(words(203, -2, 256, 4))).toBe(0);
    expect(memory.span(256, 4)).toEqual(new Uint8Array(4));
    const indexes: number[] = [];
    expect(library.variables.getStringByNameBytes(index => {
      indexes.push(index);
      return memory.view(2046, index + 1).getUint8(index);
    })).toBe("");
    expect(indexes).toEqual([0, 1, 0, 0, 1]);
    memory.bytes[2047] = 99;
    expect(call(words(203, 2047, 272, 4))).toBe(0);
    expect(memory.span(272, 4)).toEqual(new Uint8Array(4));
  });

  test("libvar matching prefixes still reject missing reached bytes before output writes", () => {
    const { library, memory, call } = fixture();
    library.variables.clear(); library.variables.set("b", "value");
    memory.bytes[2047] = 66;
    const before = memory.bytes.slice();
    expect(() => call(words(203, 2047, 256, 4))).toThrow(RangeError);
    expect(memory.bytes).toEqual(before);
    memory.bytes.set([66, 0], 2046);
    expect(call(words(203, 2046, 256, 8))).toBe(0);
    expect(memory.readString(256)).toBe("value");
    library.variables.set("\xff", "byte");
    memory.bytes.set([255, 0], 2046);
    expect(call(words(203, 2046, 272, 8))).toBe(0);
    expect(memory.readString(272)).toBe("byte");
  });

  test("libvar name comparison reads the source count-limit byte before returning equality", () => {
    const { library, imports } = fixture();
    library.variables.clear(); library.variables.set("x".repeat(100000), "limit");
    const memory = new QvmMemory(new Uint8Array(131072));
    memory.bytes.fill(120, 31072);
    expect(qvmBotLibrarySyscall("game", words(203, 31072, 32, 8), memory, library, imports)).toBe(0);
    expect(memory.readString(32)).toBe("limit");
    expect(() => qvmBotLibrarySyscall("game", words(203, 31073, 48, 8), memory, library, imports)).toThrow(RangeError);
  });

  test("libvar SET skips full name reads for existing count-limit matches but requires them on allocation", () => {
    const { library, imports } = fixture();
    const name = "x".repeat(100000);
    library.variables.clear(); library.variables.set(name, "before"); library.variables.setNotModified(name);
    const memory = new QvmMemory(new Uint8Array(131072));
    memory.bytes.fill(120, 31072); memory.writeString(32, "123.5", 8);
    expect(qvmBotLibrarySyscall("game", words(202, 31072, 32), memory, library, imports)).toBe(0);
    expect(library.variables.getString(name)).toBe("123.5");
    expect(library.variables.getValue(name)).toBe(123.5);
    expect(library.variables.changed(name)).toBe(true);
    library.variables.clear();
    expect(() => qvmBotLibrarySyscall("game", words(202, 31072, 32), memory, library, imports)).toThrow(RangeError);
    expect(library.variables.get(name)).toBeNull();
  });

  test("map loads consume captured words after the print gate and retain null-map history", () => {
    const { library, memory, call, control, mapNames, reads } = fixture();
    expect(call(words(200))).toBe(0);
    const active = words(206, 32);
    control.beforePrint = text => {
      if (text === "------------ Map Loading ------------\n") active.setInt32(4, 2047, true);
    };
    expect(call(active)).toBe(0);
    expect(mapNames).toEqual(["authored"]); expect(library.aas.loaded).toBe(true);
    expect(active.getInt32(4, true)).toBe(2047);
    const history = library.aas.entities;
    const loadedReads = reads.length;
    expect(call(words(206, 0))).toBe(0);
    expect(mapNames).toEqual(["authored", null]);
    expect(library.aas.entities).toBe(history); expect(reads.length).toBe(loadedReads);
    control.beforePrint = () => {};
    const requests = mapNames.length;
    expect(() => call(words(206, 2047))).toThrow(RangeError);
    expect(mapNames.length).toBe(requests);
    memory.writeString(48, "missing", 16);
    expect(call(words(206, 48))).toBe(4);
    expect(library.aas.loaded).toBe(false);
  });

  test("start-frame float bits and decoded entity fields reach real AAS history and unlinking", () => {
    const { library, memory, call } = fixture();
    expect(call(words(200))).toBe(0);
    expect(call(words(206, 32))).toBe(0);
    expect(call(words(205, 0x3eaaaaab))).toBe(0);
    expect(library.time()).toBe(Math.fround(1 / 3));
    expect(library.aasInitialized).toBe(true);
    entityBytes(memory, 256);
    const decoded = readQvmBotEntityState(memory.view(256, 112));
    expect(call(words(207, 1, -1792))).toBe(0);
    const info = library.aas.entities.info(1);
    expect(info).toMatchObject(decoded);
    expect(info.valid).toBe(true); expect(info.number).toBe(1);
    expect(info.lastUpdateTime).toBe(Math.fround(1 / 3));
    const phase = library.aas.phase;
    if (phase.kind !== "ready") throw new Error("Expected initialized authored AAS");
    expect(library.aas.entities.entityAreas(1)).toEqual([1]);
    expect(call(words(207, 1, 0))).toBe(0);
    expect(library.aas.entities.entityAreas(1)).toEqual([]);
    expect(library.aas.entities.info(1)).toEqual(info);
    expect(() => call(words(207, 4, 2047))).toThrow("source entity allocation");
    expect(() => call(words(207, 1, 2047))).toThrow(RangeError);
    expect(library.aas.entities.info(1)).toEqual(info);
  });

  test("the 112-byte entity codec owns vectors, signed words and float32 fields", () => {
    const memory = new QvmMemory(new Uint8Array(256));
    entityBytes(memory, 32);
    expect(QVM_BOT_ENTITY_STATE_BYTES).toBe(112);
    const decoded = readQvmBotEntityState(memory.view(32, 112));
    expect(decoded).toEqual({ type: 4, flags: -1, origin: { x: 30, y: 1.25, z: 2.25 },
      angles: { x: 3.25, y: 4.25, z: 5.25 }, oldOrigin: { x: 6.25, y: 7.25, z: 8.25 },
      mins: { x: -1, y: -2, z: -3 }, maxs: { x: 1, y: 2, z: 3 }, groundEntity: -20, solid: 2,
      modelIndex: -18, modelIndex2: -17, frame: -16, event: -15, eventParameter: -14, powerups: -13,
      weapon: -12, legsAnimation: -11, torsoAnimation: -10 });
    memory.view(32, 112).setFloat32(8, 999, true);
    expect(decoded.origin.x).toBe(30);
    expect(() => readQvmBotEntityState(memory.view(32, 111))).toThrow();
  });

  test("entity updates reread later VM fields after the actual model-bounds callback", () => {
    const { library, memory, call, control } = fixture();
    expect(call(words(200))).toBe(0); expect(call(words(206, 32))).toBe(0);
    expect(call(words(205, 0x3f800000))).toBe(0);
    entityBytes(memory, 256);
    const record = memory.view(256, 112);
    record.setInt32(72, 3, true); record.setInt32(76, 0, true);
    control.beforeModelBounds = () => {
      record.setFloat32(8, -40, true);
      record.setInt32(4, 99, true);
    };
    expect(call(words(207, 1, 256))).toBe(0);
    const info = library.aas.entities.info(1);
    expect(info.origin.x).toBe(-40);
    expect(info.flags).toBe(-1);
    const phase = library.aas.phase;
    if (phase.kind !== "ready") throw new Error("Expected authored initialized map");
    expect(library.aas.entities.entityAreas(1)).toEqual([2]);
  });

  test("short argument frames reject before owner callbacks or variable writes", () => {
    const { call, prints, library } = fixture();
    for (const trap of [202, 203, 205, 206, 207]) expect(() => call(words(trap))).toThrow(RangeError);
    expect(prints).toEqual([]); expect(library.isSetup).toBe(false);
  });

  test("setup reads actual shared globals and preserves partial failure return codes", () => {
    const { library, files, call } = fixture();
    library.globals.add('WEAPON_NAME "Defined"');
    files.set("botfiles/weapons.c", new TextEncoder().encode(
      'projectileinfo { name "bolt" } weaponinfo { number 1 name WEAPON_NAME projectile "bolt" }',
    ));
    expect(call(words(200))).toBe(0);
    expect(library.weapons.config?.weapons[1]?.name).toBe("Defined");
    expect(call(words(201))).toBe(0);
    files.delete("botfiles/weapons.c");
    expect(call(words(200))).toBe(12);
    expect(library.isSetup).toBe(false); expect(library.setupStage).toBe("weapons");
    const actions = library.actions;
    expect(call(words(201))).toBe(1);
    expect(library.actions).toBe(actions);
  });
});
