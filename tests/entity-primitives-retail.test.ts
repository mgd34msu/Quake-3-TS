import { HunkArena } from "../src/core/hunk.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, test } from "bun:test";
import { cameraRefdef } from "./refdef-fixture.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { encodePng } from "../src/core/png.ts";
import { createLightningEntity, createModelEntity, createRailCoreEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import type { WorldFrame } from "../src/render/world.ts";
import type { SourcePreparedViews } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const dataPath = process.env["Q3_DATA"];
const clear = { x: 0, y: 0, z: 0, w: 1 };
const white = { x: 255, y: 255, z: 255, w: 255 };

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function entityRenderer(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, milliseconds: number) {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Retail entity primitives", width: 320, height: 240, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), cpu = new SoftwareRenderer(320, 240, images, gl?.subpixelBits ?? 8);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const settings = createRendererSettings(), clock = { milliseconds: () => milliseconds };
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  function submit(prepare: SourcePreparedViews) {
    const start = recording.trace().length + 1;
    commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, color: clear, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    commands.addPreparedViews(prepare); commands.submit();
    return recording.trace().slice(start);
  }
  return { resources, cpu, gl, submit };
}

async function comparePixels(name: string, cpu: SoftwareRenderer, gl: GlRenderer | null, view: WorldFrame): Promise<Uint8Array> {
  const output = process.env["Q3_ENTITY_IMAGES"];
  if (output !== undefined) await Bun.write(`${output}/${name}-cpu.png`, encodePng(view.refdef.width, view.refdef.height, cpu.pixels));
  if (gl !== null) {
      const pixels = gl.readPixels();
      let sum = 0, rgbSum = 0, rgbMaximum = 0;
      for (const [index, value] of pixels.entries()) {
        const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("missing CPU image channel");
        const difference = Math.abs(value - expected);
        sum += difference;
        if (index % 4 !== 3) { rgbSum += difference; rgbMaximum = Math.max(rgbMaximum, difference); }
      }
      expect(sum / pixels.length).toBeLessThan(3);
      if (output !== undefined) {
        await Bun.write(`${output}/${name}-gl.png`, encodePng(view.refdef.width, view.refdef.height, pixels));
        await Bun.write(`${output}/${name}.json`, JSON.stringify({ width: view.refdef.width, height: view.refdef.height,
          meanRgbError: rgbSum / (view.refdef.width * view.refdef.height * 3), maximumRgbError: rgbMaximum, depthBits: gl.depthBits, driver: gl.driver }, null, 2));
      }
  }
  return new Uint8Array(cpu.pixels);
}

test.skipIf(dataPath === undefined)("retail procedural shaders render before a world and rail RGBA retains preceding sprite alpha", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const { resources, cpu, gl, submit } = await entityRenderer(assets, 1000);
  const sprite = { ...createSpriteEntity(), customShader: await resources.registerShader("smokePuff"), origin: vec3(80, 20, 0), radius: 12, shaderRGBA: white };
  const bolt = { ...createLightningEntity(), customShader: await resources.registerShader("lightningBolt"), origin: vec3(96, -24, -24), oldOrigin: vec3(128, 0, 24), shaderRGBA: white };
  const axis = { ...createModelEntity(), origin: vec3(80, -12, -20), axis: anglesToAxis(vec3(0, 0, 0)) };
  const view: WorldFrame = { refdef: { ...cameraRefdef({ origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) }, 320, 240, 1000), renderFlags: RDF_NOWORLDMODEL } };
  const batches = submit(resources.prepareFrame({ ...view, entities: [sprite, bolt, axis] }));
  expect(batches.flatMap(view => view.batches).some(batch => batch.primitive === "lines")).toBe(true);
  expect(batches.flatMap(view => view.batches).filter(batch => batch.primitive === "triangles").some(batch => batch.vertices.length === 16)).toBe(true);
  const pixels = await comparePixels("retail-procedural", cpu, gl, view);
  expect(pixels.filter((value, index) => index % 4 !== 3 && value > 20).length).toBeGreaterThan(1000);
  const core = { ...createRailCoreEntity(), customShader: await resources.registerShader("railCore"), origin: bolt.oldOrigin, oldOrigin: bolt.origin,
    shaderRGBA: { x: 128, y: 64, z: 32, w: 0 } };
  expect(core.customShader).not.toBeNull();
  submit(resources.prepareFrame({ ...view, entities: [{ ...sprite, shaderRGBA: { x: 255, y: 255, z: 255, w: 47 } }] }));
  const seeded = resources.tess.snapshotGeometry();
  const railViews = submit(resources.prepareFrame({ ...view, entities: [core] })), railBatches = railViews.flatMap(view => view.batches);
  expect(railBatches).toHaveLength(1);
  const railBatch = railBatches[0]; if (railBatch === undefined) throw new Error("retail rail batch missing");
  expect(railBatch.indices).toEqual([0, 1, 2, 2, 1, 3]);
  // RB_AddQuadStampExt stores all RGBA bytes. DoRailCore writes only RGB and quarters its first corner.
  expect(railBatch.vertices.map(vertex => vertex.color)).toEqual([
    { x: 32 / 255, y: 16 / 255, z: 8 / 255, w: 47 / 255 },
    ...Array.from({ length: 3 }, () => ({ x: 128 / 255, y: 64 / 255, z: 32 / 255, w: 47 / 255 })),
  ]);
  expect(resources.tess.snapshotGeometry().vertices.map(vertex => ({ normal: vertex.normal, uv1: vertex.lightmapCoord })))
    .toEqual(seeded.vertices.map(vertex => ({ normal: vertex.normal, uv1: vertex.lightmapCoord })));
  const railPixels = await comparePixels("retail-rail-retained", cpu, gl, view);
  expect(railPixels.filter((value, index) => index % 4 !== 3 && value > 20).length).toBeGreaterThan(100);
});

test.skipIf(dataPath === undefined)("retail inline brush model uses registered map identity and transformed lightmap geometry", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const { resources, cpu, gl, submit } = await entityRenderer(assets, 0), scene = await resources.loadWorld("q3dm2");
  const model = scene.inlineModel(1);
  const view: WorldFrame = { refdef: cameraRefdef({ origin: vec3(-1888, -2300, 96), angles: vec3(0, 270, 0) }, 320, 240) };
  const entity = { ...createModelEntity(model), axis: anglesToAxis(vec3(0, 0, 0)), origin: vec3(40, 0, 0), shaderRGBA: white };
  const before = submit(scene.prepareFrame(view)), beforePixels = new Uint8Array(cpu.pixels);
  const batches = submit(scene.prepareFrame({ ...view, entities: [entity] }));
  expect(batches.flatMap(view => view.batches).length).toBeGreaterThan(before.flatMap(view => view.batches).length);
  const override = await resources.registerShader("lightningBolt");
  expect(submit(scene.prepareFrame({ ...view, entities: [{ ...entity, customShader: override }] }))).toEqual(batches);
  expect(() => scene.prepareFrame({ ...view, entities: [{ ...entity, model: { ...model } }] })).toThrow("unregistered");
  const pixels = await comparePixels("retail-inline", cpu, gl, view);
  let changed = 0;
  for (const [index, value] of pixels.entries()) if (value !== beforePixels[index]) changed++;
  expect(changed).toBeGreaterThan(100);
  const anotherWorld = await resources.loadWorld("q3dm2");
  expect(() => anotherWorld.prepareFrame({ ...view, entities: [entity] })).toThrow("another world");
  expect(scene.markGeometry.surfaces.length).toBe(scene.map.surfaces.length);
  expect(scene.lightForPoint(view.refdef.viewOrigin)).not.toBeNull();
});
