// Port of id Software's client/cl_input.c input state and command creation.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandBuffer, CommandContext } from "../core/commands.ts";
import { CommonError } from "../core/common-error.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry, CvarSnapshot } from "../core/cvar.ts";
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { LanAddresses } from "../platform/lan.ts";
import { CommandButtons } from "../shared/player-state.ts";
import type { ClientMoveSample, ClientPacketDelivery, EngineClientSession } from "./client-session.ts";
import type { ClientActiveState } from "./client-active.ts";
import type { ClientPacketAddress, ClientStaticState } from "./client-state.ts";

export interface ClientInputKeys {
  readonly keyCatchers: number;
  readonly anyKeyDown: number;
}
export interface ClientInputOptions {
  readonly commands: CommandBuffer;
  readonly cvars: CvarRegistry;
  readonly print: (text: string) => undefined;
  readonly readKeys: () => ClientInputKeys;
  readonly readDeltaAngles: () => Readonly<Vec3>;
  readonly mouseToUi: (dx: number, dy: number) => Promise<void>;
  readonly mouseToCgame: (dx: number, dy: number) => Promise<void>;
  readonly debugGraph: (value: number, color: number) => undefined;
}
/** The connection owner derives primed after CG_Init, or uses the source cinematic phase. */
export type ClientInputFrame =
  | { readonly kind: "unprimed" }
  | { readonly kind: "primed" | "cinematic"; readonly session: EngineClientSession; readonly comFrameTime: number;
      readonly clientFrameTime: number; readonly serverTime: number }
  | { readonly kind: "playback"; readonly active: ClientActiveState; readonly comFrameTime: number;
      readonly clientFrameTime: number; readonly serverTime: number };
export interface ClientSendFrame {
  readonly session: EngineClientSession;
  readonly comFrameTime: number;
  readonly remoteAddress: ClientPacketAddress;
  readonly lan: LanAddresses;
  readonly delivery: ClientPacketDelivery;
}
export type ClientInputCvarGroup = "angle-speeds" | "movement" | "mouse";

/** These groups occupy distinct CL_Init registration sites around other client cvars. */
export function registerClientInputCvars(cvars: CvarRegistry, group: ClientInputCvarGroup): void {
  const archive = CvarFlag.Archive;
  switch (group) {
    case "angle-speeds":
      cvars.register("cl_yawspeed", "140", archive); cvars.register("cl_pitchspeed", "140", archive);
      cvars.register("cl_anglespeedkey", "1.5"); return;
    case "movement":
      cvars.register("cl_run", "1", archive); cvars.register("sensitivity", "5", archive);
      cvars.register("cl_mouseAccel", "0", archive); cvars.register("cl_freelook", "1", archive);
      cvars.register("cl_showmouserate", "0"); return;
    case "mouse":
      cvars.register("m_pitch", "0.022", archive); cvars.register("m_yaw", "0.022", archive);
      cvars.register("m_forward", "0.25", archive); cvars.register("m_side", "0.25", archive);
      cvars.register("m_filter", "0", archive); return;
    default: { const unreachable: never = group; throw new Error(`Unknown input cvar group ${unreachable}`); }
  }
}

class KeyButton {
  first = 0;
  second = 0;
  downtime = 0;
  milliseconds = 0;
  active = false;
  wasPressed = false;
}
interface Move { buttons: number; forward: number; side: number; up: number }
function signed(value: number, label: string): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError(`${label} requires int32`);
  return value;
}
function nativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648) {
    throw new RangeError("Undefined native input float-to-int conversion");
  }
  return Math.trunc(value) + 0;
}
function clampChar(value: number): number { return Math.max(-128, Math.min(127, nativeInteger(value))); }
const f = Math.fround;

/** Native %f for binary32 values, with six places and round-to-nearest/even. */
function fixedSix(value: number): string {
  const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true), exponent = (bits >>> 23) & 255;
  const sign = (bits >>> 31) === 0 ? "" : "-", fraction = bits & 0x7fffff;
  if (exponent === 255) return `${sign}${fraction === 0 ? "inf" : "nan"}`;
  const coefficient = BigInt(exponent === 0 ? fraction : fraction | 0x800000) * 1000000n;
  const shift = exponent === 0 ? -149 : exponent - 150;
  let rounded: bigint;
  if (shift >= 0) rounded = coefficient << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), quotient = coefficient / divisor, twiceRemainder = 2n * (coefficient % divisor);
    rounded = quotient + (twiceRemainder > divisor || (twiceRemainder === divisor && (quotient & 1n) !== 0n) ? 1n : 0n);
  }
  return `${sign}${rounded / 1000000n}.${(rounded % 1000000n).toString().padStart(6, "0")}`;
}

/** Button globals survive CL_ClearState; angles, mouse buffers and axes do not. */
export class ClientInput {
  private readonly left = new KeyButton();
  private readonly right = new KeyButton();
  private readonly forward = new KeyButton();
  private readonly back = new KeyButton();
  private readonly lookup = new KeyButton();
  private readonly lookdown = new KeyButton();
  private readonly moveleft = new KeyButton();
  private readonly moveright = new KeyButton();
  private readonly strafe = new KeyButton();
  private readonly speed = new KeyButton();
  private readonly up = new KeyButton();
  private readonly down = new KeyButton();
  // Native storage has 16 entries, but its registration and packing stop at 15.
  private readonly buttons = Array.from({ length: 16 }, () => new KeyButton());
  private mlooking = false;
  private frameMilliseconds = 0;
  private oldComFrameTime = 0;
  private angles: Vec3 = vec3(0, 0, 0);
  private readonly mouseX: [number, number] = [0, 0];
  private readonly mouseY: [number, number] = [0, 0];
  private mouseIndex: 0 | 1 = 0;
  private readonly axes: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  private initialized = false;

  constructor(private readonly options: ClientInputOptions) {}
  get viewAngles(): Readonly<Vec3> { return { ...this.angles }; }

  initializeCommands(): void {
    if (this.initialized) throw new Error("Client input commands are already initialized");
    const commands = this.options.commands;
    commands.register("centerview", context => { context.assertActive(); this.centerView(); });
    const names: readonly (readonly [string, KeyButton])[] = [
      ["moveup", this.up], ["movedown", this.down], ["left", this.left], ["right", this.right],
      ["forward", this.forward], ["back", this.back], ["lookup", this.lookup], ["lookdown", this.lookdown],
      ["strafe", this.strafe], ["moveleft", this.moveleft], ["moveright", this.moveright], ["speed", this.speed],
    ];
    const register = (name: string, button: KeyButton): void => {
      commands.register(`+${name}`, context => { context.assertActive(); this.keyDown(button, context); });
      commands.register(`-${name}`, context => { context.assertActive(); this.keyUp(button, context); });
    };
    for (const [name, button] of names) register(name, button);
    const registerButton = (name: string, index: number): void => {
      commands.register(`+${name}`, context => { this.buttonDown(index, context); });
      commands.register(`-${name}`, context => { this.buttonUp(index, context); });
    };
    registerButton("attack", 0);
    for (let index = 0; index < 15; index++) registerButton(`button${index}`, index);
    commands.register("+mlook", context => { context.assertActive(); this.mlooking = true; });
    commands.register("-mlook", context => {
      context.assertActive(); this.mlooking = false;
      if (this.cvar("cl_freelook").integerValue === 0) this.centerView();
    });
    this.options.cvars.register("cl_nodelta", "0"); this.options.cvars.register("cl_debugMove", "0");
    this.initialized = true;
  }

  clearActiveState(): void {
    this.angles = vec3(0, 0, 0); this.mouseX.fill(0); this.mouseY.fill(0); this.mouseIndex = 0; this.axes.fill(0);
  }

  /** IN_Button0..15Down/Up exist even though CL_InitInput never registers button15. */
  buttonDown(index: number, context: CommandContext): void { context.assertActive(); this.keyDown(this.button(index), context); }
  buttonUp(index: number, context: CommandContext): void { context.assertActive(); this.keyUp(this.button(index), context); }

  async mouseEvent(dx: number, dy: number, time: number): Promise<void> {
    signed(dx, "Mouse X"); signed(dy, "Mouse Y"); signed(time, "Mouse event time");
    const catchers = signed(this.options.readKeys().keyCatchers, "Key catchers");
    if ((catchers & 2) !== 0) await this.options.mouseToUi(dx, dy);
    else if ((catchers & 8) !== 0) await this.options.mouseToCgame(dx, dy);
    else {
      this.mouseX[this.mouseIndex] = (this.mouseX[this.mouseIndex] + dx) | 0;
      this.mouseY[this.mouseIndex] = (this.mouseY[this.mouseIndex] + dy) | 0;
    }
  }

  joystickEvent(axis: number, value: number, time: number): void {
    signed(axis, "Joystick axis");
    if (axis < 0 || axis >= this.axes.length) throw new CommonError("drop", `CL_JoystickEvent: bad axis ${axis}`);
    signed(value, "Joystick value"); signed(time, "Joystick event time"); this.axes[axis] = value;
  }

  createNewCommands(frame: ClientInputFrame): number | null {
    if (frame.kind === "unprimed") return null;
    signed(frame.comFrameTime, "Common frame time"); signed(frame.clientFrameTime, "Client frame time"); signed(frame.serverTime, "Server time");
    const milliseconds = Math.min((frame.comFrameTime - this.oldComFrameTime) >>> 0, 200);
    if (milliseconds === 0) throw new RangeError("Zero-duration input frame requires undefined native movement conversion");
    this.frameMilliseconds = milliseconds; this.oldComFrameTime = frame.comFrameTime;
    const previous = this.angles;
    const sample = this.createCommand(frame);
    const number = frame.kind === "playback" ? frame.active.createUserCommand(sample) : frame.session.createUserCommand(sample);
    if (number === null) throw new Error("Claimed-primed input requires its actual primed client session");
    const debug = this.cvar("cl_debugMove").integerValue;
    if (debug === 1) this.options.debugGraph(Math.abs(nativeInteger(f(this.angles.y - previous.y))), 0);
    else if (debug === 2) this.options.debugGraph(Math.abs(nativeInteger(f(this.angles.x - previous.x))), 0);
    return number;
  }

  /** CL_SendCmd still consumes input and records usercmds when playback suppresses networking. */
  sendPlaybackCommand(active: ClientActiveState, state: ClientStaticState, comFrameTime: number): void {
    if (state.phase === "uninitialized" || state.phase === "disconnected" || state.phase === "connecting" || state.phase === "challenging") return;
    if (this.cvar("sv_running").integerValue !== 0 && this.cvar("sv_paused").integerValue !== 0
      && this.cvar("cl_paused").integerValue !== 0) return;
    if (state.phase === "primed" || state.phase === "active" || state.phase === "cinematic") {
      this.createNewCommands({ kind: "playback", active, comFrameTime, clientFrameTime: state.frameTime, serverTime: active.time });
    }
    if (this.cvar("cl_showSend").integerValue !== 0) this.options.print(". ");
  }

  /** CL_SendCmd for an admitted network connection. */
  sendCommand(frame: ClientSendFrame): void {
    const session = frame.session, lifecycle = session.lifecycle, cls = lifecycle.clientStatic;
    lifecycle.assertCurrentOperation();
    switch (cls.phase) {
      case "uninitialized": case "disconnected": case "connecting": case "challenging": return;
      case "connected": case "loading": case "primed": case "active": case "cinematic": break;
      default: { const unreachable: never = cls.phase; throw new Error(`Unknown client phase ${unreachable}`); }
    }
    if (session.cvars !== this.options.cvars) throw new Error("Client input and session require the same cvars");
    if (this.cvar("sv_running").integerValue !== 0 && this.cvar("sv_paused").integerValue !== 0
      && this.cvar("cl_paused").integerValue !== 0) return;
    if (cls.phase === "primed" || cls.phase === "active" || cls.phase === "cinematic") {
      this.createNewCommands({ kind: cls.phase === "cinematic" ? "cinematic" : "primed", session, comFrameTime: frame.comFrameTime,
        clientFrameTime: cls.frameTime, serverTime: session.serverTime });
      lifecycle.assertCurrentOperation();
    }
    if (!session.readyToSendPacket(frame.remoteAddress, frame.lan)) {
      if (this.cvar("cl_showSend").integerValue !== 0) {
        frame.delivery.print(". "); lifecycle.assertCurrentOperation();
      }
      return;
    }
    session.transmit(frame.delivery);
  }

  private cvar(name: string): CvarSnapshot {
    const value = this.options.cvars.get(name);
    if (value === undefined) throw new Error(`Client input requires registered cvar ${name}`);
    return value;
  }
  private button(index: number): KeyButton {
    const button = this.buttons[index];
    if (button === undefined) throw new RangeError(`Invalid input button ${index}`);
    return button;
  }
  private keyDown(button: KeyButton, context: CommandContext): void {
    const text = context.argv[1] ?? "", key = text === "" ? -1 : nativeAtoi(text);
    if (key === button.first || key === button.second) return;
    if (button.first === 0) button.first = key;
    else if (button.second === 0) button.second = key;
    else { this.options.print("Three keys down for a button!\n"); return; }
    if (button.active) return;
    button.downtime = nativeAtoi(context.argv[2] ?? "") >>> 0;
    button.active = true; button.wasPressed = true;
  }
  private keyUp(button: KeyButton, context: CommandContext): void {
    const text = context.argv[1] ?? "";
    if (text === "") { button.first = 0; button.second = 0; button.active = false; return; }
    const key = nativeAtoi(text);
    if (button.first === key) button.first = 0;
    else if (button.second === key) button.second = 0;
    else return;
    if (button.first !== 0 || button.second !== 0) return;
    button.active = false;
    const uptime = nativeAtoi(context.argv[2] ?? "") >>> 0;
    button.milliseconds = (button.milliseconds + (uptime === 0 ? Math.floor(this.frameMilliseconds / 2) : uptime - button.downtime)) >>> 0;
  }
  private keyState(button: KeyButton, comFrameTime: number): number {
    let milliseconds = button.milliseconds | 0; button.milliseconds = 0;
    if (button.active) {
      milliseconds = button.downtime === 0 ? comFrameTime : (milliseconds + comFrameTime - button.downtime) | 0;
      button.downtime = comFrameTime >>> 0;
    }
    return Math.max(0, Math.min(1, f(f(milliseconds) / f(this.frameMilliseconds))));
  }
  private centerView(): void {
    const pitch = signed(this.options.readDeltaAngles().x, "Snapshot delta pitch");
    this.angles = { ...this.angles, x: f(-pitch * (360 / 65536)) };
  }
  private angleSpeed(clientFrameTime: number): number {
    return this.speed.active ? f(0.001 * clientFrameTime * this.cvar("cl_anglespeedkey").numericValue) : f(0.001 * clientFrameTime);
  }
  private adjustAngles(frame: Exclude<ClientInputFrame, { kind: "unprimed" }>): void {
    const speed = this.angleSpeed(frame.clientFrameTime), time = frame.comFrameTime;
    let { x: pitch, y: yaw, z: roll } = this.angles;
    if (!this.strafe.active) {
      yaw = f(yaw - f(f(speed * this.cvar("cl_yawspeed").numericValue) * this.keyState(this.right, time)));
      yaw = f(yaw + f(f(speed * this.cvar("cl_yawspeed").numericValue) * this.keyState(this.left, time)));
    }
    pitch = f(pitch - f(f(speed * this.cvar("cl_pitchspeed").numericValue) * this.keyState(this.lookup, time)));
    pitch = f(pitch + f(f(speed * this.cvar("cl_pitchspeed").numericValue) * this.keyState(this.lookdown, time)));
    this.angles = { x: pitch, y: yaw, z: roll };
  }
  private commandButtons(): number {
    let buttons = 0;
    for (let index = 0; index < 15; index++) {
      const button = this.button(index);
      if (button.active || button.wasPressed) buttons |= 1 << index;
      button.wasPressed = false;
    }
    if (this.options.readKeys().keyCatchers !== 0) buttons |= CommandButtons.TALK;
    if (this.options.readKeys().anyKeyDown !== 0 && this.options.readKeys().keyCatchers === 0) buttons |= CommandButtons.ANY;
    return buttons;
  }
  private keyMove(move: Move, comFrameTime: number): void {
    const running = ((this.speed.active ? 1 : 0) ^ this.cvar("cl_run").integerValue) !== 0;
    const speed = running ? 127 : 64;
    if (running) move.buttons &= ~CommandButtons.WALKING;
    else move.buttons |= CommandButtons.WALKING;
    const add = (value: number, button: KeyButton) => nativeInteger(f(f(value) + f(f(speed) * this.keyState(button, comFrameTime))));
    const subtract = (value: number, button: KeyButton) => nativeInteger(f(f(value) - f(f(speed) * this.keyState(button, comFrameTime))));
    if (this.strafe.active) { move.side = add(move.side, this.right); move.side = subtract(move.side, this.left); }
    move.side = add(move.side, this.moveright); move.side = subtract(move.side, this.moveleft);
    move.up = add(move.up, this.up); move.up = subtract(move.up, this.down);
    move.forward = add(move.forward, this.forward); move.forward = subtract(move.forward, this.back);
    move.forward = clampChar(move.forward); move.side = clampChar(move.side); move.up = clampChar(move.up);
  }
  private mouseMove(move: Move, sensitivity: number): void {
    let mx: number, my: number;
    if (this.cvar("m_filter").integerValue !== 0) {
      mx = f(((this.mouseX[0] + this.mouseX[1]) | 0) * 0.5);
      my = f(((this.mouseY[0] + this.mouseY[1]) | 0) * 0.5);
    } else { mx = f(this.mouseX[this.mouseIndex]); my = f(this.mouseY[this.mouseIndex]); }
    this.mouseIndex = this.mouseIndex === 0 ? 1 : 0; this.mouseX[this.mouseIndex] = 0; this.mouseY[this.mouseIndex] = 0;
    const rate = f(Math.sqrt(f(f(mx * mx) + f(my * my))) / f(this.frameMilliseconds));
    let accel = f(this.cvar("sensitivity").numericValue + f(rate * this.cvar("cl_mouseAccel").numericValue));
    accel = f(accel * sensitivity);
    if (rate !== 0 && this.cvar("cl_showmouserate").integerValue !== 0) this.options.print(`${fixedSix(rate)} : ${fixedSix(accel)}\n`);
    mx = f(mx * accel); my = f(my * accel);
    if (mx === 0 && my === 0) return;
    if (this.strafe.active) move.side = clampChar(f(f(move.side) + f(this.cvar("m_side").numericValue * mx)));
    else this.angles = { ...this.angles, y: f(this.angles.y - f(this.cvar("m_yaw").numericValue * mx)) };
    if ((this.mlooking || this.cvar("cl_freelook").integerValue !== 0) && !this.strafe.active) {
      this.angles = { ...this.angles, x: f(this.angles.x + f(this.cvar("m_pitch").numericValue * my)) };
    } else move.forward = clampChar(f(f(move.forward) - f(this.cvar("m_forward").numericValue * my)));
  }
  private joystickMove(move: Move, clientFrameTime: number): void {
    if (((this.speed.active ? 1 : 0) ^ this.cvar("cl_run").integerValue) === 0) move.buttons |= CommandButtons.WALKING;
    const speed = this.angleSpeed(clientFrameTime);
    if (!this.strafe.active) this.angles = { ...this.angles,
      y: f(this.angles.y + f(f(speed * this.cvar("cl_yawspeed").numericValue) * f(this.axes[0]))) };
    else move.side = clampChar((move.side + this.axes[0]) | 0);
    if (this.mlooking) this.angles = { ...this.angles,
      x: f(this.angles.x + f(f(speed * this.cvar("cl_pitchspeed").numericValue) * f(this.axes[1]))) };
    else move.forward = clampChar((move.forward + this.axes[1]) | 0);
    move.up = clampChar((move.up + this.axes[2]) | 0);
  }
  private createCommand(frame: Exclude<ClientInputFrame, { kind: "unprimed" }>): ClientMoveSample {
    const previous = this.angles;
    this.adjustAngles(frame);
    const move: Move = { buttons: this.commandButtons(), forward: 0, side: 0, up: 0 };
    this.keyMove(move, frame.comFrameTime);
    this.mouseMove(move, frame.kind === "playback" ? frame.active.sensitivity : frame.session.userCmdSensitivity);
    this.joystickMove(move, frame.clientFrameTime);
    if (f(this.angles.x - previous.x) > 90) this.angles = { ...this.angles, x: f(previous.x + 90) };
    else if (f(previous.x - this.angles.x) > 90) this.angles = { ...this.angles, x: f(previous.x - 90) };
    const result: ClientMoveSample = { serverTime: frame.serverTime, viewAngles: { ...this.angles },
      buttons: move.buttons, forwardmove: move.forward, rightmove: move.side, upmove: move.up };
    return result;
  }
}
