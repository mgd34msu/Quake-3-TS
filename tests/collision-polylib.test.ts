// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CollisionWindingLibrary, WindingSide } from "../src/collision/polylib.ts";
import type { CollisionWinding } from "../src/collision/polylib.ts";
import { CollisionDebugSurface, generatePatchCollide } from "../src/collision/patch.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";

function polygon(library: CollisionWindingLibrary, points: readonly Vec3[]): CollisionWinding {
  const result = library.alloc(points.length);
  for (const p of points) result.append(p);
  return result;
}
const square = [vec3(-2, -2, 0), vec3(-2, 2, 0), vec3(2, 2, 0), vec3(2, -2, 0)];

test("winding allocation owns source bytes and counters, preserves double-free failure ordering", () => {
  const zone = new ZoneArena(4096), sizes: number[] = [];
  const library = new CollisionWindingLibrary({ allocate: bytes => { sizes.push(bytes); return zone.allocate(bytes, ZoneTag.General, true); }, free: allocation => zone.free(allocation) });
  const w = library.alloc(4);
  expect(sizes).toEqual([52]); expect(w.numPoints).toBe(0); expect(w.point(3)).toEqual(vec3(0, 0, 0));
  w.append(vec3(1, 2, 3));
  const data = new DataView(w.allocation.bytes.buffer, w.allocation.bytes.byteOffset, w.allocation.bytes.byteLength);
  expect(data.getFloat32(8, true)).toBe(2); data.setFloat32(4, 9, true); expect(w.point(0).x).toBe(9);
  library.free(w);
  expect(library.c_active_windings).toBe(0); expect(library.c_peak_windings).toBe(1);
  expect(library.c_winding_allocs).toBe(1); expect(library.c_winding_points).toBe(4);
  expect(() => library.free(w)).toThrow("FreeWinding: freed a freed winding");
  expect(library.c_active_windings).toBe(0); zone.checkHeap();
});

test("copy/reverse own independent float storage, plane, area, center and bounds follow clockwise input", () => {
  const library = new CollisionWindingLibrary(), w = polygon(library, square);
  const copy = library.copy(w), reversed = library.reverse(w);
  expect(library.plane(w)).toEqual({ normal: vec3(0, 0, 1), distance: 0 });
  expect(library.area(w)).toBe(16); expect(library.center(w)).toEqual(vec3(0, 0, 0));
  expect(library.bounds(w)).toEqual({ min: vec3(-2, -2, 0), max: vec3(2, 2, 0) });
  expect(reversed.points).toEqual([...square].reverse());
  copy.setPoint(0, vec3(50, 60, 70)); expect(w.points).toEqual(square);
  library.check(w); library.free(w); library.free(copy); library.free(reversed);
  expect(library.c_active_windings).toBe(0);
});

test("two-sided clipping snaps axial crossings and retains input", () => {
  const library = new CollisionWindingLibrary(), w = polygon(library, square);
  const result = library.clip(w, { normal: vec3(1, 0, 0), distance: 0 }, 0.1);
  expect(result.front?.points).toEqual([vec3(0, 2, 0), vec3(2, 2, 0), vec3(2, -2, 0), vec3(0, -2, 0)]);
  expect(result.back?.points).toEqual([vec3(-2, -2, 0), vec3(-2, 2, 0), vec3(0, 2, 0), vec3(0, -2, 0)]);
  expect(w.points).toEqual(square); expect(library.c_active_windings).toBe(3);
  if (result.front === null || result.back === null) throw new Error("Crossing fixture did not split");
  expect(library.area(result.front) + library.area(result.back)).toBe(16);
  library.free(result.front); library.free(result.back); library.free(w);
});

test("on-plane clip goes to back, in-place chop frees it, front-only chop retains identity", () => {
  const library = new CollisionWindingLibrary(), w = polygon(library, square);
  const plane = { normal: vec3(0, 0, 1), distance: 0 };
  const result = library.clip(w, plane, 0.1);
  expect(result.front).toBeNull(); expect(result.back?.points).toEqual(square);
  if (result.back === null) throw new Error("On-plane fixture lost back winding");
  library.free(result.back);
  expect(library.chopInPlace(w, { normal: vec3(0, 0, 1), distance: -1 })).toBe(w);
  expect(library.chopInPlace(w, plane)).toBeNull(); expect(library.c_active_windings).toBe(0);
});

test("ChopWinding frees input and back after producing a front copy", () => {
  const library = new CollisionWindingLibrary(), w = polygon(library, square);
  const front = library.chop(w, { normal: vec3(1, 0, 0), distance: 0 });
  expect(front?.numPoints).toBe(4); expect(library.c_active_windings).toBe(1); expect(library.c_peak_windings).toBe(3);
  expect(() => w.numPoints).toThrow("freed");
  if (front === null) throw new Error("Crossing fixture lost front"); library.free(front);
});

test("colinear removal, side classification and base winding cover source helpers", () => {
  const library = new CollisionWindingLibrary(), w = polygon(library, [vec3(-2, -2, 0), vec3(-2, 0, 0), vec3(-2, 2, 0), vec3(2, 2, 0), vec3(2, -2, 0)]);
  library.removeColinearPoints(w); expect(w.points).toEqual(square); expect(library.c_removed).toBe(1);
  expect(library.onPlaneSide(w, { normal: vec3(1, 0, 0), distance: 0 })).toBe(WindingSide.Cross);
  expect(library.onPlaneSide(w, { normal: vec3(0, 0, 1), distance: -1 })).toBe(WindingSide.Front);
  expect(library.onPlaneSide(w, { normal: vec3(0, 0, 1), distance: 1 })).toBe(WindingSide.Back);
  expect(library.onPlaneSide(w, { normal: vec3(0, 0, 1), distance: 0 })).toBe(WindingSide.On);
  const base = library.baseForPlane({ normal: vec3(0, 0, 1), distance: 9 });
  expect(base.points).toEqual([vec3(65535, 65535, 9), vec3(65535, -65535, 9), vec3(-65535, -65535, 9), vec3(-65535, 65535, 9)]);
  library.free(base); library.free(w);
});

test("convex hull keeps source point order and replaces its old allocation even for contained input", () => {
  const library = new CollisionWindingLibrary(), w = polygon(library, square);
  const hull = library.addToConvexHull(w, null, vec3(0, 0, 1));
  expect(hull).not.toBe(w); expect(hull.points).toEqual(square);
  const point = polygon(library, [vec3(4, 0, 0)]);
  const expanded = library.addToConvexHull(point, hull, vec3(0, 0, 1));
  expect(expanded.points).toEqual([vec3(4, 0, 0), vec3(2, -2, 0), vec3(-2, -2, 0), vec3(-2, 2, 0), vec3(2, 2, 0)]);
  expect(library.area(expanded)).toBe(20); library.check(expanded);
  expect(() => hull.numPoints).toThrow("freed");
  library.free(expanded); library.free(point); library.free(w);
});

test("CheckWinding rejects each source-invalid geometry", () => {
  const library = new CollisionWindingLibrary();
  const check = (points: readonly Vec3[], message: string): void => { const w = polygon(library, points); expect(() => library.check(w)).toThrow(message); library.free(w); };
  check([vec3(0, 0, 0)], "1 points");
  check([vec3(0, 0, 0), vec3(0, 0.5, 0), vec3(0.5, 0.5, 0)], "area");
  check([vec3(70000, 0, 0), vec3(70000, 2, 0), vec3(70002, 2, 0)], "BUGUS_RANGE");
  check([vec3(-2, -2, 0), vec3(-2, 2, 0), vec3(2, 2, 0), vec3(2, -2, 1)], "point off plane");
  check([...square, vec3(-2, -2, 0)], "degenerate edge");
  check([vec3(-2, -2, 0), vec3(-2, 2, 0), vec3(0, 0, 0), vec3(2, 2, 0), vec3(2, -2, 0)], "non-convex");
});

test("patch generation uses one common winding owner and real source zone, with source counters and pw output", () => {
  const zone = new ZoneArena(65536), prints: string[] = [];
  const debug = new CollisionDebugSurface({ cvars: new CvarRegistry(), print: text => { prints.push(text); }, developerPrint: () => undefined,
    windings: { allocate: bytes => zone.allocate(bytes, ZoneTag.General, true), free: allocation => zone.free(allocation) } });
  const points = Array.from({ length: 9 }, (_, i) => vec3(i % 3 * 32, Math.floor(i / 3) * 32, 0));
  const patch = generatePatchCollide(3, 3, points, debug);
  expect(patch.facets.length).toBe(1); expect(debug.c_totalPatchBlocks).toBe(1);
  expect(debug.windings.c_active_windings).toBe(0); expect(debug.windings.c_winding_allocs).toBe(10);
  expect(debug.windings.c_peak_windings).toBe(2);
  const w = polygon(debug.windings, [vec3(1, -2, 3)]); debug.printWinding(w); debug.windings.free(w);
  expect(prints).toEqual(["(  1.0,  -2.0,   3.0)\n"]);
  debug.clearLevelPatches(); expect(debug.c_totalPatchBlocks).toBe(1); expect(debug.windings.c_winding_allocs).toBe(11);
  zone.checkHeap();
});

test("pw formats binary32 ties to even and keeps signed zero", () => {
  const library = new CollisionWindingLibrary(), output: string[] = [];
  const w = polygon(library, [vec3(1.25, -1.25, -0)]);
  library.pw(w, text => { output.push(text); });
  expect(output).toEqual(["(  1.2,  -1.2,  -0.0)\n"]);
  library.free(w);
});
