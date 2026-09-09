import { expect, test } from "bun:test";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission } from "../src/render/scene-submission.ts";
import { SourceBackendMemory } from "../src/render/backend-memory.ts";
import { polyGeometry } from "../src/render/entity-primitives.ts";
import type { RefPolyVertex } from "../src/render/ref-entity.ts";

for (const count of [1, 2]) test(`${count}-vertex polygons retain scene capacity, fog and zero-index geometry`, () => {
  const messages: string[] = [], scene = new SourceSceneSubmission(new SourceSceneEntities(), { maxPolys: 2, maxPolyVertices: count * 2 }, {
    fogBounds: () => [{ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } }],
    developerEnabled: () => true, print: text => { messages.push(text); },
  });
  const vertices: readonly RefPolyVertex[] = Array.from({ length: count }, (_, index) => ({ position: { x: index + 1, y: 1, z: 1 },
    texCoord: { x: 0, y: 1 }, color: { x: 255, y: 127, z: 63, w: 31 } }));
  scene.addPolysByHandle(7, count, 2, () => vertices);
  const capture = scene.captureScene();
  expect(capture.polys).toHaveLength(2);
  for (const poly of capture.polys) {
    expect(poly.shader).toBe(7); expect(poly.fog).toBe(0);
    expect(polyGeometry(poly).indices).toHaveLength(0);
    expect(polyGeometry(poly).vertices).toHaveLength(count);
  }
  scene.clearScene();
  scene.addPolysByHandle(7, count, 1, () => { throw new Error("Source capacity gate must precede vertex reads"); });
  expect(messages).toEqual(["^1WARNING: RE_AddPolyToScene: r_max_polys or r_max_polyverts reached\n"]);
  expect(scene.captureScene().polys).toHaveLength(0);
});

test("zero-vertex polygons consume only polygon slots without a world, including at full vertex capacity", () => {
  const limits = { maxPolys: 3, maxPolyVertices: 1 }, backend = SourceBackendMemory.local(limits);
  const scene = new SourceSceneSubmission(new SourceSceneEntities(backend), limits, {
    fogBounds: () => [], developerEnabled: () => false, print: () => undefined,
  }, { kind: "source", backend, shaderHandle: () => 7 });
  scene.addPolysByHandle(7, 0, 1, () => []);
  scene.addPolysByHandle(7, 1, 1, () => [{ position: { x: 1, y: 2, z: 3 }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } }]);
  scene.addPolysByHandle(7, 0, 1, () => []);
  const polys = scene.captureScene().polys;
  expect(polys.map(poly => [poly.vertices.length, poly.fog, polyGeometry(poly).indices.length])).toEqual([[0, -1, 0], [1, -1, 0], [0, -1, 0]]);
  expect(backend.polyData(2).getUint32(16, true)).toBe(backend.byteOffset + backend.byteLength);
  expect(() => backend.polyVertexData(1)).toThrow("outside its allocation");
  scene.clearScene();
  scene.addPolysByHandle(7, 0, 1, () => { throw new Error("Polygon capacity gate must still precede the empty copy"); });
  expect(scene.captureScene().polys).toHaveLength(0);
});

test("zero-vertex fog uses the retained first allocation cell after publication", () => {
  const limits = { maxPolys: 2, maxPolyVertices: 1 }, backend = SourceBackendMemory.local(limits);
  let fogReads = 0;
  const scene = new SourceSceneSubmission(new SourceSceneEntities(backend), limits, {
    fogBounds: () => { fogReads++; expect(backend.polyData(0).getInt32(0, true)).toBe(5); return [{ min: { x: 1, y: 1, z: 1 }, max: { x: 3, y: 3, z: 3 } }]; },
    developerEnabled: () => false, print: () => undefined,
  }, { kind: "source", backend, shaderHandle: () => 7 });
  const retained = backend.polyVertexData(0);
  for (const offset of [0, 4, 8]) retained.setFloat32(offset, 2, true);
  scene.addPolysByHandle(7, 0, 1, () => []);
  expect(scene.captureScene().polys[0]?.fog).toBe(0);
  expect(scene.captureScene().polys[0]?.vertices).toHaveLength(0);
  expect(fogReads).toBe(1);
});

test("zero-vertex fog dereference faults only after publishing a one-past polygon", () => {
  const limits = { maxPolys: 2, maxPolyVertices: 1 }, backend = SourceBackendMemory.local(limits);
  const scene = new SourceSceneSubmission(new SourceSceneEntities(backend), limits, {
    fogBounds: () => [{ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } }],
    developerEnabled: () => false, print: () => undefined,
  }, { kind: "source", backend, shaderHandle: () => 7 });
  scene.addPolysByHandle(7, 1, 1, () => [{ position: { x: 1, y: 2, z: 3 }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } }]);
  expect(() => scene.addPolysByHandle(7, 0, 1, () => [])).toThrow("outside its allocation");
  expect(backend.polyData(1).getInt32(0, true)).toBe(5);
  expect(backend.polyData(1).getUint32(16, true)).toBe(backend.byteOffset + backend.byteLength);
  expect(scene.captureScene().polys.map(poly => poly.vertices.length)).toEqual([1, 0]);
});
