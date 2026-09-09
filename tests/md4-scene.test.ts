import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// MD4 scene integration follows id Software renderer/tr_animation.c and tr_scene.c.
// Synthetic binary layouts follow qcommon/qfiles.h. SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, spyOn, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { SourcePreparedViews } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createModelEntity, createPortalEntity, createSpriteEntity, RF_SHADOW_PLANE, RF_THIRD_PERSON } from "../src/render/ref-entity.ts";
import type { RefEntity, SceneModel } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import type { RecordedView } from "./render-target-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const triangle = [vec3(32, -8, -8), vec3(32, 8, -8), vec3(32, 0, 8)];
interface Surface {
  readonly shader: string;
  readonly positions: readonly Vec3[];
  readonly triangles: readonly (readonly [number, number, number])[];
}
function surface(shader: string): Surface { return { shader, positions: triangle, triangles: [[0, 1, 2]] }; }
function name(writer: BinaryWriter, value: string, length = 64): void {
  const bytes = new TextEncoder().encode(value);
  writer.bytes(bytes); writer.bytes(new Uint8Array(length - bytes.length));
}
function md4(lods: readonly (readonly Surface[])[], translation = 8): Uint8Array {
  const size = (mesh: Surface) => 172 + mesh.triangles.length * 12 + mesh.positions.length * 44;
  const end = 276 + lods.reduce((total, lod) => total + 12 + lod.reduce((sum, mesh) => sum + size(mesh), 0), 0);
  const writer = new BinaryWriter(end);
  writer.u32(0x34504449); writer.i32(1); name(writer, "models/scene.md4");
  for (const value of [2, 1, 0, 100, lods.length, 276, end]) writer.i32(value);
  for (const shift of [0, translation]) {
    // Bounds behind the camera discriminate MD4's lack of MD3 culling.
    for (const value of [-1024, -1, -1, -1000, 1, 1, -1012, 0, 0, 1,
      1, 0, 0, 0, 0, 1, 0, shift, 0, 0, 1, 0]) writer.f32(value);
  }
  for (const lod of lods) {
    writer.i32(lod.length); writer.i32(12); writer.i32(12 + lod.reduce((sum, mesh) => sum + size(mesh), 0));
    for (const mesh of lod) {
      const start = writer.offset, references = 168 + mesh.triangles.length * 12;
      writer.i32(0); name(writer, "body"); name(writer, mesh.shader);
      for (const value of [0, -start, mesh.positions.length, references + 4, mesh.triangles.length, 168, 1, references, size(mesh)]) writer.i32(value);
      for (const indices of mesh.triangles) for (const index of indices) writer.i32(index);
      writer.i32(0);
      for (const [index, position] of mesh.positions.entries()) {
        for (const value of [-1, 0, 0, index / 8, 0.25]) writer.f32(value);
        writer.i32(1); writer.i32(0); writer.f32(1);
        for (const value of [position.x, position.y, position.z]) writer.f32(value);
      }
    }
  }
  expect(writer.offset).toBe(end);
  return writer.finish();
}
function md3(positions: readonly Vec3[]): Uint8Array {
  const size = 188 + positions.length * 16, writer = new BinaryWriter(164 + size);
  writer.u32(0x33504449); writer.i32(15); name(writer, "models/seed.md3");
  for (const value of [0, 1, 0, 1, 0, 108, 164, 164, 164 + size]) writer.i32(value);
  for (const value of [24, -32, -16, 40, 32, 16, 32, 0, 0, 40]) writer.f32(value);
  name(writer, "seed", 16);
  writer.u32(0x33504449); name(writer, "body");
  for (const value of [0, 1, 1, positions.length, 1, 108, 120, 188, 188 + positions.length * 8, size]) writer.i32(value);
  for (const value of [0, 1, 2]) writer.i32(value);
  name(writer, "scene/blue"); writer.i32(0);
  for (const [index] of positions.entries()) { writer.f32(index / 8); writer.f32(0.25); }
  for (const position of positions) {
    writer.i16(position.x * 64); writer.i16(position.y * 64); writer.i16(position.z * 64); writer.u16(0);
  }
  expect(writer.offset).toBe(164 + size);
  return writer.finish();
}

const scripts = `
scene/red { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }
scene/green { cull none { map $whiteimage rgbGen const ( 0 1 0 ) } }
scene/blue { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } }
scene/retained { cull none { map $whiteimage rgbGen exactvertex tcGen lightmap } }
scene/diffuse { cull none { map $whiteimage rgbGen lightingDiffuse } }
scene/portal { portal cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }
`;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function renderer(entries: readonly (readonly [string, Uint8Array])[]) {
  const files = new Map<string, Uint8Array>([["scripts/scene.shader", new TextEncoder().encode(scripts)], ...entries]);
  const assets: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => files.get(path)?.byteLength ?? -1, readFileOptional: async path => files.get(path),
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing fixture ${path}`); return bytes; } });
  const images = new RendererImageCatalog(), cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "MD4 scene", width: 64, height: 64, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(64, 64, images, gl?.subpixelBits ?? 8), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(44100, () => 0);
  const clock = { milliseconds: () => 0 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: clock.milliseconds }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => queue.close("discard"));
  function submit(prepared: SourcePreparedViews): readonly RecordedView[] {
    const firstView = recording.trace().length;
    queue.addView({ viewport: { x: 0, y: 0, width: 64, height: 64 }, clear: { stencil: false, color: vec4(0, 0, 0, 1), depth: 1 }, operations: [] });
    queue.addPreparedViews(prepared); queue.submitFrame();
    return recording.trace().slice(firstView + 1);
  }
  function pixels(x: number, y: number, expected: readonly number[]): void {
    const offset = (y * 64 + x) * 4;
    expect(Array.from(cpu.pixels.subarray(offset, offset + 4))).toEqual([...expected]);
    if (gl !== null) for (const [channel, value] of gl.readPixels().subarray(offset, offset + 4).entries()) {
      const wanted = expected[channel]; if (wanted === undefined) throw new Error("Missing expected pixel channel");
      expect(Math.abs(value - wanted)).toBeLessThanOrEqual(1);
    }
  }
  function scene(entities: readonly RefEntity[]) {
    resources.sceneEntities.clearScene();
    for (const entity of entities) expect(resources.sceneEntities.addRefEntity(entity)).toBe(true);
    return resources.sceneEntities.sceneRange();
  }
  return { resources, cvars, queue, recording, cpu, gl, submit, pixels, scene };
}
function entity(model: SceneModel) {
  const result = createModelEntity(model); result.axis = anglesToAxis(vec3(0, 0, 0)); return result;
}
function refdef() {
  const result = cameraRefdef({ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) }, 64, 64);
  result.renderFlags = RDF_NOWORLDMODEL; return result;
}
function first<T>(values: readonly T[]): T {
  const value = values[0]; if (value === undefined) throw new Error("Missing scene fixture result"); return value;
}
function batches(views: readonly RecordedView[]) { return views.flatMap(view => view.batches); }

test("queued MD4 registration animates the first embedded LOD and ignores MD3 culling, personal-model and material overrides on CPU/GL", async () => {
  const f = await renderer([["models/scene.md3", md4([[surface("scene/red")], [surface("scene/blue")]])],
    ["models/override.skin", new TextEncoder().encode("body,scene/green\n")]]);
  const model = await f.resources.registerModel("models/scene.md3");
  if (model.kind !== "md4") throw new Error("MD4 ident must select skeletal registration even in a .md3 file");
  expect(model.md4.lods.map(lod => lod.map(item => item.material.name))).toEqual([["scene/red"], ["scene/blue"]]);
  const submitted = entity(model); submitted.customShader = await f.resources.registerShader("scene/green");
  submitted.customSkin = await f.resources.registerSkin("models/override.skin");
  submitted.renderFlags = RF_THIRD_PERSON | RF_SHADOW_PLANE;
  f.cvars.set("cg_shadows", "2"); f.cvars.set("r_lodscale", "0"); f.cvars.set("r_lodbias", "2");
  for (const [frame, oldFrame, backLerp, shift] of [[0, 0, 0.75, 0], [1, 0, 0.25, 6]] satisfies readonly (readonly [number, number, number, number])[]) {
    submitted.frame = frame; submitted.oldFrame = oldFrame; submitted.backLerp = backLerp;
    const range = f.scene([submitted]), cell = range.entity(0);
    const prepared = f.resources.prepareFrame({ refdef: refdef(), entities: range });
    submitted.frame = 0; submitted.backLerp = 0; submitted.origin = vec3(0, 1000, 0);
    const draws = batches(f.submit(prepared));
    expect(draws).toHaveLength(1); expect(first(draws).indices).toEqual([0, 1, 2]);
    expect(first(draws).vertices.map(vertex => [vertex.position.x, vertex.position.y, vertex.position.w])).toEqual(triangle.map(position => [-position.y - shift, position.z, 32]));
    expect(f.resources.tess.context.entity).toBe(cell.entity); expect(cell.lightingCalculated).toBe(false);
    f.pixels(32 - shift, 32, [255, 0, 0, 255]);
    submitted.origin = vec3(0, 0, 0);
  }
});

test("zero declared LODs draw a reached SF_MD4 surface through its pre-existing shader handle", async () => {
  const bytes = md4([[surface("unread/shader")]]), view = new DataView(bytes.buffer);
  view.setInt32(88, 0, true); view.setInt32(288, 7, true);
  const f = await renderer([["models/undeclared.md4", bytes]]);
  const shader = await f.resources.registerShader("scene/red");
  view.setInt32(288 + 132, f.resources.shaderHandle(shader), true);
  const model = await f.resources.registerModel("models/undeclared.md4");
  if (model.kind !== "md4") throw new Error("Expected allocated MD4 model");
  expect(model.md4.lods).toEqual([]);
  expect(first(model.md4.firstLodSurfaces()).source.name).toBe("body");
  const draw = first(batches(f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([entity(model)]) }))));
  expect(draw.indices).toEqual([0, 1, 2]);
  f.pixels(32, 32, [255, 0, 0, 255]);
});

test("an actual BSP draw supplies MD4's untouched vertex colors and lightmap coordinates", async () => {
  const f = await renderer([["models/scene.md4", md4([[surface("scene/retained")]])],
    ["maps/seed.bsp", renderBspFixture([{ shader: "scene/blue", lightmap: -1 }, { shader: "scene/blue", lightmap: -1 }], [])]]);
  const world = await f.resources.loadWorld("seed"), view = refdef(); view.renderFlags = 0;
  f.submit(world.prepareFrame({ refdef: view, entities: f.scene([]) }));
  const model = await f.resources.registerModel("models/scene.md4");
  const draw = first(batches(f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([entity(model)]) }))));
  expect(draw.vertices.map(vertex => vertex.texCoord)).toEqual(Array.from({ length: 3 }, () => ({ x: 0.5, y: 0.5 })));
  expect(draw.vertices.map(vertex => vertex.color)).toEqual(Array.from({ length: 3 }, () => ({ x: 127 / 255, y: 191 / 255, z: 1, w: 1 })));
  expect(f.resources.tess.snapshotGeometry().vertices.map(vertex => vertex.normal)).toEqual(Array.from({ length: 3 }, () => vec3(-1, 0, 0)));
  f.pixels(32, 32, [127, 191, 255, 255]);
});

test("same-shader MD4 surfaces retain the index-count base and read inactive MD3 allocation and stage cells on CPU/GL", async () => {
  const seed = [...triangle, ...triangle, vec3(32, 0, 0), vec3(32, -24, -8), vec3(32, -8, -8)];
  const quad: Surface = { shader: "scene/red", positions: [vec3(32, 8, -8), vec3(32, 16, -8), vec3(32, 16, 8), vec3(32, 8, 8)], triangles: [[0, 1, 2], [0, 2, 3]] };
  const tail: Surface = { shader: "scene/red", positions: [vec3(32, -8, -8), vec3(32, 0, -8), vec3(32, -8, 8)], triangles: [[0, 1, 2]] };
  // Source shortsort swaps two equal-sort surfaces; execute the quad before the tail.
  const f = await renderer([["models/seed.md3", md3(seed)], ["models/scene.md4", md4([[tail, quad]])]]);
  const previous = await f.resources.registerModel("models/seed.md3"), model = await f.resources.registerModel("models/scene.md4");
  f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([entity(previous)]) }));
  const sourceStates: ReturnType<typeof f.resources.tess.snapshotGeometry>[] = [];
  const endSurface = f.resources.tess.endSurface.bind(f.resources.tess);
  const ending = spyOn(f.resources.tess, "endSurface").mockImplementation(() => {
    if (f.resources.tess.numIndexes !== 0) sourceStates.push(f.resources.tess.snapshotGeometry());
    endSurface();
  });
  let views: readonly RecordedView[] = [];
  try { views = f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([entity(model)]) })); }
  finally { ending.mockRestore(); }
  const draw = first(batches(views));
  const sourceSlots = [0, 1, 2, 3, 6, 7, 8], sourceIndices = [0, 1, 2, 0, 2, 3, 6, 7, 8];
  expect(sourceStates).toHaveLength(1); expect(first(sourceStates).indices).toEqual(sourceIndices);
  expect(first(sourceStates).vertices).toHaveLength(7);
  expect(f.resources.tess.numVertexes).toBe(7); expect(f.resources.tess.numIndexes).toBe(0);
  expect(draw.indices).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
  expect(draw.indices.map(index => sourceSlots[index])).toEqual(sourceIndices);
  expect(draw.vertices).toHaveLength(7);
  expect(draw.vertices.slice(5).map(vertex => [vertex.position.x, vertex.position.y, vertex.position.w])).toEqual([[24, -8, 32], [8, -8, 32]]);
  expect(draw.vertices.slice(5).map(vertex => vertex.texCoord)).toEqual([{ x: 7 / 8, y: 0.25 }, { x: 1, y: 0.25 }]);
  expect(draw.vertices.slice(0, 5).every(vertex => vertex.color.x === 1 && vertex.color.z === 0)).toBe(true);
  expect(draw.vertices.slice(5).map(vertex => vertex.color)).toEqual([vec4(0, 0, 1, 1), vec4(0, 0, 1, 1)]);
  f.pixels(20, 32, [255, 0, 0, 255]); f.pixels(44, 36, [56, 0, 199, 255]);
});

test("MD3 lighting survives actual scene-cell reuse by next-frame MD4 without a new lighting calculation", async () => {
  const f = await renderer([["models/seed.md3", md3(triangle)], ["models/scene.md4", md4([[surface("scene/diffuse")]])]]);
  const previous = await f.resources.registerModel("models/seed.md3"), model = await f.resources.registerModel("models/scene.md4");
  const oldRange = f.scene([entity(previous)]), oldCell = oldRange.entity(0);
  f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: oldRange }));
  expect(oldCell.lightingCalculated).toBe(true); expect(oldCell.lighting.ambientLight).toEqual(vec3(182, 182, 182));
  const lighting = oldCell.lighting;
  f.resources.sceneEntities.rolloverFrame();
  const reused = f.scene([entity(model)]), cell = reused.entity(0);
  expect(cell).toBe(oldCell); expect(cell.lightingCalculated).toBe(false); expect(cell.lighting).toBe(lighting);
  const draw = first(batches(f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: reused }))));
  expect(cell.lightingCalculated).toBe(false);
  expect(draw.vertices.every(vertex => vertex.color.x === 182 / 255 && vertex.color.y === 182 / 255 && vertex.color.z === 182 / 255)).toBe(true);
  f.pixels(32, 32, [182, 182, 182, 255]);
  const fresh = f.scene([entity(model)]); expect(fresh.entity(0)).not.toBe(cell);
  f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: fresh })); f.pixels(32, 32, [0, 0, 0, 255]);
});

test("MD4 portal probing uses the submitted bone owner with the retained backend entity pose", async () => {
  const f = await renderer([["models/previous.md4", md4([[surface("scene/blue")]], 20)], ["models/portal.md4", md4([[surface("scene/portal")]])]]);
  const previous = entity(await f.resources.registerModel("models/previous.md4")); previous.frame = 1; previous.oldFrame = 0; previous.backLerp = 0.25;
  f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([previous]) }));
  const submitted = entity(await f.resources.registerModel("models/portal.md4"));
  const retainedIndex = f.recording.trace().length - 1;
  const retainedBatches = first(f.recording.trace().slice(retainedIndex)).batches.length;
  const views = f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([submitted, createPortalEntity()]) }));
  expect(views).toHaveLength(2);
  const prefix = first(first(f.recording.trace().slice(retainedIndex)).batches.slice(retainedBatches));
  expect(prefix.vertices.map(vertex => [vertex.position.x, vertex.position.y, vertex.position.w])).toEqual(triangle.map(position => [-position.y - 6, position.z, 32]));
  const parent = first(batches([first(views.slice(1))]));
  expect(parent.vertices.map(vertex => [vertex.position.x, vertex.position.y, vertex.position.w])).toEqual(triangle.map(position => [-position.y, position.z, 32]));
  f.pixels(32, 32, [255, 0, 0, 255]);
});

test("actual MD4 portal entry reports initial NULL and then consumes the retained sprite's source zero pose", async () => {
  const f = await renderer([["models/portal.md4", md4([[surface("scene/portal")]])]]);
  const model = entity(await f.resources.registerModel("models/portal.md4"));
  expect(() => f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([model, createPortalEntity()]) }))
    .toThrow("source backEnd.currentEntity is NULL");
  const sprite = createSpriteEntity(); sprite.origin = vec3(32, 0, 0); sprite.radius = 8;
  sprite.customShader = await f.resources.registerShader("scene/blue");
  f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([sprite]) }));
  const views = f.submit(f.resources.prepareFrame({ refdef: refdef(), entities: f.scene([model, createPortalEntity()]) }));
  expect(views).toHaveLength(2);
});
