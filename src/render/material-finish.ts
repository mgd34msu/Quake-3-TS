// FinishShader/VertexLightingCollapse, id Software renderer/tr_shader.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import {
  SourceAlphaGenerator,
  SourceColorGenerator,
  SourceTexCoordGenerator,
  SourceWaveFunction,
} from "./material.ts";
import type {
  AlphaGenerator,
  ColorGenerator,
  FinishedStageBinding,
  ParsedShaderStage,
  RegisteredShaderStage,
  ShaderDefinition,
  ShaderMap,
  ShaderStage,
  SourceWaveStorage,
} from "./material.ts";
import { sourceMaterialIterator } from "./material-iterator.ts";
import type {
  FinishedIteratorStage,
  MaterialIterator,
  MaterialIteratorProfile,
} from "./material-iterator.ts";
import type { FogAdjustment } from "./fog.ts";
import { SourceStateBit, sourceStateBits } from "./source-state.ts";
import type { SourceStateInput } from "./source-state.ts";

export type FinishImageMetadata = RegisteredShaderStage;
export type FinishLoadedImageMetadata = Extract<RegisteredShaderStage, { readonly kind: "loaded" }>;

export interface FinishShaderProfile {
  readonly detailTextures: boolean;
  readonly vertexLight: boolean;
  readonly uiFullscreen: boolean;
  readonly hardware: "generic" | "permedia2";
  readonly iterator: MaterialIteratorProfile;
}

export type FogColorAdjustment = FogAdjustment;

interface FinishedStageFields {
  readonly fogAdjustment: FogColorAdjustment;
  readonly rgbGen: SourceColorGenerator;
}

export type FinishedShaderStage = FinishedIteratorStage & FinishedStageFields;

export interface FinishShaderDiagnostic {
  readonly kind: "missing-image" | "lightmap-cleared";
  readonly stage: number | null;
  readonly message: string;
}

export interface FinishedShader {
  readonly sort: number;
  readonly lightmapIndex: number;
  readonly hasLightmapStage: boolean;
  /** FinishShader stages immediately before CollapseMultitexture. */
  readonly sourceStages: readonly FinishedShaderStage[];
  /** Pass count after the optional single CollapseMultitexture call. */
  readonly numUnfoggedPasses: number;
  readonly iterator: MaterialIterator;
  readonly fogPass: "none" | "equal" | "less-equal";
  readonly diagnostics: readonly FinishShaderDiagnostic[];
}

export interface FinishShaderInput {
  readonly definition: ShaderDefinition;
  readonly lightmapIndex: number;
  /** One entry for every parsed stage, after image or cinematic registration. */
  readonly images: readonly FinishImageMetadata[];
  readonly profile: FinishShaderProfile;
}

export interface FinishFailedShaderInput {
  readonly name: string;
  readonly lightmapIndex: number;
  readonly profile: FinishShaderProfile;
}

interface FinishImplicitShaderFields {
  readonly name: string;
  readonly baseImage: FinishLoadedImageMetadata;
  readonly profile: FinishShaderProfile;
}

export type FinishImplicitShaderInput = FinishImplicitShaderFields & (
  | { readonly kind: "default" | "stencil-shadow" | "dynamic" | "vertex" | "picture" }
  | { readonly kind: "white"; readonly whiteImage: FinishLoadedImageMetadata }
  | { readonly kind: "lightmap"; readonly lightmapIndex: number; readonly lightmapImage: FinishLoadedImageMetadata }
);

type FinishedAlphaGenerator = FinishedIteratorStage["alphaGen"];

interface WorkingStage {
  stage: ShaderStage;
  stateBits: number;
  active: boolean;
  imageTMU: 0 | 1 | null;
  binding: FinishedStageBinding | null;
  alphaGen: FinishedAlphaGenerator;
  rgbGen: SourceColorGenerator;
  rgbWave: SourceWaveStorage;
  alphaWave: SourceWaveStorage;
  isLightmap: boolean;
  vertexLightmap: boolean;
  tcGen: SourceTexCoordGenerator;
  fogAdjustment: FogColorAdjustment;
}

function copyWave(wave: SourceWaveStorage): SourceWaveStorage {
  return { func: wave.func, base: wave.base, amplitude: wave.amplitude, phase: wave.phase, frequency: wave.frequency };
}

function copyStage(stage: ShaderStage): ShaderStage {
  return {
    map: stage.map,
    blend: { source: stage.blend.source, destination: stage.blend.destination },
    depthFunc: stage.depthFunc,
    depthWrite: stage.depthWrite,
    alphaFunc: stage.alphaFunc,
    detail: stage.detail,
    rgbGen: stage.rgbGen,
    alphaGen: stage.alphaGen,
    tcGen: stage.tcGen,
    tcMods: [...stage.tcMods],
  };
}

function alphaKind(source: SourceAlphaGenerator, semantic: AlphaGenerator): FinishedAlphaGenerator {
  switch (source) {
    case SourceAlphaGenerator.Identity: return "identity";
    case SourceAlphaGenerator.Skip: return "skip";
    case SourceAlphaGenerator.Entity: return "entity";
    case SourceAlphaGenerator.OneMinusEntity: return "oneminusentity";
    case SourceAlphaGenerator.Vertex: return "vertex";
    case SourceAlphaGenerator.OneMinusVertex: return "oneminusvertex";
    case SourceAlphaGenerator.LightingSpecular: return "lightingspecular";
    case SourceAlphaGenerator.Waveform: return semantic.kind === "wave" ? semantic.kind : "wave";
    case SourceAlphaGenerator.Portal: return semantic.kind === "portal" ? semantic.kind : "portal";
    case SourceAlphaGenerator.Const: return semantic.kind === "const" ? semantic.kind : "const";
  }
}

function workingStage(stage: ParsedShaderStage, image: FinishImageMetadata, portalRange: number): WorkingStage {
  const semantic = copyStage(stage);
  let finishedSemantic = semantic;
  if (semantic.alphaGen.kind === "portal") {
    const alphaGen: AlphaGenerator = { kind: "portal", range: portalRange };
    finishedSemantic = { ...semantic, alphaGen };
  }
  return {
    stage: finishedSemantic,
    stateBits: stage.sourceState.stateBits,
    active: stage.sourceState.active && image.kind === "loaded",
    imageTMU: image.kind === "loaded" ? image.tmu : null,
    binding: image.kind === "loaded" ? image.binding : null,
    alphaGen: alphaKind(stage.sourceState.alphaGen, stage.alphaGen),
    rgbGen: stage.sourceState.rgbGen,
    rgbWave: copyWave(stage.sourceState.rgbWave),
    alphaWave: copyWave(stage.sourceState.alphaWave),
    isLightmap: stage.sourceState.isLightmap,
    vertexLightmap: stage.sourceState.vertexLightmap,
    tcGen: stage.sourceState.tcGen,
    fogAdjustment: "none",
  };
}

const blendMask = SourceStateBit.SRCBLEND_BITS | SourceStateBit.DSTBLEND_BITS;

function isBlended(stage: WorkingStage): boolean {
  return (stage.stateBits & blendMask) !== 0;
}

function fogAdjustment(stage: WorkingStage): FogColorAdjustment {
  const blend = stage.stateBits & blendMask;
  if (blend === (SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE)
    || blend === (SourceStateBit.SRCBLEND_ZERO | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_COLOR)) return "rgb";
  if (blend === (SourceStateBit.SRCBLEND_SRC_ALPHA | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA)) return "alpha";
  if (blend === (SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA)) return "rgba";
  return "none";
}

function withBundle(target: ShaderStage, source: ShaderStage): ShaderStage {
  return { ...target, map: source.map, tcGen: source.tcGen, tcMods: [...source.tcMods] };
}

function copyWorking(source: WorkingStage): WorkingStage {
  return {
    stage: copyStage(source.stage),
    stateBits: source.stateBits,
    active: source.active,
    imageTMU: source.imageTMU,
    binding: source.binding,
    alphaGen: source.alphaGen,
    rgbGen: source.rgbGen,
    rgbWave: copyWave(source.rgbWave),
    alphaWave: copyWave(source.alphaWave),
    isLightmap: source.isLightmap,
    vertexLightmap: source.vertexLightmap,
    tcGen: source.tcGen,
    fogAdjustment: source.fogAdjustment,
  };
}

function vertexLightingCollapse(stages: (WorkingStage | null)[], sort: number, lightmapIndex: number): void {
  const first = stages[0];
  if (first === undefined || first === null) return;
  if (sort === 3) {
    let best = first;
    let bestRank = -999999;
    for (let index = 0; index < 8; index++) {
      const candidate = stages[index];
      if (candidate === undefined || candidate === null || !candidate.active) break;
      let rank = 0;
      if (candidate.isLightmap) rank -= 100;
      if (candidate.tcGen !== SourceTexCoordGenerator.Texture) rank -= 5;
      if (candidate.stage.tcMods.length !== 0) rank -= 5;
      if (candidate.rgbGen !== SourceColorGenerator.Identity && candidate.rgbGen !== SourceColorGenerator.IdentityLighting) rank -= 3;
      if (rank > bestRank) { bestRank = rank; best = candidate; }
    }
    first.stage = withBundle(first.stage, best.stage);
    first.imageTMU = best.imageTMU;
    first.binding = best.binding;
    first.isLightmap = best.isLightmap;
    first.vertexLightmap = best.vertexLightmap;
    first.tcGen = best.tcGen;
    first.stage = {
      ...first.stage,
      blend: { source: "one", destination: "zero" },
      depthWrite: true,
      rgbGen: lightmapIndex === -1 ? { kind: "lightingdiffuse" } : { kind: "exactvertex" },
    };
    first.stateBits = (first.stateBits & ~blendMask) | SourceStateBit.DEPTHMASK_TRUE;
    first.rgbGen = lightmapIndex === -1 ? SourceColorGenerator.LightingDiffuse : SourceColorGenerator.ExactVertex;
    first.alphaGen = "skip";
  } else {
    const second = stages[1];
    if (second === undefined || second === null) return;
    if (first.isLightmap) stages[0] = copyWorking(second);
    const collapsed = stages[0];
    if (collapsed === undefined || collapsed === null) return;
    if (collapsed.rgbGen === SourceColorGenerator.OneMinusEntity || second.rgbGen === SourceColorGenerator.OneMinusEntity) {
      collapsed.stage = { ...collapsed.stage, rgbGen: { kind: "identitylighting" } };
      collapsed.rgbGen = SourceColorGenerator.IdentityLighting;
    }
    if (collapsed.rgbGen === SourceColorGenerator.Waveform && second.rgbGen === SourceColorGenerator.Waveform) {
      const a = collapsed.rgbWave.func;
      const b = second.rgbWave.func;
      if ((a === SourceWaveFunction.Sawtooth && b === SourceWaveFunction.InverseSawtooth)
        || (a === SourceWaveFunction.InverseSawtooth && b === SourceWaveFunction.Sawtooth)) {
        collapsed.stage = { ...collapsed.stage, rgbGen: { kind: "identitylighting" } };
        collapsed.rgbGen = SourceColorGenerator.IdentityLighting;
      }
    }
  }
  for (let index = 1; index < 8; index++) stages[index] = null;
}

function finishedStage(stage: WorkingStage): FinishedShaderStage {
  const fields = {
    stage: stage.stage,
    stateBits: stage.stateBits,
    alphaGen: stage.alphaGen,
    rgbGen: stage.rgbGen,
    tcGen: stage.tcGen,
    rgbWave: stage.rgbWave,
    alphaWave: stage.alphaWave,
    isLightmap: stage.isLightmap,
    vertexLightmap: stage.vertexLightmap,
    fogAdjustment: stage.fogAdjustment,
  };
  if (stage.active && stage.imageTMU !== null && stage.binding !== null) {
    return { ...fields, active: true, imageTMU: stage.imageTMU, binding: stage.binding };
  }
  return { ...fields, active: false, imageTMU: null, binding: null };
}

export function finishShader(input: FinishShaderInput): FinishedShader {
  const { definition, profile } = input;
  if (!Number.isInteger(input.lightmapIndex) || input.lightmapIndex < -4 || input.lightmapIndex > 0x7fffffff) {
    throw new RangeError("FinishShader lightmapIndex must be a source lightmap sentinel or non-negative int32");
  }
  if (input.images.length !== definition.stages.length) {
    throw new RangeError("FinishShader needs exactly one image result for each parsed stage");
  }
  const stages: (WorkingStage | null)[] = [];
  for (let index = 0; index < definition.stages.length; index++) {
    const parsed = definition.stages[index];
    const image = input.images[index];
    if (parsed === undefined || image === undefined) throw new Error("validated FinishShader stage input became incomplete");
    stages.push(workingStage(parsed, image, definition.portalRange));
  }
  while (stages.length < 8) stages.push(null);

  const diagnostics: FinishShaderDiagnostic[] = [];
  let sort = definition.sort ?? 0;
  if (definition.sky !== null) sort = 2;
  if (definition.polygonOffset && sort === 0) sort = 4;
  let hasLightmapStage = false;
  let stageIndex = 0;
  while (stageIndex < 8) {
    const current = stages[stageIndex];
    if (current === undefined || current === null) break;
    if (!current.active) {
      diagnostics.push({ kind: "missing-image", stage: stageIndex, message: `Shader ${definition.name} has a stage with no image` });
      stageIndex++;
      continue;
    }
    if (current.stage.detail && !profile.detailTextures) {
      if (stageIndex < 7) {
        for (let move = stageIndex; move < 7; move++) stages[move] = stages[move + 1] ?? null;
        stages[stageIndex + 1] = null;
      }
      stageIndex++;
      continue;
    }
    if (current.tcGen === SourceTexCoordGenerator.Bad) {
      current.tcGen = current.isLightmap ? SourceTexCoordGenerator.Lightmap : SourceTexCoordGenerator.Texture;
      current.stage = { ...current.stage, tcGen: current.isLightmap ? { kind: "lightmap" } : { kind: "texture" } };
    }
    if (current.isLightmap) hasLightmapStage = true;
    const first = stages[0];
    if (first !== undefined && first !== null && isBlended(current) && isBlended(first)) {
      current.fogAdjustment = fogAdjustment(current);
      if (sort === 0) sort = current.stateBits & SourceStateBit.DEPTHMASK_TRUE ? 5 : 9;
    }
    stageIndex++;
  }
  if (sort === 0) sort = 3;

  if (stageIndex > 1 && ((profile.vertexLight && !profile.uiFullscreen) || profile.hardware === "permedia2")) {
    vertexLightingCollapse(stages, sort, input.lightmapIndex);
    stageIndex = 1;
    hasLightmapStage = false;
  }

  let lightmapIndex = input.lightmapIndex;
  if (lightmapIndex >= 0 && !hasLightmapStage) {
    diagnostics.push({
      kind: "lightmap-cleared",
      stage: null,
      message: `Shader ${definition.name} has lightmap but no lightmap stage`,
    });
    lightmapIndex = -1;
  }

  const sourceStages: FinishedShaderStage[] = [];
  for (let index = 0; index < stageIndex; index++) {
    const stage = stages[index];
    if (stage === undefined || stage === null) break;
    sourceStages.push(finishedStage(stage));
  }
  const iterator = sourceMaterialIterator({
    stages: sourceStages,
    sky: definition.sky !== null,
    polygonOffset: definition.polygonOffset,
    deformCount: definition.deforms.length,
  }, profile.iterator);
  const numUnfoggedPasses = iterator.passes.length;
  if (numUnfoggedPasses === 0) sort = 7;
  const fogPass = sort <= 3 ? "equal" : definition.surfaceParms.includes("fog") ? "less-equal" : "none";
  return { sort, lightmapIndex, hasLightmapStage, sourceStages, numUnfoggedPasses, iterator, fogPass, diagnostics };
}

function zeroWave(): SourceWaveStorage {
  return { func: SourceWaveFunction.None, base: 0, amplitude: 0, phase: 0, frequency: 0 };
}

function implicitStage(fields: {
  readonly map: ShaderMap;
  readonly rgbGen: ColorGenerator;
  readonly sourceRgbGen: SourceColorGenerator;
  readonly alphaGen: AlphaGenerator;
  readonly sourceAlphaGen: SourceAlphaGenerator;
  readonly blend: NonNullable<SourceStateInput["blend"]>;
  readonly depthFunc: ShaderStage["depthFunc"];
  readonly depthWrite: boolean;
  readonly isLightmap: boolean;
}): ParsedShaderStage {
  return {
    map: fields.map,
    blend: fields.blend,
    depthFunc: fields.depthFunc,
    depthWrite: fields.depthWrite,
    alphaFunc: "none",
    detail: false,
    rgbGen: fields.rgbGen,
    alphaGen: fields.alphaGen,
    tcGen: fields.isLightmap ? { kind: "lightmap" } : { kind: "texture" },
    tcMods: [],
    sourceState: {
      active: true,
      stateBits: sourceStateBits({ blend: fields.blend.source === "one" && fields.blend.destination === "zero" ? null : fields.blend,
        depthTest: fields.depthFunc === "always" ? "less-equal" : fields.depthFunc, depthWrite: fields.depthWrite, alphaTest: "none" },
      "fill", fields.depthFunc !== "always"),
      rgbGen: fields.sourceRgbGen,
      alphaGen: fields.sourceAlphaGen,
      tcGen: SourceTexCoordGenerator.Bad,
      rgbWave: zeroWave(),
      alphaWave: zeroWave(),
      isLightmap: fields.isLightmap,
      vertexLightmap: false,
    },
  };
}

function implicitDefinition(name: string, stages: readonly ParsedShaderStage[], sort: number | null): ShaderDefinition {
  return {
    name,
    stages,
    surfaceParms: [],
    cull: "front",
    sort,
    sky: null,
    fog: null,
    sun: null,
    deforms: [],
    polygonOffset: false,
    noMipMaps: false,
    noPicMip: false,
    entityMergable: false,
    portalRange: 0,
    clampTime: 0,
    warnings: [],
    compilerDirectives: [],
  };
}

const opaqueBlend: NonNullable<SourceStateInput["blend"]> = { source: "one", destination: "zero" };
const filterBlend: NonNullable<SourceStateInput["blend"]> = { source: "dst-color", destination: "zero" };

/** Builds CreateInternalShaders and the five R_FindShader stage layouts before running FinishShader. */
export function finishImplicitShader(input: FinishImplicitShaderInput): FinishedShader {
  const baseMap: ShaderMap = { kind: "image", name: input.name, clamp: input.kind === "picture" };
  let lightmapIndex: number;
  let stages: readonly ParsedShaderStage[];
  let images: readonly FinishImageMetadata[];
  let sort: number | null = null;
  switch (input.kind) {
    case "default": case "stencil-shadow":
      lightmapIndex = -1;
      stages = [implicitStage({ map: baseMap, rgbGen: { kind: "identitylighting" }, sourceRgbGen: SourceColorGenerator.Bad,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Identity, blend: opaqueBlend, depthFunc: "less-equal", depthWrite: true, isLightmap: false })];
      images = [input.baseImage];
      if (input.kind === "stencil-shadow") sort = 14;
      break;
    case "dynamic":
      lightmapIndex = -1;
      stages = [implicitStage({ map: baseMap, rgbGen: { kind: "lightingdiffuse" }, sourceRgbGen: SourceColorGenerator.LightingDiffuse,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Identity, blend: opaqueBlend, depthFunc: "less-equal", depthWrite: true, isLightmap: false })];
      images = [input.baseImage];
      break;
    case "vertex":
      lightmapIndex = -3;
      stages = [implicitStage({ map: baseMap, rgbGen: { kind: "exactvertex" }, sourceRgbGen: SourceColorGenerator.ExactVertex,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Skip, blend: opaqueBlend, depthFunc: "less-equal", depthWrite: true, isLightmap: false })];
      images = [input.baseImage];
      break;
    case "picture":
      lightmapIndex = -4;
      stages = [implicitStage({ map: baseMap, rgbGen: { kind: "vertex" }, sourceRgbGen: SourceColorGenerator.Vertex,
        alphaGen: { kind: "vertex" }, sourceAlphaGen: SourceAlphaGenerator.Vertex,
        blend: { source: "src-alpha", destination: "one-minus-src-alpha" }, depthFunc: "always", depthWrite: false, isLightmap: false })];
      images = [input.baseImage];
      break;
    case "white": {
      lightmapIndex = -2;
      const white = implicitStage({ map: { kind: "whiteimage" }, rgbGen: { kind: "identitylighting" }, sourceRgbGen: SourceColorGenerator.IdentityLighting,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Identity, blend: opaqueBlend, depthFunc: "less-equal", depthWrite: true, isLightmap: false });
      const base = implicitStage({ map: baseMap, rgbGen: { kind: "identity" }, sourceRgbGen: SourceColorGenerator.Identity,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Identity, blend: filterBlend, depthFunc: "less-equal", depthWrite: false, isLightmap: false });
      stages = [white, base];
      images = [input.whiteImage, input.baseImage];
      break;
    }
    case "lightmap": {
      if (!Number.isInteger(input.lightmapIndex) || input.lightmapIndex < 0 || input.lightmapIndex > 0x7fffffff) {
        throw new RangeError("Implicit lightmap index must be a non-negative int32");
      }
      lightmapIndex = input.lightmapIndex;
      const lightmap = implicitStage({ map: { kind: "lightmap" }, rgbGen: { kind: "identity" }, sourceRgbGen: SourceColorGenerator.Identity,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Identity, blend: opaqueBlend, depthFunc: "less-equal", depthWrite: true, isLightmap: true });
      const base = implicitStage({ map: baseMap, rgbGen: { kind: "identity" }, sourceRgbGen: SourceColorGenerator.Identity,
        alphaGen: { kind: "identity" }, sourceAlphaGen: SourceAlphaGenerator.Identity, blend: filterBlend, depthFunc: "less-equal", depthWrite: false, isLightmap: false });
      stages = [lightmap, base];
      images = [input.lightmapImage, input.baseImage];
      break;
    }
  }
  return finishShader({ definition: implicitDefinition(input.name, stages, sort), lightmapIndex, images, profile: input.profile });
}

/** R_FindShader's named missing-image record, before public registration maps it to handle zero. */
export function finishFailedShader(input: FinishFailedShaderInput): FinishedShader {
  return finishShader({
    definition: implicitDefinition(input.name, [], null),
    lightmapIndex: input.lightmapIndex,
    images: [],
    profile: input.profile,
  });
}
