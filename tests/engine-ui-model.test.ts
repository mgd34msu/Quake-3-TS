import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { EngineUiModelPainter } from "../src/engine/ui-model.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { DEFAULT_MODEL, RF_LIGHTING_ORIGIN, RF_NOSHADOW } from "../src/render/ref-entity.ts";
import type { SourceRefEntity } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import type { Refdef } from "../src/render/refdef.ts";
import { RendererResources } from "../src/render/world.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import type { UiModelPaintRequest } from "../src/ui/runtime.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function observe(resources: RendererResources) {
  const scenes: (Omit<WorldFrame, "entities"> & { readonly entities: readonly SourceRefEntity[] })[] = [];
  return { scenes, resources: { ...resources, renderScene: (refdef: Readonly<Refdef>) => {
    scenes.push({ refdef, entities: resources.sceneEntities.sceneRange().copyRefEntities() });
    return resources.renderScene(refdef);
  } } };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const noFiles: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: () => -1, readFileOptional: async () => undefined,
  has: () => false, list: () => [], read: async path => { throw new Error(`Unexpected asset ${path}`); } });
async function fixture(files = noFiles, width = 1280, height = 960, window: SdlWindow | null = null) {
  const images = new RendererImageCatalog(), gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(width, height, images, gl?.subpixelBits ?? 8), recording = new BatchRecordingBackend(cpu);
  const target = gl === null ? new RenderTarget(images, [recording]) : new RenderTarget(images, [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1000 };
  const cinematicClock = { reads: 0, sample(): number { this.reads++; return 1234; } };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: cinematicClock, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  const real = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const captured = observe(real), commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: real.tess, runtime: settings.runtime });
  const draw = commands.draw2D("team-ui-640"), painter = new EngineUiModelPainter(captured.resources, commands);
  const whiteFixture = real.picture(await real.registerShaderNoMip("*white"));
  const request: UiModelPaintRequest = { draw, model: DEFAULT_MODEL, rect: { x: 10.25, y: 20.75, width: 64.25, height: 48.75 },
    time: 1000, angle: 90, fieldOfViewX: 0, fieldOfViewY: 0 };
  cleanups.push(() => { commands.close("discard"); cinematics.dispose(); target.close(); window?.close(); });
  return { ...captured, draw, commands, painter, request, whiteFixture, cpu, gl, recording, cinematicClock };
}

describe("source Item_Model_Paint engine adapter", () => {
  test("already-inset rectangles scale once and zero FOV selects post-scale dimensions before integer viewport truncation", async () => {
    // Unchanged Item_Model_Paint, 32-bit SSE single-precision constants:
    // /tmp/q3-ui-model-oracle-569un1/oracle.c emits view 20 41 128 97, FOV 128.5 97.5.
    const { painter, request, scenes, cinematicClock } = await fixture();
    painter.paint(request);
    const scene = scenes[0]; if (scene === undefined) throw new Error("Missing source scene");
    expect(scene.refdef).toMatchObject({ x: 20, y: 41, width: 128, height: 97, fovX: 128.5, fovY: 97.5,
      time: 1000, renderFlags: RDF_NOWORLDMODEL, viewOrigin: { x: 0, y: 0, z: 0 } });
    expect(scene.refdef.viewAxis).toEqual([{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
    expect(cinematicClock.reads).toBe(0);
    const entity = scene.entities?.[0]; if (entity?.kind !== "model") throw new Error("Missing model");
    expect(entity.renderFlags).toBe(RF_LIGHTING_ORIGIN | RF_NOSHADOW);
    expect(entity.origin).toEqual({ x: 0, y: 0, z: -0 });
    expect(entity.oldOrigin).toEqual(entity.origin); expect(entity.lightingOrigin).toEqual(entity.origin);
    expect(entity.shaderRGBA).toEqual({ x: 0, y: 0, z: 0, w: 0 });
    expect(entity.axis[0].x).toBe(-4.371138828673793e-8);
  });

  test("explicit horizontal and vertical FOV remain independent and model view preserves surrounding 2D order", async () => {
    const { painter, request, scenes, draw, commands, whiteFixture, recording } = await fixture();
    draw.fillRect({ x: 0, y: 0, width: 1, height: 1 }, { x: 1, y: 0, z: 0, w: 1 }, whiteFixture);
    painter.paint({ ...request, fieldOfViewX: 30, fieldOfViewY: 50 });
    draw.fillRect({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 1, z: 0, w: 1 }, whiteFixture);
    expect(scenes[0]?.refdef.fovX).toBe(30); expect(scenes[0]?.refdef.fovY).toBe(50);
    commands.submit();
    expect(recording.trace().map(view => view.state.clear === null ? "2d" : "view")).toEqual(["2d", "view", "2d"]);
    const foreign = await fixture();
    expect(() => painter.paint({ ...request, draw: foreign.draw })).toThrow("engine drawing queue");
  });
});

const retail = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retail, "baseq3/pak0.pk3")))("retail rocket menu preview uses source model bounds and ordered CPU/GL views", async () => {
  const files = await VirtualFileSystem.openInspection({ dataPath: retail, homePath: retail, cdPath: null, product: "missionpack" });
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Retail menu model", width: 320, height: 240, backend: "gl", hidden: true }) : null;
  const captured = await fixture(files, 320, 240, window), model = await captured.resources.registerModel("models/weapons2/rocketl/rocketl.md3");
  const { draw, commands, painter, cpu, gl } = captured;
  const whitePicture = captured.resources.picture(await captured.resources.registerShaderNoMip("white"));
  draw.fillRect({ x: 0, y: 0, width: 640, height: 480 }, { x: 0.1, y: 0.2, z: 0.3, w: 1 }, whitePicture);
  painter.paint({ draw, model, rect: { x: 80, y: 60, width: 160, height: 120 }, time: 1000, angle: 180, fieldOfViewX: 60, fieldOfViewY: 60 });
  draw.fillRect({ x: 100, y: 80, width: 10, height: 10 }, { x: 1, y: 0, z: 0, w: 1 }, whitePicture);
  const entity = captured.scenes[0]?.entities?.[0]; if (entity?.kind !== "model") throw new Error("Missing retail model");
  // First retail rocket frame bounds: y[-5,4.296875], z[-5.203125,5.6875].
  expect(entity.origin).toEqual({ x: 20.318328857421875, y: -0.3515625, z: -0.2421875 });
  commands.submitFrame();
  expect(captured.recording.trace().map(view => view.state.clear === null ? "2d" : "view")).toEqual(["2d", "view", "2d"]);
  expect(Array.from(cpu.pixels.subarray((41 * 320 + 51) * 4, (41 * 320 + 51) * 4 + 4))).toEqual([255, 0, 0, 255]);
  let modelPixels = 0;
  for (let y = 30; y < 90; y++) for (let x = 40; x < 120; x++) if (cpu.pixels[(y * 320 + x) * 4] !== 25) modelPixels++;
  expect(modelPixels).toBeGreaterThan(100);
  if (gl !== null) {
      const pixels = gl.readPixels(); let difference = 0;
      for (let index = 0; index < pixels.length; index++) { const a = pixels[index], b = cpu.pixels[index]; if (a === undefined || b === undefined) throw new Error("Missing pixel"); difference += Math.abs(a - b); }
      expect(difference / pixels.length).toBeLessThan(1);
  }
});
