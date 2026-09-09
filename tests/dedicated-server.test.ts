import { createProtocolClientSession, transmitProtocolClient } from "../tools/client-protocol-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { DedicatedServerHost } from "../src/engine/dedicated-server.ts";
import type { DedicatedHostOptions } from "../src/engine/dedicated-server.ts";
import { modifyCommonMilliseconds } from "../src/engine/common-frame.ts";
import { CommonError } from "../src/core/common-error.ts";
import type { CommonErrorCode } from "../src/core/common-error.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { encodeConnect, encodeConnectionlessText, decodeConnectionless } from "../src/protocol/connectionless.ts";
import { UdpTransport } from "../src/platform/network.ts";
import { ServerClientPhase } from "../src/server/state.ts";
import { Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/.local/share/Steam/steamapps/common/Quake 3 Arena";
const homes: string[] = [], hosts: DedicatedServerHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true });
});

async function fixture(product: Product = "baseq3", commands = "", humanOnly = true,
  onPrint?: (text: string) => undefined) {
  const homePath = mkdtempSync(join(tmpdir(), "q3-dedicated-host-")); homes.push(homePath);
  const stdin = new PassThrough(), printed: string[] = [], clock = { wall: 1000000 };
  const options: DedicatedHostOptions = { roots: { dataPath, homePath, cdPath: null, product },
    startupText: `+set dedicated 1 +set net_ip 127.0.0.1 +set net_port 0 +set sv_pure 0 +set sv_maxclients 2 +set fixedtime 50 ${humanOnly ? "+set bot_enable 0" : ""} ${commands}`,
    buildDate: "dedicated-host-test", print: text => { onPrint?.(text); printed.push(text); },
    bots: { kind: "unavailable", reason: "Real game bot AI is not available in this test" },
    systemClock: new UnixSystemClock(() => clock.wall++), input: { stdin, signals: "none" } };
  const host = await DedicatedServerHost.open(options); hosts.push(host);
  return { host, options, homePath, stdin, printed, clock };
}
function running(host: DedicatedServerHost) {
  const state = host.server.state;
  if (state.kind !== "running") throw new Error("Expected actual running dedicated map");
  const game = state.world.game;
  if (!(game instanceof GameRuntime)) throw new Error("Expected direct TypeScript dedicated game");
  return { ...state, game };
}
function ownedDescriptors(homePath: string): string[] {
  const paths: string[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    let target: string;
    try { target = readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
    if (target.startsWith(`${homePath}/`)) paths.push(target);
  }
  return paths.sort();
}
function deferred() {
  let finish: () => void = () => { throw new Error("Uninitialized deferred"); };
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, finish };
}
async function receive(peer: UdpTransport) {
  const deadline = performance.now() + 2000;
  while (peer.statistics.pending === 0) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for real dedicated UDP output");
    await Bun.sleep(1);
  }
  const packet = peer.poll();
  if (packet === null) throw new Error("Missing dedicated UDP packet");
  if (packet.kind === "error") throw packet.error;
  return packet;
}

describe("dedicated common timing binary32 profile", () => {
  test("retains source fixedtime/timescale/camera ordering, hitches and dedicated clamps", () => {
    const modify = (rawMilliseconds: number, fixedTime = 0, timeScale = 1, cameraMode = 0) =>
      modifyCommonMilliseconds({ rawMilliseconds, fixedTime, timeScale, cameraMode, dedicated: true, localServer: true });
    expect(modify(10, 0, 0.7)).toEqual({ milliseconds: 7, hitchMilliseconds: null });
    expect(modify(100, 0, 0.7)).toEqual({ milliseconds: 70, hitchMilliseconds: null });
    expect(modify(10, 3, 0.1)).toEqual({ milliseconds: 3, hitchMilliseconds: null });
    expect(modify(10, 0, 0)).toEqual({ milliseconds: 10, hitchMilliseconds: null });
    expect(modify(10, 0, 0, 1)).toEqual({ milliseconds: 0, hitchMilliseconds: null });
    expect(modify(10, -2, 0)).toEqual({ milliseconds: -2, hitchMilliseconds: null });
    expect(modify(10, -2, 1)).toEqual({ milliseconds: 1, hitchMilliseconds: null });
    expect(modify(1, 0, 0.1)).toEqual({ milliseconds: 1, hitchMilliseconds: null });
    expect(modify(501)).toEqual({ milliseconds: 501, hitchMilliseconds: 501 });
    expect(modify(9000)).toEqual({ milliseconds: 5000, hitchMilliseconds: 9000 });
    expect(modifyCommonMilliseconds({ rawMilliseconds: 9000, fixedTime: 0, timeScale: 1, cameraMode: 0,
      dedicated: false, localServer: true })).toEqual({ milliseconds: 200, hitchMilliseconds: null });
    expect(modifyCommonMilliseconds({ rawMilliseconds: 9000, fixedTime: 0, timeScale: 1, cameraMode: 0,
      dedicated: false, localServer: false })).toEqual({ milliseconds: 5000, hitchMilliseconds: null });
    expect(modify(16777217, 0, 2 ** -24)).toEqual({ milliseconds: 1, hitchMilliseconds: null });
    expect(() => modify(2147483647)).toThrow("Undefined native");
    expect(() => modify(1, 0, NaN)).toThrow("Undefined native");
    expect(() => modify(1, 0, Infinity)).toThrow("Undefined native");
    expect(() => modify(1.5)).toThrow("signed-int");
  });
});

describe("real dedicated common host lifecycle", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const code of ["drop", "disconnect", "fatal"] satisfies readonly CommonErrorCode[]) {
      test(`${product}: actual first ${code} error diagnostic control keeps the original message before explicit disposal`, async () => {
        let armed = false;
        const first = new CommonError(code, "first diagnostic error"), trace: string[] = [];
        const f = await fixture(product, `+map ${product === "baseq3" ? "q3dm1" : "mpteam1"} +set logfile 2`, true, text => {
          if (!armed) return;
          trace.push(text);
          if (text.startsWith("********************\nERROR:")) throw new CommonError("drop", "failed diagnostic");
        });
        await f.host.frame(); const before = running(f.host);
        f.host.common.commands.register("diagnostic_error", () => { throw first; });
        f.host.common.commands.append("diagnostic_error\n"); armed = true;
        if (code === "fatal") await expect(f.host.frame()).rejects.toBe(first);
        else {
          await expect(f.host.frame()).rejects.toThrow("recursive error after: first diagnostic error");
          expect(before.world.game).toBe(before.game);
          expect(ownedDescriptors(f.homePath).some(path => path.endsWith("/games.log"))).toBe(true);
        }
        const sourceTrace = [...trace];
        await f.host.close(); await f.host.close();
        expect(trace).toEqual(sourceTrace); expect(ownedDescriptors(f.homePath)).toEqual([]);
        expect(before.world.game).toBeNull(); f.stdin.destroy();
      });
    }
  }
  for (const point of ["early", "factory", "late", "success"] satisfies readonly string[]) {
    test(`actual host source bot ownership ${point} remains inert until a map opens`, async () => {
      const homePath = mkdtempSync(join(tmpdir(), "q3-host-bot-owner-")); homes.push(homePath);
      const first = new CommonError("fatal", "host initialization primary"), printed: string[] = [];
      const stdin = new PassThrough();
      let observed: unknown;
      try {
        const host = await DedicatedServerHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
          startupText: `+set dedicated 1 +set bot_enable 0 +set sv_pure 0 +set net_port 0 ${point === "factory" ? "+set cl_running 1" : ""}`,
          buildDate: "source-bot-owner", print: text => {
            printed.push(text);
            if (point === "early" && text === "----- FS_Startup -----\n" || point === "late" && text === "--- Common Initialization Complete ---\n") throw first;
          }, bots: { kind: "source" }, input: { stdin, signals: "none" } });
        hosts.push(host);
        expect(point).toBe("success"); expect(host.server.options.bots.kind).toBe("source");
        expect(host.server.state.kind).toBe("stopped");
        await host.close(); await host.close(); expect(host.server.state.kind).toBe("disposed");
      } catch (error) { observed = error; }
      finally { stdin.destroy(); }
      expect(printed.some(text => text === "------- BotLib Initialization -------\n")).toBe(false);
      expect(printed.some(text => text === "Opened log botlib.log\n")).toBe(false);
      expect(ownedDescriptors(homePath)).toEqual([]);
      if (point === "factory") expect(observed).toBeInstanceOf(Error);
      else expect(observed).toBe(point === "success" ? undefined : first);
    });
  }
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const mode of ["normal", "recoverable", "recursive", "fatal"] satisfies readonly string[]) {
      test(`${product}: ${mode} source termination and explicit close release only this host's actual descriptors`, async () => {
        const map = product === "baseq3" ? "q3dm1" : "mpteam1";
        let armed = false;
        const f = await fixture(product, `+map ${map} +set logfile 2`, true, text => {
          if (armed && mode === "recursive" && text.includes("ERROR: descriptor error")) throw new CommonError("drop", "nested descriptor error");
        });
        const other = await fixture(product, `+map ${map} +set logfile 2`);
        await f.host.frame(); await other.host.frame();
        const retained = running(f.host), independent = running(other.host);
        const independentFiles = ownedDescriptors(other.homePath);
        expect(independentFiles.some(path => path.endsWith("/games.log"))).toBe(true);
        expect(independentFiles.some(path => path.endsWith("/qconsole.log"))).toBe(true);
        const first = new CommonError(mode === "fatal" ? "fatal" : "drop", "descriptor error");
        f.host.common.commands.register("descriptor_error", () => { throw first; });
        f.host.common.commands.append(mode === "normal" ? "quit\n" : "descriptor_error\n");
        armed = true;
        if (mode === "fatal") await expect(f.host.frame()).rejects.toBe(first);
        else if (mode === "recursive") await expect(f.host.frame()).rejects.toThrow("recursive error after: descriptor error");
        else expect((await f.host.frame()).kind).toBe(mode === "normal" ? "quit" : "aborted");
        const pending = ownedDescriptors(f.homePath);
        expect(pending.some(path => path.endsWith("/qconsole.log"))).toBe(mode === "recoverable" || mode === "recursive");
        expect(pending.some(path => path.endsWith("/games.log"))).toBe(mode === "recursive");
        if (mode === "recursive") expect(retained.world.game).toBe(retained.game);
        await f.host.close(); await f.host.close();
        expect(retained.world.game).toBeNull();
        expect(ownedDescriptors(f.homePath)).toEqual([]);
        expect(ownedDescriptors(other.homePath)).toEqual(independentFiles);
        expect(running(other.host).game).toBe(independent.game);
        expect((await other.host.frame()).kind).toBe("frame");
        await other.host.close();
        f.stdin.destroy(); other.stdin.destroy();
      });
    }
  }

  for (const entry of ["frame", "limit", "close"] satisfies readonly string[]) {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const code of ["drop", "disconnect", "fatal", "persistent", "persistent-disconnect", "persistent-fatal"] satisfies readonly string[]) {
        test(`${product}: actual first quit ${entry}/${code} preserves source-selected ownership before explicit close`, async () => {
          const first = new CommonError(code.endsWith("fatal") ? "fatal" : code.endsWith("disconnect") ? "disconnect" : "drop", "first quit shutdown error");
          const persistent = code.startsWith("persistent");
          let armed = false, injections = 0;
          const trace: string[] = [];
          const f = await fixture(product, `+map ${product === "baseq3" ? "q3dm1" : "mpteam1"} +set logfile 2`, true, text => {
            if (!armed) return;
            trace.push(text);
            if (text === "----- Server Shutdown -----\n" && (injections === 0 || persistent)) { injections++; throw first; }
          });
          await f.host.frame();
          const before = running(f.host);
          armed = true;
          if (entry === "frame") f.host.common.commands.append("quit; echo forbidden\n");
          let observed: unknown;
          try {
            const outcome = entry === "frame" ? await f.host.frame() : entry === "limit" ? await f.host.run({ kind: "frames", count: 1 }) : await f.host.close();
            if (entry === "frame" && code !== "fatal" && !persistent) expect(outcome?.kind).toBe("aborted");
            else throw new Error("Quit incorrectly fulfilled after source control");
          } catch (error) { observed = error; }
          if (persistent) {
            expect(observed).toBeInstanceOf(CommonError);
            if (!(observed instanceof CommonError)) throw new Error("Expected recursive quit control");
            expect(observed.message).toBe("recursive error after: first quit shutdown error");
            expect(injections).toBe(2);
            if (entry !== "close") expect(before.world.game).toBe(before.game);
          } else {
            expect(injections).toBe(1);
            if (entry !== "frame" || code === "fatal") expect(observed).toBe(first);
            else expect(observed).toBeUndefined();
            expect(before.world.game).toBeNull();
          }
          expect(trace.some(text => text.includes("forbidden"))).toBe(false);
          expect(trace.some(text => text.includes("ERROR: first quit shutdown error"))).toBe(first.code !== "fatal");
          const selectedTrace = [...trace];
          await f.host.close(); await f.host.close();
          expect(trace).toEqual(selectedTrace);
          expect(before.world.game).toBeNull();
          expect(ownedDescriptors(f.homePath)).toEqual([]);
          expect(f.stdin.listenerCount("readable")).toBe(0);
          f.stdin.destroy();
        });
      }
    }
  }

  for (const code of ["server-disconnect", "drop", "disconnect", "need-cd", "fatal"] satisfies readonly CommonErrorCode[]) {
    test(`post-Com_Init real network startup ${code} rejects its original primary without an invented init-abort diagnostic`, async () => {
      const homePath = mkdtempSync(join(tmpdir(), "q3-post-init-")); homes.push(homePath);
      const stdin = new PassThrough(), first = new CommonError(code, "post-init socket startup");
      let injected = false;
      await expect(DedicatedServerHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
        startupText: "+set dedicated 1 +set bot_enable 0 +set sv_pure 0 +set net_port 0 +set logfile 2",
        buildDate: "post-init", print: text => {
          if (!injected && text.startsWith("Opening IP socket:")) {
            expect(ownedDescriptors(homePath).some(path => path.endsWith("/qconsole.log"))).toBe(true);
            injected = true; throw first;
          }
        },
        bots: { kind: "unavailable", reason: "Human-only startup" },
        input: { stdin, signals: "none" } })).rejects.toBe(first);
      expect(injected).toBe(true);
      expect(ownedDescriptors(homePath)).toEqual([]);
      expect(stdin.listenerCount("readable")).toBe(0); stdin.destroy();
    });
  }
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    for (const point of ["filesystem", "config", "complete"] satisfies readonly string[]) {
      for (const code of ["server-disconnect", "drop", "disconnect", "need-cd", "fatal"] satisfies readonly CommonErrorCode[]) {
        test(`${product}: first typed initialization ${point}/${code} selects source effects before finite failed-open disposal`, async () => {
          const homePath = mkdtempSync(join(tmpdir(), "q3-init-control-")); homes.push(homePath);
          const stdin = new PassThrough(), trace: string[] = [];
          const first = new CommonError(code, `initial ${point} ${code}`);
          const trigger = point === "filesystem" ? "----- FS_Startup -----\n" : point === "config" ? "execing default.cfg\n" : "--- Common Initialization Complete ---\n";
          let injected = false, observed: unknown;
          try {
            await DedicatedServerHost.open({ roots: { dataPath, homePath, cdPath: null, product },
              startupText: "+set dedicated 1 +set bot_enable 0 +set sv_pure 0 +set net_ip 127.0.0.1 +set net_port 0 +set logfile 2",
              buildDate: "init-control-test", print: text => {
                if (injected || text === trigger) trace.push(text);
                if (!injected && text === trigger) { injected = true; throw first; }
              }, bots: { kind: "unavailable", reason: "Human-only initialization" },
              input: { stdin, signals: "none" } });
          } catch (error) { observed = error; }
          finally { stdin.destroy(); }
          expect(injected).toBe(true);
          expect(observed).toBeInstanceOf(CommonError);
          if (!(observed instanceof CommonError)) throw new Error("Expected selected initialization error");
          if (code === "fatal") expect(observed).toBe(first);
          else { expect(observed.code).toBe("fatal"); expect(observed.message).toBe("Error during initialization"); }
          expect(trace.some(text => text.includes(`ERROR: ${first.message}`))).toBe(code === "drop" || code === "disconnect");
          expect(trace.filter(text => text === "Server didn't have CD\n")).toHaveLength(code === "need-cd" ? 1 : 0);
          expect(trace.some(text => text.startsWith("Opening IP socket"))).toBe(false);
          expect(stdin.listenerCount("readable")).toBe(0);
          expect(ownedDescriptors(homePath)).toEqual([]);
        });
      }
    }
  }
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: real game source control retains owner after recursive terminal shutdown`, async () => {
      const trace: string[] = [];
      let armed = false;
      const initial = new CommonError("drop", "initial command failure");
      const f = await fixture(product, `+map ${product === "baseq3" ? "q3dm1" : "mpteam1"}`, true, text => {
        if (!armed) return;
        trace.push(text);
        if (text === "==== ShutdownGame ====\n") throw new CommonError("drop", "nested game shutdown print");
      });
      await f.host.frame();
      const before = running(f.host), udp = f.host.server.options.network.udp;
      if (udp === null) throw new Error("Expected actual UDP transport");
      const address = udp.address;
      f.host.common.commands.register("trigger_game_owner_error", () => { throw initial; });
      f.host.common.commands.append("trigger_game_owner_error\n");
      armed = true;
      let observed: unknown;
      try { await f.host.frame(); } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(CommonError);
      if (!(observed instanceof CommonError)) throw new Error("Expected recursive control");
      expect(observed.code).toBe("fatal"); expect(observed.message).toBe("recursive error after: initial command failure");
      expect(f.host.server.state.kind).toBe("running"); expect(before.world.game === before.game).toBe(true);
      expect(trace).toEqual(["********************\nERROR: initial command failure\n********************\n",
        "----- Server Shutdown -----\n", "==== ShutdownGame ====\n"]);
      expect(f.host.server.options.network.udp).toBeNull();
      const rebound = await UdpTransport.bind({ host: address.host, port: address.port });
      expect(rebound.address.port).toBe(address.port); rebound.close();
      const stoppedTrace = [...trace];
      await f.host.close(); await expect(f.host.frame()).rejects.toThrow("closed");
      expect(trace).toEqual(stoppedTrace); expect(before.world.game).toBeNull();
      expect(ownedDescriptors(f.homePath)).toEqual([]);
      f.stdin.destroy();
    });
  }

  for (const secondaryFailure of [false, true]) {
    test(`real server nested CommonError stops at shutdown banner and closes UDP, secondary=${secondaryFailure}`, async () => {
      const trace: string[] = [];
      let armed = false;
      const initial = new CommonError("drop", "initial command failure");
      const nested = new CommonError("drop", "nested shutdown print");
      const f = await fixture("baseq3", "+map q3dm1", true, text => {
        if (!armed) return;
        trace.push(text);
        if (text === "----- Server Shutdown -----\n") throw nested;
        if (secondaryFailure && text === "==== ShutdownGame ====\n") throw new Error("forbidden secondary cleanup failure");
      });
      await f.host.frame();
      const before = running(f.host), udp = f.host.server.options.network.udp;
      if (udp === null) throw new Error("Expected actual dedicated UDP transport");
      const address = udp.address;
      f.host.common.commands.register("trigger_initial_common_error", () => { throw initial; });
      f.host.common.commands.append("trigger_initial_common_error\n");
      armed = true;
      let observed: unknown = null;
      try { await f.host.frame(); } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(CommonError);
      if (!(observed instanceof CommonError)) throw new Error("Expected recursive common control");
      expect(observed.code).toBe("fatal");
      expect(observed.message).toBe("recursive error after: initial command failure");
      expect(f.host.common.cvars.get("com_errorMessage")?.value).toBe(initial.message);
      expect(trace).toEqual(["********************\nERROR: initial command failure\n********************\n", "----- Server Shutdown -----\n"]);
      expect(f.host.server.state.kind).toBe("running");
      expect(before.world.game).toBe(before.game);
      expect(f.host.server.options.network.udp).toBeNull();
      const rebound = await UdpTransport.bind({ host: address.host, port: address.port });
      expect(rebound.address.port).toBe(address.port);
      rebound.close();
      const terminalTrace = [...trace];
      await f.host.close();
      expect(trace).toEqual(terminalTrace);
      await expect(f.host.frame()).rejects.toThrow("closed");
      f.stdin.destroy();
    });
  }

  for (const command of ["map q3dm2", "map_restart 0"]) {
    test(`real server CommonError reaches common shutdown before map cleanup: ${command}`, async () => {
      const trace: string[] = [];
      let armed = false;
      const failure = new CommonError("drop", "map source control");
      const failurePrint = command === "map q3dm2" ? "------ Server Initialization ------\n" : "------- Game Initialization -------\n";
      const f = await fixture("baseq3", "+map q3dm1", true, text => {
        if (!armed) return;
        trace.push(text);
        if (text === failurePrint) throw failure;
      });
      await f.host.frame();
      f.host.common.commands.append(`${command}\n`);
      armed = true;
      expect(await f.host.frame()).toEqual({ kind: "aborted", frameNumber: 1, code: "drop", message: failure.message });
      const errorAt = trace.indexOf(`********************\nERROR: ${failure.message}\n********************\n`);
      expect(errorAt).toBeGreaterThan(trace.indexOf(failurePrint));
      expect(trace.indexOf("----- Server Shutdown -----\n")).toBeGreaterThan(errorAt);
      expect(trace.indexOf("---------------------------\n")).toBeGreaterThan(errorAt);
      expect(f.host.server.state.kind).toBe("stopped");
      expect(f.host.common.cvars.get("com_errorMessage")?.value).toBe(failure.message);
      armed = false;
      expect((await f.host.frame()).kind).toBe("frame");
    });
  }

  test("a dedicated build startup override zero runs the source null client and listen snapshot profile", async () => {
    const f = await fixture("baseq3", "+set dedicated 0 +map q3dm1");
    expect(f.host.common.cvars.get("cl_shownet")?.flags).toBe(CvarFlag.Temporary);
    const frame = await f.host.frame();
    expect(frame.kind).toBe("frame");
    const state = running(f.host);
    expect(state.statics.snapshotFrames).toBe(4);
    expect(state.statics.numSnapshotEntities).toBe(2 * 4 * 64);
  });

  test("native initialization completion opens the real common log before network initialization", async () => {
    const quiet = await fixture("baseq3", "+set net_noudp 1 +set logfile 2");
    expect(quiet.host.server.options.network.udp).toBeNull();
    const logfile = join(quiet.homePath, "baseq3", "qconsole.log");
    expect(existsSync(logfile)).toBe(true);
    expect(readFileSync(logfile, "latin1")).toMatch(/^logfile opened on .*\n\n--- Common Initialization Complete ---\n$/);
    expect(quiet.printed.join("")).toContain("--- Common Initialization Complete ---\n");
    const networked = await fixture("baseq3", "+set logfile 2");
    const networkLog = readFileSync(join(networked.homePath, "baseq3", "qconsole.log"), "latin1");
    expect(networkLog.indexOf("--- Common Initialization Complete ---\n")).toBeLessThan(networkLog.indexOf("Opening IP socket:"));
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: startup map waits for actual network initialization and stdin fast/full changes preserve native owners`, async () => {
      const map = product === "baseq3" ? "q3dm1" : "mpteam1", next = product === "baseq3" ? "q3dm2" : "mpteam2";
      const f = await fixture(product, `+set logfile 2 +map ${map}`);
      expect(f.host.server.state.kind).toBe("stopped");
      const udp = f.host.server.options.network.udp;
      if (udp === null) throw new Error("Dedicated NET_Init did not bind");
      expect(udp.address.host).toEqual([127, 0, 0, 1]); expect(udp.address.port).toBeGreaterThan(0);
      expect(f.host.common.cvars.get("net_qport")?.value).toBe("0");
      const firstFrame = await f.host.frame();
      if (firstFrame.kind !== "frame") throw new Error("Unexpected quit");
      const first = running(f.host), common = f.host.common, commands = common.commands, files = common.files.current;
      expect(first.world.serverId).toBe(firstFrame.frameTime);
      expect(firstFrame.modifiedMilliseconds).toBe(50); expect(first.statics.time).toBe(450);
      f.stdin.write("map_restart 0\n"); await f.host.frame();
      const restarted = running(f.host);
      expect(restarted.world).toBe(first.world); expect(restarted.statics).toBe(first.statics);
      expect(restarted.game).not.toBe(first.game); expect(common.files.current).toBe(files);
      f.stdin.write(`map ${next}\n`); await f.host.frame();
      const changed = running(f.host);
      expect(changed.world).not.toBe(first.world); expect(changed.statics).toBe(first.statics);
      expect(f.host.common).toBe(common); expect(f.host.common.commands).toBe(commands);
      f.stdin.write("killserver\n"); await f.host.frame(); expect(f.host.server.state.kind).toBe("stopped");
      f.stdin.write(`map ${map}\n`); await f.host.frame(); expect(running(f.host).statics).not.toBe(first.statics);
      f.stdin.write(`quit; map ${next}\n`);
      expect(await f.host.frame()).toEqual({ kind: "quit", frames: 5 });
      expect(f.host.server.state.kind).toBe("stopped");
      expect(f.host.common.commands.pendingText).toContain(`map ${next}`);
      expect(readFileSync(join(f.homePath, product, "qconsole.log"), "latin1").match(/logfile opened on /g)?.length).toBe(1);
      expect(readFileSync(join(f.homePath, product, "games.log"), "latin1")).toContain("ShutdownGame:");
      const rebound = await UdpTransport.bind(udp.address); rebound.close();
    });
  }

  test("one source command drain retains wait and frame limits quit without adding a game frame", async () => {
    const f = await fixture("baseq3", "+echo first +wait 2 +echo delayed");
    const first = await f.host.frame(); expect(first.kind).toBe("frame");
    expect(f.printed.join("")).toContain("first \n"); expect(f.printed.join("")).not.toContain("delayed \n");
    await f.host.frame(); expect(f.printed.join("")).not.toContain("delayed \n");
    f.stdin.end();
    expect(await f.host.run({ kind: "frames", count: 1 })).toEqual({ kind: "frame-limit", frames: 3 });
    expect(f.printed.join("")).toContain("delayed \n");
    expect(() => f.host.common.output.print("closed")).toThrow("closed");
  });

  test("run consumes queued quit, EOF alone does not quit, and archive persistence runs before commands", async () => {
    const f = await fixture("baseq3", "+seta saved old");
    await f.host.frame();
    f.stdin.write("set saved stored\n"); await f.host.frame();
    f.stdin.write("seta saved new\n"); await f.host.frame();
    const config = join(f.homePath, "baseq3", "q3config.cfg");
    expect(readFileSync(config, "latin1")).toContain('seta saved "stored"');
    f.stdin.write("quit\n");
    expect(await f.host.run({ kind: "continuous" })).toEqual({ kind: "quit", frames: 3 });
    expect(readFileSync(config, "latin1")).toContain('seta saved "new"');
    expect(f.stdin.listenerCount("readable")).toBe(0);
  });

  test("unrelated host entry and command drains reject without poisoning the accepted frame", async () => {
    const f = await fixture(), entered = deferred(), gate = deferred(), late = deferred();
    const original = f.host.server.frame.bind(f.host.server), escaped: { result: Promise<unknown> | null } = { result: null };
    f.host.server.frame = async milliseconds => {
      entered.finish(); await gate.promise;
      escaped.result = late.promise.then(() => f.host.frame());
      await original(milliseconds);
    };
    const frame = f.host.frame();
    try {
      await entered.promise;
      await expect(f.host.close()).rejects.toThrow("source order");
      await expect(f.host.frame()).rejects.toThrow("source order");
      await expect(f.host.run({ kind: "frames", count: 1 })).rejects.toThrow("source order");
      expect(() => f.host.common.commands.executeNow("echo forbidden")).toThrow("current owned driver operation");
      expect(() => f.host.common.close()).toThrow("current owned driver operation");
      gate.finish(); expect((await frame).kind).toBe("frame");
      if (escaped.result === null) throw new Error("Missing escaped callback");
      late.finish(); await expect(escaped.result).rejects.toThrow("closed common driver operation");
      f.host.server.frame = original;
      expect((await f.host.frame()).kind).toBe("frame");
    } finally { gate.finish(); await frame; f.host.server.frame = original; }
  });

  test("unrelated server, custom, empty and wait commands cannot mutate an accepted running frame", async () => {
    const f = await fixture("baseq3", "+map q3dm1"); await f.host.frame();
    const before = running(f.host), entered = deferred(), gate = deferred(), custom: string[] = [];
    f.host.common.commands.register("custom", () => { custom.push("sync"); });
    f.host.common.commands.registerAsync("custom_async", async () => { custom.push("async"); });
    f.stdin.write("wait 2;echo still-pending\n");
    const original = f.host.server.frame.bind(f.host.server);
    f.host.server.frame = async milliseconds => { entered.finish(); await gate.promise; await original(milliseconds); };
    const accepted = f.host.frame();
    try {
      await entered.promise;
      const names = f.host.common.commands.registeredNames(), pending = f.host.common.commands.pendingText;
      for (const text of ["killserver", "map q3dm2", "custom_async", "unknown", "", " "]) {
        await expect(f.host.common.commands.executeNowAsync(text)).rejects.toThrow("current owned driver operation");
      }
      for (const text of ["custom", "wait 0", "unknown", "", " "]) {
        expect(() => f.host.common.commands.executeNow(text)).toThrow("current owned driver operation");
      }
      expect(() => f.host.common.commands.execute()).toThrow("current owned driver operation");
      await expect(f.host.common.commands.executeAsync()).rejects.toThrow("current owned driver operation");
      expect(f.host.common.commands.pendingText).toBe(pending);
      expect(f.host.common.commands.registeredNames()).toEqual(names); expect(custom).toEqual([]);
      expect(running(f.host).world).toBe(before.world); expect(running(f.host).game).toBe(before.game);
      gate.finish(); expect((await accepted).kind).toBe("frame");
      f.host.server.frame = original;
      await f.host.frame(); expect(f.printed.join("")).not.toContain("still-pending \n");
      await f.host.frame(); expect(f.printed.join("")).toContain("still-pending \n");
      expect(running(f.host).world).toBe(before.world); expect(running(f.host).game).toBe(before.game);
    } finally { gate.finish(); await accepted; f.host.server.frame = original; }
  });

  test("actual UDP RCON quit unwinds the command and redirect before closing socket/common resources", async () => {
    const f = await fixture("baseq3", "+set rconPassword local-test +map q3dm1");
    await f.host.frame();
    const udp = f.host.server.options.network.udp;
    if (udp === null) throw new Error("No actual host socket");
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      f.clock.wall += 600;
      peer.send(udp.address, encodeConnectionlessText("rcon local-test quit"));
      expect(await f.host.frame()).toEqual({ kind: "quit", frames: 1 });
      expect(f.host.server.state.kind).toBe("stopped");
      expect(f.host.server.networkControl.redirectAddress.kind).toBe("bot");
      const rebound = await UdpTransport.bind(udp.address); rebound.close();
    } finally { peer.close(); }
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: encoded UDP client connects, primes, moves and receives both final packets through only common frames`, async () => {
      const f = await fixture(product, `+map ${product === "baseq3" ? "q3dm1" : "mpteam1"}`); await f.host.frame();
      const udp = f.host.server.options.network.udp;
      if (udp === null) throw new Error("No actual host socket");
      const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
      try {
        peer.send(udp.address, encodeConnectionlessText("getchallenge")); await f.host.frame();
        const challengeResponse = decodeConnectionless((await receive(peer)).payload, "client");
        expect(challengeResponse.command).toBe("challengeResponse");
        const challengeText = challengeResponse.arguments[0];
        if (challengeText === undefined || !/^-?\d+$/.test(challengeText)) throw new Error("Missing source challenge");
        const challenge = Number(challengeText), qport = 1023;
        peer.send(udp.address, encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\${challenge}\\name\\CommonPeer\\rate\\25000\\snaps\\20`));
        await f.host.frame(); expect(decodeConnectionless((await receive(peer)).payload, "client").command).toBe("connectResponse");
        const client = createProtocolClientSession({ product, cvars: new CvarRegistry(), mode: { kind: "network", challenge, qport } });
        for (const packet of transmitProtocolClient(client, f.clock.wall, 0, true)) peer.send(udp.address, packet);
        for (let count = 0; count < 32 && client.gamestateGeneration === 0; count++) {
          await f.host.frame();
          (await client.receiveDatagram((await receive(peer)).payload));
          while (peer.statistics.pending !== 0) (await client.receiveDatagram((await receive(peer)).payload));
        }
        expect(client.gamestateGeneration).toBe(1);
        const state = running(f.host), serverClient = state.statics.clients[0];
        expect(serverClient?.phase).toBe(ServerClientPhase.Primed);
        client.prime(1); client.setUserCmdValue(Weapon.WP_MACHINEGUN, 1);
        const before = state.game.pool.clientAt(0).ps.origin;
        client.createUserCommand({ serverTime: state.statics.time, viewAngles: vec3(0, 0, 0), buttons: 0, forwardmove: 127, rightmove: 0, upmove: 0 });
        for (const packet of transmitProtocolClient(client, f.clock.wall, 0, true)) peer.send(udp.address, packet);
        await f.host.frame(); expect(serverClient?.phase).toBe(ServerClientPhase.Active);
        (await client.receiveDatagram((await receive(peer)).payload));
        expect(client.snapshots.current().number).toBeGreaterThan(0);
        expect(state.game.pool.clientAt(0).ps.origin).not.toEqual(before);
        while (peer.statistics.pending !== 0) (await client.receiveDatagram((await receive(peer)).payload));
        const snapshot = client.snapshots.current().number;
        f.stdin.write("quit\n"); expect((await f.host.frame()).kind).toBe("quit");
        (await client.receiveDatagram((await receive(peer)).payload)); (await client.receiveDatagram((await receive(peer)).payload));
        expect(client.snapshots.current().number).toBe(snapshot + 2);
        expect(serverClient?.reliable.pending().filter(command => command.text === "disconnect")).toHaveLength(2);
      } finally { peer.close(); }
    });
  }

  test("none time precedes loopback RCON clock reads and client-first draining retains new server replies", async () => {
    const f = await fixture("baseq3", "+set rconPassword local-test +map q3dm1"); await f.host.frame(); f.clock.wall += 600;
    const loopback = f.host.server.options.network.loopback;
    loopback.send("server", Uint8Array.of(7));
    loopback.send("client", encodeConnectionlessText("rcon local-test status"));
    const expected = f.clock.wall - 1000000, result = await f.host.frame();
    if (result.kind !== "frame") throw new Error("Unexpected quit");
    expect(result.frameTime).toBe(expected);
    expect(f.clock.wall - 1000000).toBeGreaterThan(result.frameTime + 1);
    const reply = loopback.poll("client");
    if (reply === null) throw new Error("Missing retained server-to-client loopback reply");
    const response = decodeConnectionless(reply.payload, "client");
    expect(response.command).toBe("print"); expect(Buffer.from(response.payload).toString("latin1")).toContain("map: q3dm1");
  });

  test("dropsim owns its seed independently, draws before stopped-server discard and never drops loopback", async () => {
    const f = await fixture("baseq3", "+map q3dm1"); await f.host.frame();
    const udp = f.host.server.options.network.udp;
    if (udp === null) throw new Error("No actual host socket");
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      f.host.common.cvars.set("com_dropsim", "0.5", true);
      for (let index = 0; index < 3; index++) peer.send(udp.address, encodeConnectionlessText(`getinfo draw-${index}`));
      await f.host.frame();
      const response = decodeConnectionless((await receive(peer)).payload, "client");
      expect(Buffer.from(response.payload).toString("latin1")).toContain("\\challenge\\draw-2");
      expect(peer.statistics.pending).toBe(0);
      f.stdin.write("killserver\n"); await f.host.frame();
      peer.send(udp.address, encodeConnectionlessText("getinfo consumes-while-stopped")); await f.host.frame();
      f.stdin.write("map q3dm1\n"); await f.host.frame();
      for (let index = 0; index < 3; index++) peer.send(udp.address, encodeConnectionlessText(`getinfo after-stop-${index}`));
      await f.host.frame();
      const afterStop = decodeConnectionless((await receive(peer)).payload, "client");
      expect(Buffer.from(afterStop.payload).toString("latin1")).toContain("\\challenge\\after-stop-2");
      expect(peer.statistics.pending).toBe(0);
      f.host.common.cvars.set("com_dropsim", "1", true);
      f.host.server.options.network.loopback.send("client", encodeConnectionlessText("getinfo no-drop"));
      await f.host.frame();
      const packet = f.host.server.options.network.loopback.poll("client");
      if (packet === null) throw new Error("Loopback must bypass dropsim");
      expect(Buffer.from(decodeConnectionless(packet.payload, "client").payload).toString("latin1")).toContain("\\challenge\\no-drop");
    } finally { peer.close(); }
  });

  test("default unavailable bots fail visibly and release the owned socket and stdin", async () => {
    const f = await fixture("baseq3", "+map q3dm1", false), udp = f.host.server.options.network.udp;
    if (udp === null) throw new Error("No actual host socket");
    await expect(f.host.frame()).rejects.toThrow("bot");
    expect(f.host.server.state.kind).toBe("stopped"); expect(f.stdin.listenerCount("readable")).toBe(0);
    const rebound = await UdpTransport.bind(udp.address); rebound.close();
  });

  test("input initialization failure after a real bind closes that socket and does not claim a started host", async () => {
    const probe = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 }), address = probe.address; probe.close();
    const homePath = mkdtempSync(join(tmpdir(), "q3-dedicated-failure-")); homes.push(homePath);
    const stdin = new PassThrough(); stdin.setEncoding("utf8");
    await expect(DedicatedServerHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startupText: `+set dedicated 1 +set net_ip 127.0.0.1 +set net_port ${address.port}`,
      buildDate: "failure-test", print: () => undefined,
      bots: { kind: "unavailable", reason: "No bot AI" },
      input: { stdin, signals: "none" } })).rejects.toThrow("binary Readable");
    const rebound = await UdpTransport.bind(address); rebound.close();
    expect(stdin.listenerCount("readable")).toBe(0);
  });

  test("config map commands before SV_Init cannot start a map, but late startup commands do", async () => {
    const homePath = mkdtempSync(join(tmpdir(), "q3-dedicated-config-")); homes.push(homePath);
    mkdirSync(join(homePath, "baseq3")); writeFileSync(join(homePath, "baseq3", "autoexec.cfg"), "map q3dm2\necho config finished\n");
    const printed: string[] = [];
    const host = await DedicatedServerHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set bot_enable 0 +set sv_pure 0 +map q3dm1",
      buildDate: "config-test", print: text => { printed.push(text); },
      bots: { kind: "unavailable", reason: "No bot AI" },
      input: { stdin: new PassThrough(), signals: "none" } }); hosts.push(host);
    expect(host.server.state.kind).toBe("stopped"); expect(printed.join("")).toContain("config finished \n");
    expect(printed.join("")).not.toContain("Server: q3dm2");
    await host.frame(); expect(host.common.cvars.get("mapname")?.value).toBe("q3dm1");
  });

  test("real UDP packets are dispatched before console commands from the same event drain", async () => {
    const f = await fixture("baseq3", "+map q3dm1"); await f.host.frame();
    const udp = f.host.server.options.network.udp;
    if (udp === null) throw new Error("No host socket");
    const peer = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
    try {
      f.stdin.write("killserver\n"); peer.send(udp.address, encodeConnectionlessText("getinfo phase-order"));
      await f.host.frame(); expect(f.host.server.state.kind).toBe("stopped");
      await Bun.sleep(1);
      const result = peer.poll();
      if (result === null || result.kind !== "packet") throw new Error("Missing real getinfo response before killserver");
      expect(decodeConnectionless(result.payload, "client").command).toBe("infoResponse");
    } finally { peer.close(); }
  });
});
