import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { UI_PICTURE_STATE } from "../src/render/draw2d.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { CoordinateSpace, PictureAsset } from "../src/render/draw2d.ts";
import type { DrawBatch, TextureBinding } from "../src/render/types.ts";
import { UiAssetRegistry, parseFontData, drawCgString, drawUiString, proportionalStringWidth, bannerStringWidth, drawProportionalString, drawBannerString, textWidth, textHeight, textPaint, textPaintWithCursor, textPaintLimit, UI_CENTER, UI_DROPSHADOW, UI_PULSE, UI_BLINK } from "../src/render/font.ts";
import type { FontSet, LegacyFonts, RegisteredFont } from "../src/render/font.ts";
import { drawCgProportionalString, drawCgBannerString, UI_INVERSE } from "../src/render/font.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererResources } from "../src/render/world.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

import { RenderTarget, RenderCommandBuffer, RendererCommandStorage } from "../src/render/commands.ts";
import type { SubmissionReceipt } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage, ImageResourceOperation, CreateImageOperation } from "../src/render/image-resource.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

const white = { x: 1, y: 1, z: 1, w: 1 };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
class ImageRecorder extends BatchRecordingBackend {
  readonly creations: CreateImageOperation[] = [];
  override applyImageResource(operation: ImageResourceOperation): undefined {
    super.applyImageResource(operation);
    if (operation.kind === "create-image") this.creations.push(operation.creation);
    return undefined;
  }
  creation(image: RendererImage): CreateImageOperation {
    const value = this.creations.find(creation => creation.image === image);
    if (value === undefined) throw new Error("Missing image creation"); return value;
  }
}
function pipeline(width: number, height: number, useGl: boolean) {
  const images = new RendererImageCatalog(), window = useGl ? SdlWindow.open({ title: "Consumed font draws", width, height, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), cpu = new SoftwareRenderer(width, height, images, gl === null ? 8 : gl.subpixelBits);
  const recorder = new ImageRecorder(cpu), target = new RenderTarget(images, gl === null ? [recorder] : [recorder, gl]);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => {
    images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
  });
  disposals.push(() => { target.close(); if (window !== null) window.close(); });
  return { images, gl, cpu, recorder, target };
}
function fontFixture(width: number, height: number, space: CoordinateSpace) {
  const p = pipeline(width, height, false), tess = new SourceTessState(), settings = createRendererSettings();
  const image = publishTexture(p.images, { name: "font-layout-white", width: 1, height: 1, pixels: new Uint8Array([255,255,255,255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(p.images, { name: "font-layout-registration-tail", width: 1, height: 1, pixels: new Uint8Array([0,0,0,0]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const commandStorage = new RendererCommandStorage(() => null, "isolated");
  const queue = new RenderCommandBuffer(p.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess, runtime: settings.runtime, commandStorage });
  const picture: PictureAsset = { kind: "image", name: "fixture", texture: { kind: "bind-image", image }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } };
  const legacy: LegacyFonts = { charset: picture, proportional: picture, glow: { ...picture, name: "glow" }, banner: picture };
  return { ...p, queue, commandStorage, picture, legacy, draw: queue.draw2D(space) };
}
test("base UI inverse text uses the QVM32 color and inverse constant", () => {
  const f = fontFixture(640, 480, "base-ui-640");
  drawProportionalString(f.draw, f.legacy, { x: 0, y: 0, text: "A", color: { x: 0.0007, y: 0.2, z: 0.3, w: 0.4 }, style: UI_INVERSE, time: 0 });
  const commands = f.commandStorage.memory().data();
  expect([4, 8, 12, 16].map(offset => commands.getFloat32(offset, true))).toEqual([
    0.000489999947603792, Math.fround(Math.fround(0.2) * Math.fround(0.7)), Math.fround(Math.fround(0.3) * Math.fround(0.7)), Math.fround(0.4),
  ]);
});
function imageBinding(batch: DrawBatch): Extract<TextureBinding, { readonly kind: "bind-image" }> {
  if (batch.texture.kind !== "bind-image") throw new Error("Expected image binding"); return batch.texture;
}
function observed(f: { readonly recorder: ImageRecorder }, receipt: SubmissionReceipt | null): readonly DrawBatch[] {
  if (receipt === null) throw new Error("Font frame-end command was not reserved");
  return receipt.batches === 0 ? [] : f.recorder.trace().flatMap(view => view.batches).slice(-receipt.batches);
}
test("cgame legacy text uses X scale vertically, resets invalid glyph advance, and keeps its inverse multiplier", () => {
  const f = fontFixture(1280, 480, "stretch-640"), { draw, legacy } = f;
  drawCgProportionalString(draw, legacy, { x: 10, y: 20, text: "A\x01B", color: white, style: UI_INVERSE, time: 0 }); f.queue.submit();
  expect(xy(f, 0)[0]).toBeCloseTo(20, 4); expect(xy(f, 0)[1]).toBeCloseTo(40, 4);
  expect(xy(f, 1)[0]).toBeCloseTo(68, 4);
  const vertices = batch(f).vertices, top = vertices[0], bottom = vertices[2];
  if (top === undefined || bottom === undefined) throw new Error("Missing cgame text quad");
  expect((top.position.y - bottom.position.y) * 240).toBeCloseTo(54, 4);
  expect(top.color).toEqual({ x: 204 / 255, y: 204 / 255, z: 204 / 255, w: 1 });
  const bannerFixture = fontFixture(1280, 480, "stretch-640"), banner = bannerFixture.draw;
  drawCgBannerString(banner, bannerFixture.legacy, { x: 10, y: 20, text: "A A", color: white, style: 0, time: 0 }); bannerFixture.queue.submit();
  expect(xy(bannerFixture, 1)[0]).toBeCloseTo(126, 4); expect(xy(bannerFixture, 0)[1]).toBeCloseTo(40, 4);
  const bannerTop = batch(bannerFixture).vertices[0], bannerBottom = batch(bannerFixture).vertices[2];
  if (bannerTop === undefined || bannerBottom === undefined) throw new Error("Missing cgame banner quad");
  expect((bannerTop.position.y - bannerBottom.position.y) * 240).toBeCloseTo(72, 4);
});
function batch(f: ReturnType<typeof fontFixture>, index = 0): DrawBatch { const value = f.recorder.trace().flatMap(view => view.batches)[index]; if (value === undefined) throw new Error("Missing batch"); return value; }
function xy(f: ReturnType<typeof fontFixture>, index: number): readonly [number, number] {
  const draw = f.draw, vertex = batch(f, index).vertices[0]; if (vertex === undefined) throw new Error("Missing vertex");
  return [(vertex.position.x + 1) * draw.width / 2, (1 - vertex.position.y) * draw.height / 2];
}
function fontBytes(): Uint8Array {
  const bytes = new Uint8Array(20548), view = new DataView(bytes.buffer);
  for (let i = 0; i < 255; i++) {
    const offset = i * 80;
    for (const [field, value] of [9, 10, 0, 8, i === 32 ? 3 : 7, 8, 9].entries()) view.setInt32(offset + field * 4, value, true);
    view.setFloat32(offset + 36, 0.5, true); view.setFloat32(offset + 40, 0.5, true);
    bytes.set(new TextEncoder().encode("atlas.tga"), offset + 48);
  }
  view.setFloat32(20480, 4, true); bytes.set(new TextEncoder().encode("saved-name"), 20484);
  return bytes;
}
function fixtureFont(picture: PictureAsset, xSkip: number, glyphScale: number): RegisteredFont {
  const data = parseFontData(fontBytes()); return { ...data, glyphScale, glyphs: data.glyphs.map(glyph => ({ ...glyph, xSkip, picture })) };
}
function fixtureFonts(picture: PictureAsset): FontSet { return { small: fixtureFont(picture, 7, 4), normal: fixtureFont(picture, 8, 3), big: fixtureFont(picture, 11, 2.4), profile: "ui", smallThreshold: 0.25, bigThreshold: 0.4 }; }
const startupImagePrints = ["WARNING: no shader files found\n", "trying projectionShadow.TGA...\n", "trying flareShader.TGA...\n", "trying sun.TGA...\n"];
async function registryFor(reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, width = 8, height = 1, useGl = process.env["QUAKE_GL_TEST"] === "1") {
  const p = pipeline(width, height, useGl), builtins = new BuiltinImages(p.images, identityImageUploadProfile), settings = createRendererSettings();
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: reader }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: p.gl === null ? 4096 : p.gl.maxTextureSize } });
  disposals.push(() => movies.closeAllVideos());
  const prints: string[] = [];
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: text => { prints.push(text); }, imageProfile: identityImageUploadProfile, target: p.target, images: p.images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: movies.shaderCinematics });
  const queue = new RenderCommandBuffer(p.target, { print: (text: string) => { prints.push(text); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  queue.setColor(null);
  return { ...p, builtins, resources, queue, prints, registry: new UiAssetRegistry(resources, text => { prints.push(text); }) };
}
function evaluatedPicture(f: Awaited<ReturnType<typeof registryFor>>, picture: PictureAsset | null | undefined): DrawBatch {
  if (picture === null || picture === undefined) throw new Error("Missing registered picture");
  const draw = f.queue.draw2D("pixels");
  draw.drawPic({ x: 0, y: 0, width: 8, height: 1 }, picture);
  const value = observed(f, f.queue.submitFrame())[0]; if (value === undefined) throw new Error("Missing consumed picture"); return value;
}
function atlasTga(alpha: boolean): Uint8Array {
  const height = alpha ? 4 : 1, tga = new Uint8Array(18 + 2 * height * 4);
  tga[2] = 2; tga[12] = 2; tga[14] = height; tga[16] = 32;
  // Upload32 scans all alpha bytes. The bottom-up file's first row selects RGBA8;
  // t=.5 and all flipped-UV probes still interpolate identical opaque rows.
  for (let row = alpha ? 1 : 0; row < height; row++) tga.set([0,0,255,255,0,255,0,255], 18 + row * 8);
  return tga;
}
async function edgeFontPicture(useGl: boolean, alpha: boolean) {
  const tga = atlasTga(alpha);
  const f = await registryFor(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "atlas.tga" ? tga.byteLength : path === "fonts/fontImage_12.dat" ? 20548 : -1,
    async readFileOptional(path) { return this.has(path) ? this.read(path) : undefined; },
    list: () => [], has: path => path === "atlas.tga" || path === "fonts/fontImage_12.dat", read: async path => path === "atlas.tga" ? tga : fontBytes() }), 8, 1, useGl);
  const font = await f.registry.registerFont("ignored.ttf", 12);
  if (font === null) throw new Error("Expected edge-test font registration");
  const picture = font.glyphs[65]?.picture;
  if (picture === undefined || picture === null) throw new Error("Missing edge-test font atlas");
  // Explicit source draw establishes a different cached image before the atlas edge probe.
  f.queue.draw2D("pixels").drawPic({ x: -8, y: -8, width: 1, height: 1 }, f.resources.picture(null)); f.queue.submitFrame();
  return { ...f, picture };
}
function queueEdges(f: Awaited<ReturnType<typeof registryFor>>, picture: PictureAsset): void {
  const draw = f.queue.draw2D("pixels");
  f.queue.addView({ viewport: { x: 0, y: 0, width: f.cpu.width, height: f.cpu.height }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
  draw.stretchPic({ x: 0, y: 0, width: 2, height: 1 }, { s: 0, t: .5, s2: 0, t2: .5 }, picture);
  draw.stretchPic({ x: 2, y: 0, width: 2, height: 1 }, { s: 1, t: .5, s2: 1, t2: .5 }, picture);
  draw.drawHandlePic({ x: 4, y: 0, width: -4, height: 1 }, picture);
}
function expectClampedEdges(pixels: Uint8Array, driverRounding = false, alphaBits = 8): void {
  const probes: readonly (readonly [number, readonly number[]])[] = [[0, [64, 0, 0, 191]], [8, [0, 64, 0, 191]], [16, [0, 143, 0, 207]], [28, [143, 0, 0, 207]]];
  for (const [offset, expected] of probes) {
    const actual = Array.from(pixels.subarray(offset, offset + 4));
    if (!driverRounding) expect(actual).toEqual([...expected]);
    else for (const [channel, value] of expected.entries()) {
      const measured = actual[channel]; if (measured === undefined) throw new Error("Missing edge pixel channel");
      // Fixed-function GL rounds intermediate filtering/blending bytes differently from CPU.
      const stored = channel === 3 && alphaBits === 0 ? 255 : value;
      expect(Math.abs(measured - stored)).toBeLessThanOrEqual(1);
    }
  }
}

test("font atlas no-mip registration includes transparent GL_CLAMP border in CPU edge and flipped-UV draws", async () => {
  const f = await edgeFontPicture(false, true); queueEdges(f, f.picture); f.queue.submitFrame(); expectClampedEdges(f.cpu.pixels);
});
test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("font atlas no-mip registration includes transparent GL_CLAMP border on actual OpenGL", async () => {
  const f = await edgeFontPicture(true, true); queueEdges(f, f.picture); f.queue.submitFrame();
  expectClampedEdges(f.cpu.pixels); if (f.gl === null) throw new Error("Missing requested GL"); expectClampedEdges(f.gl.readPixels(), true, f.gl.alphaBits);
});
test("opaque atlas registration selects source RGB8 and keeps alpha one at clamp borders", async () => {
  const f = await edgeFontPicture(process.env["QUAKE_GL_TEST"] === "1", false);
  queueEdges(f, f.picture); const batches = observed(f, f.queue.submitFrame());
  const rendered = batches[0]; if (rendered === undefined) throw new Error("Missing opaque atlas draw");
  expect(f.recorder.creation(imageBinding(rendered).image).internalFormat).toBe("rgb8");
  for (const [offset, expected] of [[0,[128,0,0,255]], [8,[0,128,0,255]], [16,[0,191,0,255]], [28,[191,0,0,255]]] satisfies readonly (readonly [number, readonly number[]])[]) {
    expect([...f.cpu.pixels.slice(offset, offset + 4)]).toEqual([...expected]);
    if (f.gl !== null) {
      const pixels = f.gl.readPixels();
      for (const [channel, value] of expected.entries()) {
        const actual = pixels[offset + channel]; if (actual === undefined) throw new Error("Missing opaque edge channel");
        // Same fixed-function filtering allowance as the adjacent RGBA probes; alpha is exact.
        expect(Math.abs(actual - value)).toBeLessThanOrEqual(channel === 3 ? 0 : 1);
      }
    }
  }
});

describe("prebuilt renderer fonts", () => {
  test("parses packed little-endian metrics and discards stale shader handles", () => {
    const bytes = fontBytes(); new DataView(bytes.buffer).setInt32(65 * 80 + 44, 0x12345678, true);
    const font = parseFontData(bytes, "fixture.dat");
    expect(font.glyphs.length).toBe(256); expect(font.name).toBe("saved-name"); expect(font.glyphScale).toBe(4);
    expect(font.glyphs[65]).toEqual({ height: 9, top: 10, bottom: 0, pitch: 8, xSkip: 7, imageWidth: 8, imageHeight: 9, s: 0, t: 0, s2: 0.5, t2: 0.5, shaderName: "atlas.tga" });
  });
  test("rejects truncation, trailing bytes and non-finite metrics, and accepts empty atlas names", () => {
    expect(() => parseFontData(fontBytes().subarray(1))).toThrow("20548"); expect(() => parseFontData(new Uint8Array(20549))).toThrow("20548");
    const bytes = fontBytes(), view = new DataView(bytes.buffer);
    view.setFloat32(28, NaN, true); expect(() => parseFontData(bytes)).toThrow("non-finite");
    view.setFloat32(28, 0, true); bytes.fill(0, 48, 80); expect(parseFontData(bytes).glyphs[0]?.shaderName).toBe("");
  });
  test("missing and wrong-size DATs print source no-FreeType diagnostics without writing a font", async () => {
    const { registry, prints } = await registryFor(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "fonts/fontImage_14.dat" ? 3 : -1,
      async readFileOptional(path) { if (path.startsWith("fonts/")) throw new Error("Font length must gate the content read"); return undefined; },
      list: () => [], has: path => path === "fonts/fontImage_14.dat",
      read: async path => { if (path !== "fonts/fontImage_14.dat") throw new Error("Must not read absent font"); return new Uint8Array(3); } }));
    expect(await registry.registerFont("fonts/custom.ttf", 12)).toBeNull();
    expect(await registry.registerFont("fonts/custom.ttf", 14)).toBeNull();
    expect(await registry.registerFont("fonts/custom.ttf", 12)).toBeNull();
    expect(prints).toEqual([...startupImagePrints, ...Array.from({ length: 3 }, () => "RE_RegisterFont: FreeType code not available\n")]);
  });
  test("registers decoded atlases once, deduplicates async loads and keys fonts by point size", async () => {
    const tga = new Uint8Array(22); tga[2] = 2; tga[12] = 1; tga[14] = 1; tga[16] = 32; tga.fill(255, 18);
    let reads = 0;
    const f = await registryFor(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength(path) { return this.has(path) ? path === "atlas.tga" ? tga.byteLength : 20548 : -1; },
      async readFileOptional(path) { return this.has(path) ? this.read(path) : undefined; },
      list: () => [], has: path => path === "atlas.tga" || /^fonts\/fontImage_[0-9]+\.dat$/.test(path), read: async path => { reads++; return path === "atlas.tga" ? tga : fontBytes(); } })), { registry } = f;
    const [first, second] = await Promise.all([registry.registerFont("one.ttf", 0), registry.registerFont("two.ttf", 12)]);
    if (first === null || second === null) throw new Error("Expected fixture font registrations");
    expect(first).toBe(second); expect(first.name).toBe("fonts/fontImage_12.dat"); expect(reads).toBe(2);
    expect(f.recorder.creation(imageBinding(evaluatedPicture(f, first.glyphs[65]?.picture)).image).levels[0].copyPixels()).toEqual(new Uint8Array([255, 255, 255, 255]));
    expect(first.glyphs[65]?.picture).toBe(first.glyphs[66]?.picture); expect(first.glyphs[255]?.picture).toBeNull();
    await Promise.all([13, 14, 15, 16, 17].map(size => registry.registerFont("ignored.ttf", size)));
    const completedReads = reads;
    expect(await registry.registerFont("cached-but-source-cap-first.ttf", 12)).toBeNull();
    expect(await registry.registerFont("seventh.ttf", 18)).toBeNull();
    expect(reads).toBe(completedReads);
    expect(f.prints).toEqual([...startupImagePrints, "RE_RegisterFont: Too many fonts registered already.\n", "RE_RegisterFont: Too many fonts registered already.\n"]);
  });
  test("UI and cgame share renderer slots and check capacity before a queued cache hit", async () => {
    const reads: string[] = [], cgamePrints: string[] = [];
    const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength(path) { return this.has(path) ? path === "atlas.tga" ? atlasTga(true).byteLength : 20548 : -1; },
      async readFileOptional(path) { return this.has(path) ? this.read(path) : undefined; },
      list: () => [], has: path => path === "atlas.tga" || /^fonts\/fontImage_[0-9]+\.dat$/.test(path),
      read: async path => { reads.push(path); return path === "atlas.tga" ? atlasTga(true) : fontBytes(); } });
    const f = await registryFor(reader), ui = f.registry;
    const cgame = new UiAssetRegistry(f.resources, text => { cgamePrints.push(text); });
    const first = await ui.registerFont("fonts/arial.ttf", -1);
    if (first === null) throw new Error("Expected first renderer font");
    expect(await cgame.registerFont("unread-different-name.ttf", 12.9)).toBe(first);
    expect(first.name).toBe("fonts/fontImage_12.dat");
    for (const size of [13, 14, 15, 16]) expect(await cgame.registerFont("ignored.ttf", size)).not.toBeNull();
    const [sixth, queuedCached, seventh] = await Promise.all([
      ui.registerFont("ignored.ttf", 17), cgame.registerFont("same-sixth.ttf", 17), cgame.registerFont("ignored.ttf", 18),
    ]);
    expect(sixth).not.toBeNull(); expect(queuedCached).toBeNull(); expect(seventh).toBeNull();
    expect(await ui.registerFont("first.ttf", 12)).toBeNull();
    expect(reads).toEqual(["fonts/fontImage_12.dat", "atlas.tga", ...[13, 14, 15, 16, 17].map(size => `fonts/fontImage_${size}.dat`)]);
    expect(cgamePrints).toEqual(Array.from({ length: 2 }, () => "RE_RegisterFont: Too many fonts registered already.\n"));
    expect(f.prints).toEqual([...startupImagePrints, "RE_RegisterFont: Too many fonts registered already.\n"]);
  });
  test("missing and wrong-size fonts leave slots available while admitted DAT values consume a slot", async () => {
    const malformed = fontBytes(); new DataView(malformed.buffer).setFloat32(28, NaN, true);
    const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength(path) { return this.has(path) ? path === "atlas.tga" ? atlasTga(true).byteLength : path === "fonts/fontImage_10.dat" ? 3 : 20548 : -1; },
      async readFileOptional(path) { return this.has(path) ? this.read(path) : undefined; },
      list: () => [], has: path => path !== "fonts/fontImage_9.dat" && (path === "atlas.tga" || /^fonts\/fontImage_[0-9]+\.dat$/.test(path)),
      read: async path => path === "atlas.tga" ? atlasTga(true) : path === "fonts/fontImage_10.dat" ? new Uint8Array(3) : path === "fonts/fontImage_11.dat" ? malformed : fontBytes() });
    const f = await registryFor(reader), cgame = new UiAssetRegistry(f.resources, text => { f.prints.push(text); });
    const outcomes = await Promise.allSettled([
      f.registry.registerFont("missing.ttf", 9), cgame.registerFont("wrong-size.ttf", 10), f.registry.registerFont("malformed.ttf", 11),
      ...[12, 13, 14, 15, 16, 17].map(size => cgame.registerFont("valid.ttf", size)),
    ]);
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status === "fulfilled") {
        if (index < 2 || index === 8) expect(outcome.value).toBeNull();
        else expect(outcome.value?.name).toBe(`fonts/fontImage_${index + 9}.dat`);
        if (index === 2) expect(outcome.value?.glyphs[0]?.s).toBeNaN();
      }
    }
    expect(f.prints).toEqual([...startupImagePrints, ...Array.from({ length: 2 }, () => "RE_RegisterFont: FreeType code not available\n"),
      "RE_RegisterFont: Too many fonts registered already.\n"]);
    expect(await cgame.registerFont("capacity.ttf", 18)).toBeNull();
  });
  test("font slots survive world loading and UI recreation, and reset with a replacement renderer", async () => {
    const map = renderBspFixture([{ shader: "", lightmap: -1 }, { shader: "", lightmap: -1 }], []);
    let fontReads = 0;
    const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength(path) { return this.has(path) ? path === "atlas.tga" ? atlasTga(true).byteLength : path === "maps/font-owner.bsp" ? map.byteLength : 20548 : -1; },
      async readFileOptional(path) { return this.has(path) ? this.read(path) : undefined; },
      list: () => [], has: path => path === "atlas.tga" || path === "maps/font-owner.bsp" || /^fonts\/fontImage_[0-9]+\.dat$/.test(path),
      read: async path => { if (path === "atlas.tga") return atlasTga(true); if (path === "maps/font-owner.bsp") return map; fontReads++; return fontBytes(); } });
    const f = await registryFor(reader), first = await f.registry.registerFont("first.ttf", 12);
    if (first === null) throw new Error("Expected renderer font before world load");
    await f.resources.loadWorld("font-owner");
    const recreatedUi = new UiAssetRegistry(f.resources, text => { f.prints.push(text); });
    expect(await recreatedUi.registerFont("recreated-ui.ttf", 12)).toBe(first); expect(fontReads).toBe(1);
    for (const size of [13, 14, 15, 16, 17]) expect(await recreatedUi.registerFont("fill.ttf", size)).not.toBeNull();
    expect(await recreatedUi.registerFont("full.ttf", 12)).toBeNull();
    // Both CL_FlushMemory and vid_restart shut down/reinitialize the renderer.
    // Keeping its SDL window does not retain its old RendererResources.
    const replacement = await registryFor(reader), reloaded = await replacement.registry.registerFont("fresh.ttf", 12);
    expect(replacement.resources.fonts).not.toBe(f.resources.fonts);
    if (reloaded === null) throw new Error("Expected first font in replacement renderer");
    expect(reloaded).not.toBe(first); expect(fontReads).toBe(7);
    expect(reloaded.glyphs[65]?.picture).not.toBe(first.glyphs[65]?.picture);
    expect(await f.registry.registerFont("retired-full.ttf", 12)).toBeNull();
    expect(replacement.prints).toEqual(startupImagePrints);
  });
  test("renderer-owned pictures preserve implicit mip flags and first registration of an exact image name", async () => {
    const tga = atlasTga(true);
    const script = new TextEncoder().encode(`
explicit/repeat
{
 nopicmip
 nomipmaps
 {
  map atlas.tga
  blendFunc blend
  rgbGen vertex
  alphaGen vertex
 }
}
explicit/clamp
{
 {
  clampmap atlas.tga
  blendFunc blend
  rgbGen vertex
  alphaGen vertex
 }
}
explicit/multistage
{
 { map atlas.tga }
 { map atlas.tga blendFunc add }
}
`);
    const imageReads: string[] = [];
    const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "scripts/pictures.shader" ? script.byteLength : path.endsWith(".tga") ? tga.byteLength : -1,
      async readFileOptional(path) { return this.has(path) ? this.read(path) : undefined; },
      list: (prefix = "") => ["scripts/pictures.shader"].filter(path => path.startsWith(prefix)), has: path => path.endsWith(".tga") || path === "scripts/pictures.shader", read: async path => {
      if (path === "scripts/pictures.shader") return script;
      if (path.endsWith(".tga")) { imageReads.push(path); return tga; }
      throw new Error(`Unexpected fixture asset ${path}`);
    } });
    const f = await registryFor(reader), { resources, registry } = f;
    const regular = await registry.registerPicture("implicit/regular", "mip"), noMip = await registry.registerPicture("implicit/noMip");
    expect(f.recorder.creation(imageBinding(evaluatedPicture(f, regular)).image).sampling.wrap).toBe("repeat"); expect(f.recorder.creation(imageBinding(evaluatedPicture(f, noMip)).image).sampling.wrap).toBe("clamp");
    expect(await registry.registerPicture("IMPLICIT/REGULAR.tga", "no-mip")).toBe(regular);
    expect(await registry.registerPicture("implicit/noMip.tga", "mip")).toBe(noMip);
    const repeat = await registry.registerPicture("explicit/repeat"), clamp = await registry.registerPicture("explicit/clamp", "mip");
    // R_FindImageFile compares the complete atlas.tga name with strcmp, warns on
    // mixed wrap requests, and returns the first image without changing its wrap.
    expect(f.recorder.creation(imageBinding(evaluatedPicture(f, repeat)).image).sampling.wrap).toBe("repeat"); expect(f.recorder.creation(imageBinding(evaluatedPicture(f, clamp)).image).sampling.wrap).toBe("repeat");
    expect(imageBinding(evaluatedPicture(f, repeat)).image).toBe(imageBinding(evaluatedPicture(f, clamp)).image);
    expect(imageReads).toEqual(["projectionShadow.tga", "flareShader.tga", "sun.tga", "implicit/regular.tga", "implicit/noMip.tga", "atlas.tga"]);
    expect(repeat).toBe(resources.picture(await resources.registerShaderNoMip("explicit/repeat")));
    const multistage = await registry.registerPicture("explicit/multistage");
    queueEdges(f, multistage); const stages = observed(f, f.queue.submitFrame());
    expect(stages).toHaveLength(2);
    expect(stages[0]?.state.blend).toEqual({ source: "one", destination: "zero" });
    expect(stages[1]?.state.blend).toEqual({ source: "one", destination: "one" });
    const firstStage = stages[0], secondStage = stages[1];
    if (firstStage === undefined || secondStage === undefined) throw new Error("Missing multistage picture batches");
    expect(imageBinding(firstStage).image).toBe(imageBinding(evaluatedPicture(f, repeat)).image);
    expect(imageBinding(secondStage).image).toBe(imageBinding(firstStage).image);
    const cpu = f.cpu;
    // Set up named-atlas sampling with a real different-image draw, not a cache repair.
    f.queue.draw2D("pixels").drawPic({ x: -8, y: -8, width: 1, height: 1 }, resources.picture(null)); f.queue.submitFrame();
    queueEdges(f, repeat); f.queue.submitFrame();
    expect(Array.from(cpu.pixels.subarray(0, 4))).toEqual([128, 128, 0, 255]);
    const inverse = await registryFor(reader), inverseRegistry = inverse.registry;
    const firstClamp = await inverseRegistry.registerPicture("explicit/clamp", "mip");
    const laterRepeat = await inverseRegistry.registerPicture("explicit/repeat");
    const clampBatch = evaluatedPicture(inverse, firstClamp), repeatBatch = evaluatedPicture(inverse, laterRepeat);
    expect(inverse.recorder.creation(imageBinding(clampBatch).image).sampling.wrap).toBe("clamp"); expect(inverse.recorder.creation(imageBinding(repeatBatch).image).sampling.wrap).toBe("clamp");
    expect(imageBinding(repeatBatch).image).toBe(imageBinding(clampBatch).image);
    expect(imageBinding(clampBatch).image).not.toBe(imageBinding(evaluatedPicture(f, repeat)).image);
    expect(imageReads).toEqual(["projectionShadow.tga", "flareShader.tga", "sun.tga", "implicit/regular.tga", "implicit/noMip.tga", "atlas.tga", "projectionShadow.tga", "flareShader.tga", "sun.tga", "atlas.tga"]);
    inverse.queue.draw2D("pixels").drawPic({ x: -8, y: -8, width: 1, height: 1 }, inverse.resources.picture(null)); inverse.queue.submitFrame();
    queueEdges(inverse, laterRepeat); inverse.queue.submitFrame();
    expect(Array.from(inverse.cpu.pixels.subarray(0, 2))).toEqual([64, 0]);
  });
});

describe("source text layout and colors", () => {
  test("CG limits count visible chars; escapes preserve alpha and shadow stays black", () => {
    const f = fontFixture(640, 480, "stretch-640"), { draw, picture } = f;
    drawCgString(draw, picture, { x: 10, y: 20, text: "A^1B C", color: { ...white, w: 0.5 }, charWidth: 8, charHeight: 16, maxChars: 2, forceColor: false, shadow: true }); f.queue.submit();
    expect(f.recorder.trace().flatMap(view => view.batches).length).toBe(4); expect(xy(f, 0)[0]).toBeCloseTo(12); expect(xy(f, 1)[0]).toBeCloseTo(20);
    expect(batch(f, 1).vertices[0]?.color).toEqual({ x: 0, y: 0, z: 0, w: 127 / 255 });
    expect(batch(f, 3).vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 127 / 255 });
  });
  test("base UI alignment counts escape bytes and its shadow interprets escapes", () => {
    const f = fontFixture(640, 480, "base-ui-640"), { draw, picture } = f;
    drawUiString(draw, picture, { x: 100, y: 20, text: "A^1B", color: white, style: UI_CENTER | UI_DROPSHADOW, time: 0 }); f.queue.submit();
    expect(f.recorder.trace().flatMap(view => view.batches).length).toBe(4); expect(xy(f, 2)[0]).toBeCloseTo(68);
    expect(batch(f, 1).vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 1 });
  });
  test("caret escaping follows Q_IsColorString, including non-digit color indices", () => {
    const f = fontFixture(640, 480, "pixels"), { draw, picture } = f;
    drawUiString(draw, picture, { x: 0, y: 0, text: "^^A^9B", color: white, style: 0, time: 0 }); f.queue.submit();
    expect(f.recorder.trace().flatMap(view => view.batches).length).toBe(2); expect(batch(f, 1).vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 1 });
  });
  test("blink and negative-y fixed text do not issue commands", () => {
    const f = fontFixture(640, 480, "pixels"), { draw, picture } = f;
    drawUiString(draw, picture, { x: 0, y: 0, text: "A", color: white, style: UI_BLINK, time: 200 }); f.queue.submit();
    drawUiString(draw, picture, { x: 0, y: -17, text: "A", color: white, style: 0, time: 0 }); f.queue.submit(); expect(observed(f, f.queue.submit())).toEqual([]);
  });
  test("proportional metrics retain unsupported-character drawing advance", () => {
    expect(proportionalStringWidth("")).toBe(-3); expect(proportionalStringWidth("Aa I")).toBe(61);
    expect(proportionalStringWidth("A\x01B")).toBe(39);
    const f = fontFixture(640, 480, "base-ui-640"), { draw, legacy } = f;
    drawProportionalString(draw, legacy, { x: 0, y: 0, text: "A\x01B", color: white, style: 0, time: 0 }); f.queue.submit();
    expect(xy(f, 1)[0]).toBeCloseTo(42); expect(batch(f).vertices[0]?.texCoord).toEqual({ x: 5 / 256, y: 4 / 256 });
  });
  test("banner width excludes space gaps that are present when drawing", () => {
    expect(bannerStringWidth("")).toBe(-4); expect(bannerStringWidth("A A")).toBe(82);
    const f = fontFixture(640, 480, "base-ui-640"), { draw, legacy } = f;
    drawBannerString(draw, legacy, { x: 0, y: 0, text: "A A", color: white, style: 0, time: 0 }); f.queue.submit();
    expect(xy(f, 1)[0]).toBeCloseTo(53);
  });
  test("proportional pulse glow alpha is independent of original alpha", () => {
    const f = fontFixture(640, 480, "base-ui-640"), { draw, legacy } = f;
    drawProportionalString(draw, legacy, { x: 0, y: 0, text: "A", color: { ...white, w: 0.2 }, style: UI_PULSE, time: 0 }); f.queue.submit();
    expect(batch(f).vertices[0]?.color.w).toBe(51 / 255); expect(batch(f, 1).vertices[0]?.color.w).toBe(127 / 255);
    const laterFixture = fontFixture(640, 480, "base-ui-640"), later = laterFixture.draw;
    drawProportionalString(later, laterFixture.legacy, { x: 0, y: 0, text: "A", color: white, style: UI_PULSE, time: 74 }); laterFixture.queue.submit();
    expect(batch(laterFixture, 1).vertices[0]?.color.w).toBe(127 / 255);
  });
  test("modern metrics use source float32 thresholds and truncate scaled output", () => {
    const f = fontFixture(640, 480, "pixels"), fonts = fixtureFonts(f.picture);
    expect(textWidth(fonts, "A^1A", 0.25)).toBe(14); expect(textWidth(fonts, "AAA", 0.25, 2)).toBe(14);
    expect(textWidth(fonts, "A", 0.4)).toBe(10); expect(textWidth({ ...fonts, profile: "cgame" }, "A", 0.4)).toBe(9);
    expect(textHeight(fonts, "A", 0.25)).toBe(9);
  });
  test("modern glyphs align to baseline and use per-glyph virtual shadows", () => {
    const f = fontFixture(1280, 960, "team-ui-640"), { draw, picture } = f;
    textPaint(draw, fixtureFonts(picture), { x: 10, y: 30, scale: 0.25, text: "A^2B", color: { ...white, w: 0.5 }, adjust: 1, limit: 0, style: 6 }); f.queue.submit();
    expect(f.recorder.trace().flatMap(view => view.batches).length).toBe(4); expect(xy(f, 0)[0]).toBeCloseTo(24); expect(xy(f, 0)[1]).toBeCloseTo(44);
    expect(xy(f, 3)[0]).toBeCloseTo(36); expect(batch(f, 3).vertices[0]?.color).toEqual({ x: 0, y: 1, z: 0, w: 127 / 255 });
    draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, picture); f.queue.submit(); expect(batch(f, 4).vertices[0]?.color).toEqual(white);
  });
  test("8-bit string boundary rejects unsupported Unicode and respects NUL", () => {
    expect(() => proportionalStringWidth("λ")).toThrow("8-bit"); expect(proportionalStringWidth("A\0B")).toBe(18);
  });
  test("cursor blinks and preserves the source raw-length end-position comparison", () => {
    const options = { x: 0, y: 20, scale: 0.25, text: "A^1B", color: white, limit: 0, style: 0 };
    const endFixture = fontFixture(640, 480, "pixels"), end = endFixture.draw;
    textPaintWithCursor(end, fixtureFonts(endFixture.picture), options, { position: 2, character: 95, time: 0 }); endFixture.queue.submit(); expect(endFixture.recorder.trace().flatMap(view => view.batches).length).toBe(2);
    const rawEndFixture = fontFixture(640, 480, "pixels"), rawEnd = rawEndFixture.draw;
    textPaintWithCursor(rawEnd, fixtureFonts(rawEndFixture.picture), options, { position: 4, character: 95, time: 0 }); rawEndFixture.queue.submit(); expect(rawEndFixture.recorder.trace().flatMap(view => view.batches).length).toBe(3); expect(xy(rawEndFixture, 2)[0]).toBeCloseTo(14);
    const blinkFixture = fontFixture(640, 480, "pixels"), blink = blinkFixture.draw;
    textPaintWithCursor(blink, fixtureFonts(blinkFixture.picture), options, { position: 0, character: 95, time: 200 }); blinkFixture.queue.submit(); expect(blinkFixture.recorder.trace().flatMap(view => view.batches).length).toBe(2);
  });
  test("limited text repeats font scaling in the source overflow test", () => {
    const options = { x: 0, y: 20, scale: 0.25, text: "A", color: white, limit: 0, adjust: 0 };
    const clippedFixture = fontFixture(640, 480, "pixels"), clipped = clippedFixture.draw;
    // Actual advance is 7, but Text_Width(useScale=1) selects the big font and returns 26.
    expect(textPaintLimit(clipped, fixtureFonts(clippedFixture.picture), options, 25)).toBe(0); expect(observed(clippedFixture, clippedFixture.queue.submit()).length).toBe(0);
    const fitsFixture = fontFixture(640, 480, "pixels"), fits = fitsFixture.draw; expect(textPaintLimit(fits, fixtureFonts(fitsFixture.picture), options, 26)).toBe(7); expect(observed(fitsFixture, fitsFixture.queue.submit()).length).toBe(1);
  });
});

const dataPath = process.env["Q3_DATA"];
describe.skipIf(dataPath === undefined)("retail UI font assets", () => {
  test("loads shipped point sizes and renders the same UI batches on CPU and OpenGL", async () => {
    if (dataPath === undefined) throw new Error("Missing Q3_DATA");
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" }), f = await registryFor(vfs, 640, 480), resources = f.resources, assets = f.registry;
    const legacyFonts = await assets.loadLegacyFonts();
    const small = await assets.registerFont("fonts/arial.ttf", 12), normal = await assets.registerFont("fonts/arial.ttf", 16), big = await assets.registerFont("fonts/arial.ttf", 20);
    if (small === null || normal === null || big === null) throw new Error("Expected shipped font registration");
    expect(f.recorder.creation(imageBinding(evaluatedPicture(f, legacyFonts.charset)).image).sampling.wrap).toBe("repeat");
    for (const picture of [legacyFonts.proportional, legacyFonts.glow, legacyFonts.banner, small.glyphs[65]?.picture, normal.glyphs[65]?.picture, big.glyphs[65]?.picture]) {
      expect(f.recorder.creation(imageBinding(evaluatedPicture(f, picture)).image).sampling.wrap).toBe("clamp");
    }
    expect(small.glyphScale).toBe(4); expect(normal.glyphScale).toBe(3); expect(big.glyphScale).toBe(Math.fround(2.4));
    expect(small.glyphs[65]?.xSkip).toBe(7); expect(normal.glyphs[65]?.xSkip).toBe(8); expect(big.glyphs[65]?.xSkip).toBe(11);
    expect(small.glyphs[255]?.picture).toBeNull(); expect(await assets.registerFont("different-name.ttf", 12)).toBe(small);
    const draw = f.queue.draw2D("team-ui-640");
    draw.fillRect({ x: 0, y: 0, width: 640, height: 480 }, { x: 0.05, y: 0.08, z: 0.12, w: 1 }, resources.picture(await resources.registerShaderNoMip("white")));
    drawUiString(draw, legacyFonts.charset, { x: 24, y: 24, text: "QUAKE ^1III ^7ARENA", color: white, style: UI_DROPSHADOW, time: 0 });
    drawProportionalString(draw, legacyFonts, { x: 24, y: 70, text: "MULTIPLAYER", color: { x: 1, y: 0.8, z: 0.2, w: 1 }, style: UI_DROPSHADOW, time: 0 });
    drawBannerString(draw, legacyFonts, { x: 24, y: 125, text: "TEAM ARENA", color: white, style: UI_DROPSHADOW, time: 0 });
    const fonts: FontSet = { small, normal, big, profile: "ui", smallThreshold: 0.25, bigThreshold: 0.4 };
    for (const [index, scale] of [0.25, 0.3, 0.4].entries()) textPaint(draw, fonts, { x: 24, y: 210 + index * 55, scale, color: white, text: "Capture ^1the ^4Flag ^7 0123456789", adjust: 0, limit: 0, style: 3 });
    f.queue.submitFrame(); const cpu = f.cpu, uiPixels = cpu.pixels.slice(), uiGlPixels = f.gl === null ? null : f.gl.readPixels();
    expect(new Set(cpu.pixels).size).toBeGreaterThan(200);
    const atlas = small.glyphs[65]?.picture;
    if (atlas === undefined || atlas === null) throw new Error("Missing retail font atlas");
    const atlasTexture = imageBinding(evaluatedPicture(f, atlas)).image;
    expect(Array.from(f.recorder.creation(atlasTexture).levels[0].copyPixels().subarray(85 * 256 * 4, 85 * 256 * 4 + 4))).toEqual([255, 255, 255, 255]);
    const edge = f.queue.draw2D("pixels");
    f.queue.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    edge.stretchPic({ x: 0, y: 0, width: 8, height: 1 }, { s: 0, t: 85.5 / 256, s2: 0, t2: 85.5 / 256 }, atlas);
    f.queue.submitFrame();
    expect(Array.from(cpu.pixels.subarray(0, 4))).toEqual([64, 64, 64, 191]);
    if (f.gl !== null && uiGlPixels !== null) {
      let totalError = 0, bad = 0;
      for (const [i, value] of uiGlPixels.entries()) {
        const expected = i % 4 === 3 && f.gl.alphaBits === 0 ? 255 : uiPixels[i];
        if (expected === undefined) throw new Error("Missing CPU pixel");
        const error = Math.abs(value - expected); totalError += error; if (error > 3) bad++;
      }
      expect(totalError / uiGlPixels.length).toBeLessThan(.25); expect(bad / uiGlPixels.length).toBeLessThan(.002);
      const output = process.env["QUAKE_UI_CAPTURE"];
      if (output !== undefined) { await Bun.write(`${output}.cpu.rgba`, uiPixels); await Bun.write(`${output}.gl.rgba`, uiGlPixels); }
      const edgePixels = f.gl.readPixels();
      for (const [channel, expected] of [64,64,64,191].entries()) {
        const actual = edgePixels[channel]; if (actual === undefined) throw new Error("Missing retail edge pixel");
        const stored = channel === 3 && f.gl.alphaBits === 0 ? 255 : expected;
        expect(Math.abs(actual - stored)).toBeLessThanOrEqual(1);
      }
    }
  });
});
