// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { KEY_CHAR_FLAG, KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import type { ClientKeyHost, ClientKeyUi } from "../src/engine/client-keys.ts";
import { CommonEvents } from "../src/engine/common-events.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { SdlJoystick, SdlWindow } from "../src/platform/sdl.ts";
import { SdlGameInput, sdlEventTime, sdlGameKey, sdlJoystickAxes } from "../src/platform/sdl-game-input.ts";
import { SourceInputState } from "../src/platform/source-input.ts";
import { GraphicalEventSource } from "../src/platform/graphical-input.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UdpTransport } from "../src/platform/network.ts";

function fixture(visible = false, joystick = false, ui: ClientKeyUi | null = null,
  beforeWindow: ((source: SourceInputState, unix: UnixIo) => undefined) | null = null) {
  const cvars = new CvarRegistry(), commands = new CommandBuffer(), prints: string[] = [], stdin = new PassThrough();
  const wall = { now: 1000100 }, clock = new UnixSystemClock(() => wall.now);
  const print = (text: string): undefined => { prints.push(text); };
  const unix = new UnixIo(print, clock, { stdin, signals: "none" });
  const unavailable = (): never => { throw new Error("Unrelated client service called by SDL input test"); };
  const host: ClientKeyHost = {
    readConnection: () => ({ kind: "active", demoPlayback: false }), readUi: () => ui, readCgame: () => null,
    assertCurrentOperation: () => { commands.assertCurrentExecution(); }, disconnect: unavailable,
    stopAllSounds: unavailable, addReliableCommand: unavailable, toggleConsole: unavailable,
    updateScreen: unavailable, consoleScroll: unavailable, readConsoleWidth: () => 78,
    clipboard: { kind: "native-unix-unavailable" },
  };
  const keys = new ClientKeys({ cvars, commands, print, host });
  keys.initializeCommands(); keys.initializeConsoleFields(78);
  cvars.set("in_joystick", joystick ? "1" : "0");
  const systemInput = new SourceInputState({ cvars, print });
  let window: SdlWindow;
  try {
    systemInput.initialize();
    beforeWindow?.(systemInput, unix);
    window = SdlWindow.open({ title: "Q3 SDL gameplay input", width: 64, height: 64, backend: "cpu", hidden: !visible });
  } catch (error) { systemInput.close(); unix.close(); stdin.destroy(); throw error; }
  let input: SdlGameInput;
  try { input = SdlGameInput.open({ window, unix, cvars, keys, clock, print, source: systemInput }); }
  catch (error) { window.close(); systemInput.close(); unix.close(); stdin.destroy(); throw error; }
  cvars.set("in_subframe", "0");
  window.pollEvents();
  const source = new GraphicalEventSource(unix, input), common = new CommonEvents(source, print);
  return { window, cvars, commands, keys, unix, input, source, common, prints, wall, clock, stdin, systemInput,
    close: (): void => { try { input.close(); } finally { window.close(); systemInput.close(); unix.close(); stdin.destroy(); } },
  };
}

function drain(unix: UnixIo): CommonSystemEvent[] {
  const result: CommonSystemEvent[] = [];
  let event = unix.takeQueuedEvent();
  while (event !== null) { result.push(event); event = unix.takeQueuedEvent(); }
  return result;
}

function key(window: SdlWindow, keycode: number, down: boolean, repeat = false, modifiers = 0): void {
  window.pushEvent({ kind: "key", timestamp: window.ticks, scancode: 4, keycode, down, repeat, modifiers });
}

describe("SDL source gameplay input", () => {
  test("maps source layout keys, shifted number aliases, keypad and modifiers", () => {
    expect(sdlGameKey(65)).toBe(97); expect(sdlGameKey(1)).toBe(97);
    expect(sdlGameKey(8)).toBe(KeyCode.Backspace); expect(sdlGameKey(127)).toBe(KeyCode.Delete);
    expect(sdlGameKey(178)).toBe(126); expect(sdlGameKey(0x40000000 | 85)).toBe(42);
    expect(sdlGameKey(0x40000000 | 89)).toBe(KeyCode.KeypadEnd);
    expect(sdlGameKey(0x40000000 | 224)).toBe(KeyCode.Control);
    expect(sdlGameKey(0x40000000 | 227)).toBe(KeyCode.Alt);
    expect(sdlGameKey(0x40000000 | 69)).toBe(KeyCode.F12);
    expect(sdlGameKey(0x40000000 | 104)).toBe(0);
    expect(sdlGameKey(0x20ac)).toBe(0);
    for (const [symbol, digit] of [[33, 49], [64, 50], [35, 51], [36, 52], [37, 53], [94, 54], [38, 55], [42, 56], [40, 57], [41, 48]]) {
      if (symbol === undefined || digit === undefined) throw new Error("Malformed expected mapping");
      expect(sdlGameKey(symbol)).toBe(digit);
    }
  });

  test("converts real SDL age to shared signed time with exact 30 ms limit and wrap", () => {
    expect(sdlEventTime(970, 1000, 230, true)).toBe(200);
    expect(sdlEventTime(969, 1000, 230, true)).toBe(230);
    expect(sdlEventTime(1001, 1000, 230, true)).toBe(230);
    expect(sdlEventTime(970, 1000, 230, false)).toBe(230);
    expect(sdlEventTime(0xfffffff8, 7, 100, true)).toBe(85);
    expect(sdlEventTime(95, 100, -2147483646, true)).toBe(2147483645);
  });

  test("pushed keys and adjacent decoded text bind actual Shift and Latin-1 layout symbols", async () => {
    const f = fixture();
    try {
      const cases: readonly (readonly [number, number, string, number])[] = [
        [59, 1, ":", 58], [39, 1, '"', 34], [91, 1, "{", 123], [93, 1, "}", 125],
        [92, 1, "|", 124], [45, 1, "_", 95], [61, 1, "+", 43], [49, 1, "!", 49],
        [50, 0, "é", 233], [55, 0, "è", 232], [49, 0, "&", 55], [97, 0x2000, "A", 97],
      ];
      for (const [symbol, modifiers, text, binding] of cases) {
        f.keys.setBinding(binding, "+forward");
        key(f.window, symbol, true, false, modifiers);
        for (const event of f.window.pollEvents()) f.input.handleEvent(event);
        // sdl2-compat cannot safely SDL_PushEvent text. Its decoded channel is explicit.
        f.input.handleEvent({ kind: "text", timestamp: f.window.ticks, text });
        key(f.window, symbol, false); f.input.sendKeyEvents();
        const events = drain(f.unix);
        expect(events).toEqual([
          { kind: "key", time: 100, key: binding, down: true },
          { kind: "character", time: 100, character: text.charCodeAt(0) },
          { kind: "key", time: 100, key: binding, down: false },
        ]);
        for (const event of events) if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
        expect(f.keys.isDown(binding)).toBe(false);
      }
      expect(f.commands.pendingText).toBe(cases.map(([, , , binding]) => `+forward ${binding} 100\n-forward ${binding} 100\n`).join(""));
      expect(f.keys.inputState.anyKeyDown).toBe(0);
    } finally { f.close(); }
  });

  test("layout text reaches UI only through source K_CHAR_FLAG and retains repeat binding identity", async () => {
    const calls: (readonly [number, boolean])[] = [];
    const f = fixture(false, false, { keyEvent: async (code, down) => { calls.push([code, down]); },
      setActiveMenu: async () => { throw new Error("Unexpected menu activation"); } });
    try {
      f.keys.setCatcher(KeyCatcher.Ui);
      for (const repeat of [false, true]) {
        key(f.window, 91, true, repeat, repeat ? 0 : 1);
        for (const event of f.window.pollEvents()) f.input.handleEvent(event);
        f.input.handleEvent({ kind: "text", timestamp: f.window.ticks, text: repeat ? "[" : "{" });
      }
      key(f.window, 91, false); f.input.sendKeyEvents();
      for (const event of drain(f.unix)) {
        if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
        else if (event.kind === "character") await f.keys.charEvent(event.character);
      }
      expect(calls).toEqual([[123, true], [123 | KEY_CHAR_FLAG, true], [123, false],
        [123, true], [91 | KEY_CHAR_FLAG, true], [123, false]]);
      expect(f.keys.inputState.anyKeyDown).toBe(0);
    } finally { f.close(); }
  });

  test("keypad center follows source KP_Begin versus KP_5 and Control bytes survive missing SDL text", () => {
    const f = fixture();
    try {
      // XLookupString reference: NumLock maps KP_5 to byte 53, Ctrl to 29;
      // Shift retains that symbol. Without NumLock it is KP_Begin, with no byte.
      for (const modifiers of [0, 1, 0x1000, 0x1001, 0x1040, 0x1041]) {
        const binding = (modifiers & 0x1000) === 0 ? KeyCode.Keypad5 : (modifiers & 0x40) === 0 ? 53 : 29;
        key(f.window, 0x40000000 | 93, true, false, modifiers);
        key(f.window, 0x40000000 | 93, false); f.input.sendKeyEvents();
        const expected: CommonSystemEvent[] = [{ kind: "key", time: 100, key: binding, down: true }];
        if ((modifiers & 0x1040) === 0x1040) expected.push({ kind: "character", time: 100, character: 29 });
        expected.push({ kind: "key", time: 100, key: binding, down: false });
        expect(drain(f.unix)).toEqual(expected);
      }
      key(f.window, 49, true, false, 0x40); key(f.window, 49, false); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 49, down: true },
        { kind: "character", time: 100, character: 49 }, { kind: "key", time: 100, key: 49, down: false }]);
      key(f.window, 0x40000000 | 85, true, false, 0x40); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 42, down: true }, { kind: "character", time: 100, character: 42 }]);
      key(f.window, 9, true, false, 1); key(f.window, 9, false); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 0, down: false }]);
    } finally { f.close(); }
  });

  test("nonadjacent and multicharacter text cannot rewrite earlier binding events", () => {
    const f = fixture();
    try {
      key(f.window, 91, true, false, 1); f.input.sendKeyEvents();
      f.input.handleEvent({ kind: "text", timestamp: f.window.ticks, text: "{" });
      key(f.window, 91, false); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 91, down: true },
        { kind: "character", time: 100, character: 123 }, { kind: "key", time: 100, key: 91, down: false }]);
      key(f.window, 97, true);
      for (const event of f.window.pollEvents()) f.input.handleEvent(event);
      f.input.handleEvent({ kind: "text", timestamp: f.window.ticks, text: "ab" });
      key(f.window, 97, false); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 97, down: true },
        { kind: "character", time: 100, character: 97 }, { kind: "character", time: 100, character: 98 },
        { kind: "key", time: 100, key: 97, down: false }]);
    } finally { f.close(); }
  });

  test("real safely injected keys cross UnixIo and CommonEvents and produce source bindings", async () => {
    const f = fixture();
    try {
      f.keys.setBinding(97, "+forward");
      key(f.window, 97, true); key(f.window, 97, true, true); key(f.window, 97, false);
      expect(f.common.milliseconds()).toBe(100);
      const first = f.common.getEvent(), second = f.common.getEvent();
      expect(first).toEqual({ kind: "key", time: 100, key: 97, down: true });
      expect(second).toEqual({ kind: "key", time: 100, key: 97, down: false });
      for (const event of [first, second]) if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
      expect(f.commands.pendingText).toBe("+forward 97 100\n-forward 97 100\n");
      expect(f.keys.inputState.anyKeyDown).toBe(0);
      expect(f.common.getEvent().kind).toBe("none");
    } finally { f.close(); }
  });

  test("real repeats expose source release/press pairs with a catcher and controls use characters", () => {
    const f = fixture();
    try {
      f.keys.setCatcher(KeyCatcher.Console);
      key(f.window, 97, true, false, 0xc0); key(f.window, 97, true, true, 0xc0); key(f.window, 97, false);
      f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([
        { kind: "key", time: 100, key: 97, down: true }, { kind: "character", time: 100, character: 1 },
        { kind: "key", time: 100, key: 97, down: false }, { kind: "key", time: 100, key: 97, down: true },
        { kind: "character", time: 100, character: 1 }, { kind: "key", time: 100, key: 97, down: false },
      ]);
      key(f.window, 8, true); key(f.window, 9, true); key(f.window, 13, true); key(f.window, 127, true);
      f.input.sendKeyEvents();
      const controls = drain(f.unix);
      expect(controls.filter(event => event.kind === "character").map(event => event.character)).toEqual([8, 9, 13, 127]);
      expect(controls.slice(-2)).toEqual([{ kind: "key", time: 100, key: KeyCode.Delete, down: true }, { kind: "character", time: 100, character: 127 }]);
    } finally { f.close(); }
  });

  test("source unknown-key downs are omitted but their releases still queue key zero", () => {
    const f = fixture();
    try {
      key(f.window, 0x40000000 | 104, true); key(f.window, 0x40000000 | 104, false);
      f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 0, down: false }]);
      f.keys.setCatcher(KeyCatcher.Console);
      key(f.window, 0x40000000 | 104, true, true); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 0, down: false }]);
    } finally { f.close(); }
  });

  test("logical Ctrl punctuation converts both source binding keys and control characters", () => {
    const f = fixture();
    try {
      const cases: readonly (readonly [number, number, number])[] = [
        [51, 27, 27], [52, 28, 28], [53, 29, 29], [54, 30, 30], [55, 31, 31],
        [56, 127, 127], [91, 27, 27], [92, 28, 28], [93, 29, 29], [47, 31, 31], [104, 104, 8],
      ];
      for (const [symbol, binding, character] of cases) {
        key(f.window, symbol, true, false, 0xc0); f.input.sendKeyEvents();
        expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: binding, down: true }, { kind: "character", time: 100, character }]);
      }
      key(f.window, 50, true, false, 0xc0); key(f.window, 50, false, false, 0xc0); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 0, down: false }]);
      key(f.window, 32, true, false, 0xc0); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: KeyCode.Space, down: true }]);
    } finally { f.close(); }
  });

  test("decoded text and wheel preserve byte channels, report Unicode and never use SDL_PushEvent", async () => {
    const f = fixture();
    try {
      f.keys.setCatcher(KeyCatcher.Console);
      f.input.handleEvent({ kind: "text", timestamp: 0, text: "Aé\t\r漢" });
      const events = drain(f.unix);
      expect(events).toEqual([{ kind: "character", time: 100, character: 65 }, { kind: "character", time: 100, character: 233 }]);
      for (const event of events) if (event.kind === "character") await f.keys.charEvent(event.character);
      expect(f.keys.consoleField.text).toBe("Aé");
      expect(f.prints.at(-1)).toContain("U+6F22");
      f.input.handleEvent({ kind: "mouse-wheel", timestamp: 0, x: 0, y: -2, preciseX: 0, preciseY: -2, flipped: true });
      expect(drain(f.unix)).toEqual([
        { kind: "key", time: 100, key: KeyCode.MouseWheelUp, down: true }, { kind: "key", time: 100, key: KeyCode.MouseWheelUp, down: false },
        { kind: "key", time: 100, key: KeyCode.MouseWheelUp, down: true }, { kind: "key", time: 100, key: KeyCode.MouseWheelUp, down: false },
      ]);
    } finally { f.close(); }
  });

  test("decoded repeat text is suppressed in gameplay and unrelated normal text resumes", () => {
    const f = fixture();
    try {
      key(f.window, 97, true, true); f.input.sendKeyEvents();
      f.input.handleEvent({ kind: "text", timestamp: 0, text: "a" }); expect(drain(f.unix)).toEqual([]);
      key(f.window, 98, true); f.input.sendKeyEvents(); f.input.handleEvent({ kind: "text", timestamp: 0, text: "b" });
      expect(drain(f.unix)).toEqual([{ kind: "key", time: 100, key: 98, down: true }, { kind: "character", time: 100, character: 98 }]);
    } finally { f.close(); }
  });

  test("queued fast path precedes native polling; SDL keys precede console and source none time", () => {
    const f = fixture();
    try {
      f.unix.initializeConsole(f.cvars); f.stdin.write("echo stdin\n");
      f.unix.queueEvent({ kind: "console", time: 20, text: "older" }); key(f.window, 97, true);
      expect(f.source.getEvent()).toEqual({ kind: "console", time: 20, text: "older" });
      expect(f.source.getEvent()).toEqual({ kind: "key", time: 100, key: 97, down: true });
      expect(f.source.getEvent()).toEqual({ kind: "console", time: 100, text: "echo stdin" });
      expect(f.source.getEvent()).toEqual({ kind: "none", time: 100 });
    } finally { f.close(); }
  });

  test("real mouse buttons map SDL middle/right/side buttons to source binding keys", () => {
    const f = fixture();
    try {
      for (let button = 1; button <= 5; button++) f.window.pushEvent({ kind: "mouse-button", timestamp: f.window.ticks, button, down: true, clicks: 1, x: 1, y: 2 });
      f.input.sendKeyEvents();
      expect(drain(f.unix).filter(event => event.kind === "key").map(event => event.key)).toEqual([
        KeyCode.Mouse1, KeyCode.Mouse3, KeyCode.Mouse2, KeyCode.Mouse4, KeyCode.Mouse5,
      ]);
    } finally { f.close(); }
  });

  test("actual localhost packets follow SDL keys and console on the same Unix queue", async () => {
    const f = fixture();
    let sender: UdpTransport | null = null;
    try {
      f.cvars.set("net_ip", "127.0.0.1"); f.cvars.set("net_port", "0");
      await f.unix.initializeNetwork(f.cvars); f.unix.initializeConsole(f.cvars);
      const receiver = f.unix.udp;
      if (receiver === null) throw new Error("Missing actual UDP receiver");
      sender = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
      sender.send(receiver.address, new Uint8Array([1, 3, 7]));
      for (let attempt = 0; attempt < 100 && receiver.statistics.pending === 0; attempt++) await f.unix.yieldToIo();
      expect(receiver.statistics.pending).toBe(1);
      key(f.window, 97, true); f.stdin.write("packet order\n");
      expect(f.source.getEvent().kind).toBe("key");
      expect(f.source.getEvent()).toEqual({ kind: "console", time: 100, text: "packet order" });
      expect(f.source.getEvent()).toEqual({ kind: "packet", time: 100, from: sender.address, payload: new Uint8Array([1, 3, 7]) });
      expect(f.source.getEvent().kind).toBe("none");
    } finally { sender?.close(); f.close(); }
  });

  test("global input lease is exclusive and survives closing unrelated windows", () => {
    const f = fixture(), other = SdlWindow.open({ title: "unrelated", width: 2, height: 2, backend: "cpu", hidden: true });
    try {
      expect(() => other.beginInput()).toThrow("already has an owner");
      expect(() => f.window.beginInput()).toThrow("already has an owner");
      other.close(); f.input.frame();
      f.input.close(); f.input.close();
      expect(() => f.input.sendKeyEvents()).toThrow("closed");
      expect(() => f.input.frame()).toThrow("closed");
      const old = f.window.beginInput(); old.close();
      const current = f.window.beginInput(); old.close();
      expect(current.closed).toBe(false);
      expect(() => old.setRelativeMouse(false)).toThrow("closed");
      current.close(); current.close();
    } finally { other.close(); f.close(); }
  });

  test("source initialization owns no window lease and attachment does not repeat initialization", () => {
    const f = fixture();
    const failed = new SourceInputState({ cvars: f.cvars, print: () => { throw new Error("print startup failed"); } });
    try {
      f.input.close();
      expect(() => failed.initialize()).toThrow("print startup failed");
      f.cvars.set("in_joystick", "0.75"); f.cvars.set("in_mouse", "0");
      const second = SdlGameInput.open({ window: f.window, unix: f.unix, cvars: f.cvars, keys: f.keys, clock: f.clock,
        source: f.systemInput, print: () => { throw new Error("attachment repeated source initialization"); } });
      expect(f.cvars.get("in_joystick")?.latchedValue).toBe("0.75");
      expect(f.systemInput.mouse.available).toBe(true);
      f.window.close(); second.close(); second.close();
      expect(f.systemInput.mouse.available).toBe(true);
      f.systemInput.restart();
      expect(f.systemInput.mouse.available).toBe(false);
      expect(f.cvars.get("in_joystick")?.value).toBe("0.75");
    } finally { failed.close(); f.close(); }
  });

  test("source input initializes and restarts before a window without acquiring SDL resources", () => {
    const cvars = new CvarRegistry(), prints: string[] = [], events: (readonly [number, boolean, number])[] = [];
    const input = new SourceInputState({ cvars, print: text => { prints.push(text); } });
    try {
      expect(cvars.get("in_mouse")).toBeUndefined(); expect(prints).toEqual([]);
      input.joystickFrame((key, down, time) => { events.push([key, down, time]); });
      expect(events).toEqual([]);
      input.initialize();
      expect(input.mouse.available).toBe(true);
      expect(cvars.get("in_mouse")?.flags).toBe(CvarFlag.Archive);
      expect(cvars.get("in_joystick")?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
      expect(cvars.get("in_debugjoystick")?.flags).toBe(CvarFlag.Temporary);
      cvars.set("in_mouse", "0"); cvars.set("in_joystick", "0.75");
      expect(input.mouse.available).toBe(true);
      expect(cvars.get("in_joystick")?.value).toBe("0");
      expect(cvars.get("in_joystick")?.latchedValue).toBe("0.75");
      input.restart();
      expect(input.mouse.available).toBe(false);
      expect(cvars.get("in_joystick")?.value).toBe("0.75");
      expect(cvars.get("in_joystick")?.latchedValue).toBeUndefined();
      cvars.set("in_mouse", "0.5"); input.restart();
      expect(input.mouse.available).toBe(true);
      expect(prints).toEqual(Array.from({ length: 3 }, () => ["\n------- Input Initialization -------\n",
        "Joystick is not active.\n", "------------------------------------\n"]).flat());
      input.close(); input.close();
      expect(() => input.restart()).toThrow("closed");
      expect(() => input.initialize()).toThrow("closed");
    } finally { input.close(); }
  });

  test("source restart applies the joystick latch at discovery and leaves earlier input state on failure", () => {
    // Observe discovery selection without opening a physical joystick.
    const discover = spyOn(SdlJoystick, "openFirst").mockImplementation(() => null);
    const cvars = new CvarRegistry(), prints: string[] = [];
    const input = new SourceInputState({ cvars, print: text => { prints.push(text); } });
    const register = cvars.register.bind(cvars);
    const registrations: string[] = [];
    const observe = spyOn(cvars, "register").mockImplementation((...args) => {
      registrations.push(args[0]); return register(...args);
    });
    try {
      input.initialize();
      cvars.set("in_joystick", "1");
      input.joystickFrame(() => { throw new Error("No device is attached"); });
      expect(discover).not.toHaveBeenCalled();
      registrations.length = 0; input.restart();
      expect(registrations).toEqual(["in_mouse", "in_dgamouse", "in_subframe", "in_nograb", "in_joystick", "in_debugjoystick", "joy_threshold"]);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(cvars.get("in_joystick")?.value).toBe("1");
      expect(cvars.get("in_joystick")?.latchedValue).toBeUndefined();
      expect(prints.at(-2)).toBe("No joystick found.\n");
      cvars.set("in_joystick", "0");
      observe.mockImplementation((...args) => {
        const value = register(...args);
        if (args[0] === "in_debugjoystick") throw new Error("reached input registration failure");
        return value;
      });
      expect(() => input.restart()).toThrow("reached input registration failure");
      expect(input.mouse.available).toBe(false);
      expect(cvars.get("in_joystick")?.value).toBe("0");
      expect(cvars.get("in_joystick")?.latchedValue).toBeUndefined();
      expect(discover).toHaveBeenCalledTimes(1);
      observe.mockRestore(); input.restart();
      expect(input.mouse.available).toBe(true); expect(discover).toHaveBeenCalledTimes(1);
      expect(prints.at(-2)).toBe("Joystick is not active.\n");
    } finally { observe.mockRestore(); discover.mockRestore(); input.close(); }
  });

  test("source restart preserves held bindings, pending layout text, queued events and the actual SDL lease", async () => {
    const f = fixture();
    try {
      f.keys.setBinding(97, "+forward"); f.keys.setBinding(123, "+attack");
      key(f.window, 97, true); f.input.sendKeyEvents();
      for (const event of drain(f.unix)) if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
      expect(f.keys.isDown(97)).toBe(true);
      f.unix.queueEvent({ kind: "console", time: 20, text: "older" });
      f.input.handleEvent({ kind: "key", timestamp: f.window.ticks, scancode: 5, keycode: 91, down: true, repeat: false, modifiers: 1 });
      f.systemInput.restart();
      expect(f.keys.isDown(97)).toBe(true);
      expect(() => f.window.beginInput()).toThrow("already has an owner");
      f.input.handleEvent({ kind: "text", timestamp: f.window.ticks, text: "{" });
      f.systemInput.restart();
      key(f.window, 97, false);
      f.window.pushEvent({ kind: "key", timestamp: f.window.ticks, scancode: 5, keycode: 91, down: false, repeat: false, modifiers: 0 });
      f.input.sendKeyEvents();
      const events = drain(f.unix);
      expect(events).toEqual([
        { kind: "console", time: 20, text: "older" },
        { kind: "key", time: 100, key: 123, down: true }, { kind: "character", time: 100, character: 123 },
        { kind: "key", time: 100, key: 97, down: false }, { kind: "key", time: 100, key: 123, down: false },
      ]);
      for (const event of events) if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
      expect(f.keys.inputState.anyKeyDown).toBe(0);
      expect(f.commands.pendingText).toBe("+forward 97 100\n+attack 123 100\n-forward 97 100\n-attack 123 100\n");
      key(f.window, 97, true, true); f.input.sendKeyEvents();
      f.systemInput.restart(); f.input.handleEvent({ kind: "text", timestamp: f.window.ticks, text: "a" });
      expect(drain(f.unix)).toEqual([]);
    } finally { f.close(); }
  });

  test("focus loss releases shared joystick keys emitted before the first window and across window replacement", async () => {
    const f = fixture(false, false, null, (source, unix) => {
      const queueKey = (key: number, down: boolean, time: number): undefined => { unix.queueEvent({ kind: "key", key, down, time }); };
      source.joystickState.button(0, true, queueKey);
      source.joystickState.axis(0, -32768); source.joystickState.frame(0.15, queueKey);
    });
    let replacement: SdlGameInput | null = null;
    let replacementWindow: SdlWindow | null = null;
    const queueKey = (key: number, down: boolean, time: number): undefined => { f.unix.queueEvent({ kind: "key", key, down, time }); };
    const dispatch = async (): Promise<void> => {
      for (const event of drain(f.unix)) if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
    };
    try {
      await dispatch();
      expect(f.keys.isDown(KeyCode.Joy1)).toBe(true); expect(f.keys.isDown(KeyCode.Left)).toBe(true);
      f.input.handleEvent({ kind: "window", timestamp: f.window.ticks, event: 13, data1: 0, data2: 0 });
      await dispatch();
      expect(f.keys.isDown(KeyCode.Joy1)).toBe(false); expect(f.keys.isDown(KeyCode.Left)).toBe(false);
      f.systemInput.joystickState.axis(0, 0); f.systemInput.joystickState.frame(0.15, queueKey);
      await dispatch(); expect(f.keys.inputState.anyKeyDown).toBe(0);

      f.systemInput.joystickState.button(0, true, queueKey);
      f.systemInput.joystickState.axis(0, -32768); f.systemInput.joystickState.frame(0.15, queueKey);
      await dispatch();
      f.systemInput.restart();
      expect(drain(f.unix)).toEqual([]);
      f.input.close(); f.window.close();
      replacementWindow = SdlWindow.open({ title: "replacement input window", width: 64, height: 64, backend: "cpu", hidden: true });
      replacement = SdlGameInput.open({ window: replacementWindow, unix: f.unix, cvars: f.cvars, keys: f.keys, clock: f.clock,
        print: () => undefined, source: f.systemInput });
      expect(f.keys.isDown(KeyCode.Joy1)).toBe(true); expect(f.keys.isDown(KeyCode.Left)).toBe(true);
      key(replacementWindow, 0x40000000 | 80, true); replacement.sendKeyEvents();
      await dispatch();
      replacement.handleEvent({ kind: "window", timestamp: replacementWindow.ticks, event: 13, data1: 0, data2: 0 });
      const released = drain(f.unix);
      expect(released.filter(event => event.kind === "key")).toEqual([
        { kind: "key", time: 100, key: KeyCode.Joy1, down: false },
        { kind: "key", time: 100, key: KeyCode.Left, down: false },
      ]);
      for (const event of released) if (event.kind === "key") await f.keys.keyEvent(event.key, event.down, event.time >>> 0);
      f.systemInput.joystickState.axis(0, 0); f.systemInput.joystickState.frame(0.15, queueKey);
      await dispatch(); expect(f.keys.inputState.anyKeyDown).toBe(0);
    } finally { replacement?.close(); replacementWindow?.close(); f.close(); }
  });

  test("real close event queues one quit after releasing held keys", () => {
    const f = fixture();
    try {
      key(f.window, 97, true);
      f.window.pushEvent({ kind: "window", timestamp: f.window.ticks, event: 14, data1: 0, data2: 0 });
      f.window.pushEvent({ kind: "quit", timestamp: f.window.ticks }); f.input.sendKeyEvents();
      expect(drain(f.unix)).toEqual([
        { kind: "key", time: 100, key: 97, down: true }, { kind: "key", time: 100, key: 97, down: false },
        { kind: "console", time: 100, text: "quit" },
      ]);
    } finally { f.close(); }
  });

  test("native joystick discovery has an explicit absent-device result and cvar source flags", () => {
    const f = fixture(false, true);
    try {
      expect(f.prints.some(text => text === "No joystick found.\n" || text.startsWith("Joystick SDL instance"))).toBe(true);
      expect(f.cvars.get("in_joystick")?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
      expect(f.cvars.get("in_debugjoystick")?.flags).toBe(CvarFlag.Temporary);
      f.input.frame();
    } finally { f.close(); }
  });

  test("disabled joystick returns before threshold processing", () => {
    const f = fixture();
    try { f.cvars.set("joy_threshold", "-1"); f.input.frame(); expect(drain(f.unix)).toEqual([]); }
    finally { f.close(); }
  });

  test("pure joystick thresholds retain signed axis, float32 boundary and bit 31 behavior", () => {
    expect(sdlJoystickAxes(new Int16Array([-32768, 32767, 0]), 0.15)).toBe(9);
    expect(sdlJoystickAxes(new Int16Array([4915]), Math.fround(0.15))).toBe(0);
    expect(sdlJoystickAxes(new Int16Array([4916]), Math.fround(0.15))).toBe(2);
    const axes = new Int16Array(16); axes[15] = 32767;
    expect(sdlJoystickAxes(axes, 0.15)).toBe(-2147483648);
  });

  test.skipIf(process.env["QUAKE_SDL_INPUT_TEST"] !== "1")("actual focused display captures, gates motion at 50ms, releases console and respects nograb", async () => {
    const f = fixture(true);
    try {
      for (let attempt = 0; attempt < 100 && (f.window.flags & 0x200) === 0; attempt++) { f.window.pollEvents(); await Bun.sleep(10); }
      expect(f.window.flags & 0x200).not.toBe(0);
      f.input.frame(); expect(f.window.relativeMouse).toBe(true);
      for (const elapsed of [50, 51]) {
        f.wall.now = 1000100 + elapsed;
        f.window.pushEvent({ kind: "mouse-motion", timestamp: f.window.ticks, buttons: 0, x: 30, y: 30, dx: 3, dy: -1 });
        f.input.sendKeyEvents();
        expect(drain(f.unix).filter(event => event.kind === "mouse")).toEqual(elapsed === 50 ? [] : [{ kind: "mouse", time: 151, dx: 6, dy: -1 }]);
      }
      f.keys.setCatcher(KeyCatcher.Console); f.input.frame(); expect(f.window.relativeMouse).toBe(false);
      f.keys.setCatcher(KeyCatcher.Ui); f.input.frame(); expect(f.window.relativeMouse).toBe(true);
      f.cvars.set("in_nograb", "1"); f.input.frame(); expect(f.window.relativeMouse).toBe(false);
      expect(f.cvars.get("in_dgamouse")?.value).toBe("0");
      f.cvars.set("in_nograb", "0"); f.input.frame(); expect(f.window.relativeMouse).toBe(true);
      key(f.window, 97, true); f.input.sendKeyEvents(); drain(f.unix);
      const other = SdlWindow.open({ title: "native focus destination", width: 64, height: 64, backend: "cpu" });
      try {
        for (let attempt = 0; attempt < 100 && (f.window.flags & 0x200) !== 0; attempt++) { f.input.sendKeyEvents(); await Bun.sleep(10); }
        expect(f.window.flags & 0x200).toBe(0);
        f.input.sendKeyEvents();
        expect(f.window.relativeMouse).toBe(false);
        expect(drain(f.unix)).toContainEqual({ kind: "key", time: 151, key: 97, down: false });
      } finally { other.close(); }
      f.input.close(); expect(f.window.relativeMouse).toBe(false);
    } finally { f.close(); }
  });

  test.skipIf(process.env["QUAKE_SDL_INPUT_TEST"] !== "1")("actual source restart preserves active mouse capture and samples inactive availability only on restart", async () => {
    const f = fixture(true);
    try {
      for (let attempt = 0; attempt < 100 && (f.window.flags & 0x200) === 0; attempt++) { f.window.pollEvents(); await Bun.sleep(10); }
      expect(f.window.flags & 0x200).not.toBe(0);
      f.input.frame(); expect(f.window.relativeMouse).toBe(true);
      f.wall.now += 51; f.systemInput.restart();
      f.window.pushEvent({ kind: "mouse-motion", timestamp: f.window.ticks, buttons: 0, x: 30, y: 30, dx: 3, dy: -1 });
      f.input.sendKeyEvents();
      expect(drain(f.unix).filter(event => event.kind === "mouse")).toEqual([{ kind: "mouse", time: 151, dx: 6, dy: -1 }]);
      f.cvars.set("in_mouse", "0"); f.systemInput.restart(); f.input.frame();
      expect(f.window.relativeMouse).toBe(true);
      f.keys.setCatcher(KeyCatcher.Console); f.input.frame(); expect(f.window.relativeMouse).toBe(true);
      f.cvars.set("in_mouse", "1"); f.systemInput.restart(); f.input.frame();
      expect(f.window.relativeMouse).toBe(false);
      f.keys.setCatcher(KeyCatcher.Ui);
      f.cvars.set("in_mouse", "0"); f.systemInput.restart(); f.input.frame();
      expect(f.window.relativeMouse).toBe(false);
      f.cvars.set("in_mouse", "0.5"); f.input.frame(); expect(f.window.relativeMouse).toBe(false);
      f.systemInput.restart(); f.input.frame(); expect(f.window.relativeMouse).toBe(true);
    } finally { f.close(); }
  });
});
