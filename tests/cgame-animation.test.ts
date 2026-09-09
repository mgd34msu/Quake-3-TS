import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Animation, PlayerAnimationConfig } from "../src/assets/animation.ts";
import { parsePlayerAnimationConfig } from "../src/assets/animation.ts";
import {
  ANIMATION_TOGGLE_BIT,
  clearLerpFrame,
  createLerpFrame,
  runLerpFrame,
  setLerpFrameAnimation,
} from "../src/cgame/animation.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { ClientInfo } from "../src/cgame/client-info.ts";
import { CommonError } from "../src/core/common-error.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";

const baseAnimation: Animation = {
  firstFrame: 10,
  numFrames: 4,
  loopFrames: 0,
  frameLerp: 100,
  initialLerp: 50,
  reversed: false,
  flipflop: false,
};

function animationSet(animation: Animation, slot = 0): Pick<PlayerAnimationConfig, "animations"> {
  const animations: (Animation | null)[] = [];
  for (let index = 0; index < 37; index++) animations.push(index === 31 ? null : baseAnimation);
  animations[slot] = animation;
  return { animations };
}

function step(
  config: Pick<PlayerAnimationConfig, "animations">,
  state: ReturnType<typeof createLerpFrame>,
  timeMs: number,
  newAnimation = 0,
  speedScale = 1,
): void {
  runLerpFrame(config, state, { timeMs, newAnimation, speedScale, noPlayerAnimations: false });
}

describe("cgame lerp-frame animation", () => {
  test("sets and clears an animation using frameTime plus initialLerp", () => {
    const config = animationSet(baseAnimation);
    const state = createLerpFrame();
    state.frameTime = 25;
    setLerpFrameAnimation(config, state, ANIMATION_TOGGLE_BIT);
    expect(state.animationNumber).toBe(ANIMATION_TOGGLE_BIT);
    expect(state.currentAnimation).toBe(baseAnimation);
    expect(state.animationTime).toBe(75);

    clearLerpFrame(config, state, 0, 100);
    expect(state).toEqual({
      oldFrame: 10,
      oldFrameTime: 100,
      frame: 10,
      frameTime: 100,
      backLerp: 0,
      animationNumber: 0,
      currentAnimation: baseAnimation,
      animationTime: 150,
    });
  });

  test("honors initial lerp and computes float32 backlerp at exact boundaries", () => {
    const config = animationSet(baseAnimation);
    const state = createLerpFrame();
    clearLerpFrame(config, state, 0, 100);
    step(config, state, 100);
    expect(state.frame).toBe(10);
    expect(state.oldFrame).toBe(10);
    expect(state.frameTime).toBe(150);
    expect(state.oldFrameTime).toBe(100);
    expect(state.backLerp).toBe(1);
    step(config, state, 125);
    expect(state.backLerp).toBe(0.5);
    step(config, state, 150);
    expect(state.oldFrame).toBe(10);
    expect(state.frame).toBe(11);
    expect(state.oldFrameTime).toBe(150);
    expect(state.frameTime).toBe(250);
    expect(state.backLerp).toBe(1);
  });

  test("the toggle bit restarts the same underlying animation", () => {
    const config = animationSet(baseAnimation);
    const state = createLerpFrame();
    clearLerpFrame(config, state, 0, 100);
    step(config, state, 100);
    step(config, state, 150);
    step(config, state, 200, ANIMATION_TOGGLE_BIT);
    expect(state.animationNumber).toBe(ANIMATION_TOGGLE_BIT);
    expect(state.animationTime).toBe(300);
    expect(state.frame).toBe(11);
    step(config, state, 250, ANIMATION_TOGGLE_BIT);
    expect(state.oldFrame).toBe(11);
    expect(state.frame).toBe(10);
    expect(state.frameTime).toBe(300);
  });

  test("reversed looping and flipflop use the source frame offset order", () => {
    const reversed: Animation = {
      firstFrame: 10, numFrames: 4, loopFrames: 2,
      frameLerp: 100, initialLerp: 0, reversed: true, flipflop: false,
    };
    const reversedConfig = animationSet(reversed);
    const reversedState = createLerpFrame();
    clearLerpFrame(reversedConfig, reversedState, 0, 0);
    const reversedFrames: number[] = [];
    for (const timeMs of [0, 100, 200, 300, 400]) {
      step(reversedConfig, reversedState, timeMs);
      reversedFrames.push(reversedState.frame);
    }
    expect(reversedFrames).toEqual([12, 11, 10, 11, 10]);

    const flipflop: Animation = {
      firstFrame: 20, numFrames: 3, loopFrames: 0,
      frameLerp: 100, initialLerp: 0, reversed: false, flipflop: true,
    };
    const flipflopConfig = animationSet(flipflop);
    const flipflopState = createLerpFrame();
    clearLerpFrame(flipflopConfig, flipflopState, 0, 0);
    const flipflopFrames: number[] = [];
    for (const timeMs of [0, 100, 200, 300, 400]) {
      step(flipflopConfig, flipflopState, timeMs);
      flipflopFrames.push(flipflopState.frame);
    }
    expect(flipflopFrames).toEqual([21, 22, 22, 21, 20]);
  });

  test("drops only one scheduled frame per call and clamps ended animations to now", () => {
    const animation: Animation = { ...baseAnimation, firstFrame: 20, numFrames: 3, initialLerp: 0 };
    const config = animationSet(animation);
    const state = createLerpFrame();
    clearLerpFrame(config, state, 0, 0);
    step(config, state, 1000);
    expect(state.oldFrame).toBe(20);
    expect(state.frame).toBe(21);
    expect(state.oldFrameTime).toBe(0);
    expect(state.frameTime).toBe(1000);
    expect(state.backLerp).toBe(0);
    step(config, state, 1000);
    expect(state.oldFrame).toBe(21);
    expect(state.frame).toBe(22);
    expect(state.frameTime).toBe(1000);
  });

  test("truncates scaled frame offsets like an int compound assignment", () => {
    const animation: Animation = { ...baseAnimation, firstFrame: 0, numFrames: 10, initialLerp: 0 };
    const config = animationSet(animation);
    const state = createLerpFrame();
    clearLerpFrame(config, state, 0, 0);
    step(config, state, 0, 0, 1.5);
    expect(state.frame).toBe(1);
    step(config, state, 100, 0, 1.5);
    expect(state.frame).toBe(3);
  });

  test("clamps frame times more than 200ms in the future", () => {
    const animation: Animation = { ...baseAnimation, initialLerp: 500 };
    const config = animationSet(animation);
    const state = createLerpFrame();
    step(config, state, 0);
    expect(state.animationTime).toBe(500);
    expect(state.frameTime).toBe(0);
    expect(state.oldFrameTime).toBe(0);
    expect(state.backLerp).toBe(0);
    step(config, state, 100);
    expect(state.frameTime).toBe(100);
    expect(state.oldFrameTime).toBe(0);
  });

  test("noPlayerAnimations zeros frame output without switching timing state", () => {
    const config = animationSet(baseAnimation);
    const state = createLerpFrame();
    clearLerpFrame(config, state, 0, 100);
    state.oldFrame = 8;
    state.frame = 9;
    state.backLerp = 0.75;
    runLerpFrame(config, state, {
      timeMs: Number.NaN,
      newAnimation: -999,
      speedScale: Number.NaN,
      noPlayerAnimations: true,
    });
    expect(state).toEqual({
      oldFrame: 0,
      oldFrameTime: 100,
      frame: 0,
      frameTime: 100,
      backLerp: 0,
      animationNumber: 0,
      currentAnimation: baseAnimation,
      animationTime: 150,
    });
  });

  test("preserves the source early return for a zero frame lerp", () => {
    const stopped: Animation = { ...baseAnimation, frameLerp: 0 };
    const config = animationSet(stopped);
    const state = createLerpFrame();
    clearLerpFrame(config, state, 0, 50);
    state.frameTime = 500;
    state.oldFrameTime = 400;
    step(config, state, 600);
    expect(state.oldFrameTime).toBe(500);
    expect(state.frameTime).toBe(500);
    expect(state.backLerp).toBe(0);
  });

  test("publishes the unstripped animation number before a source bounds drop", () => {
    const config = animationSet(baseAnimation);
    for (const [number, index] of [[37, 37], [165, 37], [-1, -129], [-2147483648, -2147483648], [2147483647, 2147483519]] satisfies readonly (readonly [number, number])[]) {
      const state = createLerpFrame(), printed: string[] = [];
      clearLerpFrame(config, state, 0, 100);
      const before = { ...state };
      let thrown: unknown = null;
      try { setLerpFrameAnimation(config, state, number, message => { printed.push(message); }); }
      catch (error) { thrown = error; }
      expect(state).toEqual({ ...before, animationNumber: number });
      expect(state.currentAnimation).toBe(before.currentAnimation);
      expect(thrown).toBeInstanceOf(CommonError);
      expect(thrown).toMatchObject({ code: "drop", message: `Bad animation number: ${index}` });
      expect(printed).toEqual([]);
    }
  });

  test("rejects non-int32 animation inputs before publishing source state", () => {
    const config = animationSet(baseAnimation), state = createLerpFrame();
    clearLerpFrame(config, state, 0, 100);
    const before = { ...state };
    for (const number of [0.5, Number.NaN, Number.POSITIVE_INFINITY, -2147483649, 2147483648]) {
      expect(() => setLerpFrameAnimation(config, state, number)).toThrow(RangeError);
      expect(state).toEqual(before);
    }
  });

  test("keeps missing animation storage and invalid step inputs separate from source drops", () => {
    const config = animationSet(baseAnimation);
    const state = createLerpFrame();
    expect(() => setLerpFrameAnimation(config, state, 31)).toThrow(new RangeError("animation slot 31 is not playable"));
    expect(() => setLerpFrameAnimation(config, state, 31)).toThrow(RangeError);
    expect(() => setLerpFrameAnimation({ animations: [] }, state, 0)).toThrow(new RangeError("animation slot 0 is not playable"));
    expect(() => setLerpFrameAnimation({ animations: [] }, state, 0)).toThrow(RangeError);
    expect(() => runLerpFrame(config, state, {
      timeMs: 0, newAnimation: 0, speedScale: Number.NaN, noPlayerAnimations: false,
    })).toThrow("speed scale");
  });
});

describe("cgame client animation storage", () => {
  test("parser omission leaves the source BSS sentinel allocated and playable", () => {
    const ci = new ClientInfo(), cells = ci.animations, sentinel = cells[31];
    if (sentinel === undefined) throw new Error("Missing sentinel cell");
    ci.setAnimations(parsePlayerAnimationConfig("0 8 8 20\n".repeat(31)).animations);
    expect(ci.animations).toBe(cells);
    expect(ci.animations[31]).toBe(sentinel);
    expect(sentinel).toEqual({ firstFrame: 0, numFrames: 0, loopFrames: 0, frameLerp: 0, initialLerp: 0, reversed: false, flipflop: false });
    const state = createLerpFrame();
    state.frame = 7; state.backLerp = 0.25;
    step(ci, state, 1000, 31);
    expect(state.currentAnimation).toBe(sentinel);
    expect([state.oldFrame, state.frame, state.oldFrameTime, state.frameTime, state.backLerp]).toEqual([7, 7, 0, 0, 0.25]);
  });

  test("retains the selected client's actual animation cell until the animation changes", () => {
    const first = new ClientInfo(), second = new ClientInfo();
    const animation: Animation = { ...baseAnimation, numFrames: 8, loopFrames: 8, initialLerp: 100 };
    first.setAnimations(animationSet(animation, PlayerAnimation.LEGS_RUN).animations);
    second.setAnimations(animationSet({ ...animation, firstFrame: 1000 }, PlayerAnimation.LEGS_RUN).animations);
    const state = createLerpFrame();
    step(first, state, 0, PlayerAnimation.LEGS_RUN);
    const selected = state.currentAnimation;
    step(second, state, 100, PlayerAnimation.LEGS_RUN);
    expect(state.currentAnimation).toBe(selected);
    expect([state.oldFrame, state.frame, state.animationTime, state.frameTime]).toEqual([10, 11, 100, 200]);
    first.setAnimations(animationSet({ ...animation, firstFrame: 100, frameLerp: 50 }, PlayerAnimation.LEGS_RUN).animations);
    expect(state.currentAnimation?.firstFrame).toBe(100);
    step(second, state, 200, PlayerAnimation.LEGS_RUN);
    expect([state.oldFrame, state.frame, state.animationTime, state.frameTime]).toEqual([11, 103, 100, 250]);
    step(second, state, 225, PlayerAnimation.LEGS_RUN | ANIMATION_TOGGLE_BIT);
    const secondAnimation = second.animations[PlayerAnimation.LEGS_RUN];
    if (secondAnimation === undefined) throw new Error("Missing second animation cell");
    expect(state.currentAnimation).toBe(secondAnimation);
    expect(state.animationTime).toBe(350);
  });

  test("client publication and clearing copy values without replacing held animation pointers", () => {
    const slot = new ClientInfo(), next = new ClientInfo(), state = createLerpFrame();
    slot.setAnimations(animationSet(baseAnimation).animations);
    step(slot, state, 0);
    const cells = slot.animations, selected = state.currentAnimation;
    next.name = "next";
    next.setAnimations(animationSet({ ...baseAnimation, firstFrame: 200, frameLerp: 40 }).animations);
    slot.copyFrom(next);
    expect(slot.name).toBe("next");
    expect(slot.animations).toBe(cells);
    expect(slot.animations).not.toBe(next.animations);
    expect(state.currentAnimation).toBe(selected);
    expect(state.currentAnimation).not.toBe(next.animations[0]);
    expect(state.currentAnimation?.firstFrame).toBe(200);
    slot.copyFrom(new ClientInfo());
    expect(state.currentAnimation).toBe(selected);
    expect(state.currentAnimation?.frameLerp).toBe(0);
    expect(state.currentAnimation?.firstFrame).toBe(0);
  });
});

const retailPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retailPath, "baseq3", "pak0.pk3")))("runs source timing against retail Sarge animations", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "baseq3" });
  const path = "models/players/sarge/animation.cfg";
  const config = parsePlayerAnimationConfig(new TextDecoder().decode(await vfs.read(path)), path);
  const state = createLerpFrame();
  clearLerpFrame(config, state, PlayerAnimation.LEGS_RUN, 1000);
  expect(state.frame).toBe(110);
  expect(state.animationTime).toBe(1047);
  step(config, state, 1000, PlayerAnimation.LEGS_RUN);
  expect(state.frame).toBe(110);
  expect(state.frameTime).toBe(1047);
  step(config, state, 1023, PlayerAnimation.LEGS_RUN);
  expect(state.backLerp).toBe(Math.fround(1 - Math.fround(23 / 47)));
  step(config, state, 1047, PlayerAnimation.LEGS_RUN);
  expect(state.oldFrame).toBe(110);
  expect(state.frame).toBe(111);
  expect(state.frameTime).toBe(1094);
}, 30_000);
