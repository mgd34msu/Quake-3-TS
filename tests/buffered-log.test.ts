import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BufferedLog } from "../src/assets/buffered-log.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { BotLog } from "../src/botlib/log.ts";
import type { BotLogStream } from "../src/botlib/log.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";

const directories: string[] = [];
const streams: BotLogStream[] = [];
afterEach(() => {
  mock.restore();
  for (const stream of streams.splice(0)) stream.close();
  for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

function temporary(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "q3-buffered-log-")); directories.push(root); return root;
}
function file() {
  const path = join(temporary(), "stream.log"), descriptor = fs.openSync(path, "w");
  let unregistered = 0;
  const stream = new BufferedLog(descriptor, path, () => { unregistered++; });
  streams.push(stream);
  return { path, descriptor, stream, unregistered: () => unregistered };
}
function device() {
  const descriptor = fs.openSync("/dev/full", "w");
  let unregistered = 0;
  const stream = new BufferedLog(descriptor, "/dev/full", () => { unregistered++; });
  streams.push(stream);
  return { stream, descriptor, unregistered: () => unregistered };
}
function bytes(text: string): Uint8Array { return Buffer.from(text, "latin1"); }
function expectClosed(descriptor: number): void { expect(() => fs.fstatSync(descriptor)).toThrow(); }

describe("TypeScript printf-output buffer", () => {
  test("real regular-file partial writes match native small and large EFBIG recovery", () => {
    for (const mode of ["short", "large"]) {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/bot-log-resource-limit.ts"), mode], { stdout: "pipe", stderr: "pipe" });
      expect(new TextDecoder().decode(result.stderr)).toBe(""); expect(result.exitCode).toBe(0);
      const value: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
      const prefix = mode === "large" ? "51".repeat(4100) : "4142434445";
      expect(value).toEqual({ kind: "ok", afterError: prefix, afterRecovery: `${prefix}5859`,
        diagnostics: ["Opened log limit.log\n", "Closed log limit.log\n"] });
    }
  });

  test("real regular-file pending close failure keeps native partial bytes and diagnostic", () => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/bot-log-resource-limit.ts"), "pending-close"], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(result.stderr)).toBe(""); expect(result.exitCode).toBe(0);
    const value: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(value).toEqual({ kind: "failed", bytes: "4142434445",
      diagnostics: ["Opened log limit.log\n", "can't close log file limit.log\n"] });
  });

  test("matches native formatted-output visibility at ten buffer boundaries", () => {
    const cases: readonly (readonly [number, number])[] = [
      [0, 0], [1, 0], [4095, 0], [4096, 0], [4097, 4096],
      [8191, 4096], [8192, 4096], [8193, 8192], [16384, 12288], [16385, 16384],
    ];
    for (const [length, before] of cases) {
      const state = file(), input = new Uint8Array(length).fill(81);
      expect(state.stream.write(input)).toEqual({ kind: "ok" });
      expect(fs.statSync(state.path).size).toBe(before);
      expect(state.stream.flush()).toEqual({ kind: "ok" });
      expect(fs.readFileSync(state.path)).toEqual(Buffer.from(input));
      expect(state.stream.close()).toEqual({ kind: "ok" });
      expect(state.unregistered()).toBe(1);
    }
  });

  test("copies pending input, shares calls, and preserves embedded zero and high bytes", () => {
    const state = file(), input = new Uint8Array([65, 0, 233, 255, 66]);
    state.stream.write(input); input.fill(77);
    state.stream.write(bytes("/x/\0/é"));
    expect(fs.statSync(state.path).size).toBe(0);
    state.stream.flush();
    expect(fs.readFileSync(state.path).toString("hex")).toBe("4100e9ff422f782f002fe9");
    state.stream.close(); state.stream.close();
    expect(state.unregistered()).toBe(1);
    expect(() => state.stream.write(new Uint8Array())).toThrow("closed");
    expect(() => state.stream.flush()).toThrow("closed");
  });

  test("real ENOSPC flush discards its tail, empty flush and close still succeed", () => {
    const state = device();
    expect(state.stream.write(bytes("full"))).toEqual({ kind: "ok" });
    const failed = state.stream.flush();
    expect(failed.kind).toBe("failed");
    if (failed.kind !== "failed") throw new Error("Expected actual ENOSPC");
    expect("code" in failed.error && failed.error.code).toBe("ENOSPC");
    expect(state.stream.flush()).toEqual({ kind: "ok" });
    expect(state.stream.close()).toEqual({ kind: "ok" });
    expect(state.unregistered()).toBe(1); expectClosed(state.descriptor);
  });

  test("real ENOSPC close with pending bytes returns failure and consumes once", () => {
    const state = device(); state.stream.write(bytes("pending"));
    const result = state.stream.close();
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("Expected pending flush failure");
    expect("code" in result.error && result.error.code).toBe("ENOSPC");
    expectClosed(state.descriptor);
    expect(state.stream.close()).toEqual({ kind: "ok" }); expect(state.unregistered()).toBe(1);
  });

  test("real invalid descriptor aggregates flush then close failures without retry", () => {
    const state = file(); state.stream.write(bytes("pending")); fs.closeSync(state.descriptor);
    const close = spyOn(fs, "closeSync");
    const result = state.stream.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed" || !(result.error instanceof AggregateError)) throw new Error("Expected flush+close aggregate");
    const failures: unknown = result.error.errors;
    if (!Array.isArray(failures)) throw new Error("Expected aggregate error array");
    expect(failures.length).toBe(2);
    const first: unknown = failures[0];
    expect(result.error.cause).toBe(first);
    for (const index of [0, 1]) {
      const failure: unknown = failures[index];
      expect(failure instanceof Error && "code" in failure && failure.code).toBe("EBADF");
    }
    expect(state.stream.close()).toEqual({ kind: "ok" }); expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore(); expect(state.unregistered()).toBe(1);
  });

  test("zero write ends one attempt without retries or stale-tail replay", () => {
    const state = file(); state.stream.write(bytes("lost"));
    const write = spyOn(fs, "writeSync").mockImplementation(() => 0);
    expect(state.stream.flush().kind).toBe("failed"); expect(write).toHaveBeenCalledTimes(1);
    expect(state.stream.flush()).toEqual({ kind: "ok" }); expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore(); state.stream.write(bytes("new")); state.stream.flush();
    expect(fs.readFileSync(state.path, "latin1")).toBe("new");
  });

  test("automatic flush failure drops only that write's remaining output", () => {
    const state = file(); const write = spyOn(fs, "writeSync").mockImplementation(() => 0);
    expect(state.stream.write(new Uint8Array(12288).fill(81)).kind).toBe("failed");
    expect(write).toHaveBeenCalledTimes(1); write.mockRestore();
    state.stream.flush(); expect(fs.statSync(state.path).size).toBe(0);
    state.stream.write(bytes("later")); state.stream.flush();
    expect(fs.readFileSync(state.path, "latin1")).toBe("later");
  });

  test("timestamp calls continue after an expected body write failure and retain the counter", () => {
    const state = file(), variables = new BotLibVars(); variables.set("log", "1");
    const log = new BotLog({ variables, globals: { time: 0 },
      openFile: () => ({ kind: "opened", stream: state.stream }), print: () => undefined });
    log.open("timestamp.log");
    const write = spyOn(fs, "writeSync").mockImplementationOnce(() => 0);
    log.writeTimeStamped("Q".repeat(12288));
    expect(write).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(state.path, "latin1")).toBe("\r\n");
    log.writeTimeStamped("later");
    expect(fs.readFileSync(state.path, "latin1")).toBe("\r\n1   00:00:00:00   later\r\n");
    write.mockRestore(); expect(log.close()).toEqual({ kind: "ok" });
  });

  test("programming write errors propagate but do not prevent close and unregister", () => {
    const state = file(), failure = new Error("programming write failure");
    state.stream.write(bytes("pending"));
    const write = spyOn(fs, "writeSync").mockImplementation(() => { throw failure; });
    expect(() => state.stream.close()).toThrow(failure); write.mockRestore();
    expectClosed(state.descriptor); expect(state.unregistered()).toBe(1);
    expect(state.stream.close()).toEqual({ kind: "ok" });
  });

  test("source Log_Write and close produce exact native ENOSPC diagnostics", () => {
    for (const pending of [false, true]) {
      const state = device(), variables = new BotLibVars(), output: string[] = [];
      variables.set("log", "1");
      const log = new BotLog({ variables, globals: { time: 0 },
        openFile: () => ({ kind: "opened", stream: state.stream }),
        print: (_severity, text) => { output.push(text); return undefined; } });
      log.open("botlib.log");
      if (pending) log.filePointer()?.write("pending"); else log.write("full");
      expect(log.close().kind).toBe(pending ? "failed" : "ok");
      expect(output).toEqual(["Opened log botlib.log\n", pending ? "can't close log file botlib.log\n" : "Closed log botlib.log\n"]);
      expect(log.filePointer()).toBeNull(); expectClosed(state.descriptor);
    }
  });

  test("failed close consumes old borrow before diagnostic reopens a real file", () => {
    const state = device(), variables = new BotLibVars(), output: string[] = [];
    const files = new WritableFileSystem({ homePath: temporary(), product: "missionpack", print: () => undefined });
    variables.set("log", "1");
    let log: BotLog;
    log = new BotLog({ variables, globals: { time: 0 },
      openFile: name => name === "first.log" ? { kind: "opened", stream: state.stream } : files.openBotLog(name),
      print: (_severity, text) => {
        output.push(text);
        if (text === "can't close log file first.log\n") { log.open("next.log"); log.write("new owner"); }
        return undefined;
      } });
    try {
      log.open("first.log"); const old = log.filePointer(); old?.write("pending");
      expect(log.close().kind).toBe("failed");
      expect(() => old?.write("stale")).toThrow("closed");
      expect(fs.readFileSync(join(files.rootPath, "next.log"), "latin1")).toBe("new owner");
      expect(log.filePointer()).not.toBeNull(); log.shutdown();
    } finally { files.closeAll(); }
  });

  test("failed close and throwing diagnostic preserve the original I/O failure", () => {
    const state = device(), variables = new BotLibVars(), diagnostic = new Error("diagnostic failed");
    variables.set("log", "1");
    const log = new BotLog({ variables, globals: { time: 0 }, openFile: () => ({ kind: "opened", stream: state.stream }),
      print: (_severity, text) => { if (text.startsWith("can't close")) throw diagnostic; return undefined; } });
    log.open("failure.log"); const old = log.filePointer(); old?.write("pending");
    let caught: unknown;
    try { log.close(); } catch (error) { caught = error; }
    expect(caught instanceof AggregateError).toBe(true);
    if (!(caught instanceof AggregateError)) throw new Error("Expected I/O plus diagnostic failure");
    const failures: unknown = caught.errors;
    if (!Array.isArray(failures)) throw new Error("Expected aggregate error array");
    const first: unknown = failures[0], second: unknown = failures[1];
    expect(failures.length).toBe(2); expect(caught.cause).toBe(first); expect(second).toBe(diagnostic);
    expect(log.filePointer()).toBeNull(); expect(() => old?.write("old")).toThrow("closed");
    expect(log.close()).toEqual({ kind: "ok" }); expectClosed(state.descriptor);
  });
});
