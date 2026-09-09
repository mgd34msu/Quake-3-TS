// Authored bytecode over the actual protocol client session. GPL-2.0-or-later.
import { expect, spyOn, test } from "bun:test";
import { QvmOpcode, parseQvm } from "../src/assets/qvm.ts";
import type { QvmImage } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { EngineClientSession } from "../src/engine/client-session.ts";
import { QvmCgame } from "../src/engine/qvm-cgame.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerOperation } from "../src/protocol/server-message.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";

function observedModule(): QvmImage {
  const code = new BinaryWriter(96);
  code.u8(QvmOpcode.OP_ENTER); code.i32(32);
  for (let index = 0; index < 4; index++) {
    code.u8(QvmOpcode.OP_LOCAL); code.i32(40 + index * 4);
    code.u8(QvmOpcode.OP_LOAD4);
    code.u8(QvmOpcode.OP_ARG); code.u8(8 + index * 4);
  }
  code.u8(QvmOpcode.OP_CONST); code.i32(-501);
  code.u8(QvmOpcode.OP_CALL);
  code.u8(QvmOpcode.OP_LEAVE); code.i32(32);
  const bytes = code.finish(), writer = new BinaryWriter(32 + bytes.length);
  for (const word of [0x12721444, 16, 32, bytes.length, 32 + bytes.length, 0, 0, 2048]) writer.i32(word);
  writer.bytes(bytes);
  return parseQvm(writer.finish(), "authored-cgame.qvm");
}

function session(): EngineClientSession {
  return createProtocolClientSession({ product: "baseq3", cvars: new CvarRegistry(),
    mode: { kind: "network", challenge: 0, qport: 27960 } });
}

async function receive(client: EngineClientSession, operations: readonly ServerOperation[]): Promise<void> {
  const number = client.serverMessageSequence + 1;
  await client.receiveServerMessage(number, encodeServerMessage(0, operations,
    { product: client.product, messageNumber: number, reliableSequence: 0,
      serverCommandSequence: client.serverCommandSequence, parseEntitiesNumber: 0,
      baseline: () => null, history: () => null }));
}

async function gamestate(client: EngineClientSession): Promise<void> {
  await receive(client, [{ kind: "gamestate", commandSequence: 5, clientNumber: 7, checksumFeed: 19,
    entries: [{ kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" }] }]);
}

test("external cgame initializes the actual session and forwards all source exports", async () => {
  const client = session(); await gamestate(client);
  const registration = new VmRegistry().reserve("cgame"), called = spyOn(registration, "called");
  await receive(client, [{ kind: "command", sequence: 6, text: "print pending" }]);
  await client.getServerCommand(6);
  await receive(client, [{ kind: "command", sequence: 7, text: "print unexecuted" }]);
  const initialMessage = client.serverMessageSequence, calls: number[][] = [];
  const game = new QvmCgame(observedModule(), call => {
    const command = call.words.getInt32(4, true);
    if (command === 0) expect(client.lifecycle.clientStatic.phase).toBe("loading");
    calls.push(Array.from({ length: 4 }, (_, index) => call.words.getInt32(4 + index * 4, true)));
    return command === 4 ? 63 : command === 5 ? -1 : 2;
  }, client, () => client.lifecycle.assertCurrentOperation(), { kind: "unaccounted" }, registration);
  expect(QvmCgame.registered(registration)).toBe(game);
  await expect(game.crosshairPlayer()).rejects.toThrow("not initialized");
  await game.initialize();
  expect(client.lifecycle.clientStatic.phase).toBe("primed");
  expect(client.serverCommandSequence).toBe(7);
  expect(client.lastExecutedServerCommand).toBe(6);
  expect(await game.consoleCommand(["ignored", "by", "bytecode"])).toBe(true);
  for (const stereo of ["center", "left", "right"] satisfies readonly ("center" | "left" | "right")[]) {
    await game.drawActiveFrame({ serverTime: -123, stereo, demoPlayback: stereo === "left", engineFrameNumber: 777 });
  }
  expect(await game.crosshairPlayer()).toBe(63); expect(await game.lastAttacker()).toBe(-1);
  await game.keyEvent(42, true); await game.keyEvent(42, false);
  await game.mouseEvent(-7, 9); await game.eventHandling(3);
  await game.close(); await game.close();
  expect(calls).toEqual([[0, initialMessage, 6, 7], [2, 0, 0, 0],
    [3, -123, 0, 0], [3, -123, 1, 1], [3, -123, 2, 0], [4, 0, 0, 0], [5, 0, 0, 0],
    [6, 42, 1, 0], [6, 42, 0, 0], [7, -7, 9, 0], [8, 3, 0, 0], [1, 0, 0, 0]]);
  await expect(game.lastAttacker()).rejects.toThrow("retired");
  expect(registration.binding.kind).toBe("freed");
  expect(QvmCgame.registered(registration)).toBeNull();
  expect(called).toHaveBeenCalledTimes(12);
  called.mockRestore();
});

test("external cgame loading and command callbacks recursively invoke the suspended interpreter", async () => {
  const client = session(); await gamestate(client);
  const registration = new VmRegistry().reserve("cgame"), called = spyOn(registration, "called");
  const calls: number[] = [], commands = client.lifecycle.consoleCommands;
  const game = new QvmCgame(observedModule(), async call => {
    const command = call.words.getInt32(4, true); calls.push(command);
    if (command === 0) {
      await Promise.resolve();
      await game.drawActiveFrame({ serverTime: 0, stereo: "center", demoPlayback: false, engineFrameNumber: 0 });
    }
    if (command === 2) {
      expect(commands.tokenizedArguments).toEqual(["mod", "original"]);
      await commands.executeNowAsync("target nested");
      expect(commands.tokenizedArguments).toEqual(["target", "nested"]);
    }
    return 1;
  }, client, () => client.lifecycle.assertCurrentOperation(), { kind: "unaccounted" }, registration);
  commands.registerAsync("target", async context => { expect(await game.crosshairPlayer()).toBe(1); context.assertActive(); });
  commands.registerAsync("mod", async () => { expect(await game.consoleCommand(["must-not-retokenize"])).toBe(true); });
  await game.initialize(); await commands.executeNowAsync("mod original"); await game.close();
  expect(calls).toEqual([0, 3, 2, 4, 1]);
  expect(called).toHaveBeenCalledTimes(5);
  called.mockRestore();
});

test("external cgame refuses absent or replaced gamestates and callback-free retirement", async () => {
  const client = session(), calls: number[] = [];
  const game = new QvmCgame(observedModule(), call => { calls.push(call.words.getInt32(4, true)); return 0; },
    client, () => client.lifecycle.assertCurrentOperation());
  await expect(game.initialize()).rejects.toThrow("live engine gamestate");
  await gamestate(client); await game.initialize();
  await game.initialize();
  await gamestate(client);
  await expect(game.mouseEvent(0, 0)).rejects.toThrow("stale engine gamestate");
  game.retire(); game.retire(); await game.close();
  expect(calls).toEqual([0, 0]);
});

test("registered cgame initialization reuses the actual interpreter and data across gamestates", async () => {
  const client = session(); await gamestate(client);
  const registration = new VmRegistry().reserve("cgame"), initializations: number[] = [];
  const game = new QvmCgame(observedModule(), call => {
    if (call.words.getInt32(4, true) === 0) {
      initializations.push(call.words.getInt32(8, true));
      const memory = new DataView(call.memory.buffer, call.memory.byteOffset, call.memory.byteLength);
      memory.setInt32(64, memory.getInt32(64, true) + 1, true);
    }
    return 0;
  }, client, () => client.lifecycle.assertCurrentOperation(), { kind: "unaccounted" }, registration);
  const binding = registration.binding;
  if (binding.kind !== "interpreted") throw new Error("Authored cgame must bind an interpreter");
  const memory = binding.interpreter.memory;
  await game.initialize();
  await gamestate(client);
  const reused = QvmCgame.registered(registration);
  if (reused === null) throw new Error("Registered cgame adapter was lost");
  expect(reused).toBe(game);
  await reused.initialize();
  expect(binding.interpreter.memory).toBe(memory);
  expect(new DataView(memory.buffer, memory.byteOffset, memory.byteLength).getInt32(64, true)).toBe(2);
  expect(initializations).toEqual([1, 2]);
  expect(client.lifecycle.clientStatic.phase).toBe("primed");
  await reused.close();
});

test("external cgame shuts down its retained module after the session receives a new gamestate", async () => {
  const client = session(); await gamestate(client);
  const calls: number[] = [];
  const game = new QvmCgame(observedModule(), call => { calls.push(call.words.getInt32(4, true)); return 0; },
    client, () => client.lifecycle.assertCurrentOperation());
  await game.initialize(); await gamestate(client);
  await expect(game.mouseEvent(0, 0)).rejects.toThrow("stale engine gamestate");
  expect(await game.consoleCommand(["retained-module-command"])).toBe(false);
  await game.close(); await game.close();
  expect(calls).toEqual([0, 2, 1]);
  expect(client.lifecycle.clientStatic.phase).toBe("connected");
});

test("external cgame rejects received server messages during initialization without priming", async () => {
  const client = session(); await gamestate(client);
  const game = new QvmCgame(observedModule(), async () => {
    await receive(client, [{ kind: "command", sequence: 6, text: "print changed" }]); return 0;
  }, client, () => client.lifecycle.assertCurrentOperation());
  await expect(game.initialize()).rejects.toThrow("serialize behind CG_Init");
  expect(client.lifecycle.clientStatic.phase).toBe("loading");
  game.retire();
});

test("external cgame refuses a dropped session before entering bytecode", async () => {
  const client = session(); await gamestate(client);
  const calls: number[] = [];
  const game = new QvmCgame(observedModule(), call => { calls.push(call.words.getInt32(4, true)); return 0; },
    client, () => client.lifecycle.assertCurrentOperation());
  await game.initialize();
  await receive(client, [{ kind: "command", sequence: 6, text: "disconnect ended" }]);
  await expect(client.getServerCommand(6)).rejects.toThrow("Server Disconnected");
  await expect(game.eventHandling(0)).rejects.toThrow("Server Disconnected");
  await game.close(); expect(calls).toEqual([0, 1]);
});

test("external cgame rejects unrelated entry and retirement while a syscall is suspended", async () => {
  const client = session(); await gamestate(client);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<number>();
  const calls: number[] = [];
  const game = new QvmCgame(observedModule(), call => {
    const command = call.words.getInt32(4, true); calls.push(command);
    if (command === 4) { entered.resolve(); return release.promise; }
    return 0;
  }, client, () => client.lifecycle.assertCurrentOperation());
  await game.initialize();
  const pending = game.crosshairPlayer(); await entered.promise;
  await expect(game.lastAttacker()).rejects.toThrow("already active");
  game.retire(); release.resolve(12);
  await expect(pending).rejects.toThrow("retired");
  expect(calls).toEqual([0, 4]);
});

test("external cgame detects a gamestate replacement during initialization", async () => {
  const client = session(); await gamestate(client);
  const game = new QvmCgame(observedModule(), async () => { await gamestate(client); return 0; },
    client, () => client.lifecycle.assertCurrentOperation());
  await expect(game.initialize()).rejects.toThrow("stale engine gamestate");
  expect(client.gamestateGeneration).toBe(2);
  expect(client.lifecycle.clientStatic.phase).toBe("connected");
  game.retire();
});
