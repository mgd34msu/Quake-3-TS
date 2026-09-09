import { describe, expect, test } from "bun:test";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import type { EntityStateFields } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { Weapon } from "../src/shared/definitions.ts";
import { vec3 } from "../src/core/math.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { SourceParseEntities } from "../src/protocol/parse-entities.ts";
import { ServerReliableCommands } from "../src/protocol/reliable.ts";
import { writeDeltaEntity, writeDeltaPlayerState } from "../src/protocol/state-delta.ts";
import { decodeServerMessage, encodeServerMessage, writeServerMessage, ServerMessageCursor, ServerOpcode } from "../src/protocol/server-message.ts";
import type { Gamestate, ServerMessageContext, ServerOperation, Snapshot, SnapshotHistoryEntry, SnapshotValidity } from "../src/protocol/server-message.ts";

// Native source oracle uses untouched SV_WriteSnapshotToClient/SV_EmitPacketEntities
// and MSG_* from dbe4ddb. Gamestate/download order follows SV_SendClientGameState/WriteDownloadToClient.
const GAMESTATE = "6c15f9ab6c3d967781cdcde66519781ec18e014259ca028f60b2b7c7f22eb0f3604717b023944bc786df2f1bba3e01c0480000ff15a92e8d3705bf02";
const FULL = "6c35e2570b8f5018b23707c3c49cf54fb2d55024fb9b21be6c5d29410100000000cbdb4b229d58f900bc97c90a";
const DELTA = "6cf55f2554772892fd21c53eea13001c0a0060da9eac00";
const DOWNLOAD = "6c15a26c952d5412b2d50a";

function baseline(): EntityState {
  const entity = new EntityState();
  entity.number = 3; entity.eType = 2; entity.modelindex = 7;
  return entity;
}

function context(messageNumber = 10, old: SnapshotHistoryEntry | null = null): ServerMessageContext {
  return { product: "baseq3", messageNumber, reliableSequence: 3, serverCommandSequence: messageNumber === 10 ? 6 : 7,
    parseEntitiesNumber: messageNumber === 10 ? 0 : 2,
    baseline: (number) => number === 3 ? baseline() : null,
    history: () => old };
}

function fullSnapshot(): Snapshot {
  const playerState = new PlayerState("baseq3");
  playerState.commandTime = 995; playerState.origin = vec3(10.5, 0, 0); playerState.stats.set(0, 100); playerState.weapon = Weapon.WP_ROCKET_LAUNCHER;
  const entity = new EntityState(); entity.number = 1; entity.eType = 1; entity.pos = { ...entity.pos, base: vec3(5, 0, 0) };
  return { messageNumber: 10, serverTime: 1000, deltaNumber: -1, flags: 4, serverCommandNumber: 7, parseEntitiesNumber: 0,
    areaMask: Uint8Array.of(3, 128), playerState, entities: [entity, baseline()] };
}

function deltaSnapshot(): Snapshot {
  const full = fullSnapshot();
  full.playerState.origin = vec3(12, 0, 0);
  const next = new EntityState(); next.number = 2; next.eType = 4; next.modelindex = 9;
  const unchanged = full.entities[0];
  if (unchanged === undefined) throw new Error("Missing fixture entity");
  return { ...full, messageNumber: 11, serverTime: 1050, deltaNumber: 10, parseEntitiesNumber: 2, entities: [unchanged, next] };
}

function snapshotOperation(snapshot: Snapshot): Extract<ServerOperation, { kind: "snapshot" }> {
  return { kind: "snapshot", validity: { kind: "valid" }, snapshot };
}

function gamestate(): Gamestate {
  return { kind: "gamestate", commandSequence: 7, clientNumber: 2, checksumFeed: 0x12345678, entries: [
    { kind: "configstring", index: 0, value: "\\sv_hostname\\Fixture" },
    { kind: "configstring", index: 1, value: "\\sv_serverid\\123" },
    { kind: "baseline", number: 3, entity: baseline() },
  ] };
}

describe("server envelope native fixtures", () => {
  test("source negative acknowledgement window writes signed command sequences unchanged", () => {
    const reliable = new ServerReliableCommands(); reliable.assignAcknowledgement(-64);
    const operations: ServerOperation[] = reliable.pending().map(command => ({ kind: "command", ...command }));
    const writer = new MessageWriter(); writeServerMessage(writer, 0, operations, context()); writer.writeByte(ServerOpcode.Eof);
    const reader = new MessageReader(writer.toBytes()); expect(reader.readLong()).toBe(0);
    for (let sequence = -63; sequence <= 0; sequence++) { expect(reader.readByte()).toBe(ServerOpcode.Command); expect(reader.readLong()).toBe(sequence); expect(reader.readString()).toBe(""); }
    expect(reader.readByte()).toBe(ServerOpcode.Eof);
    // CL_ParseCommandString consumes these old commands but does not publish them.
    expect(decodeServerMessage(writer.toBytes(), context()).operations).toEqual([]);
  });
  test("unfinished server writer permits source padding/downloads before channel-owned EOF", () => {
    const writer = new MessageWriter();
    writeServerMessage(writer, 3, [snapshotOperation(fullSnapshot())], context());
    writer.writeByte(ServerOpcode.Nop);
    writer.writeByte(ServerOpcode.Download); writer.writeShort(1); writer.writeShort(0);
    writer.writeByte(ServerOpcode.Eof);
    expect(writer.toBytes()).toEqual(encodeServerMessage(3, [snapshotOperation(fullSnapshot()), { kind: "nop" },
      { kind: "download", block: { kind: "chunk", number: 1, data: new Uint8Array() } }], context()));
  });
  test("unfinished writer retains overflow for the source caller to clear", () => {
    const writer = new MessageWriter("bitstream", 4);
    expect(() => writeServerMessage(writer, 3, [snapshotOperation(fullSnapshot())], context())).not.toThrow();
    expect(writer.overflowed).toBe(true); writer.clear(); expect(writer.byteLength).toBe(0);
  });
  test("gamestate configstrings, baseline, client index and checksum match source bytes", () => {
    const encoded = encodeServerMessage(3, [gamestate()], context());
    expect(Buffer.from(encoded).toString("hex")).toBe(GAMESTATE);
    const decoded = decodeServerMessage(Buffer.from(GAMESTATE, "hex"), context());
    expect(decoded).toEqual({ reliableAcknowledge: 3, serverCommandSequence: 7, parseEntitiesNumber: 0, operations: [gamestate()], terminal: "eof" });
  });

  test("full snapshot and preceding reliable command match original SV snapshot writer", () => {
    const operations: ServerOperation[] = [{ kind: "command", sequence: 7, text: "print hello" }, snapshotOperation(fullSnapshot())];
    expect(Buffer.from(encodeServerMessage(3, operations, context())).toString("hex")).toBe(FULL);
    const decoded = decodeServerMessage(Buffer.from(FULL, "hex"), context());
    expect(decoded.operations).toEqual(operations);
    expect(decoded.parseEntitiesNumber).toBe(2);
    expect(decoded.serverCommandSequence).toBe(7);
  });

  test("delta sorted merge keeps entity1, adds2 and removes3 exactly like source", () => {
    const ctx = context(11, { status: "valid", snapshot: fullSnapshot() });
    const operations = [snapshotOperation(deltaSnapshot())];
    expect(Buffer.from(encodeServerMessage(3, operations, ctx)).toString("hex")).toBe(DELTA);
    const decoded = decodeServerMessage(Buffer.from(DELTA, "hex"), ctx);
    expect(decoded.operations).toEqual(operations);
    expect(decoded.parseEntitiesNumber).toBe(4);
  });

  test("download first block and zero-length EOF block match source bytes", () => {
    const operations: ServerOperation[] = [
      { kind: "download", block: { kind: "start", fileSize: 3, data: Uint8Array.of(65, 0, 255) } },
      { kind: "download", block: { kind: "chunk", number: 1, data: new Uint8Array() } },
    ];
    expect(Buffer.from(encodeServerMessage(3, operations, context())).toString("hex")).toBe(DOWNLOAD);
    expect(decodeServerMessage(Buffer.from(DOWNLOAD, "hex"), context()).operations).toEqual(operations);
  });

  test("download reader accepts source MAX_MSGLEN storage beyond the sender chunk size", () => {
    for (const size of [2049, 16384]) {
      const data = new Uint8Array(size);
      const writer = new MessageWriter();
      writer.writeLong(3); writer.writeByte(ServerOpcode.Download); writer.writeShort(1); writer.writeShort(size);
      writer.writeData(data); writer.writeByte(ServerOpcode.Eof);
      expect(writer.overflowed).toBe(false);
      expect(decodeServerMessage(writer.toBytes(), context()).operations).toEqual([{ kind: "download", block: { kind: "chunk", number: 1, data } }]);
    }
  });
});

describe("snapshot validity and ownership", () => {
  test("missing reference consumes the whole invalid snapshot before next command", () => {
    const valid = context(11, { status: "valid", snapshot: fullSnapshot() });
    const bytes = encodeServerMessage(3, [snapshotOperation(deltaSnapshot()), { kind: "command", sequence: 8, text: "after snapshot" }], valid);
    const decoded = decodeServerMessage(bytes, context(11));
    const first = decoded.operations[0];
    if (first?.kind !== "snapshot") throw new Error("Missing snapshot");
    expect(first.validity).toEqual({ kind: "invalid", reason: "missing-delta" });
    expect(first.snapshot.entities.map((entity) => entity.number)).toEqual([2]);
    expect(decoded.operations[1]).toEqual({ kind: "command", sequence: 8, text: "after snapshot" });
    expect(decoded.serverCommandSequence).toBe(8);
    expect(decoded.terminal).toBe("eof");
    expect(() => encodeServerMessage(3, [first], valid)).toThrow("invalid decoded snapshot");
  });

  test("invalid flag, stale ring message and expired entity history remain distinguishable", () => {
    const old = fullSnapshot();
    const cases: readonly [ServerMessageContext, Extract<SnapshotValidity, { kind: "invalid" }>["reason"]][] = [
      [context(11, { status: "invalid", snapshot: old }), "invalid-delta"],
      [context(11, { status: "valid", snapshot: { ...old, messageNumber: 9 } }), "stale-delta"],
      [{ ...context(11, { status: "valid", snapshot: old }), parseEntitiesNumber: 1921 }, "stale-entities"],
    ];
    for (const [ctx, reason] of cases) {
      const result = decodeServerMessage(Buffer.from(DELTA, "hex"), ctx);
      const first = result.operations[0];
      if (first?.kind !== "snapshot") throw new Error("Missing snapshot");
      expect(first.validity).toEqual({ kind: "invalid", reason });
      expect(first.snapshot.entities.map((entity) => entity.number)).toEqual([1, 2]);
    }
    const limit = decodeServerMessage(Buffer.from(DELTA, "hex"), { ...context(11, { status: "valid", snapshot: old }), parseEntitiesNumber: 1920 });
    const first = limit.operations[0];
    if (first?.kind !== "snapshot") throw new Error("Missing snapshot");
    expect(first.validity).toEqual({ kind: "valid" });
  });

  test("decoded entities, player arrays and masks own bytes apart from history and input", () => {
    const old = fullSnapshot();
    const bytes = Buffer.from(DELTA, "hex");
    const result = decodeServerMessage(bytes, context(11, { status: "valid", snapshot: old }));
    const first = result.operations[0];
    if (first?.kind !== "snapshot") throw new Error("Missing snapshot");
    const oldEntity = old.entities[0]; const newEntity = first.snapshot.entities[0];
    if (oldEntity === undefined || newEntity === undefined) throw new Error("Missing fixture entity");
    expect(newEntity).not.toBe(oldEntity);
    expect(newEntity.pos.base).not.toBe(oldEntity.pos.base);
    oldEntity.eType = 99;
    old.playerState.stats.set(0, 1);
    old.areaMask.fill(0);
    bytes.fill(0);
    expect(newEntity.eType).toBe(1);
    expect(first.snapshot.playerState.stats.get(0)).toBe(100);
    expect(first.snapshot.areaMask).toEqual(Uint8Array.of(3, 128));
  });

  test("gamestate resets prior baseline/history and command sequence within same envelope", () => {
    const ctx = context(10, { status: "valid", snapshot: fullSnapshot() });
    const operations: ServerOperation[] = [gamestate(), snapshotOperation(fullSnapshot())];
    const result = decodeServerMessage(encodeServerMessage(3, operations, ctx), { ...ctx, parseEntitiesNumber: 999, baseline: () => { throw new Error("Old baseline must be cleared"); } });
    expect(result.operations).toEqual(operations);
    expect(result.parseEntitiesNumber).toBe(2);
  });
});

describe("envelope source rules and malformed data", () => {
  test("old reliable acknowledgement clamps at source64-command threshold and duplicate commands disappear", () => {
    const ctx = { ...context(), reliableSequence: 100, serverCommandSequence: 7 };
    const operations: ServerOperation[] = [{ kind: "command", sequence: 6, text: "old" }, { kind: "command", sequence: 7, text: "duplicate" }, { kind: "command", sequence: 8, text: "new%" }, { kind: "nop" }];
    const result = decodeServerMessage(encodeServerMessage(35, operations, ctx), ctx);
    expect(result.reliableAcknowledge).toBe(100);
    expect(result.operations).toEqual([{ kind: "command", sequence: 8, text: "new." }, { kind: "nop" }]);
    expect(decodeServerMessage(encodeServerMessage(36, [], ctx), ctx).reliableAcknowledge).toBe(36);
  });

  test("server download error is terminal and does not require a following EOF", () => {
    const writer = new MessageWriter();
    writer.writeLong(3); writer.writeByte(ServerOpcode.Download); writer.writeShort(0); writer.writeLong(-1); writer.writeString("missing file");
    const result = decodeServerMessage(writer.toBytes(), context());
    expect(result.terminal).toBe("download-error");
    expect(result.operations).toEqual([{ kind: "download", block: { kind: "error", fileSize: -1, message: "missing file" } }]);
    expect(() => encodeServerMessage(3, [...result.operations, { kind: "nop" }], context())).toThrow("terminal");
  });

  test("unknown opcodes, illegal outer configstrings and every truncated native fixture reject", () => {
    for (const opcode of [0, 3, 4, 9, 255]) {
      const writer = new MessageWriter(); writer.writeLong(3); writer.writeByte(opcode);
      expect(() => decodeServerMessage(writer.toBytes(), context())).toThrow("opcode");
    }
    for (const hex of [GAMESTATE, FULL, DOWNLOAD]) {
      const bytes = Buffer.from(hex, "hex");
      for (let size = 0; size < bytes.length; size++) expect(() => decodeServerMessage(bytes.subarray(0, size), context())).toThrow();
    }
  });

  test("bounds reject invalid configstrings, area masks and download lengths", () => {
    const config = new MessageWriter();
    config.writeLong(0); config.writeByte(ServerOpcode.Gamestate); config.writeLong(0); config.writeByte(ServerOpcode.Configstring); config.writeShort(1024);
    expect(() => decodeServerMessage(config.toBytes(), context())).toThrow("configstring index");
    const area = new MessageWriter();
    area.writeLong(0); area.writeByte(ServerOpcode.Snapshot); area.writeLong(1); area.writeByte(0); area.writeByte(0); area.writeByte(33);
    expect(() => decodeServerMessage(area.toBytes(), context())).toThrow("area mask");
    for (const length of [-1, 16385]) {
      const writer = new MessageWriter(); writer.writeLong(0); writer.writeByte(ServerOpcode.Download); writer.writeShort(1); writer.writeShort(length);
      expect(() => decodeServerMessage(writer.toBytes(), context())).toThrow("block length");
    }
  });

  test("duplicate and decreasing packet entities retain the source append order", () => {
    for (const second of [1, 2]) {
      const writer = new MessageWriter();
      writer.writeLong(0); writer.writeByte(ServerOpcode.Snapshot); writer.writeLong(1); writer.writeByte(0); writer.writeByte(0); writer.writeByte(0);
      writeDeltaPlayerState(writer, null, new PlayerState("baseq3"));
      const entity = new EntityState(); entity.number = 2;
      writeDeltaEntity(writer, null, entity, true); entity.number = second; writeDeltaEntity(writer, null, entity, true);
      writer.writeBits(1023, 10); writer.writeByte(ServerOpcode.Eof);
      const decoded = decodeServerMessage(writer.toBytes(), context());
      const result = decoded.operations[0];
      if (result?.kind !== "snapshot") throw new Error("Missing source-order snapshot");
      expect(result.snapshot.entities.map(value => value.number)).toEqual([2, second]);
      expect(decoded.parseEntitiesNumber).toBe(2);
    }
  });

  test("gamestate string accounting includes repeated definitions", () => {
    const writer = new MessageWriter(); writer.writeLong(0); writer.writeByte(ServerOpcode.Gamestate); writer.writeLong(0);
    for (let i = 0; i < 2; i++) { writer.writeByte(ServerOpcode.Configstring); writer.writeShort(0); writer.writeBigString("0".repeat(7999)); }
    expect(writer.overflowed).toBe(false);
    expect(() => decodeServerMessage(writer.toBytes(), context())).toThrow("string storage");
    const duplicate = gamestate();
    const operations: ServerOperation[] = [{ ...duplicate, entries: [{ kind: "configstring", index: 0, value: "a" }, { kind: "configstring", index: 0, value: "b" }] }];
    expect(decodeServerMessage(encodeServerMessage(3, operations, context()), context()).operations).toEqual(operations);
  });

  test("writer checks source caps, missing history and sorted entities", () => {
    expect(() => encodeServerMessage(3, [{ kind: "download", block: { kind: "chunk", number: 1, data: new Uint8Array(2049) } }], context())).toThrow("2048");
    expect(() => encodeServerMessage(3, [{ kind: "command", sequence: 7, text: "a".repeat(1024) }], context())).toThrow("MAX_STRING");
    expect(() => encodeServerMessage(3, [snapshotOperation(deltaSnapshot())], context(11))).toThrow("baseline");
    const full = fullSnapshot();
    expect(() => encodeServerMessage(3, [snapshotOperation({ ...full, entities: [...full.entities].reverse() })], context())).toThrow("sorted");
    expect(() => encodeServerMessage(3, [snapshotOperation({ ...full, areaMask: new Uint8Array(33) })], context())).toThrow("area mask");
  });
});

describe("source cl_shownet parse diagnostics", () => {
  test("packet size precedes acknowledgement and includes the source transport prefix", () => {
    const bytes = encodeServerMessage(3, [{ kind: "nop" }], context());
    for (const offset of [0, 4]) {
      const printed: string[] = [];
      const cursor = new ServerMessageCursor(bytes, "<shownet>", { shownet: () => 1, print: text => { printed.push(text); } }, offset);
      expect(printed).toEqual([]);
      expect(cursor.next(context())).toEqual({ kind: "acknowledge", sequence: 3 });
      expect(printed).toEqual([`${bytes.length + offset} `]);
      expect(cursor.next(context())).toEqual({ kind: "operation", operation: { kind: "nop" } });
      expect(cursor.next(context())).toEqual({ kind: "end", terminal: "eof" });
      expect(printed).toEqual([`${bytes.length + offset} `]);
    }
  });

  test("opcode and EOF lines use source offsets and sample live shownet at each site", () => {
    const bytes = encodeServerMessage(0, [{ kind: "nop" }], context());
    let shownet = 2;
    const printed: string[] = [];
    const cursor = new ServerMessageCursor(bytes, "<shownet>", { shownet: () => shownet, print: text => { printed.push(text); } }, 4);
    cursor.next(context());
    cursor.next(context());
    cursor.next(context());
    expect(printed).toEqual(["------------------\n", "  5:svc_nop\n", "  6:END OF MESSAGE\n"]);
    printed.length = 0;
    const live = new ServerMessageCursor(bytes, "<shownet>", { shownet: () => shownet, print: text => { printed.push(text); } }, 4);
    live.next(context());
    shownet = 0;
    live.next(context());
    shownet = 3;
    live.next(context());
    expect(printed).toEqual(["------------------\n", "  6:END OF MESSAGE\n"]);
  });

  test("invalid delta output occurs before reading the missing snapshot body", () => {
    const old = fullSnapshot();
    const cases: readonly [ServerMessageContext, string][] = [
      [context(11), "Delta from invalid frame (not supposed to happen!).\n"],
      [context(11, { status: "invalid", snapshot: old }), "Delta from invalid frame (not supposed to happen!).\n"],
      [context(11, { status: "valid", snapshot: { ...old, messageNumber: 9 } }), "Delta frame too old.\n"],
      [{ ...context(11, { status: "valid", snapshot: old }), parseEntitiesNumber: 1921 }, "Delta parseEntitiesNum too old.\n"],
    ];
    for (const [ctx, expected] of cases) {
      const writer = new MessageWriter();
      writer.writeLong(0); writer.writeByte(ServerOpcode.Snapshot); writer.writeLong(1050); writer.writeByte(1); writer.writeByte(0);
      const printed: string[] = [];
      const cursor = new ServerMessageCursor(writer.toBytes(), "<shownet>", { shownet: () => 0, print: text => { printed.push(text); } });
      cursor.next(ctx);
      expect(cursor.next(ctx)).toEqual({ kind: "snapshot-header", deltaNumber: 10 });
      expect(printed).toEqual([]);
      expect(() => cursor.next(ctx)).toThrow();
      expect(printed).toEqual([expected]);
    }
  });

  test("packet entity merge diagnostics preserve unchanged, baseline and delta order", () => {
    const ctx = context(11, { status: "valid", snapshot: fullSnapshot() });
    const printed: string[] = [];
    const cursor = new ServerMessageCursor(Buffer.from(DELTA, "hex"), "<shownet>", { shownet: () => 3, print: text => { printed.push(text); } });
    cursor.next(ctx);
    cursor.next(ctx);
    const step = cursor.next(ctx);
    expect(step.kind).toBe("operation");
    // CL_ParsePacketEntities prints readcount; SHOWNET above prints readcount - 1.
    expect(printed.filter(text => text.includes(":  "))).toEqual([
      " 13:  unchanged: 1\n", " 13:  baseline: 2\n", " 21:  delta: 3\n",
    ]);
    expect(printed.some(text => text.endsWith(":playerstate\n"))).toBe(true);
    expect(printed.some(text => text.endsWith(":packet entities\n"))).toBe(true);
  });
});

describe("retained source packet entity writes", () => {
  test("descending records merge against reached old cells and retain duplicate unchanged entities", () => {
    const old = { ...fullSnapshot(), entities: [5, 2, 5, 8].map(number => {
      const entity = new EntityState(); entity.number = number; return entity;
    }) };
    const ring = new SourceParseEntities();
    for (const [index, entity] of old.entities.entries()) {
      ring.at(index).copyFrom(entity); ring.at(index).modelindex = (index + 1) * 11;
      ring.advance();
    }
    const baseline = (number: number): EntityState => {
      const entity = new EntityState(); entity.number = number; entity.modelindex = number * 101; return entity;
    };
    const ctx = { ...context(11, { status: "valid", snapshot: old }), baseline };
    const writer = new MessageWriter();
    writer.writeLong(3); writer.writeByte(ServerOpcode.Snapshot); writer.writeLong(1050);
    writer.writeByte(1); writer.writeByte(0); writer.writeByte(0);
    writeDeltaPlayerState(writer, old.playerState, old.playerState);
    writeDeltaEntity(writer, ring.at(0), ring.at(0), true);
    writeDeltaEntity(writer, baseline(1), baseline(1), true);
    writeDeltaEntity(writer, baseline(3), baseline(3), true);
    writeDeltaEntity(writer, ring.at(3), null);
    writer.writeBits(1023, 10);
    writer.writeByte(ServerOpcode.Command); writer.writeLong(8); writer.writeString("after snapshot");
    writer.writeByte(ServerOpcode.Eof);
    const reached: string[] = [];
    const cursor = new ServerMessageCursor(writer.toBytes(), "<source-merge>", {
      shownet: () => 3,
      print: text => {
        const separator = text.indexOf(":  ");
        if (separator !== -1) reached.push(`${ring.number} ${text.slice(separator + 3).trim()}`);
      },
    }, 0, ring);
    cursor.next(ctx); cursor.next(ctx);
    const step = cursor.next(ctx);
    if (step.kind !== "operation" || step.operation.kind !== "snapshot") throw new Error("Missing source merge");
    expect(reached).toEqual(["4 delta: 5", "5 baseline: 1", "6 unchanged: 2", "7 baseline: 3", "8 unchanged: 5", "9 delta: 8"]);
    expect(step.operation.snapshot.entities.map(entity => [entity.number, entity.modelindex]))
      .toEqual([[5, 11], [1, 101], [2, 22], [3, 303], [5, 33]]);
    expect(step.operation.snapshot.parseEntitiesNumber).toBe(4);
    expect(ring.number).toBe(9); expect(ring.at(9).number).toBe(1023);
    expect(cursor.next(ctx)).toEqual({ kind: "operation", operation: { kind: "command", sequence: 8, text: "after snapshot" } });
    expect(cursor.next(ctx)).toEqual({ kind: "end", terminal: "eof" });
    ring.at(4).modelindex = 99;
    expect(step.operation.snapshot.entities[0]?.modelindex).toBe(11);
    const detached = decodeServerMessage(writer.toBytes(), ctx).operations[0];
    if (detached?.kind !== "snapshot") throw new Error("Missing detached source merge");
    expect(detached.snapshot.entities.map(entity => [entity.number, entity.modelindex]))
      .toEqual([[5, 0], [1, 101], [2, 0], [3, 303], [5, 0]]);
  });

  test("packet entity count is independent of the entity-number sentinel", () => {
    const writer = new MessageWriter();
    writer.writeLong(3); writer.writeByte(ServerOpcode.Snapshot); writer.writeLong(1000);
    writer.writeByte(0); writer.writeByte(0); writer.writeByte(0);
    writeDeltaPlayerState(writer, null, new PlayerState("baseq3"));
    const entity = new EntityState();
    for (let index = 0; index < 1024; index++) {
      entity.number = index % 2 === 0 ? 1022 : 0;
      writeDeltaEntity(writer, null, entity, true);
    }
    writer.writeBits(1023, 10); writer.writeByte(ServerOpcode.Eof);
    const decoded = decodeServerMessage(writer.toBytes(), context());
    const operation = decoded.operations[0];
    if (operation?.kind !== "snapshot") throw new Error("Missing repeated-entity snapshot");
    expect(operation.snapshot.entities.length).toBe(1024);
    expect(operation.snapshot.entities.map(value => value.number)).toEqual(Array.from({ length: 1024 }, (_, index) => index % 2 === 0 ? 1022 : 0));
    expect(decoded.parseEntitiesNumber).toBe(1024);
  });

  test("delta merge reads retained cells, advances per accepted entity and keeps removal in the next cell", () => {
    const old = fullSnapshot();
    const ring = new SourceParseEntities();
    for (const entity of old.entities) { ring.at(ring.number).copyFrom(entity); ring.advance(); }
    ring.at(0).eType = 9;
    const counts: number[] = [];
    const ctx = context(11, { status: "valid", snapshot: old });
    const cursor = new ServerMessageCursor(Buffer.from(DELTA, "hex"), "<retained>", {
      shownet: () => 3,
      print: text => { if (text.includes(":  ")) counts.push(ring.number); },
    }, 4, ring);
    cursor.next(ctx); cursor.next(ctx);
    const step = cursor.next(ctx);
    if (step.kind !== "operation" || step.operation.kind !== "snapshot") throw new Error("Missing retained snapshot");
    expect(counts).toEqual([2, 3, 4]);
    expect(ring.number).toBe(4);
    expect([ring.at(2).number, ring.at(2).eType, ring.at(3).number, ring.at(4).number]).toEqual([1, 9, 2, 1023]);
    expect(step.operation.snapshot.parseEntitiesNumber).toBe(2);
    const first = step.operation.snapshot.entities[0];
    if (first === undefined) throw new Error("Missing unchanged entity");
    expect(first.eType).toBe(9);
    expect(first).not.toBe(ring.at(2));
    ring.at(2).eType = 12;
    expect(first.eType).toBe(9);
    expect(old.entities[0]?.eType).toBe(1);
  });

  test("a diagnostic abort on the second entity retains the first raw write and count", () => {
    const first = new EntityStateRecord<number>(0); first.number = 1; first.eType = 1;
    first.pos = { ...first.pos, type: 201 }; first.apos = { ...first.apos, type: 255 };
    const second = new EntityStateRecord<number>(0); second.number = 2; second.eType = 2;
    second.pos = { ...second.pos, type: 202 };
    const bytes = encodeServerMessage(3, [snapshotOperation({ ...fullSnapshot(), entities: [first, second] })], context());
    const ring = new SourceParseEntities();
    const firstCell = ring.at(0), secondCell = ring.at(1);
    firstCell.number = 100; secondCell.number = 101; secondCell.pos = { ...secondCell.pos, type: -999 };
    const cursor = new ServerMessageCursor(bytes, "<retained>", {
      shownet: () => 2,
      print: text => { if (text.includes("#101 ")) throw new Error("stop second entity"); },
    }, 0, ring);
    cursor.next(context()); cursor.next(context());
    expect(() => cursor.next(context())).toThrow("stop second entity");
    expect(ring.number).toBe(1);
    expect(ring.at(0)).toBe(firstCell);
    expect(ring.at(1)).toBe(secondCell);
    expect([firstCell.number, firstCell.eType, secondCell.number]).toEqual([1, 1, 101]);
    expect([firstCell.pos.type, firstCell.apos.type, secondCell.pos.type]).toEqual([201, 255, -999]);
  });

  test("packet entity entry samples the retained count and old-frame metadata after diagnostics", () => {
    const old = { ...fullSnapshot() };
    const ring = new SourceParseEntities();
    for (const [index, entity] of old.entities.entries()) ring.at(index).copyFrom(entity);
    ring.at(2).copyFrom(ring.at(0)); ring.at(2).eType = 9;
    ring.at(3).copyFrom(ring.at(1)); ring.number = 2;
    const ctx = context(11, { status: "valid", snapshot: old });
    const cursor = new ServerMessageCursor(Buffer.from(DELTA, "hex"), "<retained>", {
      shownet: () => 2,
      print: text => {
        if (text.endsWith(":packet entities\n")) { ring.number = 4; old.parseEntitiesNumber = 2; }
      },
    }, 0, ring);
    cursor.next(ctx); cursor.next(ctx);
    const step = cursor.next(ctx);
    if (step.kind !== "operation" || step.operation.kind !== "snapshot") throw new Error("Missing retained snapshot");
    expect(step.operation.snapshot.parseEntitiesNumber).toBe(4);
    expect(step.operation.snapshot.entities[0]?.eType).toBe(9);
    expect(ring.number).toBe(6);
  });

  test("repeated gamestate baselines mutate the retained destination and publish detached records", () => {
    const first = new EntityStateRecord<number>(0); first.copyFrom(baseline());
    first.pos = { ...first.pos, type: 201 };
    const second = first.copy(); second.eType = 4; second.modelindex = 9;
    second.apos = { ...second.apos, type: 255 };
    const gamestateValue: Gamestate = { ...gamestate(), entries: [
      { kind: "baseline", number: 3, entity: first }, { kind: "baseline", number: 3, entity: second },
    ] };
    const target: EntityStateFields = { ...new EntityStateRecord<number>(0) };
    const ctx = { ...context(), baseline: (number: number) => number === 3 ? target : null };
    const printed: string[] = [];
    const cursor = new ServerMessageCursor(encodeServerMessage(3, [gamestateValue], context()), "<retained>", {
      shownet: () => 2,
      print: text => { if (text.includes("#")) printed.push(text); },
    });
    cursor.next(ctx); cursor.next(ctx); cursor.next(ctx);
    const firstStep = cursor.next(ctx);
    if (firstStep.kind !== "gamestate-entry" || firstStep.entry.kind !== "baseline") throw new Error("Missing first baseline");
    expect(target).toEqual(first);
    const secondStep = cursor.next(ctx);
    if (secondStep.kind !== "gamestate-entry" || secondStep.entry.kind !== "baseline") throw new Error("Missing second baseline");
    expect(target).toEqual(second);
    expect(firstStep.entry.entity).toEqual(first);
    expect(firstStep.entry.entity).not.toBe(target);
    expect(printed.map(text => text.slice(text.indexOf("#")))).toEqual(["#0   ", "#3   "]);
  });
});
