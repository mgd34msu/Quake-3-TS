/*
 * FGetLittleLong/Short, S_FindWavChunk and background WAV reads from
 * id Software's code/client/snd_dma.c. Unix streamed reads use FS_Read.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { FileHandle } from "../assets/file-handles.ts";
import type { VirtualFileSystem } from "../assets/vfs.ts";
import type { PcmSound } from "../assets/wav.ts";

const SOURCE_CHUNK_BYTES = 30_000;

class TruncatedMusicHeader extends Error {}

interface ReadyStream {
  readonly kind: "ready";
  readonly file: FileHandle;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly width: 1 | 2;
  frames: number;
}

type StreamState = { readonly kind: "header"; readonly file: FileHandle } | ReadyStream | { readonly kind: "closed" };

/** Source reads consecutive chunks; it neither scans RIFF nor skips fmt tails. */
export class MusicStream {
  private state: StreamState;

  private constructor(
    private readonly readFiles: () => VirtualFileSystem,
    file: FileHandle,
    private readonly path: string,
  ) { this.state = { kind: "header", file }; }

  static open(readFiles: () => VirtualFileSystem, path: string, print: (text: string) => void,
    publish: (stream: MusicStream | null) => undefined): MusicStream | null {
    let stream: MusicStream | null = null;
    const opened = readFiles().openUniqueRead(path, file => {
      stream = new MusicStream(readFiles, file, path);
      publish(stream);
    });
    if (opened === undefined) {
      publish(null);
      print(`^3WARNING: couldn't open music file ${path}\n`);
      return null;
    }
    if (stream === null) throw new Error("Music file opened without publishing its source handle");
    return stream;
  }

  readHeader(print: (text: string) => void): void {
    if (this.state.kind !== "header") throw new Error("Music header has already been consumed");
    const { file } = this.state;
    const { readFiles, path } = this;
    const scalar = (width: 2 | 4): number => {
      const bytes = new Uint8Array(width);
      if (readFiles().readInto(file, bytes) !== width) throw new TruncatedMusicHeader(`Truncated music header in ${path}\n`);
      const view = new DataView(bytes.buffer);
      return width === 2 ? view.getInt16(0, true) : view.getInt32(0, true);
    };
    const chunk = (name: string): number => {
      const bytes = new Uint8Array(4);
      if (readFiles().readInto(file, bytes) !== 4) return 0;
      const length = scalar(4);
      if (length < 0 || length > 0xfffffff) return 0;
      if (String.fromCharCode(...bytes) !== name) return 0;
      return (length + 1) & ~1;
    };
    const reject = (message: string): void => {
      this.close();
      print(message);
    };
    try {
      readFiles().readInto(file, new Uint8Array(12));
      if (chunk("fmt ") === 0) {
        // Source prints this failure before closing, unlike the later checks.
        print(`No fmt chunk in ${path}\n`);
        this.close();
        return;
      }
      const format = scalar(2);
      const channels = scalar(2);
      const sampleRate = scalar(4);
      scalar(4);
      scalar(2);
      const width = Math.trunc(scalar(2) / 8);
      if (format !== 1) return reject(`Not a microsoft PCM format wav: ${path}\n`);
      if (channels !== 2 || sampleRate !== 22050) print(`^3WARNING: music file ${path} is not 22k stereo\n`);
      const length = chunk("data");
      if (length === 0) return reject(`No data chunk in ${path}\n`);
      // These source inputs otherwise divide by zero, spin, or select no raw
      // conversion branch. Reject that undefined/unsupported domain explicitly.
      if ((channels !== 1 && channels !== 2) || (width !== 1 && width !== 2) || sampleRate <= 0) {
        return reject(`Unsupported music PCM format in ${path}\n`);
      }
      const frames = Math.trunc(length / (width * channels));
      if (frames === 0) return reject(`Music file ${path} has no complete PCM frames\n`);
      this.state = { kind: "ready", file, sampleRate, channels, width, frames };
    } catch (error) {
      if (error instanceof TruncatedMusicHeader) {
        this.close();
        print(error.message);
        return;
      }
      throw error;
    }
  }

  get isOpen(): boolean { return this.state.kind !== "closed"; }
  get sampleRate(): number { return this.ready().sampleRate; }
  get remainingFrames(): number { return this.ready().frames; }

  private ready(): ReadyStream {
    if (this.state.kind !== "ready") throw new Error("Music header did not complete");
    return this.state;
  }

  readChunk(requestedFrames: number): PcmSound | null {
    const stream = this.ready();
    const bytesPerFrame = stream.width * stream.channels;
    const frameCount = Math.min(requestedFrames, stream.frames, Math.trunc(SOURCE_CHUNK_BYTES / bytesPerFrame));
    if (frameCount < 0) throw new RangeError("Music source frame request overflowed");
    const bytes = new Uint8Array(frameCount * bytesPerFrame);
    if (this.readFiles().readInto(stream.file, bytes) !== bytes.byteLength) return null;
    const samples = new Int16Array(frameCount * stream.channels);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = stream.width === 2 ? view.getInt16(index * 2, true)
        : (stream.channels === 2 ? view.getInt8(index) : view.getUint8(index) - 128) * 256;
    }
    stream.frames -= frameCount;
    return { sampleRate: stream.sampleRate, channels: stream.channels, samples, frameCount, loopStart: null };
  }

  close(): void {
    if (this.state.kind === "closed") return;
    this.readFiles().closeFile(this.state.file);
    this.state = { kind: "closed" };
  }
}
