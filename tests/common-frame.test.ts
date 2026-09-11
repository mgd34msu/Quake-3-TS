import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import type { CommandContext } from "../src/core/commands.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import type { CommonErrorCode } from "../src/core/common-error.ts";
import { CommonFrameDriver } from "../src/engine/common-frame.ts";
import { CommonJournal } from "../src/engine/common-journal.ts";
import { DedicatedServerHost } from "../src/engine/dedicated-server.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UdpTransport } from "../src/platform/network.ts";
import type {
  CommonClientRuntime,
  CommonFrameOpenOptions,
  CommonFramePlatform,
  CommonServerConstruction,
  CommonServerRuntime,
} from "../src/engine/common-frame.ts";
import type { CommonNeedCdCapability } from "../src/engine/common-frame.ts";
import type { CommonBuildProfile, CommonConsole } from "../src/engine/common-console.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { MAX_COMMON_PUSHED_EVENTS } from "../src/engine/common-events.ts";
import type { ServerShutdownRequest } from "../src/engine/server-engine.ts";
import type { ServerPacketAddress } from "../src/server/net-channel.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

const homes: string[] = [], drivers: CommonFrameDriver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true });
});

class RecorderPlatform implements CommonFramePlatform {
  private readonly events: CommonSystemEvent[] = [];
  time = 0;
  clockTime = 0;
  eventReads = 0;
  clockReads = 0;
  closed = false;

  constructor(private readonly trace: string[]) {}
  enqueue(event: CommonSystemEvent): void { this.events.push(event); }
  getEvent(): CommonSystemEvent { this.eventReads++; return this.events.shift() ?? { kind: "none", time: this.time }; }
  milliseconds(): number { this.clockReads++; return this.clockTime; }
  async yieldToIo(): Promise<void> { this.time = (this.time + 1) | 0; this.trace.push("yield"); }
  showConsole(level: number, quitOnClose: boolean): void { this.trace.push(`show:${level}:${quitOnClose}`); }
  async initialize(): Promise<void> { this.trace.push("platform:init"); }
  close(): void { if (!this.closed) { this.closed = true; this.trace.push("platform:close"); } }
}

class RecorderServer implements CommonServerRuntime {
  running = false;
  readonly profile = { timeGame: 0 };
  frameError: CommonError | null = null;

  constructor(private readonly trace: string[], private readonly platform: RecorderPlatform) {}
  async frame(milliseconds: number): Promise<void> {
    this.trace.push(`server:frame:${milliseconds}`);
    const error = this.frameError;
    this.frameError = null;
    if (error !== null) throw error;
  }
  async packetEvent(_from: ServerPacketAddress, _payload: Uint8Array): Promise<void> { this.trace.push("server:packet"); }
  async shutdown(request: ServerShutdownRequest): Promise<void> { this.running = false; this.trace.push(`server:shutdown:${request.kind}:${request.reason}`); }
  async shutdownFromCommand(reason: string): Promise<void> { this.running = false; this.trace.push(`server:command-shutdown:${reason}`); }
  async disposeResources(): Promise<void> { this.trace.push("server:dispose"); }
  *gameConsoleCommand(_context: CommandContext): CallSteps<boolean> { this.trace.push("server:command"); return false; }
  assertCommandEntry(): void {}
  enqueueSecondDrain(text: string): void { this.platform.enqueue({ kind: "console", time: this.platform.time, text }); }
}

class RecorderClient implements CommonClientRuntime {
  private cvars: CvarRegistry | null = null;
  readonly frameTimings = { frontEndMsec: 0, backEndMsec: 0 };

  constructor(private readonly trace: string[], readonly needCd: CommonNeedCdCapability = { kind: "absent" }) {}
  initializeInput(): void { this.trace.push("client:input-init"); }
  restartInput(): void { this.trace.push("client:input-restart"); }
  bind(cvars: CvarRegistry): void { this.cvars = cvars; }
  private registry(): CvarRegistry {
    if (this.cvars === null) throw new Error("Recorder client is not bound to common cvars");
    return this.cvars;
  }
  async initialize(): Promise<void> { this.registry().set("cl_running", "1", true); this.trace.push("client:init"); }
  async shutdown(): Promise<void> { this.registry().set("cl_running", "0", true); this.trace.push("client:shutdown"); }
  async disposeResources(): Promise<void> { this.trace.push("client:dispose"); }
  async frame(milliseconds: number): Promise<void> { this.trace.push(`client:frame:${milliseconds}`); }
  async packetEvent(_from: ServerPacketAddress, _payload: Uint8Array): Promise<void> { this.trace.push("client:packet"); }
  async keyEvent(key: number, down: boolean, time: number): Promise<void> { this.trace.push(`client:key:${key}:${down}:${time}`); }
  async characterEvent(character: number): Promise<void> { this.trace.push(`client:char:${character}`); }
  async mouseEvent(dx: number, dy: number, time: number): Promise<void> { this.trace.push(`client:mouse:${dx}:${dy}:${time}`); }
  async joystickEvent(axis: number, value: number, time: number): Promise<void> { this.trace.push(`client:joy:${axis}:${value}:${time}`); }
  async disconnect(showMainMenu: boolean): Promise<void> { this.trace.push(`client:disconnect:${showMainMenu}`); }
  async flushMemory(): Promise<void> { this.trace.push("client:flush"); }
  queueDefaultStartup(): void { this.trace.push("client:default-startup"); }
  async startHunkUsers(): Promise<void> { this.trace.push("client:hunk-users"); }
}

interface DriverFixture {
  readonly driver: CommonFrameDriver;
  readonly platform: RecorderPlatform;
  readonly server: RecorderServer;
  readonly client: RecorderClient;
  readonly trace: string[];
  readonly services: CommonServerConstruction;
}

function initializationRoots() {
  const root = mkdtempSync(join(tmpdir(), "q3-common-init-")); homes.push(root);
  const dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3", "default.cfg"), "\n");
  writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  return { dataPath, homePath, cdPath: null, product: "baseq3" } satisfies CommonFrameOpenOptions["roots"];
}

function journalDescriptors(homePath: string): string[] {
  const result: string[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    let path: string;
    try { path = readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
    if (path === join(homePath, "baseq3", "journal.dat") || path === join(homePath, "baseq3", "journaldata.dat")) result.push(path);
  }
  return result.sort();
}

describe("actual dedicated host journaling", () => {
  test("journal startup failures preserve config/error ordering and release partial real handles", async () => {
    for (const mode of [1, 2]) {
      const roots = initializationRoots(), stdin = new PassThrough(), printed: string[] = [];
      mkdirSync(join(roots.homePath, "baseq3"), { recursive: true });
      if (mode === 1) mkdirSync(join(roots.homePath, "baseq3", "journaldata.dat"));
      try {
        await expect(DedicatedServerHost.open({ roots, startupText: `+set journal ${mode} +set bot_enable 0 +set net_noudp 1`,
          buildDate: "failed-journal-test", print: text => { printed.push(text); },
          bots: { kind: "unavailable", reason: "No bot source call precedes journal failure" }, input: { stdin, signals: "none" } }))
          .rejects.toMatchObject({ code: "fatal", message: mode === 1 ? "Error writing to journal file" : "Error reading from journal file" });
        expect(printed.indexOf("Couldn't open journal files\n")).toBeGreaterThan(0);
        expect(printed.indexOf(mode === 1 ? "execing default.cfg\n" : "couldn't exec default.cfg\n"))
          .toBeGreaterThan(printed.indexOf("Couldn't open journal files\n"));
        expect(journalDescriptors(roots.homePath)).toEqual([]); expect(stdin.listenerCount("readable")).toBe(0);
      } finally { stdin.destroy(); }
    }
  });

  test("records real console and UDP input, replays startup/runtime configs and disposes both journal handles", async () => {
    const roots = initializationRoots(), printed: string[] = [];
    mkdirSync(join(roots.homePath, "baseq3"), { recursive: true });
    writeFileSync(join(roots.dataPath, "baseq3", "default.cfg"), "set startup_cfg recorded\n");
    const runtimePath = join(roots.homePath, "baseq3", "runtime.cfg");
    writeFileSync(runtimePath, "set runtime_cfg recorded\n");
    const stdin = new PassThrough(), replayStdin = new PassThrough();
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    let wall = 1000000;
    const open = (mode: number, input: PassThrough) => DedicatedServerHost.open({ roots,
      startupText: `+set journal ${mode} +set bot_enable 0 +set net_ip 127.0.0.1 +set net_port 0 +set fixedtime 2 +set developer 1 +set logfile 2`,
      buildDate: "actual-journal-test", print: text => { printed.push(text); },
      bots: { kind: "unavailable", reason: "No bot match belongs to this common journal test" },
      systemClock: new UnixSystemClock(() => wall++), input: { stdin: input, signals: "none" } });
    try {
      const recorded = await open(1, stdin); drivers.push(recorded.driver);
      expect(recorded.common.cvars.get("startup_cfg")?.value).toBe("recorded");
      expect(journalDescriptors(roots.homePath)).toHaveLength(2);
      const udp = recorded.server.options.network.udp;
      if (udp === null) throw new Error("Actual dedicated journal test has no UDP socket");
      const packet = new Uint8Array([255, 255, 255, 255, 106, 111, 117, 114, 110, 97, 108]);
      peer.send(udp.address, packet);
      const deadline = performance.now() + 2000;
      while (udp.statistics.pending === 0) {
        if (performance.now() > deadline) throw new Error("Real UDP packet did not reach the common event producer");
        await Bun.sleep(1);
      }
      stdin.write("exec runtime.cfg\n");
      const first = await recorded.frame();
      stdin.write("set event_value 23\n");
      const second = await recorded.frame();
      expect(recorded.common.cvars.get("runtime_cfg")?.value).toBe("recorded");
      expect(recorded.common.cvars.get("event_value")?.value).toBe("23");
      const eventBytes = readFileSync(join(roots.homePath, "baseq3", "journal.dat"));
      expect(eventBytes.indexOf(packet)).toBeGreaterThan(0);
      await recorded.close();
      expect(journalDescriptors(roots.homePath)).toEqual([]); expect(stdin.listenerCount("readable")).toBe(0);
      const printedAfterClose = printed.length;
      await recorded.close(); expect(printed).toHaveLength(printedAfterClose);
      writeFileSync(join(roots.dataPath, "baseq3", "default.cfg"), "set startup_cfg changed\n");
      writeFileSync(runtimePath, "set runtime_cfg changed\n");
      replayStdin.write("set live_input forbidden\n");
      wall = 9000000;
      const replayed = await open(2, replayStdin); drivers.push(replayed.driver);
      expect(replayed.common.cvars.get("startup_cfg")?.value).toBe("recorded");
      expect(await replayed.frame()).toEqual(first);
      expect(await replayed.frame()).toEqual(second);
      expect(replayed.common.cvars.get("runtime_cfg")?.value).toBe("recorded");
      expect(replayed.common.cvars.get("event_value")?.value).toBe("23");
      expect(replayed.common.cvars.get("live_input")).toBeUndefined();
      expect(printed).toContain("Loading runtime.cfg from journal file.\n");
      await expect(replayed.frame()).rejects.toMatchObject({ code: "fatal", message: "Error reading from journal file" });
      expect(journalDescriptors(roots.homePath)).toEqual([join(roots.homePath, "baseq3", "journaldata.dat")]);
      const finalPrintCount = printed.length;
      await replayed.close(); await replayed.close();
      expect(journalDescriptors(roots.homePath)).toEqual([]);
      expect(printed).toHaveLength(finalPrintCount); expect(replayStdin.listenerCount("readable")).toBe(0);
    } finally { peer.close(); stdin.destroy(); replayStdin.destroy(); }
  });
});

function unknownArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function errorMembers(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) throw new Error("Expected aggregate failure");
  const members: unknown = error.errors;
  if (!unknownArray(members)) throw new Error("Invalid aggregate members");
  return members;
}

function observePureClearing(common: CommonConsole, trace: string[], label = "pure-clear"): void {
  const clear = common.clearPureServerPaks.bind(common);
  common.clearPureServerPaks = async assertCurrentOperation => {
    await clear(assertCurrentOperation);
    expect(common.files.serverLoadedPaks).toEqual([]);
    trace.push(label);
  };
}

describe("first quit control and finite system/resource boundaries", () => {
  for (const point of ["client", "common"] satisfies readonly string[]) {
    for (const code of ["drop", "fatal"] satisfies readonly CommonErrorCode[]) {
      test(`first ${code} during normal quit ${point} callback dispatches before remaining source cleanup`, async () => {
        const f = await fixture("client", "+set dedicated 1"), common = f.driver.common;
        const first = new CommonError(code, "normal quit callback"), shutdown = common.shutdown.bind(common);
        let failed = false;
        const failOnce = (): void => { if (!failed) { failed = true; throw first; } };
        common.shutdown = () => { f.trace.push("common:shutdown"); if (point === "common") failOnce(); shutdown(); };
        if (point === "client") {
          const shutdown = f.client.shutdown.bind(f.client);
          f.client.shutdown = async () => { await shutdown(); failOnce(); };
        }
        f.trace.length = 0; common.commands.append("quit\n");
        if (code === "fatal") await expect(f.driver.frame()).rejects.toBe(first);
        else {
          expect((await f.driver.frame()).kind).toBe("aborted");
          expect(f.platform.closed).toBe(false); common.assertCapabilities();
          expect(f.trace.filter(text => text === "common:shutdown")).toHaveLength(point === "common" ? 1 : 0);
        }
        expect(f.trace.filter(text => text === "client:pure-clear")).toHaveLength(1);
        expect(f.trace.filter(text => text.startsWith("server:shutdown:common-error"))).toHaveLength(1);
        await f.driver.close();
      });
    }
  }

  test("recoverable public close still attempts platform after every managed owner fails", async () => {
    const f = await fixture("client", "+set dedicated 1"), first = new CommonError("drop", "recoverable close");
    const common = f.driver.common, close = common.close.bind(common), platformClose = f.platform.close.bind(f.platform);
    let injected = false;
    f.server.shutdown = async request => { if (request.kind === "normal" && !injected) { injected = true; throw first; } };
    const secondary = new CommonError("fatal", "managed server failure");
    f.server.disposeResources = async () => { f.trace.push("server:resource-error"); throw secondary; };
    f.client.disposeResources = async () => { f.trace.push("client:resource-error"); throw null; };
    common.close = () => { f.trace.push("common:resource-error"); close(); throw undefined; };
    const platformFailure = new Error("managed platform failure");
    f.platform.close = () => { platformClose(); throw platformFailure; };
    f.trace.length = 0;
    let observed: unknown;
    try { await f.driver.close(); } catch (error) { observed = error; }
    const members = errorMembers(observed);
    expect(members[0]).toBe(first);
    expect(errorMembers(members[1])).toEqual([secondary, null, undefined, platformFailure]);
    expect(f.trace.slice(-4)).toEqual(["server:resource-error", "client:resource-error", "common:resource-error", "platform:close"]);
    expect(f.trace.filter(text => text === "client:pure-clear")).toHaveLength(1);
    const finalTrace = [...f.trace]; await f.driver.close(); expect(f.trace).toEqual(finalTrace);
  });

  for (const point of ["server", "client", "common"] satisfies readonly string[]) {
    for (const value of [new Error("ordinary shutdown failure"), null, undefined]) {
      test(`ordinary ${point} source shutdown ${String(value)} retains accumulation and finite later stages`, async () => {
        const f = await fixture("client", "+set dedicated 1"), common = f.driver.common;
        let failed = false;
        const failOnce = (): void => { if (!failed) { failed = true; throw value; } };
        if (point === "server") f.server.shutdownFromCommand = async () => { f.trace.push("server:ordinary"); failOnce(); };
        else if (point === "client") {
          const shutdown = f.client.shutdown.bind(f.client);
          f.client.shutdown = async () => { await shutdown(); failOnce(); };
        } else {
          const shutdown = common.shutdown.bind(common);
          common.shutdown = () => { shutdown(); failOnce(); };
        }
        f.trace.length = 0; common.commands.append("quit\n");
        let observed: unknown;
        try { await f.driver.frame(); } catch (error) { observed = error; }
        expect(errorMembers(observed)).toEqual([value]);
        expect(f.trace.filter(text => text === "client:shutdown")).toHaveLength(2);
        expect(f.trace).toContain("platform:close");
        expect(f.trace).not.toContain("client:pure-clear");
        await f.driver.close();
        expect(f.trace.filter(text => text === "server:dispose")).toHaveLength(1);
      });
    }
  }

  for (const entry of ["frame", "limit", "close"] satisfies readonly string[]) {
    for (const code of ["server-disconnect", "drop", "disconnect", "need-cd", "fatal"] satisfies readonly CommonErrorCode[]) {
      test(`${entry} first quit ${code} selects its branch without resuming quit`, async () => {
        const f = await fixture("client", "+set dedicated 1"), first = new CommonError(code, "first quit error");
        const common = f.driver.common;
        let injected = false;
        f.server.shutdownFromCommand = async () => { f.trace.push("quit:interrupted"); injected = true; throw first; };
        f.server.shutdown = async request => {
          if (!injected && request.kind === "normal") { injected = true; f.trace.push("quit:interrupted"); throw first; }
          f.trace.push(`selected:${request.kind}:${request.reason}`);
        };
        f.trace.length = 0;
        if (entry === "frame") {
          common.commands.append("quit; echo forbidden\n");
          if (code === "fatal") await expect(f.driver.frame()).rejects.toBe(first);
          else expect(await f.driver.frame()).toEqual({ kind: "aborted", frameNumber: 0, code, message: first.message });
        } else if (entry === "limit") await expect(f.driver.run({ kind: "frames", count: 1 })).rejects.toBe(first);
        else await expect(f.driver.close()).rejects.toBe(first);
        expect(injected).toBe(true);
        expect(f.trace.filter(value => value === "quit:interrupted")).toHaveLength(1);
        expect(f.trace.some(value => value.includes("forbidden"))).toBe(false);
        if (code === "server-disconnect") expect(f.trace.filter(value => value.startsWith("selected:"))).toEqual([]);
        else expect(f.trace.filter(value => value.startsWith("selected:"))).toEqual([
          code === "fatal" ? "selected:common-error:Server fatal crashed: first quit error\n"
            : code === "need-cd" ? "selected:common-error:Server didn't have CD\n" : "selected:common-error:Server crashed: first quit error\n",
        ]);
        if (entry !== "close" && code !== "fatal") {
          expect(f.platform.closed).toBe(false); common.assertCapabilities();
          expect(f.trace).not.toContain("server:dispose");
        } else expect(f.platform.closed).toBe(true);
        if (entry === "close") {
          expect(f.trace.filter(value => value === "server:dispose")).toHaveLength(1);
          expect(f.trace.filter(value => value === "client:dispose")).toHaveLength(1);
          await expect(f.driver.frame()).rejects.toThrow("closed");
        }
        // Restore the source callback for explicit disposal after the observation.
        f.server.shutdownFromCommand = async () => undefined;
        await f.driver.close();
      });
    }
  }

  for (const entry of ["normal", "fatal", "direct-system"] satisfies readonly string[]) {
    for (const failure of [new CommonError("drop", "system client control"), new Error("system client ordinary"), null, undefined]) {
      test(`${entry} system client ${String(failure)} cannot skip platform or reenter source`, async () => {
        const f = await fixture("client", "+set dedicated 1"), primary = new CommonError("fatal", "initial fatal");
        if (entry === "direct-system") {
          f.server.frameError = new CommonError("need-cd", "sticky error");
          expect((await f.driver.frame()).kind).toBe("aborted");
        }
        f.trace.length = 0;
        let calls = 0;
        f.client.shutdown = async () => {
          f.trace.push("client:shutdown"); calls++;
          if (calls === (entry === "direct-system" ? 1 : 2)) {
            expect(() => f.driver.assertCurrentOperation()).toThrow("no longer active");
            throw failure;
          }
        };
        const platformFailure = new Error("system platform failure"), closePlatform = f.platform.close.bind(f.platform);
        f.platform.close = () => { closePlatform(); throw platformFailure; };
        if (entry === "fatal") f.server.frameError = primary;
        else f.driver.common.commands.append("quit\n");
        let observed: unknown;
        try { await f.driver.frame(); } catch (error) { observed = error; }
        expect(errorMembers(observed)).toEqual(entry === "fatal" ? [primary, failure, platformFailure] : [failure, platformFailure]);
        expect(calls).toBe(entry === "direct-system" ? 1 : 2);
        expect(f.trace.filter(value => value === "platform:close")).toHaveLength(1);
        const sourceTrace = [...f.trace];
        await f.driver.close(); await f.driver.close();
        expect(f.trace).toEqual([...sourceTrace, "server:dispose", "client:dispose"]);
      });
    }
  }

  test("terminal resource failures remain opaque, consume all owners and reject source reentry", async () => {
    const f = await fixture("client", "+set dedicated 1"), common = f.driver.common;
    f.server.frameError = new CommonError("need-cd", "sticky");
    await f.driver.frame();
    f.server.frameError = new CommonError("drop", "recursive");
    await expect(f.driver.frame()).rejects.toThrow("recursive error after: sticky");
    const resourceControl = new CommonError("drop", "resource-only failure"), sourceTrace = [...f.trace];
    f.server.disposeResources = async () => {
      f.trace.push("server:dispose-failed");
      expect(() => f.driver.server).toThrow("ownership");
      expect(() => f.driver.assertCurrentOperation()).toThrow("no longer active");
      await expect(f.driver.pumpForDownloadsComplete()).rejects.toThrow("no longer active");
      await expect(f.driver.frame()).rejects.toThrow("source order");
      throw resourceControl;
    };
    f.client.disposeResources = async () => { f.trace.push("client:dispose-failed"); throw null; };
    const close = common.close.bind(common);
    common.close = () => { f.trace.push("common:dispose-failed"); close(); throw undefined; };
    let observed: unknown;
    try { await f.driver.close(); } catch (error) { observed = error; }
    expect(errorMembers(observed)).toEqual([resourceControl, null, undefined]);
    expect(f.trace).toEqual([...sourceTrace, "server:dispose-failed", "client:dispose-failed", "common:dispose-failed"]);
    const disposedTrace = [...f.trace];
    await f.driver.close(); expect(f.trace).toEqual(disposedTrace);
    expect(() => common.assertCapabilities()).toThrow("closed");
  });
});

describe("first typed initialization control, controlled actual-driver capabilities", () => {
  test("a bound running server without an actual owner is reported rather than replaced by a shutdown placeholder", async () => {
    const trace: string[] = [], platform = new RecorderPlatform(trace), first = new CommonError("fatal", "qport source error");
    let constructed = false, observed: unknown;
    platform.getEvent = () => { throw first; };
    try {
      await CommonFrameDriver.open({ roots: initializationRoots(), startupText: "+set sv_running 1", buildDate: "missing-owner",
        build: { kind: "dedicated" }, platformPrint: () => undefined, client: { kind: "absent" },
        systemClock: platform, createPlatform: () => platform,
        createServer: () => { constructed = true; return new RecorderServer(trace, platform); }, resolveCommand: () => undefined });
    } catch (error) { observed = error; }
    const members = errorMembers(observed);
    expect(members[0]).toBe(first);
    expect(members[1]).toBeInstanceOf(Error);
    const unavailable = members[1];
    if (!(unavailable instanceof Error)) throw new Error("Missing owner inconsistency was not reported");
    expect(unavailable.message).toBe("Running common server has no actual server owner");
    expect(constructed).toBe(false); expect(platform.closed).toBe(true);
  });

  for (const primary of [null, undefined]) {
    test(`failed open keeps the presence of thrown ${String(primary)} ahead of disposal failure`, async () => {
      const client = new RecorderClient([]), secondary = new CommonError("drop", "client resource error");
      client.disposeResources = async () => { throw secondary; };
      let observed: unknown;
      try {
        await CommonFrameDriver.open({ roots: initializationRoots(), startupText: "", buildDate: "tagged-primary",
          build: { kind: "client", client: { initializeKeyCommands: () => {}, consolePrint: () => {}, writeBindings: () => {}, usesUniqueKey: () => 0 } },
          platformPrint: () => { throw primary; }, client: { kind: "available", runtime: client },
          systemClock: { milliseconds: () => 0 },
          createPlatform: () => { throw new Error("Forbidden startup"); }, createServer: () => { throw new Error("Forbidden startup"); },
          resolveCommand: () => undefined });
      } catch (error) { observed = error; }
      const members = errorMembers(observed);
      expect(members[0]).toBe(primary); expect(errorMembers(members[1])).toEqual([secondary]);
    });
  }

  for (const code of ["drop", "need-cd"] satisfies readonly CommonErrorCode[]) {
    test(`early ${code} ignores startup-created source bindings and has a clock without an event/platform owner`, async () => {
      const trace: string[] = [], client = new RecorderClient(trace), first = new CommonError(code, "early bootstrap");
      const registries: CvarRegistry[] = [];
      let finalCvars: readonly CvarSnapshot[] = [];
      client.disposeResources = async () => {
        const registry = registries[0];
        if (registry === undefined) throw new Error("Missing early registry before disposal");
        finalCvars = registry.snapshots();
        trace.push("client:dispose");
      };
      let observed: unknown, clocks = 0;
      try {
        await CommonFrameDriver.open({ roots: initializationRoots(),
          startupText: "+set dedicated 0 +set com_buildScript 1 +set sv_running 1 +set cl_running 1",
          buildDate: "early-bindings", build: { kind: "client", client: {
            initializeKeyCommands: services => {
              registries.push(services.cvars); client.bind(services.cvars); trace.length = 0; throw first;
            }, consolePrint: text => { trace.push(`client-console:${text}`); }, writeBindings: () => {}, usesUniqueKey: () => 0,
          } }, platformPrint: text => { trace.push(`print:${text}`); }, client: { kind: "available", runtime: client },
          systemClock: { milliseconds: () => { clocks++; return 1000; } },
          createPlatform: () => { throw new Error("Forbidden early platform construction"); },
          createServer: () => { throw new Error("Forbidden early server construction"); }, resolveCommand: () => undefined });
      } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(CommonError);
      if (!(observed instanceof CommonError)) throw new Error("Early source control was lost");
      expect(observed.message).toBe("Error during initialization");
      expect(observed).not.toBe(first);
      expect(clocks).toBe(1);
      expect(trace.filter(text => text.startsWith("client-console:"))).toEqual([]);
      expect(trace.filter(text => !text.startsWith("print:"))).toEqual(code === "drop"
        ? ["client:disconnect:true", "client:flush", "client:shutdown", "client:dispose"]
        : ["client:shutdown", "client:dispose"]);
      const cvars = registries[0];
      if (cvars === undefined) throw new Error("Missing early registry");
      expect(finalCvars.find(value => value.name === "com_buildScript")?.integerValue).toBe(1);
      expect(finalCvars.find(value => value.name === "logfile")).toBeUndefined();
      expect(finalCvars.find(value => value.name === "com_errorMessage")?.value).toBe(code === "drop" ? first.message : undefined);
      expect(() => cvars.get("com_buildScript")).toThrow("no longer valid");
    });
  }

  for (const primary of [new Error("pre-setjmp ordinary"), new CommonError("drop", "pre-setjmp control"), null, undefined]) {
    test(`pre-setjmp ${String(primary)} preserves exact primary and disposes the captured actual client handle`, async () => {
      const roots = initializationRoots(), trace: string[] = [], client = new RecorderClient(trace);
      const fd = openSync(join(roots.dataPath, "owned-client-handle"), "w");
      let owned: number | null = fd, disposals = 0, observed: unknown;
      client.disposeResources = async () => {
        const handle = owned; owned = null; disposals++;
        if (handle !== null) closeSync(handle);
      };
      try {
        await CommonFrameDriver.open({ roots, startupText: "", buildDate: "pre-setjmp",
          build: { kind: "client", client: { initializeKeyCommands: () => {}, consolePrint: () => {}, writeBindings: () => {}, usesUniqueKey: () => 0 } },
          platformPrint: () => { throw primary; }, client: { kind: "available", runtime: client },
          systemClock: { milliseconds: () => { throw new Error("Forbidden pre-setjmp clock"); } },
          createPlatform: () => { throw new Error("Forbidden platform construction"); },
          createServer: () => { throw new Error("Forbidden server construction"); }, resolveCommand: () => undefined });
      } catch (error) { observed = error; }
      finally { if (owned !== null) closeSync(owned); }
      expect(observed).toBe(primary); expect(disposals).toBe(1);
      expect(() => fstatSync(fd)).toThrow(); expect(trace).toEqual([]);
    });
  }

  test("failed-open primary and all remaining disposal failures stay ordered without typed resource redispatch", async () => {
    const trace: string[] = [], platform = new RecorderPlatform(trace), client = new RecorderClient(trace);
    const first = new CommonError("fatal", "selected init fatal"), resource = new CommonError("drop", "resource failure");
    let observed: unknown;
    client.initialize = async () => { throw first; };
    client.disposeResources = async () => { trace.push("client:resource-error"); throw undefined; };
    try {
      await CommonFrameDriver.open({ roots: initializationRoots(), startupText: "", buildDate: "failed-disposal",
        build: { kind: "client", client: { initializeKeyCommands: () => {}, consolePrint: () => {}, writeBindings: () => {}, usesUniqueKey: () => 0 } },
        platformPrint: () => undefined, client: { kind: "available", runtime: client },
        systemClock: platform,
        createPlatform: () => platform, createServer: services => {
          observePureClearing(services.common, trace);
          client.bind(services.common.cvars);
          const server = new RecorderServer(trace, platform);
          server.disposeResources = async () => { trace.push("server:resource-error"); throw resource; };
          return server;
        }, resolveCommand: () => undefined });
    } catch (error) { observed = error; }
    const members = errorMembers(observed);
    expect(members[0]).toBe(first); expect(errorMembers(members[1])).toEqual([resource, undefined]);
    expect(trace.filter(text => text === "pure-clear")).toHaveLength(1);
    expect(trace.slice(-3)).toEqual(["platform:close", "server:resource-error", "client:resource-error"]);
  });

  test("an escaped deferred-registration callback cannot retain a second owner after transfer", async () => {
    const platform = new RecorderPlatform([]), registrations: ((cleanup: () => void) => void)[] = [];
    const driver = await CommonFrameDriver.open({ roots: initializationRoots(), startupText: "", buildDate: "deferred-transfer",
      build: { kind: "dedicated" }, platformPrint: () => undefined, client: { kind: "absent" },
      systemClock: platform, createPlatform: () => platform,
      createServer: services => { registrations.push(services.deferCleanup); return new RecorderServer([], platform); }, resolveCommand: () => undefined });
    drivers.push(driver);
    const register = registrations[0];
    if (register === undefined) throw new Error("Missing deferred registrar");
    let ran = false;
    expect(() => register(() => { ran = true; })).toThrow("current owned");
    driver.common.commands.register("stale_registration", () => {
      expect(() => register(() => { ran = true; })).toThrow("transferred ownership");
    });
    driver.common.commands.append("stale_registration\n");
    expect((await driver.frame()).kind).toBe("frame");
    await driver.close(); expect(ran).toBe(false);
  });

  for (const code of ["server-disconnect", "drop", "disconnect", "need-cd", "fatal"] satisfies readonly CommonErrorCode[]) {
    for (const recursive of code === "fatal" ? [false, true] : [false]) {
      test(`client initialization ${code}, recursive=${recursive}, preserves selection and disposes only afterward`, async () => {
        const trace: string[] = [], platform = new RecorderPlatform(trace), client = new RecorderClient(trace);
        platform.clockTime = 1000;
        const first = new CommonError(code, `first client initialization ${code}`), captured: CommonConsole[] = [];
        let finalCvars: readonly CvarSnapshot[] = [];
        client.disposeResources = async () => {
          const common = captured[0];
          if (common === undefined) throw new Error("Missing common owner before disposal");
          finalCvars = common.cvars.snapshots();
          trace.push("client:dispose");
        };
        let shutdowns = 0, observed: unknown;
        client.initialize = async () => { trace.length = 0; trace.push("client:init-error"); throw first; };
        client.shutdown = async () => {
          trace.push("client:shutdown"); shutdowns++;
          if (recursive && shutdowns === 1) throw new CommonError("drop", "second client shutdown");
        };
        try {
          await CommonFrameDriver.open({ roots: initializationRoots(), startupText: "", buildDate: "init-test",
            build: { kind: "client", client: { initializeKeyCommands: () => {}, consolePrint: () => {}, writeBindings: () => {}, usesUniqueKey: () => 0 } },
            platformPrint: text => { trace.push(`print:${text}`); }, client: { kind: "available", runtime: client },
            systemClock: platform,
            createPlatform: () => platform, createServer: services => {
              observePureClearing(services.common, trace);
              captured.push(services.common); client.bind(services.common.cvars); return new RecorderServer(trace, platform);
            }, resolveCommand: () => undefined });
        } catch (error) { observed = error; }
        expect(observed).toBeInstanceOf(CommonError);
        if (!(observed instanceof CommonError)) throw new Error("Expected initialization source control");
        expect(observed.code).toBe("fatal");
        expect(observed.message).toBe(recursive ? `recursive error after: ${first.message}` : code === "fatal" ? first.message : "Error during initialization");
        if (code === "fatal" && !recursive) expect(observed).toBe(first);
        const common = captured[0];
        if (common === undefined) throw new Error("Missing captured common owner");
        expect(finalCvars.find(value => value.name === "com_errorMessage")?.value).toBe(code === "disconnect" || code === "need-cd" ? undefined : first.message);
        expect(() => common.assertCapabilities()).toThrow("closed");
        const selected = trace.filter(text => !text.startsWith("print:"));
        const expected = ["client:init-error", "pure-clear"];
        if (code === "fatal") {
          expected.push("client:shutdown");
          if (recursive) expected.push("pure-clear");
          else expected.push(`server:shutdown:common-error:Server fatal crashed: ${first.message}\n`);
        } else if (code === "drop" || code === "disconnect") {
          expected.push(`server:shutdown:common-error:Server crashed: ${first.message}\n`, "client:disconnect:true", "client:flush");
        } else if (code === "server-disconnect") expected.push("client:disconnect:true", "client:flush");
        else expected.push("server:shutdown:common-error:Server didn't have CD\n");
        expected.push("client:shutdown", "platform:close", "server:dispose", "client:dispose");
        expect(selected).toEqual(expected);
        expect(platform.clockReads).toBe(recursive ? 2 : 1);
      });
    }
  }

  for (const control of ["ordinary", "typed-body", "typed-cleanup"] satisfies readonly string[]) {
    test(`initialization deferred ledger ${control} preserves typed control and consumes only once`, async () => {
      const trace: string[] = [], platform = new RecorderPlatform(trace);
      const first = control === "typed-body" ? new CommonError("drop", "typed factory") : new Error("ordinary factory");
      const second = new CommonError("drop", "typed cleanup");
      let observed: unknown;
      try {
        await CommonFrameDriver.open({ roots: initializationRoots(), startupText: "", buildDate: "ledger-test", build: { kind: "dedicated" },
          platformPrint: text => { if (text.includes("ERROR:")) trace.push(text); }, client: { kind: "absent" },
          systemClock: platform,
          createPlatform: () => platform, createServer: services => {
            observePureClearing(services.common, trace);
            services.deferCleanup(() => { trace.push("older-cleanup"); });
            services.deferCleanup(() => { trace.push("newer-cleanup"); if (control === "typed-cleanup") throw second; });
            throw first;
          }, resolveCommand: () => undefined });
      } catch (error) { observed = error; }
      if (control === "ordinary") {
        expect(observed).toBe(first); expect(trace).toEqual(["newer-cleanup", "older-cleanup", "platform:close"]);
      } else {
        expect(observed).toBeInstanceOf(CommonError);
        if (!(observed instanceof CommonError)) throw new Error("Typed cleanup was erased");
        expect(observed.message).toBe("Error during initialization");
        const error = control === "typed-body" ? first : second;
        const expected = ["pure-clear", `********************\nERROR: ${error.message}\n********************\n`, "platform:close"];
        if (control === "typed-cleanup") expected.unshift("newer-cleanup"); else expected.push("newer-cleanup");
        expected.push("older-cleanup"); expect(trace).toEqual(expected);
      }
    });
  }
});

async function fixture(profile: "dedicated" | "client", startupText = "", needCd: CommonNeedCdCapability = { kind: "absent" }): Promise<DriverFixture> {
  const root = mkdtempSync(join(tmpdir(), "q3-common-frame-")); homes.push(root);
  const dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true }); mkdirSync(join(homePath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3", "default.cfg"), "\n");
  writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  const trace: string[] = [], platform = new RecorderPlatform(trace), client = new RecorderClient(trace, needCd);
  let server: RecorderServer | null = null;
  let construction: CommonServerConstruction | null = null;
  const build: CommonBuildProfile = profile === "dedicated" ? { kind: "dedicated" } : {
    kind: "client",
    client: {
      initializeKeyCommands: (): void => { trace.push("keys:init"); },
      writeBindings: (write: (text: string) => undefined): void => { write("unbindall\n"); trace.push("keys:write"); },
      consolePrint: (text: string): void => { trace.push(`console:${text}`); },
      usesUniqueKey: (): number => 0,
    },
  };
  const options: CommonFrameOpenOptions = {
    roots: { dataPath, homePath, cdPath: null, product: "baseq3" }, startupText, buildDate: "common-frame-test",
    build, platformPrint: text => { trace.push(`print:${text}`); }, client: profile === "dedicated" ? { kind: "absent" } : { kind: "available", runtime: client },
    systemClock: platform, createPlatform: () => platform,
    createServer: (services: CommonServerConstruction): CommonServerRuntime => {
      construction = services;
      if (profile === "client") observePureClearing(services.common, trace, "client:pure-clear");
      client.bind(services.common.cvars); server = new RecorderServer(trace, platform); return server;
    },
    resolveCommand: () => undefined,
  };
  const driver = await CommonFrameDriver.open(options); drivers.push(driver);
  if (server === null || construction === null) throw new Error("Missing recorder server");
  return { driver, platform, server, client, trace, services: construction };
}

test("renderer callbacks borrow a live operation and retire idle synchronous scopes", async () => {
  const { driver, services } = await fixture("client");
  expect(() => services.assertCurrentOperation()).toThrow("current owned driver operation");
  let descendant: Promise<void> | null = null;
  services.runRendererCallback(() => {
    services.assertCurrentOperation();
    expect(services.runRendererCallback(() => 17)).toBe(17);
    descendant = Promise.resolve().then(() => {
      expect(() => services.assertCurrentOperation()).toThrow("current owned driver operation");
    });
  });
  await descendant;
  expect(() => services.assertCurrentOperation()).toThrow("current owned driver operation");
  services.common.commands.register("renderer_scope", () => {
    services.assertCurrentOperation();
    services.runRendererCallback(() => { services.assertCurrentOperation(); });
    services.assertCurrentOperation();
  });
  services.common.commands.append("renderer_scope\n");
  await driver.frame();
  const failure = new Error("renderer source failure");
  expect(() => services.runRendererCallback(() => { throw failure; })).toThrow(failure);
  expect(services.runRendererCallback(() => 23)).toBe(23);
  await driver.close();
  expect(() => services.runRendererCallback(() => 0)).toThrow("active common source work");
});

describe("Unix Sys_Init common startup", () => {
  for (const dedicated of [0, 1]) {
    test(`client build with dedicated=${dedicated} initializes source input before Netchan and server`, async () => {
      const trace: string[] = [], platformOwner = new RecorderPlatform(trace), client = new RecorderClient(trace);
      let inputInitialized = false;
      platformOwner.getEvent = () => {
        expect(inputInitialized).toBe(true);
        trace.push("event:sample"); return { kind: "none", time: 71325 };
      };
      const driver = await CommonFrameDriver.open({ roots: initializationRoots(), startupText: `+set dedicated ${dedicated}`,
        buildDate: "system-init-order", build: { kind: "client", client: {
          initializeKeyCommands: services => {
            client.bind(services.cvars);
            client.initializeInput = () => {
              expect(services.commands.registeredNames()).toContain("in_restart");
              expect(services.cvars.get("arch")).toMatchObject({ value: `${platform()} ${arch()} TypeScript`, flags: CvarFlag.None });
              expect(services.cvars.get("username")).toMatchObject({ value: userInfo().username, flags: CvarFlag.None });
              const names = services.cvars.snapshots().map(value => value.name);
              expect(names.indexOf("username")).toBeLessThan(names.indexOf("arch"));
              for (const name of ["showpackets", "showdrop", "net_qport"]) expect(services.cvars.get(name)).toBeUndefined();
              inputInitialized = true; trace.push("client:input-init");
            };
          }, consolePrint: () => {}, writeBindings: () => {}, usesUniqueKey: () => 0,
        } }, platformPrint: () => undefined, client: { kind: "available", runtime: client },
        systemClock: platformOwner, createPlatform: () => platformOwner,
        createServer: services => {
          expect(inputInitialized).toBe(true);
          expect(services.common.cvars.get("net_qport")).toMatchObject({ value: "5789", flags: CvarFlag.Init });
          expect(services.common.cvars.get("showpackets")?.flags).toBe(CvarFlag.Temporary);
          expect(services.common.cvars.get("showdrop")?.flags).toBe(CvarFlag.Temporary);
          trace.push("server:init"); return new RecorderServer(trace, platformOwner);
        }, resolveCommand: () => undefined });
      drivers.push(driver);
      expect(trace.slice(0, 3)).toEqual(["client:input-init", "event:sample", "server:init"]);
      expect(trace.includes("client:init")).toBe(dedicated === 0);
      expect(trace.at(-1)).toBe("platform:init");
      driver.common.commands.append("in_restart\n");
      await driver.frame();
      expect(trace.filter(value => value === "client:input-restart")).toHaveLength(1);
    });
  }

  test("dedicated build registers the source null input command and force-sets existing system cvars", async () => {
    const f = await fixture("dedicated", "+set arch invented +set username invented");
    expect(f.driver.common.commands.registeredNames()).toContain("in_restart");
    expect(f.driver.common.cvars.get("arch")).toMatchObject({ value: `${platform()} ${arch()} TypeScript`, flags: CvarFlag.UserCreated });
    expect(f.driver.common.cvars.get("username")).toMatchObject({ value: userInfo().username, flags: CvarFlag.UserCreated });
    f.trace.length = 0;
    f.driver.common.commands.append("in_restart\n");
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(f.trace.some(value => value.startsWith("client:"))).toBe(false);
    expect(f.trace.some(value => value.includes("Unknown command"))).toBe(false);
  });

  test("in_restart executes inside common source error dispatch", async () => {
    const f = await fixture("client", "+set dedicated 1");
    f.client.restartInput = () => { f.driver.assertCurrentOperation(); throw new CommonError("drop", "input restart failed"); };
    f.trace.length = 0;
    f.driver.common.commands.append("in_restart\n");
    expect(await f.driver.frame()).toMatchObject({ kind: "aborted", code: "drop", message: "input restart failed" });
    expect(f.trace.filter(value => value.startsWith("client:"))).toEqual(["client:pure-clear", "client:disconnect:true", "client:flush"]);
  });
});

describe("common source timing and trace reports", () => {
  test("samples both event drains and reads actual retained producer times before reporting and advancing", async () => {
    const f = await fixture("client", "+set com_speeds 1 +set com_maxfps 0 +set com_showtrace 1");
    const common = f.driver.common;
    const samples = [100, 110, 140, 150, 190];
    f.platform.milliseconds = () => {
      const value = samples.shift();
      if (value === undefined) throw new Error("Unexpected timing sample");
      f.trace.push(`clock:${value}`); return value;
    };
    f.server.frame = async () => { f.trace.push("server:timed"); f.server.profile.timeGame = 7; };
    f.client.frame = async () => {
      f.trace.push("client:timed"); f.client.frameTimings.frontEndMsec = 11; f.client.frameTimings.backEndMsec = 13;
      common.collisionCounters.c_traces = 12345; common.collisionCounters.c_brush_traces = 9;
      common.collisionCounters.c_patch_traces = 8; common.collisionCounters.c_pointcontents = 6;
    };
    f.trace.length = 0;
    const result = await f.driver.frame();
    expect(result).toMatchObject({ kind: "frame", frameNumber: 1 });
    expect(f.trace.filter(text => text.startsWith("clock:") || text.endsWith(":timed") || text.startsWith("print:frame:") || text.includes("print:12345 traces")))
      .toEqual(["clock:100", "clock:110", "server:timed", "clock:140", "clock:150", "client:timed", "clock:190",
        "print:frame:0 all: 80 sv: 23 ev: 20 cl: 16 gm:  7 rf: 11 bk: 13\n", "print:12345 traces  (9b 8p)    6 points\n"]);
    expect(samples).toEqual([]);
    expect(common.collisionCounters).toMatchObject({ c_traces: 0, c_brush_traces: 0, c_patch_traces: 0, c_pointcontents: 0 });
    expect(f.server.profile.timeGame).toBe(7);
    expect(f.client.frameTimings).toEqual({ frontEndMsec: 11, backEndMsec: 13 });
  });

  test("live toggles retain zero unsampled boundaries and suppress unrequested clock reads", async () => {
    const f = await fixture("client", "+set com_maxfps 0");
    const samples = [20, 30, 40, 50];
    f.platform.milliseconds = () => {
      const value = samples.shift();
      if (value === undefined) throw new Error("Unexpected timing sample");
      return value;
    };
    f.driver.common.commands.append("set com_speeds 1\n");
    await f.driver.frame();
    expect(f.trace).toContain("print:frame:0 all: 30 sv: 10 ev: 30 cl: 10 gm:  0 rf:  0 bk:  0\n");
    expect(samples).toEqual([]);
    f.driver.common.cvars.set("com_speeds", "0", true);
    await f.driver.frame();
    f.driver.common.cvars.set("com_speeds", "1", true);
    f.platform.milliseconds = () => 90;
    f.client.frame = async () => { f.driver.common.cvars.set("com_speeds", "0", true); };
    const before = f.trace.filter(text => text.startsWith("print:frame:")).length;
    await f.driver.frame();
    expect(f.trace.filter(text => text.startsWith("print:frame:"))).toHaveLength(before);
  });

  test("dedicated reports source zero client timestamps and available client retained times", async () => {
    for (const profile of ["dedicated", "client"] satisfies readonly ("dedicated" | "client")[]) {
      const f = await fixture(profile, "+set dedicated 1 +set com_speeds 1");
      const samples = [100, 120];
      f.platform.milliseconds = () => {
        const value = samples.shift();
        if (value === undefined) throw new Error("Dedicated frame sampled client timing");
        return value;
      };
      f.server.profile.timeGame = 7; f.client.frameTimings.frontEndMsec = 11; f.client.frameTimings.backEndMsec = 13;
      await f.driver.frame();
      expect(f.trace).toContain(profile === "dedicated"
        ? "print:frame:0 all:-120 sv:-127 ev: 20 cl:  0 gm:  7 rf:  0 bk:  0\n"
        : "print:frame:0 all:-120 sv:-127 ev: 20 cl:-24 gm:  7 rf: 11 bk: 13\n");
      expect(samples).toEqual([]);
    }
  });

  test("frame timing subtraction preserves signed clock wrap", async () => {
    const f = await fixture("client", "+set com_speeds 1 +set com_maxfps 0");
    const samples = [2147483640, 2147483645, -2147483645, -2147483640, -2147483630];
    f.platform.milliseconds = () => {
      const value = samples.shift();
      if (value === undefined) throw new Error("Unexpected wrapped timing sample");
      return value;
    };
    await f.driver.frame();
    expect(f.trace).toContain("print:frame:0 all: 21 sv:  6 ev: 10 cl: 10 gm:  0 rf:  0 bk:  0\n");
  });

  test("speed report print failure precedes trace reads, resets and frame number advancement", async () => {
    const f = await fixture("dedicated", "+set com_speeds 1 +set com_showtrace 1"), common = f.driver.common;
    const print = common.output.print.bind(common.output);
    common.collisionCounters.c_traces = 29;
    common.output.print = text => {
      if (text.startsWith("frame:")) throw new CommonError("drop", "speed print failed");
      print(text);
    };
    expect(await f.driver.frame()).toMatchObject({ kind: "aborted", frameNumber: 0, code: "drop" });
    expect(common.collisionCounters.c_traces).toBe(29);
    expect(f.trace.some(text => text.includes(" traces "))).toBe(false);
    common.output.print = text => {
      print(text);
      if (text.startsWith("frame:")) common.cvars.set("com_showtrace", "0", true);
    };
    expect(await f.driver.frame()).toMatchObject({ kind: "frame", frameNumber: 1 });
    expect(common.collisionCounters.c_traces).toBe(29);
  });

  test("times network and server loopback packets and rereads controls after callbacks", async () => {
    const f = await fixture("dedicated", "+set com_speeds 3"), common = f.driver.common;
    common.cvars.set("sv_running", "1", true);
    const samples = [10, 20, 25, 30, 39, 40];
    f.platform.milliseconds = () => {
      const value = samples.shift();
      if (value === undefined) throw new Error("Unexpected packet timing sample");
      return value;
    };
    f.platform.enqueue(common.eventMemory.packet(1, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, Uint8Array.of(1)));
    f.driver.loopback.send("client", Uint8Array.of(2));
    await f.driver.frame();
    expect(f.trace.filter(text => text.startsWith("print:SV_PacketEvent")))
      .toEqual(["print:SV_PacketEvent time: 5\n", "print:SV_PacketEvent time: 9\n"]);
    expect(samples).toEqual([]);

    common.cvars.set("com_speeds", "0", true);
    f.server.packetEvent = async () => { common.cvars.set("com_speeds", "3", true); };
    f.platform.milliseconds = () => 77;
    f.driver.loopback.send("client", Uint8Array.of(3));
    await f.driver.frame();
    expect(f.trace).toContain("print:SV_PacketEvent time: 77\n");
  });

  test("print failures retain counters and frame number; successful callbacks reset even newly added counts", async () => {
    const f = await fixture("dedicated", "+set com_showtrace 1"), common = f.driver.common;
    const print = common.output.print.bind(common.output);
    common.collisionCounters.c_traces = 9;
    common.output.print = text => {
      if (text.includes(" traces ")) throw new CommonError("drop", "trace print failed");
      print(text);
    };
    expect(await f.driver.frame()).toMatchObject({ kind: "aborted", frameNumber: 0, code: "drop" });
    expect(common.collisionCounters.c_traces).toBe(9);
    common.output.print = text => {
      print(text);
      if (text.includes(" traces ")) {
        common.collisionCounters.c_traces = 33; common.collisionCounters.c_pointcontents = 44;
        common.cvars.set("com_showtrace", "0", true);
      }
    };
    expect(await f.driver.frame()).toMatchObject({ kind: "frame", frameNumber: 1 });
    expect(f.trace).toContain("print:   9 traces  (0b 0p)    0 points\n");
    expect(common.collisionCounters).toMatchObject({ c_traces: 0, c_brush_traces: 0, c_patch_traces: 0, c_pointcontents: 0 });
    common.collisionCounters.c_traces = 17;
    await f.driver.frame();
    expect(common.collisionCounters.c_traces).toBe(17);
  });

  test("aborted packet callbacks skip end sampling, reports and collision reset", async () => {
    const f = await fixture("dedicated", "+set com_speeds 3 +set com_showtrace 1"), common = f.driver.common;
    common.cvars.set("sv_running", "1", true); common.collisionCounters.c_traces = 9;
    let samples = 0;
    f.platform.milliseconds = () => { samples++; return 1000; };
    f.server.packetEvent = async () => { throw new CommonError("drop", "packet timed abort"); };
    f.driver.loopback.send("client", Uint8Array.of(3));
    expect(await f.driver.frame()).toMatchObject({ kind: "aborted", frameNumber: 0, code: "drop" });
    expect(samples).toBe(3); // First events, packet start, then Com_Error.
    expect(f.trace.some(text => text.startsWith("print:SV_PacketEvent") || text.startsWith("print:frame:"))).toBe(false);
    expect(common.collisionCounters.c_traces).toBe(9);
  });
});

describe("common event payload lifetimes", () => {
  test("nested event pumps keep independent packet scratch while an outer packet is borrowed", async () => {
    const f = await fixture("dedicated"), common = f.driver.common;
    common.cvars.set("sv_running", "1", true);
    const address: ServerPacketAddress = { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 };
    const seen: number[][] = [];
    f.server.packetEvent = async (_from, payload) => {
      seen.push([...payload]);
      if (payload[0] === 1) {
        f.platform.enqueue(common.eventMemory.packet(1, address, Uint8Array.of(2, 3)));
        await f.driver.pumpForDownloadsComplete();
        expect([...payload]).toEqual([1, 4]);
      }
    };
    f.platform.enqueue(common.eventMemory.packet(1, address, Uint8Array.of(1, 4)));
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(seen).toEqual([[1, 4], [2, 3]]);
    common.mainZone.checkHeap();
  });

  test("normal console and awaited packet dispatch free their actual common-zone payloads", async () => {
    const f = await fixture("dedicated"), common = f.driver.common, memory = common.eventMemory, zone = common.mainZone;
    const available = zone.memoryRemaining(), console = memory.console(1, "echo retained"), input = Uint8Array.of(3, 4, 5);
    const packet = memory.packet(1, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, input);
    const stored = memory.payload(packet);
    if (stored === null) throw new Error("Packet allocation was not retained");
    common.cvars.set("sv_running", "1", true);
    f.server.packetEvent = async (from, payload) => {
      expect(from).toEqual(packet.from); expect(payload).toEqual(input);
      expect(payload.buffer).not.toBe(stored.buffer);
      expect(zone.memoryRemaining()).toBe(available - 48);
      stored[20] = 9;
      await Promise.resolve();
      expect(payload).toEqual(input); expect(packet.payload).toEqual(Uint8Array.of(9, 4, 5));
    };
    f.platform.enqueue(console); f.platform.enqueue(packet);
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(() => console.text).toThrow("no longer valid"); expect(() => packet.payload).toThrow("no longer valid");
    expect(zone.memoryRemaining()).toBe(available); zone.checkHeap();
  });

  test("dropsim frees without dereferencing a packet address", async () => {
    const f = await fixture("dedicated"), common = f.driver.common, memory = common.eventMemory, zone = common.mainZone;
    const available = zone.memoryRemaining(), packet = memory.packet(1, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, Uint8Array.of(7));
    const bytes = memory.payload(packet);
    if (bytes === null) throw new Error("Packet allocation was not retained");
    bytes[0] = 99; common.cvars.set("com_dropsim", "2", true); f.platform.enqueue(packet);
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(zone.memoryRemaining()).toBe(available); expect(() => packet.from).toThrow("no longer valid");
    expect(f.trace).not.toContain("server:packet");
  });

  test("an awaited source dispatch abort leaves its event allocation alive until final disposal", async () => {
    const f = await fixture("dedicated"), common = f.driver.common, memory = common.eventMemory, zone = common.mainZone;
    const available = zone.memoryRemaining(), packet = memory.packet(1, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, Uint8Array.of(7));
    common.cvars.set("sv_running", "1", true);
    f.server.packetEvent = async () => { await Promise.resolve(); throw new CommonError("drop", "packet dispatch aborted"); };
    f.platform.enqueue(packet);
    expect(await f.driver.frame()).toMatchObject({ kind: "aborted", code: "drop", message: "packet dispatch aborted" });
    expect(packet.payload).toEqual(Uint8Array.of(7)); expect(zone.memoryRemaining()).toBe(available - 48);
    await f.driver.close(); expect(() => packet.payload).toThrow("no longer valid");
  });

  test("oversized event packets keep the source continue-path allocation while later events dispatch", async () => {
    const f = await fixture("dedicated"), common = f.driver.common, memory = common.eventMemory, zone = common.mainZone;
    const available = zone.memoryRemaining(), packet = memory.packet(1, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, new Uint8Array(16385));
    const afterPacket = zone.memoryRemaining(), console = memory.console(1, "echo after oversize");
    f.platform.enqueue(packet); f.platform.enqueue(console);
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(f.trace).toContain("print:Com_EventLoop: oversize packet\n");
    expect(f.trace).not.toContain("server:packet"); expect(() => console.text).toThrow("no longer valid");
    expect(packet.payload).toHaveLength(16385); expect(zone.memoryRemaining()).toBe(afterPacket);
    expect(afterPacket).toBeLessThan(available);
  });

  test("journal replay reads into the allocated zone block and recording preserves its unused address bytes", async () => {
    const f = await fixture("dedicated"), common = f.driver.common, memory = common.eventMemory, zone = common.mainZone;
    const available = zone.memoryRemaining(), packet = memory.packet(1, { kind: "ipv4", host: [127, 0, 0, 1], port: 27960 }, Uint8Array.of(3, 4, 5));
    const bytes = memory.payload(packet);
    if (bytes === null) throw new Error("Packet allocation was not retained");
    bytes[8] = 0x71; bytes[17] = 0x92;
    const expected = bytes.slice(), recordCvars = new CvarRegistry(); recordCvars.set("journal", "1");
    const record = new CommonJournal(recordCvars, () => common.files, () => undefined, () => undefined, () => undefined, memory);
    record.initialize(); expect(record.getEvent({ getEvent: () => packet })).toBe(packet); record.shutdown(); record.retire();
    expect([...readFileSync(Buffer.concat([common.roots.homePath.resolvedBytes(), Buffer.from("/baseq3/journal.dat")])).subarray(32)]).toEqual([...expected]);
    const replayCvars = new CvarRegistry(); replayCvars.set("journal", "2");
    const replay = new CommonJournal(replayCvars, () => common.files, () => undefined, () => undefined, () => undefined, memory);
    replay.initialize();
    const restored = replay.getEvent({ getEvent: () => { throw new Error("Replay polled the system event source"); } });
    expect(zone.memoryRemaining()).toBe(available - 96); expect(memory.payload(restored)).toEqual(expected);
    if (restored.kind !== "packet") throw new Error("Journal did not restore a packet event");
    expect(restored.from).toEqual(packet.from); expect(restored.payload).toEqual(packet.payload);
    const retained = memory.payload(restored);
    if (retained === null) throw new Error("Replay allocation was not retained");
    retained[20] = 8; expect(restored.payload).toEqual(Uint8Array.of(8, 4, 5)); expect(packet.payload).toEqual(Uint8Array.of(3, 4, 5));
    memory.free(packet); memory.free(restored); expect(zone.memoryRemaining()).toBe(available); zone.checkHeap();
    replay.shutdown(); replay.retire();
  });

  test("a short journal payload read retains the source allocation while a short header allocates nothing", async () => {
    for (const shortHeader of [true, false]) {
      const f = await fixture("dedicated"), common = f.driver.common, zone = common.mainZone;
      const header = new Uint8Array(shortHeader ? 31 : 33);
      if (!shortHeader) {
        const view = new DataView(header.buffer); view.setInt32(4, 5, true); view.setInt32(16, 63, true); header[32] = 101;
      }
      const events = common.files.writable.openBinaryWrite("journal.dat"), data = common.files.writable.openBinaryWrite("journaldata.dat");
      if (events === null || data === null) throw new Error("Could not write authored journal files");
      events.writeBytes(header); events.close(); data.close();
      const cvars = new CvarRegistry(); cvars.set("journal", "2");
      const journal = new CommonJournal(cvars, () => common.files, () => undefined, () => undefined, () => undefined, common.eventMemory);
      journal.initialize(); const available = zone.memoryRemaining();
      expect(() => journal.getEvent({ getEvent: () => { throw new Error("Replay polled the system event source"); } })).toThrow("Error reading from journal file");
      expect(zone.memoryRemaining()).toBe(available - (shortHeader ? 0 : 88));
      journal.shutdown(); journal.retire(); zone.checkHeap();
    }
  });
});

describe("common source initialization and frame chronology", () => {
  test("source version banner precedes key bootstrap and filesystem startup", async () => {
    for (const profile of ["dedicated", "client"] satisfies readonly ("dedicated" | "client")[]) {
      const f = await fixture(profile);
      expect(f.trace[0]).toBe("print:Q3 1.32b linux-ts common-frame-test\n");
      expect(f.trace.indexOf("print:----- FS_Startup -----\n")).toBeGreaterThan(0);
      expect(f.driver.common.cvars.get("version")?.value).toBe("Q3 1.32b linux-ts common-frame-test");
      expect(f.trace.filter(value => value.includes("Q3 1.32b"))).toEqual(["print:Q3 1.32b linux-ts common-frame-test\n"]);
    }
  });
  test("partial construction runs only deferred concrete cleanups in LIFO order before common platform cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "q3-common-frame-partial-")); homes.push(root);
    const dataPath = join(root, "data"), homePath = join(root, "home"), trace: string[] = [];
    mkdirSync(join(dataPath, "baseq3"), { recursive: true }); mkdirSync(join(homePath, "baseq3"), { recursive: true });
    writeFileSync(join(dataPath, "baseq3", "default.cfg"), "\n");
    writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
    const platform = new RecorderPlatform(trace), failure = new Error("server factory failed");
    await expect(CommonFrameDriver.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startupText: "", buildDate: "partial-test", build: { kind: "dedicated" }, platformPrint: () => undefined,
      client: { kind: "absent" }, systemClock: platform, createPlatform: () => platform,
      createServer: async services => {
        services.deferCleanup(() => { trace.push("cleanup:first"); });
        services.deferCleanup(async () => { trace.push("cleanup:second"); });
        throw failure;
      }, resolveCommand: () => undefined })).rejects.toBe(failure);
    expect(trace).toEqual(["cleanup:second", "cleanup:first", "platform:close"]);
  });

  test("a dedicated binary retains raw dedicated zero through null_client initialization and both command drains", async () => {
    const f = await fixture("dedicated", "+set dedicated 0 +set fixedtime 7 +set com_maxfps 1000");
    expect(f.driver.common.cvars.get("dedicated")?.integerValue).toBe(0);
    expect(f.driver.common.cvars.get("cl_shownet")?.flags).toBe(CvarFlag.Temporary);
    const commands: string[] = [];
    f.driver.common.commands.register("first", () => { commands.push("first"); });
    f.driver.common.commands.register("second", () => { commands.push("second"); });
    f.platform.enqueue({ kind: "console", time: 1, text: "first" });
    const original = f.server.frame.bind(f.server);
    f.server.frame = async milliseconds => { await original(milliseconds); f.server.enqueueSecondDrain("second"); };
    const result = await f.driver.frame();
    expect(result).toEqual({ kind: "frame", frameNumber: 1, frameTime: 1, rawMilliseconds: 1, modifiedMilliseconds: 7 });
    expect(commands).toEqual(["first", "second"]);
    expect(f.trace.filter(value => value.startsWith("server:frame") || value.startsWith("show:"))).toEqual([
      "show:0:false", "show:0:false", "server:frame:7",
    ]);
  });

  test("client source order drains commands around server frame and attempts Linux client shutdown twice on quit", async () => {
    const f = await fixture("client", "+set fixedtime 3");
    f.trace.length = 0;
    const commands: string[] = [];
    f.driver.common.commands.register("first", () => { commands.push("first"); });
    f.driver.common.commands.register("second", () => { commands.push("second"); });
    f.platform.enqueue({ kind: "console", time: 1, text: "first" });
    const original = f.server.frame.bind(f.server);
    f.server.frame = async milliseconds => { await original(milliseconds); f.server.enqueueSecondDrain("second"); };
    expect(await f.driver.run({ kind: "frames", count: 1 })).toEqual({ kind: "frame-limit", frames: 1 });
    expect(commands).toEqual(["first", "second"]);
    expect(f.trace.filter(value => value.startsWith("server:") || value.startsWith("client:") || value === "platform:close")).toEqual([
      "server:frame:3", "client:frame:3", "server:command-shutdown:Server quit\n", "client:shutdown", "client:shutdown", "platform:close",
    ]);
  });

  test("integer-zero dedicated mode paces as client while nonzero numeric mode suppresses modified viewlog", async () => {
    const f = await fixture("dedicated", "+set dedicated 0.5 +set com_maxfps 1000");
    f.trace.length = 0;
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(f.trace.filter(value => value.startsWith("show:"))).toEqual([]);
  });
});

describe("common recoverable error entry", () => {
  test("pure clearing is safe for the configured filesystem owner before its first mount", async () => {
    const cvars = new CvarRegistry(), sound = new SoundOutput(), trace: string[] = [];
    cvars.register("developer", "1");
    const files = new CommonFileState(initializationRoots(), text => { trace.push(text); }, sound, cvars);
    try {
      await files.setServerLoadedPaks("", "", () => { trace.push("owner-check"); });
      expect(files.initialized).toBe(false);
      expect(files.serverLoadedPaks).toEqual([]);
      expect(trace).toEqual(["owner-check"]);
    } finally { files.close(); sound.close(); }
  });

  for (const code of ["server-disconnect", "drop", "disconnect", "need-cd", "fatal"] satisfies readonly CommonErrorCode[]) {
    test(`${code} clears the actual loaded restriction before the error clock and cleanup`, async () => {
      const f = await fixture("client", "+set dedicated 1"), common = f.driver.common, files = common.files;
      const mounted = files.current, error = new CommonError(code, "pure owner error");
      writeFileSync(Buffer.concat([common.roots.dataPath.resolvedBytes(), Buffer.from("/baseq3/local.txt")]), "local asset");
      const assertCurrentOperation = (): void => { f.driver.assertCurrentOperation(); };
      f.server.frame = async () => {
        await files.setServerLoadedPaks("123", "remote/pak", assertCurrentOperation);
        files.setServerReferencedPaks("456", "remote/referenced");
        expect(files.serverLoadedPaks).toEqual([{ checksum: 123, name: "remote/pak" }]);
        expect(files.current.fileLength("local.txt")).toBe(-1);
        throw error;
      };
      f.platform.milliseconds = () => {
        expect(files.serverLoadedPaks).toEqual([]);
        expect(files.serverReferencedPaks).toEqual([{ checksum: 456, name: "remote/referenced" }]);
        expect(files.current).toBe(mounted);
        expect(new TextDecoder().decode(files.current.readSync("local.txt"))).toBe("local asset");
        f.trace.push("error-clock");
        return 1000;
      };
      f.trace.length = 0;
      if (code === "fatal") await expect(f.driver.frame()).rejects.toBe(error);
      else expect(await f.driver.frame()).toMatchObject({ kind: "aborted", code, message: error.message });
      const sequence = f.trace.filter(value => value === "client:pure-clear" || value === "error-clock"
        || value.startsWith("server:shutdown") || value.startsWith("client:disconnect") || value === "client:shutdown");
      expect(sequence.slice(0, 2)).toEqual(["client:pure-clear", "error-clock"]);
      expect(sequence.length).toBeGreaterThan(2);
    });
  }

  test("Com_Error awaits actual pure search-order restart before the clock and disconnect", async () => {
    const f = await fixture("client", "+set developer 1 +set dedicated 1"), common = f.driver.common, files = common.files;
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    for (const { name, value } of [{ name: "pak-a", value: "low" }, { name: "pak-z", value: "high" }]) {
      const entries = [
        { name: encoder.encode("productid.txt"), data: encoder.encode(SOURCE_PRODUCT_ID), method: 0, utf8: false },
        { name: encoder.encode("default.cfg"), data: encoder.encode("\n"), method: 0, utf8: false },
        { name: encoder.encode("shared.txt"), data: encoder.encode(value), method: 0, utf8: false },
      ] satisfies Parameters<typeof sourceZip>[0];
      writeFileSync(Buffer.concat([common.roots.dataPath.resolvedBytes(), Buffer.from(`/baseq3/${name}.pk3`)]), sourceZip(entries));
    }
    const assertCurrentOperation = (): void => { f.driver.assertCurrentOperation(); };
    let checkedClock = false;
    f.server.frame = async () => {
      await files.restart({ checksumFeed: 313, random: () => 0 }, assertCurrentOperation);
      expect(decoder.decode(files.current.readSync("shared.txt"))).toBe("high");
      const low = files.current.pakReferences.snapshot().find(row => row.pack.basename === "pak-a")?.pack;
      if (low === undefined) throw new Error("Missing actual pure package");
      await files.setServerLoadedPaks(String(low.checksum | 0), "baseq3/pak-a", assertCurrentOperation);
      await files.restart({ checksumFeed: 313, random: () => 0 }, assertCurrentOperation);
      const reordered = files.current;
      expect(reordered.pureReordered).toBe(true);
      expect(decoder.decode(reordered.readSync("shared.txt"))).toBe("low");
      f.trace.length = 0;
      f.platform.milliseconds = () => {
        checkedClock = true;
        expect(files.serverLoadedPaks).toEqual([]);
        expect(files.current).not.toBe(reordered);
        expect(() => reordered.fileLength("shared.txt")).toThrow("retired");
        expect(files.current.pakReferences.checksumFeed).toBe(313);
        expect(decoder.decode(files.current.readSync("shared.txt"))).toBe("high");
        f.trace.push("error-clock");
        return 1000;
      };
      throw new CommonError("drop", "pure reordered error");
    };
    expect(await f.driver.frame()).toMatchObject({ kind: "aborted", code: "drop", message: "pure reordered error" });
    expect(checkedClock).toBe(true);
    expect(f.trace.filter(value => value === "print:FS search reorder is required\n" || value === "client:pure-clear"
      || value === "error-clock" || value.startsWith("server:shutdown") || value.startsWith("client:disconnect") || value === "client:flush"))
      .toEqual(["print:FS search reorder is required\n", "client:pure-clear", "error-clock",
        "server:shutdown:common-error:Server crashed: pure reordered error\n", "client:disconnect:true", "client:flush"]);
  });

  test("a published com_buildScript binding escalates through the fatal branch while preserving primary identity", async () => {
    const f = await fixture("dedicated", "+set com_buildScript 1"), first = new CommonError("drop", "build script error");
    f.trace.length = 0; f.server.frameError = first;
    await expect(f.driver.frame()).rejects.toBe(first);
    expect(f.trace.some(text => text.includes("ERROR:"))).toBe(false);
    expect(f.trace).toContain("server:shutdown:common-error:Server fatal crashed: build script error\n");
    expect(f.platform.closed).toBe(true);
  });
  test("need-CD reads cl_running after actual source server shutdown rather than caching it at error entry", async () => {
    let dialogs = 0;
    const f = await fixture("client", "+set dedicated 1", { kind: "available", show: async () => { dialogs++; } });
    expect(f.driver.common.cvars.get("cl_running")?.integerValue).toBe(0);
    f.server.shutdown = async () => { f.driver.common.cvars.set("cl_running", "1", true); };
    f.server.frameError = new CommonError("need-cd", "late client availability");
    expect((await f.driver.frame()).kind).toBe("aborted");
    expect(dialogs).toBe(1);
    expect(f.trace).toContain("client:disconnect:true"); expect(f.trace).toContain("client:flush");
  });
  test("fatal error preserves common cleanup order and the literal second Linux client-shutdown attempt", async () => {
    const f = await fixture("client", "+set fixedtime 2");
    f.trace.length = 0;
    f.server.frameError = new CommonError("fatal", "terminal failure");
    await expect(f.driver.frame()).rejects.toThrow("terminal failure");
    expect(f.trace.filter(value => value.startsWith("client:") || value.startsWith("server:shutdown") || value === "platform:close")).toEqual([
      "client:pure-clear", "client:shutdown", "server:shutdown:common-error:Server fatal crashed: terminal failure\n", "client:shutdown", "platform:close",
    ]);
  });

  test("client drop resets pure state and preserves source server-disconnect-flush order without closing common", async () => {
    const f = await fixture("client", "+set fixedtime 2");
    f.trace.length = 0;
    f.server.frameError = new CommonError("drop", "bad snapshot");
    expect(await f.driver.frame()).toEqual({ kind: "aborted", frameNumber: 0, code: "drop", message: "bad snapshot" });
    expect(f.trace.filter(value => value.startsWith("client:") || value.startsWith("server:shutdown"))).toEqual([
      "client:pure-clear", "server:shutdown:common-error:Server crashed: bad snapshot\n", "client:disconnect:true", "client:flush",
    ]);
    expect(f.platform.closed).toBe(false);
    expect((await f.driver.frame()).kind).toBe("frame");
  });

  test("need-CD with cl_running zero leaves error entry set and a subsequent error becomes terminal", async () => {
    const f = await fixture("dedicated", "+set dedicated 0");
    f.server.frameError = new CommonError("need-cd", "missing media");
    expect(await f.driver.frame()).toEqual({ kind: "aborted", frameNumber: 0, code: "need-cd", message: "missing media" });
    f.server.frameError = new CommonError("drop", "later drop");
    await expect(f.driver.frame()).rejects.toThrow("recursive error after: missing media");
    expect(f.trace.filter(value => value.startsWith("server:shutdown"))).toEqual([
      "server:shutdown:common-error:Server didn't have CD\n",
    ]);
    expect(f.platform.closed).toBe(true);
  });

  for (const terminal of ["quit", "close", "recursive-error"] satisfies readonly string[]) {
    test(`entered-error ${terminal} skips common/server cleanup and attempts only Unix client shutdown`, async () => {
      const f = await fixture("client", "+set dedicated 1");
      f.server.frameError = new CommonError("need-cd", "missing media");
      expect((await f.driver.frame()).kind).toBe("aborted");
      f.trace.length = 0;
      const close = f.driver.common.close.bind(f.driver.common);
      f.driver.common.close = () => { f.trace.push("common:close"); close(); };
      if (terminal === "recursive-error") {
        f.server.frameError = new CommonError("drop", "later drop");
        await expect(f.driver.frame()).rejects.toThrow("recursive error after: missing media");
      } else if (terminal === "quit") {
        f.platform.enqueue({ kind: "console", time: 2, text: "quit; echo forbidden" });
        expect(await f.driver.frame()).toEqual({ kind: "quit", frames: 0 });
      } else await f.driver.close();
      expect(f.trace.filter(value => value === "client:shutdown" || value.includes("shutdown:") || value === "common:close" || value === "platform:close"))
        .toEqual(terminal === "close" ? ["client:shutdown", "platform:close", "common:close"] : ["client:shutdown", "platform:close"]);
      expect(f.trace.some(value => value.includes("forbidden"))).toBe(false);
      expect(f.platform.closed).toBe(true);
      const trace = [...f.trace];
      await f.driver.close();
      expect(f.trace).toEqual(terminal === "close" ? trace : [...trace, "server:dispose", "client:dispose", "common:close"]);
      const disposedTrace = [...f.trace];
      await f.driver.close(); expect(f.trace).toEqual(disposedTrace);
      await expect(f.driver.frame()).rejects.toThrow("closed");
    });
  }

  test("an error raised during drop cleanup enters Sys_Error without repeating partial server/common cleanup", async () => {
    const f = await fixture("client", "+set fixedtime 2");
    f.trace.length = 0;
    const close = f.driver.common.close.bind(f.driver.common);
    f.driver.common.close = () => { f.trace.push("common:close"); close(); };
    f.server.shutdown = async request => {
      f.trace.push(`server:shutdown:${request.kind}`);
      throw new CommonError("drop", "cleanup failed");
    };
    f.server.frameError = new CommonError("drop", "first failure");
    await expect(f.driver.frame()).rejects.toThrow("recursive error after: first failure");
    expect(f.trace.filter(value => value === "client:shutdown" || value.startsWith("server:shutdown") || value === "common:close" || value === "platform:close"))
      .toEqual(["server:shutdown:common-error", "client:shutdown", "platform:close"]);
  });

  test("error timing reads only Sys_Milliseconds and leaves pending input acquisition to the next frame", async () => {
    const f = await fixture("dedicated");
    let readsAtFailure = 0;
    f.driver.common.commands.register("late_marker", () => { f.trace.push("late-marker"); });
    f.server.frame = async () => {
      f.platform.enqueue({ kind: "console", time: f.platform.time, text: "late_marker" });
      readsAtFailure = f.platform.eventReads;
      throw new CommonError("drop", "clock probe");
    };
    expect((await f.driver.frame()).kind).toBe("aborted");
    expect(f.platform.eventReads).toBe(readsAtFailure);
    expect(f.platform.clockReads).toBe(1);
    expect(f.trace).not.toContain("late-marker");
    f.server.frame = async () => undefined;
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(f.trace.filter(value => value === "late-marker")).toHaveLength(1);
  });

  test("error timing does not overflow a full Com_Milliseconds pushed-event ring", async () => {
    const f = await fixture("dedicated");
    f.server.frame = async () => {
      for (let index = 0; index < MAX_COMMON_PUSHED_EVENTS; index++) {
        f.platform.enqueue({ kind: "console", time: 1, text: `queued_${index}` });
      }
      f.driver.events.milliseconds();
      f.platform.enqueue({ kind: "console", time: 1, text: "later_input" });
      throw new CommonError("drop", "full ring");
    };
    expect((await f.driver.frame()).kind).toBe("aborted");
    expect(f.trace.some(value => value.includes("Com_PushEvent overflow"))).toBe(false);
    for (let index = 0; index < MAX_COMMON_PUSHED_EVENTS; index++) {
      expect(f.driver.events.getEvent()).toEqual({ kind: "console", time: 1, text: `queued_${index}` });
    }
    let later = 0;
    f.driver.common.commands.register("later_input", () => { later++; });
    f.server.frame = async () => undefined;
    expect((await f.driver.frame()).kind).toBe("frame");
    expect(later).toBe(1);
  });

  for (const failurePoint of ["client", "server", "common"] satisfies readonly string[]) {
    test(`a CommonError during fatal ${failurePoint} shutdown bypasses remaining common teardown`, async () => {
      const f = await fixture("client", "+set fixedtime 2");
      f.trace.length = 0;
      const close = f.driver.common.close.bind(f.driver.common);
      const shutdown = f.client.shutdown.bind(f.client);
      const commonShutdown = f.driver.common.shutdown.bind(f.driver.common);
      let failed = false;
      const failOnce = (point: string): void => {
        if (!failed && point === failurePoint) { failed = true; throw new CommonError("drop", "nested shutdown failure"); }
      };
      f.client.shutdown = async () => { await shutdown(); failOnce("client"); };
      f.server.shutdown = async () => { f.trace.push("server:shutdown"); failOnce("server"); };
      f.driver.common.shutdown = () => { f.trace.push("common:shutdown"); failOnce("common"); commonShutdown(); };
      f.driver.common.close = () => { f.trace.push("common:close"); close(); };
      f.server.frameError = new CommonError("fatal", "original fatal");
      await expect(f.driver.frame()).rejects.toThrow("recursive error after: original fatal");
      const actual = f.trace.filter(value => value === "client:shutdown" || value === "server:shutdown" || value === "common:shutdown" || value === "platform:close");
      const expected: typeof actual = ["client:shutdown"];
      if (failurePoint !== "client") expected.push("server:shutdown");
      if (failurePoint === "common") expected.push("common:shutdown");
      expected.push("client:shutdown", "platform:close");
      expect(actual).toEqual(expected);
      const trace = [...f.trace];
      await f.driver.close();
      expect(f.trace).toEqual([...trace, "server:dispose", "client:dispose", "common:close"]);
    });
  }

  test("error escalation uses direct clock 99ms and 100ms boundaries independently of event timestamps", async () => {
    for (const interval of [99, 100]) {
      const f = await fixture("dedicated");
      for (let index = 0; index < 5; index++) {
        f.platform.time = (index + 1) * 1000;
        f.platform.clockTime = 1000 + index * interval;
        f.server.frameError = new CommonError("drop", `error ${index}`);
        if (interval === 99 && index === 4) await expect(f.driver.frame()).rejects.toThrow("error 4");
        else expect((await f.driver.frame()).kind).toBe("aborted");
      }
      expect(f.platform.clockReads).toBe(5);
      expect(f.platform.closed).toBe(interval === 99);
    }
  });
});
