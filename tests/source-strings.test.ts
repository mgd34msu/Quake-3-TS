import { describe, expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import {
  qCleanStr, qIsalpha, qIslower, qIsprint, qIsupper, qPrintStrlen,
  qStrcat, qStricmp, qStricmpn, qStrlwr, qStrncmp, qStrncpyz, qStrrchr, qStrupr,
} from "../src/core/source-strings.ts";

describe("q_shared.c byte strings", () => {
  test("character predicates retain ASCII bounds and numeric results", () => {
    for (let byte = -128; byte <= 256; byte++) {
      expect(qIsprint(byte)).toBe(byte >= 32 && byte <= 126 ? 1 : 0);
      expect(qIslower(byte)).toBe(byte >= 97 && byte <= 122 ? 1 : 0);
      expect(qIsupper(byte)).toBe(byte >= 65 && byte <= 90 ? 1 : 0);
      expect(qIsalpha(byte)).toBe(byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 ? 1 : 0);
    }
  });

  test("last match returns the source byte offset and converts its character to char", () => {
    const bytes = Uint8Array.of(97, 255, 97, 255, 0, 97);
    expect(qStrrchr(bytes, -1)).toBe(3);
    expect(qStrrchr(bytes, 353)).toBe(2);
    expect(qStrrchr(bytes, 256)).toBe(4);
    expect(qStrrchr(bytes, 98)).toBeNull();
    expect(qStrrchr("abc\0a", 97)).toBe(0);
    expect(qStrrchr("", 0)).toBe(0);
  });

  test("NULL comparison cases differ between bounded and unbounded source functions", () => {
    const unread = (): number => { throw new Error("unexpected read"); };
    expect(qStricmpn(null, null, 5)).toBe(0);
    expect(qStricmpn(null, unread, 5)).toBe(-1);
    expect(qStricmpn(unread, null, 5)).toBe(1);
    expect(qStricmp(null, null)).toBe(-1);
    expect(qStricmp(null, unread)).toBe(-1);
    expect(qStricmp(unread, null)).toBe(-1);
  });

  test("comparisons use signed bytes, ASCII folding, NUL and source limit", () => {
    expect(qStricmp("abc", "ABC")).toBe(0);
    expect(qStrncmp("abc", "ABC", 3)).toBe(1);
    expect(qStricmp("\xff", "a")).toBe(-1);
    expect(qStrncmp("\xff", "", 1)).toBe(-1);
    expect(qStricmp("\xe0", "\xc0")).toBe(1);
    expect(qStricmp("ab\0unread", "AB")).toBe(0);
    expect(qStricmpn("abc", "abx", 2)).toBe(0);
    expect(qStricmpn("abc", "abx", -1)).toBe(-1);
    expect(qStrncmp("ab", "ab", -1)).toBe(0);
    const prefix = "x".repeat(99999);
    expect(qStricmp(`${prefix}a`, `${prefix}b`)).toBe(0);
  });

  test("bounded comparison reads both bytes before the count and stops on mismatch", () => {
    for (const compare of [qStricmpn, qStrncmp]) {
      const reads: string[] = [];
      const left = (index: number): number => { reads.push(`a${index}`); return 97; };
      const right = (index: number): number => { reads.push(`b${index}`); return 98; };
      expect(compare(left, right, 0)).toBe(0);
      expect(reads).toEqual(["a0", "b0"]);
      reads.length = 0;
      expect(compare(left, right, 100)).toBe(-1);
      expect(reads).toEqual(["a0", "b0"]);
      expect(() => compare(new Uint8Array(), "", 0)).toThrow(RangeError);
    }
    expect(qStricmp("a\u0100", "b")).toBe(-1);
  });

  test("copy pads exactly the retained destination capacity and truncates without reading the tail", () => {
    const allocation = new Uint8Array(9).fill(77);
    const destination = allocation.subarray(2);
    qStrncpyz(destination, "ab\0\u0100", 5);
    expect([...allocation]).toEqual([77, 77, 97, 98, 0, 0, 0, 77, 77]);
    qStrncpyz(destination, "xyz\u0100", 4);
    expect([...allocation]).toEqual([77, 77, 120, 121, 122, 0, 0, 77, 77]);
    qStrncpyz(destination, (): number => { throw new Error("unexpected read"); }, 1);
    expect(allocation[2]).toBe(0);
    expect(allocation[3]).toBe(121);
  });

  test("copy reports source fatal errors in order", () => {
    const destination = new Uint8Array(2);
    for (const [operation, message] of [
      [() => qStrncpyz(null, null, 0), "Q_strncpyz: NULL dest"],
      [() => qStrncpyz(destination, null, 0), "Q_strncpyz: NULL src"],
      [() => qStrncpyz(destination, "", 0), "Q_strncpyz: destsize < 1"],
    ] satisfies readonly (readonly [() => void, string])[]) {
      try { operation(); throw new Error("missing fatal error"); }
      catch (error) {
        expect(error).toBeInstanceOf(CommonError);
        if (!(error instanceof CommonError)) throw error;
        expect(error.code).toBe("fatal");
        expect(error.message).toBe(message);
      }
    }
    expect(() => qStrncpyz(destination, "abc", 3)).toThrow(RangeError);
    expect([...destination]).toEqual([0, 0]);
  });

  test("append scans existing text first and pads only the remaining capacity", () => {
    const bytes = Uint8Array.of(97, 98, 0, 77, 77, 77, 77, 77);
    qStrcat(bytes, 7, "c");
    expect([...bytes]).toEqual([97, 98, 99, 0, 0, 0, 0, 77]);
    qStrcat(bytes, 5, "defg");
    expect([...bytes]).toEqual([97, 98, 99, 100, 0, 0, 0, 77]);
    expect(() => qStrcat(bytes, 4, null)).toThrow("Q_strcat: already overflowed");
    expect(() => qStrcat(bytes, 5, null)).toThrow("Q_strncpyz: NULL src");
  });

  test("case mutation retains allocation identity, high bytes, and bytes after NUL", () => {
    const text = Uint8Array.of(65, 90, 97, 122, 192, 224, 0, 65);
    expect(qStrlwr(text)).toBe(text);
    expect([...text]).toEqual([97, 122, 97, 122, 192, 224, 0, 65]);
    expect(qStrupr(text)).toBe(text);
    expect([...text]).toEqual([65, 90, 65, 90, 192, 224, 0, 65]);
  });

  test("color recognition includes non-digit codes and preserves doubled escape overlap", () => {
    expect(qPrintStrlen(null)).toBe(0);
    expect(qPrintStrlen("a^1b^xc\t\xff^\0tail")).toBe(6);
    expect(qPrintStrlen("^^1x")).toBe(2);
    expect(qPrintStrlen("^^")).toBe(2);
    const text = Uint8Array.of(97, 94, 49, 98, 9, 255, 94, 94, 49, 120, 94, 0, 77);
    expect(qCleanStr(text)).toBe(text);
    expect([...text]).toEqual([97, 98, 94, 120, 94, 0, 94, 94, 49, 120, 94, 0, 77]);
  });

  test("unterminated allocations reject at the reached read and retain earlier writes", () => {
    const text = Uint8Array.of(65, 66);
    expect(() => qStrlwr(text)).toThrow(RangeError);
    expect([...text]).toEqual([97, 98]);
    expect(() => qPrintStrlen(Uint8Array.of(94))).toThrow(RangeError);
    const destination = new Uint8Array(4).fill(77);
    expect(() => qStrncpyz(destination, Uint8Array.of(97), 4)).toThrow(RangeError);
    expect([...destination]).toEqual([97, 77, 77, 77]);
  });
});
