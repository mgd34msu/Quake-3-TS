import { expect, test } from "bun:test";
import { infoSetValueForKey, infoSetValueForKeyBig, infoValueForKey } from "../src/core/info-string.ts";
import { CommonError } from "../src/core/common-error.ts";

test("ordinary native info setter removes only the first case-sensitive key and prepends", () => {
  const logs: string[] = [], print = (text: string): void => { logs.push(text); };
  expect(infoSetValueForKey("\\K\\first\\k\\last", "k", "new", print)).toBe("\\k\\new\\K\\first");
  expect(infoSetValueForKey("\\k\\one\\k\\two", "k", "new", print)).toBe("\\k\\new\\k\\two");
  expect(infoSetValueForKey("\\k\\one\\z\\two", "k", "", print)).toBe("\\z\\two");
  expect(logs).toEqual([]);
});

test("native rejection precedes removal but oversized replacements remove the old key first", () => {
  const logs: string[] = [], print = (text: string): void => { logs.push(text); };
  const info = "\\k\\old\\z\\1";
  expect(infoSetValueForKey(info, "k", "bad;value", print)).toBe(info);
  expect(infoSetValueForKey(info, "k", "x".repeat(1099), print)).toBe("\\z\\1");
  // /tmp/q3-server-connectionless-YWMZkN/info: untouched q_shared.c, gcc-m32-O2.
  expect(logs).toEqual(["Can't use keys or values with a semicolon\n", "Com_sprintf: overflow of 1102 in 1024\n", "Info string length exceeded\n"]);
});

test("native byte/NUL semantics and explicit C buffer-overrun boundaries", () => {
  const logs: string[] = [], print = (text: string): void => { logs.push(text); };
  expect(() => infoValueForKey("x".repeat(8192), "x")).toThrow(new CommonError("drop", "Info_ValueForKey: oversize infostring"));
  try {
    infoValueForKey("x".repeat(8192), "x");
  } catch (error) {
    expect(error).toBeInstanceOf(CommonError);
    if (!(error instanceof CommonError)) throw error;
    expect(error.code).toBe("drop");
  }
  expect(infoSetValueForKey("", "k", "é".repeat(600), print)).toBe(`\\k\\${"é".repeat(600)}`);
  expect(infoSetValueForKey("\\a\\old\0ignored", "a\0b", "new\0bad", print)).toBe("\\a\\new");
  expect(infoSetValueForKey("", "k", "x".repeat(1200), print).length).toBe(1023);
  expect(() => infoSetValueForKey("x".repeat(1024), "k", "v", print)).toThrow("oversize");
  expect(() => infoSetValueForKey("\\z\\1", "k", "x".repeat(1017), print)).toThrow("source terminator");
  expect(() => infoSetValueForKey("", "k", "🙂", print)).toThrow("byte characters");
});

test("big info setter appends byte strings with its separate source capacity", () => {
  const logs: string[] = [], print = (text: string): void => { logs.push(text); };
  const value = "\xe9".repeat(5000);
  expect(infoSetValueForKeyBig("\\a\\first\\k\\old", "k", value, print)).toBe(`\\a\\first\\k\\${value}`);
  expect(infoSetValueForKeyBig("\\a\\first", "k", "x".repeat(9000), print)).toBe("\\a\\first");
  expect(logs).toEqual(["Com_sprintf: overflow of 9003 in 8192\n", "BIG Info string length exceeded\n"]);
  expect(() => infoSetValueForKeyBig("x".repeat(8192), "k", "v", print)).toThrow("oversize");
});
