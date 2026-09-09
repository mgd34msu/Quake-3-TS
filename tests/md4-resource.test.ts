/*
 * Synthetic layouts and arithmetic follow id Software's qcommon/qfiles.h,
 * renderer/tr_model.c and renderer/tr_animation.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, test } from "bun:test";
import type { Md4Bone, Md4Vertex } from "../src/assets/md4.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";
import { bitsToFloat32 } from "../src/core/numeric.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishFailedShader, finishImplicitShader } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { loadMd4Resource, Md4AllocationReadError } from "../src/render/md4-resource.ts";
import type { Md4RegistrationHost, Md4Resource, RegisteredMd4Surface } from "../src/render/md4-resource.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

function diagonal(x: number, y: number, z: number, tx: number, ty: number, tz: number): Md4Bone {
  return { matrix: [{ x, y: 0, z: 0, w: tx }, { x: 0, y, z: 0, w: ty }, { x: 0, y: 0, z, w: tz }] };
}
const frames: readonly (readonly Md4Bone[])[] = [
  [diagonal(1, 2, 3, 10, 20, 30), diagonal(2, 3, 4, -2, 4, 8)],
  [diagonal(5, 6, 7, 20, 40, 60), diagonal(4, 5, 6, 2, 8, 16)],
];
const vertices: readonly Md4Vertex[] = [
  { normal: { x: 0, y: 0, z: 2 }, texCoords: { x: -0.25, y: 1.5 }, weights: [
    { boneIndex: 1, boneWeight: 0.25, offset: { x: 1, y: 2, z: -3 } },
    { boneIndex: 0, boneWeight: 1.25, offset: { x: 1, y: 2, z: -3 } },
  ] },
  { normal: { x: 0, y: 0, z: 2 }, texCoords: { x: -0, y: 0.5 }, weights: [] },
  { normal: { x: 0, y: 0, z: 2 }, texCoords: { x: 0.75, y: -1 }, weights: [
    { boneIndex: 1, boneWeight: 1, offset: { x: 1, y: 2, z: -3 } },
  ] },
];

function string(writer: BinaryWriter, value: string): void {
  const bytes = new Uint8Array(64);
  for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index);
  writer.bytes(bytes);
}

function fixture(input: {
  readonly frames?: readonly (readonly Md4Bone[])[];
  readonly vertices?: readonly Md4Vertex[];
  readonly lods?: readonly (readonly string[])[];
} = {}) {
  const frameList = input.frames ?? frames, vertexList = input.vertices ?? vertices;
  const lodList = input.lods ?? [["ABCD", "SECOND"], ["LOWER"]];
  const first = frameList[0];
  if (first === undefined) throw new Error("Fixture needs a frame");
  const bones = first.length, frameSize = 40 + bones * 48;
  const surfaceSize = 168 + 12 + bones * 4 + vertexList.reduce((size, vertex) => size + 24 + vertex.weights.length * 20, 0);
  const byteLength = 100 + frameList.length * frameSize + lodList.reduce((size, lod) => size + 12 + lod.length * surfaceSize, 0);
  const writer = new BinaryWriter(byteLength + 16);
  writer.u32(0x34504449); writer.i32(1); string(writer, "Models/Synthetic.md4");
  writer.i32(frameList.length); writer.i32(bones); writer.i32(0); writer.i32(100);
  writer.i32(lodList.length); writer.i32(100 + frameList.length * frameSize); writer.i32(byteLength);
  for (const frame of frameList) {
    for (const value of [-1, -2, -3, 4, 5, 6, 0, 0, 0, 7]) writer.f32(value);
    for (const bone of frame) for (const row of bone.matrix) for (const value of [row.x, row.y, row.z, row.w]) writer.f32(value);
  }
  const surfaceOffsets: number[] = [], lodOffsets: number[] = [];
  for (const lod of lodList) {
    lodOffsets.push(writer.offset);
    writer.i32(lod.length); writer.i32(12); writer.i32(12 + lod.length * surfaceSize);
    for (const name of lod) {
      const start = writer.offset;
      surfaceOffsets.push(start);
      writer.i32(123); string(writer, name); string(writer, `Textures/${name}`);
      writer.i32(-33); writer.i32(-start); writer.i32(vertexList.length); writer.i32(180 + bones * 4);
      writer.i32(1); writer.i32(168); writer.i32(bones); writer.i32(180); writer.i32(surfaceSize);
      for (const index of [0, 1, 2]) writer.i32(index);
      for (let bone = bones - 1; bone >= 0; bone--) writer.i32(bone);
      for (const vertex of vertexList) {
        for (const value of [vertex.normal.x, vertex.normal.y, vertex.normal.z, vertex.texCoords.x, vertex.texCoords.y]) writer.f32(value);
        writer.i32(vertex.weights.length);
        for (const weight of vertex.weights) {
          writer.i32(weight.boneIndex); writer.f32(weight.boneWeight);
          for (const value of [weight.offset.x, weight.offset.y, weight.offset.z]) writer.f32(value);
        }
      }
    }
  }
  writer.bytes(new Uint8Array(16).fill(255));
  return { bytes: writer.finish(), surfaceOffsets, lodOffsets, byteLength, frameSize };
}

async function materials(failed = "") {
  const image = new RendererImageCatalog().create({ name: "synthetic-white", sourceWidth: 1, sourceHeight: 1,
    levels: [{ width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]) }], mipmap: false,
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const profile = createRendererSettings().registrationProfile();
  const registry = new MaterialRegistry(async name => {
    const defaulted = name === failed;
    const finished = defaulted ? finishFailedShader({ name, lightmapIndex: -1, profile })
      : finishImplicitShader({ name, profile, kind: name === "*default" ? "default" : "dynamic",
        baseImage: { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } } });
    return { definition: null, image, whiteImage: image, defaulted, finished, sky: null };
  }, text => { throw new Error(text); });
  const defaultMaterial = await registry.register("*default", { kind: "none" });
  await registry.register("already-registered", { kind: "none" });
  const allocations: Uint8Array[] = [], published: Md4Resource[] = [], printed: string[] = [];
  const registration: Md4RegistrationHost = {
    allocate: size => { const bytes = new Uint8Array(size); allocations.push(bytes); return bytes; },
    publish: resource => { published.push(resource); }, print: text => { printed.push(text); },
    shaderForHandle: index => registry.findByHandle(index),
  };
  return { registry, defaultMaterial, material: (name: string) => registry.register(name, { kind: "none" }),
    registration, allocations, published, printed };
}

async function load(bytes: Uint8Array): Promise<Md4Resource> {
  const resource = await loadMd4Resource({ bytes, source: "synthetic.md4", ...await materials() });
  if (resource === null) throw new Error("Expected successful authored MD4 registration");
  return resource;
}

function firstSurface(resource: Md4Resource): RegisteredMd4Surface {
  const surface = resource.firstLodSurfaces()[0];
  if (surface === undefined) throw new Error("Fixture has no surface");
  return surface;
}

function weighted(boneIndex: number, normal = { x: 0, y: 0, z: 0 }): Md4Vertex {
  return { normal, texCoords: { x: 0.25, y: -0 }, weights: [{ boneIndex, boneWeight: 1, offset: { x: 0, y: 0, z: 0 } }] };
}

describe("MD4 resource allocation and animation", () => {
  test("owns registered surfaces across all LODs and selects the first embedded LOD", async () => {
    const input = fixture(), registered = await materials();
    const resource = await loadMd4Resource({ bytes: input.bytes, source: "lods.md4", ...registered });
    if (resource === null) throw new Error("Expected authored MD4 resource");
    expect(resource.byteLength).toBe(input.byteLength);
    expect(resource.lods.map(lod => lod.map(surface => surface.source.name))).toEqual([["abcd", "second"], ["lower"]]);
    expect(resource.lods[0]).toBe(resource.firstLodSurfaces());
    expect(resource.lods.flat().map(surface => surface.material.order)).toEqual([2, 3, 4]);
    const lower = resource.lods[1]?.[0];
    if (lower === undefined) throw new Error("Fixture has no second LOD surface");
    expect(registered.registry.find("Textures/LOWER")).toBe(lower.material);
    const surface = firstSurface(resource);
    expect(surface.owner).toBe(resource);
    expect(resource.model.lods[0]?.surfaces[0]).toBe(surface.source);
    input.bytes.fill(0);
    expect(surface.source.boneReferences).toEqual([1, 0]);
    expect(Object.isFrozen(surface.source.vertices[0]?.weights)).toBe(true);
    expect(Object.isFrozen(resource.model.frames[0]?.bones[0]?.matrix[0])).toBe(true);
    expect(surface.animate({ frame: 0, oldFrame: 0, backLerp: 1 })[0]?.position).toEqual({ x: 13.75, y: 32.5, z: 25.25 });
  });

  test("uses global bone indexes, keeps weight sums and normal length, and writes only XYZ/normal/UV0", async () => {
    const result = firstSurface(await load(fixture().bytes)).animate({ frame: 0, oldFrame: 1, backLerp: 0 });
    expect(result).toEqual([
      { position: { x: 13.75, y: 32.5, z: 25.25 }, normal: { x: 0, y: 0, z: 9.5 }, texCoord: { x: -0.25, y: 1.5 } },
      { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, texCoord: { x: -0, y: 0.5 } },
      { position: { x: 0, y: 10, z: -4 }, normal: { x: 0, y: 0, z: 8 }, texCoord: { x: 0.75, y: -1 } },
    ]);
  });

  test("equal frames ignore backlerp and distinct frames interpolate all matrix components", async () => {
    const surface = firstSurface(await load(fixture().bytes));
    expect(surface.animate({ frame: 1, oldFrame: 1, backLerp: Number.NaN })[0]).toEqual({
      position: { x: 32.75, y: 69.5, z: 48.25 }, normal: { x: 0, y: 0, z: 20.5 }, texCoord: { x: -0.25, y: 1.5 },
    });
    expect(surface.animate({ frame: 1, oldFrame: 0, backLerp: 0.25 })[0]).toEqual({
      position: { x: 28, y: 60.25, z: 42.5 }, normal: { x: 0, y: 0, z: 17.75 }, texCoord: { x: -0.25, y: 1.5 },
    });
    expect(surface.animate({ frame: 1, oldFrame: 0, backLerp: 1 })[0]?.position).toEqual({ x: 13.75, y: 32.5, z: 25.25 });
    expect(() => surface.animate({ frame: 999, oldFrame: 0, backLerp: 1 })).toThrow(Md4AllocationReadError);
  });

  test("rounds dot products and weight accumulation at binary32 operation boundaries", async () => {
    const bone: Md4Bone = { matrix: [{ x: 16777216, y: 1, z: -16777216, w: 0 },
      { x: 1, y: 0, z: 0, w: 0 }, { x: 0, y: 0, z: 1, w: 0 }] };
    const vertex: Md4Vertex = { normal: { x: 1, y: 1, z: 1 }, texCoords: { x: 0, y: 0 },
      weights: [{ boneIndex: 0, boneWeight: 1, offset: { x: 1, y: 1, z: 1 } }] };
    const accumulated: Md4Vertex = { ...vertex, weights: [16777216, 1, -16777216].map(boneWeight => ({
      boneIndex: 0, boneWeight, offset: { x: 1, y: 1, z: 1 },
    })) };
    const surface = firstSurface(await load(fixture({ frames: [[bone]], vertices: [vertex, accumulated, vertex] }).bytes));
    const output = surface.animate({ frame: 0, oldFrame: 0, backLerp: 0 });
    // 2^24 + 1 rounds to 2^24 before subtraction, for both dot and accumulator.
    expect(output[0]?.position).toEqual({ x: 0, y: 1, z: 1 });
    expect(output[0]?.normal).toEqual({ x: 0, y: 1, z: 1 });
    expect(output[1]?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(output[1]?.normal).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("reads logical frame overflow inside ofsEnd instead of parsed frame records", async () => {
    const input = fixture();
    new DataView(input.bytes.buffer).setInt32(72, 1, true);
    const resource = await load(input.bytes);
    expect(resource.model.frames).toHaveLength(1);
    expect(firstSurface(resource).animate({ frame: 1, oldFrame: -1, backLerp: 0 })[0]?.position)
      .toEqual({ x: 32.75, y: 69.5, z: 48.25 });
    new DataView(input.bytes.buffer).setInt32(84, 100 + input.frameSize, true);
    const shifted = await load(input.bytes);
    expect(firstSurface(shifted).animate({ frame: -1, oldFrame: 999, backLerp: 0 })[0]?.position)
      .toEqual({ x: 13.75, y: 32.5, z: 25.25 });
  });

  test("direct reads consume only weighted bones; interpolation consumes every global bone", async () => {
    const input = fixture({ vertices: [weighted(0), weighted(0), weighted(0)] });
    const boneStart = 100 + 20 * input.frameSize + 40, end = boneStart + 48;
    const bytes = new Uint8Array(end + 48);
    bytes.set(input.bytes);
    const view = new DataView(bytes.buffer);
    view.setInt32(96, end, true);
    const bone = diagonal(1, 1, 1, 2, 4, 8);
    let offset = boneStart;
    for (const row of bone.matrix) for (const value of [row.x, row.y, row.z, row.w]) { view.setFloat32(offset, value, true); offset += 4; }
    const surface = firstSurface(await load(bytes));
    expect(surface.animate({ frame: 20, oldFrame: 999, backLerp: 0 })[0]?.position).toEqual({ x: 2, y: 4, z: 8 });
    expect(() => surface.animate({ frame: 20, oldFrame: 0, backLerp: 0.25 })).toThrow(Md4AllocationReadError);
    expect(() => surface.animate({ frame: 20, oldFrame: 0, backLerp: 0.25 })).toThrow(`at ${end} exceeds copied MD4 allocation`);
    expect(() => surface.animate({ frame: 21, oldFrame: 0, backLerp: 0 })).toThrow(Md4AllocationReadError);
  });

  test("empty weight lists and zero bones avoid unconsumed frame reads", async () => {
    const empty: Md4Vertex = { normal: { x: 0, y: 0, z: 1 }, texCoords: { x: 0.5, y: 0.25 }, weights: [] };
    const weightedModel = firstSurface(await load(fixture({ vertices: [empty, empty, empty] }).bytes));
    expect(weightedModel.animate({ frame: 999, oldFrame: -999, backLerp: 0 })[0]?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(() => weightedModel.animate({ frame: 999, oldFrame: -999, backLerp: 0.5 })).toThrow(Md4AllocationReadError);
    const noBones = firstSurface(await load(fixture({ frames: [[]], vertices: [empty, empty, empty] }).bytes));
    expect(noBones.animate({ frame: 0x7fffffff, oldFrame: -0x80000000, backLerp: 0.5 })[0])
      .toEqual({ position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, texCoord: { x: 0.5, y: 0.25 } });
    const zero: Md4Vertex = { ...empty, weights: [{ boneIndex: 0, boneWeight: 0, offset: { x: 0, y: 0, z: 0 } }] };
    const zeroWeight = firstSurface(await load(fixture({ vertices: [zero, zero, zero] }).bytes));
    expect(() => zeroWeight.animate({ frame: 999, oldFrame: 0, backLerp: 0 })).toThrow(Md4AllocationReadError);
  });

  test("logical frame alias reads see SF_MD4 and lowercase surface-name writes", async () => {
    const input = fixture({ vertices: [weighted(0, { x: 1, y: 0, z: 0 }), weighted(0, { x: 0, y: 1, z: 0 }), weighted(0)] });
    const start = input.surfaceOffsets[0];
    if (start === undefined) throw new Error("Fixture has no surface offset");
    const view = new DataView(input.bytes.buffer);
    view.setInt32(72, 1, true);
    view.setInt32(84, start - input.frameSize - 40, true);
    const output = firstSurface(await load(input.bytes)).animate({ frame: 1, oldFrame: 1, backLerp: 0 });
    expect(output[0]?.normal.x).toBe(bitsToFloat32(7));
    expect(output[1]?.normal.x).toBe(bitsToFloat32(0x64636261));
    expect(view.getInt32(start, true)).toBe(123);
    expect(view.getUint32(start + 4, true)).toBe(0x44434241);
  });

  test("logical frame alias sees the actual shader order and source default handle zero", async () => {
    for (const failed of [false, true]) {
      const input = fixture({ vertices: [weighted(1), weighted(1), weighted(1)] });
      const start = input.surfaceOffsets[0];
      if (start === undefined) throw new Error("Fixture has no surface offset");
      const view = new DataView(input.bytes.buffer);
      view.setInt32(72, 1, true);
      view.setInt32(84, start + 132 - 92 - input.frameSize - 40, true);
      const registered = await materials(failed ? "Textures/ABCD" : "");
      const resource = await loadMd4Resource({ bytes: input.bytes, source: "shader-alias.md4", ...registered });
      if (resource === null) throw new Error("Expected authored MD4 resource");
      const surface = firstSurface(resource);
      expect(failed ? registered.defaultMaterial : registered.registry.find("Textures/ABCD")).toBe(surface.material);
      expect(surface.animate({ frame: 1, oldFrame: 1, backLerp: 0 })[0]?.position.z).toBe(bitsToFloat32(failed ? 0 : 2));
      expect(view.getInt32(start + 132, true)).toBe(-33);
    }
  });

  test("published semantic frames agree with the mutated allocation when headers overlap frames", async () => {
    const input = fixture({ vertices: [weighted(0, { x: 1, y: 0, z: 0 }), weighted(0), weighted(0)] });
    const start = input.surfaceOffsets[0];
    if (start === undefined) throw new Error("Fixture has no surface offset");
    const view = new DataView(input.bytes.buffer);
    view.setInt32(72, 1, true); view.setInt32(76, 1, true); view.setInt32(84, start - 40, true);
    // Keep the deliberately permuted reference list valid for this one-bone case.
    for (const surface of input.surfaceOffsets) {
      view.setInt32(surface + 156, 1, true); view.setInt32(surface + 180, 0, true);
    }
    const resource = await load(input.bytes);
    expect(resource.model.frames[0]?.bones[0]?.matrix[0].x).toBe(bitsToFloat32(7));
    expect(firstSurface(resource).animate({ frame: 0, oldFrame: 0, backLerp: 0 })[0]?.normal.x).toBe(bitsToFloat32(7));
  });

  test("owns bytes before awaiting ordered real material registrations and publishes only after completion", async () => {
    const input = fixture(), registered = await materials(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    let published = false;
    const pending = loadMd4Resource({ bytes: input.bytes, source: "pending.md4", defaultMaterial: registered.defaultMaterial, registration: registered.registration,
      async material(name) {
        calls.push(name);
        if (calls.length === 1) { entered.resolve(); await gate.promise; }
        return registered.material(name);
      } });
    const completed = pending.then(resource => { published = true; return resource; });
    await entered.promise;
    expect(published).toBe(false);
    expect(registered.published).toHaveLength(1);
    expect(registered.allocations[0]?.byteLength).toBe(input.byteLength);
    expect(calls).toEqual(["Textures/ABCD"]);
    input.bytes.fill(0);
    gate.resolve();
    const resource = await completed;
    if (resource === null) throw new Error("Expected authored MD4 resource");
    expect(calls).toEqual(["Textures/ABCD", "Textures/SECOND", "Textures/LOWER"]);
    expect(firstSurface(resource).animate({ frame: 0, oldFrame: 0, backLerp: 0 })[0]?.position).toEqual({ x: 13.75, y: 32.5, z: 25.25 });
  });

  test("does not turn failed material registration into a completed resource or erase earlier registrations", async () => {
    const registered = await materials(), calls: string[] = [];
    await expect(loadMd4Resource({ bytes: fixture().bytes, source: "failed-material.md4", defaultMaterial: registered.defaultMaterial, registration: registered.registration,
      async material(name) {
        calls.push(name);
        if (name === "Textures/SECOND") throw new Error("material preparation failed");
        return registered.material(name);
      } })).rejects.toThrow("material preparation failed");
    expect(calls).toEqual(["Textures/ABCD", "Textures/SECOND"]);
    expect(registered.registry.find("Textures/ABCD")?.order).toBe(2);
    expect(registered.registry.find("Textures/LOWER")).toBeNull();
  });

  test("zero frames retain published allocation and return source false after warning", async () => {
    const registered = await materials(), input = fixture();
    new DataView(input.bytes.buffer).setInt32(72, 0, true);
    expect(await loadMd4Resource({ bytes: input.bytes, source: "rejected.md4", ...registered })).toBeNull();
    expect(registered.published).toHaveLength(1);
    expect(registered.published[0]?.model.frames).toEqual([]);
    expect(registered.printed).toEqual(["R_LoadMD4: rejected.md4 has no frames\n"]);
    expect(registered.registry.find("Textures/ABCD")).toBeNull();
  });

  test("version rejection precedes allocation; truncated copies and short allocated headers retain their publication", async () => {
    const registered = await materials(), input = fixture(), view = new DataView(input.bytes.buffer);
    view.setInt32(4, 2, true);
    expect(await loadMd4Resource({ bytes: input.bytes.subarray(0, 8), source: "version.md4", ...registered })).toBeNull();
    expect(registered.allocations).toEqual([]);
    expect(registered.printed).toEqual(["R_LoadMD4: version.md4 has wrong version (2 should be 1)\n"]);
    view.setInt32(4, 1, true); view.setInt32(96, input.bytes.byteLength + 1, true);
    await expect(loadMd4Resource({ bytes: input.bytes, source: "copy.md4", ...registered })).rejects.toBeInstanceOf(BinaryError);
    expect(registered.published).toHaveLength(1);
    view.setInt32(96, 76, true);
    await expect(loadMd4Resource({ bytes: input.bytes, source: "short.md4", ...registered })).rejects.toThrow("header endian conversion read at 76");
    expect(registered.published).toHaveLength(2);
  });

  test("surface name spill lowercases through the next field before shader registration", async () => {
    const input = fixture(), start = input.surfaceOffsets[0], registered = await materials();
    if (start === undefined) throw new Error("Fixture has no surface offset");
    input.bytes.fill(65, start + 4, start + 68);
    const calls: string[] = [];
    const resource = await loadMd4Resource({ bytes: input.bytes, source: "spill.md4", ...registered,
      material: name => { calls.push(name); return registered.material(name); } });
    if (resource === null) throw new Error("Expected authored MD4 resource");
    expect(firstSurface(resource).source.name).toBe(`${"a".repeat(64)}textures/abcd`);
    expect(calls[0]).toBe("textures/abcd");
    expect(new DataView(input.bytes.buffer).getUint8(start + 68)).toBe(84);
  });

  test("shader C strings may reach a terminator beyond their field with a defined short stripped name", async () => {
    const input = fixture(), start = input.surfaceOffsets[0], registered = await materials();
    if (start === undefined) throw new Error("Fixture has no surface offset");
    input.bytes.fill(65, start + 68, start + 132); input.bytes[start + 69] = 46;
    const calls: string[] = [];
    const resource = await loadMd4Resource({ bytes: input.bytes, source: "shader-spill.md4", ...registered,
      material: name => { calls.push(name); return registered.material(name); } });
    if (resource === null) throw new Error("Expected authored MD4 resource");
    expect(calls[0]?.length).toBeGreaterThan(64);
    expect(firstSurface(resource).material.name).toBe("A");
  });

  test("later triangle failure preserves earlier shaders and the current surface's identifier/name/shader writes", async () => {
    const input = fixture(), second = input.surfaceOffsets[1], registered = await materials();
    if (second === undefined) throw new Error("Fixture has no second surface");
    new DataView(input.bytes.buffer).setInt32(second + 152, input.byteLength - second, true);
    await expect(loadMd4Resource({ bytes: input.bytes, source: "late.md4", ...registered })).rejects.toThrow("triangle index read");
    expect(registered.registry.find("Textures/ABCD")?.order).toBe(2);
    expect(registered.registry.find("Textures/SECOND")?.order).toBe(3);
    expect(registered.registry.find("Textures/LOWER")).toBeNull();
    const copy = registered.allocations[0];
    if (copy === undefined) throw new Error("No retained allocation");
    const view = new DataView(copy.buffer);
    expect(view.getInt32(second, true)).toBe(7);
    expect(view.getUint8(second + 4)).toBe(115);
    expect(view.getInt32(second + 132, true)).toBe(3);
  });

  test("registration uses the copied allocation extent and leaves unused references and surface-header targets unread", async () => {
    const input = fixture({ lods: [["ABCD"]] }), start = input.surfaceOffsets[0], lod = input.lodOffsets[0];
    if (start === undefined || lod === undefined) throw new Error("Missing authored surface");
    const view = new DataView(input.bytes.buffer);
    view.setInt32(lod + 8, 12, true); view.setInt32(start + 164, 168, true);
    view.setInt32(start + 156, 0x7fffffff, true); view.setInt32(start + 160, -0x80000000, true);
    view.setInt32(start + 136, input.byteLength, true);
    const resource = await load(input.bytes), surface = firstSurface(resource);
    expect(surface.numVerts).toBe(3); expect(Array.from(surface.triangleIndices())).toEqual([0, 1, 2]);
    expect(surface.source.vertices).toHaveLength(3);
    expect(() => surface.animationHeader()).toThrow(Md4AllocationReadError);
    expect(() => surface.source.boneReferences).toThrow(Md4AllocationReadError);
  });

  test("source count errors precede identifier/name writes and material registration", async () => {
    const input = fixture(), start = input.surfaceOffsets[0], registered = await materials();
    if (start === undefined) throw new Error("Missing authored surface");
    new DataView(input.bytes.buffer).setInt32(start + 140, 1001, true);
    await expect(loadMd4Resource({ bytes: input.bytes, source: "limit.md4", ...registered })).rejects.toThrow("R_LoadMD3: limit.md4 has more than 1000 verts on a surface (1001)");
    const copy = registered.allocations[0];
    if (copy === undefined) throw new Error("Missing published allocation");
    const view = new DataView(copy.buffer);
    expect(view.getInt32(start, true)).toBe(123); expect(view.getUint8(start + 4)).toBe(65);
    expect(registered.registry.find("Textures/ABCD")).toBeNull();
  });

  test("zero declared LODs still read the reached first header and distinguish unresolved drawing from an empty loop", async () => {
    const input = fixture(), lod = input.lodOffsets[0];
    if (lod === undefined) throw new Error("Fixture has no LOD offset");
    const view = new DataView(input.bytes.buffer);
    view.setInt32(88, 0, true);
    const registered = await materials(), undeclared = await loadMd4Resource({ bytes: input.bytes, source: "undeclared.md4", ...registered });
    if (undeclared === null) throw new Error("Expected authored MD4 resource");
    expect(undeclared.lods).toEqual([]);
    const first = firstSurface(undeclared);
    expect(first.surfaceType).toBe(123);
    expect(() => first.animationHeader()).toThrow("surface-dispatch");
    expect(first.material).toBe(registered.defaultMaterial);
    expect(registered.printed).toEqual(["R_GetShaderByHandle: out of range hShader '-33'\n"]);
    view.setInt32(lod, 0, true);
    expect((await load(input.bytes)).firstLodSurfaces()).toEqual([]);
    view.setInt32(92, input.byteLength - 4, true);
    const outside = await load(input.bytes);
    expect(() => outside.firstLodSurfaces()).toThrow(Md4AllocationReadError);
  });
});
