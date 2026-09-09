// SPDX-License-Identifier: GPL-2.0-or-later
// code/unix/linux_glimp.c GLimp_Init driver selection, with SDL2 library ownership.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { SdlWindow } from "./sdl.ts";

/** The caller attempts its requested mode and mode 3 within each library attempt. */
export function openUnixGlDriver(cvars: CvarRegistry, open: (driver: string) => SdlWindow): SdlWindow {
  cvars.register("r_lastValidRenderer", "(uninitialized)", CvarFlag.Archive);
  cvars.register("r_allowSoftwareGL", "0", CvarFlag.Latch);
  const previous = cvars.register("r_previousglDriver", "", CvarFlag.ReadOnly);
  if (previous.value.length !== 0) cvars.set("r_glDriver", previous.value, true);
  const requested = cvars.get("r_glDriver");
  if (requested === undefined) throw new Error("r_glDriver must register before GLimp_Init");
  let window: SdlWindow;
  try { window = open(requested.value); }
  catch (error) {
    if (requested.value.toLowerCase() === "libgl.so.1") throw error;
    try { window = open("libGL.so.1"); }
    catch (fallback) {
      throw new AggregateError([error, fallback], "GLimp_Init() - could not load OpenGL subsystem", { cause: error });
    }
    cvars.set("r_glDriver", "libGL.so.1", true);
    cvars.clearModified("r_glDriver");
  }
  const selected = cvars.get("r_glDriver");
  if (selected === undefined) throw new Error("r_glDriver disappeared during GLimp_Init");
  cvars.set("r_previousglDriver", selected.value, true);
  return window;
}

/** Reached only when GLimp_Init creates a new context, not RE_Shutdown(false). */
export function initializeUnixGlRenderer(cvars: CvarRegistry, renderer: string): void {
  const previous = cvars.get("r_lastValidRenderer");
  if (previous === undefined) throw new Error("GLimp_Init driver state is not registered");
  if (previous.value.toLowerCase() !== renderer.toLowerCase()) {
    cvars.set("r_textureMode", "GL_LINEAR_MIPMAP_NEAREST", true);
    if (renderer.toLowerCase().includes("voodoo graphics/1 tmu/2 mb")) {
      cvars.set("r_picmip", "2", true);
      cvars.register("r_picmip", "1", CvarFlag.Archive | CvarFlag.Latch);
    } else {
      cvars.set("r_picmip", "1", true);
      const name = renderer.toLowerCase();
      if (name.includes("rage 128") || name.includes("rage128")) cvars.set("r_finish", "0", true);
      else if (name.includes("savage3d") || name.includes("s3 savage4"))
        cvars.set("r_textureMode", "GL_LINEAR_MIPMAP_LINEAR", true);
    }
  }
  cvars.set("r_lastValidRenderer", renderer, true);
}
