/*
 * Player lerp-frame timing translated from Quake III Arena's
 * cgame/cg_players.c CG_SetLerpFrameAnimation, CG_RunLerpFrame and
 * CG_ClearLerpFrame.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Animation, PlayerAnimationConfig } from "../assets/animation.ts";
import { CommonError } from "../core/common-error.ts";
import { PlayerAnimation } from "../shared/player-state.ts";
import { qvmFloatToInt } from "../core/numeric.ts";

export const ANIMATION_TOGGLE_BIT = 128;
const MAX_TOTAL_ANIMATIONS = PlayerAnimation.FLAG_STAND2RUN + 1;

export interface LerpFrame {
  oldFrame: number;
  oldFrameTime: number;
  frame: number;
  frameTime: number;
  backLerp: number;
  animationNumber: number;
  currentAnimation: Animation | null;
  animationTime: number;
}

export interface RunLerpFrameInput {
  readonly timeMs: number;
  readonly newAnimation: number;
  readonly speedScale: number;
  readonly noPlayerAnimations: boolean;
}

type AnimationSet = Pick<PlayerAnimationConfig, "animations">;

export function createLerpFrame(): LerpFrame {
  return {
    oldFrame: 0,
    oldFrameTime: 0,
    frame: 0,
    frameTime: 0,
    backLerp: 0,
    animationNumber: 0,
    currentAnimation: null,
    animationTime: 0,
  };
}

function clock(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`animation clock ${value} is outside int32 milliseconds`);
  }
}

function animationNumber(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`animation number ${value} is outside int32`);
  }
}

function animationAt(config: AnimationSet, index: number): Animation {
  if (index < 0 || index >= MAX_TOTAL_ANIMATIONS) throw new CommonError("drop", `Bad animation number: ${index}`);
  const animation = config.animations[index];
  if (animation === undefined || animation === null) throw new RangeError(`animation slot ${index} is not playable`);
  return animation;
}

/** Select an animation and schedule its first exact frame after the current frame. */
export function setLerpFrameAnimation(config: AnimationSet, state: LerpFrame, newAnimation: number, print: ((message: string) => void) | null = null): void {
  animationNumber(newAnimation);
  state.animationNumber = newAnimation;
  const animation = animationAt(config, newAnimation & ~ANIMATION_TOGGLE_BIT);
  state.currentAnimation = animation;
  state.animationTime = (state.frameTime + animation.initialLerp) | 0;
  if (print !== null) print(`Anim: ${newAnimation & ~ANIMATION_TOGGLE_BIT}\n`);
}

function currentAnimation(state: LerpFrame): Animation {
  if (state.currentAnimation === null) throw new Error("lerp frame has no current animation");
  return state.currentAnimation;
}

/** Advance one source lerp-frame step for an explicit cgame clock value. */
export function runLerpFrame(config: AnimationSet, state: LerpFrame, input: RunLerpFrameInput, print: ((message: string) => void) | null = null): void {
  if (input.noPlayerAnimations) {
    state.oldFrame = 0;
    state.frame = 0;
    state.backLerp = 0;
    return;
  }
  clock(input.timeMs);
  animationNumber(input.newAnimation);
  if (!Number.isFinite(input.speedScale) || input.speedScale < 0) {
    throw new RangeError(`animation speed scale ${input.speedScale} must be finite and non-negative`);
  }
  if (input.newAnimation !== state.animationNumber || state.currentAnimation === null) {
    setLerpFrameAnimation(config, state, input.newAnimation, print);
  }
  if (input.timeMs >= state.frameTime) {
    state.oldFrame = state.frame;
    state.oldFrameTime = state.frameTime;
    const animation = currentAnimation(state);
    if (animation.frameLerp === 0) return;
    if (input.timeMs < state.animationTime) state.frameTime = state.animationTime;
    else state.frameTime = (state.oldFrameTime + animation.frameLerp) | 0;
    let frameOffset = Math.trunc(((state.frameTime - state.animationTime) | 0) / animation.frameLerp);
    frameOffset = qvmFloatToInt(Math.fround(Math.fround(frameOffset) * Math.fround(input.speedScale)));
    let frameCount = animation.numFrames;
    if (animation.flipflop) frameCount = Math.imul(frameCount, 2);
    if (frameOffset >= frameCount) {
      frameOffset = (frameOffset - frameCount) | 0;
      if (animation.loopFrames !== 0) {
        frameOffset %= animation.loopFrames;
        frameOffset = (frameOffset + animation.numFrames - animation.loopFrames) | 0;
      } else {
        frameOffset = frameCount - 1;
        state.frameTime = input.timeMs;
      }
    }
    if (animation.reversed) {
      state.frame = (animation.firstFrame + animation.numFrames - 1 - frameOffset) | 0;
    } else if (animation.flipflop && frameOffset >= animation.numFrames) {
      state.frame = (animation.firstFrame + animation.numFrames - 1 - (frameOffset % animation.numFrames)) | 0;
    } else {
      state.frame = (animation.firstFrame + frameOffset) | 0;
    }
    if (input.timeMs > state.frameTime) {
      state.frameTime = input.timeMs;
      if (print !== null) print("Clamp lf->frameTime\n");
    }
  }
  if (state.frameTime > ((input.timeMs + 200) | 0)) state.frameTime = input.timeMs;
  if (state.oldFrameTime > input.timeMs) state.oldFrameTime = input.timeMs;
  if (state.frameTime === state.oldFrameTime) {
    state.backLerp = 0;
  } else {
    const elapsed = Math.fround((input.timeMs - state.oldFrameTime) | 0);
    const duration = Math.fround((state.frameTime - state.oldFrameTime) | 0);
    const fraction = Math.fround(elapsed / duration);
    state.backLerp = Math.fround(1 - fraction);
  }
}

/** Reset interpolation to an animation's first stored frame at the supplied clock. */
export function clearLerpFrame(
  config: AnimationSet,
  state: LerpFrame,
  animation: number,
  timeMs: number,
  print: ((message: string) => void) | null = null,
): void {
  clock(timeMs);
  state.frameTime = timeMs;
  state.oldFrameTime = timeMs;
  setLerpFrameAnimation(config, state, animation, print);
  const selected = currentAnimation(state);
  state.oldFrame = selected.firstFrame;
  state.frame = selected.firstFrame;
}
