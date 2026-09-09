// Ported from id Software's code/cgame/cg_draw.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import type { CvarSnapshot } from "../core/cvar.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { vec3 } from "../core/math.ts";
import type { Vec4 } from "../core/math.ts";
import { gameFormat } from "../game/format.ts";
import { GameType, PersistentIndex, Powerup, Team, statSchema } from "../shared/definitions.ts";
import { findItemForPowerup, itemAt } from "../shared/items.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import { drawStrlen, fadeColor, getColorForHealth } from "./draw-tools.ts";
import type { ClientDrawIcons } from "./draw-icons.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";

const f = Math.fround;
const ICON_SIZE = 48;
const CHAR_WIDTH = 32;
const CHAR_HEIGHT = 48;
const BIGCHAR_WIDTH = 16;
const BIGCHAR_HEIGHT = 16;
const TINYCHAR_WIDTH = 8;
const TINYCHAR_HEIGHT = 8;
const MAX_TEAM_OVERLAY_PLAYERS = 8;
const TEAM_OVERLAY_MAXNAME_WIDTH = 12;
const TEAM_OVERLAY_MAXLOCATION_WIDTH = 16;
const MAX_LOCATIONS = 64;
const TEAMCHAT_HEIGHT = 8;
const SCORE_NOT_PRESENT = -9999;
const CS_PLAYERS = 544;
const CS_LOCATIONS = 608;
const ATTACKER_HEAD_TIME = 10_000;
const POWERUP_BLINKS = 5;
const POWERUP_BLINK_TIME = 1_000;
const PULSE_TIME = 200;
const PULSE_SCALE = 1.5;
const FPS_FRAMES = 4;

export type ClientHudCornerCvar =
  | "cg_drawTeamOverlay"
  | "cg_drawSnapshot"
  | "cg_drawFPS"
  | "cg_drawTimer"
  | "cg_drawAttacker"
  | "cg_teamChatHeight"
  | "cg_teamChatTime";

export interface ClientHudCornersHost {
  readVmCvar(name: ClientHudCornerCvar): CvarSnapshot;
  configString(index: number): string;
  milliseconds(): number;
}

const POWERUPS: readonly Powerup[] = [
  Powerup.PW_NONE, Powerup.PW_QUAD, Powerup.PW_BATTLESUIT, Powerup.PW_HASTE,
  Powerup.PW_INVIS, Powerup.PW_REGEN, Powerup.PW_FLIGHT, Powerup.PW_REDFLAG,
  Powerup.PW_BLUEFLAG, Powerup.PW_NEUTRALFLAG, Powerup.PW_SCOUT, Powerup.PW_GUARD,
  Powerup.PW_DOUBLER, Powerup.PW_AMMOREGEN, Powerup.PW_INVULNERABILITY,
  Powerup.PW_NUM_POWERUPS,
];

function integerDivision(numerator: number, denominator: number): number {
  return Math.trunc(numerator / denominator) | 0;
}

function activePlayerState(state: ClientGameState): SourcePlayerState {
  const snapshot = state.snap;
  if (snapshot === null) throw new Error("HUD corners require a current snapshot");
  return snapshot.playerState;
}

export class ClientHudCorners {
  private readonly previousTimes = new Int32Array(FPS_FRAMES);
  private fpsIndex = 0;
  private previousMilliseconds = 0;

  constructor(
    readonly state: ClientGameState,
    readonly staticState: ClientGameStaticState,
    readonly icons: ClientDrawIcons,
    private readonly host: ClientHudCornersHost,
  ) {
    if (icons.state !== state) throw new Error("HUD corners and icons must share client state");
    if (icons.tools.media.staticState !== staticState) throw new Error("HUD corners and media must share static state");
    if (state.product !== staticState.product || state.product !== icons.tools.media.product) {
      throw new Error("HUD corner products differ");
    }
  }

  drawField(x: number, y: number, width: number, value: number): void {
    if (this.state.product === "missionpack") throw new Error("CG_DrawField is not compiled in missionpack");
    if (width < 1) return;
    if (width > 5) width = 5;
    value |= 0;
    if (width === 1) value = Math.max(0, Math.min(9, value));
    else if (width === 2) value = Math.max(-9, Math.min(99, value));
    else if (width === 3) value = Math.max(-99, Math.min(999, value));
    else if (width === 4) value = Math.max(-999, Math.min(9999, value));
    const text = gameFormat("%i", [value], 16);
    const length = Math.min(text.length, width);
    let drawX = x + 2 + CHAR_WIDTH * (width - length);
    for (let index = 0; index < length; index++) {
      const code = text.charCodeAt(index);
      const frame = code === 45 ? 10 : code - 48;
      const shader = this.icons.tools.media.graphics.numberShaders[frame];
      if (shader === undefined) throw new RangeError("Invalid field digit frame");
      this.icons.tools.drawPic({ x: drawX, y, width: CHAR_WIDTH, height: CHAR_HEIGHT }, shader);
      drawX += CHAR_WIDTH;
    }
  }

  async drawUpperRight(): Promise<void> {
    let y = 0;
    if (this.staticState.gameType >= GameType.GT_TEAM && this.cvar("cg_drawTeamOverlay") === 1) {
      y = await this.drawTeamOverlay(y, true, true);
    }
    if (this.cvar("cg_drawSnapshot") !== 0) y = this.drawSnapshot(y);
    if (this.cvar("cg_drawFPS") !== 0) y = this.drawFps(y);
    if (this.cvar("cg_drawTimer") !== 0) y = this.drawTimer(y);
    if (this.cvar("cg_drawAttacker") !== 0) this.drawAttacker(y);
  }

  async drawLowerRight(): Promise<void> {
    this.requireBase("CG_DrawLowerRight");
    let y = 480 - ICON_SIZE;
    if (this.staticState.gameType >= GameType.GT_TEAM && this.cvar("cg_drawTeamOverlay") === 2) {
      y = await this.drawTeamOverlay(y, true, false);
    }
    y = this.drawScores(y);
    await this.drawPowerups(y);
  }

  async drawLowerLeft(): Promise<void> {
    this.requireBase("CG_DrawLowerLeft");
    let y = 480 - ICON_SIZE;
    if (this.staticState.gameType >= GameType.GT_TEAM && this.cvar("cg_drawTeamOverlay") === 3) {
      y = await this.drawTeamOverlay(y, false, false);
    }
    await this.drawPickupItem(Math.trunc(y));
  }

  drawTeamInfo(): void {
    this.requireBase("CG_DrawTeamInfo");
    const chatHeight = Math.min(this.cvar("cg_teamChatHeight"), TEAMCHAT_HEIGHT);
    if (chatHeight <= 0) return;
    const cgs = this.staticState;
    if (cgs.teamLastChatPos === cgs.teamChatPos) return;
    const oldest = cgs.teamChatMsgTimes[cgs.teamLastChatPos % chatHeight];
    if (oldest === undefined) throw new RangeError("Invalid team chat ring index");
    if (((this.state.time - oldest) | 0) > this.cvar("cg_teamChatTime")) cgs.teamLastChatPos++;
    const height = (cgs.teamChatPos - cgs.teamLastChatPos) * TINYCHAR_HEIGHT;
    let width = 0;
    for (let index = cgs.teamLastChatPos; index < cgs.teamChatPos; index++) {
      const message = cgs.teamChatMsgs[index % chatHeight];
      if (message === undefined) throw new RangeError("Invalid team chat ring index");
      width = Math.max(width, drawStrlen(message));
    }
    width = width * TINYCHAR_WIDTH + TINYCHAR_WIDTH * 2;
    const team = activePlayerState(this.state).persistant.get(PersistentIndex.PERS_TEAM);
    const color = team === Team.TEAM_RED ? { x: 1, y: 0, z: 0, w: f(0.33) }
      : team === Team.TEAM_BLUE ? { x: 0, y: 0, z: 1, w: f(0.33) }
      : { x: 0, y: 1, z: 0, w: f(0.33) };
    this.icons.tools.draw.setColor(color);
    this.icons.tools.drawPic({ x: 0, y: 420 - height, width: 640, height }, this.icons.tools.media.graphics.teamStatusBar);
    this.icons.tools.draw.setColor(null);
    for (let index = cgs.teamChatPos - 1; index >= cgs.teamLastChatPos; index--) {
      const message = cgs.teamChatMsgs[index % chatHeight];
      if (message === undefined) throw new RangeError("Invalid team chat ring index");
      this.icons.tools.drawStringExt({ x: 8, y: 420 - (cgs.teamChatPos - index) * 8, text: message,
        color: { x: 1, y: 1, z: 1, w: 1 }, forceColor: false, shadow: false,
        charWidth: TINYCHAR_WIDTH, charHeight: TINYCHAR_HEIGHT, maxChars: 0 });
    }
  }

  private cvar(name: ClientHudCornerCvar): number { return this.host.readVmCvar(name).integerValue; }

  private requireBase(sourceName: string): void {
    if (this.state.product === "missionpack") throw new Error(`${sourceName} is not compiled in missionpack`);
  }

  private drawAttacker(y: number): number {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("CG_DrawAttacker requires a current snapshot");
    const predicted = this.state.predictedPlayerState;
    if (predicted.stats.get(statSchema(this.state.product).health) <= 0 || this.state.attackerTime === 0) return y;
    const clientNum = predicted.persistant.get(PersistentIndex.PERS_ATTACKER);
    if (clientNum < 0 || clientNum >= 64 || clientNum === snapshot.playerState.clientNum) return y;
    if (((this.state.time - this.state.attackerTime) | 0) > ATTACKER_HEAD_TIME) {
      this.state.attackerTime = 0;
      return y;
    }
    const size = f(ICON_SIZE * f(1.25));
    this.icons.drawHead({ x: f(640 - size), y, width: size, height: size }, clientNum, vec3(0, 180, 0));
    const name = infoValueForKey(this.host.configString(CS_PLAYERS + clientNum), "n");
    y = f(y + size);
    this.icons.tools.drawBigString(Math.trunc(640 - drawStrlen(name) * BIGCHAR_WIDTH), Math.trunc(y), name, 0.5);
    return f(y + BIGCHAR_HEIGHT + 2);
  }

  private drawSnapshot(y: number): number {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("CG_DrawSnapshot requires a current snapshot");
    const text = gameFormat("time:%i snap:%i cmd:%i", [snapshot.serverTime | 0, this.state.latestSnapshotNum | 0,
      this.staticState.serverCommandSequence | 0]);
    const width = drawStrlen(text) * BIGCHAR_WIDTH;
    this.icons.tools.drawBigString(635 - width, Math.trunc(y + 2), text, 1);
    return f(y + BIGCHAR_HEIGHT + 4);
  }

  private drawFps(y: number): number {
    const time = this.host.milliseconds() | 0;
    const frameTime = (time - this.previousMilliseconds) | 0;
    this.previousMilliseconds = time;
    this.previousTimes[this.fpsIndex % FPS_FRAMES] = frameTime;
    this.fpsIndex++;
    if (this.fpsIndex > FPS_FRAMES) {
      let total = 0;
      for (const elapsed of this.previousTimes) total = (total + elapsed) | 0;
      if (total === 0) total = 1;
      const fps = integerDivision(1000 * FPS_FRAMES, total);
      const text = gameFormat("%ifps", [fps]);
      this.icons.tools.drawBigString(635 - drawStrlen(text) * BIGCHAR_WIDTH, Math.trunc(y + 2), text, 1);
    }
    return f(y + BIGCHAR_HEIGHT + 4);
  }

  private drawTimer(y: number): number {
    const milliseconds = (this.state.time - this.staticState.levelStartTime) | 0;
    let seconds = integerDivision(milliseconds, 1000);
    const minutes = integerDivision(seconds, 60);
    seconds = (seconds - minutes * 60) | 0;
    const tens = integerDivision(seconds, 10);
    seconds = (seconds - tens * 10) | 0;
    const text = gameFormat("%i:%i%i", [minutes, tens, seconds]);
    this.icons.tools.drawBigString(635 - drawStrlen(text) * BIGCHAR_WIDTH, Math.trunc(y + 2), text, 1);
    return f(y + BIGCHAR_HEIGHT + 4);
  }

  private async drawTeamOverlay(y: number, right: boolean, upper: boolean): Promise<number> {
    if (this.cvar("cg_drawTeamOverlay") === 0) return y;
    const playerState = activePlayerState(this.state);
    const team = playerState.persistant.get(PersistentIndex.PERS_TEAM);
    if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return y;
    const count = Math.min(this.state.numSortedTeamPlayers, MAX_TEAM_OVERLAY_PLAYERS);
    let players = 0;
    let playerWidth = 0;
    for (let index = 0; index < count; index++) {
      const client = this.teamClient(index);
      if (client.infoValid && client.team === team) {
        players++;
        playerWidth = Math.max(playerWidth, drawStrlen(client.name));
      }
    }
    if (players === 0) return y;
    playerWidth = Math.min(playerWidth, TEAM_OVERLAY_MAXNAME_WIDTH);
    let locationWidth = 0;
    for (let index = 1; index < MAX_LOCATIONS; index++) {
      const location = this.host.configString(CS_LOCATIONS + index);
      if (location.length > 0) locationWidth = Math.max(locationWidth, drawStrlen(location));
    }
    locationWidth = Math.min(locationWidth, TEAM_OVERLAY_MAXLOCATION_WIDTH);
    const width = (playerWidth + locationWidth + 11) * TINYCHAR_WIDTH;
    const x = right ? 640 - width : 0;
    const height = players * TINYCHAR_HEIGHT;
    const returnY = upper ? y + height : y - height;
    if (!upper) y -= height;
    this.icons.tools.draw.setColor(team === Team.TEAM_RED ? { x: 1, y: 0, z: 0, w: f(0.33) }
      : { x: 0, y: 0, z: 1, w: f(0.33) });
    this.icons.tools.drawPic({ x, y, width, height }, this.icons.tools.media.graphics.teamStatusBar);
    this.icons.tools.draw.setColor(null);
    for (let index = 0; index < count; index++) {
      const client = this.teamClient(index);
      if (!client.infoValid || client.team !== team) continue;
      let xx = x + TINYCHAR_WIDTH;
      this.icons.tools.drawStringExt({ x: xx, y, text: client.name, color: { x: 1, y: 1, z: 1, w: 1 },
        forceColor: false, shadow: false, charWidth: 8, charHeight: 8, maxChars: TEAM_OVERLAY_MAXNAME_WIDTH });
      if (locationWidth !== 0) {
        let location = this.host.configString(CS_LOCATIONS + client.location);
        if (location.length === 0) location = "unknown";
        xx = x + TINYCHAR_WIDTH * 2 + TINYCHAR_WIDTH * playerWidth;
        this.icons.tools.drawStringExt({ x: xx, y, text: location, color: { x: 1, y: 1, z: 1, w: 1 },
          forceColor: false, shadow: false, charWidth: 8, charHeight: 8, maxChars: TEAM_OVERLAY_MAXLOCATION_WIDTH });
      }
      xx = x + TINYCHAR_WIDTH * 3 + TINYCHAR_WIDTH * playerWidth + TINYCHAR_WIDTH * locationWidth;
      this.icons.tools.drawStringExt({ x: xx, y, text: gameFormat("%3i %3i", [client.health | 0, client.armor | 0], 16),
        color: getColorForHealth(client.health, client.armor), forceColor: false, shadow: false,
        charWidth: 8, charHeight: 8, maxChars: 0 });
      xx += TINYCHAR_WIDTH * 3;
      const weapon = this.icons.tools.media.weaponRegistry.weapon(client.curWeapon);
      this.icons.tools.drawPic({ x: xx, y, width: 8, height: 8 }, weapon.weaponIcon ?? this.icons.tools.media.graphics.deferShader);
      xx = right ? x : x + width - TINYCHAR_WIDTH;
      for (const powerup of POWERUPS) {
        if ((client.powerups & (1 << powerup)) === 0) continue;
        const item = findItemForPowerup(this.state.product, powerup);
        if (item === null) continue;
        const shader = item.icon === null ? null : await this.icons.tools.media.resources.registerShader(item.icon);
        this.icons.tools.drawPic({ x: xx, y, width: 8, height: 8 }, shader);
        xx += right ? -TINYCHAR_WIDTH : TINYCHAR_WIDTH;
      }
      y += TINYCHAR_HEIGHT;
    }
    return f(returnY);
  }

  private teamClient(sortedIndex: number) {
    const clientNumber = this.state.sortedTeamPlayers[sortedIndex];
    if (clientNumber === undefined) throw new RangeError("Invalid sorted team player index");
    const client = this.staticState.clientInfo[clientNumber];
    if (client === undefined) throw new RangeError("Invalid sorted team client number");
    return client;
  }

  private drawScores(y: number): number {
    this.requireBase("CG_DrawScores");
    const playerState = activePlayerState(this.state);
    let score1 = this.staticState.scores1 | 0;
    let score2 = this.staticState.scores2 | 0;
    y = f(y - BIGCHAR_HEIGHT - 8);
    let y1 = y;
    let x = 640;
    if (this.staticState.gameType >= GameType.GT_TEAM) {
      let text = gameFormat("%2i", [score2]);
      let width = drawStrlen(text) * BIGCHAR_WIDTH + 8;
      x -= width;
      this.icons.tools.fillRect({ x, y: y - 4, width, height: BIGCHAR_HEIGHT + 8 }, { x: 0, y: 0, z: 1, w: f(0.33) });
      if (playerState.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_BLUE) {
        this.icons.tools.drawPic({ x, y: y - 4, width, height: BIGCHAR_HEIGHT + 8 }, this.icons.tools.media.graphics.selectShader);
      }
      this.icons.tools.drawBigString(x + 4, Math.trunc(y), text, 1);
      if (this.staticState.gameType === GameType.GT_CTF && findItemForPowerup(this.state.product, Powerup.PW_BLUEFLAG) !== null) {
        y1 = f(y - BIGCHAR_HEIGHT - 8);
        if (this.staticState.blueflag >= 0 && this.staticState.blueflag <= 2) {
          const shader = this.icons.tools.media.graphics.blueFlagShader[this.staticState.blueflag];
          if (shader === undefined) throw new RangeError("Invalid blue flag status");
          this.icons.tools.drawPic({ x, y: y1 - 4, width, height: BIGCHAR_HEIGHT + 8 }, shader);
        }
      }
      text = gameFormat("%2i", [score1]);
      width = drawStrlen(text) * BIGCHAR_WIDTH + 8;
      x -= width;
      this.icons.tools.fillRect({ x, y: y - 4, width, height: BIGCHAR_HEIGHT + 8 }, { x: 1, y: 0, z: 0, w: f(0.33) });
      if (playerState.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_RED) {
        this.icons.tools.drawPic({ x, y: y - 4, width, height: BIGCHAR_HEIGHT + 8 }, this.icons.tools.media.graphics.selectShader);
      }
      this.icons.tools.drawBigString(x + 4, Math.trunc(y), text, 1);
      if (this.staticState.gameType === GameType.GT_CTF && findItemForPowerup(this.state.product, Powerup.PW_REDFLAG) !== null) {
        y1 = f(y - BIGCHAR_HEIGHT - 8);
        if (this.staticState.redflag >= 0 && this.staticState.redflag <= 2) {
          const shader = this.icons.tools.media.graphics.redFlagShader[this.staticState.redflag];
          if (shader === undefined) throw new RangeError("Invalid red flag status");
          this.icons.tools.drawPic({ x, y: y1 - 4, width, height: BIGCHAR_HEIGHT + 8 }, shader);
        }
      }
      const limit = this.staticState.gameType >= GameType.GT_CTF ? this.staticState.capturelimit : this.staticState.fraglimit;
      if (limit !== 0) {
        text = gameFormat("%2i", [limit | 0]);
        const width = drawStrlen(text) * BIGCHAR_WIDTH + 8;
        x -= width;
        this.icons.tools.drawBigString(x + 4, Math.trunc(y), text, 1);
      }
    } else {
      const score = playerState.persistant.get(PersistentIndex.PERS_SCORE);
      const spectator = playerState.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR;
      if (score1 !== score) score2 = score;
      if (score2 !== SCORE_NOT_PRESENT) x = this.drawFreeScore(x, y, score2, !spectator && score === score2 && score !== score1, false);
      if (score1 !== SCORE_NOT_PRESENT) x = this.drawFreeScore(x, y, score1, !spectator && score === score1, true);
      if (this.staticState.fraglimit !== 0) {
        const text = gameFormat("%2i", [this.staticState.fraglimit | 0]);
        const width = drawStrlen(text) * BIGCHAR_WIDTH + 8;
        x -= width;
        this.icons.tools.drawBigString(x + 4, Math.trunc(y), text, 1);
      }
    }
    return f(y1 - 8);
  }

  private drawFreeScore(x: number, y: number, score: number, selected: boolean, first: boolean): number {
    const text = gameFormat("%2i", [score | 0]);
    const width = drawStrlen(text) * BIGCHAR_WIDTH + 8;
    x -= width;
    const color = selected ? (first ? { x: 0, y: 0, z: 1, w: f(0.33) } : { x: 1, y: 0, z: 0, w: f(0.33) })
      : { x: f(0.5), y: f(0.5), z: f(0.5), w: f(0.33) };
    this.icons.tools.fillRect({ x, y: y - 4, width, height: BIGCHAR_HEIGHT + 8 }, color);
    if (selected) this.icons.tools.drawPic({ x, y: y - 4, width, height: BIGCHAR_HEIGHT + 8 }, this.icons.tools.media.graphics.selectShader);
    this.icons.tools.drawBigString(x + 4, Math.trunc(y), text, 1);
    return x;
  }

  private async drawPowerups(y: number): Promise<number> {
    this.requireBase("CG_DrawPowerups");
    const playerState = activePlayerState(this.state);
    if (playerState.stats.get(statSchema(this.state.product).health) <= 0) return y;
    const sorted: number[] = [];
    const sortedTimes: number[] = [];
    for (let powerup = 0; powerup < playerState.powerups.length; powerup++) {
      const expiration = playerState.powerups.get(powerup);
      if (expiration === 0) continue;
      const remaining = (expiration - this.state.time) | 0;
      if (remaining < 0 || remaining > 999_000) continue;
      let insertion = 0;
      while (insertion < sortedTimes.length) {
        const existing = sortedTimes[insertion];
        if (existing === undefined || existing >= remaining) break;
        insertion++;
      }
      sorted.splice(insertion, 0, powerup);
      sortedTimes.splice(insertion, 0, remaining);
    }
    const x = 640 - ICON_SIZE - CHAR_WIDTH * 2;
    for (let index = 0; index < sorted.length; index++) {
      const powerup = sorted[index];
      const remaining = sortedTimes[index];
      if (powerup === undefined || remaining === undefined) throw new RangeError("Invalid sorted powerup index");
      const powerupKind = POWERUPS[powerup];
      if (powerupKind === undefined) throw new RangeError("Invalid powerup slot");
      const item = findItemForPowerup(this.state.product, powerupKind);
      if (item === null) continue;
      y = f(y - ICON_SIZE);
      this.icons.tools.draw.setColor({ x: 1, y: f(0.2), z: f(0.2), w: 1 });
      this.drawField(x, y, 2, integerDivision(remaining, 1000));
      let modulation: Vec4 | null = null;
      if (remaining < POWERUP_BLINKS * POWERUP_BLINK_TIME) {
        let fraction = f(f(remaining) / f(POWERUP_BLINK_TIME));
        fraction = f(fraction - Math.trunc(fraction));
        modulation = { x: fraction, y: fraction, z: fraction, w: fraction };
      }
      this.icons.tools.draw.setColor(modulation);
      let size = ICON_SIZE;
      if (this.state.powerupActive === powerup && ((this.state.time - this.state.powerupTime) | 0) < PULSE_TIME) {
        const pulse = f(1 - f(f(f(this.state.time) - f(this.state.powerupTime)) / f(PULSE_TIME)));
        size = f(f(ICON_SIZE) * f(1 + f(f(PULSE_SCALE - 1) * pulse)));
      }
      const shader = item.icon === null ? null : await this.icons.tools.media.resources.registerShader(item.icon);
      this.icons.tools.drawPic({ x: f(640 - size), y: f(f(y + ICON_SIZE / 2) - f(size / 2)), width: size, height: size }, shader);
    }
    this.icons.tools.draw.setColor(null);
    return y;
  }

  private async drawPickupItem(y: number): Promise<number> {
    this.requireBase("CG_DrawPickupItem");
    const playerState = activePlayerState(this.state);
    if (playerState.stats.get(statSchema(this.state.product).health) <= 0) return y;
    y = (y - ICON_SIZE) | 0;
    const value = this.state.itemPickup | 0;
    if (value === 0) return y;
    const fade = fadeColor(this.state.time, this.state.itemPickupTime, 3000);
    if (fade === null) return y;
    const item = itemAt(this.state.product, value);
    await this.icons.tools.media.weaponRegistry.registerItemVisuals(value);
    const visual = this.icons.tools.media.weaponRegistry.items[value];
    if (visual === undefined) throw new Error("Pickup item has no cgame visual slot");
    this.icons.tools.draw.setColor(fade);
    this.icons.tools.drawPic({ x: 8, y, width: ICON_SIZE, height: ICON_SIZE }, visual.icon);
    this.icons.tools.drawBigString(ICON_SIZE + 16, y + ICON_SIZE / 2 - BIGCHAR_HEIGHT / 2, item.pickupName ?? "", fade.x);
    this.icons.tools.draw.setColor(null);
    return y;
  }
}
