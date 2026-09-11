// Windows IN_JoyMove and macOS display selection through the SDL replacement.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, spyOn, test } from "bun:test";
import { endianness } from "node:os";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import type { CommonSystemEvent } from "../src/engine/common-events.ts";
import { decodeSdlEvent, sdlDisplayIndex, sdlMatchingDisplayMode, SdlWindow } from "../src/platform/sdl.ts";
import type { SdlDisplayMode, SdlEvent, SdlInputLease, SdlJoystickEvent } from "../src/platform/sdl.ts";
import { SdlGameInput } from "../src/platform/sdl-game-input.ts";
import { SourceInputState, windowsJoystickDebug } from "../src/platform/source-input.ts";

function stateFixture() {
  const cvars = new CvarRegistry();
  const source = new SourceInputState({ cvars, print: () => undefined });
  const keys: { readonly key: number; readonly down: boolean; readonly time: number }[] = [];
  const mouse: { readonly dx: number; readonly dy: number; readonly time: number }[] = [];
  const queueKey = (key: number, down: boolean, time: number): undefined => { keys.push({ key, down, time }); };
  const queueMouse = (dx: number, dy: number, time: number): undefined => { mouse.push({ dx, dy, time }); };
  return { cvars, source, state: source.joystickState, keys, mouse, queueKey, queueMouse };
}

test("Windows debug row preserves source field order, widths, buttons, POV and unscaled axes", () => {
  const axes: SdlJoystickEvent[] = [-32768, 32767, -16384, 8192, 123, -456].map((value, axis) =>
    ({ kind: "joystick-axis", timestamp: 0, instance: 1, axis, value }));
  expect(windowsJoystickDebug([...axes,
    { kind: "joystick-button", timestamp: 0, instance: 1, button: 0, down: true },
    { kind: "joystick-button", timestamp: 0, instance: 1, button: 31, down: true },
    { kind: "joystick-hat", timestamp: 0, instance: 1, hat: 0, value: 3 },
  ])).toBe("80000001  4500 -1.00  1.00 -0.50  0.25    123   -456\n");
  for (const [value, pov] of [[0, 65535], [1, 0], [3, 4500], [2, 9000], [6, 13500],
    [4, 18000], [12, 22500], [8, 27000], [9, 31500]] satisfies readonly (readonly [number, number])[]) {
    expect(windowsJoystickDebug([{ kind: "joystick-hat", timestamp: 0, instance: 1, hat: 0, value }]))
      .toBe(`       0 ${String(pov).padStart(5)}  0.00  0.00  0.00  0.00      0      0\n`);
  }
});

test("joystick diagnostics remain silent without an active device", () => {
  const cvars = new CvarRegistry(), output: string[] = [];
  const source = new SourceInputState({ cvars, print: text => { output.push(text); } });
  cvars.set("in_joystickProfile", "windows");
  source.initialize(); output.length = 0;
  source.joystickFrame(() => undefined, () => undefined);
  expect(output).toEqual([]);
  cvars.set("in_debugjoystick", "1");
  source.joystickFrame(() => undefined, () => undefined);
  expect(output).toEqual([]);
  source.close();
});

test("Windows JoyToF uses /32768 and maps only X/Y/Z/R direction pairs", () => {
  const f = stateFixture();
  f.state.axis(0, 32767);
  f.state.windowsFrame(32767 / 32768, 6, 0.02, f.queueKey, f.queueMouse);
  expect(f.keys).toEqual([]);
  f.state.frame(32767 / 32768, f.queueKey);
  expect(f.keys).toEqual([{ key: KeyCode.Right, down: true, time: 0 }]);
  f.keys.length = 0; f.state.clear();
  for (const [index, value] of [-32768, 32767, -32768, 32767, -32768, 32767].entries()) f.state.axis(index, value);
  f.state.windowsFrame(0.15, 6, 0.02, f.queueKey, f.queueMouse);
  expect(f.keys).toEqual([KeyCode.Left, KeyCode.Down, KeyCode.Joy16, KeyCode.Joy19].map(key => ({ key, down: true, time: 0 })));
  expect(f.mouse).toEqual([{ dx: -655, dy: 655, time: 0 }]);
  f.state.windowsFrame(0.15, 6, 0.02, f.queueKey, f.queueMouse);
  expect(f.keys).toHaveLength(4);
  expect(f.mouse).toHaveLength(2);
  f.source.close();
});

test("Windows cardinal POV maps bits 12..15 while diagonals and extra hats stay neutral", () => {
  const f = stateFixture();
  for (const [hat, key] of [[1, KeyCode.Joy24], [4, KeyCode.Joy25], [2, KeyCode.Joy26], [8, KeyCode.Joy27]] satisfies readonly (readonly [number, number])[]) {
    f.state.pov(0, hat); f.state.windowsFrame(0.15, 2, 0.02, f.queueKey, f.queueMouse);
    f.state.pov(0, 0); f.state.windowsFrame(0.15, 2, 0.02, f.queueKey, f.queueMouse);
    expect(f.keys.splice(0)).toEqual([{ key, down: true, time: 0 }, { key, down: false, time: 0 }]);
  }
  for (const diagonal of [3, 6, 9, 12]) {
    f.state.pov(0, diagonal); f.state.windowsFrame(0.15, 6, 0.02, f.queueKey, f.queueMouse);
  }
  f.state.pov(1, 1); f.state.windowsFrame(0.15, 6, 0.02, f.queueKey, f.queueMouse);
  expect(f.keys).toEqual([]); expect(f.mouse).toEqual([]);
  f.state.pov(0, 1); f.state.windowsFrame(0.15, 6, 0.02, f.queueKey, f.queueMouse);
  f.state.windowsFrame(null, 0, 0.02, f.queueKey, f.queueMouse);
  expect(f.keys).toEqual([{ key: KeyCode.Joy24, down: true, time: 0 }, { key: KeyCode.Joy24, down: false, time: 0 }]);
  f.source.close();
});

test("Windows trackball requires six axes, truncates float products and honors live scale", () => {
  const f = stateFixture();
  f.state.axis(4, 49); f.state.axis(5, -51);
  f.state.windowsFrame(0.15, 5, 0.02, f.queueKey, f.queueMouse);
  expect(f.mouse).toEqual([]);
  f.state.windowsFrame(0.15, 6, 0.02, f.queueKey, f.queueMouse);
  expect(f.mouse).toEqual([{ dx: 0, dy: -1, time: 0 }]);
  f.state.windowsFrame(0.15, 6, 0.5, f.queueKey, f.queueMouse);
  expect(f.mouse[1]).toEqual({ dx: 24, dy: -25, time: 0 });
  f.state.removeDevice(f.queueKey);
  f.state.windowsFrame(null, 0, 0.02, f.queueKey, f.queueMouse);
  expect(f.mouse).toHaveLength(2);
  f.source.close();
});

test("Windows sampled buttons publish transitions while Linux keeps delivered button edges", () => {
  const f = stateFixture();
  f.state.button(0, false, f.queueKey, true);
  f.state.button(0, true, f.queueKey, true);
  f.state.button(0, true, f.queueKey, true);
  f.state.button(0, false, f.queueKey, true);
  f.state.button(0, false, f.queueKey, true);
  expect(f.keys.splice(0)).toEqual([{ key: KeyCode.Joy1, down: true, time: 0 }, { key: KeyCode.Joy1, down: false, time: 0 }]);
  f.state.button(0, true, f.queueKey); f.state.button(0, true, f.queueKey);
  expect(f.keys).toHaveLength(2);
  f.state.pov(0, 1); f.state.frame(0.15, f.queueKey);
  expect(f.keys).toHaveLength(2);
  f.source.close();
});

test("joystick profiles register with a Linux default and apply the Windows latch on restart", () => {
  const f = stateFixture();
  f.source.initialize();
  expect(f.cvars.get("in_joystickProfile")?.value).toBe("linux");
  expect(f.cvars.get("in_joystickProfile")?.flags).toBe(CvarFlag.Archive | CvarFlag.Latch);
  expect(f.cvars.get("in_joyBallScale")?.value).toBe("0.02");
  f.cvars.set("in_joystickProfile", "windows");
  expect(f.cvars.get("in_joystickProfile")?.value).toBe("linux");
  f.source.restart();
  expect(f.cvars.get("in_joystickProfile")?.value).toBe("windows");
  f.cvars.set("in_joystickProfile", "unknown", true);
  expect(() => f.source.restart()).toThrow("in_joystickProfile must be linux or windows");
  f.source.close();
});

function inputFixture() {
  const f = stateFixture(); f.source.initialize();
  f.cvars.register("vid_xpos", "3", CvarFlag.Archive);
  f.cvars.register("vid_ypos", "22", CvarFlag.Archive);
  const native = { flags: 0x200, relativeMouse: false, closed: false };
  const lease: SdlInputLease = { get closed() { return native.closed; },
    setRelativeMouse: enabled => { native.relativeMouse = enabled; }, close: () => { native.closed = true; } };
  const events: CommonSystemEvent[] = [];
  const input = SdlGameInput.open({
    window: { beginInput: () => lease, get closed() { return native.closed; }, ticks: 100,
      get flags() { return native.flags; }, get relativeMouse() { return native.relativeMouse; },
      pollEvents: (): SdlEvent[] => [], positionOrigin: { x: 1920, y: -200 } },
    unix: { queueEvent: event => { events.push(event); } }, cvars: f.cvars,
    keys: { getCatcher: () => 0 }, clock: { milliseconds: () => 100 }, print: () => undefined, source: f.source,
  });
  return { ...f, native, input, events, close: () => { input.close(); f.source.close(); } };
}

test("SDL hat ABI records route through gameplay input into the shared joystick owner", () => {
  const f = inputFixture();
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer), little = endianness() === "LE";
  view.setUint32(0, 0x602, little); view.setUint32(4, 89, little); view.setInt32(8, 1234, little);
  view.setUint8(12, 0); view.setUint8(13, 4);
  const event = decodeSdlEvent(bytes);
  expect(event).toEqual({ kind: "joystick-hat", timestamp: 89, instance: 1234, hat: 0, value: 4 });
  const queued = spyOn(f.source, "queueJoystickEvent").mockImplementation(received => {
    if (received.kind === "joystick-hat") f.state.pov(received.hat, received.value);
  });
  try {
    f.input.handleEvent(event);
    expect(queued).toHaveBeenCalledWith(event);
    f.state.windowsFrame(0.15, 2, 0.02, f.queueKey, f.queueMouse);
    expect(f.keys).toEqual([{ key: KeyCode.Joy25, down: true, time: 0 }]);
  } finally { queued.mockRestore(); f.close(); }
  expect(() => decodeSdlEvent(bytes.subarray(0, 13))).toThrow(RangeError);
});

test("SDL gameplay frame routes Windows U/V output into actual common mouse events", () => {
  const f = inputFixture(); f.state.axis(4, 1000); f.state.axis(5, -2000);
  const frame = spyOn(f.source, "joystickFrame").mockImplementation((queueKey, queueMouse) => {
    if (queueMouse === undefined) throw new Error("Missing mouse queue");
    f.state.windowsFrame(0.15, 6, 0.02, queueKey, queueMouse);
  });
  try {
    f.input.frame();
    expect(f.events).toEqual([{ kind: "mouse", dx: 20, dy: -40, time: 0 }]);
  } finally { frame.mockRestore(); f.close(); }
});

test("SDL moved events persist display-relative window coordinates and ignore fullscreen moves", () => {
  const f = inputFixture();
  try {
    f.input.handleEvent({ kind: "window", timestamp: 100, event: 4, data1: 1940, data2: -170 });
    expect(f.cvars.get("vid_xpos")?.value).toBe("20"); expect(f.cvars.get("vid_ypos")?.value).toBe("30");
    expect(f.cvars.get("vid_xpos")?.modified).toBe(false); expect(f.cvars.get("vid_ypos")?.modified).toBe(false);
    expect(f.cvars.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
    f.native.flags |= 1;
    f.input.handleEvent({ kind: "window", timestamp: 101, event: 4, data1: 1920, data2: -200 });
    expect(f.cvars.get("vid_xpos")?.value).toBe("20"); expect(f.cvars.get("vid_ypos")?.value).toBe("30");
    f.native.flags &= ~1;
    f.input.handleEvent({ kind: "window", timestamp: 102, event: 4, data1: 1800, data2: -230 });
    expect(f.cvars.get("vid_xpos")?.value).toBe("-120"); expect(f.cvars.get("vid_ypos")?.value).toBe("-30");
  } finally { f.close(); }
});

test("display index follows Sys_DisplayToUse primary fallback", () => {
  expect([-10, -1, 0, 1, 2, 3, 100].map(index => sdlDisplayIndex(index, 3))).toEqual([0, 0, 0, 1, 2, 0, 0]);
  expect(() => sdlDisplayIndex(0, 0)).toThrow("no video displays");
  expect(() => sdlDisplayIndex(1.5, 2)).toThrow("signed 32-bit integer");
});

test("source display selector uses exact size and depth, inclusive limits, and the last match", () => {
  const modes: SdlDisplayMode[] = [
    { width: 640, height: 480, colorBits: 24, refreshRate: 0 },
    { width: 640, height: 480, colorBits: 24, refreshRate: 60 },
    { width: 640, height: 480, colorBits: 24, refreshRate: 75 },
    { width: 640, height: 480, colorBits: 24, refreshRate: 85 },
    { width: 800, height: 600, colorBits: 24, refreshRate: 75 },
    { width: 640, height: 480, colorBits: 16, refreshRate: 75 },
  ];
  const request = { width: 640, height: 480, colorBits: 24, minDisplayRefresh: 60, maxDisplayRefresh: 75 };
  expect(sdlMatchingDisplayMode(modes, request)).toBe(2);
  expect(sdlMatchingDisplayMode(modes, { ...request, minDisplayRefresh: 75 })).toBe(2);
  expect(sdlMatchingDisplayMode(modes, { ...request, minDisplayRefresh: 0, maxDisplayRefresh: 0 })).toBe(3);
  expect(sdlMatchingDisplayMode(modes, { ...request, minDisplayRefresh: 0, maxDisplayRefresh: 59 })).toBe(0);
  expect(sdlMatchingDisplayMode(modes, { ...request, width: 1024 })).toBeNull();
  expect(sdlMatchingDisplayMode(modes, { ...request, minDisplayRefresh: 76, maxDisplayRefresh: 80 })).toBeNull();
  expect(() => sdlMatchingDisplayMode(modes, { ...request, minDisplayRefresh: 76 })).toThrow("less than or equal");
});

test("invalid display controls fail before SDL initializes a native device", () => {
  expect(() => SdlWindow.open({ title: "must not open", width: 64, height: 64, backend: "cpu",
    minDisplayRefresh: 80, maxDisplayRefresh: 60 })).toThrow("less than or equal");
  expect(() => SdlWindow.open({ title: "must not open", width: 64, height: 64, backend: "cpu",
    position: { x: NaN, y: 0 } })).toThrow("signed 32-bit integer");
});
