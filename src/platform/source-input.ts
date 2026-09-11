// Port of unix/linux_glimp.c IN_Init/Shutdown and unix/linux_joystick.c.
// Sys_In_Restart_f is from unix/unix_main.c.
// Windows joystick profile: win32/win_input.c JoyToF, JoyToI and IN_JoyMove.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { KeyCode } from "../core/key-codes.ts";
import { SdlJoystick } from "./sdl.ts";
import type { SdlJoystickEvent } from "./sdl.ts";

export interface SourceInputOptions {
  readonly cvars: CvarRegistry;
  readonly print: (text: string) => undefined;
}

export type SourceJoystickProfile = "linux" | "windows";

/** IN_JoyMove's diagnostic row, from the same sample consumed by the frame. */
export function windowsJoystickDebug(events: readonly SdlJoystickEvent[]): string {
  let buttons = 0, pov = 65535;
  const axes = new Int16Array(6);
  for (const event of events) {
    if (event.kind === "joystick-button" && event.button < 32) {
      if (event.down) buttons |= 1 << event.button;
      else buttons &= ~(1 << event.button);
    }
    else if (event.kind === "joystick-axis" && event.axis < 6) axes[event.axis] = event.value;
    else if (event.kind === "joystick-hat" && event.hat === 0) {
      switch (event.value) {
        case 1: pov = 0; break;
        case 3: pov = 4500; break;
        case 2: pov = 9000; break;
        case 6: pov = 13500; break;
        case 4: pov = 18000; break;
        case 12: pov = 22500; break;
        case 8: pov = 27000; break;
        case 9: pov = 31500; break;
        default: pov = 65535;
      }
    }
  }
  const fields = [(buttons >>> 0).toString(16).padStart(8), String(pov).padStart(5)];
  for (const [axis, value] of axes.entries()) {
    fields.push(axis < 4 ? Math.fround(value / 32768).toFixed(2).padStart(5) : String(value).padStart(6));
  }
  return `${fields.join(" ")}\n`;
}

export function sdlJoystickAxes(values: Int16Array, threshold: number): number {
  let axes = 0;
  for (const [index, value] of values.entries()) {
    if (index >= 16) break;
    const fraction = Math.fround(value / 32767);
    if (fraction < -threshold) axes |= 1 << (index * 2);
    else if (fraction > threshold) axes |= 1 << (index * 2 + 1);
  }
  return axes;
}

const joystickKeys: readonly number[] = [KeyCode.Left, KeyCode.Right, KeyCode.Up, KeyCode.Down,
  KeyCode.Joy16, KeyCode.Joy17, KeyCode.Joy18, KeyCode.Joy19,
  KeyCode.Joy20, KeyCode.Joy21, KeyCode.Joy22, KeyCode.Joy23,
  KeyCode.Joy24, KeyCode.Joy25, KeyCode.Joy26, KeyCode.Joy27];

class SourceJoystickState {
  private readonly heldButtons = new Set<number>();
  private readonly axes = new Int16Array(16);
  private oldAxes = 0;
  private hat = 0;

  button(button: number, down: boolean, queueKey: (key: number, down: boolean, time: number) => undefined, transitionsOnly = false): void {
    if (!Number.isInteger(button) || button < 0 || button > 255) throw new RangeError("Joystick button requires an unsigned byte");
    const key = KeyCode.Joy1 + button;
    if (transitionsOnly && this.heldButtons.has(key) === down) return;
    queueKey(key, down, 0);
    if (down) this.heldButtons.add(key); else this.heldButtons.delete(key);
  }

  axis(axis: number, value: number): void {
    if (axis < 16) this.axes[axis] = value;
  }

  pov(hat: number, value: number): void {
    if (hat === 0) this.hat = value;
  }

  frame(threshold: number | null, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    const axes = threshold === null ? 0 : sdlJoystickAxes(this.axes, threshold);
    this.publishAxes(axes, queueKey);
  }

  windowsFrame(threshold: number | null, axisCount: number, ballScale: number,
    queueKey: (key: number, down: boolean, time: number) => undefined,
    queueMouse: (dx: number, dy: number, time: number) => undefined): void {
    let axes = 0;
    if (threshold !== null) {
      for (let index = 0; index < Math.min(axisCount, 4); index++) {
        const value = this.axes[index];
        if (value === undefined) throw new Error("Missing Windows joystick axis");
        const fraction = Math.fround(value / 32768);
        if (fraction < -threshold) axes |= 1 << (index * 2);
        else if (fraction > threshold) axes |= 1 << (index * 2 + 1);
      }
      // SDL hat bits are up/right/down/left; source accepts cardinal POV only.
      if (this.hat === 1) axes |= 1 << 12;
      else if (this.hat === 4) axes |= 1 << 13;
      else if (this.hat === 2) axes |= 1 << 14;
      else if (this.hat === 8) axes |= 1 << 15;
    }
    this.publishAxes(axes, queueKey);
    if (threshold !== null && axisCount >= 6) {
      const u = this.axes[4], v = this.axes[5];
      if (u === undefined || v === undefined) throw new Error("Missing Windows joystick U/V axes");
      const dx = Math.trunc(Math.fround(u * Math.fround(ballScale)));
      const dy = Math.trunc(Math.fround(v * Math.fround(ballScale)));
      if (dx !== 0 || dy !== 0) queueMouse(dx, dy, 0);
    }
  }

  private publishAxes(axes: number, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    for (const [bit, key] of joystickKeys.entries()) {
      const mask = 1 << bit;
      if ((axes & mask) !== (this.oldAxes & mask)) queueKey(key, (axes & mask) !== 0, 0);
    }
    this.oldAxes = axes;
  }

  removeDevice(queueKey: (key: number, down: boolean, time: number) => undefined): void {
    for (const key of this.heldButtons) queueKey(key, false, 0);
    this.heldButtons.clear(); this.axes.fill(0); this.hat = 0;
  }

  release(time: number, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    const held = new Set(this.heldButtons);
    for (const [bit, key] of joystickKeys.entries()) if ((this.oldAxes & (1 << bit)) !== 0) held.add(key);
    for (const key of held) queueKey(key, false, time);
    this.clear();
  }

  clear(): void {
    this.heldButtons.clear(); this.axes.fill(0); this.oldAxes = 0; this.hat = 0;
  }
}

/** Client-build input survives window replacement and starts at Sys_Init, before Netchan_Init. */
export class SourceInputState {
  readonly mouse = { available: false, active: false, resetTime: 0 };
  readonly joystickState = new SourceJoystickState();
  private closed = false;
  private joystick: SdlJoystick | null = null;
  private joystickEvents: SdlJoystickEvent[] = [];
  private joystickProfile: SourceJoystickProfile = "linux";

  /** Inert construction permits the common owner to publish input before initialization prints. */
  constructor(private readonly options: SourceInputOptions) {}

  /** IN_Init registers source cvars, applies the joystick latch and discovers its actual device. */
  initialize(): void {
    this.requireOpen();
    const { cvars, print } = this.options;
    print("\n------- Input Initialization -------\n");
    cvars.register("in_mouse", "1", CvarFlag.Archive);
    cvars.register("in_dgamouse", "1", CvarFlag.Archive);
    cvars.register("in_subframe", "1", CvarFlag.Archive);
    cvars.register("in_nograb", "0");
    cvars.register("in_joystick", "0", CvarFlag.Archive | CvarFlag.Latch);
    cvars.register("in_debugjoystick", "0", CvarFlag.Temporary);
    cvars.register("joy_threshold", "0.15", CvarFlag.Archive);
    const profile = cvars.register("in_joystickProfile", process.platform === "win32" ? "windows" : "linux", CvarFlag.Archive | CvarFlag.Latch).value;
    if (profile !== "linux" && profile !== "windows") throw new Error("in_joystickProfile must be linux or windows");
    this.joystickProfile = profile;
    cvars.register("in_joyBallScale", "0.02", CvarFlag.Archive);
    this.mouse.available = this.cvar("in_mouse").numericValue !== 0;

    // The source abandons the old descriptor but retains IN_JoyMove's static axis state.
    const previous = this.joystick;
    this.joystick = null;
    this.joystickEvents = [];
    previous?.close();
    if (this.cvar("in_joystick").integerValue !== 0) {
      if (this.joystickProfile === "windows") this.joystickState.clear();
      const joystick = SdlJoystick.openFirst(print, this.joystickProfile);
      this.joystick = joystick;
      print(joystick === null ? "No joystick found.\n" : `Joystick SDL instance ${joystick.instance} found\nName:    ${joystick.name}\nAxes:    ${joystick.axes}\nButtons: ${joystick.buttons}\n`);
      // Linux discards JS_EVENT_INIT; Windows samples current values in each frame.
      joystick?.pollEvents();
    } else print("Joystick is not active.\n");
    print("------------------------------------\n");
  }

  /** Sys_In_Restart_f changes availability and device selection without retiring the window. */
  restart(): void {
    this.requireOpen();
    this.mouse.available = false;
    this.initialize();
  }

  queueJoystickEvent(event: SdlJoystickEvent): void {
    this.requireOpen();
    if (this.joystick !== null && event.instance === this.joystick.instance) this.joystickEvents.push(event);
  }

  /** IN_JoyMove runs after console polling, with or without an attached SDL window. */
  joystickFrame(queueKey: (key: number, down: boolean, time: number) => undefined,
    queueMouse?: (dx: number, dy: number, time: number) => undefined): void {
    this.requireOpen();
    if (this.joystick === null) return;
    const events = [...this.joystickEvents, ...this.joystick.pollEvents(this.joystickProfile)];
    this.joystickEvents = [];
    if (this.joystickProfile === "windows" && this.cvar("in_debugjoystick").integerValue !== 0
      && !events.some(event => event.kind === "joystick-removed")) this.options.print(windowsJoystickDebug(events));
    for (const event of events) {
      if (this.joystick === null) break;
      switch (event.kind) {
        case "joystick-button":
          this.joystickState.button(event.button, event.down, queueKey, this.joystickProfile === "windows");
          break;
        case "joystick-axis":
          this.joystickState.axis(event.axis, event.value);
          break;
        case "joystick-hat":
          this.joystickState.pov(event.hat, event.value);
          break;
        case "joystick-removed":
          this.options.print("SDL joystick disconnected.\n");
          this.joystick?.close(); this.joystick = null;
          this.joystickState.removeDevice(queueKey);
          break;
      }
    }
    const threshold = this.joystick === null ? null : this.cvar("joy_threshold").numericValue;
    if (this.joystickProfile === "windows") {
      if (queueMouse === undefined) throw new Error("Windows joystick input requires a mouse event consumer");
      this.joystickState.windowsFrame(threshold, this.joystick?.axes ?? 0, this.cvar("in_joyBallScale").numericValue, queueKey, queueMouse);
    } else this.joystickState.frame(threshold, queueKey);
  }

  /** SDL focus loss releases shared keys before clearing them; source restart never calls this. */
  releaseJoystickState(time: number, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    this.requireOpen();
    this.joystickState.release(time, queueKey);
  }

  private cvar(name: string) {
    const value = this.options.cvars.get(name);
    if (value === undefined) throw new Error(`Input cvar ${name} no longer exists`);
    return value;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Source input is closed");
  }

  /** Final common disposal releases the joystick; ordinary window shutdown does not. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mouse.available = false;
    const joystick = this.joystick;
    this.joystick = null; this.joystickEvents = [];
    this.joystickState.clear();
    joystick?.close();
  }
}
