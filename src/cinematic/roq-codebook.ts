// Ported from id Software's code/client/cl_cin.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError, BinaryReader } from "../core/binary.ts";

export type RoqCodebookMode = "normal" | "half" | "smoothed-double";
export type RoqCodebookFormat =
  | { readonly samplesPerPixel: 1; readonly gray: Uint8Array }
  | { readonly samplesPerPixel: 2 | 4 };

function chroma(coefficient: number, value: number, bias: number): number {
  const factor = Math.fround(Math.fround(Math.fround(coefficient) / 2) * 64 + 0.5);
  return Math.trunc(Math.fround(Math.fround(factor * value) + bias));
}

function validateYuv(y: number, u: number, v: number): void {
  if (!Number.isInteger(y) || y < 0 || y > 255 || !Number.isInteger(u) || u < 0 || u > 255
    || !Number.isInteger(v) || v < 0 || v > 255) throw new RangeError("RoQ YUV values must be bytes");
}

/** ROQ_GenYUVTables and yuv_to_rgb, retaining the separate 5/6/5-bit shifts. */
export function yuvToRgb565(y: number, u: number, v: number): number {
  validateYuv(y, u, v);
  const yy = (y << 6) | (y >> 2);
  const xU = 2 * u - 255;
  const xV = 2 * v - 255;
  const r = Math.max(0, Math.min(31, (yy + chroma(1.402, xV, 32)) >> 9));
  const g = Math.max(0, Math.min(63, (yy + chroma(0.34414, -xU, 0) + chroma(0.71414, -xV, 32)) >> 8));
  const b = Math.max(0, Math.min(31, (yy + chroma(1.772, xU, 32)) >> 9));
  return (r << 11) | (g << 5) | b;
}

/** yuv_to_rgb24 represented as a little-endian RGBA word. */
export function yuvToRgba(y: number, u: number, v: number): number {
  validateYuv(y, u, v);
  const yy = (y << 6) | (y >> 2);
  const xU = 2 * u - 255;
  const xV = 2 * v - 255;
  const r = Math.max(0, Math.min(255, (yy + chroma(1.402, xV, 32)) >> 6));
  const g = Math.max(0, Math.min(255, (yy + chroma(0.34414, -xU, 0) + chroma(0.71414, -xV, 32)) >> 6));
  const b = Math.max(0, Math.min(255, (yy + chroma(1.772, xU, 32)) >> 6));
  return (r | (g << 8) | (b << 16) | 0xff000000) >>> 0;
}

/** Source global unsigned-short allocations, shared by every codebook pixel/size profile. */
export class SourceRoqCodebooks {
  readonly vq2 = new Uint16Array(256 * 16 * 4);
  readonly vq4 = new Uint16Array(256 * 64 * 4);
  readonly vq8 = new Uint16Array(256 * 256 * 4);
  readonly book2 = new Uint8Array(this.vq2.buffer);
  readonly book4 = new Uint8Array(this.vq4.buffer);
  readonly book8 = new Uint8Array(this.vq8.buffer);
  private readonly pixels = new DataView(this.vq2.buffer);

  clear(): void { this.vq2.fill(0); this.vq4.fill(0); this.vq8.fill(0); }

  decode(reader: BinaryReader, flags: number, mode: RoqCodebookMode, format: RoqCodebookFormat,
    profile: "source" | "diagnostic-2x2" = "source"): void {
    if (!Number.isInteger(flags) || flags < 0 || flags > 65535) {
      throw new BinaryError(reader.source, reader.offset, "invalid RoQ codebook flags");
    }
    if (format.samplesPerPixel === 1 && format.gray.length < 256) {
      throw new BinaryError(reader.source, reader.offset, "RoQ gray lookup requires at least 256 bytes");
    }
    const count2 = (flags >>> 8) === 0 ? 256 : flags >>> 8;
    let count4 = flags === 0 ? 256 : flags & 255;
    const width = format.samplesPerPixel;
    const cellPixels = mode === "half" ? 2 : mode === "normal" ? 4 : 8;
    let cursor = 0;
    const gray = format.samplesPerPixel === 1
      ? new DataView(format.gray.buffer, format.gray.byteOffset, format.gray.byteLength) : null;
    const write = (y: number, u: number, v: number): void => {
      if (gray !== null) this.pixels.setUint8(cursor, gray.getUint8(y));
      else if (width === 2) this.pixels.setUint16(cursor, yuvToRgb565(y, u, v), true);
      else this.pixels.setUint32(cursor, yuvToRgba(y, u, v), true);
      cursor += width;
    };
    for (let index = 0; index < count2; index++) {
      if (gray !== null && mode !== "smoothed-double") {
        // Gray normal/half publish each lookup before reading the next source byte.
        write(reader.u8(), 0, 0);
        if (mode === "half") {
          reader.skip(1);
          write(reader.u8(), 0, 0);
          reader.skip(3);
        } else {
          write(reader.u8(), 0, 0);
          write(reader.u8(), 0, 0);
          write(reader.u8(), 0, 0);
          reader.skip(2);
        }
        continue;
      }
      const y0 = reader.u8();
      if (mode === "half") {
        reader.skip(1);
        const y2 = reader.u8();
        reader.skip(1);
        const u = reader.u8();
        const v = reader.u8();
        write(y0, u, v);
        write(y2, u, v);
        continue;
      }
      const y1 = reader.u8();
      const y2 = reader.u8();
      const y3 = reader.u8();
      let u = 0;
      let v = 0;
      if (gray !== null) reader.skip(2);
      else { u = reader.u8(); v = reader.u8(); }
      write(y0, u, v);
      write(y1, u, v);
      if (mode === "smoothed-double") {
        write(Math.trunc((y0 * 3 + y2) / 4), u, v);
        write(Math.trunc((y1 * 3 + y3) / 4), u, v);
        write(Math.trunc((y0 + y2 * 3) / 4), u, v);
        write(Math.trunc((y1 + y3 * 3) / 4), u, v);
      }
      write(y2, u, v);
      write(y3, u, v);
    }
    // Preserve the existing complete-file diagnostic extension; source flags zero require both tables.
    if (profile === "diagnostic-2x2" && flags === 0 && reader.remaining === 0) count4 = 0;
    const rowPixels = mode === "half" ? 1 : 2;
    const rows = cellPixels / rowPixels;
    let destination4 = 0;
    let destination8 = 0;
    for (let half = 0; half < count4 * 2; half++) {
      let left = reader.u8() * cellPixels * width;
      let right = reader.u8() * cellPixels * width;
      for (let row = 0; row < rows; row++) {
        // VQ2TO4, or VQ2TO2 for half: join a/b and duplicate every pixel and row into d.
        for (const start of [left, right]) {
          for (let column = 0; column < rowPixels; column++) {
            const source = start + column * width;
            const pixel = this.book2.subarray(source, source + width);
            this.book4.set(pixel, destination4);
            destination4 += width;
            this.book8.set(pixel, destination8);
            this.book8.set(pixel, destination8 + width);
            destination8 += width * 2;
          }
        }
        const rowBytes = rowPixels * width * 4;
        this.book8.copyWithin(destination8, destination8 - rowBytes, destination8);
        destination8 += rowBytes;
        left += rowPixels * width;
        right += rowPixels * width;
      }
    }
  }
}
