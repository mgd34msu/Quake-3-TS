// Team Arena owner drawing from id Software's code/cgame/cg_newdraw.c,
// with CG_OwnerDrawWidth from cg_main.c and IDs from ui/menudef.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { Vec4 } from "../core/math.ts";
import type { GameRandom } from "../game/numeric.ts";
import type { Rect2D } from "../render/draw2d.ts";
import { textPaint, textPaintLimit, textWidth } from "../render/font.ts";
import type { FontSet } from "../render/font.ts";
import type { SceneShader } from "../render/ref-entity.ts";
import { GameType, MissionpackStatIndex, PersistentIndex, Powerup, Team, statSchema } from "../shared/definitions.ts";
import { findItemForPowerup } from "../shared/items.ts";
import type { UiOwnerDrawPaintRequest } from "../ui/runtime.ts";
import type { ClientConfiguration } from "./config.ts";
import type { ClientDrawIcons } from "./draw-icons.ts";
import { getColorForHealth } from "./draw-tools.ts";
import { placeString } from "./events.ts";
import type { ClientMedia } from "./media.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";

export enum MissionOwnerDrawId {
  CG_PLAYER_ARMOR_ICON = 1, CG_PLAYER_ARMOR_VALUE = 2, CG_PLAYER_HEAD = 3, CG_PLAYER_HEALTH = 4,
  CG_PLAYER_AMMO_ICON = 5, CG_PLAYER_AMMO_VALUE = 6, CG_SELECTEDPLAYER_HEAD = 7,
  CG_SELECTEDPLAYER_NAME = 8, CG_SELECTEDPLAYER_LOCATION = 9, CG_SELECTEDPLAYER_STATUS = 10,
  CG_SELECTEDPLAYER_WEAPON = 11, CG_SELECTEDPLAYER_POWERUP = 12, CG_PLAYER_ITEM = 19, CG_PLAYER_SCORE = 20,
  CG_BLUE_FLAGHEAD = 21, CG_BLUE_FLAGSTATUS = 22, CG_BLUE_FLAGNAME = 23,
  CG_RED_FLAGHEAD = 24, CG_RED_FLAGSTATUS = 25, CG_RED_FLAGNAME = 26,
  CG_BLUE_SCORE = 27, CG_RED_SCORE = 28, CG_RED_NAME = 29, CG_BLUE_NAME = 30,
  CG_HARVESTER_SKULLS = 31, CG_ONEFLAG_STATUS = 32, CG_PLAYER_LOCATION = 33, CG_TEAM_COLOR = 34,
  CG_CTF_POWERUP = 35, CG_AREA_POWERUP = 36, CG_PLAYER_HASFLAG = 38, CG_GAME_TYPE = 39,
  CG_SELECTEDPLAYER_ARMOR = 40, CG_SELECTEDPLAYER_HEALTH = 41, CG_PLAYER_STATUS = 42,
  CG_AREA_SYSTEMCHAT = 46, CG_AREA_TEAMCHAT = 47, CG_AREA_CHAT = 48, CG_GAME_STATUS = 49, CG_KILLER = 50,
  CG_PLAYER_ARMOR_ICON2D = 51, CG_PLAYER_AMMO_ICON2D = 52, CG_ACCURACY = 53, CG_ASSISTS = 54,
  CG_DEFEND = 55, CG_EXCELLENT = 56, CG_IMPRESSIVE = 57, CG_PERFECT = 58, CG_GAUNTLET = 59,
  CG_SPECTATORS = 60, CG_TEAMINFO = 61, CG_VOICE_HEAD = 62, CG_VOICE_NAME = 63,
  CG_PLAYER_HASFLAG2D = 64, CG_HARVESTER_SKULLS2D = 65, CG_CAPFRAGLIMIT = 66,
  CG_1STPLACE = 67, CG_2NDPLACE = 68, CG_CAPTURES = 69,
}
export enum MissionOwnerDrawFlags {
  CG_SHOW_BLUE_TEAM_HAS_REDFLAG = 0x1, CG_SHOW_RED_TEAM_HAS_BLUEFLAG = 0x2,
  CG_SHOW_ANYTEAMGAME = 0x4, CG_SHOW_HARVESTER = 0x8, CG_SHOW_ONEFLAG = 0x10,
  CG_SHOW_CTF = 0x20, CG_SHOW_OBELISK = 0x40, CG_SHOW_HEALTHCRITICAL = 0x80,
  CG_SHOW_SINGLEPLAYER = 0x100, CG_SHOW_TOURNAMENT = 0x200, CG_SHOW_DURINGINCOMINGVOICE = 0x400,
  CG_SHOW_IF_PLAYER_HAS_FLAG = 0x800, CG_SHOW_LANPLAYONLY = 0x1000, CG_SHOW_MINED = 0x2000,
  CG_SHOW_HEALTHOK = 0x4000, CG_SHOW_TEAMINFO = 0x8000, CG_SHOW_NOTEAMINFO = 0x10000,
  CG_SHOW_OTHERTEAMHASFLAG = 0x20000, CG_SHOW_YOURTEAMHASENEMYFLAG = 0x40000,
  CG_SHOW_ANYNONTEAMGAME = 0x80000, CG_SHOW_2DONLY = 0x10000000,
}
export interface MissionOwnerDrawHost {
  readonly icons: ClientDrawIcons;
  readonly fonts: () => FontSet;
  readonly configuration: Pick<ClientConfiguration, "readVmCvar">;
  readonly random: GameRandom;
  configString(index: number): string;
  selectedPlayer(): number;
  chat(): { readonly system: string; readonly team1: string; readonly team2: string };
}

const f = Math.fround, ID = MissionOwnerDrawId, SHOW = MissionOwnerDrawFlags;
const WHITE: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
const RED: Vec4 = { x: 1, y: 0, z: 0, w: 1 }, BLUE: Vec4 = { x: 0, y: 0, z: 1, w: 1 };
const SCORE_NOT_PRESENT = -9999, CS_LOCATIONS = 608, MAX_LOCATIONS = 64;
function slot<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new RangeError(`Invalid owner-draw slot ${index}`); return value;
}

/** Canonical cg/cgs are retained across paints; menu lifecycle belongs to MissionHud. */
export class MissionOwnerDraw {
  constructor(readonly state: ClientGameState, readonly staticState: ClientGameStaticState,
    readonly media: ClientMedia, readonly host: MissionOwnerDrawHost) {
    if (state.product !== "missionpack" || staticState.product !== "missionpack" || media.staticState !== staticState
      || host.icons.state !== state || host.icons.tools.media !== media) throw new Error("Mission owner drawing requires canonical Team Arena state and media");
  }
  private get tools() { return this.host.icons.tools; }
  private get ps() {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("Mission owner drawing requires a current snapshot");
    return snapshot.playerState;
  }
  private cvar(name: string): number { return this.host.configuration.readVmCvar(name).integerValue; }
  private client(index: number) { return slot(this.staticState.clientInfo, index); }
  private selectedIndex(): number { return slot(this.state.sortedTeamPlayers, this.host.selectedPlayer()); }
  private selected() { return this.client(this.selectedIndex()); }
  private get team(): number { return this.ps.persistant.get(PersistentIndex.PERS_TEAM); }
  private location(index: number): string { return this.host.configString(CS_LOCATIONS + index) || "unknown"; }
  private widthText(text: string, scale: number): number { return textWidth(this.host.fonts(), text, scale); }
  private text(rect: Rect2D, scale: number, color: Vec4, text: string, style: number, x = rect.x, y = f(rect.y + rect.height)): void {
    textPaint(this.tools.draw, this.host.fonts(), { x, y, scale, color, text, adjust: 0, limit: 0, style });
  }
  private number(rect: Rect2D, scale: number, color: Vec4, value: number, picture: UiOwnerDrawPaintRequest["background"], style: number): void {
    if (picture !== undefined) {
      this.tools.draw.setColor(color); this.tools.draw.stretchPic(rect, { s: 0, t: 0, s2: 1, t2: 1 }, picture); this.tools.draw.setColor(null);
    } else {
      const text = String(value | 0), width = this.widthText(text, scale);
      this.text(rect, scale, color, text, style, f(rect.x + f(f(rect.width - width) / 2)));
    }
  }

  statusHandle(task: number): SceneShader | null {
    const g = this.media.graphics;
    switch (task) {
      case 2: return g.defendShader;
      case 3: return g.patrolShader;
      case 4: return g.followShader;
      case 5: return g.retrieveShader;
      case 6: return g.escortShader;
      case 7: return g.campShader;
      default: return g.assaultShader;
    }
  }
  value(id: number): number { return f(this.rawValue(id)); }
  private rawValue(id: number): number {
    const ps = this.ps, stats = statSchema("missionpack");
    switch (id) {
      case ID.CG_SELECTEDPLAYER_ARMOR: return this.selected().armor;
      case ID.CG_SELECTEDPLAYER_HEALTH: return this.selected().health;
      case ID.CG_PLAYER_ARMOR_VALUE: return ps.stats.get(stats.armor);
      case ID.CG_PLAYER_AMMO_VALUE: {
        const weapon = this.state.entityAt(ps.clientNum).currentState.weapon;
        return weapon !== 0 ? ps.ammo.get(weapon) : -1;
      }
      case ID.CG_PLAYER_SCORE: return ps.persistant.get(PersistentIndex.PERS_SCORE);
      case ID.CG_PLAYER_HEALTH: return ps.stats.get(stats.health);
      case ID.CG_RED_SCORE: return this.staticState.scores1;
      case ID.CG_BLUE_SCORE: return this.staticState.scores2;
      default: return -1;
    }
  }
  otherTeamHasFlag(): boolean {
    const cgs = this.staticState;
    if (cgs.gameType !== GameType.GT_1FCTF && cgs.gameType !== GameType.GT_CTF) return false;
    const team = this.team;
    if (cgs.gameType === GameType.GT_1FCTF) return team === Team.TEAM_RED && cgs.flagStatus === 3 || team === Team.TEAM_BLUE && cgs.flagStatus === 2;
    if (cgs.gameType === GameType.GT_CTF) return team === Team.TEAM_RED && cgs.redflag === 1 || team === Team.TEAM_BLUE && cgs.blueflag === 1;
    return false;
  }
  yourTeamHasFlag(): boolean {
    const cgs = this.staticState;
    if (cgs.gameType !== GameType.GT_1FCTF && cgs.gameType !== GameType.GT_CTF) return false;
    const team = this.team;
    if (cgs.gameType === GameType.GT_1FCTF) return team === Team.TEAM_RED && cgs.flagStatus === 2 || team === Team.TEAM_BLUE && cgs.flagStatus === 3;
    if (cgs.gameType === GameType.GT_CTF) return team === Team.TEAM_RED && cgs.blueflag === 1 || team === Team.TEAM_BLUE && cgs.redflag === 1;
    return false;
  }
  visible(flags: number): boolean {
    const cgs = this.staticState, type = cgs.gameType;
    if (flags & SHOW.CG_SHOW_TEAMINFO) return this.cvar("cg_currentSelectedPlayer") === this.state.numSortedTeamPlayers;
    if (flags & SHOW.CG_SHOW_NOTEAMINFO) return this.cvar("cg_currentSelectedPlayer") !== this.state.numSortedTeamPlayers;
    if (flags & SHOW.CG_SHOW_OTHERTEAMHASFLAG) return this.otherTeamHasFlag();
    if (flags & SHOW.CG_SHOW_YOURTEAMHASENEMYFLAG) return this.yourTeamHasFlag();
    if (flags & (SHOW.CG_SHOW_BLUE_TEAM_HAS_REDFLAG | SHOW.CG_SHOW_RED_TEAM_HAS_BLUEFLAG)) {
      return !!(flags & SHOW.CG_SHOW_BLUE_TEAM_HAS_REDFLAG) && (cgs.redflag === 1 || cgs.flagStatus === 2)
        || !!(flags & SHOW.CG_SHOW_RED_TEAM_HAS_BLUEFLAG) && (cgs.blueflag === 1 || cgs.flagStatus === 3);
    }
    if (flags & SHOW.CG_SHOW_ANYTEAMGAME && type >= GameType.GT_TEAM) return true;
    if (flags & SHOW.CG_SHOW_ANYNONTEAMGAME && type < GameType.GT_TEAM) return true;
    if (flags & SHOW.CG_SHOW_HARVESTER) return type === GameType.GT_HARVESTER;
    if (flags & SHOW.CG_SHOW_ONEFLAG) return type === GameType.GT_1FCTF;
    if (flags & SHOW.CG_SHOW_CTF && type === GameType.GT_CTF) return true;
    if (flags & SHOW.CG_SHOW_OBELISK) return type === GameType.GT_OBELISK;
    if (flags & SHOW.CG_SHOW_HEALTHCRITICAL && this.ps.stats.get(statSchema("missionpack").health) < 25) return true;
    if (flags & SHOW.CG_SHOW_HEALTHOK && this.ps.stats.get(statSchema("missionpack").health) >= 25) return true;
    if (flags & SHOW.CG_SHOW_SINGLEPLAYER && type === GameType.GT_SINGLE_PLAYER) return true;
    if (flags & SHOW.CG_SHOW_TOURNAMENT && type === GameType.GT_TOURNAMENT) return true;
    if (flags & SHOW.CG_SHOW_IF_PLAYER_HAS_FLAG) return this.ps.powerups.get(Powerup.PW_REDFLAG) !== 0
      || this.ps.powerups.get(Powerup.PW_BLUEFLAG) !== 0 || this.ps.powerups.get(Powerup.PW_NEUTRALFLAG) !== 0;
    return false;
  }
  private gameTypeText(): string {
    switch (this.staticState.gameType) {
      case GameType.GT_FFA: return "Free For All";
      case GameType.GT_TEAM: return "Team Deathmatch";
      case GameType.GT_CTF: return "Capture the Flag";
      case GameType.GT_1FCTF: return "One Flag CTF";
      case GameType.GT_OBELISK: return "Overload";
      case GameType.GT_HARVESTER: return "Harvester";
      default: return "";
    }
  }
  private gameStatusText(): string {
    if (this.staticState.gameType < GameType.GT_TEAM) return this.team === Team.TEAM_SPECTATOR ? ""
      : `${placeString((this.ps.persistant.get(PersistentIndex.PERS_RANK) + 1) | 0)} place with ${this.ps.persistant.get(PersistentIndex.PERS_SCORE)}`;
    const [red, blue] = this.state.teamScores;
    return red === blue ? `Teams are tied at ${red}` : red >= blue ? `Red leads Blue, ${red} to ${blue}` : `Blue leads Red, ${blue} to ${red}`;
  }
  private killerText(): string { return this.state.killerName.length > 0 ? `Fragged by ${this.state.killerName}` : ""; }
  width(id: number, scale: number): number {
    switch (id) {
      case ID.CG_GAME_TYPE: return this.widthText(this.gameTypeText(), scale);
      case ID.CG_GAME_STATUS: return this.widthText(this.gameStatusText(), scale);
      case ID.CG_KILLER: return this.widthText(this.killerText(), scale);
      case ID.CG_RED_NAME: return this.widthText(this.host.configuration.readVmCvar("g_redteam").value, scale);
      case ID.CG_BLUE_NAME: return this.widthText(this.host.configuration.readVmCvar("g_blueteam").value, scale);
      default: return 0;
    }
  }

  private armorIcon(rect: Rect2D, force2D: boolean): void {
    if (this.cvar("cg_drawStatus") === 0) return;
    if (force2D || this.cvar("cg_draw3dIcons") === 0 && this.cvar("cg_drawIcons") !== 0) {
      this.tools.drawPic({ ...rect, y: f(f(rect.y + f(rect.height / 2)) + 1) }, this.media.graphics.armorIcon);
    } else if (this.cvar("cg_draw3dIcons") !== 0) {
      this.host.icons.draw3DModel(rect, this.media.graphics.armorModel, null, vec3(90, 0, -10), vec3(0, f((this.state.time & 2047) * 360 / 2048), 0));
    }
  }
  private ammoIcon(rect: Rect2D, force2D: boolean): void {
    const registry = this.media.weaponRegistry;
    if (force2D || this.cvar("cg_draw3dIcons") === 0 && this.cvar("cg_drawIcons") !== 0) {
      const icon = registry.weapon(this.state.predictedPlayerState.weapon).ammoIcon;
      if (icon !== null) this.tools.drawPic(rect, icon);
    } else if (this.cvar("cg_draw3dIcons") !== 0) {
      const weapon = this.state.entityAt(this.ps.clientNum).currentState.weapon, model = registry.weapon(weapon).ammoModel;
      if (weapon !== 0 && model.kind !== "default") this.host.icons.draw3DModel(rect, model, null, vec3(70, 0, 0),
        vec3(0, f(90 + f(20 * f(Math.sin(f(f(this.state.time) / 1000))))), 0));
    }
  }
  private playerHead(rect: Rect2D): void {
    const cg = this.state, random = this.host.random;
    let x = rect.x;
    if (cg.damageTime !== 0 && f(f(cg.time) - cg.damageTime) < 500) {
      const frac = f(f(f(cg.time) - cg.damageTime) / 500);
      const size = f(f(rect.width * 1.25) * f(1.5 - f(frac * 0.5))), stretch = f(size - f(rect.width * 1.25));
      x = f(x - f(f(stretch * 0.5) + f(f(cg.damageX * stretch) * 0.5)));
      cg.headStartYaw = f(180 + f(cg.damageX * 45));
      cg.headEndYaw = f(180 + f(20 * f(Math.cos(f(random.crandom() * f(Math.PI))))));
      cg.headEndPitch = f(5 * f(Math.cos(f(random.crandom() * f(Math.PI)))));
      cg.headStartTime = cg.time;
      cg.headEndTime = Math.trunc(f(f((cg.time + 100) | 0) + f(random.random() * 2000))) | 0;
    } else if (cg.time >= cg.headEndTime) {
      cg.headStartYaw = cg.headEndYaw; cg.headStartPitch = cg.headEndPitch; cg.headStartTime = cg.headEndTime;
      cg.headEndTime = Math.trunc(f(f((cg.time + 100) | 0) + f(random.random() * 2000))) | 0;
      cg.headEndYaw = f(180 + f(20 * f(Math.cos(f(random.crandom() * f(Math.PI))))));
      cg.headEndPitch = f(5 * f(Math.cos(f(random.crandom() * f(Math.PI)))));
    }
    if (cg.headStartTime > cg.time) cg.headStartTime = cg.time;
    let frac = f(f((cg.time - cg.headStartTime) | 0) / f((cg.headEndTime - cg.headStartTime) | 0));
    frac = f(f(frac * frac) * f(3 - f(2 * frac)));
    this.host.icons.drawHead({ ...rect, x }, this.ps.clientNum,
      vec3(f(cg.headStartPitch + f(f(cg.headEndPitch - cg.headStartPitch) * frac)), f(cg.headStartYaw + f(f(cg.headEndYaw - cg.headStartYaw) * frac)), 0));
  }
  private selectedStatus(rect: Rect2D): void {
    const ci = this.selected(), cgs = this.staticState;
    if (cgs.orderPending && this.state.time > ((cgs.orderTime - 2500) | 0) && (this.state.time >> 9) & 1) return;
    this.tools.drawPic(rect, this.statusHandle(cgs.orderPending ? cgs.currentOrder : ci.teamTask));
  }
  private flagCarrier(blue: boolean): number | null {
    for (let i = 0; i < this.staticState.maxclients; i++) {
      const ci = this.client(i);
      if (ci.infoValid && ci.team === (blue ? Team.TEAM_RED : Team.TEAM_BLUE) && ci.powerups & (1 << (blue ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG))) return i;
    }
    return null;
  }
  private flagHead(rect: Rect2D, blue: boolean): void {
    if (this.flagCarrier(blue) !== null) this.host.icons.drawHead(rect, 0, vec3(0, f(180 + f(20 * f(Math.sin(f(f(this.state.time) / 650))))), 0));
  }
  private flagStatus(rect: Rect2D, blue: boolean, picture: UiOwnerDrawPaintRequest["background"]): void {
    const cgs = this.staticState, g = this.media.graphics;
    if (cgs.gameType !== GameType.GT_CTF && cgs.gameType !== GameType.GT_1FCTF) {
      if (cgs.gameType === GameType.GT_HARVESTER) {
        this.tools.draw.setColor(blue ? BLUE : RED); this.tools.drawPic(rect, blue ? g.blueCubeIcon : g.redCubeIcon); this.tools.draw.setColor(null);
      }
      return;
    }
    if (picture !== undefined) this.tools.draw.stretchPic(rect, { s: 0, t: 0, s2: 1, t2: 1 }, picture);
    else if (findItemForPowerup("missionpack", blue ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG) !== null) {
      const status = blue ? cgs.blueflag : cgs.redflag;
      this.tools.draw.setColor(blue ? BLUE : RED);
      this.tools.drawPic(rect, slot(g.flagShaders, status >= 0 && status <= 2 ? status : 0));
      this.tools.draw.setColor(null);
    }
  }
  private oneFlagStatus(rect: Rect2D): void {
    const status = this.staticState.flagStatus;
    if (this.staticState.gameType !== GameType.GT_1FCTF || findItemForPowerup("missionpack", Powerup.PW_NEUTRALFLAG) === null || status < 0 || status > 4) return;
    this.tools.draw.setColor(status === 2 ? RED : status === 3 ? BLUE : WHITE);
    this.tools.drawPic(rect, slot(this.media.graphics.flagShaders, status === 2 || status === 3 ? 1 : status === 4 ? 2 : 0));
    // The source intentionally leaves this color set for the next draw.
  }
  private skulls(rect: Rect2D, scale: number, color: Vec4, force2D: boolean, style: number): void {
    if (this.staticState.gameType !== GameType.GT_HARVESTER) return;
    const text = String(Math.min(this.ps.generic1, 99));
    this.text(rect, scale, color, text, style, f(rect.x + f(rect.width - this.widthText(text, scale))));
    if (this.cvar("cg_drawIcons") === 0) return;
    const red = this.team === Team.TEAM_BLUE, g = this.media.graphics;
    if (!force2D && this.cvar("cg_draw3dIcons") !== 0) this.host.icons.draw3DModel({ ...rect, width: 35, height: 35 }, red ? g.redCubeModel : g.blueCubeModel,
      null, vec3(90, 0, -10), vec3(0, f((this.state.time & 2047) * 360 / 2048), 0));
    else this.tools.drawPic({ x: f(rect.x + 3), y: f(rect.y + 16), width: 20, height: 20 }, red ? g.redCubeIcon : g.blueCubeIcon);
  }
  private playerHasFlag(rect: Rect2D, force2D: boolean): void {
    const ps = this.state.predictedPlayerState, adj = force2D ? 0 : 2;
    const r = { x: f(rect.x + adj), y: f(rect.y + adj), width: f(rect.width - adj), height: f(rect.height - adj) };
    if (ps.powerups.get(Powerup.PW_REDFLAG)) this.host.icons.drawFlagModel(r, Team.TEAM_RED, force2D);
    else if (ps.powerups.get(Powerup.PW_BLUEFLAG)) this.host.icons.drawFlagModel(r, Team.TEAM_BLUE, force2D);
    else if (ps.powerups.get(Powerup.PW_NEUTRALFLAG)) this.host.icons.drawFlagModel(r, Team.TEAM_FREE, force2D);
  }
  private async item(rect: Rect2D, persistent: boolean): Promise<void> {
    if (persistent && this.staticState.gameType < GameType.GT_CTF) return;
    const value = this.ps.stats.get(persistent ? MissionpackStatIndex.STAT_PERSISTANT_POWERUP : MissionpackStatIndex.STAT_HOLDABLE_ITEM);
    if (value === 0) return;
    await this.media.weaponRegistry.registerItemVisuals(value);
    if (!persistent) await this.media.weaponRegistry.registerItemVisuals(value);
    this.tools.drawPic(rect, slot(this.media.weaponRegistry.items, value).icon);
  }
  private async selectedPowerup(rect: Rect2D): Promise<void> {
    const ci = this.selected();
    for (let j = 0; j < Powerup.PW_NUM_POWERUPS; j++) {
      if (!(ci.powerups & (1 << j))) continue;
      const item = findItemForPowerup("missionpack", j);
      if (item !== null) {
        const shader = item.icon === null ? null : await this.media.resources.registerShader(item.icon);
        this.tools.drawPic(rect, shader); return;
      }
    }
  }
  private async areaPowerup(rect: Rect2D, alignment: number, special: number, scale: number, color: Vec4): Promise<void> {
    const ps = this.ps;
    if (ps.stats.get(statSchema("missionpack").health) <= 0) return;
    const sorted: { readonly powerup: number; readonly remaining: number }[] = [];
    for (let i = 0; i < 16; i++) {
      const expiry = ps.powerups.get(i), remaining = (expiry - this.state.time) | 0;
      if (expiry === 0 || remaining <= 0 || remaining >= 999000) continue;
      const index = sorted.findIndex(entry => entry.remaining >= remaining);
      sorted.splice(index < 0 ? sorted.length : index, 0, { powerup: i, remaining });
    }
    let x = rect.x, y = rect.y;
    for (const entry of sorted) {
      const item = findItemForPowerup("missionpack", entry.powerup);
      if (item === null) continue;
      const remaining = (ps.powerups.get(entry.powerup) - this.state.time) | 0;
      if (remaining >= 5000) this.tools.draw.setColor(null);
      else { const phase = f(f(remaining) / 1000), alpha = f(phase - Math.trunc(phase)); this.tools.draw.setColor({ x: alpha, y: alpha, z: alpha, w: alpha }); }
      const shader = item.icon === null ? null : await this.media.resources.registerShader(item.icon);
      this.tools.drawPic({ x, y, width: f(rect.width * 0.75), height: rect.height }, shader);
      this.text(rect, scale, color, String(Math.trunc(entry.remaining / 1000)), 0, f(f(x + f(rect.width * 0.75)) + 3), f(y + rect.height));
      if (alignment === 0) y = f(y + f(rect.width + special)); else x = f(x + f(rect.width + special));
    }
    this.tools.draw.setColor(null);
  }
  private limited(text: string, x: number, y: number, scale: number, color: Vec4, maximum: number, limit = 0): number {
    return textPaintLimit(this.tools.draw, this.host.fonts(), { x, y, scale, color, text, adjust: 0, limit }, maximum);
  }
  private async teamInfo(rect: Rect2D, textY: number, scale: number, color: Vec4): Promise<void> {
    const count = Math.min(this.state.numSortedTeamPlayers, 8);
    // The source measures these unused maxima before drawing; font/config lookups remain ordered.
    for (let i = 0; i < count; i++) {
      const ci = this.client(slot(this.state.sortedTeamPlayers, i));
      if (ci.infoValid && ci.team === this.team) this.widthText(ci.name, scale);
    }
    for (let i = 1; i < MAX_LOCATIONS; i++) {
      const location = this.host.configString(CS_LOCATIONS + i); if (location.length > 0) this.widthText(location, scale);
    }
    let y = rect.y;
    for (let i = 0; i < count; i++) {
      const ci = this.client(slot(this.state.sortedTeamPlayers, i));
      if (!ci.infoValid || ci.team !== this.team) continue;
      let x = Math.trunc(f(rect.x + 1));
      for (let j = 0; j <= Powerup.PW_NUM_POWERUPS; j++) {
        if (!(ci.powerups & (1 << j))) continue;
        const item = findItemForPowerup("missionpack", j);
        if (item !== null) { const shader = item.icon === null ? null : await this.media.resources.registerShader(item.icon);
          this.tools.drawPic({ x, y, width: 12, height: 12 }, shader); x += 12; }
      }
      x = Math.trunc(f(rect.x + 38));
      this.tools.draw.setColor(getColorForHealth(ci.health, ci.armor));
      this.tools.drawPic({ x, y: f(y + 1), width: 10, height: 10 }, this.media.graphics.heartShader);
      x += 13; this.tools.draw.setColor(null);
      const cgs = this.staticState;
      const handle = cgs.orderPending && this.state.time > ((cgs.orderTime - 2500) | 0) && (this.state.time >> 9) & 1
        ? null : this.statusHandle(cgs.orderPending ? cgs.currentOrder : ci.teamTask);
      if (handle !== null) this.tools.drawPic({ x, y, width: 12, height: 12 }, handle);
      x += 13;
      const leftOver = f(rect.width - x), max = f(x + f(leftOver / 3));
      this.limited(ci.name, x, f(y + textY), scale, color, max);
      const location = this.location(ci.location);
      x = Math.trunc(f(x + f(f(leftOver / 3) + 2)));
      this.limited(location, x, f(y + textY), scale, color, f(rect.width - 4));
      y = f(y + f(textY + 2));
      if (f(f(y + textY) + 2) > f(rect.y + rect.height)) break;
    }
  }
  private spectators(rect: Rect2D, scale: number, color: Vec4): void {
    const cg = this.state;
    if (cg.spectatorLen === 0) return;
    if (cg.spectatorWidth === -1) { cg.spectatorWidth = 0; cg.spectatorPaintX = Math.trunc(f(rect.x + 1)); cg.spectatorPaintX2 = -1; }
    if (cg.spectatorOffset > cg.spectatorLen) { cg.spectatorOffset = 0; cg.spectatorPaintX = Math.trunc(f(rect.x + 1)); cg.spectatorPaintX2 = -1; }
    if (cg.time > cg.spectatorTime) {
      cg.spectatorTime = (cg.time + 10) | 0;
      if (cg.spectatorPaintX <= f(rect.x + 2)) {
        if (cg.spectatorOffset < cg.spectatorLen) {
          cg.spectatorPaintX = (cg.spectatorPaintX + textWidth(this.host.fonts(), cg.spectatorList.slice(cg.spectatorOffset), scale, 1) - 1) | 0;
          cg.spectatorOffset++;
        } else {
          cg.spectatorOffset = 0; cg.spectatorPaintX = cg.spectatorPaintX2 >= 0 ? cg.spectatorPaintX2 : Math.trunc(f(f(rect.x + rect.width) - 2)); cg.spectatorPaintX2 = -1;
        }
      } else { cg.spectatorPaintX = (cg.spectatorPaintX - 1) | 0; if (cg.spectatorPaintX2 >= 0) cg.spectatorPaintX2 = (cg.spectatorPaintX2 - 1) | 0; }
    }
    const maximum = f(f(rect.x + rect.width) - 2), baseline = f(f(rect.y + rect.height) - 3);
    const max = this.limited(cg.spectatorList.slice(cg.spectatorOffset), cg.spectatorPaintX, baseline, scale, color, maximum);
    if (cg.spectatorPaintX2 >= 0) this.limited(cg.spectatorList, cg.spectatorPaintX2, baseline, scale, color, maximum, cg.spectatorOffset);
    if (cg.spectatorOffset !== 0 && max > 0) { if (cg.spectatorPaintX2 === -1) cg.spectatorPaintX2 = Math.trunc(maximum); }
    else cg.spectatorPaintX2 = -1;
  }
  private medal(id: number, rect: Rect2D, scale: number, inputColor: Vec4, picture: UiOwnerDrawPaintRequest["background"]): void {
    const score = slot(this.state.scores, this.state.selectedScore);
    let value = 0, text: string | null = null, color = { ...inputColor, w: 0.25 };
    switch (id) {
      case ID.CG_ACCURACY: value = f(score.accuracy); break;
      case ID.CG_ASSISTS: value = f(score.assistCount); break;
      case ID.CG_DEFEND: value = f(score.defendCount); break;
      case ID.CG_EXCELLENT: value = f(score.excellentCount); break;
      case ID.CG_IMPRESSIVE: value = f(score.impressiveCount); break;
      case ID.CG_PERFECT: value = f(score.perfect); break;
      case ID.CG_GAUNTLET: value = f(score.guantletCount); break;
      case ID.CG_CAPTURES: value = f(score.captures); break;
    }
    if (value > 0) {
      if (id === ID.CG_PERFECT) { color.w = 1; text = "Wow"; }
      else if (id === ID.CG_ACCURACY) { text = `${Math.trunc(value)}%`; if (value > 50) color.w = 1; }
      else { text = String(Math.trunc(value)); color.w = 1; }
    }
    this.tools.draw.setColor(color);
    this.tools.draw.stretchPic(rect, { s: 0, t: 0, s2: 1, t2: 1 }, picture === undefined ? this.media.resources.picture(null) : picture);
    if (text !== null) {
      color = { ...color, w: 1 }; value = this.widthText(text, scale);
      this.text(rect, scale, color, text, 0, f(rect.x + f(f(rect.width - value) / 2)), f(f(rect.y + rect.height) + 10));
    }
    this.tools.draw.setColor(null);
  }

  async paint(request: UiOwnerDrawPaintRequest): Promise<void> {
    if (request.draw !== this.tools.draw) throw new Error("Mission owner drawing must share the ordered HUD recorder");
    if (this.cvar("cg_drawStatus") === 0) return;
    const { rect, textScale: scale, color, background: picture, textStyle: style, ownerDraw: id } = request;
    const force2D = (request.ownerDrawFlags & SHOW.CG_SHOW_2DONLY) !== 0, g = this.media.graphics;
    switch (id) {
      case ID.CG_PLAYER_ARMOR_ICON: this.armorIcon(rect, force2D); break;
      case ID.CG_PLAYER_ARMOR_ICON2D: this.armorIcon(rect, true); break;
      case ID.CG_PLAYER_AMMO_ICON: this.ammoIcon(rect, force2D); break;
      case ID.CG_PLAYER_AMMO_ICON2D: this.ammoIcon(rect, true); break;
      case ID.CG_PLAYER_AMMO_VALUE:
        if (this.state.entityAt(this.ps.clientNum).currentState.weapon !== 0 && this.rawValue(id) > -1) this.number(rect, scale, color, this.rawValue(id), picture, style); break;
      case ID.CG_PLAYER_ARMOR_VALUE: case ID.CG_PLAYER_HEALTH: case ID.CG_PLAYER_SCORE: case ID.CG_SELECTEDPLAYER_HEALTH:
        this.number(rect, scale, color, this.rawValue(id), picture, style); break;
      case ID.CG_SELECTEDPLAYER_ARMOR:
        if (this.selected().armor > 0) this.number(rect, scale, color, this.selected().armor, picture, style); break;
      case ID.CG_SELECTEDPLAYER_HEAD: case ID.CG_VOICE_HEAD:
        this.host.icons.drawHead(rect, id === ID.CG_VOICE_HEAD ? this.staticState.currentVoiceClient : this.selectedIndex(), vec3(0, 180, 0)); break;
      case ID.CG_SELECTEDPLAYER_NAME: case ID.CG_VOICE_NAME:
        this.text(rect, scale, color, this.client(id === ID.CG_VOICE_NAME ? this.staticState.currentVoiceClient : this.selectedIndex()).name, style); break;
      case ID.CG_SELECTEDPLAYER_LOCATION: this.text(rect, scale, color, this.location(this.selected().location), style); break;
      case ID.CG_PLAYER_LOCATION: this.text(rect, scale, color, this.location(this.client(this.ps.clientNum).location), style); break;
      case ID.CG_SELECTEDPLAYER_STATUS: this.selectedStatus(rect); break;
      case ID.CG_PLAYER_STATUS: this.tools.drawPic(rect, this.statusHandle(this.client(this.ps.clientNum).teamTask)); break;
      case ID.CG_SELECTEDPLAYER_WEAPON: this.tools.drawPic(rect, this.media.weaponRegistry.weapon(this.selected().curWeapon).weaponIcon ?? g.deferShader); break;
      case ID.CG_SELECTEDPLAYER_POWERUP: await this.selectedPowerup(rect); break;
      case ID.CG_PLAYER_HEAD: this.playerHead(rect); break;
      case ID.CG_PLAYER_ITEM: await this.item(rect, false); break;
      case ID.CG_CTF_POWERUP: await this.item(rect, true); break;
      case ID.CG_RED_SCORE: case ID.CG_BLUE_SCORE: {
        const value = id === ID.CG_RED_SCORE ? this.staticState.scores1 : this.staticState.scores2, text = value === SCORE_NOT_PRESENT ? "-" : String(value);
        this.text(rect, scale, color, text, style, f(f(rect.x + rect.width) - this.widthText(text, scale))); break;
      }
      case ID.CG_RED_NAME: case ID.CG_BLUE_NAME:
        this.text(rect, scale, color, this.host.configuration.readVmCvar(id === ID.CG_RED_NAME ? "g_redteam" : "g_blueteam").value, style); break;
      case ID.CG_BLUE_FLAGHEAD: this.flagHead(rect, true); break;
      case ID.CG_RED_FLAGHEAD: this.flagHead(rect, false); break;
      case ID.CG_BLUE_FLAGSTATUS: this.flagStatus(rect, true, picture); break;
      case ID.CG_RED_FLAGSTATUS: this.flagStatus(rect, false, picture); break;
      case ID.CG_BLUE_FLAGNAME: case ID.CG_RED_FLAGNAME: {
        const carrier = this.flagCarrier(id === ID.CG_BLUE_FLAGNAME); if (carrier !== null) this.text(rect, scale, color, this.client(carrier).name, style); break;
      }
      case ID.CG_HARVESTER_SKULLS: this.skulls(rect, scale, color, false, style); break;
      case ID.CG_HARVESTER_SKULLS2D: this.skulls(rect, scale, color, true, style); break;
      case ID.CG_ONEFLAG_STATUS: this.oneFlagStatus(rect); break;
      case ID.CG_TEAM_COLOR: this.host.icons.drawTeamBackground(rect, color.w, this.team); break;
      case ID.CG_AREA_POWERUP: await this.areaPowerup(rect, request.alignment, request.special, scale, color); break;
      case ID.CG_PLAYER_HASFLAG: this.playerHasFlag(rect, false); break;
      case ID.CG_PLAYER_HASFLAG2D: this.playerHasFlag(rect, true); break;
      case ID.CG_AREA_SYSTEMCHAT: this.text(rect, scale, color, this.host.chat().system, 0); break;
      case ID.CG_AREA_TEAMCHAT: this.text(rect, scale, color, this.host.chat().team1, 0); break;
      case ID.CG_AREA_CHAT: this.text(rect, scale, color, this.host.chat().team2, 0); break;
      case ID.CG_GAME_TYPE: this.text(rect, scale, color, this.gameTypeText(), style); break;
      case ID.CG_GAME_STATUS: this.text(rect, scale, color, this.gameStatusText(), style); break;
      case ID.CG_KILLER: if (this.state.killerName.length > 0) this.text(rect, scale, color, this.killerText(), style,
        Math.trunc(f(rect.x + f(rect.width / 2))) - Math.trunc(this.widthText(this.killerText(), scale) / 2)); break;
      case ID.CG_ACCURACY: case ID.CG_ASSISTS: case ID.CG_DEFEND: case ID.CG_EXCELLENT: case ID.CG_IMPRESSIVE: case ID.CG_PERFECT: case ID.CG_GAUNTLET: case ID.CG_CAPTURES:
        this.medal(id, rect, scale, color, picture); break;
      case ID.CG_SPECTATORS: this.spectators(rect, scale, color); break;
      case ID.CG_TEAMINFO: if (this.cvar("cg_currentSelectedPlayer") === this.state.numSortedTeamPlayers) await this.teamInfo(rect, request.textY, scale, color); break;
      case ID.CG_CAPFRAGLIMIT:
        this.text(rect, scale, color, String(this.staticState.gameType >= GameType.GT_CTF ? this.staticState.capturelimit : this.staticState.fraglimit).padStart(2, " "), style, rect.x, rect.y); break;
      case ID.CG_1STPLACE: case ID.CG_2NDPLACE: {
        const value = id === ID.CG_1STPLACE ? this.staticState.scores1 : this.staticState.scores2;
        if (value !== SCORE_NOT_PRESENT) this.text(rect, scale, color, String(value).padStart(2, " "), style, rect.x, rect.y); break;
      }
    }
  }
}
