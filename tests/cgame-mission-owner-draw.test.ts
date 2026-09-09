import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ClientConfiguration } from "../src/cgame/config.ts";
import { ClientDrawIcons } from "../src/cgame/draw-icons.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { MissionOwnerDraw, MissionOwnerDrawId as ID, MissionOwnerDrawFlags as SHOW } from "../src/cgame/mission-owner-draw.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { Vec3, Vec4 } from "../src/core/math.ts";
import { encodePng } from "../src/core/png.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SOURCE_COMMAND_RELEASE32 } from "../src/render/command-memory.ts";
import { Draw2D } from "../src/render/draw2d.ts";
import type { Rect2D, TextureRect, PictureAsset } from "../src/render/draw2d.ts";
import { UiAssetRegistry } from "../src/render/font.ts";
import type { FontSet, RegisteredFont } from "../src/render/font.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RendererResources } from "../src/render/world.ts";
import { GameType, MissionpackStatIndex as STAT, PersistentIndex as PERS, Powerup, Team } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { itemList } from "../src/shared/items.ts";
import type { UiOwnerDrawPaintRequest } from "../src/ui/runtime.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 }, rect = { x: 17.75, y: 23.5, width: 120.25, height: 31.75 };
function cell<T>(values: readonly T[], i: number): T { const value = values[i]; if (value === undefined) throw new Error(`Missing fixture ${i}`); return value; }
interface DrawTrace { pictures: { readonly rect: Rect2D; readonly name: string; readonly color: Vec4 | null }[]; colors: (Vec4 | null)[]; retained: Vec4 | null }
const traces = new WeakMap<Draw2D, DrawTrace>();
function trace(draw: Draw2D): DrawTrace {
  const cached = traces.get(draw); if (cached !== undefined) return cached;
  const state: DrawTrace = { pictures: [], colors: [], retained: null }; traces.set(draw, state); return state;
}
class TraceDraw extends Draw2D {
  get pictures() { return trace(this).pictures; }
  get colors() { return trace(this).colors; }
  override setColor(color: Vec4 | null): void { const state = trace(this); state.retained = color === null ? null : { ...color }; state.colors.push(state.retained); super.setColor(color); }
  override stretchPic(rect: Rect2D, uv: TextureRect, picture: Parameters<Draw2D["stretchPic"]>[2]): void {
    const ownedRect = { ...rect }, color = trace(this).retained;
    const record = (resolved: PictureAsset): PictureAsset => {
      this.pictures.push({ rect: ownedRect, name: resolved.name, color }); return resolved;
    };
    super.stretchPic(rect, uv, typeof picture === "function" ? () => record(picture()) : record(picture));
  }
  resetTrace(): void { this.commands.submit(); this.pictures.length = 0; this.colors.length = 0; }
}
class TraceIcons extends ClientDrawIcons {
  readonly heads: { readonly rect: Rect2D; readonly client: number; readonly angles: Vec3 }[] = [];
  override drawHead(rect: Rect2D, client: number, angles: Vec3): void {
    this.heads.push({ rect: { ...rect }, client, angles: { ...angles } }); super.drawHead(rect, client, angles);
  }
}
function syntheticAssets(): RetainedFileReader & SoundAssetReader & SourceFileReader {
  const bytes = new Uint8Array(22); bytes[2] = 2; bytes[12] = 1; bytes[14] = 1; bytes[16] = 32; bytes[17] = 0x20; bytes.fill(255, 18);
  const read = (path: string): Uint8Array => { if (!path.endsWith(".tga")) throw new Error(`Unexpected fixture asset ${path}`); return bytes; };
  return withRetainedFiles<SoundAssetReader & SourceFileReader>({ has: path => path.endsWith(".tga"), list: () => [], read: async path => read(path), readSync: read,
    readFileLength: path => path.endsWith(".tga") ? bytes.byteLength : -1,
    readFileOptional: async path => path.endsWith(".tga") ? bytes : undefined,
    readFileOptionalSync: path => path.endsWith(".tga") ? bytes : undefined });
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(assets: RetainedFileReader & SoundAssetReader & SourceFileReader = syntheticAssets(), random = new GameRandom(0), window: SdlWindow | null = null) {
  const state = new ClientGameState("missionpack", 7, 0), cgs = new ClientGameStaticState("missionpack");
  const images = new RendererImageCatalog(), gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(1280, 720, images, gl?.subpixelBits ?? 8), recording = new BatchRecordingBackend(cpu);
  const target = gl === null ? new RenderTarget(images, [recording]) : new RenderTarget(images, [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => state.time };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096, inGameVideo: () => 1 } });
  const actual = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const registrations: string[] = [];
  const resources: RendererResources = { ...actual, registerShader: async name => { registrations.push(name); return actual.registerShader(name); } };
  const soundDebugMessages: string[] = [];
  const media = new ClientMedia("missionpack", cgs, resources, new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => {} }));
  const ps = createPlayerState("missionpack"); ps.clientNum = 7; ps.stats.set(STAT.STAT_HEALTH, 80); ps.stats.set(STAT.STAT_ARMOR, 33); ps.persistant.set(PERS.PERS_TEAM, Team.TEAM_RED); ps.persistant.set(PERS.PERS_SCORE, 13);
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: ps, entities: [] };
  state.predictedPlayerState = ps.copy(); state.time = 1000; cgs.gameType = GameType.GT_CTF; cgs.maxclients = 8;
  state.numSortedTeamPlayers = 2; state.sortedTeamPlayers[0] = 3; state.sortedTeamPlayers[1] = 5;
  Object.assign(cell(cgs.clientInfo, 3), { infoValid: true, team: Team.TEAM_RED, health: 33, armor: 20, location: 1, name: "^1Alpha" });
  Object.assign(cell(cgs.clientInfo, 5), { infoValid: true, team: Team.TEAM_RED, health: 80, location: 2, name: "Beta" });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  const draw = new TraceDraw(commands, "stretch-640"), tools = new ClientDrawTools(draw, media), cvars = new CvarRegistry();
  const configuration = new ClientConfiguration("missionpack", { state, staticState: cgs, cvars, clients: { newClientInfo: async () => { throw new Error("Unexpected client load"); } }, configString: () => "" });
  configuration.registerCvars();
  const icons = new TraceIcons(state, tools, () => ({ drawIcons: configuration.readVmCvar("cg_drawIcons").integerValue !== 0, draw3dIcons: configuration.readVmCvar("cg_draw3dIcons").integerValue !== 0 }), commands);
  const shader = await resources.registerShaderNoMip("fixture/picture"), picture = resources.picture(shader);
  media.graphics.armorIcon = shader; media.graphics.heartShader = shader; media.graphics.assaultShader = shader;
  media.graphics.flagShaders[0] = shader; media.graphics.flagShaders[1] = shader; media.graphics.flagShaders[2] = shader;
  function font(glyphScale: number): RegisteredFont {
    return { name: "numeric source fixture", glyphScale, glyphs: Array.from({ length: 256 }, (_, i) => ({
      height: 10, top: 8, bottom: 0, pitch: 0, xSkip: 7 + i % 3, imageWidth: 8, imageHeight: 12,
      s: 0, t: 0, s2: 1, t2: 1, shaderName: "fixture/picture", picture: { ...picture, name: `glyph/${i}` },
    })) };
  }
  const fonts: { value: FontSet } = { value: { small: font(0.75), normal: font(1.25), big: font(1.5), profile: "cgame", smallThreshold: 0.25, bigThreshold: Math.fround(0.4) } };
  const configs: number[] = [], messages = { system: "system", team1: "team one", team2: "team two" };
  const owner = new MissionOwnerDraw(state, cgs, media, { icons, fonts: () => fonts.value, configuration, random,
    configString: i => { configs.push(i); return i === 609 ? "Long corridor" : i === 610 ? "Base" : ""; },
    selectedPlayer: () => configuration.readVmCvar("cg_currentSelectedPlayer").integerValue, chat: () => messages });
  const request = (ownerDraw: number, changes: Partial<UiOwnerDrawPaintRequest> = {}): UiOwnerDrawPaintRequest => ({ draw, rect, ownerDraw, ownerDrawFlags: 0,
    textX: 4.5, textY: 11.75, alignment: 0, special: 13.75, textScale: Math.fround(0.3), color: white, background: undefined, textStyle: 0, ...changes });
  async function set(name: string, value: string): Promise<void> { cvars.set(name, value); await configuration.updateCvars(); }
  cleanups.push(() => { commands.close("discard"); cinematics.dispose(); target.close(); window?.close(); });
  return { state, cgs, ps, media, resources, draw, tools, commands, icons, owner, request, set, random, configs, fonts, registrations, picture, shader, cpu, gl, recording };
}

test("source getvalue and first-return visibility precedence use canonical snapshot and raw selected-player cvar", async () => {
  const v = await fixture();
  expect([2, 4, 6, 20, 27, 28, 40, 41, 999].map(id => v.owner.value(id))).toEqual([33, 80, -1, 13, 0, 0, 20, 33, -1]);
  v.state.entityAt(7).currentState.weapon = 3; v.ps.ammo.set(3, -1); expect(v.owner.value(6)).toBe(-1);
  v.ps.ammo.set(3, 16777217); expect(v.owner.value(6)).toBe(16777216);
  expect(v.owner.visible(SHOW.CG_SHOW_TEAMINFO | SHOW.CG_SHOW_ANYTEAMGAME)).toBe(false);
  expect(v.owner.visible(SHOW.CG_SHOW_HARVESTER | SHOW.CG_SHOW_HEALTHOK)).toBe(false);
  expect(v.owner.visible(SHOW.CG_SHOW_CTF | SHOW.CG_SHOW_HARVESTER)).toBe(false);
  expect(v.owner.visible(SHOW.CG_SHOW_CTF | SHOW.CG_SHOW_HEALTHCRITICAL)).toBe(true);
  await v.set("cg_currentSelectedPlayer", "2"); expect(v.owner.visible(SHOW.CG_SHOW_TEAMINFO | SHOW.CG_SHOW_NOTEAMINFO)).toBe(true);
  for (const flags of [0, SHOW.CG_SHOW_DURINGINCOMINGVOICE, SHOW.CG_SHOW_LANPLAYONLY, SHOW.CG_SHOW_MINED, SHOW.CG_SHOW_2DONLY]) expect(v.owner.visible(flags)).toBe(false);
  v.cgs.redflag = 1; expect(v.owner.otherTeamHasFlag()).toBe(true); expect(v.owner.yourTeamHasFlag()).toBe(false);
  v.cgs.gameType = GameType.GT_1FCTF; v.cgs.flagStatus = 2; expect(v.owner.otherTeamHasFlag()).toBe(false); expect(v.owner.yourTeamHasFlag()).toBe(true);
});
test("source health number centers integer text and owner dispatch does not apply visibility flags", async () => {
  const v = await fixture(); await v.owner.paint(v.request(ID.CG_PLAYER_HEALTH, { ownerDrawFlags: SHOW.CG_SHOW_HARVESTER }));
  const glyph = cell(v.draw.pictures, 0);
  // Source fixture: width('80',.3)=6; (120.25-6)/2+17.75=74.875, baseline55.25-top3.
  expect(glyph.rect).toEqual({ x: 74.875, y: 52.25, width: 3, height: 4.5 }); expect(glyph.name).toBe("glyph/56");
  v.draw.resetTrace(); await v.set("cg_drawStatus", "0");
  for (let id = 0; id <= 80; id++) await v.owner.paint(v.request(id, { background: () => { throw new Error("Disabled owner draw resolved its background"); } }));
  expect(v.draw.pictures).toHaveLength(0); expect(v.icons.heads).toHaveLength(0);
});

test("source owner-draw branches leave unused backgrounds unresolved", async () => {
  const v = await fixture(); let lookups = 0;
  const background = (): PictureAsset => { lookups++; return v.picture; };
  for (const id of [ID.CG_GAME_TYPE, ID.CG_RED_SCORE, ID.CG_BLUE_SCORE, ID.CG_PLAYER_AMMO_VALUE, 999]) {
    await v.owner.paint(v.request(id, { background }));
  }
  v.state.entityAt(7).currentState.weapon = 3; v.ps.ammo.set(3, -1);
  await v.owner.paint(v.request(ID.CG_PLAYER_AMMO_VALUE, { background }));
  cell(v.cgs.clientInfo, 3).armor = 0;
  await v.owner.paint(v.request(ID.CG_SELECTEDPLAYER_ARMOR, { background }));
  for (const gameType of [GameType.GT_FFA, GameType.GT_HARVESTER]) {
    v.cgs.gameType = gameType;
    await v.owner.paint(v.request(ID.CG_BLUE_FLAGSTATUS, { background }));
    await v.owner.paint(v.request(ID.CG_RED_FLAGSTATUS, { background }));
  }
  expect(lookups).toBe(0);
});

test("owner background draws reserve before reentrant lookup and skip lookup on overflow", async () => {
  const v = await fixture(), red = { x: 1, y: 0, z: 0, w: 1 }, green = { x: 0, y: 1, z: 0, w: 1 };
  const colors = Math.floor((SOURCE_COMMAND_RELEASE32.capacity - SOURCE_COMMAND_RELEASE32.endBytes) / SOURCE_COMMAND_RELEASE32.setColorBytes);
  for (const id of [ID.CG_PLAYER_HEALTH, ID.CG_BLUE_FLAGSTATUS, ID.CG_RED_FLAGSTATUS, ID.CG_ACCURACY]) {
    v.draw.resetTrace(); v.cpu.pixels.fill(0); cell(v.state.scores, 0).accuracy = 51;
    v.draw.setColor(red); let lookups = 0;
    await v.owner.paint(v.request(id, { rect: { x: 8, y: 8, width: -8, height: -8 }, color: red, background: () => {
      lookups++; v.draw.setColor(green);
      v.draw.drawPic({ x: 16, y: 0, width: 8, height: 8 }, v.picture);
      cell(v.state.scores, 0).accuracy = 0;
      return v.picture;
    } }));
    expect(v.commands.submitFrame()).not.toBeNull();
    expect(lookups).toBe(1);
    expect(Array.from(v.cpu.pixels.subarray((2 * 1280 + 2) * 4, (2 * 1280 + 2) * 4 + 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(v.cpu.pixels.subarray((2 * 1280 + 36) * 4, (2 * 1280 + 36) * 4 + 4))).toEqual([0, 255, 0, 255]);
    if (id === ID.CG_ACCURACY) expect(v.draw.pictures.slice(2).map(picture => picture.name)).toEqual(["glyph/53", "glyph/49", "glyph/37"]);
    for (let index = 0; index < colors; index++) v.draw.setColor(null);
    await v.owner.paint(v.request(id, { background: () => { lookups++; return v.picture; } }));
    expect(lookups).toBe(1);
    expect(v.commands.submit().commands).toBe(colors);
  }
});

test("absent backgrounds keep source zero branches while resolved default pictures still draw", async () => {
  const v = await fixture();
  await v.owner.paint(v.request(ID.CG_PLAYER_HEALTH));
  expect(v.draw.pictures.map(picture => picture.name)).toEqual(["glyph/56", "glyph/48"]);
  v.draw.resetTrace(); await v.owner.paint(v.request(ID.CG_BLUE_FLAGSTATUS));
  expect(cell(v.draw.pictures, 0)).toEqual({ rect, name: "fixture/picture", color: { x: 0, y: 0, z: 1, w: 1 } });
  v.draw.resetTrace(); await v.owner.paint(v.request(ID.CG_ACCURACY));
  expect(cell(v.draw.pictures, 0)).toEqual({ rect, name: "<default>", color: { ...white, w: 0.25 } });
  v.draw.resetTrace(); await v.owner.paint(v.request(ID.CG_PLAYER_HEALTH, { background: () => v.resources.picture(null) }));
  expect(v.draw.pictures.map(picture => picture.name)).toEqual(["<default>"]);
});

test("team name leaves and widths read source engine cvar names through the real VM cache", async () => {
  const v = await fixture(); await v.set("g_redteam", "Red Team"); await v.set("g_blueteam", "Blue Team");
  expect(v.owner.width(ID.CG_RED_NAME, 0.3)).toBe(24); expect(v.owner.width(ID.CG_BLUE_NAME, 0.3)).toBe(26);
  await v.owner.paint(v.request(ID.CG_RED_NAME));
  expect(v.draw.pictures.map(p => p.name)).toEqual(Array.from("Red Team", character => `glyph/${character.charCodeAt(0)}`));
});
test("armor force2D bypasses icon toggles and applies the source half-height vertical offset", async () => {
  const v = await fixture(); await v.set("cg_drawIcons", "0"); await v.set("cg_draw3dIcons", "0");
  await v.owner.paint(v.request(ID.CG_PLAYER_ARMOR_ICON)); expect(v.draw.pictures).toHaveLength(0);
  await v.owner.paint(v.request(ID.CG_PLAYER_ARMOR_ICON2D)); expect(cell(v.draw.pictures, 0).rect).toEqual({ ...rect, y: 40.375 });
});
test("flag heads preserve source client zero, and one-flag status deliberately retains color", async () => {
  const v = await fixture(), ci = cell(v.cgs.clientInfo, 3); ci.powerups = 1 << Powerup.PW_BLUEFLAG;
  await v.owner.paint(v.request(ID.CG_BLUE_FLAGHEAD)); ci.team = Team.TEAM_BLUE; ci.powerups = 1 << Powerup.PW_REDFLAG;
  await v.owner.paint(v.request(ID.CG_RED_FLAGHEAD)); expect(v.icons.heads.map(head => head.client)).toEqual([0, 0]);
  v.cgs.gameType = GameType.GT_1FCTF; v.cgs.flagStatus = 2; v.draw.resetTrace();
  await v.owner.paint(v.request(ID.CG_ONEFLAG_STATUS)); expect(v.draw.colors).toEqual([{ x: 1, y: 0, z: 0, w: 1 }]);
  v.tools.drawPic(rect, v.shader); expect(cell(v.draw.pictures, 1).color).toEqual({ x: 1, y: 0, z: 0, w: 1 });
});
test("medals use source .25 alpha, strict >50 accuracy, and opaque text baseline +10", async () => {
  const v = await fixture(), score = cell(v.state.scores, 0);
  for (const accuracy of [0, 50, 51]) {
    score.accuracy = accuracy; v.draw.resetTrace(); await v.owner.paint(v.request(ID.CG_ACCURACY, { background: v.picture }));
    expect(cell(v.draw.pictures, 0).color?.w).toBe(accuracy > 50 ? 1 : 0.25);
    if (accuracy > 0) { expect(cell(v.draw.pictures, 1).color?.w).toBe(1); expect(cell(v.draw.pictures, 1).rect.y).toBe(62.25); }
    else expect(v.draw.pictures).toHaveLength(1);
  }
  score.perfect = 1; v.draw.resetTrace(); await v.owner.paint(v.request(ID.CG_PERFECT, { background: v.picture }));
  expect(v.draw.pictures.slice(1).map(p => p.name)).toEqual(["glyph/87", "glyph/111", "glyph/119"]);
});
test("source draw-time registration only runs at reached leaves, with equal expiry order reversed", async () => {
  const v = await fixture(); const items = itemList("missionpack"), medkit = items.findIndex(item => item.className === "holdable_medkit");
  v.ps.stats.set(STAT.STAT_HOLDABLE_ITEM, medkit); v.registrations.length = 0;
  await v.owner.paint(v.request(ID.CG_GAME_TYPE)); expect(v.registrations).toHaveLength(0);
  await v.set("cg_drawStatus", "0"); await v.owner.paint(v.request(ID.CG_PLAYER_ITEM)); expect(v.registrations).toHaveLength(0);
  await v.set("cg_drawStatus", "1"); await v.owner.paint(v.request(ID.CG_PLAYER_ITEM)); expect(v.registrations).toEqual(["icons/medkit"]);
  v.ps.powerups.set(Powerup.PW_QUAD, 3500); v.ps.powerups.set(Powerup.PW_HASTE, 3500); v.draw.resetTrace(); v.registrations.length = 0;
  await v.owner.paint(v.request(ID.CG_AREA_POWERUP));
  expect(v.registrations).toEqual(["icons/haste", "icons/quad"]);
  expect(cell(v.draw.pictures, 0).color).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
  expect(cell(v.draw.pictures, 2).rect.y).toBe(157.5);
});
test("spectator scrolling stores source paint state and honors strict ten-millisecond deadline", async () => {
  const v = await fixture(); v.state.spectatorList = "AB CD"; v.state.spectatorLen = 5; v.state.spectatorWidth = -1;
  await v.owner.paint(v.request(ID.CG_SPECTATORS));
  expect([v.state.spectatorOffset, v.state.spectatorTime, v.state.spectatorPaintX, v.state.spectatorPaintX2]).toEqual([1, 1010, 20, 136]);
  v.state.time = 1010; await v.owner.paint(v.request(ID.CG_SPECTATORS)); expect(v.state.spectatorPaintX).toBe(20);
  v.state.time = 1011; await v.owner.paint(v.request(ID.CG_SPECTATORS)); expect(v.state.spectatorPaintX).toBe(19);
  v.state.spectatorOffset = 6; await v.owner.paint(v.request(ID.CG_SPECTATORS)); expect(v.state.spectatorOffset).toBe(0); expect(v.state.spectatorPaintX).toBe(18);
});
test("team info visits source location inventory before rows, clips against absolute width, and uses width-driven columns", async () => {
  const v = await fixture(); await v.set("cg_currentSelectedPlayer", "2"); await v.owner.paint(v.request(ID.CG_TEAMINFO));
  expect(v.configs.slice(0, 63)).toEqual(Array.from({ length: 63 }, (_, i) => 609 + i));
  expect(v.configs.slice(63)).toEqual([609, 610]);
  expect(cell(v.draw.pictures, 0).rect).toEqual({ x: 55, y: 24.5, width: 10, height: 10 });
  expect(cell(v.draw.pictures, 1).rect).toEqual({ x: 68, y: 23.5, width: 12, height: 12 });
  expect(cell(v.draw.pictures, 2).rect.x).toBe(81);
});

test("killer centering truncates both the rect center and integer text-width half", async () => {
  const v = await fixture(); v.state.killerName = "A";
  await v.owner.paint(v.request(ID.CG_KILLER));
  expect(v.owner.width(ID.CG_KILLER, Math.fround(0.3))).toBe(37);
  expect(cell(v.draw.pictures, 0).rect.x).toBe(59);
});

test.skipIf(process.env["Q3_DATA"] === undefined)("retail Team Arena owner draws use shipped fonts, icons, skins and ordered CPU/GL scenes", async () => {
  const dataPath = process.env["Q3_DATA"]; if (dataPath === undefined) throw new Error("Missing retail data");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Team Arena source owner draws", width: 1280, height: 720, backend: "gl", hidden: true }) : null;
  const v = await fixture(assets, new GameRandom(0), window), g = v.media.graphics;
  const registry = new UiAssetRegistry(v.resources, text => { throw new Error(`Unexpected retail font diagnostic: ${text}`); });
  const small = await registry.registerFont("fonts/arial.ttf", 12), normal = await registry.registerFont("fonts/arial.ttf", 16),
    big = await registry.registerFont("fonts/arial.ttf", 20);
  if (small === null || normal === null || big === null) throw new Error("Expected shipped font registration");
  v.fonts.value = { small, normal, big, profile: "cgame", smallThreshold: 0.25, bigThreshold: Math.fround(0.4) };
  g.whiteShader = await v.resources.registerShader("white"); g.armorIcon = await v.resources.registerShaderNoMip("icons/iconr_yellow");
  g.heartShader = await v.resources.registerShaderNoMip("ui/assets/statusbar/selectedhealth.tga");
  g.assaultShader = await v.resources.registerShaderNoMip("ui/assets/statusbar/assault.tga");
  g.defendShader = await v.resources.registerShaderNoMip("ui/assets/statusbar/defend.tga");
  g.flagShaders[0] = await v.resources.registerShaderNoMip("ui/assets/statusbar/flag_in_base.tga");
  g.flagShaders[1] = await v.resources.registerShaderNoMip("ui/assets/statusbar/flag_capture.tga");
  g.flagShaders[2] = await v.resources.registerShaderNoMip("ui/assets/statusbar/flag_missing.tga");
  const medal = await v.resources.registerShaderNoMip("medal_impressive"), ci = cell(v.cgs.clientInfo, 3);
  ci.headModel = await v.resources.registerModel("models/players/sarge/head.md3"); ci.headSkin = await v.resources.registerSkin("models/players/sarge/head_default.skin");
  expect(ci.headModel.kind).toBe("md3"); expect(ci.headSkin).not.toBeNull(); expect(g.armorIcon).not.toBeNull();
  v.cgs.scores1 = 7; v.cgs.scores2 = 4; v.state.teamScores[0] = 7; v.state.teamScores[1] = 4;
  ci.powerups = (1 << Powerup.PW_QUAD) | (1 << Powerup.PW_HASTE); cell(v.state.scores, 0).impressiveCount = 3;
  v.ps.powerups.set(Powerup.PW_QUAD, 9500); v.ps.powerups.set(Powerup.PW_HASTE, 4500);
  v.state.spectatorList = "Spectators: ^3Ranger ^7and ^2Visor"; v.state.spectatorLen = v.state.spectatorList.length; v.state.spectatorWidth = -1;
  v.draw.resetTrace(); v.tools.fillRect({ x: 0, y: 0, width: 640, height: 480 }, { x: 0.04, y: 0.06, z: 0.1, w: 1 });
  const paint = async (id: number, x: number, y: number, width: number, height: number, extra: Partial<UiOwnerDrawPaintRequest> = {}) =>
    v.owner.paint(v.request(id, { rect: { x, y, width, height }, ...extra }));
  await paint(ID.CG_GAME_TYPE, 20, 10, 400, 30, { textScale: 0.4 });
  await paint(ID.CG_GAME_STATUS, 20, 45, 400, 25);
  await paint(ID.CG_SELECTEDPLAYER_HEAD, 20, 90, 96, 96);
  await paint(ID.CG_SELECTEDPLAYER_NAME, 126, 95, 160, 22);
  await paint(ID.CG_SELECTEDPLAYER_LOCATION, 126, 125, 240, 22);
  await paint(ID.CG_PLAYER_ARMOR_ICON2D, 390, 80, 48, 48);
  await paint(ID.CG_PLAYER_ARMOR_VALUE, 390, 145, 48, 20);
  await paint(ID.CG_PLAYER_HEALTH, 470, 145, 48, 20);
  await paint(ID.CG_BLUE_FLAGSTATUS, 550, 110, 48, 48);
  await paint(ID.CG_AREA_POWERUP, 20, 210, 56, 42, { alignment: 1, special: 30 });
  await paint(ID.CG_IMPRESSIVE, 470, 220, 48, 48, { background: v.resources.picture(medal) });
  await v.set("cg_currentSelectedPlayer", "2"); await paint(ID.CG_TEAMINFO, 20, 320, 600, 65, { textY: 24 });
  await paint(ID.CG_SPECTATORS, 20, 420, 600, 24);
  expect(v.commands.submit().views).toBeGreaterThan(0);
  const cpu = v.cpu;
  expect(new Set(cpu.pixels).size).toBeGreaterThan(150);
  const capture = process.env["QUAKE_UI_CAPTURE"];
  if (capture !== undefined) await Bun.write(`${capture}.cpu.png`, encodePng(v.draw.width, v.draw.height, cpu.pixels));
  const gl = v.gl;
  if (gl === null) return;
    const pixels = gl.readPixels(); let maximum = 0, sum = 0;
    for (const [index, channel] of pixels.entries()) {
      const other = cpu.pixels[index]; if (other === undefined) throw new Error("Missing CPU channel");
      const delta = Math.abs(channel - other); maximum = Math.max(maximum, delta); sum += delta;
    }
    console.log(JSON.stringify({ ownerDrawMean: sum / pixels.length, ownerDrawMaximum: maximum, subpixelBits: gl.subpixelBits }));
    if (capture !== undefined) await Bun.write(`${capture}.gl.png`, encodePng(v.draw.width, v.draw.height, pixels));
    expect(maximum).toBeLessThanOrEqual(2); expect(sum / pixels.length).toBeLessThan(0.1);
});

test("player-head future start correction preserves exact source interpolation and caller RNG lifetime", async () => {
  const v = await fixture(); v.state.headStartTime = 1100; v.state.headEndTime = 2000; v.state.headStartYaw = 160; v.state.headEndYaw = 200;
  await v.owner.paint(v.request(ID.CG_PLAYER_HEAD));
  expect(v.state.headStartTime).toBe(1000); expect(v.random.seed).toBe(0);
  expect(cell(v.icons.heads, 0).angles).toEqual({ x: 0, y: 160, z: 0 });
  v.state.time = 1500; await v.owner.paint(v.request(ID.CG_PLAYER_HEAD));
  expect(cell(v.icons.heads, 1).angles).toEqual({ x: 0, y: 180, z: 0 }); expect(v.random.seed).toBe(0);
});

test("damage head follows q3lcc float32 instruction order and the source crandom/crandom/random sequence", async () => {
  class SourceInputs extends GameRandom {
    calls = 0;
    override rand(): number { return cell([0, 8192, 16384], this.calls++); }
  }
  const random = new SourceInputs(), v = await fixture(syntheticAssets(), random);
  v.state.damageTime = 900; v.state.damageX = 0.5;
  await v.owner.paint(v.request(ID.CG_PLAYER_HEAD));
  expect(random.calls).toBe(3); expect(v.state.headEndTime).toBe(2100);
  expect(v.state.headStartYaw).toBe(202.5); expect(v.state.headEndYaw).toBe(160);
  const bytes = new DataView(new ArrayBuffer(4)); bytes.setFloat32(0, v.state.headEndPitch, true);
  // Unchanged q3lcc assembly rounds PI and arithmetic before CALLF4 cos.
  // Native double-PI libm instead produces word964383697; that is a different profile.
  expect(bytes.getUint32(0, true)).toBe(964363605);
  expect(cell(v.icons.heads, 0).rect).toEqual({ ...rect, x: -27.34375 });
  expect(cell(v.icons.heads, 0).angles).toEqual({ x: 0, y: 202.5, z: 0 });
});

test("holdable drawing awaits both original registration call sites before issuing its picture", async () => {
  const v = await fixture(), registry = v.media.weaponRegistry, register = registry.registerItemVisuals.bind(registry);
  const item = itemList("missionpack").findIndex(item => item.className === "holdable_medkit"), calls: number[] = [];
  const gate = Promise.withResolvers<void>();
  registry.registerItemVisuals = async index => { calls.push(index); await gate.promise; await register(index); };
  v.ps.stats.set(STAT.STAT_HOLDABLE_ITEM, item); v.draw.resetTrace();
  const painting = v.owner.paint(v.request(ID.CG_PLAYER_ITEM));
  expect(calls).toEqual([item]); expect(v.draw.pictures).toHaveLength(0);
  gate.resolve(); await painting;
  expect(calls).toEqual([item, item]); expect(v.draw.pictures).toHaveLength(1);
});
