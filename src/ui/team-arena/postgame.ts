/*
 * UI_CalcPostGameStats from code/ui/ui_atoms.c and UI_ShowPostGame from ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 * Integer arithmetic and floating conversions follow the QVM32 profile.
 */
import type { CommandContext } from "../../core/commands.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UiMenuCommand } from "../public.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaMenuController } from "./menu-controller.ts";
import { PostGameInfo } from "./scores.ts";
import type { TeamArenaScores } from "./scores.ts";

export interface TeamArenaPostGameServices {
  readonly cvars: TeamArenaUiCvars;
  readonly gameInfo: TeamArenaGameInfo;
  readonly scores: TeamArenaScores;
  readonly menus: TeamArenaMenuController;
  readonly assertActive: () => void;
}

/** Callers serialize and await this operation with the owning UI's other work. */
export class TeamArenaPostGame {
  newHighScoreTime = 0;
  newBestTime = 0;
  soundHighScore = false;

  constructor(private readonly services: TeamArenaPostGameServices) {}

  private set(name: string, value: string): void {
    this.services.cvars.registry.set(name, value, true);
    this.services.assertActive();
  }

  async show(newHigh: boolean): Promise<void> {
    this.services.assertActive();
    this.set("cg_cameraOrbit", "0");
    this.set("cg_thirdPerson", "0");
    this.set("sv_killserver", "1");
    this.soundHighScore = newHigh;
    await this.services.menus.setActiveMenu(UiMenuCommand.Postgame);
    this.services.assertActive();
  }

  private value(name: string): number {
    const value = this.services.cvars.registry.get(name)?.numericValue ?? 0;
    this.services.assertActive();
    return Math.fround(value);
  }

  async calculate(context: CommandContext, client: Pick<EngineClientSession, "getConfigString">, realTime: number): Promise<void> {
    const services = this.services;
    context.assertActive(); services.assertActive();
    if (!Number.isInteger(realTime) || realTime < -2147483648 || realTime > 2147483647) {
      throw new RangeError("UI_CalcPostGameStats realTime requires the source int32 UI clock");
    }
    const configString = client.getConfigString(0);
    services.assertActive();
    const info = sourceCommandText(configString ?? "").slice(0, 1023);
    const map = infoValueForKey(info, "mapname").slice(0, 63), game = gameAtoi(infoValueForKey(info, "g_gametype"));
    const filename = services.scores.scorePath(map, game), oldInfo = services.scores.readRecord(filename);
    services.assertActive();
    const arg = (index: number): number => {
      context.assertActive();
      return gameAtoi(sourceCommandText(context.argv[index] ?? "").slice(0, 1023));
    };
    const next = new PostGameInfo();
    next.accuracy = arg(3);
    next.impressives = arg(4);
    next.excellents = arg(5);
    next.defends = arg(6);
    next.assists = arg(7);
    next.gauntlets = arg(8);
    next.baseScore = arg(9);
    next.perfects = arg(10);
    next.redScore = arg(11);
    next.blueScore = arg(12);
    const time = arg(13);
    next.captures = arg(14);
    next.time = qvmFloatToInt(Math.fround(Math.fround(Math.fround(time) - this.value("ui_matchStartTime")) / 1000));
    const mapIndex = services.cvars.get("ui_currentMap").integerValue;
    services.assertActive();
    const row = services.gameInfo.mapList[mapIndex];
    if (row === undefined) throw new RangeError(`UI_CalcPostGameStats map read outside source 128-entry array at ${mapIndex}`);
    const adjustedTime = row.timeToBeat[game];
    if (adjustedTime === undefined) throw new RangeError(`UI_CalcPostGameStats time read outside source 16-entry array at ${game}`);
    next.timeBonus = next.time < adjustedTime ? Math.imul((adjustedTime - next.time) | 0, 10) : 0;
    next.shutoutBonus = next.redScore > next.blueScore && next.blueScore <= 0 ? 100 : 0;
    next.skillBonus = qvmFloatToInt(this.value("g_spSkill"));
    if (next.skillBonus <= 0) next.skillBonus = 1;
    next.score = Math.imul((next.baseScore + next.shutoutBonus + next.timeBonus) | 0, next.skillBonus);
    const newHigh = next.redScore > next.blueScore && next.score > oldInfo.score;
    if (newHigh) {
      this.newHighScoreTime = (realTime + 20000) | 0;
      services.scores.writeRecord(filename, next);
      services.assertActive();
    }
    if (next.time < oldInfo.time) this.newBestTime = (realTime + 20000) | 0;
    for (const [name, saved] of [
      ["capturelimit", "ui_saveCaptureLimit"], ["fraglimit", "ui_saveFragLimit"], ["cg_drawTimer", "ui_drawTimer"],
      ["g_doWarmup", "ui_doWarmup"], ["g_Warmup", "ui_Warmup"], ["sv_pure", "ui_pure"], ["g_friendlyFire", "ui_friendlyFire"],
    ] satisfies readonly (readonly [string, string])[]) {
      const value = sourceCommandText(services.cvars.registry.get(saved)?.value ?? "").slice(0, 1023);
      services.assertActive();
      this.set(name, value);
    }
    services.scores.setBestScores(next, true);
    services.assertActive();
    await this.show(newHigh);
    context.assertActive(); services.assertActive();
  }
}
