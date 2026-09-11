// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { loadGl } from "../src/platform/gl.ts";
import { defaultOpenGlDriver } from "../src/platform/native-libraries.ts";
import { openUnixGlDriver } from "../src/platform/renderer-driver.ts";
import { SdlWindow } from "../src/platform/sdl.ts";

test.skipIf(process.env["QUAKE_SDL_RENDER_CONTEXT_TEST"] !== "1")("system OpenGL fallback loads the native driver and renders exact pixels", () => {
  if (process.env["SDL_VIDEODRIVER"] !== "x11" || process.env["WAYLAND_DISPLAY"] !== undefined
    || process.env["DISPLAY"] !== process.env["QUAKE_OWNED_DISPLAY"] || process.env["DISPLAY"] === undefined
    || process.env["SDL_AUDIODRIVER"] !== "dummy") throw new Error("Native driver test requires an owned Xvfb and dummy audio");
  const cvars = new CvarRegistry();
  cvars.register("r_glDriver", "quake3-missing-gl-driver", CvarFlag.Archive | CvarFlag.Latch);
  const attempts: string[] = [];
  const window = openUnixGlDriver(cvars, driver => {
    attempts.push(driver);
    return SdlWindow.open({ title: "system GL driver", width: 4, height: 4, backend: "gl", hidden: true, driver });
  });
  const gl = loadGl(window);
  try {
    const driver = defaultOpenGlDriver();
    expect(attempts).toEqual(["quake3-missing-gl-driver", driver]);
    expect(cvars.get("r_glDriver")?.value).toBe(driver);
    expect(cvars.get("r_previousglDriver")?.value).toBe(driver);
    gl.symbols.glClearColor(0, 1, 0, 1);
    gl.symbols.glClear(0x4000);
    const pixels = new Uint8Array(4 * 4 * 4);
    gl.symbols.glReadPixels(0, 0, 4, 4, 0x1908, 0x1401, pixels);
    expect(Array.from(pixels)).toEqual(Array.from({ length: 16 }, () => [0, 255, 0, 255]).flat());
    expect(gl.symbols.glGetError()).toBe(0);
    window.swap();
  } finally { gl.close(); window.close(); }
});
