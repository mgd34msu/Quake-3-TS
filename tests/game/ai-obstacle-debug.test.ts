// BotGetActivateGoal OBSTACLEDEBUG from id Software's code/game/ai_dmq3.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import type { BspMap } from "../../src/assets/bsp.ts";
import { AasDebugLines } from "../../src/botlib/aas-debug.ts";
import { BotLibrary } from "../../src/botlib/library.ts";
import { CvarFlag } from "../../src/core/cvar.ts";
import { vec3 } from "../../src/core/math.ts";
import { LinuxNativeRandom } from "../../src/core/native-random.ts";
import { registerSourceBotCvars } from "../../src/engine/source-bots.ts";
import { GameAiContext } from "../../src/game/ai-context.ts";
import { botGetActivateGoal } from "../../src/game/ai-navigation.ts";
import { BotActivateGoal } from "../../src/game/ai-state.ts";
import { BotDebugPolygons } from "../../src/server/bot-debug.ts";
import { GameType } from "../../src/shared/definitions.ts";
import { createGameVerificationHarness } from "../../tools/game-verification-harness.ts";

function fixture(entityText: string, obstacleDebug = false) {
  const bounds = { min: vec3(-128, -128, -128), max: vec3(128, 128, 128) };
  const map: BspMap = { entities: '{ "classname" "worldspawn" }', entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const game = createGameVerificationHarness({ product: "baseq3", map, gameType: GameType.GT_FFA, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep 10 2026", clientNamePrefix: "Human", botsReason: "Obstacle diagnostic does not schedule AI" });
  if (obstacleDebug) game.cvars.set("com_botObstacleDebug", "1");
  registerSourceBotCvars(game.cvars);
  const unused = (): never => { throw new Error("Obstacle diagnostic must not call server or asset services"); };
  const lines = new AasDebugLines(new BotDebugPolygons(), unused);
  const library = new BotLibrary({ assets: unused, random: new LinuxNativeRandom(1), print: () => undefined,
    commonPrint: unused, openLog: unused, openWrite: unused, milliseconds: unused, permanentLine: unused,
    movementDebug: lines.movement, clientCommand: unused });
  library.aas.setup();
  library.aas.setInitialized();
  library.aas.bspEntities.load(`{ "classname" "worldspawn" } ${entityText}`);
  const context = new GameAiContext(game.runtime, library, { getSnapshotEntity: unused, getConsoleMessage: unused,
    userCommand: unused, insertConsoleCommand: unused, checkBotSpawn: unused, loadMap: unused });
  context.registerCvar("bot_developer", "0");
  const state = context.states.acquire(0, game.runtime.memory);
  game.prints.length = 0;
  return { game, library, context, state };
}

const obstacle = '{ "classname" "func_static" "model" "*0" "targetname" "blocked" }';

test("OBSTACLEDEBUG defaults off and is independent of com_botDebug", () => {
  const { game, library, context, state } = fixture(obstacle);
  try {
    expect(game.cvars.get("com_botObstacleDebug")?.value).toBe("0");
    expect(game.cvars.get("com_botObstacleDebug")?.flags).toBe(CvarFlag.Init);
    game.cvars.set("com_botDebug", "1");
    expect(botGetActivateGoal(context, state, 0, new BotActivateGoal())).toBe(0);
    expect(game.prints).toEqual([]);
    game.cvars.set("com_botObstacleDebug", "1");
    expect(game.cvars.get("com_botObstacleDebug")?.value).toBe("0");
  } finally { library.disposeResources(); game.runtime.shutdown(false); }
});

test("OBSTACLEDEBUG prints after search exhaustion and retains the original target through relays", () => {
  const { game, library, context, state } = fixture(`${obstacle}
    { "classname" "target_relay" "target" "blocked" "targetname" "relay" }
    { "classname" "func_timer" "target" "relay" }`, true);
  try {
    context.registerCvar("bot_developer", "1");
    game.cvars.set("bot_developer", "1", true);
    context.cvar("bot_developer").update();
    expect(botGetActivateGoal(context, state, 0, new BotActivateGoal())).toBe(0);
    expect(game.prints).toEqual([
      '^1Error: BotGetActivateGoal: no entity with target "relay"\n',
      '^1Error: BotGetActivateGoal: no entity with target "blocked"\n',
      '^1Error: BotGetActivateGoal: no valid activator for entity with target "blocked"\n',
    ]);
  } finally { library.disposeResources(); game.runtime.shutdown(false); }
});

test("OBSTACLEDEBUG prints with bot_developer and com_botDebug disabled", () => {
  const { game, library, context, state } = fixture(obstacle, true);
  try {
    game.cvars.set("com_botDebug", "0");
    expect(context.cvar("bot_developer").integerValue).toBe(0);
    expect(botGetActivateGoal(context, state, 0, new BotActivateGoal())).toBe(0);
    expect(game.prints).toEqual(['^1Error: BotGetActivateGoal: no valid activator for entity with target "blocked"\n']);
  } finally { library.disposeResources(); game.runtime.shutdown(false); }
});

test("OBSTACLEDEBUG does not print the exhaustion diagnostic on an earlier button return", () => {
  const { game, library, context, state } = fixture('{ "classname" "func_button" "model" "*0" "targetname" "button" }', true);
  try {
    const activation = new BotActivateGoal();
    activation.time = 99;
    expect(botGetActivateGoal(context, state, 0, activation)).toBe(0);
    expect(activation.time).toBe(0);
    expect(game.prints).toEqual([]);
  } finally { library.disposeResources(); game.runtime.shutdown(false); }
});
