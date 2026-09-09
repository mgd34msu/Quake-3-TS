// Ported from id Software's code/renderer/tr_image.c LoadBMP.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { ImageData } from "./tga.ts";

/** The source caller must dispatch this message through ERR_DROP. */
export class BmpDropError extends Error {
  constructor(readonly source: string, message: string) {
    super(message);
    this.name = "BmpDropError";
  }
}

/** Historical 32-bit LoadBMP profile, including its offset and row-order quirks. */
export function decodeBmp(bytes: Uint8Array, source = "<buffer>"): ImageData {
  const reader = new BinaryReader(bytes, source);
  const id0 = reader.u8(), id1 = reader.u8();
  const fileSize = reader.u32();
  reader.skip(12); // Reserved field, pixel offset and DIB header size are unused.
  const width = reader.i32(), signedHeight = reader.i32();
  reader.skip(2); // Planes is unused.
  const bitsPerPixel = reader.u16(), compression = reader.u32();
  reader.skip(20); // Data size, resolution and color counts are unused.

  // C copies 1024 bytes unconditionally, even beyond short truecolor inputs.
  // Only 8-bit pixels consume that palette; omit the unused unsafe copy.
  const palette = bitsPerPixel === 8 ? new DataView(reader.bytes(1024).buffer) : null;

  if (id0 !== 66 && id1 !== 77) {
    throw new BmpDropError(source, `LoadBMP: only Windows-style BMP files supported (${source})\n`);
  }
  if (fileSize !== bytes.length) {
    throw new BmpDropError(source,
      `LoadBMP: header size does not match file size (${fileSize | 0} vs. ${bytes.length}) (${source})\n`);
  }
  if (compression !== 0) {
    throw new BmpDropError(source, `LoadBMP: only uncompressed BMP files supported (${source})\n`);
  }
  if (bitsPerPixel < 8) {
    throw new BmpDropError(source, `LoadBMP: monochrome and 4-bit BMP files not supported (${source})\n`);
  }

  // Negative width and negating INT_MIN escape the source's defined allocation profile.
  if (width < 0) throw new BinaryError(source, 18, `negative BMP width ${width}`);
  if (signedHeight === -0x80000000) throw new BinaryError(source, 22, "BMP height negation overflows signed 32-bit source arithmetic");
  const height = Math.abs(signedHeight), outputLength = width * height * 4;
  if (!Number.isSafeInteger(outputLength) || outputLength > 0x7fffffff) {
    throw new BinaryError(source, 18, `decoded BMP size ${outputLength} overflows signed 32-bit source allocation arithmetic`);
  }
  // The source never reaches its pixel-size switch for an empty image.
  if (outputLength === 0) return { width, height, pixels: new Uint8Array(0) };
  if (bitsPerPixel === 16) {
    throw new BinaryError(source, 28,
      "16-bit LoadBMP source path reads uninitialized output and writes beyond its allocation; unsupported source-indeterminate pixels");
  }
  if (bitsPerPixel !== 8 && bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new BmpDropError(source, `LoadBMP: illegal pixel_size '${bitsPerPixel}' in file '${source}'\n`);
  }
  const requiredBytes = width * height * (bitsPerPixel / 8);
  if (reader.remaining < requiredBytes) throw new BinaryError(source, reader.offset, "truncated BMP pixel data");

  const pixels = new Uint8Array(outputLength);
  // Negative source heights still use this bottom-up traversal. Rows are packed.
  for (let row = height - 1; row >= 0; row--) {
    let destination = row * width * 4;
    for (let column = 0; column < width; column++) {
      if (palette !== null) {
        const index = reader.u8() * 4;
        pixels[destination++] = palette.getUint8(index + 2);
        pixels[destination++] = palette.getUint8(index + 1);
        pixels[destination++] = palette.getUint8(index);
        pixels[destination++] = 255;
      } else {
        const blue = reader.u8(), green = reader.u8(), red = reader.u8();
        pixels[destination++] = red;
        pixels[destination++] = green;
        pixels[destination++] = blue;
        pixels[destination++] = bitsPerPixel === 32 ? reader.u8() : 255;
      }
    }
  }
  return { width, height, pixels };
}
