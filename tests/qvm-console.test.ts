import { expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { qvmConsoleSyscall } from "../src/vm/console-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

function fixture(role: "game" | "cgame" | "ui") {
  const memory = new QvmMemory(new Uint8Array(2048)), commands = new CommandBuffer(), printed: string[] = [];
  const services = { commands, output: new ConsoleOutput(text => { printed.push(text); }), clock: { milliseconds: () => -12 } };
  const call = (trap: number, ...args: number[]) => {
    const words = new DataView(new ArrayBuffer((args.length + 1) * 4));
    words.setInt32(0, trap, true);
    for (const [index, word] of args.entries()) words.setInt32((index + 1) * 4, word, true);
    return qvmConsoleSyscall(role, words, memory, services);
  };
  return { memory, commands, printed, call };
}

test("all VM roles use the real console, error severity and system clock", () => {
  for (const role of ["game", "cgame", "ui"] satisfies readonly ("game" | "cgame" | "ui")[]) {
    const f = fixture(role);
    f.memory.writeString(16, "hello %s\xe9", 32);
    expect(f.call(role === "ui" ? 1 : 0, 16)).toBe(0);
    expect(f.printed).toEqual(["hello %s\xe9"]);
    expect(f.call(2)).toBe(-12);
    try { f.call(role === "ui" ? 0 : 1, 16); throw new Error("Expected trap failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(CommonError);
      if (!(error instanceof CommonError)) throw error;
      expect(error.code).toBe("drop");
      expect(error.message).toBe("hello %s\xe9");
    }
    expect(f.call(99)).toBeNull();
  }
});

test("argument traps use latest actual tokenization, including nested execution", async () => {
  const f = fixture("cgame");
  f.commands.registerAsync("outer", async context => {
    expect(f.call(7)).toBe(2);
    await f.commands.executeNowAsync('inner "two words" last');
    expect(context.argv).toEqual(["outer", "first"]);
    expect(f.call(7)).toBe(3);
    f.memory.bytes.fill(0xaa, 64, 97);
    expect(f.call(8, 1, 64, 16)).toBe(0);
    expect(f.memory.readString(64)).toBe("two words");
    expect(f.memory.span(74, 6)).toEqual(new Uint8Array(6));
    expect(f.memory.bytes[80]).toBe(0xaa);
    expect(f.call(9, 80, 16)).toBe(0);
    expect(f.memory.readString(80)).toBe("two words last");
    expect(f.call(8, -1, 64, 1)).toBe(0);
    expect(f.memory.readString(64)).toBe("");
  });
  f.commands.register("inner", () => undefined);
  await f.commands.executeNowAsync("outer first");
  expect(f.commands.tokenizedArguments).toEqual(["inner", "two words", "last"]);
  f.commands.tokenize(null);
  expect(f.call(7)).toBe(0);
  expect(() => f.call(8, 0, 64, 0)).toThrow("destsize");
});

test("UI/game EXEC_NOW awaits handlers; insert and append preserve source buffering", async () => {
  for (const role of ["game", "ui"] satisfies readonly ("game" | "ui")[]) {
    const f = fixture(role), trap = role === "game" ? 14 : 12, seen: string[] = [];
    f.commands.registerAsync("mark", async context => { await Promise.resolve(); seen.push(context.args.join(" ")); });
    f.memory.writeString(16, "mark immediate;still-one-command", 64);
    expect(await f.call(trap, 0, 16)).toBe(0);
    expect(seen).toEqual(["immediate;still-one-command"]);
    f.memory.writeString(16, "mark appended\n", 32);
    expect(f.call(trap, 2, 16)).toBe(0);
    f.memory.writeString(16, "mark inserted", 32);
    expect(f.call(trap, 1, 16)).toBe(0);
    expect(seen).toHaveLength(1);
    expect(await f.call(trap, 0, 0)).toBe(0);
    expect(seen).toEqual(["immediate;still-one-command", "inserted", "appended"]);
    expect(() => f.call(trap, 9, 0)).toThrow("Cbuf_ExecuteText: bad exec_when");
  }
});

test("cgame command names and deferred text use the existing command owner", async () => {
  const f = fixture("cgame");
  f.memory.writeString(16, "mod_command", 16);
  expect(f.call(15, 16)).toBe(0);
  expect(f.commands.registeredNames()).toContain("mod_command");
  expect(f.call(72, 16)).toBe(0);
  expect(f.commands.registeredNames()).not.toContain("mod_command");
  f.memory.writeString(16, "wait\n", 16);
  expect(f.call(14, 16)).toBe(0);
  expect(f.commands.pendingText).toBe("wait\n");
  expect(await f.commands.executeAsync()).toBe(1);
  expect(f.call(16)).toBeNull();
});
