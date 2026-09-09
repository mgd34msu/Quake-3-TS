import { afterEach, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { finishCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { Ipv4Address } from "../src/platform/network.ts";
import { decodeConnectionless, encodeConnect, encodeConnectionlessText } from "../src/protocol/connectionless.ts";
import { ServerClientLifecycleRuntime } from "../src/server/client-lifecycle.ts";
import { registerServerCvars } from "../src/server/config.ts";
import { addServerCommand } from "../src/server/configstrings.ts";
import { ServerConnectionlessRuntime } from "../src/server/connectionless.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import type { ServerGameDenial } from "../src/server/game.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import { ServerNetworkControlState } from "../src/server/network-control.ts";
import type { ServerPacketAddress } from "../src/server/net-channel.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import type { ServerAddress, ServerClient } from "../src/server/state.ts";
import { PersistentIndex } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing fixture slot ${index}`); return value;
}
const remote: Ipv4Address = { kind: "ipv4", host: [203, 0, 113, 9], port: 27961 };
const lan: Ipv4Address = { kind: "ipv4", host: [10, 0, 0, 9], port: 27961 };
const authorizeAddress: Ipv4Address = { kind: "ipv4", host: [192, 0, 2, 10], port: 27952 };
function text(bytes: Uint8Array): string { return [...bytes.subarray(4)].map(byte => String.fromCharCode(byte)).join(""); }
const downloadFileOwners: CommonFileState[] = [];
afterEach(() => { for (const files of downloadFileOwners.splice(0)) files.close(); });

async function fixture(product: Product = "baseq3") {
  const statics = new ServerStaticState({ product, maxClients: 3, dedicated: false }), cvars = new CvarRegistry();
  const downloadFiles = new CommonFileState({ homePath: process.cwd(), dataPath: process.cwd(), cdPath: null, product: "baseq3" },
    () => undefined, new SoundOutput(), cvars);
  downloadFileOwners.push(downloadFiles);
  await downloadFiles.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  registerServerCvars(cvars);
  for (const [key, value] of [["sv_maxclients", "3"], ["dedicated", "0"], ["sv_pure", "0"], ["sv_hostname", "Fixture"], ["mapname", "q3dm1"],
    ["sv_privateClients", "1"], ["sv_privatePassword", "secret"], ["g_log", ""], ["bot_enable", "0"], ["g_doWarmup", "0"]] satisfies readonly (readonly [string, string])[]) cvars.set(key, value, true);
  const events: string[] = [], packets: { address: ServerPacketAddress; payload: Uint8Array }[] = [];
  const print = (value: string): void => { events.push(`print:${value}`); };
  const debugPrint = (value: string): void => { events.push(`debug:${value}`); };
  const sendPacket = (address: ServerPacketAddress, payload: Uint8Array): undefined => { packets.push({ address, payload: new Uint8Array(payload) }); };
  const isLanAddress = (address: ServerAddress): boolean => address.kind === "loopback" || address.kind === "ipv4" && address.host[0] === 10;
  const client = (slot: number): ServerClient => at(statics.clients, slot);
  const dropClient = (value: ServerClient, reason: string): CallSteps => currentLifecycle.dropClient(value, reason);
  const sendClientGameState = (value: ServerClient): void => { currentLifecycle.sendClientGameState(value); };
  function snapshotHost(target: ServerWorldState) {
    function directGame(): GameRuntime {
      const game = target.game;
      if (!(game instanceof GameRuntime)) throw new Error("Connectionless snapshot fixture requires a direct game");
      return game;
    }
    return { get collision() { return directGame().options.collision; }, get spatial() { return directGame().world; }, debugPrint };
  }
  const world = new ServerWorldState(statics, { print, dropClient });
  const downloads = new ServerDownloadRuntime(statics, { cvars, files: downloadFiles.server, print, debugPrint, dropClient, sendClientGameState });
  const channel = new ServerNetChannelRuntime(statics, { debugPrint: text => { debugPrint(text); }, tracePacket: message => { expect(message).toMatch(/^server send /); }, print, sendPacket,
    connectionless: () => { throw new Error("This fixture awaits the async connectionless receiver directly"); },
    executeClientMessage: () => { throw new Error("Sequenced movement is outside connectionless fixture"); } });
  const sender = new ServerSnapshotSendRuntime(new ServerSnapshotRuntime(world, statics, snapshotHost(world)), channel, { cvars, downloads, print, isLanAddress });
  const lifecycle = new ServerClientLifecycleRuntime(world, statics, { cvars, downloads, sender, print, debugPrint, sendPacket, isLanAddress });
  let currentLifecycle = lifecycle;
  const random = new LinuxNativeRandom(1);
  let resolver: (name: string, port: number) => Promise<Ipv4Address | null> = async (_name, port) => ({ ...authorizeAddress, port });
  const control = new ServerNetworkControlState();
  const runtime = new ServerConnectionlessRuntime(control, { cvars, random, print, debugPrint, sendPacket, isLanAddress, currentLifecycle: () => currentLifecycle,
    resolveAddress: async (name, port) => { events.push(`dns:${name}:${port}`); return await resolver(name, port); },
    remoteCommand: async (from, bytes, decoded) => { events.push(`rcon:${from.kind}:${text(bytes)}:${decoded.line}`); } });
  const map = parseBsp(renderBspFixture([{ shader: "fixture", lightmap: -1 }, { shader: "fixture", lightmap: -1 }], []));
  statics.time = 1000; world.state = "loading";
  function createGame(target: ServerWorldState): GameRuntime {
    const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
    const spatial = new ServerWorld(collision, collision.modelBounds(0), number => target.game?.data.entity(number), { get loading() { return target.state === "loading"; }, print: text => { print(text); }, developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) print(text); } });
    return GameRuntime.create({ product, map, collision, world: spatial, levelTime: 1000,
    randomSeed: 17, restart: false, buildDate: "fixture", cvars, configstrings: target.configstrings,
    engine: { milliseconds: () => statics.time, print, getUserinfo: slot => client(slot).userinfo, setUserinfo: (slot, value) => { currentLifecycle.setUserinfo(slot, value); },
      getUserCommand: slot => client(slot).lastUsercmd, dropClient: (slot, reason) => { finishCalls(currentLifecycle.dropClient(client(slot), reason)); },
      sendServerCommand: (slot, command) => {
        if (slot === -1) { for (const value of statics.clients) if (value.phase >= ServerClientPhase.Primed) finishCalls(addServerCommand(value, command, { print, dropClient })); }
        else finishCalls(addServerCommand(client(slot), command, { print, dropClient }));
      }, appendConsoleCommand: command => { events.push(`console:${command}`); },
      insertConsoleCommand: command => { events.push(`console-insert:${command}`); }, executeConsoleNow: command => { events.push(`execute:${command}`); },
      openLog: () => { throw new Error("Fixture logging disabled"); } },
    botFactory: { kind: "unavailable", reason: "Connectionless fixture has human clients only" },
    }, target); }
  const game = createGame(world);
  world.state = "game";
  async function query(command: string, from: ServerPacketAddress = remote): Promise<void> { await runtime.process(from, encodeConnectionlessText(command)); }
  async function connect(address: ServerPacketAddress, name: string, password: string): Promise<void> {
    await query("getchallenge", address);
    const response = decodeConnectionless(at(packets, packets.length - 1).payload, "client");
    if (response.command !== "challengeResponse") throw new Error("Missing challenge response");
    await runtime.process(address, encodeConnect(`\\protocol\\68\\qport\\700\\challenge\\${at(response.arguments, 0)}\\name\\${name}\\password\\${password}\\model\\sarge/default`));
  }
  return { statics, world, cvars, game, client, random, runtime, lifecycle, control, packets, events, query, connect, sendPacket,
    setResolver(value: typeof resolver) { resolver = value; },
    replaceSession() {
      const replacement = new ServerStaticState({ product, maxClients: 3, dedicated: false });
      const target = new ServerWorldState(replacement, { print, dropClient });
      const nextDownloads = new ServerDownloadRuntime(replacement, { ...downloads.host });
      const nextChannel = new ServerNetChannelRuntime(replacement, channel.host);
      const nextSender = new ServerSnapshotSendRuntime(new ServerSnapshotRuntime(target, replacement, snapshotHost(target)), nextChannel, { cvars, downloads: nextDownloads, print, isLanAddress });
      currentLifecycle = new ServerClientLifecycleRuntime(target, replacement, { cvars, downloads: nextDownloads, sender: nextSender, print, debugPrint, sendPacket, isLanAddress });
      return replacement;
    },
    replaceWorld() {
      const replacement = new ServerWorldState(statics, { print, dropClient });
      const replacementSender = new ServerSnapshotSendRuntime(new ServerSnapshotRuntime(replacement, statics, snapshotHost(replacement)), channel, { cvars, downloads, print, isLanAddress });
      currentLifecycle = new ServerClientLifecycleRuntime(replacement, statics, { cvars, downloads, sender: replacementSender, print, debugPrint, sendPacket, isLanAddress });
      createGame(replacement); replacement.state = "game";
      return replacement;
    } };
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: actual challenge/compressed-connect lifecycle feeds native info and status fields`, async () => {
    const f = await fixture(product);
    await f.connect(lan, "Private", "secret");
    await f.connect({ kind: "ipv4", host: [10, 0, 0, 10], port: 27962 }, "Public", "");
    expect(f.client(0).phase).toBe(ServerClientPhase.Connected); expect(f.client(1).phase).toBe(ServerClientPhase.Connected);
    expect(at(f.statics.challenges, 0).connected).toBe(true);
    const first = f.game.pool.at(0).client, second = f.game.pool.at(1).client;
    if (first === null || second === null) throw new Error("Missing real game clients");
    first.ps.persistant.set(PersistentIndex.PERS_SCORE, 9); second.ps.persistant.set(PersistentIndex.PERS_SCORE, -3);
    f.client(0).ping = 7; f.client(1).ping = 42; f.packets.length = 0;
    await f.query("getinfo abc");
    // Untouched SVC_Info native packet from /tmp/q3-server-connectionless-YWMZkN, both products.
    expect(text(at(f.packets, 0).payload)).toBe("infoResponse\n\\pure\\0\\gametype\\0\\sv_maxclients\\2\\clients\\1\\mapname\\q3dm1\\hostname\\Fixture\\protocol\\68\\challenge\\abc");
    await f.query("getstatus abc");
    const status = text(at(f.packets, 1).payload), lines = status.split("\n");
    expect(lines.slice(2).join("\n")).toBe('9 7 "Private"\n-3 42 "Public"\n');
    expect(infoValueForKey(at(lines, 1), "challenge", 1024)).toBe("abc");
    f.cvars.set("fs_restrict", "1", true); f.cvars.set("sv_keywords", "tag", true); await f.query("getstatus def");
    expect(infoValueForKey(at(text(at(f.packets, 2).payload).split("\n"), 1), "sv_keywords", 1024)).toBe("demo tag");
  });
}

test("native challenge value, exact address/port reuse and RNG draw order", async () => {
  const f = await fixture(); await f.query("getchallenge", lan); await f.query("getchallenge", lan);
  expect(f.packets.map(packet => text(packet.payload))).toEqual(["challengeResponse 1998331950", "challengeResponse 1998331950"]);
  expect(f.random.next()).toBe(1681692777);
  await f.query("getchallenge", { ...lan, port: 27962 });
  expect(text(at(f.packets, 2).payload)).toBe("challengeResponse 1019469753");
  f.statics.time = 1200; await f.query("getchallenge", lan);
  expect(at(f.statics.challenges, 0).firstTime).toBe(1000); expect(at(f.statics.challenges, 0).time).toBe(1000); expect(at(f.statics.challenges, 0).pingTime).toBe(1200);
});

test("compressed connect waits for actual game admission before publishing Connected and its reply", async () => {
  for (const reject of [false, true]) {
    const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<undefined>();
    const original = f.game.calls.clientConnect, failure = new Error("Game admission rejected");
    f.game.calls.clientConnect = function* (slot, firstTime, isBot): CallSteps<ServerGameDenial | null> {
      entered.resolve();
      yield () => gate.promise;
      return yield* original(slot, firstTime, isBot);
    };
    const pending = f.connect(lan, "Waiting", "secret");
    await entered.promise;
    expect(f.client(0).phase).toBe(ServerClientPhase.Free);
    expect(f.client(0).gameEntity).toBe(f.game.data.entity(0));
    expect(f.packets.map(packet => text(packet.payload))).toEqual(["challengeResponse 1998331950"]);
    expect(f.control.connectionlessBusy).toBe(true);
    if (reject) {
      gate.reject(failure); await expect(pending).rejects.toBe(failure);
      expect(f.client(0).phase).toBe(ServerClientPhase.Free);
      expect(f.packets).toHaveLength(1);
    } else {
      gate.resolve(undefined); await pending;
      expect(f.client(0).phase).toBe(ServerClientPhase.Connected);
      expect(text(at(f.packets, 1).payload)).toBe("connectResponse");
      expect(f.game.pool.clientAt(0).pers.netname).toBe("Waiting");
    }
    expect(f.control.connectionlessBusy).toBe(false);
  }
});

test("authorization DNS cache, strict5000ms boundary, source game name and port", async () => {
  const f = await fixture(); await f.query("getchallenge");
  expect(f.events).toContain("dns:authorize.quake3arena.com:27952");
  expect(at(f.packets, 0).address).toEqual(authorizeAddress);
  expect(text(at(f.packets, 0).payload)).toBe("getIpAuthorize 1998331950 203.0.113.9 baseq3 0 1");
  f.statics.time = 6000; await f.query("getchallenge"); expect(text(at(f.packets, 1).payload)).toStartWith("getIpAuthorize ");
  f.statics.time = 6001; await f.query("getchallenge"); expect(text(at(f.packets, 2).payload)).toBe("challengeResponse 1998331950");
  expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(1);
  f.cvars.set("fs_game", "missionpack", true); f.statics.time = 7000;
  await f.query("getchallenge", { ...remote, port: 27962 }); expect(text(at(f.packets, 3).payload)).toContain(" missionpack 0 1");
});

test("failed authorization DNS is not retried and still permits eventual timeout", async () => {
  const f = await fixture(); f.setResolver(async () => null);
  await f.query("getchallenge"); await f.query("getchallenge"); expect(f.packets).toHaveLength(0);
  f.statics.time = 6001; await f.query("getchallenge"); expect(text(at(f.packets, 0).payload)).toBe("challengeResponse 1998331950");
  expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(1);
});

test("ban authorization shares successful and failed challenge caches in both directions", async () => {
  for (const first of ["ban", "challenge"]) {
    for (const success of [false, true]) {
      const f = await fixture(); await f.connect(lan, "Target", "secret");
      const client = f.client(0), before = { phase: client.phase, time: client.lastPacketTime, reliable: client.reliable.sequence };
      f.packets.length = 0; f.events.length = 0;
      f.setResolver(async () => success ? { ...authorizeAddress, port: 1 } : null);
      if (first === "ban") { await f.runtime.banUser(client); await f.query("getchallenge"); }
      else { await f.query("getchallenge"); await f.runtime.banUser(client); }
      expect(f.events.filter(event => event.startsWith("dns:"))).toEqual(["dns:authorize.quake3arena.com:27952"]);
      expect(f.statics.authorizeAddress).toEqual(success ? { kind: "resolved", address: authorizeAddress } : { kind: "failed" });
      const bans = f.packets.filter(packet => text(packet.payload).startsWith("banUser"));
      expect(bans.map(packet => text(packet.payload))).toEqual(success ? ["banUser 10.0.0.9"] : []);
      if (success) expect(at(bans, 0).address).toEqual(authorizeAddress);
      expect(f.events.filter(event => event.includes("was banned"))).toEqual(success ? ["print:Target was banned from coming back\n"] : []);
      expect({ phase: client.phase, time: client.lastPacketTime, reliable: client.reliable.sequence }).toEqual(before);
    }
  }
});

test("ban DNS and send preserve source print ordering and reached client reads", async () => {
  const f = await fixture(); await f.connect(lan, "Before", "secret");
  const client = f.client(0), trace: string[] = [], print = f.runtime.host.print;
  f.runtime.host.print = value => { trace.push(value); print(value); };
  f.setResolver(async (name, port) => {
    trace.push(`dns:${name}:${port}`);
    if (client.connection.kind !== "initialized") throw new Error("Expected actual admitted client");
    client.connection.address = remote;
    client.name = "After DNS";
    return authorizeAddress;
  });
  f.runtime.host.sendPacket = (address, payload) => {
    trace.push(`send:${text(payload)}:${client.name}`); f.sendPacket(address, payload); client.name = "After send";
  };
  await f.runtime.banUser(client);
  expect(trace).toEqual([
    "Resolving authorize.quake3arena.com\n", "dns:authorize.quake3arena.com:27952",
    "authorize.quake3arena.com resolved to 192.0.2.10:27952\n", "send:banUser 203.0.113.9:After DNS",
    "After send was banned from coming back\n",
  ]);
});

test("ban retries zero-first-octet cache addresses and sends retained bot bytes", async () => {
  const f = await fixture(), client = f.client(0);
  client.name = "Fresh bot"; client.connection.phase = ServerClientPhase.Zombie;
  f.statics.authorizeAddress = { kind: "resolved", address: { kind: "ipv4", host: [0, 1, 2, 3], port: 27952 } };
  await f.runtime.banUser(client);
  expect(text(at(f.packets, 0).payload)).toBe("banUser 0.0.0.0");
  client.retainedBotAddressIp = [198, 51, 100, 17];
  await f.runtime.banUser(client);
  expect(text(at(f.packets, 1).payload)).toBe("banUser 198.51.100.17");
  expect(f.events.filter(event => event.startsWith("dns:"))).toHaveLength(1);
  expect(client.phase).toBe(ServerClientPhase.Zombie);
  client.connection.phase = ServerClientPhase.Free;
  await f.connect(lan, "New human", "secret");
  expect(f.client(0)).toBe(client); expect(client.retainedBotAddressIp).toEqual([0, 0, 0, 0]);
});

test("ban resolver rejection and escaped rcon ownership cannot publish cache or packets", async () => {
  const f = await fixture(); await f.connect(lan, "Target", "secret"); f.packets.length = 0;
  const failure = new Error("authored resolver rejection");
  f.setResolver(async () => { throw failure; });
  await expect(f.runtime.banUser(f.client(0))).rejects.toBe(failure);
  expect(f.control.connectionlessBusy).toBe(false); expect(f.statics.authorizeAddress).toEqual({ kind: "unresolved" });
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<Ipv4Address | null>();
  f.setResolver(() => { entered.resolve(); return gate.promise; });
  const child: { result: Promise<void> | null } = { result: null };
  await expect(f.control.runRcon(async () => {
    child.result = f.runtime.banUser(f.client(0)); await entered.promise;
  })).rejects.toThrow("Nested server network operations must be awaited");
  await expect(f.query("getchallenge")).rejects.toThrow("awaited in source order");
  gate.resolve(authorizeAddress);
  if (child.result === null) throw new Error("Missing pending ban");
  await expect(child.result).rejects.toThrow("closed server network operation");
  expect(f.statics.authorizeAddress).toEqual({ kind: "unresolved" }); expect(f.packets).toEqual([]);
  expect(f.control.connectionlessBusy).toBe(false);
  await expect(f.control.runConnectionless(() => f.runtime.banUser(f.client(0)))).rejects.toThrow("invalid nested operation");
  await expect(f.control.runBan(() => f.control.runHeartbeat(async () => undefined))).rejects.toThrow("invalid nested operation");
});

test("authorization accepts base address regardless of port, rejects spoof, and clears negative responses", async () => {
  const f = await fixture(); await f.query("getchallenge"); f.packets.length = 0;
  await f.query("ipAuthorize 1998331950 accept", remote); expect(f.packets).toHaveLength(0);
  await f.query("ipAuthorize 1998331950 AcCePt", { ...authorizeAddress, port: 1 }); expect(text(at(f.packets, 0).payload)).toBe("challengeResponse 1998331950");
  await f.query("ipAuthorize 1998331950 unknown", authorizeAddress); expect(text(at(f.packets, 1).payload)).toBe("print\n\n");
  expect(at(f.statics.challenges, 0)).toEqual({ address: null, challenge: 0, time: 0, pingTime: 0, firstTime: 0, connected: false });
  await f.query("ipAuthorize 1998331950 accept", authorizeAddress); expect(f.packets).toHaveLength(2);
});

test("demo authorization restrict branch and reason source byte sanitization", async () => {
  const f = await fixture(); await f.query("getchallenge"); f.packets.length = 0;
  f.cvars.set("fs_restrict", "1", true); await f.query("ipAuthorize 1998331950 demo", authorizeAddress);
  expect(text(at(f.packets, 0).payload)).toBe("challengeResponse 1998331950");
  f.cvars.set("fs_restrict", "0", true); await f.query("ipAuthorize 1998331950 demo", authorizeAddress);
  expect(text(at(f.packets, 1).payload)).toBe("print\nServer is not a demo server\n");
  await f.query("getchallenge"); const value = at(f.statics.challenges, 0).challenge;
  await f.query(`ipAuthorize ${value} deny "bad %s é"`, authorizeAddress);
  expect(text(at(f.packets, f.packets.length - 1).payload)).toBe("print\nbad .s é\n");
});

test("single-player privacy differs for status versus info and challenge; unknown/disconnect are harmless", async () => {
  const f = await fixture(); f.cvars.set("ui_singlePlayerActive", "1", true);
  await f.query("getinfo x"); await f.query("getchallenge"); expect(f.packets).toHaveLength(0);
  await f.query("getstatus x"); expect(f.packets).toHaveLength(1);
  f.cvars.set("g_gametype", "2", true); await f.query("getstatus x"); expect(f.packets).toHaveLength(1);
  await f.query("disconnect"); await f.query("extension unknown\npayload"); expect(f.packets).toHaveLength(1);
  expect(f.events.some(event => event.includes("bad connectionless packet"))).toBe(true);
});

test("rcon delegates the owned raw packet; malformed codecs and overlapping awaited operations reject", async () => {
  const f = await fixture(); await f.query("rcon pass status"); expect(f.events).toContain("rcon:ipv4:rcon pass status:rcon pass status");
  await expect(f.runtime.process(remote, Uint8Array.of(255))).rejects.toThrow("Truncated connectionless");
  let finish: ((address: Ipv4Address | null) => void) | undefined;
  f.setResolver(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.query("getchallenge");
  await expect(f.query("getinfo x")).rejects.toThrow("awaited in source order");
  if (finish === undefined) throw new Error("Missing DNS promise"); finish(authorizeAddress); await pending;
  await f.query("getinfo x"); expect(text(at(f.packets, f.packets.length - 1).payload)).toStartWith("infoResponse\n");
});

test("native oldest-time ties choose the first slot and connected records cannot be reused", async () => {
  const f = await fixture();
  for (const challenge of f.statics.challenges) { challenge.connected = true; challenge.time = 100; }
  at(f.statics.challenges, 7).time = -1; at(f.statics.challenges, 8).time = -1;
  await f.query("getchallenge", lan);
  expect(at(f.statics.challenges, 7).challenge).toBe(1998331950); expect(at(f.statics.challenges, 7).connected).toBe(false);
  expect(at(f.statics.challenges, 8).challenge).toBe(0); expect(at(f.statics.challenges, 8).connected).toBe(true);
});

test("native signed time wrap still crosses the authorization timeout", async () => {
  const f = await fixture(); f.statics.time = 2147481147;
  await f.query("getchallenge"); expect(text(at(f.packets, 0).payload)).toBe("getIpAuthorize 149149181 203.0.113.9 baseq3 0 1");
  f.statics.time = -2147481148; await f.query("getchallenge");
  expect(text(at(f.packets, 1).payload)).toBe("challengeResponse 149149181"); expect(at(f.statics.challenges, 0).pingTime).toBe(-2147481148);
});

test("native heartbeat cadence, explicit-port overwrite and modified flag clearing before DNS", async () => {
  const f = await fixture(); f.cvars.set("dedicated", "2", true); f.cvars.set("sv_master1", "master.example:28000", true);
  f.setResolver(async (name, port) => {
    expect(name).toBe("master.example"); expect(port).toBe(28000);
    expect(f.cvars.get("sv_master1")?.modified).toBe(false);
    return { ...authorizeAddress, port };
  });
  const before = f.cvars.get("sv_master1")?.modificationCount;
  f.statics.time = 6001; await f.runtime.masterHeartbeat(); await f.runtime.masterHeartbeat();
  expect(f.packets).toHaveLength(1); expect(at(f.packets, 0).address).toEqual({ ...authorizeAddress, port: 27950 });
  expect(text(at(f.packets, 0).payload)).toBe("heartbeat QuakeArena-1\n");
  expect(f.statics.nextHeartbeatTime).toBe(306001); expect(f.cvars.get("sv_master1")?.modificationCount).toBe(before);
  f.statics.time = 306000; await f.runtime.masterHeartbeat(); expect(f.packets).toHaveLength(1);
  f.statics.time = 306001; await f.runtime.masterHeartbeat(); expect(f.packets).toHaveLength(2);
  expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(1);
});

test("heartbeat failed names are cleared and do not repeat DNS; private/LAN dedicated modes do not send", async () => {
  const f = await fixture(); f.setResolver(async () => null);
  await f.runtime.masterHeartbeat(); f.cvars.set("dedicated", "1", true); await f.runtime.masterHeartbeat();
  expect(f.statics.nextHeartbeatTime).toBe(0); expect(f.events.some(event => event.startsWith("dns:"))).toBe(false);
  f.cvars.set("dedicated", "2", true); await f.runtime.masterHeartbeat();
  expect(f.cvars.get("sv_master1")?.value).toBe(""); expect(f.cvars.get("sv_master1")?.modified).toBe(false);
  f.statics.time = f.statics.nextHeartbeatTime; await f.runtime.masterHeartbeat();
  expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(1); expect(f.packets).toHaveLength(0);
});

test("one handler retains master/auth caches across real map lifecycle replacement and reads current game scores", async () => {
  const f = await fixture(); await f.connect(lan, "Private", "secret");
  await f.query("getchallenge"); f.cvars.set("dedicated", "2", true); await f.runtime.masterHeartbeat();
  const dnsCount = f.events.filter(event => event.startsWith("dns:")).length;
  const replacement = f.replaceWorld(), game = replacement.game;
  if (!(game instanceof GameRuntime)) throw new Error("Replacement fixture requires direct game runtime");
  const player = game.pool.at(0).client;
  if (player === null || player === undefined) throw new Error("Missing replacement game player");
  player.ps.persistant.set(PersistentIndex.PERS_SCORE, 71);
  await f.query("getstatus mapchange"); expect(text(at(f.packets, f.packets.length - 1).payload)).toContain('71 0 "Private"');
  await f.connect({ kind: "ipv4", host: [10, 0, 0, 11], port: 27962 }, "NewMap", "");
  expect(f.client(1).phase).toBe(ServerClientPhase.Connected);
  expect(game.pool.at(1).client?.pers.netname).toBe("NewMap");
  expect(f.game.pool.at(1).client?.pers.netname).not.toBe("NewMap");
  await f.query("getchallenge");
  f.statics.time = f.statics.nextHeartbeatTime; await f.runtime.masterHeartbeat();
  expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(dnsCount);
  expect(f.statics.authorizeAddress).toEqual({ kind: "resolved", address: authorizeAddress });
});

test("canonical failed authorization state survives handler replacement and zero-first-octet addresses retry", async () => {
  const f = await fixture(); f.setResolver(async () => null); await f.query("getchallenge");
  expect(f.statics.authorizeAddress).toEqual({ kind: "failed" });
  const replacement = new ServerConnectionlessRuntime(f.control, f.runtime.host);
  await replacement.process(remote, encodeConnectionlessText("getchallenge")); expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(1);
  f.statics.authorizeAddress = { kind: "resolved", address: { kind: "ipv4", host: [0, 1, 2, 3], port: 27952 } };
  f.setResolver(async () => authorizeAddress); await f.query("getchallenge");
  expect(f.events.filter(event => event.startsWith("dns:")).length).toBe(2);
});

test("source info cvar bounds preserve negative public capacity but reject an invalid client-table index", async () => {
  const f = await fixture(); f.cvars.set("sv_privateClients", "4", true); f.cvars.set("sv_minPing", "50", true); f.cvars.set("sv_maxPing", "200", true); f.cvars.set("fs_game", "missionpack", true);
  await f.query("getinfo abc");
  const info = at(text(at(f.packets, 0).payload).split("\n"), 1);
  expect(infoValueForKey(info, "sv_maxclients", 1024)).toBe("-1"); expect(infoValueForKey(info, "clients", 1024)).toBe("0");
  expect(infoValueForKey(info, "minPing", 1024)).toBe("50"); expect(infoValueForKey(info, "maxPing", 1024)).toBe("200"); expect(infoValueForKey(info, "game", 1024)).toBe("missionpack");
  f.cvars.set("sv_privateClients", "-1", true); await expect(f.query("getinfo abc")).rejects.toThrow("outside allocated slots");
});

test("source diagnostic callbacks precede subsequent live cvar reads", async () => {
  const f = await fixture(), print = f.runtime.host.print;
  f.runtime.host.print = value => {
    print(value);
    if (value === "Can't use keys or values with a semicolon\n") f.cvars.set("sv_hostname", "After diagnostic", true);
    if (value === "Resolving before.example\n") f.cvars.set("sv_master1", "after.example:1234", true);
  };
  await f.query('getinfo "invalid;challenge"');
  expect(text(at(f.packets, 0).payload)).toContain("\\hostname\\After diagnostic");
  f.cvars.set("dedicated", "2", true); f.cvars.set("sv_master1", "before.example", true);
  await f.runtime.masterHeartbeat(); expect(f.events).toContain("dns:after.example:1234");
  expect(f.cvars.get("sv_master1")?.modified).toBe(true);
});

test("current-lifecycle validation rejects a different server before processing packets", async () => {
  const f = await fixture(), other = await fixture(); f.runtime.host.currentLifecycle = () => other.lifecycle;
  await expect(f.query("getinfo abc")).rejects.toThrow("share engine cvars");
  expect(f.packets).toHaveLength(0);
});

test("master slots resolve in source order, localhost bypasses DNS, and wire port parsing wraps", async () => {
  const f = await fixture(); f.cvars.set("dedicated", "2", true); f.cvars.set("sv_master1", "localhost", true);
  f.cvars.set("sv_master2", "second.example:-1", true); f.cvars.set("sv_master5", "fifth.example", true);
  await f.runtime.masterHeartbeat();
  expect(f.packets.map(packet => packet.address)).toEqual([{ kind: "loopback" }, { ...authorizeAddress, port: 27950 }, { ...authorizeAddress, port: 27950 }]);
  expect(f.events.filter(event => event.startsWith("dns:"))).toEqual(["dns:second.example:65535", "dns:fifth.example:27960"]);
  f.statics.time = 2147483600; await f.runtime.masterHeartbeat(); expect(f.statics.nextHeartbeatTime).toBe(-2147183696);
});

test("source DNS INADDR_NONE is failure and invalid host boundary data is rejected", async () => {
  const f = await fixture(); f.setResolver(async () => ({ kind: "ipv4", host: [255, 255, 255, 255], port: 27952 }));
  await f.query("getchallenge"); expect(f.statics.authorizeAddress).toEqual({ kind: "failed" }); expect(f.packets).toHaveLength(0);
  f.statics.authorizeAddress = { kind: "unresolved" }; f.setResolver(async () => ({ kind: "ipv4", host: [256, 0, 0, 1], port: 27952 }));
  await expect(f.query("getchallenge")).rejects.toThrow("invalid source IPv4");
});

test("engine master cache survives handler and full server-session replacement", async () => {
  const f = await fixture(); f.cvars.set("dedicated", "2", true);
  await f.runtime.masterHeartbeat();
  const replacement = f.replaceSession();
  const next = new ServerConnectionlessRuntime(f.control, f.runtime.host);
  await next.masterHeartbeat();
  expect(f.events.filter(event => event.startsWith("dns:"))).toHaveLength(1);
  expect(f.packets).toHaveLength(2);
  expect(replacement.nextHeartbeatTime).toBe(300000);
  expect(f.statics.nextHeartbeatTime).toBe(301000);
  expect(replacement.authorizeAddress).toEqual({ kind: "unresolved" });
});

test("replacement handlers share the outstanding DNS guard and release it on rejection", async () => {
  const f = await fixture(), gate = Promise.withResolvers<Ipv4Address | null>();
  f.setResolver(() => gate.promise);
  const running = f.query("getchallenge");
  const replacement = new ServerConnectionlessRuntime(f.control, f.runtime.host);
  await expect(replacement.process(lan, encodeConnectionlessText("getchallenge"))).rejects.toThrow("awaited in source order");
  await expect(replacement.masterHeartbeat()).rejects.toThrow("awaited in source order");
  gate.reject(new Error("fixture DNS failure"));
  await expect(running).rejects.toThrow("fixture DNS failure");
  await replacement.process(lan, encodeConnectionlessText("getchallenge"));
  expect(f.packets).toHaveLength(1);
  const independent = await fixture(); await independent.query("getchallenge", lan);
  expect(independent.packets).toHaveLength(1);
});

test("status info-string visits later cvars after earlier diagnostics mutate them", async () => {
  const f = await fixture();
  f.cvars.register("review_later", "old", CvarFlag.ServerInfo);
  f.cvars.register("review_bad", "x;y", CvarFlag.ServerInfo);
  const print = f.runtime.host.print;
  f.runtime.host.print = value => {
    print(value);
    if (value === "Can't use keys or values with a semicolon\n") f.cvars.set("review_later", "new", true);
  };
  await f.query("getstatus abc");
  expect(infoValueForKey(at(text(at(f.packets, 0).payload).split("\n"), 1), "review_later", 1024)).toBe("new");
});

test("packetEvent awaits actual challenge DNS before caller continuation and propagates resolver rejection", async () => {
  const f = await fixture(), gate = Promise.withResolvers<Ipv4Address | null>();
  f.setResolver(() => gate.promise);
  const channel = new ServerNetChannelRuntime(f.statics, { debugPrint: text => { f.runtime.host.debugPrint(text); }, tracePacket: message => { expect(message).toMatch(/^server send /); },
    print: f.runtime.host.print, sendPacket: f.sendPacket,
    connectionless: (address, packet) => f.runtime.process(address, packet),
    executeClientMessage: () => { throw new Error("Challenge is not sequenced movement"); },
  });
  const input = encodeConnectionlessText("getchallenge");
  const pending = channel.packetEvent(remote, input).then(() => { f.events.push("caller:continued"); });
  input.fill(0);
  await Promise.resolve();
  expect(f.events).toContain("dns:authorize.quake3arena.com:27952");
  expect(f.events).not.toContain("caller:continued"); expect(f.packets).toHaveLength(0);
  gate.resolve(authorizeAddress); await pending;
  expect(text(at(f.packets, 0).payload)).toBe("getIpAuthorize 1998331950 203.0.113.9 baseq3 0 1");
  expect(f.events.at(-1)).toBe("caller:continued");
  const failure = new Error("fixture DNS rejected"); f.statics.authorizeAddress = { kind: "unresolved" };
  f.setResolver(async () => { throw failure; });
  await expect(channel.packetEvent(remote, encodeConnectionlessText("getchallenge"))).rejects.toBe(failure);
  expect(f.control.connectionlessBusy).toBe(false); expect(f.packets).toHaveLength(1);
});
