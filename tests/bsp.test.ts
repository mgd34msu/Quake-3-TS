import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";

function record(size: number, write: (writer: BinaryWriter) => void): Uint8Array {
  const writer = new BinaryWriter(size);
  write(writer);
  const result = writer.finish();
  expect(result.length).toBe(size);
  return result;
}

function fixture(): Uint8Array {
  const lumps: Uint8Array[] = Array.from({ length: 17 }, () => new Uint8Array(0));
  lumps[0] = new TextEncoder().encode('{\n"classname" "worldspawn"\n"message" "BSP test"\n}\n\0');
  lumps[1] = record(72, w => { w.bytes(new TextEncoder().encode("textures/test/wall")); w.bytes(new Uint8Array(46)); w.i32(0x80); w.i32(1); });
  lumps[2] = record(16, w => { w.f32(1); w.f32(0); w.f32(0); w.f32(16); });
  lumps[3] = record(36, w => { w.i32(0); w.i32(-1); w.i32(-1); for (const value of [-32, -32, -32, 32, 32, 32]) w.i32(value); });
  lumps[4] = record(48, w => {
    w.i32(0); w.i32(0);
    for (const value of [-32, -32, -32, 32, 32, 32]) w.i32(value);
    w.i32(0); w.i32(4); w.i32(0); w.i32(1);
  });
  lumps[5] = record(16, w => { for (let i = 0; i < 4; i++) w.i32(i); });
  lumps[6] = record(4, w => { w.i32(0); });
  lumps[7] = record(40, w => {
    for (const value of [-32, -32, -32, 32, 32, 32]) w.f32(value);
    w.i32(0); w.i32(4); w.i32(0); w.i32(1);
  });
  lumps[8] = record(12, w => { w.i32(0); w.i32(6); w.i32(0); });
  lumps[9] = record(48, w => { for (let i = 0; i < 6; i++) { w.i32(0); w.i32(0); } });
  lumps[10] = record(44 * 12, w => {
    for (let i = 0; i < 12; i++) {
      w.f32(i); w.f32(i + 0.5); w.f32(-i);
      w.f32(0.25); w.f32(0.75); w.f32(0.125); w.f32(0.875);
      w.f32(0); w.f32(0); w.f32(1);
      w.u8(12); w.u8(34); w.u8(56); w.u8(255);
    }
  });
  lumps[11] = record(12, w => { w.i32(0); w.i32(1); w.i32(2); });
  lumps[12] = record(72, w => { w.bytes(new TextEncoder().encode("fog")); w.bytes(new Uint8Array(61)); w.i32(0); w.i32(-1); });
  lumps[13] = record(104 * 4, w => {
    for (let type = 1; type <= 4; type++) {
      w.i32(0); w.i32(type === 4 ? -1 : 0); w.i32(type);
      w.i32(type === 2 ? 3 : 0); w.i32(type === 2 ? 9 : type === 4 ? 0 : 3);
      w.i32(0); w.i32(type === 2 || type === 4 ? 0 : 3);
      w.i32(type === 4 ? -1 : 0);
      w.i32(8); w.i32(16); w.i32(32); w.i32(64);
      for (let field = 0; field < 12; field++) w.f32(field + 0.5);
      w.i32(type === 2 ? 3 : 0); w.i32(type === 2 ? 3 : 0);
    }
  });
  lumps[14] = new Uint8Array(128 * 128 * 3).fill(127);
  lumps[15] = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  lumps[16] = record(9, w => { w.i32(1); w.i32(1); w.u8(1); });
  const output = new BinaryWriter(144 + lumps.reduce((sum, lump) => sum + lump.length, 0));
  output.bytes(new TextEncoder().encode("IBSP")); output.i32(46);
  let offset = 144;
  for (const lump of lumps) { output.i32(offset); output.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) output.bytes(lump);
  return output.finish();
}

function lumpOffset(data: Uint8Array, lump: number): number { return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(8 + lump * 8, true); }
function changeInt(data: Uint8Array, lump: number, offset: number, value: number): number {
  const absolute = lumpOffset(data, lump) + offset;
  new DataView(data.buffer, data.byteOffset, data.byteLength).setInt32(absolute, value, true);
  return absolute;
}
function expectError(data: Uint8Array, offset: number, message: string): void {
  try { parseBsp(data, "fixture.bsp"); throw new Error("accepted corrupt BSP"); }
  catch (error) {
    expect(error).toBeInstanceOf(BinaryError);
    if (!(error instanceof BinaryError)) throw error;
    expect(error.source).toBe("fixture.bsp");
    expect(error.offset).toBe(offset);
    expect(error.message).toContain(message);
  }
}

describe("BSP v46", () => {
  test("decodes all 17 lumps with exact stored values", () => {
    const map = parseBsp(fixture());
    expect(map.entities).toContain('"message" "BSP test"');
    expect(map.entityRecords[0]?.get("classname")).toBe("worldspawn");
    expect(map.shaders).toEqual([{ name: "textures/test/wall", surfaceFlags: 128, contentFlags: 1 }]);
    expect(map.planes).toEqual([{ normal: { x: 1, y: 0, z: 0 }, distance: 16 }]);
    expect(map.nodes[0]).toEqual({ plane: 0, children: [-1, -1], bounds: { min: { x: -32, y: -32, z: -32 }, max: { x: 32, y: 32, z: 32 } } });
    expect(map.leaves[0]?.surfaceCount).toBe(4);
    expect(map.leafSurfaces).toEqual([0, 1, 2, 3]);
    expect(map.leafBrushes).toEqual([0]);
    expect(map.models[0]?.brushCount).toBe(1);
    expect(map.brushes).toEqual([{ firstSide: 0, sideCount: 6, shader: 0 }]);
    expect(map.brushSides).toHaveLength(6);
    expect(map.brushSides[5]).toEqual({ plane: 0, shader: 0 });
    expect(map.vertices[1]).toEqual({ position: { x: 1, y: 1.5, z: -1 }, texCoord: { x: 0.25, y: 0.75 }, lightmapCoord: { x: 0.125, y: 0.875 }, normal: { x: 0, y: 0, z: 1 }, color: { x: 12, y: 34, z: 56, w: 255 } });
    expect(map.indices).toEqual([0, 1, 2]);
    expect(map.fogs).toEqual([{ shader: "fog", brush: 0, visibleSide: -1 }]);
    expect(map.surfaces.map(surface => surface.type)).toEqual(["planar", "patch", "triangles", "flare"]);
    expect(map.surfaces[0]).toEqual({ type: "planar", shader: 0, fog: 0, firstVertex: 0, vertexCount: 3, firstIndex: 0, indexCount: 3, lightmap: 0, lightmapX: 8, lightmapY: 16, lightmapWidth: 32, lightmapHeight: 64, lightmapOrigin: { x: 0.5, y: 1.5, z: 2.5 }, lightmapVectors: [{ x: 3.5, y: 4.5, z: 5.5 }, { x: 6.5, y: 7.5, z: 8.5 }, { x: 9.5, y: 10.5, z: 11.5 }], patchWidth: 0, patchHeight: 0 });
    expect(map.surfaces[1]?.patchWidth).toBe(3);
    expect(map.lightmaps[0]?.length).toBe(49152);
    expect(map.lightmaps[0]?.[49151]).toBe(127);
    expect(map.lightGrid).toEqual([{ ambient: { x: 1, y: 2, z: 3 }, directed: { x: 4, y: 5, z: 6 }, latLong: { x: 7, y: 8 } }]);
    expect(map.visibility).toEqual({ clusterCount: 1, bytesPerCluster: 1, bits: new Uint8Array([1]) });
  });

  test("supports a nonzero underlying buffer byte offset", () => {
    const data = fixture();
    const wrapped = new Uint8Array(data.length + 8);
    wrapped.set(data, 3);
    expect(parseBsp(wrapped.subarray(3, 3 + data.length)).planes[0]?.distance).toBe(16);
  });

  test("represents missing PVS as null and retains leaf clusters", () => {
    const data = fixture();
    new DataView(data.buffer).setInt32(12 + 16 * 8, 0, true);
    changeInt(data, 4, 0, 71);
    expect(parseBsp(data).visibility).toBeNull();
    expect(parseBsp(data).leaves[0]?.cluster).toBe(71);
  });

  test("copies byte lumps so callers can release their source buffer", () => {
    const data = fixture();
    const map = parseBsp(data);
    data.fill(0);
    expect(map.lightmaps[0]?.[0]).toBe(127);
    expect(map.visibility?.bits[0]).toBe(1);
  });

  test("preserves shipped flare fog and missing-lightmap values", () => {
    const data = fixture();
    const view = new DataView(data.buffer);
    view.setInt32(12 + 12 * 8, 0, true);
    view.setInt32(12 + 14 * 8, 0, true);
    for (let index = 0; index < 3; index++) changeInt(data, 13, index * 104 + 4, -1);
    changeInt(data, 13, 3 * 104 + 4, 0);
    const map = parseBsp(data);
    expect(map.fogs).toHaveLength(0);
    expect(map.surfaces[3]?.fog).toBe(0);
    expect(map.lightmaps).toHaveLength(0);
    expect(map.surfaces[0]?.lightmap).toBe(0);
  });

  test("preserves NaN unused lightmap UVs on unlit patches, rejects them when sampled", () => {
    const data = fixture();
    const offset = changeInt(data, 10, 3 * 44 + 24, -65281);
    expectError(data, offset, "non-finite lightmap coordinate");
    changeInt(data, 13, 104 + 28, -1);
    expect(Number.isNaN(parseBsp(data).vertices[3]?.lightmapCoord.y)).toBe(true);
  });

  test("rejects every truncation of the header and the last payload byte", () => {
    const data = fixture();
    for (let size = 0; size < 144; size++) expect(() => parseBsp(data.subarray(0, size))).toThrow(BinaryError);
    expect(() => parseBsp(data.subarray(0, data.length - 1))).toThrow(BinaryError);
  });

  test("rejects magic, version, negative, overflowing and header-overlapping lump ranges", () => {
    for (const [offset, value, message] of [
      [0, 0, "magic"], [4, 47, "version"], [8, -1, "range"], [12, -1, "range"],
      [8, 2147483647, "range"], [8, 100, "range"],
    ] satisfies [number, number, string][]) {
      const data = fixture();
      new DataView(data.buffer).setInt32(offset, value, true);
      expectError(data, offset === 12 ? 8 : offset, message);
    }
  });

  test("rejects each malformed fixed record stride", () => {
    for (let lump = 1; lump <= 15; lump++) {
      const data = fixture();
      const view = new DataView(data.buffer);
      const header = 12 + lump * 8;
      view.setInt32(header, view.getInt32(header, true) - 1, true);
      expectError(data, lumpOffset(data, lump), "multiple");
    }
  });

  test("rejects non-finite floats at their absolute file offsets", () => {
    for (const [lump, local] of [[2, 12], [7, 0], [10, 12], [13, 84]] satisfies [number, number][]) {
      const data = fixture();
      const offset = changeInt(data, lump, local, 0x7fc00000);
      expectError(data, offset, "non-finite");
    }
  });

  test("rejects corrupt cross references and nested ranges", () => {
    for (const [lump, local, value, message] of [
      [3, 0, 1, "node plane"], [3, 4, -2, "node child"], [3, 8, 1, "node child"],
      [4, 0, 1, "cluster"], [4, 4, -2, "area"], [4, 32, 1, "leaf surfaces"], [4, 40, -1, "leaf brushes"],
      [5, 0, 4, "leaf surface"], [6, 0, 1, "leaf brush"], [7, 24, 1, "model surfaces"], [7, 32, 1, "model brushes"],
      [8, 0, 1, "brush sides"], [8, 8, 1, "brush shader"], [9, 0, 1, "brush side plane"], [9, 4, 1, "brush side shader"],
      [12, 64, 1, "fog brush"], [12, 68, 6, "fog visible side"],
      [13, 0, 1, "surface shader"], [13, 4, 1, "surface fog"], [13, 8, 0, "surface type"],
      [13, 12, -1, "surface vertices"], [13, 20, 1, "surface indices"],
      [13, 28, -5, "lightmap sentinel"], [13, 104 + 96, 4, "patch control"], [11, 0, 3, "local vertex"],
    ] satisfies [number, number, number, string][]) {
      const data = fixture();
      const offset = changeInt(data, lump, local, value);
      expectError(data, offset, message);
    }
  });

  test("rejects a node cycle without recursive traversal", () => {
    const data = fixture();
    changeInt(data, 3, 4, 0);
    expectError(data, lumpOffset(data, 3), "cycle");
  });

  test("rejects malformed visibility dimensions and headers", () => {
    for (const [local, value] of [[0, -1], [0, 2], [4, 0], [4, -1], [4, 2147483647]] satisfies [number, number][]) {
      const data = fixture();
      changeInt(data, 16, local, value);
      expectError(data, lumpOffset(data, 16), "visibility dimensions");
    }
    const data = fixture();
    new DataView(data.buffer).setInt32(12 + 16 * 8, 4, true);
    expectError(data, lumpOffset(data, 16), "visibility header");
  });
});

const retailPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retailPath, "baseq3/pak0.pk3")))("loads every installed base and Team Arena BSP through the VFS", async () => {
  const hasMissionpack = existsSync(join(retailPath, "missionpack/pak0.pk3"));
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: hasMissionpack ? "missionpack" : "baseq3" });
  const names = vfs.list("maps").filter(name => name.startsWith("maps/") && name.endsWith(".bsp"));
  expect(names).toContain("maps/q3dm1.bsp");
  if (hasMissionpack) expect(names).toContain("maps/mpteam1.bsp");
  for (const name of names) {
    const bytes = await vfs.read(name);
    const map = parseBsp(bytes, name);
    expect(map.entityRecords[0]?.get("classname")).toBe("worldspawn");
    expect(map.models.length).toBeGreaterThan(0);
    expect(map.nodes.length).toBeGreaterThan(0);
    if (name === "maps/q3dm1.bsp") {
      expect(map.vertices).toHaveLength(13978);
      expect(map.surfaces).toHaveLength(2097);
      expect(map.lightmaps).toHaveLength(9);
    }
    if (name === "maps/mpteam1.bsp") {
      expect(map.vertices).toHaveLength(69060);
      expect(map.surfaces).toHaveLength(13455);
      expect(map.lightmaps).toHaveLength(30);
    }
    expect(() => parseBsp(bytes.subarray(0, 143), name)).toThrow(BinaryError);
  }
}, 60_000);
