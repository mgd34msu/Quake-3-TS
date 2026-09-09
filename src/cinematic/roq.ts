// Ported from id Software's code/client/cl_cin.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError, BinaryReader } from "../core/binary.ts";
import { RoqStream } from "./roq-stream.ts";
import { SourceRoqAudio } from "./roq-audio.ts";
import { SourceRoqCodebooks } from "./roq-codebook.ts";

export type RoqEvent =
  | { readonly kind: "frame"; readonly rgba: Uint8Array; readonly index: number; readonly time: number }
  | { readonly kind: "audio"; readonly samples: Int16Array; readonly channels: 1 | 2; readonly sampleRate: 22050 }
  | { readonly kind: "end" };

export type RoqChunkEvent = RoqEvent
  | { readonly kind: "info"; readonly width: number; readonly height: number }
  | { readonly kind: "metadata" };

export interface RoqDecoderOptions {
  readonly endPolicy?: "complete" | "cinematic-lookahead";
  readonly silent?: boolean;
  readonly scratch?: RoqDecoderScratch;
}

/** cl_cin's process-wide codebooks and fixed linbuf; decoder instances retain their own stream positions. */
export class RoqDecoderScratch {
  readonly file = new Uint8Array(65536 + 8);
  readonly codebooks = new SourceRoqCodebooks();
  readonly book2 = this.codebooks.book2;
  readonly book4 = this.codebooks.book4;
  readonly book8 = this.codebooks.book8;
  private readonly frames = new Uint8Array(512 * 512 * 4 * 2);

  /** A new CIN_PlayCinematic clears cinematics_t, but the separate global codebooks survive. */
  clearMovieState(): void { this.file.fill(0); this.frames.fill(0); }

  clear(): void { this.clearMovieState(); this.codebooks.clear(); }

  /** Shared physical view: the second image starts at this movie's screenDelta, not a fixed half-buffer offset. */
  frame(byteLength: number, index: 0 | 1): Uint8Array {
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 512 * 512 * 4) throw new RangeError("Invalid RoQ scratch frame length");
    return this.view(byteLength * index, byteLength);
  }

  /** CIN_UploadCinematic may read beyond the published frame into the same global linbuf. */
  view(offset: number, byteLength: number): Uint8Array {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(byteLength) || offset < 0 || byteLength < 0
      || offset + byteLength > this.frames.length) throw new RangeError("Invalid RoQ physical buffer range");
    return this.frames.subarray(offset, offset + byteLength);
  }
}

class VqReader {
  private codes = 0;
  private remaining = 0;

  constructor(readonly reader: BinaryReader) {}

  code(): number {
    if (this.remaining === 0) {
      this.codes = this.reader.u16();
      this.remaining = 8;
    }
    const code = this.codes >>> 14;
    this.codes = (this.codes << 2) & 65535;
    this.remaining--;
    return code;
  }
}

export class RoqDecoder {
  private readonly audio = new SourceRoqAudio();
  private rate: number;
  private readonly stream: RoqStream;
  private readonly book2: Uint8Array;
  private readonly book4: Uint8Array;
  private readonly book8: Uint8Array;
  private readonly scratch: RoqDecoderScratch;
  private frameWidth = 0;
  private frameHeight = 0;
  private firstBuffer: Uint8Array = new Uint8Array(0);
  private secondBuffer: Uint8Array = new Uint8Array(0);
  private frameIndex = -1;
  private unknownChunk: "none" | "interrupt" | "run-tail" = "none";
  private readonly cinematicLookahead: boolean;
  private readonly silent: boolean;

  constructor(data: Uint8Array | RoqStream, source = "<RoQ>", options: RoqDecoderOptions = {}) {
    this.audio.setupTable();
    this.scratch = options.scratch ?? new RoqDecoderScratch();
    this.book2 = this.scratch.book2;
    this.book4 = this.scratch.book4;
    this.book8 = this.scratch.book8;
    this.cinematicLookahead = data instanceof RoqStream || options.endPolicy === "cinematic-lookahead";
    this.silent = options.silent ?? false;
    this.stream = data instanceof RoqStream ? data : RoqStream.fromBytes(data, source, this.scratch.file, options.endPolicy);
    const reader = new BinaryReader(this.stream.initialize(), source);
    if (this.stream.initializedByReset) reader.skip(6);
    else {
      if (reader.u16() !== 0x1084) throw new BinaryError(source, 0, "invalid RoQ magic");
      reader.skip(4);
    }
    const rate = reader.u16();
    this.rate = rate === 0 ? 30 : rate;
  }

  get frameRate(): number { return this.rate; }
  get width(): number { return this.frameWidth; }
  get height(): number { return this.frameHeight; }
  get inPacket(): boolean { return this.stream.inPacket; }
  get hasInvalidLookahead(): boolean { return this.unknownChunk !== "none" || this.stream.hasInvalidLookahead; }
  get resetAfterRun(): boolean { return this.unknownChunk === "run-tail"; }
  private get front(): Uint8Array { return (this.frameIndex & 1) === 0 ? this.firstBuffer : this.secondBuffer; }
  private get back(): Uint8Array { return (this.frameIndex & 1) === 0 ? this.secondBuffer : this.firstBuffer; }

  /** RoQReset retains both physical image buffers and the codebooks between loops. */
  rewind(): void {
    this.stream.rewind();
    const header = new BinaryReader(this.stream.initialize(), this.stream.source);
    header.skip(6);
    const rate = header.u16();
    this.rate = rate === 0 ? 30 : rate;
    this.frameIndex = -1;
    this.unknownChunk = "none";
  }

  next(): RoqEvent {
    for (;;) {
      const event = this.nextChunk();
      if (event.kind !== "info" && event.kind !== "metadata") return event;
    }
  }

  nextChunk(beforeStereoDecode?: () => undefined, afterInfoDecode?: () => undefined,
    afterAudioDecode?: (audio: Extract<RoqEvent, { readonly kind: "audio" }>) => undefined): RoqChunkEvent {
    if (this.unknownChunk !== "none") return { kind: "end" };
    const streamed = this.stream.nextChunk();
    if (streamed === null) return { kind: "end" };
    const { id, flags, reader: chunk } = streamed;
    let event: RoqChunkEvent;
    switch (id) {
      case 0x1001:
        this.readInfo(chunk);
        afterInfoDecode?.();
        event = { kind: "info", width: this.width, height: this.height };
        break;
      case 0x1002:
        this.readCodebook(chunk, flags);
        event = { kind: "metadata" };
        break;
      case 0x1011:
        event = this.readFrame(chunk, flags);
        break;
      case 0x1012: // ROQ_QUAD_JPEG is a no-op in the original decoder.
      case 0x1013:
      case 0x1030:
        event = { kind: "metadata" };
        break;
      case 0x1020:
        event = this.silent ? { kind: "metadata" } : this.readAudio(chunk, flags, 1);
        break;
      case 0x1021:
        if (this.silent) event = { kind: "metadata" };
        else {
          beforeStereoDecode?.();
          event = this.readAudio(chunk, flags, 2);
        }
        break;
      default:
        if (!this.cinematicLookahead) this.fail(chunk, `unsupported RoQ chunk 0x${id.toString(16)}`);
        event = { kind: "end" };
        break;
    }
    if (event.kind === "audio") afterAudioDecode?.(event);
    this.stream.completeChunk(event.kind === "end");
    if (event.kind === "end") this.unknownChunk = this.stream.hasInvalidLookahead ? "interrupt" : "run-tail";
    return event;
  }

  private fail(reader: BinaryReader, message: string): never {
    throw new BinaryError(reader.source, reader.offset, message);
  }

  private readInfo(reader: BinaryReader): void {
    if (this.frameIndex !== -1) {
      // RoQInterrupt does not read repeated INFO payloads, and retains numQuads=1.
      if (this.frameIndex !== 1) this.frameIndex = 0;
      return;
    }
    const width = reader.u16();
    const height = reader.u16();
    reader.u16(); // Stored maxsize and minsize do not control the source's fixed 8/4 traversal.
    reader.u16();
    if (width === 0 || height === 0 || width % 8 !== 0 || height % 8 !== 0
      || width * height > 512 * 512) {
      this.fail(reader, "invalid RoQ quad dimensions");
    }
    this.frameWidth = width;
    this.frameHeight = height;
    this.firstBuffer = this.scratch.frame(width * height * 4, 0);
    this.secondBuffer = this.scratch.frame(width * height * 4, 1);
    this.frameIndex = 0;
  }

  private readCodebook(reader: BinaryReader, flags: number): void {
    this.scratch.codebooks.decode(reader, flags, "normal", { samplesPerPixel: 4 },
      this.cinematicLookahead ? "source" : "diagnostic-2x2");
  }

  private readAudio(reader: BinaryReader, flags: number, channels: 1 | 2): RoqEvent {
    if (reader.remaining % channels !== 0) this.fail(reader, "incomplete stereo sample pair");
    const count = reader.remaining;
    const samples = new Int16Array(channels === 1 ? count * 2 : count);
    const input = reader.bytes(count);
    if (channels === 1) this.audio.decodeMonoToStereo(input, samples, count, false, flags);
    else this.audio.decodeStereoToStereo(input, samples, count, false, flags);
    // RoQInterrupt submits RllDecodeMonoToStereo's duplicated buffer as mono.
    return { kind: "audio", samples: samples.subarray(0, count), channels, sampleRate: 22050 };
  }

  private readFrame(reader: BinaryReader, flags: number): RoqEvent {
    if (this.width === 0) this.fail(reader, "RoQ frame precedes quad info");
    const vq = new VqReader(reader);
    for (let y = 0; y < this.height; y += 16) {
      for (let x = 0; x < this.width; x += 16) {
        for (let quadrant = 0; quadrant < 4; quadrant++) {
          const blockX = x + (quadrant & 1) * 8;
          const blockY = y + (quadrant >>> 1) * 8;
          if (blockX + 8 <= this.width && blockY + 8 <= this.height) this.block(vq, blockX, blockY, 8, flags);
        }
      }
    }
    // The source stops at the final quad; retail streams include trailing control padding.
    const event: RoqEvent = { kind: "frame", rgba: this.front.slice(), index: this.frameIndex, time: this.frameIndex * 1000 / this.frameRate };
    if (this.frameIndex === 0) this.back.set(this.front);
    this.frameIndex++;
    return event;
  }

  private block(vq: VqReader, x: number, y: number, size: 4 | 8, flags: number): void {
    switch (vq.code()) {
      case 0: return;
      case 1: {
        const motion = vq.reader.u8();
        const meanX = (flags << 16) >> 24;
        const meanY = (flags << 24) >> 24;
        const scale = this.width === this.height * 4 ? 2 : 1;
        const reference = (this.frameIndex & 1) === 0 ? this.front.length : 0;
        const offset = reference + ((y + (8 - (motion & 15) - meanY) * scale) * this.width
          + x + (8 - (motion >>> 4) - meanX) * scale) * 4;
        const length = ((size - 1) * this.width + size) * 4;
        // Source motion addresses the full linbuf, including the current image and unused tail.
        if (offset < 0 || offset + length > 512 * 512 * 4 * 2) {
          this.fail(vq.reader, "RoQ motion vector exceeds physical frame buffer");
        }
        const source = this.scratch.view(offset, length);
        for (let row = 0; row < size; row++) {
          for (let pair = 0; pair < size * 4; pair += 8) {
            const from = row * this.width * 4 + pair;
            this.front.set(source.subarray(from, from + 8), ((y + row) * this.width + x) * 4 + pair);
          }
        }
        return;
      }
      case 2:
        this.blit(size === 8 ? this.book8 : this.book4, vq.reader.u8(), size, x, y);
        return;
      case 3:
        for (let quadrant = 0; quadrant < 4; quadrant++) {
          const nextX = x + (quadrant & 1) * (size / 2);
          const nextY = y + (quadrant >>> 1) * (size / 2);
          if (size === 8) this.block(vq, nextX, nextY, 4, flags);
          else this.blit(this.book2, vq.reader.u8(), 2, nextX, nextY);
        }
        return;
    }
  }

  private blit(book: Uint8Array, index: number, size: number, x: number, y: number): void {
    for (let row = 0; row < size; row++) {
      const source = (index * size * size + row * size) * 4;
      this.front.set(book.subarray(source, source + size * 4), ((y + row) * this.width + x) * 4);
    }
  }
}
