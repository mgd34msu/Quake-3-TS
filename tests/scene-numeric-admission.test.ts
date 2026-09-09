// Numeric scene admission ordering from id Software renderer/tr_scene.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import type { RefPolyVertex } from "../src/render/ref-entity.ts";
import { createModelEntity } from "../src/render/ref-entity.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission } from "../src/render/scene-submission.ts";
import { readQvmRefEntity } from "../src/vm/render-record.ts";

function vertices(x = 1) {
  return [0, 1, 2].map(index => ({ position: { x, y: index, z: 0 }, texCoord: { x: 0.1, y: 0.2 },
    color: { x: 1, y: 2, z: 3, w: 4 } }));
}

function fixture(maxPolys = 600, maxPolyVertices = 3000, fogBounds: () => readonly Bounds[] = () => []) {
  const entities = new SourceSceneEntities(), printed: string[] = [], state = { developer: false };
  const scene = new SourceSceneSubmission(entities, { maxPolys, maxPolyVertices }, {
    fogBounds, developerEnabled: () => state.developer, print: text => { printed.push(text); },
  });
  return { entities, scene, printed, state };
}

describe("numeric records use the shared source scene allocation", () => {
  test("entity reads follow the same capacity shared with typed submissions", () => {
    const { scene, entities } = fixture();
    for (let index = 0; index < 1021; index++) scene.addRefEntity(createModelEntity());
    const record = new DataView(new ArrayBuffer(140)); record.setInt32(0, 1, true); record.setInt32(112, -1, true);
    let reads = 0;
    expect(scene.addRefEntityRecord(() => { reads++; return readQvmRefEntity(record); })).toBeUndefined();
    expect(entities.sceneRange().entity(1021).entity).toMatchObject({ kind: "poly", customShader: -1 });
    scene.addRefEntityRecord(() => { reads++; throw new Error("Overflow record was read"); });
    expect(reads).toBe(1); expect(entities.sceneRange().length).toBe(1022);
  });

  test("zero shader warning wins over counts and vertex reads", () => {
    const { scene, printed } = fixture(0, 0);
    let reads = 0;
    const read = (): readonly RefPolyVertex[] => { reads++; throw new Error("Rejected vertices were read"); };
    scene.addPolysByHandle(0, 3, 1, read);
    scene.addPolysByHandle(0, -1, 0, read);
    expect(reads).toBe(0);
    expect(printed).toEqual(new Array<string>(2).fill("^3WARNING: RE_AddPolyToScene: NULL poly shader\n"));
    expect(scene.captureScene().polys).toHaveLength(0);
  });

  test("nonpositive polygon count never reads vertices", () => {
    const { scene, printed } = fixture();
    for (const count of [0, -1, -2147483648]) scene.addPolysByHandle(-7, 3, count, () => {
      throw new Error("No polygon should be read");
    });
    expect(printed).toEqual([]); expect(scene.captureScene().polys).toHaveLength(0);
  });

  test("polygon capacity precedes reads and partial batches retain numeric shaders", () => {
    const { scene, printed, state } = fixture(2, 99), readIndexes: number[] = [], source = vertices(0.1);
    state.developer = true;
    scene.addPolysByHandle(-2147483648, 3, 3, index => { readIndexes.push(index); return source; });
    expect(readIndexes).toEqual([0, 1]);
    expect(printed).toEqual(["^1WARNING: RE_AddPolyToScene: r_max_polys or r_max_polyverts reached\n"]);
    const capture = scene.captureScene();
    expect(capture.polys).toHaveLength(2);
    for (const vertex of source) { vertex.position.x = 99; vertex.texCoord.x = 99; vertex.color.x = 99; }
    for (const poly of capture.polys) {
      expect(poly.shader).toBe(-2147483648);
      expect(poly.vertices[0]).toEqual({ position: { x: Math.fround(0.1), y: 0, z: 0 },
        texCoord: { x: Math.fround(0.1), y: Math.fround(0.2) }, color: { x: 1, y: 2, z: 3, w: 4 } });
    }
    scene.clearScene();
    scene.addPolysByHandle(16777217, 3, 1, () => { throw new Error("Cleared allocation was reclaimed"); });
    expect(scene.captureScene().polys).toHaveLength(0);
    scene.rolloverFrame();
    scene.addPolysByHandle(16777217, 3, 1, () => vertices());
    expect(scene.captureScene().polys[0]?.shader).toBe(16777217);
  });

  test("vertex capacity is shared by typed and numeric polygons", () => {
    const { scene, printed, state } = fixture(99, 6);
    scene.addPoly({ shader: { name: "typed" }, vertices: vertices() });
    const reads: number[] = [];
    scene.addPolysByHandle(9, 3, 2, index => { reads.push(index); return vertices(); });
    expect(reads).toEqual([0]); expect(printed).toEqual([]);
    expect(scene.captureScene().polys.map(poly => poly.shader)).toEqual([{ name: "typed" }, 9]);
    state.developer = true;
    scene.addPolysByHandle(9, 3, 1, () => { throw new Error("Full vertex allocation was read"); });
    expect(printed).toHaveLength(1);
  });

  test("later record failure retains only prior accepted polygons", () => {
    const { scene } = fixture(4, 12);
    expect(() => scene.addPolysByHandle(-1, 3, 3, index => {
      if (index === 1) throw new Error("Second polygon is unreadable");
      return vertices(index);
    })).toThrow("Second polygon is unreadable");
    expect(scene.captureScene().polys).toHaveLength(1);
    scene.addPolysByHandle(7, 3, 3, () => vertices());
    expect(scene.captureScene().polys.map(poly => poly.shader)).toEqual([-1, 7, 7, 7]);
  });

  test("polygon counters advance before fog and prevent later reads after fog failure", () => {
    let fogReads = 0;
    const { scene } = fixture(2, 3, () => { fogReads++; throw new Error("Fog read failed"); });
    const reads: number[] = [];
    expect(() => scene.addPolysByHandle(17, 3, 2, index => { reads.push(index); return vertices(); })).toThrow("Fog read failed");
    expect(reads).toEqual([0]); expect(fogReads).toBe(1);
    expect(scene.captureScene().polys[0]).toMatchObject({ shader: 17, fog: -1 });
    scene.addPolysByHandle(18, 3, 1, () => { throw new Error("Retained vertex count was lost"); });
    expect(scene.captureScene().polys).toHaveLength(1);
  });

  test("numeric polygons retain the finite three-vertex profile before publication", () => {
    const { scene } = fixture();
    for (const count of [0, 1, 2, -1]) expect(() => scene.addPolysByHandle(1, count, 1, () => {
      throw new Error("Degenerate polygon was read");
    })).toThrow("requires at least three vertices");
    expect(() => scene.addPolysByHandle(1, 3, 1, () => vertices().slice(1))).toThrow("vertex count does not match");
    expect(() => scene.addPolysByHandle(1, 3, 1, () => vertices(Infinity))).toThrow("finite coordinates");
    expect(scene.captureScene().polys).toHaveLength(0);
  });

  test("light capacity and nonpositive intensity precede origin resolution", () => {
    const { scene } = fixture(), color = { x: 1, y: 0.5, z: 0.25 }, origin = { x: 0.1, y: 2, z: 3 };
    let reads = 0;
    const unreadable = (): Vec3 => { reads++; throw new Error("Rejected light origin was read"); };
    for (const radius of [0, -1, -Infinity]) scene.addLightRecord(radius, color, false, unreadable);
    scene.addLight({ origin, color, radius: 4 });
    for (let index = 1; index < 32; index++) scene.addLightRecord(0.1, color, true, () => origin);
    scene.addLightRecord(NaN, color, true, unreadable);
    scene.clearScene(); scene.addLightRecord(4, color, true, unreadable);
    expect(reads).toBe(0); expect(scene.captureScene().dynamicLights).toHaveLength(0);
    scene.rolloverFrame();
    scene.addLightRecord(0.1, color, true, () => { reads++; return origin; });
    origin.x = 99; color.x = 99;
    expect(reads).toBe(1);
    expect(scene.captureScene().dynamicLights[0]).toEqual({ radius: Math.fround(0.1), additive: true,
      origin: { x: Math.fround(0.1), y: 2, z: 3 }, color: { x: 1, y: 0.5, z: 0.25 } });
  });

  test("failed light origin resolution or finite checks leave capacity available", () => {
    const { scene } = fixture(), color = { x: 1, y: 1, z: 1 };
    expect(() => scene.addLightRecord(4, color, false, () => { throw new Error("Light pointer failed"); })).toThrow("Light pointer failed");
    expect(() => scene.addLightRecord(Infinity, color, false, () => ({ x: 1, y: 2, z: 3 }))).toThrow("finite float32");
    for (let index = 0; index < 32; index++) scene.addLightRecord(1, color, false, () => ({ x: 0, y: 0, z: 0 }));
    expect(scene.captureScene().dynamicLights).toHaveLength(32);
  });
});
