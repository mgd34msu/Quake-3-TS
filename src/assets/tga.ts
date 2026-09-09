// Ported from id Software's code/renderer/tr_image.c LoadTGA.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError, BinaryReader } from "../core/binary.ts";

export interface ImageData {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

const TGA_HEADER_SIZE = 18;

function reject(source: string, offset: number, message: string): never {
  throw new BinaryError(source, offset, message);
}

function writePixel(
  output: Uint8Array,
  sourcePixel: number,
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
): void {
  const sourceY = Math.floor(sourcePixel / width);
  const sourceX = sourcePixel - sourceY * width;
  const destination = ((height - sourceY - 1) * width + sourceX) * 4;
  output[destination] = red;
  output[destination + 1] = green;
  output[destination + 2] = blue;
  output[destination + 3] = alpha;
}

function readAndWritePixel(
  reader: BinaryReader,
  output: Uint8Array,
  sourcePixel: number,
  width: number,
  height: number,
  pixelDepth: number,
): void {
  if (pixelDepth === 8) {
    const intensity = reader.u8();
    writePixel(output, sourcePixel, width, height, intensity, intensity, intensity, 255);
    return;
  }

  const blue = reader.u8();
  const green = reader.u8();
  const red = reader.u8();
  const alpha = pixelDepth === 32 ? reader.u8() : 255;
  writePixel(output, sourcePixel, width, height, red, green, blue, alpha);
}

// LoadTGA always traverses bottom-up, left-to-right; its origin flip is disabled.
export function decodeTga(bytes: Uint8Array, source = "<buffer>",
  warning: (text: string) => undefined = () => undefined): ImageData {
  const reader = new BinaryReader(bytes, source);
  if (reader.length < TGA_HEADER_SIZE) reject(source, 0, "truncated TGA header");

  const idLength = reader.u8();
  const colorMapType = reader.u8();
  const imageType = reader.u8();
  reader.skip(5);
  reader.skip(4);
  const width = reader.u16();
  const height = reader.u16();
  const pixelDepth = reader.u8();
  const descriptor = reader.u8();

  if (imageType !== 2 && imageType !== 3 && imageType !== 10) {
    reject(source, 2, `unsupported TGA image type ${imageType}`);
  }
  if (colorMapType !== 0) reject(source, 1, "color-mapped TGA images are unsupported");
  if (pixelDepth !== 24 && pixelDepth !== 32 && !(imageType === 3 && pixelDepth === 8)) {
    reject(source, 16, `unsupported ${pixelDepth}-bit depth for TGA image type ${imageType}`);
  }
  if (width === 0 || height === 0) reject(source, 12, `invalid TGA dimensions ${width}x${height}`);

  reader.skip(idLength);
  const pixelCount = width * height;
  const outputLength = pixelCount * 4;
  const bytesPerPixel = pixelDepth / 8;
  if (imageType === 10) {
    const minimumBytes = Math.ceil(pixelCount / 128) * (bytesPerPixel + 1);
    if (reader.remaining < minimumBytes) reject(source, reader.offset, "truncated TGA RLE pixel data");
  } else {
    const requiredBytes = pixelCount * bytesPerPixel;
    if (reader.remaining < requiredBytes) reject(source, reader.offset, "truncated TGA pixel data");
  }

  // LoadTGA computes numPixels*4 in signed int before calling ri.Malloc.
  if (outputLength > 0x7fffffff) {
    reject(source, 12, `decoded TGA size ${outputLength} overflows the source signed-int allocation`);
  }
  const output = new Uint8Array(outputLength);

  if (imageType !== 10) {
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      readAndWritePixel(reader, output, pixel, width, height, pixelDepth);
    }
  } else {
    let pixel = 0;
    while (pixel < pixelCount) {
      const packetHeader = reader.u8();
      const packetLength = (packetHeader & 0x7f) + 1;
      // The source leaves both packet loops at the last image pixel. A raw
      // packet's unused tail is not read, even when the packet claims more data.
      const packetEnd = Math.min(pixel + packetLength, pixelCount);

      if ((packetHeader & 0x80) !== 0) {
        const blue = reader.u8();
        const green = reader.u8();
        const red = reader.u8();
        const alpha = pixelDepth === 32 ? reader.u8() : 255;
        while (pixel < packetEnd) {
          writePixel(output, pixel, width, height, red, green, blue, alpha);
          pixel++;
        }
      } else {
        while (pixel < packetEnd) {
          readAndWritePixel(reader, output, pixel, width, height, pixelDepth);
          pixel++;
        }
      }
    }
  }

  if ((descriptor & 0x20) !== 0) {
    warning(`WARNING: '${source}' TGA file header declares top-down image, ignoring\n`);
  }
  return { width, height, pixels: output };
}
