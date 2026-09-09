// Unchanged tr_shader.c oracle: /tmp/quake-tess-reference-k3GjAo/iterator.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { parseShaderScript, SourceColorGenerator, SourceTexCoordGenerator } from "../src/render/material.ts";
import type { ShaderStage } from "../src/render/material.ts";
import { sourceMaterialIterator } from "../src/render/material-iterator.ts";
import type { FinishedIteratorStage, IteratorWaveStorage, MaterialIteratorInput, MaterialIteratorProfile } from "../src/render/material-iterator.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { publishTexture } from "./render-target-fixture.ts";

// Explicit enabled-extension/fast-iterator profile, not the Linux source defaults.
const profile: MaterialIteratorProfile = { ignoreFastPath: false, multitexture: true, textureEnvAdd: true, driver: "generic" };
const zeroWave: IteratorWaveStorage = { func: 0, base: 0, amplitude: 0, phase: 0, frequency: 0 };
type ActiveStage = Extract<FinishedIteratorStage, { active: true }>;
function stage(text: string): ActiveStage {
  const value = parseShaderScript(`fixture { { ${text} } }`)[0]?.stages[0];
  if (value === undefined) throw new Error("missing fixture stage");
  const image = publishTexture(new RendererImageCatalog(), { name: "iterator-image", width: 1, height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" },
    registrationUnit: value.map.kind === "lightmap" ? 1 : 0 });
  // The fixture writes these exact source fields; it does not recover parser state.
  return { stage: value, stateBits: value.sourceState.stateBits, active: true, rgbGen: value.sourceState.rgbGen, fogAdjustment: "none", alphaGen: value.alphaGen.kind, rgbWave: zeroWave, alphaWave: zeroWave,
    tcGen: value.map.kind === "lightmap" ? SourceTexCoordGenerator.Lightmap : SourceTexCoordGenerator.Texture,
    binding: { kind: "images", playback: { kind: "single", image: { image } } },
    isLightmap: value.map.kind === "lightmap", vertexLightmap: false, imageTMU: value.map.kind === "lightmap" ? 1 : 0 };
}
function input(stages: readonly FinishedIteratorStage[]): MaterialIteratorInput { return { stages, sky: false, polygonOffset: false, deformCount: 0 }; }
function lightmap(): readonly [ActiveStage, ActiveStage] {
  return [stage("map $lightmap rgbGen identity"), stage("map base.tga blendFunc filter rgbGen identity")];
}

test("native classifier trace: lightmap collapse, ignore-fast, depth mismatch, deforms and sky priority", () => {
  const [a, b] = lightmap(), material = input([a, b]);
  const collapsed = sourceMaterialIterator(material, profile);
  expect(collapsed.kind).toBe("lightmapped-multitexture"); expect(collapsed.multitextureEnv).toBe("modulate"); expect(collapsed.passes).toHaveLength(1);
  expect(collapsed.passes[0]?.bundles).toEqual([b, a]);
  expect(sourceMaterialIterator(material, { ...profile, ignoreFastPath: true }).kind).toBe("generic");
  expect(sourceMaterialIterator(material, { ...profile, ignoreFastPath: true }).passes).toHaveLength(1);
  expect(sourceMaterialIterator(input([a, { ...b, stateBits: b.stateBits | 0x20000, stage: { ...b.stage, depthFunc: "equal" } }]), profile).passes).toHaveLength(2);
  expect(sourceMaterialIterator({ ...material, deformCount: 1 }, profile).kind).toBe("generic");
  expect(sourceMaterialIterator({ ...material, sky: true }, { ...profile, ignoreFastPath: true }).kind).toBe("sky");
  expect(sourceMaterialIterator({ ...material, polygonOffset: true }, profile).kind).toBe("generic");
});

test("vertex-lit fast iterator ignores tcMods but requires identity alpha and no deformations", () => {
  const diffuse = stage("map base.tga rgbGen lightingDiffuse tcMod scroll 1 2");
  expect(sourceMaterialIterator(input([diffuse]), profile).kind).toBe("vertex-lit");
  expect(sourceMaterialIterator(input([{ ...diffuse, alphaGen: "skip" }]), profile).kind).toBe("generic");
  expect(sourceMaterialIterator(input([{ ...diffuse, tcGen: SourceTexCoordGenerator.Bad }]), profile).kind).toBe("generic");
  expect(sourceMaterialIterator(input([{ ...diffuse, rgbGen: SourceColorGenerator.Bad }]), profile).kind).toBe("generic");
  expect(sourceMaterialIterator({ ...input([diffuse]), deformCount: 1 }, profile).kind).toBe("generic");
  expect(sourceMaterialIterator(input([diffuse]), { ...profile, multitexture: false }).kind).toBe("vertex-lit");
});

test("source compares RGB wave bytes but accidentally compares alpha wave storage only for portal enum", () => {
  const [a, b] = lightmap(), wave = { ...zeroWave, func: 1, base: 1 };
  const rgb: ShaderStage["rgbGen"] = { kind: "wave", wave: { kind: "sin", base: 1, amplitude: 0, phase: 0, frequency: 0 } };
  const rgbA = { ...a, stage: { ...a.stage, rgbGen: rgb }, rgbGen: SourceColorGenerator.Waveform, rgbWave: wave }, rgbB = { ...b, stage: { ...b.stage, rgbGen: rgb }, rgbGen: SourceColorGenerator.Waveform, rgbWave: { ...wave, base: 2 } };
  expect(sourceMaterialIterator(input([rgbA, rgbB]), profile).passes).toHaveLength(2);
  expect(sourceMaterialIterator(input([rgbA, { ...rgbB, rgbWave: wave }]), profile).passes).toHaveLength(1);
  const alpha: ShaderStage["alphaGen"] = { kind: "wave", wave: { kind: "sin", base: 1, amplitude: 0, phase: 0, frequency: 0 } };
  const alphaA: FinishedIteratorStage = { ...a, stage: { ...a.stage, alphaGen: alpha }, alphaGen: "wave", alphaWave: wave };
  const alphaB: FinishedIteratorStage = { ...b, stage: { ...b.stage, alphaGen: alpha }, alphaGen: "wave", alphaWave: zeroWave };
  expect(sourceMaterialIterator(input([alphaA, alphaB]), profile).passes).toHaveLength(1);
  expect(sourceMaterialIterator(input([{ ...alphaA, alphaGen: "portal" }, { ...alphaB, alphaGen: "portal" }]), profile).passes).toHaveLength(2);
  expect(sourceMaterialIterator(input([{ ...alphaA, alphaGen: "portal", alphaWave: zeroWave }, { ...alphaB, alphaGen: "portal", alphaWave: { ...zeroWave, base: -0 } }]), profile).passes).toHaveLength(2);
});

test("all eight native blend-table pairs collapse, and source keeps first depthWrite and ignores constant RGB differences", () => {
  const blends: readonly { readonly blend: ShaderStage["blend"]; readonly bits: number }[] = [
    { blend: { source: "one", destination: "zero" }, bits: 0 }, { blend: { source: "dst-color", destination: "zero" }, bits: 0x13 },
    { blend: { source: "zero", destination: "src-color" }, bits: 0x31 }, { blend: { source: "one", destination: "one" }, bits: 0x22 },
  ];
  const [a, b] = lightmap(); let count = 0;
  for (const first of blends) for (const second of blends) {
    const result = sourceMaterialIterator(input([{ ...a, stateBits: (a.stateBits & ~0xff) | first.bits, stage: { ...a.stage, blend: first.blend } },
      { ...b, stateBits: (b.stateBits & ~0xff) | second.bits, stage: { ...b.stage, blend: second.blend } }]), profile);
    if (result.passes.length === 1) { count++; expect(result.passes[0]?.stage.depthWrite).toBe(a.stage.depthWrite); }
  }
  expect(count).toBe(8);
  const constantA = stage("map a.tga rgbGen const ( 1 0 0 )"), constantB = stage("map b.tga blendFunc filter rgbGen const ( 0 1 0 )");
  expect(sourceMaterialIterator(input([constantA, constantB]), profile).passes).toHaveLength(1);
});

test("capabilities and source Voodoo TMU equality gate collapse, and only the first two passes are considered", () => {
  const [a, b] = lightmap(), material = input([a, b]);
  expect(sourceMaterialIterator(material, { ...profile, multitexture: false }).passes).toHaveLength(2);
  expect(sourceMaterialIterator(material, { ...profile, driver: "voodoo" }).passes).toHaveLength(1);
  expect(sourceMaterialIterator(input([{ ...a, active: true, imageTMU: 0 }, { ...b, active: true, imageTMU: 0 }]), { ...profile, driver: "voodoo" }).passes).toHaveLength(2);
  const add = { ...b, stateBits: (b.stateBits & ~0xff) | 0x22, stage: { ...b.stage, blend: { source: "one", destination: "one" } satisfies ShaderStage["blend"] } };
  expect(sourceMaterialIterator(input([a, add]), { ...profile, textureEnvAdd: false }).passes).toHaveLength(2);
  expect(sourceMaterialIterator(input([a, add]), profile).multitextureEnv).toBe("add");
  expect(sourceMaterialIterator(input([{ ...a, active: false, imageTMU: null, binding: null }, b]), profile).passes).toHaveLength(2);
  const three = sourceMaterialIterator(input([a, b, b]), profile);
  expect(three.passes).toHaveLength(2); expect(three.kind).toBe("generic"); expect(three.passes[1]?.bundles).toEqual([b]);
});

test("collapse compares retained raw masks and preserves all first-stage non-blend bits", () => {
  const [a, b] = lightmap();
  const incomplete = stage("map base\nrgbGen identity\nblendFunc GL_ONE\n");
  expect(incomplete.stateBits).toBe(0x102);
  expect(sourceMaterialIterator(input([incomplete, b]), profile).passes).toHaveLength(2);
  for (const differing of [0x1000, 0x10000, 0x20000, 0x10000000]) {
    expect(sourceMaterialIterator(input([{ ...a, stateBits: a.stateBits | differing }, b]), profile).passes).toHaveLength(2);
  }
  const flags = 0x1000 | 0x10000 | 0x20000 | 0x10000000;
  const collapsed = sourceMaterialIterator(input([{ ...a, stateBits: a.stateBits | flags }, { ...b, stateBits: b.stateBits | flags }]), profile);
  expect(collapsed.passes).toHaveLength(1);
  expect(collapsed.passes[0]?.stateBits).toBe(flags | 0x100);
});
