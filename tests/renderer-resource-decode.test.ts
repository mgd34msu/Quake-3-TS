// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { RendererResourceReceiver, RendererResourceSender } from "../src/render/renderer-resource-transport.ts";
import type { ImageOperationTransfer, MaterialTransfer, ResourceJournal } from "../src/render/renderer-resource-transport.ts";
import { decodeImageFrameState, decodeImageUsageState, decodeResourceJournal } from "../src/render/renderer-resource-decode.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

function fixture() {
  const images = new RendererImageCatalog(), sender = new RendererResourceSender(images, () => {}, () => 3);
  const image = images.create({ name: "decode-image", sourceWidth: 1, sourceHeight: 1, mipmap: false,
    levels: [{ width: 1, height: 1, pixels: new Uint8Array([7, 19, 31, 255]) }], internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
  const definition = parseShaderScript(`decode-material {
    cull none
    deformVertexes wave 2 sin 0 1 0 2
    deformVertexes move 1 2 3 triangle 0 1 0 1
    deformVertexes text7
    q3map_sun 1 2 3 4 5 6
    fogParms ( 0.1 0.2 0.3 ) 64
    qer_editorimage textures/editor
    {
      map decode-image
      rgbGen wave square 0 1 0 2
      alphaGen portal 128
      tcGen vector ( 1 0 0 ) ( 0 1 0 )
      tcMod scale 2 3
      tcMod scroll 0.1 0.2
      tcMod transform 1 2 3 4 5 6
      tcMod stretch sin 1 0.2 0 1
    }
    {
      animMap 2 decode-image decode-image
      blendFunc add
      rgbGen const ( 0.2 0.3 0.4 )
      alphaGen const 0.5
      tcMod rotate 15
      tcMod turb 0 1 0 2
    }
  }`)[0];
  if (definition === undefined) throw new Error("Missing parsed fixture shader");
  const finished = finishShader({ definition, lightmapIndex: -4,
    images: definition.stages.map(() => ({ kind: "loaded", tmu: 0,
      binding: { kind: "images", playback: { kind: "single", image: { image } } } })),
    profile: createRendererSettings().registrationProfile() });
  sender.materialHandle({ kind: "ordinary", name: definition.name, order: 0, sortedIndex: 0, sort: finished.sort,
    lighting: { kind: "picture" }, definition, image, whiteImage: image, defaulted: false, finished,
    sky: null, mip: true, remapped: null, timeOffset: -0 });
  const journal = sender.takeJournal(), entry = journal.entries.find(entry => entry.kind === "material");
  if (entry?.kind !== "material") throw new Error("Missing material transfer");
  return { journal, material: entry.material };
}
function materialJournal(material: unknown): unknown { return { first: 0, entries: [{ kind: "material", material }] }; }
function changed(value: unknown, path: readonly string[], replacement: unknown): unknown {
  const copy: unknown = structuredClone(value);
  let current = copy;
  for (const [index, key] of path.entries()) {
    if (typeof current !== "object" || current === null) throw new Error("Bad mutation fixture path");
    if (index === path.length - 1) { Reflect.set(current, key, replacement); break; }
    current = Reflect.get(current, key);
  }
  return copy;
}
function decodeMaterial(value: unknown): MaterialTransfer {
  const entry = decodeResourceJournal(materialJournal(value)).entries[0];
  if (entry?.kind !== "material") throw new Error("Missing decoded material");
  return entry.material;
}

test("real sender journal decodes deeply and creates worker-owned material and image identities", () => {
  const { journal, material } = fixture(), decoded = decodeResourceJournal(structuredClone(journal));
  expect(decoded).toEqual(journal);
  const restored = decodeMaterial(material);
  expect(restored).toEqual(material);
  expect(restored.definition).not.toBe(material.definition);
  expect(restored.finished.iterator.passes[0]?.bundles[0].stage).not.toBe(material.finished.iterator.passes[0]?.bundles[0].stage);
  expect(Object.is(restored.timeOffset, -0)).toBe(true);
  const images = new RendererImageCatalog(), receiver = new RendererResourceReceiver(images,
    () => { throw new Error("Unexpected cinematic"); }, () => { throw new Error("Unexpected lightmap"); });
  receiver.applyJournal(decoded);
  expect(receiver.resolveMaterial(0).image).toBe(receiver.resolveImage(0));
  expect(receiver.resolveImage(0).belongsTo(images)).toBe(true);
});

test("all image operation variants decode and pixel copies exclude surrounding allocation bytes", () => {
  const backing = new Uint8Array([99, 1, 2, 3, 4, 99]), pixels = backing.subarray(1, 5);
  const content = { width: 1, height: 1, pixels };
  const operations: readonly ImageOperationTransfer[] = [
    { kind: "begin-image", image: 0, mipmap: true, registrationUnit: 1 },
    { kind: "upload-image-level", image: 0, index: 0, content, internalFormat: "rgba4" },
    { kind: "set-image-upload-descriptor", image: 0, width: 1, height: 1, internalFormat: "rgb5" },
    { kind: "finish-image-upload", image: 0, filter: "nearest-mipmap-linear" },
    { kind: "create-image", image: 0, levels: [content], internalFormat: "rgb4-s3tc", mipmap: true,
      sampling: { wrap: "clamp", filter: "linear-mipmap-linear" }, registrationUnit: 1 },
    { kind: "texture-mode", filter: "linear-mipmap-nearest" },
    { kind: "current-border-color", color: { x: 0, y: 0.25, z: 0.5, w: 1 } },
    { kind: "dlight-image", image: 0 },
  ];
  const journal: ResourceJournal = { first: 17, entries: operations.map(operation => ({ kind: "image-operation", operation })) };
  const decoded = decodeResourceJournal(journal);
  expect(decoded).toEqual(journal);
  backing.fill(88);
  const entry = decoded.entries[1];
  if (entry?.kind !== "image-operation" || entry.operation.kind !== "upload-image-level") throw new Error("Missing decoded upload");
  expect(entry.operation.content.pixels).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(entry.operation.content.pixels.buffer.byteLength).toBe(4);
});

test("malformed image variants, handles, dimensions and truncated bytes reject before application", () => {
  const invalid: readonly unknown[] = [
    { kind: "made-up" }, { kind: "dlight-image", image: -1 },
    { kind: "begin-image", image: 0, mipmap: true, registrationUnit: 2 },
    { kind: "texture-mode", filter: "anisotropic" },
    { kind: "finish-image-upload", image: 0 },
    { kind: "set-image-upload-descriptor", image: 0, width: 0, height: 1, internalFormat: "rgba" },
    { kind: "upload-image-level", image: 0, index: -1, content: { width: 1, height: 1, pixels: new Uint8Array(4) }, internalFormat: "rgba" },
    { kind: "upload-image-level", image: 0, index: 0, content: { width: 1, height: 1, pixels: new Uint8Array(3) }, internalFormat: "rgba" },
    { kind: "upload-image-level", image: 0, index: 0, content: { width: 1, height: 1, pixels: new Uint8ClampedArray(4) }, internalFormat: "rgba" },
    { kind: "upload-image-level", image: 0, index: 0, content: { width: 1, height: 1, pixels: new Uint8Array(new SharedArrayBuffer(4)) }, internalFormat: "rgba" },
    { kind: "create-image", image: 0, levels: [], internalFormat: "rgba", mipmap: false, sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 },
    { kind: "current-border-color", color: { x: 0, y: 0, z: 0 } },
  ];
  const images = new RendererImageCatalog(), receiver = new RendererResourceReceiver(images,
    () => { throw new Error("Unexpected cinematic"); }, () => { throw new Error("Unexpected lightmap"); });
  for (const operation of invalid) {
    expect(() => receiver.applyJournal(decodeResourceJournal({ first: 0, entries: [
      { kind: "image-identity", identity: { ordinal: 0, name: "test", sourceWidth: 1, sourceHeight: 1, mipmap: false, wrap: "repeat", registrationUnit: 0 } },
      { kind: "image-operation", operation },
    ] }))).toThrow();
    expect(images.registeredImages()).toHaveLength(0);
  }
});

test("deep material malformed discriminants, missing fields and source allocation limits reject", () => {
  const { material } = fixture();
  const invalid: readonly { readonly path: readonly string[]; readonly value: unknown }[] = [
    { path: ["kind"], value: "bogus" }, { path: ["order"], value: 16384 }, { path: ["remapped"], value: -1 },
    { path: ["remapped"], value: 16384 },
    { path: ["lighting"], value: { kind: "lightmap", owner: 0, image: 0 } },
    { path: ["sky"], value: { outer: { rt: 0, bk: 0, lf: 0, ft: 0, up: 0 }, inner: null, cloudHeight: 0 } },
    { path: ["definition", "stages", "0", "sourceState", "rgbGen"], value: 12 },
    { path: ["definition", "stages", "0", "sourceState", "alphaGen"], value: 10 },
    { path: ["definition", "stages", "0", "sourceState", "tcGen"], value: 7 },
    { path: ["definition", "stages", "0", "sourceState", "rgbWave", "func"], value: 7 },
    { path: ["definition", "stages", "0", "rgbGen", "wave", "frequency"], value: undefined },
    { path: ["definition", "stages", "0", "map", "kind"], value: "bogus" },
    { path: ["definition", "stages", "0", "blend", "source"], value: "bogus" },
    { path: ["definition", "stages", "0", "tcGen", "s", "z"], value: "0" },
    { path: ["definition", "stages", "0", "tcMods", "2", "m11"], value: undefined },
    { path: ["definition", "deforms", "2", "index"], value: 8 },
    { path: ["definition", "deforms"], value: Array.from({ length: 4 }, () => ({ kind: "none" })) },
    { path: ["finished", "sourceStages", "0", "active"], value: false },
    { path: ["finished", "sourceStages", "0", "imageTMU"], value: 2 },
    { path: ["finished", "sourceStages", "0", "binding"], value: { kind: "images", playback: { kind: "animation", frequency: 1, frames: [] } } },
    { path: ["finished", "sourceStages", "0", "binding"], value: { kind: "images", playback: { kind: "animation", frequency: 1, frames: Array.from({ length: 9 }, () => 0) } } },
    { path: ["finished", "iterator", "passes", "0", "bundles"], value: [] },
    { path: ["finished", "iterator", "kind"], value: "bogus" },
    { path: ["finished", "lightmapIndex"], value: -5 },
    { path: ["definition", "warnings"], value: [{ source: "test", line: 1, column: 2 }] },
  ];
  for (const mutation of invalid) expect(() => decodeMaterial(changed(material, mutation.path, mutation.value))).toThrow();
});

test("retained NaN, infinity and negative zero source fields survive decoding", () => {
  let material: unknown = fixture().material;
  material = changed(material, ["finished", "sourceStages", "0", "rgbWave", "base"], Number.NaN);
  material = changed(material, ["definition", "deforms", "0", "spread"], Number.POSITIVE_INFINITY);
  material = changed(material, ["definition", "stages", "0", "tcGen", "s", "x"], -0);
  const decoded = decodeMaterial(material);
  expect(Number.isNaN(decoded.finished.sourceStages[0]?.rgbWave.base)).toBe(true);
  const deform = decoded.definition?.deforms[0], tc = decoded.definition?.stages[0]?.tcGen;
  if (deform?.kind !== "wave" || tc?.kind !== "vector") throw new Error("Missing fixture variants");
  expect(deform.spread).toBe(Number.POSITIVE_INFINITY);
  expect(Object.is(tc.s.x, -0)).toBe(true);
});

test("animation, cinematic, retained, inactive and paired stage variants decode", () => {
  const { material } = fixture();
  const bindings: readonly unknown[] = [
    { kind: "images", playback: { kind: "animation", frequency: 2.5, frames: [0, 1, 2, 3, 4, 5, 6, 7] } },
    { kind: "video", source: 3 }, { kind: "retain-current-texture" },
  ];
  for (const binding of bindings) {
    const decoded = decodeMaterial(changed(material, ["finished", "sourceStages", "0", "binding"], binding));
    expect<unknown>(decoded.finished.sourceStages[0]?.binding).toEqual(binding);
  }
  const first = material.finished.sourceStages[0];
  if (first === undefined) throw new Error("Missing first stage");
  const inactive: MaterialTransfer["finished"]["sourceStages"][number] = { ...first, active: false, imageTMU: null, binding: null };
  expect(decodeMaterial(changed(material, ["finished", "sourceStages", "0"], inactive)).finished.sourceStages[0]).toEqual(inactive);
  const pair: readonly [typeof first, typeof inactive] = [first, inactive];
  expect(decodeMaterial(changed(material, ["finished", "iterator", "passes", "0", "bundles"], pair)).finished.iterator.passes[0]?.bundles).toEqual(pair);
  const faces = { rt: 0, bk: 1, lf: 2, ft: 3, up: 4, dn: 5 }, sky = { outer: faces, inner: faces, cloudHeight: 512 };
  const decoded = decodeMaterial(changed(changed(material, ["sky"], sky), ["lighting"], { kind: "lightmap", owner: 1, index: 2, image: 3 }));
  expect(decoded.sky).toEqual(sky);
  expect(decoded.sky?.outer).not.toBe(faces);
  expect(decoded.lighting).toEqual({ kind: "lightmap", owner: 1, index: 2, image: 3 });
});

test("remaining shader map, generator and deformation variants retain their exact fields", () => {
  const { material } = fixture(), wave = { kind: "noise", base: 1, amplitude: 2, phase: 3, frequency: 4 };
  const groups: readonly { readonly path: readonly string[]; readonly variants: readonly unknown[] }[] = [
    { path: ["definition", "deforms"], variants: [
      [{ kind: "projectionshadow" }], [{ kind: "autosprite" }], [{ kind: "autosprite2" }], [{ kind: "none" }],
      [{ kind: "normal", amplitude: 2, frequency: 3 }], [{ kind: "bulge", width: 1, height: 2, speed: 3 }],
    ] },
    { path: ["definition", "stages", "0", "map"], variants: [
      { kind: "lightmap" }, { kind: "whiteimage" }, { kind: "none" }, { kind: "video", name: "video.roq" },
    ] },
    { path: ["definition", "stages", "0", "rgbGen"], variants: [
      { kind: "identity" }, { kind: "identitylighting" }, { kind: "entity" }, { kind: "oneminusentity" },
      { kind: "vertex" }, { kind: "exactvertex" }, { kind: "lightingdiffuse" }, { kind: "oneminusvertex" },
    ] },
    { path: ["definition", "stages", "0", "alphaGen"], variants: [
      { kind: "identity" }, { kind: "entity" }, { kind: "oneminusentity" }, { kind: "vertex" },
      { kind: "lightingspecular" }, { kind: "oneminusvertex" }, { kind: "wave", wave },
    ] },
    { path: ["definition", "stages", "0", "tcGen"], variants: [{ kind: "texture" }, { kind: "lightmap" }, { kind: "environment" }] },
    { path: ["definition", "stages", "0", "tcMods"], variants: [[{ kind: "entitytranslate" }, { kind: "none" }]] },
    { path: ["definition", "sky"], variants: [{ outerBox: "outer", innerBox: null, cloudHeight: 512 }] },
  ];
  for (const group of groups) for (const variant of group.variants) {
    const expected = changed(material, group.path, variant);
    expect<unknown>(decodeMaterial(expected)).toEqual(expected);
  }
});

test("buffer inputs copy ownership and sparse arrays reject as truncated records", () => {
  const pixels = Buffer.from([3, 5, 7, 11]);
  const decoded = decodeResourceJournal({ first: 0, entries: [{ kind: "image-operation", operation: {
    kind: "upload-image-level", image: 0, index: 0, content: { width: 1, height: 1, pixels }, internalFormat: "rgba",
  } }] });
  pixels.fill(0);
  const entry = decoded.entries[0];
  if (entry?.kind !== "image-operation" || entry.operation.kind !== "upload-image-level") throw new Error("Missing upload");
  expect(entry.operation.content.pixels).toEqual(new Uint8Array([3, 5, 7, 11]));
  const sparse: unknown[] = [];
  sparse.length = 1;
  expect(() => decodeResourceJournal({ first: 0, entries: sparse })).toThrow("Sparse");
  expect(() => decodeImageUsageState(sparse)).toThrow("Sparse");
  expect(() => decodeResourceJournal({ first: 0, entries: [{ kind: "image-operation", operation: {
    kind: "current-border-color", color: { x: 2, y: 0, z: 0, w: 1 },
  } }] })).toThrow("normalized");
});

test("frame and usage state validate signed frame bounds and pending zero image dimensions", () => {
  expect(decodeImageFrameState({ frameCount: -0x80000000, noBind: true, ignoreGLErrors: false }))
    .toEqual({ frameCount: -0x80000000, noBind: true, ignoreGLErrors: false });
  expect(decodeImageUsageState([{ ordinal: 0, frameUsed: 0x7fffffff, uploadWidth: 0, uploadHeight: 0 }]))
    .toEqual([{ ordinal: 0, frameUsed: 0x7fffffff, uploadWidth: 0, uploadHeight: 0 }]);
  for (const frameCount of [-0x80000001, 0x80000000, Number.NaN, 1.5])
    expect(() => decodeImageFrameState({ frameCount, noBind: false, ignoreGLErrors: false })).toThrow();
  expect(() => decodeImageFrameState({ frameCount: 0, noBind: false })).toThrow();
  expect(() => decodeImageUsageState([{ ordinal: 0, frameUsed: 0, uploadWidth: -1, uploadHeight: 1 }])).toThrow();
  expect(() => decodeImageUsageState({ ordinal: 0 })).toThrow();
  for (const journal of [null, {}, { first: -1, entries: [] }, { first: 0, entries: [{ kind: "unknown" }] }])
    expect(() => decodeResourceJournal(journal)).toThrow();
  expect(() => decodeResourceJournal({ first: Number.MAX_SAFE_INTEGER, entries: [
    { kind: "material-state", handle: 0, sortedIndex: 0, remapped: null, timeOffset: 0 },
  ] })).toThrow("cursor");
});
