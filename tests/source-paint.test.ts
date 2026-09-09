import { expect, test } from "bun:test";
import { byteSwapRawSamples, resampleSoundRaw, SourceCompressedPainter, SourcePaintChunk, SourceSoundResampler, transferPaintBuffer, writeLinearBlastStereo16 } from "../src/audio/source-paint.ts";
import type { SourcePaintChannel } from "../src/audio/source-paint.ts";
import { SourceWaveletCodec } from "../src/audio/wavelet.ts";
import { AudioMixer, spatializeSoundOrigin } from "../src/audio/mixer.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { vec3 } from "../src/core/math.ts";

function chunk(sample = 0): SourcePaintChunk {
  const result = new SourcePaintChunk(new Uint8Array(2048));
  result.adpcm.sample = sample;
  result.size = 2048;
  return result;
}

const channel: SourcePaintChannel = { leftvol: 256, rightvol: 128, doppler: false, dopplerScale: 1, oldDopplerScale: 1 };

test("ResampleSfxRaw uses the same source count and 8.8 indexes as bank loading", () => {
  const output = new Int16Array(7).fill(123);
  expect(resampleSoundRaw(output, 11025, 22050, 1, 3, new Uint8Array([0, 128, 255]))).toBe(6);
  expect([...output]).toEqual([-32768, -32768, 0, 0, 32512, 32512, 123]);
  const bytes = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  expect(resampleSoundRaw(output, 44100, 22050, 2, 4, bytes)).toBe(2);
  expect([...output.subarray(0, 3)]).toEqual([1, 3, 0]);
  const resampler = new SourceSoundResampler(44100, 22050, 0x1000000);
  expect(resampler.sourceIndex(0x400000)).toBe(-0x800000);
  const partial = new Int16Array(3).fill(9);
  expect(() => resampleSoundRaw(partial, 22050, 22050, 2, 3, bytes.subarray(0, 4))).toThrow();
  expect([...partial]).toEqual([1, 2, 9]);
});

test("source raw bytes preserve signed stereo, unsigned mono, signed gain and zero-count reset", () => {
  const mixer = new AudioMixer(22050, () => 0);
  mixer.queueRawBytes(1, 22050, 1, 2, new Uint8Array([0, 255]), 1);
  expect([...mixer.mix(1)]).toEqual([0, -256]);
  mixer.queueRawBytes(1, 22050, 1, 1, new Uint8Array([255]), -1);
  expect([...mixer.mix(1)]).toEqual([-32512, -32512]);
  mixer.selectTime(100, 100);
  mixer.queueRawBytes(0, 22050, 2, 2, new Uint8Array(0), 1);
  expect(mixer.rawEnd).toBe(100);
  mixer.queueRawBytes(3, 22050, 3, 2, new Uint8Array(0), 1);
  expect(mixer.rawEnd).toBe(100);
  mixer.queueRawBytes(1, 22050, 2, 1, new Uint8Array([0x34, 0x12]), 1);
  expect([...mixer.mix(1)]).toEqual([0x1234, 0x1234]);
});

test("raw byte swap changes big-endian shorts and leaves little-endian or eight-bit input alone", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  byteSwapRawSamples(1, 2, 2, bytes, true);
  expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6]);
  byteSwapRawSamples(1, 2, 2, bytes, false);
  expect([...bytes]).toEqual([2, 1, 4, 3, 5, 6]);
  byteSwapRawSamples(3, 1, 2, bytes, false);
  expect([...bytes]).toEqual([2, 1, 4, 3, 5, 6]);
  byteSwapRawSamples(1, 2, 1, bytes, false);
  expect([...bytes]).toEqual([1, 2, 4, 3, 5, 6]);
});

test("raw sample pointer exposes the actual interleaved mixer allocation", () => {
  const mixer = new AudioMixer(22050, () => 0);
  const raw = mixer.getRawSamplePointer();
  mixer.queueRaw({ sampleRate: 22050, channels: 2, samples: new Int16Array([123, -456]), frameCount: 1, loopStart: null }, 1);
  expect(raw.length).toBe(16384 * 2);
  expect([...raw.subarray(0, 2)]).toEqual([123 * 256, -456 * 256]);
  raw[0] = 789 * 256;
  expect([...mixer.mix(1)]).toEqual([789, -456]);
  mixer.clearSoundBuffer();
  expect(mixer.getRawSamplePointer()).toBe(raw);
  expect(raw[0]).toBe(789 * 256);
});

test("mono spatialization retains distance attenuation without stereo pan", () => {
  const origin = vec3(0, 0, 0);
  const axis: import("../src/core/math.ts").Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  expect(spatializeSoundOrigin(vec3(0, 80, 0), origin, axis, 127, 2)).toEqual({ left: 127, right: 0 });
  expect(spatializeSoundOrigin(vec3(0, 80, 0), origin, axis, 127, 1)).toEqual({ left: 127, right: 127 });
  expect(spatializeSoundOrigin(vec3(0, 1330, 0), origin, axis, 127, 1)).toEqual({ left: 0, right: 0 });
});

test("channel scan returns new starts and source channel reset prints through developer gate", () => {
  const mixer = new AudioMixer(22050, () => 0);
  const cvars = new CvarRegistry();
  cvars.register("developer", "1");
  cvars.register("s_show", "0");
  const printed: string[] = [];
  mixer.bindSoundCvars(cvars);
  mixer.bindConsoleOutput(new ConsoleOutput(text => { printed.push(text); }));
  const sound = { sampleRate: 22050, channels: 1, samples: new Int16Array([1, 2]), frameCount: 2, loopStart: null } satisfies import("../src/assets/wav.ts").PcmSound;
  expect(mixer.scanChannelStarts()).toBe(false);
  mixer.startLocalSound(sound, 0);
  expect(mixer.scanChannelStarts()).toBe(true);
  expect(mixer.scanChannelStarts()).toBe(false);
  mixer.clearSoundBuffer();
  expect(printed).toEqual(["Channel memory manager started\n"]);
});

test("source loop clear retires a persistent sound whose retained length became zero", () => {
  const mixer = new AudioMixer(22050, () => 0);
  const sound = { sampleRate: 22050, channels: 1, samples: new Int16Array([1000]), frameCount: 1, loopStart: null } satisfies import("../src/assets/wav.ts").PcmSound;
  let length = 1;
  mixer.bindSoundMemory({ frameCount: () => length, hasData: () => true, sample: () => 1000, touch: () => undefined });
  mixer.updateRealLoopingSound(sound, { entity: 1, origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0) });
  length = 0;
  mixer.clearLoopingSounds(false);
  length = 1;
  mixer.setListener(0, vec3(0, 0, 0), [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]);
  expect([...mixer.mix(1)]).toEqual([0, 0]);
});

test("source transfer clips, selects left mono, offsets circular stereo, and emits unsigned eight-bit", () => {
  const paint = new Int32Array([-0x800001, 0x800000, -256, 256, 0, 32767 * 256]);
  const stereo = new Int16Array(8).fill(19);
  writeLinearBlastStereo16(paint, stereo, 6);
  expect([...stereo]).toEqual([-32768, 32767, -1, 1, 0, 32767, 19, 19]);
  transferPaintBuffer(paint, { samplebits: 16, channels: 2, samples: stereo }, 3, 6);
  expect([...stereo]).toEqual([-1, 1, 0, 32767, 0, 32767, -32768, 32767]);
  const mono = new Int16Array(4).fill(19);
  transferPaintBuffer(paint, { samplebits: 16, channels: 1, samples: mono }, 3, 6);
  expect([...mono]).toEqual([-1, 0, 19, -32768]);
  const bytes = new Uint8Array(8).fill(19);
  transferPaintBuffer(paint, { samplebits: 8, channels: 2, samples: bytes }, 3, 6);
  expect([...bytes]).toEqual([127, 128, 128, 255, 19, 19, 0, 255]);
  const monoBytes = new Uint8Array(4).fill(19);
  transferPaintBuffer(paint, { samplebits: 8, channels: 1, samples: monoBytes }, 3, 6);
  expect([...monoBytes]).toEqual([127, 128, 19, 0]);
});

test("source test-sound replaces paint and keeps unwritten ring samples", () => {
  const paint = new Int32Array(4).fill(123);
  const output = new Int16Array(8).fill(19);
  transferPaintBuffer(paint, { samplebits: 16, channels: 2, samples: output }, 0, 2, true);
  expect([...paint]).toEqual([0, 0, 511147, 511147]);
  expect([...output]).toEqual([0, 0, 1996, 1996, 19, 19, 19, 19]);
});

test("ADPCM painter caches sound identity, reloads boundary, and applies old Doppler scale", () => {
  const codec = new SourceWaveletCodec(chunk);
  const painter = new SourceCompressedPainter(codec);
  const first = chunk(100), second = chunk(300);
  first.next = second;
  const sound = { soundData: first };
  const paint = new Int32Array(10);
  painter.paintAdpcm(sound, channel, paint, 2, 4095, 1, 256);
  expect([...paint]).toEqual([0, 0, 25600, 12800, 76800, 38400, 0, 0, 0, 0]);
  second.adpcm.sample = 900;
  painter.paintAdpcm(sound, channel, paint, 1, 4096, 3, 256);
  expect([...paint.subarray(6, 8)]).toEqual([76800, 38400]);
  painter.paintAdpcm(sound, { ...channel, doppler: true, oldDopplerScale: 2 }, paint, 1, 2048, 4, 256);
  expect([...paint.subarray(8)]).toEqual([76800, 38400]);
});

test("wavelet painter retains source ADPCM initial decode and wavelet boundary decode", () => {
  const codec = new SourceWaveletCodec(chunk);
  codec.encodeMuLaw({ soundData: null, soundLength: 0 }, new Int16Array(0));
  const first = chunk(100), second = chunk();
  first.next = second;
  codec.encodeWavelet({ soundData: null, soundLength: 4 }, new Int16Array([1000, 1000, 1000, 1000]));
  second.size = 4;
  second.data.set([0x47, 0x47, 0x7f, 0x7f]);
  const painter = new SourceCompressedPainter(codec);
  const paint = new Int32Array(4);
  painter.paintWavelet({ soundData: first }, channel, paint, 2, 2047, 0, 256);
  expect([...paint]).toEqual([25600, 12800, 989 * 256, 989 * 128]);
});

test("mu-law painter keeps lazy table, crosses chunks and resets Doppler offset to zero", () => {
  const codec = new SourceWaveletCodec(chunk);
  const painter = new SourceCompressedPainter(codec);
  const first = chunk(), second = chunk();
  first.next = second;
  first.data[2047] = 0x7e;
  second.data[0] = 0x6f;
  second.data[1] = 0x47;
  const sound = { soundData: first };
  const paint = new Int32Array(4);
  painter.paintMuLaw(sound, channel, paint, 2, 2047, 0, 256);
  expect([...paint]).toEqual([0, 0, 0, 0]);
  codec.encodeMuLaw({ soundData: null, soundLength: 0 }, new Int16Array(0));
  painter.paintMuLaw(sound, { ...channel, doppler: true, dopplerScale: 2 }, paint, 2, 2047, 0, 256);
  expect([...paint]).toEqual([4 * 256, 4 * 128, 124 * 256, 124 * 128]);
  const boundary = new Int32Array(2);
  expect(() => painter.paintMuLaw({ soundData: second }, channel, boundary, 1, 2047, 0, 256)).toThrow("null source chunk");
  expect([...boundary]).toEqual([31612 * 256, 31612 * 128]);
});
