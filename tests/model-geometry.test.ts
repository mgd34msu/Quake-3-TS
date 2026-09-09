// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { decodeMd3Normal, parseMd3, parseSkin } from "../src/assets/md3.ts";
import type { Md3Frame, Md3Model, Md3Surface, Md3Tag, Md3Vertex } from "../src/assets/md3.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { perspectiveMat4 } from "../src/core/math.ts";
import type { Axis, Bounds, Vec3 } from "../src/core/math.ts";
import { prepareMd3Entity, prepareMd3EntityPose, transformMd3Tag } from "../src/render/model-geometry.ts";
import type { Md3Entity, Md3EntityInput, Md3View } from "../src/render/model-geometry.ts";
import { RendererPerformanceCounters } from "../src/render/performance.ts";

const axis: Axis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
const origin: Vec3 = { x: 0, y: 0, z: 0 };
const bounds: Bounds = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
const frame: Md3Frame = { bounds, origin, radius: 1, name: "frame" };
const vertices: readonly Md3Vertex[] = [
  { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  { position: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  { position: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
];
const surface: Md3Surface = { name: "body", flags: 0, shaders: [{ name: "body/default", index: 4 }, { name: "body/red", index: 9 }],
  triangles: [{ indices: [0, 1, 2] }], texCoords: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  frames: [vertices, vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, x: vertex.position.x + 2 } }))] };
const tag: Md3Tag = { name: "tag_weapon", origin: { x: 1, y: 0, z: 0 }, axes: axis };
const model: Md3Model = { name: "fixture", flags: 0, skinCount: 0, frames: [frame, frame], tags: [[tag], [{ ...tag, origin: { x: 3, y: 0, z: 0 } }]], surfaces: [surface] };
const entity: Md3Entity = { origin, axis, nonNormalizedAxes: false, frame: 0, oldFrame: 0, backLerp: 0, wrapFrames: false,
  skinNum: 0, customShader: null, customSkin: null, thirdPerson: false };
const view: Md3View = { origin, forward: { x: 1, y: 0, z: 0 }, projection: perspectiveMat4(90, 1, 1, 1000),
  frustum: [{ normal: { x: 1, y: 0, z: 0 }, distance: -10 }, { normal: { x: -1, y: 0, z: 0 }, distance: -10 },
    { normal: { x: 0, y: 1, z: 0 }, distance: -10 }, { normal: { x: 0, y: -1, z: 0 }, distance: -10 }],
  noCull: false, isPortal: false, lodScale: 1, lodBias: 0 };

function input(overrides: Partial<Md3EntityInput> = {}): Md3EntityInput { return { md3: [model, null, null], numLods: 1, entity, view, fogBounds: null, ...overrides }; }

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected fixture record");
  return value;
}

describe("source MD3 entity geometry", () => {
  test("counts reached sphere and box outcomes, including no-cull and mismatched animation spheres", () => {
    for (const [x, scaled, noCull, expectedSphere, expectedBox] of [
      [0, false, false, "in", null], [20, false, false, "out", null],
      [9.5, false, false, "clip", "clip"], [11, false, false, "clip", "out"],
      [0, true, false, null, "in"], [20, true, false, null, "out"],
      [9.5, true, false, null, "clip"], [20, false, true, "clip", "clip"],
    ] satisfies readonly (readonly [number, boolean, boolean, "in" | "clip" | "out" | null, "in" | "clip" | "out" | null])[]) {
      const performance = new RendererPerformanceCounters();
      prepareMd3EntityPose({ md3: [model, null, null], numLods: 1,
        entity: { ...entity, origin: { x, y: 0, z: 0 }, nonNormalizedAxes: scaled, renderFlags: 0 },
        view: { ...view, noCull, performance }, frameWarning: () => undefined });
      expect([performance.frontEnd.c_sphere_cull_md3_in, performance.frontEnd.c_sphere_cull_md3_clip, performance.frontEnd.c_sphere_cull_md3_out])
        .toEqual([Number(expectedSphere === "in"), Number(expectedSphere === "clip"), Number(expectedSphere === "out")]);
      expect([performance.frontEnd.c_box_cull_md3_in, performance.frontEnd.c_box_cull_md3_clip, performance.frontEnd.c_box_cull_md3_out])
        .toEqual([Number(expectedBox === "in"), Number(expectedBox === "clip"), Number(expectedBox === "out")]);
    }
    const performance = new RendererPerformanceCounters();
    const moving = { ...model, frames: [frame, { ...frame, origin: { x: 20, y: 0, z: 0 } }] };
    prepareMd3EntityPose({ md3: [moving, null, null], numLods: 1,
      entity: { ...entity, frame: 1, renderFlags: 0 }, view: { ...view, performance }, frameWarning: () => undefined });
    expect([performance.frontEnd.c_sphere_cull_md3_in, performance.frontEnd.c_sphere_cull_md3_clip, performance.frontEnd.c_sphere_cull_md3_out]).toEqual([0, 0, 0]);
    expect(performance.frontEnd.c_box_cull_md3_in).toBe(1);
  });

  test("publishes frame repair into the borrowed entity before a later LOD failure", () => {
    const borrowed = { ...entity, frame: 8, oldFrame: 9, renderFlags: 0 };
    const observed: number[][] = [];
    expect(() => prepareMd3EntityPose({ md3: [model, null, null], numLods: 2, entity: borrowed,
      view: { ...view, lodBias: 1 }, frameWarning: (oldFrame, frame) => {
        observed.push([oldFrame, frame, borrowed.oldFrame, borrowed.frame]);
      } })).toThrow("consumed absent MD3 slot 1");
    expect(observed).toEqual([[9, 8, 9, 8]]);
    expect([borrowed.frame, borrowed.oldFrame]).toEqual([0, 0]);
  });

  test("pose culling does not read shader selection or interpolate unused vertices", () => {
    const borrowed = { ...entity, origin: { x: 20, y: 0, z: 0 }, backLerp: NaN, skinNum: -1, renderFlags: 0 };
    const prepared = prepareMd3EntityPose({ md3: [model, null, null], numLods: 1, entity: borrowed, view, frameWarning: () => undefined });
    expect(prepared.cull).toBe("out");
    expect(prepared.model).toBe(model);
  });

  test("only consumes the selected source slots and their selected frames", () => {
    expect(prepareMd3Entity(input({ md3: [model, null, model], numLods: 2 })).lod).toBe(0);
    expect(() => prepareMd3Entity(input({ md3: [model, null, model], numLods: 2, view: { ...view, lodBias: 1 } })))
      .toThrow("consumed absent MD3 slot 1");
    expect(() => prepareMd3Entity(input({ md3: [null, null, model] }))).toThrow("consumed absent MD3 slot 0");
    const oneFrame = { ...model, frames: [frame] };
    expect(prepareMd3Entity(input({ md3: [model, oneFrame, null], numLods: 2, view: { ...view, lodBias: 1 } })).frame).toBe(0);
    expect(() => prepareMd3Entity(input({ md3: [model, oneFrame, null], numLods: 2, entity: { ...entity, frame: 1 }, view: { ...view, lodBias: 1 } })))
      .toThrow("LOD MD3 frame 1");
  });
  test("wraps like C remainder and resets both frames when either is invalid", () => {
    const wrapped = prepareMd3Entity(input({ entity: { ...entity, frame: 5, oldFrame: 4, wrapFrames: true, backLerp: 0.25 } }));
    expect([wrapped.frame, wrapped.oldFrame, wrapped.backLerp, wrapped.frameFallback]).toEqual([1, 0, 0.25, false]);
    for (const [current, old] of [[2, 1], [1, -1], [-1, 1]] satisfies readonly [number, number][]) {
      const result = prepareMd3Entity(input({ entity: { ...entity, frame: current, oldFrame: old, backLerp: 0.5 } }));
      expect([result.frame, result.oldFrame, result.backLerp, result.frameFallback]).toEqual([0, 0, 0, true]);
    }
    expect(prepareMd3Entity(input({ entity: { ...entity, frame: -1, wrapFrames: true } })).frameFallback).toBe(true);
    const multiple = prepareMd3Entity(input({ entity: { ...entity, frame: -2, wrapFrames: true } }));
    expect(multiple.frame).toBe(0); expect(multiple.frameFallback).toBe(false);
    expect(prepareMd3Entity(input({ entity: { ...entity, frame: 1, oldFrame: 1, backLerp: 0.75 } })).backLerp).toBe(0);
  });

  test("chooses LOD from base-frame bounds, projection, capped scale, and final bias", () => {
    const lodFrame: Md3Frame = { ...frame, bounds: { min: origin, max: { x: 0, y: 0, z: 2 } }, radius: 999 };
    const base = { ...model, frames: [lodFrame, lodFrame] };
    const lods: Md3EntityInput["md3"] = [base, model, model];
    function choose(distance: number, lodScale = 1, lodBias = 0): number {
      return prepareMd3Entity(input({ md3: lods, numLods: 3, entity: { ...entity, origin: { x: distance, y: 0, z: 0 } }, view: { ...view, noCull: true, lodScale, lodBias } })).lod;
    }
    expect(choose(10)).toBe(2); expect(choose(5)).toBe(1); expect(choose(2)).toBe(0);
    expect(choose(-1)).toBe(0); expect(choose(0, 1, 1)).toBe(1);
    expect(choose(100, 20)).toBe(1); expect(choose(100, 200)).toBe(1);
    expect(choose(100, Infinity)).toBe(choose(100, 20));
    for (const unusedScale of [NaN, -Infinity, Infinity]) {
      expect(choose(0, unusedScale, 1)).toBe(1);
      expect(prepareMd3Entity(input({ view: { ...view, lodScale: unusedScale } })).lod).toBe(0);
    }
    for (const undefinedScale of [NaN, -Infinity]) expect(() => choose(100, undefinedScale)).toThrow("LOD float-to-int");
    expect(choose(10, -1)).toBe(2); expect(choose(10, 1, -1)).toBe(1);
    expect(choose(10, 1, 100)).toBe(2); expect(choose(10, 1, -100)).toBe(0);
    expect(prepareMd3Entity(input({ view: { ...view, lodBias: 2 } })).lod).toBe(0);
  });

  test("uses sphere early-outs, strict box boundaries, and four side planes", () => {
    expect(prepareMd3Entity(input()).cull).toBe("in");
    const far = { ...entity, origin: { x: 20, y: 0, z: 0 } };
    expect(prepareMd3Entity(input({ entity: far })).cull).toBe("out");
    expect(prepareMd3Entity(input({ entity: far })).surfaces).toEqual([]);
    expect(prepareMd3Entity(input({ entity: { ...entity, origin: { x: 9.5, y: 0, z: 0 } } })).cull).toBe("clip");
    expect(prepareMd3Entity(input({ entity: { ...entity, origin: { x: 11, y: 0, z: 0 } } })).cull).toBe("out");
    expect(prepareMd3Entity(input({ entity: { ...entity, origin: { x: 0, y: 0, z: 1000000 } } })).cull).toBe("in");
    expect(prepareMd3Entity(input({ entity: far, view: { ...view, noCull: true } })).cull).toBe("clip");
    const scaled: Axis = [{ x: 20, y: 0, z: 0 }, axis[1], axis[2]];
    expect(prepareMd3Entity(input({ entity: { ...far, axis: scaled, nonNormalizedAxes: true } })).cull).toBe("clip");
  });

  test("retains the source two-frame sphere shortcut even across opposite outside planes", () => {
    const left: Md3Frame = { ...frame, origin: { x: -20, y: 0, z: 0 }, bounds: { min: { x: -21, y: -1, z: -1 }, max: { x: -19, y: 1, z: 1 } } };
    const right: Md3Frame = { ...frame, origin: { x: 20, y: 0, z: 0 }, bounds: { min: { x: 19, y: -1, z: -1 }, max: { x: 21, y: 1, z: 1 } } };
    const moving = { ...model, frames: [left, right] };
    const animated = { ...entity, frame: 1, oldFrame: 0, backLerp: 0.5 };
    expect(prepareMd3Entity(input({ md3: [moving, null, null], entity: animated })).cull).toBe("out");
    expect(prepareMd3Entity(input({ md3: [moving, null, null], entity: { ...animated, nonNormalizedAxes: true } })).cull).toBe("clip");
  });

  test("selects custom shader, valid skin, default fallback, then surface shader modulo", () => {
    const skin = [{ name: "body", shader: "body/blue" }];
    const selection = (override: Partial<Md3Entity>) => first(prepareMd3Entity(input({ entity: { ...entity, ...override } })).surfaces).shader;
    expect(selection({ skinNum: 5 })).toEqual({ kind: "surface", name: "body/red", slot: 1 });
    expect(selection({ customSkin: skin, skinNum: 1 })).toEqual({ kind: "skin", name: "body/blue" });
    expect(selection({ customShader: "effects/custom", customSkin: skin })).toEqual({ kind: "custom", name: "effects/custom" });
    expect(selection({ customShader: "*default", customSkin: skin })).toEqual({ kind: "custom", name: "*default" });
    expect(selection({ customShader: "effects/custom", skinNum: -1 })).toEqual({ kind: "custom", name: "effects/custom" });
    expect(selection({ customSkin: [{ name: "BODY", shader: "wrong-case" }] })).toEqual({ kind: "default", reason: "missing-skin-surface" });
    expect(selection({ customSkin: [] })).toEqual({ kind: "default", reason: "missing-skin-surface" });
    const noShaders = { ...model, surfaces: [{ ...surface, shaders: [] }] };
    expect(first(prepareMd3Entity(input({ md3: [noShaders, null, null] })).surfaces).shader).toEqual({ kind: "default", reason: "no-surface-shaders" });
  });

  test("keeps model-local interpolation and transforms world positions/directions without renormalizing scaled axes", () => {
    const rotated: Axis = [{ x: 0, y: 2, z: 0 }, { x: -2, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }];
    const placed = { ...entity, origin: { x: 10, y: 20, z: 30 }, axis: rotated, nonNormalizedAxes: true, frame: 1, oldFrame: 0, backLerp: 0.25 };
    const result = first(prepareMd3Entity(input({ entity: placed, view: { ...view, noCull: true } })).surfaces);
    expect(first(result.localVertices).position).toEqual({ x: 1.5, y: 0, z: 0 });
    expect(first(result.vertices).position).toEqual({ x: 10, y: 23, z: 30 });
    expect(result.indices).toEqual([0, 1, 2]); expect(result.vertices.map(vertex => vertex.texCoord)).toEqual([...surface.texCoords]);
    const unblended = first(prepareMd3Entity(input({ entity: { ...placed, frame: 0 }, view: { ...view, noCull: true } })).surfaces);
    expect(first(unblended.vertices).normal).toEqual({ x: 0, y: 0, z: 2 });
  });

  test("matches native tr_surface.c interpolation through entity geometry", () => {
    // Original LerpMeshVertexes fixture: int16 xyz and lat/long packed normals.
    const old: Md3Vertex = { position: { x: -32768 / 64, y: 12345 / 64, z: -7 / 64 }, normal: decodeMd3Normal(0x1234) };
    const current: Md3Vertex = { position: { x: 32767 / 64, y: -23456 / 64, z: 19 / 64 }, normal: decodeMd3Normal(0xabc9) };
    const nativeModel = { ...model, surfaces: [{ ...surface, frames: [[old, old, old], [current, current, current]] }] };
    const result = first(prepareMd3Entity(input({ md3: [nativeModel, null, null], entity: { ...entity, frame: 1, oldFrame: 0, backLerp: 0.123456789 }, view: { ...view, noCull: true } })).surfaces);
    const expected: Md3Vertex = {
      position: { x: Math.fround(385.566559), y: Math.fround(-297.439423), z: Math.fround(0.246720687) },
      normal: { x: Math.fround(0.533783913), y: Math.fround(0.811051726), z: Math.fround(0.232161999) },
    };
    expect(first(result.localVertices)).toEqual(expected);
    expect(first(result.vertices).position).toEqual(expected.position);
    expect(first(result.vertices).normal).toEqual(expected.normal);
  });

  test("stores float32 matrix products and sums before cancellation", () => {
    const point: Md3Vertex = { position: { x: 1, y: 1, z: 1 }, normal: { x: 1, y: 1, z: 1 } };
    const cancellation = { ...model, surfaces: [{ ...surface, frames: [[point, point, point], [point, point, point]] }] };
    const axes: Axis = [{ x: 16777216, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: -16777216, y: 0, z: 1 }];
    const result = first(prepareMd3Entity(input({ md3: [cancellation, null, null], entity: { ...entity, axis: axes, nonNormalizedAxes: true }, view: { ...view, noCull: true } })).surfaces);
    // 2^24 + 1 rounds to 2^24 in float32 before subtracting 2^24.
    expect(first(result.vertices).position).toEqual({ x: 0, y: 1, z: 1 });
    expect(first(result.vertices).normal).toEqual({ x: 0, y: 1, z: 1 });
  });

  test("uses first intersecting fog with strict touching exclusion and unrotated local origin", () => {
    const fog = { min: { x: 4, y: -2, z: -2 }, max: { x: 6, y: 2, z: 2 } };
    const fogModel = { ...model, frames: [{ ...frame, origin: { x: 5, y: 0, z: 0 } }, frame] };
    const rotated: Axis = [{ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, axis[2]];
    expect(prepareMd3Entity(input({ md3: [fogModel, null, null], entity: { ...entity, axis: rotated }, fogBounds: [bounds, fog, fog] })).fogIndex).toBe(1);
    expect(prepareMd3Entity(input({ md3: [fogModel, null, null], fogBounds: null })).fogIndex).toBe(0);
    const touch = { min: { x: 6, y: -2, z: -2 }, max: { x: 9, y: 2, z: 2 } };
    expect(prepareMd3Entity(input({ md3: [fogModel, null, null], fogBounds: [fog, touch] })).fogIndex).toBe(0);
  });

  test("marks third-person surfaces for caller shadow routing and permits portal views", () => {
    const hidden = prepareMd3Entity(input({ entity: { ...entity, thirdPerson: true } }));
    expect(hidden.personalModel).toBe(true); expect(hidden.surfaces.length).toBe(1);
    expect(prepareMd3Entity(input({ entity: { ...entity, thirdPerson: true }, view: { ...view, isPortal: true } })).personalModel).toBe(false);
  });

  test("reuses source tag clamp and interpolation before parent rotation", () => {
    const parent = { origin: { x: 10, y: 20, z: 30 }, axis: [{ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, axis[2]] satisfies Axis };
    expect(transformMd3Tag(model, "tag_weapon", 0, 1, 0.5, parent)?.origin).toEqual({ x: 10, y: 22, z: 30 });
    expect(transformMd3Tag(model, "tag_weapon", 100, 100, 0, parent)?.origin).toEqual({ x: 10, y: 23, z: 30 });
    expect(transformMd3Tag(model, "missing", 0, 1, 0.5, parent)).toBeNull();
  });

  test("rejects undefined source indexes and nonfinite boundary input", () => {
    expect(() => prepareMd3Entity(input({ entity: { ...entity, skinNum: -1 } }))).toThrow("negative");
    expect(() => prepareMd3Entity(input({ entity: { ...entity, frame: 0.5 } }))).toThrow("int32");
    expect(() => prepareMd3Entity(input({ entity: { ...entity, backLerp: NaN } }))).toThrow("finite");
    expect(() => prepareMd3Entity(input({ entity: { ...entity, origin: { x: Infinity, y: 0, z: 0 } } }))).toThrow("finite");
    expect(() => prepareMd3Entity(input({ md3: [model, { ...model, frames: [] }, null], numLods: 2, view: { ...view, lodBias: 1 } }))).toThrow("LOD MD3 frame");
  });
});

const dataPath = process.env["Q3_DATA"];
if (dataPath !== undefined) {
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    test(`prepares retail Sarge and weapon LODs through ${product} assets`, async () => {
      const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
      const paths = ["models/players/sarge/head", "models/players/sarge/upper", "models/players/sarge/lower", "models/weapons2/machinegun/machinegun"];
      if (product === "missionpack") paths.push("models/weapons/nailgun/nailgun");
      for (const path of paths) {
        const base = parseMd3(await vfs.read(`${path}.md3`));
        const lods: Md3EntityInput["md3"] = [base, parseMd3(await vfs.read(`${path}_1.md3`)), parseMd3(await vfs.read(`${path}_2.md3`))];
        const skin = path.includes("/players/") ? parseSkin(new TextDecoder().decode(await vfs.read(`${path}_default.skin`))) : null;
        const unblended = prepareMd3Entity(input({ md3: [base, null, null], view: { ...view, noCull: true } }));
        expect(first(first(unblended.surfaces).vertices).position).toEqual(first(first(first(base.surfaces).frames)).position);
        expect(first(first(unblended.surfaces).vertices).normal).toEqual(first(first(first(base.surfaces).frames)).normal);
        for (const lodBias of [0, 1, 2]) {
          const result = prepareMd3Entity(input({ md3: lods, numLods: 3, entity: { ...entity, frame: base.frames.length - 1, oldFrame: 0, backLerp: 0.375, customSkin: skin },
            view: { ...view, noCull: true, lodBias } }));
          expect(result.lod).toBe(lodBias); expect(result.frameFallback).toBe(false); expect(result.surfaces.length).toBeGreaterThan(0);
          for (const selected of result.surfaces) {
            expect(selected.shader.kind).not.toBe("default");
            expect(selected.vertices.length).toBeGreaterThan(0);
            expect(selected.indices.length % 3).toBe(0);
            expect(selected.indices.every(index => index >= 0 && index < selected.vertices.length)).toBe(true);
            expect(selected.vertices.every(vertex => [vertex.position.x, vertex.position.y, vertex.position.z, vertex.normal.x, vertex.normal.y, vertex.normal.z].every(Number.isFinite))).toBe(true);
          }
        }
        const firstTag = base.tags[0]?.[0];
        if (firstTag !== undefined) expect(transformMd3Tag(base, firstTag.name, 0, base.frames.length + 10, 0.5, { origin, axis })).not.toBeNull();
      }
    }, 30000);
  }
}
