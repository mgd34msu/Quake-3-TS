// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { FRAGMENT_SIZE, Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { decodeServerMessage, ServerOpcode } from "../src/protocol/server-message.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";
import { readDeltaEntity, readDeltaPlayerState } from "../src/protocol/state-delta.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import { ServerNetChannelRuntime } from "../src/server/net-channel.ts";
import type { ServerPacketAddress } from "../src/server/net-channel.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerSnapshotSendRuntime } from "../src/server/snapshot-send.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { GameType } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

// Native i386 oracle includes untouched sv_snapshot.c, msg.c, huffman.c and
// net_chan.c, and links untouched sv_net_chan.c and q_shared.c. Not QVM.
// /tmp/quake3-snapshot-send-reference-swhhsI/{fixture.c,run.sh}; gcc -m32 -O2
// -ffunction-sections -fdata-sections -Wl,--gc-sections. Cvar_Set and LAN/UDP
// services are capture boundaries; source EOF encoding and rate arithmetic run.
// RATE 12/387/387; MAXRATE 1548/1000; EOF pre2/post3,next1051,delayed1;
// EQUAL next1050,delayed1; LIMIT next1051,delayed0; CONNECTED2000;
// DOWNLOAD1050; SLOW3500; LOCAL/LAN999,retained delayed1.
// EARLY counter0/packets0; BOT counter1/packets0/downloadcalls0;
// FRAGMENT next2548/3896/3944,remaining1300/0/0,pending1/1/0.

function at<T>(items: ArrayLike<T>, index: number): T { const value = items[index]; if (value === undefined) throw new Error(`Missing fixture slot ${index}`); return value; }
function smallMap(): BspMap {
  const bounds = { min: vec3(-1024, -1024, -1024), max: vec3(1024, 1024, 1024) };
  return { entities: '{ "classname" "worldspawn" }', entityRecords: [], planes: [{ normal: vec3(1, 0, 0), distance: 0 }],
    nodes: [{ plane: 0, children: [-1, -1], bounds }], leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], visibility: { clusterCount: 1, bytesPerCluster: 1, bits: Uint8Array.of(1) },
    shaders: [], leafSurfaces: [], leafBrushes: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [] };
}
const downloadFileOwners: CommonFileState[] = [];
afterEach(() => { for (const files of downloadFileOwners.splice(0)) files.close(); });

async function fixture(product: Product = "baseq3", map = smallMap(), maxClients = 4) {
  const harness = createGameVerificationHarness({ product, map, gameType: GameType.GT_FFA, levelTime: 1000, randomSeed: 42,
    buildDate: "Sep 5 2026", clientNamePrefix: "Send", botsReason: "No bot AI in sender test", additionalCvars: [["sv_maxclients", String(maxClients)]] });
  const game = harness.runtime, statics = new ServerStaticState({ product, maxClients, dedicated: false }), prints: string[] = [];
  const world = new ServerWorldState(statics, { print: text => prints.push(text), dropClient: (_client, reason) => { throw new Error(reason); } });
  world.game = game; world.state = "game"; statics.time = 1000;
  const client = at(statics.clients, 0), netchan = new Netchannel("server");
  client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "ipv4", host: [203, 0, 113, 7], port: 27960 }, netchan };
  client.gameEntity = game.pool.at(0); client.rate = 4000; client.snapshotMsec = 50; client.name = "Fixture"; client.challenge = 1234;
  const cvars = new CvarRegistry();
  const downloadFiles = new CommonFileState({ homePath: process.cwd(), dataPath: process.cwd(), cdPath: null, product: "baseq3" },
    () => undefined, new SoundOutput(), cvars);
  downloadFileOwners.push(downloadFiles);
  await downloadFiles.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  for (const [name, value] of [["sv_maxRate", "0"], ["sv_lanForceRate", "0"], ["sv_padPackets", "0"], ["sv_maxclients", String(maxClients)], ["sv_allowDownload", "1"], ["sv_pure", "0"]]) {
    if (name === undefined || value === undefined) throw new Error("Missing cvar fixture"); cvars.register(name, value);
  }
  const downloads = new ServerDownloadRuntime(statics, { cvars, files: downloadFiles.server, print: text => prints.push(text),
    debugPrint: text => prints.push(text), dropClient: (_client, reason) => { throw new Error(reason); }, sendClientGameState: () => { throw new Error("Unexpected download restart"); } });
  const packets: Uint8Array[] = [], lanQueries: ServerPacketAddress[] = [], loopback = new LoopbackTransport();
  const channel = new ServerNetChannelRuntime(statics, { debugPrint: text => { prints.push(text); }, tracePacket: message => { expect(message).toMatch(/^server send /); }, sendPacket: (address, payload) => { packets.push(new Uint8Array(payload)); if (address.kind === "loopback") loopback.send("server", payload); },
    connectionless: () => { throw new Error("Unexpected connectionless input"); }, executeClientMessage: () => { throw new Error("Unexpected client input"); }, print: text => prints.push(text) });
  const snapshots = new ServerSnapshotRuntime(world, statics, { collision: game.options.collision, spatial: game.world, debugPrint: text => prints.push(text) });
  const sender = new ServerSnapshotSendRuntime(snapshots, channel, { cvars, downloads, isLanAddress: address => { lanQueries.push(address); return true; }, print: text => prints.push(text) });
  return { ...harness, game, statics, world, client, netchan, channel, cvars, downloads, packets, loopback, snapshots, sender, prints, lanQueries };
}
function connection(client: ServerClient) { if (client.connection.kind !== "initialized") throw new Error("Missing fixture connection"); return client.connection; }
function message(): MessageWriter { const writer = new MessageWriter(); writer.writeLong(0); return writer; }
function decodePacket(f: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const receiver = new Netchannel("client"), result = receiver.receive(at(f.packets, index));
  if (result.kind !== "accepted") throw new Error("Expected complete fixture packet");
  return xorServerMessage(result.payload, f.client.challenge, result.sequence, f.client.lastClientCommandString);
}

describe("source server snapshot send scheduling", () => {
  test("rate clamps packet size, forces the live case-insensitive maxRate cvar, and truncates division", async () => {
    const f = await fixture(); expect([0, 1500, 2000].map(size => f.sender.rateMsec(f.client, size))).toEqual([12, 387, 387]);
    f.cvars.register("sv_maxRate", "0", CvarFlag.Latch | CvarFlag.ReadOnly); f.cvars.set("sv_maxRate", "500", true);
    expect(f.sender.rateMsec(f.client, 1500)).toBe(1548); expect(f.cvars.get("sv_maxRate")?.value).toBe("1000");
    expect(f.cvars.get("sv_maxRate")?.latchedValue).toBeUndefined(); expect(f.client.rate).toBe(4000);
    f.client.rate = 0; expect(() => f.sender.rateMsec(f.client, 1)).toThrow("division by zero");
    expect(() => f.sender.rateMsec(new ServerClient("baseq3", 0), 1)).toThrow("belong");
  });
  test("frame metadata is pre-EOF while rate uses the post-EOF bytes and equality is delayed", async () => {
    const f = await fixture(), writer = message(); writer.writeByte(ServerOpcode.Nop); const before = writer.byteLength; f.client.rate = 1000; f.client.snapshotMsec = 0;
    f.sender.sendMessageToClient(f.client, writer);
    expect(writer.byteLength).toBeGreaterThan(before);
    expect(at(f.client.frames, 1).messageSize).toBe(before); expect(at(f.client.frames, 1).messageSent).toBe(1000); expect(at(f.client.frames, 1).messageAcked).toBe(-1);
    expect(f.client.nextSnapshotTime).toBe(1000 + writer.byteLength + 48); expect(f.client.rateDelayed).toBe(true);
    expect(at(f.client.frames, 2).messageSent).toBe(0); expect(f.netchan.outgoingSequence).toBe(2);
    f.client.snapshotMsec = 50; f.sender.sendMessageToClient(f.client, message()); expect(f.client.rateDelayed).toBe(true);
    f.client.snapshotMsec++; f.sender.sendMessageToClient(f.client, message()); expect(f.client.rateDelayed).toBe(false);
  });
  test("loopback and forced LAN preserve rateDelayed and bypass ordinary clamps", async () => {
    const f = await fixture(); f.client.rate = 0; f.client.rateDelayed = true; connection(f.client).address = { kind: "loopback" };
    f.sender.sendMessageToClient(f.client, message()); expect(f.client.nextSnapshotTime).toBe(999); expect(f.client.rateDelayed).toBe(true); expect(f.lanQueries).toHaveLength(0);
    connection(f.client).address = { kind: "ipv4", host: [10, 3, 4, 5], port: 27960 }; f.cvars.set("sv_lanForceRate", "1");
    f.sender.sendMessageToClient(f.client, message()); expect(f.client.nextSnapshotTime).toBe(999); expect(f.lanQueries).toHaveLength(1);
  });
  test("connected and zombie messages wait a second unless downloading, without shortening slower packets", async () => {
    const f = await fixture(); connection(f.client).phase = ServerClientPhase.Connected;
    f.sender.sendMessageToClient(f.client, message()); expect(f.client.nextSnapshotTime).toBe(2000);
    f.client.download.name = "fixture.pk3"; f.sender.sendMessageToClient(f.client, message()); expect(f.client.nextSnapshotTime).toBe(1050);
    f.client.download.name = ""; f.client.rate = 20; f.sender.sendMessageToClient(f.client, message()); expect(f.client.nextSnapshotTime).toBeGreaterThan(2000);
    f.client.rate = 4000; connection(f.client).phase = ServerClientPhase.Zombie; f.sender.sendClientSnapshot(f.client); expect(f.client.nextSnapshotTime).toBe(2000);
  });
  test("signed source time addition wraps", async () => {
    const f = await fixture(); f.statics.time = 0x7ffffff0; f.sender.sendMessageToClient(f.client, message()); expect(f.client.nextSnapshotTime).toBe(-2147483614);
  });
  test("snapshot command resend, source padding and real download error precede channel EOF", async () => {
    const f = await fixture(); f.client.lastClientCommand = 3; f.client.reliable.add("print first"); f.client.reliable.add("print second"); f.cvars.set("sv_padPackets", "2");
    f.downloads.begin(f.client, ["download", "missing-snapshot-send-fixture.pk3"]); f.sender.sendClientSnapshot(f.client);
    const decoded = decodeServerMessage(decodePacket(f), { ...f.snapshots.messageContext(f.client), messageNumber: 1, reliableSequence: 3, serverCommandSequence: 0 });
    expect(decoded.reliableAcknowledge).toBe(3); expect(decoded.operations.map(operation => operation.kind)).toEqual(["command", "command", "snapshot", "nop", "nop", "download"]);
    expect(f.client.reliableSent).toBe(2); expect(f.client.download.name).toBe("");
    f.sender.sendClientSnapshot(f.client); const repeated = decodeServerMessage(decodePacket(f, 1), { ...f.snapshots.messageContext(f.client), messageNumber: 2, reliableSequence: 3, serverCommandSequence: 0 });
    expect(repeated.operations.filter(operation => operation.kind === "command")).toHaveLength(2);
  });
  test("source overflow clears the entire snapshot, then transmits only EOF with zero pre-EOF size", async () => {
    const f = await fixture(); f.cvars.set("sv_padPackets", "100000"); f.sender.sendClientSnapshot(f.client);
    expect(f.prints).toContain("WARNING: msg overflowed for Fixture\n"); expect(at(f.client.frames, 1).messageSize).toBe(0);
    const payload = decodePacket(f); expect(new MessageReader(payload).readByte()).toBe(ServerOpcode.Eof);
    const eof = new MessageWriter(); eof.writeByte(ServerOpcode.Eof); expect(payload).toEqual(eof.toBytes());
  });
  test("snapshot deltas consume retained frames for removals, baseline additions and unchanged entities", async () => {
    const f = await fixture(), removed = f.game.pool.spawn(), added = f.game.pool.spawn(), kept = f.game.pool.spawn(), tail = f.game.pool.spawn();
    for (const entity of [removed, added, kept, tail]) {
      entity.r.linked = true; entity.r.svFlags = ServerEntityFlags.BROADCAST; entity.s.modelindex = 7;
    }
    f.snapshots.createBaselines(); added.r.linked = false;
    f.sender.sendClientSnapshot(f.client);
    const first = decodeServerMessage(decodePacket(f), { ...f.snapshots.messageContext(f.client), messageNumber: 1 });
    const firstSnapshot = first.operations.find(operation => operation.kind === "snapshot");
    if (firstSnapshot?.kind !== "snapshot") throw new Error("Missing initial delta frame");
    expect(firstSnapshot.snapshot.entities.map(entity => entity.number)).toEqual([removed.slot, kept.slot, tail.slot]);
    f.client.deltaMessage = 1; f.statics.time = 1050;
    removed.r.linked = false; added.r.linked = true; added.s.modelindex = 11; tail.r.linked = false;
    f.game.pool.clientAt(0).ps.commandTime = 1042;
    f.sender.sendClientSnapshot(f.client);
    const reader = new MessageReader(decodePacket(f, 1));
    expect(reader.readLong()).toBe(0); expect(reader.readByte()).toBe(ServerOpcode.Snapshot);
    expect(reader.readLong()).toBe(1050); expect(reader.readByte()).toBe(1); expect(reader.readByte()).toBe(0);
    expect(reader.readData(reader.readByte())).toEqual(Uint8Array.of(254));
    expect(readDeltaPlayerState(reader, firstSnapshot.snapshot.playerState, "baseq3").commandTime).toBe(1042);
    expect(reader.readBits(10)).toBe(removed.slot);
    expect(readDeltaEntity(reader, removed.s, removed.slot).number).toBe(1023);
    expect(reader.readBits(10)).toBe(added.slot);
    expect(readDeltaEntity(reader, at(f.world.baselines, added.slot), added.slot).modelindex).toBe(11);
    expect(reader.readBits(10)).toBe(tail.slot);
    expect(readDeltaEntity(reader, tail.s, tail.slot).number).toBe(1023);
    expect(reader.readBits(10)).toBe(1023); expect(reader.readByte()).toBe(ServerOpcode.Eof);
    const current = decodeServerMessage(decodePacket(f, 1), { ...f.snapshots.messageContext(f.client), messageNumber: 2 });
    const snapshot = current.operations.find(operation => operation.kind === "snapshot");
    if (snapshot?.kind !== "snapshot") throw new Error("Missing current delta frame");
    expect(snapshot.snapshot.entities.map(entity => [entity.number, entity.modelindex])).toEqual([[added.slot, 11], [kept.slot, 7]]);
  });
  test("single-client snapshots emit the physical entity ring after the current frame overwrites its start", async () => {
    const f = await fixture("baseq3", smallMap(), 1);
    expect(f.statics.numSnapshotEntities).toBe(256);
    expect(f.game.pool.numEntities).toBe(72);
    for (let index = 0; index < 257; index++) {
      const entity = f.game.pool.spawn();
      entity.r.linked = true;
      entity.r.svFlags = ServerEntityFlags.BROADCAST;
    }
    f.sender.sendClientSnapshot(f.client);
    expect(at(f.client.frames, 1).numEntities).toBe(257);
    expect(f.statics.nextSnapshotEntities).toBe(257);
    const reader = new MessageReader(decodePacket(f));
    expect(reader.readLong()).toBe(0); expect(reader.readByte()).toBe(ServerOpcode.Snapshot);
    expect(reader.readLong()).toBe(1000); expect(reader.readByte()).toBe(0); expect(reader.readByte()).toBe(0);
    expect(reader.readData(reader.readByte())).toEqual(Uint8Array.of(254));
    expect(readDeltaPlayerState(reader, null, "baseq3").clientNum).toBe(0);
    for (const expected of [328, ...Array.from({ length: 256 }, (_, index) => index + 73)]) {
      const number = reader.readBits(10);
      expect(number).toBe(expected);
      expect(readDeltaEntity(reader, at(f.world.baselines, number), number).number).toBe(expected);
    }
    expect(reader.readBits(10)).toBe(1023); expect(reader.readByte()).toBe(ServerOpcode.Eof);
  });
  test("real file download follows padding and advances its source window even when the message overflows", async () => {
    const f = await fixture(); f.downloads.begin(f.client, ["download", "LICENSE"]); f.cvars.set("sv_padPackets", "100000");
    try {
      f.sender.sendClientSnapshot(f.client);
      expect(f.client.download.file).not.toBeNull(); expect(f.client.download.xmitBlock).toBe(1); expect(f.client.download.sendTime).toBe(1000);
      expect(f.prints.findIndex(text => text.includes("writing block 0"))).toBeLessThan(f.prints.findIndex(text => text.includes("msg overflowed")));
      expect(new MessageReader(decodePacket(f)).readByte()).toBe(ServerOpcode.Eof);
    } finally { f.downloads.close(f.client); }
  });
  test("snapshot flags describe the previous send before this send updates rateDelayed", async () => {
    const f = await fixture(); f.client.rateDelayed = true; f.sender.sendClientSnapshot(f.client);
    expect(f.client.rateDelayed).toBe(false);
    const first = decodeServerMessage(decodePacket(f), { ...f.snapshots.messageContext(f.client), messageNumber: 1 });
    const firstSnapshot = first.operations.find(operation => operation.kind === "snapshot");
    expect(firstSnapshot?.kind === "snapshot" ? firstSnapshot.snapshot.flags : null).toBe(1);
    f.client.rate = 1; f.sender.sendClientSnapshot(f.client); expect(f.client.rateDelayed).toBe(true);
    const second = decodeServerMessage(decodePacket(f, 1), { ...f.snapshots.messageContext(f.client), messageNumber: 2 });
    const secondSnapshot = second.operations.find(operation => operation.kind === "snapshot");
    expect(secondSnapshot?.kind === "snapshot" ? secondSnapshot.snapshot.flags : null).toBe(0);
  });
  test("overflow caused only by EOF remains marked and transmits the original message", async () => {
    const f = await fixture(), writer = new MessageWriter("bitstream", 4); writer.writeByte(7); const before = writer.toBytes();
    f.sender.sendMessageToClient(f.client, writer); expect(writer.overflowed).toBe(true); expect(decodePacket(f)).toEqual(before);
    expect(at(f.client.frames, 1).messageSize).toBe(before.length);
  });
  test("fragment cadence uses remaining bytes before each fragment, including the empty terminator", async () => {
    const f = await fixture(); f.client.rate = 1000; f.client.rateDelayed = true;
    f.channel.transmit(f.client, { kind: "complete", payload: new Uint8Array(FRAGMENT_SIZE * 3) });
    expect(f.netchan.remainingUnsentBytes).toBe(2600); f.sender.sendClientMessages(); expect(f.client.nextSnapshotTime).toBe(2548); expect(f.packets).toHaveLength(2);
    f.sender.sendClientMessages(); expect(f.packets).toHaveLength(2);
    f.statics.time = 2548; f.sender.sendClientMessages(); expect(f.client.nextSnapshotTime).toBe(3896); expect(f.netchan.remainingUnsentBytes).toBe(0); expect(f.netchan.hasUnsentFragments).toBe(true);
    f.statics.time = 3896; f.sender.sendClientMessages(); expect(f.client.nextSnapshotTime).toBe(3944); expect(at(f.packets, 3).length).toBe(8);
    expect(f.netchan.hasUnsentFragments).toBe(false); expect(f.world.snapshotCounter).toBe(0); expect(at(f.client.frames, 1).messageSent).toBe(0); expect(f.client.rateDelayed).toBe(true);
  });
  test("send loop skips free/early clients; bots build but never send or update frame metadata", async () => {
    const f = await fixture(); f.client.nextSnapshotTime = 1001; f.sender.sendClientMessages(); expect(f.world.snapshotCounter).toBe(0);
    f.client.nextSnapshotTime = 1000; f.game.pool.at(0).r.svFlags |= ServerEntityFlags.BOT; connection(f.client).address = { kind: "bot" };
    f.sender.sendClientMessages(); expect(f.world.snapshotCounter).toBe(1); expect(f.packets).toHaveLength(0); expect(at(f.client.frames, 1).messageSent).toBe(0);
    f.cvars.set("sv_maxclients", "5"); expect(() => f.sender.sendClientMessages()).toThrow("canonical server client storage");
  });
  test("bot addresses without the entity BOT flag still advance the channel and rate schedule", async () => {
    for (const bound of [false, true]) {
      const f = await fixture();
      connection(f.client).address = { kind: "bot" };
      f.game.pool.at(0).r.svFlags &= ~ServerEntityFlags.BOT;
      if (!bound) f.client.gameEntity = null;
      f.cvars.set("sv_lanForceRate", "1");
      f.sender.sendClientSnapshot(f.client);
      expect(f.world.snapshotCounter).toBe(1);
      expect(f.packets).toHaveLength(0);
      expect(f.lanQueries).toHaveLength(0);
      expect(f.netchan.outgoingSequence).toBe(2);
      expect(at(f.client.frames, 1).messageSent).toBe(1000);
      expect(f.client.nextSnapshotTime).toBe(1050);
      expect(f.client.rateDelayed).toBe(false);
    }
  });
  test("zombie sends retain their entity pointer after game disposal; active sends and foreign channels reject", async () => {
    const f = await fixture(), frame = at(f.client.frames, 1); connection(f.client).phase = ServerClientPhase.Zombie; f.client.gameEntity = null; f.world.game = null;
    frame.areaBytes = 3; frame.firstEntity = 77; frame.playerState.commandTime = 42;
    f.sender.sendClientSnapshot(f.client); expect([frame.areaBytes, frame.firstEntity, frame.playerState.commandTime]).toEqual([3, 77, 42]);
    expect(frame.messageSent).toBe(1000); expect(f.packets).toHaveLength(1);
    f.client.gameEntity = f.game.pool.at(0); f.sender.sendClientSnapshot(f.client); expect(f.packets).toHaveLength(2);
    connection(f.client).phase = ServerClientPhase.Active; expect(() => f.sender.sendClientSnapshot(f.client)).toThrow("game");
    const other = await fixture(); expect(() => new ServerSnapshotSendRuntime(f.snapshots, other.channel, f.sender.host)).toThrow("share server state");
  });
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} retail GameRuntime sends real loopback snapshots into client-owned history`, async () => {
      const assets = await VirtualFileSystem.openInspection({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", cdPath: null, product });
      const map = parseBsp(await assets.read(`maps/${product === "baseq3" ? "q3dm1" : "mpteam1"}.bsp`));
      const f = await fixture(product, map); connection(f.client).address = { kind: "loopback" }; expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0);
      f.snapshots.createBaselines(); const history = new SnapshotHistory(), receiver = new Netchannel("client"), baselines = f.world.baselines.map(entity => entity.copy());
      let parseEntitiesNumber = 0;
      for (let index = 0; index < 3; index++) {
        f.game.runFrame(1100 + index * 100); f.statics.time = 1100 + index * 100; f.client.deltaMessage = index;
        f.sender.sendClientMessages();
        while (f.netchan.hasUnsentFragments) { f.statics.time = f.client.nextSnapshotTime; f.sender.sendClientMessages(); }
        let packet = f.loopback.poll("client"), delivered = 0;
        while (packet !== null) {
          const result = receiver.receive(packet.payload); if (result.kind === "rejected") throw new Error(result.reason);
          if (result.kind === "accepted") {
            const context: ServerMessageContext = { product, messageNumber: result.sequence, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber,
              baseline: number => at(baselines, number), history: number => history.readSlot(number) };
            const decoded = decodeServerMessage(xorServerMessage(result.payload, f.client.challenge, result.sequence, ""), context); parseEntitiesNumber = decoded.parseEntitiesNumber;
            const snapshot = decoded.operations.find(operation => operation.kind === "snapshot"); if (snapshot?.kind !== "snapshot") throw new Error("Missing snapshot");
            expect(snapshot.validity.kind).toBe("valid"); expect(history.publish(snapshot)).toBe(true); expect(snapshot.snapshot.entities.length).toBeGreaterThan(0);
            expect(snapshot.snapshot.deltaNumber).toBe(index === 0 ? -1 : index); expect(snapshot.snapshot.playerState.origin).toEqual(f.game.pool.clientAt(0).ps.origin); delivered++;
          }
          packet = f.loopback.poll("client");
        }
        expect(delivered).toBe(1);
      }
      const saved = history.latest; if (saved === null) throw new Error("Missing history"); const origin = { ...saved.playerState.origin };
      f.game.pool.clientAt(0).ps.origin = vec3(999, 999, 999); for (const frame of f.client.frames) frame.playerState.origin = vec3(999, 999, 999);
      expect(history.latest?.playerState.origin).toEqual(origin);
    });
  }
});
