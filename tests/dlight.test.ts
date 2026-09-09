import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { bmodelDlightMask, faceDlightMask, gridDlightMask, iterateProjectedDlights, projectDlightTexture, splitDlightMask, transformDlights } from "../src/render/dlight.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { DynamicLight } from "../src/render/lighting.ts";
import { RendererPerformanceCounters } from "../src/render/performance.ts";

const light: DynamicLight = { origin: vec3(0, 0, 0), radius: 4, color: vec3(1, 0.5, 1.5) };
const project = (position: BspVertex["position"]) => ({ ...position, w: 1 });
function vertex(x: number, y: number, z: number): BspVertex {
  return { position: vec3(x, y, z), normal: vec3(0, 0, 1), texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 },
    color: { x: 255, y: 255, z: 255, w: 255 } };
}

test("projected light counters retain rejected vertex work and count only reached hit indices", () => {
  const image = new BuiltinImages(new RendererImageCatalog(), identityImageUploadProfile).find("*dlight")?.image;
  if (image === undefined) throw new Error("missing actual dlight image");
  const performance = new RendererPerformanceCounters();
  const geometry = { vertices: [vertex(0, 0, 0), vertex(1, 0, 0), vertex(0, 1, 0)], indices: [0, 1, 2] };
  projectDlightTexture(geometry, 3, [light, { ...light, origin: vec3(100, 0, 0) }], image, project, "none", performance);
  expect([performance.backEnd.c_dlightVertexes, performance.backEnd.c_dlightIndexes, performance.backEnd.c_totalIndexes]).toEqual([6, 3, 3]);
  projectDlightTexture(geometry, 0, [light], image, project, "none", performance);
  expect(performance.backEnd.c_dlightVertexes).toBe(6);
  expect(() => projectDlightTexture({ ...geometry, indices: [0, 1, 3] }, 1, [light], image, project, "none", performance)).toThrow("inactive source scratch");
  expect([performance.backEnd.c_dlightVertexes, performance.backEnd.c_dlightIndexes]).toEqual([9, 3]);
  const pending = iterateProjectedDlights(geometry, 1, [light], image, project, "none", performance);
  expect(pending.next().done).toBe(false);
  expect([performance.backEnd.c_dlightVertexes, performance.backEnd.c_dlightIndexes, performance.backEnd.c_totalIndexes]).toEqual([12, 3, 3]);
  expect(() => pending.throw(new Error("draw interrupted"))).toThrow("draw interrupted");
  expect([performance.backEnd.c_dlightIndexes, performance.backEnd.c_totalIndexes]).toEqual([3, 3]);
});

test("projected light UVs, height attenuation, byte truncation and blend state follow the scalar source", () => {
  const image = new BuiltinImages(new RendererImageCatalog(), identityImageUploadProfile).find("*dlight")?.image;
  if (image === undefined) throw new Error("missing actual dlight image");
  const geometry = { vertices: [vertex(0, 0, 0), vertex(1, -1, 3), vertex(-1, 1, 4)], indices: [0, 1, 2] };
  const batches = projectDlightTexture(geometry, 3, [light, { ...light, additive: true }], image, project, "back");
  expect(batches).toHaveLength(2);
  expect(batches[0]?.vertices.map(value => value.texCoord)).toEqual([{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.75 }, { x: 0.75, y: 0.25 }]);
  expect(batches[0]?.vertices.map(value => value.color)).toEqual([
    { x: 1, y: 127 / 255, z: 126 / 255, w: 1 }, { x: 127 / 255, y: 63 / 255, z: 191 / 255, w: 1 }, { x: 0, y: 0, z: 0, w: 1 },
  ]);
  expect(batches[0]?.state).toEqual({ blend: { source: "dst-color", destination: "one" }, depthTest: "equal", depthWrite: false, alphaTest: "none", cull: "back" });
  expect(batches[1]?.state.blend).toEqual({ source: "one", destination: "one" });
  expect(projectDlightTexture(geometry, 0, [light], image, project, "none")).toHaveLength(0);
  expect(projectDlightTexture({ vertices: [vertex(3, 0, 0), vertex(4, 1, 0), vertex(5, -1, 0)], indices: [0, 1, 2] },
    1, [light], image, project, "none")).toHaveLength(0);
  expect(projectDlightTexture({ vertices: [vertex(0, 0, 5), vertex(1, 1, 6), vertex(-1, -1, 7)], indices: [0, 1, 2] },
    1, [light], image, project, "none")).toHaveLength(0);
});

test("projected light rejects reached inactive scratch without rejecting an unselected light", () => {
  const image = new BuiltinImages(new RendererImageCatalog(), identityImageUploadProfile).find("*dlight")?.image;
  if (image === undefined) throw new Error("missing actual dlight image");
  const vertices = [vertex(0, 0, 0), vertex(1, 0, 0), vertex(0, 1, 0)];
  expect(projectDlightTexture({ vertices, indices: [0, 1, 2] }, 1, [light], image, project, "none")).toHaveLength(1);
  const inactive = { vertices, indices: [0, 1, 3] };
  expect(projectDlightTexture(inactive, 0, [light], image, project, "none")).toEqual([]);
  expect(() => projectDlightTexture(inactive, 1, [light], image, project, "none"))
    .toThrow("inactive source scratch is indeterminate");
});

test("world split/face/grid masks and transformed inline bounds keep source tangency rules", () => {
  const plane = { normal: vec3(1, 0, 0), distance: 0 }, bounds = { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) };
  const tangent = { ...light, origin: vec3(4, 0, 0) };
  expect(splitDlightMask([tangent], 1, plane)).toEqual([1, 0]);
  expect(faceDlightMask([tangent], 1, plane)).toBe(1);
  expect(faceDlightMask([{ ...tangent, origin: vec3(4.01, 0, 0) }], 1, plane)).toBe(0);
  expect(gridDlightMask([{ ...light, origin: vec3(5, 0, 0) }], 1, bounds)).toBe(1);
  expect(gridDlightMask([{ ...light, origin: vec3(5.01, 0, 0) }], 1, bounds)).toBe(0);
  const transformed = transformDlights([{ ...light, origin: vec3(10, 3, 0) }], vec3(10, 0, 0), anglesToAxis(vec3(0, 90, 0)));
  expect(transformed[0]?.origin.x).toBe(3);
  expect(bmodelDlightMask(transformed, bounds)).toBe(1);
  const thirtyTwo = Array.from({ length: 32 }, () => light);
  expect(splitDlightMask(thirtyTwo, -1, plane)).toEqual([-1, -1]);
  expect(bmodelDlightMask(thirtyTwo, bounds)).toBe(-1);
});
