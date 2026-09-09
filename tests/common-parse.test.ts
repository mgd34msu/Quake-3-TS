import { describe, expect, test } from "bun:test";
import { CommonParseCursor, CommonParseState, compressCommonText } from "../src/core/common-parse.ts";

describe("q_shared.c COM_Compress", () => {
  test("comments, pending CR/LF and tabs follow source byte order", () => {
    expect(compressCommonText(" \t one \t two\r\n\n three  ")).toBe(" one two\nthree");
    expect(compressCommonText("a/* ignored\n */b// ignored\rstill ignored\nc")).toBe("ab\nc");
    expect(compressCommonText("a/*/b")).toBe("ab");
    expect(compressCommonText("x/* unfinished")).toBe("x");
    expect(compressCommonText("a\v\fb\x80\xff")).toBe("a\v\fb\x80\xff");
  });
  test("quoted comments and whitespace remain literal, with no escape processing", () => {
    expect(compressCommonText('"a // b\r\n c /* d */" \t tail')).toBe('"a // b\r\n c /* d */" tail');
    expect(compressCommonText('"a\\"/* removed */b')).toBe('"a\\"b');
    expect(compressCommonText('"unfinished\n')).toBe('"unfinished\n');
    expect(compressCommonText("x\0ignored")).toBe("x");
  });
  test("known NUL terminates short reads; unknown bytes reject at the reached read", () => {
    expect(compressCommonText("x\0", "uninitialized")).toBe("x");
    expect(compressCommonText("/*\0", "uninitialized")).toBe("");
    for (const source of ["", "x", "/", "//", "/*", '"quoted"']) {
      expect(() => compressCommonText(source, "uninitialized")).toThrow("uninitialized short-read tail");
    }
    expect(() => compressCommonText("\u0100")).toThrow("not a Latin-1 byte string");
  });
});

describe("q_shared.c COM_ParseExt byte parsing", () => {
  test("SkipRestOfLine retains tokens, counts only LF and commits only completed reads", () => {
    const state = new CommonParseState();
    expect(state.parse(new CommonParseCursor("retained"))).toBe("retained");
    const source = new CommonParseCursor(' } /* " ignored\r\xff\nnext', "uninitialized");
    state.skipRestOfLine(source);
    expect(source.offset).toBe(source.source.indexOf("\n") + 1);
    expect(state.line).toBe(1);
    expect(state.token).toBe("retained");

    const short = new CommonParseCursor(" ignored\r", "uninitialized");
    short.offset = 1;
    expect(() => state.skipRestOfLine(short)).toThrow("uninitialized short-read tail");
    expect(short.offset).toBe(1);
    expect(state.line).toBe(1);
    expect(state.token).toBe("retained");

    for (const text of ["", " ignored\r", " ignored\0\n"]) {
      const cursor = new CommonParseCursor(text);
      state.skipRestOfLine(cursor);
      expect(cursor.offset).toBeNull();
      expect(state.line).toBe(1);
      expect(state.token).toBe("retained");
      expect(() => state.skipRestOfLine(cursor)).toThrow("requires a live source cursor");
    }
  });

  test("short-read storage rejects only an actual read beyond available bytes", () => {
    const state = new CommonParseState();
    const quoted = new CommonParseCursor('"wrong"', "uninitialized");
    expect(state.parse(quoted)).toBe("wrong");
    expect(quoted.offset).toBe(7);
    expect(() => state.parse(quoted)).toThrow("uninitialized short-read tail");
    expect(() => state.parse(new CommonParseCursor("wrong", "uninitialized"))).toThrow("uninitialized short-read tail");
    expect(state.parse(new CommonParseCursor("wrong\0", "uninitialized"))).toBe("wrong");
  });

  test("ordinary words retain adjacent punctuation and embedded comment markers", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor(' /* ignored */ { key value } a,b;(c) x//y x/*y*/z "two words"');
    for (const expected of ["{", "key", "value", "}", "a,b;(c)", "x//y", "x/*y*/z", "two words"]) {
      expect(state.parse(cursor)).toBe(expected);
      expect(state.token).toBe(expected);
    }
    expect(state.parse(cursor)).toBe("");
    expect(cursor.offset).toBeNull();
    expect(state.line).toBe(0);
  });

  test("quoted strings have no escape processing or newline accounting", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor('"a\\"b "x\ny"tail');
    expect(state.parse(cursor)).toBe("a\\");
    expect(cursor.offset).toBe(4);
    expect(state.parse(cursor)).toBe("b");
    expect(state.parse(cursor)).toBe("x\ny");
    expect(state.line).toBe(0);
    expect(state.parse(cursor)).toBe("tail");
  });

  test("line comments end at LF, while CR remains inside the comment", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor("// ignored\rstill ignored\nnext");
    expect(state.parse(cursor, false)).toBe("");
    expect(cursor.offset).toBe(25);
    expect(state.line).toBe(1);
    expect(state.parse(cursor, false)).toBe("next");

    const onlyCr = new CommonParseCursor("// ignored\rnext");
    expect(state.parse(onlyCr)).toBe("");
    expect(onlyCr.offset).toBeNull();
    expect(state.line).toBe(1);
  });

  test("block comment LF does not count or stop a disallowed-line parse", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor("/* first\nsecond */ /*third*/next");
    expect(state.parse(cursor, false)).toBe("next");
    expect(state.line).toBe(0);
    const unterminated = new CommonParseCursor("/* ignored\nforever");
    expect(state.parse(unterminated, false)).toBe("");
    expect(unterminated.offset).toBeNull();
    expect(state.line).toBe(0);
  });

  test("CR alone is whitespace, without a line barrier", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor("\r\t first\rsecond");
    expect(state.parse(cursor, false)).toBe("first");
    expect(state.parse(cursor, false)).toBe("second");
    expect(state.line).toBe(0);
  });

  test("word LF counts on lookahead and again on the next whitespace skip", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor("one\n \ttwo");
    expect(state.parse(cursor, false)).toBe("one");
    expect(cursor.offset).toBe(3);
    expect(state.line).toBe(1);
    expect(state.parse(cursor, false)).toBe("");
    expect(cursor.offset).toBe(6);
    expect(state.line).toBe(2);
    expect(state.parse(cursor, false)).toBe("two");
    expect(state.line).toBe(2);
  });

  test("a disallowed line break stops before the following comment is consumed", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor("\n/* ignored */next");
    expect(state.parse(cursor, false)).toBe("");
    expect(cursor.offset).toBe(1);
    expect(state.line).toBe(1);
    expect(state.parse(cursor, false)).toBe("next");
    expect(state.line).toBe(1);
  });

  test("zero-length input, NUL and whitespace EOF exhaust the cursor", () => {
    for (const input of ["", "\0ignored", " \t\n"]) {
      const state = new CommonParseState();
      const cursor = new CommonParseCursor(input);
      expect(cursor.offset).toBe(0);
      expect(state.parse(cursor, false)).toBe("");
      expect(cursor.offset).toBeNull();
      expect(state.parse(cursor)).toBe("");
    }
  });

  test("embedded NUL terminates an ordinary token before later bytes", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor("a\0ignored");
    expect(cursor.source).toBe("a\0ignored");
    expect(state.parse(cursor)).toBe("a");
    expect(cursor.offset).toBe(1);
    expect(state.parse(cursor)).toBe("");
    expect(cursor.offset).toBeNull();
  });

  test("empty quoted tokens retain a non-null cursor, including at string end", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor('""next ""');
    expect(state.parse(cursor)).toBe("");
    expect(cursor.offset).toBe(2);
    expect(state.parse(cursor)).toBe("next");
    expect(state.parse(cursor)).toBe("");
    expect(cursor.offset).toBe(9);
    expect(state.parse(cursor)).toBe("");
    expect(cursor.offset).toBeNull();
  });

  test("unterminated quotes preserve their partial token with managed exhaustion", () => {
    for (const input of ['"abc', '"abc\0ignored']) {
      const state = new CommonParseState();
      const cursor = new CommonParseCursor(input);
      expect(state.parse(cursor)).toBe("abc");
      expect(cursor.offset).toBeNull();
      expect(state.parse(cursor)).toBe("");
    }
  });

  test("ordinary words of 1024 or more bytes are fully consumed and discarded", () => {
    for (const length of [1023, 1024, 1025]) {
      const state = new CommonParseState();
      const word = "a".repeat(length);
      const cursor = new CommonParseCursor(`${word}\nnext`);
      expect(state.parse(cursor)).toBe(length === 1023 ? word : "");
      expect(cursor.offset).toBe(length);
      expect(state.line).toBe(1);
      expect(state.parse(cursor)).toBe("next");
      expect(state.line).toBe(2);
    }
  });

  test("1023 quoted bytes fit their terminator", () => {
    const state = new CommonParseState();
    const word = "a".repeat(1023);
    const cursor = new CommonParseCursor(`"${word}"next`);
    expect(state.parse(cursor)).toBe(word);
    expect(cursor.offset).toBe(1025);
    expect(state.parse(cursor)).toBe("next");
  });

  test("quoted terminator overflow rejects after partial writes without committing the cursor", () => {
    for (const length of [1024, 1025]) {
      for (const terminator of ['"next', ""]) {
        const state = new CommonParseState();
        const cursor = new CommonParseCursor(`\n"${"a".repeat(length)}${terminator}`);
        expect(() => state.parse(cursor)).toThrow("quoted token terminator");
        expect(cursor.offset).toBe(0);
        expect(state.token).toBe("a".repeat(1024));
        expect(state.line).toBe(1);
      }
    }
  });

  test("signed high bytes are skipped and end ordinary words but copy unchanged in quotes", () => {
    const state = new CommonParseState();
    const cursor = new CommonParseCursor('\x80\xffalpha\xe9beta "\x80\xe9\xff" \x7f');
    expect(state.parse(cursor, false)).toBe("alpha");
    expect(cursor.offset).toBe(7);
    expect(state.parse(cursor, false)).toBe("beta");
    expect(state.parse(cursor)).toBe("\x80\xe9\xff");
    expect(state.parse(cursor)).toBe("\x7f");
    expect(state.line).toBe(0);
  });

  test("constructor checks the entire Latin-1 domain and cursor writes check its NUL boundary", () => {
    for (const input of ["\u0100", "\ud800", "\0\u0100"]) {
      expect(() => new CommonParseCursor(input)).toThrow("not a Latin-1 byte string");
    }
    const cursor = new CommonParseCursor("a\0ignored");
    for (const offset of [-1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => { cursor.offset = offset; }).toThrow("outside its C byte string");
      expect(cursor.offset).toBe(0);
    }
    cursor.offset = 1;
    expect(cursor.offset).toBe(1);
    cursor.offset = null;
    expect(cursor.offset).toBeNull();
    cursor.offset = 0;
    expect(cursor.offset).toBe(0);
  });

  test("state belongs to the parser instance and persists across independent cursors", () => {
    const first = new CommonParseState();
    const second = new CommonParseState();
    const cursor = new CommonParseCursor("key\nvalue");
    expect(first.line).toBe(0);
    expect(first.token).toBe("");
    const copiedKey = first.parse(cursor);
    expect(first.line).toBe(1);
    expect(second.parse(new CommonParseCursor("other"))).toBe("other");
    expect(second.line).toBe(0);
    expect(first.parse(new CommonParseCursor("\nnew"))).toBe("new");
    expect(first.line).toBe(2);
    expect(cursor.offset).toBe(3);
    expect(first.parse(cursor)).toBe("value");
    expect(first.line).toBe(3);
    expect(copiedKey).toBe("key");
    expect(second.token).toBe("other");
  });
});
