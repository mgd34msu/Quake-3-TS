import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmMemorySyscall } from "../src/vm/memory-syscalls.ts";

function words(trap: number, destination: number, source: number, count: number): DataView {
  const view = new DataView(new ArrayBuffer(16));
  view.setInt32(0, trap, true);
  view.setInt32(4, destination, true);
  view.setInt32(8, source, true);
  view.setInt32(12, count, true);
  return view;
}

test("QvmMemory borrows power-of-two allocations and masks after the null check", () => {
  const bytes = new Uint8Array(8);
  const memory = new QvmMemory(bytes);
  expect(memory.bytes).toBe(bytes);
  expect(memory.pointer(0)).toBeNull();
  expect(memory.pointer(-0)).toBeNull();
  expect(memory.pointer(8)).toEqual(bytes);
  expect(memory.pointer(-8)).toEqual(bytes);
  expect(memory.pointer(-1)).toEqual(bytes.subarray(7));
  expect(memory.pointer(-0x80000000)).toEqual(bytes);
  expect(memory.pointer(0x7fffffff)).toEqual(bytes.subarray(7));
  memory.span(8, 1)[0] = 42;
  expect(bytes[0]).toBe(42);
  for (const length of [0, 3, 7, 9]) expect(() => new QvmMemory(new Uint8Array(length))).toThrow(RangeError);
  expect(new QvmMemory(new Uint8Array(1)).span(1, 1).byteLength).toBe(1);
});

test("QvmMemory validates words and contained ranges without wrapping their ends", () => {
  const memory = new QvmMemory(new Uint8Array(8));
  for (const word of [NaN, Infinity, -Infinity, 1.5, 0x80000000, -0x80000001]) {
    expect(() => memory.pointer(word)).toThrow(RangeError);
  }
  for (const length of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2]) {
    expect(() => memory.span(7, length)).toThrow(RangeError);
  }
  expect(() => memory.span(0, 0)).toThrow("nonnull");
  expect(memory.span(7, 0).byteLength).toBe(0);
  expect(memory.span(7, 1).byteLength).toBe(1);
  expect(() => memory.view(7, 2)).toThrow(RangeError);
});

test("QvmMemory DataViews respect an allocation subarray's backing offset", () => {
  const backing = new Uint8Array(20).fill(99);
  const memory = new QvmMemory(backing.subarray(5, 13));
  memory.view(2, 4).setUint32(0, 0x12345678, true);
  expect([...backing]).toEqual([99, 99, 99, 99, 99, 99, 99, 0x78, 0x56, 0x34, 0x12, 99, 99, 99, 99, 99, 99, 99, 99, 99]);
  expect(memory.view(8, 8).byteOffset).toBe(5);
});

test("QVM strings are NUL-terminated bytes rather than UTF-8", () => {
  const memory = new QvmMemory(Uint8Array.of(65, 0, 0xc3, 0xa9, 0xff, 0, 66, 67));
  expect(memory.readString(2)).toBe("\u00c3\u00a9\u00ff");
  expect(memory.readString(8)).toBe("A");
  expect(() => memory.readString(6)).toThrow("no terminator");
  expect(() => memory.readString(0)).toThrow("nonnull");
});

test("QVM relative accesses mask the base before indexing within its actual allocation", () => {
  const backing = new Uint8Array(24).fill(99);
  const memory = new QvmMemory(backing.subarray(4, 20));
  memory.view(8, 4, -4).setInt32(0, -123, true);
  expect(memory.view(24, 4, -4).getInt32(0, true)).toBe(-123);
  expect(memory.view(-8, 4, -4).getInt32(0, true)).toBe(-123);
  expect(memory.span(8, 4, -4).byteOffset).toBe(8);
  expect([...backing.subarray(0, 4)]).toEqual([99, 99, 99, 99]);
  expect([...backing.subarray(20)]).toEqual([99, 99, 99, 99]);
  for (const offset of [-9, 5, 16, 0.5, NaN, Infinity]) {
    expect(() => memory.view(8, 4, offset)).toThrow(RangeError);
  }
  expect(() => memory.view(16, 4, -4)).toThrow(RangeError);
  expect(() => memory.view(0, 4, 4)).toThrow("nonnull");
});

test("Q_strncpyz truncates, pads and terminates within capacity only", () => {
  const bytes = new Uint8Array(16).fill(77);
  const memory = new QvmMemory(bytes);
  memory.writeString(2, "\u00ffA", 5);
  expect([...bytes.subarray(1, 8)]).toEqual([77, 255, 65, 0, 0, 0, 77]);
  memory.writeString(9, "ABCDE", 3);
  expect([...bytes.subarray(8, 13)]).toEqual([77, 65, 66, 0, 77]);
  memory.writeString(14, "A\0ignored", 2);
  expect([...bytes.subarray(14)]).toEqual([65, 0]);
  memory.writeString(16, "ignored", 1);
  expect(bytes[0]).toBe(0);
});

test("Q_strncpyz rejects null before capacity and rejects invalid reached bytes", () => {
  const bytes = new Uint8Array(8).fill(77);
  const memory = new QvmMemory(bytes);
  expect(() => memory.writeString(0, "", 0)).toThrow(new CommonError("fatal", "Q_strncpyz: NULL dest"));
  for (const capacity of [0, -1]) {
    expect(() => memory.writeString(1, "", capacity)).toThrow(new CommonError("fatal", "Q_strncpyz: destsize < 1"));
  }
  for (const capacity of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8]) {
    expect(() => memory.writeString(1, "", capacity)).toThrow(RangeError);
  }
  expect(() => memory.writeString(1, "A\u0100", 4)).toThrow(RangeError);
  expect([...bytes]).toEqual([77, 65, 77, 77, 77, 77, 77, 77]);
  memory.writeString(1, "A\0\u0100", 4);
  expect([...bytes.subarray(1, 6)]).toEqual([65, 0, 0, 0, 77]);
  memory.writeString(1, "A\u0100", 2);
  expect([...bytes.subarray(1, 4)]).toEqual([65, 0, 0]);
});

test("raw bounded bot string copies preserve allocation errors without a source fatal call", () => {
  const memory = new QvmMemory(new Uint8Array(8).fill(77));
  expect(() => memory.writeBoundedString(0, "a", 2)).toThrow(RangeError);
  expect(() => memory.writeBoundedString(1, "a", 0)).toThrow(RangeError);
  expect(() => memory.writeBoundedString(7, "a", 2)).toThrow(RangeError);
  expect([...memory.bytes]).toEqual(new Array<number>(8).fill(77));
  memory.writeBoundedString(2, "ab", 5);
  expect([...memory.bytes]).toEqual([77, 77, 97, 98, 0, 0, 0, 77]);
});

const roles: readonly ("game" | "cgame" | "ui")[] = ["game", "cgame", "ui"];
for (const role of roles) {
  test(`${role} memory traps mutate bytes and preserve source return conventions`, () => {
    const memory = new QvmMemory(new Uint8Array(16).fill(77));
    expect(qvmMemorySyscall(role, words(100, 2, 0x123456fe, 3), memory)).toBe(0);
    expect([...memory.bytes.subarray(1, 6)]).toEqual([77, 254, 254, 254, 77]);
    expect(qvmMemorySyscall(role, words(101, 8, 2, 3), memory)).toBe(0);
    expect([...memory.bytes.subarray(7, 12)]).toEqual([77, 254, 254, 254, 77]);
    memory.bytes.set([65, 255, 0], 12);
    expect(qvmMemorySyscall(role, words(102, -12, 12, 5), memory)).toBe(-12);
    expect([...memory.bytes.subarray(3, 10)]).toEqual([254, 65, 255, 0, 0, 0, 254]);
    expect(qvmMemorySyscall(role, words(102, 16, 12, 2), memory)).toBe(16);
    expect([...memory.bytes.subarray(0, 3)]).toEqual([65, 255, 254]);
  });
}

test("strncpy pads after the last allocation byte's NUL without reading past it", () => {
  const memory = new QvmMemory(new Uint8Array(16).fill(77));
  memory.bytes[15] = 0;
  qvmMemorySyscall("ui", words(102, 1, 15, 5), memory);
  expect([...memory.bytes.subarray(0, 7)]).toEqual([77, 0, 0, 0, 0, 0, 77]);
  memory.bytes[14] = 65;
  qvmMemorySyscall("ui", words(102, 1, 14, 5), memory);
  expect([...memory.bytes.subarray(0, 7)]).toEqual([77, 65, 0, 0, 0, 0, 77]);
});

test("memory syscalls respect subarray offsets for both argument words and borrowed memory", () => {
  const bytes = new Uint8Array(24).fill(77);
  const memory = new QvmMemory(bytes.subarray(3, 19));
  const argumentsBacking = new Uint8Array(24).fill(255);
  argumentsBacking.set(new Uint8Array(words(100, 1, -1, 2).buffer), 5);
  expect(qvmMemorySyscall("cgame", new DataView(argumentsBacking.buffer, 5, 16), memory)).toBe(0);
  expect([...bytes.subarray(0, 7)]).toEqual([77, 77, 77, 77, 255, 255, 77]);
  qvmMemorySyscall("cgame", words(101, 5, 1, 2), memory);
  expect([...bytes.subarray(7, 11)]).toEqual([77, 255, 255, 77]);
  memory.bytes[15] = 0;
  qvmMemorySyscall("cgame", words(102, 10, 15, 2), memory);
  expect([...bytes.subarray(12, 16)]).toEqual([77, 0, 0, 77]);
});

test("memory trap validation rejects malformed ranges and undefined overlap before writes", () => {
  const memory = new QvmMemory(new Uint8Array(16).fill(77));
  for (const trap of [100, 101, 102]) {
    expect(() => qvmMemorySyscall("game", words(trap, 1, 10, -1), memory)).toThrow(RangeError);
    expect(() => qvmMemorySyscall("game", words(trap, 15, 10, 2), memory)).toThrow(RangeError);
    expect(() => qvmMemorySyscall("game", words(trap, 0, 10, 0), memory)).toThrow("nonnull");
    expect(() => qvmMemorySyscall("game", new DataView(words(trap, 1, 10, 1).buffer, 0, 12), memory)).toThrow(RangeError);
  }
  for (const trap of [101, 102]) {
    expect(() => qvmMemorySyscall("game", words(trap, 1, 15, 2), memory)).toThrow(RangeError);
    expect(() => qvmMemorySyscall("game", words(trap, 1, 0, 0), memory)).toThrow("nonnull");
    expect(() => qvmMemorySyscall("game", words(trap, 1, 2, 3), memory)).toThrow("Overlapping");
    expect(() => qvmMemorySyscall("game", words(trap, 2, 1, 3), memory)).toThrow("Overlapping");
    expect(qvmMemorySyscall("game", words(trap, 1, 1, 0), memory)).toBe(trap === 101 ? 0 : 1);
  }
  expect([...memory.bytes]).toEqual(new Array<number>(16).fill(77));
  expect(qvmMemorySyscall("ui", words(103, 0, 0, -1), memory)).toBeNull();
  expect(qvmMemorySyscall("game", new DataView(new ArrayBuffer(4)), memory)).toBeNull();
  expect(() => qvmMemorySyscall("ui", new DataView(new ArrayBuffer(3)), memory)).toThrow(RangeError);
});
