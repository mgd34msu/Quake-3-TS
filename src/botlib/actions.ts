/*
 * Elementary bot actions translated from id Software's botlib/be_ea.c,
 * game/be_ea.h and game/botlib.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { Vec3 } from "../core/math.ts";
import { finishCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { BotMemory } from "./memory.ts";
import type { BotMemoryAllocation } from "./memory.ts";

const BOT_INPUT_BYTES = 40;
const MAX_USER_MOVE = 400;
const VA_BUFFER_SIZE = 32_000;
const JUMPED_LAST_FRAME = 0x0000080;

export enum BotActionFlag {
  ATTACK = 0x0000001,
  USE = 0x0000002,
  RESPAWN = 0x0000008,
  JUMP = 0x0000010,
  MOVE_UP = 0x0000020,
  CROUCH = 0x0000080,
  MOVE_DOWN = 0x0000100,
  MOVE_FORWARD = 0x0000200,
  MOVE_BACK = 0x0000800,
  MOVE_LEFT = 0x0001000,
  MOVE_RIGHT = 0x0002000,
  DELAYED_JUMP = 0x0008000,
  TALK = 0x0010000,
  GESTURE = 0x0020000,
  WALK = 0x0080000,
  AFFIRMATIVE = 0x0100000,
  NEGATIVE = 0x0200000,
  GET_FLAG = 0x0800000,
  GUARD_BASE = 0x1000000,
  PATROL = 0x2000000,
  FOLLOW_ME = 0x8000000,
}

export interface BotInput {
  readonly thinkTime: number;
  readonly direction: Vec3;
  readonly speed: number;
  readonly viewAngles: Vec3;
  readonly actionFlags: number;
  readonly weapon: number;
}

export interface BotActionHost {
  clientCommand(client: number, command: string): CallSteps;
}

class BotInputView {
  private data: { readonly view: DataView; readonly byteOffset: number; readonly byteLength: number } | null = null;

  constructor(private readonly allocation: BotMemoryAllocation, private readonly offset: number) {}

  get bytes(): Uint8Array { return this.allocation.bytes.subarray(this.offset, this.offset + BOT_INPUT_BYTES); }

  private view(): DataView {
    const bytes = this.allocation.bytes;
    let data = this.data;
    if (data === null || data.view.buffer !== bytes.buffer || data.byteOffset !== bytes.byteOffset || data.byteLength !== bytes.byteLength) {
      data = { view: new DataView(bytes.buffer, bytes.byteOffset + this.offset, BOT_INPUT_BYTES),
        byteOffset: bytes.byteOffset, byteLength: bytes.byteLength };
      this.data = data;
    }
    return data.view;
  }

  get thinkTime(): number { return this.view().getFloat32(0, true); }
  set thinkTime(value: number) { this.view().setFloat32(0, value, true); }
  get direction(): Vec3 {
    const view = this.view();
    return { x: view.getFloat32(4, true), y: view.getFloat32(8, true), z: view.getFloat32(12, true) };
  }
  set direction(value: Vec3) {
    this.view().setFloat32(4, value.x, true);
    this.view().setFloat32(8, value.y, true);
    this.view().setFloat32(12, value.z, true);
  }
  get speed(): number { return this.view().getFloat32(16, true); }
  set speed(value: number) { this.view().setFloat32(16, value, true); }
  get viewAngles(): Vec3 {
    const view = this.view();
    return { x: view.getFloat32(20, true), y: view.getFloat32(24, true), z: view.getFloat32(28, true) };
  }
  set viewAngles(value: Vec3) {
    this.view().setFloat32(20, value.x, true);
    this.view().setFloat32(24, value.y, true);
    this.view().setFloat32(28, value.z, true);
  }
  get actionFlags(): number { return this.view().getInt32(32, true); }
  set actionFlags(value: number) { this.view().setInt32(32, value, true); }
  get weapon(): number { return this.view().getInt32(36, true); }
  set weapon(value: number) { this.view().setInt32(36, value, true); }
}

function zeroVector(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

function sourceInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`${name} must be a signed 32-bit integer`);
  }
  return value;
}

function byteCString(value: string, name: string): string {
  const nul = value.indexOf("\0");
  const visible = nul < 0 ? value : value.slice(0, nul);
  for (let index = 0; index < visible.length; index++) {
    const code = visible.charCodeAt(index);
    if (code > 0xff) throw new RangeError(`${name} must contain byte-valued code units`);
  }
  return visible;
}

function vaCommand(prefix: string, value: string, name: string): string {
  const command = prefix + byteCString(value, name);
  if (command.length >= VA_BUFFER_SIZE) {
    throw new RangeError(`${name} exceeds the 32000-byte botlib va buffer`);
  }
  return command;
}

/** Per-instance storage for be_ea.c's accumulated bot_input_t records. */
export class BotActionBuffer {
  private inputs: { readonly allocation: BotMemoryAllocation; readonly views: Map<number, BotInputView> } | null = null;
  private clientCapacity = 0;

  constructor(
    maxClients: number | null,
    private readonly host: BotActionHost,
    private readonly memory: BotMemory = new BotMemory(),
  ) {
    if (maxClients !== null) this.setup(maxClients);
  }

  get maxClients(): number { return this.clientCapacity; }

  setup(maxClients: number): void {
    if (!Number.isInteger(maxClients) || maxClients < 0 || maxClients * BOT_INPUT_BYTES > 0x7fffffff) {
      throw new RangeError(`bot action maxClients ${maxClients} exceeds the source signed allocation range`);
    }
    this.inputs = { allocation: this.memory.allocate(maxClients * BOT_INPUT_BYTES, "hunk", true),
      views: new Map<number, BotInputView>() };
    this.clientCapacity = maxClients;
  }

  shutdown(): void {
    if (this.inputs !== null) this.memory.free(this.inputs.allocation);
    this.inputs = null;
  }

  disposeResources(): void {
    this.inputs = null;
  }

  private input(client: number): BotInputView {
    const inputs = this.inputs;
    if (inputs === null) throw new Error("bot action input allocation has been shut down");
    if (!Number.isInteger(client) || client < 0 || client >= this.clientCapacity) {
      throw new RangeError(`bot action client ${client} outside 0..${this.clientCapacity - 1}`);
    }
    // Resolve the source pointer before evaluating a lazy vector argument.
    void inputs.allocation.bytes;
    let view = inputs.views.get(client);
    if (view === undefined) {
      view = new BotInputView(inputs.allocation, client * BOT_INPUT_BYTES);
      inputs.views.set(client, view);
    }
    return view;
  }

  private addFlag(client: number, flag: BotActionFlag): void {
    const input = this.input(client);
    input.actionFlags |= flag;
  }

  say(client: number, text: string): void {
    finishCalls(this.sayCalls(client, text));
  }

  *sayCalls(client: number, text: string): CallSteps {
    yield* this.host.clientCommand(client, vaCommand("say ", text, "bot say text"));
  }

  sayTeam(client: number, text: string): void {
    finishCalls(this.sayTeamCalls(client, text));
  }

  *sayTeamCalls(client: number, text: string): CallSteps {
    yield* this.host.clientCommand(client, vaCommand("say_team ", text, "bot team say text"));
  }

  tell(client: number, recipient: number, text: string): void {
    finishCalls(this.tellCalls(client, recipient, text));
  }

  *tellCalls(client: number, recipient: number, text: string): CallSteps {
    const target = sourceInt(recipient, "bot tell recipient");
    yield* this.host.clientCommand(client, vaCommand(`tell ${target}, `, text, "bot tell text"));
  }

  useItem(client: number, item: string): void {
    finishCalls(this.useItemCalls(client, item));
  }

  *useItemCalls(client: number, item: string): CallSteps {
    yield* this.host.clientCommand(client, vaCommand("use ", item, "bot item name"));
  }

  dropItem(client: number, item: string): void {
    finishCalls(this.dropItemCalls(client, item));
  }

  *dropItemCalls(client: number, item: string): CallSteps {
    yield* this.host.clientCommand(client, vaCommand("drop ", item, "bot item name"));
  }

  useInventory(client: number, inventory: string): void {
    finishCalls(this.useInventoryCalls(client, inventory));
  }

  *useInventoryCalls(client: number, inventory: string): CallSteps {
    yield* this.host.clientCommand(client, vaCommand("invuse ", inventory, "bot inventory name"));
  }

  dropInventory(client: number, inventory: string): void {
    finishCalls(this.dropInventoryCalls(client, inventory));
  }

  *dropInventoryCalls(client: number, inventory: string): CallSteps {
    yield* this.host.clientCommand(client, vaCommand("invdrop ", inventory, "bot inventory name"));
  }

  command(client: number, command: string): void {
    finishCalls(this.commandCalls(client, command));
  }

  *commandCalls(client: number, command: string): CallSteps {
    yield* this.host.clientCommand(client, byteCString(command, "bot client command"));
  }

  gesture(client: number): void { this.addFlag(client, BotActionFlag.GESTURE); }
  talk(client: number): void { this.addFlag(client, BotActionFlag.TALK); }
  attack(client: number): void { this.addFlag(client, BotActionFlag.ATTACK); }
  use(client: number): void { this.addFlag(client, BotActionFlag.USE); }
  respawn(client: number): void { this.addFlag(client, BotActionFlag.RESPAWN); }
  crouch(client: number): void { this.addFlag(client, BotActionFlag.CROUCH); }
  walk(client: number): void { this.addFlag(client, BotActionFlag.WALK); }
  moveUp(client: number): void { this.addFlag(client, BotActionFlag.MOVE_UP); }
  moveDown(client: number): void { this.addFlag(client, BotActionFlag.MOVE_DOWN); }
  moveForward(client: number): void { this.addFlag(client, BotActionFlag.MOVE_FORWARD); }
  moveBack(client: number): void { this.addFlag(client, BotActionFlag.MOVE_BACK); }
  moveLeft(client: number): void { this.addFlag(client, BotActionFlag.MOVE_LEFT); }
  moveRight(client: number): void { this.addFlag(client, BotActionFlag.MOVE_RIGHT); }

  action(client: number, actionFlags: number): void {
    const input = this.input(client);
    input.actionFlags |= sourceInt(actionFlags, "bot action flags");
  }

  selectWeapon(client: number, weapon: number): void {
    this.input(client).weapon = sourceInt(weapon, "bot weapon");
  }

  jump(client: number): void {
    const input = this.input(client);
    if ((input.actionFlags & JUMPED_LAST_FRAME) !== 0) input.actionFlags &= ~BotActionFlag.JUMP;
    else input.actionFlags |= BotActionFlag.JUMP;
  }

  delayedJump(client: number): void {
    const input = this.input(client);
    if ((input.actionFlags & JUMPED_LAST_FRAME) !== 0) input.actionFlags &= ~BotActionFlag.DELAYED_JUMP;
    else input.actionFlags |= BotActionFlag.DELAYED_JUMP;
  }

  move(client: number, direction: Vec3 | (() => Vec3), speed: number): void {
    const input = this.input(client);
    const value = typeof direction === "function" ? direction() : direction;
    input.direction = value;
    const storedSpeed = Math.fround(speed);
    input.speed = storedSpeed > MAX_USER_MOVE ? MAX_USER_MOVE : storedSpeed < -MAX_USER_MOVE ? -MAX_USER_MOVE : storedSpeed;
  }

  view(client: number, viewAngles: Vec3 | (() => Vec3)): void {
    const input = this.input(client);
    const value = typeof viewAngles === "function" ? viewAngles() : viewAngles;
    input.viewAngles = value;
  }

  /** The active source body is empty; retain it as an explicit no-op. */
  endRegular(_client: number, _thinkTime: number): void {}

  getInput(client: number, thinkTime: number): BotInput {
    const input = this.input(client);
    input.thinkTime = thinkTime;
    return {
      thinkTime: input.thinkTime,
      direction: input.direction,
      speed: input.speed,
      viewAngles: input.viewAngles,
      actionFlags: input.actionFlags,
      weapon: input.weapon,
    };
  }

  /** EA_GetInput's reached memcpy source, after the source thinktime store. */
  getInputBytes(client: number, thinkTime: number): Uint8Array {
    const input = this.input(client);
    input.thinkTime = thinkTime;
    return input.bytes;
  }

  resetInput(client: number): void {
    const input = this.input(client);
    input.actionFlags &= ~JUMPED_LAST_FRAME;
    input.thinkTime = 0;
    input.direction = zeroVector();
    input.speed = 0;
    const jumped = (input.actionFlags & BotActionFlag.JUMP) !== 0;
    input.actionFlags = jumped ? JUMPED_LAST_FRAME : 0;
  }
}
