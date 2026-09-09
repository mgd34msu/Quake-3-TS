import { describe, expect, test } from "bun:test";
import { blockChecksum, blockChecksumKey, md4, Md4Context } from "../src/core/md4.ts";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

describe("MD4", () => {
  test("matches the RFC 1320 digest vectors", () => {
    const vectors: readonly (readonly [string, string])[] = [
      ["", "31d6cfe0d16ae931b73c59d7e0c089c0"],
      ["a", "bde52cb31de33e46245e05fbdbd6fb24"],
      ["abc", "a448017aaf21d8525fc10ae87aa6729d"],
      ["message digest", "d9130a8164549fe818874806e1c7014b"],
      ["abcdefghijklmnopqrstuvwxyz", "d79e1c308aa5bbcdeea8ed63df412da9"],
      ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "043f8582f241db351ce627e153e7f0e4"],
      ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "e33b4ddc9c38f2199c3e7b164fcc0536"],
    ];
    for (const [message, digest] of vectors) {
      const input = bytes(message);
      expect(hex(md4(input))).toBe(digest);
      for (let split = 0; split <= input.length; split++) {
        const context = new Md4Context();
        context.update(input.subarray(0, split));
        context.update(input.subarray(split));
        expect(hex(context.final())).toBe(digest);
      }
    }
  });

  test("matches OpenSSL around the 56-byte padding boundary", () => {
    const vectors: readonly (readonly [number, string])[] = [
      [55, "c889c81dd86c4d2e025778944ea02881"],
      [56, "d5f9a9e9257077a5f08b0b92f348b0ad"],
      [63, "7ea3da77432d44c323671097d1348fc8"],
      [64, "52f5076fabd22680234a3fa9f9dc5732"],
      [65, "330e377bf231f3cacfecc2c182fe7e5b"],
    ];
    for (const [length, digest] of vectors) expect(hex(md4(bytes("a".repeat(length))))).toBe(digest);
  });

  test("folds four little-endian digest words like Com_BlockChecksum", () => {
    expect(blockChecksum(bytes(""))).toBe(0xc6f640b7);
    expect(blockChecksum(bytes("abc"))).toBe(0x5da10e2e);
  });

  test("streaming owns partial blocks, retains storage on initialize and zeroizes it on final", () => {
    const context = new Md4Context(), state = context.state, count = context.count, buffer = context.buffer;
    buffer.fill(42);
    context.update(bytes("obsolete"));
    context.initialize();
    expect(context.count).toEqual([0, 0]);
    const retained: Uint8Array<ArrayBufferLike> = context.buffer.subarray(0, 8);
    expect(retained).toEqual(bytes("obsolete"));
    const input = bytes("a");
    context.update(input); input[0] = 98;
    expect(context.count).toEqual([8, 0]);
    expect(context.buffer[0]).toBe(97);
    const digest = context.final();
    expect(hex(digest)).toBe("bde52cb31de33e46245e05fbdbd6fb24");
    expect(context.state).toBe(state); expect(context.count).toBe(count); expect(context.buffer).toBe(buffer);
    expect(context.state).toEqual({ a: 0, b: 0, c: 0, d: 0 });
    expect(context.count).toEqual([0, 0]);
    expect(context.buffer).toEqual(new Uint8Array(64));
    context.initialize(); context.update(bytes("abc"));
    expect(hex(context.final())).toBe("a448017aaf21d8525fc10ae87aa6729d");
    expect(hex(digest)).toBe("bde52cb31de33e46245e05fbdbd6fb24");
  });

  test("bit counts carry and wrap at the source uint32 boundaries", () => {
    const context = new Md4Context();
    context.count[0] = 0xfffffff8; context.count[1] = 0x12345678;
    context.update(Uint8Array.of(0));
    expect(context.count).toEqual([0, 0x12345679]);
    context.count[0] = 0xffffff00; context.count[1] = 0xffffffff;
    context.update(new Uint8Array(32));
    expect(context.count).toEqual([0, 0]);
    context.update(new Uint8Array());
    expect(context.count).toEqual([0, 0]);
  });

  test("streaming crosses partial and direct block transforms with arbitrary chunk sizes", () => {
    const input = Uint8Array.from({ length: 1024 }, (_, index) => index & 255);
    // Retained whole-buffer TypeScript digest, supplementing the independent RFC vectors.
    const digest = "5ae257c47e9be1243ee32aabe408fb6b";
    for (const size of [1, 7, 55, 56, 63, 64, 65, 127, 128, 129, 1024]) {
      const context = new Md4Context();
      for (let offset = 0; offset < input.length; offset += size) context.update(input.subarray(offset, offset + size));
      expect(hex(context.final())).toBe(digest);
    }
  });

  test("prefixes a little-endian int32 key like Com_BlockChecksumKey", () => {
    expect(blockChecksumKey(bytes("abc"), 0)).toBe(0x20a44803);
    expect(blockChecksumKey(bytes("abc"), 0x12345678)).toBe(0x3fa8af87);
    expect(blockChecksumKey(bytes("abc"), -1)).toBe(blockChecksumKey(bytes("abc"), 0xffffffff));
  });

  test("rejects keys outside their 32-bit bit pattern", () => {
    for (const key of [-0x80000001, 0x100000000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => blockChecksumKey(new Uint8Array(), key)).toThrow(RangeError);
    }
  });
});
