// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { SdlAudioDevice } from "../src/platform/audio.ts";
import { runAudioSmoke } from "../tools/audio-smoke.ts";

if (process.env["QUAKE_AUDIO_TEST_CHILD"] !== "1") {
  test("SDL audio native suite in isolated dummy-driver process", async () => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SDL_AUDIODRIVER: "dummy", SDL_AUDIO_FREQUENCY: "48000", QUAKE_AUDIO_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`SDL audio child failed (${exitCode})\n${stdout}${stderr}`);
    expect(exitCode).toBe(0);
  }, 15000);
} else {
  if (process.env["SDL_AUDIODRIVER"] !== "dummy") throw new Error("SDL audio tests require the dummy driver");
  describe("SDL queued audio", () => {
    test("native paused queue, dummy playback drain and clear", async () => {
      expect(await runAudioSmoke()).toContain("2048 paused frames");
    });

    test("counts playing silence while pause and clear preserve fractional clock ownership", async () => {
      const device = SdlAudioDevice.open({ sampleRate: 48000, channels: 2, bufferFrames: 256 });
      try {
        expect(device.playbackFrames).toBe(0);
        await Bun.sleep(20);
        expect(device.playbackFrames).toBe(0);
        device.resume();
        const firstDeadline = performance.now() + 250;
        while (device.playbackFrames < 480 && performance.now() < firstDeadline) await Bun.sleep(5);
        device.pause();
        const first = device.playbackFrames;
        expect(first).toBeGreaterThanOrEqual(480);
        expect(device.queuedFrames).toBe(0);
        device.clear(); device.pause();
        await Bun.sleep(20);
        expect(device.playbackFrames).toBe(first);
        device.resume(); device.resume();
        const secondDeadline = performance.now() + 250;
        while (device.playbackFrames < first + 480 && performance.now() < secondDeadline) await Bun.sleep(5);
        device.pause();
        expect(device.playbackFrames).toBeGreaterThanOrEqual(first + 480);
      } finally { device.close(); }
    });

    test("negotiates mono/stereo and respects sample-array views", () => {
      const mono = SdlAudioDevice.open({ sampleRate: 48000, channels: 1, bufferFrames: 512 });
      try {
        expect(mono.sampleRate).toBe(48000);
        expect(mono.channels).toBe(1);
        expect(mono.bufferFrames).toBeGreaterThan(0);
        mono.queue(new Int16Array(9).subarray(2, 7));
        expect(mono.queuedFrames).toBe(5);
        mono.queue(new Int16Array(0));
        expect(mono.queuedFrames).toBe(5);
        mono.clear();
        expect(mono.queuedFrames).toBe(0);
      } finally { mono.close(); }
    });

    test("accepts exact 22050 Hz queues or cleans up rejected native accounting", () => {
      let device: SdlAudioDevice | undefined;
      try {
        try { device = SdlAudioDevice.open({ sampleRate: 22050, channels: 1 }); }
        catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (!(error instanceof Error)) throw error;
          expect(error.message).toContain("exact queued input frames");
        }
        if (device !== undefined) {
          device.queue(new Int16Array(5));
          expect(device.queuedFrames).toBe(5);
        }
      } finally { device?.close(); }
      const replacement = SdlAudioDevice.open({ sampleRate: 48000, channels: 2 });
      try { replacement.queue(new Int16Array(4)); expect(replacement.queuedFrames).toBe(2); }
      finally { replacement.close(); }
    });

    test("rejects partial frames and bounds queue memory", () => {
      const device = SdlAudioDevice.open({ sampleRate: 48000, channels: 2 });
      try {
        expect(() => device.queue(new Int16Array(3))).toThrow("channel aligned");
        expect(device.queuedFrames).toBe(0);
        device.queue(new Int16Array(device.maxQueuedFrames * 2));
        expect(device.queuedFrames).toBe(96000);
        expect(() => device.queue(new Int16Array(2))).toThrow("two-second limit");
        expect(device.queuedFrames).toBe(96000);
        device.clear();
        device.queue(new Int16Array(2));
        expect(device.queuedFrames).toBe(1);
      } finally { device.close(); }
    });

    test("validates requested format before opening a native device", () => {
      for (const sampleRate of [0, -1, 7999, 192001, 48000.5, NaN, Infinity]) {
        expect(() => SdlAudioDevice.open({ sampleRate, channels: 2 })).toThrow("sample rate");
      }
      for (const bufferFrames of [0, -1, 63, 1000, 65536, 1024.5, NaN]) {
        expect(() => SdlAudioDevice.open({ sampleRate: 48000, channels: 2, bufferFrames })).toThrow("buffer frames");
      }
    });

    test("keeps other devices usable after native open failure and repeated closure", () => {
      const devices: SdlAudioDevice[] = [];
      let failure: unknown;
      try {
        // SDL2's dummy driver and sdl2-compat have finite device slots.
        for (let index = 0; index < 64; index++) {
          try { devices.push(SdlAudioDevice.open({ sampleRate: 48000, channels: 2 })); }
          catch (error) { failure = error; break; }
        }
        expect(failure).toBeInstanceOf(Error);
        const first = devices[0];
        if (first === undefined) throw new Error("No dummy audio device opened");
        first.queue(new Int16Array(8));
        expect(first.queuedFrames).toBe(4);
        const last = devices.pop();
        if (last === undefined) throw new Error("No audio device available for closure");
        last.close(); last.close();
        const replacement = SdlAudioDevice.open({ sampleRate: 48000, channels: 1 });
        try { replacement.queue(new Int16Array(3)); expect(replacement.queuedFrames).toBe(3); }
        finally { replacement.close(); }
      } finally { for (const device of devices) { device.close(); device.close(); } }
      const reopened = SdlAudioDevice.open({ sampleRate: 48000, channels: 2 });
      reopened.close();
    });

    test("rejects native operations after idempotent close", () => {
      const device = SdlAudioDevice.open({ sampleRate: 48000, channels: 2 });
      device.close(); device.close();
      expect(() => device.queue(new Int16Array(2))).toThrow("closed");
      expect(() => device.queuedFrames).toThrow("closed");
      expect(() => device.playbackFrames).toThrow("closed");
      expect(() => device.clear()).toThrow("closed");
      expect(() => device.pause()).toThrow("closed");
      expect(() => device.resume()).toThrow("closed");
    });
  });
}
