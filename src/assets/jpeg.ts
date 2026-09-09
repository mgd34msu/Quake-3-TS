/**
 * TypeScript translation of IJG jdmarker.c, jdhuff.c, jdphuff.c, jdcoefct.c,
 * jdinput.c, jdmainct.c, jdapimin.c, jddctmgr.c, jidctflt.c,
 * jdsample.c and jdcolor.c, used by Quake III renderer/tr_image.c LoadJPG.
 * Copyright (C) 1991-1998, Thomas G. Lane. See the IJG README license notice.
 * This version uses owned buffers and source-defined entropy recovery.
 * It supports 8-bit sequential and progressive
 * Huffman JPEG, including source-defined progressive scan recovery.
 * Multiscan/progressive and RGB input extend the pinned game build's selected
 * profile. Grayscale expands to RGBA instead of LoadJPG's undersized buffer.
 */
import { BinaryError } from "../core/binary.ts";

export interface JpegImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** A defined IJG error_exit message, dispatched as ERR_FATAL by the renderer. */
export class JpegSourceError extends BinaryError {
  constructor(source: string, offset: number, readonly sourceMessage: string) {
    super(source, offset, `JPEG: ${sourceMessage}`);
    this.name = "JpegSourceError";
  }
}

const naturalOrder = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

function at(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`JPEG internal index ${index}`);
  return value;
}

class Warnings {
  private count = 0;
  constructor(readonly print: (text: string) => undefined) {}
  emit(message: string): void {
    // jerror.c emit_message, with the renderer's default trace_level = 0.
    if (this.count === 0) this.print(`${message}\n`);
    this.count++;
  }
}

class Input {
  offset = 0;
  unreadMarker = 0;
  discardedBytes = 0;
  constructor(readonly bytes: Uint8Array, readonly source: string, readonly warnings: Warnings) {}
  fail(message: string): never {
    throw new BinaryError(this.source, this.offset, `JPEG: ${message}`);
  }
  sourceFail(message: string): never {
    throw new JpegSourceError(this.source, this.offset, message);
  }
  byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) this.fail("truncated input");
    this.offset++;
    return value;
  }
  word(): number { return this.byte() * 256 + this.byte(); }
  private nextMarker(): void {
    while (true) {
      let marker = this.byte();
      while (marker !== 255) { this.discardedBytes++; marker = this.byte(); }
      do { marker = this.byte(); } while (marker === 255);
      if (marker === 0) { this.discardedBytes += 2; continue; }
      if (this.discardedBytes !== 0) {
        this.warnings.emit(`Corrupt JPEG data: ${this.discardedBytes} extraneous bytes before marker 0x${marker.toString(16).padStart(2, "0")}`);
        this.discardedBytes = 0;
      }
      this.unreadMarker = marker;
      return;
    }
  }
  marker(): number {
    if (this.unreadMarker === 0) this.nextMarker();
    const marker = this.unreadMarker;
    this.unreadMarker = 0;
    return marker;
  }
  restart(desired: number): void {
    if (this.unreadMarker === 0) this.nextMarker();
    if (this.unreadMarker === 208 + desired) { this.unreadMarker = 0; return; }
    this.warnings.emit(`Corrupt JPEG data: found marker 0x${this.unreadMarker.toString(16).padStart(2, "0")} instead of RST${desired}`);
    // jdmarker.c jpeg_resync_to_restart: retain nearby future markers,
    // search past stale markers, and consume distant restart markers.
    while (true) {
      const marker = this.unreadMarker;
      if (marker < 192 || marker === 208 + ((desired - 1) & 7) || marker === 208 + ((desired - 2) & 7)) {
        this.nextMarker();
      } else if (marker < 208 || marker > 215 || marker === 208 + ((desired + 1) & 7) || marker === 208 + ((desired + 2) & 7)) {
        return;
      } else { this.unreadMarker = 0; return; }
    }
  }
  skip(size: number): void {
    if (size <= 0) return;
    if (size > this.bytes.length - this.offset) {
      this.offset = this.bytes.length;
      this.fail("truncated input");
    }
    this.offset += size;
  }
}

class Entropy {
  private value = 0;
  private remaining = 0;
  private printedEnd = false;
  constructor(readonly input: Input) {}
  private fill(required: number): void {
    while (this.remaining < 25) {
      let next = 0;
      if (this.input.unreadMarker !== 0) {
        if (this.remaining >= required) break;
        if (!this.printedEnd) {
          this.input.warnings.emit("Corrupt JPEG data: premature end of data segment");
          this.printedEnd = true;
        }
      } else {
        next = this.input.byte();
        if (next === 255) {
          let following = this.input.byte();
          while (following === 255) following = this.input.byte();
          if (following !== 0) { this.input.unreadMarker = following; continue; }
        }
      }
      this.value = (this.value << 8) | next;
      this.remaining += 8;
    }
  }
  bits(count: number): number {
    if (this.remaining < count) this.fill(count);
    this.remaining -= count;
    return (this.value >>> this.remaining) & ((1 << count) - 1);
  }
  signed(count: number): number {
    if (count > 15) this.input.fail("DC category exceeds source sign-extension table");
    const value = this.bits(count);
    return count > 0 && value < 2 ** (count - 1) ? value + 1 - 2 ** count : value;
  }
  align(): void {
    // IJG discards unused bits at scan and restart boundaries.
    this.remaining = 0;
  }
  restart(desired: number): void {
    this.input.discardedBytes += Math.floor(this.remaining / 8);
    this.align();
    this.input.restart(desired);
    this.printedEnd = false;
  }
  symbol(table: ReadonlyMap<number, number>): number {
    if (this.remaining < 8) this.fill(0);
    let minimum = 1;
    if (this.remaining >= 8) {
      const look = (this.value >>> (this.remaining - 8)) & 255;
      for (let length = 1; length <= 8; length++) {
        const value = table.get((1 << length) + (look >>> (8 - length)));
        if (value !== undefined) { this.remaining -= length; return value; }
      }
      minimum = 9;
    }
    let code = (1 << minimum) + this.bits(minimum);
    for (let length = minimum; length <= 16; length++) {
      const value = table.get(code);
      if (value !== undefined) return value;
      code = code * 2 + this.bits(1);
    }
    // jpeg_huff_decode consumes the seventeenth bit before recovery.
    this.input.warnings.emit("Corrupt JPEG data: bad Huffman code");
    return 0;
  }
}

interface Component {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly quantizer: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly pixels: Uint8Array;
  readonly outputSamples: Uint8Array | null;
  readonly progression: Progression | null;
}

interface Progression {
  readonly coefficients: Int16Array;
  readonly bits: Int8Array;
  table: { readonly quantizer: Uint16Array; readonly multipliers: Float32Array } | null;
}

interface Frame {
  readonly progressive: boolean;
  readonly width: number;
  readonly height: number;
  readonly maxH: number;
  readonly maxV: number;
  readonly columns: number;
  readonly rows: number;
  readonly components: readonly Component[];
}

interface FrameHeader {
  readonly progressive: boolean;
  readonly arithmetic: boolean;
  readonly precision: number;
  readonly width: number;
  readonly height: number;
  readonly components: readonly { readonly id: number; readonly h: number; readonly v: number; readonly quantizer: number }[];
}

interface ScanHeader {
  readonly members: readonly { readonly id: number; readonly selector: number }[];
  readonly start: number;
  readonly end: number;
  readonly approximation: number;
}

type ColorSpace = "grayscale" | "rgb" | "ycbcr" | "cmyk" | "ycck" | "unknown";

interface ScanComponent {
  readonly component: Component;
  readonly prediction: { dc: number };
  readonly dc: ReadonlyMap<number, number>;
  readonly ac: ReadonlyMap<number, number>;
  readonly multipliers: Float32Array;
}

interface HuffmanTable {
  readonly counts: readonly number[];
  readonly values: Uint8Array;
  derived?: ReadonlyMap<number, number>;
}

function readFrame(input: Input, progressive: boolean, arithmetic: boolean, duplicate: boolean): FrameHeader {
  const length = input.word();
  const precision = input.byte();
  const height = input.word();
  const width = input.word();
  const count = input.byte();
  if (duplicate) input.sourceFail("Invalid JPEG file structure: two SOF markers");
  if (width === 0 || height === 0 || count === 0) input.sourceFail("Empty JPEG image (DNL not supported)");
  if (length !== 8 + count * 3) input.sourceFail("Bogus marker length");
  const descriptors: { id: number; h: number; v: number; quantizer: number }[] = [];
  for (let index = 0; index < count; index++) {
    const id = input.byte();
    const sampling = input.byte();
    const h = sampling >> 4;
    const v = sampling & 15;
    const quantizer = input.byte();
    descriptors.push({ id, h, v, quantizer });
  }
  return { progressive, arithmetic, precision, width, height, components: descriptors };
}

// jdinput.c initial_setup runs only after the first complete SOS header.
function prepareFrame(input: Input, header: FrameHeader, buffered: boolean): Frame {
  const { width, height, precision, progressive, components: descriptors } = header;
  const count = descriptors.length;
  if (width > 65500 || height > 65500) input.sourceFail("Maximum supported image dimension is 65500 pixels");
  if (precision !== 8) input.sourceFail(`Unsupported JPEG data precision ${precision}`);
  if (count > 10) input.sourceFail(`Too many color components: ${count}, max 10`);
  let maxH = 1;
  let maxV = 1;
  for (const { h, v } of descriptors) {
    if (h < 1 || h > 4 || v < 1 || v > 4) input.sourceFail("Bogus sampling factors");
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
  }
  const columns = Math.ceil(width / (8 * maxH));
  const rows = Math.ceil(height / (8 * maxV));
  const components = descriptors.map(descriptor => {
    const stride = columns * descriptor.h * 8;
    return {
      ...descriptor, width: Math.ceil(width * descriptor.h / maxH),
      height: Math.ceil(height * descriptor.v / maxV), stride,
      pixels: new Uint8Array(buffered ? stride * rows * descriptor.v * 8 : 0),
      outputSamples: buffered ? null : new Uint8Array(width * height),
      progression: buffered ? {
        coefficients: new Int16Array(stride * rows * descriptor.v * 8),
        bits: new Int8Array(64).fill(-1), table: null,
      } : null,
    };
  });
  return { width, height, maxH, maxV, columns, rows, components, progressive };
}

function readScanHeader(input: Input, frame: { readonly components: readonly { readonly id: number }[] }): ScanHeader {
  const length = input.word();
  const count = input.byte();
  if (count < 1 || count > 4 || length !== 6 + count * 2) input.sourceFail("Bogus marker length");
  const members: { id: number; selector: number }[] = [];
  for (let index = 0; index < count; index++) {
    const id = input.byte();
    const selector = input.byte();
    if (!frame.components.some(component => component.id === id)) input.sourceFail(`Invalid component ID ${id} in SOS`);
    for (const member of members) if (member.id === id) member.selector = selector;
    members.push({ id, selector });
  }
  const start = input.byte(), end = input.byte(), approximation = input.byte();
  return { members, start, end, approximation };
}

function readQuantizers(input: Input, tables: Map<number, Uint16Array>): void {
  let remaining = input.word() - 2;
  while (remaining > 0) {
    const selector = input.byte();
    const precision = selector >> 4;
    const id = selector & 15;
    if (id > 3) input.sourceFail(`Bogus DQT index ${id}`);
    const table = new Uint16Array(64);
    for (let index = 0; index < 64; index++) {
      const value = precision === 0 ? input.byte() : input.word();
      table[at(naturalOrder, index)] = value;
    }
    tables.set(id, table);
    remaining -= precision === 0 ? 65 : 129;
  }
}

function readHuffman(input: Input, tables: Map<number, HuffmanTable>): void {
  let remaining = input.word() - 2;
  while (remaining > 0) {
    const selector = input.byte();
    const counts: number[] = [];
    let total = 0;
    for (let length = 1; length <= 16; length++) {
      const count = input.byte();
      counts.push(count);
      total += count;
    }
    remaining -= 17;
    if (total > 256 || total > remaining) input.sourceFail("Bogus DHT counts");
    const values = Uint8Array.from({ length: total }, () => input.byte());
    remaining -= total;
    const tableIndex = (selector & 16) !== 0 ? selector - 16 : selector;
    if (tableIndex >= 4) input.sourceFail(`Bogus DHT index ${tableIndex}`);
    tables.set(selector, { counts, values });
  }
}

// jdhuff.c derives tables at scan startup, not while reading DHT markers.
function deriveHuffman(input: Input, tables: ReadonlyMap<number, HuffmanTable>, selector: number): ReadonlyMap<number, number> {
  const raw = tables.get(selector);
  if (raw === undefined) input.sourceFail(`Huffman table 0x${(selector & 15).toString(16).padStart(2, "0")} was not defined`);
  if (raw.derived !== undefined) return raw.derived;
  const table = new Map<number, number>();
  let code = 0;
  let valueIndex = 0;
  for (let length = 1; length <= 16; length++) {
    const count = at(raw.counts, length - 1);
    // Short overfull codes write beyond IJG's 256-entry lookahead arrays.
    if (length <= 8 && code + count > 2 ** length && count !== 0) input.fail("oversubscribed Huffman table exceeds source lookahead allocation");
    for (let symbol = 0; symbol < count; symbol++, code++) {
      const value = at(raw.values, valueIndex++);
      if (code < 2 ** length) table.set(2 ** length + code, value);
    }
    code *= 2;
  }
  raw.derived = table;
  return table;
}

// jdmarker.c get_dac validates these tables even for a Huffman frame.
function readArithmeticTables(input: Input): void {
  let remaining = input.word() - 2;
  while (remaining > 0) {
    const index = input.byte();
    const value = input.byte();
    remaining -= 2;
    if (index >= 32) input.sourceFail(`Bogus DAC index ${index}`);
    if (index < 16 && (value & 15) > (value >> 4)) input.sourceFail(`Bogus DAC value 0x${value.toString(16)}`);
  }
}

// jdmarker.c reads fixed APP prefixes before skipping any declared tail.
function readJfif(input: Input): boolean {
  let remaining = input.word() - 2;
  let recognized = false;
  if (remaining >= 14) {
    const prefix = Uint8Array.from({ length: 14 }, () => input.byte());
    remaining -= 14;
    recognized = new TextDecoder().decode(prefix.subarray(0, 5)) === "JFIF\0";
    if (recognized) {
      const major = at(prefix, 5);
      if (major !== 1) input.warnings.emit(`Warning: unknown JFIF revision number ${major}.${at(prefix, 6).toString().padStart(2, "0")}`);
    }
  }
  input.skip(remaining);
  return recognized;
}

function readAdobe(input: Input): number | undefined {
  let remaining = input.word() - 2;
  let transform: number | undefined;
  if (remaining >= 12) {
    const prefix = Uint8Array.from({ length: 12 }, () => input.byte());
    remaining -= 12;
    if (new TextDecoder().decode(prefix.subarray(0, 5)) === "Adobe") transform = at(prefix, 11);
  }
  input.skip(remaining);
  return transform;
}

function descale(value: number, bits: number): number {
  return Math.floor((value + 2 ** (bits - 1)) / 2 ** bits);
}

function clamp(value: number): number { return Math.min(255, Math.max(0, value)); }

// jddctmgr.c start_pass: double-precision AA&N scaling, stored as FAST_FLOAT.
function floatMultipliers(quantizer: Uint16Array): Float32Array {
  const scales = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.541196100, 0.275899379];
  return Float32Array.from(quantizer, (value, index) => value * at(scales, Math.floor(index / 8)) * at(scales, index % 8));
}

// jidctflt.c jpeg_idct_float: FAST_FLOAT is float in the pinned jconfig.h.
// Round arithmetic as well as assignments, without fused multiply-add.
function inversePass(values: Float32Array, start: number, step: number, output: Float32Array, outputStart: number, outputStep: number): void {
  const f = Math.fround;
  const a0 = at(values, start);
  const a1 = at(values, start + step);
  const a2 = at(values, start + step * 2);
  const a3 = at(values, start + step * 3);
  const a4 = at(values, start + step * 4);
  const a5 = at(values, start + step * 5);
  const a6 = at(values, start + step * 6);
  const a7 = at(values, start + step * 7);
  const even10 = f(a0 + a4);
  const even11 = f(a0 - a4);
  const even13 = f(a2 + a6);
  const even12 = f(f(f(a2 - a6) * f(1.414213562)) - even13);
  const tmp0 = f(even10 + even13);
  const tmp3 = f(even10 - even13);
  const tmp1 = f(even11 + even12);
  const tmp2 = f(even11 - even12);
  const z13 = f(a5 + a3);
  const z10 = f(a5 - a3);
  const z11 = f(a1 + a7);
  const z12 = f(a1 - a7);
  const tmp7 = f(z11 + z13);
  const odd11 = f(f(z11 - z13) * f(1.414213562));
  const z5 = f(f(z10 + z12) * f(1.847759065));
  const odd10 = f(f(f(1.082392200) * z12) - z5);
  const odd12 = f(f(f(-2.613125930) * z10) + z5);
  const tmp6 = f(odd12 - tmp7);
  const tmp5 = f(odd11 - tmp6);
  const tmp4 = f(odd10 + tmp5);
  output[outputStart] = tmp0 + tmp7;
  output[outputStart + outputStep * 7] = tmp0 - tmp7;
  output[outputStart + outputStep] = tmp1 + tmp6;
  output[outputStart + outputStep * 6] = tmp1 - tmp6;
  output[outputStart + outputStep * 2] = tmp2 + tmp5;
  output[outputStart + outputStep * 5] = tmp2 - tmp5;
  output[outputStart + outputStep * 4] = tmp3 + tmp4;
  output[outputStart + outputStep * 3] = tmp3 - tmp4;
}

// jdmaster.c prepare_range_limit_table and jidctflt.c's INT32-before-DESCALE.
function idctSample(value: number): number {
  const index = descale(Math.trunc(value), 3) & 1023;
  if (index < 128) return index + 128;
  if (index < 512) return 255;
  if (index < 896) return 0;
  return index - 896;
}

function decodeBlock(entropy: Entropy, scan: ScanComponent, column: number, row: number, block: Float32Array): void {
  const component = scan.component;
  const storage = component.progression;
  const offset = (row * (component.stride / 8) + column) * 64;
  if (storage === null) block.fill(0);
  else block.set(storage.coefficients.subarray(offset, offset + 64));
  const dcSize = entropy.symbol(scan.dc);
  scan.prediction.dc = (scan.prediction.dc + entropy.signed(dcSize)) | 0;
  block[0] = (scan.prediction.dc << 16) >> 16;
  let index = 1;
  while (index < 64) {
    const symbol = entropy.symbol(scan.ac);
    const run = symbol >> 4;
    const size = symbol & 15;
    if (size === 0) {
      if (run !== 15) break;
      index += 16;
    } else {
      index += run;
      // jpeg_natural_order has sixteen sentinel entries pointing at 63.
      const natural = at(naturalOrder, Math.min(index++, 63));
      block[natural] = entropy.signed(size);
    }
  }
  if (storage !== null) storage.coefficients.set(block, offset);
  else {
    for (let index = 0; index < 64; index++) block[index] = at(block, index) * at(scan.multipliers, index);
  }
}

function inverseBlock(block: Float32Array, workspace: Float32Array): void {
  for (let x = 0; x < 8; x++) {
    let dcOnly = true;
    for (let y = 1; y < 8; y++) dcOnly &&= at(block, y * 8 + x) === 0;
    if (dcOnly) {
      for (let y = 0; y < 8; y++) workspace[y * 8 + x] = at(block, x);
    } else inversePass(block, x, 8, workspace, x, 8);
  }
  for (let y = 0; y < 8; y++) inversePass(workspace, y * 8, 1, block, y * 8, 1);
}

function writeBlock(input: Input, component: Component, column: number, row: number, block: Float32Array, workspace: Float32Array): void {
  inverseBlock(block, workspace);
  for (let y = 0; y < 8; y++) {
    const destination = (row * 8 + y) * component.stride + column * 8;
    if (destination + 8 > component.pixels.length) input.fail("block outside component plane");
    for (let x = 0; x < 8; x++) component.pixels[destination + x] = idctSample(at(block, y * 8 + x));
  }
}

interface StripPlane {
  readonly pixels: Uint8Array;
  readonly initialized: Uint8Array;
  readonly pointers: number[];
  readonly starts: readonly [number, number];
}

// jdmainct.c's physical strip and two pointer lists. Keep initialization
// separate from bytes: native alloc_sarray does not zero its sample storage.
class OnePassRows {
  private readonly context: boolean;
  private readonly planes: readonly StripPlane[];
  private which: 0 | 1 = 0;
  private outputRow = 0;

  constructor(private readonly input: Input, private readonly frame: Frame, private readonly colorSpace: ColorSpace) {
    this.context = frame.components.some(component => frame.maxH === component.h * 2
      && frame.maxV === component.v * 2 && component.width > 2);
    this.planes = frame.components.map(component => {
      const v = component.v;
      const stride = Math.ceil(component.width / 8) * 8;
      const rows = v * (this.context ? 10 : 8);
      const starts: [number, number] = this.context ? [v, v * 13] : [0, 0];
      const pointers = new Array<number>(this.context ? v * 24 : rows);
      for (const start of starts) {
        for (let row = 0; row < rows; row++) pointers[start + row] = row * stride;
      }
      if (this.context) {
        for (let row = 0; row < v * 2; row++) {
          pointers[starts[1] + v * 6 + row] = (v * 8 + row) * stride;
          pointers[starts[1] + v * 8 + row] = (v * 6 + row) * stride;
        }
        for (let row = 0; row < v; row++) pointers[starts[0] - v + row] = 0;
      }
      return { pixels: new Uint8Array(stride * rows), initialized: new Uint8Array(stride * rows), pointers, starts };
    });
  }

  private plane(index: number): StripPlane {
    const plane = this.planes[index];
    if (plane === undefined) this.input.fail("scan output uses an uninitialized source component pointer");
    return plane;
  }

  private rowPointer(plane: StripPlane, row: number, which: 0 | 1 = this.which): number {
    const index = plane.starts[which] + row;
    if (index < 0 || index >= plane.pointers.length) this.input.fail("row pointer outside source pointer allocation");
    const pointer = plane.pointers[index];
    if (pointer === undefined) this.input.fail("uninitialized source row pointer");
    return pointer;
  }

  write(index: number, column: number, row: number, block: Float32Array, workspace: Float32Array): void {
    // alloc_funny_pointers allocates both top-level component lists together;
    // an extra list0 scan member can therefore address a list1 component.
    const physicalIndex = this.which * this.planes.length + index;
    if (this.context && physicalIndex >= this.planes.length * 2) this.input.fail("component pointer outside source xbuffer allocation");
    const plane = this.plane(this.context ? physicalIndex % this.planes.length : index);
    const which = this.context && physicalIndex >= this.planes.length ? 1 : 0;
    inverseBlock(block, workspace);
    for (let y = 0; y < 8; y++) {
      const destination = this.rowPointer(plane, row * 8 + y, which) + column * 8;
      if (destination < 0 || destination + 8 > plane.pixels.length) this.input.fail("IDCT write outside source sample allocation");
      for (let x = 0; x < 8; x++) {
        plane.pixels[destination + x] = idctSample(at(block, y * 8 + x));
        plane.initialized[destination + x] = 1;
      }
    }
  }

  private read(plane: StripPlane, row: number, column: number): number {
    const offset = this.rowPointer(plane, row) + column;
    if (offset < 0 || offset >= plane.pixels.length) this.input.fail("upsampling read outside source sample allocation");
    if (plane.initialized[offset] !== 1) this.input.fail("upsampling reads an uninitialized source sample");
    return at(plane.pixels, offset);
  }

  private emitGroup(group: number): void {
    const frame = this.frame;
    if (this.outputRow >= frame.height) return;
    for (const [index, component] of frame.components.entries()) {
      const plane = this.plane(index);
      const output = component.outputSamples;
      if (output === null) throw new Error("JPEG one-pass component lacks output samples");
      const h = frame.maxH / component.h, v = frame.maxV / component.v;
      if (h === 1 && v === 1) continue;
      // Non-fullsize methods upsample every row before output cropping.
      for (let y = 0; y < frame.maxV; y++) {
        const row = group * component.v + Math.floor(y / v);
        for (let x = 0; x < frame.width; x++) {
          const column = Math.floor(x / h);
          const center = this.read(plane, row, column);
          let value = center;
          if (h === 2 && component.width > 2 && (v === 1 || v === 2)) {
            const neighbor = Math.max(0, Math.min(component.width - 1, column + (x % 2 === 0 ? -1 : 1)));
            const horizontal = this.read(plane, row, neighbor);
            if (v === 1) value = (center * 3 + horizontal + (x % 2 === 0 ? 1 : 2)) >> 2;
            else {
              const adjacent = row + (y % 2 === 0 ? -1 : 1);
              const vertical = this.read(plane, adjacent, column);
              const diagonal = this.read(plane, adjacent, neighbor);
              value = (center * 9 + horizontal * 3 + vertical * 3 + diagonal + (x % 2 === 0 ? 8 : 7)) >> 4;
            }
          }
          if (this.outputRow + y < frame.height) output[(this.outputRow + y) * frame.width + x] = value;
        }
      }
    }
    // fullsize_upsample only aliases pointers. Its actual reads happen in
    // jdcolor, after every non-fullsize upsampler has completed the group.
    const readFullsize = (index: number, x: number, y: number): void => {
      const component = frame.components[index];
      if (component === undefined) throw new Error("JPEG missing color component");
      if (component.h !== frame.maxH || component.v !== frame.maxV) return;
      const output = component.outputSamples;
      if (output === null) throw new Error("JPEG one-pass component lacks output samples");
      output[(this.outputRow + y) * frame.width + x] = this.read(this.plane(index), group * component.v + y, x);
    };
    for (let y = 0; y < Math.min(frame.maxV, frame.height - this.outputRow); y++) {
      if (this.colorSpace === "ycbcr" || this.colorSpace === "ycck") {
        for (let x = 0; x < frame.width; x++) {
          for (let index = 0; index < frame.components.length; index++) readFullsize(index, x, y);
        }
      } else {
        for (let index = 0; index < frame.components.length; index++) {
          for (let x = 0; x < frame.width; x++) readFullsize(index, x, y);
        }
      }
    }
    this.outputRow += frame.maxV;
  }

  finishRow(iMcu: number): void {
    if (!this.context) {
      for (let group = 0; group < 8; group++) this.emitGroup(group);
      return;
    }
    // The next strip is decoded before the previous postponed group. Bottom
    // pointer changes must happen after that postponed group is consumed.
    if (iMcu > 0) this.emitGroup(9);
    let available = 7;
    if (iMcu === this.frame.rows - 1) {
      for (const [index, component] of this.frame.components.entries()) {
        const plane = this.plane(index);
        const remainder = component.height % (component.v * 8);
        const rowsLeft = remainder === 0 ? component.v * 8 : remainder;
        if (index === 0) available = Math.ceil(rowsLeft / component.v);
        const last = this.rowPointer(plane, rowsLeft - 1);
        for (let row = 0; row < component.v * 2; row++) plane.pointers[plane.starts[this.which] + rowsLeft + row] = last;
      }
    }
    for (let group = 0; group < available; group++) this.emitGroup(group);
    if (iMcu === 0) {
      for (const [index, component] of this.frame.components.entries()) {
        const plane = this.plane(index);
        for (const start of plane.starts) {
          for (let row = 0; row < component.v; row++) {
            plane.pointers[start - component.v + row] = at(plane.pointers, start + component.v * 9 + row);
            plane.pointers[start + component.v * 10 + row] = at(plane.pointers, start + row);
          }
        }
      }
    }
    this.which = this.which === 0 ? 1 : 0;
  }
}

function readScan(input: Input, scanHeader: ScanHeader, frame: Frame, quantizers: ReadonlyMap<number, Uint16Array>, huffman: ReadonlyMap<number, HuffmanTable>, restartInterval: number, buffered: boolean, colorSpace: ColorSpace): void {
  const count = scanHeader.members.length;
  const { start, end, approximation } = scanHeader;
  const members: { component: Component; selector: number }[] = [];
  for (const { id, selector } of scanHeader.members) {
    const component = frame.components.find(candidate => candidate.id === id);
    if (component === undefined) input.sourceFail(`Invalid component ID ${id} in SOS`);
    members.push({ component, selector });
  }
  // jdinput.c per_scan_setup limits interleaved MCU membership, not the frame.
  if (count > 1 && members.reduce((blocks, member) => blocks + member.component.h * member.component.v, 0) > 10) input.sourceFail("Sampling factors too large for interleaved scan");
  const prepared = members.map(({ component, selector }) => {
    const storage = component.progression;
    if (storage !== null && storage.table !== null) {
      return { component, selector, multipliers: storage.table.multipliers };
    }
    const quantizer = quantizers.get(component.quantizer);
    if (quantizer === undefined) input.sourceFail(`Quantization table 0x${component.quantizer.toString(16).padStart(2, "0")} was not defined`);
    const multipliers = floatMultipliers(quantizer);
    if (component.progression !== null) component.progression.table = { quantizer, multipliers };
    return { component, selector, multipliers };
  });
  if (start !== 0 || end !== 63 || approximation !== 0) input.warnings.emit("Invalid SOS parameters for sequential JPEG");
  const scans: ScanComponent[] = prepared.map(({ component, selector, multipliers }) => {
    for (const tableSelector of [selector >> 4, 16 + (selector & 15)]) {
      if (!huffman.has(tableSelector)) input.sourceFail(`Huffman table 0x${(tableSelector & 15).toString(16).padStart(2, "0")} was not defined`);
    }
    const dc = deriveHuffman(input, huffman, selector >> 4);
    const ac = deriveHuffman(input, huffman, 16 + (selector & 15));
    return { component, prediction: { dc: 0 }, dc, ac, multipliers };
  });
  const single = count === 1 ? scans[0] : undefined;
  const columns = single === undefined ? frame.columns : Math.ceil(single.component.width / 8);
  const rows = single === undefined ? frame.rows : Math.ceil(single.component.height / 8);
  const entropy = new Entropy(input);
  const blocks = Array.from({ length: 10 }, () => new Float32Array(64));
  const workspace = new Float32Array(64);
  const strip = buffered ? null : new OnePassRows(input, frame, colorSpace);
  let restart = 0;
  for (let mcu = 0; mcu < columns * rows; mcu++) {
    if (restartInterval !== 0 && mcu > 0 && mcu % restartInterval === 0) {
      entropy.restart(restart);
      restart = (restart + 1) & 7;
      for (const scan of scans) scan.prediction.dc = 0;
    }
    const column = mcu % columns;
    const row = Math.floor(mcu / columns);
    let blockIndex = 0;
    const pending: { index: number; column: number; row: number; block: Float32Array }[] = [];
    for (const [index, scan] of scans.entries()) {
      const h = single === undefined ? scan.component.h : 1;
      const v = single === undefined ? scan.component.v : 1;
      for (let y = 0; y < v; y++) {
        for (let x = 0; x < h; x++) {
          const block = blocks[blockIndex++];
          if (block === undefined) throw new Error("JPEG MCU exceeds block storage");
          const blockColumn = column * h + x, blockRow = row * v + y;
          decodeBlock(entropy, scan, blockColumn, blockRow, block);
          if (strip !== null && blockColumn * 8 < scan.component.width && blockRow * 8 < scan.component.height) {
            pending.push({ index, column: blockColumn, row: single === undefined ? y : row % scan.component.v, block });
          }
        }
      }
    }
    // jdhuff completes all MCU entropy before jdcoefct performs any IDCT.
    if (strip !== null) {
      for (const output of pending) strip.write(output.index, output.column, output.row, output.block, workspace);
      if (column === columns - 1 && (single === undefined || row % single.component.v === single.component.v - 1 || row === rows - 1)) {
        strip.finishRow(single === undefined ? row : Math.floor(row / single.component.v));
      }
    }
  }
  entropy.align();
}

// jdphuff.c decode_mcu_AC_first. EOB runs count blocks, including the block
// containing the symbol; restart boundaries reset both this count and DCs.
function progressiveAcFirst(entropy: Entropy, table: ReadonlyMap<number, number>, coefficients: Int16Array, offset: number, start: number, end: number, low: number, eob: { remaining: number }): void {
  if (eob.remaining > 0) { eob.remaining--; return; }
  let index = start;
  while (index <= end) {
    const symbol = entropy.symbol(table);
    const run = symbol >> 4;
    const size = symbol & 15;
    if (size === 0) {
      if (run < 15) {
        eob.remaining = (1 << run) + entropy.bits(run) - 1;
        return;
      }
      index += 16;
    } else {
      index += run;
      coefficients[offset + at(naturalOrder, Math.min(index++, 63))] = entropy.signed(size) << low;
    }
  }
}

function refineCoefficient(entropy: Entropy, coefficients: Int16Array, index: number, bit: number): void {
  const value = at(coefficients, index);
  if (entropy.bits(1) !== 0 && (value & bit) === 0) coefficients[index] = value + (value >= 0 ? bit : -bit);
}

// jdphuff.c decode_mcu_AC_refine: zero runs skip only zero coefficients.
// Existing nonzero coefficients consume correction bits even during EOB runs.
function progressiveAcRefine(entropy: Entropy, table: ReadonlyMap<number, number>, coefficients: Int16Array, offset: number, start: number, end: number, low: number, eob: { remaining: number }): void {
  const bit = 1 << low;
  let index = start;
  if (eob.remaining === 0) {
    while (index <= end) {
      const symbol = entropy.symbol(table);
      let run = symbol >> 4;
      const size = symbol & 15;
      let value = 0;
      if (size !== 0) {
        if (size !== 1) entropy.input.warnings.emit("Corrupt JPEG data: bad Huffman code");
        value = entropy.bits(1) === 0 ? -bit : bit;
      } else if (run < 15) {
        eob.remaining = (1 << run) + entropy.bits(run);
        break;
      }
      while (index <= end) {
        const position = offset + at(naturalOrder, index);
        if (at(coefficients, position) !== 0) refineCoefficient(entropy, coefficients, position, bit);
        else if (--run < 0) break;
        index++;
      }
      if (value !== 0) coefficients[offset + at(naturalOrder, Math.min(index, 63))] = value;
      index++;
    }
  }
  if (eob.remaining > 0) {
    for (; index <= end; index++) {
      const position = offset + at(naturalOrder, index);
      if (at(coefficients, position) !== 0) refineCoefficient(entropy, coefficients, position, bit);
    }
    eob.remaining--;
  }
}

function readProgressiveScan(input: Input, scanHeader: ScanHeader, frame: Frame, quantizers: ReadonlyMap<number, Uint16Array>, huffman: ReadonlyMap<number, HuffmanTable>, restartInterval: number): void {
  const count = scanHeader.members.length;
  const { start, end, approximation } = scanHeader;
  const members: { component: Component; state: Progression; selector: number }[] = [];
  for (const { id, selector } of scanHeader.members) {
    const component = frame.components.find(candidate => candidate.id === id);
    if (component === undefined) input.sourceFail(`Invalid component ID ${id} in SOS`);
    const state = component.progression;
    if (state === null) input.fail("progressive scan without coefficient storage");
    members.push({ component, state, selector });
  }
  const high = approximation >> 4;
  const low = approximation & 15;
  if (count > 1 && members.reduce((blocks, member) => blocks + member.component.h * member.component.v, 0) > 10) input.sourceFail("Sampling factors too large for interleaved scan");
  for (const { component, state } of members) {
    if (state.table !== null) continue;
    const quantizer = quantizers.get(component.quantizer);
    if (quantizer === undefined) input.sourceFail(`Quantization table 0x${component.quantizer.toString(16).padStart(2, "0")} was not defined`);
    state.table = { quantizer, multipliers: floatMultipliers(quantizer) };
  }
  if ((start === 0 ? end !== 0 : start > end || end > 63 || count !== 1)
      || (high !== 0 && low !== high - 1) || low > 13) input.sourceFail(`Invalid progressive parameters Ss=${start} Se=${end} Ah=${high} Al=${low}`);
  const entropy = new Entropy(input);
  const eob = { remaining: 0 };
  for (const { component, state } of members) {
    const componentIndex = frame.components.indexOf(component);
    if (start > 0 && at(state.bits, 0) < 0) input.warnings.emit(`Inconsistent progression sequence for component ${componentIndex} coefficient 0`);
    for (let index = start; index <= end; index++) {
      const previous = at(state.bits, index);
      if (high !== (previous < 0 ? 0 : previous)) input.warnings.emit(`Inconsistent progression sequence for component ${componentIndex} coefficient ${index}`);
      state.bits[index] = low;
    }
  }
  const scans = members.map(({ component, state, selector }) => {
    const prediction = { dc: 0 };
    let decode: (offset: number) => void;
    if (start === 0 && high !== 0) {
      decode = offset => {
        if (entropy.bits(1) !== 0) state.coefficients[offset] = at(state.coefficients, offset) | (1 << low);
      };
    } else {
      const table = deriveHuffman(input, huffman, start === 0 ? selector >> 4 : 16 + (selector & 15));
      if (start === 0) {
        decode = offset => {
          prediction.dc = (prediction.dc + entropy.signed(entropy.symbol(table))) | 0;
          state.coefficients[offset] = prediction.dc << low;
        };
      } else if (high === 0) {
        decode = offset => progressiveAcFirst(entropy, table, state.coefficients, offset, start, end, low, eob);
      } else {
        decode = offset => progressiveAcRefine(entropy, table, state.coefficients, offset, start, end, low, eob);
      }
    }
    return { component, decode, prediction };
  });
  const single = count === 1 ? scans[0] : undefined;
  const columns = single === undefined ? frame.columns : Math.ceil(single.component.width / 8);
  const rows = single === undefined ? frame.rows : Math.ceil(single.component.height / 8);
  let restart = 0;
  for (let mcu = 0; mcu < columns * rows; mcu++) {
    if (restartInterval !== 0 && mcu > 0 && mcu % restartInterval === 0) {
      entropy.restart(restart);
      restart = (restart + 1) & 7;
      eob.remaining = 0;
      for (const scan of scans) scan.prediction.dc = 0;
    }
    const column = mcu % columns;
    const row = Math.floor(mcu / columns);
    for (const scan of scans) {
      const h = single === undefined ? scan.component.h : 1;
      const v = single === undefined ? scan.component.v : 1;
      for (let y = 0; y < v; y++) {
        for (let x = 0; x < h; x++) scan.decode(((row * v + y) * (scan.component.stride / 8) + column * h + x) * 64);
      }
    }
  }
  entropy.align();
}

// jdcoefct.c decompress_smooth_data, applied only to still-zero low-frequency
// AC values whose bits remain unknown. Neighbors repeat at image edges.
function smoothProgressiveBlock(component: Component, state: Progression, quantizer: Uint16Array, column: number, row: number, coefficients: Int16Array): void {
  const columns = Math.ceil(component.width / 8);
  const rows = Math.ceil(component.height / 8);
  const dc = (x: number, y: number): number => at(state.coefficients,
    (Math.min(rows - 1, Math.max(0, y)) * (component.stride / 8) + Math.min(columns - 1, Math.max(0, x))) * 64);
  const q00 = at(quantizer, 0);
  const center = dc(column, row);
  const above = dc(column, row - 1);
  const below = dc(column, row + 1);
  const left = dc(column - 1, row);
  const right = dc(column + 1, row);
  const numerators = [
    36 * q00 * (left - right),
    36 * q00 * (above - below),
    9 * q00 * (above + below - 2 * center),
    5 * q00 * (dc(column - 1, row - 1) - dc(column + 1, row - 1) - dc(column - 1, row + 1) + dc(column + 1, row + 1)),
    9 * q00 * (left + right - 2 * center),
  ];
  for (let index = 1; index <= 5; index++) {
    const low = at(state.bits, index);
    const natural = at(naturalOrder, index);
    if (low === 0 || at(coefficients, natural) !== 0) continue;
    const quant = at(quantizer, natural);
    const numerator = at(numerators, index - 1);
    let prediction = Math.trunc((quant * 128 + Math.abs(numerator)) / (quant * 256));
    if (low > 0) prediction = Math.min(prediction, (1 << low) - 1);
    coefficients[natural] = numerator < 0 ? -prediction : prediction;
  }
}

function finishBuffered(input: Input, frame: Frame): void {
  const block = new Float32Array(64);
  const workspace = new Float32Array(64);
  const coefficients = new Int16Array(64);
  // jdcoefct.c smoothing_ok checks the first six zigzag quantizers across
  // every component before enabling its division-based prediction pass.
  const smoothingSafe = frame.progressive && frame.components.every(component => {
    const state = component.progression;
    if (state === null || state.table === null || at(state.bits, 0) < 0) return false;
    const quantizer = state.table.quantizer;
    return naturalOrder.slice(0, 6).every(index => at(quantizer, index) !== 0);
  });
  for (const component of frame.components) {
    const state = component.progression;
    if (state === null) input.fail("buffered frame without coefficient storage");
    // jddctmgr.c leaves multiplier tables zero until the component's first
    // scan latches a quantizer. An omitted component produces neutral samples.
    const table = state.table;
    const multipliers = table === null ? new Float32Array(64) : table.multipliers;
    const smoothing = smoothingSafe && state.bits.subarray(1, 6).some(low => low !== 0);
    for (let row = 0; row < Math.ceil(component.height / 8); row++) {
      for (let column = 0; column < Math.ceil(component.width / 8); column++) {
        const offset = (row * (component.stride / 8) + column) * 64;
        coefficients.set(state.coefficients.subarray(offset, offset + 64));
        if (smoothing && table !== null) smoothProgressiveBlock(component, state, table.quantizer, column, row, coefficients);
        for (let index = 0; index < 64; index++) block[index] = at(coefficients, index) * at(multipliers, index);
        writeBlock(input, component, column, row, block, workspace);
      }
    }
  }
}

function sample(component: Component, x: number, y: number, frame: Frame): number {
  if (component.outputSamples !== null) return at(component.outputSamples, y * frame.width + x);
  const h = frame.maxH / component.h;
  const v = frame.maxV / component.v;
  const cx = Math.floor(x / h);
  const cy = Math.floor(y / v);
  const center = at(component.pixels, cy * component.stride + cx);
  if (h !== 2 || component.width <= 2 || (v !== 1 && v !== 2)) return center;
  const neighborX = Math.min(component.width - 1, Math.max(0, cx + (x % 2 === 0 ? -1 : 1)));
  const horizontal = at(component.pixels, cy * component.stride + neighborX);
  if (v === 1) return (center * 3 + horizontal + (x % 2 === 0 ? 1 : 2)) >> 2;
  const neighborY = Math.min(component.height - 1, Math.max(0, cy + (y % 2 === 0 ? -1 : 1)));
  const vertical = at(component.pixels, neighborY * component.stride + cx);
  const diagonal = at(component.pixels, neighborY * component.stride + neighborX);
  return (center * 9 + horizontal * 3 + vertical * 3 + diagonal + (x % 2 === 0 ? 8 : 7)) >> 4;
}

// jdapimin.c default_decompress_parms. Unknown Adobe transforms use the
// component-count-specific YCC fallback; JFIF takes priority for three components.
function selectColorSpace(frame: Frame, adobeTransform: number | undefined, jfif: boolean, warnings: Warnings): ColorSpace {
  if (frame.components.length === 1) return "grayscale";
  if (frame.components.length !== 3 && frame.components.length !== 4) return "unknown";
  if (frame.components.length === 4) {
    if (adobeTransform !== undefined && adobeTransform !== 0 && adobeTransform !== 2) warnings.emit(`Unknown Adobe color transform code ${adobeTransform}`);
    return adobeTransform === undefined || adobeTransform === 0 ? "cmyk" : "ycck";
  }
  if (jfif) return "ycbcr";
  if (adobeTransform !== undefined) {
    if (adobeTransform !== 0 && adobeTransform !== 1) warnings.emit(`Unknown Adobe color transform code ${adobeTransform}`);
    return adobeTransform === 0 ? "rgb" : "ycbcr";
  }
  const red = frame.components[0];
  const green = frame.components[1];
  const blue = frame.components[2];
  return red?.id === 82 && green?.id === 71 && blue?.id === 66 ? "rgb" : "ycbcr";
}

function render(input: Input, frame: Frame, colorSpace: ColorSpace): JpegImage {
  if (frame.components.length === 2) input.fail("two-component LoadJPG alpha writes exceed the source output allocation");
  const first = frame.components[0];
  if (first === undefined) throw new Error("JPEG missing image component");
  const second = frame.components[1];
  const third = frame.components[2];
  const pixels = new Uint8Array(frame.width * frame.height * 4);
  if (colorSpace === "unknown") {
    // null_convert emits N interleaved channels. LoadJPG overwrites alpha
    // in, and the renderer reads, only the first width * height * 4 bytes.
    for (let index = 0; index < pixels.length; index++) {
      const pixel = Math.floor(index / frame.components.length);
      const component = frame.components[index % frame.components.length];
      if (component === undefined) throw new Error("JPEG missing null-conversion component");
      pixels[index] = index % 4 === 3 ? 255 : sample(component, pixel % frame.width, Math.floor(pixel / frame.width), frame);
    }
    return { width: frame.width, height: frame.height, pixels };
  }
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const offset = (y * frame.width + x) * 4;
      const a = sample(first, x, y, frame);
      if (second === undefined || third === undefined) {
        pixels[offset] = a;
        pixels[offset + 1] = a;
        pixels[offset + 2] = a;
      } else {
        const b = sample(second, x, y, frame);
        const c = sample(third, x, y, frame);
        if (colorSpace === "rgb" || colorSpace === "cmyk") {
          pixels[offset] = a;
          pixels[offset + 1] = b;
          pixels[offset + 2] = c;
        } else {
          const red = a + descale(91881 * (c - 128), 16);
          const green = a + descale(-22554 * (b - 128) - 46802 * (c - 128), 16);
          const blue = a + descale(116130 * (b - 128), 16);
          pixels[offset] = clamp(colorSpace === "ycck" ? 255 - red : red);
          pixels[offset + 1] = clamp(colorSpace === "ycck" ? 255 - green : green);
          pixels[offset + 2] = clamp(colorSpace === "ycck" ? 255 - blue : blue);
        }
      }
      // LoadJPG overwrites the fourth output byte, including CMYK's decoded K.
      pixels[offset + 3] = 255;
    }
  }
  return { width: frame.width, height: frame.height, pixels };
}

/** Decode top-to-bottom opaque renderer pixels; CMYK/YCCK retain Quake's CMY channels. */
export function decodeJpeg(bytes: Uint8Array, source: string, print: (text: string) => undefined): JpegImage {
  const input = new Input(bytes, source, new Warnings(print));
  const first = input.byte();
  const second = input.byte();
  if (first !== 255 || second !== 216) input.sourceFail(`Not a JPEG file: starts with 0x${first.toString(16).padStart(2, "0")} 0x${second.toString(16).padStart(2, "0")}`);
  const quantizers = new Map<number, Uint16Array>();
  const huffman = new Map<number, HuffmanTable>();
  let state: { readonly kind: "header"; readonly header: FrameHeader }
    | { readonly kind: "ready"; readonly frame: Frame; readonly colorSpace: ColorSpace; readonly multipleScans: boolean } | undefined;
  let restartInterval = 0;
  let adobeTransform: number | undefined;
  let jfif = false;
  while (true) {
    const marker = input.marker();
    if (marker === 217) {
      if (state === undefined) return input.sourceFail("JPEG datastream contains no image");
      if (state.kind === "header") return input.sourceFail("Invalid JPEG file structure: missing SOS marker");
      const { frame, colorSpace } = state;
      if (state.multipleScans) finishBuffered(input, frame);
      return render(input, frame, colorSpace);
    }
    if (marker === 216) input.sourceFail("Invalid JPEG file structure: two SOI markers");
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if ([195, 197, 198, 199, 200, 203, 205, 206, 207].includes(marker)) input.sourceFail(`Unsupported JPEG process: SOF type 0x${marker.toString(16).padStart(2, "0")}`);
    if (marker === 218 && state === undefined) input.sourceFail("Invalid JPEG file structure: SOS before SOF");
    if (![192, 193, 194, 196, 201, 202, 204, 218, 219, 220, 221, 254].includes(marker)
        && (marker < 224 || marker > 239)) input.sourceFail(`Unsupported marker type 0x${marker.toString(16).padStart(2, "0")}`);
    if (marker === 219) { readQuantizers(input, quantizers); continue; }
    if (marker === 196) { readHuffman(input, huffman); continue; }
    if (marker === 204) { readArithmeticTables(input); continue; }
    if (marker === 192 || marker === 193 || marker === 194 || marker === 201 || marker === 202) {
      state = { kind: "header", header: readFrame(input, marker === 194 || marker === 202, marker === 201 || marker === 202, state !== undefined) };
    }
    else if (marker === 221) {
      if (input.word() !== 4) input.sourceFail("Bogus marker length");
      restartInterval = input.word();
    }
    else if (marker === 218) {
      if (state === undefined) return input.sourceFail("Invalid JPEG file structure: SOS before SOF");
      const scanHeader = readScanHeader(input, state.kind === "header" ? state.header : state.frame);
      if (state.kind === "ready" && !state.multipleScans) input.sourceFail("Didn't expect more than one scan");
      if (state.kind === "header") {
        const multipleScans = state.header.progressive || scanHeader.members.length < state.header.components.length;
        const frame = prepareFrame(input, state.header, multipleScans);
        const colorSpace = selectColorSpace(frame, adobeTransform, jfif, input.warnings);
        for (const component of frame.components) {
          if (frame.maxH % component.h !== 0 || frame.maxV % component.v !== 0) input.sourceFail("Fractional sampling not implemented yet");
        }
        if (state.header.arithmetic) input.sourceFail("Sorry, there are legal restrictions on arithmetic coding");
        state = { kind: "ready", frame, colorSpace, multipleScans };
      }
      const { frame } = state;
      if (frame.progressive) readProgressiveScan(input, scanHeader, frame, quantizers, huffman, restartInterval);
      else readScan(input, scanHeader, frame, quantizers, huffman, restartInterval, state.multipleScans, state.colorSpace);
    } else if (marker === 224) {
      if (readJfif(input)) jfif = true;
    } else if (marker === 238) {
      const transform = readAdobe(input);
      if (transform !== undefined) adobeTransform = transform;
    } else {
      // skip_variable handles COM, other APP markers and DNL (which never
      // replaces SOF dimensions). Negative skip lengths consume nothing.
      input.skip(input.word() - 2);
    }
  }
}
