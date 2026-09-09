// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, expect, test } from "bun:test";
import { musicFiles } from "./music-file-fixture.ts";
import { fileURLToPath } from "node:url";
import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BackgroundMusic } from "../src/audio/music.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import { SoundFrame } from "../src/engine/sound-frame.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";

function frameCvars(): CvarRegistry {
  const cvars = new CvarRegistry();
  for (const [name, value] of [["s_volume", "0.8"], ["s_musicvolume", "0.25"], ["s_mixahead", "0.2"], ["s_mixPreStep", "0.05"]] satisfies readonly (readonly [string, string])[]) {
    cvars.register(name, value, CvarFlag.Archive);
  }
  return cvars;
}

function mono(frames: number, value: number): PcmSound {
  return { sampleRate: 48000, channels: 1, frameCount: frames, samples: new Int16Array(frames).fill(value), loopStart: null };
}

if (process.env["QUAKE_SOUND_FRAME_TEST_CHILD"] !== "1") {
  test("sound frame scheduling in an isolated real SDL dummy process", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SDL_AUDIODRIVER: "dummy", SDL_AUDIO_FREQUENCY: "48000", QUAKE_SOUND_FRAME_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Sound frame child failed (${exitCode})\n${stdout}${stderr}`);
    expect(exitCode).toBe(0);
  }, 15000);
} else {
  if (process.env["SDL_AUDIODRIVER"] !== "dummy") throw new Error("Sound frame tests require the dummy driver");
  const musicFixture = await musicFiles(new Map([["music/test.wav", mono(20000, 1000)]]));
  afterAll(() => musicFixture.close());

  test("repaints actual native output while preserving both untouched sides", () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      mixer.queueRaw(mono(4800, 1000), 1);
      output.submit(4800);
      mixer.clearSoundBuffer();
      mixer.queueRaw(mono(4800, 2000), 1);
      output.repaint({ startFrame: 1000, endFrame: 2000 });
      const pending = output.pendingOutput;
      expect(pending.startFrame).toBe(0);
      expect(output.queuedFrames).toBe(4800);
      expect(output.paused).toBe(true);
      expect(pending.samples.slice(0, 2000)).toEqual(new Int16Array(2000).fill(1000));
      expect(pending.samples.slice(2000, 4000)).toEqual(new Int16Array(2000).fill(2000));
      expect(pending.samples.slice(4000)).toEqual(new Int16Array(5600).fill(1000));
      pending.samples.fill(9);
      expect(output.pendingOutput.samples[0]).toBe(1000);
      expect(mixer.soundClock).toBe(0);
    } finally { output.close(); }
  });

  test("does not replay delivered prefix and restores resumed state across repaint", async () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      mixer.queueRaw(mono(9600, 1000), 1);
      output.submit(9600);
      output.resume();
      await Bun.sleep(25);
      output.pause();
      const before = output.pendingOutput;
      expect(before.startFrame).toBeGreaterThan(0);
      expect(before.startFrame).toBeLessThan(9600);
      mixer.clearSoundBuffer();
      mixer.queueRaw(mono(9600, 2000), 1);
      output.repaint({ startFrame: 0, endFrame: before.startFrame + 1000 });
      expect(output.deliveryTime).toBe(before.startFrame);
      expect(output.queuedFrames).toBe(9600 - before.startFrame);
      expect(output.pendingOutput.samples.slice(0, 2000)).toEqual(new Int16Array(2000).fill(2000));
      expect(output.pendingOutput.samples.slice(2000)).toEqual(new Int16Array((8600 - before.startFrame) * 2).fill(1000));
      output.resume();
      output.repaint({ startFrame: 0, endFrame: 9600 });
      expect(output.paused).toBe(false);
      output.pause();
      expect(output.deliveryTime).toBeGreaterThanOrEqual(before.startFrame);
      expect(output.deliveryTime + output.queuedFrames).toBe(9600);
      const retained = output.pendingOutput;
      await Bun.sleep(15);
      expect(output.deliveryTime).toBe(retained.startFrame);
      expect(output.queuedFrames).toBe(retained.samples.length / 2);
    } finally { output.close(); }
  });

  test("uses source prestep, float32 lookahead and unchanged-position no-scan", () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { return { kind: "none", time: 0 }; } }, () => undefined);
      const cvars = frameCvars();
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      expect(cvars.get("s_mixahead")?.flags).toBe(CvarFlag.Archive);
      frame.update();
      expect(mixer.soundClock).toBe(0);
      expect(mixer.sampleClock).toBe(5280);
      expect(output.queuedFrames).toBe(5280);
      mixer.startLocalSound(mono(200, 32767), 1);
      frame.update();
      expect(mixer.sampleClock).toBe(2400);
      expect(output.queuedFrames).toBe(5280);
      expect(output.pendingOutput.samples).toEqual(new Int16Array(10560));
      // No scan on the unchanged update: the pending channel starts at this later range.
      expect(mixer.mix({ startFrame: 4000, endFrame: 4001 })[0]).toBeGreaterThan(0);
      expect(mixer.mix({ startFrame: 3000, endFrame: 3001 })[0]).toBe(0);
    } finally { output.close(); }
  });

  test("starts newly requested voices before the previously painted tail using real device progress", async () => {
    const output = new SoundOutput();
    try {
      let clock = 100;
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => clock);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { return { kind: "none", time: clock }; } }, () => undefined);
      const frame = new SoundFrame(output, music, events, frameCvars(), () => { music.stop(); output.clearSoundBuffer(); });
      frame.update();
      expect(mixer.sampleClock).toBe(9600);
      output.resume();
      const deliveryDeadline = performance.now() + 2000;
      while (output.deliveryTime === 0 && performance.now() < deliveryDeadline) await Bun.sleep(5);
      output.pause();
      const delivered = output.deliveryTime;
      expect(delivered).toBeGreaterThan(0);
      clock = 120;
      mixer.startLocalSound(mono(10000, 32767), 1);
      frame.update();
      expect(mixer.soundClock).toBe(delivered);
      const onset = delivered + 2400;
      expect(onset).toBeLessThan(9600);
      const pending = output.pendingOutput;
      expect(pending.samples.slice(0, 4800)).toEqual(new Int16Array(4800));
      expect(pending.samples[4800]).toBeGreaterThan(0);
      expect(output.paused).toBe(true);
      expect(output.queuedFrames).toBe(mixer.sampleClock - delivered);
    } finally { output.close(); }
  });

  test("fills music before the clock callback and against previous delivery time", async () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 100);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      await music.start("music/test");
      const observed: number[] = [];
      const events = new CommonEvents({ getEvent() { observed.push(mixer.rawEnd); return { kind: "none", time: 100 }; } }, () => undefined);
      const frame = new SoundFrame(output, music, events, frameCvars(), () => { music.stop(); output.clearSoundBuffer(); });
      frame.update();
      output.resume();
      await Bun.sleep(20);
      output.pause();
      const delivered = output.deliveryTime;
      frame.update();
      expect(observed).toEqual([mixer.rawCapacity, mixer.rawCapacity]);
      expect(mixer.soundClock).toBe(delivered);
      frame.update();
      expect(mixer.rawEnd).toBe(delivered + mixer.rawCapacity);
      expect(music.isPlaying).toBe(true);
      output.clearSoundBuffer();
      const unchanged = output.deliveryTime;
      frame.update();
      expect(output.queuedFrames).toBe(0);
      output.resume();
      const refillDeadline = performance.now() + 250;
      while (output.deliveryTime === unchanged && performance.now() < refillDeadline) await Bun.sleep(5);
      frame.update();
      expect(output.queuedFrames).toBeGreaterThan(0);
      output.pause();
      expect(output.deliveryTime).toBeGreaterThanOrEqual(unchanged);
      expect(music.isPlaying).toBe(true);
    } finally { output.close(); }
  });

  test("retains lastTime across unchanged positions and caps a later long frame to queue capacity", async () => {
    const output = new SoundOutput();
    try {
      let clock = 0;
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => clock);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { return { kind: "none", time: clock }; } }, () => undefined);
      const cvars = frameCvars();
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      cvars.set("s_mixahead", "10");
      frame.update();
      expect(output.queuedFrames).toBe(5280);
      clock = 1000;
      frame.update();
      output.resume();
      const deliveryDeadline = performance.now() + 2000;
      while (output.deliveryTime === 0 && performance.now() < deliveryDeadline) await Bun.sleep(5);
      output.pause();
      expect(output.deliveryTime).toBeGreaterThan(0);
      clock = 1011;
      frame.update();
      expect(output.queuedFrames).toBe(output.maxQueuedFrames);
      expect(mixer.sampleClock).toBe(mixer.soundClock + output.maxQueuedFrames);
    } finally { output.close(); }
  });

  test("recovers a real empty resumed queue after a nonpainting cvar configuration is corrected", async () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { return { kind: "none", time: 100 }; } }, () => undefined);
      const cvars = frameCvars();
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      cvars.set("s_mixahead", "0");
      frame.update();
      expect(output.queuedFrames).toBe(0);
      expect(output.deliveryTime).toBe(0);
      expect(mixer.sampleClock).toBe(2400);
      frame.update();
      expect(output.deliveryTime).toBe(0);
      cvars.set("s_mixahead", "0.2");
      frame.update();
      expect(output.queuedFrames).toBe(0);
      output.resume();
      const progressDeadline = performance.now() + 250;
      while (output.deliveryTime === 0 && performance.now() < progressDeadline) await Bun.sleep(5);
      frame.update();
      expect(output.queuedFrames).toBeGreaterThan(0);
      expect(output.paused).toBe(false);
      output.pause();
      expect(mixer.sampleClock).toBe(mixer.soundClock + 5280);
    } finally { output.close(); }
  });

  test("keeps source negative music/effects volumes and tiny-negative unsigned end conversion", async () => {
    const output = new SoundOutput();
    try {
      let clockReads = 0;
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      await music.start("music/test");
      const events = new CommonEvents({ getEvent() { clockReads++; return { kind: "none", time: 100 }; } }, () => undefined);
      const cvars = frameCvars();
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      cvars.set("s_musicvolume", "-1");
      cvars.set("s_volume", "-1");
      cvars.set("s_mixahead", "-0.0000001");
      mixer.startLocalSound(mono(10000, 256), 1);
      frame.update();
      expect(clockReads).toBe(1);
      expect(music.effectiveVolume).toBe(-0.375);
      expect(music.isPlaying).toBe(true);
      expect(mixer.rawEnd).toBe(0);
      expect(output.queuedFrames).toBe(0);
      expect(mixer.sampleClock).toBe(2400);
      cvars.set("s_mixahead", "0.2");
      output.resume();
      const progressDeadline = performance.now() + 250;
      while (output.deliveryTime === 0 && performance.now() < progressDeadline) await Bun.sleep(5);
      output.pause();
      frame.update();
      expect(clockReads).toBe(2);
      const pending = output.pendingOutput;
      expect(pending.samples[2400 * 2]).toBe(-127);
      expect(mixer.rawEnd).toBe(0);
      const nextDelivery = output.deliveryTime + 48;
      output.resume();
      const deliveryDeadline = performance.now() + 2000;
      while (output.deliveryTime <= nextDelivery && performance.now() < deliveryDeadline) await Bun.sleep(5);
      output.pause();
      expect(output.deliveryTime).toBeGreaterThan(nextDelivery);
      cvars.set("s_mixahead", "-0.001");
      cvars.set("s_mixPreStep", "-0.001");
      frame.update();
      // endtime precedes soundtime, so source unsigned subtraction selects the full bound.
      expect(output.queuedFrames).toBe(output.maxQueuedFrames);
      expect(mixer.sampleClock).toBe(mixer.soundClock + output.maxQueuedFrames);
    } finally { output.close(); }
  });

  test("negative initial prestep paints one-shots at source time and queues only the undelivered range", () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { return { kind: "none", time: 100 }; } }, () => undefined);
      const cvars = frameCvars();
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      cvars.set("s_mixPreStep", "-0.00005");
      cvars.set("s_volume", "1");
      mixer.startLocalSound({ sampleRate: 48000, channels: 1, frameCount: 4, samples: new Int16Array([256, 512, 768, 1024]), loopStart: null }, 1);
      frame.update();
      expect(mixer.soundClock).toBe(0);
      expect(mixer.sampleClock).toBe(9600);
      expect(output.queuedFrames).toBe(9600);
      expect(output.pendingOutput.startFrame).toBe(0);
      expect(Array.from(output.pendingOutput.samples.slice(0, 6))).toEqual([379, 379, 506, 506, 0, 0]);
      expect(output.paused).toBe(true);
    } finally { output.close(); }
  });

  test("starvation retires old voices and raw PCM while real loops resume at the elapsed source phase", async () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000, bufferFrames: 256 }, () => 0);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { return { kind: "none", time: 100 }; } }, () => undefined);
      const cvars = frameCvars(); cvars.set("s_volume", "1");
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      const cycle: PcmSound = { sampleRate: 48000, channels: 1, loopStart: null, frameCount: 7,
        samples: new Int16Array([256, 512, 768, 1024, 1280, 1536, 1792]) };
      const origin = { x: 0, y: 0, z: 0 };
      mixer.updateRealLoopingSound(cycle, { entity: 1, origin, velocity: origin });
      mixer.setListener(0, origin, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
      mixer.startLocalSound(mono(100, 5000), 1);
      mixer.queueRaw(mono(mixer.rawCapacity, 9000), 1);
      frame.update();
      output.resume();
      const target = mixer.rawCapacity + 4800, deadline = performance.now() + 1500;
      while (output.deliveryTime < target && performance.now() < deadline) await Bun.sleep(5);
      output.pause();
      const elapsed = output.deliveryTime;
      expect(elapsed).toBeGreaterThanOrEqual(target);
      expect(output.queuedFrames).toBe(0);
      mixer.clearLoopingSounds(false);
      mixer.setListener(0, origin, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
      frame.update();
      expect(mixer.soundClock).toBe(elapsed);
      expect(mixer.rawEnd).toBe(mixer.rawCapacity);
      expect(Array.from(mixer.channelVolumes())).toEqual([]);
      const pending = output.pendingOutput;
      expect(pending.startFrame).toBe(elapsed);
      expect(pending.samples.slice(0, 4800)).toEqual(new Int16Array(4800));
      // Centered real-loop volume 90 splits to 45 per side, with effects gain 255.
      const levels = [44, 89, 134, 179, 224, 268, 313];
      const expected: number[] = [];
      for (let index = 0; index < 7; index++) {
        const sample = levels[(elapsed + 2400 + index) % 7];
        if (sample === undefined) throw new Error("Missing source loop sample");
        expected.push(sample, sample);
      }
      expect(pending.samples.slice(4800, 4814)).toEqual(new Int16Array(expected));
      mixer.queueRaw(mono(3, 3000), 1);
      expect(mixer.rawEnd).toBe(elapsed + 3);
      output.repaint({ startFrame: elapsed, endFrame: elapsed + 3 });
      const rawExpected: number[] = [];
      for (let index = 0; index < 3; index++) {
        const sample = levels[(elapsed + index) % 7];
        if (sample === undefined) throw new Error("Missing source raw/loop sample");
        rawExpected.push(3000 + sample, 3000 + sample);
      }
      expect(output.pendingOutput.samples.slice(0, 6)).toEqual(new Int16Array(rawExpected));
    } finally { output.close(); }
  });

  test("rechecks output ownership after the real common event callback", () => {
    const output = new SoundOutput();
    try {
      const mixer = output.start({ sampleRate: 48000 }, () => 0);
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const events = new CommonEvents({ getEvent() { output.shutdown(); return { kind: "none", time: 0 }; } }, () => undefined);
      const frame = new SoundFrame(output, music, events, frameCvars(), () => { music.stop(); output.clearSoundBuffer(); });
      expect(() => frame.update()).toThrow("lifetime has ended");
      expect(mixer.sampleClock).toBe(0);
    } finally { output.close(); }
  });

  test("rejects foreign/stale owners and invalid timing cvars without manufacturing readiness", () => {
    const output = new SoundOutput();
    const cvars = frameCvars();
    const events = new CommonEvents({ getEvent() { return { kind: "none", time: 100 }; } }, () => undefined);
    const foreignMixer = new AudioMixer(48000, () => 0);
    const foreign = new BackgroundMusic(() => foreignMixer, () => musicFixture.files, () => {});
    expect(() => new SoundFrame(output, foreign, events, cvars, () => { foreign.stop(); output.clearSoundBuffer(); })).toThrow("started output");
    try {
      const mixer = output.start({ sampleRate: 48000 }, () => 0);
      expect(() => new SoundFrame(output, foreign, events, cvars, () => { foreign.stop(); output.clearSoundBuffer(); })).toThrow("different mixer");
      const music = new BackgroundMusic(() => mixer, () => musicFixture.files, () => {});
      const frame = new SoundFrame(output, music, events, cvars, () => { music.stop(); output.clearSoundBuffer(); });
      cvars.set("s_mixPreStep", "1e30");
      expect(() => frame.update()).toThrow("undefined signed-int conversion");
      expect(output.queuedFrames).toBe(0);
      cvars.set("s_mixPreStep", "30000");
      frame.update();
      expect(mixer.sampleClock).toBe(1440000000);
      expect(mixer.soundClock).toBe(0);
      expect(output.queuedFrames).toBe(0);
      // With no delivery progress, the source leaves this valid paint time selected.
      frame.update();
      expect(mixer.sampleClock).toBe(1440000000);
      expect(output.deliveryTime).toBe(0);
      expect(output.queuedFrames).toBe(0);
      output.shutdown();
      output.start({ sampleRate: 48000 }, () => 0);
      expect(() => frame.update()).toThrow("lifetime has ended");
    } finally { output.close(); }
  });
}
