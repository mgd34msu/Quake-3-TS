// Source cl_cgame.c/cl_ui.c trap contracts exercised through authored protocol records.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { parseQvm, QvmOpcode } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientActiveState, getClientServerCommand } from "../src/engine/client-active.ts";
import type { ClientServerCommandServices } from "../src/engine/client-active.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { ClientConnectionState } from "../src/engine/client-state.ts";
import { DemoReader } from "../src/protocol/demo.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerOperation, Snapshot } from "../src/protocol/server-message.ts";
import type { RendererConfigurationSnapshot } from "../src/render/configuration.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { qvmClientStateSyscall } from "../src/vm/client-state-syscalls.ts";
import type { QvmClientStateServices } from "../src/vm/client-state-syscalls.ts";
import { qvmConsoleSyscall } from "../src/vm/console-syscalls.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { readQvmUserCommand } from "../src/vm/user-command.ts";
import { ProtocolClientLifecycle, transmitProtocolClient } from "../tools/client-protocol-fixture.ts";

function configuration(): RendererConfigurationSnapshot {
  return { backend: "gl", driverType: "icd", maxTextureSize: 16384, depthStorage: "driver",
    rendererString: "authored driver", vendorString: "vendor", versionString: "1.2", extensionsString: "EXT_test",
    maxActiveTextures: 2, colorBits: 24, depthBits: 32, stencilBits: 8, hardwareType: "generic",
    deviceSupportsGamma: false, gamma: { kind: "unsupported", reason: "no device in this fixture" },
    textureCompression: "none", compiledVertexArrays: false, textureEnvAddAvailable: true, vidWidth: 1280, vidHeight: 720,
    windowAspect: 16 / 9, displayFrequency: 60, isFullscreen: false, stereoEnabled: false, smpActive: false };
}

function words(trap: number, ...args: number[]): DataView {
  const view = new DataView(new ArrayBuffer((args.length + 1) * 4));
  view.setInt32(0, trap, true);
  for (const [index, value] of args.entries()) view.setInt32((index + 1) * 4, value, true);
  return view;
}

function fixture(product: Product = "baseq3", demo = false) {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: demo
    ? { kind: "demo", reader: new DemoReader(new Uint8Array(), "authored empty demo") }
    : { kind: "network", challenge: 0, qport: 27960 } });
  const memory = new QvmMemory(new Uint8Array(131072).fill(0xa5)), commands = session.lifecycle.consoleCommands;
  const services: QvmClientStateServices = { clientStatic: session.lifecycle.clientStatic,
    connection: session.lifecycle.clientConnection, active: session.active,
    getServerCommand: sequence => session.getServerCommand(sequence), configuration };
  return { session, lifecycle, memory, commands, services,
    call: (role: "game" | "cgame" | "ui", trap: number, ...args: number[]) =>
      qvmClientStateSyscall(role, words(trap, ...args), memory, services) };
}

async function receive(session: EngineClientSession, operations: readonly ServerOperation[], number = session.serverMessageSequence + 1): Promise<void> {
  await session.receiveServerMessage(number, encodeServerMessage(0, operations,
    { product: session.product, messageNumber: number, reliableSequence: 0, serverCommandSequence: session.serverCommandSequence,
      parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
}

function snapshot(product: Product, number: number, entities: readonly EntityState[] = []): Snapshot {
  return { messageNumber: number, serverTime: number * 50, deltaNumber: -1, flags: 5,
    serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: Uint8Array.of(0x81, 0x17),
    playerState: new PlayerState(product), entities };
}

function operation(value: Snapshot): Extract<ServerOperation, { kind: "snapshot" }> {
  return { kind: "snapshot", validity: { kind: "valid" }, snapshot: value };
}

function sample(serverTime: number) {
  return { serverTime, viewAngles: { x: 90, y: -90, z: 180 }, buttons: 1,
    forwardmove: 127, rightmove: -127, upmove: -128 };
}

async function prime(session: EngineClientSession): Promise<void> {
  await receive(session, [{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 19,
    entries: [{ kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" },
      { kind: "configstring", index: 10, value: "allocated" }, { kind: "configstring", index: 11, value: "" }] }]);
  session.prime(1);
}

describe("QVM client-state traps", () => {
  test("role IDs, source void returns, configuration and UI cleared snapshot identity", () => {
    const f = fixture();
    const services = f.services;
    services.clientStatic.phase = "challenging";
    services.clientStatic.servername = "server";
    services.connection.connectPacketCount = 12;
    services.connection.serverMessage = "awaiting challenge";
    for (const [role, trap] of [["ui", 43], ["cgame", 49]] satisfies readonly (readonly ["ui" | "cgame", number])[]) {
      expect(qvmClientStateSyscall(role, words(trap, 16), f.memory, services)).toBe(0);
      expect(f.memory.readString(16)).toBe("authored driver");
      expect(f.memory.view(16 + 11304, 4).getInt32(0, true)).toBe(1280);
    }
    expect(qvmClientStateSyscall("ui", words(44, 16), f.memory, services)).toBe(0);
    const state = f.memory.view(16, 3084);
    expect([state.getInt32(0, true), state.getInt32(4, true), state.getInt32(8, true)]).toEqual([4, 12, 0]);
    expect(f.memory.readString(28)).toBe("server");
    expect(f.memory.readString(2076)).toBe("awaiting challenge");
    expect(qvmClientStateSyscall("game", new DataView(new ArrayBuffer(0)), f.memory, services)).toBeNull();
    expect(f.call("ui", 49)).toBeNull();
    expect(f.call("cgame", 43)).toBeNull();
    expect(qvmClientStateSyscall("cgame", words(54), f.memory, services)).toBe(0);
  });

  test("set usercmd value retains the source float word before movement consumes it", () => {
    const f = fixture();
    for (const value of [NaN, Infinity, -Infinity, -0, 1 / 3]) {
      const call = words(56, 5, 0);
      call.setFloat32(8, value, true);
      expect(qvmClientStateSyscall("cgame", call, f.memory, f.services)).toBe(0);
      expect(f.session.userCmdSensitivity).toBe(Math.fround(value));
    }
  });

  test("UI configstrings retain source allocation presence, invalid-index no-write and size rules", async () => {
    const f = fixture(); await prime(f.session);
    expect(f.call("ui", 45, -1, 0, 100)).toBe(0);
    expect(f.call("ui", 45, 1024, 0, 100)).toBe(0);
    expect(f.call("ui", 45, 12, 0, 0)).toBe(0);
    expect(f.memory.bytes.every(byte => byte === 0xa5)).toBe(true);
    expect(f.call("ui", 45, 12, 16, -1)).toBe(0);
    expect(f.memory.bytes[16]).toBe(0); expect(f.memory.bytes[17]).toBe(0xa5);
    expect(f.call("ui", 45, 11, 32, 4)).toBe(1);
    expect(f.memory.span(32, 5)).toEqual(Uint8Array.of(0, 0, 0, 0, 0xa5));
    expect(f.call("ui", 45, 10, 48, 5)).toBe(1);
    expect(f.memory.readString(48)).toBe("allo");
    expect(() => f.call("ui", 45, 11, 32, 0)).toThrow("destsize");
    expect(() => f.call("ui", 45, 12, 0, 1)).toThrow("nonnull");
    f.services.active.clear();
    expect(qvmClientStateSyscall("ui", words(45, 10, 64, 1), f.memory, f.services)).toBe(0);
    expect(f.memory.bytes[64]).toBe(0);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} received wire gamestate/snapshot and actual outgoing history supply ABI records`, async () => {
      const f = fixture(product); await prime(f.session);
      expect(f.call("cgame", 50, 16)).toBe(0);
      const gameState = f.memory.view(16, 20100);
      const offset = gameState.getInt32(10 * 4, true);
      expect(f.memory.readString(16 + 4096 + offset)).toBe("allocated");
      expect(gameState.getInt32(11 * 4, true)).toBeGreaterThan(0);
      expect(gameState.getInt32(12 * 4, true)).toBe(0);
      f.session.createUserCommand(sample(100)); transmitProtocolClient(f.session, 1000, 0, true);
      f.services.clientStatic.realtime = 1090;
      const value = snapshot(product, 2, [new EntityState()]);
      value.playerState.commandTime = 100; value.playerState.clientNum = 41;
      value.playerState.origin = { x: 1.25, y: -2.5, z: 3.75 };
      await receive(f.session, [{ kind: "command", sequence: 1, text: "print received" }, operation(value)]);
      expect(f.call("cgame", 51, 16, 20)).toBe(0);
      expect(f.memory.view(16, 8).getInt32(0, true)).toBe(2);
      expect(f.memory.view(16, 8).getInt32(4, true)).toBe(100);
      f.memory.bytes.fill(0xa5);
      expect(f.call("cgame", 52, 2, 32)).toBe(1);
      const snap = f.memory.view(32, 53772);
      expect([snap.getInt32(0, true), snap.getInt32(4, true), snap.getInt32(8, true)]).toEqual([5, 90, 100]);
      expect(f.memory.span(44, 32)).toEqual(Uint8Array.from([0x81, 0x17, ...Array.from({ length: 30 }, () => 0)]));
      expect(snap.getInt32(184, true)).toBe(41);
      expect(snap.getFloat32(64, true)).toBe(1.25);
      expect(snap.getInt32(512, true)).toBe(1);
      expect(snap.getInt32(53764, true)).toBe(-1515870811);
      expect(snap.getInt32(53768, true)).toBe(1);
      expect(f.memory.span(32 + 516 + 208, 208).every(byte => byte === 0xa5)).toBe(true);
      expect(f.call("ui", 44, 60000)).toBe(0);
      expect(f.memory.view(60008, 4).getInt32(0, true)).toBe(41);
      expect(f.call("cgame", 51, 16, 16)).toBe(0);
      expect(f.memory.view(16, 4).getInt32(0, true)).toBe(100);
    });
  }

  test("snapshot ring gates precede destination access and truncate the actual 257-entity wire record", async () => {
    const f = fixture();
    expect(f.call("cgame", 52, 0, 0)).toBe(0);
    expect(() => f.call("cgame", 52, 1, 0)).toThrow("snapshotNumber");
    const entities = Array.from({ length: 257 }, (_, index) => { const entity = new EntityState(); entity.number = index; return entity; });
    await receive(f.session, [operation(snapshot("baseq3", 1, entities))]);
    expect(f.call("cgame", 52, 1, 16)).toBe(1);
    expect(f.memory.view(528, 4).getInt32(0, true)).toBe(256);
    expect(f.lifecycle.debugMessages).toContain("CL_GetSnapshot: truncated 257 entities to 256\n");
    await receive(f.session, [operation(snapshot("baseq3", 33))], 33);
    f.memory.bytes.fill(0xa5);
    expect(f.call("cgame", 52, 1, 0)).toBe(0);
    expect(f.call("cgame", 52, 32, 0)).toBe(0);
    expect(f.memory.bytes.every(byte => byte === 0xa5)).toBe(true);
  });

  test("snapshot parse-entity expiry returns false within the 32-snapshot ring", async () => {
    const f = fixture();
    const entities = Array.from({ length: 256 }, (_, number) => { const entity = new EntityState(); entity.number = number; return entity; });
    for (let number = 1; number <= 9; number++) await receive(f.session, [operation(snapshot("baseq3", number, entities))]);
    expect(f.session.snapshots.current().number).toBe(9);
    expect(f.call("cgame", 52, 1, 0)).toBe(0);
    expect(f.call("cgame", 52, 2, 0)).toBe(0);
    expect(f.memory.bytes.every(byte => byte === 0xa5)).toBe(true);
    expect(f.call("cgame", 52, 3, 16)).toBe(1);
  });

  test("snapshot ping and headers precede truncation callbacks that replace the retained slot", () => {
    const f = fixture(), messages: string[] = [];
    const entities = Array.from({ length: 257 }, () => new EntityState());
    const original = snapshot("baseq3", 1, entities);
    original.playerState.clientNum = 41;
    const replacement = { ...snapshot("baseq3", 33, entities), flags: 9,
      parseEntitiesNumber: 257, serverCommandNumber: 8, areaMask: Uint8Array.of(3) };
    replacement.playerState.clientNum = 66;
    const active = new ClientActiveState(text => {
      messages.push(text);
      active.history.publish(operation(replacement));
      active.snapshotPings[1] = { messageNumber: 33, ping: 999 };
      for (let index = 0; index < 257; index++) active.parseEntities.at(257 + index).number = index + 300;
      active.parseEntitiesNumber = 514;
    });
    active.history.publish(operation(original));
    active.snapshotPings[1] = { messageNumber: 1, ping: 90 };
    active.parseEntitiesNumber = 257;
    const services: QvmClientStateServices = { ...f.services, active };
    expect(qvmClientStateSyscall("cgame", words(52, 1, 16), f.memory, services)).toBe(1);
    const result = f.memory.view(16, 53772);
    expect([result.getInt32(0, true), result.getInt32(4, true), result.getInt32(8, true)]).toEqual([5, 90, 50]);
    expect(f.memory.span(28, 2)).toEqual(Uint8Array.of(0x81, 0x17));
    expect(result.getInt32(184, true)).toBe(41);
    expect(result.getInt32(53768, true)).toBe(0);
    expect(result.getInt32(512, true)).toBe(256);
    expect(result.getInt32(516, true)).toBe(300);
    expect(result.getInt32(516 + 255 * 208, true)).toBe(555);
    expect(messages).toEqual(["CL_GetSnapshot: truncated 257 entities to 256\n"]);
    expect(active.snapshotPing(1)).toBeNull();
    expect(active.snapshotPing(33)).toBe(999);
  });

  test("usercmd traps use real generated history and source restart clears retained ring values", async () => {
    const f = fixture(); await prime(f.session);
    expect(f.call("cgame", 54)).toBe(0);
    expect(f.call("cgame", 55, 0, 16)).toBe(1);
    expect(f.memory.span(16, 24)).toEqual(new Uint8Array(24));
    expect(f.call("cgame", 56, 5, 0x3f000000)).toBe(0);
    expect(f.session.userCmdSensitivity).toBe(0.5);
    f.session.createUserCommand(sample(123));
    expect(f.call("cgame", 54)).toBe(1);
    expect(f.call("cgame", 55, 1, 16)).toBe(1);
    expect(readQvmUserCommand(f.memory.view(16, 24))).toEqual({ serverTime: 123, angles: { x: 16384, y: 49152, z: 32768 },
      buttons: 1, weapon: 5, forwardmove: 127, rightmove: -127, upmove: -128 });
    expect(() => f.call("cgame", 55, 2, 0)).toThrow("CL_GetUserCmd: 2 >= 1");
    f.memory.bytes.fill(0xa5);
    expect(f.call("cgame", 55, -63, 0)).toBe(0);
    expect(f.memory.bytes.every(byte => byte === 0xa5)).toBe(true);
    await receive(f.session, [{ kind: "command", sequence: 1, text: "map_restart" }]);
    expect(await f.call("cgame", 53, 1)).toBe(1);
    expect(f.call("cgame", 54)).toBe(1);
    expect(f.call("cgame", 55, 1, 16)).toBe(1);
    expect(f.memory.span(16, 24)).toEqual(new Uint8Array(24));
  });

  test("server commands join actual console argc/argv/args including false-returning fragments", async () => {
    const f = fixture();
    const consoleServices = { commands: f.commands, output: new ConsoleOutput(() => undefined), clock: { milliseconds: () => 0 } };
    const consoleCall = (trap: number, ...args: number[]) => qvmConsoleSyscall("cgame", words(trap, ...args), f.memory, consoleServices);
    const commands = ['print "two words" tail', 'bcs0 10 "first "', 'bcs1 10 "second "', 'bcs2 10 "third"', "clientLevelShot"];
    for (const [index, text] of commands.entries()) {
      await receive(f.session, [{ kind: "command", sequence: index + 1, text }]);
      expect(await f.call("cgame", 53, index + 1)).toBe(index === 0 || index === 3 ? 1 : 0);
      if (index === 0) {
        expect(consoleCall(7)).toBe(3);
        expect(consoleCall(8, 1, 16, 32)).toBe(0); expect(f.memory.readString(16)).toBe("two words");
        expect(consoleCall(9, 16, 32)).toBe(0); expect(f.memory.readString(16)).toBe("two words tail");
      } else if (index === 3) {
        expect(f.commands.tokenizedArguments).toEqual(["cs", "10", "first second third"]);
        expect(f.session.getConfigString(10)).toBe("first second third");
      } else expect(f.commands.tokenizedArguments[0]).toBe(index === 4 ? "clientLevelShot" : `bcs${index - 1}`);
    }
    const demo = fixture("baseq3", true);
    await receive(demo.session, [{ kind: "command", sequence: 65, text: "print new" }]);
    demo.commands.tokenize("previous retained");
    expect(await demo.call("cgame", 53, 1)).toBe(0);
    expect(demo.commands.tokenizedArguments).toEqual(["previous", "retained"]);
    await expect(Promise.resolve().then(() => demo.call("cgame", 53, 66))).rejects.toThrow("not received");
  });

  test("captures scalar words before resolving callback owners", async () => {
    const f = fixture(); await prime(f.session);
    const callWords = words(56, 5, 0x3f000000);
    const services: QvmClientStateServices = { ...f.services, get active() {
      callWords.setInt32(4, 9, true); callWords.setInt32(8, 0x7fc00000, true); return f.session.active;
    } };
    expect(qvmClientStateSyscall("cgame", callWords, f.memory, services)).toBe(0);
    expect(f.session.userCmdSensitivity).toBe(0.5);
    f.session.createUserCommand(sample(100));
    expect(f.session.commands.read(1)?.weapon).toBe(5);
    const glWords = words(49, 16);
    const glServices: QvmClientStateServices = { ...f.services, configuration: () => {
      glWords.setInt32(4, 0, true); return configuration();
    } };
    expect(qvmClientStateSyscall("cgame", glWords, f.memory, glServices)).toBe(0);
    expect(f.memory.readString(16)).toBe("authored driver");
  });

  test("cs retokenizes its captured server text after awaited package callbacks change the common tokens", async () => {
    class RetokenizingLifecycle extends ProtocolClientLifecycle {
      override async applyServerPackages(info: string): Promise<void> {
        expect(this.consoleCommands.tokenizedArguments).toEqual(["cs", "1", "\\sv_serverid\\123"]);
        await super.applyServerPackages(info);
        this.consoleCommands.tokenize("nested other tokens");
      }
    }
    const cvars = new CvarRegistry(), lifecycle = new RetokenizingLifecycle(cvars);
    const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
      mode: { kind: "network", challenge: 0, qport: 27960 } });
    const memory = new QvmMemory(new Uint8Array(1024));
    const services: QvmClientStateServices = { clientStatic: lifecycle.clientStatic, connection: lifecycle.clientConnection,
      active: session.active, getServerCommand: sequence => session.getServerCommand(sequence), configuration };
    await receive(session, [{ kind: "command", sequence: 1, text: 'cs 1 "\\sv_serverid\\123"' }]);
    const callWords = words(53, 1), result = qvmClientStateSyscall("cgame", callWords, memory, services);
    callWords.setInt32(4, 999, true);
    expect(await result).toBe(1);
    expect(lifecycle.consoleCommands.tokenizedArguments).toEqual(["cs", "1", "\\sv_serverid\\123"]);
    expect(session.serverId).toBe(123);
  });

  test("resolved destination bounds reject successful writes and preserve source pointer masking", async () => {
    const f = fixture(); await prime(f.session);
    expect(f.call("cgame", 55, 0, -131056)).toBe(1);
    expect(f.memory.span(16, 24)).toEqual(new Uint8Array(24));
    f.memory.bytes.fill(0xa5);
    for (const [role, trap, args] of [
      ["ui", 43, [131071]], ["ui", 44, [131071]], ["cgame", 50, [131071]], ["cgame", 55, [0, 131071]],
    ] satisfies readonly (readonly ["ui" | "cgame", number, readonly number[]])[]) {
      expect(() => f.call(role, trap, ...args)).toThrow("exceeds allocation");
      expect(f.memory.bytes.every(byte => byte === 0xa5)).toBe(true);
    }
  });

  test("retained active allocation supplies all cleared shutdown traps without a transport session", async () => {
    const f = fixture(); await prime(f.session);
    f.session.createUserCommand(sample(100));
    f.session.setUserCmdValue(7, 0.75);
    await receive(f.session, [operation(snapshot("baseq3", 2))]);
    const active = f.session.active, snapshots = active.snapshots, commands = active.commands, state = active.gameState;
    active.clear();
    const connection = new ClientConnectionState();
    f.services.clientStatic.phase = "disconnected";
    const commandServices: ClientServerCommandServices = {
      cvars: f.session.cvars, consoleCommands: f.commands,
      assertCurrentOperation: () => f.commands.assertCurrentExecution(),
      applyServerPackages: info => f.lifecycle.applyServerPackages(info),
      emitEvent: event => { throw new Error(`Unexpected cleared command event ${event.kind}`); },
      fail: (_kind, message) => { throw new Error(message); },
    };
    const services: QvmClientStateServices = { clientStatic: f.services.clientStatic, connection, active, configuration,
      getServerCommand: sequence => getClientServerCommand(sequence, active, connection, f.services.clientStatic, commandServices) };
    f.lifecycle.close();
    expect(() => f.session.getSourceGameState()).toThrow("no longer current");
    const call = (trap: number, ...args: number[]) => qvmClientStateSyscall("cgame", words(trap, ...args), f.memory, services);
    expect([active.snapshots, active.commands, active.gameState]).toEqual([snapshots, commands, state]);
    expect(call(50, 16)).toBe(0);
    expect(f.memory.span(16, 20100)).toEqual(new Uint8Array(20100));
    expect(call(51, 16, 20)).toBe(0);
    expect(f.memory.span(16, 8)).toEqual(new Uint8Array(8));
    f.memory.bytes.fill(0xa5);
    expect(call(52, 0, 0)).toBe(0);
    expect(f.memory.bytes.every(byte => byte === 0xa5)).toBe(true);
    expect(call(54)).toBe(0);
    expect(call(55, 0, 16)).toBe(1);
    expect(f.memory.span(16, 24)).toEqual(new Uint8Array(24));
    expect(call(56, 9, 0x3f400000)).toBe(0);
    expect(active.userCmdValue).toBe(9); expect(active.sensitivity).toBe(0.75);
    expect(call(56, 5, 0x7fc00000)).toBe(0);
    expect(active.sensitivity).toBeNaN();
    expect(call(56, 5, 0x7f800000)).toBe(0);
    expect(active.sensitivity).toBe(Number.POSITIVE_INFINITY);
    f.commands.tokenize("previous tokens");
    expect(await call(53, 0)).toBe(1);
    expect(f.commands.tokenizedArguments).toEqual([]);
    expect(connection.lastExecutedServerCommand).toBe(0);
    await expect(Promise.resolve().then(() => call(53, 1))).rejects.toThrow("not received");
    expect(f.commands.tokenizedArguments).toEqual([]);
  });

  test("active clears and connection replacement preserve client-lived fragmented configstring assembly", async () => {
    const f = fixture();
    await receive(f.session, [{ kind: "command", sequence: 1, text: 'bcs0 10 "before "' }]);
    expect(await f.call("cgame", 53, 1)).toBe(0);
    const active = f.session.active;
    active.clear();
    const connection = new ClientConnectionState();
    connection.serverCommandSequence = 1; connection.serverCommands[1] = 'bcs2 10 "after"';
    const commandServices: ClientServerCommandServices = {
      cvars: f.session.cvars, consoleCommands: f.commands,
      assertCurrentOperation: () => f.commands.assertCurrentExecution(),
      applyServerPackages: info => f.lifecycle.applyServerPackages(info),
      emitEvent: event => { throw new Error(`Unexpected configstring event ${event.kind}`); },
      fail: (_kind, message) => { throw new Error(message); },
    };
    expect(await getClientServerCommand(1, active, connection, f.services.clientStatic, commandServices)).toEqual(["cs", "10", "before after"]);
    expect(active.getConfigString(10)).toBe("before after");
    expect(connection.lastExecutedServerCommand).toBe(1);
    expect(f.commands.tokenizedArguments).toEqual(["cs", "10", "before after"]);
  });

  test("authored QVM interpreter receives the actual wire snapshot through the client-state dispatcher", async () => {
    const f = fixture();
    const value = snapshot("baseq3", 1); value.playerState.clientNum = 23;
    await receive(f.session, [operation(value)]);
    const code = new BinaryWriter(64);
    code.u8(QvmOpcode.OP_ENTER); code.i32(16);
    code.u8(QvmOpcode.OP_CONST); code.i32(1); code.u8(QvmOpcode.OP_ARG); code.u8(8);
    code.u8(QvmOpcode.OP_CONST); code.i32(32); code.u8(QvmOpcode.OP_ARG); code.u8(12);
    code.u8(QvmOpcode.OP_CONST); code.i32(-53); code.u8(QvmOpcode.OP_CALL);
    code.u8(QvmOpcode.OP_LEAVE); code.i32(16);
    const codeBytes = code.finish(), file = new BinaryWriter(32 + codeBytes.length);
    for (const word of [0x12721444, 8, 32, codeBytes.length, 32 + codeBytes.length, 0, 0, 131072]) file.i32(word);
    file.bytes(codeBytes);
    const vm = new QvmInterpreter(parseQvm(file.finish(), "authored-client-state.qvm"), call => {
      const result = qvmClientStateSyscall("cgame", call.words, new QvmMemory(call.memory), f.services);
      if (result === null) throw new Error("Unexpected authored QVM trap");
      return result;
    });
    expect(await vm.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(new DataView(vm.memory.buffer).getInt32(32 + 184, true)).toBe(23);
  });
});
