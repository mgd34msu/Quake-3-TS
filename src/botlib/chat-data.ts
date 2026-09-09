/*
 * Chat configuration readers translated from id Software's botlib/be_ai_chat.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { NumberFlag, ScriptLanguageError, type ScriptDiagnostic, type ScriptToken, type SourceLocation } from "../script/lexer.ts";
import type { ScriptSourceReader, ScriptTokenRecord } from "../script/preprocessor.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";

export const CHAT_ESCAPE = "\x01";
export const CHAT_MESSAGE_SIZE = 256;
export type ChatTextSource = string | ((maximumBytes?: number) => string);

/** Q_stricmp and strcmp stop reading at the first different source byte. */
export function chatTextEquals(expected: string, input: ChatTextSource | null, caseSensitive = false): boolean {
  if (input === null) return false;
  for (let index = 0; index <= expected.length; index++) {
    const text = typeof input === "string" ? input : input(index + 1);
    let first = index === expected.length ? 0 : expected.charCodeAt(index);
    let second = index < text.length ? text.charCodeAt(index) : 0;
    if (first > 255 || second > 255) throw new RangeError("bot chat strings must contain byte-valued code units");
    if (!caseSensitive) {
      if (first >= 97 && first <= 122) first -= 32;
      if (second >= 97 && second <= 122) second -= 32;
    }
    if (first !== second) return false;
    if (first === 0) return true;
  }
  return false;
}
export interface ChatMessage { readonly text: string; time: number }
export interface ChatType { readonly name: string; readonly messages: readonly ChatMessage[] }
export interface InitialChat { readonly types: readonly ChatType[] }
export interface RandomChatList { readonly name: string; readonly messages: readonly string[] }
export interface StoredRandomChatList extends RandomChatList { readonly numMessages: number; message(index: number): string | undefined }
export interface Synonym { readonly text: string; readonly weight: number }
export interface SynonymGroup { readonly context: number; readonly entries: readonly [Synonym, Synonym, ...Synonym[]]; readonly totalWeight: number }
export type MatchPiece =
  | { readonly kind: "variable"; readonly index: number }
  | { readonly kind: "string"; readonly alternatives: readonly string[] };
export interface MatchTemplate { readonly context: number; readonly type: number; readonly subtype: number; readonly pieces: readonly MatchPiece[] }
export type ReplyTest =
  | { readonly kind: "name" }
  | { readonly kind: "gender"; readonly gender: number }
  | { readonly kind: "botnames"; readonly names: string }
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "match"; readonly pieces: readonly MatchPiece[] };
export interface ReplyKey { readonly mode: "any" | "and" | "not"; readonly test: ReplyTest }
export interface ReplyChat { readonly keys: readonly ReplyKey[]; readonly priority: number; readonly messages: readonly ChatMessage[] }

function stringValue(value: string): string { const nul = value.indexOf("\0"); return nul < 0 ? value : value.slice(0, nul); }
function containsChatText(text: string, part: string): boolean {
  const upper = (value: string): string => value.replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32));
  return upper(text).includes(upper(part));
}

/** BotLoadInitialChat packs Release32 records without alignment padding.
 * Internal pointer words are byte offsets plus one; zero remains NULL. */
export class ChatInitial {
  private readonly types = new Map<number, ChatInitialType>();
  private readonly messages = new Map<number, ChatInitialMessage>();
  constructor(readonly allocation: BotMemoryAllocation, readonly pointer: number) {}
  view(offset: number, size: number): DataView {
    const bytes = this.allocation.bytes;
    if (offset < 0 || offset + size > bytes.length) throw new RangeError("initial chat record exceeds its allocation");
    return new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  }
  text(offset: number): string {
    const bytes = this.allocation.bytes;
    if (offset < 0 || offset >= bytes.length) throw new RangeError("initial chat string pointer is outside its allocation");
    let text = "";
    for (let index = offset; index < bytes.length; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("initial chat string exceeds its allocation");
      if (byte === 0) return text;
      text += String.fromCharCode(byte);
    }
    throw new RangeError("initial chat string has no terminator before allocation end");
  }
  private copyText(offset: number, text: string, size: number): void {
    const view = this.view(offset, size), copied = Math.min(text.length, size);
    for (let index = 0; index < copied; index++) {
      const byte = text.charCodeAt(index);
      if (byte > 255) throw new RangeError("bot chat strings must contain byte-valued code units");
      view.setUint8(index, byte);
    }
    for (let index = copied; index < size; index++) view.setUint8(index, 0);
  }
  typeAt(pointer: number): ChatInitialType | null {
    if (pointer === 0) return null;
    const type = this.types.get(pointer);
    if (type === undefined) throw new RangeError("initial chat pointer does not identify an allocated type");
    return type;
  }
  messageAt(pointer: number): ChatInitialMessage | null {
    if (pointer === 0) return null;
    const message = this.messages.get(pointer);
    if (message === undefined) throw new RangeError("initial chat pointer does not identify an allocated message");
    return message;
  }
  get firstType(): ChatInitialType | null { return this.typeAt(this.view(0, 4).getUint32(0, true)); }
  addType(offset: number, name: string): ChatInitialType {
    const type = new ChatInitialType(this, offset);
    this.types.set(type.pointer, type);
    this.copyText(offset, name, 32);
    type.firstMessage = null;
    type.next = this.firstType;
    this.view(0, 4).setUint32(0, type.pointer, true);
    return type;
  }
  addMessage(type: ChatInitialType, offset: number): ChatInitialMessage {
    const message = new ChatInitialMessage(this, offset);
    this.messages.set(message.pointer, message);
    message.time = -40;
    message.next = type.firstMessage;
    type.firstMessage = message;
    this.view(offset, 12).setUint32(0, offset + 12 + 1, true);
    return message;
  }
  writeMessage(type: ChatInitialType, offset: number, text: string): void {
    this.copyText(offset, text, text.length + 1);
    type.numMessages++;
  }
  *allMessages(): Generator<ChatMessage, undefined, undefined> {
    for (let type = this.firstType; type !== null; type = type.next) yield* type.messages();
  }
  snapshot(): InitialChat {
    const types: ChatType[] = [];
    for (let type = this.firstType; type !== null; type = type.next) {
      const messages: ChatMessage[] = [];
      for (const message of type.messages()) messages.push({ text: message.text, time: message.time });
      types.push({ name: type.name, messages });
    }
    return { types };
  }
}

class ChatInitialType {
  readonly pointer: number;
  constructor(private readonly owner: ChatInitial, private readonly offset: number) { this.pointer = offset + 1; }
  private view(): DataView { return this.owner.view(this.offset, 44); }
  get name(): string { return this.owner.text(this.offset); }
  get numMessages(): number { return this.view().getInt32(32, true); }
  set numMessages(value: number) { this.view().setInt32(32, value, true); }
  get firstMessage(): ChatInitialMessage | null { return this.owner.messageAt(this.view().getUint32(36, true)); }
  set firstMessage(value: ChatInitialMessage | null) { this.view().setUint32(36, value?.pointer ?? 0, true); }
  get next(): ChatInitialType | null { return this.owner.typeAt(this.view().getUint32(40, true)); }
  set next(value: ChatInitialType | null) { this.view().setUint32(40, value?.pointer ?? 0, true); }
  *messages(): Generator<ChatInitialMessage, undefined, undefined> { for (let message = this.firstMessage; message !== null; message = message.next) yield message; }
}

class ChatInitialMessage implements ChatMessage {
  readonly pointer: number;
  constructor(private readonly owner: ChatInitial, private readonly offset: number) { this.pointer = offset + 1; }
  private view(): DataView { return this.owner.view(this.offset, 12); }
  get text(): string { return this.owner.text(this.view().getUint32(0, true) - 1); }
  get time(): number { return this.view().getFloat32(4, true); }
  set time(value: number) { this.view().setFloat32(4, value, true); }
  get next(): ChatInitialMessage | null { return this.owner.messageAt(this.view().getUint32(8, true)); }
  set next(value: ChatInitialMessage | null) { this.view().setUint32(8, value?.pointer ?? 0, true); }
}

type ChatGraphPointer = ChatGraphString | ChatMatchString | ChatMatchPiece | ChatMatchTemplate | ChatReplyKey | ChatReplyMessage | ChatReply;

/** Release32 pointer words identify typed views; every reached field is read from its block. */
class ChatGraphMemory {
  private readonly pointers = new Map<number, ChatGraphPointer>();
  constructor(private readonly memory: BotMemory) {}
  private register<T extends ChatGraphPointer>(cell: T): T { this.pointers.set(cell.pointer, cell); return cell; }
  private allocate<T extends ChatGraphPointer>(size: number, create: (allocation: BotMemoryAllocation, pointer: number) => T): T {
    const allocation = this.memory.allocate(size, "hunk", true);
    return this.register(create(allocation, this.pointers.size + 1));
  }
  private target(pointer: number): ChatGraphPointer | null {
    if (pointer === 0) return null;
    const value = this.pointers.get(pointer);
    if (value === undefined) throw new RangeError("chat pointer is outside its allocated graph");
    return value;
  }
  stringAt(pointer: number): ChatGraphString | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatGraphString) return value;
    throw new RangeError("chat pointer does not identify a string");
  }
  matchStringAt(pointer: number): ChatMatchString | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatMatchString) return value;
    throw new RangeError("chat pointer does not identify a match string");
  }
  pieceAt(pointer: number): ChatMatchPiece | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatMatchPiece) return value;
    throw new RangeError("chat pointer does not identify a match piece");
  }
  templateAt(pointer: number): ChatMatchTemplate | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatMatchTemplate) return value;
    throw new RangeError("chat pointer does not identify a match template");
  }
  keyAt(pointer: number): ChatReplyKey | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatReplyKey) return value;
    throw new RangeError("chat pointer does not identify a reply key");
  }
  messageAt(pointer: number): ChatReplyMessage | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatReplyMessage) return value;
    throw new RangeError("chat pointer does not identify a reply message");
  }
  replyAt(pointer: number): ChatReply | null {
    const value = this.target(pointer);
    if (value === null || value instanceof ChatReply) return value;
    throw new RangeError("chat pointer does not identify a reply");
  }
  private writeString(allocation: BotMemoryAllocation, offset: number, text: string): ChatGraphString {
    const bytes = allocation.bytes;
    for (let index = 0; index < text.length; index++) {
      const byte = text.charCodeAt(index);
      if (byte > 255) throw new RangeError("bot chat strings must contain byte-valued code units");
      bytes[offset + index] = byte;
    }
    bytes[offset + text.length] = 0;
    return this.register(new ChatGraphString(this, allocation, this.pointers.size + 1, offset));
  }
  newString(text: string): ChatGraphString {
    return this.writeString(this.memory.allocate(text.length + 1, "hunk", true), 0, text);
  }
  newMatchString(text: string): ChatMatchString {
    const cell = this.allocate(8 + text.length + 1, (allocation, pointer) => new ChatMatchString(this, allocation, pointer));
    cell.string = this.writeString(cell.allocation, 8, text);
    return cell;
  }
  newPiece(): ChatMatchPiece { return this.allocate(16, (allocation, pointer) => new ChatMatchPiece(this, allocation, pointer)); }
  newTemplate(): ChatMatchTemplate { return this.allocate(20, (allocation, pointer) => new ChatMatchTemplate(this, allocation, pointer)); }
  newKey(): ChatReplyKey { return this.allocate(16, (allocation, pointer) => new ChatReplyKey(this, allocation, pointer)); }
  newMessage(text: string): ChatReplyMessage {
    const cell = this.allocate(12 + text.length + 1, (allocation, pointer) => new ChatReplyMessage(this, allocation, pointer));
    cell.string = this.writeString(cell.allocation, 12, text);
    return cell;
  }
  newReply(): ChatReply { return this.allocate(20, (allocation, pointer) => new ChatReply(this, allocation, pointer)); }
  free(allocation: BotMemoryAllocation): void { this.memory.free(allocation); }
}

class ChatGraphBlock {
  constructor(protected readonly owner: ChatGraphMemory, readonly allocation: BotMemoryAllocation, readonly pointer: number) {}
  protected view(): DataView { const bytes = this.allocation.bytes; return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  protected readPointer(offset: number): number { return this.view().getUint32(offset, true); }
  protected writePointer(offset: number, value: ChatGraphPointer | null): void { this.view().setUint32(offset, value?.pointer ?? 0, true); }
  freeBlock(): void { this.owner.free(this.allocation); }
}

class ChatGraphString extends ChatGraphBlock {
  constructor(owner: ChatGraphMemory, allocation: BotMemoryAllocation, pointer: number, private readonly offset: number) { super(owner, allocation, pointer); }
  get text(): string {
    const bytes = this.allocation.bytes;
    let result = "";
    for (let index = this.offset; index < bytes.length; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("chat string exceeds its allocation");
      if (byte === 0) return result;
      result += String.fromCharCode(byte);
    }
    throw new RangeError("chat string has no terminator before allocation end");
  }
}

class ChatMatchString extends ChatGraphBlock {
  get string(): ChatGraphString | null { return this.owner.stringAt(this.readPointer(0)); }
  set string(value: ChatGraphString | null) { this.writePointer(0, value); }
  get text(): string { const value = this.string; if (value === null) throw new RangeError("match string has a null string pointer"); return value.text; }
  get next(): ChatMatchString | null { return this.owner.matchStringAt(this.readPointer(4)); }
  set next(value: ChatMatchString | null) { this.writePointer(4, value); }
}

export class ChatMatchPiece extends ChatGraphBlock {
  get type(): number { return this.view().getInt32(0, true); }
  set type(value: number) { this.view().setInt32(0, value, true); }
  get firstString(): ChatMatchString | null { return this.owner.matchStringAt(this.readPointer(4)); }
  set firstString(value: ChatMatchString | null) { this.writePointer(4, value); }
  get variable(): number { return this.view().getInt32(8, true); }
  set variable(value: number) { this.view().setInt32(8, value, true); }
  get next(): ChatMatchPiece | null { return this.owner.pieceAt(this.readPointer(12)); }
  set next(value: ChatMatchPiece | null) { this.writePointer(12, value); }
  snapshot(): MatchPiece {
    if (this.type === 1) return { kind: "variable", index: this.variable };
    if (this.type !== 2) throw new RangeError("unknown source match piece type");
    const alternatives: string[] = [];
    for (let value = this.firstString; value !== null; value = value.next) alternatives.push(value.text);
    return { kind: "string", alternatives };
  }
  free(): void {
    for (let piece: ChatMatchPiece | null = this; piece !== null;) {
      const next: ChatMatchPiece | null = piece.next;
      if (piece.type === 2) for (let value = piece.firstString; value !== null;) {
        const nextString = value.next; value.freeBlock(); value = nextString;
      }
      piece.freeBlock(); piece = next;
    }
  }
}

export class ChatMatchTemplate extends ChatGraphBlock {
  get context(): number { return this.view().getUint32(0, true); }
  set context(value: number) { this.view().setUint32(0, value, true); }
  get type(): number { return this.view().getInt32(4, true); }
  set type(value: number) { this.view().setInt32(4, value, true); }
  get subtype(): number { return this.view().getInt32(8, true); }
  set subtype(value: number) { this.view().setInt32(8, value, true); }
  get first(): ChatMatchPiece | null { return this.owner.pieceAt(this.readPointer(12)); }
  set first(value: ChatMatchPiece | null) { this.writePointer(12, value); }
  get next(): ChatMatchTemplate | null { return this.owner.templateAt(this.readPointer(16)); }
  set next(value: ChatMatchTemplate | null) { this.writePointer(16, value); }
  snapshot(): MatchTemplate {
    const pieces: MatchPiece[] = [];
    for (let piece = this.first; piece !== null; piece = piece.next) pieces.push(piece.snapshot());
    return { context: this.context, type: this.type, subtype: this.subtype, pieces };
  }
  free(): void {
    for (let template: ChatMatchTemplate | null = this; template !== null;) {
      const next: ChatMatchTemplate | null = template.next; template.first?.free(); template.freeBlock(); template = next;
    }
  }
}

export class ChatReplyKey extends ChatGraphBlock {
  get flags(): number { return this.view().getInt32(0, true); }
  set flags(value: number) { this.view().setInt32(0, value, true); }
  get string(): ChatGraphString | null { return this.owner.stringAt(this.readPointer(4)); }
  set string(value: ChatGraphString | null) { this.writePointer(4, value); }
  get text(): string { const value = this.string; if (value === null) throw new RangeError("reply key has a null string pointer"); return value.text; }
  get match(): ChatMatchPiece | null { return this.owner.pieceAt(this.readPointer(8)); }
  set match(value: ChatMatchPiece | null) { this.writePointer(8, value); }
  get next(): ChatReplyKey | null { return this.owner.keyAt(this.readPointer(12)); }
  set next(value: ChatReplyKey | null) { this.writePointer(12, value); }
  snapshot(): ReplyKey {
    const flags = this.flags, mode = (flags & 1) !== 0 ? "and" : (flags & 2) !== 0 ? "not" : "any";
    let test: ReplyTest;
    if ((flags & 4) !== 0) test = { kind: "name" };
    else if ((flags & 32) !== 0) test = { kind: "botnames", names: this.text };
    else if ((flags & 64) !== 0) test = { kind: "gender", gender: 1 };
    else if ((flags & 128) !== 0) test = { kind: "gender", gender: 2 };
    else if ((flags & 256) !== 0) test = { kind: "gender", gender: 0 };
    else if ((flags & 16) !== 0) {
      const pieces: MatchPiece[] = [];
      for (let piece = this.match; piece !== null; piece = piece.next) pieces.push(piece.snapshot());
      test = { kind: "match", pieces };
    } else if ((flags & 8) !== 0) test = { kind: "string", text: this.text };
    else throw new RangeError("unknown source reply key flags");
    return { mode, test };
  }
}

class ChatReplyMessage extends ChatGraphBlock implements ChatMessage {
  get string(): ChatGraphString | null { return this.owner.stringAt(this.readPointer(0)); }
  set string(value: ChatGraphString | null) { this.writePointer(0, value); }
  get text(): string { const value = this.string; if (value === null) throw new RangeError("reply message has a null string pointer"); return value.text; }
  get time(): number { return this.view().getFloat32(4, true); }
  set time(value: number) { this.view().setFloat32(4, value, true); }
  get next(): ChatReplyMessage | null { return this.owner.messageAt(this.readPointer(8)); }
  set next(value: ChatReplyMessage | null) { this.writePointer(8, value); }
}

export class ChatReply extends ChatGraphBlock {
  get keys(): ChatReplyKey | null { return this.owner.keyAt(this.readPointer(0)); }
  set keys(value: ChatReplyKey | null) { this.writePointer(0, value); }
  get priority(): number { return this.view().getFloat32(4, true); }
  set priority(value: number) { this.view().setFloat32(4, value, true); }
  get numMessages(): number { return this.view().getInt32(8, true); }
  set numMessages(value: number) { this.view().setInt32(8, value, true); }
  get firstMessage(): ChatReplyMessage | null { return this.owner.messageAt(this.readPointer(12)); }
  set firstMessage(value: ChatReplyMessage | null) { this.writePointer(12, value); }
  get next(): ChatReply | null { return this.owner.replyAt(this.readPointer(16)); }
  set next(value: ChatReply | null) { this.writePointer(16, value); }
  *messages(): Generator<ChatReplyMessage, undefined, undefined> { for (let value = this.firstMessage; value !== null; value = value.next) yield value; }
  snapshot(): ReplyChat {
    const keys: ReplyKey[] = [], messages: ChatMessage[] = [];
    for (let key = this.keys; key !== null; key = key.next) keys.push(key.snapshot());
    for (const message of this.messages()) messages.push({ text: message.text, time: message.time });
    return { keys, priority: this.priority, messages };
  }
  free(): void {
    for (let reply: ChatReply | null = this; reply !== null;) {
      const next: ChatReply | null = reply.next;
      for (let key = reply.keys; key !== null;) {
        const nextKey = key.next; key.match?.free(); key.string?.freeBlock(); key.freeBlock(); key = nextKey;
      }
      for (let message = reply.firstMessage; message !== null;) {
        const nextMessage = message.next; message.freeBlock(); message = nextMessage;
      }
      reply.freeBlock(); reply = next;
    }
  }
}

/** Release pointer-width record sizing; linked membership remains typed references. */
export class ChatDataMemory {
  private cursor = 0;
  constructor(private readonly allocation: BotMemoryAllocation | null = null) {}
  get byteLength(): number { return this.cursor; }
  reserve(size: number): number {
    const offset = this.cursor;
    this.cursor += size;
    if (this.allocation !== null && this.cursor > this.allocation.bytes.length) throw new RangeError("chat second pass exceeds first-pass allocation");
    return offset;
  }
  private view(): DataView {
    if (this.allocation === null) throw new Error("chat sizing pass has no allocation");
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  integer(offset: number, value: number): () => number {
    if (this.allocation === null) return () => value;
    this.view().setUint32(offset, value, true);
    return () => this.view().getUint32(offset, true);
  }
  float(offset: number, value: number): () => number {
    if (this.allocation === null) return () => value;
    this.view().setFloat32(offset, value, true);
    return () => this.view().getFloat32(offset, true);
  }
  string(value: string): () => string {
    const offset = this.reserve(value.length + 1);
    if (this.allocation === null) return () => value;
    const bytes = this.allocation.bytes;
    for (let index = 0; index < value.length; index++) {
      const byte = value.charCodeAt(index);
      if (byte > 255) throw new RangeError("bot chat strings must contain byte-valued code units");
      bytes[offset + index] = byte;
    }
    bytes[offset + value.length] = 0;
    return () => {
      if (this.allocation === null) throw new Error("chat string lost its allocation");
      const current = this.allocation.bytes;
      let result = "";
      for (let index = offset; index < current.length; index++) {
        const byte = current[index];
        if (byte === undefined) throw new RangeError("chat string exceeds allocation");
        if (byte === 0) return result;
        result += String.fromCharCode(byte);
      }
      throw new RangeError("chat string has no terminator before allocation end");
    };
  }
}

/** Arrays retain the original linked-list order, including each head insertion. */
export class InitialChatNotFoundError extends Error {
  constructor(readonly chatName: string) { super(`couldn't find chat ${chatName}`); }
}

export class ChatDataParser {
  private readonly issues: ScriptDiagnostic[];
  private location: SourceLocation;
  private readonly graph: ChatGraphMemory;
  private matchHead: ChatMatchTemplate | null = null;
  private replyHead: ChatReply | null = null;
  private unfinishedPieces: ChatMatchPiece | null = null;
  private lastRecord: ScriptTokenRecord | undefined;
  private failure: Error | null = null;
  private errorCleanup: "outer" | "pieces" | "graphs" = "outer";

  constructor(private readonly source: ScriptSourceReader, path: string, readonly memory = new ChatDataMemory(), botMemory = new BotMemory(),
    private readonly report?: (issue: ScriptDiagnostic) => undefined) {
    this.issues = [];
    this.location = { path, line: 1, column: 1 };
    this.graph = new ChatGraphMemory(botMemory);
  }

  get diagnostics(): readonly ScriptDiagnostic[] { return [...this.source.diagnostics, ...this.issues]; }
  failedWith(error: unknown): boolean { return this.failure !== null && error === this.failure; }
  dispose(): void { this.source.dispose(); }

  private next(): ScriptToken | undefined {
    this.lastRecord = undefined;
    try {
      this.lastRecord = this.source.next();
    } catch (error) {
      if (!this.source.isSourceFailure(error)) throw error;
      // PC_ReadToken returns false for this read; a later check may read again.
    }
    const token = this.lastRecord?.token;
    this.location = { path: this.source.currentScriptFilename, line: this.source.position.line,
      column: token?.location.column ?? this.location.column };
    return token;
  }

  private unread(token: ScriptToken): void {
    const record = this.lastRecord;
    if (record === undefined || record.token !== token) throw new Error("chat parser can only unread its last source token");
    this.source.unread(record);
  }

  private required(): ScriptToken {
    const token = this.next();
    if (token === undefined) this.fail("couldn't read expected token");
    return token;
  }

  private fail(message: string): never {
    const issue: ScriptDiagnostic = { severity: "error", message, location: this.location };
    this.issues.push(issue);
    this.report?.(issue);
    const error = new ScriptLanguageError(issue, this.diagnostics);
    this.failure = error;
    throw error;
  }

  private emptyPieces(message: string): never {
    this.errorCleanup = "graphs";
    const error = new Error(message);
    this.failure = error;
    throw error;
  }

  private warn(message: string): void {
    const issue: ScriptDiagnostic = { severity: "warning", message, location: this.location };
    this.issues.push(issue);
    this.report?.(issue);
  }

  private check(text: string): boolean {
    const token = this.next();
    if (token === undefined) return false;
    if (token.text === text) return true;
    this.unread(token);
    return false;
  }

  private expect(text: string): void {
    const token = this.next();
    if (token === undefined) this.fail(`couldn't find expected ${text}`);
    if (token.text !== text) this.fail(`expected ${text}, found ${token.text}`);
  }

  private string(): string {
    const token = this.required();
    if (token.kind !== "string") this.fail(`expected a string, found ${token.text}`);
    return stringValue(token.value);
  }

  private number(integer: boolean): number {
    const token = this.required();
    if (token.kind !== "number") this.fail(`expected a number, found ${token.text}`);
    if (integer && (token.flags & NumberFlag.Integer) === 0) throw new RangeError("PC_ExpectTokenType integer-subtype error formats an uninitialized source string");
    const value = integer ? token.integerValue : Math.fround(token.floatValue);
    if (!Number.isFinite(value)) throw new RangeError("chat number exceeds finite source range");
    return value;
  }

  private message(): string {
    let message = "";
    do {
      const token = this.required();
      let text: string;
      if (token.kind === "string") text = stringValue(token.value);
      else if (token.kind === "number" && (token.flags & NumberFlag.Integer) !== 0) {
        if (message.length + 7 > CHAT_MESSAGE_SIZE) this.fail("chat message too long\n");
        text = `${CHAT_ESCAPE}v${token.integerValue}${CHAT_ESCAPE}`;
      } else if (token.kind === "name") {
        if (message.length + 7 > CHAT_MESSAGE_SIZE) this.fail("chat message too long\n");
        text = `${CHAT_ESCAPE}r${token.value}${CHAT_ESCAPE}`;
      } else this.fail(`unknown message component ${token.text}\n`);
      if (message.length + text.length >= CHAT_MESSAGE_SIZE) {
        if (token.kind === "string") this.fail("chat message too long\n");
        throw new RangeError("encoded chat message exceeds the source 256-byte buffer");
      }
      message += text;
      if (this.check(";")) return message;
      this.expect(",");
    } while (true);
  }

  synonyms(): readonly SynonymGroup[] {
    const groups: SynonymGroup[] = [];
    const contexts: number[] = [];
    let context = 0;
    let token: ScriptToken | undefined;
    while ((token = this.next()) !== undefined) {
      if (token.kind === "number") {
        context = (context | token.integerValue) >>> 0;
        contexts.push(token.integerValue);
        if (contexts.length >= 32) this.fail("more than 32 context levels");
        this.expect("{");
      } else if (token.kind === "punctuation") {
        if (token.text === "}") {
          const ended = contexts.pop();
          if (ended === undefined) this.fail("too many }");
          context = (context & ~ended) >>> 0;
        } else if (token.text === "[") {
          const record = this.memory.reserve(16);
          const storedContext = this.memory.integer(record, context);
          let storedTotalWeight = this.memory.float(record + 4, 0);
          const entries: Synonym[] = [];
          let totalWeight = 0;
          do {
            this.expect("(");
            const text = this.string();
            if (text.length === 0) this.fail("empty string");
            const entryRecord = this.memory.reserve(12);
            const storedText = this.memory.string(text);
            this.expect(",");
            const weight = this.number(false);
            this.expect(")");
            totalWeight = Math.fround(totalWeight + weight);
            const storedWeight = this.memory.float(entryRecord + 4, weight);
            storedTotalWeight = this.memory.float(record + 4, totalWeight);
            entries.push({ get text() { return storedText(); }, get weight() { return storedWeight(); } });
            if (this.check("]")) break;
            this.expect(",");
          } while (true);
          const [first, second, ...rest] = entries;
          if (first === undefined || second === undefined) this.fail("synonym must have at least two entries\n");
          groups.push({ get context() { return storedContext(); }, entries: [first, second, ...rest], get totalWeight() { return storedTotalWeight(); } });
        } else this.fail(`unexpected ${token.text}`);
      }
    }
    this.dispose();
    if (contexts.length !== 0) throw new RangeError("BotLoadSynonyms reports a missing context brace through its freed source");
    return groups;
  }

  randoms(): readonly StoredRandomChatList[] {
    const lists: StoredRandomChatList[] = [];
    let token: ScriptToken | undefined;
    while ((token = this.next()) !== undefined) {
      if (token.kind !== "name") this.fail(`unknown random ${token.text}`);
      const record = this.memory.reserve(16);
      const storedName = this.memory.string(token.value);
      let count = this.memory.integer(record + 4, 0);
      this.expect("="); this.expect("{");
      const messages: (() => string)[] = [];
      while (!this.check("}")) {
        const message = this.message();
        this.memory.reserve(8);
        messages.unshift(this.memory.string(message));
        count = this.memory.integer(record + 4, messages.length);
      }
      lists.push({ get name() { return storedName(); }, get numMessages() { return count(); },
        get messages() { return messages.map(read => read()); }, message(index) { return messages[index]?.(); } });
    }
    return lists;
  }

  private pieces(end: string): ChatMatchPiece | null {
    this.errorCleanup = "pieces";
    this.unfinishedPieces = null;
    let lastPiece: ChatMatchPiece | null = null;
    let lastWasVariable = false;
    let token: ScriptToken | undefined;
    while ((token = this.next()) !== undefined) {
      if (token.kind === "number" && (token.flags & NumberFlag.Integer) !== 0) {
        if (token.integerValue < 0 || token.integerValue >= 8) this.fail("can't have more than 8 match variables\n");
        if (lastWasVariable) this.fail("not allowed to have adjacent variables\n");
        lastWasVariable = true;
        const piece = this.graph.newPiece();
        piece.type = 1; piece.variable = token.integerValue;
        if (lastPiece === null) this.unfinishedPieces = piece;
        else lastPiece.next = piece;
        lastPiece = piece;
      } else if (token.kind === "string") {
        const piece = this.graph.newPiece();
        piece.type = 2;
        if (lastPiece === null) this.unfinishedPieces = piece;
        else lastPiece.next = piece;
        lastPiece = piece;
        let lastString: ChatMatchString | null = null, empty = false;
        do {
          const text = lastString === null ? stringValue(token.value) : this.string();
          const value = this.graph.newMatchString(text);
          if (text.length === 0) empty = true;
          if (lastString === null) piece.firstString = value;
          else lastString.next = value;
          lastString = value;
        } while (this.check("|"));
        if (!empty) lastWasVariable = false;
      } else this.fail(`invalid token ${token.text}\n`);
      if (this.check(end)) break;
      this.expect(",");
    }
    const first = this.unfinishedPieces;
    this.unfinishedPieces = null;
    this.errorCleanup = "outer";
    return first;
  }

  matches(): readonly MatchTemplate[] {
    const matches: MatchTemplate[] = [];
    try {
      for (let match = this.matchTemplates(); match !== null; match = match.next) matches.push(match.snapshot());
    } catch (error) {
      if (this.failedWith(error)) this.freeAfterError();
      throw error;
    }
    return matches;
  }

  matchTemplates(): ChatMatchTemplate | null {
    this.matchHead = null;
    let lastMatch: ChatMatchTemplate | null = null;
    while (true) {
      const first = this.next();
      if (first === undefined) return this.matchHead;
      if (first.kind !== "number" || (first.flags & NumberFlag.Integer) === 0) this.fail(`expected integer, found ${first.text}\n`);
      const context = first.integerValue >>> 0;
      this.expect("{");
      let token: ScriptToken | undefined;
      while ((token = this.next()) !== undefined) {
        if (token.text === "}") break;
        this.source.unreadLast();
        const match = this.graph.newTemplate();
        match.context = context;
        if (lastMatch === null) this.matchHead = match;
        else lastMatch.next = match;
        lastMatch = match;
        match.first = this.pieces("=");
        if (match.first === null) this.emptyPieces("empty match template");
        this.expect("("); match.type = this.number(true);
        this.expect(","); match.subtype = this.number(true);
        this.expect(")"); this.expect(";");
      }
    }
  }

  replies(): readonly ReplyChat[] {
    const replies: ReplyChat[] = [];
    try {
      for (let reply = this.replyChats(); reply !== null; reply = reply.next) replies.push(reply.snapshot());
    } catch (error) {
      if (this.failedWith(error)) this.freeAfterError();
      throw error;
    }
    return replies;
  }

  replyChats(): ChatReply | null {
    this.replyHead = null;
    while (true) {
      const first = this.next();
      if (first === undefined) return this.replyHead;
      if (first.text !== "[") this.fail(`expected [, found ${first.text}`);
      const reply = this.graph.newReply();
      reply.next = this.replyHead; this.replyHead = reply;
      do {
        const key = this.graph.newKey();
        key.next = reply.keys; reply.keys = key;
        if (this.check("&")) key.flags |= 1;
        else if (this.check("!")) key.flags |= 2;
        if (this.check("name")) key.flags |= 4;
        else if (this.check("female")) key.flags |= 64;
        else if (this.check("male")) key.flags |= 128;
        else if (this.check("it")) key.flags |= 256;
        else if (this.check("(")) {
          key.flags |= 16; key.match = this.pieces(")");
          if (key.match === null) this.emptyPieces("empty reply match template");
        }
        else if (this.check("<")) {
          key.flags |= 32;
          const names = [this.string()];
          while (this.check(",")) names.push(this.string());
          this.expect(">");
          const joined = names.reduce((result, name) => result.length === 0 ? name : `${result}\\${name}`, "");
          if (joined.length >= CHAT_MESSAGE_SIZE) throw new RangeError("bot name key exceeds the source 256-byte buffer");
          key.string = this.graph.newString(joined);
        } else { key.flags |= 8; key.string = this.graph.newString(this.string()); }
        this.check(",");
      } while (!this.check("]"));
      this.replyWarnings(reply.keys);
      this.expect("=");
      reply.priority = this.number(false);
      this.expect("{");
      reply.numMessages = 0;
      while (!this.check("}")) {
        const message = this.graph.newMessage(this.message());
        message.time = -40;
        message.next = reply.firstMessage;
        reply.firstMessage = message;
        reply.numMessages++;
      }
    }
  }

  /** Error paths free unfinished pieces before their still-null parent field. */
  freeGraphs(): void {
    this.unfinishedPieces?.free(); this.unfinishedPieces = null;
    this.matchHead?.free(); this.matchHead = null;
    this.replyHead?.free(); this.replyHead = null;
  }

  freeAfterError(): void {
    // BotLoadMatchPieces releases the source before its unfinished graph;
    // the outer match/reply loaders free their graphs before FreeSource.
    if (this.errorCleanup === "pieces") this.dispose();
    this.freeGraphs();
    if (this.errorCleanup === "outer") this.dispose();
  }

  private replyWarnings(keys: ChatReplyKey | null): void {
    let allPrefixed = true, hasVariables = false, hasString = false;
    for (let key = keys; key !== null; key = key.next) {
      if ((key.flags & 3) === 0) {
        allPrefixed = false;
        if ((key.flags & 16) !== 0) {
          for (let piece = key.match; piece !== null; piece = piece.next) if (piece.type === 1) hasVariables = true;
        } else if ((key.flags & 8) !== 0) hasString = true;
      } else if ((key.flags & 1) !== 0 && (key.flags & 8) !== 0) {
        for (let other = keys; other !== null; other = other.next) {
          if (other === key || (other.flags & 2) !== 0 || (other.flags & 16) === 0) continue;
          let space = false;
          for (let piece = other.match; piece !== null; piece = piece.next) {
            if (piece.type === 2) {
              for (let value = piece.firstString; value !== null; value = value.next) {
                if (containsChatText(value.text, key.text)) { space = true; break; }
              }
              if (space) break;
            } else if (piece.type === 1) { space = true; break; }
          }
          if (!space) this.warn(`one of the match templates does not leave space for the key ${key.text} with the & prefix`);
        }
      }
      if ((key.flags & 2) !== 0 && (key.flags & 8) !== 0) {
        for (let other = keys; other !== null; other = other.next) {
          if (other === key || (other.flags & 2) !== 0) continue;
          if ((other.flags & 8) !== 0) {
            if (containsChatText(other.text, key.text)) this.warn(`the key ${key.text} with prefix ! is inside the key ${other.text}`);
          } else if ((other.flags & 16) !== 0) {
            for (let piece = other.match; piece !== null; piece = piece.next) {
              if (piece.type !== 2) continue;
              for (let value = piece.firstString; value !== null; value = value.next) {
                if (containsChatText(value.text, key.text)) this.warn(`the key ${key.text} with prefix ! is inside the match template string ${value.text}`);
              }
            }
          }
        }
      }
    }
    if (allPrefixed) this.warn("all keys have a & or ! prefix");
    if (hasVariables && hasString) this.warn("variables from the match template(s) could be invalid when outputting one of the chat messages");
  }

  initial(name: ChatTextSource, previouslyFound?: boolean): InitialChat;
  initial(name: ChatTextSource, previouslyFound: boolean, stored: ChatInitial): void;
  initial(name: ChatTextSource, previouslyFound = false, stored: ChatInitial | null = null): InitialChat | undefined {
    const types: ChatType[] = [];
    this.memory.reserve(4);
    let found = previouslyFound;
    while (true) {
      const token = this.next();
      if (token === undefined) break;
      if (token.text !== "chat") this.fail(`unknown definition ${token.text}\n`);
      const chatName = this.string();
      this.expect("{");
      if (!chatTextEquals(chatName, name)) {
        let depth = 1;
        while (depth > 0) {
          const skipped = this.required();
          if (skipped.text === "{") depth++;
          else if (skipped.text === "}") depth--;
        }
        continue;
      }
      found = true;
      while (true) {
        const typeToken = this.required();
        if (typeToken.text === "}") break;
        if (typeToken.text !== "type") this.fail(`expected type found ${typeToken.text}\n`);
        const typeName = this.string();
        this.expect("{");
        const typeOffset = this.memory.reserve(44), type = stored?.addType(typeOffset, typeName) ?? null;
        const messages: ChatMessage[] = [];
        while (!this.check("}")) {
          const text = this.message(), messageOffset = this.memory.reserve(12);
          if (stored !== null && type !== null) stored.addMessage(type, messageOffset);
          const textOffset = this.memory.reserve(text.length + 1);
          if (stored !== null && type !== null) stored.writeMessage(type, textOffset, text);
          else messages.unshift({ text, time: -40 });
        }
        if (stored === null) types.unshift({ name: typeName, messages });
      }
    }
    this.dispose();
    if (!found) {
      const error = new InitialChatNotFoundError(typeof name === "string" ? name : name());
      this.failure = error;
      throw error;
    }
    return stored === null ? { types } : undefined;
  }
}
