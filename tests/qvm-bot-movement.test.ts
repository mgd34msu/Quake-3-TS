// Authored fixtures for sv_game.c movement traps and be_ai_move.c pointer ordering.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import type { AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { BotActionBuffer } from "../src/botlib/actions.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import type { BotGoal } from "../src/botlib/goals.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import { BotMovement } from "../src/botlib/movement.ts";
import { addToMovementTarget, BotMovementRouting } from "../src/botlib/movement-routing.ts";
import { BotMoveFlag, BotMoveStateStore } from "../src/botlib/movement-state.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import type { AasSpatialHost } from "../src/botlib/spatial.ts";
import { BinaryError } from "../src/core/binary.ts";
import { waitForCall } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { bitsToFloat32, float32ToBits } from "../src/core/numeric.ts";
import { writeQvmBotGoal } from "../src/vm/bot-goal-record.ts";
import { QVM_BOT_INIT_MOVE_BYTES, QVM_BOT_MOVE_RESULT_BYTES, qvmBotInitMoveReference,
  qvmBotMoveResultReference } from "../src/vm/bot-movement-record.ts";
import { qvmBotMovementSyscall } from "../src/vm/bot-movement-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

function words(...values: number[]): DataView {
  const result = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => result.setInt32(index * 4, value, true));
  return result;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing authored movement fixture value");
  return value;
}

function putVector(memory: QvmMemory, word: number, value: Vec3): void {
  const view = memory.view(word, 12);
  view.setFloat32(0, value.x, true);
  view.setFloat32(4, value.y, true);
  view.setFloat32(8, value.z, true);
}

function getVector(memory: QvmMemory, word: number): Vec3 {
  const view = memory.view(word, 12);
  return vec3(view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true));
}

function goal(area = 1, origin = vec3(30, 40, 24)): BotGoal {
  return { origin, area, mins: vec3(-16, -16, -24), maxs: vec3(16, 16, 32),
    entity: 7, number: 8, flags: 9, itemInfo: 10 };
}

function putInit(memory: QvmMemory, word: number): void {
  putVector(memory, word, vec3(0, 0, 24));
  putVector(memory, word + 12, vec3(0, 0, 0));
  putVector(memory, word + 24, vec3(0, 0, 20));
  const view = memory.view(word, 68);
  view.setInt32(36, -1, true); view.setInt32(40, 1, true);
  view.setFloat32(44, 0.1, true); view.setInt32(48, 2, true);
  putVector(memory, word + 52, vec3(10, 20, 30));
  view.setInt32(64, BotMoveFlag.ONGROUND, true);
}

class ObservedMemory extends QvmMemory {
  readonly resolved: number[] = [];
  override pointer(word: number): Uint8Array | null {
    this.resolved.push(word);
    return super.pointer(word);
  }
}

function authoredAas(reachHeight: number, grapple: boolean): AasWorld {
  const zero = vec3(0, 0, 0), bounds = { min: vec3(-1000, -1000, 0), max: vec3(1000, 1000, 1000) };
  const reachability: readonly AasReachability[] = [
    { area: 0, face: 0, edge: 0, start: zero, end: zero, travelType: 0, travelTime: 0, padding: 0 },
    { area: 2, face: 0, edge: 0, start: vec3(grapple ? 0 : 30, 0, reachHeight), end: vec3(120, 0, reachHeight),
      travelType: grapple ? TravelType.GRAPPLEHOOK : TravelType.WALK, travelTime: 10, padding: 0 },
    { area: 1, face: 0, edge: 0, start: vec3(120, 0, 24), end: vec3(30, 0, 24), travelType: TravelType.WALK, travelTime: 10, padding: 0 },
  ];
  return {
    source: "authored-qvm-bot-movement", version: 5, bspChecksum: 0, vertices: [], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    planes: [{ normal: vec3(0, 0, 1), distance: 0, type: 2 }, { normal: vec3(0, 0, -1), distance: 0, type: 2 },
      { normal: vec3(1, 0, 0), distance: 100, type: 0 }, { normal: vec3(-1, 0, 0), distance: -100, type: 0 }],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [2, 0] }, { plane: 2, children: [-2, -1] }],
    areas: [0, 1, 2].map(areaNumber => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: vec3(areaNumber * 50, 0, 24) })),
    areaSettings: [0, 1, 2].map(area => ({ contents: 0, flags: area === 0 ? 0 : 1,
      presenceType: area === 0 ? 0 : 6, cluster: area === 0 ? 0 : 1, clusterAreaNumber: area === 0 ? 0 : area - 1,
      reachableAreaCount: area === 0 ? 0 : 1, firstReachableArea: area })),
    reachability, portals: [], portalIndex: [], bboxes: [],
    clusters: [{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 },
      { areaCount: 2, reachabilityAreaCount: 2, portalCount: 0, firstPortal: 0 }],
    pointArea: point => point.z <= 0 ? 0 : point.x > 100 ? 2 : 1,
    areaBounds: () => bounds,
    areaReachabilities: area => area === 0 ? [] : [required(reachability[area])],
  };
}

function fixture(reachHeight = 24, grapple = false) {
  const memory = new ObservedMemory(new Uint8Array(4096).fill(0xa5)), messages: string[] = [], commands: string[] = [];
  const variables = new BotLibVars();
  const runtime = { loaded: true, mapBorrows: 0, contents: 0, visible: true,
    beforePrint: (): void => {}, beforeCommand: (): void => {},
    *commandCalls(): CallSteps<undefined> {} };
  const traces: { readonly start: Vec3; readonly end: Vec3; readonly bounds: Bounds | null; readonly pass: number; readonly mask: number }[] = [];
  const host: AasSpatialHost = {
    print: (text, severity) => { runtime.beforePrint(); messages.push(severity === undefined ? text : `${severity}:${text}`); },
    pointContents: () => runtime.contents,
    trace(start, end, bounds, pass, mask) {
      traces.push({ start: vec3(start.x, start.y, start.z), end: vec3(end.x, end.y, end.z), bounds, pass, mask });
      if (bounds === null) return { fraction: runtime.visible ? 1 : 0.5, end,
        solidity: "clear", contact: { kind: "none" }, entityNum: 1023, contents: 0, surfaceFlags: 0 };
      const floor = -bounds.min.z, solid = start.z < floor;
      const fraction = solid ? 0 : end.z < floor ? Math.fround((start.z - floor) / (start.z - end.z)) : 1;
      return { fraction, end: vec3(start.x + fraction * (end.x - start.x), start.y + fraction * (end.y - start.y),
        start.z + fraction * (end.z - start.z)), solidity: solid ? "start-solid" : "clear",
        contact: { kind: "none" }, entityNum: fraction < 1 ? 1022 : 1023, contents: 0, surfaceFlags: 0 };
    },
    entityTrace: () => { throw new Error("Authored world has no linked dynamic entities"); },
    entityModelIndex: () => 0,
    modelBounds: () => { throw new Error("Authored world has no brush models"); },
  };
  const world = authoredAas(reachHeight, grapple), bsp = new AasBspEntities((_severity, text) => { messages.push(text); });
  bsp.load("");
  const links = new AasLinkHeap(() => { throw new Error("Authored AAS link heap exhausted"); });
  links.initialize(() => 6144);
  const spatial = new AasSpatial(world, bsp, host, DEFAULT_AAS_MOVEMENT_SETTINGS,
    new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
  const states = new BotMoveStateStore({ time: () => 1,
    print: (severity, text) => { runtime.beforePrint(); messages.push(`${severity}:${text}`); },
    libVar: (name, value) => variables.getOrCreate(name, value),
    setBrushModelTypes: () => spatial.setBrushModelTypes(host.print) });
  states.setup();
  const aasRouting = new AasRouting(world);
  aasRouting.initializeRouting(spatial, () => 16 * 1024 * 1024, () => 1);
  const routing = new BotMovementRouting(states, spatial, aasRouting,
    { originOfMoverWithModelNum: () => null, entityModelNum: host.entityModelIndex });
  const actions = new BotActionBuffer(2, { *clientCommand(_client, command): ReturnType<BotActionBuffer["commandCalls"]> {
    runtime.beforeCommand(); commands.push(command);
    yield* runtime.commandCalls();
  } });
  const movement = new BotMovement(routing, actions, { random: { nextInt: () => 0 }, developer: () => false,
    nextEntity: () => 0, entityType: () => { throw new Error("Authored world has no grapple entity"); },
    entityWeapon: () => { throw new Error("Authored world has no grapple weapon"); } });
  const currentMovement = (): BotMovement => {
    runtime.mapBorrows++;
    if (!runtime.loaded) throw new Error("No movement map loaded");
    return movement;
  };
  const currentRouting = (): BotMovementRouting => {
    runtime.mapBorrows++;
    if (!runtime.loaded) throw new Error("No movement map loaded");
    return routing;
  };
  const callSuspendable = (...values: number[]): number | Promise<number> | null =>
    qvmBotMovementSyscall("game", words(...values), memory, states, currentMovement, currentRouting);
  const call = (...values: number[]): number | null => {
    const result = callSuspendable(...values);
    if (result instanceof Promise) throw new Error("Synchronous movement fixture reached a callback wait");
    return result;
  };
  const initialize = (): number => {
    const handle = required(call(555)); putInit(memory, 64); expect(call(557, handle, 64)).toBe(0); return handle;
  };
  return { memory, messages, commands, variables, runtime, traces, states, routing, actions, movement,
    currentMovement, currentRouting, call, callSuspendable, initialize };
}

describe("QVM movement record layouts", () => {
  test("init reads exact signed and binary32 fields into the real state", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    expect(QVM_BOT_INIT_MOVE_BYTES).toBe(68); expect(QVM_BOT_MOVE_RESULT_BYTES).toBe(52);
    const view = env.memory.view(64, 68);
    putVector(env.memory, 64, vec3(0.1, -0, 16777217));
    putVector(env.memory, 76, vec3(4, 5, 6)); putVector(env.memory, 88, vec3(7, 8, 9));
    view.setInt32(36, -2147483648, true); view.setInt32(40, -7, true); view.setInt32(48, 4, true);
    view.setInt32(64, BotMoveFlag.WALK | BotMoveFlag.WATERJUMP | BotMoveFlag.SWIMMING, true);
    state.moveFlags = 0xffff; state.lastReachability = 12;
    expect(env.call(557, handle, 4160)).toBe(0);
    expect(state.origin).toEqual(vec3(Math.fround(0.1), -0, 16777216));
    expect(state.velocity).toEqual(vec3(4, 5, 6)); expect(state.viewOffset).toEqual(vec3(7, 8, 9));
    expect(state.entityNum).toBe(-2147483648); expect(state.client).toBe(-7);
    expect(state.thinkTime).toBe(Math.fround(0.1)); expect(state.presenceType).toBe(4);
    expect(state.viewAngles).toEqual(vec3(10, 20, 30)); expect(state.lastReachability).toBe(12);
    const mask = 2 | 16 | 32 | 64 | 512;
    expect(state.moveFlags).toBe((0xffff & ~mask) | 16 | 512);
    view.setFloat32(0, 99, true); expect(state.origin.x).toBe(Math.fround(0.1));
  });

  test.each([0, 1, 6, -1, -2147483648, 2147483647])("init retains presence integer %i and copies the remaining fields", presence => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.runtime.loaded = false;
    const view = env.memory.view(64, 68);
    putVector(env.memory, 64, vec3(9, 8, 7));
    view.setInt32(48, presence, true);
    putVector(env.memory, 116, vec3(-90, 180, 270));
    view.setInt32(64, BotMoveFlag.TELEPORTED | BotMoveFlag.WALK, true);
    state.moveFlags = BotMoveFlag.SWIMMING | BotMoveFlag.ONGROUND | BotMoveFlag.WATERJUMP | BotMoveFlag.GRAPPLEPULL;
    const input = env.memory.bytes.slice(64, 132);
    expect(env.call(557, handle, 64)).toBe(0);
    expect(state.origin).toEqual(vec3(9, 8, 7)); expect(state.presenceType).toBe(presence);
    expect(state.viewAngles).toEqual(vec3(-90, 180, 270));
    expect(state.moveFlags).toBe(BotMoveFlag.SWIMMING | BotMoveFlag.TELEPORTED | BotMoveFlag.WALK);
    expect(env.memory.bytes.subarray(64, 132)).toEqual(input);
    expect(env.messages).toEqual([]); expect(env.runtime.mapBorrows).toBe(0);
  });

  test("truncated init retains the fields copied before the missing word", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.memory.bytes.fill(0, 4048); env.memory.view(4048, 48).setFloat32(44, 0.5, true);
    expect(() => env.call(557, handle, 4048)).toThrow(BinaryError);
    expect(state.origin).toEqual(vec3(0, 0, 0)); expect(state.thinkTime).toBe(0.5);
    expect(state.presenceType).toBe(2); expect(state.viewAngles).toEqual(vec3(10, 20, 30));
    env.memory.bytes.fill(0, 4044); env.memory.view(4044, 52).setInt32(48, 6, true);
    expect(() => env.call(557, handle, 4044)).toThrow(BinaryError);
    expect(state.presenceType).toBe(6); expect(state.viewAngles).toEqual(vec3(10, 20, 30));
  });

  test("result fields use 52 bytes, signed integers and live binary32 vector writes", () => {
    const bytes = new Uint8Array(60).fill(0xa5), pointer = (): Uint8Array => bytes.subarray(4, 56);
    const result = qvmBotMoveResultReference(pointer), view = new DataView(bytes.buffer, 4, 52);
    result.failure = true; result.type = -2147483648; result.blocked = true; result.blockEntity = -1;
    result.travelType = 2147483647; result.flags = -2147483647; result.weapon = -99;
    result.moveDirection = { x: 0.1, y: -0, z: 16777217 }; result.idealViewAngles = vec3(-1, 2, 3);
    expect(Array.from({ length: 7 }, (_, index) => view.getInt32(index * 4, true)))
      .toEqual([1, -2147483648, 1, -1, 2147483647, -2147483647, -99]);
    expect([view.getUint32(28, true), view.getUint32(32, true), view.getFloat32(36, true)])
      .toEqual([float32ToBits(0.1), 0x80000000, 16777216]);
    expect(result.idealViewAngles).toEqual(vec3(-1, 2, 3));
    view.setFloat32(40, 91, true); expect(result.idealViewAngles.x).toBe(91);
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array(4).fill(0xa5));
    expect(bytes.subarray(56)).toEqual(new Uint8Array(4).fill(0xa5));
  });

  test("references defer null and short-pointer errors until the field is used", () => {
    const bytes = new Uint8Array(4), init = qvmBotInitMoveReference(() => null), result = qvmBotMoveResultReference(() => bytes);
    expect(() => init.origin.x).toThrow("nonnull pointer");
    result.failure = true; expect(result.failure).toBe(true);
    expect(() => { result.type = 1; }).toThrow(BinaryError);
  });
});

describe("game VM movement traps over actual bot owners", () => {
  test("role and unsupported-trap gates precede arguments, pointers and map owners", () => {
    const env = fixture();
    for (const role of ["cgame", "ui"] satisfies readonly ("cgame" | "ui")[]) {
      expect(qvmBotMovementSyscall(role, words(), env.memory, env.states, env.currentMovement, env.currentRouting)).toBeNull();
    }
    for (const trap of [-1, 547, 558, 571, 573, 575]) expect(env.call(trap)).toBeNull();
    expect(env.memory.resolved).toEqual([]); expect(env.runtime.mapBorrows).toBe(0);
    for (const trap of [548, 549, 550, 551, 552, 553, 554, 556, 557, 572, 574]) {
      expect(() => env.call(trap)).toThrow(RangeError);
    }
    expect(env.runtime.mapBorrows).toBe(0);
  });

  test("allocation, initialization, avoidance, reset and free retain the pre-map state owner", () => {
    const env = fixture(); env.runtime.loaded = false;
    const handle = env.initialize(), state = required(env.states.fromHandle(handle)), avoid = state.avoidReach;
    putVector(env.memory, 32, vec3(1, 2, 3));
    expect(env.call(574, handle, 32, float32ToBits(0.1), 2)).toBe(0);
    expect(state.avoidSpots[0]?.origin).toEqual(vec3(1, 2, 3));
    expect(state.avoidSpots[0]?.radius).toBe(Math.fround(0.1));
    state.avoidReach[0] = 12; state.avoidReachTimes[0] = 10; state.avoidReachTries[0] = 3;
    expect(env.call(552, handle)).toBe(0); expect(state.avoidReachTimes[0]).toBe(0); expect(state.avoidReachTries[0]).toBe(2);
    expect(env.call(551, handle)).toBe(0); expect([...state.avoidReach]).toEqual([0]); expect([...state.avoidReachTries]).toEqual([0]);
    expect(env.call(548, handle)).toBe(0); expect(env.states.fromHandle(handle)).toBe(state);
    expect(state.avoidReach).toBe(avoid); expect(state.presenceType).toBe(0); expect(state.numAvoidSpots).toBe(0);
    expect(env.call(556, handle)).toBe(0); expect(env.call(555)).toBe(handle);
    expect(env.states.fromHandle(handle)).not.toBe(state); expect(env.runtime.mapBorrows).toBe(0);
  });

  test("allocation exhausts the actual 64 slots and free makes precisely its slot reusable", () => {
    const env = fixture();
    for (let handle = 1; handle <= 64; handle++) expect(env.call(555)).toBe(handle);
    expect(env.call(555)).toBe(0); expect(env.call(556, 17)).toBe(0); expect(env.call(555)).toBe(17);
    expect(env.call(556, 0)).toBe(0); expect(env.messages).toEqual(["4:move state handle 0 out of range\n"]);
  });

  test("unloaded move-to-goal clears the result before invalid-handle diagnostics without a map borrow", () => {
    const env = fixture(); env.runtime.loaded = false;
    const tail = env.memory.bytes.slice(224, 252);
    env.runtime.beforePrint = () => {
      expect(env.memory.bytes.subarray(200, 224)).toEqual(new Uint8Array(24));
      expect(env.memory.bytes.subarray(224, 252)).toEqual(tail);
    };
    expect(env.call(549, 200, 0, 4095, 0)).toBe(0);
    expect(env.messages).toEqual(["4:move state handle 0 out of range\n"]);
    expect(env.runtime.mapBorrows).toBe(0);
    expect(() => env.call(549, 0, 0, 0, 0)).toThrow("nonnull pointer");
    expect(env.messages).toHaveLength(1); expect(env.runtime.mapBorrows).toBe(0);
  });

  test("unloaded direction traps diagnose invalid actual handles before resolving a map or direction", () => {
    const env = fixture(); env.runtime.loaded = false;
    expect(env.call(550, 0, 0, float32ToBits(100), 1)).toBe(0);
    const handle = required(env.call(555)); env.call(556, handle);
    expect(env.call(550, handle, 4095, float32ToBits(100), 1)).toBe(0);
    expect(env.messages).toEqual(["4:move state handle 0 out of range\n", "4:invalid move state 1\n"]);
    expect(env.runtime.mapBorrows).toBe(0); expect(env.memory.resolved).toEqual([]);
  });

  test("unloaded view-target gates invalid handles, absent goals and an unentered lookahead loop", () => {
    const env = fixture(); env.runtime.loaded = false;
    expect(env.call(554, 0, 4095, 0, float32ToBits(100), 0)).toBe(0);
    const handle = required(env.call(555)), state = required(env.states.fromHandle(handle));
    expect(env.call(554, handle, 4095, 0, float32ToBits(100), 0)).toBe(0);
    state.lastReachability = 1;
    expect(env.call(554, handle, 0, 0, float32ToBits(100), 0)).toBe(0);
    for (const lookahead of [0, -1, Number.NaN]) {
      expect(env.call(554, handle, 4095, 0, float32ToBits(lookahead), 0)).toBe(0);
    }
    expect(env.messages).toEqual(["4:move state handle 0 out of range\n"]);
    expect(env.runtime.mapBorrows).toBe(0); expect(env.memory.resolved).toEqual([]);
  });

  test("unloaded visibility gates precede map lookup while an unentered hop still copies origin", () => {
    const env = fixture(); env.runtime.loaded = false;
    expect(env.call(572, 0, 1, 0, 0, 0)).toBe(0);
    expect(env.call(572, 0, 0, 4095, 0, 0)).toBe(0);
    expect(env.memory.resolved).toEqual([]);
    env.memory.view(4080, 16).setInt32(12, 0, true);
    expect(env.call(572, 0, 1, 4080, 0, 0)).toBe(0);
    env.memory.view(4080, 16).setInt32(12, 1, true);
    expect(() => env.call(572, 0, 1, 4080, 0, 0)).toThrow("nonnull pointer");
    putVector(env.memory, 32, vec3(0, 0, 24)); env.memory.resolved.length = 0;
    expect(env.call(572, 32, 1, 4080, 0, 0)).toBe(0);
    expect(env.memory.resolved.includes(32)).toBe(true);
    expect(env.runtime.mapBorrows).toBe(0);
    env.memory.view(4080, 16).setInt32(12, 2, true);
    expect(() => env.call(572, 32, 1, 4080, 0, 0)).toThrow("No movement map loaded");
    expect(env.runtime.mapBorrows).toBe(1);
  });

  test("invalid handles and avoid CLEAR/capacity returns never resolve their input pointers", () => {
    const env = fixture(), handle = env.initialize();
    env.memory.resolved.length = 0;
    expect(env.call(557, 0, 0)).toBe(0); expect(env.call(574, 0, 4095, 0, 1)).toBe(0);
    expect(env.call(550, 0, 0, float32ToBits(100), 1)).toBe(0);
    expect(env.call(554, 0, 4095, 0, float32ToBits(10), 0)).toBe(0);
    expect(env.call(574, handle, 0, float32ToBits(Number.NaN), 0)).toBe(0);
    const state = required(env.states.fromHandle(handle)); state.numAvoidSpots = 32;
    expect(env.call(574, handle, 0, float32ToBits(Infinity), 1)).toBe(0);
    expect(env.memory.resolved).toEqual([]); expect(env.messages).toHaveLength(4);
    expect(() => env.call(557, handle, 0)).toThrow("nonnull pointer");
    expect(env.call(574, handle, 0, 0, 0)).toBe(0);
    expect(() => env.call(574, handle, 4095, 0, 1)).toThrow(BinaryError);
  });

  test("result clear precedes handle diagnostics and preserves caller weapon, vectors and raw NaN words", () => {
    const env = fixture(), word = 200;
    env.memory.view(word, 52).setUint32(28, 0x7fa12345, true);
    env.memory.view(word, 52).setUint32(40, 0xffa54321, true);
    const tail = env.memory.bytes.slice(word + 24, word + 52);
    env.memory.resolved.length = 0;
    let observed = false;
    env.runtime.beforePrint = () => {
      observed = true;
      expect(env.memory.bytes.subarray(word, word + 24)).toEqual(new Uint8Array(24));
      expect(env.memory.bytes.subarray(word + 24, word + 52)).toEqual(tail);
    };
    expect(env.call(549, word, 0, 4095, 0)).toBe(0); expect(observed).toBe(true);
    expect(env.memory.bytes[word - 1]).toBe(0xa5); expect(env.memory.bytes[word + 52]).toBe(0xa5);
    expect(env.memory.resolved.every(pointer => pointer === word)).toBe(true);
  });

  test("result short clear publishes earlier words and errors before handle diagnostics", () => {
    const env = fixture();
    expect(env.call(549, 4072, 0, 0, 0)).toBe(0);
    expect(env.memory.bytes.subarray(4072)).toEqual(new Uint8Array(24));
    env.messages.length = 0; env.memory.bytes.fill(0xa5, 4076);
    expect(() => env.call(549, 4076, 0, 0, 0)).toThrow(BinaryError);
    expect(env.memory.bytes.subarray(4076)).toEqual(new Uint8Array(20)); expect(env.messages).toEqual([]);
    expect(() => env.call(549, 0, 0, 0, 0)).toThrow("nonnull pointer"); expect(env.messages).toEqual([]);
  });

  test("null goal clears grapple through the actual action owner before setting failure", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.variables.set("offhandgrapple", "1"); state.moveFlags |= BotMoveFlag.ACTIVEGRAPPLE;
    env.runtime.beforeCommand = () => { expect(env.memory.bytes.subarray(200, 224)).toEqual(new Uint8Array(24)); };
    const tail = env.memory.bytes.slice(224, 252);
    expect(env.call(549, 200, handle, 0, TravelFlags.DEFAULT)).toBe(0);
    expect(env.memory.view(200, 4).getInt32(0, true)).toBe(1); expect(env.commands).toEqual(["grappleoff"]);
    expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(0); expect(env.memory.bytes.subarray(224, 252)).toEqual(tail);
  });

  test("awaited grapple reset preserves live result writes and reads the callback's goal before geometry", async () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.variables.set("offhandgrapple", "1"); state.moveFlags |= BotMoveFlag.ACTIVEGRAPPLE;
    state.grappleVisibleTime = 1;
    writeQvmBotGoal(env.memory.view(300, 56), goal(2));
    const gate = Promise.withResolvers<undefined>();
    env.runtime.commandCalls = function* (): CallSteps<undefined> {
      yield* waitForCall(() => gate.promise);
      writeQvmBotGoal(env.memory.view(300, 56), goal(1, vec3(0, 50, 24)));
    };
    const result = env.callSuspendable(549, 200, handle, 300, TravelFlags.DEFAULT);
    expect(result).toBeInstanceOf(Promise);
    expect(env.commands).toEqual(["grappleoff"]);
    expect(env.traces).toEqual([]);
    expect(env.memory.bytes.subarray(200, 224)).toEqual(new Uint8Array(24));
    expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(BotMoveFlag.ACTIVEGRAPPLE);
    expect(state.grappleVisibleTime).toBe(1);
    gate.resolve(undefined);
    expect(await result).toBe(0);
    expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(0);
    expect(state.grappleVisibleTime).toBe(0);
    expect(state.lastGoalArea).toBe(1);
    expect(env.actions.getInput(1, 0).direction).toEqual(vec3(0, 1, 0));
    expect(env.traces.length).toBeGreaterThan(0);
  });

  test("null-goal callback writes survive reset and failure is published only after completion", async () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.variables.set("offhandgrapple", "1"); state.moveFlags |= BotMoveFlag.ACTIVEGRAPPLE;
    const gate = Promise.withResolvers<undefined>();
    env.runtime.commandCalls = function* (): CallSteps<undefined> {
      yield* waitForCall(() => gate.promise);
      env.memory.view(200, 52).setInt32(4, 73, true);
      env.memory.view(200, 52).setInt32(24, 91, true);
    };
    const result = env.callSuspendable(549, 200, handle, 0, TravelFlags.DEFAULT);
    expect(env.memory.view(200, 4).getInt32(0, true)).toBe(0);
    gate.resolve(undefined);
    expect(await result).toBe(0);
    expect(env.memory.view(200, 52).getInt32(0, true)).toBe(1);
    expect(env.memory.view(200, 52).getInt32(4, true)).toBe(73);
    expect(env.memory.view(200, 52).getInt32(24, true)).toBe(91);
    expect(env.traces).toEqual([]);
  });

  test("ground and airborne grapple travel await commands before copying their result into QVM memory", async () => {
    for (const height of [24, 100]) {
      const env = fixture(height, true), handle = env.initialize(), state = required(env.states.fromHandle(handle));
      env.variables.set("offhandgrapple", "1");
      state.origin = vec3(0, 0, height); state.viewOffset = vec3(0, 0, 0); state.viewAngles = vec3(0, 0, 0);
      state.moveFlags = height === 24 ? BotMoveFlag.ONGROUND : 0;
      state.lastReachability = 1; state.lastArea = 1; state.lastGoalArea = 2;
      state.reachArea = 1; state.reachabilityTime = 5;
      writeQvmBotGoal(env.memory.view(300, 56), goal(2, vec3(120, 0, height)));
      const gate = Promise.withResolvers<undefined>(), tail = env.memory.bytes.slice(224, 252);
      env.runtime.commandCalls = function* (): CallSteps<undefined> {
        yield* waitForCall(() => gate.promise);
        env.memory.view(200, 52).setInt32(4, 73, true);
      };
      const result = env.callSuspendable(549, 200, handle, 300, TravelFlags.DEFAULT | TravelFlags.GRAPPLEHOOK);
      expect(result).toBeInstanceOf(Promise);
      expect(env.commands).toEqual(["grappleon"]);
      expect(env.memory.view(200, 52).getInt32(16, true)).toBe(TravelType.GRAPPLEHOOK);
      expect(env.memory.view(200, 52).getInt32(20, true)).toBe(0);
      expect(env.memory.bytes.subarray(224, 252)).toEqual(tail);
      expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(0);
      expect(state.lastOrigin).toEqual(vec3(0, 0, 0));
      gate.resolve(undefined);
      expect(await result).toBe(0);
      expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(BotMoveFlag.ACTIVEGRAPPLE);
      expect(state.lastOrigin).toEqual(state.origin);
      expect(env.memory.view(200, 52).getInt32(4, true)).toBe(0);
      expect(env.memory.view(200, 52).getInt32(20, true)).toBe(1);
    }
  });

  test("rejected reset commands retain source-prefix writes and direct movement never starts a wait", async () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.variables.set("offhandgrapple", "1"); state.moveFlags |= BotMoveFlag.ACTIVEGRAPPLE;
    state.grappleVisibleTime = 1;
    const failure = new Error("GAME_CLIENT_COMMAND failed");
    let started = 0;
    env.runtime.commandCalls = function* (): CallSteps<undefined> {
      yield* waitForCall(() => { started++; return Promise.reject(failure); });
    };
    expect(() => env.movement.moveToGoal(qvmBotMoveResultReference(() => env.memory.pointer(200)), handle, null, 0))
      .toThrow("Cannot synchronously finish");
    expect(started).toBe(0);
    const result = env.callSuspendable(549, 200, handle, 0, 0);
    await expect(result).rejects.toBe(failure);
    expect(started).toBe(1);
    expect(env.memory.bytes.subarray(200, 224)).toEqual(new Uint8Array(24));
    expect(state.moveFlags & BotMoveFlag.ACTIVEGRAPPLE).toBe(BotMoveFlag.ACTIVEGRAPPLE);
    expect(state.grappleVisibleTime).toBe(1);
    expect(env.traces).toEqual([]);
  });

  test("move-to-goal writes the source result and the existing EA input together", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    writeQvmBotGoal(env.memory.view(300, 56), goal());
    state.lastArea = 2; state.lastGoalArea = 2; state.lastReachability = 1;
    expect(env.call(549, 200, handle, 300, TravelFlags.DEFAULT)).toBe(0);
    const out = env.memory.view(200, 52), input = env.actions.getInput(1, 0.1);
    expect(out.getInt32(0, true)).toBe(0); expect(out.getInt32(16, true)).toBe(TravelType.WALK);
    expect([out.getUint32(28, true), out.getUint32(32, true), out.getUint32(36, true)])
      .toEqual([1058642329, 1061997772, 0]);
    expect(input.speed).toBe(200); expect(input.direction).toEqual(getVector(env.memory, 228));
    expect(env.actions.getInput(0, 0).speed).toBe(0);
    expect([state.lastReachability, state.lastArea, state.lastGoalArea]).toEqual([0, 0, 1]);
  });

  test("direction trap decodes float words, masks pointers and drives real swimming input", () => {
    const env = fixture(), handle = env.initialize(); env.runtime.contents = 32;
    putVector(env.memory, 32, vec3(3, 4, 0));
    expect(env.call(550, handle, -4064, float32ToBits(1.5), 1)).toBe(1);
    const input = env.actions.getInput(1, 0.1);
    expect(input.speed).toBe(1.5); expect(input.direction).toEqual(vec3(0.6, 0.8, 0));
    expect(env.call(550, handle, 32, float32ToBits(-0), 1)).toBe(1);
    expect(env.actions.getInput(1, 0).speed).toBe(-0);
    expect(() => env.call(550, handle, 0, float32ToBits(100), 1)).toThrow("nonnull pointer");
  });

  test.each([
    { presence: 0, entity: 1, diagnostics: 0 },
    { presence: 1, entity: 1, diagnostics: 0 },
    { presence: -2147483648, entity: 1, diagnostics: 0 },
    { presence: 6, entity: -1, diagnostics: 0 },
    { presence: 6, entity: 1, diagnostics: 1 },
    { presence: -1, entity: 1, diagnostics: 1 },
  ])("direction preserves raw presence $presence and entity $entity through the reached area test", ({ presence, entity, diagnostics }) => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    const view = env.memory.view(64, 68);
    view.setInt32(36, entity, true); view.setInt32(48, presence, true); view.setInt32(64, 0, true);
    expect(env.call(557, handle, 64)).toBe(0);
    expect(env.messages).toEqual([]); env.memory.resolved.length = 0;
    expect(env.call(550, handle, 0, float32ToBits(100), 1)).toBe(1);
    expect(env.messages).toEqual(Array.from({ length: diagnostics }, () => "4:AAS_PresenceTypeBoundingBox: unknown presence type\n"));
    expect(env.memory.resolved).toEqual([]); expect(state.presenceType).toBe(presence);
    expect(state.moveFlags).toBe(0);
  });

  test("move-to-goal prints before crouch fallback and keeps the passed presence across the callback", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.memory.view(64, 68).setInt32(48, 6, true);
    expect(env.call(557, handle, 64)).toBe(0);
    writeQvmBotGoal(env.memory.view(300, 56), goal());
    env.runtime.beforePrint = () => {
      expect(state.presenceType).toBe(6); expect(env.traces).toEqual([]);
      state.presenceType = 2;
    };
    expect(env.call(549, 200, handle, 300, TravelFlags.DEFAULT)).toBe(0);
    expect(env.messages).toEqual(["4:AAS_PresenceTypeBoundingBox: unknown presence type\n"]);
    expect(env.traces[0]?.bounds).toEqual({ min: vec3(-15, -15, -24), max: vec3(15, 15, 8) });
    expect(env.traces[1]?.bounds).toEqual({ min: vec3(-15, -15, -6), max: vec3(15, 15, 22) });
    expect(env.memory.view(200, 52).getInt32(0, true)).toBe(0);
  });

  test("reachability-area calls the actual spatial owner with the source client and trace mask", () => {
    const env = fixture(); putVector(env.memory, 32, vec3(120, 0, 24));
    expect(env.call(553, 32, -9)).toBe(2);
    expect(env.traces[0]).toEqual({ start: vec3(120, 0, 24), end: vec3(120, 0, 21),
      bounds: { min: vec3(-15, -15, -24), max: vec3(15, 15, 8) }, pass: -9, mask: 1 | 0x10000 });
  });

  test("view-target gates avoid unused pointers for missing reachability and nonpositive lookahead", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.memory.resolved.length = 0;
    expect(env.call(554, handle, 4095, 0, float32ToBits(100), 0)).toBe(0);
    state.lastReachability = 1;
    expect(env.call(554, handle, 0, 0, float32ToBits(100), 0)).toBe(0);
    for (const lookahead of [0, -1, Number.NaN]) {
      expect(env.call(554, handle, 4095, 0, float32ToBits(lookahead), 0)).toBe(0);
    }
    expect(env.memory.resolved).toEqual([]);
  });

  test("view target writes lookahead, preserves writes on false, and clears invalid reach lookup", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    state.lastReachability = 1; state.lastArea = 1; state.lastGoalArea = 1;
    writeQvmBotGoal(env.memory.view(300, 56), goal());
    expect(env.call(554, handle, 300, TravelFlags.DEFAULT, float32ToBits(10.5), 200)).toBe(1);
    expect(getVector(env.memory, 200)).toEqual(vec3(10.5, 0, 24));
    expect(env.call(554, handle, 300, TravelFlags.DEFAULT, float32ToBits(1000), 200)).toBe(0);
    expect(getVector(env.memory, 200)).toEqual(vec3(120, 0, 24));
    state.lastReachability = 999;
    expect(env.call(554, handle, 300, TravelFlags.DEFAULT, float32ToBits(1000), 200)).toBe(0);
    expect(getVector(env.memory, 200)).toEqual(vec3(0, 0, 0));
  });

  test("view-target publishes each coordinate before a truncated destination fails", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    state.lastReachability = 1;
    expect(() => env.call(554, handle, 4095, TravelFlags.DEFAULT, float32ToBits(10), 4092)).toThrow(BinaryError);
    expect(env.memory.view(4092, 4).getFloat32(0, true)).toBe(10);
    expect(env.memory.resolved.includes(4095)).toBe(false);
  });

  test("view-target aliases remain visible to the goal origin read at the final segment", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    state.lastReachability = 1; state.lastArea = 1; state.lastGoalArea = 2;
    writeQvmBotGoal(env.memory.view(300, 56), goal(2, vec3(150, 0, 24)));
    expect(env.call(554, handle, 300, TravelFlags.DEFAULT, float32ToBits(200), 300)).toBe(1);
    expect(getVector(env.memory, 300)).toEqual(vec3(120, 0, 24));
    expect(env.memory.view(300, 56).getInt32(12, true)).toBe(2);
  });

  test("view-target forward copy observes each overlapping goal component after the preceding write", () => {
    const env = fixture(bitsToFloat32(2)), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    state.lastReachability = 1; state.lastArea = 1; state.lastGoalArea = 2;
    writeQvmBotGoal(env.memory.view(300, 56), goal(2, vec3(150, 40, 0)));
    expect(env.call(554, handle, 300, TravelFlags.DEFAULT, float32ToBits(1000), 304)).toBe(1);
    expect(getVector(env.memory, 304)).toEqual(vec3(150, 150, 150));
  });

  test("direct movement-target output owns its vector after the source endpoint changes", () => {
    const end = { x: 3, y: 4, z: 0 }, progress = { value: vec3(0, 0, 0), distance: 0 };
    expect(addToMovementTarget(vec3(0, 0, 0), end, 10, progress)).toBe(false);
    end.x = 99;
    expect(progress.value).toEqual(vec3(3, 4, 0));
    expect(progress.distance).toBe(5);
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    state.lastReachability = 1; state.lastArea = 1; state.lastGoalArea = 2;
    const origin = { x: 150, y: 40, z: 24 }, target = { value: vec3(0, 0, 0) };
    expect(env.routing.movementViewTarget(handle, goal(2, origin), TravelFlags.DEFAULT, 1000, target)).toBe(true);
    origin.x = 999;
    expect(target.value).toEqual(vec3(150, 40, 24));
  });

  test("visible-position gates null and zero goals before the required origin copy", () => {
    const env = fixture(); env.memory.resolved.length = 0;
    expect(env.call(572, 0, 1, 0, 0, 0)).toBe(0); expect(env.call(572, 0, 0, 4095, 0, 0)).toBe(0);
    expect(env.memory.resolved).toEqual([]);
    writeQvmBotGoal(env.memory.view(300, 56), goal(0));
    expect(env.call(572, 0, 1, 300, 0, 0)).toBe(0);
    writeQvmBotGoal(env.memory.view(300, 56), goal(1));
    expect(() => env.call(572, 0, 1, 300, 0, 0)).toThrow("nonnull pointer");
    putVector(env.memory, 32, vec3(0, 0, 24));
    expect(env.call(572, 32, 1, 300, 0, 0)).toBe(0);
  });

  test("movement queries read only the reached goal fields at the end of VM memory", () => {
    const env = fixture(), handle = env.initialize(), state = required(env.states.fromHandle(handle));
    env.memory.view(4080, 16).setInt32(12, 0, true);
    expect(env.call(572, 0, 1, 4080, TravelFlags.DEFAULT, 0)).toBe(0);
    env.memory.view(4080, 16).setInt32(12, 1, true);
    putVector(env.memory, 32, vec3(0, 0, 24));
    expect(env.call(572, 32, 1, 4080, TravelFlags.DEFAULT, 0)).toBe(0);
    state.lastReachability = 1; state.lastArea = 1; state.lastGoalArea = 1;
    expect(env.call(554, handle, 4080, TravelFlags.DEFAULT, float32ToBits(1000), 200)).toBe(0);
    expect(getVector(env.memory, 200)).toEqual(vec3(120, 0, 24));
    env.memory.view(4080, 16).setInt32(12, 2, true);
    expect(() => env.call(572, 32, 1, 4080, TravelFlags.DEFAULT, 200)).toThrow("exceeds allocation");
  });

  test("visible-position follows actual routes and traces, including source goal-area fallback", () => {
    const env = fixture(); putVector(env.memory, 32, vec3(0, 0, 24));
    writeQvmBotGoal(env.memory.view(300, 56), goal(2, vec3(150, 0, 24)));
    expect(env.call(572, 32, 1, 300, TravelFlags.DEFAULT, 200)).toBe(1);
    expect(getVector(env.memory, 200)).toEqual(vec3(30, 0, 24));
    expect(env.traces[0]).toEqual({ start: vec3(150, 0, 24), end: vec3(30, 0, 24), bounds: null, pass: 7, mask: 1 | 0x10000 });
    env.runtime.visible = false;
    expect(env.call(572, 32, 1, 300, TravelFlags.DEFAULT, 200)).toBe(1);
    expect(getVector(env.memory, 200)).toEqual(vec3(120, 0, 24));
    const before = env.memory.bytes.slice(200, 212);
    expect(env.call(572, 32, 1, 300, 0, 200)).toBe(0); expect(env.memory.bytes.subarray(200, 212)).toEqual(before);
  });
});
