// Ported from id Software's code/renderer/tr_image.c LoadPCX and LoadPCX32.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { ImageData } from "./tga.ts";

export interface PcxRejection {
  readonly kind: "rejected";
  readonly message: string;
}

export interface IndexedPcxImage {
  readonly width: number;
  readonly height: number;
  readonly indices: Uint8Array;
  readonly palette: Uint8Array;
}

// Header rejection is the source PRINT_ALL/null outcome. Unsafe source memory
// accesses throw BinaryError for the caller's malformed-input policy.
export function decodePcxIndexed(bytes: Uint8Array, source = "<buffer>"): IndexedPcxImage | PcxRejection {
  const reader = new BinaryReader(bytes, source);
  if (reader.length < 12) throw new BinaryError(source, 0, "truncated PCX header");
  const manufacturer = reader.u8();
  const version = reader.u8();
  const encoding = reader.u8();
  const bitsPerPixel = reader.u8();
  reader.skip(4);
  // qfiles.h uses unsigned shorts; Linux !idppc LittleShort is an empty macro.
  const xmax = reader.u16();
  const ymax = reader.u16();
  const width = xmax + 1;
  const height = ymax + 1;
  if (manufacturer !== 0x0a || version !== 5 || encoding !== 1 || bitsPerPixel !== 8
    || xmax >= 1024 || ymax >= 1024) {
    return { kind: "rejected", message: `Bad pcx file ${source} (${width} x ${height}) (${xmax} x ${ymax})\n` };
  }

  if (reader.length < 768) throw new BinaryError(source, reader.length - 768, "PCX palette precedes input");
  const indices = new Uint8Array(width * height);
  const palette = reader.section(reader.length - 768, 768).bytes(768);
  reader.seek(128);
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const packetOffset = reader.offset;
      let dataByte = reader.u8();
      let runLength = 1;
      if ((dataByte & 0xc0) === 0xc0) {
        runLength = dataByte & 0x3f;
        dataByte = reader.u8();
      }
      const destination = y * width + x;
      if (runLength > indices.length - destination) {
        throw new BinaryError(source, packetOffset, "PCX RLE packet overruns image allocation");
      }
      // The source permits a run to cross a row; the next row restarts at x=0
      // and overwrites those cells. It never skips bytes_per_line padding.
      indices.fill(dataByte, destination, destination + runLength);
      x += runLength;
    }
  }

  return { width, height, indices, palette };
}

/** LoadPCX32 expands owned index and palette allocations after FS_FreeFile. */
export function expandPcx(image: IndexedPcxImage): ImageData {
  const palette = new BinaryReader(image.palette);
  const pixels = new Uint8Array(image.indices.length * 4);
  let destination = 0;
  for (const index of image.indices) {
    palette.seek(index * 3);
    pixels[destination++] = palette.u8();
    pixels[destination++] = palette.u8();
    pixels[destination++] = palette.u8();
    pixels[destination++] = 255;
  }
  return { width: image.width, height: image.height, pixels };
}

export function decodePcx(bytes: Uint8Array, source = "<buffer>"): ImageData | PcxRejection {
  const decoded = decodePcxIndexed(bytes, source);
  return "kind" in decoded ? decoded : expandPcx(decoded);
}
