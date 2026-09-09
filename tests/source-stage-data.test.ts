// Source expectations: id Software renderer/tr_shade.c stage arrays and draw order.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import type { Vec3 } from "../src/core/math.ts";
import { vec2, vec3, vec4 } from "../src/core/math.ts";
import { RendererNoise } from "../src/render/deform.ts";
import { projectDlightTexture } from "../src/render/dlight.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { finishShader } from "../src/render/material-finish.ts";
import type { FinishLoadedImageMetadata } from "../src/render/material-finish.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { iterateMaterialOperations, evaluateMaterialStages } from "../src/render/picture-material.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { SurfaceViewOperation } from "../src/render/types.ts";
import { publishTexture } from "./render-target-fixture.ts";

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`Missing fixture element ${index}`);
  return value;
}
function vertex(slot: number): BspVertex {
  return { position: vec3(slot / 8, slot / 16, 0), normal: vec3(0, 0, 1),
    texCoord: vec2((slot + 1) / 8, (slot + 2) / 16), lightmapCoord: vec2((slot + 2) / 16, (slot + 3) / 32),
    color: vec4(32 + slot, 64 + slot, 128 + slot, 192 + slot) };
}
const project = (position: Vec3) => vec4(position.x, position.y, position.z, 1);
const seedColor = (slot: number) => ({ x: (17 + slot) / 255, y: (33 + slot) / 255, z: (65 + slot) / 255, w: (129 + slot) / 255 });
const seedUV0 = (slot: number) => vec2(4 + slot / 8, 8 + slot / 16);
const seedUV1 = (slot: number) => vec2(12 + slot / 8, 16 + slot / 16);

async function fixture(script: string, indices: readonly number[] = [3, 1, 2]) {
  const definition = at(parseShaderScript(`fixture { ${script} }`), 0);
  const cvars = new CvarRegistry();
  cvars.set("r_ignoreFastPath", "0", true);
  cvars.set("r_ext_texture_env_add", "1", true);
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const image = publishTexture(new RendererImageCatalog(), { name: "stage-white", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const loaded: FinishLoadedImageMetadata = { kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image } } } };
  const materials = new MaterialRegistry(async () => ({ definition, image, whiteImage: image,
    finished: finishShader({ definition, lightmapIndex: -1, images: definition.stages.map(() => loaded), profile: settings.registrationProfile() }),
    defaulted: false, sky: null }), text => { throw new Error(text); });
  const material = await materials.register("fixture", { kind: "none" });
  const tess = new SourceTessState();
  tess.beginSurface(material, 0, 0.25);
  tess.appendGeometry({ vertices: [vertex(0), vertex(1), vertex(2), vertex(3)], indices }, "bsp-normal");
  for (let slot = 0; slot < tess.numVertexes; slot++) {
    tess.writeStageColor(slot, seedColor(slot));
    tess.writeStageTexCoord(0, slot, seedUV0(slot));
    tess.writeStageTexCoord(1, slot, seedUV1(slot));
  }
  return { material, tess, settings, image };
}
function overwriteScratch(tess: SourceTessState): void {
  for (let slot = 0; slot < tess.numVertexes; slot++) {
    tess.writeStageColor(slot, vec4(1, 1, 1, 1));
    tess.writeStageTexCoord(0, slot, vec2(-1, -2));
    tess.writeStageTexCoord(1, slot, vec2(-3, -4));
  }
}

test("constant alpha converts its double atof product while RGB first stores float32 vector components", async () => {
  const f = await fixture("{ map $whiteimage rgbGen const ( 0.99999999 1 1 ) alphaGen const 0.99999999 }");
  evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime);
  expect(f.tess.stageColor(0)).toEqual({ x: 1, y: 1, z: 1, w: 254 / 255 });
});

test("generic single stages detach their own post-write scratch in compact vertex order", async () => {
  const f = await fixture(`
    { map $whiteimage rgbGen const ( 0.2 0.4 0.6 ) alphaGen const 0.8 tcMod scale 2 3 }
    { map $whiteimage rgbGen const ( 0.6 0.4 0.2 ) alphaGen const 0.4 tcMod scale 4 5 }
  `);
  const stages = evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime);
  expect(stages.map(stage => stage.kind)).toEqual(["generic-single", "generic-single"]);
  const first = at(stages, 0), second = at(stages, 1);
  expect(first.batch.indices).toEqual([2, 0, 1]);
  expect(first.batch.vertices.map(output => output.position)).toEqual([1, 2, 3].map(slot => project(vertex(slot).position)));
  expect(first.scratch).toHaveLength(3);
  expect(first.scratch.map(cell => cell.color)).toEqual([1, 2, 3].map(() => ({ x: 51 / 255, y: 102 / 255, z: 153 / 255, w: 204 / 255 })));
  expect(second.scratch.map(cell => cell.color)).toEqual([1, 2, 3].map(() => ({ x: 153 / 255, y: 102 / 255, z: 51 / 255, w: 102 / 255 })));
  expect(first.scratch.map(cell => cell.texCoord)).toEqual([1, 2, 3].map(slot => vec2(vertex(slot).texCoord.x * 2, vertex(slot).texCoord.y * 3)));
  expect(second.scratch.map(cell => cell.texCoord)).toEqual([1, 2, 3].map(slot => vec2(vertex(slot).texCoord.x * 4, vertex(slot).texCoord.y * 5)));
  expect(first.scratch.map(cell => cell.texCoord2)).toEqual([1, 2, 3].map(seedUV1));
  expect(first.scratch.map(cell => cell.rawTexCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(first.scratch.map(cell => cell.rawTexCoord2)).toEqual([1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(at(first.scratch, 0).color).toBe(at(first.batch.vertices, 0).color);
  expect(at(first.scratch, 0).texCoord).toBe(at(first.batch.vertices, 0).texCoord);
  expect(first.scratch).not.toBe(second.scratch);
  const saved = structuredClone(stages);
  overwriteScratch(f.tess);
  expect(stages).toEqual(saved);
});

test("generic pairs capture both generated arrays after the second bundle writes", async () => {
  const f = await fixture(`
    { map $whiteimage rgbGen vertex alphaGen vertex tcMod scale 2 3 }
    { map $whiteimage blendFunc filter rgbGen vertex alphaGen vertex tcGen lightmap tcMod scale 4 5 }
    { map $whiteimage rgbGen identity tcMod scale 6 7 }
  `);
  const stages = evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime);
  expect(stages.map(stage => stage.kind)).toEqual(["generic-pair", "generic-single"]);
  const stage = at(stages, 0), single = at(stages, 1);
  if (stage.kind !== "generic-pair") throw new Error("Expected actual generic collapse");
  expect(stage.batch.indices).toEqual([2, 0, 1]);
  expect(stage.scratch.map(cell => cell.texCoord2)).toEqual([1, 2, 3].map(slot => vec2(vertex(slot).lightmapCoord.x * 4, vertex(slot).lightmapCoord.y * 5)));
  expect(stage.scratch.map(cell => cell.rawTexCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(stage.scratch.map(cell => cell.rawTexCoord2)).toEqual([1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(single.scratch.map(cell => cell.texCoord2)).toEqual(stage.scratch.map(cell => cell.texCoord2));
  expect(single.scratch.map(cell => cell.texCoord)).not.toEqual(stage.scratch.map(cell => cell.texCoord));
  for (const [index, cell] of stage.scratch.entries()) {
    const output = at(stage.batch.vertices, index);
    expect(cell.color).toBe(output.color);
    expect(cell.texCoord).toBe(output.texCoord);
    expect(cell.texCoord2).toBe(output.texCoord2);
  }
  const saved = structuredClone(stage.scratch);
  overwriteScratch(f.tess);
  expect(stage.scratch).toEqual(saved);
});

test("vertex-lit stage payload preserves scratch UVs that differ from its bound raw array", async () => {
  const f = await fixture("{ map $whiteimage rgbGen lightingDiffuse tcMod scale 7 9 }");
  const stage = at(evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime), 0);
  expect(stage.kind).toBe("vertex-lit");
  expect(stage.scratch.map(cell => cell.rawTexCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(stage.scratch.map(cell => cell.rawTexCoord2)).toEqual([1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(stage.batch.vertices.map(output => output.texCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(stage.scratch.map(cell => cell.texCoord)).toEqual([1, 2, 3].map(seedUV0));
  expect(stage.scratch.map(cell => cell.texCoord2)).toEqual([1, 2, 3].map(seedUV1));
  expect(stage.scratch.map(cell => cell.color)).toEqual([1, 2, 3].map(() => ({ x: 0, y: 0, z: 0, w: 0 })));
  expect(at(stage.scratch, 0).color).toBe(at(stage.batch.vertices, 0).color);
  const saved = structuredClone(stage.scratch);
  overwriteScratch(f.tess);
  expect(stage.scratch).toEqual(saved);
});

test("lightmapped fast path retains all scratch cells instead of substituting white and raw UVs", async () => {
  const f = await fixture(`
    { map $lightmap rgbGen identity tcMod scroll 2 3 }
    { map $whiteimage blendFunc filter tcMod scale 7 9 }
  `);
  const stage = at(evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime), 0);
  if (stage.kind !== "lightmapped-pair") throw new Error("Expected actual lightmapped fast iterator");
  expect(stage.scratch.map(cell => cell.rawTexCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(stage.scratch.map(cell => cell.rawTexCoord2)).toEqual([1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(stage.batch.vertices.map(output => output.color)).toEqual([1, 2, 3].map(() => ({ x: 1, y: 1, z: 1, w: 1 })));
  expect(stage.batch.vertices.map(output => output.texCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(stage.batch.vertices.map(output => output.texCoord2)).toEqual([1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(stage.scratch.map(cell => cell.color)).toEqual([1, 2, 3].map(seedColor));
  expect(stage.scratch.map(cell => cell.texCoord)).toEqual([1, 2, 3].map(seedUV0));
  expect(stage.scratch.map(cell => cell.texCoord2)).toEqual([1, 2, 3].map(seedUV1));
  const saved = structuredClone(stage.scratch);
  overwriteScratch(f.tess);
  expect(stage.scratch).toEqual(saved);
});

test("dlight payload uses active original slots after ordinary stages and before fog overwrites", async () => {
  const f = await fixture(`
    { map $whiteimage rgbGen const ( 0.2 0.4 0.6 ) alphaGen const 0.8 tcMod scale 2 3 }
    { map $whiteimage rgbGen const ( 0.6 0.4 0.2 ) alphaGen const 0.4 tcMod scale 4 5 }
  `);
  const geometry = f.tess.snapshotGeometry();
  f.tess.beginSurface(f.material, 1, 0.25);
  f.tess.appendGeometry(geometry, "bsp-normal");
  const fogColor = { x: 13 / 255, y: 31 / 255, z: 67 / 255, w: 1 };
  const fogCoordinates = (position: Vec3) => vec2(position.x + 0.5, position.y + 0.75);
  f.tess.setFogContext({ volume: { bounds: { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) }, surface: null, color: fogColor, tcScale: 1 },
    texture: f.image, coordinates: fogCoordinates });
  const light = { origin: vec3(0, 0, 1), radius: 8, color: vec3(1, 0.5, 0.25) };
  const lights = projectDlightTexture(geometry, 3, [light, { ...light, additive: true }], f.image, project, "front");
  expect(lights).toHaveLength(2);
  const stages = evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime, lights);
  expect(stages.map(stage => stage.kind)).toEqual(["generic-single", "generic-single", "dlight", "dlight", "fog"]);
  const ordinary = at(stages, 1), dlight = at(stages, 2), secondDlight = at(stages, 3), fog = at(stages, 4);
  expect(ordinary.batch.indices).toEqual([2, 0, 1]);
  expect(dlight.batch.indices).toEqual([3, 1, 2]);
  expect(dlight.scratch).toHaveLength(4);
  expect(dlight.scratch.map(cell => cell.rawTexCoord)).toEqual([0, 1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(dlight.scratch.map(cell => cell.rawTexCoord2)).toEqual([0, 1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(dlight.scratch).not.toBe(ordinary.scratch);
  expect(secondDlight.scratch).toBe(dlight.scratch);
  expect(dlight.scratch.map(cell => cell.color)).toEqual([0, 1, 2, 3].map(() => ({ x: 153 / 255, y: 102 / 255, z: 51 / 255, w: 102 / 255 })));
  expect(dlight.scratch.map(cell => cell.texCoord)).toEqual([0, 1, 2, 3].map(slot => vec2(vertex(slot).texCoord.x * 4, vertex(slot).texCoord.y * 5)));
  expect(dlight.scratch.map(cell => cell.texCoord2)).toEqual([0, 1, 2, 3].map(seedUV1));
  expect(at(dlight.scratch, 0).color).not.toEqual(at(dlight.batch.vertices, 0).color);
  expect(at(dlight.scratch, 0).texCoord).not.toEqual(at(dlight.batch.vertices, 0).texCoord);
  expect(fog.scratch.map(cell => cell.color)).toEqual([1, 2, 3].map(() => fogColor));
  expect(fog.scratch.map(cell => cell.texCoord)).toEqual([1, 2, 3].map(slot => fogCoordinates(vertex(slot).position)));
  expect(fog.scratch.map(cell => cell.texCoord2)).toEqual([1, 2, 3].map(seedUV1));
  expect(fog.scratch.map(cell => cell.rawTexCoord)).toEqual([1, 2, 3].map(slot => vertex(slot).texCoord));
  expect(fog.scratch.map(cell => cell.rawTexCoord2)).toEqual([1, 2, 3].map(slot => vertex(slot).lightmapCoord));
  expect(at(fog.scratch, 0).color).toBe(at(fog.batch.vertices, 0).color);
  expect(at(fog.scratch, 0).texCoord).toBe(at(fog.batch.vertices, 0).texCoord);
  expect(f.tess.stageColor(0)).toEqual(fogColor);
  const saved = structuredClone(stages.map(stage => stage.scratch));
  overwriteScratch(f.tess);
  expect(stages.map(stage => stage.scratch)).toEqual(saved);
});

test("consecutive dlights reuse unchanged preceding scratch only when index alignment is identical", async () => {
  const f = await fixture("{ map $whiteimage rgbGen vertex alphaGen vertex }", [0, 1, 2, 0, 2, 3]);
  const light = { origin: vec3(0, 0, 1), radius: 8, color: vec3(1, 0.5, 0.25) };
  const lights = projectDlightTexture(f.tess.snapshotGeometry(), 3, [light, { ...light, additive: true }], f.image, project, "front");
  const stages = evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime, lights);
  expect(stages.map(stage => stage.kind)).toEqual(["generic-single", "dlight", "dlight"]);
  expect(at(stages, 1).scratch).toBe(at(stages, 0).scratch);
  expect(at(stages, 2).scratch).toBe(at(stages, 0).scratch);
  expect(at(stages, 1).scratch.map(cell => cell.texCoord2)).toEqual([0, 1, 2, 3].map(seedUV1));
});

test("zero-index stages still publish source state and perform active scratch writes", async () => {
  const f = await fixture("polygonOffset { map $whiteimage rgbGen identity tcMod scale 2 3 }", []);
  f.tess.setDepthRange([0.25, 0.75]);
  const operations = Array.from(iterateMaterialOperations(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime));
  expect(operations.map(operation => operation.kind)).toEqual(["cull", "polygon-offset", "begin-source-arrays", "begin-generic-iterator", "source-tess-stage", "end-source-arrays", "polygon-offset"]);
  const operation = at(operations, 4);
  if (operation.kind !== "source-tess-stage") throw new Error("Expected source stage operation");
  expect(operation.vertexCount).toBe(4); expect(operation.slots).toEqual([]);
  expect(operation.stage.kind).toBe("generic-single");
  expect(operation.stage.scratch).toEqual([]);
  expect(operation.stage.batch.vertices).toEqual([]);
  expect(operation.stage.batch.indices).toEqual([]);
  // Source stages consume the backend's physical range; the iterator does not reset it.
  expect(operation.stage.batch.state.depthRange).toBeUndefined();
  expect(operation.stage.batch.state.polygonOffset).toEqual(f.settings.runtime.polygonOffset);
  expect(f.tess.stageColor(3)).toEqual({ x: 1, y: 1, z: 1, w: 1 });
  expect(f.tess.stageTexCoord(0, 3)).toEqual(vec2(vertex(3).texCoord.x * 2, vertex(3).texCoord.y * 3));
  expect(f.tess.stageTexCoord(1, 3)).toEqual(seedUV1(3));
});

test("ComputeColors publishes every active RGB before a wave-alpha failure, including the zero-vertex call", async () => {
  for (const count of [0, 4]) {
    const f = await fixture("{ map $whiteimage blendFunc blend rgbGen const ( 1 0 0 ) alphaGen wave noise 1 0 0 1 }");
    const geometry = f.tess.snapshotGeometry();
    f.tess.beginSurface(f.material, 1, 0.25);
    if (count !== 0) f.tess.appendGeometry(geometry, "bsp-normal");
    f.tess.writeStageColor(8, seedColor(8));
    let fogCalls = 0;
    f.tess.setFogContext({ volume: { bounds: { min: vec3(-1, -1, -1), max: vec3(1, 1, 1) }, surface: null,
      color: vec4(1, 1, 1, 1), tcScale: 1 }, texture: f.image,
      coordinates: () => { fogCalls++; throw new Error("Fog must follow alpha"); } });
    const operations: SurfaceViewOperation[] = [];
    let failure: unknown;
    try {
      for (const operation of iterateMaterialOperations(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime)) operations.push(operation);
    } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(CommonError);
    if (!(failure instanceof CommonError)) throw new Error("Expected source TableForFunc error");
    expect(failure.code).toBe("drop");
    expect(failure.message).toBe("TableForFunc called with invalid function '6' in shader 'fixture'\n");
    expect(operations.map(operation => operation.kind)).toEqual(["cull", "begin-source-arrays", "begin-generic-iterator"]);
    const begin = at(operations, 2);
    if (begin.kind !== "begin-generic-iterator") throw new Error("Expected generic iterator prefix");
    expect(begin.setArraysOnce).toBe(true);
    expect(begin.scratch.map(cell => cell.color)).toEqual(count === 0 ? [] : [1, 2, 3].map(seedColor));
    expect(begin.scratch.map(cell => cell.rawTexCoord)).toEqual(count === 0 ? [] : [1, 2, 3].map(slot => vertex(slot).texCoord));
    for (let slot = 0; slot < count; slot++) {
      expect(f.tess.stageColor(slot)).toEqual(vec4(1, 0, 0, 0));
      expect(f.tess.stageTexCoord(0, slot)).toEqual(seedUV0(slot));
    }
    expect(f.tess.stageColor(8)).toEqual(seedColor(8));
    expect(fogCalls).toBe(0);
  }
});

test("ComputeTexCoords publishes complete TCGen and earlier modifiers before stretch-wave failure", async () => {
  for (const scaled of [false, true]) for (const count of [0, 4]) {
    const f = await fixture(`{ map $whiteimage rgbGen identity tcGen texture
      ${scaled ? "tcMod scale 2 3" : ""}
      tcMod stretch noise 1 0 0 1
    }`);
    if (count === 0) f.tess.resetGeometry();
    f.tess.writeStageTexCoord(0, 8, seedUV0(8));
    expect(() => evaluateMaterialStages(f.material, f.tess, project, 1, new RendererNoise(), f.settings.runtime))
      .toThrow("TableForFunc called with invalid function '6' in shader 'fixture'\n");
    for (let slot = 0; slot < count; slot++) {
      const uv = vertex(slot).texCoord;
      expect(f.tess.stageTexCoord(0, slot)).toEqual(scaled ? vec2(uv.x * 2, uv.y * 3) : uv);
      expect(f.tess.stageTexCoord(1, slot)).toEqual(seedUV1(slot));
      expect(f.tess.stageColor(slot)).toEqual(vec4(1, 1, 1, 1));
    }
    expect(f.tess.stageTexCoord(0, 8)).toEqual(seedUV0(8));
  }
});
