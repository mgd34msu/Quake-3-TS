/*
 * Active product owner draws, UI_OwnerDrawWidth and UI_GetValue from id Software's
 * code/ui/ui_main.c. Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import { gameFormat } from "../../game/format.ts";
import type { GameFormatArgument } from "../../game/format.ts";
import type { RendererConfigurationSnapshot } from "../../render/configuration.ts";
import type { Draw2D } from "../../render/draw2d.ts";
import { textPaint, textPaintLimit, textWidth } from "../../render/font.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { RendererResources } from "../../render/world.ts";
import { Weapon } from "../../shared/definitions.ts";
import { PlayerAnimation } from "../../shared/player-state.ts";
import type { UiRect } from "../menu.ts";
import type { UiOwnerDrawPaintRequest, UiRuntime } from "../runtime.ts";
import type { TeamArenaCatalog } from "./catalog.ts";
import type { TeamArenaUiCinematics } from "./cinematics.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo, TeamArenaMap } from "./game-info.ts";
import type { TeamArenaUiInteractionState } from "./interaction-state.ts";
import type { TeamArenaLists } from "./lists.ts";
import type { TeamArenaPlayerList } from "./player-list.ts";
import { clearTeamArenaPlayerInfo, TeamArenaPlayerInfo } from "./players.ts";
import type { TeamArenaUiPlayers } from "./players.ts";
import type { TeamArenaUiResources } from "./resources.ts";
import type { TeamArenaSelection } from "./selection.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";
import type { TeamArenaTeam, TeamArenaTeamInfo } from "./team-info.ts";

enum Owner { Handicap = 200, Effects, PlayerModel, ClanName, ClanLogo, GameType, MapPreview, Skill,
  BlueTeamName, RedTeamName, Blue1, Blue2, Blue3, Blue4, Blue5, Red1, Red2, Red3, Red4, Red5,
  NetSource, NetMapPreview, NetFilter, Tier, OpponentModel, TierMap1, TierMap2, TierMap3,
  PlayerLogo, OpponentLogo, PlayerLogoMetal, OpponentLogoMetal, PlayerLogoName, OpponentLogoName,
  TierMapName, TierGameType, AllMapsSelection, OpponentName, VoteKick, BotName, BotSkill, RedBlue,
  Crosshair, SelectedPlayer, MapCinematic, NetGameType, NetMapCinematic, ServerRefreshDate,
  ServerMOTD, GLInfo, KeyBindStatus, ClanCinematic, MapTimeToBeat, JoinGameType, PreviewCinematic,
  StartMapCinematic, MapsSelection }

const HANDICAPS: readonly (string | null)[] = ["None", "95", "90", "85", "80", "75", "70", "65", "60", "55", "50", "45", "40", "35", "30", "25", "20", "15", "10", "5", null];
const SKILLS = ["I Can Win", "Bring It On", "Hurt Me Plenty", "Hardcore", "Nightmare"];
const NET_SOURCES = ["Local", "Mplayer", "Internet", "Favorites"];
const FILTERS = ["All", "Quake 3 Arena", "Team Arena", "Rocket Arena", "Alliance", "Weapons Factory Arena", "OSP"];
const PREVIEW_RECT = { x: 0, y: 0, width: 0, height: 0 };
const f = Math.fround;
type ShaderCell = { readonly kind: "unregistered" } | { readonly kind: "registered"; readonly shader: SceneShader | null };
interface Tier { tierName: string | null; readonly maps: (string | null)[]; readonly gameTypes: number[]; readonly mapHandles: ShaderCell[] }

export interface TeamArenaOwnerDrawServices {
  readonly cvars: TeamArenaUiCvars;
  readonly renderer: RendererResources;
  readonly resources: TeamArenaUiResources;
  readonly game: TeamArenaGameInfo;
  readonly teams: TeamArenaTeamInfo;
  readonly catalog: TeamArenaCatalog;
  readonly selection: TeamArenaSelection;
  readonly lists: TeamArenaLists;
  readonly playerList: TeamArenaPlayerList;
  readonly players: TeamArenaUiPlayers;
  readonly browser: ServerBrowser;
  readonly servers: TeamArenaServerBrowser;
  readonly cinematics: TeamArenaUiCinematics;
  readonly interaction: TeamArenaUiInteractionState;
  readonly runtime: UiRuntime;
  /** The UI_Init copy, not a new renderer query during an owner draw. */
  readRendererConfiguration(): RendererConfigurationSnapshot;
  readClient(): Parameters<TeamArenaPlayerList["build"]>[0];
  readRealTime(): number;
  readFrameTime(): number;
  assertActive(): void;
}

function sourceInt(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Team Arena owner draw requires source int32 input");
  return value;
}
function va(format: string, args: readonly GameFormatArgument[]): string {
  const result = gameFormat(format, args);
  if (result.length >= 32000) throw new RangeError("UI va source buffer overflow");
  return result;
}
function namesEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const fold = (value: string): string => sourceCommandText(value).replace(/[a-z]/g, byte => String.fromCharCode(byte.charCodeAt(0) - 32));
  return fold(left) === fold(right);
}

/** One UI lifetime's static preview objects. Callers serialize and await paint operations. */
export class TeamArenaOwnerDraw {
  readonly playerInfo = new TeamArenaPlayerInfo();
  readonly opponentInfo = new TeamArenaPlayerInfo();
  private q3Model = false;
  // Tier_Parse is commented out upstream; active draws still consume this BSS storage.
  tierCount = 0;
  readonly tierList: readonly Tier[] = Array.from({ length: 16 }, () => ({ tierName: null,
    maps: Array.from({ length: 3 }, () => null), gameTypes: [0, 0, 0],
    mapHandles: Array.from({ length: 3 }, () => ({ kind: "registered", shader: null })) }));

  constructor(private readonly services: TeamArenaOwnerDrawServices) { services.assertActive(); }
  private realTime(): number { const time = this.services.readRealTime(); this.services.assertActive(); return sourceInt(time); }
  private raw(name: string): string {
    const text = sourceCommandText(this.services.cvars.registry.get(name)?.value ?? "").slice(0, 1023);
    this.services.assertActive(); return text;
  }
  private number(name: string): number {
    const value = this.services.cvars.registry.get(name)?.numericValue ?? 0;
    this.services.assertActive(); return value;
  }
  private integer(name: string): number { return qvmFloatToInt(this.number(name)); }
  private set(name: string, value: string): void { this.services.cvars.registry.set(name, value, true); this.services.assertActive(); }
  private copy(name: string, size: number): string {
    const value = this.raw(name);
    if (value.length >= size) throw new RangeError(`UI player strcpy exceeds ${size}-byte source destination`);
    return value;
  }
  private paintText(request: UiOwnerDrawPaintRequest, text: string | null, limit = 0): void {
    if (text === null) return;
    textPaint(request.draw, this.services.resources.fonts, { x: request.rect.x, y: request.rect.y,
      scale: request.textScale, color: request.color, text, adjust: 0, limit, style: request.textStyle });
    this.services.assertActive();
  }
  private picture(draw: Draw2D, rect: UiRect, shader: SceneShader | null): void {
    const picture = this.services.renderer.picture(shader); this.services.assertActive();
    draw.drawHandlePic(rect, picture); this.services.assertActive();
  }
  private tinted(request: UiOwnerDrawPaintRequest, shader: SceneShader | null | -1): void {
    request.draw.setColor(request.color);
    this.picture(request.draw, request.rect, shader === -1 ? this.services.renderer.shaderForHandle(-1) : shader);
    request.draw.setColor(null);
  }
  private async registerTeamLogos(row: TeamArenaTeam): Promise<void> {
    if (row.teamIcon !== -1) return;
    const icon = await this.register(row.imageName); this.services.assertActive(); row.teamIcon = icon;
    const metal = await this.register(va("%s_metal", [row.imageName])); this.services.assertActive(); row.teamIconMetal = metal;
    const name = await this.register(va("%s_name", [row.imageName])); this.services.assertActive(); row.teamIconName = name;
  }
  private async register(path: string | null): Promise<SceneShader | null> {
    const result = await this.services.renderer.registerShaderNoMip(path); this.services.assertActive(); return result;
  }
  private handicap(): string | null {
    const value = this.number("handicap"), h = qvmFloatToInt(value < 5 ? 5 : value > 100 ? 100 : value);
    return infoSlot(HANDICAPS, 20 - Math.trunc(h / 5));
  }
  private skill(): string { let i = this.integer("g_spSkill"); if (i < 1 || i > SKILLS.length) i = 1; return infoSlot(SKILLS, i - 1); }
  private teamName(blue: boolean): string | null {
    const s = this.services, index = s.selection.teamIndexFromName(this.raw(blue ? "ui_blueTeam" : "ui_redTeam"));
    return index >= 0 && index < s.teams.teamCount ? va("%s: %s", [blue ? "Blue" : "Red", infoSlot(s.teams.teamList, index).teamName]) : null;
  }
  private teamMember(blue: boolean, index: number, width: boolean): string | null {
    const s = this.services;
    let value = this.integer(va(blue ? "ui_blueteam%i" : "ui_redteam%i", [index])), text: string | null;
    if (value <= 0) text = "Closed";
    else if (value === 1) text = "Human";
    else {
      value -= 2;
      if (width) {
        if (value >= s.teams.aliasCount) value = 0;
        text = infoSlot(s.teams.aliasList, value).name;
      } else text = this.bot(value, s.cvars.get("ui_actualNetGameType").integerValue);
    }
    return width ? va("%i. %s", [index, text]) : text;
  }
  private bot(index: number, game: number): string | null {
    const s = this.services;
    if (game >= 3) { if (index >= s.teams.characterCount) index = 0; return infoSlot(s.teams.characterList, index).name; }
    if (index >= s.catalog.getNumBots()) index = 0;
    const name = s.catalog.getBotNameByNumber(index); s.assertActive(); return name;
  }
  private netSource(width: boolean): string {
    const s = this.services, index = s.cvars.get("ui_netSource").integerValue;
    if (index < 0 || index > (width ? s.game.numJoinGameTypes : NET_SOURCES.length)) s.cvars.writeInteger("ui_netSource", 0);
    return va("Source: %s", [infoSlot(NET_SOURCES, s.cvars.get("ui_netSource").integerValue)]);
  }
  private netFilter(): string {
    const servers = this.services.servers, index = servers.serverFilterType;
    if (index < 0 || index > FILTERS.length) servers.serverFilterType = 0;
    return va("Filter: %s", [infoSlot(FILTERS, servers.serverFilterType)]);
  }
  private bindingText(): string {
    const waiting = this.services.runtime.bindingPending(); this.services.assertActive();
    return waiting ? "Waiting for new key... Press ESCAPE to cancel" : "Press ENTER or CLICK to change, Press BACKSPACE to clear";
  }
  private tier(): Tier { let i = this.integer("ui_currentTier"); if (i < 0 || i >= this.tierCount) i = 0; return infoSlot(this.tierList, i); }
  private tierMapIndex(): number { const i = this.integer("ui_currentMap"); return i < 0 || i > 3 ? 0 : i; }
  private mapIndex(net: boolean): number {
    const s = this.services, name = net ? "ui_currentNetMap" : "ui_currentMap";
    let index = s.cvars.get(name).integerValue;
    if (index < 0 || index > s.game.mapCount) { s.cvars.writeInteger(name, 0); this.set(name, "0"); index = 0; }
    return index;
  }
  private map(net: boolean): TeamArenaMap { return infoSlot(this.services.game.mapList, this.mapIndex(net)); }
  private async mapPreview(request: UiOwnerDrawPaintRequest, net: boolean): Promise<void> {
    const row = this.map(net);
    if (row.levelShot.kind === "unregistered") { const shader = await this.register(row.imageName); this.services.assertActive(); row.levelShot = { kind: "registered", shader }; }
    const shader = row.levelShot.shader === null ? await this.register("menu/art/unknownmap") : row.levelShot.shader;
    this.services.assertActive(); this.picture(request.draw, request.rect, shader);
  }
  private async netMapPreview(request: UiOwnerDrawPaintRequest): Promise<void> {
    const shader = this.services.servers.currentServerPreview ?? await this.register("menu/art/unknownmap");
    this.services.assertActive(); this.picture(request.draw, request.rect, shader);
  }
  private runCinematic(index: number, request: UiOwnerDrawPaintRequest): void {
    this.services.cinematics.run(index); this.services.assertActive();
    this.services.cinematics.draw(index, request.rect, request.draw); this.services.assertActive();
  }
  private async mapCinematic(request: UiOwnerDrawPaintRequest, net: boolean): Promise<void> {
    const row = this.map(net);
    if (row.cinematic >= -1) {
      if (row.cinematic === -1) { const handle = await this.services.cinematics.play(va("%s.roq", [row.mapLoadName]), PREVIEW_RECT); this.services.assertActive(); row.cinematic = handle; }
      if (row.cinematic >= 0) this.runCinematic(row.cinematic, request);
      else row.cinematic = -2;
    } else await this.mapPreview(request, net);
  }
  private async clanCinematic(request: UiOwnerDrawPaintRequest): Promise<void> {
    const s = this.services, index = s.selection.teamIndexFromName(this.raw("ui_teamName"));
    if (index < 0 || index >= s.teams.teamCount) return;
    const row = infoSlot(s.teams.teamList, index);
    if (row.cinematic >= -2) {
      if (row.cinematic === -1) { const handle = await s.cinematics.play(va("%s.roq", [row.imageName]), PREVIEW_RECT); s.assertActive(); row.cinematic = handle; }
      if (row.cinematic >= 0) this.runCinematic(row.cinematic, request);
      else { this.tinted(request, row.teamIconMetal); row.cinematic = -2; }
    } else this.tinted(request, row.teamIcon);
  }
  private async player(request: UiOwnerDrawPaintRequest, opponent: boolean): Promise<void> {
    const s = this.services, state = s.interaction, info = opponent ? this.opponentInfo : this.playerInfo;
    let model = "", head = "", team = "";
    if (opponent) {
      if (state.updateOpponentModel) { model = this.copy("ui_opponentModel", 64); head = this.copy("ui_opponentModel", 64); }
    } else if (this.number("ui_Q3Model") !== 0) {
      model = this.copy("model", 64); head = this.copy("headmodel", 256);
      if (!this.q3Model) { this.q3Model = true; state.updateModel = true; }
    } else {
      team = this.copy("ui_teamName", 256); model = this.copy("team_model", 64); head = this.copy("team_headmodel", 256);
      if (this.q3Model) { this.q3Model = false; state.updateModel = true; }
    }
    if (opponent ? state.updateOpponentModel : state.updateModel) {
      clearTeamArenaPlayerInfo(info);
      await s.players.setModel(info, model, head, team); s.assertActive();
      await s.players.setInfo(info, { legsAnim: PlayerAnimation.LEGS_IDLE, torsoAnim: PlayerAnimation.TORSO_STAND,
        viewAngles: { x: 0, y: 170, z: 0 }, moveAngles: { x: 0, y: 0, z: 0 }, weaponNumber: Weapon.WP_MACHINEGUN, chat: false }); s.assertActive();
      if (opponent) { await s.players.registerClientModelname(info, model, head, team); s.assertActive(); state.updateOpponentModel = false; }
      else state.updateModel = false;
    }
    const time = this.realTime(), frameTime = s.readFrameTime(); s.assertActive();
    await s.players.drawPlayer(request.rect, info, Math.trunc(time / 2), { draw: request.draw, time, frameTime: sourceInt(frameTime) }); s.assertActive();
  }
  private refreshDate(request: UiOwnerDrawPaintRequest): void {
    const s = this.services;
    if (!s.servers.refreshActive) { this.paintText(request, va("Refresh Time: %s", [this.raw(va("ui_lastServerRefresh_%i", [s.cvars.get("ui_netSource").integerValue])).slice(0, 63)])); return; }
    // Both source operands of realTime/PULSE_DIVISOR are ints, before the sine trap.
    const amount = f(.5 + f(.5 * f(Math.sin(f(Math.trunc(this.realTime() / 75))))));
    const pulse = (v: number): number => Math.min(1, Math.max(0, f(v + f(amount * f(f(f(.8) * v) - v)))));
    const color = request.color, newColor = { x: pulse(color.x), y: pulse(color.y), z: pulse(color.z), w: pulse(color.w) };
    const count = s.browser.getServerCount(s.cvars.get("ui_netSource").integerValue); s.assertActive();
    this.paintText({ ...request, color: newColor }, va("Getting info for %d servers (ESC to cancel)", [count]));
  }
  private motd(request: UiOwnerDrawPaintRequest): void {
    const s = this.services, state = s.servers, rect = request.rect, fonts = s.resources.fonts;
    if (state.motdLen === 0) return;
    const right = (): number => f(f(rect.x + rect.width) - 2);
    const tail = (): string => {
      if (state.motdOffset < 0 || state.motdOffset >= 1024) throw new RangeError("UI MOTD reads outside source buffer");
      if (state.motdOffset > state.motd.length) throw new Error("UI MOTD reads unspecified retained bytes after its terminator");
      return state.motd.slice(state.motdOffset);
    };
    if (state.motdWidth === -1) { state.motdWidth = 0; state.motdPaintX = f(rect.x + 1); state.motdPaintX2 = -1; }
    if (state.motdOffset > state.motdLen) { state.motdOffset = 0; state.motdPaintX = f(rect.x + 1); state.motdPaintX2 = -1; }
    if (this.realTime() > state.motdTime) {
      state.motdTime = (this.realTime() + 10) | 0;
      if (state.motdPaintX <= f(rect.x + 2)) {
        if (state.motdOffset < state.motdLen) { state.motdPaintX = f(state.motdPaintX + f((textWidth(fonts, tail(), request.textScale, 1) - 1) | 0)); state.motdOffset = (state.motdOffset + 1) | 0; }
        else { state.motdOffset = 0; state.motdPaintX = state.motdPaintX2 >= 0 ? state.motdPaintX2 : right(); state.motdPaintX2 = -1; }
      } else { state.motdPaintX = f(state.motdPaintX - 2); if (state.motdPaintX2 >= 0) state.motdPaintX2 = f(state.motdPaintX2 - 2); }
    }
    const options = { x: state.motdPaintX, y: f(f(rect.y + rect.height) - 3), scale: request.textScale, color: request.color, text: tail(), adjust: 0, limit: 0 };
    const maxX = textPaintLimit(request.draw, fonts, options, right()); s.assertActive();
    if (state.motdPaintX2 >= 0) { textPaintLimit(request.draw, fonts, { ...options, x: state.motdPaintX2, text: state.motd, limit: state.motdOffset }, right()); s.assertActive(); }
    if (state.motdOffset !== 0 && maxX > 0) { if (state.motdPaintX2 === -1) state.motdPaintX2 = right(); }
    else state.motdPaintX2 = -1;
  }
  private glInfo(request: UiOwnerDrawPaintRequest): void {
    const config = this.services.readRendererConfiguration(); this.services.assertActive();
    const rect = request.rect;
    const line = (x: number, y: number, text: string, limit: number): void => this.paintText({ ...request, rect: { ...rect, x, y } }, text, limit);
    line(f(rect.x + 2), rect.y, va("VENDOR: %s", [config.vendorString]), 30);
    line(f(rect.x + 2), f(rect.y + 15), va("VERSION: %s: %s", [config.versionString, config.rendererString]), 30);
    line(f(rect.x + 2), f(rect.y + 30), va("PIXELFORMAT: color(%d-bits) Z(%d-bits) stencil(%d-bits)", [config.colorBits, config.depthBits, config.stencilBits]), 30);
    const buffer = sourceCommandText(config.extensionsString).slice(0, 1023), lines: string[] = [];
    let offset = 0, y = qvmFloatToInt(f(rect.y + 45));
    while (y < f(rect.y + rect.height) && offset < buffer.length) {
      while (buffer[offset] === " ") offset++;
      const start = offset;
      while (offset < buffer.length && buffer[offset] !== " ") offset++;
      if (start < offset) { if (lines.length === 64) throw new RangeError("UI GLInfo writes outside source lines[64]"); lines.push(buffer.slice(start, offset)); }
    }
    let index = 0;
    while (index < lines.length) {
      line(f(rect.x + 2), y, infoSlot(lines, index++), 20);
      if (index < lines.length) line(f(rect.x + f(rect.width / 2)), y, infoSlot(lines, index++), 20);
      y = (y + 10) | 0;
      if (y > f(f(rect.y + rect.height) - 11)) break;
    }
  }

  value(_ownerDraw: number): number { this.services.assertActive(); return 0; }

  width(ownerDraw: number, scale: number): number {
    const s = this.services; s.assertActive(); sourceInt(ownerDraw);
    let text: string | null = null;
    switch (ownerDraw) {
      case Owner.Handicap: text = this.handicap(); break;
      case Owner.ClanName: text = this.raw("ui_teamName"); break;
      case Owner.GameType: text = infoSlot(s.game.gameTypes, s.cvars.get("ui_gameType").integerValue).gameType; break;
      case Owner.Skill: text = this.skill(); break;
      case Owner.BlueTeamName: case Owner.RedTeamName: text = this.teamName(ownerDraw === Owner.BlueTeamName); break;
      case Owner.Blue1: case Owner.Blue2: case Owner.Blue3: case Owner.Blue4: case Owner.Blue5: text = this.teamMember(true, ownerDraw - Owner.Blue1 + 1, true); break;
      case Owner.Red1: case Owner.Red2: case Owner.Red3: case Owner.Red4: case Owner.Red5: text = this.teamMember(false, ownerDraw - Owner.Red1 + 1, true); break;
      case Owner.NetSource: text = this.netSource(true); break;
      case Owner.NetFilter: text = this.netFilter(); break;
      case Owner.KeyBindStatus: text = this.bindingText(); break;
      case Owner.ServerRefreshDate: text = this.raw(va("ui_lastServerRefresh_%i", [s.cvars.get("ui_netSource").integerValue])); break;
    }
    return text === null ? 0 : textWidth(s.resources.fonts, text, f(scale));
  }

  async paint(input: UiOwnerDrawPaintRequest): Promise<void> {
    const s = this.services; s.assertActive(); sourceInt(input.ownerDraw);
    const request = { ...input, textScale: f(input.textScale), color: { x: f(input.color.x), y: f(input.color.y), z: f(input.color.z), w: f(input.color.w) },
      rect: { x: f(f(input.rect.x) + f(input.textX)), y: f(f(input.rect.y) + f(input.textY)), width: f(input.rect.width), height: f(input.rect.height) } };
    const rect = request.rect, draw = request.draw, state = s.interaction, cvars = s.cvars;
    switch (request.ownerDraw) {
      case Owner.Handicap: this.paintText(request, this.handicap()); break;
      case Owner.ClanName: this.paintText(request, this.raw("ui_teamName")); break;
      case Owner.GameType: this.paintText(request, infoSlot(s.game.gameTypes, cvars.get("ui_gameType").integerValue).gameType); break;
      case Owner.NetGameType:
        if (cvars.get("ui_netGameType").integerValue < 0 || cvars.get("ui_netGameType").integerValue > s.game.numGameTypes) { this.set("ui_netGameType", "0"); this.set("ui_actualNetGameType", "0"); }
        this.paintText(request, infoSlot(s.game.gameTypes, cvars.get("ui_netGameType").integerValue).gameType); break;
      case Owner.JoinGameType:
        if (cvars.get("ui_joinGameType").integerValue < 0 || cvars.get("ui_joinGameType").integerValue > s.game.numJoinGameTypes) this.set("ui_joinGameType", "0");
        this.paintText(request, infoSlot(s.game.joinGameTypes, cvars.get("ui_joinGameType").integerValue).gameType); break;
      case Owner.Skill: this.paintText(request, this.skill()); break;
      case Owner.BlueTeamName: case Owner.RedTeamName: this.paintText(request, this.teamName(request.ownerDraw === Owner.BlueTeamName)); break;
      case Owner.Blue1: case Owner.Blue2: case Owner.Blue3: case Owner.Blue4: case Owner.Blue5: this.paintText(request, this.teamMember(true, request.ownerDraw - Owner.Blue1 + 1, false)); break;
      case Owner.Red1: case Owner.Red2: case Owner.Red3: case Owner.Red4: case Owner.Red5: this.paintText(request, this.teamMember(false, request.ownerDraw - Owner.Red1 + 1, false)); break;
      case Owner.NetSource: this.paintText(request, this.netSource(false)); break;
      case Owner.NetFilter: this.paintText(request, this.netFilter()); break;
      case Owner.Effects:
        draw.drawHandlePic({ x: rect.x, y: f(rect.y - 14), width: 128, height: 8 }, s.resources.assets.fxBasePic);
        draw.drawHandlePic({ x: f(f(rect.x + ((state.effectsColor * 16) | 0)) + 8), y: f(rect.y - 16), width: 16, height: 12 }, infoSlot(s.resources.assets.fxPic, state.effectsColor)); break;
      case Owner.Crosshair:
        draw.setColor(request.color);
        if (state.currentCrosshair < 0 || state.currentCrosshair >= 10) state.currentCrosshair = 0;
        draw.drawHandlePic({ ...rect, y: f(rect.y - rect.height) }, infoSlot(s.resources.assets.crosshairShader, state.currentCrosshair)); draw.setColor(null); break;
      case Owner.ClanLogo: {
        const index = s.selection.teamIndexFromName(this.raw("ui_teamName"));
        if (index >= 0 && index < s.teams.teamCount) {
          const row = infoSlot(s.teams.teamList, index);
          draw.setColor(request.color);
          await this.registerTeamLogos(row); s.assertActive();
          this.picture(draw, rect, row.teamIcon === -1 ? s.renderer.shaderForHandle(-1) : row.teamIcon);
          draw.setColor(null);
        }
        break;
      }
      case Owner.PlayerLogo: case Owner.PlayerLogoMetal: case Owner.PlayerLogoName:
      case Owner.OpponentLogo: case Owner.OpponentLogoMetal: case Owner.OpponentLogoName: {
        const opponent = request.ownerDraw === Owner.OpponentLogo || request.ownerDraw === Owner.OpponentLogoMetal || request.ownerDraw === Owner.OpponentLogoName;
        const row = infoSlot(s.teams.teamList, s.selection.teamIndexFromName(this.raw(opponent ? "ui_opponentName" : "ui_teamName")));
        await this.registerTeamLogos(row); s.assertActive();
        this.tinted(request, request.ownerDraw === Owner.PlayerLogoMetal || request.ownerDraw === Owner.OpponentLogoMetal ? row.teamIconMetal
          : request.ownerDraw === Owner.PlayerLogoName || request.ownerDraw === Owner.OpponentLogoName ? row.teamIconName : row.teamIcon); break;
      }
      case Owner.PlayerModel: case Owner.OpponentModel: await this.player(request, request.ownerDraw === Owner.OpponentModel); break;
      case Owner.MapPreview: await this.mapPreview(request, true); break;
      case Owner.NetMapPreview: await this.netMapPreview(request); break;
      case Owner.MapTimeToBeat: {
        this.mapIndex(false);
        const row = infoSlot(s.game.mapList, cvars.get("ui_currentMap").integerValue), game = infoSlot(s.game.gameTypes, cvars.get("ui_gameType").integerValue).gtEnum;
        const time = row.timeToBeat[game]; if (time === undefined) throw new RangeError("UI timeToBeat reads outside source array");
        this.paintText(request, va("%02i:%02i", [Math.trunc(time / 60), time % 60])); break;
      }
      case Owner.MapCinematic: case Owner.StartMapCinematic: await this.mapCinematic(request, request.ownerDraw === Owner.StartMapCinematic); break;
      case Owner.NetMapCinematic:
        this.mapIndex(true);
        if (s.servers.currentServerCinematic >= 0) this.runCinematic(s.servers.currentServerCinematic, request);
        else await this.netMapPreview(request); break;
      case Owner.ClanCinematic: await this.clanCinematic(request); break;
      case Owner.PreviewCinematic:
        if (state.previewMovie > -2) {
          const handle = await s.cinematics.play(va("%s.roq", [infoSlot(s.lists.movieList, state.movieIndex)]), PREVIEW_RECT); s.assertActive(); state.previewMovie = handle;
          if (state.previewMovie >= 0) this.runCinematic(state.previewMovie, request); else state.previewMovie = -2;
        } break;
      case Owner.Tier: this.paintText(request, va("Tier: %s", [this.tier().tierName])); break;
      case Owner.TierMap1: case Owner.TierMap2: case Owner.TierMap3: {
        const row = this.tier(), index = request.ownerDraw - Owner.TierMap1, cell = infoSlot(row.mapHandles, index);
        if (cell.kind === "unregistered") { const shader = await this.register(va("levelshots/%s", [infoSlot(row.maps, index)])); s.assertActive(); row.mapHandles[index] = { kind: "registered", shader }; }
        const handle = infoSlot(row.mapHandles, index); if (handle.kind !== "registered") throw new Error("UI tier shader remains unregistered");
        this.picture(draw, rect, handle.shader); break;
      }
      case Owner.TierMapName: {
        const name = infoSlot(this.tier().maps, this.tierMapIndex()); let english: string | null = "";
        for (let i = 0; i < s.game.mapCount; i++) { const row = infoSlot(s.game.mapList, i); if (namesEqual(name, row.mapLoadName)) { english = row.mapName; break; } }
        this.paintText(request, english); break;
      }
      case Owner.TierGameType: this.paintText(request, infoSlot(s.game.gameTypes, infoSlot(this.tier().gameTypes, this.tierMapIndex())).gameType); break;
      case Owner.AllMapsSelection: case Owner.MapsSelection: {
        const index = cvars.get(request.ownerDraw === Owner.AllMapsSelection ? "ui_currentNetMap" : "ui_currentMap").integerValue;
        if (index >= 0 && index < s.game.mapCount) this.paintText(request, infoSlot(s.game.mapList, index).mapName); break;
      }
      case Owner.OpponentName: this.paintText(request, this.raw("ui_opponentName")); break;
      case Owner.BotName: this.paintText(request, this.bot(state.botIndex, this.integer("g_gametype"))); break;
      case Owner.BotSkill: if (state.skillIndex >= 0 && state.skillIndex < SKILLS.length) this.paintText(request, infoSlot(SKILLS, state.skillIndex)); break;
      case Owner.RedBlue: this.paintText(request, state.redBlue === 0 ? "Red" : "Blue"); break;
      case Owner.SelectedPlayer:
        if (this.realTime() > state.playerRefresh) { state.playerRefresh = (this.realTime() + 3000) | 0; const client = s.readClient(); s.assertActive(); s.playerList.build(client); s.assertActive(); }
        this.paintText(request, this.raw(s.playerList.teamLeader !== 0 ? "cg_selectedPlayerName" : "name")); break;
      case Owner.ServerRefreshDate: this.refreshDate(request); break;
      case Owner.ServerMOTD: this.motd(request); break;
      case Owner.GLInfo: this.glInfo(request); break;
      case Owner.KeyBindStatus: this.paintText(request, this.bindingText()); break;
    }
    s.assertActive();
  }
}
