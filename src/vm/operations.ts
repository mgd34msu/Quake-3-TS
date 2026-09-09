/*
 * QVM arithmetic and branch conditions translated from Quake III Arena's
 * qcommon/vm_interpreted.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { QvmOpcode } from "../assets/qvm.ts";
import { bitsToFloat32, float32ToBits, qvmFloatToInt } from "../core/numeric.ts";

export type QvmUnaryOpcode =
  | QvmOpcode.OP_SEX8 | QvmOpcode.OP_SEX16 | QvmOpcode.OP_NEGI
  | QvmOpcode.OP_NEGF | QvmOpcode.OP_CVIF | QvmOpcode.OP_CVFI;

export type QvmBinaryOpcode =
  | QvmOpcode.OP_ADD | QvmOpcode.OP_SUB
  | QvmOpcode.OP_DIVI | QvmOpcode.OP_DIVU | QvmOpcode.OP_MODI | QvmOpcode.OP_MODU
  | QvmOpcode.OP_MULI | QvmOpcode.OP_MULU
  | QvmOpcode.OP_BAND | QvmOpcode.OP_BOR | QvmOpcode.OP_BXOR
  | QvmOpcode.OP_LSH | QvmOpcode.OP_RSHI | QvmOpcode.OP_RSHU
  | QvmOpcode.OP_ADDF | QvmOpcode.OP_SUBF | QvmOpcode.OP_DIVF | QvmOpcode.OP_MULF;

export type QvmBranchOpcode =
  | QvmOpcode.OP_EQ | QvmOpcode.OP_NE
  | QvmOpcode.OP_LTI | QvmOpcode.OP_LEI | QvmOpcode.OP_GTI | QvmOpcode.OP_GEI
  | QvmOpcode.OP_LTU | QvmOpcode.OP_LEU | QvmOpcode.OP_GTU | QvmOpcode.OP_GEU
  | QvmOpcode.OP_EQF | QvmOpcode.OP_NEF
  | QvmOpcode.OP_LTF | QvmOpcode.OP_LEF | QvmOpcode.OP_GTF | QvmOpcode.OP_GEF;

/** Operands and results are signed int32 words, including binary32 payloads. */
export function evaluateQvmUnary(opcode: QvmUnaryOpcode, word: number): number {
  switch (opcode) {
    case QvmOpcode.OP_SEX8: return (word << 24) >> 24;
    case QvmOpcode.OP_SEX16: return (word << 16) >> 16;
    case QvmOpcode.OP_NEGI: return -word | 0;
    case QvmOpcode.OP_NEGF: return float32ToBits(-bitsToFloat32(word)) | 0;
    case QvmOpcode.OP_CVIF: return float32ToBits(word) | 0;
    case QvmOpcode.OP_CVFI: return qvmFloatToInt(bitsToFloat32(word));
    default: {
      const unsupported: never = opcode;
      throw new Error(`Unsupported QVM unary opcode ${unsupported}`);
    }
  }
}

function shiftCount(word: number): number {
  if (word < 0 || word > 31) throw new RangeError("QVM shift count outside 0..31");
  return word;
}

/** Left is source r1 and right is r0. Integer overflow follows the wrap32 profile. */
export function evaluateQvmBinary(opcode: QvmBinaryOpcode, left: number, right: number): number {
  switch (opcode) {
    case QvmOpcode.OP_ADD: return (left + right) | 0;
    case QvmOpcode.OP_SUB: return (left - right) | 0;
    case QvmOpcode.OP_DIVI:
    case QvmOpcode.OP_MODI:
      if (right === 0) throw new RangeError("QVM integer division or modulo by zero");
      if (left === -2147483648 && right === -1) {
        throw new RangeError("QVM signed division or modulo overflow");
      }
      return (opcode === QvmOpcode.OP_DIVI ? left / right : left % right) | 0;
    case QvmOpcode.OP_DIVU:
    case QvmOpcode.OP_MODU:
      if (right === 0) throw new RangeError("QVM integer division or modulo by zero");
      return (opcode === QvmOpcode.OP_DIVU
        ? (left >>> 0) / (right >>> 0) : (left >>> 0) % (right >>> 0)) | 0;
    case QvmOpcode.OP_MULI:
    case QvmOpcode.OP_MULU: return Math.imul(left, right);
    case QvmOpcode.OP_BAND: return left & right;
    case QvmOpcode.OP_BOR: return left | right;
    case QvmOpcode.OP_BXOR: return left ^ right;
    case QvmOpcode.OP_LSH: return left << shiftCount(right);
    case QvmOpcode.OP_RSHI: return left >> shiftCount(right);
    case QvmOpcode.OP_RSHU: return (left >>> shiftCount(right)) | 0;
    case QvmOpcode.OP_ADDF: return float32ToBits(bitsToFloat32(left) + bitsToFloat32(right)) | 0;
    case QvmOpcode.OP_SUBF: return float32ToBits(bitsToFloat32(left) - bitsToFloat32(right)) | 0;
    case QvmOpcode.OP_DIVF: return float32ToBits(bitsToFloat32(left) / bitsToFloat32(right)) | 0;
    case QvmOpcode.OP_MULF: return float32ToBits(bitsToFloat32(left) * bitsToFloat32(right)) | 0;
    default: {
      const unsupported: never = opcode;
      throw new Error(`Unsupported QVM binary opcode ${unsupported}`);
    }
  }
}

/** Compare source r1 with r0; floating conditions use IEEE unordered comparisons. */
export function evaluateQvmBranch(opcode: QvmBranchOpcode, left: number, right: number): boolean {
  switch (opcode) {
    case QvmOpcode.OP_EQ: return left === right;
    case QvmOpcode.OP_NE: return left !== right;
    case QvmOpcode.OP_LTI: return left < right;
    case QvmOpcode.OP_LEI: return left <= right;
    case QvmOpcode.OP_GTI: return left > right;
    case QvmOpcode.OP_GEI: return left >= right;
    case QvmOpcode.OP_LTU: return (left >>> 0) < (right >>> 0);
    case QvmOpcode.OP_LEU: return (left >>> 0) <= (right >>> 0);
    case QvmOpcode.OP_GTU: return (left >>> 0) > (right >>> 0);
    case QvmOpcode.OP_GEU: return (left >>> 0) >= (right >>> 0);
    case QvmOpcode.OP_EQF: return bitsToFloat32(left) === bitsToFloat32(right);
    case QvmOpcode.OP_NEF: return bitsToFloat32(left) !== bitsToFloat32(right);
    case QvmOpcode.OP_LTF: return bitsToFloat32(left) < bitsToFloat32(right);
    case QvmOpcode.OP_LEF: return bitsToFloat32(left) <= bitsToFloat32(right);
    case QvmOpcode.OP_GTF: return bitsToFloat32(left) > bitsToFloat32(right);
    case QvmOpcode.OP_GEF: return bitsToFloat32(left) >= bitsToFloat32(right);
    default: {
      const unsupported: never = opcode;
      throw new Error(`Unsupported QVM branch opcode ${unsupported}`);
    }
  }
}
