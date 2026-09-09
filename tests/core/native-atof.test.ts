import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { nativeAtof, nativeAtoi } from "../../src/core/native-numeric.ts";

// Reproducible native oracle: /tmp/quake3-native-atof-oracle-20260905-a/run.sh.
// gcc 16.2.1, glibc 2.44, both -m32 i386 and -m64 x86-64 outputs matched.
// Fixture SHA-256: 78d4bc33d595cf27dbb24c7ec9bebc32f00202b7087b541d2ac764e8acad457d.
function doubleBits(value: number): string {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

function floatBits(value: number): string {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, false);
  return view.getUint32(0, false).toString(16).padStart(8, "0");
}

function corpusHash(): string {
  let state = 0x51a7f00d;
  function next(): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  }

  const bytes = new Uint8Array(1024 * 8);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 512; index++) {
    const whole = next() % 1_000_000_000;
    const fraction = next() % 100_000_000;
    const exponent = next() % 601 - 300;
    const negative = (next() & 1) !== 0;
    const text = `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(8, "0")}e${exponent}trail`;
    view.setFloat64(index * 8, nativeAtof(text), true);
  }
  for (let index = 0; index < 512; index++) {
    const whole = next();
    const fraction = next();
    const exponent = next() % 2201 - 1100;
    const negative = (next() & 1) !== 0;
    const text = `${negative ? "-" : ""}0x${whole.toString(16)}.${fraction.toString(16).padStart(8, "0")}p${exponent}trail`;
    view.setFloat64((index + 512) * 8, nativeAtof(text), true);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

describe("native glibc atof", () => {
  test("matches the native decimal prefix and binary64 boundary corpus", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["", "0000000000000000"], [" ", "0000000000000000"],
      ["\t\n\v\f\r 1.5tail", "3ff8000000000000"],
      ["\x011.5", "0000000000000000"], ["\xa01.5", "0000000000000000"],
      ["\xff1.5", "0000000000000000"], ["+", "0000000000000000"],
      ["-", "0000000000000000"], [".", "0000000000000000"],
      ["+.e1", "0000000000000000"], ["0", "0000000000000000"],
      ["-0", "8000000000000000"], ["-0.0", "8000000000000000"],
      ["+12tail", "4028000000000000"], ["1.", "3ff0000000000000"],
      [".5", "3fe0000000000000"], ["1e2", "4059000000000000"],
      ["1e", "3ff0000000000000"], ["1e+", "3ff0000000000000"],
      ["1e-", "3ff0000000000000"], ["1e-2tail", "3f847ae147ae147b"],
      ["01.2300", "3ff3ae147ae147ae"], ["9007199254740993", "4340000000000000"],
      ["9007199254740995", "4340000000000002"],
      ["1.7976931348623157e308", "7fefffffffffffff"],
      ["1.7976931348623158e308", "7fefffffffffffff"],
      ["1.7976931348623159e308", "7ff0000000000000"],
      ["2.2250738585072014e-308", "0010000000000000"],
      ["2.2250738585072011e-308", "000fffffffffffff"],
      ["4.9406564584124654e-324", "0000000000000001"],
      ["2.4703282292062327e-324", "0000000000000000"],
      ["2.4703282292062328e-324", "0000000000000001"],
      ["1e999999999", "7ff0000000000000"], ["-1e999999999", "fff0000000000000"],
      ["1e-999999999", "0000000000000000"], ["-1e-999999999", "8000000000000000"],
      ["12.5\0ignored", "4029000000000000"],
    ];
    for (const [input, expected] of cases) expect(doubleBits(nativeAtof(input))).toBe(expected);
  });

  test("matches exact hexadecimal conversion, including absent and incomplete p exponents", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["0x1p+1", "4000000000000000"], ["0x1", "3ff0000000000000"],
      ["0x1.8", "3ff8000000000000"], ["0x1p", "3ff0000000000000"],
      ["0x1p+", "3ff0000000000000"], ["0x.8p0", "3fe0000000000000"],
      ["0x.p1", "0000000000000000"],
      ["0x1.fffffffffffffp1023", "7fefffffffffffff"],
      ["0x1.fffffffffffff8p1023", "7ff0000000000000"],
      ["0x1p1024", "7ff0000000000000"], ["0x1p-1022", "0010000000000000"],
      ["0x0.fffffffffffffp-1022", "000fffffffffffff"],
      ["0x1p-1074", "0000000000000001"], ["0x1p-1075", "0000000000000000"],
      ["0x1.0000000000001p-1075", "0000000000000001"],
      ["-0x1p-1075", "8000000000000000"],
      ["-0x1.0000000000001p-1075", "8000000000000001"],
      ["0x100000000000008p-56", "3ff0000000000000"],
      ["0x100000000000018p-56", "3ff0000000000002"],
    ];
    for (const [input, expected] of cases) expect(doubleBits(nativeAtof(input))).toBe(expected);
  });

  test("recognizes glibc infinity and NaN prefixes and payload spellings", () => {
    for (const input of ["inf", "INF", "infinity", "INFINITYtail", "infinite"]) {
      expect(nativeAtof(input)).toBe(Number.POSITIVE_INFINITY);
    }
    expect(nativeAtof("-inf")).toBe(Number.NEGATIVE_INFINITY);
    for (const input of [
      "nan", "NAN", "-nan", "nan()", "nan(foo)", "nan(foo_bar9)", "nan(foo!)", "nan(",
      "nan(123)", "nan(010)", "nan(0x123)", "nan(123abc)", "nan(_123)",
      "nan(0xfffffffffffff)", "nan(0x10000000000000)",
      "nan(18446744073709551615)", "nan(18446744073709551616)", "-nan(0x123)",
    ]) expect(Number.isNaN(nativeAtof(input))).toBe(true);
  });

  test("matches the deterministic native decimal and hexadecimal corpus", () => {
    expect(corpusHash()).toBe("67fc561ae94e99b0fab69ceff8fd8bddc25f9cf14863904ce342cd7c30d9986d");
  });

  test("matches native float32 storage after double parsing", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["0x1p+1", "40000000"], ["-0x1p-1075", "80000000"],
      ["1.000000059604644775390625", "3f800000"],
      ["1.000000059604644775390626", "3f800000"],
      ["3.4028234663852886e38", "7f7fffff"], ["3.4028235677973366e38", "7f800000"],
      ["1.401298464324817e-45", "00000001"],
      ["7.006492321624085e-46", "00000000"], ["7.006492321624086e-46", "00000000"],
      ["inf", "7f800000"],
    ];
    for (const [input, expected] of cases) expect(floatBits(Math.fround(nativeAtof(input)))).toBe(expected);
    expect(Number.isNaN(Math.fround(nativeAtof("nan")))).toBe(true);
  });

  test("rejects non-byte input without changing nativeAtoi", () => {
    expect(() => nativeAtof("12Ā")).toThrow("Native numbers require byte characters");
    expect(() => nativeAtof("1\0☃")).toThrow("Native numbers require byte characters");
    expect(nativeAtoi("4294967295")).toBe(2147483647);
    expect(nativeAtoi("-999999999999999999999999999999999")).toBe(-2147483648);
  });
});
