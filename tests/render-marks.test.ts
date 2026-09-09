import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { BspMarkProjector, type MarkSurface } from "../src/render/marks.ts";
import { faceMarkSurface, markGeometry, markProjector, markSquare, markVertex } from "./marks-fixture.ts";

describe("source BSP mark projection", () => {
  test("clips real face triangles into the projected square without marker offset", () => {
    const result = markProjector().markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 });
    expect(result.fragments).toHaveLength(2);
    expect(result.points.length).toBeGreaterThanOrEqual(6);
    for (const point of result.points) {
      expect(point.z).toBe(0); expect(Math.abs(point.x)).toBeLessThanOrEqual(8.01); expect(Math.abs(point.y)).toBeLessThanOrEqual(8.01);
    }
    const wholeFace = markProjector([faceMarkSurface(-0)]).markFragments({ points: markSquare().map(point => vec3(point.x * 10, point.y * 10, point.z)), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 });
    expect(wholeFace.points.every(point => Object.is(point.z, 0))).toBe(true);
  });
  test("honors material NOIMPACT/NOMARKS/FOG and skips triangle soups", () => {
    const face = faceMarkSurface();
    if (face.kind !== "face") throw new Error("fixture face required");
    for (const surface of [{ ...face, surfaceFlags: 16 }, { ...face, surfaceFlags: 32 }, { ...face, contentFlags: 64 }, { kind: "skip" }] satisfies readonly MarkSurface[]) {
      expect(markProjector([surface]).markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 }).fragments).toHaveLength(0);
    }
    expect(markProjector().markFragments({ points: markSquare(), projection: vec3(0, 0, 20), maxPoints: 384, maxFragments: 128 }).fragments).toHaveLength(0);
  });
  test("deduplicates BSP leaves and caps candidate surfaces in front-child order", () => {
    const geometry = markGeometry();
    const leaf = geometry.map.leaves[0]; if (leaf === undefined) throw new Error("fixture leaf required");
    const projector = new BspMarkProjector({ ...geometry, map: { ...geometry.map, planes: [{ normal: vec3(1, 0, 0), distance: 0 }], nodes: [{ plane: 0, children: [-1, -2], bounds: leaf.bounds }], leaves: [leaf, leaf] } });
    expect(projector.markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 }).fragments).toHaveLength(2);
    const many = markProjector(Array.from({ length: 65 }, () => faceMarkSurface()));
    expect(many.markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 4096, maxFragments: 256 }).fragments).toHaveLength(128);
  });
  test("clips source grids using their prepared vertices", () => {
    const vertices = [markVertex(vec3(-32, -32, 0)), markVertex(vec3(32, -32, 0)), markVertex(vec3(-32, 32, 0)), markVertex(vec3(32, 32, 0))];
    const projector = markProjector([{ kind: "grid", surfaceFlags: 0, contentFlags: 1, mesh: { width: 2, height: 2, vertices, indices: [0, 2, 1, 1, 2, 3], widthLodError: [0, 0], heightLodError: [0, 0] } }]);
    expect(projector.markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 })).toEqual(markProjector().markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 }));
  });
  test("keeps source zero-projection output and bounds output capacities", () => {
    const projector = markProjector();
    for (const limits of [{ maxPoints: 0, maxFragments: 128 }, { maxPoints: 384, maxFragments: 0 }, { maxPoints: 2, maxFragments: 128 }]) expect(projector.markFragments({ points: markSquare(), projection: vec3(0, 0, -20), ...limits }).fragments).toHaveLength(0);
    expect(projector.markFragments({ points: markSquare(), projection: vec3(0, 0, 0), maxPoints: 384, maxFragments: 128 }).fragments).toHaveLength(0);
    expect(projector.markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 1 }).fragments).toHaveLength(1);
    expect(() => projector.markFragments({ points: [], projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 })).toThrow("at least one");
    expect(() => projector.markFragments({ points: markSquare(), projection: vec3(0, 0, -20), maxPoints: -1, maxFragments: 128 })).toThrow("capacity");
  });
});
