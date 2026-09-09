import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Renderer qhandle_t allocation and lookup, id Software tr_model.c, tr_image.c,
// tr_shader.c, tr_bsp.c and tr_mesh.c. SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createModelEntity, DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { RefModelEntity, SceneModel } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RendererResources } from "../src/render/world.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture, solidTga } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** qfiles.h MD3 header, one frame and one authored triangle with one shader. */
function modelBytes(): Uint8Array {
  const writer = new BinaryWriter(400);
  function name(value: string, length = 64): void {
    const bytes = new TextEncoder().encode(value);
    writer.bytes(bytes); writer.bytes(new Uint8Array(length - bytes.length));
  }
  writer.u32(0x33504449); writer.i32(15); name("model.md3");
  for (const value of [0, 1, 0, 1, 0, 108, 164, 164, 400]) writer.i32(value);
  for (const value of [24, -8, -8, 40, 8, 8, 32, 0, 0, 16]) writer.f32(value);
  name("frame", 16);
  writer.u32(0x33504449); name("body");
  for (const value of [0, 1, 1, 3, 1, 108, 120, 188, 212, 236]) writer.i32(value);
  for (const value of [0, 1, 2]) writer.i32(value);
  name("model"); writer.i32(0);
  for (let index = 0; index < 6; index++) writer.f32(0);
  for (const [y, z] of [[-8, -8], [8, -8], [0, 8]] satisfies readonly (readonly [number, number])[]) {
    writer.i16(32 * 64); writer.i16(y * 64); writer.i16(z * 64); writer.u16(0x8040);
  }
  expect(writer.offset).toBe(400);
  return writer.finish();
}

async function fixture(onRead: (path: string) => undefined = () => undefined) {
  const script = "model { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } } "
    + "picture { { map $whiteimage rgbGen const ( 0 1 0 ) } } "
    + "partial { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } unknownDirective }";
  const files = new Map<string, Uint8Array>([
    ["scripts/test.shader", new TextEncoder().encode(script)], ["model.md3", modelBytes()], ["second.md3", modelBytes()],
    ["body.skin", new TextEncoder().encode("body,model\n")], ["empty.skin", new Uint8Array()], ["shared.tga", solidTga(255, 255, 255)],
    ["maps/fixture.bsp", renderBspFixture([{ shader: "shared", lightmap: 0 }, { shader: "shared", lightmap: 1 }], [[63, 63, 63], [127, 127, 127]])],
  ]);
  const reads: string[] = [], printed: string[] = [];
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: path => files.get(path)?.byteLength ?? -1,
    readFileOptional: async path => { reads.push(path); onRead(path); return files.get(path); },
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    async read(path) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`Missing authored asset ${path}`);
      return bytes;
    },
  });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 32, images), target = new RenderTarget(images, [cpu]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), settings = createRendererSettings();
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader }, sound: { kind: "diagnostic", readMixer: () => null },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 0, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, target, images, builtins, imageProfile: identityImageUploadProfile, shaderCinematics: cinematics.shaderCinematics,
      print: text => { printed.push(text); }, drawDebugSurface: () => { throw new Error("Unexpected debug surface"); } });
  const commands = new RenderCommandBuffer(target, { clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess,
    runtime: settings.runtime, print: text => { printed.push(text); } });
  cleanup.push(() => commands.close("discard"));
  function draw(entity: RefModelEntity): Uint8Array {
    commands.addView({ viewport: { x: 0, y: 0, width: 32, height: 32 }, clear: { color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1, stencil: false }, operations: [] });
    const refdef = cameraRefdef({ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) }, 32, 32);
    refdef.renderFlags = RDF_NOWORLDMODEL;
    resources.renderFrame({ refdef, entities: [entity] });
    commands.submit();
    return cpu.pixels.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4);
  }
  return { resources, reads, printed, files, draw, commands, cpu };
}

test("new model registration executes queued CPU pictures before its first LOD read without a frame flush", async () => {
  let observe: (path: string) => undefined = () => undefined;
  const f = await fixture(path => observe(path));
  const green = await f.resources.registerShaderNoMip("picture"), red = await f.resources.registerShaderNoMip("model");
  const observed: { readonly pixel: Uint8Array; readonly vertices: number; readonly indexes: number }[] = [];
  observe = path => {
    if (path === "missing_2.md3") observed.push({ pixel: f.cpu.pixels.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4),
      vertices: f.resources.tess.numVertexes, indexes: f.resources.tess.numIndexes });
  };
  const uv = { s: 0, t: 0, s2: 1, t2: 1 };
  f.commands.stretchPixels({ x: 0, y: 0, width: 32, height: 32 }, uv, f.resources.picture(green));
  f.commands.stretchPixels({ x: 64, y: 64, width: 8, height: 8 }, uv, f.resources.picture(red));
  expect(f.cpu.pixels.some(byte => byte !== 0)).toBe(false);
  expect(await f.resources.registerModel("missing.md3")).toBe(DEFAULT_MODEL);
  expect(observed).toEqual([{ pixel: new Uint8Array([0, 255, 0, 255]), vertices: 4, indexes: 6 }]);

  const failure = new CommonError("drop", "authored queued model barrier failure"), prefix: SceneModel[] = [], rows: string[] = [];
  const readsBeforeFailure = f.reads.length;
  f.commands.addPreparedViews(() => {
    prefix.push(f.resources.modelForHandle(2));
    f.resources.listModels(text => { rows.push(text); });
    throw failure;
  });
  await expect(f.resources.registerModel("Dropped.md3")).rejects.toBe(failure);
  expect(prefix).toEqual([{ kind: "bad", path: "Dropped.md3", md3: [null, null, null], md4: null, numLods: 0 }]);
  expect(rows).toEqual(["       0 : (1) missing.md3\n", "       0 : (1) Dropped.md3\n", "       0 : Total models\n"]);
  expect(prefix[0]).toBe(f.resources.modelForHandle(2));
  expect(f.reads).toHaveLength(readsBeforeFailure);
  expect(await f.resources.registerModel("Dropped.md3")).toBe(DEFAULT_MODEL);
});

test("numeric models use source allocation rows including failed registrations and inline models", async () => {
  const { resources, reads } = await fixture();
  expect(resources.modelHandle(DEFAULT_MODEL)).toBe(0);
  expect(await resources.registerModel("missing.md3")).toBe(DEFAULT_MODEL);
  const failed = resources.modelForHandle(1);
  expect(failed).toEqual({ kind: "bad", path: "missing.md3", md3: [null, null, null], md4: null, numLods: 0 });
  expect(resources.modelHandle(failed)).toBe(1);
  const model = await resources.registerModel("model.md3");
  expect(resources.modelHandle(model)).toBe(2);
  expect(resources.modelForHandle(2)).toBe(model);
  const before = reads.length;
  expect(await resources.registerModel("missing.md3")).toBe(DEFAULT_MODEL);
  expect(await resources.registerModel("model.md3")).toBe(model);
  expect(reads).toHaveLength(before);
  const firstWorld = await resources.loadWorld("fixture"), firstInline = firstWorld.inlineModel(0);
  expect(resources.modelHandle(firstInline)).toBe(3);
  expect(resources.modelForHandle(3)).toBe(firstInline);
  expect(await resources.registerModel("*0")).toBe(firstInline);
  const second = await resources.registerModel("second.md3");
  expect(resources.modelHandle(second)).toBe(4);
  const beforeRedundantLoad = reads.length;
  await expect(resources.loadWorld("fixture")).rejects.toThrow("ERROR: attempted to redundantly load world map\n");
  expect(reads).toHaveLength(beforeRedundantLoad);
  expect(resources.modelForHandle(3)).toBe(firstInline);
  expect(resources.modelForHandle(4)).toBe(second);
  expect(await resources.registerModel("*0")).toBe(firstInline);
  for (const handle of [0, -1, 5, 0x7fffffff]) expect(resources.modelForHandle(handle)).toBe(DEFAULT_MODEL);
});

test("skin handles preserve failed nonzero rows and the source customSkin range check", async () => {
  const { resources, reads, draw } = await fixture();
  expect(await resources.registerSkin("missing.skin")).toBeNull();
  expect(await resources.registerSkin("empty.skin")).toBeNull();
  const missing = resources.skinForHandle(1), empty = resources.skinForHandle(2);
  expect(missing).not.toBeNull(); expect(empty).not.toBeNull();
  expect(missing?.surfaces).toEqual([]); expect(empty?.surfaces).toEqual([]);
  expect(resources.skinHandle(missing)).toBe(1); expect(resources.skinHandle(empty)).toBe(2);
  const loaded = await resources.registerSkin("body.skin");
  expect(resources.skinHandle(loaded)).toBe(3); expect(resources.skinForHandle(3)).toBe(loaded);
  const before = reads.length;
  expect(await resources.registerSkin("BODY.SKIN")).toBe(loaded);
  expect(await resources.registerSkin("MISSING.SKIN")).toBeNull();
  expect(reads).toHaveLength(before);
  for (const handle of [0, -1, 4, 0x7fffffff]) expect(resources.skinForHandle(handle)).toBeNull();
  expect(resources.skinHandle(null)).toBe(0);
  const model = createModelEntity(await resources.registerModel("model.md3"));
  model.axis = anglesToAxis(vec3(0, 0, 0));
  expect(draw(model)).toEqual(new Uint8Array([255, 0, 0, 255]));
  model.customSkin = missing;
  expect(draw(model)).not.toEqual(new Uint8Array([255, 0, 0, 255]));
  model.customSkin = resources.skinForHandle(0x7fffffff);
  expect(draw(model)).toEqual(new Uint8Array([255, 0, 0, 255]));
});

test("a failed inline name remains the first source registration match after world loading", async () => {
  const { resources, reads } = await fixture();
  expect(await resources.registerModel("*0")).toBe(DEFAULT_MODEL);
  const world = await resources.loadWorld("fixture"), inline = world.inlineModel(0);
  expect(resources.modelHandle(inline)).toBe(2);
  expect(resources.modelForHandle(1)).toEqual({ kind: "bad", path: "*0", md3: [null, null, null], md4: null, numLods: 0 });
  expect(resources.modelForHandle(2)).toBe(inline);
  const before = reads.length;
  expect(await resources.registerModel("*0")).toBe(DEFAULT_MODEL);
  expect(reads).toHaveLength(before);
});

test("shader handles preserve material order and same-name lighting records", async () => {
  const { resources } = await fixture();
  expect(resources.shaderForHandle(0)).toBeNull(); expect(resources.shaderHandle(null)).toBe(0);
  const shader = await resources.registerShaderNoMip("shared"), order = resources.shaderHandle(shader);
  expect(order).toBe(4);
  expect(resources.picture(shader).material.order).toBe(order);
  expect(resources.shaderForHandle(order)).toBe(shader);
  expect(await resources.registerShader("SHARED.tga")).toBe(shader);
  const world = await resources.loadWorld("fixture");
  const first = resources.shaderForHandle(order + 1), second = resources.shaderForHandle(order + 2);
  expect(first).not.toBe(shader); expect(second).not.toBe(first);
  expect([shader?.name, first?.name, second?.name]).toEqual(["shared", "shared", "shared"]);
  const firstMaterial = resources.picture(first).material, secondMaterial = resources.picture(second).material;
  expect(firstMaterial.lighting.kind).toBe("lightmap"); expect(secondMaterial.lighting.kind).toBe("lightmap");
  if (firstMaterial.lighting.kind !== "lightmap" || secondMaterial.lighting.kind !== "lightmap") throw new Error("Missing source lightmap registrations");
  expect([firstMaterial.lighting.index, secondMaterial.lighting.index]).toEqual([0, 1]);
  expect(firstMaterial.lighting.owner).toBe(world.map); expect(secondMaterial.lighting.owner).toBe(world.map);
  expect(resources.shaderHandle(first)).toBe(order + 1); expect(resources.shaderHandle(second)).toBe(order + 2);
  expect(resources.shaderForHandle(order + 1)).toBe(first);
  expect(await resources.registerShader("shared")).toBe(shader);
});

test("failed shader rows and invalid nonzero overrides retain their source default distinction", async () => {
  const { resources, printed, reads, draw } = await fixture();
  expect(await resources.registerShader("partial")).toBeNull();
  const partial = resources.shaderForHandle(4);
  expect(partial).not.toBeNull(); expect(resources.shaderHandle(partial)).toBe(4);
  expect(resources.picture(partial).material.defaulted).toBe(true);
  expect(resources.picture(partial).material.finished.numUnfoggedPasses).toBe(1);
  const before = reads.length;
  expect(await resources.registerShaderNoMip("PARTIAL.tga")).toBeNull();
  expect(reads).toHaveLength(before);
  const model = createModelEntity(await resources.registerModel("model.md3"));
  model.axis = anglesToAxis(vec3(0, 0, 0)); model.customShader = partial;
  expect(draw(model)).toEqual(new Uint8Array([0, 0, 255, 255]));
  const fallback = resources.shaderForHandle(-1);
  expect(fallback).not.toBeNull(); expect(resources.shaderHandle(fallback)).toBe(0);
  expect(resources.picture(fallback).material).toBe(resources.picture(null).material);
  expect(resources.shaderForHandle(0x7fffffff)).toBe(fallback);
  expect(printed.filter(text => text.startsWith("R_GetShaderByHandle"))).toEqual([
    "R_GetShaderByHandle: out of range hShader '-1'\n", "R_GetShaderByHandle: out of range hShader '2147483647'\n",
  ]);
  model.customShader = fallback;
  expect(draw(model)).not.toEqual(new Uint8Array([255, 0, 0, 255]));
  model.customShader = resources.shaderForHandle(0);
  expect(draw(model)).toEqual(new Uint8Array([255, 0, 0, 255]));
});

test("numeric conversion rejects foreign typed resources and impossible fractional handle words", async () => {
  const own = await fixture(), foreign = await fixture();
  const model = await foreign.resources.registerModel("model.md3"), skin = await foreign.resources.registerSkin("body.skin"), shader = await foreign.resources.registerShader("picture");
  expect(() => own.resources.modelHandle(model)).toThrow("another renderer or is unregistered");
  expect(() => own.resources.skinHandle(skin)).toThrow("another renderer or is unregistered");
  expect(() => own.resources.shaderHandle(shader)).toThrow("another renderer or is unregistered");
  expect(() => own.resources.modelHandle({ kind: "default", path: "*default" })).toThrow("another renderer or is unregistered");
  expect(() => own.resources.skinHandle({ path: "body.skin", surfaces: [] })).toThrow("another renderer or is unregistered");
  expect(() => own.resources.shaderHandle({ name: "picture" })).toThrow("another renderer or is unregistered");
  for (const handle of [0.5, Number.NaN, Infinity]) {
    expect(() => own.resources.modelForHandle(handle)).toThrow("integer");
    expect(() => own.resources.skinForHandle(handle)).toThrow("integer");
    expect(() => own.resources.shaderForHandle(handle)).toThrow("integer");
  }
});

test("MAX_SHADERS preserves the final source row, prepares overflow images, and returns the actual default", async () => {
  const { resources, reads, printed, files } = await fixture();
  const fallback = resources.picture(null).material;
  const warnings = () => printed.filter(text => text.startsWith("WARNING: GeneratePermanentShader"));
  // Four startup records occupy the same allocator, including two named failures.
  for (let index = 4; index < 16383; index++) await resources.registerShader(`capacity/missing_${index}`);
  const last = await resources.registerShader("picture");
  expect(last).not.toBeNull(); expect(resources.shaderHandle(last)).toBe(16383);
  expect(resources.shaderForHandle(16383)).toBe(last);
  const beforeCached = reads.length, beforePrinted = printed.length;
  expect(await resources.registerShaderNoMip("PICTURE")).toBe(last);
  expect(await resources.registerShader("capacity/missing_4")).toBeNull();
  expect(reads).toHaveLength(beforeCached); expect(printed).toHaveLength(beforePrinted); expect(warnings()).toEqual([]);

  files.set("overflow.tga", solidTga(12, 34, 56));
  expect(resources.images.registeredImages().some(image => image.name === "overflow.tga")).toBe(false);
  expect(await resources.registerShader("overflow")).toBeNull();
  const image = resources.images.registeredImages().find(image => image.name === "overflow.tga");
  expect(image).toBeDefined(); expect(reads).toContain("overflow.tga");
  expect(warnings()).toEqual(["WARNING: GeneratePermanentShader - MAX_SHADERS hit\n"]);
  expect(await resources.registerShader("overflow")).toBeNull();
  expect(resources.images.registeredImages().find(candidate => candidate.name === "overflow.tga")).toBe(image);
  expect(warnings()).toEqual([
    "WARNING: GeneratePermanentShader - MAX_SHADERS hit\n", "WARNING: GeneratePermanentShader - MAX_SHADERS hit\n",
  ]);
  expect(resources.picture(resources.shaderForHandle(16384)).material).toBe(fallback);
  expect(resources.shaderForHandle(16383)).toBe(last);
  const counts: string[] = [];
  resources.listShaders(false, text => { if (text.endsWith(" total shaders\n")) counts.push(text); });
  expect(counts).toEqual(["16384 total shaders\n"]);
});
