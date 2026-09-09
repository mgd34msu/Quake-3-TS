import { expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { GameAi } from "../src/game/ai-main.ts";
import { BotStateStore } from "../src/game/ai-state.ts";
import { GAME_MEMORY_BYTES, GameMemory } from "../src/game/memory.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { newSpawnString } from "../src/game/spawn.ts";
import { GameType } from "../src/shared/definitions.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

test("G_Alloc prints before failure, aligns the cursor and leaves rejected allocations unchanged", () => {
  const prints: string[] = [];
  const memory = new GameMemory(() => 1, text => { prints.push(text); });
  const first = memory.allocate(1), second = memory.allocate(33);
  expect(first.bytes.byteOffset).toBe(0);
  expect(second.bytes.byteOffset).toBe(32);
  expect(second.bytes.length).toBe(33);
  expect(memory.allocatedBytes).toBe(96);
  memory.allocate(GAME_MEMORY_BYTES - 96);
  expect(memory.allocate(0).bytes.byteOffset).toBe(GAME_MEMORY_BYTES);
  try { memory.allocate(1); throw new Error("Allocation should fail"); }
  catch (error) {
    expect(error).toBeInstanceOf(CommonError);
    if (!(error instanceof CommonError)) throw error;
    expect(error.code).toBe("drop");
    expect(error.message).toBe("G_Alloc: failed on allocation of 1 bytes\n");
  }
  expect(prints.at(-1)).toBe("G_Alloc of 1 bytes (-32 left)\n");
  expect(memory.allocatedBytes).toBe(GAME_MEMORY_BYTES);
  memory.status();
  expect(prints.at(-1)).toBe("Game memory status: 262144 out of 262144 bytes allocated\n");
});

test("G_InitMemory preserves bytes and G_NewString leaves the source escape tail intact", () => {
  const memory = new GameMemory(() => 0, () => {});
  const old = memory.allocate(9);
  old.writeString("abcdefgh");
  memory.initialize();
  expect(memory.allocatedBytes).toBe(0);
  expect(old.readString()).toBe("abcdefgh");
  expect(newSpawnString("x\\", memory)).toBe("x\\cdefgh");
  expect(old.readString()).toBe("x\\cdefgh");
  expect(memory.allocatedBytes).toBe(32);
  memory.initialize();
  expect(newSpawnString("x\\ny", memory)).toBe("x\ny");
  expect(old.bytes.subarray(0, 5)).toEqual(new Uint8Array([120, 10, 121, 0, 101]));
});

test("bot state reservations survive reset and shutdown but count each new source pointer", () => {
  const memory = new GameMemory(() => 0, () => {});
  const states = new BotStateStore("missionpack");
  const state = states.acquire(0, memory);
  expect(state.sourceAllocation?.bytes.length).toBe(9088);
  expect(memory.allocatedBytes).toBe(9088);
  state.resetDecisionState();
  state.clear();
  expect(states.acquire(0, memory)).toBe(state);
  expect(memory.allocatedBytes).toBe(9088);
  for (let client = 1; client < 28; client++) states.acquire(client, memory);
  expect(memory.allocatedBytes).toBe(254464);
  expect(() => states.acquire(28, memory)).toThrow("G_Alloc: failed on allocation of 9088 bytes");
  expect(states.get(28)).toBeNull();
  states.clear();
  expect(states.get(0)).toBeNull();
  expect(memory.allocatedBytes).toBe(254464);
});

test("actual game spawn allocation, game_memory and module replacement use the same source lifetime", () => {
  const bounds = { min: vec3(-128, -128, -128), max: vec3(128, 128, 128) };
  const map: BspMap = { entities: '{ "classname" "worldspawn" } { "classname" "info_null" "message" "first" "message" "last" }',
    entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const game = createGameVerificationHarness({ product: "baseq3", map, gameType: GameType.GT_FFA, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep  8 2026", clientNamePrefix: "Human", botsReason: "Allocator fixture disables botlib",
    additionalCvars: [["g_debugAlloc", "1"]] });
  const memory = game.runtime.memory;
  expect(memory.allocatedBytes).toBe(96);
  expect(game.prints.filter(text => text.startsWith("G_Alloc"))).toEqual([
    "G_Alloc of 10 bytes (262112 left)\n", "G_Alloc of 6 bytes (262080 left)\n", "G_Alloc of 5 bytes (262048 left)\n",
  ]);
  expect(game.runtime.consoleCommand(["game_memory"])).toBe(true);
  expect(game.prints.at(-1)).toBe("Game memory status: 96 out of 262144 bytes allocated\n");
  const unavailable = (): never => { throw new Error("Allocation-before-AAS fixture must not call downstream bot services"); };
  const lines = new AasDebugLines(new BotDebugPolygons(), unavailable);
  const library = new BotLibrary({ assets: unavailable, random: new LinuxNativeRandom(1), print: unavailable, commonPrint: unavailable,
    openLog: unavailable, openWrite: unavailable, milliseconds: unavailable, permanentLine: unavailable,
    movementDebug: lines.movement, clientCommand: unavailable });
  const ai = new GameAi(game.runtime, library, { getSnapshotEntity: unavailable, getConsoleMessage: unavailable,
    userCommand: unavailable, insertConsoleCommand: unavailable, checkBotSpawn: unavailable, loadMap: unavailable });
  try {
    const settings = { characterfile: "bots/sarge_c.c", skill: 4, team: "" };
    expect(ai.setupClient(0, settings, false)).toBe(false);
    expect(game.prints.slice(-2)).toEqual(["G_Alloc of 9088 bytes (252960 left)\n", "^1Fatal: AAS not initialized\n"]);
    expect(ai.setupClient(0, settings, false)).toBe(false);
    expect(memory.allocatedBytes).toBe(9184);
  } finally { library.disposeResources(); }
  const tail = memory.allocate(4); tail.writeString("old");
  game.runtime.shutdown(true);
  const replacement = GameRuntime.create({ ...game.runtime.options, restart: true }, game.owner);
  expect(replacement.memory).not.toBe(memory);
  expect(replacement.memory.allocatedBytes).toBe(96);
  expect(replacement.memory.allocate(4).readString()).toBe("");
  expect(tail.readString()).toBe("old");
  replacement.shutdown(false);
});
