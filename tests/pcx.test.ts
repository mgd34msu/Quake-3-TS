import { describe, expect, test } from "bun:test";
import { decodePcx } from "../src/assets/pcx.ts";
import type { ImageData } from "../src/assets/tga.ts";
import { BinaryError } from "../src/core/binary.ts";

function makePcx(width: number, height: number, encoded: readonly number[], marker: number | null = 12): Uint8Array {
  const bytes = new Uint8Array(128 + encoded.length + (marker === null ? 0 : 1) + 768);
  const view = new DataView(bytes.buffer);
  bytes.set([10, 5, 1, 8]);
  view.setUint16(8, width - 1, true);
  view.setUint16(10, height - 1, true);
  bytes[65] = 1;
  view.setUint16(66, width, true);
  bytes.set(encoded, 128);
  if (marker !== null) bytes[128 + encoded.length] = marker;
  for (let index = 0; index < 256; index++) {
    const offset = bytes.length - 768 + index * 3;
    bytes[offset] = index;
    bytes[offset + 1] = 255 - index;
    bytes[offset + 2] = (index * 17) & 255;
  }
  return bytes;
}

function image(bytes: Uint8Array): ImageData {
  const result = decodePcx(bytes);
  if ("kind" in result) throw new Error(result.message);
  return result;
}

describe("source PCX decoding", () => {
  test("expands palette indexes into opaque RGBA in source row order", () => {
    const decoded = image(makePcx(2, 2, [1, 2, 3, 4]));
    expect([decoded.width, decoded.height]).toEqual([2, 2]);
    expect([...decoded.pixels]).toEqual([
      1, 254, 17, 255, 2, 253, 34, 255,
      3, 252, 51, 255, 4, 251, 68, 255,
    ]);
  });

  test("decodes literal and escaped high indexes and the maximum 63-byte run", () => {
    const decoded = image(makePcx(65, 1, [191, 0xc1, 255, 0xff, 200]));
    expect([...decoded.pixels.subarray(0, 8)]).toEqual([191, 64, 175, 255, 255, 0, 239, 255]);
    expect([...decoded.pixels.subarray(8)]).toEqual(Array.from({ length: 63 }, () => [200, 55, 72, 255]).flat());
  });

  test("uses xmax+1 and ymax+1, ignoring origins, planes and bytes_per_line", () => {
    const bytes = makePcx(1, 2, [7, 99, 8, 99]);
    const view = new DataView(bytes.buffer);
    view.setUint16(4, 400, true);
    view.setUint16(6, 500, true);
    view.setUint16(66, 200, true);
    bytes[65] = 3;
    const decoded = image(bytes);
    expect([decoded.width, decoded.height]).toEqual([1, 2]);
    expect([...decoded.pixels]).toEqual([7, 248, 119, 255, 99, 156, 147, 255]);
  });

  test("copies the final 768 bytes without requiring a palette marker", () => {
    for (const marker of [null, 0, 12, 255]) {
      expect([...image(makePcx(1, 1, [5], marker)).pixels]).toEqual([5, 250, 85, 255]);
    }
  });

  test("preserves cross-row writes followed by the next row's overwrite", () => {
    const decoded = image(makePcx(2, 3, [0xc5, 1, 2, 3, 4, 5]));
    expect([...decoded.pixels]).toEqual([
      1, 254, 17, 255, 1, 254, 17, 255,
      2, 253, 34, 255, 3, 252, 51, 255,
      4, 251, 68, 255, 5, 250, 85, 255,
    ]);
  });

  test("consumes the value of zero-length runs and continues the same row", () => {
    expect([...image(makePcx(1, 1, [0xc0, 200, 7])).pixels]).toEqual([7, 248, 119, 255]);
  });

  test("accepts dimensions from 1 through 1024 inclusive", () => {
    expect(image(makePcx(1, 1, [0])).pixels.length).toBe(4);
    const decoded = image(makePcx(1024, 1024, new Array<number>(1024 * 1024).fill(0)));
    expect([decoded.width, decoded.height, decoded.pixels.length]).toEqual([1024, 1024, 4194304]);
    expect([...decoded.pixels.subarray(-4)]).toEqual([0, 255, 0, 255]);
  });

  test("returns the exact source PRINT_ALL diagnostic for rejected headers", () => {
    const headerCases: readonly [number, number][] = [[0, 11], [1, 4], [2, 0], [3, 4]];
    for (const [offset, value] of headerCases) {
      const bytes = makePcx(2, 3, []);
      bytes[offset] = value;
      expect(decodePcx(bytes, "bad.pcx")).toEqual({
        kind: "rejected", message: "Bad pcx file bad.pcx (2 x 3) (1 x 2)\n",
      });
    }
    const dimensionCases: readonly [number, number][] = [[1025, 1], [1, 1025], [32769, 1], [65536, 1], [0, 1]];
    for (const [width, height] of dimensionCases) {
      const xmax = (width - 1) & 65535;
      expect(decodePcx(makePcx(width, height, []), "size.pcx")).toEqual({
        kind: "rejected", message: `Bad pcx file size.pcx (${xmax + 1} x ${height}) (${xmax} x ${height - 1})\n`,
      });
    }
  });

  test("rejects an invalid header before accessing absent palette and pixel bytes", () => {
    const bytes = makePcx(1025, 1, []).subarray(0, 12);
    expect(decodePcx(bytes, "header.pcx")).toEqual({
      kind: "rejected", message: "Bad pcx file header.pcx (1025 x 1) (1024 x 0)\n",
    });
  });

  test("allows palette bytes to overlap the header and encoded input", () => {
    const bytes = new Uint8Array(768);
    bytes.set([10, 5, 1, 8]);
    bytes[128] = 0;
    expect([...image(bytes).pixels]).toEqual([10, 5, 1, 255]);
  });

  test("allows RLE input to consume palette bytes and end exactly at EOF", () => {
    const bytes = makePcx(768, 1, [], null);
    bytes.fill(0, 128);
    const decoded = image(bytes);
    expect(decoded.pixels.length).toBe(3072);
    expect([...decoded.pixels.subarray(-4)]).toEqual([0, 0, 0, 255]);
  });

  test("rejects missing accessed header bytes and a palette preceding the input", () => {
    for (let length = 0; length < 12; length++) {
      expect(() => decodePcx(new Uint8Array(length), "short.pcx")).toThrow("short.pcx:0: truncated PCX header");
    }
    for (const length of [12, 127, 128, 767]) {
      expect(() => decodePcx(makePcx(1, 1, []).subarray(0, length), "short.pcx")).toThrow(BinaryError);
    }
  });

  test("rejects truncated packet headers and values without reading past EOF", () => {
    for (const marker of [null, 12]) {
      const bytes = makePcx(1, 1, [], marker);
      bytes.fill(0xc0, 128);
      expect(() => decodePcx(bytes, "eof.pcx")).toThrow(`eof.pcx:${bytes.length}: range of 1 bytes exceeds`);
    }
  });

  test("rejects RLE writes beyond the complete image allocation", () => {
    expect(() => decodePcx(makePcx(2, 1, [0xc3, 1]), "overflow.pcx")).toThrow(
      "overflow.pcx:128: PCX RLE packet overruns image allocation",
    );
    expect(() => decodePcx(makePcx(2, 2, [1, 1, 0xc3, 1]))).toThrow(BinaryError);
  });

  test("honors input byte offsets and owns the returned pixel buffer", () => {
    const bytes = makePcx(1, 1, [9]);
    const container = new Uint8Array(bytes.length + 9);
    container.set(bytes, 4);
    const decoded = image(container.subarray(4, 4 + bytes.length));
    container.fill(0);
    expect([...decoded.pixels]).toEqual([9, 246, 153, 255]);
  });
});
