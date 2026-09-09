// Team Arena UI cvars from id Software code/ui/ui_main.c. GPL-2.0-or-later.
import { CvarFlag } from "../../core/cvar.ts";
import type { CvarRegistry, VmCvar, VmCvarRead } from "../../core/cvar.ts";

function entry<Symbol extends string>(symbol: Symbol, name: string, defaultValue: string, flags: number) {
  return Object.freeze({ symbol, name, defaultValue, flags });
}

export const TEAM_ARENA_UI_CVARS = Object.freeze([
  entry("ui_ffa_fraglimit", "ui_ffa_fraglimit", "20", CvarFlag.Archive),
  entry("ui_ffa_timelimit", "ui_ffa_timelimit", "0", CvarFlag.Archive),
  entry("ui_tourney_fraglimit", "ui_tourney_fraglimit", "0", CvarFlag.Archive),
  entry("ui_tourney_timelimit", "ui_tourney_timelimit", "15", CvarFlag.Archive),
  entry("ui_team_fraglimit", "ui_team_fraglimit", "0", CvarFlag.Archive),
  entry("ui_team_timelimit", "ui_team_timelimit", "20", CvarFlag.Archive),
  entry("ui_team_friendly", "ui_team_friendly", "1", CvarFlag.Archive),
  entry("ui_ctf_capturelimit", "ui_ctf_capturelimit", "8", CvarFlag.Archive),
  entry("ui_ctf_timelimit", "ui_ctf_timelimit", "30", CvarFlag.Archive),
  entry("ui_ctf_friendly", "ui_ctf_friendly", "0", CvarFlag.Archive),
  entry("ui_arenasFile", "g_arenasFile", "", CvarFlag.Init | CvarFlag.ReadOnly),
  entry("ui_botsFile", "g_botsFile", "", CvarFlag.Init | CvarFlag.ReadOnly),
  entry("ui_spScores1", "g_spScores1", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spScores2", "g_spScores2", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spScores3", "g_spScores3", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spScores4", "g_spScores4", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spScores5", "g_spScores5", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spAwards", "g_spAwards", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spVideos", "g_spVideos", "", CvarFlag.Archive | CvarFlag.ReadOnly),
  entry("ui_spSkill", "g_spSkill", "2", CvarFlag.Archive),
  entry("ui_spSelection", "ui_spSelection", "", CvarFlag.ReadOnly),
  entry("ui_browserMaster", "ui_browserMaster", "0", CvarFlag.Archive),
  entry("ui_browserGameType", "ui_browserGameType", "0", CvarFlag.Archive),
  entry("ui_browserSortKey", "ui_browserSortKey", "4", CvarFlag.Archive),
  entry("ui_browserShowFull", "ui_browserShowFull", "1", CvarFlag.Archive),
  entry("ui_browserShowEmpty", "ui_browserShowEmpty", "1", CvarFlag.Archive),
  entry("ui_brassTime", "cg_brassTime", "2500", CvarFlag.Archive),
  entry("ui_drawCrosshair", "cg_drawCrosshair", "4", CvarFlag.Archive),
  entry("ui_drawCrosshairNames", "cg_drawCrosshairNames", "1", CvarFlag.Archive),
  entry("ui_marks", "cg_marks", "1", CvarFlag.Archive),
  entry("ui_server1", "server1", "", CvarFlag.Archive),
  entry("ui_server2", "server2", "", CvarFlag.Archive),
  entry("ui_server3", "server3", "", CvarFlag.Archive),
  entry("ui_server4", "server4", "", CvarFlag.Archive),
  entry("ui_server5", "server5", "", CvarFlag.Archive),
  entry("ui_server6", "server6", "", CvarFlag.Archive),
  entry("ui_server7", "server7", "", CvarFlag.Archive),
  entry("ui_server8", "server8", "", CvarFlag.Archive),
  entry("ui_server9", "server9", "", CvarFlag.Archive),
  entry("ui_server10", "server10", "", CvarFlag.Archive),
  entry("ui_server11", "server11", "", CvarFlag.Archive),
  entry("ui_server12", "server12", "", CvarFlag.Archive),
  entry("ui_server13", "server13", "", CvarFlag.Archive),
  entry("ui_server14", "server14", "", CvarFlag.Archive),
  entry("ui_server15", "server15", "", CvarFlag.Archive),
  entry("ui_server16", "server16", "", CvarFlag.Archive),
  entry("ui_cdkeychecked", "ui_cdkeychecked", "0", CvarFlag.ReadOnly),
  entry("ui_new", "ui_new", "0", CvarFlag.Temporary),
  entry("ui_debug", "ui_debug", "0", CvarFlag.Temporary),
  entry("ui_initialized", "ui_initialized", "0", CvarFlag.Temporary),
  entry("ui_teamName", "ui_teamName", "Pagans", CvarFlag.Archive),
  entry("ui_opponentName", "ui_opponentName", "Stroggs", CvarFlag.Archive),
  entry("ui_redteam", "ui_redteam", "Pagans", CvarFlag.Archive),
  entry("ui_blueteam", "ui_blueteam", "Stroggs", CvarFlag.Archive),
  entry("ui_dedicated", "ui_dedicated", "0", CvarFlag.Archive),
  entry("ui_gameType", "ui_gametype", "3", CvarFlag.Archive),
  entry("ui_joinGameType", "ui_joinGametype", "0", CvarFlag.Archive),
  entry("ui_netGameType", "ui_netGametype", "3", CvarFlag.Archive),
  entry("ui_actualNetGameType", "ui_actualNetGametype", "3", CvarFlag.Archive),
  entry("ui_redteam1", "ui_redteam1", "0", CvarFlag.Archive),
  entry("ui_redteam2", "ui_redteam2", "0", CvarFlag.Archive),
  entry("ui_redteam3", "ui_redteam3", "0", CvarFlag.Archive),
  entry("ui_redteam4", "ui_redteam4", "0", CvarFlag.Archive),
  entry("ui_redteam5", "ui_redteam5", "0", CvarFlag.Archive),
  entry("ui_blueteam1", "ui_blueteam1", "0", CvarFlag.Archive),
  entry("ui_blueteam2", "ui_blueteam2", "0", CvarFlag.Archive),
  entry("ui_blueteam3", "ui_blueteam3", "0", CvarFlag.Archive),
  entry("ui_blueteam4", "ui_blueteam4", "0", CvarFlag.Archive),
  entry("ui_blueteam5", "ui_blueteam5", "0", CvarFlag.Archive),
  entry("ui_netSource", "ui_netSource", "0", CvarFlag.Archive),
  entry("ui_menuFiles", "ui_menuFiles", "ui/menus.txt", CvarFlag.Archive),
  entry("ui_currentTier", "ui_currentTier", "0", CvarFlag.Archive),
  entry("ui_currentMap", "ui_currentMap", "0", CvarFlag.Archive),
  entry("ui_currentNetMap", "ui_currentNetMap", "0", CvarFlag.Archive),
  entry("ui_mapIndex", "ui_mapIndex", "0", CvarFlag.Archive),
  entry("ui_currentOpponent", "ui_currentOpponent", "0", CvarFlag.Archive),
  entry("ui_selectedPlayer", "cg_selectedPlayer", "0", CvarFlag.Archive),
  entry("ui_selectedPlayerName", "cg_selectedPlayerName", "", CvarFlag.Archive),
  entry("ui_lastServerRefresh_0", "ui_lastServerRefresh_0", "", CvarFlag.Archive),
  entry("ui_lastServerRefresh_1", "ui_lastServerRefresh_1", "", CvarFlag.Archive),
  entry("ui_lastServerRefresh_2", "ui_lastServerRefresh_2", "", CvarFlag.Archive),
  entry("ui_lastServerRefresh_3", "ui_lastServerRefresh_3", "", CvarFlag.Archive),
  entry("ui_singlePlayerActive", "ui_singlePlayerActive", "0", 0),
  entry("ui_scoreAccuracy", "ui_scoreAccuracy", "0", CvarFlag.Archive),
  entry("ui_scoreImpressives", "ui_scoreImpressives", "0", CvarFlag.Archive),
  entry("ui_scoreExcellents", "ui_scoreExcellents", "0", CvarFlag.Archive),
  entry("ui_scoreCaptures", "ui_scoreCaptures", "0", CvarFlag.Archive),
  entry("ui_scoreDefends", "ui_scoreDefends", "0", CvarFlag.Archive),
  entry("ui_scoreAssists", "ui_scoreAssists", "0", CvarFlag.Archive),
  entry("ui_scoreGauntlets", "ui_scoreGauntlets", "0", CvarFlag.Archive),
  entry("ui_scoreScore", "ui_scoreScore", "0", CvarFlag.Archive),
  entry("ui_scorePerfect", "ui_scorePerfect", "0", CvarFlag.Archive),
  entry("ui_scoreTeam", "ui_scoreTeam", "0 to 0", CvarFlag.Archive),
  entry("ui_scoreBase", "ui_scoreBase", "0", CvarFlag.Archive),
  entry("ui_scoreTime", "ui_scoreTime", "00:00", CvarFlag.Archive),
  entry("ui_scoreTimeBonus", "ui_scoreTimeBonus", "0", CvarFlag.Archive),
  entry("ui_scoreSkillBonus", "ui_scoreSkillBonus", "0", CvarFlag.Archive),
  entry("ui_scoreShutoutBonus", "ui_scoreShutoutBonus", "0", CvarFlag.Archive),
  entry("ui_fragLimit", "ui_fragLimit", "10", 0),
  entry("ui_captureLimit", "ui_captureLimit", "5", 0),
  entry("ui_smallFont", "ui_smallFont", "0.25", CvarFlag.Archive),
  entry("ui_bigFont", "ui_bigFont", "0.4", CvarFlag.Archive),
  entry("ui_findPlayer", "ui_findPlayer", "Sarge", CvarFlag.Archive),
  entry("ui_Q3Model", "ui_q3model", "0", CvarFlag.Archive),
  entry("ui_hudFiles", "cg_hudFiles", "ui/hud.txt", CvarFlag.Archive),
  entry("ui_recordSPDemo", "ui_recordSPDemo", "0", CvarFlag.Archive),
  entry("ui_teamArenaFirstRun", "ui_teamArenaFirstRun", "0", CvarFlag.Archive),
  entry("ui_realWarmUp", "g_warmup", "20", CvarFlag.Archive),
  entry("ui_realCaptureLimit", "capturelimit", "8", CvarFlag.ServerInfo | CvarFlag.Archive | CvarFlag.NoRestart),
  entry("ui_serverStatusTimeOut", "ui_serverStatusTimeOut", "7000", CvarFlag.Archive),
]);

export type TeamArenaUiCvarSymbol = typeof TEAM_ARENA_UI_CVARS[number]["symbol"];

export class TeamArenaUiCvars {
  private readonly mirrors = new Map<TeamArenaUiCvarSymbol, VmCvar>();

  constructor(readonly registry: CvarRegistry, private readonly assertCurrentOperation: () => undefined) {
    for (const { symbol, name, defaultValue, flags } of TEAM_ARENA_UI_CVARS) {
      this.assertCurrentOperation();
      this.mirrors.set(symbol, registry.registerVm(name, defaultValue, flags));
    }
  }

  get(symbol: TeamArenaUiCvarSymbol): VmCvarRead {
    const mirror = this.mirrors.get(symbol);
    if (mirror === undefined) throw new Error(`Unregistered Team Arena UI VM cvar ${symbol}`);
    return mirror;
  }

  writeInteger(symbol: TeamArenaUiCvarSymbol, value: number): void {
    this.assertCurrentOperation();
    const mirror = this.mirrors.get(symbol);
    if (mirror === undefined) throw new Error(`Unregistered Team Arena UI VM cvar ${symbol}`);
    mirror.writeInteger(value);
  }

  update(): void {
    for (const mirror of this.mirrors.values()) {
      this.assertCurrentOperation();
      mirror.update();
    }
  }
}
