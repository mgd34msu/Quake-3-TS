// q_shared.c parser helper cases. Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { CommonParseCursor, CommonParseState } from "../src/core/common-parse.ts";

describe("shared source parser helpers", () => {
  test("session reset preserves the token and diagnostics use the retained source line", () => {
    const parser = new CommonParseState(), output: string[] = [];
    const print = (text: string): undefined => { output.push(text); };
    parser.parse(new CommonParseCursor("retained\n"));
    expect(parser.line).toBe(1);
    parser.beginSession("map\0ignored", print);
    expect(parser.token).toBe("retained");
    expect(parser.line).toBe(0);
    parser.parse(new CommonParseCursor("word\n next"));
    parser.parseError("bad token\0ignored", print);
    parser.parseWarning("unused", print);
    expect(output).toEqual(["ERROR: map, line 1: bad token\n", "WARNING: map, line 1: unused\n"]);
    expect(parser.token).toBe("word");
  });

  test("session name formatting emits the original truncation diagnostic", () => {
    const parser = new CommonParseState(), output: string[] = [];
    const print = (text: string): undefined => { output.push(text); };
    parser.beginSession("x".repeat(1024), print);
    parser.parseWarning("tail", print);
    expect(output).toEqual(["Com_sprintf: overflow of 1024 in 1024\n", `WARNING: ${"x".repeat(1023)}, line 0: tail\n`]);
    expect(() => parser.beginSession("x".repeat(32000), print)).toThrow(new CommonError("fatal", "Com_sprintf: overflowed bigbuffer"));
  });

  test("matching failures consume and retain the mismatched token", () => {
    const parser = new CommonParseState(), cursor = new CommonParseCursor("wrong next");
    expect(() => parser.matchToken(cursor, "(")).toThrow(new CommonError("drop", "MatchToken: wrong != ("));
    expect(parser.token).toBe("wrong");
    expect(parser.parse(cursor)).toBe("next");
    parser.matchToken(new CommonParseCursor("("), "(\0ignored");
  });

  test("braced skips honor quoted single braces, nested depth, EOF and non-openers", () => {
    const parser = new CommonParseState();
    const nested = new CommonParseCursor('{ "{" value "}" } tail');
    parser.skipBracedSection(nested);
    expect(parser.token).toBe("}");
    expect(parser.parse(nested)).toBe("tail");
    const ordinary = new CommonParseCursor("word tail");
    parser.skipBracedSection(ordinary);
    expect(parser.parse(ordinary)).toBe("tail");
    const unfinished = new CommonParseCursor("{ { tail");
    parser.skipBracedSection(unfinished);
    expect(unfinished.offset).toBeNull();
    const close = new CommonParseCursor("} tail");
    parser.skipBracedSection(close);
    expect(close.offset).toBeNull();
  });

  test("matrix parsing writes native numeric values in row-major order", () => {
    const parser = new CommonParseState(), matrix = new Float32Array(10).fill(99);
    const cursor = new CommonParseCursor("( ( ( 1e2 0x1.8p1 ) ( -0 1.23456789 ) ) ( ( nan inf ) ( invalid 7tail ) ) ) after");
    parser.parse3DMatrix(cursor, 2, 2, 2, matrix, 1);
    expect(Array.from(matrix)).toEqual([99, 100, 3, -0, Math.fround(1.23456789), NaN, Infinity, 0, 7, 99]);
    expect(parser.parse(cursor)).toBe("after");
  });

  test("nested matrix closing errors preserve all preceding writes", () => {
    const parser = new CommonParseState(), matrix = new Float32Array(6).fill(99);
    const cursor = new CommonParseCursor("( ( 1 2 ) ( 3 4 wrong tail");
    expect(() => parser.parse2DMatrix(cursor, 2, 2, matrix, 1)).toThrow(new CommonError("drop", "MatchToken: wrong != )"));
    expect(Array.from(matrix)).toEqual([99, 1, 2, 3, 4, 99]);
    expect(parser.parse(cursor)).toBe("tail");
  });

  test("empty dimensions still match their brackets and exhaustion writes atof empty values", () => {
    const parser = new CommonParseState(), matrix = new Float32Array([99, 99]);
    parser.parse1DMatrix(new CommonParseCursor("( )"), 0, matrix);
    expect(Array.from(matrix)).toEqual([99, 99]);
    expect(() => parser.parse1DMatrix(new CommonParseCursor("( 5"), 2, matrix)).toThrow(new CommonError("drop", "MatchToken:  != )"));
    expect(Array.from(matrix)).toEqual([5, 0]);
  });

  test("out of bounds writes reject at the reached cell after retaining its token", () => {
    const parser = new CommonParseState(), matrix = new Float32Array(1);
    const cursor = new CommonParseCursor("( 1 2 ) tail");
    expect(() => parser.parse1DMatrix(cursor, 2, matrix)).toThrow("Parse1DMatrix write exceeds its destination");
    expect(matrix[0]).toBe(1);
    expect(parser.token).toBe("2");
    expect(parser.parse(cursor)).toBe(")");
  });
});
