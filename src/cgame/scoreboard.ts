// Classic scoreboard from id Software's code/cgame/cg_scoreboard.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarSnapshot } from "../core/cvar.ts";
import { vec3, vec4 } from "../core/math.ts";
import type { Vec4 } from "../core/math.ts";
import { gameFormat } from "../game/format.ts";
import { GameType, MoveType, PersistentIndex, Powerup, Team, statSchema } from "../shared/definitions.ts";
import type { ClientDrawIcons } from "./draw-icons.ts";
import { drawStrlen, fadeColor } from "./draw-tools.ts";
import { placeString } from "./events.ts";
import type { ClientInfoStore, PlayerPresenter } from "./players.ts";
import type { ClientGameState, ClientGameStaticState, ClientScore } from "./state.ts";

export interface BaseScoreboardHost {
  readonly icons: ClientDrawIcons;
  readonly clients: ClientInfoStore;
  readonly players: PlayerPresenter;
  readVmCvar(name: "cg_paused" | "cg_drawIcons"): CvarSnapshot;
  configString(index: number): string;
  sendClientCommand(text: string): void;
  print(text: string): void;
}

const HEADER = 86, TOP = 118, NORMAL_HEIGHT = 40, INTER_HEIGHT = 16;
const MAX_NORMAL = 7, MAX_INTER = 17, WHITE = vec4(1, 1, 1, 1);
const f = Math.fround;

/** cg_draw.c selects this layout only in baseq3; Team Arena uses its menu scoreboard. */
export class BaseScoreboard {
  private localClient = false;
  constructor(readonly state: ClientGameState, readonly staticState: ClientGameStaticState, readonly host: BaseScoreboardHost) {
    if (state.product !== staticState.product) throw new Error("Scoreboard state products differ");
    if (host.icons.state !== state || host.icons.tools.media.staticState !== staticState || host.clients.host.state !== state || host.players.host.state !== state) {
      throw new Error("Scoreboard services must share canonical cgame state");
    }
    for (let index = 0; index < 64; index++) {
      if (host.clients.clientInfo(index) !== staticState.clientInfo[index]) throw new Error("Scoreboard client store must use canonical client slots");
    }
  }

  private get tools() { return this.host.icons.tools; }
  private snapshot() {
    const snap = this.state.snap;
    if (snap === null) throw new Error("CG_DrawOldScoreboard requires a current snapshot");
    return snap.playerState;
  }
  private score(index: number): ClientScore {
    const score = this.state.scores[index];
    if (score === undefined) throw new RangeError(`Scoreboard score index outside source array: ${index}`);
    return score;
  }
  private client(index: number) {
    const client = this.staticState.clientInfo[index];
    if (client === undefined) throw new RangeError(`Scoreboard client index outside source array: ${index}`);
    return client;
  }

  private drawClientScore(y: number, score: ClientScore, color: Vec4, fade: number, large: boolean): void {
    if (score.client < 0 || score.client >= this.staticState.maxclients) {
      this.host.print(gameFormat("Bad score->client: %i\n", [score.client])); return;
    }
    const ci = this.client(score.client), icons = this.host.icons, tools = this.tools, iconX = 80, headX = 112;
    const iconRect = { x: iconX, y: large ? y - 8 : y, width: large ? 32 : 16, height: large ? 32 : 16 };
    if (ci.powerups & (1 << Powerup.PW_NEUTRALFLAG)) icons.drawFlagModel(iconRect, Team.TEAM_FREE, false);
    else if (ci.powerups & (1 << Powerup.PW_REDFLAG)) icons.drawFlagModel(iconRect, Team.TEAM_RED, false);
    else if (ci.powerups & (1 << Powerup.PW_BLUEFLAG)) icons.drawFlagModel(iconRect, Team.TEAM_BLUE, false);
    else {
      if (ci.botSkill > 0 && ci.botSkill <= 5) {
        if (this.host.readVmCvar("cg_drawIcons").integerValue !== 0) {
          const shader = tools.media.graphics.botSkillShaders[ci.botSkill - 1];
          if (shader === undefined) throw new RangeError("Scoreboard bot skill outside source shader array");
          tools.drawPic(iconRect, shader);
        }
      } else if (ci.handicap < 100) {
        tools.drawSmallStringColor(iconX, this.staticState.gameType === GameType.GT_TOURNAMENT ? y - 8 : y, gameFormat("%i", [ci.handicap], 1024), color);
      }
      if (this.staticState.gameType === GameType.GT_TOURNAMENT) {
        tools.drawSmallStringColor(iconX, ci.handicap < 100 && !ci.botSkill ? y + 8 : y, gameFormat("%i/%i", [ci.wins, ci.losses], 1024), color);
      }
    }
    icons.drawHead({ x: headX, y: large ? y - 16 : y, width: large ? 48 : 16, height: large ? 48 : 16 }, score.client, vec3(0, 180, 0));
    if (this.state.product === "missionpack") {
      if (ci.teamTask === 1) tools.drawPic({ x: headX + 48, y, width: 16, height: 16 }, tools.media.graphics.assaultShader);
      else if (ci.teamTask === 2) tools.drawPic({ x: headX + 48, y, width: 16, height: 16 }, tools.media.graphics.defendShader);
    }
    const text = score.ping === -1 ? gameFormat(" connecting    %s", [ci.name], 1024)
      : ci.team === Team.TEAM_SPECTATOR ? gameFormat(" SPECT %3i %4i %s", [score.ping, score.time, ci.name], 1024)
        : gameFormat("%5i %4i %4i %s", [score.score, score.ping, score.time, ci.name], 1024);
    const ps = this.snapshot();
    if (score.client === ps.clientNum) {
      this.localClient = true;
      const rank = ps.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR || this.staticState.gameType >= GameType.GT_TEAM
        ? -1 : ps.persistant.get(PersistentIndex.PERS_RANK) & ~0x4000;
      const rgb = rank === 0 ? vec3(0, 0, f(0.7)) : rank === 1 ? vec3(f(0.7), 0, 0)
        : rank === 2 ? vec3(f(0.7), f(0.7), 0) : vec3(f(0.7), f(0.7), f(0.7));
      tools.fillRect({ x: 176, y, width: 512, height: 17 }, vec4(rgb.x, rgb.y, rgb.z, f(fade * 0.7)));
    }
    tools.drawBigString(160, y, text, fade);
    if (ps.stats.get(statSchema(ps.product).clientsReady) & (1 << score.client)) tools.drawBigStringColor(iconX, y, "READY", color);
  }

  private teamScoreboard(y: number, team: Team, fade: number, maxClients: number, lineHeight: number): number {
    let count = 0;
    const color = vec4(1, 1, 1, fade);
    for (let index = 0; index < this.state.numScores && count < maxClients; index++) {
      const score = this.score(index);
      if (this.client(score.client).team !== team) continue;
      this.drawClientScore(y + lineHeight * count, score, color, fade, lineHeight === NORMAL_HEIGHT); count++;
    }
    return count;
  }

  async draw(): Promise<boolean> {
    const state = this.state, cgs = this.staticState;
    if (this.host.readVmCvar("cg_paused").integerValue !== 0) { state.deferredPlayerLoading = 0; return false; }
    if (cgs.gameType === GameType.GT_SINGLE_PLAYER && state.predictedPlayerState.pmType === MoveType.PM_INTERMISSION) {
      state.deferredPlayerLoading = 0; return false;
    }
    if (state.warmup !== 0 && !state.showScores) return false;
    const color = state.showScores || state.predictedPlayerState.pmType === MoveType.PM_DEAD || state.predictedPlayerState.pmType === MoveType.PM_INTERMISSION
      ? WHITE : fadeColor(state.time, state.scoreFadeTime, 200);
    if (color === null) { state.deferredPlayerLoading = 0; state.killerName = ""; return false; }
    // Source dereferences RGB[0], not alpha: the old scoreboard disappears at expiry without fading its rows.
    const fade = color.x, tools = this.tools, ps = this.snapshot();
    if (state.killerName.length !== 0) {
      const text = gameFormat("Fragged by %s", [state.killerName]); tools.drawBigString(Math.trunc((640 - drawStrlen(text) * 16) / 2), 40, text, fade);
    }
    let rankText: string | null = null;
    if (cgs.gameType < GameType.GT_TEAM) {
      if (ps.persistant.get(PersistentIndex.PERS_TEAM) !== Team.TEAM_SPECTATOR) {
        rankText = gameFormat("%s place with %i", [placeString((ps.persistant.get(PersistentIndex.PERS_RANK) + 1) | 0), ps.persistant.get(PersistentIndex.PERS_SCORE)]);
      }
    } else {
      const red = state.teamScores[0], blue = state.teamScores[1];
      rankText = red === blue ? gameFormat("Teams are tied at %i", [red]) : red >= blue ? gameFormat("Red leads %i to %i", [red, blue]) : gameFormat("Blue leads %i to %i", [blue, red]);
    }
    if (rankText !== null) tools.drawBigString(Math.trunc((640 - drawStrlen(rankText) * 16) / 2), 60, rankText, fade);
    const media = tools.media.graphics;
    tools.drawPic({ x: 176, y: HEADER, width: 64, height: 32 }, media.scoreboardScore);
    tools.drawPic({ x: 264, y: HEADER, width: 64, height: 32 }, media.scoreboardPing);
    tools.drawPic({ x: 344, y: HEADER, width: 64, height: 32 }, media.scoreboardTime);
    tools.drawPic({ x: 416, y: HEADER, width: 64, height: 32 }, media.scoreboardName);
    const compact = state.numScores > MAX_NORMAL, lineHeight = compact ? INTER_HEIGHT : NORMAL_HEIGHT, topBorder = compact ? 8 : 16;
    let maxClients = compact ? MAX_INTER : MAX_NORMAL, y = TOP;
    this.localClient = false;
    if (cgs.gameType >= GameType.GT_TEAM) {
      y += lineHeight / 2;
      const firstTeam = state.teamScores[0] >= state.teamScores[1] ? Team.TEAM_RED : Team.TEAM_BLUE;
      const first = this.teamScoreboard(y, firstTeam, fade, maxClients, lineHeight);
      this.host.icons.drawTeamBackground({ x: 0, y: y - topBorder, width: 640, height: first * lineHeight + 16 }, f(0.33), firstTeam);
      y += first * lineHeight + 16; maxClients -= first;
      const secondTeam = firstTeam === Team.TEAM_RED ? Team.TEAM_BLUE : Team.TEAM_RED;
      const second = this.teamScoreboard(y, secondTeam, fade, maxClients, lineHeight);
      this.host.icons.drawTeamBackground({ x: 0, y: y - topBorder, width: 640, height: second * lineHeight + 16 }, f(0.33), secondTeam);
      y += second * lineHeight + 16; maxClients -= second;
      y += this.teamScoreboard(y, Team.TEAM_SPECTATOR, fade, maxClients, lineHeight) * lineHeight + 16;
    } else {
      const count = this.teamScoreboard(y, Team.TEAM_FREE, fade, maxClients, lineHeight);
      y += count * lineHeight + 16;
      y += this.teamScoreboard(y, Team.TEAM_SPECTATOR, fade, maxClients - count, lineHeight) * lineHeight + 16;
    }
    if (!this.localClient) {
      for (let index = 0; index < state.numScores; index++) {
        const score = this.score(index);
        if (score.client === ps.clientNum) { this.drawClientScore(y, score, color, fade, lineHeight === NORMAL_HEIGHT); break; }
      }
    }
    state.deferredPlayerLoading = (state.deferredPlayerLoading + 1) | 0;
    if (state.deferredPlayerLoading > 10) await this.host.clients.loadDeferredPlayers(entity => this.host.players.resetPlayerEntity(entity));
    return true;
  }

  private centerGiantLine(y: number, text: string): void {
    this.tools.drawStringExt({ x: Math.trunc(0.5 * (640 - 32 * drawStrlen(text))), y, text, color: WHITE,
      forceColor: true, shadow: true, charWidth: 32, charHeight: 48, maxChars: 0 });
  }

  drawTourney(): void {
    const state = this.state, cgs = this.staticState, tools = this.tools;
    if (((state.scoresRequestTime + 2000) | 0) < state.time) { state.scoresRequestTime = state.time; this.host.sendClientCommand("score"); }
    const black = vec4(0, 0, 0, 1);
    tools.fillRect({ x: 0, y: 0, width: 640, height: 480 }, black);
    const motd = this.host.configString(4); this.centerGiantLine(8, motd.length === 0 ? "Scoreboard" : motd);
    let seconds = Math.trunc(state.time / 1000);
    const minutes = Math.trunc(seconds / 60); seconds %= 60;
    this.centerGiantLine(64, gameFormat("%i:%i%i", [minutes, Math.trunc(seconds / 10), seconds % 10]));
    const line = (y: number, name: string, score: number): void => {
      tools.drawStringExt({ x: 8, y, text: name, color: black, forceColor: true, shadow: true, charWidth: 32, charHeight: 48, maxChars: 0 });
      const text = gameFormat("%i", [score]);
      tools.drawStringExt({ x: 632 - 32 * text.length, y, text, color: black, forceColor: true, shadow: true, charWidth: 32, charHeight: 48, maxChars: 0 });
    };
    if (cgs.gameType >= GameType.GT_TEAM) { line(160, "Red Team", state.teamScores[0]); line(224, "Blue Team", state.teamScores[1]); }
    else {
      let y = 160;
      for (let index = 0; index < 64; index++) {
        const ci = this.client(index);
        if (!ci.infoValid || ci.team !== Team.TEAM_FREE) continue;
        line(y, ci.name, ci.score); y += 64;
      }
    }
  }
}
