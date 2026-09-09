/*
 * Source preprocessor translated from Quake III Arena botlib/l_precomp.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */

import {
  DEFAULT_SCRIPT_TOKEN_LIMIT,
  NumberFlag,
  Punctuation,
  ScriptLanguageError,
  ScriptLexer,
  ScriptTokenType,
  scriptTokenTypeName,
  scriptNumberSubtypeName,
  allocateScriptSource,
  type NameToken,
  type NumberToken,
  type PunctuationToken,
  type ScriptDiagnostic,
  type ScriptToken,
  type ScriptTokenRecord,
  type SourceLocation,
  type ScriptPunctuation,
} from "./lexer.ts";
import { SourceScriptStorage, type ScriptMemory } from "./memory.ts";
import { SOURCE_DEFINE_HASH_BUCKETS, SourceIndentType, SourceRecord } from "./source-memory.ts";
import { localToken, PrecompDefine, PrecompMemory, PrecompToken } from "./precomp-memory.ts";
import type { SourceTokenMemory } from "./token-memory.ts";
import { qStricmp } from "../core/source-strings.ts";

export type { ScriptTokenRecord } from "./lexer.ts";

const DEFAULT_DIAGNOSTIC_LIMIT = Number.MAX_SAFE_INTEGER;
const MAX_DEFINE_PARAMETERS = 128;

export interface ScriptSource {
  readonly path: string;
  readonly text: string;
}

export interface ScriptSourcePosition {
  readonly filename: string;
  readonly line: number;
}

export type IncludeRequest =
  | {
    readonly kind: "quoted";
    readonly fromPath: string;
    readonly requestedPath: string;
    /** Omitted by diagnostic callers to select the source's empty include path. */
    readonly includePath?: string;
  }
  | {
    readonly kind: "system";
    readonly fromPath: string;
    readonly requestedPath: string;
  };

export interface IncludeResolver {
  resolve(request: IncludeRequest): ScriptSource | undefined;
}

export interface ScriptPreprocessorOptions {
  readonly memory?: ScriptMemory;
  readonly initialDefines?: readonly string[];
  readonly globals?: ScriptGlobalDefines;
  /** Detached, allocation-free diagnostic capture. Production passes globals. */
  readonly globalDefines?: ScriptGlobalSnapshot;
  readonly installBuiltins?: boolean;
  readonly now?: () => Date;
  readonly maxIncludeDepth?: number;
  readonly maxMacroExpansions?: number;
  readonly maxQueuedTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxSourceTokens?: number;
  readonly maxDefines?: number;
  readonly maxExpressionTokens?: number;
  readonly report?: (diagnostic: ScriptDiagnostic) => void;
}

type BuiltinName = "__LINE__" | "__FILE__" | "__DATE__" | "__TIME__";

export interface ScriptGlobalSnapshot {
  readonly definitions: readonly PrecompDefine[];
}

class MacroTable {
  private readonly entries = new Set<number>();

  constructor(private readonly source: SourceRecord, private readonly memory: PrecompMemory) {}

  get size(): number { return this.entries.size; }
  get(name: string): PrecompDefine | undefined {
    let remaining = this.entries.size + 1;
    for (let id = this.source.hashHead(this.hash(name)); id !== 0;) {
      if (--remaining === 0) throw new RangeError("source define hash contains a cycle");
      const entry = this.memory.define(id);
      if (entry.name === name) return entry;
      id = entry.hashnext;
    }
    return undefined;
  }
  has(name: string): boolean { return this.get(name) !== undefined; }
  prepend(macro: PrecompDefine): void {
    const bucket = this.hash(macro.name);
    macro.hashnext = this.source.hashHead(bucket);
    this.entries.add(macro.id);
    this.source.setHashHead(bucket, macro.id);
  }
  delete(name: string): void {
    const bucket = this.hash(name);
    let previous: PrecompDefine | undefined;
    let remaining = this.entries.size + 1;
    for (let id = this.source.hashHead(bucket); id !== 0;) {
      if (--remaining === 0) throw new RangeError("source define hash contains a cycle");
      const entry = this.memory.define(id);
      if (entry.name === name) {
        if (previous === undefined) this.source.setHashHead(bucket, entry.hashnext);
        else previous.hashnext = entry.hashnext;
        this.memory.freeDefine(entry);
        this.entries.delete(id);
        return;
      }
      previous = entry;
      id = entry.hashnext;
    }
  }
  first(): PrecompDefine | undefined {
    for (let bucket = 0; bucket < SOURCE_DEFINE_HASH_BUCKETS; bucket++) {
      const id = this.source.hashHead(bucket);
      if (id !== 0) return this.memory.define(id);
    }
    return undefined;
  }
  clear(): void {
    for (let bucket = 0; bucket < SOURCE_DEFINE_HASH_BUCKETS; bucket++) {
      let id: number;
      while ((id = this.source.hashHead(bucket)) !== 0) {
        const entry = this.memory.define(id);
        this.source.setHashHead(bucket, entry.hashnext);
        this.memory.freeDefine(entry);
        this.entries.delete(id);
      }
    }
  }
  private hash(name: string): number {
    let hash = 0;
    for (let index = 0; index < name.length; index++) {
      const character = name.charCodeAt(index);
      if (character === 0) break;
      hash = (hash + (character < 128 ? character : character - 256) * (119 + index)) | 0;
    }
    return (hash ^ (hash >> 10) ^ (hash >> 20)) & (SOURCE_DEFINE_HASH_BUCKETS - 1);
  }
}

interface LineTokenReader {
  next(): ScriptToken | undefined;
  unread(token: ScriptToken): void;
}

interface SourceFrame {
  readonly id: number;
  readonly lexer: ScriptLexer;
  readonly storage: SourceScriptStorage | null;
  diagnosticNext: number;
  tokenCount: number;
}

type TokenMetadata =
  | {
    readonly kind: "defined";
    readonly subtype: number;
    readonly integerValue: number;
    readonly floatValue: number;
  }
  | { readonly kind: "uninitialized"; readonly reason: string };

interface Limits {
  readonly includeDepth: number;
  readonly macroExpansions: number;
  readonly queuedTokens: number;
  readonly outputTokens: number;
  readonly sourceTokens: number;
  readonly defines: number;
  readonly expressionTokens: number;
}

interface EvalValue {
  readonly integerValue: number;
  readonly floatValue: number;
}

interface TokenChain {
  first: number;
  last: number;
  count: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function frozenLocation(location: SourceLocation): SourceLocation {
  return Object.freeze({ path: location.path, line: location.line, column: location.column });
}

/** l_precomp.c sprintf("%1.2f", fabs(value)), binary64 and nearest-even. */
function evaluationDecimal(magnitude: number): string {
  const binary = new DataView(new ArrayBuffer(8));
  binary.setFloat64(0, magnitude, true);
  const bits = binary.getBigUint64(0, true);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (exponent === 0x7ff) return fraction === 0n ? "inf" : "nan";
  const significand = exponent === 0 ? fraction : fraction | 0x10000000000000n;
  const shift = exponent === 0 ? -1074 : exponent - 1075;
  const scaled = significand * 100n;
  let rounded: bigint;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), lower = scaled / divisor, remainder = scaled % divisor;
    rounded = remainder * 2n > divisor || remainder * 2n === divisor && lower % 2n !== 0n ? lower + 1n : lower;
  }
  return `${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
}

function makeNumber(text: string, value: number, flags: number, location: SourceLocation): NumberToken {
  return Object.freeze({
    kind: "number",
    text,
    flags,
    integerValue: Math.trunc(value),
    floatValue: value,
    location: frozenLocation(location),
    leadingWhitespace: "",
    linesCrossed: 0,
  });
}

function makePunctuation(value: string, punctuation: Punctuation, location: SourceLocation): PunctuationToken {
  return Object.freeze({
    kind: "punctuation",
    text: value,
    value,
    punctuation,
    location: frozenLocation(location),
    leadingWhitespace: "",
    linesCrossed: 0,
  });
}

type ExpressionFailure = (message: string, location: SourceLocation) => never;

function signedExpressionValue(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new RangeError("preprocessor operation exceeds the source signed-long range");
  }
  return value === 0 ? 0 : value;
}

class ExpressionParser {
  private readonly tokens: readonly ScriptToken[];
  private readonly integerMode: boolean;
  private readonly defined: (name: string) => boolean;
  private readonly fail: ExpressionFailure;
  private readonly fallbackLocation: SourceLocation;

  constructor(
    tokens: readonly ScriptToken[],
    integerMode: boolean,
    defined: (name: string) => boolean,
    fail: ExpressionFailure,
    fallbackLocation: SourceLocation,
    private readonly report: (message: string, location: SourceLocation) => void,
  ) {
    this.tokens = tokens;
    this.integerMode = integerMode;
    this.defined = defined;
    this.fail = fail;
    this.fallbackLocation = fallbackLocation;
  }

  evaluate(): EvalValue {
    interface Value { value: EvalValue; previous: Value | null; next: Value | null }
    interface Operator { readonly token: PunctuationToken; readonly parentheses: number; readonly priority: number; previous: Operator | null; next: Operator | null }
    const values: { first: Value | null; last: Value | null } = { first: null, last: null };
    const operators: { first: Operator | null; last: Operator | null } = { first: null, last: null };
    let numValues = 0, numOperators = 0, parentheses = 0, lastWasValue = false, negative = false;
    const addValue = (value: EvalValue): void => {
      if (numValues++ >= 64) this.fail("out of value space\n", this.fallbackLocation);
      const entry: Value = { value, previous: values.last, next: null };
      if (values.last === null) values.first = entry; else values.last.next = entry;
      values.last = entry;
      lastWasValue = true;
    };
    for (let index = 0; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (token === undefined) throw new Error("source expression token is missing");
      if (token.kind === "name") {
        if (lastWasValue || negative) this.fail("syntax error in #if/#elif", token.location);
        if (token.text !== "defined") this.fail(`undefined name ${token.text} in #if/#elif`, token.location);
        let name = this.tokens[++index];
        if (name === undefined) throw new RangeError("defined reads a null source token before checking its name");
        const brace = name.text === "(";
        if (brace) name = this.tokens[++index];
        if (name === undefined || name.kind !== "name") this.fail("defined without name in #if/#elif", token.location);
        const value = Number(this.defined(name.text));
        addValue({ integerValue: value, floatValue: value });
        if (brace && this.tokens[++index]?.text !== ")") this.fail("defined without ) in #if/#elif", token.location);
      } else if (token.kind === "number") {
        if (lastWasValue) this.fail("syntax error in #if/#elif", token.location);
        addValue({ integerValue: negative ? signedExpressionValue(-(token.integerValue | 0)) : token.integerValue | 0, floatValue: negative ? -token.floatValue : token.floatValue });
        negative = false;
      } else if (token.kind === "punctuation") {
        if (negative) this.fail("misplaced minus sign in #if/#elif", token.location);
        const op = token.punctuation;
        if (op === Punctuation.ParenthesisOpen) { parentheses++; continue; }
        if (op === Punctuation.ParenthesisClose) { if (--parentheses < 0) this.fail("too many ) in #if/#elsif", token.location); continue; }
        if (!this.integerMode && (op === Punctuation.BinaryNot || op === Punctuation.Modulo || op === Punctuation.RightShift
          || op === Punctuation.LeftShift || op === Punctuation.BinaryAnd || op === Punctuation.BinaryOr || op === Punctuation.BinaryXor)) {
          this.fail(`illigal operator ${token.text} on floating point operands\n`, token.location);
        }
        if (op === Punctuation.LogicalNot || op === Punctuation.BinaryNot) {
          if (lastWasValue) this.fail("! or ~ after value in #if/#elif", token.location);
        } else if (op === Punctuation.Subtract && !lastWasValue) { negative = true; continue; }
        else if (op === Punctuation.Increment || op === Punctuation.Decrement) {
          this.report("++ or -- used in #if/#elif", token.location);
        } else {
          if (this.precedence(op) === undefined) this.fail(`invalid operator ${token.text} in #if/#elif`, token.location);
          if (!lastWasValue) this.fail(`operator ${token.text} after operator in #if/#elif`, token.location);
        }
        if (numOperators++ >= 64) this.fail("out of operator space\n", token.location);
        const priority = op === Punctuation.LogicalNot || op === Punctuation.BinaryNot ? 16
          : op === Punctuation.Increment || op === Punctuation.Decrement ? 0 : this.precedence(op);
        if (priority === undefined) throw new Error("source expression priority is missing");
        const entry: Operator = { token, parentheses, priority, previous: operators.last, next: null };
        if (operators.last === null) operators.first = entry; else operators.last.next = entry;
        operators.last = entry;
        lastWasValue = false;
      } else this.fail(`unknown ${token.text} in #if/#elif`, token.location);
    }
    if (!lastWasValue) this.fail("trailing operator in #if/#elif", this.fallbackLocation);
    if (parentheses !== 0) this.fail("too many ( in #if/#elif", this.fallbackLocation);
    let question: EvalValue | null = null;
    while (operators.first !== null) {
      let operator: Operator = operators.first, value: Value | null = values.first;
      while (operator.next !== null) {
        if (operator.parentheses > operator.next.parentheses || operator.parentheses === operator.next.parentheses && operator.priority >= operator.next.priority) break;
        if (operator.token.punctuation !== Punctuation.LogicalNot && operator.token.punctuation !== Punctuation.BinaryNot) value = value?.next ?? null;
        if (value === null) this.fail("mising values in #if/#elif", operator.token.location);
        operator = operator.next;
      }
      if (value === null) throw new RangeError("source expression reduction dereferences a missing value");
      const op = operator.token.punctuation;
      if (op === Punctuation.LogicalNot) value.value = { integerValue: Number(value.value.integerValue === 0), floatValue: Number(value.value.floatValue === 0) };
      else if (op === Punctuation.BinaryNot) value.value = { integerValue: ~value.value.integerValue, floatValue: value.value.floatValue };
      else {
        const next = value.next;
        if (op === Punctuation.Question) {
          if (question !== null) this.fail("? after ? in #if/#elif", operator.token.location);
          question = value.value;
        } else {
          if (next === null) throw new RangeError("source expression binary reduction dereferences a missing value");
          if (op === Punctuation.Colon) {
            if (question === null) this.fail(": without ? in #if/#elif", operator.token.location);
            value.value = this.integerMode
              ? { integerValue: question.integerValue === 0 ? next.value.integerValue : value.value.integerValue, floatValue: value.value.floatValue }
              : { integerValue: value.value.integerValue, floatValue: question.floatValue === 0 ? next.value.floatValue : value.value.floatValue };
            question = null;
          } else if (op !== Punctuation.Increment && op !== Punctuation.Decrement) value.value = this.binary(operator.token, value.value, next.value);
        }
        const removed = op === Punctuation.Question ? value : next;
        if (removed === null) throw new RangeError("source expression removes a missing value");
        if (removed.previous === null) values.first = removed.next; else removed.previous.next = removed.next;
        if (removed.next === null) values.last = removed.previous; else removed.next.previous = removed.previous;
      }
      if (operator.previous === null) operators.first = operator.next; else operator.previous.next = operator.next;
      if (operator.next === null) operators.last = operator.previous; else operator.next.previous = operator.previous;
    }
    if (values.first === null) throw new RangeError("source expression has no result value");
    return values.first.value;
  }


  private binary(operator: PunctuationToken, left: EvalValue, right: EvalValue): EvalValue {
    switch (operator.punctuation) {
      case Punctuation.Multiply:
        return {
          integerValue: signedExpressionValue(left.integerValue * right.integerValue),
          floatValue: left.floatValue * right.floatValue,
        };
      case Punctuation.Divide:
        if (right.integerValue === 0 || right.floatValue === 0) {
          this.fail("divide by zero in #if/#elif\n", operator.location);
        }
        return {
          integerValue: signedExpressionValue(Math.trunc(left.integerValue / right.integerValue)),
          floatValue: left.floatValue / right.floatValue,
        };
      case Punctuation.Modulo:
        this.requireIntegerOperator(operator);
        if (right.integerValue === 0) {
          this.fail("divide by zero in #if/#elif\n", operator.location);
        }
        signedExpressionValue(Math.trunc(left.integerValue / right.integerValue));
        return {
          integerValue: signedExpressionValue(left.integerValue % right.integerValue),
          floatValue: left.floatValue,
        };
      case Punctuation.Add:
        return {
          integerValue: signedExpressionValue(left.integerValue + right.integerValue),
          floatValue: left.floatValue + right.floatValue,
        };
      case Punctuation.Subtract:
        return {
          integerValue: signedExpressionValue(left.integerValue - right.integerValue),
          floatValue: left.floatValue - right.floatValue,
        };
      case Punctuation.LogicalAnd:
        return {
          integerValue: left.integerValue !== 0 && right.integerValue !== 0 ? 1 : 0,
          floatValue: left.floatValue !== 0 && right.floatValue !== 0 ? 1 : 0,
        };
      case Punctuation.LogicalOr:
        return {
          integerValue: left.integerValue !== 0 || right.integerValue !== 0 ? 1 : 0,
          floatValue: left.floatValue !== 0 || right.floatValue !== 0 ? 1 : 0,
        };
      case Punctuation.GreaterOrEqual:
        return {
          integerValue: left.integerValue >= right.integerValue ? 1 : 0,
          floatValue: left.floatValue >= right.floatValue ? 1 : 0,
        };
      case Punctuation.LessOrEqual:
        return {
          integerValue: left.integerValue <= right.integerValue ? 1 : 0,
          floatValue: left.floatValue <= right.floatValue ? 1 : 0,
        };
      case Punctuation.Equal:
        return {
          integerValue: left.integerValue === right.integerValue ? 1 : 0,
          floatValue: left.floatValue === right.floatValue ? 1 : 0,
        };
      case Punctuation.NotEqual:
        return {
          integerValue: left.integerValue !== right.integerValue ? 1 : 0,
          floatValue: left.floatValue !== right.floatValue ? 1 : 0,
        };
      case Punctuation.Greater:
        return {
          integerValue: left.integerValue > right.integerValue ? 1 : 0,
          floatValue: left.floatValue > right.floatValue ? 1 : 0,
        };
      case Punctuation.Less:
        return {
          integerValue: left.integerValue < right.integerValue ? 1 : 0,
          floatValue: left.floatValue < right.floatValue ? 1 : 0,
        };
      case Punctuation.RightShift:
        this.requireIntegerOperator(operator);
        if (right.integerValue < 0 || right.integerValue >= 32) throw new RangeError("source right shift count exceeds its signed-long width");
        return {
          integerValue: left.integerValue >> right.integerValue,
          floatValue: left.floatValue,
        };
      case Punctuation.LeftShift:
        this.requireIntegerOperator(operator);
        if (right.integerValue < 0 || right.integerValue >= 32 || left.integerValue < 0) {
          throw new RangeError("source signed left shift has an undefined operand");
        }
        return {
          integerValue: signedExpressionValue(left.integerValue * 2 ** right.integerValue),
          floatValue: left.floatValue,
        };
      case Punctuation.BinaryAnd:
        this.requireIntegerOperator(operator);
        return {
          integerValue: left.integerValue & right.integerValue,
          floatValue: left.floatValue,
        };
      case Punctuation.BinaryOr:
        this.requireIntegerOperator(operator);
        return {
          integerValue: left.integerValue | right.integerValue,
          floatValue: left.floatValue,
        };
      case Punctuation.BinaryXor:
        this.requireIntegerOperator(operator);
        return {
          integerValue: left.integerValue ^ right.integerValue,
          floatValue: left.floatValue,
        };
      default:
        this.fail(`unsupported expression operator ${operator.text}`, operator.location);
    }
  }

  private requireIntegerOperator(operator: PunctuationToken): void {
    if (!this.integerMode) {
      this.fail(`operator ${operator.text} is invalid in a floating-point expression`, operator.location);
    }
  }

  private precedence(punctuation: number): number | undefined {
    switch (punctuation) {
      case Punctuation.Multiply:
      case Punctuation.Divide:
      case Punctuation.Modulo:
        return 15;
      case Punctuation.Add:
      case Punctuation.Subtract:
        return 14;
      case Punctuation.RightShift:
      case Punctuation.LeftShift:
        return 13;
      case Punctuation.GreaterOrEqual:
      case Punctuation.LessOrEqual:
      case Punctuation.Greater:
      case Punctuation.Less:
        return 12;
      case Punctuation.Equal:
      case Punctuation.NotEqual:
        return 11;
      case Punctuation.BinaryAnd:
        return 10;
      case Punctuation.BinaryXor:
        return 9;
      case Punctuation.BinaryOr:
        return 8;
      case Punctuation.LogicalAnd:
        return 7;
      case Punctuation.LogicalOr:
        return 6;
      case Punctuation.Question:
      case Punctuation.Colon:
        return 5;
      default:
        return undefined;
    }
  }

}

class SourceReadFalse extends Error {}

class PreprocessorEngine {
  private readonly resolver: IncludeResolver;
  private readonly limits: Limits;
  private readonly now: () => Date;
  private readonly report: ((diagnostic: ScriptDiagnostic) => void) | undefined;
  private readonly memory: ScriptMemory | undefined;
  private readonly reported: ScriptDiagnostic[] = [];
  private readonly callbackAborts = new WeakSet<ScriptLanguageError>();
  private readonly source: SourceRecord;
  private readonly heap: PrecompMemory;
  private readonly macros: MacroTable;
  private readonly tokenMetadata = new WeakMap<ScriptToken, TokenMetadata>();
  private readonly rootFrame: SourceFrame;
  private readonly frames = new Map<number, SourceFrame>();
  private nextFrame = 1;
  private readonly cursorToken = localToken();
  private readonly cursor: LineTokenReader = {
    next: () => this.readSourceToken(this.cursorToken),
    unread: token => this.unreadToken(token),
  };
  private output = localToken();
  private expansionCount = 0;
  private outputCount = 0;
  private disposed = false;

  constructor(root: ScriptSource, resolver: IncludeResolver, options: ScriptPreprocessorOptions,
    private readonly lifetime: "source" | "global" = "source", heap?: PrecompMemory) {
    if (root.path.length === 0) throw new RangeError("root source path cannot be empty");
    this.resolver = { resolve: request => this.invokeCallback(() => resolver.resolve(request)) };
    const now = options.now ?? (() => new Date());
    this.now = () => this.invokeCallback(now);
    this.report = options.report;
    this.memory = root instanceof SourceScriptStorage ? root.memory : options.memory;
    this.heap = heap ?? new PrecompMemory(this.memory);
    this.limits = Object.freeze({
      includeDepth: positiveInteger(options.maxIncludeDepth, DEFAULT_DIAGNOSTIC_LIMIT, "maxIncludeDepth"),
      macroExpansions: positiveInteger(options.maxMacroExpansions, DEFAULT_DIAGNOSTIC_LIMIT, "maxMacroExpansions"),
      queuedTokens: positiveInteger(options.maxQueuedTokens, DEFAULT_DIAGNOSTIC_LIMIT, "maxQueuedTokens"),
      outputTokens: positiveInteger(options.maxOutputTokens, DEFAULT_DIAGNOSTIC_LIMIT, "maxOutputTokens"),
      sourceTokens: positiveInteger(options.maxSourceTokens, DEFAULT_DIAGNOSTIC_LIMIT, "maxSourceTokens"),
      defines: positiveInteger(options.maxDefines, DEFAULT_DIAGNOSTIC_LIMIT, "maxDefines"),
      expressionTokens: positiveInteger(options.maxExpressionTokens, DEFAULT_DIAGNOSTIC_LIMIT, "maxExpressionTokens"),
    });
    this.rootFrame = this.createFrame(root);
    this.setNextFrame(this.rootFrame, 0);
    this.source = new SourceRecord(root.path, this.rootFrame.id, this.memory, lifetime === "global" ? "stack" : "heap");
    this.macros = new MacroTable(this.source, this.heap);
    options.globals?.copyTo(this.heap, define => this.macros.prepend(define));
    for (const macro of options.globalDefines?.definitions ?? []) this.macros.prepend(this.heap.copyDefine(macro));
    if (options.installBuiltins === true) this.installBuiltins();
    this.installInitialDefines(options.initialDefines ?? []);
  }

  get diagnostics(): readonly ScriptDiagnostic[] {
    return Object.freeze([...this.reported]);
  }

  get position(): ScriptSourcePosition {
    this.requireLive();
    return Object.freeze({
      filename: this.source.filename,
      line: this.currentFrame.lexer.currentLocation.line,
    });
  }

  get currentScriptFilename(): string { this.requireLive(); return this.currentFrame.lexer.currentLocation.path; }

  private get currentFrame(): SourceFrame { return this.frame(this.source.script); }

  nextToken(): ScriptToken | undefined {
    this.requireLive();
    const output = localToken();
    this.output = output;
    let token: ScriptToken | undefined;
    try { token = this.readToken(output); }
    catch (error) {
      if (error instanceof SourceReadFalse) { this.output = output; return undefined; }
      if (this.isSourceFailure(error)) this.output = output;
      throw error;
    }
    this.output = output;
    if (token === undefined) return undefined;
    if (this.outputCount >= this.limits.outputTokens) {
      this.fail(`preprocessor output exceeds ${this.limits.outputTokens} tokens`, token.location);
    }
    this.outputCount++;
    return token;
  }

  nextRecord(): ScriptTokenRecord | undefined {
    const token = this.nextToken();
    if (token === undefined) return undefined;
    return this.currentRecord;
  }

  get currentRecord(): ScriptTokenRecord {
    if (this.output.unsupported !== undefined) {
      this.fail(`source token profile is unsupported: ${this.output.unsupported}`, this.currentFrame.lexer.currentLocation);
    }
    return this.output.token.readRecord(this.output.context);
  }

  unread(record: ScriptTokenRecord): void {
    this.requireLive();
    this.tokenMetadata.set(record.token, Object.freeze({
      kind: "defined",
      subtype: record.subtype,
      integerValue: record.integerValue,
      floatValue: record.floatValue,
    }));
    this.cursor.unread(record.token);
  }

  unreadLast(): void {
    this.requireLive();
    const copied = this.heap.copyToken(this.source.token);
    copied.token.next = this.source.tokens;
    this.source.tokens = copied.id;
  }

  get rawToken(): SourceTokenMemory {
    if (this.output.unsupported !== undefined) throw new RangeError(`source token profile is unsupported: ${this.output.unsupported}`);
    return this.output.token;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.lifetime === "global") {
      this.freePendingTokens();
      this.source.freeHash();
      this.rootFrame.lexer.dispose();
    } else {
      while (this.source.script !== 0) {
        const frame = this.currentFrame;
        this.source.script = this.nextFrameId(frame);
        this.frames.delete(frame.id);
        frame.lexer.dispose();
      }
      this.freePendingTokens();
      this.macros.clear();
      this.source.freeIndents();
      this.source.freeHash();
      this.source.freeRecord();
    }
    this.disposed = true;
  }

  disposeRecordOnly(): void {
    if (this.disposed) return;
    this.source.freeRecord();
    this.disposed = true;
  }

  setIncludePath(path: string): void { this.requireLive(); this.source.setIncludePath(path); }
  setPunctuations(punctuations: readonly ScriptPunctuation[] | null): void {
    this.requireLive(); this.source.setPunctuations(punctuations);
  }

  addDefine(text: string): boolean {
    this.requireLive();
    const macro = defineFromString(text, this.memory, this.heap, diagnostic => this.recordDiagnostic(diagnostic));
    if (macro === undefined) return false;
    this.macros.prepend(macro);
    return true;
  }

  addBuiltinDefines(): void { this.requireLive(); this.installBuiltins(); }

  printDefineHashTable(write: (text: string) => void): void {
    this.requireLive();
    for (let bucket = 0; bucket < SOURCE_DEFINE_HASH_BUCKETS; bucket++) {
      write(`${String(bucket).padStart(4, " ")}:`);
      for (let id = this.source.hashHead(bucket); id !== 0;) {
        const define = this.heap.define(id);
        write(` ${define.name}`);
        id = define.hashnext;
      }
      write("\n");
    }
  }

  expectTokenString(text: string): boolean {
    const record = this.readExpected();
    if (record === undefined) { this.error(`couldn't find expected ${text}`, this.currentFrame.lexer.currentLocation); return false; }
    if (record.token.text !== text) {
      this.error(`expected ${text}, found ${record.token.text}`, this.currentFrame.lexer.currentLocation); return false;
    }
    return true;
  }

  expectAnyToken(output: SourceTokenMemory): boolean {
    const record = this.readExpected();
    output.copyFrom(this.rawToken);
    if (record !== undefined) return true;
    this.error("couldn't read expected token", this.currentFrame.lexer.currentLocation);
    return false;
  }

  expectTokenType(type: number, subtype: number, output: SourceTokenMemory): boolean {
    if (!this.expectAnyToken(output)) return false;
    if (output.type !== type) {
      this.error(`expected a ${scriptTokenTypeName(type)}, found ${output.string}`, this.currentFrame.lexer.currentLocation);
      return false;
    }
    if (type === ScriptTokenType.Number && (output.subtype & subtype) !== subtype) {
      this.error(`expected ${scriptNumberSubtypeName(subtype)}, found ${output.string}`, this.currentFrame.lexer.currentLocation);
      return false;
    }
    if (type === ScriptTokenType.Punctuation && output.subtype !== subtype) {
      this.error(`found ${output.string}`, this.currentFrame.lexer.currentLocation);
      return false;
    }
    return true;
  }

  checkTokenString(text: string): boolean {
    const record = this.readExpected();
    if (record === undefined) return false;
    if (record.token.text === text) return true;
    this.unread(record);
    return false;
  }

  checkTokenType(type: number, subtype: number, output: SourceTokenMemory): boolean {
    const record = this.readExpected();
    if (record === undefined) return false;
    if (this.rawToken.type === type && (record.subtype & subtype) === subtype) {
      output.copyFrom(this.rawToken);
      return true;
    }
    this.unread(record);
    return false;
  }

  skipUntilString(text: string): boolean {
    let record: ScriptTokenRecord | undefined;
    while ((record = this.readExpected()) !== undefined) if (record.token.text === text) return true;
    return false;
  }

  readLineInto(output: SourceTokenMemory): boolean {
    this.requireLive();
    const current = localToken();
    try {
      const result = this.readLineToken({ next: () => this.readSourceToken(current), unread: token => this.unreadToken(token) });
      output.copyFrom(current.token);
      return result !== undefined;
    } catch (error) {
      if (this.isSourceFailure(error)) { output.copyFrom(current.token); return false; }
      throw error;
    }
  }

  private readExpected(): ScriptTokenRecord | undefined {
    try { return this.nextRecord(); }
    catch (error) { if (this.isSourceFailure(error)) return undefined; throw error; }
  }

  isSourceFailure(error: unknown): boolean {
    return error instanceof ScriptLanguageError && !this.callbackAborts.has(error)
      && this.reported.includes(error.diagnostic);
  }

  private requireLive(): void {
    if (this.disposed) throw new Error("Script source has been freed");
  }

  private installInitialDefines(initialDefines: readonly string[]): void {
    for (let index = 0; index < initialDefines.length; index++) {
      const definition = initialDefines[index];
      if (definition === undefined) {
        throw new Error("initial define list contained a missing entry");
      }
      const macro = defineFromString(definition, this.memory, this.heap, diagnostic => this.recordDiagnostic(diagnostic));
      if (macro === undefined) this.fail("initial define is invalid", this.currentFrame.lexer.currentLocation);
      this.macros.prepend(macro);
    }
  }

  parseGlobal(): PrecompDefine | undefined {
    this.defineDirective(this.cursor, this.currentFrame.lexer.currentLocation);
    return this.macros.first();
  }

  private installBuiltins(): void {
    const names: readonly BuiltinName[] = ["__LINE__", "__FILE__", "__DATE__", "__TIME__"];
    for (const [index, name] of names.entries()) {
      const macro = this.heap.allocateDefine(name, true);
      macro.flags |= 1;
      macro.builtin = index + 1;
      this.macros.prepend(macro);
    }
  }

  private createFrame(source: ScriptSource): SourceFrame {
    let storage = source instanceof SourceScriptStorage ? source : null;
    if (storage === null && this.memory !== undefined) {
      storage = allocateScriptSource(source.text.length, source.path, this.memory);
      storage.copyText(source.text);
    }
    const frame: SourceFrame = {
      id: this.nextFrame++,
      lexer: new ScriptLexer(storage ?? source.text, source.path, { report: diagnostic => this.recordDiagnostic(diagnostic) }),
      storage,
      diagnosticNext: 0,
      tokenCount: 0,
    };
    this.frames.set(frame.id, frame);
    return frame;
  }

  private frame(id: number): SourceFrame {
    const frame = this.frames.get(id);
    if (frame === undefined) throw new RangeError("source script pointer does not identify a live script");
    return frame;
  }

  private nextFrameId(frame: SourceFrame): number { return frame.storage === null ? frame.diagnosticNext : frame.storage.nextScript; }
  private setNextFrame(frame: SourceFrame, next: number): void {
    if (frame.storage === null) frame.diagnosticNext = next;
    else frame.storage.nextScript = next;
  }

  private readSourceToken(output: PrecompToken): ScriptToken | undefined {
    while (this.source.tokens === 0) {
      const frame = this.currentFrame;
      let token: ScriptToken | undefined;
      let failure: ScriptLanguageError | undefined;
      try {
        const record = frame.lexer.nextInto(output.token);
        if (record !== undefined) {
          token = record.token;
          output.context = { path: token.location.path, column: token.location.column, leadingWhitespace: token.leadingWhitespace };
          output.unsupported = undefined;
        }
      } catch (error) {
        if (!(error instanceof ScriptLanguageError) || !this.isSourceFailure(error)) throw error;
        failure = new ScriptLanguageError(error.diagnostic, this.reported);
      }
      if (token !== undefined) {
        if (frame.tokenCount >= this.limits.sourceTokens) {
          this.fail(`source exceeds the ${this.limits.sourceTokens}-token limit`, token.location);
        }
        frame.tokenCount++;
        return this.snapshotToken(output);
      }
      if (this.currentFrame.lexer.endOfScript) {
        while (this.source.hasCurrentIndent()) {
          this.warn("missing #endif", this.currentFrame.lexer.currentLocation);
          this.source.popIndent();
        }
      }
      const exhausted = this.currentFrame;
      const next = this.nextFrameId(exhausted);
      if (next === 0) {
        if (failure !== undefined) throw failure;
        return undefined;
      }
      this.source.script = next;
      this.frames.delete(exhausted.id);
      exhausted.lexer.dispose();
    }
    const token = this.heap.token(this.source.tokens);
    output.copyFrom(token);
    this.source.tokens = token.token.next;
    this.heap.freeToken(token);
    return this.snapshotToken(output);
  }

  private readToken(output: PrecompToken): ScriptToken | undefined {
    while (true) {
      let token = this.readSourceToken(output);
      if (token === undefined) return undefined;
      if (this.isPunctuation(token, Punctuation.Preprocessor)) {
        this.directive(this.cursor, token.location);
        continue;
      }
      if (this.isPunctuation(token, Punctuation.Dollar)) {
        this.dollarDirective(this.cursor, token.location);
        continue;
      }
      if (token.kind === "string") {
        let next: ScriptToken | undefined;
        try { next = this.readToken(localToken()); }
        catch (error) {
          if (!(error instanceof SourceReadFalse) && !this.isSourceFailure(error)) throw error;
        }
        if (next?.kind === "string") {
          const following = this.tokenValue(next).token.string;
          output.token.setStringByte(output.token.string.length - 1, 0);
          const combined = output.token.string + following.slice(1);
          if (combined.length + 1 >= DEFAULT_SCRIPT_TOKEN_LIMIT) {
            this.fail(`string longer than MAX_TOKEN ${DEFAULT_SCRIPT_TOKEN_LIMIT}\n`, token.location);
          }
          output.token.writeString(combined);
          token = this.snapshotToken(output);
        } else if (next !== undefined) {
          this.cursor.unread(next);
        }
      }
      if (!this.isSourceActive()) continue;
      if (token.kind === "name" && this.macros.has(token.value)) {
        if (!this.expandMacroIntoSource(token)) return undefined;
        continue;
      }
      this.source.token.copyFrom(output);
      return token;
    }
  }

  private snapshotToken(stored: PrecompToken): ScriptToken {
    const record = stored.token.readRecord(stored.context);
    this.tokenMetadata.set(record.token, stored.unsupported === undefined
      ? { kind: "defined", subtype: record.subtype, integerValue: record.integerValue, floatValue: record.floatValue }
      : { kind: "uninitialized", reason: stored.unsupported });
    return record.token;
  }

  private tokenValue(token: ScriptToken): PrecompToken {
    const stored = localToken();
    stored.token.writeToken(token);
    const metadata = this.metadata(token);
    if (metadata.kind === "defined") {
      stored.token.subtype = metadata.subtype;
      stored.token.integerValue = metadata.integerValue;
      stored.token.floatValue = metadata.floatValue;
    } else stored.unsupported = metadata.reason;
    stored.context = { path: token.location.path, column: token.location.column, leadingWhitespace: token.leadingWhitespace };
    return stored;
  }

  private unreadToken(token: ScriptToken): void {
    const copied = this.heap.copyToken(this.tokenValue(token));
    copied.token.next = this.source.tokens;
    this.source.tokens = copied.id;
  }

  private freePendingTokens(): void {
    while (this.source.tokens !== 0) {
      const token = this.heap.token(this.source.tokens);
      this.source.tokens = token.token.next;
      this.heap.freeToken(token);
    }
  }

  private isSourceActive(): boolean {
    return this.source.skip === 0;
  }

  private metadata(token: ScriptToken): TokenMetadata {
    const retained = this.tokenMetadata.get(token);
    if (retained !== undefined) return retained;
    switch (token.kind) {
      case "primitive":
        return { kind: "defined", subtype: 0, integerValue: 0, floatValue: 0 };
      case "number":
        return { kind: "defined", subtype: token.flags, integerValue: token.integerValue, floatValue: token.floatValue };
      case "punctuation":
        return { kind: "defined", subtype: token.punctuation, integerValue: 0, floatValue: 0 };
      case "string":
      case "literal":
      case "name":
        return { kind: "defined", subtype: token.length, integerValue: 0, floatValue: 0 };
      default: {
        const exhaustive: never = token;
        throw new Error(`unknown script token ${String(exhaustive)}`);
      }
    }
  }

  private directive(
    cursor: LineTokenReader,
    hashLocation: SourceLocation,
  ): void {
    const directive = cursor.next();
    if (directive === undefined || directive.linesCrossed > 0) {
      if (directive !== undefined) {
        cursor.unread(directive);
      }
      this.fail(directive === undefined ? "found # without name" : "found # at end of line", hashLocation);
    }
    if (directive.kind !== "name") {
      this.fail(`unknown precompiler directive ${directive.text}`, directive.location);
    }
    switch (directive.value) {
      case "if":
        this.ifDirective(cursor, directive.location);
        return;
      case "ifdef":
        this.ifdefDirective(cursor, directive.location, false);
        return;
      case "ifndef":
        this.ifdefDirective(cursor, directive.location, true);
        return;
      case "elif":
        this.elifDirective(cursor, directive.location);
        return;
      case "else":
        this.elseDirective(directive.location);
        return;
      case "endif":
        this.endifDirective(directive.location);
        return;
      default:
        break;
    }
    switch (directive.value) {
      case "include":
        if (this.isSourceActive()) this.includeDirective(cursor, this.currentScriptFilename, directive.location);
        return;
      case "define":
        if (this.isSourceActive()) this.defineDirective(cursor, directive.location);
        return;
      case "undef": {
        if (this.isSourceActive()) {
          const name = this.readLineToken(cursor);
          this.undefine(name === undefined ? [] : [name], directive.location);
        }
        return;
      }
      case "eval":
        this.evaluateDirective(cursor, true, directive.location, "hash");
        return;
      case "evalfloat":
        this.evaluateDirective(cursor, false, directive.location, "hash");
        return;
      case "line":
        this.fail("#line directive not supported", directive.location);
      case "error":
        this.fail(`#error directive: ${cursor.next()?.text ?? ""}`, directive.location);
      case "pragma":
        this.warn("#pragma directive not supported", directive.location);
        this.readLine(cursor);
        return;
      default:
        this.fail(`unknown precompiler directive ${directive.value}`, directive.location);
    }
  }

  private ifDirective(cursor: LineTokenReader, location: SourceLocation): void {
    const selected = this.evaluateExpression(cursor, true, location, "hash").integerValue !== 0;
    this.source.pushIndent(SourceIndentType.If, !selected);
  }

  private ifdefDirective(
    cursor: LineTokenReader,
    location: SourceLocation,
    negate: boolean,
  ): void {
    const name = this.readLineToken(cursor);
    if (name === undefined || name.kind !== "name") {
      if (name !== undefined) cursor.unread(name);
      this.fail(name === undefined ? "#ifdef without name" : `expected name after #ifdef, found ${name.text}`, location);
    }
    const isDefined = this.macros.has(name.value);
    const selected = negate ? !isDefined : isDefined;
    this.source.pushIndent(negate ? SourceIndentType.Ifndef : SourceIndentType.Ifdef, !selected);
  }

  private elifDirective(cursor: LineTokenReader, location: SourceLocation): void {
    const conditional = this.source.popIndent();
    if (conditional === undefined) {
      this.fail("misplaced #elif", location);
    }
    if (conditional.type === SourceIndentType.Else) {
      this.fail("misplaced #elif", location);
    }
    const selected = this.evaluateExpression(cursor, true, location, "hash").integerValue !== 0;
    this.source.pushIndent(SourceIndentType.Elif, !selected);
  }

  private elseDirective(location: SourceLocation): void {
    const conditional = this.source.popIndent();
    if (conditional === undefined) {
      this.fail("misplaced #else", location);
    }
    if (conditional.type === SourceIndentType.Else) {
      this.fail("#else after #else", location);
    }
    this.source.pushIndent(SourceIndentType.Else, conditional.skip === 0);
  }

  private endifDirective(location: SourceLocation): void {
    if (this.source.popIndent() === undefined) {
      this.fail("misplaced #endif", location);
    }
  }

  private readLine(cursor: LineTokenReader): readonly ScriptToken[] {
    const line: ScriptToken[] = [];
    while (true) {
      const token = this.readLineToken(cursor);
      if (token === undefined) {
        return Object.freeze(line);
      }
      line.push(token);
    }
  }

  private readLineToken(cursor: LineTokenReader): ScriptToken | undefined {
    let mayCrossLine = false;
    while (true) {
      const token = cursor.next();
      if (token === undefined) {
        return undefined;
      }
      if (token.linesCrossed > (mayCrossLine ? 1 : 0)) {
        cursor.unread(token);
        return undefined;
      }
      if (token.text === "\\") {
        mayCrossLine = true;
        continue;
      }
      return token;
    }
  }

  private defineDirective(cursor: LineTokenReader, location: SourceLocation): void {
    const name = this.readLineToken(cursor);
    if (name === undefined || name.kind !== "name") {
      if (name !== undefined) cursor.unread(name);
      this.fail(name === undefined ? "#define without name" : `expected name after #define, found ${name.text}`, location);
    }
    const existing = this.macros.get(name.value);
    if (existing?.fixed === true) {
      this.fail(`can't redefine ${name.value}`, name.location);
    }
    if (existing !== undefined) {
      this.warn(`redefinition of ${name.value}`, name.location);
      cursor.unread(name);
      const unread = this.readLineToken(cursor);
      this.undefine(unread === undefined ? [] : [unread], name.location);
    } else if (this.macros.size >= this.limits.defines) {
      this.fail(`define count exceeds ${this.limits.defines}`, name.location);
    }
    const macro = this.heap.allocateDefine(name.value, true);
    this.macros.prepend(macro);
    let token = this.readLineToken(cursor);
    if (token === undefined) return;
    const opening = this.tokenValue(token).token;
    if (token.text === "(" && opening.whitespaceEnd - opening.whitespaceStart <= 0) {
      let last: PrecompToken | undefined;
      const checked = this.readToken(localToken());
      if (checked?.text !== ")") {
        if (checked !== undefined) cursor.unread(checked);
        while (true) {
          const parameter = this.readLineToken(cursor);
          if (parameter === undefined || parameter.kind !== "name") {
            this.fail(parameter === undefined ? "expected define parameter" : "invalid define parameter", parameter?.location ?? location);
          }
          if (macro.parameterIndex(parameter.value) >= 0) {
            this.fail("two the same define parameters", parameter.location);
          }
          const copied = this.heap.copyToken(this.tokenValue(parameter));
          copied.clearWhitespace();
          if (last === undefined) macro.parms = copied.id;
          else last.token.next = copied.id;
          last = copied;
          macro.numparms++;
          const separator = this.readLineToken(cursor);
          if (separator === undefined) this.fail("define parameters not terminated", location);
          if (separator.text === ")") break;
          if (separator.text !== ",") this.fail("define not terminated", separator.location);
        }
      }
      token = this.readLineToken(cursor);
      if (token === undefined) return;
    }
    let last: PrecompToken | undefined;
    do {
      const copied = this.heap.copyToken(this.tokenValue(token));
      if (copied.token.type === 4 && copied.token.string === macro.name) {
        this.error("recursive define (removed recursion)", token.location);
      } else {
        copied.clearWhitespace();
        if (last === undefined) macro.tokens = copied.id;
        else last.token.next = copied.id;
        last = copied;
      }
      token = this.readLineToken(cursor);
    } while (token !== undefined);
    if (last !== undefined && (this.heap.token(macro.tokens).token.string === "##" || last.token.string === "##")) {
      this.fail("define with misplaced ##", location);
    }
  }

  private undefine(tokens: readonly ScriptToken[], location: SourceLocation): void {
    if (tokens.length !== 1 || tokens[0]?.kind !== "name") {
      const invalid = tokens[0];
      if (invalid !== undefined) this.cursor.unread(invalid);
      this.fail(invalid === undefined ? "undef without name" : `expected name, found ${invalid.text}`, location);
    }
    const name = tokens[0];
    if (name === undefined || name.kind !== "name") {
      throw new Error("undef validation was inconsistent");
    }
    const macro = this.macros.get(name.value);
    if (macro?.fixed === true) {
      this.warn(`can't undef ${name.value}`, name.location);
      return;
    }
    this.macros.delete(name.value);
  }

  private includeDirective(
    cursor: LineTokenReader,
    sourcePath: string,
    location: SourceLocation,
  ): void {
    const first = cursor.next();
    if (first === undefined || first.linesCrossed > 0) {
      this.fail("#include without file name", location);
    }
    let request: IncludeRequest;
    if (first.kind === "string") {
      const includePath = this.source.includePath;
      request = Object.freeze({ kind: "quoted", fromPath: sourcePath, requestedPath: first.value,
        ...(includePath.length === 0 ? {} : { includePath }) });
    } else if (this.isPunctuation(first, Punctuation.Less)) {
      const pieces: string[] = [];
      let closed = false;
      while (true) {
        const token = cursor.next();
        if (token === undefined) break;
        if (token.linesCrossed > 0) {
          cursor.unread(token);
          break;
        }
        if (this.isPunctuation(token, Punctuation.Greater)) {
          closed = true;
          break;
        }
        pieces.push(token.text);
      }
      if (!closed) this.warn("#include missing trailing >", first.location);
      const requestedPath = this.source.includePath + pieces.join("");
      if (requestedPath.length === 0) {
        this.fail("#include without file name between < >", first.location);
      }
      request = Object.freeze({ kind: "system", fromPath: sourcePath, requestedPath });
    } else {
      this.fail("#include without file name", first.location);
    }
    if (this.frames.size >= this.limits.includeDepth) {
      this.fail(`include depth exceeds ${this.limits.includeDepth}`, location);
    }
    const included = this.resolver.resolve(request);
    if (included === undefined) {
      const zero = request.requestedPath.indexOf("\0");
      const converted = (zero < 0 ? request.requestedPath : request.requestedPath.slice(0, zero)).replace(/[\\/]+/g, "/");
      const failedPath = request.kind === "quoted" ? this.source.includePath + converted : converted;
      this.fail(`file ${failedPath} not found`, location);
    }
    if (included.path.length === 0) {
      this.fail("include resolver returned an empty canonical path", location);
    }
    const includedFrame = this.createFrame(included);
    let remaining = this.frames.size + 1;
    for (let id = this.source.script; id !== 0;) {
      if (--remaining === 0) throw new RangeError("source script stack contains a cycle");
      const frame = this.frame(id);
      if (qStricmp(frame.lexer.currentLocation.path, included.path) === 0) {
        this.error(`${included.path} recursively included`, { path: included.path, line: 1, column: 1 });
        this.frames.delete(includedFrame.id);
        return;
      }
      id = this.nextFrameId(frame);
    }
    this.setNextFrame(includedFrame, this.source.script);
    this.source.script = includedFrame.id;
  }

  private expandMacroIntoSource(invocation: NameToken): boolean {
    const macro = this.macros.get(invocation.value);
    if (macro === undefined) return true;
    this.expansionCount++;
    if (this.expansionCount > this.limits.macroExpansions) {
      this.fail(`macro expansion count exceeds ${this.limits.macroExpansions}`, invocation.location);
    }
    const expanded = macro.builtin !== 0
      ? this.expandBuiltin(macro, invocation)
      : this.expandDefine(macro, invocation.location);
    if (expanded.first === 0 || expanded.last === 0) return false;
    this.heap.token(expanded.last).token.next = this.source.tokens;
    this.source.tokens = expanded.first;
    return true;
  }

  private readMacroArguments(
    macro: PrecompDefine,
    location: SourceLocation,
  ): readonly number[] {
    const opening = this.cursor.next();
    if (opening === undefined) this.fail(`define ${macro.name} missing parms`, location);
    if (macro.numparms > MAX_DEFINE_PARAMETERS) this.fail(`define with more than ${MAX_DEFINE_PARAMETERS} parameters`, location);
    const argumentsList: number[] = Array.from({ length: macro.numparms }, () => 0);
    if (opening.text !== "(") {
      this.cursor.unread(opening);
      this.fail(`define ${macro.name} missing parms`, location);
    }
    let argumentTokenCount = 0;
    let depth = 0;
    let done = false;
    for (let argument = 0; !done; argument++) {
      if (argument >= MAX_DEFINE_PARAMETERS) this.fail(`define ${macro.name} with too many parms`, location);
      if (argument >= macro.numparms) {
        const diagnostic: ScriptDiagnostic = Object.freeze({ severity: "warning",
          message: `define ${macro.name} has too many parms`, location: this.currentFrame.lexer.currentLocation });
        this.recordDiagnostic(diagnostic);
        throw new ScriptLanguageError(diagnostic, this.reported);
      }
      argumentsList[argument] = 0;
      let last: PrecompToken | undefined;
      let lastComma = true;
      while (!done) {
        const token = this.cursor.next();
        if (token === undefined) this.fail(`define ${macro.name} incomplete`, location);
        if (token.text === "," && depth <= 0) {
          if (lastComma) this.warn("too many comma's", token.location);
          break;
        }
        lastComma = false;
        if (token.text === "(") { depth++; continue; }
        if (token.text === ")" && --depth <= 0) {
          const lastArgument = argumentsList[macro.numparms - 1];
          if (lastArgument === undefined) throw new RangeError("define parameter count exceeds its local argument table");
          if (lastArgument === 0) this.warn("too few define parms", token.location);
          done = true;
          break;
        }
        this.checkArgumentCapacity(argumentTokenCount++, token.location);
        const copied = this.heap.copyToken(this.tokenValue(token));
        if (last === undefined) argumentsList[argument] = copied.id;
        else last.token.next = copied.id;
        last = copied;
      }
    }
    return argumentsList;
  }

  private checkArgumentCapacity(argumentTokenCount: number, location: SourceLocation): void {
    if (argumentTokenCount >= this.limits.queuedTokens) {
      this.fail(`macro argument queue exceeds ${this.limits.queuedTokens} tokens`, location);
    }
  }

  private appendToken(list: TokenChain, token: PrecompToken, location: SourceLocation): void {
    if (list.count >= this.limits.queuedTokens) this.fail(`macro expansion queue exceeds ${this.limits.queuedTokens} tokens`, location);
    if (list.last === 0) list.first = token.id;
    else this.heap.token(list.last).token.next = token.id;
    list.last = token.id;
    list.count++;
  }

  private expandDefine(macro: PrecompDefine, location: SourceLocation): TokenChain {
    const argumentsList = macro.numparms !== 0 ? this.readMacroArguments(macro, location) : [];
    const expanded: TokenChain = { first: 0, last: 0, count: 0 };
    for (let id = macro.tokens; id !== 0;) {
      let defined = this.heap.token(id);
      const parameter = defined.token.type === 4 ? macro.parameterIndex(defined.token.string) : -1;
      if (parameter >= 0) {
        const argument = argumentsList[parameter];
        if (argument === undefined) throw new RangeError("define parameter does not identify a supplied argument slot");
        for (const token of this.heap.chain(argument)) {
          this.appendToken(expanded, this.heap.copyToken(token), location);
        }
      } else {
        let copied: PrecompToken;
        if (defined.token.string === "#") {
          const next = defined.token.next === 0 ? undefined : this.heap.token(defined.token.next);
          const stringParameter = next === undefined ? -1 : macro.parameterIndex(next.token.string);
          if (next === undefined || stringParameter < 0) {
            this.warn("stringizing operator without define parameter", location);
            id = defined.token.next;
            continue;
          }
          defined = next;
          const argument = argumentsList[stringParameter];
          if (argument === undefined) throw new RangeError("stringizing parameter does not identify an argument slot");
          let text = '"';
          for (const token of this.heap.chain(argument)) text += token.token.string;
          text += '"';
          const stringized = localToken();
          stringized.token.type = 1;
          stringized.token.writeString(text);
          stringized.context = { path: location.path, column: location.column, leadingWhitespace: "" };
          stringized.unsupported = "macro stringizing leaves subtype and numeric fields uninitialized";
          copied = this.heap.copyToken(stringized);
        } else copied = this.heap.copyToken(defined);
        this.appendToken(expanded, copied, location);
      }
      id = defined.token.next;
    }
    for (let id = expanded.first; id !== 0;) {
      const first = this.heap.token(id);
      const merge = first.token.next === 0 ? undefined : this.heap.token(first.token.next);
      if (merge !== undefined && merge.token.string.startsWith("##") && merge.token.next !== 0) {
        const second = this.heap.token(merge.token.next);
        const left = first.token, right = second.token;
        if (left.type === 4 && (right.type === 4 || right.type === 3)) left.writeString(left.string + right.string);
        else if (left.type === 1 && right.type === 1) left.writeString(left.string.slice(0, -1) + right.string.slice(1));
        else this.fail(`can't merge ${left.string} with ${right.string}`, location);
        this.heap.freeToken(merge);
        first.token.next = second.token.next;
        if (second.id === expanded.last) expanded.last = first.id;
        this.heap.freeToken(second);
        continue;
      }
      id = first.token.next;
    }
    for (let index = 0; index < macro.numparms; index++) {
      const argument = argumentsList[index];
      if (argument === undefined) throw new RangeError("define parameter count exceeds its argument table");
      this.heap.freeTokens(argument);
    }
    return expanded;
  }

  private expandBuiltin(macro: PrecompDefine, invocation: NameToken): TokenChain {
    const copied = this.heap.copyToken(this.tokenValue(invocation));
    const token = copied.token;
    switch (macro.builtin) {
      case 1:
        token.writeString(String(invocation.location.line));
        token.integerValue = invocation.location.line;
        token.floatValue = invocation.location.line;
        token.type = 3;
        token.subtype = NumberFlag.Decimal | NumberFlag.Integer;
        break;
      case 2:
        token.writeString(this.currentScriptFilename);
        token.type = 4;
        token.subtype = token.string.length;
        break;
      case 3: {
        const date = this.now();
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = months[date.getMonth()] ?? "???";
        const day = String(date.getDate()).padStart(2, " ");
        token.writeString(`"${month} ${day} ${date.getFullYear()}"`);
        token.type = 4;
        token.subtype = token.string.length;
        break;
      }
      case 4: {
        const date = this.now();
        const hour = String(date.getHours()).padStart(2, "0");
        const minute = String(date.getMinutes()).padStart(2, "0");
        const second = String(date.getSeconds()).padStart(2, "0");
        token.writeString(`"${hour}:${minute}:${second}"`);
        token.type = 4;
        token.subtype = token.string.length;
        break;
      }
      default: return { first: 0, last: 0, count: 0 };
    }
    return { first: copied.id, last: copied.id, count: 1 };
  }

  private evaluateDirective(
    cursor: LineTokenReader,
    integerMode: boolean,
    location: SourceLocation,
    form: "hash" | "dollar",
  ): void {
    const value = this.evaluateExpression(cursor, integerMode, location, form);
    const numeric = integerMode ? value.integerValue : value.floatValue;
    const absolute = Math.abs(numeric);
    const text = integerMode ? String(Math.trunc(absolute)) : evaluationDecimal(absolute);
    const flags = NumberFlag.Decimal | NumberFlag.Long | (integerMode ? NumberFlag.Integer : NumberFlag.Float);
    const emittedLocation = this.currentFrame.lexer.currentLocation;
    const number = makeNumber(text, absolute, flags, emittedLocation);
    this.tokenMetadata.set(number, form === "hash"
      ? { kind: "uninitialized", reason: "#eval and #evalfloat leave numeric fields uninitialized" }
      : { kind: "defined", subtype: flags, integerValue: Math.trunc(numeric), floatValue: numeric });
    this.unreadToken(number);
    if (numeric < 0) {
      const sign = makePunctuation("-", Punctuation.Subtract, emittedLocation);
      this.tokenMetadata.set(sign, { kind: "uninitialized", reason: "evaluation sign token leaves numeric fields uninitialized" });
      this.unreadToken(sign);
    }
  }

  private evaluateExpression(cursor: LineTokenReader, integerMode: boolean,
    location: SourceLocation, form: "hash" | "dollar"): EvalValue {
    if (form === "dollar") cursor.next();
    const read = (): ScriptToken | undefined => form === "hash" ? this.readLineToken(cursor) : cursor.next();
    let token = read();
    if (token === undefined) this.fail(form === "hash" ? "no value after #if/#elif" : "nothing to evaluate", location);
    const expression: TokenChain = { first: 0, last: 0, count: 0 };
    let defined = false;
    let depth = 1;
    do {
      if (token.kind === "name") {
        if (defined) defined = false;
        else if (token.value === "defined") defined = true;
        else {
          if (!this.macros.has(token.value)) this.fail(`can't evaluate ${token.value}, not defined`, token.location);
          if (!this.expandMacroIntoSource(token)) throw new SourceReadFalse();
          token = read();
          continue;
        }
      } else if (token.kind === "number" || token.kind === "punctuation") {
        if (form === "dollar") {
          if (token.text.startsWith("(")) depth++;
          else if (token.text.startsWith(")")) depth--;
          if (depth <= 0) break;
        }
      } else this.fail(`can't evaluate ${token.text}`, token.location);
      this.appendToken(expression, this.heap.copyToken(this.tokenValue(token)), location);
      if (expression.count > this.limits.expressionTokens) this.fail(`expression exceeds ${this.limits.expressionTokens} tokens`, location);
      token = read();
    } while (token !== undefined);
    const tokens = Array.from(this.heap.chain(expression.first), token => this.snapshotToken(token));
    const value = new ExpressionParser(tokens, integerMode, name => this.macros.has(name),
      (message, failureLocation) => this.fail(message, failureLocation), location,
      (message, failureLocation) => this.error(message, failureLocation)).evaluate();
    this.heap.freeTokens(expression.first);
    return value;
  }

  private dollarDirective(cursor: LineTokenReader, location: SourceLocation): void {
    const name = cursor.next();
    if (name === undefined || name.linesCrossed > 0) {
      if (name !== undefined) cursor.unread(name);
      this.fail(name === undefined ? "found $ without name" : "found $ at end of line", location);
    }
    const integerMode = name.kind === "name" && name.value === "evalint";
    if (!integerMode && (name.kind !== "name" || name.value !== "evalfloat")) {
      cursor.unread(name);
      this.fail(`unknown precompiler directive ${name.text}`, name.location);
    }
    this.evaluateDirective(cursor, integerMode, location, "dollar");
  }

  private isPunctuation(token: ScriptToken, punctuation: Punctuation): boolean {
    return token.kind === "punctuation" && token.punctuation === punctuation;
  }

  private warn(message: string, _location: SourceLocation): void {
    this.recordDiagnostic(Object.freeze({ severity: "warning", message, location: this.currentFrame.lexer.currentLocation }));
  }

  private error(message: string, _location: SourceLocation): void {
    this.recordDiagnostic(Object.freeze({ severity: "error", message, location: this.currentFrame.lexer.currentLocation }));
  }

  private fail(message: string, _location: SourceLocation): never {
    const diagnostic = Object.freeze({ severity: "error", message, location: this.currentFrame.lexer.currentLocation });
    this.recordDiagnostic(diagnostic);
    throw new ScriptLanguageError(diagnostic, this.reported);
  }

  private recordDiagnostic(diagnostic: ScriptDiagnostic): void {
    this.reported.push(diagnostic);
    this.invokeCallback(() => this.report?.(diagnostic));
  }

  private invokeCallback<T>(callback: () => T): T {
    try { return callback(); }
    catch (error) {
      if (error instanceof ScriptLanguageError) this.callbackAborts.add(error);
      throw error;
    }
  }
}

export class ScriptGlobalDefines {
  private readonly heap: PrecompMemory;
  private first = 0;
  private readonly reported: ScriptDiagnostic[] = [];

  constructor(private readonly report?: (diagnostic: ScriptDiagnostic) => void, private readonly memory?: ScriptMemory) {
    this.heap = new PrecompMemory(memory);
  }

  get diagnostics(): readonly ScriptDiagnostic[] { return Object.freeze([...this.reported]); }

  add(text: string): boolean {
    const macro = defineFromString(text, this.memory, this.heap, diagnostic => {
      this.reported.push(diagnostic);
      this.report?.(diagnostic);
    });
    if (macro === undefined) return false;
    macro.next = this.first;
    this.first = macro.id;
    return true;
  }

  /** PC_RemoveGlobalDefine frees without unlinking; later traversal reaches the dangling ID. */
  remove(name: string): boolean {
    const zero = name.indexOf("\0"), text = zero < 0 ? name : name.slice(0, zero);
    for (let id = this.first; id !== 0;) {
      const define = this.heap.define(id);
      if (define.name === text) { this.heap.freeDefine(define); return true; }
      id = define.next;
    }
    return false;
  }

  snapshot(): ScriptGlobalSnapshot {
    const copied = new PrecompMemory(undefined);
    const definitions: PrecompDefine[] = [];
    for (let id = this.first; id !== 0;) {
      const define = this.heap.define(id);
      definitions.push(copied.copyDefine(define));
      id = define.next;
    }
    return Object.freeze({ definitions: Object.freeze(definitions) });
  }

  copyTo(memory: PrecompMemory, publish: (define: PrecompDefine) => void): void {
    for (let id = this.first; id !== 0;) {
      const define = this.heap.define(id);
      publish(memory.copyDefine(define));
      id = define.next;
    }
  }

  clear(): void {
    while (this.first !== 0) {
      const define = this.heap.define(this.first);
      this.first = define.next;
      this.heap.freeDefine(define);
    }
  }
}

function defineFromString(text: string, memory: ScriptMemory | undefined, heap: PrecompMemory,
  report: (diagnostic: ScriptDiagnostic) => void): PrecompDefine | undefined {
  const zero = text.indexOf("\0");
  const engine = new PreprocessorEngine({ path: "*extern", text: zero < 0 ? text : text.slice(0, zero) }, { resolve: () => undefined }, {
    ...(memory === undefined ? {} : { memory }), report,
  }, "global", heap);
  let define: PrecompDefine | undefined;
  try { define = engine.parseGlobal(); }
  catch (error) {
    if (!(error instanceof SourceReadFalse) && !engine.isSourceFailure(error)) throw error;
  }
  engine.dispose();
  return define;
}

export class ScriptSourceReader {
  private constructor(private readonly engine: PreprocessorEngine) {}

  static open(
    root: ScriptSource,
    resolver: IncludeResolver,
    options: ScriptPreprocessorOptions = {},
  ): ScriptSourceReader {
    return new ScriptSourceReader(new PreprocessorEngine(root, resolver, options));
  }

  next(): ScriptTokenRecord | undefined { return this.engine.nextRecord(); }
  get rawToken(): SourceTokenMemory { return this.engine.rawToken; }
  get currentRecord(): ScriptTokenRecord { return this.engine.currentRecord; }
  unread(record: ScriptTokenRecord): void { this.engine.unread(record); }
  unreadLast(): void { this.engine.unreadLast(); }
  dispose(): void { this.engine.dispose(); }
  disposeRecordOnly(): void { this.engine.disposeRecordOnly(); }
  setIncludePath(path: string): void { this.engine.setIncludePath(path); }
  setPunctuations(punctuations: readonly ScriptPunctuation[] | null): void { this.engine.setPunctuations(punctuations); }
  addDefine(text: string): boolean { return this.engine.addDefine(text); }
  addBuiltinDefines(): void { this.engine.addBuiltinDefines(); }
  printDefineHashTable(write: (text: string) => void): void { this.engine.printDefineHashTable(write); }
  expectTokenString(text: string): boolean { return this.engine.expectTokenString(text); }
  expectAnyToken(output: SourceTokenMemory): boolean { return this.engine.expectAnyToken(output); }
  expectTokenType(type: number, subtype: number, output: SourceTokenMemory): boolean { return this.engine.expectTokenType(type, subtype, output); }
  checkTokenString(text: string): boolean { return this.engine.checkTokenString(text); }
  checkTokenType(type: number, subtype: number, output: SourceTokenMemory): boolean { return this.engine.checkTokenType(type, subtype, output); }
  skipUntilString(text: string): boolean { return this.engine.skipUntilString(text); }
  readLineInto(output: SourceTokenMemory): boolean { return this.engine.readLineInto(output); }
  isSourceFailure(error: unknown): boolean { return this.engine.isSourceFailure(error); }
  get position(): ScriptSourcePosition { return this.engine.position; }
  get currentScriptFilename(): string { return this.engine.currentScriptFilename; }
  get diagnostics(): readonly ScriptDiagnostic[] { return this.engine.diagnostics; }
}

export class ScriptPreprocessor {
  private readonly tokens: readonly ScriptToken[];
  private readonly reported: readonly ScriptDiagnostic[];
  private index = 0;
  private unreadToken: ScriptToken | undefined;

  private constructor(tokens: readonly ScriptToken[], diagnostics: readonly ScriptDiagnostic[], private readonly engine: PreprocessorEngine) {
    this.tokens = Object.freeze([...tokens]);
    this.reported = Object.freeze([...diagnostics]);
  }

  static create(
    root: ScriptSource,
    resolver: IncludeResolver,
    options: ScriptPreprocessorOptions = {},
  ): ScriptPreprocessor {
    const engine = new PreprocessorEngine(root, resolver, options);
    const tokens: ScriptToken[] = [];
    while (true) {
      const token = engine.nextToken();
      if (token === undefined) break;
      tokens.push(token);
    }
    return new ScriptPreprocessor(tokens, engine.diagnostics, engine);
  }

  dispose(): void { this.engine.dispose(); }

  get diagnostics(): readonly ScriptDiagnostic[] {
    return this.reported;
  }

  next(): ScriptToken | undefined {
    if (this.unreadToken !== undefined) {
      const token = this.unreadToken;
      this.unreadToken = undefined;
      return token;
    }
    const token = this.tokens[this.index];
    if (token !== undefined) {
      this.index++;
    }
    return token;
  }

  unread(token: ScriptToken): void {
    if (this.unreadToken !== undefined) {
      throw new Error("ScriptPreprocessor can only unread one token");
    }
    this.unreadToken = token;
  }

  reset(): void {
    this.index = 0;
    this.unreadToken = undefined;
  }

  all(): readonly ScriptToken[] {
    return this.tokens;
  }
}
