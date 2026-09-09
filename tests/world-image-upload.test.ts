import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { encodeJpeg } from "../src/assets/jpeg-encoder.ts";
import { JpegSourceError } from "../src/assets/jpeg.ts";
import { BinaryError } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SourceBspResource } from "../src/render/bsp-resource.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { CreateImageOperation, ImageResourceOperation } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { PreparedBackendSourceDraw } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadRendererImage } from "../src/render/image-loader.ts";
import { createImageColorMappings } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";
import { RendererResources } from "../src/render/world.ts";
import { createModelEntity } from "../src/render/ref-entity.ts";
import type { PatchMemoryProfile } from "../src/render/patch.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture, solidTga } from "./render-bsp-fixture.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function profile(overbrightBits: number, picmip = 1): ImageUploadProfile {
  return { picmip, roundImagesDown: true, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 32, textureCompression: "none", maxTextureSize: null,
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 2, requestedOverbrightBits: overbrightBits,
      deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 }) };
}

async function fixture(script: string, actualFiles?: VirtualFileSystem, native = false,
  patchMemory: PatchMemoryProfile = { kind: "diagnostic" }) {
  const texture = new Uint8Array(18 + 4 * 4 * 3);
  texture.set(solidTga(10, 20, 30).subarray(0, 18)); texture[12] = 4; texture[14] = 4;
  for (let i = 18; i < texture.length; i += 3) texture.set([30, 20, 10], i);
  const files = new Map<string, Uint8Array>([["scripts/test.shader", new TextEncoder().encode(script)],
    ["shared.tga", texture], ["plain.tga", texture], ["other.tga", texture]]);
  const reads: string[] = [], trace: string[] = [], printed: string[] = [];
  const source: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = actualFiles ?? withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => files.get(path)?.byteLength ?? -1,
    readFileOptional: async path => { const bytes = files.get(path.toLowerCase()); if (bytes !== undefined) reads.push(path); return bytes; },
    has: path => files.has(path),
    list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing ${path}`); reads.push(path); return bytes; } });
  const reader: typeof source = {
    readFileRetained: path => { trace.push(`read:${path}`); return source.readFileRetained(path); },
    readFileRetainedSync: path => source.readFileRetainedSync(path),
    freeFile: buffer => { source.freeFile(buffer); },
    readFileLength: path => source.readFileLength(path),
    readFileOptional: path => { trace.push(`read:${path}`); return source.readFileOptional(path); },
    has: path => source.has(path), list: prefix => source.list(prefix), read: path => source.read(path),
  };
  const state = { profile: profile(0) }, imageProfile = () => state.profile;
  const images = new RendererImageCatalog(), creations: CreateImageOperation[] = [], drawnImages: string[] = [];
  const visibleImages: string[] = [];
  class UploadRenderer extends SoftwareRenderer {
    override applyImageResource(operation: ImageResourceOperation): undefined {
      super.applyImageResource(operation);
      if (operation.kind === "create-image") creations.push(operation.creation);
    }
    override prepareSourceGeometry(...args: Parameters<SoftwareRenderer["prepareSourceGeometry"]>): PreparedBackendSourceDraw {
      const prepared = super.prepareSourceGeometry(...args), boundImages: string[] = [];
      const hasGeometry = args[0].batch.indices.length > 0;
      return { ...prepared,
        applyTexture: (unit, operation) => {
          prepared.applyTexture(unit, operation);
          if (operation.kind === "bind-image") boundImages.push(operation.image.name);
        },
        draw: primitives => {
          const before = this.pixels.slice();
          prepared.draw(primitives);
          if (hasGeometry) drawnImages.push(...boundImages);
          if (hasGeometry && this.pixels.some((byte, index) => index % 4 !== 3 && byte !== before[index])) visibleImages.push(...boundImages);
        },
      };
    }
  }
  const window = native && process.env["QUAKE_GL_TEST"] === "1"
    ? SdlWindow.open({ title: "Renderer image loading", width: 16, height: 16, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new UploadRenderer(16, 16, images, gl?.subpixelBits, gl?.stencilBits);
  const target = new RenderTarget(images, gl === null ? [cpu] : [cpu, gl]);
  const settings = createRendererSettings();
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, imageProfile), mixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics, imageProfile, target,
      print: text => { printed.push(text); trace.push(`print:${text}`); } });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { printed.push(text); trace.push(`print:${text}`); }, clock: { milliseconds: () => 0 },
    identityLight: imageProfile().colorMappings.identityLight, tess: resources.tess, runtime: settings.runtime });
  commands.setColor(null);
  cleanup.push(() => commands.close("discard"));
  function creation(name: string): CreateImageOperation {
    const result = [...creations].reverse().find(item => item.image.name === name);
    if (result === undefined) throw new Error(`No creation for ${name}`);
    return result;
  }
  return { resources, creations, creation, reads, files, state, images, trace, printed, cpu, gl, commands, drawnImages, visibleImages };
}

async function looseFiles(entries: readonly (readonly [string, Uint8Array | string])[]): Promise<VirtualFileSystem> {
  const root = mkdtempSync(join(tmpdir(), "quake3-image-loading-")), game = join(root, "baseq3");
  cleanup.push(() => rmSync(root, { recursive: true }));
  mkdirSync(game);
  for (const [path, bytes] of entries) {
    mkdirSync(dirname(join(game, path)), { recursive: true });
    writeFileSync(join(game, path), bytes);
  }
  const files = await VirtualFileSystem.openInspection({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" });
  cleanup.push(() => files.close());
  return files;
}

function palettePcx(): Uint8Array {
  const bytes = new Uint8Array(128 + 1 + 768);
  bytes.set([10, 5, 1, 8]); bytes[128] = 1;
  bytes.set([12, 34, 56], 129 + 3);
  return bytes;
}

function truecolorBmp(): Uint8Array {
  const bytes = new Uint8Array(57), header = new DataView(bytes.buffer);
  bytes.set([66, 77]); header.setUint32(2, bytes.length, true);
  header.setUint32(10, 54, true); header.setUint32(14, 40, true);
  header.setInt32(18, 1, true); header.setInt32(22, 1, true);
  header.setUint16(26, 1, true); header.setUint16(28, 24, true);
  bytes.set([12, 90, 78], 54);
  return bytes;
}

test("actual PCX and BMP source reads publish the requested image and draw its pixels on CPU and GL", async () => {
  const files = await looseFiles([["Palette.PCX", palettePcx()], ["Bitmap.BMP", truecolorBmp()]]);
  const f = await fixture("", files, true); f.trace.length = 0;
  const registered = [
    { name: "Palette.PCX", pixels: [12, 34, 56, 255], shader: await f.resources.registerShaderNoMip("Palette.PCX") },
    { name: "Bitmap.BMP", pixels: [78, 90, 12, 255], shader: await f.resources.registerShaderNoMip("Bitmap.BMP") },
  ];
  for (const { name, pixels, shader } of registered) {
    expect(shader).not.toBeNull();
    const uploaded = f.creation(name);
    expect([uploaded.image.sourceWidth, uploaded.image.sourceHeight]).toEqual([1, 1]);
    expect([...uploaded.levels[0].copyPixels()]).toEqual(pixels);
    f.commands.beginFrame();
    f.commands.draw2D("pixels").stretchPic({ x: 0, y: 0, width: 16, height: 16 },
      { s: 0.5, t: 0.5, s2: 0.5, t2: 0.5 }, f.resources.picture(shader));
    f.commands.submitFrame();
    expect(f.cpu.pixels).toEqual(new Uint8Array(Array.from({ length: 256 }, () => pixels).flat()));
    if (f.gl !== null) expect(f.gl.readPixels()).toEqual(f.cpu.pixels);
  }
  expect(f.trace).toEqual(["read:Palette.PCX", "read:Bitmap.BMP"]);
});

test("actual loose-file dispatch keeps source spelling, lowercase JPEG fallback and repeated uppercase attempts", async () => {
  const jpeg = encodeJpeg({ width: 1, height: 1, pixels: new Uint8Array([128, 128, 128, 255]) }, 100);
  const cases: readonly { readonly request: string; readonly available: string | null; readonly jpeg: boolean;
    readonly loaded: boolean; readonly trace: readonly string[] }[] = [
    { request: "Image.tga", available: "Image.jpg", jpeg: true, loaded: true, trace: ["read:Image.tga", "read:Image.jpg"] },
    { request: "Image.tga", available: "Image.TGA", jpeg: false, loaded: true,
      trace: ["read:Image.tga", "read:Image.jpg", "print:trying Image.TGA...\n", "read:Image.TGA",
        "print:WARNING: 'Image.TGA' TGA file header declares top-down image, ignoring\n"] },
    { request: "Image.tga", available: "Image.JPG", jpeg: true, loaded: false,
      trace: ["read:Image.tga", "read:Image.jpg", "print:trying Image.TGA...\n", "read:Image.TGA", "read:Image.jpg"] },
    { request: "Image.TGA", available: null, jpeg: false, loaded: false,
      trace: ["read:Image.TGA", "read:Image.jpg", "print:trying Image.TGA...\n", "read:Image.TGA", "read:Image.jpg"] },
    { request: "Image.jpg", available: "Image.JPG", jpeg: true, loaded: true,
      trace: ["read:Image.jpg", "print:trying Image.JPG...\n", "read:Image.JPG"] },
    { request: "Image.JPG", available: "Image.jpg", jpeg: true, loaded: false,
      trace: ["read:Image.JPG", "print:trying Image.JPG...\n", "read:Image.JPG"] },
    { request: "Image.jpeg", available: "Image.jpeg", jpeg: true, loaded: false, trace: ["print:trying Image.jPEG...\n"] },
    { request: "Image", available: "Image.tga", jpeg: false, loaded: false, trace: ["print:trying ImAGE...\n"] },
    { request: "abc", available: "abc.tga", jpeg: false, loaded: false, trace: ["print:trying ABC...\n"] },
    { request: ".tga", available: ".tga", jpeg: false, loaded: false, trace: ["print:trying .TGA...\n"] },
  ];
  for (const scenario of cases) {
    const entries: [string, Uint8Array | string][] = [["scripts/test.shader", `test/image { nomipmaps { map ${scenario.request} } }`]];
    if (scenario.available !== null) entries.push([scenario.available, scenario.jpeg ? jpeg : solidTga(10, 20, 30)]);
    const f = await fixture("", await looseFiles(entries)); f.trace.length = 0;
    expect((await f.resources.registerShader("test/image")) !== null).toBe(scenario.loaded);
    const expectedTrace = [...scenario.trace];
    if (!scenario.loaded) expectedTrace.push(`print:WARNING: R_FindImageFile could not find '${scenario.request}' in shader 'test/image'\n`);
    expect(f.trace).toEqual(expectedTrace);
    if (scenario.loaded) expect([...f.creation(scenario.request).levels[0].copyPixels()])
      .toEqual(scenario.jpeg ? [128, 128, 128, 255] : [10, 20, 30, 255]);
  }
});

test("PCX PRINT_ALL rejection precedes uppercase retry and does not become a JPEG fallback", async () => {
  for (const secondRejected of [false, true]) {
    const rejected = palettePcx(); rejected[0] = 0;
    const f = await fixture("", await looseFiles([["Bad.pcx", rejected], ["Bad.PCX", secondRejected ? rejected : palettePcx()],
      ["Bad.jpg", new Uint8Array([0])]]));
    f.trace.length = 0;
    expect((await f.resources.registerShaderNoMip("Bad.pcx")) !== null).toBe(!secondRejected);
    const trace = ["read:Bad.pcx", "print:Bad pcx file Bad.pcx (1 x 1) (0 x 0)\n",
      "print:trying Bad.PCX...\n", "read:Bad.PCX"];
    if (secondRejected) trace.push("print:Bad pcx file Bad.PCX (1 x 1) (0 x 0)\n");
    expect(f.trace).toEqual(trace);
    if (secondRejected) expect(f.resources.diagnostics).toContain("missing texture Bad.pcx");
    else expect([...f.creation("Bad.pcx").levels[0].copyPixels()]).toEqual([12, 34, 56, 255]);
  }
});

test("BMP source drops and decoder boundary errors propagate without retries or image publication", async () => {
  const badBmp = truecolorBmp(); badBmp.set([0, 0]);
  const files = await looseFiles([["Bad.bmp", badBmp], ["Bad.BMP", truecolorBmp()], ["Short_pcx.pcx", new Uint8Array(3)],
    ["Short_bmp.bmp", new Uint8Array(3)], ["Short_tga.tga", new Uint8Array(3)], ["Short_jpg.jpg", new Uint8Array(1)]]);
  const f = await fixture("", files), before = f.creations.length;
  f.trace.length = 0; f.printed.length = 0;
  await expect(f.resources.registerShaderNoMip("Bad.bmp")).rejects.toMatchObject({ name: "CommonError", code: "drop",
    message: "LoadBMP: only Windows-style BMP files supported (Bad.bmp)\n" });
  expect(f.trace).toEqual(["read:Bad.bmp"]);
  for (const extension of ["pcx", "bmp", "tga", "jpg"]) {
    f.trace.length = 0;
    await expect(f.resources.registerShaderNoMip(`Short_${extension}.${extension}`)).rejects.toBeInstanceOf(BinaryError);
    expect(f.trace).toEqual([`read:Short_${extension}.${extension}`]);
  }
  expect(f.creations).toHaveLength(before); expect(f.printed).toEqual([]);
});

test("source retry and image creation reject unsafe name bounds at the reached source position", async () => {
  for (const name of ["a", "ab", `${"x".repeat(60)}.tga`, `${"x".repeat(60)}.bmp`]) {
    const f = await fixture(`test/image { { map ${name} } }`); f.trace.length = 0;
    await expect(f.resources.registerShader("test/image")).rejects.toBeInstanceOf(RangeError);
    expect(f.trace).toEqual(name.length < 5 ? [] : [`read:${name}`]);
  }
  const name = `${"x".repeat(60)}.bmp`;
  const f = await fixture("", await looseFiles([[name, truecolorBmp()], ["scripts/test.shader", `test/image { { map ${name} } }`]]));
  f.trace.length = 0;
  await expect(f.resources.registerShader("test/image")).rejects.toMatchObject({ name: "CommonError", code: "drop",
    message: `R_CreateImage: "${name}" is too long\n` });
  expect(f.trace).toEqual([`read:${name}`]);
});

test("JPEG source fatal errors preserve retained reads without retries or frees", async () => {
  const cases = [
    { bytes: new Uint8Array([0, 171]), message: "Not a JPEG file: starts with 0x00 0xab\n", warnings: [] },
    { bytes: new Uint8Array([255, 216, 7, 255, 216]), message: "Invalid JPEG file structure: two SOI markers\n",
      warnings: ["Corrupt JPEG data: 1 extraneous bytes before marker 0xd8\n"] },
  ];
  for (const request of ["Fatal.jpg", "Fatal.tga"]) for (const { bytes, message, warnings } of cases) {
    const memory = new ReadFileMemory(), trace: string[] = [];
    cleanup.push(() => memory.disposeResources());
    let retained: RetainedFileBuffer | undefined;
    const files: Pick<RetainedFileReader, "readFileRetained" | "freeFile"> = {
      readFileRetained: async path => {
        trace.push(`read:${path}`);
        if (path !== "Fatal.jpg") return undefined;
        retained = memory.read(bytes.length, target => { target.set(bytes); });
        return retained;
      },
      freeFile: buffer => { trace.push("free"); memory.freeFile(buffer); },
    };
    await expect(loadRendererImage(files, request, text => { trace.push(`print:${text}`); }))
      .rejects.toMatchObject({ name: "CommonError", code: "fatal", message });
    expect(trace).toEqual([...(request.endsWith(".tga") ? ["read:Fatal.tga", "read:Fatal.jpg"] : ["read:Fatal.jpg"]),
      ...warnings.map(text => `print:${text}`)]);
    expect(memory.loadStack).toBe(1);
    if (retained === undefined) throw new Error("missing retained JPEG input");
    expect(retained.bytes).toEqual(bytes);
  }
});

test("JPEG warning completion frees after print while callback aborts retain the input", async () => {
  const jpeg = encodeJpeg({ width: 1, height: 1, pixels: new Uint8Array([128, 128, 128, 255]) }, 100);
  const bytes = new Uint8Array([...jpeg.subarray(0, 2), 7, ...jpeg.subarray(2)]);
  const failures = [null, new CommonError("drop", "print retired its owner"), new Error("print unavailable"),
    new JpegSourceError("callback.jpg", 2, "callback failed")];
  for (const failure of failures) {
    const memory = new ReadFileMemory(), trace: string[] = [];
    cleanup.push(() => memory.disposeResources());
    const files: Pick<RetainedFileReader, "readFileRetained" | "freeFile"> = {
      readFileRetained: async path => {
        trace.push(`read:${path}`);
        return memory.read(bytes.length, target => { target.set(bytes); });
      },
      freeFile: buffer => { trace.push(`free:${memory.loadStack}`); memory.freeFile(buffer); },
    };
    const load = loadRendererImage(files, "Warning.jpg", text => {
      trace.push(`print:${memory.loadStack}:${text}`);
      if (failure !== null) throw failure;
    });
    if (failure !== null) await expect(load).rejects.toBe(failure);
    else expect((await load)?.pixels).toEqual(new Uint8Array([128, 128, 128, 255]));
    expect(trace).toEqual(["read:Warning.jpg", "print:1:Corrupt JPEG data: 1 extraneous bytes before marker 0xe0\n",
      ...(failure === null ? ["free:1"] : [])]);
    expect(memory.loadStack).toBe(failure === null ? 0 : 1);
  }
});

test("JPEG physical input bounds remain BinaryError and do not free retained input", async () => {
  const memory = new ReadFileMemory(), trace: string[] = [];
  cleanup.push(() => memory.disposeResources());
  const files: Pick<RetainedFileReader, "readFileRetained" | "freeFile"> = {
    readFileRetained: async path => {
      trace.push(`read:${path}`);
      return memory.read(1, bytes => { bytes[0] = 255; });
    },
    freeFile: buffer => { trace.push("free"); memory.freeFile(buffer); },
  };
  await expect(loadRendererImage(files, "Bounds.jpg", text => { trace.push(`print:${text}`); }))
    .rejects.toMatchObject({ name: "BinaryError", source: "Bounds.jpg", offset: 1 });
  expect(trace).toEqual(["read:Bounds.jpg"]);
  expect(memory.loadStack).toBe(1);
});

test("source image names stop at NUL and a failed source print aborts before the retry read", async () => {
  const files = await looseFiles([["Terminated.tga", solidTga(10, 20, 30)]]), printed: string[] = [];
  const decoded = await loadRendererImage(files, "Terminated.tga\0ignored\u0100", text => { printed.push(text); });
  expect(decoded?.pixels).toEqual(new Uint8Array([10, 20, 30, 255]));
  expect(printed).toEqual(["WARNING: 'Terminated.tga' TGA file header declares top-down image, ignoring\n"]);
  const f = await fixture("", files);
  expect(await f.resources.registerShaderNoMip("Terminated.tga\0ignored")).not.toBeNull();
  expect(f.creation("Terminated.tga").image.name).toBe("Terminated.tga");
  const failure = new CommonError("drop", "print callback retired its owner"), trace: string[] = [];
  await expect(loadRendererImage({ readFileRetained: path => { trace.push(path); return files.readFileRetained(path); }, freeFile: buffer => { files.freeFile(buffer); } },
    "Absent.pcx", text => { trace.push(text); throw failure; })).rejects.toBe(failure);
  expect(trace).toEqual(["Absent.pcx", "trying Absent.PCX...\n"]);
  await expect(loadRendererImage(files, "\u0100.tga", text => { printed.push(text); })).rejects.toBeInstanceOf(RangeError);
});

test("actual renderer source reads replay shader, image and BSP bytes before consulting changed live files", async () => {
  const root = mkdtempSync(join(tmpdir(), "quake3-render-journal-")), dataPath = join(root, "data"), homePath = join(root, "home");
  const game = join(homePath, "baseq3"), owners: CommonConsole[] = [];
  cleanup.push(() => { try { for (const common of owners.reverse()) common.close(); } finally { rmSync(root, { recursive: true }); } });
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  for (const directory of ["scripts", "maps"]) mkdirSync(join(game, directory), { recursive: true });
  writeFileSync(join(dataPath, "baseq3/default.cfg"), "set renderer_journal 1\n");
  writeFileSync(join(dataPath, "baseq3/productid.txt"), SOURCE_PRODUCT_ID);
  const script = new TextEncoder().encode("test/replayed { { map recorded.cfg.tga } } test/case { { map plain.CFG.tga } } test/missing { { map missing.cfg.jpg } }");
  const image = solidTga(10, 20, 30), map = renderBspFixture([{ shader: "test/replayed", lightmap: -1 }, { shader: "test/replayed", lightmap: -1 }], []);
  writeFileSync(join(game, "scripts/recorded.cfg.shader"), script); writeFileSync(join(game, "maps/recorded.cfg.bsp"), map);
  writeFileSync(join(game, "recorded.cfg.tga"), image); writeFileSync(join(game, "plain.CFG.tga"), image);
  async function open(mode: number) {
    return CommonConsole.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands(`+set journal ${mode}`), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
      platformPrint: () => undefined, assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
      resolveCommand: () => undefined }, owner => { owners.push(owner); });
  }
  const common = await open(1), journalPath = join(game, "journaldata.dat"), start = readFileSync(journalPath).byteLength;
  const record = await fixture("", common.files.current, false, { kind: "source-zone", zone: common.mainZone });
  expect(await record.resources.registerShader("test/replayed")).not.toBeNull();
  expect(await record.resources.registerShader("test/case")).not.toBeNull();
  expect((await record.resources.loadWorld("recorded.cfg")).map.shaders[0]?.name).toBe("test/replayed");
  expect(await record.resources.registerShader("test/missing")).toBeNull();
  const pixels = record.creation("recorded.cfg.tga").levels[0].copyPixels(), ordinary = record.creation("plain.CFG.tga").levels[0].copyPixels();
  const journalBytes = readFileSync(journalPath), journal = new DataView(journalBytes.buffer, journalBytes.byteOffset, journalBytes.byteLength);
  expect(journalBytes.byteLength - start).toBe(20 + script.byteLength + image.byteLength + map.byteLength);
  expect(journal.getInt32(start, true)).toBe(script.byteLength);
  expect(journal.getInt32(start + 4 + script.byteLength, true)).toBe(image.byteLength);
  expect(journal.getInt32(start + 8 + script.byteLength + image.byteLength, true)).toBe(map.byteLength);
  expect(journal.getInt32(journalBytes.byteLength - 4, true)).toBe(0);
  common.close();
  writeFileSync(join(game, "scripts/recorded.cfg.shader"), "changed { { map $whiteimage } }");
  rmSync(join(game, "recorded.cfg.tga")); rmSync(join(game, "maps/recorded.cfg.bsp"));
  writeFileSync(join(game, "missing.cfg.jpg"), new Uint8Array([1])); writeFileSync(join(game, "plain.CFG.tga"), solidTga(70, 80, 90));
  const restored = await open(2), replay = await fixture("", restored.files.current, false, { kind: "source-zone", zone: restored.mainZone });
  expect(restored.files.current.has("recorded.cfg.tga")).toBe(false); expect(restored.files.current.has("missing.cfg.jpg")).toBe(true);
  expect(await replay.resources.registerShader("test/replayed")).not.toBeNull();
  expect(await replay.resources.registerShader("test/case")).not.toBeNull();
  expect((await replay.resources.loadWorld("recorded.cfg")).map.shaders[0]?.name).toBe("test/replayed");
  expect(await replay.resources.registerShader("test/missing")).toBeNull();
  expect(replay.creation("recorded.cfg.tga").levels[0].copyPixels()).toEqual(pixels);
  expect(replay.creation("plain.CFG.tga").levels[0].copyPixels()).not.toEqual(ordinary);
  expect(replay.resources.diagnostics).toContain("missing texture missing.cfg.jpg");
  expect(restored.files.current.readFileOptionalSync("eof.cfg")).toBeUndefined();
});

test("implicit registration publishes source mip flags, picmip dimensions and nonmip bypass", async () => {
  const { resources, creation } = await fixture("");
  await resources.registerShader("shared.tga"); await resources.registerShaderNoMip("plain.tga");
  const mip = creation("shared.tga"), plain = creation("plain.tga");
  expect([mip.image.sourceWidth, mip.image.sourceHeight]).toEqual([4, 4]);
  expect(mip.levels.map(level => [level.width, level.height])).toEqual([[2, 2], [1, 1]]);
  expect(mip.sampling).toEqual({ wrap: "repeat", filter: "linear-mipmap-nearest" });
  expect(Array.from(mip.levels[0].copyPixels().subarray(0, 4))).toEqual([20, 40, 60, 255]);
  expect(plain.mipmap).toBe(false); expect(plain.levels).toHaveLength(1); expect(plain.levels[0].width).toBe(4);
  expect(plain.sampling).toEqual({ wrap: "clamp", filter: "linear" });
  expect(Array.from(plain.levels[0].copyPixels().subarray(0, 4))).toEqual([10, 20, 30, 255]);
});

test("first exact image name retains flags and warns on each mismatched source parameter", async () => {
  const { resources, creations, creation, reads } = await fixture("first { nomipmaps { clampmap shared.tga } } second { { map shared.tga } } case { { map Shared.tga } }");
  await resources.registerShader("first"); await resources.registerShader("second"); await resources.registerShader("case");
  expect(creations.filter(item => item.image.name === "shared.tga")).toHaveLength(1);
  expect(creation("shared.tga").mipmap).toBe(false);
  expect(creation("Shared.tga").mipmap).toBe(true);
  expect(reads.filter(name => name === "shared.tga" || name === "Shared.tga")).toEqual(["shared.tga", "Shared.tga"]);
  for (const parameter of ["mipmap", "allowPicmip", "glWrapClampMode"]) {
    expect(resources.diagnostics).toContain(`WARNING: reused image shared.tga with mixed ${parameter} parm`);
  }
});

test("implicit default extension shares the explicit exact-name cache and first creation flags in both orders", async () => {
  for (const implicitFirst of [true, false]) {
    const { resources, creations, creation, reads } = await fixture("explicit { { map shared.tga } }");
    if (implicitFirst) { await resources.registerShaderNoMip("shared"); await resources.registerShader("explicit"); }
    else { await resources.registerShader("explicit"); await resources.registerShaderNoMip("shared"); }
    expect(creations.filter(item => item.image.name === "shared.tga")).toHaveLength(1);
    expect(creations.some(item => item.image.name === "shared")).toBe(false);
    expect(reads.filter(name => name === "shared.tga")).toHaveLength(1);
    expect(creation("shared.tga").mipmap).toBe(!implicitFirst);
    expect(creation("shared.tga").sampling.wrap).toBe(implicitFirst ? "clamp" : "repeat");
    for (const parameter of ["mipmap", "allowPicmip", "glWrapClampMode"]) {
      expect(resources.diagnostics).toContain(`WARNING: reused image shared.tga with mixed ${parameter} parm`);
    }
  }
});

test("empty internal world shader names return the existing default before image lookup", async () => {
  const { resources, files, creations, reads } = await fixture("");
  const before = creations.length;
  files.set("maps/empty-shader.bsp", renderBspFixture([{ shader: "", lightmap: -1 }, { shader: "", lightmap: -1 }], []));
  const world = await resources.loadWorld("empty-shader");
  expect(creations).toHaveLength(before);
  expect(reads).not.toContain(".tga");
  expect(resources.diagnostics).not.toContain("missing texture .tga");
  const refdef = cameraRefdef({ origin: { x: 0, y: -12, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  const batches = world.frame({ refdef }).flatMap(view => view.operations.flatMap(operation => operation.kind === "draw"
    ? operation.batches : operation.kind === "source-stage" ? [operation.stage.batch] : []));
  expect(batches.length).toBeGreaterThan(0);
  expect(batches.every(batch => batch.texture.kind === "bind-image" && batch.texture.image === resources.builtins.defaultImage)).toBe(true);
  expect(resources.tess.material).toBe(resources.picture(null).material);
});

test("implicit extension preserves source case, dot scan and MAX_QPATH truncation", async () => {
  for (const [name, expected] of [
    ["Shared", "Shared.tga"], ["Shared.TGA", "Shared.TGA"], [".hidden", ".hidden.tga"],
    ["parent.dot/leaf", "parent.dot/leaf.tga"],
  ] satisfies readonly (readonly [string, string])[]) {
    const { resources, files, creation } = await fixture("");
    files.set(expected.toLowerCase(), solidTga(10, 20, 30));
    expect(await resources.registerShaderNoMip(name)).not.toBeNull();
    expect(creation(expected).image.name).toBe(expected);
  }
  for (const [name, expected, retry] of [["parent.dot\\leaf", "parent.dot\\leaf", "parent.dot\\lEAF"],
    ["x".repeat(60), `${"x".repeat(60)}.tg`, `${"x".repeat(60)}.TG`]] satisfies readonly (readonly [string, string, string])[]) {
    const f = await fixture(""); f.trace.length = 0;
    expect(await f.resources.registerShaderNoMip(name)).toBeNull();
    expect(f.trace).toEqual([`print:trying ${retry}...\n`]);
    expect(f.resources.diagnostics).toContain(`missing texture ${expected}`);
    if (name.length === 60) expect(f.resources.diagnostics).toContain("Com_sprintf: overflow of 64 in 64");
  }
});

test("nopicmip keeps a full mip chain and builtins retain source flags with the white exception", async () => {
  const { resources, creation } = await fixture("full { nopicmip { map shared.tga } } white { { clampmap *white } } identity { { clampmap *identityLight } }");
  await resources.registerShaderNoMip("full"); await resources.registerShader("white"); await resources.registerShader("identity");
  expect(creation("shared.tga").levels.map(level => level.width)).toEqual([4, 2, 1]);
  expect(creation("shared.tga").mipmap).toBe(true);
  expect(resources.diagnostics.filter(message => message.includes("reused image *white"))).toHaveLength(0);
  expect(resources.diagnostics).toContain("WARNING: reused image *identityLight with mixed mipmap parm");
  expect(resources.diagnostics).toContain("WARNING: reused image *identityLight with mixed glWrapClampMode parm");
});

test("later uploads use current mapping while existing images retain their bytes and missing reads can retry", async () => {
  const { resources, creation, state, files } = await fixture("broken { { map late.tga } } retry { { map late.tga } }");
  await resources.registerShader("shared.tga");
  expect(await resources.registerShader("broken")).toBeNull();
  files.set("late.tga", solidTga(10, 20, 30));
  expect(await resources.registerShader("retry")).not.toBeNull();
  state.profile = { ...profile(0), colorMappings: createImageColorMappings({ gamma: 1, intensity: 3, requestedOverbrightBits: 0,
    deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 }) };
  await resources.registerShader("other.tga");
  expect(Array.from(creation("shared.tga").levels[0].copyPixels().subarray(0, 4))).toEqual([20, 40, 60, 255]);
  expect(Array.from(creation("other.tga").levels[0].copyPixels().subarray(0, 4))).toEqual([30, 60, 90, 255]);
});

test("world load scales lightmaps and vertices by effective overbright and surface execution reads current identity", async () => {
  const { resources, creation, state, files } = await fixture("lit { { map $whiteimage rgbGen identityLighting } }");
  files.set("maps/probe.bsp", renderBspFixture([{ shader: "lit", lightmap: 0 }, { shader: "lit", lightmap: 1 }], [[10, 20, 30], [20, 30, 40]]));
  state.profile = profile(1);
  const world = await resources.loadWorld("probe"), lightmap = creation("*lightmap0");
  expect(lightmap.internalFormat).toBe("rgb"); expect(lightmap.registrationUnit).toBe(1);
  expect(lightmap.mipmap).toBe(false); expect(lightmap.levels[0].width).toBe(128);
  expect(Array.from(lightmap.levels[0].copyPixels().subarray(0, 4))).toEqual([20, 40, 60, 255]);
  const surface = world.markGeometry.surfaces[0];
  if (surface?.kind !== "face") throw new Error("Expected fixture face");
  expect(surface.vertices[0]?.color).toEqual({ x: 64, y: 96, z: 128, w: 255 });
  const refdef = cameraRefdef({ origin: { x: 0, y: -12, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  const colors = () => world.frame({ refdef }).flatMap(view => view.operations.flatMap(operation => operation.kind === "draw"
    ? operation.batches : operation.kind === "source-stage" ? [operation.stage.batch] : []).flatMap(batch => batch.vertices.map(vertex => vertex.color.x)));
  const initial = colors(); expect(initial.length).toBeGreaterThan(0); expect(initial.every(value => value === 127 / 255)).toBe(true);
  state.profile = profile(2);
  const changed = colors(); expect(changed.length).toBeGreaterThan(0); expect(changed.every(value => value === 63 / 255)).toBe(true);
  expect(Array.from(lightmap.levels[0].copyPixels().subarray(0, 4))).toEqual([20, 40, 60, 255]);
});

test("source single-lightmap companion preserves its borrowed prefix and zero-fills only the unavailable tail", () => {
  const lightmapBytes = 128 * 128 * 3, firstOffset = 144, secondOffset = firstOffset + lightmapBytes;
  const backing = new Uint8Array(19 + secondOffset + lightmapBytes + 7).fill(231);
  const allocation = backing.subarray(19, 19 + secondOffset + 5); allocation.fill(0);
  const header = new DataView(allocation.buffer, allocation.byteOffset, allocation.byteLength);
  header.setInt32(4, 46, true); header.setInt32(120, firstOffset, true); header.setInt32(124, lightmapBytes, true);
  allocation.fill(39, firstOffset, secondOffset); allocation.set([11, 23, 37, 41, 0], secondOffset);
  const before = allocation.slice(), file: RetainedFileBuffer = {
    length: allocation.length - 1, bytes: allocation.subarray(0, allocation.length - 1), terminatedBytes: allocation,
  };
  const trace: string[] = [], printed: string[] = [], uploads: Uint8Array[] = [];
  const source = new SourceBspResource(file, "single.bsp", { kind: "unaccounted" }, text => {
    trace.push("print"); printed.push(text);
  }, { kind: "diagnostic" });
  source.begin();
  expect(source.loadLightmaps(() => { trace.push(`sync:${source.lightmapCount}`); },
    () => { trace.push(`vertex:${source.lightmapCount}`); return false; }, (bytes, index) => {
      trace.push(`upload:${index}:${source.lightmapCount}`); uploads.push(bytes);
    })).toBe(true);
  expect(trace).toEqual(["sync:0", "vertex:2", "upload:0:2", "print", "upload:1:2"]);
  expect(source.lightmapCount).toBe(2); expect(uploads).toHaveLength(2);
  const first = uploads[0], companion = uploads[1];
  if (first === undefined || companion === undefined) throw new Error("Missing lightmap uploads");
  expect(first.buffer).toBe(backing.buffer); expect(first.byteOffset).toBe(19 + firstOffset);
  expect(first).toEqual(before.subarray(firstOffset, secondOffset));
  expect(companion).toHaveLength(lightmapBytes); expect(companion.subarray(0, 5)).toEqual(new Uint8Array([11, 23, 37, 41, 0]));
  expect(companion.subarray(5).every(byte => byte === 0)).toBe(true);
  expect(allocation).toEqual(before);
  expect(printed).toEqual(["R_LoadLightmaps: single.bsp: single-lightmap companion zero-filled 49147 bytes outside FS_ReadFile allocation\n"]);
});

test("source single-lightmap companion keeps every reached byte when the second block is available", () => {
  const bytes = renderBspFixture([{ shader: "lit", lightmap: 0 }, { shader: "lit", lightmap: 0 }], [[10, 20, 30], [40, 50, 60]]);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset = header.getInt32(120, true), lightmapBytes = 128 * 128 * 3;
  header.setInt32(124, lightmapBytes, true);
  const memory = new ReadFileMemory(), file = memory.read(bytes.length, target => { target.set(bytes); });
  cleanup.push(() => memory.disposeResources());
  const uploads: Uint8Array[] = [], printed: string[] = [];
  const source = new SourceBspResource(file, "complete-companion.bsp", { kind: "unaccounted" }, text => { printed.push(text); }, { kind: "diagnostic" });
  source.begin();
  expect(source.loadLightmaps(() => undefined, () => false, data => { uploads.push(data); })).toBe(true);
  expect(source.lightmapCount).toBe(2); expect(uploads).toHaveLength(2); expect(printed).toEqual([]);
  for (const [index, uploaded] of uploads.entries()) {
    expect(uploaded.buffer).toBe(file.terminatedBytes.buffer);
    expect(uploaded.byteOffset).toBe(file.terminatedBytes.byteOffset + offset + index * lightmapBytes);
    expect(uploaded).toEqual(bytes.subarray(offset + index * lightmapBytes, offset + (index + 1) * lightmapBytes));
  }
});

test("source lightmap count and vertex-light gate precede strict first and declared multiple-lightmap reads", () => {
  const lightmapBytes = 128 * 128 * 3;
  for (const scenario of [
    { declared: 0, available: 0, offset: -1, vertex: false, uploads: 0, rejects: false, count: 0 },
    { declared: lightmapBytes, available: 0, offset: -1, vertex: true, uploads: 0, rejects: false, count: 2 },
    { declared: lightmapBytes, available: lightmapBytes - 1, offset: 144, vertex: false, uploads: 0, rejects: true, count: 2 },
    { declared: lightmapBytes * 2, available: lightmapBytes + 5, offset: 144, vertex: false, uploads: 1, rejects: true, count: 2 },
  ]) {
    const bytes = new Uint8Array(144 + scenario.available), header = new DataView(bytes.buffer);
    header.setInt32(4, 46, true); header.setInt32(120, scenario.offset, true); header.setInt32(124, scenario.declared, true);
    const file: RetainedFileBuffer = { length: bytes.length - 1, bytes: bytes.subarray(0, bytes.length - 1), terminatedBytes: bytes };
    const trace: string[] = [], printed: string[] = [];
    const source = new SourceBspResource(file, "strict.bsp", { kind: "unaccounted" }, text => { printed.push(text); }, { kind: "diagnostic" });
    source.begin();
    const load = () => source.loadLightmaps(() => { trace.push(`sync:${source.lightmapCount}`); },
      () => { trace.push(`vertex:${source.lightmapCount}`); return scenario.vertex; }, (_data, index) => { trace.push(`upload:${index}`); });
    if (scenario.rejects) expect(load).toThrow(BinaryError);
    else expect(load()).toBe(false);
    expect(source.lightmapCount).toBe(scenario.count); expect(printed).toEqual([]);
    expect(trace).toEqual(scenario.declared === 0 ? [] : ["sync:0", "vertex:2", ...Array.from({ length: scenario.uploads }, (_, index) => `upload:${index}`)]);
  }
});

test.skipIf(process.env["Q3_DATA"] === undefined)("retail test_bigbox publishes its unused companion and draws default CPU world and model frames for both products", async () => {
  const dataPath = process.env["Q3_DATA"];
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    cleanup.push(() => files.close());
    const map = await files.readFileRetained("maps/test_bigbox.bsp");
    if (map === undefined) throw new Error("Retail test_bigbox is missing");
    const header = new DataView(map.bytes.buffer, map.bytes.byteOffset, map.bytes.byteLength);
    const surfaceOffset = header.getInt32(112, true), surfaceBytes = header.getInt32(116, true);
    expect([map.length, map.terminatedBytes.length, header.getInt32(120, true), header.getInt32(124, true)]).toEqual([54192, 54193, 3376, 49152]);
    expect(surfaceBytes / 104).toBe(6);
    for (let offset = surfaceOffset; offset < surfaceOffset + surfaceBytes; offset += 104) expect(header.getInt32(offset + 28, true)).toBe(0);
    files.freeFile(map);
    const f = await fixture("", files), world = await f.resources.loadWorld("test_bigbox");
    expect(f.creations.filter(creation => creation.image.name.startsWith("*lightmap")).map(creation => creation.image.name)).toEqual(["*lightmap0", "*lightmap1"]);
    expect(f.printed.filter(text => text.includes("single-lightmap companion"))).toEqual([
      "R_LoadLightmaps: maps/test_bigbox.bsp: single-lightmap companion zero-filled 47487 bytes outside FS_ReadFile allocation\n",
    ]);
    const refdef = cameraRefdef(world.initialCamera(), 16, 16);
    f.commands.beginFrame(); f.commands.addPreparedViews(world.prepareFrame({ refdef }));
    expect(f.commands.submitFrame()?.batches).toBeGreaterThan(0);
    expect(f.drawnImages).toContain("*lightmap0"); expect(f.drawnImages).not.toContain("*lightmap1");
    const worldPixels = f.cpu.pixels.slice(); expect(worldPixels.some((byte, index) => index % 4 !== 3 && byte > 0)).toBe(true);
    const model = createModelEntity(await f.resources.registerModel("models/players/sarge/lower.md3"));
    model.customSkin = await f.resources.registerSkin("models/players/sarge/lower_default.skin");
    model.axis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
    model.origin = { x: refdef.viewOrigin.x + refdef.viewAxis[0].x * 64, y: refdef.viewOrigin.y + refdef.viewAxis[0].y * 64,
      z: refdef.viewOrigin.z + refdef.viewAxis[0].z * 64 - 16 };
    f.drawnImages.length = 0; f.visibleImages.length = 0;
    f.resources.rolloverFrame(); f.commands.beginFrame(); f.commands.addPreparedViews(world.prepareFrame({ refdef, entities: [model] }));
    expect(f.commands.submitFrame()?.batches).toBeGreaterThan(0); expect(f.cpu.pixels).not.toEqual(worldPixels);
    expect(f.drawnImages).toContain("*lightmap0"); expect(f.drawnImages).not.toContain("*lightmap1");
    expect(f.drawnImages.some(name => name.startsWith("models/players/sarge/"))).toBe(true);
    expect(f.visibleImages.some(name => name.startsWith("models/players/sarge/"))).toBe(true);
  }
}, 30000);
