import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientSessionError, EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerMessageContext, ServerOperation, Snapshot, SnapshotHistoryEntry } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

function fixture(product: Product = "baseq3") {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 27961 } });
  return { session, lifecycle };
}
function gamestate(product: Product, clientNumber = 7): Gamestate {
  return { kind: "gamestate", commandSequence: 0, clientNumber, checksumFeed: 19, entries: [
    { kind: "configstring", index: 1, value: `\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\${product === "missionpack" ? "missionpack" : ""}` },
  ] };
}
function frame(product: Product, number: number, clientNumber: number, entities: readonly EntityState[] = [], deltaNumber = -1): Snapshot {
  const playerState = new PlayerState(product); playerState.clientNum = clientNumber;
  return { messageNumber: number, serverTime: number * 50, deltaNumber, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState, entities };
}
function operation(snapshot: Snapshot): Extract<ServerOperation, { kind: "snapshot" }> {
  return { kind: "snapshot", validity: { kind: "valid" }, snapshot };
}
function context(session: EngineClientSession, number: number, old: SnapshotHistoryEntry | null = null): ServerMessageContext {
  return { product: session.product, messageNumber: number, reliableSequence: 0, serverCommandSequence: 0,
    parseEntitiesNumber: 0, baseline: () => null, history: () => old };
}
async function send(session: EngineClientSession, operations: readonly ServerOperation[], number: number, old: SnapshotHistoryEntry | null = null) {
  const message = await session.receiveServerMessage(number, encodeServerMessage(0, operations, context(session, number, old)));
  if (message === null) throw new Error("UI-state fixture unexpectedly retired its connection");
  return message;
}
function caught(operation: () => unknown): unknown {
  try { operation(); } catch (error) { return error; }
  throw new Error("Expected owner failure");
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: UI identity reads the latest accepted player state, independent of admission`, async () => {
    const f = fixture(product); try {
      expect(f.session.readSnapshotClientNumber()).toBe(0);
      await send(f.session, [gamestate(product)], 1); expect(f.session.clientNumber).toBe(7); expect(f.session.readSnapshotClientNumber()).toBe(0);
      const first = frame(product, 2, 2); await send(f.session, [operation(first)], 2);
      expect(f.session.readSnapshotClientNumber()).toBe(2); expect(f.session.clientNumber).toBe(7);
      first.playerState.clientNum = 99; expect(f.session.readSnapshotClientNumber()).toBe(2);
      const detached = f.session.snapshots.read(2); if (detached === null) throw new Error("Missing actual accepted snapshot");
      detached.playerState.clientNum = 88; expect(f.session.readSnapshotClientNumber()).toBe(2);
      const old = frame(product, 3, 0), invalid = frame(product, 4, 9, [], 3);
      const received = await send(f.session, [operation(invalid)], 4, { status: "valid", snapshot: old });
      const snapshot = received.operations.find(value => value.kind === "snapshot");
      if (snapshot?.kind !== "snapshot") throw new Error("Missing actual decoded snapshot");
      expect(snapshot.validity).toEqual({ kind: "invalid", reason: "missing-delta" });
      expect(snapshot.snapshot.playerState.clientNum).toBe(9); expect(f.session.readSnapshotClientNumber()).toBe(2);
      expect(f.session.snapshots.current().number).toBe(2); expect(f.session.clientNumber).toBe(7);
      await send(f.session, [operation(frame(product, 5, 3))], 5); expect(f.session.readSnapshotClientNumber()).toBe(3);
      await send(f.session, [gamestate(product, 11)], 6); expect(f.session.readSnapshotClientNumber()).toBe(0); expect(f.session.clientNumber).toBe(11);
      await send(f.session, [operation(frame(product, 7, 4))], 7); expect(f.session.readSnapshotClientNumber()).toBe(4); expect(f.session.clientNumber).toBe(11);
    } finally { f.lifecycle.close(); }
  });

  test(`${product}: UI getter preserves source eight-bit snapshot client values without a 64-client guard`, async () => {
    const f = fixture(product); try {
      await send(f.session, [gamestate(product)], 1); let number = 1;
      for (const value of [0, 1, 63, 64, 127, 128, 254, 255]) {
        number++; await send(f.session, [operation(frame(product, number, value))], number);
        expect(f.session.readSnapshotClientNumber()).toBe(value); expect(f.session.clientNumber).toBe(7);
      }
      expect(f.session.dropped).toBeNull();
    } finally { f.lifecycle.close(); }
  });
}

test("UI identity survives parse-entity retention rejection of the actual latest SnapshotSource", async () => {
  const f = fixture(); try {
    await send(f.session, [gamestate("baseq3")], 1); await send(f.session, [operation(frame("baseq3", 2, 2))], 2);
    for (const [number, count, readable] of [[4, 1023, true], [6, 1023, true], [8, 1, true], [10, 1, false]] satisfies readonly (readonly [number, number, boolean])[]) {
      const entities = Array.from({ length: count }, (_, index) => { const entity = new EntityState(); entity.number = index; entity.modelindex = 1; return entity; });
      const old = frame("baseq3", number - 1, 0), invalid = frame("baseq3", number, 9, entities, number - 1);
      const received = await send(f.session, [operation(invalid)], number, { status: "valid", snapshot: old });
      const decoded = received.operations.find(value => value.kind === "snapshot");
      if (decoded?.kind !== "snapshot") throw new Error("Missing decoded invalid snapshot");
      expect(decoded.validity).toEqual({ kind: "invalid", reason: "missing-delta" }); expect(decoded.snapshot.entities).toHaveLength(count);
      expect(f.session.snapshots.current()).toEqual({ number: 2, serverTime: 100 });
      expect(f.session.snapshots.read(2) !== null).toBe(readable); expect(f.session.readSnapshotClientNumber()).toBe(2); expect(f.session.clientNumber).toBe(7);
    }
    expect(f.session.snapshots.read(f.session.snapshots.current().number)).toBeNull(); expect(f.session.readSnapshotClientNumber()).toBe(2);
    await send(f.session, [operation(frame("baseq3", 11, 255))], 11);
    expect(f.session.snapshots.read(11)?.playerState.clientNum).toBe(255); expect(f.session.readSnapshotClientNumber()).toBe(255);
  } finally { f.lifecycle.close(); }
});

for (const terminal of [false, true]) test(`UI active reset precedes gamestate callback failure, terminal=${terminal}`, async () => {
  const f = fixture(); try {
    await send(f.session, [gamestate("baseq3")], 1); await send(f.session, [operation(frame("baseq3", 2, 2))], 2);
    const original = f.lifecycle.gamestateReceived.bind(f.lifecycle), failure = terminal ? new Error("gamestate callback failed") : new CommonError("disconnect", "source gamestate abort");
    const observed: number[] = [];
    f.lifecycle.gamestateReceived = async generation => { await original(generation); observed.push(f.session.readSnapshotClientNumber()); throw failure; };
    let received: unknown;
    try { await send(f.session, [gamestate("baseq3", 13)], 3); } catch (error) { received = error; }
    expect(observed).toEqual([0]); expect(f.session.snapshots.current()).toEqual({ number: 0, serverTime: 0 }); expect(f.session.clientNumber).toBe(13);
    if (terminal) {
      expect(received).toBeInstanceOf(ClientSessionError); if (!(received instanceof ClientSessionError)) throw new Error("Missing exact terminal owner failure");
      expect(received.kind).toBe("drop"); expect(received.message).toBe(failure.message); expect(f.session.dropped).toBe(received);
      expect(caught(() => f.session.readSnapshotClientNumber())).toBe(received); expect(caught(() => f.session.getGameState())).toBe(received);
    } else {
      expect(received).toBe(failure); expect(f.session.dropped).toBeNull(); expect(f.session.readSnapshotClientNumber()).toBe(0);
      f.lifecycle.gamestateReceived = original; await send(f.session, [operation(frame("baseq3", 4, 4))], 4);
      expect(f.session.readSnapshotClientNumber()).toBe(4);
    }
  } finally { f.lifecycle.close(); }
});

test("UI snapshot identity propagates the existing operation guard before failed-session state", async () => {
  const f = fixture(); try {
    await send(f.session, [gamestate("baseq3")], 1); await send(f.session, [operation(frame("baseq3", 2, 2))], 2);
    const guard = f.lifecycle.assertCurrentOperation.bind(f.lifecycle), operationFailure = new CommonError("disconnect", "retired UI operation");
    f.lifecycle.assertCurrentOperation = () => { throw operationFailure; };
    expect(caught(() => f.session.readSnapshotClientNumber())).toBe(operationFailure);
    f.lifecycle.assertCurrentOperation = guard; expect(f.session.readSnapshotClientNumber()).toBe(2);
    const sessionFailure: unknown = await f.session.getServerCommand(1).catch((error: unknown) => error);
    expect(sessionFailure).toBeInstanceOf(ClientSessionError);
    if (!(sessionFailure instanceof ClientSessionError)) throw new Error("Missing existing session failure");
    expect(f.session.dropped).toBe(sessionFailure); expect(caught(() => f.session.readSnapshotClientNumber())).toBe(sessionFailure);
    f.lifecycle.assertCurrentOperation = () => { throw operationFailure; };
    expect(caught(() => f.session.readSnapshotClientNumber())).toBe(operationFailure);
    f.lifecycle.assertCurrentOperation = guard; f.lifecycle.close();
    expect(() => f.session.readSnapshotClientNumber()).toThrow("Protocol fixture operation is no longer current");
  } finally { f.lifecycle.close(); }
});
