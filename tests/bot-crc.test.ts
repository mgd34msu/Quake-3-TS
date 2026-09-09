import { describe, expect, test } from "bun:test";
import { CRC_ContinueProcessString, CRC_Init, CRC_ProcessByte, CRC_ProcessString, CRC_Value, crc16 } from "../src/botlib/crc.ts";
import { routeCacheClusterCrc, routeCacheCrc16 } from "../src/botlib/aas-route-cache.ts";

describe("botlib l_crc", () => {
  test("initial value, standard vector and unsigned-short argument conversions", () => {
    expect(CRC_Init()).toBe(0xffff);
    expect(CRC_ProcessString(new Uint8Array())).toBe(0xffff);
    expect(CRC_ProcessString(new TextEncoder().encode("123456789"))).toBe(0x29b1);
    expect(CRC_Value(0x129b1)).toBe(0x29b1);
    expect(CRC_ProcessByte(0x1ffff, 0x131)).toBe(0xc782);
    expect(CRC_ProcessByte(0xffff, 0xff)).toBe(0xff00);
  });

  test("single-byte and signed-char ASCII continuation match full processing", () => {
    const bytes = new TextEncoder().encode("123456789");
    let crc = CRC_Init();
    for (const byte of bytes) crc = CRC_ProcessByte(crc, byte);
    expect(CRC_Value(crc)).toBe(0x29b1);
    for (let split = 0; split <= bytes.length; split++) {
      expect(CRC_ContinueProcessString(CRC_ProcessString(bytes, split), bytes.subarray(split))).toBe(0x29b1);
    }
  });

  test("length includes NUL and respects view offsets and negative lengths", () => {
    const bytes = new Uint8Array([99, 0x31, 0, 0x32, 99]).subarray(1, 4);
    // Source table steps: c782 -> 2bab -> 2818.
    expect(CRC_ProcessString(bytes)).toBe(0x2818);
    expect(CRC_ProcessString(bytes, 1)).toBe(0xc782);
    expect(CRC_ProcessString(bytes, -1)).toBe(0xffff);
    expect(CRC_ContinueProcessString(0x1234, bytes, -1)).toBe(0x1234);
    expect(CRC_ContinueProcessString(CRC_Init(), bytes)).toBe(0x2818);
    expect(() => CRC_ProcessString(bytes, 4)).toThrow("exceeds input allocation");
    expect(() => CRC_ContinueProcessString(0xffff, bytes, 4)).toThrow("exceeds input allocation");
    expect(() => CRC_ProcessString(bytes, 0.5)).toThrow("signed 32-bit");
  });

  test("signed high bytes reject the source's undefined negative table access", () => {
    for (const byte of [0x80, 0xff]) {
      const bytes = new Uint8Array([byte]);
      expect(() => CRC_ContinueProcessString(CRC_Init(), bytes)).toThrow("undefined signed-char continuation");
      expect(CRC_ContinueProcessString(0x1234, bytes, 0)).toBe(0x1234);
      expect(CRC_ProcessString(bytes)).toBe(CRC_ProcessByte(CRC_Init(), byte));
    }
  });

  test("AAS checksum retains unsigned incremental records and existing entrypoint", () => {
    expect(routeCacheCrc16).toBe(crc16);
    const bytes = new Uint8Array([0xff, 0x80, 0, 0x31]);
    expect(crc16(bytes.subarray(2), crc16(bytes.subarray(0, 2)))).toBe(CRC_ProcessString(bytes));
    expect(routeCacheClusterCrc([{ areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 }])).toBe(0x6a0a);
  });
});
