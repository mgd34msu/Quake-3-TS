/*
 * PCM mixing translated from id Software's code/client/snd_mix.c,
 * snd_dma.c, and snd_mem.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { PcmSound } from "../assets/wav.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { ConsoleOutput } from "../core/console-output.ts";
import { add3, dot3, length3, normalize3, sub3, vec3 } from "../core/math.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import { int32 } from "../core/numeric.ts";
import { writeLinearBlastStereo16 } from "./source-paint.ts";

export interface LocalVoiceOrigin {
  readonly kind: "local";
}

export interface FixedVoiceOrigin {
  readonly kind: "fixed";
  readonly position: Vec3;
}

export interface EntityVoiceOrigin {
  readonly kind: "entity";
  readonly entity: number;
}

export type VoiceOrigin = LocalVoiceOrigin | FixedVoiceOrigin | EntityVoiceOrigin;

export interface StartSoundOptions {
  readonly entity: number;
  readonly channel: number;
  readonly origin: VoiceOrigin;
  /** Quake channel volume units. S_StartSound uses 127. */
  readonly volume: number;
}

export interface FrameLoopingSoundOptions {
  readonly entity: number;
  readonly origin: Vec3;
  readonly velocity: Vec3;
  readonly frameNumber: number;
}

export interface RealLoopingSoundOptions {
  readonly entity: number;
  readonly origin: Vec3;
  readonly velocity: Vec3;
}

interface PreparedSound {
  readonly sound: PcmSound;
  readonly step256: number;
  readonly outputFrames: number;
}

/** Engine sound handles borrow the bank's current resampled chunk allocation. */
export interface MixerSoundMemory {
  frameCount(sound: PcmSound): number;
  hasData(sound: PcmSound): boolean;
  sample(sound: PcmSound, frame: number): number;
  touch(sound: PcmSound, milliseconds: number): undefined;
}

interface OneShotVoice {
  readonly prepared: PreparedSound;
  readonly entity: number;
  readonly channel: number;
  readonly origin: VoiceOrigin;
  readonly volume: number;
  stereoVolume: StereoVolume;
  readonly start: { readonly kind: "pending" } | { readonly kind: "started"; readonly sample: number };
  readonly allocatedAt: number;
}

export interface SoundPaintRange {
  readonly startFrame: number;
  readonly endFrame: number;
}

export const SOUND_TIME_EPOCH = 0x40000000;

interface LoopVoice {
  readonly prepared: PreparedSound;
  readonly entity: number;
  readonly velocity: Vec3;
  readonly volume: number;
  readonly lifetime: "frame" | "persistent";
  readonly active: boolean;
  readonly doppler: boolean;
  readonly dopplerScale: number;
  readonly oldDopplerScale: number;
  readonly frameNumber: number;
}

interface LoopMix {
  readonly prepared: PreparedSound;
  leftVolume: number;
  rightVolume: number;
  readonly doppler: boolean;
  readonly dopplerScale: number;
  readonly oldDopplerScale: number;
}

interface StereoVolume {
  readonly left: number;
  readonly right: number;
}

const SOUND_FULLVOLUME = 80;
const SOUND_ATTENUATE = Math.fround(0.0008);
const RAW_SAMPLE_CAPACITY = 16_384;
const MAX_GENTITIES = 1024;
const PAINTBUFFER_SIZE = 4096;
const SND_CHUNK_SIZE = 1024;

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireEntity(entity: number): void {
  if (!Number.isSafeInteger(entity) || entity < 0 || entity >= MAX_GENTITIES) {
    throw new RangeError(`entity must be an integer from 0 through ${MAX_GENTITIES - 1}`);
  }
}

function requireChannel(channel: number): void {
  if (!Number.isInteger(channel) || int32(channel) !== channel) {
    throw new RangeError("channel must be a signed 32-bit integer");
  }
}

function requireFrameNumber(frameNumber: number): void {
  if (!Number.isSafeInteger(frameNumber) || int32(frameNumber) !== frameNumber) {
    throw new RangeError("frame number must be a signed 32-bit integer");
  }
}

function requireChannelVolume(volume: number): void {
  if (!Number.isInteger(volume) || volume < 0 || volume > 255) {
    throw new RangeError("channel volume must be an integer from 0 through 255");
  }
}

function requireGain(gain: number, name: string): void {
  if (!Number.isFinite(gain) || gain < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number`);
  }
}

function checkedSample(samples: Int16Array, index: number): number {
  const sample = samples[index];
  if (sample === undefined) {
    throw new Error(`PCM sample index ${index} is outside ${samples.length} samples`);
  }
  return sample;
}

function checkedPaint(paint: Int32Array, index: number): number {
  const sample = paint[index];
  if (sample === undefined) {
    throw new Error(`paint index ${index} is outside ${paint.length} values`);
  }
  return sample;
}

function addPaint(paint: Int32Array, index: number, contribution: number): void {
  paint[index] = int32(checkedPaint(paint, index) + contribution);
}

function addFloatPaint(paint: Int32Array, index: number, contribution: number): void {
  const sum = Math.fround(Math.fround(checkedPaint(paint, index)) + Math.fround(contribution));
  paint[index] = int32(Math.trunc(sum));
}

function checkedRaw(samples: Int32Array, index: number): number {
  const sample = samples[index];
  if (sample === undefined) {
    throw new Error(`raw sample index ${index} is outside ${samples.length} values`);
  }
  return sample;
}

function validateSound(sound: PcmSound, allowStereo: boolean): void {
  requirePositiveInteger(sound.sampleRate, "PCM sample rate");
  if (allowStereo) {
    if (!Number.isSafeInteger(sound.frameCount) || sound.frameCount < 0) {
      throw new RangeError("PCM frame count must be a nonnegative safe integer");
    }
  } else requirePositiveInteger(sound.frameCount, "PCM frame count");
  if (sound.channels !== 1 && sound.channels !== 2) {
    throw new RangeError("PCM channel count must be one or two");
  }
  if (!allowStereo && sound.channels !== 1) {
    throw new RangeError("sound effects must be mono, matching Quake S_LoadSound");
  }
  const expectedSamples = sound.frameCount * sound.channels;
  if (!Number.isSafeInteger(expectedSamples) || sound.samples.length !== expectedSamples) {
    throw new RangeError(
      `PCM has ${sound.samples.length} samples, expected ${expectedSamples}`,
    );
  }
  if (
    sound.loopStart !== null
    && (!Number.isSafeInteger(sound.loopStart)
      || sound.loopStart < 0
      || sound.loopStart >= sound.frameCount)
  ) {
    throw new RangeError("PCM loop start is outside the sound");
  }
}

/** S_SpatializeOrigin, including the source mono-output branch. */
export function spatializeSoundOrigin(position: Vec3, listenerOrigin: Vec3, listenerAxis: Axis,
  volume: number, channels: 1 | 2): { readonly left: number; readonly right: number } {
  const source = sub3(position, listenerOrigin);
  const distance = length3(source);
  const direction = normalize3(source);
  const pan = -dot3(direction, listenerAxis[1]);
  const distanceBeyondFullVolume = Math.max(0, Math.fround(distance - SOUND_FULLVOLUME));
  const distanceLoss = Math.fround(distanceBeyondFullVolume * SOUND_ATTENUATE);
  const rightScale = channels === 1 ? 1 : Math.max(0, Math.fround(0.5 * (1 + pan)));
  const leftScale = channels === 1 ? 1 : Math.max(0, Math.fround(0.5 * (1 - pan)));
  const right = Math.max(0, Math.trunc(Math.fround(volume * Math.fround((1 - distanceLoss) * rightScale))));
  const left = Math.max(0, Math.trunc(Math.fround(volume * Math.fround((1 - distanceLoss) * leftScale))));
  return { left, right };
}

/** PCM mixing with a borrowed allocation clock and no device ownership. */
export class AudioMixer {
  readonly outputRate: number;
  readonly capacity: number;
  readonly rawCapacity = RAW_SAMPLE_CAPACITY;

  private effectsVolume = 0.8;
  private musicVolume = 0.25;
  private dopplerEnabled = true;
  private listenerEntity = 0;
  private listenerOrigin: Vec3 = vec3(0, 0, 0);
  private listenerAxis: Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  private readonly entityPositions: Vec3[] = Array.from(
    { length: MAX_GENTITIES },
    () => vec3(0, 0, 0),
  );
  private readonly voices: (OneShotVoice | null)[];
  private readonly freeChannels: number[];
  private readonly loops = new Map<number, LoopVoice>();
  private loopChannels: LoopMix[] = [];
  private readonly rawSamples = new Int32Array(RAW_SAMPLE_CAPACITY * 2);
  private paintedTime = 0;
  private soundTime = 0;
  private rawEndTime = 0;
  private enabled = true;
  private soundCvars: CvarRegistry | null = null;
  private consoleOutput: ConsoleOutput | null = null;
  private soundMemory: MixerSoundMemory | null = null;

  constructor(outputRate: number, private readonly milliseconds: () => number, capacity = 96,
    readonly outputChannels: 1 | 2 = 2) {
    requirePositiveInteger(outputRate, "output rate");
    requirePositiveInteger(capacity, "channel capacity");
    this.outputRate = outputRate;
    this.capacity = capacity;
    this.voices = Array.from({ length: capacity }, () => null);
    this.freeChannels = Array.from({ length: capacity }, (_, index) => index);
  }

  get sampleClock(): number {
    return this.paintedTime;
  }

  get soundClock(): number { return this.soundTime; }

  get playbackEnabled(): boolean { return this.enabled; }
  setPlaybackEnabled(enabled: boolean): void { this.enabled = enabled; }
  bindSoundCvars(cvars: CvarRegistry): void { this.soundCvars = cvars; }
  bindConsoleOutput(output: ConsoleOutput): void { this.consoleOutput = output; }
  bindSoundMemory(memory: MixerSoundMemory): void { this.soundMemory = memory; }

  /** S_Update walks the actual one-shot slots, excluding silent channels and loops. */
  *channelVolumes(): Generator<{ readonly sound: PcmSound; readonly left: number; readonly right: number }, void, unknown> {
    for (const voice of this.voices) {
      if (voice === null || (voice.stereoVolume.left === 0 && voice.stereoVolume.right === 0)) continue;
      yield { sound: voice.prepared.sound, ...voice.stereoVolume };
    }
  }

  /** S_GetSoundtime selects paint time even when S_Update_ subsequently skips its scan. */
  selectTime(soundTime: number, paintTime: number): void {
    if (!Number.isSafeInteger(soundTime) || soundTime < this.soundTime || !Number.isSafeInteger(paintTime)) {
      throw new RangeError("sound time must advance monotonically and paint time must be a safe integer");
    }
    this.soundTime = soundTime;
    this.paintedTime = paintTime;
  }

  /** After S_StopAllSounds, move the delivered cursor and paint clock into the same SDL epoch. */
  rebaseTime(deliveredTime: number): number {
    if (!Number.isSafeInteger(deliveredTime) || deliveredTime <= this.soundTime || deliveredTime < SOUND_TIME_EPOCH) {
      throw new RangeError("sound epoch rebase requires advancing delivery beyond a complete epoch");
    }
    const offset = Math.trunc(deliveredTime / SOUND_TIME_EPOCH) * SOUND_TIME_EPOCH;
    const paintTime = this.paintedTime - offset;
    if (!Number.isSafeInteger(paintTime)) throw new RangeError("rebased sound paint time must be a safe integer");
    this.soundTime = deliveredTime - offset;
    this.paintedTime = paintTime;
    // The raw PCM allocation survives the source stop, but its old absolute-frame
    // tags cannot establish overwritten history in this new clock epoch.
    return this.soundTime;
  }

  get rawEnd(): number {
    return this.rawEndTime;
  }

  /** S_GetRawSamplePointer returns the live interleaved sample-pair allocation. */
  getRawSamplePointer(): Int32Array { return this.rawSamples; }

  setListener(entity: number, origin: Vec3, axis: Axis): void {
    if (!this.enabled) return;
    if (!Number.isInteger(entity) || int32(entity) !== entity) {
      throw new RangeError("listener entity must be a signed 32-bit integer");
    }
    this.listenerEntity = entity;
    this.listenerOrigin = vec3(origin.x, origin.y, origin.z);
    this.listenerAxis = [
      vec3(axis[0].x, axis[0].y, axis[0].z),
      vec3(axis[1].x, axis[1].y, axis[1].z),
      vec3(axis[2].x, axis[2].y, axis[2].z),
    ];
    // S_Respatialize owns these cells; painting must not observe newer entity
    // positions until the next respatialization.
    for (const voice of this.voices) {
      if (voice !== null) voice.stereoVolume = this.spatialize(voice.entity, voice.origin, voice.volume);
    }
    this.loopChannels = this.collectLoopMixes();
  }

  /** S_UpdateEntityPosition writes the engine-lifetime loopSounds origin cell. */
  updateEntityPosition(entity: number, origin: Vec3): void {
    requireEntity(entity);
    this.entityPositions[entity] = vec3(origin.x, origin.y, origin.z);
  }

  setEffectsVolume(volume: number): void {
    const gain = Math.trunc(Math.fround(Math.fround(volume) * 255));
    if (!Number.isInteger(gain) || gain < -2147483648 || gain > 2147483647) {
      throw new RangeError("effects volume has an undefined signed-int gain conversion");
    }
    this.effectsVolume = Math.fround(volume);
  }

  setMusicVolume(volume: number): void {
    requireGain(volume, "music volume");
    this.musicVolume = volume;
  }

  /** Standalone setting; engine-owned mixers read their bound s_doppler during loop registration. */
  setDopplerEnabled(enabled: boolean): void {
    this.dopplerEnabled = enabled;
  }

  /** S_StartLocalSound delegates through S_StartSound with listener_number and NULL origin. */
  startLocalSound(sound: PcmSound, channel: number, sourceName: string | null = null): boolean {
    return this.startSound(sound, {
      entity: this.listenerEntity,
      channel,
      origin: { kind: "entity", entity: this.listenerEntity },
      volume: 127,
    }, sourceName);
  }

  startSound(sound: PcmSound, options: StartSoundOptions, sourceName: string | null = null): boolean {
    if (!this.enabled) return false;
    if (this.soundMemory === null) validateSound(sound, false);
    if (options.origin.kind === "fixed") {
      if (!Number.isInteger(options.entity) || int32(options.entity) !== options.entity) {
        throw new RangeError("fixed-origin entity must be a signed 32-bit integer");
      }
    } else if (!Number.isInteger(options.entity) || options.entity < 0 || options.entity > MAX_GENTITIES) {
      // S_StartSound accepts MAX_GENTITIES. A matching listener never reads
      // loopSounds; resolveOrigin checks bounds if later spatialization does.
      throw new RangeError(`entity must be an integer from 0 through ${MAX_GENTITIES}`);
    }
    requireChannel(options.channel);
    requireChannelVolume(options.volume);
    const prepared = this.prepare(sound);

    // S_StartSound prints after memory preparation, before either clock read or
    // duplicate/allocation decision, including sounds that will be dropped.
    if (this.diagnosticSetting("s_show") === 1) {
      if (sourceName === null || this.consoleOutput === null) throw new Error("Sound start diagnostics require a registered name and console output");
      this.consoleOutput.print(`${this.paintedTime} : ${sourceName}\n`);
      if (!this.enabled) throw new Error("Sound playback ended during start diagnostics");
    }

    const time = this.allocationTime();
    let sameSoundCount = 0;
    // The native loop increments ch and also indexes ch[i], reading beyond
    // s_channels. Scan each actual slot once instead of reproducing that UB.
    for (const voice of this.voices) {
      if (voice === null || voice.entity !== options.entity || voice.prepared.sound !== sound) continue;
      if (int32(time - voice.allocatedAt) < 50) return false;
      sameSoundCount++;
    }
    const allowed = options.entity === this.listenerEntity ? 8 : 4;
    if (sameSoundCount > allowed) return false;

    this.soundMemory?.touch(sound, time);

    const free = this.freeChannels.at(-1);
    const channel = free === undefined ? this.chooseVictim(options.entity, time) : free;
    // S_ChannelMalloc samples Com_Milliseconds again only for a free slot.
    if (free !== undefined) this.freeChannels.pop();
    const allocatedAt = free === undefined ? time : this.allocationTime();
    this.voices[channel] = {
      prepared,
      entity: options.entity,
      channel: options.channel,
      origin: options.origin.kind === "fixed"
        ? { kind: "fixed", position: vec3(options.origin.position.x, options.origin.position.y, options.origin.position.z) }
        : options.origin,
      volume: options.volume,
      stereoVolume: { left: options.volume, right: options.volume },
      start: { kind: "pending" },
      allocatedAt,
    };
    return true;
  }

  updateLoopingSound(sound: PcmSound, options: FrameLoopingSoundOptions): void {
    if (!this.enabled) return;
    if (this.soundMemory === null) validateSound(sound, false);
    requireEntity(options.entity);
    requireFrameNumber(options.frameNumber);
    const prepared = this.prepare(sound);
    if (prepared.outputFrames === 0) throw new RangeError("loop sound has length 0");
    const previous = this.loops.get(options.entity);
    const origin = vec3(options.origin.x, options.origin.y, options.origin.z);
    const velocity = vec3(options.velocity.x, options.velocity.y, options.velocity.z);
    this.entityPositions[options.entity] = origin;
    let doppler = false;
    let dopplerScale = 1;
    let oldDopplerScale = 1;
    const dopplerCvar = this.soundCvars?.get("s_doppler");
    if (this.soundCvars !== null && dopplerCvar === undefined) throw new Error("Missing sound cvar s_doppler");
    const dopplerEnabled = dopplerCvar === undefined ? this.dopplerEnabled : dopplerCvar.integerValue !== 0;
    if (dopplerEnabled && dot3(velocity, velocity) > 0) {
      doppler = true;
      const listenerPosition = this.positionForEntity(this.listenerEntity);
      const before = sub3(listenerPosition, origin);
      const after = sub3(listenerPosition, add3(origin, velocity));
      const distanceBefore = dot3(before, before);
      const distanceAfter = dot3(after, after);
      // The source resets dopplerScale to 1 before reading it into oldDopplerScale.
      if (previous !== undefined && ((previous.frameNumber + 1) | 0) === options.frameNumber) oldDopplerScale = 1;
      dopplerScale = Math.fround(distanceAfter / Math.fround(distanceBefore * Math.fround(100)));
      if (dopplerScale <= 1) doppler = false;
    }
    this.loops.set(options.entity, {
      prepared, entity: options.entity, velocity, volume: 127,
      lifetime: "frame", active: true, doppler, dopplerScale, oldDopplerScale,
      frameNumber: options.frameNumber,
    });
  }

  /** S_AddRealLoopingSound survives frame clears, uses source volume 90, and never Dopplers. */
  updateRealLoopingSound(sound: PcmSound, options: RealLoopingSoundOptions): void {
    if (!this.enabled) return;
    if (this.soundMemory === null) validateSound(sound, false);
    requireEntity(options.entity);
    const prepared = this.prepare(sound);
    if (prepared.outputFrames === 0) throw new RangeError("loop sound has length 0");
    const previous = this.loops.get(options.entity);
    const origin = vec3(options.origin.x, options.origin.y, options.origin.z);
    this.entityPositions[options.entity] = origin;
    this.loops.set(options.entity, {
      prepared, entity: options.entity,
      velocity: vec3(options.velocity.x, options.velocity.y, options.velocity.z), volume: 90,
      lifetime: "persistent", active: true, doppler: false,
      dopplerScale: previous === undefined ? 1 : previous.dopplerScale,
      oldDopplerScale: previous === undefined ? 1 : previous.oldDopplerScale,
      frameNumber: previous === undefined ? 0 : previous.frameNumber,
    });
  }

  /** S_ClearLoopingSounds does not stop one-shots or the raw music/cinematic stream. */
  clearLoopingSounds(killAll: boolean): void {
    for (const [entity, loop] of this.loops) {
      if (killAll || loop.lifetime === "frame" || loop.prepared.outputFrames === 0) this.loops.set(entity, { ...loop, active: false });
    }
    this.loopChannels = [];
  }

  stopLoopingSound(entity: number): void {
    requireEntity(entity);
    const loop = this.loops.get(entity);
    if (loop !== undefined) this.loops.set(entity, { ...loop, active: false });
  }

  stopEntity(entity: number): void {
    requireEntity(entity);
    for (const [index, voice] of this.voices.entries()) {
      if (voice !== null && voice.entity === entity) this.freeChannel(index);
    }
    this.stopLoopingSound(entity);
  }

  stopAll(): void {
    this.resetChannels();
    this.loops.clear();
    this.loopChannels = [];
    this.entityPositions.fill(vec3(0, 0, 0));
    this.clearRaw();
  }

  /** S_ClearSoundBuffer resets loop cells and S_ChannelSetup, without moving painted time. */
  clearSoundBuffer(): void {
    this.loops.clear();
    this.loopChannels = [];
    this.entityPositions.fill(vec3(0, 0, 0));
    this.resetChannels();
    this.rawEndTime = 0;
  }

  clearRaw(): void {
    this.rawEndTime = this.paintedTime;
  }

  /** CIN_PlayCinematic and pre-INFO stereo reset s_rawend to s_soundtime. */
  resetRawToSoundTime(): void { this.rawEndTime = this.soundTime; }

  /** S_StopBackgroundTrack ends raw playback without clearing ordinary sound channels. */
  stopRaw(): void { this.rawEndTime = 0; }

  /** Queues decoded mono or stereo PCM through Quake's raw streaming path. */
  queueRaw(sound: PcmSound, volume: number): void {
    if (!this.enabled) return;
    validateSound(sound, true);
    requireGain(volume, "raw volume");
    const integerVolume = Math.trunc(Math.fround(256 * Math.fround(volume)));
    if (!Number.isInteger(integerVolume) || int32(integerVolume) !== integerVolume) {
      throw new RangeError("raw volume has an undefined signed-int gain conversion");
    }
    this.beginRawWrite();
    const outputFrames = this.rawOutputFrames(sound);
    this.appendRaw(sound, integerVolume, outputFrames);
    if (this.rawEndTime > this.soundTime + RAW_SAMPLE_CAPACITY) {
      this.rawDebugPrint(`S_RawSamples: overflowed ${this.rawEndTime} > ${this.soundTime}\n`);
    }
  }

  /** S_RawSamples before PCM normalization, including signed stereo byte samples. */
  queueRawBytes(samples: number, rate: number, width: number, channels: number, data: Uint8Array, volume: number): void {
    if (!this.enabled) return;
    if (!Number.isInteger(samples) || int32(samples) !== samples || !Number.isInteger(rate) || rate <= 0) {
      throw new RangeError("Raw sample count and rate require source signed integers and a positive rate");
    }
    let integerVolume = Math.trunc(Math.fround(256 * Math.fround(volume)));
    if (!Number.isInteger(integerVolume) || int32(integerVolume) !== integerVolume) throw new RangeError("raw volume has an undefined signed-int gain conversion");
    this.beginRawWrite();
    if ((channels === 1 || channels === 2) && (width === 1 || width === 2)) {
      const scale = Math.fround(rate / this.outputRate);
      if (width === 1) integerVolume = Math.imul(integerVolume, 256);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let index = 0; ; index++) {
        const source = channels === 2 && width === 2 && scale === 1 ? index : Math.trunc(Math.fround(index * scale));
        if (source >= samples) break;
        const destination = this.rawEndTime & (RAW_SAMPLE_CAPACITY - 1);
        this.rawEndTime++;
        const sourceIndex = source * channels;
        const sample = (index: number): number => width === 2 ? view.getInt16(index * 2, true)
          : channels === 2 ? view.getInt8(index) : view.getUint8(index) - 128;
        this.rawSamples[destination * 2] = Math.imul(sample(sourceIndex), integerVolume);
        this.rawSamples[destination * 2 + 1] = Math.imul(sample(sourceIndex + channels - 1), integerVolume);
      }
    }
    if (this.rawEndTime > this.soundTime + RAW_SAMPLE_CAPACITY) {
      this.rawDebugPrint(`S_RawSamples: overflowed ${this.rawEndTime} > ${this.soundTime}\n`);
    }
  }

  private rawOutputFrames(sound: PcmSound): number {
    const scale = Math.fround(sound.sampleRate / this.outputRate);
    if (sound.channels === 2 && scale === 1) return sound.frameCount;
    let outputFrames = Math.ceil(sound.frameCount / scale);
    if (!Number.isSafeInteger(outputFrames)) throw new RangeError("resampled raw PCM frame count is outside the supported range");
    while (outputFrames > 0 && Math.trunc(Math.fround((outputFrames - 1) * scale)) >= sound.frameCount) outputFrames--;
    while (Math.trunc(Math.fround(outputFrames * scale)) < sound.frameCount) {
      outputFrames++;
      if (!Number.isSafeInteger(outputFrames)) throw new RangeError("resampled raw PCM frame count is outside the supported range");
    }
    return outputFrames;
  }

  private beginRawWrite(): void {
    if (this.rawEndTime < this.soundTime) {
      this.rawDebugPrint(`S_RawSamples: resetting minimum: ${this.rawEndTime} < ${this.soundTime}\n`);
      this.rawEndTime = this.soundTime;
    }
  }

  private rawDebugPrint(text: string): void {
    const developer = this.soundCvars?.get("developer");
    if (developer === undefined || developer.integerValue === 0) return;
    if (this.consoleOutput === null) throw new Error("Raw sound diagnostics require console output");
    this.consoleOutput.print(text);
  }

  private appendRaw(sound: PcmSound, integerVolume: number, count: number): void {
    if (!Number.isSafeInteger(this.rawEndTime + count)) throw new RangeError("raw PCM end frame is outside the supported range");
    const scale = Math.fround(sound.sampleRate / this.outputRate);
    for (let offset = 0; offset < count; offset++) {
      const sourceFrame = sound.channels === 2 && scale === 1 ? offset : Math.trunc(Math.fround(offset * scale));
      const destination = this.rawEndTime & (RAW_SAMPLE_CAPACITY - 1);
      this.rawEndTime += 1;
      const sourceIndex = sourceFrame * sound.channels;
      const left = checkedSample(sound.samples, sourceIndex);
      const right = sound.channels === 1
        ? left
        : checkedSample(sound.samples, sourceIndex + 1);
      this.rawSamples[destination * 2] = Math.imul(left, integerVolume);
      this.rawSamples[destination * 2 + 1] = Math.imul(right, integerVolume);
    }
  }

  queueMusic(sound: PcmSound): void {
    this.queueRaw(sound, this.musicVolume);
  }

  /** Numeric calls consume directly; explicit ranges paint without advancing device sound time. */
  mix(request: number | SoundPaintRange): Int16Array {
    const startFrame = typeof request === "number" ? this.paintedTime : request.startFrame;
    const frames = typeof request === "number" ? request : request.endFrame - request.startFrame;
    if (!Number.isSafeInteger(startFrame)) {
      throw new RangeError("paint start frame must be a safe integer");
    }
    if (!Number.isSafeInteger(frames) || frames < 0) {
      throw new RangeError("mix frame count must be a nonnegative safe integer");
    }
    const sampleCount = frames * 2;
    if (!Number.isSafeInteger(sampleCount)) {
      throw new RangeError("mix output is too large");
    }
    const endFrame = startFrame + frames;
    if (!Number.isSafeInteger(endFrame)) throw new RangeError("paint end frame is outside the supported range");
    if (typeof request === "number" && endFrame < this.soundTime) throw new RangeError("direct consumption cannot rewind sound time");
    const output = new Int16Array(sampleCount);
    this.paintedTime = startFrame;
    this.scanChannelStarts();
    const effectsGain = Math.trunc(Math.fround(Math.fround(this.effectsVolume) * 255));

    while (this.paintedTime < endFrame) {
      const count = Math.min(PAINTBUFFER_SIZE, endFrame - this.paintedTime);
      const paint = new Int32Array(count * 2);
      this.paintRaw(paint, count);

      for (const voice of this.voices) {
        if (voice === null) continue;
        if (voice.start.kind === "pending") throw new Error("Channel scan left a pending sound");
        const stereoVolume = voice.stereoVolume;
        if (stereoVolume.left === 0 && stereoVolume.right === 0) continue;
        const firstOffset = this.paintedTime - voice.start.sample;
        for (let outputFrame = 0; outputFrame < count; outputFrame++) {
          const soundFrame = firstOffset + outputFrame;
          if (soundFrame < 0 || soundFrame >= voice.prepared.outputFrames) continue;
          const sample = this.effectSample(voice.prepared, soundFrame);
          this.paintEffect(paint, outputFrame, sample, stereoVolume, effectsGain);
        }
      }

      for (const loop of this.loopChannels) {
        if (this.soundMemory !== null && (!this.soundMemory.hasData(loop.prepared.sound) || loop.prepared.outputFrames === 0)) continue;
        this.paintLoop(paint, count, loop, effectsGain);
      }

      // S_TransferPaintBuffer replaces each completed source paint block.
      if (this.diagnosticSetting("s_testsound") !== 0) {
        for (let frame = 0; frame < count; frame++) {
          const sample = Math.trunc(Math.sin((this.paintedTime + frame) * 0.1) * 20000 * 256);
          paint[frame * 2] = sample;
          paint[frame * 2 + 1] = sample;
        }
      }

      const outputOffset = (this.paintedTime - startFrame) * 2;
      writeLinearBlastStereo16(paint, output.subarray(outputOffset), paint.length);
      this.paintedTime += count;
    }

    if (typeof request === "number") this.soundTime = endFrame;
    return output;
  }

  private diagnosticSetting(name: string): number {
    if (this.soundCvars === null) return 0;
    const setting = this.soundCvars.get(name);
    if (setting === undefined) throw new Error(`Missing sound cvar ${name}`);
    return setting.integerValue;
  }

  private prepare(sound: PcmSound): PreparedSound {
    if (this.soundMemory !== null) {
      const memory = this.soundMemory;
      memory.frameCount(sound);
      return { sound, step256: 256, get outputFrames() { return memory.frameCount(sound); } };
    }
    const scale = Math.fround(sound.sampleRate / this.outputRate);
    const outputFrames = Math.trunc(Math.fround(Math.fround(sound.frameCount) / scale));
    if (!Number.isSafeInteger(outputFrames) || outputFrames < 0) {
      throw new RangeError("resampled PCM frame count is outside the supported range");
    }
    return {
      sound,
      step256: Math.trunc(scale * 256),
      outputFrames,
    };
  }

  private allocationTime(): number {
    const time = this.milliseconds();
    if (!Number.isInteger(time) || int32(time) !== time) throw new RangeError("sound allocation clock requires signed-int milliseconds");
    return time;
  }

  private resetChannels(): void {
    this.voices.fill(null);
    this.freeChannels.length = 0;
    for (let index = 0; index < this.capacity; index++) this.freeChannels.push(index);
    this.rawDebugPrint("Channel memory manager started\n");
  }

  private freeChannel(index: number): void {
    this.voices[index] = null;
    this.freeChannels.push(index);
  }

  /** S_ScanChannelStarts is separate from clock selection, including no-paint updates. */
  scanChannelStarts(): boolean {
    let newSamples = false;
    for (const [index, voice] of this.voices.entries()) {
      if (voice === null) continue;
      if (voice.start.kind === "pending") {
        this.voices[index] = { ...voice, start: { kind: "started", sample: this.paintedTime } };
        newSamples = true;
      } else if (voice.start.sample + voice.prepared.outputFrames <= this.paintedTime) {
        this.freeChannel(index);
      }
    }
    return newSamples;
  }

  private chooseVictim(entity: number, time: number): number {
    let victim: number | null = null;
    let oldest = time;
    for (const [index, voice] of this.voices.entries()) {
      if (voice === null || voice.entity === this.listenerEntity || voice.entity !== entity || voice.channel === 7) continue;
      if (voice.allocatedAt < oldest) { oldest = voice.allocatedAt; victim = index; }
    }
    if (victim !== null) return victim;
    for (const [index, voice] of this.voices.entries()) {
      if (voice === null || voice.entity === this.listenerEntity || voice.channel === 7) continue;
      if (voice.allocatedAt < oldest) { oldest = voice.allocatedAt; victim = index; }
    }
    if (victim !== null) return victim;
    // Native code reads one-past-end ch->entnum before its listener fallback.
    // Its result, including whether it drops the sound, is undefined.
    throw new Error("S_StartSound reached the undefined native listener fallback");
  }

  private positionForEntity(entity: number): Vec3 {
    const position = this.entityPositions[entity];
    if (position === undefined) throw new Error(`Missing source sound position for entity ${entity}`);
    return position;
  }

  private resolveOrigin(origin: VoiceOrigin): Vec3 {
    switch (origin.kind) {
      case "local":
        return this.listenerOrigin;
      case "fixed":
        return origin.position;
      case "entity":
        requireEntity(origin.entity);
        return this.positionForEntity(origin.entity);
    }
  }

  private spatialize(entity: number, origin: VoiceOrigin, volume: number): StereoVolume {
    if (origin.kind === "local" || entity === this.listenerEntity) {
      return { left: volume, right: volume };
    }
    const position = this.resolveOrigin(origin);
    return this.spatializeOrigin(position, volume);
  }

  private spatializeOrigin(position: Vec3, volume: number): StereoVolume {
    return spatializeSoundOrigin(position, this.listenerOrigin, this.listenerAxis, volume, this.outputChannels);
  }

  private effectSample(prepared: PreparedSound, outputFrame: number): number {
    if (this.soundMemory !== null) return this.soundMemory.sample(prepared.sound, outputFrame);
    const sourceFrame = Math.trunc(outputFrame * prepared.step256 / 256);
    return checkedSample(prepared.sound.samples, sourceFrame);
  }

  private paintLoop(paint: Int32Array, frames: number, loop: LoopMix, effectsGain: number): void {
    let outputFrame = 0;
    while (outputFrame < frames) {
      const absoluteFrame = this.paintedTime + outputFrame;
      const sampleOffset = absoluteFrame % loop.prepared.outputFrames;
      const count = Math.min(frames - outputFrame, loop.prepared.outputFrames - sampleOffset);
      if (!loop.doppler || loop.dopplerScale === 1) {
        for (let index = 0; index < count; index++) {
          if (sampleOffset + index < 0) throw new RangeError("loop sound reached an invalid negative sample access");
          const sample = this.effectSample(loop.prepared, sampleOffset + index);
          this.paintEffect(paint, outputFrame + index, sample,
            { left: loop.leftVolume, right: loop.rightVolume }, effectsGain);
        }
      } else {
        this.paintDopplerLoop(paint, outputFrame, count, sampleOffset, loop, effectsGain);
      }
      outputFrame += count;
    }
  }

  private paintDopplerLoop(
    paint: Int32Array,
    outputFrame: number,
    count: number,
    sourceOffset: number,
    loop: LoopMix,
    effectsGain: number,
  ): void {
    const scaledOffset = Math.trunc(Math.fround(Math.fround(sourceOffset) * loop.oldDopplerScale));
    const chunkCount = Math.ceil(loop.prepared.outputFrames / SND_CHUNK_SIZE);
    let chunk = scaledOffset < 0 ? 0 : Math.trunc(scaledOffset / SND_CHUNK_SIZE) % chunkCount;
    let offset = Math.fround(scaledOffset < 0 ? scaledOffset : scaledOffset % SND_CHUNK_SIZE);
    const leftVolume = Math.fround(Math.imul(loop.leftVolume, effectsGain));
    const rightVolume = Math.fround(Math.imul(loop.rightVolume, effectsGain));
    for (let index = 0; index < count; index++) {
      const first = Math.trunc(offset);
      offset = Math.fround(offset + loop.dopplerScale);
      const last = Math.trunc(offset);
      let sampleTotal = 0;
      for (let source = first; source < last; source++) {
        if (source === SND_CHUNK_SIZE) {
          chunk = (chunk + 1) % chunkCount;
          offset = Math.fround(offset - SND_CHUNK_SIZE);
        }
        sampleTotal = Math.fround(sampleTotal + this.dopplerSample(loop.prepared, chunk, source));
      }
      const divisor = Math.fround(Math.imul(256, last - first));
      const leftContribution = Math.fround(Math.fround(sampleTotal * leftVolume) / divisor);
      const rightContribution = Math.fround(Math.fround(sampleTotal * rightVolume) / divisor);
      addFloatPaint(paint, (outputFrame + index) * 2, leftContribution);
      addFloatPaint(paint, (outputFrame + index) * 2 + 1, rightContribution);
    }
  }

  private dopplerSample(prepared: PreparedSound, chunk: number, sampleOffset: number): number {
    const outputFrame = chunk * SND_CHUNK_SIZE + (sampleOffset & (SND_CHUNK_SIZE - 1));
    if (this.soundMemory !== null) return this.soundMemory.sample(prepared.sound, outputFrame);
    // The source reads uninitialized tail storage in the final sndBuffer when
    // Doppler outruns soundLength. Deterministic mixing explicitly stabilizes
    // that undefined memory as zero.
    if (outputFrame >= prepared.outputFrames) return 0;
    return this.effectSample(prepared, outputFrame);
  }

  private paintEffect(
    paint: Int32Array,
    outputFrame: number,
    sample: number,
    volume: StereoVolume,
    effectsGain: number,
  ): void {
    const leftGain = Math.imul(volume.left, effectsGain);
    const rightGain = Math.imul(volume.right, effectsGain);
    addPaint(paint, outputFrame * 2, Math.imul(sample, leftGain) >> 8);
    addPaint(paint, outputFrame * 2 + 1, Math.imul(sample, rightGain) >> 8);
  }

  private collectLoopMixes(): LoopMix[] {
    this.loopChannels = [];
    const time = this.soundMemory === null ? null : this.allocationTime();
    const mixes: LoopMix[] = [];
    const loops = [...this.loops.values()].filter(loop => loop.active).sort((left, right) => left.entity - right.entity);
    const merged = new Set<number>();
    for (let index = 0; index < loops.length; index++) {
      const loop = loops[index];
      if (loop === undefined || merged.has(loop.entity)) continue;
      const volume = this.spatializeOrigin(this.positionForEntity(loop.entity), loop.volume);
      if (time !== null) this.soundMemory?.touch(loop.prepared.sound, time);
      let leftVolume = volume.left;
      let rightVolume = volume.right;
      for (let later = index + 1; later < loops.length; later++) {
        const candidate = loops[later];
        if (candidate === undefined || candidate.doppler || candidate.prepared.sound !== loop.prepared.sound) continue;
        merged.add(candidate.entity);
        const candidateVolume = this.spatializeOrigin(this.positionForEntity(candidate.entity), candidate.volume);
        if (time !== null) this.soundMemory?.touch(candidate.prepared.sound, time);
        leftVolume += candidateVolume.left;
        rightVolume += candidateVolume.right;
      }
      if (leftVolume === 0 && rightVolume === 0) continue;
      mixes.push({ prepared: loop.prepared, leftVolume: Math.min(255, leftVolume), rightVolume: Math.min(255, rightVolume),
        doppler: loop.doppler, dopplerScale: loop.dopplerScale, oldDopplerScale: loop.oldDopplerScale });
      if (mixes.length === this.capacity) break;
    }
    return mixes;
  }

  private paintRaw(paint: Int32Array, frames: number): void {
    const stop = Math.min(this.paintedTime + frames, this.rawEndTime);
    for (let absoluteFrame = this.paintedTime; absoluteFrame < stop; absoluteFrame++) {
      const outputFrame = absoluteFrame - this.paintedTime;
      const rawIndex = absoluteFrame & (RAW_SAMPLE_CAPACITY - 1);
      paint[outputFrame * 2] = checkedRaw(this.rawSamples, rawIndex * 2);
      paint[outputFrame * 2 + 1] = checkedRaw(this.rawSamples, rawIndex * 2 + 1);
    }
  }
}
