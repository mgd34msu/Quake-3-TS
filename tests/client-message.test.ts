import { describe, expect, test } from "bun:test";
import { ClientMessageReader, ClientOpcode, InvalidClientCommandCountError, InvalidClientOpcodeError, commandHash, decodeClientMessage, encodeClientMessage, filterClientMovement } from "../src/protocol/client-message.ts";
import type { ClientDecodeContext, ClientMessage, DecodedClientMessage } from "../src/protocol/client-message.ts";
import { MessageWriter } from "../src/protocol/message.ts";
import type { WireUserCommand } from "../src/protocol/message.ts";

// Untouched CL_WritePacket and Com_HashKey at dbe4ddb, with only transport replaced
// by an output collector that appends the source CL_Netchan_Transmit clc_EOF.
const MOVE = "736a5afdd550b60acc831da13004cdde59585ed6d050358f27fce6609898b32291926c9df7b853c72d4e3617f76e6279ccb809676f8800";
const NO_DELTA = "736a5afdd550b60acc831da13004cdde59585ed6d050358f27fce6609898b3b291926c9df7b853c72d4e3617f76e6279ccb809676f8800";
const COMMANDS = "736a5afdd550b60acc831da13004cdde59585ed6d050358f27fce6609898b34600";
const EMPTY = "736a5afdd508";
const header = { serverId: 123, messageAcknowledge: 10, reliableAcknowledge: 7 };
const context: ClientDecodeContext = { checksumFeed: 0x12345678, reliableSequence: 7, lastClientCommand: 2, lastUserCommandTime: 0,
  serverCommand: (sequence) => { if (sequence !== 7) throw new Error("Unexpected server command lookup"); return "print hello"; } };

function fixture(): ClientMessage {
  const first: WireUserCommand = { serverTime: 1000, angles: [100, 200, 0], forwardmove: 127, rightmove: 0, upmove: 0, buttons: 1, weapon: 5 };
  const second: WireUserCommand = { ...first, serverTime: 1017, angles: [120, 200, 0], forwardmove: -127, rightmove: 30 };
  return { header, commands: [{ sequence: 3, text: "userinfo test" }, { sequence: 4, text: "say hello" }], movement: { kind: "move", commands: [first, second] } };
}

function rawHeader(writer: MessageWriter, messageAcknowledge = 10, reliableAcknowledge = 7): void {
  writer.writeLong(123); writer.writeLong(messageAcknowledge); writer.writeLong(reliableAcknowledge);
}

describe("native client packet fixtures", () => {
  test("source stale-ack backup slots retain signed command sequences through the writer", () => {
    const commands = Array.from({ length: 64 }, (_, index) => ({ sequence: index - 63, text: "" }));
    const message: ClientMessage = { header, commands, movement: null };
    const bytes = encodeClientMessage(message, context);
    const reader = new ClientMessageReader(bytes);
    expect(reader.readHeader()).toEqual(header);
    for (let index = -63; index <= 0; index++) {
      expect(reader.next()).toEqual({ kind: "command", command: { sequence: index, text: "" } });
    }
    expect(reader.next()).toEqual({ kind: "eof" });
    for (const sequence of [-2147483649, 2147483648, -0.5]) {
      expect(() => encodeClientMessage({ ...message, commands: [{ sequence, text: "" }] }, context)).toThrow("int32 sequences");
    }
    expect(() => encodeClientMessage({ ...message, commands: [{ sequence: -1, text: "" }, { sequence: -2, text: "" }] }, context)).toThrow("increasing");
  });

  test("Com_HashKey matches C including signed char and32-byte limit", () => {
    expect(commandHash("")).toBe(0);
    expect(commandHash("a")).toBe(11548);
    expect(commandHash("print hello")).toBe(138829);
    expect(commandHash("a\x80\xff")).toBe(-3939);
    expect(commandHash("abcdefghijklmnopqrstuvwxyz0123456789")).toBe(420691);
    expect(commandHash("a\0ignored")).toBe(11548);
    expect(commandHash("a", 0)).toBe(0);
    expect(() => commandHash("\u1234")).toThrow("byte string");
  });

  test("client reliable commands and two keyed usercmds match CL_WritePacket", () => {
    const message = fixture();
    expect(Buffer.from(encodeClientMessage(message, context)).toString("hex")).toBe(MOVE);
    const decoded = decodeClientMessage(Buffer.from(MOVE, "hex"), context);
    if (decoded.kind !== "accepted" || decoded.movement === null || message.movement === null) throw new Error("Missing fixture movement");
    expect(decoded.header).toEqual(header);
    expect(decoded.commands).toEqual(message.commands);
    expect(decoded.lastClientCommand).toBe(4);
    expect(decoded.movement.commands).toEqual(message.movement.commands);
    expect(decoded.movement.executableCommands).toEqual(message.movement.commands);
    expect(decoded.movement.deltaMessage).toBe(10);
    expect(decoded.movement.lastUserCommandTime).toBe(1017);
  });

  test("moveNoDelta differs by the source opcode and disables snapshot delta request", () => {
    const message = fixture();
    if (message.movement === null) throw new Error("Missing fixture movement");
    expect(Buffer.from(encodeClientMessage({ ...message, movement: { ...message.movement, kind: "move-no-delta" } }, context)).toString("hex")).toBe(NO_DELTA);
    const decoded = decodeClientMessage(Buffer.from(NO_DELTA, "hex"), context);
    if (decoded.kind !== "accepted" || decoded.movement === null) throw new Error("Missing decoded movement");
    expect(decoded.movement.kind).toBe("move-no-delta");
    expect(decoded.movement.deltaMessage).toBe(-1);
  });

  test("command-only and empty packet match native bytes without requiring hash lookup", () => {
    const noLookup = { ...context, serverCommand: (): string => { throw new Error("Unexpected hash lookup"); } };
    expect(Buffer.from(encodeClientMessage({ ...fixture(), movement: null }, noLookup)).toString("hex")).toBe(COMMANDS);
    expect(Buffer.from(encodeClientMessage({ header, commands: [], movement: null }, noLookup)).toString("hex")).toBe(EMPTY);
    const decoded = decodeClientMessage(Buffer.from(EMPTY, "hex"), noLookup);
    expect(decoded).toEqual({ kind: "accepted", header, commands: [], lastClientCommand: 2, movement: null });
  });
});

describe("backup filtering and reliable replay", () => {
  test("already executed backup times disappear only from executable commands", () => {
    const decoded = decodeClientMessage(Buffer.from(MOVE, "hex"), { ...context, lastClientCommand: 4, lastUserCommandTime: 1000 });
    if (decoded.kind !== "accepted" || decoded.movement === null) throw new Error("Missing decoded movement");
    expect(decoded.commands).toEqual([]);
    expect(decoded.movement.commands.length).toBe(2);
    expect(decoded.movement.executableCommands.map((command) => command.serverTime)).toEqual([1017]);
    const replay = decodeClientMessage(Buffer.from(MOVE, "hex"), { ...context, lastClientCommand: 4, lastUserCommandTime: 1017 });
    if (replay.kind !== "accepted" || replay.movement === null) throw new Error("Missing replay movement");
    expect(replay.movement.executableCommands).toEqual([]);
  });

  test("source map-restart upper time guard and running last-time filter preserve order", () => {
    for (const times of [[1200, 1000], [1000, 900, 1100]]) {
      const writer = new MessageWriter(); rawHeader(writer);
      writer.writeByte(ClientOpcode.Move); writer.writeByte(times.length);
      for (const time of times) { writer.writeBits(0, 1); writer.writeLong(time); writer.writeBits(0, 1); }
      writer.writeByte(ClientOpcode.Eof);
      const result = decodeClientMessage(writer.toBytes(), { ...context, lastUserCommandTime: 950 });
      if (result.kind !== "accepted" || result.movement === null) throw new Error("Missing decoded movement");
      expect(result.movement.commands.map((command) => command.serverTime)).toEqual(times);
      expect(result.movement.executableCommands.map((command) => command.serverTime)).toEqual(times.length === 2 ? [1000] : [1000, 1100]);
    }
  });

  test("lost reliable command rejects subsequent movement but retains valid preceding commands", () => {
    const writer = new MessageWriter(); rawHeader(writer);
    for (const sequence of [3, 5]) { writer.writeByte(ClientOpcode.Command); writer.writeLong(sequence); writer.writeString(`command${sequence}`); }
    const decoded = decodeClientMessage(writer.toBytes(), { ...context, serverCommand: (): string => { throw new Error("Must not decode movement after command loss"); } });
    expect(decoded).toEqual({ kind: "rejected", header, commands: [{ sequence: 3, text: "command3" }], lastClientCommand: 3, reason: "lost-reliable-command" });
  });

  test("1 and32 command boundaries, consecutive delta chain and independent executable copies", () => {
    for (const count of [1, 32]) {
      const commands: WireUserCommand[] = Array.from({ length: count }, (_, index) => ({ serverTime: 1000 + index * 10, angles: [0, 0, 0], forwardmove: index, rightmove: 0, upmove: 0, buttons: 0, weapon: 0 }));
      const message: ClientMessage = { header, commands: [], movement: { kind: "move", commands } };
      const bytes = encodeClientMessage(message, context);
      const decoded = decodeClientMessage(bytes, context);
      bytes.fill(0);
      if (decoded.kind !== "accepted" || decoded.movement === null) throw new Error("Missing decoded movement");
      expect(decoded.movement.commands).toEqual(commands);
      expect(decoded.movement.executableCommands).toEqual(commands);
      expect(decoded.movement.commands[0]).not.toBe(decoded.movement.executableCommands[0]);
      expect(decoded.movement.commands[0]?.angles).not.toBe(decoded.movement.executableCommands[0]?.angles);
    }
  });
});

describe("client message boundaries", () => {
  test("negative/future acknowledgements reject, stale acknowledgement resets to server sequence", () => {
    const cases: readonly [number, number, number, Extract<DecodedClientMessage, { kind: "rejected" }>["reason"], number][] = [[-1, 7, 7, "negative-message-acknowledge", 7], [10, -1, 7, "negative-reliable-acknowledge", -1], [10, 8, 7, "future-reliable-acknowledge", 8], [10, 35, 100, "stale-reliable-acknowledge", 100]];
    for (const [messageAck, reliableAck, sequence, reason, expectedAck] of cases) {
      const writer = new MessageWriter(); rawHeader(writer, messageAck, reliableAck);
      const result = decodeClientMessage(writer.toBytes(), { ...context, reliableSequence: sequence });
      if (result.kind !== "rejected") throw new Error("Expected rejected header");
      expect(result.reason).toBe(reason);
      expect(result.header.reliableAcknowledge).toBe(expectedAck);
    }
    const writer = new MessageWriter(); rawHeader(writer, 10, 36); writer.writeByte(ClientOpcode.Eof);
    expect(decodeClientMessage(writer.toBytes(), { ...context, reliableSequence: 100 }).kind).toBe("accepted");
  });

  test("invalid counts and terminal opcodes fail explicitly", () => {
    for (const count of [0, 33, 255]) {
      const writer = new MessageWriter(); rawHeader(writer); writer.writeByte(ClientOpcode.Move); writer.writeByte(count);
      expect(() => decodeClientMessage(writer.toBytes(), context)).toThrow("count");
    }
    for (const opcode of [0, 1, 6, 255]) {
      const writer = new MessageWriter(); rawHeader(writer); writer.writeByte(opcode);
      expect(() => decodeClientMessage(writer.toBytes(), context)).toThrow("opcode");
    }
    const writer = new MessageWriter(); rawHeader(writer); writer.writeByte(ClientOpcode.Move); writer.writeByte(1);
    writer.writeBits(0, 1); writer.writeLong(1000); writer.writeBits(0, 1); writer.writeByte(ClientOpcode.Command);
    expect(() => decodeClientMessage(writer.toBytes(), context)).toThrow("terminal");
  });

  test("every truncated native packet rejects", () => {
    for (const hex of [MOVE, NO_DELTA, COMMANDS, EMPTY]) {
      const bytes = Buffer.from(hex, "hex");
      for (let length = 0; length < bytes.length; length++) expect(() => decodeClientMessage(bytes.subarray(0, length), context)).toThrow();
    }
  });

  test("writer validates acknowledgements, command order and movement caps", () => {
    const message = fixture();
    for (const acknowledge of [-1, 0x80000000, 0.5]) expect(() => encodeClientMessage({ ...message, header: { ...header, messageAcknowledge: acknowledge } }, context)).toThrow("acknowledgements");
    expect(() => encodeClientMessage({ ...message, commands: [{ sequence: 3, text: "first" }, { sequence: 3, text: "duplicate" }] }, context)).toThrow("increasing");
    for (const count of [0, 33]) {
      const commands: WireUserCommand[] = Array.from({ length: count }, () => ({ serverTime: 1, angles: [0, 0, 0], forwardmove: 0, rightmove: 0, upmove: 0, buttons: 0, weapon: 0 }));
      expect(() => encodeClientMessage({ ...message, movement: { kind: "move", commands } }, context)).toThrow("1 through 32");
    }
  });
});

describe("incremental source server admission", () => {
  test("source bad-opcode and bad-count diagnostics have narrow typed payloads", () => {
    const badOpcode = new MessageWriter(); rawHeader(badOpcode); badOpcode.writeByte(6);
    const opcodeReader = new ClientMessageReader(badOpcode.toBytes(), "opcode-fixture"); opcodeReader.readHeader();
    try { opcodeReader.next(); throw new Error("Expected invalid opcode"); } catch (error: unknown) {
      expect(error instanceof InvalidClientOpcodeError).toBe(true);
      if (error instanceof InvalidClientOpcodeError) { expect(error.opcode).toBe(6); expect(error.message).toContain("opcode-fixture"); }
    }
    for (const count of [0, 33, 255]) {
      const writer = new MessageWriter(); rawHeader(writer); writer.writeByte(ClientOpcode.Move); writer.writeByte(count);
      const reader = new ClientMessageReader(writer.toBytes()); reader.readHeader(); reader.next();
      try { reader.readMovement(context); throw new Error("Expected invalid count"); } catch (error: unknown) {
        expect(error instanceof InvalidClientCommandCountError).toBe(true);
        if (error instanceof InvalidClientCommandCountError) expect(error.count).toBe(count);
      }
    }
  });

  test("negative message acknowledgement returns before an absent third header long", () => {
    const writer = new MessageWriter(); writer.writeLong(123); writer.writeLong(-1);
    const reader = new ClientMessageReader(writer.toBytes());
    expect(reader.prefix).toEqual({ serverId: 123, messageAcknowledge: -1 });
    // SV_ExecuteClientMessage returns here. No reliable acknowledgement or opcode exists.
    expect(reader.prefix.messageAcknowledge < 0).toBe(true);
    expect(() => reader.readHeader()).toThrow("truncated");
    expect(() => reader.readHeader()).toThrow("failed");
  });

  test("source header policies can stop before malformed payload without convenience hardening", () => {
    for (const reliableAcknowledge of [-1, 8, 35]) {
      const writer = new MessageWriter(); rawHeader(writer, 10, reliableAcknowledge); writer.writeByte(ClientOpcode.Move); writer.writeByte(255);
      const reader = new ClientMessageReader(writer.toBytes());
      const decoded = reader.readHeader();
      expect(decoded).toEqual({ ...header, reliableAcknowledge });
      // Source applies only its stale-window check here, not the codec wrapper's
      // additional negative/future-ack rules. Server-id admission follows it.
      const reliableSequence = reliableAcknowledge === 35 ? 100 : 7;
      const sourceReliableAck = decoded.reliableAcknowledge < reliableSequence - 64 ? reliableSequence : decoded.reliableAcknowledge;
      expect(sourceReliableAck).toBe(reliableAcknowledge === 35 ? 100 : reliableAcknowledge);
      expect(decoded.serverId !== 124).toBe(true);
      const beforeMovement = reader.readCount;
      expect(reader.next()).toEqual({ kind: "movement", movementKind: "move", deltaMessage: 10 });
      expect(reader.readCount).toBeGreaterThanOrEqual(beforeMovement);
      expect(() => reader.readMovement({ ...context, serverCommand: () => { throw new Error("Lookup must follow valid count"); } })).toThrow("count");
    }
  });

  test("stale serverId and stale reliable acknowledgement admission never request a malformed movement body", () => {
    function admit(bytes: Uint8Array, serverId: number, reliableSequence: number): string {
      const reader = new ClientMessageReader(bytes);
      if (reader.prefix.messageAcknowledge < 0) return "negative-message-ack";
      const decoded = reader.readHeader();
      if (decoded.reliableAcknowledge < reliableSequence - 64) return "stale-reliable-ack";
      if (decoded.serverId !== serverId) return "outdated-server";
      const part = reader.next();
      if (part.kind === "movement") reader.readMovement(context);
      return "parsed";
    }
    const writer = new MessageWriter(); rawHeader(writer); writer.writeByte(ClientOpcode.Move); writer.writeByte(255);
    expect(admit(writer.toBytes(), 124, 7)).toBe("outdated-server");
    expect(admit(writer.toBytes(), 124, 100)).toBe("stale-reliable-ack");
    expect(() => admit(writer.toBytes(), 123, 7)).toThrow("count");
  });

  test("a reliable disconnect is available before the next malformed command or movement suffix", () => {
    for (const suffix of [ClientOpcode.Command, ClientOpcode.Move]) {
      const writer = new MessageWriter(); rawHeader(writer);
      writer.writeByte(ClientOpcode.Command); writer.writeLong(3); writer.writeString("disconnect");
      writer.writeByte(suffix);
      if (suffix === ClientOpcode.Move) writer.writeByte(255);
      const reader = new ClientMessageReader(writer.toBytes()); reader.readHeader();
      const command = reader.next(); expect(command).toEqual({ kind: "command", command: { sequence: 3, text: "disconnect" } });
      const executed: string[] = [];
      if (command.kind === "command") executed.push(command.command.text);
      expect(executed).toEqual(["disconnect"]);
      // A production caller returns for CS_ZOMBIE. Only an explicit further read fails.
      if (suffix === ClientOpcode.Command) expect(() => reader.next()).toThrow();
      else {
        expect(reader.next().kind).toBe("movement");
        expect(() => reader.readMovement(context)).toThrow("count");
      }
    }
  });

  test("reliable replay/loss information is exposed without pre-reading the following opcode", () => {
    const writer = new MessageWriter(); rawHeader(writer);
    for (const sequence of [2, 3, 5]) { writer.writeByte(ClientOpcode.Command); writer.writeLong(sequence); writer.writeString(`command${sequence}`); }
    const reader = new ClientMessageReader(writer.toBytes()); reader.readHeader();
    const received: number[] = [], executed: string[] = []; let lastCommand = 2;
    for (let i = 0; i < 3; i++) {
      const part = reader.next(); if (part.kind !== "command") throw new Error("Missing reliable fixture command");
      received.push(part.command.sequence);
      if (part.command.sequence <= lastCommand) continue;
      if (part.command.sequence > lastCommand + 1) break;
      executed.push(part.command.text); lastCommand = part.command.sequence;
    }
    expect(received).toEqual([2, 3, 5]); expect(executed).toEqual(["command3"]); expect(lastCommand).toBe(3);
    expect(() => reader.next()).toThrow();
  });

  test("movement count and key lookup occur only after preceding reliable commands execute", () => {
    const bytes = Buffer.from(MOVE, "hex"), message = fixture();
    if (message.movement === null) throw new Error("Missing fixture movement");
    const reader = new ClientMessageReader(bytes); reader.readHeader(); bytes.fill(0);
    const calls: string[] = [];
    while (true) {
      const part = reader.next();
      if (part.kind === "command") { calls.push(`execute:${part.command.sequence}:${part.command.text}`); continue; }
      if (part.kind !== "movement") throw new Error("Missing movement fixture");
      expect(calls).toEqual(["execute:3:userinfo test", "execute:4:say hello"]);
      const movement = reader.readMovement({ checksumFeed: context.checksumFeed, serverCommand: sequence => {
        expect(calls.length).toBe(2); calls.push(`key:${sequence}`); return "print hello";
      } });
      expect([...movement.commands]).toEqual([...message.movement.commands]);
      expect(calls).toEqual(["execute:3:userinfo test", "execute:4:say hello", "key:7"]);
      reader.validateTerminal(); break;
    }
  });

  test("key material can change during reliable execution before movement decoding", () => {
    const message = fixture(), key = { checksumFeed: 99, serverCommand: () => "after cp" };
    const reader = new ClientMessageReader(encodeClientMessage(message, key)); reader.readHeader();
    let checksumFeed = 0, serverCommandText = "before cp";
    while (true) {
      const part = reader.next();
      if (part.kind === "command") { checksumFeed = key.checksumFeed; serverCommandText = key.serverCommand(); continue; }
      if (part.kind !== "movement") throw new Error("Missing movement fixture");
      const movement = reader.readMovement({ checksumFeed, serverCommand: () => serverCommandText });
      // Source MSG_ReadDeltaKey indexes kbitmask[16] == 0x1ffff, retaining
      // the key's seventeenth bit in int angles/buttons, not in byte fields.
      expect(movement.commands).toEqual([
        { serverTime: 1000, angles: [65636, 65736, 0], forwardmove: 127, rightmove: 0, upmove: 0, buttons: 65537, weapon: 5 },
        { serverTime: 1017, angles: [65656, 65736, 0], forwardmove: -127, rightmove: 30, upmove: 0, buttons: 65537, weapon: 5 },
      ]); reader.validateTerminal(); break;
    }
  });

  test("ClientEnterWorld seeds first backup before time filtering and output copies remain independent", () => {
    const reader = new ClientMessageReader(Buffer.from(MOVE, "hex")); reader.readHeader();
    while (reader.next().kind === "command") { /* Caller admits the two fixture commands. */ }
    const movement = reader.readMovement(context), first = movement.commands[0];
    if (first === undefined) throw new Error("Missing first command");
    expect(movement.commands.map(command => command.serverTime)).toEqual([1000, 1017]);
    const lastUsercmdAfterEnterWorld = { ...first, angles: [...first.angles] };
    const filtered = filterClientMovement(movement, lastUsercmdAfterEnterWorld.serverTime);
    expect(filtered.executableCommands.map(command => command.serverTime)).toEqual([1017]);
    expect(filtered.lastUserCommandTime).toBe(1017);
    expect(filterClientMovement(movement, 0).executableCommands.length).toBe(2);
    expect(filtered.commands[0]).not.toBe(movement.commands[0]);
    expect(filtered.commands[0]?.angles).not.toBe(movement.commands[0]?.angles);
    expect(filtered.commands[1]).not.toBe(filtered.executableCommands[0]);
    reader.validateTerminal();
  });

  test("terminal validation is optional after source movement and cannot run ahead of it", () => {
    for (const ending of ["missing", "invalid", "valid"]) {
      const writer = new MessageWriter(); rawHeader(writer); writer.writeByte(ClientOpcode.Move); writer.writeByte(1);
      writer.writeBits(0, 1); writer.writeLong(1000); writer.writeBits(0, 1);
      if (ending !== "missing") writer.writeByte(ending === "valid" ? ClientOpcode.Eof : ClientOpcode.Command);
      const reader = new ClientMessageReader(writer.toBytes()); reader.readHeader();
      expect(() => reader.validateTerminal()).toThrow("commands");
      expect(reader.next()).toEqual({ kind: "movement", movementKind: "move", deltaMessage: 10 });
      expect(() => reader.validateTerminal()).toThrow("movement");
      const movement = reader.readMovement(context);
      expect(movement.commands[0]?.serverTime).toBe(1000);
      if (ending === "valid") { reader.validateTerminal(); expect(() => reader.validateTerminal()).toThrow("done"); }
      else {
        expect(() => reader.validateTerminal()).toThrow();
        expect(() => reader.validateTerminal()).toThrow("failed");
        expect(() => decodeClientMessage(writer.toBytes(), context)).toThrow();
      }
    }
  });

  test("illegal repeated/out-of-order reads are rejected without silently advancing phases", () => {
    const reader = new ClientMessageReader(Buffer.from(MOVE, "hex"));
    expect(() => reader.next()).toThrow("header"); expect(() => reader.readMovement(context)).toThrow("header");
    reader.readHeader(); expect(() => reader.readHeader()).toThrow("commands");
    expect(() => reader.readMovement(context)).toThrow("commands");
    expect(reader.next().kind).toBe("command"); expect(reader.next().kind).toBe("command"); expect(reader.next().kind).toBe("movement");
    expect(() => reader.next()).toThrow("movement"); reader.readMovement(context);
    expect(() => reader.next()).toThrow("terminal"); expect(() => reader.readMovement(context)).toThrow("terminal");
    reader.validateTerminal(); expect(() => reader.next()).toThrow("done");
    const empty = new ClientMessageReader(Buffer.from(EMPTY, "hex")); empty.readHeader(); expect(empty.next()).toEqual({ kind: "eof" });
    expect(() => empty.next()).toThrow("done"); expect(() => empty.validateTerminal()).toThrow("done");
  });
});
