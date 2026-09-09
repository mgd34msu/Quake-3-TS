// UI_OwnerDrawVisible from id Software code/ui/ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../../assets/wav.ts";
import type { EngineSound } from "../../engine/sound.ts";
import { ServerBrowserSource } from "../../engine/server-browser.ts";
import { GameType } from "../../shared/definitions.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaPlayerList } from "./player-list.ts";
import type { TeamArenaPostGame } from "./postgame.ts";
import type { TeamArenaScores } from "./scores.ts";

/** UI_SHOW_* values in the retail menu language (ui/menudef.h). */
export enum TeamArenaVisibilityFlag {
  Leader = 0x0001, NotLeader = 0x0002, FavoriteServers = 0x0004,
  AnyNonTeamGame = 0x0008, AnyTeamGame = 0x0010, NewHighScore = 0x0020,
  DemoAvailable = 0x0040, NewBestTime = 0x0080, Ffa = 0x0100, NotFfa = 0x0200,
  NetAnyNonTeamGame = 0x0400, NetAnyTeamGame = 0x0800, NotFavoriteServers = 0x1000,
}

export interface TeamArenaVisibilityServices {
  readonly cvars: TeamArenaUiCvars;
  readonly gameInfo: TeamArenaGameInfo;
  readonly players: TeamArenaPlayerList;
  readonly postgame: TeamArenaPostGame;
  readonly scores: TeamArenaScores;
  readonly sound: Pick<EngineSound, "startLocalSound">;
  newHighScoreSound(): PcmSound | null;
  assertActive(): void;
}

export class TeamArenaVisibility {
  constructor(private readonly services: TeamArenaVisibilityServices) {}

  private value(name: string): number {
    const value = this.services.cvars.registry.get(name)?.numericValue ?? 0;
    this.services.assertActive();
    return value;
  }

  private selectedSelf(): boolean {
    const services = this.services;
    const selected = services.cvars.get("ui_selectedPlayer").integerValue;
    if (selected >= services.players.myTeamCount) return false;
    const client = services.players.teamClientNums[selected];
    if (client === undefined) throw new RangeError("UI_OwnerDrawVisible team client read exceeds its source 64-entry array");
    return client === services.players.playerNumber;
  }

  visible(flags: number, realTime: number): boolean {
    const services = this.services;
    services.assertActive();
    let visible = true;
    // Preserve source evaluation order: a failed condition does not skip later sound effects.
    if ((flags & TeamArenaVisibilityFlag.Ffa) !== 0 && this.value("g_gametype") !== GameType.GT_FFA) visible = false;
    if ((flags & TeamArenaVisibilityFlag.NotFfa) !== 0 && this.value("g_gametype") === GameType.GT_FFA) visible = false;
    if ((flags & TeamArenaVisibilityFlag.Leader) !== 0
      && (services.players.teamLeader === 0 || this.selectedSelf())) visible = false;
    if ((flags & TeamArenaVisibilityFlag.NotLeader) !== 0
      && services.players.teamLeader !== 0 && !this.selectedSelf()) visible = false;
    if ((flags & TeamArenaVisibilityFlag.FavoriteServers) !== 0
      && services.cvars.get("ui_netSource").integerValue !== ServerBrowserSource.Favorites) visible = false;
    if ((flags & TeamArenaVisibilityFlag.NotFavoriteServers) !== 0
      && services.cvars.get("ui_netSource").integerValue === ServerBrowserSource.Favorites) visible = false;
    if ((flags & TeamArenaVisibilityFlag.AnyTeamGame) !== 0
      && infoSlot(services.gameInfo.gameTypes, services.cvars.get("ui_gameType").integerValue).gtEnum <= GameType.GT_TEAM) visible = false;
    if ((flags & TeamArenaVisibilityFlag.AnyNonTeamGame) !== 0
      && infoSlot(services.gameInfo.gameTypes, services.cvars.get("ui_gameType").integerValue).gtEnum > GameType.GT_TEAM) visible = false;
    if ((flags & TeamArenaVisibilityFlag.NetAnyTeamGame) !== 0
      && infoSlot(services.gameInfo.gameTypes, services.cvars.get("ui_netGameType").integerValue).gtEnum <= GameType.GT_TEAM) visible = false;
    if ((flags & TeamArenaVisibilityFlag.NetAnyNonTeamGame) !== 0
      && infoSlot(services.gameInfo.gameTypes, services.cvars.get("ui_netGameType").integerValue).gtEnum > GameType.GT_TEAM) visible = false;
    if ((flags & TeamArenaVisibilityFlag.NewHighScore) !== 0) {
      if (services.postgame.newHighScoreTime < realTime) visible = false;
      else if (services.postgame.soundHighScore && this.value("sv_killserver") === 0) {
        const sound = services.newHighScoreSound(); services.assertActive();
        services.sound.startLocalSound(sound, 7); services.assertActive();
        services.postgame.soundHighScore = false;
      }
    }
    if ((flags & TeamArenaVisibilityFlag.NewBestTime) !== 0 && services.postgame.newBestTime < realTime) visible = false;
    if ((flags & TeamArenaVisibilityFlag.DemoAvailable) !== 0 && !services.scores.demoAvailable) visible = false;
    return visible;
  }

}
