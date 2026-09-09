import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { createBeamEntity, createModelEntity, createPortalEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import type { RefPoly } from "../src/render/ref-entity.ts";
import { RDF_HYPERSPACE, RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RendererResources } from "../src/render/world.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture, solidTga } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { SourcePreparedViews } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { skyVector } from "../src/render/sky.ts";
import { Md3AllocationReadError } from "../src/render/md3-resource.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function preparedRenderer(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">,
  settings = createRendererSettings(), stencilBits = 0) {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Prepared portal scenes", width: 64, height: 48, backend: "gl", hidden: true, stencilBits }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(64, 48, images, gl?.subpixelBits, gl?.stencilBits ?? stencilBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const clock = { milliseconds: () => 0 };
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  function submit(prepare: SourcePreparedViews) {
    const start = recording.trace().length;
    commands.addPreparedViews(prepare); commands.submit();
    return recording.trace().slice(start);
  }
  return { resources, submit, commands, recording, cpu, gl };
}

function assets(files: ReadonlyMap<string, Uint8Array>): RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> {
  return withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: prefix => [...files.keys()].filter(name => prefix === undefined || name.startsWith(prefix)),
    read: async name => { const data = files.get(name); if (data === undefined) throw new Error(`Missing fixture ${name}`); return data; } });
}
function camera() { return { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) }; }

// qfiles.h MD4 layout, with two one-bone poses and one authored triangle.
function portalMd4(shader: string, translation: number): Uint8Array {
  const writer = new BinaryWriter(604);
  function name(value: string): void {
    const bytes = new TextEncoder().encode(value);
    writer.bytes(bytes); writer.bytes(new Uint8Array(64 - bytes.length));
  }
  writer.u32(0x34504449); writer.i32(1); name("models/portal.md4");
  for (const value of [2, 1, 0, 100, 1, 276, 604]) writer.i32(value);
  for (const shift of [0, translation]) {
    for (const value of [24, -8 + shift, -8, 40, 8 + shift, 8, 32, shift, 0, 16,
      1, 0, 0, 0, 0, 1, 0, shift, 0, 0, 1, 0]) writer.f32(value);
  }
  writer.i32(1); writer.i32(12); writer.i32(328);
  writer.i32(0); name("body"); name(shader);
  for (const value of [0, -288, 3, 184, 1, 168, 1, 180, 316]) writer.i32(value);
  for (const value of [0, 1, 2, 0]) writer.i32(value);
  for (const [y, z] of [[-8, -8], [8, -8], [0, 8]] satisfies readonly (readonly [number, number])[]) {
    for (const value of [-1, 0, 0, 0, 0]) writer.f32(value);
    writer.i32(1); writer.i32(0); writer.f32(1);
    for (const value of [32, y, z]) writer.f32(value);
  }
  expect(writer.offset).toBe(604);
  return writer.finish();
}

function portalMd3(shader: string, translation: number, vertexCount = 3): Uint8Array {
  const surfaceBytes = 188 + vertexCount * 24, length = 220 + surfaceBytes;
  const writer = new BinaryWriter(length);
  function name(value: string, length = 64): void {
    const bytes = new TextEncoder().encode(value);
    writer.bytes(bytes); writer.bytes(new Uint8Array(length - bytes.length));
  }
  writer.u32(0x33504449); writer.i32(15); name("models/portal.md3");
  for (const value of [0, 2, 0, 1, 0, 108, 220, 220, length]) writer.i32(value);
  for (const shift of [0, translation]) {
    for (const value of [24, -8 + shift, -8, 40, 8 + shift, 8, 32, shift, 0, 16]) writer.f32(value);
    name("frame", 16);
  }
  writer.u32(0x33504449); name("body");
  for (const value of [0, 2, 1, vertexCount, 1, 108, 120, 188, 188 + vertexCount * 8, surfaceBytes]) writer.i32(value);
  for (const value of [0, 1, 2]) writer.i32(value);
  name(shader); writer.i32(0);
  for (let index = 0; index < vertexCount * 2; index++) writer.f32(0);
  const positions: readonly (readonly [number, number])[] = [[-8, -8], [8, -8], [0, 8]];
  for (const shift of [0, translation]) {
    for (let index = 0; index < vertexCount; index++) {
      const position = positions[index % 3];
      if (position === undefined) throw new Error("MD3 fixture position is missing");
      const [y, z] = position;
      writer.i16(32 * 64); writer.i16((y + shift) * 64); writer.i16(z * 64); writer.u16(0x8040);
    }
  }
  expect(writer.offset).toBe(length);
  return writer.finish();
}

test("MD3 frontend defers allocation payload reads and backend overflow draws prior geometry before a reached component failure", async () => {
  const seed = portalMd3("solid", 0, 998), failing = portalMd3("solid", 0);
  const bytes = new Uint8Array(seed.byteLength + failing.byteLength - 220);
  // Source shortsort reverses these two equal sort words, so seed executes first.
  bytes.set(failing); bytes.set(seed.subarray(220), failing.byteLength);
  const allocation = new DataView(bytes.buffer);
  allocation.setInt32(84, 2, true); allocation.setInt32(104, bytes.byteLength, true);
  // R_LoadMD3 accepts zero surface frames; the draw still reaches the entity's frame.
  allocation.setInt32(220 + 72, 0, true);
  allocation.setInt32(220 + 100, bytes.byteLength - 220 - 2, true);
  const script = new TextEncoder().encode("solid { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["models/deferred.md3", bytes]])));
  const model = await f.resources.registerModel("models/deferred.md3");
  expect(model.kind).toBe("md3");
  const entity = createModelEntity(model); entity.axis = anglesToAxis(vec3(0, 0, 0));
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  const prepared = f.resources.prepareFrame({ refdef, entities: [entity] });
  expect(f.resources.tess.material).toBeNull();
  expect(f.recording.trace()).toHaveLength(0);
  f.commands.addPreparedViews(prepared);
  expect(() => f.commands.submit()).toThrow(Md3AllocationReadError);
  expect(f.recording.trace().flatMap(view => view.batches)).toHaveLength(1);
  expect([f.resources.tess.numVertexes, f.resources.tess.numIndexes]).toEqual([0, 0]);
  expect(f.resources.tess.allocatedVertex(0).position).toEqual(vec3(-511, -8, -8));
  const offset = (24 * 64 + 32) * 4;
  expect(Array.from(f.cpu.pixels.subarray(offset, offset + 4))).toEqual([255, 0, 0, 255]);
});

test("a later MD4 portal frontend sees retained pose zero before an earlier queued scene selects pose one", async () => {
  const script = new TextEncoder().encode("old { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } } portal { portal cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script],
    ["models/earlier.md4", portalMd4("old", 8)], ["models/portal.md4", portalMd4("portal", 128)]])));
  const earlier = createModelEntity(await f.resources.registerModel("models/earlier.md4")); earlier.frame = 1;
  const portal = createModelEntity(await f.resources.registerModel("models/portal.md4"));
  earlier.axis = anglesToAxis(vec3(0, 0, 0)); portal.axis = anglesToAxis(vec3(0, 0, 0));
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  f.submit(f.resources.prepareFrame({ refdef }));
  f.commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 64, height: 48 }, { x: 0, y: 0, z: 1, w: 1 },
    f.resources.picture(await f.resources.registerShader("old")));
  f.commands.submit();
  const retained = f.resources.tess.context.entity, before = f.recording.trace();
  expect(f.resources.tess.context.kind).toBe("2d");
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef, entities: [earlier] }));
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef, entities: [portal, createPortalEntity()] }));
  expect(f.resources.tess.context.entity).toBe(retained);
  expect(f.resources.tess.snapshotGeometry().vertices.map(vertex => vertex.position)).toEqual([
    vec3(32, -8, -8), vec3(32, 8, -8), vec3(32, 0, 8),
  ]);
  expect(f.resources.tess.numIndexes).toBe(3);
  expect(f.recording.trace()).toEqual(before);
  expect(f.commands.submitFrame()).toMatchObject({ commands: 2, views: 3 });
  expect(f.resources.tess.context.entity?.kind).toBe("model");
  const offset = (24 * 64 + 32) * 4;
  expect(Array.from(f.cpu.pixels.subarray(offset, offset + 4))).toEqual([255, 0, 0, 255]);
  if (f.gl !== null) expect(Array.from(f.gl.readPixels().subarray(offset, offset + 4))).toEqual([255, 0, 0, 255]);
});

test("queued MD3 portal selection also precedes the earlier scene's backend pose change", async () => {
  const script = new TextEncoder().encode("old { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } } portal { portal cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script],
    ["models/earlier.md3", portalMd3("old", 8)], ["models/portal.md3", portalMd3("portal", 128)]])));
  const earlier = createModelEntity(await f.resources.registerModel("models/earlier.md3")); earlier.frame = 1;
  const portal = createModelEntity(await f.resources.registerModel("models/portal.md3"));
  earlier.axis = anglesToAxis(vec3(0, 0, 0)); portal.axis = anglesToAxis(vec3(0, 0, 0));
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  f.submit(f.resources.prepareFrame({ refdef }));
  const retainedWorldEntity = f.resources.tess.context.entity;
  if (retainedWorldEntity?.kind !== "model") throw new Error("Empty source view must retain the zero-initialized world model record");
  expect(retainedWorldEntity.frame).toBe(0);
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef, entities: [earlier] }));
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef, entities: [portal, createPortalEntity()] }));
  expect(f.resources.tess.context.entity).toBe(retainedWorldEntity);
  expect([f.resources.performance.frontEnd.c_sphere_cull_md3_in, f.resources.performance.frontEnd.c_sphere_cull_md3_out]).toEqual([2, 1]);
  expect(f.resources.performance.backEnd.c_surfaces).toBe(0);
  expect(f.resources.performance.zFar).toBe(2048);
  expect(f.resources.tess.snapshotGeometry().vertices.map(vertex => vertex.position)).toEqual([
    vec3(32, -8, -8), vec3(32, 8, -8), vec3(32, 0, 8),
  ]);
  expect(f.resources.tess.numIndexes).toBe(3);
  expect(f.commands.submitFrame()).toMatchObject({ commands: 2, views: 3 });
  const offset = (24 * 64 + 32) * 4;
  expect(Array.from(f.cpu.pixels.subarray(offset, offset + 4))).toEqual([255, 0, 0, 255]);
  if (f.gl !== null) expect(Array.from(f.gl.readPixels().subarray(offset, offset + 4))).toEqual([255, 0, 0, 255]);
});

test("MD3 portal recursion uses the retained valid frame while the queued entity's missing frame fails only at backend execution", async () => {
  const bytes = portalMd3("portal", 0).slice(0, 456), allocation = new DataView(bytes.buffer);
  allocation.setInt32(104, bytes.byteLength, true);
  allocation.setInt32(220 + 72, 1, true); allocation.setInt32(220 + 104, bytes.byteLength - 220, true);
  const script = new TextEncoder().encode("portal { portal cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["models/portal.md3", bytes]])));
  const entity = createModelEntity(await f.resources.registerModel("models/portal.md3"));
  entity.axis = anglesToAxis(vec3(0, 0, 0)); entity.frame = 1;
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  f.submit(f.resources.prepareFrame({ refdef }));
  const retained = f.resources.tess.context.entity;
  const prepared = f.resources.prepareFrame({ refdef, entities: [entity, createPortalEntity()] });
  expect(f.resources.tess.context.entity).toBe(retained);
  expect(f.resources.tess.snapshotGeometry().vertices.map(vertex => vertex.position)).toEqual([
    vec3(32, -8, -8), vec3(32, 8, -8), vec3(32, 0, 8),
  ]);
  expect(f.resources.tess.numIndexes).toBe(3);
  f.commands.addPreparedViews(prepared);
  expect(() => f.commands.submit()).toThrow(Md3AllocationReadError);
  expect(f.resources.tess.context.entity?.kind).toBe("model");
  expect(f.resources.tess.numVertexes).toBe(0);
});

test("portal immediate axes execute under actual retained 2D state while scene commands remain queued", async () => {
  const script = new TextEncoder().encode("old { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } } portal { portal cull none { map $whiteimage } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script]])));
  const picture = f.resources.picture(await f.resources.registerShader("old"));
  const submitted = createBeamEntity(); submitted.customShader = await f.resources.registerShader("portal");
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  f.submit(f.resources.prepareFrame({ refdef }));
  f.commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 64, height: 48 }, { x: 1, y: 1, z: 1, w: 1 }, picture);
  f.commands.submitFrame();
  // Re-enter 2D with a pending surface; the prior frame supplies defined framebuffer contents.
  f.commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 64, height: 48 }, { x: 1, y: 1, z: 1, w: 1 }, picture);
  f.commands.submit();
  const count = f.recording.trace().length, offset = 8 * 64 * 4;
  function pixel(expected: readonly number[]): void {
    expect(Array.from(f.cpu.pixels.subarray(offset, offset + 4))).toEqual([...expected]);
    if (f.gl !== null) expect(Array.from(f.gl.readPixels().subarray(offset, offset + 4))).toEqual([...expected]);
  }
  pixel([0, 0, 255, 255]);
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef: { ...refdef, time: 64, renderFlags: RDF_NOWORLDMODEL | RDF_HYPERSPACE } }));
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef, entities: [submitted] }));
  pixel([0, 255, 0, 255]);
  expect(f.recording.trace()).toHaveLength(count);
  expect(f.resources.tess.context.kind).toBe("2d");
  expect(f.resources.tess.numIndexes).toBe(0);
  expect(f.commands.submitFrame()).toMatchObject({ commands: 2, views: 2 });
  pixel([64, 64, 64, 255]);
});

test("portal frontend failures precede scene completion and leave pending commands unconsumed", async () => {
  const script = new TextEncoder().encode("portal { portal cull none { map $whiteimage } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["models/portal.md4", portalMd4("portal", 8)]])));
  const model = createModelEntity(await f.resources.registerModel("models/portal.md4"));
  model.axis = anglesToAxis(vec3(0, 0, 0));
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef }));
  f.resources.sceneEntities.addRefEntity(model); f.resources.sceneEntities.addRefEntity(createPortalEntity());
  const range = f.resources.sceneEntities.sceneRange();
  expect(() => f.resources.prepareFrame({ refdef, entities: range })).toThrow("source backEnd.currentEntity is NULL");
  expect(f.resources.sceneEntities.sceneRange().length).toBe(2);
  expect(f.recording.trace()).toHaveLength(0);
  expect(f.commands.submitFrame()).toMatchObject({ commands: 1, views: 1 });
  f.resources.prepareFrame({ refdef, entities: range });
  expect(f.resources.sceneEntities.sceneRange().length).toBe(0);
});

test("a failed portal child frontend does not advance the next scene's entity range", async () => {
  const script = new TextEncoder().encode("portal { portal cull none { map $whiteimage } }");
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["models/portal.md4", portalMd4("portal", 8)]])));
  const model = createModelEntity(await f.resources.registerModel("models/portal.md4"));
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  f.submit(f.resources.prepareFrame({ refdef }));
  // The model's source-zero axis makes its reflected child basis invalid.
  f.resources.sceneEntities.addRefEntity(model); f.resources.sceneEntities.addRefEntity(createPortalEntity());
  const range = f.resources.sceneEntities.sceneRange();
  expect(() => f.resources.prepareFrame({ refdef, entities: range })).toThrow("finite view coordinates");
  expect(f.resources.sceneEntities.sceneRange().length).toBe(2);
  expect(f.resources.tess.numIndexes).toBe(3);
});

test("prepared scene owns frontend values but resolves registered material remaps at backend execution", async () => {
  const source = new TextEncoder().encode("old { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } } target { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } }");
  const { resources, submit } = await preparedRenderer(assets(new Map([["scripts/test.shader", source]])));
  const shader = await resources.registerShader("old");
  if (shader === null) throw new Error("Fixture shader registration failed");
  await resources.registerShader("target");
  const origin = { x: 32, y: 0, z: 0 }, color = { x: 255, y: 255, z: 255, w: 255 };
  const entity = { ...createSpriteEntity(), customShader: shader, origin, radius: 4, shaderRGBA: color };
  const entities = [entity], refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  const viewOrigin = { ...refdef.viewOrigin }, forward = { ...refdef.viewAxis[0] };
  refdef.viewOrigin = viewOrigin; refdef.viewAxis = [forward, refdef.viewAxis[1], refdef.viewAxis[2]];
  const input = { refdef, entities, polygonOffset: { factor: -1, units: -2 } };
  const prepared = resources.prepareFrame(input);
  expect(resources.tess.material).toBeNull();
  expect(resources.tess.numVertexes).toBe(0);
  const original = submit(resources.prepareFrame(input))[0];
  if (original === undefined || original.batches.length === 0) throw new Error("Fixture did not produce geometry");
  origin.x = 256; entity.radius = 100; color.z = 0; entities.length = 0;
  refdef.width = 8; refdef.height = 8; viewOrigin.y = 500; refdef.time = 4000;
  forward.x = -1; input.polygonOffset.factor = 400;
  await resources.remapShader("old", "target", null);
  const executed = submit(prepared)[0];
  if (executed === undefined) throw new Error("Prepared view missing");
  expect(executed.state.viewport).toEqual(original.state.viewport);
  expect(executed.batches.map(batch => batch.vertices.map(vertex => vertex.position)))
    .toEqual(original.batches.map(batch => batch.vertices.map(vertex => vertex.position)));
  expect(executed.batches.map(batch => batch.indices)).toEqual(original.batches.map(batch => batch.indices));
  expect(original.batches.every(batch => batch.vertices.every(vertex => vertex.color.x === 1 && vertex.color.z === 0))).toBe(true);
  expect(executed.batches.every(batch => batch.vertices.every(vertex => vertex.color.x === 0 && vertex.color.z === 1))).toBe(true);
});

test("prepared world captures visibility and projection before the caller changes its area mask", async () => {
  const script = new TextEncoder().encode("old { { map $lightmap } }");
  const map = renderBspFixture([{ shader: "old", lightmap: 0 }, { shader: "old", lightmap: 1 }], [[63, 0, 0], [0, 63, 0]]);
  const { resources, submit } = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["maps/test.bsp", map]])));
  const world = await resources.loadWorld("test"), refdef = cameraRefdef(camera(), 64, 48);
  const prepared = world.prepareFrame({ refdef });
  refdef.areaMask[0] = 2;
  expect(submit(prepared).flatMap(view => view.batches)).toHaveLength(2);
  expect(submit(world.prepareFrame({ refdef })).flatMap(view => view.batches)).toHaveLength(1);
});

test("invalid frontend submissions fail when queued, not after unrelated backend commands execute", async () => {
  const { resources } = await preparedRenderer(assets(new Map<string, Uint8Array>()));
  expect(() => resources.prepareFrame({ refdef: cameraRefdef(camera(), 64, 48) })).toThrow("NULL worldmodel");
  const refdef = { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL };
  expect(() => resources.prepareFrame({ refdef: { ...refdef, time: Number.NaN } })).toThrow("time");
});

test("prepared view publishes refdef before finish but leaves projection and cull changes at view begin", async () => {
  for (const phase of ["finish", "begin-view", "ordinary", "hyperspace"]) {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cvars.set("r_finish", "1");
    const f = await preparedRenderer(assets(new Map<string, Uint8Array>()), settings);
    const tess = f.resources.tess;
    tess.cullState("front"); tess.setGL2D(0);
    const refdef = { ...cameraRefdef(camera(), 64, 48), time: 2000, viewOrigin: vec3(1, 2, 3),
      renderFlags: RDF_NOWORLDMODEL | (phase === "hyperspace" ? RDF_HYPERSPACE : 0) };
    if (phase === "finish") f.recording.finish = () => { throw new Error("finish callback failure"); };
    if (phase === "begin-view") f.recording.beginView = () => { throw new Error("begin-view callback failure"); };
    f.commands.addPreparedViews(f.resources.prepareFrame({ refdef }));
    if (phase === "finish" || phase === "begin-view") expect(() => f.commands.submit()).toThrow(`${phase} callback failure`);
    else f.commands.submit();
    expect(tess.view.origin).toEqual(refdef.viewOrigin);
    expect(tess.floatTime).toBe(2);
    expect(tess.is2D).toBe(phase === "finish");
    expect(tess.cullState("front")).toBe(phase === "ordinary" ? "front" : "none");
  }
});

test("shadow finish retains disabled culling and identity modelview when its actual CPU quad rejects indeterminate UV", async () => {
  const cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  cvars.set("cg_shadows", "2"); cvars.set("r_primitives", "2");
  const script = new TextEncoder().encode("ordinary { cull front { map $whiteimage rgbGen identity } }");
  const map = renderBspFixture([{ shader: "ordinary", lightmap: -1 }, { shader: "ordinary", lightmap: -1 }], []);
  const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["maps/test.bsp", map]])), settings, 8);
  expect(f.cpu.stencilBits).toBe(8);
  f.resources.images.setBindingSettings(settings);
  const world = await f.resources.loadWorld("test");
  cvars.set("r_nobind", "1");
  f.commands.addPreparedViews(world.prepareFrame({ refdef: cameraRefdef(camera(), 64, 48) }));
  expect(() => f.commands.submit()).toThrow("source-indeterminate coordinates and coordinate-dependent texels");
  expect(f.recording.trace().flatMap(view => view.batches).length).toBeGreaterThan(0);
  expect(f.resources.tess.numIndexes).toBe(0);
  expect(f.resources.tess.actualCullState).toBe("none");
  expect(f.resources.tess.projectPosition(vec3(1, 2, -10)).w).toBe(10);
});

test("cloud overflow publishes the thousandth retained vertex after completed skybox draws", async () => {
  const script = new TextEncoder().encode(`clouds {
    skyparms env/clouds 128 -
    cull none
    { map $whiteimage rgbGen const ( 1 0 0 ) }
    { map $whiteimage rgbGen const ( 0 1 0 ) }
    { map $whiteimage rgbGen const ( 0 0 1 ) }
  }`);
  const files = new Map<string, Uint8Array>([["scripts/clouds.shader", script]]);
  for (const face of ["rt", "bk", "lf", "ft", "up", "dn"]) files.set(`env/clouds_${face}.tga`, solidTga(255, 0, 0));
  const f = await preparedRenderer(assets(files)), shader = await f.resources.registerShader("clouds");
  const drawImmediate = f.cpu.drawImmediate.bind(f.cpu);
  let completedSkyFaces = 0;
  f.cpu.drawImmediate = operation => {
    drawImmediate(operation);
    if (operation.kind === "sky-side") completedSkyFaces++;
  };
  const polys: RefPoly[] = Array.from({ length: 6 }, (_, face) => ({ shader,
    vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => {
      if (s === undefined || t === undefined) throw new Error("Missing cloud fixture corner");
      return { position: skyVector(face, s, t, 100), texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } };
    }) }));
  f.commands.addPreparedViews(f.resources.prepareFrame({ refdef: { ...cameraRefdef(camera(), 64, 48), renderFlags: RDF_NOWORLDMODEL }, polys }));
  expect(() => f.commands.submit()).toThrow("SHADER_MAX_VERTEXES hit in FillCloudySkySide()");
  const tess = f.resources.tess, size = Math.fround(2048 / 1.75), last = tess.allocatedVertex(999);
  expect(tess.material?.finished.numUnfoggedPasses).toBe(3);
  expect(tess.numVertexes).toBe(1000);
  expect(tess.numIndexes).toBe(1920);
  expect(last.position).toEqual(vec3(-size, size, Math.fround(-0.25 * size)));
  expect(last.texCoord).toEqual(tess.allocatedVertex(189).texCoord);
  expect(last.color).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  expect(last.normal).toEqual(vec3(0, 0, 0));
  expect(last.lightmapCoord).toEqual({ x: 0, y: 0 });
  expect(tess.snapshotGeometry().vertices).toHaveLength(1000);
  expect(() => tess.allocatedVertex(1000)).toThrow("outside scratch allocation");
  expect(tess.actualDepthRange).toEqual([1, 1]);
  expect(completedSkyFaces).toBe(6);
  expect(f.cpu.pixels.some((value, index) => index % 4 === 0 && value > 0)).toBe(true);
});

test("source clear uses stencil and fast-sky cvars changed by the reached finish callback", async () => {
  for (const stencilSetting of ["r_measureOverdraw", "cg_shadows"]) for (const enabled of [false, true]) {
    const cvars = new CvarRegistry();
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    const script = new TextEncoder().encode("ordinary { cull none { map $whiteimage } }");
    const map = renderBspFixture([{ shader: "ordinary", lightmap: -1 }, { shader: "ordinary", lightmap: -1 }], []);
    const f = await preparedRenderer(assets(new Map([["scripts/test.shader", script], ["maps/test.bsp", map]])), settings);
    const world = await f.resources.loadWorld("test");
    f.commands.addView({ viewport: { x: 0, y: 0, width: 64, height: 48 },
      clear: { depth: 1, stencil: false, color: { x: 1, y: 0, z: 0, w: 1 } }, operations: [] });
    f.commands.submit(); f.commands.beginFrame();
    const activeStencil = stencilSetting === "cg_shadows" ? "2" : "1";
    cvars.set("r_finish", "1"); cvars.set("r_measureOverdraw", "0"); cvars.set("cg_shadows", "0");
    cvars.set(stencilSetting, enabled ? "0" : activeStencil); cvars.set("r_fastsky", enabled ? "0" : "1");
    f.recording.finish = () => {
      f.cpu.finish();
      cvars.set(stencilSetting, enabled ? activeStencil : "0"); cvars.set("r_fastsky", enabled ? "1" : "0");
    };
    const views = f.submit(world.prepareFrame({ refdef: cameraRefdef(camera(), 64, 48) }));
    expect(views[0]?.state.clear).toEqual({ depth: 1, stencil: enabled, color: enabled ? { x: 0, y: 0, z: 0, w: 1 } : null });
    expect(Array.from(f.cpu.pixels.subarray(0, 4))).toEqual(enabled ? [0, 0, 0, 255] : [255, 0, 0, 255]);
  }
});
