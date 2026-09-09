// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BspMap } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonParseCursor, CommonParseState } from "../src/core/common-parse.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { vec3 } from "../src/core/math.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { GameBotCatalog, parseGameInfos } from "../src/game/bots.ts";
import { GAME_MEMORY_BYTES, GameMemory } from "../src/game/memory.ts";
import type { GameMemoryAllocation } from "../src/game/memory.ts";
import { GameType, Team } from "../src/shared/definitions.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

test("game bot info parser keeps quoted names, duplicate replacement and line-missing values", () => {
  const prints: string[] = [];
  const memory = new GameMemory(() => 0, () => {});
  const allocations: GameMemoryAllocation[] = [];
  expect(parseGameInfos(new CommonParseCursor(`// catalog\n{ name Sarge funname "The Sarge"\nmodel\nname Crash }\n{ name Visor aifile bots/visor_c.c }`),
    1024, new CommonParseState(), text => { prints.push(text); }, memory, allocations)).toBe(2);
  const infos = allocations.map(allocation => allocation.readString());
  expect(infos).toHaveLength(2);
  const first = infos[0], second = infos[1];
  if (first === undefined || second === undefined) throw new Error("Expected two parsed records");
  expect(infoValueForKey(first, "name")).toBe("Crash");
  expect(infoValueForKey(first, "funname")).toBe("The Sarge");
  expect(infoValueForKey(first, "model")).toBe("<NULL>");
  expect(infoValueForKey(second, "aifile")).toBe("bots/visor_c.c");
  expect(prints).toEqual([]);
});

test("game bot parser publishes partial records and checks maximum only after an opening brace", () => {
  const prints: string[] = [];
  const memory = new GameMemory(() => 0, () => {});
  const earlier = memory.allocate(14); earlier.writeString("\\name\\Earlier");
  const infos = [earlier];
  parseGameInfos(new CommonParseCursor("{ name Sarge } { name Visor }"), 1, new CommonParseState(), text => { prints.push(text); }, memory, infos);
  expect(infos.map(allocation => allocation.readString())).toEqual(["\\name\\Earlier", "\\name\\Sarge"]);
  expect(prints).toEqual(["Max infos exceeded\n"]);
  prints.length = 0;
  const partial: GameMemoryAllocation[] = [];
  expect(parseGameInfos(new CommonParseCursor("{ name Sarge"), 1024, new CommonParseState(), text => { prints.push(text); }, memory, partial)).toBe(1);
  expect(partial.map(allocation => allocation.readString())).toEqual(["\\name\\Sarge"]);
  expect(prints).toEqual(["Unexpected end of info file\n"]);
  prints.length = 0;
  expect(parseGameInfos(new CommonParseCursor("broken"), 0, new CommonParseState(), text => { prints.push(text); }, memory, [])).toBe(0);
  expect(prints).toEqual(["Missing { in info file\n"]);
});

test("game catalog parsing retains earlier records when a short-read tail is reached", () => {
  const infos: GameMemoryAllocation[] = [];
  const memory = new GameMemory(() => 0, () => {});
  expect(() => parseGameInfos(new CommonParseCursor("{ name Sarge }\n{ name ", "uninitialized"),
    1024, new CommonParseState(), () => {}, memory, infos)).toThrow("uninitialized short-read tail");
  expect(infos.map(allocation => allocation.readString())).toEqual(["\\name\\Sarge"]);
});

test("game catalog loads real mounted files and generates minplayers commands through actual game imports", async () => {
  const bounds = { min: vec3(-128, -128, -128), max: vec3(128, 128, 128) };
  const map: BspMap = { entities: '{ "classname" "worldspawn" }', entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const game = createGameVerificationHarness({ product: "baseq3", map, gameType: GameType.GT_FFA, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep  7 2026", clientNamePrefix: "Human", botsReason: "Catalog test does not initialize AI" });
  const directory = mkdtempSync(join(tmpdir(), "quake3-game-bots-"));
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" },
    text => { game.prints.push(text); }, sound, game.cvars);
  try {
    mkdirSync(join(directory, "baseq3", "scripts"), { recursive: true });
    writeFileSync(join(directory, "baseq3", "default.cfg"), "fixture\n");
    writeFileSync(join(directory, "baseq3", "scripts", "bots.txt"), '{ name "^1Sarge" aifile bots/sarge_c.c }');
    writeFileSync(join(directory, "baseq3", "scripts", "extra.bot"), '{ name Visor }');
    writeFileSync(join(directory, "baseq3", "scripts", "arenas.txt"), '{ map q3dm1 type single bots "Sarge Visor" }');
    writeFileSync(join(directory, "baseq3", "scripts", "extra.arena"), '{ map q3dm2 }');
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    let allocations = 0;
    const catalog = new GameBotCatalog(game.runtime, files, new CommonParseState(), {
      allocateClient: () => { allocations++; return -1; },
      setupClient: () => { throw new Error("Catalog-only test must not enter AI setup"); },
      shutdownClient: () => { throw new Error("Catalog-only test must not enter AI shutdown"); },
    });
    game.cvars.set("bot_enable", "1", true);
    game.cvars.set("g_spSkill", "3", true);
    catalog.initializeBots(false);
    expect(catalog.numBots).toBe(2); expect(catalog.numArenas).toBe(2);
    expect(game.runtime.memory.allocatedBytes).toBe(192);
    expect(game.runtime.consoleCommand(["game_memory"])).toBe(true);
    expect(game.prints.at(-1)).toBe("Game memory status: 192 out of 262144 bytes allocated\n");
    expect(catalog.getBotInfoByName("visor")).toBe("\\name\\Visor");
    expect(infoValueForKey(catalog.getArenaInfoByMap("Q3DM2") ?? "", "num")).toBe("1");
    catalog.consoleCommand(["addbot", "Visor"]);
    expect(allocations).toBe(0);
    expect(game.prints).toContain("^1Error: bot has no aifile specified\n");
    catalog.consoleCommand(["addbot", "^1Sarge", "2"]);
    expect(allocations).toBe(1);
    expect(game.prints).toContain("^1Unable to add bot.  All player slots are in use.\n");
    game.cvars.set("bot_minplayers", "1", true);
    const before = game.consoleCommands.length;
    game.runtime.level.time = 9999;
    catalog.checkMinimumPlayers();
    expect(game.consoleCommands).toHaveLength(before);
    game.runtime.level.time = 10000;
    catalog.checkMinimumPlayers();
    expect(game.consoleCommands.slice(before)).toEqual(["insert:addbot Sarge 3.000000  0\n"]);
    expect(catalog.countBotPlayers(Team.TEAM_FREE)).toBe(0);
    catalog.checkMinimumPlayers();
    expect(game.consoleCommands).toHaveLength(before + 1);
    writeFileSync(join(directory, "baseq3", "scripts", "extra.bot"), '{ name Visor } { name Crash }');
    const memory = game.runtime.memory;
    memory.allocate(GAME_MEMORY_BYTES - memory.allocatedBytes - 96);
    const retained = memory.allocate(0);
    expect(() => catalog.initializeBots(false)).toThrow("G_Alloc: failed on allocation");
    expect(catalog.numBots).toBe(1);
    expect(catalog.getBotInfoByName("Visor")).toBeNull();
    expect(catalog.getBotInfoByNumber(1)).toBeNull();
    expect(retained.readString()).toBe("\\aifile\\bots/sarge_c.c\\name\\^1Sarge");
    expect(String.fromCharCode(...new Uint8Array(retained.bytes.buffer, retained.bytes.byteOffset + 64, 11))).toBe("\\name\\Visor");
    expect(memory.allocatedBytes).toBe(GAME_MEMORY_BYTES);
    memory.initialize();
    writeFileSync(join(directory, "baseq3", "scripts", "extra.bot"), '{ name Crash }');
    catalog.initializeBots(false);
    expect(catalog.numBots).toBe(2);
    expect(catalog.getBotInfoByName("Visor")).toBeNull();
    expect(catalog.getBotInfoByName("Crash")).toBe("\\name\\Crash");
  } finally {
    game.runtime.shutdown(false);
    files.close(); sound.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("single-player bot spawning clears all retained podium players, while restart preserves them", async () => {
  const bounds = { min: vec3(-128, -128, -128), max: vec3(128, 128, 128) };
  const map: BspMap = { entities: '{ "classname" "worldspawn" }', entityRecords: [], shaders: [], planes: [], nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
  const game = createGameVerificationHarness({ product: "baseq3", map, gameType: GameType.GT_SINGLE_PLAYER, levelTime: 1000,
    randomSeed: 42, buildDate: "Sep  9 2026", clientNamePrefix: "Human", botsReason: "Catalog test does not initialize AI" });
  const directory = mkdtempSync(join(tmpdir(), "quake3-game-bot-podium-"));
  const sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: directory, homePath: directory, cdPath: null, product: "baseq3" },
    text => { game.prints.push(text); }, sound, game.cvars);
  try {
    mkdirSync(join(directory, "baseq3", "scripts"), { recursive: true });
    writeFileSync(join(directory, "baseq3", "default.cfg"), "fixture\n");
    writeFileSync(join(directory, "baseq3", "scripts", "arenas.txt"), '{ map q3dm1 bots "Sarge Visor" special training }');
    await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
    game.cvars.register("mapname", "q3dm1", CvarFlag.ServerInfo);
    game.cvars.set("g_spSkill", "0", true);
    const catalog = new GameBotCatalog(game.runtime, files, new CommonParseState(), {
      allocateClient: () => { throw new Error("Queued bot commands must not allocate clients yet"); },
      setupClient: () => { throw new Error("Catalog test must not enter AI setup"); },
      shutdownClient: () => { throw new Error("Catalog test must not enter AI shutdown"); },
    });
    game.runtime.level.numNonSpectatorClients = 3;
    game.runtime.level.sortedClients[0] = 0;
    game.runtime.level.sortedClients[1] = 1;
    game.runtime.level.sortedClients[2] = 2;
    const firstSlot = game.runtime.pool.numEntities;
    game.runtime.arenas.spawnModelsOnVictoryPads();
    const podium = game.runtime.pool.at(firstSlot);
    const players = [game.runtime.pool.at(firstSlot + 1), game.runtime.pool.at(firstSlot + 2), game.runtime.pool.at(firstSlot + 3)];
    const winner = game.runtime.pool.at(firstSlot + 1);
    const originalOrigins = players.map(player => player.r.currentOrigin);
    const movePodium = (): void => {
      if (podium.think === null) throw new Error("Podium must retain its placement callback");
      podium.think(podium);
    };

    catalog.initializeBots(true);
    expect(game.consoleCommands).toEqual([]);
    expect(game.cvars.get("g_spSkill")?.value).toBe("0");
    game.runtime.level.intermissionOrigin = vec3(50, 100, 150);
    movePodium();
    for (let index = 0; index < players.length; index++) {
      expect(players[index]?.r.currentOrigin).not.toEqual(originalOrigins[index]);
    }
    game.runtime.arenas.abortPodium();
    expect(winner.nextthink).toBe(1000);
    winner.nextthink = 7777;
    const retainedOrigins = players.map(player => player.r.currentOrigin);
    const retainedThink = winner.think;

    catalog.initializeBots(false);
    expect(game.consoleCommands).toEqual(["insert:addbot Sarge 1.000000 free 12000\n", "insert:addbot Visor 1.000000 free 13500\n"]);
    expect(game.cvars.get("g_spSkill")?.value).toBe("1");
    game.runtime.level.intermissionOrigin = vec3(500, 1000, 1500);
    movePodium();
    expect(players.map(player => player.r.currentOrigin)).toEqual(retainedOrigins);
    game.runtime.arenas.abortPodium();
    expect(winner.nextthink).toBe(7777);
    expect(winner.think).toBe(retainedThink);
    expect(players.every(player => player.inuse)).toBe(true);
  } finally {
    game.runtime.shutdown(false);
    files.close(); sound.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
