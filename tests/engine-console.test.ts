import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditField } from "../src/core/edit-field.ts";
import { KeyCatcher } from "../src/core/key-codes.ts";
import { EngineConsole } from "../src/engine/console.ts";
import { screenBigStringWidth, screenColor, screenDrawBigField, screenDrawBigString, screenDrawBigStringColor, screenDrawField, screenDrawSmallChar, screenDrawSmallString, screenDrawString, screenStringLength } from "../src/engine/screen-draw.ts";
import { screenFixture, whiteAssets } from "./engine-screen-fixture.ts";

test.skipIf(process.env["Q3_CONSOLE_ORACLE"] === undefined)("unchanged native console and field traces execute through the actual CPU queue", async () => {
  const oracle = process.env["Q3_CONSOLE_ORACLE"];
  if (oracle === undefined) throw new Error("Run the isolated console verifier to provide its unchanged-source oracle");
  for (const [width, height] of [[640, 480], [1280, 720], [641, 479]] satisfies readonly (readonly [number, number])[]) {
  const native = Bun.spawnSync([oracle, String(width), String(height)]); expect(native.exitCode).toBe(0);
  const f = await screenFixture(width, height);
  try {
    const trace = f.queue.trace, marker = (name: string) => { trace.push(`CASE ${name}`); };
    const draw = () => { f.console.draw(f.drawing); f.submit(); };
    marker("early"); f.state.phase = "disconnected"; draw(); f.state.phase = "active";
    marker("strings"); screenDrawString(f.drawing, 3, 5, 13.75, "a^1b^^c^", screenColor(7), false);
    screenDrawSmallString(f.drawing, 4, 7, "a^2b^^", screenColor(7), false);
    marker("fields"); const field = new EditField(); field.setText("ab^1cdef"); field.widthInChars = 4; field.cursor = 8; field.scroll = 99;
    screenDrawField(f.drawing, field, 10, 20, true); trace.push(`FIELD ${field.scroll}`);
    field.widthInChars = 20; field.scroll = 77; screenDrawBigField(f.drawing, field, 10, 40, true); trace.push(`FIELD ${field.scroll}`);
    marker("notify"); f.console.print("alpha ^1red\rX\n"); f.console.print("[skipnotify]hidden\n"); f.console.print("^1\xe9\xfftail"); draw();
    marker("notify-boundary"); f.state.realtime = 3100; draw(); f.state.realtime = 3101; draw();
    marker("intermission"); f.state.realtime = 100; f.keys.setCatcher(KeyCatcher.Ui); draw(); f.moveType(5); draw();
    marker("chat"); f.keys.setCatcher(0); f.commands.executeNow("messagemode2"); f.keys.chatField.setText("hey^1you"); f.keys.chatField.cursor = 8;
    f.targetPlayer(-1); await f.commands.executeNowAsync("messagemode3"); draw(); trace.push(`CHAT ${Number(f.keys.chatTeam)} ${f.keys.chatPlayer} ${f.keys.chatField.widthInChars} ${f.keys.getCatcher()}`);
    marker("solid"); f.keys.setCatcher(KeyCatcher.Console); f.state.realFrameTime = 47; f.console.run(); draw();
    marker("scroll"); f.console.scroll("page-up"); draw(); f.console.scroll("top"); draw(); f.console.scroll("bottom"); draw();
    marker("closed"); f.console.close(); draw();
    marker("disconnected"); f.state.phase = "disconnected"; draw();
    marker("toggle"); f.keys.setCatcher(KeyCatcher.Console); f.keys.consoleField.setText("keep"); await f.console.toggle();
    trace.push(...f.calls, `EDIT ${f.keys.consoleField.text} ${f.keys.getCatcher()}`);
    marker("clear-and-suppress"); f.state.phase = "active"; f.commands.executeNow("clear"); f.cvars.set("cl_noprint", "1"); f.console.print("must not appear");
    f.cvars.set("cl_noprint", "0"); f.console.print("after clear"); draw();
    marker("page-down"); f.keys.setCatcher(KeyCatcher.Console); f.state.realFrameTime = 1000; f.console.run(); f.console.scroll("page-up"); f.console.scroll("page-down"); draw();
    marker("closing"); f.keys.setCatcher(0); f.state.realFrameTime = 47; f.console.run(); draw(); f.state.realFrameTime = 1000; f.console.run(); draw();
    marker("helper-corners"); screenDrawSmallChar(f.drawing, 1, -17, 65); screenDrawSmallChar(f.drawing, 1, -16, 321); screenDrawSmallChar(f.drawing, 1, 0, 32);
    screenDrawBigStringColor(f.drawing, 7, -15, "^2A\xff", screenColor(1)); screenDrawBigString(f.drawing, 7, -17, "A", 0.25);
    trace.push(`WIDTH ${screenStringLength("a^1b^^c^")} ${screenBigStringWidth("a^1b^^c^")}`);
    marker("hidden-cursor"); f.keys.setOverstrike(true); f.state.realtime = 256; screenDrawField(f.drawing, field, 4, 8, true);
    f.state.realtime = 0; screenDrawField(f.drawing, field, 4, 8, false); screenDrawField(f.drawing, field, 4, 8, true); f.submit();
    marker("retained-ring"); for (let index = 0; index < 600; index++) f.console.print(`row ${index}\n`);
    f.state.phase = "disconnected"; f.console.scroll("top"); draw(); f.console.scroll("page-up"); draw(); f.console.scroll("page-down"); f.console.scroll("bottom"); draw();
    expect(trace).toEqual(native.stdout.toString().trimEnd().split("\n"));
    expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
  } finally { f.close(); }
  }
});

test.skipIf(process.env["Q3_CONSOLE_ORACLE"] === undefined)("ring wrap retains exactly the source dump lines after more than 420 linefeeds", async () => {
  const oracle = process.env["Q3_CONSOLE_ORACLE"]; if (oracle === undefined) throw new Error("Missing native console oracle");
  const f = await screenFixture();
  try {
    for (let index = 0; index < 600; index++) f.console.print(`row ${index}\n`);
    f.commands.executeNow("condump console.txt");
    const native = Bun.spawnSync([oracle, "dump-ring", "console.txt"], { cwd: f.home }); expect(native.exitCode).toBe(0);
    const actual = readFileSync(join(f.home, "baseq3/console.txt")), reference = readFileSync(join(f.home, "console.txt"));
    expect(actual).toEqual(reference); expect(actual.toString()).toStartWith("row 182\n");
    expect(actual.toString().split("\n")).toHaveLength(421);
  } finally { f.close(); }
});

test.skipIf(process.env["Q3_CONSOLE_ORACLE"] === undefined)("common print before Con_Init lazily allocates text and later initialization preserves it", async () => {
  const oracle = process.env["Q3_CONSOLE_ORACLE"]; if (oracle === undefined) throw new Error("Missing native console oracle");
  const f = await screenFixture(640, 480, whiteAssets(), false, "before initialization\n");
  try {
    expect(f.fsReads()).toBe(0); expect(f.keys.consoleField.widthInChars).toBe(78);
    f.commands.executeNow("condump console.txt");
    const native = Bun.spawnSync([oracle, "dump-early", "console.txt"], { cwd: f.home }); expect(native.exitCode).toBe(0);
    const actual = readFileSync(join(f.home, "baseq3/console.txt")), reference = readFileSync(join(f.home, "console.txt"));
    expect(actual).toEqual(reference); expect(actual.toString()).toStartWith("before initialization\n");
  } finally { f.close(); }
});

test.skipIf(process.env["Q3_CONSOLE_ORACLE"] === undefined)("real temporary-home condump includes its own success print and original byte wrapping", async () => {
  const oracle = process.env["Q3_CONSOLE_ORACLE"]; if (oracle === undefined) throw new Error("Missing native console oracle");
  const f = await screenFixture();
  try {
    f.console.print("alpha ^1red\rX\n"); f.console.print("[skipnotify]hidden\n"); f.console.print("^1\xe9\xfftail\n"); f.console.print("A".repeat(160));
    expect(f.fsReads()).toBe(0); f.commands.executeNow("condump console.txt"); expect(f.fsReads()).toBe(1);
    const native = Bun.spawnSync([oracle, "dump", "console.txt"], { cwd: f.home }); expect(native.exitCode).toBe(0);
    const actual = readFileSync(join(f.home, "baseq3/console.txt")), reference = readFileSync(join(f.home, "console.txt"));
    expect(actual).toEqual(reference); expect(actual.toString("latin1")).toContain("Dumped console text to console.txt.");
    expect(actual.includes(Buffer.from([233, 255]))).toBe(true);
    f.commands.executeNow("condump"); expect(f.fsReads()).toBe(1); expect(f.prints.at(-1)).toBe("usage: condump <filename>\n");
  } finally { f.close(); }
});

test("commands borrow keys and preserve target failure, XOR catchers and renderer field-width timing", async () => {
  const f = await screenFixture(1280, 720);
  try {
    expect(f.console.fieldWidth).toBe(78); expect(f.keys.consoleField.widthInChars).toBe(78);
    expect([...f.commands.registeredNames()].reverse().slice(-7)).toEqual(["toggleconsole", "messagemode", "messagemode2", "messagemode3", "messagemode4", "clear", "condump"]);
    f.console.rendererInitialized(1280); expect(f.console.fieldWidth).toBe(158); expect(f.keys.consoleField.widthInChars).toBe(158);
    f.commands.executeNow("messagemode2"); f.keys.chatField.setText("keep"); f.targetPlayer(64); await f.commands.executeNowAsync("messagemode4");
    expect([f.keys.chatTeam, f.keys.chatPlayer, f.keys.chatField.text, f.keys.chatField.widthInChars, f.keys.getCatcher()]).toEqual([true, -1, "keep", 25, 4]);
    f.targetPlayer(63); await f.commands.executeNowAsync("messagemode4"); expect([f.keys.chatTeam, f.keys.chatPlayer, f.keys.chatField.text, f.keys.chatField.widthInChars, f.keys.getCatcher()]).toEqual([false, 63, "", 30, 0]);
    f.keys.consoleField.setText("abc"); f.keys.setCatcher(KeyCatcher.Ui); await f.console.toggle();
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui | KeyCatcher.Console); expect(f.keys.consoleField.text).toBe("");
    f.cvars.set("cl_running", "0", true); f.keys.consoleField.setText("keep"); f.console.close(); expect(f.keys.consoleField.text).toBe("keep");
    f.cvars.set("cl_running", "1", true); f.console.close(); expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.keys.consoleField.text).toBe("");
    const error = new Error("expired owner"); f.guardError(error); expect(() => f.console.print("no")).toThrow(error); f.guardError(null);
  } finally { f.close(); }
});

test("targeted message commands await cgame results and recheck authority before changing keys", async () => {
  const f = await screenFixture();
  try {
    let guardError: Error | null = null;
    let target = Promise.withResolvers<number>();
    let reached = Promise.withResolvers<void>();
    const console = new EngineConsole({ state: f.state, keys: f.keys, cvars: f.cvars, commands: f.commands, output: f.output,
      host: {
        assertCurrentOperation: () => { if (guardError !== null) throw guardError; f.commands.assertCurrentExecution(); },
        startDemoLoop: async () => { throw new Error("Unexpected demo loop"); },
        readCgame: () => ({ crosshairPlayer: () => { reached.resolve(); return target.promise; },
          lastAttacker: () => { reached.resolve(); return target.promise; } }),
        snapshotMoveType: () => 0, writableFiles: () => { throw new Error("Unexpected writable files"); }, version: "test",
      } });
    for (const name of ["toggleconsole", "messagemode", "messagemode2", "messagemode3", "messagemode4", "clear", "condump"]) f.commands.unregister(name);
    console.initialize(); f.commands.executeNow("messagemode2"); f.keys.chatField.setText("retained");
    const first = f.commands.executeNowAsync("messagemode3"); await reached.promise;
    expect([f.keys.chatPlayer, f.keys.chatTeam, f.keys.chatField.text]).toEqual([-1, true, "retained"]);
    target.resolve(12); await first;
    expect([f.keys.chatPlayer, f.keys.chatTeam, f.keys.chatField.text, f.keys.getCatcher()]).toEqual([12, false, "", 0]);
    target = Promise.withResolvers<number>(); reached = Promise.withResolvers<void>();
    f.keys.chatField.setText("keep after rejection");
    const second = f.commands.executeNowAsync("messagemode4"); await reached.promise;
    guardError = new Error("retired console operation"); target.resolve(21);
    await expect(second).rejects.toThrow("retired console operation");
    expect([f.keys.chatPlayer, f.keys.chatField.text, f.keys.getCatcher()]).toEqual([12, "keep after rejection", 0]);
    guardError = null;
  } finally { f.close(); }
});
