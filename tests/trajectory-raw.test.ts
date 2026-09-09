import { describe, expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { vec3 } from "../src/core/math.ts";
import { EntityState, EntityStateRecord } from "../src/shared/entity-state.ts";
import { playerTouchesItem } from "../src/shared/items.ts";
import { evaluateTrajectory, evaluateTrajectoryDelta, TrajectoryType } from "../src/shared/trajectory.ts";
import type { Trajectory } from "../src/shared/trajectory.ts";

function trajectory(type: number): Trajectory<number> {
  return { type, time: -12345, duration: 1000, base: vec3(1, 2, 3), delta: vec3(10, 20, 30) };
}

describe("raw source trajectory tags", () => {
  test("entity storage and copies retain unknown tags without evaluating them", () => {
    const raw = new EntityStateRecord<number>(0);
    raw.pos = trajectory(255);
    raw.apos = trajectory(-1);
    const entity = new EntityState();
    entity.copyFrom(raw);
    expect(entity.pos).toEqual(raw.pos);
    expect(entity.apos).toEqual(raw.apos);
    expect(entity.pos).not.toBe(raw.pos);
    const copied = entity.copy();
    expect(copied.pos.type).toBe(255);
    expect(copied.apos.type).toBe(-1);
    expect(copied.pos.base).not.toBe(entity.pos.base);
  });

  test("each evaluator drops at its reached default, formatting trTime rather than trType", () => {
    for (const type of [-2147483648, -1, 6, 255, 2147483647]) {
      const tr = trajectory(type);
      for (const [evaluate, name] of [
        [evaluateTrajectory, "BG_EvaluateTrajectory"],
        [evaluateTrajectoryDelta, "BG_EvaluateTrajectoryDelta"],
      ] satisfies readonly (readonly [typeof evaluateTrajectory, string])[]) {
        let caught: unknown;
        try { evaluate(tr, 9000); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(CommonError);
        if (!(caught instanceof CommonError)) throw new Error("Expected the source trajectory drop");
        expect(caught.code).toBe("drop");
        expect(caught.message).toBe(`${name}: unknown trType: -12345`);
      }
    }
  });

  test("known raw tags retain normal source evaluation", () => {
    const raw: Trajectory<number> = trajectory(TrajectoryType.TR_LINEAR);
    expect(evaluateTrajectory(raw, raw.time + 500)).toEqual(vec3(6, 12, 18));
    expect(evaluateTrajectoryDelta(raw, raw.time + 500)).toEqual(vec3(10, 20, 30));
    const entity = new EntityState();
    entity.apos = trajectory(255);
    expect(evaluateTrajectory(entity.pos, 100)).toEqual(vec3(0, 0, 0));
  });

  test("item pickup evaluation reaches the shared drop with the retained raw tag", () => {
    const entity = new EntityState();
    entity.pos = trajectory(255);
    expect(() => playerTouchesItem(vec3(0, 0, 0), entity.pos, 0))
      .toThrow(new CommonError("drop", "BG_EvaluateTrajectory: unknown trType: -12345"));
  });
});
