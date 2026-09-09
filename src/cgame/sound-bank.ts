// Sound registration from id Software's code/client/snd_dma.c and snd_mem.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { readWavInfo } from "../assets/wav.ts";
import type { PcmSound, WavInfo } from "../assets/wav.ts";
import type { AssetReader } from "../assets/reader.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "../assets/read-file-memory.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import type { MixerSoundMemory } from "../audio/mixer.ts";
import { SourceSoundResampler } from "../audio/source-paint.ts";
import { int32 } from "../core/numeric.ts";
import { CommonError } from "../core/common-error.ts";

const SOUND_CHUNK_SAMPLES = 1024;
// release32 sndBuffer: 2048 PCM bytes, next pointer, size and padded ADPCM state.
const SOUND_CHUNK_BYTES = 2060;

interface SoundPool {
  readonly storage: ArrayBuffer;
  readonly free: Int16Array[];
  readonly sampleRate: () => number;
  readonly milliseconds: () => number;
  totalAllocated: number;
}

export interface SoundAssetReader extends AssetReader {
  readSync(path: string): Uint8Array;
}

interface SoundEntry {
  readonly name: string; readonly index: number;
  sound: PcmSound | null; inMemory: boolean; defaultSound: boolean; pending: Promise<PcmSound | null> | null;
  readonly chunks: Int16Array[];
  soundLength: number;
  sampleRate: number;
  lastTimeUsed: number;
}
function key(name: string): string {
  return name.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
}
function sourceName(path: string): string {
  const nul = path.indexOf("\0");
  return nul < 0 ? path : path.slice(0, nul);
}

/** S_HashSFXName folds ASCII case and path separators, and stops at the first dot. */
export function hashSoundName(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    let letter = name.charCodeAt(index);
    if (letter === 0 || letter === 46) break;
    if (letter > 255) throw new RangeError("Sound name requires source byte characters");
    if (letter >= 65 && letter <= 90) letter += 32;
    if (letter === 92) letter = 47;
    if (letter >= 128) letter -= 256;
    hash = (hash + Math.imul(letter, index + 119)) | 0;
  }
  return hash & 127;
}

/** Registered identities survive eviction; the engine mixer reads their current chunks. */
export class ClientSoundBank implements MixerSoundMemory {
  private readonly entries = new Map<number, SoundEntry[]>();
  private readonly slots: SoundEntry[] = [];
  private readonly decodedEntries = new WeakMap<PcmSound, SoundEntry>();
  private registrationEnabled = true;
  private registrationGeneration = 0;
  private zeroEntry: SoundEntry | null = null;
  private pool: SoundPool | null = null;
  constructor(private readonly assets: RetainedFileReader,
    private readonly imports: { print(text: string): void; debugPrint(text: string): undefined },
    private readonly memory: HunkAccountingProfile = { kind: "unaccounted" }) {}

  get memoryStarted(): boolean { return this.pool !== null; }

  /** SND_setup. Unbound format-inspection banks keep their decoded PCM ownership. */
  initializeMemory(options: { readonly chunkCount: number; readonly sampleRate: () => number; readonly milliseconds: () => number }): void {
    if (this.pool !== null) return;
    if (this.slots.length !== 0) throw new Error("Sound memory must initialize before source sound slots");
    if (!Number.isSafeInteger(options.chunkCount) || options.chunkCount <= 0) throw new RangeError("Sound memory requires a positive source chunk count");
    // New backing is zeroed by ECMAScript; reused sample tails persist. Free-list
    // links are typed ownership, not native pointer bytes overlaid on PCM.
    const storage = new ArrayBuffer(options.chunkCount * SOUND_CHUNK_BYTES);
    const free = Array.from({ length: options.chunkCount }, (_, index) => new Int16Array(storage, index * SOUND_CHUNK_BYTES, SOUND_CHUNK_SAMPLES));
    this.pool = { storage, free, sampleRate: options.sampleRate, milliseconds: options.milliseconds, totalAllocated: 0 };
    const generation = this.registrationGeneration;
    this.imports.print("Sound memory manager started\n");
    this.assertRegistration(generation);
  }

  memoryUsage(): { readonly freeBytes: number; readonly totalAllocatedBytes: number } | null {
    return this.pool === null ? null : {
      freeBytes: this.pool.free.length * SOUND_CHUNK_BYTES,
      totalAllocatedBytes: this.pool.totalAllocated,
    };
  }

  frameCount(sound: PcmSound): number { return this.sourceEntry(sound).soundLength; }
  hasData(sound: PcmSound): boolean { return this.sourceEntry(sound).chunks.length !== 0; }
  sample(sound: PcmSound, frame: number): number { return this.chunkSample(this.sourceEntry(sound), frame); }
  touch(sound: PcmSound, milliseconds: number): undefined {
    this.sourceEntry(sound).lastTimeUsed = milliseconds;
  }

  /** Active but uncalled S_DefaultSound, operating on the bank's real retained slot. */
  defaultSound(index: number): void {
    if (!Number.isInteger(index)) throw new RangeError("Sound slot requires an integer");
    const entry = this.slots[index], pool = this.pool;
    if (entry === undefined || pool === null) throw new RangeError("Default sound requires an allocated source sound slot and pool");
    entry.soundLength = 512;
    const next = this.allocateChunk(pool);
    entry.chunks.length = 0;
    entry.chunks.push(next);
    for (let sample = 0; sample < 512; sample++) next[sample] = sample;
    entry.sampleRate = pool.sampleRate();
    this.publishPcm(entry);
  }

  private sourceEntry(sound: PcmSound): SoundEntry {
    if (this.pool === null) throw new Error("Source sound memory is not initialized");
    const entry = this.decodedEntries.get(sound);
    if (entry === undefined) throw new Error("Sound does not belong to this source memory owner");
    return entry;
  }

  private chunkSample(entry: SoundEntry, frame: number): number {
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Invalid source sound sample index");
    const chunk = entry.chunks[Math.trunc(frame / SOUND_CHUNK_SAMPLES)];
    const sample = chunk?.[frame % SOUND_CHUNK_SAMPLES];
    if (sample === undefined) throw new RangeError(`Sound ${entry.name} has no resident chunk for sample ${frame}`);
    return sample;
  }

  private memoryTime(pool: SoundPool): number {
    const generation = this.registrationGeneration;
    const time = pool.milliseconds();
    this.assertRegistration(generation);
    if (!Number.isInteger(time) || int32(time) !== time) throw new RangeError("Sound memory clock requires signed-int milliseconds");
    return time;
  }

  private allocateChunk(pool: SoundPool): Int16Array {
    while (pool.free.length === 0) {
      const victim = this.freeOldestSound(pool);
      // The original allocator spins forever once slot zero cannot release a chunk.
      if (pool.free.length === 0 && victim.index === 0) throw new Error("Sound memory exhausted without a reclaimable source chunk");
    }
    const chunk = pool.free.pop();
    if (chunk === undefined) throw new Error("Missing free sound chunk");
    pool.totalAllocated = int32(pool.totalAllocated + SOUND_CHUNK_BYTES);
    return chunk;
  }

  private freeOldestSound(pool: SoundPool): SoundEntry {
    let oldest = this.memoryTime(pool);
    let used = 0;
    for (let index = 1; index < this.slots.length; index++) {
      const entry = this.slots[index];
      if (entry === undefined) throw new Error("Missing source sound slot");
      if (entry.inMemory && entry.lastTimeUsed < oldest) { oldest = entry.lastTimeUsed; used = index; }
    }
    const entry = this.slots[used];
    if (entry === undefined) throw new Error("Sound memory exhausted without source slot zero");
    const generation = this.registrationGeneration;
    this.imports.debugPrint(`S_FreeOldestSound: freeing sound ${entry.name}\n`);
    this.assertRegistration(generation);
    for (const chunk of entry.chunks) pool.free.push(chunk);
    entry.inMemory = false;
    entry.chunks.length = 0;
    return entry;
  }

  private hasSoundData(entry: SoundEntry): boolean {
    return this.pool === null ? entry.sound !== null : entry.chunks.length !== 0;
  }

  setRegistrationEnabled(enabled: boolean): void {
    if (enabled !== this.registrationEnabled) this.registrationGeneration++;
    this.registrationEnabled = enabled;
  }

  /** S_Init clears lookup chains while retaining the source's existing s_knownSfx slots. */
  resetLookup(): void { this.entries.clear(); }

  registeredSounds(): readonly { readonly name: string; readonly sound: PcmSound | null; readonly inMemory: boolean; readonly soundLength: number; readonly lastTimeUsed: number }[] {
    return this.slots.map(entry => ({ name: entry.name, sound: entry.sound, inMemory: entry.inMemory,
      soundLength: this.pool === null ? entry.sound === null ? 0 : entry.sound.frameCount : entry.soundLength, lastTimeUsed: entry.lastTimeUsed }));
  }

  /** PCM handles retain their actual source entry across lookup-chain resets. */
  nameForSound(sound: PcmSound): string | null {
    return this.decodedEntries.get(sound)?.name ?? null;
  }

  /** VM handles share the source slots used by ordinary typed registrations. */
  indexForSound(sound: PcmSound | null): number {
    if (sound === null) return 0;
    const entry = this.decodedEntries.get(sound);
    if (entry === undefined) throw new RangeError("Sound does not belong to this registry");
    return entry.index;
  }

  /** Reached playback loads nonresident source slots without registration's default-handle substitution. */
  soundForIndex(index: number): PcmSound | null | undefined {
    if (!Number.isInteger(index)) throw new RangeError("Sound handle must be an integer");
    if (index < 0 || index >= this.slots.length) {
      // snd_dma.c passes S_COLOR_YELLOW as the whole format, leaving extra args unused.
      this.imports.print("^3");
      return undefined;
    }
    const entry = this.slots[index];
    if (entry === undefined) throw new RangeError("Sound handle has no source slot");
    this.ensureResident(entry);
    if (index === 0) return null;
    if (entry.sound === null) throw new RangeError("Sound handle has no decoded PCM");
    return entry.sound;
  }

  private find(path: string): SoundEntry | null {
    const name = sourceName(path);
    if (name.length >= 64) { this.imports.print("Sound name exceeds MAX_QPATH\n"); return null; }
    if (name.length === 0) throw new CommonError("fatal", "S_FindName: empty name\n");
    for (const character of name) if (character.charCodeAt(0) > 255) throw new RangeError("Sound name requires source byte characters");
    const identity = key(name);
    const hash = hashSoundName(name);
    let bucket = this.entries.get(hash);
    let entry = bucket?.find(candidate => key(candidate.name) === identity);
    if (entry === undefined) {
      if (this.slots.length === 4096) throw new CommonError("fatal", "S_FindName: out of sfx_t");
      entry = { name, index: this.slots.length, sound: null, inMemory: false, defaultSound: false, pending: null,
        chunks: [], soundLength: 0, sampleRate: 0, lastTimeUsed: 0 };
      if (bucket === undefined) { bucket = []; this.entries.set(hash, bucket); }
      bucket.unshift(entry);
      this.slots.push(entry);
      if (entry.index === 0) this.zeroEntry = entry;
    }
    return entry;
  }

  /** S_BeginRegistration reserves real hit.wav at source handle zero once per engine lifetime. */
  async beginRegistration(): Promise<void> {
    if (this.slots.length === 0) await this.registerSound("sound/feedback/hit.wav", false);
    else if (this.zeroEntry?.pending !== null && this.zeroEntry?.pending !== undefined) await this.zeroEntry.pending;
  }

  /** Only the engine audio trap resolves zero. Cgame's own `if (handle)` tests retain null. */
  resolveForPlayback(sound: PcmSound | null): PcmSound | null {
    const entry = sound === null ? this.zeroEntry : this.decodedEntries.get(sound);
    if (entry === null) return null;
    if (entry === undefined) {
      if (this.pool !== null) throw new Error("Sound does not belong to this source memory owner");
      return sound;
    }
    this.ensureResident(entry);
    return entry.sound;
  }

  private ensureResident(entry: SoundEntry): void {
    if (entry.inMemory || !this.registrationEnabled) return;
    if (entry.pending !== null) throw new Error(`Sound registration is still loading: ${entry.name}`);
    this.memoryLoad(entry);
  }

  private memoryLoad(entry: SoundEntry): void {
    const generation = this.registrationGeneration;
    const buffer = entry.name.startsWith("*") ? undefined : this.assets.readFileRetainedSync(entry.name);
    this.publish(entry, buffer, generation);
  }

  private handle(entry: SoundEntry): PcmSound | null {
    if (entry.defaultSound) {
      this.imports.print(`^3WARNING: could not find ${entry.name} - using default\n`);
      return null;
    }
    return entry.index === 0 ? null : entry.sound;
  }

  async registerSound(path: string | null, _compressed: boolean): Promise<PcmSound | null> {
    if (!this.registrationEnabled) return null;
    if (path === null) throw new Error("S_RegisterSound dereferences NULL name at strlen");
    const entry = this.find(path);
    if (entry === null) return null;
    if (this.hasSoundData(entry)) return this.handle(entry);
    if (entry.pending !== null) return entry.pending;
    entry.inMemory = false;
    const pending = this.load(entry);
    entry.pending = pending;
    try { return await pending; } finally { entry.pending = null; }
  }

  private async load(entry: SoundEntry): Promise<PcmSound | null> {
    const generation = this.registrationGeneration;
    const buffer = entry.name.startsWith("*") ? undefined : await this.assets.readFileRetained(entry.name);
    this.publish(entry, buffer, generation);
    return this.handle(entry);
  }

  private assertRegistration(generation: number): void {
    if (generation !== this.registrationGeneration) throw new Error("Sound registration lifetime ended during asset loading");
  }

  private publish(entry: SoundEntry, buffer: RetainedFileBuffer | undefined, generation: number): void {
    this.assertRegistration(generation);
    let sound: PcmSound | null = null;
    let samples: HunkAllocation | null = null;
    if (buffer !== undefined) {
      const info = readWavInfo(buffer.terminatedBytes, buffer.length, entry.name, text => {
        this.imports.print(text);
        this.assertRegistration(generation);
      });
      if (info.channels !== 1) {
        this.imports.print(`${entry.name} is a stereo wav file\n`);
        this.assertRegistration(generation);
      } else {
        if (info.sourceBytesPerSample === 1) {
          this.imports.debugPrint(`^3WARNING: ${entry.name} is a 8 bit wav file\n`);
          this.assertRegistration(generation);
        }
        if (info.sampleRate !== 22050) {
          this.imports.debugPrint(`^3WARNING: ${entry.name} is not a 22kHz wav file\n`);
          this.assertRegistration(generation);
        }
        // S_LoadSound reserves these bytes even in its uncompressed branch,
        // which does not read or write the temporary samples buffer.
        if (this.memory.kind === "source-hunk") {
          samples = this.memory.accounting.allocateTemp("S_LoadSound:samples", entry.name,
            info.frameCount * Int16Array.BYTES_PER_ELEMENT * 2);
        }
        if (this.pool === null) sound = info.decode();
        else {
          entry.lastTimeUsed = int32(this.memoryTime(this.pool) + 1);
          sound = this.loadChunks(entry, info, this.pool);
        }
      }
    }
    if (this.pool === null || sound !== null) entry.sound = sound;
    if (sound !== null) this.decodedEntries.set(sound, entry);
    if (samples !== null && this.memory.kind === "source-hunk") {
      this.memory.accounting.freeTemp("S_LoadSound:samples", entry.name, samples);
      this.assertRegistration(generation);
    }
    if (buffer !== undefined) {
      this.assets.freeFile(buffer);
      this.assertRegistration(generation);
    }
    if (sound === null) entry.defaultSound = true;
    entry.inMemory = true;
  }

  private loadChunks(entry: SoundEntry, info: WavInfo, pool: SoundPool): PcmSound {
    const rate = pool.sampleRate();
    if (!Number.isInteger(rate) || rate <= 0) throw new RangeError("Source sound memory requires a positive output rate");
    const resampler = new SourceSoundResampler(info.sampleRate, rate, info.frameCount);
    const frames = resampler.count;
    if (!Number.isInteger(frames) || frames < 0 || frames > 2147483647) throw new RangeError("Resampled sound length has an undefined signed-int conversion");
    entry.sampleRate = rate;
    entry.soundLength = frames;
    entry.chunks.length = 0;
    const sound = this.publishPcm(entry);
    let chunk: Int16Array | null = null;
    for (let frame = 0; frame < frames; frame++) {
      const source = resampler.sourceIndex(frame);
      const sample = info.sample(source);
      const part = frame & (SOUND_CHUNK_SAMPLES - 1);
      if (part === 0) {
        const next = this.allocateChunk(pool);
        // Slot-zero fallback may evict this partial chain. ResampleSfx retains
        // its local chunk, but does not restore the cleared sfx.soundData head.
        if (chunk === null || entry.chunks.at(-1) === chunk) entry.chunks.push(next);
        chunk = next;
      }
      if (chunk === null) throw new Error("Missing allocated sound chunk");
      chunk[part] = sample;
    }
    return sound;
  }

  private publishPcm(entry: SoundEntry): PcmSound {
    if (entry.sound === null) {
      const bank = this;
      entry.sound = {
        get sampleRate() { return entry.sampleRate; }, channels: 1, loopStart: null,
        get frameCount() { return entry.soundLength; },
        get samples() {
          if (!entry.inMemory && entry.chunks.length === 0) throw new Error(`Sound ${entry.name} is not resident`);
          const samples = new Int16Array(entry.soundLength);
          for (let frame = 0; frame < samples.length; frame++) samples[frame] = bank.chunkSample(entry, frame);
          return samples;
        },
      };
      this.decodedEntries.set(entry.sound, entry);
    }
    return entry.sound;
  }

  /** Source S_RegisterSound at synchronous first use, sharing the async decoded registry. */
  sound(path: string | null, _compressed: boolean): PcmSound | null {
    if (!this.registrationEnabled) return null;
    if (path === null) return null;
    const entry = this.find(path);
    if (entry === null) return null;
    if (entry.pending !== null) throw new Error(`Sound registration is still loading: ${entry.name}`);
    if (this.hasSoundData(entry)) return this.handle(entry);
    entry.inMemory = false;
    this.memoryLoad(entry);
    return this.handle(entry);
  }
}
