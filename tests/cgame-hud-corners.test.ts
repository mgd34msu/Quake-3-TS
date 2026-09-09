import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { ClientDrawIcons } from "../src/cgame/draw-icons.ts";
import { ClientHudCorners } from "../src/cgame/hud-corners.ts";
import type { ClientHudCornerCvar, ClientHudCornersHost } from "../src/cgame/hud-corners.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { RendererResources } from "../src/render/world.ts";
import type { Product } from "../src/shared/definitions.ts";
import { GameType, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import { findItemForPowerup, itemList } from "../src/shared/items.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
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

async function fixture(product: Product = "baseq3") {
  const state = new ClientGameState(product, 0, 0), staticState = new ClientGameStaticState(product);
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(640, 480, images);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.time };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const settings = createRendererSettings();
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { cinematics.dispose(); } } });
  const soundDebugMessages: string[] = [];
  const media = new ClientMedia(product, staticState, resources, new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => undefined }));
  const shader = await resources.registerShaderNoMip("fixture.tga");
  media.graphics.whiteShader = shader; media.graphics.charsetShader = shader; media.graphics.teamStatusBar = shader;
  media.graphics.deferShader = shader; media.graphics.selectShader = shader;
  for (let index = 0; index < media.graphics.numberShaders.length; index++) media.graphics.numberShaders[index] = shader;
  for (let index = 0; index < media.graphics.redFlagShader.length; index++) {
    media.graphics.redFlagShader[index] = shader; media.graphics.blueFlagShader[index] = shader;
  }
  const tools: ObservedTools = Object.assign(new ClientDrawTools(commands.draw2D("stretch-640"), media), { commands, recording, cpu });
  const icons = new ClientDrawIcons(state, tools, () => ({ drawIcons: true, draw3dIcons: false }),
    commands);
  const cvars = new CvarRegistry();
  cvars.register("cg_drawTeamOverlay", "0"); cvars.register("cg_drawSnapshot", "0");
  cvars.register("cg_drawFPS", "0"); cvars.register("cg_drawTimer", "0"); cvars.register("cg_drawAttacker", "0");
  cvars.register("cg_teamChatHeight", "8"); cvars.register("cg_teamChatTime", "3000");
  const reads: ClientHudCornerCvar[] = [], strings = new Map<number, string>(), wallclock = { value: 0 };
  const host: ClientHudCornersHost = {
    readVmCvar: name => {
      reads.push(name);
      const value = cvars.get(name);
      if (value === undefined) throw new Error(`Missing cvar ${name}`);
      return value;
    },
    configString: index => strings.get(index) ?? "",
    milliseconds: () => wallclock.value,
  };
  const corners = new ClientHudCorners(state, staticState, icons, host);
  return { state, staticState, media, tools, icons, cvars, reads, strings, wallclock, corners };
}

function activateSnapshot(value: Awaited<ReturnType<typeof fixture>>, team = Team.TEAM_FREE): void {
  const playerState = createPlayerState(value.state.product);
  playerState.clientNum = value.state.clientNum;
  playerState.stats.set(statSchema(value.state.product).health, 100);
  playerState.persistant.set(PersistentIndex.PERS_TEAM, team);
  value.state.snap = { messageNumber: 7, serverTime: 1234, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState, entities: [] };
}

function batch(tools: ObservedTools, index: number): DrawBatch {
  const value = pictureQuads(tools.recording.trace().flatMap(view => view.batches))[index];
  if (value === undefined) throw new RangeError(`Missing draw batch ${index}`);
  return value;
}

function rect(tools: ObservedTools, index: number): readonly number[] {
  const vertices = batch(tools, index).vertices, first = vertices[0], opposite = vertices[2];
  if (first === undefined || opposite === undefined) throw new Error("Rectangle batch has missing vertices");
  return [(first.position.x + 1) * 320, (1 - first.position.y) * 240,
    (opposite.position.x - first.position.x) * 320, (first.position.y - opposite.position.y) * 240];
}

function expectRect(tools: ObservedTools, index: number, expected: readonly number[]): void {
  for (const [component, actual] of rect(tools, index).entries()) {
    const wanted = expected[component];
    if (wanted === undefined) throw new Error("Missing expected rectangle component");
    expect(actual).toBeCloseTo(wanted, 3);
  }
}

function setCvar(value: Awaited<ReturnType<typeof fixture>>, name: ClientHudCornerCvar, setting: string): void {
  value.cvars.set(name, setting, true);
}

describe("cg_draw corner fields and upper stack", () => {
  test("CG_DrawField applies source width clamps and right alignment", async () => {
    const value = await fixture();
    value.corners.drawField(100, 20, 2, -15);
    value.tools.commands.submitFrame();
    expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(2);
    expectRect(value.tools, 0, [102, 20, 32, 48]);
    expectRect(value.tools, 1, [134, 20, 32, 48]);

    const wide = await fixture();
    wide.corners.drawField(0, 0, 9, 123456);
    wide.tools.commands.submitFrame();
    expect(pictureQuads(wide.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(5);
    expectRect(wide.tools, 0, [2, 0, 32, 48]);

    const empty = await fixture(); empty.corners.drawField(0, 0, 0, 1);
    empty.tools.commands.submitFrame();
    expect(pictureQuads(empty.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(0);
  });

  test("upper-right preserves source cvar order, attacker expiration, and the four-frame FPS warmup", async () => {
    const value = await fixture(); activateSnapshot(value, Team.TEAM_RED);
    value.staticState.gameType = GameType.GT_TEAM; value.staticState.serverCommandSequence = 9;
    value.state.latestSnapshotNum = 8; value.state.time = 12_345; value.staticState.levelStartTime = 345;
    setCvar(value, "cg_drawTeamOverlay", "1"); setCvar(value, "cg_drawSnapshot", "1");
    setCvar(value, "cg_drawFPS", "1"); setCvar(value, "cg_drawTimer", "1"); setCvar(value, "cg_drawAttacker", "1");
    value.wallclock.value = 100;
    await value.corners.drawUpperRight();
    expect(value.reads).toEqual(["cg_drawTeamOverlay", "cg_drawTeamOverlay", "cg_drawSnapshot", "cg_drawFPS", "cg_drawTimer", "cg_drawAttacker"]);
    value.tools.commands.submitFrame();
    expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches)).length).toBeGreaterThan(0);
    for (let index = 1; index <= 4; index++) {
      value.wallclock.value = 100 + index * 10;
      await value.corners.drawUpperRight();
    }
    value.tools.commands.submitFrame();
    expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches)).length).toBeGreaterThan(100);

    const expired = await fixture(); activateSnapshot(expired);
    expired.state.attackerTime = 1; expired.state.time = 10_002;
    expired.state.predictedPlayerState.stats.set(statSchema("baseq3").health, 100);
    expired.state.predictedPlayerState.persistant.set(PersistentIndex.PERS_ATTACKER, 1);
    setCvar(expired, "cg_drawAttacker", "1"); await expired.corners.drawUpperRight();
    expect(expired.state.attackerTime).toBe(0);
  });
});

describe("baseq3 lower corners", () => {
  test("team overlay uses source widths, row order, locations, health, weapon and powerup icons", async () => {
    const value = await fixture(); activateSnapshot(value, Team.TEAM_RED);
    value.staticState.gameType = GameType.GT_TEAM; value.state.numSortedTeamPlayers = 2;
    value.state.sortedTeamPlayers[0] = 1; value.state.sortedTeamPlayers[1] = 2;
    const first = value.staticState.clientInfo[1], second = value.staticState.clientInfo[2];
    if (first === undefined || second === undefined) throw new Error("Missing clients");
    first.infoValid = true; first.team = Team.TEAM_RED; first.name = "abcdefghijklmnop"; first.location = 1;
    first.health = 50; first.armor = 25; first.curWeapon = Weapon.WP_MACHINEGUN; first.powerups = 1 << Powerup.PW_QUAD;
    second.infoValid = true; second.team = Team.TEAM_BLUE;
    value.strings.set(609, "a very long location name");
    const quad = findItemForPowerup("baseq3", Powerup.PW_QUAD);
    if (quad === null) throw new Error("Missing quad item");
    const quadIndex = itemList("baseq3").indexOf(quad);
    expect(value.media.weaponRegistry.items[quadIndex]?.icon).toBeNull();
    setCvar(value, "cg_drawTeamOverlay", "2");
    await value.corners.drawLowerRight();
    value.tools.commands.submitFrame();
    expectRect(value.tools, 0, [328, 424, 312, 8]);
    expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(39);
    expectRect(value.tools, 31, [328, 424, 8, 8]);
  });

  test("scores, sorted powerups and pickup fade record source rectangles and execute on the CPU renderer", async () => {
    const value = await fixture(); activateSnapshot(value);
    const snapshot = value.state.snap;
    if (snapshot === null) throw new Error("Missing snapshot");
    snapshot.playerState.persistant.set(PersistentIndex.PERS_SCORE, 7);
    value.staticState.scores1 = 10; value.staticState.scores2 = 5; value.staticState.fraglimit = 20;
    value.state.time = 1000;
    snapshot.playerState.powerups.set(Powerup.PW_QUAD, 4000);
    snapshot.playerState.powerups.set(Powerup.PW_HASTE, 3000);
    value.state.powerupActive = Powerup.PW_HASTE; value.state.powerupTime = 950;
    const quad = findItemForPowerup("baseq3", Powerup.PW_QUAD), haste = findItemForPowerup("baseq3", Powerup.PW_HASTE);
    if (quad === null || haste === null) throw new Error("Missing powerup items");
    expect(value.media.weaponRegistry.items[itemList("baseq3").indexOf(quad)]?.icon).toBeNull();
    expect(value.media.weaponRegistry.items[itemList("baseq3").indexOf(haste)]?.icon).toBeNull();
    await value.corners.drawLowerRight();
    value.tools.commands.submitFrame();
    const drawsAfterRight = pictureQuads(value.tools.recording.trace().flatMap(view => view.batches)).length;
    expect(drawsAfterRight).toBe(17);
    expectRect(value.tools, 13, [562, 352, 32, 48]);
    expectRect(value.tools, 14, [574, 343, 66, 66]);
    expectRect(value.tools, 15, [562, 304, 32, 48]);
    expectRect(value.tools, 16, [592, 304, 48, 48]);

    value.state.itemPickup = itemList("baseq3").indexOf(quad); value.state.itemPickupTime = 1; value.state.time = 100;
    await value.corners.drawLowerLeft();
    expect(value.media.weaponRegistry.items[value.state.itemPickup]?.icon).not.toBeNull();
    value.tools.commands.submitFrame();
    expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches)).length).toBeGreaterThan(drawsAfterRight);
    expectRect(value.tools, drawsAfterRight, [8, 384, 48, 48]);
    const renderer = value.tools.cpu;
    let lit = 0;
    for (let index = 3; index < renderer.pixels.length; index += 4) if (renderer.pixels[index] !== 0) lit++;
    expect(lit).toBeGreaterThan(1000);
  });

  test("team chat advances one expired line and retains the source zero-height background", async () => {
    const value = await fixture(); activateSnapshot(value, Team.TEAM_BLUE);
    value.staticState.teamChatMsgs[0] = "old"; value.staticState.teamChatMsgTimes[0] = 1;
    value.staticState.teamChatPos = 1; value.state.time = 4002;
    value.corners.drawTeamInfo();
    expect(value.staticState.teamLastChatPos).toBe(1);
    value.tools.commands.submitFrame();
    expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(1);
    expectRect(value.tools, 0, [0, 420, 640, 0]);

    const ordered = await fixture(); activateSnapshot(ordered, Team.TEAM_RED);
    ordered.staticState.teamChatMsgs[0] = "one"; ordered.staticState.teamChatMsgs[1] = "longer";
    ordered.staticState.teamChatPos = 2; ordered.state.time = 100;
    ordered.corners.drawTeamInfo();
    ordered.tools.commands.submitFrame();
    expectRect(ordered.tools, 0, [0, 404, 640, 16]);
    expect(pictureQuads(ordered.tools.recording.trace().flatMap(view => view.batches))).toHaveLength(10);
  });
});

test("missionpack retains common upper drawing and rejects source-excluded field and lower routines", async () => {
  const value = await fixture("missionpack"); activateSnapshot(value);
  setCvar(value, "cg_drawTimer", "1"); await value.corners.drawUpperRight();
  value.tools.commands.submitFrame();
  expect(pictureQuads(value.tools.recording.trace().flatMap(view => view.batches)).length).toBeGreaterThan(0);
  expect(() => value.corners.drawField(0, 0, 1, 1)).toThrow("not compiled");
  await expect(value.corners.drawLowerRight()).rejects.toThrow("not compiled");
  await expect(value.corners.drawLowerLeft()).rejects.toThrow("not compiled");
  expect(() => value.corners.drawTeamInfo()).toThrow("not compiled");
});
