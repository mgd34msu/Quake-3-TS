// Port of id Software's CL_WritePacket, SV_ExecuteClientMessage, SV_UserMove and Com_HashKey.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import { MAX_MESSAGE_LENGTH, MessageReader, MessageWriter, readDeltaUserCommand, writeDeltaUserCommand } from "./message.ts";
import type { SourceMessageState, WireUserCommand } from "./message.ts";
import type { ReliableCommand } from "./reliable.ts";

export enum ClientOpcode { Nop = 1, Move = 2, MoveNoDelta = 3, Command = 4, Eof = 5 }
export const MAX_PACKET_USER_COMMANDS = 32;

export class InvalidClientOpcodeError extends BinaryError {
  constructor(source: string, offset: number, readonly opcode: number) {
    super(source, offset, `Invalid client opcode ${opcode}`);
    this.name = "InvalidClientOpcodeError";
  }
}

export class InvalidClientCommandCountError extends BinaryError {
  constructor(source: string, offset: number, readonly count: number) {
    super(source, offset, `Invalid user command count ${count}`);
    this.name = "InvalidClientCommandCountError";
  }
}

export interface ClientHeader {
  readonly serverId: number;
  readonly messageAcknowledge: number;
  readonly reliableAcknowledge: number;
}

export interface ClientMovement {
  readonly kind: "move" | "move-no-delta";
  readonly commands: readonly WireUserCommand[];
}

export interface ClientMessage {
  readonly header: ClientHeader;
  readonly commands: readonly ReliableCommand[];
  readonly movement: ClientMovement | null;
}

export interface ClientKeyContext {
  readonly checksumFeed: number;
  readonly serverCommand: (reliableAcknowledge: number) => string;
}

export interface ClientDecodeContext extends ClientKeyContext {
  readonly reliableSequence: number;
  readonly lastClientCommand: number;
  readonly lastUserCommandTime: number;
}

export interface DecodedClientMovement extends ClientMovement {
  readonly deltaMessage: number;
  readonly executableCommands: readonly WireUserCommand[];
  readonly lastUserCommandTime: number;
}

export interface UnfilteredClientMovement extends ClientMovement {
  readonly commands: readonly [WireUserCommand, ...WireUserCommand[]];
  readonly deltaMessage: number;
}

export type ClientMessagePart =
  | { readonly kind: "command"; readonly command: ReliableCommand }
  | { readonly kind: "movement"; readonly movementKind: ClientMovement["kind"]; readonly deltaMessage: number }
  | { readonly kind: "eof" };

type ClientReadPhase =
  | { readonly kind: "header" }
  | { readonly kind: "commands"; readonly header: ClientHeader }
  | { readonly kind: "movement"; readonly header: ClientHeader; readonly movementKind: ClientMovement["kind"] }
  | { readonly kind: "terminal" }
  | { readonly kind: "done" }
  | { readonly kind: "failed" };

export type DecodedClientMessage =
  | { readonly kind: "accepted"; readonly header: ClientHeader; readonly commands: readonly ReliableCommand[]; readonly lastClientCommand: number; readonly movement: DecodedClientMovement | null }
  | { readonly kind: "rejected"; readonly header: ClientHeader; readonly commands: readonly ReliableCommand[]; readonly lastClientCommand: number; readonly reason: "negative-message-acknowledge" | "negative-reliable-acknowledge" | "stale-reliable-acknowledge" | "future-reliable-acknowledge" | "lost-reliable-command" };

/** Source Com_HashKey uses signed char bytes and arithmetic shifts on the x86 baseline. */
export function commandHash(text: string, maxLength = 32): number {
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError("Invalid command hash length");
  let hash = 0;
  for (let i = 0; i < maxLength && i < text.length; i++) {
    const byte = text.charCodeAt(i);
    if (byte === 0) break;
    if (byte > 255) throw new RangeError("Command hash requires an engine byte string");
    hash = (hash + Math.imul((byte << 24) >> 24, 119 + i)) | 0;
  }
  return hash ^ (hash >> 10) ^ (hash >> 20);
}

function moveKey(header: ClientHeader, context: ClientKeyContext): number {
  return context.checksumFeed ^ header.messageAcknowledge ^ commandHash(context.serverCommand(header.reliableAcknowledge), 32);
}

function zeroCommand(): WireUserCommand {
  return { serverTime: 0, angles: [0, 0, 0], forwardmove: 0, rightmove: 0, upmove: 0, buttons: 0, weapon: 0 };
}

function copyCommand(command: WireUserCommand): WireUserCommand {
  return { ...command, angles: [...command.angles] };
}

/** CL_WritePacket prefix precedes packetdup clamping and movement diagnostics. */
export function beginClientMessage(header: ClientHeader, commands: readonly ReliableCommand[], sourceState: SourceMessageState | null = null): MessageWriter {
  if (!Number.isInteger(header.serverId) || header.serverId < -0x80000000 || header.serverId > 0x7fffffff) throw new RangeError("Client serverId must be int32");
  for (const acknowledge of [header.messageAcknowledge, header.reliableAcknowledge]) {
    if (!Number.isInteger(acknowledge) || acknowledge < 0 || acknowledge > 0x7fffffff) throw new RangeError("Client acknowledgements must be nonnegative int32 values");
  }
  const writer = new MessageWriter("bitstream", MAX_MESSAGE_LENGTH, sourceState);
  writer.writeLong(header.serverId);
  writer.writeLong(header.messageAcknowledge);
  writer.writeLong(header.reliableAcknowledge);
  let previousSequence: number | null = null;
  for (const command of commands) {
    if (!Number.isInteger(command.sequence) || command.sequence < -0x80000000 || command.sequence > 0x7fffffff
      || (previousSequence !== null && command.sequence <= previousSequence)) throw new RangeError("Client reliable commands must have increasing int32 sequences");
    writer.writeByte(ClientOpcode.Command); writer.writeLong(command.sequence); writer.writeString(command.text);
    previousSequence = command.sequence;
  }
  return writer;
}

export function writeClientMovement(writer: MessageWriter, movement: ClientMovement, header: ClientHeader, context: ClientKeyContext): void {
  const count = movement.commands.length;
  if (count < 1 || count > MAX_PACKET_USER_COMMANDS) throw new RangeError("Movement needs 1 through 32 backup commands");
  writer.writeByte(movement.kind === "move" ? ClientOpcode.Move : ClientOpcode.MoveNoDelta);
  writer.writeByte(count);
  const key = moveKey(header, context);
  let old = zeroCommand();
  for (const command of movement.commands) {
    writeDeltaUserCommand(writer, old, command, key);
    old = command;
  }
}

/** CL_Netchan_Transmit appends EOF after CL_WritePacket's cursize diagnostic. */
export function finishClientMessage(writer: MessageWriter): Uint8Array {
  writer.writeByte(ClientOpcode.Eof);
  if (writer.overflowed) throw new RangeError("Client message exceeds MAX_MSGLEN");
  return writer.toBytes();
}

/** Plaintext payload before CL_Netchan_Encode; backup commands are supplied in source generation order. */
export function encodeClientMessage(message: ClientMessage, context: ClientKeyContext, sourceState: SourceMessageState | null = null): Uint8Array {
  const writer = beginClientMessage(message.header, message.commands, sourceState);
  if (message.movement !== null) writeClientMovement(writer, message.movement, message.header, context);
  return finishClientMessage(writer);
}

/**
 * Owned plaintext after XOR. Each method stops at the source admission boundary.
 * The production server owns acknowledgement policy, reliable execution and pure checks.
 */
export class ClientMessageReader {
  readonly prefix: Pick<ClientHeader, "serverId" | "messageAcknowledge">;
  private readonly reader: MessageReader;
  private phase: ClientReadPhase = { kind: "header" };
  constructor(bytes: Uint8Array, source = "<client-message>") {
    // Validate the source cap before copying a caller-owned datagram.
    const validated = new MessageReader(bytes, "bitstream", source);
    this.reader = new MessageReader(new Uint8Array(validated.data), "bitstream", source);
    this.prefix = { serverId: this.reader.readLong(), messageAcknowledge: this.reader.readLong() };
  }
  get readCount(): number { return this.reader.readCount; }

  /** Call only after accepting prefix.messageAcknowledge; no payload opcode is read. */
  readHeader(): ClientHeader {
    if (this.phase.kind !== "header") throw new Error(`Cannot read client header during ${this.phase.kind}`);
    this.phase = { kind: "failed" };
    const header = { ...this.prefix, reliableAcknowledge: this.reader.readLong() };
    this.phase = { kind: "commands", header };
    return header;
  }

  /** A returned reliable command must be admitted/executed before requesting the next part. */
  next(): ClientMessagePart {
    const phase = this.phase;
    if (phase.kind !== "commands") throw new Error(`Cannot read next client part during ${phase.kind}`);
    this.phase = { kind: "failed" };
    const opcode = this.reader.readByte();
    if (opcode === ClientOpcode.Command) {
      const command = { sequence: this.reader.readLong(), text: this.reader.readString() };
      this.phase = phase;
      return { kind: "command", command };
    }
    if (opcode === ClientOpcode.Eof) { this.phase = { kind: "done" }; return { kind: "eof" }; }
    if (opcode !== ClientOpcode.Move && opcode !== ClientOpcode.MoveNoDelta) throw new InvalidClientOpcodeError(this.reader.source, this.reader.readCount, opcode);
    const movementKind = opcode === ClientOpcode.Move ? "move" : "move-no-delta";
    this.phase = { kind: "movement", header: phase.header, movementKind };
    return { kind: "movement", movementKind, deltaMessage: movementKind === "move" ? phase.header.messageAcknowledge : -1 };
  }

  /** Decode backups before pure/enter-world processing, without time filtering or trailing-byte reads. */
  readMovement(context: ClientKeyContext): UnfilteredClientMovement {
    const phase = this.phase;
    if (phase.kind !== "movement") throw new Error(`Cannot read client movement during ${phase.kind}`);
    this.phase = { kind: "failed" };
    const count = this.reader.readByte();
    if (count < 1 || count > MAX_PACKET_USER_COMMANDS) throw new InvalidClientCommandCountError(this.reader.source, this.reader.readCount, count);
    const key = moveKey(phase.header, context);
    let old = readDeltaUserCommand(this.reader, zeroCommand(), key);
    const commands: [WireUserCommand, ...WireUserCommand[]] = [old];
    for (let i = 1; i < count; i++) {
      old = readDeltaUserCommand(this.reader, old, key);
      commands.push(old);
    }
    this.phase = { kind: "terminal" };
    return { kind: phase.movementKind, commands, deltaMessage: phase.movementKind === "move" ? phase.header.messageAcknowledge : -1 };
  }

  /** Strict codec validation only: SV_ExecuteClientMessage does not consume this trailing byte. */
  validateTerminal(): void {
    if (this.phase.kind !== "terminal") throw new Error(`Cannot validate client terminal during ${this.phase.kind}`);
    this.phase = { kind: "failed" };
    if (this.reader.readByte() !== ClientOpcode.Eof) throw new BinaryError(this.reader.source, this.reader.readCount, "Missing terminal clc_EOF after movement");
    this.phase = { kind: "done" };
  }
}

/** Run after SV_ClientEnterWorld has seeded lastUsercmd; this does not execute game commands. */
export function filterClientMovement(movement: UnfilteredClientMovement, lastUserCommandTime: number): DecodedClientMovement {
  const latest = movement.commands[movement.commands.length - 1];
  if (latest === undefined || movement.commands.length > MAX_PACKET_USER_COMMANDS) throw new RangeError("Movement needs 1 through 32 backup commands");
  const executableCommands: WireUserCommand[] = [];
  for (const command of movement.commands) {
    if (command.serverTime > latest.serverTime || command.serverTime <= lastUserCommandTime) continue;
    executableCommands.push(copyCommand(command));
    lastUserCommandTime = command.serverTime;
  }
  return { ...movement, commands: movement.commands.map(copyCommand), executableCommands, lastUserCommandTime };
}

/**
 * Complete-codec convenience API, not production SV admission. It retains stricter
 * negative/future reliable-ack rejection and mandatory terminal EOF validation.
 * Use ClientMessageReader when execution can stop between commands or enter the world.
 */
export function decodeClientMessage(bytes: Uint8Array, context: ClientDecodeContext, source = "<client-message>"): DecodedClientMessage {
  const reader = new ClientMessageReader(bytes, source);
  const header = reader.readHeader();
  const commands: ReliableCommand[] = [];
  let lastClientCommand = context.lastClientCommand;
  const reject = (reason: Extract<DecodedClientMessage, { kind: "rejected" }>["reason"], rejectedHeader = header): DecodedClientMessage => ({ kind: "rejected", header: rejectedHeader, commands, lastClientCommand, reason });
  if (header.messageAcknowledge < 0) return reject("negative-message-acknowledge");
  if (header.reliableAcknowledge < 0) return reject("negative-reliable-acknowledge");
  if (header.reliableAcknowledge < context.reliableSequence - 64) return reject("stale-reliable-acknowledge", { ...header, reliableAcknowledge: context.reliableSequence });
  if (header.reliableAcknowledge > context.reliableSequence) return reject("future-reliable-acknowledge");
  while (true) {
    const part = reader.next();
    if (part.kind === "command") {
      if (part.command.sequence > lastClientCommand) {
        if (part.command.sequence > lastClientCommand + 1) return reject("lost-reliable-command");
        commands.push(part.command);
        lastClientCommand = part.command.sequence;
      }
    } else if (part.kind === "eof") return { kind: "accepted", header, commands, lastClientCommand, movement: null };
    else {
      const movement = reader.readMovement(context);
      reader.validateTerminal();
      return { kind: "accepted", header, commands, lastClientCommand, movement: filterClientMovement(movement, context.lastUserCommandTime) };
    }
  }
}
