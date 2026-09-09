import { describe, expect, test } from "bun:test";

import {
  allocateScriptSource,
  LexerFlag,
  NumberFlag,
  Punctuation,
  ScriptLanguageError,
  ScriptLexer,
  type ScriptToken,
} from "../src/script/lexer.ts";
import { SOURCE_SCRIPT_BYTES, SOURCE_PUNCTUATION_TABLE_BYTES } from "../src/script/memory.ts";
import { SOURCE_TOKEN_BYTES, SourceTokenMemory } from "../src/script/token-memory.ts";
import { BotMemory, type BotMemoryAllocation } from "../src/botlib/memory.ts";
import { ZoneArena } from "../src/core/zone.ts";

class ScriptHeap extends BotMemory {
  readonly blocks: BotMemoryAllocation[] = [];
  readonly events: string[] = [];
  recordAtPunctuation: Uint8Array | null = null;

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    this.events.push(`allocate ${size} ${clear}`);
    if (size === SOURCE_PUNCTUATION_TABLE_BYTES) {
      const record = this.blocks.at(-1);
      if (record !== undefined) this.recordAtPunctuation = Uint8Array.from(record.bytes);
    }
    const allocation = super.allocate(size, kind, clear);
    this.blocks.push(allocation);
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    this.events.push(`free ${allocation.bytes.length}`);
    super.free(allocation);
  }
}

function readAll(lexer: ScriptLexer): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  while (true) {
    const token = lexer.next();
    if (token === undefined) {
      return tokens;
    }
    tokens.push(token);
  }
}

describe("botlib script lexer", () => {
  test("unread publication consumes the actual embedded token bytes, metadata and complete tail", () => {
    const zone = new ZoneArena(8192), memory = new ScriptHeap(undefined, zone);
    const source = allocateScriptSource(5, "retained.c", memory);
    source.copyText("first");
    const lexer = new ScriptLexer(source, "retained.c");
    const first = lexer.next();
    expect(first?.text).toBe("first");
    const bytes = source.token.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length).toBe(1068);
    expect(view.getInt32(1024, true)).toBe(4);
    expect(view.getInt32(1028, true)).toBe(5);
    expect(view.getUint32(1048, true)).toBe(2148);
    expect(view.getUint32(1052, true)).toBe(2148);
    bytes[0] = 98;
    bytes[1000] = 0x7e;
    bytes[1046] = 0xa5;
    bytes[1047] = 0x5a;
    view.setInt32(1032, 37, true);
    view.setBigUint64(1036, 0xa000000000000000n, true);
    view.setUint16(1044, 0x3fff, true);
    view.setInt32(1056, 77, true);
    view.setInt32(1060, 3, true);
    view.setUint32(1064, 29, true);
    source.tokenAvailable = true;
    const outputBytes = new Uint8Array(SOURCE_TOKEN_BYTES).fill(0xcc);
    const output = new SourceTokenMemory(() => outputBytes);
    const result = lexer.nextInto(output);
    expect(result).toMatchObject({ token: { text: "birst", location: { line: 77 }, linesCrossed: 3 },
      subtype: 5, integerValue: 37, floatValue: 1.25 });
    expect(result?.token).not.toBe(first);
    expect([...outputBytes]).toEqual([...bytes]);
    expect(output.next).toBe(29);
    expect(source.tokenAvailable).toBe(false);
    bytes[5] = 101;
    bytes[6] = 114;
    bytes[7] = 0;
    source.tokenAvailable = true;
    expect(lexer.nextInto(output)?.token.text).toBe("birster");
    const retained = Uint8Array.from(bytes);
    expect(lexer.nextInto(output)).toBeUndefined();
    expect(output.type).toBe(0);
    expect(output.string).toBe("");
    expect(output.whitespaceStart).toBe(2153);
    expect(output.whitespaceEnd).toBe(0);
    expect(outputBytes.subarray(0, 1048).every(byte => byte === 0)).toBe(true);
    expect(bytes).toEqual(retained);
    lexer.dispose();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("false quoted reads publish only reached writes before diagnostic callbacks", () => {
    const zone = new ZoneArena(8192), memory = new ScriptHeap(undefined, zone);
    const source = allocateScriptSource(9, "partial.c", memory);
    source.copyText('abc\n"bad\n');
    const bytes = new Uint8Array(SOURCE_TOKEN_BYTES).fill(0xcc);
    const output = new SourceTokenMemory(() => bytes);
    const observed: { readonly string: string; readonly type: number; readonly subtype: number; readonly line: number }[] = [];
    const lexer = new ScriptLexer(source, "partial.c", { report: () => {
      observed.push({ string: output.string, type: output.type, subtype: output.subtype, line: output.line });
    } });
    expect(lexer.nextInto(output)?.token.text).toBe("abc");
    const retained = Uint8Array.from(source.token.bytes);
    expect(() => lexer.nextInto(output)).toThrow(ScriptLanguageError);
    expect(observed).toEqual([{ string: '"bad', type: 1, subtype: 0, line: 2 }]);
    expect(output.whitespaceStart).toBe(2151);
    expect(output.whitespaceEnd).toBe(2152);
    expect(output.linesCrossed).toBe(1);
    expect(output.integerValue).toBe(0);
    expect(output.floatValue).toBe(0);
    expect([...bytes.subarray(0, 6)]).toEqual([34, 98, 97, 100, 0, 0]);
    expect(source.token.bytes).toEqual(retained);
    lexer.dispose();
    zone.dispose();
  });

  test("token copies preserve embedded NUL payloads, numeric precision and ABI padding", () => {
    const sourceBytes = new Uint8Array(SOURCE_TOKEN_BYTES);
    const destinationBytes = new Uint8Array(SOURCE_TOKEN_BYTES);
    const source = new SourceTokenMemory(() => sourceBytes);
    const destination = new SourceTokenMemory(() => destinationBytes);
    const lexer = new ScriptLexer('"a\\0b" 4294967297', "copy.c");
    const quoted = lexer.nextInto(source);
    expect(quoted?.token).toMatchObject({ text: '"a\0b"', value: "a\0b", length: 5 });
    expect(source.string).toBe('"a');
    sourceBytes[900] = 0x7e;
    destination.copyFrom(source);
    expect(destination.readRecord({ path: "copy.c", column: 1, leadingWhitespace: "" }).token.text).toBe('"a\0b"');
    expect(destinationBytes[900]).toBe(0x7e);
    const numeric = lexer.nextInto(source);
    expect(numeric).toMatchObject({ integerValue: 1, floatValue: 1 });
    expect(new DataView(sourceBytes.buffer).getUint32(1032, true)).toBe(1);
    destination.copyFrom(source);
    expect(destination.integerValue).toBe(1);
    new DataView(destinationBytes.buffer).setUint32(1032, 9, true);
    expect(destination.integerValue).toBe(9);
    source.integerValue = -0;
    destination.copyFrom(source);
    expect(Object.is(destination.integerValue, 0)).toBe(true);
    sourceBytes[1046] = 0xa5;
    sourceBytes[1047] = 0x5a;
    for (const value of [0, -0, 1.25, -.125, .1, Number.MIN_VALUE, Number.MAX_VALUE, Infinity, -Infinity, NaN]) {
      source.floatValue = value;
      expect(Object.is(source.floatValue, value)).toBe(true);
      expect([...sourceBytes.subarray(1046, 1048)]).toEqual([0xa5, 0x5a]);
      destination.copyFrom(source);
      expect(Object.is(destination.floatValue, value)).toBe(true);
    }
    const raw = new DataView(sourceBytes.buffer);
    raw.setBigUint64(1036, 0x8000000000000001n, true);
    raw.setUint16(1044, 0x3fff, true);
    expect(() => source.floatValue).toThrow("binary64 numeric profile");
  });

  test("caller token storage retains source failure state when a report callback throws", () => {
    const bytes = new Uint8Array(SOURCE_TOKEN_BYTES).fill(0xcc);
    const output = new SourceTokenMemory(() => bytes);
    const failure = new ScriptLanguageError({ severity: "error", message: "callback abort",
      location: { path: "callback", line: 1, column: 1 } }, []);
    const lexer = new ScriptLexer('"prefix\\j"', "callback.c", { report: () => { throw failure; } });
    let caught: unknown;
    try { lexer.nextInto(output); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(output.type).toBe(1);
    expect(output.subtype).toBe(0);
    expect(output.string).toBe('"prefix');
    expect(output.line).toBe(1);
  });

  test("matches the l_script source token classes, flags, values, and punctuation IDs", () => {
    const tokens = readAll(new ScriptLexer(
      'name 0x2aUL 0755 09 .5 "a\\n" \'z\' >>= ##',
      "oracle.c",
    ));

    expect(tokens).toHaveLength(9);
    expect(tokens[0]).toMatchObject({ kind: "name", text: "name", value: "name", length: 4 });
    expect(tokens[1]).toMatchObject({
      kind: "number",
      text: "0x2a",
      flags: NumberFlag.Hex | NumberFlag.Unsigned | NumberFlag.Long | NumberFlag.Integer,
      integerValue: 42,
      floatValue: 42,
    });
    expect(tokens[2]).toMatchObject({
      kind: "number",
      text: "0755",
      flags: NumberFlag.Octal | NumberFlag.Integer,
      integerValue: 493,
      floatValue: 493,
    });
    expect(tokens[3]).toMatchObject({
      kind: "number",
      text: "09",
      flags: NumberFlag.Decimal | NumberFlag.Integer,
      integerValue: 9,
      floatValue: 9,
    });
    expect(tokens[4]).toMatchObject({
      kind: "number",
      text: ".5",
      flags: NumberFlag.Decimal | NumberFlag.Float,
      integerValue: 0,
      floatValue: 0.5,
    });
    expect(tokens[5]).toMatchObject({ kind: "string", text: '"a\n"', value: "a\n", length: 4 });
    expect(tokens[6]).toMatchObject({ kind: "literal", text: "'z'", value: "z", length: 3 });
    expect(tokens[7]).toMatchObject({
      kind: "punctuation",
      text: ">>=",
      punctuation: Punctuation.RightShiftAssign,
    });
    expect(tokens[8]).toMatchObject({
      kind: "punctuation",
      text: "##",
      punctuation: Punctuation.PreprocessorMerge,
    });
  });

  test("tracks whitespace, comments, lines, and columns", () => {
    const lexer = new ScriptLexer("// heading\n  first /* two\n lines */ second", "botfiles/test.c");
    const first = lexer.next();
    const second = lexer.next();

    expect(first).toMatchObject({
      kind: "name",
      value: "first",
      location: { path: "botfiles/test.c", line: 2, column: 3 },
      leadingWhitespace: "// heading\n  ",
      linesCrossed: 1,
    });
    expect(second).toMatchObject({
      kind: "name",
      value: "second",
      location: { path: "botfiles/test.c", line: 3, column: 11 },
      leadingWhitespace: " /* two\n lines */ ",
      linesCrossed: 1,
    });
  });

  test("concatenates same-quote strings through whitespace and comments", () => {
    const lexer = new ScriptLexer('"one" /* join */ "two"\n\'a\' \'b\' "" \'\'', "strings.c");

    expect(lexer.next()).toMatchObject({ kind: "string", text: '"onetwo"', value: "onetwo" });
    expect(lexer.next()).toMatchObject({ kind: "literal", text: "'ab'", value: "ab" });
    expect(lexer.next()).toMatchObject({ kind: "string", text: '""', value: "", length: 2 });
    expect(lexer.next()).toMatchObject({ kind: "literal", text: "''", value: "", length: 2 });
  });

  test("can disable source string concatenation and escapes", () => {
    const lexer = new ScriptLexer('"one" "two" "a\\n"', "strings.c", {
      flags: LexerFlag.NoStringConcatenation | LexerFlag.NoStringEscapes,
    });

    expect(readAll(lexer).map((token) => token.text)).toEqual(['"one"', '"two"', '"a\\n"']);
  });

  test("unreads one token without sharing global scanner state", () => {
    const left = new ScriptLexer("alpha beta", "left.c");
    const right = new ScriptLexer("gamma", "right.c");
    const alpha = left.next();
    if (alpha === undefined) {
      throw new Error("fixture did not produce alpha");
    }
    left.unread(alpha);

    expect(left.next()).toBe(alpha);
    expect(right.next()).toMatchObject({ text: "gamma", location: { path: "right.c" } });
    expect(left.next()).toMatchObject({ text: "beta", location: { path: "left.c" } });
  });

  test("preserves source-accepted malformed number tokens without invented warnings", () => {
    const lexer = new ScriptLexer("0x 0b 1.2.3 0xA 0xB", "numbers.c");
    expect(readAll(lexer).map((token) => token.text)).toEqual(["0x", "0b", "1.2.3", "0xA", "0x", "B"]);
    expect(lexer.diagnostics).toEqual([]);
  });

  test("preserves NumberValue's early return and trailing-dot cleared-NUL arithmetic", () => {
    const lexer = new ScriptLexer("1.2.3 10. 10.25", "number-values.c");
    expect(lexer.next()).toMatchObject({ kind: "number", text: "1.2.3", integerValue: 0, floatValue: 1.2 });
    expect(lexer.next()).toMatchObject({ kind: "number", text: "10.", integerValue: 5, floatValue: 5.2 });
    expect(lexer.next()).toMatchObject({ kind: "number", text: "10.25", integerValue: 10, floatValue: 10.25 });
    expect(lexer.diagnostics).toEqual([]);
  });

  test("preserves the source hex-escape ASCII-letter digit quirk", () => {
    const token = new ScriptLexer('"\\xG"', "escape.c").next();
    expect(token).toMatchObject({ kind: "string", text: `"${String.fromCharCode(16)}"` });
    if (token === undefined || token.kind !== "string") {
      throw new Error("escape fixture did not produce a string");
    }
    expect(token.value.charCodeAt(0)).toBe(16);
  });

  test("reports escape warnings on the live concatenated segment while retaining the first token location", () => {
    const lexer = new ScriptLexer('"a"\n"\\999"', "escapes.c");
    expect(lexer.next()).toMatchObject({ value: "aÿ", location: { path: "escapes.c", line: 1 } });
    expect(lexer.diagnostics).toMatchObject([{ severity: "warning", location: { path: "escapes.c", line: 2 } }]);
    const failed = new ScriptLexer('"a"\n"\\j"', "escapes.c");
    expect(failed.next()).toMatchObject({ value: "a\0j", location: { path: "escapes.c", line: 1 } });
    expect(failed.diagnostics).toMatchObject([{ severity: "error", location: { path: "escapes.c", line: 2 } }]);
  });

  test("makes malformed strings and token capacity failures fatal and located", () => {
    const newline = new ScriptLexer('"not\nclosed"', "bad.c");
    expect(() => newline.next()).toThrow(ScriptLanguageError);
    expect(newline.diagnostics[0]).toEqual({
      severity: "error",
      message: 'newline inside string "not',
      location: { path: "bad.c", line: 1, column: 5 },
    });

    const tooLong = new ScriptLexer("abcdef", "long.c", { maxTokenLength: 6 });
    expect(() => tooLong.next()).toThrow("name longer than MAX_TOKEN = 6");
  });

  test("skips all nonzero signed high bytes only outside quoted tokens", () => {
    const bytes = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index + 128)).join("");
    const lexer = new ScriptLexer(`${bytes}{"k" "${bytes}"}\0ignored`, "bytes.c", {
      flags: LexerFlag.NoStringConcatenation | LexerFlag.NoStringEscapes,
    });
    expect(readAll(lexer).map(token => token.text)).toEqual(["{", '"k"', `"${bytes}"`, "}"]);
    expect(lexer.diagnostics).toEqual([]);
    expect(lexer.currentLocation).toEqual({ path: "bytes.c", line: 1, column: 265 });
    const notByte = new ScriptLexer("\u0100", "utf16.c");
    expect(() => notByte.next()).toThrow("can't read token");
    expect(notByte.currentLocation).toEqual({ path: "utf16.c", line: 1, column: 1 });
  });

  test("quoted payload capacity includes its leading quote for strings and literals", () => {
    for (const quote of ['"', "'"]) {
      for (const count of [0, 1019, 1020]) {
        const lexer = new ScriptLexer(`${quote}${"x".repeat(count)}${quote}`, "capacity.c");
        expect(lexer.next()).toMatchObject({ value: "x".repeat(count), length: count + 2 });
        expect(lexer.next()).toBeUndefined();
      }
      const lexer = new ScriptLexer(`${quote}${"x".repeat(1021)}${quote}`, "capacity.c");
      expect(() => lexer.next()).toThrow("string longer than MAX_TOKEN = 1024");
      expect(lexer.diagnostics).toEqual([{ severity: "error", message: "string longer than MAX_TOKEN = 1024", location: { path: "capacity.c", line: 1, column: 1023 } }]);
    }
  });

  test("concatenated segments share capacity and diagnose the current segment line", () => {
    for (const quote of ['"', "'"]) {
      const prefix = `${quote}${"a".repeat(1019)}${quote}\n/*join*/${quote}`;
      expect(new ScriptLexer(`${prefix}b${quote}`, "joined.c").next()).toMatchObject({ value: `${"a".repeat(1019)}b`, length: 1022 });
      const rejected = new ScriptLexer(`${prefix}bc${quote}`, "joined.c");
      expect(() => rejected.next()).toThrow("string longer than MAX_TOKEN = 1024");
      expect(rejected.currentLocation).toEqual({ path: "joined.c", line: 2, column: 12 });
      const separated = new ScriptLexer(`${quote}${"a".repeat(1020)}${quote}\n${quote}b${quote}`, "joined.c", { flags: LexerFlag.NoStringConcatenation });
      expect(readAll(separated).map(token => token.text.length)).toEqual([1022, 3]);
    }
    expect(new ScriptLexer('"ab"', "small.c", { maxTokenLength: 6 }).next()).toMatchObject({ value: "ab" });
    expect(() => new ScriptLexer('"abc"', "small.c", { maxTokenLength: 6 }).next()).toThrow("string longer than MAX_TOKEN = 6");
  });

  test("reports exact current-line quote failures and C-string partial buffers", () => {
    const cases: readonly (readonly [string, string, number, number])[] = [
      ['"bad\n', 'newline inside string "bad', 1, 5],
      ["'bad\n", "newline inside string 'bad", 1, 5],
      ['"a"\n"b\n', 'newline inside string "ab', 2, 3],
      ['"a"\n"b', "missing trailing quote", 2, 3],
      ['"a"\n"b\0ignored', "missing trailing quote", 2, 3],
      ['"a\\0b\n', 'newline inside string "a', 1, 6],
      ["\n// comment\n`", "can't read token", 3, 1],
    ];
    for (const [text, message, line, column] of cases) {
      const lexer = new ScriptLexer(text, "failed.c");
      expect(() => lexer.next()).toThrow(ScriptLanguageError);
      expect(lexer.diagnostics).toEqual([{ severity: "error", message, location: { path: "failed.c", line, column } }]);
      expect(lexer.currentLocation).toEqual({ path: "failed.c", line, column });
    }
    const embedded = new ScriptLexer('"a\\0b"', "nul.c").next();
    expect(embedded).toMatchObject({ value: "a\0b", length: 5 });
  });

  test("preserves separate decimal, hexadecimal, binary and name token limits", () => {
    const cases: readonly (readonly [string, string, string, number])[] = [
      ["0".repeat(1022), "0".repeat(1023), "number", 1024],
      [`0.${"0".repeat(1020)}`, `0.${"0".repeat(1021)}`, "number", 1024],
      [`0x${"0".repeat(1021)}`, `0x${"0".repeat(1022)}`, "hexadecimal number", 1025],
      [`0b${"0".repeat(1021)}`, `0b${"0".repeat(1022)}`, "binary number", 1025],
      ["a".repeat(1023), "a".repeat(1024), "name", 1025],
    ];
    for (const [accepted, rejected, label, column] of cases) {
      expect(new ScriptLexer(accepted, "limit.c").next()?.text).toBe(accepted);
      const lexer = new ScriptLexer(`\n${rejected}`, "limit.c");
      expect(() => lexer.next()).toThrow(`${label} longer than MAX_TOKEN = 1024`);
      expect(lexer.currentLocation).toEqual({ path: "limit.c", line: 2, column });
    }
    const suffix = new ScriptLexer(`${"0".repeat(1022)}UL next`, "suffix.c");
    expect(suffix.next()).toMatchObject({ text: "0".repeat(1022), flags: NumberFlag.Octal | NumberFlag.Unsigned | NumberFlag.Long | NumberFlag.Integer });
    expect(suffix.next()?.text).toBe("next");
    expect(readAll(new ScriptLexer("0b 0B1", "binary.c", { flags: LexerFlag.NoBinaryNumbers })).map(token => token.text)).toEqual(["0", "b", "0", "B1"]);
  });

  test("currentLocation is a frozen snapshot across unread, EOF comments and reset", () => {
    const lexer = new ScriptLexer('"a"\n /* eof\ncomment */', "location.c");
    const initial = lexer.currentLocation, token = lexer.next(), afterToken = lexer.currentLocation;
    if (token === undefined) throw new Error("Expected quoted fixture token");
    expect(Object.isFrozen(initial)).toBe(true);
    expect(initial).toEqual({ path: "location.c", line: 1, column: 1 });
    expect(afterToken).toEqual({ path: "location.c", line: 1, column: 4 });
    lexer.unread(token);
    expect(lexer.currentLocation).toEqual(afterToken);
    expect(lexer.next()).toBe(token);
    expect(lexer.next()).toBeUndefined();
    expect(lexer.currentLocation).toEqual({ path: "location.c", line: 3, column: 11 });
    expect(afterToken).toEqual({ path: "location.c", line: 1, column: 4 });
    lexer.reset();
    expect(lexer.currentLocation).toEqual(initial);
    expect(lexer.next()?.text).toBe('"a"');
    const failed = new ScriptLexer("`", "reset.c");
    expect(() => failed.next()).toThrow(ScriptLanguageError);
    failed.reset();
    expect(failed.diagnostics).toEqual([]);
    expect(failed.currentLocation).toEqual({ path: "reset.c", line: 1, column: 1 });
  });

  test("memory loading initializes source fields before punctuation allocation and copies afterward", () => {
    const zone = new ZoneArena(8192), memory = new ScriptHeap(undefined, zone);
    const lexer = new ScriptLexer("alpha beta", "memory.c", { memory });
    const [record, table] = memory.blocks;
    const beforeTable = memory.recordAtPunctuation;
    if (record === undefined || table === undefined || beforeTable === null) throw new Error("Missing script allocations");
    expect(SOURCE_SCRIPT_BYTES).toBe(2148);
    expect(memory.events).toEqual(["allocate 2159 true", "allocate 1024 false"]);
    const before = new DataView(beforeTable.buffer, beforeTable.byteOffset, beforeTable.byteLength);
    expect([...beforeTable.subarray(0, 9)]).toEqual([109, 101, 109, 111, 114, 121, 46, 99, 0]);
    expect(before.getUint32(1024, true)).toBe(2148);
    expect(before.getUint32(1028, true)).toBe(2148);
    expect(before.getUint32(1032, true)).toBe(2158);
    expect(before.getUint32(1036, true)).toBe(2148);
    expect(before.getInt32(1048, true)).toBe(10);
    expect(before.getInt32(1052, true)).toBe(1);
    expect(before.getInt32(1056, true)).toBe(1);
    expect(before.getUint32(1068, true)).toBe(0);
    expect(before.getUint32(1072, true)).toBe(0);
    expect([...beforeTable.subarray(2148)]).toEqual(Array.from({ length: 11 }, () => 0));

    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    const alpha = lexer.next();
    if (alpha === undefined) throw new Error("Missing alpha token");
    expect(view.getUint32(1028, true)).toBe(2153);
    expect(view.getUint32(1040, true)).toBe(2148);
    expect(view.getUint32(1044, true)).toBe(2148);
    lexer.unread(alpha);
    expect(view.getInt32(1060, true)).toBe(1);
    expect(lexer.next()).toBe(alpha);
    expect(view.getInt32(1060, true)).toBe(0);
    record.bytes[2154] = 122;
    record.bytes[0] = 77;
    view.setInt32(1052, 7, true);
    expect(lexer.next()).toMatchObject({ text: "zeta", location: { path: "Memory.c", line: 7, column: 7 } });
    expect(view.getInt32(1056, true)).toBe(7);
    lexer.reset();
    expect(view.getUint32(1040, true)).toBe(0);
    expect(view.getUint32(1044, true)).toBe(0);
    expect(lexer.currentLocation).toEqual({ path: "Memory.c", line: 1, column: 1 });
    memory.events.length = 0;
    lexer.dispose();
    lexer.dispose();
    expect(memory.events).toEqual(["free 1024", "free 2159"]);
    expect(() => lexer.next()).toThrow("freed");
    expect(() => record.bytes).toThrow("freed");
    expect(() => table.bytes).toThrow("freed");
    expect(zone.memoryRemaining()).toBe(8192);
    zone.checkHeap();
    zone.dispose();
  });

  test("file compression mutates the loaded block while retaining its original end pointer", () => {
    const zone = new ZoneArena(8192), memory = new ScriptHeap(undefined, zone);
    const input = '// heading\n  left /* hidden\n */ + "a // b"\r\n right // end';
    const source = allocateScriptSource(input.length, "file.c", memory);
    source.copyText(input);
    const record = memory.blocks[0];
    if (record === undefined) throw new Error("Missing file script allocation");
    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    source.compress();
    expect(source.text).toBe('\nleft + "a // b"\nright');
    expect(source.length).toBe(22);
    expect(source.buffer.length).toBe(input.length);
    expect(view.getUint32(1032, true)).toBe(2148 + input.length);
    expect(record.bytes[2148 + source.length]).toBe(0);
    const lexer = new ScriptLexer(source, "ignored.c");
    expect(readAll(lexer).map(token => token.text)).toEqual(["left", "+", '"a // b"', "right"]);
    lexer.dispose();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("punctuation selection and flags consume the actual table and script words", () => {
    const zone = new ZoneArena(8192), memory = new ScriptHeap(undefined, zone);
    const source = allocateScriptSource(3, "punctuation.c", memory);
    source.copyText(">>=");
    const [record, table] = memory.blocks;
    if (record === undefined || table === undefined) throw new Error("Missing punctuation allocations");
    const tableView = new DataView(table.bytes.buffer, table.bytes.byteOffset, table.bytes.byteLength);
    const lexer = new ScriptLexer(source, "punctuation.c");
    expect(tableView.getUint32(62 * 4, true)).toBe(1);
    tableView.setUint32(62 * 4, Punctuation.Greater, true);
    expect(readAll(lexer).map(token => token.text)).toEqual([">", ">", "="]);
    lexer.reset();
    tableView.setUint32(62 * 4, 1, true);
    expect(lexer.next()).toMatchObject({ text: ">>=", punctuation: Punctuation.RightShiftAssign });
    lexer.dispose();

    const quoted = new ScriptLexer('"a" "b"', "flags.c", { memory });
    const quotedRecord = memory.blocks[2];
    if (quotedRecord === undefined) throw new Error("Missing quoted script allocation");
    new DataView(quotedRecord.bytes.buffer, quotedRecord.bytes.byteOffset, quotedRecord.bytes.byteLength)
      .setInt32(1064, LexerFlag.NoStringConcatenation, true);
    expect(readAll(quoted).map(token => token.text)).toEqual(['"a"', '"b"']);
    quoted.dispose();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });

  test("punctuation allocation failure retains the initialized script before its memory copy", () => {
    const zone = new ZoneArena(3000), memory = new ScriptHeap(undefined, zone);
    expect(() => new ScriptLexer("hello!", "failure.c", { memory })).toThrow("Z_Malloc");
    const record = memory.blocks[0];
    if (record === undefined) throw new Error("Missing retained script allocation");
    expect(memory.events).toEqual(["allocate 2155 true", "allocate 1024 false"]);
    expect(memory.blocks.length).toBe(1);
    expect([...record.bytes.subarray(2148)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
    expect(view.getInt32(1052, true)).toBe(1);
    expect(view.getUint32(1068, true)).toBe(0);
    expect(view.getUint32(1072, true)).toBe(0);
    expect(zone.memoryRemaining()).toBe(816);
    memory.free(record);
    zone.checkHeap();
    zone.dispose();
  });

  test("warning callbacks observe the live source cursor and leave allocations after abort", () => {
    const zone = new ZoneArena(8192), memory = new ScriptHeap(undefined, zone);
    const abort = new Error("warning abort");
    const lexer = new ScriptLexer('"a"\n"\\999" tail', "warning.c", {
      memory,
      report: diagnostic => {
        const record = memory.blocks[0];
        if (record === undefined) throw new Error("Missing warning script allocation");
        const view = new DataView(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength);
        expect(diagnostic.severity).toBe("warning");
        expect(view.getUint32(1028, true)).toBe(2148 + 8);
        expect(view.getInt32(1052, true)).toBe(2);
        throw abort;
      },
    });
    expect(() => lexer.next()).toThrow(abort);
    expect(memory.events.filter(event => event.startsWith("free"))).toEqual([]);
    expect(lexer.currentLocation).toEqual({ path: "warning.c", line: 2, column: 5 });
    lexer.dispose();
    expect(zone.memoryRemaining()).toBe(8192);
    zone.dispose();
  });
});
