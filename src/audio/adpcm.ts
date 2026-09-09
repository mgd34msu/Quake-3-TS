/*
 * Translated from Quake III Arena code/client/snd_adpcm.c and snd_local.h.
 * Intel/DVI ADPCM, version 1.2, 18-Dec-92, from the IMA Compatibility
 * Project proceedings, Vol 2, Number 2, May 1992.
 *
 * Copyright 1992 by Stichting Mathematisch Centrum, Amsterdam, The
 * Netherlands.
 *
 *                         All Rights Reserved
 *
 * Permission to use, copy, modify, and distribute this software and its
 * documentation for any purpose and without fee is hereby granted,
 * provided that the above copyright notice appear in all copies and that
 * both that copyright notice and this permission notice appear in
 * supporting documentation, and that the names of Stichting Mathematisch
 * Centrum or CWI not be used in advertising or publicity pertaining to
 * distribution of the software without specific, written prior permission.
 *
 * STICHTING MATHEMATISCH CENTRUM DISCLAIMS ALL WARRANTIES WITH REGARD TO
 * THIS SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS, IN NO EVENT SHALL STICHTING MATHEMATISCH CENTRUM BE LIABLE
 * FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
 * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

const INDEX_TABLE: readonly number[] = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
];

const STEP_SIZE_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

export const ADPCM_CHUNK_BYTES = 2048;
export const ADPCM_CHUNK_SAMPLES = 4096;

export interface AdpcmState {
  sample: number;
  index: number;
}

/** sndBuffer's ADPCM fields. The allocator owns the supplied storage. */
export class AdpcmChunk {
  readonly adpcm: AdpcmState = { sample: 0, index: 0 };
  next: AdpcmChunk | null = null;

  constructor(readonly data: Uint8Array) {
    if (data.length !== ADPCM_CHUNK_BYTES) {
      throw new RangeError("ADPCM chunk storage must contain 2048 bytes");
    }
  }
}

export interface AdpcmSound {
  soundData: AdpcmChunk | null;
}

function requireState(state: AdpcmState): void {
  if (!Number.isInteger(state.sample) || state.sample < -32768 || state.sample > 32767) {
    throw new RangeError("ADPCM predictor must be a signed 16-bit sample");
  }
  if (!Number.isInteger(state.index) || state.index < 0 || state.index > 88) {
    throw new RangeError("ADPCM step index must be between 0 and 88");
  }
}

function tableValue(table: readonly number[], index: number): number {
  const value = table[index];
  if (value === undefined) throw new RangeError("ADPCM table index out of range");
  return value;
}

/** S_AdpcmEncode: each call starts at the high nibble; an odd tail writes zero below it. */
export function encodeAdpcm(samples: Int16Array, output: Uint8Array, state: AdpcmState): void {
  requireState(state);
  if (output.length < Math.ceil(samples.length / 2)) {
    throw new RangeError("ADPCM output is too short");
  }
  let predicted = state.sample;
  let index = state.index;
  let step = tableValue(STEP_SIZE_TABLE, index);
  let outputBuffer = 0;
  let highNibble = true;
  let outputOffset = 0;

  for (const sample of samples) {
    let difference = sample - predicted;
    const sign = difference < 0 ? 8 : 0;
    if (sign !== 0) difference = -difference;
    let delta = 0;
    let predictedDifference = step >> 3;
    if (difference >= step) {
      delta = 4;
      difference -= step;
      predictedDifference += step;
    }
    step >>= 1;
    if (difference >= step) {
      delta |= 2;
      difference -= step;
      predictedDifference += step;
    }
    step >>= 1;
    if (difference >= step) {
      delta |= 1;
      predictedDifference += step;
    }
    predicted += sign !== 0 ? -predictedDifference : predictedDifference;
    predicted = Math.max(-32768, Math.min(32767, predicted));
    delta |= sign;
    index = Math.max(0, Math.min(88, index + tableValue(INDEX_TABLE, delta)));
    step = tableValue(STEP_SIZE_TABLE, index);
    if (highNibble) {
      outputBuffer = (delta << 4) & 0xf0;
    } else {
      output[outputOffset++] = (delta & 0x0f) | outputBuffer;
    }
    highNibble = !highNibble;
  }
  if (!highNibble) output[outputOffset] = outputBuffer;
  state.sample = predicted;
  state.index = index;
}

/** S_AdpcmDecode: output length is the sample count, independent of byte padding. */
export function decodeAdpcm(input: Uint8Array, output: Int16Array, state: AdpcmState): void {
  requireState(state);
  if (input.length < Math.ceil(output.length / 2)) {
    throw new RangeError("ADPCM input is truncated");
  }
  const bytes = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let predicted = state.sample;
  let index = state.index;
  let step = tableValue(STEP_SIZE_TABLE, index);
  let inputBuffer = 0;
  for (let offset = 0; offset < output.length; offset++) {
    const highNibble = (offset & 1) === 0;
    if (highNibble) inputBuffer = bytes.getUint8(offset >> 1);
    const code = highNibble ? (inputBuffer >> 4) & 0xf : inputBuffer & 0xf;
    index = Math.max(0, Math.min(88, index + tableValue(INDEX_TABLE, code)));
    const sign = code & 8;
    const delta = code & 7;
    let predictedDifference = step >> 3;
    if ((delta & 4) !== 0) predictedDifference += step;
    if ((delta & 2) !== 0) predictedDifference += step >> 1;
    if ((delta & 1) !== 0) predictedDifference += step >> 2;
    predicted += sign !== 0 ? -predictedDifference : predictedDifference;
    predicted = Math.max(-32768, Math.min(32767, predicted));
    step = tableValue(STEP_SIZE_TABLE, index);
    output[offset] = predicted;
  }
  state.sample = predicted;
  state.index = index;
}

/** S_AdpcmGetSamples decodes the full allocation without advancing its saved header. */
export function decodeAdpcmChunk(chunk: AdpcmChunk, output: Int16Array): void {
  if (output.length < ADPCM_CHUNK_SAMPLES) {
    throw new RangeError("ADPCM chunk output needs 4096 samples");
  }
  const state: AdpcmState = { sample: chunk.adpcm.sample, index: chunk.adpcm.index };
  decodeAdpcm(chunk.data, output.subarray(0, ADPCM_CHUNK_SAMPLES), state);
}

/** S_AdpcmEncodeSound after S_LoadSound clears soundData and resamples to mono PCM. */
export function encodeAdpcmSound(
  samples: Int16Array,
  sound: AdpcmSound,
  allocateChunk: () => AdpcmChunk,
): void {
  const firstSample = samples[0];
  if (firstSample === undefined) {
    throw new RangeError("S_AdpcmEncodeSound requires its initial sample");
  }
  if (sound.soundData !== null) throw new Error("ADPCM soundData must be cleared before encoding");
  const state: AdpcmState = { sample: firstSample, index: 0 };
  let previous: AdpcmChunk | null = null;
  for (let offset = 0; offset < samples.length; offset += ADPCM_CHUNK_SAMPLES) {
    const chunk = allocateChunk();
    chunk.next = null;
    if (previous === null) sound.soundData = chunk;
    else previous.next = chunk;
    previous = chunk;
    chunk.adpcm.sample = state.sample;
    chunk.adpcm.index = state.index;
    encodeAdpcm(samples.subarray(offset, offset + ADPCM_CHUNK_SAMPLES), chunk.data, state);
  }
}

/** S_AdpcmMemoryNeeded counts 4-byte C state headers, not sndBuffer allocation overhead. */
export function adpcmMemoryNeeded(sampleCount: number, inputRate: number, outputRate: number): number {
  for (const value of [sampleCount, inputRate, outputRate]) {
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
      throw new RangeError("ADPCM memory inputs must be nonnegative signed 32-bit integers");
    }
  }
  if (inputRate === 0 || outputRate === 0) throw new RangeError("ADPCM sample rates must be positive");
  const scale = Math.fround(Math.fround(inputRate) / Math.fround(outputRate));
  const scaledSampleCount = Math.trunc(Math.fround(Math.fround(sampleCount) / scale));
  if (scaledSampleCount > 0x7fffffff) throw new RangeError("ADPCM scaled sample count exceeds signed 32-bit range");
  const sampleMemory = Math.trunc(scaledSampleCount / 2);
  const blockCount = Math.ceil(scaledSampleCount / ADPCM_CHUNK_SAMPLES);
  return sampleMemory + blockCount * 4;
}
