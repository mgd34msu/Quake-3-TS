import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import { RendererNoise } from "../src/render/deform.ts";
import { evaluateTexCoords, parseShaderScript, SourceColorGenerator } from "../src/render/material.ts";
import type { ShaderStage } from "../src/render/material.ts";
import { animatedPictureIndex, evaluateStageColor, finishedStageBinding, iterateMaterialOperations } from "../src/render/picture-material.ts";
import { iterateProjectedDlights } from "../src/render/dlight.ts";
import type { StageColorContext } from "../src/render/picture-material.ts";
import { RenderTarget, RenderCommandBuffer } from "../src/render/commands.ts";
import { RendererResources } from "../src/render/world.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { solidTga } from "./render-bsp-fixture.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { encodePng } from "../src/core/png.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { fogCoordinates } from "../src/render/fog.ts";
import type { FogVolume } from "../src/render/fog.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import type { DrawBatch, ImmediateViewOperation, ShadowViewOperation, SourceGeometryAllocation, SourceStageData, TextureBinding } from "../src/render/types.ts";
import type { FinishedStageBinding, FinishedStageImage } from "../src/render/material.ts";
import { SourceTexCoordGenerator, SourceWaveFunction } from "../src/render/material.ts";
import type { FinishedIteratorStage } from "../src/render/material-iterator.ts";

import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage, ImageResourceOperation, CreateImageOperation } from "../src/render/image-resource.ts";
import type { PreparedBackendDraw, PreparedBackendSourceDraw, SubmissionReceipt } from "../src/render/commands.ts";
import type { CinematicUpload } from "../src/render/cinematic-command.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
class ImageRecorder extends BatchRecordingBackend {
  readonly shadows: ShadowViewOperation[] = [];
  readonly creations: CreateImageOperation[] = [];
  readonly uploads: CinematicUpload[] = [];
  readonly sourceStages: SourceStageData[] = [];
  override drawImmediate(operation: ImmediateViewOperation): undefined {
    super.drawImmediate(operation);
    if (operation.kind === "shadow-volume" || operation.kind === "shadow-finish") this.shadows.push(operation);
    return undefined;
  }
  override applyImageResource(operation: ImageResourceOperation): undefined {
    super.applyImageResource(operation);
    if (operation.kind === "create-image") this.creations.push(operation.creation);
    return undefined;
  }
  creation(image: RendererImage): CreateImageOperation {
    const result = this.creations.find(creation => creation.image === image);
    if (result === undefined) throw new Error("Missing real image publication"); return result;
  }
  override prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const prepared = super.prepareGeometry(batch);
    return {
      begin: () => prepared.begin(),
      applyTexture: (unit, operation) => {
        prepared.applyTexture(unit, operation);
        if (operation.kind === "cinematic-upload") this.uploads.push(operation.upload);
        return undefined;
      },
      draw: () => prepared.draw(), cleanup: () => prepared.cleanup(),
    };
  }
  override prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    const prepared = super.prepareSourceGeometry(stage, allocation);
    this.sourceStages.push(stage);
    return {
      begin: () => prepared.begin(),
      prepareTexture: unit => prepared.prepareTexture(unit),
      applyTexture: (unit, operation) => {
        prepared.applyTexture(unit, operation);
        if (operation.kind === "cinematic-upload") this.uploads.push(operation.upload);
        return undefined;
      },
      finishTextures: () => prepared.finishTextures(),
      draw: primitives => prepared.draw(primitives), cleanup: () => prepared.cleanup(),
    };
  }
}
function uploadedPixels(recorder: ImageRecorder): Uint8Array {
  const upload = recorder.uploads.at(-1); if (upload === undefined) throw new Error("Missing actual movie upload");
  return upload.content.copyPixels();
}
async function fixture(reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, settings = createRendererSettings(), width = 16, height = 16, stencilBits = 0) {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Consumed pictures", width, height, backend: "gl", stencilBits, hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(width, height, images, gl === null ? 8 : gl.subpixelBits, gl?.stencilBits ?? stencilBits), recorder = new ImageRecorder(cpu);
  const target = new RenderTarget(images, gl === null ? [recorder] : [recorder, gl]);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const clock = { milliseconds: () => 0 }, movieClock = { sample: () => 0 };
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: reader }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: movieClock, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl === null ? 4096 : gl.maxTextureSize } });
  disposals.push(() => { movies.closeAllVideos(); target.close(); if (window !== null) window.close(); });
  const renderer = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: renderer.tess, runtime: settings.runtime });
  queue.setColor(null);
  return { images, cpu, gl, recorder, target, builtins, clock, movieClock, renderer, queue };
}
function observed(f: Awaited<ReturnType<typeof fixture>>, receipt: SubmissionReceipt | null): readonly DrawBatch[] {
  if (receipt === null) throw new Error("Unexpected frame swap admission failure");
  const batches = f.recorder.trace().flatMap(view => view.batches);
  return receipt.batches === 0 ? [] : batches.slice(-receipt.batches);
}

function boundImage(binding: TextureBinding | undefined): RendererImage {
  if (binding?.kind !== "bind-image") throw new Error("Expected explicit image binding");
  return binding.image;
}

function imageBundle(binding: FinishedStageBinding): Extract<FinishedIteratorStage, { active: true }> {
  return { active: true, stateBits: 0x10000, imageTMU: 0, binding, rgbGen: SourceColorGenerator.Identity,
    alphaGen: "identity", tcGen: SourceTexCoordGenerator.Texture, fogAdjustment: "none", isLightmap: false, vertexLightmap: false,
    rgbWave: { func: SourceWaveFunction.None, base: 0, amplitude: 0, phase: 0, frequency: 0 },
    alphaWave: { func: SourceWaveFunction.None, base: 0, amplitude: 0, phase: 0, frequency: 0 },
    stage: { map: { kind: "none" }, blend: { source: "one", destination: "zero" }, depthFunc: "always", depthWrite: false,
      alphaFunc: "none", detail: false, rgbGen: { kind: "identity" }, alphaGen: { kind: "identity" }, tcGen: { kind: "texture" }, tcMods: [] } };
}

test("finished playback owns animation timing; stale semantic map and retain never choose fallback images", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images), target = new RenderTarget(images, [cpu]);
  disposals.push(() => target.close());
  const red: FinishedStageImage = { image: publishTexture(images, { name: "red", width: 1, height: 1, pixels: new Uint8Array([255,0,0,255]), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 }) };
  const green: FinishedStageImage = { image: publishTexture(images, { name: "green", width: 1, height: 1, pixels: new Uint8Array([0,255,0,255]), internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 }) };
  const animation = imageBundle({ kind: "images", playback: { kind: "animation", frequency: 2, frames: [red, green] } });
  expect(boundImage(finishedStageBinding(animation, 0.5))).toBe(green.image);
  expect(boundImage(finishedStageBinding(animation, -1))).toBe(red.image);
  const single = imageBundle({ kind: "images", playback: { kind: "single", image: red } });
  expect(boundImage(finishedStageBinding({ ...single, stage: { ...single.stage, map: { kind: "animation", frequency: 90, frames: ["stale", "unused"] } } }, 10))).toBe(red.image);
  expect(finishedStageBinding(imageBundle({ kind: "retain-current-texture" }), 10)).toEqual({ kind: "retain-current-texture" });
});

function optimizedSettings(): SourceRendererSettings {
  const cvars = new CvarRegistry();
  cvars.set("r_ignoreFastPath", "0", true);
  cvars.set("r_ext_texture_env_add", "1", true);
  return new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
}

async function resources(script: string, settings = createRendererSettings(), stencilBits = 0) {
  const files = new Map([["scripts/pictures.shader", new TextEncoder().encode(script)], ["red.tga", solidTga(128, 0, 0)], ["green.tga", solidTga(0, 64, 0)]]);
  return fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => files.get(path)?.byteLength ?? -1, readFileOptional: async path => files.get(path),
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing fixture ${path}`); return bytes; } }), settings, 16, 16, stencilBits);
}

test("2D remaps execute zero-edge stencil operations and retain indexes for the next source flush", async () => {
  const f = await resources("old { { map red.tga } } next { { map green.tga } }", createRendererSettings(), 8);
  const old = f.renderer.picture(await f.renderer.registerShader("old"));
  const next = f.renderer.picture(await f.renderer.registerShader("next"));
  await f.renderer.remapShader("old", "<stencil shadow>", null);
  const draw = f.queue.draw2D("pixels");
  draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, old);
  f.queue.submitFrame();
  expect(f.recorder.shadows).toHaveLength(1);
  const shadow = f.recorder.shadows[0];
  if (shadow?.kind !== "shadow-volume") throw new Error("missing real picture stencil operation");
  expect(shadow.indices).toHaveLength(0);
  expect(shadow.positions[0]).toEqual({ x: -1, y: 1, z: -1, w: 1 });
  expect("depthRange" in shadow).toBeFalse();
  expect(f.renderer.tess.numIndexes).toBe(6);
  f.queue.submit(); expect(f.recorder.shadows).toHaveLength(1);
  f.queue.submitFrame(); expect(f.recorder.shadows).toHaveLength(2);
  draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, next);
  f.queue.submit();
  expect(f.recorder.shadows).toHaveLength(3);
  expect(f.recorder.shadows[2]).toEqual(shadow);
  expect(f.renderer.tess.numIndexes).toBe(6);
  expect(observed(f, f.queue.submitFrame())).toHaveLength(1);
  expect(f.renderer.tess.numIndexes).toBe(0);
});

function stage(body: string): ShaderStage {
  const value = parseShaderScript(`fixture { { map $whiteimage\n${body}\n} }`)[0]?.stages[0];
  if (value === undefined) throw new Error("Missing parsed fixture stage");
  return value;
}
const vertex: BspVertex = { position: { x: 20, y: 30, z: 0 }, normal: { x: 0, y: 0, z: 0 },
  texCoord: { x: 0.25, y: 0.5 }, lightmapCoord: { x: 0.75, y: 0.125 }, color: { x: 127, y: 63, z: 255, w: 31 } };
const context: StageColorContext = { time: 0, identityLight: 0.5, entityRGBA: { x: 0, y: 0, z: 0, w: 0 }, lighting: null,
  viewOrigin: { x: 0, y: 0, z: 0 }, localViewOrigin: { x: 0, y: 0, z: 0 }, noise: new RendererNoise(),
  previousColor: { x: 17 / 255, y: 17 / 255, z: 17 / 255, w: 17 / 255 } };
function bytes(value: ReturnType<typeof evaluateStageColor>): readonly number[] { return [value.x, value.y, value.z, value.w].map(channel => Math.round(channel * 255)); }

describe("source picture material evaluation", () => {
  test("matches untouched ComputeColors byte fixtures and ParseStage's cross-enum alpha skip", () => {
    // Original tr_shade.c + tr_shade_calc.c, GCC O2, /tmp/quake3-picture-reference-KzSajm/colors.
    const rows: readonly { readonly rgb: string; readonly expected: readonly number[] }[] = [
      { rgb: "identityLighting", expected: [127, 127, 127, 255] },
      { rgb: "identity", expected: [255, 255, 255, 255] },
      { rgb: "entity", expected: [0, 0, 0, 255] },
      { rgb: "oneMinusEntity", expected: [255, 255, 255, 255] },
      { rgb: "exactVertex", expected: [127, 63, 255, 255] },
      { rgb: "vertex", expected: [63, 31, 127, 255] },
      { rgb: "oneMinusVertex", expected: [64, 96, 0, 255] },
      { rgb: "wave square .75 .05 0 5", expected: [102, 102, 102, 255] },
      { rgb: "const ( 0 0 0 )", expected: [0, 0, 0, 255] },
    ];
    for (const row of rows) expect(bytes(evaluateStageColor(stage(`rgbGen ${row.rgb}\nalphaGen identity`), vertex, context))).toEqual(row.expected);
    expect(bytes(evaluateStageColor(stage("rgbGen identity\nalphaGen entity"), vertex, context))).toEqual([255, 255, 255, 255]);
    expect(bytes(evaluateStageColor(stage("rgbGen vertex\nalphaGen identity"), vertex, { ...context, identityLight: 1 }))).toEqual([127, 63, 255, 31]);
    expect(bytes(evaluateStageColor(stage("rgbGen const ( .5 .25 1 )\nalphaGen const .125"), vertex, context))).toEqual([127, 63, 255, 31]);
  });

  test("menuscreen2 square color and ordered scroll/scale remain frame-time dependent", () => {
    const screen = stage("blendFunc add\ntcMod scroll 7 .2\ntcMod scale .4 .5\nrgbGen wave square .75 .05 0 5");
    expect(bytes(evaluateStageColor(screen, vertex, { ...context, identityLight: 1, time: 0 }))).toEqual([204, 204, 204, 255]);
    expect(bytes(evaluateStageColor(screen, vertex, { ...context, identityLight: 1, time: 0.125 }))).toEqual([178, 178, 178, 255]);
    expect(evaluateTexCoords(screen, vertex.texCoord, vertex.position, vertex.normal, 0.125)).toEqual({ x: 0.45000001788139343, y: 0.26249998807907104 });
  });

  test("animation uses signed fixed-table conversion and clamps negative remap time before modulo", () => {
    expect(animatedPictureIndex(0.19999999, 5, 5)).toBe(0);
    expect(animatedPictureIndex(0.2, 5, 5)).toBe(1);
    expect(animatedPictureIndex(1, 5, 5)).toBe(0);
    expect(animatedPictureIndex(-0.4, 5, 5)).toBe(0);
    expect(() => animatedPictureIndex(1, 5, 0)).toThrow("registered frames");
  });

  test("noise RGB uses actual RendererNoise and does not multiply identityLight", () => {
    const noise = stage("rgbGen wave noise .5 .25 .125 3");
    expect(evaluateStageColor(noise, vertex, context)).toEqual(evaluateStageColor(noise, vertex, { ...context, identityLight: 1 }));
    expect(evaluateStageColor(noise, vertex, context)).not.toEqual(evaluateStageColor(noise, vertex, { ...context, time: 0.25 }));
  });

  test("finished source BAD RGB falls through to identity lighting before alpha generation", () => {
    expect(bytes(evaluateStageColor(stage("rgbGen identity"), vertex, context, false, SourceColorGenerator.Bad))).toEqual([127, 127, 127, 255]);
    expect(bytes(evaluateStageColor(stage("rgbGen identity alphaGen entity"), vertex, context, false, SourceColorGenerator.Bad))).toEqual([127, 127, 127, 0]);
    expect(bytes(evaluateStageColor(stage("rgbGen identity"), vertex, context, true, SourceColorGenerator.Bad))).toEqual([127, 127, 127, 127]);
  });

  test("registered collapsed overlap draws each triangle once through both actual texture units", async () => {
    const f = await resources("collapsed { { map red.tga rgbGen identity } { map green.tga blendFunc add rgbGen identity } }", optimizedSettings()), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("collapsed"));
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const batches = observed(f, f.queue.submitFrame());
    expect(batches).toHaveLength(1);
    expect(batches[0]?.texturing).toBe("pair");
    expect(f.recorder.sourceStages.map(stage => [stage.kind, stage.stateBits])).toEqual([["generic-pair", 0x100]]);
    const cpu = f.cpu;
    expect(Array.from(cpu.pixels.slice(0, 4))).toEqual([128, 64, 0, 255]);
    if (f.gl !== null) expect(f.gl.readPixels()).toEqual(cpu.pixels);
  });

  test("optimized vertex lighting ignores authored tcMods and preserves UV scratch", async () => {
    const f = await resources("fast { { map red.tga rgbGen lightingDiffuse tcMod scroll 2 3\n} }", optimizedSettings()), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("fast"));
    expect(picture.material.finished.iterator.kind).toBe("vertex-lit");
    renderer.tess.writeStageTexCoord(0, 0, { x: 0.375, y: 0.625 });
    renderer.tess.writeStageColor(0, { x: 1, y: 0.5, z: 0.25, w: 1 });
    f.clock.milliseconds = () => 125;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    expect(observed(f, f.queue.submitFrame())[0]?.vertices[0]?.texCoord).toEqual({ x: 0, y: 0 });
    expect(f.recorder.sourceStages.map(stage => [stage.kind, stage.stateBits])).toEqual([["vertex-lit", 0x100]]);
    expect(renderer.tess.stageTexCoord(0, 0)).toEqual({ x: 0.375, y: 0.625 });
    expect(renderer.tess.stageColor(0)).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });

  test("optimized lightmapping uses original UV sets without changing color or UV scratch", async () => {
    const f = await resources("lightmapped { { map $lightmap rgbGen identity alphaFunc GT0 depthFunc equal tcMod scroll 2 3\n} { map red.tga blendFunc filter alphaFunc GT0 depthFunc equal tcMod scale 7 9\n} }", optimizedSettings()), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("lightmapped")), tess = renderer.tess;
    expect(picture.material.finished.iterator.kind).toBe("lightmapped-multitexture");
    expect(picture.material.finished.iterator.passes[0]?.stateBits).toBe(0x10020100);
    tess.beginSurface(renderer.picture(null).material, 0, 0);
    tess.appendGeometry({ vertices: [vertex, vertex, vertex, vertex], indices: [0, 1, 2] }, "bsp-normal");
    tess.endSurface();
    const retained = { x: 17 / 255, y: 33 / 255, z: 65 / 255, w: 129 / 255 };
    tess.writeStageColor(0, retained);
    tess.writeStageTexCoord(0, 0, { x: 0.375, y: 0.625 });
    tess.writeStageTexCoord(1, 0, { x: 0.875, y: 0.125 });
    f.clock.milliseconds = () => 125;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const batch = observed(f, f.queue.submitFrame())[0];
    if (batch?.texturing !== "pair") throw new Error("Expected actual collapsed lightmap batch");
    expect(f.recorder.sourceStages.map(stage => [stage.kind, stage.stateBits])).toEqual([["lightmapped-pair", 0x100]]);
    expect(batch.vertices[0]?.texCoord).toEqual({ x: 0, y: 0 });
    expect(batch.vertices[0]?.texCoord2).toEqual(vertex.lightmapCoord);
    expect(batch.vertices[0]?.color).toEqual({ x: 1, y: 1, z: 1, w: 1 });
    expect(tess.stageColor(0)).toEqual(retained);
    expect(tess.stageTexCoord(0, 0)).toEqual({ x: 0.375, y: 0.625 });
    expect(tess.stageTexCoord(1, 0)).toEqual({ x: 0.875, y: 0.125 });
  });

  test("white fills use the caller's actual registered shader and update shared source scratch", async () => {
    const f = await resources("white { { map $whiteimage blendFunc blend rgbGen vertex } }"), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("white")), tess = renderer.tess;
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    draw.fillRect({ x: 0, y: 0, width: 16, height: 16 }, { x: 1, y: 0.5, z: 0.25, w: 1 }, picture);
    const batches = observed(f, f.queue.submitFrame());
    expect(batches).toHaveLength(1);
    expect(tess.material).toBe(picture.material);
    expect(tess.numVertexes).toBe(4);
    expect(tess.stageColor(0)).toEqual({ x: 1, y: 127 / 255, z: 63 / 255, w: 1 });
    const cpu = f.cpu;
    expect(Array.from(cpu.pixels.slice(0, 4))).toEqual([255, 127, 63, 255]);
  });

  test("transparent white fills retain zero alpha beside opaque borders in one surface", async () => {
    const f = await resources("white { { map $whiteimage blendFunc blend rgbGen vertex } }"), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("white"));
    const draw = f.queue.draw2D("pixels");
    draw.fillRect({ x: 0, y: 0, width: 16, height: 16 }, { x: 1, y: 0.5, z: 0.25, w: 1 }, picture);
    f.queue.submitFrame();
    const before = Array.from(f.cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4));
    draw.fillRect({ x: 1, y: 1, width: 14, height: 14 }, { x: 0, y: 0, z: 0, w: 0 }, picture);
    draw.drawUiRect({ x: 0, y: 0, width: 16, height: 16 }, { x: 0.5, y: 0.5, z: 0.5, w: 1 }, picture);
    const batches = observed(f, f.queue.submitFrame()), stage = f.recorder.sourceStages.at(-1);
    expect(batches).toHaveLength(1);
    if (stage === undefined) throw new Error("Expected actual white-material source stage");
    expect(stage.stateBits).toBe(101);
    expect(stage.batch.vertices.map(vertex => vertex.color.w)).toEqual([...Array<number>(4).fill(0), ...Array<number>(16).fill(1)]);
    expect(stage.scratch.map(vertex => vertex.color.w)).toEqual([...Array<number>(4).fill(0), ...Array<number>(16).fill(1)]);
    expect(Array.from(f.cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4))).toEqual(before);
    expect(Array.from(f.cpu.pixels.slice(0, 4))).toEqual([127, 127, 127, 255]);
  });

  test("lightmap debugging reads live backend settings without recompiling registered passes", async () => {
    const cvars = new CvarRegistry();
    cvars.set("r_ext_texture_env_add", "1", true);
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    const f = await resources("debug { { map red.tga rgbGen identity } { map green.tga blendFunc add rgbGen identity } }", settings), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("debug")), finished = picture.material.finished;
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    cvars.set("r_lightmap", "1");
    const replacement = observed(f, f.queue.submitFrame())[0];
    if (replacement?.texturing !== "pair") throw new Error("Expected compiled texture pair");
    expect(replacement.secondTexture.environment).toBe("replace");
    const cpu = f.cpu;
    expect(Array.from(cpu.pixels.slice(0, 4))).toEqual([0, 64, 0, 255]);
    cvars.set("r_lightmap", "0");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const addition = observed(f, f.queue.submitFrame())[0];
    if (addition?.texturing !== "pair") throw new Error("Expected retained compiled texture pair");
    expect(addition.secondTexture.environment).toBe("add");
    expect(picture.material.finished).toBe(finished);
  });

  test("vertex-lighting collapse preserves the source's disabled vertexLightmap marker", async () => {
    const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cvars.set("r_vertexLight", "1", true);
    const f = await resources("vertexdebug { { map $lightmap rgbGen identity } { map red.tga blendFunc filter } }", settings), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("vertexdebug"));
    // tr_shader.c initializes this flag false; its sole true assignment is commented out.
    expect(picture.material.finished.iterator.passes[0]?.bundles[0].vertexLightmap).toBe(false);
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    cvars.set("r_lightmap", "1");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const texture = boundImage(observed(f, f.queue.submitFrame())[0]?.texture);
    expect(texture).not.toBe(picture.material.whiteImage);
    cvars.set("r_uifullscreen", "1");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    expect(boundImage(observed(f, f.queue.submitFrame())[0]?.texture)).toBe(texture);
  });

  test("polygon offset reads live renderer cvars at execution and snapshots the resulting batch", async () => {
    const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    const f = await resources("offset { polygonOffset { map red.tga } }", settings), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("offset"));
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    cvars.set("r_offsetfactor", "-3.5", true); cvars.set("r_offsetunits", "7", true);
    const batch = observed(f, f.queue.submitFrame())[0];
    expect(batch?.state.polygonOffset).toEqual({ factor: -3.5, units: 7 });
    cvars.set("r_offsetfactor", "-1", true);
    expect(batch?.state.polygonOffset).toEqual({ factor: -3.5, units: 7 });
  });

  test("animation selects the actual per-image sampler state retained by prior registrations", async () => {
    const f = await resources("clamped { { clampmap red.tga } } animated { { animMap 2 red.tga green.tga\n} }"), renderer = f.renderer;
    await renderer.registerShader("clamped");
    const picture = renderer.picture(await renderer.registerShader("animated"));
    let milliseconds = 0;
    f.clock.milliseconds = () => milliseconds;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const firstBinding = observed(f, f.queue.submitFrame())[0]?.texture;
    expect(firstBinding?.kind === "bind-image" && f.recorder.creation(firstBinding.image).sampling.wrap).toBe("clamp");
    milliseconds = 500;
    draw.drawPic({ x: -16, y: -16, width: 1, height: 1 }, renderer.picture(null));
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const secondBinding = observed(f, f.queue.submitFrame())[1]?.texture;
    expect(secondBinding?.kind === "bind-image" && f.recorder.creation(secondBinding.image).sampling.wrap).toBe("repeat");
  });

  test("registered overlapping pictures execute stage-major through actual CPU and GL", async () => {
    // Different alpha generators prevent source CollapseMultitexture; both evaluate to255 here.
    const f = await resources("layered { { map red.tga rgbGen identity } { map green.tga blendFunc add rgbGen identity alphaGen vertex } }"), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("layered"));
    f.clock.milliseconds = () => 125;
    const draw = f.queue.draw2D("pixels");
    for (let i = 0; i < 2; i++) draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const batches = observed(f, f.queue.submitFrame());
    expect(batches).toHaveLength(2);
    expect(batches.map(batch => [batch.vertices.length, batch.indices.length])).toEqual([[8, 12], [8, 12]]);
    const cpu = f.cpu;
    expect(Array.from(cpu.pixels.slice(0, 4))).toEqual([128, 128, 0, 255]);
    if (f.gl !== null) expect(f.gl.readPixels()).toEqual(cpu.pixels);
  });

  test("registered partial generator directives reach source tess colors and actual CPU pixels", async () => {
    const f = await resources(`retained {
      {
        map red.tga
        rgbGen wave sawtooth .25 .125 0 0
        rgbGen identity
        rgbGen wave square .5
        rgbGen
        alphaGen const .25
        alphaGen
        tcGen texture
        tcGen
      }
    }`);
    const handle = await f.renderer.registerShader("retained");
    expect(handle).not.toBeNull();
    const picture = f.renderer.picture(handle);
    // R_CreateImage raw-unbinds its last image without clearing the source bind cache.
    await f.renderer.registerShader("green.tga");
    f.queue.draw2D("pixels").drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const batches = observed(f, f.queue.submitFrame());
    expect(batches).toHaveLength(1);
    const vertex = batches[0]?.vertices[0];
    if (vertex === undefined) throw new Error("Expected the registered partial generator vertex");
    expect(vertex.color).toEqual({ x: 159 / 255, y: 159 / 255, z: 159 / 255, w: 63 / 255 });
    expect(f.renderer.tess.stageColor(0)).toEqual(vertex.color);
    expect(f.recorder.creation(boundImage(batches[0]?.texture)).levels[0].copyPixels().slice(0, 4)).toEqual(new Uint8Array([128, 0, 0, 255]));
    expect(Array.from(f.cpu.pixels.slice(0, 4))).toEqual([80, 0, 0, 63]);
  });

  test("registered zero-function waveforms drop at the reached stage after earlier CPU draws", async () => {
    for (const generator of ["rgbGen", "alphaGen"]) {
      const f = await resources(`invalid {
        { map red.tga rgbGen const ( .5 .5 .5 ) }
        {
          map green.tga
          rgbGen identity
          ${generator} wave
        }
      }`);
      const handle = await f.renderer.registerShader("invalid");
      expect(handle).not.toBeNull();
      f.queue.draw2D("pixels").drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.renderer.picture(handle));
      expect(() => f.queue.submitFrame()).toThrow("TableForFunc called with invalid function '0' in shader 'invalid'");
      expect(f.recorder.trace().flatMap(view => view.batches)).toHaveLength(1);
      expect(Array.from(f.cpu.pixels.slice(0, 4))).toEqual([64, 0, 0, 255]);
      const value = generator === "rgbGen" ? 127 / 255 : 1;
      expect(f.renderer.tess.stageColor(0)).toEqual({ x: value, y: value, z: value, w: 1 });
      expect(f.renderer.tess.numIndexes).toBe(6);
    }
  });

  test("registered incomplete blend factors drop at the reached CPU stage after earlier draws", async () => {
    const f = await resources(`invalid {
      { map red.tga rgbGen identity }
      {
        map green.tga
        rgbGen const ( .5 .5 .5 )
        depthFunc equal
        blendFunc GL_ONE
      }
    }`);
    const handle = await f.renderer.registerShader("invalid");
    expect(handle).not.toBeNull();
    const picture = f.renderer.picture(handle);
    expect(picture.material.finished.iterator.passes.map(pass => pass.stateBits)).toEqual([0x100, 0x20102]);
    f.queue.draw2D("pixels").drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    expect(() => f.queue.submitFrame()).toThrow("GL_State: invalid dst blend state bits\n");
    expect(f.recorder.sourceStages.map(stage => [stage.kind, stage.stateBits])).toEqual([["generic-single", 0x100], ["generic-single", 0x20102]]);
    expect(f.recorder.trace().flatMap(view => view.batches)).toHaveLength(1);
    expect(Array.from(f.cpu.pixels.slice(0, 4))).toEqual([128, 0, 0, 255]);
    expect(f.renderer.tess.stageColor(0)).toEqual({ x: 127 / 255, y: 127 / 255, z: 127 / 255, w: 1 });
    expect(f.renderer.tess.numIndexes).toBe(6);
  });

  test("registered partial move deforms source picture vertices before CPU drawing", async () => {
    const f = await resources(`moved {
      deformVertexes bulge 2
      deformVertexes move 8 0 0 square .5
      { map red.tga rgbGen identity }
    }`);
    const handle = await f.renderer.registerShader("moved");
    expect(handle).not.toBeNull();
    await f.renderer.registerShader("green.tga");
    f.queue.draw2D("pixels").drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.renderer.picture(handle));
    const batches = observed(f, f.queue.submitFrame());
    expect(batches).toHaveLength(1);
    expect(f.renderer.tess.snapshotGeometry().vertices.map(vertex => vertex.position)).toEqual([
      { x: 4, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 20, y: 16, z: 0 }, { x: 4, y: 16, z: 0 },
    ]);
    expect(Array.from(f.cpu.pixels.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(f.cpu.pixels.slice(5 * 4, 6 * 4))).toEqual([128, 0, 0, 255]);
  });

  test("deformation wave errors occur after prior draws and retained moves even when text clears all vertices", async () => {
    for (const empty of [false, true]) for (const directive of ["wave 1", "move 1 2 3", "wave 1 noise 0 0 0 1", "move 1 2 3 noise 0 0 0 0"]) {
      const f = await resources(`prior { { map red.tga rgbGen identity } }
        invalid {
          deformVertexes move 8 0 0 sin .5 0 0 0
          ${empty ? "deformVertexes text0" : ""}
          deformVertexes ${directive}
          { map green.tga rgbGen identity }
        }`);
      const prior = await f.renderer.registerShader("prior"), invalid = await f.renderer.registerShader("invalid");
      expect(invalid).not.toBeNull();
      const draw = f.queue.draw2D("pixels");
      draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.renderer.picture(prior));
      draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.renderer.picture(invalid));
      const func = directive.includes("noise") ? 6 : 0;
      expect(() => f.queue.submitFrame()).toThrow(`TableForFunc called with invalid function '${func}' in shader 'invalid'`);
      expect(f.recorder.trace().flatMap(view => view.batches)).toHaveLength(1);
      expect(Array.from(f.cpu.pixels.slice(0, 4))).toEqual([128, 0, 0, 255]);
      expect(f.renderer.tess.allocatedVertex(0).position).toEqual({ x: 4, y: 0, z: 0 });
      expect(f.renderer.tess.numVertexes).toBe(empty ? 0 : 4);
      expect(f.renderer.tess.numIndexes).toBe(empty ? 0 : 6);
    }
  });

  test("clock is sampled at command execution, cached until source enters 2D again", async () => {
    const f = await resources("wave { { map red.tga rgbGen wave square .75 .05 0 5 } }"), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("wave"));
    let milliseconds = 0, calls = 0;
    f.clock.milliseconds = () => { calls++; return milliseconds; };
    const draw = f.queue.draw2D("pixels");
    const commands = f.queue;
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    expect(calls).toBe(0);
    milliseconds = 125;
    expect(observed(f, commands.submit())).toHaveLength(0);
    // RB_ExecuteRenderCommands samples both ends; RB_SetGL2D samples on entry.
    expect(calls).toBe(3);
    expect(renderer.tess.floatTime).toBe(0.125);
    expect(renderer.tess.numIndexes).toBe(6);
    milliseconds = 250;
    expect(commands.submit().batches).toBe(0);
    expect(f.recorder.trace().flatMap(view => view.batches)).toEqual([]);
    expect(renderer.tess.numIndexes).toBe(6);
    expect(calls).toBe(5);
    expect(renderer.tess.floatTime).toBe(0.125);
    const first = observed(f, commands.submitFrame());
    expect(first[0]?.vertices[0]?.color.x).toBe(178 / 255);
    expect(renderer.tess.numIndexes).toBe(0);
    expect(f.recorder.trace().flatMap(view => view.batches)).toEqual([...first]);
    expect(calls).toBe(7);
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    expect(commands.submit().batches).toBe(0);
    expect(calls).toBe(10);
    expect(renderer.tess.floatTime).toBe(0.25);
    expect(renderer.tess.numIndexes).toBe(6);
    expect(observed(f, commands.submitFrame())).toHaveLength(1);
    expect(calls).toBe(12);
  });

  test("capacity flushes before vertex1000 and remap lookup stays one hop per BeginSurface", async () => {
    const f = await resources("old { { map red.tga } } replacement { { map green.tga } }"), renderer = f.renderer;
    const old = await renderer.registerShader("old"), picture = renderer.picture(old);
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    for (let i = 0; i < 250; i++) draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, picture);
    expect(observed(f, f.queue.submit()).map(batch => [batch.vertices.length, batch.indices.length])).toEqual([[996, 1494]]);
    expect(renderer.tess.numVertexes).toBe(4);
    expect(renderer.tess.numIndexes).toBe(6);
    expect(observed(f, f.queue.submitFrame()).map(batch => [batch.vertices.length, batch.indices.length])).toEqual([[4, 6]]);
    await renderer.remapShader("old", "replacement", ".25");
    draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, picture);
    // No new BeginSurface when the raw handle still equals the retained tess.shader.
    expect(f.recorder.creation(boundImage(observed(f, f.queue.submitFrame())[0]?.texture)).levels[0].copyPixels().slice(0, 3)).toEqual(new Uint8Array([128, 0, 0]));
    draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, renderer.picture(null));
    draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, picture);
    expect(f.recorder.creation(boundImage(observed(f, f.queue.submitFrame())[1]?.texture)).levels[0].copyPixels().slice(0, 3)).toEqual(new Uint8Array([0, 64, 0]));
    expect(renderer.tess.shaderTime).toBe(-0.25);
  });

  test("StretchPic preserves previous tess normals and lightmap UVs through real deformation", async () => {
    const f = await resources("retained { deformVertexes wave 1 sin 2 0 0 0 { map red.tga tcGen lightmap } }"), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("retained")), tess = renderer.tess;
    tess.beginSurface(picture.material, 0, 0);
    tess.appendGeometry({ vertices: [{ ...vertex, normal: { x: 0, y: 0, z: 1 } }, vertex, vertex, vertex], indices: [0, 1, 2] }, "bsp-normal");
    tess.endSurface();
    // A different material starts a fresh count, but no source attribute clear.
    tess.beginSurface(renderer.picture(null).material, 0, 0); tess.endSurface();
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 8, height: 8 }, picture);
    const batch = observed(f, f.queue.submitFrame())[0];
    expect(batch?.vertices[0]?.texCoord).toEqual(vertex.lightmapCoord);
    expect(batch?.vertices[0]?.position.z).toBe(-5);
    expect(tess.snapshotGeometry().vertices[0]?.normal).toEqual({ x: 0, y: 0, z: 1 });
    const other = new SourceTessState();
    expect(other.numVertexes).toBe(0); expect(other.stageColor(0)).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });

  test("same shader retains real world fog and publishes fog color/UV scratch for following surfaces", async () => {
    const f = await resources("fogged { { map red.tga } }"), renderer = f.renderer;
    const picture = renderer.picture(await renderer.registerShader("fogged")), tess = renderer.tess;
    const fog: FogVolume = { bounds: { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } },
      surface: { normal: { x: 1, y: 0, z: 0 }, distance: -100 }, color: { x: 0, y: 0, z: 1, w: 1 }, tcScale: 0.02 };
    const coordinates = fogCoordinates(fog, { x: -10, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    tess.beginSurface(picture.material, 1, 0);
    tess.setFogContext({ volume: fog, texture: f.builtins.fogImage, coordinates });
    tess.endSurface();
    f.clock.milliseconds = () => 0;
    const draw = f.queue.draw2D("pixels");
    draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
    const batches = observed(f, f.queue.submitFrame());
    expect(batches).toHaveLength(2); expect(batches[1]?.state.depthTest).toBe("equal");
    expect(f.recorder.sourceStages.map(stage => [stage.kind, stage.stateBits])).toEqual([["generic-single", 0x100], ["fog", 0x20065]]);
    expect(tess.stageColor(0)).toEqual(fog.color); expect(tess.stageTexCoord(0, 0)).toEqual(coordinates({ x: 0, y: 0, z: 0 }));
    const cpu = f.cpu;
    expect(cpu.pixels[2]).toBe(255); expect(cpu.pixels[0]).toBe(0);
  });

  test("projected dlight source operations encode their actual additive and modulated state", async () => {
    const settings = createRendererSettings(), f = await resources("lit { { map red.tga rgbGen identity } }", settings);
    const material = f.renderer.picture(await f.renderer.registerShader("lit")).material, tess = f.renderer.tess;
    tess.beginSurface(material, 0, 0);
    tess.appendGeometry({ vertices: [vertex, vertex, vertex], indices: [0, 1, 2] }, "bsp-normal");
    const light = { origin: vertex.position, color: { x: 1, y: 1, z: 1 }, radius: 64 };
    const project = (position: BspVertex["position"]) => ({ ...position, w: 1 });
    const dlight = f.builtins.find("*dlight");
    if (dlight === undefined) throw new Error("Built-in dynamic light image was not registered");
    const lights = iterateProjectedDlights(tess.snapshotGeometry(), 3, [light, { ...light, additive: true }], dlight.image, project, "none");
    const operations = [...iterateMaterialOperations(material, tess, project, 1, context.noise, settings.runtime, lights)];
    expect(operations.flatMap(operation => operation.kind === "source-tess-stage" ? [[operation.stage.kind, operation.stage.stateBits]] : []))
      .toEqual([["generic-single", 0x100], ["dlight", 0x20023], ["dlight", 0x20022]]);
  });
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail Team Arena menuscreen2 and clanlogo animate through actual CPU and GL", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const f = await fixture(assets, createRendererSettings(), 320, 240), renderer = f.renderer;
  const screenShader = await renderer.registerShaderNoMip("menuscreen2"), logoShader = await renderer.registerShaderNoMip("clanlogo");
  expect(screenShader).not.toBeNull(); expect(logoShader).not.toBeNull();
  const screen = renderer.picture(screenShader), logo = renderer.picture(logoShader);
  let milliseconds = 125;
  f.clock.milliseconds = () => milliseconds; f.movieClock.sample = () => 5000;
  const draw = f.queue.draw2D("team-ui-640");
  const cpu = f.cpu, gl = f.gl, hashes: string[] = [];
  for (milliseconds of [125, 250, 450]) {
    f.queue.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    draw.drawPic({ x: 0, y: 0, width: 640, height: 480 }, screen);
    draw.drawPic({ x: 160, y: 80, width: 320, height: 320 }, logo);
    const batches = observed(f, f.queue.submitFrame());
    expect(batches.length).toBeGreaterThan(2);
    hashes.push(new Bun.CryptoHasher("sha256").update(cpu.pixels).digest("hex"));
    if (gl !== null) {
      const pixels = gl.readPixels(); let maximum = 0, sum = 0;
      for (const [index, actual] of pixels.entries()) {
        const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing retail CPU pixel");
        const error = Math.abs(actual - expected); maximum = Math.max(maximum, error); sum += error;
      }
      expect(maximum).toBeLessThanOrEqual(3); expect(sum / pixels.length).toBeLessThan(0.1);
    }
    const capture = process.env["Q3_PICTURE_CAPTURE"];
    if (capture !== undefined) await Bun.write(`${capture}.${milliseconds}.cpu.png`, encodePng(320, 240, cpu.pixels));
  }
  expect(new Set(hashes).size).toBe(3);

}, 60000);

test.skipIf(dataPath === undefined)("2D videoMap uses the registered real movie and an independent cinematic clock", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const path = "scripts/000_picture_video.shader", script = new TextEncoder().encode("picturemovie { clampTime .001 { videoMap mpteam1.roq } { videoMap video/mpteam1.roq blendFunc add } }");
  let reads = 0, milliseconds = 900000, cinematic = 5000;
  const f = await fixture({ ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: name => name === path ? Promise.resolve(script) : Promise.resolve(undefined) }, vfs), readFileLength: name => name === path ? script.byteLength : vfs.readFileLength(name),
    readFileOptional: name => name === path ? Promise.resolve(script) : vfs.readFileOptional(name),
    has: name => name === path || vfs.has(name),
    list: prefix => prefix === "scripts/" ? [path, ...vfs.list(prefix)] : vfs.list(prefix),
    read: name => { if (name === path) return Promise.resolve(script); if (name === "video/mpteam1.roq") reads++; return vfs.read(name); } }), renderer = f.renderer;
  f.movieClock.sample = () => cinematic;
  const picture = renderer.picture(await renderer.registerShader("picturemovie"));
  f.clock.milliseconds = () => milliseconds;
  const draw = f.queue.draw2D("pixels");
  const frame = () => { draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture); return observed(f, f.queue.submitFrame()); };
  const first = frame(), binding = first[0]?.texture;
  if (binding?.kind !== "shader-cinematic") throw new Error("Expected actual cinematic binding");
  const texture = binding.source.image;
  expect(f.recorder.creation(texture).sampling.wrap).toBe("clamp");
  const secondBinding = first[1]?.texture;
  expect(secondBinding?.kind === "shader-cinematic" ? secondBinding.source.image : null).toBe(texture); expect(reads).toBe(1);
  expect(renderer.tess.shaderTime).toBe(Math.fround(0.001));
  // First source Run has no decoded frame: retain the genuinely registered scratch image.
  expect(f.recorder.uploads).toHaveLength(0);
  const initialHash = new Bun.CryptoHasher("sha256").update(f.recorder.creation(texture).levels[0].copyPixels()).digest("hex");
  milliseconds = 1000000; cinematic = 5034;
  const second = frame();
  expect(second.every(batch => batch.texture.kind === "shader-cinematic" && batch.texture.source.image === texture)).toBe(true);
  const advanced = new Bun.CryptoHasher("sha256").update(uploadedPixels(f.recorder)).digest("hex");
  expect(advanced).not.toBe(initialHash);
  milliseconds += 10000; frame();
  expect(new Bun.CryptoHasher("sha256").update(uploadedPixels(f.recorder)).digest("hex")).toBe(advanced);
  const cpu = f.cpu;
  expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
}, 60000);

test.skipIf(dataPath === undefined)("successful retail video followed by failed video emits a real no-bind operation", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const path = "scripts/000_retained_video.shader";
  const script = new TextEncoder().encode("preceding { { map red-retain.tga rgbGen identity } } sticky { { videoMap mpteam1.roq videoMap missing-retain.roq rgbGen identity } }");
  const f = await fixture({ ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: name => name === path ? Promise.resolve(script) : name === "red-retain.tga" ? Promise.resolve(solidTga(128, 0, 0)) : Promise.resolve(undefined) }, vfs), readFileLength: name => name === path ? script.byteLength : name === "red-retain.tga" ? solidTga(128, 0, 0).byteLength : vfs.readFileLength(name),
    readFileOptional: name => name === path ? Promise.resolve(script) : name === "red-retain.tga" ? Promise.resolve(solidTga(128, 0, 0)) : vfs.readFileOptional(name),
    has: name => name === path || name === "red-retain.tga" || vfs.has(name),
    list: prefix => prefix === "scripts/" ? [path, ...vfs.list(prefix)] : vfs.list(prefix),
    read: name => name === path ? Promise.resolve(script) : name === "red-retain.tga" ? Promise.resolve(solidTga(128, 0, 0)) : vfs.read(name) },
    createRendererSettings()), renderer = f.renderer;
  const preceding = renderer.picture(await renderer.registerShader("preceding")), handle = await renderer.registerShader("sticky");
  expect(handle).not.toBeNull();
  const sticky = renderer.picture(handle);
  expect(sticky.material.finished.iterator.passes[0]?.bundles[0].binding).toEqual({ kind: "retain-current-texture" });
  f.clock.milliseconds = () => 100;
  f.movieClock.sample = () => 100;
  const draw = f.queue.draw2D("pixels");
  // Establish a different cached image by a real draw before measuring red -> retain.
  draw.drawPic({ x: -16, y: -16, width: 1, height: 1 }, renderer.picture(await renderer.registerShader("*white")));
  f.queue.submitFrame();
  draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, preceding);
  draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, sticky);
  const batches = observed(f, f.queue.submitFrame());
  expect(batches[1]?.texture).toEqual({ kind: "retain-current-texture" });
  const cpu = f.cpu;
  expect(Array.from(cpu.pixels.slice(0, 4))).toEqual([128, 0, 0, 255]);
  if (f.gl !== null) expect(f.gl.readPixels()).toEqual(cpu.pixels);
}, 60000);
