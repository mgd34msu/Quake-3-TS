import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, test } from "bun:test";
import { AudioMixer } from "../src/audio/mixer.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3, vec4 } from "../src/core/math.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { MaterialRegistry, remapTimeOffset, rendererFloatTime, resolvedMaterial } from "../src/render/material-registry.ts";
import type { MaterialContent, MaterialLighting } from "../src/render/material-registry.ts";
import type { ShaderDefinition } from "../src/render/material.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createImageColorMappings } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";
import { finishFailedShader, finishImplicitShader, finishShader } from "../src/render/material-finish.ts";
import type { FinishLoadedImageMetadata } from "../src/render/material-finish.ts";
import { RendererResources } from "../src/render/world.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { createRailCoreEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture, solidTga } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";
import type { SourcePreparedViews } from "../src/render/commands.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function assets(files: ReadonlyMap<string, Uint8Array>): RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> {
  return withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: prefix => [...files.keys()].filter(name => prefix === undefined || name.startsWith(prefix)),
    read: async name => { const data = files.get(name); if (data === undefined) throw new Error(`missing fixture ${name}`); return data; } });
}
function first<T>(values: readonly T[]): T { const item = values[0]; if (item === undefined) throw new Error("fixture result missing"); return item; }
const lightmaps: readonly (readonly [number, number, number])[] = [[63, 0, 0], [0, 63, 0]];
const sameNameMap = renderBspFixture([{ shader: "old", lightmap: 0 }, { shader: "old", lightmap: 1 }], lightmaps);
const camera = { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) };
const white = vec4(255, 255, 255, 255);

function publishedImage(name = "fixture/image"): RendererImage {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images), target = new RenderTarget(images, [cpu]);
  cleanup.push(() => target.close());
  return publishTexture(images, { name, width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 0 });
}

async function renderer(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, width = 16, height = 16, paired = false, imageProfile: () => ImageUploadProfile = identityImageUploadProfile) {
  const images = new RendererImageCatalog();
  const window = paired ? SdlWindow.open({ title: "Material remap", width, height, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(width, height, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const settings = createRendererSettings(), clock = { milliseconds: () => 0 };
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, imageProfile);
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); window?.close(); });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: imageProfile().colorMappings.identityLight, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  function submit(prepare: SourcePreparedViews) {
    const start = recording.trace().length;
    commands.addPreparedViews(prepare); commands.submit();
    return recording.trace().slice(start);
  }
  function pixel(x: number, y: number): Uint8Array {
    const offset = (y * width + x) * 4;
    return cpu.pixels.slice(offset, offset + 4);
  }
  return { resources, commands, cpu, gl, recording, builtins, submit, pixel };
}

function materialContent(name: string, lighting: MaterialLighting, image: RendererImage, definition: ShaderDefinition | null, defaulted = false): MaterialContent {
  const profile = createRendererSettings().registrationProfile(), whiteImage = image;
  const loaded = (texture: RendererImage, tmu: 0 | 1): FinishLoadedImageMetadata => ({ kind: "loaded", tmu,
    binding: { kind: "images", playback: { kind: "single", image: { image: texture } } } });
  const lightmapIndex = lighting.kind === "lightmap" ? lighting.index : lighting.kind === "none" ? -1
    : lighting.kind === "white" ? -2 : lighting.kind === "vertex" ? -3 : -4;
  if (defaulted) return { definition, image, whiteImage, defaulted, sky: null, finished: finishFailedShader({ name, lightmapIndex, profile }) };
  if (definition !== null) return { definition, image, whiteImage, defaulted, sky: null, finished: finishShader({ definition, lightmapIndex,
    images: definition.stages.map(() => loaded(image, 0)), profile }) };
  const fields = { name, baseImage: loaded(image, 0), profile };
  const finished = lighting.kind === "lightmap" ? finishImplicitShader({ ...fields, kind: "lightmap", lightmapIndex: lighting.index, lightmapImage: loaded(lighting.image, 1) })
    : lighting.kind === "white" ? finishImplicitShader({ ...fields, kind: "white", whiteImage: loaded(whiteImage, 0) })
      : finishImplicitShader({ ...fields, kind: lighting.kind === "none" ? "dynamic" : lighting.kind });
  return { definition, image, whiteImage, defaulted, sky: null, finished };
}

test("failed public registration stays zero while named failure remains cached, and default pictures retain their source stage state", async () => {
  const imageProfile = (): ImageUploadProfile => ({ ...identityImageUploadProfile(),
    colorMappings: createImageColorMappings({ gamma: 1, intensity: 1, requestedOverbrightBits: 1,
      deviceSupportsGamma: true, isFullscreen: true, colorBits: 32 }) });
  const { resources, commands, recording } = await renderer(assets(new Map<string, Uint8Array>()), 16, 16, false, imageProfile);
  expect(await resources.registerShader("missing")).toBeNull();
  const diagnostics = resources.diagnostics;
  expect(await resources.registerShaderNoMip("missing.tga")).toBeNull();
  expect(resources.diagnostics).toEqual(diagnostics);
  expect(await resources.registerShader("")).toBeNull();
  expect(await resources.registerShader("a".repeat(64))).toBeNull();
  const picture = resources.picture(null);
  expect(resources.picture(null)).toBe(picture);
  const draw = commands.draw2D("pixels");
  draw.setColor(vec4(0, 0, 0, 0)); draw.drawPic({ x: 0, y: 0, width: 16, height: 16 }, picture);
  commands.submitFrame();
  const evaluated = first(recording.trace().flatMap(view => view.batches));
  // R_SetColorMappings with one overbright bit feeds ComputeColors 127 RGB; AGEN_IDENTITY restores 255 alpha.
  expect(evaluated.vertices[0]?.color).toEqual({ x: 127 / 255, y: 127 / 255, z: 127 / 255, w: 1 });
  // CreateInternalShaders uses GLS_DEFAULT, not implicit LIGHTMAP_2D blend/depth defaults.
  expect(evaluated.state.depthTest).toBe("less-equal"); expect(evaluated.state.depthWrite).toBe(true);
  expect(evaluated.state.blend).toEqual({ source: "one", destination: "zero" });
});

test("internal stencil marker is registered before external shaders and remaps retain source identity", async () => {
  const image = publishedImage();
  const registry = new MaterialRegistry(async (name, lighting) => materialContent(name, lighting, image, null), text => { throw new Error(text); });
  const fallback = await registry.register("*default", { kind: "none" });
  const shadow = registry.registerStencilShadow(fallback);
  const ordinary = await registry.register("external", { kind: "none" });
  expect([fallback.order, shadow.order, ordinary.order]).toEqual([0, 1, 2]);
  expect(shadow.kind).toBe("stencil-shadow"); expect(shadow.sort).toBe(14);
  expect(shadow.finished.sourceStages).toBe(fallback.finished.sourceStages);
  expect(registry.find("<stencil shadow>")).toBe(shadow);
  expect(await registry.register("<stencil shadow>", { kind: "none" })).toBe(shadow);
  registry.remap("external", shadow, null);
  expect(resolvedMaterial(ordinary)).toBe(shadow);
  registry.remap("<stencil shadow>", fallback, null);
  expect(resolvedMaterial(shadow)).toBe(fallback);
  expect(resolvedMaterial(ordinary)).toBe(shadow);
});

test("identity detail picture preserves source filter blend and ignores SetColor on CPU and actual GL", async () => {
  const script = "detail { { map detail.tga blendFunc GL_DST_COLOR GL_SRC_COLOR rgbGen identity } }";
  const paired = process.env["QUAKE_GL_TEST"] === "1";
  const { resources, commands, cpu, gl, recording } = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)], ["detail.tga", solidTga(64, 64, 64)]])), 16, 16, paired);
  const shader = await resources.registerShader("detail"); expect(shader).not.toBeNull();
  const picture = resources.picture(shader), draw = commands.draw2D("pixels");
  const background = vec4(64 / 255, 32 / 255, 16 / 255, 1);
  commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: background, depth: 1 }, operations: [] });
  draw.setColor(vec4(0, 0, 0, 0)); draw.stretchPic({ x: 0, y: 0, width: 16, height: 16 }, { s: 0, t: 0, s2: 2.5, t2: 2 }, picture);
  commands.submitFrame();
  expect(first(recording.trace().flatMap(view => view.batches)).vertices[0]?.color).toEqual(vec4(1, 1, 1, 1));
  expect(cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)).toEqual(new Uint8Array([128, 64, 32, 255]));
  if (gl !== null) expect(gl.readPixels()).toEqual(cpu.pixels);
  draw.drawPic({ x: -16, y: -16, width: 1, height: 1 }, resources.picture(null)); commands.submit();
  commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: background, depth: 1 }, operations: [] });
  draw.stretchPic({ x: 0, y: 0, width: 16, height: 16 }, { s: 0, t: 0, s2: 2.5, t2: 2 }, picture); commands.submitFrame();
  expect(cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)).toEqual(new Uint8Array([32, 16, 8, 255]));
  if (gl !== null) expect(gl.readPixels()).toEqual(cpu.pixels);
});

test("material lookup keys include map owner and finished lightmap mode, while first mip request wins", async () => {
  const definition = first(parseShaderScript("explicit { { map $whiteimage } }"));
  const image = publishedImage("lookup/image");
  const registry = new MaterialRegistry(async (name, lighting) => materialContent(name, lighting, image, name === "explicit" ? definition : null, name === "missing"), text => { throw new Error(text); });
  const map = parseBsp(sameNameMap), other = parseBsp(sameNameMap);
  const a = await registry.register("wall.tga", { kind: "lightmap", owner: map, index: 0, image });
  expect(await registry.register("WALL.jpg", { kind: "lightmap", owner: map, index: 0, image })).toBe(a);
  expect(await registry.register("wall", { kind: "lightmap", owner: map, index: 1, image })).not.toBe(a);
  expect(await registry.register("wall", { kind: "lightmap", owner: other, index: 0, image })).not.toBe(a);
  const explicit = await registry.register("explicit", { kind: "lightmap", owner: map, index: 0, image });
  expect(explicit.lighting.kind).toBe("none");
  expect(await registry.register("explicit", { kind: "none" })).toBe(explicit);
  expect(await registry.register("explicit", { kind: "lightmap", owner: map, index: 0, image })).not.toBe(explicit);
  const picture = await registry.register("pic", { kind: "picture" }, false);
  expect(await registry.register("pic", { kind: "picture" }, true)).toBe(picture); expect(picture.mip).toBe(false);
  const failed = await registry.register("missing", { kind: "none" });
  expect(await registry.register("missing", { kind: "picture" })).toBe(failed);
});

test("source one-hop remap updates all current name records, self clears, later registrations stay independent, and null preserves target offset", async () => {
  const image = publishedImage("remap/image");
  const registry = new MaterialRegistry(async (name, lighting) => materialContent(name, lighting, image, null), text => { throw new Error(text); });
  const a = await registry.register("a", { kind: "none" }), a2 = await registry.register("a", { kind: "picture" });
  const b = await registry.register("b", { kind: "none" }), c = await registry.register("c", { kind: "none" });
  registry.remap("a.tga", b, " .125tail"); registry.remap("b", c, "2");
  expect(resolvedMaterial(a)).toBe(b); expect(resolvedMaterial(a2)).toBe(b); expect(resolvedMaterial(b)).toBe(c);
  const later = await registry.register("a", { kind: "vertex" }); expect(later.remapped).toBeNull();
  registry.remap("a", b, null); expect(b.timeOffset).toBe(0.125);
  registry.remap("a", a2, null); expect(a2.remapped).toBeNull(); expect(resolvedMaterial(a)).toBe(a2);
  expect(a.sort).toBe(3); expect(a2.sort).toBe(9);
  expect(remapTimeOffset("nonnumeric")).toBe(0); expect(remapTimeOffset(" -0x1.8p+2junk")).toBe(-6);
  expect(remapTimeOffset("1e100")).toBe(Infinity);
  expect(remapTimeOffset("-inf")).toBe(-Infinity);
  expect(remapTimeOffset("nan(payload)")).toBeNaN();
  expect(Object.is(remapTimeOffset("-0x0p0"), -0)).toBe(true);
  expect(rendererFloatTime(16777217)).toBe(Math.fround(Math.fround(16777217) * Math.fround(0.001)));
});

test("world remaps replace actual bound lightmaps across every original index and keep original sort", async () => {
  const script = "old { { map $lightmap } } target { sort blend { map $lightmap } }";
  const bsp = renderBspFixture([{ shader: "old", lightmap: 0 }, { shader: "target", lightmap: 1 }], lightmaps);
  const paired = process.env["QUAKE_GL_TEST"] === "1";
  const rendered = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)], ["maps/test.bsp", bsp]])), 64, 64, paired);
  const { resources, commands, cpu, gl, submit } = rendered;
  const world = await resources.loadWorld("test"), refdef = cameraRefdef(camera, 64, 64);
  commands.addView({ viewport: { x: 0, y: 0, width: 64, height: 64 }, clear: { stencil: false, color: vec4(0, 0, 0, 1), depth: 1 }, operations: [] });
  const initialViews = submit(world.prepareFrame({ refdef })), initial = initialViews.flatMap(view => view.batches);
  const initialTexture = first(initial).texture;
  if (initialTexture.kind !== "bind-image") throw new Error("initial lightmap binding missing");
  expect(rendered.pixel(44, 32)).toEqual(new Uint8Array([252, 0, 0, 255]));
  await resources.remapShader("old", "target", null);
  commands.addView({ viewport: { x: 0, y: 0, width: 64, height: 64 }, clear: { stencil: false, color: vec4(0, 0, 0, 1), depth: 1 }, operations: [] });
  const remappedViews = submit(world.prepareFrame({ refdef })), remapped = remappedViews.flatMap(view => view.batches);
  expect(remapped).toHaveLength(2);
  const targetBinding = initial[1]?.texture;
  if (targetBinding?.kind !== "bind-image") throw new Error("target lightmap binding missing");
  expect(remapped.every(batch => batch.texture.kind === "bind-image" && batch.texture.image === targetBinding.image)).toBe(true);
  expect(first(remapped).vertices[0]?.position.w).toBe(32);
  expect(rendered.pixel(44, 32)).toEqual(new Uint8Array([0, 252, 0, 255]));
  if (gl !== null) expect(gl.readPixels()).toEqual(cpu.pixels);

  const fallback = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)], ["maps/test.bsp", sameNameMap]])), 64, 64);
  const allWorld = await fallback.resources.loadWorld("test");
  await fallback.resources.registerShader("target");
  await fallback.resources.remapShader("old", "target", null);
  const whiteBatches = fallback.submit(allWorld.prepareFrame({ refdef })).flatMap(view => view.batches);
  expect(whiteBatches).toHaveLength(2);
  const whiteTexture = first(whiteBatches).texture;
  if (whiteTexture.kind !== "bind-image") throw new Error("source lightmap fallback needs the registered white image");
  const builtinWhite = fallback.builtins.find("*white");
  if (builtinWhite === undefined) throw new Error("Missing renderer white image");
  expect(whiteTexture.image.sourceWidth).toBe(8); expect(whiteTexture.image.sourceHeight).toBe(8);
  expect(whiteTexture.image).toBe(builtinWhite.image);
  expect(whiteBatches.every(batch => batch.texture.kind === "bind-image" && batch.texture.image === whiteTexture.image)).toBe(true);
});

test("source area mask suppresses its leaf surfaces and no-world suppresses all BSP geometry", async () => {
  const { resources, submit } = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode("old { { map $lightmap } }")], ["maps/test.bsp", sameNameMap]])), 64, 64);
  const world = await resources.loadWorld("test"), refdef = cameraRefdef(camera, 64, 64);
  expect(submit(world.prepareFrame({ refdef })).flatMap(view => view.batches)).toHaveLength(2);
  refdef.areaMask[0] = 2;
  expect(submit(world.prepareFrame({ refdef })).flatMap(view => view.batches)).toHaveLength(1);
  refdef.renderFlags = RDF_NOWORLDMODEL;
  expect(submit(world.prepareFrame({ refdef })).flatMap(view => view.batches)).toHaveLength(0);
});

test("entity-mergable remap flushes all geometry stage-by-stage using the final entity clock", async () => {
  const { resources, submit } = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(
    "old { entityMergable { map $whiteimage } } target { clampTime 0.1 { map $whiteimage tcMod scroll 0.125 0\n } { map $whiteimage blendFunc add } }")]])));
  const shader = await resources.registerShader("old"); await resources.registerShader("target");
  await resources.remapShader("old", "target", "0.5");
  const refdef = { ...cameraRefdef(camera, 16, 16, 10000), renderFlags: RDF_NOWORLDMODEL };
  const sprite = { ...createSpriteEntity(), origin: vec3(20, 0, 0), radius: 4, customShader: shader, shaderRGBA: white };
  const batches = submit(resources.prepareFrame({ refdef, entities: [{ ...sprite, shaderTime: 2 }, { ...sprite, shaderTime: 3 }] })).flatMap(view => view.batches);
  expect(batches).toHaveLength(2); expect(batches[0]?.vertices).toHaveLength(8);
  expect(batches[0]?.vertices[0]?.texCoord.x).toBe(0.8125);
  expect(batches[0]?.vertices[4]?.texCoord.x).toBe(0.8125);
});

test("fresh missing remap target leaves original intact, while source cached named failures remain distinct from global default", async () => {
  const { resources, submit } = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode("old { { map $whiteimage } }")]])));
  const shader = await resources.registerShader("old");
  const refdef = { ...cameraRefdef(camera, 16, 16), renderFlags: RDF_NOWORLDMODEL };
  const sprite = { ...createSpriteEntity(), origin: vec3(20, 0, 0), radius: 4, customShader: shader, shaderRGBA: white };
  const frame = () => submit(resources.prepareFrame({ refdef, entities: [sprite] })).flatMap(view => view.batches);
  await resources.remapShader("old", "missing", null); expect(frame()).toHaveLength(1);
  expect(resources.diagnostics).toContain("WARNING: R_RemapShader: new shader missing not found");
  await resources.remapShader("old", "missing", null); expect(frame()).toHaveLength(0);
});

test("actual scene tess overflow changes the one-hop target and rail alpha retains prior sprite attributes", async () => {
  const script = "a { entityMergable { map $whiteimage } } b { { map $whiteimage rgbGen const ( 1 0 0 ) } } c { { map $whiteimage rgbGen const ( 0 1 0 ) alphaGen vertex } }";
  const { resources, submit } = await renderer(assets(new Map([["scripts/test.shader", new TextEncoder().encode(script)]])));
  const shader = await resources.registerShader("a");
  await resources.remapShader("a", "b", null); await resources.remapShader("b", "c", null);
  const refdef = { ...cameraRefdef(camera, 16, 16), renderFlags: RDF_NOWORLDMODEL };
  const sprite = { ...createSpriteEntity(), origin: vec3(20, 0, 0), radius: 4, customShader: shader, shaderRGBA: white };
  const entities = Array.from({ length: 250 }, () => ({ ...sprite }));
  const batches = submit(resources.prepareFrame({ refdef, entities })).flatMap(view => view.batches);
  expect(batches.map(batch => batch.vertices.length)).toEqual([996, 4]);
  expect(batches[0]?.vertices[0]?.color).toEqual(vec4(1, 0, 0, 1));
  expect(batches[1]?.vertices[0]?.color).toEqual(vec4(0, 1, 0, 1));
  const rail = { ...createRailCoreEntity(), origin: vec3(20, 0, 0), oldOrigin: vec3(20, 10, 0), customShader: shader, shaderRGBA: white };
  const railFrame = () => submit(resources.prepareFrame({ refdef, entities: Array.from({ length: 250 }, () => ({ ...rail, shaderRGBA: vec4(255, 255, 255, 0) })) })).flatMap(view => view.batches);
  const firstRails = railFrame();
  expect(firstRails.map(batch => batch.vertices.length)).toEqual([996, 4]);
  expect(firstRails[0]?.vertices[0]?.color).toEqual(vec4(1, 0, 0, 1));
  expect(firstRails[1]?.vertices[0]?.color).toEqual(vec4(0, 1, 0, 1));
  // RB_AddQuadStampExt writes alpha; DoRailCore writes RGB only. AGEN_VERTEX
  // reads that retained vertexColors alpha, not the rail entity's current zero.
  submit(resources.prepareFrame({ refdef, entities: entities.map(entity => ({ ...entity, shaderRGBA: vec4(255, 255, 255, 47) })) }));
  const retainedRails = railFrame();
  expect(retainedRails.map(batch => batch.vertices.length)).toEqual([996, 4]);
  expect(retainedRails[0]?.vertices[0]?.color).toEqual(vec4(1, 0, 0, 1));
  for (const vertex of first(retainedRails.slice(1)).vertices) expect(vertex.color).toEqual({ x: 0, y: 1, z: 0, w: 47 / 255 });
});

test("cached pictures observe remaps on both CPU and actual GL without a second image cache", async () => {
  const paired = process.env["QUAKE_GL_TEST"] === "1";
  const rendered = await renderer(assets(new Map([["red.tga", solidTga(255, 0, 0)], ["green.tga", solidTga(0, 255, 0)]])), 16, 16, paired);
  const { resources, commands, cpu, gl, recording } = rendered;
  const a = await resources.registerShaderNoMip("red"), b = await resources.registerShaderNoMip("green");
  if (a === null || b === null) throw new Error("Fixture image registration failed");
  const picture = resources.picture(a), target = resources.picture(b);
  const draw = commands.draw2D("pixels");
  draw.stretchPic({ x: 0, y: 0, width: 16, height: 16 }, { s: 0.5, t: 0.5, s2: 0.5, t2: 0.5 }, picture); commands.submit();
  expect(cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
  draw.setColor(null);
  draw.drawPic({ x: -16, y: -16, width: 1, height: 1 }, resources.picture(null)); commands.submit();
  draw.stretchPic({ x: 0, y: 0, width: 16, height: 16 }, { s: 0.5, t: 0.5, s2: 0.5, t2: 0.5 }, picture);
  await resources.remapShader("red", "green", null);
  expect(resources.picture(a)).toBe(picture);
  commands.submitFrame();
  const remappedBatch = recording.trace().flatMap(view => view.batches).at(-1);
  if (remappedBatch === undefined) throw new Error("Remapped cached picture did not draw");
  const remappedTexture = remappedBatch.texture;
  const targetBundle = target.material.finished.iterator.passes[0]?.bundles[0];
  if (targetBundle === undefined || !targetBundle.active || targetBundle.binding.kind !== "images" || targetBundle.binding.playback.kind !== "single") {
    throw new Error("target remap image missing");
  }
  expect(remappedTexture.kind === "bind-image" ? remappedTexture.image : null).toBe(targetBundle.binding.playback.image.image);
  expect(cpu.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)).toEqual(new Uint8Array([0, 255, 0, 255]));
  if (gl !== null) expect(gl.readPixels()).toEqual(cpu.pixels);
});

test("duplicate world loads preserve active remap fallback", async () => {
  const green = renderBspFixture([{ shader: "world/green", lightmap: 0 }, { shader: "world/green", lightmap: 0 }], [[0, 63, 0], [63, 0, 0]]);
  const base = assets(new Map([["maps/green.bsp", green], ["world/green.tga", solidTga(255, 255, 255)],
    ["fallback1.tga", solidTga(255, 255, 255)], ["fallback2.tga", solidTga(255, 255, 255)], ["scripts/test.shader", new TextEncoder().encode("anchor { { map $whiteimage } }")]]));
  const worldReads: string[] = [];
  const rendered = await renderer(withRetainedFiles({ ...base, readFileOptional: name => {
    if (name.startsWith("maps/")) worldReads.push(name);
    return base.readFileOptional(name);
  } }));
  const { resources, submit } = rendered;
  const shader = await resources.registerShader("anchor"), world = await resources.loadWorld("green");
  expect(worldReads).toEqual(["maps/green.bsp"]);
  expect(await resources.registerModel("*0")).toBe(world.inlineModel(0));
  const refdef = { ...cameraRefdef(camera, 16, 16), renderFlags: RDF_NOWORLDMODEL };
  const sprite = { ...createSpriteEntity(), origin: vec3(20, 0, 0), radius: 4, customShader: shader, shaderRGBA: white };
  const frame = () => submit(resources.prepareFrame({ refdef, entities: [sprite] })).flatMap(view => view.batches);
  await resources.remapShader("anchor", "fallback1", null);
  const firstRemap = first(frame()); if (firstRemap.texturing !== "pair") throw new Error("source implicit lightmap must collapse into paired bundles");
  if (firstRemap.secondTexture.binding.kind !== "bind-image") throw new Error("first remap lightmap missing");
  const winningLightmap = firstRemap.secondTexture.binding.image;
  expect(winningLightmap.name).toContain("lightmap");
  expect(rendered.pixel(8, 8)).toEqual(new Uint8Array([0, 252, 0, 255]));
  const failedWorld = resources.loadWorld("missing");
  await expect(failedWorld).rejects.toBeInstanceOf(CommonError);
  await expect(failedWorld).rejects.toMatchObject({ code: "drop", message: "ERROR: attempted to redundantly load world map\n" });
  expect(worldReads).toEqual(["maps/green.bsp"]);
  expect(await resources.registerModel("*0")).toBe(world.inlineModel(0));
  await resources.remapShader("anchor", "fallback2", null);
  const secondRemap = first(frame()); if (secondRemap.texturing !== "pair") throw new Error("source implicit lightmap must collapse into paired bundles");
  if (secondRemap.secondTexture.binding.kind !== "bind-image") throw new Error("second remap lightmap missing");
  expect(secondRemap.secondTexture.binding.image).toBe(winningLightmap);
  expect(rendered.pixel(8, 8)).toEqual(new Uint8Array([0, 252, 0, 255]));
});
