// SPDX-License-Identifier: GPL-2.0-or-later
import { SdlAudioDevice } from "../src/platform/audio.ts";

function requireQueuedFrames(device: SdlAudioDevice, expected: number): void {
  const actual = device.queuedFrames;
  if (actual !== expected) throw new Error(`SDL audio queue has ${actual} frames; expected ${expected}`);
}

export async function runAudioSmoke(): Promise<string> {
  if (process.env["SDL_AUDIODRIVER"] !== "dummy") throw new Error("Audio verification requires SDL_AUDIODRIVER=dummy");
  const device = SdlAudioDevice.open({ sampleRate: 48000, channels: 2 });
  try {
    if (device.sampleRate !== 48000 || device.channels !== 2 || device.bufferFrames <= 0) throw new Error("Unexpected SDL audio specification");
    const samples = new Int16Array(4096);
    for (let sample = 0; sample < samples.length; sample++) samples[sample] = sample % 2 === 0 ? 32767 : -32768;
    device.queue(samples);
    samples.fill(0);
    requireQueuedFrames(device, 2048);
    await Bun.sleep(30);
    requireQueuedFrames(device, 2048);
    device.resume();
    const deadline = performance.now() + 2000;
    while (device.queuedFrames > 0 && performance.now() < deadline) await Bun.sleep(10);
    device.pause();
    requireQueuedFrames(device, 0);
    device.queue(new Int16Array(2048));
    device.clear();
    requireQueuedFrames(device, 0);
    return "SDL audio: 48000 Hz stereo S16, 2048 paused frames, native dummy drain, clear and idempotent cleanup";
  } finally { device.close(); device.close(); }
}

if (import.meta.main) process.stdout.write(`${await runAudioSmoke()}\n`);
