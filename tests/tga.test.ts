import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryError } from "../src/core/binary.ts";
import { decodeTga } from "../src/assets/tga.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";

function makeTga(
  imageType: number,
  width: number,
  height: number,
  pixelDepth: number,
  descriptor: number,
  pixels: readonly number[],
  id: readonly number[] = [],
  colorMapType = 0,
): Uint8Array {
  const output = new Uint8Array(18 + id.length + pixels.length);
  const view = new DataView(output.buffer);
  output[0] = id.length;
  output[1] = colorMapType;
  output[2] = imageType;
  view.setUint16(12, width, true);
  view.setUint16(14, height, true);
  output[16] = pixelDepth;
  output[17] = descriptor;
  output.set(id, 18);
  output.set(pixels, 18 + id.length);
  return output;
}

const CANONICAL_2_BY_2 = [
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
];

describe("TGA decoding", () => {
  test("decodes bottom-left 24-bit BGR into top-left RGBA", () => {
    const image = decodeTga(makeTga(2, 2, 2, 24, 0, [
      255, 0, 0, 255, 255, 255,
      0, 0, 255, 0, 255, 0,
    ]));
    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect([...image.pixels]).toEqual(CANONICAL_2_BY_2);
  });

  test("ignores top and right origin flags for source row traversal", () => {
    // LoadTGA's origin flip is #if 0; every active pixel loop starts at rows-1.
    for (const descriptor of [0, 0x10, 0x20, 0x30]) {
      for (const imageType of [2, 3, 10]) {
        const pixels = [255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0];
        const encoded = imageType === 10 ? [3, ...pixels] : pixels;
        const image = decodeTga(makeTga(imageType, 2, 2, 24, descriptor, encoded));
        expect([...image.pixels]).toEqual(CANONICAL_2_BY_2);
      }
    }
  });

  test("prints the source top-down warning after decoding all pixels", () => {
    for (const imageType of [2, 3, 10]) {
      const pixels = [255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0];
      const encoded = makeTga(imageType, 2, 2, 24, 0x30, imageType === 10 ? [3, ...pixels] : pixels);
      const warnings: string[] = [];
      const image = decodeTga(encoded, "Origin.TGA", text => {
        warnings.push(text);
        encoded.fill(0, 18);
        return undefined;
      });
      expect([...image.pixels]).toEqual(CANONICAL_2_BY_2);
      expect(warnings).toEqual(["WARNING: 'Origin.TGA' TGA file header declares top-down image, ignoring\n"]);
    }
  });

  test("omits the top-down warning when its source call is not reached", () => {
    const warnings: string[] = [];
    const warning = (text: string): undefined => { warnings.push(text); return undefined; };
    decodeTga(makeTga(2, 1, 1, 24, 0x10, [30, 20, 10]), "right.tga", warning);
    expect(() => decodeTga(makeTga(2, 1, 1, 24, 0x20, []), "short.tga", warning)).toThrow(BinaryError);
    expect(warnings).toEqual([]);

    const failure = new Error("warning failed");
    const brokenWarning = (): never => { throw failure; };
    expect(() => decodeTga(makeTga(3, 1, 1, 8, 0x20, [0]), "gray.tga", brokenWarning)).toThrow(failure);
  });

  test("decodes 8-bit grayscale and skips the image ID", () => {
    const image = decodeTga(makeTga(3, 2, 1, 8, 0x20, [0, 200], [65, 66, 67]));
    expect([...image.pixels]).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
  });

  test("preserves alpha from uncompressed 32-bit pixels", () => {
    const image = decodeTga(makeTga(2, 1, 1, 32, 0x28, [30, 20, 10, 7]));
    expect([...image.pixels]).toEqual([10, 20, 30, 7]);
  });

  test("decodes type-3 24-bit and 32-bit pixels using the source depth switch", () => {
    const rgb = decodeTga(makeTga(3, 2, 1, 24, 0, [30, 20, 10, 60, 50, 40]));
    expect([...rgb.pixels]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const rgba = decodeTga(makeTga(3, 2, 1, 32, 0, [30, 20, 10, 7, 60, 50, 40, 9]));
    expect([...rgba.pixels]).toEqual([10, 20, 30, 7, 40, 50, 60, 9]);
  });

  test("decodes RLE and raw packets that cross scanline boundaries", () => {
    const image = decodeTga(makeTga(10, 3, 2, 24, 0, [
      0x83, 0, 0, 255,
      0x01, 255, 0, 0, 0, 255, 0,
    ]));
    expect([...image.pixels]).toEqual([
      255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    ]);
  });

  test("stops final RLE packets at the source image boundary", () => {
    // Both source packet loops leave through breakOut at the final pixel.
    const repeated = decodeTga(makeTga(10, 2, 2, 32, 0, [0xff, 30, 20, 10, 7]));
    expect([...repeated.pixels]).toEqual([
      10, 20, 30, 7, 10, 20, 30, 7,
      10, 20, 30, 7, 10, 20, 30, 7,
    ]);
    const raw = decodeTga(makeTga(10, 2, 2, 24, 0, [
      0x7f, 255, 0, 0, 255, 255, 255,
      0, 0, 255, 0, 255, 0,
    ]));
    expect([...raw.pixels]).toEqual(CANONICAL_2_BY_2);
    const mixed = decodeTga(makeTga(10, 3, 2, 24, 0, [
      0x83, 0, 0, 255,
      0x7f, 255, 0, 0, 0, 255, 0,
    ]));
    expect([...mixed.pixels]).toEqual([
      255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    ]);
  });

  test("rejects truncated pixels reached before the final RLE image boundary", () => {
    const incomplete = makeTga(10, 2, 2, 24, 0, [0x7f, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => decodeTga(incomplete, "raw.tga")).toThrow("raw.tga:28: range of 1 bytes exceeds 28-byte input");
    expect(() => decodeTga(makeTga(10, 1, 1, 32, 0, [0xff, 0, 0, 0]))).toThrow(BinaryError);
  });

  test("rejects unsupported and malformed images with source offsets", () => {
    expect(() => decodeTga(new Uint8Array(17), "short.tga")).toThrow("short.tga:0: truncated TGA header");
    expect(() => decodeTga(makeTga(1, 1, 1, 8, 0, []), "mapped.tga")).toThrow("unsupported TGA image type");
    expect(() => decodeTga(makeTga(2, 1, 1, 24, 0, [], [], 1), "mapped.tga")).toThrow("color-mapped");
    expect(() => decodeTga(makeTga(2, 1, 1, 16, 0, []))).toThrow("unsupported 16-bit depth");
    expect(() => decodeTga(makeTga(3, 1, 1, 16, 0, []))).toThrow("unsupported 16-bit depth");
    expect(() => decodeTga(makeTga(2, 1, 1, 8, 0, [0]))).toThrow("unsupported 8-bit depth");
    expect(() => decodeTga(makeTga(10, 1, 1, 8, 0, [0x80, 0]))).toThrow("unsupported 8-bit depth");
    expect(() => decodeTga(makeTga(2, 0, 1, 24, 0, []))).toThrow("invalid TGA dimensions");
    expect(() => decodeTga(makeTga(2, 1, 1, 24, 0, [0, 0]))).toThrow(BinaryError);
  });

  test("decodes source-valid RLE images larger than 64 MiB", () => {
    const width = 4097;
    const height = 4096;
    const packetCount = width * height / 128;
    const encoded = new Uint8Array(18 + packetCount * 5);
    encoded.set(makeTga(10, width, height, 32, 0, []));
    for (let packet = 0; packet < packetCount; packet++) {
      encoded.set([0xff, 30, 20, packet % 256, 7], 18 + packet * 5);
    }
    const image = decodeTga(encoded, "large.tga");
    expect([image.width, image.height, image.pixels.length]).toEqual([width, height, 67125248]);
    for (const { x, y } of [{ x: 0, y: 0 }, { x: 4096, y: 0 }, { x: 0, y: 4095 },
      { x: 4096, y: 4095 }, { x: 128, y: 2048 }]) {
      const destination = (y * width + x) * 4;
      const packet = Math.floor(((height - y - 1) * width + x) / 128);
      expect([...image.pixels.subarray(destination, destination + 4)]).toEqual([packet % 256, 20, 30, 7]);
    }
  });

  test("rejects truncated large RLE images before allocating decoded storage", () => {
    const hostile = makeTga(10, 32767, 32767, 24, 0, []);
    expect(() => decodeTga(hostile, "allocation-bomb.tga")).toThrow(
      "allocation-bomb.tga:18: truncated TGA RLE pixel data",
    );

    const limitBoundary = makeTga(10, 4096, 4096, 24, 0, []);
    expect(() => decodeTga(limitBoundary, "limit.tga")).toThrow("truncated TGA RLE pixel data");
  });

  test("rejects source signed-int allocation overflow without allocating decoded storage", () => {
    // Enough encoded bytes for the minimum-length RLE stream, but numPixels*4
    // would overflow LoadTGA's signed int before ri.Malloc receives it.
    const encoded = new Uint8Array(18 + 32768 * 16384 / 128 * 4);
    encoded.set(makeTga(10, 32768, 16384, 24, 0, []));
    expect(() => decodeTga(encoded, "overflow.tga")).toThrow(
      "overflow.tga:12: decoded TGA size 2147483648 overflows the source signed-int allocation",
    );
  });
});

const retailRoot = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"));

test.skipIf(!retailAvailable)("loads known uncompressed and RLE retail images through the VFS", async () => {
  const hasMissionpack = existsSync(join(retailRoot, "missionpack", "pak0.pk3"));
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: hasMissionpack ? "missionpack" : "baseq3" });
  const bigChars = decodeTga(await vfs.read("gfx/2d/bigchars.tga"), "gfx/2d/bigchars.tga");
  expect([bigChars.width, bigChars.height, bigChars.pixels.length]).toEqual([256, 256, 256 * 256 * 4]);
  if (hasMissionpack) {
    const backTile = decodeTga(await vfs.read("gfx/2d/backtile.tga"), "gfx/2d/backtile.tga");
    expect([backTile.width, backTile.height, backTile.pixels.length]).toEqual([64, 64, 64 * 64 * 4]);
  }
});
