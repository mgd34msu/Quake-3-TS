import { expect, test } from "bun:test";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";
import { BotCharacterLibrary, Characteristic } from "../src/botlib/character.ts";
import { BotChatLibrary } from "../src/botlib/chat.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import { WeaponAi, WeaponLoadResult } from "../src/botlib/weapons.ts";
import { BotGoalLibrary, GoalError } from "../src/botlib/goals.ts";

function fixture() {
  const files = new Map([
    ["weapons.c", 'projectileinfo { name "bolt" } weaponinfo { number 1 name "Alpha" projectile "bolt" }'],
    ["items.c", 'iteminfo "item_health" { name "Health" modelindex 5 }'],
    ["syn.c", '1 { [("one", 1), ("two", 1)] }'],
    ["rnd.c", 'greeting = { "hello"; }'],
    ["match.c", '1 { "hello", 0 = (1, 0); }'],
    ["rchat.c", '["hello"] = 1 { "hello"; }'],
    ["bots/default_c.c", 'skill 1 { 0 "Default" 1 "it" }'],
    // Inactive string replacements can read #endif and escape the source skip state.
    ["bots/test_c.c", '#ifdef MISSIONPACK\n#define BOT_NAME "Mission"\n#else\n#define BOT_NAME BASE_NAME\n#endif\nskill 1 { 0 BOT_NAME 3 "bots/test_w.c" 21 "bots/test_t.c" 22 "bot" 40 "bots/test_i.c" }'],
    ["bots/test_i.c", '#ifdef MISSIONPACK\n#define ITEM_WEIGHT 21\n#else\n#define ITEM_WEIGHT 7\n#endif\nweight "item_health" return ITEM_WEIGHT;'],
    ["bots/test_w.c", '#ifdef MISSIONPACK\n#define WEAPON_WEIGHT 22\n#else\n#define WEAPON_WEIGHT 8\n#endif\nweight "Alpha" return WEAPON_WEIGHT;'],
    ["bots/test_t.c", '#ifdef MISSIONPACK\n#define GREETING "mission"\n#else\n#define GREETING BASE_GREETING\n#endif\nchat "bot" { type "hello" { GREETING; } }'],
  ]);
  const scripts = new MemoryBotScriptReader(files);
  const globals = scripts.globals;
  const reads = scripts.reads;
  const weights = new WeightConfigStore(scripts);
  const weapons = new WeaponAi({ resolver: scripts, weights });
  const log: string[] = [];
  const goals = new BotGoalLibrary({ resolver: scripts, weightStore: weights, log: { write: text => { log.push(text); } }, clock: () => 0, gameType: () => 0, random: { nextInt: () => 0 } });
  const chat = new BotChatLibrary(scripts, { time: () => 0, random: { nextInt: () => 0 }, *clientCommand(): ReturnType<BotChatLibrary["enterChatCalls"]> {} });
  const characters = new BotCharacterLibrary(scripts);
  return { reads, files, globals, weights, weapons, goals, chat, characters };
}

test("MISSIONPACK is installed before synchronous botlib setup and per-bot source first use", () => {
  const { reads, globals, weights, weapons, goals, chat, characters } = fixture();
  expect(globals.add("MISSIONPACK")).toBe(true);
  // Export_BotLibSetup: weapon config, item config, then chat configs with two synonym/random passes.
  expect(weapons.setup()).toBe(WeaponLoadResult.NoError);
  expect(goals.setup()).toBe(GoalError.None);
  expect(chat.setup()).toBeUndefined();
  expect(reads).toEqual(["weapons.c", "items.c", "syn.c", "syn.c", "rnd.c", "rnd.c", "match.c", "rchat.c"]);
  // BotAISetupClient: character, item weights, weapon weights, then initial chat.
  const character = characters.load("bots/test_c.c", 1);
  expect(characters.string(character, Characteristic.Name)).toBe("Mission");
  const goal = goals.allocGoalState(0), weapon = weapons.allocateState(), state = chat.allocate();
  expect(goals.loadItemWeights(goal, characters.string(character, Characteristic.ItemWeights))).toBe(GoalError.None);
  expect(weapons.loadWeights(weapon, characters.string(character, Characteristic.WeaponWeights))).toBe(WeaponLoadResult.NoError);
  expect(chat.loadChatFile(state, characters.string(character, Characteristic.ChatFile), characters.string(character, Characteristic.ChatName))).toBe(true);
  expect(reads.slice(8)).toEqual(["bots/default_c.c", "bots/test_c.c", "bots/test_i.c", "bots/test_w.c", "bots/test_t.c"]);
  const itemWeights = weights.load("bots/test_i.c");
  expect(itemWeights.evaluate(0, [0])).toBe(21);
  expect(weights.load("bots/test_w.c").evaluate(0, [0])).toBe(22);
  chat.initialChat(state, "hello", 0);
  expect(chat.getChatMessage(state)).toBe("mission");
  const count = reads.length;
  characters.shutdown(); goals.shutdown(); weapons.shutdown(); chat.shutdown();
  expect(weights.load("bots/test_i.c")).toBe(itemWeights);
  expect(reads.length).toBe(count);
  expect(itemWeights.evaluate(0, [0])).toBe(21);
  expect(characters.string(characters.load("bots/test_c.c", 1), Characteristic.Name)).toBe("Mission");
  weights.shutdown();
  expect(() => itemWeights.evaluate(0, [0])).toThrow("has been freed");
  globals.clear();
  expect(weights.load("bots/test_i.c").evaluate(0, [0])).toBe(7);
});

test("a failed later chat setup file retains each earlier published configuration", () => {
  const { chat, files, reads } = fixture();
  files.set("match.c", "malformed");
  chat.setup();
  expect(reads).toEqual(["syn.c", "syn.c", "rnd.c", "rnd.c", "match.c", "rchat.c"]);
  expect(chat.configurationCounts).toEqual({ synonyms: 1, randomLists: 1, matches: 0, replies: 1 });
  expect(chat.diagnostics.filter(issue => issue.code === "load-error").map(issue => issue.source)).toEqual(["match.c"]);
});
