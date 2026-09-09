import { describe, expect, test } from "bun:test";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmVectorSyscall } from "../src/vm/vector-syscalls.ts";

function argumentsView(...words: number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  for (const [index, word] of words.entries()) view.setInt32(index * 4, word, true);
  return view;
}

function floats(memory: QvmMemory, pointer: number, ...values: number[]): void {
  const view = memory.view(pointer, values.length * 4);
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value, true);
}

function readFloats(memory: QvmMemory, pointer: number, count: number): number[] {
  const view = memory.view(pointer, count * 4);
  return Array.from({ length: count }, (_, index) => view.getFloat32(index * 4, true));
}

describe("game host vector syscalls over QVM bytes", () => {
  test("zero angles preserve axis signs and null outputs do not address byte zero", () => {
    const bytes = new Uint8Array(256);
    const memory = new QvmMemory(bytes);
    bytes.fill(0xa5, 0, 12);
    floats(memory, 16, 0, 0, 0);
    expect(qvmVectorSyscall("game", argumentsView(108, 16, 32, 48, 64), memory)).toBe(0);
    expect(readFloats(memory, 32, 3)).toEqual([1, 0, -0]);
    expect(readFloats(memory, 48, 3)).toEqual([0, -1, -0]);
    expect(readFloats(memory, 64, 3)).toEqual([0, 0, 1]);
    expect(qvmVectorSyscall("game", argumentsView(108, 16, 0, 0, 0), memory)).toBe(0);
    expect(bytes.slice(0, 12)).toEqual(new Uint8Array(12).fill(0xa5));
    expect(qvmVectorSyscall("game", argumentsView(108, 16, 0, 80, 0), memory)).toBe(0);
    expect(readFloats(memory, 80, 3)).toEqual([0, -1, -0]);
  });

  test("ordinary angles retain the existing native SSE golden through byte writes", () => {
    const memory = new QvmMemory(new Uint8Array(256));
    floats(memory, 16, -17.35, 123.456, 21.5);
    qvmVectorSyscall("game", argumentsView(108, 16, 32, 48, 64), memory);
    // Untouched q_math.c GCC gnu99 -O0 fixtures recorded in tests/math.test.ts.
    expect(readFloats(memory, 32, 3)).toEqual([-0.5262129306793213, 0.7963491678237915, 0.29820796847343445]);
    expect(readFloats(memory, 48, 3)).toEqual([0.7160030603408813, 0.6041205525398254, -0.34982573986053467]);
    expect(readFloats(memory, 64, 3)).toEqual([0.45873701572418213, -0.029434993863105774, 0.8880844712257385]);
  });

  test("angles are captured before aliased outputs and overlapping outputs publish in source order", () => {
    const memory = new QvmMemory(new Uint8Array(128));
    floats(memory, 16, 0, 0, 0);
    qvmVectorSyscall("game", argumentsView(108, 16, 16, 20, 24), memory);
    expect(readFloats(memory, 16, 5)).toEqual([1, 0, 0, 0, 1]);
  });

  test("perpendicular basis, tie choice, source alias and native SSE golden", () => {
    const memory = new QvmMemory(new Uint8Array(128));
    floats(memory, 16, 1, 0, 0);
    expect(qvmVectorSyscall("game", argumentsView(109, 32, 16), memory)).toBe(0);
    expect(readFloats(memory, 32, 3)).toEqual([0, 1, 0]);
    floats(memory, 16, 0, 0, 1);
    qvmVectorSyscall("game", argumentsView(109, 16, 16), memory);
    expect(readFloats(memory, 16, 3)).toEqual([1, 0, 0]);
    // Normalized (1, 2, 3) and its perpendicular native goldens in math.test.ts.
    floats(memory, 16, 0.26726123690605164, 0.5345224738121033, 0.8017836809158325);
    qvmVectorSyscall("game", argumentsView(109, 32, 16), memory);
    expect(readFloats(memory, 32, 3)).toEqual([0.963624119758606, -0.14824987947940826, -0.2223748415708542]);
  });

  test("zero and underflowed normals retain the native assertion rejection before mutation", () => {
    const memory = new QvmMemory(new Uint8Array(128));
    floats(memory, 32, 7, 8, 9);
    for (const component of [0, 1e-30]) {
      floats(memory, 16, component, 0, 0);
      expect(() => qvmVectorSyscall("game", argumentsView(109, 32, 16), memory)).toThrow("zero projection denominator");
      expect(readFloats(memory, 32, 3)).toEqual([7, 8, 9]);
    }
  });

  test("matrix multiplication stores row-major results and rounds intermediate sums", () => {
    const memory = new QvmMemory(new Uint8Array(256));
    floats(memory, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    floats(memory, 64, 9, 8, 7, 6, 5, 4, 3, 2, 1);
    expect(qvmVectorSyscall("game", argumentsView(107, 16, 64, 112), memory)).toBe(0);
    expect(readFloats(memory, 112, 9)).toEqual([30, 24, 18, 84, 69, 54, 138, 114, 90]);
    floats(memory, 16, 1.0000001192092896, 1, 1, 0, 0, 0, 0, 0, 0);
    floats(memory, 64, 1.0000001192092896, 0, 0, -1, 0, 0, -0.0000002384185791015625, 0, 0);
    qvmVectorSyscall("game", argumentsView(107, 16, 64, 112), memory);
    expect(readFloats(memory, 112, 9)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("matrix output aliases observe each preceding assignment", () => {
    const memory = new QvmMemory(new Uint8Array(128));
    floats(memory, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    floats(memory, 64, 9, 8, 7, 6, 5, 4, 3, 2, 1);
    qvmVectorSyscall("game", argumentsView(107, 16, 64, 16), memory);
    expect(readFloats(memory, 16, 9)).toEqual([30, 256, 1237, 84, 709, 3430, 138, 1162, 5623]);
  });

  test("masked pointers preserve borrowed allocation offsets and nonzero words resolving to byte zero", () => {
    const backing = new Uint8Array(160).fill(0xa5);
    const memory = new QvmMemory(backing.subarray(16, 144));
    floats(memory, 16, 0, 0, 0);
    // -112 masks to 16; 128 masks to zero but is not a null pointer.
    qvmVectorSyscall("game", argumentsView(108, -112, 128, 0, 0), memory);
    expect(readFloats(memory, 128, 3)).toEqual([1, 0, -0]);
    expect(backing.subarray(0, 16)).toEqual(new Uint8Array(16).fill(0xa5));
    expect(backing.subarray(144)).toEqual(new Uint8Array(16).fill(0xa5));
  });

  test("client and UI traps and unknown game traps stay unhandled", () => {
    const memory = new QvmMemory(new Uint8Array(128));
    for (const trap of [107, 108, 109]) {
      expect(qvmVectorSyscall("cgame", argumentsView(trap), memory)).toBeNull();
      expect(qvmVectorSyscall("ui", argumentsView(trap), memory)).toBeNull();
    }
    expect(qvmVectorSyscall("game", argumentsView(110), memory)).toBeNull();
  });

  test("exact final vector span succeeds and truncated words, null input and overruns reject", () => {
    const memory = new QvmMemory(new Uint8Array(128));
    floats(memory, 16, 1, 0, 0);
    qvmVectorSyscall("game", argumentsView(109, 116, 16), memory);
    expect(readFloats(memory, 116, 3)).toEqual([0, 1, 0]);
    floats(memory, 16, 1, 0, 0, 0, 1, 0, 0, 0, 1);
    floats(memory, 56, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    qvmVectorSyscall("game", argumentsView(107, 16, 56, 92), memory);
    expect(readFloats(memory, 92, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(() => qvmVectorSyscall("game", argumentsView(), memory)).toThrow(RangeError);
    expect(() => qvmVectorSyscall("game", argumentsView(108, 16, 32, 48), memory)).toThrow(RangeError);
    expect(() => qvmVectorSyscall("game", argumentsView(109, 32, 0), memory)).toThrow(RangeError);
    expect(() => qvmVectorSyscall("game", argumentsView(109, 117, 16), memory)).toThrow(RangeError);
    expect(() => qvmVectorSyscall("game", argumentsView(107, 16, 64, 93), memory)).toThrow(RangeError);
    floats(memory, 32, 7, 8, 9);
    expect(() => qvmVectorSyscall("game", argumentsView(108, 16, 32, 0, 117), memory)).toThrow(RangeError);
    expect(readFloats(memory, 32, 3)).toEqual([7, 8, 9]);
  });
});
