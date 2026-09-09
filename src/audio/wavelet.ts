/*
 * Translated from id Software's code/client/snd_wavelet.c and snd_local.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const C0 = 0.4829629131445341;
const C1 = 0.8365163037378079;
const C2 = 0.2241438680420134;
const C3 = -0.1294095225512604;
const CHUNK_SAMPLES = 1024;
const CHUNK_BYTES = CHUNK_SAMPLES * 2;

export interface WaveletSoundChunk {
  readonly sndChunk: Int16Array;
  next: WaveletSoundChunk | null;
  size: number;
}

export interface WaveletSound {
  readonly soundLength: number;
  soundData: WaveletSoundChunk | null;
}

function read(values: Float32Array | Int16Array | Uint8Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`sound codec read outside allocation at ${index}`);
  return value;
}

function integer(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} outside ${minimum}..${maximum}`);
  }
}

function transformInput(samples: Float32Array, size: number, sign: number): void {
  integer(size, 0, Math.min(samples.length, 4096), "wavelet size");
  integer(sign, -2147483648, 2147483647, "wavelet sign");
}

/** daub4 stores each double-coefficient expression into binary32 scratch. */
export function daub4(samples: Float32Array, size: number, sign: number): void {
  transformInput(samples, size, sign);
  if (size < 4) return;
  if (size % 2 !== 0) throw new RangeError("odd daub4 size reads uninitialized source scratch");
  const scratch = new Float32Array(size);
  const half = size >> 1;
  if (sign >= 0) {
    let i = 0;
    for (let j = 0; j <= size - 4; j += 2, i++) {
      scratch[i] = C0 * read(samples, j) + C1 * read(samples, j + 1)
        + C2 * read(samples, j + 2) + C3 * read(samples, j + 3);
      scratch[i + half] = C3 * read(samples, j) - C2 * read(samples, j + 1)
        + C1 * read(samples, j + 2) - C0 * read(samples, j + 3);
    }
    scratch[i] = C0 * read(samples, size - 2) + C1 * read(samples, size - 1)
      + C2 * read(samples, 0) + C3 * read(samples, 1);
    scratch[i + half] = C3 * read(samples, size - 2) - C2 * read(samples, size - 1)
      + C1 * read(samples, 0) - C0 * read(samples, 1);
  } else {
    scratch[0] = C2 * read(samples, half - 1) + C1 * read(samples, size - 1)
      + C0 * read(samples, 0) + C3 * read(samples, half);
    scratch[1] = C3 * read(samples, half - 1) - C0 * read(samples, size - 1)
      + C1 * read(samples, 0) - C2 * read(samples, half);
    for (let i = 0, j = 2; i < half - 1; i++) {
      scratch[j++] = C2 * read(samples, i) + C1 * read(samples, i + half)
        + C0 * read(samples, i + 1) + C3 * read(samples, i + half + 1);
      scratch[j++] = C3 * read(samples, i) - C0 * read(samples, i + half)
        + C1 * read(samples, i + 1) - C2 * read(samples, i + half + 1);
    }
  }
  samples.set(scratch);
}

/** wt1 deliberately uses n/4, including its non-power-of-two stage lengths. */
export function wt1(samples: Float32Array, size: number, sign: number): void {
  transformInput(samples, size, sign);
  const inverseStartLength = Math.trunc(size / 4);
  if (inverseStartLength === 0) throw new RangeError("wavelet size below four does not terminate in source");
  if (sign >= 0) {
    for (let length = size; length >= inverseStartLength; length >>= 1) daub4(samples, length, sign);
  } else {
    for (let length = inverseStartLength; length <= size; length <<= 1) daub4(samples, length, sign);
  }
}

export function muLawEncode(sample: number): number {
  integer(sample, -32768, 32767, "mu-law sample");
  const sign = sample < 0 ? 0 : 0x80;
  // The source's two's-complement short narrowing at -32768 also saturates here.
  const adjusted = Math.min(Math.abs(sample) + 132, 32767);
  const exponent = 31 - Math.clz32((adjusted >> 7) & 0xff);
  const mantissa = (adjusted >> (exponent + 3)) & 0xf;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function muLawDecode(value: number): number {
  integer(value, 0, 255, "mu-law byte");
  const law = (~value) & 0xff;
  const exponent = (law >> 4) & 0x7;
  const mantissa = (law & 0xf) + 16;
  const adjusted = (mantissa << (exponent + 3)) - 132;
  return (law & 0x80) !== 0 ? adjusted : -adjusted;
}

function bytes(chunk: WaveletSoundChunk): Uint8Array {
  if (chunk.sndChunk.length !== CHUNK_SAMPLES) throw new RangeError("sound chunk must contain 1024 shorts");
  return new Uint8Array(chunk.sndChunk.buffer, chunk.sndChunk.byteOffset, CHUNK_BYTES);
}

function outputSample(destination: Int16Array, index: number, sample: number): void {
  if (index >= destination.length) throw new RangeError("sound codec destination is truncated");
  const truncated = Math.trunc(sample);
  integer(truncated, -32768, 32767, "decoded wavelet short");
  destination[index] = truncated;
}

/** Owns the original lazy mulawToShort table. The allocator owns chunk storage. */
export class SourceWaveletCodec {
  private readonly mulawToShort = new Int16Array(256);
  private madeTable = false;
  private streamCount = 0;

  /** SND_malloc must return exclusive storage with next cleared and other bytes retained. */
  constructor(private readonly allocateChunk: () => WaveletSoundChunk) {}

  /** NXPutc shares its cursor across streams for the codec's lifetime. */
  nxPutc(stream: Uint8Array, output: number): void {
    integer(output, -128, 255, "stream character");
    const offset = this.streamCount++;
    if (offset >= stream.length) throw new RangeError("NXPutc writes outside stream allocation");
    stream[offset] = output;
  }

  private makeTable(): void {
    if (this.madeTable) return;
    for (let i = 0; i < 256; i++) this.mulawToShort[i] = muLawDecode(i);
    this.madeTable = true;
  }

  /** Reads the owned table, including its initial all-zero state. */
  muLawSample(value: number): number {
    integer(value, 0, 255, "mu-law byte");
    return read(this.mulawToShort, value);
  }

  private append(sound: WaveletSound, previous: WaveletSoundChunk | null): WaveletSoundChunk {
    const chunk = this.allocateChunk();
    if (sound.soundData === null) sound.soundData = chunk;
    else {
      if (previous === null) throw new Error("source soundData must be null before compression");
      previous.next = chunk;
    }
    return chunk;
  }

  encodeWavelet(sound: WaveletSound, packets: Int16Array): void {
    this.makeTable();
    integer(sound.soundLength, 0, 2147483647, "sound length");
    let previous: WaveletSoundChunk | null = null;
    let offset = 0;
    let remaining = sound.soundLength;
    while (remaining > 0) {
      const size = Math.max(4, Math.min(remaining, CHUNK_BYTES));
      const chunk = this.append(sound, previous);
      previous = chunk;
      const scratch = new Float32Array(size);
      for (let i = 0; i < size; i++) scratch[i] = read(packets, offset++);
      wt1(scratch, size, 1);
      const output = bytes(chunk);
      for (let i = 0; i < size; i++) {
        const sample = Math.max(-32768, Math.min(32767, read(scratch, i)));
        output[i] = muLawEncode(Math.trunc(sample));
      }
      chunk.size = size;
      remaining -= size;
    }
  }

  decodeWavelet(chunk: WaveletSoundChunk, destination: Int16Array | null): void {
    const size = chunk.size;
    integer(size, 0, CHUNK_BYTES, "wavelet chunk size");
    const input = bytes(chunk);
    const scratch = new Float32Array(size);
    for (let i = 0; i < size; i++) scratch[i] = this.muLawSample(read(input, i));
    wt1(scratch, size, -1);
    if (destination === null) return;
    for (let i = 0; i < size; i++) outputSample(destination, i, read(scratch, i));
  }

  encodeMuLaw(sound: WaveletSound, packets: Int16Array): void {
    this.makeTable();
    integer(sound.soundLength, 0, 2147483647, "sound length");
    let previous: WaveletSoundChunk | null = null;
    let offset = 0;
    let remaining = sound.soundLength;
    let grade = 0;
    while (remaining > 0) {
      const size = Math.min(remaining, CHUNK_BYTES);
      const chunk = this.append(sound, previous);
      previous = chunk;
      const output = bytes(chunk);
      for (let i = 0; i < size; i++) {
        const sample = Math.max(-32768, Math.min(32767, read(packets, offset) + grade));
        const encoded = muLawEncode(sample);
        output[i] = encoded;
        grade = sample - this.muLawSample(encoded);
        offset++;
      }
      chunk.size = size;
      remaining -= size;
    }
  }

  decodeMuLaw(chunk: WaveletSoundChunk, destination: Int16Array): void {
    const size = chunk.size;
    integer(size, 0, CHUNK_BYTES, "mu-law chunk size");
    const input = bytes(chunk);
    for (let i = 0; i < size; i++) outputSample(destination, i, this.muLawSample(read(input, i)));
  }
}
