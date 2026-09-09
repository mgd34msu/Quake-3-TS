import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
import { describe, expect, test } from "bun:test";
import { ClientSoundBank, hashSoundName } from "../src/cgame/sound-bank.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { decodeWav } from "../src/assets/wav.ts";
import { existsSync } from "node:fs";
import { CommonEvents } from "../src/engine/common-events.ts";
import { vec3 } from "../src/core/math.ts";
import { CommonError } from "../src/core/common-error.ts";

function wav(channels = 1, sampleRate = 22050, bitsPerSample: 8 | 16 = 16): Uint8Array {
  const bytesPerSample = bitsPerSample / 8, sampleBytes = channels * 2 * bytesPerSample;
  const data = new Uint8Array(44 + sampleBytes), view = new DataView(data.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] satisfies readonly (readonly [number, string])[]) {
    for (let i = 0; i < text.length; i++) data[offset + i] = text.charCodeAt(i);
  }
  view.setUint32(4, data.length - 8, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, bitsPerSample, true);
  view.setUint32(40, sampleBytes, true);
  if (bitsPerSample === 8) { view.setUint8(44, 0); view.setUint8(45, 255); }
  else { view.setInt16(44, -123, true); view.setInt16(46, 456, true); }
  return data;
}
async function fixture(data = wav()) {
  const reads: string[] = [], warnings: string[] = [], developerWarnings: string[] = [];
  const assets: ConstructorParameters<typeof ClientSoundBank>[0] = withRetainedFiles<Pick<SourceFileReader, "readFileOptional" | "readFileOptionalSync">>({
    readFileOptionalSync: name => { if (name.includes("missing")) return undefined; reads.push(name); return data; },
    readFileOptional: async name => { if (name.includes("missing")) return undefined; reads.push(name); return data; } });
  const bank = new ClientSoundBank(assets, { print: text => warnings.push(text), debugPrint: text => { developerWarnings.push(text); } });
  await bank.beginRegistration(); reads.length = 0; warnings.length = 0; developerWarnings.length = 0;
  return { bank, reads, warnings, developerWarnings };
}

function sampleWav(samples: readonly number[], rate = 22050): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  bytes.set(wav(1, rate).subarray(0, 44));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(40, samples.length * 2, true);
  for (const [index, sample] of samples.entries()) view.setInt16(44 + index * 2, sample, true);
  return bytes;
}

async function pooledFixture(chunkCount: number, tracks: ReadonlyMap<string, Uint8Array>, channels = 96) {
  const reads: string[] = [], printed: string[] = [], debug: string[] = [];
  const clock = { time: 0, calls: 0 };
  const events = new CommonEvents({ getEvent: () => { clock.calls++; return { kind: "none", time: clock.time }; } }, () => undefined);
  const read = (name: string): Uint8Array | undefined => { reads.push(name); return tracks.get(name); };
  const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: read, readFileOptional: name => Promise.resolve(read(name)) }), {
    print: text => { printed.push(text); }, debugPrint: text => { debug.push(text); },
  });
  const mixer = new AudioMixer(22050, () => events.milliseconds(), channels);
  mixer.setEffectsVolume(1);
  bank.initializeMemory({ chunkCount, sampleRate: () => mixer.outputRate, milliseconds: () => events.milliseconds() });
  mixer.bindSoundMemory(bank);
  await bank.beginRegistration();
  return { bank, mixer, clock, reads, printed, debug };
}

describe("source sound chunk memory", () => {
  test("sound hash folds source ASCII, separators and extensions without merging distinct names", async () => {
    expect(hashSoundName("A.wav")).toBe((97 * 119) & 127);
    expect(hashSoundName("sound\\A.wav")).toBe(hashSoundName("SOUND/a.ogg"));
    expect(hashSoundName("ab\0suffix.wav")).toBe(hashSoundName("ab"));
    const f = await pooledFixture(8, new Map([
      ["sound/feedback/hit.wav", wav()], ["a.wav", wav()], ["a.ogg", wav()],
    ]));
    const first = f.bank.sound("a.wav", false), second = f.bank.sound("a.ogg", false);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(f.bank.sound("A.WAV", false)).toBe(first);
  });

  test("S_DefaultSound fills 512 ascending shorts in the actual bank pool", async () => {
    const f = await pooledFixture(3, new Map([["sound/feedback/hit.wav", wav()]]));
    expect(f.bank.sound("missing.wav", false)).toBeNull();
    const before = f.bank.memoryUsage();
    f.bank.defaultSound(1);
    const pcm = f.bank.soundForIndex(1);
    if (pcm === null || pcm === undefined || before === null) throw new Error("Missing default sound allocation");
    expect(pcm.frameCount).toBe(512);
    expect([...pcm.samples]).toEqual(Array.from({ length: 512 }, (_, index) => index));
    expect(f.bank.memoryUsage()?.freeBytes).toBe(before.freeBytes - 2060);
    expect(f.bank.memoryUsage()?.totalAllocatedBytes).toBe(before.totalAllocatedBytes + 2060);
    // S_DefaultSound does not clear the registration failure flag.
    expect(f.bank.sound("missing.wav", false)).toBeNull();
  });
  test("load, accepted starts and loop collection sample their reached source clocks", async () => {
    const f = await pooledFixture(8, new Map([
      ["sound/feedback/hit.wav", wav()], ["a.wav", wav()], ["b.wav", wav()], ["c.wav", wav()],
    ]), 1);
    expect(f.clock.calls).toBe(1);
    expect(f.bank.registeredSounds()[0]?.lastTimeUsed).toBe(1);
    f.clock.time = 10;
    const a = f.bank.sound("a.wav", false), b = f.bank.sound("b.wav", false), c = f.bank.sound("c.wav", false);
    if (a === null || b === null || c === null) throw new Error("Missing pooled source sound");
    expect(f.clock.calls).toBe(4);
    expect(await f.bank.registerSound("A.WAV", true)).toBe(a);
    expect(f.clock.calls).toBe(4);
    f.clock.time = 100;
    expect(f.mixer.startLocalSound(a, 1)).toBe(true);
    expect(f.clock.calls).toBe(6);
    expect(f.bank.registeredSounds()[1]?.lastTimeUsed).toBe(100);
    f.clock.time = 125;
    expect(f.mixer.startLocalSound(a, 1)).toBe(false);
    expect(f.clock.calls).toBe(7);
    expect(f.bank.registeredSounds()[1]?.lastTimeUsed).toBe(100);
    f.clock.time = 150;
    expect(() => f.mixer.startLocalSound(b, 1)).toThrow("undefined native listener fallback");
    expect(f.clock.calls).toBe(8);
    expect(f.bank.registeredSounds()[2]?.lastTimeUsed).toBe(150);

    f.mixer.clearSoundBuffer();
    for (const [entity, sound, distance] of [[1, a, 2000], [2, a, 2000], [3, b, 0], [4, c, 0], [9, b, 0]] satisfies readonly (readonly [number, typeof a, number])[]) {
      f.mixer.updateLoopingSound(sound, { entity, origin: vec3(0, distance, 0), velocity: vec3(0, 0, 0), frameNumber: 1 });
    }
    expect(f.clock.calls).toBe(8);
    f.clock.time = 200;
    f.mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
    expect(f.clock.calls).toBe(9);
    expect(f.bank.registeredSounds().map(entry => entry.lastTimeUsed)).toEqual([1, 200, 200, 11]);
    f.mixer.clearLoopingSounds(true);
    f.mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
    expect(f.clock.calls).toBe(10);
  });

  test("oldest selection frees real chunks in source LIFO order and reloads stable typed handles", async () => {
    const large = new Array<number>(2048).fill(256); large.fill(512, 1024);
    const f = await pooledFixture(4, new Map([
      ["sound/feedback/hit.wav", wav()], ["a.wav", sampleWav(large)], ["b.wav", wav()],
      ["c.wav", sampleWav([1024, 1280])], ["d.wav", sampleWav([1024, 1280])],
    ]));
    f.clock.time = 10;
    const a = f.bank.sound("a.wav", false), b = f.bank.sound("b.wav", false);
    if (a === null || b === null) throw new Error("Missing source pool fixture");
    expect(f.bank.memoryUsage()).toEqual({ freeBytes: 0, totalAllocatedBytes: 4 * 2060 });
    f.clock.time = 20;
    const c = f.bank.sound("c.wav", false), d = f.bank.sound("d.wav", false);
    if (c === null || d === null) throw new Error("Missing reused source chunks");
    expect(f.debug).toEqual(["S_FreeOldestSound: freeing sound a.wav\n"]);
    expect(f.bank.registeredSounds()[1]?.inMemory).toBe(false);
    expect(f.bank.frameCount(a)).toBe(2048);
    expect(() => a.samples).toThrow("not resident");
    expect(f.bank.sample(c, 2)).toBe(512);
    expect(f.bank.sample(d, 2)).toBe(256);
    expect(f.bank.memoryUsage()).toEqual({ freeBytes: 0, totalAllocatedBytes: 6 * 2060 });
    f.mixer.updateLoopingSound(c, { entity: 3, origin: vec3(1, 0, 0), velocity: vec3(19, 0, 0), frameNumber: 1 });
    f.mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
    expect(Array.from(f.mixer.mix(1))).toEqual([203, 203]);
    f.mixer.clearLoopingSounds(true);
    f.clock.time = 30;
    expect(f.bank.resolveForPlayback(a)).toBe(a);
    expect(f.bank.soundForIndex(1)).toBe(a);
    expect(a.samples).toEqual(Int16Array.from(large));
    expect(f.reads.filter(name => name === "a.wav")).toHaveLength(2);
    expect(f.debug).toEqual([
      "S_FreeOldestSound: freeing sound a.wav\n", "S_FreeOldestSound: freeing sound b.wav\n",
      "S_FreeOldestSound: freeing sound c.wav\n",
    ]);
    expect(f.bank.registeredSounds()[1]?.lastTimeUsed).toBe(31);
  });

  test("slot zero is the source fallback and empty reclamation fails finitely before later recovery", async () => {
    const f = await pooledFixture(1, new Map([["sound/feedback/hit.wav", wav()], ["a.wav", wav()]]));
    const zero = f.bank.resolveForPlayback(null);
    if (zero === null) throw new Error("Missing source slot zero");
    const a = f.bank.sound("a.wav", false);
    expect(a).not.toBeNull();
    expect(f.debug).toEqual(["S_FreeOldestSound: freeing sound sound/feedback/hit.wav\n"]);
    expect(f.bank.hasData(zero)).toBe(false);
    expect(() => f.bank.resolveForPlayback(null)).toThrow("exhausted without a reclaimable source chunk");
    expect(f.bank.memoryUsage()?.freeBytes).toBe(0);
    f.clock.time = 2;
    expect(f.bank.resolveForPlayback(null)).toBe(zero);
    expect(zero.samples).toEqual(new Int16Array([-123, 456]));
    expect(f.bank.registeredSounds()[1]?.inMemory).toBe(false);
  });

  test("slot-zero self-eviction retains the loader's detached current chunk without restoring soundData", async () => {
    const f = await pooledFixture(1, new Map([
      ["sound/feedback/hit.wav", sampleWav(new Array<number>(2048).fill(256))],
    ]));
    const zero = f.bank.resolveForPlayback(null);
    if (zero === null) throw new Error("Missing detached source identity");
    expect(f.bank.registeredSounds()[0]?.inMemory).toBe(true);
    expect(f.bank.frameCount(zero)).toBe(2048);
    expect(f.bank.hasData(zero)).toBe(false);
    expect(() => zero.samples).toThrow("no resident chunk");
    expect(f.debug).toEqual(["S_FreeOldestSound: freeing sound sound/feedback/hit.wav\n"]);
    expect(f.bank.memoryUsage()).toEqual({ freeBytes: 0, totalAllocatedBytes: 2 * 2060 });
    expect(f.clock.calls).toBe(2);
    expect(f.mixer.startLocalSound(zero, 1)).toBe(true);
    expect(() => f.mixer.mix(1)).toThrow("no resident chunk for sample 0");
  });

  test("runtime memory stores resampled PCM and mixer reads it without another conversion", async () => {
    const f = await pooledFixture(2, new Map([
      ["sound/feedback/hit.wav", wav()], ["rate.wav", sampleWav(new Array<number>(320).fill(256), 48000)],
    ]));
    const sound = f.bank.sound("rate.wav", true);
    if (sound === null) throw new Error("Missing resampled source sound");
    expect(sound.sampleRate).toBe(22050);
    expect(sound.frameCount).toBe(147);
    expect(f.mixer.startLocalSound(sound, 1)).toBe(true);
    const output = f.mixer.mix(148);
    expect(output[292]).toBe(126);
    expect(output[294]).toBe(0);
  });

  test("active handles observe absent chunks and reloaded lengths instead of retained PCM copies", async () => {
    const tracks = new Map([
      ["sound/feedback/hit.wav", wav()], ["a.wav", sampleWav([256, 256, 256, 256])], ["b.wav", wav()],
    ]);
    const f = await pooledFixture(2, tracks);
    const a = f.bank.sound("a.wav", false);
    if (a === null) throw new Error("Missing source sound identity");
    a.samples.fill(2048);
    f.clock.time = 10;
    f.mixer.startLocalSound(a, 1);
    expect(Array.from(f.mixer.mix(1))).toEqual([126, 126]);
    f.clock.time = 20;
    const b = f.bank.sound("b.wav", false);
    if (b === null) throw new Error("Missing eviction fixture");
    expect(() => f.mixer.mix(1)).toThrow("no resident chunk for sample 1");
    tracks.set("a.wav", sampleWav([512, 512]));
    f.clock.time = 30;
    expect(f.bank.resolveForPlayback(a)).toBe(a);
    expect(a.frameCount).toBe(2);
    expect(Array.from(f.mixer.mix(2))).toEqual([253, 253, 0, 0]);
    expect(Array.from(f.mixer.channelVolumes())).toHaveLength(1);
    f.mixer.mix(0);
    expect(Array.from(f.mixer.channelVolumes())).toHaveLength(0);

    f.clock.time = 40;
    f.mixer.updateLoopingSound(a, { entity: 1, origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0), frameNumber: 1 });
    f.mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
    f.clock.time = 50;
    expect(f.bank.resolveForPlayback(b)).toBe(b);
    expect(Array.from(f.mixer.mix(2))).toEqual([0, 0, 0, 0]);
    tracks.set("a.wav", sampleWav([768, 768, 768]));
    f.clock.time = 60;
    expect(f.bank.resolveForPlayback(a)).toBe(a);
    expect(Array.from(f.mixer.mix(2))).toEqual([188, 188, 188, 188]);
  });

  test("missing and empty resident rows retire in source order before a reclaimable sound", async () => {
    const f = await pooledFixture(3, new Map([
      ["sound/feedback/hit.wav", wav()], ["empty.wav", sampleWav([])], ["stereo.wav", wav(2)],
      ["a.wav", wav()], ["b.wav", wav()], ["c.wav", wav()],
    ]));
    const empty = f.bank.sound("empty.wav", false);
    if (empty === null) throw new Error("Missing zero-length source handle");
    expect(empty.samples).toHaveLength(0);
    expect(f.bank.sound("stereo.wav", false)).toBeNull();
    expect(f.bank.sound("missing.wav", false)).toBeNull();
    expect(f.clock.calls).toBe(2);
    f.clock.time = 10;
    f.bank.sound("a.wav", false);
    f.bank.sound("b.wav", false);
    expect(f.clock.calls).toBe(4);
    f.clock.time = 20;
    expect(f.bank.sound("c.wav", false)).not.toBeNull();
    expect(f.clock.calls).toBe(9);
    expect(f.debug).toEqual([
      "S_FreeOldestSound: freeing sound stereo.wav\n", "S_FreeOldestSound: freeing sound missing.wav\n",
      "S_FreeOldestSound: freeing sound empty.wav\n", "S_FreeOldestSound: freeing sound a.wav\n",
    ]);
    expect(f.bank.memoryUsage()).toEqual({ freeBytes: 0, totalAllocatedBytes: 4 * 2060 });
  });
});

describe("source shared sound registration", () => {
  test("resident loading retries an interrupted source row at playback and retains its actual index", async () => {
    let broken = true;
    const reads: string[] = [], warnings: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({
      readFileOptionalSync: name => { reads.push(name); return broken ? new Uint8Array(1) : wav(); },
      readFileOptional: name => Promise.resolve(name === "sound/feedback/hit.wav" ? wav() : new Uint8Array(1)),
    }), { print: text => warnings.push(text), debugPrint: () => undefined });
    await bank.beginRegistration();
    await expect(bank.registerSound("Interrupted.wav", false)).rejects.toThrow("truncated");
    expect(() => bank.soundForIndex(1)).toThrow("truncated");
    broken = false;
    bank.resetLookup();
    const sound = bank.soundForIndex(1);
    if (sound === null || sound === undefined) throw new Error("Interrupted source row must load actual PCM");
    expect(bank.indexForSound(sound)).toBe(1);
    expect(bank.nameForSound(sound)).toBe("Interrupted.wav");
    expect(bank.soundForIndex(1)).toBe(sound);
    expect(reads).toEqual(["Interrupted.wav", "Interrupted.wav"]);
    expect(warnings).toEqual([]);
    const mixer = new AudioMixer(22050, () => 0);
    mixer.setEffectsVolume(1);
    expect(mixer.startLocalSound(sound, 2, bank.nameForSound(sound))).toBe(true);
    expect(mixer.mix(2)).toEqual(new Int16Array([-61, -61, 225, 225]));
  });

  test("resident loading preserves sticky defaults without registration warnings or repeated missing reads", async () => {
    let data: Uint8Array | undefined;
    const reads: string[] = [], warnings: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({
      readFileOptionalSync: name => { reads.push(name); return data; },
      readFileOptional: name => Promise.resolve(name === "sound/feedback/hit.wav" ? wav() : data),
    }), { print: text => warnings.push(text), debugPrint: () => undefined });
    await bank.beginRegistration();
    expect(bank.sound("sticky.wav", false)).toBeNull();
    data = wav();
    expect(() => bank.soundForIndex(1)).toThrow("no decoded PCM");
    expect(reads).toEqual(["sticky.wav"]);
    data = new Uint8Array(1);
    expect(() => bank.sound("sticky.wav", false)).toThrow("truncated");
    data = wav();
    warnings.length = 0;
    const sound = bank.soundForIndex(1);
    expect(sound?.samples).toEqual(new Int16Array([-123, 456]));
    expect(warnings).toEqual([]);
    expect(bank.sound("sticky.wav", false)).toBeNull();
    expect(warnings).toEqual(["^3WARNING: could not find sticky.wav - using default\n"]);

    data = new Uint8Array(1);
    expect(() => bank.sound("absent.wav", false)).toThrow("truncated");
    data = undefined;
    warnings.length = 0;
    expect(() => bank.soundForIndex(2)).toThrow("no decoded PCM");
    expect(() => bank.soundForIndex(2)).toThrow("no decoded PCM");
    expect(reads.filter(name => name === "absent.wav")).toEqual(["absent.wav", "absent.wav"]);
    expect(warnings).toEqual([]);
  });

  test("resident loading resolves real zero at typed playback but respects pending and disabled lifetimes", async () => {
    const pending = Promise.withResolvers<Uint8Array>();
    const reads: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({
      readFileOptionalSync: name => { reads.push(name); return wav(); },
      readFileOptional: name => name === "sound/feedback/hit.wav" ? Promise.reject(new Error("interrupted")) : pending.promise,
    }), { print: () => undefined, debugPrint: () => undefined });
    await expect(bank.beginRegistration()).rejects.toThrow("interrupted");
    bank.setRegistrationEnabled(false);
    expect(bank.resolveForPlayback(null)).toBeNull();
    expect(reads).toEqual([]);
    bank.setRegistrationEnabled(true);
    const zero = bank.resolveForPlayback(null);
    expect(zero?.samples).toEqual(new Int16Array([-123, 456]));
    expect(bank.soundForIndex(0)).toBeNull();
    expect(bank.resolveForPlayback(null)).toBe(zero);
    const registration = bank.registerSound("pending.wav", false);
    expect(() => bank.soundForIndex(1)).toThrow("still loading");
    expect(reads).toEqual(["sound/feedback/hit.wav"]);
    bank.setRegistrationEnabled(false);
    pending.resolve(wav());
    await expect(registration).rejects.toThrow("lifetime ended");
    expect(() => bank.soundForIndex(1)).toThrow("no decoded PCM");
    expect(reads).toEqual(["sound/feedback/hit.wav"]);
  });

  test("developer WAV warnings retain source width, rate, spelling and order for both registration paths", async () => {
    for (const bitsPerSample of [8, 16] satisfies readonly (8 | 16)[]) {
      for (const sampleRate of [11025, 22050]) {
        const { bank, reads, warnings, developerWarnings } = await fixture(wav(1, sampleRate, bitsPerSample));
        const expected: string[] = [];
        const sync = bank.sound("Sound/Format.wav\0ignored", true);
        if (bitsPerSample === 8) expected.push("^3WARNING: Sound/Format.wav is a 8 bit wav file\n");
        if (sampleRate !== 22050) expected.push("^3WARNING: Sound/Format.wav is not a 22kHz wav file\n");
        expect(developerWarnings).toEqual(expected);
        expect(sync?.samples).toEqual(bitsPerSample === 8 ? new Int16Array([-32768, 32512]) : new Int16Array([-123, 456]));
        expect(await bank.registerSound("sound/format.wav", false)).toBe(sync);
        expect(bank.sound("SOUND/FORMAT.WAV", false)).toBe(sync);
        expect(developerWarnings).toEqual(expected);
        const async = await bank.registerSound("Sound/Async.wav", false);
        if (bitsPerSample === 8) expected.push("^3WARNING: Sound/Async.wav is a 8 bit wav file\n");
        if (sampleRate !== 22050) expected.push("^3WARNING: Sound/Async.wav is not a 22kHz wav file\n");
        expect(async?.samples).toEqual(sync?.samples);
        expect(developerWarnings).toEqual(expected);
        expect(reads).toEqual(["Sound/Format.wav", "Sound/Async.wav"]);
        expect(warnings).toEqual([]);
      }
    }
  });

  test("stereo WAV rejection precedes developer warnings for both registration paths", async () => {
    const { bank, warnings, developerWarnings } = await fixture(wav(2, 11025, 8));
    expect(bank.sound("stereo.wav", false)).toBeNull();
    expect(await bank.registerSound("stereo.wav", true)).toBeNull();
    expect(warnings).toEqual([
      "stereo.wav is a stereo wav file\n", "^3WARNING: could not find stereo.wav - using default\n",
      "stereo.wav is a stereo wav file\n", "^3WARNING: could not find stereo.wav - using default\n",
    ]);
    expect(developerWarnings).toEqual([]);
  });

  test("developer warning callbacks cannot publish across a retired registration lifetime", async () => {
    for (const method of ["sync", "async"]) {
      for (const stopAfter of [1, 2]) {
        const developerWarnings: string[] = [];
        const read = (path: string): Uint8Array => path === "sound/feedback/hit.wav" ? wav() : wav(1, 11025, 8);
        const bank: ClientSoundBank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: read, readFileOptional: path => Promise.resolve(read(path)) }), {
          print: () => undefined,
          debugPrint: text => {
            developerWarnings.push(text);
            expect(bank.registeredSounds().find(entry => entry.name === "retire.wav")?.sound).toBeNull();
            if (developerWarnings.length === stopAfter) {
              bank.setRegistrationEnabled(false);
              bank.setRegistrationEnabled(true);
            }
          },
        });
        await bank.beginRegistration();
        if (method === "sync") expect(() => bank.sound("retire.wav", false)).toThrow("Sound registration lifetime ended");
        else await expect(bank.registerSound("retire.wav", false)).rejects.toThrow("Sound registration lifetime ended");
        expect(developerWarnings.length).toBe(stopAfter);
        expect(bank.registeredSounds().find(entry => entry.name === "retire.wav")?.sound).toBeNull();
      }
    }
  });

  test("PCM name lookup retains actual zero and old entries across lookup resets without enumerating slots", async () => {
    const { bank, reads } = await fixture();
    const zero = bank.resolveForPlayback(null), first = bank.sound("Sound/First.wav", false);
    if (zero === null || first === null) throw new Error("Fixture sounds must decode");
    expect(await bank.registerSound("SOUND/FIRST.WAV", false)).toBe(first);
    bank.registeredSounds = () => { throw new Error("Name lookup must not enumerate the registry"); };
    expect(bank.nameForSound(zero)).toBe("sound/feedback/hit.wav");
    expect(bank.nameForSound(first)).toBe("Sound/First.wav");
    expect(bank.nameForSound(decodeWav(wav(), "unregistered.wav"))).toBeNull();
    bank.resetLookup();
    await bank.beginRegistration();
    expect(bank.resolveForPlayback(null)).toBe(zero);
    const replacement = await bank.registerSound("sound/first.wav", false);
    if (replacement === null) throw new Error("Replacement sound must decode");
    expect(replacement).not.toBe(first);
    expect(bank.nameForSound(replacement)).toBe("sound/first.wav");
    expect(bank.nameForSound(first)).toBe("Sound/First.wav");
    expect(bank.nameForSound(zero)).toBe("sound/feedback/hit.wav");
    expect(bank.sound("missing.wav", false)).toBeNull();
    expect(bank.nameForSound(zero)).toBe("sound/feedback/hit.wav");
    expect(reads).toEqual(["Sound/First.wav", "sound/first.wav"]);
  });

  test("first source registration opens the current file without an earlier cached miss", async () => {
    let exists = false;
    const reads: string[] = [], warnings: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: path => { if (path !== "sound/feedback/hit.wav" && !exists) return undefined; reads.push(path); return wav(); },
      readFileOptional: async path => { if (path !== "sound/feedback/hit.wav" && !exists) return undefined; reads.push(path); return wav(); } }), { print: text => warnings.push(text), debugPrint: () => undefined });
    await bank.beginRegistration();
    expect(reads).toEqual(["sound/feedback/hit.wav"]); expect(warnings).toEqual([]);
    exists = true;
    const sound = bank.sound("late.wav", false);
    expect(sound?.samples).toEqual(new Int16Array([-123, 456]));
    expect(await bank.registerSound("late.wav", false)).toBe(sound);
    expect(reads).toEqual(["sound/feedback/hit.wav", "late.wav"]); expect(warnings).toEqual([]);
    const oracle = process.env["Q3_SOUND_LIFECYCLE_ORACLE"] ?? "/tmp/quake3-sound-lifecycle-vCC4q9/reference";
    if (existsSync(oracle)) {
      const result = Bun.spawnSync([oracle, "late"]), output = new TextDecoder().decode(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(output).toContain("REGISTER|handle=1\nFIRST|slots=2|name=late.wav|memory=1|default=0|data=1|length=2|reads=2\n");
      expect(output).toContain("SECOND|slots=2|name=late.wav|memory=1|default=0|data=1|length=2|reads=2\n");
    }
  });
  test("sync and async stereo retries reopen source data and retain sticky failure after recovery", async () => {
    let stereo = true;
    const reads: string[] = [], warnings: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: path => { reads.push(path); return wav(path === "sound/feedback/hit.wav" || !stereo ? 1 : 2); },
      readFileOptional: path => { reads.push(path); return Promise.resolve(wav(path === "sound/feedback/hit.wav" || !stereo ? 1 : 2)); } }), { print: text => warnings.push(text), debugPrint: () => undefined });
    await bank.beginRegistration();
    expect(bank.sound("stereo.wav", false)).toBeNull();
    expect(bank.sound("stereo.wav", false)).toBeNull();
    expect(reads).toEqual(["sound/feedback/hit.wav", "stereo.wav", "stereo.wav"]);
    stereo = false;
    expect(await bank.registerSound("stereo.wav", false)).toBeNull();
    expect(await bank.registerSound("stereo.wav", false)).toBeNull();
    expect(reads.length).toBe(4);
    expect(warnings.filter(text => text.includes("stereo wav file")).length).toBe(2);
    expect(warnings.filter(text => text.includes("using default")).length).toBe(4);
  });
  test("synchronous first use performs actual decode, diagnostics and failures at that call", async () => {
    const { bank, reads, warnings } = await fixture();
    expect(reads).toEqual([]); expect(warnings).toEqual([]);
    const sound = bank.sound("late.wav", false);
    expect(sound?.samples).toEqual(new Int16Array([-123, 456]));
    expect(bank.sound("LATE.WAV", true)).toBe(sound);
    expect(reads).toEqual(["late.wav"]);
    expect(bank.sound("missing.wav", false)).toBeNull();
    expect(warnings.length).toBe(1);
    const broken = await fixture();
    const brokenBank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: () => new Uint8Array(1),
      readFileOptional: name => Promise.resolve(name === "sound/feedback/hit.wav" ? wav() : new Uint8Array(1)) }), { print: text => broken.warnings.push(text), debugPrint: () => undefined });
    await brokenBank.beginRegistration();
    expect(broken.warnings).toEqual([]);
    expect(() => brokenBank.sound("broken.wav", false)).toThrow("truncated");
    expect(bank.sound("nul.wav", false)?.frameCount).toBe(2);
  });
  test("async registration deduplicates loads and sync overlap rejects without racing publication", async () => {
    const data = Promise.withResolvers<Uint8Array>(); let reads = 0;
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: () => { throw new Error("Unexpected competing sync read"); },
      readFileOptional: name => { if (name === "sound/feedback/hit.wav") return Promise.resolve(wav()); reads++; return data.promise; } }), { print: () => undefined, debugPrint: () => undefined });
    await bank.beginRegistration();
    const registered = bank.registerSound("deferred.wav", false), duplicate = bank.registerSound("DEFERRED.WAV", true);
    expect(() => bank.sound("deferred.wav", false)).toThrow("still loading");
    data.resolve(wav());
    expect(await registered).toBe(await duplicate); expect(reads).toBe(1);
    expect(bank.sound("deferred.wav", false)).toBe(await registered);
    const failure = new Error("fixture I/O failure");
    const failing = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: () => { throw failure; },
      readFileOptional: name => name === "sound/feedback/hit.wav" ? Promise.resolve(wav()) : Promise.reject(failure) }), { print: () => undefined, debugPrint: () => undefined });
    await failing.beginRegistration();
    expect(() => failing.sound("io.wav", false)).toThrow(failure);
  });
  test("compression is forced off and case-insensitive concurrent registration shares decoded ownership", async () => {
    const { bank, reads } = await fixture();
    const [a, b] = await Promise.all([bank.registerSound("sound/A.wav", true), bank.registerSound("SOUND/a.WAV", false)]);
    expect(a).toBe(b); expect(reads).toEqual(["sound/A.wav"]);
    expect(bank.sound("sOuNd/A.WaV", false)).toBe(a);
    expect(a?.samples).toEqual(new Int16Array([-123, 456]));
    expect(await bank.registerSound("sound/A.wav", false)).toBe(a);
    expect(reads.length).toBe(1);
    expect(await bank.registerSound("sound\\A.wav", false)).not.toBe(a);
    expect(reads.length).toBe(2);
  });
  test("missing/custom sounds retain source zero without invented PCM and retry registration", async () => {
    const { bank, reads, warnings } = await fixture();
    expect(await bank.registerSound("missing.wav", false)).toBeNull();
    expect(bank.sound("MISSING.WAV", true)).toBeNull();
    expect(await bank.registerSound("missing.wav", true)).toBeNull();
    expect(await bank.registerSound("*pain25_1.wav", false)).toBeNull();
    expect(reads).toEqual([]); expect(warnings.length).toBe(4);
    expect(bank.sound(null, false)).toBeNull();
    expect(bank.sound("first-use.wav", false)?.frameCount).toBe(2);
  });
  test("source stereo rejection, path limit and empty-name failure", async () => {
    const { bank, warnings } = await fixture(wav(2));
    expect(await bank.registerSound("stereo.wav", false)).toBeNull();
    expect(warnings[0]).toBe("stereo.wav is a stereo wav file\n");
    expect(await bank.registerSound("x".repeat(64), false)).toBeNull();
    expect(warnings.at(-1)).toBe("Sound name exceeds MAX_QPATH\n");
    for (const path of ["", "\0ignored"]) {
      for (const register of [() => bank.registerSound(path, false), () => bank.sound(path, false)]) {
        const result = Promise.resolve().then(register);
        await expect(result).rejects.toBeInstanceOf(CommonError);
        await expect(result).rejects.toMatchObject({ code: "fatal", message: "S_FindName: empty name\n" });
      }
    }
    await expect(bank.registerSound("é漢.wav", false)).rejects.toThrow("byte characters");
    bank.setRegistrationEnabled(false);
    expect(await bank.registerSound("", false)).toBeNull();
    expect(bank.sound("", false)).toBeNull();
  });
  test("both retail products use one bank across player, weapon and announcer lookup", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
      const assets = await VirtualFileSystem.openInspection({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", cdPath: null, product });
      const bank = new ClientSoundBank(assets, { print: () => undefined, debugPrint: () => undefined });
      await bank.beginRegistration();
      for (const path of ["sound/feedback/hit.wav", "sound/weapons/rocket/rocklx1a.wav", "sound/player/sarge/death1.wav"]) {
        const sound = bank.sound(path, true);
        const pcm = bank.resolveForPlayback(sound);
        expect(pcm?.channels).toBe(1); expect(pcm?.frameCount).toBeGreaterThan(0);
        expect(bank.sound(path, false)).toBe(sound);
        expect(await bank.registerSound(path, false)).toBe(sound);
      }
    }
  });
  test("native S_BeginRegistration/StartSound proof: successful hit and failed names share zero handle but play real hit PCM", async () => {
    const { bank, reads } = await fixture();
    const zero = bank.resolveForPlayback(null);
    expect(zero?.samples).toEqual(new Int16Array([-123, 456]));
    if (zero === null) throw new Error("Fixture hit.wav must provide actual slot-zero PCM");
    const audio = new AudioMixer(22050, () => 0); audio.setEffectsVolume(1);
    audio.startSound(zero, { entity: 3, channel: 4, volume: 127, origin: { kind: "local" } });
    expect([...audio.mix(2)]).toEqual([-61, -61, 225, 225]);
    expect(await bank.registerSound("sound/feedback/hit.wav", true)).toBeNull();
    expect(await bank.registerSound("SOUND/FEEDBACK/HIT.WAV", false)).toBeNull();
    expect(bank.sound("sound/feedback/hit.wav", false)).toBeNull();
    expect(bank.resolveForPlayback(await bank.registerSound("missing.wav", false))).toBe(zero);
    await bank.beginRegistration(); expect(reads).toEqual([]); expect(bank.resolveForPlayback(null)).toBe(zero);
    const sound = await bank.registerSound("other.wav", false);
    expect(sound).not.toBeNull(); expect(bank.resolveForPlayback(sound)).toBe(sound);
    const oracle = `${process.env["Q3_CGAME_MEDIA_ORACLE"] ?? "/tmp/quake3-cgame-media-reference-CWS3PZ"}/sound-reference`;
    if (existsSync(oracle)) {
      const result = Bun.spawnSync([oracle]), output = new TextDecoder().decode(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(output).toContain("HANDLES|0|0|0\n");
      expect(output).toContain("PLAY|sound/feedback/hit.wav|entity=3|channel=4\n");
      expect(output).toContain("RETRY|0|default=1|data=1\n");
    }
  });
  test("failed-load flag remains sticky even when a later registration can read the file", async () => {
    let exists = false, reads = 0;
    const warnings: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: name => { if (name !== "sound/feedback/hit.wav" && !exists) return undefined; reads++; return wav(); },
      readFileOptional: async name => { if (name !== "sound/feedback/hit.wav" && !exists) return undefined; reads++; return wav(); } }), { print: text => warnings.push(text), debugPrint: () => undefined });
    await bank.beginRegistration();
    expect(bank.sound("missing.wav", false)).toBeNull();
    exists = true;
    expect(bank.sound("missing.wav", false)).toBeNull();
    expect(await bank.registerSound("missing.wav", false)).toBeNull();
    expect(reads).toBe(2); expect(warnings.length).toBe(3);
    expect(bank.resolveForPlayback(null)?.samples).toEqual(new Int16Array([-123, 456]));
  });
  test("source missing hit.wav is not retried by begin or playback and never generates fallback PCM", async () => {
    let exists = false;
    const reads: string[] = [], warnings: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: path => { if (!exists) return undefined; reads.push(path); return wav(); },
      readFileOptional: async path => { if (!exists) return undefined; reads.push(path); return wav(); } }), { print: text => warnings.push(text), debugPrint: () => undefined });
    await bank.beginRegistration(); expect(bank.resolveForPlayback(null)).toBeNull();
    exists = true; await bank.beginRegistration();
    expect(bank.resolveForPlayback(null)).toBeNull(); expect(reads).toEqual([]); expect(warnings.length).toBe(1);
    expect(await bank.registerSound("sound/feedback/hit.wav", false)).toBeNull();
    expect(bank.resolveForPlayback(null)?.samples).toEqual(new Int16Array([-123, 456]));
    expect(reads).toEqual(["sound/feedback/hit.wav"]); expect(warnings.length).toBe(2);
  });
  test("custom source names perform neither async nor sync whole-file reads", async () => {
    const reads: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptional: path => { reads.push(path); return Promise.resolve(wav()); },
      readFileOptionalSync: path => { reads.push(path); return wav(); } }), { print: () => undefined, debugPrint: () => undefined });
    await bank.beginRegistration();
    expect(bank.sound("*pain25_1.wav", false)).toBeNull();
    expect(await bank.registerSound("*pain25_1.wav", false)).toBeNull();
    expect(reads).toEqual(["sound/feedback/hit.wav"]);
  });
  test("begin registration preserves a preexisting source slot zero", async () => {
    const reads: string[] = [];
    const bank = new ClientSoundBank(withRetainedFiles({ readFileOptionalSync: path => { reads.push(path); return wav(); },
      readFileOptional: path => { reads.push(path); return Promise.resolve(wav()); } }), { print: () => undefined, debugPrint: () => undefined });
    expect(await bank.registerSound("prior.wav", false)).toBeNull();
    const zero = bank.resolveForPlayback(null);
    await bank.beginRegistration();
    expect(reads).toEqual(["prior.wav"]); expect(bank.resolveForPlayback(null)).toBe(zero);
  });
  test("source MAX_SFX includes reserved slot zero but repeated names consume no slots", async () => {
    const { bank } = await fixture();
    const first = await bank.registerSound("sound/cap/1.wav", false);
    for (let i = 2; i < 4096; i++) await bank.registerSound(`sound/cap/${i}.wav`, false);
    expect(await bank.registerSound("SOUND/CAP/1.WAV", true)).toBe(first);
    for (const register of [() => bank.registerSound("sound/overflow.wav", false), () => bank.sound("sound/overflow.wav", false)]) {
      const result = Promise.resolve().then(register);
      await expect(result).rejects.toBeInstanceOf(CommonError);
      await expect(result).rejects.toMatchObject({ code: "fatal", message: "S_FindName: out of sfx_t" });
    }
    expect(bank.registeredSounds()).toHaveLength(4096);
    bank.setRegistrationEnabled(false);
    expect(await bank.registerSound("sound/overflow.wav", false)).toBeNull();
    expect(bank.sound("sound/overflow.wav", false)).toBeNull();
  });
});
