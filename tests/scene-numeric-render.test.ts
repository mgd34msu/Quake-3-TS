import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Deferred renderer handles from id Software renderer/tr_main.c, tr_mesh.c and tr_scene.c.
// Authored in-memory MD3/MD4 layouts follow qcommon/qfiles.h. SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createModelEntity, createPortalEntity, createSpriteEntity, RF_FIRST_PERSON, RF_THIRD_PERSON } from "../src/render/ref-entity.ts";
import type { RefPolyVertex, SourceRefEntity, SourceRefEntityRecord } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const axis = anglesToAxis(vec3(0, 0, 0));
const points = [vec3(0, -8, -8), vec3(0, 8, -8), vec3(0, 0, 8)];
const scripts = "green { cull none { map $whiteimage rgbGen const ( 0 1 0 ) } }\n"
  + "blue { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } }\n"
  + "portal { portal cull none { map $whiteimage } }";

function name(writer: BinaryWriter, value: string, length = 64): void {
  const bytes = new TextEncoder().encode(value);
  writer.bytes(bytes); writer.bytes(new Uint8Array(length - bytes.length));
}

function md3(): Uint8Array {
  const writer = new BinaryWriter(500);
  writer.u32(0x33504449); writer.i32(15); name(writer, "models/numeric.md3");
  for (const value of [0, 1, 0, 2, 0, 108, 164, 164, 500]) writer.i32(value);
  for (const value of [-8, -8, -8, 8, 8, 8, 0, 0, 0, 16]) writer.f32(value);
  name(writer, "frame", 16);
  for (const surface of ["body", "head"]) {
    writer.u32(0x33504449); name(writer, surface);
    for (const value of [0, 1, 0, 3, 1, 108, 120, 120, 144, 168]) writer.i32(value);
    for (const index of [0, 1, 2]) writer.i32(index);
    for (const index of [0, 1, 2]) { writer.f32(index / 2); writer.f32(0); }
    for (const point of points) { writer.i16(point.x * 64); writer.i16(point.y * 64); writer.i16(point.z * 64); writer.u16(0); }
  }
  expect(writer.offset).toBe(500);
  return writer.finish();
}

function md4(): Uint8Array {
  const writer = new BinaryWriter(516);
  writer.u32(0x34504449); writer.i32(1); name(writer, "models/numeric.md4");
  for (const value of [1, 1, 0, 100, 1, 188, 516]) writer.i32(value);
  for (const value of [-8, -8, -8, 8, 8, 8, 0, 0, 0, 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) writer.f32(value);
  for (const value of [1, 12, 328]) writer.i32(value);
  writer.i32(0); name(writer, "body"); name(writer, "green");
  for (const value of [0, -200, 3, 184, 1, 168, 1, 180, 316]) writer.i32(value);
  for (const index of [0, 1, 2, 0]) writer.i32(index);
  for (const point of points) {
    for (const value of [-1, 0, 0, 0, 0]) writer.f32(value);
    writer.i32(1); writer.i32(0); writer.f32(1);
    for (const value of [point.x, point.y, point.z]) writer.f32(value);
  }
  expect(writer.offset).toBe(516);
  return writer.finish();
}

function modelRecord(model: number, customShader: number): Extract<SourceRefEntityRecord, { readonly kind: "model" }> {
  return { ...createModelEntity(), model, customShader, customSkin: 0, origin: vec3(32, 0, 0), axis, radius: 0, rotation: 0 };
}

function polygon(): readonly RefPolyVertex[] {
  return points.map(position => ({ position: { ...position, x: 24 }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } }));
}

function refdef() { return { ...cameraRefdef({ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) }, 64, 48), renderFlags: RDF_NOWORLDMODEL }; }
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function renderer() {
  const files = new Map<string, Uint8Array>([["scripts/numeric.shader", new TextEncoder().encode(scripts)],
    ["models/numeric.md3", md3()], ["models/numeric.md4", md4()],
    ["models/numeric.skin", new TextEncoder().encode("body,green\nhead,blue\n")],
    ["maps/numeric.bsp", renderBspFixture([{ shader: "green", lightmap: -1 }, { shader: "blue", lightmap: -1 }], [])],
    ["maps/mirror.bsp", renderBspFixture([{ shader: "portal", lightmap: -1 }, { shader: "blue", lightmap: -1 }], [])]]);
  const assets: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing authored asset ${path}`); return bytes; },
    readFileLength: path => files.get(path)?.byteLength ?? -1, readFileOptional: async path => files.get(path),
  });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(64, 48, images), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const clock = { milliseconds: () => 0 }, printed: string[] = [];
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets },
    sound: { kind: "diagnostic", readMixer: () => null }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, images, builtins, target, imageProfile: identityImageUploadProfile, print: text => { printed.push(text); },
      drawDebugSurface: () => undefined, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime,
    print: text => { printed.push(text); } });
  cleanup.push(() => commands.close("discard"));
  printed.length = 0;
  return { resources, commands, cpu, recording, cvars, printed };
}

test("model and shader registration after ADD reaches actual CPU drawing while handles stay numeric", async () => {
  const f = await renderer(), previous = await f.resources.registerShader("blue");
  const shaderHandle = f.resources.shaderHandle(previous) + 1;
  const submitted = { ...modelRecord(1, shaderHandle), frame: 19, oldFrame: 23 };
  f.resources.addRefEntityRecord(() => submitted);
  const cell = f.resources.sceneEntities.sceneRange().entity(0);
  const model = await f.resources.registerModel("models/numeric.md3"), shader = await f.resources.registerShader("green");
  expect(f.resources.modelHandle(model)).toBe(1); expect(f.resources.shaderHandle(shader)).toBe(shaderHandle);
  f.resources.renderScene(refdef());
  expect(cell.entity).toMatchObject({ model: 1, customShader: shaderHandle, frame: 0, oldFrame: 0 });
  expect(submitted.frame).toBe(19); expect(cell.lightingCalculated).toBe(true);
  f.commands.submitFrame();
  expect(f.resources.tess.context.entity).toBe(cell.entity);
  expect(f.resources.tess.context.lighting).toBe(cell.lighting);
  expect(f.cpu.pixels.slice((24 * 64 + 32) * 4, (24 * 64 + 32) * 4 + 4)).toEqual(new Uint8Array([0, 255, 0, 255]));
  expect(f.printed).toEqual([]);
});

test("culled MD3, primary third-person procedures and portals do not resolve unused shader or skin handles", async () => {
  const f = await renderer(), model = await f.resources.registerModel("models/numeric.md3");
  const culled = { ...modelRecord(f.resources.modelHandle(model), 9001), origin: vec3(-1024, 0, 0), customSkin: 9002 };
  const hidden: SourceRefEntity = { ...createSpriteEntity(), renderFlags: RF_THIRD_PERSON, customShader: 9003, radius: 8 };
  const portal: SourceRefEntityRecord = { ...modelRecord(0, 9004), kind: "portal-surface" };
  for (const entity of [culled, hidden, portal]) f.resources.addRefEntityRecord(() => entity);
  const cells = f.resources.sceneEntities.sceneRange();
  f.resources.renderScene(refdef()); f.commands.submitFrame();
  expect(f.printed).toEqual([]); expect(cells.entity(0).lightingCalculated).toBe(false);
  expect(f.recording.trace()[0]?.batches).toEqual([]);
});

test("each visible MD3 surface resolves its custom shader even for a hidden personal model", async () => {
  const f = await renderer(), model = await f.resources.registerModel("models/numeric.md3");
  for (const flags of [0, RF_THIRD_PERSON]) {
    const submitted = { ...modelRecord(f.resources.modelHandle(model), 9011), renderFlags: flags, customSkin: 9012 };
    f.resources.addRefEntityRecord(() => submitted);
    const cell = f.resources.sceneEntities.sceneRange().entity(0);
    f.resources.renderScene(refdef()); f.commands.submitFrame();
    expect(f.printed.splice(0)).toEqual(Array.from({ length: 2 }, () => "R_GetShaderByHandle: out of range hShader '9011'\n"));
    expect(cell.lightingCalculated).toBe(flags === 0);
    expect(cell.entity).toMatchObject({ model: 1, customShader: 9011, customSkin: 9012 });
  }
  expect(f.recording.trace()[1]?.batches).toEqual([]);
});

test("MOD_BAD resolves a reached custom shader and skips it for a primary personal model", async () => {
  const f = await renderer();
  for (const flags of [0, RF_THIRD_PERSON]) f.resources.addRefEntityRecord(() => ({ ...modelRecord(9999, 9021), renderFlags: flags }));
  f.resources.renderScene(refdef()); f.commands.submitFrame();
  expect(f.printed).toEqual(["R_GetShaderByHandle: out of range hShader '9021'\n"]);
});

test("MD4 and inline models ignore numeric custom shader and skin handles", async () => {
  const f = await renderer(), md4Model = await f.resources.registerModel("models/numeric.md4");
  const world = await f.resources.loadWorld("numeric"), inline = world.inlineModel(0);
  const loadPrintCount = f.printed.length;
  for (const model of [md4Model, inline]) f.resources.addRefEntityRecord(() => ({
    ...modelRecord(f.resources.modelHandle(model), 9031), origin: model.kind === "inline" ? vec3(0, 0, 0) : vec3(32, 0, 0), customSkin: 9032,
  }));
  f.resources.renderScene(refdef()); f.commands.submitFrame();
  expect(f.printed.slice(loadPrintCount)).toEqual([]);
  expect(f.recording.trace()[0]?.batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(15);
});

test("MD3 resolves a skin registered after admission only in its noncustom surface branch", async () => {
  const f = await renderer(), model = await f.resources.registerModel("models/numeric.md3");
  f.resources.addRefEntityRecord(() => ({ ...modelRecord(f.resources.modelHandle(model), 0), customSkin: 1, skinNum: -1 }));
  expect(f.resources.skinHandle(await f.resources.registerSkin("models/numeric.skin"))).toBe(1);
  f.resources.renderScene(refdef()); f.commands.submitFrame();
  expect(f.printed).toEqual([]);
  const colors = f.recording.trace()[0]?.batches.map(batch => batch.vertices[0]?.color);
  expect(colors).toContainEqual({ x: 0, y: 1, z: 0, w: 1 }); expect(colors).toContainEqual({ x: 0, y: 0, z: 1, w: 1 });
  const unused = createModelEntity(model); unused.origin = vec3(32, 0, 0); unused.axis = axis;
  unused.customSkin = { path: "unregistered.skin", surfaces: [] }; unused.customShader = await f.resources.registerShader("green");
  expect(() => f.resources.addRefEntity(unused)).toThrow("skin handle belongs to another renderer");
  f.resources.addRefEntityRecord(() => ({ ...modelRecord(f.resources.modelHandle(model), f.resources.shaderHandle(unused.customShader)), customSkin: 9032 }));
  f.resources.renderScene(refdef()); f.commands.submitFrame();
  expect(f.printed).toEqual([]);
  expect(f.recording.trace()[1]?.batches.map(batch => batch.vertices[0]?.color)).toEqual([
    { x: 0, y: 1, z: 0, w: 1 },
  ]);
  expect(f.recording.trace()[1]?.batches[0]?.indices).toHaveLength(6);
});

test("r_drawentities gates bad RT_POLY dispatch and leaves derived entity state untouched", async () => {
  const f = await renderer(), bad: SourceRefEntityRecord = { ...modelRecord(0, 9041), kind: "poly" };
  f.cvars.set("r_drawentities", "0");
  f.resources.addRefEntityRecord(() => bad);
  const cell = f.resources.sceneEntities.sceneRange().entity(0); cell.needDlights = true;
  f.resources.renderScene(refdef()); f.commands.submitFrame();
  expect(cell.needDlights).toBe(true); expect(f.printed).toEqual([]);
  f.cvars.set("r_drawentities", "1"); f.resources.addRefEntityRecord(() => bad);
  const reached = f.resources.sceneEntities.sceneRange().entity(0); reached.needDlights = true;
  f.cvars.set("r_norefresh", "1"); f.resources.renderScene(refdef());
  expect(reached.needDlights).toBe(true); expect(f.resources.sceneEntities.sceneRange().length).toBe(1);
  f.cvars.set("r_norefresh", "0");
  expect(() => f.resources.renderScene(refdef())).toThrow("R_AddEntitySurfaces: Bad reType");
  expect(reached.needDlights).toBe(false); expect(f.resources.sceneEntities.sceneRange().length).toBe(1);
});

test("portal children repeat numeric polygon and model surface lookups in source order", async () => {
  const f = await renderer(); await f.resources.loadWorld("mirror");
  const loadPrintCount = f.printed.length;
  const model = await f.resources.registerModel("models/numeric.md3");
  const portal = createPortalEntity(); portal.origin = vec3(32, -12, 0); portal.oldOrigin = portal.origin;
  f.resources.addRefEntity(portal);
  f.resources.addRefEntityRecord(() => ({ ...modelRecord(f.resources.modelHandle(model), 9052), origin: vec3(16, 0, 0) }));
  f.resources.addRefEntityRecord(() => ({ ...modelRecord(0, 9053), renderFlags: RF_FIRST_PERSON }));
  f.resources.addPolysByHandle(9051, 3, 1, () => polygon());
  f.resources.renderScene({ ...refdef(), renderFlags: 0 }); f.commands.submitFrame();
  expect(f.printed.slice(loadPrintCount)).toEqual(["R_GetShaderByHandle: out of range hShader '9051'\n",
    "R_GetShaderByHandle: out of range hShader '9052'\n", "R_GetShaderByHandle: out of range hShader '9052'\n",
    "R_GetShaderByHandle: out of range hShader '9053'\n", "R_GetShaderByHandle: out of range hShader '9051'\n",
    "R_GetShaderByHandle: out of range hShader '9052'\n", "R_GetShaderByHandle: out of range hShader '9052'\n"]);
  expect(f.recording.trace()).toHaveLength(2);
});
