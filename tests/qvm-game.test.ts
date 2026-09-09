// Authored GAME bytecode and source export contracts. GPL-2.0-or-later.
import { expect, spyOn, test } from "bun:test";
import { QvmOpcode, parseQvm } from "../src/assets/qvm.ts";
import type { QvmImage } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { finishCalls, runCalls } from "../src/core/call-steps.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { QvmGame } from "../src/engine/qvm-game.ts";
import type { ServerGame } from "../src/server/game.ts";
import { Weapon } from "../src/shared/definitions.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { VmRegistry } from "../src/vm/registry.ts";

/** Exposes all ten vmMain words through one test syscall, returning its result. */
function observedModule(initializedData = new Uint8Array(), allocation = 8192, trap = 500): QvmImage {
  const code = new BinaryWriter(128);
  code.u8(QvmOpcode.OP_ENTER); code.i32(64);
  for (let index = 0; index < 10; index++) {
    code.u8(QvmOpcode.OP_LOCAL); code.i32(72 + index * 4);
    code.u8(QvmOpcode.OP_LOAD4);
    code.u8(QvmOpcode.OP_ARG); code.u8(8 + index * 4);
  }
  code.u8(QvmOpcode.OP_CONST); code.i32(-1 - trap);
  code.u8(QvmOpcode.OP_CALL);
  code.u8(QvmOpcode.OP_LEAVE); code.i32(64);
  const bytes = code.finish(), writer = new BinaryWriter(32 + bytes.length + initializedData.length);
  for (const word of [0x12721444, 34, 32, bytes.length, 32 + bytes.length,
    initializedData.length, 0, allocation - initializedData.length]) writer.i32(word);
  writer.bytes(bytes); writer.bytes(initializedData);
  return parseQvm(writer.finish(), "authored-game.qvm");
}

test("external game publishes before INIT and forwards every source export and argument", async () => {
  const owner: { game: ServerGame | null } = { game: null }, calls: number[][] = [];
  const registration = new VmRegistry().reserve("qagame"), called = spyOn(registration, "called");
  let entryChecks = 0;
  const game = new QvmGame(observedModule(), "missionpack", call => {
    expect(owner.game).toBe(game);
    expect(call.words.getInt32(0, true)).toBe(500);
    const args = Array.from({ length: 10 }, (_, index) => call.words.getInt32(4 + index * 4, true));
    calls.push(args);
    return call.words.getInt32(4, true) === 9 ? -7 : 0;
  }, () => { entryChecks++; }, { kind: "unaccounted" }, registration);
  expect(QvmGame.registered(registration)).toBe(game);
  expect(game.product).toBe("missionpack");
  expect(() => finishCalls(game.calls.runFrame(91))).toThrow("Cannot synchronously finish");
  expect(calls).toEqual([]); expect(entryChecks).toBe(0);
  owner.game = game;
  await game.initialize(-123, 0x7fffffff);
  expect(await runCalls(game.calls.clientConnect(5, true, false))).toBeNull();
  expect(await runCalls(game.calls.clientConnect(6, false, true))).toBeNull();
  await runCalls(game.calls.clientBegin(7));
  await runCalls(game.calls.clientUserinfoChanged(8));
  await runCalls(game.calls.clientDisconnect(9));
  await runCalls(game.calls.clientCommand(10, ["say", "not ABI arguments"]));
  const command: UserCommand = { serverTime: 987, angles: { x: 123, y: 456, z: 789 }, buttons: 1,
    weapon: Weapon.WP_ROCKET_LAUNCHER, forwardmove: 127, rightmove: -127, upmove: 3 };
  await runCalls(game.calls.clientThink(11, command));
  await runCalls(game.calls.runFrame(-456));
  expect(await runCalls(game.calls.consoleCommand(["not tokenized here"]))).toBe(true);
  await runCalls(game.calls.botFrame(789));
  await runCalls(game.calls.shutdown(true));
  await runCalls(game.calls.shutdown(false));
  expect(calls).toEqual([
    [0, -123, 0x7fffffff, 0, 0, 0, 0, 0, 0, 0],
    [2, 5, 1, 0, 0, 0, 0, 0, 0, 0], [2, 6, 0, 1, 0, 0, 0, 0, 0, 0],
    [3, 7, 0, 0, 0, 0, 0, 0, 0, 0], [4, 8, 0, 0, 0, 0, 0, 0, 0, 0],
    [5, 9, 0, 0, 0, 0, 0, 0, 0, 0], [6, 10, 0, 0, 0, 0, 0, 0, 0, 0],
    [7, 11, 0, 0, 0, 0, 0, 0, 0, 0], [8, -456, 0, 0, 0, 0, 0, 0, 0, 0],
    [9, 0, 0, 0, 0, 0, 0, 0, 0, 0], [10, 789, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ]);
  game.disposeResources(); game.disposeResources();
  expect(registration.binding.kind).toBe("freed");
  expect(QvmGame.registered(registration)).toBeNull();
  expect(calls.length).toBe(13);
  expect(called).toHaveBeenCalledTimes(13);
  called.mockRestore();
  await expect(Promise.resolve(runCalls(game.calls.runFrame(0)))).rejects.toThrow("retired");
});

test("client admission awaits the interpreter and borrows its masked denial pointer", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const game = new QvmGame(observedModule(), "baseq3", async call => {
    if (call.words.getInt32(4, true) !== 2) return 0;
    entered.resolve(); await release.promise;
    const memory = new QvmMemory(call.memory);
    memory.writeString(128, "denied \xff", 32);
    return call.memory.length + 128;
  }, () => undefined);
  await game.initialize(0, 1);
  let completed = false;
  const pending = Promise.resolve(runCalls(game.calls.clientConnect(2, true, false)))
    .then(value => { completed = true; return value; });
  await entered.promise;
  expect(completed).toBe(false);
  release.resolve();
  const denied = await pending;
  if (typeof denied !== "function") throw new Error("Expected the borrowed game denial pointer");
  expect(denied()).toBe("denied \xff");
  game.disposeResources();
});

test("unterminated denial text rejects at its source read without poisoning later calls", async () => {
  const game = new QvmGame(observedModule(), "baseq3", call => {
    if (call.words.getInt32(4, true) !== 2) return 0;
    call.memory[call.memory.length - 1] = 255;
    return call.memory.length - 1;
  }, () => undefined);
  await game.initialize(0, 1);
  const denied = await runCalls(game.calls.clientConnect(0, true, false));
  if (typeof denied !== "function") throw new Error("Expected the borrowed game denial pointer");
  expect(denied).toThrow("no terminator");
  await runCalls(game.calls.runFrame(1));
  game.disposeResources();
});

test("game command callbacks reenter after awaits and retain the common tokenizer's latest state", async () => {
  const commands = new CommandBuffer(), calls: number[] = [];
  const registration = new VmRegistry().reserve("qagame"), called = spyOn(registration, "called");
  const game = new QvmGame(observedModule(), "baseq3", async call => {
    const command = call.words.getInt32(4, true); calls.push(command);
    if (command === 9) {
      expect(commands.tokenizedArguments).toEqual(["mod", "original"]);
      await Promise.resolve(); await commands.executeNowAsync("nested replacement");
      expect(commands.tokenizedArguments).toEqual(["nested", "replacement"]);
    }
    if (command === 6) expect(commands.tokenizedArguments).toEqual(["nested", "replacement"]);
    return command === 9 ? 1 : 0;
  }, () => undefined, { kind: "unaccounted" }, registration);
  commands.registerAsync("mod", async () => {
    expect(await runCalls(game.calls.consoleCommand(["must", "not", "retokenize"]))).toBe(true);
  });
  commands.registerAsync("nested", async () => {
    await runCalls(game.calls.clientCommand(4, ["also", "ignored"]));
    await runCalls(game.calls.clientBegin(4));
  });
  await game.initialize(0, 1); await commands.executeNowAsync("mod original");
  expect(commands.tokenizedArguments).toEqual(["nested", "replacement"]);
  expect(calls).toEqual([0, 9, 6, 3]);
  expect(called).toHaveBeenCalledTimes(4);
  called.mockRestore();
  game.disposeResources();
});

test("restart reloads the same game allocation and retains code, tables and entity pointers", async () => {
  const initialized = new Uint8Array(512);
  new DataView(initialized.buffer).setInt32(64, 12, true);
  const calls: number[][] = [];
  const game = new QvmGame(observedModule(initialized), "missionpack", call => {
    const command = call.words.getInt32(4, true);
    calls.push([call.words.getInt32(0, true), command, call.words.getInt32(8, true),
      call.words.getInt32(12, true), call.words.getInt32(16, true)]);
    if (command === 0) game.data.locate(64, 2, 600, 4096, 512);
    return 0;
  }, () => undefined);
  await game.initialize(100, 101);
  const data = game.data, entity = data.entity(0);
  expect(entity.s.number).toBe(12);
  entity.r.linkcount = 9; data.setPlayerPing(0, 77);
  await runCalls(game.calls.shutdown(true));
  expect(entity.r.linkcount).toBe(9);
  const replacement = new Uint8Array(128);
  new DataView(replacement.buffer).setInt32(64, 31, true);
  game.restart(observedModule(replacement, 4096, 501));
  expect(game.data).toBe(data);
  expect(data.numEntities).toBe(2);
  expect(data.entity(0)).toBe(entity);
  expect(entity.s.number).toBe(31); expect(entity.r.linkcount).toBe(0);
  // A smaller reload clears only its new data size, retaining the old allocation and mask.
  expect(data.copyPlayerState(0).ping).toBe(77);
  await game.initialize(200, 201, true);
  expect(data.entity(0)).toBe(entity);
  expect(calls).toEqual([[500, 0, 100, 101, 0], [500, 1, 1, 0, 0], [500, 0, 200, 201, 1]]);
  game.disposeResources();
  expect(entity.s.number).toBe(31);
  expect(() => game.restart(observedModule())).toThrow("retired");
});

test("already-entered calls finish after nested shutdown and callback-free retirement", async () => {
  const owner: { game: ServerGame | null } = { game: null }, calls: number[] = [];
  let currentOperation = true;
  const game = new QvmGame(observedModule(), "baseq3", async call => {
    const command = call.words.getInt32(4, true); calls.push(command);
    if (command === 9) {
      await Promise.resolve();
      await runCalls(game.calls.shutdown(false));
      game.disposeResources(); owner.game = null; currentOperation = false;
    }
    return command === 9 ? 1 : 0;
  }, () => { if (!currentOperation) throw new Error("Retired server operation"); });
  owner.game = game;
  await game.initialize(0, 1);
  expect(await runCalls(game.calls.consoleCommand([]))).toBe(true);
  expect(owner.game).toBeNull(); expect(calls).toEqual([0, 9, 1]);
  await expect(game.initialize(0, 1)).rejects.toThrow("Retired server operation");
});

test("unrelated entry and active restart reject while the actual syscall remains suspended", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>();
  const game = new QvmGame(observedModule(), "baseq3", call => {
    if (call.words.getInt32(4, true) === 8) { entered.resolve(); return release.promise; }
    return 0;
  }, () => undefined);
  await game.initialize(0, 1);
  const pending = runCalls(game.calls.runFrame(10)); await entered.promise;
  await expect(Promise.resolve(runCalls(game.calls.clientBegin(0)))).rejects.toThrow("already active");
  expect(() => game.restart(observedModule())).toThrow("active QVM");
  release.resolve(0); await pending;
  expect(() => game.restart(observedModule(new Uint8Array(), 16384))).toThrow("original allocation");
  await runCalls(game.calls.runFrame(11));
  game.disposeResources();
});

test("detached callbacks cannot reuse a closed syscall's recursive authority", async () => {
  const release = Promise.withResolvers<void>();
  const detached: { completion: Promise<void> | null } = { completion: null };
  const calls: number[] = [];
  const game = new QvmGame(observedModule(), "baseq3", call => {
    const command = call.words.getInt32(4, true); calls.push(command);
    if (command === 8) {
      detached.completion = (async () => {
        await release.promise;
        await runCalls(game.calls.clientBegin(1));
      })();
    }
    return 0;
  }, () => undefined);
  await game.initialize(0, 1); await runCalls(game.calls.runFrame(1));
  const completion = detached.completion;
  if (completion === null) throw new Error("Authored callback did not start its detached work");
  release.resolve();
  await expect(completion).rejects.toThrow("active, unoccupied syscall");
  await runCalls(game.calls.clientBegin(2));
  expect(calls).toEqual([0, 8, 3]);
  game.disposeResources();
});
