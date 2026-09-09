import { describe, expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { parseStartupLines, StartupCommands } from "../src/engine/startup-commands.ts";

describe("native common startup command lines", () => {
  test("splits quoted plus and unconditional line endings without changing source bytes", () => {
    const text = '+set message "one+two\nthree"\r+echo last\0+echo excluded';
    const parsed = parseStartupLines(text);
    expect(parsed.map(line => line.text)).toEqual(["", 'set message "one+two', 'three"', "", "echo last"]);
    expect(parsed.map(line => line.argv)).toEqual([[], ["set", "message", "one+two"], ["three", ""], [], ["echo", "last"]]);
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const line of parsed) { expect(Object.isFrozen(line)).toBe(true); expect(Object.isFrozen(line.argv)).toBe(true); }
    expect(parseStartupLines("echo \xffone")[0]?.argv).toEqual(["echo", "one"]);
    expect(() => parseStartupLines("echo \u0100")).toThrow("source bytes");
  });

  test("line32 owns all unprocessed source text after the separator cap", () => {
    const text = Array.from({ length: 35 }, (_, index) => `echo ${index}`).join("+");
    const lines = parseStartupLines(text);
    expect(lines).toHaveLength(32);
    expect(lines[30]?.text).toBe("echo 30");
    expect(lines[31]?.text).toBe("echo 31+echo 32+echo 33+echo 34");
    expect(lines[31]?.argv).toEqual(["echo", "31+echo", "32+echo", "33+echo", "34"]);
    expect(parseStartupLines("+").map(line => line.text)).toEqual(["", ""]);
    expect(parseStartupLines("").map(line => line.text)).toEqual([""]);
  });

  test("startup set passes force only exact-case command/name matches and retain late text", () => {
    const startup = new StartupCommands('+set target early +SET target ignored +set TARGET upper +set target "last value" extra');
    const cvars = new CvarRegistry();
    cvars.register("target", "default", CvarFlag.ReadOnly);
    startup.applyVariables(cvars, "target");
    expect(cvars.get("target")?.value).toBe("last value");
    expect(cvars.get("target")?.flags).toBe(CvarFlag.ReadOnly | CvarFlag.UserCreated);
    cvars.set("target", "reset", true);
    startup.applyVariables(cvars, "TARGET");
    expect(cvars.get("target")?.value).toBe("upper");
    startup.applyVariables(cvars, null);
    expect(cvars.get("target")?.value).toBe("last value");
    const commands = new CommandBuffer();
    expect(startup.appendCommands(commands)).toBe(false);
    expect(commands.pendingText).toBe('set target early \nSET target ignored \nset TARGET upper \nset target "last value" extra\n');
  });

  test("startup missing names remain empty and invalid names diagnose twice before flagging BADNAME", () => {
    const printed: string[] = [], cvars = new CvarRegistry(text => { printed.push(text); });
    new StartupCommands("+set").applyVariables(cvars, null);
    expect(cvars.get("")?.value).toBe("");
    expect(cvars.get("")?.flags).toBe(CvarFlag.UserCreated);
    new StartupCommands('+set "bad;name" 1').applyVariables(cvars, null);
    expect(printed).toEqual(["invalid cvar name string: bad;name\n", "invalid cvar name string: bad;name\n"]);
    expect(cvars.get("bad;name")).toBeUndefined();
    expect(cvars.get("BADNAME")?.value).toBe("1");
    expect(cvars.get("BADNAME")?.flags).toBe(CvarFlag.UserCreated);
  });

  test("safe consumption is per-owner and never mutates immutable parsed snapshots", () => {
    const text = "+safe+set x 1+CVAR_RESTART+safe+echo ready";
    const startup = new StartupCommands(text), second = new StartupCommands(text);
    const before = startup.lines;
    expect(startup.consumeSafeMode()).toBe(true);
    expect(startup.lines).toBe(before);
    expect(startup.lines.map(line => line.text)).toEqual(["", "safe", "set x 1", "CVAR_RESTART", "safe", "echo ready"]);
    const queue = new CommandBuffer();
    expect(startup.appendCommands(queue)).toBe(true);
    expect(queue.pendingText).toBe("set x 1\nCVAR_RESTART\nsafe\necho ready\n");
    expect(startup.consumeSafeMode()).toBe(true);
    expect(startup.consumeSafeMode()).toBe(true);
    expect(startup.consumeSafeMode()).toBe(false);
    expect(second.consumeSafeMode()).toBe(true);
    const last = new CommandBuffer();
    startup.appendCommands(last);
    expect(last.pendingText).toBe("set x 1\necho ready\n");
  });

  test("late-action detection checks raw first three bytes, not tokenized command identity", () => {
    const commands = new CommandBuffer();
    expect(new StartupCommands("seta x 1+setting y 2").appendCommands(commands)).toBe(false);
    expect(new StartupCommands(" set x 1").appendCommands(new CommandBuffer())).toBe(true);
    expect(new StartupCommands("safe").consumeSafeMode()).toBe(true);
  });
});
