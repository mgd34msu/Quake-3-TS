import { afterEach, expect, test } from "bun:test";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import type { CommandFallbackResolver, CommandHandler } from "../src/core/commands.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { ServerClientLifecycleRuntime } from "../src/server/client-lifecycle.ts";
import { registerServerCvars } from "../src/server/config.ts";
import { ServerConnectionlessRuntime } from "../src/server/connectionless.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import type { ServerPacketAddress } from "../src/server/net-channel.ts";
import { ServerNetworkControlState } from "../src/server/network-control.ts";
import { ServerRconRuntime } from "../src/server/rcon.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerStaticState, ServerWorldState } from "../src/server/state.ts";

function resolveSynchronously(handler: CommandHandler): CommandFallbackResolver {
  return () => ({ kind: "sync", handler });
}

const from: ServerPacketAddress = { kind: "ipv4", host: [10, 0, 0, 1], port: 27961 };
function wireText(packet: Uint8Array): string { return [...packet.subarray(4)].map(byte => String.fromCharCode(byte)).join(""); }
function hash(packet: Uint8Array): string {
  let value = 2166136261;
  for (const byte of packet.subarray(4)) value = Math.imul(value ^ byte, 16777619);
  return (value >>> 0).toString(16).padStart(8, "0");
}
const downloadFileOwners: CommonFileState[] = [];
afterEach(() => { for (const files of downloadFileOwners.splice(0)) files.close(); });

async function fixture() {
  const cvars = new CvarRegistry(); registerServerCvars(cvars); cvars.set("rconPassword", "secret", true);
  const downloadFiles = new CommonFileState({ homePath: process.cwd(), dataPath: process.cwd(), cdPath: null, product: "baseq3" },
    () => undefined, new SoundOutput(), cvars);
  downloadFileOwners.push(downloadFiles);
  await downloadFiles.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  const normal: string[] = [], trace: string[] = [], packets: Uint8Array[] = [], addresses: ServerPacketAddress[] = [], executed: string[] = [];
  const output = new ConsoleOutput(text => { normal.push(text); trace.push("normal"); });
  const print = (text: string): void => { output.print(text); };
  const sendPacket = (address: ServerPacketAddress, bytes: Uint8Array): undefined => { addresses.push(address); packets.push(bytes); trace.push("packet"); };
  const commands = new CommandBuffer({ resolveFallback: resolveSynchronously(context => { executed.push(context.raw); }) });
  const control = new ServerNetworkControlState();
  function createLifecycle(): ServerClientLifecycleRuntime {
    const statics = new ServerStaticState({ product: "baseq3", maxClients: 1, dedicated: true });
    const world = new ServerWorldState(statics, { print, dropClient: () => { throw new Error("Rcon fixture never drops clients"); } });
    const downloads = new ServerDownloadRuntime(statics, { cvars, files: downloadFiles.server, print, debugPrint: print,
      dropClient: () => { throw new Error("No downloads"); }, sendClientGameState: () => { throw new Error("No downloads"); } });
    const channel = new ServerNetChannelRuntime(statics, { debugPrint: text => { print(text); }, tracePacket: message => { expect(message).toMatch(/^server send /); }, print, sendPacket, connectionless: () => { throw new Error("Use awaited receiver"); }, executeClientMessage: () => { throw new Error("No movement"); } });
    const sender = new ServerSnapshotSendRuntime(new ServerSnapshotRuntime(world, statics, {
      get collision() {
        const game = world.game;
        if (!(game instanceof GameRuntime)) throw new Error("RCON fixture has no loaded map");
        return game.options.collision;
      },
      get spatial() {
        const game = world.game;
        if (!(game instanceof GameRuntime)) throw new Error("RCON fixture has no loaded map");
        return game.world;
      },
      debugPrint: print,
    }), channel, { cvars, downloads, print, isLanAddress: () => true });
    return new ServerClientLifecycleRuntime(world, statics, { cvars, downloads, sender, print, debugPrint: print, sendPacket, isLanAddress: () => true });
  }
  let lifecycle: ServerClientLifecycleRuntime | null = createLifecycle(), now = 500;
  function currentLifecycle(): ServerClientLifecycleRuntime {
    if (lifecycle === null) throw new Error("Fixture server is stopped");
    return lifecycle;
  }
  const rcon = new ServerRconRuntime(control, { cvars, commands, output, milliseconds: () => now, sendPacket });
  const receiver = new ServerConnectionlessRuntime(control, { cvars, random: new LinuxNativeRandom(1), currentLifecycle, sendPacket,
    isLanAddress: () => true, resolveAddress: async () => { throw new Error("Rcon must not resolve external addresses"); },
    print, debugPrint: text => { trace.push(`debug:${text}`); }, remoteCommand: (address, raw, packet) => rcon.handle(address, raw, packet) });
  commands.register("chunks", context => { executed.push(context.raw); output.print("a".repeat(600)); output.print("b".repeat(500)); });
  commands.register("big", context => { executed.push(context.raw); output.print("x".repeat(5000)); });
  commands.register("full", context => { executed.push(context.raw); output.print("z".repeat(1007)); });
  async function request(line: string): Promise<void> { await receiver.process(from, encodeConnectionlessText(line)); }
  return { cvars, output, commands, control, rcon, receiver, normal, trace, packets, addresses, executed, request,
    clock(value: number) { now = value; },
    currentState: () => currentLifecycle().staticState,
    stopSession() { control.resetServerSession(); lifecycle = null; },
    replaceSession() { control.resetServerSession(); lifecycle = createLifecycle(); return new ServerRconRuntime(control, rcon.host); } };
}

test("unchanged C rcon packet fixture: unsigned throttle, flush lengths/hashes, failure branches and wrap", async () => {
  const f = await fixture();
  for (const now of [0, 499]) { f.clock(now); await f.request("rcon secret chunks"); }
  expect(f.packets).toHaveLength(0); expect(f.normal).toHaveLength(0);
  f.clock(500); await f.request("rcon secret chunks"); f.clock(999); await f.request("rcon secret big");
  f.clock(1000); await f.request("rcon secret big"); f.clock(1500); await f.request("rcon secret full");
  f.clock(2000); await f.request("rcon wrong echo hidden");
  f.cvars.set("rconPassword", "", true); f.clock(2500); await f.request("rcon wrong echo hidden");
  // /tmp/q3-rcon-oracle-mpG9n0: untouched sv_main/common functions, gcc -m32 -O2 and original q_shared.c.
  expect(f.packets.map(packet => [packet.length - 4, hash(packet)])).toEqual([
    [606, "4fcc768e"], [506, "5b40a26e"], [6, "7b6f0aa6"], [1013, "75d056fa"], [1013, "eb37f718"], [24, "e2cdfa64"], [41, "e68a3621"],
  ]);
  expect(f.executed).toEqual(["chunks", "big", "full"]);
  expect(f.trace.filter(event => event === "normal" || event === "packet")).toEqual([
    "normal", "packet", "packet", "normal", "packet", "packet", "normal", "packet", "normal", "packet", "normal", "packet",
  ]);
  expect(f.normal.join("")).not.toContain("secret"); expect(f.normal.join("")).not.toContain("hidden"); expect(f.normal.join("")).not.toContain("wrong");
  for (const packet of f.packets) expect([...packet.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  f.cvars.set("rconPassword", "secret", true); f.packets.length = 0;
  for (const now of [-256, -255, 0, 244, 245]) { f.clock(now); await f.request("rcon secret full"); }
  expect(f.packets.map(hash)).toEqual(["eb37f718", "eb37f718", "eb37f718"]);
});

test("raw remaining command extraction preserves native spaces/tabs/quotes and does not split semicolons", async () => {
  const f = await fixture();
  await f.request("rcon\tsecret\techo hi");
  f.clock(1000); f.cvars.set("rconPassword", "space pass", true); await f.request('rcon "space pass" echo hi');
  f.clock(1500); f.cvars.set("rconPassword", "secret", true); await f.request(" rcon secret chunks");
  f.clock(2000); await f.request('rcon secret echo "a b"; full');
  expect(f.executed).toEqual(["hi", 'pass" echo hi', "secret chunks", 'echo "a b"; full']);
  expect(f.packets.map(wireText)).toEqual(["print\n", "print\n", "print\n", "print\n"]);
});

test("source incoming line truncates before extraction and empty command does not drain queued work", async () => {
  const f = await fixture(); f.commands.append("full\n");
  await f.request("rcon secret"); expect(f.commands.pendingText).toBe("full\n"); expect(f.executed).toEqual([]);
  f.clock(1000); await f.request(`rcon secret unknown ${"a".repeat(1500)}`);
  // MSG_ReadStringLine first limits the whole packet line to1023, including the12-byte rcon prefix.
  expect(f.executed).toEqual([`unknown ${"a".repeat(1003)}`]);
  expect(f.commands.pendingText).toBe("full\n");
});

test("rcon awaits the real command while shared engine output remains redirected", async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>();
  f.commands.registerAsync("later", async () => { f.output.print("before"); await gate.promise; f.output.print("after"); });
  const original = f.currentState(), pending = f.request("rcon secret later");
  expect(f.output.redirecting).toBe(true); expect(f.packets).toHaveLength(0);
  f.output.print("during");
  const replacement = new ServerRconRuntime(f.control, f.rcon.host), raw = encodeConnectionlessText("rcon secret full");
  await expect(replacement.handle(from, raw, decodeConnectionless(raw, "server"))).rejects.toThrow("awaited in source order");
  gate.resolve(); await pending;
  expect(f.packets.map(wireText)).toEqual(["print\nbeforeduringafter"]);
  expect(f.addresses).toEqual([from]); expect(f.output.redirecting).toBe(false);
  expect(f.currentState()).toBe(original); expect(f.control.redirectAddress).toEqual(from);
  f.output.print("ordinary"); expect(f.normal.at(-1)).toBe("ordinary");
});

test("ambient overflow uses the captured owner and only a returned command ends redirection", async () => {
  for (const fail of [false, true]) {
    const f = await fixture(), gate = Promise.withResolvers<void>(), failure = new Error("deferred command rejected");
    f.commands.registerAsync("wait-output", async () => { await gate.promise; if (fail) throw failure; });
    const pending = f.request("rcon secret wait-output");
    expect(f.control.inCurrentRconOperation).toBe(false);
    f.output.print("a".repeat(1007)); f.output.print("b");
    expect(f.packets.map(wireText)).toEqual([`print\n${"a".repeat(1007)}`]);
    gate.resolve();
    if (fail) await expect(pending).rejects.toBe(failure); else await pending;
    expect(f.control.connectionlessBusy).toBe(false);
    if (fail) {
      expect(f.packets.map(wireText)).toEqual([`print\n${"a".repeat(1007)}`]);
      expect(f.output.redirecting).toBe(true);
      expect(() => f.output.endRedirect()).toThrow("closed server network operation");
    } else {
      expect(f.packets.map(wireText)).toEqual([`print\n${"a".repeat(1007)}`, "print\nb"]);
      expect(f.output.redirecting).toBe(false);
      f.output.print("ordinary after close"); expect(f.normal.at(-1)).toBe("ordinary after close");
    }
  }
});

test("ambient overflow remains global while an owned heartbeat is awaiting DNS", async () => {
  const f = await fixture(), gate = Promise.withResolvers<Ipv4Address | null>();
  f.cvars.set("dedicated", "2", true); f.cvars.set("sv_master1", "master.example", true);
  f.receiver.host.resolveAddress = () => gate.promise;
  f.commands.registerAsync("heartbeat-output", async () => { await f.receiver.masterHeartbeat(); });
  const pending = f.request("rcon secret heartbeat-output");
  expect(f.control.inCurrentRconOperation).toBe(false);
  f.output.print("a".repeat(1007)); f.output.print("b");
  expect(f.packets.map(wireText)).toEqual(["print\nResolving master.example\n", `print\n${"a".repeat(1007)}`]);
  gate.resolve({ kind: "ipv4", host: [192, 0, 2, 10], port: 27960 }); await pending;
  expect(f.packets.map(wireText).slice(2)).toEqual([
    "heartbeat QuakeArena-1\n", "print\nbmaster.example resolved to 192.0.2.10:27950\nSending heartbeat to master.example\n",
  ]);
  expect(f.control.connectionlessBusy).toBe(false); expect(f.output.redirecting).toBe(false);
});

test("reset-to-bot during ambient output drops overflow and final flush without caller-context errors", async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>();
  f.commands.registerAsync("wait-output", async () => { await gate.promise; });
  const pending = f.request("rcon secret wait-output");
  f.output.print("a".repeat(1007)); f.stopSession(); f.output.print("b");
  expect(f.packets).toHaveLength(0); gate.resolve(); await pending;
  expect(f.packets).toHaveLength(0); expect(f.output.redirecting).toBe(false);
  f.output.print("normal while stopped"); expect(f.normal.at(-1)).toBe("normal while stopped");
});

test("a captured output owner rejects use after its operation closes, independently of ambient context", async () => {
  const control = new ServerNetworkControlState();
  let captured: ReturnType<ServerNetworkControlState["captureCurrentOperation"]> | undefined;
  await control.runRcon(async () => { captured = control.captureCurrentOperation(); captured.assertOpen(); });
  if (captured === undefined) throw new Error("Missing captured owner");
  const owner = captured;
  expect(() => owner.assertOpen()).toThrow("closed server network operation");
  expect(() => owner.assertChildrenReturned()).toThrow("closed server network operation");
  expect(() => control.captureCurrentOperation()).toThrow("inactive server network operation");
});

test("engine throttle persists across full session/handler replacement but independent engines do not share it", async () => {
  const f = await fixture(); await f.request("rcon secret full");
  const original = f.currentState(), replacement = f.replaceSession(), raw = encodeConnectionlessText("rcon secret full"), decoded = decodeConnectionless(raw, "server");
  f.clock(999); await replacement.handle(from, raw, decoded); expect(f.packets).toHaveLength(1);
  f.clock(1000); await replacement.handle(from, raw, decoded); expect(f.packets).toHaveLength(2);
  expect(f.currentState()).not.toBe(original); expect(f.control.redirectAddress).toEqual(from);
  const independent = await fixture(); await independent.request("rcon secret full"); expect(independent.packets).toHaveLength(1);
});

test("rejected command skips the final flush and retains the managed buffer after ownership closes", async () => {
  const f = await fixture(), error = new Error("command rejected");
  f.commands.registerAsync("fail", async () => { f.output.print("before failure"); throw error; });
  await expect(f.request("rcon secret fail")).rejects.toBe(error);
  expect(f.packets).toHaveLength(0); expect(f.output.redirecting).toBe(true);
  expect(f.control.rconBusy).toBe(false); expect(f.control.connectionlessBusy).toBe(false);
  // Source longjmp leaves a dangling stack buffer; the managed buffer survives,
  // but its closed asynchronous network owner cannot publish anything further.
  expect(() => f.output.endRedirect()).toThrow("closed server network operation");
  expect(f.output.redirecting).toBe(true); expect(f.packets).toHaveLength(0);
});

test("password is read again after the normal diagnostic, without logging secrets", async () => {
  const f = await fixture(), seen: string[] = [];
  const output = new ConsoleOutput(text => { seen.push(text); f.cvars.set("rconPassword", "", true); });
  const handler = new ServerRconRuntime(f.control, { ...f.rcon.host, output });
  const raw = encodeConnectionlessText("rcon secret echo credential");
  await handler.handle(from, raw, decodeConnectionless(raw, "server"));
  expect(seen).toEqual(["Rcon from 10.0.0.1:27961:\n[command omitted]\n"]);
  expect(f.packets.map(wireText)).toEqual(["print\nNo rconpassword set on the server.\n"]); expect(f.executed).toEqual([]);
});

test("Latin1 percent and NUL decoding reaches commands, malformed cursor/clock reject explicitly", async () => {
  const f = await fixture(); await f.request("rcon secret echo % é\0ignored"); expect(f.executed).toEqual(["echo . é"]);
  f.clock(1000);
  const raw = encodeConnectionlessText("rcon secret");
  const decoded = decodeConnectionless(raw, "server");
  await expect(f.rcon.handle(from, raw, { ...decoded, line: "r" })).rejects.toThrow("cursor exceeds");
  expect(f.output.redirecting).toBe(true);
  f.clock(2147483648); await expect(f.request("rcon secret full")).rejects.toThrow("signed-int milliseconds");
});

test("synchronous command abort skips EndRedirect and leaves its managed buffer active", async () => {
  const f = await fixture(), commandError = new Error("sync command failure");
  f.commands.register("throw", () => { f.output.print("partial"); throw commandError; });
  await expect(f.request("rcon secret throw")).rejects.toBe(commandError);
  expect(f.packets).toHaveLength(0);
  expect(f.output.redirecting).toBe(true); expect(f.control.rconBusy).toBe(false);
  expect(() => f.output.endRedirect()).toThrow("closed server network operation");
});

test("packet-send failure aborts EndRedirect before its buffer is cleared", async () => {
  const f = await fixture(), sendError = new Error("send failure");
  const broken = new ServerRconRuntime(f.control, { ...f.rcon.host, sendPacket: () => { throw sendError; } });
  const raw = encodeConnectionlessText("rcon secret full");
  await expect(broken.handle(from, raw, decodeConnectionless(raw, "server"))).rejects.toBe(sendError);
  expect(f.output.redirecting).toBe(true); expect(f.control.rconBusy).toBe(false);
  expect(f.normal.every(text => text.includes("[command omitted]"))).toBe(true);
  expect(() => f.output.endRedirect()).toThrow("closed server network operation");
  expect(f.packets).toHaveLength(0);
});

test("logical svs redirect reset retains engine caches/throttle and drops output after command shutdown", async () => {
  const f = await fixture(); expect(f.control.redirectAddress).toEqual({ kind: "bot" });
  f.control.masterAddresses[0] = from;
  f.commands.register("stop", () => { f.output.print("before shutdown"); f.stopSession(); f.output.print("after shutdown"); });
  await f.request("rcon secret stop");
  expect(f.packets).toEqual([]); expect(f.control.redirectAddress).toEqual({ kind: "bot" });
  expect(f.control.masterAddresses[0]).toEqual(from); expect(f.control.rconLastTime).toBe(500);
  expect(f.output.redirecting).toBe(false); expect(f.control.connectionlessBusy).toBe(false);
  expect(() => f.currentState()).toThrow("server is stopped");
});

test("normal diagnostic may stop or replace the server before the source redirect assignment", async () => {
  for (const action of ["stop", "replace"]) {
    const f = await fixture(), original = f.currentState();
    const output = new ConsoleOutput(text => {
      f.normal.push(text);
      if (action === "stop") f.stopSession(); else f.replaceSession();
    });
    const handler = new ServerRconRuntime(f.control, { ...f.rcon.host, output });
    const raw = encodeConnectionlessText("rcon incorrect");
    await handler.handle(from, raw, decodeConnectionless(raw, "server"));
    if (action === "stop") expect(() => f.currentState()).toThrow("server is stopped");
    else expect(f.currentState()).not.toBe(original);
    expect(f.control.redirectAddress).toEqual(from);
    expect(f.packets.map(wireText)).toEqual(["print\nBad rconpassword.\n"]);
  }
});

test("session replacement during a command drops final output; every earlier flush uses its then-live address", async () => {
  const f = await fixture(), other: ServerPacketAddress = { kind: "ipv4", host: [10, 0, 0, 2], port: 1234 };
  f.commands.register("replace", () => {
    f.output.print("a".repeat(1007));
    f.control.redirectAddress = other;
    f.output.print("b"); // Flushes the full buffer to the newly live address.
    f.replaceSession();
    f.output.print("c");
  });
  await f.request("rcon secret replace");
  expect(f.addresses).toEqual([other]); expect(f.packets.map(wireText)).toEqual([`print\n${"a".repeat(1007)}`]);
  expect(f.control.redirectAddress).toEqual({ kind: "bot" });
});

test("RCON killserver owns two awaited real master heartbeats before source session zeroing", async () => {
  const f = await fixture(), gate = Promise.withResolvers<Ipv4Address | null>();
  f.cvars.set("dedicated", "2", true); f.cvars.set("sv_master1", "master.example", true);
  f.receiver.host.resolveAddress = () => { f.trace.push("dns:begin"); return gate.promise; };
  f.commands.registerAsync("killserver", async () => {
    expect(f.control.inCurrentRconOperation).toBe(true); f.trace.push("shutdown:begin");
    f.currentState().nextHeartbeatTime = -9999999;
    await f.receiver.masterHeartbeat(); f.trace.push("shutdown:first-heartbeat");
    expect(f.control.inCurrentRconOperation).toBe(true);
    f.currentState().nextHeartbeatTime = -9999999;
    await f.receiver.masterHeartbeat(); f.trace.push("shutdown:second-heartbeat");
    f.stopSession(); f.trace.push("shutdown:zero"); f.output.print("shutdown complete\n");
  });
  const pending = f.request("rcon secret killserver").then(() => { f.trace.push("caller:continued"); });
  await Promise.resolve();
  expect(f.control.inCurrentRconOperation).toBe(false); expect(f.packets).toHaveLength(0);
  expect(f.trace.slice(-2)).toEqual(["shutdown:begin", "dns:begin"]);
  await expect(f.receiver.masterHeartbeat()).rejects.toThrow("awaited in source order");
  await expect(f.request("getinfo x")).rejects.toThrow("awaited in source order");
  gate.resolve({ kind: "ipv4", host: [192, 0, 2, 10], port: 27960 }); await pending;
  expect(f.trace.filter(text => text.startsWith("shutdown:") || text === "packet" || text.startsWith("caller:"))).toEqual([
    "shutdown:begin", "packet", "shutdown:first-heartbeat", "packet", "shutdown:second-heartbeat", "shutdown:zero", "caller:continued",
  ]);
  expect(f.packets.map(wireText)).toEqual(["heartbeat QuakeArena-1\n", "heartbeat QuakeArena-1\n"]);
  expect(f.trace.filter(text => text === "dns:begin")).toHaveLength(1);
  expect(f.control.connectionlessBusy).toBe(false); expect(f.control.rconBusy).toBe(false); expect(f.output.redirecting).toBe(false);
});

test("owned heartbeat siblings reject while the first DNS is pending, without rejecting the awaited parent", async () => {
  const f = await fixture(), gate = Promise.withResolvers<null>();
  f.cvars.set("dedicated", "2", true); f.receiver.host.resolveAddress = () => gate.promise;
  f.commands.registerAsync("siblings", async () => {
    const first = f.receiver.masterHeartbeat();
    await expect(f.receiver.masterHeartbeat()).rejects.toThrow("awaited in source order");
    expect(f.control.inCurrentRconOperation).toBe(false);
    gate.resolve(null); await first;
    expect(f.control.inCurrentRconOperation).toBe(true);
  });
  await f.request("rcon secret siblings");
  expect(f.control.connectionlessBusy).toBe(false); expect(f.packets).toHaveLength(1);
});

test("unawaited heartbeat rejects the RCON parent and cannot publish after its ancestors close", async () => {
  const f = await fixture(), gate = Promise.withResolvers<Ipv4Address | null>();
  f.cvars.set("dedicated", "2", true); f.receiver.host.resolveAddress = () => gate.promise;
  let child: Promise<void> | undefined;
  f.commands.registerAsync("escape", async () => { child = f.receiver.masterHeartbeat(); });
  await expect(f.request("rcon secret escape")).rejects.toThrow("must be awaited");
  expect(f.packets).toHaveLength(0); expect(f.output.redirecting).toBe(true);
  expect(f.control.connectionlessBusy).toBe(true);
  if (child === undefined) throw new Error("Expected outstanding heartbeat");
  gate.resolve({ kind: "ipv4", host: [192, 0, 2, 10], port: 27960 });
  await expect(child).rejects.toThrow("closed server network operation");
  expect(f.packets).toHaveLength(0); expect(f.control.masterAddresses[0]).toBe(null);
  expect(f.control.connectionlessBusy).toBe(false); expect(f.control.inCurrentRconOperation).toBe(false);
  // Discard the managed post-abort buffer explicitly before testing a new request.
  f.output.beginRedirect(1, () => undefined); f.output.endRedirect();
  f.clock(1000); await f.request("rcon secret full"); expect(f.packets.map(hash)).toEqual(["eb37f718"]);
});

test("a delayed callback cannot reuse a closed owned RCON context", async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>();
  let escaped: Promise<void> | undefined;
  f.commands.registerAsync("later-network", async () => {
    escaped = gate.promise.then(async () => {
      expect(f.control.inCurrentRconOperation).toBe(false);
      await f.receiver.masterHeartbeat();
    });
  });
  await f.request("rcon secret later-network");
  if (escaped === undefined) throw new Error("Missing delayed fixture callback");
  gate.resolve(); await expect(escaped).rejects.toThrow("closed server network operation");
  expect(f.packets.map(wireText)).toEqual(["print\n"]); expect(f.control.connectionlessBusy).toBe(false);
});
