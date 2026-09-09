// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "../src/assets/file-handles.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BackgroundMusic } from "../src/audio/music.ts";
import { CommonError } from "../src/core/common-error.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { EngineSound } from "../src/engine/sound.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { musicFiles, musicWav } from "./music-file-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const fixtures: Awaited<ReturnType<typeof musicFiles>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

function pcm(samples: readonly number[], sampleRate = 22050, channels: 1 | 2 = 2): PcmSound {
  return { sampleRate, channels, samples: new Int16Array(samples), frameCount: samples.length / channels, loopStart: null };
}

async function sourceFrom(tracks: ReadonlyMap<string, PcmSound | Uint8Array>) {
  const fixture = await musicFiles(tracks);
  fixtures.push(fixture);
  const opens: string[] = [], reads: number[] = [], closes: FileHandle[] = [], printed: string[] = [];
  const open = fixture.files.openUniqueRead.bind(fixture.files);
  const read = fixture.files.readInto.bind(fixture.files);
  const close = fixture.files.closeFile.bind(fixture.files);
  fixture.files.openUniqueRead = (name, selected) => { opens.push(name); return open(name, selected); };
  fixture.files.readInto = (file, bytes) => { reads.push(bytes.byteLength); return read(file, bytes); };
  fixture.files.closeFile = file => { closes.push(file); close(file); };
  return { ...fixture, opens, reads, closes, printed,
    music(readMixer: () => AudioMixer | null): BackgroundMusic {
      return new BackgroundMusic(readMixer, () => fixture.files, text => { printed.push(text); });
    },
  };
}

describe("retained background files", () => {
  test("start diagnostics use complete source names before empty returns and path truncation", async () => {
    const intro = "a".repeat(70), loop = "b".repeat(70), debug: string[] = [];
    const source = await sourceFrom(new Map([[`${intro.slice(0, 59)}.wav`, pcm([100, 100])]]));
    const music = new BackgroundMusic(() => null, () => source.files, text => { source.printed.push(text); },
      text => { debug.push(text); });
    music.start(null, "ignored"); music.start("", null); music.start("\0ignored", "\0ignored");
    expect(source.opens).toEqual([]);
    music.start(`${intro}\0ignored`, `${loop}\0ignored`);
    expect(debug).toEqual([
      "S_StartBackgroundTrack( , ignored )\n", "S_StartBackgroundTrack( ,  )\n", "S_StartBackgroundTrack( ,  )\n",
      `S_StartBackgroundTrack( ${intro}, ${loop} )\n`,
    ]);
    expect(source.opens).toEqual([`${intro.slice(0, 59)}.wav`]);
    expect(music.loopName).toBe(loop.slice(0, 63));
    music.stop();
  });

  test("diagnostic abort retains a manually replaced track but follows the old close at loop EOF", async () => {
    const source = await sourceFrom(new Map([["intro.wav", pcm([100, 100])]]));
    const mixer = new AudioMixer(22050, () => 0), failure = new Error("start diagnostic abort");
    let abort = false;
    const debug: { text: string; playing: boolean; loop: string }[] = [];
    const music = new BackgroundMusic(() => mixer, () => source.files, () => undefined, text => {
      debug.push({ text, playing: music.isPlaying, loop: music.loopName });
      if (abort) throw failure;
    });
    music.start("intro", "loop"); abort = true;
    expect(() => music.start("replacement")).toThrow(failure);
    expect(debug.at(-1)).toEqual({ text: "S_StartBackgroundTrack( replacement, replacement )\n", playing: true, loop: "loop" });
    expect(source.opens).toEqual(["intro.wav"]); expect(source.closes).toHaveLength(0);
    expect(() => music.update()).toThrow(failure);
    expect(debug.at(-1)).toEqual({ text: "S_StartBackgroundTrack( loop, loop )\n", playing: false, loop: "loop" });
    expect(source.closes).toHaveLength(1); expect(mixer.rawEnd).toBe(1);
    music.stop(); expect(mixer.rawEnd).toBe(1);
  });

  test("actual sound owner preserves start diagnostics and aborted file publication without output", async () => {
    const source = await sourceFrom(new Map([
      ["default.cfg", new TextEncoder().encode("set music_fixture 1\n")],
      ["productid.txt", new TextEncoder().encode(SOURCE_PRODUCT_ID)],
      ["intro.wav", musicWav(pcm([100, 100]))],
    ]));
    const printed: string[] = [];
    let abortFilePrint = false;
    const common = await CommonConsole.open({
      roots: { dataPath: source.root, homePath: source.root, cdPath: null, product: "baseq3" },
      startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
      platformPrint: text => {
        printed.push(text);
        if (abortFilePrint && text.startsWith("FS_FOpenFileRead: intro.wav")) throw new CommonError("drop", "Music file debug abort");
      }, resolveCommand: () => undefined,
      assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined,
    }, () => undefined);
    const events = new CommonEvents({ getEvent: () => { throw new Error("Music start must not poll input"); } }, () => undefined);
    const sound = new EngineSound(common, events);
    try {
      common.registerRuntimeCvars("music-source-start", async () => undefined);
      common.cvars.set("developer", "0.5", true);
      await sound.startBackgroundTrack(null, null);
      common.cvars.set("developer", "-1", true);
      await sound.startBackgroundTrack(null, null);
      await sound.startBackgroundTrack("intro\0ignored", "\0ignored");
      common.cvars.set("developer", "0", true);
      await sound.startBackgroundTrack("", "ignored");
      expect(printed.filter(text => text.startsWith("S_StartBackgroundTrack("))).toEqual([
        "S_StartBackgroundTrack( ,  )\n", "S_StartBackgroundTrack( intro, intro )\n",
      ]);
      expect(sound.music.isPlaying).toBe(true); expect(common.sound.mixer).toBeNull();
      sound.stopBackgroundTrack();
      common.cvars.set("fs_debug", "1", true); abortFilePrint = true;
      await expect(sound.startBackgroundTrack("intro", null)).rejects.toThrow("Music file debug abort");
      expect(sound.music.isPlaying).toBe(true);
      abortFilePrint = false; sound.stopBackgroundTrack();
      const reopened = common.files.current.openUniqueRead("intro.wav");
      expect(reopened?.file.slot).toBe(1);
      if (reopened !== undefined) common.files.current.closeFile(reopened.file);
    } finally { try { sound.close(); } finally { common.close(); } }
  });

  test("final retirement leaves already submitted PCM without reading owners or resetting their raw stream", async () => {
    const source = await sourceFrom(new Map([["track.wav", pcm([1000, 1000, 2000, 2000])]]));
    const mixer = new AudioMixer(48000, () => 0);
    let retiredOwners = false;
    const music = new BackgroundMusic(() => {
      if (retiredOwners) throw new Error("Retired output callback");
      return mixer;
    }, () => {
      if (retiredOwners) throw new Error("Retired filesystem callback");
      return source.files;
    }, () => {});
    mixer.queueRaw(pcm(new Array<number>((mixer.rawCapacity - 1) * 2).fill(0), 48000), 1);
    music.start("track"); music.update();
    expect(mixer.rawEnd).toBe(mixer.rawCapacity + 2);
    retiredOwners = true;
    music.retire(); music.retire(); music.stop(); music.update();
    expect(music.isPlaying).toBe(false); expect(music.mixer).toBeNull();
    expect(mixer.rawEnd).toBe(mixer.rawCapacity + 2); expect(source.closes).toHaveLength(0);
    expect(() => music.start("track")).toThrow("retired");
  });

  test("opens only the intro header, then observes a loop created after start", async () => {
    const source = await sourceFrom(new Map([["intro.wav", pcm([100, 100, 200, 200])]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("intro", "loop");
    expect(source.opens).toEqual(["intro.wav"]);
    expect(source.reads).toEqual([12, 4, 4, 2, 2, 4, 4, 2, 2, 4, 4]);
    await writeFile(join(source.root, "baseq3/loop.wav"), musicWav(pcm(new Array<number>(40000).fill(300))));
    music.update();
    expect(source.opens).toEqual(["intro.wav", "loop.wav"]);
    expect(source.closes).toHaveLength(1);
    expect(Array.from(mixer.mix(3))).toEqual([25, 25, 50, 50, 75, 75]);
    music.stop();
  });

  test("reopens the loop at exact ring completion and sees replacement content on its next open", async () => {
    const mixer = new AudioMixer(22050, () => 0);
    const source = await sourceFrom(new Map([
      ["intro.wav", pcm(new Array<number>(mixer.rawCapacity * 2).fill(100))],
      ["loop.wav", pcm([200, 200])],
    ]));
    const music = source.music(() => mixer);
    music.start("intro", "loop"); music.update();
    expect(mixer.rawEnd).toBe(mixer.rawCapacity);
    expect(source.opens).toEqual(["intro.wav", "loop.wav"]);
    await writeFile(join(source.root, "baseq3/loop.wav"), musicWav(pcm([400, 400])));
    mixer.mix(mixer.rawCapacity);
    // The retained loose descriptor sees the changed bytes; every completed
    // loop still acquires a fresh source handle, including the final full ring.
    music.update();
    expect(source.opens.length).toBe(mixer.rawCapacity + 2);
    expect(Array.from(mixer.mix(1))).toEqual([75, 75]);
    music.stop();
  });

  test("missing loop fails at intro completion and leaves its queued tail", async () => {
    const source = await sourceFrom(new Map([["intro.wav", pcm([100, 100, 200, 200])]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("intro", "missing");
    expect(music.isPlaying).toBe(true);
    expect(source.printed).toEqual([]);
    music.update();
    expect(source.opens).toEqual(["intro.wav", "missing.wav"]);
    expect(source.printed).toEqual(["^3WARNING: couldn't open music file missing.wav\n"]);
    expect(music.isPlaying).toBe(false);
    expect(mixer.rawEnd).toBe(2);
    music.stop();
    expect(mixer.rawEnd).toBe(2);
  });

  test("successive starts preserve queued PCM, and empty intro preserves the active file", async () => {
    const source = await sourceFrom(new Map([
      ["a.wav", pcm(new Array<number>(40000).fill(100))], ["b.wav", pcm(new Array<number>(40000).fill(200))],
    ]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("a"); music.update();
    const previous = mixer.rawEnd;
    music.start("b"); music.start("", "ignored");
    expect(source.opens).toEqual(["a.wav", "b.wav"]);
    expect(source.closes).toHaveLength(1);
    expect(music.loopName).toBe("b");
    expect(mixer.rawEnd).toBe(previous);
    expect(Array.from(mixer.mix(1))).toEqual([25, 25]);
    music.stop(); expect(mixer.rawEnd).toBe(0);
  });

  test("one-shot completion drops the common-owned handle without closing or clearing raw PCM", async () => {
    const source = await sourceFrom(new Map([["once.wav", pcm([100, 100, 200, 200])]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("once"); music.clearLoop(); music.update();
    expect(music.isPlaying).toBe(false); expect(mixer.rawEnd).toBe(2);
    expect(source.closes).toHaveLength(0);
    music.stop(); expect(source.closes).toHaveLength(0); expect(mixer.rawEnd).toBe(2);
    const next = source.files.openUniqueRead("once.wav");
    expect(next?.file.slot).toBe(2);
    if (next !== undefined) source.files.closeFile(next.file);
  });

  test("stop closes music and raw playback while leaving ordinary sound effects alive", async () => {
    const source = await sourceFrom(new Map([["music.wav", pcm(new Array<number>(40000).fill(2000))]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    mixer.setEffectsVolume(1); music.start("music"); music.update();
    mixer.startSound(pcm([256], 22050, 1), { entity: 1, channel: 1, origin: { kind: "local" }, volume: 128 });
    music.stop(); expect(mixer.rawEnd).toBe(0); expect(source.closes).toHaveLength(1);
    expect(Array.from(mixer.mix(1))).toEqual([127, 127]);
  });

  test("retained descriptor survives unlink, and the loop open sees the missing file", async () => {
    const source = await sourceFrom(new Map([["track.wav", pcm([100, 100])]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("track");
    await unlink(join(source.root, "baseq3/track.wav"));
    music.update();
    expect(mixer.rawEnd).toBe(1); expect(music.isPlaying).toBe(false);
    expect(source.opens).toEqual(["track.wav", "track.wav"]);
  });
});

describe("source music reader", () => {
  test("ignores RIFF contents but requires consecutive fmt and data chunks", async () => {
    const ignoredRiff = musicWav(pcm([400, 400])); ignoredRiff.fill(0, 0, 12);
    const extraChunk = musicWav(pcm([400, 400])); extraChunk.set(new TextEncoder().encode("JUNK"), 12);
    const extendedFmt = musicWav(pcm([400, 400])); new DataView(extendedFmt.buffer).setUint32(16, 18, true);
    const source = await sourceFrom(new Map([["ignored.wav", ignoredRiff], ["junk.wav", extraChunk], ["extended.wav", extendedFmt]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("ignored"); expect(music.isPlaying).toBe(true); music.stop();
    music.start("junk"); expect(music.isPlaying).toBe(false);
    expect(source.printed).toContain("No fmt chunk in junk.wav\n");
    // A larger fmt length is ignored; the next read is still at byte 36.
    music.start("extended"); expect(music.isPlaying).toBe(true); music.stop();
  });

  test("reads scalar fields before rejecting non-PCM and preserves failure print/close order", async () => {
    const nonPcm = musicWav(pcm([1, 1])); new DataView(nonPcm.buffer).setUint16(20, 3, true);
    const noFmt = musicWav(pcm([1, 1])); noFmt[12] = 0;
    const source = await sourceFrom(new Map([["bad.wav", nonPcm], ["fmt.wav", noFmt]]));
    const trace: string[] = [], close = source.files.closeFile.bind(source.files);
    source.files.closeFile = file => { trace.push("close"); close(file); };
    const music = new BackgroundMusic(() => null, () => source.files, text => { trace.push(text); });
    music.start("bad");
    expect(source.reads).toEqual([12, 4, 4, 2, 2, 4, 4, 2, 2]);
    expect(trace).toEqual(["close", "Not a microsoft PCM format wav: bad.wav\n"]);
    trace.length = 0; music.start("fmt");
    expect(trace).toEqual(["No fmt chunk in fmt.wav\n", "close"]);
  });

  test("short data read stops only at update, before queueing any partial chunk", async () => {
    const bytes = musicWav(pcm([100, 100])); new DataView(bytes.buffer).setUint32(40, 12, true);
    const source = await sourceFrom(new Map([["short.wav", bytes]]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    mixer.queueRaw(pcm([123, 123]), 1);
    music.start("short"); expect(music.isPlaying).toBe(true); expect(mixer.rawEnd).toBe(1);
    music.update();
    expect(source.reads.at(-1)).toBe(12); expect(music.isPlaying).toBe(false);
    expect(source.printed).toEqual(["StreamedRead failure on music track\n"]);
    expect(source.closes).toHaveLength(1); expect(mixer.rawEnd).toBe(0);
  });

  test("header read errors leave the published file stoppable and print errors preserve source close order", async () => {
    const badFmt = musicWav(pcm([1, 1])); badFmt[12] = 0;
    const nonPcm = musicWav(pcm([1, 1])); new DataView(nonPcm.buffer).setUint16(20, 3, true);
    const source = await sourceFrom(new Map([["valid.wav", musicWav(pcm([1, 1]))], ["fmt.wav", badFmt], ["pcm.wav", nonPcm]]));
    const mixer = new AudioMixer(22050, () => 0);
    const failure = new Error("source abort");
    const music = new BackgroundMusic(() => mixer, () => source.files, () => { throw failure; });
    const read = source.files.readInto.bind(source.files);
    source.files.readInto = (file, bytes) => { if (bytes.byteLength === 2) throw failure; return read(file, bytes); };
    expect(() => music.start("valid")).toThrow(failure);
    expect(music.isPlaying).toBe(true); expect(source.closes).toHaveLength(0);
    music.stop(); expect(source.closes).toHaveLength(1);
    source.files.readInto = read;
    expect(() => music.start("fmt")).toThrow(failure);
    expect(music.isPlaying).toBe(true); expect(source.closes).toHaveLength(1);
    music.stop(); expect(source.closes).toHaveLength(2);
    mixer.queueRaw(pcm([123, 123]), 1);
    expect(() => music.start("pcm")).toThrow(failure);
    expect(music.isPlaying).toBe(false); expect(source.closes).toHaveLength(3);
    music.stop(); expect(mixer.rawEnd).toBe(1);
  });

  test("rejects truncated scalar, missing and zero data without a fill loop", async () => {
    const short = musicWav(pcm([1, 1])).slice(0, 21);
    const source = await sourceFrom(new Map([["short.wav", short], ["empty.wav", musicWav(pcm([]))]]));
    const music = source.music(() => null);
    music.start("short"); expect(source.printed).toContain("Truncated music header in short.wav\n");
    music.start("empty"); expect(source.printed).toContain("No data chunk in empty.wav\n");
    music.start("missing"); expect(music.isPlaying).toBe(false);
  });

  test("word-pads odd data and keeps source signed stereo versus unsigned mono 8-bit conversion", async () => {
    function wav8(channels: 1 | 2, bytes: readonly number[]): Uint8Array {
      const header = musicWav(pcm([], 22050, channels));
      const result = new Uint8Array(44 + bytes.length); result.set(header); result.set(bytes, 44);
      const view = new DataView(result.buffer); view.setUint16(34, 8, true); view.setUint32(40, bytes.length, true);
      return result;
    }
    const source = await sourceFrom(new Map([
      ["stereo.wav", wav8(2, [0, 128, 255, 127])], ["mono.wav", wav8(1, [0, 128])], ["odd.wav", wav8(1, [255])],
    ]));
    const mixer = new AudioMixer(22050, () => 0), music = source.music(() => mixer);
    music.start("stereo"); music.clearLoop(); music.update();
    expect(Array.from(mixer.mix(2))).toEqual([0, -8192, -64, 8128]);
    mixer.stopRaw(); music.start("mono"); music.clearLoop(); music.update();
    expect(Array.from(mixer.mix(2))).toEqual([-6144, -6144, 0, 0]);
    music.start("odd"); music.update();
    expect(source.reads.at(-1)).toBe(2); expect(music.isPlaying).toBe(false);
    expect(source.printed.at(-1)).toBe("StreamedRead failure on music track\n");
  });
});

describe("source update arithmetic and output ownership", () => {
  test("caps real source reads at 30000 bytes and crosses the boundary without a gap", async () => {
    const samples = Array.from({ length: 16000 }, (_, index) => Math.trunc(index / 2) * 4);
    const source = await sourceFrom(new Map([["long.wav", pcm(samples, 8000)]]));
    const mixer = new AudioMixer(8000, () => 0), music = source.music(() => mixer);
    music.start("long"); source.reads.length = 0; music.update();
    expect(source.reads[0]).toBe(30000); expect(source.reads[1]).toBe(2000);
    expect(Math.max(...source.reads)).toBe(30000);
    const output = mixer.mix(8002);
    expect(Array.from(output.slice(7499 * 2, 7502 * 2))).toEqual([7499, 7499, 7500, 7500, 7501, 7501]);
    expect(Array.from(output.slice(7999 * 2))).toEqual([7999, 7999, 0, 0, 1, 1]);
    music.stop();
  });

  test("persists float32 gain smoothing and does not refill for paint-ahead alone", async () => {
    const source = await sourceFrom(new Map([["tone.wav", pcm(new Array<number>(80000).fill(1000), 48000)]]));
    const mixer = new AudioMixer(48000, () => 0), music = source.music(() => mixer);
    music.setVolume(1); music.start("tone"); music.update();
    expect(music.effectiveVolume).toBe(0.625); expect(mixer.rawEnd).toBe(mixer.rawCapacity);
    mixer.mix({ startFrame: 100, endFrame: 1000 });
    const before = source.reads.length; music.update();
    expect(source.reads).toHaveLength(before); expect(mixer.rawEnd).toBe(mixer.rawCapacity);
    music.stop(); music.start("tone"); music.update();
    expect(music.effectiveVolume).toBe(0.6640625);
    mixer.selectTime(100, 200); music.update();
    expect(mixer.rawEnd).toBe(100 + mixer.rawCapacity); expect(mixer.sampleClock).toBe(200);
    music.stop();
  });

  test("the zero-file-frame accommodation submits the complete resampled frame through the ring", async () => {
    const source = await sourceFrom(new Map([["remainder.wav", pcm([1000, 1000, 2000, 2000])]]));
    const mixer = new AudioMixer(48000, () => 0), music = source.music(() => mixer);
    mixer.queueRaw(pcm(new Array<number>((mixer.rawCapacity - 1) * 2).fill(0), 48000), 1);
    music.start("remainder"); music.update(); expect(mixer.rawEnd).toBe(mixer.rawCapacity + 2);
    mixer.mix(mixer.rawCapacity - 1); expect(Array.from(mixer.mix(1))).toEqual([250, 250]);
    music.update();
    expect(mixer.rawEnd - mixer.soundClock).toBe(mixer.rawCapacity + 2);
    expect(Array.from(mixer.mix(3))).toEqual([375, 375, 375, 375, 375, 375]);
    music.stop();
  });

  test("disabled output retains header position and output replacement continues with the next file frame", async () => {
    const source = await sourceFrom(new Map([["track.wav", pcm([1000, 1000, 2000, 2000])]]));
    let current: AudioMixer | null = null;
    const music = source.music(() => current);
    music.start("track"); music.update(); expect(source.reads).toHaveLength(11);
    const old = new AudioMixer(48000, () => 0); current = old;
    old.setPlaybackEnabled(false); music.update(); expect(source.reads).toHaveLength(11);
    old.setPlaybackEnabled(true);
    old.queueRaw(pcm(new Array<number>((old.rawCapacity - 1) * 2).fill(0), 48000), 1);
    music.update(); expect(source.reads.at(-1)).toBe(4);
    const replacement = new AudioMixer(22050, () => 0); current = replacement;
    music.update(); expect(Array.from(replacement.mix(1))).toEqual([375, 375]);
    expect(old.rawEnd).toBe(old.rawCapacity + 2); music.stop();
  });
});
