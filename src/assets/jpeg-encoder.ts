/**
 * TypeScript translation of Quake III SaveJPG's configured IJG compressor:
 * jcparam.c, jccolor.c, jcsample.c, jccoefct.c, jcdctmgr.c, jfdctflt.c,
 * jchuff.c and jcmarker.c. Copyright (C) 1991-1995, Thomas G. Lane.
 * See the IJG README license notice. The reference trees remain external.
 */
import type { JpegImage } from "./jpeg.ts";

export type JpegEncodingProfile =
  | { readonly kind: "diagnostic-owned" }
  | { readonly kind: "source-destination"; readonly destination: Uint8Array; readonly rowOrder: "top-down" | "bottom-up" };
interface EncoderImage extends JpegImage { readonly rowOrder: "top-down" | "bottom-up" }

const naturalOrder = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const luminanceQuantizers = [
  16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40,
  26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51,
  56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87,
  95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99,
];
const chrominanceQuantizers = [
  17, 18, 18, 24, 21, 24, 47, 26, 26, 47, 99, 66, 56, 66, 99, 99,
  ...new Array<number>(48).fill(99),
];

interface HuffmanTable {
  readonly counts: readonly number[];
  readonly values: readonly number[];
}
const dcLuminance: HuffmanTable = {
  counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const dcChrominance: HuffmanTable = {
  counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  values: dcLuminance.values,
};
const acLuminance: HuffmanTable = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125],
  values: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
    0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
    0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};
const acChrominance: HuffmanTable = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119],
  values: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
    0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
    0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
    0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
    0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};

function at(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`JPEG encoder index ${index}`);
  return value;
}

interface HuffmanCode { readonly value: number; readonly size: number }
function deriveCodes(table: HuffmanTable): ReadonlyMap<number, HuffmanCode> {
  const result = new Map<number, HuffmanCode>();
  let code = 0;
  let index = 0;
  for (const [length, count] of table.counts.entries()) {
    for (let entry = 0; entry < count; entry++) result.set(at(table.values, index++), { value: code++, size: length + 1 });
    code *= 2;
  }
  return result;
}
const luminanceCodes = { dc: deriveCodes(dcLuminance), ac: deriveCodes(acLuminance) };
const chrominanceCodes = { dc: deriveCodes(dcChrominance), ac: deriveCodes(acChrominance) };

class Output {
  private bytes: Uint8Array;
  private length = 0;
  private pending = 0;
  private pendingBits = 0;
  constructor(private readonly profile: JpegEncodingProfile) {
    this.bytes = profile.kind === "source-destination" ? profile.destination : new Uint8Array(4096);
  }
  byte(value: number): void {
    if (this.length === this.bytes.length) {
      if (this.profile.kind === "source-destination") throw new RangeError("SaveJPG destination capacity exceeded; source buffer exhaustion is unsupported");
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = value;
  }
  marker(marker: number, payload: readonly number[]): void {
    this.byte(255); this.byte(marker);
    this.byte((payload.length + 2) >> 8); this.byte((payload.length + 2) & 255);
    for (const value of payload) this.byte(value);
  }
  bits(value: number, size: number): void {
    this.pending = this.pending * 2 ** size + (value & (2 ** size - 1));
    this.pendingBits += size;
    while (this.pendingBits >= 8) {
      this.pendingBits -= 8;
      const byte = (this.pending >> this.pendingBits) & 255;
      this.byte(byte);
      if (byte === 255) this.byte(0);
    }
    this.pending &= 2 ** this.pendingBits - 1;
  }
  symbol(table: ReadonlyMap<number, HuffmanCode>, symbol: number): void {
    const code = table.get(symbol);
    if (code === undefined) throw new RangeError(`JPEG encoder Huffman symbol ${symbol}`);
    this.bits(code.value, code.size);
  }
  finish(): Uint8Array {
    // jchuff.c flush_bits emits seven ones, then discards the remaining bits.
    this.bits(127, 7);
    this.byte(255); this.byte(217);
    return this.profile.kind === "source-destination" ? this.bytes.subarray(0, this.length) : this.bytes.slice(0, this.length);
  }
}

function quantizers(base: readonly number[], quality: number): Uint8Array {
  const bounded = Math.max(1, Math.min(100, quality));
  const scale = bounded < 50 ? Math.floor(5000 / bounded) : 200 - bounded * 2;
  return Uint8Array.from(base, value => Math.max(1, Math.min(255, Math.floor((value * scale + 50) / 100))));
}

// jcdctmgr.c start_pass evaluates the reciprocal in double, then stores float.
function divisors(table: Uint8Array): Float32Array {
  const scales = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.541196100, 0.275899379];
  const result = new Float32Array(64);
  for (const [zigzag, natural] of naturalOrder.entries()) {
    result[natural] = 1 / (at(table, zigzag) * at(scales, Math.floor(natural / 8)) * at(scales, natural % 8) * 8);
  }
  return result;
}

// jfdctflt.c, with binary32 expressions and storage, without contraction.
function forwardPass(data: Float32Array, start: number, step: number): void {
  const f = Math.fround;
  const tmp0 = f(at(data, start) + at(data, start + step * 7));
  const tmp7 = f(at(data, start) - at(data, start + step * 7));
  const tmp1 = f(at(data, start + step) + at(data, start + step * 6));
  const tmp6 = f(at(data, start + step) - at(data, start + step * 6));
  const tmp2 = f(at(data, start + step * 2) + at(data, start + step * 5));
  const tmp5 = f(at(data, start + step * 2) - at(data, start + step * 5));
  const tmp3 = f(at(data, start + step * 3) + at(data, start + step * 4));
  const tmp4 = f(at(data, start + step * 3) - at(data, start + step * 4));
  const even10 = f(tmp0 + tmp3);
  const even13 = f(tmp0 - tmp3);
  const even11 = f(tmp1 + tmp2);
  const even12 = f(tmp1 - tmp2);
  data[start] = even10 + even11;
  data[start + step * 4] = even10 - even11;
  const z1 = f(f(even12 + even13) * f(0.707106781));
  data[start + step * 2] = even13 + z1;
  data[start + step * 6] = even13 - z1;
  const odd10 = f(tmp4 + tmp5);
  const odd11 = f(tmp5 + tmp6);
  const odd12 = f(tmp6 + tmp7);
  const z5 = f(f(odd10 - odd12) * f(0.382683433));
  const z2 = f(f(f(0.541196100) * odd10) + z5);
  const z4 = f(f(f(1.306562965) * odd12) + z5);
  const z3 = f(odd11 * f(0.707106781));
  const z11 = f(tmp7 + z3);
  const z13 = f(tmp7 - z3);
  data[start + step * 5] = z13 + z2;
  data[start + step * 3] = z13 - z2;
  data[start + step] = z11 + z4;
  data[start + step * 7] = z11 - z4;
}

interface Component {
  readonly sampling: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly samples: Uint8Array;
  readonly divisors: Float32Array;
  readonly codes: typeof luminanceCodes;
  dc: number;
}

function component(width: number, height: number, sampling: number, table: Uint8Array): Component {
  const stride = Math.ceil(width / 8) * 8;
  return { sampling, width, height, stride, samples: new Uint8Array(stride * sampling * 8),
    divisors: divisors(table), codes: sampling === 2 ? luminanceCodes : chrominanceCodes, dc: 0 };
}

// jccolor.c rgb_ycc_start/rgb_ycc_convert, including chroma's half-minus-one.
function color(image: EncoderImage, x: number, y: number, channel: number): number {
  const row = image.rowOrder === "bottom-up" ? image.height - 1 - y : y;
  const offset = (row * image.width + x) * 4;
  const r = at(image.pixels, offset), g = at(image.pixels, offset + 1), b = at(image.pixels, offset + 2);
  if (channel === 0) return (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
  if (channel === 1) return (-11059 * r - 21709 * g + 32768 * b + 8421375) >> 16;
  return (32768 * r - 27439 * g - 5329 * b + 8421375) >> 16;
}

// jcprepct.c pads the converted row pair before downsampling, then repeats
// the last downsampled row. jcsample.c alternates chroma rounding bias 1,2.
function fillStrip(image: EncoderImage, component: Component, channel: number, mcuRow: number): void {
  for (let row = 0; row < component.sampling * 8; row++) {
    const y = Math.min(component.height - 1, mcuRow * component.sampling * 8 + row);
    for (let column = 0; column < component.stride; column++) {
      const x = Math.min(component.width - 1, column);
      if (channel === 0) component.samples[row * component.stride + column] = color(image, x, y, 0);
      else {
        const x0 = Math.min(image.width - 1, column * 2), x1 = Math.min(image.width - 1, x0 + 1);
        const y0 = y * 2, y1 = Math.min(image.height - 1, y0 + 1);
        const sum = color(image, x0, y0, channel) + color(image, x1, y0, channel)
          + color(image, x0, y1, channel) + color(image, x1, y1, channel);
        component.samples[row * component.stride + column] = (sum + 1 + column % 2) >> 2;
      }
    }
  }
}

function transform(component: Component, column: number, row: number, block: Int16Array, workspace: Float32Array): void {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) workspace[y * 8 + x] = at(component.samples, (row * 8 + y) * component.stride + column * 8 + x) - 128;
  }
  for (let row = 0; row < 8; row++) forwardPass(workspace, row * 8, 1);
  for (let column = 0; column < 8; column++) forwardPass(workspace, column, 8);
  for (let index = 0; index < 64; index++) {
    const scaled = Math.fround(at(workspace, index) * at(component.divisors, index));
    block[index] = Math.trunc(Math.fround(scaled + 16384.5)) - 16384;
  }
}

function category(value: number): number { return value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value))) + 1; }
function writeBlock(output: Output, component: Component, block: Int16Array): void {
  const dc = at(block, 0);
  const difference = dc - component.dc;
  const size = category(difference);
  output.symbol(component.codes.dc, size);
  if (size > 0) output.bits(difference < 0 ? difference - 1 : difference, size);
  component.dc = dc;
  let zeroes = 0;
  for (let index = 1; index < 64; index++) {
    const value = at(block, at(naturalOrder, index));
    if (value === 0) zeroes++;
    else {
      while (zeroes > 15) { output.symbol(component.codes.ac, 240); zeroes -= 16; }
      const size = category(value);
      output.symbol(component.codes.ac, zeroes * 16 + size);
      output.bits(value < 0 ? value - 1 : value, size);
      zeroes = 0;
    }
  }
  if (zeroes > 0) output.symbol(component.codes.ac, 0);
}

/** Diagnostic calls own a growing output. Source calls borrow the fixed SaveJPG
 * destination and return a view valid only until that allocation is released.
 */
export function encodeJpeg(image: JpegImage, quality = 95, profile: JpegEncodingProfile = { kind: "diagnostic-owned" }): Uint8Array {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width > 65500 || image.height > 65500)
    throw new RangeError("JPEG encoder dimensions must be integers in 1..65500");
  if (image.pixels.length !== image.width * image.height * 4) throw new RangeError("JPEG encoder requires tightly packed RGBA pixels");
  if (!Number.isInteger(quality)) throw new RangeError("JPEG encoder quality must be an integer");
  if (profile.kind === "source-destination" && profile.destination.length !== image.width * image.height * 4)
    throw new RangeError("SaveJPG destination requires exactly width*height*4 bytes");
  const input: EncoderImage = { ...image, rowOrder: profile.kind === "source-destination" ? profile.rowOrder : "top-down" };
  const yQuantizers = quantizers(luminanceQuantizers, quality);
  const cQuantizers = quantizers(chrominanceQuantizers, quality);
  const output = new Output(profile);
  output.byte(255); output.byte(216);
  output.marker(224, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  output.marker(219, [0, ...yQuantizers]); output.marker(219, [1, ...cQuantizers]);
  output.marker(192, [8, image.height >> 8, image.height & 255, image.width >> 8, image.width & 255,
    3, 1, 34, 0, 2, 17, 1, 3, 17, 1]);
  for (const [selector, table] of [[0, dcLuminance], [16, acLuminance], [1, dcChrominance], [17, acChrominance]] satisfies [number, HuffmanTable][]) {
    output.marker(196, [selector, ...table.counts, ...table.values]);
  }
  output.marker(218, [3, 1, 0, 2, 17, 3, 17, 0, 63, 0]);
  const chromaWidth = Math.ceil(image.width / 2), chromaHeight = Math.ceil(image.height / 2);
  const components = [component(image.width, image.height, 2, yQuantizers),
    component(chromaWidth, chromaHeight, 1, cQuantizers), component(chromaWidth, chromaHeight, 1, cQuantizers)];
  const block = new Int16Array(64);
  const workspace = new Float32Array(64);
  for (let mcuRow = 0; mcuRow < Math.ceil(image.height / 16); mcuRow++) {
    for (const [channel, component] of components.entries()) fillStrip(input, component, channel, mcuRow);
    for (let mcuColumn = 0; mcuColumn < Math.ceil(image.width / 16); mcuColumn++) {
      for (const component of components) {
        for (let row = 0; row < component.sampling; row++) {
          for (let column = 0; column < component.sampling; column++) {
            const blockColumn = mcuColumn * component.sampling + column;
            const blockRow = mcuRow * component.sampling + row;
            if (blockColumn >= Math.ceil(component.width / 8) || blockRow >= Math.ceil(component.height / 8)) {
              // jccoefct.c dummy right/bottom blocks retain the preceding DC.
              block.fill(0); block[0] = component.dc;
            } else transform(component, blockColumn, row, block, workspace);
            writeBlock(output, component, block);
          }
        }
      }
    }
  }
  return output.finish();
}
