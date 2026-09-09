// linux_signals.c InitSig/signal_handler and unix_main.c Sys_Exit.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import { CvarRegistry } from "../src/core/cvar.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import type { UnixSignalName, UnixSignalRuntime } from "../src/platform/unix-io.ts";

const sourceSignals: readonly [UnixSignalName, number][] = [
  ["SIGHUP", 1], ["SIGQUIT", 3], ["SIGILL", 4], ["SIGTRAP", 5], ["SIGIOT", 6],
  ["SIGBUS", 7], ["SIGFPE", 8], ["SIGSEGV", 11], ["SIGTERM", 15],
];

class SignalExit extends Error {
  constructor(readonly status: 0 | 1) { super(`exit ${status}`); }
}

function fixture() {
  const handlers = new Map<UnixSignalName, () => undefined>(), trace: string[] = [];
  const runtime: UnixSignalRuntime = {
    install: (name, handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate signal listener ${name}`);
      handlers.set(name, handler);
    },
    remove: (name, handler) => { if (handlers.get(name) === handler) handlers.delete(name); },
    write: text => { trace.push(text); },
    exit: status => { trace.push(`exit ${status}`); throw new SignalExit(status); },
  };
  const stdin = new PassThrough();
  const io = new UnixIo(text => { trace.push(`common ${text}`); }, { milliseconds: () => 77 }, { stdin, signals: runtime });
  return { io, runtime, handlers, trace,
    signal: (name: UnixSignalName): undefined => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`Signal ${name} was not installed`);
      return handler();
    },
    close: (): void => { io.close(); stdin.destroy(); },
  };
}

async function childProbe(): Promise<void> {
  const originalInt = process.listenerCount("SIGINT");
  const io = new UnixIo(() => undefined, { milliseconds: () => 0 });
  io.initializeSignals(null);
  if (process.listenerCount("SIGINT") !== originalInt) throw new Error("InitSig added SIGINT");
  const other = new UnixIo(() => undefined, { milliseconds: () => 0 });
  let rejected = false;
  try { other.initializeSignals(null); }
  catch (error) { rejected = error instanceof Error && error.message === "Unix process signals already have an owner"; }
  other.close();
  if (!rejected) throw new Error("Second process signal owner was accepted");
  io.close();
  const replacement = new UnixIo(() => undefined, { milliseconds: () => 0 });
  replacement.initializeSignals(null);
  process.on("exit", () => { writeSync(1, "unexpected process exit callback\n"); });
  writeSync(1, "ready\n");
  await Bun.sleep(10000);
  throw new Error("Signal child deadline expired");
}

async function ttyChildProbe(): Promise<void> {
  const io = new UnixIo(text => { writeSync(1, text); }, { milliseconds: () => 0 });
  io.bindConsoleCompletion(() => undefined);
  io.initializeConsole(new CvarRegistry());
  io.initializeSignals(() => { writeSync(1, "graphics shutdown\n"); });
  writeSync(1, `profile ${io.consoleProfile}\n`);
  process.kill(process.pid, "SIGTERM");
  await Bun.sleep(10000);
  throw new Error("TTY signal child deadline expired");
}

if (process.argv.includes("--unix-signal-tty-child")) {
  await ttyChildProbe();
} else if (process.argv.includes("--unix-signal-child")) {
  await childProbe();
} else describe("Unix source signal lifecycle", () => {
  test("InitSig installs the source signals separately from console initialization", () => {
    const probe = fixture(), cvars = new CvarRegistry(); cvars.set("ttycon", "0");
    try {
      probe.io.initializeConsole(cvars);
      expect([...probe.handlers.keys()]).toEqual([]);
      probe.io.initializeSignals(null);
      expect([...probe.handlers.keys()]).toEqual(sourceSignals.map(([name]) => name));
      probe.io.initializeSignals(null);
      expect(probe.handlers.size).toBe(9);
      probe.io.close(); probe.io.close();
      expect(probe.handlers.size).toBe(0);
    } finally { probe.close(); }
  });

  test("every first signal prints its number and exits without ordinary quit or common output", () => {
    for (const [name, number] of sourceSignals) {
      const probe = fixture();
      try {
        probe.io.initializeSignals(null);
        probe.io.queueEvent({ kind: "console", time: 12, text: "status" });
        expect(() => probe.signal(name)).toThrow("exit 0");
        expect(probe.trace).toEqual([`Received signal ${number}, exiting...\n`, "exit 0"]);
        expect(probe.io.takeQueuedEvent()).toEqual({ kind: "console", time: 12, text: "status" });
        expect(probe.io.takeQueuedEvent()).toBeNull();
      } finally { probe.close(); }
    }
  });

  test("graphical platform shutdown is synchronous between signal output and exit", () => {
    const probe = fixture();
    try {
      probe.io.initializeSignals(() => { probe.trace.push("window close"); });
      expect(() => probe.signal("SIGTERM")).toThrow("exit 0");
      expect(probe.trace).toEqual(["Received signal 15, exiting...\n", "window close", "exit 0"]);
    } finally { probe.close(); }
  });

  test("a signal during graphical shutdown takes the double-fault exit without replaying graphics", () => {
    const probe = fixture();
    try {
      probe.io.initializeSignals(() => { probe.trace.push("window close"); probe.signal("SIGQUIT"); });
      expect(() => probe.signal("SIGHUP")).toThrow("exit 1");
      expect(probe.trace).toEqual(["Received signal 1, exiting...\n", "window close",
        "DOUBLE SIGNAL FAULT: Received signal 3, exiting...\n", "exit 1"]);
    } finally { probe.close(); }
  });

  test("reinitialization keeps caught state while independent contexts keep their own state", () => {
    const first = fixture(), second = fixture();
    try {
      first.io.initializeSignals(null); second.io.initializeSignals(null);
      expect(() => first.signal("SIGILL")).toThrow("exit 0");
      first.io.initializeSignals(() => { first.trace.push("unexpected graphics"); });
      expect(() => first.signal("SIGTERM")).toThrow("exit 1");
      expect(() => second.signal("SIGTERM")).toThrow("exit 0");
      expect(first.trace).toEqual(["Received signal 4, exiting...\n", "exit 0",
        "DOUBLE SIGNAL FAULT: Received signal 15, exiting...\n", "exit 1"]);
      expect(second.trace).toEqual(["Received signal 15, exiting...\n", "exit 0"]);
    } finally { first.close(); second.close(); }
  });

  test("partial signal installation removes only installed handlers and permits retry", () => {
    const probe = fixture(), install = probe.runtime.install;
    let reject = true;
    probe.runtime.install = (name, handler) => {
      if (reject && name === "SIGBUS") throw new Error("install failed");
      install(name, handler);
    };
    try {
      expect(() => probe.io.initializeSignals(null)).toThrow("install failed");
      expect(probe.handlers.size).toBe(0);
      reject = false; probe.io.initializeSignals(null);
      expect(probe.handlers.size).toBe(9);
    } finally { probe.close(); }
  });

  test("signal removal continues after a callback failure and close remains idempotent", () => {
    const probe = fixture(), remove = probe.runtime.remove;
    probe.runtime.remove = (name, handler) => {
      remove(name, handler);
      if (name === "SIGILL") throw new Error("remove failed");
    };
    probe.io.initializeSignals(null);
    try {
      expect(() => probe.io.close()).toThrow("Dedicated input cleanup failed");
      expect(probe.handlers.size).toBe(0);
      expect(() => probe.io.close()).not.toThrow();
    } finally { probe.close(); }
  });

  test("owned children receive externally sent signals and use _exit without process exit callbacks", async () => {
    // These are externally delivered signals, not hardware-fault recovery tests.
    for (const [name, number] of sourceSignals) {
      const child = Bun.spawn([process.execPath, import.meta.path, "--unix-signal-child"], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000, killSignal: "SIGKILL",
      });
      try {
        const reader = child.stdout.getReader(), first = await reader.read();
        expect(first.done).toBe(false);
        expect(new TextDecoder().decode(first.value)).toBe("ready\n");
        child.kill(name === "SIGIOT" ? "SIGABRT" : name);
        const remainingOutput = async (): Promise<string> => {
          const decoder = new TextDecoder(); let text = "";
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return text + decoder.decode();
            text += decoder.decode(chunk.value, { stream: true });
          }
        };
        const [status, stdout, stderr] = await Promise.all([
          child.exited, remainingOutput(), new Response(child.stderr).text(),
        ]);
        expect(status).toBe(0);
        expect(stdout).toBe(`Received signal ${number}, exiting...\n`);
        expect(stderr).toBe("");
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }
  });

  test("signal exit restores the exact owned private PTY settings after graphical shutdown", async () => {
    const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
    const command = [
      "stty -g",
      `${quote(process.execPath)} ${quote(import.meta.path)} --unix-signal-tty-child`,
      "stty -g",
    ].join("\n");
    // script allocates a private PTY. No user terminal or SDL device is used.
    const child = Bun.spawn(["/usr/bin/script", "--quiet", "--return", "--command", command, "/dev/null"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000, killSignal: "SIGKILL",
    });
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0); expect(stderr).toBe("");
      const lines = stdout.replaceAll("\r", "").trim().split("\n");
      const before = lines[0], after = lines.at(-1);
      expect(before).toMatch(/^[0-9a-f]+:/);
      expect(after).toBe(before);
      expect(lines.slice(1, -1)).toEqual([
        "Started tty console (use +set ttycon 0 to disable)", "profile tty-linux-glibc",
        "Received signal 15, exiting...", "graphics shutdown", "Shutdown tty console",
      ]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
});
