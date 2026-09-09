/*
 * Sound traps from id Software's code/client/cl_cgame.c and cl_ui.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { Axis, Vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { EngineSound } from "../engine/sound.ts";
import type { QvmMemory } from "./memory.ts";

export interface QvmSoundServices {
  readonly sound: Pick<EngineSound, "bank" | "started" | "muted" | "startSound" | "startLocalSound" |
    "updateLoopingSound" | "updateRealLoopingSound" | "clearLoopingSounds" | "stopLoopingSound" |
    "updateEntityPosition" | "setListener" | "startBackgroundTrack" | "stopBackgroundTrack">;
  /** The actual client-static cls.framecount, sampled at S_AddLoopingSound. */
  frameNumber(): number;
}

function vector(view: DataView, offset = 0): Vec3 {
  return { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
}

/** Invalid source handles print and stop without selecting sound zero. */
export function qvmSoundSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, services: QvmSoundServices,
): number | Promise<number> | null {
  if (role === "game") return null;
  const trap = words.getInt32(0, true), sound = services.sound;
  const register = role === "ui" ? 31 : 34, local = role === "ui" ? 32 : 29;
  const startMusic = role === "ui" ? 63 : 35, stopMusic = role === "ui" ? 62 : 69;
  if (trap === register) {
    if (!sound.started) return 0;
    const name = memory.readString(words.getInt32(4, true)), compressed = words.getInt32(8, true) !== 0;
    return sound.bank.registerSound(name, compressed).then(pcm => sound.bank.indexForSound(pcm));
  }
  if (trap === local) {
    if (!sound.started || sound.muted) return 0;
    const index = words.getInt32(4, true), channel = words.getInt32(8, true);
    const pcm = sound.bank.soundForIndex(index);
    if (pcm === undefined) return 0;
    sound.startLocalSound(pcm, channel);
    return 0;
  }
  if (trap === startMusic) {
    const introWord = words.getInt32(4, true), loopWord = words.getInt32(8, true);
    const intro = introWord === 0 ? "" : memory.readString(introWord);
    const loop = loopWord === 0 ? "" : memory.readString(loopWord);
    return sound.startBackgroundTrack(intro, loop).then(() => 0);
  }
  if (trap === stopMusic) { sound.stopBackgroundTrack(); return 0; }
  if (role === "ui") return null;
  switch (trap) {
    case 28: {
      if (!sound.started || sound.muted) return 0;
      const originWord = words.getInt32(4, true), entity = words.getInt32(8, true), channel = words.getInt32(12, true);
      const index = words.getInt32(16, true);
      if (originWord === 0 && (entity < 0 || entity > 1024)) throw new CommonError("drop", `S_StartSound: bad entitynum ${entity}`);
      const pcm = sound.bank.soundForIndex(index);
      if (pcm === undefined) return 0;
      const origin = originWord === 0 ? null : vector(memory.view(originWord, 12));
      sound.startSound(pcm, { entity, channel, origin: origin === null ? { kind: "entity", entity } : { kind: "fixed", position: origin }, volume: 127 });
      return 0;
    }
    case 30: sound.clearLoopingSounds(words.getInt32(4, true) !== 0); return 0;
    case 31:
    case 80: {
      if (!sound.started || sound.muted) return 0;
      const entity = words.getInt32(4, true), originWord = words.getInt32(8, true), velocityWord = words.getInt32(12, true);
      const index = words.getInt32(16, true), pcm = sound.bank.soundForIndex(index);
      if (pcm === undefined) return 0;
      const origin = vector(memory.view(originWord, 12)), velocity = vector(memory.view(velocityWord, 12));
      if (trap === 31) sound.updateLoopingSound(pcm, { entity, origin, velocity, frameNumber: services.frameNumber() });
      else sound.updateRealLoopingSound(pcm, { entity, origin, velocity });
      return 0;
    }
    case 32: {
      const entity = words.getInt32(4, true), origin = vector(memory.view(words.getInt32(8, true), 12));
      sound.updateEntityPosition(entity, origin);
      return 0;
    }
    case 33: {
      if (!sound.started || sound.muted) return 0;
      const entity = words.getInt32(4, true), origin = vector(memory.view(words.getInt32(8, true), 12));
      const view = memory.view(words.getInt32(12, true), 36);
      const axis: Axis = [vector(view), vector(view, 12), vector(view, 24)];
      // S_Respatialize accepts inwater but does not use it.
      words.getInt32(16, true);
      sound.setListener(entity, origin, axis);
      return 0;
    }
    case 81: sound.stopLoopingSound(words.getInt32(4, true)); return 0;
    default: return null;
  }
}
