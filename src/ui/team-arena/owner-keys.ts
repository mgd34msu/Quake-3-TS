/*
 * UI_*_HandleKey, UI_OwnerDrawHandleKey and UI_Next/PriorOpponent from
 * id Software's code/ui/ui_main.c. IDs from ui/menudef.h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { KeyCode } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { gameFormat } from "../../game/format.ts";
import { GameType } from "../../shared/definitions.ts";
import type { UiOwnerDrawKeyResult, UiRuntime } from "../runtime.ts";
import type { TeamArenaCatalog } from "./catalog.ts";
import type { TeamArenaUiCinematics } from "./cinematics.ts";
import type { TeamArenaUiCvars, TeamArenaUiCvarSymbol } from "./cvars.ts";
import type { TeamArenaFeeders } from "./feeders.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaUiInteractionState } from "./interaction-state.ts";
import type { TeamArenaPlayerList } from "./player-list.ts";
import type { TeamArenaScores } from "./scores.ts";
import type { TeamArenaSelection } from "./selection.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";
import type { TeamArenaSettings } from "./settings.ts";
import type { TeamArenaTeamInfo } from "./team-info.ts";

export interface TeamArenaOwnerKeyServices {
  readonly cvars: TeamArenaUiCvars;
  readonly game: TeamArenaGameInfo;
  readonly teams: TeamArenaTeamInfo;
  readonly selection: TeamArenaSelection;
  readonly feeders: TeamArenaFeeders;
  readonly settings: TeamArenaSettings;
  readonly scores: TeamArenaScores;
  readonly players: TeamArenaPlayerList;
  readonly catalog: TeamArenaCatalog;
  readonly servers: TeamArenaServerBrowser;
  readonly cinematics: TeamArenaUiCinematics;
  readonly runtime: UiRuntime;
  readonly interaction: TeamArenaUiInteractionState;
  readClient(): Parameters<TeamArenaPlayerList["build"]>[0];
  readRealTime(): number;
  assertActive(): void;
}

const UI_TO_GAME_COLOR = [4, 6, 2, 3, 1, 5, 7];
function accepted(key: number): boolean {
  return key === KeyCode.Mouse1 || key === KeyCode.Mouse2 || key === KeyCode.Enter || key === KeyCode.KeypadEnter;
}
function int32(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Team Arena owner-key arguments require source int32 values");
}

/** Source UI operations are serialized; false dispatch results do not undo reached effects. */
export class TeamArenaOwnerKeys {
  constructor(private readonly services: TeamArenaOwnerKeyServices) {}

  private time(): number {
    const time = this.services.readRealTime(); this.services.assertActive(); int32(time); return time;
  }
  private value(name: string): number {
    const value = this.services.cvars.registry.get(name)?.numericValue ?? 0;
    this.services.assertActive(); return Math.fround(value);
  }
  private text(name: string): string {
    const text = sourceCommandText(this.services.cvars.registry.get(name)?.value ?? "").slice(0, 1023);
    this.services.assertActive(); return text;
  }
  private set(name: string, value: string | null): void {
    const services = this.services;
    if (value === null) {
      const variable = services.cvars.registry.get(name); services.assertActive();
      if (variable === undefined) return;
      value = variable.resetValue;
    }
    services.cvars.registry.set(name, value, true); services.assertActive();
  }
  private setInt(name: string, value: number): void { this.set(name, gameFormat("%i", [value])); }
  private word(symbol: TeamArenaUiCvarSymbol): number { return this.services.cvars.get(symbol).integerValue; }
  private write(symbol: TeamArenaUiCvarSymbol, value: number): void {
    this.services.cvars.writeInteger(symbol, value); this.services.assertActive();
  }
  private teamIndex(name: string): number { return this.services.selection.teamIndexFromName(this.text(name)); }

  /** Also called by source StartSkirmish and menu scripts with resetMap=false. */
  async gameTypeHandleKey(key: number, resetMap: boolean): Promise<boolean> {
    const services = this.services;
    services.assertActive(); int32(key);
    if (!accepted(key)) return false;
    const oldCount = services.selection.mapCountByGameType(true);
    if (key === KeyCode.Mouse2) {
      this.write("ui_gameType", (this.word("ui_gameType") - 1) | 0);
      if (this.word("ui_gameType") === 2) this.write("ui_gameType", 1);
      else if (this.word("ui_gameType") < 2) this.write("ui_gameType", (services.game.numGameTypes - 1) | 0);
    } else {
      this.write("ui_gameType", (this.word("ui_gameType") + 1) | 0);
      if (this.word("ui_gameType") >= services.game.numGameTypes) this.write("ui_gameType", 1);
      else if (this.word("ui_gameType") === 2) this.write("ui_gameType", 3);
    }
    this.set("ui_Q3Model", infoSlot(services.game.gameTypes, this.word("ui_gameType")).gtEnum === GameType.GT_TOURNAMENT ? "1" : "0");
    this.setInt("ui_gameType", this.word("ui_gameType"));
    services.settings.setCapFragLimits(true); services.assertActive();
    services.scores.loadBestScores(infoSlot(services.game.mapList, this.word("ui_currentMap")).mapLoadName,
      infoSlot(services.game.gameTypes, this.word("ui_gameType")).gtEnum);
    services.assertActive();
    if (resetMap && oldCount !== services.selection.mapCountByGameType(true)) {
      this.set("ui_currentMap", "0");
      await services.runtime.setFeederSelection(1, 0); services.assertActive();
    }
    return true;
  }

  private async clan(key: number): Promise<void> {
    const services = this.services;
    let index = this.teamIndex("ui_teamName");
    const old = infoSlot(services.teams.teamList, index);
    if (old.cinematic >= 0) { services.cinematics.stop(old.cinematic); services.assertActive(); old.cinematic = -1; }
    index = (index + (key === KeyCode.Mouse2 ? -1 : 1)) | 0;
    if (index >= services.teams.teamCount) index = 0;
    else if (index < 0) index = (services.teams.teamCount - 1) | 0;
    this.set("ui_teamName", infoSlot(services.teams.teamList, index).teamName);
    services.selection.headCountByTeam(); services.assertActive();
    await services.feeders.select(0, 0); services.assertActive();
    services.interaction.updateModel = true;
  }

  private async netGameType(direction: number): Promise<void> {
    const services = this.services;
    this.write("ui_netGameType", (this.word("ui_netGameType") + direction) | 0);
    if (this.word("ui_netGameType") < 0) this.write("ui_netGameType", (services.game.numGameTypes - 1) | 0);
    else if (this.word("ui_netGameType") >= services.game.numGameTypes) this.write("ui_netGameType", 0);
    this.setInt("ui_netGameType", this.word("ui_netGameType"));
    this.setInt("ui_actualnetGameType", infoSlot(services.game.gameTypes, this.word("ui_netGameType")).gtEnum);
    this.set("ui_currentNetMap", "0");
    services.selection.mapCountByGameType(false); services.assertActive();
    await services.runtime.setFeederSelection(4, 0); services.assertActive();
  }

  private teamName(blue: boolean, direction: number): void {
    const services = this.services, cvar = blue ? "ui_blueTeam" : "ui_redTeam";
    let index = (this.teamIndex(cvar) + direction) | 0;
    if (index >= services.teams.teamCount) index = 0;
    else if (index < 0) index = (services.teams.teamCount - 1) | 0;
    this.set(cvar, infoSlot(services.teams.teamList, index).teamName);
  }

  private memberValue(value: number, teamGame: boolean): number {
    const services = this.services;
    if (teamGame) {
      if (value >= ((services.teams.characterCount + 2) | 0)) return 0;
      if (value < 0) return (services.teams.characterCount + 1) | 0;
    } else {
      if (value >= ((services.catalog.getNumBots() + 2) | 0)) return 0;
      if (value < 0) return (services.catalog.getNumBots() + 1) | 0;
    }
    return value;
  }

  private async netSource(direction: number): Promise<void> {
    const services = this.services;
    this.write("ui_netSource", (this.word("ui_netSource") + direction) | 0);
    if (this.word("ui_netSource") === 1) this.write("ui_netSource", (this.word("ui_netSource") + direction) | 0);
    if (this.word("ui_netSource") >= 4) this.write("ui_netSource", 0);
    else if (this.word("ui_netSource") < 0) this.write("ui_netSource", 3);
    await services.servers.buildDisplayList(1, this.time()); services.assertActive();
    if (this.word("ui_netSource") !== 2) { await services.servers.startRefresh(true, this.time()); services.assertActive(); }
    this.setInt("ui_netSource", this.word("ui_netSource"));
  }

  private opponent(direction: number): void {
    const services = this.services;
    let index = this.teamIndex("ui_opponentName");
    const player = this.teamIndex("ui_teamName");
    index = (index + direction) | 0;
    if (direction > 0 && index >= services.teams.teamCount) index = 0;
    else if (direction < 0 && index < 0) index = (services.teams.teamCount - 1) | 0;
    if (index === player) {
      index = (index + direction) | 0;
      if (direction > 0 && index >= services.teams.teamCount) index = 0;
      else if (direction < 0 && index < 0) index = (services.teams.teamCount - 1) | 0;
    }
    this.set("ui_opponentName", infoSlot(services.teams.teamList, index).teamName);
  }

  private selectedPlayer(direction: number): void {
    const services = this.services, client = services.readClient(); services.assertActive();
    services.players.build(client); services.assertActive();
    if (services.players.teamLeader === 0) return;
    let selected = (qvmFloatToInt(this.value("cg_selectedPlayer")) + direction) | 0;
    if (selected > services.players.myTeamCount) selected = 0;
    else if (selected < 0) selected = services.players.myTeamCount;
    this.set("cg_selectedPlayerName", selected === services.players.myTeamCount ? "Everyone" : infoSlot(services.players.teamNames, selected));
    this.setInt("cg_selectedPlayer", selected);
  }

  async handleKey(ownerDraw: number, flags: number, special: number, key: number): Promise<UiOwnerDrawKeyResult> {
    const services = this.services, state = services.interaction;
    services.assertActive(); int32(ownerDraw); int32(flags); int32(key);
    if (!accepted(key)) return { handled: false, special };
    const direction = key === KeyCode.Mouse2 ? -1 : 1;
    let handled = false;
    switch (ownerDraw) {
      case 200: {
        let value = this.value("handicap");
        if (value < 5) value = 5;
        if (value > 100) value = 100;
        let handicap = (qvmFloatToInt(value) + direction * 5) | 0;
        if (handicap > 100) handicap = 5;
        else if (handicap < 0) handicap = 100;
        this.setInt("handicap", handicap); handled = true; break;
      }
      case 201:
        state.effectsColor = (state.effectsColor + direction) | 0;
        if (state.effectsColor > 6) state.effectsColor = 0;
        else if (state.effectsColor < 0) state.effectsColor = 6;
        this.setInt("color1", infoSlot(UI_TO_GAME_COLOR, state.effectsColor)); handled = true; break;
      case 203: await this.clan(key); handled = true; break;
      case 205: handled = await this.gameTypeHandleKey(key, true); break;
      case 245: await this.netGameType(direction); handled = true; break;
      case 253:
        this.write("ui_joinGameType", (this.word("ui_joinGameType") + direction) | 0);
        if (this.word("ui_joinGameType") < 0) this.write("ui_joinGameType", (services.game.numJoinGameTypes - 1) | 0);
        else if (this.word("ui_joinGameType") >= services.game.numJoinGameTypes) this.write("ui_joinGameType", 0);
        this.setInt("ui_joinGameType", this.word("ui_joinGameType"));
        await services.servers.buildDisplayList(1, this.time()); services.assertActive(); handled = true; break;
      case 207: {
        let skill = (qvmFloatToInt(this.value("g_spSkill")) + direction) | 0;
        if (skill < 1) skill = 5; else if (skill > 5) skill = 1;
        this.setInt("g_spSkill", skill); handled = true; break;
      }
      case 208: case 209: this.teamName(ownerDraw === 208, direction); handled = true; break;
      case 210: case 211: case 212: case 213: case 214: case 215: case 216: case 217: case 218: case 219: {
        const cvar = gameFormat(ownerDraw < 215 ? "ui_blueteam%i" : "ui_redteam%i", [ownerDraw - (ownerDraw < 215 ? 210 : 215) + 1]);
        const value = (qvmFloatToInt(this.value(cvar)) + direction) | 0;
        this.setInt(cvar, this.memberValue(value, this.word("ui_actualNetGameType") >= GameType.GT_TEAM)); break;
      }
      case 220: await this.netSource(direction); break;
      case 222:
        services.servers.serverFilterType = (services.servers.serverFilterType + direction) | 0;
        if (services.servers.serverFilterType >= 7) services.servers.serverFilterType = 0;
        else if (services.servers.serverFilterType < 0) services.servers.serverFilterType = 6;
        await services.servers.buildDisplayList(1, this.time()); services.assertActive(); break;
      case 237: this.opponent(direction); break;
      case 239: {
        const game = qvmFloatToInt(this.value("g_gametype")), value = (state.botIndex + direction) | 0;
        state.botIndex = this.memberValue(value, game >= GameType.GT_TEAM); handled = true; break;
      }
      case 240:
        state.skillIndex = (state.skillIndex + direction) | 0;
        if (state.skillIndex >= 5) state.skillIndex = 0; else if (state.skillIndex < 0) state.skillIndex = 4;
        handled = true; break;
      case 241: state.redBlue ^= 1; break;
      case 242:
        state.currentCrosshair = (state.currentCrosshair + direction) | 0;
        if (state.currentCrosshair >= 10) state.currentCrosshair = 0; else if (state.currentCrosshair < 0) state.currentCrosshair = 9;
        this.setInt("cg_drawCrosshair", state.currentCrosshair); break;
      case 243: this.selectedPlayer(direction); break;
    }
    services.assertActive();
    return { handled, special };
  }
}
