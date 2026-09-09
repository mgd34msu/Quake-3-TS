// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { createImageColorMappings, prepareImageUpload } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";
import type { ImageInternalFormat } from "../src/render/image-resource.ts";
import type { TextureImage } from "../src/render/types.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

const neutral = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 0,
  deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 });
function profile(changes: Partial<ImageUploadProfile> = {}): ImageUploadProfile {
  return { picmip: 0, roundImagesDown: false, simpleMipMaps: true, colorMipLevels: false,
    textureBits: 0, textureCompression: "none", maxTextureSize: null, colorMappings: neutral, ...changes };
}
function input(width: number, height: number, reds: readonly number[], alpha = 255): TextureImage {
  const pixels = new Uint8Array(width * height * 4);
  if (reds.length !== width * height) throw new Error("Fixture dimensions do not match");
  reds.forEach((red, index) => pixels.set([red, red, red, alpha], index * 4));
  return { width, height, pixels };
}
function upload(source: TextureImage, changes: Partial<ImageUploadProfile> = {}, mipmap = true, allowPicmip = true, name = "fixture") {
  return prepareImageUpload(source, { name, mipmap, allowPicmip }, profile(changes));
}
function reds(pixels: Uint8Array): number[] { return [...pixels].filter((_value, index) => index % 4 === 0); }

describe("source Upload32 preparation", () => {
  test("legacy S3 compression overrides RGB precision but excludes alpha and lightmaps", () => {
    for (const textureBits of [0, 16, 32]) {
      const settings = { textureBits, textureCompression: "s3tc" } satisfies Partial<ImageUploadProfile>;
      const reds = Array.from({ length: 16 }, () => 128);
      expect(upload(input(4, 4, reds), settings).internalFormat).toBe("rgb4-s3tc");
      expect(upload(input(4, 4, reds), settings, true, true, "*lightmap0").internalFormat).toBe("rgb");
      expect(upload(input(4, 4, reds, 254), settings).internalFormat)
        .toBe(textureBits === 16 ? "rgba4" : textureBits === 32 ? "rgba8" : "rgba");
    }
  });
  test("POT simple reductions own all levels and source pixels remain unchanged", () => {
    const source = input(4, 4, Array.from({ length: 16 }, (_, i) => i * 10));
    const result = upload(source);
    expect(result.levels.map(level => [level.width, level.height])).toEqual([[4, 4], [2, 2], [1, 1]]);
    expect(result.levels.map(level => reds(level.pixels))).toEqual([
      Array.from({ length: 16 }, (_, i) => i * 10), [25, 45, 105, 125], [75],
    ]);
    source.pixels.fill(0);
    expect(reds(result.levels[0].pixels)).toEqual(Array.from({ length: 16 }, (_, i) => i * 10));
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.levels)).toBe(true);
  });

  test("NPOT quarter-offset box resampling precedes both round-down and picmip", () => {
    const source = input(3, 3, [0, 10, 20, 30, 40, 50, 60, 70, 80]);
    const up = upload(source, {}, false);
    expect([up.levels[0].width, up.levels[0].height]).toEqual([4, 4]);
    expect(reds(up.levels[0].pixels)).toEqual([0, 5, 15, 20, 15, 20, 30, 35, 45, 50, 60, 65, 60, 65, 75, 80]);
    const down = upload(source, { roundImagesDown: true }, false);
    expect([down.levels[0].width, down.levels[0].height]).toEqual([2, 2]);
    expect(reds(down.levels[0].pixels)).toEqual([20, 30, 50, 60]);
    expect(reds(upload(source, { picmip: 1 }, false).levels[0].pixels)).toEqual([10, 25, 55, 70]);
  });

  test("picmip applies to nonmip scratch flags and is skipped when not allowed", () => {
    const source = input(4, 2, [0, 20, 40, 60, 80, 100, 120, 140]);
    const reduced = upload(source, { picmip: 1 }, false, true, "*scratch");
    expect(reduced.levels.map(level => [level.width, level.height, reds(level.pixels)])).toEqual([[2, 1, [50, 90]]]);
    expect(upload(source, { picmip: 1 }, false, false).levels[0].width).toBe(4);
    expect(reds(upload(source, { picmip: 16 }, false).levels[0].pixels)).toEqual([70]);
  });

  test("hardware limit halves both axes and rejects the source zero-axis domain", () => {
    const result = upload(input(8, 4, new Array<number>(32).fill(7)), { maxTextureSize: 4 });
    expect(result.levels.map(level => [level.width, level.height])).toEqual([[4, 2], [2, 1], [1, 1]]);
    expect(() => upload(input(8, 1, new Array<number>(8).fill(7)), { maxTextureSize: 4 })).toThrow("positive");
  });

  test("source resample max-width drop precedes later picmip and hardware limits", () => {
    expect(() => upload(input(2049, 1, new Array<number>(2049).fill(1)), { picmip: 16, maxTextureSize: 1 })).toThrow("source ERR_DROP");
    expect(() => upload(input(32768, 3, new Array<number>(32768 * 3).fill(1)))).toThrow("source ERR_DROP");
  });

  test("simple one-dimensional tails average pairs while weighted tails retain the prefix", () => {
    for (const [width, height] of [[4, 1], [1, 4]] satisfies readonly (readonly [number, number])[]) {
      const source = input(width, height, [10, 20, 30, 40]);
      expect(upload(source).levels.map(level => reds(level.pixels))).toEqual([[10, 20, 30, 40], [15, 35], [25]]);
      expect(upload(source, { simpleMipMaps: false }).levels.map(level => reds(level.pixels))).toEqual([[10, 20, 30, 40], [10, 20], [10]]);
      expect(reds(upload(source, { simpleMipMaps: false, picmip: 2 }, false).levels[0].pixels)).toEqual([10]);
    }
  });

  test("weighted 4x4 taps wrap periodically and divide by 36 before child publication", () => {
    const source = input(4, 4, [144, ...new Array<number>(15).fill(0)]);
    expect(upload(source, { simpleMipMaps: false }).levels.map(level => reds(level.pixels))).toEqual([
      [144, ...new Array<number>(15).fill(0)], [16, 8, 8, 4], [9],
    ]);
    expect(upload(source).levels.map(level => reds(level.pixels))).toEqual([
      [144, ...new Array<number>(15).fill(0)], [36, 0, 0, 0], [9],
    ]);
  });

  test("color mip tint divides by 512, keeps alpha and feeds subsequent mip generation", () => {
    const result = upload(input(4, 4, new Array<number>(16).fill(100), 200), { colorMipLevels: true });
    expect(result.levels.map(level => [...level.pixels.slice(0, 4)])).toEqual([[100, 100, 100, 200], [88, 24, 24, 200], [21, 69, 5, 200]]);
    expect(() => upload(input(65536, 1, new Array<number>(65536).fill(1)), { colorMipLevels: true })).toThrow("undefined source table");
  });

  test("format scans alpha before reduction, selects source sized formats and honors exact lightmap prefix", () => {
    const alpha = input(2, 1, [100, 100]); alpha.pixels[7] = 254;
    for (const [bits, opaqueFormat, alphaFormat] of [[0, "rgb", "rgba"], [16, "rgb5", "rgba4"], [32, "rgb8", "rgba8"], [24, "rgb", "rgba"]] satisfies readonly (readonly [number, ImageInternalFormat, ImageInternalFormat])[]) {
      expect(upload(input(1, 1, [100]), { textureBits: bits }).internalFormat).toBe(opaqueFormat);
      expect(upload(alpha, { textureBits: bits, picmip: 1 }).internalFormat).toBe(alphaFormat);
      expect(upload(alpha, { textureBits: bits }, true, true, "*lightmap0").internalFormat).toBe("rgb");
      expect(upload(alpha, { textureBits: bits }, true, true, "*LIGHTMAP0").internalFormat).toBe(alphaFormat);
    }
    expect([...upload(alpha, { textureBits: 16 }).levels[0].pixels]).toEqual([...alpha.pixels]);
    const tailAlpha = input(4, 1, [100, 100, 100, 100]); tailAlpha.pixels[15] = 0;
    const prefix = upload(tailAlpha, { simpleMipMaps: false, picmip: 2, textureBits: 16 });
    expect(prefix.levels[0].pixels[3]).toBe(255);
    expect(prefix.internalFormat).toBe("rgba4");
  });

  test("unmipped direct POT and NPOT-resampled paths bypass gamma and intensity", () => {
    const mappings = createImageColorMappings({ gamma: 2, intensity: 2, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 });
    for (const width of [1, 3]) {
      const result = upload(input(width, 1, new Array<number>(width).fill(64), 123), { colorMappings: mappings }, false);
      expect([...result.levels[0].pixels.slice(0, 4)]).toEqual([64, 64, 64, 123]);
    }
    expect([...upload(input(2, 2, [64, 64, 64, 64], 123), { picmip: 1, colorMappings: mappings }, false).levels[0].pixels]).toEqual([128, 128, 128, 123]);
    expect([...upload(input(1, 1, [64], 123), { colorMappings: mappings }).levels[0].pixels]).toEqual([181, 181, 181, 123]);
  });

  test("hardware-gamma uploads use only intensity when mipmapped and no scaling for reduced nonmip images", () => {
    const mappings = createImageColorMappings({ gamma: 2, intensity: 2, requestedOverbrightBits: 0,
      deviceSupportsGamma: true, isFullscreen: true, colorBits: 24 });
    expect(reds(upload(input(1, 1, [64]), { colorMappings: mappings }).levels[0].pixels)).toEqual([128]);
    expect(reds(upload(input(2, 2, [64, 64, 64, 64]), { picmip: 1, colorMappings: mappings }, false).levels[0].pixels)).toEqual([64]);
  });

  test("replacing color tables affects later prepared images only", () => {
    const source = input(1, 1, [64]), first = upload(source);
    const colorMappings = createImageColorMappings({ gamma: 2, intensity: 1, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 });
    expect(reds(upload(source, { colorMappings }).levels[0].pixels)).toEqual([128]);
    expect(reds(first.levels[0].pixels)).toEqual([64]);
  });

  test("unsafe source dimensions, byte counts and native integer conversions reject", () => {
    for (const source of [{ width: 0, height: 1, pixels: new Uint8Array() },
      { width: 1, height: 1, pixels: new Uint8Array(3) },
      { width: 0x40000000, height: 1, pixels: new Uint8Array() }]) expect(() => upload(source)).toThrow(RangeError);
    for (const picmip of [-1, 17, 1.5, Number.NaN]) expect(() => upload(input(1, 1, [0]), { picmip })).toThrow(RangeError);
  });
});

describe("Upload32 common-hunk temporaries", () => {
  test("NPOT reduction keeps both buffers until the normal tail and includes weighted scratch highwater", () => {
    const arena = new HunkArena(256, () => {}), accounting = new SourceHunkAccounting(arena);
    const result = prepareImageUpload(input(3, 3, [0, 10, 20, 30, 40, 50, 60, 70, 80]),
      { name: "npot", mipmap: true, allowPicmip: true }, profile({ picmip: 1, simpleMipMaps: false }),
      { kind: "source-hunk", accounting });
    expect(accounting.report().trace.map(event => [event.action, event.source, event.bytes])).toEqual([
      ["allocate", "Upload32:resampledBuffer", 64], ["allocate", "Upload32:scaledBuffer", 16],
      ["allocate", "R_MipMap2", 16], ["free-temporary", "R_MipMap2", 16],
      ["allocate", "R_MipMap2", 4], ["free-temporary", "R_MipMap2", 4],
    ]);
    expect(arena.memoryRemaining()).toBe(256 - 96);
    expect(arena.snapshot().high.tempHighwater).toBe(120);
    result.finishUpload();
    expect(arena.memoryRemaining()).toBe(256);
    expect(accounting.report().trace.slice(-2).map(event => event.source)).toEqual(["Upload32:scaledBuffer", "Upload32:resampledBuffer"]);
    const traceLength = accounting.report().trace.length;
    result.finishUpload();
    expect(accounting.report().trace.length).toBe(traceLength);
    const reused = arena.allocateTemp(128); reused.bytes.fill(0);
    expect(reds(result.levels[0].pixels)).toEqual([30, 35, 45, 50]);
    arena.freeTemp(reused);
  });

  test("weighted one-dimensional tails still allocate and free source zero-byte blocks", () => {
    const arena = new HunkArena(64, () => {}), accounting = new SourceHunkAccounting(arena);
    const result = prepareImageUpload(input(4, 1, [10, 20, 30, 40]),
      { name: "tail", mipmap: true, allowPicmip: false }, profile({ simpleMipMaps: false }), { kind: "source-hunk", accounting });
    expect(accounting.report().trace.filter(event => event.source === "R_MipMap2").map(event => [event.action, event.bytes, event.reservedBytes])).toEqual([
      ["allocate", 0, 8], ["free-temporary", 0, 0], ["allocate", 0, 8], ["free-temporary", 0, 0],
    ]);
    expect(arena.snapshot().high.tempHighwater).toBe(32);
    expect(result.levels.map(level => reds(level.pixels))).toEqual([[10, 20, 30, 40], [10, 20], [10]]);
    result.finishUpload(); expect(arena.memoryRemaining()).toBe(64);
  });

  test("even direct nonmip images allocate scaledBuffer before bypassing color transforms", () => {
    const arena = new HunkArena(32, () => {}), accounting = new SourceHunkAccounting(arena);
    const result = prepareImageUpload(input(1, 1, [64]), { name: "direct", mipmap: false, allowPicmip: false }, profile(), { kind: "source-hunk", accounting });
    expect(arena.memoryRemaining()).toBe(20);
    expect(accounting.report().trace.map(event => [event.source, event.bytes])).toEqual([["Upload32:scaledBuffer", 4]]);
    result.finishUpload(); expect(arena.memoryRemaining()).toBe(32);
  });

  test("allocation and resample failures retain every earlier source temporary", () => {
    const arena = new HunkArena(96, () => {}), accounting = new SourceHunkAccounting(arena);
    expect(() => prepareImageUpload(input(3, 3, new Array<number>(9).fill(1)),
      { name: "full", mipmap: false, allowPicmip: false }, profile(), { kind: "source-hunk", accounting })).toThrow("failed");
    expect(arena.memoryRemaining()).toBe(24);
    expect(accounting.report().trace.map(event => event.source)).toEqual(["Upload32:resampledBuffer"]);
    const largeArena = new HunkArena(32768, () => {}), large = new SourceHunkAccounting(largeArena);
    expect(() => prepareImageUpload(input(2049, 1, new Array<number>(2049).fill(1)),
      { name: "wide", mipmap: false, allowPicmip: true }, profile({ picmip: 16 }), { kind: "source-hunk", accounting: large })).toThrow("source ERR_DROP");
    expect(largeArena.memoryRemaining()).toBe(32768 - 16392);
    expect(large.report().trace.map(event => event.source)).toEqual(["Upload32:resampledBuffer"]);
  });
});

describe("source R_SetColorMappings", () => {
  test("neutral tables are frozen 256-byte identities", () => {
    expect(neutral.gammaTable).toEqual(Array.from({ length: 256 }, (_, i) => i));
    expect(neutral.intensityTable).toEqual(neutral.gammaTable);
    expect(Object.isFrozen(neutral)).toBe(true);
    expect(Object.isFrozen(neutral.gammaTable)).toBe(true); expect(Object.isFrozen(neutral.intensityTable)).toBe(true);
  });

  test("effective overbright requires fullscreen hardware gamma and respects framebuffer bits", () => {
    for (const [requestedOverbrightBits, deviceSupportsGamma, isFullscreen, colorBits, bits, identity] of [
      [3, true, true, 24, 2, 63], [3, true, true, 16, 1, 127],
      [1, false, true, 24, 0, 255], [1, true, false, 24, 0, 255], [-1, true, true, 24, 0, 255],
    ] satisfies readonly (readonly [number, boolean, boolean, number, number, number])[]) {
      const mappings = createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits, deviceSupportsGamma, isFullscreen, colorBits });
      expect([mappings.overbrightBits, mappings.identityLightByte]).toEqual([bits, identity]);
      expect(mappings.identityLight).toBe(1 / 2 ** bits);
      expect(mappings.gammaTable[64]).toBe(Math.min(255, 64 * 2 ** bits));
    }
  });

  test("float32 gamma inputs precede pow and float32 intensity multiplication precedes truncation", () => {
    const mappings = createImageColorMappings({ gamma: 2, intensity: 1.2, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 });
    expect([mappings.gammaTable[0], mappings.gammaTable[1], mappings.gammaTable[64], mappings.gammaTable[128], mappings.gammaTable[255]])
      .toEqual([0, 16, 128, 181, 255]);
    expect([mappings.intensityTable[5], mappings.intensityTable[10], mappings.intensityTable[200], mappings.intensityTable[255]])
      .toEqual([6, 12, 240, 255]);
  });

  test("clamping belongs to settings; invalid conversion domains are explicit", () => {
    const rounded = createImageColorMappings({ gamma: 0.841, intensity: 1.3, requestedOverbrightBits: 0,
      deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 });
    expect(rounded.gammaTable[131]).toBe(116);
    expect(rounded.intensityTable[10]).toBe(13);
    for (const [gamma, intensity] of [[0.4, 1], [3.1, 1], [1, 0.9], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY], [1, 1e8]] satisfies readonly (readonly [number, number])[]) {
      expect(() => createImageColorMappings({ gamma, intensity, requestedOverbrightBits: 0,
        deviceSupportsGamma: false, isFullscreen: false, colorBits: 24 })).toThrow(RangeError);
    }
  });
});
