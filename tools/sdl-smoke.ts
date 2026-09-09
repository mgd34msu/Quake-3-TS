// SPDX-License-Identifier: GPL-2.0-or-later
import { SdlWindow } from "../src/platform/sdl.ts";
import { PassThrough } from "node:stream";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import { SdlGameInput } from "../src/platform/sdl-game-input.ts";
import { SourceInputState } from "../src/platform/source-input.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";

export async function runSdlSmoke(backend: "cpu" | "gl"): Promise<string> {
  if ((process.env["SDL_VIDEODRIVER"] !== "dummy" && process.env["SDL_VIDEODRIVER"] !== "offscreen")
    || process.env["SDL_AUDIODRIVER"] !== "dummy"
    || process.env["DISPLAY"] !== undefined || process.env["WAYLAND_DISPLAY"] !== undefined) {
    throw new Error("SDL smoke requires dummy/offscreen video, dummy audio, and absent DISPLAY/WAYLAND_DISPLAY");
  }
  const cvars = new CvarRegistry(), commands = new CommandBuffer(), stdin = new PassThrough();
  const clock = new UnixSystemClock(() => 1000100), print = (): undefined => undefined;
  const unix = new UnixIo(print, clock, { stdin, signals: "none" });
  const unavailable = (): never => { throw new Error("Unrelated client service reached by SDL smoke"); };
  const keys = new ClientKeys({ cvars, commands, print, host: {
    readConnection: () => ({ kind: "active", demoPlayback: false }), readUi: () => null, readCgame: () => null,
    assertCurrentOperation: () => { commands.assertCurrentExecution(); }, disconnect: unavailable,
    stopAllSounds: unavailable, addReliableCommand: unavailable, toggleConsole: unavailable,
    updateScreen: unavailable, consoleScroll: unavailable, readConsoleWidth: () => 78,
    clipboard: { kind: "native-unix-unavailable" },
  } });
  const source = new SourceInputState({ cvars, print });
  let window: SdlWindow | null = null, input: SdlGameInput | null = null;
  const dispatch = async (): Promise<void> => {
    for (let event = unix.takeQueuedEvent(); event !== null; event = unix.takeQueuedEvent()) {
      if (event.kind !== "key") throw new Error(`Unexpected typed input event: ${event.kind}`);
      await keys.keyEvent(event.key, event.down, event.time >>> 0);
    }
  };
  try {
    keys.initializeCommands(); keys.initializeConsoleFields(78); keys.setBinding(97, "+forward");
    cvars.set("in_joystick", "0"); cvars.set("in_nograb", "1"); cvars.set("in_subframe", "0");
    source.initialize();
    if (!source.mouse.available) throw new Error("Source input did not initialize before window creation");
    source.joystickState.button(0, true, (key, down, time) => { unix.queueEvent({ kind: "key", key, down, time }); });
    await dispatch();
    if (!keys.isDown(KeyCode.Joy1)) throw new Error("Synthetic joystick state was not held before window creation");
    window = SdlWindow.open({ title: "Quake III SDL verification", width: 16, height: 16, backend, hidden: true });
    const size = window.drawableSize;
    if (size.width !== 16 || size.height !== 16) throw new Error("SDL drawable size differs from request");
    window.pollEvents();
    window.pushEvent({ kind: "key", timestamp: 123, down: true, repeat: false, scancode: 4, keycode: 97, modifiers: 1 });
    window.pushEvent({ kind: "mouse-motion", timestamp: 124, buttons: 1, x: 7, y: 8, dx: -3, dy: 5 });
    window.pushEvent({ kind: "quit", timestamp: 125 });
    const events = window.pollEvents();
    if (!events.some(event => event.kind === "key" && event.scancode === 4 && event.keycode === 97 && event.modifiers === 1)) throw new Error("SDL key queue decode failed");
    if (!events.some(event => event.kind === "mouse-motion" && event.dx === -3 && event.dy === 5)) throw new Error("SDL mouse queue decode failed");
    if (!events.some(event => event.kind === "quit")) throw new Error("SDL quit queue decode failed");
    if (backend === "cpu") {
      const rgba = new Uint8Array(16 * 16 * 4);
      for (let pixel = 0; pixel < 256; pixel++) {
        rgba[pixel * 4] = pixel;
        rgba[pixel * 4 + 1] = 255 - pixel;
        rgba[pixel * 4 + 2] = pixel % 2 === 0 ? 29 : 219;
        rgba[pixel * 4 + 3] = 255;
      }
      window.present(rgba);
      const actual = window.readPixels();
      for (let offset = 0; offset < rgba.length; offset++) {
        if (actual[offset] !== rgba[offset]) throw new Error(`SDL framebuffer mismatch at byte ${offset}`);
      }
    } else {
      window.getGlProcAddress("glGetString");
      window.getGlProcAddress("glReadPixels");
      window.swap();
    }
    input = SdlGameInput.open({ window, unix, cvars, keys, clock, print, source });
    window.pushEvent({ kind: "key", timestamp: window.ticks, down: true, repeat: false, scancode: 4, keycode: 97, modifiers: 0 });
    input.sendKeyEvents(); await dispatch();
    const pressedText = commands.pendingText;
    if (!keys.isDown(97) || pressedText !== "+forward 97 100\n") throw new Error("Native keydown did not reach ClientKeys");
    unix.queueEvent({ kind: "console", time: 20, text: "retained" });
    window.pushEvent({ kind: "key", timestamp: window.ticks, down: false, repeat: false, scancode: 4, keycode: 97, modifiers: 0 });
    input.sendKeyEvents();
    cvars.set("in_mouse", "0");
    if (!source.mouse.available) throw new Error("Mouse availability changed before restart");
    source.restart();
    if (source.mouse.available || !keys.isDown(97)) throw new Error("Restart changed held keys or failed to apply mouse availability");
    let duplicateLeaseRejected = false;
    try { const lease = window.beginInput(); lease.close(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already has an owner")) throw error;
      duplicateLeaseRejected = true;
    }
    if (!duplicateLeaseRejected) throw new Error("Restart lost the SDL input lease");
    const marker = unix.takeQueuedEvent();
    if (marker?.kind !== "console" || marker.time !== 20 || marker.text !== "retained") throw new Error("Restart lost the queued marker");
    await dispatch();
    const releasedText = commands.pendingText;
    if (keys.isDown(97) || releasedText !== "+forward 97 100\n-forward 97 100\n") throw new Error("Restart lost the queued keyup");
    cvars.set("in_mouse", "1");
    if (source.mouse.available) throw new Error("Mouse availability changed before second restart");
    source.restart();
    if (!source.mouse.available || !keys.isDown(KeyCode.Joy1)) throw new Error("Second restart lost source state");
    input.close(); input.close(); window.close(); window.close();
    window = SdlWindow.open({ title: "Quake III SDL replacement", width: 16, height: 16, backend, hidden: true });
    window.pollEvents();
    input = SdlGameInput.open({ window, unix, cvars, keys, clock, print, source });
    if (!keys.isDown(KeyCode.Joy1) || !source.mouse.available) throw new Error("Window replacement lost source input state");
    window.pushEvent({ kind: "window", timestamp: window.ticks, event: 13, data1: 0, data2: 0 });
    input.sendKeyEvents(); await dispatch();
    if (keys.inputState.anyKeyDown !== 0) throw new Error("Replacement focus loss did not release shared synthetic joystick state");
    return `SDL ${backend}: 16x16 drawable, native key/mouse/quit queue, ${backend === "cpu" ? "1024 exact readback bytes" : "GL context, procedure lookup and swap"}, typed ClientKeys delivery, SourceInputState.restart preserves held/queued input and lease, shared synthetic joystick state across window replacement, idempotent cleanup`;
  } finally {
    try { input?.close(); input?.close(); }
    finally {
      try { window?.close(); window?.close(); }
      finally { source.close(); source.close(); unix.close(); unix.close(); stdin.destroy(); }
    }
  }
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "cpu";
  if (mode !== "cpu" && mode !== "gl") throw new Error("Usage: bun tools/sdl-smoke.ts [cpu|gl]");
  process.stdout.write(`${await runSdlSmoke(mode)}\n`);
}
