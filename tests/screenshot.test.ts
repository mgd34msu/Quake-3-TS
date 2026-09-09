// Source screenshot behavior, id Software tr_init.c and cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { decodeTga } from "../src/assets/tga.ts";
import { decodeJpeg } from "../src/assets/jpeg.ts";
import type { WritableBinaryFile } from "../src/assets/writable-files.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { ClientHost } from "../src/engine/client-host.ts";
import { aviFrameMilliseconds, EngineScreenshots } from "../src/engine/screenshots.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RenderCommandBuffer, RendererCommandStorage, RenderTarget } from "../src/render/commands.ts";
import { SOURCE_COMMAND_RELEASE32 } from "../src/render/command-memory.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import type { ConfiguredRenderer } from "../src/render/configuration.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createImageColorMappings } from "../src/render/image-upload.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import type { PictureAsset } from "../src/render/picture-material.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { levelshotTga, screenshotTga, ScreenshotCommand, ScreenshotFilename } from "../src/render/screenshot.ts";
import type { ScreenshotFormat } from "../src/render/screenshot.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { publishTexture } from "./render-target-fixture.ts";

function unexpectedJpegWarning(text: string): undefined {
  throw new Error(`Unexpected JPEG warning: ${text}`);
}

const mappings = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
  deviceSupportsGamma: false, isFullscreen: false, colorBits: 32 });

test("TGA header, BGR order, orientation, source gamma gate and row-packing boundary", () => {
  const rgba = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
    170, 180, 190, 200, 210, 220, 230, 240, 1, 2, 3, 4, 5, 6, 7, 8]);
  const encoded = screenshotTga(4, 2, rgba, mappings);
  expect(Array.from(encoded.subarray(0, 18))).toEqual([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 2, 0, 24, 0]);
  expect(Array.from(encoded.subarray(18, 24))).toEqual([190, 180, 170, 230, 220, 210]);
  const decoded = decodeTga(encoded);
  expect(decoded.pixels).toEqual(rgba.map((value, index) => index % 4 === 3 ? 255 : value));
  const gamma = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 1,
    deviceSupportsGamma: true, isFullscreen: true, colorBits: 32 });
  expect(Array.from(screenshotTga(4, 2, rgba, gamma).subarray(18, 24))).toEqual([255, 255, 255, 255, 255, 255]);
  expect(screenshotTga(4, 2, rgba, { ...gamma, deviceSupportsGamma: false })).toEqual(encoded);
  expect(screenshotTga(4, 2, rgba, { ...gamma, overbrightBits: 0 })).toEqual(encoded);
  expect(screenshotTga(1, 1, rgba.subarray(0, 4), mappings).subarray(18)).toEqual(new Uint8Array([30, 20, 10]));
  expect(() => screenshotTga(3, 2, new Uint8Array(24), mappings)).toThrow("row packing");
  expect(() => screenshotTga(4, 2, new Uint8Array(31), mappings)).toThrow("complete top-left RGBA");
});

test("levelshot averages each 4 by 3 source block before truncation and gamma", () => {
  const rgba = new Uint8Array(512 * 384 * 4);
  for (let y = 0; y < 384; y++) for (let x = 0; x < 512; x++) {
    const offset = (y * 512 + x) * 4;
    rgba[offset] = x % 256; rgba[offset + 1] = y % 256; rgba[offset + 2] = 17; rgba[offset + 3] = 255;
  }
  const encoded = levelshotTga(512, 384, rgba, mappings);
  expect(encoded.length).toBe(18 + 128 * 128 * 3);
  expect(Array.from(encoded.subarray(18, 24))).toEqual([17, 126, 1, 17, 126, 5]);
  expect(Array.from(decodeTga(encoded).pixels.subarray(0, 8))).toEqual([1, 1, 17, 255, 5, 1, 17, 255]);
  const gamma = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 1,
    deviceSupportsGamma: true, isFullscreen: true, colorBits: 32 });
  expect(Array.from(levelshotTga(512, 384, rgba, gamma).subarray(18, 21))).toEqual([34, 252, 2]);
});

test("AVI milliseconds use integer division first, float32 timescale, int truncation and zero minimum", () => {
  expect(aviFrameMilliseconds(30, 1)).toBe(33);
  expect(aviFrameMilliseconds(60, 1.5)).toBe(24);
  expect(aviFrameMilliseconds(30, 0.5)).toBe(16);
  expect(aviFrameMilliseconds(2000, 3)).toBe(1);
  expect(aviFrameMilliseconds(30, 0)).toBe(1);
  expect(aviFrameMilliseconds(-30, 1)).toBe(-33);
  expect(() => aviFrameMilliseconds(1, Number.POSITIVE_INFINITY)).toThrow("native CL_Frame");
});

test("startup screenshot storage retains zero dimensions, source temp bytes and filenames after a dropped command", () => {
  for (const format of ["tga", "jpeg"] satisfies readonly ScreenshotFormat[]) {
    const root = mkdtempSync(join(tmpdir(), "quake3-startup-screenshot-"));
    const files = new WritableFileSystem({ homePath: root, product: "baseq3", print: () => undefined });
    const accounting = new SourceHunkAccounting(new HunkArena(4 * 1024 * 1024, () => {}));
    const backend = accounting.initializeRendererBackend({ maxPolys: 600, maxPolyVertices: 3000 });
    const storage = new RendererCommandStorage(() => backend, "source");
    const owner = new EngineScreenshots({ kind: "source-hunk", accounting });
    let currentRenderer: ConfiguredRenderer | null = null;
    let currentSettings: SourceRendererSettings | null = null;
    let width = 0, height = 0;
    const graphics = {
      commands: storage, worldBaseName: null,
      get width() { return width; }, get height() { return height; },
      get renderer(): ConfiguredRenderer {
        if (currentRenderer === null) throw new Error("Screenshot backend has not started");
        return currentRenderer;
      },
      configuration: { imageUploadProfile() {
        if (currentSettings === null) throw new Error("Screenshot color mappings have not started");
        return { ...currentSettings.imageUploadSettings(), colorMappings: mappings, textureCompression: "none", maxTextureSize: null } satisfies ReturnType<RendererConfiguration["imageUploadProfile"]>;
      } },
    };
    const console = new CommandBuffer(), output: string[] = [];
    console.register("capture", context => owner.command(context, graphics, files, text => { output.push(text); }, format));
    console.executeNow("capture startup");
    const commandMemory = storage.memory();
    expect(commandMemory.used).toBe(28);
    expect(commandMemory.data().getInt32(12, true)).toBe(0);
    expect(commandMemory.data().getInt32(16, true)).toBe(0);
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images);
    currentRenderer = { kind: "cpu", backend: cpu }; width = 16; height = 16;
    currentSettings = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), "linux"), cpu.capabilities);
    const target = new RenderTarget(images, [cpu]), tess = new SourceTessState();
    tess.frontEndMemory = backend;
    const commands = new RenderCommandBuffer(target, { commandStorage: storage, tess, runtime: currentSettings.runtime,
      clock: { milliseconds: () => 0 }, identityLight: 1, print: () => undefined });
    try {
      const extension = format === "tga" ? "tga" : "jpg";
      expect(files.fileExists(`screenshots/startup.${extension}`)).toBe(false);
      expect(commandMemory.reserve(SOURCE_COMMAND_RELEASE32.capacity - 4 - commandMemory.used)).toBe(28);
      console.executeNow("capture dropped");
      expect(output).toEqual([`Wrote screenshots/startup.${extension}\n`, `Wrote screenshots/dropped.${extension}\n`]);
      const anchor = accounting.allocateTemp("fixture", "active temp bank", 4);
      const retained = accounting.allocateTemp("fixture", "retained RGBA", 16 * 16 * 4);
      for (let offset = 0; offset < retained.bytes.length; offset += 4) retained.bytes.set([255, 0, 0, 255], offset);
      accounting.freeTemp("fixture", "retained RGBA", retained);
      commands.submit();
      accounting.freeTemp("fixture", "active temp bank", anchor);
      expect(files.fileExists(`screenshots/dropped.${extension}`)).toBe(false);
      const encoded = readFileSync(join(files.rootPath, `screenshots/startup.${extension}`));
      if (format === "tga") {
        expect(Array.from(encoded)).toEqual([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 0]);
      } else {
        const decoded = decodeJpeg(encoded, "screenshots/startup.jpg", unexpectedJpegWarning);
        expect([decoded.width, decoded.height]).toEqual([16, 16]);
        expect(Array.from(decoded.pixels.subarray(0, 3))).toEqual([254, 0, 0]);
      }
      for (let offset = 0; offset < cpu.pixels.length; offset += 4) cpu.pixels.set([0, 0, 255, 255], offset);
      console.executeNow("capture running");
      commands.submit();
      const running = readFileSync(join(files.rootPath, `screenshots/running.${extension}`));
      const decoded = format === "tga" ? decodeTga(running) : decodeJpeg(running, "screenshots/running.jpg", unexpectedJpegWarning);
      expect([decoded.width, decoded.height]).toEqual([16, 16]);
      expect(Array.from(decoded.pixels.subarray(0, 3))).toEqual(format === "tga" ? [0, 0, 255] : [0, 0, 254]);
    } finally { commands.close("discard"); target.close(); files.closeAll(); rmSync(root, { recursive: true }); }
  }
});

async function graphics(kind: "cpu" | "gl", owner: EngineScreenshots, files: WritableFileSystem, output: string[], width = 16, height = 16) {
  const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux", null, () => undefined);
  const window = SdlWindow.open({ title: "Source screenshot", width, height, backend: kind, hidden: true });
  const images = new RendererImageCatalog();
  const renderer: ConfiguredRenderer = kind === "cpu" ? { kind, backend: new SoftwareRenderer(width, height, images) } : { kind, backend: new GlRenderer(window, images) };
  const target = new RenderTarget(images, [renderer.backend]), settings = new SourceRendererSettings(registered, renderer.backend.capabilities);
  const configuration = RendererConfiguration.create({ window, renderer, settings });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { output.push(text); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: new SourceTessState(), runtime: settings.runtime });
  const texture = publishTexture(images, { name: "screenshot-white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const definition = parseShaderScript("screenshot-pic { { map $whiteimage rgbGen vertex } }")[0];
  if (definition === undefined) throw new Error("Missing screenshot material");
  const finished = finishShader({ definition, lightmapIndex: -4, profile: settings.registrationProfile(), images: [{ kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image: texture } } } }] });
  const material = await new MaterialRegistry(async () => ({ definition, image: texture, whiteImage: texture, finished, defaulted: false, sky: null }), text => { throw new Error(text); }).register("screenshot-pic", { kind: "picture" });
  const picture: PictureAsset = { kind: "material", name: "screenshot-pic", material };
  const console = new CommandBuffer(), state: { worldBaseName: string | null } = { worldBaseName: "fixture" };
  console.register("screenshot", context => owner.command(context, { commands, renderer, configuration, width, height, worldBaseName: state.worldBaseName }, files,
    text => { output.push(text); }));
  console.register("screenshotJPEG", context => owner.command(context, { commands, renderer, configuration, width, height, worldBaseName: state.worldBaseName }, files,
    text => { output.push(text); }, "jpeg"));
  const clear = (red: number, green: number): void => commands.addView({ viewport: { x: 0, y: 0, width, height },
    clear: { stencil: false, color: { x: red, y: green, z: 0, w: 1 }, depth: 1 }, operations: [] });
  return { commands, console, renderer, configuration, clear, picture, draw: commands.draw2D("pixels"), state,
    close: (): void => { commands.close("discard"); configuration.close(); target.close(); window.close(); } };
}

for (const kind of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  test.skipIf(kind === "gl" && process.env["QUAKE_GL_TEST"] !== "1")(`${kind} framebuffer to real file preserves command ordering, immediate levelshots and shared filenames`, async () => {
    const files = new WritableFileSystem({ homePath: mkdtempSync(join(tmpdir(), "quake3-screenshot-")), product: "baseq3", print: () => undefined });
    const owner = new EngineScreenshots(), output: string[] = [], f = await graphics(kind, owner, files, output);
    const read = (name: string) => decodeTga(readFileSync(join(files.rootPath, name))).pixels;
    try {
      f.state.worldBaseName = null;
      expect(() => f.console.executeNow("screenshot levelshot")).toThrow("requires a loaded renderer world");
      f.state.worldBaseName = "fixture";
      f.clear(1, 0); f.console.executeNow("screenshot first"); f.clear(0, 1); f.commands.submit();
      expect(Array.from(read("screenshots/first.tga").subarray(0, 4))).toEqual([255, 0, 0, 255]);
      f.clear(1, 0); f.console.executeNow("screenshot levelshot ignored");
      expect(Array.from(read("levelshots/fixture.tga").subarray(0, 4))).toEqual([0, 255, 0, 255]);
      f.commands.submit();
      f.draw.fillRect({ x: 0, y: 0, width: 16, height: 16 }, { x: 0, y: 1, z: 0, w: 1 }, f.picture);
      f.console.executeNow("screenshot unflushed"); f.commands.submit();
      expect(Array.from(read("screenshots/unflushed.tga").subarray(0, 4))).toEqual([255, 0, 0, 255]);
      f.console.executeNow("screenshot drawn"); f.commands.submit();
      expect(Array.from(read("screenshots/drawn.tga").subarray(0, 4))).toEqual([0, 255, 0, 255]);
      f.console.executeNow("screenshot alias-first"); f.console.executeNow("screenshot alias-last"); f.commands.submit();
      expect(existsSync(join(files.rootPath, "screenshots/alias-first.tga"))).toBe(false);
      expect(existsSync(join(files.rootPath, "screenshots/alias-last.tga"))).toBe(true);
      f.console.executeNow("screenshot shot0000"); f.commands.submit(); output.length = 0;
      f.console.executeNow("screenshot silent"); f.commands.submit();
      expect(output).toEqual([]); expect(existsSync(join(files.rootPath, "screenshots/shot0001.tga"))).toBe(true);
      f.console.executeNow("screenshot not-explicit extra"); f.commands.submit();
      expect(output).toEqual(["Wrote screenshots/shot0002.tga\n"]);
      f.console.executeNow("screenshot discarded");
    } finally { f.close(); }
    expect(existsSync(join(files.rootPath, "screenshots/discarded.tga"))).toBe(false);
    files.setGameDirectory("missionpack");
    const restarted = await graphics(kind, owner, files, output);
    try {
      restarted.clear(0, 1); restarted.console.executeNow("screenshot silent"); restarted.commands.submit();
      expect(existsSync(join(files.rootPath, "screenshots/shot0003.tga"))).toBe(true);
    } finally { restarted.close(); files.closeAll(); }
  });
}

function recordFileWrites(files: WritableFileSystem) {
  const writes: { readonly path: string; readonly bytes: Uint8Array }[] = [], events: string[] = [];
  const open = files.openBinaryWrite.bind(files);
  const spy = spyOn(files, "openBinaryWrite").mockImplementation(path => {
    events.push("open"); const file = open(path);
    if (file === null) return null;
    return {
      writeBytes(bytes) { events.push("write"); writes.push({ path, bytes: bytes.slice() }); return file.writeBytes(bytes); },
      seek(offset, origin) { return file.seek(offset, origin); },
      tell() { return file.tell(); }, close() { events.push("close"); file.close(); },
    } satisfies WritableBinaryFile;
  });
  return { writes, events, spy };
}

for (const kind of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  test.skipIf(kind === "gl" && process.env["QUAKE_GL_TEST"] !== "1")(`${kind} JPEG captures real patterned pixels, separate writes, mixed-format aliases and counters`, async () => {
    const files = new WritableFileSystem({ homePath: mkdtempSync(join(tmpdir(), "quake3-jpeg-shot-")), product: "baseq3", print: () => undefined });
    const owner = new EngineScreenshots(), output: string[] = [], f = await graphics(kind, owner, files, output);
    const trace = recordFileWrites(files);
    try {
      f.clear(1, 0); f.commands.submit();
      f.draw.fillRect({ x: 0, y: 0, width: 16, height: 8 }, { x: 0, y: 1, z: 0, w: 1 }, f.picture); f.commands.submit();
      const pixels = kind === "cpu" && f.renderer.kind === "cpu" ? f.renderer.backend.pixels.slice()
        : f.renderer.kind === "gl" ? f.renderer.backend.readPixels() : f.renderer.backend.pixels.slice();
      f.console.executeNow("screenshotJPEG pattern"); f.commands.submit();
      expect(trace.events).toEqual(["open", "write", "close", "open", "write", "close"]);
      expect(trace.writes[0]?.bytes).toEqual(new Uint8Array([255]));
      const encoded = readFileSync(join(files.rootPath, "screenshots/pattern.jpg"));
      const image = decodeJpeg(encoded, "screenshots/pattern.jpg", unexpectedJpegWarning);
      expect([image.width, image.height]).toEqual([16, 16]);
      expect(image.pixels[1]).toBeGreaterThan(240); expect(image.pixels[0]).toBeLessThan(10);
      expect(image.pixels[15 * 16 * 4]).toBeGreaterThan(240); expect(image.pixels[15 * 16 * 4 + 1]).toBeLessThan(10);
      const reference = process.env["Q3_JPEG_ENCODER_REFERENCE"];
      if (reference !== undefined) {
        const result = Bun.spawnSync([reference, "16", "16", "95"], { stdin: pixels });
        expect(result.exitCode).toBe(0); expect(new Uint8Array(encoded)).toEqual(new Uint8Array(result.stdout));
      }
      trace.writes.length = 0;
      f.console.executeNow("screenshotJPEG mixed-jpeg"); f.console.executeNow("screenshot mixed-tga"); f.commands.submit();
      expect(trace.writes.map(write => write.path)).toEqual(new Array<string>(3).fill("screenshots/mixed-tga.tga"));
      expect(Array.from(trace.writes[1]?.bytes.subarray(0, 2) ?? [])).toEqual([255, 216]);
      expect(trace.writes[2]?.bytes[2]).toBe(2);
      trace.writes.length = 0;
      f.console.executeNow("screenshot reverse-tga"); f.console.executeNow("screenshotJPEG reverse-jpeg"); f.commands.submit();
      expect(trace.writes.map(write => write.path)).toEqual(new Array<string>(3).fill("screenshots/reverse-jpeg.jpg"));
      expect(trace.writes[0]?.bytes[2]).toBe(2);
      expect(Array.from(trace.writes[2]?.bytes.subarray(0, 2) ?? [])).toEqual([255, 216]);
      f.console.executeNow("screenshotJPEG levelshot ignored");
      expect(decodeTga(readFileSync(join(files.rootPath, "levelshots/fixture.tga"))).width).toBe(128);
      f.console.executeNow("screenshotJPEG shot0000"); f.commands.submit();
      output.length = 0;
      f.console.executeNow("screenshotJPEG silent"); f.commands.submit();
      f.console.executeNow("screenshot silent"); f.commands.submit();
      expect(output).toEqual([]);
      expect(existsSync(join(files.rootPath, "screenshots/shot0001.jpg"))).toBe(true);
      expect(existsSync(join(files.rootPath, "screenshots/shot0000.tga"))).toBe(true);
    } finally { trace.spy.mockRestore(); f.close(); files.closeAll(); }
  });

  test.skipIf(kind === "gl" && process.env["QUAKE_GL_TEST"] !== "1")(`${kind} JPEG accepts odd RGB row widths and gamma does not mutate the framebuffer`, async () => {
    const files = new WritableFileSystem({ homePath: mkdtempSync(join(tmpdir(), "quake3-jpeg-gamma-")), product: "baseq3", print: () => undefined });
    const f = await graphics(kind, new EngineScreenshots(), files, [], 17, 19), trace = recordFileWrites(files);
    const gamma = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 1, deviceSupportsGamma: true, isFullscreen: true, colorBits: 32 });
    const profile = f.configuration.imageUploadProfile();
    // Synthetic source color table exercises the gamma boundary; physical gamma acceptance is not claimed.
    const profileSpy = spyOn(f.configuration, "imageUploadProfile").mockReturnValue({ ...profile, colorMappings: gamma });
    try {
      f.clear(0.2, 0.3); f.commands.submit();
      const before = f.renderer.kind === "cpu" ? f.renderer.backend.pixels.slice() : f.renderer.backend.readPixels();
      f.console.executeNow("screenshotJPEG odd-gamma"); f.commands.submit();
      const first = before[(19 - 1) * 17 * 4];
      if (first === undefined) throw new Error("Missing actual bottom-left pixel");
      expect(trace.writes[0]?.bytes).toEqual(new Uint8Array([Math.min(255, first * 2)]));
      const after = f.renderer.kind === "cpu" ? f.renderer.backend.pixels.slice() : f.renderer.backend.readPixels();
      expect(after).toEqual(before);
      const image = decodeJpeg(readFileSync(join(files.rootPath, "screenshots/odd-gamma.jpg")), "screenshots/odd-gamma.jpg", unexpectedJpegWarning);
      expect([image.width, image.height]).toEqual([17, 19]); expect(image.pixels[0]).toBeGreaterThan(95); expect(image.pixels[1]).toBeGreaterThan(145);
      const reference = process.env["Q3_JPEG_ENCODER_REFERENCE"];
      if (reference !== undefined) {
        const corrected = before.map(value => Math.min(255, value * 2));
        const result = Bun.spawnSync([reference, "17", "19", "95"], { stdin: corrected });
        expect(result.exitCode).toBe(0);
        expect(new Uint8Array(readFileSync(join(files.rootPath, "screenshots/odd-gamma.jpg")))).toEqual(new Uint8Array(result.stdout));
      }
    } finally { profileSpy.mockRestore(); trace.spy.mockRestore(); f.close(); files.closeAll(); }
  });
}

test("detached wide CPU capture preserves JPEG one-byte precreation before the codec dimension error", async () => {
  const files = new WritableFileSystem({ homePath: mkdtempSync(join(tmpdir(), "quake3-jpeg-limit-")), product: "baseq3", print: () => undefined });
  const f = await graphics("cpu", new EngineScreenshots(), files, []), trace = recordFileWrites(files);
  // SDL's client dimensions stop at 16384. A real detached CPU target reaches the codec's 65500 limit.
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(65501, 1, images), target = new RenderTarget(images, [cpu]);
  const filename = new ScreenshotFilename(); filename.value = "screenshots/too-wide.jpg";
  const capture = new ScreenshotCommand({ renderer: { kind: "cpu", backend: cpu }, configuration: f.configuration,
    width: cpu.width, height: cpu.height }, files, filename, () => undefined, "jpeg");
  try {
    cpu.beginView({ viewport: { x: 0, y: 0, width: 65501, height: 1 }, clear: { color: { x: 1, y: 0, z: 0, w: 1 }, depth: 1, stencil: false } });
    expect(() => capture.execute()).toThrow("1..65500");
    expect(trace.events).toEqual(["open", "write", "close"]);
    expect(new Uint8Array(readFileSync(join(files.rootPath, "screenshots/too-wide.jpg")))).toEqual(new Uint8Array([255]));
  } finally { target.close(); trace.spy.mockRestore(); f.close(); files.closeAll(); }
});

test("failed TGA, levelshot and both JPEG writes preserve source warning order and blocked directories", async () => {
  const output: string[] = [], files = new WritableFileSystem({ homePath: mkdtempSync(join(tmpdir(), "quake3-shot-failure-")), product: "baseq3", print: text => { output.push(text); } });
  const f = await graphics("cpu", new EngineScreenshots(), files, output), trace = recordFileWrites(files);
  const paths = ["screenshots/blocked.tga", "screenshots/blocked.jpg", "levelshots/fixture.tga"];
  const identities = paths.map(path => {
    const directory = join(files.rootPath, path); mkdirSync(directory, { recursive: true }); return statSync(directory).ino;
  });
  const original = files.openBinaryWrite("screenshots/blocked.jpg/original");
  if (original === null) throw new Error("Failed to create preserved file fixture");
  original.writeBytes(new Uint8Array([17, 29, 41])); original.close();
  try {
    f.clear(1, 0); f.commands.submit(); output.length = 0;
    f.console.executeNow("screenshot blocked"); f.commands.submit();
    expect(output).toEqual(["Wrote screenshots/blocked.tga\n", "Failed to open screenshots/blocked.tga\n"]);
    output.length = 0; trace.events.length = 0;
    f.console.executeNow("screenshotJPEG blocked"); f.commands.submit();
    expect(output).toEqual(["Wrote screenshots/blocked.jpg\n", "Failed to open screenshots/blocked.jpg\n", "Failed to open screenshots/blocked.jpg\n"]);
    expect(trace.events).toEqual(["open", "open"]);
    output.length = 0;
    f.console.executeNow("screenshotJPEG levelshot");
    expect(output).toEqual(["Failed to open levelshots/fixture.tga\n", "Wrote levelshots/fixture.tga\n"]);
    expect(paths.map(path => statSync(join(files.rootPath, path)).ino)).toEqual(identities);
    expect(paths.every(path => statSync(join(files.rootPath, path)).isDirectory())).toBe(true);
    expect(new Uint8Array(readFileSync(join(files.rootPath, "screenshots/blocked.jpg/original")))).toEqual(new Uint8Array([17, 29, 41]));
  } finally { trace.spy.mockRestore(); f.close(); files.closeAll(); }
});

test("separate source counters retain TGA's refused 9999 and JPEG's accepted 9999 across renderer replacement", async () => {
  const files = new WritableFileSystem({ homePath: mkdtempSync(join(tmpdir(), "quake3-shot-numbers-")), product: "baseq3", print: () => undefined });
  const owner = new EngineScreenshots(), output: string[] = [], f = await graphics("cpu", owner, files, output);
  try {
    // Isolate filename statics from capture: retire these pending diagnostic commands without execution.
    for (let index = 0; index < 9999; index++) {
      f.console.executeNow("screenshot silent"); f.console.executeNow("screenshotJPEG silent");
    }
  } finally { f.close(); }
  const restarted = await graphics("cpu", owner, files, output);
  try {
    restarted.clear(1, 0); restarted.commands.submit();
    restarted.console.executeNow("screenshot silent");
    expect(output).toEqual(["ScreenShot: Couldn't create a file\n"]);
    restarted.console.executeNow("screenshotJPEG silent"); restarted.commands.submit();
    expect(decodeJpeg(readFileSync(join(files.rootPath, "screenshots/shot9999.jpg")), "screenshots/shot9999.jpg", unexpectedJpegWarning).width).toBe(16);
    expect(existsSync(join(files.rootPath, "screenshots/shot9999.tga"))).toBe(false);
    restarted.console.executeNow("screenshotJPEG silent");
    expect(output).toEqual(["ScreenShot: Couldn't create a file\n", "ScreenShot: Couldn't create a file\n"]);
  } finally { restarted.close(); files.closeAll(); }
});

const dataPath = process.env["Q3_DATA"];
for (const renderer of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  test.skipIf(dataPath === undefined || (renderer === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
    `actual ${renderer} client screenshot commands, restart, world levelshot and AVI clock`, async () => {
      if (dataPath === undefined) throw new Error("Q3_DATA required");
      const homePath = mkdtempSync(join(tmpdir(), "quake3-client-screenshot-")), stdin = new PassThrough(), output: string[] = [];
      const readPixels = GlRenderer.prototype.readPixels, readbacks: Uint8Array[] = [];
      const readbackSpy = spyOn(GlRenderer.prototype, "readPixels").mockImplementation(function(this: GlRenderer) {
        const pixels = readPixels.call(this); readbacks.push(pixels.slice()); return pixels;
      });
      const host = await ClientHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
        startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set cl_motd 0 +set s_initsound 0 +set bot_enable 0 +set r_fullscreen 0 +echo screenshot-client-probe",
        buildDate: "screenshot-client-probe", print: text => { output.push(text); },
        bots: { kind: "unavailable", reason: "Screenshot test does not use bots" },
        video: { renderer, width: 320, height: 240, hidden: true }, sound: { sampleRate: 48000 }, input: { stdin, signals: "none" } });
      async function frame(): Promise<void> { expect((await host.frame()).kind).toBe("frame"); }
      expect(host.common.commands.registeredNames()).toContain("screenshot");
      expect(host.common.commands.registeredNames()).toContain("screenshotJPEG");
      try {
        await frame(); host.common.commands.append("screenshot client\n"); await frame();
        const image = decodeTga(readFileSync(join(homePath, "baseq3/screenshots/client.tga")));
        expect([image.width, image.height]).toEqual([320, 240]);
        // A post-swap GL back buffer may be black. Compare the actual read, not assumed swap retention.
        if (renderer === "gl") {
          const readback = readbacks.at(-1);
          if (readback === undefined) throw new Error("Screenshot did not read the actual GL framebuffer");
          expect(image.pixels).toEqual(readback.map((value, index) => index % 4 === 3 ? 255 : value));
        }
        else expect(image.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
        host.common.commands.append("screenshotJPEG client-jpeg\n"); await frame();
        const jpeg = decodeJpeg(readFileSync(join(homePath, "baseq3/screenshots/client-jpeg.jpg")), "screenshots/client-jpeg.jpg", unexpectedJpegWarning);
        expect([jpeg.width, jpeg.height]).toEqual([320, 240]);
        const blocked = join(homePath, "baseq3/screenshots/client-blocked.jpg"); mkdirSync(blocked);
        output.length = 0; host.common.commands.append("screenshotJPEG client-blocked\n"); await frame();
        expect(output.filter(text => text.includes("client-blocked.jpg"))).toEqual([
          "Wrote screenshots/client-blocked.jpg\n", "Failed to open screenshots/client-blocked.jpg\n", "Failed to open screenshots/client-blocked.jpg\n"]);
        expect(statSync(blocked).isDirectory()).toBe(true);
        host.common.commands.append("set cl_avidemo 30\nset cl_forceavidemo 0\n"); await frame();
        expect(host.client.clientStatic.realFrameTime).toBe(33); expect(existsSync(join(homePath, "baseq3/screenshots/shot0000.tga"))).toBe(false);
        host.common.commands.append("set cl_forceavidemo 1\n"); await frame();
        expect(existsSync(join(homePath, "baseq3/screenshots/shot0000.tga"))).toBe(true);
        host.common.commands.register("avi-reread-probe", () => {
          host.common.commands.unregister("screenshot");
          host.common.commands.register("screenshot", () => { host.common.cvars.set("cl_avidemo", "60", true); });
        });
        host.common.commands.append("avi-reread-probe\nset cl_avidemo 30\n"); await frame();
        expect(host.client.clientStatic.realFrameTime).toBe(16);
        host.common.commands.append("set cl_avidemo 0\nvid_restart\n"); await frame();
        host.common.commands.append("set cl_avidemo 0\nscreenshot before-restart\nvid_restart\nscreenshot after-restart\n"); await frame();
        expect(existsSync(join(homePath, "baseq3/screenshots/before-restart.tga"))).toBe(true);
        expect(existsSync(join(homePath, "baseq3/screenshots/after-restart.tga"))).toBe(true);
        host.common.commands.append("screenshotJPEG before-jpeg-restart\nvid_restart\nscreenshotJPEG after-jpeg-restart\n"); await frame();
        expect(decodeJpeg(readFileSync(join(homePath, "baseq3/screenshots/before-jpeg-restart.jpg")), "screenshots/before-jpeg-restart.jpg", unexpectedJpegWarning).width).toBe(320);
        expect(decodeJpeg(readFileSync(join(homePath, "baseq3/screenshots/after-jpeg-restart.jpg")), "screenshots/after-jpeg-restart.jpg", unexpectedJpegWarning).width).toBe(320);
        await frame(); host.common.commands.append("devmap q3dm1\n");
        for (let index = 0; index < 40 && host.client.clientStatic.phase !== "active"; index++) await frame();
        expect(host.client.clientStatic.phase).toBe("active");
        host.common.commands.append("screenshot levelshot\nset cl_forceavidemo 0\nset cl_avidemo 60\nset timescale 1.5\n"); await frame();
        expect(host.client.clientStatic.realFrameTime).toBe(24);
        expect(existsSync(join(homePath, "baseq3/screenshots/shot0001.tga"))).toBe(true);
        const levelshot = decodeTga(readFileSync(join(homePath, "baseq3/levelshots/q3dm1.tga")));
        expect([levelshot.width, levelshot.height]).toEqual([128, 128]);
        expect(output.some(text => text.includes("Wrote levelshots/q3dm1.tga"))).toBe(true);
        host.common.commands.append("screenshotJPEG levelshot\n"); await frame();
        expect(decodeTga(readFileSync(join(homePath, "baseq3/levelshots/q3dm1.tga"))).width).toBe(128);
        host.common.commands.append("set cl_avidemo 0\nscreenshotJPEG final-shutdown\nquit\n");
        expect((await host.frame()).kind).toBe("quit");
        expect(decodeJpeg(readFileSync(join(homePath, "baseq3/screenshots/final-shutdown.jpg")), "screenshots/final-shutdown.jpg", unexpectedJpegWarning).width).toBe(320);
        expect(host.common.commands.registeredNames()).not.toContain("screenshot");
        expect(host.common.commands.registeredNames()).not.toContain("screenshotJPEG");
      } finally { try { await host.close(); } finally { readbackSpy.mockRestore(); stdin.destroy(); } }
    }, 120000);
}
