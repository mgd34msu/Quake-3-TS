import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeJpeg as decodeJpegWithWarnings, JpegSourceError } from "../src/assets/jpeg.ts";
import { BinaryError } from "../src/core/binary.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { JpegImage } from "../src/assets/jpeg.ts";

function decodeJpeg(bytes: Uint8Array, source = "JPEG"): JpegImage {
  return decodeJpegWithWarnings(bytes, source, () => undefined);
}

function segment(marker: number, data: readonly number[]): number[] {
  const length = data.length + 2;
  return [255, marker, length >> 8, length & 255, ...data];
}

function withAdobe(bytes: Uint8Array, transform: number): Uint8Array {
  return new Uint8Array([255, 216, ...segment(238, [65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, transform]), ...bytes.subarray(2)]);
}

interface Block {
  readonly dc: number;
  readonly ac: boolean;
}

interface Fixture {
  readonly width: number;
  readonly height: number;
  readonly sampling: readonly number[];
  readonly blocks: readonly Block[];
  readonly restart: number;
}

// Deliberately small, hand-specified Huffman tables: DC categories 0..11
// have four-bit codes; AC EOB, +1 and ZRL have two-bit codes 00, 01, 10.
function fixture(options: Fixture): Uint8Array {
  const bytes = [255, 216];
  bytes.push(...segment(219, [0, ...new Array<number>(64).fill(1)]));
  const components = options.sampling.flatMap((sampling, index) => [index + 1, sampling, 0]);
  bytes.push(...segment(192, [8, options.height >> 8, options.height & 255, options.width >> 8, options.width & 255, options.sampling.length, ...components]));
  const dcCounts = [0, 0, 0, 12, ...new Array<number>(12).fill(0)];
  const acCounts = [0, 3, ...new Array<number>(14).fill(0)];
  bytes.push(...segment(196, [0, ...dcCounts, ...Array.from({ length: 12 }, (_, index) => index), 16, ...acCounts, 0, 1, 240]));
  if (options.restart > 0) bytes.push(...segment(221, [0, options.restart]));
  bytes.push(...segment(218, [options.sampling.length, ...options.sampling.flatMap((_, index) => [index + 1, 0]), 0, 63, 0]));
  let bits = "";
  let restart = 0;
  const flush = (): void => {
    bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "1");
    for (let index = 0; index < bits.length; index += 8) {
      const byte = Number.parseInt(bits.slice(index, index + 8), 2);
      bytes.push(byte);
      if (byte === 255) bytes.push(0);
    }
    bits = "";
  };
  for (const [index, block] of options.blocks.entries()) {
    if (options.restart > 0 && index > 0 && index % options.restart === 0) {
      flush();
      bytes.push(255, 208 + restart);
      restart = (restart + 1) % 8;
    }
    const size = block.dc === 0 ? 0 : Math.floor(Math.log2(Math.abs(block.dc))) + 1;
    bits += size.toString(2).padStart(4, "0");
    if (size > 0) bits += (block.dc < 0 ? block.dc - 1 + 2 ** size : block.dc).toString(2).padStart(size, "0");
    if (block.ac) bits += "011";
    bits += "00";
  }
  flush();
  bytes.push(255, 217);
  return new Uint8Array(bytes);
}

function gray(blocks: readonly Block[] = [{ dc: 0, ac: false }], width = 8, restart = 0): Uint8Array {
  return fixture({ width, height: 8, sampling: [17], blocks, restart });
}

function contextAliasFixture(height = 17): Uint8Array {
  const blocks: Block[] = [];
  let previous = 0;
  for (const values of [[40, 50, 60, 70], [80, 90, 100, 110], [120, 130, 140, 150], [160, 170, 180, 190]]) {
    blocks.push(...new Array<Block>(4).fill({ dc: 0, ac: false }));
    for (const value of values) {
      const coefficient = (value - 128) * 8;
      blocks.push({ dc: coefficient - previous, ac: false });
      previous = coefficient;
    }
    blocks.push({ dc: 0, ac: false });
  }
  const bytes = fixture({ width: 17, height, sampling: [34, 34, 17], restart: 0, blocks });
  bytes[markerOffset(bytes, 192) + 14] = 18;
  bytes[markerOffset(bytes, 218) + 7] = 1;
  return bytes;
}

// Coefficients and quantizers are in JPEG zigzag order. Four-bit AC codes
// encode EOB, categories 1..10, and ZRL, independently of the decoder tables.
function coefficientFixture(coefficients: readonly number[], quantizers: readonly number[]): Uint8Array {
  const bytes = [255, 216, ...segment(219, [0, ...quantizers]),
    ...segment(192, [8, 0, 8, 0, 8, 1, 1, 17, 0])];
  const counts = [0, 0, 0, 12, ...new Array<number>(12).fill(0)];
  bytes.push(...segment(196, [0, ...counts, ...Array.from({ length: 12 }, (_, index) => index),
    16, ...counts, ...Array.from({ length: 11 }, (_, index) => index), 240]));
  bytes.push(...segment(218, [1, 1, 0, 0, 63, 0]));
  let bits = "";
  let zeroes = 0;
  for (const [index, coefficient] of coefficients.entries()) {
    if (index > 0 && coefficient === 0) { zeroes++; continue; }
    while (zeroes >= 16) { bits += "1011"; zeroes -= 16; }
    // Emit individual zero AC values as ZRL only; these cases have dense
    // prefixes and trailing zeroes, so no nonzero run nibble is needed.
    if (zeroes !== 0) throw new Error("fixture requires a dense coefficient prefix");
    const size = coefficient === 0 ? 0 : Math.floor(Math.log2(Math.abs(coefficient))) + 1;
    bits += size.toString(2).padStart(4, "0");
    if (size > 0) bits += (coefficient < 0 ? coefficient - 1 + 2 ** size : coefficient).toString(2).padStart(size, "0");
  }
  if (zeroes > 0) bits += "0000";
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "1");
  for (let index = 0; index < bits.length; index += 8) {
    const byte = Number.parseInt(bits.slice(index, index + 8), 2);
    bytes.push(byte);
    if (byte === 255) bytes.push(0);
  }
  return new Uint8Array([...bytes, 255, 217]);
}

const progressiveSymbols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 240, 16, 32, 48, 17, 33, 49];

function progressiveAc(symbol: number): string {
  const index = progressiveSymbols.indexOf(symbol);
  if (index < 0) throw new Error("missing fixture AC symbol");
  return index.toString(2).padStart(5, "0");
}

function progressiveDc(value: number): string {
  const size = value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value))) + 1;
  return size.toString(2).padStart(4, "0")
    + (size === 0 ? "" : (value < 0 ? value - 1 + 2 ** size : value).toString(2).padStart(size, "0"));
}

interface ProgressiveFixtureScan {
  readonly ids: readonly number[];
  readonly start: number;
  readonly end: number;
  readonly high: number;
  readonly low: number;
  readonly chunks: readonly string[];
}

function progressiveFixture(scans: readonly ProgressiveFixtureScan[], width = 8, height = 8, sampling: readonly number[] = [17], restart = 0): Uint8Array {
  const bytes = [255, 216, ...segment(219, [0, ...new Array<number>(64).fill(1)]),
    ...segment(194, [8, height >> 8, height & 255, width >> 8, width & 255, sampling.length,
      ...sampling.flatMap((value, index) => [index + 1, value, 0])]),
    ...segment(196, [0, 0, 0, 0, 12, ...new Array<number>(12).fill(0), ...Array.from({ length: 12 }, (_, index) => index),
      16, 0, 0, 0, 0, progressiveSymbols.length, ...new Array<number>(11).fill(0), ...progressiveSymbols])];
  if (restart > 0) bytes.push(...segment(221, [restart >> 8, restart & 255]));
  for (const scan of scans) {
    bytes.push(...segment(218, [scan.ids.length, ...scan.ids.flatMap(id => [id, 0]), scan.start, scan.end, scan.high * 16 + scan.low]));
    for (const [chunkIndex, chunk] of scan.chunks.entries()) {
      if (chunkIndex > 0) bytes.push(255, 208 + (chunkIndex - 1) % 8);
      const padded = chunk.padEnd(Math.ceil(chunk.length / 8) * 8, "1");
      for (let index = 0; index < padded.length; index += 8) {
        const value = Number.parseInt(padded.slice(index, index + 8), 2);
        bytes.push(value);
        if (value === 255) bytes.push(0);
      }
    }
  }
  return new Uint8Array([...bytes, 255, 217]);
}

function markerOffset(bytes: Uint8Array, marker: number): number {
  for (let index = 0; index + 1 < bytes.length; index++) {
    if (bytes[index] === 255 && bytes[index + 1] === marker) return index;
  }
  throw new Error(`fixture lacks marker ${marker}`);
}

function compareReference(image: JpegImage, bytes: Uint8Array): void {
  const sourceReference = process.env["Q3_JPEG_REFERENCE"];
  const reference = Bun.spawnSync(sourceReference === undefined ? ["djpeg", "-dct", "float", "-rgb"] : [sourceReference], {
    stdin: bytes, env: { ...process.env, JSIMD_FORCENONE: "1" },
  });
  expect(reference.exitCode).toBe(0);
  const header = new TextDecoder().decode(reference.stdout.subarray(0, 64)).match(/^P6\n(\d+) (\d+)\n255\n/);
  if (header === null) throw new Error("unexpected djpeg reference format");
  expect(Number(header[1])).toBe(image.width);
  expect(Number(header[2])).toBe(image.height);
  const rgb = reference.stdout.subarray(header[0].length);
  const actualRgb = new Uint8Array(image.width * image.height * 3);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) actualRgb.set(image.pixels.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  if (sourceReference !== undefined) expect(actualRgb).toEqual(new Uint8Array(rgb));
  else {
    // Modern IJG float rounds after adding the level shift; the pinned source
    // truncates to INT32 first. One sample of difference can become three RGB
    // levels after color conversion. This is supporting evidence only.
    expect(actualRgb.length).toBe(rgb.length);
    let maximumError = 0;
    for (const [index, actual] of actualRgb.entries()) {
      const expected = rgb[index];
      if (expected === undefined) throw new Error("truncated reference pixels");
      maximumError = Math.max(maximumError, Math.abs(actual - expected));
    }
    expect(maximumError).toBeLessThanOrEqual(3);
  }
}

describe("JPEG sequential Huffman decoder", () => {
  test("source fatal ordering reads intervening markers and SOS before decoder setup", () => {
    const bytes = gray();
    bytes[markerOffset(bytes, 192) + 4] = 12;
    const sos = markerOffset(bytes, 218);
    const jfif = segment(224, [74, 70, 73, 70, 0, 2, 3, 0, 0, 1, 0, 1, 0, 0]);
    const warnings: string[] = [];
    const withWarning = new Uint8Array([...bytes.subarray(0, sos), ...jfif, ...bytes.subarray(sos)]);
    expect(() => decodeJpegWithWarnings(withWarning, "setup-order.jpg", text => { warnings.push(text); })).toThrow("Unsupported JPEG data precision 12");
    expect(warnings).toEqual(["Warning: unknown JFIF revision number 2.03\n"]);
    expect(() => decodeJpeg(new Uint8Array([...bytes.subarray(0, sos), 255, 217]))).toThrow("missing SOS marker");
    const badScan = withAdobe(fixture({ width: 1, height: 1, sampling: [17, 17, 17], blocks: [], restart: 0 }), 7);
    badScan[markerOffset(badScan, 218) + 5] = 99;
    warnings.length = 0;
    expect(() => decodeJpegWithWarnings(badScan, "sos-order.jpg", text => { warnings.push(text); })).toThrow("Invalid component ID 99 in SOS");
    expect(warnings).toEqual([]);
  });

  test("source fatal diagnostics carry exact IJG messages without converting safety boundaries", () => {
    const original = gray();
    const sof = markerOffset(original, 192), sos = markerOffset(original, 218);
    const changed = (offset: number, value: number): Uint8Array => {
      const bytes = original.slice(); bytes[offset] = value; return bytes;
    };
    const cases: readonly [Uint8Array, string][] = [
      [new Uint8Array([0, 171]), "Not a JPEG file: starts with 0x00 0xab"],
      [new Uint8Array([255, 216, 255, 217]), "JPEG datastream contains no image"],
      [new Uint8Array([255, 216, 255, 216]), "Invalid JPEG file structure: two SOI markers"],
      [new Uint8Array([255, 216, 255, 218]), "Invalid JPEG file structure: SOS before SOF"],
      [new Uint8Array([255, 216, 255, 195]), "Unsupported JPEG process: SOF type 0xc3"],
      [new Uint8Array([255, 216, 255, 2]), "Unsupported marker type 0x02"],
      [new Uint8Array([...original.subarray(0, sos), 255, 217]), "Invalid JPEG file structure: missing SOS marker"],
      [new Uint8Array([...original.subarray(0, sos), ...original.subarray(sof)]), "Invalid JPEG file structure: two SOF markers"],
      [new Uint8Array([...original.subarray(0, original.length - 2), ...original.subarray(sos)]), "Didn't expect more than one scan"],
      [changed(sof + 8, 0), "Empty JPEG image (DNL not supported)"],
      [changed(sof + 9, 2), "Bogus marker length"],
      [changed(sof + 4, 12), "Unsupported JPEG data precision 12"],
      [changed(sof + 11, 0), "Bogus sampling factors"],
      [changed(sof + 12, 3), "Quantization table 0x03 was not defined"],
      [changed(sos + 5, 99), "Invalid component ID 99 in SOS"],
      [changed(sos + 6, 32), "Huffman table 0x02 was not defined"],
      [changed(sos + 6, 3), "Huffman table 0x03 was not defined"],
      [changed(sos + 4, 0), "Bogus marker length"],
      [changed(sof + 1, 201), "Sorry, there are legal restrictions on arithmetic coding"],
      [new Uint8Array([255, 216, ...segment(221, [0])]), "Bogus marker length"],
      [new Uint8Array([255, 216, ...segment(219, [4])]), "Bogus DQT index 4"],
      [new Uint8Array([255, 216, ...segment(204, [32, 0])]), "Bogus DAC index 32"],
      [new Uint8Array([255, 216, ...segment(204, [0, 15])]), "Bogus DAC value 0xf"],
      [new Uint8Array([255, 216, ...segment(196, [0, 2, ...new Array<number>(15).fill(0)])]), "Bogus DHT counts"],
      [new Uint8Array([255, 216, ...segment(196, [20, ...new Array<number>(16).fill(0)])]), "Bogus DHT index 4"],
      [new Uint8Array([255, 216, ...segment(192, [8, 0, 1, 0, 1, 11,
        ...Array.from({ length: 11 }, (_, index) => [index + 1, 17, 0]).flat()]),
        ...segment(218, [1, 1, 0, 0, 63, 0])]), "Too many color components: 11, max 10"],
    ];
    for (const [bytes, message] of cases) {
      let failure: unknown;
      try { decodeJpeg(bytes, "fatal-fixture.jpg"); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(JpegSourceError);
      if (!(failure instanceof JpegSourceError)) throw new Error("missing source fatal");
      expect(failure.sourceMessage).toBe(message);
      expect(failure.source).toBe("fatal-fixture.jpg");
      expect(failure).toBeInstanceOf(BinaryError);
    }
    for (const bytes of [new Uint8Array(), new Uint8Array([255]), new Uint8Array([255, 216, 255, 219, 0, 69])]) {
      let failure: unknown;
      try { decodeJpeg(bytes); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(BinaryError);
      expect(failure).not.toBeInstanceOf(JpegSourceError);
    }
  });

  test("source recovery skips marker junk and emits only the first warning", () => {
    const bytes = gray([{ dc: 80, ac: false }]);
    const warnings: string[] = [];
    const corrupt = new Uint8Array([255, 216, 7, 255, 0, 9, 255, 255,
      ...bytes.subarray(2, bytes.length - 2), 3, 4, 255, 217]);
    expect(decodeJpegWithWarnings(corrupt, "junk.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(bytes));
    expect(warnings).toEqual(["Corrupt JPEG data: 4 extraneous bytes before marker 0xdb\n"]);
    const failure = new Error("renderer print aborted");
    expect(() => decodeJpegWithWarnings(corrupt, "junk.jpg", () => { throw failure; })).toThrow(failure);
  });

  test("source recovery supplies zero entropy at EOI and substitutes bad Huffman symbols", () => {
    const bytes = fixture({ width: 1, height: 1, sampling: [17, 17, 17],
      blocks: [{ dc: 80, ac: false }, { dc: -80, ac: false }, { dc: 0, ac: false }], restart: 0 });
    const sos = markerOffset(bytes, 218);
    const warnings: string[] = [];
    const empty = new Uint8Array([...bytes.subarray(0, sos + 14), 255, 217]);
    expect([...decodeJpegWithWarnings(empty, "empty.jpg", text => { warnings.push(text); }).pixels]).toEqual([128, 128, 128, 255]);
    expect(warnings).toEqual(["Corrupt JPEG data: premature end of data segment\n"]);
    const grayBytes = gray();
    const invalid = new Uint8Array([...grayBytes.subarray(0, markerOffset(grayBytes, 218) + 10),
      255, 0, 255, 0, 159, 255, 217]); // Seventeen invalid one bits, then AC EOB 00.
    warnings.length = 0;
    expect(decodeJpegWithWarnings(invalid, "huffman.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(grayBytes));
    expect(warnings).toEqual(["Corrupt JPEG data: bad Huffman code\n"]);
  });

  test("source recovery warns for sequential SOS parameters and decodes full blocks", () => {
    const bytes = gray([{ dc: 80, ac: false }]);
    const expected = decodeJpeg(bytes);
    const sos = markerOffset(bytes, 218);
    bytes[sos + 7] = 5;
    bytes[sos + 8] = 9;
    bytes[sos + 9] = 162;
    const warnings: string[] = [];
    expect(decodeJpegWithWarnings(bytes, "sequential.jpg", text => { warnings.push(text); })).toEqual(expected);
    expect(warnings).toEqual(["Invalid SOS parameters for sequential JPEG\n"]);
    warnings.length = 0;
    bytes[sos + 6] = 240;
    expect(() => decodeJpegWithWarnings(bytes, "scan-table.jpg", text => { warnings.push(text); })).toThrow("Huffman table 0x0f was not defined");
    expect(warnings).toEqual(["Invalid SOS parameters for sequential JPEG\n"]);
  });

  test("source recovery reports JFIF and Adobe warnings with source precedence", () => {
    const bytes = fixture({ width: 1, height: 1, sampling: [17, 17, 17], blocks: new Array<Block>(3).fill({ dc: 0, ac: false }), restart: 0 });
    const warnings: string[] = [];
    expect(decodeJpegWithWarnings(withAdobe(bytes, 7), "adobe.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(bytes));
    expect(warnings).toEqual(["Unknown Adobe color transform code 7\n"]);
    warnings.length = 0;
    const jfif = segment(224, [74, 70, 73, 70, 0, 2, 3, 0, 0, 1, 0, 1, 0, 0]);
    const both = new Uint8Array([255, 216, ...jfif, ...withAdobe(bytes, 7).subarray(2)]);
    expect(decodeJpegWithWarnings(both, "jfif.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(bytes));
    expect(warnings).toEqual(["Warning: unknown JFIF revision number 2.03\n"]);
    warnings.length = 0;
    const four = fixture({ width: 1, height: 1, sampling: [17, 17, 17, 17], blocks: new Array<Block>(4).fill({ dc: 0, ac: false }), restart: 0 });
    expect(decodeJpegWithWarnings(withAdobe(four, 1), "four-adobe.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(withAdobe(four, 2)));
    expect(warnings).toEqual(["Unknown Adobe color transform code 1\n"]);
  });

  test("source recovery preserves signed DC storage and natural-order sentinel coefficients", () => {
    const overflow = gray([{ dc: 2047, ac: false }, { dc: 2047, ac: false }], 16);
    expect([...decodeJpeg(overflow).pixels.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...decodeJpeg(overflow).pixels.slice(32, 36)]).toEqual([0, 0, 0, 255]);
    const extendedHeader = overflow.subarray(0, markerOffset(overflow, 218) + 10).slice();
    extendedHeader[markerOffset(extendedHeader, 196) + 32] = 15;
    const bits = ("1011" + "1".repeat(15) + "00").repeat(2).padEnd(48, "1");
    const entropy: number[] = [];
    for (let index = 0; index < bits.length; index += 8) {
      const byte = Number.parseInt(bits.slice(index, index + 8), 2);
      entropy.push(byte);
      if (byte === 255) entropy.push(0);
    }
    expect([...decodeJpeg(new Uint8Array([...extendedHeader, ...entropy, 255, 217])).pixels])
      .toEqual(Array.from({ length: 128 }, () => [128, 128, 128, 255]).flat());
    extendedHeader[markerOffset(extendedHeader, 196) + 32] = 16;
    expect(() => decodeJpeg(new Uint8Array([...extendedHeader, ...entropy, 255, 217]))).toThrow("source sign-extension table");
    const original = gray();
    const header = original.subarray(0, markerOffset(original, 218) + 10).slice();
    const symbol = markerOffset(header, 196) + 51;
    header[symbol] = 234;
    // DC zero, three ZRLs, run fourteen/category ten, amplitude 1023.
    const inRange = new Uint8Array([...header, 10, 159, 255, 0, 255, 217]);
    header[symbol] = 250;
    const recovered = new Uint8Array([...header, 10, 159, 255, 0, 255, 217]);
    const warnings: string[] = [];
    expect(decodeJpegWithWarnings(recovered, "sentinel.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(inRange));
    expect(warnings).toEqual([]);
  });

  test("source recovery resynchronizes ahead, stale, distant and nonrestart markers", () => {
    const bytes = gray(Array.from({ length: 3 }, () => ({ dc: 80, ac: false })), 24, 1);
    const restart = markerOffset(bytes, 208);
    for (const value of [
      { marker: 209, prefix: false, expected: [138, 128, 138] },
      { marker: 215, prefix: true, expected: [138, 138, 138] },
      { marker: 212, prefix: false, expected: [138, 138, 138] },
      { marker: 2, prefix: true, expected: [138, 138, 138] },
      { marker: 217, prefix: false, expected: [138, 128, 128] },
    ]) {
      const tail = value.marker === 217 ? [] : [...bytes.subarray(restart + (value.prefix ? 0 : 2))];
      const corrupt = new Uint8Array([...bytes.subarray(0, restart), 255, value.marker, ...tail]);
      const warnings: string[] = [];
      const image = decodeJpegWithWarnings(corrupt, "restart.jpg", text => { warnings.push(text); });
      expect([image.pixels[0], image.pixels[32], image.pixels[64]]).toEqual(value.expected);
      expect(warnings).toEqual([`Corrupt JPEG data: found marker 0x${value.marker.toString(16).padStart(2, "0")} instead of RST0\n`]);
    }
    const warnings: string[] = [];
    const prefetched = new Uint8Array([...bytes.subarray(0, restart), 18, ...bytes.subarray(restart)]);
    expect(decodeJpegWithWarnings(prefetched, "prefetched-junk.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(bytes));
    expect(warnings).toEqual([]);
    const extra = new Uint8Array([...bytes.subarray(0, restart), ...new Array<number>(8).fill(18), ...bytes.subarray(restart)]);
    expect(decodeJpegWithWarnings(extra, "restart-junk.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(bytes));
    expect(warnings).toEqual(["Corrupt JPEG data: 8 extraneous bytes before marker 0xd0\n"]);
  });

  test("source accepts auxiliary DAC, DNL and standalone markers around scans", () => {
    const bytes = fixture({ width: 1, height: 1, sampling: [17, 17, 17],
      blocks: [{ dc: 80, ac: false }, { dc: -80, ac: false }, { dc: 0, ac: false }], restart: 0 });
    const expected = decodeJpeg(bytes);
    const ignored = [255, 1, ...segment(204, [0, 16, 15, 255, 16, 0, 31, 255]),
      ...segment(220, [0, 99]), ...Array.from({ length: 8 }, (_, index) => [255, 208 + index]).flat()];
    const scan = markerOffset(bytes, 218);
    for (const offset of [2, scan, bytes.length - 2]) {
      expect(decodeJpeg(new Uint8Array([...bytes.subarray(0, offset), ...ignored, ...bytes.subarray(offset)]))).toEqual(expected);
    }
    const progressive = progressiveFixture([
      { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(80)] },
      { ids: [1], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(0)] },
    ]);
    const first = markerOffset(progressive, 218);
    const second = first + 2 + markerOffset(progressive.subarray(first + 2), 218);
    expect(decodeJpeg(new Uint8Array([...progressive.subarray(0, second), ...ignored, ...progressive.subarray(second)]))).toEqual(decodeJpeg(progressive));
  });

  test("source validates unused DAC tables and retains SOF dimensions across DNL", () => {
    const bytes = gray();
    for (const [payload, message] of [
      [[32, 0], "Bogus DAC index 32"],
      [[0, 15], "Bogus DAC value 0xf"],
      [[0], "Quantization table 0x00 was not defined"],
    ] satisfies [number[], string][]) {
      expect(() => decodeJpeg(new Uint8Array([255, 216, ...segment(204, payload), ...bytes.subarray(2)]))).toThrow(message);
    }
    for (const offset of [5, 7]) {
      const frame = markerOffset(bytes, 192);
      const excessive = bytes.slice();
      excessive[frame + offset] = 255;
      excessive[frame + offset + 1] = 221; // JPEG_MAX_DIMENSION is 65500.
      expect(() => decodeJpeg(excessive)).toThrow("Maximum supported image dimension is 65500 pixels");
    }
    const empty = bytes.slice();
    empty[markerOffset(empty, 192) + 6] = 0;
    expect(() => decodeJpeg(new Uint8Array([255, 216, ...segment(220, [0, 8]), ...empty.subarray(2)]))).toThrow("Empty JPEG image");
    expect(() => decodeJpeg(new Uint8Array([255, 216, ...segment(204, [0, 16]), 255, 217]))).toThrow("JPEG datastream contains no image");
  });

  test("source entropy reader accepts repeated FF fill before stuffed zero", () => {
    const bytes = gray([{ dc: 0, ac: false }, { dc: 2047, ac: false }], 16);
    const stuffed = markerOffset(bytes, 0);
    const expected = decodeJpeg(bytes);
    const filled = new Uint8Array([...bytes.subarray(0, stuffed), 255, 255, ...bytes.subarray(stuffed)]);
    expect(decodeJpeg(filled)).toEqual(expected);
    filled[stuffed + 3] = 217;
    expect([...decodeJpeg(filled).pixels.slice(32, 36)]).toEqual([96, 96, 96, 255]);
  });

  test("source discards unused JPEG padding bits at scan and restart boundaries", () => {
    for (const restart of [false, true]) {
      const bytes = fixture({ width: restart ? 16 : 8, height: 8, sampling: [17, 17, 17],
        blocks: Array.from({ length: restart ? 6 : 3 }, () => ({ dc: 0, ac: false })), restart: restart ? 3 : 0 });
      if (restart) bytes[markerOffset(bytes, 221) + 5] = 1; // One three-block MCU per restart.
      const expected = decodeJpeg(bytes);
      expect(Array.from(expected.pixels.slice(0, 4))).toEqual([128, 128, 128, 255]);
      expect(bytes[bytes.length - 3]).toBe(63);
      bytes[bytes.length - 3] = 0;
      if (restart) {
        const padding = markerOffset(bytes, 208) - 1;
        expect(bytes[padding]).toBe(63);
        bytes[padding] = 0;
      }
      expect(decodeJpeg(bytes)).toEqual(expected);
    }
  });
  test("pinned floating IDCT coefficient fixtures", () => {
    // Captured from unchanged jpeg-6/jidctflt.c and jddctmgr.c at source
    // dbe4ddb10315479fc00086f08e25d968b4b43c49, GCC float evaluation with
    // -ffp-contract=off -fexcess-precision=standard. Grayscale samples are
    // replicated into RGB by the reference adapter, after source decoding.
    const cases = [
      {
        coefficients: Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? 1 : -1) * (index * 13 % 31 + 1)),
        quantizers: Array.from({ length: 64 }, (_, index) => index * 17 % 31 + 1),
        expected: [84, 0, 0, 255, 255, 0, 124, 0, 210, 23, 89, 255, 255, 0, 248, 86,
          42, 255, 37, 0, 255, 0, 0, 186, 255, 139, 0, 0, 255, 0, 0, 255,
          0, 0, 199, 0, 0, 2, 122, 255, 255, 0, 255, 227, 0, 255, 182, 175,
          255, 255, 0, 0, 67, 255, 255, 141, 0, 255, 239, 0, 255, 183, 128, 255],
      },
      {
        coefficients: [0, 1, ...new Array<number>(62).fill(0)], quantizers: new Array<number>(64).fill(80),
        expected: Array.from({ length: 8 }, () => [142, 140, 136, 131, 125, 120, 116, 114]).flat(),
      },
      {
        coefficients: [1023, ...new Array<number>(63).fill(0)], quantizers: new Array<number>(64).fill(255),
        expected: new Array<number>(64).fill(0),
      },
    ];
    for (const value of cases) {
      const bytes = coefficientFixture(value.coefficients, value.quantizers);
      const image = decodeJpeg(bytes);
      expect([...image.pixels]).toEqual(value.expected.flatMap(sample => [sample, sample, sample, 255]));
      if (process.env["Q3_JPEG_REFERENCE"] !== undefined) compareReference(image, bytes);
    }
  });

  test("grayscale DC, level shift, alpha and subarray offsets", () => {
    const bytes = gray([{ dc: 80, ac: false }]);
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    const image = decodeJpeg(padded.subarray(5, 5 + bytes.length));
    expect([image.width, image.height]).toEqual([8, 8]);
    expect([...image.pixels]).toEqual(Array.from({ length: 64 }, () => [138, 138, 138, 255]).flat());
  });

  test("signed DC prediction across blocks", () => {
    const image = decodeJpeg(gray([{ dc: 80, ac: false }, { dc: -160, ac: false }], 16));
    expect([...image.pixels.slice(0, 4)]).toEqual([138, 138, 138, 255]);
    expect([...image.pixels.slice(32, 36)]).toEqual([118, 118, 118, 255]);
  });

  test("AC coefficient follows source INT32 truncation before the IDCT descale", () => {
    const bytes = gray([{ dc: 0, ac: true }]);
    const dqt = markerOffset(bytes, 219);
    bytes[dqt + 6] = 80;
    const image = decodeJpeg(bytes);
    const expected = Array.from({ length: 8 }, (_, x) => 128 + Math.floor((Math.trunc(80 * Math.SQRT2 * Math.cos((2 * x + 1) * Math.PI / 16)) + 4) / 8));
    for (let y = 0; y < 8; y++) {
      expect(Array.from({ length: 8 }, (_, x) => image.pixels[(y * 8 + x) * 4])).toEqual(expected);
    }
  });

  test.each([17, 33, 34])("YCbCr conversion and sampling 0x%s", sampling => {
    const luminanceBlocks = (sampling >> 4) * (sampling & 15);
    const blocks: Block[] = Array.from({ length: luminanceBlocks }, (_, index) => ({ dc: index === 0 ? -416 : 0, ac: false }));
    blocks.push({ dc: -344, ac: false }, { dc: 1016, ac: false });
    const image = decodeJpeg(fixture({ width: 7, height: 5, sampling: [sampling, 17, 17], blocks, restart: 0 }));
    expect([image.width, image.height]).toEqual([7, 5]);
    expect([...image.pixels]).toEqual(Array.from({ length: 35 }, () => [254, 0, 0, 255]).flat());
  });

  test("restart markers reset DC predictors and wrap sequence", () => {
    const bytes = gray(Array.from({ length: 10 }, () => ({ dc: 80, ac: false })), 80, 1);
    const image = decodeJpeg(bytes);
    expect([...image.pixels]).toEqual(Array.from({ length: 640 }, () => [138, 138, 138, 255]).flat());
    const restart = markerOffset(bytes, 208);
    bytes[restart + 1] = 209;
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 640 }, (_, pixel) => {
      const value = Math.floor((pixel % 80) / 8) === 1 ? 128 : 138;
      return [value, value, value, 255];
    }).flat());
  });

  test("stuffed FF entropy bytes are decoded and early EOI supplies missing bits", () => {
    const bytes = gray([{ dc: 0, ac: false }, { dc: 2047, ac: false }], 16);
    const stuffed = markerOffset(bytes, 0);
    expect([...decodeJpeg(bytes).pixels.slice(32, 36)]).toEqual([255, 255, 255, 255]);
    bytes[stuffed + 1] = 217;
    // The truncated DC category becomes eight; its zero amplitude is -255.
    expect([...decodeJpeg(bytes).pixels.slice(32, 36)]).toEqual([96, 96, 96, 255]);
  });

  test("separate sequential scans and intervening table redefinitions", () => {
    const header = fixture({ width: 8, height: 8, sampling: [17, 17, 17], blocks: [], restart: 0 });
    const bytes = [...header.subarray(0, markerOffset(header, 218))];
    for (const [index, dc] of [-416, -344, 1016].entries()) {
      const component = gray([{ dc, ac: false }]);
      const scan = markerOffset(component, 218);
      const body = component.subarray(scan + 10, component.length - 2);
      bytes.push(...segment(218, [1, index + 1, 0, 0, 63, 0]), ...body);
      if (index === 0) bytes.push(...segment(219, [0, ...new Array<number>(64).fill(1)]));
    }
    bytes.push(255, 217);
    const image = decodeJpeg(new Uint8Array(bytes));
    expect([...image.pixels]).toEqual(Array.from({ length: 64 }, () => [254, 0, 0, 255]).flat());
  });

  test("Adobe RGB and component IDs preserve channels until a complete JFIF marker takes priority", () => {
    const jpeg = fixture({ width: 1, height: 1, sampling: [17, 17, 17], blocks: [{ dc: 80, ac: false }, { dc: -80, ac: false }, { dc: 0, ac: false }], restart: 0 });
    const bytes = withAdobe(jpeg, 0);
    expect([...decodeJpeg(bytes).pixels]).toEqual([138, 118, 128, 255]);
    const jfif = [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    expect([...decodeJpeg(new Uint8Array([255, 216, ...segment(224, jfif), ...bytes.subarray(2)])).pixels]).toEqual([138, 141, 120, 255]);
    expect([...decodeJpeg(new Uint8Array([255, 216, ...segment(224, jfif.slice(0, 5)), ...bytes.subarray(2)])).pixels]).toEqual([138, 118, 128, 255]);
    const named = jpeg.slice();
    for (const [index, id] of [82, 71, 66].entries()) {
      named[markerOffset(named, 192) + 10 + index * 3] = id;
      named[markerOffset(named, 218) + 5 + index * 2] = id;
    }
    expect([...decodeJpeg(named).pixels]).toEqual([138, 118, 128, 255]);
    expect([...decodeJpeg(withAdobe(named, 255)).pixels]).toEqual([138, 141, 120, 255]);
  });

  test("rejects every truncated prefix with source context", () => {
    const bytes = gray();
    for (let size = 0; size < bytes.length; size++) {
      expect(() => decodeJpeg(bytes.subarray(0, size), "truncated.jpg")).toThrow("truncated.jpg");
    }
  });

  test("rejects dimensions, component selectors, missing tables and invalid progressive scans", () => {
    const original = gray();
    const sof = markerOffset(original, 192);
    const sos = markerOffset(original, 218);
    for (const [offset, value, message] of [
      [sof + 8, 0, "Empty JPEG image"],
      [sof + 11, 0, "sampling"],
      [sof + 12, 4, "Quantization table 0x04 was not defined"],
      [sos + 5, 2, "Invalid component ID 2 in SOS"],
      [sos + 6, 17, "Huffman table 0x01 was not defined"],
      [sof + 1, 194, "progressive"],
    ] satisfies [number, number, string][]) {
      const bytes = original.slice();
      bytes[offset] = value;
      expect(() => decodeJpeg(bytes)).toThrow(message);
    }
  });

  test("source decodes a valid RGB image above sixteen megapixels without an area quota", () => {
    const width = 4097, height = 4096;
    const blocks = new Array<Block>(Math.ceil(width / 8) * Math.ceil(height / 8) * 3).fill({ dc: 0, ac: false });
    blocks[0] = { dc: 80, ac: false };
    blocks[1] = { dc: -160, ac: false };
    blocks[2] = { dc: 240, ac: false };
    const bytes = fixture({ width, height, sampling: [17, 17, 17], restart: 0, blocks });
    const warnings: string[] = [];
    const image = decodeJpegWithWarnings(bytes, "above-sixteen-megapixels.jpg", text => { warnings.push(text); });
    expect(image.width).toBe(width);
    expect(image.height).toBe(height);
    expect(image.pixels.length).toBe(67_125_248);
    // DC samples Y=138, Cb=108, Cr=158 give the source fixed-point RGB.
    for (const pixel of [0, width - 1, width, 2048 * width + 2048, width * height - 1]) {
      expect([...image.pixels.subarray(pixel * 4, pixel * 4 + 4)]).toEqual([180, 123, 103, 255]);
    }
    expect(warnings).toEqual([]);
  }, 120_000);

  test("source JPEG dimension errors precede precision and sampling before allocation", () => {
    const original = gray();
    const sof = markerOffset(original, 192);
    for (const offset of [5, 7]) {
      const bytes = original.slice();
      bytes[sof + offset] = 255;
      bytes[sof + offset + 1] = 221;
      bytes[sof + 4] = 12;
      bytes[sof + 11] = 0;
      expect(() => decodeJpeg(bytes)).toThrow("Maximum supported image dimension is 65500 pixels");
    }
    const bytes = original.slice();
    bytes[sof + 7] = 255;
    bytes[sof + 8] = 220;
    bytes[sof + 4] = 12;
    bytes[sof + 11] = 0;
    expect(() => decodeJpeg(bytes)).toThrow("Unsupported JPEG data precision 12");
    bytes[sof + 4] = 8;
    expect(() => decodeJpeg(bytes)).toThrow("Bogus sampling factors");
  });

  test("rejects oversubscribed Huffman tables but accepts zero quantizers and recovers entropy underflow", () => {
    const original = gray();
    const dht = markerOffset(original, 196);
    const dqt = markerOffset(original, 219);
    const badTable = original.slice();
    badTable[dht + 5] = 2;
    expect(() => decodeJpeg(badTable)).toThrow("Huffman");
    const zeroQuantizer = original.slice();
    zeroQuantizer[dqt + 5] = 0;
    expect(decodeJpeg(zeroQuantizer)).toEqual(decodeJpeg(original));
    const entropy = markerOffset(original, 218) + 10;
    const missingEntropy = new Uint8Array([...original.subarray(0, entropy), 255, 217]);
    expect([...decodeJpeg(missingEntropy).pixels]).toEqual(Array.from({ length: 64 }, () => [128, 128, 128, 255]).flat());
  });

  test("source recovery accepts empty and complete Huffman tables and nonzero DQT precision", () => {
    const original = gray([{ dc: 80, ac: false }]);
    const dqt = markerOffset(original, 219);
    const dht = markerOffset(original, 196);
    const sos = markerOffset(original, 218);
    const wide = new Uint8Array([...original.subarray(0, dqt), ...segment(219, [240, ...new Array<number>(64).fill(1).flatMap(value => [0, value])]), ...original.subarray(dqt + 69)]);
    expect(decodeJpeg(wide)).toEqual(decodeJpeg(original));
    const zero = original.slice();
    zero[dqt + 5] = 0;
    expect(decodeJpeg(zero)).toEqual(decodeJpeg(gray()));
    const empty = segment(196, [0, ...new Array<number>(16).fill(0), 16, 1, ...new Array<number>(15).fill(0), 0]);
    const warnings: string[] = [];
    const emptyImage = new Uint8Array([...original.subarray(0, dht), ...empty, ...original.subarray(sos, sos + 10), 0, 0, 0, 255, 217]);
    expect(decodeJpegWithWarnings(emptyImage, "empty-huffman.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(gray()));
    expect(warnings).toEqual(["Corrupt JPEG data: bad Huffman code\n"]);
    const complete = segment(196, [0, 2, ...new Array<number>(15).fill(0), 0, 0, 16, 2, ...new Array<number>(15).fill(0), 0, 0]);
    const completeImage = new Uint8Array([...original.subarray(0, dht), ...complete, ...original.subarray(sos, sos + 10), 255, 0, 255, 217]);
    warnings.length = 0;
    expect(decodeJpegWithWarnings(completeImage, "complete-huffman.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(gray()));
    expect(warnings).toEqual([]);
  });

  test("source table markers consume physical bytes beyond short declarations", () => {
    const original = gray([{ dc: 80, ac: false }]);
    for (const length of [3, 4, 66]) {
      const short = original.slice();
      short[markerOffset(short, 219) + 3] = length;
      expect(decodeJpeg(short)).toEqual(decodeJpeg(original));
    }
    const dac = new Uint8Array([255, 216, 255, 204, 0, 3, 0, 16, ...original.subarray(2)]);
    expect(decodeJpeg(dac)).toEqual(decodeJpeg(original));
    for (const marker of [196, 204, 219]) {
      for (const length of [0, 1, 2]) {
        expect(decodeJpeg(new Uint8Array([255, 216, 255, marker, 0, length, ...original.subarray(2)]))).toEqual(decodeJpeg(original));
      }
    }
    expect(() => decodeJpeg(new Uint8Array([255, 216, 255, 196, 0, 3, 0, ...new Array<number>(16).fill(0)]))).toThrow("Bogus DHT counts");
  });

  test("source non-table markers validate lengths at their reached input positions", () => {
    const sof = segment(192, [8, 0, 8, 0, 8, 1, 1, 17, 0]);
    const cases: { bytes: number[]; message: string }[] = [
      { bytes: [255, 216, 255, 221, 0, 5], message: "Bogus marker length" },
      { bytes: [255, 216, 255, 192, 0, 255, 8, 0, 8, 0, 8, 1], message: "Bogus marker length" },
      { bytes: [255, 216, 255, 192, 0, 0, 8, 0, 0, 0, 8, 1], message: "Empty JPEG image (DNL not supported)" },
      { bytes: [255, 216, ...sof, 255, 192, 0, 0, 8, 0, 8, 0, 8, 1], message: "Invalid JPEG file structure: two SOF markers" },
      { bytes: [255, 216, ...sof, 255, 218, 0, 255, 1], message: "Bogus marker length" },
      { bytes: [255, 216, ...sof, 255, 218, 0, 8, 1, 9, 0], message: "Invalid component ID 9 in SOS" },
    ];
    for (const { bytes, message } of cases) {
      try {
        decodeJpeg(new Uint8Array(bytes), "marker-order.jpg");
        throw new Error("expected source marker fatal");
      } catch (error) {
        if (!(error instanceof JpegSourceError)) throw error;
        expect(error.sourceMessage).toBe(message);
        expect(error.offset).toBe(bytes.length);
      }
    }
    for (const bytes of [
      [255, 216, 255, 221, 0, 4, 0],
      [255, 216, 255, 192, 0, 0, 8],
      [255, 216, 255, 192, 0, 11, 8, 0, 8, 0, 8, 1],
      [255, 216, ...sof, 255, 218, 0, 8, 1, 9],
    ]) {
      try {
        decodeJpeg(new Uint8Array(bytes), "physical-prefix.jpg");
        throw new Error("expected physical input boundary");
      } catch (error) {
        expect(error).toBeInstanceOf(BinaryError);
        expect(error).not.toBeInstanceOf(JpegSourceError);
        if (!(error instanceof BinaryError)) throw error;
        expect(error.offset).toBe(bytes.length);
      }
    }
  });

  test("source skipped non-table marker lengths below two consume no payload", () => {
    const original = gray([{ dc: 80, ac: false }]);
    const expected = decodeJpeg(original);
    for (const marker of [220, 254, ...Array.from({ length: 16 }, (_, index) => 224 + index)]) {
      for (const length of [0, 1, 2]) {
        const warnings: string[] = [];
        const bytes = new Uint8Array([255, 216, 255, marker, 0, length, ...original.subarray(2)]);
        expect(decodeJpegWithWarnings(bytes, "empty-marker.jpg", text => { warnings.push(text); })).toEqual(expected);
        expect(warnings).toEqual([]);
      }
    }
  });

  test("source APP prefix warnings precede exhausted declared tails and callback aborts", () => {
    const bytes = new Uint8Array([255, 216, 255, 224, 255, 255, 74, 70, 73, 70, 0, 2, 3, 0, 0, 1, 0, 1, 0, 0]);
    const warnings: string[] = [];
    expect(() => decodeJpegWithWarnings(bytes, "jfif-tail.jpg", text => { warnings.push(text); })).toThrow(BinaryError);
    expect(warnings).toEqual(["Warning: unknown JFIF revision number 2.03\n"]);
    warnings.length = 0;
    expect(() => decodeJpegWithWarnings(bytes.subarray(0, 13), "partial-jfif.jpg", text => { warnings.push(text); })).toThrow(BinaryError);
    expect(warnings).toEqual([]);
    const abort = new Error("APP warning abort");
    try {
      decodeJpegWithWarnings(bytes, "jfif-tail.jpg", () => { throw abort; });
      throw new Error("expected callback abort");
    } catch (error) { expect(error).toBe(abort); }
  });

  test("source sequential aliases retain scan-ordinal output and independent DC predictions", () => {
    const original = fixture({ width: 16, height: 8, sampling: [17, 17, 17], restart: 0,
      blocks: [80, 160, 240, 80, 160, 240].map(dc => ({ dc, ac: false })) });
    const reordered = original.slice();
    const sos = markerOffset(reordered, 218);
    reordered[sos + 5] = 3;
    reordered[sos + 9] = 1;
    expect(decodeJpeg(reordered)).toEqual(decodeJpeg(original));
    const duplicate = original.slice();
    duplicate[sos + 7] = 1;
    duplicate[sos + 9] = 1;
    expect(decodeJpeg(duplicate)).toEqual(decodeJpeg(original));
    const sof = markerOffset(duplicate, 192);
    duplicate[sof + 13] = 1;
    duplicate[sof + 16] = 1;
    expect(decodeJpeg(duplicate)).toEqual(decodeJpeg(original));
    for (const sampling of [33, 18]) {
      const tiny = fixture({ width: 1, height: 1, sampling: [sampling, sampling, sampling], restart: 0,
        blocks: [80, 0, 160, 0, 240, 0].map(dc => ({ dc, ac: false })) });
      const aliased = tiny.slice();
      const tinySof = markerOffset(aliased, 192), tinySos = markerOffset(aliased, 218);
      aliased[tinySof + 14] = 17;
      aliased[tinySof + 17] = 17;
      aliased[tinySos + 7] = 1;
      aliased[tinySos + 9] = 1;
      expect(decodeJpeg(aliased)).toEqual(decodeJpeg(tiny));
    }
  });

  test("source sequential buffered aliases retain prior AC coefficients and latched quantizers", () => {
    const original = withAdobe(fixture({ width: 8, height: 8, sampling: [17, 17, 17], restart: 0,
      blocks: [160, 0, 0].map((dc, index) => ({ dc, ac: index === 0 })) }), 0);
    const bytes = [...original.subarray(0, markerOffset(original, 218))];
    for (const [id, dc, ac] of [[1, 80, true], [1, 160, false], [2, 0, false], [3, 0, false]] satisfies [number, number, boolean][]) {
      const single = gray([{ dc, ac }]);
      bytes.push(...segment(218, [1, id, 0, 0, 63, 0]), ...single.subarray(markerOffset(single, 218) + 10, single.length - 2));
      if (id === 1 && dc === 80) bytes.push(...segment(219, [0, ...new Array<number>(64).fill(2)]));
    }
    expect(decodeJpeg(new Uint8Array([...bytes, 255, 217]))).toEqual(decodeJpeg(original));
  });

  test("source one-pass aliases preserve physical row overlap before simple upsampling", () => {
    const blocks = [80, 0, 160, 0, 240, 0, 320, 0, 80, 0, 160, 0, 240, 0, 320, 0].map(dc => ({ dc, ac: false }));
    const bytes = fixture({ width: 17, height: 2, sampling: [33, 33, 33, 33], restart: 0, blocks });
    const sof = markerOffset(bytes, 192), sos = markerOffset(bytes, 218);
    for (let member = 1; member < 4; member++) {
      bytes[sof + 11 + member * 3] = 18;
      bytes[sos + 5 + member * 2] = 1;
    }
    const expected = Array.from({ length: 34 }, (_, pixel) => {
      const x = pixel % 17, row = Math.floor(pixel / 17);
      const green = row === 0 ? 148 : x < 15 ? 168 : x === 15 ? 163 : 153;
      const blue = row === 0 ? 158 : x < 15 ? 188 : x === 15 ? 181 : 165;
      return [x < 16 ? 138 : 148, green, blue, 255];
    }).flat();
    expect([...decodeJpeg(bytes).pixels]).toEqual(expected);
  });

  test("source one-pass aliases retain context rows through pointer swaps and final cropping", () => {
    const expected = Array.from({ length: 17 * 17 }, (_, pixel) => {
      const x = pixel % 17, row = Math.floor(pixel / 17);
      const left = row === 0 ? 40 : row <= 8 ? 80 : row < 16 ? 100 : 120;
      const right = row < 8 ? 50 : row < 16 ? 70 : 130;
      const cb = x < 15 ? left : x === 15 ? (3 * left + right + 2) >> 2 : (3 * right + left + 1) >> 2;
      return [128, 128 + Math.floor((-22554 * (cb - 128) + 32768) / 65536),
        Math.max(0, Math.min(255, 128 + Math.floor((116130 * (cb - 128) + 32768) / 65536))), 255];
    }).flat();
    expect([...decodeJpeg(contextAliasFixture()).pixels]).toEqual(expected);
    // A full second strip writes through list1's physical last row and
    // beyond the sample allocation; the short final strip above does not.
    const warnings: string[] = [];
    expect(() => decodeJpegWithWarnings(contextAliasFixture(33), "full-strip.jpg", text => { warnings.push(text); })).toThrow("source sample allocation");
    expect(warnings).toEqual([]);
  });

  test("source context component lists share their physical pointer allocation", () => {
    const original = fixture({ width: 17, height: 1, sampling: [34, 17, 17, 17], restart: 0,
      blocks: [0, 0, 0, 0, 0, 0, 80, 0, 0, 0, 0, 0, 0, 80].map(dc => ({ dc, ac: false })) });
    const sof = markerOffset(original, 192);
    const bytes = new Uint8Array([...original.subarray(0, sof),
      ...segment(192, [8, 0, 1, 0, 17, 3, 1, 34, 0, 2, 17, 0, 3, 17, 0]), ...original.subarray(sof + 22)]);
    bytes[markerOffset(bytes, 218) + 11] = 2;
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 17 }, (_, x) => {
      const value = x < 8 ? 138 : x < 16 ? 148 : 128;
      return [value, value, value, 255];
    }).flat());
    bytes[sof + 6] = 17;
    const warnings: string[] = [];
    expect(() => decodeJpegWithWarnings(bytes, "second-pointer-list.jpg", text => { warnings.push(text); })).toThrow("source xbuffer allocation");
    expect(warnings).toEqual(["Corrupt JPEG data: premature end of data segment\n"]);
    const abort = new Error("stop at entropy warning before missing output pointer");
    expect(() => decodeJpegWithWarnings(bytes, "callback-first.jpg", () => { throw abort; })).toThrow(abort);
  });

  test("source one-pass output rejects uninitialized samples including overwritten black", () => {
    const color = fixture({ width: 17, height: 1, sampling: [17, 17, 17], restart: 0,
      blocks: new Array<Block>(6).fill({ dc: 0, ac: false }) });
    color[markerOffset(color, 192) + 11] = 34;
    color[markerOffset(color, 218) + 5] = 2;
    expect(() => decodeJpeg(color)).toThrow("uninitialized source sample");
    const black = fixture({ width: 17, height: 1, sampling: [34, 17, 17, 17], restart: 0,
      blocks: new Array<Block>(14).fill({ dc: 0, ac: false }) });
    black[markerOffset(black, 192) + 20] = 34;
    black[markerOffset(black, 218) + 11] = 2;
    expect(() => decodeJpeg(black)).toThrow("uninitialized source sample");
  });

  test("source ordinary chroma edges preserve context across three iMCU rows", () => {
    const blocks: Block[] = [];
    let previous = 0;
    for (const cb of [80, 160, 200]) {
      for (let column = 0; column < 2; column++) {
        blocks.push(...new Array<Block>(4).fill({ dc: 0, ac: false }));
        const coefficient = (cb - 128) * 8;
        blocks.push({ dc: coefficient - previous, ac: false }, { dc: 0, ac: false });
        previous = coefficient;
      }
    }
    const bytes = fixture({ width: 17, height: 33, sampling: [34, 17, 17], restart: 0, blocks });
    const expected = Array.from({ length: 17 * 33 }, (_, pixel) => {
      const row = Math.floor(pixel / 17);
      const cb = row < 15 ? 80 : row === 15 ? 100 : row === 16 ? 140 : row < 31 ? 160 : row === 31 ? 170 : 190;
      return [128, 128 + Math.floor((-22554 * (cb - 128) + 32768) / 65536),
        Math.max(0, Math.min(255, 128 + Math.floor((116130 * (cb - 128) + 32768) / 65536))), 255];
    }).flat();
    expect([...decodeJpeg(bytes).pixels]).toEqual(expected);
  });

  test("source null conversion preserves the renderer byte prefix for five through ten components", () => {
    for (let count = 5; count <= 10; count++) {
      const values = Array.from({ length: count }, (_, index) => 120 + index * 2);
      for (const progressive of [false, true]) {
        const scans = values.map((value, index) => ({ ids: [index + 1], start: 0, end: progressive ? 0 : 63, high: 0, low: 0,
          chunks: [progressiveDc((value - 128) * 8) + (progressive ? "" : progressiveAc(0))] }));
        const bytes = withAdobe(progressiveFixture(scans, 3, 2, new Array<number>(count).fill(17)), 99);
        if (!progressive) bytes[markerOffset(bytes, 194) + 1] = 192;
        const expected = Array.from({ length: 6 }, () => values).flat().slice(0, 24);
        for (let alpha = 3; alpha < expected.length; alpha += 4) expected[alpha] = 255;
        const warnings: string[] = [];
        const image = decodeJpegWithWarnings(bytes, "null-conversion.jpg", text => { warnings.push(text); });
        expect(image.width).toBe(3);
        expect(image.height).toBe(2);
        expect([...image.pixels]).toEqual(expected);
        expect(warnings).toEqual([]);
      }
    }
  });

  test("source derives only requested Huffman tables and extends only selected DC symbols", () => {
    const original = gray();
    const unused = segment(196, [3, 3, ...new Array<number>(15).fill(0), 0, 16, 255]);
    expect(decodeJpeg(new Uint8Array([255, 216, ...unused, ...original.subarray(2)]))).toEqual(decodeJpeg(original));
    const unselectedSymbol = original.slice();
    unselectedSymbol[markerOffset(unselectedSymbol, 196) + 21 + 11] = 255;
    expect(decodeJpeg(unselectedSymbol)).toEqual(decodeJpeg(original));
    const warnings: string[] = [];
    const selected = new Uint8Array([...original.subarray(0, markerOffset(original, 218)), ...unused,
      ...segment(218, [1, 1, 48, 1, 63, 0]), 0, 255, 217]);
    expect(() => decodeJpegWithWarnings(selected, "oversubscribed.jpg", text => { warnings.push(text); })).toThrow("oversubscribed Huffman table");
    expect(warnings).toEqual(["Invalid SOS parameters for sequential JPEG\n"]);
    const missingAc = selected.slice();
    missingAc[markerOffset(missingAc, 218) + 6] = 49;
    expect(() => decodeJpeg(missingAc)).toThrow("Huffman table 0x01 was not defined");
    // The complete one-bit prefix makes this overfull ninth-bit code
    // unreachable; it never indexes the eight-bit lookahead arrays.
    const long = segment(196, [0, 2, ...new Array<number>(7).fill(0), 1, ...new Array<number>(7).fill(0), 0, 0, 255]);
    expect(decodeJpeg(new Uint8Array([...original.subarray(0, markerOffset(original, 218)), ...long,
      ...segment(218, [1, 1, 0, 0, 63, 0]), 0, 255, 217]))).toEqual(decodeJpeg(original));
  });

  test("source recovery accepts oversized zero runs and extended AC categories", () => {
    const original = gray();
    const entropy = markerOffset(original, 218) + 10;
    // DC category zero, followed by four ZRL codes, exceeds 63 AC positions.
    const badRun = new Uint8Array([...original.subarray(0, entropy), 10, 175, 255, 217]);
    expect(decodeJpeg(badRun)).toEqual(decodeJpeg(original));
    const eob = original.slice();
    eob[markerOffset(eob, 196) + 50] = 224;
    expect(decodeJpeg(eob)).toEqual(decodeJpeg(original));
    const extended = coefficientFixture([0, 1023], new Array<number>(64).fill(1));
    // Give the existing category-ten code category eleven and an explicit
    // 1024 amplitude. This is defined by the source's 16-entry extend table.
    const extendedHeader = extended.subarray(0, markerOffset(extended, 218) + 10).slice();
    extendedHeader[markerOffset(extendedHeader, 196) + 50 + 10] = 11;
    const bytes = new Uint8Array([...extendedHeader, 10, 128, 0, 255, 217]);
    const warnings: string[] = [];
    const image = decodeJpegWithWarnings(bytes, "extended-ac.jpg", text => { warnings.push(text); });
    expect([...image.pixels.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...image.pixels.slice(28, 32)]).toEqual([0, 0, 0, 255]);
    expect(warnings).toEqual([]);
  });

  test.skipIf(Bun.which("cjpeg") === null || Bun.which("djpeg") === null)("odd dimensions, chroma edges, optimized tables and interleaved restarts match IJG", () => {
    for (const width of [1, 3, 5, 17, 33]) {
      const height = 19;
      const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
      const ppm = new Uint8Array(header.length + width * height * 3);
      ppm.set(header);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = header.length + (y * width + x) * 3;
          ppm[offset] = (x * 17 + y * 3) & 255;
          ppm[offset + 1] = (x * 7 + y * 31) & 255;
          ppm[offset + 2] = (x * 47 + y * 11) & 255;
        }
      }
      for (const sampling of ["1x1,1x1,1x1", "2x1,1x1,1x1", "2x2,1x1,1x1"]) {
        const encoded = Bun.spawnSync(["cjpeg", "-quality", "83", "-optimize", "-restart", "1B", "-sample", sampling], { stdin: ppm });
        expect(encoded.exitCode).toBe(0);
        compareReference(decodeJpeg(encoded.stdout), encoded.stdout);
      }
    }
  });
});

describe("JPEG four-component pure fixtures", () => {
  test("sequential CMYK defaults and Adobe zero preserve CMY and overwrite black with alpha", () => {
    for (const [marker, black] of [[192, 0], [193, 255]] satisfies [number, number][]) {
      const bytes = fixture({ width: 1, height: 1, sampling: [17, 17, 17, 17],
        blocks: [20, 64, 192, black].map(value => ({ dc: (value - 128) * 8, ac: false })), restart: 0 });
      const frame = markerOffset(bytes, 192);
      bytes[frame + 1] = marker;
      for (const [index, id] of [89, 67, 99, 3].entries()) {
        bytes[frame + 10 + index * 3] = id;
        bytes[markerOffset(bytes, 218) + 5 + index * 2] = id;
      }
      expect([...decodeJpeg(bytes).pixels]).toEqual([20, 64, 192, 255]);
      expect([...decodeJpeg(withAdobe(bytes, 0)).pixels]).toEqual([20, 64, 192, 255]);
    }
  });

  test("YCCK uses source fixed-point inversion, clipping and nonzero Adobe fallback", () => {
    // jdcolor.c uses FIX(1.40200)=91881, FIX(1.77200)=116130,
    // FIX(0.34414)=22554 and FIX(0.71414)=46802, then inverts before clipping.
    for (const value of [
      { transform: 2, components: [128, 64, 192, 0], expected: [37, 151, 240, 255] },
      { transform: 1, components: [76, 85, 255, 19], expected: [1, 255, 255, 255] },
      { transform: 255, components: [255, 0, 255, 231], expected: [0, 47, 227, 255] },
    ]) {
      const bytes = fixture({ width: 1, height: 1, sampling: [17, 17, 17, 17],
        blocks: value.components.map(component => ({ dc: (component - 128) * 8, ac: false })), restart: 0 });
      expect([...decodeJpeg(withAdobe(bytes, value.transform)).pixels]).toEqual(value.expected);
    }
  });

  test("four-component color selection latches at first SOS and ignores short Adobe markers", () => {
    const bytes = fixture({ width: 1, height: 1, sampling: [17, 17, 17, 17],
      blocks: [128, 64, 192, 200].map(value => ({ dc: (value - 128) * 8, ac: false })), restart: 0 });
    const adobe = [65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0];
    const late = new Uint8Array([...bytes.subarray(0, bytes.length - 2), ...segment(238, [...adobe, 2]), 255, 217]);
    expect([...decodeJpeg(late).pixels]).toEqual([128, 64, 192, 255]);
    const ycck = withAdobe(bytes, 2);
    const lateZero = new Uint8Array([...ycck.subarray(0, ycck.length - 2), ...segment(238, [...adobe, 0]), 255, 217]);
    expect([...decodeJpeg(lateZero).pixels]).toEqual([37, 151, 240, 255]);
    const short = new Uint8Array([255, 216, ...segment(238, adobe), ...bytes.subarray(2)]);
    expect([...decodeJpeg(short).pixels]).toEqual([128, 64, 192, 255]);
    const jfif = segment(224, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    expect([...decodeJpeg(new Uint8Array([255, 216, ...jfif, ...ycck.subarray(2)])).pixels]).toEqual([37, 151, 240, 255]);
    expect([...decodeJpeg(new Uint8Array([255, 216, ...jfif, ...bytes.subarray(2)])).pixels]).toEqual([128, 64, 192, 255]);
  });

  test("separate four-component scans allow frame sampling totals above the interleaved MCU limit", () => {
    const sampling = [34, 34, 34, 34];
    const header = fixture({ width: 8, height: 8, sampling, blocks: [], restart: 0 });
    const bytes = [...header.subarray(0, markerOffset(header, 218))];
    const scans: ProgressiveFixtureScan[] = [];
    for (const [id, dc] of [[4, -1024], [2, -512], [1, -864], [3, 512]] satisfies [number, number][]) {
      const component = gray([{ dc, ac: false }]);
      const body = component.subarray(markerOffset(component, 218) + 10, component.length - 2);
      bytes.push(...segment(218, [1, id, 0, 0, 63, 0]), ...body);
      scans.push({ ids: [id], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(dc)] });
    }
    const expected = Array.from({ length: 64 }, () => [20, 64, 192, 255]).flat();
    expect([...decodeJpeg(new Uint8Array([...bytes, 255, 217])).pixels]).toEqual(expected);
    expect([...decodeJpeg(progressiveFixture(scans, 8, 8, sampling)).pixels]).toEqual(expected);
    expect(() => decodeJpeg(header)).toThrow("Sampling factors too large for interleaved scan");
    const interleaved = progressiveFixture([{ ids: [1, 2, 3, 4], start: 0, end: 0, high: 0, low: 0, chunks: [""] }], 8, 8, sampling);
    expect(() => decodeJpeg(interleaved)).toThrow("Sampling factors too large for interleaved scan");
  });

  test("CMYK uses source fancy and integer upsampling at odd component edges", () => {
    const blocks = [-512, 1024, -1536, 2040].flatMap((dc, mcu) => [
      ...Array.from({ length: 4 }, (_, index) => ({ dc: mcu === 0 && index === 0 ? -864 : 0, ac: false })),
      { dc, ac: false }, { dc: mcu === 0 ? 512 : 0, ac: false },
      ...Array.from({ length: 4 }, (_, index) => ({ dc: mcu === 0 && index === 0 ? -1024 : 0, ac: false })),
    ]);
    const image = decodeJpeg(fixture({ width: 17, height: 17, sampling: [34, 17, 17, 34], blocks, restart: 0 }));
    // Four M blocks contain 64, 192, 0, 255. The source h2v2 triangle
    // weights and alternating +7/+8 bias produce this cropped corner.
    for (const [x, y, magenta] of [[14, 14, 64], [15, 15, 88], [16, 15, 168], [15, 16, 72], [16, 16, 183]] satisfies [number, number, number][]) {
      const offset = (y * image.width + x) * 4;
      expect([...image.pixels.subarray(offset, offset + 4)]).toEqual([20, magenta, 192, 255]);
    }
    const scans: ProgressiveFixtureScan[] = [
      { ids: [1, 2, 3, 4], start: 0, end: 0, high: 0, low: 0, chunks: [blocks.map(block => progressiveDc(block.dc)).join("")] },
      ...[1, 2, 3, 4].map(id => ({ ids: [id], start: 1, end: 63, high: 0, low: 0,
        chunks: [id === 1 || id === 4 ? progressiveAc(48) + "001" : progressiveAc(32) + "00"] })),
    ];
    expect(decodeJpeg(progressiveFixture(scans, 17, 17, [34, 17, 17, 34]))).toEqual(image);
    const integerBlocks = [-512, 1024].flatMap((dc, mcu) => [
      ...Array.from({ length: 3 }, (_, index) => ({ dc: mcu === 0 && index === 0 ? -864 : 0, ac: false })),
      { dc, ac: false }, { dc: mcu === 0 ? 512 : 0, ac: false },
      ...Array.from({ length: 3 }, (_, index) => ({ dc: mcu === 0 && index === 0 ? -1024 : 0, ac: false })),
    ]);
    const integer = decodeJpeg(fixture({ width: 25, height: 1, sampling: [49, 17, 17, 49], blocks: integerBlocks, restart: 0 }));
    expect([...integer.pixels]).toEqual([...Array.from({ length: 24 }, () => [20, 64, 192, 255]).flat(), 20, 192, 192, 255]);
  });

  test("four-component progressive DC refinement and separate AC scans preserve restart state", () => {
    const scans: ProgressiveFixtureScan[] = [
      { ids: [1, 2, 3, 4], start: 0, end: 0, high: 0, low: 1,
        chunks: [-512, 508, 0].map(black => progressiveDc(-208) + progressiveDc(-172) + progressiveDc(508) + progressiveDc(black)) },
      { ids: [1, 2, 3, 4], start: 0, end: 0, high: 1, low: 0, chunks: ["0001", "1110", "0101"] },
      ...[1, 2, 3, 4].map(id => ({ ids: [id], start: 1, end: 63, high: 0, low: 0,
        chunks: [id === 4 ? progressiveAc(1) + "1" + progressiveAc(0) : progressiveAc(0), progressiveAc(0), progressiveAc(0)] })),
    ];
    const bytes = progressiveFixture(scans, 17, 8, [17, 17, 17, 17], 1);
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 136 }, () => [76, 85, 255, 255]).flat());
    expect([...decodeJpeg(withAdobe(bytes, 2)).pixels]).toEqual(Array.from({ length: 136 }, () => [1, 255, 255, 255]).flat());
    bytes[markerOffset(bytes, 208) + 1] = 209;
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 136 }, (_, pixel) =>
      Math.floor((pixel % 17) / 8) === 1 ? [128, 128, 128, 255] : [76, 85, 255, 255]).flat());
  });

  test("fourth-component entropy recovers while missing tables and fractional sampling fail", () => {
    const options = { width: 1, height: 1, sampling: [17, 17, 17, 17],
      blocks: [20, 64, 192, 255].map(value => ({ dc: (value - 128) * 8, ac: false })), restart: 0 };
    const bytes = withAdobe(fixture(options), 2);
    for (let size = 0; size < bytes.length; size++) {
      expect(() => decodeJpeg(bytes.subarray(0, size), "four-component-truncated.jpg")).toThrow("four-component-truncated.jpg");
    }
    expect([...decodeJpeg(fixture({ ...options, blocks: options.blocks.slice(0, 3) })).pixels]).toEqual([20, 64, 192, 255]);
    const missingTable = bytes.slice();
    missingTable[markerOffset(missingTable, 192) + 21] = 3;
    expect(() => decodeJpeg(missingTable)).toThrow("Quantization table 0x03 was not defined");
    const incomplete = progressiveFixture([{ ids: [1, 2, 3], start: 0, end: 0, high: 0, low: 0,
      chunks: [progressiveDc(0).repeat(3)] }], 1, 1, options.sampling);
    expect([...decodeJpeg(incomplete).pixels]).toEqual([128, 128, 128, 255]);
    expect(() => decodeJpeg(fixture({ ...options, sampling: [49, 17, 17, 33], blocks: [] }))).toThrow("Fractional sampling");
  });
});

describe("JPEG progressive pure fixtures", () => {
  test("source progressive duplicate scan members share blocks but keep independent DC predictors", () => {
    const bytes = progressiveFixture([{ ids: [1, 1], start: 0, end: 0, high: 0, low: 0,
      chunks: [progressiveDc(80) + progressiveDc(160) + progressiveDc(80) + progressiveDc(0)] },
      { ids: [1], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(16) + "0"] }], 16);
    // get_sos stores selectors in the shared component descriptor, so the
    // second member's selector replaces the first before table validation.
    bytes[markerOffset(bytes, 218) + 6] = 16;
    const expected = gray([{ dc: 160, ac: false }, { dc: 0, ac: false }], 16);
    expect(decodeJpeg(bytes)).toEqual(decodeJpeg(expected));
    const duplicateIds = progressiveFixture([{ ids: [1, 1, 3], start: 0, end: 0, high: 0, low: 0,
      chunks: [progressiveDc(80) + progressiveDc(160) + progressiveDc(0)] }], 8, 8, [17, 17, 17]);
    duplicateIds[markerOffset(duplicateIds, 194) + 13] = 1;
    expect([...decodeJpeg(duplicateIds).pixels]).toEqual(Array.from({ length: 64 }, () => [148, 148, 148, 255]).flat());
  });

  test("source progressive recovery warns for scan history and retains untransmitted zero coefficients", () => {
    const dc: ProgressiveFixtureScan = { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(80)] };
    const ac: ProgressiveFixtureScan = { ids: [1], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(0)] };
    const warnings: string[] = [];
    const decode = (scans: readonly ProgressiveFixtureScan[]): JpegImage =>
      decodeJpegWithWarnings(progressiveFixture(scans), "progression.jpg", text => { warnings.push(text); });
    expect(decode([ac, dc])).toEqual(decodeJpeg(gray([{ dc: 80, ac: false }])));
    expect(warnings).toEqual(["Inconsistent progression sequence for component 0 coefficient 0\n"]);
    warnings.length = 0;
    expect(decode([dc, dc, ac])).toEqual(decodeJpeg(gray([{ dc: 80, ac: false }])));
    expect(warnings).toEqual([]);
    expect(decode([{ ...dc, low: 1 }, dc, ac])).toEqual(decodeJpeg(gray([{ dc: 80, ac: false }])));
    expect(warnings).toEqual(["Inconsistent progression sequence for component 0 coefficient 0\n"]);
    warnings.length = 0;
    expect(decode([ac])).toEqual(decodeJpeg(gray()));
    expect(warnings).toEqual(["Inconsistent progression sequence for component 0 coefficient 0\n"]);
    const failure = new Error("progression warning retired its owner");
    expect(() => decodeJpegWithWarnings(progressiveFixture([ac]), "aborted-progression.jpg", () => { throw failure; })).toThrow(failure);
    const partial = progressiveFixture([dc], 8, 8, [17, 17, 17]);
    expect([...decodeJpeg(partial).pixels]).toEqual(Array.from({ length: 64 }, () => [138, 138, 138, 255]).flat());
  });

  test("source progressive recovery keeps EOB runs through the image and resets them at restarts", () => {
    const dc: ProgressiveFixtureScan = { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(0)] };
    const ac: ProgressiveFixtureScan = { ids: [1], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(48) + "111"] };
    expect(decodeJpeg(progressiveFixture([dc, ac]))).toEqual(decodeJpeg(gray()));
    const bytes = progressiveFixture([{ ...dc, chunks: [progressiveDc(80), progressiveDc(80)] },
      { ...ac, chunks: [progressiveAc(48) + "111", progressiveAc(0)] }], 16, 8, [17], 1);
    expect(decodeJpeg(bytes)).toEqual(decodeJpeg(gray([{ dc: 80, ac: false }, { dc: 80, ac: false }], 16, 1)));
  });

  test("source progressive recovery preserves out-of-band AC writes and warning-only refinement sizes", () => {
    const amplified = (bytes: Uint8Array): Uint8Array => {
      const dqt = markerOffset(bytes, 219);
      bytes.fill(64, dqt + 6, dqt + 69);
      return bytes;
    };
    const decoded = (scans: readonly ProgressiveFixtureScan[]): JpegImage => decodeJpeg(amplified(progressiveFixture(scans)));
    const dc: ProgressiveFixtureScan = { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(0)] };
    const ac: ProgressiveFixtureScan = { ids: [1], start: 1, end: 1, high: 0, low: 1, chunks: [progressiveAc(0)] };
    const refined: ProgressiveFixtureScan = { ...ac, high: 1, low: 0, chunks: [progressiveAc(2) + "1"] };
    const warnings: string[] = [];
    expect(decodeJpegWithWarnings(amplified(progressiveFixture([dc, ac, refined])), "refinement.jpg", text => { warnings.push(text); }))
      .toEqual(decoded([dc, ac, { ...refined, chunks: [progressiveAc(1) + "1"] }]));
    expect(warnings).toEqual(["Corrupt JPEG data: bad Huffman code\n"]);
    const overrun: ProgressiveFixtureScan = { ...ac, low: 0, chunks: [progressiveAc(17) + "1"] };
    const normal: ProgressiveFixtureScan = { ...overrun, end: 2 };
    expect(decoded([dc, overrun])).toEqual(decoded([dc, normal]));
    expect(decoded([dc, overrun])).not.toEqual(decodeJpeg(gray()));
    expect(decodeJpeg(progressiveFixture([dc, { ...ac, low: 0, chunks: [progressiveAc(240)] }])))
      .toEqual(decodeJpeg(gray()));
    const refinementOverrun = { ...refined, chunks: [progressiveAc(49) + "1"] };
    expect(decoded([dc, ac, refinementOverrun]))
      .toEqual(decoded([dc, { ...ac, end: 2 }, { ...refined, end: 2, chunks: [progressiveAc(17) + "1"] }]));
    const sentinel = { ...overrun, start: 63, end: 63, chunks: [progressiveAc(49) + "1"] };
    expect(decoded([dc, sentinel])).toEqual(decoded([dc, { ...sentinel, chunks: [progressiveAc(1) + "1"] }]));
    expect(decoded([dc, sentinel])).not.toEqual(decodeJpeg(gray()));
    const extended = amplified(progressiveFixture([dc, { ...ac, low: 1, chunks: [progressiveAc(10) + "1".repeat(15)] }]));
    extended[markerOffset(extended, 196) + 60] = 15;
    expect(decodeJpeg(extended)).toEqual(decoded([dc, { ...ac, low: 0, chunks: [progressiveAc(2) + "01"] }]));
  });

  test("source progressive recovery validates only active selectors and preserves fatal-before-warning order", () => {
    const dc: ProgressiveFixtureScan = { ids: [1], start: 0, end: 0, high: 1, low: 0, chunks: ["0"] };
    const refined = progressiveFixture([dc]);
    refined[markerOffset(refined, 218) + 6] = 255;
    const warnings: string[] = [];
    expect(decodeJpegWithWarnings(refined, "refine-selectors.jpg", text => { warnings.push(text); })).toEqual(decodeJpeg(gray()));
    expect(warnings).toEqual(["Inconsistent progression sequence for component 0 coefficient 0\n"]);
    const invalid = progressiveFixture([{ ...dc, high: 2, low: 0 }]);
    invalid[markerOffset(invalid, 218) + 6] = 240;
    warnings.length = 0;
    expect(() => decodeJpegWithWarnings(invalid, "bad-progression.jpg", text => { warnings.push(text); }))
      .toThrow("Invalid progressive parameters Ss=0 Se=0 Ah=2 Al=0");
    expect(warnings).toEqual([]);
    invalid[markerOffset(invalid, 194) + 12] = 3;
    expect(() => decodeJpeg(invalid)).toThrow("Quantization table 0x03 was not defined");
    const missing = progressiveFixture([{ ...dc, high: 0 }]);
    missing[markerOffset(missing, 218) + 6] = 48;
    expect(() => decodeJpeg(missing)).toThrow("Huffman table 0x03 was not defined");
  });

  test("source discards unused progressive padding before restarts and scan completion", () => {
    const dc = progressiveDc(0).repeat(3);
    const bytes = progressiveFixture([{ ids: [1, 2, 3], start: 0, end: 0, high: 0, low: 0, chunks: [dc, dc] }], 16, 8, [17, 17, 17], 1);
    const expected = decodeJpeg(bytes), restartPadding = markerOffset(bytes, 208) - 1;
    expect(Array.from(expected.pixels.slice(0, 4))).toEqual([128, 128, 128, 255]);
    expect(bytes[restartPadding]).toBe(15); expect(bytes[bytes.length - 3]).toBe(15);
    bytes[restartPadding] = 0; bytes[bytes.length - 3] = 0;
    expect(decodeJpeg(bytes)).toEqual(expected);
  });
  test("signed DC and AC refinement, new coefficients and spectral bands match sequential coefficients", () => {
    const bytes = progressiveFixture([
      { ids: [1], start: 0, end: 0, high: 0, low: 2, chunks: [progressiveDc(-21)] },
      { ids: [1], start: 1, end: 5, high: 0, low: 2, chunks: [progressiveAc(1) + "1" + progressiveAc(1) + "0" + progressiveAc(0)] },
      { ids: [1], start: 6, end: 63, high: 0, low: 0, chunks: [progressiveAc(0)] },
      { ids: [1], start: 0, end: 0, high: 2, low: 1, chunks: ["1"] },
      { ids: [1], start: 1, end: 5, high: 2, low: 1, chunks: [progressiveAc(1) + "101" + progressiveAc(0)] },
      { ids: [1], start: 0, end: 0, high: 1, low: 0, chunks: ["1"] },
      { ids: [1], start: 1, end: 5, high: 1, low: 0, chunks: [progressiveAc(1) + "0101" + progressiveAc(0)] },
    ]);
    const expected = coefficientFixture([-81, 5, -6, 3, -1, ...new Array<number>(59).fill(0)], new Array<number>(64).fill(1));
    expect(decodeJpeg(bytes)).toEqual(decodeJpeg(expected));
    for (let size = 0; size < bytes.length; size++) expect(() => decodeJpeg(bytes.subarray(0, size), "progressive-truncated.jpg")).toThrow("progressive-truncated.jpg");
  });

  test("EOB runs carry AC correction bits across blocks", () => {
    const bytes = progressiveFixture([
      { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(0).repeat(2)] },
      { ids: [1], start: 1, end: 63, high: 0, low: 1, chunks: [(progressiveAc(1) + "1" + progressiveAc(0)).repeat(2)] },
      { ids: [1], start: 1, end: 63, high: 1, low: 0, chunks: [progressiveAc(16) + "0" + "11"] },
    ], 16);
    const expected = decodeJpeg(coefficientFixture([0, 3, ...new Array<number>(62).fill(0)], new Array<number>(64).fill(1)));
    const image = decodeJpeg(bytes);
    for (let row = 0; row < 8; row++) {
      expect(image.pixels.slice(row * 64, row * 64 + 32)).toEqual(expected.pixels.slice(row * 32, row * 32 + 32));
      expect(image.pixels.slice(row * 64 + 32, row * 64 + 64)).toEqual(expected.pixels.slice(row * 32, row * 32 + 32));
    }
  });

  test("refinement ZRL and new-coefficient runs skip existing nonzero values", () => {
    const dc: ProgressiveFixtureScan = { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(0)] };
    const ac: ProgressiveFixtureScan = { ids: [1], start: 1, end: 63, high: 0, low: 1,
      chunks: [progressiveAc(1) + "1" + progressiveAc(240) + progressiveAc(1) + "0" + progressiveAc(0)] };
    const bytes = progressiveFixture([dc, ac,
      { ...ac, high: 1, low: 0, chunks: [progressiveAc(240) + "1" + progressiveAc(17) + "11" + progressiveAc(0)] },
    ]);
    const expected = progressiveFixture([dc, { ...ac, low: 0,
      chunks: [progressiveAc(2) + "11" + progressiveAc(240) + progressiveAc(2) + "00" + progressiveAc(17) + "1" + progressiveAc(0)] }]);
    expect(decodeJpeg(bytes)).toEqual(decodeJpeg(expected));
  });

  test("quantizers latch on first component scan and unused Huffman selectors need no table", () => {
    const bytes = progressiveFixture([
      { ids: [1], start: 0, end: 0, high: 0, low: 1, chunks: [progressiveDc(40)] },
      { ids: [1], start: 0, end: 0, high: 1, low: 0, chunks: ["1"] },
      { ids: [1], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(0)] },
    ]);
    const first = markerOffset(bytes, 218);
    const second = first + 2 + markerOffset(bytes.subarray(first + 2), 218);
    const third = second + 2 + markerOffset(bytes.subarray(second + 2), 218);
    bytes[first + 6] = 3;
    bytes[second + 6] = 51;
    bytes[third + 6] = 48;
    const redefined = new Uint8Array([...bytes.subarray(0, second),
      ...segment(219, [0, ...new Array<number>(64).fill(10)]), ...bytes.subarray(second)]);
    expect([...decodeJpeg(redefined).pixels]).toEqual(Array.from({ length: 64 }, () => [138, 138, 138, 255]).flat());
  });

  test("DC-only final images use source block smoothing with replicated edge neighbors", () => {
    const bytes = progressiveFixture([
      { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(40) + progressiveDc(80)] },
    ], 16);
    // K.8 predicts AC01=-11 in both blocks, AC02=+3/-3, all other
    // coefficients zero. Independent cosine evaluation gives these rows.
    const row = [132, 132, 132, 132, 133, 134, 135, 135, 141, 141, 142, 143, 144, 144, 144, 144];
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 8 }, () => row.flatMap(value => [value, value, value, 255])).flat());
    for (let quantizer = 0; quantizer < 6; quantizer++) {
      const zero = bytes.slice();
      zero[markerOffset(zero, 219) + 5 + quantizer] = 0;
      const plain = quantizer === 0 ? [128, 128] : [133, 143];
      expect([...decodeJpeg(zero).pixels]).toEqual(Array.from({ length: 128 }, (_, pixel) => {
        const value = plain[Math.floor((pixel % 16) / 8)];
        if (value === undefined) throw new Error("missing expected block sample");
        return [value, value, value, 255];
      }).flat());
    }
  });

  test("interleaved DC and separate AC scans retain subsampled odd-edge block positions", () => {
    const bytes = progressiveFixture([
      { ids: [1, 2, 3], start: 0, end: 0, high: 0, low: 0,
        chunks: [progressiveDc(-416) + progressiveDc(0).repeat(3) + progressiveDc(-344) + progressiveDc(1016)] },
      { ids: [1], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(16) + "0"] },
      { ids: [2], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(0)] },
      { ids: [3], start: 1, end: 63, high: 0, low: 0, chunks: [progressiveAc(0)] },
    ], 9, 5, [34, 17, 17]);
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 45 }, () => [254, 0, 0, 255]).flat());
  });

  test("progressive restarts wrap sequence and reset DC and EOB state for each scan", () => {
    const dc = Array.from({ length: 10 }, () => progressiveDc(40));
    const first = Array.from({ length: 10 }, () => progressiveAc(0));
    const bytes = progressiveFixture([
      { ids: [1], start: 0, end: 0, high: 0, low: 1, chunks: dc },
      { ids: [1], start: 1, end: 63, high: 0, low: 1, chunks: first },
      { ids: [1], start: 0, end: 0, high: 1, low: 0, chunks: new Array<string>(10).fill("1") },
      { ids: [1], start: 1, end: 63, high: 1, low: 0, chunks: first },
    ], 80, 8, [17], 1);
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 640 }, () => [138, 138, 138, 255]).flat());
    bytes[markerOffset(bytes, 208) + 1] = 209;
    expect([...decodeJpeg(bytes).pixels]).toEqual(Array.from({ length: 640 }, (_, pixel) => {
      const value = Math.floor((pixel % 80) / 8) === 1 ? 128 : 138;
      return [value, value, value, 255];
    }).flat());
  });

  test("rejects source-invalid progressive spectral and approximation parameters", () => {
    const dc: ProgressiveFixtureScan = { ids: [1], start: 0, end: 0, high: 0, low: 0, chunks: [progressiveDc(0)] };
    const ac: ProgressiveFixtureScan = { ids: [1], start: 1, end: 63, high: 0, low: 1, chunks: [progressiveAc(0)] };
    for (const [scans, message] of [
      [[dc, { ...ac, high: 2, low: 0 }], "Invalid progressive parameters Ss=1 Se=63 Ah=2 Al=0"],
      [[dc, { ...ac, end: 0 }], "Invalid progressive parameters Ss=1 Se=0 Ah=0 Al=1"],
      [[dc, { ...ac, low: 14 }], "Invalid progressive parameters Ss=1 Se=63 Ah=0 Al=14"],
    ] satisfies [ProgressiveFixtureScan[], string][]) expect(() => decodeJpeg(progressiveFixture(scans))).toThrow(message);
  });
});

const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"));

test.skipIf(!retailAvailable)("JPEG loads through the project's mounted retail filesystem", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "baseq3" });
  const path = vfs.list("env/").find(path => path.endsWith(".jpg"));
  if (path === undefined) throw new Error("retail installation has no JPEG environment map");
  const bytes = await vfs.read(path);
  const image = decodeJpeg(bytes, path);
  expect(image.width).toBeGreaterThan(0);
  expect(image.height).toBeGreaterThan(0);
  if (Bun.which("djpeg") !== null) compareReference(image, bytes);
});

test.skipIf(!retailAvailable)("all installed retail JPEGs decode; samples compare with the IJG float decoder", () => {
  let images = 0;
  let compared = 0;
  const djpegAvailable = Bun.which("djpeg") !== null;
  for (const game of ["baseq3", "missionpack"]) {
    const directory = join(retailRoot, game);
    if (!existsSync(directory)) continue;
    for (const archive of readdirSync(directory).filter(name => name.endsWith(".pk3"))) {
      const path = join(directory, archive);
      const listing = Bun.spawnSync(["unzip", "-Z1", path]);
      expect(listing.exitCode).toBe(0);
      for (const name of new TextDecoder().decode(listing.stdout).split("\n").filter(name => /\.jpe?g$/i.test(name))) {
        const extracted = Bun.spawnSync(["unzip", "-p", path, name]);
        expect(extracted.exitCode).toBe(0);
        const image = decodeJpeg(extracted.stdout, `${archive}/${name}`);
        expect(image.pixels.length).toBe(image.width * image.height * 4);
        if (djpegAvailable && images % 50 === 0) {
          compareReference(image, extracted.stdout);
          compared++;
        }
        images++;
      }
    }
  }
  expect(images).toBeGreaterThan(0);
  if (djpegAvailable) expect(compared).toBeGreaterThan(0);
}, 120_000);
