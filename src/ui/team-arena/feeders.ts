/*
 * UI_FeederCount, UI_FeederItemText, UI_FeederItemImage and UI_FeederSelection
 * from id Software's code/ui/ui_main.c; feeder IDs from ui/menudef.h.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { infoValueForKey } from "../../core/info-string.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import { gameFormat } from "../../game/format.ts";
import type { GameFormatArgument } from "../../game/format.ts";
import { gameAtoi } from "../../game/numeric.ts";
import type { PictureAsset } from "../../render/draw2d.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { RendererResources } from "../../render/world.ts";
import type { UiRuntimeFeeder, UiRuntimeFeederItem } from "../runtime.ts";
import type { TeamArenaUiCinematics } from "./cinematics.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaUiInteractionState } from "./interaction-state.ts";
import type { TeamArenaLists } from "./lists.ts";
import type { TeamArenaModels } from "./models.ts";
import type { TeamArenaPlayerList } from "./player-list.ts";
import type { TeamArenaScores } from "./scores.ts";
import type { TeamArenaSelection } from "./selection.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";
import type { TeamArenaServerStatus } from "./server-status.ts";
import type { TeamArenaTeamInfo } from "./team-info.ts";

enum Feeder { Heads = 0, Maps = 1, Servers = 2, AllMaps = 4, Players = 7, Team = 8, Mods = 9,
  Demos = 10, Q3Heads = 12, ServerStatus = 13, FindPlayer = 14, Cinematics = 15 }
const GAME_TYPES = ["FFA", "TOURNAMENT", "SP", "TEAM DM", "CTF", "1FCTF", "OVERLOAD", "HARVESTER", "TEAMTOURNAMENT"];
const NET_NAMES: readonly (string | null)[] = ["???", "UDP", "IPX", null];
const PREVIEW_RECT = { x: 0, y: 0, width: 0, height: 0 };

export interface TeamArenaFeederServices {
  readonly cvars: TeamArenaUiCvars;
  readonly game: TeamArenaGameInfo;
  readonly teams: TeamArenaTeamInfo;
  readonly selection: TeamArenaSelection;
  readonly lists: TeamArenaLists;
  readonly models: TeamArenaModels;
  readonly scores: TeamArenaScores;
  readonly players: TeamArenaPlayerList;
  readonly browser: ServerBrowser;
  readonly servers: TeamArenaServerBrowser;
  readonly status: TeamArenaServerStatus;
  readonly cinematics: TeamArenaUiCinematics;
  readonly renderer: RendererResources;
  readonly interaction: TeamArenaUiInteractionState;
  readClient(): Parameters<TeamArenaPlayerList["build"]>[0];
  readRealTime(): number;
  print(text: string): void;
  assertActive(): void;
}

function int32(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Team Arena feeder requires source int32 index, column and UI realTime");
}

/** One UI lifetime's source caches. Callers await one feeder operation at a time. */
export class TeamArenaFeeders implements UiRuntimeFeeder {
  private serverInfo = "";
  private lastColumn = -1;
  private lastTime = 0;
  private selectionInfo = "";

  constructor(private readonly services: TeamArenaFeederServices) {}

  private realTime(): number {
    const value = this.services.readRealTime(); this.services.assertActive(); int32(value); return value;
  }
  private format(format: string, args: readonly GameFormatArgument[], size: number): string {
    const text = gameFormat(format, args);
    if (text.length >= size) { this.services.print(`Com_sprintf: overflow of ${text.length} in ${size}\n`); this.services.assertActive(); }
    return text.slice(0, size - 1);
  }
  private set(name: string, value: string | null): void {
    const services = this.services;
    if (value === null) {
      // Cvar_Set2(NULL) resets an existing cvar forcibly; an unknown cvar is not created.
      const variable = services.cvars.registry.get(name); services.assertActive();
      if (variable === undefined) return;
      value = variable.resetValue;
    }
    services.cvars.registry.set(name, value, true); services.assertActive();
  }
  private displayServer(index: number): number {
    const value = this.services.servers.displayServers[index];
    if (value === undefined) throw new RangeError(`Team Arena feeder reads outside displayServers[2048] at ${index}`);
    return value;
  }
  private picture(shader: SceneShader | null): PictureAsset {
    const picture = this.services.renderer.picture(shader); this.services.assertActive(); return picture;
  }

  count(feeder: number): number {
    const services = this.services;
    services.assertActive();
    switch (feeder) {
      case Feeder.Heads: return services.selection.headCountByTeam();
      case Feeder.Q3Heads: return services.models.headCount;
      case Feeder.Cinematics: return services.lists.movieCount;
      case Feeder.Maps: case Feeder.AllMaps: return services.selection.mapCountByGameType(feeder === Feeder.Maps);
      case Feeder.Servers: return services.servers.numDisplayServers;
      case Feeder.ServerStatus: return services.status.serverStatusInfo.numLines;
      case Feeder.FindPlayer: return services.status.numFoundPlayerServers;
      case Feeder.Players: case Feeder.Team:
        if (this.realTime() > services.interaction.playerRefresh) {
          services.interaction.playerRefresh = (this.realTime() + 3000) | 0;
          const client = services.readClient(); services.assertActive();
          services.players.build(client); services.assertActive();
        }
        return feeder === Feeder.Players ? services.players.playerCount : services.players.myTeamCount;
      case Feeder.Mods: return services.lists.modCount;
      case Feeder.Demos: return services.lists.demoCount;
      default: return 0;
    }
  }

  private serverText(index: number, column: number): string {
    const services = this.services;
    if (index < 0 || index >= services.servers.numDisplayServers) return "";
    // Source cache has no row key and its deadline comparison points backwards.
    if (this.lastColumn !== column || this.lastTime > ((this.realTime() + 5000) | 0)) {
      const info = services.browser.getServerInfo(services.cvars.get("ui_netSource").integerValue, this.displayServer(index), 1024);
      services.assertActive(); this.serverInfo = info; this.lastColumn = column; this.lastTime = this.realTime();
    }
    const ping = gameAtoi(infoValueForKey(this.serverInfo, "ping"));
    switch (column) {
      case 0:
        if (ping <= 0) return infoValueForKey(this.serverInfo, "addr");
        if (services.cvars.get("ui_netSource").integerValue === 0) {
          const hostname = infoValueForKey(this.serverInfo, "hostname");
          const net = infoSlot(NET_NAMES, gameAtoi(infoValueForKey(this.serverInfo, "nettype")));
          return this.format("%s [%s]", [hostname, net], 1024);
        }
        return this.format("%s", [infoValueForKey(this.serverInfo, "hostname")], 1024);
      case 1: return infoValueForKey(this.serverInfo, "mapname");
      case 2: return this.format("%s (%s)", [infoValueForKey(this.serverInfo, "clients"), infoValueForKey(this.serverInfo, "sv_maxclients")], 32);
      case 3: {
        const game = gameAtoi(infoValueForKey(this.serverInfo, "gametype"));
        return game >= 0 && game < GAME_TYPES.length ? infoSlot(GAME_TYPES, game) : "Unknown";
      }
      case 4: return ping <= 0 ? "..." : infoValueForKey(this.serverInfo, "ping");
      case 5: return gameAtoi(infoValueForKey(this.serverInfo, "punkbuster")) !== 0 ? "Yes" : "No";
      default: return "";
    }
  }

  async item(feeder: number, index: number, column: number): Promise<UiRuntimeFeederItem> {
    const services = this.services;
    services.assertActive(); int32(index); int32(column);
    let text: string | null = "";
    switch (feeder) {
      case Feeder.Heads: text = services.selection.selectedHead(index).name; break;
      case Feeder.Q3Heads: if (index >= 0 && index < services.models.headCount) text = infoSlot(services.models.heads, index).name; break;
      case Feeder.Maps: case Feeder.AllMaps: text = services.selection.selectedMap(index).name; break;
      case Feeder.Servers: text = this.serverText(index, column); break;
      case Feeder.ServerStatus:
        if (index >= 0 && index < services.status.serverStatusInfo.numLines && column >= 0 && column < 4) text = services.status.serverStatusInfo.column(index, column);
        break;
      case Feeder.FindPlayer:
        if (index >= 0 && index < services.status.numFoundPlayerServers) text = infoSlot(services.status.foundPlayerServerNames, index);
        break;
      case Feeder.Players: if (index >= 0 && index < services.players.playerCount) text = infoSlot(services.players.playerNames, index); break;
      case Feeder.Team: if (index >= 0 && index < services.players.myTeamCount) text = infoSlot(services.players.teamNames, index); break;
      case Feeder.Mods:
        if (index >= 0 && index < services.lists.modCount) {
          const row = infoSlot(services.lists.modList, index);
          text = row.modDescr !== null && row.modDescr.length > 0 && !row.modDescr.startsWith("\0") ? row.modDescr : row.modName;
        }
        break;
      case Feeder.Cinematics: if (index >= 0 && index < services.lists.movieCount) text = infoSlot(services.lists.movieList, index); break;
      case Feeder.Demos: if (index >= 0 && index < services.lists.demoCount) text = infoSlot(services.lists.demoList, index); break;
    }
    return { text, picture: undefined }; // UI_FeederItemText always writes the source -1 image handle.
  }

  async image(feeder: number, index: number): Promise<PictureAsset> {
    const services = this.services;
    services.assertActive(); int32(index);
    if (feeder === Feeder.Heads) {
      index = services.selection.selectedHead(index).actual;
      if (index >= 0 && index < services.teams.characterCount) {
        const row = infoSlot(services.teams.characterList, index);
        if (row.headImage.kind === "unregistered") {
          const shader = await services.renderer.registerShaderNoMip(row.imageName); services.assertActive();
          row.headImage = { kind: "registered", shader };
        }
        return this.picture(row.headImage.shader);
      }
    } else if (feeder === Feeder.Q3Heads) {
      if (index >= 0 && index < services.models.headCount) return this.picture(infoSlot(services.models.heads, index).icon);
    } else if (feeder === Feeder.AllMaps || feeder === Feeder.Maps) {
      index = services.selection.selectedMap(index).actual;
      if (index >= 0 && index < services.game.mapCount) {
        const row = infoSlot(services.game.mapList, index);
        if (row.levelShot.kind === "unregistered") {
          const shader = await services.renderer.registerShaderNoMip(row.imageName); services.assertActive();
          row.levelShot = { kind: "registered", shader };
        }
        return this.picture(row.levelShot.shader);
      }
    }
    return this.picture(null);
  }

  async select(feeder: number, index: number): Promise<void> {
    const services = this.services, state = services.interaction;
    services.assertActive(); int32(index);
    switch (feeder) {
      case Feeder.Heads:
        index = services.selection.selectedHead(index).actual;
        if (index >= 0 && index < services.teams.characterCount) {
          this.set("team_model", gameFormat("%s", [infoSlot(services.teams.characterList, index).base]));
          this.set("team_headmodel", gameFormat("*%s", [infoSlot(services.teams.characterList, index).name]));
          state.updateModel = true;
        }
        return;
      case Feeder.Q3Heads:
        if (index >= 0 && index < services.models.headCount) {
          this.set("model", infoSlot(services.models.heads, index).name);
          this.set("headmodel", infoSlot(services.models.heads, index).name);
          state.updateModel = true;
        }
        return;
      case Feeder.Maps: case Feeder.AllMaps: {
        const current = feeder === Feeder.AllMaps ? "ui_currentNetMap" : "ui_currentMap";
        const previous = infoSlot(services.game.mapList, services.cvars.get(current).integerValue);
        if (previous.cinematic >= 0) { services.cinematics.stop(previous.cinematic); services.assertActive(); previous.cinematic = -1; }
        const actual = services.selection.selectedMap(index).actual;
        this.set("ui_mapIndex", gameFormat("%d", [index]));
        services.cvars.writeInteger("ui_mapIndex", index); services.assertActive();
        services.cvars.writeInteger(current, actual); services.assertActive();
        this.set(current, gameFormat("%d", [actual]));
        const selected = infoSlot(services.game.mapList, services.cvars.get(current).integerValue);
        const movie = await services.cinematics.play(gameFormat("%s.roq", [selected.mapLoadName]), PREVIEW_RECT); services.assertActive();
        selected.cinematic = movie;
        if (feeder === Feeder.Maps) {
          services.scores.loadBestScores(infoSlot(services.game.mapList, services.cvars.get("ui_currentMap").integerValue).mapLoadName,
            infoSlot(services.game.gameTypes, services.cvars.get("ui_gameType").integerValue).gtEnum);
          services.assertActive();
          this.set("ui_opponentModel", infoSlot(services.game.mapList, services.cvars.get("ui_currentMap").integerValue).opponentName);
          state.updateOpponentModel = true;
        }
        return;
      }
      case Feeder.Servers: {
        services.servers.currentServer = index;
        const info = services.browser.getServerInfo(services.cvars.get("ui_netSource").integerValue, this.displayServer(index), 1024);
        services.assertActive(); this.selectionInfo = info;
        const shader = await services.renderer.registerShaderNoMip(gameFormat("levelshots/%s", [infoValueForKey(this.selectionInfo, "mapname")])); services.assertActive();
        services.servers.currentServerPreview = shader;
        if (services.servers.currentServerCinematic >= 0) {
          services.cinematics.stop(services.servers.currentServerCinematic); services.assertActive(); services.servers.currentServerCinematic = -1;
        }
        const map = infoValueForKey(this.selectionInfo, "mapname");
        if (map.length > 0) {
          const movie = await services.cinematics.play(gameFormat("%s.roq", [map]), PREVIEW_RECT); services.assertActive();
          services.servers.currentServerCinematic = movie;
        }
        return;
      }
      case Feeder.FindPlayer: await services.status.selectFoundPlayer(index, this.realTime()); services.assertActive(); return;
      case Feeder.Players: state.playerIndex = index; return;
      case Feeder.Team: state.teamIndex = index; return;
      case Feeder.Mods: state.modIndex = index; return;
      case Feeder.Cinematics:
        state.movieIndex = index;
        if (state.previewMovie >= 0) { services.cinematics.stop(state.previewMovie); services.assertActive(); }
        state.previewMovie = -1; return;
      case Feeder.Demos: state.demoIndex = index; return;
      default: return;
    }
  }
}
