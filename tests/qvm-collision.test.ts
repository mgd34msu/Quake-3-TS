import { describe, expect, test } from "bun:test";
import type { BspMap, BspPlane } from "../src/assets/bsp.ts";
import { parseQvm, QvmOpcode } from "../src/assets/qvm.ts";
import { SourceClipModels } from "../src/collision/clip-models.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { vec2, vec3, vec4 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { qvmCollisionSyscall } from "../src/vm/collision-syscalls.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { QVM_TRACE_BYTES, writeQvmTrace } from "../src/vm/trace-record.ts";
import type { QvmTraceRecord } from "../src/vm/trace-record.ts";

function emptyTrace(): QvmTraceRecord {
  return {
    allSolid: false, startSolid: false, fraction: 1, end: vec3(0, 0, 0),
    plane: { normal: vec3(0, 0, 0), distance: 0, type: 0, signbits: 0 },
    surfaceFlags: 0, contents: 0, entityNum: 0,
  };
}

function boxPlanes(bounds: Bounds): BspPlane[] {
  return [
    { normal: vec3(-1, 0, 0), distance: -bounds.min.x }, { normal: vec3(1, 0, 0), distance: bounds.max.x },
    { normal: vec3(0, -1, 0), distance: -bounds.min.y }, { normal: vec3(0, 1, 0), distance: bounds.max.y },
    { normal: vec3(0, 0, -1), distance: -bounds.min.z }, { normal: vec3(0, 0, 1), distance: bounds.max.z },
  ];
}

function boxMap(count = 2, bounds: Bounds = { min: vec3(-10, -10, -10), max: vec3(10, 10, 10) }): BspMap {
  const planes = boxPlanes(bounds);
  return {
    entities: "", entityRecords: [], shaders: [{ name: "solid", surfaceFlags: 8, contentFlags: 1 }], planes,
    nodes: [{ plane: 0, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: Array.from({ length: count }, () => ({ bounds,
      firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 })),
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null,
  };
}

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (const [index, value] of values.entries()) view.setInt32(index * 4, value, true);
  return view;
}

function vector(memory: QvmMemory, pointer: number, value: Vec3): void {
  const view = memory.view(pointer, 12);
  view.setFloat32(0, value.x, true); view.setFloat32(4, value.y, true); view.setFloat32(8, value.z, true);
}

function fixture(map = boxMap()) {
  const world = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const models = new SourceClipModels(world), memory = new QvmMemory(new Uint8Array(1024));
  const call = (...args: number[]) => qvmCollisionSyscall("cgame", words(...args), memory, models);
  const output = memory.view(256, QVM_TRACE_BYTES);
  vector(memory, 32, vec3(20, 0, 0)); vector(memory, 48, vec3(0, 0, 0));
  vector(memory, 64, vec3(-2, -2, -4)); vector(memory, 80, vec3(2, 2, 4));
  vector(memory, 96, vec3(0, 0, 0)); vector(memory, 112, vec3(0, 0, 0));
  return { world, models, memory, call, output };
}

describe("source QVM trace_t record", () => {
  test("writes all 56 source bytes and leaves allocation guards untouched", () => {
    const bytes = new Uint8Array(64).fill(0xa5);
    const view = new DataView(bytes.buffer, 4, QVM_TRACE_BYTES);
    writeQvmTrace(view, {
      allSolid: true, startSolid: false, fraction: 0.5, end: vec3(1, -2, 3),
      plane: { normal: vec3(-1, 0, 0), distance: 10, type: 3, signbits: 1 },
      surfaceFlags: 0x12345678, contents: -2147483648, entityNum: 1022,
    });
    expect([...bytes.subarray(4, 60)]).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63,
      0, 0, 128, 63, 0, 0, 0, 192, 0, 0, 64, 64,
      0, 0, 128, 191, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 32, 65, 3, 1, 0, 0,
      120, 86, 52, 18, 0, 0, 0, 128, 254, 3, 0, 0,
    ]);
    expect([...bytes.subarray(0, 4)]).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
    expect([...bytes.subarray(60)]).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
  });

  test("cleared plane and padding overwrite stale destination bytes", () => {
    const bytes = new Uint8Array(60).fill(0xff);
    writeQvmTrace(new DataView(bytes.buffer), emptyTrace());
    const expected = new Uint8Array(QVM_TRACE_BYTES);
    expected[10] = 128;
    expected[11] = 63;
    expect(bytes.subarray(0, QVM_TRACE_BYTES)).toEqual(expected);
    expect([...bytes.subarray(QVM_TRACE_BYTES)]).toEqual([255, 255, 255, 255]);
  });

  test("preserves independent solidity words and retained invalid-plane fields", () => {
    const view = new DataView(new ArrayBuffer(QVM_TRACE_BYTES));
    writeQvmTrace(view, { ...emptyTrace(), allSolid: true, startSolid: true,
      plane: { normal: vec3(1, 2, 3), distance: 4, type: 5, signbits: 6 },
      surfaceFlags: 8, contents: 1 });
    expect(view.getInt32(0, true)).toBe(1);
    expect(view.getInt32(4, true)).toBe(1);
    expect(view.getFloat32(24, true)).toBe(1);
    expect(view.getFloat32(36, true)).toBe(4);
    expect(view.getUint8(40)).toBe(5);
    expect(view.getUint8(41)).toBe(6);
    expect(view.getInt32(44, true)).toBe(8);
  });

  test("rejects every truncated record before the first write", () => {
    for (let length = 0; length < QVM_TRACE_BYTES; length++) {
      const bytes = new Uint8Array(64).fill(0x7d);
      expect(() => writeQvmTrace(new DataView(bytes.buffer, 3, length), emptyTrace()))
        .toThrow("record requires 56 bytes");
      expect(bytes).toEqual(new Uint8Array(64).fill(0x7d));
    }
  });
});

describe("cgame collision traps over actual map and temporary owners", () => {
  test("inline handles are actual model indexes and source invalid numbers reject", () => {
    const f = fixture();
    expect(f.call(19)).toBe(2);
    expect(f.call(20, 0)).toBe(0); expect(f.call(20, 1)).toBe(1);
    for (const index of [-1, 2, 255]) expect(() => f.call(20, index)).toThrow("CM_InlineModel: bad number");
    for (const handle of [-1, 2, 253, 254, 256, 2147483647]) {
      expect(() => f.call(23, 48, handle)).toThrow("CM_ClipHandleToModel: bad handle");
    }
    expect(() => f.call(23, 48, 2147483647)).toThrow("-2147483393");
    expect(f.call(23, 48, 0)).toBe(1); expect(f.call(23, 32, 1)).toBe(0);
  });

  test("temporary calls reuse handle255 and capsule bounds preserve prior brush planes", () => {
    const f = fixture();
    expect(f.call(22, 64, 80)).toBe(255);
    expect(f.call(23, 48, 255)).toBe(0x02000000);
    vector(f.memory, 32, vec3(5, 0, 0));
    expect(f.call(23, 32, 255)).toBe(0);
    vector(f.memory, 64, vec3(-10, -10, -20)); vector(f.memory, 80, vec3(10, 10, 20));
    expect(f.call(82, 64, 80)).toBe(254);
    expect(f.models.modelBounds(255)).toEqual({ min: vec3(-10, -10, -20), max: vec3(10, 10, 20) });
    expect(f.call(23, 32, 255)).toBe(0);
    expect(() => f.call(23, 48, 254)).toThrow("2 < 254 < 256");
    expect(() => f.call(83, 256, 32, 48, 64, 80, 254, -1)).toThrow("2 < 254 < 256");
    expect(f.call(22, 64, 80)).toBe(255);
    expect(f.call(23, 32, 255)).toBe(0x02000000);
    const independent = fixture();
    expect(independent.call(23, 32, 255)).toBe(0);
  });

  test("box traces write the source epsilon, all fields, zero entity identity and masked rejection", () => {
    const f = fixture();
    f.memory.bytes.fill(0xa5, 255, 313);
    expect(f.call(25, 256, 32, 48, 0, 0, 0, 1)).toBe(0);
    expect(f.output.getFloat32(8, true)).toBe(Math.fround(9.875 / 20));
    expect(f.output.getFloat32(12, true)).toBe(10.125);
    expect(f.output.getFloat32(24, true)).toBe(1);
    expect(f.output.getFloat32(36, true)).toBe(10);
    expect([...f.memory.span(296, 4)]).toEqual([0, 0, 0, 0]);
    expect(f.output.getInt32(44, true)).toBe(8); expect(f.output.getInt32(48, true)).toBe(1);
    expect(f.output.getInt32(52, true)).toBe(0);
    expect(f.memory.bytes[255]).toBe(0xa5); expect(f.memory.bytes[312]).toBe(0xa5);
    f.call(25, 256, 32, 48, 0, 0, 0, 32);
    expect(f.output.getFloat32(8, true)).toBe(1);
    expect([...f.memory.span(280, 32)]).toEqual(new Array<number>(32).fill(0));
  });

  test("each null size vector independently denotes zero and zero-address masked words are data", () => {
    const f = fixture();
    f.call(25, 256, 32, 48, 64, 0, 0, 1);
    expect(f.output.getFloat32(12, true)).toBe(12.125);
    f.call(25, 256, 32, 48, 0, 80, 0, 1);
    expect(f.output.getFloat32(12, true)).toBe(10.125);
    vector(f.memory, 1024, vec3(-3, -3, -3));
    f.call(25, 256, 32, 48, 1024, 0, 0, 1);
    expect(f.output.getFloat32(12, true)).toBe(13.125);
    f.call(25, 256, -992, 48, 0, 0, 0, 1);
    expect(f.output.getFloat32(12, true)).toBe(10.125);
  });

  test("exiting, stationary and all-solid output words preserve their distinct source states", () => {
    const f = fixture();
    f.call(25, 256, 48, 32, 0, 0, 0, 1);
    expect(f.output.getInt32(0, true)).toBe(0); expect(f.output.getInt32(4, true)).toBe(1);
    expect(f.output.getFloat32(8, true)).toBe(1); expect(f.output.getInt32(48, true)).toBe(0);
    f.call(25, 256, 48, 48, 0, 0, 0, 1);
    expect(f.output.getInt32(0, true)).toBe(1); expect(f.output.getInt32(4, true)).toBe(1);
    expect(f.output.getFloat32(8, true)).toBe(0); expect(f.output.getInt32(48, true)).toBe(1);
    expect([...f.memory.span(280, 20)]).toEqual(new Array<number>(20).fill(0));
  });

  test("transformed boxes and capsules retain pre-rotation plane metadata", () => {
    const f = fixture();
    vector(f.memory, 32, vec3(100, 20, 0)); vector(f.memory, 48, vec3(100, 0, 0));
    vector(f.memory, 96, vec3(100, 0, 0)); vector(f.memory, 112, vec3(0, 90, 0));
    expect(f.call(24, 48, 1, 96, 112)).toBe(1);
    expect(f.call(26, 256, 32, 48, 0, 0, 1, 1, 96, 112)).toBe(0);
    expect(f.output.getFloat32(16, true)).toBe(10.125);
    expect(f.output.getFloat32(28, true)).toBeCloseTo(1, 6);
    expect(f.output.getUint8(40)).toBe(0); expect(f.output.getUint8(41)).toBe(0);
    vector(f.memory, 32, vec3(0, 0, 30)); vector(f.memory, 48, vec3(0, 0, 0));
    vector(f.memory, 96, vec3(0, 0, 0)); vector(f.memory, 112, vec3(90, 0, 0));
    f.call(26, 256, 32, 48, 64, 80, 1, 1, 96, 112);
    expect(f.output.getFloat32(20, true)).toBe(12.125);
    f.call(84, 256, 32, 48, 64, 80, 1, 1, 96, 112);
    // Source stores fraction, then the product, then the end coordinate in binary32.
    const capsuleEnd = Math.fround(30 - Math.fround(Math.fround(15.875 / 30) * 30));
    expect(f.output.getFloat32(20, true)).toBe(capsuleEnd);
    expect(f.output.getUint8(40)).toBe(3); expect(f.output.getUint8(41)).toBe(1);
    f.call(83, 256, 32, 48, 64, 80, 1, 1);
    expect(f.output.getFloat32(20, true)).toBe(capsuleEnd);
  });

  test("temporary negative Y/Z planes keep source types4/5 and box transforms ignore rotation", () => {
    const f = fixture();
    f.call(22, 64, 80);
    vector(f.memory, 112, vec3(90, 90, 90));
    vector(f.memory, 32, vec3(0, -20, 0));
    f.call(26, 256, 32, 48, 0, 0, 255, 0x02000000, 96, 112);
    expect(f.output.getFloat32(16, true)).toBe(-2.125);
    expect(f.output.getUint8(40)).toBe(4); expect(f.output.getUint8(41)).toBe(2);
    vector(f.memory, 32, vec3(0, 0, -20));
    f.call(84, 256, 32, 48, 0, 0, 255, 0x02000000, 96, 112);
    expect(f.output.getFloat32(20, true)).toBe(-4.125);
    expect(f.output.getUint8(40)).toBe(5); expect(f.output.getUint8(41)).toBe(4);
  });

  test("real model255 precedes the temporary hull while its transform still ignores angles", () => {
    const f = fixture(boxMap(256, { min: vec3(-1, -2, -8), max: vec3(1, 2, 8) }));
    expect(f.call(19)).toBe(256); expect(f.call(20, 255)).toBe(255);
    vector(f.memory, 64, vec3(-30, -30, -30)); vector(f.memory, 80, vec3(30, 30, 30));
    expect(f.call(22, 64, 80)).toBe(255);
    vector(f.memory, 32, vec3(5, 0, 0)); vector(f.memory, 112, vec3(90, 0, 0));
    expect(f.call(23, 32, 255)).toBe(0);
    expect(f.call(24, 32, 255, 96, 112)).toBe(0);
    f.call(26, 256, 32, 48, 0, 0, 255, 1, 96, 112);
    expect(f.output.getFloat32(12, true)).toBe(1.125);
    expect(f.output.getInt32(48, true)).toBe(1);
  });

  test("box handle transforms never dereference unused angles, including real model255", () => {
    for (const modelCount of [2, 256]) {
      const f = fixture(boxMap(modelCount)), contents = modelCount === 2 ? 0x02000000 : 1;
      f.call(22, 64, 80);
      const expectedContents = f.call(24, 48, 255, 96, 112);
      expect(expectedContents).toBe(contents);
      for (const angles of [0, 1023]) {
        expect(f.call(24, 48, 255, 96, angles)).toBe(expectedContents);
        for (const trap of [26, 84]) {
          f.call(trap, 256, 32, 48, 0, 0, 255, contents, 96, 112);
          const expected = f.memory.span(256, QVM_TRACE_BYTES).slice();
          expect(f.call(trap, 256, 32, 48, 0, 0, 255, contents, 96, angles)).toBe(0);
          expect(f.memory.span(256, QVM_TRACE_BYTES)).toEqual(expected);
        }
      }
      expect(() => f.call(24, 48, 1, 96, 0)).toThrow();
    }
  });

  test("real model254 supplies expanded capsule bounds and box traces replace retained hull state", () => {
    const f = fixture(boxMap(255, { min: vec3(-9, -9, -19), max: vec3(9, 9, 19) }));
    vector(f.memory, 32, vec3(30, 0, 0));
    f.call(83, 256, 32, 48, 64, 80, 254, 0);
    expect(f.output.getFloat32(12, true)).toBeCloseTo(13, 3);
    expect(f.output.getInt32(48, true)).toBe(0x02000000);
    expect(f.output.getUint8(40)).toBe(0); expect(f.output.getUint8(41)).toBe(0);
    f.call(25, 256, 32, 48, 64, 80, 254, 0x02000000);
    expect(f.output.getFloat32(12, true)).toBe(12.125);
    expect(f.models.modelBounds(255)).toEqual({ min: vec3(-2, -2, -4), max: vec3(2, 2, 4) });
    vector(f.memory, 32, vec3(3, 0, 0));
    expect(f.call(23, 32, 255)).toBe(0);
  });

  test("box-through-capsule replacement traces real model255 and preserves original position bounds", () => {
    const original = boxMap(256, { min: vec3(-9, -9, -19), max: vec3(9, 9, 19) });
    const f = fixture(original);
    vector(f.memory, 32, vec3(30, 0, 0));
    f.call(25, 256, 32, 48, 64, 80, 254, 1);
    expect(f.output.getFloat32(12, true)).toBe(19.125);
    expect(f.output.getInt32(48, true)).toBe(1);
    f.call(25, 256, 32, 48, 64, 80, 254, 0x02000000);
    expect(f.output.getFloat32(8, true)).toBe(1);
    vector(f.memory, 32, vec3(0, 30, 0)); vector(f.memory, 112, vec3(0, 90, 0));
    f.call(26, 256, 32, 48, 64, 80, 254, 1, 96, 112);
    expect(f.output.getFloat32(16, true)).toBe(19.125);
    expect(f.output.getFloat32(28, true)).toBeCloseTo(1, 6);
    expect(f.output.getUint8(40)).toBe(0);
    vector(f.memory, 32, vec3(12, 0, 0));
    f.call(25, 256, 32, 32, 64, 80, 254, 1);
    expect(f.output.getFloat32(8, true)).toBe(1);
    const offset = fixture({ ...original, models: original.models.map((model, index) => index === 254
      ? { ...model, bounds: { min: vec3(90, -9, -19), max: vec3(110, 9, 19) } } : model) });
    vector(offset.memory, 32, vec3(8, 0, 0));
    offset.call(25, 256, 32, 32, 64, 80, 254, 1);
    expect(offset.output.getInt32(0, true)).toBe(1);
    expect(offset.output.getInt32(4, true)).toBe(1);
    expect(offset.output.getFloat32(8, true)).toBe(0);
  });

  test("a point box-through-capsule swap retains point patch clipping on real model255", () => {
    const original = boxMap(256, { min: vec3(-9, -9, -19), max: vec3(9, 9, 19) });
    const f = fixture({ ...original,
      models: original.models.map((model, index) => index === 255 ? { ...model, brushCount: 0, surfaceCount: 1 } : model),
      vertices: Array.from({ length: 9 }, (_, index) => ({ position: vec3(index % 3 * 32 - 32, Math.floor(index / 3) * 32 - 32, 15),
        texCoord: vec2(0, 0), lightmapCoord: vec2(0, 0), normal: vec3(0, 0, 1), color: vec4(255, 255, 255, 255) })),
      surfaces: [{ type: "patch", shader: 0, fog: -1, firstVertex: 0, vertexCount: 9, firstIndex: 0, indexCount: 0,
        lightmap: -1, lightmapX: 0, lightmapY: 0, lightmapWidth: 0, lightmapHeight: 0, lightmapOrigin: vec3(0, 0, 0),
        lightmapVectors: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 1)], patchWidth: 3, patchHeight: 3 }] });
    vector(f.memory, 32, vec3(0, 0, 40));
    f.call(25, 256, 32, 48, 0, 0, 254, 1);
    expect(f.output.getFloat32(20, true)).toBe(15.125);
    expect(f.output.getFloat32(8, true)).toBe(Math.fround(24.875 / 40));
    expect(f.output.getFloat32(32, true)).toBe(1);
    expect(f.output.getUint8(40)).toBe(0); expect(f.output.getUint8(41)).toBe(0);
  });

  test("no-node point contents precedes lookup while trace lookup precedes the cleared result", () => {
    const f = fixture({ ...boxMap(), nodes: [] });
    expect(f.call(23, 32, -1)).toBe(0);
    expect(f.call(23, 0, -1)).toBe(0);
    expect(() => f.call(25, 256, 32, 48, 0, 0, -1, 1)).toThrow("bad handle -1");
    expect(() => f.call(25, 256, 0, 0, 1016, 1016, -1, 1)).toThrow("bad handle -1");
    expect(f.call(25, 256, 0, 0, 1016, 1016, 0, 1)).toBe(0);
    vector(f.memory, 48, vec3(7, 8, 9));
    f.call(25, 256, 32, 48, 0, 0, 0, 1);
    expect(f.output.getFloat32(8, true)).toBe(1);
    expect(f.output.getFloat32(12, true)).toBe(0);
    f.call(26, 256, 32, 48, 0, 0, 0, 1, 96, 112);
    expect(f.output.getFloat32(12, true)).toBe(7);
    expect(f.output.getFloat32(16, true)).toBe(8);
  });

  test("aliased output reads inputs first and truncated spans leave output untouched", () => {
    const f = fixture();
    f.call(25, 32, 32, 48, 0, 0, 0, 1);
    expect(f.memory.view(32, QVM_TRACE_BYTES).getFloat32(12, true)).toBe(10.125);
    f.memory.span(256, QVM_TRACE_BYTES).fill(0xa5);
    for (const args of [[25, 256, 1016, 48, 0, 0, 0, 1], [25, 256, 0, 48, 0, 0, 0, 1],
      [26, 256, 48, 48, 0, 0, 0, 1, 96, 1016]]) {
      expect(() => f.call(...args)).toThrow();
      expect(f.memory.span(256, QVM_TRACE_BYTES)).toEqual(new Uint8Array(QVM_TRACE_BYTES).fill(0xa5));
    }
    expect(() => f.call(25, 976, 48, 48, 0, 0, 0, 1)).toThrow("exceeds allocation");
    expect(f.call(25, 968, 48, 48, 0, 0, 0, 1)).toBe(0);
    expect(() => f.call(25, 256)).toThrow();
    expect(() => f.call(22, 0, 80)).toThrow("nonnull pointer");
  });

  test("other roles, map-loading lifecycle and unrelated traps remain unhandled", () => {
    const f = fixture();
    for (const role of ["game", "ui"] satisfies readonly ("game" | "ui")[]) {
      expect(qvmCollisionSyscall(role, new DataView(new ArrayBuffer(0)), f.memory, f.models)).toBeNull();
    }
    for (const trap of [18, 21, 27, 81, 85, 999]) expect(f.call(trap)).toBeNull();
  });
});

describe("source collision plane retention", () => {
  test("a later all-solid brush retains the earlier plane and surface bytes", () => {
    const original = boxMap();
    const enclosing = { min: vec3(-30, -30, -30), max: vec3(30, 30, 30) };
    const planes = [...original.planes, ...boxPlanes(enclosing)];
    const f = fixture({ ...original, planes,
      shaders: [...original.shaders, { name: "water", contentFlags: 32, surfaceFlags: 64 }],
      brushes: [...original.brushes, { firstSide: 6, sideCount: 6, shader: 1 }],
      brushSides: planes.map((_, plane) => ({ plane, shader: plane < 6 ? 0 : 1 })),
      models: original.models.map(model => ({ ...model, brushCount: 2 })) });
    f.call(25, 256, 32, 48, 0, 0, 1, 33);
    expect(f.output.getInt32(0, true)).toBe(1); expect(f.output.getInt32(4, true)).toBe(1);
    expect(f.output.getFloat32(8, true)).toBe(0);
    expect(f.output.getFloat32(24, true)).toBe(1); expect(f.output.getFloat32(36, true)).toBe(10);
    expect(f.output.getInt32(44, true)).toBe(8); expect(f.output.getInt32(48, true)).toBe(32);
    expect(f.world.trace({ start: vec3(20, 0, 0), end: vec3(0, 0, 0), shape: { kind: "point" }, mask: 33, modelIndex: 1 }).contact.kind).toBe("none");
  });

  test("a closer patch changes normal and distance while retaining copied brush type/signbits", () => {
    const original = boxMap(2, { min: vec3(-10, -10, -100), max: vec3(10, 10, 100) });
    const f = fixture({ ...original,
      shaders: [...original.shaders, { name: "patch", contentFlags: 32, surfaceFlags: 64 }],
      models: original.models.map(model => ({ ...model, surfaceCount: 1 })),
      vertices: Array.from({ length: 9 }, (_, index) => ({ position: vec3(index % 3 * 32 - 32, Math.floor(index / 3) * 32 - 32, 15),
        texCoord: vec2(0, 0), lightmapCoord: vec2(0, 0), normal: vec3(0, 0, 1), color: vec4(255, 255, 255, 255) })),
      surfaces: [{ type: "patch", shader: 1, fog: -1, firstVertex: 0, vertexCount: 9, firstIndex: 0, indexCount: 0,
        lightmap: -1, lightmapX: 0, lightmapY: 0, lightmapWidth: 0, lightmapHeight: 0, lightmapOrigin: vec3(0, 0, 0),
        lightmapVectors: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 1)], patchWidth: 3, patchHeight: 3 }] });
    vector(f.memory, 32, vec3(-20, 0, 20));
    f.call(25, 256, 32, 48, 0, 0, 1, 33);
    expect(f.output.getFloat32(8, true)).toBe(Math.fround(4.875 / 20));
    expect(f.output.getFloat32(24, true)).toBe(0); expect(f.output.getFloat32(32, true)).toBe(1);
    expect(f.output.getFloat32(36, true)).toBe(15);
    expect(f.output.getUint8(40)).toBe(3); expect(f.output.getUint8(41)).toBe(1);
    expect(f.output.getInt32(44, true)).toBe(64); expect(f.output.getInt32(48, true)).toBe(32);
  });
});

test("authored interpreted cgame bytecode reads an actual collision trace record", async () => {
  const f = fixture();
  const code = new BinaryWriter(128);
  code.u8(QvmOpcode.OP_ENTER); code.i32(48);
  for (const [index, value] of [256, 32, 48, 0, 0, 0, 1].entries()) {
    code.u8(QvmOpcode.OP_CONST); code.i32(value); code.u8(QvmOpcode.OP_ARG); code.u8(8 + index * 4);
  }
  code.u8(QvmOpcode.OP_CONST); code.i32(-26); code.u8(QvmOpcode.OP_CALL); code.u8(QvmOpcode.OP_POP);
  code.u8(QvmOpcode.OP_CONST); code.i32(268); code.u8(QvmOpcode.OP_LOAD4); code.u8(QvmOpcode.OP_LEAVE); code.i32(48);
  const instructions = code.finish(), file = new BinaryWriter(instructions.length + 32);
  for (const value of [0x12721444, 21, 32, instructions.length, 32 + instructions.length, 0, 0, 1024]) file.i32(value);
  file.bytes(instructions);
  const vm = new QvmInterpreter(parseQvm(file.finish(), "authored-collision.qvm"), call => {
    const result = qvmCollisionSyscall("cgame", call.words, new QvmMemory(call.memory), f.models);
    if (result === null) throw new Error("Unexpected authored collision trap");
    return result;
  });
  vector(new QvmMemory(vm.memory), 32, vec3(20, 0, 0));
  expect(await vm.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0x41220000);
});
