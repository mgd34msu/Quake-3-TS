import { describe, expect, test } from "bun:test";
import { ImpactMarkSystem, type ImpactMarkRequest } from "../src/cgame/marks.ts";
import { vec3 } from "../src/core/math.ts";
import { markProjector } from "./marks-fixture.ts";

const normalShader = { name: "mark" }, energyShader = { name: "energy" };
function fixture() {
  const clock = { time: 100, enabled: true };
  const marks = new ImpactMarkSystem(markProjector(), { clock: () => clock.time, enabled: () => clock.enabled, energyShader: () => energyShader });
  const request: ImpactMarkRequest = { shader: normalShader, origin: vec3(0, 0, 1), direction: vec3(0, 0, 1), orientation: 0, color: { x: 1, y: 0.5, z: 0.25, w: 0.5 }, alphaFade: true, radius: 8, temporary: false };
  return { marks, clock, request };
}

describe("source impact mark lifetimes", () => {
  test("temporary marks submit immediately; permanent marks retain copied source colors and UVs", () => {
    const { marks, request } = fixture();
    const temporary = marks.impactMark({ ...request, temporary: true });
    expect(temporary).toHaveLength(2); expect(marks.activeMarkCount).toBe(0);
    expect(temporary[0]?.vertices[0]?.color).toEqual({ x: 255, y: 127, z: 63, w: 127 });
    expect(marks.impactMark(request)).toEqual([]); expect(marks.activeMarkCount).toBe(2);
    expect(marks.addMarks()).toEqual([...temporary].reverse());
  });
  test("expiry is strict and final alpha fade ignores original alpha", () => {
    const { marks, clock, request } = fixture(); marks.impactMark(request);
    const initial = marks.addMarks();
    clock.time = 9100; expect(marks.addMarks()[0]?.vertices[0]?.color.w).toBe(127);
    clock.time = 9101; expect(marks.addMarks()[0]?.vertices[0]?.color.w).toBe(254);
    expect(initial[0]?.vertices[0]?.color.w).toBe(127);
    clock.time = 9600; expect(marks.addMarks()[0]?.vertices[0]?.color.w).toBe(127);
    clock.time = 10100; expect(marks.addMarks()[0]?.vertices[0]?.color.w).toBe(0); expect(marks.activeMarkCount).toBe(2);
    clock.time = 10101; expect(marks.addMarks()).toEqual([]); expect(marks.activeMarkCount).toBe(0);
  });
  test("RGB fading and the energy first-red-zero latch retain source behavior", () => {
    const { marks, clock, request } = fixture(); marks.impactMark({ ...request, shader: energyShader, alphaFade: false });
    clock.time = 2100; expect(marks.addMarks()[0]?.vertices[0]?.color).toEqual({ x: 150, y: 75, z: 37, w: 127 });
    clock.time = 3100; expect(marks.addMarks()[0]?.vertices[0]?.color.x).toBe(0);
    clock.time = 9600; expect(marks.addMarks()[0]?.vertices[0]?.color).toEqual({ x: 127, y: 63, z: 31, w: 127 });
    marks.reset(); clock.time = 100; marks.impactMark({ ...request, shader: energyShader, color: { x: 0, y: 1, z: 1, w: 1 } });
    clock.time = 3100; expect(marks.addMarks()[0]?.vertices[0]?.color).toEqual({ x: 0, y: 255, z: 255, w: 255 });
  });
  test("Q3_VM energy arithmetic preserves visible rounding and integer expiry wrapping", () => {
    // Both retail cgame QVMs: CG_AddMarks starts at base 50420 / TA 35999;
    // source fade emits SUBI4 CVIF4 DIVF4 MULF4 SUBF4 CVFI4.
    // Native double promotion instead produces 221,210,197 for these ages.
    for (const [age, red] of [[1520, 222], [1600, 209], [1680, 198]]) {
      if (age === undefined || red === undefined) throw new Error("incomplete VM fade golden");
      const { marks, clock, request } = fixture(); marks.impactMark({ ...request, shader: energyShader });
      clock.time = 100 + age; expect(marks.addMarks()[0]?.vertices[0]?.color.x).toBe(red);
    }
    const { marks, clock, request } = fixture(); clock.time = 0x7ffffff0; marks.impactMark(request);
    expect(marks.activeMarkCount).toBe(2); expect(marks.addMarks()).toEqual([]);
  });
  test("shader handle zero remains a renderer default and matches unregistered energy media", () => {
    const clock = { time: 100 }, { request } = fixture();
    const marks = new ImpactMarkSystem(markProjector(), { clock: () => clock.time, enabled: () => true, energyShader: () => null });
    expect(marks.impactMark({ ...request, shader: null, temporary: true })[0]?.shader).toBeNull();
    marks.impactMark({ ...request, shader: null }); clock.time = 3100;
    expect(marks.addMarks()[0]?.vertices[0]?.color.x).toBe(0);
  });
  test("pool pressure removes every oldest-time polygon, including safe timestamp-zero eviction", () => {
    const { marks, clock, request } = fixture();
    clock.time = 0;
    for (let index = 0; index < 128; index++) marks.impactMark(request);
    expect(marks.activeMarkCount).toBe(256);
    clock.time = 1; marks.impactMark(request);
    expect(marks.activeMarkCount).toBe(2);
    marks.reset();
    for (let index = 0; index < 128; index++) { clock.time = index + 1; marks.impactMark(request); }
    clock.time = 200; marks.impactMark(request); expect(marks.activeMarkCount).toBe(256);
  });
  test("disabled marks suspend storage/expiry and reject invalid enabled inputs explicitly", () => {
    const { marks, clock, request } = fixture(); marks.impactMark(request);
    clock.enabled = false; clock.time = 20000;
    expect(marks.addMarks()).toEqual([]); expect(marks.activeMarkCount).toBe(2);
    expect(marks.impactMark({ ...request, radius: 0 })).toEqual([]);
    clock.enabled = true; expect(marks.addMarks()).toEqual([]);
    expect(() => marks.impactMark({ ...request, radius: 0 })).toThrow("<= 0 radius");
    expect(marks.impactMark({ ...request, direction: vec3(0, 0, 0) })).toEqual([]);
    expect(marks.activeMarkCount).toBe(0);
  });
});
