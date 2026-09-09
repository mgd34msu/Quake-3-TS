// Buffered and powerup audio from id Software's code/cgame/cg_view.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import type { Vec3 } from "../core/math.ts";
import type { ClientGameState } from "./state.ts";

export interface ClientFrameAudioHost {
  readonly startLocalSound: (sound: PcmSound | null, channel: number) => void;
  readonly startSound: (origin: Vec3 | null, entity: number, channel: number, sound: PcmSound | null) => void;
}

export class ClientFrameAudio {
  constructor(private readonly state: ClientGameState, private readonly media: { readonly wearOffSound: PcmSound | null },
    private readonly host: ClientFrameAudioHost) {}

  addBufferedSound(sound: PcmSound | null): void {
    if (sound === null) return;
    const state = this.state;
    state.soundBuffer[state.soundBufferIn] = sound;
    state.soundBufferIn = (state.soundBufferIn + 1) % 20;
    if (state.soundBufferIn === state.soundBufferOut) state.soundBufferOut++;
  }

  playBufferedSounds(): void {
    const state = this.state;
    if (state.soundTime >= state.time || state.soundBufferOut === state.soundBufferIn) return;
    const sound = state.soundBuffer[state.soundBufferOut];
    if (sound === undefined) throw new RangeError(`CG_PlayBufferedSounds: sound buffer index ${state.soundBufferOut} outside 0..19`);
    if (sound === null) return;
    this.host.startLocalSound(sound, 7);
    state.soundBuffer[state.soundBufferOut] = null;
    state.soundBufferOut = (state.soundBufferOut + 1) % 20;
    state.soundTime = (state.time + 750) | 0;
  }

  powerupTimerSounds(): void {
    const state = this.state, snapshot = state.snap;
    if (snapshot === null) throw new Error("CG_PowerupTimerSounds requires an active snapshot");
    for (let slot = 0; slot < 16; slot++) {
      const expiry = snapshot.playerState.powerups.get(slot);
      if (expiry <= state.time) continue;
      const remaining = (expiry - state.time) | 0;
      if (remaining >= 5000) continue;
      const previous = (expiry - state.oldTime) | 0;
      if (Math.trunc(remaining / 1000) !== Math.trunc(previous / 1000)) {
        this.host.startSound(null, snapshot.playerState.clientNum, 4, this.media.wearOffSound);
      }
    }
  }
}
