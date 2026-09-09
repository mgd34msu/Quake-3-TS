// Ported from id Software's code/client/snd_mem.c GetWavinfo and ResampleSfx.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError, BinaryReader } from "../core/binary.ts";

export interface PcmSound {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly samples: Int16Array;
  readonly frameCount: number;
  readonly loopStart: number | null;
}

export interface DecodedWav extends PcmSound {
  readonly sourceBytesPerSample: 1 | 2;
}

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly sourceBytesPerSample: number;
  readonly frameCount: number;
  /** Reads the reached ResampleSfx index from the borrowed file allocation. */
  sample(index: number): number;
  /** Standalone banks materialize mono PCM while the file allocation is live. */
  decode(): PcmSound;
}

interface WavFormat {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly bytesPerSample: 1 | 2;
  readonly blockAlign: number;
}

interface ChunkRange {
  readonly offset: number;
  readonly length: number;
}

function reject(source: string, offset: number, message: string): never {
  throw new BinaryError(source, offset, message);
}

function fourCc(reader: BinaryReader): string {
  return String.fromCharCode(reader.u8(), reader.u8(), reader.u8(), reader.u8());
}

function expectFourCc(reader: BinaryReader, expected: string): void {
  const offset = reader.offset;
  const actual = fourCc(reader);
  if (actual !== expected) reject(reader.source, offset, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function matchesFourCc(reader: BinaryReader, offset: number, expected: string): boolean {
  reader.seek(offset);
  for (let index = 0; index < 4; index++) {
    if (reader.u8() !== expected.charCodeAt(index)) return false;
  }
  return true;
}

// FindChunk resets last_chunk for each search. FindNextChunk checks only the
// next header's start against iff_end; payload reads use the actual allocation.
function findChunk(reader: BinaryReader, start: number, length: number, name: string): ChunkRange | null {
  let offset = start;
  while (offset < length) {
    if (offset + 8 > reader.length) reject(reader.source, offset + 4, "truncated WAV chunk header");
    reader.seek(offset + 4);
    const chunkLength = reader.i32();
    if (chunkLength < 0) return null;
    if (chunkLength === 0x7fffffff) reject(reader.source, offset + 4, "WAV chunk alignment overflows a signed int");
    if (matchesFourCc(reader, offset, name)) return { offset: offset + 8, length: chunkLength };
    offset += 8 + ((chunkLength + 1) & ~1);
  }
  return null;
}

function pcmSample(reader: BinaryReader, dataOffset: number, bytesPerSample: number, index: number): number {
  if (!Number.isSafeInteger(index)) reject(reader.source, dataOffset, "WAV sample index must be an integer");
  reader.seek(dataOffset + index * (bytesPerSample === 2 ? 2 : 1));
  return bytesPerSample === 2 ? reader.i16() : (reader.u8() - 128) << 8;
}

function pcmSamples(reader: BinaryReader, dataOffset: number, bytesPerSample: number, sampleCount: number): Int16Array {
  if (sampleCount < 0) reject(reader.source, dataOffset, "negative WAV sample allocation");
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) samples[index] = pcmSample(reader, dataOffset, bytesPerSample, index);
  return samples;
}

/** GetWavinfo returns zero or partial fields after its ordinary diagnostics. */
export function readWavInfo(bytes: Uint8Array, length: number, source: string, print: (text: string) => undefined): WavInfo {
  const reader = new BinaryReader(bytes, source);
  if (!Number.isSafeInteger(length) || length < 0 || length > reader.length) {
    reject(source, 0, `WAV file length ${length} exceeds its physical allocation`);
  }
  let sampleRate = 0, channels = 0, sourceBytesPerSample = 0, frameCount = 0, dataOffset = 0;
  const info = (): WavInfo => ({
    sampleRate, channels, sourceBytesPerSample, frameCount,
    sample: index => pcmSample(reader, dataOffset, sourceBytesPerSample, index),
    decode(): PcmSound {
      if (channels !== 1) reject(source, dataOffset, "source WAV sound decoding requires mono channels");
      const samples = pcmSamples(reader, dataOffset, sourceBytesPerSample, frameCount);
      return { sampleRate, channels, frameCount, samples, loopStart: null };
    },
  });
  const riff = findChunk(reader, 0, length, "RIFF");
  if (riff === null || !matchesFourCc(reader, riff.offset, "WAVE")) {
    print("Missing RIFF/WAVE chunks\n");
    return info();
  }
  const chunkStart = riff.offset + 4;
  const format = findChunk(reader, chunkStart, length, "fmt ");
  if (format === null) {
    print("Missing fmt chunk\n");
    return info();
  }
  reader.seek(format.offset);
  const encoding = reader.i16();
  channels = reader.i16();
  sampleRate = reader.i32();
  reader.skip(6);
  sourceBytesPerSample = Math.trunc(reader.i16() / 8) | 0;
  if (encoding !== 1) {
    print("Microsoft PCM format only\n");
    return info();
  }
  const data = findChunk(reader, chunkStart, length, "data");
  if (data === null) {
    print("Missing data chunk\n");
    return info();
  }
  if (sourceBytesPerSample === 0) reject(source, data.offset - 4, "WAV sample count divides by zero source width");
  frameCount = Math.trunc(data.length / sourceBytesPerSample) | 0;
  dataOffset = data.offset;
  return info();
}

function parseFormat(reader: BinaryReader, source: string, chunkOffset: number): WavFormat {
  if (reader.length < 16) reject(source, chunkOffset, `fmt chunk is ${reader.length} bytes, expected at least 16`);
  const encoding = reader.u16();
  if (encoding !== 1) reject(source, chunkOffset, `unsupported WAV encoding ${encoding}; only PCM is supported`);

  const channels = reader.u16();
  if (channels !== 1 && channels !== 2) reject(source, chunkOffset + 2, `unsupported WAV channel count ${channels}`);
  const sampleRate = reader.u32();
  if (sampleRate === 0) reject(source, chunkOffset + 4, "WAV sample rate must be positive");
  const byteRate = reader.u32();
  const blockAlign = reader.u16();
  const bitsPerSample = reader.u16();
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    reject(source, chunkOffset + 14, `unsupported WAV sample width ${bitsPerSample} bits`);
  }
  const bytesPerSample = bitsPerSample === 8 ? 1 : 2;
  const expectedBlockAlign = channels * bytesPerSample;
  if (blockAlign !== expectedBlockAlign) {
    reject(source, chunkOffset + 12, `WAV block alignment ${blockAlign} does not match ${expectedBlockAlign}`);
  }
  const expectedByteRate = sampleRate * blockAlign;
  if (byteRate !== expectedByteRate) {
    reject(source, chunkOffset + 8, `WAV byte rate ${byteRate} does not match ${expectedByteRate}`);
  }
  return { sampleRate, channels, bytesPerSample, blockAlign };
}

function parseCueLoop(reader: BinaryReader, source: string, chunkOffset: number): number | null {
  if (reader.length < 4) reject(source, chunkOffset, "truncated WAV cue chunk");
  const cueCount = reader.u32();
  const requiredLength = 4 + cueCount * 24;
  if (requiredLength > reader.length) reject(source, chunkOffset, "truncated WAV cue-point records");
  if (cueCount === 0) return null;
  reader.skip(20);
  return reader.u32();
}

function parseSamplerLoop(reader: BinaryReader, source: string, chunkOffset: number): number | null {
  if (reader.length < 36) reject(source, chunkOffset, "truncated WAV sampler chunk");
  reader.seek(28);
  const loopCount = reader.u32();
  const requiredLength = 36 + loopCount * 24;
  if (requiredLength > reader.length) reject(source, chunkOffset, "truncated WAV sampler-loop records");
  if (loopCount === 0) return null;
  reader.seek(44);
  return reader.u32();
}

// Asset inspection checks the complete RIFF and retains its cue/smpl extension.
export function decodeWav(bytes: Uint8Array, source = "<buffer>"): DecodedWav {
  const reader = new BinaryReader(bytes, source);
  if (reader.length < 12) reject(source, 0, "truncated RIFF/WAVE header");
  expectFourCc(reader, "RIFF");
  const riffSize = reader.u32();
  if (riffSize < 4) reject(source, 4, `invalid RIFF size ${riffSize}`);
  const riffEnd = 8 + riffSize;
  if (riffEnd > reader.length) reject(source, 4, `RIFF size ${riffSize} exceeds ${reader.length}-byte input`);
  expectFourCc(reader, "WAVE");

  let format: WavFormat | null = null;
  let data: ChunkRange | null = null;
  let cueLoopStart: number | null = null;
  let samplerLoopStart: number | null = null;

  while (reader.offset < riffEnd) {
    const chunkHeaderOffset = reader.offset;
    if (riffEnd - chunkHeaderOffset < 8) reject(source, chunkHeaderOffset, "truncated WAV chunk header");
    const chunkId = fourCc(reader);
    const chunkLength = reader.u32();
    const chunkOffset = reader.offset;
    if (chunkOffset > riffEnd - chunkLength) {
      reject(source, chunkHeaderOffset + 4, `WAV chunk ${JSON.stringify(chunkId)} exceeds RIFF bounds`);
    }
    const chunkEnd = chunkOffset + chunkLength;
    // Several retail Quake III WAVs omit the otherwise required pad after an
    // odd final data chunk. GetWavinfo accepts them because it never advances
    // beyond that chunk. Padding remains mandatory when another chunk follows.
    const nextChunkOffset = chunkEnd < riffEnd ? chunkEnd + (chunkLength & 1) : chunkEnd;

    if (chunkId === "fmt " && format === null) {
      format = parseFormat(reader.section(chunkOffset, chunkLength), source, chunkOffset);
    } else if (chunkId === "data" && data === null) {
      data = { offset: chunkOffset, length: chunkLength };
    } else if (chunkId === "cue " && cueLoopStart === null) {
      cueLoopStart = parseCueLoop(reader.section(chunkOffset, chunkLength), source, chunkOffset);
    } else if (chunkId === "smpl" && samplerLoopStart === null) {
      samplerLoopStart = parseSamplerLoop(reader.section(chunkOffset, chunkLength), source, chunkOffset);
    }
    reader.seek(nextChunkOffset);
  }

  if (format === null) reject(source, 12, "missing WAV fmt chunk");
  if (data === null) reject(source, 12, "missing WAV data chunk");
  if (data.length % format.blockAlign !== 0) {
    reject(source, data.offset, `WAV data length ${data.length} is not a multiple of block alignment ${format.blockAlign}`);
  }

  const frameCount = data.length / format.blockAlign;
  const sampleCount = frameCount * format.channels;
  const loopStart = cueLoopStart ?? samplerLoopStart;
  const bytesPerSample = format.bytesPerSample;
  const sampleRate = format.sampleRate, channels = format.channels;
  const samples = pcmSamples(reader, data.offset, bytesPerSample, sampleCount);
  if (loopStart !== null && loopStart >= frameCount) {
    reject(source, data.offset, `WAV loop start ${loopStart} is outside ${frameCount} frames`);
  }
  return { sourceBytesPerSample: bytesPerSample, sampleRate, channels, samples, frameCount, loopStart };
}
