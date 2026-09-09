import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// DrawTris/DrawNormals and RB_EndSurface, id Software renderer/tr_shade.c;
// RB_StageIteratorSky/R_BuildCloudData, renderer/tr_sky.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import type { CvarReference } from "../src/core/cvar.ts";
import { anglesToAxis, vec2, vec3, vec4 } from "../src/core/math.ts";
import type { Vec3, Vec4 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { snapshotSourceDebugOperations } from "../src/render/debug-draw.ts";
import { deformGeometry, RendererNoise } from "../src/render/deform.ts";
import { fogCoordinates } from "../src/render/fog.ts";
import type { FogVolume } from "../src/render/fog.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { evaluatePictureSurface } from "../src/render/picture-material.ts";
import { createModelEntity } from "../src/render/ref-entity.ts";
import type { SourceRefEntityRecord } from "../src/render/ref-entity.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { SourceDebugNormals, SourceDebugTris, ViewOperation } from "../src/render/types.ts";
import { RendererResources } from "../src/render/world.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const noise = new RendererNoise();
const camera = { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) };

class CvarReads extends CvarRegistry {
  readonly reads: string[] = [];
  override find(name: string): CvarReference | undefined { this.reads.push(name); return super.find(name); }
}

async function fixture(script: string, worldShader = "plain") {
  const data = new Map([
    ["scripts/debug.shader", new TextEncoder().encode(script)],
    ["maps/debug.bsp", renderBspFixture([{ shader: worldShader, lightmap: -1 }, { shader: worldShader, lightmap: -1 }], [])],
  ]);
  const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    has: path => data.has(path), list: prefix => [...data.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    read: async path => { const bytes = data.get(path); if (bytes === undefined) throw new Error(`Missing debug fixture ${path}`); return bytes; },
  });
  const cvars = new CvarReads(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  cvars.set("r_showtris", "1"); cvars.set("r_shownormals", "1");
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cpu = new SoftwareRenderer(64, 64, images, 8, 8), target = new RenderTarget(images, [cpu]);
  const mixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); } });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, images, builtins, target, imageProfile: identityImageUploadProfile, print: () => undefined, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  return { resources, cvars, settings, builtins, cpu, target };
}

function vertex(slot: number): BspVertex {
  return { position: vec3(slot, slot + 10, slot + 20), normal: vec3(slot + 0.5, slot + 1, slot + 1.5),
    texCoord: vec2(slot / 16, slot / 32), lightmapCoord: vec2(slot / 8, slot / 4), color: vec4(20 + slot, 40 + slot, 60 + slot, 80 + slot) };
}
function triangle(): readonly BspVertex[] {
  return [{ ...vertex(0), position: vec3(0, 0, 0) }, { ...vertex(1), position: vec3(8, 0, 0) }, { ...vertex(2), position: vec3(0, 8, 0) }];
}
function project(position: Vec3): Vec4 {
  return vec4(position.x * 2 + position.z, position.y * 3, position.z * 4, position.x + 5);
}
function debugTail(operations: readonly ViewOperation[]): readonly [SourceDebugTris, SourceDebugNormals] {
  const tail = operations.filter(operation => operation.kind !== "log-comment");
  const tris = tail.at(-2), normals = tail.at(-1);
  if (tris?.kind !== "debug-tris" || normals?.kind !== "debug-normals") throw new Error("Missing ordered source debug tail");
  return [tris.input, normals.input];
}
const plain = "plain { cull none { map $whiteimage rgbGen exactvertex alphaGen vertex } }";

test("debug snapshots compact referenced slots 8/9 with matching svars, preserve strip order and include active unreferenced normals after deformation", async () => {
  const { resources } = await fixture("moved { deformVertexes move 1 2 3 sin 1 0 0 0 { map $whiteimage } }");
  const material = resources.picture(await resources.registerShaderNoMip("moved")).material;
  if (material.definition === null) throw new Error("Missing registered deformation");
  const tess = new SourceTessState(), seed = Array.from({ length: 10 }, (_, slot) => vertex(slot));
  seed[7] = { ...vertex(7), position: vec3(Infinity, NaN, -Infinity) };
  tess.beginSurface(material, 0, 0); tess.appendGeometry({ vertices: seed, indices: [] }, "bsp-normal");
  for (let slot = 0; slot < seed.length; slot++) {
    tess.writeStageColor(slot, { x: (slot + 1) / 255, y: (slot + 2) / 255, z: (slot + 3) / 255, w: (slot + 4) / 255 });
    tess.writeStageTexCoord(0, slot, vec2(slot + 0.25, slot + 0.5));
    tess.writeStageTexCoord(1, slot, vec2(slot + 0.75, slot + 1));
  }
  tess.beginSurface(material, 0, 0);
  tess.appendGeometry({ vertices: Array.from({ length: 4 }, (_, slot) => vertex(slot + 20)), indices: [] }, "poly");
  const sourceIndices = [2, 0, 8, 8, 0, 9, 9, 1, 2];
  tess.replaceGeometry({ vertices: tess.snapshotGeometry().vertices, indices: sourceIndices });
  deformGeometry(tess, material.definition.deforms, { axis: tess.view.axis, mirror: false, entityAxis: null, nonNormalizedAxis: null }, 0, noise);
  const projected: Vec3[] = [];
  const [tris, normals] = snapshotSourceDebugOperations(tess, position => {
    if (![position.x, position.y, position.z].every(Number.isFinite)) throw new Error("Unused nonfinite gap was projected");
    projected.push({ ...position }); return project(position);
  }, material.whiteImage, { showTris: 1, showNormals: 1 });
  if (tris?.kind !== "debug-tris" || normals?.kind !== "debug-normals") throw new Error("Missing debug snapshots");
  expect(tris.input.positions).toEqual([vec3(21, 32, 43), vec3(22, 33, 44), vec3(23, 34, 45), vertex(8).position, vertex(9).position].map(project));
  expect(tris.input.indices).toEqual([2, 0, 3, 3, 0, 4, 4, 1, 2]);
  expect(tris.input.scratch).toEqual([0, 1, 2, 8, 9].map(slot => ({ color: tess.stageColor(slot), texCoord: tess.stageTexCoord(0, slot), texCoord2: tess.stageTexCoord(1, slot),
    rawTexCoord: tess.allocatedVertex(slot).texCoord, rawTexCoord2: tess.allocatedVertex(slot).lightmapCoord })));
  expect(normals.input.segments).toHaveLength(4);
  expect(normals.input.segments[0]).toEqual([project(vec3(21, 32, 43)), project(vec3(22, 34, 46))]);
  expect(normals.input.segments[3]).toEqual([project(vec3(24, 35, 46)), project(vec3(31, 43, 55))]);
  expect(projected).toHaveLength(13);
  expect(tess.snapshotGeometry().indices).toEqual(sourceIndices); expect(tess.numVertexes).toBe(4); expect(tess.numIndexes).toBe(9);
  tess.resetGeometry(); tess.appendGeometry({ vertices: Array.from({ length: 10 }, (_, slot) => vertex(slot + 100)), indices: [0, 1, 2] }, "bsp-normal");
  tess.writeStageColor(8, vec4(1, 1, 1, 1)); tess.writeStageTexCoord(1, 9, vec2(0, 0));
  expect(tris.input.positions[3]).toEqual(project(vertex(8).position));
  expect(tris.input.scratch[4]?.texCoord2).toEqual(vec2(9.75, 10));
  expect(tris.input.scratch[4]?.rawTexCoord).toEqual(vertex(9).texCoord);
  expect(tris.input.scratch[4]?.rawTexCoord2).toEqual(vertex(9).lightmapCoord);
  expect(normals.input.segments[3]?.[1]).toEqual(project(vec3(31, 43, 55)));
});

test("normal endpoint multiplication and the local temp use float32 before projection, while disabled debug data stays unvalidated", async () => {
  const { resources, cvars, settings } = await fixture(plain);
  const material = resources.picture(await resources.registerShaderNoMip("plain")).material, tess = new SourceTessState();
  tess.beginSurface(material, 0, 0);
  tess.appendGeometry({ vertices: [{ ...vertex(0), position: vec3(-3e38, 0, 0), normal: vec3(2e38, 0, 0) },
    { ...vertex(1), position: vec3(16777216, 0, 0), normal: vec3(0.5, 0, 0) }, vertex(2)], indices: [0, 1, 2] }, "bsp-normal");
  const snapshots = [...snapshotSourceDebugOperations(tess, position => vec4(position.x, position.y, position.z, 1), material.whiteImage,
    { showTris: 1, showNormals: 1 })];
  const normals = snapshots[1];
  if (normals?.kind !== "debug-normals") throw new Error("Missing normals snapshot");
  expect(normals.input.segments[0]?.[1].x).toBe(Infinity);
  expect(normals.input.segments[1]?.[1].x).toBe(16777216);
  cvars.set("r_showtris", "0"); cvars.set("r_shownormals", "0");
  cvars.reads.length = 0;
  const operations = evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8);
  expect(operations.some(operation => operation.kind === "debug-tris" || operation.kind === "debug-normals")).toBe(false);
  expect(cvars.reads).toContain("r_showtris"); expect(cvars.reads).toContain("r_shownormals");
  expect(tess.numIndexes).toBe(0);
});

test("debug gates are sampled at each reached pass without projecting the disabled pass", async () => {
  const { resources, settings, cvars } = await fixture(plain);
  const material = resources.picture(await resources.registerShaderNoMip("plain")).material;
  const tess = new SourceTessState();
  tess.beginSurface(material, 0, 0);
  tess.appendGeometry({ vertices: [...triangle(), { ...vertex(3), position: vec3(Infinity, 0, 0) }], indices: [0, 1, 2] }, "bsp-normal");
  const projected: Vec3[] = [];
  const finiteProject = (position: Vec3): Vec4 => {
    if (![position.x, position.y, position.z].every(Number.isFinite)) throw new Error("Reached nonfinite debug vertex");
    projected.push(position); return { ...position, w: 1 };
  };
  cvars.set("r_showtris", "0"); cvars.set("r_shownormals", "0"); cvars.reads.length = 0;
  expect([...snapshotSourceDebugOperations(tess, finiteProject, material.whiteImage, settings.runtime)]).toEqual([]);
  expect(projected).toEqual([]);
  expect(cvars.reads).toEqual(["r_showtris", "r_shownormals"]);
  cvars.set("r_showtris", "-2"); cvars.set("r_shownormals", "1"); cvars.reads.length = 0;
  const operations = snapshotSourceDebugOperations(tess, finiteProject, material.whiteImage, settings.runtime);
  expect(cvars.reads).toEqual([]);
  const tris = operations.next();
  expect(tris.done).toBe(false);
  expect(projected).toHaveLength(3);
  expect(cvars.reads).toEqual(["r_showtris"]);
  cvars.set("r_shownormals", "0"); cvars.reads.length = 0;
  expect(operations.next().done).toBe(true);
  expect(cvars.reads).toEqual(["r_shownormals"]);
  expect(projected).toHaveLength(3);
  cvars.set("r_showtris", "0"); cvars.set("r_shownormals", "1");
  expect(() => [...snapshotSourceDebugOperations(tess, finiteProject, material.whiteImage, settings.runtime)])
    .toThrow("Reached nonfinite debug vertex");
});

test("both picture entrypaths queue one tail after fog and offset cleanup without stamping frontend depth", async () => {
  const { resources, cvars, settings, builtins } = await fixture("plain { sort opaque polygonOffset cull none { map $whiteimage rgbGen identity } }");
  const material = resources.picture(await resources.registerShaderNoMip("plain")).material;
  const fog: FogVolume = { bounds: { min: vec3(-64, -64, -64), max: vec3(64, 64, 64) }, surface: null, color: vec4(0.2, 0.4, 0.6, 1), tcScale: 0.01 };
  for (const tess of [new SourceTessState(), resources.tess]) {
    tess.beginSurface(material, 1, 0); tess.appendGeometry({ vertices: triangle(), indices: [0, 1, 2] }, "bsp-normal");
    tess.setFogContext({ volume: fog, texture: builtins.fogImage, coordinates: fogCoordinates(fog, vec3(0, 0, 0), vec3(1, 0, 0)) });
    tess.setDepthRange([0, 0.3]); cvars.reads.length = 0;
    const operations = evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8);
    expect(operations.map(operation => operation.kind)).toEqual(["cull", "polygon-offset", "begin-source-arrays", "begin-generic-iterator", "source-tess-stage", "source-tess-stage", "end-source-arrays", "polygon-offset", "debug-tris", "debug-normals", "log-comment"]);
    const stages = operations.filter(operation => operation.kind === "source-tess-stage");
    expect(stages.map(operation => operation.stage.kind)).toEqual(["generic-single", "fog"]);
    expect(stages.every(operation => operation.stage.batch.state.depthRange === undefined)).toBe(true);
    expect(operations.at(-4)).toEqual({ kind: "polygon-offset", value: null });
    expect(debugTail(operations)[0].scratch[0]?.color).toEqual(tess.stageColor(0));
    expect(cvars.reads.filter(name => name === "r_showtris")).toHaveLength(1);
    expect(cvars.reads.filter(name => name === "r_shownormals")).toHaveLength(1);
    expect(tess.numIndexes).toBe(0); expect(tess.numVertexes).toBe(3);
  }
});

test("both retained evaluators read nonmodel source axis scale and shadow plane without resolving its handles", async () => {
  const { resources, settings } = await fixture("sprite { deformVertexes autosprite { map $whiteimage } } shadow { deformVertexes projectionShadow { map $whiteimage } }");
  const sprite = resources.picture(await resources.registerShaderNoMip("sprite")).material;
  const shadow = resources.picture(await resources.registerShaderNoMip("shadow")).material;
  const axis = anglesToAxis(camera.angles);
  const entity: SourceRefEntityRecord = { ...createModelEntity(), kind: "sprite", model: -31, customShader: 12345, customSkin: -29,
    radius: 0, rotation: 0, nonNormalizedAxes: true, axis: [vec3(0, 4, 0), axis[1], axis[2]], shadowPlane: 2 };
  const positions = [vec3(0, 1, 1), vec3(0, -1, 1), vec3(0, -1, -1), vec3(0, 1, -1)];
  const geometry = { vertices: positions.map((position, slot) => ({ ...vertex(slot), position })), indices: [0, 1, 3, 3, 1, 2] };
  for (const tess of [new SourceTessState(), resources.tess]) {
    tess.enterView({ origin: camera.origin, axis, mirror: false }, 0, cameraRefdef(camera, 64, 64));
    tess.setEntity({ ...tess.context, kind: "entity", entity, orientationAxis: axis, orientationOrigin: vec3(0, 0, 10),
      lighting: { ...tess.context.lighting, lightDir: vec3(0, 0, 1) } });
    tess.beginSurface(sprite, 0, 0); tess.appendGeometry(geometry, "stamp");
    evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8);
    expect(tess.allocatedVertex(0).position.y).toBeCloseTo(Math.sqrt(2) * 0.707 / 4, 6);
    expect(tess.allocatedVertex(0).position.z).toBeCloseTo(Math.sqrt(2) * 0.707 / 4, 6);
    tess.beginSurface(shadow, 0, 0); tess.appendGeometry(geometry, "stamp");
    evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8);
    expect(tess.snapshotGeometry().vertices.map(vertex => vertex.position.z)).toEqual([-8, -8, -8, -8]);
    const retained = tess.context.entity;
    if (retained === null || !("model" in retained)) throw new Error("Fixture needs complete source record");
    expect(retained.model).toBe(-31); expect(retained.customShader).toBe(12345); expect(retained.customSkin).toBe(-29);
  }
});

test("entry zero indices and internal shadows bypass sort/debug reads and retain source shadow counts", async () => {
  const { resources, cvars, settings } = await fixture(plain);
  const material = resources.picture(await resources.registerShaderNoMip("plain")).material;
  await resources.remapShader("plain", "<stencil shadow>", null);
  cvars.set("r_debugSort", "-2");
  for (const tess of [new SourceTessState(), resources.tess]) {
    cvars.reads.length = 0;
    expect(evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8)).toEqual([]);
    expect(cvars.reads).toEqual([]);
    tess.beginSurface(material, 0, 0); tess.appendGeometry({ vertices: triangle(), indices: [0, 1, 2] }, "bsp-normal");
    tess.setEntity({ ...tess.context, lighting: { ...tess.context.lighting, lightDir: vec3(0, 0, 1) } });
    tess.setDepthRange([0, 0.3]);
    const operations = evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8);
    expect(operations.map(operation => operation.kind)).toEqual(["shadow-volume"]);
    expect(operations[0]).not.toHaveProperty("depthRange");
    expect(cvars.reads).toEqual([]); expect(tess.numIndexes).toBe(3); expect(tess.numVertexes).toBe(3);
  }
});

test("both ordinary entrypaths apply the live integer sort guard to the actual remapped shader before iterator mutations", async () => {
  const { resources, cvars, settings } = await fixture("low { sort 2 { map $whiteimage } } high { sort 7 deformVertexes move 4 0 0 sin 1 0 0 0 { map $whiteimage } }");
  const low = resources.picture(await resources.registerShaderNoMip("low")).material;
  await resources.registerShaderNoMip("high"); await resources.remapShader("low", "high", null);
  for (const tess of [new SourceTessState(), resources.tess]) for (const value of ["-2", "0", "6.9", "7", "8"]) {
    cvars.set("r_debugSort", value); tess.beginSurface(low, 0, 0); tess.appendGeometry({ vertices: triangle(), indices: [0, 1, 2] }, "bsp-normal");
    expect(tess.material?.sort).toBe(7);
    const before = tess.snapshotGeometry(); cvars.reads.length = 0;
    const operations = evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8);
    const rejected = value === "-2" || value === "6.9";
    if (rejected) { expect(operations).toHaveLength(0); expect(tess.snapshotGeometry()).toEqual(before); }
    else { expect(debugTail(operations)[0].indices).toEqual([0, 1, 2]); expect(tess.allocatedVertex(0).position.x).toBe(4); expect(tess.numIndexes).toBe(0); }
    expect(cvars.reads.filter(name => name === "r_debugsort")).toHaveLength(1);
    expect(cvars.reads.filter(name => name === "r_showtris")).toHaveLength(rejected ? 0 : 1);
    expect(cvars.reads.filter(name => name === "r_shownormals")).toHaveLength(rejected ? 0 : 1);
  }
  cvars.set("r_debugSort", "6");
  for (const tess of [new SourceTessState(), resources.tess]) {
    tess.beginSurface(low, 1, 0); tess.appendGeometry({ vertices: triangle(), indices: [0, 1, 2] }, "bsp-normal");
    expect(evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8)).toEqual([]);
    expect(tess.numIndexes).toBe(3);
  }
});

test("actual fastsky world returns the original geometry through the debug tail", async () => {
  const { resources, cvars } = await fixture("sky { skyparms - 128 - cull none { map $whiteimage } }", "sky");
  const world = await resources.loadWorld("debug"); cvars.set("r_fastsky", "-2");
  const operations = world.frame({ refdef: cameraRefdef(camera, 64, 64) }).flatMap(view => view.operations);
  expect(operations.map(operation => operation.kind)).toEqual(["debug-tris", "debug-normals", "log-comment"]);
  const [tris, normals] = debugTail(operations);
  expect(tris.positions).toHaveLength(8); expect(tris.indices).toHaveLength(12); expect(normals.segments).toHaveLength(8);
  expect(resources.tess.numVertexes).toBe(8); expect(resources.tess.numIndexes).toBe(0);
  expect(tris.positions).toEqual(resources.tess.snapshotGeometry().vertices.map(vertex => resources.tess.projectPosition(vertex.position)));
});

test("actual world flush applies sort before deformation and preserves rejected index counts", async () => {
  const { resources, cvars } = await fixture("plain { sort 7 cull none deformVertexes move 4 0 0 sin 1 0 0 0 { map $whiteimage } }");
  const world = await resources.loadWorld("debug"), refdef = cameraRefdef(camera, 64, 64);
  cvars.set("r_debugSort", "6");
  expect(world.frame({ refdef }).flatMap(view => view.operations)).toHaveLength(0);
  // Source shortsort swaps the equal-sort pair after traversal visits x=64 first.
  expect(resources.tess.allocatedVertex(0).position.x).toBe(32);
  expect(resources.tess.numVertexes).toBe(8); expect(resources.tess.numIndexes).toBe(12);
  cvars.set("r_debugSort", "7");
  const operations = world.frame({ refdef }).flatMap(view => view.operations);
  expect(debugTail(operations)[0].positions).toHaveLength(8);
  expect(resources.tess.allocatedVertex(0).position.x).toBe(36); expect(resources.tess.numIndexes).toBe(0);
});

test("ordinary sky queues cloud data after offset/depth restore and includes active unindexed second-pass normals", async () => {
  const { resources } = await fixture("sky { skyparms - 128 - cull none polygonOffset { map $whiteimage } { map $whiteimage blendFunc add } }", "sky");
  const world = await resources.loadWorld("debug");
  const operations = world.frame({ refdef: cameraRefdef(camera, 64, 64) }).flatMap(view => view.operations);
  const [tris, normals] = debugTail(operations);
  expect(operations.slice(-5).map(operation => operation.kind)).toEqual(["polygon-offset", "depth-range", "debug-tris", "debug-normals", "log-comment"]);
  expect(operations.at(-5)).toEqual({ kind: "polygon-offset", value: null }); expect(operations.at(-4)).toEqual({ kind: "depth-range", range: [0, 1] });
  expect(tris.positions.length).toBeGreaterThan(8); expect(normals.segments).toHaveLength(tris.positions.length * 2);
  expect(normals.segments).toHaveLength(resources.tess.numVertexes); expect(resources.tess.numIndexes).toBe(0);
  expect(operations.filter(operation => operation.kind === "source-tess-stage").every(operation => operation.stage.batch.state.depthRange === undefined)).toBe(true);
});

test("zero-height cloud state still queues empty debug calls after the real sky iterator", async () => {
  const { resources, settings } = await fixture("sky { skyparms - 128 - cull none polygonOffset { map $whiteimage } }");
  const material = resources.picture(await resources.registerShaderNoMip("sky")).material;
  if (material.sky === null) throw new Error("Missing registered sky");
  const tess = resources.tess;
  tess.beginSurface({ ...material, sky: { ...material.sky, cloudHeight: 0 } }, 0, 0);
  tess.appendGeometry({ vertices: triangle(), indices: [0, 1, 2] }, "bsp-normal");
  const operations = evaluatePictureSurface(tess, 64, 64, 1, noise, settings.runtime, 8), [tris, normals] = debugTail(operations);
  expect(operations.slice(-5).map(operation => operation.kind)).toEqual(["polygon-offset", "depth-range", "debug-tris", "debug-normals", "log-comment"]);
  expect(operations.filter(operation => operation.kind === "source-tess-stage")).toHaveLength(1);
  expect(tris.positions).toEqual([]); expect(tris.indices).toEqual([]); expect(tris.scratch).toEqual([]); expect(normals.segments).toEqual([]);
  expect(tess.numVertexes).toBe(0); expect(tess.numIndexes).toBe(0);
});

test("empty text deformation preserves zero-index material effects before live debug calls", async () => {
  const { resources, cvars, settings, cpu, target } = await fixture("plain { sort opaque deformVertexes text0 polygonOffset cull back { map $whiteimage rgbGen identity } }");
  const picture = resources.picture(await resources.registerShaderNoMip("plain")), events: string[] = [];
  let expectedCull: "back" | "none" = "back";
  const immediate = cpu.drawImmediate.bind(cpu), prepareStage = cpu.prepareSourceGeometry.bind(cpu);
  const prepareTris = cpu.prepareDebugTris.bind(cpu), drawNormals = cpu.drawDebugNormals.bind(cpu);
  cpu.drawImmediate = operation => {
    immediate(operation);
    if (operation.kind === "cull") { expect(operation.cull).toBe(expectedCull); events.push("cull"); }
    if (operation.kind === "polygon-offset") events.push(operation.value === null ? "offset-off" : "offset-on");
    return undefined;
  };
  cpu.prepareSourceGeometry = stage => {
    expect(stage.kind).toBe("generic-single"); expect(stage.batch.vertices).toHaveLength(0); expect(stage.batch.indices).toHaveLength(0);
    const draw = prepareStage(stage);
    return {
      begin: () => { draw.begin(); events.push("stage-begin"); return undefined; },
      prepareTexture: unit => draw.prepareTexture(unit),
      applyTexture: (unit, operation) => {
        draw.applyTexture(unit, operation); expect(operation.kind).toBe("bind-image"); events.push("bind-image");
        cvars.set("r_showtris", "-2"); cvars.set("r_shownormals", "-2"); return undefined;
      },
      draw: primitives => { draw.draw(primitives); events.push("stage-draw"); return undefined; },
      finishTextures: () => draw.finishTextures(),
      cleanup: () => { draw.cleanup(); events.push("stage-cleanup"); return undefined; },
    };
  };
  cpu.prepareDebugTris = input => {
    expect(input.positions).toHaveLength(0); expect(input.indices).toHaveLength(0);
    const draw = prepareTris(input);
    return { ...draw, draw: primitives => { draw.draw(primitives); events.push("tris"); return undefined; } };
  };
  cpu.drawDebugNormals = input => { expect(input.segments).toHaveLength(0); drawNormals(input); events.push("normals"); return undefined; };
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  const before = cpu.pixels.slice();
  for (const text of ["", "   "]) {
    events.length = 0; cvars.set("r_showtris", "0"); cvars.set("r_shownormals", "0");
    resources.tess.enterView(resources.tess.view, 0, { text: [text, "", "", "", "", "", "", ""], time: 0 });
    commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 32, height: 32 }, picture);
    commands.submitFrame();
    expect(events).toEqual(["cull", "offset-on", "stage-begin", "bind-image", "stage-draw", "stage-cleanup", "offset-off", "tris", "normals"]);
    expect(resources.tess.numVertexes).toBe(0); expect(resources.tess.numIndexes).toBe(0); expect(cpu.pixels).toEqual(before);
    expectedCull = "none"; // The next 2D entry disables culling without invalidating its cached type.
  }
});

test("real world dlight and offset cleanup precede debug, whose colors come from tess svars", async () => {
  const { resources } = await fixture("plain { sort opaque polygonOffset cull none { map $whiteimage rgbGen const ( 0.2 0.2 0.2 ) } }");
  const world = await resources.loadWorld("debug");
  const operations = world.frame({ refdef: cameraRefdef(camera, 64, 64), dynamicLights: [{ origin: vec3(32, -12, 0), radius: 256, color: vec3(1, 0, 0) }] }).flatMap(view => view.operations);
  const dlight = operations.find(operation => operation.kind === "source-tess-stage" && operation.stage.kind === "dlight");
  if (dlight?.kind !== "source-tess-stage") throw new Error("Missing real projected-light pass");
  const [tris] = debugTail(operations);
  expect(operations.at(-4)).toEqual({ kind: "polygon-offset", value: null });
  expect(tris.scratch[0]?.color).toEqual(resources.tess.stageColor(0));
  expect(dlight.stage.batch.vertices[0]?.color).not.toEqual(tris.scratch[0]?.color);
});
