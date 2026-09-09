import { describe, expect, test } from "bun:test";
import type { Animation } from "../src/assets/animation.ts";
import { CommonError } from "../src/core/common-error.ts";
import { runBasePlayerLerpFrame as run, setBasePlayerLerpFrameAnimation as select, type BasePlayerLerpFrame } from "../src/ui/base/player-animation.ts";

// Literal transition expectations from q3_ui/ui_players.c:345–421, not cgame interpolation.
function row(overrides: Partial<Animation> = {}): Animation {
  return { firstFrame: 10, numFrames: 4, loopFrames: 0, frameLerp: 100, initialLerp: 50, reversed: false, flipflop: false, ...overrides };
}
function table(animation: Animation = row()): Animation[] {
  return Array.from({ length: 31 }, () => ({ ...animation }));
}
function zero(overrides: Partial<BasePlayerLerpFrame> = {}): BasePlayerLerpFrame {
  return { oldFrame: 0, oldFrameTime: 0, frame: 0, frameTime: 0, backLerp: 0, animationNumber: 0, currentAnimation: null, animationTime: 0, ...overrides };
}
function bits(value: number): number {
  const buffer = new ArrayBuffer(4), view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

describe("base UI animation selection", () => {
  for (const number of [0, 30, 128, 158]) test(`raw selection ${number} retains history and exact cell`, () => {
    const animations = table(), frame = zero({ oldFrame: 3, oldFrameTime: 7, frame: 4, frameTime: 25, backLerp: .75 });
    const selected = animations[number & ~128];
    if (selected === undefined) throw new Error("Missing explicit table cell");
    const before = { ...frame };
    expect(select(animations, frame, number)).toBeUndefined();
    expect(frame).toEqual({ ...before, animationNumber: number, currentAnimation: selected, animationTime: 75 });
    expect(frame.currentAnimation).toBe(selected);
  });
  for (const [number, masked] of [[31, 31], [159, 31], [-1, -129], [-128, -256], [256, 256], [2147483647, 2147483519]]) {
    if (number === undefined || masked === undefined) throw new Error("Missing explicit selection case");
    test(`bad selection ${number} stores raw number before exact source drop`, () => {
      const previous = row(), frame = zero({ currentAnimation: previous, animationTime: 77, frameTime: 25 });
      expect(() => select(table(), frame, number)).toThrow(new CommonError("drop", `Bad animation number: ${masked}`));
      try { select(table(), frame, number); } catch (error) {
        expect(error).toBeInstanceOf(CommonError);
        if (!(error instanceof CommonError)) throw error;
        expect(error.code).toBe("drop"); expect(error.message).toBe(`Bad animation number: ${masked}`);
      }
      expect(frame).toEqual(zero({ animationNumber: number, currentAnimation: previous, animationTime: 77, frameTime: 25 }));
    });
  }
  test("missing physical slot does not default or replace pointer; unused absent cells are not preflighted", () => {
    const previous = row(), frame = zero({ currentAnimation: previous, animationTime: 77 });
    expect(() => select([], frame, 30)).toThrow("Missing source UI animation slot 30");
    expect(frame.animationNumber).toBe(30); expect(frame.currentAnimation).toBe(previous); expect(frame.animationTime).toBe(77);
    const only = row(); select([only], frame, 0); expect(frame.currentAnimation).toBe(only);
  });
  test("pointer write survives reached initialLerp or frameTime error", () => {
    for (const invalidInitial of [false, true]) {
      const animation = row({ initialLerp: invalidInitial ? NaN : 50 });
      const frame = zero({ animationNumber: 2, animationTime: 88, frameTime: invalidInitial ? 25 : .5 });
      expect(() => select([animation], frame, 128)).toThrow(RangeError);
      expect(frame.animationNumber).toBe(128); expect(frame.currentAnimation).toBe(animation); expect(frame.animationTime).toBe(88);
    }
  });
  test("setter wraps signed time addition without touching unused row fields", () => {
    const animation = row({ initialLerp: 1, firstFrame: NaN, frameLerp: NaN, numFrames: NaN, loopFrames: NaN });
    const frame = zero({ frameTime: 2147483647 }); select([animation], frame, 0);
    expect(frame.animationTime).toBe(-2147483648);
  });
});

describe("base UI interpolation", () => {
  test("initial delay, interpolation and exact advance boundary", () => {
    const animations = table(), frame = zero();
    run(animations, frame, { animationNumber: 0, realtime: 0 });
    expect(frame).toEqual(zero({ currentAnimation: animations[0] ?? null, frame: 10, frameTime: 50, animationTime: 50, backLerp: 1 }));
    run(animations, frame, { animationNumber: 0, realtime: 25 });
    expect(frame.frame).toBe(10); expect(frame.frameTime).toBe(50); expect(frame.backLerp).toBe(.5);
    run(animations, frame, { animationNumber: 0, realtime: 50 });
    expect(frame).toEqual(zero({ currentAnimation: animations[0] ?? null, oldFrame: 10, oldFrameTime: 50, frame: 11, frameTime: 150, animationTime: 50, backLerp: 1 }));
  });
  test("toggle restart schedules from existing frameTime and retains old history", () => {
    const animations = table(), frame = zero({ oldFrame: 4, oldFrameTime: 10, frame: 11, frameTime: 150, currentAnimation: row(), animationTime: 50 });
    run(animations, frame, { animationNumber: 128, realtime: 100 });
    expect(frame).toEqual(zero({ oldFrame: 4, oldFrameTime: 10, frame: 11, frameTime: 150, currentAnimation: animations[0] ?? null, animationNumber: 128, animationTime: 200, backLerp: Math.fround(1 - Math.fround(90 / 140)) }));
  });
  test("same-number cache observes stable cell mutation, not replacement slot or fresh table", () => {
    const cell = { firstFrame: 10, numFrames: 100, loopFrames: 0, frameLerp: 100, initialLerp: 0, reversed: false, flipflop: false };
    const animations = table(); animations[0] = cell;
    const frame = zero(); select(animations, frame, 0);
    cell.firstFrame = 40; animations[0] = row({ firstFrame: 900 });
    run(animations, frame, { animationNumber: 0, realtime: 0 });
    expect(frame.currentAnimation).toBe(cell); expect(frame.frame).toBe(41);
    cell.firstFrame = 70;
    run([], frame, { animationNumber: 0, realtime: 100 });
    expect(frame.currentAnimation).toBe(cell); expect(frame.frame).toBe(72); expect(frame.animationTime).toBe(0);
  });
  test("caught setter drop leaves a same-raw cached pointer usable; null still forces drop", () => {
    const animation = row({ initialLerp: 0 }), frame = zero({ currentAnimation: animation });
    expect(() => select([], frame, 31)).toThrow(CommonError);
    run([], frame, { animationNumber: 31, realtime: 0 });
    expect(frame.frame).toBe(11); expect(frame.currentAnimation).toBe(animation); expect(frame.animationNumber).toBe(31);
    frame.currentAnimation = null;
    expect(() => run([], frame, { animationNumber: 31, realtime: 100 })).toThrow(new CommonError("drop", "Bad animation number: 31"));
  });
  test("long delay advances one scheduled frame then clamps to now", () => {
    const animation = row({ numFrames: 100 }), frame = zero({ currentAnimation: animation, frame: 11, frameTime: 100 });
    run([], frame, { animationNumber: 0, realtime: 1000 });
    expect(frame).toEqual(zero({ currentAnimation: animation, oldFrame: 11, oldFrameTime: 100, frame: 12, frameTime: 1000 }));
  });

  interface OffsetCase { name: string; animation: Animation; frameTime: number; animationTime: number; realtime: number; expectedFrame: number; expectedTime: number }
  const offsetCases: readonly OffsetCase[] = [
    { name: "nonloop final hold", animation: row(), frameTime: 300, animationTime: 0, realtime: 300, expectedFrame: 13, expectedTime: 300 },
    { name: "tail loop", animation: row({ loopFrames: 2 }), frameTime: 400, animationTime: 0, realtime: 400, expectedFrame: 13, expectedTime: 500 },
    { name: "loop longer than count", animation: row({ loopFrames: 6 }), frameTime: 400, animationTime: 0, realtime: 400, expectedFrame: 9, expectedTime: 500 },
    { name: "negative loop", animation: row({ loopFrames: -2 }), frameTime: 400, animationTime: 0, realtime: 400, expectedFrame: 17, expectedTime: 500 },
    { name: "zero count", animation: row({ numFrames: 0 }), frameTime: 0, animationTime: 0, realtime: 0, expectedFrame: 9, expectedTime: 0 },
    { name: "negative count", animation: row({ numFrames: -3 }), frameTime: 0, animationTime: 0, realtime: 0, expectedFrame: 6, expectedTime: 0 },
    { name: "negative lerp and truncation toward zero", animation: row({ frameLerp: -100 }), frameTime: 0, animationTime: -250, realtime: 0, expectedFrame: 9, expectedTime: 0 },
    { name: "negative dividend remainder", animation: row({ frameLerp: -100, numFrames: -3, loopFrames: 2 }), frameTime: 0, animationTime: -450, realtime: 0, expectedFrame: 5, expectedTime: 0 },
    { name: "UI ignores reversed and flipflop", animation: row({ reversed: true, flipflop: true }), frameTime: 100, animationTime: 0, realtime: 100, expectedFrame: 12, expectedTime: 200 },
    { name: "frame addition wraps", animation: row({ firstFrame: 2147483647 }), frameTime: 0, animationTime: 0, realtime: 0, expectedFrame: -2147483648, expectedTime: 100 },
    { name: "scheduled time wraps", animation: row({ frameLerp: 2147483647, numFrames: 100 }), frameTime: 1, animationTime: 0, realtime: 1, expectedFrame: 9, expectedTime: 1 },
  ];
  for (const item of offsetCases) test(item.name, () => {
    const frame = zero({ currentAnimation: item.animation, frame: 77, frameTime: item.frameTime, animationTime: item.animationTime });
    run([], frame, { animationNumber: 0, realtime: item.realtime });
    expect(frame.oldFrame).toBe(77); expect(frame.oldFrameTime).toBe(item.frameTime);
    expect(frame.frame).toBe(item.expectedFrame); expect(frame.frameTime).toBe(item.expectedTime);
  });
  test("signed remainder keeps dividend sign after wrapped subtract", () => {
    const animation = row({ numFrames: -2147483647, loopFrames: 3, frameLerp: 1 });
    const frame = zero({ currentAnimation: animation });
    run([], frame, { animationNumber: 0, realtime: 0 });
    // offset 1 - INT_MIN+1 wraps to INT_MIN; INT_MIN % 3 = -2.
    expect(frame.frame).toBe(-2147483642); expect(frame.frameTime).toBe(1);
  });
  test("future clamp is strict; backward clock independently clamps old time", () => {
    for (const future of [200, 201]) {
      const frame = zero({ currentAnimation: row(), frameTime: future, oldFrameTime: 10, frame: 13 });
      run([], frame, { animationNumber: 0, realtime: 0 });
      expect(frame.frameTime).toBe(future === 200 ? 200 : 0); expect(frame.oldFrameTime).toBe(0);
      expect(frame.backLerp).toBe(future === 200 ? 1 : 0); expect(frame.frame).toBe(13);
    }
    const negative = zero({ currentAnimation: row(), frameTime: -50, oldFrameTime: -200 });
    run([], negative, { animationNumber: 0, realtime: -100 });
    expect(negative.frameTime).toBe(-50); expect(bits(negative.backLerp)).toBe(0x3eaaaaaa);
  });
  test("realtime+200 uses the signed word boundary", () => {
    const frame = zero({ currentAnimation: row(), frameTime: 2147483647, oldFrameTime: 2147483645 });
    run([], frame, { animationNumber: 0, realtime: 2147483646 });
    expect(frame.frameTime).toBe(2147483646); expect(frame.backLerp).toBe(0);
  });
  test("float32 conversions, quotient and subtraction have literal bit expectations", () => {
    for (const [elapsed, duration, expected] of [[1, 3, 0x3f2aaaaa], [2, 3, 0x3eaaaaaa], [1, 10, 0x3f666666], [16777217, 16777219, 0x34800000]]) {
      if (elapsed === undefined || duration === undefined || expected === undefined) throw new Error("Missing explicit precision case");
      const frame = zero({ currentAnimation: row(), frameTime: duration });
      run([], frame, { animationNumber: 0, realtime: elapsed });
      expect(bits(frame.backLerp)).toBe(expected);
    }
    const frame = zero({ currentAnimation: row(), frameTime: 100, oldFrameTime: -2147483640 });
    run([], frame, { animationNumber: 0, realtime: 0 });
    expect(frame.backLerp).toBe(2); // Wrapped duration changes sign; source does not clamp the result.
  });
  test("interleaved independent records share no clock or mutable module state", () => {
    const animations = table(), a = zero(), b = zero();
    run(animations, a, { animationNumber: 0, realtime: 0 });
    run(animations, b, { animationNumber: 30, realtime: 0 });
    const saved = { ...b };
    run(animations, a, { animationNumber: 0, realtime: 25 }); expect(b).toEqual(saved);
    run(animations, b, { animationNumber: 30, realtime: 50 });
    expect(a.frameTime).toBe(50); expect(a.backLerp).toBe(.5); expect(b.frameTime).toBe(150);
  });
});

describe("reached representation and arithmetic failures", () => {
  test("zero divisor retains old-frame writes and both source scheduling branches", () => {
    for (const animationTime of [0, 50]) {
      const animation = row({ frameLerp: 0 }), frame = zero({ currentAnimation: animation, frame: 42, frameTime: 10, oldFrame: 7, oldFrameTime: 8, animationTime, backLerp: .25 });
      expect(() => run([], frame, { animationNumber: 0, realtime: 10 })).toThrow("Undefined source UI animation integer division");
      expect(frame).toEqual(zero({ currentAnimation: animation, frame: 42, frameTime: animationTime === 0 ? 10 : 50, oldFrame: 42, oldFrameTime: 10, animationTime, backLerp: .25 }));
    }
  });
  test("unreached bad animation fields and old backLerp do not block interpolation", () => {
    const animation = row({ frameLerp: 0, initialLerp: NaN, firstFrame: NaN, numFrames: NaN, loopFrames: NaN });
    const frame = zero({ currentAnimation: animation, animationTime: NaN, frame: NaN, oldFrame: NaN, frameTime: 100, backLerp: NaN });
    run([], frame, { animationNumber: 0, realtime: 25 }); expect(frame.backLerp).toBe(.75);
    const unusedLoop = zero({ currentAnimation: row({ loopFrames: NaN, initialLerp: NaN }) });
    run([], unusedLoop, { animationNumber: 0, realtime: 0 }); expect(unusedLoop.frame).toBe(11);
  });
  test("INT_MIN/-1 division and remainder fail after source scheduling writes", () => {
    const division = zero({ currentAnimation: row({ frameLerp: -1 }), frame: 42, frameTime: -2147483647, backLerp: .5 });
    expect(() => run([], division, { animationNumber: 0, realtime: 0 })).toThrow("Undefined source UI animation integer division");
    expect(division.oldFrame).toBe(42); expect(division.oldFrameTime).toBe(-2147483647); expect(division.frameTime).toBe(-2147483648); expect(division.frame).toBe(42); expect(division.backLerp).toBe(.5);
    const remainder = zero({ currentAnimation: row({ frameLerp: 1, numFrames: -2147483648, loopFrames: -1 }), frame: 42, animationTime: 1, backLerp: .5 });
    expect(() => run([], remainder, { animationNumber: 0, realtime: 0 })).toThrow("Undefined source UI animation integer remainder");
    expect(remainder.oldFrame).toBe(42); expect(remainder.frameTime).toBe(1); expect(remainder.frame).toBe(42); expect(remainder.backLerp).toBe(.5);
  });
  test("bad fields fail at their reached reads without rolling back preceding mutations", () => {
    const invalidFrame = zero({ currentAnimation: row(), frame: NaN, oldFrame: 7, oldFrameTime: 8 });
    expect(() => run([], invalidFrame, { animationNumber: 0, realtime: 0 })).toThrow("integer: frame");
    expect(invalidFrame.oldFrame).toBe(7); expect(invalidFrame.oldFrameTime).toBe(8);
    const invalidTime = zero({ currentAnimation: row(), frame: 42, frameTime: 10, animationTime: NaN });
    expect(() => run([], invalidTime, { animationNumber: 0, realtime: 10 })).toThrow("integer: animationTime");
    expect(invalidTime.oldFrame).toBe(42); expect(invalidTime.oldFrameTime).toBe(10); expect(invalidTime.frameTime).toBe(10);
    for (const field of ["frameLerp", "numFrames", "loopFrames", "firstFrame"]) {
      const animation = row({ numFrames: 0, [field]: NaN });
      const frame = zero({ currentAnimation: animation, frame: 42, frameTime: 10, backLerp: .25 });
      expect(() => run([], frame, { animationNumber: 0, realtime: 20 })).toThrow(`integer: ${field}`);
      expect(frame.oldFrame).toBe(42); expect(frame.oldFrameTime).toBe(10);
      expect(frame.frameTime).toBe(field === "frameLerp" ? 10 : field === "firstFrame" ? 20 : 110);
      expect(frame.frame).toBe(42); expect(frame.backLerp).toBe(.25);
    }
  });
  for (const invalid of [NaN, Infinity, -Infinity, .5, 2147483648, -2147483649]) test(`invalid public number ${invalid} fails before mutation`, () => {
    const frame = zero(), before = { ...frame };
    expect(() => select(table(), frame, invalid)).toThrow(RangeError); expect(frame).toEqual(before);
    expect(() => run(table(), frame, { animationNumber: invalid, realtime: 0 })).toThrow(RangeError); expect(frame).toEqual(before);
    expect(() => run(table(), frame, { animationNumber: 128, realtime: invalid })).toThrow(RangeError); expect(frame).toEqual(before);
  });
});
