import { expect, test } from "bun:test";
import { vec3 } from "../../src/core/math.ts";
import { BotInventory } from "../../src/game/ai-definitions.ts";
import { botAddDeltaAngles, botSubtractDeltaAngles } from "../../src/game/ai-input.ts";
import { GameMemory, GameMemoryAllocation } from "../../src/game/memory.ts";
import { BOT_STATE_SOURCE_BYTES, BotState, BotStateStore, BotWaypoint, copyBotPlayerState } from "../../src/game/ai-state.ts";
import type { BotSetupProgress } from "../../src/game/ai-state.ts";
import type { Product } from "../../src/shared/definitions.ts";
import { MoveType, Weapon, WeaponState, statSchema } from "../../src/shared/definitions.ts";
import { PlayerState, PlayerStateSlots } from "../../src/shared/player-state.ts";
import { readQvmPlayerState, writeQvmPlayerState } from "../../src/vm/player-record.ts";

test("BotResetState preserves source fields and shutdown clears the same slot and embedded storage", () => {
  const products: readonly Product[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const store = new BotStateStore(product);
    const memory = new GameMemory(() => 0, () => {});
    expect(store.get(63)).toBeNull();
    const state = store.acquire(63, memory), other = store.acquire(1, memory);
    expect(store.acquire(63, memory)).toBe(state);
    expect(state.client).toBe(0);
    expect(state.enemy).toBe(0);
    expect(state.settings.skill).toBe(0);
    expect(state.inventory).toHaveLength(256);
    expect(state.entityEventTime).toHaveLength(1024);
    expect(state.proxMines).toHaveLength(64);
    expect(state.activateGoalHeap).toHaveLength(8);
    const activation = state.activateGoalHeap[7];
    if (activation === undefined) throw new Error("Missing source activation slot");
    const ps = state.curPs, stats = ps.stats, playerOrigin = ps.origin;
    const command = state.lastUcmd, commandAngles = command.angles, origin = state.origin;
    const inventory = state.inventory, events = state.entityEventTime, mines = state.proxMines;
    const teamGoal = state.teamGoal, goalOrigin = teamGoal.origin, heap = state.activateGoalHeap;
    const areas = activation.areas, activationGoal = activation.goal;
    const current = new PlayerState(product);
    current.origin = vec3(11, 22, 33);
    current.velocity = vec3(4, 5, 6);
    current.health = 137;
    current.weapon = Weapon.WP_ROCKET_LAUNCHER;
    current.deltaAngles = vec3(100, 200, 300);
    current.events.set(1, 23);
    current.eventParms.set(1, 55);
    current.powerups.set(7, 456);
    current.ammo.set(5, 19);
    copyBotPlayerState(ps, current);
    expect(ps).toEqual(current);
    expect(ps.origin).toBe(playerOrigin);
    expect(ps.origin).not.toBe(current.origin);
    expect(ps.stats).toBe(stats);
    expect(ps.stats).not.toBe(current.stats);
    const residue: BotSetupProgress = { kind: "failed", stage: "weapon-weights", errorCode: 7 };
    state.setup = residue;
    state.inuse = true;
    state.client = 63;
    state.entityNum = 63;
    state.character = 11;
    state.ms = 12;
    state.gs = 13;
    state.cs = 14;
    state.ws = 15;
    state.enterGameTime = 1.25;
    Object.assign(state.settings, { characterfile: "bots/sarge_c.c", skill: 4.5, team: "red" });
    state.botThinkResidual = 77;
    state.aiNode = "battle-fight";
    state.enemy = -1;
    state.setupCount = 4;
    state.walker = 0.5;
    state.lastAirTime = 10;
    state.invulnerabilityTime = 19;
    state.weaponNum = 7;
    Object.assign(origin, vec3(10, 20, 30));
    state.lastUcmd.weapon = Weapon.WP_RAILGUN;
    state.lastUcmd.serverTime = 1000;
    state.inventory[BotInventory.HEALTH] = 137;
    state.entityEventTime[1023] = 987;
    state.proxMines[63] = 777;
    state.teamGoal.copyFrom({ origin: vec3(1, 2, 3), area: 9, mins: vec3(-8, -8, -8),
      maxs: vec3(8, 8, 8), entity: 22, number: 31, flags: 7, itemInfo: 3 });
    activation.inuse = true;
    activation.goal.copyFrom(state.teamGoal);
    activation.areas[31] = 222;
    activation.numAreas = 32;
    activation.areasDisabled = true;
    activation.justUsedTime = 45;
    state.activateStack = activation;
    state.checkpoints = new BotWaypoint();
    state.patrolPoints = new BotWaypoint();
    state.currentPatrolPoint = state.patrolPoints;
    state.teamLeader = "Leader";
    state.ordered = true;
    state.resetDecisionState();

    const expected = new BotState(product, state.sourceAllocation);
    expected.inuse = true;
    expected.client = 63;
    expected.entityNum = 63;
    expected.character = 11;
    expected.ms = 12;
    expected.gs = 13;
    expected.cs = 14;
    expected.ws = 15;
    expected.enterGameTime = 1.25;
    expected.setup = residue;
    Object.assign(expected.settings, { characterfile: "bots/sarge_c.c", skill: 4.5, team: "red" });
    copyBotPlayerState(expected.curPs, current);
    expect(state).toEqual(expected);
    expect(state.setup).toBe(residue);
    expect(state.curPs).toBe(ps);
    expect(state.curPs.stats).toBe(stats);
    expect(state.lastUcmd).toBe(command);
    expect(state.lastUcmd.angles).toBe(commandAngles);
    expect(state.origin).toBe(origin);
    expect(state.inventory).toBe(inventory);
    expect(state.entityEventTime).toBe(events);
    expect(state.proxMines).toBe(mines);
    expect(state.teamGoal).toBe(teamGoal);
    expect(state.teamGoal.origin).toBe(goalOrigin);
    expect(state.activateGoalHeap).toBe(heap);
    expect(state.activateGoalHeap[7]).toBe(activation);
    expect(activation.goal).toBe(activationGoal);
    expect(activation.areas).toBe(areas);
    expect(other).toEqual(new BotState(product, other.sourceAllocation));

    state.clear();
    expect(state).toEqual(new BotState(product, state.sourceAllocation));
    expect(store.acquire(63, memory)).toBe(state);
    expect(state.curPs).toBe(ps);
    expect(state.curPs.stats).toBe(stats);
    expect(state.curPs.origin).toBe(playerOrigin);
    expect(state.inventory).toBe(inventory);
    expect(state.activateGoalHeap[7]).toBe(activation);
    state.setup = { kind: "complete" };
    expect(state.inuse).toBe(false);
    state.character = 31;
    store.clear();
    expect(store.get(63)).toBeNull();
    expect(state.character).toBe(31);
    expect(store.acquire(63, memory)).not.toBe(state);
    expect(() => store.acquire(64, memory)).toThrow(RangeError);
    expect(() => store.get(-1)).toThrow(RangeError);
  }
});

test("bot numeric fields, command bytes and fixed arrays use the actual G_Alloc record", () => {
  const products: readonly Product[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const memory = new GameMemory(() => 0, () => {});
    const prefix = memory.allocate(17);
    prefix.bytes.fill(0x5a);
    const state = new BotStateStore(product).acquire(4, memory);
    const allocation = state.sourceAllocation;
    if (allocation === null) throw new Error("BotStateStore omitted source allocation");
    const view = new DataView(allocation.bytes.buffer, allocation.bytes.byteOffset, allocation.bytes.byteLength);
    expect(view.byteLength).toBe(9088);
    expect(view.byteOffset).toBe(32);
    state.inuse = true;
    state.client = 0x1_0000_0004;
    state.enemy = 0xffff_ffff;
    state.thinkTime = 1 / 3;
    state.ownDecisionTime = 99.75;
    state.settings.skill = 2 / 3;
    expect(view.getInt32(0, true)).toBe(1);
    expect(view.getInt32(8, true)).toBe(4);
    expect(view.getInt32(6540, true)).toBe(-1);
    expect(view.getFloat32(4904, true)).toBe(Math.fround(1 / 3));
    expect(state.thinkTime).toBe(Math.fround(1 / 3));
    expect(view.getInt32(6620, true)).toBe(99);
    expect(state.ownDecisionTime).toBe(99);
    expect(view.getFloat32(4752, true)).toBe(Math.fround(2 / 3));

    const origin = state.origin;
    state.origin = { x: 1 / 3, y: -0, z: 17 };
    expect(state.origin).toBe(origin);
    expect(view.getFloat32(4908, true)).toBe(Math.fround(1 / 3));
    expect(Object.is(view.getFloat32(4912, true), -0)).toBe(true);
    view.setFloat32(4916, 29.5, true);
    expect(origin.z).toBe(29.5);
    view.setInt32(0, -7, true);
    expect(state.inuse).toBe(true);

    state.entityEventTime[1023] = 12345;
    state.inventory[29] = 0x1_0000_0003;
    state.proxMines[63] = -12;
    expect(view.getInt32(4604, true)).toBe(12345);
    expect(view.getInt32(5068, true)).toBe(3);
    expect(state.inventory[29]).toBe(3);
    expect(view.getInt32(6512, true)).toBe(-12);
    view.setInt32(4952, -23, true);
    expect(state.inventory[0]).toBe(-23);
    state.inventory.fill(7);
    expect(view.getInt32(4952, true)).toBe(7);
    expect(view.getInt32(5972, true)).toBe(7);

    const angles = state.lastUcmd.angles;
    state.lastUcmd.angles = { x: 0x7fff_fffe, y: -0x7fff_fffd, z: 0x1_0000_0003 };
    state.lastUcmd.serverTime = 1234;
    state.lastUcmd.buttons = -1;
    state.lastUcmd.weapon = Weapon.WP_ROCKET_LAUNCHER;
    state.lastUcmd.forwardmove = 200;
    state.lastUcmd.rightmove = -129;
    state.lastUcmd.upmove = -5;
    expect(state.lastUcmd.angles).toBe(angles);
    expect(view.getInt32(488, true)).toBe(1234);
    expect(view.getInt32(492, true)).toBe(0x7fff_fffe);
    expect(view.getInt32(496, true)).toBe(-0x7fff_fffd);
    expect(view.getInt32(500, true)).toBe(3);
    expect(view.getInt32(504, true)).toBe(-1);
    expect(view.getUint8(508)).toBe(5);
    expect(view.getInt8(509)).toBe(-56);
    expect(state.lastUcmd.forwardmove).toBe(-56);
    expect(view.getInt8(510)).toBe(127);
    expect(view.getInt8(511)).toBe(-5);
    expect(prefix.bytes).toEqual(new Uint8Array(17).fill(0x5a));
    view.setUint8(508, 255);
    expect(() => state.lastUcmd.weapon).toThrow("Unsupported bot command weapon 255");
    view.setInt32(4932, 3, true);
    expect(() => state.presenceType).toThrow("Unsupported bot presence type 3");
  }
});

test("inline goal publication and every activation slot consume source bytes", () => {
  const memory = new GameMemory(() => 0, () => {});
  const state = new BotStateStore("baseq3").acquire(0, memory);
  const allocation = state.sourceAllocation;
  if (allocation === null) throw new Error("BotStateStore omitted source allocation");
  const view = new DataView(allocation.bytes.buffer, allocation.bytes.byteOffset, allocation.bytes.byteLength);
  const goals = [state.teamGoal, state.altRouteGoal, state.lastGoalTeamGoal, state.leadTeamGoal, state.formationGoal];
  const offsets = [6624, 6680, 6768, 6828, 7060];
  for (let index = 0; index < goals.length; index++) {
    const goal = goals[index], offset = offsets[index];
    if (goal === undefined || offset === undefined) throw new Error("Missing source goal fixture");
    const origin = goal.origin;
    goal.origin = { x: 1 / 3, y: index, z: 9 };
    goal.area = 29;
    goal.mins = { x: -11, y: -12, z: -13 };
    goal.maxs = { x: 11, y: 12, z: 13 };
    goal.entity = 31;
    goal.number = 37;
    goal.flags = -1;
    goal.itemInfo = 41;
    expect(goal.origin).toBe(origin);
    expect(view.getFloat32(offset, true)).toBe(Math.fround(1 / 3));
    expect(view.getInt32(offset + 12, true)).toBe(29);
    expect(view.getFloat32(offset + 24, true)).toBe(-13);
    expect(view.getFloat32(offset + 36, true)).toBe(13);
    expect(view.getInt32(offset + 40, true)).toBe(31);
    expect(view.getInt32(offset + 44, true)).toBe(37);
    expect(view.getInt32(offset + 48, true)).toBe(-1);
    expect(view.getInt32(offset + 52, true)).toBe(41);
    view.setInt32(offset + 12, 51, true);
    expect(goal.area).toBe(51);
    expect({ ...goal }).toEqual({ origin: { x: Math.fround(1 / 3), y: index, z: 9 }, area: 51,
      mins: { x: -11, y: -12, z: -13 }, maxs: { x: 11, y: 12, z: 13 },
      entity: 31, number: 37, flags: -1, itemInfo: 41 });
  }
  for (let index = 0; index < 8; index++) {
    const activation = state.activateGoalHeap[index];
    if (activation === undefined) throw new Error("Missing source activation fixture");
    const offset = 7120 + 244 * index;
    activation.inuse = true;
    activation.goal.copyFrom(state.teamGoal);
    activation.time = 1 / 3;
    activation.startTime = 2 / 3;
    activation.justUsedTime = 4 / 3;
    activation.shoot = true;
    activation.weapon = 7;
    activation.target = { x: 11, y: 12, z: 13 };
    activation.origin = { x: -11, y: -12, z: -13 };
    activation.areas[31] = 71 + index;
    activation.numAreas = 32;
    activation.areasDisabled = true;
    expect(view.getInt32(offset, true)).toBe(1);
    expect(view.getInt32(offset + 16, true)).toBe(51);
    expect(view.getFloat32(offset + 60, true)).toBe(Math.fround(1 / 3));
    expect(view.getFloat32(offset + 64, true)).toBe(Math.fround(2 / 3));
    expect(view.getFloat32(offset + 68, true)).toBe(Math.fround(4 / 3));
    expect(view.getInt32(offset + 72, true)).toBe(1);
    expect(view.getInt32(offset + 76, true)).toBe(7);
    expect(view.getFloat32(offset + 88, true)).toBe(13);
    expect(view.getFloat32(offset + 100, true)).toBe(-13);
    expect(view.getInt32(offset + 228, true)).toBe(71 + index);
    expect(view.getInt32(offset + 232, true)).toBe(32);
    expect(view.getInt32(offset + 236, true)).toBe(1);
    view.setInt32(offset + 104, -91, true);
    expect(activation.areas[0]).toBe(-91);
  }
});

test("attaching retained storage does not clear it and reset preserves exact source ranges", () => {
  const bytes = new Uint8Array(BOT_STATE_SOURCE_BYTES + 7).fill(0xa5);
  const state = new BotState("missionpack", new GameMemoryAllocation(bytes));
  expect(bytes).toEqual(new Uint8Array(BOT_STATE_SOURCE_BYTES + 7).fill(0xa5));
  const before = bytes.slice(0, BOT_STATE_SOURCE_BYTES);
  const expected = new Uint8Array(BOT_STATE_SOURCE_BYTES);
  const preserved: readonly (readonly [number, number])[] = [
    [0, 4], [8, 484], [4608, 4900], [6064, 6068], [6520, 6540],
  ];
  for (const [start, end] of preserved) expected.set(before.subarray(start, end), start);
  const origin = state.origin, inventory = state.inventory, goal = state.teamGoal;
  state.resetDecisionState();
  expect(bytes.subarray(0, BOT_STATE_SOURCE_BYTES)).toEqual(expected);
  expect(state.origin).toBe(origin);
  expect(state.inventory).toBe(inventory);
  expect(state.teamGoal).toBe(goal);
  state.clear();
  expect(bytes.subarray(0, BOT_STATE_SOURCE_BYTES)).toEqual(new Uint8Array(BOT_STATE_SOURCE_BYTES));
  expect(bytes.subarray(BOT_STATE_SOURCE_BYTES)).toEqual(new Uint8Array(7).fill(0xa5));
  expect(() => new BotState("baseq3", new GameMemoryAllocation(new Uint8Array(9087)))).toThrow(RangeError);
});

test("G_InitMemory reuse aliases actual bot fields and diagnostic storage stays independent", () => {
  const memory = new GameMemory(() => 0, () => {});
  const store = new BotStateStore("baseq3");
  const old = store.acquire(1, memory);
  old.character = 65;
  old.inventory[29] = 137;
  memory.initialize();
  store.clear();
  const reused = store.acquire(1, memory);
  expect(reused).not.toBe(old);
  expect(reused.character).toBe(65);
  expect(reused.inventory[29]).toBe(137);
  reused.inventory[29] = 19;
  expect(old.inventory[29]).toBe(19);
  const charged = memory.allocatedBytes;
  const diagnostic = new BotState("baseq3");
  diagnostic.thinkTime = 1 / 3;
  diagnostic.inventory[29] = 9;
  expect(diagnostic.thinkTime).toBe(Math.fround(1 / 3));
  expect(memory.allocatedBytes).toBe(charged);
  expect(reused.inventory[29]).toBe(19);
  diagnostic.clear();
  expect(diagnostic.inventory[29]).toBe(0);
  expect(reused.inventory[29]).toBe(19);
});

test("embedded player state shares all 468 source bytes and retains its ordinary copy APIs", () => {
  const products: readonly Product[] = ["baseq3", "missionpack"];
  for (const product of products) {
    const memory = new GameMemory(() => 0, () => {});
    const state = new BotStateStore(product).acquire(1, memory);
    const allocation = state.sourceAllocation;
    if (allocation === null) throw new Error("BotStateStore omitted source allocation");
    const view = new DataView(allocation.bytes.buffer, allocation.bytes.byteOffset + 16, 468);
    for (let index = 0; index < 117; index++) view.setInt32(index * 4, 500000 + index, true);
    for (const offset of [20, 24, 28, 32, 36, 40, 92, 96, 100, 152, 156, 160]) {
      view.setFloat32(offset, offset / 8, true);
    }
    view.setInt32(4, MoveType.PM_SPECTATOR, true);
    view.setInt32(144, product === "baseq3" ? Weapon.WP_RAILGUN : Weapon.WP_CHAINGUN, true);
    view.setInt32(148, WeaponState.WEAPON_FIRING, true);
    const expected = readQvmPlayerState(view, product);
    expect(state.curPs).toEqual(expected);
    expect(state.curPs.copy()).toEqual(expected);
    expect(state.curPs.stats.get(statSchema(product).weapons)).toBe(500000 + 46 + statSchema(product).weapons);

    const player = state.curPs, origin = player.origin, angles = player.deltaAngles, stats = player.stats;
    const copy = player.copy();
    player.origin = { x: 1 / 3, y: -0, z: 7 };
    player.deltaAngles = { x: 16777217, y: -2147483648, z: 2147483647 };
    player.commandTime = 0x1_0000_0005;
    player.health = 137;
    player.stats.set(15, 0xffff_ffff);
    expect(player.origin).toBe(origin);
    expect(player.deltaAngles).toBe(angles);
    expect(player.stats).toBe(stats);
    expect(view.getFloat32(20, true)).toBe(Math.fround(1 / 3));
    expect(Object.is(view.getFloat32(24, true), -0)).toBe(true);
    expect(view.getInt32(56, true)).toBe(16777217);
    expect(view.getInt32(60, true)).toBe(-2147483648);
    expect(view.getInt32(64, true)).toBe(2147483647);
    expect(view.getInt32(0, true)).toBe(5);
    expect(view.getInt32(184 + 4 * statSchema(product).health, true)).toBe(137);
    expect(view.getInt32(244, true)).toBe(-1);
    expect(copy).toEqual(expected);
    player.eventSequence = 9;
    expect(player.addEvent(73, 91)).toEqual({ sequence: 9, event: 73, parameter: 91 });
    expect(view.getInt32(108, true)).toBe(10);
    expect(view.getInt32(116, true)).toBe(73);
    expect(view.getInt32(124, true)).toBe(91);

    copyBotPlayerState(player, expected);
    expect(player.origin).toBe(origin);
    expect(player.deltaAngles).toBe(angles);
    expect(player.stats).toBe(stats);
    const encoded = new Uint8Array(468);
    writeQvmPlayerState(new DataView(encoded.buffer), expected);
    expect(allocation.bytes.subarray(16, 484)).toEqual(encoded);
    const detached = new PlayerState(product), detachedStats = detached.stats, detachedOrigin = detached.origin;
    copyBotPlayerState(detached, player);
    expect(detached).toEqual(expected);
    expect(detached.stats).toBe(detachedStats);
    expect(detached.origin).toBe(detachedOrigin);
    state.resetDecisionState();
    expect(allocation.bytes.subarray(16, 484)).toEqual(encoded);
    state.clear();
    expect(player).toEqual(new PlayerState(product));
    expect(player.origin).toBe(origin);
    expect(player.stats).toBe(stats);
    expect(detached).toEqual(expected);
    view.setInt32(4, 99, true);
    expect(() => player.pmType).toThrow("Unsupported bot player pmType 99");
    view.setInt32(144, 99, true);
    expect(() => player.weapon).toThrow("Unsupported bot player weapon 99");
    view.setInt32(148, 99, true);
    expect(() => player.weaponState).toThrow("Unsupported bot player weaponState 99");
  }
});

test("bot view delta arithmetic converts retained integer angles before floating multiplication", () => {
  const products: readonly Product[] = ["baseq3", "missionpack"];
  const cases = [
    { delta: { x: 16777217, y: -16777217, z: 16777217 }, added: vec3(0, 0, 0), subtracted: vec3(0, 0, 0) },
    { delta: { x: -16777217, y: 16777217, z: -16777217 }, added: vec3(0, 0, 0), subtracted: vec3(0, 0, 0) },
    { delta: { x: 16384, y: 32768, z: -16384 }, added: vec3(90, 180, 270), subtracted: vec3(270, 180, 90) },
  ];
  for (const product of products) {
    const state = new BotState(product), viewangles = state.viewangles;
    for (const fixture of cases) {
      state.curPs.deltaAngles = fixture.delta;
      state.viewangles = vec3(0, 0, 0);
      // QVM SHORT2ANGLE first rounds 16777217 to 16777216, exactly 256 turns.
      botAddDeltaAngles(state);
      expect(state.viewangles).toEqual(fixture.added);
      expect(state.viewangles).toBe(viewangles);
      expect(state.curPs.deltaAngles).toEqual(fixture.delta);
      state.viewangles = vec3(0, 0, 0);
      botSubtractDeltaAngles(state);
      expect(state.viewangles).toEqual(fixture.subtracted);
      expect(state.viewangles).toBe(viewangles);
      expect(state.curPs.deltaAngles).toEqual(fixture.delta);
    }
  }
});

test("PlayerStateSlots uses a supplied view and copies remain independent", () => {
  const values = new Int32Array([11, 22]);
  const slots = new PlayerStateSlots(2, values);
  expect(slots.get(0)).toBe(11);
  slots.set(1, 0xffff_ffff);
  expect(values[1]).toBe(-1);
  values[0] = 73;
  expect(slots.get(0)).toBe(73);
  const copy = slots.copy();
  slots.set(0, 91);
  expect(copy[0]).toBe(73);
  expect(() => new PlayerStateSlots(3, values)).toThrow(RangeError);
  expect(() => slots.get(2)).toThrow(RangeError);
  expect(() => slots.set(-1, 0)).toThrow(RangeError);
  expect(new PlayerStateSlots(2).copy()).toEqual(new Int32Array(2));
});

test("fixed bot text stores source bytes, zero padding, truncation and retained reads", () => {
  const memory = new GameMemory(() => 0, () => {});
  const state = new BotStateStore("baseq3").acquire(0, memory);
  const allocation = state.sourceAllocation;
  if (allocation === null) throw new Error("BotStateStore omitted source allocation");
  const bytes = allocation.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.fill(0x5a, 4608, 4900);
  Object.assign(state.settings, { characterfile: "b\xfft\0ignored", skill: 2.5, team: "red" });
  expect(state.settings.characterfile).toBe("b\xfft");
  expect(bytes.subarray(4608, 4612)).toEqual(new Uint8Array([98, 255, 116, 0]));
  expect(bytes.subarray(4612, 4752)).toEqual(new Uint8Array(140));
  expect(view.getFloat32(4752, true)).toBe(2.5);
  expect(bytes.subarray(4756, 4760)).toEqual(new Uint8Array([114, 101, 100, 0]));
  expect(bytes.subarray(4760, 4900)).toEqual(new Uint8Array(140));
  state.settings.team = "r".repeat(160);
  expect(state.settings.team).toBe("r".repeat(143));
  expect(bytes[4898]).toBe(114);
  expect(bytes[4899]).toBe(0);
  const settings = bytes.slice(4608, 4900);
  expect(() => { state.settings.characterfile = "bad\u0100"; }).toThrow("source byte characters");
  expect(bytes.subarray(4608, 4900)).toEqual(settings);
  state.formationTeammate = "f".repeat(20);
  expect(state.formationTeammate).toBe("f".repeat(15));
  expect(bytes[7031]).toBe(0);
  view.setUint32(7032, 0x12345678, true);
  state.formationTeammate = "\xff";
  expect(bytes.subarray(7016, 7032)).toEqual(new Uint8Array([255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  expect(view.getUint32(7032, true)).toBe(0x12345678);

  bytes.fill(88, 6900, 6932);
  view.setUint32(6932, 0x005a59, true);
  expect(state.teamLeader).toBe("X".repeat(32) + "YZ");
  const alias = new BotState("baseq3", allocation);
  expect(alias.settings.characterfile).toBe("b\xfft");
  expect(alias.teamLeader).toBe(state.teamLeader);
  alias.settings.team = "blue";
  expect(state.settings.team).toBe("blue");
  state.resetDecisionState();
  expect(state.settings.characterfile).toBe("b\xfft");
  expect(state.settings.team).toBe("blue");
  expect(bytes.subarray(6900, 6932)).toEqual(new Uint8Array(32));
  expect(bytes.subarray(7016, 7032)).toEqual(new Uint8Array(16));
});

test("bot text operations retain cleaned tails and mutate exact source terminator bytes", () => {
  const memory = new GameMemory(() => 0, () => {});
  const state = new BotStateStore("missionpack").acquire(0, memory);
  const allocation = state.sourceAllocation;
  if (allocation === null) throw new Error("BotStateStore omitted source allocation");
  const bytes = allocation.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  state.copyTeamLeaderClientName("^1A\xffB");
  expect(state.teamLeader).toBe("AB");
  expect(bytes.subarray(6900, 6906)).toEqual(new Uint8Array([65, 66, 0, 255, 66, 0]));
  expect(bytes.subarray(6906, 6932)).toEqual(new Uint8Array(26));
  state.clearTeamLeader();
  expect(state.teamLeader).toBe("");
  expect(bytes.subarray(6900, 6906)).toEqual(new Uint8Array([0, 66, 0, 255, 66, 0]));

  view.setUint32(6932, 0x7fc012ff, true);
  state.copyTeamLeaderWithOverflow("L".repeat(40));
  expect(state.teamLeader).toBe("L".repeat(32));
  expect(bytes.subarray(6900, 6932)).toEqual(new Uint8Array(32).fill(76));
  expect(view.getUint32(6932, true)).toBe(0x7fc01200);
  view.setUint32(6932, 0x123456ff, true);
  state.copyTeamLeaderWithOverflow("Sam");
  expect(bytes.subarray(6900, 6904)).toEqual(new Uint8Array([83, 97, 109, 0]));
  expect(bytes.subarray(6904, 6932)).toEqual(new Uint8Array(28));
  expect(view.getUint32(6932, true)).toBe(0x12345600);
  state.copyTeamLeader("N".repeat(40));
  expect(state.teamLeader).toBe("N".repeat(31));
  expect(bytes[6931]).toBe(0);
  expect(view.getUint32(6932, true)).toBe(0x12345600);

  state.copySubteam("squad");
  state.clearSubteam();
  expect(state.subteam).toBe("");
  expect(bytes.subarray(6980, 6986)).toEqual(new Uint8Array([0, 113, 117, 97, 100, 0]));
  state.copySubteam("S".repeat(40));
  expect(state.subteam).toBe("S".repeat(31));
  expect(bytes[7011]).toBe(0);
  state.copySubteam("");
  expect(bytes.subarray(6980, 7012)).toEqual(new Uint8Array(32));
});
