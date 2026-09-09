// RB_BeginSurface, ComputeColors and R_BindAnimatedImage, id Software renderer.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { BspVertex } from "../assets/bsp.ts";
import { CommonError } from "../core/common-error.ts";
import { dot3, sub3 } from "../core/math.ts";
import type { Vec2, Vec3, Vec4 } from "../core/math.ts";
import { deformGeometry } from "./deform.ts";
import type { RendererNoise } from "./deform.ts";
import { snapshotSourceDebugOperations } from "./debug-draw.ts";
import type { EntityLighting } from "./lighting.ts";
import { evaluateTexCoords, evaluateWaveform, SourceColorGenerator, SourceTexCoordGenerator, SourceWaveFunction, stageState } from "./material.ts";
import type { ShaderStage, Waveform } from "./material.ts";
import type { FinishedIteratorStage } from "./material-iterator.ts";
import type { MaterialRecord } from "./material-registry.ts";
import { diffuseColor, specularAlpha } from "./scene-models.ts";
import { OPAQUE_STATE } from "./types.ts";
import type { DrawBatch, RenderState, SourceStageCell, SourceStageData, SurfaceViewOperation, TextureBinding, ViewOperation } from "./types.ts";
import type { SourceTessState } from "./tess-state.ts";
import type { RendererRuntimeSettings } from "./settings.ts";
import { attenuateFogColor, fogPassState } from "./fog.ts";
import { SourceStateBit, sourceStateBits } from "./source-state.ts";

export interface PictureClock {
  milliseconds(): number;
}

export interface ImagePicture {
  readonly kind: "image";
  readonly name: string;
  readonly texture: TextureBinding;
  readonly state: RenderState;
  readonly color: { readonly rgb: "vertex" | "exactvertex" | "identity" | "identitylighting"; readonly alpha: "vertex" | "identity" | "identitylighting" };
}

export interface MaterialPicture {
  readonly kind: "material";
  readonly name: string;
  readonly material: MaterialRecord;
}

/** Registered shaders retain their identity; direct bitmap commands are a separate input. */
export type PictureAsset = ImagePicture | MaterialPicture;

export interface StageColorContext {
  readonly time: number;
  readonly identityLight: number;
  readonly entityRGBA: Vec4;
  readonly lighting: EntityLighting | null;
  readonly viewOrigin: Vec3;
  readonly localViewOrigin: Vec3;
  readonly noise: RendererNoise;
  readonly previousColor: Vec4;
}

const f = Math.fround;
const byte = (value: number): number => {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647)
    throw new RangeError("Shader color reaches undefined source float-to-integer conversion");
  return integer & 255;
};
const normalizedByte = (value: number): number => byte(f(f(value) * 255));
const waveByte = (value: number): number => normalizedByte(Math.max(0, Math.min(1, value)));

function sortedSourceSlots(indices: readonly number[]): number[] {
  const words = new Uint32Array(32), slots: number[] = [];
  let fallback: Set<number> | null = null, maximumWord = -1;
  for (const index of indices) {
    if (fallback !== null) {
      fallback.add(index);
      continue;
    }
    if (!Number.isInteger(index) || index < 0 || index >= 1024) {
      fallback = new Set(slots);
      fallback.add(index);
      continue;
    }
    const wordIndex = index >>> 5, bit = 1 << (index & 31), word = words[wordIndex];
    if (word === undefined) throw new Error("Source slot bitmap word is outside its allocation");
    if ((word & bit) !== 0) continue;
    words[wordIndex] = word | bit;
    slots.push(index === 0 ? 0 : index);
    if (wordIndex > maximumWord) maximumWord = wordIndex;
  }
  if (fallback !== null) return [...fallback].sort((left, right) => left - right);
  slots.length = 0;
  for (let wordIndex = 0; wordIndex <= maximumWord; wordIndex++) {
    let word = words[wordIndex];
    if (word === undefined) throw new Error("Source slot bitmap word is outside its allocation");
    while (word !== 0) {
      slots.push(wordIndex * 32 + 31 - Math.clz32(word & -word));
      word &= word - 1;
    }
  }
  return slots;
}

/** Source unsigned-byte stage storage, returned normalized for both renderer backends. */
export function evaluateStageColor(stage: ShaderStage, vertex: BspVertex, context: StageColorContext, skipAlpha = false, sourceRgb: SourceColorGenerator | null = null): Vec4 {
  const color = evaluateStageRgbColor(stage, vertex, context, sourceRgb);
  return skipAlpha ? color : evaluateStageAlpha(stage, vertex, { ...context, previousColor: color }, sourceRgb);
}

function waveformColor(wave: Waveform, time: number, identityLight: number, noise: RendererNoise, shaderName: string | null = null): Vec4 {
  const glow = wave.kind === "noise"
    ? f(wave.base + f(noise.sample(0, 0, 0, f(f(time + wave.phase) * wave.frequency)) * wave.amplitude))
    : f((shaderName === null ? evaluateWaveform(wave, time) : materialWaveform(wave, time, shaderName)) * identityLight);
  const color = waveByte(glow) / 255;
  return { x: color, y: color, z: color, w: 1 };
}

function evaluateStageRgbColor(stage: ShaderStage, vertex: BspVertex, context: StageColorContext, sourceRgb: SourceColorGenerator | null): Vec4 {
  const { identityLight, entityRGBA, time } = context;
  let red = 0, green = 0, blue = 0, alpha = normalizedByte(context.previousColor.w);
  if (sourceRgb === SourceColorGenerator.Bad) red = green = blue = alpha = normalizedByte(identityLight);
  else switch (stage.rgbGen.kind) {
    case "identity": red = green = blue = alpha = 255; break;
    case "identitylighting": red = green = blue = alpha = normalizedByte(identityLight); break;
    case "entity": red = entityRGBA.x; green = entityRGBA.y; blue = entityRGBA.z; alpha = entityRGBA.w; break;
    case "oneminusentity": red = 255 - entityRGBA.x; green = 255 - entityRGBA.y; blue = 255 - entityRGBA.z; alpha = 255 - entityRGBA.w; break;
    case "vertex":
      red = byte(f(vertex.color.x * identityLight)); green = byte(f(vertex.color.y * identityLight)); blue = byte(f(vertex.color.z * identityLight)); alpha = vertex.color.w; break;
    case "exactvertex": red = vertex.color.x; green = vertex.color.y; blue = vertex.color.z; alpha = vertex.color.w; break;
    case "oneminusvertex":
      red = byte(f((255 - vertex.color.x) * identityLight)); green = byte(f((255 - vertex.color.y) * identityLight)); blue = byte(f((255 - vertex.color.z) * identityLight)); break;
    case "const":
      red = normalizedByte(stage.rgbGen.color.x); green = normalizedByte(stage.rgbGen.color.y); blue = normalizedByte(stage.rgbGen.color.z);
      alpha = stage.alphaGen.kind === "const" ? byte(stage.alphaGen.alpha * 255) : 0; break;
    case "wave": return waveformColor(stage.rgbGen.wave, time, identityLight, context.noise);
    case "lightingdiffuse": {
      if (context.lighting === null) throw new Error("lightingDiffuse requires entity lighting");
      const color = diffuseColor(vertex.normal, context.lighting);
      red = color.x; green = color.y; blue = color.z;
      alpha = dot3(vertex.normal, context.lighting.lightDir) <= 0 ? context.lighting.ambientLightInt >>> 24 : 255;
      break;
    }
  }
  return { x: byte(red) / 255, y: byte(green) / 255, z: byte(blue) / 255, w: byte(alpha) / 255 };
}

function evaluateStageAlpha(stage: ShaderStage, vertex: BspVertex, context: StageColorContext, sourceRgb: SourceColorGenerator | null): Vec4 {
  const { identityLight, entityRGBA, time, previousColor } = context;
  let alpha = normalizedByte(previousColor.w);
  switch (stage.alphaGen.kind) {
    case "identity":
      if (sourceRgb === SourceColorGenerator.Bad || stage.rgbGen.kind !== "identity" && (stage.rgbGen.kind !== "vertex" || identityLight !== 1)) alpha = 255;
      break;
    case "entity":
      // ParseStage compares alphaGen to CGEN_IDENTITY (2), which is AGEN_ENTITY.
      if (sourceRgb !== null || stage.rgbGen.kind !== "identity" && stage.rgbGen.kind !== "lightingdiffuse") alpha = entityRGBA.w;
      break;
    case "oneminusentity": alpha = 255 - entityRGBA.w; break;
    case "vertex": alpha = vertex.color.w; break;
    case "oneminusvertex": alpha = 255 - vertex.color.w; break;
    case "const": alpha = byte(stage.alphaGen.alpha * 255); break;
    case "wave": alpha = waveByte(evaluateWaveform(stage.alphaGen.wave, time)); break;
    case "portal": {
      const delta = sub3(vertex.position, context.viewOrigin);
      alpha = waveByte(f(f(Math.sqrt(dot3(delta, delta))) / stage.alphaGen.range)); break;
    }
    case "lightingspecular": alpha = specularAlpha(vertex.position, vertex.normal, context.localViewOrigin); break;
  }
  return { ...previousColor, w: byte(alpha) / 255 };
}

/** Keep animation phase aligned with the renderer's 1024-entry waveform table. */
export function animatedPictureIndex(time: number, frequency: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("Animated picture needs registered frames");
  const value = Math.trunc(f(f(time * frequency) * 1024));
  if (!Number.isFinite(value) || value < -2147483648 || value > 2147483647)
    throw new RangeError("Animated picture index reaches undefined source float-to-int conversion");
  const index = value >> 10;
  return Math.max(0, index) % count;
}

export function finishedStageBinding(bundle: Extract<FinishedIteratorStage, { active: true }>, time: number): TextureBinding {
  const binding = bundle.binding;
  if (binding.kind === "retain-current-texture") return binding;
  if (binding.kind === "video") return { kind: "shader-cinematic", source: binding.source };
  const playback = binding.playback;
  if (playback.kind === "single") return { kind: "bind-image", image: playback.image.image };
  const index = animatedPictureIndex(time, playback.frequency, playback.frames.length);
  const image = playback.frames[index];
  if (image === undefined) throw new Error(`Registered stage image ${index} is missing`);
  return { kind: "bind-image", image: image.image };
}

function compiledTexCoords(bundle: FinishedIteratorStage, vertex: BspVertex, tess: SourceTessState, index: number, slot: 0 | 1, shaderTexCoord: Vec2): Vec2 {
  const stage = bundle.stage;
  let generator: ShaderStage["tcGen"], input = vertex.texCoord;
  switch (bundle.tcGen) {
    case SourceTexCoordGenerator.Bad: return tess.stageTexCoord(slot, index);
    case SourceTexCoordGenerator.Identity: return { x: 0, y: 0 };
    case SourceTexCoordGenerator.Texture: return vertex.texCoord;
    case SourceTexCoordGenerator.Lightmap: return vertex.lightmapCoord;
    case SourceTexCoordGenerator.EnvironmentMapped: generator = { kind: "environment" }; break;
    case SourceTexCoordGenerator.Fog:
      if (tess.fogContext === null) throw new Error("TCGEN_FOG requires the source world fog context");
      input = tess.fogContext.coordinates(vertex.position); generator = { kind: "texture" }; break;
    case SourceTexCoordGenerator.Vector:
      if (stage.tcGen.kind !== "vector") throw new Error("TCGEN_VECTOR lost its registered vectors");
      generator = stage.tcGen; break;
  }
  return evaluateTexCoords({ ...stage, tcGen: generator, tcMods: [] }, input, vertex.position, vertex.normal, tess.shaderTime,
    { lightmap: vertex.lightmapCoord, viewOrigin: tess.context.localViewOrigin, shaderTexCoord });
}

function materialWaveform(wave: Waveform, time: number, shaderName: string): number {
  if (wave.kind === "none" || wave.kind === "noise") {
    const func = wave.kind === "none" ? SourceWaveFunction.None : SourceWaveFunction.Noise;
    throw new CommonError("drop", `TableForFunc called with invalid function '${func}' in shader '${shaderName}'\n`);
  }
  return evaluateWaveform(wave, time);
}

/** ComputeTexCoords completes TCGen and each modifier before reaching the next one. */
function writeBundleTexCoords(bundle: FinishedIteratorStage, vertices: readonly BspVertex[], tess: SourceTessState, slot: 0 | 1, shaderTexCoord: Vec2, shaderName: string): boolean {
  if (bundle.tcGen === SourceTexCoordGenerator.Bad) return false;
  vertices.forEach((vertex, index) => tess.writeStageTexCoord(slot, index, compiledTexCoords(bundle, vertex, tess, index, slot, shaderTexCoord)));
  for (const modifier of bundle.stage.tcMods) {
    if (modifier.kind === "none") break;
    if (modifier.kind === "stretch") {
      // RB_CalcStretchTexCoords evaluates even when numVertexes is zero.
      const scale = f(1 / materialWaveform(modifier.wave, tess.shaderTime, shaderName)), translation = f(0.5 - f(0.5 * scale));
      vertices.forEach((_vertex, index) => {
        const uv = tess.stageTexCoord(slot, index);
        tess.writeStageTexCoord(slot, index, {
          x: f(f(f(uv.x * scale) + f(uv.y * 0)) + translation),
          y: f(f(f(uv.x * 0) + f(uv.y * scale)) + translation),
        });
      });
    } else {
      const stage: ShaderStage = { ...bundle.stage, tcGen: { kind: "texture" }, tcMods: [modifier] };
      vertices.forEach((vertex, index) => tess.writeStageTexCoord(slot, index,
        evaluateTexCoords(stage, tess.stageTexCoord(slot, index), vertex.position, vertex.normal, tess.shaderTime, { shaderTexCoord })));
    }
  }
  return true;
}

/** RB_EndSurface branches to this marker before deformation or ordinary stages. */
export function evaluateStencilShadowSurface(tess: SourceTessState, project: (position: Vec3) => Vec4, stencilBits: number): readonly Extract<ViewOperation, { readonly kind: "shadow-volume" }>[] {
  const material = tess.material;
  if (material === null || material.kind !== "stencil-shadow") throw new Error("Stencil surface requires the actual internal marker");
  if (tess.numIndexes === 0 || tess.numVertexes >= 500 || stencilBits < 4) return [];
  const volume = tess.shadowGeometry();
  if (volume.kind !== "volume") return [];
  tess.setActualCull(tess.view.mirror ? "back" : "front");
  return [{ kind: "shadow-volume", positions: volume.positions.map(project), indices: volume.indices,
    mirror: tess.view.mirror, whiteImage: material.whiteImage }];
}

/** Detached diagnostic collection of the source surface iterator. */
export function evaluatePictureSurface(tess: SourceTessState, width: number, height: number, identityLight: number, noise: RendererNoise,
  runtime: RendererRuntimeSettings, stencilBits: number): readonly ViewOperation[] {
  const operations: ViewOperation[] = [];
  for (const operation of iteratePictureSurface(tess, width, height, identityLight, noise, runtime, stencilBits)) {
    operations.push(operation.kind === "source-stage" || operation.kind === "source-tess-stage"
      ? { ...operation, stage: snapshotStageBindings(operation.stage) } : operation);
  }
  return operations;
}

/** Each source operation completes before the next stage changes retained tess cells. */
export function* iteratePictureSurface(tess: SourceTessState, width: number, height: number, identityLight: number, noise: RendererNoise,
  runtime: RendererRuntimeSettings, stencilBits: number): Generator<SurfaceViewOperation, void, unknown> {
  if (tess.numIndexes === 0) return;
  const material = tess.material;
  if (material === null) throw new Error("Picture surface has no begun material");
  const project = (position: Vec3): Vec4 => ({ x: f(position.x * 2 / width - 1), y: f(1 - position.y * 2 / height), z: f(-2 * position.z - 1), w: 1 });
  if (material.kind === "stencil-shadow") {
    yield* evaluateStencilShadowSurface(tess, position => tess.projectPosition(position), stencilBits);
    return;
  }
  const evaluator = tess.surfaceEvaluator;
  if (evaluator !== null) {
    yield* evaluator(identityLight, noise, runtime);
    return;
  }
  const debugSort = runtime.debugSort;
  if (debugSort !== 0 && debugSort < material.sort) return;
  const counters = tess.performance.backEnd;
  counters.c_shaders = (counters.c_shaders + 1) | 0;
  counters.c_vertexes = (counters.c_vertexes + tess.numVertexes) | 0;
  counters.c_indexes = (counters.c_indexes + tess.numIndexes) | 0;
  counters.c_totalIndexes = (counters.c_totalIndexes + Math.imul(tess.numIndexes, material.finished.numUnfoggedPasses)) | 0;
  const definition = material.definition, entity = tess.context.entity;
  const finished = material.finished, iterator = finished.iterator;
  const fog = tess.fog === 0 ? null : tess.fogContext;
  if (tess.fog !== 0 && fog === null) throw new Error(`${material.name}: retained world fog context is missing`);
  if (iterator.kind === "sky") throw new Error(`${material.name}: 2D sky requires the retained world sky iterator`);
  if (definition !== null && definition.deforms.length !== 0) {
    deformGeometry(tess, definition.deforms, { axis: tess.view.axis, mirror: tess.view.mirror,
      entityAxis: tess.context.orientationAxis,
      nonNormalizedAxis: entity !== null && "nonNormalizedAxes" in entity && entity.nonNormalizedAxes ? entity.axis[0] : null }, tess.shaderTime, noise,
      entity !== null && "shadowPlane" in entity ? { axis: tess.context.orientationAxis, origin: tess.context.orientationOrigin,
        shadowPlane: entity.shadowPlane, lightDir: tess.context.lighting.lightDir } : null);
  }
  yield* iterateMaterialOperations(material, tess, project, identityLight, noise, runtime);
  yield* snapshotSourceDebugOperations(tess, project, material.whiteImage, runtime);
  tess.endSurface();
  yield { kind: "log-comment", text: "----------\n" };
}

/** Generic iterator state surrounds its stages even when sky generation leaves no indices. */
export function* iterateMaterialOperations(material: MaterialRecord, tess: SourceTessState, project: (position: Vec3) => Vec4,
  identityLight: number, noise: RendererNoise, runtime: RendererRuntimeSettings, projectedLights: Iterable<DrawBatch, unknown, unknown> = [],
  polygonOffset?: NonNullable<RenderState["polygonOffset"]>): Generator<SurfaceViewOperation, void, unknown> {
  const iterator = material.finished.iterator, vertexLit = iterator.kind === "vertex-lit";
  if (runtime.logFile !== 0) {
    const name = vertexLit ? "RB_StageIteratorVertexLitTexturedUnfogged"
      : iterator.kind === "lightmapped-multitexture" ? "RB_StageIteratorLightmappedMultitexture" : "RB_StageIteratorGeneric";
    yield { kind: "log-comment", text: `--- ${name}( ${material.name} ) ---\n` };
  }
  if (!vertexLit) yield { kind: "cull", cull: tess.cullState(material.definition?.cull ?? "front") };
  const offset = material.definition?.polygonOffset === true ? polygonOffset ?? runtime.polygonOffset : null;
  if (offset !== null) yield { kind: "polygon-offset", value: offset };
  const slots = sortedSourceSlots(tess.snapshotIndices());
  const vertexCount = tess.numVertexes;
  yield { kind: "begin-source-arrays", vertexCount, slots,
    positions: slots.map(slot => project(tess.allocatedPosition(slot))) };
  if (iterator.kind === "generic" || iterator.kind === "sky") {
    const scratch = slots.map(slot => {
      const source = tess.allocatedTextureCoordinates(slot);
      return { color: tess.stageColor(slot), texCoord: tess.stageTexCoord(0, slot), texCoord2: tess.stageTexCoord(1, slot),
        rawTexCoord: source.texCoord, rawTexCoord2: source.lightmapCoord };
    });
    yield { kind: "begin-generic-iterator", setArraysOnce: !(material.finished.numUnfoggedPasses > 1 || iterator.multitextureEnv !== "none"), scratch };
  }
  for (const stage of iterateMaterialStages(material, tess, project, identityLight, noise, runtime, projectedLights)) {
    if (stage.kind === "vertex-lit") yield { kind: "cull", cull: tess.cullState(material.definition?.cull ?? "front") };
    const state = { ...stage.batch.state, cull: tess.actualCullState, ...(offset === null ? {} : { polygonOffset: offset }) };
    const stageSlots = stage.kind === "dlight" ? stage.batch.vertices.map((_vertex, index) => index) : slots;
    switch (stage.kind) {
      case "generic-pair": case "lightmapped-pair":
        yield { kind: "source-tess-stage", slots: stageSlots, vertexCount, stage: { ...stage, batch: {
          texturing: "pair", primitive: "triangles", vertices: stage.batch.vertices, indices: stage.batch.indices, state,
          get texture() { return stage.batch.texture; }, secondTexture: stage.batch.secondTexture,
        } } };
        break;
      case "generic-single": case "vertex-lit": case "dlight": case "fog":
        yield { kind: "source-tess-stage", slots: stageSlots, vertexCount, stage: { ...stage, batch: {
          texturing: "single", primitive: "triangles", vertices: stage.batch.vertices, indices: stage.batch.indices, state,
          get texture() { return stage.batch.texture; },
        } } };
        break;
    }
  }
  yield { kind: "end-source-arrays" };
  if (offset !== null) yield { kind: "polygon-offset", value: null };
}

/** Detached diagnostic collection of the finished source stages. */
export function evaluateMaterialStages(material: MaterialRecord, tess: SourceTessState, project: (position: Vec3) => Vec4,
  identityLight: number, noise: RendererNoise, runtime: RendererRuntimeSettings, projectedLights: readonly DrawBatch[] = []): readonly SourceStageData[] {
  tess.cullState(material.definition?.cull ?? "front");
  const stages: SourceStageData[] = [];
  for (const stage of iterateMaterialStages(material, tess, project, identityLight, noise, runtime, projectedLights)) stages.push(snapshotStageBindings(stage));
  return stages;
}

/** Diagnostic snapshots resolve source binding getters at the collected stage boundary. */
export function snapshotStageBindings(stage: SourceStageData): SourceStageData {
  switch (stage.kind) {
    case "generic-pair": case "lightmapped-pair":
      return { ...stage, batch: { ...stage.batch, secondTexture: { ...stage.batch.secondTexture } } };
    case "generic-single": case "vertex-lit": case "dlight": case "fog":
      return { ...stage, batch: { ...stage.batch } };
  }
}

function* iterateMaterialStages(material: MaterialRecord, tess: SourceTessState, project: (position: Vec3) => Vec4,
  identityLight: number, noise: RendererNoise, runtime: RendererRuntimeSettings, projectedLights: Iterable<DrawBatch, unknown, unknown>): Generator<SourceStageData, void, unknown> {
  const definition = material.definition, entity = tess.context.entity;
  const finished = material.finished, iterator = finished.iterator;
  const geometry = tess.snapshotGeometry(), fog = tess.fog === 0 ? null : tess.fogContext;
  const allocated = sortedSourceSlots(geometry.indices).map(slot => ({ slot, vertex: tess.allocatedTexturedPosition(slot) }));
  const publishedSlots = new Map<number, number>();
  for (const [index, source] of allocated.entries()) publishedSlots.set(source.slot, index);
  const indices = geometry.indices.map(slot => {
    const index = publishedSlots.get(slot);
    if (index === undefined) throw new Error("Indexed tess cell has no published slot");
    return index;
  });
  if (tess.fog !== 0 && fog === null) throw new Error(`${material.name}: retained world fog context is missing`);
  const cull = tess.actualCullState;
  let lastStage: SourceStageData | null = null;
  const entityRGBA = entity !== null && "shaderRGBA" in entity ? entity.shaderRGBA : { x: 0, y: 0, z: 0, w: 0 };
  const shaderTexCoord = entity !== null && "shaderTexCoord" in entity ? entity.shaderTexCoord : { x: 0, y: 0 };
  for (const pass of iterator.passes) {
    const first = pass.bundles[0], second = pass.bundles[1];
    if (!first.active) {
      if (iterator.kind === "vertex-lit" || iterator.kind === "lightmapped-multitexture") throw new Error(`${material.name}: optimized source iterator dereferences an absent stage`);
      break;
    }
    const lightmapped = iterator.kind === "lightmapped-multitexture", vertexLit = iterator.kind === "vertex-lit";
    const state: RenderState = { ...(lightmapped ? { ...OPAQUE_STATE, cull } : stageState(pass.stage, cull)),
      ...(definition?.polygonOffset ? { polygonOffset: { ...runtime.polygonOffset } } : {}) };
    if (!lightmapped) {
      const context = { time: tess.shaderTime, identityLight, entityRGBA, lighting: tess.context.lighting,
        viewOrigin: tess.view.origin, localViewOrigin: tess.context.localViewOrigin, noise };
      const rgbWave = pass.rgbGen !== SourceColorGenerator.Bad && pass.stage.rgbGen.kind === "wave"
        ? waveformColor(pass.stage.rgbGen.wave, tess.shaderTime, identityLight, noise, material.name) : null;
      geometry.vertices.forEach((vertex, index) => tess.writeStageColor(index,
        rgbWave ?? evaluateStageRgbColor(pass.stage, vertex, { ...context, previousColor: tess.stageColor(index) }, pass.rgbGen)));
      if (!vertexLit && pass.alphaGen !== "skip") {
        const alphaWave = pass.stage.alphaGen.kind === "wave" ? waveByte(materialWaveform(pass.stage.alphaGen.wave, tess.shaderTime, material.name)) / 255 : null;
        geometry.vertices.forEach((vertex, index) => {
          const previousColor = tess.stageColor(index);
          tess.writeStageColor(index, alphaWave === null
            ? evaluateStageAlpha(pass.stage, vertex, { ...context, previousColor }, pass.rgbGen) : { ...previousColor, w: alphaWave });
        });
      }
      if (fog !== null && !vertexLit && pass.fogAdjustment !== "none") {
        const coordinates = geometry.vertices.map(vertex => fog.coordinates(vertex.position));
        coordinates.forEach((uv, index) => tess.writeStageColor(index, attenuateFogColor(tess.stageColor(index), pass.fogAdjustment, uv)));
      }
    }
    if (!lightmapped && !vertexLit && writeBundleTexCoords(first, geometry.vertices, tess, 0, shaderTexCoord, material.name)
      && second !== undefined && second.active) writeBundleTexCoords(second, geometry.vertices, tess, 1, shaderTexCoord, material.name);
    const vertices = allocated.map(({ vertex, slot }) => ({ position: project(vertex.position),
      texCoord: lightmapped || vertexLit ? vertex.texCoord : tess.stageTexCoord(0, slot),
      color: lightmapped ? { x: 1, y: 1, z: 1, w: 1 } : tess.stageColor(slot) }));
    if (second === undefined) {
      if (lightmapped) throw new Error(`${material.name}: lightmapped source iterator has no second bundle`);
      const scratch = vertices.map((output, index) => {
        const source = allocated[index];
        if (source === undefined) throw new Error("Published tess vertex has no source slot");
        return { color: output.color, texCoord: vertexLit ? tess.stageTexCoord(0, source.slot) : output.texCoord,
          texCoord2: tess.stageTexCoord(1, source.slot), rawTexCoord: source.vertex.texCoord, rawTexCoord2: source.vertex.lightmapCoord };
      });
      lastStage = { kind: vertexLit ? "vertex-lit" : "generic-single", stateBits: pass.stateBits, scratch,
        batch: { texturing: "single", primitive: "triangles", vertices, indices, state,
          get texture(): TextureBinding {
            return iterator.kind === "generic" && first.vertexLightmap && runtime.vertexLighting && runtime.lightmap
              ? { kind: "bind-image", image: material.whiteImage } : finishedStageBinding(first, tess.shaderTime);
          } } };
      yield lastStage;
    } else {
      if (!second.active) throw new Error(`${material.name}: collapsed stage has an inactive second bundle`);
      const scratch: SourceStageCell[] = [];
      const paired = vertices.map((output, index) => {
        const source = allocated[index];
        if (source === undefined) throw new Error("Published tess vertex has no source slot");
        const texCoord2 = lightmapped ? source.vertex.lightmapCoord : tess.stageTexCoord(1, source.slot);
        scratch.push({ color: lightmapped ? tess.stageColor(source.slot) : output.color,
          texCoord: lightmapped ? tess.stageTexCoord(0, source.slot) : output.texCoord,
          texCoord2: lightmapped ? tess.stageTexCoord(1, source.slot) : texCoord2,
          rawTexCoord: source.vertex.texCoord, rawTexCoord2: source.vertex.lightmapCoord });
        return { ...output, texCoord2 };
      });
      lastStage = { kind: lightmapped ? "lightmapped-pair" : "generic-pair", stateBits: lightmapped ? SourceStateBit.DEFAULT : pass.stateBits, scratch,
        batch: { texturing: "pair", primitive: "triangles", vertices: paired, indices, state,
          get texture() { return finishedStageBinding(first, tess.shaderTime); },
          secondTexture: {
            get binding() { return finishedStageBinding(second, tess.shaderTime); },
            get environment() {
              const environment = runtime.lightmap ? "replace" : lightmapped ? "modulate" : iterator.multitextureEnv;
              if (environment === "none") throw new Error(`${material.name}: collapsed stage has no texture environment`);
              return environment;
            },
          } } };
      yield lastStage;
    }
    if (runtime.lightmap && (first.isLightmap || second?.isLightmap || first.vertexLightmap)) break;
  }
  {
    // Dlight arrays retain active geometry indices; material publication may have compacted source slots.
    let scratch = lastStage !== null && allocated.length === geometry.vertices.length
      && allocated.every((source, index) => source.slot === index) ? lastStage.scratch : null;
    for (const batch of projectedLights) {
      if (batch.primitive !== "triangles" || batch.texturing !== "single") throw new Error("Projected dlight requires a single-texture triangle batch");
      const blend = batch.state.blend;
      if ((blend.source !== "one" && blend.source !== "dst-color") || blend.destination !== "one" || batch.state.depthTest !== "equal") {
        throw new Error("Projected dlight requires its source blend factors and equal depth function");
      }
      const stateBits = sourceStateBits({ depthTest: batch.state.depthTest, depthWrite: batch.state.depthWrite,
        alphaTest: batch.state.alphaTest, blend: { source: blend.source, destination: blend.destination } });
      if (scratch === null || scratch.length !== batch.vertices.length) {
        scratch = batch.vertices.map((_vertex, index) => {
          const source = tess.allocatedTextureCoordinates(index);
          return { color: tess.stageColor(index), texCoord: tess.stageTexCoord(0, index), texCoord2: tess.stageTexCoord(1, index),
            rawTexCoord: source.texCoord, rawTexCoord2: source.lightmapCoord };
        });
      }
      yield { kind: "dlight", stateBits, batch, scratch };
    }
  }
  const fogPass = finished.fogPass;
  if (fog !== null && fogPass !== "none") {
    geometry.vertices.forEach((_vertex, index) => tess.writeStageColor(index, fog.volume.color));
    geometry.vertices.forEach((vertex, index) => tess.writeStageTexCoord(0, index, fog.coordinates(vertex.position)));
    const vertices = allocated.map(({ vertex, slot }) => ({ position: project(vertex.position), texCoord: tess.stageTexCoord(0, slot), color: tess.stageColor(slot) }));
    const scratch = vertices.map((output, index) => {
      const source = allocated[index];
      if (source === undefined) throw new Error("Published tess vertex has no source slot");
      return { color: output.color, texCoord: output.texCoord, texCoord2: tess.stageTexCoord(1, source.slot),
        rawTexCoord: source.vertex.texCoord, rawTexCoord2: source.vertex.lightmapCoord };
    });
    const stateBits = sourceStateBits({ depthTest: fogPass, depthWrite: false, alphaTest: "none",
      blend: { source: "src-alpha", destination: "one-minus-src-alpha" } });
    yield { kind: "fog", stateBits, scratch, batch: { texturing: "single", primitive: "triangles", vertices, indices,
      texture: { kind: "bind-image", image: fog.texture }, state: fogPassState(fogPass, cull) } };
  }
}
