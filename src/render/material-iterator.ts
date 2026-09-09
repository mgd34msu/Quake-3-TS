// CollapseMultitexture/ComputeStageIteratorFunc, id Software renderer/tr_shader.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { FinishedStageBinding, ShaderStage, SourceWaveStorage } from "./material.ts";
import { SourceColorGenerator, SourceTexCoordGenerator } from "./material.ts";
import type { RenderState } from "./types.ts";
import type { FogAdjustment } from "./fog.ts";
import { SourceStateBit } from "./source-state.ts";

/** Actual waveForm_t storage, including fields retained by repeated directives. */
export type IteratorWaveStorage = SourceWaveStorage;
interface IteratorStageFields {
  readonly stage: ShaderStage;
  readonly stateBits: number;
  readonly rgbGen: SourceColorGenerator;
  readonly fogAdjustment: FogAdjustment;
  /** Source alphaGen_t after ParseStage's numeric CGEN_IDENTITY comparison. */
  readonly alphaGen: ShaderStage["alphaGen"]["kind"] | "skip";
  readonly tcGen: SourceTexCoordGenerator;
  readonly rgbWave: IteratorWaveStorage;
  readonly alphaWave: IteratorWaveStorage;
  readonly isLightmap: boolean;
  readonly vertexLightmap: boolean;
}
export type FinishedIteratorStage = IteratorStageFields & ({ readonly active: true; readonly imageTMU: 0 | 1; readonly binding: FinishedStageBinding }
  | { readonly active: false; readonly imageTMU: null; readonly binding: null });
export interface MaterialIteratorProfile {
  readonly ignoreFastPath: boolean;
  readonly multitexture: boolean;
  readonly textureEnvAdd: boolean;
  readonly driver: "generic" | "voodoo";
}
export interface MaterialIteratorInput {
  /** FinishShader has already applied image, detail and vertex-light rules. */
  readonly stages: readonly FinishedIteratorStage[];
  readonly sky: boolean;
  readonly polygonOffset: boolean;
  readonly deformCount: number;
}
export interface IteratorPass {
  readonly stage: ShaderStage;
  readonly stateBits: number;
  readonly rgbGen: SourceColorGenerator;
  readonly fogAdjustment: FogAdjustment;
  readonly alphaGen: FinishedIteratorStage["alphaGen"];
  readonly bundles: readonly [FinishedIteratorStage] | readonly [FinishedIteratorStage, FinishedIteratorStage];
}
export interface MaterialIterator {
  readonly kind: "generic" | "vertex-lit" | "lightmapped-multitexture" | "sky";
  readonly passes: readonly IteratorPass[];
  readonly multitextureEnv: "none" | "modulate" | "add";
}

type Blend = RenderState["blend"];
const blendMask = SourceStateBit.SRCBLEND_BITS | SourceStateBit.DSTBLEND_BITS;
const filterSource = SourceStateBit.SRCBLEND_DST_COLOR | SourceStateBit.DSTBLEND_ZERO;
const filterDestination = SourceStateBit.SRCBLEND_ZERO | SourceStateBit.DSTBLEND_SRC_COLOR;
const additive = SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE;

function collapseBlend(first: number, second: number): { readonly env: "modulate" | "add"; readonly blend: Blend; readonly bits: number } | null {
  if (second === filterSource || second === filterDestination) {
    if (first === 0) return { env: "modulate", blend: { source: "one", destination: "zero" }, bits: 0 };
    if (first === filterSource || first === filterDestination) return { env: "modulate", blend: { source: "dst-color", destination: "zero" }, bits: filterSource };
  }
  if (second === additive) {
    if (first === 0) return { env: "add", blend: { source: "one", destination: "zero" }, bits: 0 };
    if (first === additive) return { env: "add", blend: { source: "one", destination: "one" }, bits: additive };
  }
  return null;
}
function sameWave(a: IteratorWaveStorage, b: IteratorWaveStorage): boolean {
  return a.func === b.func && Object.is(Math.fround(a.base), Math.fround(b.base)) && Object.is(Math.fround(a.amplitude), Math.fround(b.amplitude))
    && Object.is(Math.fround(a.phase), Math.fround(b.phase)) && Object.is(Math.fround(a.frequency), Math.fround(b.frequency));
}

/** Only the first two stages are considered once; source does not collapse to a fixed point. */
export function sourceMaterialIterator(input: MaterialIteratorInput, profile: MaterialIteratorProfile): MaterialIterator {
  const passes: IteratorPass[] = input.stages.map(stage => ({ stage: stage.stage, stateBits: stage.stateBits, rgbGen: stage.rgbGen, fogAdjustment: stage.fogAdjustment, alphaGen: stage.alphaGen, bundles: [stage] }));
  let multitextureEnv: MaterialIterator["multitextureEnv"] = "none";
  const a = input.stages[0], b = input.stages[1];
  if (profile.multitexture && a !== undefined && b !== undefined && a.active && b.active
    && (profile.driver !== "voodoo" || a.imageTMU !== b.imageTMU)
    && (a.stateBits & ~(blendMask | SourceStateBit.DEPTHMASK_TRUE)) === (b.stateBits & ~(blendMask | SourceStateBit.DEPTHMASK_TRUE))
    && a.rgbGen === b.rgbGen && a.alphaGen === b.alphaGen
    && (a.rgbGen !== SourceColorGenerator.Waveform || sameWave(a.rgbWave, b.rgbWave))
    // Original typo compares alphaGen to CGEN_WAVEFORM (8), i.e. AGEN_PORTAL.
    && (a.alphaGen !== "portal" || sameWave(a.alphaWave, b.alphaWave))) {
    const collapse = collapseBlend(a.stateBits & blendMask, b.stateBits & blendMask);
    if (collapse !== null && (collapse.env !== "add" || profile.textureEnvAdd && a.rgbGen === SourceColorGenerator.Identity)) {
      multitextureEnv = collapse.env;
      const bundles: readonly [FinishedIteratorStage, FinishedIteratorStage] = a.isLightmap ? [b, a] : [a, b];
      passes.splice(0, 2, { stage: { ...a.stage, blend: collapse.blend }, stateBits: (a.stateBits & ~blendMask) | collapse.bits,
        rgbGen: a.rgbGen, fogAdjustment: a.fogAdjustment, alphaGen: a.alphaGen, bundles });
    }
  }
  let kind: MaterialIterator["kind"] = "generic";
  const first = passes[0];
  if (input.sky) kind = "sky";
  else if (!profile.ignoreFastPath && passes.length === 1 && first !== undefined && !input.polygonOffset && input.deformCount === 0) {
    if (first.rgbGen === SourceColorGenerator.LightingDiffuse && first.alphaGen === "identity" && first.bundles[0].tcGen === SourceTexCoordGenerator.Texture && multitextureEnv === "none") kind = "vertex-lit";
    if (first.rgbGen === SourceColorGenerator.Identity && first.alphaGen === "identity" && first.bundles[0].tcGen === SourceTexCoordGenerator.Texture
      && first.bundles[1]?.tcGen === SourceTexCoordGenerator.Lightmap && multitextureEnv !== "none") kind = "lightmapped-multitexture";
  }
  return { kind, passes, multitextureEnv };
}
