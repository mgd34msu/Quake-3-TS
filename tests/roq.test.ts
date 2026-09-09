import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryError, BinaryReader, BinaryWriter } from "../src/core/binary.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { RoqDecoder, RoqDecoderScratch } from "../src/cinematic/roq.ts";
import { RoqStream } from "../src/cinematic/roq-stream.ts";
import { RoqPlayback } from "../src/cinematic/playback.ts";

function chunk(id: number, data: readonly number[], flags = 0): Uint8Array {
  const writer = new BinaryWriter(data.length + 8);
  writer.u16(id);
  writer.u32(data.length);
  writer.u16(flags);
  writer.bytes(Uint8Array.from(data));
  return writer.finish();
}

function movie(chunks: readonly Uint8Array[], rate = 30): Uint8Array {
  const writer = new BinaryWriter(8 + chunks.reduce((sum, value) => sum + value.length, 0));
  writer.u16(0x1084);
  writer.u32(0xffffffff);
  writer.u16(rate);
  for (const value of chunks) writer.bytes(value);
  return writer.finish();
}

function info(width = 16, height = 16): Uint8Array {
  return chunk(0x1001, [width & 255, width >>> 8, height & 255, height >>> 8, 8, 0, 4, 0]);
}

interface Action { readonly code: number; readonly data: readonly number[] }

function vq(actions: readonly Action[], flags = 0): Uint8Array {
  const data: number[] = [];
  for (let start = 0; start < actions.length; start += 8) {
    const group = actions.slice(start, start + 8);
    let bits = 0;
    for (const [index, action] of group.entries()) bits |= action.code << (14 - 2 * index);
    data.push(bits & 255, bits >>> 8);
    for (const action of group) data.push(...action.data);
  }
  return chunk(0x1011, data, flags);
}

const black: Action = { code: 2, data: [0] };
const white: Action = { code: 2, data: [1] };
const skip: Action = { code: 0, data: [] };
const books = chunk(0x1002, [0, 0, 0, 0, 128, 128, 255, 255, 255, 255, 128, 128, 0, 0, 0, 0, 1, 1, 1, 1], 0x0202);

function nextFrame(decoder: RoqDecoder): Uint8Array {
  const event = decoder.next();
  if (event.kind !== "frame") throw new Error(`expected frame, got ${event.kind}`);
  return event.rgba;
}

function pixel(data: Uint8Array, x: number, y: number, width = 16): number[] {
  return Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
}

describe("RoQ source decoder", () => {
  test("physical pointer views retain exact offsets and permit source shader-sized reads", () => {
    const scratch = new RoqDecoderScratch();
    const frame = scratch.frame(256, 1);
    frame.fill(41);
    const shader = scratch.view(256, 256 * 256 * 4);
    expect(shader.subarray(0, 256).every(value => value === 41)).toBe(true);
    expect(shader.subarray(256).every(value => value === 0)).toBe(true);
    scratch.frame(1024, 0).fill(121);
    expect(frame.every(value => value === 121)).toBe(true);
    expect(shader.subarray(0, 768).every(value => value === 121)).toBe(true);
    for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, NaN], [2097152, 1]] satisfies readonly [number, number][]) {
      expect(() => scratch.view(offset, length)).toThrow(RangeError);
    }
    expect(scratch.view(2097152, 0).length).toBe(0);
  });
  test("shared scratch retains codebooks across new movies and aliases physical buffers across dimensions", () => {
    const scratch = new RoqDecoderScratch();
    const large = new RoqDecoder(movie([info(), books, vq([white, white, white, white])]), "large", { scratch });
    const retained = nextFrame(large);
    scratch.file.fill(255);
    scratch.clearMovieState();
    expect(scratch.file.every(value => value === 0)).toBe(true);
    expect(retained[0]).toBe(255);
    const small = new RoqDecoder(movie([info(8, 8), vq([skip]), vq([white])]), "small", { scratch });
    expect(nextFrame(small).every(value => value === 0)).toBe(true);
    expect(nextFrame(small).every(value => value === 255)).toBe(true);
    // Small frame1 occupies linbuf+256, inside large physical frame0, not a fixed 1MB second half.
    large.rewind();
    const skips = new RoqDecoder(movie([info(), vq([skip, skip, skip, skip])]), "skips", { scratch });
    const frame = nextFrame(skips);
    expect(frame.subarray(0, 256).every(value => value === 0)).toBe(true);
    expect(frame.subarray(256, 512).every(value => value === 255)).toBe(true);
    expect(frame.subarray(512).every(value => value === 0)).toBe(true);
    scratch.clear();
    expect(retained.every(value => value === 255)).toBe(true);
  });

  test("partial shared codebooks update only their declared entries across handle rewinds", () => {
    const scratch = new RoqDecoderScratch();
    const a = new RoqDecoder(movie([info(), books, vq([white, white, white, white])]), "a", { scratch });
    nextFrame(a);
    const partial = chunk(0x1002, [80, 80, 80, 80, 128, 128, 0, 0, 0, 0], 0x0101);
    const b = new RoqDecoder(movie([info(), partial, vq([black, white, black, white])]), "b", { scratch });
    const output = nextFrame(b);
    expect(pixel(output, 0, 0)[0]).toBe(81);
    expect(pixel(output, 8, 0)[0]).toBe(255);
    const reuse = new RoqDecoder(movie([info(), vq([black, white, black, white])]), "reuse", { scratch });
    expect(nextFrame(reuse)).toEqual(output);
  });

  test("truncated codebook index pairs retain source half-table publication", () => {
    for (const indexes of [[0], [0, 0]]) {
      const scratch = new RoqDecoderScratch();
      scratch.book4.fill(255);
      scratch.book8.fill(255);
      const decoder = new RoqDecoder(movie([chunk(0x1002, [0, 0, 0, 0, 128, 128, ...indexes], 0x0101)]),
        "partial-books.roq", { scratch });
      expect(() => decoder.nextChunk()).toThrow(BinaryError);
      // decodeCodeBook reads both indexes before publishing two 4x4 rows and four 8x8 rows.
      expect(pixel(scratch.book2, 0, 0, 2)).toEqual([1, 0, 1, 255]);
      expect(pixel(scratch.book4, 0, 0, 4)).toEqual(indexes.length === 1 ? [255, 255, 255, 255] : [1, 0, 1, 255]);
      expect(pixel(scratch.book4, 3, 1, 4)).toEqual(indexes.length === 1 ? [255, 255, 255, 255] : [1, 0, 1, 255]);
      expect(pixel(scratch.book4, 0, 2, 4)).toEqual([255, 255, 255, 255]);
      expect(pixel(scratch.book8, 7, 3, 8)).toEqual(indexes.length === 1 ? [255, 255, 255, 255] : [1, 0, 1, 255]);
      expect(pixel(scratch.book8, 0, 4, 8)).toEqual([255, 255, 255, 255]);
    }
  });
  test("header rate, dimensions, source YUV rounding, frames and timestamps", () => {
    const decoder = new RoqDecoder(movie([info(), books, vq([black, white, white, black]), vq([skip, skip, skip, skip])], 0));
    expect(decoder.frameRate).toBe(30);
    const first = decoder.next();
    if (first.kind !== "frame") throw new Error("missing first frame");
    expect([decoder.width, decoder.height, first.index, first.time]).toEqual([16, 16, 0, 0]);
    expect(pixel(first.rgba, 0, 0)).toEqual([1, 0, 1, 255]);
    expect(pixel(first.rgba, 8, 0)).toEqual([255, 255, 255, 255]);
    const second = decoder.next();
    if (second.kind !== "frame") throw new Error("missing second frame");
    expect(second.index).toBe(1);
    expect(second.time).toBe(1000 / 30);
    expect(second.rgba).toEqual(first.rgba);
    expect(decoder.next()).toEqual({ kind: "end" });
    expect(decoder.next()).toEqual({ kind: "end" });
  });

  test("source header parsing ignores the file size word and fourth chunk size byte", () => {
    const data = movie([info(), books, vq([white, white, white, white])]);
    data.fill(0x3c, 2, 6);
    data[13] = 0x80;
    data[29] = 0x40;
    data[57] = 0x20;
    const decoder = new RoqDecoder(data);
    expect(nextFrame(decoder).every(value => value === 255)).toBe(true);
    expect(decoder.next()).toEqual({ kind: "end" });
  });

  test("quad traversal clips 16x16 roots at valid 8-pixel image boundaries", () => {
    const decoder = new RoqDecoder(movie([info(8, 8), books, vq([white])], 24));
    const frame = nextFrame(decoder);
    expect([decoder.width, decoder.height, decoder.frameRate, frame.length]).toEqual([8, 8, 24, 256]);
    expect(pixel(frame, 7, 7, 8)).toEqual([255, 255, 255, 255]);
  });

  test("INFO uses allocation-sized dimensions and ignores stored block sizes and trailing bytes", () => {
    for (const [width, height] of [[1024, 8], [8, 1024]] satisfies readonly [number, number][]) {
      const dimensions = chunk(0x1001, [width & 255, width >>> 8, height & 255, height >>> 8, 16, 0, 2, 0, 77]);
      const decoder = new RoqDecoder(movie([dimensions, books, vq(Array.from({ length: 128 }, () => white))]));
      const frame = nextFrame(decoder);
      expect([decoder.width, decoder.height, frame.length]).toEqual([width, height, 32768]);
      expect(pixel(frame, width - 1, height - 1, width)).toEqual([255, 255, 255, 255]);
    }
  });

  test("skips preserve two-frame-old destination while FCC reads preceding frame", () => {
    const decoder = new RoqDecoder(movie([info(), books,
      vq([black, black, black, black]),
      vq([white, white, white, white]),
      vq([skip, { code: 1, data: [0x88] }, skip, skip]),
    ]));
    const first = nextFrame(decoder);
    nextFrame(decoder);
    const third = nextFrame(decoder);
    expect(pixel(third, 0, 0)).toEqual([1, 0, 1, 255]);
    expect(pixel(third, 8, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(first, 8, 0)).toEqual([1, 0, 1, 255]);
  });

  test("rewind retains physical buffer zero after odd and even frame counts", () => {
    const firstSkip = vq([skip, skip, skip, skip]);
    for (const count of [2, 3]) {
      const chunks = [info(), books, firstSkip, vq([white, white, white, white])];
      if (count === 3) chunks.push(vq([black, black, black, black]));
      chunks.push(chunk(0x1013, []));
      const decoder = new RoqDecoder(movie(chunks), "loop.roq", { endPolicy: "cinematic-lookahead" });
      expect(pixel(nextFrame(decoder), 0, 0)).toEqual([0, 0, 0, 0]);
      for (let index = 1; index < count; index++) nextFrame(decoder);
      expect(decoder.next()).toEqual({ kind: "end" });
      decoder.rewind();
      expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
      expect(pixel(nextFrame(decoder), 0, 0)).toEqual(count === 3 ? [1, 0, 1, 255] : [0, 0, 0, 0]);
    }
  });

  test("rewind preserves partial codebooks for 2x2, 4x4 and 8x8 first-frame references", () => {
    const partial = chunk(0x1002, [0, 0, 0, 0, 128, 128, 0, 0, 0, 0], 0x0101);
    const usesRetainedBooks = vq([white, { code: 3, data: [] }, white,
      { code: 3, data: [1, 1, 1, 1] }, white, white, white, white]);
    const decoder = new RoqDecoder(movie([info(), partial, usesRetainedBooks, books,
      vq([black, black, black, black])]));
    expect(pixel(nextFrame(decoder), 0, 0)).toEqual([0, 0, 0, 0]);
    nextFrame(decoder);
    decoder.rewind();
    const retained = nextFrame(decoder);
    expect(pixel(retained, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(retained, 8, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(retained, 12, 0)).toEqual([255, 255, 255, 255]);
  });

  test("first-frame motion after rewind reads retained physical buffer one", () => {
    const motion: Action = { code: 1, data: [0x88] };
    const decoder = new RoqDecoder(movie([info(), books, vq([motion, motion, motion, motion]),
      vq([white, white, white, white]), vq([black, black, black, black])]));
    nextFrame(decoder);
    nextFrame(decoder);
    nextFrame(decoder);
    decoder.rewind();
    expect(pixel(nextFrame(decoder), 0, 0)).toEqual([255, 255, 255, 255]);
  });

  test("rewind discards the pending packet cursor and same-size INFO resets physical buffer selection", () => {
    const packet = chunk(0x1030, [...vq([black, black, black, black]), ...vq([white, white, white, white])], 2);
    const decoder = new RoqDecoder(movie([info(), books, packet]));
    nextFrame(decoder);
    expect(decoder.inPacket).toBe(true);
    decoder.rewind();
    expect(decoder.inPacket).toBe(false);
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
    const first = decoder.next();
    if (first.kind !== "frame") throw new Error("Expected rewound packet frame");
    expect(first.index).toBe(0);

    const repeatedInfo = new RoqDecoder(movie([info(), books, vq([black, black, black, black]),
      vq([white, white, white, white]), vq([black, black, black, black]), info(), vq([skip, skip, skip, skip])]));
    nextFrame(repeatedInfo);
    nextFrame(repeatedInfo);
    nextFrame(repeatedInfo);
    expect(pixel(nextFrame(repeatedInfo), 0, 0)).toEqual([1, 0, 1, 255]);
  });

  test("signed motion means and X/Y nibbles select correct preceding block", () => {
    const decoder = new RoqDecoder(movie([info(), books,
      vq([black, white, black, black]),
      vq([{ code: 1, data: [0x00] }, skip, skip, skip], 0x0008),
      vq([{ code: 1, data: [0x98] }, skip, skip, skip], 0xff00),
    ]));
    nextFrame(decoder);
    expect(pixel(nextFrame(decoder), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(nextFrame(decoder), 0, 0)).toEqual([255, 255, 255, 255]);
  });

  test("motion may read its destination image and copies overlapping eight-byte pairs in source order", () => {
    for (const size of [4, 8]) {
      const scratch = new RoqDecoderScratch();
      const initial = scratch.frame(16 * 16 * 4, 0);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) initial.set([x, y, 0, 255], (y * 16 + x) * 4);
      }
      const motion: Action = { code: 1, data: [0x88] };
      const actions = size === 8 ? [skip, motion, skip, skip]
        : [{ code: 3, data: [] }, skip, motion, skip, skip, skip, skip, skip];
      const decoder = new RoqDecoder(movie([info(), vq(actions, 0x0210)]), "overlapping-motion.roq", { scratch });
      const frame = nextFrame(decoder);
      // meanY=16 cancels screenDelta, then meanX=2 reads the pair just before the destination.
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) expect(pixel(frame, size + x, y)).toEqual([size - 2 + (x & 1), y, 0, 255]);
      }
      expect(scratch.frame(16 * 16 * 4, 1)).toEqual(frame);
    }
  });

  test("motion reads the retained linbuf allocation beyond both published images", () => {
    const scratch = new RoqDecoderScratch();
    scratch.view(16 * 16 * 4 * 2, 16 * 16 * 4).fill(77);
    const decoder = new RoqDecoder(movie([info(), vq([skip, skip, { code: 1, data: [0x80] }, skip])]),
      "motion-tail.roq", { scratch });
    const frame = nextFrame(decoder);
    expect(pixel(frame, 0, 8)).toEqual([77, 77, 77, 77]);
    expect(pixel(frame, 7, 15)).toEqual([77, 77, 77, 77]);
    expect(pixel(frame, 8, 8)).toEqual([0, 0, 0, 0]);
  });

  test("4x4 and 2x2 subdivision consumes interleaved control words", () => {
    const decoder = new RoqDecoder(movie([info(), books, vq([
      { code: 3, data: [] },
      { code: 3, data: [0, 1, 1, 0] }, white, black, white,
      { code: 3, data: [] }, black, white, white, black,
      black, white,
    ])]));
    const frame = nextFrame(decoder);
    expect(pixel(frame, 0, 0)).toEqual([1, 0, 1, 255]);
    expect(pixel(frame, 2, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(frame, 0, 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(frame, 2, 2)).toEqual([1, 0, 1, 255]);
    expect(pixel(frame, 12, 4)).toEqual([1, 0, 1, 255]);
    expect(pixel(frame, 8, 8)).toEqual([255, 255, 255, 255]);
  });

  test("mono and stereo signed square deltas wrap to 16 bits", () => {
    const decoder = new RoqDecoder(movie([
      chunk(0x1020, [0, 1, 2, 129, 255, 127], 32767),
      chunk(0x1021, [1, 2, 129, 130, 127, 255], 0x80ff),
    ]));
    expect(decoder.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
      samples: new Int16Array([32767, 32767, -32768, -32768, -32764, -32764]) });
    expect(decoder.next()).toEqual({ kind: "audio", channels: 2, sampleRate: 22050,
      samples: new Int16Array([-32767, -252, -32768, -256, -16639, -16385]) });
  });

  test("mono submission reads the source prefix of duplicated stereo pairs", () => {
    const decoder = new RoqDecoder(movie([
      chunk(0x1020, [1, 2, 3, 4, 5], 100),
      chunk(0x1020, [255, 127, 1], 0x8000),
      chunk(0x1020, [], 100),
    ]));
    // RoQInterrupt passes RllDecodeMonoToStereo's output to S_RawSamples with channels=1.
    expect(decoder.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
      samples: new Int16Array([101, 101, 105, 105, 114]) });
    expect(decoder.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
      samples: new Int16Array([16639, 16639, -32768]) });
    expect(decoder.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array(0) });
  });

  test("silent chunks emit metadata without stereo hooks and retain packet and video order", () => {
    const packet = chunk(0x1030, [...chunk(0x1020, [127, 255]), ...chunk(0x1021, [1])], 2);
    const decoder = new RoqDecoder(movie([packet, info(), books, vq([white, white, white, white])]),
      "silent.roq", { silent: true });
    let stereoCalls = 0;
    for (let pass = 0; pass < 2; pass++) {
      if (pass !== 0) decoder.rewind();
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.inPacket).toBe(true);
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.inPacket).toBe(true);
      expect(decoder.nextChunk(() => { stereoCalls++; })).toEqual({ kind: "metadata" });
      expect(decoder.inPacket).toBe(false);
      const result = decoder.next();
      if (result.kind !== "frame") throw new Error("Expected frame after silent audio");
      expect([result.index, result.time, decoder.width, decoder.height]).toEqual([0, 0, 16, 16]);
      expect(result.rgba.every(value => value === 255)).toBe(true);
      expect(decoder.next()).toEqual({ kind: "end" });
    }
    expect(stereoCalls).toBe(0);
  });

  test("silent audio retains header, chunk, packet and video validation", () => {
    const truncatedAudio = movie([chunk(0x1021, [1, 2])]).subarray(0, -1);
    const partialHeader = movie([chunk(0x1021, [1]), chunk(0x1013, [])]).subarray(0, -1);
    for (const data of [
      truncatedAudio, partialHeader,
      movie([chunk(0x1020, Array.from({ length: 65537 }, () => 0))]),
      movie([chunk(0x1030, [...chunk(0x1021, [1])], 2)]),
      movie([chunk(0x1021, [1]), chunk(0x7777, [])]),
      movie([chunk(0x1021, [1]), vq([skip])]),
    ]) {
      expect(() => {
        const decoder = new RoqDecoder(data, "bad-silent.roq", { silent: true });
        while (decoder.next().kind !== "end") { /* Consume through skipped audio. */ }
      }).toThrow(BinaryError);
    }
    const final = new RoqDecoder(movie([chunk(0x1021, [1])]), "silent-eof.roq",
      { silent: true, endPolicy: "cinematic-lookahead" });
    expect(final.nextChunk()).toEqual({ kind: "end" });
  });

  test("codebook quadrant placement and 8x8 nearest expansion preserve luma order", () => {
    const gradient = chunk(0x1002, [0, 64, 128, 192, 128, 128, 0, 0, 0, 0], 0x0101);
    const decoder = new RoqDecoder(movie([info(), gradient, vq([black, black, black, black])]));
    const frame = nextFrame(decoder);
    expect(pixel(frame, 0, 0)).toEqual([1, 0, 1, 255]);
    expect(pixel(frame, 1, 1)).toEqual([1, 0, 1, 255]);
    expect(pixel(frame, 2, 0)).toEqual([65, 64, 65, 255]);
    expect(pixel(frame, 0, 2)).toEqual([129, 128, 129, 255]);
    expect(pixel(frame, 2, 2)).toEqual([193, 192, 194, 255]);
    expect(pixel(frame, 4, 4)).toEqual([1, 0, 1, 255]);
  });

  test("codebook updates stop at their declared entries and ignore chunk padding", () => {
    const padded = chunk(0x1002, [255, 255, 255, 255, 128, 128, 0, 0, 0, 0, 77, 88, 99], 0x0101);
    const decoder = new RoqDecoder(movie([info(), padded, vq([black, black, black, black])]));
    expect(nextFrame(decoder).every(value => value === 255)).toBe(true);
  });

  test("complete diagnostics retain larger tables for zero-flags 2x2-only payloads", () => {
    const update: number[] = [];
    for (let index = 0; index < 256; index++) update.push(255, 255, 255, 255, 128, 128);
    const decoder = new RoqDecoder(movie([info(), books, chunk(0x1002, update), vq([
      { code: 3, data: [] }, { code: 3, data: [0, 0, 0, 0] }, black, black, black,
      black, black, black,
    ])]));
    const frame = nextFrame(decoder);
    expect(pixel(frame, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(frame, 4, 0)).toEqual([1, 0, 1, 255]);
    expect(pixel(frame, 8, 0)).toEqual([1, 0, 1, 255]);
  });

  test("cinematic codebooks consume the following header and retained file bytes for all declared entries", () => {
    const update: number[] = [];
    for (let index = 0; index < 256; index++) update.push(index, index, index, index, 128, 128);
    const codebook = chunk(0x1002, update);
    const frameChunk = vq([black, { code: 2, data: [255] }, black, { code: 2, data: [255] }]);
    for (const packed of [false, true]) {
      const scratch = new RoqDecoderScratch();
      const tail = packed ? [chunk(0x1030, [...codebook, ...frameChunk], 2)] : [codebook, frameChunk];
      const data = movie([info(), books, chunk(0x1012, new Array<number>(2600).fill(123)), ...tail, chunk(0x1013, [])]);
      const decoder = new RoqDecoder(data, "retained-codebook.roq", { scratch, endPolicy: "cinematic-lookahead" });
      const frame = nextFrame(decoder);
      // decodeCodeBook reads 1024 indexes after its 1536 luma/chroma bytes.
      // The first four are the following VQ header; entry 255 still reads the prior JPEG payload.
      expect(pixel(frame, 0, 0)).toEqual([18, 17, 18, 255]);
      expect(pixel(frame, 4, 0)).toEqual([17, 16, 17, 255]);
      expect(pixel(frame, 0, 4)).toEqual([7, 5, 7, 255]);
      expect(pixel(frame, 4, 4)).toEqual([1, 0, 1, 255]);
      expect(pixel(frame, 8, 0)).toEqual([124, 123, 124, 255]);
      expect(pixel(scratch.book4, 0, 0, 4)).toEqual([18, 17, 18, 255]);
      expect(pixel(scratch.book4.subarray(255 * 64), 3, 3, 4)).toEqual([124, 123, 124, 255]);
    }
  });

  test("cinematic codebook reads stop at the source file allocation after earlier entry writes", () => {
    const scratch = new RoqDecoderScratch();
    scratch.book2.fill(91);
    const packet = chunk(0x1030, [...chunk(0x1012, new Array<number>(65512).fill(0)), ...chunk(0x1002, [], 0x0200)], 2);
    const decoder = new RoqDecoder(movie([packet, chunk(0x1013, [])]), "codebook-boundary.roq",
      { scratch, endPolicy: "cinematic-lookahead" });
    expect(decoder.nextChunk().kind).toBe("metadata");
    expect(decoder.nextChunk().kind).toBe("metadata");
    // The codebook starts at cin.file+65528. Its first entry uses the real following HANG header.
    expect(() => decoder.nextChunk()).toThrow("exceeds 8-byte input");
    expect(scratch.book2.subarray(0, 16).every(value => value === 91)).toBe(false);
    expect(scratch.book2.subarray(16).every(value => value === 91)).toBe(true);
  });

  test("4:1 images double motion spacing and 4x4 FCC uses the prior frame", () => {
    const initial: Action[] = [black, white, black, black];
    const moved: Action[] = [{ code: 3, data: [] }, { code: 1, data: [0x48] }, skip, skip, skip, skip, skip, skip];
    for (let index = 0; index < 12; index++) { initial.push(black); moved.push(skip); }
    const decoder = new RoqDecoder(movie([info(64, 16), books, vq(initial), vq(moved)]));
    nextFrame(decoder);
    const frame = nextFrame(decoder);
    expect(pixel(frame, 0, 0, 64)).toEqual([255, 255, 255, 255]);
    expect(pixel(frame, 4, 0, 64)).toEqual([1, 0, 1, 255]);
  });

  test("packet chunks dispatch children; JPEG and hang do not invent a frame", () => {
    const payload = [...chunk(0x1012, [1, 2]), ...chunk(0x1013, []), ...chunk(0x1020, [2], 1)];
    const decoder = new RoqDecoder(movie([chunk(0x1030, payload, 3)]));
    expect(decoder.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array([5]) });
    expect(decoder.next()).toEqual({ kind: "end" });
  });

  test("zero-count PACKET and nonempty HANG select their payload header before the next physical read", () => {
    for (const id of [0x1030, 0x1013]) {
      const sound = chunk(0x1020, [1, 2], 100);
      const data = movie([chunk(id, [...sound]), chunk(0x7777, []), Uint8Array.from([3, 4]), chunk(0x1084, [])]);
      const scratch = new RoqDecoderScratch();
      const stream = RoqStream.fromBytes(data, "physical-read.roq", scratch.file, "cinematic-lookahead");
      const decoder = new RoqDecoder(stream, "physical-read.roq", { scratch });
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.inPacket).toBe(false);
      // The first read consumed bytes 16..33. The chosen inner header's payload starts at byte 34.
      data[34] = 5;
      expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
        samples: new Int16Array([125, 125]) });
      expect(decoder.hasInvalidLookahead).toBe(true);
      expect(decoder.nextChunk()).toEqual({ kind: "end" });
    }
  });

  test("the selected inner size advances RoQPlayed and the EOF read still precedes its guard", () => {
    for (const id of [0x1030, 0x1013]) {
      const soundHeader = chunk(0x1020, new Array<number>(20).fill(0), 100).subarray(0, 8);
      const data = movie([chunk(id, [...soundHeader]), chunk(0x1013, []), new Uint8Array(20).fill(9)]);
      const scratch = new RoqDecoderScratch();
      const decoder = new RoqDecoder(data, "played-size.roq", { endPolicy: "cinematic-lookahead", scratch });
      expect(data.length).toBe(52);
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      // The selected size advances 24 to 52. Source still reads bytes 32..51 before testing EOF.
      data[32] = 7;
      expect(decoder.nextChunk()).toEqual({ kind: "end" });
      expect(scratch.file.subarray(0, 20)).toEqual(new Uint8Array([7, ...new Array<number>(19).fill(9)]));
    }
  });

  test("nested PACKET replaces the outer counter and selects the header that controls the next read", () => {
    for (const nestedCount of [0, 1]) {
      const first = chunk(0x1020, [1, 2], 100), second = chunk(0x1020, [9, 10], 200);
      const nested = chunk(0x1030, [...first], nestedCount);
      const outer = chunk(0x1030, [...nested, ...second], 9);
      const data = movie([outer, chunk(0x7777, []), Uint8Array.from([3, 4]), chunk(0x1084, [])]);
      const decoder = new RoqDecoder(data, "nested-packet.roq", { endPolicy: "cinematic-lookahead" });
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.inPacket).toBe(true);
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.inPacket).toBe(nestedCount === 1);
      if (nestedCount === 1) {
        expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
          samples: new Int16Array([101, 101]) });
      }
      expect(decoder.inPacket).toBe(false);
      // The outer count of nine is discarded. The next payload comes from after its physical read.
      expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
        samples: new Int16Array(nestedCount === 0 ? [109, 109] : [209, 209]) });
      expect(decoder.hasInvalidLookahead).toBe(true);
      expect(decoder.nextChunk()).toEqual({ kind: "end" });
    }
  });

  test("a packet HANG uses zero effective size and decodes the header inside its declared payload", () => {
    const sound = chunk(0x1020, [3, 4], 100);
    const hang = chunk(0x1013, [...sound]);
    const outer = chunk(0x1030, [...hang], 2);
    const decoder = new RoqDecoder(movie([outer, chunk(0x1084, [])]), "packet-hang.roq",
      { endPolicy: "cinematic-lookahead" });
    expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
    expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
    expect(decoder.inPacket).toBe(true);
    expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
      samples: new Int16Array([109, 109]) });
    expect(decoder.inPacket).toBe(false);
    expect(decoder.hasInvalidLookahead).toBe(true);
    expect(decoder.nextChunk()).toEqual({ kind: "end" });
  });

  test("buffered PACKET and HANG do not read or skip their discarded declared payload size", () => {
    for (const id of [0x1030, 0x1013]) {
      const control = chunk(id, [...chunk(0x1020, [3, 4], 100)], 1);
      control[2] = 0xd2;
      control[3] = 4; // The declared 1234 bytes are discarded by this buffered control dispatch.
      const outer = chunk(0x1030, [...control], 2);
      const decoder = new RoqDecoder(movie([outer, chunk(0x1084, [])]), "discarded-size.roq",
        { endPolicy: "cinematic-lookahead" });
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
      expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
        samples: new Int16Array([109, 109]) });
      expect(decoder.hasInvalidLookahead).toBe(true);
      expect(decoder.nextChunk()).toEqual({ kind: "end" });
    }
  });

  test("the following header is read after the reached stereo callback and sample decode", () => {
    const scratch = new RoqDecoderScratch();
    const data = movie([chunk(0x1021, [1, 2]), chunk(0x1013, []), chunk(0x1013, [])]);
    const decoder = new RoqDecoder(data, "stereo-tail.roq", { endPolicy: "cinematic-lookahead", scratch });
    const audio = decoder.nextChunk(() => {
      expect(decoder.hasInvalidLookahead).toBe(false);
      scratch.file[0] = 3;
      scratch.file.set(chunk(0x1084, []), 2);
    });
    expect(audio).toEqual({ kind: "audio", channels: 2, sampleRate: 22050, samples: new Int16Array([9, 4]) });
    expect(decoder.hasInvalidLookahead).toBe(true);
    expect(decoder.nextChunk()).toEqual({ kind: "end" });
  });

  test("INFO publishes dimensions and reaches its clock callback before reading the following header", () => {
    const scratch = new RoqDecoderScratch();
    const data = movie([info(), chunk(0x1020, [1, 2]), chunk(0x1013, [])]);
    const decoder = new RoqDecoder(data, "info-tail.roq", { endPolicy: "cinematic-lookahead", scratch });
    let clocks = 0;
    const event = decoder.nextChunk(undefined, () => {
      clocks++;
      expect([decoder.width, decoder.height]).toEqual([16, 16]);
      expect(decoder.hasInvalidLookahead).toBe(false);
      scratch.file.set(chunk(0x1084, []), 8);
    });
    expect(event).toEqual({ kind: "info", width: 16, height: 16 });
    expect(clocks).toBe(1);
    expect(decoder.hasInvalidLookahead).toBe(true);
    expect(decoder.nextChunk()).toEqual({ kind: "end" });
  });

  test("actual playback samples its INFO clock before the following header for ordinary and packet chunks", () => {
    for (const packed of [false, true]) {
      const scratch = new RoqDecoderScratch();
      const audio = chunk(0x1020, [1, 2]);
      const data = movie(packed ? [chunk(0x1030, [...info(), ...audio], 2), chunk(0x1013, [])]
        : [info(), audio, chunk(0x1013, [])]);
      let clockReads = 0;
      const clock = { sample(): number {
        clockReads++;
        if (clockReads === 4) scratch.file.set(chunk(0x1084, []), packed ? 16 : 8);
        return 0;
      } };
      let delivered = 0;
      const playback = new RoqPlayback(data, { developerPrint: () => undefined, clock, scratch, onAudio: () => { delivered++; } });
      expect(playback.run(clock)).toEqual({ status: "ended", update: { kind: "unchanged" } });
      expect(clockReads).toBe(4);
      expect(playback.dimensions).toEqual({ width: 16, height: 16 });
      expect(delivered).toBe(0);
    }
  });

  test("playback delivers audio before selecting the buffered lookahead header", () => {
    for (const packed of [false, true]) {
      const scratch = new RoqDecoderScratch();
      const audio = chunk(0x1020, [1, 2]);
      const data = movie(packed ? [chunk(0x1030, [...audio, ...info()], 2), chunk(0x1013, [])]
        : [audio, info(), chunk(0x1013, [])]);
      let delivered = 0;
      const playback = new RoqPlayback(data, { developerPrint: () => undefined, clock: { sample: () => 0 }, scratch, onAudio: event => {
        delivered++;
        expect(Array.from(event.samples)).toEqual([1, 1]);
        scratch.file.set(chunk(0x1084, []), packed ? 10 : 2);
      } });
      expect(playback.run({ sample: () => 0 }).status).toBe("ended");
      expect(playback.dimensions).toBeNull();
      expect(delivered).toBe(1);
    }
  });

  test("a nested read beyond source scratch allocation rejects after earlier audio publication", () => {
    const first = chunk(0x1020, [1, 2], 100);
    const oversized = chunk(0x1021, []);
    new DataView(oversized.buffer).setUint32(2, 65536, true);
    const packet = chunk(0x1030, [...first, ...oversized], 2);
    const decoder = new RoqDecoder(movie([packet, chunk(0x1013, []), chunk(0x1013, [])]), "short-packet.roq",
      { endPolicy: "cinematic-lookahead" });
    expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
    const audio = decoder.nextChunk();
    expect(audio).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array([101, 101]) });
    expect(decoder.inPacket).toBe(true);
    expect(() => decoder.nextChunk()).toThrow("RoQ packet payload exceeds source scratch buffer");
    expect(audio).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array([101, 101]) });
  });

  test("rewind retains the source packet counter while restarting with a physical read", () => {
    const packet = chunk(0x1030, [...chunk(0x1020, [1, 2]), 0, 0, 0, 0, 0, 0, ...chunk(0x1020, [3, 4], 100)], 2);
    const decoder = new RoqDecoder(movie([info(), packet, chunk(0x1013, []), chunk(0x1013, [])]),
      "rewound-packet.roq", { endPolicy: "cinematic-lookahead" });
    expect(decoder.nextChunk().kind).toBe("info");
    expect(decoder.nextChunk().kind).toBe("metadata");
    expect(decoder.inPacket).toBe(true);
    decoder.rewind();
    expect(decoder.inPacket).toBe(false);
    expect(decoder.nextChunk().kind).toBe("info");
    // RoQ_init resets numQuads and RoQPlayed, but does not clear the one remaining inMemory count.
    expect(decoder.inPacket).toBe(true);
    expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
    expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050,
      samples: new Int16Array([109, 109]) });
  });

  test("unknown packet chunks stop redump and preserve the selected-header loop phase", () => {
    for (const followingId of [0x1013, 0x1084]) {
      const packet = chunk(0x1030, [...chunk(0x7777, []), ...chunk(followingId, [])], 2);
      const decoder = new RoqDecoder(movie([packet, chunk(0x1013, [])]), "unknown-packet.roq",
        { endPolicy: "cinematic-lookahead" });
      for (let pass = 0; pass < 2; pass++) {
        if (pass !== 0) decoder.rewind();
        expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
        expect(decoder.inPacket).toBe(true);
        expect(decoder.nextChunk()).toEqual({ kind: "end" });
        expect(decoder.inPacket).toBe(false);
        expect(decoder.hasInvalidLookahead).toBe(true);
        expect(decoder.resetAfterRun).toBe(followingId === 0x1013);
      }
    }
  });

  test("playback's retained packet counter can trigger another source reset before the next frame", () => {
    const unknown = chunk(0x1030, [...chunk(0x7777, [1]), ...vq([white])], 2);
    const data = movie([info(8, 8), books, vq([black]), unknown, vq([white]), chunk(0x1013, [])]);
    const clock = { time: 0, sample(): number { return this.time; } };
    const playback = new RoqPlayback(data, { developerPrint: () => undefined, clock, loop: true, hold: true, onAudio: () => undefined });
    playback.run(clock);
    clock.time = 34;
    expect(playback.run(clock).update.kind).toBe("frame");
    clock.time = 67;
    expect(playback.run(clock).status).toBe("looped");
    expect(playback.run(clock).update.kind).toBe("unchanged");
    for (const time of [101, 135, 168]) {
      clock.time = time;
      expect(playback.run(clock)).toEqual({ status: "playing", update: { kind: "unchanged" } });
      expect(playback.currentFrame?.loop).toBe(0);
    }
    // The retained codebook read ends at a zero header; the next physical read causes reset two.
    clock.time = 202;
    const tick = playback.run(clock);
    if (tick.update.kind !== "frame") throw new Error("Expected the frame after the second reset");
    expect([tick.update.frame.index, tick.update.frame.loop]).toEqual([0, 2]);
  });

  test("cinematic lookahead skips the final chunk while complete decoding preserves it", () => {
    const data = movie([info(), books, vq([black, black, black, black]), vq([white, white, white, white])]);
    const complete = new RoqDecoder(data);
    nextFrame(complete);
    expect(pixel(nextFrame(complete), 0, 0)).toEqual([255, 255, 255, 255]);
    const cinematic = new RoqDecoder(data, "cinematic.roq", { endPolicy: "cinematic-lookahead" });
    nextFrame(cinematic);
    expect(cinematic.next()).toEqual({ kind: "end" });
    expect(cinematic.next()).toEqual({ kind: "end" });
    const trailer = movie([info(), books, vq([black, black, black, black]), vq([white, white, white, white]), chunk(0x1013, [])]);
    const withTrailer = new RoqDecoder(trailer, "cinematic.roq", { endPolicy: "cinematic-lookahead" });
    nextFrame(withTrailer);
    expect(pixel(nextFrame(withTrailer), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(withTrailer.next()).toEqual({ kind: "end" });
  });

  test("chunk events expose info and metadata without consuming pending frames or audio", () => {
    const decoder = new RoqDecoder(movie([info(), books, chunk(0x1020, [2], 1), vq([black, black, black, black]),
      info(), vq([white, white, white, white]), info(), vq([black, black, black, black])]));
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
    expect(decoder.nextChunk()).toEqual({ kind: "metadata" });
    expect(decoder.nextChunk()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array([5]) });
    const first = decoder.nextChunk();
    if (first.kind !== "frame") throw new Error("Expected first frame");
    expect(first.index).toBe(0);
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
    const second = decoder.nextChunk();
    if (second.kind !== "frame") throw new Error("Expected second frame");
    expect(second.index).toBe(1);
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
    const reset = decoder.nextChunk();
    if (reset.kind !== "frame") throw new Error("Expected reset frame");
    expect(reset.index).toBe(0);
    expect(decoder.nextChunk()).toEqual({ kind: "end" });
  });

  test("repeated INFO ignores its payload and preserves the source frame-count reset", () => {
    const decoder = new RoqDecoder(movie([info(), books, vq([black, black, black, black]),
      chunk(0x1001, [255]), vq([white, white, white, white]), chunk(0x1001, []), vq([skip, skip, skip, skip])]));
    nextFrame(decoder);
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
    const second = decoder.next();
    if (second.kind !== "frame") throw new Error("Expected second frame");
    expect(second.index).toBe(1);
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 16, height: 16 });
    const reset = decoder.next();
    if (reset.kind !== "frame") throw new Error("Expected reset frame");
    expect(reset.index).toBe(0);
    expect(pixel(reset.rgba, 0, 0)).toEqual([1, 0, 1, 255]);
  });

  test("first INFO after rewind rereads dimensions over retained physical buffers", () => {
    const data = movie([info(), books, vq([white, white, white, white])]);
    const decoder = new RoqDecoder(data);
    nextFrame(decoder);
    data[6] = 24;
    data[16] = 8;
    data[18] = 8;
    decoder.rewind();
    expect(decoder.frameRate).toBe(24);
    expect(decoder.nextChunk()).toEqual({ kind: "info", width: 8, height: 8 });
    const frame = decoder.next();
    if (frame.kind !== "frame") throw new Error("Expected resized frame");
    expect(frame.index).toBe(0);
    expect(frame.rgba.length).toBe(256);
    expect(pixel(frame.rgba, 7, 7, 8)).toEqual([255, 255, 255, 255]);
  });

  test("packet children share the interrupt and its RoQPlayed counter can lag physical EOF", () => {
    const packet = chunk(0x1030, [...chunk(0x1020, [2], 1)], 1);
    const final = new RoqDecoder(movie([packet]), "packet.roq", { endPolicy: "cinematic-lookahead" });
    expect(final.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array([5]) });
    expect(final.next()).toEqual({ kind: "end" });
    const interior = new RoqDecoder(movie([packet, chunk(0x1013, [])]), "packet.roq", { endPolicy: "cinematic-lookahead" });
    expect(interior.next()).toEqual({ kind: "audio", channels: 1, sampleRate: 22050, samples: new Int16Array([5]) });
    expect(interior.next()).toEqual({ kind: "end" });
    const truncatedData = movie([packet]).subarray(0, -1);
    const truncated = new RoqDecoder(truncatedData, "bad.roq", { endPolicy: "cinematic-lookahead" });
    // RoQPlayed=24 reaches EOF before dispatch, even though the source still issued its read.
    expect(truncated.next()).toEqual({ kind: "end" });
    expect(() => new RoqDecoder(truncatedData, "bad-complete.roq").next()).toThrow(BinaryError);
  });

  test("packet boundaries remain visible until the last child, including a frame-count overshoot", () => {
    const packet = chunk(0x1030, [...vq([black, black, black, black]), ...vq([white, white, white, white]),
      ...vq([black, black, black, black])], 3);
    const decoder = new RoqDecoder(movie([info(), books, packet, chunk(0x1013, [])]), "packet.roq",
      { endPolicy: "cinematic-lookahead" });
    expect(decoder.inPacket).toBe(false);
    expect(decoder.nextChunk().kind).toBe("info");
    expect(decoder.nextChunk().kind).toBe("metadata");
    expect(decoder.nextChunk().kind).toBe("metadata");
    expect(decoder.inPacket).toBe(true);
    nextFrame(decoder);
    expect(decoder.inPacket).toBe(true);
    nextFrame(decoder);
    expect(decoder.inPacket).toBe(true);
    nextFrame(decoder);
    expect(decoder.inPacket).toBe(false);
    expect(decoder.nextChunk().kind).toBe("end");
  });

  test("malformed headers, truncated chunks, codes, dimensions and motion fail with source", () => {
    const valid = movie([info(), books, vq([black, black, black, black])]);
    for (const length of [0, 1, 7]) expect(() => new RoqDecoder(valid.slice(0, length), "bad.roq")).toThrow(BinaryError);
    const badMagic = valid.slice();
    badMagic[0] = 0;
    expect(() => new RoqDecoder(badMagic)).toThrow("magic");
    for (const data of [
      valid.slice(0, -1), movie([info(15)]), movie([chunk(0x1021, [1])]),
      movie([info(), chunk(0x1002, [1], 0x0100)]),
      movie([info(), vq([{ code: 1, data: [0xff] }, skip, skip, skip], 0x7f7f)]),
      movie([chunk(0x1011, [0, 0])]), movie([chunk(0x7777, [])]),
      movie([chunk(0x1030, [], 1)]),
      movie([info(), chunk(0x1011, [0])]),
    ]) {
      const decoder = new RoqDecoder(data, "bad.roq");
      expect(() => { while (decoder.next().kind !== "end") { /* Consume until validation fails. */ } }).toThrow(BinaryError);
    }
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retailRoot, "missionpack/pak0.pk3")))("complete retail RoQ corpus matches independent chunk frame/audio counts", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
  const paths = vfs.list().filter(path => path.endsWith(".roq"));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const data = await vfs.read(path);
    const chunks = new BinaryReader(data, path);
    chunks.skip(8);
    let expectedFrames = 0;
    let expectedSamples = 0;
    while (chunks.remaining > 0) {
      const id = chunks.u16();
      const size = chunks.u32();
      chunks.u16();
      chunks.skip(size);
      if (id === 0x1011) expectedFrames++;
      if (id === 0x1020 || id === 0x1021) expectedSamples += size;
    }
    const decoder = new RoqDecoder(data, path);
    let frames = 0;
    let samples = 0;
    for (;;) {
      const event = decoder.next();
      if (event.kind === "end") break;
      if (event.kind === "frame") {
        expect(event.index).toBe(frames++);
        expect(event.rgba.length).toBe(decoder.width * decoder.height * 4);
      } else samples += event.samples.length;
    }
    expect({ path, frames, samples }).toEqual({ path, frames: expectedFrames, samples: expectedSamples });
  }
}, 120000);
