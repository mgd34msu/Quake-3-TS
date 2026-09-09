/*
 * Cinematic traps from id Software's code/client/cl_cgame.c and cl_ui.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { CinematicStatus, type EngineCinematics } from "../engine/cinematics.ts";
import type { Draw2D } from "../render/draw2d.ts";
import type { QvmMemory } from "./memory.ts";

export interface QvmCinematicServices {
  readonly cinematics: EngineCinematics;
  readonly draw: Draw2D;
  developerPrint(text: string): undefined;
}

/** Numeric handles borrow the engine's sixteen permanent cinematic cells. */
export function qvmCinematicSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, services: QvmCinematicServices,
): number | Promise<number> | null {
  if (role === "game") return null;
  const trap = words.getInt32(0, true), play = role === "ui" ? 75 : 74;
  if (trap < play || trap > play + 4) return null;
  const cinematics = services.cinematics;
  if (trap === play) {
    const pathWord = words.getInt32(4, true), x = words.getInt32(8, true), y = words.getInt32(12, true);
    const width = words.getInt32(16, true), height = words.getInt32(20, true), bits = words.getInt32(24, true);
    const path = memory.readString(pathWord);
    if (role === "ui") services.developerPrint("UI_CIN_PlayCinematic\n");
    return cinematics.prepare(path).then(asset => cinematics.play(asset, { x, y, width, height }, bits))
      .then(handle => handle === undefined ? -1 : handle.index);
  }
  const index = words.getInt32(4, true);
  if (trap === play + 1) return cinematics.stopSlot(index);
  const rect = trap === play + 4 ? { x: words.getInt32(8, true), y: words.getInt32(12, true),
    width: words.getInt32(16, true), height: words.getInt32(20, true) } : null;
  const handle = cinematics.handleAtSlot(index);
  if (trap === play + 2) return handle === undefined ? CinematicStatus.Eof : cinematics.run(handle);
  if (handle !== undefined) {
    if (rect === null) cinematics.draw(handle, services.draw);
    else cinematics.setExtents(handle, rect);
  }
  return 0;
}
