import { describe, expect, test } from "bun:test";
import { constants, deflateRawSync, deflateSync } from "node:zlib";
import { adler32, RawInflateError, RawInflateReader, ZlibDictionaryRequired, ZlibInflateReader } from "../src/assets/inflate.ts";

class FixtureBits {
  private readonly bytes: number[] = [];
  private partial = 0;
  private used = 0;

  bits(value: number, count: number): void {
    for (let bit = 0; bit < count; bit++) {
      this.partial |= ((value >>> bit) & 1) << this.used;
      if (++this.used === 8) this.align();
    }
  }

  code(value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit--) this.bits((value >>> bit) & 1, 1);
  }

  align(): void {
    if (this.used === 0) return;
    this.bytes.push(this.partial);
    this.partial = 0;
    this.used = 0;
  }

  fixedHeader(final: boolean): void {
    this.bits(final ? 1 : 0, 1);
    this.bits(1, 2);
  }

  fixedSymbol(symbol: number): void {
    if (symbol < 144) this.code(0x30 + symbol, 8);
    else if (symbol < 256) this.code(0x190 + symbol - 144, 9);
    else if (symbol < 280) this.code(symbol - 256, 7);
    else this.code(0xc0 + symbol - 280, 8);
  }

  stored(bytes: Uint8Array, final: boolean): void {
    this.bits(final ? 1 : 0, 1);
    this.bits(0, 2);
    this.align();
    this.bits(bytes.length, 16);
    this.bits(bytes.length ^ 0xffff, 16);
    for (const byte of bytes) this.bits(byte, 8);
  }

  dynamicHeader(literalCount: number, distanceCount: number, lengthsInWireOrder: readonly number[]): void {
    this.bits(5, 3);
    this.bits(literalCount - 257, 5);
    this.bits(distanceCount - 1, 5);
    this.bits(lengthsInWireOrder.length - 4, 4);
    for (const length of lengthsInWireOrder) this.bits(length, 3);
  }

  finish(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

function readerFor(bytes: Uint8Array): RawInflateReader {
  let offset = 0;
  return new RawInflateReader(() => bytes[offset++]);
}

function decode(bytes: Uint8Array, chunkSize = 7): Uint8Array {
  const reader = readerFor(bytes);
  const destination = new Uint8Array(chunkSize);
  const output: number[] = [];
  while (!reader.ended) {
    const count = reader.readInto(destination);
    for (const byte of destination.subarray(0, count)) output.push(byte);
  }
  return Uint8Array.from(output);
}

// Code-length symbols 18, 0, 1 have the respective codes 0, 10, 11.
const LITERAL_CODE_LENGTHS = [0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
// Code-length symbols 0, 1, 2, 16, 17, 18 have codes 00, 01, 100, 101, 110, 111.
const REPEAT_CODE_LENGTHS = [3, 3, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 2];

function dynamicLiterals(): Uint8Array {
  const bits = new FixtureBits();
  bits.dynamicHeader(257, 1, LITERAL_CODE_LENGTHS);
  bits.code(0, 1);
  bits.bits(54, 7); // 65 zero lengths before literal A.
  bits.code(3, 2);
  bits.code(0, 1);
  bits.bits(127, 7);
  bits.code(0, 1);
  bits.bits(41, 7); // 190 zero lengths before EOB.
  bits.code(3, 2);
  bits.code(2, 2); // No distance codes.
  bits.code(0, 1);
  bits.code(0, 1);
  bits.code(0, 1);
  bits.code(1, 1);
  return bits.finish();
}

function dynamicRepeats(): Uint8Array {
  const bits = new FixtureBits();
  bits.dynamicHeader(258, 4, REPEAT_CODE_LENGTHS);
  bits.code(4, 3);
  bits.code(4, 3); // Literal 0 and 1 have length two.
  bits.code(7, 3);
  bits.bits(127, 7);
  bits.code(7, 3);
  bits.bits(95, 7);
  bits.code(6, 3);
  bits.bits(7, 3); // 254 zero lengths reach symbol 256.
  bits.code(4, 3);
  bits.code(5, 3);
  bits.bits(2, 2); // Five repeats span literal 257 and all four distances.
  bits.code(1, 2); // Literal 1.
  bits.code(3, 2); // Length 3.
  bits.code(0, 2); // Distance 1.
  bits.code(0, 2); // Literal 0.
  bits.code(2, 2); // EOB.
  return bits.finish();
}

function malformedDynamic(lengths: readonly number[], literalCount = 257, distanceCount = 1): Uint8Array {
  const bits = new FixtureBits();
  bits.dynamicHeader(literalCount, distanceCount, REPEAT_CODE_LENGTHS);
  for (const length of lengths) {
    if (length === 0) bits.code(0, 2);
    else if (length === 1) bits.code(1, 2);
    else if (length === 2) bits.code(4, 3);
    else throw new Error("fixture supports lengths zero through two");
  }
  return bits.finish();
}

describe("TypeScript raw DEFLATE", () => {
  test("constructor and empty reads consume no input, even for invalid data", () => {
    let reads = 0;
    const reader = new RawInflateReader(() => { reads++; return undefined; });
    expect(reader.ended).toBe(false);
    expect(reader.readInto(new Uint8Array())).toBe(0);
    expect(reads).toBe(0);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(RawInflateError);
    expect(reader.readInto(new Uint8Array())).toBe(0);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow("truncated");
    expect(reads).toBe(1);
  });

  test("stored blocks read only the requested data and recognize an exact final boundary", () => {
    const bits = new FixtureBits();
    bits.stored(new Uint8Array([11, 22, 33]), true);
    const bytes = bits.finish();
    let offset = 0;
    const reader = new RawInflateReader(() => bytes[offset++]);
    const destination = new Uint8Array(1);
    expect(reader.readInto(destination)).toBe(1);
    expect(destination[0]).toBe(11);
    expect(offset).toBe(6);
    expect(reader.ended).toBe(false);
    expect(reader.readInto(new Uint8Array(2))).toBe(2);
    expect(reader.ended).toBe(true);
    expect(reader.readInto(destination)).toBe(0);
    expect(offset).toBe(bytes.length);
    expect(decode(new Uint8Array([1, 0, 0, 255, 255]))).toEqual(new Uint8Array());
  });

  test("fixed codes decode every literal value and the empty final block", () => {
    const bits = new FixtureBits();
    bits.fixedHeader(true);
    for (let byte = 0; byte < 256; byte++) bits.fixedSymbol(byte);
    bits.fixedSymbol(256);
    expect(decode(bits.finish(), 1)).toEqual(Uint8Array.from({ length: 256 }, (_, index) => index));
    expect(decode(new Uint8Array([3, 0]))).toEqual(new Uint8Array());
  });

  test("overlapping copies survive chunks without consuming EOB or trailing bytes", () => {
    const bits = new FixtureBits();
    bits.fixedHeader(true);
    bits.fixedSymbol(65);
    bits.fixedSymbol(285);
    bits.code(0, 5);
    bits.fixedSymbol(256);
    const bytes = Uint8Array.from([...bits.finish(), 255]);
    let offset = 0;
    const reader = new RawInflateReader(() => bytes[offset++]);
    const first = new Uint8Array(1);
    expect(reader.readInto(first)).toBe(1);
    expect(first[0]).toBe(65);
    expect(offset).toBe(2);
    expect(reader.readInto(first)).toBe(1);
    expect(offset).toBe(3);
    const rest = new Uint8Array(257);
    expect(reader.readInto(rest)).toBe(257);
    expect(rest.every((byte) => byte === 65)).toBe(true);
    expect(offset).toBe(3);
    expect(reader.ended).toBe(false);
    expect(reader.readInto(first)).toBe(0);
    expect(reader.ended).toBe(true);
    expect(offset).toBe(4);
    expect(reader.readInto(first)).toBe(0);
    expect(offset).toBe(4);
  });

  test("dynamic trees support literal-only data and repeats across the alphabet boundary", () => {
    expect(decode(dynamicLiterals(), 1)).toEqual(new Uint8Array([65, 65, 65]));
    expect(decode(dynamicRepeats(), 2)).toEqual(new Uint8Array([1, 1, 1, 1, 0]));
  });

  test("one-bit single-symbol literal and distance trees retain source acceptance", () => {
    const bits = new FixtureBits();
    bits.dynamicHeader(257, 1, LITERAL_CODE_LENGTHS);
    bits.code(0, 1);
    bits.bits(127, 7);
    bits.code(0, 1);
    bits.bits(107, 7); // 256 zeros.
    bits.code(3, 2); // EOB is the only literal/length code.
    bits.code(3, 2); // One unused, single-bit distance code.
    bits.code(0, 1);
    expect(decode(bits.finish())).toEqual(new Uint8Array());
  });

  test("canonical dynamic decoding reaches the fifteen-bit maximum", () => {
    const bits = new FixtureBits();
    // Symbols 0..15 in the code-length alphabet have their four-bit values.
    bits.dynamicHeader(257, 1, [0, 0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    for (let symbol = 0; symbol < 257; symbol++) {
      const length = symbol < 14 ? symbol + 1 : symbol === 14 || symbol === 256 ? 15 : 0;
      bits.code(length, 4);
    }
    bits.code(1, 4);
    bits.code(0, 1);
    bits.code(16_382, 14);
    bits.code(32_766, 15);
    bits.code(32_767, 15);
    expect(decode(bits.finish(), 1)).toEqual(new Uint8Array([0, 13, 14]));
  });

  test("history spans fixed and stored block boundaries, including byte realignment", () => {
    const bits = new FixtureBits();
    bits.fixedHeader(false);
    bits.fixedSymbol(88);
    bits.fixedSymbol(256);
    bits.stored(new Uint8Array([89]), false);
    bits.fixedHeader(true);
    bits.fixedSymbol(259); // Length five, distance two adds X,Y,X,Y,X.
    bits.code(1, 5);
    bits.fixedSymbol(256);
    expect(decode(bits.finish(), 1)).toEqual(new Uint8Array([88, 89, 88, 89, 88, 89, 88]));
  });

  test("distance 32768 survives history wrap and crosses read boundaries", () => {
    const prefix = Uint8Array.from({ length: 32_768 }, (_, index) => (index * 13 + (index >>> 8)) & 255);
    const bits = new FixtureBits();
    bits.stored(prefix, false);
    bits.fixedHeader(true);
    bits.fixedSymbol(285);
    bits.code(29, 5);
    bits.bits(8191, 13);
    bits.fixedSymbol(285);
    bits.code(29, 5);
    bits.bits(8191, 13);
    bits.fixedSymbol(256);
    expect(decode(bits.finish(), 113)).toEqual(Uint8Array.from([...prefix, ...prefix.subarray(0, 516)]));
  });

  test("length and distance extra-bit groups match authored expected bytes", () => {
    const prefix = Uint8Array.from({ length: 32_768 }, (_, index) => (index * 23 + (index >>> 7)) & 255);
    const bits = new FixtureBits();
    bits.stored(prefix, false);
    bits.fixedHeader(true);
    const lengths = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 258, 258];
    const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const distances = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
    const distanceExtraBits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const expected = [...prefix];
    for (const [index, distance] of distances.entries()) {
      const lengthIndex = index % lengths.length;
      const length = lengths[lengthIndex];
      const lengthExtra = lengthExtraBits[lengthIndex];
      const distanceExtra = distanceExtraBits[index];
      if (length === undefined || lengthExtra === undefined || distanceExtra === undefined) throw new Error("incomplete analytic fixture");
      bits.fixedSymbol(257 + lengthIndex);
      bits.bits((1 << lengthExtra) - 1, lengthExtra);
      bits.code(index, 5);
      bits.bits((1 << distanceExtra) - 1, distanceExtra);
      for (let count = 0; count < length; count++) {
        const byte = expected[expected.length - distance];
        if (byte === undefined) throw new Error("analytic distance exceeds fixture history");
        expected.push(byte);
      }
    }
    bits.fixedSymbol(256);
    expect(decode(bits.finish(), 17)).toEqual(Uint8Array.from(expected));
  });

  test("authored corpora agree with independently compressed stored, fixed and dynamic streams", () => {
    let random = 0x1256_3412;
    const varied = Uint8Array.from({ length: 70_001 }, (_, index) => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return index % 5 === 0 ? random & 255 : index % 11;
    });
    const corpora = [new Uint8Array(), new TextEncoder().encode("quake quake quake\n".repeat(4100)), varied];
    for (const corpus of corpora) {
      for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE]) {
        const compressed = deflateRawSync(corpus, { strategy });
        for (const chunkSize of [1, 3, 257, 65_536]) expect(decode(compressed, chunkSize)).toEqual(corpus);
      }
      expect(decode(deflateRawSync(corpus, { level: 0 }), 101)).toEqual(corpus);
    }
  });

  test("rejects truncated stored, fixed, dynamic, and match input", () => {
    const stored = new FixtureBits();
    stored.stored(new Uint8Array([5, 4, 3, 2, 1]), true);
    const fixed = new FixtureBits();
    fixed.fixedHeader(true);
    fixed.fixedSymbol(65);
    fixed.fixedSymbol(285);
    fixed.code(0, 5);
    fixed.fixedSymbol(256);
    const extraBits = new FixtureBits();
    extraBits.stored(new Uint8Array(32_768).fill(67), false);
    extraBits.fixedHeader(true);
    extraBits.fixedSymbol(284);
    extraBits.bits(31, 5);
    extraBits.code(29, 5);
    extraBits.bits(8191, 13);
    extraBits.fixedSymbol(256);
    const extraBytes = extraBits.finish();
    for (let length = extraBytes.length - 5; length < extraBytes.length; length++) {
      expect(() => decode(extraBytes.subarray(0, length))).toThrow("truncated");
    }
    for (const complete of [stored.finish(), fixed.finish(), dynamicLiterals(), dynamicRepeats()]) {
      for (let length = 0; length < complete.length; length++) {
        expect(() => decode(complete.subarray(0, length))).toThrow("truncated");
      }
    }
  });

  test("rejects reserved block types, stored complements and symbols", () => {
    expect(() => decode(new Uint8Array([7]))).toThrow("invalid block type");
    expect(() => decode(new Uint8Array([1, 1, 0, 255, 255, 65]))).toThrow("invalid stored block lengths");
    for (const symbol of [286, 287]) {
      const bits = new FixtureBits();
      bits.fixedHeader(true);
      bits.fixedSymbol(symbol);
      expect(() => decode(bits.finish())).toThrow("invalid literal/length code");
    }
    for (const symbol of [30, 31]) {
      const bits = new FixtureBits();
      bits.fixedHeader(true);
      bits.fixedSymbol(65);
      bits.fixedSymbol(257);
      bits.code(symbol, 5);
      expect(() => decode(bits.finish())).toThrow("invalid distance code");
    }
  });

  test("rejects a distance before output and beyond the available history", () => {
    for (const prefix of [new Uint8Array(), new Uint8Array([65])]) {
      const bits = new FixtureBits();
      bits.fixedHeader(true);
      for (const byte of prefix) bits.fixedSymbol(byte);
      bits.fixedSymbol(257);
      bits.code(1, 5);
      expect(() => decode(bits.finish())).toThrow("distance exceeds available output history");
    }
  });

  test("rejects oversubscribed, incomplete and empty dynamic trees", () => {
    for (const lengths of [[1, 1, 1, 0], [2, 0, 0, 0], [0, 0, 0, 0]]) {
      const bits = new FixtureBits();
      bits.dynamicHeader(257, 1, lengths);
      expect(() => decode(bits.finish())).toThrow("tree");
    }
    const overLiterals = new Array<number>(258).fill(0);
    overLiterals[0] = 1;
    overLiterals[1] = 1;
    overLiterals[256] = 1;
    expect(() => decode(malformedDynamic(overLiterals))).toThrow("oversubscribed literal/length tree");
    const incompleteLiterals = new Array<number>(258).fill(0);
    incompleteLiterals[0] = 2;
    incompleteLiterals[256] = 2;
    expect(() => decode(malformedDynamic(incompleteLiterals))).toThrow("incomplete literal/length tree");
    expect(() => decode(malformedDynamic(new Array<number>(258).fill(0)))).toThrow("incomplete literal/length tree");
    const overDistances = new Array<number>(260).fill(0);
    overDistances[0] = 1;
    overDistances[256] = 1;
    overDistances[257] = 1;
    overDistances[258] = 1;
    overDistances[259] = 1;
    expect(() => decode(malformedDynamic(overDistances, 257, 3))).toThrow("oversubscribed distance tree");
    overDistances[257] = 2;
    overDistances[258] = 2;
    overDistances[259] = 0;
    expect(() => decode(malformedDynamic(overDistances, 257, 3))).toThrow("incomplete distance tree");
  });

  test("retains pinned source dynamic-count and empty-distance rejection", () => {
    for (const [literalCount, distanceCount] of [[287, 1], [288, 1], [257, 31], [257, 32]]) {
      if (literalCount === undefined || distanceCount === undefined) throw new Error("incomplete counts fixture");
      const bits = new FixtureBits();
      bits.dynamicHeader(literalCount, distanceCount, [0, 0, 0, 0]);
      expect(() => decode(bits.finish())).toThrow("too many length or distance symbols");
    }
    const lengths = new Array<number>(259).fill(0);
    lengths[256] = 1;
    expect(() => decode(malformedDynamic(lengths, 258, 1))).toThrow("empty distance tree with lengths");
  });

  test("rejects repeat-before-previous and repeats beyond the combined alphabets", () => {
    const previous = new FixtureBits();
    previous.dynamicHeader(257, 1, REPEAT_CODE_LENGTHS);
    previous.code(5, 3);
    previous.bits(0, 2);
    expect(() => decode(previous.finish())).toThrow("invalid bit length repeat");
    const overflow = new FixtureBits();
    overflow.dynamicHeader(257, 1, REPEAT_CODE_LENGTHS);
    overflow.code(7, 3);
    overflow.bits(127, 7);
    overflow.code(7, 3);
    overflow.bits(127, 7);
    expect(() => decode(overflow.finish())).toThrow("invalid bit length repeat");
  });

  test("validates callback bytes and preserves callback failures", () => {
    for (const value of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RawInflateReader(() => value).readInto(new Uint8Array(1))).toThrow("invalid byte");
    }
    const error = new Error("input source failed");
    let calls = 0;
    const reader = new RawInflateReader(() => { calls++; throw error; });
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(error);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(error);
    expect(calls).toBe(1);
  });
});

function zlibFixture(raw: Uint8Array, checksum: number, dictionary: number | null = null, windowBits = 15): Uint8Array {
  const method = ((windowBits - 8) << 4) | 8;
  const flags = dictionary === null ? 0 : 32;
  const bytes = [method, flags + (31 - (((method << 8) | flags) % 31)) % 31];
  if (dictionary !== null) bytes.push(dictionary >>> 24, (dictionary >>> 16) & 255, (dictionary >>> 8) & 255, dictionary & 255);
  return Uint8Array.from([...bytes, ...raw, checksum >>> 24, (checksum >>> 16) & 255, (checksum >>> 8) & 255, checksum & 255]);
}

function zlibReaderFor(bytes: Uint8Array, windowBits = 15): ZlibInflateReader {
  let offset = 0;
  return new ZlibInflateReader(() => bytes[offset++], windowBits);
}

function decodeZlib(bytes: Uint8Array, chunkSize = 7): Uint8Array {
  const reader = zlibReaderFor(bytes);
  const destination = new Uint8Array(chunkSize);
  const output: number[] = [];
  while (!reader.ended) {
    const count = reader.readInto(destination);
    output.push(...destination.subarray(0, count));
  }
  return Uint8Array.from(output);
}

describe("TypeScript zlib wrapper", () => {
  test("Adler32 retains reset, empty-seed, incremental and reduction-boundary behavior", () => {
    expect(adler32(0xffff_ffff, null)).toBe(1);
    expect(adler32(0x8765_4321, new Uint8Array())).toBe(0x8765_4321);
    expect(adler32(1, new TextEncoder().encode("Wikipedia"))).toBe(0x11e6_0398);
    expect(adler32(adler32(1, new TextEncoder().encode("Wiki")), new TextEncoder().encode("pedia"))).toBe(0x11e6_0398);
    // Closed-form sums for n identical bytes, independent of chunk reduction.
    for (const length of [5551, 5552, 5553, 65_536]) {
      const low = (1 + 255 * length) % 65521;
      const high = (length + 255 * length * (length + 1) / 2) % 65521;
      expect(adler32(1, new Uint8Array(length).fill(255))).toBe(((high << 16) | low) >>> 0);
    }
  });

  test("authored wrappers decode stored, fixed, dynamic and empty bodies", () => {
    const stored = new FixtureBits();
    stored.stored(new Uint8Array([65, 66, 67]), true);
    const fixed = new FixtureBits();
    fixed.fixedHeader(true);
    for (const byte of [65, 66, 67]) fixed.fixedSymbol(byte);
    fixed.fixedSymbol(256);
    for (const body of [stored.finish(), fixed.finish()]) {
      for (const chunkSize of [1, 3, 8]) expect(decodeZlib(zlibFixture(body, 0x018d_00c7), chunkSize)).toEqual(new Uint8Array([65, 66, 67]));
    }
    expect(decodeZlib(zlibFixture(dynamicLiterals(), 0x0189_00c4))).toEqual(new Uint8Array([65, 65, 65]));
    expect(decodeZlib(new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1]))).toEqual(new Uint8Array());
  });

  test("header errors preserve source validation order and stop input consumption", () => {
    for (const { bytes, message, consumed } of [
      { bytes: [0x79, 0], message: "unknown compression method", consumed: 1 },
      { bytes: [0x88, 0], message: "invalid window size", consumed: 1 },
      { bytes: [0x78, 0], message: "incorrect header check", consumed: 2 },
    ]) {
      const input = Uint8Array.from(bytes);
      let offset = 0;
      const reader = new ZlibInflateReader(() => input[offset++]);
      expect(offset).toBe(0);
      expect(reader.readInto(new Uint8Array())).toBe(0);
      expect(() => reader.readInto(new Uint8Array(1))).toThrow(message);
      expect(offset).toBe(consumed);
      expect(() => reader.readInto(new Uint8Array(1))).toThrow(message);
      expect(offset).toBe(consumed);
    }
  });

  test("checksums consume four aligned bytes and leave trailing input untouched", () => {
    const bytes = new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1, 0xaa]);
    let offset = 0;
    const reader = new ZlibInflateReader(() => bytes[offset++]);
    expect(reader.readInto(new Uint8Array(1))).toBe(0);
    expect(reader.ended).toBe(true);
    expect(offset).toBe(8);
    expect(reader.readInto(new Uint8Array(1))).toBe(0);
    expect(offset).toBe(8);
    bytes[7] = 2;
    const invalid = zlibReaderFor(bytes);
    expect(() => invalid.readInto(new Uint8Array(1))).toThrow("incorrect data check");
    expect(invalid.ended).toBe(false);
    expect(() => invalid.readInto(new Uint8Array(1))).toThrow("incorrect data check");
  });

  test("a full fixed-block destination leaves EOB and trailer for the next read", () => {
    const body = new FixtureBits();
    body.fixedHeader(true);
    body.fixedSymbol(65);
    body.fixedSymbol(256);
    const input = zlibFixture(body.finish(), 0x0042_0042);
    let offset = 0;
    const reader = new ZlibInflateReader(() => input[offset++]);
    const destination = new Uint8Array(1);
    expect(reader.readInto(destination)).toBe(1);
    expect(destination[0]).toBe(65);
    expect(reader.ended).toBe(false);
    expect(offset).toBeLessThan(input.length - 4);
    const beforeEmptyRead = offset;
    expect(reader.readInto(new Uint8Array())).toBe(0);
    expect(offset).toBe(beforeEmptyRead);
    expect(reader.readInto(destination)).toBe(0);
    expect(reader.ended).toBe(true);
    expect(offset).toBe(input.length);
  });

  test("all partial headers, bodies, dictionary IDs and trailers reject truncation", () => {
    const body = new FixtureBits();
    body.stored(new Uint8Array([65, 66, 67]), true);
    const complete = zlibFixture(body.finish(), 0x018d_00c7);
    for (let length = 0; length < complete.length; length++) {
      expect(() => decodeZlib(complete.subarray(0, length))).toThrow("truncated compressed input");
    }
    const dictionary = zlibFixture(new Uint8Array([3, 0]), 1, 0x018d_00c7);
    for (let length = 2; length < 6; length++) {
      expect(() => decodeZlib(dictionary.subarray(0, length))).toThrow("truncated compressed input");
    }
  });

  test("dictionary request stops before blocks; wrong dictionary retries and correct history supplies matches", () => {
    const body = new FixtureBits();
    body.fixedHeader(true);
    body.fixedSymbol(260); // Six bytes, all copied from dictionary history.
    body.code(2, 5); // Distance three, overlapping after ABC.
    body.fixedSymbol(256);
    const input = zlibFixture(body.finish(), 0x056c_018d, 0x018d_00c7);
    let offset = 0;
    const reader = new ZlibInflateReader(() => input[offset++]);
    const destination = new Uint8Array(2);
    expect(() => reader.setDictionary(new Uint8Array())).toThrow("dictionary not requested");
    expect(offset).toBe(0);
    expect(() => reader.readInto(destination)).toThrow(ZlibDictionaryRequired);
    expect(offset).toBe(6);
    expect(reader.dictionaryAdler).toBe(0x018d_00c7);
    expect(() => reader.setDictionary(new Uint8Array([65, 66]))).toThrow("incorrect dictionary check");
    expect(reader.dictionaryAdler).toBe(0x018d_00c7);
    expect(offset).toBe(6);
    const dictionary = new Uint8Array([65, 66, 67]);
    reader.setDictionary(dictionary);
    dictionary.fill(0); // The ring owns a copy of the dictionary.
    expect(reader.dictionaryAdler).toBeNull();
    const output: number[] = [];
    while (!reader.ended) {
      const count = reader.readInto(destination);
      output.push(...destination.subarray(0, count));
    }
    expect(output).toEqual([65, 66, 67, 65, 66, 67]);
    expect(offset).toBe(input.length);
    expect(() => reader.setDictionary(dictionary)).toThrow("dictionary not requested");
  });

  test("reading again without the requested dictionary enters permanent imBAD", () => {
    const input = zlibFixture(new Uint8Array([3, 0]), 1, 1);
    let offset = 0;
    const reader = new ZlibInflateReader(() => input[offset++]);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(ZlibDictionaryRequired);
    expect(reader.readInto(new Uint8Array())).toBe(0);
    expect(reader.dictionaryAdler).toBe(1);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow("need dictionary");
    expect(reader.dictionaryAdler).toBeNull();
    expect(() => reader.setDictionary(new Uint8Array())).toThrow("dictionary not requested");
    expect(() => reader.readInto(new Uint8Array(1))).toThrow("need dictionary");
    expect(offset).toBe(6);
  });

  test("an empty requested dictionary initializes empty history and an independent output check", () => {
    const reader = zlibReaderFor(zlibFixture(new Uint8Array([3, 0]), 1, 1));
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(ZlibDictionaryRequired);
    reader.setDictionary(new Uint8Array());
    expect(reader.readInto(new Uint8Array(1))).toBe(0);
    expect(reader.ended).toBe(true);
  });

  test("configured window accepts 8 through 15 bits and rejects oversized stream headers", () => {
    for (let windowBits = 8; windowBits <= 15; windowBits++) {
      const reader = zlibReaderFor(zlibFixture(new Uint8Array([3, 0]), 1, null, windowBits), windowBits);
      expect(reader.readInto(new Uint8Array(1))).toBe(0);
      expect(reader.ended).toBe(true);
    }
    expect(() => zlibReaderFor(new Uint8Array([0x78]), 14).readInto(new Uint8Array(1))).toThrow("invalid window size");
    for (const size of [7, 16, -15, 8.5, Number.NaN]) expect(() => zlibReaderFor(new Uint8Array(), size)).toThrow(RangeError);
  });

  test("dictionary retention drops leading bytes at the configured ring boundary", () => {
    const dictionary = Uint8Array.from({ length: 300 }, (_, index) => index & 255);
    const body = new FixtureBits();
    body.fixedHeader(true);
    body.fixedSymbol(257); // Three bytes at distance 255 use original dictionary[45..47].
    body.code(15, 5);
    body.bits(62, 6);
    body.fixedSymbol(256);
    const reader = zlibReaderFor(zlibFixture(body.finish(), 0x0115_008b, adler32(1, dictionary), 8), 8);
    const destination = new Uint8Array(4);
    expect(() => reader.readInto(destination)).toThrow(ZlibDictionaryRequired);
    reader.setDictionary(dictionary);
    expect(reader.readInto(destination)).toBe(3);
    expect(destination.subarray(0, 3)).toEqual(new Uint8Array([45, 46, 47]));
    expect(reader.ended).toBe(true);

    const discarded = new FixtureBits();
    discarded.fixedHeader(true);
    discarded.fixedSymbol(257);
    discarded.code(15, 5);
    discarded.bits(63, 6); // Distance 256 reaches the byte excluded by the source setter.
    const invalid = zlibReaderFor(zlibFixture(discarded.finish(), 1, adler32(1, dictionary), 8), 8);
    expect(() => invalid.readInto(destination)).toThrow(ZlibDictionaryRequired);
    invalid.setDictionary(dictionary);
    expect(() => invalid.readInto(destination)).toThrow("distance exceeds available output history");
  });

  test("independently compressed wrapped corpora and long dictionaries decode through real blocks", () => {
    const dictionary = Uint8Array.from({ length: 40_000 }, (_, index) => (index * 11 + (index >>> 8)) & 255);
    const corpus = Uint8Array.from([...dictionary.subarray(39_000), ...new TextEncoder().encode("quake quake quake\n".repeat(4100))]);
    for (const options of [{ level: 0 }, { strategy: constants.Z_FIXED }, { strategy: constants.Z_DEFAULT_STRATEGY }]) {
      expect(decodeZlib(deflateSync(corpus, options), 113)).toEqual(corpus);
    }
    const reader = zlibReaderFor(deflateSync(corpus, { dictionary }));
    const destination = new Uint8Array(113);
    expect(() => reader.readInto(destination)).toThrow(ZlibDictionaryRequired);
    reader.setDictionary(dictionary);
    const output: number[] = [];
    while (!reader.ended) {
      const count = reader.readInto(destination);
      output.push(...destination.subarray(0, count));
    }
    expect(Uint8Array.from(output)).toEqual(corpus);
  });

  test("invalid callback bytes and callback exceptions become permanent failures", () => {
    for (const value of [-1, 256, 1.5, Number.NaN]) {
      expect(() => new ZlibInflateReader(() => value).readInto(new Uint8Array(1))).toThrow("invalid byte");
    }
    const error = new Error("wrapped input failed");
    let calls = 0;
    const reader = new ZlibInflateReader(() => { calls++; throw error; });
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(error);
    expect(() => reader.readInto(new Uint8Array(1))).toThrow(error);
    expect(calls).toBe(1);
  });
});
