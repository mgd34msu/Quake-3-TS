// Port of id Software's client/cl_parse.c, server/sv_snapshot.c and server/sv_client.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import type { Product } from "../shared/definitions.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../shared/entity-state.ts";
import type { PlayerStateFields } from "../shared/player-state.ts";
import { MAX_MESSAGE_LENGTH, MessageReader, MessageWriter } from "./message.ts";
import type { SourceMessageState } from "./message.ts";
import { MAX_PARSE_ENTITIES } from "./parse-entities.ts";
import type { SourceParseEntities } from "./parse-entities.ts";
import { readDeltaEntity, readDeltaPlayerState, writeDeltaEntity, writeDeltaPlayerState } from "./state-delta.ts";
import type { DeltaMessageDiagnostics } from "./state-delta.ts";

export enum ServerOpcode { Nop = 1, Gamestate = 2, Configstring = 3, Baseline = 4, Command = 5, Download = 6, Snapshot = 7, Eof = 8 }
const SERVER_OPCODE_NAMES = ["svc_bad", "svc_nop", "svc_gamestate", "svc_configstring", "svc_baseline", "svc_serverCommand", "svc_download", "svc_snapshot"];
const ENTITY_SENTINEL = 1023;
const MAX_CONFIGSTRINGS = 1024;
const MAX_GAMESTATE_CHARS = 16000;
const MAX_AREA_BYTES = 32;
const MAX_DOWNLOAD_BLOCK = 2048;

export type GamestateEntry =
  | { readonly kind: "configstring"; readonly index: number; readonly value: string }
  | { readonly kind: "baseline"; readonly number: number; readonly entity: EntityStateFields };

export interface Gamestate {
  readonly kind: "gamestate";
  readonly commandSequence: number;
  readonly entries: readonly GamestateEntry[];
  readonly clientNumber: number;
  readonly checksumFeed: number;
}

export interface Snapshot {
  readonly messageNumber: number;
  readonly serverTime: number;
  readonly deltaNumber: number;
  readonly flags: number;
  readonly serverCommandNumber: number;
  readonly parseEntitiesNumber: number;
  readonly areaMask: Uint8Array;
  readonly playerState: PlayerStateFields;
  /** Source append order; length is numEntities, including repeated numbers. */
  readonly entities: readonly EntityStateFields[];
}

export interface SnapshotHistoryEntry {
  readonly status: "valid" | "invalid";
  readonly snapshot: Snapshot;
}

export type SnapshotValidity =
  | { readonly kind: "valid" }
  | { readonly kind: "invalid"; readonly reason: "missing-delta" | "invalid-delta" | "stale-delta" | "stale-entities" };

export type Download =
  | { readonly kind: "start"; readonly fileSize: number; readonly data: Uint8Array }
  | { readonly kind: "chunk"; readonly number: number; readonly data: Uint8Array }
  | { readonly kind: "error"; readonly fileSize: number; readonly message: string };

export type ServerOperation =
  | { readonly kind: "nop" }
  | { readonly kind: "command"; readonly sequence: number; readonly text: string }
  | Gamestate
  | { readonly kind: "download"; readonly block: Download }
  | { readonly kind: "snapshot"; readonly validity: SnapshotValidity; readonly snapshot: Snapshot };

export interface ServerMessageContext {
  readonly product: Product;
  readonly messageNumber: number;
  readonly reliableSequence: number;
  readonly serverCommandSequence: number;
  readonly parseEntitiesNumber: number;
  readonly baseline: (number: number) => EntityStateFields | null;
  /** Return the actual ring slot, even when its message number is stale or its valid flag is clear. */
  readonly history: (deltaNumber: number) => SnapshotHistoryEntry | null;
}

export interface ServerMessage {
  readonly reliableAcknowledge: number;
  readonly serverCommandSequence: number;
  readonly parseEntitiesNumber: number;
  readonly operations: readonly ServerOperation[];
  readonly terminal: "eof" | "download-error";
}

export type ServerMessageDiagnostics = Omit<DeltaMessageDiagnostics, "offset">;

function showNet(reader: MessageReader, label: string, diagnostics: DeltaMessageDiagnostics | null): void {
  if (diagnostics !== null && diagnostics.shownet() >= 2) diagnostics.print(`${String(reader.readCount + diagnostics.offset - 1).padStart(3)}:${label}\n`);
}

function showPacketEntity(reader: MessageReader, label: "unchanged" | "delta" | "baseline", number: number, diagnostics: DeltaMessageDiagnostics | null): void {
  if (diagnostics !== null && diagnostics.shownet() === 3) diagnostics.print(`${String(reader.readCount + diagnostics.offset).padStart(3)}:  ${label}: ${number}\n`);
}

function fail(reader: MessageReader, message: string): never {
  throw new BinaryError(reader.source, reader.readCount, message);
}

function validateEntities(entities: readonly EntityStateFields[]): void {
  if (entities.length > ENTITY_SENTINEL) throw new RangeError("Too many snapshot entities");
  let previous = -1;
  for (const entity of entities) {
    if (!Number.isInteger(entity.number) || entity.number <= previous || entity.number >= ENTITY_SENTINEL) throw new RangeError("Snapshot entities must have sorted unique numbers below 1023");
    previous = entity.number;
  }
}

function readPacketEntities(reader: MessageReader, previous: Snapshot | null, baseline: ServerMessageContext["baseline"], diagnostics: DeltaMessageDiagnostics | null, parseEntities: SourceParseEntities | null): SourceEntityState[] {
  const output: SourceEntityState[] = [];
  const oldState = (index: number): EntityStateFields | null => {
    if (previous === null || index >= previous.entities.length) return null;
    if (parseEntities !== null) return parseEntities.at((previous.parseEntitiesNumber + index) | 0);
    const entity = previous.entities[index];
    if (entity === undefined) throw new Error("Missing previous packet entity");
    return entity;
  };
  const deltaEntity = (number: number, from: EntityStateFields, unchanged: boolean): void => {
    const target = parseEntities === null ? new EntityStateRecord<number>(0) : parseEntities.at(parseEntities.number);
    if (unchanged) target.copyFrom(from);
    else readDeltaEntity(reader, from, number, diagnostics, target);
    if (target.number === ENTITY_SENTINEL) return;
    if (parseEntities !== null) parseEntities.advance();
    output.push(target.copy());
  };
  let oldIndex = 0;
  let old = oldState(oldIndex);
  let oldNumber = old === null ? 99999 : old.number;
  while (true) {
    const number = reader.readBits(10);
    if (number === ENTITY_SENTINEL) break;
    if (reader.readCount > reader.data.length) fail(reader, "CL_ParsePacketEntities: end of message");
    while (old !== null && oldNumber < number) {
      showPacketEntity(reader, "unchanged", oldNumber, diagnostics);
      deltaEntity(oldNumber, old, true);
      oldIndex++;
      old = oldState(oldIndex);
      oldNumber = old === null ? 99999 : old.number;
    }
    if (old !== null && oldNumber === number) {
      showPacketEntity(reader, "delta", number, diagnostics);
      deltaEntity(number, old, false);
      oldIndex++;
      old = oldState(oldIndex);
      oldNumber = old === null ? 99999 : old.number;
    } else {
      showPacketEntity(reader, "baseline", number, diagnostics);
      deltaEntity(number, baseline(number) ?? new EntityStateRecord<number>(0), false);
    }
  }
  while (old !== null) {
    showPacketEntity(reader, "unchanged", oldNumber, diagnostics);
    deltaEntity(oldNumber, old, true);
    oldIndex++;
    old = oldState(oldIndex);
    oldNumber = old === null ? 99999 : old.number;
  }
  return output;
}

function writePacketEntities(writer: MessageWriter, previous: readonly EntityStateFields[], current: readonly EntityStateFields[], baseline: ServerMessageContext["baseline"]): void {
  validateEntities(previous);
  validateEntities(current);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < previous.length || newIndex < current.length) {
    const old = previous[oldIndex];
    const next = current[newIndex];
    if (old !== undefined && next !== undefined && old.number === next.number) {
      writeDeltaEntity(writer, old, next, false);
      oldIndex++; newIndex++;
    } else if (next !== undefined && (old === undefined || next.number < old.number)) {
      writeDeltaEntity(writer, baseline(next.number), next, true);
      newIndex++;
    } else if (old !== undefined) {
      writeDeltaEntity(writer, old, null, true);
      oldIndex++;
    } else throw new Error("Missing packet entity during merge");
  }
  writer.writeBits(ENTITY_SENTINEL, 10);
}

function gamestateBaselines(gamestate: Gamestate): ServerMessageContext["baseline"] {
  const entries = new Map<number, EntityStateFields>();
  for (const entry of gamestate.entries) if (entry.kind === "baseline") entries.set(entry.number, entry.entity);
  return (number) => entries.get(number) ?? null;
}

function readDownload(reader: MessageReader, publishSize: ((fileSize: number) => number) | null): Download {
  const number = reader.readShort();
  let fileSize = 0;
  if (number === 0) {
    fileSize = reader.readLong();
    // Cvar_Set2 can print and change the live download size before the sign test.
    if (publishSize !== null) fileSize = publishSize(fileSize);
    if (fileSize < 0) return { kind: "error", fileSize, message: reader.readString() };
  }
  const size = reader.readShort();
  if (size < 0 || size > MAX_MESSAGE_LENGTH) fail(reader, `Invalid download block length ${size}`);
  const data = reader.readData(size);
  return number === 0 ? { kind: "start", fileSize, data } : { kind: "chunk", number, data };
}

type SnapshotHeader = Pick<Snapshot, "serverTime" | "deltaNumber" | "flags">;

function readSnapshot(reader: MessageReader, header: SnapshotHeader, context: ServerMessageContext, diagnostics: DeltaMessageDiagnostics | null, parseEntities: SourceParseEntities | null): Extract<ServerOperation, { kind: "snapshot" }> {
  const { serverTime, deltaNumber, flags } = header;
  const { messageNumber, serverCommandSequence } = context;
  const slot = deltaNumber <= 0 ? null : context.history(deltaNumber);
  let validity: SnapshotValidity = { kind: "valid" };
  if (deltaNumber > 0) {
    if (slot === null) validity = { kind: "invalid", reason: "missing-delta" };
    else if (slot.status === "invalid") validity = { kind: "invalid", reason: "invalid-delta" };
    else if (slot.snapshot.messageNumber !== deltaNumber) validity = { kind: "invalid", reason: "stale-delta" };
    else if ((((parseEntities === null ? context.parseEntitiesNumber : parseEntities.number) - slot.snapshot.parseEntitiesNumber) | 0) > MAX_PARSE_ENTITIES - 128) validity = { kind: "invalid", reason: "stale-entities" };
  }
  if (validity.kind === "invalid" && diagnostics !== null) {
    switch (validity.reason) {
      case "missing-delta":
      case "invalid-delta": diagnostics.print("Delta from invalid frame (not supposed to happen!).\n"); break;
      case "stale-delta": diagnostics.print("Delta frame too old.\n"); break;
      case "stale-entities": diagnostics.print("Delta parseEntitiesNum too old.\n"); break;
    }
  }
  const length = reader.readByte();
  if (length > MAX_AREA_BYTES) fail(reader, "Snapshot area mask exceeds 32 bytes");
  const areaMask = reader.readData(length);
  showNet(reader, "playerstate", diagnostics);
  const playerState = readDeltaPlayerState(reader, slot === null ? null : slot.snapshot.playerState, context.product, diagnostics);
  showNet(reader, "packet entities", diagnostics);
  const parseEntitiesNumber = parseEntities === null ? context.parseEntitiesNumber : parseEntities.number;
  const entities = readPacketEntities(reader, slot === null ? null : slot.snapshot, context.baseline, diagnostics, parseEntities);
  return { kind: "snapshot", validity, snapshot: { messageNumber, serverTime, deltaNumber, flags, serverCommandNumber: serverCommandSequence, parseEntitiesNumber, areaMask, playerState, entities } };
}

/** Source mutation boundaries, including CL_ClearState before gamestate fields. */
export type ServerMessageStep =
  | { readonly kind: "acknowledge"; readonly sequence: number }
  | { readonly kind: "gamestate-start" }
  | { readonly kind: "gamestate-sequence"; readonly sequence: number }
  | { readonly kind: "gamestate-entry"; readonly entry: GamestateEntry }
  | { readonly kind: "gamestate-client"; readonly number: number }
  | { readonly kind: "gamestate-checksum"; readonly checksum: number }
  | { readonly kind: "gamestate-end" }
  | { readonly kind: "snapshot-header"; readonly deltaNumber: number }
  | { readonly kind: "operation"; readonly operation: Exclude<ServerOperation, Gamestate> }
  | { readonly kind: "end"; readonly terminal: ServerMessage["terminal"] };

/** One decoder; the engine supplies its current context after each source barrier. */
export class ServerMessageCursor {
  private readonly reader: MessageReader;
  private readonly diagnostics: DeltaMessageDiagnostics | null;
  private phase: "header" | "opcode" | "sequence" | "entries" | "client" | "checksum" | "gamestate-end" | "end" = "header";
  private terminal: ServerMessage["terminal"] = "eof";
  private dataCount = 1;
  private exhausted = false;
  private snapshotHeader: SnapshotHeader | null = null;

  constructor(bytes: Uint8Array, source = "<server-message>", diagnostics: ServerMessageDiagnostics | null = null, private readonly readOffset = 0, private readonly parseEntities: SourceParseEntities | null = null,
    private readonly publishDownloadSize: ((fileSize: number) => number) | null = null) {
    if (!Number.isInteger(readOffset) || readOffset < 0) throw new RangeError("Invalid server message read offset");
    this.reader = new MessageReader(bytes, "bitstream", source);
    this.diagnostics = diagnostics === null ? null : { ...diagnostics, offset: readOffset };
  }

  /** MSG_ReadLong returns -1 after exhaustion; retain that scalar's side effects. */
  private sourceLong(): number {
    if (this.exhausted) return -1;
    try {
      const value = this.reader.readLong();
      if (this.reader.readCount > this.reader.data.length) this.exhausted = true;
      return value;
    }
    catch (error) {
      if (!(error instanceof BinaryError) || (this.reader.bitPosition < this.reader.data.length * 8
        && this.reader.readCount <= this.reader.data.length)) throw error;
      this.exhausted = true;
      return -1;
    }
  }

  next(context: ServerMessageContext): ServerMessageStep {
    const reader = this.reader;
    if (this.snapshotHeader !== null) {
      const header = this.snapshotHeader;
      this.snapshotHeader = null;
      return { kind: "operation", operation: readSnapshot(reader, header, context, this.diagnostics, this.parseEntities) };
    }
    switch (this.phase) {
      case "header": {
        if (this.diagnostics !== null) {
          if (this.diagnostics.shownet() === 1) this.diagnostics.print(`${reader.data.length + this.readOffset} `);
          else if (this.diagnostics.shownet() >= 2) this.diagnostics.print("------------------\n");
        }
        const wire = this.sourceLong();
        this.phase = "opcode";
        return { kind: "acknowledge", sequence: wire < context.reliableSequence - 64 ? context.reliableSequence : wire };
      }
      case "sequence": {
        const sequence = this.sourceLong();
        this.dataCount = 1; this.phase = "entries";
        return { kind: "gamestate-sequence", sequence };
      }
      case "entries": {
        const opcode = this.exhausted ? -1 : reader.readByte();
        if (opcode === ServerOpcode.Eof) { this.phase = "client"; return this.next(context); }
        if (opcode === ServerOpcode.Configstring) {
          const index = reader.readShort();
          if (index < 0 || index >= MAX_CONFIGSTRINGS) fail(reader, "Invalid configstring index");
          const value = reader.readBigString();
          if (this.dataCount + value.length + 1 > MAX_GAMESTATE_CHARS) fail(reader, "Gamestate string storage exceeded");
          this.dataCount += value.length + 1;
          return { kind: "gamestate-entry", entry: { kind: "configstring", index, value } };
        }
        if (opcode === ServerOpcode.Baseline) {
          const number = reader.readBits(10);
          const target = context.baseline(number) ?? new EntityStateRecord<number>(0);
          readDeltaEntity(reader, new EntityStateRecord<number>(0), number, this.diagnostics, target);
          const entity = new EntityStateRecord<number>(0);
          entity.copyFrom(target);
          return { kind: "gamestate-entry", entry: { kind: "baseline", number, entity } };
        }
        return fail(reader, `Invalid gamestate opcode ${opcode}`);
      }
      case "client": {
        const number = this.sourceLong(); this.phase = "checksum";
        return { kind: "gamestate-client", number };
      }
      case "checksum": {
        const checksum = this.sourceLong(); this.phase = "gamestate-end";
        return { kind: "gamestate-checksum", checksum };
      }
      case "gamestate-end": this.phase = "opcode"; return { kind: "gamestate-end" };
      case "end": return { kind: "end", terminal: this.terminal };
      case "opcode": break;
    }
    while (true) {
      if (this.exhausted || reader.readCount > reader.data.length) return fail(reader, "CL_ParseServerMessage: read past end of server message");
      const opcode = reader.readByte();
      if (opcode === ServerOpcode.Eof) {
        showNet(reader, "END OF MESSAGE", this.diagnostics);
        this.phase = "end";
        return { kind: "end", terminal: "eof" };
      }
      if (this.diagnostics !== null && this.diagnostics.shownet() >= 2) {
        const name = SERVER_OPCODE_NAMES[opcode];
        if (name === undefined) this.diagnostics.print(`${String(reader.readCount + this.readOffset - 1).padStart(3)}:BAD CMD ${opcode}\n`);
        else showNet(reader, name, this.diagnostics);
      }
      switch (opcode) {
        case ServerOpcode.Nop: return { kind: "operation", operation: { kind: "nop" } };
        case ServerOpcode.Command: {
          const sequence = reader.readLong(), text = reader.readString();
          if (sequence <= context.serverCommandSequence) break;
          return { kind: "operation", operation: { kind: "command", sequence, text } };
        }
        case ServerOpcode.Gamestate: this.phase = "sequence"; return { kind: "gamestate-start" };
        case ServerOpcode.Download: {
          const block = readDownload(reader, this.publishDownloadSize);
          if (block.kind === "error") { this.phase = "end"; this.terminal = "download-error"; }
          return { kind: "operation", operation: { kind: "download", block } };
        }
        case ServerOpcode.Snapshot: {
          const serverTime = reader.readLong();
          const distance = reader.readByte();
          const deltaNumber = distance === 0 ? -1 : (context.messageNumber - distance) | 0;
          const flags = reader.readByte();
          this.snapshotHeader = { serverTime, deltaNumber, flags };
          return { kind: "snapshot-header", deltaNumber };
        }
        default: return fail(reader, `Invalid server opcode ${opcode}`);
      }
    }
  }
}

/** Pure consumer of the same incremental decoder used by the engine session. */
export function decodeServerMessage(bytes: Uint8Array, context: ServerMessageContext, source = "<server-message>"): ServerMessage {
  const cursor = new ServerMessageCursor(bytes, source);
  let reliableAcknowledge = 0, commandSequence = context.serverCommandSequence, parseEntitiesNumber = context.parseEntitiesNumber;
  let baseline = context.baseline, history = context.history;
  let entries: GamestateEntry[] = [], gamestateSequence = 0, clientNumber = 0, checksumFeed = 0;
  const operations: ServerOperation[] = [];
  while (true) {
    const step = cursor.next({ ...context, serverCommandSequence: commandSequence, parseEntitiesNumber, baseline, history });
    switch (step.kind) {
      case "acknowledge": reliableAcknowledge = step.sequence; break;
      case "gamestate-start": entries = []; parseEntitiesNumber = 0; baseline = () => null; history = () => null; break;
      case "gamestate-sequence": gamestateSequence = step.sequence; commandSequence = step.sequence; break;
      case "gamestate-entry": entries.push(step.entry); break;
      case "gamestate-client": clientNumber = step.number; break;
      case "gamestate-checksum": checksumFeed = step.checksum; break;
      case "snapshot-header": break;
      case "gamestate-end": {
        const gamestate: Gamestate = { kind: "gamestate", commandSequence: gamestateSequence, entries, clientNumber, checksumFeed };
        operations.push(gamestate); baseline = gamestateBaselines(gamestate); break;
      }
      case "operation":
        operations.push(step.operation);
        if (step.operation.kind === "command") commandSequence = step.operation.sequence;
        if (step.operation.kind === "snapshot") parseEntitiesNumber = (parseEntitiesNumber + step.operation.snapshot.entities.length) | 0;
        break;
      case "end": return { reliableAcknowledge, serverCommandSequence: commandSequence, parseEntitiesNumber, operations, terminal: step.terminal };
    }
  }
}

function writeGamestate(writer: MessageWriter, gamestate: Gamestate): void {
  writer.writeByte(ServerOpcode.Gamestate);
  writer.writeLong(gamestate.commandSequence);
  let dataCount = 1;
  for (const entry of gamestate.entries) {
    if (entry.kind === "configstring") {
      if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= MAX_CONFIGSTRINGS) throw new RangeError("Invalid configstring index");
      const nul = entry.value.indexOf("\0");
      const length = nul === -1 ? entry.value.length : nul;
      if (length >= 8192) throw new RangeError("Configstring exceeds BIG_INFO_STRING");
      dataCount += length + 1;
      if (dataCount > MAX_GAMESTATE_CHARS) throw new RangeError("Gamestate string storage exceeded");
      writer.writeByte(ServerOpcode.Configstring);
      writer.writeShort(entry.index);
      writer.writeBigString(entry.value);
    } else {
      if (!Number.isInteger(entry.number) || entry.number < 0 || entry.number > ENTITY_SENTINEL) throw new RangeError("Invalid baseline number");
      writer.writeByte(ServerOpcode.Baseline);
      if (entry.entity.number === ENTITY_SENTINEL && entry.number !== ENTITY_SENTINEL) {
        const removed = new EntityStateRecord<number>(0); removed.number = entry.number;
        writeDeltaEntity(writer, removed, null);
      } else {
        if (entry.entity.number !== entry.number) throw new RangeError("Baseline index differs from entity number");
        writeDeltaEntity(writer, new EntityStateRecord<number>(0), entry.entity, true);
      }
    }
  }
  writer.writeByte(ServerOpcode.Eof);
  writer.writeLong(gamestate.clientNumber);
  writer.writeLong(gamestate.checksumFeed);
}

function writeDownload(writer: MessageWriter, block: Download): void {
  writer.writeByte(ServerOpcode.Download);
  if (block.kind === "error") {
    if (!Number.isInteger(block.fileSize) || block.fileSize < -0x80000000 || block.fileSize >= 0) throw new RangeError("Invalid download error file size");
    writer.writeShort(0); writer.writeLong(block.fileSize); writer.writeString(block.message);
    return;
  }
  if (block.data.length > MAX_DOWNLOAD_BLOCK) throw new RangeError("Download block exceeds 2048 bytes");
  if (block.kind === "start") {
    if (!Number.isInteger(block.fileSize) || block.fileSize < 0 || block.fileSize > 0x7fffffff) throw new RangeError("Invalid download file size");
    writer.writeShort(0); writer.writeLong(block.fileSize);
  } else {
    if (!Number.isInteger(block.number) || block.number === 0 || block.number < -32768 || block.number > 32767) throw new RangeError("Invalid download block number");
    writer.writeShort(block.number);
  }
  writer.writeShort(block.data.length);
  writer.writeData(block.data);
}

function writeSnapshot(writer: MessageWriter, snapshot: Snapshot, context: ServerMessageContext, baseline: ServerMessageContext["baseline"], history: ServerMessageContext["history"]): void {
  if (snapshot.messageNumber !== context.messageNumber) throw new RangeError("Snapshot message number differs from envelope");
  if (snapshot.playerState.product !== context.product) throw new RangeError("Snapshot product differs from envelope");
  if (!Number.isInteger(snapshot.messageNumber) || snapshot.messageNumber < -0x80000000 || snapshot.messageNumber > 0x7fffffff
    || !Number.isInteger(snapshot.deltaNumber) || snapshot.deltaNumber < -0x80000000 || snapshot.deltaNumber > 0x7fffffff) {
    throw new RangeError("Snapshot sequence fields must be int32");
  }
  const distance = snapshot.deltaNumber <= 0 ? 0 : (snapshot.messageNumber - snapshot.deltaNumber) | 0;
  if (!Number.isInteger(distance) || distance < 0 || distance > 255 || (distance === 0 && snapshot.deltaNumber > 0)) throw new RangeError("Invalid snapshot delta distance");
  const old = distance === 0 ? null : history(snapshot.deltaNumber);
  if (distance !== 0 && (old === null || old.status !== "valid" || old.snapshot.messageNumber !== snapshot.deltaNumber)) throw new RangeError("Missing valid snapshot baseline for encoding");
  if (snapshot.areaMask.length > MAX_AREA_BYTES) throw new RangeError("Snapshot area mask exceeds 32 bytes");
  if (!Number.isInteger(snapshot.flags) || snapshot.flags < 0 || snapshot.flags > 255) throw new RangeError("Invalid snapshot flags");
  writer.writeByte(ServerOpcode.Snapshot);
  writer.writeLong(snapshot.serverTime);
  writer.writeByte(distance);
  writer.writeByte(snapshot.flags);
  writer.writeByte(snapshot.areaMask.length);
  writer.writeData(snapshot.areaMask);
  writeDeltaPlayerState(writer, old === null ? null : old.snapshot.playerState, snapshot.playerState);
  writePacketEntities(writer, old === null ? [] : old.snapshot.entities, snapshot.entities, baseline);
}

/** Writes an unfinished server envelope; the network owner appends EOF and handles overflow. */
export function writeServerMessage(writer: MessageWriter, reliableAcknowledge: number, operations: readonly ServerOperation[], context: ServerMessageContext): void {
  writer.writeLong(reliableAcknowledge);
  let baseline = context.baseline;
  let history = context.history;
  let downloadError = false;
  for (const operation of operations) {
    if (downloadError) throw new RangeError("Operations cannot follow a terminal download error");
    switch (operation.kind) {
      case "nop": writer.writeByte(ServerOpcode.Nop); break;
      case "command":
        if (operation.text.length >= 1024) throw new RangeError("Server command exceeds MAX_STRING_CHARS");
        writer.writeByte(ServerOpcode.Command); writer.writeLong(operation.sequence); writer.writeString(operation.text);
        break;
      case "gamestate":
        writeGamestate(writer, operation);
        baseline = gamestateBaselines(operation);
        history = () => null;
        break;
      case "download":
        writeDownload(writer, operation.block);
        downloadError = operation.block.kind === "error";
        break;
      case "snapshot":
        if (operation.validity.kind !== "valid") throw new RangeError("Cannot encode an invalid decoded snapshot");
        writeSnapshot(writer, operation.snapshot, context, baseline, history);
        break;
    }
  }
}

export function encodeServerMessage(reliableAcknowledge: number, operations: readonly ServerOperation[], context: ServerMessageContext, sourceState: SourceMessageState | null = null): Uint8Array {
  const writer = new MessageWriter("bitstream", MAX_MESSAGE_LENGTH, sourceState);
  writeServerMessage(writer, reliableAcknowledge, operations, context);
  writer.writeByte(ServerOpcode.Eof);
  if (writer.overflowed) throw new RangeError("Server message exceeds MAX_MSGLEN");
  return writer.toBytes();
}
