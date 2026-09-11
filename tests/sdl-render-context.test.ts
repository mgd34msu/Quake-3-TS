// SPDX-License-Identifier: GPL-2.0-or-later
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { SdlWindow } from "../src/platform/sdl.ts";
import { SdlWorkerRenderContext } from "../src/platform/sdl-render-context.ts";
import { loadGl } from "../src/platform/gl.ts";

function runWorker(): void {
  const data: unknown = workerData, port = parentPort;
  if (port === null) throw new Error("SDL context test worker requires its parent port");
  let context: SdlWorkerRenderContext | null = null;
  let gl: ReturnType<typeof loadGl> | null = null;
  const finish = (error: unknown): void => {
    if (error !== null) port.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    try { gl?.close(); } finally { context?.release(); context?.release(); }
    port.postMessage({ kind: "released" });
    port.close();
  };
  try {
    context = SdlWorkerRenderContext.adopt(data);
    gl = loadGl(context);
    const size = context.drawableSize, pixels = new Uint8Array(size.width * size.height * 4), binding = new Int32Array(1);
    gl.symbols.glGetIntegerv(0x8069, binding);
    gl.symbols.glClearColor(0, 1, 0, 1); gl.symbols.glClear(0x4000);
    gl.symbols.glReadPixels(0, 0, size.width, size.height, 0x1908, 0x1401, pixels);
    context.swap();
    context.setRenderingEnabled(false);
    context.makeCurrent();
    gl.symbols.glClearColor(1, 0, 0, 1); gl.symbols.glClear(0x4000);
    context.swap();
    const gateStayedDisabled = !context.renderingEnabled;
    gl.symbols.glClearColor(0, 0, 1, 1); gl.symbols.glClear(0x4000);
    context.setRenderingEnabled(true);
    const gatedColor = new Float32Array(4);
    gl.symbols.glGetFloatv(0x0c22, gatedColor);
    port.once("message", (command: unknown) => finish(command === "release" ? null : new Error("deliberate render failure")));
    port.postMessage({ kind: "ready", size, binding: binding[0], pixels, gatedColor: Array.from(gatedColor),
      gateStayedDisabled, error: gl.symbols.glGetError() });
  } catch (error) {
    finish(error);
  }
}

function spawnWorker(transfer: unknown) {
  const worker = new Worker(new URL(import.meta.url), { workerData: transfer });
  const messages: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  worker.on("message", (message: unknown) => {
    const receive = waiting.shift();
    if (receive === undefined) messages.push(message);
    else receive(message);
  });
  const released = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "released") resolve();
    });
    worker.once("error", reject);
  });
  return { worker,
    stop: async (): Promise<void> => { worker.postMessage("release"); await released; await worker.terminate(); },
    receive: (): Promise<unknown> => messages.length > 0 ? Promise.resolve(messages.shift()) : new Promise(resolve => waiting.push(resolve)) };
}

if (!isMainThread) {
  runWorker();
} else {
  const { describe, expect, test } = await import("bun:test");
  describe("SDL render context transfer", () => {
    test("rejects malformed transfers before native access", () => {
      for (const value of [null, 1, {}, { windowId: 0 }, { windowId: 1, key: "bad", ownership: new SharedArrayBuffer(4) }])
        expect(() => SdlWorkerRenderContext.adopt(value)).toThrow("Invalid SDL render context transfer");
    });

    const native = process.env["QUAKE_SDL_RENDER_CONTEXT_TEST"] === "1";
    test.skipIf(!native)("same context survives worker draw, exclusive ownership, release, and repeated transfer", async () => {
      if (process.env["SDL_VIDEODRIVER"] !== "x11" || process.env["WAYLAND_DISPLAY"] !== undefined
        || process.env["DISPLAY"] !== process.env["QUAKE_OWNED_DISPLAY"] || process.env["SDL_AUDIODRIVER"] !== "dummy")
        throw new Error("Native context test requires a preflighted owned Xvfb child environment");
      const window = SdlWindow.open({ title: "SDL worker context", width: 4, height: 4, backend: "gl", hidden: true });
      const sibling = SdlWindow.open({ title: "SDL sibling context", width: 4, height: 4, backend: "gl", hidden: true });
      const gl = loadGl(window);
      try {
        const textures = new Uint32Array(1);
        gl.symbols.glGenTextures(1, textures);
        const texture = textures[0];
        if (texture === undefined || texture === 0) throw new Error("GL did not allocate a texture");
        gl.symbols.glBindTexture(0x0de1, texture);
        for (const command of ["release", "fail", "release"]) {
          const startDisabled = command === "fail";
          if (startDisabled) window.setRenderingEnabled(false);
          const transfer = window.detachRenderContext(), worker = spawnWorker(transfer);
          try {
            const pixels = new Uint8Array(64);
            for (let offset = 0; offset < pixels.length; offset += 4) { pixels[offset + 1] = 255; pixels[offset + 3] = 255; }
            expect(await worker.receive()).toEqual({ kind: "ready", size: { width: 4, height: 4 }, binding: texture, pixels,
              gatedColor: [0, 1, 0, 1], gateStayedDisabled: true, error: 0 });
            expect(() => window.makeCurrent()).toThrow("worker");
            expect(() => window.setRenderingEnabled(false)).toThrow("worker");
            expect(() => window.swap()).toThrow("worker");
            expect(() => window.close()).toThrow("worker");
            expect(() => sibling.close()).toThrow("worker");
            expect(() => window.restoreRenderContext()).toThrow("worker");
            expect(() => SdlWindow.open({ title: "competing window", width: 4, height: 4, backend: "gl", hidden: true })).toThrow("worker");
            window.pushEvent({ kind: "quit", timestamp: 42 });
            expect(window.pollEvents().some(event => event.kind === "quit")).toBe(true);
            const duplicate = spawnWorker(transfer);
            try {
              expect(await duplicate.receive()).toEqual({ kind: "error", message: "SDL render context transfer was already consumed" });
              expect(await duplicate.receive()).toEqual({ kind: "released" });
            } finally { await duplicate.stop(); }
            worker.worker.postMessage(command);
            if (command === "fail") expect(await worker.receive()).toEqual({ kind: "error", message: "deliberate render failure" });
            expect(await worker.receive()).toEqual({ kind: "released" });
          } finally { await worker.stop(); }
          window.restoreRenderContext(); window.restoreRenderContext();
          expect(window.renderingEnabled).toBe(!startDisabled);
          window.setRenderingEnabled(true);
          const color = new Float32Array(4), binding = new Int32Array(1);
          gl.symbols.glGetFloatv(0x0c22, color); gl.symbols.glGetIntegerv(0x8069, binding);
          expect(Array.from(color)).toEqual([0, 1, 0, 1]);
          expect(binding[0]).toBe(texture);
          window.swap();
          const stale = spawnWorker(transfer);
          try {
            expect(await stale.receive()).toEqual({ kind: "error", message: "SDL render context transfer was already consumed" });
            expect(await stale.receive()).toEqual({ kind: "released" });
          } finally { await stale.stop(); }
        }
        gl.symbols.glDeleteTextures(1, textures);
        const cancelled = window.detachRenderContext();
        window.restoreRenderContext();
        const late = spawnWorker(cancelled);
        try {
          expect(await late.receive()).toEqual({ kind: "error", message: "SDL render context transfer was already consumed" });
          expect(await late.receive()).toEqual({ kind: "released" });
        } finally { await late.stop(); }
        window.makeCurrent();
        const invalid = window.detachRenderContext();
        const failed = spawnWorker({ ...invalid, key: `quake3-render-${crypto.randomUUID()}` });
        try {
          expect(await failed.receive()).toEqual({ kind: "error", message: "SDL render context ownership does not match the registered transfer" });
          expect(await failed.receive()).toEqual({ kind: "released" });
        } finally { await failed.stop(); }
        window.restoreRenderContext(); window.swap();
      } finally { gl.close(); window.close(); sibling.close(); }
      const restarted = SdlWindow.open({ title: "SDL context restart", width: 4, height: 4, backend: "gl", hidden: true });
      restarted.swap(); restarted.close(); restarted.close();
    }, 20000);
  });
}
