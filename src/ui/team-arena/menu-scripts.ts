/*
 * UI_RunMenuScript, UI_StartSkirmish, UI_SetNextMap and UI_AIFromName
 * from id Software's code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommandBuffer } from "../../core/commands.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { KeyCatcher, KeyCode } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { validateCdKey } from "../../engine/cd-key.ts";
import type { CommonCdKeyState } from "../../engine/cd-key.ts";
import type { ClientKeys } from "../../engine/client-keys.ts";
import { ServerBrowserSource } from "../../engine/server-browser.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import { gameFormat } from "../../game/format.ts";
import type { GameFormatArgument } from "../../game/format.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { GameType } from "../../shared/definitions.ts";
import type { UiExternalScriptContext, UiExternalScriptHost, UiRuntime, UiScriptCursor } from "../runtime.ts";
import type { TeamArenaCatalog } from "./catalog.ts";
import type { TeamArenaUiCinematics } from "./cinematics.ts";
import type { TeamArenaUiCvars, TeamArenaUiCvarSymbol } from "./cvars.ts";
import type { TeamArenaFeeders } from "./feeders.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaUiInteractionState } from "./interaction-state.ts";
import type { TeamArenaLists } from "./lists.ts";
import type { TeamArenaOwnerKeys } from "./owner-keys.ts";
import type { TeamArenaPlayerList } from "./player-list.ts";
import type { TeamArenaScores } from "./scores.ts";
import type { TeamArenaSelection } from "./selection.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";
import type { TeamArenaServerStatus } from "./server-status.ts";
import type { TeamArenaSettings } from "./settings.ts";
import type { TeamArenaTeamInfo } from "./team-info.ts";

export interface TeamArenaMenuScriptServices {
  readonly cvars: TeamArenaUiCvars;
  readonly commands: CommandBuffer;
  readonly keys: ClientKeys;
  readonly cdKey: CommonCdKeyState;
  usesUniqueKey(): number;
  readonly game: TeamArenaGameInfo;
  readonly teams: TeamArenaTeamInfo;
  readonly catalog: TeamArenaCatalog;
  readonly selection: TeamArenaSelection;
  readonly lists: TeamArenaLists;
  readonly scores: TeamArenaScores;
  readonly players: TeamArenaPlayerList;
  readonly feeders: TeamArenaFeeders;
  readonly browser: ServerBrowser;
  readonly servers: TeamArenaServerBrowser;
  readonly status: TeamArenaServerStatus;
  readonly cinematics: TeamArenaUiCinematics;
  readonly settings: TeamArenaSettings;
  readonly ownerKeys: TeamArenaOwnerKeys;
  readonly runtime: UiRuntime;
  readonly interaction: TeamArenaUiInteractionState;
  readRealTime(): number;
  print(text: string): void;
  assertActive(): void;
}

function folded(text: string): string {
  return sourceCommandText(text).replace(/[A-Z]/g, letter => letter.toLowerCase());
}
function same(first: string | null, second: string | null): boolean {
  return first !== null && second !== null && folded(first) === folded(second);
}
function integer(cursor: UiScriptCursor): number | undefined {
  const token = cursor.next();
  return token === undefined || token.text.length === 0 ? undefined : gameAtoi(sourceCommandText(token.text));
}

/** Borrows one UI lifetime's owners. Script calls, like UI VM calls, are serialized. */
export class TeamArenaMenuScripts implements UiExternalScriptHost {
  constructor(private readonly services: TeamArenaMenuScriptServices) {}

  private word(symbol: TeamArenaUiCvarSymbol): number { return this.services.cvars.get(symbol).integerValue; }
  private value(name: string): number {
    const value = Math.fround(this.services.cvars.registry.get(name)?.numericValue ?? 0);
    this.services.assertActive(); return value;
  }
  private text(name: string): string {
    const value = sourceCommandText(this.services.cvars.registry.get(name)?.value ?? "").slice(0, 1023);
    this.services.assertActive(); return value;
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
  private append(text: string | null): void {
    // Cbuf_AddText ignores a NULL pointer, including successful NULL String_Parse.
    if (text !== null) this.services.commands.append(text);
    this.services.assertActive();
  }
  private format(format: string, args: readonly GameFormatArgument[], size = 32000): string {
    const text = gameFormat(format, args);
    if (text.length >= size) {
      this.services.print(`Com_sprintf: overflow of ${text.length} in ${size}\n`); this.services.assertActive();
    }
    return text.slice(0, size - 1);
  }
  private time(): number {
    const time = this.services.readRealTime(); this.services.assertActive();
    if (!Number.isInteger(time) || time < -2147483648 || time > 2147483647) throw new RangeError("Team Arena menu scripts require int32 UI realTime");
    return time;
  }
  private map() { return infoSlot(this.services.game.mapList, this.word("ui_currentMap")); }
  private displayIndex(): number {
    const services = this.services, index = services.servers.currentServer;
    const value = services.servers.displayServers[index];
    if (value === undefined) throw new RangeError(`Team Arena script reads outside displayServers[2048] at ${index}`);
    return value;
  }
  private serverAddress(size: number): string {
    const address = this.services.browser.getServerAddressString(this.word("ui_netSource"), this.displayIndex(), size);
    this.services.assertActive(); return address;
  }
  private serverInfo(): string {
    const info = this.services.browser.getServerInfo(this.word("ui_netSource"), this.displayIndex(), 1024);
    this.services.assertActive(); return info;
  }
  private aiFromName(name: string | null): string | null {
    for (let index = 0; index < this.services.teams.aliasCount; index++) {
      const alias = infoSlot(this.services.teams.aliasList, index);
      if (same(alias.name, name)) return alias.ai;
    }
    return "James";
  }
  private async setNextMap(actual: number, index: number): Promise<boolean> {
    const services = this.services;
    for (let i = (actual + 1) | 0; i < services.game.mapCount; i++) {
      if (infoSlot(services.game.mapList, i).active) {
        await services.runtime.setFeederSelection(1, (index + 1) | 0, "skirmish"); services.assertActive();
        return true;
      }
    }
    return false;
  }

  async startSkirmish(next: boolean): Promise<void> {
    const services = this.services; services.assertActive();
    if (next) {
      const index = qvmFloatToInt(this.value("ui_mapIndex"));
      services.selection.mapCountByGameType(true);
      const selected = services.selection.selectedMap(index);
      if (!await this.setNextMap(selected.actual, index)) {
        services.assertActive();
        await services.ownerKeys.gameTypeHandleKey(KeyCode.Mouse1, false); services.assertActive();
        services.selection.mapCountByGameType(true);
        await services.runtime.setFeederSelection(1, 0, "skirmish"); services.assertActive();
      }
    }
    const game = infoSlot(services.game.gameTypes, this.word("ui_gameType")).gtEnum;
    this.setInt("g_gametype", game);
    this.append(this.format("wait ; wait ; map %s\n", [this.map().mapLoadName]));
    const skill = this.value("g_spSkill");
    this.set("ui_scoreMap", this.map().mapName);
    let team = services.selection.teamIndexFromName(this.text("ui_opponentName"));
    this.set("ui_singlePlayerActive", "1");
    this.setInt("ui_saveCaptureLimit", qvmFloatToInt(this.value("capturelimit")));
    this.setInt("ui_saveFragLimit", qvmFloatToInt(this.value("fraglimit")));
    services.settings.setCapFragLimits(false); services.assertActive();
    for (const [from, to] of [
      ["cg_drawTimer", "ui_drawTimer"], ["g_doWarmup", "ui_doWarmup"], ["g_friendlyFire", "ui_friendlyFire"],
      ["sv_maxClients", "ui_maxClients"], ["g_warmup", "ui_Warmup"], ["sv_pure", "ui_pure"],
    ] satisfies readonly (readonly [string, string])[]) this.setInt(to, qvmFloatToInt(this.value(from)));
    this.set("cg_cameraOrbit", "0"); this.set("cg_thirdPerson", "0"); this.set("cg_drawTimer", "1");
    this.set("g_doWarmup", "1"); this.set("g_warmup", "15"); this.set("sv_pure", "0"); this.set("g_friendlyFire", "0");
    this.set("g_redTeam", this.text("ui_teamName")); this.set("g_blueTeam", this.text("ui_opponentName"));
    if (this.value("ui_recordSPDemo") !== 0) this.set("ui_recordSPDemoName", this.format("%s_%i", [this.map().mapLoadName, game], 1024));
    let delay = 500;
    if (game === GameType.GT_TOURNAMENT) {
      this.set("sv_maxClients", "2");
      // Adjacent C literals join before the comma: this is not an empty quoted team argument.
      this.append(this.format("wait ; addbot %s %f , %i \n", [this.map().opponentName, skill, delay], 1024));
    } else {
      this.setInt("sv_maxClients", Math.imul(this.map().teamMembers, 2));
      for (let i = 0; i < this.map().teamMembers; i++) {
        const name = infoSlot(infoSlot(services.teams.teamList, team).teamMembers, i);
        this.append(this.format("addbot %s %f %s %i %s\n", [this.aiFromName(name), skill,
          game === GameType.GT_FFA ? "" : "Blue", delay, name], 1024));
        delay = (delay + 500) | 0;
      }
      team = services.selection.teamIndexFromName(this.text("ui_teamName"));
      for (let i = 0; i < ((this.map().teamMembers - 1) | 0); i++) {
        const name = infoSlot(infoSlot(services.teams.teamList, team).teamMembers, i);
        this.append(this.format("addbot %s %f %s %i %s\n", [this.aiFromName(name), skill,
          game === GameType.GT_FFA ? "" : "Red", delay, name], 1024));
        delay = (delay + 500) | 0;
      }
    }
    if (game >= GameType.GT_TEAM) this.append("wait 5; team Red\n");
  }

  private startServer(): void {
    const services = this.services;
    this.set("cg_thirdPerson", "0"); this.set("cg_cameraOrbit", "0"); this.set("ui_singlePlayerActive", "0");
    this.setInt("dedicated", Math.max(0, Math.min(2, this.word("ui_dedicated"))));
    this.setInt("g_gametype", Math.max(0, Math.min(8, infoSlot(services.game.gameTypes, this.word("ui_netGameType")).gtEnum)));
    this.set("g_redTeam", this.text("ui_teamName")); this.set("g_blueTeam", this.text("ui_opponentName"));
    this.append(this.format("wait ; wait ; map %s\n", [infoSlot(services.game.mapList, this.word("ui_currentNetMap")).mapLoadName]));
    const skill = this.value("g_spSkill"), oldClients = qvmFloatToInt(this.value("sv_maxClients"));
    let clients = 0;
    for (let i = 0; i < 5; i++) {
      if (qvmFloatToInt(this.value(`ui_blueteam${i + 1}`)) >= 0) clients++;
      if (qvmFloatToInt(this.value(`ui_redteam${i + 1}`)) >= 0) clients++;
    }
    if (clients === 0) clients = 8;
    if (oldClients > clients) clients = oldClients;
    this.setInt("sv_maxClients", clients);
    for (let i = 0; i < 5; i++) {
      for (const team of ["Blue", "Red"]) {
        const bot = qvmFloatToInt(this.value(`ui_${team.toLowerCase()}team${i + 1}`));
        if (bot <= 1) continue;
        if (this.word("ui_actualNetGameType") >= GameType.GT_TEAM) {
          this.append(this.format("addbot %s %f %s\n", [infoSlot(services.teams.characterList, bot - 2).name, skill, team], 1024));
        } else {
          const name = services.catalog.getBotNameByNumber(bot - 2); services.assertActive();
          this.append(this.format("addbot %s %f \n", [name, skill], 1024));
        }
      }
    }
  }
  private getCdKey(): void {
    const bytes = new Uint8Array(17);
    this.services.cdKey.readUiForCompiledModule(() => this.services.usesUniqueKey(), () => bytes); this.services.assertActive();
    const key = sourceCommandText(String.fromCharCode(...bytes));
    for (let i = 1; i <= 4; i++) this.set(`cdkey${i}`, "");
    if (key.length === 16) for (let i = 0; i < 4; i++) this.set(`cdkey${i + 1}`, key.slice(i * 4, i * 4 + 4));
  }
  private verifyCdKey(): void {
    let key = "";
    for (let i = 1; i <= 4; i++) key = (key + this.text(`cdkey${i}`)).slice(0, 1023);
    this.set("cdkey", key);
    if (validateCdKey(key, this.text("cdkeychecksum"))) {
      this.set("ui_cdkeyvalid", "CD Key Appears to be valid.");
      this.services.cdKey.writeUiForCompiledModule(() => this.services.usesUniqueKey(), () => Uint8Array.from(key, letter => letter.charCodeAt(0)));
      this.services.assertActive();
    } else this.set("ui_cdkeyvalid", "CD Key does not appear to be valid.");
  }
  private stopRefresh(): void {
    const services = this.services;
    services.servers.stopRefresh(); services.assertActive();
    services.servers.nextDisplayRefresh = 0;
    services.status.nextServerStatusRefresh = 0;
    services.status.nextFindPlayerRefresh = 0;
  }
  private async closeInGame(): Promise<void> {
    const services = this.services;
    services.keys.setCatcher(services.keys.getCatcher() & ~KeyCatcher.Ui); services.assertActive();
    await services.keys.clearStates(); services.assertActive();
    this.set("cl_paused", "0");
    await services.runtime.closeAll(); services.assertActive();
  }
  private async addFavorite(name: string, address: string): Promise<void> {
    if (name.length === 0 || address.length === 0) return;
    const result = await this.services.browser.addServer(ServerBrowserSource.Favorites, name, address);
    this.services.assertActive();
    this.services.print(result === 0 ? "Favorite already in list\n" : result === -1 ? "Favorite list full\n" : `Added favorite server ${address}\n`);
    this.services.assertActive();
  }
  private orderFormat(order: string | null, argument: GameFormatArgument): string {
    if (order === null) throw new RangeError("Team Arena orders reaches strcpy with a NULL String_Parse result");
    if (sourceCommandText(order).length >= 1024) throw new RangeError("Team Arena orders overflows its 1024-byte source strcpy buffer");
    // gameFormat rejects incompatible pointer/integer arguments instead of inventing a native pointer value.
    return this.format(order, [argument]);
  }

  async run(cursor: UiScriptCursor, _context: UiExternalScriptContext): Promise<void> {
    const services = this.services; services.assertActive();
    const name = cursor.string(); services.assertActive();
    if (name === undefined) return;
    const command = name === null ? null : folded(name);
    switch (command) {
      case "startserver": this.startServer(); return;
      case "updatespmenu":
        services.settings.setCapFragLimits(true); services.assertActive();
        services.selection.mapCountByGameType(true);
        services.cvars.writeInteger("ui_mapIndex", services.selection.indexFromSelection(this.word("ui_currentMap")));
        this.setInt("ui_mapIndex", this.word("ui_mapIndex"));
        await services.runtime.setFeederSelection(1, this.word("ui_mapIndex"), "skirmish"); services.assertActive();
        await services.ownerKeys.gameTypeHandleKey(KeyCode.Mouse1, false); services.assertActive();
        await services.ownerKeys.gameTypeHandleKey(KeyCode.Mouse2, false); services.assertActive(); return;
      case "resetdefaults":
        this.append("exec default.cfg\n"); this.append("cvar_restart\n");
        services.runtime.resetBindings(); services.assertActive();
        this.set("com_introPlayed", "1"); this.append("vid_restart\n"); return;
      case "getcdkey": this.getCdKey(); return;
      case "verifycdkey": this.verifyCdKey(); return;
      case "loadarenas":
        services.catalog.loadArenas(); services.assertActive();
        services.selection.mapCountByGameType(false);
        await services.runtime.setFeederSelection(4, 0, "createserver"); services.assertActive(); return;
      case "savecontrols": services.runtime.applyBindings(); services.assertActive(); return;
      case "loadcontrols": services.runtime.reloadBindings(); services.assertActive(); return;
      case "clearerror": this.set("com_errorMessage", ""); return;
      case "loadgameinfo":
        await services.game.parseGameInfo("gameinfo.txt"); services.assertActive();
        services.scores.loadBestScores(this.map().mapLoadName, infoSlot(services.game.gameTypes, this.word("ui_gameType")).gtEnum);
        services.assertActive(); return;
      case "resetscores": services.scores.clearScores(); services.assertActive(); return;
      case "refreshservers": case "refreshfilter":
        await services.servers.startRefresh(command === "refreshservers", this.time()); services.assertActive();
        await services.servers.buildDisplayList(1, this.time()); services.assertActive(); return;
      case "runspdemo":
        if (services.scores.demoAvailable) this.append(this.format("demo %s_%i\n", [this.map().mapLoadName, infoSlot(services.game.gameTypes, this.word("ui_gameType")).gtEnum]));
        return;
      case "loaddemos": services.lists.loadDemos(); services.assertActive(); return;
      case "loadmovies": services.lists.loadMovies(); services.assertActive(); return;
      case "loadmods": services.lists.loadMods(); services.assertActive(); return;
      case "playmovie":
        if (services.interaction.previewMovie >= 0) { services.cinematics.stop(services.interaction.previewMovie); services.assertActive(); }
        this.append(this.format("cinematic %s.roq 2\n", [infoSlot(services.lists.movieList, services.interaction.movieIndex)])); return;
      case "runmod":
        this.set("fs_game", infoSlot(services.lists.modList, services.interaction.modIndex).modName); this.append("vid_restart;"); return;
      case "rundemo": this.append(this.format("demo %s\n", [infoSlot(services.lists.demoList, services.interaction.demoIndex)])); return;
      case "quake3": this.set("fs_game", ""); this.append("vid_restart;"); return;
      case "closejoin":
        if (services.servers.refreshActive) {
          this.stopRefresh(); await services.servers.buildDisplayList(1, this.time()); services.assertActive();
        } else {
          await services.runtime.close("joinserver"); services.assertActive();
          await services.runtime.activate("main"); services.assertActive();
        }
        return;
      case "stoprefresh": this.stopRefresh(); return;
      case "updatefilter":
        if (this.word("ui_netSource") === ServerBrowserSource.Local) { await services.servers.startRefresh(true, this.time()); services.assertActive(); }
        await services.servers.buildDisplayList(1, this.time()); services.assertActive();
        await services.feeders.select(2, 0); services.assertActive(); return;
      case "serverstatus":
        services.status.serverStatusAddress = this.serverAddress(64);
        await services.status.buildServerStatus(true, this.time()); services.assertActive(); return;
      case "foundplayerserverstatus":
        services.status.serverStatusAddress = infoSlot(services.status.foundPlayerServerAddresses, services.status.currentFoundPlayerServer);
        await services.status.buildServerStatus(true, this.time()); services.assertActive();
        await services.runtime.setFeederSelection(14, 0); services.assertActive(); return;
      case "findplayer":
        await services.status.buildFindPlayerList(true, this.time()); services.assertActive();
        services.status.serverStatusInfo.numLines = 0;
        await services.runtime.setFeederSelection(14, 0); services.assertActive(); return;
      case "joinserver":
        this.set("cg_thirdPerson", "0"); this.set("cg_cameraOrbit", "0"); this.set("ui_singlePlayerActive", "0");
        if (services.servers.currentServer >= 0 && services.servers.currentServer < services.servers.numDisplayServers) {
          this.append(this.format("connect %s\n", [this.serverAddress(1024)]));
        }
        return;
      case "foundplayerjoinserver":
        this.set("ui_singlePlayerActive", "0");
        if (services.status.currentFoundPlayerServer >= 0 && services.status.currentFoundPlayerServer < services.status.numFoundPlayerServers) {
          this.append(this.format("connect %s\n", [infoSlot(services.status.foundPlayerServerAddresses, services.status.currentFoundPlayerServer)]));
        }
        return;
      case "quit": this.set("ui_singlePlayerActive", "0"); await services.commands.executeNowAsync("quit"); services.assertActive(); return;
      case "controls":
        this.set("cl_paused", "1"); services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
        await services.runtime.closeAll(); services.assertActive();
        await services.runtime.activate("setup_menu2"); services.assertActive(); return;
      case "leave":
        this.append("disconnect\n"); services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
        await services.runtime.closeAll(); services.assertActive();
        await services.runtime.activate("main"); services.assertActive(); return;
      case "serversort": {
        const column = integer(cursor); services.assertActive();
        if (column !== undefined) {
          if (column === services.servers.sortKey) services.servers.sortDir = services.servers.sortDir === 0 ? 1 : 0;
          services.servers.sort(column, true); services.assertActive();
        }
        return;
      }
      case "nextskirmish": await this.startSkirmish(true); return;
      case "skirmishstart": await this.startSkirmish(false); return;
      case "closeingame": await this.closeInGame(); return;
      case "votemap":
        if (this.word("ui_currentNetMap") >= 0 && this.word("ui_currentNetMap") < services.game.mapCount) {
          this.append(this.format("callvote map %s\n", [infoSlot(services.game.mapList, this.word("ui_currentNetMap")).mapLoadName]));
        }
        return;
      case "votekick":
        if (services.interaction.playerIndex >= 0 && services.interaction.playerIndex < services.players.playerCount) {
          this.append(this.format("callvote kick %s\n", [infoSlot(services.players.playerNames, services.interaction.playerIndex)]));
        }
        return;
      case "votegame":
        if (this.word("ui_netGameType") >= 0 && this.word("ui_netGameType") < services.game.numGameTypes) {
          this.append(this.format("callvote g_gametype %i\n", [infoSlot(services.game.gameTypes, this.word("ui_netGameType")).gtEnum]));
        }
        return;
      case "voteleader":
        if (services.interaction.teamIndex >= 0 && services.interaction.teamIndex < services.players.myTeamCount) {
          this.append(this.format("callteamvote leader %s\n", [infoSlot(services.players.teamNames, services.interaction.teamIndex)]));
        }
        return;
      case "addbot": {
        const bot = this.value("g_gametype") >= GameType.GT_TEAM
          ? infoSlot(services.teams.characterList, services.interaction.botIndex).name
          : services.catalog.getBotNameByNumber(services.interaction.botIndex);
        services.assertActive();
        this.append(this.format("addbot %s %i %s\n", [bot, (services.interaction.skillIndex + 1) | 0, services.interaction.redBlue === 0 ? "Red" : "Blue"])); return;
      }
      case "addfavorite":
        if (this.word("ui_netSource") !== ServerBrowserSource.Favorites) {
          const info = this.serverInfo();
          await this.addFavorite(infoValueForKey(info, "hostname").slice(0, 31), infoValueForKey(info, "addr").slice(0, 31));
        }
        return;
      case "deletefavorite":
        if (this.word("ui_netSource") === ServerBrowserSource.Favorites) {
          const address = infoValueForKey(this.serverInfo(), "addr").slice(0, 31);
          if (address.length > 0) { await services.browser.removeServer(ServerBrowserSource.Favorites, address); services.assertActive(); }
        }
        return;
      case "createfavorite":
        if (this.word("ui_netSource") === ServerBrowserSource.Favorites) {
          const favorite = this.text("ui_favoriteName").slice(0, 31), address = this.text("ui_favoriteAddress").slice(0, 31);
          await this.addFavorite(favorite, address);
        }
        return;
      case "orders": case "voiceorders": case "voiceordersteam": {
        const order = cursor.string(); services.assertActive();
        if (order === undefined) return;
        const selected = qvmFloatToInt(this.value("cg_selectedPlayer"));
        if (command === "voiceordersteam") {
          if (selected === services.players.myTeamCount) { this.append(order); this.append("\n"); }
        } else if (selected < services.players.myTeamCount) {
          // The strcpy precedes the array read in the source.
          if (order === null || sourceCommandText(order).length >= 1024) this.orderFormat(order, 0);
          const client = services.players.teamClientNums[selected];
          if (client === undefined) throw new RangeError(`Team Arena orders reads outside teamClientNums[64] at ${selected}`);
          this.append(this.orderFormat(order, client)); this.append("\n");
        } else if (command === "orders") {
          for (let i = 0; i < services.players.myTeamCount; i++) {
            if (same(this.text("name"), infoSlot(services.players.teamNames, i))) continue;
            this.append(this.orderFormat(order, infoSlot(services.players.teamNames, i))); this.append("\n");
          }
        }
        await this.closeInGame(); return;
      }
      case "glcustom": this.set("ui_glCustom", "4"); return;
      case "update": {
        const setting = cursor.string(); services.assertActive();
        if (setting !== undefined) {
          if (setting === null) throw new RangeError("UI_Update reaches Cvar_VariableValue with a NULL String_Parse name");
          services.settings.update(setting); services.assertActive();
        }
        return;
      }
      case "setpbclstatus": integer(cursor); services.assertActive(); return; // cl_ui.c UI_SET_PBCLSTATUS returns 0 without effects.
      default: services.print(this.format("unknown UI script %s\n", [name])); services.assertActive();
    }
  }
}
