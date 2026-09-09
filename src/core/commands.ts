/*
 * Command buffering translated from Quake III Arena's cmd.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { finishCalls, runCalls } from "./call-steps.ts";
import type { CallSteps } from "./call-steps.ts";
import { BIG_INFO_STRING_MAX, COMMAND_TOKEN_MAX, sourceCommandText, tokenizeCommand } from "./text.ts";
import { CommandCompletionState } from "./edit-field.ts";
import { nativeAtoi } from "./native-numeric.ts";
import { ZoneTag } from "./zone.ts";
import type { SourceZoneStrings } from "./zone-strings.ts";

const DEFAULT_MAX_BUFFER = 16384;
const DEFAULT_MAX_COMMAND = 1024;
// cmd_function_t has three pointer fields in the source Release32 layout.
const COMMAND_RECORD_BYTES = 12;

export interface CommandContext {
  readonly argv: readonly string[];
  readonly args: readonly string[];
  readonly raw: string;
  append(text: string): void;
  insert(text: string): void;
  assertActive(): void;
}

/** A retained char pointer into cmd_tokenized, not an argv index or copied token. */
export interface CommandStringReference {
  readonly value: string;
  offset(displacement: number): CommandStringReference;
}

class TokenStringReference implements CommandStringReference {
  constructor(private readonly bytes: Uint8Array, private readonly start: number) {
    if (!Number.isInteger(start) || start < 0 || start >= bytes.length) {
      throw new RangeError("Undefined native command token pointer");
    }
  }

  get value(): string {
    let result = "";
    for (let index = this.start; index < this.bytes.length; index++) {
      const byte = this.bytes[index];
      if (byte === undefined) throw new RangeError("Undefined native command token pointer");
      if (byte === 0) return result;
      result += String.fromCharCode(byte);
    }
    throw new RangeError("Undefined native unterminated command token");
  }

  offset(displacement: number): CommandStringReference {
    return new TokenStringReference(this.bytes, this.start + displacement);
  }
}

export type CommandHandler = (context: CommandContext) => undefined;
export type AsyncCommandHandler = (context: CommandContext) => Promise<void>;
export type CallCommandHandler = (context: CommandContext) => CallSteps;

/** Immutable command identity available while selecting, but not executing, a fallback. */
export interface CommandLookup {
  readonly name: string;
  readonly argv: readonly string[];
  readonly args: readonly string[];
  readonly raw: string;
}

export type ResolvedCommandHandler =
  | { readonly kind: "sync"; readonly handler: CommandHandler }
  | { readonly kind: "async"; readonly handler: AsyncCommandHandler }
  | { readonly kind: "calls"; readonly handler: CallCommandHandler };

export type CommandFallbackResolver = (lookup: CommandLookup) => ResolvedCommandHandler | undefined;

type RegisteredCommand =
  | { readonly kind: "sync"; readonly handler: CommandHandler }
  | { readonly kind: "async"; readonly handler: AsyncCommandHandler }
  | { readonly kind: "calls"; readonly handler: CallCommandHandler }
  | { readonly kind: "fallback" };

interface RegisteredEntry {
  readonly name: string;
  readonly command: RegisteredCommand;
  next: RegisteredEntry | undefined;
  free(): void;
}

type PreparedCommand =
  | { readonly kind: "empty" }
  | {
      readonly kind: "sync";
      readonly context: CommandContext;
      readonly handler: CommandHandler | undefined;
      readonly registration: RegisteredEntry | undefined;
    }
  | {
      readonly kind: "async";
      readonly context: CommandContext;
      readonly handler: AsyncCommandHandler;
      readonly registration: RegisteredEntry | undefined;
    }
  | {
      readonly kind: "calls";
      readonly context: CommandContext;
      readonly handler: CallCommandHandler;
      readonly registration: RegisteredEntry | undefined;
    };

interface ExecutionFrame {
  readonly parent: ExecutionFrame | undefined;
  readonly depth: number;
  readonly work: { remaining: number } | null;
  closed: boolean;
}

export interface CommandBufferOptions {
  readonly strings?: SourceZoneStrings;
  readonly print?: (text: string) => undefined;
  readonly maxBufferLength?: number;
  readonly maxCommandLength?: number;
  readonly maxCommandsPerExecute?: number;
  readonly maxRecursion?: number;
  readonly resolveFallback?: CommandFallbackResolver;
  readonly waitRegistration?: "immediate" | "manual";
  readonly assertExecutionEntry?: () => undefined;
}

interface CommandChunk {
  readonly command: string;
  readonly consumed: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function commandChunk(buffer: string, maximumLength: number): CommandChunk {
  let quoted = false;
  let offset = 0;
  while (offset < buffer.length) {
    const character = buffer[offset];
    if (character === '"') quoted = !quoted;
    if ((!quoted && character === ";") || character === "\n" || character === "\r") break;
    offset++;
  }
  const length = Math.min(offset, maximumLength - 1);
  return { command: buffer.slice(0, length), consumed: length === buffer.length ? length : length + 1 };
}

function asciiUpper(byte: number): number {
  return byte >= 97 && byte <= 122 ? byte - 32 : byte;
}

function commandNamesEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) {
    if (asciiUpper(first.charCodeAt(index)) !== asciiUpper(second.charCodeAt(index))) return false;
  }
  return true;
}

export class CommandBuffer {
  readonly completionState = new CommandCompletionState();
  private handlers: RegisteredEntry | undefined;
  private readonly strings: SourceZoneStrings | undefined;
  private readonly print: ((text: string) => undefined) | undefined;
  private readonly maxBufferLength: number;
  private readonly maxCommandLength: number;
  private readonly maxCommandsPerExecute: number | null;
  private readonly maxRecursion: number | null;
  private readonly resolveFallback: CommandFallbackResolver | undefined;
  private readonly assertExecutionEntry: (() => undefined) | undefined;
  private buffer = "";
  private tokens: readonly string[] = Object.freeze([]);
  private readonly tokenBytes = new Uint8Array(BIG_INFO_STRING_MAX + COMMAND_TOKEN_MAX);
  private tokenOffsets: readonly number[] = [];
  private readonly emptyArgument = new TokenStringReference(new Uint8Array(1), 0);
  private waitFrames = 0;
  private readonly executionContext = new AsyncLocalStorage<ExecutionFrame>();
  private activeExecution: ExecutionFrame | undefined;

  constructor(options: CommandBufferOptions = {}) {
    this.strings = options.strings;
    this.print = options.print;
    this.maxBufferLength = positiveInteger(options.maxBufferLength ?? DEFAULT_MAX_BUFFER, "maxBufferLength");
    this.maxCommandLength = positiveInteger(options.maxCommandLength ?? DEFAULT_MAX_COMMAND, "maxCommandLength");
    this.maxCommandsPerExecute = options.maxCommandsPerExecute === undefined ? null
      : positiveInteger(options.maxCommandsPerExecute, "maxCommandsPerExecute");
    this.maxRecursion = options.maxRecursion === undefined ? null : positiveInteger(options.maxRecursion, "maxRecursion");
    this.resolveFallback = options.resolveFallback;
    this.assertExecutionEntry = options.assertExecutionEntry;
    if (options.waitRegistration !== "manual") this.registerWaitCommand();
  }

  registerWaitCommand(assertEntry?: () => undefined): void {
    this.register("wait", (context) => {
      assertEntry?.();
      const requested = context.argv[1];
      if (context.argv.length !== 2 || requested === undefined) {
        this.waitFrames = 1;
        return;
      }
      this.waitFrames = nativeAtoi(requested);
    });
  }

  get pendingText(): string {
    return this.buffer;
  }

  /** Cmd_Argc/Argv read the last tokenization, including nested commands. */
  get tokenizedArguments(): readonly string[] { return this.tokens; }

  argumentReference(index: number): CommandStringReference {
    if (!Number.isInteger(index)) throw new RangeError("Command argument index requires an integer");
    const offset = this.tokenOffsets[index];
    return offset === undefined ? this.emptyArgument : new TokenStringReference(this.tokenBytes, offset);
  }

  tokenize(text: string | null): readonly string[] {
    this.assertCurrentExecution();
    this.tokens = Object.freeze([]);
    this.tokenOffsets = [];
    if (text !== null) {
      const tokens = tokenizeCommand(text), offsets: number[] = [];
      let offset = 0;
      for (const token of tokens) {
        if (offset + token.length >= this.tokenBytes.length) throw new RangeError("Source command exceeds cmd_tokenized storage");
        offsets.push(offset);
        for (let index = 0; index < token.length; index++) this.tokenBytes[offset++] = token.charCodeAt(index);
        this.tokenBytes[offset++] = 0;
      }
      this.tokenOffsets = offsets;
      this.tokens = Object.freeze(tokens);
    }
    return this.tokens;
  }

  registeredNames(): readonly string[] {
    const names: string[] = [];
    for (let entry = this.handlers; entry !== undefined; entry = entry.next) names.push(entry.name);
    return Object.freeze(names);
  }

  /** Cmd_CommandCompletion reads the current link after each callback returns. */
  completeNames(visitor: (name: string) => undefined): void {
    for (let entry = this.handlers; entry !== undefined; entry = entry.next) visitor(entry.name);
  }

  assertCurrentExecution(): void {
    const current = this.executionContext.getStore();
    this.requireOpenContext(current);
    if (current !== this.activeExecution) throw new Error("Cannot start overlapping command execution");
  }

  register(name: string, handler: CommandHandler): void {
    this.registerHandler(name, { kind: "sync", handler });
  }

  registerAsync(name: string, handler: AsyncCommandHandler): void {
    this.registerHandler(name, { kind: "async", handler });
  }

  registerCalls(name: string, handler: CallCommandHandler): void {
    this.registerHandler(name, { kind: "calls", handler });
  }

  /** Cmd_AddCommand(name, NULL): listed and touched, then routed through the normal fallback chain. */
  registerFallbackName(name: string): void {
    this.requireOpenContext(this.executionContext.getStore());
    name = sourceCommandText(name);
    if (this.findExactRegistration(name) !== undefined) return;
    this.addEntry(name, { kind: "fallback" });
  }

  private registerHandler(name: string, handler: ResolvedCommandHandler): void {
    this.requireOpenContext(this.executionContext.getStore());
    name = sourceCommandText(name);
    if (this.findExactRegistration(name) !== undefined) {
      this.print?.(`Cmd_AddCommand: ${name} already defined\n`);
      return;
    }
    this.addEntry(name, handler);
  }

  private addEntry(name: string, command: RegisteredCommand): void {
    const strings = this.strings;
    if (strings === undefined) {
      this.handlers = { name, command, next: this.handlers, free: () => {} };
      return;
    }
    const allocation = strings.zone.allocate(COMMAND_RECORD_BYTES, ZoneTag.Small, false);
    const copiedName = strings.copy(name);
    let next = this.handlers;
    // Names live in CopyString bytes; next/function retain actual typed identities.
    // Their native pointer words are not represented by invented numeric addresses.
    this.handlers = {
      get name(): string { void allocation.bytes; return copiedName.value; },
      get command(): RegisteredCommand { void allocation.bytes; return command; },
      get next(): RegisteredEntry | undefined { void allocation.bytes; return next; },
      set next(value: RegisteredEntry | undefined) { void allocation.bytes; next = value; },
      free: (): void => { strings.free(copiedName); strings.zone.free(allocation); },
    };
  }

  private findExactRegistration(name: string): RegisteredEntry | undefined {
    for (let entry = this.handlers; entry !== undefined; entry = entry.next) {
      if (entry.name === name) return entry;
    }
    return undefined;
  }

  unregister(name: string): boolean {
    this.requireOpenContext(this.executionContext.getStore());
    name = sourceCommandText(name);
    let previous: RegisteredEntry | undefined;
    for (let entry = this.handlers; entry !== undefined; entry = entry.next) {
      if (entry.name === name) {
        if (previous === undefined) this.handlers = entry.next;
        else previous.next = entry.next;
        entry.free();
        return true;
      }
      previous = entry;
    }
    return false;
  }

  append(text: string): void {
    this.requireOpenContext(this.executionContext.getStore());
    const value = sourceCommandText(text);
    if (this.buffer.length + value.length >= this.maxBufferLength) {
      this.print?.("Cbuf_AddText: overflow\n");
      return;
    }
    this.buffer += value;
  }

  insert(text: string): void {
    this.requireOpenContext(this.executionContext.getStore());
    const insertion = `${sourceCommandText(text)}\n`;
    if (this.buffer.length + insertion.length > this.maxBufferLength) {
      this.print?.("Cbuf_InsertText overflowed\n");
      return;
    }
    this.buffer = insertion + this.buffer;
  }

  execute(): number {
    return this.withExecutionLimits(frame => {
      let executed = 0;
      while (this.buffer.length > 0) {
        if (this.waitFrames !== 0) {
          this.waitFrames = (this.waitFrames - 1) | 0;
          break;
        }
        this.requireWork(frame);
        const chunk = commandChunk(this.buffer, this.maxCommandLength);
        const command = this.prepare(chunk.command, frame);
        if (command.kind === "async") throw new Error("Cannot synchronously execute an asynchronous command");
        this.buffer = this.buffer.slice(chunk.consumed);
        executed += this.dispatchSync(command, frame);
      }
      return executed;
    });
  }

  /** Cbuf_ExecuteText(EXEC_NOW) bypasses both buffered splitting and cmd_wait. */
  executeNow(text: string | null): number {
    const value = text === null ? "" : sourceCommandText(text);
    if (value.length === 0) return this.execute();
    return this.withExecutionLimits(frame => {
      const command = this.prepare(value, frame);
      if (command.kind === "async") throw new Error("Cannot synchronously execute an asynchronous command");
      return this.dispatchSync(command, frame);
    });
  }

  async executeAsync(): Promise<number> {
    return this.withAsyncExecutionLimits(async frame => {
      let executed = 0;
      while (this.buffer.length > 0) {
        if (this.waitFrames !== 0) {
          this.waitFrames = (this.waitFrames - 1) | 0;
          break;
        }
        this.requireWork(frame);
        const chunk = commandChunk(this.buffer, this.maxCommandLength);
        const command = this.prepare(chunk.command, frame);
        this.buffer = this.buffer.slice(chunk.consumed);
        if (command.kind === "async" || command.kind === "calls") {
          if (frame.work !== null) frame.work.remaining--;
          this.touchCommand(command.registration);
          if (command.kind === "calls") await runCalls(command.handler(command.context));
          else await command.handler(command.context);
          this.requireReturnedChildren(frame);
          executed++;
        } else executed += this.dispatchSync(command, frame);
      }
      return executed;
    });
  }

  /** The awaited equivalent of EXEC_NOW still dispatches nonempty text without splitting it. */
  async executeNowAsync(text: string | null): Promise<number> {
    const value = text === null ? "" : sourceCommandText(text);
    if (value.length === 0) return this.executeAsync();
    return this.withAsyncExecutionLimits(async frame => {
      const command = this.prepare(value, frame);
      if (command.kind !== "async" && command.kind !== "calls") return this.dispatchSync(command, frame);
      this.requireWork(frame);
      if (frame.work !== null) frame.work.remaining--;
      this.touchCommand(command.registration);
      if (command.kind === "calls") await runCalls(command.handler(command.context));
      else await command.handler(command.context);
      this.requireReturnedChildren(frame);
      return 1;
    });
  }

  private requireWork(frame: ExecutionFrame): void {
    if (frame.work?.remaining === 0) throw new Error(`command execution exceeded work limit ${this.maxCommandsPerExecute}`);
  }

  private prepare(raw: string, frame: ExecutionFrame): PreparedCommand {
    const argv = this.tokenize(raw), name = argv[0];
    if (name === undefined) return { kind: "empty" };
    const frozenArgv = Object.freeze(argv);
    const args = Object.freeze(argv.slice(1));
    const boundedRaw = raw.slice(0, BIG_INFO_STRING_MAX - 1);
    const lookup: CommandLookup = Object.freeze({ name, argv: frozenArgv, args, raw: boundedRaw });
    const context: CommandContext = Object.freeze({
      argv: frozenArgv, args, raw: boundedRaw,
      append: (text: string): void => { this.requireOpenContext(frame); this.append(text); },
      insert: (text: string): void => { this.requireOpenContext(frame); this.insert(text); },
      assertActive: (): void => {
        this.requireOpenContext(frame);
        if (frame !== this.activeExecution || frame !== this.executionContext.getStore()) {
          throw new Error("Command context is not the active owned execution");
        }
      },
    });
    const registration = this.findRegistration(name);
    const registeredCommand = registration?.command;
    if (registeredCommand?.kind === "sync") {
      return { kind: "sync", context, handler: registeredCommand.handler, registration };
    }
    if (registeredCommand?.kind === "async") {
      return { kind: "async", context, handler: registeredCommand.handler, registration };
    }
    if (registeredCommand?.kind === "calls") {
      return { kind: "calls", context, handler: registeredCommand.handler, registration };
    }
    const fallbackRegistration = this.strings === undefined ? registration : undefined;
    if (this.strings !== undefined) this.touchCommand(registration);
    const fallback = this.resolveFallback?.(lookup);
    if (fallback?.kind === "async") return { kind: "async", context, handler: fallback.handler, registration: fallbackRegistration };
    if (fallback?.kind === "calls") return { kind: "calls", context, handler: fallback.handler, registration: fallbackRegistration };
    return { kind: "sync", context, handler: fallback?.handler, registration: fallbackRegistration };
  }

  private dispatchSync(command: Exclude<PreparedCommand, { kind: "async" }>, frame: ExecutionFrame): number {
    if (command.kind === "empty") return 0;
    this.requireWork(frame);
    if (frame.work !== null) frame.work.remaining--;
    this.touchCommand(command.registration);
    if (command.kind === "calls") finishCalls(command.handler(command.context));
    else command.handler?.(command.context);
    this.requireReturnedChildren(frame);
    return 1;
  }

  private findRegistration(name: string): RegisteredEntry | undefined {
    for (let entry = this.handlers; entry !== undefined; entry = entry.next) {
      if (commandNamesEqual(entry.name, name)) return entry;
    }
    return undefined;
  }

  private touchCommand(entry: RegisteredEntry | undefined): void {
    if (entry === undefined || entry === this.handlers) return;
    for (let previous = this.handlers; previous !== undefined; previous = previous.next) {
      if (previous.next !== entry) continue;
      previous.next = entry.next;
      entry.next = this.handlers;
      this.handlers = entry;
      return;
    }
  }

  private requireOpenContext(frame: ExecutionFrame | undefined): void {
    for (let current = frame; current !== undefined; current = current.parent) {
      if (current.closed) throw new Error("Cannot reuse a closed command execution context");
    }
  }

  private beginExecution(): ExecutionFrame {
    this.assertCurrentExecution();
    this.assertExecutionEntry?.();
    const parent = this.executionContext.getStore();
    const depth = (parent?.depth ?? 0) + 1;
    if (this.maxRecursion !== null && depth > this.maxRecursion) {
      throw new Error(`command execution exceeded recursion limit ${this.maxRecursion}`);
    }
    const frame: ExecutionFrame = {
      parent, depth, work: parent === undefined
        ? this.maxCommandsPerExecute === null ? null : { remaining: this.maxCommandsPerExecute }
        : parent.work, closed: false,
    };
    this.activeExecution = frame;
    return frame;
  }

  private requireReturnedChildren(frame: ExecutionFrame): void {
    if (this.activeExecution !== frame) throw new Error("Nested command execution must be awaited before its handler returns");
    this.requireOpenContext(frame);
  }

  private endExecution(frame: ExecutionFrame): void {
    frame.closed = true;
    if (this.activeExecution === frame) {
      this.activeExecution = frame.parent;
      while (this.activeExecution?.closed) this.activeExecution = this.activeExecution.parent;
    }
  }

  private withExecutionLimits<T>(execute: (frame: ExecutionFrame) => T): T {
    const frame = this.beginExecution();
    return this.executionContext.run(frame, () => {
      try {
        const result = execute(frame);
        this.requireReturnedChildren(frame);
        return result;
      }
      finally { this.endExecution(frame); }
    });
  }

  private async withAsyncExecutionLimits<T>(execute: (frame: ExecutionFrame) => Promise<T>): Promise<T> {
    const frame = this.beginExecution();
    return this.executionContext.run(frame, async () => {
      try {
        const result = await execute(frame);
        this.requireReturnedChildren(frame);
        return result;
      }
      finally { this.endExecution(frame); }
    });
  }

}
