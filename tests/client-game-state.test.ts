// Source CL_ParseGamestate, CL_ConfigstringModified, CL_GetGameState and CL_MapLoading.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientSessionError, EngineClientSession } from "../src/engine/client-session.ts";
import { ClientGameStateStorage } from "../src/engine/game-state.ts";
import type { SourceGameStateRecord } from "../src/engine/game-state.ts";
import { MessageWriter } from "../src/protocol/message.ts";
import { encodeServerMessage, ServerOpcode } from "../src/protocol/server-message.ts";
import type { Product } from "../src/shared/definitions.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

function fixture(product: Product) {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product, cvars, lifecycle, mode: { kind: "network", challenge: 1, qport: 1 } });
  return { session, lifecycle };
}
function packet(entries: readonly (readonly [number, string])[]): Uint8Array {
  const writer = new MessageWriter();
  writer.writeLong(0); writer.writeByte(ServerOpcode.Gamestate); writer.writeLong(0);
  for (const [index, value] of entries) {
    writer.writeByte(ServerOpcode.Configstring); writer.writeShort(index);
    for (let i = 0; i < value.length; i++) writer.writeByte(value.charCodeAt(i));
    writer.writeByte(0);
  }
  writer.writeByte(ServerOpcode.Eof); writer.writeLong(3); writer.writeLong(19); writer.writeByte(ServerOpcode.Eof);
  if (writer.overflowed) throw new Error("Gamestate test packet overflowed");
  return writer.toBytes();
}
async function command(session: EngineClientSession, text: string): Promise<void> {
  const sequence = session.serverCommandSequence + 1, number = session.serverMessageSequence + 1;
  await session.receiveServerMessage(number, encodeServerMessage(0, [{ kind: "command", sequence, text }], {
    product: session.product, messageNumber: number, reliableSequence: 0, serverCommandSequence: session.serverCommandSequence,
    parseEntitiesNumber: 0, baseline: () => null, history: () => null,
  }));
  await session.getServerCommand(sequence);
}
function storage(): ClientGameStateStorage {
  return new ClientGameStateStorage(message => { throw new ClientSessionError("drop", message); });
}
function zero(record: SourceGameStateRecord, count: number): void {
  expect(record.dataCount).toBe(count);
  expect(record.stringOffsets).toEqual(new Int32Array(1024));
  expect(record.stringData).toEqual(new Uint8Array(16000));
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: actual session retains wire allocation order, duplicate tails and byte characters`, async () => {
    const { session, lifecycle } = fixture(product);
    try {
      zero(session.getSourceGameState(), 0);
      await session.receiveServerMessage(1, packet([[32, "old"], [2, "\u0080\u00ff"], [32, "new"], [7, ""]]));
      const record = session.getSourceGameState();
      expect(record.dataCount).toBe(13);
      expect(record.stringOffsets[32]).toBe(8); expect(record.stringOffsets[2]).toBe(5); expect(record.stringOffsets[7]).toBe(12);
      expect(record.stringData.slice(0, 14)).toEqual(Uint8Array.of(0, 111, 108, 100, 0, 128, 255, 0, 110, 101, 119, 0, 0, 0));
      expect(session.getGameState()[2]).toBe("\u0080\u00ff"); expect(session.getConfigString(7)).toBe("");
      expect(session.getConfigString(8)).toBeNull();
      expect(session.copyGamestate().entries).toEqual([
        { kind: "configstring", index: 2, value: "\u0080\u00ff" },
        { kind: "configstring", index: 7, value: "" },
        { kind: "configstring", index: 32, value: "new" },
      ]);
      record.stringOffsets.fill(99); record.stringData.fill(42);
      expect(session.getSourceGameState().stringOffsets[32]).toBe(8); expect(session.getConfigString(32)).toBe("new");
      const previous = session.getSourceGameState();
      await command(session, 'cs 7 ""'); await command(session, 'cs 32 "new"');
      expect(session.getSourceGameState()).toEqual(previous);
      await command(session, 'cs 32 "x"');
      const rebuilt = session.getSourceGameState();
      expect(rebuilt.dataCount).toBe(6); expect(rebuilt.stringOffsets[2]).toBe(1); expect(rebuilt.stringOffsets[32]).toBe(4);
      expect(rebuilt.stringOffsets[7]).toBe(0); expect(session.getConfigString(7)).toBeNull();
      expect(rebuilt.stringData.slice(0, 7)).toEqual(Uint8Array.of(0, 128, 255, 0, 120, 0, 0));
      expect(rebuilt.stringData.subarray(6).every(byte => byte === 0)).toBe(true);
      expect(previous.stringData[1]).toBe(111);
      const reliable = lifecycle.clientConnection.reliable, generation = session.gamestateGeneration;
      session.clearGameStateForMapLoading(); zero(session.getSourceGameState(), 0);
      expect(session.getConfigString(32)).toBeNull(); expect(session.copyGamestate().entries).toEqual([]);
      expect(session.gamestateGeneration).toBe(generation); expect(lifecycle.clientConnection.reliable).toBe(reliable);
      await session.receiveServerMessage(session.serverMessageSequence + 1, packet([])); zero(session.getSourceGameState(), 1);
      lifecycle.close(); expect(() => session.getSourceGameState()).toThrow("no longer current");
    } finally { lifecycle.close(); }
  });
}

test("gamestate parse publishes clear, sequence reservation and each completed entry before later work", async () => {
  for (const count of [0, 1, 5, 9]) {
    const { session, lifecycle } = fixture("baseq3");
    try {
      await session.receiveServerMessage(1, packet([[99, "prior"]]));
      const original = lifecycle.assertCurrentOperation.bind(lifecycle), abort = new CommonError("disconnect", "observed source parse step");
      const observed: { record: SourceGameStateRecord | null } = { record: null };
      const inspect = (): void => {
        original(); lifecycle.assertCurrentOperation = original;
        const record = session.getSourceGameState();
        lifecycle.assertCurrentOperation = inspect;
        if (session.gamestateGeneration === 2 && record.dataCount === count) { observed.record = record; throw abort; }
      };
      lifecycle.assertCurrentOperation = inspect;
      const result: unknown = await session.receiveServerMessage(2, packet([[32, "old"], [32, "new"]])).catch((error: unknown) => error);
      lifecycle.assertCurrentOperation = original;
      if (observed.record === null) throw new Error("Expected retained state at the interrupted parse step");
      expect(result).toBe(abort); expect(session.dropped).toBeNull(); expect(session.getSourceGameState()).toEqual(observed.record);
      expect(session.getSourceGameState().dataCount).toBe(count); expect(session.getConfigString(99)).toBeNull();
      if (count === 5) expect(session.getConfigString(32)).toBe("old");
      if (count === 9) expect(session.getConfigString(32)).toBe("new");
    } finally { lifecycle.close(); }
  }
});

test("initial storage capacity counts duplicate and empty allocations and retains prior entries on overflow", () => {
  const state = storage(); state.beginEntries();
  state.append(3, "a".repeat(7998)); state.append(3, "b".repeat(7998)); state.append(4, "");
  expect(state.copySourceRecord().dataCount).toBe(16000); expect(state.copySourceRecord().stringOffsets[3]).toBe(8000);
  const previous = state.copySourceRecord();
  expect(() => state.append(4, "")).toThrow("MAX_GAMESTATE_CHARS exceeded"); expect(state.copySourceRecord()).toEqual(previous);
});

test("changed configstring overflow preserves the partially rebuilt source allocation", () => {
  const state = storage(); state.beginEntries();
  state.append(900, "b".repeat(7997)); state.append(2, "a".repeat(7998)); state.append(1, "");
  expect(state.copySourceRecord().dataCount).toBe(15999);
  expect(() => state.modify(4, "xy")).toThrow("MAX_GAMESTATE_CHARS exceeded");
  const record = state.copySourceRecord();
  expect(record.dataCount).toBe(8003); expect(record.stringOffsets[2]).toBe(1); expect(record.stringOffsets[4]).toBe(8000);
  expect(record.stringOffsets[900]).toBe(0); expect(record.stringOffsets[1]).toBe(0);
  expect(state.get(900)).toBeNull(); expect(state.get(4)).toBe("xy"); expect(record.stringData.subarray(8003).every(byte => byte === 0)).toBe(true);
});

test("actual session configstring overflow uses the retained drop event and failed-session guard", async () => {
  const { session, lifecycle } = fixture("baseq3");
  try {
    await session.receiveServerMessage(1, packet([[900, "0".repeat(7997)], [2, "0".repeat(7998)]]));
    const result: unknown = await command(session, 'cs 4 "xy"').catch((error: unknown) => error);
    if (!(result instanceof ClientSessionError)) throw new Error("Missing source configstring drop");
    expect(result.kind).toBe("drop"); expect(result.message).toBe("MAX_GAMESTATE_CHARS exceeded"); expect(session.dropped).toBe(result);
    expect(session.pendingEvents.at(-1)).toEqual({ kind: "disconnect", reason: result.message, errorKind: "drop" });
    expect(() => session.getSourceGameState()).toThrow(result);
  } finally { lifecycle.close(); }
});

test("direct storage rejects nonbyte and embedded-NUL input without concealing it", () => {
  const state = storage(); state.beginEntries(); state.append(2, "kept"); const prior = state.copySourceRecord();
  for (const text of ["a\0b", "\u0100", "\ud83d\ude00"]) {
    expect(() => state.append(2, text)).toThrow("byte characters"); expect(() => state.modify(2, text)).toThrow("byte characters");
    expect(state.copySourceRecord()).toEqual(prior);
  }
  for (const index of [-1, 1024, 1.5]) expect(() => state.append(index, "x")).toThrow("configstring > MAX_CONFIGSTRINGS");
});

test("one active owner survives map loading and resets its distinct packet cells at a new gamestate", async () => {
  const { session, lifecycle } = fixture("baseq3");
  try {
    const active = lifecycle.clientActive, gameState = active.gameState, snapshots = active.snapshots, commands = active.commands;
    const packets = active.outPackets.slice();
    const parseEntities = active.parseEntities, firstParsed = parseEntities.at(0), lastParsed = parseEntities.at(2047);
    const snapshotRecord = active.history.borrowSlot(1, "baseq3").snapshot;
    const playerState = snapshotRecord.playerState, areaMask = snapshotRecord.areaMask;
    const stats = playerState.stats, events = playerState.events;
    const baseline = active.baselines[37];
    if (baseline === undefined) throw new Error("Missing source baseline cell");
    await session.receiveServerMessage(1, packet([[1, "\\sv_serverid\\77"], [40, "old map"]]));
    session.prime(1);
    session.setUserCmdValue(5, 0.75);
    session.createUserCommand({ serverTime: 100, viewAngles: { x: 0, y: 0, z: 0 }, buttons: 1,
      forwardmove: 127, rightmove: 0, upmove: 0 });
    for (const [index, outgoing] of active.outPackets.entries()) {
      outgoing.commandNumber = index + 1; outgoing.serverTime = 100 + index; outgoing.realTime = 1000 + index;
    }
    firstParsed.number = 11; firstParsed.modelindex = 31;
    lastParsed.number = 12; lastParsed.pos = { ...lastParsed.pos, base: { x: 1, y: 2, z: 3 } };
    baseline.number = 37; baseline.modelindex = 91;
    playerState.commandTime = 700; playerState.health = 80; playerState.events.set(0, 11); areaMask[31] = 7;
    active.parseEntitiesNumber = 2049;
    active.time = 250;
    lifecycle.clientStatic.bigConfigString = 'cs 40 "retained';
    await command(session, "print retained command");
    const reliableNumber = lifecycle.clientConnection.lastExecutedServerCommand;
    session.clearGameStateForMapLoading();
    zero(active.getSourceGameState(), 0);
    expect(active.serverId).toBe(77); expect(active.time).toBe(250);
    expect(active.commands.currentNumber).toBe(1); expect(active.sensitivity).toBe(0.75);
    expect(active.outPackets[0]?.commandNumber).toBe(1);
    expect(active.parseEntities).toBe(parseEntities); expect(active.parseEntitiesNumber).toBe(2049);
    expect(parseEntities.at(2048)).toBe(firstParsed); expect(parseEntities.at(-1)).toBe(lastParsed);
    expect(firstParsed.modelindex).toBe(31); expect(lastParsed.pos.base.x).toBe(1);
    expect(active.baselines[37]).toBe(baseline); expect(baseline.modelindex).toBe(91);
    expect(snapshotRecord.playerState).toBe(playerState); expect(playerState.commandTime).toBe(700); expect(playerState.health).toBe(80);
    expect(snapshotRecord.areaMask).toBe(areaMask); expect(areaMask[31]).toBe(7);
    expect(session.active).toBe(active); expect(session.snapshots).toBe(snapshots); expect(session.commands).toBe(commands);
    await session.receiveServerMessage(session.serverMessageSequence + 1, packet([]));
    expect(session.active).toBe(active); expect(active.gameState).toBe(gameState);
    expect(active.snapshots).toBe(snapshots); expect(active.commands).toBe(commands);
    expect(active.serverId).toBe(0); expect(active.time).toBe(0);
    expect(active.commands.currentNumber).toBe(0); expect(active.userCmdValue).toBe(0); expect(active.sensitivity).toBe(0);
    expect(active.parseEntities).toBe(parseEntities); expect(active.parseEntitiesNumber).toBe(0);
    expect(parseEntities.at(0)).toBe(firstParsed); expect(parseEntities.at(2047)).toBe(lastParsed);
    expect(firstParsed.number).toBe(0); expect(firstParsed.modelindex).toBe(0);
    expect(lastParsed.number).toBe(0); expect(lastParsed.pos.base).toEqual({ x: 0, y: 0, z: 0 });
    expect(active.baselines[37]).toBe(baseline); expect(baseline.number).toBe(0); expect(baseline.modelindex).toBe(0);
    expect(active.history.borrowSlot(1, "baseq3").snapshot).toBe(snapshotRecord);
    expect(snapshotRecord.playerState).toBe(playerState); expect(playerState.stats).toBe(stats); expect(playerState.events).toBe(events);
    expect(playerState.commandTime).toBe(0); expect(playerState.health).toBe(0); expect(events.get(0)).toBe(0);
    expect(snapshotRecord.areaMask).toBe(areaMask); expect(areaMask).toEqual(new Uint8Array(32));
    firstParsed.modelindex = 7; expect(parseEntities.at(1).modelindex).toBe(0);
    expect(lifecycle.clientConnection.lastExecutedServerCommand).toBe(reliableNumber);
    expect(lifecycle.clientStatic.bigConfigString).toBe('cs 40 "retained');
    for (const [index, outgoing] of active.outPackets.entries()) {
      const previous = packets[index];
      if (previous === undefined) throw new Error("Missing previous source packet cell");
      expect(outgoing).toBe(previous);
      expect(outgoing).toEqual({ commandNumber: 0, serverTime: 0, realTime: 0 });
    }
    const first = active.outPackets[0], second = active.outPackets[1];
    if (first === undefined || second === undefined) throw new Error("Missing source packet ring cells");
    first.realTime = 99;
    expect(second.realTime).toBe(0);
  } finally { lifecycle.close(); }
});
