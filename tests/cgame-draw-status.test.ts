import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { ClientDrawStatus } from "../src/cgame/draw-status.ts";
import type { ClientDrawStatusCvar, ClientDrawStatusHost } from "../src/cgame/draw-status.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { ClientCommandHistory } from "../src/cgame/prediction.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { PictureAsset } from "../src/render/draw2d.ts";
import type { FontSet, RegisteredFont, RegisteredGlyph } from "../src/render/font.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { RendererResources } from "../src/render/world.ts";
import type { Product } from "../src/shared/definitions.ts";
import { Weapon } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { pictureQuads } from "./picture-quads-fixture.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
type ObservedTools = ClientDrawTools & { readonly commands: RenderCommandBuffer; readonly recording: BatchRecordingBackend; readonly cpu: SoftwareRenderer };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });


const image = new Uint8Array(22);
image[2] = 2; image[12] = 1; image[14] = 1; image[16] = 32; image[17] = 0x20; image.fill(255, 18);
const assets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ list: () => [], has: path => path.endsWith(".tga"), read: async () => image, readSync: () => image,
  readFileLength: path => path.endsWith(".tga") ? image.byteLength : -1,
  readFileOptional: async path => path.endsWith(".tga") ? image : undefined,
  readFileOptionalSync: path => path.endsWith(".tga") ? image : undefined });

function command(serverTime: number): UserCommand {
  return { serverTime, angles: { x: 0, y: 0, z: 0 }, buttons: 0, weapon: Weapon.WP_NONE, forwardmove: 0, rightmove: 0, upmove: 0 };
}

function commandHistory(oldestTime: number): ClientCommandHistory {
  const history = new ClientCommandHistory();
  history.append(command(oldestTime));
  for (let index = 1; index < 64; index++) history.append(command(0));
  return history;
}

function font(picture: PictureAsset): FontSet {
  const glyphs: RegisteredGlyph[] = Array.from({ length: 256 }, (_, index) => ({
    height: 12, top: 10, bottom: 2, pitch: 0, xSkip: index === 32 ? 4 : 8,
    imageWidth: index === 32 ? 0 : 8, imageHeight: index === 32 ? 0 : 12,
    s: 0, t: 0, s2: 1, t2: 1, shaderName: "fixture", picture: index === 32 ? null : picture,
  }));
  const registered: RegisteredFont = { name: "fixture", glyphScale: 1, glyphs };
  return { small: registered, normal: registered, big: registered, profile: "cgame", smallThreshold: 0.25, bigThreshold: 0.4 };
}

async function fixture(product: Product, width = 640, height = 480, oldestCommandTime = 0, fontPicture: "registered" | "zero" = "registered") {
  const staticState = new ClientGameStaticState(product), state = new ClientGameState(product, 0, 0);
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.time };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const settings = createRendererSettings();
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { cinematics.dispose(); } } });
  const soundDebugMessages: string[] = [];
  const bank = new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => undefined });
  const media = new ClientMedia(product, staticState, resources, bank), shader = await resources.registerShaderNoMip("fixture.tga");
  if (shader === null) throw new Error("Ordinary status font fixture must register its actual image");
  media.graphics.whiteShader = shader; media.graphics.charsetShader = shader;
  media.graphics.lagometerShader = shader; media.graphics.connectionShader = shader;
  const tools: ObservedTools = Object.assign(new ClientDrawTools(commands.draw2D("stretch-640"), media), { commands, recording, cpu });
  const cvars = new CvarRegistry();
  cvars.register("cg_centertime", "3"); cvars.register("cg_lagometer", "1");
  cvars.register("cg_nopredict", "0"); cvars.register("g_synchronousClients", "0");
  const reads: ClientDrawStatusCvar[] = [];
  const host: ClientDrawStatusHost = {
    commands: commandHistory(oldestCommandTime),
    readVmCvar: name => {
      reads.push(name);
      const value = cvars.get(name);
      if (value === undefined) throw new Error(`Missing fixture cvar ${name}`);
      return value;
    },
  };
  const status = product === "baseq3"
    ? new ClientDrawStatus(state, staticState, tools, { kind: "baseq3" }, host)
    : new ClientDrawStatus(state, staticState, tools, { kind: "missionpack", fonts: font(resources.picture(fontPicture === "zero" ? null : shader)) }, host);
  return { state, staticState, tools, cvars, reads, status, resources };
}

function batch(tools: ObservedTools, index: number): DrawBatch {
  const value = pictureQuads(tools.recording.trace().flatMap(view => view.batches))[index];
  if (value === undefined) throw new RangeError(`Missing draw batch ${index}`);
  return value;
}

function rect(tools: ObservedTools, index: number): readonly number[] {
  const vertices = batch(tools, index).vertices, first = vertices[0], opposite = vertices[2];
  if (first === undefined || opposite === undefined) throw new Error("Rectangle batch has missing vertices");
  return [(first.position.x + 1) * tools.draw.width / 2, (1 - first.position.y) * tools.draw.height / 2,
    (opposite.position.x - first.position.x) * tools.draw.width / 2,
    (first.position.y - opposite.position.y) * tools.draw.height / 2];
}

function expectRect(tools: ObservedTools, index: number, expected: readonly number[]): void {
  for (const [component, value] of rect(tools, index).entries()) {
    const wanted = expected[component];
    if (wanted === undefined) throw new Error("Missing expected rectangle component");
    expect(value).toBeCloseTo(wanted, 3);
  }
}

function activateSnapshot(state: ClientGameState, commandTime: number): void {
  const playerState = createPlayerState(state.product); playerState.commandTime = commandTime;
  state.snap = { messageNumber: 1, serverTime: state.time, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState, entities: [] };
}

describe("cg_draw center printing", () => {
  test("CG_CenterPrint copies source bytes, stops at NUL, caps 1023 bytes and counts copied lines", async () => {
    const first = await fixture("baseq3"); first.state.time = 25;
    first.status.centerPrint(`one\ntwo\0ignored`, 143, 16);
    expect([first.state.centerPrint, first.state.centerPrintTime, first.state.centerPrintY,
      first.state.centerPrintCharWidth, first.state.centerPrintLines]).toEqual(["one\ntwo", 25, 143, 16, 2]);
    first.status.centerPrint(`${"x".repeat(1022)}\ntruncated`, -2147483649, 2147483648);
    expect(first.state.centerPrint).toHaveLength(1023); expect(first.state.centerPrint.endsWith("\n")).toBe(true);
    expect(first.state.centerPrintLines).toBe(2); expect(first.state.centerPrintY).toBe(2147483647);
    expect(first.state.centerPrintCharWidth).toBe(-2147483648);
    expect(() => first.status.centerPrint("bad\u0100", 0, 0)).toThrow("source byte");
  });

  test("base CG_DrawCenterString centers lines, truncates each source line at 50 and uses the 200ms fade", async () => {
    const f = await fixture("baseq3"); f.state.time = 100; f.status.centerPrint("AB\nC", 100, 16); f.status.drawCenterString();
    f.tools.commands.submitFrame();
    expect(pictureQuads(f.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(6);
    expectRect(f.tools, 0, [306, 86, 16, 24]); expectRect(f.tools, 2, [304, 84, 16, 24]);
    expectRect(f.tools, 4, [314, 110, 16, 24]);
    const long = await fixture("baseq3"); long.state.time = 100; long.status.centerPrint("A".repeat(51), 100, 8); long.status.drawCenterString();
    long.tools.commands.submitFrame();
    expect(pictureQuads(long.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(100);
    const faded = await fixture("baseq3"); faded.cvars.set("cg_centertime", "1"); faded.state.time = 100;
    faded.status.centerPrint("A", 100, 16); faded.state.time = 1000; faded.status.drawCenterString();
    faded.tools.commands.submitFrame();
    expect(batch(faded.tools, 1).vertices[0]?.color.w).toBe(127 / 255);
    const expired = await fixture("baseq3"); expired.cvars.set("cg_centertime", "1"); expired.state.time = 100;
    expired.status.centerPrint("A", 100, 16); expired.state.time = 1100; expired.status.drawCenterString();
    expired.tools.commands.submitFrame();
    expect(pictureQuads(expired.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(0);
  });

  test("time zero remains the source no-center-print sentinel", async () => {
    const f = await fixture("baseq3"); f.status.centerPrint("not drawn", 100, 16); f.state.time = 1; f.status.drawCenterString();
    f.tools.commands.submitFrame();
    expect(pictureQuads(f.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(0); expect(f.reads).toEqual([]);
  });

  test("missionpack uses cgame font metrics, baseline and shadowed-more style", async () => {
    const f = await fixture("missionpack"); f.state.time = 100; f.status.centerPrint("AB", 100, 64); f.status.drawCenterString();
    f.tools.commands.submitFrame();
    expect(pictureQuads(f.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(4);
    expectRect(f.tools, 0, [318, 95, 4, 6]); expectRect(f.tools, 1, [316, 93, 4, 6]);
    expectRect(f.tools, 2, [322, 95, 4, 6]); expectRect(f.tools, 3, [320, 93, 4, 6]);
    expect(batch(f.tools, 0).vertices[0]?.color).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(batch(f.tools, 1).vertices[0]?.color).toEqual({ x: 1, y: 1, z: 1, w: 1 });
  });

  test("missionpack zero font handles retain the global default material instead of ordinary font modulation", async () => {
    const f = await fixture("missionpack", 640, 480, 0, "zero");
    f.state.time = 100; f.status.centerPrint("A", 100, 64); f.status.drawCenterString();
    f.tools.commands.submitFrame();
    const quads = pictureQuads(f.tools.recording.trace().flatMap(view => view.batches));
    expect(quads).toHaveLength(2);
    expect(quads.every(quad => quad.texture.kind === "bind-image" && quad.texture.image === f.resources.picture(null).material.image)).toBe(true);
    expect(quads.every(quad => quad.vertices.every(vertex => vertex.color.x === 1 && vertex.color.y === 1 && vertex.color.z === 1))).toBe(true);
  });
});

describe("cg_draw lagometer and disconnect", () => {
  test("frame, extrapolation, normal/rate-delayed pings and drops produce exact graph rectangles and colors", async () => {
    const f = await fixture("baseq3"); activateSnapshot(f.state, 1000);
    f.state.time = 200; f.state.latestSnapshotTime = 100; f.status.addLagometerFrameInfo();
    f.state.time = 50; f.state.latestSnapshotTime = 100; f.status.addLagometerFrameInfo();
    f.status.addLagometerSnapshotInfo({ ping: 450, flags: 0 });
    f.status.addLagometerSnapshotInfo({ ping: 900, flags: 1 });
    f.status.addLagometerSnapshotInfo(null); await f.status.drawLagometer();
    f.tools.commands.submitFrame();
    expect(pictureQuads(f.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(6);
    expectRect(f.tools, 0, [592, 432, 48, 48]);
    expectRect(f.tools, 1, [640, 448, 1, 8 / 3]);
    expectRect(f.tools, 2, [639, 1328 / 3, 1, 16 / 3]);
    expectRect(f.tools, 3, [640, 456, 1, 24]);
    expectRect(f.tools, 4, [639, 456, 1, 24]);
    expectRect(f.tools, 5, [638, 468, 1, 12]);
    expect(batch(f.tools, 1).vertices[0]?.color).toEqual({ x: 0, y: 0, z: 1, w: 1 });
    expect(batch(f.tools, 2).vertices[0]?.color).toEqual({ x: 1, y: 1, z: 0, w: 1 });
    expect(batch(f.tools, 3).vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 1 });
    expect(batch(f.tools, 4).vertices[0]?.color).toEqual({ x: 1, y: 1, z: 0, w: 1 });
    expect(batch(f.tools, 5).vertices[0]?.color).toEqual({ x: 0, y: 1, z: 0, w: 1 });
  });

  test("missionpack graph uses the source elevated position and scaled physical columns", async () => {
    const f = await fixture("missionpack", 1280, 720); activateSnapshot(f.state, 1000);
    f.state.time = 300; f.state.latestSnapshotTime = 0; f.status.addLagometerFrameInfo(); await f.status.drawLagometer();
    f.tools.commands.submitFrame();
    expectRect(f.tools, 0, [1184, 504, 96, 72]);
    expectRect(f.tools, 1, [1280, 504, 1, 24]);
  });

  test("disabled and local-server paths skip the graph but retain disconnect and cvar order", async () => {
    const disabled = await fixture("baseq3", 640, 480, 500); disabled.state.time = 1024; activateSnapshot(disabled.state, 100);
    disabled.cvars.set("cg_lagometer", "0"); await disabled.status.drawLagometer();
    disabled.tools.commands.submitFrame();
    expect(disabled.reads).toEqual(["cg_lagometer"]); expectRect(disabled.tools, pictureQuads(disabled.tools.recording.trace().flatMap(view => view.batches)).length - 1, [592, 432, 48, 48]);
    const local = await fixture("baseq3", 640, 480, 500); local.state.time = 1024; activateSnapshot(local.state, 100);
    local.staticState.localServer = 2; await local.status.drawLagometer();
    local.tools.commands.submitFrame();
    expect(local.reads).toEqual(["cg_lagometer"]); expectRect(local.tools, pictureQuads(local.tools.recording.trace().flatMap(view => view.batches)).length - 1, [592, 432, 48, 48]);
  });

  test("snc warning uses registered cvar names and source short-circuit order", async () => {
    const f = await fixture("baseq3"); activateSnapshot(f.state, 0); f.cvars.set("cg_nopredict", "1"); await f.status.drawLagometer();
    expect(f.reads).toEqual(["cg_lagometer", "cg_nopredict"]);
    f.tools.commands.submitFrame();
    expect(pictureQuads(f.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(7); expectRect(f.tools, 1, [594, 434, 16, 16]);
    const synchronous = await fixture("baseq3"); activateSnapshot(synchronous.state, 0); synchronous.cvars.set("g_synchronousClients", "1");
    await synchronous.status.drawLagometer();
    expect(synchronous.reads).toEqual(["cg_lagometer", "cg_nopredict", "g_synchronousClients"]);
  });

  test("disconnect command boundaries and blink preserve source ordering", async () => {
    const visible = await fixture("baseq3", 640, 480, 500); visible.state.time = 1024; activateSnapshot(visible.state, 100); await visible.status.drawDisconnect();
    visible.tools.commands.submitFrame();
    expectRect(visible.tools, pictureQuads(visible.tools.recording.trace().flatMap(view => view.batches)).length - 1, [592, 432, 48, 48]);
    const icon = pictureQuads(visible.tools.recording.trace().flatMap(view => view.batches)).at(-1);
    if (icon?.texture.kind !== "bind-image") throw new Error("Disconnect icon must bind its registered source image");
    expect(icon.texture.image.name).toBe("gfx/2d/net.tga");
    const blink = await fixture("baseq3", 640, 480, 500); blink.state.time = 512; activateSnapshot(blink.state, 100); await blink.status.drawDisconnect();
    blink.tools.commands.submitFrame();
    expect(pictureQuads(blink.tools.recording.trace().flatMap(view => view.batches)).length).toBe(42);
    const acknowledged = await fixture("baseq3", 640, 480, 100); acknowledged.state.time = 1024; activateSnapshot(acknowledged.state, 100);
    await acknowledged.status.drawDisconnect(); acknowledged.tools.commands.submitFrame(); expect(pictureQuads(acknowledged.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(0);
    const future = await fixture("baseq3", 640, 480, 1025); future.state.time = 1024; activateSnapshot(future.state, 100);
    await future.status.drawDisconnect(); future.tools.commands.submitFrame(); expect(pictureQuads(future.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(0);
  });

  test("recorded status batches execute through the CPU renderer", async () => {
    const f = await fixture("baseq3"); activateSnapshot(f.state, 1000); f.state.time = 100; f.state.latestSnapshotTime = 0;
    f.status.addLagometerFrameInfo(); await f.status.drawLagometer();
    f.tools.commands.submitFrame();
    const renderer = f.tools.cpu;
    let lit = 0;
    for (let index = 0; index < renderer.pixels.length; index += 4) {
      const red = renderer.pixels[index], alpha = renderer.pixels[index + 3];
      if (red === undefined || alpha === undefined) throw new Error("CPU framebuffer row is truncated");
      if (red !== 0 || alpha !== 0) lit++;
    }
    expect(lit).toBeGreaterThan(1000);
  });
});
