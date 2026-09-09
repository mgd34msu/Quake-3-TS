import { describe, expect, test } from "bun:test";

import { daub4, muLawDecode, muLawEncode, SourceWaveletCodec, wt1 } from "../src/audio/wavelet.ts";
import type { WaveletSound, WaveletSoundChunk } from "../src/audio/wavelet.ts";

function chunk(): WaveletSoundChunk {
  const backing = new Int16Array(1026);
  backing.fill(0x5555);
  return { sndChunk: backing.subarray(1, 1025), size: 91, next: null };
}

function head(sound: WaveletSound): WaveletSoundChunk {
  if (sound.soundData === null) throw new Error("missing test sound chunk");
  return sound.soundData;
}

function data(chunk: WaveletSoundChunk): Uint8Array {
  return new Uint8Array(chunk.sndChunk.buffer, chunk.sndChunk.byteOffset, chunk.sndChunk.byteLength);
}

describe("snd_wavelet.c", () => {
  test("NXPutc retains its cursor across stream arguments and narrows signed bytes", () => {
    const codec = new SourceWaveletCodec(chunk);
    const first = new Uint8Array(4).fill(7);
    const second = new Uint8Array(4).fill(9);
    codec.nxPutc(first, -1);
    codec.nxPutc(second, 128);
    expect([...first]).toEqual([255, 7, 7, 7]);
    expect([...second]).toEqual([9, 128, 9, 9]);
    const independent = new SourceWaveletCodec(chunk);
    independent.nxPutc(second, 12);
    expect([...second]).toEqual([12, 128, 9, 9]);
    expect(() => codec.nxPutc(new Uint8Array(2), 1)).toThrow("outside stream");
    codec.nxPutc(second, 21);
    expect([...second]).toEqual([12, 128, 9, 21]);
  });
  test("mu-law retains source sign, bias, saturation and zero encodings", () => {
    const samples = [-32768, -32767, -128, -4, -1, 0, 1, 4, 128, 32767];
    const encoded = [0x80, 0x80, 0xef, 0xfe, 0xff, 0x7f, 0x7f, 0x7e, 0x6f, 0];
    expect(samples.map(muLawEncode)).toEqual(encoded);
    expect(encoded.map(muLawDecode)).toEqual([-31612, -31612, -124, -4, 4, -4, -4, 4, 124, 31612]);
    expect(() => muLawEncode(32768)).toThrow();
    expect(() => muLawEncode(0.5)).toThrow();
    expect(() => muLawDecode(256)).toThrow();
  });

  test("daub4 periodic impulse has source coefficient order and binary32 storage", () => {
    const samples = new Float32Array([1, 0, 0, 0, 77]);
    daub4(samples, 4, 0);
    expect(Array.from(samples)).toEqual([
      Math.fround(0.4829629131445341), Math.fround(0.2241438680420134),
      Math.fround(-0.1294095225512604), Math.fround(0.8365163037378079), 77,
    ]);
    daub4(samples, 4, -1);
    expect(samples[0]).toBeCloseTo(1, 6);
    for (const sample of samples.subarray(1, 4)) expect(sample).toBeCloseTo(0, 6);
    expect(samples[4]).toBe(77);
  });

  test("wt1 uses three stages, retains source six-sample asymmetry and rejects undefined stages", () => {
    for (const size of [4, 8, 12, 24, 64, 2048]) {
      const original = Float32Array.from({ length: size }, (_, i) => (i % 17) * 53 - 400);
      const samples = original.slice();
      wt1(samples, size, 1);
      wt1(samples, size, -1);
      for (let i = 0; i < size; i++) {
        const sample = samples[i];
        const expected = original[i];
        if (sample === undefined || expected === undefined) throw new Error("missing test sample");
        expect(sample).toBeCloseTo(expected, 3);
      }
    }
    const six = new Float32Array([1, 2, 3, 4, 5, 6]);
    const direct = six.slice();
    wt1(six, 6, 1);
    daub4(direct, 6, 1);
    expect(six).toEqual(direct);
    wt1(six, 6, -1);
    daub4(direct, 4, -1);
    expect(six).toEqual(direct);
    expect(() => wt1(new Float32Array(3), 3, 1)).toThrow("does not terminate");
    expect(() => wt1(new Float32Array(10), 10, 1)).toThrow("uninitialized");
    expect(() => daub4(new Float32Array(4098), 4098, 1)).toThrow();
  });

  test("wavelet publishes reused chunks, encodes known constant coefficients and preserves tails", () => {
    const allocation = chunk();
    const sound: WaveletSound = { soundLength: 4, soundData: null };
    const codec = new SourceWaveletCodec(() => allocation);
    codec.encodeWavelet(sound, new Int16Array([1000, 1000, 1000, 1000]));
    expect(head(sound)).toBe(allocation);
    expect(allocation.size).toBe(4);
    expect(Array.from(data(allocation).subarray(0, 5))).toEqual([0x47, 0x47, 0x7f, 0x7f, 0x55]);
    const output = new Int16Array(5);
    output[4] = 123;
    codec.decodeWavelet(allocation, output);
    expect(Array.from(output)).toEqual([989, 995, 989, 995, 123]);
    codec.decodeWavelet(allocation, null);
    const truncated = new Int16Array(2);
    expect(() => codec.decodeWavelet(allocation, truncated)).toThrow("destination is truncated");
    expect(Array.from(truncated)).toEqual([989, 995]);
  });

  test("lazy table is zero until encoding, including an empty sound", () => {
    const codec = new SourceWaveletCodec(chunk);
    const allocation = chunk();
    allocation.size = 4;
    data(allocation).fill(0, 0, 4);
    const output = new Int16Array(4);
    codec.decodeMuLaw(allocation, output);
    expect(Array.from(output)).toEqual([0, 0, 0, 0]);
    codec.decodeWavelet(allocation, output);
    expect(Array.from(output)).toEqual([0, 0, 0, 0]);
    codec.encodeWavelet({ soundLength: 0, soundData: null }, new Int16Array(0));
    expect(codec.muLawSample(0)).toBe(31612);
    codec.decodeMuLaw(allocation, output);
    expect(Array.from(output)).toEqual([31612, 31612, 31612, 31612]);
    expect(() => codec.decodeWavelet(allocation, output)).toThrow("decoded wavelet short");
  });

  test("mu-law error feedback crosses chunk boundaries and preserves unused bytes", () => {
    const codec = new SourceWaveletCodec(chunk);
    const sound: WaveletSound = { soundLength: 2049, soundData: null };
    const packets = new Int16Array(2049);
    packets[2047] = 3;
    packets[2048] = 1;
    codec.encodeMuLaw(sound, packets);
    const first = head(sound);
    const second = first.next;
    if (second === null) throw new Error("missing second test chunk");
    expect(first.size).toBe(2048);
    expect(Array.from(data(first).subarray(0, 4))).toEqual([0x7f, 0x7e, 0x7f, 0x7e]);
    expect(second.size).toBe(1);
    expect(Array.from(data(second).subarray(0, 2))).toEqual([0x7e, 0x55]);
    expect(second.next).toBeNull();
  });

  test("tail padding comes from caller allocation and failed reads retain source publication", () => {
    const codec = new SourceWaveletCodec(chunk);
    const short: WaveletSound = { soundLength: 1, soundData: null };
    expect(() => codec.encodeWavelet(short, new Int16Array([1]))).toThrow("outside allocation");
    expect(head(short).size).toBe(91);
    expect(data(head(short))[0]).toBe(0x55);
    const padded: WaveletSound = { soundLength: 1, soundData: null };
    codec.encodeWavelet(padded, new Int16Array([1000, 1000, 1000, 1000]));
    expect(head(padded).size).toBe(4);
    expect(Array.from(data(head(padded)).subarray(0, 4))).toEqual([0x47, 0x47, 0x7f, 0x7f]);
    const muLaw: WaveletSound = { soundLength: 2, soundData: null };
    expect(() => codec.encodeMuLaw(muLaw, new Int16Array([0]))).toThrow("outside allocation");
    expect(Array.from(data(head(muLaw)).subarray(0, 2))).toEqual([0x7f, 0x55]);
    expect(head(muLaw).size).toBe(91);
    head(padded).size = 2049;
    expect(() => codec.decodeMuLaw(head(padded), new Int16Array(2049))).toThrow();
  });
});
