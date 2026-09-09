import { describe, expect, test } from "bun:test";

import {
  ADPCM_CHUNK_BYTES,
  ADPCM_CHUNK_SAMPLES,
  AdpcmChunk,
  adpcmMemoryNeeded,
  decodeAdpcm,
  decodeAdpcmChunk,
  encodeAdpcm,
  encodeAdpcmSound,
} from "../src/audio/adpcm.ts";
import type { AdpcmSound, AdpcmState } from "../src/audio/adpcm.ts";

describe("snd_adpcm.c Intel/DVI codec", () => {
  test("encodes a hand-calculated signed sequence with high-nibble-first odd padding", () => {
    const state: AdpcmState = { sample: 0, index: 0 };
    const output = new Uint8Array(6).fill(0xab);
    // At step 7 the successive magnitudes 0, 1, 2 encode as 0, 1, 1.
    // Step/index then progress 7/0 -> 9/2 -> 16/8 -> 28/14 -> 41/18.
    encodeAdpcm(new Int16Array([0, 1, -1, 7, -7, 20, -20]), output, state);
    expect(Array.from(output)).toEqual([0x01, 0x94, 0xe6, 0xd0, 0xab, 0xab]);
    expect(state).toEqual({ sample: -19, index: 18 });

    const decoded = new Int16Array(7);
    const decoder: AdpcmState = { sample: 0, index: 0 };
    decodeAdpcm(new Uint8Array([0x01, 0x94, 0xe6, 0xdf]), decoded, decoder);
    expect(Array.from(decoded)).toEqual([0, 1, 0, 7, -7, 19, -19]);
    expect(decoder).toEqual({ sample: -19, index: 18 });
  });

  test("decodes all nibbles using separately truncated step components", () => {
    // Step 7 gives components 0, 7, 3, 1, not floor((delta + .5) * 7 / 4).
    const magnitudes = [0, 1, 3, 4, 7, 8, 10, 11];
    const indexes = [0, 0, 0, 0, 2, 4, 6, 8];
    for (const [delta, magnitude] of magnitudes.entries()) {
      const index = indexes[delta];
      if (index === undefined) throw new Error(`Missing expected ADPCM index for nibble ${delta}`);
      for (const sign of [0, 8]) {
        const state: AdpcmState = { sample: 100, index: 0 };
        const output = new Int16Array(1);
        decodeAdpcm(new Uint8Array([((delta | sign) << 4) | 7]), output, state);
        const sample = 100 + (sign === 0 ? magnitude : -magnitude);
        expect(Array.from(output)).toEqual([sample]);
        expect(state).toEqual({ sample, index });
      }
    }
  });

  test("clamps predictor and upper index without using the updated step prematurely", () => {
    const state: AdpcmState = { sample: 32760, index: 88 };
    const output = new Int16Array(4);
    decodeAdpcm(new Uint8Array([0x0f, 0x90]), output, state);
    expect(Array.from(output)).toEqual([32767, -23096, -32768, -29044]);
    expect(state).toEqual({ sample: -29044, index: 86 });

    const encoder: AdpcmState = { sample: 32760, index: 88 };
    const bytes = new Uint8Array(2);
    encodeAdpcm(new Int16Array([32767, -32768, -32768]), bytes, encoder);
    expect(Array.from(bytes)).toEqual([0x0f, 0x90]);
    expect(encoder).toEqual({ sample: -32768, index: 87 });
  });

  test("carries predictor and index across calls but resets nibble position each call", () => {
    const state: AdpcmState = { sample: 0, index: 0 };
    const first = new Uint8Array(1);
    const second = new Uint8Array(1);
    encodeAdpcm(new Int16Array([7]), first, state);
    expect(Array.from(first)).toEqual([0x40]);
    expect(state).toEqual({ sample: 7, index: 2 });
    encodeAdpcm(new Int16Array([-7]), second, state);
    expect(Array.from(second)).toEqual([0xe0]);
    expect(state).toEqual({ sample: -7, index: 8 });
    const decoder: AdpcmState = { sample: 0, index: 0 };
    const output = new Int16Array(1);
    decodeAdpcm(first, output, decoder);
    expect(output[0]).toBe(7);
    decodeAdpcm(second, output, decoder);
    expect(output[0]).toBe(-7);
    expect(decoder).toEqual(state);
  });

  test("empty low-level calls retain state and storage; sliced buffers use their own offsets", () => {
    const state: AdpcmState = { sample: -1234, index: 22 };
    const bytes = new Uint8Array([0xab, 0xab, 0xab]);
    encodeAdpcm(new Int16Array(), bytes, state);
    decodeAdpcm(bytes, new Int16Array(), state);
    expect(state).toEqual({ sample: -1234, index: 22 });
    expect(Array.from(bytes)).toEqual([0xab, 0xab, 0xab]);
    state.sample = 0;
    state.index = 0;
    encodeAdpcm(new Int16Array([100, 7, -7, 100]).subarray(1, 3), bytes.subarray(1, 2), state);
    expect(Array.from(bytes)).toEqual([0xab, 0x4e, 0xab]);
    const decoded = new Int16Array([99, 99, 99, 99]);
    decodeAdpcm(bytes.subarray(1, 2), decoded.subarray(1, 3), { sample: 0, index: 0 });
    expect(Array.from(decoded)).toEqual([99, 7, -7, 99]);
    const shared = new ArrayBuffer(4);
    const sharedBytes = new Uint8Array(shared);
    sharedBytes[0] = 0x4e;
    const sharedSamples = new Int16Array(shared);
    decodeAdpcm(sharedBytes.subarray(0, 1), sharedSamples, { sample: 0, index: 0 });
    expect(Array.from(sharedSamples)).toEqual([7, -7]);
  });

  test("rejects truncated buffers and malformed state before mutation", () => {
    const state: AdpcmState = { sample: 0, index: 0 };
    const output = new Int16Array([77, 77, 77]);
    expect(() => decodeAdpcm(new Uint8Array([0x77]), output, state)).toThrow("truncated");
    expect(Array.from(output)).toEqual([77, 77, 77]);
    const bytes = new Uint8Array([0xab]);
    expect(() => encodeAdpcm(output, bytes, state)).toThrow("too short");
    expect(Array.from(bytes)).toEqual([0xab]);
    expect(state).toEqual({ sample: 0, index: 0 });
    for (const index of [-1, 89, 0.5, NaN, Infinity]) {
      expect(() => decodeAdpcm(bytes, new Int16Array(1), { sample: 0, index })).toThrow("index");
    }
    for (const sample of [-32769, 32768, 0.5, NaN, Infinity]) {
      expect(() => encodeAdpcm(new Int16Array(1), bytes, { sample, index: 0 })).toThrow("predictor");
    }
  });
});

describe("snd_adpcm.c sound chunk contract", () => {
  test("saves pre-block headers and preserves allocated tails while decoding all 4096 samples", () => {
    const samples = new Int16Array(ADPCM_CHUNK_SAMPLES + 3);
    samples.set([7, -7, 20, -20, 0], ADPCM_CHUNK_SAMPLES - 2);
    const sound: AdpcmSound = { soundData: null };
    encodeAdpcmSound(samples, sound, () => new AdpcmChunk(new Uint8Array(ADPCM_CHUNK_BYTES).fill(0xab)));
    const first = sound.soundData;
    if (first === null || first.next === null) throw new Error("expected two chunks");
    const second = first.next;
    expect(first.adpcm).toEqual({ sample: 0, index: 0 });
    expect(first.data[ADPCM_CHUNK_BYTES - 1]).toBe(0x4e);
    expect(second.adpcm).toEqual({ sample: -7, index: 8 });
    expect(Array.from(second.data.subarray(0, 4))).toEqual([0x6d, 0x10, 0xab, 0xab]);
    expect(second.next).toBeNull();
    const output = new Int16Array(ADPCM_CHUNK_SAMPLES + 1).fill(12345);
    decodeAdpcmChunk(second, output);
    expect(Array.from(output.subarray(0, 5))).toEqual([19, -19, -4, 0, -21]);
    expect(output[ADPCM_CHUNK_SAMPLES]).toBe(12345);
    expect(second.adpcm).toEqual({ sample: -7, index: 8 });
    const repeated = new Int16Array(ADPCM_CHUNK_SAMPLES);
    decodeAdpcmChunk(second, repeated);
    expect(repeated).toEqual(output.subarray(0, ADPCM_CHUNK_SAMPLES));
  });

  test("initializes from sample zero and publishes completed chunks before later allocation failure", () => {
    const sound: AdpcmSound = { soundData: null };
    let allocations = 0;
    encodeAdpcmSound(new Int16Array(ADPCM_CHUNK_SAMPLES).fill(-123), sound, () => {
      allocations++;
      return new AdpcmChunk(new Uint8Array(ADPCM_CHUNK_BYTES));
    });
    expect(allocations).toBe(1);
    expect(sound.soundData?.adpcm).toEqual({ sample: -123, index: 0 });
    expect(sound.soundData?.next).toBeNull();
    const partial: AdpcmSound = { soundData: null };
    allocations = 0;
    expect(() => encodeAdpcmSound(new Int16Array(ADPCM_CHUNK_SAMPLES + 1).fill(123), partial, () => {
      if (allocations++ !== 0) throw new Error("allocation failed");
      return new AdpcmChunk(new Uint8Array(ADPCM_CHUNK_BYTES));
    })).toThrow("allocation failed");
    expect(partial.soundData?.adpcm).toEqual({ sample: 123, index: 0 });
    expect(partial.soundData?.next).toBeNull();
    expect(partial.soundData?.data.every(value => value === 0)).toBe(true);
  });

  test("rejects unsupported initial state and invalid chunk boundaries", () => {
    const chunk = new AdpcmChunk(new Uint8Array(ADPCM_CHUNK_BYTES));
    expect(() => new AdpcmChunk(new Uint8Array(1))).toThrow("2048");
    expect(() => decodeAdpcmChunk(chunk, new Int16Array(4095))).toThrow("4096");
    expect(() => encodeAdpcmSound(new Int16Array(), { soundData: null }, () => chunk)).toThrow("initial sample");
    expect(() => encodeAdpcmSound(new Int16Array([0]), { soundData: chunk }, () => chunk)).toThrow("cleared");
  });

  test("memory estimate retains odd truncation, block headers and float32 count conversion", () => {
    expect(adpcmMemoryNeeded(0, 22050, 22050)).toBe(0);
    expect(adpcmMemoryNeeded(1, 22050, 22050)).toBe(4);
    expect(adpcmMemoryNeeded(4096, 22050, 22050)).toBe(2052);
    expect(adpcmMemoryNeeded(4097, 22050, 22050)).toBe(2056);
    expect(adpcmMemoryNeeded(8194, 44100, 22050)).toBe(2056);
    expect(adpcmMemoryNeeded(4097, 22050, 44100)).toBe(4109);
    // 16,777,217 rounds to 16,777,216 before the source float division.
    expect(adpcmMemoryNeeded(16777217, 22050, 22050)).toBe(8404992);
    expect(() => adpcmMemoryNeeded(1, 0, 22050)).toThrow("positive");
    expect(() => adpcmMemoryNeeded(-1, 22050, 22050)).toThrow("32-bit");
    expect(() => adpcmMemoryNeeded(1.5, 22050, 22050)).toThrow("32-bit");
    expect(() => adpcmMemoryNeeded(0x7fffffff, 1, 2)).toThrow("scaled");
  });
});
