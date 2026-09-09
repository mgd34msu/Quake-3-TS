// HUD composition from id Software's code/cgame/cg_draw.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import { vec3, vec4 } from "../core/math.ts";
import type { Vec4 } from "../core/math.ts";
import { gameFormat } from "../game/format.ts";
import type { GameRandom } from "../game/numeric.ts";
import { textPaint, textWidth } from "../render/font.ts";
import type { FontSet } from "../render/font.ts";
import { GameType, MoveType, PersistentIndex, Powerup, Team, WeaponState, statSchema } from "../shared/definitions.ts";
import { MoveFlags } from "../shared/player-state.ts";
import type { ClientInfo } from "./client-info.ts";
import type { ClientDrawIcons } from "./draw-icons.ts";
import type { ClientDrawStatus } from "./draw-status.ts";
import { colorForHealth, drawStrlen, fadeColor } from "./draw-tools.ts";
import type { ClientHudCorners } from "./hud-corners.ts";
import type { MissionHud } from "./mission-hud.ts";
import type { PredictionRuntime } from "./prediction.ts";
import type { BaseScoreboard } from "./scoreboard.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";
import type { ClientWeaponRuntime } from "./weapons.ts";

export type ClientHudCvar = "cg_draw2D" | "cg_drawStatus" | "cg_drawIcons" | "cg_draw3dIcons" | "cg_drawRewards"
  | "cg_drawCrosshair" | "cg_crosshairHealth" | "cg_crosshairSize" | "cg_crosshairX" | "cg_crosshairY"
  | "cg_drawCrosshairNames" | "cg_drawAmmoWarning" | "cg_paused";

export interface ClientHudHost {
  readonly icons: ClientDrawIcons;
  readonly status: ClientDrawStatus;
  readonly corners: ClientHudCorners;
  readonly prediction: PredictionRuntime;
  readonly weapons: ClientWeaponRuntime;
  readonly random: GameRandom;
  readVmCvar(name: ClientHudCvar): CvarSnapshot;
  readonly startLocalSound: (sound: PcmSound | null, channel: number) => void;
}

export type ClientHudVariant =
  | { readonly kind: "baseq3"; readonly scoreboard: BaseScoreboard }
  | { readonly kind: "missionpack"; readonly fonts: FontSet; readonly menus: MissionHud };

const f = Math.fround, WHITE = vec4(1, 1, 1, 1), RED = vec4(1, 0, 0, 1);
const NORMAL = vec4(1, f(0.69), 0, 1), LOW = vec4(1, f(0.2), f(0.2), 1), FIRING = vec4(0.5, 0.5, 0.5, 1);
const ICON = 48, DAMAGE_TIME = 500;

/** One HUD instance per cgame lifetime; source static warning timers live here. */
export class ClientHud {
  private proxTime = 0;
  private proxCounter = 0;
  private proxTick = 0;
  constructor(readonly state: ClientGameState, readonly staticState: ClientGameStaticState,
    readonly host: ClientHudHost, readonly variant: ClientHudVariant) {
    if (state.product !== staticState.product || variant.kind !== state.product || host.icons.state !== state
      || host.icons.tools.media.staticState !== staticState || host.status.state !== state || host.status.tools !== host.icons.tools
      || host.corners.state !== state || host.corners.staticState !== staticState || host.corners.icons !== host.icons
      || host.prediction.state !== state || host.weapons.state !== state || host.weapons.registry !== host.icons.tools.media.weaponRegistry) {
      throw new Error("HUD services must share canonical cgame state, drawing and weapon media");
    }
    if (variant.kind === "baseq3" && (variant.scoreboard.state !== state || variant.scoreboard.host.icons !== host.icons)) {
      throw new Error("HUD scoreboard must share canonical drawing and state");
    }
    if (variant.kind === "missionpack" && variant.fonts.profile !== "cgame") throw new Error("Missionpack HUD requires cgame fonts");
    if (variant.kind === "missionpack" && (variant.menus.state !== state || variant.menus.staticState !== staticState
      || variant.menus.host.icons !== host.icons || variant.fonts !== variant.menus.fonts)) {
      throw new Error("Missionpack HUD must share its menu, font and drawing owners");
    }
  }
  private get tools() { return this.host.icons.tools; }
  private snapshot() {
    const snap = this.state.snap;
    if (snap === null) throw new Error("CG_Draw2D requires a current snapshot");
    return snap.playerState;
  }
  private client(index: number) {
    const client = this.staticState.clientInfo[index];
    if (client === undefined) throw new RangeError(`HUD client index outside source array: ${index}`);
    return client;
  }
  private reward(index: number) {
    const reward = this.state.rewards[index];
    if (reward === undefined) throw new RangeError(`HUD reward index outside source array: ${index}`);
    return reward;
  }
  private enabled(name: ClientHudCvar): boolean { return this.host.readVmCvar(name).integerValue !== 0; }
  private baseOnly(operation: string): void {
    if (this.variant.kind !== "baseq3") throw new Error(`${operation} is excluded from the missionpack build`);
  }

  drawStatusBarHead(x: number): void {
    this.baseOnly("CG_DrawStatusBarHead");
    x = f(x);
    const state = this.state, random = this.host.random;
    let size = 60;
    if (state.damageTime !== 0 && f(f(state.time) - state.damageTime) < DAMAGE_TIME) {
      const frac = f(f(f(state.time) - state.damageTime) / DAMAGE_TIME);
      size = f(60 * f(1.5 - f(frac * 0.5)));
      const stretch = f(size - 60);
      x = f(x - f(f(stretch * 0.5) + f(f(state.damageX * stretch) * 0.5)));
      state.headStartYaw = f(180 + f(state.damageX * 45));
      state.headEndYaw = f(180 + f(20 * f(Math.cos(f(random.crandom() * f(Math.PI))))));
      state.headEndPitch = f(5 * f(Math.cos(f(random.crandom() * f(Math.PI)))));
      state.headStartTime = state.time;
      state.headEndTime = Math.trunc(f(f((state.time + 100) | 0) + f(random.random() * 2000))) | 0;
    } else if (state.time >= state.headEndTime) {
      state.headStartYaw = state.headEndYaw; state.headStartPitch = state.headEndPitch; state.headStartTime = state.headEndTime;
      state.headEndTime = Math.trunc(f(f((state.time + 100) | 0) + f(random.random() * 2000))) | 0;
      state.headEndYaw = f(180 + f(20 * f(Math.cos(f(random.crandom() * f(Math.PI))))));
      state.headEndPitch = f(5 * f(Math.cos(f(random.crandom() * f(Math.PI)))));
    }
    if (state.headStartTime > state.time) state.headStartTime = state.time;
    let frac = f(f((state.time - state.headStartTime) | 0) / f((state.headEndTime - state.headStartTime) | 0));
    frac = f(f(frac * frac) * f(3 - f(2 * frac)));
    const angles = vec3(f(state.headStartPitch + f(f(state.headEndPitch - state.headStartPitch) * frac)),
      f(state.headStartYaw + f(f(state.headEndYaw - state.headStartYaw) * frac)), 0);
    this.host.icons.drawHead({ x, y: f(480 - size), width: size, height: size }, this.snapshot().clientNum, angles);
  }

  drawStatusBarFlag(x: number, team: number): void {
    this.baseOnly("CG_DrawStatusBarFlag");
    this.host.icons.drawFlagModel({ x, y: 432, width: ICON, height: ICON }, team, false);
  }

  drawStatusBar(): void {
    this.baseOnly("CG_DrawStatusBar");
    if (!this.enabled("cg_drawStatus")) return;
    const state = this.state, ps = this.snapshot(), predicted = state.predictedPlayerState, icons = this.host.icons;
    const registry = this.tools.media.weaponRegistry, graphics = this.tools.media.graphics, stats = statSchema(ps.product);
    icons.drawTeamBackground({ x: 0, y: 420, width: 640, height: 60 }, f(0.33), ps.persistant.get(PersistentIndex.PERS_TEAM));
    const weapon = state.entityAt(ps.clientNum).currentState.weapon;
    const ammoModel = registry.weapon(weapon).ammoModel;
    if (weapon !== 0 && ammoModel.kind !== "default") icons.draw3DModel({ x: 100, y: 432, width: ICON, height: ICON },
      ammoModel, null, vec3(70, 0, 0), vec3(0, f(90 + f(20 * f(Math.sin(f(f(state.time) / 1000))))), 0));
    this.drawStatusBarHead(285);
    if (predicted.powerups.get(Powerup.PW_REDFLAG)) this.drawStatusBarFlag(333, Team.TEAM_RED);
    else if (predicted.powerups.get(Powerup.PW_BLUEFLAG)) this.drawStatusBarFlag(333, Team.TEAM_BLUE);
    else if (predicted.powerups.get(Powerup.PW_NEUTRALFLAG)) this.drawStatusBarFlag(333, Team.TEAM_FREE);
    if (ps.stats.get(stats.armor) !== 0) icons.draw3DModel({ x: 470, y: 432, width: ICON, height: ICON }, graphics.armorModel,
      null, vec3(90, 0, -10), vec3(0, f((state.time & 2047) * 360 / 2048), 0));
    if (weapon !== 0) {
      const ammo = ps.ammo.get(weapon);
      if (ammo > -1) {
        this.tools.draw.setColor(predicted.weaponState === WeaponState.WEAPON_FIRING && predicted.weaponTime > 100 ? FIRING : NORMAL);
        this.host.corners.drawField(0, 432, 3, ammo); this.tools.draw.setColor(null);
        if (!this.enabled("cg_draw3dIcons") && this.enabled("cg_drawIcons")) {
          const icon = registry.weapon(predicted.weapon).ammoIcon;
          if (icon !== null) this.tools.drawPic({ x: 100, y: 432, width: ICON, height: ICON }, icon);
        }
      }
    }
    const health = ps.stats.get(stats.health);
    this.tools.draw.setColor(health > 100 ? WHITE : health > 25 ? NORMAL : health > 0 ? ((state.time >> 8) & 1) ? LOW : NORMAL : LOW);
    this.host.corners.drawField(185, 432, 3, health);
    this.tools.draw.setColor(colorForHealth(state));
    const armor = ps.stats.get(stats.armor);
    if (armor > 0) {
      this.tools.draw.setColor(NORMAL); this.host.corners.drawField(370, 432, 3, armor); this.tools.draw.setColor(null);
      if (!this.enabled("cg_draw3dIcons") && this.enabled("cg_drawIcons")) this.tools.drawPic({ x: 470, y: 432, width: ICON, height: ICON }, graphics.armorIcon);
    }
  }

  async drawHoldableItem(): Promise<void> {
    this.baseOnly("CG_DrawHoldableItem");
    const value = this.snapshot().stats.get(statSchema(this.state.product).holdableItem);
    if (value === 0) return;
    const registry = this.tools.media.weaponRegistry;
    await registry.registerItemVisuals(value);
    const item = registry.items[value];
    if (item === undefined) throw new RangeError(`HUD holdable item outside source array: ${value}`);
    this.tools.drawPic({ x: 592, y: 216, width: ICON, height: ICON }, item.icon);
  }

  drawReward(): void {
    if (!this.enabled("cg_drawRewards")) return;
    const state = this.state;
    let color = fadeColor(state.time, state.rewardTime, 3000);
    if (color === null) {
      if (state.rewardStack <= 0) return;
      for (let index = 0; index < state.rewardStack; index++) Object.assign(this.reward(index), this.reward(index + 1));
      state.rewardTime = state.time; state.rewardStack--;
      color = fadeColor(state.time, state.rewardTime, 3000);
      this.host.startLocalSound(this.reward(0).sound, 7);
    }
    this.tools.draw.setColor(color);
    const reward = this.reward(0);
    if (reward.count >= 10) {
      this.tools.drawPic({ x: 296, y: 56, width: 44, height: 44 }, reward.shader);
      const text = gameFormat("%d", [reward.count], 32);
      if (color === null) throw new Error("CG_DrawReward: source null text color at zero reward time");
      this.fixedText((640 - 8 * drawStrlen(text)) / 2, 104, text, 8, 16, color);
    } else {
      for (let index = 0, x = 320 - reward.count * 24; index < reward.count; index++, x += ICON) {
        this.tools.drawPic({ x, y: 56, width: 44, height: 44 }, reward.shader);
      }
    }
    this.tools.draw.setColor(null);
  }

  drawCrosshair(): void {
    if (!this.enabled("cg_drawCrosshair") || this.snapshot().persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR || this.state.renderingThirdPerson) return;
    this.tools.draw.setColor(this.enabled("cg_crosshairHealth") ? colorForHealth(this.state) : null);
    let size = f(this.host.readVmCvar("cg_crosshairSize").numericValue);
    const elapsed = f((this.state.time - this.state.itemPickupBlendTime) | 0);
    if (elapsed > 0 && elapsed < 200) size = f(size * f(1 + f(elapsed / 200)));
    const rect = this.tools.adjustFrom640({ x: this.host.readVmCvar("cg_crosshairX").integerValue,
      y: this.host.readVmCvar("cg_crosshairY").integerValue, width: size, height: size });
    const index = Math.max(0, this.host.readVmCvar("cg_drawCrosshair").integerValue) % 10;
    const shader = this.tools.media.graphics.crosshairShader[index];
    if (shader === undefined) throw new RangeError("HUD crosshair shader outside source array");
    const view = this.state.refdef;
    this.tools.draw.stretchPixels({ ...rect, x: f(f(rect.x + f(view.x)) + f(0.5 * f(f(view.width) - rect.width))),
      y: f(f(rect.y + f(view.y)) + f(0.5 * f(f(view.height) - rect.height))) }, { s: 0, t: 0, s2: 1, t2: 1 }, this.tools.media.resources.picture(shader));
  }

  scanForCrosshairEntity(): void {
    const view = this.state.refdef, start = view.viewOrigin, axis = view.viewAxis[0];
    const end = vec3(f(start.x + f(131072 * axis.x)), f(start.y + f(131072 * axis.y)), f(start.z + f(131072 * axis.z)));
    const zero = vec3(0, 0, 0), prediction = this.host.prediction;
    const trace = prediction.trace(start, end, { min: zero, max: zero }, this.snapshot().clientNum, 1 | 0x2000000);
    if (trace.entityNum >= 64) return;
    if (prediction.collision.pointContents(trace.end, 0) & 64) return;
    if (this.state.entityAt(trace.entityNum).currentState.powerups & (1 << Powerup.PW_INVIS)) return;
    this.state.crosshairClientNum = trace.entityNum; this.state.crosshairClientTime = this.state.time;
  }

  drawCrosshairNames(): void {
    if (!this.enabled("cg_drawCrosshair") || !this.enabled("cg_drawCrosshairNames") || this.state.renderingThirdPerson) return;
    this.scanForCrosshairEntity();
    const color = fadeColor(this.state.time, this.state.crosshairClientTime, 1000);
    if (color === null) { this.tools.draw.setColor(null); return; }
    const name = this.client(this.state.crosshairClientNum).name;
    if (this.variant.kind === "missionpack") this.proportional(name, 190, f(0.3), { ...color, w: f(color.w * 0.5) }, 3);
    else this.tools.drawBigString(320 - drawStrlen(name) * 8, 170, name, f(color.w * 0.5));
    this.tools.draw.setColor(null);
  }

  drawSpectator(): void {
    this.tools.drawBigString(248, 440, "SPECTATOR", 1);
    if (this.staticState.gameType === GameType.GT_TOURNAMENT) this.tools.drawBigString(200, 460, "waiting to play", 1);
    else if (this.staticState.gameType >= GameType.GT_TEAM) this.tools.drawBigString(8, 460, "press ESC and use the JOIN menu to play", 1);
  }
  drawVote(): void {
    const cgs = this.staticState;
    if (cgs.voteTime === 0) return;
    if (cgs.voteModified) { cgs.voteModified = false; this.host.startLocalSound(this.tools.media.sounds.talkSound, 6); }
    const sec = Math.max(0, Math.trunc(((30000 - ((this.state.time - cgs.voteTime) | 0)) | 0) / 1000));
    this.tools.drawSmallString(0, 58, gameFormat("VOTE(%i):%s yes:%i no:%i", [sec, cgs.voteString, cgs.voteYes, cgs.voteNo]), 1);
    if (this.variant.kind === "missionpack") this.tools.drawSmallString(0, 76, "or press ESC then click Vote", 1);
  }
  drawTeamVote(): void {
    const cgs = this.staticState, team = this.client(0).team;
    if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return;
    const index = team === Team.TEAM_RED ? 0 : 1;
    if (cgs.teamVoteTime[index] === 0) return;
    if (cgs.teamVoteModified[index]) { cgs.teamVoteModified[index] = false; this.host.startLocalSound(this.tools.media.sounds.talkSound, 6); }
    const sec = Math.max(0, Math.trunc(((30000 - ((this.state.time - cgs.teamVoteTime[index]) | 0)) | 0) / 1000));
    this.tools.drawSmallString(0, 90, gameFormat("TEAMVOTE(%i):%s yes:%i no:%i", [sec, cgs.teamVoteString[index], cgs.teamVoteYes[index], cgs.teamVoteNo[index]]), 1);
  }
  drawFollow(): boolean {
    const ps = this.snapshot();
    if (!(ps.pmFlags & MoveFlags.FOLLOW)) return false;
    this.tools.drawBigString(248, 24, "following", 1);
    const name = this.client(ps.clientNum).name;
    this.fixedText(0.5 * (640 - 32 * drawStrlen(name)), 40, name, 32, 48, WHITE, true);
    return true;
  }
  drawAmmoWarning(): void {
    if (!this.enabled("cg_drawAmmoWarning") || this.state.lowAmmoWarning === 0) return;
    const text = this.state.lowAmmoWarning === 2 ? "OUT OF AMMO" : "LOW AMMO WARNING";
    this.tools.drawBigString(320 - drawStrlen(text) * 8, 64, text, 1);
  }
  drawProxWarning(): void {
    if (this.variant.kind !== "missionpack") throw new Error("CG_DrawProxWarning is excluded from the baseq3 build");
    if (!(this.snapshot().eFlags & 2)) { this.proxTime = 0; return; }
    if (this.proxTime === 0) { this.proxTime = (this.state.time + 5000) | 0; this.proxCounter = 5; this.proxTick = 0; }
    if (this.state.time > this.proxTime) { this.proxTick = this.proxCounter; this.proxCounter = (this.proxCounter - 1) | 0; this.proxTime = (this.state.time + 1000) | 0; }
    const text = this.proxTick !== 0 ? gameFormat("INTERNAL COMBUSTION IN: %i", [this.proxTick], 32) : "YOU HAVE BEEN MINED";
    this.tools.drawBigStringColor(320 - drawStrlen(text) * 8, 80, text, RED);
  }
  private fixedText(x: number, y: number, text: string, charWidth: number, charHeight: number, color: Vec4, forceColor = false): void {
    this.tools.drawStringExt({ x: Math.trunc(x), y, text, color, charWidth, charHeight, forceColor, shadow: true, maxChars: 0 });
  }
  private proportional(text: string, y: number, scale: number, color: Vec4, style: number, integerWidth = false): void {
    if (this.variant.kind !== "missionpack") throw new Error("Proportional HUD text requires missionpack fonts");
    const width = textWidth(this.variant.fonts, text, scale, 0);
    const halfWidth = integerWidth ? Math.trunc(width / 2) : f(width / 2);
    textPaint(this.tools.draw, this.variant.fonts, { x: f(320 - halfWidth), y, scale, color, text, adjust: 0, limit: 0, style });
  }
  drawWarmup(): void {
    const state = this.state, cgs = this.staticState;
    if (state.warmup === 0) return;
    if (state.warmup < 0) { const text = "Waiting for players"; this.tools.drawBigString(320 - drawStrlen(text) * 8, 24, text, 1); state.warmupCount = 0; return; }
    let heading = "", drawHeading = true;
    if (cgs.gameType === GameType.GT_TOURNAMENT) {
      let first: ClientInfo | null = null, second: ClientInfo | null = null;
      for (let index = 0; index < cgs.maxclients; index++) {
        const client = this.client(index);
        if (client.infoValid && client.team === Team.TEAM_FREE) { if (first === null) first = client; else second = client; }
      }
      if (first !== null && second !== null) heading = gameFormat("%s vs %s", [first.name, second.name]); else drawHeading = false;
    } else if (cgs.gameType === GameType.GT_FFA) heading = "Free For All";
    else if (cgs.gameType === GameType.GT_TEAM) heading = "Team Deathmatch";
    else if (cgs.gameType === GameType.GT_CTF) heading = "Capture the Flag";
    else if (this.variant.kind === "missionpack") {
      if (cgs.gameType === GameType.GT_1FCTF) heading = "One Flag CTF";
      else if (cgs.gameType === GameType.GT_OBELISK) heading = "Overload";
      else if (cgs.gameType === GameType.GT_HARVESTER) heading = "Harvester";
    }
    if (drawHeading) {
      const tournament = cgs.gameType === GameType.GT_TOURNAMENT;
      if (this.variant.kind === "missionpack") this.proportional(heading, tournament ? 60 : 90, f(0.6), WHITE, 6, true);
      else { const width = drawStrlen(heading), cw = width > 20 ? Math.trunc(640 / width) : 32;
        this.fixedText(320 - Math.trunc(width * cw / 2), tournament ? 20 : 25, heading, cw, Math.trunc(f(cw * f(tournament ? 1.5 : 1.1))), WHITE); }
    }
    let sec = Math.trunc(((state.warmup - state.time) | 0) / 1000);
    if (sec < 0) { state.warmup = 0; sec = 0; }
    const text = gameFormat("Starts in: %i", [(sec + 1) | 0]);
    if (sec !== state.warmupCount) {
      state.warmupCount = sec;
      const sounds = this.tools.media.sounds;
      if (sec === 0) this.host.startLocalSound(sounds.count1Sound, 7);
      else if (sec === 1) this.host.startLocalSound(sounds.count2Sound, 7);
      else if (sec === 2) this.host.startLocalSound(sounds.count3Sound, 7);
    }
    const count = state.warmupCount, cw = count === 0 ? 28 : count === 1 ? 24 : count === 2 ? 20 : 16;
    if (this.variant.kind === "missionpack") this.proportional(text, 125, f(count === 0 ? 0.54 : count === 1 ? 0.51 : count === 2 ? 0.48 : 0.45), WHITE, 6, true);
    else this.fixedText(320 - Math.trunc(drawStrlen(text) * cw / 2), 70, text, cw, Math.trunc(cw * 1.5), WHITE);
  }
  async drawTimedMenus(): Promise<void> {
    if (this.variant.kind !== "missionpack") throw new Error("CG_DrawTimedMenus is excluded from baseq3");
    await this.variant.menus.drawTimedMenus();
  }
  async drawScoreboard(): Promise<boolean> {
    if (this.variant.kind === "missionpack") return this.variant.menus.drawScoreboard();
    return this.variant.scoreboard.draw();
  }
  async drawIntermission(): Promise<void> {
    if (this.variant.kind === "baseq3" && this.staticState.gameType === GameType.GT_SINGLE_PLAYER) { this.host.status.drawCenterString(); return; }
    this.state.scoreFadeTime = this.state.time;
    this.state.scoreBoardShowing = await this.drawScoreboard();
  }
  drawTourneyScoreboard(): void {
    if (this.variant.kind === "baseq3") this.variant.scoreboard.drawTourney();
  }
  async draw2D(): Promise<void> {
    const state = this.state, cgs = this.staticState;
    if (this.variant.kind === "missionpack" && cgs.orderPending && state.time > cgs.orderTime) this.variant.menus.checkOrderPending();
    if (state.levelShot || !this.enabled("cg_draw2D")) return;
    const ps = this.snapshot();
    if (ps.pmType === MoveType.PM_INTERMISSION) { await this.drawIntermission(); return; }
    if (ps.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR) {
      this.drawSpectator(); this.drawCrosshair(); this.drawCrosshairNames();
    } else {
      if (!state.showScores && ps.stats.get(statSchema(ps.product).health) > 0) {
        if (this.variant.kind === "missionpack") {
          if (this.enabled("cg_drawStatus")) { await this.variant.menus.paintAll(); await this.drawTimedMenus(); }
        } else this.drawStatusBar();
        this.drawAmmoWarning();
        if (this.variant.kind === "missionpack") this.drawProxWarning();
        this.drawCrosshair(); this.drawCrosshairNames(); this.host.weapons.drawWeaponSelect();
        if (this.variant.kind === "baseq3") await this.drawHoldableItem();
        this.drawReward();
      }
      if (cgs.gameType >= GameType.GT_TEAM && this.variant.kind === "baseq3") this.host.corners.drawTeamInfo();
    }
    this.drawVote(); this.drawTeamVote(); await this.host.status.drawLagometer();
    if (this.variant.kind === "baseq3" || !this.enabled("cg_paused")) await this.host.corners.drawUpperRight();
    if (this.variant.kind === "baseq3") { await this.host.corners.drawLowerRight(); await this.host.corners.drawLowerLeft(); }
    if (!this.drawFollow()) this.drawWarmup();
    state.scoreBoardShowing = await this.drawScoreboard();
    if (!state.scoreBoardShowing) this.host.status.drawCenterString();
  }
}
