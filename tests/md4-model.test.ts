/*
 * Synthetic model layouts follow qcommon/qfiles.h's MD4 records and the accesses in
 * renderer/tr_model.c:R_LoadMD4 and tr_animation.c:RB_SurfaceAnim.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, test } from "bun:test";
import { parseMd4 } from "../src/assets/md4.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";

// 100-byte header; two 40+2*48-byte frames; LODs with two/one surfaces.
// Each surface: 168-byte header, triangle, one bone reference, then vertices
// with two, zero, and one 20-byte weights. Vertex records have no extra padding.
const FRAME_START = 100;
const LOD_START = 372;
const SURFACE_START = 384;
const SURFACE_LENGTH = 316;
const VERTEX_START = SURFACE_START + 184;
const MODEL_END = 1344;

function string(writer: BinaryWriter, value: string): void {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
  writer.bytes(bytes);
}

function surface(writer: BinaryWriter, name: string): void {
  const start = writer.offset;
  writer.i32(123); // Source replaces the surface ident without a magic check.
  string(writer, name);
  string(writer, "Textures/Armor");
  writer.i32(-33); // Replaced by R_FindShader, not a retained runtime handle.
  writer.i32(-start);
  writer.i32(3);
  writer.i32(184);
  writer.i32(1);
  writer.i32(168);
  writer.i32(1);
  writer.i32(180);
  writer.i32(SURFACE_LENGTH);
  for (const value of [2, 0, 1, 0]) writer.i32(value);
  for (const count of [2, 0, 1]) {
    for (const value of [0, -0, 2, -0.25, 1.5]) writer.f32(value);
    writer.i32(count);
    for (let weight = 0; weight < count; weight++) {
      writer.i32(weight === 0 ? 1 : 0);
      writer.f32(weight === 0 ? 0.25 : 1.25);
      for (const value of [0.1, 2, -3]) writer.f32(value);
    }
  }
}

function fixture(): Uint8Array {
  const writer = new BinaryWriter(MODEL_END + 7);
  writer.u32(0x34504449);
  writer.i32(1);
  string(writer, "Models/Test.MD4");
  writer.i32(2);
  writer.i32(2);
  writer.i32(-0x80000000); // ofsBoneNames has no selected source reader.
  writer.i32(FRAME_START);
  writer.i32(2);
  writer.i32(LOD_START);
  writer.i32(MODEL_END);
  for (let frame = 0; frame < 2; frame++) {
    for (const value of [-1, -2, -3, 4, 5, 6, 0.5, 1.5, 2.5, 7]) writer.f32(value + frame);
    for (let bone = 0; bone < 2; bone++) {
      for (let entry = 1; entry <= 12; entry++) writer.f32(frame * 100 + bone * 20 + entry);
    }
  }
  writer.i32(2);
  writer.i32(12);
  writer.i32(644);
  surface(writer, "BODY_1");
  surface(writer, "HEAD");
  writer.i32(1);
  writer.i32(12);
  writer.i32(328);
  surface(writer, "LOD_1");
  writer.bytes(new Uint8Array([255, 254, 253, 252, 251, 250, 249]));
  return writer.finish();
}

function changed(offset: number, value: number): Uint8Array {
  const bytes = fixture();
  new DataView(bytes.buffer).setInt32(offset, value, true);
  return bytes;
}

describe("MD4 v1 reader", () => {
  test("reads source frame strides, row-major bone matrices, LOD/surface chains and variable weights", () => {
    const model = parseMd4(fixture(), "synthetic.md4");
    expect(model.version).toBe(1);
    expect(model.name).toBe("Models/Test.MD4");
    expect(model.byteLength).toBe(MODEL_END);
    expect(model.numBones).toBe(2);
    expect(model.frames).toHaveLength(2);
    expect(model.frames[0]?.bounds).toEqual({ min: { x: -1, y: -2, z: -3 }, max: { x: 4, y: 5, z: 6 } });
    expect(model.frames[1]?.localOrigin).toEqual({ x: 1.5, y: 2.5, z: 3.5 });
    expect(model.frames[1]?.radius).toBe(8);
    expect(model.frames[1]?.bones[1]?.matrix).toEqual([
      { x: 121, y: 122, z: 123, w: 124 },
      { x: 125, y: 126, z: 127, w: 128 },
      { x: 129, y: 130, z: 131, w: 132 },
    ]);
    expect(model.lods.map(lod => lod.surfaces.map(item => item.name))).toEqual([["body_1", "head"], ["lod_1"]]);
    const first = model.lods[0]?.surfaces[0];
    expect(first?.shader).toBe("Textures/Armor");
    expect(first?.triangles).toEqual([{ indices: [2, 0, 1] }]);
    expect(first?.boneReferences).toEqual([0]);
    expect(first?.vertices.map(vertex => vertex.weights.length)).toEqual([2, 0, 1]);
    expect(first?.vertices[0]?.weights).toEqual([
      { boneIndex: 1, boneWeight: 0.25, offset: { x: Math.fround(0.1), y: 2, z: -3 } },
      { boneIndex: 0, boneWeight: 1.25, offset: { x: Math.fround(0.1), y: 2, z: -3 } },
    ]);
    expect(first?.vertices[0]?.normal).toEqual({ x: 0, y: -0, z: 2 });
    expect(first?.vertices[0]?.texCoords).toEqual({ x: -0.25, y: 1.5 });
    expect(model.lods[1]?.surfaces[0]?.vertices[2]?.weights[0]?.boneIndex).toBe(1);
  });

  test("owns records independently of caller bytes and ignores bytes beyond ofsEnd", () => {
    const bytes = fixture();
    const model = parseMd4(bytes);
    expect(parseMd4(bytes.subarray(0, MODEL_END))).toEqual(model);
    const wrapped = new Uint8Array(bytes.length + 9);
    wrapped.set(bytes, 5);
    expect(parseMd4(wrapped.subarray(5, 5 + bytes.length))).toEqual(model);
    bytes.fill(0);
    expect(model.frames[0]?.bones[0]?.matrix[0].w).toBe(4);
    expect(model.lods[0]?.surfaces[0]?.triangles[0]?.indices).toEqual([2, 0, 1]);
  });

  test("preserves loader limits, empty LODs and unused offsets without inventing consumption", () => {
    const bytes = changed(88, 0);
    new DataView(bytes.buffer).setInt32(92, -100, true);
    expect(parseMd4(bytes).lods).toEqual([]);
    const empty = changed(LOD_START, 0);
    new DataView(empty.buffer).setInt32(LOD_START + 4, -100, true);
    expect(parseMd4(empty).lods[0]?.surfaces).toEqual([]);
    const noReferences = changed(SURFACE_START + 156, 0);
    new DataView(noReferences.buffer).setInt32(SURFACE_START + 160, -100, true);
    expect(parseMd4(noReferences).lods[0]?.surfaces[0]?.boneReferences).toEqual([]);
  });

  test("rejects a truncated header and model allocation even when trailing bytes could supply a record", () => {
    expect(() => parseMd4(fixture().subarray(0, 99))).toThrow(BinaryError);
    expect(() => parseMd4(fixture().subarray(0, MODEL_END - 1))).toThrow(BinaryError);
    expect(() => parseMd4(changed(96, MODEL_END - 1))).toThrow(BinaryError);
  });

  const invalid: readonly { readonly label: string; readonly offset: number; readonly value: number }[] = [
    { label: "magic", offset: 0, value: 0x33504449 },
    { label: "version", offset: 4, value: 2 },
    { label: "zero frames", offset: 72, value: 0 },
    { label: "negative frames", offset: 72, value: -1 },
    { label: "frame allocation", offset: 72, value: 0x7fffffff },
    { label: "negative bones", offset: 76, value: -1 },
    { label: "bone interpolation stack", offset: 76, value: 129 },
    { label: "frame offset", offset: 84, value: MODEL_END - 1 },
    { label: "LOD count", offset: 88, value: 0x7fffffff },
    { label: "LOD offset", offset: 92, value: MODEL_END - 1 },
    { label: "model end", offset: 96, value: 99 },
    { label: "LOD surfaces", offset: LOD_START, value: 0x7fffffff },
    { label: "surface offset", offset: LOD_START + 4, value: 643 },
    { label: "LOD end", offset: LOD_START + 8, value: 11 },
    { label: "LOD outer range", offset: LOD_START + 8, value: MODEL_END },
    { label: "header backlink", offset: SURFACE_START + 136, value: -SURFACE_START + 4 },
    { label: "vertex capacity", offset: SURFACE_START + 140, value: 1001 },
    { label: "vertex offset", offset: SURFACE_START + 144, value: 315 },
    { label: "triangle capacity", offset: SURFACE_START + 148, value: 2001 },
    { label: "triangle offset", offset: SURFACE_START + 152, value: 315 },
    { label: "bone reference count", offset: SURFACE_START + 156, value: 0x7fffffff },
    { label: "bone reference offset", offset: SURFACE_START + 160, value: 315 },
    { label: "surface end", offset: SURFACE_START + 164, value: 167 },
    { label: "surface exceeds LOD", offset: SURFACE_START + 164, value: MODEL_END },
    { label: "negative triangle vertex", offset: SURFACE_START + 168, value: -1 },
    { label: "triangle vertex bound", offset: SURFACE_START + 168, value: 3 },
    { label: "bone reference bound", offset: SURFACE_START + 180, value: 2 },
    { label: "weight count", offset: VERTEX_START + 20, value: 0x7fffffff },
    { label: "negative weights", offset: VERTEX_START + 20, value: -1 },
    { label: "weight bone bound", offset: VERTEX_START + 24, value: 2 },
    { label: "negative weight bone", offset: VERTEX_START + 24, value: -1 },
    { label: "non-finite normal", offset: VERTEX_START, value: 0x7f800000 },
    { label: "non-finite matrix", offset: FRAME_START + 40, value: 0x7fc00000 },
  ];
  for (const item of invalid) {
    test(`rejects ${item.label} with source and offset diagnostics`, () => {
      expect(() => parseMd4(changed(item.offset, item.value), "bad.md4")).toThrow(BinaryError);
      expect(() => parseMd4(changed(item.offset, item.value), "bad.md4")).toThrow(/bad\.md4:\d+:/);
    });
  }
});
