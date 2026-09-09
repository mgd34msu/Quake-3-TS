/*
 * S_Update/S_GetSoundtime/S_Update_ from id Software's code/client/snd_dma.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { AudioMixer } from "../audio/mixer.ts";
import { BackgroundMusic } from "../audio/music.ts";
import { CvarRegistry } from "../core/cvar.ts";
import { CommonEvents } from "./common-events.ts";
import { SoundOutput } from "./sound-output.ts";

/**
 * Scheduling for an already-open output, not S_Init/registration or a background-track owner.
 * Linux's submission_chunk is one frame. SDL queue delivery supplies consumed PCM
 * positions, while its performance clock advances empty-queue silence. Hardware
 * latency and native DMA-wrap timing are not measured by this logical timeline.
 */
export class SoundFrame {
  private readonly mixer: AudioMixer;
  private lastTime = Math.fround(0);
  private oldSoundTime = -1;

  constructor(
    private readonly output: SoundOutput,
    private readonly music: BackgroundMusic,
    private readonly events: CommonEvents,
    private readonly cvars: CvarRegistry,
    private readonly stopAllSounds: () => undefined,
  ) {
    const mixer = output.mixer;
    if (mixer === null) throw new Error("Sound frame requires started output");
    if (music.mixer !== mixer) throw new Error("Background music belongs to a different mixer");
    this.mixer = mixer;
  }

  update(): void {
    this.requireLifetime();
    if (!this.mixer.playbackEnabled) return;
    // Source music fills against the previous sound time, before Com_Milliseconds drains input.
    if (this.music.isPlaying) this.music.setVolume(this.setting("s_musicvolume"));
    this.music.update();
    const milliseconds = this.events.milliseconds();
    if (!Number.isInteger(milliseconds) || milliseconds < -2147483648 || milliseconds > 2147483647) {
      throw new RangeError("sound frame clock requires signed-int milliseconds");
    }
    this.requireLifetime();
    const thisTime = Math.fround(milliseconds);
    this.output.rebaseTime(this.stopAllSounds);
    const soundTime = this.output.deliveryTime;
    const prestep = this.setting("s_mixPreStep");
    const paintTime = Math.trunc(Math.fround(Math.fround(soundTime) + Math.fround(prestep * this.mixer.outputRate)));
    if (!Number.isInteger(paintTime) || paintTime < -2147483648 || paintTime > 2147483647) {
      throw new RangeError("sound paint time has an undefined signed-int conversion");
    }
    this.mixer.selectTime(soundTime, paintTime);
    if (soundTime === this.oldSoundTime) return;
    this.oldSoundTime = soundTime;
    this.mixer.scanChannelStarts();

    const sane = Math.max(11, Math.fround(thisTime - this.lastTime));
    const ma = Math.fround(this.setting("s_mixahead") * this.mixer.outputRate);
    const op = Math.fround(prestep + Math.fround(sane * this.mixer.outputRate) * 0.01);
    const proposedEnd = Math.trunc(Math.fround(Math.fround(soundTime) + Math.min(ma, op)));
    if (!Number.isInteger(proposedEnd) || proposedEnd < 0 || proposedEnd > 4294967295) {
      throw new RangeError("sound end time has an undefined unsigned-int conversion");
    }
    const ahead = (proposedEnd - soundTime) >>> 0;
    const endTime = ahead > this.output.maxQueuedFrames ? soundTime + this.output.maxQueuedFrames : proposedEnd;
    this.mixer.setEffectsVolume(this.setting("s_volume"));
    if (endTime > paintTime) this.output.repaint({ startFrame: paintTime, endFrame: endTime });
    this.lastTime = thisTime;
  }

  private requireLifetime(): void {
    if (this.output.mixer !== this.mixer) throw new Error("Sound frame output lifetime has ended");
  }

  private setting(name: string): number {
    const value = this.cvars.get(name);
    if (value === undefined) throw new Error(`Missing sound cvar ${name}`);
    return value.numericValue;
  }
}
