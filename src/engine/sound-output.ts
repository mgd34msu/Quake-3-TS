/*
 * Output lifetime and S_ClearSoundBuffer from id Software's code/client/snd_dma.c.
 * SDL2 queued U8/S16 audio replaces the platform DMA buffer.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { AudioMixer, SOUND_TIME_EPOCH } from "../audio/mixer.ts";
import type { SoundPaintRange } from "../audio/mixer.ts";
import { SdlAudioDevice } from "../platform/audio.ts";
import type { SdlAudioOptions } from "../platform/audio.ts";

export type SoundOutputOptions = Pick<SdlAudioOptions, "sampleRate" | "bufferFrames" | "sampleBits" | "deviceName">
  & { readonly channels?: 1 | 2 };

interface StartedOutput {
  readonly kind: "started";
  readonly mixer: AudioMixer;
  readonly device: SdlAudioDevice;
  paused: boolean;
  delivered: number;
  clockOffset: number;
  pending: Int16Array | Uint8Array;
}

type OutputState = { readonly kind: "idle" } | StartedOutput | { readonly kind: "closed" };

/** Owns the actual mixer/device pair. Source registration and frame scheduling remain external. */
export class SoundOutput {
  private state: OutputState = { kind: "idle" };

  get mixer(): AudioMixer | null {
    return this.state.kind === "started" ? this.state.mixer : null;
  }

  /** Opens paused output. Repeated starts retain the current pair and ignore new options. */
  start(options: SoundOutputOptions, milliseconds: () => number): AudioMixer {
    if (this.state.kind === "closed") throw new Error("Sound output is closed");
    if (this.state.kind === "started") return this.state.mixer;
    const device = SdlAudioDevice.open({ ...options, channels: options.channels ?? 2 });
    try {
      const mixer = new AudioMixer(device.sampleRate, milliseconds, 96, device.channels);
      mixer.clearSoundBuffer();
      device.clear();
      this.state = { kind: "started", mixer, device, paused: true, delivered: 0, clockOffset: 0, pending: this.silence(device, 0) };
      return mixer;
    } catch (error) {
      device.close();
      throw error;
    }
  }

  /** S_ClearSoundBuffer intentionally leaves BackgroundMusic's playback source running. */
  clearSoundBuffer(): void {
    if (this.state.kind !== "started") return;
    this.state.mixer.clearSoundBuffer();
    const state = this.state;
    this.withPaused(state, () => {
      this.synchronize(state);
      state.device.clear();
      state.pending = this.silence(state.device, 0);
      state.clockOffset = state.device.playbackFrames - state.delivered;
    });
  }

  get queuedFrames(): number {
    return this.started().device.queuedFrames;
  }

  get paused(): boolean { return this.started().paused; }
  get maxQueuedFrames(): number { return this.started().device.maxQueuedFrames; }
  get channels(): 1 | 2 { return this.started().device.channels; }
  get sampleBits(): 8 | 16 { return this.started().device.sampleBits; }
  get deviceName(): string | null { return this.started().device.deviceName; }

  /** Queued PCM advances by actual delivery; an empty queue advances through logical silence. */
  get deliveryTime(): number {
    const state = this.started();
    this.synchronize(state);
    return state.delivered;
  }

  /** SDL has no DMA wrap. Chop whole source-limit epochs after playback advances. */
  rebaseTime(stopAllSounds: () => undefined): void {
    const state = this.started();
    this.synchronize(state);
    if (state.delivered < SOUND_TIME_EPOCH || state.delivered <= state.mixer.soundClock
      || state.mixer.sampleClock <= SOUND_TIME_EPOCH) return;
    stopAllSounds();
    if (this.state !== state) throw new Error("Sound output lifetime ended during clock rebase");
    // S_ClearSoundBuffer accounts for delivery while pausing and clearing the
    // actual queue. Rebase its final cursor without replaying that consumed PCM.
    this.synchronize(state);
    const previous = state.delivered;
    state.delivered = state.mixer.rebaseTime(previous);
    state.clockOffset += previous - state.delivered;
  }

  /** Defensive copy of the still-native-queued PCM; delivered samples are excluded. */
  get pendingOutput(): { readonly startFrame: number; readonly samples: Int16Array | Uint8Array } {
    const state = this.started();
    this.synchronize(state);
    return { startFrame: state.delivered, samples: state.pending.slice() };
  }

  /** Paints a caller-selected frame count; this does not implement S_Update's clock scheduling. */
  submit(frames: number): void {
    const state = this.started();
    const { device } = state;
    if (!Number.isSafeInteger(frames) || frames < 0) {
      throw new RangeError("mix frame count must be a nonnegative safe integer");
    }
    if (frames > device.maxQueuedFrames - device.queuedFrames) {
      throw new Error("SDL audio queue exceeds the two-second limit");
    }
    this.synchronize(state);
    const startFrame = state.delivered + state.pending.length / device.channels;
    this.repaint({ startFrame, endFrame: startFrame + frames });
  }

  /** Mix while playback runs, then replace only output SDL has not delivered yet. */
  repaint(range: SoundPaintRange): void {
    const state = this.started();
    this.synchronize(state);
    if (range.endFrame - state.delivered > state.device.maxQueuedFrames) throw new Error("SDL audio queue exceeds the two-second limit");
    const samples = state.mixer.mix(range);
    if (samples.length === 0) return;
    this.withPaused(state, () => {
      this.synchronize(state);
      const begin = Math.max(range.startFrame, state.delivered);
      if (range.endFrame <= begin) return;
      const channels = state.device.channels;
      const end = Math.max(range.endFrame, state.delivered + state.pending.length / channels);
      // A previously empty prefix represents actual queued silence before the source prestep.
      const replacement = this.silence(state.device, end - state.delivered);
      replacement.set(state.pending);
      // S_TransferPaintBuffer selects the left paint cell for mono, then clips
      // before its unsigned eight-bit conversion. mix() already clips to S16.
      if (state.device.sampleBits === 16 && channels === 2) {
        replacement.set(samples.subarray((begin - range.startFrame) * 2), (begin - state.delivered) * 2);
      } else {
        for (let frame = begin; frame < range.endFrame; frame++) {
          for (let channel = 0; channel < channels; channel++) {
            const sample = samples[(frame - range.startFrame) * 2 + channel];
            if (sample === undefined) throw new RangeError("Sound paint output is truncated");
            replacement[(frame - state.delivered) * channels + channel] = state.device.sampleBits === 16
              ? sample : (sample >> 8) + 128;
          }
        }
      }
      state.device.clear();
      state.pending = this.silence(state.device, 0);
      // On failure the native queue really is empty. Never resurrect discarded ownership.
      state.device.queue(replacement);
      state.pending = replacement;
    });
  }

  pause(): void { const state = this.started(); state.device.pause(); state.paused = true; }
  resume(): void { const state = this.started(); state.device.resume(); state.paused = false; }

  shutdown(): void {
    if (this.state.kind !== "started") return;
    this.state.device.close();
    this.state.mixer.setPlaybackEnabled(false);
    this.state = { kind: "idle" };
  }

  close(): void {
    try { this.shutdown(); }
    finally { this.state = { kind: "closed" }; }
  }

  private started(): StartedOutput {
    if (this.state.kind !== "started") throw new Error("Sound output is not started");
    return this.state;
  }

  private synchronize(state: StartedOutput): void {
    const consumed = state.pending.length / state.device.channels - state.device.queuedFrames;
    if (consumed < 0) throw new Error("SDL queue contains output not owned by SoundOutput");
    state.delivered += consumed;
    state.pending = state.pending.subarray(consumed * state.device.channels);
    if (state.pending.length === 0) {
      const playbackFrames = state.device.playbackFrames;
      state.delivered = Math.max(state.delivered, playbackFrames - state.clockOffset);
      // A native delivery quantum can lead elapsed time. Start silence at that
      // final queue head without waiting for the nominal clock to catch up.
      state.clockOffset = playbackFrames - state.delivered;
    }
  }

  private silence(device: SdlAudioDevice, frames: number): Int16Array | Uint8Array {
    const samples = frames * device.channels;
    return device.sampleBits === 16 ? new Int16Array(samples) : new Uint8Array(samples).fill(128);
  }

  private withPaused(state: StartedOutput, operation: () => void): void {
    const wasPaused = state.paused;
    if (!wasPaused) state.device.pause();
    try { operation(); }
    finally { if (!wasPaused) state.device.resume(); }
  }
}
