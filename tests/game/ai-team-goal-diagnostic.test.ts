// BotPrintTeamGoal fixtures from id Software's code/game/ai_cmd.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import type { BspMap } from "../../src/assets/bsp.ts";
import { AasDebugLines } from "../../src/botlib/aas-debug.ts";
import { BotLibrary } from "../../src/botlib/library.ts";
import { vec3 } from "../../src/core/math.ts";
import { LinuxNativeRandom } from "../../src/core/native-random.ts";
import { botPrintTeamGoal } from "../../src/game/ai-command.ts";
import { BotLongTermGoal } from "../../src/game/ai-definitions.ts";
import { GameAi } from "../../src/game/ai-main.ts";
import { BotDebugPolygons } from "../../src/server/bot-debug.ts";
import { GameType } from "../../src/shared/definitions.ts";
import type { Product } from "../../src/shared/definitions.ts";
import { createGameVerificationHarness } from "../../tools/game-verification-harness.ts";

function fixture(product: Product) {
  const bounds = { min: vec3(-128, -128, -128), max: vec3(128, 128, 128) };
  const map: BspMap = { entities: '{ "classname" "worldspawn" }', entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const game = createGameVerificationHarness({ product, map, gameType: GameType.GT_TEAM, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep  9 2026", clientNamePrefix: "Human", botsReason: "Diagnostic fixture does not schedule AI" });
  const unused = (): never => { throw new Error("Team goal diagnostic must not call botlib or server services"); };
  const lines = new AasDebugLines(new BotDebugPolygons(), unused);
  const library = new BotLibrary({ assets: unused, random: new LinuxNativeRandom(1), print: unused, commonPrint: unused,
    openLog: unused, openWrite: unused, milliseconds: unused, permanentLine: unused,
    movementDebug: lines.movement, clientCommand: unused });
  const ai = new GameAi(game.runtime, library, { getSnapshotEntity: unused, getConsoleMessage: unused,
    userCommand: unused, insertConsoleCommand: unused, checkBotSpawn: unused, loadMap: unused });
  const state = ai.context.states.acquire(0, game.runtime.memory);
  state.client = 0;
  game.configstrings.set(544, "\\n\\^1Sarge\\t\\1");
  game.prints.length = 0;
  return { game, library, context: ai.context, state };
}

test("BotPrintTeamGoal covers all thirteen source LTGs with product-specific cases", () => {
  const cases: readonly (readonly [BotLongTermGoal, string])[] = [
    [BotLongTermGoal.TEAMHELP, "help a team mate"],
    [BotLongTermGoal.TEAMACCOMPANY, "accompany a team mate"],
    [BotLongTermGoal.GETFLAG, "get the flag"],
    [BotLongTermGoal.RUSHBASE, "rush to the base"],
    [BotLongTermGoal.RETURNFLAG, "try to return the flag"],
    [BotLongTermGoal.ATTACKENEMYBASE, "attack the enemy base"],
    [BotLongTermGoal.HARVEST, "harvest"],
    [BotLongTermGoal.DEFENDKEYAREA, "defend a key area"],
    [BotLongTermGoal.GETITEM, "get an item"],
    [BotLongTermGoal.KILL, "kill someone"],
    [BotLongTermGoal.CAMP, "camp"],
    [BotLongTermGoal.CAMPORDER, "camp"],
    [BotLongTermGoal.PATROL, "patrol"],
  ];
  const products: readonly Product[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const { game, library, context, state } = fixture(product);
    try {
      context.time = 10;
      state.teamGoalTime = 13.75;
      for (const [goal, action] of cases) {
        state.ltgType = goal;
        botPrintTeamGoal(context, state);
        const missionpackOnly = goal === BotLongTermGoal.ATTACKENEMYBASE || goal === BotLongTermGoal.HARVEST;
        expect(game.prints.pop()).toBe(product === "baseq3" && missionpackOnly
          ? "Sarge: I've got a regular goal\n" : `Sarge: I'm gonna ${action} for 3 secs\n`);
        expect(game.prints).toHaveLength(0);
      }
    } finally { library.disposeResources(); game.runtime.shutdown(false); }
  }
});

test("BotPrintTeamGoal uses the actual bounded ClientName and source float formatter", () => {
  const { game, library, context, state } = fixture("baseq3");
  try {
    game.configstrings.set(544, `\\n\\^1${"A".repeat(40)}\\t\\1`);
    context.time = 1;
    state.ltgType = BotLongTermGoal.CAMP;
    state.teamGoalTime = 0.25;
    botPrintTeamGoal(context, state);
    expect(game.prints.pop()).toBe(`${"A".repeat(33)}: I'm gonna camp for -0 secs\n`);
    game.configstrings.set(544, `\\n\\${"A".repeat(35)}\\t\\1`);
    botPrintTeamGoal(context, state);
    expect(game.prints.pop()).toBe(`${"A".repeat(35)}: I'm gonna camp for -0 secs\n`);
    game.configstrings.set(544, "\\n\\Changed\\t\\1");
    context.time = 0.00000001;
    state.teamGoalTime = 1;
    botPrintTeamGoal(context, state);
    expect(game.prints.pop()).toBe("Changed: I'm gonna camp for 1 secs\n");
  } finally { library.disposeResources(); game.runtime.shutdown(false); }
});

test("BotPrintTeamGoal default samples FloatTime separately for comparison and duration", () => {
  const { game, library, context, state } = fixture("missionpack");
  try {
    state.ltgType = 0;
    state.teamGoalTime = 100;
    state.ctfRoamTime = 12;
    let reads = 0;
    Object.defineProperty(context, "time", { configurable: true, get: () => { reads++; return reads === 1 ? 1 : reads === 2 ? 10 : 13; } });
    botPrintTeamGoal(context, state);
    expect(reads).toBe(3);
    expect(game.prints.pop()).toBe("Sarge: I'm gonna roam for -1 secs\n");
    state.ctfRoamTime = 10;
    reads = 0;
    botPrintTeamGoal(context, state);
    expect(reads).toBe(2);
    expect(game.prints.pop()).toBe("Sarge: I've got a regular goal\n");
  } finally { library.disposeResources(); game.runtime.shutdown(false); }
});
