// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { CommonEventMemory } from "../src/engine/event-memory.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { MAX_UNIX_CONSOLE_LINE, MAX_UNIX_SYSTEM_EVENTS, UnixIo } from "../src/platform/unix-io.ts";
import { TtyConsole } from "../src/platform/tty-console.ts";
import { MAX_DATAGRAM_LENGTH, UdpTransport } from "../src/platform/network.ts";
import type { Ipv4Address, Ipv4Host } from "../src/platform/network.ts";

const localhost: Ipv4Host = [127, 0, 0, 1];

function cvarsForNetwork(port = 0): CvarRegistry {
  const cvars = new CvarRegistry();
  cvars.set("net_ip", "127.0.0.1"); cvars.set("net_port", String(port));
  return cvars;
}

function requireUdp(input: UnixIo): UdpTransport {
  const udp = input.udp;
  if (udp === null) throw new Error("Expected initialized UDP");
  return udp;
}

function waitReadable(udp: UdpTransport): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Local UDP readiness deadline expired")); }, 2000);
    const unsubscribe = udp.subscribeReadable(() => { unsubscribe(); clearTimeout(timer); resolve(); });
    if (udp.statistics.pending > 0) { unsubscribe(); clearTimeout(timer); resolve(); }
  });
}

function getDedicatedEvent(unix: UnixIo): CommonSystemEvent {
  return new DedicatedEventSource(unix).getEvent();
}

function consoleText(event: CommonSystemEvent): string {
  if (event.kind !== "console") throw new Error(`Expected console, received ${event.kind}`);
  return event.text;
}

function waitEnd(stdin: PassThrough): Promise<void> {
  return new Promise<void>(resolve => { stdin.once("end", () => { resolve(); }); });
}

function ttyFixture(erase = 127) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const commands = new CommandBuffer(), cvars = new CvarRegistry(), diagnostics: string[] = [];
  const editor: TtyConsole = new TtyConsole({ erase,
    write: byte => { stdout.write(Uint8Array.of(byte)); },
    complete: field => { field.complete(commands, cvars, text => {
      editor.hide(); stdout.write(Buffer.from(text, "latin1")); editor.show();
    }); },
    developerPrint: text => { diagnostics.push(text); },
  });
  return {
    stdin, editor, commands, cvars, diagnostics,
    poll: (): string | null => editor.poll(() => {
      const chunk: unknown = stdin.read(1);
      if (chunk === null) return null;
      if (!(chunk instanceof Uint8Array) || chunk.length !== 1) throw new Error("Expected one fixture byte");
      const byte = chunk[0];
      if (byte === undefined) throw new Error("Expected a fixture byte");
      return byte;
    }),
    output: (): string => {
      const chunk: unknown = stdout.read();
      if (chunk === null) return "";
      if (!(chunk instanceof Uint8Array)) throw new Error("Expected fixture output bytes");
      return Buffer.from(chunk).toString("latin1");
    },
    close: (): void => { stdin.destroy(); stdout.destroy(); },
  };
}

async function occupyTenPorts(): Promise<readonly UdpTransport[]> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const first = await UdpTransport.bind({ host: localhost, port: 0 });
    const occupied = [first];
    try {
      for (let offset = 1; offset < 10; offset++) occupied.push(await UdpTransport.bind({ host: localhost, port: first.address.port + offset }));
      return occupied;
    } catch { for (const socket of occupied) socket.close(); }
  }
  throw new Error("Could not reserve a contiguous localhost port fixture");
}

class ChildLines {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private text = "";
  private readonly decoder = new TextDecoder();
  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }
  async next(): Promise<string> {
    while (true) {
      const newline = this.text.indexOf("\n");
      if (newline >= 0) { const line = this.text.slice(0, newline); this.text = this.text.slice(newline + 1); return line; }
      const result = await this.reader.read();
      if (result.done) throw new Error(`Child output ended before newline: ${this.text}`);
      this.text += this.decoder.decode(result.value, { stream: true });
    }
  }
}

async function childProbe(): Promise<void> {
  const input = new UnixIo(() => undefined, new UnixSystemClock()), cvars = cvarsForNetwork();
  await input.initializeNetwork(cvars);
  input.initializeConsole(cvars);
  input.initializeSignals(null);
  try {
    process.stdout.write(`ready ${requireUdp(input).address.port}\n`);
    let running = true, eofReported = false;
    while (running) {
      await input.yieldToIo();
      while (true) {
        const event = getDedicatedEvent(input);
        if (event.kind === "none") break;
        if (event.kind === "console") {
          process.stdout.write(`console ${Buffer.from(event.text, "latin1").toString("hex")}\n`);
          if (event.text === "quit") { running = false; break; }
        } else if (event.kind === "packet") { process.stdout.write(`packet ${event.payload.length}\n`); running = false; break; }
        else throw new Error(`Dedicated source received ${event.kind}`);
      }
      if (!input.consoleActive && !eofReported) { eofReported = true; process.stdout.write("eof active=false\n"); }
      if (running) await input.sleepUntilInput(60000);
    }
  } finally { input.close(); input.close(); }
  process.stdout.write("closed\n");
}

if (process.argv.includes("--dedicated-input-child")) {
  await childProbe();
} else describe("dedicated Bun system input", () => {
  test("raw TTY polls one byte, echoes backspace aliases and submits on newline", () => {
    const tty = ttyFixture(21);
    try {
      tty.stdin.write(Buffer.from("ab\x15c\x7fd\be\n", "latin1"));
      for (let i = 0; i < 8; i++) expect(tty.poll()).toBeNull();
      expect(tty.poll()).toBe("ae"); expect(tty.poll()).toBeNull();
      expect(tty.output()).toBe("ab\b \bc\b \bd\b \be\n");
      tty.stdin.write("\n"); expect(tty.poll()).toBe(""); expect(tty.output()).toBe("\n");
    } finally { tty.close(); }
  });

  test("raw TTY nested hide and show remove and redraw the input exactly once", () => {
    const tty = ttyFixture();
    try {
      tty.stdin.write("abc"); for (let i = 0; i < 3; i++) tty.poll(); expect(tty.output()).toBe("abc");
      tty.editor.hide(); tty.editor.hide(); expect(tty.output()).toBe("\b \b".repeat(3));
      tty.editor.show(); expect(tty.output()).toBe(""); tty.editor.show(); expect(tty.output()).toBe("abc");
      expect(() => tty.editor.show()).toThrow("without hide");
    } finally { tty.close(); }
  });

  test("raw TTY keeps 32 copied history fields including empty submissions and flushes arrow suffixes", () => {
    const tty = ttyFixture();
    try {
      for (let i = 0; i < 35; i++) {
        const line = String(i); tty.stdin.write(`${line}\n`);
        for (let c = 0; c < line.length; c++) tty.poll();
        expect(tty.poll()).toBe(line);
      }
      tty.output();
      for (let i = 0; i < 35; i++) { tty.stdin.write("\x1b[Aignored\n"); expect(tty.poll()).toBeNull(); }
      expect(tty.poll()).toBeNull(); tty.stdin.write("\n"); expect(tty.poll()).toBe("3");
      tty.stdin.write("\x1bOA"); tty.poll(); tty.stdin.write("x\n"); tty.poll(); expect(tty.poll()).toBe("3x");
      tty.stdin.write("\x1b[A"); tty.poll(); tty.stdin.write("\x1b[A"); tty.poll(); tty.stdin.write("\n");
      expect(tty.poll()).toBe("3");
      tty.stdin.write("\n"); expect(tty.poll()).toBe("");
      tty.stdin.write("\x1b[A"); tty.poll(); tty.stdin.write("\n"); expect(tty.poll()).toBe("");
      tty.stdin.write("draft"); for (let i = 0; i < 5; i++) tty.poll();
      tty.stdin.write("\x1b[Bdiscard\n"); tty.poll(); tty.stdin.write("\n"); expect(tty.poll()).toBe("");
    } finally { tty.close(); }
  });

  test("raw TTY completes through actual commands and cvars while nested print keeps the line hidden", () => {
    const tty = ttyFixture();
    try {
      tty.commands.register("map", () => undefined); tty.commands.register("map_restart", () => undefined);
      tty.stdin.write("ma\t"); tty.poll(); tty.poll(); tty.output(); expect(tty.poll()).toBeNull();
      // FindMatches does not shorten its first match when the next name is its prefix.
      expect(tty.output()).toBe("\b \b".repeat(2) + "]\\map_restart\n    map_restart\nmap_restart");
      tty.stdin.write("\n"); expect(tty.poll()).toBe("map_restart"); tty.output();
      tty.cvars.register("sv_hostname", "server");
      const line = "/sv_host \"two words\"  x";
      tty.stdin.write(`${line}\t`); for (let i = 0; i < line.length; i++) tty.poll(); tty.output(); tty.poll();
      expect(tty.output()).toBe("\b \b".repeat(line.length) + "sv_hostname \"two words\"  x");
      tty.stdin.write("\n"); expect(tty.poll()).toBe("sv_hostname \"two words\"  x");
    } finally { tty.close(); }
  });

  test("raw TTY ignores horizontal arrows without flushing and drops incomplete or unknown controls", () => {
    const tty = ttyFixture();
    try {
      tty.stdin.write("\x1b[Cx\n"); tty.poll(); tty.poll(); expect(tty.poll()).toBe("x");
      tty.stdin.write("\x1bODy\n"); tty.poll(); tty.poll(); expect(tty.poll()).toBe("y");
      tty.stdin.write("\x1b"); tty.poll(); tty.stdin.write("[A\n"); tty.poll(); tty.poll(); expect(tty.poll()).toBe("[A");
      tty.stdin.write("\x1b[9discard\n"); tty.poll(); expect(tty.poll()).toBeNull();
      tty.stdin.write(Buffer.from("\xffstale\n", "latin1")); tty.poll(); expect(tty.poll()).toBeNull();
      expect(tty.diagnostics).toEqual([
        "droping ISCTL sequence: 27, tty_erase: 127\n",
        "droping ISCTL sequence: 57, tty_erase: 127\n",
        "droping ISCTL sequence: 115, tty_erase: 127\n",
      ]);
    } finally { tty.close(); }
  });

  test("raw TTY retains NUL and later field bytes in history without expanding the command string", () => {
    const tty = ttyFixture();
    try {
      tty.stdin.write(Buffer.from("a\0b\n", "latin1")); tty.poll(); tty.poll(); tty.poll(); expect(tty.poll()).toBe("a");
      expect(tty.output()).toBe("a\0b\n");
      tty.stdin.write("\x1b[A"); tty.poll(); expect(tty.output()).toBe("a\0b");
      tty.stdin.write("c\n"); tty.poll(); expect(tty.poll()).toBe("a"); expect(tty.output()).toBe("c\n");
    } finally { tty.close(); }
  });

  test("raw TTY exposes source field overflow instead of executing a truncated command", () => {
    const tty = ttyFixture();
    try {
      tty.stdin.write("x".repeat(255) + "\n"); for (let i = 0; i < 255; i++) tty.poll(); expect(tty.poll()).toBe("x".repeat(255));
      tty.stdin.write("x".repeat(256) + "\n"); for (let i = 0; i < 256; i++) tty.poll();
      expect(() => tty.poll()).toThrow("unterminated field buffer");
      tty.stdin.write("x"); expect(() => tty.poll()).toThrow("field buffer index");
    } finally { tty.close(); }
  });

  test("raw TTY host output and completion bindings are inert for pipes and after close", () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), output: string[] = [];
    const input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, stdout, signals: "none" });
    const commands = new CommandBuffer(), cvars = new CvarRegistry(); cvars.set("ttycon", "0");
    try {
      input.withConsoleOutput(() => { output.push("before"); });
      input.bindConsoleCompletion(field => { field.complete(commands, cvars, () => undefined); });
      expect(() => input.bindConsoleCompletion(() => undefined)).toThrow("bind once");
      input.initializeConsole(cvars); input.withConsoleOutput(() => { output.push("pipe"); });
      input.close(); input.withConsoleOutput(() => { output.push("closed"); });
      expect(output).toEqual(["before", "pipe", "closed"]); expect(stdout.readableLength).toBe(0);
    } finally { input.close(); stdin.destroy(); stdout.destroy(); }
  });

  test("a dedicated event source borrows one Unix resource and queue owner", () => {
    const stdin = new PassThrough();
    const unix = new UnixIo(() => undefined, new UnixSystemClock(() => 1042), { stdin, signals: "none" });
    const source = new DedicatedEventSource(unix);
    try {
      expect(unix.udp).toBeNull(); expect(unix.consoleActive).toBe(false);
      expect(stdin.listenerCount("readable")).toBe(0); expect(stdin.listenerCount("end")).toBe(0);
      expect(source.getEvent()).toEqual({ kind: "none", time: 42 });
      unix.queueEvent({ kind: "console", time: 0, text: "status" });
      expect(source.getEvent()).toEqual({ kind: "console", time: 42, text: "status" });
      expect(source.getEvent()).toEqual({ kind: "none", time: 42 });
    } finally { unix.close(); stdin.destroy(); }
  });

  test("canonical scalar system events are copied into the one Unix queue", () => {
    let key = 13, down = true, character = 97, dx = -2, dy = 4, axis = 1, value = -127;
    const unix = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
    const source = new DedicatedEventSource(unix);
    try {
      unix.queueEvent({ kind: "key", time: 1, get key() { return key; }, get down() { return down; } });
      unix.queueEvent({ kind: "character", time: 2, get character() { return character; } });
      unix.queueEvent({ kind: "mouse", time: 3, get dx() { return dx; }, get dy() { return dy; } });
      unix.queueEvent({ kind: "joystick", time: 4, get axis() { return axis; }, get value() { return value; } });
      key = 27; down = false; character = 98; dx = 99; dy = 100; axis = 5; value = 127;
      const events = [source.getEvent(), source.getEvent(), source.getEvent(), source.getEvent()];
      expect(events).toEqual([
        { kind: "key", time: 1, key: 13, down: true },
        { kind: "character", time: 2, character: 97 },
        { kind: "mouse", time: 3, dx: -2, dy: 4 },
        { kind: "joystick", time: 4, axis: 1, value: -127 },
      ]);
      expect(events.every(event => Object.isFrozen(event))).toBe(true);
    } finally { unix.close(); }
  });

  test("independent Unix owners share no queue, clock or close state", () => {
    const first = new UnixIo(() => undefined, new UnixSystemClock(() => 1041), { signals: "none" });
    const second = new UnixIo(() => undefined, new UnixSystemClock(() => 2099), { signals: "none" });
    const firstSource = new DedicatedEventSource(first), secondSource = new DedicatedEventSource(second);
    try {
      first.queueEvent({ kind: "console", time: 0, text: "first" });
      expect(secondSource.getEvent()).toEqual({ kind: "none", time: 99 });
      expect(firstSource.getEvent()).toEqual({ kind: "console", time: 41, text: "first" });
      first.close();
      second.queueEvent({ kind: "console", time: 0, text: "second" });
      expect(secondSource.getEvent()).toEqual({ kind: "console", time: 99, text: "second" });
    } finally { first.close(); second.close(); }
  });

  test("Sys_QueEvent samples zero time after the overflow print advances the clock", () => {
    let wall = 1055;
    const clock = new UnixSystemClock(() => wall), printed: string[] = [];
    expect(clock.milliseconds()).toBe(55);
    const input = new UnixIo(text => { printed.push(text); wall += 1000; }, clock, { signals: "none" });
    try {
      for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "console", time: 1, text: String(index) });
      input.queueEvent({ kind: "console", time: 0, text: "after overflow" });
      expect(printed).toEqual(["Sys_QueEvent: overflow\n"]);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: 1, text: String(index) });
      expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: 1055, text: "after overflow" });
    } finally { input.close(); }
  });

  test("shared-zone Sys_QueEvent frees the overwritten pointer between print and zero-time sampling", () => {
    const zone = new ZoneArena(512), memory = new CommonEventMemory(() => zone), stdin = new PassThrough();
    const old = memory.console(1, "old"), replacement = memory.console(0, "new"), trace: string[] = [];
    const input = new UnixIo(() => { trace.push("print"); expect(old.text).toBe("old"); expect(zone.memoryRemaining()).toBe(456); },
      { milliseconds: () => { trace.push("clock"); expect(() => old.text).toThrow("no longer valid"); return 77; } },
      { stdin, signals: "none" }, memory);
    try {
      input.queueEvent(old);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "key", time: 1, key: index, down: true });
      input.queueEvent(replacement); expect(trace).toEqual(["print", "clock"]);
      expect(zone.memoryRemaining()).toBe(484);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) getDedicatedEvent(input);
      const received = getDedicatedEvent(input);
      expect(received).toEqual({ kind: "console", time: 77, text: "new" });
      expect(memory.payload(received)).toBe(memory.payload(replacement));
      memory.free(received); expect(zone.memoryRemaining()).toBe(512);
    } finally { input.close(); stdin.destroy(); zone.dispose(); }
  });

  test("shared-zone allocation pressure rejects a new payload before overflowing the Unix queue", () => {
    const zone = new ZoneArena(128), memory = new CommonEventMemory(() => zone), stdin = new PassThrough();
    let prints = 0, samples = 0;
    const input = new UnixIo(() => { prints++; }, { milliseconds: () => { samples++; return 1; } }, { stdin, signals: "none" }, memory);
    try {
      const first = memory.console(1, "old"); input.queueEvent(first);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "key", time: 1, key: index, down: true });
      expect(() => input.queueEvent({ kind: "console", time: 0, text: "x".repeat(128) })).toThrow("Z_Malloc: failed");
      expect(prints).toBe(0); expect(samples).toBe(0); expect(first.text).toBe("old");
      const received = getDedicatedEvent(input); expect(received).toEqual(first);
      memory.free(received); expect(zone.memoryRemaining()).toBe(128);
    } finally { input.close(); stdin.destroy(); zone.dispose(); }
  });

  test("zero time samples once without overflow; supplied nonzero overflow times do not sample", () => {
    let samples = 0; const printed: string[] = [];
    const input = new UnixIo(text => { printed.push(text); }, { milliseconds: () => { samples++; return 77; } }, { signals: "none" });
    try {
      input.queueEvent({ kind: "console", time: 0, text: "zero" });
      expect(samples).toBe(1); expect(printed).toEqual([]);
      expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: 77, text: "zero" });
      for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "console", time: 12, text: String(index) });
      input.queueEvent({ kind: "console", time: -123, text: "supplied" });
      expect(samples).toBe(1); expect(printed).toEqual(["Sys_QueEvent: overflow\n"]);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) expect(consoleText(getDedicatedEvent(input))).toBe(String(index));
      expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: -123, text: "supplied" });
    } finally { input.close(); }
  });

  for (const failure of [new CommonError("drop", "overflow print source abort"), new Error("overflow print failure")]) {
    test(`overflow print preserves ${failure.name} identity before sampling or changing the full queue`, () => {
      let samples = 0, prints = 0;
      const input = new UnixIo(() => { prints++; throw failure; }, { milliseconds: () => { samples++; return 88; } }, { signals: "none" });
      try {
        for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "console", time: 1, text: String(index) });
        let caught: unknown;
        try { input.queueEvent({ kind: "console", time: 0, text: "aborted" }); } catch (error) { caught = error; }
        expect(caught).toBe(failure); expect(prints).toBe(1); expect(samples).toBe(0);
        for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: 1, text: String(index) });
        expect(samples).toBe(0); expect(getDedicatedEvent(input)).toEqual({ kind: "none", time: 88 });
      } finally { input.close(); }
    });
  }

  test("overflow callbacks cannot mutate the already owned packet", () => {
    const host: [number, number, number, number] = [127, 0, 0, 1], payload = Uint8Array.of(4, 5), trace: string[] = [];
    const input = new UnixIo(() => { trace.push("print"); host[3] = 9; payload.fill(0); },
      { milliseconds: () => { trace.push("clock"); return 99; } }, { signals: "none" });
    try {
      for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "console", time: 1, text: String(index) });
      input.queueEvent({ kind: "packet", time: 0, from: { kind: "ipv4", host, port: 1234 }, payload });
      expect(trace).toEqual(["print", "clock"]);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) getDedicatedEvent(input);
      expect(getDedicatedEvent(input)).toEqual({ kind: "packet", time: 99, from: { kind: "ipv4", host: [127, 0, 0, 1], port: 1234 }, payload: Uint8Array.of(4, 5) });
    } finally { input.close(); }
  });

  test("invalid owned input is rejected before overflow effects or zero-time sampling", () => {
    let prints = 0, samples = 0;
    const input = new UnixIo(() => { prints++; }, { milliseconds: () => { samples++; return 1; } }, { signals: "none" });
    try {
      for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "console", time: 1, text: String(index) });
      expect(() => input.queueEvent({ kind: "console", time: 0, text: "\u0100" })).toThrow("source bytes");
      expect(() => input.queueEvent({ kind: "packet", time: 0, from: { kind: "ipv4", host: localhost, port: -1 }, payload: Uint8Array.of(1) })).toThrow("IPv4 sender");
      expect(prints).toBe(0); expect(samples).toBe(0);
      for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) expect(consoleText(getDedicatedEvent(input))).toBe(String(index));
    } finally { input.close(); }
  });

  test("managed throwing clock retains the prior overflow discard without fallback or append", () => {
    const failure = new Error("injected clock failure"), trace: string[] = [];
    let failed = false;
    const input = new UnixIo(() => { trace.push("print"); }, { milliseconds: () => {
      trace.push("clock"); if (!failed) { failed = true; throw failure; } return 44;
    } }, { signals: "none" });
    try {
      for (let index = 0; index < MAX_UNIX_SYSTEM_EVENTS; index++) input.queueEvent({ kind: "console", time: 1, text: String(index) });
      let caught: unknown;
      try { input.queueEvent({ kind: "console", time: 0, text: "not appended" }); } catch (error) { caught = error; }
      expect(caught).toBe(failure); expect(trace).toEqual(["print", "clock"]);
      for (let index = 1; index < MAX_UNIX_SYSTEM_EVENTS; index++) expect(consoleText(getDedicatedEvent(input))).toBe(String(index));
      expect(getDedicatedEvent(input)).toEqual({ kind: "none", time: 44 });
    } finally { input.close(); }
  });

  test("source mixed queue owns packet bytes, substitutes time0 and discards oldest on each overflow", () => {
    let now = 1033;
    const output: string[] = [], input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(() => now), { signals: "none" });
    const host: [number, number, number, number] = [127, 0, 0, 1], bytes = Uint8Array.of(1, 2);
    try {
      input.queueEvent({ kind: "packet", time: 0, from: { kind: "ipv4", host, port: 1234 }, payload: bytes });
      host[3] = 5; bytes.fill(0); now = 1066;
      expect(getDedicatedEvent(input)).toEqual({ kind: "packet", time: 33, from: { kind: "ipv4", host: localhost, port: 1234 }, payload: Uint8Array.of(1, 2) });
      for (let i = 0; i < MAX_UNIX_SYSTEM_EVENTS + 3; i++) input.queueEvent({ kind: "console", time: -12, text: String(i) });
      expect(output).toEqual(Array<string>(3).fill("Sys_QueEvent: overflow\n"));
      for (let i = 3; i < 259; i++) expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: -12, text: String(i) });
      expect(getDedicatedEvent(input)).toEqual({ kind: "none", time: 66 });
      expect(() => input.queueEvent({ kind: "console", time: 2147483648, text: "bad" })).toThrow("signed 32-bit");
      expect(() => input.queueEvent({ kind: "console", time: 1, text: "\u0100" })).toThrow("source bytes");
      expect(() => input.queueEvent({ kind: "packet", time: 1, from: { kind: "ipv4", host: localhost, port: -1 }, payload: bytes })).toThrow("IPv4 sender");
    } finally { input.close(); }
  });

  test("publication snapshots changing getters once before validating owned event values", () => {
    const input = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
    let payloadReads = 0, timeReads = 0, portReads = 0, fromReads = 0, kindReads = 0;
    const from: Ipv4Address = { kind: "ipv4", host: localhost, get port() { portReads++; return portReads === 1 ? 1234 : 65536; } };
    try {
      input.queueEvent({
        get kind(): "packet" { kindReads++; return "packet"; },
        get time() { timeReads++; return timeReads; },
        get from() { fromReads++; return from; },
        get payload() { payloadReads++; return new Uint8Array(payloadReads === 1 ? 1 : MAX_DATAGRAM_LENGTH + 1); },
      });
      expect(getDedicatedEvent(input)).toEqual({ kind: "packet", time: 1, from: { kind: "ipv4", host: localhost, port: 1234 }, payload: Uint8Array.of(0) });
      expect([payloadReads, timeReads, portReads, fromReads, kindReads]).toEqual([1, 1, 1, 1, 1]);
      const oversized = new Uint8Array(MAX_DATAGRAM_LENGTH + 1);
      Object.defineProperty(oversized, "byteLength", { get: () => 1 });
      expect(() => input.queueEvent({ kind: "packet", time: 1, from: { kind: "ipv4", host: localhost, port: 1234 }, payload: oversized })).toThrow("receive limit");
      expect(getDedicatedEvent(input).kind).toBe("none");
    } finally { input.close(); }
  });

  test("cooked Latin-1 input frames split CRLF, lone CR/LF and NUL without executing an excess suffix", async () => {
    const stdin = new PassThrough(), output: string[] = [];
    const input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(() => 1042), { stdin, signals: "none" });
    const cvars = new CvarRegistry();
    input.initializeConsole(cvars);
    try {
      expect(input.consoleProfile).toBe("line-latin1"); expect(cvars.get("ttycon")?.value).toBe("0");
      stdin.write(Buffer.from([115, 116, 97])); expect(getDedicatedEvent(input).kind).toBe("none");
      stdin.write(Buffer.from("tus\r", "latin1")); expect(consoleText(getDedicatedEvent(input))).toBe("status");
      stdin.write(Buffer.from("\n\xff\nfirst\0discard;quit\rnext\n\n", "latin1"));
      expect(consoleText(getDedicatedEvent(input))).toBe("\xff");
      expect(consoleText(getDedicatedEvent(input))).toBe("first"); expect(consoleText(getDedicatedEvent(input))).toBe("next");
      expect(consoleText(getDedicatedEvent(input))).toBe(""); expect(getDedicatedEvent(input).kind).toBe("none");
      stdin.write("x".repeat(MAX_UNIX_CONSOLE_LINE) + ";quit\nstatus\n");
      expect(consoleText(getDedicatedEvent(input))).toBe("x".repeat(1023)); expect(consoleText(getDedicatedEvent(input))).toBe("status");
      expect(output).toEqual(["stdin is not a tty, tty console mode failed\n", "Console line exceeds 1023 bytes; excess bytes discarded\n"]);
      const ended = waitEnd(stdin); stdin.end("tail");
      expect(getDedicatedEvent(input).kind).toBe("none"); await ended;
      expect(input.consoleActive).toBe(false); expect(consoleText(getDedicatedEvent(input))).toBe("tail");
      expect(getDedicatedEvent(input).kind).toBe("none"); expect(getDedicatedEvent(input).kind).toBe("none");
    } finally { input.close(); stdin.destroy(); }
  });

  test("polls one console before one actual UDP result and drains queued packets before another console", async () => {
    const stdin = new PassThrough(), input = new UnixIo(() => undefined, new UnixSystemClock(() => 1055), { stdin, signals: "none" });
    const cvars = cvarsForNetwork(); await input.initializeNetwork(cvars); input.initializeConsole(cvars);
    const sender = await UdpTransport.bind({ host: localhost, port: 0 }), udp = requireUdp(input);
    try {
      expect(cvars.get("net_port")?.integerValue).toBe(udp.address.port);
      const ready = waitReadable(udp); sender.send(udp.address, Uint8Array.of(9)); await ready;
      stdin.write("status\nmap q3dm1\n");
      input.queueEvent({ kind: "console", time: 7, text: "already queued" });
      expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: 7, text: "already queued" });
      expect(udp.statistics.pending).toBe(1); expect(stdin.readableLength).toBeGreaterThan(0);
      expect(getDedicatedEvent(input)).toEqual({ kind: "console", time: 55, text: "status" });
      expect(udp.statistics.pending).toBe(0);
      expect(getDedicatedEvent(input)).toEqual({ kind: "packet", time: 55, from: sender.address, payload: Uint8Array.of(9) });
      expect(consoleText(getDedicatedEvent(input))).toBe("map q3dm1");
      expect(getDedicatedEvent(input)).toEqual({ kind: "none", time: 55 });
    } finally { sender.close(); input.close(); stdin.destroy(); }
  });

  test("readiness sleep wakes on partial stdin, pending input, UDP and close without dispatching", async () => {
    const stdin = new PassThrough(), input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
    const cvars = cvarsForNetwork(); await input.initializeNetwork(cvars); input.initializeConsole(cvars);
    const udp = requireUdp(input), sender = await UdpTransport.bind({ host: localhost, port: 0 });
    try {
      const first = input.sleepUntilInput(60000);
      await expect(input.sleepUntilInput(60000)).rejects.toThrow("pending sleep");
      stdin.write("sta"); await first; expect(getDedicatedEvent(input).kind).toBe("none");
      const second = input.sleepUntilInput(60000); stdin.write("tus\n"); await second;
      await input.sleepUntilInput(60000); expect(consoleText(getDedicatedEvent(input))).toBe("status");
      const packetWait = input.sleepUntilInput(60000); sender.send(udp.address, Uint8Array.of(7)); await packetWait;
      expect(udp.statistics.pending).toBe(1); expect(getDedicatedEvent(input).kind).toBe("packet");
      input.queueEvent({ kind: "console", time: 1, text: "queued" }); await input.sleepUntilInput(60000);
      expect(consoleText(getDedicatedEvent(input))).toBe("queued");
      await input.sleepUntilInput(1);
      const closedWait = input.sleepUntilInput(60000); input.close(); await closedWait;
      expect(input.udp).toBeNull(); expect(udp.statistics.pending).toBe(0);
      expect(() => getDedicatedEvent(input)).toThrow("closed"); await expect(input.sleepUntilInput(1)).rejects.toThrow("closed");
    } finally { input.close(); sender.close(); stdin.destroy(); }
  });

  test("EOF wakes a pending sleep and a binary input error is surfaced at poll, not inside its callback", async () => {
    const stdin = new PassThrough(), input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
    const cvars = cvarsForNetwork(); await input.initializeNetwork(cvars); input.initializeConsole(cvars);
    try {
      const ended = waitEnd(stdin);
      const waiting = input.sleepUntilInput(60000); stdin.end(); getDedicatedEvent(input); await ended; await waiting;
      expect(input.consoleActive).toBe(false); expect(getDedicatedEvent(input).kind).toBe("none");
      const failure = new Error("stdin failure"); const errorWait = input.sleepUntilInput(60000);
      expect(() => stdin.emit("error", failure)).not.toThrow(); await errorWait;
      let caught: unknown;
      try { getDedicatedEvent(input); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
    } finally { input.close(); stdin.destroy(); }
  });

  test("failed wait registration or readiness recheck releases subscriptions and the wait owner", async () => {
    const stdin = new PassThrough(), input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
    const cvars = cvarsForNetwork(); await input.initializeNetwork(cvars); input.initializeConsole(cvars);
    const udp = requireUdp(input), subscribe = udp.subscribeReadable.bind(udp);
    try {
      const registrationFailure = new Error("subscription failed");
      udp.subscribeReadable = () => { throw registrationFailure; };
      await expect(input.sleepUntilInput(60000)).rejects.toThrow("subscription failed");
      udp.subscribeReadable = subscribe;
      await input.sleepUntilInput(1);
      let active = 0;
      udp.subscribeReadable = listener => {
        const unsubscribe = subscribe(listener); active++;
        return () => { active--; unsubscribe(); };
      };
      Object.defineProperty(stdin, "readableLength", { configurable: true, get: () => { throw new Error("readiness failed"); } });
      await expect(input.sleepUntilInput(60000)).rejects.toThrow("readiness failed");
      expect(active).toBe(0); Reflect.deleteProperty(stdin, "readableLength");
      await input.sleepUntilInput(1); expect(active).toBe(0);
      udp.subscribeReadable = listener => {
        const unsubscribe = subscribe(listener); active++;
        input.queueEvent({ kind: "console", time: 1, text: "during registration" });
        return () => { active--; unsubscribe(); };
      };
      await input.sleepUntilInput(60000); expect(active).toBe(0);
      expect(consoleText(getDedicatedEvent(input))).toBe("during registration");
    } finally {
      Reflect.deleteProperty(stdin, "readableLength"); udp.subscribeReadable = subscribe;
      input.close(); stdin.destroy();
    }
  });

  test("cleanup continues through an owned stdin release error and remains idempotently closed", async () => {
    const stdin = new PassThrough(), input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
    const cvars = cvarsForNetwork();
    await input.initializeNetwork(cvars); input.initializeConsole(cvars);
    const udp = requireUdp(input), address = udp.address, pause = stdin.pause.bind(stdin);
    try {
      const waiting = input.sleepUntilInput(60000);
      stdin.pause = () => { throw new Error("stdin pause failed"); };
      expect(() => input.close()).toThrow(); await waiting;
      expect(() => udp.poll()).toThrow("closed");
      expect(stdin.listenerCount("readable")).toBe(0); expect(() => input.close()).not.toThrow();
      const rebound = await UdpTransport.bind({ host: address.host, port: address.port }); rebound.close();
    } finally {
      stdin.pause = pause; udp.close(); input.close(); stdin.destroy();
    }
  });

  test("network initialization is explicit, retries occupied localhost ports and releases its actual socket", async () => {
    const occupied = await UdpTransport.bind({ host: localhost, port: 0 });
    const output: string[] = [], input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(), { signals: "none" });
    const cvars = cvarsForNetwork(occupied.address.port);
    try {
      expect(input.udp).toBeNull(); expect(input.lan.isLanAddress({ kind: "ipv4", host: localhost })).toBe(false);
      await input.initializeNetwork(cvars); const udp = requireUdp(input);
      expect(udp.address.port).toBeGreaterThan(occupied.address.port); expect(output[0]).toContain(`:${occupied.address.port}`);
      expect(cvars.get("net_port")?.integerValue).toBe(udp.address.port);
      expect(input.lan.isLanAddress({ kind: "ipv4", host: localhost })).toBe(true);
      await expect(input.initializeNetwork(cvars)).rejects.toThrow("already initialized");
      const address = udp.address; input.close(); input.close();
      const replacement = await UdpTransport.bind({ host: address.host, port: address.port }); replacement.close();
    } finally { occupied.close(); input.close(); }
  });

  test("noUDP does not create IP cvars or LAN state and native PORT_ANY retains -1", async () => {
    const noUdp = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" }), cvars = new CvarRegistry();
    cvars.set("net_noudp", "1");
    const ephemeral = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" }), ports = cvarsForNetwork(-1);
    try {
      await noUdp.initializeNetwork(cvars); expect(noUdp.udp).toBeNull(); expect(cvars.get("net_ip")).toBeUndefined();
      expect(cvars.get("net_port")).toBeUndefined(); expect(noUdp.lan.isLanAddress({ kind: "ipv4", host: localhost })).toBe(false);
      await noUdp.sleepUntilInput(60000);
      await ephemeral.initializeNetwork(ports); expect(requireUdp(ephemeral).address.port).toBeGreaterThan(0);
      expect(ports.get("net_port")?.value).toBe("-1");
    } finally { noUdp.close(); ephemeral.close(); }
  });

  test("exhausts exactly ten occupied source ports, cleans failure and can initialize afterward", async () => {
    const occupied = await occupyTenPorts(), first = occupied[0];
    if (first === undefined) throw new Error("Missing occupied port fixture");
    const output: string[] = [], input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(), { signals: "none" });
    const cvars = cvarsForNetwork(first.address.port);
    try {
      await expect(input.initializeNetwork(cvars)).rejects.toThrow("Couldn't allocate IP port");
      expect(output.filter(text => text.startsWith("Opening IP socket:"))).toHaveLength(10);
      expect(input.udp).toBeNull(); expect(cvars.get("net_port")?.integerValue).toBe(first.address.port);
      for (const socket of occupied) socket.close();
      await input.initializeNetwork(cvars); expect(requireUdp(input).address.port).toBe(first.address.port);
    } finally { input.close(); for (const socket of occupied) socket.close(); }
  });

  test("native float-to-int port then short conversion retains wrapped cvar values", async () => {
    for (const value of [65536, -65536]) {
      const input = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" }), cvars = cvarsForNetwork(value);
      try {
        await input.initializeNetwork(cvars); expect(requireUdp(input).address.port).toBeGreaterThan(0);
        expect(cvars.get("net_port")?.integerValue).toBe(value);
      } finally { input.close(); }
    }
    for (const value of [2147483648, -2147483904]) {
      const input = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
      try { await expect(input.initializeNetwork(cvarsForNetwork(value))).rejects.toThrow("signed-int conversion"); }
      finally { input.close(); }
    }
  });

  test("localhost bind means INADDR_ANY while explicit resolution means actual IPv4 localhost", async () => {
    const input = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" }), cvars = new CvarRegistry();
    cvars.set("net_port", "0");
    try {
      await input.initializeNetwork(cvars); expect(requireUdp(input).address.host).toEqual([0, 0, 0, 0]);
      expect(await input.resolveAddress("localhost", 27960)).toEqual({ kind: "ipv4", host: localhost, port: 27960 });
      expect(await input.resolveAddress("127.0.0.1", 1)).toEqual({ kind: "ipv4", host: localhost, port: 1 });
      expect(await input.resolveAddress("999.0.0.1", 1)).toEqual({ kind: "ipv4", host: [255, 255, 255, 255], port: 1 });
      await expect(input.resolveAddress("localhost", 0)).rejects.toThrow("port");
    } finally { input.close(); }
  });

  test("closing during asynchronous bind cannot publish a late socket or LAN state", async () => {
    const input = new UnixIo(() => undefined, new UnixSystemClock(), { signals: "none" });
    const initialization = input.initializeNetwork(cvarsForNetwork());
    input.close(); await expect(initialization).rejects.toThrow("closed");
    expect(input.udp).toBeNull(); expect(input.lan.isLanAddress({ kind: "ipv4", host: localhost })).toBe(false);
  });

  test("a real connection-refused receive wakes the owner but is not a packet or native error diagnostic", async () => {
    const output: string[] = [], input = new UnixIo(text => { output.push(text); }, new UnixSystemClock(), { signals: "none" });
    await input.initializeNetwork(cvarsForNetwork());
    const peer = await UdpTransport.bind({ host: localhost, port: 0 }), destination = peer.address;
    peer.close();
    try {
      const udp = requireUdp(input), awake = input.sleepUntilInput(60000);
      udp.send(destination, Uint8Array.of(1)); await awake;
      expect(udp.statistics.errors).toBe(1); expect(getDedicatedEvent(input).kind).toBe("none");
      expect(output.filter(text => text.startsWith("NET_GetPacket"))).toEqual([]);
    } finally { input.close(); peer.close(); }
  });

  test("console ownership rejects incompatible readers and removes only its own listeners", () => {
    const stdin = new PassThrough(), input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
    let reads = 0; const borrowedListener = (): undefined => { reads++; };
    stdin.on("readable", borrowedListener);
    const cvars = new CvarRegistry(); input.initializeConsole(cvars);
    expect(stdin.listenerCount("readable")).toBe(2);
    expect(() => input.initializeConsole(cvars)).toThrow("already initialized");
    input.close(); expect(stdin.listenerCount("readable")).toBe(1); stdin.emit("readable"); expect(reads).toBe(1);
    expect(stdin.listenerCount("error")).toBe(0); expect(stdin.listenerCount("end")).toBe(0); stdin.destroy();
    for (const invalid of [new PassThrough({ objectMode: true }), new PassThrough({ encoding: "utf8" })]) {
      const rejected = new UnixIo(() => undefined, new UnixSystemClock(), { stdin: invalid, signals: "none" });
      expect(() => rejected.initializeConsole(cvars)).toThrow("binary Readable"); rejected.close(); invalid.destroy();
    }
  });

  test("a late ttycon1 request rejects a non-TTY startup without consuming buffered commands", () => {
    const stdin = new PassThrough(), cvars = new CvarRegistry();
    const input = new UnixIo(() => undefined, new UnixSystemClock(), { stdin, signals: "none" });
    input.initializeConsole(cvars);
    try {
      stdin.write("status\n"); cvars.set("ttycon", "1");
      expect(() => getDedicatedEvent(input)).toThrow("after non-TTY console initialization");
      cvars.set("ttycon", "0"); expect(consoleText(getDedicatedEvent(input))).toBe("status");
    } finally { input.close(); stdin.destroy(); }
  });

  test("real piped stdin preserves Latin-1 and EOF remains alive until actual localhost UDP input", async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--dedicated-input-child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines = new ChildLines(child.stdout), peer = await UdpTransport.bind({ host: localhost, port: 0 });
    try {
      const ready = await lines.next(); expect(ready.startsWith("ready ")).toBe(true);
      const port = Number(ready.slice(6)), destination: Ipv4Address = { kind: "ipv4", host: localhost, port };
      child.stdin.write(Buffer.from("status\r\n\xff\nlast", "latin1")); child.stdin.end();
      expect(await lines.next()).toBe("console 737461747573"); expect(await lines.next()).toBe("console ff");
      expect(await lines.next()).toBe("console 6c617374"); expect(await lines.next()).toBe("eof active=false");
      expect(child.exitCode).toBeNull(); peer.send(destination, Uint8Array.of(1));
      expect(await lines.next()).toBe("packet 1"); expect(await lines.next()).toBe("closed");
      expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
      const rebound = await UdpTransport.bind({ host: localhost, port }); rebound.close();
    } finally { peer.close(); if (child.exitCode === null) child.kill(); await child.exited; }
  });

  test("real process SIGTERM exits directly without queuing quit or normal cleanup", async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--dedicated-input-child"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines = new ChildLines(child.stdout);
    try {
      expect((await lines.next()).startsWith("ready ")).toBe(true);
      child.kill("SIGTERM"); expect(await lines.next()).toBe("Received signal 15, exiting...");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  });

  test("redirected non-socket process stdin has no ref methods and EOF still permits UDP wake", async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--dedicated-input-child"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const lines = new ChildLines(child.stdout), peer = await UdpTransport.bind({ host: localhost, port: 0 });
    try {
      const ready = await lines.next(); expect(ready.startsWith("ready ")).toBe(true);
      expect(await lines.next()).toBe("eof active=false");
      peer.send({ kind: "ipv4", host: localhost, port: Number(ready.slice(6)) }, Uint8Array.of(1));
      expect(await lines.next()).toBe("packet 1"); expect(await lines.next()).toBe("closed");
      expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
    } finally { peer.close(); if (child.exitCode === null) child.kill(); await child.exited; }
  });
});
