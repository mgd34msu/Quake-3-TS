import { expect, test } from "bun:test";
import type { PcmSound } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { ClientFrameAudio } from "../src/cgame/frame-audio.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";

const tone: PcmSound = { sampleRate: 22050, channels: 1, frameCount: 2, loopStart: null, samples: new Int16Array([1024, -1024]) };
const products: readonly Product[] = ["baseq3", "missionpack"];
function fixture(product: Product = "baseq3", wearOffSound: PcmSound | null = tone) {
  const state = new ClientGameState(product, 3, 0), ps = createPlayerState(product);
  ps.clientNum = 3;
  state.snap = { messageNumber: 1, serverTime: 0, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
    parseEntitiesNumber: 0, areaMask: new Uint8Array(32), playerState: ps, entities: [] };
  const calls: { readonly kind: "local" | "entity"; readonly sound: PcmSound | null; readonly entity: number; readonly channel: number }[] = [];
  const audio = new ClientFrameAudio(state, { wearOffSound }, {
    startLocalSound: (sound, channel) => { calls.push({ kind: "local", sound, entity: state.clientNum, channel }); },
    startSound: (origin, entity, channel, sound) => { expect(origin).toBeNull(); calls.push({ kind: "entity", sound, entity, channel }); },
  });
  return { state, ps, calls, audio };
}

test("buffered announcer ignores zero handles and uses strict 750ms scheduling", () => {
  const f = fixture();
  expect(f.state.soundBuffer).toHaveLength(20);
  expect(f.state.soundBuffer.every(sound => sound === null)).toBe(true);
  f.audio.addBufferedSound(null); expect(f.state.soundBufferIn).toBe(0);
  f.audio.addBufferedSound(tone); f.audio.addBufferedSound(tone);
  f.audio.playBufferedSounds(); expect(f.calls).toHaveLength(0);
  f.state.time = 1; f.audio.playBufferedSounds();
  expect(f.calls).toEqual([{ kind: "local", sound: tone, entity: 3, channel: 7 }]);
  expect([f.state.soundBufferIn, f.state.soundBufferOut, f.state.soundTime]).toEqual([2, 1, 751]);
  expect(f.state.soundBuffer[0]).toBeNull();
  f.state.time = 751; f.audio.playBufferedSounds(); expect(f.calls).toHaveLength(1);
  f.state.time = 752; f.audio.playBufferedSounds(); expect(f.calls).toHaveLength(2);
  expect(f.state.soundBufferOut).toBe(2);
});

test("pool-full queue drops the oldest entry without changing source wrap order", () => {
  const f = fixture(), sounds = Array.from({ length: 20 }, () => ({ ...tone }));
  for (const sound of sounds) f.audio.addBufferedSound(sound);
  expect([f.state.soundBufferIn, f.state.soundBufferOut]).toEqual([0, 1]);
  f.state.time = 1; f.audio.playBufferedSounds();
  expect(f.calls[0]?.sound).toBe(sounds[1]);
  expect(f.state.soundBufferOut).toBe(2);
});

test("source unwrapped overflow rejects the actual out-of-bounds read, not an invented sound", () => {
  const f = fixture();
  f.state.soundBufferIn = 18; f.state.soundBufferOut = 19;
  f.audio.addBufferedSound(tone);
  expect([f.state.soundBufferIn, f.state.soundBufferOut]).toEqual([19, 20]);
  expect(f.state.soundBuffer[18]).toBe(tone);
  f.state.time = 1;
  expect(() => f.audio.playBufferedSounds()).toThrow("sound buffer index 20");
  expect(f.calls).toHaveLength(0);
});

test("a zero queue head stalls instead of skipping forward, and instances own their queues", () => {
  const f = fixture(), other = fixture();
  f.state.soundBufferIn = 2; f.state.soundBuffer[1] = tone; f.state.time = 100;
  f.audio.playBufferedSounds(); expect(f.calls).toHaveLength(0); expect(f.state.soundBufferOut).toBe(0);
  expect(other.state.soundBuffer[1]).toBeNull();
  f.state.soundBuffer[0] = tone; f.audio.playBufferedSounds(); expect(f.calls).toHaveLength(1);
});

test("announcer deadline uses signed integer time and preserves state if the trap fails", () => {
  const f = fixture(); f.state.time = 2147483640;
  f.audio.addBufferedSound(tone); f.audio.playBufferedSounds();
  expect(f.state.soundTime).toBe(-2147482906);
  const failure = new Error("audio trap failure");
  const broken = new ClientFrameAudio(f.state, { wearOffSound: tone }, {
    startLocalSound: () => { throw failure; }, startSound: () => { throw failure; },
  });
  broken.addBufferedSound(tone);
  expect(() => broken.playBufferedSounds()).toThrow(failure);
  expect(f.state.soundBufferOut).toBe(1); expect(f.state.soundBuffer[1]).toBe(tone);
});

for (const product of products) test(`${product} powerup warnings preserve signed comparisons, integer buckets and all 16 slots`, () => {
  const cases = [
    { time: 1000, old: 999, expiry: 6000, count: 0 },
    { time: 1000, old: 999, expiry: 5999, count: 1 },
    { time: 1000, old: 0, expiry: 1000, count: 0 },
    { time: 1000, old: 0, expiry: 1001, count: 1 },
    { time: 1000, old: 999, expiry: 2000, count: 0 },
    { time: 1001, old: 1000, expiry: 2000, count: 1 },
    { time: 1000, old: 2000, expiry: 3500, count: 1 },
    { time: -2147483648, old: 2147482600, expiry: 2147483600, count: 1 },
  ];
  for (const sample of cases) {
    const f = fixture(product, null); f.state.time = sample.time; f.state.oldTime = sample.old;
    for (let slot = 0; slot < 16; slot++) f.ps.powerups.set(slot, sample.time);
    f.ps.powerups.set(15, sample.expiry);
    f.audio.powerupTimerSounds();
    expect(f.calls).toHaveLength(sample.count);
    if (sample.count !== 0) expect(f.calls[0]).toEqual({ kind: "entity", entity: 3, channel: 4, sound: null });
  }
  const f = fixture(product); f.state.time = 1001; f.state.oldTime = 1000;
  for (let slot = 0; slot < 16; slot++) f.ps.powerups.set(slot, 2000);
  f.audio.powerupTimerSounds(); expect(f.calls).toHaveLength(16);
});

test("powerup processing requires the active snapshot used by the source frame", () => {
  const f = fixture(); f.state.snap = null;
  expect(() => f.audio.powerupTimerSounds()).toThrow("active snapshot");
});

const data = process.env["Q3_DATA"];
test.skipIf(data === undefined)("retail zero-handle wear-off trap reaches real sound-bank PCM and the actual mixer", async () => {
  if (data === undefined) throw new Error("Retail data is required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath: data, homePath: data, cdPath: null, product: "baseq3" });
  const soundDebugMessages: string[] = [];
  const bank = new ClientSoundBank(vfs, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => undefined }); await bank.beginRegistration();
  const zero = bank.resolveForPlayback(null); if (zero === null) throw new Error("Retail hit.wav must be registered in slot zero");
  const f = fixture(); f.state.time = 1001; f.state.oldTime = 1000; f.ps.powerups.set(1, 2000);
  const mixed = new AudioMixer(zero.sampleRate, () => 0), reference = new AudioMixer(zero.sampleRate, () => 0);
  for (const mixer of [mixed, reference]) mixer.setListener(3, vec3(0, 0, 0), anglesToAxis(vec3(0, 0, 0)));
  const audio = new ClientFrameAudio(f.state, { wearOffSound: null }, {
    startLocalSound: () => { throw new Error("Unexpected announcer call"); },
    startSound: (_origin, entity, channel, handle) => {
      const pcm = bank.resolveForPlayback(handle); if (pcm === null) throw new Error("Sound zero is unavailable");
      mixed.startSound(pcm, { entity, channel, origin: { kind: "entity", entity }, volume: 127 });
    },
  });
  audio.powerupTimerSounds();
  reference.startSound(zero, { entity: 3, channel: 4, origin: { kind: "entity", entity: 3 }, volume: 127 });
  const actual = mixed.mix(zero.frameCount);
  expect(actual).toEqual(reference.mix(zero.frameCount)); expect(actual.some(value => value !== 0)).toBe(true);
});
