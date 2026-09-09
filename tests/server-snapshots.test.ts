// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import type { BspMap, BspNode } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { vec3 } from "../src/core/math.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { Vec3 } from "../src/core/math.ts";
import { setOrigin } from "../src/game/entities.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { readDeltaEntity, readDeltaPlayerState } from "../src/protocol/state-delta.ts";
import { decodeServerMessage, encodeServerMessage, ServerOpcode } from "../src/protocol/server-message.ts";
import type { ServerMessageContext } from "../src/protocol/server-message.ts";
import { ServerSnapshotRuntime } from "../src/server/snapshots.ts";
import { ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";
import { GameType } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { EntityShared, ServerEntityFlags } from "../src/shared/entity-shared.ts";
import { QvmGameData } from "../src/vm/game-data.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { createGameVerificationHarness } from "../tools/game-verification-harness.ts";

// Independent native-i386 control-flow oracle includes untouched sv_snapshot.c.
// gcc -m32 -O2 -ffunction-sections -fdata-sections -Wl,--gc-sections, not QVM.
// /tmp/quake3-server-snapshots-reference-i8B9qq/{fixture.c,run.sh}
// CM query traps supply the same synthetic leaf/area/PVS layout used below;
// TypeScript runs actual CollisionWorld and ServerWorld against that BSP.
// Captured: PORTALS 4 0 1 248 255 1 64 65 66 67; OVERFLOW -1/16/17 -> 1/1/0;
// PARTIAL 7 0 23 41 93 1 0; AGE28/AGE29/EXPIRED lastframe 28/0/0;
// FLAGS lastframe1 flags5; PRIMED lastframe0 flags7; FULL count1024 counter2.

function at<T>(items: ArrayLike<T>, index: number): T { const item = items[index]; if (item === undefined) throw new Error(`Missing snapshot fixture ${index}`); return item; }

function sourceFailure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected source error");
}
function mapForClusters(count = 3, visible: readonly number[] = [0], separateAreas = true): BspMap {
  const bounds = { min: vec3(-4096, -4096, -4096), max: vec3(4096, 4096, 4096) };
  const nodes: BspNode[] = Array.from({ length: count - 1 }, (_, index) => ({ plane: index,
    children: [-(index + 1), index === count - 2 ? -count : index + 1], bounds }));
  const bytesPerCluster = Math.ceil(count / 8), bits = new Uint8Array(count * bytesPerCluster);
  for (let from = 0; from < count; from++) for (const to of from === 0 ? visible : [from]) bits[from * bytesPerCluster + (to >> 3)] = at(bits, from * bytesPerCluster + (to >> 3)) | (1 << (to & 7));
  return { entities: '{ "classname" "worldspawn" }', entityRecords: [], planes: nodes.map((_, index) => ({ normal: vec3(1, 0, 0), distance: -100 * index })), nodes,
    leaves: Array.from({ length: count }, (_, cluster) => ({ cluster, area: separateAreas ? cluster : 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 })),
    models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], visibility: { clusterCount: count, bytesPerCluster, bits },
    shaders: [], leafSurfaces: [], leafBrushes: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [] };
}
function fixture(map = mapForClusters(), product: Product = "baseq3") {
  const harness = createGameVerificationHarness({ product, map, gameType: GameType.GT_FFA, levelTime: 1000, randomSeed: 42,
    buildDate: "Sep 5 2026", clientNamePrefix: "Snapshot", botsReason: "Snapshot fixture excludes bots" });
  const game = harness.runtime, statics = new ServerStaticState({ product, maxClients: 4, dedicated: false }), diagnostics: string[] = [];
  statics.resetSnapshotEntities({ kind: "source-hunk", accounting: new SourceHunkAccounting(new HunkArena(1024 * 1024, () => undefined)) });
  const world = new ServerWorldState(statics, { print: text => diagnostics.push(text), dropClient: (_client, reason) => { throw new Error(reason); } });
  world.game = game; world.state = "game"; statics.time = 1000;
  const client = at(statics.clients, 0), channel = new Netchannel("server");
  client.connection = { kind: "initialized", phase: ServerClientPhase.Active, address: { kind: "loopback" }, netchan: channel }; client.gameEntity = game.pool.at(0);
  game.pool.clientAt(0).ps.clientNum = 0; game.pool.clientAt(0).ps.origin = vec3(50, 0, 0);
  const runtime = new ServerSnapshotRuntime(world, statics, { collision: game.options.collision, spatial: game.world, debugPrint: text => diagnostics.push(text) });
  function entity(origin = vec3(50, 0, 0), flags = 0) {
    const ent = game.pool.spawn(); setOrigin(ent, origin); ent.s.origin = { ...origin }; ent.r.svFlags = flags;
    game.world.link(ent); return ent;
  }
  const numbers = () => runtime.snapshotOperation(client).snapshot.entities.map(ent => ent.number);
  return { ...harness, game, statics, world, client, channel, diagnostics, runtime, entity, numbers };
}

describe("source server snapshot construction", () => {
  test("raw mod words survive live publication, baseline copies and server frame storage", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = fixture(mapForClusters(), product), memory = new QvmMemory(new Uint8Array(4096));
      const data = new QvmGameData(memory, product);
      data.locate(64, 2, 516, 2048, 468);
      f.world.game = { product, data, calls: f.game.calls, disposeResources: () => { f.game.disposeResources(); } };
      f.client.gameEntity = data.entity(0);
      const entity = data.entity(1), entityWords = memory.view(64 + 516, 208), playerWords = memory.view(2048, 468);
      entity.r.linked = true; entity.r.svFlags = ServerEntityFlags.BROADCAST;
      entityWords.setInt32(12, 0x12345678, true); entityWords.setInt32(48, -5, true);
      playerWords.setInt32(4, 0x123456a5, true); playerWords.setFloat32(20, 50, true);
      playerWords.setInt32(144, 0x1234561f, true); playerWords.setInt32(148, -1, true);
      playerWords.setInt32(452, 91, true); playerWords.setInt32(456, 0x7fffffff, true);
      playerWords.setInt32(460, -7, true); playerWords.setInt32(464, 0x1020304, true);
      f.runtime.createBaselines();
      expect(entityWords.getInt32(0, true)).toBe(1);
      expect([at(f.world.baselines, 1).pos.type, at(f.world.baselines, 1).apos.type]).toEqual([0x12345678, -5]);
      entityWords.setInt32(12, -17, true); entityWords.setInt32(48, 0x123456ab, true);
      const frame = f.runtime.buildClientSnapshot(f.client), published = f.runtime.snapshotOperation(f.client).snapshot;
      expect([frame.playerState.pmType, frame.playerState.weapon, frame.playerState.weaponState]).toEqual([0x123456a5, 0x1234561f, -1]);
      expect([frame.playerState.ping, frame.playerState.pmoveFramecount, frame.playerState.jumppadFrame, frame.playerState.entityEventSequence])
        .toEqual([91, 0x7fffffff, -7, 0x1020304]);
      const stored = f.statics.snapshotEntities.get(frame.firstEntity % f.statics.numSnapshotEntities);
      expect([stored.pos.type, stored.apos.type]).toEqual([-17, 0x123456ab]);
      entityWords.setInt32(12, 7, true); playerWords.setInt32(4, 7, true); playerWords.setInt32(452, 7, true);
      expect([published.playerState.pmType, published.playerState.ping, at(published.entities, 0).pos.type]).toEqual([0x123456a5, 91, -17]);
      expect([at(f.world.baselines, 1).pos.type, f.statics.snapshotEntities.get(frame.firstEntity).pos.type]).toEqual([0x12345678, -17]);
      const writer = new MessageWriter(); writer.writeLong(0);
      f.runtime.writeSnapshotToClient(f.client, writer); writer.writeByte(ServerOpcode.Eof);
      const decoded = decodeServerMessage(writer.toBytes(), f.runtime.messageContext(f.client));
      const operation = decoded.operations[0];
      if (operation?.kind !== "snapshot") throw new Error("Missing raw mod snapshot");
      expect(operation.validity).toEqual({ kind: "valid" });
      expect([operation.snapshot.playerState.pmType, operation.snapshot.playerState.weapon, operation.snapshot.playerState.weaponState]).toEqual([0xa5, 31, 15]);
      expect([at(operation.snapshot.entities, 0).pos.type, at(operation.snapshot.entities, 0).apos.type]).toEqual([0xef, 0xab]);
      f.channel.transmit(new Uint8Array()); f.client.deltaMessage = 1;
      const previous = f.runtime.messageContext(f.client).history(1);
      if (previous === null) throw new Error("Missing raw mod delta frame");
      expect([previous.snapshot.playerState.pmType, previous.snapshot.playerState.ping, previous.snapshot.playerState.entityEventSequence])
        .toEqual([0x123456a5, 91, 0x1020304]);
      expect(at(previous.snapshot.entities, 0).pos.type).toBe(-17);
    }
  });
  test("module data supplies player state and live entities while the retained pointer only gates construction", () => {
    const f = fixture(), visible = f.entity(), follow = f.game.pool.at(1), reads: number[] = [];
    setOrigin(follow, vec3(50, 0, 0)); f.game.world.link(follow);
    f.game.pool.clientAt(0).ps.clientNum = 1;
    f.client.gameEntity = { s: new EntityState(), r: new EntityShared() };
    f.client.gameEntity.s.number = 400;
    f.world.game = {
      product: f.game.product,
      data: {
        get numEntities() { return f.game.data.numEntities; },
        entity: number => f.game.data.entity(number),
        copyPlayerState: client => { reads.push(client); return f.game.data.copyPlayerState(client); },
        setPlayerPing: (client, ping) => { f.game.data.setPlayerPing(client, ping); },
      },
      calls: f.game.calls,
      disposeResources: () => { f.game.disposeResources(); },
    };
    f.runtime.createBaselines();
    const frame = f.runtime.buildClientSnapshot(f.client);
    expect(reads).toEqual([0]); expect(frame.playerState.clientNum).toBe(1);
    expect(f.numbers()).toEqual([visible.slot]); expect(f.client.gameEntity.s.number).toBe(400);
    const savedOrigin = { ...frame.playerState.origin };
    f.game.pool.clientAt(0).ps.origin = vec3(-150, 0, 0);
    expect(frame.playerState.origin).toEqual(savedOrigin);
    f.game.pool.clientAt(0).ps.origin = vec3(50, 0, 0);
    const added = f.entity(); f.runtime.buildClientSnapshot(f.client);
    expect(f.numbers()).toEqual([visible.slot, added.slot]);
  });
  test("module linked flags govern baselines and broadcasts independently of spatial membership", () => {
    const f = fixture(), linked = f.entity(), broadcast = f.game.pool.spawn();
    linked.r.linked = false;
    broadcast.r.linked = true; broadcast.r.svFlags = ServerEntityFlags.BROADCAST;
    broadcast.s.number = 900; broadcast.s.modelindex = 42;
    expect(f.game.world.linkState(broadcast.slot)).toBeUndefined();
    f.runtime.createBaselines();
    expect(at(f.world.baselines, linked.slot).number).toBe(0);
    expect(at(f.world.baselines, broadcast.slot).modelindex).toBe(42);
    f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual([broadcast.slot]);
    broadcast.s.modelindex = 43; expect(at(f.world.baselines, broadcast.slot).modelindex).toBe(42);
  });
  test("baselines start at one, skip unlinked entities, fix source numbers and own copies", () => {
    const f = fixture(), linked = f.entity(), unlinked = f.entity(); f.game.world.unlink(unlinked.slot);
    const zero = f.game.pool.at(0); setOrigin(zero, vec3(50, 0, 0)); f.game.world.link(zero); zero.s.modelindex = 99;
    linked.s.number = 900; linked.s.origin2 = vec3(1, 2, 3); f.runtime.createBaselines();
    expect(linked.s.number).toBe(linked.slot); expect(at(f.world.baselines, 0).modelindex).toBe(0);
    expect(at(f.world.baselines, unlinked.slot).number).toBe(0);
    linked.s.origin2 = vec3(9, 9, 9); expect(at(f.world.baselines, linked.slot).origin2).toEqual(vec3(1, 2, 3));
  });
  test("linked state, client flags, masks and follow-client self exclusion precede PVS", () => {
    const f = fixture(), normal = f.entity(), hidden = f.entity(vec3(50, 0, 0), ServerEntityFlags.NOCLIENT | ServerEntityFlags.BROADCAST);
    const single = f.entity(vec3(50, 0, 0), ServerEntityFlags.SINGLECLIENT); single.r.singleClient = 1;
    const notSingle = f.entity(vec3(50, 0, 0), ServerEntityFlags.NOTSINGLECLIENT); notSingle.r.singleClient = 0;
    const mask = f.entity(vec3(50, 0, 0), ServerEntityFlags.CLIENTMASK); mask.r.singleClient = 2;
    const distant = f.entity(vec3(-150, 0, 0), ServerEntityFlags.BROADCAST), unlinked = f.entity(); f.game.world.unlink(unlinked.slot);
    const follow = f.game.pool.at(1); follow.s.number = 1; setOrigin(follow, vec3(50, 0, 0)); f.game.world.link(follow);
    f.game.pool.clientAt(0).ps.clientNum = 1; normal.s.number = 999;
    f.runtime.buildClientSnapshot(f.client);
    expect(f.numbers()).toEqual([normal.slot, single.slot, notSingle.slot, mask.slot, distant.slot]);
    expect(f.numbers()).not.toContain(hidden.slot); expect(f.numbers()).not.toContain(1); expect(f.diagnostics).toEqual(["FIXING ENT->S.NUMBER!!!\n"]);
    f.game.pool.clientAt(0).ps.clientNum = 32;
    expect(sourceFailure(() => f.runtime.buildClientSnapshot(f.client))).toMatchObject({ name: "CommonError", code: "drop", message: "SVF_CLIENTMASK: cientNum > 32\n" });
    f.game.pool.clientAt(0).ps.clientNum = -1;
    expect(sourceFailure(() => f.runtime.buildClientSnapshot(f.client))).toMatchObject({ name: "CommonError", code: "drop", message: "SV_SvEntityForGentity: bad gEnt" });
  });
  test("portals recursively OR area bits, deduplicate, sort and preserve distance/broadcast rules", () => {
    const f = fixture(), remote = f.entity(vec3(-150, 0, 0)), middle = f.entity(vec3(-50, 0, 0));
    remote.r.svFlags = ServerEntityFlags.PORTAL; remote.s.origin2 = vec3(50, 0, 0);
    const secondPortal = f.entity(vec3(-50, 0, 0), ServerEntityFlags.PORTAL); secondPortal.s.origin2 = vec3(-150, 0, 0);
    const portal = f.entity(vec3(50, 0, 0), ServerEntityFlags.PORTAL); portal.s.origin2 = vec3(-50, 0, 0);
    const frame = f.runtime.buildClientSnapshot(f.client);
    expect(f.numbers()).toEqual([remote.slot, middle.slot, secondPortal.slot, portal.slot]);
    expect(frame.areaBytes).toBe(1); expect(frame.areaBits).toEqual(Uint8Array.from([248, ...Array.from({ length: 31 }, () => 255)]));
    portal.s.generic1 = 1; portal.s.origin = vec3(100, 0, 0); f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual([portal.slot]);
    portal.s.generic1 = 50; f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toContain(remote.slot);
    portal.r.svFlags |= ServerEntityFlags.BROADCAST; f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual([portal.slot]);
  });
  test("closed areas block PVS entities; straddling area2 and opened portals permit them", () => {
    const f = fixture(mapForClusters(3, [0, 1, 2])), distant = f.entity(vec3(-150, 0, 0));
    const door = f.entity(vec3(-50, 0, 0)); door.r.mins = vec3(-60, 0, 0); door.r.maxs = vec3(60, 0, 0); f.game.world.link(door);
    f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual([door.slot]);
    f.game.options.collision.adjustAreaPortalState(0, 2, true); f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual([distant.slot, door.slot]);
  });
  test("overflow lastCluster equality retains the original surprising visibility result", () => {
    for (const visible of [[], [16], [17]]) {
      const f = fixture(mapForClusters(18, visible, false)), large = f.entity(vec3(-800, 0, 0));
      large.r.mins = vec3(-1000, 0, 0); large.r.maxs = vec3(1000, 0, 0); f.game.world.link(large);
      const link = f.game.world.linkState(large.slot); expect(link?.clusters).toHaveLength(16); expect(link?.lastCluster).toBe(17);
      f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual(visible.includes(17) ? [] : [large.slot]);
    }
  });
  test("unbound and zombie frames clear only entity count and area bits while advancing counter", () => {
    const f = fixture(), frame = at(f.client.frames, 1); frame.areaBits.fill(17); frame.areaBytes = 7; frame.numEntities = 12;
    frame.firstEntity = 23; frame.playerState.commandTime = 41; frame.messageSent = 93; f.client.gameEntity = null;
    expect(f.runtime.buildClientSnapshot(f.client)).toBe(frame); expect(frame.areaBits).toEqual(new Uint8Array(32));
    expect([frame.areaBytes, frame.numEntities, frame.firstEntity, frame.playerState.commandTime, frame.messageSent, f.world.snapshotCounter]).toEqual([7, 0, 23, 41, 93, 1]);
    f.client.gameEntity = f.game.pool.at(0); if (f.client.connection.kind !== "initialized") throw new Error("Missing connection");
    f.client.connection.phase = ServerClientPhase.Zombie; f.world.game = null; f.runtime.buildClientSnapshot(f.client);
    expect(f.world.snapshotCounter).toBe(2); expect(frame.playerState.commandTime).toBe(41);
  });
  test("shutdown skips visibility but still inverts the full mask and publishes player state", () => {
    const f = fixture(); f.entity(); f.world.state = "dead"; const frame = at(f.client.frames, 1); frame.areaBytes = 4;
    f.runtime.buildClientSnapshot(f.client); expect(frame.areaBytes).toBe(4); expect(frame.areaBits.every(byte => byte === 255)).toBe(true); expect(frame.numEntities).toBe(0);
  });
  test("entity history wrap guard copies/increments before failing but does not count the entity", () => {
    const f = fixture(), ent = f.entity(); f.statics.nextSnapshotEntities = 0x7ffffffd;
    expect(sourceFailure(() => f.runtime.buildClientSnapshot(f.client))).toMatchObject({ name: "CommonError", code: "fatal", message: "svs.nextSnapshotEntities wrapped" });
    expect(f.statics.nextSnapshotEntities).toBe(0x7ffffffe); expect(at(f.client.frames, 1).numEntities).toBe(0);
    expect(f.statics.snapshotEntities.get(0x7ffffffd % f.statics.numSnapshotEntities).number).toBe(ent.slot);
  });
  test("maximum canonical game entity population remains sorted, unique and counter marked", () => {
    const f = fixture();
    while (f.game.pool.numEntities < 1022) f.game.pool.spawn();
    for (let number = 0; number < f.game.pool.numEntities; number++) {
      const entity = f.game.pool.at(number); entity.s.number = number; setOrigin(entity, vec3(50, 0, 0)); f.game.world.link(entity);
    }
    f.world.snapshotCounter = 0x7fffffff;
    const frame = f.runtime.buildClientSnapshot(f.client);
    expect(frame.numEntities).toBe(1021); expect(f.numbers()).toEqual(Array.from({ length: 1021 }, (_, index) => index + 1));
    expect(f.world.snapshotCounter).toBe(-0x80000000);
    expect(f.world.entitySnapshotCounters.subarray(0, 1022).every(counter => counter === -0x80000000)).toBe(true);
  });
  test("PVS reads use the zeroed collision allocation tail and reject beyond its end", () => {
    const map = mapForClusters(3, [0], false);
    const malformed = { ...map, leaves: map.leaves.map((leaf, index) => index === 2 ? { ...leaf, cluster: 31 } : leaf) };
    const f = fixture(malformed), tail = f.entity(vec3(-150, 0, 0));
    f.runtime.buildClientSnapshot(f.client);
    expect(f.numbers()).not.toContain(tail.slot);
    const outside = fixture({ ...map, leaves: map.leaves.map((leaf, index) => index === 2 ? { ...leaf, cluster: 96 } : leaf) });
    outside.entity(vec3(-150, 0, 0));
    expect(() => outside.runtime.buildClientSnapshot(outside.client)).toThrow("PVS byte 12 outside stored visibility allocation of 11 bytes");
  });
});

describe("source server snapshot delta selection and publication", () => {
  test("equal and future acknowledgements consume masked source frames and truncate the wire distance", () => {
    for (const acknowledgement of [1, 2, 33, 257, 0x7fffffff]) {
      const f = fixture();
      const frame = f.runtime.buildClientSnapshot(f.client);
      frame.playerState.commandTime = 1234;
      const old = at(f.client.frames, acknowledgement & 31);
      old.playerState.stats.set(0, 71);
      f.client.deltaMessage = acknowledgement;
      const writer = new MessageWriter();
      f.runtime.writeSnapshotToClient(f.client, writer);
      const reader = new MessageReader(writer.toBytes());
      expect(reader.readByte()).toBe(ServerOpcode.Snapshot);
      expect(reader.readLong()).toBe(1000);
      expect(reader.readByte()).toBe((1 - acknowledgement) & 255);
      expect(reader.readByte()).toBe(0);
      expect(reader.readData(reader.readByte())).toEqual(frame.areaBits.subarray(0, frame.areaBytes));
      const decoded = readDeltaPlayerState(reader, old.playerState, "baseq3");
      expect(decoded.commandTime).toBe(1234);
      expect(decoded.stats.get(0)).toBe(frame.playerState.stats.get(0));
      expect(reader.readBits(10)).toBe(1023);
      expect(f.diagnostics).toEqual([]);
    }
  });
  test("linked external slot 1023 is built and written before the packet entity terminator", () => {
    const f = fixture(), memory = new QvmMemory(new Uint8Array(1024 * 1024));
    const data = new QvmGameData(memory, "baseq3");
    data.locate(64, 1024, 516, 64 + 1024 * 516, 468);
    f.world.game = { product: "baseq3", data, calls: f.game.calls, disposeResources: () => f.game.disposeResources() };
    f.client.gameEntity = data.entity(0);
    const entity = data.entity(1023);
    entity.r.linked = true;
    entity.r.svFlags = ServerEntityFlags.BROADCAST;
    entity.s.modelindex = 17;
    const frame = f.runtime.buildClientSnapshot(f.client);
    expect(frame.numEntities).toBe(1);
    expect(f.statics.snapshotEntities.get(frame.firstEntity).number).toBe(1023);
    expect(f.world.entitySnapshotCounters[1023]).toBe(f.world.snapshotCounter);
    const writer = new MessageWriter();
    f.runtime.writeSnapshotToClient(f.client, writer);
    const reader = new MessageReader(writer.toBytes());
    expect(reader.readByte()).toBe(ServerOpcode.Snapshot);
    expect(reader.readLong()).toBe(1000);
    expect(reader.readByte()).toBe(0);
    expect(reader.readByte()).toBe(0);
    reader.readData(reader.readByte());
    readDeltaPlayerState(reader, null, "baseq3");
    expect(reader.readBits(10)).toBe(1023);
    expect(readDeltaEntity(reader, at(f.world.baselines, 1023), 1023).modelindex).toBe(17);
    expect(reader.readBits(10)).toBe(1023);
    expect(() => f.runtime.snapshotOperation(f.client)).toThrow("sentinel 1023");
  });
  test("packet age 29 and entity expiry equality select full snapshots; flags use live source state", () => {
    const f = fixture(); f.entity(); f.runtime.buildClientSnapshot(f.client); f.channel.transmit(new Uint8Array());
    f.client.deltaMessage = 1; f.runtime.buildClientSnapshot(f.client); expect(f.runtime.snapshotOperation(f.client).snapshot.deltaNumber).toBe(1);
    f.statics.snapFlagServerBit = 4; f.client.rateDelayed = true; expect(f.runtime.snapshotOperation(f.client).snapshot.flags).toBe(5);
    if (f.client.connection.kind !== "initialized") throw new Error("Missing connection");
    f.client.connection.phase = ServerClientPhase.Primed; expect(f.runtime.snapshotOperation(f.client).snapshot.flags).toBe(7); expect(f.runtime.snapshotOperation(f.client).snapshot.deltaNumber).toBe(-1);
    f.client.connection.phase = ServerClientPhase.Active;
    f.statics.nextSnapshotEntities = f.statics.numSnapshotEntities; expect(f.runtime.snapshotOperation(f.client).snapshot.deltaNumber).toBe(-1);
    expect(f.diagnostics).toContain(": Delta request from out of date entities.\n");
    f.statics.nextSnapshotEntities = 0;
    while (f.channel.outgoingSequence < 29) f.channel.transmit(new Uint8Array());
    expect(f.runtime.snapshotOperation(f.client).snapshot.deltaNumber).toBe(1);
    f.channel.transmit(new Uint8Array()); expect(f.runtime.snapshotOperation(f.client).snapshot.deltaNumber).toBe(-1);
    expect(f.diagnostics).toContain(": Delta request from out of date packet.\n");
  });
  test("entity storage wraps physically while logical frame ranges and mask bit31 stay intact", () => {
    const f = fixture(), first = f.entity(vec3(50, 0, 0), ServerEntityFlags.CLIENTMASK | ServerEntityFlags.BOT), second = f.entity(vec3(50, 0, 0), ServerEntityFlags.USE_CURRENT_ORIGIN | ServerEntityFlags.NOSERVERINFO);
    first.r.singleClient = -0x80000000; f.game.pool.clientAt(0).ps.clientNum = 31;
    f.statics.nextSnapshotEntities = f.statics.numSnapshotEntities - 1;
    const frame = f.runtime.buildClientSnapshot(f.client);
    expect(frame.firstEntity).toBe(f.statics.numSnapshotEntities - 1); expect(frame.numEntities).toBe(2);
    expect(f.numbers()).toEqual([first.slot, second.slot]); expect(f.statics.snapshotEntities.get(0).number).toBe(second.slot);
    f.game.pool.clientAt(0).ps.clientNum = 0; f.runtime.buildClientSnapshot(f.client); expect(f.numbers()).toEqual([second.slot]);
  });
  test("operation and encoder context survive source mutation, frame/ring reuse and consumer mutation", () => {
    const f = fixture(), ent = f.entity(); f.runtime.createBaselines(); f.runtime.buildClientSnapshot(f.client);
    f.channel.transmit(new Uint8Array()); f.client.deltaMessage = 1; ent.s.modelindex = 7; f.runtime.buildClientSnapshot(f.client);
    const operation = f.runtime.snapshotOperation(f.client), context = f.runtime.messageContext(f.client);
    const expected = encodeServerMessage(0, [operation], context);
    ent.s.modelindex = 99; at(f.world.baselines, ent.slot).modelindex = 99;
    for (let index = 0; index < f.statics.numSnapshotEntities; index++) {
      const stored = f.statics.snapshotEntities.get(index); stored.modelindex = 99; f.statics.snapshotEntities.set(index, stored);
    }
    for (const frame of f.client.frames) frame.playerState.commandTime = 99;
    const baseline = context.baseline(ent.slot); if (baseline === null) throw new Error("Missing baseline"); baseline.modelindex = 101;
    const old = context.history(1); if (old === null) throw new Error("Missing delta frame"); at(old.snapshot.entities, 0).modelindex = 101;
    expect(operation.snapshot.entities[0]?.modelindex).toBe(7); expect(encodeServerMessage(0, [operation], context)).toEqual(expected);
  });
  test("foreign clients, uninitialized channels and protocol sentinel states reject explicitly", () => {
    const f = fixture(); expect(() => f.runtime.buildClientSnapshot(new ServerClient("baseq3", 0))).toThrow("Foreign");
    expect(() => f.runtime.snapshotOperation(at(f.statics.clients, 1))).toThrow("initialized channel");
    const ent = f.entity(); f.runtime.buildClientSnapshot(f.client);
    const stored = f.statics.snapshotEntities.get(0); stored.number = 1023; f.statics.snapshotEntities.set(0, stored);
    expect(() => f.runtime.snapshotOperation(f.client)).toThrow("sentinel 1023"); expect(ent.s.number).toBe(ent.slot);
  });
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} retail GameRuntime snapshots encode/decode into client-owned history`, async () => {
      const assets = await VirtualFileSystem.openInspection({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", cdPath: null, product });
      const map = parseBsp(await assets.read(`maps/${product === "baseq3" ? "q3dm1" : "mpteam1"}.bsp`));
      const f = fixture(map, product); expect(f.game.clientConnect(0, true, false)).toBeNull(); f.game.clientBegin(0); f.game.runFrame(1100); f.statics.time = 1100;
      f.runtime.createBaselines(); const history = new SnapshotHistory();
      const clientBaseline = f.world.baselines.map(entity => entity.copy());
      let parseEntitiesNumber = 0;
      for (let index = 0; index < 3; index++) {
        const sequence = f.channel.outgoingSequence; f.client.deltaMessage = sequence === 1 ? 0 : sequence - 1;
        f.runtime.buildClientSnapshot(f.client); const operation = f.runtime.snapshotOperation(f.client);
        const bytes = encodeServerMessage(f.client.lastClientCommand, [operation], f.runtime.messageContext(f.client));
        const context: ServerMessageContext = { product, messageNumber: sequence, reliableSequence: 0, serverCommandSequence: 0, parseEntitiesNumber,
          baseline: number => at(clientBaseline, number), history: number => history.readSlot(number) };
        const decoded = decodeServerMessage(bytes, context); parseEntitiesNumber = decoded.parseEntitiesNumber;
        const snap = decoded.operations.find(op => op.kind === "snapshot"); if (snap?.kind !== "snapshot") throw new Error("Missing decoded snapshot");
        expect(snap.validity.kind).toBe("valid"); expect(history.publish(snap)).toBe(true);
        expect(snap.snapshot.entities.map(entity => entity.number)).toEqual(operation.snapshot.entities.map(entity => entity.number));
        expect(snap.snapshot.areaMask).toEqual(operation.snapshot.areaMask); expect(snap.snapshot.playerState.origin).toEqual(operation.snapshot.playerState.origin);
        expect(snap.snapshot.entities.length).toBeGreaterThan(0); expect(snap.snapshot.entities.some(entity => entity.number === 0)).toBe(false);
        f.channel.transmit(bytes); f.game.runFrame(1200 + index * 100); f.statics.time = 1200 + index * 100;
      }
      const saved = history.latest; if (saved === null) throw new Error("Missing client history");
      const origin: Vec3 = { ...saved.playerState.origin }; f.game.pool.clientAt(0).ps.origin = vec3(999, 999, 999);
      for (let index = 0; index < f.statics.numSnapshotEntities; index++) {
        const entity = f.statics.snapshotEntities.get(index); entity.origin = vec3(999, 999, 999); f.statics.snapshotEntities.set(index, entity);
      }
      expect(history.latest?.playerState.origin).toEqual(origin);
    });
  }
});
