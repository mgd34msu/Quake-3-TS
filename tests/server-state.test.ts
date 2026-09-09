import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { HunkArena } from "../src/core/hunk.ts";
import type { HunkAllocation } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { Netchannel } from "../src/protocol/netchan.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { GameEntity } from "../src/game/state.ts";
import { createSnapshotEntityStorage, ServerClient, ServerClientPhase, ServerStaticState, ServerWorldState } from "../src/server/state.ts";

function firstPacket(channel: Netchannel, payload: Uint8Array): Uint8Array {
  const packets: Uint8Array[] = [], traces: string[] = [];
  channel.beginTransmit(payload, { send: packet => { packets.push(packet); }, trace: text => { traces.push(text); } });
  const packet = packets[0];
  if (packet === undefined || packets.length !== 1 || traces.length !== 1) throw new Error("Expected one delivered datagram and trace");
  return packet;
}

const products: readonly Product[] = ["baseq3", "missionpack"];
const unexpected = { print: (text: string) => { throw new Error(text); },
  dropClient: (_client: ServerClient, reason: string) => { throw new Error(reason); } };

describe("source server record ownership", () => {
  for (const product of products) {
    test(`${product}: source zero slots do not initialize channels or enter the world`, () => {
      const state = new ServerStaticState({ product, maxClients: 2, dedicated: false });
      expect(state.initialized).toBe(false);
      expect(state.time).toBe(0); expect(state.snapFlagServerBit).toBe(0);
      expect(state.nextSnapshotEntities).toBe(0); expect(state.nextHeartbeatTime).toBe(0);
      expect(state.authorizeAddress).toEqual({ kind: "unresolved" });
      expect(state.challenges).toHaveLength(1024);
      for (const challenge of state.challenges) expect(challenge).toEqual({ address: null, challenge: 0, time: 0, pingTime: 0, firstTime: 0, connected: false });
      const client = state.clients[0];
      if (client === undefined) throw new Error("Missing client");
      expect(client.connection).toEqual({ kind: "uninitialized", phase: ServerClientPhase.Free, address: { kind: "bot" } });
      expect(client.phase).toBe(0); expect(client.gameEntity).toBeNull();
      expect(client.reliable.sequence).toBe(0); expect(client.reliable.acknowledge).toBe(0);
      expect(client.deltaMessage).toBe(0); expect(client.gamestateMessageNum).toBe(0);
      expect(client.frames).toHaveLength(32);
      for (const frame of client.frames) {
        expect(frame.areaBytes).toBe(0); expect(frame.areaBits).toEqual(new Uint8Array(32));
        expect(frame.playerState).toEqual(new PlayerState(product));
        expect(frame.firstEntity).toBe(0); expect(frame.numEntities).toBe(0);
        expect(frame.messageSent).toBe(0); expect(frame.messageAcked).toBe(0); expect(frame.messageSize).toBe(0);
      }
      expect(client.download).toEqual({ file: null, name: "", size: 0, count: 0, clientBlock: 0, currentBlock: 0,
        xmitBlock: 0, blocks: [null, null, null, null, null, null, null, null], blockSizes: new Int32Array(8), eof: false, sendTime: 0 });
      expect(client.queuedMessages).toEqual([]);
    });

    test(`${product}: source allocation is maxclients times 32 or 4 times 64`, () => {
      expect(new ServerStaticState({ product, maxClients: 2, dedicated: true }).numSnapshotEntities).toBe(4096);
      expect(new ServerStaticState({ product, maxClients: 3, dedicated: false }).numSnapshotEntities).toBe(768);
    });

    test(`${product}: spawn ring consumes source bytes and expires with its hunk`, async () => {
      const arena = new HunkArena(1024 * 1024, () => undefined), accounting = new SourceHunkAccounting(arena);
      const allocations: HunkAllocation[] = [], allocate = arena.allocate.bind(arena);
      arena.allocate = (size, preference) => {
        const allocation = allocate(size, preference); allocations.push(allocation); return allocation;
      };
      const state = new ServerStaticState({ product, maxClients: 2, dedicated: false });
      state.resizeSnapshotEntities(true);
      expect(arena.memoryRemaining()).toBe(1024 * 1024);
      state.nextSnapshotEntities = 17;
      state.resetSnapshotEntities({ kind: "source-hunk", accounting });
      const ring = state.snapshotEntities;
      expect(state.nextSnapshotEntities).toBe(0); expect(ring.length).toBe(4096);
      expect(arena.memoryRemaining()).toBe(1024 * 1024 - 4096 * 208);
      expect(accounting.report().trace).toEqual([{ action: "allocate", source: "SV_SpawnServer:snapshotEntities",
        resource: "<server snapshots>", bytes: 4096 * 208, reservedBytes: 4096 * 208, offset: 0, preference: "high" }]);
      expect(ring.get(0)).toEqual(new EntityState()); expect(ring.get(ring.length - 1)).toEqual(new EntityState());
      const entity = new EntityState(); entity.number = 71; entity.eType = 18; entity.weapon = 13;
      entity.eFlags = 0x80000001; entity.origin = { x: 1 / 3, y: -0, z: 16777217 };
      entity.pos = { type: TrajectoryType.TR_GRAVITY, time: 1234, duration: 99,
        base: { x: 1 / 3, y: 2, z: 3 }, delta: { x: 4, y: 5, z: 6 } };
      ring.set(ring.length - 1, entity);
      const expected = entity.copy(); expected.eFlags = -2147483647;
      expected.origin = { x: Math.fround(1 / 3), y: -0, z: 16777216 };
      expected.pos = { ...expected.pos, base: { x: Math.fround(1 / 3), y: 2, z: 3 } };
      entity.number = 72;
      expect(ring.get(ring.length - 1)).toEqual(expected);
      const detached = ring.get(ring.length - 1); detached.number = 73; detached.origin = vec3(9, 9, 9);
      expect(ring.get(ring.length - 1)).toEqual(expected); expect(ring.get(0)).toEqual(new EntityState());
      const allocation = allocations[0];
      if (allocation === undefined) throw new Error("Snapshot ring did not allocate hunk storage");
      const bytes = allocation.bytes, last = new DataView(bytes.buffer, bytes.byteOffset + (ring.length - 1) * 208, 208);
      expect(last.getInt32(0, true)).toBe(71); expect(last.getInt32(8, true)).toBe(-2147483647);
      expect(last.getFloat32(92, true)).toBe(Math.fround(1 / 3)); expect(last.getInt32(192, true)).toBe(13);
      last.setInt32(0, 74, true);
      expect(ring.get(ring.length - 1).number).toBe(74);
      for (const index of [-1, ring.length, 1.5, NaN, Infinity]) {
        expect(() => ring.get(index)).toThrow(RangeError); expect(() => ring.set(index, entity)).toThrow(RangeError);
      }
      await accounting.clearAsync({ kind: "dedicated", shutdownGameProgs: () => undefined, clearVm: () => undefined });
      expect(() => ring.get(0)).toThrow("no longer valid"); expect(() => ring.set(0, entity)).toThrow("no longer valid");
      state.resetSnapshotEntities({ kind: "source-hunk", accounting });
      expect(state.snapshotEntities).not.toBe(ring); expect(state.snapshotEntities.get(ring.length - 1)).toEqual(new EntityState());
      expect(arena.memoryRemaining()).toBe(1024 * 1024 - 4096 * 208);
    });

    test(`${product}: map records reset independently while static and connection records survive`, () => {
      const state = new ServerStaticState({ product, maxClients: 2, dedicated: false });
      const first = new ServerWorldState(state, unexpected), next = new ServerWorldState(state, unexpected);
      const client = state.clients[0];
      if (client === undefined) throw new Error("Missing client");
      state.time = 5000; client.reliable.add("print persistent"); first.serverId = 42;
      first.configstrings.set(7, "old"); first.entitySnapshotCounters[3] = 5;
      expect(next.product).toBe(product); expect(next.state).toBe("dead"); expect(next.game).toBeNull();
      expect(next.serverId).toBe(0); expect(next.configstrings.get(7)).toBe("");
      expect(next.entitySnapshotCounters).toEqual(new Int32Array(1024));
      expect(next.baselines).toHaveLength(1024); expect(next.gameEntity(client)).toBeNull();
      expect(state.time).toBe(5000); expect(client.reliable.lookup(1)).toBe("print persistent");
      expect(first.configstrings.get(7)).toBe("old");
      const retained = new GameEntity(client.slot);
      client.gameEntity = retained;
      expect(next.game).toBeNull();
      expect(next.gameEntity(client)).toBe(retained);
    });
  }

  test("source fixed tables own every mutable cell across slots, frames, products and instances", () => {
    const state = new ServerStaticState({ product: "baseq3", maxClients: 2, dedicated: false });
    const other = new ServerStaticState({ product: "missionpack", maxClients: 1, dedicated: false });
    const a = state.clients[0], b = state.clients[1], c = other.clients[0];
    if (a === undefined || b === undefined || c === undefined) throw new Error("Missing clients");
    const first = a.frames[0], second = a.frames[1], neighbor = b.frames[0];
    if (first === undefined || second === undefined || neighbor === undefined) throw new Error("Missing frames");
    first.areaBits[0] = 255; first.playerState.stats.set(0, 120); first.playerState.events.set(0, 9);
    a.download.blocks[0] = Uint8Array.of(1, 2); a.download.blockSizes[0] = 2; a.lastUsercmd.angles = vec3(1, 2, 3);
    a.reliable.add("one");
    expect(second.areaBits[0]).toBe(0); expect(neighbor.areaBits[0]).toBe(0);
    expect(second.playerState.stats.get(0)).toBe(0); expect(neighbor.playerState.events.get(0)).toBe(0);
    expect(b.lastUsercmd.angles).toEqual(vec3(0, 0, 0)); expect(b.download.blocks[0]).toBeNull();
    expect(c.download.blockSizes[0]).toBe(0); expect(b.reliable.sequence).toBe(0);
    const entity = new EntityState(); entity.number = 9; entity.pos = { ...entity.pos, base: vec3(1, 2, 3) };
    state.snapshotEntities.set(0, entity); entity.number = 10; entity.pos = { ...entity.pos, base: vec3(4, 5, 6) };
    expect(state.snapshotEntities.get(0).number).toBe(9); expect(state.snapshotEntities.get(0).pos.base).toEqual(vec3(1, 2, 3));
    expect(state.snapshotEntities.get(1).number).toBe(0); expect(other.snapshotEntities.get(0).number).toBe(0);
    const challenge = state.challenges[0];
    if (challenge === undefined) throw new Error("Missing challenge");
    challenge.challenge = 42;
    expect(state.challenges[1]?.challenge).toBe(0); expect(other.challenges[0]?.challenge).toBe(0);
  });

  test("explicit channel setup and later free phase preserve the owned connection", () => {
    const client = new ServerClient("baseq3", 0);
    const netchan = new Netchannel("server", 12345);
    client.connection = { kind: "initialized", phase: ServerClientPhase.Connected, address: { kind: "loopback" }, netchan };
    expect(client.phase).toBe(ServerClientPhase.Connected);
    firstPacket(netchan, Uint8Array.of(1));
    client.connection.phase = ServerClientPhase.Zombie;
    client.connection.phase = ServerClientPhase.Free;
    expect(client.connection.netchan.outgoingSequence).toBe(2);
    expect(client.connection.netchan.qport).toBe(12345);
  });

  test("game entity lookup rejects noncanonical clients before inspecting binding or game state", () => {
    const state = new ServerStaticState({ product: "baseq3", maxClients: 1, dedicated: false });
    const world = new ServerWorldState(state, unexpected);
    const own = state.clients[0];
    if (own === undefined) throw new Error("Missing own client");
    expect(world.gameEntity(own)).toBeNull();
    for (const product of products) {
      const foreignState = new ServerStaticState({ product, maxClients: 1, dedicated: false });
      const foreign = foreignState.clients[0];
      if (foreign === undefined) throw new Error("Missing foreign client");
      expect(() => world.gameEntity(foreign)).toThrow("does not belong to this server");
      foreign.gameEntity = new GameEntity(foreign.slot);
      expect(() => world.gameEntity(foreign)).toThrow("does not belong to this server");
    }
    expect(() => world.gameEntity(new ServerClient("baseq3", 0))).toThrow("does not belong to this server");
  });

  test("allocation boundary rejects invalid client counts and slots", () => {
    for (const count of [0, -1, 65, 1.5, NaN, Infinity]) expect(() => createSnapshotEntityStorage(count, false)).toThrow(RangeError);
    for (const slot of [-1, 64, 0.5, NaN]) expect(() => new ServerClient("baseq3", slot)).toThrow(RangeError);
  });
});
