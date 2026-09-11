/*
 * Reusable chat AI translated from id Software's botlib/be_ai_chat.c and
 * game/be_ai_chat.h. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { ScriptDiagnostic, SourceLocation } from "../script/lexer.ts";
import { ScriptSourceReader } from "../script/preprocessor.ts";
import { finishCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { BotActionHost } from "./actions.ts";
import type { BotScriptReader } from "./script-sources.ts";
import type { BotRandom } from "./weights.ts";
import type { BotLog } from "./log.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";
import { CHAT_ESCAPE, CHAT_MESSAGE_SIZE, ChatDataMemory, ChatDataParser, ChatInitial, InitialChatNotFoundError, chatTextEquals, type ChatMessage, type ChatTextSource, type InitialChat, type ChatMatchPiece, type ChatMatchTemplate, type ChatReply, type ChatReplyKey, type MatchTemplate, type RandomChatList, type ReplyChat, type SynonymGroup } from "./chat-data.ts";
import type { StoredRandomChatList } from "./chat-data.ts";
export type { ChatTextSource } from "./chat-data.ts";

export enum ChatGender { Genderless = 0, Female = 1, Male = 2 }
export enum ChatDestination { All = 0, Team = 1, Tell = 2 }
export type ChatVariables = readonly [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null];
export type ChatVariableSources = readonly [ChatTextSource | null, ChatTextSource | null, ChatTextSource | null, ChatTextSource | null, ChatTextSource | null, ChatTextSource | null, ChatTextSource | null, ChatTextSource | null];
export type ChatCapture = { readonly kind: "absent" } | { readonly kind: "present"; readonly offset: number; readonly length: number };
export type ChatCaptures = readonly [ChatCapture, ChatCapture, ChatCapture, ChatCapture, ChatCapture, ChatCapture, ChatCapture, ChatCapture];
export interface ChatMatch { readonly text: string; readonly type: number; readonly subtype: number; readonly variables: ChatCaptures }
export interface ConsoleChatMessage { readonly handle: number; readonly time: number; readonly type: number; readonly message: string }
export interface ChatDiagnostic {
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly code: "loaded" | "empty-replies" | "load-error" | "parse-warning" | "invalid-handle" | "invalid-variable" | "message-heap-full" | "cache-full" | "expansion-error" | "expansion-limit" | "test-output" | "print-fragment" | "missing-random" | "integrity-error";
  readonly source: string;
  readonly message: string;
  readonly location: SourceLocation | null;
}
export interface BotChatHost extends BotActionHost { readonly random: BotRandom; time(): number; report?(diagnostic: ChatDiagnostic): void }
export interface BotChatOptions {
  readonly debug?: { readonly milliseconds: () => number };
  readonly log?: Pick<BotLog, "write" | "filePointer">;
  readonly maxMessages?: number | (() => number);
  readonly synonymFile?: string;
  readonly randomFile?: string;
  readonly matchFile?: string;
  readonly replyFile?: string;
  readonly noChat?: () => boolean;
  readonly reloadCharacters?: () => boolean;
  readonly testInitialChats?: () => boolean;
  readonly testReplyChats?: () => boolean;
  readonly developer?: () => boolean;
}
export interface ChatConfigurationCounts { readonly synonyms: number; readonly randomLists: number; readonly matches: number; readonly replies: number }
export interface ChatConfiguration {
  readonly synonyms: readonly SynonymGroup[];
  readonly randomLists: readonly RandomChatList[];
  readonly matches: readonly MatchTemplate[];
  readonly replies: readonly ReplyChat[];
}

export interface ChatMatchVariable { offset: number; length: number }
export type ChatMatchVariables = [ChatMatchVariable, ChatMatchVariable, ChatMatchVariable, ChatMatchVariable, ChatMatchVariable, ChatMatchVariable, ChatMatchVariable, ChatMatchVariable];
export interface ChatMatchBuffer {
  readonly string: Uint8Array | null;
  type: number;
  subtype: number;
  readonly variables: ChatMatchVariables;
}
type RawCapture = ChatMatchVariable;
type RawCaptures = ChatMatchVariables;
interface RawMatch { text: string; readonly variables: RawCaptures }
interface ChatGeneration { readonly cache: (CachedChat | undefined)[]; setupRevision: number }
const NO_VARIABLES: ChatVariables = [null, null, null, null, null, null, null, null];

const CONSOLE_MESSAGE_BYTES = 276;
const CHAT_STATE_BYTES = 316;
const CHAT_CACHE_BYTES = 132;
function chatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";
  const negative = value < 0 || Object.is(value, -0), absolute = Math.abs(value);
  if (absolute >= 1e21) return `${negative ? "-" : ""}${BigInt(absolute)}${digits === 0 ? "" : `.${"0".repeat(digits)}`}`;
  const scale = 10 ** digits, scaled = absolute * scale, whole = Math.floor(scaled);
  if (Number.isSafeInteger(whole) && scaled - whole === 0.5) {
    const rounded = whole % 2 === 0 ? whole : whole + 1;
    return `${negative ? "-" : ""}${(rounded / scale).toFixed(digits)}`;
  }
  return `${negative ? "-" : ""}${absolute.toFixed(digits)}`;
}
class ChatSetupRetired extends Error {}
class ChatSourceCallbackAbort extends Error {
  constructor(readonly reason: unknown) { super("chat source callback aborted"); }
}

function chatSourceCallback<T>(callback: () => T, current: () => boolean): T {
  try {
    const value = callback();
    if (!current()) throw new ChatSetupRetired();
    return value;
  } catch (error) {
    throw new ChatSourceCallbackAbort(error);
  }
}

function initialChatAt(chats: ReadonlyMap<number, ChatInitial>, pointer: number): ChatInitial | null {
  if (pointer === 0) return null;
  const chat = chats.get(pointer);
  if (chat === undefined) throw new RangeError("initial chat pointer is outside the owned chat allocations");
  return chat;
}

/** Release32 bot_chatstate_t; pointer words identify typed allocation views. */
class ChatState {
  revision = 0;
  constructor(readonly allocation: BotMemoryAllocation, private readonly consoleCells: ReadonlyMap<number, ConsoleMessageCell>,
    private readonly chats: ReadonlyMap<number, ChatInitial>) {}
  private view(): DataView { const bytes = this.allocation.bytes; return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get gender(): number { return this.view().getInt32(0, true); }
  set gender(value: number) { this.view().setInt32(0, value, true); }
  get client(): number { return this.view().getInt32(4, true); }
  set client(value: number) { this.view().setInt32(4, value, true); }
  get name(): string { return readMessage(this.allocation.bytes.subarray(8, 40)); }
  set name(value: string) { const bytes = this.allocation.bytes; copyChatText(bytes, 8, value, 32); bytes[39] = 0; }
  get message(): Uint8Array { return this.allocation.bytes.subarray(40, 296); }
  get handle(): number { return this.view().getInt32(296, true); }
  set handle(value: number) { this.view().setInt32(296, value, true); }
  private consoleMessage(offset: number): ConsoleMessageCell | null {
    const pointer = this.view().getUint32(offset, true);
    if (pointer === 0) return null;
    const message = this.consoleCells.get(pointer);
    if (message === undefined) throw new RangeError("chat state console pointer is outside the owned heaps");
    return message;
  }
  get firstMessage(): ConsoleMessageCell | null { return this.consoleMessage(300); }
  set firstMessage(value: ConsoleMessageCell | null) { this.view().setUint32(300, value?.pointer ?? 0, true); }
  get lastMessage(): ConsoleMessageCell | null { return this.consoleMessage(304); }
  set lastMessage(value: ConsoleMessageCell | null) { this.view().setUint32(304, value?.pointer ?? 0, true); }
  get numConsoleMessages(): number { return this.view().getInt32(308, true); }
  set numConsoleMessages(value: number) { this.view().setInt32(308, value, true); }
  get chat(): ChatInitial | null { return initialChatAt(this.chats, this.view().getUint32(312, true)); }
  set chat(value: ChatInitial | null) { this.view().setUint32(312, value?.pointer ?? 0, true); }
}

/** Release32 bot_ichatdata_t retains the source cache pointer and fixed strings. */
class CachedChat {
  constructor(readonly allocation: BotMemoryAllocation, private readonly chats: ReadonlyMap<number, ChatInitial>) {}
  private view(): DataView { const bytes = this.allocation.bytes; return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get chat(): ChatInitial | null { return initialChatAt(this.chats, this.view().getUint32(0, true)); }
  set chat(value: ChatInitial | null) { this.view().setUint32(0, value?.pointer ?? 0, true); }
  get path(): string { return readMessage(this.allocation.bytes.subarray(4, 68)); }
  set path(value: string) { writeMessage(this.allocation.bytes.subarray(4, 68), value); }
  get name(): string { return readMessage(this.allocation.bytes.subarray(68, 132)); }
  set name(value: string) { writeMessage(this.allocation.bytes.subarray(68, 132), value); }
}

function* replyMessages(first: ChatReply | null): Generator<ChatMessage, undefined, undefined> {
  for (let reply = first; reply !== null; reply = reply.next) yield* reply.messages();
}

class ConsoleMessageCell {
  constructor(private readonly allocation: BotMemoryAllocation, private readonly offset: number,
    readonly pointer: number, private readonly cells: ReadonlyMap<number, ConsoleMessageCell>) {}
  private bytes(): Uint8Array { return this.allocation.bytes.subarray(this.offset, this.offset + CONSOLE_MESSAGE_BYTES); }
  private view(): DataView { const bytes = this.bytes(); return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get handle(): number { return this.view().getInt32(0, true); }
  set handle(value: number) { this.view().setInt32(0, value, true); }
  get time(): number { return this.view().getFloat32(4, true); }
  set time(value: number) { this.view().setFloat32(4, value, true); }
  get type(): number { return this.view().getInt32(8, true); }
  set type(value: number) { this.view().setInt32(8, value, true); }
  get message(): string { const bytes = this.bytes().subarray(12, 268), end = bytes.indexOf(0); return byteText(end < 0 ? bytes : bytes.subarray(0, end)); }
  set message(value: string) { copyChatText(this.bytes(), 12, value, CHAT_MESSAGE_SIZE); }
  private link(offset: number): ConsoleMessageCell | null {
    const pointer = this.view().getUint32(offset, true);
    if (pointer === 0) return null;
    const cell = this.cells.get(pointer);
    if (cell === undefined) throw new RangeError("console message link is outside the owned heaps");
    return cell;
  }
  get prev(): ConsoleMessageCell | null { return this.link(268); }
  set prev(value: ConsoleMessageCell | null) { this.view().setUint32(268, value?.pointer ?? 0, true); }
  get next(): ConsoleMessageCell | null { return this.link(272); }
  set next(value: ConsoleMessageCell | null) { this.view().setUint32(272, value?.pointer ?? 0, true); }
  snapshot(): ConsoleChatMessage { return { handle: this.handle, time: this.time, type: this.type, message: this.message }; }
}

function byteCString(text: string): string {
  const nul = text.indexOf("\0");
  const value = nul < 0 ? text : text.slice(0, nul);
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) > 255) throw new RangeError("bot chat strings must contain byte-valued code units");
  return value;
}
function chatText(input: ChatTextSource): string { return byteCString(typeof input === "string" ? input : input()); }
function boundedChatText(input: ChatTextSource, count: number): string {
  return byteCString((typeof input === "string" ? input : input(count)).slice(0, count));
}
function messageText(text: string): string {
  const value = byteCString(text);
  if (value.length >= CHAT_MESSAGE_SIZE) throw new RangeError("chat text exceeds the source 256-byte buffer");
  return value;
}
function asciiUpper(text: string): string { return text.replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32)); }
function byteText(bytes: Uint8Array): string { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return text; }
function readMessage(bytes: Uint8Array): string { const nul = bytes.indexOf(0); return byteText(nul < 0 ? bytes : bytes.subarray(0, nul)); }
function writeMessage(bytes: Uint8Array, text: string, offset = 0): void {
  if (offset + text.length >= bytes.length) throw new RangeError("expanded chat exceeds the source 256-byte buffer");
  for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
  bytes[offset + text.length] = 0;
}
function chatSpan(bytes: Uint8Array | null, offset: number, count: number): Uint8Array {
  if (bytes === null) throw new RangeError("bot chat buffer requires a nonnull pointer");
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 || offset + count > bytes.length) {
    throw new RangeError("bot chat buffer exceeds allocation");
  }
  return bytes.subarray(offset, offset + count);
}
function chatByte(bytes: Uint8Array | null, offset: number): number {
  const value = chatSpan(bytes, offset, 1)[0];
  if (value === undefined) throw new RangeError("bot chat byte exceeds allocation");
  return value;
}
function chatCString(bytes: Uint8Array | null): string {
  if (bytes === null) throw new RangeError("bot chat string requires a nonnull pointer");
  const end = bytes.indexOf(0);
  if (end < 0) throw new RangeError("bot chat string has no terminator before allocation end");
  return byteText(bytes.subarray(0, end));
}
function copyChatText(bytes: Uint8Array | null, offset: number, text: string, count: number): void {
  const destination = chatSpan(bytes, offset, count);
  const copied = Math.min(text.length, count);
  for (let index = 0; index < copied; index++) destination[index] = text.charCodeAt(index);
  destination.fill(0, copied);
}
function rawCaptures(): RawCaptures { return [{ offset: 0, length: 0 }, { offset: 0, length: 0 }, { offset: 0, length: 0 }, { offset: 0, length: 0 }, { offset: 0, length: 0 }, { offset: 0, length: 0 }, { offset: 0, length: 0 }, { offset: 0, length: 0 }]; }
function capture(match: RawMatch, index: number): RawCapture { const value = match.variables[index]; if (value === undefined) throw new RangeError("match variable outside 0..7"); return value; }
function publicCapture(value: RawCapture): ChatCapture { return value.offset < 0 ? { kind: "absent" } : { kind: "present", offset: value.offset, length: value.length }; }
function publicCaptures(values: RawCaptures): ChatCaptures { return [publicCapture(values[0]), publicCapture(values[1]), publicCapture(values[2]), publicCapture(values[3]), publicCapture(values[4]), publicCapture(values[5]), publicCapture(values[6]), publicCapture(values[7])]; }
function copyMatch(match: RawMatch): RawMatch { const variables = rawCaptures(); for (let index = 0; index < 8; index++) Object.assign(capture({ text: "", variables }, index), capture(match, index)); return { text: match.text, variables }; }
function sourceRandom(random: BotRandom): number {
  const value = random.nextInt();
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) throw new RangeError("bot random result must be an int32 or uint32");
  return Math.fround((value & 0x7fff) / 32767);
}

export function stringContains(text: ChatTextSource | null, part: ChatTextSource | null, caseSensitive = false): number {
  if (text === null || part === null) return -1;
  const input = chatText(text), needle = chatText(part);
  return caseSensitive ? input.indexOf(needle) : asciiUpper(input).indexOf(asciiUpper(needle));
}
function wordDelimiter(character: string): boolean { return character === " " || character === "." || character === "," || character === "!"; }
function wordIndex(text: string, part: string, start = 0): number {
  const end = text.length - start - part.length;
  let pointer = start;
  const upper = asciiUpper(text), needle = asciiUpper(part);
  for (let index = 0; index <= end; index++, pointer++) {
    if (index !== 0) {
      while (pointer < text.length && !wordDelimiter(text.charAt(pointer))) pointer++;
      if (pointer === text.length) break;
      pointer++;
    }
    if (upper.slice(pointer, pointer + needle.length) === needle
      && (pointer + needle.length === text.length || wordDelimiter(text.charAt(pointer + needle.length)))) return pointer;
  }
  return -1;
}
function replaceWords(text: string, synonym: string, replacement: string,
  publish?: (offset: number, tail: string, replacement: string) => void): string {
  let found = wordIndex(text, synonym);
  while (found >= 0) {
    let prior = wordIndex(text, replacement);
    while (prior >= 0 && !(prior <= found && found < prior + replacement.length)) prior = wordIndex(text, replacement, prior + 1);
    if (prior < 0) {
      const tail = text.slice(found + synonym.length);
      publish?.(found, tail, replacement);
      text = text.slice(0, found) + replacement + tail;
    }
    found = wordIndex(text, synonym, found + replacement.length);
  }
  return text;
}
function whiteSpace(byte: number): boolean { return !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || "()?:'/,.[]-_+=".includes(String.fromCharCode(byte))); }

/** Preserves UnifyWhiteSpaces' moving-pointer behavior after each memmove. */
export function unifyWhiteSpaces(input: string): string {
  const text = byteCString(input);
  const bytes = new Uint8Array(text.length + 1);
  writeMessage(bytes, text);
  unifyWhiteSpacesInPlace(bytes);
  return readMessage(bytes);
}

/** Runs the original byte moves against the caller's live string allocation. */
export function unifyWhiteSpacesInPlace(bytes: Uint8Array | null): void {
  function at(index: number): number { return chatByte(bytes, index); }
  let pointer = 0, old = 0;
  while (at(pointer) !== 0) {
    while (at(pointer) !== 0 && whiteSpace(at(pointer))) pointer++;
    if (pointer > old) {
      if (old > 0 && at(pointer) !== 0) chatSpan(bytes, old++, 1)[0] = 32;
      if (pointer > old) {
        let end = pointer;
        while (at(end) !== 0) end++;
        chatSpan(bytes, old, end + 1 - pointer).set(chatSpan(bytes, pointer, end + 1 - pointer));
      }
    }
    while (at(pointer) !== 0 && !whiteSpace(at(pointer))) pointer++;
    old = pointer;
  }
}
function removeTildes(text: string): string { for (let index = 0; index < text.length; index++) if (text.charAt(index) === "~") text = text.slice(0, index) + text.slice(index + 1); return text; }

function stringsMatch(pieces: ChatMatchPiece | null, match: RawMatch): boolean {
  let lastVariable = -1, pointer = 0;
  for (let piece = pieces; piece !== null; piece = piece.next) {
    if (piece.type === 1) {
      capture(match, piece.variable).offset = (pointer << 24) >> 24;
      lastVariable = piece.variable;
      continue;
    }
    if (piece.type !== 2) continue;
    let nextPointer = -1;
    for (let value = piece.firstString; value !== null; value = value.next) {
      const alternative = value.text;
      if (alternative.length === 0) { nextPointer = pointer; break; }
      const index = stringContains(match.text.slice(pointer), alternative);
      if (index < 0) continue;
      if (lastVariable >= 0) {
        const variable = capture(match, lastVariable);
        variable.length = pointer + index - variable.offset;
        lastVariable = -1;
        nextPointer = pointer + index + alternative.length;
        break;
      }
      if (index === 0) { nextPointer = pointer + alternative.length; break; }
    }
    if (nextPointer < 0) return false;
    pointer = nextPointer;
  }
  if (lastVariable < 0) return pointer === match.text.length;
  const variable = capture(match, lastVariable);
  if (variable.offset < 0) throw new RangeError("source signed-char match offset overflow");
  variable.length = match.text.length - variable.offset;
  return true;
}

export class BotChatLibrary {
  private generation: ChatGeneration = { cache: [], setupRevision: 0 };
  private readonly states: (ChatState | undefined)[] = Array.from({ length: 65 }, () => undefined);
  private readonly issues: ChatDiagnostic[] = [];
  private synonyms: readonly SynonymGroup[] = [];
  private randoms: readonly StoredRandomChatList[] = [];
  private synonymsAllocation: BotMemoryAllocation | null = null;
  private randomsAllocation: BotMemoryAllocation | null = null;
  private matches: ChatMatchTemplate | null = null;
  private replies: ChatReply | null = null;
  private consoleMessageHeap: BotMemoryAllocation | null = null;
  private freeConsoleMessages: ConsoleMessageCell | null = null;
  private readonly consoleMessageCells = new Map<number, ConsoleMessageCell>();
  private readonly initialChats = new Map<number, ChatInitial>();

  constructor(private readonly reader: BotScriptReader, private readonly host: BotChatHost, private readonly options: BotChatOptions = {}, private readonly memory = new BotMemory()) {}
  get diagnostics(): readonly ChatDiagnostic[] { return [...this.issues]; }
  get configurationCounts(): ChatConfigurationCounts {
    let matches = 0, replies = 0;
    for (let match = this.matches; match !== null; match = match.next) matches++;
    for (let reply = this.replies; reply !== null; reply = reply.next) replies++;
    return { synonyms: this.synonyms.length, randomLists: this.randoms.length, matches, replies };
  }
  dumpConfiguration(): ChatConfiguration {
    const matches: MatchTemplate[] = [], replies: ReplyChat[] = [];
    for (let match = this.matches; match !== null; match = match.next) matches.push(match.snapshot());
    for (let reply = this.replies; reply !== null; reply = reply.next) replies.push(reply.snapshot());
    return structuredClone({ synonyms: this.synonyms, randomLists: this.randoms.map(list => ({ name: list.name, messages: list.messages })), matches, replies });
  }
  dumpInitialChat(handle: number): InitialChat | null { return this.state(handle)?.chat?.snapshot() ?? null; }
  dumpSynonymList(): void {
    const file = this.options.log?.filePointer();
    if (file === null || file === undefined) return;
    for (const group of this.synonyms) {
      file.write(`${group.context | 0} : [`);
      for (let index = 0; index < group.entries.length; index++) {
        const synonym = group.entries[index];
        if (synonym === undefined) throw new RangeError("missing stored chat synonym");
        file.write(`("${synonym.text}", ${chatFixed(synonym.weight, 2)})`);
        if (index + 1 < group.entries.length) file.write(", ");
      }
      file.write("]\n");
    }
  }
  dumpRandomStringList(): void {
    const file = this.options.log?.filePointer();
    if (file === null || file === undefined) return;
    for (const list of this.randoms) {
      file.write(`${list.name} = {`);
      for (let index = 0; index < list.messages.length; index++) {
        const message = list.messages[index];
        if (message === undefined) throw new RangeError("missing stored random chat string");
        file.write(`"${message}"`);
        file.write(index + 1 < list.messages.length ? ", " : "}\n");
      }
    }
  }
  dumpMatchTemplates(): void {
    const file = this.options.log?.filePointer();
    if (file === null || file === undefined) return;
    for (let match = this.matches; match !== null; match = match.next) {
      file.write("{ ");
      for (let piece = match.first; piece !== null; piece = piece.next) {
        if (piece.type === 2) {
          for (let text = piece.firstString; text !== null; text = text.next) {
            file.write(`"${text.text}"`);
            if (text.next !== null) file.write("|");
          }
        } else if (piece.type === 1) file.write(String(piece.variable));
        if (piece.next !== null) file.write(", ");
      }
      file.write(` = (${match.type}, ${match.subtype});}\n`);
    }
  }
  dumpReplyChat(): void {
    const file = this.options.log?.filePointer();
    if (file === null || file === undefined) return;
    file.write("BotDumpReplyChat:\n");
    for (let reply = this.replies; reply !== null; reply = reply.next) {
      this.writeReplyChatKeys(reply, text => file.write(text));
      for (const message of reply.messages()) file.write(`\t"${message.text}";\n`);
      file.write("}\n");
    }
  }
  logInitialChat(handle: number): void {
    const chat = this.state(handle)?.chat;
    if (chat === null || chat === undefined) return;
    this.options.log?.write("{");
    for (let type = chat.firstType; type !== null; type = type.next) {
      this.options.log?.write(` type "${type.name}"`);
      this.options.log?.write(" {");
      this.options.log?.write(`  numchatmessages = ${type.numMessages}`);
      for (const message of type.messages()) this.options.log?.write(`  "${message.text}"`);
      this.options.log?.write(" }");
    }
    this.options.log?.write("}");
  }
  printReplyChatKeys(index: number): void {
    if (!Number.isInteger(index) || index < 0) throw new RangeError("reply chat index must be nonnegative");
    let reply = this.replies;
    for (let current = 0; current < index && reply !== null; current++) reply = reply.next;
    if (reply === null) throw new RangeError("reply chat index is outside the stored reply list");
    this.writeReplyChatKeys(reply, text => this.report("info", "print-fragment", text));
  }
  private writeReplyChatKeys(reply: ChatReply, write: (text: string) => void): void {
    write("[");
    for (let key = reply.keys; key !== null; key = key.next) {
      if ((key.flags & 1) !== 0) write("&");
      else if ((key.flags & 2) !== 0) write("!");
      if ((key.flags & 4) !== 0) write("name");
      else if ((key.flags & 64) !== 0) write("female");
      else if ((key.flags & 128) !== 0) write("male");
      else if ((key.flags & 256) !== 0) write("it");
      else if ((key.flags & 16) !== 0) {
        write("(");
        for (let piece = key.match; piece !== null; piece = piece.next) {
          if (piece.type === 2) {
            const first = piece.firstString;
            if (first === null) throw new RangeError("reply match string has no first alternative");
            write(`"${first.text}"`);
          } else write(String(piece.variable));
          if (piece.next !== null) write(", ");
        }
        write(")");
      } else if ((key.flags & 8) !== 0) write(`"${key.text}"`);
      if (key.next !== null) write(", ");
      else write(`] = ${chatFixed(reply.priority, 0)}\n`);
    }
    write("{\n");
  }
  private report(severity: ChatDiagnostic["severity"], code: ChatDiagnostic["code"], message: string, source = "", location: SourceLocation | null = null): void {
    const issue: ChatDiagnostic = { severity, code, source, message, location };
    this.issues.push(issue); this.host.report?.(issue);
  }
  private time(): number { const time = Math.fround(this.host.time()); if (!Number.isFinite(time)) throw new RangeError("chat time must be finite float32"); return time; }
  private state(handle: number): ChatState | undefined {
    if (!Number.isInteger(handle) || handle < 1 || handle > 64) {
      this.report("fatal", "invalid-handle", `chat state handle ${handle} out of range`);
      return undefined;
    }
    const state = this.states[handle];
    if (state === undefined) this.report("fatal", "invalid-handle", `invalid chat state ${handle}`);
    return state;
  }
  private parser(path: string, current: () => boolean, memory: ChatDataMemory): ChatDataParser | undefined {
    const source = chatSourceCallback(() => this.reader.resolveRoot(path), current);
    if (source === undefined) return undefined;
    const report = (issue: ScriptDiagnostic): undefined => {
      chatSourceCallback(() => this.report(issue.severity, issue.severity === "error" ? "load-error" : "parse-warning",
        issue.message, issue.location.path, issue.location), current);
      return undefined;
    };
    const stream = ScriptSourceReader.open(source, {
      resolve: request => chatSourceCallback(() => this.reader.resolve(request), current),
    }, { globals: this.reader.globals, report,
      ...(this.reader.debugEval === undefined ? {} : { debugEval: (text: string) => chatSourceCallback(() => this.reader.debugEval?.(text), current) }),
    });
    return new ChatDataParser(stream, source.path, memory, this.memory, report);
  }

  setup(): void {
    const startTime = this.options.debug?.milliseconds();
    const generation = this.generation, revision = ++generation.setupRevision;
    const current = (): boolean => this.generation === generation && revision === generation.setupRevision;
    const load = <T>(path: string, parse: (parser: ChatDataParser) => T, publish: (value: T, allocation: BotMemoryAllocation | null) => void,
      empty: T, passes = 1, finish?: (value: T) => boolean, timed = false): boolean => {
      const loadStart = timed ? this.options.debug?.milliseconds() : undefined;
      let value = empty;
      let size = 0;
      let allocation: BotMemoryAllocation | null = null;
      for (let pass = 0; pass < passes; pass++) {
        if (!current()) return false;
        allocation = pass > 0 && size > 0 ? this.memory.allocate(size, "hunk", true) : null;
        const storage = new ChatDataMemory(allocation);
        if (!current()) return false;
        let parser: ChatDataParser | undefined;
        try {
          parser = this.parser(path, current, storage);
          if (parser !== undefined) value = parse(parser);
        } catch (error) {
          if (error instanceof ChatSourceCallbackAbort) {
            if (error.reason instanceof ChatSetupRetired) return false;
            throw error.reason;
          }
          if (parser === undefined || !parser.failedWith(error)) throw error;
          if (!current()) return false;
          parser.freeAfterError();
          publish(empty, null);
          return true;
        }
        if (!current()) return false;
        if (parser === undefined) {
          this.report("error", "load-error", `counldn't load ${path}`, path);
          if (!current()) return false;
          publish(empty, null);
          return true;
        }
        parser.dispose();
        size = storage.byteLength;
      }
      this.report("info", "loaded", `loaded ${path}`, path);
      if (!current()) return false;
      if (loadStart !== undefined && this.options.debug !== undefined) {
        this.report("info", "loaded", `random strings ${(this.options.debug.milliseconds() - loadStart) | 0} msec`, path);
      }
      if (!current() || (finish !== undefined && !finish(value))) return false;
      publish(value, allocation);
      return true;
    };
    if (!load(this.options.synonymFile ?? "syn.c", parser => parser.synonyms(), (value, allocation) => {
      this.synonyms = value; this.synonymsAllocation = value.length === 0 ? null : allocation;
    }, [], 2)) return;
    if (!load(this.options.randomFile ?? "rnd.c", parser => parser.randoms(), (value, allocation) => {
      this.randoms = value; this.randomsAllocation = value.length === 0 ? null : allocation;
    }, [], 2, undefined, true)) return;
    if (!load(this.options.matchFile ?? "match.c", parser => parser.matchTemplates(), value => { this.matches = value; }, null)) return;
    const noChat = this.options.noChat?.() ?? false;
    if (!current()) return;
    if (!noChat && !load(this.options.replyFile ?? "rchat.c", parser => parser.replyChats(), value => { this.replies = value; }, null, 1, replies => {
      const developer = this.options.developer?.() ?? false;
      if (!current()) return false;
      if (developer) this.checkIntegrity(replyMessages(replies), current);
      if (!current()) return false;
      if (replies === null) this.report("info", "empty-replies", "no rchats");
      return current();
    })) return;
    if (!current()) return;
    if (this.consoleMessageHeap !== null) this.memory.free(this.consoleMessageHeap);
    const configuredMaxMessages = this.options.maxMessages ?? 1024;
    if (!current()) return;
    const value = typeof configuredMaxMessages === "function" ? configuredMaxMessages() : configuredMaxMessages;
    if (!current()) return;
    const maxMessages = Math.trunc(Math.fround(value));
    if (!Number.isInteger(maxMessages) || maxMessages < 2 || maxMessages > 0x7fffffff) {
      throw new RangeError("InitConsoleMessageHeap: max_messages must truncate to at least 2 within the source int32 range");
    }
    const heap = this.memory.allocate(maxMessages * CONSOLE_MESSAGE_BYTES, "hunk", true);
    if (!current()) return;
    this.consoleMessageHeap = heap;
    let first: ConsoleMessageCell | null = null, previous: ConsoleMessageCell | null = null;
    for (let index = 0; index < maxMessages; index++) {
      const cell = new ConsoleMessageCell(heap, index * CONSOLE_MESSAGE_BYTES, this.consoleMessageCells.size + 1, this.consoleMessageCells);
      this.consoleMessageCells.set(cell.pointer, cell);
      cell.prev = previous;
      if (previous === null) first = cell;
      else previous.next = cell;
      previous = cell;
    }
    this.freeConsoleMessages = first;
    if (startTime !== undefined && this.options.debug !== undefined) {
      this.report("info", "loaded", `setup chat AI ${(this.options.debug.milliseconds() - startTime) | 0} msec`);
    }
  }

  shutdown(): void {
    const generation: ChatGeneration = { cache: this.generation.cache, setupRevision: 0 };
    this.generation = generation;
    // BotShutdownChatAI intentionally visits 0..63, leaving source handle 64.
    for (let handle = 0; handle < 64; handle++) {
      if (this.states[handle] !== undefined) this.free(handle);
      if (this.generation !== generation || generation.setupRevision !== 0) return;
    }
    for (let index = 0; index < 64; index++) {
      const cached = generation.cache[index];
      if (cached === undefined) continue;
      const chat = cached.chat;
      if (chat !== null) this.memory.free(chat.allocation);
      this.memory.free(cached.allocation);
      generation.cache[index] = undefined;
    }
    if (this.consoleMessageHeap !== null) this.memory.free(this.consoleMessageHeap);
    this.consoleMessageHeap = null;
    this.matches?.free(); this.matches = null;
    if (this.randomsAllocation !== null) this.memory.free(this.randomsAllocation);
    this.randomsAllocation = null; this.randoms = [];
    if (this.synonymsAllocation !== null) this.memory.free(this.synonymsAllocation);
    this.synonymsAllocation = null; this.synonyms = [];
    this.replies?.free(); this.replies = null;
  }
  disposeResources(): void {
    this.generation = { cache: [], setupRevision: 0 };
    this.states.fill(undefined); this.freeConsoleMessages = null;
    this.consoleMessageHeap = null; this.consoleMessageCells.clear();
    this.initialChats.clear();
    this.synonymsAllocation = null; this.randomsAllocation = null;
    this.synonyms = []; this.randoms = []; this.matches = null; this.replies = null;
  }
  reset(): void { for (let reply = this.replies; reply !== null; reply = reply.next) for (const message of reply.messages()) message.time = 0; }
  allocate(): number {
    for (let handle = 1; handle <= 64; handle++) if (this.states[handle] === undefined) {
      const allocation = this.memory.allocate(CHAT_STATE_BYTES, "heap", true);
      this.states[handle] = new ChatState(allocation, this.consoleMessageCells, this.initialChats);
      return handle;
    }
    return 0;
  }
  free(handle: number): void {
    const state = this.state(handle); if (state === undefined) return;
    const generation = this.generation;
    const reload = this.options.reloadCharacters?.() ?? false;
    if (this.generation !== generation || this.states[handle] !== state) return;
    if (reload) this.freeChatFile(handle);
    for (let message = this.nextConsoleMessage(handle); message !== null && message.handle !== 0; message = this.nextConsoleMessage(handle)) this.removeConsoleMessage(handle, message.handle);
    this.memory.free(state.allocation);
    state.revision++; this.states[handle] = undefined;
  }
  freeChatFile(handle: number): void {
    const state = this.state(handle); if (state === undefined) return;
    const chat = state.chat;
    if (chat !== null) this.memory.free(chat.allocation);
    state.chat = null; state.revision++;
  }

  loadChatFile(handle: number, path: ChatTextSource, name: ChatTextSource): boolean {
    const state = this.state(handle); if (state === undefined) return false;
    this.freeChatFile(handle);
    const generation = this.generation, revision = state.revision;
    const current = (): boolean => this.generation === generation && this.states[handle] === state && state.revision === revision;
    const reload = this.options.reloadCharacters?.() ?? false;
    if (!current()) return false;
    let available = 0;
    if (!reload) {
      available = -1;
      for (let index = 0; index < 64; index++) {
        const cached = generation.cache[index];
        if (cached === undefined) { if (available === -1) available = index; continue; }
        const samePath = chatTextEquals(cached.path, path, true);
        if (!current()) return false;
        if (!samePath) continue;
        const sameName = chatTextEquals(cached.name, name, true);
        if (!current()) return false;
        if (sameName) { state.chat = cached.chat; return true; }
      }
      if (available === -1) {
        const chatName = chatText(name), filename = chatText(path);
        this.report("fatal", "cache-full", `ichatdata table full; couldn't load chat ${chatName} from ${filename}`, filename);
        return false;
      }
    }
    const failedLoad = (): false => {
      if (!current()) return false;
      state.chat = null;
      const chatName = chatText(name), filename = chatText(path);
      this.report("fatal", "load-error", `couldn't load chat ${chatName} from ${filename}`, filename);
      return false;
    };
    const sourceName: ChatTextSource = typeof name === "string" ? name
      : maximumBytes => chatSourceCallback(() => name(maximumBytes), current);
    const startTime = this.options.debug?.milliseconds();
    let chat: ChatInitial | null = null, size = 0;
    for (let pass = 0; pass < 2; pass++) {
      const allocation = pass > 0 && size > 0 ? this.memory.allocate(size, "heap", true) : null;
      if (!current()) return false;
      const storage = new ChatDataMemory(allocation);
      if (allocation !== null) {
        chat = new ChatInitial(allocation, this.initialChats.size + 1);
        this.initialChats.set(chat.pointer, chat);
      }
      let parser: ChatDataParser | undefined;
      try {
        parser = this.parser(chatText(path), current, storage);
        if (!current()) return false;
        if (chat === null) parser?.initial(sourceName, pass !== 0);
        else parser?.initial(sourceName, pass !== 0, chat);
      } catch (error) {
        if (error instanceof ChatSourceCallbackAbort) {
          if (error.reason instanceof ChatSetupRetired) return false;
          throw error.reason;
        }
        if (parser === undefined || !parser.failedWith(error)) throw error;
        if (error instanceof InitialChatNotFoundError && current()) {
          const filename = chatText(path);
          this.report("error", "load-error", `couldn't find chat ${error.chatName} in ${filename}`, filename);
        }
        if (current()) parser?.dispose();
        return failedLoad();
      }
      if (!current()) return false;
      if (parser === undefined) {
        const filename = chatText(path);
        this.report("error", "load-error", `counldn't load ${filename}`, filename);
        return failedLoad();
      }
      parser.dispose();
      size = storage.byteLength;
    }
    if (chat === null) return failedLoad();
    const chatName = chatText(name), filename = chatText(path);
    this.report("info", "loaded", `loaded ${chatName} from ${filename}`, filename);
    if (!current()) return false;
    const developer = this.options.developer?.() ?? false;
    if (developer && current()) this.checkIntegrity(chat.allMessages(), current);
    if (!current()) return false;
    if (startTime !== undefined && this.options.debug !== undefined) {
      this.report("info", "loaded", `initial chats loaded in ${(this.options.debug.milliseconds() - startTime) | 0} msec`);
    }
    if (!current()) return false;
    state.chat = chat;
    const cache = !(this.options.reloadCharacters?.() ?? false);
    if (!current()) return false;
    if (cache) {
      const cached = new CachedChat(this.memory.allocate(CHAT_CACHE_BYTES, "heap", true), this.initialChats);
      if (!current()) return false;
      generation.cache[available] = cached;
      cached.chat = state.chat;
      cached.name = boundedChatText(name, 63);
      if (!current()) return false;
      cached.path = boundedChatText(path, 63);
    }
    return current();
  }

  queueConsoleMessage(handle: number, type: number, input: ChatTextSource): void {
    const state = this.state(handle); if (state === undefined) return;
    if (!Number.isInteger(type)) throw new RangeError("console message type must be integer");
    const message = this.freeConsoleMessages;
    if (message === null) { this.report("error", "message-heap-full", "empty console message heap"); return; }
    this.freeConsoleMessages = message.next;
    if (this.freeConsoleMessages !== null) this.freeConsoleMessages.prev = null;
    state.handle++;
    if (state.handle <= 0 || state.handle > 8192) state.handle = 1;
    message.handle = state.handle;
    const generation = this.generation, time = this.time();
    if (this.generation !== generation || this.states[handle] !== state) return;
    message.time = time; message.type = type;
    message.message = boundedChatText(input, CHAT_MESSAGE_SIZE);
    message.next = null;
    const previous = state.lastMessage;
    if (previous !== null) {
      previous.next = message;
      message.prev = previous;
      state.lastMessage = message;
    } else {
      state.lastMessage = message;
      state.firstMessage = message;
      message.prev = null;
    }
    state.numConsoleMessages++;
  }
  private freeConsoleMessage(message: ConsoleMessageCell): void {
    if (this.freeConsoleMessages !== null) this.freeConsoleMessages.prev = message;
    message.prev = null; message.next = this.freeConsoleMessages;
    this.freeConsoleMessages = message;
  }
  removeConsoleMessage(handle: number, messageHandle: number): void {
    const state = this.state(handle); if (state === undefined) return;
    for (let message = state.firstMessage; message !== null; message = message.next) {
      if (message.handle !== messageHandle) continue;
      const next = message.next, previous = message.prev;
      if (next !== null) next.prev = previous;
      else state.lastMessage = previous;
      if (previous !== null) previous.next = next;
      else state.firstMessage = next;
      this.freeConsoleMessage(message);
      state.numConsoleMessages--;
      break;
    }
  }
  nextConsoleMessage(handle: number): ConsoleChatMessage | null { return this.state(handle)?.firstMessage?.snapshot() ?? null; }
  numConsoleMessages(handle: number): number { return this.state(handle)?.numConsoleMessages ?? 0; }
  setName(handle: number, name: ChatTextSource, client: number): void {
    const state = this.state(handle); if (state === undefined) return;
    if (!Number.isInteger(client)) throw new RangeError("chat client must be integer");
    state.client = client; state.name = "";
    state.name = boundedChatText(name, 32).slice(0, 31);
  }
  setGender(handle: number, gender: number): void { const state = this.state(handle); if (state !== undefined) state.gender = gender === 1 || gender === 2 ? gender : 0; }
  chatLength(handle: number): number { const state = this.state(handle); return state === undefined ? 0 : readMessage(state.message).length; }
  getChatMessage(handle: number, size = CHAT_MESSAGE_SIZE): string {
    let result = "";
    this.writeChatMessage(handle, text => {
      if (!Number.isInteger(size) || size < 1) throw new RangeError("chat output size must be positive");
      result = text.slice(0, size - 1);
    });
    return result;
  }
  writeChatMessage(handle: number, write: (text: string) => void): void {
    const state = this.state(handle); if (state === undefined) return;
    writeMessage(state.message, removeTildes(readMessage(state.message)));
    write(readMessage(state.message));
    state.message[0] = 0;
  }
  enterChat(handle: number, clientTo: number, sendTo: number): void {
    finishCalls(this.enterChatCalls(handle, clientTo, sendTo));
  }
  *enterChatCalls(handle: number, clientTo: number, sendTo: number): CallSteps {
    const state = this.state(handle); if (state === undefined || readMessage(state.message).length === 0) return;
    writeMessage(state.message, removeTildes(readMessage(state.message)));
    if (this.options.testInitialChats?.()) this.report("info", "test-output", readMessage(state.message));
    else {
      const message = readMessage(state.message);
      yield* this.host.clientCommand(state.client, sendTo === ChatDestination.Team ? `say_team ${message}` : sendTo === ChatDestination.Tell ? `tell ${clientTo} ${message}` : `say ${message}`);
    }
    state.message[0] = 0;
  }

  findMatch(input: string, context: number): ChatMatch | null {
    const buffer: ChatMatchBuffer = { string: new Uint8Array(CHAT_MESSAGE_SIZE), type: 0, subtype: 0, variables: rawCaptures() };
    if (!this.findMatchInto(input, context, buffer)) return null;
    return { text: chatCString(buffer.string), type: buffer.type, subtype: buffer.subtype, variables: publicCaptures(buffer.variables) };
  }
  findMatchInto(input: ChatTextSource, context: number, buffer: ChatMatchBuffer): boolean {
    copyChatText(buffer.string, 0, boundedChatText(input, CHAT_MESSAGE_SIZE), CHAT_MESSAGE_SIZE);
    let length = chatCString(buffer.string).length;
    while (length > 0 && chatByte(buffer.string, length - 1) === 10) chatSpan(buffer.string, --length, 1)[0] = 0;
    const match: RawMatch = { get text(): string { return chatCString(buffer.string); }, variables: buffer.variables };
    for (let template = this.matches; template !== null; template = template.next) {
      if ((template.context & context) === 0) continue;
      for (const variable of match.variables) variable.offset = -1;
      if (stringsMatch(template.first, match)) {
        buffer.type = template.type; buffer.subtype = template.subtype;
        return true;
      }
    }
    return false;
  }
  matchVariable(match: ChatMatch, index: number, size = CHAT_MESSAGE_SIZE): string {
    let result = "";
    this.writeMatchVariable(variableIndex => {
      const variable = match.variables[variableIndex];
      if (variable === undefined) throw new RangeError("match variable outside 0..7");
      return variable.kind === "absent" ? { offset: -1, length: 0 } : { offset: variable.offset, length: variable.length };
    }, index, size, (offset, capacity) => {
      if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("invalid match variable buffer size");
      result = byteCString(match.text.slice(offset, offset + capacity - 1));
    }, () => { result = ""; });
    return result;
  }
  writeMatchVariable(variableAt: (index: number) => ChatMatchVariable, index: number, size: number,
    write: (offset: number, capacity: number) => void, clear: () => void): void {
    if (!Number.isInteger(index) || index < 0 || index >= 8) {
      this.report("fatal", "invalid-variable", "BotMatchVariable: variable out of range");
      clear();
      return;
    }
    const variable = variableAt(index), offset = variable.offset;
    if (offset < 0) { clear(); return; }
    if (variable.length < size) size = variable.length + 1;
    write(offset, size);
  }
  replaceSynonyms(input: string, context: number): string {
    let text = byteCString(input);
    for (const group of this.synonyms) if ((group.context & context) !== 0) {
      for (const entry of group.entries.slice(1)) text = replaceWords(text, entry.text, group.entries[0].text);
    }
    return text;
  }
  replaceSynonymsInPlace(input: () => Uint8Array | null, context: number): void {
    for (const group of this.synonyms) if ((group.context & context) !== 0) {
      for (const entry of group.entries.slice(1)) {
        const bytes = input();
        replaceWords(chatCString(bytes), entry.text, group.entries[0].text, (offset, tail, replacement) => {
          copyChatText(bytes, offset + replacement.length, tail, tail.length + 1);
          copyChatText(bytes, offset, replacement, replacement.length);
        });
      }
    }
  }
  replaceWeightedSynonyms(input: string, context: number): string {
    let text = byteCString(input);
    for (const group of this.synonyms) {
      if ((group.context & context) === 0) continue;
      const weight = Math.fround(sourceRandom(this.host.random) * group.totalWeight);
      if (weight === 0) continue;
      let current = 0;
      const replacement = group.entries.find(entry => { current = Math.fround(current + entry.weight); return weight < current; });
      if (replacement === undefined) continue;
      for (const entry of group.entries) if (entry !== replacement) text = replaceWords(text, entry.text, replacement.text);
    }
    return text;
  }
  replaceReplySynonyms(input: string, context: number): string {
    let text = byteCString(input), pointer = 0;
    while (pointer < text.length) {
      while (pointer < text.length && (text.charCodeAt(pointer) << 24 >> 24) <= 32) pointer++;
      if (pointer >= text.length) break;
      let replaced = false;
      for (const group of this.synonyms) {
        if ((group.context & context) === 0) continue;
        for (const synonym of group.entries.slice(1)) {
          if (wordIndex(text, synonym.text, pointer) !== pointer) continue;
          const replacement = group.entries[0].text;
          if (wordIndex(text, replacement, pointer) === pointer) continue;
          text = text.slice(0, pointer) + replacement + text.slice(pointer + synonym.text.length); replaced = true; break;
        }
        if (replaced) break;
      }
      while (pointer < text.length && (text.charCodeAt(pointer) << 24 >> 24) > 32) pointer++;
    }
    return text;
  }
  randomString(name: string): string | null {
    for (const list of this.randoms) if (list.name === name) {
      const index = Math.trunc(Math.fround(sourceRandom(this.host.random) * list.numMessages));
      const message = list.message(index);
      if (message !== undefined) return message;
    }
    return null;
  }

  private appendVariables(match: RawMatch, variables: ChatVariableSources): void {
    for (let index = 0; index < 8; index++) {
      const input = variables[index];
      if (input === undefined) throw new RangeError("chat variables must contain exactly eight entries");
      if (input === null) continue;
      const text = chatText(input);
      const variable = capture(match, index); variable.offset = (match.text.length << 24) >> 24; variable.length = text.length;
      match.text = messageText(match.text + text);
    }
  }
  private expand(state: ChatState, source: string, mcontext: number, match: RawMatch, vcontext: number, reply: boolean): boolean {
    let pointer = 0, length = 0, expanded = false;
    while (pointer < source.length) {
      if (source.charAt(pointer) !== CHAT_ESCAPE) {
        if (length >= CHAT_MESSAGE_SIZE - 1) { this.report("error", "expansion-error", "expanded message exceeds the source buffer"); return false; }
        state.message[length++] = source.charCodeAt(pointer++); continue;
      }
      const kind = source.charAt(++pointer);
      if (kind !== "v" && kind !== "r") { this.report("fatal", "expansion-error", `BotConstructChat: message "${source}" invalid escape char`); continue; }
      const start = ++pointer;
      while (pointer < source.length && source.charAt(pointer) !== CHAT_ESCAPE) pointer++;
      const key = source.slice(start, pointer);
      if (pointer < source.length) pointer++;
      let value: string;
      if (kind === "v") {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= 8) { this.report("error", "expansion-error", `message variable ${key} outside 0..7`); return false; }
        const variable = capture(match, index);
        if (variable.offset < 0) continue;
        value = match.text.slice(variable.offset, variable.offset + variable.length);
        value = reply ? this.replaceReplySynonyms(value, vcontext) : this.replaceSynonyms(value, vcontext);
      } else {
        const random = this.randomString(key);
        if (random === null) { this.report("error", "expansion-error", `BotConstructChat: unknown random string ${key}`); return false; }
        value = random; expanded = true;
      }
      if (length + value.length >= CHAT_MESSAGE_SIZE) {
        this.report("error", "expansion-error", `BotConstructChat: message ${kind === "v" ? source : `"${source}"`} too long`);
        return false;
      }
      writeMessage(state.message, value, length); length += value.length;
    }
    state.message[length] = 0;
    const weighted = this.replaceWeightedSynonyms(readMessage(state.message), mcontext);
    if (weighted.length >= CHAT_MESSAGE_SIZE) { this.report("error", "expansion-error", "weighted message exceeds the source buffer"); return false; }
    writeMessage(state.message, weighted);
    return expanded;
  }
  private construct(state: ChatState, text: string, mcontext: number, match: RawMatch, vcontext: number, reply: boolean): void {
    for (let count = 0; count < 10; count++) {
      if (!this.expand(state, text, mcontext, match, vcontext, reply)) return;
      text = readMessage(state.message);
    }
    this.report("warning", "expansion-limit", "too many expansions in chat message");
    this.report("warning", "expansion-limit", readMessage(state.message));
  }
  private checkIntegrity(messages: Iterable<ChatMessage, undefined, undefined>, current: () => boolean): void {
    const strings: BotMemoryAllocation[] = [];
    let head = 0;
    const stringAt = (pointer: number): BotMemoryAllocation => {
      const allocation = strings[pointer - 1];
      if (allocation === undefined) throw new RangeError("invalid chat integrity string pointer");
      return allocation;
    };
    const hasString = (name: string): boolean => {
      for (let pointer = head; pointer !== 0;) {
        const bytes = stringAt(pointer).bytes;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (readMessage(stringAt(view.getUint32(0, true)).bytes.subarray(8)) === name) return true;
        pointer = view.getUint32(4, true);
      }
      return false;
    };
    messagesLoop:
    for (const message of messages) {
      let pointer = 0;
      while (pointer < message.text.length) {
        if (message.text.charAt(pointer++) !== CHAT_ESCAPE) continue;
        const kind = message.text.charAt(pointer);
        if (kind !== "v" && kind !== "r") {
          this.report("fatal", "integrity-error", `BotCheckChatMessageIntegrety: message "${message.text}" invalid escape char`);
          if (!current()) break messagesLoop;
          continue;
        }
        const start = ++pointer;
        while (pointer < message.text.length && message.text.charAt(pointer) !== CHAT_ESCAPE) pointer++;
        const name = message.text.slice(start, pointer);
        if (pointer < message.text.length) pointer++;
        if (kind === "r") {
          const random = this.randomString(name);
          if (!current()) break messagesLoop;
          if (random === null && !hasString(name)) {
            this.options.log?.write(`${name} = {"${name}"} //MISSING RANDOM\r\n`);
            if (!current()) break messagesLoop;
            const allocation = this.memory.allocate(8 + name.length + 1, "heap", true);
            const bytes = allocation.bytes;
            strings.push(allocation);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            view.setUint32(0, strings.length, true);
            writeMessage(bytes, name, 8);
            view.setUint32(4, head, true);
            head = strings.length;
            this.report("warning", "missing-random", `missing random string ${name}`);
            if (!current()) break messagesLoop;
          }
        }
      }
    }
    for (let pointer = head; pointer !== 0;) {
      const allocation = stringAt(pointer), bytes = allocation.bytes;
      pointer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
      this.memory.free(allocation);
    }
  }
  numInitialChats(handle: number, name: ChatTextSource | null): number {
    const chat = this.state(handle)?.chat;
    if (chat === null || chat === undefined) return 0;
    for (let type = chat.firstType; type !== null; type = type.next) {
      if (!chatTextEquals(type.name, name) || name === null) continue;
      if (this.options.testInitialChats?.()) {
        this.report("info", "test-output", `${chatText(name)} has ${type.numMessages} chat lines`);
        this.report("info", "test-output", "-------------------");
      }
      return type.numMessages;
    }
    return 0;
  }
  initialChat(handle: number, name: ChatTextSource | null, context: number, variables: ChatVariableSources = NO_VARIABLES): void {
    const state = this.state(handle); if (state === undefined) return;
    const chat = state.chat; if (chat === null) return;
    let type = chat.firstType;
    while (type !== null && !chatTextEquals(type.name, name)) type = type.next;
    if (type === null) {
      this.missingInitialChat(name);
      return;
    }
    let eligible = 0;
    for (const message of type.messages()) if (message.time <= this.time()) eligible++;
    let selected: ChatMessage | undefined;
    if (eligible === 0) {
      let bestTime = 0;
      for (const message of type.messages()) if (bestTime === 0 || message.time < bestTime) { selected = message; bestTime = message.time; }
    } else {
      let index = Math.trunc(Math.fround(sourceRandom(this.host.random) * eligible));
      for (const message of type.messages()) {
        if (message.time > this.time()) continue;
        if (--index < 0) { selected = message; selected.time = Math.fround(this.time() + 20); break; }
      }
    }
    if (selected === undefined) {
      this.missingInitialChat(name);
      return;
    }
    const match: RawMatch = { text: "", variables: rawCaptures() }; this.appendVariables(match, variables);
    this.construct(state, selected.text, context, match, 0, false);
  }
  private missingInitialChat(name: ChatTextSource | null): void {
    if (this.options.debug === undefined) return;
    if (name === null) throw new RangeError("BotInitialChat: DEBUG print reads a null source type string");
    this.report("info", "test-output", `no chat messages of type ${chatText(name)}`);
  }
  private replyKey(key: ChatReplyKey, state: ChatState, input: ChatTextSource, match: RawMatch): boolean {
    if ((key.flags & 4) !== 0) return stringContains(input, state.name) >= 0;
    if ((key.flags & 32) !== 0) return stringContains(key.text, state.name) >= 0;
    if ((key.flags & 64) !== 0) return state.gender === 1;
    if ((key.flags & 128) !== 0) return state.gender === 2;
    if ((key.flags & 256) !== 0) return state.gender === 0;
    if ((key.flags & 16) !== 0) return stringsMatch(key.match, match);
    if ((key.flags & 8) !== 0) return wordIndex(chatText(input), key.text) >= 0;
    return false;
  }
  replyChat(handle: number, input: ChatTextSource, messageContext: number, variableContext: number, variables: ChatVariableSources = NO_VARIABLES): boolean {
    const state = this.state(handle); if (state === undefined) return false;
    const message = messageText(chatText(input)), match: RawMatch = { text: message, variables: rawCaptures() };
    let best: { readonly message: ChatMessage; readonly reply: ChatReply; readonly match: RawMatch } | undefined;
    let priority = -1;
    for (let reply = this.replies; reply !== null; reply = reply.next) {
      let found = false;
      for (let key = reply.keys; key !== null; key = key.next) {
        const result = this.replyKey(key, state, input, match);
        if ((key.flags & 1) !== 0) { if (!result) { found = false; break; } }
        else if ((key.flags & 2) !== 0) { if (result) { found = false; break; } }
        else if (result) found = true;
      }
      if (!found || reply.priority <= priority) continue;
      let eligible = 0;
      for (const line of reply.messages()) if (line.time <= this.time()) eligible++;
      let selected = Math.trunc(Math.fround(sourceRandom(this.host.random) * eligible));
      for (const line of reply.messages()) {
        if (--selected < 0) { best = { message: line, reply, match: copyMatch(match) }; priority = Math.trunc(reply.priority); break; }
        if (line.time > this.time()) continue;
      }
    }
    if (best === undefined) return false;
    this.appendVariables(best.match, variables);
    if (this.options.testReplyChats?.()) {
      for (const line of best.reply.messages()) { this.construct(state, line.text, messageContext, best.match, variableContext, true); const text = removeTildes(readMessage(state.message)); writeMessage(state.message, text); this.report("info", "test-output", text); }
    } else { best.message.time = Math.fround(this.time() + 20); this.construct(state, best.message.text, messageContext, best.match, variableContext, true); }
    return true;
  }
}
