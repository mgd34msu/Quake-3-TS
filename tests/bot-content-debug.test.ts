import { expect, test } from "bun:test";
import { BotCharacterLibrary } from "../src/botlib/character.ts";
import { BotChatLibrary, type BotChatHost } from "../src/botlib/chat.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import { WeaponAi, WeaponLoadResult } from "../src/botlib/weapons.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";
import { BotGoalLibrary, type GoalWorldHost } from "../src/botlib/goals.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { AasSpatial, BotBrushModelTypes, type AasSpatialHost } from "../src/botlib/spatial.ts";
import { AasRouting } from "../src/botlib/routing.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { vec3 } from "../src/core/math.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { BotLog } from "../src/botlib/log.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";

test("DEBUG weight timing starts before cache lookup and ends only at developer success", () => {
  const reader = new MemoryBotScriptReader(new Map([["weights.c", 'weight "a" { return 2; }']]));
  const events: string[] = [];
  let time = 10, developer = true;
  const store = new WeightConfigStore(reader, {
    debug: { milliseconds: () => { events.push("clock"); return time++; }, developer: () => developer },
    print: (_severity, text) => { events.push(text); },
  });
  store.load("weights.c");
  expect(events).toEqual(["clock", "loaded weights.c\n", "clock", "weights loaded in 1 msec\n"]);
  events.length = 0;
  store.load("weights.c");
  expect(events).toEqual(["clock"]);
  events.length = 0;
  developer = false;
  store.shutdown();
  store.load("weights.c");
  expect(events).toEqual(["clock", "loaded weights.c\n"]);
  events.length = 0;
  expect(() => store.load("missing.c")).toThrow();
  expect(events).toEqual(["clock", "counldn't load missing.c\n"]);
});

test("DEBUG character success timing follows loaded prints while cached calls only start", () => {
  const reader = new MemoryBotScriptReader(new Map([
    ["bots/default_c.c", "skill 1 { 0 1 }"], ["bot.c", "skill 1 { 0 3 }"],
  ]));
  const events: string[] = [];
  let time = 0;
  const library = new BotCharacterLibrary(reader, {
    debug: { milliseconds: () => { events.push("clock"); return time++; }, developer: () => true },
    report: diagnostic => { events.push(diagnostic.message); },
  });
  expect(library.load("bot.c", 1)).toBeGreaterThan(0);
  expect(events).toEqual([
    "clock", "loaded skill 1 from bots/default_c.c", "clock", "skill 1 loaded in 1 msec from bots/default_c.c",
    "clock", "loaded skill 1 from bot.c", "clock", "skill 1 loaded in 1 msec from bot.c",
  ]);
  events.length = 0;
  library.load("bot.c", 1);
  expect(events).toEqual(["clock", "loaded cached skill 1.000000 from bots/default_c.c", "clock", "loaded cached skill 1.000000 from bot.c"]);
});

function chatFixture(debug: boolean) {
  const reader = new MemoryBotScriptReader(new Map([
    ["syn.c", ""], ["rnd.c", 'hello = { "hello"; }'], ["match.c", ""], ["rchat.c", ""],
    ["chat.c", 'chat "bot" { type "hello" { "hello"; } type "empty" {} }'],
  ]));
  const events: string[] = [];
  let samples = 0;
  const host: BotChatHost = {
    random: { nextInt: () => 0 }, time: () => 0,
    *clientCommand(): CallSteps {}, report: diagnostic => { events.push(diagnostic.message); },
  };
  const library = new BotChatLibrary(reader, host, {
    maxMessages: 2, noChat: () => true,
    ...(debug ? { debug: { milliseconds: () => { events.push("clock"); return samples++; } } } : {}),
  });
  return { library, events, samples: () => samples };
}

test("DEBUG chat setup nests random timing and initial loading excludes cache reuse", () => {
  const { library, events, samples } = chatFixture(true);
  library.setup();
  expect(events).toEqual([
    "clock", "loaded syn.c", "clock", "loaded rnd.c", "clock", "random strings 1 msec", "loaded match.c",
    "clock", "setup chat AI 3 msec",
  ]);
  events.length = 0;
  const handle = library.allocate();
  expect(library.loadChatFile(handle, "chat.c", "bot")).toBe(true);
  expect(events).toEqual(["clock", "loaded bot from chat.c", "clock", "initial chats loaded in 1 msec"]);
  events.length = 0;
  expect(library.loadChatFile(handle, "chat.c", "bot")).toBe(true);
  expect(events).toEqual([]);
  expect(samples()).toBe(6);
});

test("DEBUG missing initial chat messages requires a loaded chat and preserves release silence", () => {
  for (const debug of [false, true]) {
    const { library, events, samples } = chatFixture(debug);
    const handle = library.allocate();
    library.initialChat(handle, "missing", 0);
    expect(events).toEqual([]);
    expect(library.loadChatFile(handle, "chat.c", "bot")).toBe(true);
    events.length = 0;
    library.initialChat(handle, "missing", 0);
    library.initialChat(handle, "empty", 0);
    expect(events).toEqual(debug ? ["no chat messages of type missing", "no chat messages of type empty"] : []);
    expect(samples()).toBe(debug ? 2 : 0);
  }
});

test("DEBUG_AI_WEAP writes complete projectile then every weapon slot and flushes each structure", () => {
  const reader = new MemoryBotScriptReader(new Map([["weapons.c", `
    projectileinfo { name "shot" model "projectile.md3" gravity 0.5 damage 20 }
    weaponinfo { number 1 name "gun" model "gun.md3" projectile "shot" recoil { 1, 2, 3 } }
  `]]));
  const writes: string[] = [], records: string[] = [];
  const weights = new WeightConfigStore(reader);
  const ai = new WeaponAi({ resolver: reader, weights }, {
    maxWeaponInfo: 2,
    debug: { log: { filePointer: () => ({ write: text => { writes.push(text); } }), flush: () => { records.push(writes.join("")); writes.length = 0; } } },
  });
  expect(ai.setup("weapons.c")).toBe(WeaponLoadResult.NoError);
  expect(records).toEqual([
    '{\r\n\tname\t"shot"\r\n\tmodel\t"projectile.md3"\r\n\tflags\t0\r\n\tgravity\t0.5\r\n\tdamage\t20\r\n\tradius\t0\r\n\tvisdamage\t0\r\n\tdamagetype\t0\r\n\thealthinc\t0\r\n\tpush\t0\r\n\tdetonation\t0\r\n\tbounce\t0\r\n\tbouncefric\t0\r\n\tbouncestop\t0\r\n}\r\n',
    '{\r\n\tnumber\t0\r\n\tname\t""\r\n\tlevel\t0\r\n\tmodel\t""\r\n\tweaponindex\t0\r\n\tflags\t0\r\n\tprojectile\t""\r\n\tnumprojectiles\t0\r\n\thspread\t0\r\n\tvspread\t0\r\n\tspeed\t0\r\n\tacceleration\t0\r\n\trecoil\t{0,0,0}\r\n\toffset\t{0,0,0}\r\n\tangleoffset\t{0,0,0}\r\n\textrazvelocity\t0\r\n\tammoamount\t0\r\n\tammoindex\t0\r\n\tactivate\t0\r\n\treload\t0\r\n\tspinup\t0\r\n\tspindown\t0\r\n}\r\n',
    '{\r\n\tnumber\t1\r\n\tname\t"gun"\r\n\tlevel\t0\r\n\tmodel\t"gun.md3"\r\n\tweaponindex\t0\r\n\tflags\t0\r\n\tprojectile\t"shot"\r\n\tnumprojectiles\t0\r\n\thspread\t0\r\n\tvspread\t0\r\n\tspeed\t0\r\n\tacceleration\t0\r\n\trecoil\t{1,2,3}\r\n\toffset\t{0,0,0}\r\n\tangleoffset\t{0,0,0}\r\n\textrazvelocity\t0\r\n\tammoamount\t0\r\n\tammoindex\t0\r\n\tactivate\t0\r\n\treload\t0\r\n\tspinup\t0\r\n\tspindown\t0\r\n}\r\n',
  ]);
  expect(writes).toEqual([]);
});

test("DEBUG goal linking logs only the newly associated existing level item", () => {
  for (const debug of [false, true]) {
    const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
    const origin = vec3(100, 0, 20);
    const world: AasWorld = {
      source: "debug-goal", version: 5, bspChecksum: 0, vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
      planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }],
      nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -1] }],
      areas: [0, 1].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: origin })),
      areaSettings: [0, 1].map(() => ({ contents: 0, flags: 1, presenceType: 6, cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 })),
      reachability: [], portals: [], portalIndex: [], clusters: [], bboxes: [],
      pointArea: () => 1, areaBounds: () => bounds, areaReachabilities: () => [],
    };
    const bspEntities = new AasBspEntities(() => {});
    bspEntities.load('{ "classname" "item_health" "origin" "100 0 20" "spawnflags" "1" }');
    const host: GoalWorldHost & AasSpatialHost = {
      print: () => {}, pointContents: () => 32,
      trace: (_start, end) => ({ fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 }),
      entityTrace: (_entity, _start, end) => ({ fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 }),
      entityModelIndex: () => 5, modelBounds: () => ({ bounds, origin }),
      nextEntity: after => after === 0 ? 1 : 0,
      entityInfo: () => ({ type: 2, modelIndex: 5, origin, lastVisibleOrigin: origin, lastUpdateTime: 0 }),
    };
    const links = new AasLinkHeap(() => {});
    links.initialize(() => 16);
    const spatial = new AasSpatial(world, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
    const reader = new MemoryBotScriptReader(new Map([["items.c", 'iteminfo "item_health" { modelindex 5 }']]));
    const logs: string[] = [];
    const library = new BotGoalLibrary({ resolver: reader, weightStore: new WeightConfigStore(reader), debug,
      log: { write: text => { logs.push(text); } }, clock: () => 0, random: { nextInt: () => 0 }, gameType: () => 0 });
    expect(library.setup()).toBe(0);
    library.initLevelItems({ bspEntities, host, pointArea: () => 1, navigation: { spatial, routing: new AasRouting(world) } });
    logs.length = 0;
    library.updateEntityItems();
    library.updateEntityItems();
    expect(logs).toEqual(debug ? ["linked item item_health to an entity"] : []);
  }
});

test("DEBUG_AI_WEAP stops each structure at the real log write failure then flushes", () => {
  const variables = new BotLibVars();
  variables.set("log", "1");
  let failing = false, flushes = 0;
  const attempted: string[] = [];
  const log = new BotLog({ variables, globals: { time: 0 }, print: () => undefined,
    openFile: () => ({ kind: "opened", stream: {
      write: bytes => {
        attempted.push(Buffer.from(bytes).toString("latin1"));
        return failing ? { kind: "failed", error: new Error("full") } : { kind: "ok" };
      }, flush: () => { flushes++; return { kind: "ok" }; }, close: () => ({ kind: "ok" }),
    } }),
  });
  log.open("debug.log");
  const file = log.filePointer();
  if (file === null) throw new Error("missing open log");
  expect(file.write("abc")).toBe(3);
  failing = true;
  expect(file.write("failure")).toBe(-1);
  attempted.length = 0;
  const reader = new MemoryBotScriptReader(new Map([["weapons.c", 'projectileinfo { name "shot" }']]));
  const ai = new WeaponAi({ resolver: reader, weights: new WeightConfigStore(reader) }, { maxWeaponInfo: 2, debug: { log } });
  expect(ai.setup()).toBe(WeaponLoadResult.NoError);
  expect(attempted).toEqual(["{\r\n", "{\r\n", "{\r\n"]);
  expect(flushes).toBe(3);
  log.close();
});
