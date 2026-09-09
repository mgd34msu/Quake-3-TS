import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, test } from "bun:test";
import { AudioMixer } from "../src/audio/mixer.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { RendererResources } from "../src/render/world.ts";
import type { RendererResourceServices } from "../src/render/world.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { solidTga } from "./render-bsp-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmRenderResourceSyscall } from "../src/vm/render-resource-syscalls.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { SOURCE_BACKEND_RELEASE32 } from "../src/render/backend-memory.ts";

type ResourceListings = Parameters<NonNullable<RendererResourceServices["publishListings"]>>[0];
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(script: string, print: (text: string) => undefined = () => undefined,
  settings = createRendererSettings(), publishListings?: (listings: ResourceListings,
    commands: RenderCommandBuffer | null) => undefined, startup?: { readonly tess: SourceTessState; readonly accounting: SourceHunkAccounting }) {
  const shared = solidTga(127, 63, 31);
  shared[17] = 0;
  const files = new Map<string, Uint8Array>([["scripts/test.shader", new TextEncoder().encode(script)], ["shared.tga", shared]]);
  const reads: string[] = [];
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => files.get(path)?.byteLength ?? -1,
    readFileOptional: async path => { const bytes = files.get(path); if (bytes !== undefined) reads.push(path); return bytes; },
    has: path => files.has(path),
    list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`Missing fixture ${path}`);
      reads.push(path);
      return bytes;
    } });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8, 8, images);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), clock = { milliseconds: () => 0 };
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: startup === undefined ? new HunkArena(1024 * 1024, () => undefined) : startup.accounting.arena, developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: reader }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const earlyCommands = startup === undefined ? null : new RenderCommandBuffer(target, {
    print, clock, identityLight: 1, tess: startup.tess, runtime: settings.runtime });
  if (earlyCommands !== null) cleanup.push(() => earlyCommands.close("discard"));
  const memory: HunkAccountingProfile = startup === undefined ? { kind: "unaccounted" } : { kind: "source-hunk", accounting: startup.accounting };
  const resources = await RendererResources.create(reader, memory, settings,
    { patchMemory: { kind: "diagnostic" }, print, imageProfile: identityImageUploadProfile, target, images, builtins,
      ...(publishListings === undefined ? {} : { publishListings: (listings: ResourceListings) => publishListings(listings, earlyCommands) }),
      ...(startup === undefined ? {} : { tess: startup.tess }),
      drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = earlyCommands ?? new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  if (earlyCommands === null) cleanup.push(() => commands.close("discard"));
  function sampledPixel(image: RendererImage): Uint8Array {
    commands.addView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 0 }, depth: 1 }, operations: [{ kind: "draw", batches: [{
      texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, state: { ...OPAQUE_STATE, cull: "none" },
      indices: [0, 1, 2, 0, 2, 3], vertices: [
        { position: { x: -1, y: 1, z: 0, w: 1 }, color: { x: 1, y: 1, z: 1, w: 1 }, texCoord: { x: 2.5, y: 2.5 } },
        { position: { x: 1, y: 1, z: 0, w: 1 }, color: { x: 1, y: 1, z: 1, w: 1 }, texCoord: { x: 2.5, y: 2.5 } },
        { position: { x: 1, y: -1, z: 0, w: 1 }, color: { x: 1, y: 1, z: 1, w: 1 }, texCoord: { x: 2.5, y: 2.5 } },
        { position: { x: -1, y: -1, z: 0, w: 1 }, color: { x: 1, y: 1, z: 1, w: 1 }, texCoord: { x: 2.5, y: 2.5 } },
      ],
    }] }] });
    commands.submit();
    const offset = (4 * 8 + 4) * 4;
    return cpu.pixels.slice(offset, offset + 4);
  }
  return { resources, reads, files, commands, cpu, recording, builtins, sampledPixel };
}

test("early renderer listings retain the actual shader prefix after interrupted resource initialization", async () => {
  const cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  cvars.set("r_printShaders", "1");
  const failure = new Error("projection shader startup interrupted");
  const published: ResourceListings[] = [];
  await expect(fixture("projectionShadow { { map $whiteimage } }", text => {
    if (text === "*SHADER* projectionShadow\n") throw failure;
  }, settings, listings => {
    published.push(listings);
    if (listings.kind === "shaders") {
      const chunks: string[] = [];
      listings.listShaders(false, text => { chunks.push(text); });
      expect(chunks).toEqual(["-----------------------\n", "0 total shaders\n", "------------------\n"]);
    }
  })).rejects.toThrow(failure);
  expect(published.map(listings => listings.kind)).toEqual(["shaders"]);
  const shaders = published[0];
  if (shaders?.kind !== "shaders") throw new Error("Missing early shader registry");
  const chunks: string[] = [];
  shaders.listShaders(false, text => { chunks.push(text); });
  expect(chunks).toContain(": <default>\n");
  expect(chunks).toContain(": <stencil shadow>\n");
  expect(chunks).toContain("2 total shaders\n");
  expect(chunks.join("")).not.toContain("projectionShadow");
});

test("early renderer listings remain the same live shader model and skin registries after publication", async () => {
  const published: ResourceListings[] = [];
  const cvars = new CvarRegistry();
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const accounting = new SourceHunkAccounting(new HunkArena(8 * 1024 * 1024, text => { throw new Error(`Unexpected hunk diagnostic: ${text}`); }));
  accounting.initializeRendererBackend(settings.sceneLimits(), true);
  const backend = accounting.rendererBackend(1);
  if (backend === null) throw new Error("Missing source backend allocation");
  const tess = new SourceTessState();
  tess.frontEndMemory = backend;
  tess.frontEndSmpFrame = 1;
  cvars.set("r_maxpolys", "900");
  const f = await fixture("later { { map shared.tga } }", () => undefined, settings, (listings, commands) => {
    published.push(listings);
    if (commands === null) throw new Error("Missing early renderer command queue");
    expect(commands.tess).toBe(tess);
    if (listings.kind === "models") {
      const models: string[] = [], skins: string[] = [];
      listings.listModels(text => { models.push(text); });
      listings.listSkins(text => { skins.push(text); });
      expect(models).toEqual(["       0 : Total models\n"]);
      expect(skins).toEqual(["------------------\n", "------------------\n"]);
      commands.setColor({ x: 0.25, y: 0.5, z: 0.75, w: 1 });
    }
  }, { tess, accounting });
  expect(settings.runtime.smpRequested).toBe(false);
  expect(settings.sceneLimits().maxPolys).toBe(900);
  expect(backend.limits.maxPolys).toBe(600);
  expect(f.resources.tess).toBe(tess);
  expect(f.resources.performance).toBe(f.commands.performance);
  expect(tess.frontEndSmpFrame).toBe(1);
  expect(tess.frontEndMemory).toBe(backend);
  expect(backend.commandsData().getInt32(SOURCE_BACKEND_RELEASE32.commandBytes, true)).toBe(20);
  expect(f.commands.submit().commands).toBe(1);
  expect(published.map(listings => listings.kind)).toEqual(["shaders", "models"]);
  const shaders = published[0], models = published[1];
  if (shaders?.kind !== "shaders" || models?.kind !== "models") throw new Error("Missing published renderer registries");
  expect(shaders.listShaders).toBe(f.resources.listShaders);
  expect(models.listModels).toBe(f.resources.listModels);
  expect(models.listSkins).toBe(f.resources.listSkins);
  const skins: string[] = [];
  models.listSkins(text => { skins.push(text); });
  expect(skins).toEqual(["------------------\n", "  0:<default skin>\n", "        = <default>\n", "------------------\n"]);
  expect(await f.resources.registerShader("later")).not.toBeNull();
  const chunks: string[] = [];
  shaders.listShaders(false, text => { chunks.push(text); });
  expect(chunks).toContain(": later\n");
  expect(chunks).toContain("6 total shaders\n");
});

for (const allocation of [
  { remaining: 0, failed: 224, skinRows: [], allocated: [] },
  { remaining: 224, failed: 32, skinRows: ["  0:<default skin>\n"], allocated: [196] },
  { remaining: 256, failed: 128, skinRows: ["  0:<default skin>\n", "        = <default>\n"], allocated: [196, 4] },
]) {
  test(`early renderer listings retain reached skins when startup allocation fails on ${allocation.failed} bytes`, async () => {
    const settings = createRendererSettings(), published: ResourceListings[] = [];
    const accounting = new SourceHunkAccounting(new HunkArena(2 * 1024 * 1024, text => { throw new Error(`Unexpected hunk diagnostic: ${text}`); }));
    const tess = new SourceTessState();
    tess.frontEndMemory = accounting.initializeRendererBackend(settings.sceneLimits());
    await expect(fixture("", () => undefined, settings, listings => {
      published.push(listings);
      if (listings.kind === "models") {
        const skins: string[] = [];
        listings.listSkins(text => { skins.push(text); });
        expect(skins).toEqual(["------------------\n", "------------------\n"]);
        accounting.reserve("fixture", "remaining startup budget", accounting.memoryRemaining() - allocation.remaining, "low");
      }
    }, { tess, accounting })).rejects.toThrow(`Hunk_Alloc failed on ${allocation.failed}`);
    expect(published.map(listings => listings.kind)).toEqual(["shaders", "models"]);
    const models = published[1];
    if (models?.kind !== "models") throw new Error("Missing published model and skin registry");
    const skins: string[] = [], modelRows: string[] = [];
    models.listSkins(text => { skins.push(text); });
    models.listModels(text => { modelRows.push(text); });
    expect(skins).toEqual(["------------------\n", ...allocation.skinRows, "------------------\n"]);
    expect(modelRows).toEqual(["       0 : Total models\n"]);
    expect(accounting.report().trace.filter(row => row.source.startsWith("R_InitSkins")).map(row => row.bytes)).toEqual(allocation.allocated);
    expect(accounting.report().trace.some(row => row.source === "R_ModelInit:R_AllocModel")).toBe(false);
    expect(accounting.memoryRemaining()).toBe(0);
  });
}

test("r_printShaders prints original spelling before explicit parsing and keeps cached and implicit lookups silent", async () => {
  const cvars = new CvarRegistry(), messages: string[] = [];
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const f = await fixture("known { { map shared.tga } { map $whiteimage\n detail } } broken { unknownDirective } later { { map $whiteimage } }", text => {
    messages.push(text);
    if (text.startsWith("*SHADER*")) cvars.set("r_detailtextures", "0", true);
  }, settings);
  messages.length = 0;
  cvars.set("r_printShaders", "-1");
  const known = await f.resources.registerShader("KnOwN.tga");
  expect(known).not.toBeNull();
  expect(f.resources.picture(known).material.finished.numUnfoggedPasses).toBe(1);
  expect(messages).toEqual(["*SHADER* KnOwN.tga\n"]);
  await f.resources.registerShader("known");
  await f.resources.registerShader("shared.tga");
  expect(messages).toEqual(["*SHADER* KnOwN.tga\n"]);
  expect(await f.resources.registerShader("broken")).toBeNull();
  expect(messages).toEqual(["*SHADER* KnOwN.tga\n", "*SHADER* broken\n"]);
  cvars.set("r_printShaders", "0.9");
  await f.resources.registerShader("later");
  expect(messages).toHaveLength(2);
});

test("an interrupted shader diagnostic prevents parsing and publication, and retry prints again", async () => {
  const cvars = new CvarRegistry(), messages: string[] = [];
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const failure = new Error("shader print stopped");
  let stop = true;
  const f = await fixture("known { { map shared.tga } }", text => {
    messages.push(text);
    if (stop && text.startsWith("*SHADER*")) throw failure;
  }, settings);
  messages.length = 0;
  cvars.set("r_printShaders", "1");
  await expect(f.resources.registerShader("known")).rejects.toThrow(failure);
  expect(f.reads).not.toContain("shared.tga");
  stop = false;
  expect(await f.resources.registerShader("known")).not.toBeNull();
  expect(f.reads).toContain("shared.tga");
  expect(messages).toEqual(["*SHADER* known\n", "*SHADER* known\n"]);
});

test("QVM shader handles and picture traps reach the actual CPU command pipeline", async () => {
  const f = await fixture("moddraw { { map shared.tga\n rgbGen vertex\n } }");
  const memory = new QvmMemory(new Uint8Array(1024));
  const call = (role: "ui" | "cgame", trap: number, ...args: number[]) => {
    const words = new DataView(new ArrayBuffer((args.length + 1) * 4));
    words.setInt32(0, trap, true);
    for (const [index, arg] of args.entries()) words.setInt32((index + 1) * 4, arg, true);
    return qvmRenderResourceSyscall(role, words, memory, f.resources, f.commands);
  };
  memory.writeString(16, "moddraw", 16);
  const shader = await f.resources.registerShaderNoMip("moddraw");
  const handle = await call("ui", 20, 16);
  expect(handle).toBe(f.resources.shaderHandle(shader));
  if (typeof handle !== "number" || handle === 0) throw new Error("Expected real registered shader index");
  const color = { x: 0.5, y: 1, z: 0.25, w: 1 };
  f.commands.setColor(color);
  f.commands.stretchPixels({ x: 0, y: 0, width: 8, height: 8 }, { s: 0, t: 0, s2: 1, t2: 1 }, f.resources.picture(shader));
  f.commands.submitFrame();
  const expected = f.cpu.pixels.slice();
  expect(expected.some(byte => byte !== 0)).toBe(true);
  f.cpu.pixels.fill(0);
  const view = memory.view(64, 16);
  for (const [index, value] of [color.x, color.y, color.z, color.w].entries()) view.setFloat32(index * 4, value, true);
  expect(call("ui", 26, 64)).toBe(0);
  expect(call("ui", 27, ...[0, 0, 8, 8, 0, 0, 1, 1].map(float32ToBits), handle)).toBe(0);
  view.setFloat32(0, 1, true);
  f.commands.submitFrame();
  expect(f.cpu.pixels).toEqual(expected);
  expect(await call("cgame", 39, 16)).toBe(handle);
  expect(call("ui", 21)).toBeNull();
});

test("QVM picture reservation precedes commands queued by the actual shader warning", async () => {
  let warning = (): undefined => undefined;
  const f = await fixture("moddraw { { map shared.tga\n rgbGen vertex\n } }", text => {
    if (text.startsWith("R_GetShaderByHandle:")) warning();
  });
  const shader = await f.resources.registerShaderNoMip("moddraw");
  const rect = { x: 0, y: 0, width: 8, height: 8 }, uv = { s: 0, t: 0, s2: 1, t2: 1 };
  const red = { x: 1, y: 0, z: 0, w: 1 }, green = { x: 0, y: 1, z: 0, w: 1 };
  const nested = (): undefined => {
    f.commands.setColor(green);
    f.commands.stretchPixels(rect, uv, f.resources.picture(shader));
  };
  f.commands.setColor(red);
  f.commands.stretchPixels(rect, uv, f.resources.picture(null));
  nested(); f.commands.submit();
  const expected = f.cpu.pixels.slice();
  f.cpu.pixels.fill(0);
  const words = new DataView(new ArrayBuffer(40));
  words.setInt32(0, 27, true);
  for (const [index, value] of [0, 0, 8, 8, 0, 0, 1, 1].entries()) words.setFloat32((index + 1) * 4, value, true);
  words.setInt32(36, 0x7fffffff, true);
  let warnings = 0;
  warning = () => { warnings++; nested(); words.setFloat32(12, 0, true); };
  f.commands.setColor(red);
  expect(qvmRenderResourceSyscall("ui", words, new QvmMemory(new Uint8Array(1024)), f.resources, f.commands)).toBe(0);
  f.commands.submit();
  expect(warnings).toBe(1);
  expect(f.cpu.pixels).toEqual(expected);
});

test("QVM model failure, bounds and missing tags use actual registry results and ABI writes", async () => {
  const f = await fixture("");
  const memory = new QvmMemory(new Uint8Array(1024));
  const call = (role: "ui" | "cgame", trap: number, ...args: number[]) => {
    const words = new DataView(new ArrayBuffer((args.length + 1) * 4));
    words.setInt32(0, trap, true);
    for (const [index, arg] of args.entries()) words.setInt32((index + 1) * 4, arg, true);
    return qvmRenderResourceSyscall(role, words, memory, f.resources, f.commands);
  };
  memory.writeString(16, "missing.md3", 32);
  expect(await call("ui", 18, 16)).toBe(0);
  expect(await call("ui", 18, 0)).toBe(0);
  expect(await call("cgame", 37, 0)).toBe(0);
  expect(await call("ui", 19, 0)).toBe(0);
  expect(await call("cgame", 38, 0)).toBe(0);
  memory.span(128, 25).fill(0xa5);
  expect(call("cgame", 47, 0, 128, 140)).toBe(0);
  expect(memory.span(128, 24)).toEqual(new Uint8Array(24));
  expect(memory.bytes[152]).toBe(0xa5);
  memory.writeString(16, "tag_missing", 32);
  memory.span(256, 49).fill(0xa5);
  expect(call("cgame", 48, 256, 0, 0, 1, float32ToBits(0.5), 16)).toBe(0);
  expect(Array.from({ length: 12 }, (_, index) => memory.view(256, 48).getFloat32(index * 4, true)))
    .toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  expect(memory.bytes[304]).toBe(0xa5);
  expect(call("ui", 29, 256, 0, 0, 1, float32ToBits(0.5), 16)).toBe(0);
  expect(call("cgame", 48, 256, 0, 0, 1, float32ToBits(0.5), 0)).toBe(0);
});

test("ParseStage image failure does not register images in later shader stages", async () => {
  const { resources, reads, sampledPixel } = await fixture("broken { { map absent.tga } { clampmap shared.tga } } good { { map shared.tga } }");
  expect(await resources.registerShader("broken")).toBeNull();
  expect(reads).not.toContain("shared.tga");
  const handle = await resources.registerShader("good");
  if (handle === null) throw new Error("good registration returned source zero handle");
  const bundle = resources.picture(handle).material.finished.iterator.passes[0]?.bundles[0];
  if (bundle === undefined || !bundle.active || bundle.binding.kind !== "images") throw new Error("Missing registered fixture image");
  if (bundle.binding.playback.kind !== "single") throw new Error("Fixture image unexpectedly animates");
  expect(sampledPixel(bundle.binding.playback.image.image)).toEqual(new Uint8Array([255, 255, 255, 255]));
});

test("animMap registration stops at its first missing frame", async () => {
  const { resources, reads, sampledPixel } = await fixture("broken { { animMap 1 absent.tga shared.tga\n } } good { { clampmap shared.tga } }");
  expect(await resources.registerShader("broken")).toBeNull();
  expect(reads).not.toContain("shared.tga");
  const handle = await resources.registerShader("good");
  if (handle === null) throw new Error("good registration returned source zero handle");
  const bundle = resources.picture(handle).material.finished.iterator.passes[0]?.bundles[0];
  if (bundle === undefined || !bundle.active || bundle.binding.kind !== "images") throw new Error("Missing registered fixture image");
  if (bundle.binding.playback.kind !== "single") throw new Error("Fixture image unexpectedly animates");
  expect(sampledPixel(bundle.binding.playback.image.image)).toEqual(new Uint8Array([255, 255, 255, 255]));
});

test("failed image lookups are not retained in the source image cache", async () => {
  const { resources, files } = await fixture("broken { { map late.tga } } good { { map late.tga } }");
  expect(await resources.registerShader("broken")).toBeNull();
  files.set("late.tga", solidTga(10, 20, 30));
  expect(await resources.registerShader("good")).not.toBeNull();
});

test("failed named remaps retain only the parsed stage prefix including the failing slot", async () => {
  const { resources } = await fixture("broken { { map $whiteimage } { map absent.tga } { map shared.tga } } good { { map $whiteimage } }");
  expect(await resources.registerShader("broken")).toBeNull();
  const handle = await resources.registerShader("good");
  await resources.remapShader("good", "broken", null);
  const failed = resources.picture(handle).material.remapped;
  if (failed === null) throw new Error("Missing source cached failed remap target");
  expect(failed.finished.numUnfoggedPasses).toBe(2);
  expect(failed.finished.sourceStages).toHaveLength(2);
  expect(failed.finished.sourceStages[0]?.active).toBe(true);
  expect(failed.finished.sourceStages[1]?.active).toBe(false);
});

test("sky outer image registration owns clamp sampling for later stage reuse", async () => {
  const { resources, files, sampledPixel } = await fixture("sky { skyParms env 512 - } image { { map env_rt.tga } }");
  files.set("env_rt.tga", solidTga(10, 20, 30));
  expect(await resources.registerShader("sky")).not.toBeNull();
  const handle = await resources.registerShader("image");
  if (handle === null) throw new Error("image registration returned source zero handle");
  const bundle = resources.picture(handle).material.finished.iterator.passes[0]?.bundles[0];
  if (bundle === undefined || !bundle.active || bundle.binding.kind !== "images") throw new Error("Missing registered sky image");
  if (bundle.binding.playback.kind !== "single") throw new Error("Fixture image unexpectedly animates");
  expect(sampledPixel(bundle.binding.playback.image.image)).toEqual(new Uint8Array([255, 255, 255, 255]));
});

test("a cached text-rejected shader retains its completed image pass when used by a remap", async () => {
  const { resources, reads, commands, cpu, recording } = await fixture("partial { { map shared.tga rgbGen identity } unknownDirective } good { { map $whiteimage } }");
  expect(await resources.registerShader("partial")).toBeNull();
  expect(reads).toContain("shared.tga");
  const good = await resources.registerShader("good");
  await resources.remapShader("good", "partial", null);
  const remapped = resources.picture(good).material.remapped;
  expect(remapped?.defaulted).toBe(true);
  expect(remapped?.finished.numUnfoggedPasses).toBe(1);
  expect(remapped?.finished.sourceStages[0]?.active).toBe(true);
  const draw = commands.draw2D("pixels");
  draw.drawPic({ x: 0, y: 0, width: 8, height: 8 }, resources.picture(good));
  commands.submitFrame();
  const executed = recording.trace().flatMap(view => view.batches).at(-1);
  if (executed === undefined || executed.texture.kind !== "bind-image") throw new Error("Missing remapped fixture draw");
  const retained = remapped?.finished.iterator.passes[0]?.bundles[0];
  if (retained === undefined || !retained.active || retained.binding.kind !== "images" || retained.binding.playback.kind !== "single") {
    throw new Error("Missing retained rejected-prefix image");
  }
  expect(executed.texture.image).toBe(retained.binding.playback.image.image);
  expect(cpu.pixels.slice((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4)).toEqual(new Uint8Array([255, 255, 255, 255]));
});

test("production registration keeps first-definition precedence even when one duplicate is rejected", async () => {
  const acceptedFirst = await fixture("duplicate { { map shared.tga } } duplicate { unknownDirective }");
  expect(await acceptedFirst.resources.registerShader("duplicate")).not.toBeNull();
  expect(acceptedFirst.reads).toContain("shared.tga");
  const rejectedFirst = await fixture("duplicate { unknownDirective } duplicate { { map shared.tga } }");
  expect(await rejectedFirst.resources.registerShader("duplicate")).toBeNull();
  expect(rejectedFirst.reads).not.toContain("shared.tga");
});

test("overwritten image directives keep their original registration and sampler ownership", async () => {
  const { resources, files, reads, sampledPixel } = await fixture("ordered { { clampmap shared.tga map other.tga } } reuse { { map shared.tga } }");
  files.set("other.tga", solidTga(8, 16, 24));
  expect(await resources.registerShader("ordered")).not.toBeNull();
  expect(reads.filter(path => path.endsWith(".tga"))).toEqual(["shared.tga", "other.tga"]);
  const reuse = await resources.registerShader("reuse");
  const bundle = resources.picture(reuse).material.finished.iterator.passes[0]?.bundles[0];
  if (bundle === undefined || !bundle.active || bundle.binding.kind !== "images" || bundle.binding.playback.kind !== "single") throw new Error("Missing single image fixture binding");
  expect(sampledPixel(bundle.binding.playback.image.image)).toEqual(new Uint8Array([32, 16, 8, 255]));
  expect(reads.filter(path => path === "shared.tga")).toHaveLength(1);
});

test("sky faces register outer then inner in source order before a later stage image", async () => {
  const { resources, files, reads, sampledPixel } = await fixture("sky { skyParms outer 512 inner { map shared.tga } }");
  const suffixes = ["rt", "bk", "lf", "ft", "up", "dn"];
  for (const box of ["outer", "inner"]) for (const suffix of suffixes) files.set(`${box}_${suffix}.tga`, solidTga(10, 20, 30));
  const sky = await resources.registerShader("sky");
  expect(sky).not.toBeNull();
  expect(reads.filter(path => path.endsWith(".tga"))).toEqual([
    ...suffixes.map(suffix => `outer_${suffix}.tga`), ...suffixes.map(suffix => `inner_${suffix}.tga`), "shared.tga",
  ]);
  const registered = resources.picture(sky).material.sky;
  const outer = registered?.outer?.image("rt"), inner = registered?.inner?.image("rt");
  if (outer === undefined || inner === undefined) throw new Error("Missing registered sky boxes");
  expect(sampledPixel(outer.image)).toEqual(new Uint8Array([3, 5, 8, 255]));
  expect(sampledPixel(inner.image)).toEqual(new Uint8Array([10, 20, 30, 255]));
});
