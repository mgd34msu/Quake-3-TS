// Source expectations: renderer/tr_surface.c, tr_shade.c and tr_backend.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import type { Md3Surface, Md3Vertex } from "../src/assets/md3.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import type { Axis } from "../src/core/math.ts";
import { vec2, vec3, vec4 } from "../src/core/math.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { createModelEntity, createPortalEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import type { SourceRefEntityRecord } from "../src/render/ref-entity.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { finishImplicitShader, finishShader } from "../src/render/material-finish.ts";
import type { FinishLoadedImageMetadata } from "../src/render/material-finish.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { publishTexture } from "./render-target-fixture.ts";
import { loadMd4Resource, Md4AllocationReadError } from "../src/render/md4-resource.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { deformGeometry, RendererNoise } from "../src/render/deform.ts";
import { evaluateMaterialStages } from "../src/render/picture-material.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { projectDlightTexture } from "../src/render/dlight.ts";
import type { SurfaceViewOperation } from "../src/render/types.ts";

const axis: Axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
function vertex(value: number): BspVertex {
  return { position: vec3(value, value + 1, value + 2), normal: vec3(value + 3, value + 4, value + 5),
    texCoord: vec2(value + 6, value + 7), lightmapCoord: vec2(value + 8, value + 9), color: vec4(value + 10, value + 11, value + 12, value + 13) };
}
function mesh(value: number, count = 3) { return { vertices: Array.from({ length: count }, (_, index) => vertex(value + index)), indices: [0, 1, 2] }; }
function registry(script = "", images = new RendererImageCatalog()) {
  const definitions = parseShaderScript(`clamped { clampTime 1 { map $whiteimage } } ${script}`);
  const image = publishTexture(images, { name: "tess-white", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const registered = createRendererSettings().registrationProfile();
  const profile = { ...registered, iterator: { ...registered.iterator, ignoreFastPath: false } };
  const baseImage: FinishLoadedImageMetadata = { kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image } } } };
  return new MaterialRegistry(async (name, lighting) => {
    const definition = definitions.find(item => item.name === name) ?? null;
    const finished = definition === null ? finishImplicitShader({ name, baseImage, profile, kind: name === "*default" ? "default" : lighting.kind === "picture" ? "picture" : "dynamic" })
      : finishShader({ definition, lightmapIndex: -1, images: definition.stages.map(() => baseImage), profile });
    return { definition, image, whiteImage: image, finished, defaulted: false, sky: null };
  }, text => { throw new Error(text); });
}
function first<T>(items: readonly T[]): T { const item = items[0]; if (item === undefined) throw new Error("fixture has no first element"); return item; }
function md3Surface(frames: Md3Surface["frames"]): Md3Surface {
  return { name: "tess-md3", flags: 0, shaders: [], frames, triangles: [{ indices: [0, 1, 2] }],
    texCoords: Array.from({ length: first(frames).length }, (_, index) => vec2(index / 4, 0.75)) };
}

type Md4FixtureLayout = "quad" | "gap-seed" | "gap-consumer";
function md4Fixture(declaredFrames = 2, layout: Md4FixtureLayout = "quad"): Uint8Array {
  const offsets = layout === "quad" ? [vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1)]
    : Array.from({ length: layout === "gap-seed" ? 9 : 3 }, (_, index) => vec2(index % 2, index % 3));
  const surfaces = layout === "gap-seed" ? [{ name: "seed", indices: [] }]
    : layout === "gap-consumer" ? [{ name: "first", indices: [0, 1, 2, 0, 1, 2] }, { name: "second", indices: [1, 1, 1] }]
    : [{ name: "first", indices: [0, 1, 2, 0, 2, 3] }, { name: "second", indices: [0, 1, 2, 0, 2, 3] }];
  const frameBytes = 40 + 2 * 48;
  const surfaceSize = (indices: readonly number[]) => 168 + indices.length * 4 + 8 + offsets.length * 44;
  const lodBytes = 12 + surfaces.reduce((sum, surface) => sum + surfaceSize(surface.indices), 0);
  const byteLength = 100 + 2 * frameBytes + lodBytes;
  const writer = new BinaryWriter(byteLength);
  const name = (value: string): void => {
    const bytes = new Uint8Array(64);
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index);
    writer.bytes(bytes);
  };
  writer.u32(0x34504449); writer.i32(1); name("tess.md4");
  for (const value of [declaredFrames, 2, 0, 100, 1, 100 + 2 * frameBytes, byteLength]) writer.i32(value);
  for (const scale of [2, 4]) {
    for (const value of [-100, -100, -100, 100, 100, 100, 0, 0, 0, 100]) writer.f32(value);
    for (const value of [1, 0, 0, -100, 0, 1, 0, 0, 0, 0, 1, 0,
      scale, 0, 0, layout === "gap-seed" ? 3e38 : scale * 10, 0, scale, 0, 0, 0, 0, scale, 0]) writer.f32(value);
  }
  writer.i32(surfaces.length); writer.i32(12); writer.i32(lodBytes);
  for (const surface of surfaces) {
    const start = writer.offset;
    const boneReferencesOffset = 168 + surface.indices.length * 4;
    writer.i32(0); name(surface.name); name("md4");
    for (const value of [0, -start, offsets.length, boneReferencesOffset + 8, surface.indices.length / 3, 168, 2, boneReferencesOffset, surfaceSize(surface.indices)]) writer.i32(value);
    for (const index of [...surface.indices, 1, 0]) writer.i32(index);
    for (const [index, offset] of offsets.entries()) {
      for (const value of [2, 0, 0, offset.x, offset.y]) writer.f32(value);
      writer.i32(1); writer.i32(layout === "quad" || layout === "gap-seed" && index === 6 ? 1 : 0);
      writer.f32(layout === "quad" ? 0.5 : index === 6 ? 2 : 1);
      for (const value of [0, offset.x, offset.y]) writer.f32(value);
    }
  }
  return writer.finish();
}

async function md4Resource(materials: MaterialRegistry, declaredFrames = 2, layout: Md4FixtureLayout = "quad") {
  const defaultMaterial = await materials.register("*default", { kind: "none" });
  const resource = await loadMd4Resource({ bytes: md4Fixture(declaredFrames, layout), source: "tess.md4", defaultMaterial,
    material: name => materials.register(name, { kind: "none" }),
    registration: { allocate: length => new Uint8Array(length), publish: () => undefined,
      print: text => { throw new Error(text); }, shaderForHandle: index => materials.findByHandle(index) } });
  if (resource === null) throw new Error("MD4 fixture was rejected");
  return resource;
}

function selectModel(tess: SourceTessState, frame = 0, oldFrame = 0, backLerp = 0): void {
  const entity = createModelEntity(); entity.frame = frame; entity.oldFrame = oldFrame; entity.backLerp = backLerp; entity.axis = axis;
  tess.setEntity({ ...tess.context, kind: "entity", entity });
}

test("source BSS, Begin/End and partial BSP→2D→MD3 writes preserve unwritten attributes and stage arrays", async () => {
  const tess = new SourceTessState(), materials = registry(), a = await materials.register("a", { kind: "none" });
  expect(tess.stageColor(0)).toEqual(vec4(0, 0, 0, 0)); expect(tess.stageTexCoord(1, 0)).toEqual(vec2(0, 0));
  tess.beginSurface(a, 2, 3); tess.appendGeometry(mesh(1), "bsp-normal");
  tess.writeStageColor(0, vec4(23 / 255, 71 / 255, 192 / 255, 35 / 255)); tess.writeStageTexCoord(1, 0, vec2(0.375, 0.75));
  tess.endSurface(); expect(tess.numVertexes).toBe(3); expect(tess.numIndexes).toBe(0);
  tess.beginSurface(a, 0, 4); tess.appendGeometry(mesh(40), "stretch-pic");
  expect(first(tess.snapshotGeometry().vertices)).toEqual({ ...vertex(40), normal: vertex(1).normal, lightmapCoord: vertex(1).lightmapCoord });
  tess.endSurface(); tess.beginSurface(a, 0, 5); tess.appendGeometry(mesh(80), "md3");
  expect(first(tess.snapshotGeometry().vertices)).toEqual({ ...vertex(80), lightmapCoord: vertex(1).lightmapCoord, color: vertex(40).color });
  expect(tess.stageColor(0)).toEqual({ x: 23 / 255, y: 71 / 255, z: 192 / 255, w: 35 / 255 });
  expect(tess.stageTexCoord(1, 0)).toEqual(vec2(0.375, 0.75));
});

test("rail writes RGB but not alpha, poly does not write normal/UV1, and BSP skips normal when needsNormal is false", async () => {
  const tess = new SourceTessState(), a = await registry().register("a", { kind: "none" });
  tess.beginSurface(a, 0, 0); tess.appendGeometry(mesh(1), "stamp");
  for (const writer of ["rail", "poly", "bsp"] satisfies readonly ("rail" | "poly" | "bsp")[]) {
    tess.endSurface(); tess.beginSurface(a, 0, 0); tess.appendGeometry(mesh(40), writer);
    const result = first(tess.snapshotGeometry().vertices);
    expect(result.normal).toEqual(vertex(1).normal);
    expect(result.lightmapCoord).toEqual(writer === "bsp" ? vertex(40).lightmapCoord : vertex(1).lightmapCoord);
    expect(result.color.w).toBe(writer === "rail" ? 14 : 53);
  }
});

test("allocated reads retain inactive source slots while snapshots keep only active vertices", async () => {
  const tess = new SourceTessState(), material = await registry().register("a", { kind: "none" });
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(1, 6), "stamp");
  const retained = tess.allocatedVertex(4);
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(40), "md3");
  expect(tess.numVertexes).toBe(3); expect(tess.snapshotGeometry().vertices).toHaveLength(3);
  expect(tess.allocatedVertex(4)).toEqual(vertex(5));
  tess.resetGeometry(); tess.appendGeometry(mesh(80, 6), "stamp");
  expect(retained).toEqual(vertex(5)); expect(tess.allocatedVertex(4)).toEqual(vertex(84));
  expect(tess.allocatedVertex(999).position).toEqual(vec3(0, 0, 0));
  for (const index of [-1, 0.5, 1000, Infinity, NaN]) expect(() => tess.allocatedVertex(index)).toThrow("outside scratch allocation");
});

test("R_BuildCloudData resets counts and writes XYZ/UV0 per pass without overwriting source colors/normals/UV1", async () => {
  const tess = new SourceTessState(), material = await registry().register("sky", { kind: "none" });
  tess.beginSurface(material, 0, 7); tess.appendGeometry(mesh(1), "bsp-normal");
  tess.resetGeometry(); tess.appendGeometry(mesh(40), "cloud"); tess.appendGeometry({ vertices: mesh(40).vertices, indices: [] }, "cloud");
  const snapshot = tess.snapshotGeometry();
  expect(tess.material).toBe(material); expect(tess.shaderTime).toBe(7); expect(tess.numVertexes).toBe(6);
  expect(snapshot.indices).toEqual([0, 1, 2]);
  expect(first(snapshot.vertices)).toEqual({ ...vertex(1), position: vertex(40).position, texCoord: vertex(40).texCoord });
  expect(snapshot.vertices[3]?.color).toEqual(vec4(0, 0, 0, 0));
});

test("same shader StretchPic after End appends after retained vertices, while remap and overflow Begin advance exactly one hop", async () => {
  const tess = new SourceTessState(), materials = registry(), a = await materials.register("a", { kind: "picture" }), b = await materials.register("b", { kind: "picture" }), c = await materials.register("c", { kind: "picture" });
  a.remapped = b; b.remapped = c;
  tess.beginSurface(a, 4, 2); expect(tess.material).toBe(b);
  tess.appendGeometry(mesh(1), "bsp-normal"); tess.endSurface(); tess.appendGeometry(mesh(20), "stretch-pic");
  expect(tess.numVertexes).toBe(6); expect(tess.snapshotGeometry().indices).toEqual([3, 4, 5]);
  tess.endSurface(); tess.beginSurface(b, tess.fog, tess.floatTime); expect(tess.material).toBe(c);
  tess.appendGeometry({ vertices: mesh(1, 999).vertices, indices: [0, 1, 2] }, "stamp");
  expect(tess.wouldOverflow(1, 0)).toBe(true); expect(tess.wouldOverflow(0, 5997)).toBe(true);
  expect(tess.wouldOverflow(0, 5996)).toBe(false); expect(() => tess.wouldOverflow(1000, 0)).toThrow("single surface");
  expect(() => tess.appendGeometry(mesh(1), "poly")).toThrow("overflow boundary");
});

test("Begin clamps shaderTime, later entity rebase does not, and direct RB_SetGL2D always refreshes time", async () => {
  const tess = new SourceTessState(), material = await registry().register("clamped", { kind: "none" }); material.timeOffset = 0.5;
  tess.enterView({ origin: vec3(10, 20, 30), axis, mirror: false }, 10, createRefdef());
  tess.beginSurface(material, 0, tess.floatTime); expect(tess.shaderTime).toBe(1);
  tess.setShaderTime(7.5); tess.endSurface(); tess.setGL2D(12345);
  expect(tess.shaderTime).toBe(7.5); expect(tess.floatTime).toBe(12.345000267028809);
  tess.setGL2D(54321); expect(tess.floatTime).toBe(54.32100296020508);
  tess.endFrame(); tess.setGL2D(54321); expect(tess.floatTime).toBe(Math.fround(Math.fround(54321) * Math.fround(0.001)));
});

test("RB_SetGL2D disables actual culling without changing GL_Cull cache; mirrored face only updates when the cache changes", () => {
  const tess = new SourceTessState(); tess.enterView({ origin: vec3(0, 0, 0), axis, mirror: false }, 0, createRefdef());
  expect(tess.cullState("front")).toBe("front"); tess.setGL2D(12345);
  expect(tess.cullState("front")).toBe("none"); expect(tess.cullState("back")).toBe("back");
  tess.enterView({ origin: vec3(0, 0, 0), axis, mirror: true }, 1, createRefdef());
  expect(tess.cullState("front")).toBe("back"); tess.setGL2D(2000);
  expect(tess.cullState("front")).toBe("none"); expect(tess.cullState("back")).toBe("front");
});

test("entity2D selects source-zero lighting/entity but retains last view and orientation; snapshots own attributes", async () => {
  const tess = new SourceTessState(), entity = createModelEntity(), origin = { x: 1, y: 2, z: 3 };
  entity.shaderRGBA = vec4(50, 60, 70, 80);
  tess.setEntity({ kind: "entity", entity, localViewOrigin: origin, orientationAxis: axis, orientationOrigin: origin,
    lighting: { ambientLight: vec3(40, 50, 60), directedLight: vec3(10, 20, 30), lightDir: vec3(1, 0, 0), ambientLightInt: 0xff3c3228 } });
  origin.x = 999; entity.shaderRGBA = vec4(0, 0, 0, 0);
  expect(tess.context.localViewOrigin.x).toBe(1);
  tess.setGL2D(1000); expect(tess.context.kind).toBe("entity");
  tess.selectEntity2D(); expect(tess.context.kind).toBe("2d"); expect(tess.context.localViewOrigin).toEqual(vec3(1, 2, 3)); expect(tess.context.orientationAxis).toEqual(axis);
  expect(tess.context.orientationOrigin).toEqual(vec3(1, 2, 3));
  expect(tess.context.lighting.ambientLightInt).toBe(0);
  const selected = tess.context.entity; if (selected === null || selected.kind === "portal-surface") throw new Error("missing entity2D");
  expect(selected.shaderRGBA).toEqual(vec4(0, 0, 0, 0));
  const material = await registry().register("a", { kind: "none" }); tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(1), "stamp");
  const snapshot = tess.snapshotGeometry(); tess.replaceGeometry(mesh(80)); expect(first(snapshot.vertices)).toEqual(vertex(1));
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(40), "poly"); expect(first(tess.snapshotGeometry().vertices).normal).toEqual(vertex(80).normal);
  expect(() => tess.stageColor(-1)).toThrow(); expect(() => tess.writeStageTexCoord(1, 1000, vec2(0, 0))).toThrow();
});

test("RB_SurfaceMesh retains each reached position cell when a later MD3 component read fails", async () => {
  const tess = new SourceTessState(), material = await registry().register("md3", { kind: "none" });
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(4), "stamp"); tess.resetGeometry(); selectModel(tess);
  const failing: Md3Vertex = { position: { x: 24, get y(): number { throw new Error("MD3 Y read"); }, z: 26 }, normal: vec3(-1, 0, 0) };
  const source = md3Surface([[failing, vertex(30), vertex(40)]]);
  expect(() => Array.from(tess.appendMd3(source, () => []))).toThrow("MD3 Y read");
  expect([tess.numVertexes, tess.numIndexes]).toEqual([0, 0]);
  expect(tess.allocatedVertex(0)).toEqual({ ...vertex(4), position: vec3(24, 5, 6) });
});

test("RB_SurfaceMesh delays MD3 normal normalization and index/ST reads until all interpolated vertices are written", async () => {
  const tess = new SourceTessState(), material = await registry().register("md3", { kind: "none" });
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(4), "stamp"); tess.resetGeometry(); selectModel(tess, 1, 0, 0.25);
  const old = { position: vec3(16, 20, 24), normal: vec3(1, 0, 0) };
  const current = { position: vec3(32, 36, 40), normal: vec3(0, 1, 0) };
  const failing: Md3Vertex = { position: { get x(): number { throw new Error("later MD3 X read"); }, y: 0, z: 0 }, normal: vec3(0, 0, 1) };
  const source = md3Surface([[old, old, old], [current, failing, current]]);
  expect(() => Array.from(tess.appendMd3(source, () => []))).toThrow("later MD3 X read");
  expect([tess.numVertexes, tess.numIndexes]).toEqual([0, 0]);
  expect(tess.allocatedVertex(0)).toEqual({ ...vertex(4), position: vec3(28, 32, 36), normal: vec3(0.25, 0.75, 0) });
  expect(tess.allocatedVertex(1)).toEqual(vertex(5));
});

test("RB_SurfaceMesh publishes MD3 indices before per-cell ST failures and retains unwritten attributes", async () => {
  const tess = new SourceTessState(), material = await registry().register("md3", { kind: "none" });
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(4, 4), "stamp"); tess.resetGeometry(); selectModel(tess);
  const source: Md3Surface = { ...md3Surface([[vertex(16), vertex(24), vertex(32)]]), triangles: [{ indices: [0, 3, 2] }],
    texCoords: [{ x: 0.25, get y(): number { throw new Error("MD3 T read"); } }, vec2(1, 0), vec2(0, 1)] };
  expect(() => Array.from(tess.appendMd3(source, () => []))).toThrow("MD3 T read");
  expect([tess.numVertexes, tess.numIndexes]).toEqual([0, 3]);
  expect(tess.snapshotGeometry().indices).toEqual([0, 3, 2]);
  expect(tess.allocatedVertex(0)).toEqual({ ...vertex(4), position: vertex(16).position, normal: vertex(16).normal, texCoord: vec2(0.25, 11) });
  expect(tess.snapshotIndexedGeometry().vertices[3]).toEqual(vertex(7));
});

test("RB_SurfaceMesh captures MD3 backlerp before overflow and reads the selected pose after the flush resumes", async () => {
  const tess = new SourceTessState(), material = await registry().register("md3", { kind: "none" });
  const entities = new SourceSceneEntities(), entity = createModelEntity();
  entity.frame = 1; entity.oldFrame = 0; entity.backLerp = 0.25;
  entities.addRefEntity(entity);
  const cell = entities.sceneRange().entity(0);
  tess.selectSceneEntity(cell, tess.context);
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(4, 998), "stamp");
  const source = md3Surface([mesh(16).vertices, mesh(32).vertices]);
  const steps = tess.appendMd3(source, function* (): Generator<SurfaceViewOperation, void, unknown> {
    expect([tess.numVertexes, tess.numIndexes]).toEqual([998, 3]);
    yield { kind: "depth-range", range: [0, 1] };
    tess.endSurface();
    cell.entity.frame = 0; cell.entity.oldFrame = 1; cell.entity.backLerp = 0.75;
  });
  expect(steps.next()).toMatchObject({ done: false, value: { kind: "depth-range" } });
  expect(tess.numVertexes).toBe(998);
  expect(steps.next().done).toBe(true);
  expect([tess.numVertexes, tess.numIndexes]).toEqual([3, 3]);
  expect(tess.allocatedVertex(0).position).toEqual(vec3(20, 21, 22));
});

test("RB_SurfaceMesh flushes retained MD3 geometry before an oversized-surface drop without beginning another surface", async () => {
  const tess = new SourceTessState(), material = await registry().register("md3", { kind: "none" });
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(4), "stamp"); selectModel(tess);
  const source = { ...md3Surface([mesh(16).vertices]), texCoords: Array.from({ length: 1000 }, () => vec2(0, 0)) };
  let flushes = 0;
  expect(() => Array.from(tess.appendMd3(source, () => { flushes++; tess.endSurface(); return []; })))
    .toThrow("RB_CheckOverflow: verts > MAX (1000 > 1000)");
  expect(flushes).toBe(1); expect([tess.numVertexes, tess.numIndexes]).toEqual([3, 0]);
  expect(tess.allocatedVertex(0)).toEqual(vertex(4));
});

test("RB_SurfaceAnim adds numIndexes, retains UV1/color, and publishes referenced inactive allocated cells", async () => {
  const tess = new SourceTessState(), materials = registry(), resource = await md4Resource(materials);
  const surface = first(resource.firstLodSurfaces()), material = surface.material;
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(30, 10), "stamp");
  tess.beginSurface(material, 0, 0); selectModel(tess, 1, 0, 0.25);
  for (const part of resource.firstLodSurfaces()) tess.appendMd4(part);
  const active = tess.snapshotGeometry(), indexed = tess.snapshotIndexedGeometry();
  expect(tess.numVertexes).toBe(8); expect(tess.numIndexes).toBe(12);
  expect(active.vertices).toHaveLength(8); expect(indexed.vertices).toHaveLength(10);
  expect(active.indices).toEqual([0, 1, 2, 0, 2, 3, 6, 7, 8, 6, 8, 9]);
  expect(indexed.indices).toEqual(active.indices);
  expect(active.vertices[0]).toEqual({ ...vertex(30), position: vec3(17.5, 0, 0), normal: vec3(3.5, 0, 0), texCoord: vec2(0, 0) });
  expect(active.vertices[6]).toEqual({ ...vertex(36), position: vec3(17.5, 1.75, 1.75), normal: vec3(3.5, 0, 0), texCoord: vec2(1, 1) });
  expect(indexed.vertices[8]).toEqual(vertex(38)); expect(indexed.vertices[9]).toEqual(vertex(39));
  tess.beginSurface(material, 0, 0); tess.appendGeometry(mesh(80, 10), "stamp");
  expect(indexed.vertices[8]).toEqual(vertex(38));
});

test("MD4 index writes precede allocation animation reads, while initial NULL and incomplete diagnostic records precede all writes", async () => {
  const materials = registry(), surface = first((await md4Resource(materials)).firstLodSurfaces());
  const tess = new SourceTessState(); tess.beginSurface(surface.material, 0, 0);
  expect(() => tess.appendMd4(surface)).toThrow("currentEntity is NULL before pose access");
  expect(tess.numIndexes).toBe(0); expect(tess.numVertexes).toBe(0);
  tess.setEntity({ ...tess.context, kind: "entity", entity: createSpriteEntity() });
  expect(() => tess.appendMd4(surface)).toThrow("does not represent the source pose cells");
  expect(tess.numIndexes).toBe(0);
  selectModel(tess, 999);
  expect(() => tess.appendMd4(surface)).toThrow(Md4AllocationReadError);
  expect(tess.numVertexes).toBe(0); expect(tess.numIndexes).toBe(6);
  expect(tess.snapshotGeometry().indices).toEqual([0, 1, 2, 0, 2, 3]);
});

test("MD4 consumes selected world/2D zero pose, portal frame profile, and allocated frames beyond logical frame count", async () => {
  const materials = registry(), surface = first((await md4Resource(materials, 1)).firstLodSurfaces());
  const tess = new SourceTessState(); tess.beginSurface(surface.material, 0, 0);
  tess.setEntity({ ...tess.context, kind: "world", entity: null }); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(10);
  tess.resetGeometry(); selectModel(tess, 1); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(20);
  tess.resetGeometry(); tess.selectEntity2D(); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(10);
  const portal: SourceRefEntityRecord = { ...createModelEntity(), ...createPortalEntity(), frame: 1, oldFrame: 0, radius: 0, rotation: 0 };
  tess.resetGeometry(); tess.setEntity({ ...tess.context, kind: "entity", entity: portal }); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(20);
});

test("selected scene cells supply current pose and lighting across mutation and frame reuse, while orientation is copied", async () => {
  const materials = registry(), surface = first((await md4Resource(materials)).firstLodSurfaces());
  const tess = new SourceTessState(), entities = new SourceSceneEntities(), submitted = createModelEntity(); submitted.axis = axis;
  entities.addRefEntity(submitted);
  const cell = entities.sceneRange().entity(0), orientationOrigin = { x: 1, y: 2, z: 3 };
  tess.selectSceneEntity(cell, { orientationOrigin, orientationAxis: axis, localViewOrigin: vec3(4, 5, 6) });
  orientationOrigin.x = 90;
  const selected = cell.entity;
  if (selected.kind !== "model") throw new Error("Fixture needs actual model cell");
  selected.frame = 1; selected.oldFrame = 0; selected.backLerp = 0.25;
  expect(tess.context.entity).toBe(selected); expect(tess.context.orientationOrigin.x).toBe(1);
  const lighting = cell.setupLighting({ grid: null, noWorldModel: true, identityLight: 1, identityLightByte: 255,
    ambientScale: 1, directedScale: 1, sunDirection: vec3(0, 0, 1), dynamicLights: [] });
  expect(tess.context.lighting).toBe(lighting);
  tess.beginSurface(surface.material, 0, 0); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(17.5);
  entities.rolloverFrame(); entities.addRefEntity(submitted);
  expect(entities.sceneRange().entity(0)).toBe(cell); expect(tess.context.entity).toBe(selected);
  tess.beginSurface(surface.material, 0, 0); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(10);
  expect(tess.context.lighting).toBe(lighting);
  tess.selectEntity2D(); expect(tess.context.kind).toBe("2d");
  const reused = cell.entity;
  if (reused.kind !== "model") throw new Error("Fixture needs reused model cell");
  reused.frame = 999;
  tess.resetGeometry(); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(10);
  tess.selectSceneEntity(cell, { orientationOrigin, orientationAxis: axis, localViewOrigin: vec3(4, 5, 6) });
  tess.setEntity({ ...tess.context, kind: "world", entity: null });
  tess.resetGeometry(); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(10);
});

test("retained nonmodel source records keep numeric handles and animation fields through detached copies and scene-cell selection", async () => {
  const surface = first((await md4Resource(registry())).firstLodSurfaces());
  const tess = new SourceTessState(), entities = new SourceSceneEntities();
  const origin = { x: 4, y: 5, z: 6 }, sourceAxis = { x: 2, y: 0, z: 0 };
  const submitted: SourceRefEntityRecord = { ...createModelEntity(), kind: "sprite", model: -31, customShader: 12345, customSkin: -29,
    frame: 1, oldFrame: 0, backLerp: 0.25, radius: 0, rotation: 0, origin, axis: [sourceAxis, axis[1], axis[2]] };
  tess.setEntity({ ...tess.context, kind: "entity", entity: submitted });
  const detached = tess.context.entity;
  if (detached === null || !("backLerp" in detached)) throw new Error("Fixture needs complete source pose");
  expect(detached).not.toBe(submitted); expect(detached.model).toBe(-31);
  expect(detached.customShader).toBe(12345); expect(detached.customSkin).toBe(-29);
  origin.x = 900; sourceAxis.x = 7; submitted.frame = 0;
  expect(detached.origin.x).toBe(4); expect(detached.axis[0].x).toBe(2); expect(detached.frame).toBe(1);
  tess.beginSurface(surface.material, 0, 0); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(17.5);
  entities.addRefEntityRecord(() => submitted);
  const cell = entities.sceneRange().entity(0), selected = cell.entity;
  if (!("backLerp" in selected)) throw new Error("Fixture needs complete source cell pose");
  tess.selectSceneEntity(cell, { orientationOrigin: vec3(0, 0, 0), orientationAxis: axis, localViewOrigin: vec3(0, 0, 0) });
  expect(tess.context.entity).toBe(selected);
  selected.frame = 1; selected.backLerp = 0.5;
  tess.resetGeometry(); tess.appendMd4(surface);
  expect(first(tess.snapshotGeometry().vertices).position.x).toBe(15);
  expect(selected.model).toBe(-31); expect(selected.customShader).toBe(12345); expect(selected.customSkin).toBe(-29);
});

test("MD4 keeps accumulated dlight bits and requires caller overflow boundaries without repairing source index values", async () => {
  const materials = registry(), surface = first((await md4Resource(materials)).firstLodSurfaces()), tess = new SourceTessState();
  selectModel(tess, 1); tess.beginSurface(surface.material, 0, 0);
  tess.appendGeometry(mesh(1, 996), "stamp"); tess.addDlightBits(4);
  expect(() => tess.appendMd4(surface)).toThrow("overflow boundary");
  expect(tess.numVertexes).toBe(996); expect(tess.numIndexes).toBe(3); expect(tess.dlightBits).toBe(4);
  tess.endSurface(); tess.beginSurface(surface.material, 0, 0); tess.addDlightBits(2); tess.appendMd4(surface);
  expect(tess.dlightBits).toBe(2); expect(first(tess.snapshotGeometry().vertices).position.x).toBe(20);
  tess.resetGeometry(); tess.appendGeometry({ vertices: mesh(1).vertices, indices: Array.from({ length: 333 }, () => [0, 1, 2]).flat() }, "md3");
  tess.appendMd4(surface);
  expect(tess.numVertexes).toBe(7); expect(tess.snapshotGeometry().indices.slice(999)).toEqual([999, 1000, 1001, 999, 1001, 1002]);
  expect(() => tess.snapshotIndexedGeometry()).toThrow("outside scratch allocation");
});

const retainedStageScript = `
seed {
  { map $whiteimage rgbGen const ( .2 .4 .6 ) alphaGen const .8 tcMod scroll .5 .25 }
  { map $whiteimage blendFunc filter rgbGen const ( .2 .4 .6 ) alphaGen const .8 tcGen lightmap tcMod scale 2 3 }
}
generic { deformVertexes move 3 0 0 sin 1 0 0 0 { map $whiteimage rgbGen identity } }
paired { { map $whiteimage rgbGen identity tcGen vector ( 0 1 0 ) ( 0 0 1 ) } { map $whiteimage blendFunc filter tcGen lightmap } }
lightmapped { { map $lightmap rgbGen identity } { map $whiteimage blendFunc filter } }
`;

for (const kind of ["generic", "paired", "vertex-lit", "lightmapped"] satisfies readonly ("generic" | "paired" | "vertex-lit" | "lightmapped")[]) {
  test(`genuine MD4 retained-tail publication uses the ${kind} source attribute bindings without widening active generation`, async () => {
    const materials = registry(retainedStageScript), resource = await md4Resource(materials), tess = new SourceTessState();
    const seed = await materials.register("seed", { kind: "none" }), material = await materials.register(kind, { kind: "none" });
    const noise = new RendererNoise(), runtime = createRendererSettings().runtime;
    const project = (position: BspVertex["position"]) => vec4(position.x, position.y, position.z, 1);
    tess.beginSurface(seed, 0, 1); tess.appendGeometry(mesh(30, 10), "stamp");
    const seeded = first(evaluateMaterialStages(seed, tess, project, 1, noise, runtime)).batch;
    expect(seeded.texturing).toBe("pair"); expect(seed.finished.iterator.kind).toBe("generic");
    const oldColor = tess.stageColor(8), oldUV0 = tess.stageTexCoord(0, 8), oldUV1 = tess.stageTexCoord(1, 8);
    expect(oldColor).toEqual({ x: 51 / 255, y: 102 / 255, z: 153 / 255, w: 204 / 255 });
    expect(oldUV0).toEqual(vec2(44.5, 45.25)); expect(oldUV1).toEqual(vec2(92, 141));
    tess.beginSurface(material, 0, 2); selectModel(tess);
    for (const surface of resource.firstLodSurfaces()) tess.appendMd4(surface);
    const deformed = deformGeometry(tess, material.definition?.deforms ?? [],
      { axis, mirror: false, entityAxis: axis, nonNormalizedAxis: null }, tess.shaderTime, noise);
    expect(deformed.vertices).toHaveLength(8); expect(tess.allocatedVertex(8)).toEqual(vertex(38));
    expect(deformed.vertices[0]?.position.x).toBe(kind === "generic" ? 13 : 10);
    expect(deformed.vertices[4]?.position.x).toBe(kind === "generic" ? 13 : 10);
    expect(material.finished.iterator.kind).toBe(kind === "paired" ? "generic" : kind === "lightmapped" ? "lightmapped-multitexture" : kind);
    const stage = first(evaluateMaterialStages(material, tess, project, 1, noise, runtime)), batch = stage.batch, tail = batch.vertices[6];
    if (tail === undefined) throw new Error("Missing genuinely indexed retained MD4 slot");
    expect(tess.numVertexes).toBe(8); expect(tess.numIndexes).toBe(12); expect(batch.vertices).toHaveLength(8);
    expect(tess.snapshotGeometry().indices).toEqual([0, 1, 2, 0, 2, 3, 6, 7, 8, 6, 8, 9]);
    expect(batch.indices).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect(batch.vertices.map(vertex => vertex.position)).toEqual([0, 1, 2, 3, 6, 7, 8, 9].map(slot => project(tess.allocatedVertex(slot).position)));
    expect(tail.position).toEqual(vec4(38, 39, 40, 1));
    expect(tail.color).toEqual(kind === "lightmapped" ? { x: 1, y: 1, z: 1, w: 1 } : oldColor);
    expect(tail.texCoord).toEqual(kind === "vertex-lit" || kind === "lightmapped" ? vertex(38).texCoord : oldUV0);
    expect(tess.stageColor(8)).toEqual(oldColor); expect(tess.stageTexCoord(0, 8)).toEqual(oldUV0); expect(tess.stageTexCoord(1, 8)).toEqual(oldUV1);
    expect(stage.scratch).toHaveLength(batch.vertices.length);
    expect(stage.scratch[6]).toEqual({ color: oldColor, texCoord: oldUV0, texCoord2: oldUV1,
      rawTexCoord: vertex(38).texCoord, rawTexCoord2: vertex(38).lightmapCoord });
    if (kind !== "lightmapped") expect(tess.stageColor(4)).not.toEqual(oldColor);
    if (kind === "paired" || kind === "lightmapped") {
      if (batch.texturing !== "pair") throw new Error("Expected real collapsed multitexture pass");
      expect(batch.vertices[6]?.texCoord2).toEqual(kind === "lightmapped" ? vertex(38).lightmapCoord : oldUV1);
    }
  });
}

test("genuine MD4 fog publication keeps inactive stage color/UV retained after active-only fog generation", async () => {
  const materials = registry(retainedStageScript), resource = await md4Resource(materials), tess = new SourceTessState();
  const seed = await materials.register("seed", { kind: "none" }), material = await materials.register("generic", { kind: "none" });
  const noise = new RendererNoise(), runtime = createRendererSettings().runtime;
  const project = (position: BspVertex["position"]) => vec4(position.x, position.y, position.z, 1);
  tess.beginSurface(seed, 0, 1); tess.appendGeometry(mesh(30, 10), "stamp");
  evaluateMaterialStages(seed, tess, project, 1, noise, runtime);
  const oldColor = tess.stageColor(8), oldUV = tess.stageTexCoord(0, 8);
  tess.beginSurface(material, 1, 2); selectModel(tess);
  for (const surface of resource.firstLodSurfaces()) tess.appendMd4(surface);
  tess.setFogContext({ texture: material.whiteImage, coordinates: () => vec2(0.25, 0.5),
    volume: { bounds: { min: vec3(-100, -100, -100), max: vec3(100, 100, 100) }, surface: { normal: vec3(1, 0, 0), distance: 0 },
      color: { x: 1, y: 0, z: 0, w: 1 }, tcScale: 1 } });
  const batches = evaluateMaterialStages(material, tess, project, 1, noise, runtime), fog = batches[1]?.batch;
  if (fog === undefined) throw new Error("Expected source fog pass");
  expect(batches).toHaveLength(2); expect(tess.numVertexes).toBe(8); expect(fog.vertices).toHaveLength(8);
  expect(fog.vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 1 }); expect(fog.vertices[0]?.texCoord).toEqual(vec2(0.25, 0.5));
  expect(fog.vertices[6]?.color).toEqual(oldColor); expect(fog.vertices[6]?.texCoord).toEqual(oldUV);
  expect(batches[1]?.scratch[6]).toEqual({ color: oldColor, texCoord: oldUV, texCoord2: tess.stageTexCoord(1, 8),
    rawTexCoord: tess.allocatedVertex(8).texCoord, rawTexCoord2: tess.allocatedVertex(8).lightmapCoord });
});

test("mixed BSP and MD4 batches retain light bits and reject only reached inactive projected-light scratch", async () => {
  const materials = registry(), resource = await md4Resource(materials), surface = first(resource.firstLodSurfaces());
  const tess = new SourceTessState(), images = new RendererImageCatalog();
  const image = new BuiltinImages(images, identityImageUploadProfile).find("*dlight")?.image;
  if (image === undefined) throw new Error("Fixture needs actual built-in dlight image");
  const light = { origin: vec3(0, 0, 0), radius: 1000, color: vec3(1, 1, 1) };
  const project = (position: BspVertex["position"]) => vec4(position.x, position.y, position.z, 1);
  tess.beginSurface(surface.material, 0, 0); tess.appendGeometry(mesh(30, 14), "stamp");
  tess.beginSurface(surface.material, 0, 0); selectModel(tess); tess.appendGeometry(mesh(1), "bsp-normal"); tess.addDlightBits(1);
  tess.appendMd4(surface);
  expect(projectDlightTexture(tess.snapshotGeometry(), tess.dlightBits, [light], image, project, "none")).toHaveLength(1);
  tess.appendMd4(surface);
  expect(tess.dlightBits).toBe(1); expect(tess.numVertexes).toBe(11);
  expect(tess.snapshotGeometry().indices.slice(9)).toEqual([9, 10, 11, 9, 11, 12]);
  expect(tess.allocatedVertex(12)).toEqual(vertex(42));
  expect(projectDlightTexture(tess.snapshotGeometry(), 0, [light], image, project, "none")).toEqual([]);
  expect(() => projectDlightTexture(tess.snapshotGeometry(), tess.dlightBits, [light], image, project, "none"))
    .toThrow("inactive source scratch is indeterminate");
});

for (const kind of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  test.skipIf(kind === "gl" && process.env["QUAKE_GL_TEST"] !== "1")(`zero-triangle MD4 seed leaves an unindexed nonfinite gap that the actual ${kind} draw must not consume`, async () => {
    const images = new RendererImageCatalog();
    const window = kind === "gl" ? SdlWindow.open({ title: "MD4 retained allocation", width: 32, height: 32, backend: "gl", hidden: true }) : null;
    let target: RenderTarget | null = null;
    try {
      const backend = window === null ? new SoftwareRenderer(32, 32, images) : new GlRenderer(window, images);
      if (backend instanceof GlRenderer) backend.initializeDefaultState(backend.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
      target = new RenderTarget(images, [backend]);
      const materials = registry("gap { cull none { map $whiteimage rgbGen identity } }", images);
      const seed = first((await md4Resource(materials, 2, "gap-seed")).firstLodSurfaces());
      const consumer = await md4Resource(materials, 2, "gap-consumer"), material = await materials.register("gap", { kind: "none" });
      const tess = new SourceTessState(), runtime = createRendererSettings().runtime;
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess, runtime });
      let evaluations = 0;
      tess.bindSurfaceEvaluator((identityLight, noise, settings) => {
        evaluations++;
        const batches = evaluateMaterialStages(material, tess, position => vec4(position.y * 0.5 - 0.5, position.z * 0.5 - 0.5, (position.x + 100) / 1000, 1), identityLight, noise, settings);
        tess.endSurface(); return batches.map(stage => ({ kind: "source-stage", stage }));
      });
      backend.beginView({ viewport: { x: 0, y: 0, width: 32, height: 32 }, clear: { depth: 1, color: vec4(0, 0, 0, 1), stencil: false } });
      selectModel(tess); tess.beginSurface(seed.material, 0, 0); tess.appendMd4(seed);
      expect(tess.numVertexes).toBe(9); expect(tess.numIndexes).toBe(0);
      expect(tess.allocatedVertex(6).position.x).toBe(Infinity); expect(tess.allocatedVertex(7).position.x).toBe(-100);
      expect(commands.submitFrame()?.batches).toBe(0); expect(evaluations).toBe(0);
      tess.beginSurface(material, 0, 0);
      for (const surface of consumer.firstLodSurfaces()) tess.appendMd4(surface);
      expect(tess.numVertexes).toBe(6); expect(tess.snapshotGeometry().indices).toEqual([0, 1, 2, 0, 1, 2, 7, 7, 7]);
      expect(tess.allocatedVertex(6).position.x).toBe(Infinity);
      expect(commands.submitFrame()?.batches).toBe(1); expect(evaluations).toBe(1);
      const pixels = backend instanceof SoftwareRenderer ? backend.pixels : backend.readPixels();
      expect([...pixels.subarray((16 * 32 + 10) * 4, (16 * 32 + 10) * 4 + 4)]).toEqual([255, 255, 255, 255]);
    } finally { target?.close(); window?.close(); }
  });
}
