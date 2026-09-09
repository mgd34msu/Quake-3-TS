import { finishCalls, runCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ServerPureRuntime } from "../src/server/pure.ts";
import { decodeServerMessage } from "../src/protocol/server-message.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { GameRuntime } from "../src/game/runtime.ts";
import { ServerWorld } from "../src/server/world.ts";
import type { GameBotServices } from "../src/game/runtime.ts";
import { decodeConnectionless, encodeConnect } from "../src/protocol/connectionless.ts";
import { Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { ServerClientCommandRuntime } from "../src/server/client-commands.ts";
import { ServerClientLifecycleRuntime } from "../src/server/client-lifecycle.ts";
import { addServerCommand } from "../src/server/configstrings.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import type { ServerPacketAddress } from "../src/server/net-channel.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import type { ServerAddress } from "../src/server/state.ts";
import type { Product } from "../src/shared/definitions.ts";

// Unchanged SV_VerifyPaks_f, native i386 GCC -O2 -DNDEBUG, both products:
// bash /tmp/quake3-server-pure-oracle-4FkOO9/run.sh. Its captured service tape proves
// lookup/admission/snapshot/drop order and libc parsing; these tests use actual PK3 and game services.
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
  const commandBuffer = new CommandBuffer();
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
      finishCalls(lifecycle.directConnect(from, at(decoded.arguments, 0))); },
    executeClientMessage: (value, reader) => commands.executeClientMessage(value, reader) });
  const snapshots = new ServerSnapshotRuntime(world, statics, { debugPrint, get collision() { return collision; }, get spatial() { return spatial; } });
  const sender = new ServerSnapshotSendRuntime(snapshots, channel, { cvars, downloads, print, isLanAddress });
  const lifecycle = new ServerClientLifecycleRuntime(world, statics, { cvars, downloads, sender, print, debugPrint, sendPacket, isLanAddress });
  const commands = new ServerClientCommandRuntime(world, statics, { debugBuild: false, pure: false, clientRunning: true, floodProtect: false,
    tokenize: text => commandBuffer.tokenize(text),
    print, debugPrint, dropClient, sendClientGameState, userinfoChanged: value => { lifecycle.userinfoChanged(value); },
    verifyPaks: () => { throw new Error("Pure verification is outside this non-pure handshake fixture"); },
    beginDownload: (value, argv) => { downloads.begin(value, argv); }, nextDownload: (value, argv) => downloads.next(value, argv),
    stopDownload: value => { downloads.stop(value); }, doneDownload: value => { downloads.done(value); } });
  statics.time = 1000; world.state = "loading";
  const bsp = map();
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
  const collision = new CollisionWorld(bsp, { kind: "unaccounted" }, { kind: "disabled" });
  const spatial = new ServerWorld(collision, collision.modelBounds(0), number => world.game?.data.entity(number), { get loading() { return world.state === "loading"; }, print: text => { print(text); }, developerPrint: text => { const developer = cvars.get("developer"); if (developer !== undefined && developer.integerValue !== 0) print(text); } });
  const game = GameRuntime.create({ product, map: bsp, collision, world: spatial, levelTime: 1000,
    randomSeed: 17, restart: false, buildDate: "fixture", cvars, configstrings: world.configstrings,
    engine: { milliseconds: () => statics.time, print, sendServerCommand: (slot, text) => {
      if (slot === -1) { for (const value of statics.clients) if (value.phase >= ServerClientPhase.Primed) finishCalls(addServerCommand(value, text, { print, dropClient })); }
      else finishCalls(addServerCommand(client(slot), text, { print, dropClient }));
    }, dropClient: (slot, reason) => { finishCalls(dropClient(client(slot), reason)); },
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
  return { statics, world, game, cvars, downloads, channel, snapshots, sender, lifecycle, commands, commandBuffer, prints, trace, packets, client, connect, challenge, receive };
}

interface StoredEntry { readonly name: string; readonly text: string }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function storedZip(entries: readonly StoredEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);
    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centrals.push(central);
    localOffset += local.byteLength;
  }
  const localBytes = concatenate(locals);
  const centralBytes = concatenate(centrals);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralBytes.byteLength, true);
  endView.setUint32(16, localBytes.byteLength, true);
  return concatenate([localBytes, centralBytes, end]);
}

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function pureFixture(product: Product = "baseq3", missing: "none" | "cgame" | "ui" = "none") {
  const f = await fixture(product), directory = await mkdtemp(join(tmpdir(), "quake3-pure-test-"));
  directories.push(directory);
  const gameDirectory = join(directory, product); await mkdir(gameDirectory, { recursive: true });
  // The archive entries are checksum fixtures, not executable QVMs or a runtime fallback.
  if (missing !== "cgame") await writeFile(join(gameDirectory, "pak0.pk3"), storedZip([{ name: "vm/cgame.qvm", text: "cgame checksum fixture" }]));
  if (missing !== "ui") await writeFile(join(gameDirectory, "pak1.pk3"), storedZip([{ name: "vm/ui.qvm", text: "ui checksum fixture" }]));
  await writeFile(join(gameDirectory, "pak2.pk3"), storedZip([{ name: "maps/data.bin", text: "general checksum fixture" }]));
  const files = await VirtualFileSystem.openTracked({ dataPath: directory, homePath: directory, cdPath: null, product, references: { checksumFeed: f.world.checksumFeed, random: () => 0 } });
  const accesses: string[] = [], lookup = files.pakPureChecksum.bind(files), loaded = files.pakReferences.loadedPakPureChecksums.bind(files.pakReferences);
  files.pakPureChecksum = path => { accesses.push(path); return lookup(path); };
  files.pakReferences.loadedPakPureChecksums = () => { accesses.push("loaded"); return loaded(); };
  const pure = new ServerPureRuntime(f.lifecycle, { cvars: f.cvars, files, tokenize: text => f.commandBuffer.tokenize(text), debugPrint: text => { f.trace.push(text); } });
  f.commands.host.verifyPaks = (client, argv) => pure.verifyPaks(client, argv);
  f.world.checksumFeedServerId = 100; f.cvars.set("sv_pure", "1", true); await f.connect();
  const client = f.client(); connection(client).phase = ServerClientPhase.Primed;
  const cgame = lookup("vm/cgame.qvm"), ui = lookup("vm/ui.qvm");
  const refs = files.pakReferences.snapshot().map(entry => entry.pack.pureChecksum | 0);
  const states: string[] = [], send = f.sender.sendClientSnapshot.bind(f.sender), drop = f.lifecycle.dropClient.bind(f.lifecycle);
  f.sender.sendClientSnapshot = value => { states.push(`snapshot:${value.phase}:${value.gotCP}:${value.pureAuthentic}:${value.nextSnapshotTime}`); send(value); };
  f.lifecycle.dropClient = function* (value, reason): CallSteps { states.push(`drop:${value.phase}:${value.gotCP}:${value.pureAuthentic}:${value.nextSnapshotTime}`); yield* drop(value, reason); };
  function argv(references: readonly number[] = refs): string[] {
    if (cgame === undefined || ui === undefined) throw new Error("Missing QVM metadata in this fixture");
    let trailer = f.world.checksumFeed;
    for (const value of references) trailer ^= value;
    trailer ^= references.length;
    return ["cp", "100", String(cgame | 0), String(ui | 0), "@", ...references.map(String), String(trailer)];
  }
  return { ...f, files, pure, accesses, states, refs, argv, directory };
}

describe("source server pure PK3 verification", () => {
  test("pure rejection waits for GAME disconnect after publishing the source snapshot", async () => {
    const f = await pureFixture(), client = f.client(), argv = f.argv();
    argv[argv.length - 1] = "1";
    const disconnect = f.game.calls.clientDisconnect.bind(f.game.calls);
    f.game.calls.clientDisconnect = function* (slot): CallSteps {
      yield async () => {
        expect(f.states).toEqual(["snapshot:4:true:false:-1", "drop:4:true:false:999"]);
        expect(client.phase).toBe(ServerClientPhase.Zombie);
        expect(client.userinfo).not.toBe("");
        expect(client.reliable.pending().some(command => command.text.startsWith("disconnect"))).toBe(false);
      };
      yield* disconnect(slot);
    };
    const completion = runCalls(f.pure.verifyPaks(client, argv));
    expect(completion).toBeInstanceOf(Promise);
    await completion;
    expect(client.userinfo).toBe("");
    expect(client.reliable.pending().at(-1)?.text).toBe('disconnect "Unpure client detected. Invalid .PK3 files referenced!"');
    expect(f.commandBuffer.tokenizedArguments).toEqual(f.files.pakReferences.loadedPakPureChecksums().trim().split(/\s+/));
  });

  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product}: actual tracked PK3 checksums authenticate without touching game or references`, async () => {
      const f = await pureFixture(product), client = f.client(), before = f.files.pakReferences.snapshot();
      const time = client.nextSnapshotTime;
      finishCalls(f.commands.executeClientCommand(client, f.argv().join(" "), true));
      expect(client.gotCP).toBe(true); expect(client.pureAuthentic).toBe(true); expect(client.phase).toBe(ServerClientPhase.Primed);
      expect(client.nextSnapshotTime).toBe(time); expect(f.states).toEqual([]);
      expect(f.accesses).toEqual(["vm/cgame.qvm", "vm/ui.qvm", "loaded"]);
      expect(f.files.pakReferences.snapshot()).toEqual(before);
      expect(f.refs.some(checksum => checksum < 0)).toBe(true);
    });
    test(`${product}: invalid trailer forces Active snapshot before actual game disconnect`, async () => {
      const f = await pureFixture(product), client = f.client(), argv = f.argv();
      argv[argv.length - 1] = "1"; client.pureAuthentic = true;
      finishCalls(f.pure.verifyPaks(client, argv));
      expect(f.states).toEqual(["snapshot:4:true:false:-1", "drop:4:true:false:999"]);
      expect(client.phase).toBe(ServerClientPhase.Zombie); expect(client.gotCP).toBe(true); expect(client.pureAuthentic).toBe(false);
      expect(f.trace).toContain("game-disconnect:0:1:true"); expect(client.userinfo).toBe("");
      expect(client.reliable.pending().at(-1)?.text).toBe('disconnect "Unpure client detected. Invalid .PK3 files referenced!"');
      expect(client.gamestateMessageNum).toBe(-1);
      const packet = f.receive(), decoded = decodeServerMessage(packet.bytes, { product, messageNumber: packet.sequence,
        reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null });
      expect(decoded.operations.some(operation => operation.kind === "snapshot")).toBe(true);
      expect(decoded.operations.some(operation => operation.kind === "gamestate")).toBe(false);
      expect(decoded.operations.some(operation => operation.kind === "command" && operation.text.startsWith("disconnect"))).toBe(false);
      const snapshot = decoded.operations.find(operation => operation.kind === "snapshot");
      if (snapshot?.kind !== "snapshot") throw new Error("Expected source pre-drop snapshot");
      expect(snapshot.snapshot.flags & 2).toBe(0);
    });
  }
  test("disabled pure leaves flags untouched and does no metadata lookup", async () => {
    const f = await pureFixture(); f.cvars.set("sv_pure", "0", true); f.client().pureAuthentic = true;
    finishCalls(f.pure.verifyPaks(f.client(), []));
    expect(f.client().pureAuthentic).toBe(true); expect(f.client().gotCP).toBe(false); expect(f.accesses).toEqual([]); expect(f.states).toEqual([]);
  });
  test("missing feed argument is native zero: stale at positive server id, rejected at zero", async () => {
    const f = await pureFixture(); f.world.checksumFeedServerId = 0;
    finishCalls(f.pure.verifyPaks(f.client(), [])); expect(f.client().gotCP).toBe(true); expect(f.client().phase).toBe(ServerClientPhase.Zombie);
    expect(f.accesses).toEqual(["vm/cgame.qvm", "vm/ui.qvm"]);
    const wrapped = await pureFixture(); wrapped.world.checksumFeedServerId = -2147483648;
    const argv = wrapped.argv([]); argv[1] = "2147483647";
    finishCalls(wrapped.pure.verifyPaks(wrapped.client(), argv)); expect(wrapped.client().pureAuthentic).toBe(true);
  });
  test("stale feed id returns after metadata lookups, even when cgame or ui is missing", async () => {
    for (const missing of ["none", "cgame", "ui"] satisfies readonly ("none" | "cgame" | "ui")[]) {
      const f = await pureFixture("baseq3", missing); f.client().pureAuthentic = true;
      finishCalls(f.pure.verifyPaks(f.client(), ["cp", "99"]));
      expect(f.accesses).toEqual(missing === "cgame" ? ["vm/cgame.qvm"] : ["vm/cgame.qvm", "vm/ui.qvm"]);
      expect(f.client().gotCP).toBe(false); expect(f.client().pureAuthentic).toBe(true); expect(f.states).toEqual([]);
      expect(f.trace).toContain("ignoring outdated cp command from client Player\n");
      finishCalls(f.pure.verifyPaks(f.client(), [])); expect(f.client().gotCP).toBe(false);
    }
  });
  test("missing QVM metadata never fabricates successful checksums", async () => {
    for (const missing of ["cgame", "ui"] satisfies readonly ("cgame" | "ui")[]) {
      const f = await pureFixture("baseq3", missing);
      finishCalls(f.pure.verifyPaks(f.client(), ["cp", "100", "0", "0", "@", String(f.world.checksumFeed)]));
      expect(f.client().pureAuthentic).toBe(false); expect(f.client().gotCP).toBe(true); expect(f.client().phase).toBe(ServerClientPhase.Zombie);
      expect(f.accesses.includes("loaded")).toBe(false);
    }
  });
  test("PK3 module lookup ignores loose overrides without opening them or marking references", async () => {
    const f = await pureFixture(), before = f.files.pakReferences.snapshot();
    await mkdir(join(f.directory, "baseq3", "vm"), { recursive: true });
    await writeFile(join(f.directory, "baseq3", "vm", "cgame.qvm"), "loose non-executable checksum fixture");
    finishCalls(f.pure.verifyPaks(f.client(), f.argv())); expect(f.client().pureAuthentic).toBe(true);
    expect(f.files.pakReferences.snapshot()).toEqual(before);
    const missing = await pureFixture("baseq3", "cgame");
    await mkdir(join(missing.directory, "baseq3", "vm"), { recursive: true });
    await writeFile(join(missing.directory, "baseq3", "vm", "cgame.qvm"), "not a packed module");
    finishCalls(missing.pure.verifyPaks(missing.client(), ["cp", "100", "0", "0", "@", String(missing.world.checksumFeed)]));
    expect(missing.client().phase).toBe(ServerClientPhase.Zombie); expect(missing.accesses).toEqual(["vm/cgame.qvm"]);
  });
  test("empty reference list and source @-prefixed delimiter are valid; module checksums need not be references", async () => {
    const f = await pureFixture(), argv = f.argv([]); argv[4] = "@suffix"; argv[1] = "2147483647";
    finishCalls(f.pure.verifyPaks(f.client(), argv)); expect(f.client().pureAuthentic).toBe(true); expect(f.accesses.at(-1)).toBe("loaded");
    const another = await pureFixture(); finishCalls(another.pure.verifyPaks(another.client(), another.argv([at(another.refs, 0)])));
    expect(another.client().pureAuthentic).toBe(true);
  });
  test("atoi comparison accepts whitespace, leading plus, and trailing text", async () => {
    const f = await pureFixture(), argv = f.argv();
    for (let index = 2; index < argv.length; index++) {
      if (index === 4) continue;
      const token = at(argv, index); argv[index] = ` ${token.startsWith("-") ? "" : "+"}${token}tail`;
    }
    finishCalls(f.pure.verifyPaks(f.client(), argv)); expect(f.client().pureAuthentic).toBe(true);
  });
  test("native i386 atoi saturates overflow and rejects unsigned checksum and non-isspace prefixes", async () => {
    const huge = await pureFixture(), argv = huge.argv(); argv[1] = "99999999999999999999999";
    finishCalls(huge.pure.verifyPaks(huge.client(), argv)); expect(huge.client().gotCP).toBe(true); expect(huge.client().pureAuthentic).toBe(true);
    const unsigned = await pureFixture(), unsignedArgs = unsigned.argv();
    const negativeModule = [2, 3].find(index => Number(at(unsignedArgs, index)) < 0);
    if (negativeModule === undefined) throw new Error("Fixture requires a negative module checksum");
    unsignedArgs[negativeModule] = String(Number(at(unsignedArgs, negativeModule)) >>> 0);
    finishCalls(unsigned.pure.verifyPaks(unsigned.client(), unsignedArgs)); expect(unsigned.client().phase).toBe(ServerClientPhase.Zombie);
    for (const prefix of ["\u0001", "\u00ff"]) {
      const f = await pureFixture(), args = f.argv(); args[2] = prefix + at(args, 2);
      finishCalls(f.pure.verifyPaks(f.client(), args)); expect(f.client().phase).toBe(ServerClientPhase.Zombie);
    }
  });
  test("duplicate parsed reference values fail before loaded-pak enumeration", async () => {
    const f = await pureFixture(), reference = at(f.refs, 0), argv = f.argv([reference, reference]); argv[6] = `${reference}suffix`;
    finishCalls(f.pure.verifyPaks(f.client(), argv)); expect(f.client().phase).toBe(ServerClientPhase.Zombie);
    expect(f.accesses).toEqual(["vm/cgame.qvm", "vm/ui.qvm"]);
  });
  test("unloaded reference and wrong count/feed trailer fail after loaded-pak enumeration", async () => {
    for (const badKind of ["membership", "count", "feed"]) {
      const f = await pureFixture(), argv = f.argv();
      if (badKind === "membership") argv[5] = "123";
      else argv[argv.length - 1] = String((Number(at(argv, argv.length - 1)) ^ (badKind === "count" ? 1 : 0x12345678)) | 0);
      finishCalls(f.pure.verifyPaks(f.client(), argv));
      expect(f.client().phase).toBe(ServerClientPhase.Zombie); expect(f.accesses.at(-1)).toBe("loaded");
    }
  });
  test("minimum argc, module @ prefixes and delimiter fail before loaded-pak enumeration", async () => {
    for (const badKind of ["short", "cgame", "ui", "delimiter"]) {
      const f = await pureFixture(), argv = f.argv([]);
      if (badKind === "short") argv.pop(); else argv[badKind === "cgame" ? 2 : badKind === "ui" ? 3 : 4] = badKind === "delimiter" ? "x@" : "@0";
      finishCalls(f.pure.verifyPaks(f.client(), argv));
      expect(f.client().gotCP).toBe(true); expect(f.client().phase).toBe(ServerClientPhase.Zombie); expect(f.accesses.includes("loaded")).toBe(false);
    }
  });
  test("direct over-cap inputs reject at copy stage after stale-id admission, without buffer overflow", async () => {
    const f = await pureFixture(), argv = f.argv([]); argv.splice(5, 1, ...Array.from({ length: 1025 }, (_, index) => String(index)));
    finishCalls(f.pure.verifyPaks(f.client(), argv)); expect(f.client().phase).toBe(ServerClientPhase.Zombie); expect(f.accesses.includes("loaded")).toBe(false);
    const stale = await pureFixture(), tooOld = stale.argv([]); tooOld[1] = "99"; tooOld.push(...argv);
    finishCalls(stale.pure.verifyPaks(stale.client(), tooOld)); expect(stale.client().gotCP).toBe(false); expect(stale.states).toEqual([]);
  });
  test("catalog feed mismatch and foreign client ownership are rejected before verification effects", async () => {
    const f = await pureFixture(); f.world.checksumFeed ^= 1;
    expect(() => new ServerPureRuntime(f.lifecycle, { cvars: f.cvars, files: f.files, tokenize: text => f.commandBuffer.tokenize(text), debugPrint: () => {} })).toThrow("checksum feed");
    expect(() => finishCalls(f.pure.verifyPaks(new ServerClient("missionpack", 0), []))).toThrow("does not belong"); expect(f.accesses).toEqual([]);
  });
});

const retailData = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  const available = await Bun.file(join(retailData, product, "pak0.pk3")).exists();
  test.skipIf(!available)(`${product}: installed retail PK3 metadata validates through actual game lifecycle without executing QVM`, async () => {
    const f = await fixture(product);
    const files = await VirtualFileSystem.openTracked({ dataPath: retailData, homePath: retailData, cdPath: null, product, references: { checksumFeed: f.world.checksumFeed, random: () => 0 } });
    const pure = new ServerPureRuntime(f.lifecycle, { cvars: f.cvars, files, tokenize: text => f.commandBuffer.tokenize(text), debugPrint: text => { f.trace.push(text); } });
    f.world.checksumFeedServerId = 100; f.cvars.set("sv_pure", "1", true); await f.connect();
    const cgame = files.pakPureChecksum("vm/cgame.qvm"), ui = files.pakPureChecksum("vm/ui.qvm");
    if (cgame === undefined || ui === undefined) throw new Error("Retail source modules missing from installed PK3 metadata");
    const refs = files.pakReferences.snapshot().map(value => value.pack.pureChecksum | 0), before = files.pakReferences.snapshot();
    let trailer = f.world.checksumFeed;
    for (const ref of refs) trailer ^= ref;
    trailer ^= refs.length;
    finishCalls(pure.verifyPaks(f.client(), ["cp", "100", String(cgame | 0), String(ui | 0), "@", ...refs.map(String), String(trailer)]));
    expect(f.client().gotCP).toBe(true); expect(f.client().pureAuthentic).toBe(true);
    expect(f.client().phase).toBe(ServerClientPhase.Connected); expect(files.pakReferences.snapshot()).toEqual(before);
    expect(refs.length).toBe(product === "baseq3" ? 9 : 10);
  });
}
