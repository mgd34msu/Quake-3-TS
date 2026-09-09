import { describe, expect, test } from "bun:test";
import type { PlayerAnimationConfig } from "../src/assets/animation.ts";
import { createLerpFrame } from "../src/cgame/animation.ts";
import {
  addPainTwitch,
  calculatePlayerPose,
  createPlayerPoseState,
  swingAngles,
} from "../src/cgame/player-pose.ts";
import type { PlayerPose, PlayerPoseState } from "../src/cgame/player-pose.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { qvmAnglesToAxis } from "../src/core/qvm-math.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerAnimation } from "../src/shared/player-state.ts";

const ordinaryConfig: Pick<PlayerAnimationConfig, "fixedLegs" | "fixedTorso"> = {
  fixedLegs: false,
  fixedTorso: false,
};

function entity(direction: number, velocityX = 0, velocityY = 0, velocityZ = 0): EntityState {
  const state = new EntityState();
  state.angles2 = vec3(0, direction, 0);
  state.pos = { ...state.pos, delta: vec3(velocityX, velocityY, velocityZ) };
  state.legsAnim = PlayerAnimation.LEGS_IDLE;
  state.torsoAnim = PlayerAnimation.TORSO_STAND;
  return state;
}

function pose(
  state: PlayerPoseState,
  current: EntityState,
  lerpAngles = vec3(0, 0, 0),
  animationConfig = ordinaryConfig,
): PlayerPose {
  return calculatePlayerPose(state, {
    entity: current,
    animationConfig,
    lerpAngles,
    timeMs: 1000,
    frameTimeMs: 16,
    swingSpeed: 0.3,
  });
}

function expectVector(actual: { readonly x: number; readonly y: number; readonly z: number }, expected: readonly [number, number, number]): void {
  expect(actual.x).toBeCloseTo(expected[0], 6);
  expect(actual.y).toBeCloseTo(expected[1], 6);
  expect(actual.z).toBeCloseTo(expected[2], 6);
}

describe("CG_SwingAngles", () => {
  test("matches native source oracle across positive and negative yaw wrap", () => {
    const positive = swingAngles({
      destination: 30, swingTolerance: 25, clampTolerance: 90,
      speed: 0.3, frameTimeMs: 16, angle: 350, swinging: false,
    });
    expect(positive.angle).toBe(359.5989990234375);
    expect(positive.swinging).toBe(true);
    const negative = swingAngles({
      destination: 340, swingTolerance: 15, clampTolerance: 90,
      speed: 0.3, frameTimeMs: 16, angle: 10, swinging: false,
    });
    expect(negative.angle).toBe(0.3955078125);
    expect(negative.swinging).toBe(true);
  });

  test("uses the source clampTolerance minus one snap", () => {
    const result = swingAngles({
      destination: 180, swingTolerance: 25, clampTolerance: 90,
      speed: 0, frameTimeMs: 16, angle: 0, swinging: true,
    });
    expect(result).toEqual({ angle: 90.999755859375, swinging: true });
  });

  test("does not start a swing at the exact tolerance", () => {
    expect(swingAngles({
      destination: 25, swingTolerance: 25, clampTolerance: 90,
      speed: 1, frameTimeMs: 16, angle: 0, swinging: false,
    })).toEqual({ angle: 0, swinging: false });
  });
});

describe("CG_AddPainTwitch", () => {
  test("applies signed roll and stops at the exact 200ms boundary", () => {
    expect(addPainTwitch(vec3(1, 2, 0), { timeMs: 1000, painTime: 900, painDirection: false })).toEqual(vec3(1, 2, -10));
    expect(addPainTwitch(vec3(1, 2, 0), { timeMs: 1000, painTime: 900, painDirection: true })).toEqual(vec3(1, 2, 10));
    expect(addPainTwitch(vec3(1, 2, 3), { timeMs: 1100, painTime: 900, painDirection: true })).toEqual(vec3(1, 2, 3));
  });

  test("preserves the source future-pain-time overshoot", () => {
    expect(addPainTwitch(vec3(0, 0, 0), { timeMs: 1000, painTime: 1100, painDirection: true }).z).toBe(30);
  });

  test("wraps the signed pain-clock subtraction before the 200ms comparison", () => {
    expect(addPainTwitch(vec3(0, 0, 0), { timeMs: -2147483600, painTime: 2147483600, painDirection: true }).z).toBe(10.399999618530273);
    expect(addPainTwitch(vec3(1, 2, 3), { timeMs: -2147483500, painTime: 2147483596, painDirection: true })).toEqual(vec3(1, 2, 3));
  });
});

describe("CG_PlayerAngles", () => {
  test("builds pose lerp frames from the complete animation state", () => {
    const state = createPlayerPoseState();
    expect(state.legs).toEqual({
      ...createLerpFrame(), yawAngle: 0, yawing: false, pitchAngle: 0, pitching: false,
    });
    expect(state.torso).not.toBe(state.legs);
  });

  test("matches native diagonal movement yaw and hierarchical axes", () => {
    const current = entity(2);
    current.legsAnim = PlayerAnimation.LEGS_RUN;
    const state = createPlayerPoseState();
    const result = pose(state, current);
    expect(state.legs.yawAngle).toBe(9.5965576171875);
    expect(state.torso.yawAngle).toBe(2.39501953125);
    expectVector(result.legs[0], [0.986006081, 0.166709512, 0]);
    expectVector(result.legs[1], [-0.166709512, 0.986006081, 0]);
    expectVector(result.torso[0], [0.992111325, -0.125359863, 0]);
    expectVector(result.head[0], [0.999126494, -0.0417888053, 0]);
  });

  test("keeps small idle yaw in the head, but moving animations center it", () => {
    const idle = entity(0);
    const idleState = createPlayerPoseState();
    pose(idleState, idle, vec3(0, 10, 0));
    expect(idleState.legs.yawAngle).toBe(0);
    expect(idleState.torso.yawAngle).toBe(0);
    const moving = entity(0);
    moving.legsAnim = PlayerAnimation.LEGS_RUN;
    const movingState = createPlayerPoseState();
    pose(movingState, moving, vec3(0, 10, 0));
    expect(movingState.legs.yawAngle).toBe(2.39501953125);
    expect(movingState.torso.yawAngle).toBe(2.39501953125);
  });

  test("leans into velocity using source normalized forward and side projections", () => {
    const current = entity(0, 100, 0, 0);
    const result = pose(createPlayerPoseState(), current);
    expectVector(result.legs[0], [0.99619472, 0, -0.087155737]);
    expectVector(result.legs[2], [0.087155737, 0, 0.99619472]);
    expectVector(result.torso[0], [0.99619472, 0, 0.087155737]);
  });

  test("stores the source float32 lean multiplier before applying velocity", () => {
    const result = pose(createPlayerPoseState(), entity(0, 9, 0, 0));
    expect(result.legs).toEqual(qvmAnglesToAxis(vec3(0.45000001788139343, 0, 0)));
  });

  test("dead players use movement direction zero while live players use the table", () => {
    const dead = entity(2);
    dead.eFlags = 1;
    const forward = entity(0);
    const deadPose = pose(createPlayerPoseState(), dead);
    const forwardPose = pose(createPlayerPoseState(), forward);
    expect(deadPose).toEqual(forwardPose);
  });

  test("fixed torso removes pitch and fixed legs follow torso yaw without lean", () => {
    const current = entity(2, 100, 100, 0);
    current.legsAnim = PlayerAnimation.LEGS_RUN;
    const config: Pick<PlayerAnimationConfig, "fixedLegs" | "fixedTorso"> = { fixedLegs: true, fixedTorso: true };
    const result = pose(createPlayerPoseState(), current, vec3(30, 45, 0), config);
    expect(result.legs[0].z).toBeCloseTo(0, 6);
    expect(result.legs[1].z).toBeCloseTo(0, 6);
    expect(result.legs[2].z).toBeCloseTo(1, 6);
    expect(result.torso[0].z).toBeCloseTo(0, 6);
  });

  test("applies pain before hierarchical angle subtraction", () => {
    const state = createPlayerPoseState();
    state.painTime = 900;
    state.painDirection = false;
    const result = pose(state, entity(0));
    expectVector(result.torso[0], [1, 0, 0]);
    expectVector(result.torso[1], [0, 0.98480773, -0.17364818]);
    expectVector(result.head[1], [0, 0.98480773, 0.17364818]);
  });

  test("drops at the source movement-angle check after publishing swing flags", () => {
    for (const direction of [-1, 8, Number.NaN]) {
      const invalid = entity(direction), state = createPlayerPoseState();
      invalid.legsAnim = PlayerAnimation.LEGS_RUN;
      let thrown: unknown = null;
      try { pose(state, invalid); }
      catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(CommonError);
      expect(thrown).toMatchObject({ code: "drop", message: "Bad player movement angle" });
      expect(state.legs).toEqual({ ...createLerpFrame(), yawAngle: 0, yawing: true, pitchAngle: 0, pitching: false });
      expect(state.torso).toEqual({ ...createLerpFrame(), yawAngle: 0, yawing: true, pitchAngle: 0, pitching: true });
      invalid.eFlags = 1;
      expect(() => pose(createPlayerPoseState(), invalid)).not.toThrow();
    }
  });

  test("converts fractional movement directions before checking the source table bounds", () => {
    for (const [fractional, integer] of [[1.5, 1], [7.99, 7], [-0.5, 0]] satisfies readonly (readonly [number, number])[]) {
      expect(pose(createPlayerPoseState(), entity(fractional))).toEqual(pose(createPlayerPoseState(), entity(integer)));
    }
  });
});
