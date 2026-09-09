/*
 * QVM image decoding translated from Quake III Arena's qfiles.h, vm_local.h,
 * vm.c VM_Create/VM_Restart and vm_interpreted.c VM_PrepareInterpreter.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BinaryError, BinaryReader } from "../core/binary.ts";

const QVM_MAGIC = 0x12721444;
const HEADER_LENGTH = 32;
// The source allocation and next-power-of-two loop use positive signed ints.
const MAX_DATA_LENGTH = 0x40000000;
const MAX_CODE_LENGTH = 0x1fffffff;

export enum QvmOpcode {
  OP_UNDEF, OP_IGNORE, OP_BREAK,
  OP_ENTER, OP_LEAVE, OP_CALL, OP_PUSH, OP_POP,
  OP_CONST, OP_LOCAL, OP_JUMP,
  OP_EQ, OP_NE, OP_LTI, OP_LEI, OP_GTI, OP_GEI,
  OP_LTU, OP_LEU, OP_GTU, OP_GEU,
  OP_EQF, OP_NEF, OP_LTF, OP_LEF, OP_GTF, OP_GEF,
  OP_LOAD1, OP_LOAD2, OP_LOAD4, OP_STORE1, OP_STORE2, OP_STORE4,
  OP_ARG, OP_BLOCK_COPY, OP_SEX8, OP_SEX16,
  OP_NEGI, OP_ADD, OP_SUB, OP_DIVI, OP_DIVU, OP_MODI, OP_MODU,
  OP_MULI, OP_MULU, OP_BAND, OP_BOR, OP_BXOR, OP_BCOM,
  OP_LSH, OP_RSHI, OP_RSHU, OP_NEGF, OP_ADDF, OP_SUBF,
  OP_DIVF, OP_MULF, OP_CVIF, OP_CVFI,
}

type BranchOpcode =
  | QvmOpcode.OP_EQ | QvmOpcode.OP_NE
  | QvmOpcode.OP_LTI | QvmOpcode.OP_LEI | QvmOpcode.OP_GTI | QvmOpcode.OP_GEI
  | QvmOpcode.OP_LTU | QvmOpcode.OP_LEU | QvmOpcode.OP_GTU | QvmOpcode.OP_GEU
  | QvmOpcode.OP_EQF | QvmOpcode.OP_NEF
  | QvmOpcode.OP_LTF | QvmOpcode.OP_LEF | QvmOpcode.OP_GTF | QvmOpcode.OP_GEF;

type WordOpcode = BranchOpcode
  | QvmOpcode.OP_ENTER | QvmOpcode.OP_LEAVE | QvmOpcode.OP_CONST
  | QvmOpcode.OP_LOCAL | QvmOpcode.OP_BLOCK_COPY;

type SingleByteOpcode = Exclude<QvmOpcode, WordOpcode | QvmOpcode.OP_ARG>;

interface InstructionLocation {
  /** Offset from codeOffset, also the source interpreter's program counter. */
  readonly byteOffset: number;
}

export type QvmInstruction = InstructionLocation & (
  | { readonly opcode: SingleByteOpcode; readonly operandWidth: 0 }
  | { readonly opcode: WordOpcode; readonly operandWidth: 4; readonly operand: number }
  | { readonly opcode: QvmOpcode.OP_ARG; readonly operandWidth: 1; readonly operand: number }
);

export interface QvmDataImage {
  /** Owned initialized data followed by literals. Words retain little-endian bytes. */
  readonly initializedData: Uint8Array;
  /** Includes zero-filled BSS and padding; the parser does not allocate either. */
  readonly allocatedDataLength: number;
}

export interface QvmImage extends QvmDataImage {
  readonly source: string;
  readonly instructions: readonly QvmInstruction[];
  readonly codeOffset: number;
  readonly codeLength: number;
  readonly dataLength: number;
  readonly literalLength: number;
  readonly bssLength: number;
  readonly dataMask: number;
}

/** The source frees its VM only for these header failures. */
export class QvmHeaderError extends Error {
  constructor(source: string) { super(`${source} has bad header`); this.name = "QvmHeaderError"; }
}

interface QvmSourceHeader {
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly literalLength: number;
  readonly bssLength: number;
}

/** VM_Create and VM_Restart share these source header checks before allocating or copying data. */
export function readQvmSourceHeader(bytes: Uint8Array, source: string): QvmSourceHeader {
  const reader = new BinaryReader(bytes, source);
  const magic = reader.i32();
  reader.skip(8);
  const codeLength = reader.i32(), dataOffset = reader.i32();
  const dataLength = reader.i32(), literalLength = reader.i32(), bssLength = reader.i32();
  if (magic !== QVM_MAGIC || bssLength < 0 || dataLength < 0 || literalLength < 0 || codeLength <= 0) {
    throw new QvmHeaderError(source);
  }
  return { dataOffset, dataLength, literalLength, bssLength };
}

/** VM_Restart retains prepared code and never consumes the replacement instruction table. */
export function parseQvmRestart(bytes: Uint8Array, source = "<qvm>"): QvmDataImage {
  const { dataOffset, dataLength, literalLength, bssLength } = readQvmSourceHeader(bytes, source);
  const initializedLength = dataLength + literalLength, totalDataLength = initializedLength + bssLength;
  if (totalDataLength > MAX_DATA_LENGTH) {
    throw new BinaryError(source, 28, "QVM data exceeds positive signed power-of-two allocation range");
  }
  let allocatedDataLength = 1;
  while (allocatedDataLength < totalDataLength) allocatedDataLength *= 2;
  const reader = new BinaryReader(bytes, source);
  reader.seek(dataOffset);
  return { initializedData: reader.bytes(initializedLength), allocatedDataLength };
}

function decodeInstruction(
  reader: BinaryReader, codeOffset: number, codeEnd: number, instructionCount: number,
): QvmInstruction {
  const byteOffset = reader.offset - codeOffset;
  if (reader.offset >= codeEnd) {
    throw new BinaryError(reader.source, reader.offset, "QVM instruction exceeds code section");
  }
  const opcode = reader.u8();
  switch (opcode) {
    case QvmOpcode.OP_EQ: case QvmOpcode.OP_NE:
    case QvmOpcode.OP_LTI: case QvmOpcode.OP_LEI: case QvmOpcode.OP_GTI: case QvmOpcode.OP_GEI:
    case QvmOpcode.OP_LTU: case QvmOpcode.OP_LEU: case QvmOpcode.OP_GTU: case QvmOpcode.OP_GEU:
    case QvmOpcode.OP_EQF: case QvmOpcode.OP_NEF:
    case QvmOpcode.OP_LTF: case QvmOpcode.OP_LEF: case QvmOpcode.OP_GTF: case QvmOpcode.OP_GEF: {
      const operand = readWord(reader, codeEnd);
      // Source preparation rewrites these indices to byte offsets. Keep indices
      // here; CALL/JUMP get their dynamic indices from the operand stack instead.
      if (operand < 0 || operand >= instructionCount) {
        throw new BinaryError(reader.source, reader.offset - 4, `QVM branch target ${operand} outside instruction table`);
      }
      return { opcode, byteOffset, operandWidth: 4, operand };
    }
    case QvmOpcode.OP_ENTER: case QvmOpcode.OP_LEAVE: case QvmOpcode.OP_CONST:
    case QvmOpcode.OP_LOCAL: case QvmOpcode.OP_BLOCK_COPY:
      return { opcode, byteOffset, operandWidth: 4, operand: readWord(reader, codeEnd) };
    case QvmOpcode.OP_ARG:
      if (reader.offset >= codeEnd) {
        throw new BinaryError(reader.source, reader.offset, "QVM byte operand exceeds code section");
      }
      return { opcode, byteOffset, operandWidth: 1, operand: reader.u8() };
    case QvmOpcode.OP_UNDEF: case QvmOpcode.OP_IGNORE: case QvmOpcode.OP_BREAK:
    case QvmOpcode.OP_CALL: case QvmOpcode.OP_PUSH: case QvmOpcode.OP_POP: case QvmOpcode.OP_JUMP:
    case QvmOpcode.OP_LOAD1: case QvmOpcode.OP_LOAD2: case QvmOpcode.OP_LOAD4:
    case QvmOpcode.OP_STORE1: case QvmOpcode.OP_STORE2: case QvmOpcode.OP_STORE4:
    case QvmOpcode.OP_SEX8: case QvmOpcode.OP_SEX16: case QvmOpcode.OP_NEGI:
    case QvmOpcode.OP_ADD: case QvmOpcode.OP_SUB: case QvmOpcode.OP_DIVI: case QvmOpcode.OP_DIVU:
    case QvmOpcode.OP_MODI: case QvmOpcode.OP_MODU: case QvmOpcode.OP_MULI: case QvmOpcode.OP_MULU:
    case QvmOpcode.OP_BAND: case QvmOpcode.OP_BOR: case QvmOpcode.OP_BXOR: case QvmOpcode.OP_BCOM:
    case QvmOpcode.OP_LSH: case QvmOpcode.OP_RSHI: case QvmOpcode.OP_RSHU:
    case QvmOpcode.OP_NEGF: case QvmOpcode.OP_ADDF: case QvmOpcode.OP_SUBF:
    case QvmOpcode.OP_DIVF: case QvmOpcode.OP_MULF: case QvmOpcode.OP_CVIF: case QvmOpcode.OP_CVFI:
      return { opcode, byteOffset, operandWidth: 0 };
    default:
      throw new BinaryError(reader.source, reader.offset - 1, `unknown QVM opcode ${opcode}`);
  }
}

function readWord(reader: BinaryReader, codeEnd: number): number {
  if (reader.offset > codeEnd - 4) {
    throw new BinaryError(reader.source, reader.offset, "QVM word operand exceeds code section");
  }
  return reader.i32();
}

function checkSection(reader: BinaryReader, offset: number, length: number, fieldOffset: number): void {
  if (offset < HEADER_LENGTH || length < 0 || offset > reader.length - length) {
    throw new BinaryError(reader.source, fieldOffset, `invalid QVM section at ${offset} with length ${length}`);
  }
}

/** Decode the pinned 1.32b format. Execution and syscall dispatch belong to the VM owner. */
export function parseQvm(bytes: Uint8Array, source = "<qvm>"): QvmImage {
  const reader = new BinaryReader(bytes, source);
  if (reader.i32() !== QVM_MAGIC) throw new BinaryError(source, 0, "invalid QVM magic");
  const instructionCount = reader.i32();
  const codeOffset = reader.i32();
  const codeLength = reader.i32();
  const dataOffset = reader.i32();
  const dataLength = reader.i32();
  const literalLength = reader.i32();
  const bssLength = reader.i32();
  if (codeLength <= 0 || codeLength > MAX_CODE_LENGTH) {
    throw new BinaryError(source, 12, "QVM code length outside source allocation range");
  }
  if (instructionCount <= 0 || instructionCount > codeLength) {
    throw new BinaryError(source, 4, "QVM instruction count outside code bounds");
  }
  if (dataLength < 0 || dataLength % 4 !== 0) {
    throw new BinaryError(source, 20, "QVM data length must contain complete words");
  }
  if (literalLength < 0) throw new BinaryError(source, 24, "negative QVM literal length");
  if (bssLength < 0) throw new BinaryError(source, 28, "negative QVM BSS length");
  const initializedLength = dataLength + literalLength;
  const totalDataLength = initializedLength + bssLength;
  if (totalDataLength > MAX_DATA_LENGTH) {
    throw new BinaryError(source, 28, "QVM data exceeds positive signed power-of-two allocation range");
  }
  checkSection(reader, codeOffset, codeLength, 8);
  checkSection(reader, dataOffset, initializedLength, 16);
  if (initializedLength > 0 && codeOffset < dataOffset + initializedLength && dataOffset < codeOffset + codeLength) {
    throw new BinaryError(source, 16, "QVM code and initialized data sections overlap");
  }
  let allocatedDataLength = 1;
  while (allocatedDataLength < totalDataLength) allocatedDataLength *= 2;
  reader.seek(codeOffset);
  const instructions: QvmInstruction[] = [];
  for (let index = 0; index < instructionCount; index++) {
    instructions.push(decodeInstruction(reader, codeOffset, codeOffset + codeLength, instructionCount));
  }
  // q3asm aligns the code section to four bytes. Like VM_PrepareInterpreter,
  // decode only instructionCount instructions, leaving the remaining bytes inert.
  reader.seek(dataOffset);
  const initializedData = reader.bytes(initializedLength);
  return {
    source, instructions, codeOffset, codeLength, initializedData,
    dataLength, literalLength, bssLength, allocatedDataLength,
    dataMask: allocatedDataLength - 1,
  };
}
