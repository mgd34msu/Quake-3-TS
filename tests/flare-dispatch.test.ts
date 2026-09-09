import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { dot3 } from "../src/core/math.ts";
import type { Mat4 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { SourcePreparedViews } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createModelEntity, createSpriteEntity, RF_DEPTHHACK } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import type { RenderView } from "../src/render/types.ts";
import { RendererResources } from "../src/render/world.ts";
import { viewProjection } from "../src/render/view.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture, solidTga } from "./render-bsp-fixture.ts";
import { BatchRecordingBackend, recordPreparedViews } from "./render-target-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function flareBsp(onlyFlares = false, inlineFlareOnly = false): Uint8Array {
  const bytes = renderBspFixture([
    { shader: onlyFlares ? "test/flare" : "test/plain", lightmap: -1 },
    { shader: "test/flare", lightmap: -1 },
  ], []);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shaders = data.getInt32(8 + 1 * 8, true), surfaces = data.getInt32(8 + 13 * 8, true);
  data.setInt32(shaders + (onlyFlares ? 0 : 72) + 64, 0x80, true);
  for (const index of onlyFlares ? [0, 1] : [1]) {
    const offset = surfaces + index * 104;
    data.setInt32(offset + 4, 0, true); // Source mpteam1 also retains flare fog 0 without a fog lump.
    data.setInt32(offset + 8, 4, true);
    data.setInt32(offset + 16, 0, true);
    data.setInt32(offset + 24, 0, true);
  }
  if (inlineFlareOnly) {
    const leaves = data.getInt32(8 + 4 * 8, true), models = data.getInt32(8 + 7 * 8, true);
    data.setInt32(leaves + 48 + 36, 0, true);
    data.setInt32(models + 24, 1, true); data.setInt32(models + 28, 1, true);
  }
  return bytes;
}

async function fixture(portal = false, onlyFlares = false, native = false, inlineFlareOnly = false, singleBackend = false) {
  const files = new Map<string, Uint8Array>([
    ["maps/flare.bsp", flareBsp(onlyFlares, inlineFlareOnly)],
    ["scripts/flare.shader", new TextEncoder().encode(`
      test/plain { cull none { map $whiteimage rgbGen identity } }
      test/flare { ${portal ? "portal" : "sort additive"} cull none { map $whiteimage rgbGen identity } }
      test/sprite { cull none { map $whiteimage rgbGen vertex } }
      ${singleBackend ? "flareShader { cull none { map flareShader.tga rgbGen vertex blendFunc add } }" : ""}
    `)],
    ["projectionShadow.tga", solidTga(10, 20, 30)], ["flareShader.tga", solidTga(30, 20, 10)],
  ]);
  const reads: string[] = [];
  const reader: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => files.get(path)?.byteLength ?? -1,
    readFileOptional: async path => { const bytes = files.get(path); if (bytes !== undefined) reads.push(path); return bytes; },
    has: path => files.has(path),
    list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => { const bytes = files.get(path); if (bytes === undefined) throw new Error(`Missing ${path}`); reads.push(path); return bytes; } });
  const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux");
  const images = new RendererImageCatalog();
  const window = native ? SdlWindow.open({ title: "Source empty flare dispatch", width: 64, height: 64, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(64, 64, images, gl?.subpixelBits), recorder = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, singleBackend ? [gl ?? cpu] : gl === null ? [recorder] : [recorder, gl]);
  const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true });
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const mixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const create = spyOn(images, "createUploaded");
  cleanup.push(() => { create.mockRestore(); try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(reader, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics, imageProfile: identityImageUploadProfile });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  const world = await resources.loadWorld("flare");
  const refdef = cameraRefdef({ origin: { x: 0, y: -12, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 64, 64, 2000);
  function submit(prepare: SourcePreparedViews): readonly RenderView[] {
    const prepared: RenderView[] = [];
    commands.addView({ viewport: { x: 0, y: 0, width: 64, height: 64 }, clear: { depth: 1, color: { x: 0, y: 0, z: 0, w: 1 }, stencil: false }, operations: [] });
    commands.addPreparedViews(drawSurfs => recordPreparedViews(prepare(drawSurfs), prepared)); commands.submit(); return prepared;
  }
  return { resources, world, refdef, submit, cpu, gl, create, reads, files, cvars, recorder, commands, images };
}

test("source external flareShader registers after projectionShadow with no-lightmap mipmapped image effects", async () => {
  const { resources, create, reads } = await fixture();
  expect(create.mock.calls.slice(0, 2).map(call => ({ name: call[0].name, mipmap: call[0].mipmap, wrap: call[0].sampling.wrap }))).toEqual([
    { name: "projectionShadow.tga", mipmap: true, wrap: "repeat" },
    { name: "flareShader.tga", mipmap: true, wrap: "repeat" },
  ]);
  expect(reads.indexOf("flareShader.tga")).toBeGreaterThan(reads.indexOf("projectionShadow.tga"));
  await resources.registerShaderNoMip("flareShader");
  expect(create.mock.calls.filter(call => call[0].name === "flareShader.tga")).toHaveLength(1);
  expect(resources.diagnostics).toContain("WARNING: reused image flareShader.tga with mixed mipmap parm");
});

for (const native of [false, true]) test.skipIf(native && process.env["QUAKE_GL_TEST"] !== "1")(
  `${native ? "CPU and GL" : "CPU"} empty world and inline flares retain sorted state without geometry`, async () => {
    const f = await fixture(false, false, native), { resources, world, refdef } = f;
    const dynamicLights = [{ origin: { x: 32, y: -12, z: 0 }, color: { x: 1, y: 0, z: 0 }, radius: 100 }];
    const first = f.submit(world.prepareFrame({ refdef, dynamicLights }));
    expect(first).toHaveLength(1);
    expect(first[0]?.operations.every(operation => operation.kind !== "entity-axis" && operation.kind !== "entity-beam")).toBe(true);
    expect(resources.tess.material?.name).toBe("test/flare");
    expect(resources.tess.material?.lighting.kind).toBe("vertex");
    expect(resources.tess.fog).toBe(1); expect(resources.tess.dlightBits).toBe(0);
    expect([resources.tess.numVertexes, resources.tess.numIndexes]).toEqual([0, 0]);
    expect(resources.diagnostics).not.toContain("flare surfaces are not implemented");
    const pixels = new Uint8Array(f.cpu.pixels), glPixels = f.gl === null ? null : f.gl.readPixels();
    f.cvars.set("r_flares", "1");
    const second = f.submit(world.prepareFrame({ refdef, dynamicLights }));
    const drawn = (views: readonly RenderView[]) => views.flatMap(view => view.operations)
      .filter(operation => operation.kind !== "begin-generic-iterator" && operation.kind !== "render-flares");
    expect(drawn(second)).toEqual(drawn(first));
    expect(second[0]?.operations.at(-1)?.kind).toBe("render-flares");
    expect(resources.performance.backEnd.c_flareAdds).toBe(0);
    expect(resources.performance.backEnd.c_flareTests).toBe(0);
    expect(f.cpu.pixels).toEqual(pixels);
    if (f.gl !== null && glPixels !== null) expect(f.gl.readPixels()).toEqual(glPixels);
    const inlineFixture = await fixture(false, false, native, true);
    const inlineWorld = inlineFixture.world, inlineResources = inlineFixture.resources;
    const inline = createModelEntity(inlineWorld.inlineModel(0));
    inline.axis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
    inline.renderFlags = RF_DEPTHHACK; inline.shaderTime = 0.25;
    const views = inlineFixture.submit(inlineWorld.prepareFrame({ refdef, entities: [inline], dynamicLights }));
    const operations = views.flatMap(view => view.operations);
    expect(operations.filter(operation => operation.kind === "depth-range").map(operation => operation.range)).toEqual([[0, 0.3], [0, 1]]);
    expect(operations.slice(-3).map(operation => operation.kind)).toEqual(["depth-range", "depth-range", "render-flares"]);
    expect(operations.some(operation => operation.kind === "entity-axis" || operation.kind === "entity-beam")).toBe(false);
    expect(inlineResources.tess.material?.name).toBe("test/flare"); expect(inlineResources.tess.fog).toBe(1);
    const retainedEntity = inlineResources.tess.context.entity;
    if (retainedEntity?.kind !== "model") throw new Error("Inline flare did not select its model entity");
    expect(retainedEntity.shaderTime).toBe(0.25);
    expect(inlineResources.tess.shaderTime).toBe(1.75); expect(inlineResources.tess.floatTime).toBe(2);
    expect(inlineResources.tess.actualDepthRange).toEqual([0, 1]); expect(inlineResources.tess.dlightBits).toBe(0);
  });

test("portal-sorted flares begin an empty surface and do not dispatch the retained sprite", async () => {
  const f = await fixture(true, true), { resources, world, refdef } = f;
  const first = f.submit(world.prepareFrame({ refdef }));
  expect(first).toHaveLength(1); expect(first[0]?.beforeView ?? []).toEqual([]); expect(first[0]?.operations.map(operation => operation.kind)).toEqual(["render-flares"]);
  const sprite = createSpriteEntity(); sprite.origin = { x: 16, y: -12, z: 0 }; sprite.radius = 3;
  sprite.shaderRGBA = { x: 21, y: 43, z: 65, w: 255 }; sprite.customShader = await resources.registerShader("test/sprite");
  f.submit(resources.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL }, entities: [sprite] }));
  const retained = resources.tess.textQuad(), begin = spyOn(resources.tess, "beginSurface");
  try {
    const prepare = world.prepareFrame({ refdef });
    expect(begin.mock.calls.filter(call => call[0].name === "test/flare").map(call => call[1])).toEqual([1, 1]);
    const views = f.submit(prepare);
    expect(begin.mock.calls.filter(call => call[0].name === "test/flare").map(call => call[1])).toEqual([1, 1, 1]);
    expect(views).toHaveLength(1); expect(views[0]?.beforeView ?? []).toEqual([]); expect(views[0]?.operations.map(operation => operation.kind)).toEqual(["render-flares"]);
    expect(resources.tess.textQuad()).toEqual(retained);
    expect([resources.tess.numVertexes, resources.tess.numIndexes]).toEqual([0, 0]);
    expect(resources.tess.fog).toBe(1);
  } finally { begin.mockRestore(); }
});

function seedFlare(f: Awaited<ReturnType<typeof fixture>>, scene: number): void {
  const { refdef } = f, [forward, left, up] = refdef.viewAxis;
  const matrix: Mat4 = [-left.x, up.x, -forward.x, 0, -left.y, up.y, -forward.y, 0, -left.z, up.z, -forward.z, 0,
    dot3(refdef.viewOrigin, left), -dot3(refdef.viewOrigin, up), dot3(refdef.viewOrigin, forward), 1];
  f.resources.tess.flares.addFlare({}, 0, { x: 32, y: -12, z: 0 }, { x: 1, y: 1, z: 1 }, null,
    { frameCount: f.images.frameCount, frameSceneNum: scene, inPortal: false, time: refdef.time, origin: refdef.viewOrigin,
      projection: viewProjection(refdef, 2048), viewport: { x: refdef.x, y: 64 - refdef.y - refdef.height, width: refdef.width, height: refdef.height } }, matrix);
  f.cvars.set("r_flares", "1"); f.cvars.set("r_flareFade", "1000", true);
}

for (const native of [false, true]) test.skipIf(native && process.env["QUAKE_GL_TEST"] !== "1")(
  `${native ? "GL" : "CPU"} queued flare tail reads actual prior depth and renders through retained source tess`, async () => {
    const f = await fixture(false, false, native, false, true), backend = f.gl ?? f.cpu;
    seedFlare(f, 1); f.cvars.set("r_finish", "1", true);
    const read = backend.readDepthPixel.bind(backend), depths: number[] = [], phases: string[] = [];
    const finish = spyOn(backend, "finish"), depth = spyOn(backend, "readDepthPixel").mockImplementation((x, y) => {
      expect(finish).toHaveBeenCalledTimes(1);
      expect([x, y]).toEqual([32, 32]);
      phases.push("read"); const value = read(x, y); depths.push(value); return value;
    });
    cleanup.push(() => { depth.mockRestore(); finish.mockRestore(); });
    const views = f.submit(f.world.prepareFrame({ refdef: f.refdef }));
    expect(views[0]?.operations.at(-1)?.kind).toBe("render-flares");
    expect(depths).toHaveLength(1); expect(depths[0]).toBeGreaterThan(0); expect(depths[0]).toBeLessThan(1);
    expect(phases).toEqual(["read"]);
    expect(f.resources.tess.material?.name).toBe("flareShader");
    expect([f.resources.tess.numVertexes, f.resources.tess.numIndexes]).toEqual([4, 0]);
    expect(f.resources.performance.backEnd.c_flareTests).toBe(1);
    expect(f.resources.performance.backEnd.c_flareRenders).toBe(1);
    const pixels = f.gl === null ? f.cpu.pixels : f.gl.readPixels();
    const edge = (32 * 64 + 17) * 4;
    expect([...pixels.slice(edge, edge + 3)]).toEqual([30, 20, 10]);
    f.commands.submitFrame(); expect(finish).toHaveBeenCalledTimes(2);
  });

test("queued scene snapshots distinguish two scenes and collected live flares reject before tess mutation", async () => {
  const f = await fixture(false, true, false, false, true);
  seedFlare(f, 1); seedFlare(f, 2);
  const retained = f.resources.tess.textQuad();
  expect(() => f.world.frame({ refdef: f.refdef })).toThrow("Collected diagnostic frames cannot retain live flare state");
  expect(f.resources.tess.textQuad()).toEqual(retained); expect(f.resources.tess.flares.scenesRendered).toBe(0);
  f.commands.addPreparedViews(f.world.prepareFrame({ refdef: f.refdef }));
  f.commands.addPreparedViews(f.world.prepareFrame({ refdef: f.refdef }));
  expect(f.resources.tess.flares.scenesRendered).toBe(2);
  f.commands.submit();
  expect(f.resources.performance.backEnd.c_flareTests).toBe(2);
  expect(f.resources.performance.backEnd.c_flareRenders).toBe(2);
  const second = f.resources.tess.flares.activeHead;
  expect(second?.frameSceneNum).toBe(2); expect(second?.drawIntensity).toBe(1);
  expect(second?.next?.frameSceneNum).toBe(1); expect(second?.next?.drawIntensity).toBe(0);
  expect([...f.world.prepareFrame({ refdef: { ...f.refdef, width: 0 } })()]).toEqual([]);
  expect(f.resources.tess.flares.scenesRendered).toBe(3);
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("a reached flare depth query rejects shared CPU/GL state", async () => {
  const f = await fixture(false, true, true);
  seedFlare(f, 1);
  expect(() => f.submit(f.world.prepareFrame({ refdef: f.refdef }))).toThrow("Source flare depth queries require one backend");
  expect(f.resources.performance.backEnd.c_flareRenders).toBe(0);
});
