import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { ClientGameStaticState } from "../src/cgame/state.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage, ImageResourceOperation, CreateImageOperation } from "../src/render/image-resource.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererResources } from "../src/render/world.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { createImageColorMappings } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import type { Product } from "../src/shared/definitions.ts";
import type { SceneShader } from "../src/render/ref-entity.ts";
import type { DrawBatch, TextureBinding } from "../src/render/types.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const products: readonly Product[] = ["baseq3", "missionpack"];
const clock = { milliseconds: () => 1000 };
class RecordingImages extends BatchRecordingBackend {
  readonly operations: ImageResourceOperation[] = [];
  override applyImageResource(operation: ImageResourceOperation): undefined {
    super.applyImageResource(operation); this.operations.push(operation); return undefined;
  }
  creation(image: RendererImage): CreateImageOperation {
    const result = this.operations.find(operation => operation.kind === "create-image" && operation.creation.image === image);
    if (result === undefined || result.kind !== "create-image") throw new Error("Missing actual image creation");
    return result.creation;
  }
}
function pipeline() {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Source built-ins", width: 16, height: 16, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const cpu = new SoftwareRenderer(16, 16, images, gl === null ? 8 : gl.subpixelBits), recorder = new RecordingImages(cpu);
  const imageProfile = (): ImageUploadProfile => ({
    picmip: 0, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false, textureBits: 32,
    textureCompression: "none", maxTextureSize: gl === null ? null : gl.maxTextureSize,
    // This byte-comparison fixture deliberately selects neutral software color mapping.
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: gl === null ? cpu.configuration.colorBits : gl.colorBits }),
  });
  const target = new RenderTarget(images, gl === null ? [recorder] : [recorder, gl]), builtins = new BuiltinImages(images, imageProfile);
  return { images, cpu, gl, recorder, target, builtins, imageProfile, close: () => { target.close(); if (window !== null) window.close(); } };
}
async function fixture(reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">) {
  const f = pipeline(), settings = createRendererSettings();
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: reader }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds },
    scratchImages: f.builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: f.gl === null ? 4096 : f.gl.maxTextureSize } });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, target: f.target, images: f.images, builtins: f.builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics, imageProfile: f.imageProfile });
  const queue = new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  return { ...f, resources, queue, close: () => { cinematics.closeAllVideos(); f.close(); } };
}
function pictureBatch(f: Awaited<ReturnType<typeof fixture>>, shader: SceneShader | null) {
  const draw = f.queue.draw2D("pixels"), before = f.recorder.trace().flatMap(view => view.batches).length;
  draw.setColor({ x: 0.25, y: 0.5, z: 0.75, w: 0.5 });
  draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, f.resources.picture(shader));
  expect(f.queue.submit().batches).toBe(1);
  const batches = f.recorder.trace().flatMap(view => view.batches).slice(before); expect(batches).toHaveLength(1);
  const batch = batches[0]; if (batch === undefined) throw new Error("Missing actual picture draw"); return batch;
}
function imageBinding(batch: DrawBatch): Extract<TextureBinding, { readonly kind: "bind-image" }> {
  if (batch.texture.kind !== "bind-image") throw new Error("Expected image binding"); return batch.texture;
}

test("prepared builtins consume effective identity bytes, source mip flags and current catalog filter", () => {
  const images = new RendererImageCatalog(), session = images.openSession(), operations: ImageResourceOperation[] = [];
  session.attach({ images, applyImageResource: operation => { operations.push(operation); } });
  images.setTextureMode("GL_NEAREST_MIPMAP_LINEAR");
  const colorMappings = createImageColorMappings({ gamma: 1, intensity: 2, requestedOverbrightBits: 1,
    deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 });
  const imageProfile = (): ImageUploadProfile => ({ picmip: 1, roundImagesDown: false, simpleMipMaps: true,
    colorMipLevels: false, textureBits: 16, textureCompression: "none", maxTextureSize: null, colorMappings });
  const builtins = new BuiltinImages(images, imageProfile);
  const creations = operations.flatMap(operation => operation.kind === "create-image" ? [operation.creation] : []);
  const creation = (name: string): CreateImageOperation => {
    const result = creations.find(item => item.image.name === name);
    if (result === undefined) throw new Error(`Missing builtin ${name}`);
    return result;
  };
  const identity = creation("*identityLight"), scratch = creation("*scratch"), defaultImage = creation("*default");
  expect(identity.levels[0].copyPixels().slice(0, 4)).toEqual(new Uint8Array([127, 127, 127, 255]));
  expect(scratch.levels[0].copyPixels().slice(0, 4)).toEqual(new Uint8Array([127, 127, 127, 255]));
  expect([scratch.image.sourceWidth, scratch.image.sourceHeight, scratch.levels[0].width, scratch.levels[0].height]).toEqual([16, 16, 8, 8]);
  expect(defaultImage.levels.map(level => [level.width, level.height])).toEqual([[16, 16], [8, 8], [4, 4], [2, 2], [1, 1]]);
  expect(defaultImage.levels[0].copyPixels().slice(68, 72)).toEqual(new Uint8Array([64, 64, 64, 32]));
  expect(defaultImage.sampling.filter).toBe("nearest-mipmap-linear");
  expect(defaultImage.internalFormat).toBe("rgba4"); expect(identity.internalFormat).toBe("rgb5");
  expect(creations.filter(item => item.mipmap).map(item => item.image.name)).toEqual(["*default"]);
  expect(creations.filter(item => !item.mipmap).every(item => item.sampling.filter === "linear")).toBe(true);
  expect(builtins.find("*scratch")?.image).toBe(builtins.scratchImage(31));
  expect(new Set(Array.from({ length: 32 }, (_, i) => builtins.scratchImage(i))).size).toBe(32);
  expect(operations.at(-1)).toEqual({ kind: "current-border-color", color: { x: 1, y: 1, z: 1, w: 1 } });
  session.close();
});

test("prepared builtins retain established neutral base byte hashes after full mip preparation", () => {
  const images = new RendererImageCatalog(), session = images.openSession(), creations: CreateImageOperation[] = [];
  session.attach({ images, applyImageResource: operation => { if (operation.kind === "create-image") creations.push(operation.creation); } });
  const colorMappings = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
    deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 });
  new BuiltinImages(images, () => ({ picmip: 0, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 32, textureCompression: "none", maxTextureSize: null, colorMappings }));
  for (const [name, expected] of [["*default", 3473967445], ["*white", 111364805], ["*identityLight", 111364805],
    ["*dlight", 1830504773], ["*fog", 1305453869]] satisfies readonly (readonly [string, number])[]) {
    const creation = creations.find(item => item.image.name === name);
    if (creation === undefined) throw new Error(`Missing builtin ${name}`);
    let hash = 2166136261;
    for (const value of creation.levels[0].copyPixels()) hash = Math.imul(hash ^ value, 16777619) >>> 0;
    expect(hash).toBe(expected);
  }
  session.close();
});

test("all built-in RGBA bytes match extracted unchanged R_CreateBuiltinImages native output", () => {
  // gcc -std=gnu99 -O0; exact original image-construction functions, recording R_CreateImage.
  const f = pipeline(), images = f.builtins, lines: string[] = [];
  for (const [name, expected] of [["*default", 3473967445], ["*white", 111364805], ["*identityLight", 111364805],
    ["*dlight", 1830504773], ["*fog", 1305453869]] satisfies readonly (readonly [string, number])[]) {
    const builtin = images.find(name);
    if (builtin === undefined) throw new Error(`Missing source image ${name}`);
    let hash = 2166136261;
    for (const value of f.recorder.creation(builtin.image).levels[0].copyPixels()) hash = Math.imul(hash ^ value, 16777619) >>> 0;
    expect(hash).toBe(expected);
    lines.push(`${name}|${builtin.image.sourceWidth}|${builtin.image.sourceHeight}|${builtin.mipmap ? 1 : 0}|${builtin.allowPicmip ? 1 : 0}|${builtin.wrap === "repeat" ? 10497 : 10496}|${hash}`);
  }
  const oracle = process.env["Q3_BUILTIN_IMAGE_ORACLE"] ?? "/tmp/quake3-builtin-image-reference-LiJVPx/reference";
  if (existsSync(oracle)) {
    const result = Bun.spawnSync([oracle]); expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim().split("\n")).toEqual([...lines, "BORDER|1|1|1|1"]);
  }
  f.close();
});

test("built-in image pixels and cached texture parameters match R_CreateBuiltinImages", () => {
  const f = pipeline(), images = f.builtins;
  expect([...f.recorder.creation(images.defaultImage).levels[0].copyPixels().slice(0, 4)]).toEqual([255, 255, 255, 255]);
  expect([...f.recorder.creation(images.defaultImage).levels[0].copyPixels().slice(68, 72)]).toEqual([32, 32, 32, 32]);
  for (const [name, width, height, mipmap, wrap] of [
    ["*default", 16, 16, true, "repeat"], ["*white", 8, 8, false, "repeat"],
    ["*identityLight", 8, 8, false, "repeat"], ["*dlight", 16, 16, false, "clamp"], ["*fog", 256, 32, false, "clamp"],
  ] satisfies readonly (readonly [string, number, number, boolean, "repeat" | "clamp"])[]) {
    const builtin = images.find(name);
    if (builtin === undefined) throw new Error(`Missing built-in ${name}`);
    expect([builtin.image.sourceWidth, builtin.image.sourceHeight, builtin.mipmap, builtin.allowPicmip, builtin.wrap]).toEqual([width, height, mipmap, false, wrap]);
    expect(images.forImage(builtin.image)).toBe(builtin);
  }
  expect(images.find("*white")?.image).not.toBe(images.find("*identityLight")?.image);
  const identity = images.find("*identityLight"); if (identity === undefined) throw new Error("Missing identity-light image");
  expect(f.recorder.creation(identity.image).levels[0].copyPixels().every(value => value === 255)).toBe(true);
  const dlight = images.find("*dlight")?.image;
  if (dlight === undefined) throw new Error("Missing source dlight");
  expect([...f.recorder.creation(dlight).levels[0].copyPixels().slice(0, 4)]).toEqual([0, 0, 0, 255]);
  expect([...f.recorder.creation(dlight).levels[0].copyPixels().slice((7 * 16 + 7) * 4, (7 * 16 + 7) * 4 + 4)]).toEqual([255, 255, 255, 255]);
  expect([...f.recorder.creation(dlight).levels[0].copyPixels().slice((4 * 16 + 4) * 4, (4 * 16 + 4) * 4 + 4)]).toEqual([163, 163, 163, 255]);
  expect(images.find("*fog")?.image).toBe(images.fogImage);
  // Native recorder + real GLX: /tmp/q3-fog-border-audit-SlxDgP/run.sh (54 + 82 checks).
  // R_CreateImage raw-unbinds; the final border operation targets object zero, not named fog.
  const defaultModes = f.gl === null ? 0 : f.gl.capabilities.textureUnits > 1 ? 2 : 1;
  expect(f.recorder.operations).toHaveLength(191 + defaultModes);
  for (const operation of f.recorder.operations.slice(0, defaultModes))
    expect(operation).toEqual({ kind: "texture-mode", filter: "linear-mipmap-nearest" });
  expect(f.recorder.operations[184 + defaultModes]).toEqual({ kind: "dlight-image", image: dlight });
  expect(f.recorder.operations.at(-1)).toEqual({ kind: "current-border-color", color: { x: 1, y: 1, z: 1, w: 1 } });
  expect(images.find("*WHITE")).toBeUndefined(); expect(images.find("*identitylight")).toBeUndefined(); f.close();
});

test("source cached built-ins retain names and wrap without converting named failures into success", async () => {
  const text = new TextEncoder().encode(`white-clamped { { clampmap *white rgbGen vertex } }
white-nomip { nomipmaps { clampmap *white rgbGen vertex } }
default-map { { map *default rgbGen vertex } }
identity-map { { map *identityLight rgbGen vertex } }
upper-white { { map *WHITE } }
lower-identity { { map *identitylight } }
dlight-repeat { { map *dlight } }
missing-map { { map absent/image } }
scratch-map { { map *scratch } }`);
  const reads: string[] = [];
  const f = await fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "scripts/builtins.shader" ? text.byteLength : -1,
    readFileOptional: async path => { if (path !== "scripts/builtins.shader") return undefined; reads.push(path); return text; },
    list: () => ["scripts/builtins.shader"], has: () => false,
    read: path => { reads.push(path); return Promise.resolve(text); } })), resources = f.resources;
  const white = await resources.registerShader("white-clamped"); expect(white).not.toBeNull();
  expect(f.recorder.creation(imageBinding(pictureBatch(f, white)).image).sampling.wrap).toBe("repeat");
  // ParseStage keeps depth testing and writes for both scripted registration APIs.
  expect(pictureBatch(f, white).state).toMatchObject({ depthTest: "less-equal", depthWrite: true });
  // R_FindShader adds .tga only on the implicit path; script tokens name the built-in directly.
  expect(await resources.registerShaderNoMip("*white")).toBeNull();
  const whiteNoMip = await resources.registerShaderNoMip("white-nomip"); expect(whiteNoMip).not.toBeNull();
  expect(imageBinding(pictureBatch(f, whiteNoMip)).image).toBe(imageBinding(pictureBatch(f, white)).image);
  expect(f.recorder.creation(imageBinding(pictureBatch(f, whiteNoMip)).image).sampling.wrap).toBe("repeat");
  expect(pictureBatch(f, whiteNoMip).state).toMatchObject({ depthTest: "less-equal", depthWrite: true });
  const identity = await resources.registerShader("identity-map"); expect(identity).not.toBeNull();
  expect(f.recorder.creation(imageBinding(pictureBatch(f, identity)).image).levels[0].copyPixels().every(value => value === 255)).toBe(true);
  const defaultMap = await resources.registerShader("default-map"); expect(defaultMap).not.toBeNull();
  expect(imageBinding(pictureBatch(f, defaultMap)).image).toBe(imageBinding(pictureBatch(f, null)).image);
  expect(pictureBatch(f, defaultMap).vertices[0]?.color).toEqual({ x: 63 / 255, y: 127 / 255, z: 191 / 255, w: 127 / 255 });
  expect(pictureBatch(f, null).vertices[0]?.color).toEqual({ x: 1, y: 1, z: 1, w: 1 });
  expect(await resources.registerShader("upper-white")).toBeNull();
  expect(await resources.registerShader("lower-identity")).toBeNull();
  expect(await resources.registerShader("missing-map")).toBeNull();
  expect(await resources.registerShader("absent/shader")).toBeNull();
  const dlight = await resources.registerShader("dlight-repeat"); expect(dlight).not.toBeNull();
  expect(f.recorder.creation(imageBinding(pictureBatch(f, dlight)).image).sampling.wrap).toBe("clamp");
  const scratch = await resources.registerShader("scratch-map"); expect(scratch).not.toBeNull();
  expect(imageBinding(pictureBatch(f, scratch)).image).toBe(f.builtins.scratchImage(31));
  expect(reads).toEqual(["scripts/builtins.shader"]); f.close();
});

test("named source fog keeps transparent GL_CLAMP border while the source journal colors object zero", async () => {
  const text = new TextEncoder().encode(`fog-map { { map *fog blendFunc blend } }
white-map { { map *white } }`);
  const f = await fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "scripts/fog-border.shader" ? text.byteLength : -1,
    readFileOptional: async path => path === "scripts/fog-border.shader" ? text : undefined,
    list: () => ["scripts/fog-border.shader"], has: () => false,
    read: path => path === "scripts/fog-border.shader" ? Promise.resolve(text) : Promise.reject(new Error(`Unexpected read ${path}`)) }));
  try {
    expect(await f.resources.registerShader("*fog")).toBeNull();
    const shader = await f.resources.registerShader("fog-map"); expect(shader).not.toBeNull();
    const white = await f.resources.registerShader("white-map"); expect(white).not.toBeNull();
    // Bind a different real image first; do not repair R_CreateImage's cached-bind/raw-unbind mismatch.
    pictureBatch(f, white);
    f.queue.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    const draw = f.queue.draw2D("pixels"); draw.setColor(null);
    draw.stretchPic({ x: 0, y: 0, width: 16, height: 16 }, { s: 0, t: 0, s2: 0, t2: 0 }, f.resources.picture(shader));
    f.queue.submit();
    expect([...f.cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)]).toEqual([0,0,0,255]);
    if (f.gl !== null) expect([...f.gl.readPixels()]).toEqual([...f.cpu.pixels]);
  } finally { f.close(); }
});

for (const product of products) {
  test(`${product} retail white shader resolves the source built-in image`, async () => {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product }), f = await fixture(assets), resources = f.resources;
    const shader = await resources.registerShader("white");
    expect(shader).not.toBeNull();
    const picture = pictureBatch(f, shader);
    const binding = imageBinding(picture);
    expect(binding.image.sourceWidth).toBe(8); expect(binding.image.sourceHeight).toBe(8);
    expect(f.recorder.creation(binding.image).levels[0].copyPixels().every(value => value === 255)).toBe(true);
    expect(picture.vertices[0]?.color).toEqual({ x: 63 / 255, y: 127 / 255, z: 191 / 255, w: 127 / 255 }); f.close();
  });
  test(`${product} retail CG_FillRect retains tint through actual CPU and GL drawing`, async () => {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product }), f = await fixture(assets), resources = f.resources;
    const soundDebugMessages: string[] = [];
    const media = new ClientMedia(product, new ClientGameStaticState(product), resources, new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => undefined }));
    media.graphics.whiteShader = await resources.registerShader("white");
    const tools = new ClientDrawTools(f.queue.draw2D("stretch-640"), media);
    tools.fillRect({ x: 0, y: 0, width: 640, height: 480 }, { x: 0.04, y: 0.06, z: 0.1, w: 1 });
    f.queue.submit();
    expect([...f.cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)]).toEqual([10, 15, 25, 255]);
    if (f.gl !== null) expect([...f.gl.readPixels()]).toEqual([...f.cpu.pixels]);
    f.close();
  });
}
