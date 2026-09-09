// SPDX-License-Identifier: GPL-2.0-or-later
// Replaces code/unix/linux_snd.c device ownership with SDL2 queued S16 audio.
import { dlopen } from "bun:ffi";
import { endianness } from "node:os";

function loadAudio() {
  return dlopen(process.env["QUAKE_SDL2_LIBRARY"] ?? "libSDL2-2.0.so.0", {
    SDL_InitSubSystem: { args: ["u32"], returns: "i32" },
    SDL_SetHint: { args: ["buffer", "buffer"], returns: "i32" },
    SDL_QuitSubSystem: { args: ["u32"], returns: "void" },
    SDL_GetError: { args: [], returns: "cstring" },
    SDL_GetPerformanceCounter: { args: [], returns: "u64" },
    SDL_GetPerformanceFrequency: { args: [], returns: "u64" },
    SDL_OpenAudioDevice: { args: ["ptr", "i32", "buffer", "buffer", "i32"], returns: "u32" },
    SDL_QueueAudio: { args: ["u32", "buffer", "u32"], returns: "i32" },
    SDL_GetQueuedAudioSize: { args: ["u32"], returns: "u32" },
    SDL_PauseAudioDevice: { args: ["u32", "i32"], returns: "void" },
    SDL_ClearQueuedAudio: { args: ["u32"], returns: "void" },
    SDL_CloseAudioDevice: { args: ["u32"], returns: "void" },
  });
}

let library: ReturnType<typeof loadAudio> | undefined;
function audio() {
  library ??= loadAudio();
  return library.symbols;
}

const audioSubsystem = 0x10;
const littleEndian = endianness() === "LE";
const signed16Native = littleEndian ? 0x8010 : 0x9010;

function checked(result: number, operation: string): void {
  if (result < 0) throw new Error(`${operation}: ${audio().SDL_GetError()}`);
}

export interface SdlAudioOptions {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly bufferFrames?: number;
}

/** An unavailable native device leaves source SNDDMA_Init unstarted. */
export class SdlAudioUnavailableError extends Error {}

export class SdlAudioDevice {
  private device: number | null;
  private readonly clockFrequency: bigint;
  private elapsedTicks = 0n;
  private playingSince: bigint | null = null;
  readonly maxQueuedFrames: number;

  private constructor(device: number, readonly sampleRate: number, readonly channels: 1 | 2, readonly bufferFrames: number) {
    this.device = device;
    this.clockFrequency = audio().SDL_GetPerformanceFrequency();
    if (this.clockFrequency <= 0n) throw new Error("SDL returned an invalid performance counter frequency");
    this.maxQueuedFrames = sampleRate * 2;
  }

  static open(options: SdlAudioOptions): SdlAudioDevice {
    const { sampleRate, channels } = options;
    const bufferFrames = options.bufferFrames ?? 1024;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("Audio sample rate must be an integer in 8000..192000 Hz");
    if (channels !== 1 && channels !== 2) throw new Error("Audio channels must be mono or stereo");
    if (!Number.isInteger(bufferFrames) || bufferFrames < 64 || bufferFrames > 32768 || (bufferFrames & (bufferFrames - 1)) !== 0) throw new Error("Audio buffer frames must be a power of two in 64..32768");

    // SDL_AudioSpec: freq0, format4, channels6, silence7, samples8, size12,
    // callback16 and userdata24 on the 64-bit ABI. Zero pointers select queuing.
    const desired = new Uint8Array(32);
    const desiredView = new DataView(desired.buffer);
    desiredView.setInt32(0, sampleRate, littleEndian);
    desiredView.setUint16(4, signed16Native, littleEndian);
    desiredView.setUint8(6, channels);
    desiredView.setUint16(8, bufferFrames, littleEndian);
    const obtained = new Uint8Array(32);
    const obtainedView = new DataView(obtained.buffer);
    const api = audio();
    if (api.SDL_SetHint(Buffer.from("SDL_NO_SIGNAL_HANDLERS\0"), Buffer.from("1\0")) !== 1)
      throw new Error("SDL must leave signal handling to the Unix signal owner");
    if (api.SDL_InitSubSystem(audioSubsystem) < 0) throw new SdlAudioUnavailableError(`SDL_InitSubSystem AUDIO: ${api.SDL_GetError()}`);
    let device = 0;
    try {
      device = api.SDL_OpenAudioDevice(null, 0, desired, obtained, 0);
      if (device === 0) throw new SdlAudioUnavailableError(`SDL_OpenAudioDevice: ${api.SDL_GetError()}`);
      const actualRate = obtainedView.getInt32(0, littleEndian);
      const actualFormat = obtainedView.getUint16(4, littleEndian);
      const actualChannels = obtainedView.getUint8(6);
      const actualFrames = obtainedView.getUint16(8, littleEndian);
      const actualBytes = obtainedView.getUint32(12, littleEndian);
      if (actualRate !== sampleRate || actualFormat !== signed16Native || actualChannels !== channels) throw new Error("SDL changed the requested signed native 16-bit audio format");
      if (actualFrames === 0 || actualBytes !== actualFrames * channels * 2 || obtainedView.getUint8(7) !== 0) throw new Error("SDL returned an invalid audio buffer specification");
      // sdl2-compat's resampling path reports converted availability instead of
      // queued input bytes. Reject that path before exposing misleading counts.
      const probe = new Int16Array(channels * 8);
      checked(api.SDL_QueueAudio(device, probe, probe.byteLength), "SDL_QueueAudio accounting probe");
      const queuedBytes = api.SDL_GetQueuedAudioSize(device);
      api.SDL_ClearQueuedAudio(device);
      if (queuedBytes !== probe.byteLength || api.SDL_GetQueuedAudioSize(device) !== 0) throw new Error("SDL audio driver cannot report exact queued input frames at this sample rate");
      // Drivers may adjust sample frames independently of the requested format.
      return new SdlAudioDevice(device, actualRate, channels, actualFrames);
    } catch (error) {
      if (device !== 0) api.SDL_CloseAudioDevice(device);
      api.SDL_QuitSubSystem(audioSubsystem);
      throw error;
    }
  }

  private opened(): number {
    if (this.device === null) throw new Error("SDL audio device is closed");
    return this.device;
  }

  get queuedFrames(): number {
    const bytes = audio().SDL_GetQueuedAudioSize(this.opened());
    const frameBytes = this.channels * 2;
    if (bytes % frameBytes !== 0) throw new Error("SDL queued audio size is not frame aligned");
    return bytes / frameBytes;
  }

  /** Logical playing time, including empty-queue silence; not a speaker-position measurement. */
  get playbackFrames(): number {
    this.opened();
    const frames = this.playingTicks() * BigInt(this.sampleRate) / this.clockFrequency;
    if (frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("SDL playback clock exceeds safe frame positions");
    return Number(frames);
  }

  private playingTicks(): bigint {
    if (this.playingSince === null) return this.elapsedTicks;
    const now = audio().SDL_GetPerformanceCounter();
    if (now < this.playingSince) throw new Error("SDL performance counter moved backward");
    return this.elapsedTicks + now - this.playingSince;
  }

  queue(samples: Int16Array): void {
    const device = this.opened();
    if (samples.length % this.channels !== 0) throw new Error("Audio sample count is not channel aligned");
    const frames = samples.length / this.channels;
    if (this.queuedFrames + frames > this.maxQueuedFrames) throw new Error("SDL audio queue exceeds the two-second limit");
    if (frames === 0) return;
    // SDL_QueueAudio copies synchronously; samples retains the backing memory here.
    checked(audio().SDL_QueueAudio(device, samples, samples.byteLength), "SDL_QueueAudio");
  }

  clear(): void { audio().SDL_ClearQueuedAudio(this.opened()); }
  pause(): void {
    const device = this.opened();
    if (this.playingSince === null) return;
    audio().SDL_PauseAudioDevice(device, 1);
    this.elapsedTicks = this.playingTicks();
    this.playingSince = null;
  }

  resume(): void {
    const device = this.opened();
    if (this.playingSince !== null) return;
    this.playingSince = audio().SDL_GetPerformanceCounter();
    audio().SDL_PauseAudioDevice(device, 0);
  }

  close(): void {
    const device = this.device;
    if (device === null) return;
    this.device = null;
    audio().SDL_CloseAudioDevice(device);
    audio().SDL_QuitSubSystem(audioSubsystem);
  }
}
