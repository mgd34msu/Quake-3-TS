import { describe, expect, test } from "bun:test";
import { SnapshotHistory } from "../src/cgame/snapshot-history.ts";
import { HistorySnapshotSource } from "../src/cgame/snapshots.ts";
import { decodeServerMessage, encodeServerMessage } from "../src/protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation, Snapshot } from "../src/protocol/server-message.ts";
import { MAX_PARSE_ENTITIES, SourceParseEntities } from "../src/protocol/parse-entities.ts";
import type { Product } from "../src/shared/definitions.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import { PlayerState, PlayerStateRecord } from "../src/shared/player-state.ts";

function frame(messageNumber: number, deltaNumber = -1) {
  const playerState = new PlayerState("baseq3");
  playerState.origin = { x: messageNumber, y: 2, z: 3 };
  playerState.health = 100;
  const entity = new EntityState(); entity.number = 1; entity.modelindex = messageNumber;
  return { messageNumber, serverTime: messageNumber * 50, deltaNumber, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: messageNumber - 1, areaMask: Buffer.from([3]), playerState, entities: [entity] } satisfies Snapshot;
}

function operation(snapshot: Snapshot): Extract<ServerOperation, { kind: "snapshot" }> {
  return { kind: "snapshot", validity: { kind: "valid" }, snapshot };
}

describe("source client snapshot history", () => {
  test("raw mod state and ABI tails survive detached current storage and mutable ring borrows", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const parsed = new SourceParseEntities(), history = new SnapshotHistory(parsed);
      const playerState = new PlayerStateRecord<number, number, number>(product, -0x80000000, 0x7fffffff, -7);
      playerState.externalEventTime = 111; playerState.ping = 222; playerState.pmoveFramecount = 333;
      playerState.jumppadFrame = 444; playerState.entityEventSequence = 555;
      playerState.deltaAngles = { x: 0x7fffffff, y: -0x80000000, z: 57344 };
      playerState.stats.set(15, -17); playerState.events.set(1, 0x7fffffff);
      const entity = new EntityStateRecord<number>(0);
      entity.number = 1; entity.weapon = -19;
      entity.pos = { ...entity.pos, type: -0x80000000 };
      entity.apos = { ...entity.apos, type: 0x7fffffff };
      parsed.at(0).copyFrom(entity); parsed.advance();
      const slot = history.borrowSlot(0, product), slotState = slot.snapshot.playerState;
      history.publish(operation({ ...frame(0), parseEntitiesNumber: 0, playerState, entities: [entity] }));
      expect(history.borrowSlot(0, product)).toBe(slot);
      expect(slot.snapshot.playerState).toBe(slotState);
      expect([slotState.pmType, slotState.weapon, slotState.weaponState]).toEqual([-0x80000000, 0x7fffffff, -7]);
      playerState.pmType = 12; playerState.externalEventTime = 13;
      entity.pos = { ...entity.pos, type: 14 };
      slotState.pmType = 21; slotState.externalEventTime = 22;
      const retained = history.readCurrentPlayerState();
      if (retained === null) throw new Error("Current raw player state missing");
      expect([retained.pmType, retained.weapon, retained.weaponState]).toEqual([-0x80000000, 0x7fffffff, -7]);
      expect([retained.externalEventTime, retained.ping, retained.pmoveFramecount, retained.jumppadFrame,
        retained.entityEventSequence]).toEqual([111, 222, 333, 444, 555]);
      expect(retained.deltaAngles).toEqual({ x: 0x7fffffff, y: -0x80000000, z: 57344 });
      expect(retained.stats.get(15)).toBe(-17); expect(retained.events.get(1)).toBe(0x7fffffff);
      expect(history.latest?.entities.map(value => [value.weapon, value.pos.type, value.apos.type]))
        .toEqual([[-19, -0x80000000, 0x7fffffff]]);
      retained.weapon = 1; retained.ping = 2; retained.stats.set(15, 3);
      parsed.number = MAX_PARSE_ENTITIES;
      const source = new HistorySnapshotSource(history, () => parsed.number, () => {});
      expect(source.read(0)).toBeNull();
      expect(history.readCurrentPlayerState()?.weapon).toBe(0x7fffffff);
      expect(history.readCurrentPlayerState()?.ping).toBe(222);
      expect(history.readCurrentPlayerState()?.stats.get(15)).toBe(-17);
      history.clear();
      expect(history.borrowSlot(0, product)).toBe(slot);
      expect(slot.snapshot.playerState).toBe(slotState);
      expect(slot.status).toBe("invalid");
      expect([slotState.pmType, slotState.weapon, slotState.weaponState, slotState.externalEventTime,
        slotState.ping, slotState.pmoveFramecount, slotState.jumppadFrame, slotState.entityEventSequence])
        .toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(history.readCurrentPlayerState()).toBeNull();
    }
  });

  test("snapshot truncation captures header and player state before callbacks and entities afterward", () => {
    const parsed = new SourceParseEntities(), history = new SnapshotHistory(parsed);
    const playerState = new PlayerStateRecord<number, number, number>("baseq3", 201, 31, 14);
    playerState.externalEventTime = 101; playerState.ping = 102; playerState.pmoveFramecount = 103;
    playerState.jumppadFrame = 104; playerState.entityEventSequence = 105;
    const entities = Array.from({ length: 257 }, (_, index) => {
      const entity = new EntityStateRecord<number>(0);
      entity.number = index + 1; entity.modelindex = 7;
      parsed.at(index).copyFrom(entity);
      return entity;
    });
    parsed.number = entities.length;
    history.publish(operation({ ...frame(1), flags: 2, serverCommandNumber: 8, parseEntitiesNumber: 0, playerState, entities }));
    const slot = history.borrowSlot(1, "baseq3"), prints: string[] = [];
    const source = new HistorySnapshotSource(history, () => parsed.number, text => {
      prints.push(text);
      const replacement = new PlayerStateRecord<number, number, number>("baseq3", 202, 30, 13);
      replacement.externalEventTime = 901; replacement.ping = 902; replacement.pmoveFramecount = 903;
      replacement.jumppadFrame = 904; replacement.entityEventSequence = 905;
      for (let index = 0; index < 256; index++) {
        const entity = parsed.at(300 + index);
        entity.number = 700 + index; entity.modelindex = 9;
        entity.pos = { ...entity.pos, type: 221 };
        entity.apos = { ...entity.apos, type: 222 };
      }
      parsed.number = 556;
      history.publish(operation({ ...frame(33), flags: 4, serverCommandNumber: 16, parseEntitiesNumber: 300,
        areaMask: Uint8Array.of(19), playerState: replacement, entities: [] }));
    });
    const read = source.read(1);
    if (read === null) throw new Error("Snapshot was discarded during truncation print");
    expect(prints).toEqual(["CL_GetSnapshot: truncated 257 entities to 256\n"]);
    expect(history.borrowSlot(33, "baseq3")).toBe(slot);
    expect([read.messageNumber, read.serverTime, read.flags, read.serverCommandNumber, read.parseEntitiesNumber])
      .toEqual([1, 50, 2, 8, 0]);
    expect(read.areaMask[0]).toBe(3);
    expect([read.playerState.pmType, read.playerState.weapon, read.playerState.weaponState]).toEqual([201, 31, 14]);
    expect([read.playerState.externalEventTime, read.playerState.ping, read.playerState.pmoveFramecount,
      read.playerState.jumppadFrame, read.playerState.entityEventSequence]).toEqual([101, 102, 103, 104, 105]);
    expect(read.entities.length).toBe(256);
    expect(read.entities.map(entity => entity.number)).toEqual(Array.from({ length: 256 }, (_, index) => 700 + index));
    expect(read.entities.every(entity => entity.modelindex === 9 && entity.pos.type === 221 && entity.apos.type === 222)).toBe(true);
    parsed.at(300).modelindex = 77;
    expect(read.entities[0]?.modelindex).toBe(9);
  });

  test("current player state uses authoritative presence and detached copies", () => {
    const history = new SnapshotHistory();
    expect(history.readCurrentPlayerState()).toBeNull();
    history.publish(operation(frame(0)));
    const state = history.readCurrentPlayerState();
    if (state === null) throw new Error("Snapshot zero did not retain player state");
    expect(state.health).toBe(100);
    state.health = 3; state.deltaAngles = { ...state.deltaAngles, x: 99 };
    expect(history.readCurrentPlayerState()?.health).toBe(100);
    expect(history.readCurrentPlayerState()?.deltaAngles.x).toBe(0);
    history.clear();
    expect(history.readCurrentPlayerState()).toBeNull();
  });
  test("owns input state and returns independent state to each consumer", () => {
    const history = new SnapshotHistory();
    const input = frame(1);
    expect(history.publish(operation(input))).toBe(true);
    input.playerState.health = 1;
    input.areaMask[0] = 255;
    const inputEntity = input.entities[0];
    if (inputEntity === undefined) throw new Error("Fixture entity missing");
    inputEntity.modelindex = 900;
    const latest = history.latest;
    if (latest === null) throw new Error("Snapshot missing");
    expect(latest.playerState.health).toBe(100);
    expect(latest.areaMask[0]).toBe(3);
    expect(latest.entities[0]?.modelindex).toBe(1);
    latest.playerState.health = 2;
    const slot = history.readSlot(1);
    if (slot === null) throw new Error("Ring slot missing");
    slot.snapshot.playerState.health = 3;
    slot.snapshot.areaMask.fill(0);
    expect(history.latest?.playerState.health).toBe(100);
    expect(history.latest?.areaMask[0]).toBe(3);
  });

  test("invalid delta does not replace current state or invalidate history", () => {
    const history = new SnapshotHistory();
    history.publish(operation(frame(1)));
    expect(history.publish({ kind: "snapshot", validity: { kind: "invalid", reason: "missing-delta" }, snapshot: frame(33, 2) })).toBe(false);
    expect(history.latest?.messageNumber).toBe(1);
    expect(history.readSlot(1)?.status).toBe("valid");
  });

  test("invalidates skipped ring slots but preserves stale data for decoding", () => {
    const history = new SnapshotHistory();
    for (let number = 1; number <= 32; number++) history.publish(operation(frame(number)));
    history.publish(operation(frame(34)));
    const skipped = history.readSlot(33);
    expect(skipped?.status).toBe("invalid");
    expect(skipped?.snapshot.messageNumber).toBe(1);
    expect(skipped?.snapshot.playerState.origin.x).toBe(1);
    expect(history.readSlot(34)?.status).toBe("valid");
    history.publish(operation(frame(1000)));
    for (let number = 969; number < 1000; number++) expect(history.readSlot(number)?.status).toBe("invalid");
    expect(history.latest?.messageNumber).toBe(1000);
  });

  test("clears history at gamestate reset and rejects invalid sequence publication", () => {
    const history = new SnapshotHistory();
    history.publish(operation(frame(1)));
    expect(history.publish(operation(frame(1)))).toBe(true);
    for (const number of [-0x80000001, 1.5, NaN, 0x80000000]) expect(() => history.readSlot(number)).toThrow("sequence");
    history.clear();
    expect(history.latest).toBeNull();
    expect(history.readSlot(1)).toBeNull();
    expect(history.publish(operation(frame(1)))).toBe(true);
  });

  test("signed and regressive snapshots retain source masked slots and signed retrieval", () => {
    const history = new SnapshotHistory();
    const source = new HistorySnapshotSource(history, () => 0, () => {});
    history.publish(operation(frame(10)));
    history.publish(operation(frame(5)));
    expect(history.readSlot(10)?.status).toBe("valid");
    expect(source.current().number).toBe(5);
    expect(source.read(5)?.messageNumber).toBe(5);
    expect(() => source.read(10)).toThrow("CL_GetSnapshot");
    history.publish(operation(frame(-1)));
    expect(source.read(-1)?.messageNumber).toBe(-1);
    history.publish(operation(frame(0)));
    expect(source.read(0)?.messageNumber).toBe(0);
    expect(source.read(-1)?.messageNumber).toBe(-1);
    // CL_GetSnapshot checks validity and age, not the retained slot's messageNum.
    expect(source.read(-22)?.messageNumber).toBe(10);
    expect(source.read(-32)).toBeNull();
    for (const number of [NaN, 0.5, -0x80000001, 0x80000000]) expect(() => source.read(number)).toThrow("int32");
  });

  test("sequence arithmetic wraps in the retained 32-slot owner", () => {
    const history = new SnapshotHistory();
    for (let number = 1; number <= 32; number++) history.publish(operation(frame(number)));
    history.publish(operation(frame(0x7fffffff)));
    history.publish(operation(frame(-0x80000000)));
    expect(history.latest?.messageNumber).toBe(-0x80000000);
    expect(history.readSlot(-0x80000000)?.snapshot.messageNumber).toBe(-0x80000000);
    expect(history.readSlot(0x7fffffff)?.status).toBe("valid");
    history.publish(operation(frame(0x7fffffff)));
    history.publish(operation(frame(0x7fffffff)));
    expect(history.readSlot(-0x80000000)?.status).toBe("invalid");
    expect(history.latest?.messageNumber).toBe(0x7fffffff);
  });

  test("consumes a lost-reference packet and recovers with the next full snapshot", () => {
    const server = new SnapshotHistory();
    const client = new SnapshotHistory();
    let parseEntitiesNumber = 0;
    function context(messageNumber: number, history: SnapshotHistory): ServerMessageContext {
      return { product: "baseq3", messageNumber, reliableSequence: 0, serverCommandSequence: 0,
        parseEntitiesNumber, baseline: () => null, history: number => history.readSlot(number) };
    }
    function receive(snapshot: Snapshot, deliver: boolean): readonly ServerOperation[] {
      const encoded = encodeServerMessage(0, [operation(snapshot), { kind: "command", sequence: snapshot.messageNumber, text: "print after_snapshot" }], context(snapshot.messageNumber, server));
      server.publish(operation(snapshot));
      if (!deliver) return [];
      const message = decodeServerMessage(encoded, context(snapshot.messageNumber, client));
      parseEntitiesNumber = message.parseEntitiesNumber;
      for (const item of message.operations) if (item.kind === "snapshot") client.publish(item);
      return message.operations;
    }
    receive(frame(1), true);
    receive(frame(2, 1), false);
    const invalid = receive(frame(3, 2), true);
    const lost = invalid[0];
    if (lost?.kind !== "snapshot") throw new Error("Missing decoded snapshot");
    expect(lost.validity.kind).toBe("invalid");
    expect(invalid[1]).toEqual({ kind: "command", sequence: 3, text: "print after_snapshot" });
    expect(client.latest?.messageNumber).toBe(1);
    expect(parseEntitiesNumber).toBe(2);
    receive(frame(4), true);
    expect(client.latest?.playerState.origin.x).toBe(4);
    expect(client.latest?.entities[0]?.modelindex).toBe(4);
  });
});
