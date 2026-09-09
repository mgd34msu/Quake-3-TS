import { describe, expect, test } from "bun:test";
import { BmpDropError, decodeBmp } from "../src/assets/bmp.ts";
import { BinaryError } from "../src/core/binary.ts";

// Synthetic source-layout fixtures, with independently specified expected RGBA.
function bmp(width: number, height: number, depth: number, data: readonly number[] | Uint8Array): Uint8Array {
  const bytes = new Uint8Array(54 + data.length);
  const header = new DataView(bytes.buffer);
  bytes.set([66, 77]);
  header.setUint32(2, bytes.length, true);
  header.setUint32(10, depth === 8 ? 1078 : 54, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, width, true);
  header.setInt32(22, height, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, depth, true);
  bytes.set(data, 54);
  return bytes;
}

function drop(bytes: Uint8Array, source: string): BmpDropError {
  try { decodeBmp(bytes, source); }
  catch (error) {
    if (error instanceof BmpDropError) return error;
    throw error;
  }
  throw new Error("expected source ERR_DROP");
}

describe("LoadBMP source profile", () => {
  test("24-bit BGR rows decode bottom-up without width padding", () => {
    const image = decodeBmp(bmp(2, 2, 24, [
      255, 0, 0, 255, 255, 255,
      0, 0, 255, 0, 255, 0,
    ]));
    expect([image.width, image.height]).toEqual([2, 2]);
    expect([...image.pixels]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]);
  });

  test("32-bit BGRA retains alpha and negative heights remain bottom-up", () => {
    const image = decodeBmp(bmp(1, -2, 32, [3, 2, 1, 0, 6, 5, 4, 127]));
    expect([image.width, image.height]).toEqual([1, 2]);
    expect([...image.pixels]).toEqual([4, 5, 6, 127, 1, 2, 3, 0]);
  });

  test("8-bit indexes use the full BGRA palette and force opaque alpha", () => {
    const palette = new Uint8Array(1024);
    palette.set([13, 12, 11, 0], 0);
    palette.set([23, 22, 21, 5], 255 * 4);
    const bytes = bmp(1, 2, 8, [...palette, 255, 0]);
    const header = new DataView(bytes.buffer);
    header.setUint32(46, 1, true); // Even index 255 is legal with colors = 1.
    expect([...decodeBmp(bytes).pixels]).toEqual([11, 12, 13, 255, 21, 22, 23, 255]);
  });

  test("row padding bytes become pixels on the following row", () => {
    const image = decodeBmp(bmp(1, 2, 24, [3, 2, 1, 99, 6, 5, 4, 88]));
    expect([...image.pixels]).toEqual([5, 6, 99, 255, 1, 2, 3, 255]);
  });

  test("palette rows also consume padding as indexes", () => {
    const palette = new Uint8Array(1024);
    palette.set([3, 2, 1, 0], 4);
    palette.set([6, 5, 4, 0], 8);
    const image = decodeBmp(bmp(1, 2, 8, [...palette, 1, 2, 0, 0, 1, 0, 0, 0]));
    expect([...image.pixels]).toEqual([4, 5, 6, 255, 1, 2, 3, 255]);
  });

  test("ignores reserved, data offset, header size, planes and metadata fields", () => {
    for (const depth of [8, 24, 32]) {
      const palette = new Uint8Array(1024);
      palette.set([3, 2, 1, 33], 4);
      const data = depth === 8 ? [...palette, 1] : [3, 2, 1, 77];
      const bytes = bmp(1, 1, depth, data), header = new DataView(bytes.buffer);
      for (const offset of [6, 10, 14, 34, 38, 42, 46, 50]) header.setUint32(offset, 0xffffffff, true);
      header.setUint16(26, 0xffff, true);
      expect([...decodeBmp(bytes).pixels]).toEqual([1, 2, 3, depth === 32 ? 77 : 255]);
    }
  });

  test("accepts either matching signature byte because the source uses AND", () => {
    for (const signature of [[66, 0], [0, 77], [66, 77]]) {
      const bytes = bmp(1, 1, 24, [3, 2, 1]);
      bytes.set(signature);
      expect([...decodeBmp(bytes).pixels]).toEqual([1, 2, 3, 255]);
    }
    const bytes = bmp(1, 1, 24, [3, 2, 1]);
    bytes.set([0, 0]);
    const error = drop(bytes, "bad.bmp");
    expect(error.source).toBe("bad.bmp");
    expect(error.message).toBe("LoadBMP: only Windows-style BMP files supported (bad.bmp)\n");
  });

  test("preserves exact source diagnostics and their header-validation order", () => {
    const bytes = bmp(1, 1, 4, []), header = new DataView(bytes.buffer);
    header.setUint32(2, 0xffffffff, true);
    header.setUint32(30, 1, true);
    bytes.set([0, 0]);
    expect(drop(bytes, "errors.bmp").message).toBe("LoadBMP: only Windows-style BMP files supported (errors.bmp)\n");
    bytes.set([66, 77]);
    expect(drop(bytes, "errors.bmp").message).toBe("LoadBMP: header size does not match file size (-1 vs. 54) (errors.bmp)\n");
    header.setUint32(2, bytes.length, true);
    expect(drop(bytes, "errors.bmp").message).toBe("LoadBMP: only uncompressed BMP files supported (errors.bmp)\n");
    header.setUint32(30, 0, true);
    expect(drop(bytes, "errors.bmp").message).toBe("LoadBMP: monochrome and 4-bit BMP files not supported (errors.bmp)\n");
    for (const depth of [9, 15, 48, 65535]) {
      header.setUint16(28, depth, true);
      expect(drop(bytes, "errors.bmp").message).toBe(`LoadBMP: illegal pixel_size '${depth}' in file 'errors.bmp'\n`);
    }
  });

  test("requires the file size to include trailing bytes exactly", () => {
    const bytes = bmp(1, 1, 24, [3, 2, 1, 9, 9]);
    expect([...decodeBmp(bytes).pixels]).toEqual([1, 2, 3, 255]);
    new DataView(bytes.buffer).setUint32(2, 57, true);
    expect(drop(bytes, "trailing.bmp").message).toBe("LoadBMP: header size does not match file size (57 vs. 59) (trailing.bmp)\n");
  });

  test("checks every truncated header and incomplete palette boundary", () => {
    const complete = bmp(1, 1, 24, [3, 2, 1]);
    for (let length = 0; length < 54; length++) {
      expect(() => decodeBmp(complete.subarray(0, length), "short.bmp")).toThrow(BinaryError);
    }
    for (const length of [0, 1, 1023]) {
      expect(() => decodeBmp(bmp(1, 1, 8, [...new Uint8Array(length)]), "palette.bmp"))
        .toThrow(`palette.bmp:54: range of 1024 bytes exceeds ${54 + length}-byte input`);
    }
  });

  test("rejects truncated pixels with a boundary error, separate from source drops", () => {
    for (const depth of [8, 24, 32]) {
      const prefix = depth === 8 ? [...new Uint8Array(1024)] : [];
      for (let length = 0; length < depth / 8; length++) {
        expect(() => decodeBmp(bmp(1, 1, depth, [...prefix, ...new Uint8Array(length)]), "pixel.bmp"))
          .toThrow(`pixel.bmp:${depth === 8 ? 1078 : 54}: truncated BMP pixel data`);
      }
    }
  });

  test("explicitly rejects the source-indeterminate nonempty 16-bit output path", () => {
    const bytes = bmp(1, 1, 16, [0xff, 0x7f]);
    expect(() => decodeBmp(bytes, "unsafe.bmp")).toThrow(BinaryError);
    expect(() => decodeBmp(bytes, "unsafe.bmp")).toThrow(
      "unsafe.bmp:28: 16-bit LoadBMP source path reads uninitialized output and writes beyond its allocation; unsupported source-indeterminate pixels",
    );
    new DataView(bytes.buffer).setUint32(30, 1, true);
    expect(drop(bytes, "unsafe.bmp").message).toBe("LoadBMP: only uncompressed BMP files supported (unsafe.bmp)\n");
  });

  test("empty images do not reach illegal-depth or 16-bit pixel branches", () => {
    for (const depth of [16, 24, 48]) {
      for (const [width, height] of [[0, 2], [2, 0]]) {
        if (width === undefined || height === undefined) throw new Error("fixture dimensions missing");
        const image = decodeBmp(bmp(width, height, depth, []));
        expect([image.width, image.height, image.pixels.length]).toEqual([width, height, 0]);
      }
    }
  });

  test("rejects undefined signed dimensions and overflowing source allocation arithmetic", () => {
    expect(() => decodeBmp(bmp(-1, 1, 24, []))).toThrow("negative BMP width -1");
    expect(() => decodeBmp(bmp(1, -0x80000000, 24, []))).toThrow("BMP height negation overflows signed 32-bit source arithmetic");
    expect(() => decodeBmp(bmp(4097, 4096, 24, []))).toThrow("truncated BMP pixel data");
    expect(() => decodeBmp(bmp(4096, 4096, 24, []))).toThrow("truncated BMP pixel data");
    expect(() => decodeBmp(bmp(0x1fffffff, 1, 24, []))).toThrow("truncated BMP pixel data");
    expect(() => decodeBmp(bmp(0x20000000, 1, 24, []))).toThrow("overflows signed 32-bit source allocation arithmetic");
    expect(() => decodeBmp(bmp(0x7fffffff, 0x7fffffff, 24, []))).toThrow("overflows signed 32-bit source allocation arithmetic");
  });

  test("decodes valid packed 24-bit output above 64 MiB", () => {
    const width = 4097, height = 4096;
    const data = new Uint8Array(width * height * 3);
    data.set([3, 2, 1], 0);
    data.set([6, 5, 4], (width - 1) * 3);
    data.set([9, 8, 7], (height - 1) * width * 3);
    data.set([12, 11, 10], data.length - 3);
    const image = decodeBmp(bmp(width, height, 24, data));
    expect([image.width, image.height, image.pixels.length]).toEqual([width, height, 67125248]);
    expect([...image.pixels.subarray(0, 4)]).toEqual([7, 8, 9, 255]);
    expect([...image.pixels.subarray((width - 1) * 4, width * 4)]).toEqual([10, 11, 12, 255]);
    const bottom = (height - 1) * width * 4;
    expect([...image.pixels.subarray(bottom, bottom + 4)]).toEqual([1, 2, 3, 255]);
    expect([...image.pixels.subarray(-4)]).toEqual([4, 5, 6, 255]);
    let opaquePixels = 0;
    for (let offset = 3; offset < image.pixels.length; offset += 4) {
      if (image.pixels[offset] === 255) opaquePixels++;
    }
    expect(opaquePixels).toBe(width * height);
  });

  test("honors Uint8Array subviews and returns owned pixel storage", () => {
    const bytes = bmp(1, 1, 32, [3, 2, 1, 7]), container = new Uint8Array(bytes.length + 16);
    container.set(bytes, 5);
    const image = decodeBmp(container.subarray(5, 5 + bytes.length));
    container.fill(0);
    expect([...image.pixels]).toEqual([1, 2, 3, 7]);
  });
});
