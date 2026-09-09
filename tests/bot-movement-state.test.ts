import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { BotAvoidSpotType, BotMoveFlag, BotMoveResult, BotMoveState, BotMoveStateStore } from "../src/botlib/movement-state.ts";
import type { BotInitMove, BotMoveVariable } from "../src/botlib/movement-state.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";

// Both products, unchanged be_ai_move.c functions, native i386 -O2 -DNDEBUG:
// bash /tmp/quake3-bot-movestate-oracle-s1Rw8z/run.sh. Layout tries124, spots128, sizeof772.
function fixture(memory: BotMemory = new BotMemory()) {
  let now = 0;
  const trace: string[] = [], variables = new Map<string, { string: string; value: number }>();
  const store = new BotMoveStateStore({ time: () => now, print: (severity, text) => { trace.push(`${severity}:${text}`); },
    setBrushModelTypes: () => { trace.push("models"); }, libVar: (name, value): BotMoveVariable => {
      trace.push(`${name}=${value}`);
      let variable = variables.get(name);
      if (variable === undefined) { const numeric = Number(value); variable = { string: value, value: Number.isNaN(numeric) ? 0 : numeric }; variables.set(name, variable); }
      return variable;
    } }, memory);
  function state(handle = 1): BotMoveState { const value = store.fromHandle(handle); if (value === null) throw new Error("Missing test move state"); return value; }
  return { store, trace, variables, state, time: (value: number) => { now = value; } };
}
function input(): BotInitMove {
  return { origin: vec3(1, 2, 3), velocity: vec3(4, 5, 6), viewOffset: vec3(7, 8, 9), entityNum: 10, client: 11,
    thinkTime: 0.1, presenceType: 2, viewAngles: vec3(12, 13, 14), orMoveFlags: BotMoveFlag.ONGROUND | BotMoveFlag.WALK | BotMoveFlag.SWIMMING };
}

describe("source bot movement state lifetime", () => {
  test("source handles1..64, exhaustion0, reuse, independent slots and fatal print-return boundaries", () => {
    const f = fixture();
    for (let index = 1; index <= 64; index++) expect(f.store.allocate()).toBe(index);
    expect(f.store.allocate()).toBe(0); expect(f.state().avoidSpots).toHaveLength(32);
    expect([...f.state().avoidReach]).toEqual([0]); expect([...f.state().avoidReachTimes]).toEqual([0]); expect([...f.state().avoidReachTries]).toEqual([0]);
    expect(f.state(1)).not.toBe(f.state(2)); expect(f.state(1).avoidReach).not.toBe(f.state(2).avoidReach);
    const first = f.state().avoidSpots[0], next = f.state().avoidSpots[1]; expect(first).not.toBe(next);
    f.store.free(4); expect(f.store.allocate()).toBe(4);
    f.store.free(4); f.store.free(4); f.store.free(0); f.store.free(65);
    expect(f.trace).toEqual(["4:invalid move state 4\n", "4:move state handle 0 out of range\n", "4:move state handle 65 out of range\n"]);
    expect(f.store.fromHandle(-1)).toBeNull();
  });
  test("initialize copies all input and changes only five externally supplied movement flags", () => {
    const f = fixture(); f.store.allocate(); const state = f.state();
    state.moveFlags = 0xffff; state.lastReachability = 77; state.avoidReach[0] = 8;
    const init = input(); f.store.initialize(1, init);
    const mask = BotMoveFlag.ONGROUND | BotMoveFlag.TELEPORTED | BotMoveFlag.WATERJUMP | BotMoveFlag.WALK | BotMoveFlag.GRAPPLEPULL;
    expect(state.moveFlags).toBe((0xffff & ~mask) | (init.orMoveFlags & mask));
    expect(state.origin).toEqual(init.origin); expect(state.origin).not.toBe(init.origin);
    expect(state.velocity).toEqual(init.velocity); expect(state.viewOffset).toEqual(init.viewOffset); expect(state.viewAngles).toEqual(init.viewAngles);
    expect(state.entityNum).toBe(10); expect(state.client).toBe(11); expect(state.thinkTime).toBe(Math.fround(0.1)); expect(state.presenceType).toBe(2);
    expect(state.lastReachability).toBe(77); expect(state.avoidReach[0]).toBe(8);
    f.store.initialize(1, { ...init, orMoveFlags: 0 }); expect(state.moveFlags & mask).toBe(0); expect(state.moveFlags & BotMoveFlag.SWIMMING).toBe(BotMoveFlag.SWIMMING);
  });
  test("whole-state reset zeroes every scalar/vector and slot while preserving allocated state identity", () => {
    const f = fixture(); f.store.allocate(); const state = f.state(), reach = state.avoidReach, spots = state.avoidSpots, spot = spots[0];
    Object.assign(state, { origin: vec3(1, 2, 3), velocity: vec3(4, 5, 6), viewOffset: vec3(7, 8, 9), entityNum: 10, client: 11,
      thinkTime: 12, presenceType: 2, viewAngles: vec3(13, 14, 15), area: 16, lastArea: 17, lastGoalArea: 18, lastReachability: 19,
      lastOrigin: vec3(20, 21, 22), reachArea: 23, moveFlags: 24, jumpReach: 25, grappleVisibleTime: 26, lastGrappleDistance: 27, reachabilityTime: 28 } satisfies Partial<BotMoveState>);
    state.avoidReach[0] = 29; state.avoidReachTimes[0] = 30; state.avoidReachTries[0] = 31;
    for (let index = 0; index < 32; index++) f.store.addAvoidSpot(1, vec3(index + 1, 2, 3), 4, BotAvoidSpotType.ALWAYS);
    f.store.reset(1); expect(f.state()).toBe(state); expect(state).toEqual(new BotMoveState());
    expect(state.avoidReach).toBe(reach); expect(state.avoidSpots).toBe(spots); expect(state.avoidSpots[0]).toBe(spot);
  });
  test("avoid-reach add uses strict expired slots and retries reset at equality", () => {
    const f = fixture(); f.store.allocate(); const state = f.state();
    f.store.addToAvoidReach(state, 7, 6); expect([state.avoidReach[0], state.avoidReachTimes[0], state.avoidReachTries[0]]).toEqual([0, 0, 0]);
    f.time(1); f.store.addToAvoidReach(state, 7, 6); f.store.addToAvoidReach(state, 7, 6);
    expect([state.avoidReach[0], state.avoidReachTimes[0], state.avoidReachTries[0]]).toEqual([7, 7, 2]);
    f.time(7); f.store.addToAvoidReach(state, 8, 6); expect(state.avoidReach[0]).toBe(7);
    f.store.addToAvoidReach(state, 7, 6); expect([state.avoidReachTimes[0], state.avoidReachTries[0]]).toEqual([13, 1]);
    f.time(13.01); f.store.addToAvoidReach(state, 8, 0.1); expect(state.avoidReach[0]).toBe(8);
    expect(state.avoidReachTimes[0]).toBe(Math.fround(Math.fround(13.01) + Math.fround(0.1)));
    state.lastReachability = 55; f.store.resetAvoidReach(1); expect([...state.avoidReach]).toEqual([0]); expect([...state.avoidReachTimes]).toEqual([0]); expect([...state.avoidReachTries]).toEqual([0]); expect(state.lastReachability).toBe(55);
  });
  test("native layout ResetLastAvoid reads the next float word and decrements only its selected counter", () => {
    const f = fixture(); f.store.allocate(); const state = f.state(), spot = state.avoidSpots[0];
    if (spot === undefined) throw new Error("Missing source avoid spot");
    for (const [x, expected] of [[0, 3], [1, 2], [-1, 3], [-0, 3], [0.25, 2]] satisfies readonly (readonly [number, number])[]) {
      state.avoidReach[0] = 7; state.avoidReachTimes[0] = 10; state.avoidReachTries[0] = 3; spot.origin = vec3(x, 8, 9);
      f.store.resetLastAvoidReach(1); expect(state.avoidReachTimes[0]).toBe(0); expect(state.avoidReachTries[0]).toBe(expected);
      expect(state.avoidReach[0]).toBe(7); expect(spot.origin).toEqual(vec3(x, 8, 9));
    }
    state.avoidReachTimes[0] = -1; f.store.resetLastAvoidReach(1); expect(state.avoidReachTimes[0]).toBe(-1);
  });
  test("avoid spot capacity ignores excess and CLEAR preserves the unused slot contents", () => {
    const f = fixture(); f.store.allocate(); const state = f.state();
    for (let index = 0; index < 33; index++) f.store.addAvoidSpot(1, vec3(index, 2, 3), 0.1, 2);
    expect(state.numAvoidSpots).toBe(32); expect(state.avoidSpots[31]?.origin.x).toBe(31); expect(state.avoidSpots[0]?.radius).toBe(Math.fround(0.1));
    f.store.addAvoidSpot(1, vec3(9, 9, 9), 7, 0); expect(state.numAvoidSpots).toBe(0); expect(state.avoidSpots[31]?.origin.x).toBe(31);
    f.store.addAvoidSpot(1, vec3(100, 0, 0), 5, 1); expect(state.numAvoidSpots).toBe(1); expect(state.avoidSpots[0]?.origin.x).toBe(100);
  });
  test("setup refreshes models first and retains actual variable records; shutdown only frees states", () => {
    const f = fixture(); const handle = f.store.allocate();
    expect(f.store.svMaxStep).toBeNull(); expect(f.store.setup()).toBe(0);
    expect(f.trace).toEqual(["models", "sv_step=18", "sv_maxbarrier=32", "sv_gravity=800", "weapindex_rocketlauncher=5", "weapindex_bfg10k=9",
      "weapindex_grapple=10", "entitytypemissile=3", "offhandgrapple=0", "cmd_grappleon=grappleon", "cmd_grappleoff=grappleoff"]);
    const variable = f.variables.get("sv_step"); if (variable === undefined) throw new Error("Missing registered variable"); variable.value = 24;
    expect(f.store.svMaxStep?.value).toBe(24); f.store.shutdown(); expect(f.store.fromHandle(handle)).toBeNull(); expect(f.store.svMaxStep).toBe(variable);
    expect(f.store.allocate()).toBe(1); expect(new BotMoveResult()).toEqual({ failure: false, type: 0, blocked: false, blockEntity: 0,
      travelType: 0, flags: 0, weapon: 0, moveDirection: vec3(0, 0, 0), idealViewAngles: vec3(0, 0, 0) });
  });
});

class ObservedBotMemory extends BotMemory {
  readonly blocks: BotMemoryAllocation[] = [];
  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    const block = super.allocate(size, kind, clear);
    this.blocks.push(block);
    return block;
  }
}

class SwitchingMoveMemory extends BotMemory {
  current = new Uint8Array(772);
  readonly events: string[] = [];
  override allocate(): BotMemoryAllocation {
    const owner = this;
    return { get bytes(): Uint8Array { owner.events.push("bytes"); return owner.current; } };
  }
}

test("movement views check each borrow and follow replacement byte buffers and ranges", () => {
  const memory = new SwitchingMoveMemory(), state = new BotMoveState(memory);
  expect(memory.events).toEqual([]);
  state.area = 31;
  expect(state.area).toBe(31);
  expect(memory.events).toEqual(["bytes", "bytes"]);
  const original = memory.current;
  memory.current = original.subarray(4);
  state.area = 41;
  expect(new DataView(original.buffer).getInt32(68, true)).toBe(41);
  memory.current = original.subarray(4, 8);
  expect(() => state.area).toThrow(RangeError);
  memory.current = new Uint8Array(772);
  expect(state.area).toBe(0);
  state.origin.x = 0.1;
  expect(new DataView(memory.current.buffer).getFloat32(0, true)).toBe(Math.fround(0.1));
});

test("whole movement vector writes retain the reached view through foreign getter reentry and failure", () => {
  const memory = new SwitchingMoveMemory(), state = new BotMoveState(memory), original = memory.current;
  state.origin = {
    get x(): number {
      memory.events.push("x");
      memory.current = new Uint8Array(772);
      state.area = 73;
      return 1;
    },
    get y(): number { memory.events.push("y"); return 2; },
    get z(): number { memory.events.push("z"); return 3; },
  };
  expect(memory.events).toEqual(["bytes", "x", "bytes", "y", "z"]);
  const data = new DataView(original.buffer);
  expect([0, 4, 8].map(offset => data.getFloat32(offset, true))).toEqual([1, 2, 3]);
  expect(state.origin.x).toBe(0);
  expect(state.area).toBe(73);
  expect(() => { state.origin = {
    x: 7,
    get y(): number { throw new Error("foreign y"); },
    z: 9,
  }; }).toThrow("foreign y");
  expect(state.origin.x).toBe(7);
  expect(state.origin.z).toBe(0);
});

describe("movement records in the actual source zone", () => {
  test("all source fields occupy their release32 words and retained views read live bytes", () => {
    const zone = new ZoneArena(4096), memory = new ObservedBotMemory({ kind: "unaccounted" }, zone);
    const f = fixture(memory), available = zone.memoryRemaining();
    expect(f.store.allocate()).toBe(1);
    const block = memory.blocks[0];
    if (block === undefined) throw new Error("Missing movement allocation");
    const bytes = block.bytes, data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), state = f.state();
    // 772 payload + l_memory's 4-byte ID + zone's 20-byte header and 4-byte tail.
    expect(bytes.byteLength).toBe(772); expect(available - zone.memoryRemaining()).toBe(800);
    expect(bytes.every(value => value === 0)).toBe(true);
    const origin = state.origin, reach = state.avoidReach, first = state.avoidSpots[0], last = state.avoidSpots[31];
    if (first === undefined || last === undefined) throw new Error("Missing avoid spot");
    const spotOrigin = first.origin;
    Object.assign(state, {
      origin: vec3(1, 2, 3), velocity: vec3(4, 5, 6), viewOffset: vec3(7, 8, 9), entityNum: 10, client: 11,
      thinkTime: 12.1, presenceType: 2, viewAngles: vec3(13, 14, 15), area: 16, lastArea: 17, lastGoalArea: 18,
      lastReachability: 19, lastOrigin: vec3(20, 21, 22), reachArea: 23, moveFlags: 24, jumpReach: 25,
      grappleVisibleTime: 26.1, lastGrappleDistance: 27.1, reachabilityTime: 28.1,
    } satisfies Partial<BotMoveState>);
    for (const [offset, expected] of [
      [0, 1], [4, 2], [8, 3], [12, 4], [16, 5], [20, 6], [24, 7], [28, 8], [32, 9], [44, 12.1],
      [52, 13], [56, 14], [60, 15], [80, 20], [84, 21], [88, 22], [104, 26.1], [108, 27.1], [112, 28.1],
    ] satisfies readonly (readonly [number, number])[]) expect(data.getFloat32(offset, true)).toBe(Math.fround(expected));
    for (const [offset, expected] of [
      [36, 10], [40, 11], [48, 2], [64, 16], [68, 17], [72, 18], [76, 19], [92, 23], [96, 24], [100, 25],
    ] satisfies readonly (readonly [number, number])[]) expect(data.getInt32(offset, true)).toBe(expected);
    state.entityNum = 0x80000001; state.avoidReach[0] = 0xffffffff; state.avoidReachTimes[0] = 0.1; state.avoidReachTries[0] = 0x80000000;
    expect(data.getInt32(36, true)).toBe(-2147483647); expect(data.getInt32(116, true)).toBe(-1);
    expect(data.getFloat32(120, true)).toBe(Math.fround(0.1)); expect(data.getInt32(124, true)).toBe(-2147483648);
    first.origin = { x: 0.1, y: 0.2, z: 0.3 }; first.radius = 0.4; first.type = 0xffffffff;
    last.origin = vec3(40, 41, 42); last.radius = 43; last.type = 44; state.numAvoidSpots = 32;
    expect([128, 132, 136, 140].map(offset => data.getFloat32(offset, true))).toEqual([0.1, 0.2, 0.3, 0.4].map(Math.fround));
    expect(data.getInt32(144, true)).toBe(-1);
    expect([748, 752, 756, 760].map(offset => data.getFloat32(offset, true))).toEqual([40, 41, 42, 43]);
    expect(data.getInt32(764, true)).toBe(44); expect(data.getInt32(768, true)).toBe(32);
    data.setFloat32(0, 0.7, true); data.setInt32(64, 93, true); data.setInt32(116, 94, true); data.setFloat32(128, 0.8, true);
    expect(origin.x).toBe(Math.fround(0.7)); expect(state.area).toBe(93); expect(reach[0]).toBe(94); expect(spotOrigin.x).toBe(Math.fround(0.8));
    origin.y = 0.9; expect(data.getFloat32(4, true)).toBe(Math.fround(0.9));
    f.store.reset(1);
    expect(bytes.every(value => value === 0)).toBe(true); expect(state.origin).toBe(origin); expect(first.origin).toBe(spotOrigin);
    expect(origin.x).toBe(0); expect(reach[0]).toBe(0); expect(spotOrigin.x).toBe(0); expect(available - zone.memoryRemaining()).toBe(800);
    f.store.free(1); expect(zone.memoryRemaining()).toBe(available);
    expect(() => state.area).toThrow(); expect(() => origin.x).toThrow(); expect(() => { reach[0] = 1; }).toThrow(); expect(() => spotOrigin.x).toThrow();
    zone.checkHeap();
  });

  test("zone exhaustion leaves no published slot, and shutdown frees every real allocation", () => {
    const zone = new ZoneArena(1700), memory = new ObservedBotMemory({ kind: "unaccounted" }, zone), f = fixture(memory);
    const available = zone.memoryRemaining();
    expect(f.store.allocate()).toBe(1); expect(f.store.allocate()).toBe(2);
    const retained = f.state(1);
    expect(() => f.store.allocate()).toThrow("Z_Malloc"); expect(f.store.fromHandle(3)).toBeNull();
    expect(memory.blocks).toHaveLength(2); f.store.free(1); expect(f.store.allocate()).toBe(1);
    expect(f.state(1)).not.toBe(retained); expect(f.state(1).origin).toEqual(vec3(0, 0, 0));
    f.store.shutdown(); expect(zone.memoryRemaining()).toBe(available);
    for (const block of memory.blocks) expect(() => block.bytes).toThrow();
    f.store.shutdown(); zone.checkHeap();
  });

  test("zone tag reclamation invalidates previously retained scalar, vector and array access", () => {
    const zone = new ZoneArena(4096), f = fixture(new BotMemory({ kind: "unaccounted" }, zone));
    f.store.allocate(); const state = f.state(), origin = state.origin, tries = state.avoidReachTries;
    expect(state.thinkTime).toBe(0); expect(origin.z).toBe(0); expect(tries[0]).toBe(0);
    zone.freeTags(ZoneTag.Botlib);
    expect(() => state.thinkTime).toThrow(); expect(() => { origin.z = 1; }).toThrow(); expect(() => tries[0]).toThrow();
    zone.checkHeap();
  });
});
