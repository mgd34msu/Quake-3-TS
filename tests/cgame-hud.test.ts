import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { BspMap } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { ClientHud } from "../src/cgame/hud.ts";
import type { ClientHudVariant } from "../src/cgame/hud.ts";
import { ClientConfiguration } from "../src/cgame/config.ts";
import { ClientHudCorners } from "../src/cgame/hud-corners.ts";
import { ClientDrawIcons } from "../src/cgame/draw-icons.ts";
import { ClientDrawStatus } from "../src/cgame/draw-status.ts";
import { ClientDrawTools, drawStrlen, fadeColor } from "../src/cgame/draw-tools.ts";
import { ClientEffects } from "../src/cgame/effects.ts";
import { LocalEntityPool } from "../src/cgame/local-entities.ts";
import { ImpactMarkSystem } from "../src/cgame/marks.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { MissionHud } from "../src/cgame/mission-hud.ts";
import { ParticleSystem, loadParticleAnimations } from "../src/cgame/particles.ts";
import { ClientInfoStore, PlayerPresenter } from "../src/cgame/players.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { BaseScoreboard } from "../src/cgame/scoreboard.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ClientWeaponRuntime } from "../src/cgame/weapons.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { vec3, vec4 } from "../src/core/math.ts";
import type { Vec3, Vec4 } from "../src/core/math.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { EngineUiModelPainter } from "../src/engine/ui-model.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { Rect2D } from "../src/render/draw2d.ts";
import type { FixedTextOptions } from "../src/render/font.ts";
import { UiAssetRegistry } from "../src/render/font.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { BspMarkProjector } from "../src/render/marks.ts";
import type { SceneShader } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { GameType, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { MoveFlags, createPlayerState } from "../src/shared/player-state.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

type Trace = readonly unknown[];
function unavailable(): never { throw new Error("Unexpected non-HUD fixture operation"); }
function cell<T>(values: ArrayLike<T>, index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`Missing fixture slot ${index}`); return value; }
class TraceTools extends ClientDrawTools {
  readonly trace: Trace[] = [];
  readonly sourceCalls: Trace[] = [];
  private depth = 0;
  private source(row: Trace, run: () => void): void { if (this.depth === 0) this.sourceCalls.push(row); this.depth++; try { run(); } finally { this.depth--; } }
  override drawPic(rect: Rect2D, shader: SceneShader | null): void { this.trace.push(["pic", rect, shader]); this.source(["pic", rect.x, rect.y, rect.width, rect.height, shader === null ? 0 : shader.name], () => super.drawPic(rect, shader)); }
  override drawBigString(x: number, y: number, text: string, alpha: number): void { this.trace.push(["big", x, y, text, alpha]); this.source(["big", x, y, text, alpha], () => super.drawBigString(x, y, text, alpha)); }
  override drawBigStringColor(x: number, y: number, text: string, color: Vec4): void { this.trace.push(["bigcolor", x, y, text, color]); super.drawBigStringColor(x, y, text, color); }
  override drawSmallString(x: number, y: number, text: string, alpha: number): void { this.trace.push(["small", x, y, text, alpha]); this.source(["small", x, y, text, alpha], () => super.drawSmallString(x, y, text, alpha)); }
  override drawStringExt(options: FixedTextOptions): void { this.trace.push(["ext", options]); const o = options;
    this.source(["ext", o.x, o.y, o.text, o.charWidth, o.charHeight, Number(o.forceColor), Number(o.shadow), o.maxChars], () => super.drawStringExt(options)); }
}
class TraceIcons extends ClientDrawIcons {
  readonly heads: { readonly rect: Rect2D; readonly client: number; readonly angles: Vec3 }[] = [];
  override drawHead(rect: Rect2D, client: number, angles: Vec3): void { this.heads.push({ rect, client, angles }); super.drawHead(rect, client, angles); }
}
function syntheticAssets(): RetainedFileReader & SoundAssetReader & SourceFileReader {
  const tga = new Uint8Array(22); tga[2] = 2; tga[12] = 1; tga[14] = 1; tga[16] = 32; tga[17] = 0x20; tga.fill(255, 18);
  return withRetainedFiles<SoundAssetReader & SourceFileReader>({ list: () => [], has: name => name.endsWith(".tga"), read: async () => tga, readSync: () => tga,
    readFileLength: path => path.endsWith(".tga") ? tga.byteLength : -1,
    readFileOptional: async path => path.endsWith(".tga") ? tga : undefined,
    readFileOptionalSync: path => path.endsWith(".tga") ? tga : undefined });
}
function map(fog: boolean): BspMap {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 60 }, { normal: vec3(-1, 0, 0), distance: -20 },
    { normal: vec3(0, 1, 0), distance: 10 }, { normal: vec3(0, -1, 0), distance: 10 },
    { normal: vec3(0, 0, 1), distance: 10 }, { normal: vec3(0, 0, -1), distance: 10 }];
  return { entities: "", entityRecords: [], shaders: [{ name: "fog", surfaceFlags: 0, contentFlags: 64 }], planes,
    nodes: [{ plane: 0, children: [-1, -1], bounds }], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: fog ? 1 : 0 }],
    leafSurfaces: [], leafBrushes: fog ? [0] : [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: fog ? 1 : 0 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
async function fixture(assets: RetainedFileReader & SoundAssetReader & SourceFileReader = syntheticAssets(), fog = false, product: Product = "baseq3", withGl = false) {
  const state = new ClientGameState(product, 0, 0), cgs = new ClientGameStaticState(product), audio = new AudioMixer(22050, () => 0);
  const images = new RendererImageCatalog();
  const window = withGl ? SdlWindow.open({ title: `HUD integration ${product}`, width: 640, height: 480, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(640, 480, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]), builtins = new BuiltinImages(images, identityImageUploadProfile), clock = { milliseconds: () => state.time };
  const engineCinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => audio }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: engineCinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { try { engineCinematics.dispose(); } finally { window?.close(); } } } });
  const soundDebugMessages: string[] = [];
  const bank = new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: unavailable }), media = new ClientMedia(product, cgs, resources, bank);
  if (assets.has("sound/feedback/hit.wav")) await bank.beginRegistration();
  const draw = commands.draw2D("stretch-640"), tools = new TraceTools(draw, media);
  const ps = createPlayerState(product); ps.health = 100;
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
    areaMask: new Uint8Array(32), playerState: ps, entities: [] }; state.predictedPlayerState = ps.copy(); state.time = 1000; cgs.maxclients = 64;
  state.refdef.width = 640; state.refdef.height = 480; state.refdef.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  Object.assign(cell(cgs.clientInfo, 0), { infoValid: true, name: "Local", team: Team.TEAM_FREE });
  const cvars = new CvarRegistry();
  for (const [name, value] of Object.entries({ cg_draw2D: "1", cg_drawStatus: "1", cg_drawIcons: "1", cg_draw3dIcons: "0", cg_drawRewards: "1",
    cg_drawCrosshair: "1", cg_crosshairHealth: "0", cg_crosshairSize: "24", cg_crosshairX: "0", cg_crosshairY: "0", cg_drawCrosshairNames: "1", cg_drawAmmoWarning: "1",
    cg_paused: "0", cg_centertime: "3", cg_lagometer: "0", cg_nopredict: "0", g_synchronousClients: "0", cg_drawAttacker: "0", cg_drawSnapshot: "0", cg_drawFPS: "0",
    cg_drawTimer: "0", cg_drawTeamOverlay: "0", cg_teamChatHeight: "0", cg_teamChatTime: "3000" })) cvars.register(name, value);
  const readVmCvar = (name: string) => { const value = cvars.get(name); if (value === undefined) throw new Error(`Missing fixture cvar ${name}`); return value; };
  const icons = new TraceIcons(state, tools, () => ({ drawIcons: readVmCvar("cg_drawIcons").integerValue !== 0, draw3dIcons: readVmCvar("cg_draw3dIcons").integerValue !== 0 }), commands);
  const history = new ClientCommandHistory(), worldMap = map(fog), collision = new CollisionWorld(worldMap, { kind: "unaccounted" }, { kind: "disabled" }), random = new GameRandom(1);
  const prediction = new PredictionRuntime(state, collision, { commands: history, settings: unavailable, setPmoveMsec: unavailable, transitionPlayerState: unavailable, warn: unavailable });
  const corners = new ClientHudCorners(state, cgs, icons, { readVmCvar, configString: () => "", milliseconds: () => state.time });
  const clients = new ClientInfoStore({ state, assets, resources,
    settings: () => ({ gameType: cgs.gameType, maxClients: 64, forceModel: false, model: "sarge/default", headModel: "sarge/default", redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: false, loading: true }),
    memoryRemaining: () => 10000000, registerShaderNoMip: name => resources.registerShaderNoMip(name), registerSound: (name, compressed) => bank.registerSound(name, compressed),
    sound: (name, compressed) => bank.sound(name, compressed), print: unavailable }, cgs.clientInfo);
  const players = new PlayerPresenter({ state, ...(product === "baseq3" ? { product } : { product, missionMedia: media.missionPlayers }), clients, media: media.players, random,
    settings: () => ({ gameType: cgs.gameType, cameraMode: false, noPlayerAnimations: false, animationSpeed: 1, swingSpeed: 0.3, drawFriend: false, shadows: 0, enableBreath: false, enableDust: false, debugPosition: false, debugAnimation: false }),
    collision, effects: { smokePuff: unavailable }, trace: unavailable, addEntity: unavailable, addLight: unavailable, addPoly: unavailable,
    lightForPoint: unavailable, marks: { impactMark: unavailable }, addLoopingSound: unavailable, addPlayerWeapon: unavailable, print: unavailable });
  const pool = new LocalEntityPool(product), effects = new ClientEffects(state, pool, media.effects,
    { noProjectileTrail: false, blood: true, gibs: true, scorePlum: true, hardware: "generic" }, { randomInteger: () => random.rand(), startSound: unavailable });
  const marks = new ImpactMarkSystem(new BspMarkProjector({ map: worldMap, surfaces: [] }), { clock: () => state.time, enabled: () => true, energyShader: () => media.graphics.energyMarkShader });
  const particles = new ParticleSystem(state, { animations: await loadParticleAnimations(resources), media: media.particles, prediction, random, hardwareType: "generic", configString: () => "", print: unavailable });
  const weapons = new ClientWeaponRuntime(state, media.weaponRegistry, { prediction, random, localEntities: pool, effects, particles, marks, media: media.weapons,
    settings: unavailable, clientInfo: index => clients.clientInfo(index), sound: (name, compressed) => bank.sound(name, compressed), startSound: unavailable,
    addLoopSound: unavailable, addRefEntity: unavailable, addPoly: unavailable, addLight: unavailable,
    drawing: { fadeColor: (start, duration) => fadeColor(state.time, start, duration), setColor: color => draw.setColor(color), drawPic: (x, y, width, height, shader) => tools.drawPic({ x, y, width, height }, shader),
      drawStringLength: drawStrlen, drawBigStringColor: (x, y, text, color) => tools.drawBigStringColor(x, y, text, color) } });
  const sounds: { sound: PcmSound | null; channel: number }[] = [];
  const startLocalSound = (sound: PcmSound | null, channel: number) => { sounds.push({ sound, channel });
    tools.sourceCalls.push(["sound", sound === null ? 0 : "pcm", channel]);
    const pcm = bank.resolveForPlayback(sound); if (pcm !== null) audio.startSound(pcm, { entity: 0, channel, origin: { kind: "local" }, volume: 127 }); };
  const consoleCommands = new CommandBuffer(), configuration = new ClientConfiguration(product, { cvars, state, staticState: cgs, clients, configString: () => "" });
  const cinematics = new EngineUiCinematics(engineCinematics, "cgame");
  const menus = product === "baseq3" ? null : new MissionHud(state, cgs, media, {
    assets, fontRegistry: new UiAssetRegistry(resources, text => { tools.trace.push(["print", text]); }), icons, configuration, cvars, commands: consoleCommands, clients, random, cinematics,
    modelPainter: new EngineUiModelPainter(resources, commands),
    audio: { playLocal: sound => {
      const pcm = typeof sound === "number" ? bank.soundForIndex(sound) : sound;
      if (typeof sound === "number" && pcm === undefined) return;
      startLocalSound(pcm ?? null, 6);
    }, startBackground: unavailable, stopBackground: unavailable },
    configString: () => "", resetPlayerEntity: entity => players.resetPlayerEntity(entity), print: text => tools.trace.push(["print", text]), milliseconds: () => state.time, setKeyCatcher: unavailable,
  });
  if (menus !== null) { configuration.registerCvars(); cleanup.push(() => menus.dispose()); }
  const status = new ClientDrawStatus(state, cgs, tools, menus === null ? { kind: "baseq3" } : { kind: "missionpack", fonts: menus.fonts }, { commands: history, readVmCvar });
  const host = { icons, status, corners, prediction, weapons, random, readVmCvar, startLocalSound };
  const variant: ClientHudVariant = menus === null ? { kind: "baseq3", scoreboard: new BaseScoreboard(state, cgs, { icons, clients, players, readVmCvar, configString: () => "", sendClientCommand: unavailable, print: unavailable }) }
    : { kind: "missionpack", fonts: menus.fonts, menus };
  const hud = new ClientHud(state, cgs, host, variant);
  media.graphics.charsetShader = await resources.registerShaderNoMip("gfx/2d/bigchars"); media.graphics.whiteShader = await resources.registerShaderNoMip("white");
  const numberNames = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "minus"];
  for (const [index, name] of numberNames.entries()) media.graphics.numberShaders[index] = await resources.registerShader(`gfx/2d/numbers/${name}_32b`);
  return { hud, host, state, cgs, ps, tools, draw, commands, cpu, gl, recording, icons, status, corners, cvars, resources, media, clients, random, collision, prediction, sounds, audio, bank, menus, configuration, consoleCommands };
}

describe("source cg_draw HUD", () => {
  test("status digits use snapshot ammo but predicted firing state and preserve health modulation", async () => {
    const f = await fixture(); f.state.entityAt(0).currentState.weapon = Weapon.WP_MACHINEGUN; f.ps.ammo.set(Weapon.WP_MACHINEGUN, 23);
    f.state.predictedPlayerState.weaponState = WeaponState.WEAPON_FIRING; f.state.predictedPlayerState.weaponTime = 101;
    f.ps.health = 24; f.hud.drawStatusBar();
    f.commands.submitFrame();
    const batches = f.recording.trace().flatMap(view => view.batches);
    expect(batches.slice(1, 3).map(batch => batch.vertices[0]?.color)).toEqual(Array.from({ length: 2 }, () => ({ x: 127 / 255, y: 127 / 255, z: 127 / 255, w: 1 })));
    expect(batches.slice(-2).map(batch => batch.vertices[0]?.color)).toEqual(Array.from({ length: 2 }, () => ({ x: 1, y: 0.2, z: 0.2, w: 1 })));
    f.tools.drawPic({ x: 0, y: 0, width: 1, height: 1 }, f.media.graphics.whiteShader);
    f.commands.submitFrame();
    expect(f.recording.trace().flatMap(view => view.batches).at(-1)?.vertices[0]?.color).toEqual(vec4(1, 0, 0, 1));
    expect(f.icons.heads[0]?.rect).toEqual({ x: 285, y: 420, width: 60, height: 60 });
  });
  test("head damage refresh consumes source RNG order while interpolation and frozen-time repair stay live", async () => {
    const f = await fixture(); f.state.damageTime = 900; f.state.damageX = 0.5;
    f.hud.drawStatusBarHead(285);
    expect(f.state.headStartYaw).toBe(202.5); expect(f.state.headStartTime).toBe(1000);
    expect(f.icons.heads[0]?.rect).toEqual({ x: 267, y: 396, width: 84, height: 84 });
    expect(f.icons.heads[0]?.angles).toEqual(vec3(0, 202.5, 0));
    // Untouched cg_draw.c native fixture, seed1; /tmp/quake3-hud-reference-BHMlJp/reference 4.
    expect([f.state.headEndYaw, f.state.headEndPitch, f.state.headEndTime]).toEqual([Math.fround(164.419113), Math.fround(-4.90559673), 1971]);
    const expected = new GameRandom(1); expected.crandom(); expected.crandom(); expected.random(); expect(f.random.seed).toBe(expected.seed);
    f.state.damageTime = 0; f.state.headStartTime = 1500; f.state.headEndTime = 2000;
    f.hud.drawStatusBarHead(285); expect(f.state.headStartTime).toBe(1000); expect(f.random.seed).toBe(expected.seed);
  });
  test("head animation retains q3lcc float lowering and float damage time beyond exact integer range", async () => {
    const f = await fixture(); f.random.reset(3); f.state.damageTime = 900; f.hud.drawStatusBarHead(285);
    // cg_draw.asm CALLF4 cos with float32 pi/product, then MULF4; native double cosine differs by two ULP here.
    expect(f.state.headEndPitch).toBe(-3.585261344909668);
    f.state.time = 16777717; f.state.damageTime = Math.fround(16777217);
    const before = f.random.seed; f.state.headEndTime = 16778000; f.hud.drawStatusBarHead(285);
    expect(f.random.seed).toBe(before); expect(f.icons.heads.at(-1)?.rect.height).toBe(60);
  });
  test("original cg_draw.c command traces match warmup, votes, reward promotion and follow layout", async () => {
    // Captured from the untouched source compiled in /tmp/quake3-hud-reference-BHMlJp.
    // Native draw imports record calls; here every recorded call also executes real Draw2D.
    const warmup = await fixture(); warmup.cgs.gameType = GameType.GT_TOURNAMENT; warmup.state.warmup = 3500;
    Object.assign(cell(warmup.cgs.clientInfo, 1), { infoValid: true, team: Team.TEAM_FREE, name: "Middle" });
    Object.assign(cell(warmup.cgs.clientInfo, 2), { infoValid: true, team: Team.TEAM_FREE, name: "Last" });
    warmup.hud.drawWarmup(); warmup.hud.drawWarmup(); warmup.state.time = 4500; warmup.hud.drawWarmup();
    expect(warmup.tools.sourceCalls).toEqual([
      ["ext", 112, 20, "Local vs Last", 32, 48, 0, 1, 0], ["sound", 0, 7], ["ext", 200, 70, "Starts in: 3", 20, 30, 0, 1, 0],
      ["ext", 112, 20, "Local vs Last", 32, 48, 0, 1, 0], ["ext", 200, 70, "Starts in: 3", 20, 30, 0, 1, 0],
      ["ext", 112, 20, "Local vs Last", 32, 48, 0, 1, 0], ["sound", 0, 7], ["ext", 152, 70, "Starts in: 1", 28, 42, 0, 1, 0],
    ]);
    const reward = await fixture(); reward.state.time = 3001; reward.state.rewardTime = 1; reward.state.rewardStack = 2;
    cell(reward.state.rewards, 1).count = 10; cell(reward.state.rewards, 2).count = 3;
    reward.hud.drawReward(); reward.state.time = 6001; reward.hud.drawReward();
    expect(reward.tools.sourceCalls).toEqual([["sound", 0, 7], ["pic", 296, 56, 44, 44, 0], ["ext", 312, 104, "10", 8, 16, 0, 1, 0],
      ["sound", 0, 7], ["pic", 248, 56, 44, 44, 0], ["pic", 296, 56, 44, 44, 0], ["pic", 344, 56, 44, 44, 0]]);
    const follow = await fixture(); follow.state.lowAmmoWarning = 2; follow.hud.drawAmmoWarning(); follow.state.lowAmmoWarning = 1; follow.hud.drawAmmoWarning();
    follow.ps.pmFlags = MoveFlags.FOLLOW; cell(follow.cgs.clientInfo, 0).name = "^1Local"; follow.hud.drawFollow(); follow.cgs.gameType = GameType.GT_TEAM; follow.hud.drawSpectator();
    expect(follow.tools.sourceCalls).toEqual([["big", 232, 64, "OUT OF AMMO", 1], ["big", 192, 64, "LOW AMMO WARNING", 1],
      ["big", 248, 24, "following", 1], ["ext", 240, 40, "^1Local", 32, 48, 1, 1, 0], ["big", 248, 440, "SPECTATOR", 1], ["big", 8, 460, "press ESC and use the JOIN menu to play", 1]]);
  });
  test("reward expiry shifts owned records, forwards source sound zero, and draws count thresholds", async () => {
    const f = await fixture(); f.state.rewardTime = 1; f.state.time = 3001; f.state.rewardStack = 2;
    const first = cell(f.state.rewards, 0); Object.assign(cell(f.state.rewards, 1), { count: 10 }); Object.assign(cell(f.state.rewards, 2), { count: 3 });
    f.hud.drawReward(); expect(cell(f.state.rewards, 0)).toBe(first); expect(first.count).toBe(10);
    expect(f.state.rewardStack).toBe(1); expect(f.state.rewardTime).toBe(3001); expect(f.sounds).toEqual([{ sound: null, channel: 7 }]);
    expect(f.tools.trace.find(row => row[0] === "ext")?.[1]).toMatchObject({ x: 312, y: 104, text: "10", charWidth: 8, charHeight: 16 });
    f.state.time = 6001; f.tools.trace.length = 0; f.hud.drawReward(); expect(f.tools.trace.filter(row => row[0] === "pic")).toHaveLength(3);
    expect(f.tools.trace.filter(row => row[0] === "pic").map(row => row[1])).toEqual([248, 296, 344].map(x => ({ x, y: 56, width: 44, height: 44 })));
  });
  test("crosshair uses real body traces, fog world contents, invisibility and persistent name fade", async () => {
    for (const fog of [false, true]) {
      const f = await fixture(syntheticAssets(), fog), target = f.state.entityAt(1);
      target.currentState.number = 1; target.currentState.solid = 8 | (8 << 8) | (40 << 16); target.lerpOrigin = vec3(40, 0, 0); f.state.solidEntities.push(target);
      cell(f.cgs.clientInfo, 1).name = "^1Target";
      f.hud.drawCrosshairNames(); expect(f.state.crosshairClientTime).toBe(fog ? 0 : 1000);
      if (fog) continue;
      expect(f.tools.trace.find(row => row[0] === "big")).toEqual(["big", 272, 170, "^1Target", 0.5]);
      target.currentState.powerups = 1 << Powerup.PW_INVIS; f.state.time = 1900; f.tools.trace.length = 0; f.hud.drawCrosshairNames();
      expect(f.state.crosshairClientTime).toBe(1000); expect(f.tools.trace.find(row => row[0] === "big")?.[4]).toBe(0.25);
      f.state.time = 2000; f.tools.trace.length = 0; f.hud.drawCrosshairNames(); expect(f.tools.trace).toEqual([]);
    }
  });
  test("crosshair pulses in the current viewport and retains health color at source return", async () => {
    const f = await fixture(); f.state.itemPickupBlendTime = 900; f.state.refdef.x = 40; f.state.refdef.y = 20; f.state.refdef.width = 400; f.state.refdef.height = 300;
    f.cvars.set("cg_crosshairX", "4"); f.cvars.set("cg_crosshairY", "-3"); f.cvars.set("cg_crosshairHealth", "1"); f.ps.health = 20;
    f.hud.drawCrosshair(); f.commands.submitFrame(); const batch = cell(f.recording.trace().flatMap(view => view.batches), 0);
    expect(batch.vertices.map(v => v.position.x)).toEqual([226, 262, 262, 226].map(x => Math.fround(x / 320 - 1)));
    f.ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_SPECTATOR); f.hud.drawCrosshair(); f.commands.submitFrame(); expect(f.recording.trace().flatMap(view => view.batches)).toHaveLength(1);
  });
  test("vote beeps consume modified flags once and team vote reads source client slot zero", async () => {
    const f = await fixture(); f.ps.clientNum = 3; cell(f.cgs.clientInfo, 3).team = Team.TEAM_BLUE; cell(f.cgs.clientInfo, 0).team = Team.TEAM_RED;
    f.cgs.voteTime = 500; f.cgs.voteString = "map q3dm1"; f.cgs.voteYes = 2; f.cgs.voteModified = true;
    f.cgs.teamVoteTime[0] = 900; f.cgs.teamVoteString[0] = "leader 3"; f.cgs.teamVoteModified[0] = true;
    f.hud.drawVote(); f.hud.drawTeamVote(); f.hud.drawVote(); f.hud.drawTeamVote();
    expect(f.sounds).toEqual([{ sound: null, channel: 6 }, { sound: null, channel: 6 }]);
    expect(f.tools.trace.filter(row => row[0] === "small").slice(0, 2)).toEqual([["small", 0, 58, "VOTE(29):map q3dm1 yes:2 no:0", 1], ["small", 0, 90, "TEAMVOTE(29):leader 3 yes:0 no:0", 1]]);
  });
  test("warmup tournament chooses first and last valid players and countdown only emits on transitions", async () => {
    const f = await fixture(); f.cgs.gameType = GameType.GT_TOURNAMENT; f.state.warmup = 3500;
    Object.assign(cell(f.cgs.clientInfo, 1), { infoValid: true, team: Team.TEAM_FREE, name: "Middle" });
    Object.assign(cell(f.cgs.clientInfo, 2), { infoValid: true, team: Team.TEAM_FREE, name: "Last" });
    f.hud.drawWarmup(); expect(f.tools.trace.find(row => row[0] === "ext")?.[1]).toMatchObject({ text: "Local vs Last", x: 112, y: 20 });
    expect(f.state.warmupCount).toBe(2); expect(f.sounds).toEqual([{ sound: null, channel: 7 }]);
    f.hud.drawWarmup(); expect(f.sounds).toHaveLength(1); f.state.time = 4500; f.hud.drawWarmup(); expect(f.state.warmup).toBe(0); expect(f.state.warmupCount).toBe(0);
    f.ps.pmFlags |= MoveFlags.FOLLOW; expect(f.hud.drawFollow()).toBe(true);
    expect(f.tools.trace.at(-1)?.[1]).toMatchObject({ text: "Local", forceColor: true, x: 240, y: 40 });
  });
  test("base Draw2D gates, alive warnings, intermission and actual scoreboard/center suppression", async () => {
    const f = await fixture(); f.state.levelShot = true; f.state.snap = null; await f.hud.draw2D(); f.commands.submitFrame(); expect(f.recording.trace()).toEqual([]);
    f.commands.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
    f.state.levelShot = false; f.cvars.set("cg_draw2D", "0"); await f.hud.draw2D();
    f.state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: f.ps, entities: [] };
    f.cvars.set("cg_draw2D", "1"); f.state.lowAmmoWarning = 2; f.status.centerPrint("CENTER", 144, 16); await f.hud.draw2D();
    expect(f.tools.trace.some(row => row[3] === "OUT OF AMMO")).toBe(true); expect(f.state.scoreBoardShowing).toBe(false);
    expect(f.tools.trace.some(row => row[0] === "ext" && typeof row[1] === "object" && row[1] !== null && "text" in row[1] && row[1].text === "CENTER")).toBe(true);
    f.state.showScores = true; f.tools.trace.length = 0; await f.hud.draw2D(); expect(f.state.scoreBoardShowing).toBe(true);
    expect(f.tools.trace.some(row => row[3] === "OUT OF AMMO")).toBe(false);
    f.ps.pmType = MoveType.PM_INTERMISSION; f.cgs.gameType = GameType.GT_SINGLE_PLAYER; f.tools.trace.length = 0; await f.hud.draw2D();
    expect(f.tools.trace).toHaveLength(1); expect(f.tools.trace[0]?.[0]).toBe("ext");
    f.commands.submitFrame(); f.commands.close("require-empty"); const cpu = f.cpu; expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
  });
  test("Draw2D preserves ordered actual service calls and does not run alive-only operations when dead", async () => {
    const f = await fixture(), order: string[] = [];
    const observe = <T>(name: string, run: () => T) => () => { order.push(name); return run(); };
    f.hud.drawStatusBar = observe("status", f.hud.drawStatusBar.bind(f.hud));
    f.hud.drawAmmoWarning = observe("ammo", f.hud.drawAmmoWarning.bind(f.hud));
    f.hud.drawCrosshair = observe("crosshair", f.hud.drawCrosshair.bind(f.hud));
    f.hud.drawCrosshairNames = observe("names", f.hud.drawCrosshairNames.bind(f.hud));
    f.host.weapons.drawWeaponSelect = observe("weapon", f.host.weapons.drawWeaponSelect.bind(f.host.weapons));
    const holdable = f.hud.drawHoldableItem.bind(f.hud); f.hud.drawHoldableItem = async () => { order.push("holdable"); await holdable(); };
    f.hud.drawReward = observe("reward", f.hud.drawReward.bind(f.hud));
    f.hud.drawVote = observe("vote", f.hud.drawVote.bind(f.hud)); f.hud.drawTeamVote = observe("teamvote", f.hud.drawTeamVote.bind(f.hud));
    f.status.drawLagometer = observe("lag", f.status.drawLagometer.bind(f.status));
    f.corners.drawUpperRight = observe("upper", f.corners.drawUpperRight.bind(f.corners));
    f.corners.drawLowerRight = observe("right", f.corners.drawLowerRight.bind(f.corners));
    f.corners.drawLowerLeft = observe("left", f.corners.drawLowerLeft.bind(f.corners));
    f.corners.drawTeamInfo = observe("teaminfo", f.corners.drawTeamInfo.bind(f.corners));
    const follow = f.hud.drawFollow.bind(f.hud); f.hud.drawFollow = () => { order.push("follow"); return follow(); };
    f.hud.drawWarmup = observe("warmup", f.hud.drawWarmup.bind(f.hud));
    const scoreboard = f.hud.drawScoreboard.bind(f.hud); f.hud.drawScoreboard = async () => { order.push("scoreboard"); return scoreboard(); };
    f.status.drawCenterString = observe("center", f.status.drawCenterString.bind(f.status));
    f.cgs.gameType = GameType.GT_TEAM; await f.hud.draw2D();
    expect(order).toEqual(["status", "ammo", "crosshair", "names", "weapon", "holdable", "reward", "teaminfo", "vote", "teamvote", "lag", "upper", "right", "left", "follow", "warmup", "scoreboard", "center"]);
    order.length = 0; f.ps.health = 0; f.state.predictedPlayerState.pmType = MoveType.PM_DEAD; await f.hud.draw2D();
    expect(order).toEqual(["teaminfo", "vote", "teamvote", "lag", "upper", "right", "left", "follow", "warmup", "scoreboard"]);
  });
  test("different canonical drawing owners are rejected at construction", async () => {
    const first = await fixture(), second = await fixture();
    expect(() => new ClientHud(first.state, first.cgs, { ...first.host, corners: second.corners }, first.hud.variant)).toThrow("canonical");
    expect(() => new ClientHud(first.state, first.cgs, { ...first.host, weapons: second.host.weapons }, first.hud.variant)).toThrow("canonical");
  });
  test("holdable registration is awaited before drawing the actual item visual", async () => {
    const f = await fixture(), index = itemList("baseq3").findIndex(item => item.className === "holdable_medkit");
    f.ps.stats.set(statSchema("baseq3").holdableItem, index); await f.hud.drawHoldableItem();
    const icon = cell(f.media.weaponRegistry.items, index).icon;
    expect(f.tools.trace).toEqual([["pic", { x: 592, y: 216, width: 48, height: 48 }, icon]]);
  });
  test("missionpack proximity countdown uses strict deadlines and per-instance persistent ticks", async () => {
    const f = await fixture(syntheticAssets(), false, "missionpack"); f.ps.eFlags |= 2;
    f.hud.drawProxWarning(); expect(f.tools.trace.find(row => row[0] === "bigcolor")?.[3]).toBe("YOU HAVE BEEN MINED");
    f.state.time = 6000; f.tools.trace.length = 0; f.hud.drawProxWarning(); expect(f.tools.trace[0]?.[3]).toBe("YOU HAVE BEEN MINED");
    f.state.time = 6001; f.tools.trace.length = 0; f.hud.drawProxWarning(); expect(f.tools.trace[0]?.[3]).toBe("INTERNAL COMBUSTION IN: 5");
    f.state.time = 99001; f.tools.trace.length = 0; f.hud.drawProxWarning(); expect(f.tools.trace[0]?.[3]).toBe("INTERNAL COMBUSTION IN: 4");
    f.ps.eFlags = 0; f.hud.drawProxWarning(); f.ps.eFlags = 2; f.tools.trace.length = 0; f.hud.drawProxWarning(); expect(f.tools.trace[0]?.[3]).toBe("YOU HAVE BEEN MINED");
    // Original -DMISSIONPACK cg_draw.c: /tmp/quake3-hud-reference-BHMlJp/mission-reference.
    expect(f.tools.trace[0]).toEqual(["bigcolor", 168, 80, "YOU HAVE BEEN MINED", vec4(1, 0, 0, 1)]);
    expect(() => f.hud.drawStatusBar()).toThrow("excluded"); expect(() => f.hud.drawStatusBarHead(0)).toThrow("excluded");
  });
  test("missionpack orders flush through the real command buffer before levelshot and draw2D guards", async () => {
    const f = await fixture(syntheticAssets(), false, "missionpack"); f.cgs.gameType = GameType.GT_CTF;
    f.cgs.orderPending = true; f.cgs.orderTime = 999; f.cgs.currentOrder = 1; f.state.levelShot = true;
    await f.hud.draw2D(); expect(f.cgs.orderPending).toBe(false);
    expect(f.consoleCommands.pendingText).toBe("cmd vsay_team offense\n+button7; wait; -button7"); f.commands.submitFrame(); expect(f.recording.trace()).toEqual([]);
    f.cgs.orderPending = true; f.cgs.orderTime = 1000; await f.hud.draw2D(); expect(f.cgs.orderPending).toBe(true);
    f.state.time = 1001; f.state.levelShot = false; f.cvars.set("cg_draw2D", "0"); await f.hud.draw2D(); expect(f.cgs.orderPending).toBe(false);
  });
  test("missionpack voice timer retains the strict 2500ms deadline and source cvar reset", async () => {
    const f = await fixture(syntheticAssets(), false, "missionpack"); f.state.voiceTime = 1000; f.cvars.set("cl_conXOffset", "72");
    f.state.time = 3500; await f.hud.drawTimedMenus(); expect(f.state.voiceTime).toBe(1000); expect(f.cvars.get("cl_conXOffset")?.value).toBe("72");
    f.state.time = 3501; await f.hud.drawTimedMenus(); expect(f.state.voiceTime).toBe(0); expect(f.cvars.get("cl_conXOffset")?.value).toBe("0");
  });
});

const dataPath = process.env["Q3_DATA"], retail = dataPath !== undefined && existsSync(dataPath);
test.skipIf(!retail)("retail Team Arena menus and shared HUD paint through actual Draw2D and CPU", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" }), f = await fixture(assets, false, "missionpack", process.env["QUAKE_GL_TEST"] === "1");
  f.commands.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
  const menus = f.menus; if (menus === null) throw new Error("Missing missionpack menu owner");
  await f.clients.newClientInfo(0, "\\n\\Sarge\\t\\0\\model\\sarge/default\\hmodel\\sarge/default");
  await f.media.weaponRegistry.registerWeapon(Weapon.WP_MACHINEGUN);
  f.media.graphics.armorModel = await f.resources.registerModel("models/powerups/armor/armor_yel.md3");
  f.media.graphics.armorIcon = await f.resources.registerShaderNoMip("icons/iconr_yellow");
  f.ps.stats.set(statSchema("missionpack").armor, 50); f.ps.ammo.set(Weapon.WP_MACHINEGUN, 24); f.ps.weapon = Weapon.WP_MACHINEGUN;
  f.state.predictedPlayerState = f.ps.copy(); f.state.entityAt(0).currentState.weapon = Weapon.WP_MACHINEGUN;
  await menus.assetCache(); await menus.loadHudMenu(); menus.initTeamChat();
  expect(menus.fonts.normal.glyphScale).toBeGreaterThan(0);
  f.state.warmup = 4000; f.hud.drawWarmup(); f.state.warmup = 0;
  await f.hud.draw2D();
  f.commands.submitFrame(); f.commands.close("require-empty"); const cpu = f.cpu;
  expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 20).length).toBeGreaterThan(10000);
  expect(f.state.scoreBoardShowing).toBe(false);
  const gl = f.gl; if (gl === null) return;
  const actual = gl.readPixels(); let max = 0, sum = 0;
  for (let i = 0; i < cpu.pixels.length; i++) { const error = Math.abs(cell(cpu.pixels, i) - cell(actual, i)); max = Math.max(max, error); sum += error; }
  expect(max).toBeLessThanOrEqual(3); expect(sum / cpu.pixels.length).toBeLessThan(0.1);
}, 60000);
test.skipIf(!retail)("retail Sarge weapon armor reward and holdable HUD render through real CPU and GL", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" }), f = await fixture(assets, false, "baseq3", process.env["QUAKE_GL_TEST"] === "1");
  f.commands.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
  await f.clients.newClientInfo(0, "\\n\\Sarge\\t\\0\\model\\sarge/default\\hmodel\\sarge/default");
  f.cvars.set("cg_draw3dIcons", "1"); await f.media.weaponRegistry.registerWeapon(Weapon.WP_ROCKET_LAUNCHER);
  f.media.graphics.armorModel = await f.resources.registerModel("models/powerups/armor/armor_yel.md3");
  f.media.graphics.crosshairShader[1] = await f.resources.registerShader("gfx/2d/crosshairb");
  expect(f.media.graphics.numberShaders.every(shader => shader !== null)).toBe(true);
  f.ps.stats.set(statSchema("baseq3").armor, 50); f.ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 12); f.state.entityAt(0).currentState.weapon = Weapon.WP_ROCKET_LAUNCHER;
  f.ps.stats.set(statSchema("baseq3").holdableItem, itemList("baseq3").findIndex(item => item.className === "holdable_medkit"));
  Object.assign(cell(f.state.rewards, 0), { shader: await f.resources.registerShaderNoMip("medal_impressive"), count: 3 }); f.state.rewardTime = 900;
  await f.hud.draw2D();
  f.commands.submitFrame(); f.commands.close("require-empty"); const cpu = f.cpu;
  expect(f.recording.trace().filter(view => view.state.clear !== null && view.batches.length > 0)).toHaveLength(3);
  const pixels = cpu.pixels; expect(pixels.filter((value, index) => index % 4 !== 3 && value > 20).length).toBeGreaterThan(10000);
  const gl = f.gl; if (gl === null) return;
  const actual = gl.readPixels(); let max = 0, sum = 0;
  for (let i = 0; i < pixels.length; i++) { const error = Math.abs(cell(pixels, i) - cell(actual, i)); max = Math.max(max, error); sum += error; }
  expect(max).toBeLessThanOrEqual(3); expect(sum / pixels.length).toBeLessThan(0.1);
}, 60000);
