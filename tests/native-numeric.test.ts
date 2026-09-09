import { describe, expect, test } from "bun:test";
import { nativeAtoi } from "../src/core/native-numeric.ts";

// Standalone i386 glibc oracle: gcc -m32 -O2 -DNDEBUG, captured by
// /tmp/quake3-native-atoi-oracle.c (sha256 346fbad6c4ca0c5ad84a9db25bb913afe2f81a08a4adc5cb8783eb20c8513270).
describe("native i386 atoi", () => {
  test("matches the fixed decimal and overflow corpus", () => {
    const cases: readonly (readonly [string, number])[] = [
      ["", 0], ["0", 0], ["-0", 0], ["+12tail", 12], ["  -42x", -42],
      ["\t\n\v\f\r 17", 17], ["++1", 0], ["+-1", 0],
      ["2147483646", 2147483646], ["2147483647", 2147483647], ["2147483648", 2147483647],
      ["999999999999999999999999999999999999999", 2147483647],
      ["-2147483647", -2147483647], ["-2147483648", -2147483648], ["-2147483649", -2147483648],
      ["-999999999999999999999999999999999999999", -2147483648],
      ["00123", 123], [".5", 0], ["  +", 0], ["123 456", 123], ["4294967295", 2147483647],
    ];
    for (const [input, expected] of cases) expect(nativeAtoi(input)).toBe(expected);
    expect(Object.is(nativeAtoi("-0"), -0)).toBe(false);
  });

  test("uses the C locale whitespace set and stops at the first NUL", () => {
    for (let byte = 9; byte <= 13; byte++) expect(nativeAtoi(String.fromCharCode(byte) + "27")).toBe(27);
    expect(nativeAtoi(" 27")).toBe(27);
    for (const byte of [1, 8, 14, 31, 127, 160, 255]) expect(nativeAtoi(String.fromCharCode(byte) + "27")).toBe(0);
    expect(nativeAtoi("12\0" + "999999999999999999999")).toBe(12);
  });

  test("rejects external Unicode instead of narrowing it to a source byte", () => {
    expect(() => nativeAtoi("12Ā")).toThrow("Native numbers require byte characters");
    expect(() => nativeAtoi("1\0☃")).toThrow("Native numbers require byte characters");
  });
});
