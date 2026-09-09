import { HunkArena } from "../src/core/hunk.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { PcmSound } from "../src/assets/wav.ts";
import { BackgroundMusic } from "../src/audio/music.ts";
import { musicFiles } from "./music-file-fixture.ts";
import { vec3 } from "../src/core/math.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CinematicStatus, EngineCinematics } from "../src/engine/cinematics.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";

function mono(samples: readonly number[]): PcmSound {
  return { sampleRate: 48000, channels: 1, samples: new Int16Array(samples), frameCount: samples.length, loopStart: null };
}

function cinematicMovie(): Uint8Array {
  const out = new BinaryWriter(8 + 5 * 8 + 30000 + 8 + 10 + 6);
  const chunk = (id: number, payload: readonly number[], flags = 0): void => {
    out.u16(id); out.u32(payload.length); out.u16(flags); out.bytes(Uint8Array.from(payload));
  };
  out.u16(0x1084); out.u32(0xffffffff); out.u16(30);
  chunk(0x1020, new Array<number>(30000).fill(1), 1000);
  chunk(0x1001, [16, 0, 16, 0, 8, 0, 4, 0]);
  chunk(0x1002, [255, 255, 255, 255, 128, 128, 0, 0, 0, 0], 0x0101);
  chunk(0x1011, [0, 170, 0, 0, 0, 0]);
  chunk(0x1013, []);
  return out.finish();
}

if (process.env["QUAKE_SOUND_OUTPUT_TEST_CHILD"] !== "1") {
  test("sound output owner in an isolated real SDL dummy process", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SDL_AUDIODRIVER: "dummy", SDL_AUDIO_FREQUENCY: "48000", QUAKE_SOUND_OUTPUT_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Sound output child failed (${exitCode})\n${stdout}${stderr}`);
    expect(exitCode).toBe(0);
  }, 15000);
} else {
  if (process.env["SDL_AUDIODRIVER"] !== "dummy") throw new Error("Sound output tests require the dummy driver");

  describe("sound output ownership and S_ClearSoundBuffer", () => {
    test("cinematics borrows the live output across inert startup, mute and restart", async () => {
      const output = new SoundOutput(), bytes = cinematicMovie();
      const clock = { time: 0, sample(): number { return this.time; } };
      const movies = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined,
        files: { kind: "diagnostic-bytes", reader: { has: () => true, list: () => [], read: async () => bytes } }, sound: { kind: "diagnostic", readMixer: () => output.mixer }, clock,
        scratchImages: new BuiltinImages(new RendererImageCatalog(), identityImageUploadProfile), console: { kind: "absent" },
        settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 },
      });
      const play = async (name: string) => {
        const handle = movies.playNonSystem(await movies.prepare(name), { x: 0, y: 0, width: 640, height: 480 },
          { looping: false, holdAtEnd: false, silent: false, shader: false });
        if (handle === undefined) throw new Error("Cinematic fixture did not open");
        movies.run(handle);
        return handle;
      };
      try {
        expect(output.mixer).toBeNull();
        const inert = await play("inert");
        clock.time = 34; expect(movies.run(inert)).toBe(CinematicStatus.Playing);
        expect(movies.prepareUiRaw(inert)?.captureAfterBarrier().upload.content.copyPixels()[0]).toBe(255);
        const first = output.start({ sampleRate: 48000 }, () => clock.time);
        first.selectTime(7, 100);
        const active = await play("active");
        expect(first.rawEnd).toBe(7 + first.rawCapacity);
        expect(Array.from(first.mix({ startFrame: 7, endFrame: 10 }))).toEqual([1001, 1001, 1001, 1001, 1001, 1001]);
        output.shutdown();
        expect(output.mixer).toBeNull();
        movies.run(active); clock.time += 34; movies.run(active);
        expect(movies.prepareUiRaw(active)).not.toBeNull();
        expect(first.rawEnd).toBe(7 + first.rawCapacity);
        const second = output.start({ sampleRate: 48000 }, () => clock.time);
        expect(second).not.toBe(first);
        const restarted = await play("restarted");
        expect(second.rawEnd).toBe(second.rawCapacity);
        expect(Array.from(second.mix({ startFrame: 0, endFrame: 3 }))).toEqual([1001, 1001, 1001, 1001, 1001, 1001]);
        second.setPlaybackEnabled(false);
        movies.run(restarted); clock.time += 34; movies.run(restarted);
        expect(movies.prepareUiRaw(restarted)).not.toBeNull();
        expect(second.rawEnd).toBe(second.rawCapacity);
        second.setPlaybackEnabled(true);
        const interrupted = await play("interrupted");
        output.shutdown();
        const third = output.start({ sampleRate: 48000 }, () => clock.time);
        movies.run(interrupted); clock.time += 34; movies.run(interrupted);
        expect(movies.prepareUiRaw(interrupted)).not.toBeNull();
        expect(third.rawEnd).toBe(0);
        expect(second.rawEnd).toBe(second.rawCapacity);
        await play("after-replacement");
        expect(third.rawEnd).toBe(third.rawCapacity);
      } finally { movies.dispose(); output.close(); }
    });

    test("exists inert before startup and keeps clear/shutdown harmless after disposal", () => {
      const output = new SoundOutput();
      expect(output.mixer).toBeNull();
      output.clearSoundBuffer();
      output.shutdown();
      expect(output.mixer).toBeNull();
      expect(() => output.submit(0)).toThrow("not started");
      expect(() => output.queuedFrames).toThrow("not started");
      expect(() => output.pause()).toThrow("not started");
      expect(() => output.resume()).toThrow("not started");
      output.close();
      output.close();
      output.clearSoundBuffer();
      output.shutdown();
      expect(() => output.start({ sampleRate: 48000 }, () => 0)).toThrow("closed");
    });

    test("clears actual queued output, both loop lifetimes, one-shots and raw end without resetting painted time", () => {
      const output = new SoundOutput();
      try {
        const mixer = output.start({ sampleRate: 48000 }, () => 0);
        expect(output.mixer).toBe(mixer);
        expect(mixer.outputRate).toBe(48000);
        mixer.setEffectsVolume(1);
        mixer.startLocalSound(mono([256, 512, 768, 1024]), 1);
        mixer.updateLoopingSound(mono([256]), { entity: 1, origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0), frameNumber: 1 });
        mixer.updateRealLoopingSound(mono([512]), { entity: 2, origin: vec3(0, 0, 0), velocity: vec3(0, 0, 0) });
        mixer.queueRaw(mono([1000, 2000, 3000, 4000]), 1);
        output.submit(2);
        expect(output.queuedFrames).toBe(2);
        expect(mixer.sampleClock).toBe(2);
        expect(mixer.rawEnd).toBe(4);

        output.clearSoundBuffer();
        expect(output.mixer).toBe(mixer);
        expect(output.queuedFrames).toBe(0);
        expect(mixer.rawEnd).toBe(0);
        expect(mixer.sampleClock).toBe(2);
        output.submit(2);
        expect(Array.from(output.pendingOutput.samples)).toEqual([0, 0, 0, 0]);
        expect(mixer.rawEnd).toBe(0);
        mixer.queueRaw(mono([1234]), 1);
        expect(mixer.rawEnd).toBe(1);
        output.repaint({ startFrame: 0, endFrame: 1 });
        expect(Array.from(output.pendingOutput.samples)).toEqual([1234, 1234, 0, 0]);
        output.submit(3);
        expect(output.queuedFrames).toBe(5);
        output.clearSoundBuffer();
        expect(output.queuedFrames).toBe(0);
        expect(mixer.sampleClock).toBe(5);
        expect(mixer.rawEnd).toBe(0);
      } finally { output.close(); }
    });

    test("retains the playing background track so its next update refills the same raw stream", async () => {
      const output = new SoundOutput();
      const fixture = await musicFiles(new Map([["music/test.wav", mono(Array.from({ length: 40000 }, (_, index) => index % 2 === 0 ? 1024 : 2048))]]));
      try {
        const mixer = output.start({ sampleRate: 48000 }, () => 0);
        const reads: string[] = [];
        const open = fixture.files.openUniqueRead.bind(fixture.files);
        fixture.files.openUniqueRead = (path, selected) => { reads.push(path); return open(path, selected); };
        const music = new BackgroundMusic(() => mixer, () => fixture.files, () => {});
        await music.start("music/test");
        music.update();
        output.submit(4);
        expect(output.queuedFrames).toBe(4);
        output.clearSoundBuffer();
        expect(music.isPlaying).toBe(true);
        expect(mixer.sampleClock).toBe(4);
        expect(mixer.rawEnd).toBe(0);
        expect(output.queuedFrames).toBe(0);
        music.update();
        expect(mixer.rawEnd).toBe(mixer.rawCapacity);
        expect(Array.from(mixer.mix(2))).toEqual([192, 192, 384, 384]);
        expect(reads).toEqual(["music/test.wav"]);
        expect(music.isPlaying).toBe(true);
      } finally { try { output.close(); } finally { await fixture.close(); } }
    });

    test("validates queue bounds before consuming samples and recovers after clear", () => {
      const output = new SoundOutput();
      try {
        const mixer = output.start({ sampleRate: 48000 }, () => 0);
        for (const frames of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() => output.submit(frames)).toThrow("mix frame count");
          expect(mixer.sampleClock).toBe(0);
        }
        output.submit(96000);
        mixer.queueRaw(mono([4096]), 1);
        expect(() => output.submit(1)).toThrow("two-second limit");
        expect(output.queuedFrames).toBe(96000);
        expect(mixer.sampleClock).toBe(96000);
        expect(mixer.rawEnd).toBe(1);
        expect(Array.from(mixer.mix({ startFrame: 0, endFrame: 1 }))).toEqual([4096, 4096]);
        output.clearSoundBuffer();
        output.submit(1);
        expect(output.queuedFrames).toBe(1);
      } finally { output.close(); }
    });

    test("advances empty playback without replaying elapsed PCM and freezes across pause and clear", async () => {
      const output = new SoundOutput();
      try {
        const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
        mixer.queueRaw(mono(new Array<number>(480).fill(1000)), 1);
        output.submit(480);
        output.resume();
        const drainDeadline = performance.now() + 2000;
        while (output.queuedFrames !== 0 && performance.now() < drainDeadline) await Bun.sleep(5);
        expect(output.queuedFrames).toBe(0);
        const drained = output.deliveryTime;
        const silenceDeadline = performance.now() + 250;
        while (output.deliveryTime < drained + 480 && performance.now() < silenceDeadline) await Bun.sleep(5);
        output.pause();
        const elapsed = output.deliveryTime;
        expect(elapsed).toBeGreaterThanOrEqual(drained + 480);
        expect(mixer.sampleClock).toBe(480);
        await Bun.sleep(20);
        output.pause();
        expect(output.deliveryTime).toBe(elapsed);
        output.clearSoundBuffer();
        expect(output.deliveryTime).toBe(elapsed);
        expect(mixer.sampleClock).toBe(480);
        output.repaint({ startFrame: 0, endFrame: elapsed + 4 });
        expect(output.queuedFrames).toBe(4);
        expect(output.pendingOutput).toEqual({ startFrame: elapsed, samples: new Int16Array(8) });
        output.shutdown();
        output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
        expect(output.deliveryTime).toBe(0);
        expect(output.queuedFrames).toBe(0);
      } finally { output.close(); }
    });

    test("starts silence at the empty native queue head when delivery leads nominal playing time", async () => {
      const output = new SoundOutput();
      try {
        output.start({ sampleRate: 48000, bufferFrames: 32768 }, () => 0);
        output.submit(32768);
        output.resume();
        const drainDeadline = performance.now() + 2500;
        while (output.queuedFrames !== 0 && performance.now() < drainDeadline) await Bun.sleep(2);
        expect(output.queuedFrames).toBe(0);
        const next = output.deliveryTime + 480;
        const silenceDeadline = performance.now() + 100;
        while (output.deliveryTime < next && performance.now() < silenceDeadline) await Bun.sleep(2);
        output.pause();
        expect(output.deliveryTime).toBeGreaterThanOrEqual(next);
      } finally { output.close(); }
    });

    test("keeps repeated starts stable and gives restarts a fresh pair and sample clock", () => {
      const output = new SoundOutput();
      try {
        expect(() => output.start({ sampleRate: 0 }, () => 0)).toThrow("sample rate");
        expect(output.mixer).toBeNull();
        const first = output.start({ sampleRate: 48000 }, () => 0);
        output.submit(3);
        expect(output.start({ sampleRate: 0 }, () => 0)).toBe(first);
        expect(first.sampleClock).toBe(3);
        expect(output.queuedFrames).toBe(3);
        output.resume();
        output.pause();
        output.shutdown();
        output.shutdown();
        output.clearSoundBuffer();
        expect(output.mixer).toBeNull();
        expect(first.sampleClock).toBe(3);
        const second = output.start({ sampleRate: 48000 }, () => 0);
        expect(second).not.toBe(first);
        expect(second.sampleClock).toBe(0);
        expect(second.rawEnd).toBe(0);
        expect(output.queuedFrames).toBe(0);
        output.submit(2);
        expect(output.queuedFrames).toBe(2);
      } finally { output.close(); }
      expect(output.mixer).toBeNull();
      expect(() => output.start({ sampleRate: 48000 }, () => 0)).toThrow("closed");
    });

    test("retains a retryable inert owner after actual SDL device exhaustion", () => {
      const outputs: SoundOutput[] = [];
      let failed: SoundOutput | null = null;
      try {
        for (let index = 0; index < 64; index++) {
          const output = new SoundOutput();
          outputs.push(output);
          try { output.start({ sampleRate: 48000 }, () => 0); }
          catch (error) {
            if (!(error instanceof Error)) throw error;
            expect(error.message).toContain("SDL_OpenAudioDevice");
            failed = output;
            break;
          }
        }
        if (failed === null) throw new Error("Dummy driver did not reach its device limit");
        expect(failed.mixer).toBeNull();
        failed.clearSoundBuffer();
        failed.shutdown();
        const first = outputs[0];
        if (first === undefined || first === failed) throw new Error("No output opened before exhaustion");
        first.submit(4);
        expect(first.queuedFrames).toBe(4);
        first.close();
        first.close();
        const recovered = failed.start({ sampleRate: 48000 }, () => 0);
        expect(failed.mixer).toBe(recovered);
        failed.submit(3);
        expect(failed.queuedFrames).toBe(3);
      } finally { for (const output of outputs) output.close(); }
      const replacement = new SoundOutput();
      try { replacement.start({ sampleRate: 48000 }, () => 0); replacement.submit(1); expect(replacement.queuedFrames).toBe(1); }
      finally { replacement.close(); }
    });
  });
}
