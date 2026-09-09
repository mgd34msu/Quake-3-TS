// Translated from id Software code/client/snd_mix.c, snd_dma.c and snd_mem.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { AdpcmChunk, decodeAdpcmChunk } from "./adpcm.ts";
import type { SourceWaveletCodec, WaveletSoundChunk } from "./wavelet.ts";

export class SourcePaintChunk extends AdpcmChunk implements WaveletSoundChunk {
  readonly sndChunk: Int16Array;
  override next: SourcePaintChunk | null = null;
  size = 0;

  constructor(data: Uint8Array) {
    super(data);
    this.sndChunk = new Int16Array(data.buffer, data.byteOffset, 1024);
  }
}

export interface SourcePaintSound { soundData: SourcePaintChunk | null }

export interface SourcePaintChannel {
  readonly leftvol: number;
  readonly rightvol: number;
  readonly doppler: boolean;
  readonly dopplerScale: number;
  readonly oldDopplerScale: number;
}

/** ResampleSfx and ResampleSfxRaw share binary32 sizing and the wrapped 8.8 cursor. */
export class SourceSoundResampler {
  readonly count: number;
  private readonly step: number;

  constructor(inputRate: number, outputRate: number, sampleCount: number) {
    const scale = Math.fround(Math.fround(inputRate) / Math.fround(outputRate));
    this.count = Math.trunc(Math.fround(Math.fround(sampleCount) / scale));
    this.step = Math.trunc(Math.fround(scale * 256));
    if (!Number.isInteger(this.count) || this.count < -2147483648 || this.count > 2147483647
      || !Number.isInteger(this.step) || this.step < -2147483648 || this.step > 2147483647) {
      throw new RangeError("Resampled sound has an undefined signed-int conversion");
    }
  }

  sourceIndex(frame: number): number { return Math.imul(frame, this.step) >> 8; }
}

/** ResampleSfxRaw writes the caller's short allocation and returns the source output count. */
export function resampleSoundRaw(output: Int16Array, inputRate: number, outputRate: number,
  width: number, samples: number, data: Uint8Array): number {
  const resampler = new SourceSoundResampler(inputRate, outputRate, samples);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let frame = 0; frame < resampler.count; frame++) {
    const source = resampler.sourceIndex(frame);
    const sample = width === 2 ? view.getInt16(source * 2, true) : (view.getUint8(source) - 128) << 8;
    if (frame >= output.length) throw new RangeError("ResampleSfxRaw output is truncated");
    output[frame] = sample;
  }
  return resampler.count;
}

function value(array: Int32Array | Int16Array | Uint8Array, index: number): number {
  const result = array[index];
  if (result === undefined) throw new RangeError(`Sound paint access outside allocation at ${index}`);
  return result;
}

function chunk(value: SourcePaintChunk | null): SourcePaintChunk {
  if (value === null) throw new RangeError("Sound paint reached a null source chunk");
  return value;
}

function clipped(value: number): number { return Math.max(-32768, Math.min(32767, value >> 8)); }

/** S_WriteLinearBlastStereo16, with the source interleaved integer paint buffer. */
export function writeLinearBlastStereo16(paint: Int32Array, output: Int16Array, count: number): void {
  if (!Number.isInteger(count) || count < 0 || count % 2 !== 0) throw new RangeError("Stereo blast requires an even sample count");
  for (let index = 0; index < count; index += 2) {
    if (index + 1 >= output.length) throw new RangeError("Stereo output allocation is truncated");
    output[index] = clipped(value(paint, index));
    output[index + 1] = clipped(value(paint, index + 1));
  }
}

export type SourceDmaBuffer =
  | { readonly samplebits: 16; readonly channels: 1 | 2; readonly samples: Int16Array }
  | { readonly samplebits: 8; readonly channels: 1 | 2; readonly samples: Uint8Array };

/** S_ByteSwapRawSamples, with the native endianness made explicit. */
export function byteSwapRawSamples(samples: number, width: number, channels: number, data: Uint8Array, littleEndian: boolean): void {
  if (width !== 2 || littleEndian) return;
  if (channels === 2) samples <<= 1;
  for (let index = 0; index < samples; index++) {
    const offset = index * 2;
    const first = value(data, offset), second = value(data, offset + 1);
    data[offset] = second;
    data[offset + 1] = first;
  }
}

/** S_TransferStereo16 and S_TransferPaintBuffer retain circular DMA indexes. */
export function transferPaintBuffer(paint: Int32Array, dma: SourceDmaBuffer, paintedTime: number, endTime: number, testSound = false): void {
  const frames = endTime - paintedTime;
  const capacity = dma.samples.length;
  if (!Number.isInteger(frames) || frames < 0 || !Number.isInteger(paintedTime)
    || capacity < dma.channels || (capacity & (capacity - 1)) !== 0) throw new RangeError("Invalid source DMA paint range or ring capacity");
  if (testSound) {
    for (let index = 0; index < frames; index++) {
      if (index * 2 + 1 >= paint.length) throw new RangeError("Paint allocation is truncated");
      paint[index * 2] = paint[index * 2 + 1] = Math.trunc(Math.sin((paintedTime + index) * 0.1) * 20000 * 256);
    }
  }
  const count = frames * dma.channels;
  const step = 3 - dma.channels;
  let destination = (paintedTime * dma.channels) & (capacity - 1);
  for (let index = 0; index < count; index++) {
    const sample = clipped(value(paint, index * step));
    dma.samples[destination] = dma.samplebits === 16 ? sample : (sample >> 8) + 128;
    destination = (destination + 1) & (capacity - 1);
  }
}

/** Owns snd_mem's shared 4096-short decode scratch and source cache identity. */
export class SourceCompressedPainter {
  private readonly scratch = new Int16Array(4096);
  private scratchSound: SourcePaintSound | null = null;
  private scratchIndex = 0;

  constructor(private readonly codec: SourceWaveletCodec) {}

  private add(paint: Int32Array, index: number, sample: number, channel: SourcePaintChannel, volume: number): void {
    const left = Math.imul(sample, Math.imul(channel.leftvol, volume)) >> 8;
    const right = Math.imul(sample, Math.imul(channel.rightvol, volume)) >> 8;
    paint[index * 2] = (value(paint, index * 2) + left) | 0;
    paint[index * 2 + 1] = (value(paint, index * 2 + 1) + right) | 0;
  }

  paintAdpcm(sound: SourcePaintSound, channel: SourcePaintChannel, paint: Int32Array,
    count: number, sampleOffset: number, bufferOffset: number, volume: number): void {
    let current = chunk(sound.soundData);
    let index = 0;
    if (channel.doppler) sampleOffset = Math.trunc(Math.fround(Math.fround(sampleOffset) * channel.oldDopplerScale));
    while (sampleOffset >= 4096) { current = chunk(current.next); sampleOffset -= 4096; index++; }
    if (index !== this.scratchIndex || this.scratchSound !== sound) {
      decodeAdpcmChunk(current, this.scratch);
      this.scratchIndex = index;
      this.scratchSound = sound;
    }
    for (let index = 0; index < count; index++) {
      this.add(paint, bufferOffset + index, value(this.scratch, sampleOffset++), channel, volume);
      if (sampleOffset === 4096) {
        current = chunk(current.next);
        decodeAdpcmChunk(current, this.scratch);
        sampleOffset = 0;
        this.scratchIndex++;
      }
    }
  }

  paintWavelet(sound: SourcePaintSound, channel: SourcePaintChannel, paint: Int32Array,
    count: number, sampleOffset: number, bufferOffset: number, volume: number): void {
    let current = chunk(sound.soundData);
    let index = 0;
    while (sampleOffset >= 2048) { current = chunk(current.next); sampleOffset -= 2048; index++; }
    if (index !== this.scratchIndex || this.scratchSound !== sound) {
      // The source intentionally calls ADPCM here, then wavelet only at the next boundary.
      decodeAdpcmChunk(current, this.scratch);
      this.scratchIndex = index;
      this.scratchSound = sound;
    }
    for (let index = 0; index < count; index++) {
      this.add(paint, bufferOffset + index, value(this.scratch, sampleOffset++), channel, volume);
      if (sampleOffset === 2048) {
        current = chunk(current.next);
        this.codec.decodeWavelet(current, this.scratch);
        this.scratchIndex++;
        sampleOffset = 0;
      }
    }
  }

  paintMuLaw(sound: SourcePaintSound, channel: SourcePaintChannel, paint: Int32Array,
    count: number, sampleOffset: number, bufferOffset: number, volume: number): void {
    let current = chunk(sound.soundData);
    while (sampleOffset >= 2048) { current = current.next ?? chunk(sound.soundData); sampleOffset -= 2048; }
    if (!channel.doppler) {
      for (let index = 0; index < count; index++) {
        this.add(paint, bufferOffset + index, this.codec.muLawSample(value(current.data, sampleOffset++)), channel, volume);
        if (sampleOffset === 2048) { current = chunk(current.next); sampleOffset = 0; }
      }
    } else {
      let offset = Math.fround(sampleOffset);
      for (let index = 0; index < count; index++) {
        const sample = this.codec.muLawSample(value(current.data, Math.trunc(offset)));
        offset = Math.fround(offset + channel.dopplerScale);
        this.add(paint, bufferOffset + index, sample, channel, volume);
        if (offset >= 2048) { current = current.next ?? chunk(sound.soundData); offset = 0; }
      }
    }
  }
}
