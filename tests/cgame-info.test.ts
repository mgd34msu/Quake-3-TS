import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { ClientLoadingScreen } from "../src/cgame/info.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientMedia, registerClientLoadingGraphics } from "../src/cgame/media.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { UI_CENTER, UI_SMALLFONT, UI_DROPSHADOW } from "../src/render/font.ts";
import { RendererResources } from "../src/render/world.ts";
import type { SingleTextureBatch } from "../src/render/types.ts";
import { GameType } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { createHash } from "node:crypto";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { pictureQuads } from "./picture-quads-fixture.ts";

import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const WHITE = { x: 1, y: 1, z: 1, w: 1 };
function expectSamePictures(actual: readonly SingleTextureBatch[], expected: readonly SingleTextureBatch[]): void {
  expect(actual).toEqual(expected);
  for (const [index, picture] of actual.entries()) {
    const reference = expected[index];
    if (reference === undefined || picture.texture.kind !== "bind-image" || reference.texture.kind !== "bind-image") throw new Error("Expected matching static loading-screen pictures");
    expect(picture.texture.image).toBe(reference.texture.image);
  }
}
function sourceImage(): Uint8Array {
  const image = new Uint8Array(22); image[2] = 2; image[12] = 1; image[14] = 1; image[16] = 32; image[17] = 0x20; image.fill(255, 18); return image;
}
async function capture(path: string, pixels: Uint8Array): Promise<void> {
  const image = new Uint8Array(18 + pixels.length), header = new DataView(image.buffer);
  image[2] = 2; header.setUint16(12, 640, true); header.setUint16(14, 480, true); image[16] = 32; image[17] = 0x28;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (r === undefined || g === undefined || b === undefined || a === undefined) throw new Error("Missing capture pixel");
    image.set([b, g, r, a], 18 + i);
  }
  await Bun.write(path, image);
}
async function fixture(product: Product = "baseq3", extra: readonly string[] = [], update: () => Promise<void> = () => Promise.resolve(), width = 640, height = 480) {
  const paths = new Set(["gfx/2d/bigchars.tga", "menu/art/font1_prop.tga", "menu/art/font1_prop_glo.tga", "menu/art/font2_prop.tga",
    "levelshots/fixture.tga", "menu/art/unknownmap.tga", "detail.tga", ...extra]);
  const script = new TextEncoder().encode("levelShotDetail { { map detail.tga blendFunc GL_DST_COLOR GL_SRC_COLOR rgbGen identity } }");
  function readAsset(path: string): Uint8Array {
    if (path === "scripts/fixture.shader") return script;
    if (paths.has(path)) return sourceImage();
    throw new Error(`Unexpected read ${path}`);
  }
  const assets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ list: () => ["scripts/fixture.shader"], has: path => paths.has(path) || path === "scripts/fixture.shader",
    read: async (path): Promise<Uint8Array> => readAsset(path), readSync: readAsset,
    readFileLength(path) { return this.has(path) ? readAsset(path).byteLength : -1; },
    async readFileOptional(path) { return this.has(path) ? readAsset(path) : undefined; },
    readFileOptionalSync(path) { return this.has(path) ? readAsset(path) : undefined; } });
  const state = new ClientGameState(product, 0, 0);
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.time };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const settings = createRendererSettings();
  const actual = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics }), calls: string[] = [];
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: actual.tess, runtime: settings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { cinematics.dispose(); } } });
  const resources: RendererResources = { ...actual,
    registerShader: path => { calls.push(`shader:${path}`); return actual.registerShader(path); },
    registerShaderNoMip: path => { calls.push(`nomip:${path}`); return actual.registerShaderNoMip(path); },
  };
  const cvars = new CvarRegistry(), staticState = new ClientGameStaticState(product);
  const soundDebugMessages: string[] = [];
  const bank = new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => {} }), registerSound = bank.registerSound.bind(bank);
  bank.registerSound = (path, compressed) => { calls.push(`sound:${path}:${compressed}`); return registerSound(path, compressed); };
  const media = new ClientMedia(product, staticState, resources, bank);
  await registerClientLoadingGraphics(media); calls.length = 0;
  const config = new Map<number, string>([[0, "\\mapname\\fixture\\sv_hostname\\^1Host"], [1, ""]]);
  const screen = new ClientLoadingScreen(state, media, cvars, { configString: index => config.get(index) ?? "",
    updateScreen: async () => { calls.push(`screen:${state.infoScreenText}`); await update(); } });
  return { screen, state, staticState, media, resources, cvars, config, calls, commands, recording, cpu };
}

test("loading item registration precedes bounded text and awaited UpdateScreen", async () => {
  const resolvers: (() => void)[] = [];
  const value = await fixture("baseq3", ["icons/iconr_shard.tga"], () => new Promise<void>(resolve => resolvers.push(resolve)));
  let complete = false;
  const work = value.screen.loadingItem(1).then(() => { complete = true; });
  while (resolvers.length === 0) await Promise.resolve();
  expect(complete).toBe(false); expect(value.calls).toEqual(["nomip:icons/iconr_shard", "screen:Armor Shard"]);
  const resolve = resolvers.shift(); if (resolve === undefined) throw new Error("Missing deferred update"); resolve(); await work;
  const textWork = value.screen.loadingString("x".repeat(1050));
  expect(value.state.infoScreenText).toHaveLength(1023);
  const textResolve = resolvers.shift(); if (textResolve === undefined) throw new Error("Missing deferred text update"); textResolve(); await textWork;
  await expect(value.screen.loadingItem(0)).rejects.toThrow("named item");
  await expect(value.screen.loadingString("^\u0100")).rejects.toThrow("byte characters");
});

test("loading client uses last model slash, all three source fallbacks and cleaned single-player announcer", async () => {
  const value = await fixture("baseq3", ["models/players/sarge/icon_default.tga"]);
  value.staticState.gameType = GameType.GT_SINGLE_PLAYER;
  value.config.set(546, "\\model\\custom/nested/red\\n\\^1Name\u0080\t!");
  await value.screen.loadingClient(2);
  expect(value.calls).toEqual(["nomip:models/players/custom/nested/icon_red.tga", "nomip:models/players/characters/custom/nested/icon_red.tga",
    "nomip:models/players/sarge/icon_default.tga", "sound:sound/player/announce/Name!.wav:true", "screen:Name!"]);
  value.calls.length = 0; value.config.set(546, "\\model\\sarge\\n\\^2Player");
  await value.screen.loadingClient(2);
  expect(value.calls).toEqual(["nomip:models/players/sarge/icon_default.tga", "sound:sound/player/announce/Player.wav:true", "screen:Player"]);
  await expect(value.screen.loadingClient(64)).rejects.toThrow("bad client");
});

test("icon registration caps distinguish failed items from failed player attempts", async () => {
  const value = await fixture(); value.config.set(544, "\\model\\missing\\n\\Nobody");
  for (let i = 0; i < 30; i++) await value.screen.loadingItem(1);
  expect(value.calls.filter(call => call.startsWith("nomip:"))).toHaveLength(26);
  expect(value.calls.filter(call => call.startsWith("screen:"))).toHaveLength(30);
  value.calls.length = 0;
  for (let i = 0; i < 17; i++) await value.screen.loadingClient(0);
  expect(value.calls.filter(call => call.startsWith("nomip:"))).toHaveLength(51);
  const draw = value.commands.draw2D("stretch-640"); await value.screen.drawInformation(draw); value.commands.submit();
  // A missing item still draws the source handle-zero default picture in both rows.
  const lastIcon = pictureQuads(value.recording.trace().flatMap(view => view.batches))[27]?.vertices[0]; if (lastIcon === undefined) throw new Error("Missing 26th loading icon");
  expect((lastIcon.position.x + 1) * 320).toBeCloseTo(592, 3);
  expect((1 - lastIcon.position.y) * 240).toBeCloseTo(400, 3);
});

test("successful player icon cap stays at 16 while loading text continues, including source offscreen slots", async () => {
  const value = await fixture("baseq3", ["models/players/sarge/icon_default.tga"]);
  value.config.set(544, "\\model\\sarge/default\\n\\Sarge");
  for (let i = 0; i < 18; i++) await value.screen.loadingClient(0);
  expect(value.calls.filter(call => call.startsWith("nomip:"))).toHaveLength(16);
  expect(value.calls.filter(call => call.startsWith("screen:"))).toHaveLength(18);
  const draw = value.commands.draw2D("stretch-640"); await value.screen.drawInformation(draw); value.commands.submit();
  const last = pictureQuads(value.recording.trace().flatMap(view => view.batches))[17]?.vertices[0]; if (last === undefined) throw new Error("Missing 16th source icon");
  expect((last.position.x + 1) * 320).toBeCloseTo(1186, 3);
  expect((1 - last.position.y) * 240).toBeCloseTo(284, 3);
});

test("loading names and model paths use source byte limits before cleaning and splitting", async () => {
  const value = await fixture();
  value.config.set(544, `\\model\\${"x".repeat(80)}/red\\n\\${"A".repeat(62)}^1Z`);
  await value.screen.loadingClient(0);
  expect(value.calls[0]).toBe(`nomip:${("models/players/" + "x".repeat(63) + "/icon_default.tga").slice(0, 63)}`);
  expect(value.state.infoScreenText).toBe("A".repeat(62) + "^");
  await value.screen.loadingString("First\0Second"); expect(value.state.infoScreenText).toBe("First");
});

test("DrawInformation emits source remote server lines, y spacing, detail UV and FFA limit selection", async () => {
  const value = await fixture("baseq3", [], undefined, 1280, 720);
  value.config.set(0, "\\mapname\\absent\\sv_hostname\\^1Host\\timelimit\\ 20junk\\fraglimit\\-5\\capturelimit\\9");
  value.config.set(1, "\\sv_pure\\10\\sv_cheats\\1"); value.config.set(3, "Map Title"); value.config.set(4, "Welcome");
  value.state.infoScreenText = "world";
  const draw = value.commands.draw2D("stretch-640"); await value.screen.drawInformation(draw); value.commands.submit();
  expect(value.calls).toEqual(["nomip:levelshots/absent.tga", "nomip:menu/art/unknownmap", "shader:levelShotDetail"]);
  expect(pictureQuads(value.recording.trace().flatMap(view => view.batches))[1]?.vertices[2]?.texCoord).toEqual({ x: 2.5, y: 2 });
  const actual = pictureQuads(value.recording.trace().flatMap(view => view.batches)).slice(2), count = value.recording.trace().flatMap(view => view.batches).length;
  const tools = new ClientDrawTools(draw, value.media);
  const lines: readonly (readonly [number, string])[] = [[96, "Loading... world"], [148, "Host"], [175, "Pure Server"], [202, "Welcome"],
    [239, "Map Title"], [266, "CHEATS ARE ENABLED"], [293, "Free For All"], [320, "timelimit 20"], [347, "fraglimit -5"]];
  for (const [y, text] of lines) tools.drawProportionalString({ x: 320, y, text, color: WHITE, style: UI_CENTER | UI_SMALLFONT | UI_DROPSHADOW, time: 0 });
  value.commands.submit();
  expectSamePictures(actual, pictureQuads(value.recording.trace().flatMap(view => view.batches).slice(count)));
});

test("local server suppresses hostname/pure/MOTD and Team Arena uses product labels and capturelimit", async () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const value = await fixture(product); value.cvars.register("sv_running", "1"); value.staticState.gameType = GameType.GT_OBELISK;
    value.config.set(0, "\\mapname\\fixture\\sv_hostname\\Host\\fraglimit\\5\\capturelimit\\8");
    value.config.set(1, "\\sv_pure\\1"); value.config.set(4, "hidden");
    const draw = value.commands.draw2D("stretch-640"); await value.screen.drawInformation(draw); value.commands.submit();
    const actual = pictureQuads(value.recording.trace().flatMap(view => view.batches)).slice(2), count = value.recording.trace().flatMap(view => view.batches).length;
    const tools = new ClientDrawTools(draw, value.media);
    for (const [y, text] of [[96, "Awaiting snapshot..."], [148, product === "missionpack" ? "Overload" : "Unknown Gametype"], [175, "capturelimit 8"]] satisfies readonly (readonly [number, string])[]) {
      tools.drawProportionalString({ x: 320, y, text, color: WHITE, style: UI_CENTER | UI_SMALLFONT | UI_DROPSHADOW, time: 0 });
    }
    value.commands.submit();
    expectSamePictures(actual, pictureQuads(value.recording.trace().flatMap(view => view.batches).slice(count)));
  }
});

test.skipIf(process.env["Q3_DATA"] === undefined)("retail baseq3 and Team Arena loading screens", async () => {
  const dataPath = process.env["Q3_DATA"]; if (dataPath === undefined) throw new Error("Missing retail data path");
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const images = new RendererImageCatalog();
    const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: `Cgame loading ${product}`, width: 640, height: 480, backend: "gl", hidden: true }) : null;
    const gl = window === null ? null : new GlRenderer(window, images);
    const settings = createRendererSettings();
    gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const cpu = new SoftwareRenderer(640, 480, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
    const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]), builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 0 };
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
    const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    cleanup.push(() => { try { commands.close("require-empty"); } finally { try { target.close(); } finally { try { cinematics.dispose(); } finally { window?.close(); } } } });
    const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
    staticState.gameType = product === "baseq3" ? GameType.GT_FFA : GameType.GT_CTF;
    const soundDebugMessages: string[] = [];
    const bank = new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => {} }), media = new ClientMedia(product, staticState, resources, bank);
    await registerClientLoadingGraphics(media);
    const map = product === "baseq3" ? "q3dm1" : "mpteam1";
    const bsp = parseBsp(await assets.read(`maps/${map}.bsp`));
    const worldspawn = bsp.entityRecords.find(entity => entity.get("classname") === "worldspawn");
    const mapMessage = worldspawn?.get("message");
    if (mapMessage === undefined) throw new Error("Retail worldspawn requires its actual map message");
    const config = new Map<number, string>([[0, `\\mapname\\${map}\\sv_hostname\\Quake III Arena\\fraglimit\\20\\capturelimit\\8`], [1, "\\sv_pure\\1"],
      [3, mapMessage], [544, "\\model\\sarge/default\\n\\Sarge"]]);
    const screen = new ClientLoadingScreen(state, media, new CvarRegistry(), { configString: index => config.get(index) ?? "", updateScreen: async () => {} });
    await screen.loadingClient(0); for (const item of [1, 2, 9, 10]) await screen.loadingItem(item);
    commands.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 1 } }, operations: [{ kind: "draw", batches: [] }] });
    const draw = commands.draw2D("stretch-640"); await screen.drawInformation(draw); commands.submit();
    expect(cpu.pixels.some(value => value !== 0 && value !== 255)).toBe(true);
    const output = process.env["QUAKE_LOADING_CAPTURE"];
    if (output !== undefined) await capture(`${output}.${product}.cpu.tga`, cpu.pixels);
    if (gl !== null) {
      const gpu = gl.readPixels(); let total = 0, maximum = 0;
      if (output !== undefined) await capture(`${output}.${product}.gl.tga`, gpu);
      for (const [index, value] of cpu.pixels.entries()) { const other = gpu[index]; if (other === undefined) throw new Error("Missing GL pixel"); const difference = Math.abs(value - other); total += difference; maximum = Math.max(maximum, difference); }
      process.stdout.write(`${product} loading CPU ${createHash("sha256").update(cpu.pixels).digest("hex")} GL ${createHash("sha256").update(gpu).digest("hex")} subpixelBits ${gl.subpixelBits} mean ${total / gpu.length} max ${maximum}\n`);
      expect(total / gpu.length).toBeLessThan(0.25); expect(maximum).toBeLessThanOrEqual(4);
    }
  }
}, 120000);
