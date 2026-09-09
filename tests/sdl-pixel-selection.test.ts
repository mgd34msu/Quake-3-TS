// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";

describe("SDL source visual selection", () => {
  test("rejects undefined float32-to-int visual conversions and invalid refresh integers before allocating video resources", () => {
    for (const value of [NaN, Infinity, -Infinity, -0x80000100, 0x7fffffff, 0x80000000]) {
      const options = { title: "invalid visual", width: 16, height: 16, hidden: true };
      expect(() => SdlWindow.open({ ...options, backend: "gl", colorBits: value })).toThrow("signed 32-bit");
      expect(() => SdlWindow.open({ ...options, backend: "gl", depthBits: value })).toThrow("signed 32-bit");
    }
    for (const value of [NaN, Infinity, 1.5, -0x80000001, 0x80000000]) {
      const options = { title: "invalid refresh", width: 16, height: 16, hidden: true };
      expect(() => SdlWindow.open({ ...options, backend: "cpu", displayRefresh: value })).toThrow("signed 32-bit");
    }
  });

  test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("accepts source fractional and float32-underflow visual requests before integer SDL attributes", () => {
    for (const value of [0.5, -0.5, 24.9, Number("2.4e1"), 1e-50, -1e-50]) {
      const window = SdlWindow.open({ title: "source float visual", width: 16, height: 16, backend: "gl", hidden: true,
        colorBits: value, depthBits: value });
      try {
        expect(window.drawableSize).toEqual({ width: 16, height: 16 });
        window.swap();
      } finally { window.close(); }
    }
  });

  test("windowed refresh requests retain the actual desktop frequency and exact CPU pixels", () => {
    const first = SdlWindow.open({ title: "desktop frequency", width: 16, height: 16, backend: "cpu", hidden: true });
    try {
      const refresh = first.display.refreshRate;
      const second = SdlWindow.open({ title: "ignored windowed refresh", width: 16, height: 16, backend: "cpu", hidden: true,
        displayRefresh: refresh === 144 ? 60 : 144 });
      try {
        expect(second.display.refreshRate).toBe(refresh);
        expect(second.flags & 1).toBe(0);
        const pixels = new Uint8Array(16 * 16 * 4).fill(255);
        pixels[0] = 29; pixels[1] = 117; pixels[2] = 231;
        second.present(pixels);
        expect(second.readPixels()).toEqual(pixels);
      } finally { second.close(); }
    } finally { first.close(); }
  });

  test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("opens source default, 16-, 24- and 32-bit color requests and reports actual context precision", () => {
    for (const colorBits of [0, 16, 24, 32]) {
      for (const depthBits of [0, 16, 24]) {
        const window = SdlWindow.open({ title: "source visual", width: 16, height: 16, backend: "gl", hidden: true, colorBits, depthBits });
        let renderer: GlRenderer | null = null;
        try {
          const images = new RendererImageCatalog();
          renderer = new GlRenderer(window, images);
          renderer.initializeDefaultState(renderer.capabilities.textureUnits > 1, () => {
            images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
          });
          expect(renderer.colorBits).toBeGreaterThanOrEqual(12);
          expect(renderer.depthBits).toBeGreaterThanOrEqual(8);
          renderer.beginView({ viewport: { x: 0, y: 0, width: 16, height: 16 },
            clear: { color: { x: 1, y: 0, z: 0, w: 1 }, depth: 1, stencil: false } });
          expect(Array.from(renderer.readPixels().subarray(0, 4))).toEqual([255, 0, 0, 255]);
          window.swap();
        } finally { renderer?.close(); window.close(); }
      }
    }
  });

  test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("reduces an unavailable stencil request and cleans every failed visual before reopening", () => {
    const window = SdlWindow.open({ title: "source stencil fallback", width: 16, height: 16, backend: "gl", hidden: true, stencilBits: 24 });
    let renderer: GlRenderer | null = null;
    try {
      renderer = new GlRenderer(window, new RendererImageCatalog());
      expect(renderer.stencilBits).toBeGreaterThanOrEqual(0);
      expect(renderer.depthBits).toBeGreaterThanOrEqual(8);
      const input = window.beginInput();
      try {
        let failure: unknown;
        try { SdlWindow.open({ title: "impossible depth", width: 16, height: 16, backend: "gl", hidden: true, depthBits: 128 }); }
        catch (error) { failure = error; }
        if (!(failure instanceof AggregateError)) throw new Error("Impossible depth must exhaust the source visual attempts");
        const failures: unknown = failure.errors;
        if (!Array.isArray(failures)) throw new Error("Visual failures must be an array");
        expect(failures.length).toBe(16);
        expect(input.closed).toBe(false);
        window.swap();
      } finally { input.close(); }
    } finally { renderer?.close(); window.close(); }
    const next = SdlWindow.open({ title: "reopened visual", width: 16, height: 16, backend: "gl", hidden: true });
    try { next.swap(); } finally { next.close(); next.close(); }
  });

  test.skipIf(process.env["QUAKE_VIDEO_FULLSCREEN_TEST"] !== "1" || process.env["SDL_VIDEODRIVER"] !== "x11")(
    "fullscreen refresh request selects an available mode and restores the display on close", () => {
      // This opt-in profile requires an isolated Xvfb with a window manager.
      const desktop = SdlWindow.open({ title: "retained desktop", width: 16, height: 16, backend: "cpu", hidden: true });
      try {
        const before = desktop.display;
        const fullscreen = SdlWindow.open({ title: "fullscreen refresh", width: 320, height: 240, backend: "cpu", fullscreen: true, displayRefresh: 144 });
        try {
          expect(fullscreen.flags & 1).toBe(1);
          expect(fullscreen.display.refreshRate).toBe(desktop.display.refreshRate);
          expect(fullscreen.width).toBeGreaterThanOrEqual(320);
          expect(fullscreen.height).toBeGreaterThanOrEqual(240);
        } finally { fullscreen.close(); }
        expect(desktop.display.refreshRate).toBe(before.refreshRate);
      } finally { desktop.close(); }
    });
});
