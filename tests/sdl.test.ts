// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { SdlWindow } from "../src/platform/sdl.ts";
import type { SdlInjectedEvent } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { runSdlSmoke } from "../tools/sdl-smoke.ts";

function cpu(): SdlWindow {
  return SdlWindow.open({ title: "SDL test", width: 3, height: 2, backend: "cpu", hidden: true });
}

function verifyFrame(window: SdlWindow): void {
  const { width, height } = window.drawableSize, expected = new Uint8Array(width * height * 4).fill(255);
  if (window.backend === "cpu") {
    window.present(expected);
    expect(window.readPixels()).toEqual(expected);
  } else {
    const native = loadGl(window);
    try {
      const pixels = new Uint8Array(expected.length), gl = native.symbols;
      gl.glClearColor(1, 1, 1, 1); gl.glClear(0x4000);
      gl.glReadPixels(0, 0, width, height, 0x1908, 0x1401, pixels);
      expect(gl.glGetError()).toBe(0);
      expect(pixels).toEqual(expected);
      window.swap();
    } finally { native.close(); }
  }
}

describe("SDL2 native boundary", () => {
  test("presents exact RGBA pixels through the software renderer", async () => {
    expect(await runSdlSmoke("cpu")).toContain("1024 exact readback bytes");
  });

  test("decodes real native key, mouse, window and quit events", () => {
    const window = cpu();
    try {
      window.pollEvents();
      const expected: readonly SdlInjectedEvent[] = [
        { kind: "key", timestamp: 111, down: true, repeat: true, scancode: 40, keycode: 13, modifiers: 0x2040 },
        { kind: "key", timestamp: 112, down: false, repeat: false, scancode: 4, keycode: 97, modifiers: 0 },
        { kind: "mouse-motion", timestamp: 114, buttons: 5, x: -12, y: 42, dx: -7, dy: 19 },
        { kind: "mouse-button", timestamp: 115, down: true, button: 3, clicks: 2, x: 17, y: -2 },
        { kind: "mouse-button", timestamp: 116, down: false, button: 3, clicks: 2, x: 17, y: -2 },
        { kind: "window", timestamp: 118, event: 14, data1: 123, data2: -456 },
        { kind: "quit", timestamp: 119 },
      ];
      for (const event of expected) window.pushEvent(event);
      expect(window.pollEvents()).toEqual(expected);
      expect(window.pollEvents()).toEqual([]);
    } finally { window.close(); }
  });

  test("retains per-window events and balances SDL subsystem ownership", () => {
    const first = cpu();
    const second = cpu();
    try {
      first.pollEvents(); second.pollEvents();
      second.pushEvent({ kind: "key", timestamp: 123, down: true, repeat: false, scancode: 4, keycode: 97, modifiers: 0 });
      first.pushEvent({ kind: "quit", timestamp: 124 });
      expect(first.pollEvents().map(event => event.kind)).toEqual(["quit"]);
      expect(second.pollEvents().map(event => event.kind)).toEqual(["key", "quit"]);
      first.close(); first.close();
      expect(second.drawableSize).toEqual({ width: 3, height: 2 });
      const frame = new Uint8Array(24).fill(255);
      second.present(frame);
      expect(second.readPixels()).toEqual(frame);
    } finally { first.close(); second.close(); }
    const reopened = cpu();
    reopened.close();
  });

  test("copies submitted memory and accepts typed-array subviews", () => {
    const window = cpu();
    try {
      expect(window.fullscreenFailure).toBeNull();
      const memory = new Uint8Array(32).fill(255);
      const frame = memory.subarray(4, 28);
      frame[0] = 17; frame[1] = 83; frame[2] = 211;
      const expected = frame.slice();
      window.present(frame);
      memory.fill(0);
      expect(window.readPixels()).toEqual(expected);
    } finally { window.close(); }
  });

  test("rejects invalid dimensions, strings, frames and closed handles", () => {
    for (const width of [0, -1, 1.5, NaN, Infinity, 16385]) {
      expect(() => SdlWindow.open({ title: "test", width, height: 2, backend: "cpu" })).toThrow("dimensions");
    }
    expect(() => SdlWindow.open({ title: "bad\0title", width: 2, height: 2, backend: "cpu" })).toThrow("NUL");
    const window = cpu();
    try {
      expect(() => window.readPixels()).toThrow("No framebuffer");
      expect(() => window.present(new Uint8Array(23))).toThrow("size");
      expect(() => window.swap()).toThrow("GL window");
      expect(() => window.getGlProcAddress("glReadPixels")).toThrow("GL window");
      expect(() => window.pushEvent({ kind: "key", timestamp: 0, down: true, repeat: false, scancode: 4, keycode: 97, modifiers: 65536 })).toThrow("uint16");
      expect(() => window.pushEvent({ kind: "mouse-button", timestamp: 0, down: true, button: 256, clicks: 1, x: 0, y: 0 })).toThrow("uint8");
      expect(() => window.pushEvent({ kind: "quit", timestamp: -1 })).toThrow("uint32");
    } finally { window.close(); }
    window.close();
    expect(() => window.pollEvents()).toThrow("closed");
    expect(() => window.present(new Uint8Array(24))).toThrow("closed");
    expect(() => window.drawableSize).toThrow("closed");
  });

  test.skipIf(process.env["SDL_VIDEODRIVER"] !== "dummy")("cleans up failed GL creation while another CPU window remains usable", () => {
    const window = cpu();
    try {
      for (const fullscreen of [false, true])
        expect(() => SdlWindow.open({ title: "unsupported GL", width: 2, height: 2, backend: "gl", hidden: true, fullscreen }))
          .toThrow("SDL could not create any source GL visual candidate");
      const frame = new Uint8Array(24).fill(255);
      window.present(frame);
      expect(window.readPixels()).toEqual(frame);
    } finally { window.close(); }
  });

  test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("creates a compatibility GL context and switches multiple windows", async () => {
    expect(await runSdlSmoke("gl")).toContain("procedure lookup and swap");
    const first = SdlWindow.open({ title: "GL one", width: 16, height: 16, backend: "gl", hidden: true });
    const second = SdlWindow.open({ title: "GL two", width: 16, height: 16, backend: "gl", hidden: true });
    try {
      first.makeCurrent(); first.swap(); second.makeCurrent(); second.swap();
      expect(first.getGlProcAddress("glBegin")).toBeGreaterThan(0);
      first.close();
      second.swap();
      expect(() => second.present(new Uint8Array(1024))).toThrow("CPU window");
      expect(() => second.getGlProcAddress("")).toThrow("empty");
      expect(() => second.getGlProcAddress("bad\0name")).toThrow("NUL");
    } finally { first.close(); second.close(); }
  });

  // Opt in only on a separately owned Xvfb with one 320x240x24 screen.
  // 400x300 has no fitting mode there; these windows never touch the user's display.
  for (const backend of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
    test.skipIf(process.env["QUAKE_VIDEO_FULLSCREEN_TEST"] !== "1" || process.env["SDL_VIDEODRIVER"] !== "x11"
      || (backend === "gl" && process.env["QUAKE_GL_TEST"] !== "1"))(
      `actual ${backend} fullscreen mode selection continues windowed when no mode fits`, () => {
        const retained = cpu();
        try {
          for (const displayRefresh of [0, 60]) {
            const window = SdlWindow.open({ title: "SDL no fitting fullscreen mode", width: 400, height: 300,
              backend, hidden: true, fullscreen: true, displayRefresh });
            try {
              expect(window.fullscreenFailure).toContain("SDL_GetClosestDisplayMode");
              expect(window.flags & 1).toBe(0);
              expect(window.drawableSize).toEqual({ width: 400, height: 300 });
              verifyFrame(window);
              window.pollEvents();
              const event: SdlInjectedEvent = { kind: "key", timestamp: 123, down: true, repeat: false,
                scancode: 4, keycode: 97, modifiers: 0 };
              window.pushEvent(event); expect(window.pollEvents()).toEqual([event]);
            } finally { window.close(); window.close(); }
            expect(retained.drawableSize).toEqual({ width: 3, height: 2 });
            verifyFrame(retained);
          }
          const fullscreen = SdlWindow.open({ title: "SDL fitting fullscreen mode", width: 320, height: 240,
            backend, hidden: true, fullscreen: true });
          try {
            expect(fullscreen.fullscreenFailure).toBeNull();
            expect(fullscreen.flags & 1).toBe(1);
            expect(fullscreen.drawableSize).toEqual({ width: 320, height: 240 });
            verifyFrame(fullscreen);
          } finally { fullscreen.close(); }
          verifyFrame(retained);
        } finally { retained.close(); }
      });
  }
});
