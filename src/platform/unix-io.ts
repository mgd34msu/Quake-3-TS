// Unix Sys_QueEvent, console, network, signals and readiness resources.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
// Bun supplies buffered nonblocking input. The non-TTY path retains its explicit
// Latin-1 line profile instead of native last-read-byte truncation.
import { dlopen } from "bun:ffi";
import { lookup } from "node:dns/promises";
import { writeSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { ReadStream } from "node:tty";
import { CvarFlag, CvarRegistry } from "../core/cvar.ts";
import type { EditField } from "../core/edit-field.ts";
import { sourceCommandText } from "../core/text.ts";
import type { CommonSystemEvent } from "../engine/common-events.ts";
import type { CommonEventMemory } from "../engine/event-memory.ts";
import { LanAddresses } from "./lan.ts";
import { MAX_DATAGRAM_LENGTH, UdpReceiveInvariantError, UdpTransport } from "./network.ts";
import type { Ipv4Address, Ipv4Host } from "./network.ts";
import type { SystemClock } from "./system-clock.ts";
import { TtyConsole } from "./tty-console.ts";

export const MAX_UNIX_SYSTEM_EVENTS = 256;
export const MAX_UNIX_CONSOLE_LINE = 1023;
export type UnixQueuedSystemEvent = Exclude<CommonSystemEvent, { readonly kind: "none" }>;
export type UnixNoneSystemEvent = Extract<CommonSystemEvent, { readonly kind: "none" }>;

export type UnixSignalName = "SIGHUP" | "SIGQUIT" | "SIGILL" | "SIGTRAP" | "SIGIOT" | "SIGBUS" | "SIGFPE" | "SIGSEGV" | "SIGTERM";
export interface UnixSignalRuntime {
  install(signal: UnixSignalName, handler: () => undefined): undefined;
  remove(signal: UnixSignalName, handler: () => undefined): undefined;
  write(text: string): undefined;
  exit(status: 0 | 1): never;
}

export interface UnixIoOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly signals?: "process" | "none" | UnixSignalRuntime;
}

type NetworkState = { readonly kind: "uninitialized" | "initializing" }
  | { readonly kind: "ready"; readonly udp: UdpTransport | null; readonly lan: LanAddresses }
  | { readonly kind: "closed" };
type ConsoleState = { readonly kind: "uninitialized" | "closed" }
  | { readonly kind: "initialized"; readonly cvars: CvarRegistry; mode: ConsoleMode;
      ended: boolean; error: Error | null; eofConsumed: boolean };
type ConsoleMode = { readonly kind: "line" }
  | { readonly kind: "tty"; readonly editor: TtyConsole; readonly terminal: TtyTermios };
interface TtyTermios {
  readonly erase: number;
  readonly active: boolean;
  activate(): void;
  close(): void;
}

const terminalOwners = new Set<number>();
let jobControlSignals: { users: number; readonly restore: () => undefined } | null = null;
let processSignalOwner: UnixIo | null = null;
const unixSignals: readonly { readonly name: UnixSignalName; readonly number: number }[] = [
  { name: "SIGHUP", number: 1 }, { name: "SIGQUIT", number: 3 }, { name: "SIGILL", number: 4 },
  { name: "SIGTRAP", number: 5 }, { name: "SIGIOT", number: 6 }, { name: "SIGBUS", number: 7 },
  { name: "SIGFPE", number: 8 }, { name: "SIGSEGV", number: 11 }, { name: "SIGTERM", number: 15 },
];

function acquireJobControlSignals(): () => undefined {
  let shared = jobControlSignals;
  if (shared === null) {
    if (process.platform !== "linux" || process.arch !== "x64") {
      throw new Error("Unix job-control signal setup requires Linux x64 glibc");
    }
    const library = dlopen("libc.so.6", {
      sigaction: { args: ["i32", "buffer", "buffer"], returns: "i32" },
    });
    // Linux x64 glibc bits/{sigaction,types/__sigset_t,signum-*}.h:
    // handler at 0, 128-byte mask at 8, flags at 136, restorer at 144.
    // SIG_IGN is the handler word 1, not a callback that catches the signal.
    const ignored = new Uint8Array(152);
    new DataView(ignored.buffer).setBigUint64(0, 1n, true);
    const saved: { readonly signal: number; readonly action: Uint8Array }[] = [];
    const restore = (): undefined => {
      const errors: unknown[] = [];
      for (let entry = saved.pop(); entry !== undefined; entry = saved.pop()) {
        try {
          if (library.symbols.sigaction(entry.signal, entry.action, new Uint8Array(152)) !== 0) {
            throw new Error(`Failed to restore Unix signal ${entry.signal}`);
          }
        } catch (error) { errors.push(error); }
      }
      try { library.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Unix job-control signal cleanup failed", { cause: errors[0] });
    };
    try {
      // Sys_ConsoleInputInit installs these before looking up ttycon.
      for (const signal of [21, 22]) {
        const action = new Uint8Array(152);
        if (library.symbols.sigaction(signal, ignored, action) !== 0) throw new Error(`Failed to ignore Unix signal ${signal}`);
        saved.push({ signal, action });
      }
    } catch (error) {
      try { restore(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Unix job-control signal initialization failed", { cause: error }); }
      throw error;
    }
    shared = { users: 0, restore };
    jobControlSignals = shared;
  }
  shared.users++;
  const owner = shared;
  let released = false;
  return (): undefined => {
    if (released) return;
    released = true;
    if (--owner.users !== 0) return;
    jobControlSignals = null;
    owner.restore();
  };
}

function prepareTtyTermios(input: ReadStream): TtyTermios {
  // Linux x64 glibc bits/termios{,-struct,-c_cc,-c_iflag,-c_lflag}.h.
  // Keep ISIG, ICRNL and the real signal/erase control bytes. Bun setRawMode
  // also clears ISIG and cannot implement this source terminal configuration.
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Source TTY termios currently requires Linux x64 glibc; use +set ttycon 0");
  }
  const descriptor: unknown = "fd" in input ? input.fd : undefined;
  if (typeof descriptor !== "number" || !Number.isInteger(descriptor) || descriptor < 0 || descriptor > 2147483647) {
    throw new Error("TTY input has no valid Unix descriptor");
  }
  if (terminalOwners.has(descriptor)) throw new Error("TTY input already has a console owner");
  const library = dlopen("libc.so.6", {
    tcgetattr: { args: ["i32", "buffer"], returns: "i32" },
    tcsetattr: { args: ["i32", "i32", "buffer"], returns: "i32" },
  });
  const saved = new Uint8Array(60);
  try {
    if (library.symbols.tcgetattr(descriptor, saved) !== 0) throw new Error("TTY tcgetattr failed");
  } catch (error) { library.close(); throw error; }
  const changed = new Uint8Array(saved), settings = new DataView(changed.buffer);
  settings.setUint32(12, settings.getUint32(12, true) & ~0x0a, true);
  settings.setUint32(0, settings.getUint32(0, true) & ~0x30, true);
  settings.setUint8(17 + 6, 1); settings.setUint8(17 + 5, 0);
  terminalOwners.add(descriptor);
  let active = false, restore = false, closed = false;
  return {
    erase: settings.getUint8(17 + 2),
    get active() { return active; },
    activate: (): void => {
      if (closed || restore) throw new Error("TTY terminal settings have already been applied or closed");
      restore = true;
      if (library.symbols.tcsetattr(descriptor, 1, changed) !== 0) throw new Error("TTY tcsetattr failed");
      active = true;
    },
    close: (): void => {
      if (closed) return;
      closed = true; active = false; terminalOwners.delete(descriptor);
      try {
        if (restore && library.symbols.tcsetattr(descriptor, 1, saved) !== 0) throw new Error("TTY termios restoration failed");
      } finally { library.close(); }
    },
  };
}

function parseHost(text: string): Ipv4Host | null {
  const parts = text.split("."), [a, b, c, d] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined
    || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return Object.freeze([Number(a), Number(b), Number(c), Number(d)] satisfies Ipv4Host);
}

/** unix_net.c preserves inet_addr's broadcast result for malformed numeric text. */
function numericHost(text: string): Ipv4Host {
  // The selected glibc inet_addr accepts 1..4 C-integer components and ignores
  // everything after the first ASCII whitespace. The final component fills the
  // remaining address bytes. See glibc resolv/inet_addr.c inet_aton_end.
  const end = text.search(/[ \t\n\r\v\f]/);
  const parts = (end < 0 ? text : text.slice(0, end)).split(".");
  let address = 0;
  if (parts.length > 4) return Object.freeze([255, 255, 255, 255] satisfies Ipv4Host);
  for (const [index, part] of parts.entries()) {
    const radix = /^0[xX][0-9a-fA-F]+$/.test(part) ? 16 : /^0[0-7]*$/.test(part) ? 8 : /^[1-9][0-9]*$/.test(part) ? 10 : 0;
    const value = radix === 0 ? NaN : Number.parseInt(part, radix);
    const maximum = index === parts.length - 1 ? 2 ** (8 * (5 - parts.length)) - 1 : 255;
    if (!Number.isFinite(value) || value > maximum) return Object.freeze([255, 255, 255, 255] satisfies Ipv4Host);
    address += value * (index === parts.length - 1 ? 1 : 2 ** (24 - index * 8));
  }
  return Object.freeze([address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255] satisfies Ipv4Host);
}

function ownedAddress(address: Ipv4Address): Ipv4Address {
  const { host: source, port } = address;
  const length = source.length, a = source[0], b = source[1], c = source[2], d = source[3];
  const host: Ipv4Host = [a, b, c, d];
  if (length !== 4 || host.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)
    || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("Dedicated packet requires a valid IPv4 sender");
  }
  return Object.freeze({ kind: "ipv4", host: Object.freeze(host), port });
}

function ignoredReceiveError(error: Error): boolean {
  return "code" in error && (error.code === "EWOULDBLOCK" || error.code === "EAGAIN" || error.code === "ECONNREFUSED");
}

function eventWithTime(event: UnixQueuedSystemEvent, time: number): UnixQueuedSystemEvent {
  switch (event.kind) {
    case "key": return Object.freeze({ kind: "key", time, key: event.key, down: event.down });
    case "character": return Object.freeze({ kind: "character", time, character: event.character });
    case "mouse": return Object.freeze({ kind: "mouse", time, dx: event.dx, dy: event.dy });
    case "joystick": return Object.freeze({ kind: "joystick", time, axis: event.axis, value: event.value });
    case "console": return Object.freeze({ kind: "console", time, text: event.text });
    case "packet": return Object.freeze({ kind: "packet", time, from: event.from, payload: event.payload });
  }
}

/** One Unix system-event and resource owner. No callback executes engine work. */
export class UnixIo {
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly signals: "process" | "none" | UnixSignalRuntime;
  private readonly emptyLan = new LanAddresses([]);
  private network: NetworkState = { kind: "uninitialized" };
  private initializingUdp: UdpTransport | null = null;
  private console: ConsoleState = { kind: "uninitialized" };
  private events: UnixQueuedSystemEvent[] = [];
  private line = "";
  private lineBytes = 0;
  private lineNul = false;
  private truncated = false;
  private afterCr = false;
  private signalCaught = false;
  private shutdownSignalGraphics: (() => undefined) | null = null;
  private releaseSignals: (() => undefined) | null = null;
  private sleeper: (() => undefined) | null = null;
  private releaseStdinReference: (() => undefined) | null = null;
  private releaseJobControlSignals: (() => undefined) | null = null;
  private completeConsoleField: ((field: EditField) => undefined) | null = null;

  constructor(private readonly print: (text: string) => undefined, private readonly clock: SystemClock, options: UnixIoOptions = {},
    private readonly eventMemory?: CommonEventMemory) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.signals = options.signals ?? "process";
  }

  get udp(): UdpTransport | null { return this.network.kind === "ready" ? this.network.udp : null; }
  get lan(): LanAddresses { return this.network.kind === "ready" ? this.network.lan : this.emptyLan; }
  get consoleActive(): boolean { return this.console.kind === "initialized" && !this.console.ended; }
  get consoleProfile(): "line-latin1" | "tty-linux-glibc" {
    return this.console.kind === "initialized" && this.console.mode.kind === "tty" && this.console.mode.terminal.active
      ? "tty-linux-glibc" : "line-latin1";
  }

  /** linux_signals.c InitSig, reached by GLimp_Init or dedicated main. */
  initializeSignals(shutdownGraphics: (() => undefined) | null): void {
    this.requireOpen();
    this.shutdownSignalGraphics = shutdownGraphics;
    if (this.signals === "none" || this.releaseSignals !== null) return;
    let runtime: UnixSignalRuntime;
    let closeLibrary: (() => void) | null = null;
    if (this.signals === "process") {
      if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Unix signal handling requires Linux x64 glibc");
      if (processSignalOwner !== null) throw new Error("Unix process signals already have an owner");
      const library = dlopen("libc.so.6", { _exit: { args: ["i32"], returns: "void" } });
      closeLibrary = () => library.close();
      // Bun dispatches these on its JavaScript event loop. This does not recover
      // synchronous CPU faults or interrupt blocked JavaScript like C handlers.
      runtime = {
        // Linux SIGIOT and SIGABRT are both 6; Bun recognizes the SIGABRT name.
        install: (signal, handler) => { process.on(signal === "SIGIOT" ? "SIGABRT" : signal, handler); },
        remove: (signal, handler) => { process.removeListener(signal === "SIGIOT" ? "SIGABRT" : signal, handler); },
        write: text => { writeSync(1, text); },
        exit: status => { library.symbols._exit(status); throw new Error("Unix _exit returned"); },
      };
      processSignalOwner = this;
    } else runtime = this.signals;
    const installed: { readonly name: UnixSignalName; readonly handler: () => undefined }[] = [];
    const release = (): undefined => {
      const errors: unknown[] = [];
      for (const { name, handler } of installed.splice(0)) {
        try { runtime.remove(name, handler); } catch (error) { errors.push(error); }
      }
      if (processSignalOwner === this) processSignalOwner = null;
      try { closeLibrary?.(); } catch (error) { errors.push(error); }
      if (errors.length !== 0) throw new AggregateError(errors, "Unix signal cleanup failed", { cause: errors[0] });
    };
    try {
      for (const { name, number } of unixSignals) {
        const handler = (): undefined => {
          if (this.signalCaught) {
            runtime.write(`DOUBLE SIGNAL FAULT: Received signal ${number}, exiting...\n`);
            this.shutdownConsoleInput();
            runtime.exit(1);
          }
          this.signalCaught = true;
          runtime.write(`Received signal ${number}, exiting...\n`);
          this.shutdownSignalGraphics?.();
          this.shutdownConsoleInput();
          runtime.exit(0);
        };
        runtime.install(name, handler);
        installed.push({ name, handler });
      }
      this.releaseSignals = release;
    } catch (error) {
      try { release(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Unix signal initialization failed", { cause: error }); }
      throw error;
    }
  }

  private shutdownConsoleInput(): void {
    const state = this.console;
    if (state.kind !== "initialized" || state.mode.kind !== "tty" || !state.mode.terminal.active) return;
    this.withConsoleOutput(() => { this.print("Shutdown tty console\n"); });
    state.mode.terminal.close();
  }

  bindConsoleCompletion(complete: (field: EditField) => undefined): void {
    this.requireOpen();
    if (this.console.kind !== "uninitialized" || this.completeConsoleField !== null) {
      throw new Error("TTY field completion must bind once before console initialization");
    }
    this.completeConsoleField = complete;
  }

  /** Sys_Print/Sys_Warn surround only the actual platform sink, never the log. */
  withConsoleOutput(write: () => undefined): undefined {
    const state = this.console;
    const editor = state.kind === "initialized" && state.mode.kind === "tty" && state.mode.terminal.active ? state.mode.editor : null;
    editor?.hide();
    write();
    if (this.console === state && state.kind === "initialized" && state.mode.kind === "tty" && state.mode.terminal.active) editor?.show();
  }

  private requireOpen(): void { if (this.network.kind === "closed") throw new Error("Dedicated input is closed"); }
  private isClosed(): boolean { return this.network.kind === "closed"; }

  /** Sys_QueEvent: own inputs, then overflow effects, then zero-time sampling. */
  queueEvent(event: UnixQueuedSystemEvent): void {
    this.requireOpen();
    const { kind, time: suppliedTime } = event;
    if (!Number.isInteger(suppliedTime) || suppliedTime < -2147483648 || suppliedTime > 2147483647) {
      throw new RangeError("System event time requires a signed 32-bit integer");
    }
    let owned: UnixQueuedSystemEvent;
    const retainedPayload = this.eventMemory?.payload(event);
    if (this.eventMemory !== undefined && retainedPayload !== undefined && retainedPayload !== null) {
      owned = this.eventMemory.copy(event, suppliedTime);
    } else switch (kind) {
      case "key": {
        const { key, down } = event;
        owned = Object.freeze({ kind: "key", time: suppliedTime, key, down });
        break;
      }
      case "character": {
        const { character } = event;
        owned = Object.freeze({ kind: "character", time: suppliedTime, character });
        break;
      }
      case "mouse": {
        const { dx, dy } = event;
        owned = Object.freeze({ kind: "mouse", time: suppliedTime, dx, dy });
        break;
      }
      case "joystick": {
        const { axis, value } = event;
        owned = Object.freeze({ kind: "joystick", time: suppliedTime, axis, value });
        break;
      }
      case "console": {
        const { text } = event;
        const copied = sourceCommandText(text);
        owned = this.eventMemory?.console(suppliedTime, copied) ?? Object.freeze({ kind: "console", time: suppliedTime, text: copied });
        break;
      }
      case "packet": {
        const { from, payload } = event;
        const sourceLength = payload.byteLength;
        if (sourceLength > MAX_DATAGRAM_LENGTH) throw new RangeError("Dedicated packet exceeds the source receive limit");
        const sender = ownedAddress(from), bytes = new Uint8Array(payload);
        if (bytes.byteLength > MAX_DATAGRAM_LENGTH) throw new RangeError("Dedicated packet exceeds the source receive limit");
        owned = this.eventMemory?.packet(suppliedTime, sender, bytes) ?? Object.freeze({ kind: "packet", time: suppliedTime, from: sender, payload: bytes });
        break;
      }
    }
    if (this.events.length === MAX_UNIX_SYSTEM_EVENTS) {
      this.print("Sys_QueEvent: overflow\n");
      const discarded = this.events[0];
      if (discarded === undefined) throw new Error("Unix system event slot is empty");
      this.eventMemory?.free(discarded);
      this.events.shift();
    }
    if (suppliedTime === 0) {
      const time = this.clock.milliseconds();
      owned = this.eventMemory?.copy(owned, time) ?? eventWithTime(owned, time);
    }
    this.events.push(owned);
    this.wake();
  }

  takeQueuedEvent(): UnixQueuedSystemEvent | null {
    this.requireOpen();
    return this.events.shift() ?? null;
  }

  pollConsoleEvent(): void {
    this.requireOpen();
    const text = this.pollConsole();
    if (text !== null) this.queueEvent({ kind: "console", time: 0, text });
  }

  pollPacketEvent(): void {
    this.requireOpen();
    const packet = this.udp?.poll();
    if (packet === undefined || packet === null) return;
    if (packet.kind === "packet") this.queueEvent({ kind: "packet", time: 0, from: packet.from, payload: packet.payload });
    else {
      if (packet.error instanceof UdpReceiveInvariantError) throw packet.error;
      if (!ignoredReceiveError(packet.error)) this.print(`NET_GetPacket: ${packet.error.message}\n`);
    }
  }

  noneEvent(): UnixNoneSystemEvent {
    this.requireOpen();
    return { kind: "none", time: this.clock.milliseconds() };
  }

  async initializeNetwork(cvars: CvarRegistry): Promise<void> {
    this.requireOpen();
    if (this.network.kind !== "uninitialized") throw new Error("Dedicated network has already initialized or is initializing");
    this.network = { kind: "initializing" };
    let candidate: UdpTransport | null = null;
    try {
      const flags = CvarFlag.Archive | CvarFlag.Latch;
      const socksEnabled = cvars.register("net_socksEnabled", "0", flags).integerValue !== 0;
      const socksServer = cvars.register("net_socksServer", "", flags).value;
      const socksPort = cvars.register("net_socksPort", "1080", flags).integerValue & 65535;
      const socksUsername = cvars.register("net_socksUsername", "", flags).value;
      const socksPassword = cvars.register("net_socksPassword", "", flags).value;
      if (cvars.register("net_noudp", "0").numericValue !== 0) {
        this.network = { kind: "ready", udp: null, lan: this.emptyLan };
        return;
      }
      const ip = cvars.register("net_ip", "localhost").value;
      const nativePort = cvars.register("net_port", "27960").numericValue;
      if (!Number.isFinite(nativePort) || nativePort < -2147483648 || nativePort >= 2147483648) {
        throw new RangeError("net_port is outside the defined native signed-int conversion range");
      }
      const port = Math.trunc(nativePort);
      const resolved = ip === "" || ip.toLowerCase() === "localhost"
        ? { kind: "ipv4", host: [0, 0, 0, 0], port: 1 } satisfies Ipv4Address
        : await this.resolveAddress(ip, 1);
      this.requireOpen();
      if (resolved === null) throw new Error(`Could not resolve net_ip ${ip}`);
      for (let offset = 0; offset < 10; offset++) {
        const requested = port + offset;
        // Native NET_IPSocket casts its integer port to a network-order short.
        const boundPort = requested === -1 ? 0 : requested & 65535;
        this.print(`Opening IP socket: ${ip || "localhost"}:${requested}\n`);
        try { candidate = await UdpTransport.bind({ host: resolved.host, port: boundPort, print: this.print }); }
        catch (error) {
          this.requireOpen();
          this.print(`ERROR: UDP_OpenSocket: bind: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }
        this.requireOpen();
        this.initializingUdp = candidate;
        if (socksEnabled) {
          await candidate.connectSocks({ server: socksServer, port: socksPort, username: socksUsername, password: socksPassword });
          this.requireOpen();
        }
        const lan = LanAddresses.current();
        // Explicit port0 is a verifier adaptation. PORT_ANY(-1) retains source cvar semantics.
        cvars.set("net_port", String(requested === 0 ? candidate.address.port : requested), true);
        this.network = { kind: "ready", udp: candidate, lan };
        candidate = null;
        this.initializingUdp = null;
        return;
      }
      throw new Error("Couldn't allocate IP port");
    } catch (error) {
      candidate?.close();
      this.initializingUdp = null;
      if (!this.isClosed()) this.network = { kind: "uninitialized" };
      throw error;
    }
  }

  async restartNetwork(cvars: CvarRegistry): Promise<void> {
    this.requireOpen();
    if (this.network.kind !== "ready") throw new Error("Network restart requires initialized networking");
    const udp = this.network.udp;
    this.network = { kind: "uninitialized" };
    udp?.close();
    await this.initializeNetwork(cvars);
  }

  initializeConsole(cvars: CvarRegistry): void {
    this.requireOpen();
    if (this.console.kind !== "uninitialized") throw new Error("Dedicated console has already initialized");
    if (this.stdin.readableObjectMode || this.stdin.readableEncoding !== null || this.stdin.readableFlowing === true) {
      throw new Error("Dedicated console requires an exclusively owned paused binary Readable");
    }
    if (this.stdin instanceof ReadStream && this.stdin.isRaw) throw new Error("The console cannot take ownership of already raw terminal input");
    if (this.signals === "process" && this.releaseJobControlSignals === null) this.releaseJobControlSignals = acquireJobControlSignals();
    const ttycon = cvars.register("ttycon", "1");
    this.requireOpen();
    const state: Extract<ConsoleState, { readonly kind: "initialized" }> = {
      kind: "initialized", cvars, mode: { kind: "line" }, ended: this.stdin.readableEnded, error: null, eofConsumed: false,
    };
    this.console = state;
    this.stdin.on("readable", this.onReadable);
    this.stdin.on("end", this.onEnd);
    this.stdin.on("error", this.onError);
    // Bun's actual process.stdin is a socket for pipes/TTYs, but a plain file
    // ReadStream for redirection, despite its declared tty.ReadStream type.
    if (this.stdin === process.stdin && typeof process.stdin.ref === "function" && typeof process.stdin.unref === "function") {
      process.stdin.ref();
      this.releaseStdinReference = (): undefined => { process.stdin.unref(); };
    }
    if (ttycon.numericValue === 0) return;
    // Bun's process TTY may be a Socket rather than an instanceof ReadStream.
    const terminal = this.stdin instanceof ReadStream ? this.stdin : this.stdin === process.stdin ? process.stdin : null;
    if (terminal === null || terminal.isTTY !== true) {
      this.print("stdin is not a tty, tty console mode failed\n"); this.requireOpen(); cvars.set("ttycon", "0", true); return;
    }
    if (terminal.isRaw) throw new Error("The console cannot take ownership of already raw terminal input");
    const complete = this.completeConsoleField;
    if (complete === null) throw new Error("TTY console requires the common field completion owner");
    this.print("Started tty console (use +set ttycon 0 to disable)\n");
    this.requireOpen();
    const settings = prepareTtyTermios(terminal);
    const editor = new TtyConsole({ erase: settings.erase, complete,
      write: byte => { this.stdout.write(Uint8Array.of(byte)); },
      developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) this.print(text); },
    });
    state.mode = { kind: "tty", editor, terminal: settings };
    settings.activate();
  }

  private readonly onReadable = (): undefined => { this.wake(); };
  private readonly onEnd = (): undefined => {
    if (this.console.kind === "initialized") { this.console.ended = true; this.wake(); }
  };
  private readonly onError = (error: Error): undefined => {
    if (this.console.kind === "initialized") { this.console.error = error; this.wake(); }
  };

  private finishLine(): string {
    const line = this.line;
    if (this.truncated) this.print(`Console line exceeds ${MAX_UNIX_CONSOLE_LINE} bytes; excess bytes discarded\n`);
    this.line = ""; this.lineBytes = 0; this.lineNul = false; this.truncated = false;
    return line;
  }

  private pollConsole(): string | null {
    const state = this.console;
    if (state.kind !== "initialized") return null;
    const ttycon = state.cvars.find("ttycon");
    if (ttycon === undefined) throw new Error("Registered ttycon cvar no longer exists");
    if (ttycon.numericValue !== 0 && state.mode.kind === "line") {
      throw new Error("ttycon cannot enable raw editing after non-TTY console initialization");
    }
    if (state.error !== null) throw state.error;
    if (ttycon.numericValue !== 0 && state.mode.kind === "tty") {
      const text = state.mode.editor.poll(() => this.readConsoleByte());
      if (state.ended && this.stdin.readableLength === 0) state.eofConsumed = true;
      return text;
    }
    while (true) {
      const byte = this.readConsoleByte();
      if (byte === null) {
        if (state.ended && !state.eofConsumed) {
          state.eofConsumed = true;
          return this.lineBytes > 0 ? this.finishLine() : null;
        }
        return null;
      }
      if (this.afterCr) { this.afterCr = false; if (byte === 10) continue; }
      if (byte === 10 || byte === 13) { this.afterCr = byte === 13; return this.finishLine(); }
      this.lineBytes++;
      if (byte === 0) this.lineNul = true;
      if (this.lineBytes > MAX_UNIX_CONSOLE_LINE) this.truncated = true;
      else if (!this.lineNul) this.line += String.fromCharCode(byte);
    }
  }

  private readConsoleByte(): number | null {
    const chunk: unknown = this.stdin.read(1);
    if (chunk === null) return null;
    if (!(chunk instanceof Uint8Array) || chunk.length !== 1) throw new Error("Dedicated console returned non-byte input");
    const byte = chunk[0];
    if (byte === undefined) throw new Error("Dedicated console returned an empty byte read");
    return byte;
  }

  async yieldToIo(): Promise<void> {
    this.requireOpen();
    await Bun.sleep(1);
    this.requireOpen();
  }

  private wake(): undefined { this.sleeper?.(); }
  private inputReady(): boolean {
    const state = this.console;
    return this.events.length > 0 || (this.udp?.statistics.pending ?? 0) > 0
      || (state.kind === "initialized" && (state.error !== null || this.stdin.readableLength > 0 || (state.ended && !state.eofConsumed)));
  }

  async sleepUntilInput(milliseconds: number): Promise<void> {
    this.requireOpen();
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647) throw new RangeError("Dedicated sleep requires integer milliseconds in 0..2147483647");
    if (this.sleeper !== null) throw new Error("Dedicated input already has a pending sleep");
    const udp = this.udp;
    // Native NET_Sleep returns immediately without an IP socket. The outer yield still cooperates.
    if (udp === null || milliseconds === 0) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => undefined) | null = null;
      let finished = false, registering = true, wakePending = false;
      const settle = (errors: unknown[]): undefined => {
        if (finished) return;
        finished = true;
        try { if (timer !== null) clearTimeout(timer); } catch (error) { errors.push(error); }
        try { unsubscribe?.(); } catch (error) { errors.push(error); }
        this.sleeper = null;
        if (errors.length === 1) reject(errors[0]);
        else if (errors.length > 1) reject(new AggregateError(errors, "Dedicated input sleep failed", { cause: errors[0] }));
        else resolve();
      };
      const finish = (): undefined => {
        if (registering) { wakePending = true; return; }
        settle([]);
      };
      this.sleeper = finish;
      try {
        unsubscribe = udp.subscribeReadable(finish);
        // Registration may synchronously publish input. Settle only once ownership
        // of its unsubscribe has transferred, then recheck before arming the timer.
        const ready = this.inputReady();
        registering = false;
        if (wakePending || ready) finish();
        else timer = setTimeout(finish, milliseconds);
      } catch (error) { registering = false; settle([error]); }
    });
  }

  async resolveAddress(hostname: string, port: number): Promise<Ipv4Address | null> {
    this.requireOpen();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("Resolved IPv4 port requires an integer in 1..65535");
    const text = sourceCommandText(hostname);
    if (text.length === 0) return null;
    let host: Ipv4Host | null;
    if (/^[0-9]/.test(text)) host = numericHost(text);
    else {
      try { host = parseHost((await lookup(text, { family: 4 })).address); }
      catch { this.requireOpen(); return null; }
      this.requireOpen();
    }
    return host === null ? null : Object.freeze({ kind: "ipv4", host, port });
  }

  close(): void {
    if (this.network.kind === "closed") return;
    const udp = this.udp, state = this.console, hadConsole = state.kind === "initialized", releaseStdinReference = this.releaseStdinReference;
    const releaseJobControlSignals = this.releaseJobControlSignals;
    const releaseSignals = this.releaseSignals;
    this.network = { kind: "closed" };
    this.console = { kind: "closed" };
    this.releaseStdinReference = null;
    this.releaseJobControlSignals = null;
    this.releaseSignals = null;
    this.shutdownSignalGraphics = null;
    this.completeConsoleField = null;
    this.events = []; this.line = "";
    const errors: unknown[] = [];
    const release = (action: () => undefined): undefined => { try { action(); } catch (error) { errors.push(error); } };
    release(() => { this.wake(); });
    if (hadConsole) {
      if (state.mode.kind === "tty") {
        const { editor, terminal } = state.mode;
        release(() => { if (terminal.active) { editor.hide(); this.print("Shutdown tty console\n"); editor.show(); } });
        release(() => { terminal.close(); });
      }
      release(() => { this.stdin.removeListener("readable", this.onReadable); });
      release(() => { this.stdin.removeListener("end", this.onEnd); });
      release(() => { this.stdin.removeListener("error", this.onError); });
      release(() => { if (this.stdin.listenerCount("readable") === 0 && this.stdin.listenerCount("data") === 0) this.stdin.pause(); });
      // Pause failure cannot retain Bun's process-stdin reference or skip sockets.
      release(() => { if (this.stdin.listenerCount("readable") === 0 && this.stdin.listenerCount("data") === 0) releaseStdinReference?.(); });
    }
    release(() => { udp?.close(); });
    release(() => { this.initializingUdp?.close(); this.initializingUdp = null; });
    release(() => { releaseJobControlSignals?.(); });
    release(() => { releaseSignals?.(); });
    if (errors.length > 0) throw new AggregateError(errors, "Dedicated input cleanup failed", { cause: errors[0] });
  }
}
