// Authored cases for sv_game.c goal traps and be_ai_goal.c pointer gates.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import type { AasWorld } from "../src/botlib/aas.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { BotGoalLibrary, GoalFlags } from "../src/botlib/goals.ts";
import type { BotGoal, GoalEntityInfo, GoalWorldHost } from "../src/botlib/goals.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { BotLog } from "../src/botlib/log.ts";
import { AasRouting, TravelFlags } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import type { AasBspTrace, AasSpatialHost } from "../src/botlib/spatial.ts";
import { WeightConfigStore } from "../src/botlib/weights.ts";
import { BinaryError } from "../src/core/binary.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { QVM_BOT_GOAL_BYTES, copyQvmBotGoal, readQvmBotGoal, writeQvmBotGoal } from "../src/vm/bot-goal-record.ts";
import { qvmBotGoalSyscall } from "../src/vm/bot-goal-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { MemoryBotScriptReader } from "./helpers/bot-script-reader.ts";

const ITEM_SOURCE = 'iteminfo "item_health" { name "Health" modelindex 5 respawntime 35 mins {-15,-15,-15} maxs {15,15,15} }';
const WEIGHT_SOURCE = 'weight "item_health" { return 10; }';
const ITEM_MAP = '{ "classname" "item_health" "origin" "100 0 20" }\n{ "classname" "item_health" "origin" "200 0 20" }';

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing authored goal fixture value");
  return value;
}

function goal(number = 7): BotGoal {
  return { origin: vec3(100, 2, 3), area: 1, mins: vec3(-1, -2, -3), maxs: vec3(1, 2, 3), entity: 7, number, flags: 1, itemInfo: 9 };
}

function putVector(memory: QvmMemory, pointer: number, value: Vec3): void {
  const view = memory.view(pointer, 12);
  view.setFloat32(0, value.x, true);
  view.setFloat32(4, value.y, true);
  view.setFloat32(8, value.z, true);
}

function clearTrace(end: Vec3): AasBspTrace {
  return { fraction: 1, end, solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 1023 };
}

function authoredAas(): AasWorld {
  const bounds = { min: vec3(-1000, -1000, -1000), max: vec3(1000, 1000, 1000) };
  const reachability = [0, 1, 2].map(index => ({
    area: index === 0 ? 0 : index === 1 ? 2 : 1, face: 0, edge: 0,
    start: vec3(0, 0, 0), end: vec3(0, 0, 0), travelType: 2, travelTime: 100, padding: 0,
  }));
  return {
    source: "authored-qvm-goals", version: 5, bspChecksum: 0, vertices: [],
    planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    areas: [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: vec3(areaNumber === 1 ? 100 : -100, 0, 20) })),
    areaSettings: [0, 1, 2].map(index => ({ contents: 0, flags: 1, presenceType: 6, cluster: index === 0 ? 0 : 1,
      clusterAreaNumber: index === 0 ? 0 : index - 1, reachableAreaCount: index === 0 ? 0 : 1, firstReachableArea: index })),
    reachability, nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -2] }], portals: [], portalIndex: [],
    clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 },
      { areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 }], bboxes: [],
    pointArea: point => point.x > 0 ? 1 : 2, areaBounds: () => bounds,
    areaReachabilities: area => area === 0 ? [] : [required(reachability[area])],
  };
}

function fixture() {
  const resolver = new MemoryBotScriptReader(new Map([["items.c", ITEM_SOURCE], ["weights.c", WEIGHT_SOURCE]]));
  const memory = new QvmMemory(new Uint8Array(4096).fill(0xa5));
  const runtime = { time: 1, flushes: 0, blocked: false, beforeTrace: (): void => {}, beforeRandom: (): void => {}, beforeClock: (): void => {}, beforeLog: (): void => {},
    beforeWeightPrint: (_text: string): void => {}, beforeGoalReport: (_text: string): void => {} };
  const logged: string[] = [], printed: string[] = [];
  const variables = new BotLibVars();
  variables.set("log", "1");
  const log = new BotLog({ variables, globals: runtime, print: (_severity, text) => { printed.push(text); return undefined; },
    openFile: () => ({ kind: "opened", stream: {
      write: bytes => { logged.push(Array.from(bytes, byte => String.fromCharCode(byte)).join("")); runtime.beforeLog(); return { kind: "ok" }; },
      flush: () => { runtime.flushes++; return { kind: "ok" }; }, close: () => ({ kind: "ok" }),
    } }),
  });
  log.open("authored.log");
  const store = new WeightConfigStore(resolver, { reloadCharacters: true,
    print: (_severity, text) => { printed.push(text); runtime.beforeWeightPrint(text); return undefined; } });
  const goals = new BotGoalLibrary({ resolver, weightStore: store, log, gameType: () => 0,
    clock: () => { runtime.beforeClock(); return runtime.time; },
    random: { nextInt: () => { runtime.beforeRandom(); return 0; } },
    report: diagnostic => { printed.push(diagnostic.message); runtime.beforeGoalReport(diagnostic.message); return undefined; },
  });
  const entities = new Map<number, GoalEntityInfo>(), traces: { readonly start: Vec3; readonly end: Vec3; readonly viewer: number }[] = [];
  const aas = authoredAas();
  const host: AasSpatialHost & GoalWorldHost = {
    print: text => { printed.push(text); },
    trace: (start, end, bounds, viewer) => {
      traces.push({ start: vec3(start.x, start.y, start.z), end: vec3(end.x, end.y, end.z), viewer });
      runtime.beforeTrace();
      return bounds === null ? { ...clearTrace(end), fraction: runtime.blocked ? 0.5 : 1 }
        : { ...clearTrace(vec3(end.x, end.y, 15)), fraction: 0.5, entityNum: 1022 };
    },
    pointContents: () => 0,
    entityTrace: (_entity, _start, end) => clearTrace(end),
    entityModelIndex: number => entities.get(number)?.modelIndex ?? 0,
    modelBounds: () => ({ bounds: { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) }, origin: vec3(0, 0, 0) }),
    nextEntity: after => [...entities.keys()].sort((first, second) => first - second).find(number => number > after) ?? 0,
    entityInfo: number => required(entities.get(number)),
  };
  const bspEntities = new AasBspEntities((_severity, text) => { printed.push(text); });
  bspEntities.load("");
  const links = new AasLinkHeap(() => { throw new Error("authored AAS link allocation exhausted"); });
  links.initialize(() => 6144);
  const spatial = new AasSpatial(aas, bspEntities, host, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
  const routing = new AasRouting(aas);
  routing.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 0);
  const world = { bspEntities, navigation: { spatial, routing }, host, pointArea: (point: Vec3) => aas.pointArea(point) };
  const call = (argumentsView: DataView): number | null => qvmBotGoalSyscall("game", argumentsView, memory, goals);
  const map = (source: string): void => { bspEntities.load(source); goals.initLevelItems(world); };
  const entity = (number: number, x: number, lastUpdateTime = 0): void => {
    const origin = vec3(x, 0, 15);
    entities.set(number, { type: 2, modelIndex: 5, origin, lastVisibleOrigin: origin, lastUpdateTime });
  };
  const load = (): number => {
    expect(goals.setup()).toBe(0);
    const handle = required(call(words(546, 3)));
    memory.writeString(64, "weights.c", 10);
    expect(call(words(543, handle, 64))).toBe(0);
    putVector(memory, 32, vec3(50, 0, 20));
    memory.view(1024, 1024).setInt32(0, 0, true);
    return handle;
  };
  return { resolver, memory, runtime, goals, store, variables, log, logged, printed, entities, traces, bspEntities, world, call, map, entity, load };
}

describe("QVM bot goal record", () => {
  test("reads exact field offsets and writes binary32 vectors and signed integer words", () => {
    const bytes = new Uint8Array(64).fill(0xa5), view = new DataView(bytes.buffer, 4, 56);
    const floats: readonly (readonly [number, number])[] = [[0, 0.1], [4, -0], [8, 16777217], [16, -1], [20, -2], [24, -3], [28, 1], [32, 2], [36, 3]];
    for (const [offset, value] of floats) view.setFloat32(offset, value, true);
    const integers: readonly (readonly [number, number])[] = [[12, -2147483648], [40, -1], [44, 2147483647], [48, -2147483647], [52, 123456789]];
    for (const [offset, value] of integers) view.setInt32(offset, value, true);
    const decoded = readQvmBotGoal(view);
    expect(QVM_BOT_GOAL_BYTES).toBe(56);
    expect(decoded).toEqual({ origin: vec3(Math.fround(0.1), -0, 16777216), area: -2147483648,
      mins: vec3(-1, -2, -3), maxs: vec3(1, 2, 3), entity: -1, number: 2147483647, flags: -2147483647, itemInfo: 123456789 });
    const written = new Uint8Array(64).fill(0xa5);
    writeQvmBotGoal(new DataView(written.buffer, 4, 56), decoded);
    expect(written).toEqual(bytes);
    view.setFloat32(0, 99, true);
    expect(decoded.origin.x).toBe(Math.fround(0.1));
  });

  test("checks reached extents before mutation and leaves query-specific tails untouched", () => {
    const bytes = new Uint8Array(64).fill(0xa5), before = bytes.slice();
    for (const length of [0, 12, 55]) {
      expect(() => readQvmBotGoal(new DataView(bytes.buffer, 0, length))).toThrow(BinaryError);
      expect(() => writeQvmBotGoal(new DataView(bytes.buffer, 0, length), goal())).toThrow(BinaryError);
      expect(bytes).toEqual(before);
    }
    expect(() => writeQvmBotGoal(new DataView(bytes.buffer, 0, 43), goal(), "location")).toThrow(BinaryError);
    expect(() => writeQvmBotGoal(new DataView(bytes.buffer, 0, 51), goal(), "level-item")).toThrow(BinaryError);
    writeQvmBotGoal(new DataView(bytes.buffer, 0, 44), goal(), "location");
    expect(bytes.subarray(44)).toEqual(before.subarray(44));
    writeQvmBotGoal(new DataView(bytes.buffer, 0, 52), goal(), "level-item");
    expect(bytes.subarray(52)).toEqual(before.subarray(52));
  });

  test("raw goal copy checks both record extents without touching destination tails", () => {
    const source = new Uint8Array(60).fill(0x7f), destination = new Uint8Array(64).fill(0xa5);
    const output = new DataView(destination.buffer, 4, 60), before = destination.slice();
    expect(() => copyQvmBotGoal(output, source.subarray(0, 55))).toThrow(BinaryError);
    expect(() => copyQvmBotGoal(new DataView(destination.buffer, 4, 55), source)).toThrow(BinaryError);
    expect(destination).toEqual(before);
    copyQvmBotGoal(output, source);
    expect(destination.slice(4, 60)).toEqual(source.slice(0, 56));
    expect(destination.slice(0, 4)).toEqual(before.slice(0, 4));
    expect(destination.slice(60)).toEqual(before.slice(60));
  });
});

describe("QVM game bot goal traps", () => {
  test("stack memcpy preserves every raw word through push, top, second and pop", () => {
    const { goals, memory, call } = fixture(), handle = goals.allocGoalState(0);
    const pattern = [0x7f800001, 0xff800123, 0x7fc45678, 0x80000000, 0x00000001, 0x007fffff,
      0x7f800000, 0xff800000, 0x80000001, 0xdeadbeef, 0x76543210, 0xffffffff, 0x80000000, 0x12345678];
    const input = memory.view(128, QVM_BOT_GOAL_BYTES);
    pattern.forEach((word, index) => input.setUint32(index * 4, word, true));
    const expected = memory.bytes.slice(128, 184);
    expect(call(words(527, handle, 128))).toBe(0);
    memory.bytes.fill(0, 128, 184);
    expect(call(words(533, handle, 256))).toBe(1);
    expect(memory.bytes.slice(256, 312)).toEqual(expected);
    // Typed observation is not allowed to replace the retained bytes.
    expect(goals.getTopGoal(handle)?.origin.x).toBeNaN();
    goals.pushGoal(handle, goal(21));
    expect(call(words(534, handle, 320))).toBe(1);
    expect(memory.bytes.slice(320, 376)).toEqual(expected);
    expect(call(words(528, handle))).toBe(0);
    expect(call(words(533, handle, 384))).toBe(1);
    expect(memory.bytes.slice(384, 440)).toEqual(expected);
    const retained = required(goals.getTopGoalBytes(handle));
    new DataView(retained.buffer, retained.byteOffset, retained.byteLength).setUint32(0, 0xff800789, true);
    expect(call(words(533, handle, 448))).toBe(1);
    expect(memory.view(448, 4).getUint32(0, true)).toBe(0xff800789);
  });

  test("failed lazy push advances the stack but retains the previous cell bytes", () => {
    const { goals, memory, call } = fixture(), handle = goals.allocGoalState(0);
    memory.bytes.fill(0x5a, 128, 184);
    expect(call(words(527, handle, 128))).toBe(0);
    expect(call(words(528, handle))).toBe(0);
    expect(() => call(words(527, handle, 4092))).toThrow(RangeError);
    expect(call(words(533, handle, 256))).toBe(1);
    expect(memory.bytes.slice(256, 312)).toEqual(new Uint8Array(56).fill(0x5a));
    const before = memory.bytes.slice();
    expect(() => call(words(533, handle, 4092))).toThrow(RangeError);
    expect(memory.bytes).toEqual(before);
  });

  test("gates roles before words and unhandled traps before arguments", () => {
    const { goals, memory, call } = fixture(), empty = new DataView(new ArrayBuffer(0));
    expect(qvmBotGoalSyscall("ui", empty, memory, goals)).toBeNull();
    expect(qvmBotGoalSyscall("cgame", empty, memory, goals)).toBeNull();
    for (const trap of [-1, 0, 524, 545, 548, 564, 565, 566, 569, 570, 572, 574]) expect(call(words(trap))).toBeNull();
    expect(goals.diagnostics).toEqual([]);
  });

  test("shares allocation, full goal copies, stack order and retirement with typed callers", () => {
    const { goals, memory, call } = fixture();
    const handle = required(call(words(546, -2147483648)));
    expect(handle).toBe(1);
    writeQvmBotGoal(memory.view(128, 56), goal(20));
    expect(call(words(527, handle, 128 - 4096))).toBe(0);
    memory.view(128, 56).setInt32(44, 90, true);
    goals.pushGoal(handle, goal(21));
    expect(call(words(533, handle, 4096))).toBe(1);
    expect(readQvmBotGoal(memory.view(4096, 56))).toEqual(goal(21));
    expect(call(words(534, handle, 256))).toBe(1);
    expect(readQvmBotGoal(memory.view(256, 56))).toEqual(goal(20));
    expect(call(words(528, handle))).toBe(0);
    expect(goals.getTopGoal(handle)).toEqual(goal(20));
    expect(call(words(529, handle))).toBe(0);
    expect(goals.getTopGoal(handle)).toBeNull();
    for (let next = 2; next <= 64; next++) expect(call(words(546, next))).toBe(next);
    expect(call(words(546, 65))).toBe(0);
    expect(call(words(547, handle))).toBe(0);
    expect(goals.allocGoalState(9)).toBe(handle);
    goals.freeGoalState(handle);
    expect(call(words(533, handle, 0))).toBe(0);
  });

  test("empty, invalid and exhausted goal queries leave destinations unread and untouched", () => {
    const { goals, memory, call } = fixture(), handle = goals.allocGoalState(0), before = memory.bytes.slice();
    for (const state of [handle, 0, -1, 65]) {
      for (const trap of [533, 534]) expect(call(words(trap, state, 0))).toBe(0);
    }
    expect(call(words(539, -1, 0, 0))).toBe(-1);
    expect(call(words(567, -1, 0))).toBe(0);
    expect(call(words(568, 0, 0))).toBe(0);
    expect(call(words(532, 1, 0, -1))).toBe(0);
    expect(memory.bytes).toEqual(before);
  });

  test("push ignores unused pointers after handle and capacity gates and dumps overflow in source order", () => {
    const { goals, memory, call, logged, printed } = fixture();
    goals.setup();
    const handle = goals.allocGoalState(0);
    expect(call(words(527, -1, 0))).toBe(0);
    for (let index = 1; index <= 7; index++) goals.pushGoal(handle, goal(index));
    const before = memory.bytes.slice();
    expect(call(words(527, handle, 0))).toBe(0);
    expect(printed.at(-1)).toBe("goal heap overflow\n");
    expect(logged).toEqual(["1: ", "2: ", "3: ", "4: ", "5: ", "6: ", "7: "]);
    expect(goals.getTopGoal(handle)?.number).toBe(7);
    expect(memory.bytes).toEqual(before);
    goals.popGoal(handle);
    expect(() => call(words(527, handle, 4092))).toThrow(RangeError);
    expect(() => call(words(533, handle, 4092))).toThrow(RangeError);
    expect(memory.bytes).toEqual(before);
  });

  test("preserves float-word avoidance, default respawn time and reset distinctions", () => {
    const { goals, runtime, call, map, load } = fixture(), handle = load();
    map(ITEM_MAP);
    goals.pushGoal(handle, goal());
    expect(call(words(573, handle, 1, 0xbf800000))).toBe(0);
    expect(call(words(540, handle, 1))).toBe(float32ToBits(35));
    expect(call(words(573, handle, 2, 0x3fa00000))).toBe(0);
    expect(call(words(540, handle, 2))).toBe(0x3fa00000);
    runtime.time = 2.25;
    expect(call(words(540, handle, 2))).toBe(0);
    expect(call(words(571, handle, 1))).toBe(0);
    expect(call(words(540, handle, 1))).toBe(0);
    call(words(573, handle, 1, 0x3f800000));
    expect(call(words(526, handle))).toBe(0);
    expect(goals.getTopGoal(handle)?.number).toBe(7);
    expect(goals.avoidGoalTime(handle, 1)).toBe(0);
    expect(call(words(525, handle))).toBe(0);
    expect(goals.getTopGoal(handle)).toBeNull();
  });

  test("dump traps reach the actual logger without adding line endings", () => {
    const { goals, runtime, call, map, load, logged, log } = fixture(), handle = load();
    map(ITEM_MAP);
    goals.pushGoal(handle, goal(1));
    goals.setAvoidGoalTime(handle, 1, 2.5);
    expect(call(words(531, handle))).toBe(0);
    expect(call(words(530, handle))).toBe(0);
    expect(logged).toEqual(["1: Health", "avoid goal Health, number 1 for 2.500000 seconds"]);
    expect(runtime.flushes).toBe(2);
    log.close();
    call(words(531, handle));
    expect(logged).toHaveLength(2);
  });

  test("avoid dumping formats source float ties and observes each intervening log callback", () => {
    const { goals, runtime, call, logged } = fixture();
    goals.setup();
    const handle = goals.allocGoalState(0);
    goals.setAvoidGoalTime(handle, 1, 0.0078125);
    goals.setAvoidGoalTime(handle, 2, 0.0078125);
    runtime.beforeLog = () => { runtime.time = 2; };
    call(words(530, handle));
    expect(logged).toEqual(["avoid goal , number 1 for 0.007812 seconds"]);
    runtime.beforeLog = () => {};
    goals.resetAvoidGoals(handle);
    runtime.time = -0;
    goals.setAvoidGoalTime(handle, 0, -0);
    runtime.time = 0;
    runtime.beforeLog = () => { runtime.time = 1; };
    call(words(530, handle));
    expect(logged.at(-1)).toBe("avoid goal , number 0 for -0.000000 seconds");
    runtime.beforeLog = () => {};
    goals.setAvoidGoalTime(handle, 3, 2 ** 127);
    call(words(530, handle));
    expect(logged.at(-1)).toBe(`avoid goal , number 3 for ${2n ** 127n}.000000 seconds`);
  });

  test("goal names pad matches, clear only one missing byte and skip absent item configuration", () => {
    const { goals, memory, call, map } = fixture();
    const before = memory.bytes.slice();
    expect(call(words(532, 1, 0, 0))).toBe(0);
    expect(memory.bytes).toEqual(before);
    goals.setup(); map(ITEM_MAP);
    expect(call(words(532, 1, 128, 9))).toBe(0);
    expect(Array.from(memory.bytes.subarray(128, 138))).toEqual([72, 101, 97, 108, 116, 104, 0, 0, 0, 165]);
    expect(call(words(532, 1, 160, 4))).toBe(0);
    expect(Array.from(memory.bytes.subarray(160, 165))).toEqual([72, 101, 97, 0, 165]);
    expect(call(words(532, 99, 4095, -100))).toBe(0);
    expect(Array.from(memory.bytes.subarray(4094))).toEqual([165, 0]);
    expect(() => call(words(532, 1, 160, 0))).toThrow(RangeError);
    expect(() => call(words(532, 1, 4095, 2))).toThrow(RangeError);
  });

  test("item, location and camp queries preserve only their untouched source fields", () => {
    const { goals, memory, call, map } = fixture();
    goals.setup();
    map(ITEM_MAP + '\n{ "classname" "target_location" "origin" "-100 0 20" "message" "Home" }\n{ "classname" "info_camp" "origin" "100 0 20" }');
    memory.writeString(64, "HEALTH", 7);
    const itemTail = memory.bytes.slice(308, 312);
    expect(call(words(539, -1, 64, 256))).toBe(2);
    expect(readQvmBotGoal(memory.view(256, 56))).toMatchObject({ number: 2, entity: 0, area: 1, flags: GoalFlags.Item });
    expect(memory.bytes.subarray(308, 312)).toEqual(itemTail);
    expect(call(words(539, 2, 64, 4044))).toBe(1);
    expect(memory.view(4044, 52).getInt32(44, true)).toBe(1);
    expect(call(words(539, 1, 0, 0))).toBe(-1);
    const tail = memory.bytes.slice(428, 440);
    memory.writeString(64, "hOmE", 5);
    expect(call(words(568, 64, 384))).toBe(1);
    expect(readQvmBotGoal(memory.view(384, 56))).toMatchObject({ area: 2, origin: vec3(-100, 0, 20), entity: 0, mins: vec3(-8, -8, -8), maxs: vec3(8, 8, 8) });
    expect(memory.bytes.subarray(428, 440)).toEqual(tail);
    expect(call(words(567, -99, 4052))).toBe(1);
    expect(memory.view(4052, 44).getInt32(12, true)).toBe(1);
    expect(call(words(567, 1, 0))).toBe(0);
  });

  test("name matching follows Q_stricmp null, ASCII and early-mismatch reads", () => {
    const { goals, memory, call, map, resolver } = fixture();
    goals.setup(); map(ITEM_MAP);
    expect(call(words(539, -1, 0, 0))).toBe(-1);
    memory.bytes[4095] = 88;
    expect(call(words(539, -1, 4095, 0))).toBe(-1);
    memory.bytes[4095] = 72;
    expect(() => call(words(539, -1, 4095, 0))).toThrow(RangeError);
    expect(call(words(539, 0, 4095, 0))).toBe(-1);
    resolver.files.set("items.c", 'iteminfo "item_health" { name "\xc0" modelindex 5 }');
    goals.setup(); map(ITEM_MAP);
    memory.writeString(64, "\xe0", 2);
    expect(call(words(539, -1, 64, 0))).toBe(-1);
    expect(goals.getLevelItemGoal(-1, "\xe0")).toBeNull();
  });

  test("initialization reuses the retained world and update reaches actual entity items", () => {
    const { goals, memory, runtime, call, map, entity, bspEntities } = fixture();
    expect(() => call(words(541))).toThrow("retained goal world");
    expect(call(words(542))).toBe(0);
    goals.setup(); map('{ "classname" "item_health" "origin" "100 0 20" }');
    entity(3, 100); entity(8, 200);
    expect(call(words(542))).toBe(0);
    memory.writeString(64, "Health", 7);
    expect(call(words(539, -1, 64, 256))).toBe(9);
    expect(readQvmBotGoal(memory.view(256, 56))).toMatchObject({ entity: 8, flags: 5 });
    runtime.time = 31;
    entity(8, 200, 31);
    expect(call(words(542))).toBe(0);
    expect(goals.goalName(9)).toBe("Health");
    runtime.time = 31.01;
    bspEntities.load("");
    expect(call(words(541))).toBe(0);
    expect(goals.getLevelItemGoal(-1, "Health")).toBeNull();
  });

  test("LTG and NBG share real AAS selection, inventory and strict time bounds", () => {
    const { goals, memory, call, map, entity, load } = fixture(), handle = load();
    map(ITEM_MAP);
    expect(call(words(535, handle, 32, 0, TravelFlags.DEFAULT))).toBe(0);
    entity(1, 100); entity(2, 200); call(words(542));
    expect(call(words(536, handle, 32, 1024, TravelFlags.DEFAULT, 0, 0x3f800000))).toBe(0);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
    expect(goals.getTopGoal(handle)?.number).toBe(2);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
    expect(goals.getTopGoal(handle)?.number).toBe(1);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(0);
    call(words(525, handle));
    memory.view(4092, 4).setInt32(0, 1, true);
    expect(call(words(536, handle, 32, 1024, TravelFlags.DEFAULT, 4080, 0x40000000))).toBe(1);
    expect(goals.getTopGoal(handle)?.number).toBe(2);
  });

  test("item selection skips unused origin, inventory and LTG pointers at owner gates", () => {
    const { goals, call, load, map } = fixture(), handle = goals.allocGoalState(0);
    expect(call(words(535, -1, 0, 0, 0))).toBe(0);
    expect(call(words(535, handle, 0, 0, 0))).toBe(0);
    expect(call(words(536, handle, 0, 0, 0, 4095, 0x7fc00000))).toBe(0);
    const loaded = load();
    expect(call(words(535, loaded, 0, 0, 0))).toBe(0);
    map("");
    expect(call(words(535, loaded, 32, 0, TravelFlags.DEFAULT))).toBe(0);
    expect(call(words(536, loaded, 32, 0, TravelFlags.DEFAULT, 0, 0x7fc00000))).toBe(0);
    expect(() => call(words(536, loaded, 32, 0, TravelFlags.DEFAULT, 4095, 0x40000000))).toThrow(RangeError);
  });

  test("inventory reads only reached slots within the actual VM allocation", () => {
    const { goals, memory, resolver, call, load, map, entity } = fixture(), handle = load();
    map(ITEM_MAP); entity(1, 100); call(words(542));
    memory.view(4092, 4).setInt32(0, 0, true);
    expect(call(words(535, handle, 32, 4092, TravelFlags.DEFAULT))).toBe(1);
    goals.resetGoalState(handle);
    resolver.files.set("slot255.c", 'weight "item_health" { switch(255) { case 1: return 10; default: return 0; } }');
    memory.writeString(64, "slot255.c", 10);
    expect(call(words(543, handle, 64))).toBe(0);
    memory.view(4092, 4).setInt32(0, 0, true);
    expect(call(words(535, handle, 32, 3072 - 4096, TravelFlags.DEFAULT))).toBe(1);
    goals.resetGoalState(handle);
    expect(() => call(words(535, handle, 32, 3073, TravelFlags.DEFAULT))).toThrow(RangeError);
    resolver.files.set("slot256.c", 'weight "item_health" { switch(256) { default: return 10; } }');
    memory.writeString(64, "slot256.c", 10);
    expect(call(words(543, handle, 64))).toBe(0);
    memory.view(2048, 4).setInt32(0, 0, true);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
    goals.resetGoalState(handle);
    expect(() => call(words(535, handle, 32, 3072, TravelFlags.DEFAULT))).toThrow("exceeds allocation");
  });

  test("captures argument words before callbacks while reading live inventory after navigation", () => {
    const { goals, memory, runtime, resolver, call, load, map, entity } = fixture(), handle = load();
    resolver.files.set("live.c", 'weight "item_health" { switch(0) { case 1: return 10; default: return 0; } }');
    goals.loadItemWeights(handle, "live.c"); map(ITEM_MAP); entity(1, 100); call(words(542));
    const active = words(535, handle, 32, 1024, TravelFlags.DEFAULT);
    runtime.beforeTrace = () => {
      active.setInt32(4, -1, true); active.setInt32(12, 0, true); active.setInt32(16, 0, true);
      memory.view(1024, 4).setInt32(0, 1000000, true);
    };
    expect(call(active)).toBe(0);
    runtime.beforeTrace = () => {};
    memory.view(1024, 4).setInt32(0, 0, true);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
  });

  test("signed fuzzy inventory offsets retain the masked base and actual allocation bounds", () => {
    const { goals, memory, resolver, call, load, map, entity } = fixture(), handle = load();
    resolver.files.set("preceding.c", 'weight "item_health" { switch(0xffffffff) { case 1: return 10; default: return 0; } }');
    expect(goals.loadItemWeights(handle, "preceding.c")).toBe(0);
    map(ITEM_MAP); entity(1, 100); call(words(542));
    memory.view(252, 4).setInt32(0, 0, true);
    for (const pointer of [256, 4096 + 256, 256 - 4096]) {
      expect(call(words(535, handle, 32, pointer, TravelFlags.DEFAULT))).toBe(1);
      goals.resetGoalState(handle);
    }
    expect(() => call(words(535, handle, 32, 4096, TravelFlags.DEFAULT))).toThrow("exceeds allocation");
    expect(() => call(words(535, handle, 32, 0, TravelFlags.DEFAULT))).toThrow("nonnull");
  });

  test("goal selection uses inventory mutations made by the actual fuzzy random callback", () => {
    const { goals, memory, runtime, resolver, call, load, map, entity, entities } = fixture();
    resolver.files.set("items.c", ITEM_SOURCE + ' iteminfo "item_armor" { name "Armor" modelindex 6 mins {-15,-15,-15} maxs {15,15,15} }');
    resolver.files.set("weights.c", `weight "item_health" { switch(0) {
      case 0: return balance(10, 10, 10);
      case 10: return balance(30, 30, 30);
      default: return 50;
    } } weight "item_armor" { return 20; }`);
    const handle = load();
    map('{ "classname" "item_health" "origin" "100 0 20" }\n{ "classname" "item_armor" "origin" "200 0 20" }');
    entity(1, 100);
    const origin = vec3(200, 0, 15);
    entities.set(2, { type: 2, modelIndex: 6, origin, lastVisibleOrigin: origin, lastUpdateTime: 0 });
    call(words(542));
    memory.view(1024, 4).setInt32(0, 5, true);
    let randomCalls = 0;
    runtime.beforeRandom = () => {
      randomCalls++;
      if (randomCalls >= 2) memory.view(1024, 4).setInt32(0, 10, true);
    };
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
    expect(randomCalls).toBe(3);
    expect(goals.getTopGoal(handle)?.number).toBe(2);
  });

  test("touching reads only geometric fields and short-circuits unused origin components", () => {
    const { memory, call } = fixture();
    writeQvmBotGoal(memory.view(128, 56), goal());
    memory.span(4056, 40).set(memory.span(128, 40));
    putVector(memory, 32, vec3(84, 2, 3));
    expect(call(words(537, 32, 4056))).toBe(1);
    memory.view(4092, 4).setFloat32(0, 83, true);
    expect(call(words(537, 4092, 128))).toBe(0);
    putVector(memory, 32, vec3(Number.NaN, 2, 3));
    expect(call(words(537, 32, 128))).toBe(1);
  });

  test("visibility ignores view angles, keeps the source corner and reads entity after trace", () => {
    const { goals, memory, runtime, traces, call, map, entity } = fixture();
    goals.setup(); map("");
    const item = { ...goal(), flags: 0 };
    writeQvmBotGoal(memory.view(4044, 52), item, "level-item");
    expect(call(words(538, 9, 0, 0, 4044))).toBe(0);
    memory.view(4092, 4).setInt32(0, GoalFlags.Item, true);
    putVector(memory, 32, vec3(0, 0, 0));
    entity(8, 100, 0);
    runtime.beforeTrace = () => { memory.view(4084, 4).setInt32(0, 8, true); };
    expect(call(words(538, 9, 32, 0, 4044))).toBe(1);
    expect(traces.at(-1)).toEqual({ start: vec3(0, 0, 0), end: vec3(99, 0, 0), viewer: 9 });
    runtime.beforeTrace = () => {};
    runtime.time = 0.5;
    expect(call(words(538, 9, 32, 4095, 4044))).toBe(0);
    runtime.blocked = true;
    memory.view(4084, 4).setInt32(0, -1, true);
    expect(call(words(538, 9, 32, 0, 4044))).toBe(0);
    expect(() => call(words(538, 9, 0, 0, 4044))).toThrow(RangeError);
  });

  test("load and free item weights use actual owner handles and lazy filename reads", () => {
    const { goals, resolver, call, load, map } = fixture();
    expect(call(words(543, -1, 0))).toBe(9);
    const handle = load();
    map(ITEM_MAP);
    const reads = [...resolver.reads];
    expect(call(words(544, handle))).toBe(0);
    expect(resolver.reads).toEqual(reads);
    expect(call(words(535, handle, 0, 0, 0))).toBe(0);
    expect(() => call(words(543, handle, 0))).toThrow(RangeError);
    expect(call(words(547, handle))).toBe(0);
    expect(goals.getTopGoal(handle)).toBeNull();
  });

  test("weight loading keeps old weights live through reads and publishes NULL before its failure report", () => {
    const { goals, memory, runtime, resolver, call, load, map, entity } = fixture(), handle = load();
    map(ITEM_MAP); entity(1, 100); call(words(542));
    resolver.files.set("replacement.c", 'weight "item_health" { return 0; }');
    memory.writeString(64, "replacement.c", 14);
    const observed: string[] = [];
    resolver.beforeRead = filename => {
      if (filename !== "replacement.c") return;
      expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
      goals.resetGoalState(handle);
      observed.push("read kept old weights");
    };
    expect(call(words(543, handle, 64))).toBe(0);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(0);
    resolver.beforeRead = () => {};
    goals.loadItemWeights(handle, "weights.c");
    memory.writeString(64, "missing.c", 10);
    runtime.beforeWeightPrint = text => {
      if (text !== "counldn't load missing.c\n") return;
      expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
      goals.resetGoalState(handle);
      observed.push("failure print kept old weights");
    };
    runtime.beforeGoalReport = text => {
      if (text !== "couldn't load weights\n") return;
      expect(call(words(535, handle, 0, 0, 0))).toBe(0);
      observed.push("fatal saw null weights");
    };
    expect(call(words(543, handle, 64))).toBe(9);
    expect(observed).toEqual(["read kept old weights", "failure print kept old weights", "fatal saw null weights"]);
    expect(call(words(535, handle, 0, 0, 0))).toBe(0);
  });

  test("a successful weight load remains published without item configuration", () => {
    const { goals, memory, traces, call, map } = fixture(), handle = goals.allocGoalState(0);
    map(ITEM_MAP);
    memory.writeString(64, "weights.c", 10);
    expect(call(words(543, handle, 64))).toBe(9);
    putVector(memory, 32, vec3(50, 0, 20));
    expect(call(words(535, handle, 32, 0, TravelFlags.DEFAULT))).toBe(0);
    expect(traces).toHaveLength(1);
    expect(() => call(words(535, handle, 0, 0, TravelFlags.DEFAULT))).toThrow(RangeError);
  });

  test("nested index-log loads retain their config while the outer call publishes its indexes", () => {
    const { goals, memory, runtime, resolver, call, map, entity, entities, logged } = fixture();
    resolver.files.set("items.c", ITEM_SOURCE + ' iteminfo "item_armor" { name "Armor" modelindex 6 mins {-15,-15,-15} maxs {15,15,15} }');
    resolver.files.set("outer.c", 'weight "item_armor" { return 20; }');
    resolver.files.set("nested.c", 'weight "item_health" { return balance(10, 10, 10); }');
    goals.setup();
    const handle = goals.allocGoalState(0);
    map('{ "classname" "item_health" "origin" "100 0 20" }\n{ "classname" "item_armor" "origin" "200 0 20" }');
    entity(1, 100);
    const origin = vec3(200, 0, 15);
    entities.set(2, { type: 2, modelIndex: 6, origin, lastVisibleOrigin: origin, lastUpdateTime: 0 });
    call(words(542));
    memory.writeString(64, "outer.c", 8);
    memory.writeString(96, "nested.c", 9);
    runtime.beforeLog = () => {
      runtime.beforeLog = () => {};
      expect(call(words(543, handle, 96))).toBe(0);
    };
    expect(call(words(543, handle, 64))).toBe(0);
    expect(logged).toEqual(['item info 0 "item_health" has no fuzzy weight\r\n', 'item info 1 "item_armor" has no fuzzy weight\r\n']);
    let mutations = 0;
    runtime.beforeRandom = () => { mutations++; };
    goals.mutateGoalFuzzyLogic(handle, 0);
    expect(mutations).toBeGreaterThan(0);
    putVector(memory, 32, vec3(50, 0, 20));
    memory.view(1024, 4).setInt32(0, 0, true);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
    expect(goals.getTopGoal(handle)?.number).toBe(2);
  });

  test("a replacement loaded by the failure report survives the failed outer call", () => {
    const { memory, runtime, call, load, map, entity } = fixture(), handle = load();
    map(ITEM_MAP); entity(1, 100); call(words(542));
    memory.writeString(96, "missing.c", 10);
    runtime.beforeGoalReport = text => {
      if (text !== "couldn't load weights\n") return;
      expect(call(words(535, handle, 0, 0, 0))).toBe(0);
      expect(call(words(543, handle, 64))).toBe(0);
    };
    expect(call(words(543, handle, 96))).toBe(9);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
  });

  test("unexpected read callbacks and invalid filenames propagate before weight publication", () => {
    const { goals, memory, runtime, resolver, call, load, map, entity } = fixture(), handle = load();
    map(ITEM_MAP); entity(1, 100); call(words(542));
    resolver.files.set("replacement.c", WEIGHT_SOURCE);
    memory.writeString(96, "replacement.c", 14);
    const failure = new Error("authored reader abort");
    resolver.beforeRead = filename => { if (filename === "replacement.c") throw failure; };
    expect(() => call(words(543, handle, 96))).toThrow(failure);
    resolver.beforeRead = () => {};
    runtime.beforeWeightPrint = text => { if (text === "loaded replacement.c\n") throw failure; };
    expect(() => call(words(543, handle, 96))).toThrow(failure);
    expect(() => call(words(543, handle, 0))).toThrow(RangeError);
    expect(call(words(535, handle, 32, 1024, TravelFlags.DEFAULT))).toBe(1);
    expect(goals.diagnostics.some(diagnostic => diagnostic.message === "couldn't load weights\n")).toBe(false);
    runtime.beforeWeightPrint = () => {};
    resolver.files.set("bad.c", "weight 7 { return 10; }");
    memory.writeString(96, "bad.c", 6);
    expect(call(words(543, handle, 96))).toBe(9);
    expect(call(words(535, handle, 0, 0, 0))).toBe(0);
  });

  test("an empty weight filename reaches source lookup and its normal failure code", () => {
    const { memory, call, load, printed } = fixture(), handle = load();
    memory.view(64, 1).setUint8(0, 0);
    expect(call(words(543, handle, 64))).toBe(9);
    expect(printed).toContain("counldn't load \n");
  });

  test("short syscall records fail before callbacks and scalar mutations", () => {
    const { goals, call, logged } = fixture();
    for (const trap of [525, 526, 527, 528, 529, 530, 531, 532, 533, 534, 535, 536, 537, 538, 539, 540, 543, 544, 546, 547, 567, 568, 571, 573]) {
      expect(() => call(words(trap))).toThrow(RangeError);
    }
    expect(goals.diagnostics).toEqual([]);
    expect(logged).toEqual([]);
  });
});
