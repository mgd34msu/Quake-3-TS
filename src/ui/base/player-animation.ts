// UI_SetLerpFrameAnimation and UI_RunLerpFrame from id Software q3_ui/ui_players.c:345–421.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Animation } from "../../assets/animation.ts";
import { CommonError } from "../../core/common-error.ts";
import { PlayerAnimation } from "../../shared/player-state.ts";

export interface BasePlayerLerpFrame {
  oldFrame: number;
  oldFrameTime: number;
  frame: number;
  frameTime: number;
  backLerp: number;
  animationNumber: number;
  currentAnimation: Animation | null;
  animationTime: number;
}

const ANIM_TOGGLEBIT = 128;
const ANIMATION_COUNT = PlayerAnimation.TORSO_NEGATIVE + 1;

function integer(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw new RangeError(`Invalid source UI animation integer: ${field}`);
  return value | 0;
}
function quotient(numerator: number, denominator: number): number {
  if (denominator === 0 || (numerator === -2147483648 && denominator === -1))
    throw new RangeError("Undefined source UI animation integer division");
  return Math.trunc(numerator / denominator) | 0;
}
function remainder(numerator: number, denominator: number): number {
  if (denominator === 0 || (numerator === -2147483648 && denominator === -1))
    throw new RangeError("Undefined source UI animation integer remainder");
  return (numerator % denominator) | 0;
}

export function setBasePlayerLerpFrameAnimation(animations: readonly Animation[], frame: BasePlayerLerpFrame, animationNumber: number): void {
  const raw = integer(animationNumber, "animationNumber");
  frame.animationNumber = raw;
  const selected = raw & ~ANIM_TOGGLEBIT;
  if (selected < 0 || selected >= ANIMATION_COUNT) throw new CommonError("drop", `Bad animation number: ${selected}`);
  const animation = animations[selected];
  if (animation === undefined) throw new RangeError(`Missing source UI animation slot ${selected}`);
  frame.currentAnimation = animation;
  frame.animationTime = (integer(frame.frameTime, "frameTime") + integer(animation.initialLerp, "initialLerp")) | 0;
}

export function runBasePlayerLerpFrame(animations: readonly Animation[], frame: BasePlayerLerpFrame,
  input: { readonly animationNumber: number; readonly realtime: number }): void {
  const animationNumber = integer(input.animationNumber, "animationNumber"), realtime = integer(input.realtime, "realtime");
  if (animationNumber !== integer(frame.animationNumber, "stored animationNumber") || frame.currentAnimation === null)
    setBasePlayerLerpFrameAnimation(animations, frame, animationNumber);

  if (realtime >= integer(frame.frameTime, "frameTime")) {
    frame.oldFrame = integer(frame.frame, "frame");
    frame.oldFrameTime = integer(frame.frameTime, "frameTime");
    const animation = frame.currentAnimation;
    if (animation === null) throw new RangeError("Missing source UI current animation");
    if (realtime < integer(frame.animationTime, "animationTime"))
      frame.frameTime = integer(frame.animationTime, "animationTime");
    else
      frame.frameTime = (integer(frame.oldFrameTime, "oldFrameTime") + integer(animation.frameLerp, "frameLerp")) | 0;
    let offset = quotient((integer(frame.frameTime, "frameTime") - integer(frame.animationTime, "animationTime")) | 0,
      integer(animation.frameLerp, "frameLerp"));
    if (offset >= integer(animation.numFrames, "numFrames")) {
      offset = (offset - integer(animation.numFrames, "numFrames")) | 0;
      if (integer(animation.loopFrames, "loopFrames") !== 0) {
        offset = remainder(offset, integer(animation.loopFrames, "loopFrames"));
        offset = (offset + ((integer(animation.numFrames, "numFrames") - integer(animation.loopFrames, "loopFrames")) | 0)) | 0;
      } else {
        offset = (integer(animation.numFrames, "numFrames") - 1) | 0;
        frame.frameTime = realtime;
      }
    }
    frame.frame = (integer(animation.firstFrame, "firstFrame") + offset) | 0;
    if (realtime > integer(frame.frameTime, "frameTime")) frame.frameTime = realtime;
  }

  if (integer(frame.frameTime, "frameTime") > ((realtime + 200) | 0)) frame.frameTime = realtime;
  if (integer(frame.oldFrameTime, "oldFrameTime") > realtime) frame.oldFrameTime = realtime;
  if (integer(frame.frameTime, "frameTime") === integer(frame.oldFrameTime, "oldFrameTime")) frame.backLerp = 0;
  else {
    const elapsed = (realtime - integer(frame.oldFrameTime, "oldFrameTime")) | 0;
    const duration = (integer(frame.frameTime, "frameTime") - integer(frame.oldFrameTime, "oldFrameTime")) | 0;
    frame.backLerp = Math.fround(1 - Math.fround(Math.fround(elapsed) / Math.fround(duration)));
  }
}
