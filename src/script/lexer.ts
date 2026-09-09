/*
 * Lexical parser translated from Quake III Arena botlib/l_script.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { SourceScriptStorage, type ScriptMemory } from "./memory.ts";
import { SOURCE_SCRIPT_BYTES } from "./memory.ts";
import { SOURCE_TOKEN_BYTES, SourceTokenMemory, type SourceTokenContext } from "./token-memory.ts";

export const DEFAULT_SCRIPT_TOKEN_LIMIT = 1024;

export enum ScriptTokenType { Primitive = 0, String = 1, Literal = 2, Number = 3, Name = 4, Punctuation = 5 }

export function scriptTokenTypeName(type: number): string {
  switch (type) {
    case ScriptTokenType.String: return "string";
    case ScriptTokenType.Literal: return "literal";
    case ScriptTokenType.Number: return "number";
    case ScriptTokenType.Name: return "name";
    case ScriptTokenType.Punctuation: return "punctuation";
    default: return "";
  }
}

export function scriptNumberSubtypeName(subtype: number): string {
  let name: string | undefined;
  if ((subtype & NumberFlag.Decimal) !== 0) name = "decimal";
  if ((subtype & NumberFlag.Hex) !== 0) name = "hex";
  if ((subtype & NumberFlag.Octal) !== 0) name = "octal";
  if ((subtype & NumberFlag.Binary) !== 0) name = "binary";
  if (name === undefined) throw new RangeError("expected numeric subtype diagnostic reads an uninitialized source string");
  if ((subtype & NumberFlag.Long) !== 0) name += " long";
  if ((subtype & NumberFlag.Unsigned) !== 0) name += " unsigned";
  if ((subtype & NumberFlag.Float) !== 0) name += " float";
  if ((subtype & NumberFlag.Integer) !== 0) name += " integer";
  return name;
}

function stripQuotes(text: string, quote: string): string {
  const zero = text.indexOf("\0");
  let value = zero < 0 ? text : text.slice(0, zero);
  if (value.startsWith(quote)) value = value.slice(1);
  if (value.length === 0) throw new RangeError("StripQuotes reads before the source string allocation");
  if (value.endsWith(quote)) value = value.slice(0, -1);
  return value;
}

export function stripDoubleQuotes(text: string): string { return stripQuotes(text, '"'); }
export function stripSingleQuotes(text: string): string { return stripQuotes(text, "'"); }

export enum NumberFlag {
  Decimal = 0x0008,
  Hex = 0x0100,
  Octal = 0x0200,
  Binary = 0x0400,
  Float = 0x0800,
  Integer = 0x1000,
  Long = 0x2000,
  Unsigned = 0x4000,
}

export enum Punctuation {
  RightShiftAssign = 1,
  LeftShiftAssign = 2,
  Parameters = 3,
  PreprocessorMerge = 4,
  LogicalAnd = 5,
  LogicalOr = 6,
  GreaterOrEqual = 7,
  LessOrEqual = 8,
  Equal = 9,
  NotEqual = 10,
  MultiplyAssign = 11,
  DivideAssign = 12,
  ModuloAssign = 13,
  AddAssign = 14,
  SubtractAssign = 15,
  Increment = 16,
  Decrement = 17,
  BinaryAndAssign = 18,
  BinaryOrAssign = 19,
  BinaryXorAssign = 20,
  RightShift = 21,
  LeftShift = 22,
  PointerReference = 23,
  Scope = 24,
  PointerToMember = 25,
  Multiply = 26,
  Divide = 27,
  Modulo = 28,
  Add = 29,
  Subtract = 30,
  Assign = 31,
  BinaryAnd = 32,
  BinaryOr = 33,
  BinaryXor = 34,
  BinaryNot = 35,
  LogicalNot = 36,
  Greater = 37,
  Less = 38,
  Reference = 39,
  Comma = 40,
  Semicolon = 41,
  Colon = 42,
  Question = 43,
  ParenthesisOpen = 44,
  ParenthesisClose = 45,
  BraceOpen = 46,
  BraceClose = 47,
  BracketOpen = 48,
  BracketClose = 49,
  Backslash = 50,
  Preprocessor = 51,
  Dollar = 52,
}

export enum LexerFlag {
  None = 0,
  NoErrors = 0x0001,
  NoWarnings = 0x0002,
  NoStringConcatenation = 0x0004,
  NoStringEscapes = 0x0008,
  Primitive = 0x0010,
  NoBinaryNumbers = 0x0020,
  NoNumberValues = 0x0040,
}

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export type ScriptDiagnostic =
  | {
    readonly severity: "warning";
    readonly message: string;
    readonly location: SourceLocation;
  }
  | {
    readonly severity: "error";
    readonly message: string;
    readonly location: SourceLocation;
  };

interface TokenBase {
  readonly text: string;
  readonly location: SourceLocation;
  readonly leadingWhitespace: string;
  readonly linesCrossed: number;
}

export interface StringToken extends TokenBase {
  readonly kind: "string";
  readonly value: string;
  readonly length: number;
}

export interface LiteralToken extends TokenBase {
  readonly kind: "literal";
  readonly value: string;
  readonly length: number;
}

export interface NumberToken extends TokenBase {
  readonly kind: "number";
  readonly flags: number;
  readonly integerValue: number;
  readonly floatValue: number;
}

export interface NameToken extends TokenBase {
  readonly kind: "name";
  readonly value: string;
  readonly length: number;
}

export interface PunctuationToken extends TokenBase {
  readonly kind: "punctuation";
  readonly value: string;
  readonly punctuation: number;
}

export interface PrimitiveToken extends TokenBase { readonly kind: "primitive"; readonly value: string }

export type ScriptToken = StringToken | LiteralToken | NumberToken | NameToken | PunctuationToken | PrimitiveToken;

export interface ScriptTokenRecord {
  readonly token: ScriptToken;
  readonly subtype: number;
  readonly integerValue: number;
  readonly floatValue: number;
}

export interface ScriptLexerOptions {
  readonly flags?: number;
  readonly maxTokenLength?: number;
  readonly report?: (diagnostic: ScriptDiagnostic) => void;
  readonly memory?: ScriptMemory;
}

export interface ScriptPunctuation {
  readonly text: string;
  readonly punctuation: number;
}

type PunctuationSpec = ScriptPunctuation;

const PUNCTUATIONS: readonly PunctuationSpec[] = [
  { text: ">>=", punctuation: Punctuation.RightShiftAssign },
  { text: "<<=", punctuation: Punctuation.LeftShiftAssign },
  { text: "...", punctuation: Punctuation.Parameters },
  { text: "##", punctuation: Punctuation.PreprocessorMerge },
  { text: "&&", punctuation: Punctuation.LogicalAnd },
  { text: "||", punctuation: Punctuation.LogicalOr },
  { text: ">=", punctuation: Punctuation.GreaterOrEqual },
  { text: "<=", punctuation: Punctuation.LessOrEqual },
  { text: "==", punctuation: Punctuation.Equal },
  { text: "!=", punctuation: Punctuation.NotEqual },
  { text: "*=", punctuation: Punctuation.MultiplyAssign },
  { text: "/=", punctuation: Punctuation.DivideAssign },
  { text: "%=", punctuation: Punctuation.ModuloAssign },
  { text: "+=", punctuation: Punctuation.AddAssign },
  { text: "-=", punctuation: Punctuation.SubtractAssign },
  { text: "++", punctuation: Punctuation.Increment },
  { text: "--", punctuation: Punctuation.Decrement },
  { text: "&=", punctuation: Punctuation.BinaryAndAssign },
  { text: "|=", punctuation: Punctuation.BinaryOrAssign },
  { text: "^=", punctuation: Punctuation.BinaryXorAssign },
  { text: ">>", punctuation: Punctuation.RightShift },
  { text: "<<", punctuation: Punctuation.LeftShift },
  { text: "->", punctuation: Punctuation.PointerReference },
  { text: "::", punctuation: Punctuation.Scope },
  { text: ".*", punctuation: Punctuation.PointerToMember },
  { text: "*", punctuation: Punctuation.Multiply },
  { text: "/", punctuation: Punctuation.Divide },
  { text: "%", punctuation: Punctuation.Modulo },
  { text: "+", punctuation: Punctuation.Add },
  { text: "-", punctuation: Punctuation.Subtract },
  { text: "=", punctuation: Punctuation.Assign },
  { text: "&", punctuation: Punctuation.BinaryAnd },
  { text: "|", punctuation: Punctuation.BinaryOr },
  { text: "^", punctuation: Punctuation.BinaryXor },
  { text: "~", punctuation: Punctuation.BinaryNot },
  { text: "!", punctuation: Punctuation.LogicalNot },
  { text: ">", punctuation: Punctuation.Greater },
  { text: "<", punctuation: Punctuation.Less },
  { text: ".", punctuation: Punctuation.Reference },
  { text: ",", punctuation: Punctuation.Comma },
  { text: ";", punctuation: Punctuation.Semicolon },
  { text: ":", punctuation: Punctuation.Colon },
  { text: "?", punctuation: Punctuation.Question },
  { text: "(", punctuation: Punctuation.ParenthesisOpen },
  { text: ")", punctuation: Punctuation.ParenthesisClose },
  { text: "{", punctuation: Punctuation.BraceOpen },
  { text: "}", punctuation: Punctuation.BraceClose },
  { text: "[", punctuation: Punctuation.BracketOpen },
  { text: "]", punctuation: Punctuation.BracketClose },
  { text: "\\", punctuation: Punctuation.Backslash },
  { text: "#", punctuation: Punctuation.Preprocessor },
  { text: "$", punctuation: Punctuation.Dollar },
];

interface PunctuationLink {
  readonly spec: PunctuationSpec;
  next: number;
}

function punctuationTable(punctuations: readonly ScriptPunctuation[]): { readonly heads: readonly number[]; readonly links: readonly PunctuationLink[] } {
  const heads: number[] = Array.from({ length: 256 }, () => 0);
  const links: PunctuationLink[] = punctuations.map(spec => ({ spec, next: 0 }));
  for (let index = 0; index < links.length; index++) {
    const added = links[index];
    if (added === undefined) throw new Error("default punctuation record is missing");
    const character = added.spec.text.charCodeAt(0);
    const head = heads[character];
    if (head === undefined || character > 127) throw new RangeError("punctuation table index exceeds its source signed-char allocation");
    let pointer: number = head;
    let previous: PunctuationLink | undefined;
    while (pointer !== 0) {
      const current: PunctuationLink | undefined = links[pointer - 1];
      if (current === undefined) throw new Error("default punctuation link is missing");
      if (current.spec.text.length < added.spec.text.length) break;
      previous = current;
      pointer = current.next;
    }
    added.next = pointer;
    if (previous === undefined) heads[character] = index + 1;
    else previous.next = index + 1;
  }
  return { heads: Object.freeze(heads), links: Object.freeze(links.map(link => Object.freeze(link))) };
}

const DEFAULT_PUNCTUATION_TABLE = punctuationTable(PUNCTUATIONS);

/** LoadScriptFile calls this before its actual read and close operations. */
export function allocateScriptSource(length: number, path: string, memory: ScriptMemory): SourceScriptStorage {
  const source = SourceScriptStorage.allocate(length, path, memory);
  source.setDefaultPunctuations(DEFAULT_PUNCTUATION_TABLE.heads);
  return source;
}

export class ScriptLanguageError extends Error {
  readonly diagnostic: ScriptDiagnostic;
  readonly diagnostics: readonly ScriptDiagnostic[];

  constructor(diagnostic: ScriptDiagnostic, diagnostics: readonly ScriptDiagnostic[]) {
    super(`${diagnostic.location.path}:${diagnostic.location.line}:${diagnostic.location.column}: ${diagnostic.message}`);
    this.name = "ScriptLanguageError";
    this.diagnostic = diagnostic;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isNameStart(character: string | undefined): boolean {
  return character !== undefined
    && ((character >= "a" && character <= "z")
      || (character >= "A" && character <= "Z")
      || character === "_");
}

function isNameCharacter(character: string | undefined): boolean {
  return isNameStart(character) || isDigit(character);
}

function isSourceNumberHexDigit(character: string | undefined): boolean {
  return character !== undefined
    && (isDigit(character)
      || (character >= "a" && character <= "f")
      || character === "A");
}

function isSourceEscapeHexDigit(character: string | undefined): boolean {
  return character !== undefined
    && (isDigit(character)
      || (character >= "a" && character <= "z")
      || (character >= "A" && character <= "Z"));
}

function hasFlag(flags: number, flag: LexerFlag | NumberFlag): boolean {
  return (flags & flag) !== 0;
}

function location(path: string, line: number, column: number): SourceLocation {
  return Object.freeze({ path, line, column });
}

export class ScriptLexer {
  private readonly source: string | SourceScriptStorage;
  private readonly diagnosticPath: string;
  private diagnosticFlags: number;
  private readonly maxTokenLength: number;
  private readonly report: ((diagnostic: ScriptDiagnostic) => void) | undefined;
  private readonly reported: ScriptDiagnostic[] = [];
  private readonly sourceFailures = new WeakSet<ScriptLanguageError>();
  private diagnosticOffset = 0;
  private diagnosticLine = 1;
  private diagnosticLastOffset = 0;
  private diagnosticLastLine = 1;
  private diagnosticWhitespaceStart = 0;
  private diagnosticWhitespaceEnd = 0;
  private column = 1;
  private diagnosticTokenAvailable = false;
  private readonly diagnosticTokenBytes = new Uint8Array(SOURCE_TOKEN_BYTES);
  private readonly diagnosticToken = new SourceTokenMemory(() => this.diagnosticTokenBytes);
  private readonly outputBytes = new Uint8Array(SOURCE_TOKEN_BYTES);
  private readonly output = new SourceTokenMemory(() => this.outputBytes);
  private tokenContext: SourceTokenContext;
  private punctuations = PUNCTUATIONS;
  private punctuationLookup = DEFAULT_PUNCTUATION_TABLE;

  constructor(source: string | SourceScriptStorage, path: string, options: ScriptLexerOptions = {}) {
    this.diagnosticPath = path;
    this.diagnosticFlags = options.flags ?? LexerFlag.None;
    this.maxTokenLength = options.maxTokenLength ?? DEFAULT_SCRIPT_TOKEN_LIMIT;
    this.report = options.report;
    this.tokenContext = { path, column: 1, leadingWhitespace: "" };
    if (!Number.isInteger(this.maxTokenLength) || this.maxTokenLength < 4) {
      throw new RangeError("maxTokenLength must be an integer of at least 4");
    }
    if (typeof source === "string" && options.memory !== undefined) {
      const stored = allocateScriptSource(source.length, path, options.memory);
      stored.copyText(source);
      this.source = stored;
    } else {
      this.source = source;
    }
    if (this.source instanceof SourceScriptStorage && options.flags !== undefined) this.source.flags = options.flags;
  }

  get diagnostics(): readonly ScriptDiagnostic[] {
    return Object.freeze([...this.reported]);
  }

  isSourceFailure(error: unknown): boolean { return error instanceof ScriptLanguageError && this.sourceFailures.has(error); }

  get currentLocation(): SourceLocation {
    return location(this.path, this.line, this.column);
  }

  get endOfScript(): boolean { return this.offset >= this.sourceLength; }

  next(): ScriptToken | undefined {
    return this.nextInto(this.output)?.token;
  }

  getScriptFlags(): number { return this.flags; }
  setScriptFlags(flags: number): void {
    if (this.source instanceof SourceScriptStorage) this.source.flags = flags;
    else this.diagnosticFlags = flags | 0;
  }

  punctuationFromNum(number: number): string {
    return this.punctuations.find(spec => spec.punctuation === number)?.text ?? "unkown punctuation";
  }

  setPunctuations(punctuations: readonly ScriptPunctuation[] | null): void {
    const values = punctuations ?? PUNCTUATIONS;
    const table = punctuationTable(values);
    if (this.source instanceof SourceScriptStorage) this.source.setDefaultPunctuations(table.heads);
    this.punctuations = values;
    this.punctuationLookup = table;
  }

  numLinesCrossed(): number {
    return this.source instanceof SourceScriptStorage ? this.source.linesCrossed : this.line - this.diagnosticLastLine;
  }

  nextWhitespaceChar(): number {
    if (this.source instanceof SourceScriptStorage) return this.source.nextWhitespaceChar();
    if (this.diagnosticWhitespaceStart === this.diagnosticWhitespaceEnd) return 0;
    const byte = this.source.charCodeAt(this.diagnosticWhitespaceStart++);
    if (!Number.isFinite(byte)) throw new RangeError("script whitespace pointer exceeds its source allocation");
    return byte < 128 ? byte : byte - 256;
  }

  private rewindCheckedToken(): void {
    this.offset = this.source instanceof SourceScriptStorage ? this.source.lastOffset : this.diagnosticLastOffset;
  }

  unreadLast(): void {
    if (this.source instanceof SourceScriptStorage) this.source.tokenAvailable = true;
    else this.diagnosticTokenAvailable = true;
  }

  expectTokenString(text: string): boolean {
    if (!this.readExpectedInto(this.output)) { this.error(`couldn't find expected ${text}`); return false; }
    if (this.output.string !== text) { this.error(`expected ${text}, found ${this.output.string}`); return false; }
    return true;
  }

  expectAnyToken(output: SourceTokenMemory): boolean {
    if (this.readExpectedInto(output)) return true;
    this.error("couldn't read expected token");
    return false;
  }

  expectTokenType(type: number, subtype: number, output: SourceTokenMemory): boolean {
    if (!this.expectAnyToken(output)) return false;
    if (output.type !== type) {
      const name = scriptTokenTypeName(type);
      if (name === "") throw new RangeError("PS_ExpectTokenType diagnostic reads an uninitialized source string");
      this.error(`expected a ${name}, found ${output.string}`);
      return false;
    }
    if (type === ScriptTokenType.Number && (output.subtype & subtype) !== subtype) {
      this.error(`expected ${scriptNumberSubtypeName(subtype)}, found ${output.string}`);
      return false;
    }
    if (type === ScriptTokenType.Punctuation) {
      if (subtype < 0) { this.error("BUG: wrong punctuation subtype"); return false; }
      if (output.subtype !== subtype) {
        throw new RangeError("PS_ExpectTokenType passes a punctuation struct to source %s");
      }
    }
    return true;
  }

  checkTokenString(text: string): boolean {
    if (!this.readExpectedInto(this.output)) return false;
    if (this.output.string === text) return true;
    this.rewindCheckedToken();
    return false;
  }

  checkTokenType(type: number, subtype: number, output: SourceTokenMemory): boolean {
    if (!this.readExpectedInto(this.output)) return false;
    if (this.output.type === type && (this.output.subtype & subtype) === subtype) {
      output.copyFrom(this.output);
      return true;
    }
    this.rewindCheckedToken();
    return false;
  }

  skipUntilString(text: string): boolean {
    while (this.readExpectedInto(this.output)) if (this.output.string === text) return true;
    return false;
  }

  scriptSkipTo(text: string): boolean {
    while (true) {
      this.readWhitespace();
      if (this.atEnd()) return false;
      if (this.sourceStartsWith(text)) return true;
      this.advance();
    }
  }

  readSignedFloat(): number {
    this.expectAnyToken(this.output);
    let sign = 1;
    if (this.output.string === "-") { sign = -1; this.expectTokenType(ScriptTokenType.Number, 0, this.output); }
    else if (this.output.type !== ScriptTokenType.Number) this.error(`expected float value, found ${this.output.string}\n`);
    return sign * this.output.floatValue;
  }

  readSignedInt(): number {
    this.expectAnyToken(this.output);
    let sign = 1;
    if (this.output.string === "-") { sign = -1; this.expectTokenType(ScriptTokenType.Number, NumberFlag.Integer, this.output); }
    else if (this.output.type !== ScriptTokenType.Number || this.output.subtype === NumberFlag.Float) {
      this.error(`expected integer value, found ${this.output.string}\n`);
    }
    return Math.imul(sign, this.output.integerValue);
  }

  /** Active PS_ReadLiteral helper. PS_ReadToken deliberately uses ReadString instead. */
  readLiteralInto(output: SourceTokenMemory): boolean {
    const byte = (): number => {
      if (this.offset === this.sourceLength) return 0;
      const character = this.peek();
      if (character === undefined) throw new RangeError("PS_ReadLiteral reads outside its source allocation");
      return character.charCodeAt(0);
    };
    const take = (): number => { const value = byte(); this.offset++; this.column++; return value; };
    try {
      output.type = ScriptTokenType.Literal;
      output.setStringByte(0, take());
      if (byte() === 0) { this.error("end of file before trailing '"); return false; }
      const value = byte() === 92 ? this.readEscape(this.currentLocation).charCodeAt(0) : take();
      output.setStringByte(1, value);
      if (byte() !== 39) {
        this.warn("too many characters in literal, ignored", this.currentLocation);
        while (byte() !== 0 && byte() !== 39 && byte() !== 10) take();
        if (byte() === 39) take();
      }
      output.setStringByte(2, take());
      output.setStringByte(3, 0);
      output.subtype = value < 128 ? value : value - 256;
      return true;
    } catch (error) {
      if (this.isSourceFailure(error)) return false;
      throw error;
    }
  }

  private readExpectedInto(output: SourceTokenMemory): boolean {
    try { return this.nextInto(output) !== undefined; }
    catch (error) {
      if (error instanceof ScriptLanguageError && this.sourceFailures.has(error)) return false;
      throw error;
    }
  }

  private error(message: string): void {
    if ((this.flags & LexerFlag.NoErrors) !== 0) return;
    const diagnostic: ScriptDiagnostic = { severity: "error", message, location: this.currentLocation };
    this.reported.push(diagnostic);
    this.report?.(diagnostic);
  }

  /** PS_ReadToken writes the caller's token_t even when it returns false. */
  nextInto(output: SourceTokenMemory): ScriptTokenRecord | undefined {
    if (this.tokenAvailable) {
      if (this.source instanceof SourceScriptStorage) this.source.tokenAvailable = false;
      else this.diagnosticTokenAvailable = false;
      output.copyFrom(this.retainedToken);
      return output.readRecord(this.tokenContext);
    }

    if (this.source instanceof SourceScriptStorage) this.source.beginToken();
    else {
      this.diagnosticLastOffset = this.offset;
      this.diagnosticLastLine = this.line;
      this.diagnosticWhitespaceStart = this.offset;
    }
    output.clear();
    output.whitespaceStart = this.sourcePointer;
    const whitespaceStart = this.offset;
    const lineBeforeWhitespace = this.line;
    this.readWhitespace();
    if (this.atEnd()) {
      return undefined;
    }

    if (this.source instanceof SourceScriptStorage) this.source.endWhitespace();
    else this.diagnosticWhitespaceEnd = this.offset;
    output.whitespaceEnd = this.sourcePointer;
    output.line = this.line;
    output.linesCrossed = this.line - lineBeforeWhitespace;
    const leadingWhitespace = this.sourceSlice(whitespaceStart, this.offset);
    const linesCrossed = this.line - lineBeforeWhitespace;
    const tokenLocation = location(this.path, this.line, this.column);
    const character = this.peek();
    let token: ScriptToken;

    if (character === '"' || character === "'") {
      token = this.readQuoted(character, tokenLocation, leadingWhitespace, linesCrossed, output);
    } else if (isDigit(character) || (character === "." && isDigit(this.peek(1)))) {
      token = this.readNumber(tokenLocation, leadingWhitespace, linesCrossed, output);
    } else if ((this.flags & LexerFlag.Primitive) !== 0) {
      let length = 0;
      while (true) {
        const character = this.peek();
        if (character === undefined || character.charCodeAt(0) >= 128 || character <= " " || character === ";") break;
        if (length >= this.maxTokenLength) this.fail(`primitive token longer than MAX_TOKEN = ${this.maxTokenLength}`, this.currentLocation);
        output.setStringByte(length++, character.charCodeAt(0));
        this.advance();
      }
      output.setStringByte(length, 0);
      token = { kind: "primitive", text: output.string, value: output.string, location: tokenLocation, leadingWhitespace, linesCrossed };
    } else if (isNameStart(character)) {
      token = this.readName(tokenLocation, leadingWhitespace, linesCrossed, output);
    } else {
      const spec = this.readPunctuation();
      if (spec === undefined) this.fail("can't read token", this.currentLocation);
      output.writeString(spec.text);
      this.advance(spec.text.length);
      output.type = 5;
      output.subtype = spec.punctuation;
      token = Object.freeze({
        kind: "punctuation",
        text: spec.text,
        value: spec.text,
        punctuation: spec.punctuation,
        location: tokenLocation,
        leadingWhitespace,
        linesCrossed,
      } satisfies PunctuationToken);
    }

    const context = { path: this.path, column: tokenLocation.column, leadingWhitespace };
    const record = output.readRecord(context, token.text.length);
    if (token.kind === "primitive") return record;
    this.retainedToken.copyFrom(output);
    this.tokenContext = context;
    return record;
  }

  unread(token: ScriptToken): void {
    this.retainedToken.writeToken(token);
    this.tokenContext = { path: token.location.path, column: token.location.column, leadingWhitespace: token.leadingWhitespace };
    if (this.source instanceof SourceScriptStorage) this.source.tokenAvailable = true;
    else this.diagnosticTokenAvailable = true;
  }

  reset(): void {
    if (this.source instanceof SourceScriptStorage) this.source.reset();
    else {
      this.offset = 0;
      this.line = 1;
      this.diagnosticLastOffset = 0;
      this.diagnosticLastLine = 1;
      this.diagnosticWhitespaceStart = 0;
      this.diagnosticWhitespaceEnd = 0;
    }
    this.column = 1;
    this.diagnosticTokenAvailable = false;
    this.diagnosticToken.clear();
    this.reported.splice(0);
  }

  dispose(): void {
    if (this.source instanceof SourceScriptStorage) this.source.dispose();
  }

  private readPunctuation(): PunctuationSpec | undefined {
    const character = this.peek();
    if (character === undefined) return undefined;
    const head = typeof this.source === "string" ? this.punctuationLookup.heads[character.charCodeAt(0)] : this.source.punctuationHead(character.charCodeAt(0));
    if (head === undefined) return undefined;
    for (let pointer = head; pointer !== 0;) {
      const link = this.punctuationLookup.links[pointer - 1];
      if (link === undefined) throw new RangeError("script punctuation head does not identify a default record");
      if (this.sourceStartsWith(link.spec.text)) return link.spec;
      pointer = link.next;
    }
    return undefined;
  }

  private readWhitespace(): void {
    while (!this.atEnd()) {
      const character = this.peek();
      const code = character?.charCodeAt(0);
      if (code !== undefined && (code <= 32 || (code >= 128 && code <= 255))) {
        this.advance();
        continue;
      }
      if (this.sourceStartsWith("//")) {
        this.advance(2);
        while (!this.atEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }
      if (this.sourceStartsWith("/*")) {
        this.advance(2);
        while (!this.atEnd() && !this.sourceStartsWith("*/")) {
          this.advance();
        }
        if (this.sourceStartsWith("*/")) {
          this.advance(2);
        }
        continue;
      }
      return;
    }
  }

  private readQuoted(
    quote: string,
    tokenLocation: SourceLocation,
    leadingWhitespace: string,
    linesCrossed: number,
    output: SourceTokenMemory,
  ): StringToken | LiteralToken {
    let value = "";
    output.type = quote === '"' ? 1 : 2;
    output.setStringByte(0, quote.charCodeAt(0));
    this.advance();

    while (true) {
      if (value.length + 1 >= this.maxTokenLength - 2) {
        this.fail(`string longer than MAX_TOKEN = ${this.maxTokenLength}`, this.currentLocation);
      }
      const character = this.peek();
      if (character === undefined || character === "\0") {
        output.setStringByte(value.length + 1, 0);
        this.fail("missing trailing quote", this.currentLocation);
      }
      if (character === "\n") {
        output.setStringByte(value.length + 1, 0);
        const nul = value.indexOf("\0");
        this.fail(`newline inside string ${quote}${nul < 0 ? value : value.slice(0, nul)}`, this.currentLocation);
      }
      if (character === "\\" && !hasFlag(this.flags, LexerFlag.NoStringEscapes)) {
        const escaped = this.readEscape(tokenLocation);
        output.setStringByte(value.length + 1, escaped.charCodeAt(0));
        value += escaped;
        continue;
      }
      if (character === quote) {
        this.advance();
        if (hasFlag(this.flags, LexerFlag.NoStringConcatenation)) {
          break;
        }
        const savedOffset = this.offset;
        const savedLine = this.line;
        const savedColumn = this.column;
        this.readWhitespace();
        if (this.peek() === quote) {
          this.advance();
          continue;
        }
        this.offset = savedOffset;
        this.line = savedLine;
        this.column = savedColumn;
        break;
      }
      output.setStringByte(value.length + 1, character.charCodeAt(0));
      value += character;
      this.advance();
    }

    const text = `${quote}${value}${quote}`;
    output.setStringByte(value.length + 1, quote.charCodeAt(0));
    output.setStringByte(value.length + 2, 0);
    output.subtype = text.length;
    if (quote === '"') {
      return Object.freeze({
        kind: "string",
        text,
        value,
        length: text.length,
        location: tokenLocation,
        leadingWhitespace,
        linesCrossed,
      } satisfies StringToken);
    }
    return Object.freeze({
      kind: "literal",
      text,
      value,
      length: text.length,
      location: tokenLocation,
      leadingWhitespace,
      linesCrossed,
    } satisfies LiteralToken);
  }

  private readEscape(tokenLocation: SourceLocation): string {
    this.advance();
    const character = this.peek();
    if (character === undefined) {
      this.error("unknown escape char");
      return "\0";
    }
    const escapes = new Map<string, string>([
      ["\\", "\\"],
      ["n", "\n"],
      ["r", "\r"],
      ["t", "\t"],
      ["v", "\v"],
      ["b", "\b"],
      ["f", "\f"],
      ["a", "\x07"],
      ["'", "'"],
      ['"', '"'],
      ["?", "?"],
    ]);
    const escaped = escapes.get(character);
    if (escaped !== undefined) {
      this.advance();
      return escaped;
    }
    if (character === "x") {
      this.advance();
      const start = this.offset;
      while (isSourceEscapeHexDigit(this.peek())) {
        this.advance();
      }
      return String.fromCharCode(this.sourceEscapeHexValue(this.sourceSlice(start, this.offset), tokenLocation));
    }
    if (isDigit(character)) {
      const start = this.offset;
      while (isDigit(this.peek())) {
        this.advance();
      }
      return String.fromCharCode(this.decimalEscapeValue(this.sourceSlice(start, this.offset), tokenLocation));
    }
    this.error("unknown escape char");
    return "\0";
  }

  private decimalEscapeValue(text: string, tokenLocation: SourceLocation): number {
    let value = 0;
    for (const character of text) {
      value = value * 10 + character.charCodeAt(0) - 48;
      if (value > 2147483647) throw new RangeError("decimal escape exceeds the source signed-int range");
    }
    return this.finishEscapeValue(value, tokenLocation);
  }

  private sourceEscapeHexValue(text: string, tokenLocation: SourceLocation): number {
    let value = 0;
    for (const character of text) {
      let digit: number;
      if (character >= "0" && character <= "9") {
        digit = character.charCodeAt(0) - "0".charCodeAt(0);
      } else if (character >= "A" && character <= "Z") {
        digit = character.charCodeAt(0) - "A".charCodeAt(0) + 10;
      } else {
        digit = character.charCodeAt(0) - "a".charCodeAt(0) + 10;
      }
      value = value * 16 + digit;
      if (value > 2147483647) throw new RangeError("hex escape exceeds the source signed-int range");
    }
    return this.finishEscapeValue(value, tokenLocation);
  }

  private finishEscapeValue(value: number, tokenLocation: SourceLocation): number {
    if (value > 255) {
      this.offset--;
      this.column--;
      this.warn("too large value in escape character", tokenLocation);
      this.offset++;
      this.column++;
      return 255;
    }
    return value;
  }

  private readName(
    tokenLocation: SourceLocation,
    leadingWhitespace: string,
    linesCrossed: number,
    output: SourceTokenMemory,
  ): NameToken {
    const start = this.offset;
    output.type = 4;
    while (isNameCharacter(this.peek())) {
      const character = this.peek();
      if (character === undefined) throw new Error("source name character is missing");
      output.setStringByte(this.offset - start, character.charCodeAt(0));
      this.advance();
      if (this.offset - start >= this.maxTokenLength) {
        this.fail(`name longer than MAX_TOKEN = ${this.maxTokenLength}`, this.currentLocation);
      }
    }
    const value = this.sourceSlice(start, this.offset);
    output.setStringByte(value.length, 0);
    output.subtype = value.length;
    return Object.freeze({
      kind: "name",
      text: value,
      value,
      length: value.length,
      location: tokenLocation,
      leadingWhitespace,
      linesCrossed,
    } satisfies NameToken);
  }

  private readNumber(
    tokenLocation: SourceLocation,
    leadingWhitespace: string,
    linesCrossed: number,
    output: SourceTokenMemory,
  ): NumberToken {
    const start = this.offset;
    let flags = 0;
    output.type = 3;
    const append = (): void => {
      const character = this.peek();
      if (character === undefined) throw new Error("source number character is missing");
      output.setStringByte(this.offset - start, character.charCodeAt(0));
      this.advance();
    };

    if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
      append();
      append();
      while (isSourceNumberHexDigit(this.peek())) {
        append();
        this.ensureTokenLength(start, "hexadecimal number");
      }
      flags |= NumberFlag.Hex;
      output.subtype = flags;
    } else if (
      this.peek() === "0"
      && (this.peek(1) === "b" || this.peek(1) === "B")
      && !hasFlag(this.flags, LexerFlag.NoBinaryNumbers)
    ) {
      append();
      append();
      while (this.peek() === "0" || this.peek() === "1") {
        append();
        this.ensureTokenLength(start, "binary number");
      }
      flags |= NumberFlag.Binary;
      output.subtype = flags;
    } else {
      let octal = this.peek() === "0";
      let dots = 0;
      while (true) {
        const character = this.peek();
        if (character === ".") {
          dots++;
        } else if (character === "8" || character === "9") {
          octal = false;
        } else if (!isDigit(character)) {
          break;
        }
        append();
        this.ensureTokenLength(start, "number", 1);
      }
      flags |= octal ? NumberFlag.Octal : NumberFlag.Decimal;
      if (dots > 0) {
        flags |= NumberFlag.Float;
      }
      output.subtype = flags;
    }

    const textEnd = this.offset;
    for (let suffix = 0; suffix < 2; suffix++) {
      const character = this.peek();
      if ((character === "l" || character === "L") && !hasFlag(flags, NumberFlag.Long)) {
        flags |= NumberFlag.Long;
        this.advance();
        output.subtype = flags;
      } else if (
        (character === "u" || character === "U")
        && !hasFlag(flags, NumberFlag.Unsigned)
        && !hasFlag(flags, NumberFlag.Float)
      ) {
        flags |= NumberFlag.Unsigned;
        this.advance();
        output.subtype = flags;
      }
    }
    if (!hasFlag(flags, NumberFlag.Float)) {
      flags |= NumberFlag.Integer;
    }

    const text = this.sourceSlice(start, textEnd);
    output.setStringByte(text.length, 0);
    const values = this.numberValues(text, flags);
    output.integerValue = values.integerValue;
    output.floatValue = values.floatValue;
    output.subtype = flags;
    return Object.freeze({
      kind: "number",
      text,
      flags,
      integerValue: values.integerValue,
      floatValue: values.floatValue,
      location: tokenLocation,
      leadingWhitespace,
      linesCrossed,
    } satisfies NumberToken);
  }

  private numberValues(text: string, flags: number): { readonly integerValue: number; readonly floatValue: number } {
    let value = 0;
    if (hasFlag(flags, NumberFlag.Float)) {
      let divisor = 0;
      let index = 0;
      while (index < text.length) {
        if (text[index] === ".") {
          if (divisor !== 0) return Object.freeze({ integerValue: 0, floatValue: value });
          divisor = 10;
          index++;
        }
        // A trailing dot consumes the NUL in PS_ReadToken's cleared token buffer.
        const digit = (index < text.length ? text.charCodeAt(index) : 0) - 48;
        if (divisor !== 0) {
          value += digit / divisor;
          divisor = (divisor * 10) >>> 0;
        } else {
          value = value * 10 + digit;
        }
        index++;
      }
      const integerValue = Math.trunc(value);
      if (!Number.isFinite(integerValue) || integerValue < 0 || integerValue > 0xffffffff) {
        throw new RangeError("NumberValue floating conversion exceeds the source unsigned-long range");
      }
      return Object.freeze({ integerValue: integerValue >>> 0, floatValue: value });
    }
    let radix = 10;
    let index = 0;
    if (hasFlag(flags, NumberFlag.Hex)) {
      radix = 16;
      index = 2;
    } else if (hasFlag(flags, NumberFlag.Octal)) {
      radix = 8;
      index = 1;
    } else if (hasFlag(flags, NumberFlag.Binary)) {
      radix = 2;
      index = 2;
    }
    for (; index < text.length; index++) {
      const code = text.charCodeAt(index);
      const digit = code >= 97 && code <= 102 ? code - 87 : code >= 65 && code <= 70 ? code - 55 : code - 48;
      value = (value * radix + digit) >>> 0;
    }
    return Object.freeze({ integerValue: value, floatValue: value });
  }

  private ensureTokenLength(start: number, label: string, reserved = 0): void {
    if (this.offset - start >= this.maxTokenLength - reserved) {
      this.fail(`${label} longer than MAX_TOKEN = ${this.maxTokenLength}`, this.currentLocation);
    }
  }

  private warn(message: string, _tokenLocation: SourceLocation): void {
    if ((this.flags & LexerFlag.NoWarnings) !== 0) return;
    const diagnostic: ScriptDiagnostic = Object.freeze({ severity: "warning", message, location: this.currentLocation });
    this.reported.push(diagnostic);
    this.report?.(diagnostic);
  }

  private fail(message: string, _tokenLocation: SourceLocation): never {
    const diagnostic: ScriptDiagnostic = Object.freeze({ severity: "error", message, location: this.currentLocation });
    if ((this.flags & LexerFlag.NoErrors) === 0) {
      this.reported.push(diagnostic);
      this.report?.(diagnostic);
    }
    const failure = new ScriptLanguageError(diagnostic, this.reported);
    this.sourceFailures.add(failure);
    throw failure;
  }

  private atEnd(): boolean {
    return this.offset >= this.sourceLength || this.peek() === "\0";
  }

  private peek(ahead = 0): string | undefined {
    const offset = this.offset + ahead;
    if (typeof this.source === "string") return this.source[offset];
    const byte = this.source.buffer[offset];
    return byte === undefined ? undefined : String.fromCharCode(byte);
  }

  private advance(count = 1): void {
    for (let moved = 0; moved < count && this.offset < this.sourceLength; moved++) {
      const character = this.peek();
      this.offset++;
      if (character === "\n") {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
    }
  }

  private get path(): string {
    return typeof this.source === "string" ? this.diagnosticPath : this.source.path;
  }

  private get flags(): number {
    return typeof this.source === "string" ? this.diagnosticFlags : this.source.flags;
  }

  private get offset(): number {
    return typeof this.source === "string" ? this.diagnosticOffset : this.source.offset;
  }

  private set offset(value: number) {
    if (typeof this.source === "string") this.diagnosticOffset = value;
    else this.source.offset = value;
  }

  private get line(): number {
    return typeof this.source === "string" ? this.diagnosticLine : this.source.line;
  }

  private set line(value: number) {
    if (typeof this.source === "string") this.diagnosticLine = value;
    else this.source.line = value;
  }

  private get tokenAvailable(): boolean {
    return typeof this.source === "string" ? this.diagnosticTokenAvailable : this.source.tokenAvailable;
  }

  private get retainedToken(): SourceTokenMemory {
    return typeof this.source === "string" ? this.diagnosticToken : this.source.token;
  }

  private get sourcePointer(): number {
    return SOURCE_SCRIPT_BYTES + this.offset;
  }

  private get sourceLength(): number {
    return typeof this.source === "string" ? this.source.length : this.source.buffer.length;
  }

  private sourceStartsWith(text: string): boolean {
    if (typeof this.source === "string") return this.source.startsWith(text, this.offset);
    const bytes = this.source.buffer;
    const start = this.offset;
    if (start + text.length > bytes.length) return false;
    for (let index = 0; index < text.length; index++) {
      if (bytes[start + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  }

  private sourceSlice(start: number, end: number): string {
    if (typeof this.source === "string") return this.source.slice(start, end);
    const bytes = this.source.buffer;
    let text = "";
    for (let index = start; index < end; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("script token text is outside its allocation");
      text += String.fromCharCode(byte);
    }
    return text;
  }
}
