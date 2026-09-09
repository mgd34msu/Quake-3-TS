/*
 * Player animation.cfg parsing translated from Quake III Arena's
 * cgame/cg_players.c CG_ParseAnimationFile.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { TextParseError } from "../core/text.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { PlayerAnimation } from "../shared/player-state.ts";
import { gameAtof, gameAtoi } from "../game/numeric.ts";
import { gameFormat } from "../game/format.ts";
import type { GameFormatArgument } from "../game/format.ts";

const MAX_TEXT_BYTES = 19_998;
const SOURCE_ANIMATION_COUNT = PlayerAnimation.TORSO_NEGATIVE + 1;
const TOTAL_ANIMATION_COUNT = PlayerAnimation.FLAG_STAND2RUN + 1;
const MAX_ANIMATIONS_SENTINEL = SOURCE_ANIMATION_COUNT;

export type PlayerFootsteps = "normal" | "boot" | "flesh" | "mech" | "energy";
export type PlayerGender = "male" | "female" | "neuter";

export interface Animation {
  readonly firstFrame: number;
  readonly numFrames: number;
  readonly loopFrames: number;
  readonly frameLerp: number;
  readonly initialLerp: number;
  readonly reversed: boolean;
  readonly flipflop: boolean;
}

export type AnimationCell = { -readonly [Field in keyof Animation]: Animation[Field] };

export interface PlayerAnimationTarget {
  footsteps: PlayerFootsteps;
  headOffset: Vec3;
  gender: PlayerGender;
  fixedLegs: boolean;
  fixedTorso: boolean;
  readonly animations: readonly AnimationCell[];
}

export interface PlayerAnimationParseContext {
  readonly target: PlayerAnimationTarget;
  readonly parser: CommonParseState;
  print(message: string): void;
}

export class PlayerAnimationParseError extends TextParseError {}

export interface AnimationWarning {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface PlayerAnimationConfig {
  readonly footsteps: PlayerFootsteps;
  readonly headOffset: Vec3;
  readonly gender: PlayerGender;
  readonly fixedLegs: boolean;
  readonly fixedTorso: boolean;
  /** Indexed by PlayerAnimation. The MAX_ANIMATIONS sentinel at index 31 is null. */
  readonly animations: readonly (Animation | null)[];
  readonly warnings: readonly AnimationWarning[];
}

function cell(target: PlayerAnimationTarget, index: PlayerAnimation): AnimationCell {
  const animation = target.animations[index];
  if (animation === undefined) throw new RangeError(`Missing client animation cell ${index}`);
  return animation;
}

/** Parse into retained clientInfo_t cells; standalone callers receive an owned diagnostic snapshot. */
export function parsePlayerAnimationConfig(text: string, source = "<animation.cfg>", context: PlayerAnimationParseContext | null = null): PlayerAnimationConfig {
  const target: PlayerAnimationTarget = context?.target ?? {
    footsteps: "normal", headOffset: { x: 0, y: 0, z: 0 }, gender: "male", fixedLegs: false, fixedTorso: false,
    animations: Array.from({ length: TOTAL_ANIMATION_COUNT }, () => ({ firstFrame: 0, numFrames: 0,
      loopFrames: 0, frameLerp: 0, initialLerp: 0, reversed: false, flipflop: false })),
  };
  const parser = context?.parser ?? new CommonParseState();
  const warnings: AnimationWarning[] = [];
  const print = (format: string, args: readonly GameFormatArgument[]): string => {
    const message = gameFormat(format, args);
    if (message.length >= 1024) throw new RangeError("CG_Printf exceeds its 1024-byte source buffer");
    context?.print(message);
    return message;
  };
  const warn = (format: string, args: readonly GameFormatArgument[]): void => {
    const message = print(format, args);
    warnings.push({ line: (parser.line + 1) | 0, column: 1, message });
  };
  if (text.length === 0) throw new PlayerAnimationParseError(source, 1, 1, "empty animation file");
  if (text.length > MAX_TEXT_BYTES) {
    const message = print("File %s too long\n", [source]);
    throw new PlayerAnimationParseError(source, 1, 1, message);
  }
  const cursor = new CommonParseCursor(text);
  target.footsteps = "normal";
  target.headOffset = { x: 0, y: 0, z: 0 };
  target.gender = "male";
  target.fixedLegs = false;
  target.fixedTorso = false;

  while (true) {
    const previous = cursor.offset, token = parser.parse(cursor), directive = token.toLowerCase();
    if (directive === "footsteps") {
      const value = parser.parse(cursor), footstep = value.toLowerCase();
      if (footstep === "default" || footstep === "normal") target.footsteps = "normal";
      else if (footstep === "boot" || footstep === "flesh" || footstep === "mech" || footstep === "energy") target.footsteps = footstep;
      else warn("Bad footsteps parm in %s: %s\n", [source, value]);
    } else if (directive === "headoffset") {
      for (const component of ["x", "y", "z"] satisfies readonly (keyof Vec3)[]) {
        const value = gameAtof(parser.parse(cursor));
        target.headOffset = { ...target.headOffset, [component]: value };
      }
    } else if (directive === "sex") {
      const first = parser.parse(cursor).charAt(0).toLowerCase();
      target.gender = first === "f" ? "female" : first === "n" ? "neuter" : "male";
    } else if (directive === "fixedlegs") {
      target.fixedLegs = true;
    } else if (directive === "fixedtorso") {
      target.fixedTorso = true;
    } else {
      const first = token.charAt(0);
      if (first >= "0" && first <= "9") { cursor.offset = previous; break; }
      warn("unknown token '%s' is %s\n", [token, source]);
      if (previous === cursor.offset) throw new RangeError("CG animation prelude reached the source nonprogress cycle");
    }
  }

  let skip = 0, index = 0;
  for (; index < SOURCE_ANIMATION_COUNT; index++) {
    const firstToken = parser.parse(cursor), animation = cell(target, index);
    if (!firstToken) {
      if (index >= PlayerAnimation.TORSO_GETFLAG && index <= PlayerAnimation.TORSO_NEGATIVE) {
        const gesture = cell(target, PlayerAnimation.TORSO_GESTURE);
        animation.firstFrame = gesture.firstFrame;
        animation.frameLerp = gesture.frameLerp;
        animation.initialLerp = gesture.initialLerp;
        animation.loopFrames = gesture.loopFrames;
        animation.numFrames = gesture.numFrames;
        animation.reversed = false;
        animation.flipflop = false;
        continue;
      }
      break;
    }
    animation.firstFrame = gameAtoi(firstToken);
    if (index === PlayerAnimation.LEGS_WALKCR) {
      skip = (animation.firstFrame - cell(target, PlayerAnimation.TORSO_GESTURE).firstFrame) | 0;
    }
    if (index >= PlayerAnimation.LEGS_WALKCR && index < PlayerAnimation.TORSO_GETFLAG) animation.firstFrame = (animation.firstFrame - skip) | 0;
    const countToken = parser.parse(cursor);
    if (!countToken) break;
    animation.numFrames = gameAtoi(countToken);
    animation.reversed = false;
    animation.flipflop = false;
    if (animation.numFrames < 0) { animation.numFrames = -animation.numFrames | 0; animation.reversed = true; }
    const loopToken = parser.parse(cursor);
    if (!loopToken) break;
    animation.loopFrames = gameAtoi(loopToken);
    const fpsToken = parser.parse(cursor);
    if (!fpsToken) break;
    let fps = gameAtof(fpsToken);
    if (fps === 0) fps = 1;
    animation.frameLerp = qvmFloatToInt(Math.fround(1000 / fps));
    animation.initialLerp = qvmFloatToInt(Math.fround(1000 / fps));
  }
  if (index !== SOURCE_ANIMATION_COUNT) {
    const message = print("Error parsing animation file: %s", [source]);
    throw new PlayerAnimationParseError(source, (parser.line + 1) | 0, 1, message);
  }

  Object.assign(cell(target, PlayerAnimation.LEGS_BACKCR), cell(target, PlayerAnimation.LEGS_WALKCR), { reversed: true });
  Object.assign(cell(target, PlayerAnimation.LEGS_BACKWALK), cell(target, PlayerAnimation.LEGS_WALK), { reversed: true });
  Object.assign(cell(target, PlayerAnimation.FLAG_RUN), { firstFrame: 0, numFrames: 16, loopFrames: 16, frameLerp: 66, initialLerp: 66, reversed: false });
  Object.assign(cell(target, PlayerAnimation.FLAG_STAND), { firstFrame: 16, numFrames: 5, loopFrames: 0, frameLerp: 50, initialLerp: 50, reversed: false });
  Object.assign(cell(target, PlayerAnimation.FLAG_STAND2RUN), { firstFrame: 16, numFrames: 5, loopFrames: 1, frameLerp: 66, initialLerp: 66, reversed: true });
  return { footsteps: target.footsteps, headOffset: { ...target.headOffset }, gender: target.gender,
    fixedLegs: target.fixedLegs, fixedTorso: target.fixedTorso,
    animations: target.animations.map((animation, index) => index === MAX_ANIMATIONS_SENTINEL ? null : { ...animation }), warnings };
}
