import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { BotLog } from "../src/botlib/log.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";
import type { Product } from "../src/shared/definitions.ts";

const roots: string[] = [];
const owners: WritableFileSystem[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(product: Product = "baseq3") {
  const homePath = mkdtempSync(join(tmpdir(), "q3-bot-log-"));
  roots.push(homePath);
  const output: { readonly severity: 1 | 3; readonly text: string }[] = [];
  const files = new WritableFileSystem({ homePath, product, print: () => { throw new Error("Bot log must not emit FS_Write diagnostics"); } });
  owners.push(files);
  const variables = new BotLibVars();
  const globals = { time: 0 };
  const log = new BotLog({ variables, globals, openFile: filename => files.openBotLog(filename),
    print: (severity, text) => { output.push({ severity, text }); return undefined; } });
  return { homePath, files, variables, globals, log, output, path: (name: string) => join(files.rootPath, name) };
}

describe("source bot library log", () => {
  test("creates the log default before disabled early returns and consumes no closed output or clock", () => {
    const state = setup();
    const log = new BotLog({ variables: state.variables,
      globals: { get time(): number { throw new Error("No file must not sample time"); } },
      openFile: filename => state.files.openBotLog(filename),
      print: (severity, text) => { state.output.push({ severity, text }); return undefined; } });
    expect(state.variables.get("log")).toBeNull();
    expect(log.open("漢").kind).toBe("ok");
    expect(state.variables.getString("log")).toBe("0");
    expect(state.variables.changed("log")).toBe(true);
    log.write("漢"); log.writeTimeStamped("漢"); log.flush();
    expect(log.filePointer()).toBeNull();
    expect(log.close()).toEqual({ kind: "ok" });
    expect(log.shutdown()).toEqual({ kind: "ok" });
    expect(state.output).toEqual([]);
    expect(existsSync(state.files.rootPath)).toBe(false);
  });

  test("preserves null/empty/already-open order and publishes one stable borrow", () => {
    const state = setup(); state.variables.set("log", "1");
    state.log.open(null); state.log.open("\0ignored漢");
    expect(state.log.open("one.log").kind).toBe("ok");
    const file = state.log.filePointer();
    expect(file).not.toBeNull();
    expect(state.log.filePointer()).toBe(file);
    state.log.open(""); state.log.open("two.log");
    expect(existsSync(state.path("two.log"))).toBe(false);
    expect(state.output).toEqual([
      { severity: 1, text: "openlog <filename>\n" }, { severity: 1, text: "openlog <filename>\n" },
      { severity: 1, text: "Opened log one.log\n" }, { severity: 1, text: "openlog <filename>\n" },
      { severity: 3, text: "log file one.log is already opened\n" },
    ]);
  });

  test("changing the log LibVar affects later opens, not the currently open stream", () => {
    const state = setup(); state.variables.set("log", "1"); state.log.open("first.log");
    state.variables.set("log", "0");
    state.log.open("漢"); state.log.write("still active");
    expect(state.output).toEqual([{ severity: 1, text: "Opened log first.log\n" }]);
    expect(readFileSync(state.path("first.log"), "latin1")).toBe("still active");
    state.log.close(); state.log.open("later.log");
    expect(existsSync(state.path("later.log"))).toBe(false);
  });

  test("two product owners under one home do not share files or cleanup", () => {
    const first = setup();
    const secondFiles = new WritableFileSystem({ homePath: first.homePath, product: "missionpack", print: () => undefined });
    owners.push(secondFiles);
    const variables = new BotLibVars(); variables.set("log", "1"); first.variables.set("log", "1");
    const second = new BotLog({ variables, globals: { time: 0 }, openFile: name => secondFiles.openBotLog(name), print: () => undefined });
    first.log.open("botlib.log"); second.open("botlib.log"); first.log.write("base"); second.write("mission");
    first.log.shutdown(); second.write(" continued");
    expect(readFileSync(first.path("botlib.log"), "latin1")).toBe("base");
    expect(readFileSync(join(secondFiles.rootPath, "botlib.log"), "latin1")).toBe("mission continued");
    second.shutdown();
  });

  test("shares a real buffer, preserves formatted NUL/high bytes, and flushes ordinary writes", () => {
    const state = setup(); state.variables.set("log", "1"); state.log.open("regular.log");
    const file = state.log.filePointer();
    if (file === null) throw new Error("Expected actual open log");
    file.write("A\0éÿB");
    expect(readFileSync(state.path("regular.log")).length).toBe(0);
    state.log.write("/x/\0/é");
    expect(readFileSync(state.path("regular.log")).toString("hex")).toBe("4100e9ff422f782f002fe9");
    expect(() => state.log.write("漢")).toThrow(RangeError);
    expect(readFileSync(state.path("regular.log")).length).toBe(11);
    expect(state.log.close()).toEqual({ kind: "ok" });
    expect(() => file.write("old")).toThrow("closed");
    state.log.open("new.log");
    expect(() => file.write("must not follow reopen")).toThrow("closed");
    expect(readFileSync(state.path("new.log")).length).toBe(0);
  });

  test("matches native timestamps, total fields and counter persistence across reopen", () => {
    const state = setup(); state.variables.set("log", "1"); state.log.open("clock.log");
    state.globals.time = Math.fround(3661.239); state.log.writeTimeStamped("t04");
    state.globals.time = Math.fround(-0.01); state.log.writeTimeStamped("negative");
    expect(readFileSync(state.path("clock.log"), "latin1")).toBe("0   01:61:3661:23   t04\r\n1   00:00:00:-1   negative\r\n");
    state.log.shutdown(); state.log.open("clock.log"); state.globals.time = 0;
    state.log.writeTimeStamped("reopened");
    expect(readFileSync(state.path("clock.log"), "latin1")).toBe("2   00:00:00:00   reopened\r\n");
  });

  test("rejects timestamp conversion only with an open file, before prefix bytes", () => {
    const state = setup(); state.globals.time = Infinity; state.log.writeTimeStamped("ignored");
    state.variables.set("log", "1"); state.log.open("clock.log");
    for (const time of [Infinity, -Infinity, NaN, 2147483648, -2147483648]) {
      state.globals.time = time;
      expect(() => state.log.writeTimeStamped("invalid")).toThrow(RangeError);
    }
    state.log.flush();
    expect(readFileSync(state.path("clock.log")).length).toBe(0);
    state.globals.time = 0; state.log.writeTimeStamped("first");
    expect(readFileSync(state.path("clock.log"), "latin1")).toBe("0   00:00:00:00   first\r\n");
  });

  test("preserves the timestamp prefix before rejecting invalid body bytes", () => {
    const state = setup(); state.variables.set("log", "1"); state.log.open("partial.log");
    expect(() => state.log.writeTimeStamped("漢")).toThrow(RangeError);
    expect(readFileSync(state.path("partial.log")).length).toBe(0);
    state.log.flush();
    expect(readFileSync(state.path("partial.log"), "latin1")).toBe("0   00:00:00:00   ");
    state.log.writeTimeStamped("valid");
    expect(readFileSync(state.path("partial.log"), "latin1")).toBe("0   00:00:00:00   0   00:00:00:00   valid\r\n");
  });

  test("expected open failure prints source error and allows a later successful open", () => {
    const state = setup(); state.variables.set("log", "1");
    mkdirSync(state.path("directory.log"), { recursive: true });
    expect(state.log.open("directory.log").kind).toBe("failed");
    expect(state.log.filePointer()).toBeNull();
    expect(state.output).toEqual([{ severity: 3, text: "can't open the log file directory.log\n" }]);
    expect(state.log.open("recovered.log").kind).toBe("ok");
  });

  test("failed close retains the source pointer and rejects invalid FILE reuse without reopening", () => {
    const state = setup(); state.variables.set("log", "1");
    const failure = new Error("source fclose failure");
    let closes = 0, opens = 0;
    const log = new BotLog({ variables: state.variables, globals: state.globals,
      openFile: filename => {
        opens++;
        const result = state.files.openBotLog(filename);
        if (result.kind === "failed") return result;
        return { kind: "opened", stream: {
          write: bytes => result.stream.write(bytes), flush: () => result.stream.flush(),
          close: () => {
            closes++;
            expect(result.stream.close()).toEqual({ kind: "ok" });
            return { kind: "failed", error: failure };
          },
        } };
      },
      print: (severity, text) => { state.output.push({ severity, text }); return undefined; } });
    log.open("failed-close.log"); log.write("retained content");
    const file = log.filePointer();
    expect(log.close()).toEqual({ kind: "failed", error: failure });
    expect(log.filePointer()).toBe(file);
    expect(log.open("must-not-open.log")).toEqual({ kind: "ok" });
    expect(opens).toBe(1); expect(closes).toBe(1);
    expect(existsSync(state.path("must-not-open.log"))).toBe(false);
    expect(state.output.slice(-2)).toEqual([
      { severity: 3, text: "can't close log file failed-close.log\n" },
      { severity: 3, text: "log file failed-close.log is already opened\n" },
    ]);
    for (const operation of [() => log.write("invalid"), () => log.writeTimeStamped("invalid"),
      () => log.flush(), () => log.close(), () => log.shutdown(), () => file?.write("invalid")]) {
      expect(operation).toThrow("FILE is closed");
    }
    expect(closes).toBe(1);
    expect(log.disposeResources()).toEqual({ kind: "ok" });
    expect(log.filePointer()).toBeNull();
    expect(closes).toBe(1);
    expect(readFileSync(state.path("failed-close.log"), "latin1")).toBe("retained content");
    expect(log.open("recovered.log")).toEqual({ kind: "ok" });
  });

  test("close keeps the pointer during the stream callback and clears it before success printing", () => {
    const state = setup(); state.variables.set("log", "1");
    let log: BotLog;
    log = new BotLog({ variables: state.variables, globals: state.globals,
      openFile: filename => {
        const result = state.files.openBotLog(filename);
        if (result.kind === "failed") return result;
        return { kind: "opened", stream: {
          write: bytes => result.stream.write(bytes), flush: () => result.stream.flush(),
          close: () => {
            expect(log.filePointer()).not.toBeNull();
            log.open("during-close.log");
            return result.stream.close();
          },
        } };
      },
      print: (severity, text) => {
        state.output.push({ severity, text });
        if (text === "Closed log first.log\n") {
          expect(log.filePointer()).toBeNull();
          log.open("after-close.log");
        }
        return undefined;
      } });
    log.open("first.log");
    expect(log.close()).toEqual({ kind: "ok" });
    expect(existsSync(state.path("during-close.log"))).toBe(false);
    expect(existsSync(state.path("after-close.log"))).toBe(true);
    log.write("new owner");
    expect(readFileSync(state.path("after-close.log"), "latin1")).toBe("new owner");
    expect(state.output).toEqual([
      { severity: 1, text: "Opened log first.log\n" },
      { severity: 3, text: "log file first.log is already opened\n" },
      { severity: 1, text: "Closed log first.log\n" },
      { severity: 1, text: "Opened log after-close.log\n" },
    ]);
  });

  test("captures each real home/product namespace and documents filename host mapping", () => {
    const first = setup("baseq3"), second = setup("missionpack"), third = setup("baseq3");
    for (const state of [first, second, third]) { state.variables.set("log", "1"); state.log.open("logs\\é.log\0ignored漢"); }
    first.log.write("one"); second.log.write("two"); third.log.write("three");
    expect(readFileSync(first.path("logs/é.log"), "utf8")).toBe("one");
    expect(readFileSync(second.path("logs/é.log"), "utf8")).toBe("two");
    expect(readFileSync(third.path("logs/é.log"), "utf8")).toBe("three");
    first.log.close(); second.log.write("more");
    expect(readFileSync(second.path("logs/é.log"), "utf8")).toBe("twomore");
    expect(third.log.filePointer()).not.toBeNull();
  });

  test("Opened print sees the actual file and close/reopen callbacks retain the new owner", () => {
    const state = setup(); state.variables.set("log", "1");
    let log: BotLog;
    log = new BotLog({ variables: state.variables, globals: state.globals,
      openFile: filename => state.files.openBotLog(filename),
      print: (severity, text) => {
        state.output.push({ severity, text });
        if (text === "Opened log first.log\n") { log.write("first"); log.close(); }
        if (text === "Closed log first.log\n") { log.open("second.log"); log.write("second"); }
        return undefined;
      } });
    log.open("first.log");
    expect(readFileSync(state.path("first.log"), "utf8")).toBe("first");
    expect(readFileSync(state.path("second.log"), "utf8")).toBe("second");
    log.write(" retained");
    expect(readFileSync(state.path("second.log"), "utf8")).toBe("second retained");
  });

  test("failed Opened print retains its actual resource for explicit terminal cleanup", () => {
    const state = setup(); state.variables.set("log", "1");
    const failure = new Error("opened print failed");
    const log = new BotLog({ variables: state.variables, globals: state.globals,
      openFile: filename => state.files.openBotLog(filename),
      print: (_severity, text) => { if (text.startsWith("Opened")) throw failure; return undefined; } });
    expect(() => log.open("retained.log")).toThrow(failure);
    const file = log.filePointer();
    expect(file).not.toBeNull();
    log.write("retained"); expect(log.shutdown()).toEqual({ kind: "ok" });
    expect(() => file?.write("closed")).toThrow("closed");
    expect(readFileSync(state.path("retained.log"), "utf8")).toBe("retained");
  });

  test("long stored-name guard follows real acquisition and cleanup still consumes that stream", () => {
    const state = setup(); state.variables.set("log", "1");
    const name = `${"abcdefghij/".repeat(93)}target.log`;
    expect(name.length).toBeGreaterThanOrEqual(1024);
    expect(() => state.log.open(name)).toThrow("not NUL-terminated");
    const file = state.log.filePointer();
    expect(file).not.toBeNull(); expect(existsSync(state.path(name))).toBe(true);
    expect(() => state.log.shutdown()).toThrow("not NUL-terminated");
    expect(state.log.filePointer()).toBeNull();
    expect(() => file?.write("old")).toThrow("closed");
    expect(state.log.shutdown()).toEqual({ kind: "ok" });
    expect(state.log.open("short.log").kind).toBe("ok");
  });

  test("white-box undefined counter boundary preserves prior writes and does not flush", () => {
    const state = setup(); state.variables.set("log", "1"); state.log.open("overflow.log");
    const descriptor = Object.getOwnPropertyDescriptor(state.log, "numwrites");
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error("Expected actual logger own counter data property");
    }
    const count: unknown = descriptor.value;
    if (typeof count !== "number" || count !== 0 || descriptor.writable !== true) throw new Error("Unexpected initial counter state");
    Object.defineProperty(state.log, "numwrites", { value: 2147483647 });
    expect(() => state.log.writeTimeStamped("last")).toThrow("numwrites increment would overflow");
    expect(readFileSync(state.path("overflow.log")).length).toBe(0);
    state.log.flush();
    expect(readFileSync(state.path("overflow.log"), "latin1")).toBe("2147483647   00:00:00:00   last\r\n");
  });
});
