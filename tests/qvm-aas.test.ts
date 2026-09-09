// Authored in-memory cases for sv_game.c AAS traps and game/be_aas.h records.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
// No SDL, native/oracle execution, retail QVMs, retail assets, or filesystem fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import type { FileHandle } from "../src/assets/file-handles.ts";
import { AasRuntime } from "../src/botlib/aas-runtime.ts";
import type { AasMapSpatialHost } from "../src/botlib/aas-runtime.ts";
import type { AasEntityInfo, BotEntityUpdate } from "../src/botlib/entity.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { TravelFlags } from "../src/botlib/routing.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import {
  QVM_AAS_ALTERNATIVE_GOAL_BYTES, QVM_AAS_AREA_INFO_BYTES, QVM_AAS_CLIENT_MOVE_BYTES,
  QVM_AAS_ENTITY_INFO_BYTES, QVM_AAS_PREDICT_ROUTE_BYTES, QVM_AAS_TRACE_BYTES,
  qvmAasClientMoveOutput, qvmAasVector, writeQvmAasAlternativeGoal, writeQvmAasAreaInfo, writeQvmAasEntityInfo, writeQvmAasTrace,
} from "../src/vm/aas-record.ts";
import { qvmAasSyscall } from "../src/vm/aas-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

const zero = vec3(0, 0, 0), runtimes: AasRuntime[] = [];
afterEach(() => { for (const aas of runtimes.splice(0)) aas.disposeResources(); });

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

function putVector(memory: QvmMemory, pointer: number, value: Vec3): void {
  const view = memory.view(pointer, 12);
  view.setFloat32(0, value.x, true); view.setFloat32(4, value.y, true); view.setFloat32(8, value.z, true);
}

function vector(memory: QvmMemory, pointer: number): Vec3 {
  const value = qvmAasVector(memory.pointer(pointer));
  return vec3(value.x, value.y, value.z);
}

/** Three actual AAS leaves and a two-link walking route, all authored bytes. */
function aasBytes(): Uint8Array {
  const lumps: Uint8Array[] = Array.from({ length: 14 }, () => new Uint8Array(0));
  const put = (index: number, write: (writer: BinaryWriter) => void): void => {
    const writer = new BinaryWriter(512); write(writer); lumps[index] = writer.finish();
  };
  const vec = (writer: BinaryWriter, x: number, y = 0, z = 0): void => { writer.f32(x); writer.f32(y); writer.f32(z); };
  put(1, writer => vec(writer, 0));
  put(2, writer => { for (const distance of [100, 0]) { vec(writer, 1); writer.f32(distance); writer.i32(0); } });
  put(3, writer => { writer.i32(0); writer.i32(0); });
  put(5, writer => { writer.bytes(new Uint8Array(24)); });
  put(7, writer => {
    for (let area = 0; area < 4; area++) {
      writer.i32(area); writer.i32(0); writer.i32(0);
      vec(writer, -512, -512, -512); vec(writer, 512, 512, 512); vec(writer, area === 1 ? 200 : area === 2 ? 50 : -100);
    }
  });
  put(8, writer => {
    for (let area = 0; area < 4; area++) {
      writer.i32(0); writer.i32(1); writer.i32(6); writer.i32(area === 0 ? 0 : 1);
      writer.i32(area === 0 ? 0 : area - 1); writer.i32(area === 1 || area === 2 ? 1 : 0);
      writer.i32(area === 1 || area === 2 ? area : 0);
    }
  });
  put(9, writer => {
    writer.bytes(new Uint8Array(44));
    for (const area of [2, 3]) {
      writer.i32(area); writer.i32(0); writer.i32(0); vec(writer, 0); vec(writer, 0);
      writer.i32(2); writer.u16(10); writer.u16(0);
    }
  });
  put(10, writer => {
    writer.bytes(new Uint8Array(12));
    writer.i32(0); writer.i32(-1); writer.i32(2);
    writer.i32(1); writer.i32(-2); writer.i32(-3);
  });
  put(13, writer => {
    writer.bytes(new Uint8Array(16)); writer.i32(3); writer.i32(3); writer.i32(0); writer.i32(0);
  });
  const writer = new BinaryWriter(124 + lumps.reduce((sum, lump) => sum + lump.length, 0));
  writer.u32(0x53414145); writer.i32(5); writer.i32(0);
  let offset = 124;
  for (const lump of lumps) { writer.i32(offset); writer.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) writer.bytes(lump);
  const bytes = writer.finish();
  for (const [index, byte] of bytes.subarray(8, 124).entries()) bytes[8 + index] = byte ^ ((index * 119) & 255);
  return bytes;
}

function entity(): BotEntityUpdate {
  return { type: 7, flags: -2147483648, origin: vec3(200, 2, 3), angles: vec3(4, 5, 6), oldOrigin: vec3(7, 8, 9),
    mins: vec3(-1, -2, -3), maxs: vec3(1, 2, 3), groundEntity: -1, solid: 2, modelIndex: 8, modelIndex2: 9,
    frame: 10, event: 11, eventParameter: 12, powerups: 13, weapon: 14, legsAnimation: 15, torsoAnimation: 16 };
}

function fixture() {
  const handles = new SourceFileHandles();
  const cursors = new Map<FileHandle, { readonly bytes: Uint8Array; offset: number }>();
  const variables = new BotLibVars(); variables.set("maxentities", "4"); variables.set("sv_mapChecksum", "0");
  const memory = new QvmMemory(new Uint8Array(4096).fill(0xa5));
  const messages: { readonly severity: number; readonly text: string }[] = [], points: Vec3[] = [];
  const controls = { developer: true, print: (_text: string): undefined => undefined, contents: (_point: Vec3): number => 0,
    openRead: (_filename: string): undefined => undefined };
  const aas = new AasRuntime({ variables,
    print: (severity, text) => { messages.push({ severity, text }); return controls.print(text); },
    commonPrint: text => controls.print(text),
    log: { write: () => {} }, developer: () => controls.developer, milliseconds: () => 0,
    openWrite: () => null, permanentLine: () => undefined,
    movementDebug: { kind: "enabled", line: () => {}, print: () => {}, clearLines: () => {} },
  });
  runtimes.push(aas);
  const pointContents = (point: Vec3): number => {
    const captured = vec3(point.x, point.y, point.z); points.push(captured); return controls.contents(captured);
  };
  const spatialHost: AasMapSpatialHost = {
    print: text => { messages.push({ severity: 1, text }); }, pointContents,
    trace: (_start, end) => ({ fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 }),
    entityTrace: (_entity, _start, end) => ({ fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 }),
    modelBounds: () => ({ bounds: { min: zero, max: zero }, origin: zero }),
  };
  const load = (text = '{ "name" "authored" "vector" "1.5 -2 3" "float" "0.1" "int" "-19" }', host = spatialHost): void => {
    const bsp: BspMap = { entities: text, entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [],
      leafSurfaces: [], leafBrushes: [], models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [],
      surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
    expect(aas.loadMap({ name: "authored", bsp, spatialHost: host, assets: {
      readSync: () => aasBytes(), openRead: filename => {
        if (filename !== "maps/authored.aas") return controls.openRead(filename);
        const file = handles.fromSlot(1);
        if (file === null || cursors.has(file)) throw new Error("Authored AAS file slot unavailable");
        const bytes = aasBytes();
        cursors.set(file, { bytes, offset: 0 });
        return { file, length: bytes.length };
      },
      readInto: (file, destination) => {
        const cursor = cursors.get(file);
        if (cursor === undefined) throw new Error("Authored AAS file is closed");
        const count = Math.max(0, Math.min(destination.length, cursor.bytes.length - cursor.offset));
        destination.set(cursor.bytes.subarray(cursor.offset, cursor.offset + count));
        cursor.offset += count;
        return count;
      },
      seekFile: (file, offset, origin) => {
        const cursor = cursors.get(file);
        if (cursor === undefined) throw new Error("Authored AAS file is closed");
        if (origin !== 0 && origin !== 1 && origin !== 2) throw new Error("Bad authored AAS seek origin");
        const position = (origin === 0 ? cursor.offset : origin === 1 ? cursor.bytes.length : 0) + offset;
        if (!Number.isSafeInteger(position) || position < 0) return -1;
        cursor.offset = position;
        return 0;
      },
      closeFile: file => {
        if (!cursors.delete(file)) throw new Error("Authored AAS file is already closed");
      },
    } })).toBe(0);
  };
  const ready = (): void => { load(); aas.startFrame(0.25); expect(aas.initialized).toBe(true); };
  const call = (...values: number[]): number | null => qvmAasSyscall("game", words(...values), memory, aas, pointContents);
  return { aas, memory, variables, messages, points, controls, load, ready, call, pointContents, spatialHost };
}

describe("QVM AAS records", () => {
  test("uses source record widths, field offsets and untouched alternative-goal padding", () => {
    expect([QVM_AAS_ENTITY_INFO_BYTES, QVM_AAS_AREA_INFO_BYTES, QVM_AAS_TRACE_BYTES,
      QVM_AAS_CLIENT_MOVE_BYTES, QVM_AAS_PREDICT_ROUTE_BYTES, QVM_AAS_ALTERNATIVE_GOAL_BYTES]).toEqual([140, 52, 36, 84, 36, 24]);
    const bytes = new Uint8Array(144).fill(0xa5), view = new DataView(bytes.buffer, 4, 140);
    const info: AasEntityInfo = { ...entity(), valid: true, number: 3, lastVisibleOrigin: vec3(10, 11, 12),
      lastUpdateTime: 0.1, updateInterval: -0 };
    writeQvmAasEntityInfo(view, info);
    expect(view.getInt32(0, true)).toBe(1); expect(view.getInt32(8, true)).toBe(-2147483648);
    expect(view.getFloat32(12, true)).toBe(Math.fround(0.1)); expect(Object.is(view.getFloat32(16, true), -0)).toBe(true);
    expect(view.getInt32(20, true)).toBe(3); expect(view.getFloat32(60, true)).toBe(10);
    expect(view.getInt32(96, true)).toBe(-1); expect(view.getInt32(136, true)).toBe(16);
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    const alternative = new Uint8Array(24).fill(0xa5);
    writeQvmAasAlternativeGoal(new DataView(alternative.buffer), { origin: vec3(0.1, -0, 16777217), area: -9,
      startTravelTime: 65535, goalTravelTime: 2, extraTravelTime: 65534 });
    const goal = new DataView(alternative.buffer);
    expect(goal.getFloat32(8, true)).toBe(16777216); expect(goal.getInt32(12, true)).toBe(-9);
    expect(goal.getUint16(16, true)).toBe(65535); expect(goal.getUint16(20, true)).toBe(65534);
    expect(alternative.subarray(22)).toEqual(new Uint8Array(2).fill(0xa5));
  });

  test("record codecs reject truncated extents before publication", () => {
    const bytes = new Uint8Array(140).fill(0xa5), before = bytes.slice();
    const info: AasEntityInfo = { ...entity(), valid: false, number: 0, lastVisibleOrigin: zero, lastUpdateTime: 0, updateInterval: 0 };
    expect(() => writeQvmAasEntityInfo(new DataView(bytes.buffer, 0, 139), info)).toThrow(BinaryError);
    expect(() => writeQvmAasAreaInfo(new DataView(bytes.buffer, 0, 51), {
      contents: 0, flags: 0, cluster: 0, presenceType: 2, mins: zero, maxs: zero, center: zero,
    })).toThrow(BinaryError);
    expect(() => writeQvmAasTrace(new DataView(bytes.buffer, 0, 35), {
      startSolid: true, fraction: 0, end: zero, entityNum: 0, lastArea: 0, area: 0, plane: 0,
    })).toThrow(BinaryError);
    expect(bytes).toEqual(before);
  });
});

describe("QVM AAS dispatch and source gates", () => {
  test("rejects other roles before reading words and leaves unknown traps unclaimed", () => {
    const f = fixture(), empty = new DataView(new ArrayBuffer(0));
    for (const role of ["ui", "cgame"] satisfies readonly ("ui" | "cgame")[]) {
      expect(qvmAasSyscall(role, empty, f.memory, f.aas, f.pointContents)).toBeNull();
    }
    expect(f.call(9999)).toBeNull(); expect(f.messages).toEqual([]);
    expect(f.call(304)).toBe(0); expect(f.call(306)).toBe(0);
  });

  test("retains unloaded point, route, trace and bbox gates without dereferencing inactive inputs", () => {
    const f = fixture();
    expect(f.call(307, 0)).toBe(0);
    expect(f.messages.at(-1)?.text).toBe("AAS_PointAreaNum: aas not loaded\n");
    expect(f.call(316, 1, 0, 2, TravelFlags.DEFAULT)).toBe(0);
    expect(f.call(577, 4095)).toBe(0);
    expect(f.call(301, 0, 0, 0, 0)).toBe(0);
    expect(f.messages.at(-1)?.text).toBe("AAS_LinkEntity: aas not loaded\n");
    expect(f.call(308, 0, 0, 128, 0, -10)).toBe(0);
    expect(f.memory.view(128, 8).getInt32(0, true)).toBe(0);
    expect(f.memory.span(132, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    expect(() => f.call(308, 0, 0, 0, 0, 0)).toThrow("nonnull");
    expect(f.call(302, -1, 0)).toBe(0);
    expect(f.call(575, 0, 0, 0, 1, 0, 0, 0, 0)).toBe(0);
  });

  test("samples the runtime time and actual server contents independently of map readiness", () => {
    const f = fixture(); f.aas.startFrame(-0.1);
    expect(f.call(306)).toBe(float32ToBits(-0.1) | 0);
    putVector(f.memory, 64, vec3(1, 2, 3));
    f.controls.contents = point => point.z < 2 ? 32 : -2147483648;
    expect(f.call(309, 64)).toBe(-2147483648); expect(f.call(317, 64)).toBe(1);
    expect(f.points).toEqual([vec3(1, 2, 3), vec3(1, 2, 1)]);
  });

  test("prints before entity zero-fill or invalid-presence fallback, preserving diagnostic aborts", () => {
    const f = fixture(), failure = new CommonError("drop", "AAS fixture diagnostic");
    f.controls.print = () => { throw failure; };
    const before = f.memory.bytes.slice();
    expect(() => f.call(303, 1, 128)).toThrow(failure); expect(f.memory.bytes).toEqual(before);
    expect(() => f.call(305, 0, 128, 192)).toThrow(failure); expect(f.memory.bytes).toEqual(before);
    f.controls.print = () => undefined;
    expect(f.call(303, 1, 128)).toBe(0); expect(f.memory.span(128, 140)).toEqual(new Uint8Array(140));
    expect(f.call(305, 0, 128, 192)).toBe(0);
    expect(vector(f.memory, 128)).toEqual(vec3(-15, -15, -24)); expect(vector(f.memory, 192)).toEqual(vec3(15, 15, 8));
    expect(() => f.call(303, -1, 0)).toThrow("nonnull");
    expect(f.messages.at(-1)?.text).toBe("AAS_EntityInfo: aasworld not initialized\n");
  });

  test("uses parsed world data during interrupted map initialization for point and area queries", () => {
    const f = fixture(), failure = new CommonError("drop", "loaded diagnostic");
    f.controls.print = text => { if (text === "loaded maps/authored.aas\n") throw failure; return undefined; };
    expect(() => f.load()).toThrow(failure); expect(f.aas.phase.kind).toBe("data-loaded");
    putVector(f.memory, 64, vec3(200, 0, 0));
    expect(f.call(307, 64)).toBe(1); expect(f.call(302, 2, 128)).toBe(52);
    expect(f.call(308, 64, 64, 512, 0, 1)).toBe(1); expect(f.memory.view(512, 4).getInt32(0, true)).toBe(1);
    expect(f.call(304)).toBe(0); expect(f.call(303, 1, 256)).toBe(0);
    expect(f.memory.span(256, 140)).toEqual(new Uint8Array(140));
  });
});

describe("QVM AAS spatial and entity queries", () => {
  test("writes real history, source bounds, areas and enabled flags", () => {
    const f = fixture(); f.ready(); f.aas.updateEntity(1, entity());
    expect(f.call(304)).toBe(1); expect(f.call(303, 1, 256)).toBe(0);
    const info = f.memory.view(256, 140);
    expect(info.getInt32(0, true)).toBe(1); expect(info.getInt32(4, true)).toBe(7);
    expect(info.getFloat32(12, true)).toBe(0.25); expect(info.getInt32(20, true)).toBe(1);
    expect(info.getFloat32(24, true)).toBe(200); expect(info.getInt32(136, true)).toBe(16);
    expect(f.call(305, 2, -64, -48)).toBe(0); expect(vector(f.memory, -48)).toEqual(vec3(15, 15, 32));
    expect(f.call(302, 2, 512)).toBe(52); expect(f.memory.view(512, 52).getFloat32(40, true)).toBe(50);
    expect(f.call(315, 1)).toBe(1); expect(f.call(315, 3)).toBe(0);
    expect(f.call(300, 2, -1)).toBe(1); expect(f.call(300, 2, 0)).toBe(1);
    expect(f.call(300, 2, -1)).toBe(0); expect(f.call(302, 2, 512)).toBe(52);
    expect(f.memory.view(512, 52).getInt32(4, true)).toBe(9);
    expect(f.call(300, 2, 1)).toBe(0); expect(f.call(300, 2, -1)).toBe(1);
    const before = f.memory.span(512, 52).slice(); expect(f.call(302, -1, 512)).toBe(0);
    expect(f.memory.span(512, 52)).toEqual(before);
  });

  test("streams crossings and points with source zero and negative capacities", () => {
    const f = fixture(); f.ready();
    putVector(f.memory, 64, vec3(200, 0, 0)); putVector(f.memory, 80, vec3(-100, 0, 0));
    expect(f.call(308, 64, 80, 128, 256, 8)).toBe(3);
    expect([0, 4, 8].map(offset => f.memory.view(128, 12).getInt32(offset, true))).toEqual([1, 2, 3]);
    expect(vector(f.memory, 256)).toEqual(vec3(200, 0, 0));
    expect(vector(f.memory, 268)).toEqual(vec3(100, 0, 0)); expect(vector(f.memory, 280)).toEqual(zero);
    expect(f.call(308, 64, 80, 128, 0, 0)).toBe(1); expect(f.call(308, 64, 80, 128, 0, -1)).toBe(1);
    expect(() => f.call(308, 0, 80, 128, 0, 2)).toThrow("nonnull");
    expect(f.memory.view(128, 4).getInt32(0, true)).toBe(0);
    expect(() => f.call(308, 64, 80, 4092, 0, 2)).toThrow("exceeds allocation");
    expect(f.memory.view(4092, 4).getInt32(0, true)).toBe(1);
  });

  test("captures trace input after its sentinel write and preserves bbox temporary-link publication", () => {
    const f = fixture(); f.ready();
    putVector(f.memory, 64, vec3(200, 0, 0)); putVector(f.memory, 80, vec3(50, 0, 0));
    expect(f.call(308, 64, 80, 64, 256, 1)).toBe(1);
    expect(vector(f.memory, 256)).toEqual(zero);
    putVector(f.memory, 64, vec3(-100, -1, -1)); putVector(f.memory, 80, vec3(200, 1, 1));
    expect(f.call(301, 64, 80, 128, 0)).toBe(1); expect(f.memory.view(128, 4).getInt32(0, true)).toBe(1);
    expect(f.call(301, 64, 80, 128, 3)).toBe(3);
    expect([0, 4, 8].map(offset => f.memory.view(128, 12).getInt32(offset, true))).toEqual([1, 2, 3]);
    expect(() => f.call(301, 64, 80, 4092, 3)).toThrow("exceeds allocation");
    expect(f.memory.view(4092, 4).getInt32(0, true)).toBe(1);
    // An aborted C write never reaches unlink; the retained temporary entity is observable.
    expect(f.call(301, 64, 80, 128, 3)).toBe(0);
  });
});

describe("QVM AAS BSP entity fields", () => {
  test("enumerates and copies values, vectors, float bits and signed integers", () => {
    const f = fixture(); f.load();
    expect(f.call(310, 0)).toBe(1); expect(f.call(310, 1)).toBe(0);
    f.memory.writeString(64, "name", 5);
    expect(f.call(311, 1, 64, 128, 4)).toBe(1); expect(f.memory.readString(128)).toBe("aut");
    expect(f.memory.span(132, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    f.memory.writeString(64, "vector", 7); expect(f.call(312, 1, 64, 128)).toBe(1);
    expect(vector(f.memory, 128)).toEqual(vec3(1.5, -2, 3));
    f.memory.writeString(64, "float", 6); expect(f.call(313, 1, 64, 128)).toBe(1);
    expect(f.memory.view(128, 4).getInt32(0, true)).toBe(float32ToBits(0.1));
    f.memory.writeString(64, "int", 4); expect(f.call(314, 1, 64, 128)).toBe(1);
    expect(f.memory.view(128, 4).getInt32(0, true)).toBe(-19);
  });

  test("clears outputs before range diagnostics or key reads and leaves failed-query tails alone", () => {
    const f = fixture(); f.load();
    expect(f.call(311, -1, 0, 128, -99)).toBe(0);
    expect(f.memory.span(128, 4)).toEqual(new Uint8Array([0, 0xa5, 0xa5, 0xa5]));
    expect(f.call(312, -1, 0, 192)).toBe(0); expect(vector(f.memory, 192)).toEqual(zero);
    expect(f.call(313, -1, 0, 256)).toBe(0); expect(f.memory.view(256, 4).getInt32(0, true)).toBe(0);
    f.memory.writeString(64, "missing", 8); expect(f.call(311, 1, 64, 4095, 99999)).toBe(0);
    f.memory.writeString(64, "name", 5);
    expect(() => f.call(311, 1, 64, 4095, 4)).toThrow("exceeds"); expect(f.memory.bytes[4095]).toBe(0);
    expect(() => f.call(314, 1, 0, 256)).toThrow("nonnull key"); expect(f.memory.view(256, 4).getInt32(0, true)).toBe(0);
    const failure = new CommonError("drop", "BSP diagnostic");
    f.controls.print = () => { throw failure; };
    f.memory.span(192, 12).fill(0xa5); expect(() => f.call(312, -1, 0, 192)).toThrow(failure);
    expect(vector(f.memory, 192)).toEqual(zero);
  });

  test("compares keys only through reached strcmp bytes and observes key/output overlap", () => {
    const f = fixture(); f.load('{ "name" "authored" }');
    f.memory.bytes[4095] = 120; expect(f.call(311, 1, 4095, 128, 12)).toBe(0);
    f.memory.bytes[4095] = 110; expect(() => f.call(311, 1, 4095, 128, 12)).toThrow("key exceeds");
    f.memory.writeString(64, "name", 5); expect(f.call(311, 1, 64, 64, 5)).toBe(0);
    expect(f.memory.bytes[64]).toBe(0);
    f.aas.bspEntities.load("{}"); expect(f.call(311, 1, 0, 128, 0)).toBe(0);
  });
});

describe("QVM AAS routing and movement", () => {
  test("defers nested routing until route-cache callbacks finish and AAS publishes initialization", () => {
    const f = fixture(), origin = vec3(2, 3, 4); f.load(); putVector(f.memory, 64, origin);
    let cacheReads = 0;
    f.controls.openRead = filename => {
      cacheReads++;
      expect(filename).toBe("maps/authored.rcd"); expect(f.aas.initialized).toBe(false);
      f.messages.length = 0;
      for (const area of [1, 0]) {
        f.memory.span(128, 36).fill(0xa5);
        expect(f.call(576, 128, area, 64, 3, TravelFlags.DEFAULT, 0, 0, 0, 0, 0, 0)).toBe(0);
        const route = f.memory.view(128, 36);
        expect(vector(f.memory, 128)).toEqual(origin); expect(route.getInt32(12, true)).toBe(3);
        expect(route.getInt32(16, true)).toBe(1); expect(route.getInt32(20, true)).toBe(0);
        expect(route.getInt32(24, true)).toBe(0); expect(route.getInt32(32, true)).toBe(0);
        expect(f.memory.span(156, 4)).toEqual(new Uint8Array(4).fill(0xa5));
      }
      expect(f.call(316, 1, 4095, 1, TravelFlags.DEFAULT)).toBe(0);
      expect(f.call(575, 64, 1, 0, 3, TravelFlags.DEFAULT, 256, 3, 1)).toBe(0);
      expect(f.call(575, 0, -1, 0, 3, TravelFlags.DEFAULT, 256, 3, 1)).toBe(0);
      expect(f.memory.span(256, 24)).toEqual(new Uint8Array(24).fill(0xa5));
      expect(f.messages).toEqual([]);
      return undefined;
    };
    f.aas.startFrame(0.25); expect(cacheReads).toBe(1); expect(f.aas.initialized).toBe(true);
    expect(f.call(576, 128, 1, 64, 3, TravelFlags.DEFAULT, 0, 0, 0, 0, 0, 0)).toBe(1);
  });

  test("nested route range diagnostics precede NO_ROUTE and preserve initialization when print aborts", () => {
    const f = fixture(); f.load(); putVector(f.memory, 64, zero); f.messages.length = 0;
    const predict = (area: number, goalArea: number): number | null =>
      f.call(576, 128, area, 64, goalArea, TravelFlags.DEFAULT, 0, 0, 0, 0, 0, 0);
    expect(predict(0, 3)).toBe(0); expect(f.messages).toEqual([]);
    f.aas.startFrame(0.25); expect(f.aas.initialized).toBe(true); f.messages.length = 0;
    const startError = { severity: 3, text: "AAS_AreaTravelTimeToGoalArea: areanum 0 out of range\n" };
    expect(predict(0, 3)).toBe(0); expect(f.messages).toEqual([startError]);
    expect(f.memory.view(128, 36).getInt32(16, true)).toBe(1);
    f.messages.length = 0;
    const goalError = { severity: 3, text: "AAS_AreaTravelTimeToGoalArea: goalareanum 4 out of range\n" };
    expect(predict(1, 4)).toBe(0); expect(f.messages).toEqual([goalError]);
    f.messages.length = 0;
    expect(f.call(316, 1, 4095, 4, TravelFlags.DEFAULT)).toBe(0); expect(f.messages).toEqual([goalError]);
    f.messages.length = 0;
    const alternativeError = { severity: 3, text: "AAS_AreaTravelTimeToGoalArea: areanum -1 out of range\n" };
    expect(f.call(575, 0, -1, 0, 3, TravelFlags.DEFAULT, 256, 3, 1)).toBe(0);
    expect(f.messages).toEqual([alternativeError, alternativeError, alternativeError]);
    expect(f.memory.span(256, 24)).toEqual(new Uint8Array(24).fill(0xa5));
    f.messages.length = 0; f.controls.developer = false;
    expect(predict(0, 3)).toBe(0); expect(f.messages).toEqual([]);
    f.controls.developer = true;
    expect(predict(0, 0)).toBe(1); expect(f.call(316, 0, 4095, 0, 0)).toBe(1); expect(f.messages).toEqual([]);
    const failure = new CommonError("drop", "nested AAS range diagnostic");
    f.controls.print = () => { throw failure; }; f.memory.span(128, 36).fill(0xa5);
    expect(() => predict(0, 3)).toThrow(failure); expect(f.messages).toEqual([startError]);
    const route = f.memory.view(128, 36);
    expect(vector(f.memory, 128)).toEqual(zero); expect(route.getInt32(12, true)).toBe(3);
    expect(route.getInt32(16, true)).toBe(0); expect(route.getInt32(20, true)).toBe(0);
    expect(route.getInt32(24, true)).toBe(0); expect(route.getInt32(32, true)).toBe(0);
    expect(f.memory.span(156, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    f.messages.length = 0;
    expect(() => f.call(575, 0, -1, 0, 3, TravelFlags.DEFAULT, 256, 3, 1)).toThrow(failure);
    expect(f.messages).toEqual([alternativeError]);
    expect(f.memory.span(256, 24)).toEqual(new Uint8Array(24).fill(0xa5));
  });

  test("preserves initialized and same-area travel gates, including null origins", () => {
    const f = fixture(); f.ready();
    expect(f.call(316, 0, 4095, 0, 0)).toBe(1); expect(f.call(316, 1, 4095, 1, 0)).toBe(1);
    expect(f.call(316, -1, 4095, 2, 0)).toBe(0);
    putVector(f.memory, 64, zero); expect(f.call(316, 1, 64, 3, TravelFlags.DEFAULT)).toBeGreaterThan(0);
    expect(f.call(577, 0)).toBe(3);
    putVector(f.memory, 64, vec3(50, 0, 0)); expect(f.call(577, 64)).toBe(1);
    putVector(f.memory, 64, vec3(-100, 0, 0)); expect(f.call(577, 64)).toBe(0);
    expect(f.call(300, 2, 0)).toBe(1); putVector(f.memory, 64, zero);
    expect(f.call(316, 1, 64, 3, TravelFlags.DEFAULT)).toBe(0);
  });

  test("predicts real route transitions and leaves numareas untouched", () => {
    const f = fixture(); f.ready(); putVector(f.memory, 64, zero);
    expect(f.call(576, 128, 1, 64, 3, TravelFlags.DEFAULT, 0, 0, 0, 0, 0, 0)).toBe(1);
    const route = f.memory.view(128, 36);
    expect(vector(f.memory, 128)).toEqual(zero); expect(route.getInt32(12, true)).toBe(3);
    expect(route.getInt32(16, true)).toBe(0); expect(route.getInt32(24, true)).toBe(TravelFlags.WALK);
    expect(route.getInt32(32, true)).toBe(22); expect(f.memory.span(156, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    expect(f.call(576, 128, 1, 64, 3, TravelFlags.DEFAULT, 0, 0, 8, 0, 0, 2)).toBe(1);
    expect(route.getInt32(12, true)).toBe(2); expect(route.getInt32(16, true)).toBe(8); expect(route.getInt32(32, true)).toBe(0);
    expect(f.call(300, 2, 0)).toBe(1);
    expect(f.call(576, 128, 1, 64, 3, TravelFlags.DEFAULT, 0, 0, 0, 0, 0, 0)).toBe(0);
    expect(route.getInt32(16, true)).toBe(1);
  });

  test("publishes route initialization before origin errors and reads aliases in source order", () => {
    const f = fixture();
    expect(() => f.call(576, 128, 1, 0, 3, 0, 0, 0, 0, 0, 0, 0)).toThrow("nonnull");
    const route = f.memory.view(128, 36);
    expect(route.getInt32(16, true)).toBe(0); expect(route.getInt32(12, true)).toBe(3);
    expect(route.getInt32(20, true)).toBe(0); expect(route.getInt32(24, true)).toBe(0);
    expect(f.memory.span(160, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    putVector(f.memory, 124, vec3(1, 2, 3));
    expect(f.call(576, 128, 2, 124, 2, 0, 0, 0, 0, 0, 0, 0)).toBe(1);
    expect(vector(f.memory, 128)).toEqual(vec3(1, 1, 1));
    expect(f.memory.span(156, 4)).toEqual(new Uint8Array(4).fill(0xa5));
  });

  test("writes alternative route fields using actual routing and ignores the unused goal pointer", () => {
    const f = fixture(); f.ready(); putVector(f.memory, 64, zero);
    expect(f.call(575, 64, 1, 0, 3, TravelFlags.DEFAULT, 128, 0, 1)).toBe(1);
    const goal = f.memory.view(128, 24);
    expect(goal.getInt32(12, true)).toBe(2); expect(vector(f.memory, 128)).toEqual(vec3(50, 0, 0));
    expect(goal.getUint16(16, true)).toBeGreaterThan(0); expect(goal.getUint16(18, true)).toBeGreaterThan(0);
    expect(f.memory.span(150, 2)).toEqual(new Uint8Array(2).fill(0xa5));
    expect(f.call(575, 64, 1, 4095, 3, TravelFlags.DEFAULT, 128, -2, 1)).toBe(1);
    expect(f.call(575, 64, 1, 0, 3, TravelFlags.DEFAULT, 4074, 1, 1)).toBe(1);
    expect(f.memory.view(4074, 22).getInt32(12, true)).toBe(2);
    expect(f.call(575, 0, 0, 0, 3, 0, 0, 1, 1)).toBe(0);
  });

  test("clears movement before reading aliased inputs and skips an unused command vector", () => {
    const f = fixture(); f.ready(); putVector(f.memory, 64, vec3(200, 1, 10)); putVector(f.memory, 80, vec3(3, 4, 5));
    expect(f.call(318, 128, -1, 64, 2, 0, 80, 0, 0, 0, float32ToBits(0.1), 2048, 0, 0)).toBe(1);
    const move = f.memory.view(128, 84);
    expect(vector(f.memory, 128)).toEqual(vec3(200, 1, 10.25)); expect(move.getInt32(12, true)).toBe(1);
    expect(vector(f.memory, 144)).toEqual(vec3(3, 4, 5)); expect(f.memory.span(156, 36)).toEqual(new Uint8Array(36));
    expect(move.getInt32(64, true)).toBe(2); expect(move.getInt32(80, true)).toBe(0);
    expect(() => f.call(318, 128, -1, 0, 2, 0, 80, 0, 0, 0, float32ToBits(0.1), 0, 0, 0)).toThrow("nonnull");
    expect(f.memory.span(128, 84)).toEqual(new Uint8Array(84));
    putVector(f.memory, 128, vec3(200, 1, 10));
    expect(f.call(318, 128, -1, 128, 2, 0, 80, 0, 0, 0, float32ToBits(0.1), 0, 0, 0)).toBe(1);
    expect(vector(f.memory, 128)).toEqual(vec3(0, 0, 0.25));
  });

  test("completes cold zero-frame movement and preserves reached host and diagnostic ordering", () => {
    const f = fixture();
    putVector(f.memory, 64, vec3(200, 1, 10)); putVector(f.memory, 80, vec3(3, 4, 5));
    const move = qvmAasClientMoveOutput(f.memory, 128);
    const predict = (maxFrames: number, presence = -2147483648) =>
      f.call(318, 128, -1, 64, presence, 0, 80, 0, 0, maxFrames, float32ToBits(0.1), 0, 0, 0);
    for (const frames of [0, -1]) {
      f.messages.length = 0;
      expect(predict(frames)).toBe(1);
      expect(move.end).toEqual(vec3(200, 1, 10.25)); expect(move.endArea).toBe(0);
      expect(move.velocity).toEqual(vec3(3, 4, 5)); expect(move.presence).toBe(-2147483648);
      expect(move.frames).toBe(0); expect(f.points).toEqual([]);
      expect(f.messages).toEqual([{ severity: 3, text: "AAS_PointAreaNum: aas not loaded\n" }]);
    }
    const failure = new Error("cold area diagnostic aborted");
    f.controls.print = () => { throw failure; };
    expect(() => predict(0)).toThrow(failure);
    expect(move.end).toEqual(vec3(200, 1, 10.25)); expect(move.velocity).toEqual(zero);
    expect(move.presence).toBe(0);
    f.controls.print = () => undefined;
    f.controls.contents = point => {
      expect(point).toEqual(vec3(200, 1, 8.25));
      expect(f.memory.span(128, 84)).toEqual(new Uint8Array(84));
      return 0;
    };
    expect(() => predict(1, 4)).toThrow("source null world allocation");
    expect(f.points).toEqual([vec3(200, 1, 8.25)]);
    f.controls.contents = () => 0;
    f.ready(); f.aas.shutdown(); f.messages.length = 0; f.points.length = 0;
    expect(predict(0, 6)).toBe(1); expect(move.presence).toBe(6); expect(f.points).toEqual([]);
    expect(f.messages).toEqual([{ severity: 3, text: "AAS_PointAreaNum: aas not loaded\n" }]);
  });

  test("predicts with parsed data before spatial initialization and borrows retained heads with the current host", () => {
    const f = fixture(), failure = new Error("loaded diagnostic interrupted");
    f.controls.print = text => { if (text === "loaded maps/authored.aas\n") throw failure; return undefined; };
    expect(() => f.load()).toThrow(failure); expect(f.aas.phase.kind).toBe("data-loaded");
    putVector(f.memory, 64, vec3(200, 0, 10)); putVector(f.memory, 80, vec3(-2000, 0, 0));
    const predict = (entityNum: number) => f.call(318, 128, entityNum, 64, 6, 0, 80, 0, 0, 1, float32ToBits(0.1), 512, 2, 0);
    const move = qvmAasClientMoveOutput(f.memory, 128);
    f.messages.length = 0;
    expect(predict(-1)).toBe(1); expect(move.endArea).toBe(2); expect(move.presence).toBe(6);
    expect(move.end).toEqual(vec3(100, 0, 10.25)); expect(move.velocity).toEqual(vec3(-2000, 0, 0));
    expect(move.stopEvent).toBe(512); expect(f.messages).toEqual([]);
    expect(() => predict(0)).toThrow("source null entity-link heads");
    expect(f.messages).toEqual([{ severity: 4, text: "AAS_PresenceTypeBoundingBox: unknown presence type\n" }]);
    f.controls.print = () => undefined; f.ready(); f.aas.updateEntity(1, entity());
    f.controls.print = text => { if (text === "loaded maps/authored.aas\n") throw failure; return undefined; };
    const entities: number[] = [];
    const host: AasMapSpatialHost = { ...f.spatialHost,
      entityTrace: (entityNum, _start, end) => {
        entities.push(entityNum);
        return { fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 };
      },
    };
    expect(() => f.load(undefined, host)).toThrow(failure); expect(f.aas.phase.kind).toBe("data-loaded");
    f.messages.length = 0;
    expect(predict(0)).toBe(1); expect(entities).toEqual([1]);
    expect(move.endArea).toBe(2); expect(move.presence).toBe(6);
    expect(move.velocity).toEqual(vec3(-2000, 0, -80));
    expect(f.messages).toEqual(Array.from({ length: 2 }, () => ({ severity: 4, text: "AAS_PresenceTypeBoundingBox: unknown presence type\n" })));
  });

  test("preserves raw prediction presence until a source crouch transition", () => {
    const f = fixture(); f.load();
    putVector(f.memory, 64, vec3(200, 0, 10)); putVector(f.memory, 80, zero);
    putVector(f.memory, 96, vec3(0, 0, -400));
    const move = qvmAasClientMoveOutput(f.memory, 128);
    for (const presence of [0, 1, 6, -2147483648, 2147483647]) {
      f.messages.length = 0;
      expect(f.call(318, 128, -1, 64, presence, 0, 80, 0, 0, 0, float32ToBits(0.1), 0, 0, 0)).toBe(1);
      expect(move.presence).toBe(presence); expect(move.end).toEqual(vec3(200, 0, 10.25));
      expect(f.messages).toEqual([]);
    }
    f.aas.startFrame(0.25); f.messages.length = 0;
    expect(f.call(318, 128, -1, 64, 6, 0, 80, 0, 0, 1, float32ToBits(0.1), 0, 0, 0)).toBe(1);
    expect(move.presence).toBe(6); expect(move.frames).toBe(1); expect(f.messages).toEqual([]);
    expect(f.call(318, 128, -1, 64, 1, 1, 80, 96, 1, 1, float32ToBits(0.1), 0, 0, 0)).toBe(1);
    expect(move.presence).toBe(4); expect(move.frames).toBe(1); expect(f.messages).toEqual([]);
  });

  test("publishes a reached movement area and the complete actual AAS trace", () => {
    const f = fixture(); f.ready(); putVector(f.memory, 64, vec3(200, 0, 10)); putVector(f.memory, 80, vec3(-2000, 0, 0));
    expect(f.call(318, 128, -1, 64, 2, 0, 80, 0, 0, 3, float32ToBits(0.1), 512, 2, 0)).toBe(1);
    const move = f.memory.view(128, 84);
    expect(vector(f.memory, 128)).toEqual(vec3(100, 0, 6.25));
    expect(move.getInt32(12, true)).toBe(2); expect(vector(f.memory, 144)).toEqual(vec3(-2000, 0, -80));
    expect(move.getInt32(28, true)).toBe(0); expect(move.getFloat32(32, true)).toBe(1);
    expect(vector(f.memory, 164)).toEqual(vec3(0, 0, 2.25));
    expect(move.getInt32(48, true)).toBe(0); expect(move.getInt32(52, true)).toBe(2);
    expect(move.getInt32(56, true)).toBe(0); expect(move.getInt32(60, true)).toBe(0);
    expect(move.getInt32(64, true)).toBe(2); expect(move.getInt32(68, true)).toBe(512);
    expect(move.getInt32(72, true)).toBe(0); expect(move.getFloat32(76, true)).toBe(0); expect(move.getInt32(80, true)).toBe(0);
  });
});
