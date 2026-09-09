import { expect, test } from "bun:test";
import { parseQvm, QvmOpcode } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import type { ClientKeyHost, ClientKeyUi } from "../src/engine/client-keys.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { qvmKeySyscall } from "../src/vm/key-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (const [index, value] of values.entries()) view.setInt32(index * 4, value, true);
  return view;
}

function fixture() {
  const commands = new CommandBuffer(), cvars = new CvarRegistry(), memory = new QvmMemory(new Uint8Array(256));
  let ui: ClientKeyUi | null = null;
  const unexpected = (): never => { throw new Error("Unexpected virtual host operation"); };
  const host: ClientKeyHost = {
    readConnection: () => ({ kind: "active", demoPlayback: false }), readUi: () => ui, readCgame: () => null,
    assertCurrentOperation: () => { commands.assertCurrentExecution(); },
    disconnect: unexpected, stopAllSounds: unexpected, addReliableCommand: unexpected,
    toggleConsole: unexpected, updateScreen: unexpected, consoleScroll: unexpected, readConsoleWidth: () => 78,
    clipboard: { kind: "native-unix-unavailable" },
  };
  const keys = new ClientKeys({ commands, cvars, host, print: unexpected });
  keys.initializeCommands();
  const call = (role: "game" | "cgame" | "ui", ...values: number[]) => qvmKeySyscall(role, words(...values), memory, keys);
  return { commands, cvars, memory, keys, host, call, setUi: (value: ClientKeyUi | null) => { ui = value; } };
}

test("key names preserve source sentinels, truncation, padding and masked pointers", () => {
  const f = fixture();
  for (const [key, name] of [[-1, "<KEY NOT FOUND>"], [-2, "<OUT OF RANGE>"], [256, "<OUT OF RANGE>"],
    [KeyCode.Enter, "ENTER"], [59, "SEMICOLON"], [97, "a"], [0, "0x00"]] satisfies readonly (readonly [number, string])[]) {
    f.memory.bytes.fill(0xaa);
    expect(f.call("ui", 33, key, 272, 20)).toBe(0);
    expect(f.memory.readString(16)).toBe(name);
    expect(f.memory.bytes[35]).toBe(0); expect(f.memory.bytes[36]).toBe(0xaa);
  }
  expect(f.call("ui", 33, KeyCode.Enter, 16, 4)).toBe(0); expect(f.memory.readString(16)).toBe("ENT");
  expect(f.call("ui", 33, KeyCode.Enter, 16, 1)).toBe(0); expect(f.memory.readString(16)).toBe("");
  expect(() => f.call("ui", 33, 0, 0, 5)).toThrow("NULL dest");
  expect(() => f.call("ui", 33, 0, 16, 0)).toThrow("destsize");
  expect(() => f.call("ui", 33, 0, 255, 2)).toThrow("exceeds QVM allocation");
});

test("unbound binding writes one byte regardless of capacity; empty binding uses Q_strncpyz", () => {
  const f = fixture();
  for (const capacity of [0, -1, 256]) {
    f.memory.bytes.fill(0xaa);
    expect(f.call("ui", 34, 1, 255, capacity)).toBe(0);
    expect(f.memory.bytes[255]).toBe(0); expect(f.memory.bytes[254]).toBe(0xaa);
  }
  expect(() => f.call("ui", 34, 1, 0, 0)).toThrow("nonnull pointer");
  f.keys.setBinding(1, "");
  expect(() => f.call("ui", 34, 1, 16, 0)).toThrow("destsize");
  expect(() => f.call("ui", 34, -1, 16, 0)).toThrow("destsize");
  f.memory.bytes.fill(0xaa);
  expect(f.call("ui", 34, -1, 16, 4)).toBe(0);
  expect(f.memory.span(16, 5)).toEqual(new Uint8Array([0, 0, 0, 0, 0xaa]));
});

test("VM bindings and command bindings share source bytes, lookup order and archive flags", () => {
  const f = fixture();
  f.commands.executeNow('bind w "+forward"');
  expect(f.call("ui", 34, 119, 16, 16)).toBe(0); expect(f.memory.readString(16)).toBe("+forward");
  f.memory.writeString(32, "+FORWARD", 16);
  expect(f.call("cgame", 63, 32)).toBe(119);
  f.cvars.clearModifiedFlags(CvarFlag.Archive);
  f.memory.writeString(32, "+forward", 16);
  expect(f.call("ui", 35, 1, 32)).toBe(0); expect(f.cvars.modifiedFlags).toBe(CvarFlag.Archive);
  expect(f.call("cgame", 63, 32)).toBe(1);
  f.memory.writeString(32, "echo \xe9\xff", 16);
  expect(f.call("ui", 35, 2, 32)).toBe(0); expect(f.keys.getBinding(2)).toBe("echo \xe9\xff");
  expect(f.call("ui", 34, 2, 64, 8)).toBe(0);
  expect(f.memory.span(64, 8)).toEqual(new Uint8Array([101, 99, 104, 111, 32, 233, 255, 0]));
  f.commands.executeNow("unbind w"); expect(f.keys.getBinding(119)).toBe("");
  expect(f.call("cgame", 63, 0)).toBe(-1);
  f.memory.writeString(32, "", 1); expect(f.call("cgame", 63, 32)).toBe(119);
  f.cvars.clearModifiedFlags(CvarFlag.Archive);
  expect(f.call("ui", 35, -1, 0)).toBe(0); expect(f.cvars.modifiedFlags).toBe(0);
  expect(() => f.call("ui", 35, 3, 0)).toThrow("nonnull pointer");
  f.memory.bytes[255] = 255;
  expect(() => f.call("ui", 35, 3, 255)).toThrow("no terminator");
  expect(f.keys.getBinding(3)).toBeNull();
});

test("UI and cgame share actual virtual down/catcher state and raw overstrike words", async () => {
  const f = fixture();
  for (const role of ["ui", "cgame"] satisfies readonly ("ui" | "cgame")[]) {
    const trap = role === "ui" ? 36 : 60;
    expect(f.call(role, trap, -1)).toBe(0);
    expect(f.call(role, trap, 1)).toBe(0);
    for (const key of [-2, 256]) expect(() => f.call(role, trap, key)).toThrow("Undefined native key index");
  }
  await f.keys.keyEvent(1, true, 1);
  expect(f.call("ui", 36, 1)).toBe(1); expect(f.call("cgame", 60, 1)).toBe(1);
  expect(f.call("ui", 41, -2147483648)).toBe(0); expect(f.call("cgame", 61)).toBe(-2147483648);
  expect(f.call("cgame", 62, 0x7fffffff)).toBe(0); expect(f.call("ui", 40)).toBe(0x7fffffff);
  expect(f.keys.getCatcher()).toBe(0x7fffffff);
  expect(f.call("ui", 37)).toBe(0);
  expect(f.call("ui", 38, 1)).toBe(0); expect(f.keys.getOverstrike()).toBe(true); expect(f.call("ui", 37)).toBe(1);
  f.keys.setOverstrike(false); expect(f.call("ui", 37)).toBe(0);
  for (const mode of [3, -1, -2147483648, 2147483647]) {
    expect(f.call("ui", 38, mode)).toBe(0); expect(f.call("ui", 37)).toBe(mode);
    expect(f.keys.getOverstrike()).toBe(true);
  }
  f.keys.setCatcher(KeyCatcher.Console);
  await f.keys.keyEvent(KeyCode.Insert, true, 2); expect(f.call("ui", 37)).toBe(0);
  await f.keys.keyEvent(KeyCode.Insert, true, 3); expect(f.call("ui", 37)).toBe(1);
});

test("unsupported role/traps return null and malformed arguments fail before binding mutation", () => {
  const f = fixture();
  expect(qvmKeySyscall("game", new DataView(new ArrayBuffer(0)), f.memory, f.keys)).toBeNull();
  for (const trap of [32, 42, 60, 63, 999]) expect(f.call("ui", trap)).toBeNull();
  for (const trap of [33, 39, 59, 64, 999]) expect(f.call("cgame", trap)).toBeNull();
  expect(() => f.call("ui", 35, 1)).toThrow(RangeError); expect(f.keys.getBinding(1)).toBeNull();
  expect(() => f.call("ui", 34, -2, 16, 4)).toThrow("Undefined native key index");
});

test("binding scalar and source bytes are captured before the client owner callback", () => {
  const f = fixture(), args = words(35, 1, 32);
  f.memory.writeString(32, "original\xe9", 16);
  f.host.assertCurrentOperation = () => {
    f.commands.assertCurrentExecution();
    args.setInt32(4, 2, true); args.setInt32(8, 0, true);
    f.memory.writeString(32, "changed", 16);
  };
  expect(qvmKeySyscall("ui", args, f.memory, f.keys)).toBe(0);
  expect(f.keys.getBinding(1)).toBe("original\xe9"); expect(f.keys.getBinding(2)).toBeNull();
});

test("ClearStates awaits recursive authored VM UI calls and actual command release dispatch", async () => {
  const f = fixture(), released: number[] = [], results: number[] = [], executed: string[] = [];
  f.commands.register("+forward", context => { executed.push(context.raw); });
  f.commands.register("-forward", context => { executed.push(context.raw); });
  f.commands.executeNow("bind 0x32 +forward"); f.commands.executeNow("bind d +forward");
  await f.keys.keyEvent(100, true, 7); await f.keys.keyEvent(50, true, 8);
  await f.commands.executeAsync();
  f.keys.setCatcher(KeyCatcher.Ui);
  const operations: readonly (readonly [QvmOpcode, number?])[] = [
    [QvmOpcode.OP_ENTER, 16], [QvmOpcode.OP_LOCAL, 24], [QvmOpcode.OP_LOAD4],
    [QvmOpcode.OP_CONST, 0], [QvmOpcode.OP_EQ, 8],
    [QvmOpcode.OP_CONST, -41], [QvmOpcode.OP_CALL], [QvmOpcode.OP_LEAVE, 16],
    [QvmOpcode.OP_CONST, -40], [QvmOpcode.OP_CALL], [QvmOpcode.OP_LEAVE, 16],
  ];
  const code = new BinaryWriter(128);
  for (const [opcode, operand] of operations) { code.u8(opcode); if (operand !== undefined) code.i32(operand); }
  const bytes = code.finish(), file = new BinaryWriter(32 + bytes.length);
  for (const value of [0x12721444, operations.length, 32, bytes.length, 32 + bytes.length, 0, 0, 512]) file.i32(value);
  file.bytes(bytes);
  const vm = new QvmInterpreter(parseQvm(file.finish(), "authored-key.qvm"), call => {
    if (call.words.getInt32(0, true) === 39) f.setUi({
      setActiveMenu: async () => { throw new Error("Unexpected menu"); },
      keyEvent: async (key, down) => {
        expect(down).toBe(false); released.push(key);
        expect(f.keys.isDown(key)).toBe(false);
        results.push(await call.invoke([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        call.words.setInt32(0, 999, true);
      },
    });
    const result = qvmKeySyscall("ui", call.words, new QvmMemory(call.memory), f.keys);
    if (result === null) throw new Error("Unexpected authored key trap");
    return result;
  });
  f.commands.registerAsync("vm-clear", async () => {
    expect(await vm.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
    expect(released).toEqual([50, 100]);
  });
  await f.commands.executeNowAsync("vm-clear");
  expect(results).toEqual([KeyCatcher.Ui, KeyCatcher.Ui]);
  expect(f.keys.isDown(50)).toBe(false); expect(f.keys.isDown(100)).toBe(false);
  expect(f.keys.inputState.anyKeyDown).toBe(4294967294);
  expect(f.commands.pendingText).toBe("-forward 50 0\n-forward 100 0\n");
  await f.commands.executeAsync();
  expect(executed).toEqual(["+forward 100 7", "+forward 50 8", "-forward 50 0", "-forward 100 0"]);
  expect(f.keys.getBinding(50)).toBe("+forward");
});

test("ClearStates propagates UI failure with the actual owner's partial release state", async () => {
  const f = fixture();
  await f.keys.keyEvent(1, true, 1); await f.keys.keyEvent(2, true, 2);
  f.keys.setCatcher(KeyCatcher.Ui);
  f.setUi({ keyEvent: async () => { throw new Error("authored UI failure"); }, setActiveMenu: async () => undefined });
  f.commands.registerAsync("clear", async () => { await f.call("ui", 39); });
  await expect(f.commands.executeNowAsync("clear")).rejects.toThrow("authored UI failure");
  expect(f.keys.isDown(1)).toBe(false); expect(f.keys.isDown(2)).toBe(true);
  f.setUi(null); await f.commands.executeNowAsync("clear"); expect(f.keys.isDown(2)).toBe(false);
});
