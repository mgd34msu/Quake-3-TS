// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { generatePatchCollide, positionInPatch, tracePatch } from "../src/collision/patch.ts";
import type { PatchShape } from "../src/collision/patch.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import type { Product } from "../src/shared/definitions.ts";
import { vec3 } from "../src/core/math.ts";
import { HunkArena } from "../src/core/hunk.ts";
import type { HunkAllocation } from "../src/core/hunk.ts";

test("allocated patch reads retain mutable storage and reject cleared hunk lifetimes", () => {
  const arena = new HunkArena(4096, () => undefined);
  const allocations = new Map<string, HunkAllocation>();
  const points = Array.from({ length: 9 }, (_, index) => vec3(index % 3 * 32, Math.floor(index / 3) * 32, 0));
  const patch = generatePatchCollide(3, 3, points, null, (site, bytes) => {
    const allocation = arena.allocate(bytes, "high");
    allocations.set(site, allocation);
    return allocation;
  });
  const plane = patch.planes[0], facet = patch.facets[0];
  if (plane === undefined || facet === undefined) throw new Error("Planar patch fixture has no collision records");
  const border = facet.borders[0];
  if (border === undefined) throw new Error("Planar patch fixture has no border");
  const data = (site: string): DataView => {
    const allocation = allocations.get(site);
    if (allocation === undefined) throw new Error(`Missing patch allocation ${site}`);
    const bytes = allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  expect(patch.bounds.min.x).toBe(-1);
  expect(plane.normal.z).toBe(1);
  expect(plane.distance).toBe(0);
  const originalSurface = facet.surface, originalBorder = border.plane;
  data("CM_GeneratePatchCollide").setFloat32(0, -7, true);
  data("CM_PatchCollideFromGrid:planes").setFloat32(8, -0.5, true);
  data("CM_PatchCollideFromGrid:planes").setFloat32(12, 13, true);
  data("CM_PatchCollideFromGrid:facets").setInt32(0, originalSurface + 1, true);
  data("CM_PatchCollideFromGrid:facets").setInt32(8, originalBorder + 1, true);
  expect(patch.bounds.min.x).toBe(-7);
  expect(plane.normal.z).toBe(-0.5);
  expect(plane.distance).toBe(13);
  expect(facet.surface).toBe(originalSurface + 1);
  expect(border.plane).toBe(originalBorder + 1);
  arena.clear(null);
  expect(() => patch.bounds.min.x).toThrow("Hunk allocation is no longer valid");
  expect(() => patch.planes).toThrow("Hunk allocation is no longer valid");
  expect(() => plane.normal.z).toThrow("Hunk allocation is no longer valid");
  expect(() => plane.distance).toThrow("Hunk allocation is no longer valid");
  expect(() => facet.surface).toThrow("Hunk allocation is no longer valid");
  expect(() => border.plane).toThrow("Hunk allocation is no longer valid");
});

function patchAt(map: BspMap, index: number) {
  const surface = map.surfaces[index];
  if (surface === undefined || surface.type !== "patch") throw new Error("Missing retail patch fixture");
  const points = map.vertices.slice(surface.firstVertex, surface.firstVertex + surface.patchWidth * surface.patchHeight).map(vertex => vertex.position);
  return generatePatchCollide(surface.patchWidth, surface.patchHeight, points);
}

// Untouched cm_load/cm_patch/cm_polylib/q_math/q_shared; GCC 16.2.1 20260810 -m32 -O2
// -ffunction-sections -fdata-sections -Wl,--gc-sections -lm, no float flags.
// /tmp/quake3-patch-native-MfcMBV/{oracle.c,build.sh,traces.ts,compare.ts}.
// This x87 engine fixture is not QVM evidence. Rows capture native inputs too.
// surface, shape(0 point/1 box/2 capsule), fraction, plane xyzd, occupancy,
// start xyz, end xyz, stationary xyz.
const baseRows = `
0 0 0.500927687 -1 0 0 -768 0 511.400024 1437 227.800003 1023.40002 1437 227.800003 767.400024 1437 227.800003
0 1 0.497021437 -1 0 0 -766 1 511.400024 1437 227.800003 1023.40002 1437 227.800003 767.400024 1437 227.800003
0 2 0.497021437 -1 0 0 -766 1 511.400024 1437 227.800003 1023.40002 1437 227.800003 767.400024 1437 227.800003
9 0 0.439558566 -0.499276698 0.331209093 0.800639331 -250.341049 0 799.457703 347.28363 181.747223 544.542297 123.466385 -201.747223 672 235.375 -10
9 1 0.425434172 -0.271905988 0.244953036 0.930626214 -108.964798 0 799.457703 347.28363 181.747223 544.542297 123.466385 -201.747223 672 235.375 -10
9 2 0.428047985 -0.271905988 0.244953036 0.930626214 -111.721024 0 799.457703 347.28363 181.747223 544.542297 123.466385 -201.747223 672 235.375 -10
87 0 0.451268941 0.683037519 0.729900599 -0.0265488476 555.498535 0 761.912598 365.488953 20.0857239 411.993134 -8.21617126 26.7817688 586.952881 178.636383 23.4337463
87 1 0.44554171 0.683037519 0.729900599 -0.0265488476 558.430603 0 761.912598 365.488953 20.0857239 411.993134 -8.21617126 26.7817688 586.952881 178.636383 23.4337463
87 2 0.447258621 0.683037519 0.729900599 -0.0265488476 557.498535 0 761.912598 365.488953 20.0857239 411.993134 -8.21617126 26.7817688 586.952881 178.636383 23.4337463
93 0 0.63748318 -0.965348542 -0.19189702 -0.176855221 -739.703613 0 470.92511 -150.431229 95.4790039 873.07489 142.431229 216.520996 672 -4 156
93 1 0.324130416 0 -0.996936917 -0.0782102346 44.6746941 0 470.92511 -150.431229 95.4790039 873.07489 142.431229 216.520996 672 -4 156
93 2 0.324629009 0 -0.996936917 -0.0782102346 44.367981 0 470.92511 -150.431229 95.4790039 873.07489 142.431229 216.520996 672 -4 156`;
const missionRows = `
0 0 1 0 0 0 0 0 -448 2600 512 -448 2600 0 -448 2600 256
0 1 1 0 0 0 0 0 -448 2600 512 -448 2600 0 -448 2600 256
0 2 1 0 0 0 0 0 -448 2600 512 -448 2600 0 -448 2600 256
15 0 0.511945784 -0.948683321 -0.316227764 -0 556.560913 0 -1159.95435 1222.13708 484 -998.045715 1707.86292 484 -1079 1465 484
15 1 0.503710628 -0.948683321 -0.316227764 -0 559.090759 0 -1159.95435 1222.13708 484 -998.045715 1707.86292 484 -1079 1465 484
15 2 0.505435348 -0.948683321 -0.316227764 -0 558.560913 0 -1159.95435 1222.13708 484 -998.045715 1707.86292 484 -1079 1465 484
80 0 0.500927687 -1 0 0 644 0 -900.599976 1375.40002 413.399994 -388.599976 1375.40002 413.399994 -644.599976 1375.40002 413.399994
80 1 0.497021437 -1 0 0 646 1 -900.599976 1375.40002 413.399994 -388.599976 1375.40002 413.399994 -644.599976 1375.40002 413.399994
80 2 0.497021437 -1 0 0 646 1 -900.599976 1375.40002 413.399994 -388.599976 1375.40002 413.399994 -644.599976 1375.40002 413.399994`;

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product} every retail patch matches native per-surface plane/facet count digest and trace captures`, async () => {
    const assets = await VirtualFileSystem.openInspection({ dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", cdPath: null, product });
    const map = parseBsp(await assets.read(product === "baseq3" ? "maps/q3dm1.bsp" : "maps/mpteam1.bsp"));
    let count = 0, planes = 0, facets = 0, digest = 2166136261;
    for (const [index, surface] of map.surfaces.entries()) {
      if (surface.type !== "patch") continue;
      const patch = patchAt(map, index);
      count++; planes += patch.planes.length; facets += patch.facets.length;
      for (const value of [index, patch.planes.length, patch.facets.length]) digest = Math.imul(digest ^ value, 16777619) >>> 0;
    }
    expect({ count, planes, facets, digest }).toEqual(product === "baseq3"
      ? { count: 113, planes: 4959, facets: 774, digest: 1613161224 }
      : { count: 412, planes: 4777, facets: 842, digest: 5485536 });
    if (product === "baseq3") {
      const first = patchAt(map, 0);
      expect(first.facets.length).toBe(4); expect(first.planes.length).toBe(17);
    }
    for (const line of (product === "baseq3" ? baseRows : missionRows).trim().split("\n")) {
      const values = line.split(" ").map(Number);
      const value = (index: number): number => {
        const result = values[index];
        if (result === undefined || !Number.isFinite(result)) throw new Error("Incomplete native patch trace row");
        return Math.fround(result);
      };
      expect(values.length).toBe(17);
      const shape: PatchShape = value(1) === 0 ? { kind: "point", mins: vec3(0, 0, 0), extents: vec3(0, 0, 0) }
        : value(1) === 1 ? { kind: "box", mins: vec3(-2, -2, -4), extents: vec3(2, 2, 4) }
        : { kind: "capsule", extents: vec3(2, 2, 4), radius: 2, offset: vec3(0, 0, 2) };
      const patch = patchAt(map, value(0));
      const result = tracePatch(patch, vec3(value(8), value(9), value(10)), vec3(value(11), value(12), value(13)), shape);
      expect(positionInPatch(patch, vec3(value(14), value(15), value(16)), shape)).toBe(value(7) !== 0);
      if (value(2) === 1) { expect(result).toBeNull(); continue; }
      if (result === null) throw new Error(`Missed native patch contact: ${line}`);
      // Existing trace arithmetic stays on its established float32 profile;
      // native generation/contact planes are exact; x87 fractions differ by ULPs.
      expect(Math.abs(result.fraction - value(2))).toBeLessThan(0.0000005);
      expect(result.plane).toEqual({ normal: vec3(value(3), value(4), value(5)), distance: value(6) });
    }
  });
}
