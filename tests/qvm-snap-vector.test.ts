import { describe, expect, test } from "bun:test";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmSnapVectorSyscall } from "../src/vm/snap-vector-syscalls.ts";

function argumentsView(...words: number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  for (const [index, word] of words.entries()) view.setInt32(index * 4, word, true);
  return view;
}

function writeFloats(view: DataView, ...values: number[]): void {
  for (const [index, value] of values.entries()) view.setFloat32(index * 4, value, true);
}

function readFloats(view: DataView): number[] {
  return Array.from({ length: view.byteLength / 4 }, (_, index) => view.getFloat32(index * 4, true));
}

describe("QVM SnapVector selected Linux i386 x87 profile", () => {
  test("role and trap gates precede reached argument reads", () => {
    const memory = new QvmMemory(new Uint8Array(64));
    expect(qvmSnapVectorSyscall("ui", argumentsView(), memory)).toBeNull();
    expect(qvmSnapVectorSyscall("ui", argumentsView(42), memory)).toBeNull();
    expect(qvmSnapVectorSyscall("ui", argumentsView(71), memory)).toBeNull();
    expect(qvmSnapVectorSyscall("game", argumentsView(71), memory)).toBeNull();
    expect(qvmSnapVectorSyscall("cgame", argumentsView(42), memory)).toBeNull();
    expect(qvmSnapVectorSyscall("game", argumentsView(-43), memory)).toBeNull();
    expect(qvmSnapVectorSyscall("cgame", argumentsView(-72), memory)).toBeNull();
    expect(() => qvmSnapVectorSyscall("game", argumentsView(), memory)).toThrow(RangeError);
    expect(() => qvmSnapVectorSyscall("cgame", argumentsView(), memory)).toThrow(RangeError);
    expect(() => qvmSnapVectorSyscall("game", argumentsView(42), memory)).toThrow(RangeError);
    expect(() => qvmSnapVectorSyscall("cgame", argumentsView(71), memory)).toThrow(RangeError);
    expect(() => qvmSnapVectorSyscall("game", argumentsView(42, 0), memory)).toThrow("nonnull pointer");
  });

  test("half ties round to even and integer reload normalizes zero bits", () => {
    const memory = new QvmMemory(new Uint8Array(64));
    const vector = memory.view(16, 12);
    writeFloats(vector, 0.5, 1.5, 2.5);
    expect(qvmSnapVectorSyscall("game", argumentsView(42, 16), memory)).toBe(0);
    expect(readFloats(vector)).toEqual([0, 2, 2]);
    expect(vector.getUint32(0, true)).toBe(0);
    writeFloats(vector, -0.5, -1.5, -2.5);
    expect(qvmSnapVectorSyscall("cgame", argumentsView(71, 16), memory)).toBe(0);
    expect(readFloats(vector)).toEqual([0, -2, -2]);
    expect(vector.getUint32(0, true)).toBe(0);
    writeFloats(vector, -0, -0.25, 0.25);
    qvmSnapVectorSyscall("game", argumentsView(42, 16), memory);
    expect([0, 4, 8].map((offset) => vector.getUint32(offset, true))).toEqual([0, 0, 0]);
    writeFloats(vector, 1.25, 1.75, -1.75);
    qvmSnapVectorSyscall("game", argumentsView(42, 16), memory);
    expect(readFloats(vector)).toEqual([1, 2, -2]);
  });

  test("nonfinite and out-of-range conversions produce signed integer indefinite", () => {
    const memory = new QvmMemory(new Uint8Array(64));
    const vector = memory.view(16, 12);
    writeFloats(vector, NaN, Infinity, -Infinity);
    qvmSnapVectorSyscall("game", argumentsView(42, 16), memory);
    expect(readFloats(vector)).toEqual([-2147483648, -2147483648, -2147483648]);
    writeFloats(vector, 2147483648, 2147483520, -2147483648);
    qvmSnapVectorSyscall("cgame", argumentsView(71, 16), memory);
    expect(readFloats(vector)).toEqual([-2147483648, 2147483520, -2147483648]);
    writeFloats(vector, -2147483904, 3.4028234663852886e38, -3.4028234663852886e38);
    qvmSnapVectorSyscall("game", argumentsView(42, 16), memory);
    expect(readFloats(vector)).toEqual([-2147483648, -2147483648, -2147483648]);
  });

  test("masked bases preserve borrowed offsets and tail writes before bounds failure", () => {
    const backing = new Uint8Array(96).fill(0xa5);
    const memory = new QvmMemory(backing.subarray(16, 80));
    const start = memory.view(64, 12);
    writeFloats(start, 0.5, 1.5, 2.5);
    expect(qvmSnapVectorSyscall("game", argumentsView(42, 64), memory)).toBe(0);
    expect(readFloats(start)).toEqual([0, 2, 2]);
    const finalVector = memory.view(52, 12);
    writeFloats(finalVector, 1.5, 2.5, 3.5);
    expect(qvmSnapVectorSyscall("cgame", argumentsView(71, -12), memory)).toBe(0);
    expect(readFloats(finalVector)).toEqual([2, 2, 4]);
    const tail = memory.view(56, 8);
    writeFloats(tail, 1.5, -2.5);
    expect(() => qvmSnapVectorSyscall("game", argumentsView(42, -8), memory)).toThrow(RangeError);
    expect(readFloats(tail)).toEqual([2, -2]);
    expect(readFloats(start)).toEqual([0, 2, 2]);
    expect(backing.subarray(0, 16)).toEqual(new Uint8Array(16).fill(0xa5));
    expect(backing.subarray(80)).toEqual(new Uint8Array(16).fill(0xa5));
  });
});
