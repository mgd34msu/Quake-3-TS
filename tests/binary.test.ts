import { describe, expect, test } from "bun:test";
import { BinaryError, BinaryReader, BinaryWriter } from "../src/core/binary.ts";

describe("little-endian binary boundaries", () => {
  test("reads known bytes from a nonzero byteOffset", () => {
    const bytes = new Uint8Array([99, 0x78, 0x56, 0x34, 0x12, 0, 0, 0x80, 0x3f, 99]);
    const reader = new BinaryReader(bytes.subarray(1, 9), "fixture");
    expect(reader.u32()).toBe(0x12345678);
    expect(reader.f32()).toBe(1);
    expect(reader.remaining).toBe(0);
    expect(() => reader.u8()).toThrow(BinaryError);
    expect(reader.offset).toBe(8);
  });

  test("byte reads own their memory even when input is a Buffer subview", () => {
    const input = Buffer.from([99, 1, 2, 3, 99]);
    const reader = new BinaryReader(input.subarray(1, 4));
    const bytes = reader.bytes(2);
    bytes[0] = 200;
    expect(input[1]).toBe(1);
    input[2] = 201;
    expect(bytes[1]).toBe(2);
    reader.section(2, 1).bytes(1).fill(0);
    expect(input[3]).toBe(3);
  });

  test("writes exact signed/unsigned and float representations", () => {
    const writer = new BinaryWriter(9);
    writer.i8(-1); writer.u16(0xabcd); writer.i16(-2); writer.f32(-2.5);
    expect([...writer.finish()]).toEqual([255, 205, 171, 254, 255, 0, 0, 32, 192]);
    expect(() => writer.u8(256)).toThrow(RangeError);
    expect(() => writer.u8(1)).toThrow(RangeError);
  });

  test("rejects malformed ranges before changing cursor", () => {
    const reader = new BinaryReader(new Uint8Array(8));
    for (const size of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => reader.bytes(size)).toThrow(BinaryError);
      expect(reader.offset).toBe(0);
    }
    expect(() => reader.section(7, 2)).toThrow(BinaryError);
    expect(() => reader.records(0, 8, 3)).toThrow(BinaryError);
    expect(reader.section(8, 0).remaining).toBe(0);
  });

  test("fixed strings terminate at NUL and sections preserve parent position", () => {
    const reader = new BinaryReader(new Uint8Array([73, 66, 83, 80, 65, 0, 66]));
    reader.expectMagic("IBSP");
    expect(reader.fixedString(3)).toBe("A");
    expect(reader.section(0, 4).fixedString(4)).toBe("IBSP");
    expect(reader.offset).toBe(7);
  });

  test("finite float boundary rejects NaN but raw codec preserves it", () => {
    const bytes = new Uint8Array([0, 0, 192, 127]);
    expect(Number.isNaN(new BinaryReader(bytes).f32())).toBe(true);
    expect(() => new BinaryReader(bytes).finiteF32()).toThrow("non-finite");
  });
});
