import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { BotLog } from "../src/botlib/log.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";

const directories: string[] = [];
const owners: WritableFileSystem[] = [];
afterEach(() => {
  mock.restore();
  for (const owner of owners.splice(0)) owner.closeAll();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function files(): WritableFileSystem {
  const homePath = fs.mkdtempSync(join(tmpdir(), "q3-bot-log-io-"));
  directories.push(homePath);
  const owner = new WritableFileSystem({ homePath, product: "baseq3", print: () => undefined });
  owners.push(owner);
  return owner;
}

function actualFstatError(): Error {
  const descriptor = fs.openSync("/dev/null", "r");
  fs.closeSync(descriptor);
  try { fs.fstatSync(descriptor); }
  catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error("Expected native invalid-descriptor fstat error");
}

class PlatformFailure extends Error {
  readonly code = "EIO";
  readonly errno = 5;
  constructor(readonly syscall: string, message: string) { super(message); }
}

function aggregateErrors(error: Error): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  const value: unknown = error.errors;
  if (!Array.isArray(value)) throw new Error("Invalid aggregate error array");
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) { const item: unknown = value[index]; result.push(item); }
  return result;
}

describe("bot log owned I/O failure boundary", () => {
  test("returns an actual fstat platform failure while closing the acquired target", () => {
    const owner = files(), failure = actualFstatError();
    const fstat = spyOn(fs, "fstatSync").mockImplementation(() => { throw failure; });
    const result = owner.openBotLog("fstat.log");
    fstat.mockRestore();
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected fstat failure result");
    expect(result.error).toBe(failure);
    expect(fs.readFileSync(join(owner.rootPath, "fstat.log")).length).toBe(0);
    expect(owner.openBotLog("recovered.log").kind).toBe("opened");
  });

  test("does not turn programming or path-security exceptions into expected I/O results", () => {
    const owner = files(), failure = new Error("programming failure in fstat call");
    const fstat = spyOn(fs, "fstatSync").mockImplementation(() => { throw failure; });
    expect(() => owner.openBotLog("program.log")).toThrow(failure);
    fstat.mockRestore();
    expect(() => owner.openBotLog("../escape.log")).toThrow(RangeError);
    fs.symlinkSync("/tmp", join(owner.rootPath, "escape"));
    expect(() => owner.openBotLog("escape/payload.log")).toThrow("symbolic link");
  });

  test("preserves original truncate failure then target and root cleanup failures", () => {
    const owner = files(), truncateError = new PlatformFailure("ftruncate", "truncate failed");
    const closeErrors: Error[] = [], closed: number[] = [];
    let truncating = false;
    spyOn(fs, "ftruncateSync").mockImplementation(() => { truncating = true; throw truncateError; });
    const closeSync = fs.closeSync;
    const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor);
      if (truncating) {
        closed.push(descriptor);
        const error = new PlatformFailure("close", `cleanup ${closed.length}`); closeErrors.push(error); throw error;
      }
    });
    const result = owner.openBotLog("truncate.log");
    close.mockRestore();
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected acquisition error");
    expect(aggregateErrors(result.error)).toEqual([truncateError, ...closeErrors]);
    expect(result.error.cause).toBe(truncateError);
    expect(closed.length).toBe(2); expect(new Set(closed).size).toBe(2);
    const targetDescriptor = closed[0];
    if (targetDescriptor === undefined) throw new Error("Expected target close attempt");
    expect(() => fs.fstatSync(targetDescriptor)).toThrow();
  });

  test("target-open failure survives both parent and root close failures", () => {
    const owner = files(), openError = new PlatformFailure("open", "target open failed");
    const openSync = fs.openSync, closeSync = fs.closeSync, closeErrors: Error[] = [];
    let failed = false;
    spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (String(path).endsWith("/target.log")) { failed = true; throw openError; }
      return openSync(path, flags, mode);
    });
    spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor);
      if (failed) { const error = new PlatformFailure("close", `close ${closeErrors.length}`); closeErrors.push(error); throw error; }
    });
    const result = owner.openBotLog("target.log");
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected acquisition error");
    expect(aggregateErrors(result.error)).toEqual([openError, ...closeErrors]);
    expect(result.error.cause).toBe(openError); expect(closeErrors.length).toBe(2);
  });

  test("a final pinned-root close failure consumes the ready target and retains its cleanup error", () => {
    const owner = files(), ftruncateSync = fs.ftruncateSync, closeSync = fs.closeSync, failures: Error[] = [];
    const closed: number[] = [];
    let ready = false;
    spyOn(fs, "ftruncateSync").mockImplementation((descriptor, length) => {
      ftruncateSync(descriptor, length); ready = true;
    });
    const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor);
      if (ready) {
        closed.push(descriptor);
        const error = new PlatformFailure("close", `ready cleanup ${failures.length}`); failures.push(error); throw error;
      }
    });
    const result = owner.openBotLog("ready.log"); close.mockRestore();
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected ready-target cleanup failure");
    expect(aggregateErrors(result.error)).toEqual(failures); expect(result.error.cause).toBe(failures[0]);
    expect(closed.length).toBe(2); expect(new Set(closed).size).toBe(2);
    for (const descriptor of closed) expect(() => fs.fstatSync(descriptor)).toThrow();
    expect(() => owner.closeAll()).not.toThrow();
  });

  test("security failure remains thrown with primary cause and cleanup errors retained", () => {
    const owner = files(); fs.mkdirSync(owner.rootPath, { recursive: true });
    fs.symlinkSync("/tmp", join(owner.rootPath, "linked"));
    const closeSync = fs.closeSync, cleanupErrors: Error[] = [];
    spyOn(fs, "closeSync").mockImplementation(descriptor => {
      const failed = fs.readlinkSync(`/proc/self/fd/${descriptor}`) === owner.rootPath;
      closeSync(descriptor);
      if (failed) { const error = new PlatformFailure("close", `security cleanup ${cleanupErrors.length}`); cleanupErrors.push(error); throw error; }
    });
    let caught: unknown;
    try { owner.openBotLog("linked/payload.log"); } catch (error) { caught = error; }
    expect(caught instanceof AggregateError).toBe(true);
    if (!(caught instanceof AggregateError)) throw new Error("Expected security and cleanup aggregate");
    const errors = aggregateErrors(caught), first = errors[0];
    expect(first instanceof Error && first.message.includes("symbolic link")).toBe(true);
    expect(caught.cause).toBe(first); expect(errors.slice(1)).toEqual(cleanupErrors);
  });

  test("expected open I/O and thrown print failure retain both original identities", () => {
    const owner = files(), failure = actualFstatError(), diagnostic = new Error("diagnostic failure");
    const variables = new BotLibVars(); variables.set("log", "1");
    const log = new BotLog({ variables, globals: { time: 0 }, openFile: path => owner.openBotLog(path),
      print: () => { throw diagnostic; } });
    spyOn(fs, "fstatSync").mockImplementation(() => { throw failure; });
    let caught: unknown;
    try { log.open("failure.log"); } catch (error) { caught = error; }
    expect(caught instanceof AggregateError).toBe(true);
    if (!(caught instanceof AggregateError)) throw new Error("Expected open and diagnostic aggregate");
    expect(caught.cause).toBe(failure); expect(aggregateErrors(caught)).toEqual([failure, diagnostic]);
    expect(log.filePointer()).toBeNull();
  });

  test("terminal closeAll reports a buffered returned failure and still closes later logs", () => {
    const owner = files(), first = owner.openBotLog("first.log"), second = owner.openBotLog("second.log");
    if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected two actual files");
    first.stream.write(new Uint8Array([65])); second.stream.write(new Uint8Array([66]));
    const closeSync = fs.closeSync, error = new PlatformFailure("close", "first close failed");
    let calls = 0;
    const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor); calls++; if (calls === 1) throw error;
    });
    expect(() => owner.closeAll()).toThrow(error); expect(calls).toBe(2);
    expect(() => second.stream.write(new Uint8Array())).toThrow("closed");
    owner.closeAll(); expect(calls).toBe(2); close.mockRestore();
    expect(fs.readFileSync(join(owner.rootPath, "second.log"), "latin1")).toBe("B");
  });

  test("retains every buffered failure from terminal closeAll in attempted order", () => {
    const owner = files(); owner.openBotLog("one.log"); owner.openBotLog("two.log");
    const closeSync = fs.closeSync, failures: Error[] = [];
    const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor);
      const error = new PlatformFailure("close", `close ${failures.length}`); failures.push(error); throw error;
    });
    let caught: unknown;
    try { owner.closeAll(); } catch (error) { caught = error; }
    close.mockRestore();
    expect(caught instanceof AggregateError).toBe(true);
    if (!(caught instanceof AggregateError)) throw new Error("Expected every buffered failure");
    expect(aggregateErrors(caught)).toEqual(failures); expect(caught.cause).toBe(failures[0]);
    expect(failures.length).toBe(2); expect(() => owner.closeAll()).not.toThrow();
  });

  test("legacy-only close failures keep the first error identity and still consume every handle", () => {
    const owner = files(), first = owner.openAppend("one.log", false), second = owner.openWrite("two.log", false);
    if (first === null || second === null) throw new Error("Expected actual legacy logs");
    const closeSync = fs.closeSync, failures: Error[] = [];
    const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor);
      const error = new PlatformFailure("close", `legacy close ${failures.length}`); failures.push(error); throw error;
    });
    let caught: unknown;
    try { owner.closeAll(); } catch (error) { caught = error; }
    close.mockRestore();
    expect(caught).toBe(failures[0]); expect(failures.length).toBe(2);
    expect(() => first.write("closed")).toThrow("closed"); expect(() => second.write("closed")).toThrow("closed");
    expect(() => owner.closeAll()).not.toThrow();
  });

  test("mixed failed buffered and legacy logs retain attempted order in either ownership order", () => {
    for (const bufferedFirst of [false, true]) {
      const owner = files();
      if (bufferedFirst) {
        expect(owner.openBotLog("buffered.log").kind).toBe("opened");
        expect(owner.openAppend("legacy.log", false)).not.toBeNull();
      } else {
        expect(owner.openAppend("legacy.log", false)).not.toBeNull();
        expect(owner.openBotLog("buffered.log").kind).toBe("opened");
      }
      expect(owner.openWrite("last.log", false)).not.toBeNull();
      const closeSync = fs.closeSync, failures: Error[] = [];
      let calls = 0;
      const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
        closeSync(descriptor); calls++;
        if (calls <= 2) {
          const error = new PlatformFailure("close", `mixed close ${calls}`); failures.push(error); throw error;
        }
      });
      let caught: unknown;
      try { owner.closeAll(); } catch (error) { caught = error; }
      close.mockRestore();
      expect(caught instanceof AggregateError).toBe(true);
      if (!(caught instanceof AggregateError)) throw new Error("Expected both mixed close failures");
      expect(aggregateErrors(caught)).toEqual(failures); expect(caught.cause).toBe(failures[0]);
      expect(calls).toBe(3); expect(() => owner.closeAll()).not.toThrow();
    }
  });

  test("a successfully closed buffered log does not change legacy first-error behavior", () => {
    const owner = files();
    expect(owner.openAppend("one.log", false)).not.toBeNull();
    expect(owner.openBotLog("successful.log").kind).toBe("opened");
    expect(owner.openWrite("two.log", false)).not.toBeNull();
    const closeSync = fs.closeSync, failures: Error[] = [];
    let calls = 0;
    const close = spyOn(fs, "closeSync").mockImplementation(descriptor => {
      closeSync(descriptor); calls++;
      if (calls !== 2) {
        const error = new PlatformFailure("close", `legacy close ${calls}`); failures.push(error); throw error;
      }
    });
    let caught: unknown;
    try { owner.closeAll(); } catch (error) { caught = error; }
    close.mockRestore();
    expect(caught).toBe(failures[0]); expect(failures.length).toBe(2);
    expect(calls).toBe(3); expect(() => owner.closeAll()).not.toThrow();
  });
});
