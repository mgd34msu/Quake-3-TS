import { describe, expect, test } from "bun:test";
import { QvmOpcode } from "../src/assets/qvm.ts";
import {
  evaluateQvmBinary, evaluateQvmBranch, evaluateQvmUnary,
} from "../src/vm/operations.ts";
import type { QvmBinaryOpcode, QvmBranchOpcode } from "../src/vm/operations.ts";

describe("QVM word operations", () => {
  test("sign extends low bytes and shorts and wraps integer negation", () => {
    expect(evaluateQvmUnary(QvmOpcode.OP_SEX8, 0x12345680)).toBe(-128);
    expect(evaluateQvmUnary(QvmOpcode.OP_SEX8, -129)).toBe(127);
    expect(evaluateQvmUnary(QvmOpcode.OP_SEX16, 0x12348000)).toBe(-32768);
    expect(evaluateQvmUnary(QvmOpcode.OP_SEX16, -32769)).toBe(32767);
    expect(evaluateQvmUnary(QvmOpcode.OP_NEGI, 7)).toBe(-7);
    expect(evaluateQvmUnary(QvmOpcode.OP_NEGI, -2147483648)).toBe(-2147483648);
    expect(evaluateQvmUnary(QvmOpcode.OP_NEGI, 0)).toBe(0);
  });

  test("keeps exact low product bits, signed division and unsigned word interpretation", () => {
    const cases: readonly (readonly [QvmBinaryOpcode, number, number, number])[] = [
      [QvmOpcode.OP_ADD, 2147483647, 1, -2147483648],
      [QvmOpcode.OP_SUB, -2147483648, 1, 2147483647],
      [QvmOpcode.OP_MULI, 2147483647, 2147483647, 1],
      [QvmOpcode.OP_MULU, -1, -1, 1],
      [QvmOpcode.OP_DIVI, -7, 3, -2],
      [QvmOpcode.OP_DIVI, 7, -3, -2],
      [QvmOpcode.OP_MODI, -7, 3, -1],
      [QvmOpcode.OP_MODI, 7, -3, 1],
      [QvmOpcode.OP_MODI, -6, 3, 0],
      [QvmOpcode.OP_DIVU, -1, 2, 2147483647],
      [QvmOpcode.OP_DIVU, -1, 1, -1],
      [QvmOpcode.OP_DIVU, -1, -2147483648, 1],
      [QvmOpcode.OP_MODU, -1, 2, 1],
      [QvmOpcode.OP_MODU, -2147483648, -1, -2147483648],
      [QvmOpcode.OP_BAND, -1, 0x12345678, 0x12345678],
      [QvmOpcode.OP_BOR, -2147483648, 1, -2147483647],
      [QvmOpcode.OP_BXOR, -1, 0x12345678, -305419897],
      [QvmOpcode.OP_LSH, 1, 31, -2147483648],
      [QvmOpcode.OP_RSHI, -2147483648, 31, -1],
      [QvmOpcode.OP_RSHU, -2147483648, 31, 1],
      [QvmOpcode.OP_RSHU, -1, 0, -1],
    ];
    for (const [opcode, left, right, expected] of cases) {
      expect(evaluateQvmBinary(opcode, left, right)).toBe(expected);
    }
  });

  test("rejects undefined integer division, remainder and shift counts", () => {
    const divisions: readonly QvmBinaryOpcode[] = [
      QvmOpcode.OP_DIVI, QvmOpcode.OP_DIVU, QvmOpcode.OP_MODI, QvmOpcode.OP_MODU,
    ];
    for (const opcode of divisions) {
      expect(() => evaluateQvmBinary(opcode, 7, 0)).toThrow(RangeError);
    }
    const signedDivisions: readonly QvmBinaryOpcode[] = [QvmOpcode.OP_DIVI, QvmOpcode.OP_MODI];
    for (const opcode of signedDivisions) {
      expect(() => evaluateQvmBinary(opcode, -2147483648, -1)).toThrow(RangeError);
    }
    const shifts: readonly QvmBinaryOpcode[] = [QvmOpcode.OP_LSH, QvmOpcode.OP_RSHI, QvmOpcode.OP_RSHU];
    for (const opcode of shifts) {
      for (const count of [-1, 32, 256]) {
        expect(() => evaluateQvmBinary(opcode, 1, count)).toThrow(RangeError);
      }
    }
  });

  test("stores binary32 after each arithmetic operation, including cancellation", () => {
    const sum = evaluateQvmBinary(QvmOpcode.OP_ADDF, 0x4b800000, 0x3f800000);
    expect(sum).toBe(0x4b800000); // 16777216 + 1 rounds to 16777216.
    expect(evaluateQvmBinary(QvmOpcode.OP_SUBF, sum, 0x4b800000)).toBe(0);
    expect(evaluateQvmBinary(QvmOpcode.OP_SUBF, 0x3f800000, 0x40000000)).toBe(-1082130432);
    expect(evaluateQvmBinary(QvmOpcode.OP_DIVF, 0x3f800000, 0x40400000)).toBe(0x3eaaaaab);
    expect(evaluateQvmBinary(QvmOpcode.OP_MULF, 0x3fc00000, 0x40200000)).toBe(0x40700000);
    expect(evaluateQvmBinary(QvmOpcode.OP_DIVF, 0x3f800000, 0)).toBe(0x7f800000);
    expect(evaluateQvmBinary(QvmOpcode.OP_MULF, 0x7f7fffff, 0x40000000)).toBe(0x7f800000);
  });

  test("preserves negated zero and uses the existing CVFI conversion profile", () => {
    expect(evaluateQvmUnary(QvmOpcode.OP_NEGF, 0)).toBe(-2147483648);
    expect(evaluateQvmUnary(QvmOpcode.OP_NEGF, -2147483648)).toBe(0);
    expect(evaluateQvmUnary(QvmOpcode.OP_CVIF, 16777217)).toBe(0x4b800000);
    expect(evaluateQvmUnary(QvmOpcode.OP_CVIF, -1)).toBe(-1082130432);
    expect(evaluateQvmUnary(QvmOpcode.OP_CVFI, -1077936128)).toBe(-1); // -1.5
    expect(evaluateQvmUnary(QvmOpcode.OP_CVFI, -2147483648)).toBe(0); // -0
    expect(evaluateQvmUnary(QvmOpcode.OP_CVFI, 0x4effffff)).toBe(2147483520);
    for (const word of [0x4f000000, 0x7f800000, 0x7fc00000]) {
      expect(evaluateQvmUnary(QvmOpcode.OP_CVFI, word)).toBe(-2147483648);
    }
  });
});

describe("QVM conditional branches", () => {
  test("preserves signed and unsigned ordering with both branch outcomes", () => {
    const cases: readonly (readonly [QvmBranchOpcode, number, number])[] = [
      [QvmOpcode.OP_EQ, -1, -1], [QvmOpcode.OP_NE, -1, 1],
      [QvmOpcode.OP_LTI, -1, 1], [QvmOpcode.OP_LEI, -1, -1],
      [QvmOpcode.OP_GTI, 1, -1], [QvmOpcode.OP_GEI, -1, -1],
      [QvmOpcode.OP_LTU, 1, -1], [QvmOpcode.OP_LEU, -1, -1],
      [QvmOpcode.OP_GTU, -1, 1], [QvmOpcode.OP_GEU, -1, -1],
    ];
    for (const [opcode, left, right] of cases) {
      expect(evaluateQvmBranch(opcode, left, right)).toBe(true);
    }
    expect(evaluateQvmBranch(QvmOpcode.OP_EQ, 1, -1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_NE, -1, -1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_LTI, 1, -1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_LEI, 1, -1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_GTI, -1, 1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_GEI, -1, 1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_LTU, -1, 1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_LEU, -1, 1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_GTU, 1, -1)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_GEU, 1, -1)).toBe(false);
  });

  test("compares float values, equal signed zeroes and unordered NaNs", () => {
    const ordered: readonly QvmBranchOpcode[] = [
      QvmOpcode.OP_EQF, QvmOpcode.OP_LTF, QvmOpcode.OP_LEF, QvmOpcode.OP_GTF, QvmOpcode.OP_GEF,
    ];
    for (const opcode of ordered) {
      expect(evaluateQvmBranch(opcode, 0x7fc00000, 0x3f800000)).toBe(false);
      expect(evaluateQvmBranch(opcode, 0x3f800000, 0x7fc00000)).toBe(false);
    }
    expect(evaluateQvmBranch(QvmOpcode.OP_NEF, 0x7fc00000, 0x7fc00000)).toBe(true);
    expect(evaluateQvmBranch(QvmOpcode.OP_EQF, 0, -2147483648)).toBe(true);
    expect(evaluateQvmBranch(QvmOpcode.OP_NEF, 0, -2147483648)).toBe(false);
    expect(evaluateQvmBranch(QvmOpcode.OP_LTF, -1082130432, 0)).toBe(true);
    expect(evaluateQvmBranch(QvmOpcode.OP_LEF, 0, -2147483648)).toBe(true);
    expect(evaluateQvmBranch(QvmOpcode.OP_GTF, 0, -1082130432)).toBe(true);
    expect(evaluateQvmBranch(QvmOpcode.OP_GEF, -2147483648, 0)).toBe(true);
  });
});
