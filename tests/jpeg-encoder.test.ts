import { describe, expect, test } from "bun:test";
import { encodeJpeg } from "../src/assets/jpeg-encoder.ts";
import { decodeJpeg } from "../src/assets/jpeg.ts";
import type { JpegImage } from "../src/assets/jpeg.ts";

function unexpectedJpegWarning(text: string): undefined {
  throw new Error(`Unexpected JPEG warning: ${text}`);
}

function fixture(width: number, height: number): JpegImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([(x * 17 + y * 3) & 255, (x * 7 + y * 31) & 255,
        (x * 47 + y * 11) & 255, (x + y) & 255], (y * width + x) * 4);
    }
  }
  return { width, height, pixels };
}

function sourceEncode(image: JpegImage, quality: number): Uint8Array {
  const path = process.env["Q3_JPEG_ENCODER_REFERENCE"];
  if (path === undefined) throw new Error("Q3_JPEG_ENCODER_REFERENCE is required for source comparison");
  const result = Bun.spawnSync([path, String(image.width), String(image.height), String(quality)], { stdin: image.pixels });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new Uint8Array(result.stdout);
}

describe("SaveJPG float encoder", () => {
  test("complete stream hashes captured from the pinned source float compressor", () => {
    // Source dbe4ddb10315479fc00086f08e25d968b4b43c49, GCC binary32
    // -O2 -ffp-contract=off -fexcess-precision=standard. The outside-project
    // adapter uses SaveJPG's codec parameters and an ordinary stdio destination.
    const cases = [
      [1, 1, 95, "b75600195202cddab3ec8ea6dbcb5631282780d8c43dbee24d37a15df4f8d241"],
      [9, 7, 37, "63e6cd6f2aa433195867afdf12938bcd8d7ab4842b3d8405cdcc6a18de4da3fd"],
      [17, 19, 95, "65b306559a3f7d31da3f284de8967cdb00ec8a01b12c84cab75b6e22977595d5"],
      [33, 31, 100, "b1f1e4800bf681ac7edac9a81f92f82376bfb44611ad41df4e96499983d198ff"],
      [127, 93, 95, "6e97b3c56f523623cfd894bbf1b5822eb220612bca139a0ccac0d0ac374ba21a"],
    ] satisfies [number, number, number, string][];
    for (const [width, height, quality, expected] of cases) {
      const encoded = encodeJpeg(fixture(width, height), quality);
      expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(expected);
    }
  });

  test("quality clamps to source baseline limits and defaults to screenshot quality95", () => {
    const image = fixture(9, 7);
    expect(encodeJpeg(image)).toEqual(encodeJpeg(image, 95));
    expect(encodeJpeg(image, 0)).toEqual(encodeJpeg(image, 1));
    expect(encodeJpeg(image, -100)).toEqual(encodeJpeg(image, 1));
    expect(encodeJpeg(image, 101)).toEqual(encodeJpeg(image, 100));
    expect(encodeJpeg(image, 500)).toEqual(encodeJpeg(image, 100));
    expect(encodeJpeg(image, 1)).not.toEqual(encodeJpeg(image, 100));
  });

  test("top-down RGBA orientation, alpha independence, subarrays and owned output", () => {
    const image = fixture(16, 32);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) image.pixels.set(y < 16 ? [255, 0, 0, 0] : [0, 0, 255, 0], (y * image.width + x) * 4);
    }
    const original = image.pixels.slice();
    const encoded = encodeJpeg(image);
    expect(image.pixels).toEqual(original);
    const decoded = decodeJpeg(encoded, "top-down RGBA encoder fixture", unexpectedJpegWarning);
    expect([decoded.width, decoded.height]).toEqual([16, 32]);
    const top = decoded.pixels.subarray(0, 4), bottom = decoded.pixels.subarray(31 * 16 * 4, 31 * 16 * 4 + 4);
    expect(top[0]).toBeGreaterThan(250); expect(top[2]).toBeLessThan(5);
    expect(bottom[2]).toBeGreaterThan(250); expect(bottom[0]).toBeLessThan(5);
    for (let index = 3; index < image.pixels.length; index += 4) image.pixels[index] = 255;
    const padded = new Uint8Array(image.pixels.length + 11);
    padded.set(image.pixels, 7);
    expect(encodeJpeg({ ...image, pixels: padded.subarray(7, 7 + image.pixels.length) })).toEqual(encoded);
    const second = encodeJpeg(image);
    second.fill(0);
    expect(encoded[0]).toBe(255);
  });

  test("rejects malformed image and quality boundaries before encoding", () => {
    for (const dimension of [0, -1, 1.5, 65501, Infinity, NaN]) {
      expect(() => encodeJpeg({ width: dimension, height: 1, pixels: new Uint8Array(4) })).toThrow("dimensions");
      expect(() => encodeJpeg({ width: 1, height: dimension, pixels: new Uint8Array(4) })).toThrow("dimensions");
    }
    for (const length of [0, 3, 5]) expect(() => encodeJpeg({ width: 1, height: 1, pixels: new Uint8Array(length) })).toThrow("RGBA");
    for (const quality of [1.5, NaN, Infinity, -Infinity]) expect(() => encodeJpeg(fixture(1, 1), quality)).toThrow("quality");
  });

  test("source destination borrows its exact subarray and flips SaveJPG input rows", () => {
    const image = fixture(127, 93);
    const bottomUp = new Uint8Array(image.pixels.length);
    const stride = image.width * 4;
    for (let row = 0; row < image.height; row++) {
      bottomUp.set(image.pixels.subarray(row * stride, (row + 1) * stride), (image.height - 1 - row) * stride);
    }
    const allocation = new Uint8Array(image.pixels.length + 18).fill(173);
    const destination = allocation.subarray(7, 7 + image.pixels.length);
    const encoded = encodeJpeg({ ...image, pixels: bottomUp }, 95,
      { kind: "source-destination", destination, rowOrder: "bottom-up" });
    expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex"))
      .toBe("6e97b3c56f523623cfd894bbf1b5822eb220612bca139a0ccac0d0ac374ba21a");
    expect(encoded.buffer).toBe(allocation.buffer);
    expect(encoded.byteOffset).toBe(destination.byteOffset);
    expect(allocation.subarray(0, 7)).toEqual(new Uint8Array(7).fill(173));
    expect(allocation.subarray(7 + encoded.length)).toEqual(new Uint8Array(allocation.length - 7 - encoded.length).fill(173));
    expect(image.pixels.subarray((image.height - 1) * stride)).toEqual(bottomUp.subarray(0, stride));
  });

  test("neutral source MCU emits four zero luma blocks and two zero chroma blocks", () => {
    const image = { width: 16, height: 16, pixels: new Uint8Array(16 * 16 * 4).fill(128) };
    const encoded = encodeJpeg(image, 100,
      { kind: "source-destination", destination: new Uint8Array(image.pixels.length), rowOrder: "top-down" });
    // DC=0 and EOB: luma 00 1010 repeated four times; chroma 00 00 twice.
    // These fill exactly four bytes, so flush_bits adds no extra byte.
    expect(encoded.subarray(-6)).toEqual(new Uint8Array([0x28, 0xa2, 0x8a, 0x00, 0xff, 0xd9]));
    expect(decodeJpeg(encoded, "neutral source MCU fixture", unexpectedJpegWarning).pixels).toEqual(Uint8Array.from(image.pixels, (value, index) => index % 4 === 3 ? 255 : value));
  });

  test("source destination rejects mismatched allocations and stops at unsafe exhaustion", () => {
    const image = fixture(1, 1);
    for (const length of [0, 3, 5]) {
      const destination = new Uint8Array(length).fill(173);
      expect(() => encodeJpeg(image, 95, { kind: "source-destination", destination, rowOrder: "bottom-up" }))
        .toThrow("exactly width*height*4");
      expect(destination).toEqual(new Uint8Array(length).fill(173));
    }
    const allocation = new Uint8Array(6).fill(173);
    expect(() => encodeJpeg(image, 95,
      { kind: "source-destination", destination: allocation.subarray(1, 5), rowOrder: "bottom-up" }))
      .toThrow("source buffer exhaustion is unsupported");
    expect(allocation).toEqual(new Uint8Array([173, 255, 216, 255, 224, 173]));
  });

  test("source maximum dimension is accepted with a complete narrow image", () => {
    const encoded = encodeJpeg(fixture(65500, 1), 95);
    const decoded = decodeJpeg(encoded, "maximum-dimension encoder fixture", unexpectedJpegWarning);
    expect([decoded.width, decoded.height]).toEqual([65500, 1]);
    if (process.env["Q3_JPEG_ENCODER_REFERENCE"] !== undefined) expect(encoded).toEqual(sourceEncode(fixture(65500, 1), 95));
  });

  test.skipIf(process.env["Q3_JPEG_ENCODER_REFERENCE"] === undefined)("complete streams match the pinned source on odd MCU edges and quality limits", () => {
    for (const [width, height] of [[1, 1], [2, 2], [8, 8], [9, 7], [15, 17], [17, 19], [33, 31], [127, 93]] satisfies [number, number][]) {
      const image = fixture(width, height);
      for (const quality of [0, 1, 37, 50, 75, 95, 100, 101]) {
        const encoded = encodeJpeg(image, quality);
        const reference = sourceEncode(image, quality);
        expect(encoded).toEqual(reference);
        const decoded = decodeJpeg(encoded, `${width}x${height} quality ${quality} encoder fixture`, unexpectedJpegWarning);
        expect([decoded.width, decoded.height]).toEqual([width, height]);
      }
    }
  });
});
