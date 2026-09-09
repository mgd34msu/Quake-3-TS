// Port of unix/linux_glimp.c XLateKey, HandleEvents and IN_Frame window capture.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
// SDL relative motion replaces X warp/DGA delivery, preserving the source delta gain.
import type { CvarRegistry } from "../core/cvar.ts";
import { KeyCatcher, KeyCode } from "../core/key-codes.ts";
import type { ClientKeys } from "../engine/client-keys.ts";
import type { SdlEvent, SdlInputLease, SdlJoystickEvent, SdlWindow } from "./sdl.ts";
import type { SourceInputState } from "./source-input.ts";
import type { SystemClock } from "./system-clock.ts";
import type { UnixIo } from "./unix-io.ts";
export { sdlJoystickAxes } from "./source-input.ts";

export interface SdlGameInputOptions {
  readonly window: SdlWindow;
  readonly unix: UnixIo;
  readonly cvars: CvarRegistry;
  readonly keys: Pick<ClientKeys, "getCatcher">;
  readonly clock: SystemClock;
  readonly print: (text: string) => undefined;
  readonly source: SourceInputState;
}

const specialKeys = new Map<number, number>([
  [57, 0], [70, 0], [71, 0], [72, KeyCode.Pause],
  [73, KeyCode.Insert], [74, KeyCode.Home], [75, KeyCode.PageUp],
  [77, KeyCode.End], [78, KeyCode.PageDown], [79, KeyCode.Right],
  [80, KeyCode.Left], [81, KeyCode.Down], [82, KeyCode.Up],
  [84, KeyCode.KeypadSlash], [85, 42], [86, KeyCode.KeypadMinus],
  [87, KeyCode.KeypadPlus], [88, KeyCode.KeypadEnter],
  [89, KeyCode.KeypadEnd], [90, KeyCode.KeypadDown], [91, KeyCode.KeypadPageDown],
  [92, KeyCode.KeypadLeft], [93, KeyCode.Keypad5], [94, KeyCode.KeypadRight],
  [95, KeyCode.KeypadHome], [96, KeyCode.KeypadUp], [97, KeyCode.KeypadPageUp],
  [98, KeyCode.KeypadInsert], [99, KeyCode.KeypadDelete], [103, 61],
  [116, KeyCode.Control], [205, KeyCode.Space],
  [224, KeyCode.Control], [225, KeyCode.Shift], [226, KeyCode.Alt], [227, KeyCode.Alt],
  [228, KeyCode.Control], [229, KeyCode.Shift], [230, KeyCode.Alt], [231, KeyCode.Alt],
]);

/** XLookupString's ASCII control conversion, before XLateKey's fallback normalization. */
function controlByte(byte: number): number {
  if ((byte >= 64 && byte < 127) || byte === 32) return byte & 31;
  if (byte === 50) return 0;
  if (byte >= 51 && byte <= 55) return byte - 24;
  if (byte === 56) return 127;
  if (byte === 47) return 31;
  return byte;
}

/** XLateKey's keysym aliases and fallback byte normalization. */
export function sdlGameKey(keycode: number, modifiers = 0): number {
  if ((keycode & 0x40000000) !== 0) {
    const code = keycode & ~0x40000000;
    if (code >= 58 && code <= 69) return KeyCode.F1 + code - 58;
    // XLateKey lists KP_Begin, but KP_5 takes the fallback byte path.
    if (code === 93 && (modifiers & 0x1000) !== 0) return (modifiers & 0xc0) !== 0 ? 29 : 53;
    return specialKeys.get(code) ?? 0;
  }
  switch (keycode) {
    case 8: return KeyCode.Backspace;
    case 127: return KeyCode.Delete;
    case 33: return 49;
    case 64: return 50;
    case 35: return 51;
    case 36: return 52;
    case 37: return 53;
    case 94: return 54;
    case 38: return 55;
    case 42: return 56;
    case 40: return 57;
    case 41: return 48;
    case 178: return 126;
    // XLookupString returns no byte for ISO_Left_Tab, which XLateKey omits.
    case 9: return (modifiers & 3) !== 0 ? 0 : KeyCode.Tab;
    case 13: return KeyCode.Enter;
    case 27: return KeyCode.Escape;
    case 32: return KeyCode.Space;
    default: {
      const byte = (modifiers & 0xc0) !== 0 ? controlByte(keycode) : keycode;
      if (byte >= 65 && byte <= 90) return byte + 32;
      if (byte >= 1 && byte <= 26) return byte + 96;
      return byte > 0 && byte <= 255 ? byte : 0;
    }
  }
}

/** Printable keypad bytes XLookupString supplies before its Control conversion. */
function keypadByte(keycode: number, modifiers: number): number {
  if ((keycode & 0x40000000) === 0) return 0;
  const code = keycode & ~0x40000000;
  if (code >= 89 && code <= 97) return (modifiers & 0x1000) !== 0 ? code - 40 : 0;
  switch (code) {
    case 84: return 47;
    case 85: return 42;
    case 86: return 45;
    case 87: return 43;
    case 98: return (modifiers & 0x1000) !== 0 ? 48 : 0;
    case 99: return (modifiers & 0x1000) !== 0 ? 46 : 0;
    case 103: return 61;
    case 205: return 32;
    default: return 0;
  }
}

/** Sys_XTimeToSysTime's 30 ms correction, using SDL's real age and the shared clock. */
export function sdlEventTime(timestamp: number, ticks: number, now: number, subframe: boolean): number {
  const age = (ticks - timestamp) | 0;
  return subframe && age >= 0 && age <= 30 ? (now - age) | 0 : now;
}

function joystickEvent(event: SdlEvent): event is SdlJoystickEvent {
  return event.kind === "joystick-axis" || event.kind === "joystick-button" || event.kind === "joystick-removed";
}

/** Borrows the actual window, queue, key catcher, cvars and engine clock. */
export class SdlGameInput {
  private closed = false;
  private quitQueued = false;
  private suppressText = false;
  private pendingKey: { readonly event: Extract<SdlEvent, { readonly kind: "key" }>; readonly time: number } | null = null;
  private readonly keyboardBindings = new Map<number, number>();
  private readonly heldKeys = new Set<number>();

  private constructor(private readonly options: SdlGameInputOptions,
    private readonly lease: SdlInputLease) {}

  static open(options: SdlGameInputOptions): SdlGameInput {
    const lease = options.window.beginInput();
    return new SdlGameInput(options, lease);
  }

  private requireOpen(): void {
    if (this.closed || this.lease.closed || this.options.window.closed) throw new Error("SDL gameplay input is closed");
  }
  private numeric(name: string): number {
    const value = this.options.cvars.get(name);
    if (value === undefined) throw new Error(`Input cvar ${name} no longer exists`);
    return value.numericValue;
  }
  private time(timestamp: number): number {
    const ticks = this.options.window.ticks, now = this.options.clock.milliseconds();
    return sdlEventTime(timestamp, ticks, now, this.numeric("in_subframe") !== 0);
  }
  private key(key: number, down: boolean, time: number): void {
    this.options.unix.queueEvent({ kind: "key", time, key, down });
    if (down) this.heldKeys.add(key); else this.heldKeys.delete(key);
  }
  private releaseKeys(time: number): void {
    this.options.source.releaseJoystickState(time, (key, down, eventTime) => { this.key(key, down, eventTime); });
    for (const key of this.heldKeys) this.key(key, false, time);
    this.keyboardBindings.clear();
  }
  private stopMouse(): void {
    if (!this.options.window.closed) this.lease.setRelativeMouse(false);
    this.options.source.mouse.active = false;
  }

  sendKeyEvents(): void {
    this.requireOpen();
    for (const event of this.options.window.pollEvents()) this.handleEvent(event);
    this.flushKey(null);
  }

  private flushKey(text: string | null): void {
    const pending = this.pendingKey;
    if (pending === null) return;
    this.pendingKey = null;
    this.keyboardEvent(pending.event, pending.time, text);
  }

  private keyboardEvent(event: Extract<SdlEvent, { readonly kind: "key" }>, time: number, text: string | null): void {
    const { keys, unix } = this.options;
    this.suppressText = event.down && event.repeat && keys.getCatcher() === 0;
    if (this.suppressText) return;
    // SDL2's keycode omits Shift and even forces AZERTY number-row keys to digits.
    // An adjacent single-byte text commit supplies the actual layout symbol.
    // Multicharacter commits and keys without text retain SDL's keycode.
    const symbol = text !== null && text.length === 1 && text.charCodeAt(0) >= 32 && text.charCodeAt(0) !== 127 && text.charCodeAt(0) <= 255
      ? text.charCodeAt(0) : event.keycode;
    let key = sdlGameKey(symbol, event.modifiers);
    if (!event.down || event.repeat) key = this.keyboardBindings.get(event.scancode) ?? key;
    if (event.down) this.keyboardBindings.set(event.scancode, key);
    else this.keyboardBindings.delete(event.scancode);
    // X exposes a release/press pair for UI repeats; SDL exposes a repeated down.
    if (event.down && event.repeat) this.key(key, false, time);
    if (event.down && key === 0) return;
    this.key(key, event.down, time);
    if (!event.down) return;
    const control = (event.modifiers & 0xc0) !== 0;
    let character = 0;
    if (control && event.keycode >= 32 && event.keycode < 127) {
      character = controlByte(event.keycode);
    } else if (control && keypadByte(event.keycode, event.modifiers) !== 0) {
      character = controlByte(keypadByte(event.keycode, event.modifiers));
    } else if (event.keycode === 8 || event.keycode === 9 || event.keycode === 13 || event.keycode === 27 || event.keycode === 127) character = event.keycode;
    else if (key === KeyCode.KeypadEnter) character = 13;
    // SDL omits control bytes and Control combinations from its text channel.
    if (character !== 0) unix.queueEvent({ kind: "character", time, character });
  }

  /** Consumes decoded SDL records. Native input comes only from sendKeyEvents. */
  handleEvent(event: SdlEvent): void {
    this.requireOpen();
    this.flushKey(event.kind === "text" ? event.text : null);
    if (joystickEvent(event)) {
      this.options.source.queueJoystickEvent(event);
      return;
    }
    const { unix, window } = this.options;
    switch (event.kind) {
      case "key": {
        const time = this.time(event.timestamp);
        if (event.down && event.keycode >= 32 && event.keycode !== 127 && event.keycode <= 255 && (event.modifiers & 0xc0) === 0) {
          this.pendingKey = { event, time };
        } else this.keyboardEvent(event, time, null);
        return;
      }
      case "text": {
        if (this.suppressText) { this.suppressText = false; return; }
        const time = this.time(event.timestamp);
        for (const character of event.text) {
          const byte = character.codePointAt(0);
          if (byte === undefined) throw new Error("Empty SDL text character");
          if (byte > 255) { this.options.print(`SDL text U+${byte.toString(16).toUpperCase()} is outside the source Latin-1 character set.\n`); continue; }
          if (byte < 32 || byte === 127) continue;
          // ClientKeys consumes canonical bytes, independent of native char signedness.
          unix.queueEvent({ kind: "character", time, character: byte });
        }
        return;
      }
      case "mouse-motion": {
        const time = this.time(event.timestamp);
        const mouse = this.options.source.mouse;
        if (!mouse.active || (window.flags & 0x200) === 0 || ((time - mouse.resetTime) | 0) <= 50) return;
        const gain = (delta: number): number => (Math.abs(delta) > 1 ? delta * 2 : delta) | 0;
        unix.queueEvent({ kind: "mouse", time, dx: gain(event.dx), dy: gain(event.dy) });
        return;
      }
      case "mouse-button": {
        const key = event.button === 1 ? KeyCode.Mouse1 : event.button === 2 ? KeyCode.Mouse3
          : event.button === 3 ? KeyCode.Mouse2 : event.button === 4 ? KeyCode.Mouse4
          : event.button === 5 ? KeyCode.Mouse5 : 0;
        if (key !== 0) this.key(key, event.down, this.time(event.timestamp));
        return;
      }
      case "mouse-wheel": {
        const steps = event.flipped ? -event.y : event.y, time = this.time(event.timestamp);
        const key = steps > 0 ? KeyCode.MouseWheelUp : KeyCode.MouseWheelDown;
        for (let step = 0; step < Math.abs(steps); step++) { this.key(key, true, time); this.key(key, false, time); }
        return;
      }
      case "window":
        if (event.event === 14) this.quit(event.timestamp);
        // A recorded loss still releases keys if focus returned before this poll.
        // Acquisition in frame always uses the current native window flags.
        else if (event.event === 13 || ((event.event === 7 || event.event === 2) && (window.flags & 0x200) === 0)) {
          this.releaseKeys(this.time(event.timestamp)); this.stopMouse(); this.suppressText = false;
        }
        return;
      case "quit": this.quit(event.timestamp); return;
      case "unsupported": return;
    }
  }

  private quit(timestamp: number): void {
    if (this.quitQueued) return;
    this.quitQueued = true;
    const time = this.time(timestamp);
    this.releaseKeys(time); this.stopMouse();
    this.options.unix.queueEvent({ kind: "console", time, text: "quit" });
  }

  /** IN_JoyMove precedes source mouse capture policy and packet polling. */
  frame(): void {
    this.requireOpen();
    this.options.source.joystickFrame((key, down, time) => { this.key(key, down, time); });
    const { window, keys, clock } = this.options, flags = window.flags;
    const mouse = this.options.source.mouse;
    const consoleWindowed = (keys.getCatcher() & KeyCatcher.Console) !== 0 && (flags & 1) === 0;
    if (this.quitQueued || (flags & 0x200) === 0 || (flags & 0x48) !== 0) {
      this.stopMouse(); return;
    }
    // Both source capture functions return when unavailable, preserving mouse_active.
    if (!mouse.available) return;
    if (consoleWindowed) {
      this.stopMouse(); return;
    }
    const grab = this.numeric("in_nograb") === 0;
    if (!grab && this.numeric("in_dgamouse") !== 0) this.options.cvars.set("in_dgamouse", "0", true);
    const wasRelative = window.relativeMouse;
    this.lease.setRelativeMouse(grab);
    if (grab && !wasRelative) mouse.resetTime = clock.milliseconds();
    mouse.active = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.heldKeys.clear();
    this.pendingKey = null; this.keyboardBindings.clear();
    const errors: unknown[] = [];
    try { this.lease.close(); } catch (error) { errors.push(error); }
    if (this.options.source.mouse.available) this.options.source.mouse.active = false;
    if (errors.length !== 0) throw new AggregateError(errors, "SDL gameplay input cleanup failed");
  }
}
