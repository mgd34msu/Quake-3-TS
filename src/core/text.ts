/*
 * Text parsing translated from Quake III Arena's q_shared.c and cmd.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */

export const INFO_STRING_MAX = 1024;
export const BIG_INFO_STRING_MAX = 8192;
export const TOKEN_MAX = 1024;
export const COMMAND_TOKEN_MAX = 1024;

export interface Token {
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly quoted: boolean;
}

export class TextParseError extends Error {
  readonly sourceName: string;
  readonly line: number;
  readonly column: number;

  constructor(sourceName: string, line: number, column: number, message: string) {
    super(`${sourceName}:${line}:${column}: ${message}`);
    this.name = "TextParseError";
    this.sourceName = sourceName;
    this.line = line;
    this.column = column;
  }
}

function isWhitespace(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 32;
}

export class Tokenizer {
  private readonly source: string;
  private readonly sourceName: string;
  private offset = 0;
  private currentLine = 1;
  private currentColumn = 1;

  constructor(source: string, name = "<text>") {
    this.source = source;
    this.sourceName = name;
  }

  get name(): string {
    return this.sourceName;
  }

  get line(): number {
    return this.currentLine;
  }

  get column(): number {
    return this.currentColumn;
  }

  next(allowLineBreaks = true): Token | undefined {
    let crossedLine = false;

    while (true) {
      while (this.offset < this.source.length) {
        const character = this.source[this.offset];
        if (character === undefined || !isWhitespace(character)) {
          break;
        }
        if (character === "\n" || character === "\r") {
          crossedLine = true;
        }
        this.advance();
      }

      if (this.source.startsWith("//", this.offset)) {
        this.advance();
        this.advance();
        while (this.offset < this.source.length) {
          const character = this.source[this.offset];
          if (character === "\n" || character === "\r") {
            break;
          }
          this.advance();
        }
        continue;
      }

      if (this.source.startsWith("/*", this.offset)) {
        this.advance();
        this.advance();
        while (this.offset < this.source.length && !this.source.startsWith("*/", this.offset)) {
          const character = this.source[this.offset];
          if (character === "\n" || character === "\r") {
            crossedLine = true;
          }
          this.advance();
        }
        if (this.source.startsWith("*/", this.offset)) {
          this.advance();
          this.advance();
        }
        continue;
      }

      break;
    }

    if (!allowLineBreaks && crossedLine) {
      return undefined;
    }
    if (this.offset >= this.source.length) {
      return undefined;
    }

    const line = this.currentLine;
    const column = this.currentColumn;
    const quoted = this.source[this.offset] === '"';
    let value = "";

    if (quoted) {
      this.advance();
      while (this.offset < this.source.length) {
        const character = this.source[this.offset];
        if (character === undefined || character === '"') {
          break;
        }
        value += character;
        this.advance();
      }
      if (this.source[this.offset] === '"') {
        this.advance();
      }
    } else {
      while (this.offset < this.source.length) {
        const character = this.source[this.offset];
        if (character === undefined || isWhitespace(character)) {
          break;
        }
        value += character;
        this.advance();
      }
    }

    if (value.length >= TOKEN_MAX) {
      throw new TextParseError(this.sourceName, line, column, `token is limited to ${TOKEN_MAX - 1} characters`);
    }

    return Object.freeze({ value, line, column, quoted });
  }

  private advance(): void {
    const character = this.source[this.offset];
    if (character === undefined) {
      return;
    }
    if (character === "\r") {
      this.offset++;
      if (this.source[this.offset] === "\n") {
        this.offset++;
      }
      this.currentLine++;
      this.currentColumn = 1;
      return;
    }
    this.offset++;
    if (character === "\n") {
      this.currentLine++;
      this.currentColumn = 1;
    } else {
      this.currentColumn++;
    }
  }
}

function parseError(tokenizer: Tokenizer, message: string, token?: Token): TextParseError {
  if (token === undefined) {
    return new TextParseError(tokenizer.name, tokenizer.line, tokenizer.column, message);
  }
  return new TextParseError(tokenizer.name, token.line, token.column, message);
}

export function parseEntities(text: string, name = "<entities>"): readonly ReadonlyMap<string, string>[] {
  const tokenizer = new Tokenizer(text, name);
  const entities: ReadonlyMap<string, string>[] = [];

  while (true) {
    const opening = tokenizer.next();
    if (opening === undefined) {
      return Object.freeze(entities);
    }
    if (opening.value !== "{") {
      throw parseError(tokenizer, 'expected "{"', opening);
    }

    const entity = new Map<string, string>();
    while (true) {
      const key = tokenizer.next();
      if (key === undefined) {
        throw parseError(tokenizer, 'expected key or "}"');
      }
      if (key.value === "}") {
        entities.push(entity);
        break;
      }
      const value = tokenizer.next(false);
      if (value === undefined) {
        throw parseError(tokenizer, `missing value for entity key "${key.value}"`);
      }
      if (value.value === "}") {
        throw parseError(tokenizer, `missing value for entity key "${key.value}"`, value);
      }
      entity.set(key.value, value.value);
    }
  }
}

/** Native engine commands are NUL-terminated byte strings, not Unicode text. */
export function sourceCommandText(input: string): string {
  const nul = input.indexOf("\0"), text = nul < 0 ? input : input.slice(0, nul);
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("Command text requires source bytes");
  }
  return text;
}

function commandWhitespace(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 32 || code >= 128;
}

export function tokenizeCommand(input: string): string[] {
  const text = sourceCommandText(input);
  const tokens: string[] = [];
  let offset = 0;

  while (offset < text.length && tokens.length < COMMAND_TOKEN_MAX) {
    while (offset < text.length) {
      const character = text[offset];
      if (character === undefined || !commandWhitespace(character)) {
        break;
      }
      offset++;
    }
    if (offset >= text.length || text.startsWith("//", offset)) {
      break;
    }
    if (text.startsWith("/*", offset)) {
      offset += 2;
      while (offset < text.length && !text.startsWith("*/", offset)) {
        offset++;
      }
      if (text.startsWith("*/", offset)) {
        offset += 2;
      }
      continue;
    }

    if (text[offset] === '"') {
      offset++;
      let value = "";
      while (offset < text.length && text[offset] !== '"') {
        const character = text[offset];
        if (character !== undefined) {
          value += character;
        }
        offset++;
      }
      if (text[offset] === '"') {
        offset++;
      }
      tokens.push(value);
      continue;
    }

    let value = "";
    while (offset < text.length) {
      const character = text[offset];
      if (
        character === undefined
        || commandWhitespace(character)
        || character === '"'
        || text.startsWith("//", offset)
        || text.startsWith("/*", offset)
      ) {
        break;
      }
      value += character;
      offset++;
    }
    tokens.push(value);
  }

  return tokens;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function ensureInfoLength(info: string, maximumLength: number): void {
  if (!Number.isInteger(maximumLength) || maximumLength < 1) {
    throw new RangeError("info string maximum length must be a positive integer");
  }
  if (utf8Length(info) >= maximumLength) {
    throw new RangeError(`info string is limited to ${maximumLength - 1} bytes`);
  }
}

function ensureInfoComponent(label: string, value: string): void {
  if (value.includes("\\") || value.includes(";") || value.includes('"')) {
    throw new TypeError(`${label} contains a forbidden info-string character`);
  }
}

export function infoValidate(info: string, maximumLength = INFO_STRING_MAX): boolean {
  if (!Number.isInteger(maximumLength) || maximumLength < 1) {
    return false;
  }
  return utf8Length(info) < maximumLength && !info.includes('"') && !info.includes(";");
}

export function infoParse(info: string, maximumLength = INFO_STRING_MAX): ReadonlyMap<string, string> {
  ensureInfoLength(info, maximumLength);
  const pairs = new Map<string, string>();
  let offset = info.startsWith("\\") ? 1 : 0;

  while (offset < info.length) {
    const keyStart = offset;
    while (offset < info.length && info[offset] !== "\\") {
      offset++;
    }
    if (offset >= info.length) {
      throw new TextParseError("<info>", 1, keyStart + 1, "info key has no value");
    }
    const key = info.slice(keyStart, offset);
    offset++;
    const valueStart = offset;
    while (offset < info.length && info[offset] !== "\\") {
      offset++;
    }
    pairs.set(key, info.slice(valueStart, offset));
    if (offset < info.length) {
      offset++;
    }
  }

  return pairs;
}

export function infoRemove(info: string, key: string, maximumLength = INFO_STRING_MAX): string {
  ensureInfoLength(info, maximumLength);
  if (key.includes("\\")) {
    return info;
  }

  let offset = info.startsWith("\\") ? 1 : 0;
  while (offset < info.length) {
    const pairStart = offset === 0 ? 0 : offset - 1;
    const keyStart = offset;
    while (offset < info.length && info[offset] !== "\\") {
      offset++;
    }
    if (offset >= info.length) {
      return info;
    }
    const currentKey = info.slice(keyStart, offset);
    offset++;
    while (offset < info.length && info[offset] !== "\\") {
      offset++;
    }
    if (currentKey === key) {
      return info.slice(0, pairStart) + info.slice(offset);
    }
    if (offset < info.length) {
      offset++;
    }
  }
  return info;
}

export function infoSet(
  info: string,
  key: string,
  value: string,
  maximumLength = INFO_STRING_MAX,
): string {
  ensureInfoLength(info, maximumLength);
  ensureInfoComponent("info key", key);
  ensureInfoComponent("info value", value);
  const removed = infoRemove(info, key, maximumLength);
  if (value.length === 0) {
    return removed;
  }
  const result = `\\${key}\\${value}${removed}`;
  ensureInfoLength(result, maximumLength);
  return result;
}
