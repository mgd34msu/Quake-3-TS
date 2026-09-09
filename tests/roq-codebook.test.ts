import { describe, expect, test } from "bun:test";
import { BinaryError, BinaryReader } from "../src/core/binary.ts";
import { SourceRoqCodebooks, yuvToRgb565, yuvToRgba } from "../src/cinematic/roq-codebook.ts";
import type { RoqCodebookFormat, RoqCodebookMode } from "../src/cinematic/roq-codebook.ts";
import { RoqDecoderScratch } from "../src/cinematic/roq.ts";

const gray = Uint8Array.from({ length: 256 }, (_, index) => 255 - index);
const formats: readonly RoqCodebookFormat[] = [{ samplesPerPixel: 1, gray }, { samplesPerPixel: 2 }, { samplesPerPixel: 4 }];
const fixtures: readonly {
  readonly mode: RoqCodebookMode;
  readonly rowWidth: number;
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly joined: readonly number[];
}[] = [
  { mode: "normal", rowWidth: 4, left: [0, 32, 128, 255], right: [255, 128, 32, 0],
    joined: [0, 32, 255, 128, 128, 255, 32, 0, 255, 128, 0, 32, 32, 0, 128, 255] },
  { mode: "half", rowWidth: 2, left: [0, 128], right: [255, 32],
    joined: [0, 255, 128, 32, 255, 0, 32, 128] },
  { mode: "smoothed-double", rowWidth: 4, left: [0, 32, 32, 87, 96, 199, 128, 255], right: [255, 128, 199, 96, 87, 32, 32, 0],
    joined: [0, 32, 255, 128, 32, 87, 199, 96, 96, 199, 87, 32, 128, 255, 32, 0,
      255, 128, 0, 32, 199, 96, 32, 87, 87, 32, 96, 199, 32, 0, 128, 255] },
];

// Neutral chroma source constants: UB=89, VR=77, UG=-11, VG=8.
const colors = new Map<number, { readonly rgb565: number; readonly rgba: readonly number[] }>([
  [0, { rgb565: 0x0000, rgba: [1, 0, 1, 255] }],
  [32, { rgb565: 0x2104, rgba: [33, 32, 33, 255] }],
  [87, { rgb565: 0x5aab, rgba: [88, 87, 88, 255] }],
  [96, { rgb565: 0x630c, rgba: [97, 96, 97, 255] }],
  [128, { rgb565: 0x8410, rgba: [129, 128, 129, 255] }],
  [199, { rgb565: 0xce39, rgba: [200, 199, 201, 255] }],
  [255, { rgb565: 0xffff, rgba: [255, 255, 255, 255] }],
]);

function bytes(luminance: readonly number[], width: 1 | 2 | 4): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(luminance.flatMap(y => {
    if (width === 1) return [255 - y];
    const color = colors.get(y);
    if (color === undefined) throw new Error(`Missing independent color fixture ${y}`);
    return width === 2 ? [color.rgb565 & 255, color.rgb565 >>> 8] : color.rgba;
  }));
}

function reader(input: readonly number[]): BinaryReader { return new BinaryReader(Uint8Array.from(input), "codebook.roq"); }

describe("source RoQ codebooks", () => {
  for (const fixture of fixtures) {
    for (const format of formats) {
      test(`${fixture.mode}, ${format.samplesPerPixel}-byte pixels: exact cells and VQ macro rows`, () => {
        const books = new SourceRoqCodebooks();
        books.book2.fill(0x45); books.book4.fill(0x45); books.book8.fill(0x45);
        const input = reader([0, 32, 128, 255, 128, 128, 255, 128, 32, 0, 128, 128, 0, 1, 1, 0, 77]);
        books.decode(input, 0x0201, fixture.mode, format);
        expect(input.offset).toBe(16);
        expect(input.u8()).toBe(77);
        const expected2 = bytes([...fixture.left, ...fixture.right], format.samplesPerPixel);
        const expected4 = bytes(fixture.joined, format.samplesPerPixel);
        const large: number[] = [];
        for (let row = 0; row < fixture.joined.length; row += fixture.rowWidth) {
          const doubled = fixture.joined.slice(row, row + fixture.rowWidth).flatMap(y => [y, y]);
          large.push(...doubled, ...doubled);
        }
        const expected8 = bytes(large, format.samplesPerPixel);
        expect(books.book2.subarray(0, expected2.length)).toEqual(expected2);
        expect(books.book4.subarray(0, expected4.length)).toEqual(expected4);
        expect(books.book8.subarray(0, expected8.length)).toEqual(expected8);
        expect(books.book2.subarray(expected2.length).every(value => value === 0x45)).toBe(true);
        expect(books.book4.subarray(expected4.length).every(value => value === 0x45)).toBe(true);
        expect(books.book8.subarray(expected8.length).every(value => value === 0x45)).toBe(true);
      });
    }
  }

  test("full unsigned-short backing survives movie clearing and supports the largest source profile", () => {
    const scratch = new RoqDecoderScratch();
    expect(scratch.codebooks.vq2.length).toBe(256 * 16 * 4);
    expect(scratch.codebooks.vq4.length).toBe(256 * 64 * 4);
    expect(scratch.codebooks.vq8.length).toBe(256 * 256 * 4);
    expect(scratch.book2.byteLength).toBe(32768);
    expect(scratch.book4.byteLength).toBe(131072);
    expect(scratch.book8.byteLength).toBe(524288);
    const input = reader([...Array.from({ length: 256 }, () => [255, 255, 255, 255, 128, 128]).flat(),
      ...new Array<number>(1024).fill(255)]);
    scratch.codebooks.decode(input, 0, "smoothed-double", { samplesPerPixel: 4 });
    expect(input.remaining).toBe(0);
    expect(scratch.book2.subarray(0, 8192).every(value => value === 255)).toBe(true);
    expect(scratch.book4.subarray(0, 32768).every(value => value === 255)).toBe(true);
    expect(scratch.book8.subarray(0, 131072).every(value => value === 255)).toBe(true);
    for (const book of [scratch.book2, scratch.book4, scratch.book8]) book[book.length - 1] = 99;
    scratch.clearMovieState();
    expect(scratch.book8[131071]).toBe(255);
    for (const book of [scratch.book2, scratch.book4, scratch.book8]) expect(book[book.length - 1]).toBe(99);
    scratch.clear();
    for (const book of [scratch.book2, scratch.book4, scratch.book8]) expect(book.every(value => value === 0)).toBe(true);
  });

  test("high-byte zero updates all 256 cells; source zero flags still require index pairs", () => {
    const books = new SourceRoqCodebooks();
    const cells = Array.from({ length: 256 }, () => [0, 32, 128, 255, 128, 128]).flat();
    books.decode(reader([...cells, 255, 255, 255, 255]), 1, "half", { samplesPerPixel: 1, gray });
    expect(books.book2.subarray(510, 512)).toEqual(Uint8Array.of(255, 127));
    expect(books.book4.subarray(0, 8)).toEqual(Uint8Array.of(255, 255, 127, 127, 255, 255, 127, 127));
    expect(() => books.decode(reader(cells), 0, "normal", { samplesPerPixel: 4 })).toThrow(BinaryError);
    expect(() => books.decode(reader(cells), 0, "normal", { samplesPerPixel: 4 }, "diagnostic-2x2")).not.toThrow();
  });

  test("partial updates retain old entries and reinterpret the same allocation across modes", () => {
    const books = new SourceRoqCodebooks();
    books.decode(reader([0, 32, 128, 255, 128, 128, 255, 128, 32, 0, 128, 128]), 0x0200,
      "normal", { samplesPerPixel: 1, gray });
    books.decode(reader([128, 0, 32, 0, 128, 128, 0, 3, 3, 0]), 0x0101, "half", { samplesPerPixel: 1, gray });
    expect(books.book2.subarray(0, 8)).toEqual(Uint8Array.of(127, 223, 127, 0, 0, 127, 223, 255));
    expect(books.book4.subarray(0, 8)).toEqual(Uint8Array.of(127, 223, 223, 255, 223, 127, 255, 223));
  });

  test("gray lookup borrows its supplied byte offset and permits a larger backing view", () => {
    const backing = new Uint8Array(300);
    backing.set(gray, 11);
    const books = new SourceRoqCodebooks();
    books.decode(reader([0, 32, 128, 255, 128, 128]), 0x0100, "normal",
      { samplesPerPixel: 1, gray: backing.subarray(11) });
    expect(books.book2.subarray(0, 4)).toEqual(Uint8Array.of(255, 223, 127, 0));
  });

  test("truncated cells preserve reached gray writes and defer color/smoothed writes", () => {
    for (const fixture of fixtures) for (const format of formats) {
      const books = new SourceRoqCodebooks();
      books.book2.fill(0x45);
      expect(() => books.decode(reader([0, 32, 128]), 0x0100, fixture.mode, format)).toThrow(BinaryError);
      const written = format.samplesPerPixel === 1
        ? fixture.mode === "normal" ? [255, 223, 127] : fixture.mode === "half" ? [255, 127] : [] : [];
      expect(books.book2.subarray(0, written.length)).toEqual(Uint8Array.from(written));
      expect(books.book2.subarray(written.length).every(value => value === 0x45)).toBe(true);
    }
  });

  test("truncated expansion publishes only complete source index pairs in every mode", () => {
    for (const fixture of fixtures) for (const format of formats) for (const indexes of [[0], [0, 0]]) {
      const books = new SourceRoqCodebooks();
      books.book4.fill(0x45); books.book8.fill(0x45);
      expect(() => books.decode(reader([0, 32, 128, 255, 128, 128, ...indexes]), 0x0101, fixture.mode, format)).toThrow(BinaryError);
      const expected4 = indexes.length === 2 ? fixture.left.length * 2 * format.samplesPerPixel : 0;
      expect(books.book4.subarray(0, expected4).some(value => value !== 0x45)).toBe(indexes.length === 2);
      expect(books.book4.subarray(expected4).every(value => value === 0x45)).toBe(true);
      expect(books.book8.subarray(expected4 * 4).every(value => value === 0x45)).toBe(true);
    }
  });

  test("malformed flags, lookup sizes and scalar inputs reject before mutation", () => {
    const books = new SourceRoqCodebooks();
    for (const flags of [-1, 65536, 1.5, NaN]) {
      expect(() => books.decode(reader([]), flags, "normal", { samplesPerPixel: 4 })).toThrow(BinaryError);
    }
    for (const length of [0, 255]) {
      expect(() => books.decode(reader([]), 0x0100, "normal", { samplesPerPixel: 1, gray: new Uint8Array(length) })).toThrow(BinaryError);
    }
    for (const value of [-1, 256, 1.5, NaN]) for (const convert of [yuvToRgb565, yuvToRgba]) {
      expect(() => convert(value, 128, 128)).toThrow(RangeError);
      expect(() => convert(128, value, 128)).toThrow(RangeError);
      expect(() => convert(128, 128, value)).toThrow(RangeError);
    }
    expect(books.book2.every(value => value === 0)).toBe(true);
  });

  test("YUV scalar conversion preserves source neutral quantization and saturated channels", () => {
    for (const [y, color] of colors) {
      expect(yuvToRgb565(y, 128, 128)).toBe(color.rgb565);
      const result = new DataView(new ArrayBuffer(4));
      result.setUint32(0, yuvToRgba(y, 128, 128), true);
      expect(Array.from(new Uint8Array(result.buffer))).toEqual(Array.from(color.rgba));
    }
    expect(yuvToRgb565(0, 0, 0)).toBe(0x0440);
    expect(yuvToRgb565(255, 255, 255)).toBe(0xfbbf);
    expect(yuvToRgba(0, 0, 0)).toBe(0xff008b00);
    expect(yuvToRgba(255, 255, 255)).toBe(0xffff75ff);
  });
});
