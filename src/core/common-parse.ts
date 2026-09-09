/*
 * COM_Parse, COM_ParseExt, COM_Compress, SkipWhitespace and SkipRestOfLine from game/q_shared.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 * Uses the source Linux/QVM signed-char byte profile.
 */

import { CommonError } from "./common-error.ts";
import { nativeAtof } from "./native-numeric.ts";

const MAX_TOKEN_CHARS = 1024;

export class CommonParseCursor {
  readonly source: string;
  private readonly terminator: number;
  private currentOffset: number | null = 0;

  constructor(source: string, readonly end: "terminated" | "uninitialized" = "terminated") {
    for (let index = 0; index < source.length; index++) {
      if (source.charCodeAt(index) > 255) {
        throw new RangeError(`COM_Parse source is not a Latin-1 byte string at ${index}`);
      }
    }
    this.source = source;
    const nul = source.indexOf("\0");
    this.terminator = nul === -1 ? source.length : nul;
  }

  get offset(): number | null {
    return this.currentOffset;
  }

  set offset(value: number | null) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > this.terminator)) {
      throw new RangeError("COM_Parse cursor is outside its C byte string");
    }
    this.currentOffset = value;
  }
}

function signedByte(cursor: CommonParseCursor, offset: number): number {
  const source = cursor.source;
  if (offset === source.length) {
    if (cursor.end === "uninitialized") throw new RangeError("COM_Parse reached an uninitialized short-read tail");
    return 0;
  }
  const byte = source.charCodeAt(offset);
  return byte >= 128 ? byte - 256 : byte;
}

/** COM_Compress preserves quoted bytes and coalesces pending whitespace before the next token. */
export function compressCommonText(source: string, end: CommonParseCursor["end"] = "terminated"): string {
  const cursor = new CommonParseCursor(source, end);
  let offset = 0, output = "", newline = false, whitespace = false;
  let byte: number;
  while ((byte = signedByte(cursor, offset)) !== 0) {
    if (byte === 47 && signedByte(cursor, offset + 1) === 47) {
      while ((byte = signedByte(cursor, offset)) !== 0 && byte !== 10) offset++;
    } else if (byte === 47 && signedByte(cursor, offset + 1) === 42) {
      while (signedByte(cursor, offset) !== 0
        && (signedByte(cursor, offset) !== 42 || signedByte(cursor, offset + 1) !== 47)) offset++;
      if (signedByte(cursor, offset) !== 0) offset += 2;
    } else if (byte === 10 || byte === 13) {
      newline = true;
      offset++;
    } else if (byte === 32 || byte === 9) {
      whitespace = true;
      offset++;
    } else {
      if (newline) { output += "\n"; newline = false; whitespace = false; }
      if (whitespace) { output += " "; whitespace = false; }
      output += source.charAt(offset++);
      if (byte === 34) {
        while ((byte = signedByte(cursor, offset)) !== 0 && byte !== 34) output += source.charAt(offset++);
        if (byte === 34) output += source.charAt(offset++);
      }
    }
  }
  return output;
}

export class CommonParseState {
  private currentToken = "";
  private currentLine = 0;
  private currentName = "";

  /** COM_BeginParseSession does not clear the shared token. */
  beginSession(name: string, print: (text: string) => undefined): void {
    this.currentLine = 0;
    const cursor = new CommonParseCursor(name);
    const nul = cursor.source.indexOf("\0");
    const text = nul < 0 ? cursor.source : cursor.source.slice(0, nul);
    if (text.length >= 32000) throw new CommonError("fatal", "Com_sprintf: overflowed bigbuffer");
    if (text.length >= MAX_TOKEN_CHARS) print(`Com_sprintf: overflow of ${text.length} in ${MAX_TOKEN_CHARS}\n`);
    this.currentName = text.slice(0, MAX_TOKEN_CHARS - 1);
  }

  parseError(message: string, print: (text: string) => undefined): void {
    this.diagnostic("ERROR", message, print);
  }

  parseWarning(message: string, print: (text: string) => undefined): void {
    this.diagnostic("WARNING", message, print);
  }

  private diagnostic(kind: "ERROR" | "WARNING", message: string, print: (text: string) => undefined): void {
    const nul = message.indexOf("\0");
    print(`${kind}: ${this.currentName}, line ${this.currentLine}: ${nul < 0 ? message : message.slice(0, nul)}\n`);
  }

  matchToken(cursor: CommonParseCursor, match: string): void {
    const token = this.parse(cursor);
    const nul = match.indexOf("\0"), expected = nul < 0 ? match : match.slice(0, nul);
    if (token !== expected) throw new CommonError("drop", `MatchToken: ${token} != ${expected}`);
  }

  skipBracedSection(cursor: CommonParseCursor): void {
    let depth = 0;
    do {
      const token = this.parse(cursor);
      if (token === "{") depth++;
      else if (token === "}") depth--;
    } while (depth !== 0 && cursor.offset !== null);
  }

  /** Parse1DMatrix uses the engine's native atof and writes each reached cell. */
  parse1DMatrix(cursor: CommonParseCursor, x: number, matrix: Float32Array, offset = 0): void {
    this.matchToken(cursor, "(");
    for (let index = 0; index < x; index++) {
      const token = this.parse(cursor);
      const target = offset + index;
      if (!Number.isInteger(target) || target < 0 || target >= matrix.length) {
        throw new RangeError("Parse1DMatrix write exceeds its destination");
      }
      matrix[target] = nativeAtof(token);
    }
    this.matchToken(cursor, ")");
  }

  parse2DMatrix(cursor: CommonParseCursor, y: number, x: number, matrix: Float32Array, offset = 0): void {
    this.matchToken(cursor, "(");
    for (let index = 0; index < y; index++) this.parse1DMatrix(cursor, x, matrix, offset + index * x);
    this.matchToken(cursor, ")");
  }

  parse3DMatrix(cursor: CommonParseCursor, z: number, y: number, x: number, matrix: Float32Array, offset = 0): void {
    this.matchToken(cursor, "(");
    for (let index = 0; index < z; index++) this.parse2DMatrix(cursor, y, x, matrix, offset + index * x * y);
    this.matchToken(cursor, ")");
  }

  get token(): string {
    return this.currentToken;
  }

  /** Callers can write through COM_Parse's shared char pointer without advancing parsing. */
  overwriteToken(text: string): void {
    const nul = text.indexOf("\0"), value = nul < 0 ? text : text.slice(0, nul);
    if (value.length >= MAX_TOKEN_CHARS) throw new RangeError("COM_Parse token write exceeds its source buffer");
    for (let index = 0; index < value.length; index++) {
      if (value.charCodeAt(index) > 255) throw new RangeError("COM_Parse token write requires source bytes");
    }
    this.currentToken = value;
  }

  get line(): number {
    return this.currentLine;
  }

  /** SkipRestOfLine leaves the token untouched and consumes raw bytes through LF. */
  skipRestOfLine(cursor: CommonParseCursor): void {
    let data = cursor.offset;
    if (data === null) throw new RangeError("SkipRestOfLine requires a live source cursor");
    for (;;) {
      const byte = signedByte(cursor, data++);
      if (byte === 0) {
        // C advances past NUL; retain the parser's managed exhaustion convention.
        cursor.offset = null;
        return;
      }
      if (byte === 10) {
        this.currentLine = (this.currentLine + 1) | 0;
        cursor.offset = data;
        return;
      }
    }
  }

  parse(cursor: CommonParseCursor, allowLineBreaks = true): string {
    let data = cursor.offset;
    this.currentToken = "";
    if (data === null) return this.currentToken;

    const source = cursor.source;
    let hasNewLines = false;
    let c: number;
    while (true) {
      // SkipWhitespace counts LF, including the lookahead LF left by a word.
      while ((c = signedByte(cursor, data)) <= 32) {
        if (c === 0) {
          cursor.offset = null;
          return this.currentToken;
        }
        if (c === 10) {
          this.currentLine = (this.currentLine + 1) | 0;
          hasNewLines = true;
        }
        data++;
      }
      if (hasNewLines && !allowLineBreaks) {
        cursor.offset = data;
        return this.currentToken;
      }

      if (c === 47 && signedByte(cursor, data + 1) === 47) {
        data += 2;
        while ((c = signedByte(cursor, data)) !== 0 && c !== 10) data++;
      } else if (c === 47 && signedByte(cursor, data + 1) === 42) {
        data += 2;
        while (signedByte(cursor, data) !== 0
          && (signedByte(cursor, data) !== 42 || signedByte(cursor, data + 1) !== 47)) {
          data++;
        }
        if (signedByte(cursor, data) !== 0) data += 2;
      } else {
        break;
      }
    }

    if (c === 34) {
      data++;
      while (true) {
        c = signedByte(cursor, data);
        data++;
        if (c === 34 || c === 0) {
          // C writes its terminator out of bounds at length 1024. Reject at
          // that write, preserving the prefix and uncommitted caller cursor.
          if (this.currentToken.length === MAX_TOKEN_CHARS) {
            throw new RangeError("COM_Parse quoted token terminator exceeds 1024-byte storage");
          }
          // C advances past NUL on an unterminated quote. Retain its partial
          // token, but represent exhaustion without exposing that unsafe read.
          cursor.offset = c === 0 ? null : data;
          return this.currentToken;
        }
        if (this.currentToken.length < MAX_TOKEN_CHARS) {
          this.currentToken += source.charAt(data - 1);
        }
      }
    }

    do {
      if (this.currentToken.length < MAX_TOKEN_CHARS) {
        this.currentToken += source.charAt(data);
      }
      data++;
      c = signedByte(cursor, data);
      if (c === 10) this.currentLine = (this.currentLine + 1) | 0;
    } while (c > 32);

    if (this.currentToken.length === MAX_TOKEN_CHARS) this.currentToken = "";
    cursor.offset = data;
    return this.currentToken;
  }
}
