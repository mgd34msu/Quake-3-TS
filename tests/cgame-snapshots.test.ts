// Initial callback order independently recorded from full upstream cg_snapshot.c
// in native i386 and q3lcc vm_game=1, both products: /tmp/quake3-cgame-reference-sSvF61.
import { describe, expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { SourceParseEntities } from "../src/protocol/parse-entities.ts";
import type { Snapshot } from "../src/protocol/server-message.ts";
import { readDeltaPlayerState, writeDeltaPlayerState } from "../src/protocol/state-delta.ts";
import { EntityType, MoveType, Weapon, WeaponState } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import { createPlayerState, MoveFlags, PlayerStateRecord } from "../src/shared/player-state.ts";
import type { SourcePlayerState } from "../src/shared/player-state.ts";
import { TrajectoryType, evaluateTrajectory, evaluateTrajectoryDelta } from "../src/shared/trajectory.ts";
import { retailSnapshot } from "../src/cgame/retail-snapshot.ts";
import type { RetailSnapshot } from "../src/cgame/retail-snapshot.ts";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { HistorySnapshotSource, SnapshotRuntime } from "../src/cgame/snapshots.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { copyRefdef } from "../src/render/refdef.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
function snapshot(product: Product, number: number, time: number, entities: readonly EntityState[] = []): RetailSnapshot {
  return { messageNumber: number, serverTime: time, deltaNumber: -1, flags: 0, serverCommandNumber: number,
    parseEntitiesNumber: 0, areaMask: new Uint8Array([3]), playerState: createPlayerState(product), entities };
}
function entity(number: number, type = EntityType.ET_GENERAL): EntityState {
  const result = new EntityState(); result.number = number; result.eType = type; result.origin = vec3(number, 2, 3); return result;
}
function fixture(product: Product, initialMessageSequence = 0) {
  const history = new SnapshotHistory(), state = new ClientGameState(product, 0, initialMessageSequence);
  const calls: string[] = [], live = { parseHead: 0, demo: false };
  const source = new HistorySnapshotSource(history, () => live.parseHead, message => { calls.push(message); });
  const runtime = new SnapshotRuntime(state, { source, get demoPlayback() { return live.demo; }, noPredict: false, synchronousClients: false,
    executeServerCommands: async sequence => { calls.push(`command:${sequence}:${state.entityAt(1).currentValid}`); },
    respawn: () => { calls.push("respawn"); }, resetPlayerEntity: cent => { calls.push(`reset:${cent.currentState.number}`); },
    checkEvents: async cent => { calls.push(`event:${cent.currentState.number}:${cent.previousEvent}:${cent.snapshotTime}`); },
    transitionPlayerState: async (current, previous) => { calls.push(`transition:${previous.commandTime}:${current.commandTime}`); },
    lagometerSnapshot: snap => { calls.push(snap === null ? "lost" : `received:${snap.messageNumber}`); },
    warn: text => { calls.push(text); } });
  return { history, state, calls, live, source, runtime, publish: (snap: Snapshot) => history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: snap }) };
}

for (const product of products) describe(`${product} CG_ProcessSnapshots`, () => {
  test("raw mod enum words survive history and are skipped in inactive initial snapshots", async () => {
    const f = fixture(product);
    const ps = new PlayerStateRecord<number, number, number>(product, 71, 72, 73);
    const state = new EntityStateRecord<number>(74); state.number = 1;
    const inactive: Snapshot = { ...snapshot(product, 1, 100), flags: 2, playerState: ps, entities: [state] };
    f.publish(inactive);
    const read = f.source.read(1);
    expect(read?.playerState.pmType).toBe(71); expect(read?.playerState.weapon).toBe(72);
    expect(read?.playerState.weaponState).toBe(73); expect(read?.entities[0]?.pos.type).toBe(74);
    expect(read?.entities[0]?.apos.type).toBe(74);
    f.publish(snapshot(product, 2, 200)); f.state.time = 200;
    await f.runtime.processSnapshots();
    expect(f.state.snap?.messageNumber).toBe(2);
    expect(f.calls).toEqual(["received:1", "received:2", "command:2:false", "respawn"]);
  });
  test("raw player enum words survive initial and next snapshot consumption", async () => {
    for (const words of [[7, 0, 0], [0, 14, 0], [0, 0, 4]] satisfies readonly (readonly [number, number, number])[]) {
      const f = fixture(product), ps = new PlayerStateRecord<number, number, number>(product, ...words);
      const state = new EntityStateRecord<number>(0); state.number = 1;
      const input: Snapshot = { ...snapshot(product, 2, 200), playerState: ps, entities: [state] };
      const readWords = (value: SourcePlayerState | undefined) => value === undefined ? [] : [value.pmType, value.weapon, value.weaponState];
      await f.runtime.setInitialSnapshot(input);
      expect(readWords(f.state.snap?.playerState)).toEqual(words);
      expect(f.calls).toEqual(["command:2:false", "respawn", "event:1:0:0"]);
      const next = fixture(product);
      await next.runtime.setInitialSnapshot(snapshot(product, 1, 100));
      next.runtime.setNextSnapshot(input);
      expect(next.state.snap?.messageNumber).toBe(1);
      expect(readWords(next.state.nextSnap?.playerState)).toEqual(words);
      expect(next.state.entityAt(ps.clientNum).nextState.weapon).toBe(ps.weapon);
      expect(next.state.entityAt(ps.clientNum).nextState.eType).toBe(EntityType.ET_PLAYER);
    }
  });
  test("raw trajectories survive snapshot publication and fail only when evaluated", async () => {
    const f = fixture(product), state = new EntityStateRecord<number>(0); state.number = 1;
    state.pos = { ...state.pos, type: 6, time: 123 };
    state.apos = { ...state.apos, type: -1, time: 456 };
    const input: Snapshot = { ...snapshot(product, 1, 100), entities: [state] };
    await f.runtime.setInitialSnapshot(input);
    const current = f.state.entityAt(1).currentState;
    expect([current.pos.type, current.apos.type]).toEqual([6, -1]);
    expect(f.calls).toEqual(["command:1:false", "respawn", "event:1:0:0"]);
    expect(() => evaluateTrajectory(current.pos, 100)).toThrow(new CommonError("drop", "BG_EvaluateTrajectory: unknown trType: 123"));
    expect(() => evaluateTrajectoryDelta(current.apos, 100)).toThrow(new CommonError("drop", "BG_EvaluateTrajectoryDelta: unknown trType: 456"));
    f.runtime.setNextSnapshot({ ...input, messageNumber: 2, serverTime: 200 });
    const next = f.state.entityAt(1).nextState;
    expect([next.pos.type, next.apos.type]).toEqual([6, -1]);
    expect(f.state.nextSnap?.messageNumber).toBe(2);
  });
  test("retail copies preserve the product getter, tail words, trajectories and independent arrays", () => {
    const ps = new PlayerStateRecord<number, number, number>(product,
      MoveType.PM_SPINTERMISSION, Weapon.WP_CHAINGUN, WeaponState.WEAPON_FIRING);
    ps.externalEventTime = 101; ps.ping = 102; ps.pmoveFramecount = 103; ps.jumppadFrame = 104; ps.entityEventSequence = 105;
    ps.origin = vec3(1.25, 2.5, 3.75); ps.deltaAngles = { x: 2147483647, y: -2147483648, z: 16777217 };
    const slots = [ps.events, ps.eventParms, ps.stats, ps.persistant, ps.powerups, ps.ammo];
    for (const [index, slot] of slots.entries()) slot.set(0, 20 + index);
    const state = new EntityStateRecord<number>(TrajectoryType.TR_GRAVITY); state.number = 17;
    state.pos = { type: TrajectoryType.TR_GRAVITY, time: 30, duration: 40, base: vec3(4, 5, 6), delta: vec3(7, 8, 9) };
    state.apos = { type: TrajectoryType.TR_LINEAR_STOP, time: 50, duration: 60, base: vec3(10, 11, 12), delta: vec3(13, 14, 15) };
    const source: Snapshot = { ...snapshot(product, 3, 300), playerState: ps, entities: [state, state] };
    const copied = retailSnapshot(source), copiedEntity = copied.entities[0];
    if (copiedEntity === undefined) throw new Error("Missing retail entity");
    expect(copied.playerState.product).toBe(product);
    expect([copied.playerState.pmType, copied.playerState.weapon, copied.playerState.weaponState]).toEqual([6, 13, 3]);
    expect([copied.playerState.externalEventTime, copied.playerState.ping, copied.playerState.pmoveFramecount,
      copied.playerState.jumppadFrame, copied.playerState.entityEventSequence]).toEqual([101, 102, 103, 104, 105]);
    expect(copied.playerState.deltaAngles).toEqual({ x: 2147483647, y: -2147483648, z: 16777217 });
    expect(copiedEntity.pos).toEqual(state.pos); expect(copiedEntity.apos).toEqual(state.apos);
    expect(copiedEntity).not.toBe(state); expect(copiedEntity).not.toBe(copied.entities[1]);
    expect(copiedEntity.pos.base).not.toBe(state.pos.base); expect(copiedEntity.apos.delta).not.toBe(state.apos.delta);
    ps.origin = vec3(90, 91, 92); source.areaMask[0] = 99;
    for (const slot of slots) slot.set(0, 99);
    state.pos = { ...state.pos, base: vec3(90, 91, 92) };
    expect(copied.playerState.origin).toEqual(vec3(1.25, 2.5, 3.75)); expect(copied.areaMask[0]).toBe(3);
    expect([copied.playerState.events, copied.playerState.eventParms, copied.playerState.stats,
      copied.playerState.persistant, copied.playerState.powerups, copied.playerState.ammo].map(slot => slot.get(0))).toEqual([20, 21, 22, 23, 24, 25]);
    expect(copiedEntity.pos.base).toEqual(vec3(4, 5, 6));
  });
  test("cgame initialization retains a signed demo header and reads through snapshot zero", async () => {
    const f = fixture(product, -2);
    f.live.demo = true;
    expect(f.state.processedSnapshotNum).toBe(-2);
    f.publish(snapshot(product, 0, 1000));
    f.state.time = 1000;
    await f.runtime.processSnapshots();
    expect(f.state.processedSnapshotNum).toBe(0);
    expect(f.state.snap?.messageNumber).toBe(0);
    expect(f.calls.slice(0, 2)).toEqual(["lost", "received:0"]);
    expect(new ClientGameState(product, 0, -0x80000000).processedSnapshotNum).toBe(-0x80000000);
    for (const invalid of [NaN, 0.5, -0x80000001, 0x80000000]) {
      expect(() => new ClientGameState(product, 0, invalid)).toThrow("Invalid initial snapshot number");
    }
  });
  test("a published regressive demo snapshot reaches the source cgame regression error", async () => {
    const f = fixture(product);
    f.live.demo = true;
    f.publish(snapshot(product, 10, 1000));
    f.state.time = 1000;
    await f.runtime.processSnapshots();
    expect(f.state.snap?.messageNumber).toBe(10);
    f.publish(snapshot(product, 5, 1050));
    expect(f.source.current()).toEqual({ number: 5, serverTime: 1050 });
    const failure = f.runtime.processSnapshots();
    await expect(failure).rejects.toBeInstanceOf(CommonError);
    await expect(failure).rejects.toMatchObject({ code: "drop", message: "CG_ProcessSnapshots: n < cg.latestSnapshotNum" });
    expect(f.state.snap?.messageNumber).toBe(10);
    expect(f.state.latestSnapshotNum).toBe(10);
    expect(f.state.latestSnapshotTime).toBe(1050);
    expect(f.state.processedSnapshotNum).toBe(10);
    expect(f.history.latest?.messageNumber).toBe(5);
  });
  test("missing transition snapshots drop before executing server commands", async () => {
    const f = fixture(product);
    const noCurrent = f.runtime.transitionSnapshot();
    await expect(noCurrent).rejects.toBeInstanceOf(CommonError);
    await expect(noCurrent).rejects.toMatchObject({ code: "drop", message: "CG_TransitionSnapshot: NULL cg.snap" });
    expect(f.calls).toEqual([]);
    await f.runtime.setInitialSnapshot(snapshot(product, 1, 100));
    f.calls.length = 0;
    const noNext = f.runtime.transitionSnapshot();
    await expect(noNext).rejects.toBeInstanceOf(CommonError);
    await expect(noNext).rejects.toMatchObject({ code: "drop", message: "CG_TransitionSnapshot: NULL cg.nextSnap" });
    expect(f.calls).toEqual([]);
    expect(f.state.snap?.messageNumber).toBe(1);
    expect(f.state.nextSnap).toBeNull();
  });
  test("event rejection leaves later entities and snapshot bookkeeping unpublished", async () => {
    const f = fixture(product), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    await f.runtime.setInitialSnapshot(snapshot(product, 1, 100));
    const runtime = new SnapshotRuntime(f.state, { ...f.runtime.host, checkEvents: async cent => {
      f.calls.push(`pending:${cent.currentState.number}`); entered.resolve(); await gate.promise;
    } });
    runtime.setNextSnapshot(snapshot(product, 2, 200, [entity(1), entity(2)]));
    const work = runtime.transitionSnapshot(); await entered.promise;
    expect(f.state.entityAt(1).currentValid).toBe(true); expect(f.state.entityAt(1).snapshotTime).toBe(0);
    expect(f.state.entityAt(2).currentValid).toBe(false); expect(f.state.nextSnap?.serverTime).toBe(200);
    await expect(runtime.processSnapshots()).rejects.toThrow("already in progress");
    gate.reject(new Error("voice head failed")); await expect(work).rejects.toThrow("voice head failed");
    expect(f.state.entityAt(1).snapshotTime).toBe(0); expect(f.state.entityAt(2).currentValid).toBe(false);
    expect(f.state.nextSnap?.serverTime).toBe(200);
  });
  test("awaits server-command resources before publication and rejects frame reentry", async () => {
    const f = fixture(product), pending = Promise.withResolvers<void>();
    let suspended = false;
    const runtime = new SnapshotRuntime(f.state, { ...f.runtime.host,
      executeServerCommands: async sequence => { f.calls.push(`begin:${sequence}`); suspended = true; await pending.promise; f.calls.push(`end:${sequence}`); } });
    const task = runtime.setInitialSnapshot(snapshot(product, 1, 100, [entity(1, EntityType.ET_PLAYER)]));
    expect(suspended).toBe(true); expect(f.state.entityAt(1).currentValid).toBe(false);
    expect(f.calls).toEqual(["begin:1"]);
    await expect(runtime.processSnapshots()).rejects.toThrow("already in progress");
    expect(() => runtime.setNextSnapshot(snapshot(product, 2, 200))).toThrow("already in progress");
    pending.resolve(); await task;
    expect(f.calls).toEqual(["begin:1", "end:1", "respawn", "reset:1", "event:1:0:0"]);
    expect(f.state.entityAt(1).currentValid).toBe(true);
  });
  test("skips inactive/lost snapshots, orders initial callbacks, and owns every snapshot", async () => {
    const f = fixture(product), player = entity(1, EntityType.ET_PLAYER);
    f.publish({ ...snapshot(product, 1, 100), flags: 2 });
    const active = snapshot(product, 3, 200, [player]); active.playerState.addEvent(19, 7);
    f.publish(active); f.state.time = 190; await f.runtime.processSnapshots();
    expect(f.calls).toEqual(["received:1", "lost", "received:3", "command:3:false", "respawn", "reset:1", "event:1:0:0"]);
    expect(f.state.time).toBe(200); expect(f.state.processedSnapshotNum).toBe(3);
    expect(f.state.snap?.playerState.entityEventSequence).toBe(1);
    expect(f.history.latest?.playerState.entityEventSequence).toBe(0);
    expect(f.state.entityAt(1).currentState).not.toBe(player);
    expect(f.state.snap?.areaMask.length).toBe(32);
    expect(f.state.solidEntities).toEqual([]);
    f.state.entityAt(1).currentState.origin = vec3(99, 0, 0);
    expect(f.history.latest?.entities[0]?.origin.x).toBe(1);
  });
  test("same-time frames transition, disappearances invalidate, and teleport resets old events", async () => {
    const f = fixture(product);
    f.publish(snapshot(product, 1, 100, [entity(1, EntityType.ET_PLAYER), entity(2)]));
    f.state.time = 100; await f.runtime.processSnapshots(); f.calls.length = 0;
    f.state.entityAt(1).previousEvent = 77;
    const second = snapshot(product, 2, 100, [entity(1, EntityType.ET_PLAYER)]);
    second.playerState.pmFlags = MoveFlags.FOLLOW;
    f.publish(second); await f.runtime.processSnapshots();
    expect(f.calls).toEqual(["received:2", "command:2:true", "event:1:77:0", "transition:0:0"]);
    expect(f.state.entityAt(2).currentValid).toBe(false);
    const thirdEntity = entity(1, EntityType.ET_PLAYER); thirdEntity.eFlags = 4;
    const third = snapshot(product, 3, 500, [thirdEntity]); third.playerState.eFlags = 4;
    f.publish(third); f.state.time = 500; await f.runtime.processSnapshots();
    expect(f.calls.slice(-3)).toEqual(["command:3:true", "reset:1", "event:1:0:100"]);
    expect(f.state.thisFrameTeleport).toBe(true); expect(f.state.entityAt(1).snapshotTime).toBe(500);
  });
  test("interpolation barriers include follow target and server-count changes", async () => {
    const f = fixture(product); await f.runtime.setInitialSnapshot(snapshot(product, 1, 100, [entity(1)]));
    const second = snapshot(product, 2, 200, [entity(1)]); second.playerState.clientNum = 1;
    f.runtime.setNextSnapshot(second); expect(f.state.nextFrameTeleport).toBe(true);
    f.runtime.setNextSnapshot({ ...snapshot(product, 3, 200), flags: 4 }); expect(f.state.nextFrameTeleport).toBe(true);
    f.runtime.setNextSnapshot(snapshot(product, 4, 200, [entity(1)]));
    expect(f.state.nextFrameTeleport).toBe(false); expect(f.state.entityAt(1).interpolate).toBe(true);
  });
  test("source current/next solid list mixture is retained", async () => {
    const f = fixture(product), item = entity(10, EntityType.ET_ITEM), body = entity(11);
    body.solid = 0x200808; await f.runtime.setInitialSnapshot(snapshot(product, 1, 100, [item, body]));
    expect(f.state.triggerEntities.length).toBe(0); expect(f.state.solidEntities.length).toBe(0);
    f.runtime.setNextSnapshot(snapshot(product, 2, 200, [item, body]));
    expect(f.state.triggerEntities).toEqual([f.state.entityAt(10)]); expect(f.state.solidEntities).toEqual([f.state.entityAt(11)]);
  });
  test("history expires parse entities and ring slots, caps snapshots at 256 entities", () => {
    const f = fixture(product); f.publish(snapshot(product, 1, 100, Array.from({ length: 300 }, (_, i) => entity(i + 1))));
    expect(f.source.read(1)?.entities.length).toBe(256);
    const latest = f.source.current(), diagnostics = f.calls.length;
    expect(() => f.source.read(2)).toThrow(CommonError);
    try { f.source.read(2); } catch (error: unknown) {
      expect(error).toMatchObject({ code: "drop", message: "CL_GetSnapshot: snapshotNumber > cl.snapshot.messageNum" });
    }
    expect(f.source.current()).toEqual(latest); expect(f.calls).toHaveLength(diagnostics);
    expect(f.calls).toContain("CL_GetSnapshot: truncated 300 entities to 256\n");
    f.live.parseHead = 2047; expect(f.source.read(1)).not.toBeNull();
    f.live.parseHead = 2048; expect(f.source.read(1)).toBeNull();
    f.live.parseHead = 0; f.publish(snapshot(product, 33, 1000)); expect(f.source.read(1)).toBeNull();
  });
  test("cgame copies the retained parse-entity cells across wrap and expiry", () => {
    const retained = new SourceParseEntities(), history = new SnapshotHistory(retained);
    const source = new HistorySnapshotSource(history, () => retained.number, () => {});
    retained.number = 2047;
    const first = retained.at(retained.number); first.copyFrom(entity(17)); retained.advance();
    const second = retained.at(retained.number); second.copyFrom(entity(18)); retained.advance();
    history.publish({ kind: "snapshot", validity: { kind: "valid" },
      snapshot: { ...snapshot(product, 1, 100, [first, second]), parseEntitiesNumber: 2047 } });
    first.modelindex = 19;
    const published = source.read(1);
    if (published === null) throw new Error("Missing retained snapshot");
    expect(published.entities.map(state => state.number)).toEqual([17, 18]);
    expect(published.entities[0]?.modelindex).toBe(19);
    expect(history.latest?.entities[0]?.modelindex).toBe(0);
    const publishedFirst = published.entities[0];
    if (publishedFirst === undefined) throw new Error("Missing copied snapshot entity");
    publishedFirst.modelindex = 99; publishedFirst.origin = vec3(99, 0, 0);
    expect(source.read(1)?.entities[0]?.modelindex).toBe(19);
    expect(first.origin.x).toBe(17); expect(retained.at(0)).toBe(second);
    retained.number = 4094; expect(source.read(1)).not.toBeNull();
    retained.number = 4095; expect(source.read(1)).toBeNull();
    retained.number = 0x7fffffff; retained.advance();
    expect(retained.number).toBe(-0x80000000); expect(retained.at(retained.number)).toBe(second);
  });
  test("snapshot truncation copies headers before diagnostics and retained entities after them", () => {
    const retained = new SourceParseEntities(), history = new SnapshotHistory(retained);
    const original = { ...snapshot(product, 1, 100, Array.from({ length: 300 }, (_, index) => entity(index + 1))),
      parseEntitiesNumber: 0, areaMask: new Uint8Array(32) };
    original.playerState.health = 100;
    original.areaMask[0] = 3; original.areaMask[31] = 9;
    for (const [index, state] of original.entities.entries()) retained.at(index).copyFrom(state);
    retained.number = 300;
    history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: original });
    const borrowed = history.borrowSlot(1, product), record = borrowed.snapshot;
    const playerState = record.playerState, areaMask = record.areaMask;
    const replacement = { ...snapshot(product, 33, 200, Array.from({ length: 256 }, (_, index) => entity(index + 400))), parseEntitiesNumber: 500 };
    replacement.playerState.health = 7;
    replacement.areaMask[0] = 5;
    const messages: string[] = [];
    const source = new HistorySnapshotSource(history, () => retained.number, message => {
      messages.push(message);
      for (const [index, state] of replacement.entities.entries()) retained.at(500 + index).copyFrom(state);
      retained.number = 756;
      history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: replacement });
    });
    const published = source.read(1);
    if (published === null) throw new Error("Missing snapshot after diagnostic");
    expect(messages).toEqual(["CL_GetSnapshot: truncated 300 entities to 256\n"]);
    expect(published.serverTime).toBe(100); expect(published.playerState.health).toBe(100);
    expect(published.areaMask[0]).toBe(3); expect(published.areaMask[31]).toBe(9);
    expect(published.entities.length).toBe(256);
    expect(published.entities[0]?.number).toBe(400); expect(published.entities[255]?.number).toBe(655);
    expect(history.borrowSlot(33, product)).toBe(borrowed); expect(borrowed.snapshot).toBe(record);
    expect(record.playerState).toBe(playerState); expect(playerState.health).toBe(7);
    expect(record.areaMask).toBe(areaMask); expect(areaMask.length).toBe(32);
    expect(areaMask[0]).toBe(5); expect(areaMask[31]).toBe(0);
    expect(record.serverTime).toBe(200); expect(record.parseEntitiesNumber).toBe(500);
    history.clear(); retained.clear();
    expect(history.borrowSlot(1, product)).toBe(borrowed); expect(borrowed.snapshot).toBe(record);
    expect(borrowed.status).toBe("invalid"); expect(record.serverTime).toBe(0); expect(record.entities.length).toBe(0);
    expect(record.playerState).toBe(playerState); expect(playerState.health).toBe(0);
    expect(record.areaMask).toBe(areaMask); expect(areaMask).toEqual(new Uint8Array(32));
    expect(history.readSlot(1)).toBeNull(); expect(history.latest).toBeNull();
    expect(published.entities[0]?.number).toBe(400); expect(published.playerState.health).toBe(100);
    expect(published.areaMask[0]).toBe(3); expect(published.areaMask[31]).toBe(9);
    const otherProduct = product === "baseq3" ? "missionpack" : "baseq3";
    expect(history.borrowSlot(1, otherProduct).snapshot.playerState).toBe(playerState);
    expect(playerState.product).toBe(otherProduct); expect(published.playerState.product).toBe(product);
  });
  test("player deltas observe the borrowed snapshot state after diagnostic publication and clear", () => {
    for (const clear of [false, true]) {
      const history = new SnapshotHistory(), original = snapshot(product, 1, 100);
      original.playerState.commandTime = 10; original.playerState.origin = vec3(1, 2, 3);
      original.playerState.health = 100; original.playerState.ping = 19;
      original.playerState.events.set(0, 11); original.playerState.eventParms.set(0, 12);
      original.playerState.persistant.set(0, 13); original.playerState.ammo.set(0, 14); original.playerState.powerups.set(0, 15);
      history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: original });
      const record = history.borrowSlot(1, product).snapshot, playerState = record.playerState;
      const events = playerState.events, eventParms = playerState.eventParms, stats = playerState.stats;
      const persistant = playerState.persistant, ammo = playerState.ammo, powerups = playerState.powerups;
      const next = original.playerState.copy(); next.commandTime = 11;
      const writer = new MessageWriter(); writeDeltaPlayerState(writer, original.playerState, next);
      const replacement = snapshot(product, 33, 200);
      replacement.playerState.commandTime = 20; replacement.playerState.origin = vec3(7, 8, 9);
      replacement.playerState.health = 7; replacement.playerState.ping = 70;
      replacement.playerState.events.set(0, 21); replacement.playerState.eventParms.set(0, 22);
      replacement.playerState.persistant.set(0, 23); replacement.playerState.ammo.set(0, 24); replacement.playerState.powerups.set(0, 25);
      const result = readDeltaPlayerState(new MessageReader(writer.toBytes()), playerState, product, {
        shownet: () => 2, offset: 0, print: message => {
          if (!message.endsWith(": playerstate ")) return;
          if (clear) history.clear();
          else history.publish({ kind: "snapshot", validity: { kind: "valid" }, snapshot: replacement });
        },
      });
      expect(record.playerState).toBe(playerState); expect(playerState.events).toBe(events); expect(playerState.eventParms).toBe(eventParms);
      expect(playerState.stats).toBe(stats); expect(playerState.persistant).toBe(persistant);
      expect(playerState.ammo).toBe(ammo); expect(playerState.powerups).toBe(powerups);
      expect(playerState.commandTime).toBe(clear ? 0 : 20); expect(playerState.health).toBe(clear ? 0 : 7);
      expect(events.get(0)).toBe(clear ? 0 : 21); expect(eventParms.get(0)).toBe(clear ? 0 : 22);
      expect(persistant.get(0)).toBe(clear ? 0 : 23); expect(ammo.get(0)).toBe(clear ? 0 : 24); expect(powerups.get(0)).toBe(clear ? 0 : 25);
      expect(result.commandTime).toBe(11); expect(result.origin).toEqual(clear ? vec3(0, 0, 0) : vec3(7, 8, 9));
      expect(result.health).toBe(100); expect(result.ping).toBe(19);
      expect(result.events.get(0)).toBe(clear ? 0 : 21); expect(result.eventParms.get(0)).toBe(clear ? 0 : 22);
      expect(result.persistant.get(0)).toBe(13); expect(result.ammo.get(0)).toBe(14); expect(result.powerups.get(0)).toBe(15);
    }
  });
  test("backward snapshot clocks and numbers reject, clients do not share state", async () => {
    const f = fixture(product); f.publish(snapshot(product, 1, 200)); f.state.time = 200; await f.runtime.processSnapshots();
    f.publish(snapshot(product, 2, 100));
    const failure = f.runtime.processSnapshots();
    await expect(failure).rejects.toBeInstanceOf(CommonError);
    await expect(failure).rejects.toMatchObject({ code: "drop", message: "CG_ProcessSnapshots: Server time went backwards" });
    expect(f.state.snap?.serverTime).toBe(200); expect(f.state.nextSnap?.serverTime).toBe(100);
    expect(f.state.processedSnapshotNum).toBe(2); expect(f.state.time).toBe(200);
    expect(f.calls).toEqual(["received:1", "command:1:false", "respawn", "received:2"]);
    f.history.clear(); await expect(f.runtime.processSnapshots()).rejects.toThrow("n < cg.latestSnapshotNum");
    const other = new ClientGameState(product, 0, 0);
    f.state.entityAt(1).player.legs.frame = 99; f.state.predictedPlayerState.stats.set(0, 99);
    expect(other.entityAt(1).player.legs.frame).toBe(0); expect(other.predictedPlayerState.stats.get(0)).toBe(0);
    expect(() => other.entityAt(1024)).toThrow();
    f.state.refdef.areaMask[0] = 7;
    f.state.refdef.fovX = 91.25;
    f.state.refdef.fovY = 75.75;
    f.state.refdef.viewAxis = [vec3(0, 1, 0), vec3(-1, 0, 0), vec3(0, 0, 1)];
    const published = copyRefdef(f.state.refdef);
    expect(published.fovX).toBe(91.25); expect(published.fovY).toBe(75.75);
    expect(published.viewAxis).toEqual(f.state.refdef.viewAxis); expect(published.viewAxis).not.toBe(f.state.refdef.viewAxis);
    f.state.refdef.areaMask[0] = 9;
    expect(published.areaMask[0]).toBe(7); expect(other.refdef.areaMask[0]).toBe(0);
    expect(other.refdef.text).toEqual(["", "", "", "", "", "", "", ""]);
    expect(() => copyRefdef({ ...published, areaMask: new Uint8Array(31) })).toThrow("32 area-mask");
  });
});
