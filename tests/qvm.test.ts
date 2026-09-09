import { describe, expect, test } from "bun:test";
import { QvmHeaderError, QvmOpcode, parseQvm, parseQvmRestart } from "../src/assets/qvm.ts";
import { BinaryError, BinaryWriter } from "../src/core/binary.ts";

interface FixtureOptions {
  readonly data?: Uint8Array;
  readonly literals?: Uint8Array;
  readonly bssLength?: number;
  readonly padding?: Uint8Array;
}

function fixture(code: readonly number[], instructionCount: number, options: FixtureOptions = {}): Uint8Array {
  const data = options.data ?? new Uint8Array();
  const literals = options.literals ?? new Uint8Array();
  const padding = options.padding ?? new Uint8Array();
  const codeLength = code.length + padding.length;
  const writer = new BinaryWriter(32 + codeLength + data.length + literals.length);
  for (const word of [0x12721444, instructionCount, 32, codeLength, 32 + codeLength,
    data.length, literals.length, options.bssLength ?? 0]) writer.i32(word);
  writer.bytes(new Uint8Array(code));
  writer.bytes(padding);
  writer.bytes(data);
  writer.bytes(literals);
  return writer.finish();
}

function changeHeader(bytes: Uint8Array, fieldOffset: number, value: number): Uint8Array {
  const changed = bytes.slice();
  new DataView(changed.buffer).setInt32(fieldOffset, value, true);
  return changed;
}

test("QVM restart reads only source header checks and initialized data", () => {
  const bytes = fixture([255], 0, { data: new Uint8Array([7, 8, 9]), literals: new Uint8Array([10]), bssLength: 5 });
  const image = parseQvmRestart(changeHeader(changeHeader(bytes, 8, -1), 12, 0x7fffffff));
  expect(image.initializedData).toEqual(new Uint8Array([7, 8, 9, 10]));
  expect(image.allocatedDataLength).toBe(16);
  for (const [offset, value] of [[0, 0], [12, 0], [12, -1], [20, -1], [24, -1], [28, -1]] satisfies readonly (readonly [number, number])[]) {
    expect(() => parseQvmRestart(changeHeader(bytes, offset, value), "vm/qagame.qvm"))
      .toThrow(new QvmHeaderError("vm/qagame.qvm"));
  }
  expect(() => parseQvmRestart(bytes.subarray(0, 31))).toThrow(BinaryError);
  expect(() => parseQvmRestart(changeHeader(bytes, 16, bytes.length))).toThrow(BinaryError);
  expect(() => parseQvmRestart(changeHeader(bytes, 28, 0x40000000))).toThrow(BinaryError);
});

describe("QVM image decoding", () => {
  test("preserves every source opcode's numeric order", () => {
    const names = [
      "OP_UNDEF", "OP_IGNORE", "OP_BREAK", "OP_ENTER", "OP_LEAVE", "OP_CALL", "OP_PUSH", "OP_POP",
      "OP_CONST", "OP_LOCAL", "OP_JUMP", "OP_EQ", "OP_NE", "OP_LTI", "OP_LEI", "OP_GTI", "OP_GEI",
      "OP_LTU", "OP_LEU", "OP_GTU", "OP_GEU", "OP_EQF", "OP_NEF", "OP_LTF", "OP_LEF", "OP_GTF", "OP_GEF",
      "OP_LOAD1", "OP_LOAD2", "OP_LOAD4", "OP_STORE1", "OP_STORE2", "OP_STORE4", "OP_ARG", "OP_BLOCK_COPY",
      "OP_SEX8", "OP_SEX16", "OP_NEGI", "OP_ADD", "OP_SUB", "OP_DIVI", "OP_DIVU", "OP_MODI", "OP_MODU",
      "OP_MULI", "OP_MULU", "OP_BAND", "OP_BOR", "OP_BXOR", "OP_BCOM", "OP_LSH", "OP_RSHI", "OP_RSHU",
      "OP_NEGF", "OP_ADDF", "OP_SUBF", "OP_DIVF", "OP_MULF", "OP_CVIF", "OP_CVFI",
    ];
    expect(names.length).toBe(60);
    names.forEach((name, opcode) => expect(QvmOpcode[opcode]).toBe(name));
  });

  test("decodes all operand widths and code-relative byte offsets", () => {
    const code: number[] = [];
    const offsets: number[] = [];
    for (let opcode = 0; opcode < 60; opcode++) {
      offsets.push(code.length);
      code.push(opcode);
      if (opcode >= 11 && opcode <= 26) code.push(59, 0, 0, 0);
      else if ([3, 4, 8, 9, 34].includes(opcode)) code.push(0x00, 0x00, 0x00, 0x80);
      else if (opcode === 33) code.push(255);
    }
    const image = parseQvm(fixture(code, 60), "all-opcodes.qvm");
    expect(image.instructions.length).toBe(60);
    image.instructions.forEach((instruction, opcode) => {
      const byteOffset = offsets[opcode];
      if (byteOffset === undefined) throw new Error("missing opcode offset fixture");
      expect(instruction.opcode).toBe(opcode);
      expect(instruction.byteOffset).toBe(byteOffset);
      if (opcode >= 11 && opcode <= 26) {
        expect(instruction).toMatchObject({ operandWidth: 4, operand: 59 });
      } else if ([3, 4, 8, 9, 34].includes(opcode)) {
        expect(instruction).toMatchObject({ operandWidth: 4, operand: -0x80000000 });
      } else if (opcode === 33) {
        expect(instruction).toMatchObject({ operandWidth: 1, operand: 255 });
      } else {
        expect(instruction.operandWidth).toBe(0);
        expect("operand" in instruction).toBe(false);
      }
    });
  });

  test("copies little-endian initialized words and literals without allocating BSS", () => {
    const bytes = fixture([2], 1, {
      data: new Uint8Array([0x78, 0x56, 0x34, 0x12]),
      literals: new Uint8Array([65, 66, 0]), bssLength: 10,
    });
    const image = parseQvm(bytes, "data.qvm");
    expect(image.source).toBe("data.qvm");
    expect(image.dataLength).toBe(4);
    expect(image.literalLength).toBe(3);
    expect(image.bssLength).toBe(10);
    expect(image.allocatedDataLength).toBe(32);
    expect(image.dataMask).toBe(31);
    bytes.fill(0);
    expect(image.initializedData).toEqual(new Uint8Array([0x78, 0x56, 0x34, 0x12, 65, 66, 0]));
    expect(new DataView(image.initializedData.buffer).getInt32(0, true)).toBe(0x12345678);
  });

  test("computes zero, exact-power and largest source allocation boundaries", () => {
    const cases: readonly (readonly [number, number])[] = [
      [0, 1], [1, 1], [2, 2], [3, 4], [32, 32], [33, 64], [0x40000000, 0x40000000],
    ];
    for (const [bssLength, allocated] of cases) {
      const image = parseQvm(fixture([2], 1, { bssLength }));
      expect(image.allocatedDataLength).toBe(allocated);
      expect(image.dataMask).toBe(allocated - 1);
      expect(image.initializedData.length).toBe(0);
    }
  });

  test("decodes from a nonzero buffer offset and ignores source code alignment bytes", () => {
    const original = fixture([8, 0xff, 0xff, 0xff, 0xff, 5], 2, { padding: new Uint8Array([0, 0]) });
    const wrapped = new Uint8Array(original.length + 11);
    wrapped.set(original, 7);
    const image = parseQvm(wrapped.subarray(7, 7 + original.length));
    expect(image.codeOffset).toBe(32);
    expect(image.codeLength).toBe(8);
    expect(image.instructions).toEqual([
      { opcode: QvmOpcode.OP_CONST, byteOffset: 0, operandWidth: 4, operand: -1 },
      { opcode: QvmOpcode.OP_CALL, byteOffset: 5, operandWidth: 0 },
    ]);
  });

  test("leaves dynamic CALL and JUMP constants for execution-time validation", () => {
    const image = parseQvm(fixture([8, 255, 255, 255, 127, 10], 2));
    expect(image.instructions[0]).toMatchObject({ opcode: QvmOpcode.OP_CONST, operand: 0x7fffffff });
  });

  test("rejects every truncated header and invalid magic", () => {
    const bytes = fixture([2], 1);
    for (let length = 0; length < 32; length++) {
      expect(() => parseQvm(bytes.subarray(0, length))).toThrow(BinaryError);
    }
    expect(() => parseQvm(changeHeader(bytes, 0, 0x12721445))).toThrow("magic");
  });

  test("rejects negative, empty and overflowing header lengths", () => {
    const bytes = fixture([2], 1);
    const invalidFields: readonly (readonly [number, number])[] = [
      [4, -1], [4, 0], [4, 2], [4, 0x7fffffff], [12, 0], [12, -1], [12, 0x20000000],
      [20, -4], [20, 1], [24, -1], [28, -1], [28, 0x40000001], [28, 0x7fffffff],
    ];
    for (const [offset, value] of invalidFields) {
      expect(() => parseQvm(changeHeader(bytes, offset, value))).toThrow(BinaryError);
    }
    const initialized = fixture([2], 1, { data: new Uint8Array(4), bssLength: 0x40000000 });
    expect(() => parseQvm(initialized)).toThrow("allocation range");
  });

  test("rejects out-of-file, header-overlapping and mutually overlapping sections", () => {
    const bytes = fixture([2], 1, { data: new Uint8Array(4) });
    for (const offset of [-1, 0, 31, bytes.length, 0x7fffffff]) {
      expect(() => parseQvm(changeHeader(bytes, 8, offset))).toThrow(BinaryError);
      expect(() => parseQvm(changeHeader(bytes, 16, offset))).toThrow(BinaryError);
    }
    expect(() => parseQvm(changeHeader(bytes, 16, 32))).toThrow("overlap");
    expect(() => parseQvm(bytes.subarray(0, bytes.length - 1))).toThrow(BinaryError);
  });

  test("bounds operands to code even when initialized data follows", () => {
    for (const opcode of [3, 4, 8, 9, 11, 26, 34]) {
      for (let supplied = 0; supplied < 4; supplied++) {
        expect(() => parseQvm(fixture([opcode, ...new Array<number>(supplied).fill(0)], 1,
          { data: new Uint8Array(4) }), "short-code.qvm")).toThrow("word operand exceeds code section");
      }
    }
    expect(() => parseQvm(fixture([33], 1, { data: new Uint8Array(4) }))).toThrow("byte operand exceeds code section");
    expect(() => parseQvm(fixture([8, 0, 0, 0, 0], 2))).toThrow("instruction exceeds code section");
  });

  test("rejects unknown opcodes and out-of-table conditional targets with source offsets", () => {
    for (const opcode of [60, 127, 255]) {
      expect(() => parseQvm(fixture([opcode], 1), "unknown.qvm")).toThrow(`unknown.qvm:32: unknown QVM opcode ${opcode}`);
    }
    for (let opcode = 11; opcode <= 26; opcode++) {
      expect(() => parseQvm(fixture([opcode, 1, 0, 0, 0], 1))).toThrow("branch target 1");
      expect(() => parseQvm(fixture([opcode, 255, 255, 255, 255], 1))).toThrow("branch target -1");
      expect(parseQvm(fixture([opcode, 0, 0, 0, 0], 1)).instructions[0]).toMatchObject({ operand: 0 });
    }
  });
});
