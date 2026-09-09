/*
 * Bot view and command conversion translated from id Software's game/ai_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BotActionFlag } from "../botlib/actions.ts";
import type { BotInput } from "../botlib/actions.ts";
import { Characteristic } from "../botlib/character.ts";
import { dot3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { qvmAngleMod, qvmAngleVectors } from "../core/qvm-math.ts";
import { CommandButtons } from "../shared/player-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import type { GameAiContext } from "./ai-context.ts";
import type { BotState } from "./ai-state.ts";

const f = Math.fround;
const viewAxes: readonly ("x" | "y")[] = ["x", "y"];

function sourceAbs(value: number): number { return value < 0 ? (-value) | 0 : value; }

export function botAngleDifference(first: number, second: number): number {
  let difference = f(first - second);
  if (first > second) {
    if (difference > 180) difference = f(difference - 360);
  } else if (difference < -180) difference = f(difference + 360);
  return difference;
}

export function botChangeViewAngle(angle: number, ideal: number, speed: number): number {
  angle = qvmAngleMod(angle);
  ideal = qvmAngleMod(ideal);
  if (angle === ideal) return angle;
  let move = f(ideal - angle);
  if (ideal > angle) {
    if (move > 180) move = f(move - 360);
  } else if (move < -180) move = f(move + 360);
  if (move > 0) {
    if (move > speed) move = speed;
  } else if (move < -speed) move = -speed;
  return qvmAngleMod(f(angle + move));
}

export function botChangeViewAngles(context: GameAiContext, state: BotState, thinkTime: number): void {
  if (state.idealViewangles.x > 180) {
    Object.assign(state.idealViewangles, { x: f(state.idealViewangles.x - 360) });
  }
  const factor = state.enemy >= 0
    ? context.library.characters.boundedFloat(state.character, Characteristic.ViewFactor, f(0.01), 1) : f(0.05);
  let maximum = state.enemy >= 0
    ? context.library.characters.boundedFloat(state.character, Characteristic.ViewMaxChange, 1, 1800) : 360;
  if (maximum < 240) maximum = 240;
  maximum = f(maximum * thinkTime);
  for (const axis of viewAxes) {
    let angle = state.viewangles[axis], ideal = state.idealViewangles[axis];
    let angularVelocity = state.viewangleSpeed[axis];
    if (context.cvar("bot_challenge").integerValue !== 0) {
      const difference = sourceAbs(qvmFloatToInt(botAngleDifference(angle, ideal)));
      let speed = f(f(difference) * factor);
      if (speed > maximum) speed = maximum;
      angle = botChangeViewAngle(angle, ideal, speed);
    } else {
      angle = qvmAngleMod(angle);
      ideal = qvmAngleMod(ideal);
      const desired = f(botAngleDifference(angle, ideal) * factor);
      angularVelocity = f(angularVelocity + f(angularVelocity - desired));
      if (angularVelocity > 180) angularVelocity = maximum;
      if (angularVelocity < -180) angularVelocity = -maximum;
      let speed = angularVelocity;
      if (speed > maximum) speed = maximum;
      if (speed < -maximum) speed = -maximum;
      angle = qvmAngleMod(f(angle + speed));
      angularVelocity = f(angularVelocity * f(f(0.45) * f(1 - factor)));
    }
    Object.assign(state.viewangles, { [axis]: angle });
    Object.assign(state.idealViewangles, { [axis]: ideal });
    Object.assign(state.viewangleSpeed, { [axis]: angularVelocity });
  }
  if (state.viewangles.x > 180) Object.assign(state.viewangles, { x: f(state.viewangles.x - 360) });
  context.library.actions.view(state.client, state.viewangles);
}

function signedByte(value: number): number { return (value << 24) >> 24; }
function commandAngle(angle: number, delta: number): number {
  const encoded = qvmFloatToInt(f(f(angle * 65536) / 360)) & 65535;
  return ((encoded - delta) << 16) >> 16;
}

/** The input is the detached EA_GetInput result; only the caller's usercmd is retained. */
export function botInputToUserCommand(input: BotInput, command: UserCommand, deltaAngles: Vec3, time: number): void {
  let flags = input.actionFlags;
  if ((flags & BotActionFlag.DELAYED_JUMP) !== 0) flags = (flags | BotActionFlag.JUMP) & ~BotActionFlag.DELAYED_JUMP;
  command.serverTime = time;
  command.buttons = 0;
  if ((flags & (BotActionFlag.RESPAWN | BotActionFlag.ATTACK)) !== 0) command.buttons = CommandButtons.ATTACK;
  const buttons: readonly (readonly [BotActionFlag, CommandButtons])[] = [
    [BotActionFlag.TALK, CommandButtons.TALK], [BotActionFlag.GESTURE, CommandButtons.GESTURE],
    [BotActionFlag.USE, CommandButtons.USE_HOLDABLE], [BotActionFlag.WALK, CommandButtons.WALKING],
    [BotActionFlag.AFFIRMATIVE, CommandButtons.AFFIRMATIVE], [BotActionFlag.NEGATIVE, CommandButtons.NEGATIVE],
    [BotActionFlag.GET_FLAG, CommandButtons.GETFLAG], [BotActionFlag.GUARD_BASE, CommandButtons.GUARDBASE],
    [BotActionFlag.PATROL, CommandButtons.PATROL], [BotActionFlag.FOLLOW_ME, CommandButtons.FOLLOWME],
  ];
  for (const [action, button] of buttons) if ((flags & action) !== 0) command.buttons |= button;
  command.weapon = input.weapon & 255;
  Object.assign(command.angles, vec3(commandAngle(input.viewAngles.x, deltaAngles.x), commandAngle(input.viewAngles.y, deltaAngles.y), commandAngle(input.viewAngles.z, deltaAngles.z)));
  const angles = vec3(input.direction.z !== 0 ? input.viewAngles.x : 0, input.viewAngles.y, 0);
  const vectors = qvmAngleVectors(angles);
  const speed = f(f(input.speed * 127) / 400);
  command.forwardmove = signedByte(qvmFloatToInt(f(dot3(vectors.forward, input.direction) * speed)));
  command.rightmove = signedByte(qvmFloatToInt(f(dot3(vectors.right, input.direction) * speed)));
  command.upmove = signedByte(qvmFloatToInt(f(f(f(sourceAbs(qvmFloatToInt(vectors.forward.z))) * input.direction.z) * speed)));
  if ((flags & BotActionFlag.MOVE_FORWARD) !== 0) command.forwardmove = signedByte(command.forwardmove + 127);
  if ((flags & BotActionFlag.MOVE_BACK) !== 0) command.forwardmove = signedByte(command.forwardmove - 127);
  if ((flags & BotActionFlag.MOVE_LEFT) !== 0) command.rightmove = signedByte(command.rightmove - 127);
  if ((flags & BotActionFlag.MOVE_RIGHT) !== 0) command.rightmove = signedByte(command.rightmove + 127);
  if ((flags & BotActionFlag.JUMP) !== 0) command.upmove = signedByte(command.upmove + 127);
  if ((flags & BotActionFlag.CROUCH) !== 0) command.upmove = signedByte(command.upmove - 127);
}

export function botAddDeltaAngles(state: BotState): void {
  const angles = state.viewangles, delta = state.curPs.deltaAngles;
  Object.assign(state.viewangles, vec3(qvmAngleMod(f(angles.x + f(f(delta.x) * f(360 / 65536)))),
    qvmAngleMod(f(angles.y + f(f(delta.y) * f(360 / 65536)))), qvmAngleMod(f(angles.z + f(f(delta.z) * f(360 / 65536))))));
}

export function botSubtractDeltaAngles(state: BotState): void {
  const angles = state.viewangles, delta = state.curPs.deltaAngles;
  Object.assign(state.viewangles, vec3(qvmAngleMod(f(angles.x - f(f(delta.x) * f(360 / 65536)))),
    qvmAngleMod(f(angles.y - f(f(delta.y) * f(360 / 65536)))), qvmAngleMod(f(angles.z - f(f(delta.z) * f(360 / 65536))))));
}

export function botUpdateInput(context: GameAiContext, state: BotState, time: number, elapsedTime: number): void {
  botAddDeltaAngles(state);
  botChangeViewAngles(context, state, f(f(elapsedTime) / 1000));
  let input = context.library.actions.getInput(state.client, f(f(time) / 1000));
  if ((input.actionFlags & BotActionFlag.RESPAWN) !== 0 && (state.lastUcmd.buttons & CommandButtons.ATTACK) !== 0) {
    input = { ...input, actionFlags: input.actionFlags & ~(BotActionFlag.RESPAWN | BotActionFlag.ATTACK) };
  }
  botInputToUserCommand(input, state.lastUcmd, state.curPs.deltaAngles, time);
  botSubtractDeltaAngles(state);
}
