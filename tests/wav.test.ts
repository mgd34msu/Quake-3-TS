import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryError } from "../src/core/binary.ts";
import { decodeWav, readWavInfo } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";

interface TestChunk {
  readonly id: string;
  readonly data: Uint8Array;
}

function writeFourCc(output: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < 4; index++) output[offset + index] = value.charCodeAt(index);
}

function makeFormat(channels: number, sampleRate: number, bitsPerSample: number): Uint8Array {
  const output = new Uint8Array(16);
  const view = new DataView(output.buffer);
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  view.setUint16(0, 1, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * blockAlign, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);
  return output;
}

function makeCue(loopStart: number): Uint8Array {
  const output = new Uint8Array(28);
  const view = new DataView(output.buffer);
  view.setUint32(0, 1, true);
  writeFourCc(output, 12, "data");
  view.setUint32(24, loopStart, true);
  return output;
}

function makeSamplerLoop(loopStart: number): Uint8Array {
  const output = new Uint8Array(60);
  const view = new DataView(output.buffer);
  view.setUint32(28, 1, true);
  view.setUint32(44, loopStart, true);
  view.setUint32(48, loopStart + 1, true);
  return output;
}

function makeWav(chunks: readonly TestChunk[]): Uint8Array {
  let chunkBytes = 0;
  for (const chunk of chunks) chunkBytes += 8 + chunk.data.length + (chunk.data.length & 1);
  const output = new Uint8Array(12 + chunkBytes);
  const view = new DataView(output.buffer);
  writeFourCc(output, 0, "RIFF");
  view.setUint32(4, output.length - 8, true);
  writeFourCc(output, 8, "WAVE");
  let offset = 12;
  for (const chunk of chunks) {
    writeFourCc(output, offset, chunk.id);
    view.setUint32(offset + 4, chunk.data.length, true);
    output.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.length + (chunk.data.length & 1);
  }
  return output;
}

function pcm16(values: readonly number[]): Uint8Array {
  const output = new Uint8Array(values.length * 2);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of values) {
    view.setInt16(offset, value, true);
    offset += 2;
  }
  return output;
}

async function sourceBank(bytes: Uint8Array, onPrint: (text: string, bank: ClientSoundBank) => undefined = () => undefined) {
  const memory = new ReadFileMemory();
  const events: string[] = [];
  const hit = makeWav([
    { id: "fmt ", data: makeFormat(1, 22050, 16) },
    { id: "data", data: pcm16([1]) },
  ]);
  const read = (name: string) => {
    const data = name === "sound/feedback/hit.wav" ? hit : bytes;
    return memory.read(data.length, target => { target.set(data); });
  };
  const bank: ClientSoundBank = new ClientSoundBank({
    readFileRetained: name => Promise.resolve(read(name)),
    readFileRetainedSync: read,
    freeFile: buffer => { events.push("free"); memory.freeFile(buffer); },
  }, {
    print: text => { events.push(text); onPrint(text, bank); },
    debugPrint: text => { events.push(text); },
  });
  bank.initializeMemory({ chunkCount: 8, sampleRate: () => 22050, milliseconds: () => { events.push("clock"); return 0; } });
  await bank.beginRegistration();
  events.length = 0;
  return { bank, events, memory };
}

describe("source WAV sound loading", () => {
  test("actual registration ignores unused header fields, metadata contents and a malformed tail", async () => {
    const format = makeFormat(1, 22050, 16);
    const formatView = new DataView(format.buffer);
    formatView.setUint32(8, 1, true);
    formatView.setUint16(12, 0, true);
    const wav = makeWav([
      { id: "cue ", data: new Uint8Array() },
      { id: "fmt ", data: format },
      { id: "smpl", data: new Uint8Array() },
      { id: "data", data: pcm16([-123, 456]) },
    ]);
    const bytes = new Uint8Array(wav.length + 3);
    bytes.set(wav);
    bytes.set([1, 2, 3], wav.length);
    new DataView(bytes.buffer).setUint32(4, 0, true);
    const { bank, events, memory } = await sourceBank(bytes);
    expect(bank.sound("sync.wav", false)?.samples).toEqual(new Int16Array([-123, 456]));
    expect((await bank.registerSound("async.wav", false))?.samples).toEqual(new Int16Array([-123, 456]));
    expect(events).toEqual(["clock", "free", "clock", "free"]);
    expect(memory.loadStack).toBe(0);
  });

  test("searches RIFF and first data independently of the declared RIFF and fmt extents", async () => {
    const wav = makeWav([
      { id: "data", data: pcm16([321, -654]) },
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
    ]);
    new DataView(wav.buffer).setUint32(28, 1000, true);
    const bytes = new Uint8Array(wav.length + 12);
    writeFourCc(bytes, 0, "JUNK");
    new DataView(bytes.buffer).setUint32(4, 3, true);
    bytes.set(wav, 12);
    const { bank, events } = await sourceBank(bytes);
    const sound = bank.sound("ordered.wav", false);
    expect(sound?.samples).toEqual(new Int16Array([321, -654]));
    expect(sound?.loopStart).toBeNull();
    expect(events).toEqual(["clock", "free"]);
  });

  test("resampling checks selected sample reads instead of the whole declared data payload", async () => {
    const bytes = makeWav([
      { id: "fmt ", data: makeFormat(1, 44100, 16) },
      { id: "data", data: pcm16([11, 22, 33, 44]) },
    ]).slice(0, -2);
    const { bank, events } = await sourceBank(bytes);
    expect(bank.sound("decimate.wav", false)?.samples).toEqual(new Int16Array([11, 33]));
    expect(events).toEqual(["^3WARNING: decimate.wav is not a 22kHz wav file\n", "clock", "free"]);
  });

  test("reached sample reads can consume the actual FS_ReadFile trailing NUL", async () => {
    const bytes = makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
      { id: "data", data: pcm16([11, 0x12ff]) },
    ]).slice(0, -1);
    const { bank, events } = await sourceBank(bytes);
    expect(bank.sound("terminated.wav", false)?.samples).toEqual(new Int16Array([11, 255]));
    expect(events).toEqual(["clock", "free"]);
  });

  test("uses the first fmt and data, ignoring loop metadata and later duplicate chunks", async () => {
    const unsupported = makeFormat(2, 44100, 16);
    new DataView(unsupported.buffer).setUint16(0, 6, true);
    const bytes = makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
      { id: "fmt ", data: unsupported },
      { id: "cue ", data: makeCue(999) },
      { id: "smpl", data: makeSamplerLoop(999) },
      { id: "data", data: new Uint8Array([0xff, 0xff, 0x7f]) },
      { id: "data", data: pcm16([1234]) },
    ]);
    const { bank, events } = await sourceBank(bytes);
    const sound = bank.sound("first.wav", false);
    expect(sound?.samples).toEqual(new Int16Array([-1]));
    expect(sound?.loopStart).toBeNull();
    expect(events).toEqual(["clock", "free"]);
  });

  test("uses source integer width division and byte conversion for widths other than two", async () => {
    for (const bits of [15, 24]) {
      const bytes = makeWav([
        { id: "fmt ", data: makeFormat(1, 22050, bits) },
        { id: "data", data: bits === 15 ? new Uint8Array([0, 128, 255]) : new Uint8Array([0, 128, 255, 1, 2, 3, 4, 5, 6]) },
      ]);
      const { bank, events } = await sourceBank(bytes);
      expect(bank.sound("width.wav", false)?.samples).toEqual(new Int16Array([-32768, 0, 32512]));
      expect(events).toEqual(bits === 15 ? ["^3WARNING: width.wav is a 8 bit wav file\n", "clock", "free"] : ["clock", "free"]);
    }
  });

  test("missing RIFF and fmt diagnostics precede stereo rejection, file free and default warnings", async () => {
    for (const bytes of [new Uint8Array(), makeWav([])]) {
      for (const method of ["sync", "async"]) {
        const { bank, events, memory } = await sourceBank(bytes);
        const sound = method === "sync" ? bank.sound("missing.wav", false) : await bank.registerSound("missing.wav", false);
        expect(sound).toBeNull();
        expect(events).toEqual([
          bytes.length === 0 ? "Missing RIFF/WAVE chunks\n" : "Missing fmt chunk\n",
          "missing.wav is a stereo wav file\n", "free", "^3WARNING: could not find missing.wav - using default\n",
        ]);
        expect(memory.loadStack).toBe(0);
      }
    }
  });

  test("unsupported format and missing data return partial mono info before the source load tail", async () => {
    for (const encoding of [1, 6]) {
      const format = makeFormat(1, 11025, 8);
      new DataView(format.buffer).setUint16(0, encoding, true);
      const { bank, events, memory } = await sourceBank(makeWav([{ id: "fmt ", data: format }]));
      const sound = bank.sound("partial.wav", false);
      expect(sound).not.toBeNull();
      expect(sound?.samples).toHaveLength(0);
      expect(events).toEqual([
        encoding === 1 ? "Missing data chunk\n" : "Microsoft PCM format only\n",
        "^3WARNING: partial.wav is a 8 bit wav file\n", "^3WARNING: partial.wav is not a 22kHz wav file\n", "clock", "free",
      ]);
      expect(memory.loadStack).toBe(0);
    }
  });

  test("a source format print cannot continue across a retired registration lifetime", async () => {
    for (const method of ["sync", "async"]) {
      const { bank, events, memory } = await sourceBank(makeWav([]), (text, current) => {
        if (text === "Missing fmt chunk\n") {
          current.setRegistrationEnabled(false);
          current.setRegistrationEnabled(true);
        }
      });
      if (method === "sync") expect(() => bank.sound("retire.wav", false)).toThrow("lifetime ended");
      else await expect(bank.registerSound("retire.wav", false)).rejects.toThrow("lifetime ended");
      expect(events).toEqual(["Missing fmt chunk\n"]);
      expect(memory.loadStack).toBe(1);
      expect(bank.registeredSounds()[1]?.sound).toBeNull();
    }
  });

  test("a physical sample overread retains the already written source chunk and file", async () => {
    const bytes = makeWav([
      { id: "fmt ", data: makeFormat(1, 11025, 8) },
      { id: "data", data: new Uint8Array([0, 255, 128, 129, 130]) },
    ]).slice(0, 46);
    const { bank, events, memory } = await sourceBank(bytes);
    expect(() => bank.sound("overread.wav", false)).toThrow(BinaryError);
    expect(events).toEqual([
      "^3WARNING: overread.wav is a 8 bit wav file\n", "^3WARNING: overread.wav is not a 22kHz wav file\n", "clock",
    ]);
    expect(memory.loadStack).toBe(1);
    const sound = bank.registeredSounds()[1]?.sound;
    if (sound === undefined || sound === null) throw new Error("Missing partial source sound");
    expect(bank.frameCount(sound)).toBe(10);
    expect([0, 1, 2, 3, 4, 5].map(index => bank.sample(sound, index))).toEqual([-32768, -32768, 32512, 32512, -32768, -32768]);
    expect(bank.memoryUsage()?.totalAllocatedBytes).toBe(2 * 2060);
    expect(bank.registeredSounds()[1]?.inMemory).toBe(false);
  });
});

describe("source WAV scanner boundaries", () => {
  test("short WAVE mismatches print before reading unreachable suffix bytes", () => {
    const bytes = new Uint8Array(9);
    writeFourCc(bytes, 0, "RIFF");
    bytes[8] = 88;
    const printed: string[] = [];
    const info = readWavInfo(bytes, bytes.length, "short-wave.wav", text => { printed.push(text); });
    expect(printed).toEqual(["Missing RIFF/WAVE chunks\n"]);
    expect([info.channels, info.sampleRate, info.sourceBytesPerSample, info.frameCount]).toEqual([0, 0, 0, 0]);
    bytes[8] = 87;
    expect(() => readWavInfo(bytes, bytes.length, "short-wave.wav", () => undefined)).toThrow(BinaryError);
  });

  test("negative chunk lengths end searches without consuming their payload", () => {
    const bytes = makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
      { id: "data", data: pcm16([1234]) },
    ]);
    const printed: string[] = [];
    const view = new DataView(bytes.buffer);
    view.setInt32(40, -1, true);
    const info = readWavInfo(bytes, bytes.length, "negative.wav", text => { printed.push(text); });
    expect(printed).toEqual(["Missing data chunk\n"]);
    expect([info.channels, info.sampleRate, info.sourceBytesPerSample, info.frameCount]).toEqual([1, 22050, 2, 0]);
    view.setInt32(4, -1, true);
    const missing = readWavInfo(bytes, bytes.length, "negative.wav", text => { printed.push(text); });
    expect(printed).toEqual(["Missing data chunk\n", "Missing RIFF/WAVE chunks\n"]);
    expect(missing.channels).toBe(0);
  });

  test("source shorts and rate stay signed and zero-width division rejects only at the data read", () => {
    const format = makeFormat(1, 22050, 16);
    const view = new DataView(format.buffer);
    view.setInt16(2, -1, true);
    view.setInt32(4, -22050, true);
    view.setInt16(14, -16, true);
    const bytes = makeWav([
      { id: "fmt ", data: format },
      { id: "data", data: pcm16([1, 2]) },
    ]);
    const info = readWavInfo(bytes, bytes.length, "signed.wav", () => undefined);
    expect([info.channels, info.sampleRate, info.sourceBytesPerSample, info.frameCount]).toEqual([-1, -22050, -2, -2]);

    view.setInt16(14, 7, true);
    const noData = makeWav([{ id: "fmt ", data: format }]);
    const printed: string[] = [];
    expect(readWavInfo(noData, noData.length, "width.wav", text => { printed.push(text); }).sourceBytesPerSample).toBe(0);
    expect(printed).toEqual(["Missing data chunk\n"]);
    const withData = makeWav([{ id: "fmt ", data: format }, { id: "data", data: new Uint8Array() }]);
    expect(() => readWavInfo(withData, withData.length, "width.wav", () => undefined)).toThrow("divides by zero");
  });

  test("file extent limits searches while physical allocation limits only reached reads", () => {
    const bytes = makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
      { id: "data", data: pcm16([1234]) },
    ]);
    const printed: string[] = [];
    const info = readWavInfo(bytes, 36, "extent.wav", text => { printed.push(text); });
    expect(printed).toEqual(["Missing data chunk\n"]);
    expect(info.frameCount).toBe(0);
    expect(() => readWavInfo(bytes, bytes.length + 1, "extent.wav", () => undefined)).toThrow("physical allocation");
    expect(() => readWavInfo(new Uint8Array(1), 1, "header.wav", () => undefined)).toThrow("truncated WAV chunk header");
    new DataView(bytes.buffer).setUint32(4, 0x7fffffff, true);
    expect(() => readWavInfo(bytes, bytes.length, "overflow.wav", () => undefined)).toThrow("alignment overflows");
  });
});

describe("PCM WAV decoding", () => {
  test("converts unsigned 8-bit mono samples to signed PCM16", () => {
    const sound = decodeWav(makeWav([
      { id: "fmt ", data: makeFormat(1, 11025, 8) },
      { id: "data", data: new Uint8Array([0, 128, 255]) },
    ]));
    expect(sound.sampleRate).toBe(11025);
    expect(sound.sourceBytesPerSample).toBe(1);
    expect(sound.channels).toBe(1);
    expect(sound.frameCount).toBe(3);
    expect(sound.loopStart).toBeNull();
    expect([...sound.samples]).toEqual([-32768, 0, 32512]);
  });

  test("preserves signed little-endian 16-bit stereo interleaving", () => {
    const sound = decodeWav(makeWav([
      { id: "fmt ", data: makeFormat(2, 22050, 16) },
      { id: "data", data: pcm16([-32768, 32767, -1, 1]) },
    ]));
    expect(sound.channels).toBe(2);
    expect(sound.sourceBytesPerSample).toBe(2);
    expect(sound.frameCount).toBe(2);
    expect([...sound.samples]).toEqual([-32768, 32767, -1, 1]);
  });

  test("skips unknown odd-sized chunks and their pad bytes", () => {
    const sound = decodeWav(makeWav([
      { id: "JUNK", data: new Uint8Array([9, 8, 7]) },
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
      { id: "data", data: pcm16([1234]) },
    ]));
    expect([...sound.samples]).toEqual([1234]);
  });

  test("accepts the omitted final pad used by retail 8-bit WAVs", () => {
    const padded = makeWav([
      { id: "fmt ", data: makeFormat(1, 11025, 8) },
      { id: "data", data: new Uint8Array([128, 129, 130]) },
    ]);
    const unpadded = padded.slice(0, -1);
    new DataView(unpadded.buffer).setUint32(4, unpadded.length - 8, true);
    expect([...decodeWav(unpadded).samples]).toEqual([0, 256, 512]);
  });

  test("reads cue and sampler loop metadata", () => {
    const cueSound = decodeWav(makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 8) },
      { id: "cue ", data: makeCue(1) },
      { id: "data", data: new Uint8Array([128, 129, 130]) },
    ]));
    const samplerSound = decodeWav(makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 8) },
      { id: "smpl", data: makeSamplerLoop(2) },
      { id: "data", data: new Uint8Array([128, 129, 130, 131]) },
    ]));
    expect(cueSound.loopStart).toBe(1);
    expect(samplerSound.loopStart).toBe(2);
  });

  test("rejects malformed headers, chunks, and PCM data", () => {
    expect(() => decodeWav(new Uint8Array(11), "short.wav")).toThrow("short.wav:0: truncated RIFF/WAVE header");
    expect(() => decodeWav(new Uint8Array(12))).toThrow(BinaryError);

    const truncated = makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 16) },
      { id: "data", data: pcm16([1]) },
    ]).slice(0, -1);
    expect(() => decodeWav(truncated)).toThrow("RIFF size");

    const misaligned = makeWav([
      { id: "fmt ", data: makeFormat(2, 22050, 16) },
      { id: "data", data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(() => decodeWav(misaligned)).toThrow("not a multiple of block alignment");
  });

  test("rejects invalid format fields and out-of-range loops", () => {
    const badRate = makeFormat(1, 22050, 16);
    new DataView(badRate.buffer).setUint32(8, 1, true);
    expect(() => decodeWav(makeWav([
      { id: "fmt ", data: badRate },
      { id: "data", data: pcm16([1]) },
    ]))).toThrow("byte rate");

    expect(() => decodeWav(makeWav([
      { id: "fmt ", data: makeFormat(3, 22050, 16) },
      { id: "data", data: pcm16([1, 2, 3]) },
    ]))).toThrow("channel count");

    expect(() => decodeWav(makeWav([
      { id: "fmt ", data: makeFormat(1, 22050, 8) },
      { id: "cue ", data: makeCue(2) },
      { id: "data", data: new Uint8Array([128, 129]) },
    ]))).toThrow("loop start 2 is outside 2 frames");
  });
});

const retailRoot = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(retailRoot, "baseq3", "pak0.pk3"));

test.skipIf(!retailAvailable)("loads known 16-bit and unpadded 8-bit retail sounds through the VFS", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "baseq3" });
  const announcer = decodeWav(await vfs.read("sound/feedback/1_frag.wav"), "sound/feedback/1_frag.wav");
  expect(announcer.sourceBytesPerSample).toBe(2);
  expect([announcer.sampleRate, announcer.channels, announcer.frameCount]).toEqual([22050, 1, 49151]);
  const buzzer = decodeWav(await vfs.read("sound/world/buzzer.wav"), "sound/world/buzzer.wav");
  expect(buzzer.sourceBytesPerSample).toBe(1);
  expect([buzzer.sampleRate, buzzer.channels, buzzer.frameCount]).toEqual([11025, 1, 13063]);
});
