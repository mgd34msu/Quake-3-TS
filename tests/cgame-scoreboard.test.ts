import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BaseScoreboard } from "../src/cgame/scoreboard.ts";
import { ClientDrawIcons } from "../src/cgame/draw-icons.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { ClientInfoStore, PlayerPresenter } from "../src/cgame/players.ts";
import type { ClientInfoSettings } from "../src/cgame/players.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import type { ClientEntity } from "../src/cgame/state.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec4 } from "../src/core/math.ts";
import type { Vec3, Vec4 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { Rect2D } from "../src/render/draw2d.ts";
import type { FixedTextOptions } from "../src/render/font.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import type { SceneShader } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { EntityType, GameType, MoveType, PersistentIndex, Powerup, Team, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

type Trace = readonly unknown[];
const colorBits = (color: Vec4): readonly number[] => [color.x, color.y, color.z, color.w].map(float32ToBits);
function unavailable(): never { throw new Error("Unexpected non-scoreboard fixture service"); }
class TraceTools extends ClientDrawTools {
  readonly trace: Trace[] = [];
  readonly shaderIds = new WeakMap<SceneShader, number>();
  private depth = 0;
  capture(row: Trace, run: () => void): void {
    if (this.depth === 0) this.trace.push(row);
    this.depth++; try { run(); } finally { this.depth--; }
  }
  override drawPic(rect: Rect2D, shader: SceneShader | null): void {
    this.capture(["pic", rect.x, rect.y, rect.width, rect.height, shader === null ? 0 : this.shaderIds.get(shader)], () => super.drawPic(rect, shader));
  }
  override fillRect(rect: Rect2D, color: Vec4 | null): void {
    this.capture(["fill", rect.x, rect.y, rect.width, rect.height, color === null ? null : colorBits(color)], () => super.fillRect(rect, color));
  }
  override drawBigString(x: number, y: number, text: string, alpha: number): void { this.capture(["big", x, y, text, float32ToBits(alpha)], () => super.drawBigString(x, y, text, alpha)); }
  override drawBigStringColor(x: number, y: number, text: string, color: Vec4): void { this.capture(["bigcolor", x, y, text, colorBits(color)], () => super.drawBigStringColor(x, y, text, color)); }
  override drawSmallStringColor(x: number, y: number, text: string, color: Vec4): void { this.capture(["smallcolor", x, y, text, colorBits(color)], () => super.drawSmallStringColor(x, y, text, color)); }
  override drawStringExt(options: FixedTextOptions): void {
    this.capture(["ext", options.x, options.y, options.text, colorBits(options.color), Number(options.forceColor), Number(options.shadow), options.charWidth, options.charHeight, options.maxChars], () => super.drawStringExt(options));
  }
}
class TraceIcons extends ClientDrawIcons {
  constructor(state: ClientGameState, readonly tracedTools: TraceTools, settings: () => { drawIcons: boolean; draw3dIcons: boolean }, commands: RenderCommandBuffer) {
    super(state, tracedTools, settings, commands);
  }
  override drawHead(rect: Rect2D, client: number, angles: Vec3): void { this.tracedTools.capture(["head", rect.x, rect.y, rect.width, rect.height, client, angles.x, angles.y, angles.z], () => super.drawHead(rect, client, angles)); }
  override drawFlagModel(rect: Rect2D, team: number, force2D: boolean): void { this.tracedTools.capture(["flag", rect.x, rect.y, rect.width, rect.height, team, Number(force2D)], () => super.drawFlagModel(rect, team, force2D)); }
  override drawTeamBackground(rect: Rect2D, alpha: number, team: number): void { this.tracedTools.capture(["team", rect.x, rect.y, rect.width, rect.height, float32ToBits(alpha), team], () => super.drawTeamBackground(rect, alpha, team)); }
}
class TraceClients extends ClientInfoStore {
  readonly loads: number[] = [];
  trace: Trace[] = [];
  override async loadDeferredPlayers(reset: (entity: ClientEntity) => void): Promise<void> {
    this.loads.push(this.host.state.deferredPlayerLoading); this.trace.push(["deferred", this.host.state.deferredPlayerLoading]);
    await super.loadDeferredPlayers(reset);
  }
}
function cell<T>(cells: readonly T[], index: number): T { const value = cells[index]; if (value === undefined) throw new Error(`Missing fixture cell ${index}`); return value; }
function syntheticAssets(): RetainedFileReader & SoundAssetReader & SourceFileReader {
  const tga = new Uint8Array(22); tga[2] = 2; tga[12] = 1; tga[14] = 1; tga[16] = 32; tga[17] = 0x20; tga.fill(255, 18);
  return withRetainedFiles<SoundAssetReader & SourceFileReader>({ list: () => [], has: path => path.endsWith(".tga"), read: async () => tga, readSync: () => tga,
    readFileLength: path => path.endsWith(".tga") ? tga.byteLength : -1,
    readFileOptional: async path => path.endsWith(".tga") ? tga : undefined,
    readFileOptionalSync: path => path.endsWith(".tga") ? tga : undefined });
}
async function fixture(count = 3, assets: RetainedFileReader & SoundAssetReader & SourceFileReader = syntheticAssets(), withGl = false, product: Product = "baseq3") {
  const state = new ClientGameState(product, 0, 0), cgs = new ClientGameStaticState(product);
  const images = new RendererImageCatalog();
  const window = withGl ? SdlWindow.open({ title: "Retail scoreboard", width: 640, height: 480, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(640, 480, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]), builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.time };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { try { cinematics.dispose(); } finally { window?.close(); } } } });
  const soundDebugMessages: string[] = [];
  const bank = new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: unavailable }), media = new ClientMedia(product, cgs, resources, bank);
  if (assets.has("sound/feedback/hit.wav")) await bank.beginRegistration();
  const tools = new TraceTools(commands.draw2D("stretch-640"), media);
  state.time = 1000; state.showScores = true; state.numScores = count; cgs.maxclients = 64;
  const ps = createPlayerState(product);
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: ps, entities: [] };
  for (let i = 0; i < count; i++) {
    Object.assign(cell(state.scores, i), { client: i, score: 100 - i, ping: 20 + i, time: 3 + i });
    Object.assign(cell(cgs.clientInfo, i), { infoValid: true, handicap: 100, team: Team.TEAM_FREE, name: `Player${i}`, score: 200 - i });
  }
  const register = async (name: string, id: number) => { const shader = await resources.registerShaderNoMip(name); if (shader !== null) tools.shaderIds.set(shader, id); return shader; };
  media.graphics.whiteShader = await register("white", 1); media.graphics.charsetShader = await register("gfx/2d/bigchars", 2);
  media.graphics.scoreboardScore = await register("menu/tab/score.tga", 101); media.graphics.scoreboardPing = await register("menu/tab/ping.tga", 102);
  media.graphics.scoreboardTime = await register("menu/tab/time.tga", 103); media.graphics.scoreboardName = await register("menu/tab/name.tga", 104);
  for (let i = 0; i < 5; i++) media.graphics.botSkillShaders[i] = await register(`menu/art/skill${i + 1}.tga`, 201 + i);
  media.graphics.teamStatusBar = await register("gfx/2d/colorbar.tga", 301);
  const options = { drawIcons: true, draw3dIcons: false }, icons = new TraceIcons(state, tools, () => options, commands);
  const clientSettings: ClientInfoSettings = { gameType: GameType.GT_FFA, maxClients: 64, forceModel: false, model: "sarge/default", headModel: "sarge/default",
    redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: false, loading: true };
  const clients = new TraceClients({ state, assets, resources, settings: () => clientSettings, memoryRemaining: () => 10000000,
    registerShaderNoMip: name => resources.registerShaderNoMip(name), registerSound: (name, compressed) => bank.registerSound(name, compressed), sound: (name, compressed) => bank.sound(name, compressed),
    print: text => tools.trace.push(["print", text]) }, cgs.clientInfo);
  clients.trace = tools.trace;
  const players = new PlayerPresenter({ state, ...(product === "baseq3" ? { product } : { product, missionMedia: media.missionPlayers }), clients, media: media.players, random: new GameRandom(1),
    settings: () => ({ gameType: cgs.gameType, cameraMode: false, noPlayerAnimations: false, animationSpeed: 1, swingSpeed: 0.3, drawFriend: false, shadows: 0,
      enableBreath: false, enableDust: false, debugPosition: false, debugAnimation: false }),
    collision: { trace: unavailable, pointContents: unavailable }, effects: { smokePuff: unavailable }, trace: unavailable, addEntity: unavailable, addLight: unavailable,
    addPoly: unavailable, lightForPoint: unavailable, marks: { impactMark: unavailable }, addLoopingSound: unavailable, addPlayerWeapon: unavailable, print: text => tools.trace.push(["print", text]) });
  const cvars = new CvarRegistry(); cvars.register("cg_paused", "0"); cvars.register("cg_drawIcons", "1");
  const config = { motd: "Fixture MOTD" };
  const host = { icons, clients, players, readVmCvar: (name: "cg_paused" | "cg_drawIcons") => { const value = cvars.get(name); if (value === undefined) throw new Error("Missing fixture cvar"); return value; },
    configString: (index: number) => { expect(index).toBe(4); return config.motd; }, sendClientCommand: (text: string) => tools.trace.push(["command", text]), print: (text: string) => tools.trace.push(["print", text]) };
  return { state, cgs, ps, resources, media, tools, commands, cpu, gl, recording, options, cvars, clients, players, host, config, scoreboard: new BaseScoreboard(state, cgs, host) };
}

describe("source base scoreboard", () => {
  test("classic mission scoreboard keeps offense and defense task icons in both row sizes", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const count of [3, 8]) {
        const f = await fixture(count, syntheticAssets(), false, product);
        const offense = await f.resources.registerShaderNoMip("icons/offense.tga"), defense = await f.resources.registerShaderNoMip("icons/defense.tga");
        if (offense === null || defense === null) throw new Error("Missing task icons");
        f.media.graphics.assaultShader = offense; f.media.graphics.defendShader = defense;
        f.tools.shaderIds.set(offense, 401); f.tools.shaderIds.set(defense, 402);
        cell(f.cgs.clientInfo, 0).teamTask = 1; cell(f.cgs.clientInfo, 1).teamTask = 2; cell(f.cgs.clientInfo, 2).teamTask = 3;
        expect(await f.scoreboard.draw()).toBe(true);
        const tasks = f.tools.trace.filter(row => row[0] === "pic" && (row[5] === 401 || row[5] === 402));
        expect(tasks).toEqual(product === "missionpack" ? [["pic", 160, 118, 16, 16, 401], ["pic", 160, count === 3 ? 158 : 134, 16, 16, 402]] : []);
      }
    }
  });
  test("pause, single-player intermission, warmup and fade timeout preserve distinct side effects", async () => {
    const f = await fixture(); f.state.deferredPlayerLoading = 9; f.state.killerName = "Enemy"; f.cvars.set("cg_paused", "1");
    expect(await f.scoreboard.draw()).toBe(false); expect(f.state.deferredPlayerLoading).toBe(0); expect(f.state.killerName).toBe("Enemy");
    f.cvars.set("cg_paused", "0"); f.cgs.gameType = GameType.GT_SINGLE_PLAYER; f.state.predictedPlayerState.pmType = MoveType.PM_INTERMISSION; f.state.deferredPlayerLoading = 9;
    expect(await f.scoreboard.draw()).toBe(false); expect(f.state.deferredPlayerLoading).toBe(0);
    f.cgs.gameType = GameType.GT_FFA; f.state.showScores = false; f.state.warmup = -1; f.state.deferredPlayerLoading = 9;
    expect(await f.scoreboard.draw()).toBe(false); expect(f.state.deferredPlayerLoading).toBe(9);
    f.state.warmup = 0; f.state.predictedPlayerState.pmType = MoveType.PM_NORMAL; f.state.scoreFadeTime = 800;
    expect(await f.scoreboard.draw()).toBe(false); expect(f.state.deferredPlayerLoading).toBe(0); expect(f.state.killerName).toBe(""); expect(f.tools.trace).toEqual([]);
    f.state.predictedPlayerState.pmType = MoveType.PM_DEAD;
    expect(await f.scoreboard.draw()).toBe(true); expect(f.tools.trace.length).toBeGreaterThan(0);
  });
  test("fade uses source RGB dereference while the forced local READY label gets actual fading alpha", async () => {
    const f = await fixture(20); f.state.showScores = false; f.state.scoreFadeTime = 900; f.ps.clientNum = 19;
    f.ps.stats.set(statSchema("baseq3").clientsReady, 1 << 19);
    expect(await f.scoreboard.draw()).toBe(true);
    const rows = f.tools.trace.filter(row => row[0] === "big" && typeof row[3] === "string" && row[3].includes("Player"));
    expect(rows).toHaveLength(18); expect(rows.every(row => row[4] === float32ToBits(1))).toBe(true);
    expect(rows.at(-1)?.[2]).toBe(422);
    expect(f.tools.trace.find(row => row[0] === "bigcolor")).toEqual(["bigcolor", 80, 422, "READY", colorBits(vec4(1, 1, 1, 0.5))]);
  });
  test("normal versus compact row limits, missing local score and canonical info teams", async () => {
    for (const count of [7, 8, 18]) {
      const f = await fixture(count); f.ps.clientNum = 63;
      for (let i = 0; i < count; i++) cell(f.state.scores, i).team = Team.TEAM_SPECTATOR;
      expect(await f.scoreboard.draw()).toBe(true);
      const heads = f.tools.trace.filter(row => row[0] === "head"); expect(heads).toHaveLength(Math.min(count, count > 7 ? 17 : 7));
      expect(heads[0]?.slice(1, 5)).toEqual(count > 7 ? [112, 118, 16, 16] : [112, 102, 48, 48]);
    }
  });
  test("rank highlight uses snapshot rank, team and tied flag rather than row order", async () => {
    for (const [rank, expected] of [[0, vec4(0, 0, 0.7, 0.7)], [1, vec4(0.7, 0, 0, 0.7)], [2, vec4(0.7, 0.7, 0, 0.7)],
      [3, vec4(0.7, 0.7, 0.7, 0.7)], [0x4000, vec4(0, 0, 0.7, 0.7)]] satisfies readonly (readonly [number, Vec4])[]) {
      const f = await fixture(1); f.ps.persistant.set(PersistentIndex.PERS_RANK, rank);
      await f.scoreboard.draw();
      expect(f.tools.trace.find(row => row[0] === "fill")?.[5]).toEqual(colorBits(expected));
    }
    const spectator = await fixture(1); spectator.ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_SPECTATOR);
    cell(spectator.cgs.clientInfo, 0).team = Team.TEAM_SPECTATOR;
    await spectator.scoreboard.draw();
    expect(spectator.tools.trace.find(row => row[0] === "fill")?.[5]).toEqual(colorBits(vec4(0.7, 0.7, 0.7, 0.7)));
    expect(spectator.tools.trace.some(row => row[0] === "big" && row[2] === 60)).toBe(false);
    expect(spectator.tools.trace.find(row => row[0] === "big")?.[3]).toBe(" SPECT  20    3 Player0");
  });
  test("flag priority, bot icons, handicap, tournament records and source warning count", async () => {
    const f = await fixture(4); f.cgs.gameType = GameType.GT_TOURNAMENT;
    Object.assign(cell(f.cgs.clientInfo, 0), { powerups: (1 << Powerup.PW_NEUTRALFLAG) | (1 << Powerup.PW_REDFLAG), handicap: 25, botSkill: 5 });
    Object.assign(cell(f.cgs.clientInfo, 1), { botSkill: 3, handicap: 25, wins: 2, losses: 1 });
    Object.assign(cell(f.cgs.clientInfo, 2), { handicap: 50, wins: 3, losses: 2 });
    f.cgs.maxclients = 3;
    await f.scoreboard.draw();
    expect(f.tools.trace.find(row => row[0] === "flag")).toEqual(["flag", 80, 110, 32, 32, Team.TEAM_FREE, 0]);
    expect(f.tools.trace.filter(row => row[0] === "smallcolor").map(row => row.slice(1, 4))).toEqual([[80, 158, "2/1"], [80, 190, "50"], [80, 206, "3/2"]]);
    expect(f.tools.trace.at(-1)).toEqual(["print", "Bad score->client: 3\n"]);
  });
  test("team rows precede their background and the winning blue team comes first", async () => {
    const f = await fixture(3); f.cgs.gameType = GameType.GT_TEAM; f.state.teamScores[0] = 2; f.state.teamScores[1] = 3;
    cell(f.cgs.clientInfo, 0).team = Team.TEAM_RED; cell(f.cgs.clientInfo, 1).team = Team.TEAM_BLUE; cell(f.cgs.clientInfo, 2).team = Team.TEAM_SPECTATOR;
    await f.scoreboard.draw();
    expect(f.tools.trace[0]).toEqual(["big", 184, 60, "Blue leads 3 to 2", float32ToBits(1)]);
    expect(f.tools.trace.filter(row => row[0] === "head").map(row => row[5])).toEqual([1, 0, 2]);
    const background = f.tools.trace.findIndex(row => row[0] === "team");
    expect(f.tools.trace[background - 1]?.[0]).toBe("big"); expect(f.tools.trace[background]?.slice(1)).toEqual([0, 122, 640, 56, float32ToBits(0.33), Team.TEAM_BLUE]);
  });
  test("tourney score requests use strict signed timeout, fallback title and source black row text", async () => {
    const f = await fixture(2); f.state.time = 2000; f.config.motd = ""; f.scoreboard.drawTourney();
    expect(f.tools.trace.some(row => row[0] === "command")).toBe(false);
    expect(f.tools.trace[1]?.[3]).toBe("Scoreboard");
    expect(f.tools.trace.filter(row => row[0] === "ext" && typeof row[2] === "number" && row[2] >= 160).every(row => JSON.stringify(row[4]) === JSON.stringify(colorBits(vec4(0, 0, 0, 1))))).toBe(true);
    f.state.time = 2001; f.scoreboard.drawTourney(); expect(f.state.scoresRequestTime).toBe(2001);
    expect(f.tools.trace.filter(row => row[0] === "command")).toEqual([["command", "score"]]);
    f.state.scoresRequestTime = 0x7fffffff; f.state.time = -2147483647; f.scoreboard.drawTourney();
    expect(f.state.scoresRequestTime).toBe(0x7fffffff);
    f.state.time = -2147481649; f.scoreboard.drawTourney(); expect(f.state.scoresRequestTime).toBe(0x7fffffff);
    f.state.time++; f.scoreboard.drawTourney(); expect(f.state.scoresRequestTime).toBe(-2147481648);
  });
  test("empty scoreboard does not invent rows and deferred loading stays at its source site", async () => {
    const f = await fixture(0); f.state.deferredPlayerLoading = 10;
    expect(await f.scoreboard.draw()).toBe(true); expect(f.clients.loads).toEqual([11]);
    expect(f.tools.trace.filter(row => row[0] === "head")).toEqual([]);
    expect(f.tools.trace.at(-1)).toEqual(["deferred", 11]);
    expect(await f.scoreboard.draw()).toBe(true); expect(f.clients.loads).toEqual([11, 12]);
    f.state.deferredPlayerLoading = 0x7fffffff; await f.scoreboard.draw(); expect(f.state.deferredPlayerLoading).toBe(-2147483648);
    expect(f.clients.loads).toEqual([11, 12]);
  });
  test("old layout rejects mismatched product and instance ownership explicitly", async () => {
    const f = await fixture();
    expect(() => new BaseScoreboard(new ClientGameState("missionpack", 0, 0), f.cgs, f.host)).toThrow("products differ");
    expect(() => new BaseScoreboard(new ClientGameState("baseq3", 0, 0), f.cgs, f.host)).toThrow("canonical");
  });
});

const reference = "/tmp/quake3-scoreboard-reference-9vKyBY/reference";
test.skipIf(!existsSync(reference))("untouched original scoreboard command traces match actual TypeScript draw calls", async () => {
  for (const mode of [0, 1, 2, 3]) {
    const f = await fixture(mode === 0 ? 3 : mode === 1 ? 18 : mode === 2 ? 20 : 2);
    if (mode === 0) {
      f.state.killerName = "^1Enemy"; f.ps.persistant.set(PersistentIndex.PERS_RANK, 1); f.ps.persistant.set(PersistentIndex.PERS_SCORE, 42);
      cell(f.cgs.clientInfo, 1).botSkill = 3; cell(f.cgs.clientInfo, 2).team = Team.TEAM_SPECTATOR; cell(f.state.scores, 2).ping = -1; f.ps.stats.set(statSchema("baseq3").clientsReady, 1);
    } else if (mode === 1) {
      f.cgs.gameType = GameType.GT_CTF; f.state.teamScores[0] = 5; f.state.teamScores[1] = 6; f.ps.clientNum = 17; f.ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_RED);
      for (let i = 0; i < 18; i++) cell(f.cgs.clientInfo, i).team = i < 9 ? Team.TEAM_BLUE : i < 17 ? Team.TEAM_RED : Team.TEAM_SPECTATOR;
      cell(f.cgs.clientInfo, 0).powerups = 1 << Powerup.PW_BLUEFLAG; f.state.deferredPlayerLoading = 10;
    } else if (mode === 2) {
      f.state.showScores = false; f.state.scoreFadeTime = 900; f.ps.clientNum = 19; f.ps.persistant.set(PersistentIndex.PERS_RANK, 2);
      f.ps.stats.set(statSchema("baseq3").clientsReady, 1 << 19); f.cgs.gameType = GameType.GT_TOURNAMENT;
      Object.assign(cell(f.cgs.clientInfo, 19), { handicap: 50, wins: 3, losses: 2 });
    } else { f.state.time = 123456; cell(f.cgs.clientInfo, 1).team = Team.TEAM_SPECTATOR; }
    if (mode === 3) { f.scoreboard.drawTourney(); f.tools.trace.push(["state", f.state.scoresRequestTime]); }
    else { f.tools.trace.push(["result", Number(await f.scoreboard.draw())]); f.tools.trace.push(["state", f.state.deferredPlayerLoading]); }
    const run = Bun.spawnSync([reference, String(mode)]); expect(run.exitCode).toBe(0);
    expect(f.tools.trace.map(row => JSON.stringify(row)).join("\n")).toBe(new TextDecoder().decode(run.stdout).trim());
  }
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail scoreboard heads render ordered CPU/GL views and real deferred players finish after the eleventh frame", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const retail = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" }), barrier = Promise.withResolvers<void>(), reachedVisor = Promise.withResolvers<void>();
  let blockVisor = false;
  const assets: RetainedFileReader & SoundAssetReader & SourceFileReader = { list: prefix => retail.list(prefix), has: path => retail.has(path), readSync: path => retail.readSync(path),
    async readFileRetained(path) { if (blockVisor && path === "models/players/visor/lower.md3") { reachedVisor.resolve(); await barrier.promise; } return retail.readFileRetained(path); },
    readFileRetainedSync: path => retail.readFileRetainedSync(path), freeFile: buffer => { retail.freeFile(buffer); },
    read: path => retail.read(path),
    readFileLength: path => retail.readFileLength(path),
    async readFileOptional(path) { if (blockVisor && path === "models/players/visor/lower.md3") { reachedVisor.resolve(); await barrier.promise; } return retail.readFileOptional(path); },
    readFileOptionalSync: path => retail.readFileOptionalSync(path) };
  const f = await fixture(3, assets, process.env["QUAKE_GL_TEST"] === "1");
  f.commands.addView({ viewport: { x: 0, y: 0, width: 640, height: 480 }, clear: { stencil: false, depth: 1, color: vec4(0.1, 0.1, 0.1, 1) }, operations: [{ kind: "draw", batches: [] }] });
  await f.clients.newClientInfo(0, "\\n\\^1Sarge\\t\\0\\model\\sarge/default\\hmodel\\sarge/default");
  const ci = cell(f.cgs.clientInfo, 0); expect(ci.headModel.kind).toBe("md3");
  f.options.draw3dIcons = true;
  Object.assign(cell(f.cgs.clientInfo, 1), { ...ci, name: "Deferred", modelName: "visor", headModelName: "visor", deferred: true });
  const entity = f.state.entityAt(1); entity.currentState.eType = EntityType.ET_PLAYER; entity.currentState.clientNum = 1; entity.errorTime = 123;
  for (let i = 0; i < 10; i++) expect(await f.scoreboard.draw()).toBe(true);
  expect(f.clients.loads).toEqual([]); expect(cell(f.cgs.clientInfo, 1).deferred).toBe(true); expect(entity.errorTime).toBe(123);
  blockVisor = true;
  let completed = false;
  const pending = f.scoreboard.draw().then(result => { completed = true; return result; });
  await reachedVisor.promise;
  expect(completed).toBe(false); expect(cell(f.cgs.clientInfo, 1).deferred).toBe(true);
  f.commands.submit();
  const submitted = f.recording.trace().filter(view => view.state.clear !== null && view.batches.length > 0);
  const geometry = () => JSON.stringify(submitted.map(view => view.batches.map(batch => [batch.vertices, batch.indices])));
  const submittedBeforeLoad = geometry();
  expect(submitted).toHaveLength(22);
  barrier.resolve(); expect(await pending).toBe(true);
  expect(f.clients.loads).toEqual([11]); expect(cell(f.cgs.clientInfo, 1).deferred).toBe(false); expect(entity.errorTime).toBe(-99999);
  expect(cell(f.cgs.clientInfo, 1).headModel.path).toBe("models/players/visor/head.md3");
  expect(geometry()).toBe(submittedBeforeLoad);
  f.commands.close("require-empty");
  const cpu = f.cpu;
  expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 50).length).toBeGreaterThan(1000);
  const gl = f.gl; if (gl === null) return;
  const pixels = gl.readPixels(); let error = 0;
  for (const [i, value] of pixels.entries()) { const expected = cpu.pixels[i]; if (expected === undefined) throw new Error("Missing CPU pixel"); error += Math.abs(value - expected); }
  expect(error / pixels.length).toBeLessThan(2);
}, 30000);
