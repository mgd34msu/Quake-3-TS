// Ported from id Software's code/client/cl_cin.c, CIN_RunCinematic and RoQInterrupt.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { RoqDecoder } from "./roq.ts";
import type { RoqDecoderScratch } from "./roq.ts";
import { RoqStream } from "./roq-stream.ts";

export interface RoqPlaybackOptions {
  readonly clock: RoqPlaybackClock;
  readonly source?: string;
  readonly loop?: boolean;
  readonly hold?: boolean;
  readonly silent?: boolean;
  readonly shader?: boolean;
  readonly onAudio: (audio: RoqPlaybackAudio) => undefined;
  readonly developerPrint: (text: string) => undefined;
  readonly onInfo?: (width: number, height: number) => undefined;
  readonly onFrame?: (frame: RoqPlaybackFrame, pointer: RoqFramePointer) => undefined;
  readonly scratch?: RoqDecoderScratch;
  readonly beforeRawStreamReset?: () => undefined;
}

export interface RoqPlaybackClock {
  sample(): number;
}

export interface RoqFramePointer {
  readonly offset: number;
  readonly byteLength: number;
}

export interface RoqPlaybackFrame {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly index: number;
  readonly loop: number;
  /** Presentation deadline on the caller's clock; frame zero is due after one interval. */
  readonly time: number;
  readonly sourceTime: number;
}

export interface RoqPlaybackAudio {
  readonly samples: Int16Array;
  readonly channels: 1 | 2;
  readonly sampleRate: 22050;
  readonly loop: number;
  /** Sample-frame offset, independent of the number of interleaved channels. */
  readonly sourceSample: number;
  readonly sourceTime: number;
  readonly time: number;
  /** ZA_SOUND_STEREO resets the raw stream before the first QUAD_INFO of each pass. */
  readonly resetStream: boolean;
}

export interface RoqPlaybackTick {
  readonly status: "playing" | "held" | "ended" | "looped";
  readonly update: { readonly kind: "unchanged" } | { readonly kind: "frame"; readonly frame: RoqPlaybackFrame };
}

function clockTime(time: number): number {
  if (!Number.isFinite(time) || time < 0 || Math.fround(time) > 0x7fffffff) throw new RangeError("Cinematic clock must fit finite nonnegative signed milliseconds");
  return time;
}

function copyFrame(frame: RoqPlaybackFrame): RoqPlaybackFrame {
  return { ...frame, rgba: new Uint8Array(frame.rgba) };
}

export class RoqPlayback {
  private readonly data: Uint8Array | RoqStream;
  private readonly source: string;
  private readonly loop: boolean;
  private readonly hold: boolean;
  private readonly silent: boolean;
  private readonly shader: boolean;
  private readonly onAudio: (audio: RoqPlaybackAudio) => undefined;
  private readonly developerPrint: (text: string) => undefined;
  private readonly onInfo: ((width: number, height: number) => undefined) | undefined;
  private readonly onFrame: ((frame: RoqPlaybackFrame, pointer: RoqFramePointer) => undefined) | undefined;
  private readonly scratch: RoqDecoderScratch | undefined;
  private readonly beforeRawStreamReset: (() => undefined) | undefined;
  private decoder: RoqDecoder;
  private epoch: number;
  private lastTime: number;
  private state: RoqPlaybackTick["status"] = "playing";
  private frame: RoqPlaybackFrame | null = null;
  private pointer: RoqFramePointer | null = null;
  private decodedFrames = -1;
  private sourceSample = 0;
  private loopIndex = 0;

  constructor(data: Uint8Array | RoqStream, options: RoqPlaybackOptions) {
    this.data = data instanceof RoqStream ? data : new Uint8Array(data);
    this.source = options.source ?? "<RoQ playback>";
    this.loop = options.loop ?? false;
    this.hold = options.hold ?? false;
    this.silent = options.silent ?? false;
    this.shader = options.shader ?? false;
    this.onAudio = options.onAudio;
    this.developerPrint = options.developerPrint;
    this.onInfo = options.onInfo;
    this.onFrame = options.onFrame;
    this.scratch = options.scratch;
    this.beforeRawStreamReset = options.beforeRawStreamReset;
    this.decoder = new RoqDecoder(this.data, this.source, { endPolicy: "cinematic-lookahead", silent: this.silent, ...(this.scratch === undefined ? {} : { scratch: this.scratch }) });
    this.epoch = Math.trunc(clockTime(options.clock.sample())) >>> 0;
    this.lastTime = this.epoch;
  }

  /** RoQReset can initialize a retained file before CIN_Play has built its decoder. */
  static fromReset(stream: RoqStream, options: RoqPlaybackOptions): RoqPlayback {
    stream.rewind();
    const playback = new RoqPlayback(stream, options);
    playback.state = "looped";
    return playback;
  }

  get frameRate(): number { return this.decoder.frameRate; }
  get currentFrame(): RoqPlaybackFrame | null { return this.frame === null ? null : copyFrame(this.frame); }
  get currentPointer(): RoqFramePointer | null { return this.pointer === null ? null : { ...this.pointer }; }
  get dimensions(): { readonly width: number; readonly height: number } | null {
    return this.decoder.width === 0 ? null : { width: this.decoder.width, height: this.decoder.height };
  }

  /** Rewinds the decoder and clears the published frame. */
  reset(clock: RoqPlaybackClock): void {
    this.scratch?.clear();
    this.decoder = new RoqDecoder(this.data, this.source, { endPolicy: "cinematic-lookahead", silent: this.silent, ...(this.scratch === undefined ? {} : { scratch: this.scratch }) });
    this.frame = null;
    this.pointer = null;
    this.restart(clock);
    this.state = "playing";
  }

  /** Source RoQReset on handle switching: retain physical buffers, codebooks and the last published image. */
  restart(clock: RoqPlaybackClock): void {
    this.decoder.rewind();
    this.epoch = Math.trunc(clockTime(clock.sample())) >>> 0;
    this.lastTime = this.epoch;
    this.state = "looped";
    this.decodedFrames = -1;
    this.sourceSample = 0;
    this.loopIndex = 0;
  }

  private resetLoop(clock: RoqPlaybackClock): void {
    this.decoder.rewind();
    this.epoch = Math.trunc(clockTime(clock.sample())) >>> 0;
    this.lastTime = this.epoch;
    this.state = "looped";
    this.decodedFrames = -1;
    this.sourceSample = 0;
    this.loopIndex++;
  }

  run(clock: RoqPlaybackClock): RoqPlaybackTick {
    if (this.state === "held" || this.state === "ended") return { status: this.state, update: { kind: "unchanged" } };
    // CIN_RunCinematic uses 30 fps regardless of the RoQ header's rate.
    const targetFrames = (): number => {
      const time = clockTime(clock.sample());
      return Math.trunc(Math.fround((time - this.epoch) * 3 / 100));
    };
    // Verified i386 GCC x87 profile spills this signed conversion to float32;
    // RoQ_init's unsigned epoch conversion instead truncates the extended value.
    const thisTime = Math.trunc(Math.fround(clockTime(clock.sample())));
    const gap = (thisTime - this.lastTime) | 0;
    if (this.shader && Math.abs(gap) > 100) this.epoch = (this.epoch + gap) >>> 0;
    let target = targetFrames(), epoch = this.epoch;
    let dirty: RoqPlaybackFrame | null = null;
    while (this.state === "playing" && (target !== this.decodedFrames || this.decoder.inPacket || this.decoder.hasInvalidLookahead)) {
      const hadInvalidLookahead = this.decoder.hasInvalidLookahead;
      const event = this.decoder.nextChunk(!this.silent && this.decodedFrames === -1 ? this.beforeRawStreamReset : undefined, () => {
        if (this.decodedFrames === -1) {
          this.onInfo?.(this.decoder.width, this.decoder.height);
          this.epoch = Math.trunc(clockTime(clock.sample())) >>> 0;
          this.lastTime = this.epoch;
        }
        if (this.decodedFrames !== 1) this.decodedFrames = 0;
      }, event => {
        const sourceTime = this.sourceSample * 1000 / event.sampleRate;
        this.onAudio({
          samples: event.samples, channels: event.channels, sampleRate: event.sampleRate,
          loop: this.loopIndex, sourceSample: this.sourceSample, sourceTime, time: this.epoch + sourceTime,
          resetStream: event.channels === 2 && this.decodedFrames === -1,
        });
        this.sourceSample += event.samples.length / event.channels;
      });
      if (event.kind === "frame") {
        this.decodedFrames++;
        this.frame = {
          rgba: event.rgba, width: this.decoder.width, height: this.decoder.height,
          index: event.index, loop: this.loopIndex, sourceTime: event.time,
          time: this.epoch + this.decodedFrames * 1000 / 30,
        };
        const byteLength = this.decoder.width * this.decoder.height * 4;
        this.pointer = { offset: byteLength * (event.index & 1), byteLength };
        dirty = this.frame;
        this.onFrame?.(this.frame, this.pointer);
      }
      if (!hadInvalidLookahead && this.decoder.hasInvalidLookahead && !this.decoder.resetAfterRun) {
        this.developerPrint("roq_size>65536||roq_id==0x1084\n");
      }
      if (event.kind === "end") {
        if (this.hold && !this.decoder.hasInvalidLookahead) this.state = "held";
        else if (this.loop && !this.decoder.resetAfterRun) {
          // RoQReset rebases startTime to the clock that observed EOF, even after a long stall.
          this.resetLoop(clock);
        } else this.state = "ended";
      }
      // RoQInterrupt processes an entire packet before CIN_RunCinematic checks startTime.
      if (!this.decoder.inPacket && epoch !== this.epoch) {
        target = targetFrames();
        epoch = this.epoch;
      }
    }
    this.lastTime = thisTime;
    if (this.state === "looped") this.state = "playing";
    if (this.state === "ended" && this.loop) this.resetLoop(clock);
    return {
      status: this.state,
      update: dirty === null ? { kind: "unchanged" } : { kind: "frame", frame: copyFrame(dirty) },
    };
  }
}
