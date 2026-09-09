import { afterEach, describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { finishCalls, runCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { vec3 } from "../src/core/math.ts";
import { tokenizeCommand } from "../src/core/text.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { GameBotServices } from "../src/game/runtime.ts";
import { encodeClientMessage } from "../src/protocol/client-message.ts";
import { decodeConnectionless, encodeConnect } from "../src/protocol/connectionless.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import { decodeServerMessage, ServerOpcode } from "../src/protocol/server-message.ts";
import { ServerClientCommandRuntime } from "../src/server/client-commands.ts";
import { ServerClientLifecycleRuntime } from "../src/server/client-lifecycle.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import type { ServerGameDenial } from "../src/server/game.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import type { ServerPacketAddress } from "../src/server/net-channel.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import type { ServerAddress } from "../src/server/state.ts";
import { Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";

// Unchanged server functions with original q_shared/msg/huffman, i386 GCC -O2 -DNDEBUG,
// both products: bash /tmp/quake3-server-lifecycle-oracle-BM8PAV/run.sh.
// Captured game/send boundaries establish source order; integration below runs the actual TS services.

function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing fixture slot ${index}`); return value;
}
function connection(client: ServerClient) {
  if (client.connection.kind !== "initialized") throw new Error("Missing fixture connection"); return client.connection;
}
function map(): BspMap {
  const bounds = { min: vec3(-4096, -4096, -512), max: vec3(4096, 4096, 1024) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 4096 }, { normal: vec3(-1, 0, 0), distance: 4096 },
    { normal: vec3(0, 1, 0), distance: 4096 }, { normal: vec3(0, -1, 0), distance: 4096 },
    { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 512 }];
  return { entities: '{ "classname" "worldspawn" } { "classname" "info_player_deathmatch" "origin" "100 0 24" }', entityRecords: [],
    shaders: [{ name: "floor", surfaceFlags: 0, contentFlags: 1 }], planes, nodes: [],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    leafSurfaces: [], leafBrushes: [0], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 1 }],
    brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })),
    vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
const downloadFileOwners: CommonFileState[] = [];
afterEach(() => { for (const files of downloadFileOwners.splice(0)) files.close(); });

async function fixture(product: Product = "baseq3", maxClients = 2, botServices = false) {
  const statics = new ServerStaticState({ product, maxClients, dedicated: false });
  const prints: string[] = [], trace: string[] = [], packets: { address: ServerPacketAddress; payload: Uint8Array }[] = [];
  const cvars = new CvarRegistry();
  const downloadFiles = new CommonFileState({ homePath: process.cwd(), dataPath: process.cwd(), cdPath: null, product: "baseq3" },
    () => undefined, new SoundOutput(), cvars);
  downloadFileOwners.push(downloadFiles);
  await downloadFiles.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  for (const [name, value] of [["sv_maxclients", String(maxClients)], ["g_log", ""], ["bot_enable", "0"], ["g_doWarmup", "0"],
    ["dedicated", "0"], ["sv_lanForceRate", "1"], ["sv_reconnectlimit", "3"], ["sv_minPing", "0"], ["sv_maxPing", "0"],
    ["sv_privateClients", "0"], ["sv_privatePassword", ""], ["sv_maxRate", "0"], ["sv_padPackets", "0"], ["sv_allowDownload", "1"], ["sv_pure", "0"]] satisfies readonly (readonly [string, string])[]) cvars.set(name, value, true);
  const client = (slot = 0): ServerClient => at(statics.clients, slot);
  const print = (text: string): void => { prints.push(text); };
  const debugPrint = (text: string): void => { trace.push(text); };
  const dropClient = (value: ServerClient, reason: string): CallSteps => lifecycle.dropClient(value, reason);
  const sendClientGameState = (value: ServerClient): void => { lifecycle.sendClientGameState(value); };
  const world = new ServerWorldState(statics, { print, dropClient });
  const downloads = new ServerDownloadRuntime(statics, { cvars, files: downloadFiles.server, print, debugPrint, dropClient, sendClientGameState });
  const sendPacket = (address: ServerPacketAddress, payload: Uint8Array): undefined => {
    packets.push({ address, payload: new Uint8Array(payload) });
    if (payload.slice(0, 4).every(byte => byte === 255)) trace.push(`oob:${decodeConnectionless(payload, "client").command}:phase${client().phase}`);
    else trace.push(`packet:phase${client().phase}:game${client().gamestateMessageNum}`);
  };
  const isLanAddress = (address: ServerAddress): boolean => address.kind === "loopback" || (address.kind === "ipv4" && address.host[0] === 10);
  const channel = new ServerNetChannelRuntime(statics, { debugPrint: text => { debugPrint(text); }, tracePacket: message => { expect(message).toMatch(/^server send /); }, print, sendPacket,
    connectionless: async (from, payload) => { const decoded = decodeConnectionless(payload, "server");
      if (decoded.command !== "connect") throw new Error(`Unexpected connectionless ${decoded.command}`);
      await runCalls(lifecycle.directConnect(from, at(decoded.arguments, 0))); },
    executeClientMessage: (value, reader) => commands.executeClientMessage(value, reader) });
  const bsp = map();
  const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
  const spatial = new ServerWorld(collision, collision.modelBounds(0), number => world.game?.data.entity(number), {
    get loading() { return world.state === "loading"; }, print: text => { print(text); },
    developerPrint: text => { if (cvars.get("developer")?.integerValue) print(text); },
  });
  const snapshots = new ServerSnapshotRuntime(world, statics, { collision, spatial, debugPrint });
  const sender = new ServerSnapshotSendRuntime(snapshots, channel, { cvars, downloads, print, isLanAddress });
  const lifecycle = new ServerClientLifecycleRuntime(world, statics, { cvars, downloads, sender, print, debugPrint, sendPacket, isLanAddress });
  const commands = new ServerClientCommandRuntime(world, statics, { debugBuild: false, pure: false, clientRunning: true, floodProtect: false,
    print, debugPrint, tokenize: tokenizeCommand, dropClient, sendClientGameState, userinfoChanged: value => { lifecycle.userinfoChanged(value); },
    verifyPaks: () => { throw new Error("Pure verification is outside this non-pure handshake fixture"); },
    beginDownload: (value, argv) => { downloads.begin(value, argv); }, nextDownload: (value, argv) => downloads.next(value, argv),
    stopDownload: value => { downloads.stop(value); }, doneDownload: value => { downloads.done(value); } });
  statics.time = 1000; world.state = "loading";
  if (botServices) cvars.set("bot_enable", "1", true);
  const bots: GameBotServices = botServices ? { kind: "available",
    initialize: restart => { trace.push(`bot-init:${restart}`); }, loadMap: restart => { trace.push(`bot-map:${restart}`); },
    initializeBots: restart => { trace.push(`bot-init-bots:${restart}`); }, shutdown: restart => { trace.push(`bot-shutdown:${restart}`); },
    frame: time => { trace.push(`bot-frame:${time}`); },
    testAas: origin => { trace.push(`bot-test-aas:${origin.x},${origin.y},${origin.z}`); },
    interbreedEndMatch: () => { trace.push("bot-interbreed"); }, consoleCommand: argv => { trace.push(`bot-command:${argv.join(" ")}`); },
    removeQueuedBegin: slot => { trace.push(`bot-remove:${slot}`); }, connect: (slot, restart) => { trace.push(`bot-connect:${slot}:${restart}`); return true; },
    shutdownClient: (slot, restart) => { trace.push(`bot-shutdown-client:${slot}:${restart}`); } }
    : { kind: "unavailable", reason: "Lifecycle fixture uses human game clients" };
  const game = GameRuntime.create({ product, map: bsp, collision, world: spatial, levelTime: 1000,
    randomSeed: 17, restart: false, buildDate: "fixture", cvars, configstrings: world.configstrings,
    engine: { milliseconds: () => statics.time, print, sendServerCommand: (slot, text) => { finishCalls(lifecycle.sendServerCommand(slot, text)); },
    dropClient: (slot, reason) => { finishCalls(dropClient(client(slot), reason)); },
    getUserinfo: slot => client(slot).userinfo, setUserinfo: (slot, value) => { lifecycle.setUserinfo(slot, value); },
    getUserCommand: slot => client(slot).lastUsercmd, appendConsoleCommand: text => { trace.push(`console:${text}`); },
    insertConsoleCommand: text => { trace.push(`console-insert:${text}`); },
    executeConsoleNow: text => { trace.push(`console-now:${text}`); }, openLog: () => { throw new Error("Fixture logging disabled"); } },
    botFactory: bots.kind === "unavailable" ? bots : { kind: "source", attach(attached) { expect(world.game).toBe(attached); return bots; } },
    }, world);
  world.state = "game"; world.serverId = 100; world.restartedServerId = 100; world.checksumFeed = 0x12345678;
  const connectGame = game.clientConnect.bind(game), disconnectGame = game.clientDisconnect.bind(game);
  game.clientConnect = (slot, firstTime, isBot) => { trace.push(`game-connect:${slot}:${firstTime}:${isBot}:${client(slot).phase}:${client(slot).gameEntity !== null}`); return connectGame(slot, firstTime, isBot); };
  game.clientDisconnect = slot => { trace.push(`game-disconnect:${slot}:${client(slot).phase}:${client(slot).download.file === null}`); disconnectGame(slot); };
  async function connect(from: ServerPacketAddress = { kind: "loopback" }, extra = "", qport = 700): Promise<void> {
    await channel.packetEvent(from, encodeConnect(`\\protocol\\68\\qport\\${qport}\\challenge\\1234\\name\\Player\\model\\sarge/default${extra}`));
  }
  function challenge(address: ServerPacketAddress, ping = 50, index = 0): void {
    const record = at(statics.challenges, index); record.address = address; record.challenge = 1234; record.pingTime = (statics.time - ping) | 0;
  }
  function receive(receiver = new Netchannel("client")): { sequence: number; bytes: Uint8Array } {
    while (connection(client()).netchan.hasUnsentFragments) channel.transmitNextFragment(client());
    let result: { sequence: number; bytes: Uint8Array } | null = null;
    for (const packet of packets.splice(0)) {
      if (packet.payload.slice(0, 4).every(byte => byte === 255)) continue;
      const decoded = receiver.receive(packet.payload);
      if (decoded.kind === "accepted") result = { sequence: decoded.sequence, bytes: xorServerMessage(decoded.payload, client().challenge, decoded.sequence, client().lastClientCommandString) };
    }
    if (result === null) throw new Error("Expected complete server message"); return result;
  }
  return { statics, world, game, cvars, downloads, channel, snapshots, sender, lifecycle, commands, prints, trace, packets, client, connect, challenge, receive };
}
const remote: ServerPacketAddress = { kind: "ipv4", host: [203, 0, 113, 9], port: 27961 };

describe("source server client lifecycle", () => {
  test("admission retains the assigned entity and waits for game acceptance before its source tail", async () => {
    const f = await fixture(), pause = Promise.withResolvers<undefined>();
    const connectGame = f.game.calls.clientConnect.bind(f.game.calls);
    f.game.calls.clientConnect = function* (slot, firstTime, isBot): CallSteps<ServerGameDenial | null> {
      yield () => pause.promise;
      return yield* connectGame(slot, firstTime, isBot);
    };
    const completion = runCalls(f.lifecycle.directConnect({ kind: "loopback" }, "\\protocol\\68\\qport\\700\\name\\Player"));
    const client = f.client(), entity = f.game.data.entity(0);
    expect(client.gameEntity).toBe(entity);
    expect(client.phase).toBe(ServerClientPhase.Free);
    expect(client.userinfo).toContain("Player");
    expect(f.packets).toHaveLength(0);
    expect(client.lastConnectTime).toBe(0);
    f.statics.time = 1777;
    pause.resolve(undefined);
    await completion;
    expect(client.phase).toBe(ServerClientPhase.Connected);
    expect(client.gameEntity).toBe(entity);
    expect(client.lastConnectTime).toBe(1777);
    expect(f.trace).toContain("oob:connectResponse:phase0");
  });

  test("drop waits at GAME disconnect after Zombie publication and before disconnect command or userinfo clear", async () => {
    const f = await fixture(); f.challenge(remote); await f.connect(remote);
    const client = f.client(), pause = Promise.withResolvers<undefined>();
    connection(client).phase = ServerClientPhase.Active;
    const disconnectGame = f.game.calls.clientDisconnect.bind(f.game.calls);
    f.game.calls.clientDisconnect = function* (slot): CallSteps {
      yield () => pause.promise;
      yield* disconnectGame(slot);
    };
    f.statics.nextHeartbeatTime = 9999;
    const completion = runCalls(f.lifecycle.dropClient(client, "bye"));
    expect(client.phase).toBe(ServerClientPhase.Zombie);
    expect(at(f.statics.challenges, 0).connected).toBe(false);
    expect(client.reliable.pending().at(-1)?.text).toBe('print "Player^7 bye\n"');
    expect(client.userinfo).toContain("Player");
    expect(f.world.configstrings.get(544)).not.toBe("");
    expect(f.statics.nextHeartbeatTime).toBe(9999);
    finishCalls(f.lifecycle.dropClient(client, "already zombie"));
    pause.resolve(undefined);
    await completion;
    expect(client.reliable.pending().at(-1)?.text).toBe('disconnect "bye"');
    expect(client.userinfo).toBe("");
    expect(f.world.configstrings.get(544)).toBe("");
    expect(f.statics.nextHeartbeatTime).toBe(-9999999);
  });

  test("overflow during the pre-Zombie broadcast permits recursive drops and resumes both original tails", async () => {
    const f = await fixture(); await f.connect(); f.challenge(remote); await f.connect(remote);
    for (const client of f.statics.clients) {
      connection(client).phase = ServerClientPhase.Active;
      while (client.reliable.sequence < 64) client.reliable.add("old");
    }
    f.trace.length = 0;
    finishCalls(f.lifecycle.dropClient(f.client(0), "outer"));
    expect(f.trace.filter(value => value.startsWith("game-disconnect:"))).toEqual([
      "game-disconnect:1:1:true", "game-disconnect:0:1:true", "game-disconnect:0:1:true",
    ]);
    expect(f.prints.filter(value => value === "===== pending server commands =====\n")).toHaveLength(2);
    expect(f.client(0).phase).toBe(ServerClientPhase.Zombie);
    expect(f.client(1).phase).toBe(ServerClientPhase.Zombie);
    expect(f.client(0).reliable.pending().at(-1)?.text).toBe('disconnect "outer"');
    expect(f.client(1).reliable.pending().at(-1)?.text).toBe('disconnect "Server command overflow"');
  });

  test("an already Zombie client never reads the drop reason", async () => {
    const f = await fixture(); await f.connect();
    const client = f.client(); connection(client).phase = ServerClientPhase.Zombie;
    const sequence = client.reliable.sequence, traceLength = f.trace.length;
    finishCalls(f.lifecycle.dropClient(client, () => { throw new Error("reason must remain unread"); }));
    expect(client.reliable.sequence).toBe(sequence);
    expect(f.trace).toHaveLength(traceLength);
    expect(client.userinfo).toContain("Player");
  });

  test("a source-zero Free slot publishes Zombie to GAME disconnect and returns to Free without a channel", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = await fixture(product), client = f.client(), original = client.connection;
      f.lifecycle.setUserinfo(client.slot, "\\name\\Unconnected");
      f.statics.nextHeartbeatTime = 9999;
      let reason = "before", reads = 0, callbacks = 0;
      const disconnectGame = f.game.calls.clientDisconnect.bind(f.game.calls);
      f.game.calls.clientDisconnect = function* (slot): CallSteps {
        callbacks++;
        expect(slot).toBe(client.slot);
        expect(client.connection).toBe(original);
        expect(client.phase).toBe(ServerClientPhase.Zombie);
        expect(client.userinfo).toBe("\\name\\Unconnected");
        expect(client.reliable.sequence).toBe(0);
        yield* f.lifecycle.dropClient(client, () => { throw new Error("Zombie reason must remain unread"); });
        yield* disconnectGame(slot);
        reason = "after";
      };
      finishCalls(f.lifecycle.dropClient(client, () => { reads++; return reason; }));
      expect(callbacks).toBe(1);
      expect(reads).toBe(2);
      expect(client.connection).toBe(original);
      expect(client.connection.kind).toBe("uninitialized");
      expect(client.phase).toBe(ServerClientPhase.Free);
      expect(client.name).toBe("");
      expect(client.userinfo).toBe("");
      expect(client.gameEntity).toBeNull();
      expect(client.reliable.pending()).toEqual([{ sequence: 1, text: 'disconnect "after"' }]);
      expect(f.packets).toHaveLength(0);
      expect(f.statics.nextHeartbeatTime).toBe(-9999999);
    }
  });

  test("challenge and download writes precede a failing reason read at broadcast formatting", async () => {
    const f = await fixture(); f.challenge(remote); await f.connect(remote);
    const client = f.client(); connection(client).phase = ServerClientPhase.Active;
    f.downloads.begin(client, ["download", "package.json"]);
    f.downloads.writeToClient(client, new MessageWriter());
    const file = client.download.file;
    if (file === null) throw new Error("Expected package.json download descriptor");
    const sequence = client.reliable.sequence;
    expect(() => finishCalls(f.lifecycle.dropClient(client, () => {
      expect(at(f.statics.challenges, 0).connected).toBe(false);
      expect(client.download.file).toBeNull();
      expect(client.download.blocks.every(block => block === null)).toBe(true);
      throw new Error("reason read failed");
    }))).toThrow("reason read failed");
    expect(() => file.read(new Uint8Array(1))).toThrow("closed");
    expect(client.phase).toBe(ServerClientPhase.Active);
    expect(client.reliable.sequence).toBe(sequence);
    expect(client.userinfo).toContain("Player");
    expect(f.trace.some(value => value.startsWith("game-disconnect:"))).toBe(false);
  });

  test("drop rereads the slot connection after GAME replaces its source-zero bot address", async () => {
    const f = await fixture(), client = f.client(), original = client.connection;
    const disconnectGame = f.game.calls.clientDisconnect.bind(f.game.calls), netchan = new Netchannel("server");
    f.game.calls.clientDisconnect = function* (slot): CallSteps {
      yield* disconnectGame(slot);
      client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan };
    };
    f.statics.nextHeartbeatTime = 9999;
    finishCalls(f.lifecycle.dropClient(client, "bye"));
    expect(original.phase).toBe(ServerClientPhase.Zombie);
    expect(client.phase).toBe(ServerClientPhase.Active);
    expect(connection(client).netchan).toBe(netchan);
    expect(client.reliable.pending()).toEqual([{ sequence: 1, text: 'disconnect "bye"' }]);
    expect(f.statics.nextHeartbeatTime).toBe(9999);
  });

  test("admission during source-zero Zombie disconnect skips its bot address and uses the next Free slot", async () => {
    const f = await fixture(), client = f.client(), disconnectGame = f.game.calls.clientDisconnect.bind(f.game.calls);
    f.game.calls.clientDisconnect = function* (slot): CallSteps {
      yield* f.lifecycle.directConnect({ kind: "loopback" }, "\\protocol\\68\\qport\\700\\name\\Reentrant");
      expect(client.phase).toBe(ServerClientPhase.Zombie);
      expect(f.client(1).phase).toBe(ServerClientPhase.Connected);
      yield* disconnectGame(slot);
    };
    finishCalls(f.lifecycle.dropClient(client, "bye"));
    expect(client.phase).toBe(ServerClientPhase.Free);
    expect(f.client(1).name).toBe("Reentrant");
  });

  test("GAME disconnect can change the retained reason before its second source formatting use", async () => {
    const f = await fixture(); await f.connect();
    const client = f.client(); connection(client).phase = ServerClientPhase.Active;
    let reason = "before\0ignored", reads = 0;
    const disconnectGame = f.game.clientDisconnect.bind(f.game);
    f.game.clientDisconnect = slot => {
      disconnectGame(slot);
      reason = "after\0ignored\u0100";
    };
    const sequence = client.reliable.sequence;
    finishCalls(f.lifecycle.dropClient(client, () => { reads++; return reason; }));
    expect(reads).toBe(2);
    expect(client.reliable.lookupMasked(sequence + 1)).toBe('print "Player^7 before\n"');
    expect(client.reliable.pending().at(-1)?.text).toBe('disconnect "after"');
    expect(client.userinfo).toBe("");
  });

  test("public game command dispatch preserves broadcast phase filtering and dedicated echo", async () => {
    const f = await fixture(), first = f.client(0), second = f.client(1);
    first.connection = { kind: "initialized", phase: ServerClientPhase.Connected,
      address: { kind: "loopback" }, netchan: new Netchannel("server", 0) };
    second.connection = { kind: "initialized", phase: ServerClientPhase.Primed,
      address: { kind: "loopback" }, netchan: new Netchannel("server", 1) };
    f.cvars.set("dedicated", "1", true);
    const firstBefore = first.reliable.sequence, secondBefore = second.reliable.sequence;
    finishCalls(f.lifecycle.sendServerCommand(-1, 'print "hello\n"'));
    expect(first.reliable.sequence).toBe(firstBefore);
    expect(second.reliable.sequence).toBe(secondBefore + 1);
    expect(f.prints).toContain('broadcast: print "hello\\n"\n');
    finishCalls(f.lifecycle.sendServerCommand(0, "direct"));
    expect(first.reliable.sequence).toBe(firstBefore + 1);
    expect(() => finishCalls(f.lifecycle.sendServerCommand(-2, "invalid"))).toThrow("bad index");
    expect(() => finishCalls(f.lifecycle.sendServerCommand(2, "invalid"))).toThrow("bad index");
    f.game.shutdown(false);
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: compressed connect, priming, command entry and real snapshot publication`, async () => {
      const f = await fixture(product), client = f.client(), oldFrames = client.frames;
      await f.connect();
      expect(f.client()).toBe(client); expect(client.frames).not.toBe(oldFrames);
      expect(client.phase).toBe(ServerClientPhase.Connected); expect(client.gamestateMessageNum).toBe(-1);
      expect(f.trace).toContain("game-connect:0:true:false:0:true"); expect(f.trace).toContain("oob:connectResponse:phase0");
      expect(infoValueForKey(client.userinfo, "ip")).toBe("localhost"); expect(f.statics.nextHeartbeatTime).toBe(-9999999);
      const peer = new Netchannel("client", 700);
      const send = async (serverId: number, times: readonly number[]): Promise<void> => {
        const payload = encodeClientMessage({ header: { serverId, messageAcknowledge: serverId === 0 ? 0 : 1, reliableAcknowledge: client.reliable.sequence }, commands: [],
          movement: times.length ? { kind: "move-no-delta", commands: times.map(serverTime => ({ serverTime, angles: [0, 0, 0], buttons: 0,
            weapon: Weapon.WP_MACHINEGUN, forwardmove: 127, rightmove: 0, upmove: 0 })) } : null },
        { checksumFeed: f.world.checksumFeed, serverCommand: sequence => client.reliable.lookupMasked(sequence) });
        for (const packet of peer.transmit(xorClientMessage(payload, client.challenge, sequence => client.reliable.lookupMasked(sequence)))) await f.channel.packetEvent({ kind: "loopback" }, packet);
      };
      client.pureAuthentic = true; client.gotCP = true;
      await send(0, []);
      expect(client.phase).toBe(ServerClientPhase.Primed); expect(client.pureAuthentic).toBe(false); expect(client.gotCP).toBe(false);
      const initial = f.receive(peer), history = new SnapshotHistory();
      const gamestateMessage = decodeServerMessage(initial.bytes, { product, messageNumber: initial.sequence, reliableSequence: 0, serverCommandSequence: 0,
        parseEntitiesNumber: 0, baseline: () => null, history: number => history.readSlot(number) });
      const gamestate = gamestateMessage.operations.find(operation => operation.kind === "gamestate");
      if (gamestate?.kind !== "gamestate") throw new Error("Expected actual gamestate");
      expect(gamestate.clientNumber).toBe(0); expect(gamestate.checksumFeed).toBe(f.world.checksumFeed);
      expect(gamestate.entries.some(entry => entry.kind === "configstring" && entry.value.includes("Player"))).toBe(true);
      await send(100, [1000, 1050, 1100]);
      expect(client.phase).toBe(ServerClientPhase.Active); expect(client.lastUsercmd.serverTime).toBe(1100);
      expect(f.game.pool.at(0).client?.ps.origin.x).toBeGreaterThan(100);
      f.snapshots.createBaselines(); f.sender.sendClientSnapshot(client);
      const packet = f.receive(peer), decoded = decodeServerMessage(packet.bytes, { product, messageNumber: packet.sequence,
        reliableSequence: 0, serverCommandSequence: gamestateMessage.serverCommandSequence, parseEntitiesNumber: 0,
        baseline: number => { const value = gamestate.entries.find(entry => entry.kind === "baseline" && entry.number === number); return value?.kind === "baseline" ? value.entity : null; },
        history: number => history.readSlot(number) });
      const snapshot = decoded.operations.find(operation => operation.kind === "snapshot");
      if (snapshot?.kind !== "snapshot") throw new Error("Expected actual snapshot");
      expect(history.publish(snapshot)).toBe(true); expect(history.latest?.playerState.commandTime).toBe(1100);
      expect(history.latest?.playerState.origin).toEqual(f.game.pool.at(0).client?.ps.origin);
      finishCalls(f.lifecycle.dropClient(client, "test complete"));
      expect(client.phase).toBe(ServerClientPhase.Zombie); expect(client.userinfo).toBe(""); expect(client.name).toBe("");
      expect(client.gameEntity).toBe(f.game.pool.at(0)); expect(f.trace).toContain("game-disconnect:0:1:true");
      expect(client.reliable.pending().at(-1)?.text).toBe('disconnect "test complete"');
      const sequence = client.reliable.sequence, traces = f.trace.length;
      finishCalls(f.lifecycle.dropClient(client, "again")); expect(client.reliable.sequence).toBe(sequence); expect(f.trace.length).toBe(traces);
    });
  }

  test("version and qport are rejected before challenges or game callbacks", async () => {
    const f = await fixture();
    finishCalls(f.lifecycle.directConnect(remote, "\\protocol\\67")); expect(decodeConnectionless(at(f.packets, 0).payload, "client").command).toBe("print");
    expect(new TextDecoder().decode(at(f.packets, 0).payload)).toContain("Server uses protocol version 68.");
    for (const qport of [-1, 65536]) await f.connect(remote, "", qport);
    expect(f.packets).toHaveLength(3); expect(f.trace.some(value => value.startsWith("game-connect:"))).toBe(false);
    expect(f.client().connection.kind).toBe("uninitialized");
  });
  test("IPv4 LAN still requires a matching address, port and challenge", async () => {
    const f = await fixture(), lan: ServerPacketAddress = { kind: "ipv4", host: [10, 0, 0, 1], port: 27961 };
    await f.connect(lan); expect(new TextDecoder().decode(at(f.packets, 0).payload)).toContain("No or bad challenge");
    f.challenge(lan, 1); f.cvars.set("sv_minPing", "1000", true); f.cvars.set("sv_maxPing", "0.5", true);
    await f.connect(lan); expect(f.client().phase).toBe(ServerClientPhase.Connected); expect(at(f.statics.challenges, 0).connected).toBe(true);
    expect(f.client().rate).toBe(99999); expect(infoValueForKey(f.client().userinfo, "ip")).toBe("10.0.0.1:27961");
  });
  test("ping rejects mark connected first and only low ping clears the challenge port", async () => {
    for (const low of [true, false]) {
      const f = await fixture(); f.challenge(remote, 50); f.cvars.set(low ? "sv_minPing" : "sv_maxPing", low ? "51" : "49", true);
      await f.connect(remote);
      const challenge = at(f.statics.challenges, 0);
      expect(challenge.connected).toBe(true); expect(challenge.address?.kind).toBe("ipv4");
      if (challenge.address?.kind !== "ipv4") throw new Error("Expected IPv4 challenge");
      expect(challenge.address.port).toBe(low ? 0 : 27961); expect(f.client().connection.kind).toBe("uninitialized");
      expect(f.prints).toContain("Client 0 connecting with 50 challenge ping\n");
    }
  });
  test("reconnect admission runs before challenge validation and resets owned records at the exact boundary", async () => {
    const f = await fixture(); f.challenge(remote); await f.connect(remote);
    const client = f.client(), ring = client.reliable, frames = client.frames, download = client.download;
    client.reliable.add("old"); client.download.blocks[0] = new Uint8Array([1]); client.queuedMessages.push(new Uint8Array([2]));
    at(f.statics.challenges, 0).challenge = 9876; f.packets.length = 0; f.statics.time = 3999; await f.connect(remote);
    expect(f.packets).toHaveLength(0); expect(client.reliable).toBe(ring);
    f.statics.time = 4000; await f.connect(remote); expect(new TextDecoder().decode(at(f.packets, 0).payload)).toContain("No or bad challenge");
    f.challenge(remote); await f.connect(remote);
    expect(f.client()).toBe(client); expect(client.reliable).not.toBe(ring); expect(client.frames).not.toBe(frames); expect(client.download).not.toBe(download);
    expect(client.reliable.sequence).toBe(0); expect(client.queuedMessages).toHaveLength(0); expect(download.blocks[0]).toBeNull();
    expect(client.lastConnectTime).toBe(4000); expect(f.trace.filter(value => value.startsWith("game-disconnect:"))).toHaveLength(0);
  });
  test("private slots, full remote rejection, and first/last occupancy heartbeats", async () => {
    const f = await fixture(); f.cvars.set("sv_privateClients", "1", true); f.cvars.set("sv_privatePassword", "secret", true);
    f.challenge(remote); await f.connect(remote); expect(f.client(0).phase).toBe(ServerClientPhase.Free); expect(f.client(1).phase).toBe(ServerClientPhase.Connected);
    const other: ServerPacketAddress = { kind: "ipv4", host: [203, 0, 113, 10], port: 27962 };
    f.challenge(other, 50, 1); await f.connect(other); expect(new TextDecoder().decode(at(f.packets, f.packets.length - 1).payload)).toContain("Server is full.");
    f.statics.nextHeartbeatTime = 9000; await f.connect(other, "\\password\\secret");
    expect(f.client().phase).toBe(ServerClientPhase.Connected); expect(f.statics.nextHeartbeatTime).toBe(-9999999);
    f.statics.nextHeartbeatTime = 9000; finishCalls(f.lifecycle.dropClient(f.client(), "one")); expect(f.statics.nextHeartbeatTime).toBe(9000);
    finishCalls(f.lifecycle.dropClient(f.client(1), "two")); expect(f.statics.nextHeartbeatTime).toBe(-9999999);
  });
  test("game password rejection retains initialized Free connection and canonical binding", async () => {
    const f = await fixture(); f.cvars.set("g_password", "private", true); f.game.runFrame(1000); await f.connect(remote);
    expect(f.client().connection.kind).toBe("uninitialized");
    f.challenge(remote); await f.connect(remote);
    expect(f.client().phase).toBe(ServerClientPhase.Free); expect(f.client().connection.kind).toBe("initialized"); expect(f.client().gameEntity).toBe(f.game.pool.at(0));
    expect(new TextDecoder().decode(at(f.packets, f.packets.length - 1).payload)).toContain("Invalid password");
  });
  test("userinfo source parsing, rate limits, snapshots, handicap and preserved existing ip", async () => {
    const f = await fixture(); f.challenge(remote); await f.connect(remote);
    const client = f.client();
    for (const [rate, expected] of [["", 3000], ["0", 1000], ["999999", 90000], ["12500x", 12500],
      ["999999999999999999999999999999999999999", 90000]] satisfies readonly (readonly [string, number])[]) {
      f.lifecycle.setUserinfo(0, `\\NAME\\${"A".repeat(40)}\\name\\ignored\\rate\\${rate}\\snaps\\99\\handicap\\00001\\ip\\preserve`);
      f.lifecycle.userinfoChanged(client); expect(client.rate).toBe(expected); expect(client.snapshotMsec).toBe(33);
      expect(client.name).toBe("A".repeat(31)); expect(infoValueForKey(client.userinfo, "handicap")).toBe("100"); expect(infoValueForKey(client.userinfo, "ip")).toBe("preserve");
    }
    for (const [snaps, expected] of [["", 50], ["0", 1000], ["3", 333], ["30", 33]] satisfies readonly (readonly [string, number])[]) {
      f.lifecycle.setUserinfo(0, `\\snaps\\${snaps}\\handicap\\50`); f.lifecycle.userinfoChanged(client);
      expect(client.snapshotMsec).toBe(expected); expect(infoValueForKey(client.userinfo, "ip")).toBe("203.0.113.9:27961");
    }
    connection(client).address = { kind: "loopback" }; f.cvars.set("dedicated", "2", true); f.lifecycle.userinfoChanged(client); expect(client.rate).toBe(3000);
    f.cvars.set("dedicated", "1", true); f.lifecycle.userinfoChanged(client); expect(client.rate).toBe(99999);
    f.cvars.set("sv_lanForceRate", "2", true); f.lifecycle.userinfoChanged(client); expect(client.rate).toBe(3000);
  });
  test("oversize info insertion removes the old exact-case key before rejecting the new pair", async () => {
    const f = await fixture(); await f.connect(); const client = f.client();
    const prefix = "\\ip\\present\\handicap\\0\\x\\";
    client.userinfo = prefix + "a".repeat(1023 - prefix.length);
    f.lifecycle.userinfoChanged(client); expect(infoValueForKey(client.userinfo, "handicap")).toBe("");
    expect(f.prints).toContain("Info string length exceeded\n");
    client.userinfo = prefix + "a".repeat(1022 - prefix.length);
    expect(() => f.lifecycle.userinfoChanged(client)).toThrow("source terminator");
    client.userinfo = prefix + "a".repeat(1021 - prefix.length);
    f.lifecycle.userinfoChanged(client); expect(infoValueForKey(client.userinfo, "handicap")).toBe("100"); expect(client.userinfo.length).toBe(1023);
  });
  test("drop ordering broadcasts before zombie, calls real game before disconnect command, and clears challenge", async () => {
    const f = await fixture(); f.challenge(remote); await f.connect(remote); const client = f.client();
    connection(client).phase = ServerClientPhase.Primed; f.cvars.set("dedicated", "1", true);
    const before = client.reliable.sequence;
    finishCalls(f.lifecycle.dropClient(client, "bye"));
    expect(at(f.statics.challenges, 0).connected).toBe(false); expect(f.trace).toContain("game-disconnect:0:1:true");
    expect(client.reliable.lookupMasked(before + 1)).toBe('print "Player^7 bye\n"');
    expect(client.reliable.pending().at(-1)?.text).toBe('disconnect "bye"');
    expect(f.prints).toContain('broadcast: print "Player^7 bye\\n"\n');
    expect(f.world.configstrings.get(544)).toBe("");
  });
  test("gamestate uses live reliable order and number-bearing baselines without rebinding entity", async () => {
    const f = await fixture(); await f.connect(); const client = f.client();
    client.lastClientCommand = 9; client.reliable.add('print "queued"'); client.pureAuthentic = true; client.gotCP = true;
    const baseline = at(f.world.baselines, 80); baseline.number = 81; baseline.modelindex = 4;
    f.lifecycle.sendClientGameState(client);
    const packet = f.receive(), reader = new MessageReader(packet.bytes);
    expect(reader.readLong()).toBe(9); expect(reader.readByte()).toBe(ServerOpcode.Command);
    expect(reader.readLong()).toBe(1); expect(reader.readString()).toBe('print "queued"');
    const decoded = decodeServerMessage(packet.bytes, { product: "baseq3", messageNumber: packet.sequence, reliableSequence: 9,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null });
    const gamestate = decoded.operations.find(operation => operation.kind === "gamestate");
    expect(gamestate?.kind === "gamestate" && gamestate.entries.some(entry => entry.kind === "baseline" && entry.number === 81)).toBe(true);
    expect(client.reliableSent).toBe(1); expect(client.gamestateMessageNum).toBe(1);
    expect(at(client.frames, 1).messageSent).toBe(1000); expect(at(client.frames, 1).messageAcked).toBe(-1);
    expect(client.nextSnapshotTime).toBe(999); expect(client.gameEntity).toBe(f.game.pool.at(0));
  });
  test("gamestate does not apply client aggregate cap and sends overflowed message without clearing", async () => {
    const f = await fixture(); await f.connect(); f.world.state = "loading";
    for (let index = 100; index < 104; index++) f.world.configstrings.set(index, " ".repeat(5000));
    f.lifecycle.sendClientGameState(f.client()); const first = f.receive();
    expect(first.bytes.length).toBeGreaterThan(4);
    expect(() => decodeServerMessage(first.bytes, { product: "baseq3", messageNumber: first.sequence, reliableSequence: 0,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null })).toThrow("Gamestate string storage exceeded");
    for (let index = 104; index < 110; index++) f.world.configstrings.set(index, "z".repeat(5000));
    f.lifecycle.sendClientGameState(f.client()); const second = f.receive();
    expect(second.bytes.length).toBeGreaterThanOrEqual(16380); expect(at(f.client().frames, second.sequence & 31).messageSize).toBe(second.bytes.length);
    expect(new MessageReader(second.bytes).readLong()).toBe(0); expect(f.prints.some(text => text.includes("msg overflowed"))).toBe(false);
  });
  test("public client boundaries reject foreign canonical objects", async () => {
    const f = await fixture(); await f.connect(); const foreign = new ServerClient("missionpack", 0);
    foreign.connection = { kind: "initialized", phase: ServerClientPhase.Connected, address: { kind: "loopback" }, netchan: new Netchannel("server") };
    for (const action of [() => finishCalls(f.lifecycle.dropClient(foreign, "foreign")), () => f.lifecycle.userinfoChanged(foreign), () => f.lifecycle.sendClientGameState(foreign)]) expect(action).toThrow("does not belong");
    let failure: unknown;
    try { f.lifecycle.setUserinfo(2, ""); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "CommonError", code: "drop", message: "SV_SetUserinfo: bad index 2\n" });
    expect(() => f.lifecycle.setUserinfo(0, "\\name\\😀")).toThrow("source byte");
    expect(f.client().phase).toBe(ServerClientPhase.Connected);
  });
  test("reconnect and drop close actual download descriptors and release window storage", async () => {
    for (const reconnect of [false, true]) {
      const f = await fixture(); await f.connect(); const client = f.client();
      f.downloads.begin(client, ["download", "package.json"]); f.downloads.writeToClient(client, new MessageWriter());
      const download = client.download, file = download.file;
      if (file === null) throw new Error("Expected real source download service to open package.json");
      expect(download.blocks.some(block => block !== null)).toBe(true);
      if (reconnect) { f.statics.time = 4000; await f.connect(); } else finishCalls(f.lifecycle.dropClient(client, "download interrupted"));
      expect(() => file.read(new Uint8Array(1))).toThrow("closed"); expect(download.file).toBeNull();
      expect(download.blocks.every(block => block === null)).toBe(true); expect(client.download.file).toBeNull();
    }
  });
  test("local full human server is fatal; a full bot server drops its last slot and reuses the same record", async () => {
    const full = await fixture("baseq3", 1); full.challenge(remote); await full.connect(remote);
    await expect(full.connect()).rejects.toMatchObject({ name: "CommonError", code: "fatal", message: "server is full on local connect\n" });
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = await fixture(product, 1, true), client = f.client();
      client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "bot" }, netchan: new Netchannel("server") };
      client.gameEntity = f.game.pool.at(0); f.lifecycle.setUserinfo(0, "\\name\\Bot\\model\\sarge/default\\skill\\3\\ip\\localhost");
      expect(f.game.clientConnect(0, true, true)).toBeNull();
      expect(f.game.pool.at(0).r.svFlags & ServerEntityFlags.BOT).not.toBe(0);
      await f.connect();
      expect(f.client()).toBe(client); expect(client.phase).toBe(ServerClientPhase.Connected);
      expect(f.trace).toContain("bot-shutdown-client:0:false"); expect(f.trace).toContain("game-disconnect:0:1:true");
      expect(f.game.pool.at(0).r.svFlags & ServerEntityFlags.BOT).toBe(0);
      expect(client.name).toBe("Player"); expect(client.reliable.sequence).toBe(0);
    }
  });
  test("both products match native source gamestate bytes and overflow delivery exactly", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = await fixture(product), client = f.client();
      client.connection = { kind: "initialized", phase: ServerClientPhase.Connected, address: { kind: "loopback" }, netchan: new Netchannel("server") };
      f.world.state = "loading";
      for (let index = 0; index < 1024; index++) f.world.configstrings.set(index, "");
      client.lastClientCommand = 9; client.reliable.add("print queued"); f.world.configstrings.set(0, "hello");
      const baseline = at(f.world.baselines, 80); baseline.number = 81; baseline.modelindex = 4;
      const captured: { bytes: Uint8Array; bits: number; overflowed: boolean }[] = [], send = f.sender.sendMessageToClient.bind(f.sender);
      f.sender.sendMessageToClient = (value, writer) => { captured.push({ bytes: writer.toBytes(), bits: writer.bitPosition, overflowed: writer.overflowed }); send(value, writer); };
      f.lifecycle.sendClientGameState(client);
      expect(Buffer.from(at(captured, 0).bytes).toString("hex")).toBe("343562ab8547280cd99b110803c22e89dc2a5b391826e6aca175e7130000007068555d1a6f0a3e");
      expect(at(captured, 0).bits).toBe(310); expect(at(captured, 0).overflowed).toBe(false); f.receive();
      // Source oracle resets the whole client record; preserve the canonical slot identity here too.
      Object.assign(client, new ServerClient(product, 0));
      client.connection = { kind: "initialized", phase: ServerClientPhase.Connected, address: { kind: "loopback" }, netchan: new Netchannel("server") };
      f.world.configstrings.set(0, ""); baseline.number = 0; f.world.checksumFeed = 0;
      for (let index = 100; index < 104; index++) f.world.configstrings.set(index, " ".repeat(5000));
      f.lifecycle.sendClientGameState(client);
      expect(at(captured, 1).bytes.length).toBe(15016); expect(at(captured, 1).overflowed).toBe(false); f.receive();
      for (let index = 100; index < 110; index++) f.world.configstrings.set(index, "z".repeat(5000));
      f.lifecycle.sendClientGameState(client);
      expect(at(captured, 2).bytes.length).toBe(16381); expect(at(captured, 2).overflowed).toBe(true); f.receive();
    }
  });
  test("admission reads ping cvars after the source print callback and timestamps after connectResponse", async () => {
    const rejected = await fixture(); rejected.challenge(remote);
    const print = rejected.lifecycle.host.print;
    rejected.lifecycle.host.print = text => { print(text); if (text.includes("challenge ping")) rejected.cvars.set("sv_minPing", "51", true); };
    await rejected.connect(remote); expect(rejected.client().phase).toBe(ServerClientPhase.Free);
    expect(at(rejected.statics.challenges, 0).connected).toBe(true);
    const admitted = await fixture(), send = admitted.lifecycle.host.sendPacket;
    admitted.lifecycle.host.sendPacket = (address, bytes) => { send(address, bytes); if (decodeConnectionless(bytes, "client").command === "connectResponse") admitted.statics.time = 1777; };
    await admitted.connect(); expect(admitted.client().lastConnectTime).toBe(1777); expect(admitted.client().lastPacketTime).toBe(1777); expect(admitted.client().nextSnapshotTime).toBe(1777);
  });
  test("drop broadcast targets only current Primed/Active slots before game disconnect mutates configstrings", async () => {
    const f = await fixture("baseq3", 4); await f.connect();
    for (const [slot, phase] of [[0, ServerClientPhase.Active], [1, ServerClientPhase.Connected], [2, ServerClientPhase.Primed], [3, ServerClientPhase.Active]] satisfies readonly (readonly [number, ServerClientPhase])[]) {
      f.client(slot).connection = { kind: "initialized", phase, address: { kind: "loopback" }, netchan: new Netchannel("server", slot) };
    }
    finishCalls(f.lifecycle.dropClient(f.client(), "broadcast"));
    expect(f.client(1).reliable.sequence).toBe(0);
    for (const slot of [0, 2, 3]) expect(f.client(slot).reliable.lookupMasked(1)).toBe('print "Player^7 broadcast\n"');
    expect(f.client(0).reliable.pending().at(-1)?.text).toBe('disconnect "broadcast"');
    expect(f.client(2).reliable.lookupMasked(2)).toBe('cs 544 ""\n');
    expect(f.client(3).reliable.lookupMasked(2)).toBe('cs 544 ""\n');
  });
});
