import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Source renderer shared tess lifetime across RC_DRAW_SURFS/RC_STRETCH_PIC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import { encodePng } from "../src/core/png.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererResources } from "../src/render/world.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { createModelEntity, createRailCoreEntity } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function tessRenderer(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, width: number, height: number, milliseconds: number) {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Shared source tess", width, height, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(width, height, images, gl?.subpixelBits ?? 8), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const settings = createRendererSettings(), clock = { milliseconds: () => milliseconds };
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => queue.close("discard"));
  queue.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: black, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
  return { resources, queue, recording, cpu, gl };
}

function assets(files: ReadonlyMap<string, Uint8Array>): RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> {
  return withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: prefix => [...files.keys()].filter(name => prefix === undefined || name.startsWith(prefix)),
    read: async name => { const data = files.get(name); if (data === undefined) throw new Error(`missing fixture ${name}`); return data; } });
}
function checker(): Uint8Array {
  const bytes = new Uint8Array(30); bytes[2] = 2; bytes[12] = 2; bytes[14] = 2; bytes[16] = 24; bytes[17] = 0x20;
  bytes.set([0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255], 18); return bytes;
}
const camera = { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) };
const black = vec4(0, 0, 0, 1);

test("prepared text0 uses captured refdef bytes, renders atlas glyphs on CPU/GL, and retains text for a later picture", async () => {
  const atlas = new Uint8Array(18 + 256 * 256 * 4);
  atlas[2] = 2; atlas[13] = 1; atlas[15] = 1; atlas[16] = 32; atlas[17] = 0x28;
  const glyphs: readonly (readonly [number, readonly string[]])[] = [
    [65, ["01110", "10001", "10001", "11111", "10001", "10001", "10001"]],
    [66, ["11110", "10001", "10001", "11110", "10001", "10001", "11110"]],
  ];
  for (const [code, rows] of glyphs) for (const [y, row] of rows.entries()) for (let x = 0; x < row.length; x++) {
    if (row[x] !== "1") continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const offset = 18 + (((code >> 4) * 16 + y * 2 + dy + 1) * 256 + (code & 15) * 16 + x * 2 + dx + 3) * 4;
      atlas.set(code === 65 ? [0, 0, 255, 255] : [0, 255, 0, 255], offset);
    }
  }
  const script = "letters { cull none deformVertexes text0 { map atlas.tga rgbGen exactvertex alphaFunc GE128 } } picture-text { cull none deformVertexes text0 { map atlas.tga rgbGen exactvertex } }";
  const bsp = renderBspFixture([{ shader: "letters", lightmap: -1 }, { shader: "letters", lightmap: -1 }], []);
  const { resources, queue, recording, cpu, gl } = await tessRenderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)], ["atlas.tga", atlas], ["maps/test.bsp", bsp]])), 128, 96, 0);
  const world = await resources.loadWorld("test"), refdef = cameraRefdef(camera, 128, 96);
  refdef.text = ["A B\0unused", "", "", "", "", "", "", ""];
  const prepared = world.prepareFrame({ refdef });
  refdef.text = ["", "", "", "", "", "", "", ""];
  queue.addPreparedViews(prepared); queue.submit();
  expect(resources.diagnostics.some(message => message.includes("deform text"))).toBe(false);
  const batch = recording.trace().at(-1)?.batches[0];
  if (batch === undefined) throw new Error("missing text material batch");
  expect(batch.vertices).toHaveLength(8); expect(batch.indices).toHaveLength(12);
  expect(batch.vertices[0]?.texCoord).toEqual({ x: 1 / 16, y: 4 / 16 });
  expect(batch.vertices[4]?.texCoord).toEqual({ x: 2 / 16, y: 4 / 16 });
  expect(batch.vertices.every(vertex => vertex.color.x === 1 && vertex.color.y === 1 && vertex.color.z === 1 && vertex.color.w === 1)).toBe(true);
  let red = 0, green = 0;
  for (const [index, value] of cpu.pixels.entries()) {
    if (index % 4 === 0 && value > 100) red++;
    if (index % 4 === 1 && value > 100) green++;
  }
  expect(red).toBeGreaterThan(15); expect(green).toBeGreaterThan(15);
  if (gl !== null) {
    const pixels = gl.readPixels(); let maximum = 0;
    for (const [index, value] of pixels.entries()) {
      const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("missing CPU text channel");
      maximum = Math.max(maximum, Math.abs(value - expected));
    }
    expect(maximum).toBeLessThanOrEqual(1);
  }
  const picture = resources.picture(await resources.registerShaderNoMip("picture-text"));
  queue.draw2D("pixels").drawPic({ x: 0, y: 0, width: 32, height: 32 }, picture); queue.submitFrame();
  // StretchPic sets z=0, so source text is degenerate here but still emits both retained glyphs.
  const pictureBatch = recording.trace().at(-1)?.batches[0];
  expect(pictureBatch?.vertices).toHaveLength(8);
  expect(pictureBatch?.vertices[0]?.texCoord).toEqual({ x: 1 / 16, y: 4 / 16 });
  expect(pictureBatch?.vertices[4]?.texCoord).toEqual({ x: 2 / 16, y: 4 / 16 });
  expect(resources.tess.renderText[0]).toBe("A B\0unused");
  queue.addPreparedViews(world.prepareFrame({ refdef })); queue.submit();
  expect(resources.tess.renderText[0]).toBe(""); expect(resources.tess.numVertexes).toBe(0);
});

test("actual prepared BSP→2D retains lightmap coordinates and normals and renders those UVs on CPU/GL", async () => {
  const script = "seed { cull none { map $whiteimage rgbGen const ( .4 .5 .6 ) alphaGen const .25 } } pic { cull none { map checker.tga tcGen lightmap rgbGen identity } }";
  const bsp = renderBspFixture([{ shader: "seed", lightmap: -1 }, { shader: "seed", lightmap: -1 }], []);
  const { resources, queue, recording, cpu, gl } = await tessRenderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)], ["checker.tga", checker()], ["maps/test.bsp", bsp]])), 32, 32, 12345);
  const world = await resources.loadWorld("test"), shader = await resources.registerShaderNoMip("pic");
  const draw = queue.draw2D("pixels");
  queue.addPreparedViews(world.prepareFrame({ refdef: cameraRefdef(camera, 32, 32) }));
  draw.drawPic({ x: 0, y: 0, width: 32, height: 32 }, resources.picture(shader));
  expect(resources.tess.numVertexes).toBe(0);
  queue.submitFrame(); const last = recording.trace().at(-1);
  if (last === undefined) throw new Error("missing final picture");
  expect(last.batches[0]?.vertices.every(vertex => vertex.texCoord.x === 0.5 && vertex.texCoord.y === 0.5)).toBe(true);
  expect(resources.tess.snapshotGeometry().vertices.every(vertex => vertex.normal.x === -1)).toBe(true);
  expect(resources.tess.shaderTime).toBe(12.345000267028809);
  expect(Array.from(cpu.pixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4))).toEqual([128, 128, 128, 255]);
  if (gl !== null) {
    const pixels = gl.readPixels();
    // This driver rounds the bilinear half-byte tie down; CPU rounds it up.
    expect(Array.from(pixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4))).toEqual([127, 127, 127, 255]);
    let maximum = 0;
    for (const [index, value] of pixels.entries()) {
      const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("missing CPU checker channel");
      maximum = Math.max(maximum, Math.abs(value - expected));
    }
    expect(maximum).toBe(1);
  }
});

test("2D→rail keeps vertex alpha and stage colors in distinct storage; first-frame BSS alpha stays zero", async () => {
  const script = "pic { cull none { map $whiteimage rgbGen vertex alphaGen vertex } } rail { cull none { map $whiteimage rgbGen exactvertex alphaGen vertex } }";
  const { resources, queue, recording } = await tessRenderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)]])), 32, 32, 1000);
  const picture = await resources.registerShaderNoMip("pic"), railShader = await resources.registerShader("rail");
  const refdef = { ...cameraRefdef(camera, 32, 32), renderFlags: RDF_NOWORLDMODEL };
  const rail = { ...createRailCoreEntity(), origin: vec3(20, 0, 0), oldOrigin: vec3(20, 10, 0), shaderRGBA: vec4(20, 30, 40, 255), customShader: railShader };
  queue.addPreparedViews(resources.prepareFrame({ refdef, entities: [rail] })); queue.submit();
  expect(recording.trace().at(-1)?.batches[0]?.vertices.every(vertex => vertex.color.w === 0)).toBe(true);
  const draw = queue.draw2D("pixels");
  draw.setColor(vec4(1, 1, 1, 0.5)); draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, resources.picture(picture));
  queue.addPreparedViews(resources.prepareFrame({ refdef, entities: [rail] })); queue.submit();
  const final = recording.trace().at(-1); if (final === undefined) throw new Error("missing rail view");
  expect(final.batches[0]?.vertices.every(vertex => vertex.color.w === 127 / 255)).toBe(true);
  expect(final.batches[0]?.vertices[0]?.color.x).toBe(5 / 255); // DoRailCore darkens its first corner by 0.25.
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail MD3 consumes preceding 2D vertex colors through real prepared CPU/GL views", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const retail = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const source = new TextEncoder().encode("tess-head { { map models/players/sarge/band.tga rgbGen exactvertex alphaGen vertex } }");
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = { ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: path => path === "scripts/tess-proof.shader" ? Promise.resolve(source) : Promise.resolve(undefined) }, retail), has: path => path === "scripts/tess-proof.shader" || retail.has(path),
    list: prefix => [...retail.list(prefix), ...("scripts/tess-proof.shader".startsWith(prefix ?? "") ? ["scripts/tess-proof.shader"] : [])],
    read: async path => path === "scripts/tess-proof.shader" ? source : retail.read(path),
    readFileLength: path => path === "scripts/tess-proof.shader" ? source.byteLength : retail.readFileLength(path),
    readFileOptional: path => path === "scripts/tess-proof.shader" ? Promise.resolve(source) : retail.readFileOptional(path) };
  const { resources, queue, recording, cpu, gl } = await tessRenderer(reader, 320, 240, 1000);
  const model = await resources.registerModel("models/players/sarge/head.md3"), shader = await resources.registerShader("tess-head"), white = await resources.registerShaderNoMip("white");
  expect(model.kind).toBe("md3"); expect(shader).not.toBeNull(); expect(white).not.toBeNull();
  const head = { ...createModelEntity(model), origin: vec3(20, 0, -6), axis: anglesToAxis(vec3(0, 180, 0)), customShader: shader };
  const draw = queue.draw2D("pixels");
  draw.setColor(vec4(0.5, 0.25, 0.75, 1));
  for (let index = 0; index < 100; index++) draw.drawPic({ x: -4, y: -4, width: 1, height: 1 }, resources.picture(white));
  queue.addPreparedViews(resources.prepareFrame({ refdef: { ...cameraRefdef(camera, 320, 240), renderFlags: RDF_NOWORLDMODEL }, entities: [head] }));
  queue.submit(); const view = recording.trace().at(-1); if (view === undefined) throw new Error("missing head view");
  const vertices = view.batches.flatMap(batch => batch.vertices);
  expect(vertices.length).toBeGreaterThan(50); expect(vertices.length).toBeLessThan(400);
  expect(vertices.every(vertex => vertex.color.x === 127 / 255 && vertex.color.y === 63 / 255 && vertex.color.z === 191 / 255 && vertex.color.w === 1)).toBe(true);
  expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 10).length).toBeGreaterThan(500);
  const output = process.env["Q3_TESS_IMAGES"];
  if (output !== undefined) await Bun.write(`${output}.cpu.png`, encodePng(320, 240, cpu.pixels));
  if (gl !== null) {
    const pixels = gl.readPixels(); let maximum = 0, total = 0;
    for (const [index, value] of pixels.entries()) {
      const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("missing CPU head channel");
      const difference = Math.abs(value - expected); maximum = Math.max(maximum, difference); total += difference;
    }
    expect(maximum).toBeLessThanOrEqual(2); expect(total / pixels.length).toBeLessThan(0.05);
    if (output !== undefined) await Bun.write(`${output}.gl.png`, encodePng(320, 240, pixels));
  }
});
