// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { finishCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import type { CommandFallbackResolver, CommandHandler } from "../src/core/commands.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { vec3 } from "../src/core/math.ts";
import { Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { decodeServerMessage } from "../src/protocol/server-message.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { ServerClientLifecycleRuntime } from "../src/server/client-lifecycle.ts";
import { ServerConnectionlessRuntime } from "../src/server/connectionless.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import { ServerFrameRuntime } from "../src/server/frame.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import { ServerNetworkControlState } from "../src/server/network-control.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import type { ServerClient } from "../src/server/state.ts";
import { GameType } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

function resolveSynchronously(handler: CommandHandler): CommandFallbackResolver {
  return () => ({ kind: "sync", handler });
}

// Untouched sv_main.c native i386 fixture, not QVM:
// /tmp/quake3-server-frame-reference-4vzuG5/{fixture.c,run.sh}, gcc -m32 -O2
// -ffunction-sections -fdata-sections -Wl,--gc-sections. External engine/VM calls
// are captured there; these tests execute actual GameRuntime and sender instead.
// Local20/105: bot1020,send1000,bot1125,game1050,game1100,send1100,residual25.
// Dedicated20/105: sleep30,bot1000,game1050,game1100,send1100,residual25,profile7.
// Pings client0=102/ps102,bot=0/ps73,inactive999/ps73. Timeout drops at count6;
// zombie expiry retains its count on that pass, resets it on the next free pass.
// PROFILELIVE changes com_speeds in GAME_RUN_FRAME and produces7 from start0;
// INFOLIVE raises system-info during server-info publication, sends0 then1,
// and preserves only the archive modified flag1.

function at<T>(items: ArrayLike<T>, index: number): T { const item = items[index]; if (item === undefined) throw new Error(`Missing frame fixture ${index}`); return item; }
function connection(client: ServerClient) { if (client.connection.kind !== "initialized") throw new Error("Missing client channel"); return client.connection; }
function smallMap(): BspMap {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  return { entities: '{ "classname" "worldspawn" } { "classname" "info_player_deathmatch" "origin" "50 0 0" }', entityRecords: [],
    planes: [{ normal: vec3(1, 0, 0), distance: 0 }], nodes: [{ plane: 0, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], visibility: { clusterCount: 1, bytesPerCluster: 1, bits: Uint8Array.of(1) },
    shaders: [], leafSurfaces: [], leafBrushes: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [] };
}
const downloadFileOwners: CommonFileState[] = [];
afterEach(() => { for (const files of downloadFileOwners.splice(0)) files.close(); });

async function fixture(product: Product = "baseq3", map = smallMap()) {
  const harness = createGameVerificationHarness({ product, map, gameType: GameType.GT_FFA, levelTime: 1000, randomSeed: 42,
    buildDate: "Sep 5 2026", clientNamePrefix: "Frame", botsReason: "Frame fixture has disabled bots" });
  const { runtime: game, cvars } = harness, statics = new ServerStaticState({ product, maxClients: 4, dedicated: false }); statics.time = 1000;
  const downloadFiles = new CommonFileState({ homePath: process.cwd(), dataPath: process.cwd(), cdPath: null, product: "baseq3" },
    () => undefined, new SoundOutput(), cvars);
  downloadFileOwners.push(downloadFiles);
  await downloadFiles.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  const settings: readonly (readonly [string, string])[] = [["sv_fps", "20"], ["sv_timeout", "2"], ["sv_zombietime", "1"], ["sv_killserver", "0"],
    ["sv_running", "1"], ["cl_paused", "0"], ["sv_paused", "0"], ["dedicated", "0"], ["com_speeds", "0"], ["sv_padPackets", "0"],
    ["sv_maxRate", "0"], ["sv_lanForceRate", "0"], ["sv_allowDownload", "1"], ["sv_pure", "0"]];
  for (const [name, value] of settings) cvars.register(name, value);
  const timeline: string[] = [], prints: string[] = [], packets: Uint8Array[] = [], commandLog: string[] = [];
  const world = new ServerWorldState(statics, { print: text => prints.push(text), dropClient: (client, reason): CallSteps => lifecycle.dropClient(client, reason) });
  world.game = game; world.state = "game";
  const downloads = new ServerDownloadRuntime(statics, { cvars, files: downloadFiles.server, print: text => prints.push(text), debugPrint: text => prints.push(text),
    dropClient: (client, reason): CallSteps => lifecycle.dropClient(client, reason), sendClientGameState: client => lifecycle.sendClientGameState(client) });
  const channel = new ServerNetChannelRuntime(statics, { debugPrint: text => { prints.push(text); }, tracePacket: message => { expect(message).toMatch(/^server send /); }, print: text => prints.push(text), sendPacket: (_address, packet) => { packets.push(new Uint8Array(packet)); timeline.push(`send:${statics.time}`); },
    connectionless: async () => { throw new Error("No connectionless fixture input"); }, executeClientMessage: () => { throw new Error("No client packet fixture input"); } });
  const snapshots = new ServerSnapshotRuntime(world, statics, { collision: game.options.collision, spatial: game.world, debugPrint: text => prints.push(text) });
  const sender = new ServerSnapshotSendRuntime(snapshots, channel, { cvars, downloads, print: text => prints.push(text), isLanAddress: () => true });
  const lifecycle = new ServerClientLifecycleRuntime(world, statics, { cvars, sender, downloads, print: text => prints.push(text), debugPrint: text => prints.push(text),
    sendPacket: () => { throw new Error("Unexpected connectionless admission reply"); }, isLanAddress: () => true });
  const commands = new CommandBuffer({ resolveFallback: resolveSynchronously(context => { commandLog.push(context.raw); }) }), profile = { timeGame: 0 };
  let wallTime = 0;
  const runtime = new ServerFrameRuntime(sender, { cvars, lifecycle, commands, profile,
    *botFrame(time): CallSteps { timeline.push(`bot:${time}`); if (cvars.get("bot_enable")?.integerValue !== 0 && world.game !== null) throw new Error("Enabled bot frame capability unavailable in fixture"); },
    heartbeat: async () => { timeline.push(`heartbeat:${statics.time}`); if (cvars.get("dedicated")?.integerValue === 2) throw new Error("Public heartbeat capability unavailable in fixture"); },
    shutdown: async reason => { timeline.push(`shutdown:${reason}`); game.shutdown(false); world.game = null; world.state = "dead"; cvars.set("sv_running", "0", true); },
    sleep: async msec => { timeline.push(`sleep:${msec}`); }, milliseconds: () => { wallTime += 7; timeline.push(`clock:${wallTime}`); return wallTime; }, debugPrint: text => prints.push(text) });
  const client = at(statics.clients, 0); client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: new Netchannel("server") };
  client.gameEntity = game.data.entity(client.slot); client.lastPacketTime = 1000; client.rate = 4000; client.snapshotMsec = 50;
  for (const serverClient of statics.clients) serverClient.lastPacketTime = 1000;
  const thinker = game.pool.spawn(); thinker.nextthink = 1050; thinker.think = self => { timeline.push(`game:${game.level.time}`); self.nextthink = game.level.time + 50; };
  return { ...harness, game, statics, world, downloads, lifecycle, channel, snapshots, sender, runtime, client, timeline, packets, prints, commands, commandLog, profile };
}

describe("source server frame scheduler", () => {
  test("timeout expires a source-zero Zombie retained by a failed GAME disconnect without a channel", async () => {
    const f = await fixture(), client = at(f.statics.clients, 1), original = client.connection;
    f.game.calls.clientDisconnect = function* (): CallSteps { throw new Error("disconnect failed"); };
    expect(() => finishCalls(f.lifecycle.dropClient(client, "bye"))).toThrow("disconnect failed");
    expect(client.phase).toBe(ServerClientPhase.Zombie);
    expect(client.connection.kind).toBe("uninitialized");
    client.timeoutCount = 7;
    f.statics.time = 2001;
    finishCalls(f.runtime.checkTimeouts());
    expect(client.phase).toBe(ServerClientPhase.Free);
    expect(client.connection).toBe(original);
    expect(client.timeoutCount).toBe(7);
    finishCalls(f.runtime.checkTimeouts());
    expect(client.timeoutCount).toBe(0);
  });

  test("frame awaits each actual game step before advancing the next time and sending snapshots", async () => {
    for (const reject of [false, true]) {
      const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<undefined>();
      const original = f.game.calls.runFrame, failure = new Error("Game frame rejected");
      f.game.calls.runFrame = function* (time): CallSteps {
        if (time === 1050) { entered.resolve(); yield () => gate.promise; }
        yield* original(time);
      };
      const pending = f.runtime.frame(100);
      await entered.promise;
      expect([f.statics.time, f.world.timeResidual, f.game.level.time]).toEqual([1050, 50, 1000]);
      expect(f.packets).toHaveLength(0); expect(f.timeline).toEqual(["bot:1100"]);
      if (reject) {
        gate.reject(failure); await expect(pending).rejects.toBe(failure);
        expect([f.statics.time, f.world.timeResidual, f.game.level.time]).toEqual([1050, 50, 1000]);
        expect(f.packets).toHaveLength(0); expect(f.timeline).toEqual(["bot:1100"]);
      } else {
        gate.resolve(undefined); await pending;
        expect(f.timeline).toEqual(["bot:1100", "game:1050", "game:1100", "send:1100", "heartbeat:1100"]);
      }
    }
  });

  test("timeout retains Zombie until actual game disconnect completes and stops before snapshots on failure", async () => {
    for (const reject of [false, true]) {
      const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<undefined>();
      expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0);
      const original = f.game.calls.clientDisconnect, failure = new Error("Game disconnect rejected");
      f.game.calls.clientDisconnect = function* (slot): CallSteps {
        entered.resolve(); yield () => gate.promise; yield* original(slot);
      };
      f.statics.time = 4001; f.client.timeoutCount = 5;
      const pending = f.runtime.frame(0);
      await entered.promise;
      expect(f.client.phase).toBe(ServerClientPhase.Zombie); expect(f.game.pool.at(0).inuse).toBe(true);
      expect(f.packets).toHaveLength(0); expect(f.timeline).toEqual(["bot:4001"]);
      expect(f.client.reliable.pending().some(command => command.text.startsWith("disconnect "))).toBe(false);
      if (reject) {
        gate.reject(failure); await expect(pending).rejects.toBe(failure);
        expect(f.client.phase).toBe(ServerClientPhase.Zombie); expect(f.game.pool.at(0).inuse).toBe(true);
        expect(f.packets).toHaveLength(0); expect(f.timeline).toEqual(["bot:4001"]);
      } else {
        gate.resolve(undefined); await pending;
        expect(f.client.phase).toBe(ServerClientPhase.Free); expect(f.game.pool.at(0).inuse).toBe(false);
        expect(f.client.reliable.pending().some(command => command.text === 'disconnect "timed out"')).toBe(true);
      }
    }
  });

  test("local and dedicated bot calls suspend frame work at their source positions", async () => {
    for (const dedicated of [false, true]) {
      const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<undefined>();
      f.cvars.set("dedicated", dedicated ? "1" : "0", true);
      const original = f.runtime.host.botFrame;
      f.runtime.host.botFrame = function* (time): CallSteps {
        yield* original(time); entered.resolve(); yield () => gate.promise;
      };
      const pending = f.runtime.frame(50);
      await entered.promise;
      expect(f.timeline).toEqual([dedicated ? "bot:1000" : "bot:1050"]);
      expect(f.statics.time).toBe(1000); expect(f.world.timeResidual).toBe(50); expect(f.packets).toHaveLength(0);
      gate.resolve(undefined); await pending;
      expect(f.timeline.slice(1)).toEqual(["game:1050", "send:1050", "heartbeat:1050"]);
    }
  });

  test("frame awaits actual master DNS after simulation and snapshot sends", async () => {
    const f = await fixture(), gate = Promise.withResolvers<Ipv4Address | null>(), entered = Promise.withResolvers<void>();
    f.cvars.set("dedicated", "2", true);
    for (let index = 1; index <= 5; index++) f.cvars.register(`sv_master${index}`, index === 1 ? "master.example" : "");
    const heartbeat = new ServerConnectionlessRuntime(new ServerNetworkControlState(), {
      cvars: f.cvars, random: new LinuxNativeRandom(1), currentLifecycle: () => f.lifecycle,
      sendPacket: (_address, packet) => { f.packets.push(packet); f.timeline.push("heartbeat:send"); },
      isLanAddress: () => true, resolveAddress: () => { f.timeline.push("heartbeat:dns"); entered.resolve(); return gate.promise; },
      remoteCommand: async () => { throw new Error("Frame does not execute rcon"); },
      print: text => { f.prints.push(text); }, debugPrint: text => { f.prints.push(text); },
    });
    const frame = new ServerFrameRuntime(f.sender, { ...f.runtime.host, heartbeat: () => heartbeat.masterHeartbeat() });
    const pending = frame.frame(50).then(() => { f.timeline.push("caller:continued"); });
    await entered.promise;
    expect(f.timeline).toEqual(["bot:1000", "game:1050", "send:1050", "heartbeat:dns"]);
    expect(f.packets).toHaveLength(1); expect(f.statics.time).toBe(1050);
    gate.resolve({ kind: "ipv4", host: [192, 0, 2, 10], port: 27960 }); await pending;
    expect(f.timeline.slice(-2)).toEqual(["heartbeat:send", "caller:continued"]);
    expect(f.packets).toHaveLength(2);
    f.cvars.set("sv_master1", "failed.example", true); f.statics.nextHeartbeatTime = 0;
    const failure = new Error("master DNS failure"); heartbeat.host.resolveAddress = async () => { throw failure; };
    await expect(frame.frame(50)).rejects.toBe(failure);
    expect(f.statics.time).toBe(1100); expect(f.packets).toHaveLength(3);
    expect(heartbeat.control.connectionlessBusy).toBe(false);
  });

  test("kill awaits shutdown before resetting sv_killserver and rejection preserves it", async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>(); f.cvars.set("sv_killserver", "1", true);
    const frame = new ServerFrameRuntime(f.sender, { ...f.runtime.host, shutdown: async reason => {
      f.timeline.push("shutdown:begin"); await gate.promise; await f.runtime.host.shutdown(reason); f.timeline.push("shutdown:end");
    } });
    const pending = frame.frame(50).then(() => { f.timeline.push("caller:continued"); });
    await Promise.resolve(); expect(f.timeline).toEqual(["shutdown:begin"]);
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(1); expect(f.world.game).toBe(f.game);
    gate.resolve(); await pending;
    expect(f.timeline).toEqual(["shutdown:begin", "shutdown:Server was killed.\n", "shutdown:end", "caller:continued"]);
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(0); expect(f.world.game).toBe(null);
    const rejected = await fixture(), failure = new Error("shutdown failure"); rejected.cvars.set("sv_killserver", "1", true);
    const rejectedFrame = new ServerFrameRuntime(rejected.sender, { ...rejected.runtime.host, shutdown: async () => { throw failure; } });
    await expect(rejectedFrame.frame(50)).rejects.toBe(failure);
    expect(rejected.cvars.get("sv_killserver")?.integerValue).toBe(1); expect(rejected.world.game).toBe(rejected.game);
    expect(rejected.commands.pendingText).toBe(""); expect(rejected.packets).toHaveLength(0);
  });

  test("both source wrap shutdowns complete before nextmap append; rejected shutdown appends nothing", async () => {
    for (const kind of ["time", "entities"]) {
      const f = await fixture(), gate = Promise.withResolvers<void>();
      if (kind === "time") f.statics.time = 0x70000001;
      else f.statics.nextSnapshotEntities = 0x7ffffffe - f.statics.numSnapshotEntities;
      const frame = new ServerFrameRuntime(f.sender, { ...f.runtime.host, shutdown: async reason => {
        f.timeline.push("shutdown:begin"); await gate.promise; await f.runtime.host.shutdown(reason);
      } });
      const pending = frame.frame(50);
      await Promise.resolve(); expect(f.timeline.at(-1)).toBe("shutdown:begin");
      expect(f.commands.pendingText).toBe(""); expect(f.packets).toHaveLength(0);
      gate.resolve(); await pending; expect(f.commands.pendingText).toBe("vstr nextmap\n"); expect(f.world.game).toBe(null);
      const rejected = await fixture(), failure = new Error(`${kind} shutdown rejected`);
      if (kind === "time") rejected.statics.time = 0x70000001;
      else rejected.statics.nextSnapshotEntities = 0x7ffffffe - rejected.statics.numSnapshotEntities;
      const rejectedFrame = new ServerFrameRuntime(rejected.sender, { ...rejected.runtime.host, shutdown: async () => { throw failure; } });
      await expect(rejectedFrame.frame(50)).rejects.toBe(failure);
      expect(rejected.commands.pendingText).toBe(""); expect(rejected.world.game).toBe(rejected.game);
    }
  });

  test("local residual accumulates, bots run at anticipated time, and sends occur even before a simulation step", async () => {
    const f = await fixture(); await f.runtime.frame(20); await f.runtime.frame(105);
    expect(f.timeline).toEqual(["bot:1020", "send:1000", "heartbeat:1000", "bot:1125", "game:1050", "game:1100", "send:1100", "heartbeat:1100"]);
    expect([f.statics.time, f.world.timeResidual, f.game.level.time]).toEqual([1100, 25, 1100]);
  });
  test("dedicated short residual awaits its real sleep boundary and does no work afterward", async () => {
    const f = await fixture(), gate = Promise.withResolvers<void>(); f.cvars.set("dedicated", "1"); f.cvars.set("com_speeds", "1");
    const runtime = new ServerFrameRuntime(f.sender, { ...f.runtime.host, sleep: msec => { f.timeline.push(`sleep:${msec}`); return gate.promise; } });
    let settled = false; const pending = runtime.frame(20).then(() => { settled = true; }); await Promise.resolve();
    expect(settled).toBe(false); expect(f.timeline).toEqual(["sleep:30"]); expect(f.world.snapshotCounter).toBe(0);
    gate.resolve(); await pending; await runtime.frame(105);
    expect(f.timeline).toEqual(["sleep:30", "clock:7", "bot:1000", "game:1050", "game:1100", "clock:14", "send:1100", "heartbeat:1100"]);
    expect([f.statics.time, f.world.timeResidual, f.profile.timeGame]).toEqual([1100, 25, 7]);
  });
  test("fps clamps below one; zero-step fps rejects after source bot/ping effects", async () => {
    const f = await fixture(); f.cvars.set("sv_fps", "0"); await f.runtime.frame(100); expect(f.cvars.get("sv_fps")?.integerValue).toBe(10); expect(f.game.level.time).toBe(1100);
    const invalid = await fixture(); invalid.cvars.set("sv_fps", "1001"); invalid.client.ping = 17;
    await expect(invalid.runtime.frame(10)).rejects.toThrow("zero-length"); expect(invalid.world.timeResidual).toBe(10); expect(invalid.timeline).toEqual(["bot:1010"]); expect(invalid.client.ping).toBe(999);
    expect(invalid.game.level.time).toBe(1000); expect(invalid.world.snapshotCounter).toBe(0);
  });
  test("pause counts connected humans, excludes address bots, and leaves sv_paused stale when cl_paused clears", async () => {
    const f = await fixture(); f.cvars.set("cl_paused", "1"); await f.runtime.frame(100); expect(f.cvars.get("sv_paused")?.integerValue).toBe(1); expect(f.world.timeResidual).toBe(0);
    const second = at(f.statics.clients, 1); second.connection = { kind: "initialized", phase: ServerClientPhase.Connected, address: { kind: "bot" }, netchan: new Netchannel("server") };
    expect(f.runtime.checkPaused()).toBe(true); connection(second).address = { kind: "loopback" }; expect(f.runtime.checkPaused()).toBe(false); expect(f.cvars.get("sv_paused")?.integerValue).toBe(0);
    connection(second).phase = ServerClientPhase.Zombie; expect(f.runtime.checkPaused()).toBe(true); f.cvars.set("cl_paused", "0"); expect(f.runtime.checkPaused()).toBe(false); expect(f.cvars.get("sv_paused")?.integerValue).toBe(1);
  });
  test("kill has priority over running/pause and preserves reset order; stopped servers accumulate nothing", async () => {
    const f = await fixture(); f.cvars.set("sv_running", "0"); await f.runtime.frame(100); expect(f.timeline).toEqual([]); expect(f.world.timeResidual).toBe(0);
    f.cvars.set("sv_killserver", "1"); f.cvars.set("cl_paused", "1"); await f.runtime.frame(100); expect(f.timeline).toEqual(["shutdown:Server was killed.\n"]);
    expect(f.cvars.get("sv_killserver")?.integerValue).toBe(0); expect(f.world.game).toBeNull();
  });
  test("time/ring wrap and scheduled restart append actual commands before any game frame or snapshot", async () => {
    const time = await fixture(); time.statics.time = 0x70000001; await time.runtime.frame(50); time.commands.execute();
    expect(time.commandLog).toEqual(["vstr nextmap"]); expect(time.timeline).toEqual(["bot:1879048243", "shutdown:Restarting server due to time wrapping"]);
    const ring = await fixture(); ring.statics.nextSnapshotEntities = 0x7ffffffe - ring.statics.numSnapshotEntities; await ring.runtime.frame(50); ring.commands.execute();
    expect(ring.commandLog).toEqual(["vstr nextmap"]); expect(ring.world.snapshotCounter).toBe(0);
    const restart = await fixture(); restart.world.restartTime = 1000; await restart.runtime.frame(50); restart.commands.execute();
    expect(restart.commandLog).toEqual(["map_restart 0"]); expect(restart.world.restartTime).toBe(0); expect(restart.world.timeResidual).toBe(50); expect(restart.timeline).toEqual(["bot:1050"]);
  });
  test("dedicated short residual returns before lifetime restart, and exact time threshold still runs", async () => {
    const f = await fixture(); f.cvars.set("dedicated", "1"); f.statics.time = 0x70000001; await f.runtime.frame(1); expect(f.timeline).toEqual(["sleep:49"]);
    const exact = await fixture(); exact.statics.time = 0x70000000; await exact.runtime.frame(0); expect(exact.world.game).not.toBeNull(); expect(exact.timeline.some(entry => entry.startsWith("shutdown"))).toBe(false);
  });
  test("source ping averages all positive ACKs with signed integer arithmetic, only updating human active player state", async () => {
    const f = await fixture(); f.game.pool.clientAt(0).ps.ping = 73;
    at(f.client.frames, 0).messageAcked = 101; at(f.client.frames, 1).messageAcked = 104;
    f.runtime.calculatePings(); expect([f.client.ping, f.game.pool.clientAt(0).ps.ping]).toEqual([102, 102]);
    at(f.client.frames, 0).messageAcked = 1; at(f.client.frames, 0).messageSent = 4; at(f.client.frames, 1).messageAcked = 2;
    f.runtime.calculatePings(); expect(f.client.ping).toBe(0); expect(Object.is(f.client.ping, -0)).toBe(false);
    at(f.client.frames, 0).messageSent = -0x7fffffff; at(f.client.frames, 0).messageAcked = 1; at(f.client.frames, 1).messageAcked = -1;
    f.runtime.calculatePings(); expect(f.client.ping).toBe(-2147483648);
    at(f.client.frames, 0).messageSent = 0; at(f.client.frames, 0).messageAcked = 2000; f.runtime.calculatePings(); expect(f.client.ping).toBe(999);
    f.game.pool.at(0).r.svFlags |= ServerEntityFlags.BOT; f.game.pool.clientAt(0).ps.ping = 73; f.runtime.calculatePings(); expect([f.client.ping, f.game.pool.clientAt(0).ps.ping]).toEqual([0, 73]);
    f.client.gameEntity = null; f.runtime.calculatePings(); expect([f.client.ping, f.game.pool.clientAt(0).ps.ping]).toEqual([999, 73]);
  });
  test("timeouts preserve strict thresholds, six-check grace, real disconnect, and zombie/free count order", async () => {
    const f = await fixture(); expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0);
    f.statics.time = 3000; finishCalls(f.runtime.checkTimeouts()); expect(f.client.timeoutCount).toBe(0); f.statics.time = 4001;
    const zombie = at(f.statics.clients, 1); zombie.connection = { kind: "initialized", phase: ServerClientPhase.Zombie, address: { kind: "loopback" }, netchan: new Netchannel("server") }; zombie.timeoutCount = 3;
    const future = at(f.statics.clients, 2); future.lastPacketTime = 9000;
    for (let count = 1; count <= 5; count++) { finishCalls(f.runtime.checkTimeouts()); expect(f.client.timeoutCount).toBe(count); expect(f.client.phase).toBe(ServerClientPhase.Active); expect(zombie.timeoutCount).toBe(count === 1 ? 3 : 0); }
    expect(future.lastPacketTime).toBe(4001); finishCalls(f.runtime.checkTimeouts()); expect(f.client.phase).toBe(ServerClientPhase.Free); expect(f.client.timeoutCount).toBe(6);
    expect(f.client.reliable.pending().some(command => command.text === 'disconnect "timed out"')).toBe(true); expect(f.game.pool.at(0).inuse).toBe(false);
    finishCalls(f.runtime.checkTimeouts()); expect(f.client.timeoutCount).toBe(0);
  });
  test("timeout recovery clears grace and zombie equality does not expire", async () => {
    const f = await fixture(); f.statics.time = 4001; finishCalls(f.runtime.checkTimeouts()); expect(f.client.timeoutCount).toBe(1); f.client.lastPacketTime = 4001;
    finishCalls(f.runtime.checkTimeouts()); expect(f.client.timeoutCount).toBe(0); connection(f.client).phase = ServerClientPhase.Zombie; f.client.lastPacketTime = 3001;
    finishCalls(f.runtime.checkTimeouts()); expect(f.client.phase).toBe(ServerClientPhase.Zombie); f.statics.time++; finishCalls(f.runtime.checkTimeouts()); expect(f.client.phase).toBe(ServerClientPhase.Free);
  });
  test("info flags update canonical configstrings in order and retain unrelated flags", async () => {
    const f = await fixture(); f.cvars.register("frameServer", "old", CvarFlag.ServerInfo); f.cvars.register("frameSystem", "old", CvarFlag.SystemInfo); f.cvars.register("frameArchive", "old", CvarFlag.Archive);
    f.cvars.set("frameServer", "new"); f.cvars.set("frameSystem", "x".repeat(1100)); f.cvars.set("frameArchive", "new");
    await f.runtime.frame(0); expect(f.world.configstrings.get(0)).toContain("\\frameServer\\new"); expect(f.world.configstrings.get(1)).toContain("x".repeat(1100));
    expect(f.cvars.modifiedFlags & (CvarFlag.ServerInfo | CvarFlag.SystemInfo)).toBe(0); expect(f.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
    const commands = f.client.reliable.pending().map(command => command.text); const server = commands.findIndex(command => command.startsWith('cs 0 ')); const system = commands.findIndex(command => command.startsWith('bcs0 1 '));
    expect(server).toBeGreaterThanOrEqual(0); expect(system).toBeGreaterThan(server);
  });
  test("configstring-triggered disconnect changes system info before the later source flag check", async () => {
    const f = await fixture(); expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0);
    f.cvars.register("duringServer", "old", CvarFlag.ServerInfo); f.cvars.register("duringSystem", "old", CvarFlag.SystemInfo);
    f.cvars.takeModifiedFlags(); f.cvars.set("duringServer", "published");
    for (let index = 0; index < 64; index++) f.client.reliable.add(`print ${index}`);
    f.lifecycle.host.debugPrint = text => {
      f.prints.push(text);
      if (text.startsWith("Going to CS_ZOMBIE")) { f.cvars.set("duringServer", "after-publication"); f.cvars.set("duringSystem", "during-disconnect"); }
    };
    await f.runtime.frame(0);
    expect(f.client.phase).toBe(ServerClientPhase.Zombie); expect(f.world.configstrings.get(0)).toContain("\\duringServer\\published");
    expect(f.world.configstrings.get(1)).toContain("\\duringSystem\\during-disconnect");
    expect(f.cvars.modifiedFlags & (CvarFlag.ServerInfo | CvarFlag.SystemInfo)).toBe(0);
  });
  test("configstring overflow awaits game disconnect before clearing server flags or publishing system info", async () => {
    for (const reject of [false, true]) {
      const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<undefined>();
      expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0);
      f.cvars.register("waitServer", "old", CvarFlag.ServerInfo); f.cvars.register("waitSystem", "old", CvarFlag.SystemInfo);
      f.cvars.takeModifiedFlags(); f.cvars.set("waitServer", "published");
      for (let index = 0; index < 64; index++) f.client.reliable.add(`print ${index}`);
      const original = f.game.calls.clientDisconnect, failure = new Error("Configstring disconnect rejected");
      f.game.calls.clientDisconnect = function* (slot): CallSteps {
        entered.resolve(); yield () => gate.promise;
        f.cvars.set("waitSystem", "after-disconnect"); yield* original(slot);
      };
      const pending = f.runtime.frame(0);
      await entered.promise;
      expect(f.world.configstrings.get(0)).toContain("\\waitServer\\published");
      expect(f.world.configstrings.get(1)).not.toContain("\\waitSystem\\after-disconnect");
      expect(f.cvars.modifiedFlags & CvarFlag.ServerInfo).toBe(CvarFlag.ServerInfo);
      expect(f.packets).toHaveLength(0);
      if (reject) {
        gate.reject(failure); await expect(pending).rejects.toBe(failure);
        expect(f.cvars.modifiedFlags & CvarFlag.ServerInfo).toBe(CvarFlag.ServerInfo);
        expect(f.world.configstrings.get(1)).not.toContain("\\waitSystem\\after-disconnect");
        expect(f.packets).toHaveLength(0);
      } else {
        gate.resolve(undefined); await pending;
        expect(f.world.configstrings.get(1)).toContain("\\waitSystem\\after-disconnect");
        expect(f.cvars.modifiedFlags & (CvarFlag.ServerInfo | CvarFlag.SystemInfo)).toBe(0);
      }
    }
  });
  test("profiling rereads com_speeds after actual game thinks and retains its previous value when disabled", async () => {
    const f = await fixture(); f.profile.timeGame = 91;
    const toggle = f.game.pool.spawn(); toggle.nextthink = 1050; toggle.think = () => { f.cvars.set("com_speeds", "1"); };
    await f.runtime.frame(50); expect(f.profile.timeGame).toBe(7); expect(f.timeline.filter(entry => entry.startsWith("clock:"))).toEqual(["clock:7"]);
    f.cvars.set("com_speeds", "0"); await f.runtime.frame(50); expect(f.profile.timeGame).toBe(7);
  });
  test("missing enabled bot and public heartbeat capabilities fail visibly at their source stages", async () => {
    const bot = await fixture(); bot.cvars.set("bot_enable", "1"); await expect(bot.runtime.frame(50)).rejects.toThrow("bot frame capability"); expect(bot.game.level.time).toBe(1000);
    const heartbeat = await fixture(); heartbeat.cvars.set("dedicated", "2"); await expect(heartbeat.runtime.frame(50)).rejects.toThrow("heartbeat capability");
    expect(heartbeat.game.level.time).toBe(1050); expect(heartbeat.packets.length).toBeGreaterThan(0);
  });
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} retail frame residuals run actual game and publish independent wire snapshots`, async () => {
      const assets = await VirtualFileSystem.openInspection({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", cdPath: null, product });
      const f = await fixture(product, parseBsp(await assets.read(`maps/${product === "baseq3" ? "q3dm1" : "mpteam1"}.bsp`)));
      expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0); f.snapshots.createBaselines(); const baseline = f.world.baselines.map(entity => entity.copy());
      const receiver = new Netchannel("client"), history = new SnapshotHistory(); let parseEntitiesNumber = 0, delivered = 0;
      for (const delta of [17, 33, 125]) {
        f.client.deltaMessage = delivered; await f.runtime.frame(delta);
        while (connection(f.client).netchan.hasUnsentFragments) f.channel.transmitNextFragment(f.client);
        for (const packet of f.packets.splice(0)) {
          const result = receiver.receive(packet); if (result.kind === "rejected") throw new Error(result.reason);
          if (result.kind !== "accepted") continue;
          const message = decodeServerMessage(xorServerMessage(result.payload, f.client.challenge, result.sequence, f.client.lastClientCommandString), {
            product, messageNumber: result.sequence, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber, baseline: number => at(baseline, number), history: number => history.readSlot(number) });
          parseEntitiesNumber = message.parseEntitiesNumber; const snapshot = message.operations.find(operation => operation.kind === "snapshot"); if (snapshot?.kind !== "snapshot") throw new Error("No frame snapshot");
          expect(history.publish(snapshot)).toBe(true); expect(snapshot.snapshot.serverTime).toBe(f.statics.time); expect(snapshot.snapshot.playerState.origin).toEqual(f.game.pool.clientAt(0).ps.origin); delivered++;
        }
      }
      expect([f.statics.time, f.world.timeResidual, f.game.level.time, delivered]).toEqual([1150, 25, 1150, 3]);
      const saved = history.latest; if (saved === null) throw new Error("No client history"); const origin = { ...saved.playerState.origin }; f.game.pool.clientAt(0).ps.origin = vec3(999, 999, 999);
      expect(history.latest?.playerState.origin).toEqual(origin);
    });
  }
});
