// Port of unix/linux_glimp.c IN_Init/Shutdown and unix/linux_joystick.c.
// Sys_In_Restart_f is from unix/unix_main.c.
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

  button(button: number, down: boolean, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    if (!Number.isInteger(button) || button < 0 || button > 255) throw new RangeError("Joystick button requires an unsigned byte");
    const key = KeyCode.Joy1 + button;
    queueKey(key, down, 0);
    if (down) this.heldButtons.add(key); else this.heldButtons.delete(key);
  }

  axis(axis: number, value: number): void {
    if (axis < 16) this.axes[axis] = value;
  }

  frame(threshold: number | null, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    const axes = threshold === null ? 0 : sdlJoystickAxes(this.axes, threshold);
    for (const [bit, key] of joystickKeys.entries()) {
      const mask = 1 << bit;
      if ((axes & mask) !== (this.oldAxes & mask)) queueKey(key, (axes & mask) !== 0, 0);
    }
    this.oldAxes = axes;
  }

  removeDevice(queueKey: (key: number, down: boolean, time: number) => undefined): void {
    for (const key of this.heldButtons) queueKey(key, false, 0);
    this.heldButtons.clear(); this.axes.fill(0);
  }

  release(time: number, queueKey: (key: number, down: boolean, time: number) => undefined): void {
    const held = new Set(this.heldButtons);
    for (const [bit, key] of joystickKeys.entries()) if ((this.oldAxes & (1 << bit)) !== 0) held.add(key);
    for (const key of held) queueKey(key, false, time);
    this.clear();
  }

  clear(): void {
    this.heldButtons.clear(); this.axes.fill(0); this.oldAxes = 0;
  }
}

/** Client-build input survives window replacement and starts at Sys_Init, before Netchan_Init. */
export class SourceInputState {
  readonly mouse = { available: false, active: false, resetTime: 0 };
  readonly joystickState = new SourceJoystickState();
  private closed = false;
  private joystick: SdlJoystick | null = null;
  private joystickEvents: SdlJoystickEvent[] = [];

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
    this.mouse.available = this.cvar("in_mouse").numericValue !== 0;

    // The source abandons the old descriptor but retains IN_JoyMove's static axis state.
    const previous = this.joystick;
    this.joystick = null;
    this.joystickEvents = [];
    previous?.close();
    if (this.cvar("in_joystick").integerValue !== 0) {
      const joystick = SdlJoystick.openFirst(print);
      this.joystick = joystick;
      print(joystick === null ? "No joystick found.\n" : `Joystick SDL instance ${joystick.instance} found\nName:    ${joystick.name}\nAxes:    ${joystick.axes}\nButtons: ${joystick.buttons}\n`);
      // Discard only joystick initialization records, even before a window exists.
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
  joystickFrame(queueKey: (key: number, down: boolean, time: number) => undefined): void {
    this.requireOpen();
    if (this.joystick === null) return;
    const events = [...this.joystickEvents, ...this.joystick.pollEvents()];
    this.joystickEvents = [];
    for (const event of events) {
      if (this.joystick === null) break;
      switch (event.kind) {
        case "joystick-button":
          this.joystickState.button(event.button, event.down, queueKey);
          break;
        case "joystick-axis":
          this.joystickState.axis(event.axis, event.value);
          break;
        case "joystick-removed":
          this.options.print("SDL joystick disconnected.\n");
          this.joystick?.close(); this.joystick = null;
          this.joystickState.removeDevice(queueKey);
          break;
      }
    }
    this.joystickState.frame(this.joystick === null ? null : this.cvar("joy_threshold").numericValue, queueKey);
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
