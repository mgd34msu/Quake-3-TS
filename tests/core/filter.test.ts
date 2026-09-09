import { describe, expect, test } from "bun:test";
import { sourceFilter } from "../../src/core/filter.ts";

describe("common.c Com_Filter", () => {
  test("matches source prefixes, case folding and non-backtracking star searches", () => {
    expect(sourceFilter("sv_", "sv_hostname", false)).toBe(true);
    expect(sourceFilter("SV_*", "sv_hostname", false)).toBe(true);
    expect(sourceFilter("SV_*", "sv_hostname", true)).toBe(false);
    expect(sourceFilter("*ab?c", "abXdabYc", true)).toBe(false);
    expect(sourceFilter("*ab?c", "zzabYc", true)).toBe(true);
    expect(sourceFilter("", "anything", false)).toBe(true);
    expect(sourceFilter("?", "", false)).toBe(true);
  });
  test("preserves range syntax and literal star-run bracket text", () => {
    expect(sourceFilter("[a-c]var", "Bvariable", false)).toBe(true);
    expect(sourceFilter("[a-c]var", "Bvariable", true)).toBe(false);
    expect(sourceFilter("*[_]", "literal[_]tail", false)).toBe(true);
    expect(sourceFilter("*[_]", "underscore_", false)).toBe(false);
    expect(sourceFilter("[]]x", "]x", true)).toBe(true);
    expect(sourceFilter("[[a]", "a", true)).toBe(true);
    expect(sourceFilter("x\0no", "xyz", true)).toBe(true);
  });
  test("signed 0xff is the defined EOF input to native toupper in case-insensitive ranges", () => {
    expect(sourceFilter("[\xff-z]", "echo", false)).toBe(true);
    expect(sourceFilter("[\xff-z]", "echo", true)).toBe(true);
    expect(sourceFilter("[a-\xff]", "echo", false)).toBe(false);
    expect(sourceFilter("\xff", "\xff", false)).toBe(true);
  });
  test("rejects source scratch overflow and reads beyond the terminating byte", () => {
    expect(() => sourceFilter(`*${"x".repeat(1024)}`, "x", false)).toThrow("scratch");
    expect(() => sourceFilter("??", "", false)).toThrow("terminator");
    expect(() => sourceFilter("[a", "a", false)).toThrow("terminator");
    expect(() => sourceFilter("\u0100", "x", false)).toThrow("source bytes");
  });
});
