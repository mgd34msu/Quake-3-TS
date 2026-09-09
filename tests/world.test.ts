import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { BspMap, BspVertex } from "../src/assets/bsp.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { tessellatePatch } from "../src/render/patch.ts";
import { clusterVisible, RendererResources, pointInLeaf, shiftLighting } from "../src/render/world.ts";
import type { WorldCamera } from "../src/render/world.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SOURCE_HUNK_RELEASE32, SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { createModelEntity, createPortalEntity, createRailCoreEntity, createRailRingsEntity, createSpriteEntity, RF_DEPTHHACK, RF_FIRST_PERSON, RF_NOSHADOW, RF_THIRD_PERSON } from "../src/render/ref-entity.ts";
import type { RefPoly } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { anglesToAxis, cross3, normalize3, perpendicularVector, scale3, sub3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { byteToDirection, directionToByte } from "../src/shared/direction-byte.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import type { DrawBatch, ImmediateViewOperation, RenderView, SourceStageData, SourceGeometryAllocation, ViewOperation } from "../src/render/types.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { PreparedBackendDraw, PreparedBackendSourceDraw, RenderViewState, ResolvedTextureOperation, SourcePreparedViews } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend, recordPreparedViews } from "./render-target-fixture.ts";
import { renderBspFixture, solidTga } from "./render-bsp-fixture.ts";
import { viewProjection, viewProjector } from "../src/render/view.ts";
import { modelWorldPoint } from "../src/render/scene-models.ts";
import { skyVector } from "../src/render/sky.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class SurfaceRecordingBackend extends BatchRecordingBackend {
  readonly events: (ViewOperation | { readonly kind: "begin-view" })[] = [];
  readonly textures: ResolvedTextureOperation[] = [];
  override beginView(view: RenderViewState): undefined { super.beginView(view); this.events.push({ kind: "begin-view" }); }
  override drawImmediate(operation: ImmediateViewOperation): undefined { super.drawImmediate(operation); this.events.push(operation); }
  override prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const prepared = super.prepareGeometry(batch);
    return { ...prepared, applyTexture: (unit, operation) => { prepared.applyTexture(unit, operation); this.textures.push(operation); },
      draw: () => { prepared.draw(); this.events.push({ kind: "draw", batches: [batch] }); } };
  }
  override prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    const prepared = super.prepareSourceGeometry(stage, allocation);
    return { ...prepared, applyTexture: (unit, operation) => { prepared.applyTexture(unit, operation); this.textures.push(operation); },
      draw: primitives => { prepared.draw(primitives); this.events.push({ kind: "draw", batches: [stage.batch] }); } };
  }
}
function batchesBetweenDepthCalls(operations: readonly (ViewOperation | { readonly kind: "begin-view" })[], range: readonly [number, number]): readonly DrawBatch[] {
  return operations.flatMap((operation, index) => {
    if (operation.kind !== "depth-range" || operation.range[0] !== range[0] || operation.range[1] !== range[1]) return [];
    const following = operations.slice(index + 1);
    const nextDepthCall = following.findIndex(next => next.kind === "depth-range" || next.kind === "begin-view");
    return (nextDepthCall === -1 ? following : following.slice(0, nextDepthCall)).flatMap(next =>
      next.kind === "draw" ? next.batches : next.kind === "source-stage" || next.kind === "source-tess-stage" ? [next.stage.batch] : []);
  });
}
async function worldRenderer(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, memory: HunkAccountingProfile = { kind: "unaccounted" }, native = false, stencilBits = 0) {
  const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux");
  const images = new RendererImageCatalog();
  const window = native && process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Retail patch LOD", width: 320, height: 240, backend: "gl", stencilBits, hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), renderer = new SoftwareRenderer(320, 240, images, gl?.subpixelBits, gl?.stencilBits ?? stencilBits);
  const recording = new SurfaceRecordingBackend(renderer), target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true }), clock = { time: 0 };
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  if (memory.kind === "source-hunk") memory.accounting.initializeRendererBackend(settings.sceneLimits(), settings.runtime.smpRequested);
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: memory.kind === "source-hunk" ? memory.accounting.arena : new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => clock.time },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(files, memory, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, clock: { milliseconds: () => clock.time }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => clock.time }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  let preparedViews: RenderView[] = [];
  let retainedPrefix: readonly ViewOperation[] = [];
  let submittedEvents: readonly (ViewOperation | { readonly kind: "begin-view" })[] = [];
  function submit(prepare: SourcePreparedViews) {
    commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [] });
    const start = recording.trace().length + 1, eventStart = recording.events.length;
    commands.addPreparedViews(drawSurfs => { preparedViews = []; return recordPreparedViews(prepare(drawSurfs), preparedViews); }); commands.submit();
    submittedEvents = recording.events.slice(eventStart);
    const prefix: ViewOperation[] = [];
    for (const event of submittedEvents) { if (event.kind === "begin-view") break; prefix.push(event); }
    retainedPrefix = prefix;
    return recording.trace().slice(start);
  }
  return { resources, renderer, submit, clock, builtins, cvars, gl, commands, target, recording, cinematicMixer,
    get preparedViews() { return preparedViews; }, get retainedPrefix() { return retainedPrefix; }, get submittedEvents() { return submittedEvents; } };
}

function controlPoint(x: number, y: number, z: number): BspVertex {
  return { position: { x, y, z }, normal: { x: 0, y: 0, z: 1 }, texCoord: { x: x / 2, y: y / 2 },
    lightmapCoord: { x: x / 4, y: y / 4 }, color: { x: 101, y: 151, z: 201, w: 255 } };
}

function visibilityMap(): BspMap {
  const bounds = { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } };
  return {
    entities: "", entityRecords: [], shaders: [], planes: [{ normal: { x: 1, y: 0, z: 0 }, distance: 0 }],
    nodes: [{ plane: 0, children: [-1, -2], bounds }],
    leaves: [0, 1].map(cluster => ({ cluster, area: cluster, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 })),
    leafSurfaces: [], leafBrushes: [], models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [],
    lightmaps: [], lightGrid: [], visibility: { clusterCount: 2, bytesPerCluster: 1, bits: new Uint8Array([1, 3]) },
  };
}

test("source renderer performance counts frontend leaves and dlight rejects before deferred surfaces", async () => {
  const bsp = renderBspFixture([{ shader: "test/counters", lightmap: -1 }, { shader: "test/counters", lightmap: -1 }], []);
  const data = new DataView(bsp.buffer);
  // +1 addresses the first leaf in the combined source node allocation.
  data.setInt32(data.getInt32(8 + 3 * 8, true) + 8, 1, true);
  const files = new Map([
    ["maps/counters.bsp", bsp],
    ["scripts/counters.shader", new TextEncoder().encode("test/counters { cull none { map $whiteimage rgbGen identity } }")],
  ]);
  const { resources, submit, clock, cvars, commands } = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: () => [...files.keys()],
    read: async name => { const bytes = files.get(name); if (bytes === undefined) throw new Error(`missing counter fixture ${name}`); return bytes; },
  }));
  const world = await resources.loadWorld("counters"), performance = resources.performance;
  const refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  const dynamicLight = { origin: { x: 48, y: 0, z: 0 }, radius: 8, color: { x: 1, y: 1, z: 1 } };
  const prepared = world.prepareFrame({ refdef, dynamicLights: [dynamicLight] });
  expect(performance.frontEnd.c_leafs).toBe(2);
  expect([performance.frontEnd.c_dlightSurfaces, performance.frontEnd.c_dlightSurfacesCulled]).toEqual([0, 2]);
  expect(performance.viewCluster).toBe(0);
  expect(performance.zFar).toBe(Math.fround(Math.sqrt(96 * 96 + 64 * 64 + 64 * 64)));
  expect(performance.backEnd.c_surfaces).toBe(0);
  submit(prepared);
  expect(performance.frontEnd.c_leafs).toBe(2);
  expect(performance.backEnd.c_surfaces).toBe(2);
  expect([performance.backEnd.c_shaders, performance.backEnd.c_vertexes, performance.backEnd.c_indexes, performance.backEnd.c_totalIndexes]).toEqual([1, 8, 12, 12]);
  world.prepareFrame({ refdef, dynamicLights: [{ ...dynamicLight, radius: 20 }] });
  expect([performance.frontEnd.c_dlightSurfaces, performance.frontEnd.c_dlightSurfacesCulled]).toEqual([2, 2]);
  world.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL } });
  expect(performance.frontEnd.c_leafs).toBe(4);
  expect(performance.viewCluster).toBe(0);
  expect(performance.zFar).toBe(2048);
  world.prepareFrame({ refdef: { ...refdef, width: 0 } });
  expect(performance.frontEnd.c_leafs).toBe(4);
  expect(performance.zFar).toBe(2048);
  clock.time = 10;
  resources.renderSceneRecord(() => refdef.renderFlags, () => { clock.time = 17; return { ...refdef, width: 0 }; });
  expect(performance.frontEndMsec).toBe(7);
  cvars.set("r_norefresh", "1");
  resources.renderSceneRecord(() => { throw new Error("no-refresh read flags"); }, () => { throw new Error("no-refresh read refdef"); });
  expect(performance.frontEndMsec).toBe(7);
  cvars.set("r_norefresh", "0");
  function renderedLeaves(): number {
    const before = performance.frontEnd.c_leafs;
    world.renderFrame({ refdef });
    const leaves = performance.frontEnd.c_leafs - before;
    expect(commands.submitFrame()).not.toBeNull();
    resources.rolloverFrame();
    return leaves;
  }
  refdef.areaMask[0] = 1;
  expect(renderedLeaves()).toBe(1);
  cvars.set("r_lockpvs", "1"); refdef.areaMask[0] = 0;
  expect(renderedLeaves()).toBe(1);
  cvars.set("r_lockpvs", "0");
  expect(renderedLeaves()).toBe(1); // Unlocking alone retains the cached cluster.
  cvars.set("r_showcluster", "1");
  expect(renderedLeaves()).toBe(2);
  expect(cvars.get("r_showcluster")?.modified).toBe(false);
  refdef.areaMask[0] = 1; cvars.set("r_novis", "1");
  expect(renderedLeaves()).toBe(2);
  cvars.set("r_novis", "0");
  expect(renderedLeaves()).toBe(2); // A same-cluster cache hit precedes r_novis.
  cvars.set("r_showcluster", "0");
  expect(renderedLeaves()).toBe(1);
  cvars.set("r_drawworld", "0");
  expect(renderedLeaves()).toBe(0);
});

test("retail negative-area visibility reads the retained rdflags predecessor byte and preserves the cluster cache", async () => {
  const bsp = renderBspFixture([{ shader: "test/negative-area", lightmap: -1 }, { shader: "test/negative-area", lightmap: -1 }], []);
  const data = new DataView(bsp.buffer), leafOffset = data.getInt32(8 + 4 * 8, true);
  data.setInt32(leafOffset + 4, 255, true);
  data.setInt32(leafOffset + 48 + 4, -1, true);
  const files = new Map([
    ["maps/negative-area.bsp", bsp],
    ["scripts/negative-area.shader", new TextEncoder().encode("test/negative-area { cull none { map $whiteimage rgbGen identity } }")],
  ]);
  const { resources, cvars, commands } = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: () => [...files.keys()],
    read: async name => { const bytes = files.get(name); if (bytes === undefined) throw new Error(`missing negative-area fixture ${name}`); return bytes; },
  }));
  const world = await resources.loadWorld("negative-area"), performance = resources.performance;
  const refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  function renderedLeaves(): number {
    const before = performance.frontEnd.c_leafs;
    world.renderFrame({ refdef });
    const leaves = performance.frontEnd.c_leafs - before;
    expect(commands.submitFrame()).not.toBeNull();
    resources.rolloverFrame();
    return leaves;
  }
  expect(renderedLeaves()).toBe(2);
  refdef.renderFlags = -2147483648;
  expect(renderedLeaves()).toBe(2); // rdflags alone does not invalidate R_MarkLeaves.
  cvars.set("r_showcluster", "1");
  expect(renderedLeaves()).toBe(1); // areamask[-1] is rdflags byte 3, bit 7.
  refdef.areaMask[31] = 128;
  expect(renderedLeaves()).toBe(0);
  refdef.renderFlags = 0;
  expect(renderedLeaves()).toBe(0);
  cvars.set("r_showcluster", "0");
  expect(renderedLeaves()).toBe(1);
  refdef.areaMask[31] = 0;
  expect(renderedLeaves()).toBe(2);
});

test.each([-2, 256])("visibility rejects reached area %i outside the retained refdef profile after PVS", async area => {
  const bsp = renderBspFixture([{ shader: "test/area-profile", lightmap: -1 }, { shader: "test/area-profile", lightmap: -1 }], []);
  const data = new DataView(bsp.buffer);
  data.setInt32(data.getInt32(8 + 4 * 8, true) + 48 + 4, area, true);
  data.setUint8(data.getInt32(8 + 16 * 8, true) + 8, 1);
  const files = new Map([
    ["maps/area-profile.bsp", bsp],
    ["scripts/area-profile.shader", new TextEncoder().encode("test/area-profile { cull none { map $whiteimage rgbGen identity } }")],
  ]);
  const { resources, commands } = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: () => [...files.keys()],
    read: async name => { const bytes = files.get(name); if (bytes === undefined) throw new Error(`missing area-profile fixture ${name}`); return bytes; },
  }));
  const world = await resources.loadWorld("area-profile");
  const refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  world.renderFrame({ refdef });
  expect(resources.performance.frontEnd.c_leafs).toBe(1);
  expect(commands.submitFrame()).not.toBeNull();
  resources.rolloverFrame();
  refdef.viewOrigin = { x: 64, y: 0, z: 0 };
  expect(() => world.prepareFrame({ refdef })).toThrow(`R_MarkLeaves area ${area} is outside the supported refdef area-mask profile`);
});

test("queued procedural entities consume live rail controls only at backend execution", async () => {
  const files = new Map([["scripts/rail.shader", new TextEncoder().encode("test/rail { cull none { map $whiteimage } }")]]);
  const { resources, commands, cvars, recording } = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: () => [...files.keys()],
    read: async name => { const bytes = files.get(name); if (bytes === undefined) throw new Error(`missing rail fixture ${name}`); return bytes; },
  }));
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const rings = createRailRingsEntity(); rings.customShader = await resources.registerShader("test/rail");
  rings.oldOrigin = { x: 32, y: 0, z: 0 }; rings.origin = { x: 128, y: 0, z: 0 };
  cvars.set("r_railSegmentLength", "0");
  resources.renderFrame({ refdef, entities: [rings] });
  expect(recording.trace()).toHaveLength(0);
  cvars.set("r_railSegmentLength", "48");
  expect(commands.submitFrame()).not.toBeNull(); resources.rolloverFrame();
  expect(recording.trace().at(-1)?.batches.flatMap(batch => batch.vertices)).toHaveLength(4);
  const before = recording.trace().length;
  cvars.set("r_railSegmentLength", "0"); cvars.set("r_skipBackEnd", "1");
  resources.renderFrame({ refdef, entities: [rings] });
  expect(commands.submitFrame()).not.toBeNull(); resources.rolloverFrame();
  expect(recording.trace()).toHaveLength(before);
  cvars.set("r_skipBackEnd", "0");
  const core = createRailCoreEntity(); core.customShader = rings.customShader;
  core.oldOrigin = { x: 32, y: 8, z: 0 }; core.origin = { x: 96, y: 12, z: 0 };
  resources.renderFrame({ refdef, entities: [core] });
  expect(commands.submitFrame()).not.toBeNull(); resources.rolloverFrame();
  expect(recording.trace().at(-1)?.batches.flatMap(batch => batch.vertices)).toHaveLength(4);
});

test("source patch counters distinguish sphere and box branches on actual inline submissions", async () => {
  const original = renderBspFixture([{ shader: "test/patch-count", lightmap: -1 }, { shader: "test/patch-count", lightmap: -1 }], []);
  const header = new DataView(original.buffer), vertexOffset = header.getInt32(8 + 10 * 8, true);
  const vertexEnd = vertexOffset + header.getInt32(12 + 10 * 8, true);
  const bytes = new Uint8Array(original.length + 44);
  bytes.set(original.subarray(0, vertexEnd)); bytes.set(original.subarray(vertexEnd), vertexEnd + 44);
  const data = new DataView(bytes.buffer);
  for (let lump = 0; lump < 17; lump++) {
    const offset = header.getInt32(8 + lump * 8, true);
    if (lump > 10) data.setInt32(8 + lump * 8, offset + 44, true);
  }
  data.setInt32(12 + 10 * 8, 9 * 44, true);
  for (let index = 0; index < 9; index++) {
    const offset = vertexOffset + index * 44;
    for (const [component, value] of [32, index % 3 * 8 - 8, Math.floor(index / 3) * 8 - 8, 0, 0, 0, 0, -1, 0, 0].entries())
      data.setFloat32(offset + component * 4, value, true);
    for (let channel = 0; channel < 4; channel++) data.setUint8(offset + 40 + channel, 255);
  }
  const surfaceOffset = data.getInt32(8 + 13 * 8, true);
  data.setInt32(surfaceOffset + 8, 2, true); data.setInt32(surfaceOffset + 16, 9, true);
  data.setInt32(surfaceOffset + 24, 0, true);
  data.setInt32(surfaceOffset + 96, 3, true); data.setInt32(surfaceOffset + 100, 3, true);
  data.setInt32(data.getInt32(8 + 7 * 8, true) + 28, 1, true);
  const files = new Map([["maps/patch-count.bsp", bytes],
    ["scripts/patch-count.shader", new TextEncoder().encode("test/patch-count { cull none { map $whiteimage rgbGen identity } }")]]);
  const { resources, cvars } = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: () => [...files.keys()],
    read: async name => { const result = files.get(name); if (result === undefined) throw new Error(`missing patch counter fixture ${name}`); return result; },
  }));
  const world = await resources.loadWorld("patch-count"), performance = resources.performance;
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const entity = createModelEntity(world.inlineModel(0));
  entity.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  for (const y of [0, 20, 32, 40, 90]) { entity.origin = { x: 0, y, z: 0 }; world.prepareFrame({ refdef, entities: [entity] }); }
  expect([performance.frontEnd.c_sphere_cull_patch_in, performance.frontEnd.c_sphere_cull_patch_clip, performance.frontEnd.c_sphere_cull_patch_out]).toEqual([1, 3, 1]);
  expect([performance.frontEnd.c_box_cull_patch_in, performance.frontEnd.c_box_cull_patch_clip, performance.frontEnd.c_box_cull_patch_out]).toEqual([1, 1, 1]);
  cvars.set("r_nocurves", "1"); world.prepareFrame({ refdef, entities: [entity] });
  cvars.set("r_nocull", "1"); world.prepareFrame({ refdef, entities: [entity] });
  expect([performance.frontEnd.c_sphere_cull_patch_in, performance.frontEnd.c_sphere_cull_patch_clip, performance.frontEnd.c_sphere_cull_patch_out]).toEqual([1, 3, 1]);
  expect([performance.frontEnd.c_box_cull_patch_in, performance.frontEnd.c_box_cull_patch_clip, performance.frontEnd.c_box_cull_patch_out]).toEqual([1, 1, 1]);
});

test("inline sky uses local tess clipping, the selected entity transform, live sky controls and retained cloud cells", async () => {
  const data = new Map([
    ["maps/inline-sky.bsp", renderBspFixture([{ shader: "test/sky", lightmap: -1 }, { shader: "test/sky", lightmap: -1 }], [])],
    ["scripts/sky.shader", new TextEncoder().encode("test/sky { skyparms - 128 - cull none { map $whiteimage rgbGen identity } }")],
  ]);
  const fixture = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    has: path => data.has(path), list: () => [...data.keys()], read: async path => {
    const bytes = data.get(path); if (bytes === undefined) throw new Error(`missing ${path}`); return bytes;
  } }));
  const { resources, submit, cvars } = fixture, world = await resources.loadWorld("inline-sky");
  const entity = createModelEntity(world.inlineModel(0)); entity.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  cvars.set("r_nocull", "1");
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const first = submit(world.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
  expect(first).toHaveLength(1); expect(first[0]?.vertices).toHaveLength(15); expect(first[0]?.indices).toHaveLength(48);
  expect(batchesBetweenDepthCalls(fixture.submittedEvents, [1, 1])).toEqual(first);
  expect(fixture.renderer.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
  expect(resources.tess.numVertexes).toBe(15); expect(resources.tess.numIndexes).toBe(0);
  // FillCloudySkySide overwrites xyz/UV only, retaining the preceding BSP normal/color.
  expect(resources.tess.allocatedVertex(0).normal).toEqual({ x: -1, y: 0, z: 0 });
  expect(resources.tess.allocatedVertex(0).color).toEqual({ x: 127, y: 191, z: 255, w: 255 });
  entity.origin = { x: 100, y: 20, z: 0 };
  entity.axis = [{ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }];
  const rotated = submit(world.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
  expect(rotated[0]?.indices).toEqual(first[0]?.indices);
  expect(rotated[0]?.vertices.map(vertex => vertex.texCoord)).toEqual(first[0]?.vertices.map(vertex => vertex.texCoord));
  const local = skyVector(0, -0.5, -0.25, 2048 / 1.75);
  const expected = viewProjector(refdef, viewProjection(refdef, 2048))(modelWorldPoint(entity, local));
  expect(rotated[0]?.vertices[0]?.position).toEqual({ x: Math.fround(expected.x), y: Math.fround(expected.y), z: Math.fround(expected.z), w: Math.fround(expected.w) });
  cvars.set("r_showsky", "-2");
  const shown = submit(world.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
  expect(shown).toHaveLength(1);
  expect(batchesBetweenDepthCalls(fixture.submittedEvents, [0, 0])).toEqual(shown);
  expect(resources.tess.actualDepthRange).toEqual([0, 1]);
  cvars.set("r_fastsky", "2"); resources.tess.setDepthRange([0, 0.3]);
  expect(submit(world.prepareFrame({ refdef, entities: [entity] }))[0]?.batches).toHaveLength(0);
  expect(resources.tess.actualDepthRange).toEqual([0, 0.3]);
  expect(resources.tess.numVertexes).toBe(8); expect(resources.tess.numIndexes).toBe(0);
});

test("2D sky consumes the real retained iterator, physical cull, viewport and cloud-table lifetime", async () => {
  const data = new Map<string, Uint8Array>([["scripts/sky.shader", new TextEncoder().encode(
    "test/box { skyparms test/box 128 - cull back polygonOffset } "
    + "test/cloud { skyparms - 128 - cull none { map $whiteimage rgbGen identity } } "
    + "test/table { skyparms - 512 - { map $whiteimage } }")]]);
  for (const face of ["rt", "lf", "bk", "ft", "up", "dn"]) data.set(`test/box_${face}.tga`, solidTga(255, 128, 32));
  const fixture = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    has: path => data.has(path), list: () => [...data.keys()], read: async path => {
    const bytes = data.get(path); if (bytes === undefined) throw new Error(`missing ${path}`); return bytes;
  } }));
  const { resources, commands, recording, cvars } = fixture;
  const box = await resources.registerShader("test/box"), cloud = await resources.registerShader("test/cloud");
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 32, z: -8 }, angles: { x: 0, y: 0, z: 0 } }, 160, 120), x: 13, y: 19, renderFlags: RDF_NOWORLDMODEL };
  fixture.submit(resources.prepareFrame({ refdef }));
  const draw = commands.draw2D("pixels"), rect = { x: 0, y: 0, width: 320, height: 240 };
  const firstStart = recording.events.length;
  draw.drawPic(rect, resources.picture(box)); commands.submitFrame();
  const firstEvents = recording.events.slice(firstStart), first = firstEvents.filter(operation => operation.kind === "sky-side");
  expect(first.length).toBeGreaterThan(0);
  const skySides: ViewOperation["kind"][] = first.map(() => "sky-side");
  const boxOrder: (ViewOperation["kind"] | "begin-view")[] = ["begin-view", "depth-range", "sky-box-state", ...skySides,
    "cull", "polygon-offset", "begin-source-arrays", "begin-generic-iterator", "end-source-arrays", "polygon-offset", "depth-range", "log-comment", "log-comment"];
  expect(firstEvents.map(operation => operation.kind)).toEqual(boxOrder);
  expect(firstEvents.filter(operation => operation.kind === "log-comment").map(operation => operation.text))
    .toEqual(["----------\n", "***************** RB_SwapBuffers *****************\n\n\n"]);
  const white = fixture.builtins.find("*white");
  if (white === undefined) throw new Error("Missing built-in sky observer image");
  expect(() => fixture.renderer.drawShowImage(white.image, { x: 0, y: 0, width: 16, height: 16 }, false)).not.toThrow();
  expect(resources.tess.actualCullState).toBe("back");
  expect(resources.tess.numVertexes).toBe(0); expect(resources.tess.numIndexes).toBe(0);
  const start = recording.events.length;
  draw.drawPic(rect, resources.picture(box)); commands.submitFrame();
  // A completed frame re-enters 2D, which selects two-sided culling before sky.
  expect(recording.events.slice(start).map(operation => operation.kind)).toEqual(boxOrder);
  fixture.submit(resources.prepareFrame({ refdef }));
  const cloudDraw = (range: readonly [number, number] = [1, 1]) => {
    const start = recording.trace().flatMap(view => view.batches).length, eventStart = recording.events.length;
    draw.drawPic(rect, resources.picture(cloud)); commands.submitFrame();
    const batches = recording.trace().flatMap(view => view.batches).slice(start);
    const views = recording.trace().filter(view => view.batches.some(batch => batches.includes(batch)));
    expect(views.every(view => view.state.viewport.x === 0 && view.state.viewport.y === 0 && view.state.viewport.width === 320 && view.state.viewport.height === 240)).toBe(true);
    expect(resources.tess.view.origin).toEqual(refdef.viewOrigin);
    expect(resources.tess.actualDepthRange).toEqual([0, 1]);
    expect(batchesBetweenDepthCalls(recording.events.slice(eventStart), range)).toEqual(batches);
    return batches;
  };
  const clouds = cloudDraw(); expect(clouds.length).toBeGreaterThan(0);
  expect(clouds.flatMap(batch => batch.vertices).some(vertex => vertex.position.w === 1 && vertex.position.z !== -1)).toBe(true);
  await resources.registerShader("test/table");
  expect(cloudDraw().map(batch => batch.vertices.map(vertex => vertex.texCoord))).not.toEqual(clouds.map(batch => batch.vertices.map(vertex => vertex.texCoord)));
  cvars.set("r_showsky", "1");
  expect(cloudDraw([0, 0]).length).toBeGreaterThan(0);
});

test("outer sky publishes degenerate strips and binding-only faces at the source draw boundary", async () => {
  const data = new Map<string, Uint8Array>([["scripts/sky.shader", new TextEncoder().encode("test/box { skyparms test/box 128 - cull none }")]]);
  for (const face of ["rt", "lf", "bk", "ft", "up", "dn"]) data.set(`test/box_${face}.tga`, solidTga(255, 128, 32));
  const fixture = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    has: path => data.has(path), list: () => [...data.keys()], read: async path => {
      const bytes = data.get(path); if (bytes === undefined) throw new Error(`missing ${path}`); return bytes;
    },
  }));
  const shader = await fixture.resources.registerShader("test/box");
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const cases = [
    { points: [{ x: 3 / 128, y: 1 / 128, z: 1 / 256 }, { x: 4 / 128, y: 2 / 128, z: 1 / 256 }, { x: -7 / 128, y: -1 / 512, z: 0 }],
      coordinates: [[{ x: 1, y: 0.375 }, { x: 1, y: 0.25 }]] },
    { points: [{ x: 1 / 256, y: 1 / 128, z: 3 / 128 }, { x: 1 / 256, y: 2 / 128, z: 4 / 128 }, { x: 0, y: -1 / 512, z: -7 / 128 }],
      coordinates: [] },
  ];
  for (const value of cases) {
    const poly = { shader, vertices: value.points.map(position => ({ position, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } })) };
    fixture.submit(fixture.resources.prepareFrame({ refdef, polys: [poly] }));
    const sides = fixture.submittedEvents.filter(operation => operation.kind === "sky-side");
    expect(sides).toHaveLength(1);
    expect(sides[0]?.image.name).toBe("test/box_bk.tga");
    expect(sides[0]?.strips.map(strip => strip.map(vertex => vertex.texCoord))).toEqual(value.coordinates);
    expect(fixture.submittedEvents.filter(operation => operation.kind === "depth-range").map(operation => operation.range)).toEqual([[1, 1], [0, 1]]);
    expect(fixture.resources.tess.numVertexes).toBe(0);
    expect(fixture.renderer.pixels.every((component, index) => index % 4 === 3 || component === 0)).toBe(true);
  }
});

test("coplanar 2D sky executes outer state and empty stages, while incomplete skyparms stays generic", async () => {
  const data = new Map<string, Uint8Array>([["scripts/empty-sky.shader", new TextEncoder().encode(
    "test/empty { skyparms test/box 128 - cull back polygonOffset { map test/color.tga } }\n"
    + "test/partial { skyparms test/box\n cull none { map test/color.tga } }\n"
    + "test/rebind { cull none { map $whiteimage } }")], ["test/color.tga", solidTga(31, 127, 223)]]);
  for (const face of ["rt", "lf", "bk", "ft", "up", "dn"]) data.set(`test/box_${face}.tga`, solidTga(255, 128, 32));
  const fixture = await worldRenderer(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    has: path => data.has(path), list: () => [...data.keys()], read: async path => {
    const bytes = data.get(path); if (bytes === undefined) throw new Error(`missing ${path}`); return bytes;
  } }));
  const { resources, commands, recording, renderer } = fixture;
  const empty = await resources.registerShader("test/empty"), partial = await resources.registerShader("test/partial");
  const rebind = await resources.registerShader("test/rebind");
  expect(partial).not.toBeNull();
  expect(resources.picture(partial).material.finished.iterator.kind).not.toBe("sky");
  expect(resources.picture(partial).material.sky?.outer).not.toBeNull();
  const draw = commands.draw2D("pixels"), rect = { x: 0, y: 0, width: 320, height: 240 }, before = renderer.pixels.slice();
  draw.drawPic(rect, resources.picture(empty)); commands.submitFrame();
  expect(recording.events.map(operation => operation.kind)).toEqual([
    "begin-view", "depth-range", "sky-box-state", "cull", "polygon-offset", "begin-source-arrays", "begin-generic-iterator", "draw", "end-source-arrays", "polygon-offset", "depth-range",
    "log-comment", "log-comment",
  ]);
  expect(recording.events.filter(operation => operation.kind === "depth-range").map(operation => operation.range)).toEqual([[1, 1], [0, 1]]);
  expect(recording.events.filter(operation => operation.kind === "polygon-offset").map(operation => operation.value)).toEqual([{ factor: -1, units: -2 }, null]);
  const batches = recording.trace().flatMap(view => view.batches);
  expect(batches).toHaveLength(1); expect(batches[0]?.vertices).toHaveLength(0); expect(batches[0]?.indices).toHaveLength(0);
  expect(recording.textures).toHaveLength(1);
  expect(recording.textures[0]?.kind).toBe("bind-image");
  expect(renderer.pixels).toEqual(before); expect(resources.tess.actualDepthRange).toEqual([0, 1]);
  expect(resources.tess.actualCullState).toBe("back");
  const eventStart = recording.events.length, textureStart = recording.textures.length;
  commands.submit(); expect(recording.events).toHaveLength(eventStart); expect(recording.textures).toHaveLength(textureStart);
  draw.drawPic(rect, resources.picture(partial)); commands.submitFrame();
  expect(recording.events.slice(eventStart).map(operation => operation.kind)).toEqual(["begin-view", "cull", "begin-source-arrays", "begin-generic-iterator", "draw", "end-source-arrays", "log-comment", "log-comment"]);
  expect(recording.trace().at(-1)?.batches.at(-1)?.indices).toHaveLength(6);
  const binding = recording.textures.at(-1);
  if (binding?.kind !== "bind-image") throw new Error("partial sky shader did not bind its ordinary image");
  expect(binding.image.name).toBe("test/color.tga");
  // R_CreateImage raw-unbound the last image without changing GL_Bind's cache.
  // Both stage calls correctly retain incomplete object zero until a different bind.
  expect(renderer.pixels.subarray(0, 4)).toEqual(new Uint8Array([255, 255, 255, 255]));
  const bindingsBeforeRebind = recording.textures.length;
  draw.drawPic(rect, resources.picture(rebind)); draw.drawPic(rect, resources.picture(partial)); commands.submitFrame();
  expect(recording.textures.slice(bindingsBeforeRebind).map(operation => operation.kind === "bind-image" ? operation.image.name : operation.kind)).toEqual(["*white", "test/color.tga"]);
  expect(renderer.pixels.subarray(0, 4)).toEqual(new Uint8Array([31, 127, 223, 255]));
});

test("mirror views render first, clip camera-side geometry and preserve their pixels through the parent on CPU and GL", async () => {
  const bsp = renderBspFixture([{ shader: "test/mirror", lightmap: -1 }, { shader: "test/black", lightmap: -1 }], []);
  bsp.set([1, 2], bsp.length - 2);
  const data = new Map<string, Uint8Array>([
    ["maps/portal-test.bsp", bsp],
    ["scripts/portal-test.shader", new TextEncoder().encode(`
      test/mirror { portal { map $whiteimage blendFunc GL_ZERO GL_ONE depthWrite } }
      test/black { { map $whiteimage rgbGen const ( 0 0 0 ) } }
      test/red { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }
      test/blue { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } }
    `)],
  ]);
  const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    read: async path => { const bytes = data.get(path); if (bytes === undefined) throw new Error(`missing ${path}`); return bytes; },
    has: path => data.has(path), list: (prefix = "") => [...data.keys()].filter(path => path.startsWith(prefix)) });
  const mirrorFixture = await worldRenderer(files, { kind: "unaccounted" }, true, 8);
  const { resources, renderer, submit, cvars, gl } = mirrorFixture;
  const world = await resources.loadWorld("portal-test"), red = await resources.registerShader("test/red"), blue = await resources.registerShader("test/blue");
  const quad = (x: number, shader: typeof red) => ({ shader,
    vertices: [[-16, -16], [16, -16], [16, 16], [-16, 16]].map(([y, z]) => {
      if (y === undefined || z === undefined) throw new Error("missing quad coordinate");
      return { position: { x, y: y - 12, z }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } };
    }) });
  const portal = createPortalEntity(); portal.origin = { x: 32, y: -12, z: 0 }; portal.oldOrigin = portal.origin;
  const refdef = cameraRefdef({ origin: { x: 0, y: -12, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  const frame = { refdef, entities: [portal], polys: [quad(0, red), quad(48, blue)] };
  const prepared = world.prepareFrame(frame);
  portal.oldOrigin = { x: 200, y: 0, z: 0 };
  const views = submit(prepared);
  portal.oldOrigin = portal.origin;
  expect(views).toHaveLength(2);
  expect(views[0]?.state.clipPlane).toBeDefined(); expect(views[1]?.state.clipPlane).toBeUndefined();
  expect(views[0]?.state.clear?.color).toBeNull(); expect(views[1]?.state.clear?.color).toBeNull();
  // R_CullSurface removes the mirror's back face from the child before batching.
  expect(views[0]?.batches[0]?.state.cull).toBe("none"); expect(views[1]?.batches[0]?.state.cull).toBe("front");
  // Reflected camera is in cluster 1, while oldOrigin selects cluster 0's PVS.
  expect(views[0]?.batches.some(batch => batch.vertices.every(vertex => vertex.color.x === 0 && vertex.color.y === 0 && vertex.color.z === 0))).toBe(false);
  const center = (pixels: Uint8Array) => Array.from(pixels.slice((120 * 320 + 160) * 4, (120 * 320 + 160) * 4 + 4));
  expect(center(renderer.pixels)).toEqual([255, 0, 0, 255]);
  if (gl !== null) expect(center(gl.readPixels())).toEqual([255, 0, 0, 255]);
  cvars.set("r_noportals", "1");
  expect(submit(world.prepareFrame(frame))).toHaveLength(1);
  expect(center(renderer.pixels)).toEqual([0, 0, 0, 255]);
  if (gl !== null) expect(center(gl.readPixels())).toEqual([0, 0, 0, 255]);
  cvars.set("r_noportals", "0"); cvars.set("r_portalOnly", "1");
  expect(submit(world.prepareFrame(frame))).toHaveLength(1);
  expect(center(renderer.pixels)).toEqual([255, 0, 0, 255]);
  cvars.set("r_portalOnly", "0"); cvars.set("r_fastsky", "1");
  expect(submit(world.prepareFrame(frame))).toHaveLength(1);
  cvars.set("r_fastsky", "2");
  expect(submit(world.prepareFrame(frame))).toHaveLength(2);
  cvars.set("r_fastsky", "0");
  const third = createSpriteEntity(); third.origin = { x: 8, y: -12, z: 0 }; third.radius = 2; third.customShader = red; third.renderFlags = RF_THIRD_PERSON;
  const first = { ...third, origin: { x: 16, y: -12, z: 0 }, renderFlags: RF_FIRST_PERSON };
  const filtered = submit(world.prepareFrame({ ...frame, entities: [portal, third, first] }));
  const sprites = filtered.map(view => view.batches.filter(batch => batch.state.cull === "none" && batch.vertices.some(vertex => vertex.texCoord.x === 1)));
  expect(sprites[0]).toHaveLength(1); expect(sprites[1]).toHaveLength(1);
  const childSprite = sprites[0]?.find(batch => batch.vertices[0]?.position.w === 56), primarySprite = sprites[1]?.find(batch => batch.vertices[0]?.position.w === 16);
  expect(childSprite).toBeDefined(); expect(primarySprite).toBeDefined();
  expect(childSprite?.vertices[0]?.position.x).toBeGreaterThan(0); expect(primarySprite?.vertices[0]?.position.x).toBeLessThan(0);
  const portalShader = await resources.registerShader("test/mirror");
  const degenerate = { shader: portalShader, vertices: [0, 1, 2].map(y => ({ position: { x: -32, y, z: 0 },
    texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } })) };
  expect(submit(resources.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL }, polys: [degenerate] }))).toHaveLength(1);
  await resources.remapShader("test/blue", "<stencil shadow>", null);
  cvars.set("cg_shadows", "2");
  submit(world.prepareFrame(frame));
  const childOperations = mirrorFixture.preparedViews[0]?.operations;
  expect(childOperations?.slice(-2).map(operation => operation.kind)).toEqual(["shadow-finish", "render-flares"]);
  const parentPrefix = mirrorFixture.preparedViews[1]?.beforeView;
  expect(parentPrefix?.map(operation => operation.kind)).toEqual(["shadow-volume"]);
  const childVolumes = [...(childOperations ?? []), ...(parentPrefix ?? [])].filter(operation => operation.kind === "shadow-volume");
  expect(childVolumes).toHaveLength(2);
  expect(childVolumes?.[1]?.positions).not.toEqual(childVolumes?.[0]?.positions);
  expect(mirrorFixture.preparedViews[1]?.clear.stencil).toBe(true);
  const portalSprite = { ...first, customShader: portalShader, renderFlags: 0 };
  const spriteViews = submit(resources.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL }, entities: [portalSprite] }));
  expect(spriteViews).toHaveLength(1);
  expect(spriteViews[0]?.state.clipPlane).toBeUndefined();
  expect(spriteViews[0]?.batches).toHaveLength(1);
  expect(spriteViews[0]?.batches[0]?.vertices).toHaveLength(4);
  expect(spriteViews[0]?.batches[0]?.indices).toHaveLength(6);
});

test("portal probes flush ordinary and marker geometry before the first clear and retain source BSP normals", async () => {
  const bsp = renderBspFixture([{ shader: "test/mirror", lightmap: -1 }, { shader: "test/black", lightmap: -1 }], []);
  bsp.set([1, 2], bsp.length - 2);
  const data = new Map<string, Uint8Array>([
    ["maps/probe.bsp", bsp],
    ["scripts/probe.shader", new TextEncoder().encode("test/mirror { portal { map $whiteimage blendFunc GL_ZERO GL_ONE depthWrite } } test/black { { map $whiteimage rgbGen const ( 0 0 0 ) } } "
      + "test/lit { { map $whiteimage } } test/cloud { skyparms - 128 - cull none { map $whiteimage } }")],
  ]);
  const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => data.get(path)?.byteLength ?? -1, readFileOptional: async path => data.get(path),
    has: path => data.has(path), list: () => [...data.keys()], read: async path => {
    const bytes = data.get(path); if (bytes === undefined) throw new Error(`missing ${path}`); return bytes;
  } });
  const fixture = await worldRenderer(files, { kind: "unaccounted" }, true, 8);
  const world = await fixture.resources.loadWorld("probe");
  const portal = createPortalEntity(); portal.origin = { x: 32, y: -12, z: 0 }; portal.oldOrigin = portal.origin;
  const refdef = cameraRefdef({ origin: { x: 0, y: -12, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  const frame = { refdef, entities: [portal] };
  fixture.cvars.set("cg_shadows", "2");
  await fixture.resources.remapShader("test/mirror", "<stencil shadow>", null);
  // Internal marker shaders leave BSP normals at their source BSS zeros.
  expect(fixture.submit(world.prepareFrame(frame))).toHaveLength(1);
  const virginPrefix = fixture.retainedPrefix[0];
  expect(virginPrefix?.kind).toBe("shadow-volume");
  if (virginPrefix?.kind !== "shadow-volume") throw new Error("missing source virgin marker flush");
  const portalSurface = world.markGeometry.surfaces[0];
  if (portalSurface?.kind !== "face") throw new Error("missing authored portal face");
  const firstVertex = portalSurface.vertices[0];
  if (firstVertex === undefined) throw new Error("missing authored portal vertex");
  expect(virginPrefix.positions[0]).toEqual({ ...firstVertex.position, w: 1 });
  expect(virginPrefix.indices).toHaveLength(0);
  await fixture.resources.remapShader("test/mirror", "test/mirror", null);
  expect(fixture.submit(world.prepareFrame(frame))).toHaveLength(2);
  expect(fixture.retainedPrefix[0]?.kind).toBe("cull");
  expect(fixture.retainedPrefix[1]?.kind).toBe("begin-source-arrays");
  expect(fixture.retainedPrefix[2]?.kind).toBe("begin-generic-iterator");
  const ordinaryPrefix = fixture.retainedPrefix[3];
  expect(ordinaryPrefix?.kind).toBe("draw");
  if (ordinaryPrefix?.kind !== "draw") throw new Error("missing source ordinary portal flush");
  expect(ordinaryPrefix.batches[0]?.indices).toHaveLength(6);
  await fixture.resources.remapShader("test/mirror", "<stencil shadow>", null);
  expect(fixture.submit(world.prepareFrame(frame))).toHaveLength(2);
  expect(fixture.retainedPrefix[0]?.kind).toBe("shadow-volume");
  expect(fixture.preparedViews[0]?.operations.map(operation => operation.kind)).toEqual(["shadow-finish", "render-flares"]);
  expect(fixture.preparedViews[1]?.beforeView?.map(operation => operation.kind)).toEqual(["shadow-volume"]);
  await fixture.resources.remapShader("test/mirror", "test/cloud", null);
  fixture.submit(world.prepareFrame(frame));
  const skyPrefix = fixture.retainedPrefix.flatMap(operation => operation.kind === "draw" ? operation.batches : []);
  expect(skyPrefix.length).toBeGreaterThan(0);
  expect(batchesBetweenDepthCalls(fixture.retainedPrefix, [1, 1])).toEqual(skyPrefix);
  expect(fixture.resources.tess.actualDepthRange).toEqual([0, 1]);
  await fixture.resources.remapShader("test/mirror", "test/lit", null);
  const light = { origin: { x: 32, y: -12, z: 0 }, radius: 64, color: { x: 1, y: 0, z: 0 } };
  fixture.submit(world.prepareFrame({ ...frame, dynamicLights: [light] }));
  fixture.submit(world.prepareFrame({ ...frame, dynamicLights: [light] }));
  const litPrefix = fixture.retainedPrefix.flatMap(operation => operation.kind === "draw" ? operation.batches : []);
  expect(litPrefix.length).toBeGreaterThan(0);
  const projected = litPrefix.filter(batch => batch.texture.kind === "bind-image" && batch.texture.image === fixture.builtins.find("*dlight")?.image);
  expect(projected).toHaveLength(1);
  expect(projected[0]?.vertices[0]?.texCoord).toEqual({ x: 0.5, y: 0.5625 });
});

describe("world visibility and map lighting", () => {
  test("plane ties use the back child and PVS remains directional", () => {
    const map = visibilityMap();
    expect(pointInLeaf(map, { x: 1, y: 0, z: 0 })).toBe(0);
    expect(pointInLeaf(map, { x: 0, y: 0, z: 0 })).toBe(1);
    expect(clusterVisible(map.visibility, 0, 1)).toBe(false);
    expect(clusterVisible(map.visibility, 1, 0)).toBe(true);
    expect(clusterVisible(map.visibility, -1, -1)).toBe(true);
    expect(clusterVisible(map.visibility, 0, -1)).toBe(false);
    expect(clusterVisible(null, 0, 1)).toBe(true);
  });
  test("overbright normalizes hue before byte truncation", () => {
    expect(shiftLighting({ x: 100, y: 50, z: 25, w: 77 })).toEqual({ x: 255, y: 127, z: 63, w: 77 });
    expect(shiftLighting({ x: 10, y: 20, z: 30, w: 255 })).toEqual({ x: 40, y: 80, z: 120, w: 255 });
  });
});

describe("source quadratic patch subdivision", () => {
  test("curve center is on the quadratic and interpolates both coordinate sets", () => {
    const points = Array.from({ length: 9 }, (_, index) => controlPoint(index % 3, Math.floor(index / 3), index % 3 === 1 ? 8 : 0));
    const mesh = tessellatePatch(points, 3, 3, 4);
    expect(mesh.width).toBe(3);
    expect(mesh.height).toBe(2);
    expect(mesh.vertices[1]?.position).toEqual({ x: 1, y: 0, z: 4 });
    expect(mesh.vertices[1]?.texCoord).toEqual({ x: 0.5, y: 0 });
    expect(mesh.vertices[1]?.lightmapCoord).toEqual({ x: 0.25, y: 0 });
    expect(mesh.vertices[1]?.normal.z).toBeCloseTo(1);
    expect(mesh.indices).toEqual([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5]);
  });
  test("adaptive refinement retains endpoints and reaches source error bound", () => {
    const points = Array.from({ length: 9 }, (_, index) => controlPoint(index % 3 * 64, Math.floor(index / 3) * 64, index % 3 === 1 ? 128 : 0));
    const coarse = tessellatePatch(points, 3, 3, 64), fine = tessellatePatch(points, 3, 3, 4);
    expect(fine.width).toBeGreaterThan(coarse.width);
    expect(fine.vertices[0]?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(fine.vertices[fine.width - 1]?.position).toEqual({ x: 128, y: 0, z: 0 });
    expect(fine.vertices.some(vertex => vertex.position.x === 64 && vertex.position.z === 64)).toBe(true);
    for (const vertex of fine.vertices) {
      const t = vertex.position.x / 128;
      expect(vertex.position.z).toBeCloseTo(256 * t * (1 - t), 4);
    }
  });
  for (const subdivisions of [0, -1]) {
    test(`threshold ${subdivisions} refines a curve until the source straightness cutoff`, () => {
      const points = Array.from({ length: 9 }, (_, index) => controlPoint(index % 3 * 16, Math.floor(index / 3) * 16, index % 3 === 1 ? 8 : 0));
      const mesh = tessellatePatch(points, 3, 3, subdivisions);
      // Three bisections take midpoint deviation from 4 to at most 1/16, below 0.1.
      expect([mesh.width, mesh.height]).toEqual([9, 2]);
      expect(mesh.vertices.map(vertex => vertex.position)).toEqual([0, 32].flatMap(y =>
        Array.from({ length: 9 }, (_, index) => ({ x: index * 4, y, z: index * (8 - index) / 4 }))));
      expect(mesh.indices).toHaveLength(48);
      expect(mesh.vertices.every(vertex => [vertex.normal.x, vertex.normal.y, vertex.normal.z].every(Number.isFinite))).toBe(true);
      expect([...mesh.widthLodError, ...mesh.heightLodError].every(Number.isFinite)).toBe(true);
    });
    test(`threshold ${subdivisions} stops growth at the source 65-column scratch boundary`, () => {
      const points = Array.from({ length: 65 * 3 }, (_, index) => controlPoint(index % 65 * 16, Math.floor(index / 65) * 16, index % 65 % 2 === 1 ? 8 : 0));
      const mesh = tessellatePatch(points, 65, 3, subdivisions);
      expect([mesh.width, mesh.height]).toEqual([65, 2]);
      expect(mesh.vertices.map(vertex => vertex.position)).toEqual([0, 32].flatMap(y =>
        Array.from({ length: 65 }, (_, index) => ({ x: index * 16, y, z: index % 2 === 1 ? 4 : 0 }))));
      expect(mesh.widthLodError).toEqual(Array.from({ length: 65 }, (_, index) => index % 2 === 1 ? 0.25 : 0));
      expect(mesh.vertices.every(vertex => [vertex.normal.x, vertex.normal.y, vertex.normal.z].every(Number.isFinite))).toBe(true);
    });
  }
  for (const width of [33, 3]) {
    test(`accepts a source-bounded ${width}x${width === 33 ? 3 : 33} control grid`, () => {
      const height = width === 33 ? 3 : 33;
      const points = Array.from({ length: width * height }, (_, index) => {
        const x = index % width, y = Math.floor(index / width);
        return controlPoint(x * 16, y * 16, (width === 33 ? x : y) % 2 === 1 ? 8 : 0);
      });
      const mesh = tessellatePatch(points, width, height);
      expect([mesh.width, mesh.height]).toEqual([33, 2]);
      expect(mesh.vertices.map(vertex => vertex.position)).toEqual([0, 32].flatMap(edge =>
        Array.from({ length: 33 }, (_, index) => ({ x: width === 33 ? index * 16 : edge,
          y: width === 33 ? edge : (32 - index) * 16, z: index % 2 === 1 ? 4 : 0 }))));
      expect(mesh.widthLodError).toEqual(Array.from({ length: 33 }, (_, index) => index % 2 === 1 ? 0.25 : 0));
      expect(mesh.indices).toHaveLength(192);
    });
  }
  test("accepts 1023 controls within the source 1024-point input buffer", () => {
    const points = Array.from({ length: 31 * 33 }, (_, index) => controlPoint(index % 31 * 16, Math.floor(index / 31) * 16, 0));
    const mesh = tessellatePatch(points, 31, 33);
    expect([mesh.width, mesh.height]).toEqual([17, 16]);
    expect(mesh.vertices.map(vertex => vertex.position)).toEqual(Array.from({ length: 16 }, (_, row) =>
      Array.from({ length: 17 }, (_, column) => ({ x: row * 32, y: (16 - column) * 32, z: 0 }))).flat());
  });
  test("straight columns collapse for all finite threshold signs", () => {
    const points = Array.from({ length: 9 }, (_, index) => controlPoint(index % 3, Math.floor(index / 3), 0));
    for (const subdivisions of [4, 0, -1]) {
      const mesh = tessellatePatch(points, 3, 3, subdivisions);
      expect(mesh.vertices).toHaveLength(4);
      expect(mesh.indices).toHaveLength(6);
    }
  });
  test("rejects malformed dimensions, allocation overflow and nonfinite thresholds", () => {
    for (const [width, height] of [[2, 3], [3, 2], [4, 3], [3, 4], [67, 3], [3, 67], [33, 33]] satisfies readonly (readonly [number, number])[]) {
      const points = Array.from({ length: width * height }, (_, index) => controlPoint(index % width, Math.floor(index / width), 0));
      expect(() => tessellatePatch(points, width, height)).toThrow(RangeError);
    }
    const points = Array.from({ length: 9 }, (_, index) => controlPoint(index % 3, Math.floor(index / 3), 0));
    for (const [width, height] of [[3.5, 3], [3, 3.5], [NaN, 3], [3, Infinity]] satisfies readonly (readonly [number, number])[]) {
      expect(() => tessellatePatch(points, width, height)).toThrow(RangeError);
    }
    expect(() => tessellatePatch(points.slice(1), 3, 3)).toThrow(RangeError);
    for (const subdivisions of [NaN, Infinity, -Infinity]) expect(() => tessellatePatch(points, 3, 3, subdivisions)).toThrow(RangeError);
  });
});

const dataPath = process.env["Q3_DATA"];

test.skipIf(dataPath === undefined)("zero-index sky stages advance the real silent retail cinematic without drawing pixels", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA is required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const script = "scripts/000_empty_sky_video.shader", source = new TextEncoder().encode(
    "test/empty-video { skyparms - 128 - cull none { videoMap mpteam1.roq } }");
  const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = { ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: path => path === script ? Promise.resolve(source) : Promise.resolve(undefined) }, assets), has: path => path === script || assets.has(path), list: prefix => [script, ...assets.list(prefix)],
    read: path => path === script ? Promise.resolve(source) : assets.read(path),
    readFileLength: path => path === script ? source.byteLength : assets.readFileLength(path),
    readFileOptional: path => path === script ? Promise.resolve(source) : assets.readFileOptional(path) };
  const fixture = await worldRenderer(files), { resources, commands, recording, clock, renderer } = fixture;
  const shader = await resources.registerShader("test/empty-video"), draw = commands.draw2D("pixels");
  const pixels = renderer.pixels.slice();
  const hashes: string[] = [];
  for (const time of [0, 34, 67]) {
    clock.time = time;
    const start = recording.textures.length;
    draw.drawPic({ x: 0, y: 0, width: 320, height: 240 }, resources.picture(shader)); commands.submit();
    expect(recording.textures).toHaveLength(start);
    expect(resources.tess.numVertexes).toBe(4); expect(resources.tess.numIndexes).toBe(6);
    commands.submitFrame();
    const operations = recording.textures.slice(start);
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    if (time === 0) expect(operation?.kind).toBe("retain-current-texture");
    else {
      if (operation?.kind !== "cinematic-upload") throw new Error("zero-index source stage did not upload its cinematic");
      hashes.push(Bun.CryptoHasher.hash("sha256", operation.upload.content.copyPixels(), "hex"));
      expect(operation.upload.image).toBe(fixture.builtins.scratchImage(0));
    }
    expect(renderer.pixels).toEqual(pixels);
    expect(fixture.cinematicMixer.rawEnd).toBe(0);
    expect(resources.tess.numVertexes).toBe(0); expect(resources.tess.numIndexes).toBe(0);
  }
  expect(hashes).toHaveLength(2); expect(hashes[0]).not.toBe(hashes[1]);
  expect(recording.trace().flatMap(view => view.batches).every(batch => batch.indices.length === 0 && batch.vertices.length === 0)).toBe(true);
}, 20000);

test.skipIf(dataPath === undefined)("retail MD3 sky materials share the world iterator across products and entity origins", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA is required");
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const script = "scripts/000_consumer_sky.shader", source = new TextEncoder().encode(
      "test/modelsky { skyparms - 128 - cull none { map $whiteimage rgbGen entity alphaGen entity } } "
      + "test/skynoise { skyparms - 128 - deformVertexes move 1 0 0 noise 0 1 0 1 { map $whiteimage } }");
    const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = { ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: path => path === script ? Promise.resolve(source) : Promise.resolve(undefined) }, assets), has: path => path === script || assets.has(path), list: prefix => [script, ...assets.list(prefix)],
      read: path => path === script ? Promise.resolve(source) : assets.read(path),
    readFileLength: path => path === script ? source.byteLength : assets.readFileLength(path),
    readFileOptional: path => path === script ? Promise.resolve(source) : assets.readFileOptional(path) };
    const fixture = await worldRenderer(files), { resources, submit, cvars } = fixture;
    const world = await resources.loadWorld(product === "baseq3" ? "q3dm1" : "mpteam1");
    submit(world.prepareFrame({ refdef: cameraRefdef(world.initialCamera(), 320, 240) }));
    const model = await resources.registerModel("models/players/sarge/lower.md3");
    if (model.kind !== "md3") throw new Error("retail Sarge MD3 was not registered");
    const entity = createModelEntity(model);
    entity.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
    entity.customShader = await resources.registerShader("test/modelsky");
    entity.shaderRGBA = { x: 31, y: 127, z: 223, w: 255 };
    cvars.set("r_nocull", "1");
    const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
    const first = submit(resources.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
    expect(first.length).toBeGreaterThan(0);
    expect(batchesBetweenDepthCalls(fixture.submittedEvents, [1, 1])).toEqual(first);
    expect(first.flatMap(batch => batch.vertices).every(vertex => vertex.color.x === 31 / 255 && vertex.color.y === 127 / 255 && vertex.color.z === 223 / 255)).toBe(true);
    expect(fixture.renderer.pixels.some((value, index) => index % 4 === 0 && value === 31 && fixture.renderer.pixels[index + 1] === 127 && fixture.renderer.pixels[index + 2] === 223)).toBe(true);
    entity.origin = { x: 128, y: 16, z: 0 }; entity.renderFlags = RF_DEPTHHACK;
    const translated = submit(resources.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
    expect(translated.map(batch => batch.indices)).toEqual(first.map(batch => batch.indices));
    expect(translated.map(batch => batch.vertices.map(vertex => vertex.texCoord))).toEqual(first.map(batch => batch.vertices.map(vertex => vertex.texCoord)));
    const firstVertex = first[0]?.vertices[0], translatedVertex = translated[0]?.vertices[0];
    if (firstVertex === undefined || translatedVertex === undefined) throw new Error("retail model sky has no first vertex");
    expect(translatedVertex.position.w).toBe(Math.fround(firstVertex.position.w + 128));
    expect(batchesBetweenDepthCalls(fixture.submittedEvents, [1, 1])).toEqual(translated);
    expect(resources.tess.actualDepthRange).toEqual([0, 1]);
    entity.customShader = await resources.registerShader("test/skynoise");
    expect(() => submit(resources.prepareFrame({ refdef, entities: [entity] }))).toThrow("TableForFunc called with invalid function '6' in shader 'test/skynoise'\n");
  }
}, 120000);
test("stencil marker remaps emit ordered zero-edge islands with actual target gates and retained cull", async () => {
  const names = ["before", "volume-a", "between", "volume-b"];
  const script = new TextEncoder().encode(names.map(name => `test/${name} { cull none { map $whiteimage } }`).join("\n"));
  const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "scripts/stencil.shader" ? script.byteLength : -1,
    readFileOptional: async path => path === "scripts/stencil.shader" ? script : undefined,
    has: path => path === "scripts/stencil.shader", list: () => ["scripts/stencil.shader"],
    read: async path => { if (path !== "scripts/stencil.shader") throw new Error(`missing stencil fixture ${path}`); return script; } });
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  for (const bits of [0, 8]) {
    const fixture = await worldRenderer(files, { kind: "unaccounted" }, true, bits);
    const polys: RefPoly[] = [];
    for (const name of names) {
      const shader = await fixture.resources.registerShader(`test/${name}`);
      polys.push({ shader, vertices: [[-4, -4], [4, -4], [4, 4], [-4, 4]].map(([y, z]) => {
        if (y === undefined || z === undefined) throw new Error("missing stencil polygon coordinate");
        return { position: { x: 32, y, z }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } };
      }) });
    }
    await fixture.resources.remapShader("test/volume-a", "<stencil shadow>", null);
    await fixture.resources.remapShader("test/volume-b", "<stencil shadow>", null);
    fixture.cvars.set("cg_shadows", "2");
    fixture.submit(fixture.resources.prepareFrame({ refdef, polys }));
    const view = fixture.preparedViews[0];
    if (view === undefined) throw new Error("missing stencil view");
    expect(view.clear.stencil).toBe(true);
    if (fixture.target.stencilBits < 4) {
      expect(view.operations.map(operation => operation.kind)).toEqual([
        "cull", "begin-source-arrays", "begin-generic-iterator", "source-tess-stage", "end-source-arrays", "log-comment",
        "cull", "begin-source-arrays", "begin-generic-iterator", "source-tess-stage", "end-source-arrays", "log-comment",
        "render-flares",
      ]);
      continue;
    }
    expect(view.operations.map(operation => operation.kind)).toEqual([
      "cull", "begin-source-arrays", "begin-generic-iterator", "source-tess-stage", "end-source-arrays", "log-comment", "shadow-volume",
      "cull", "begin-source-arrays", "begin-generic-iterator", "source-tess-stage", "end-source-arrays", "log-comment", "shadow-volume", "shadow-finish",
      "render-flares",
    ]);
    const volumes = view.operations.filter(operation => operation.kind === "shadow-volume");
    expect(volumes.map(volume => volume.indices.length)).toEqual([0, 0]);
    expect(volumes.every(volume => volume.whiteImage === fixture.builtins.find("*white")?.image)).toBe(true);
    const draws = view.operations.flatMap(operation => operation.kind === "source-tess-stage" ? [operation.stage.batch] : []);
    expect(draws.map(batch => batch.state.cull)).toEqual(["none", "front"]);
    expect(fixture.resources.tess.numIndexes).toBe(6);
    fixture.cvars.set("cg_shadows", "0");
    fixture.submit(fixture.resources.prepareFrame({ refdef, polys }));
    expect(fixture.preparedViews[0]?.clear.stencil).toBe(false);
    // The command already flushed retained marker indexes; no portal probe replaced them.
    expect(fixture.preparedViews[0]?.beforeView).toEqual([]);
    expect(fixture.preparedViews[0]?.operations.filter(operation => operation.kind === "shadow-volume")).toHaveLength(2);
    expect(fixture.preparedViews[0]?.operations.some(operation => operation.kind === "shadow-finish")).toBe(false);
  }
});

test("world and rotated inline projected lights use the real image, source gates, and all 32 mask slots", async () => {
  const bsp = renderBspFixture([{ shader: "test/lit", lightmap: -1 }, { shader: "test/nodlight", lightmap: -1 }], []);
  const backfaces = renderBspFixture([{ shader: "test/cull", lightmap: -1 }, { shader: "test/cull", lightmap: -1 }], []);
  const faceData = new DataView(backfaces.buffer, backfaces.byteOffset, backfaces.byteLength), faceOffset = faceData.getInt32(8 + 13 * 8, true);
  for (const index of [0, 1]) faceData.setFloat32(faceOffset + index * 104 + 84, 1, true);
  const triangles = backfaces.slice(), triangleData = new DataView(triangles.buffer, triangles.byteOffset, triangles.byteLength);
  for (const index of [0, 1]) triangleData.setInt32(faceOffset + index * 104 + 8, 3, true);
  const files = new Map([["maps/dlight-test.bsp", bsp],
    ["maps/dlight-portal.bsp", renderBspFixture([{ shader: "test/lit", lightmap: -1 }, { shader: "test/lit", lightmap: -1 }], [])],
    ["maps/dlight-cull-face.bsp", backfaces], ["maps/dlight-cull-tris.bsp", triangles],
    ["maps/dlight-fast.bsp", renderBspFixture([{ shader: "test/fast", lightmap: 0 }, { shader: "test/fast", lightmap: 0 }], [[20, 20, 20], [20, 20, 20]])],
    ["maps/dlight-vertex.bsp", renderBspFixture([{ shader: "test/vertex", lightmap: -1 }, { shader: "test/vertex", lightmap: -1 }], [])],
    ["maps/dlight-translucent.bsp", renderBspFixture([{ shader: "test/translucent", lightmap: -1 }, { shader: "test/translucent", lightmap: -1 }], [])],
    ["maps/dlight-cloud.bsp", renderBspFixture([{ shader: "test/cloud", lightmap: -1 }, { shader: "test/cloud", lightmap: -1 }], [])],
    ["maps/dlight-sky.bsp", renderBspFixture([{ shader: "test/sky", lightmap: -1 }, { shader: "test/sky", lightmap: -1 }], [])],
    ["scripts/dlight-test.shader", new TextEncoder().encode(
      "test/lit { cull none { map $whiteimage rgbGen const ( 0.2 0.2 0.2 ) } } test/nodlight { surfaceparm nodlight cull none { map $whiteimage rgbGen const ( 0.2 0.2 0.2 ) } } "
      + "test/fast { surfaceparm nodlight cull none { map $whiteimage rgbGen identity } { map $lightmap blendFunc filter rgbGen identity } } "
      + "test/vertex { surfaceparm nodlight cull none { map $whiteimage rgbGen lightingDiffuse } } "
      + "test/translucent { cull none { map $whiteimage blendFunc add } } test/cull { { map $whiteimage } } "
      + "test/cloud { skyparms - 128 - cull none { map $whiteimage } } "
      + "test/sky { surfaceparm sky skyparms - 128 - cull none { map $whiteimage } } "
      + "test/portal { portal { map $whiteimage blendFunc GL_ZERO GL_ONE depthWrite } }")]]);
  const source = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: name => files.get(name)?.byteLength ?? -1, readFileOptional: async name => files.get(name),
    has: name => files.has(name), list: () => [...files.keys()],
    read: async name => { const bytes = files.get(name); if (bytes === undefined) throw new Error(`missing dlight fixture ${name}`); return bytes; } });
  let fixture = await worldRenderer(source, { kind: "unaccounted" }, true);
  let { resources, renderer, cvars, builtins, gl } = fixture;
  const nextWorld = async (name: string, fastPath = false) => {
    fixture = await worldRenderer(source, { kind: "unaccounted" }, true);
    ({ resources, renderer, cvars, builtins, gl } = fixture);
    if (fastPath) cvars.set("r_ignoreFastPath", "0", true);
    return resources.loadWorld(name);
  };
  const submit = (prepare: SourcePreparedViews) => {
    const result = fixture.submit(prepare);
    resources.rolloverFrame();
    return result;
  };
  const world = await resources.loadWorld("dlight-test"), refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
  const light = { origin: { x: 32, y: -12, z: 0 }, radius: 256, color: { x: 1, y: 0, z: 0 } };
  const dlightImage = builtins.find("*dlight")?.image;
  if (dlightImage === undefined) throw new Error("missing source dlight image");
  const lightPasses = (views: ReturnType<typeof submit>) => views.flatMap(view => view.batches).filter(batch => batch.texture.kind === "bind-image" && batch.texture.image === builtins.find("*dlight")?.image);
  submit(world.prepareFrame({ refdef })); const unlit = renderer.pixels.slice(), nativeUnlit = gl === null ? null : { renderer: gl, pixels: gl.readPixels() };
  const lit = lightPasses(submit(world.prepareFrame({ refdef, dynamicLights: [light] })));
  expect(lit).toHaveLength(1); expect(lit[0]?.state.depthTest).toBe("equal");
  expect(renderer.pixels).not.toEqual(unlit);
  if (nativeUnlit !== null) expect(nativeUnlit.renderer.readPixels()).not.toEqual(nativeUnlit.pixels);
  const ordinary = renderer.pixels.slice();
  const full = [...Array.from({ length: 31 }, () => ({ ...light, origin: { x: 9999, y: 9999, z: 9999 }, radius: 1 })), light];
  expect(lightPasses(submit(world.prepareFrame({ refdef, dynamicLights: full })))).toHaveLength(1);
  expect(renderer.pixels).toEqual(ordinary);
  cvars.set("r_dynamiclight", "0");
  expect(lightPasses(submit(world.prepareFrame({ refdef, dynamicLights: [light] })))).toHaveLength(0);
  expect(renderer.pixels).toEqual(unlit);
  cvars.set("r_dynamiclight", "1");
  const entity = createModelEntity(world.inlineModel(0)); entity.origin = { x: 100, y: 0, z: 0 }; entity.axis = anglesToAxis({ x: 0, y: 90, z: 0 });
  const inlineView = { ...cameraRefdef({ origin: entity.origin, angles: { x: 0, y: 90, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const inlineLights = lightPasses(submit(world.prepareFrame({ refdef: inlineView, entities: [entity], dynamicLights: [{ ...light, origin: { x: 112, y: 32, z: 0 } }] })));
  expect(inlineLights).toHaveLength(1);
  expect(inlineLights[0]?.vertices[0]?.texCoord).toEqual({ x: 0.5, y: 0.515625 });
  const portalWorld = await nextWorld("dlight-portal");
  const firstPerson = createModelEntity(portalWorld.inlineModel(0)); firstPerson.origin = { x: 100, y: 0, z: 0 }; firstPerson.renderFlags = RF_FIRST_PERSON;
  firstPerson.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  const portal = createPortalEntity(); portal.origin = { x: 32, y: 0, z: 0 }; portal.oldOrigin = portal.origin;
  const portalPoly = { shader: await resources.registerShader("test/portal"),
    vertices: [[-16, -16], [16, -16], [16, 16], [-16, 16]].map(([y, z]) => {
      if (y === undefined || z === undefined) throw new Error("missing portal fixture coordinate");
      return { position: { x: 32, y, z }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } };
    }) };
  const portalFrame = { refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL }, entities: [portal, firstPerson], polys: [portalPoly],
    dynamicLights: [{ ...light, origin: { x: 132, y: -12, z: 0 }, radius: 512 }] };
  cvars.set("r_noportals", "1");
  // Source shortsort swaps the equal-key inline faces: local x64 precedes x32.
  expect(lightPasses(submit(portalWorld.prepareFrame(portalFrame)))[0]?.vertices[0]?.texCoord.x).toBe(0.4375);
  cvars.set("r_noportals", "0");
  const childReset = submit(portalWorld.prepareFrame(portalFrame));
  expect(childReset).toHaveLength(2);
  // The child resets needDlights before skipping the first-person inline entity.
  // The parent consequently retains world-space light origins from the portal poly.
  expect(lightPasses(childReset)[0]?.vertices[0]?.texCoord.x).toBe(0.6328125);
  for (const mapName of ["dlight-fast", "dlight-vertex"]) {
    const optimized = await nextWorld(mapName, true);
    expect(lightPasses(submit(optimized.prepareFrame({ refdef, dynamicLights: [light] })))).toHaveLength(1);
  }
  const translucent = await nextWorld("dlight-translucent");
  expect(lightPasses(submit(translucent.prepareFrame({ refdef, dynamicLights: [light] })))).toHaveLength(0);
  const clouds = await nextWorld("dlight-cloud");
  const cloudLights = lightPasses(submit(clouds.prepareFrame({ refdef, dynamicLights: [{ ...light, radius: 8192 }] })));
  expect(cloudLights.length).toBeGreaterThan(0);
  expect(batchesBetweenDepthCalls(fixture.submittedEvents, [1, 1]).filter(batch => cloudLights.includes(batch))).toEqual(cloudLights);
  const sky = await nextWorld("dlight-sky");
  expect(lightPasses(submit(sky.prepareFrame({ refdef, dynamicLights: [{ ...light, radius: 8192 }] })))).toHaveLength(0);
  const culledFaces = await nextWorld("dlight-cull-face");
  expect(submit(culledFaces.prepareFrame({ refdef, dynamicLights: [light] })).flatMap(view => view.batches)).toHaveLength(0);
  cvars.set("r_facePlaneCull", "0");
  expect(lightPasses(submit(culledFaces.prepareFrame({ refdef, dynamicLights: [light] })))).toHaveLength(1);
  cvars.set("r_facePlaneCull", "1");
  const visibleTriangles = await nextWorld("dlight-cull-tris");
  expect(lightPasses(submit(visibleTriangles.prepareFrame({ refdef, dynamicLights: [light] })))).toHaveLength(1);
  const reversed = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 180, z: 0 } }, 320, 240);
  expect(submit(visibleTriangles.prepareFrame({ refdef: reversed, dynamicLights: [light] })).flatMap(view => view.batches)).toHaveLength(0);
  cvars.set("r_nocull", "1");
  expect(lightPasses(submit(visibleTriangles.prepareFrame({ refdef: reversed, dynamicLights: [light] })))).toHaveLength(1);
});

test.skipIf(dataPath === undefined)("retail projected dynamic lights change actual CPU and GL pixels and restore the unlit scene", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const { resources, renderer, submit, builtins, cvars, gl } = await worldRenderer(files, { kind: "unaccounted" }, true);
  const world = await resources.loadWorld("q3dm1"), camera = world.initialCamera(), refdef = cameraRefdef(camera, 320, 240);
  const light = { origin: { x: camera.origin.x, y: camera.origin.y, z: camera.origin.z + 24 }, radius: 500, color: { x: 1, y: 0.25, z: 0.125 } };
  submit(world.prepareFrame({ refdef })); const unlit = renderer.pixels.slice(), native = gl === null ? null : { renderer: gl, unlit: gl.readPixels() };
  const lit = submit(world.prepareFrame({ refdef, dynamicLights: [light] })).flatMap(view => view.batches);
  const passes = lit.filter(batch => batch.texture.kind === "bind-image" && batch.texture.image === builtins.find("*dlight")?.image);
  expect(passes.length).toBeGreaterThan(0);
  expect(passes.every(batch => batch.state.depthTest === "equal" && !batch.state.depthWrite && batch.state.blend.source === "dst-color")).toBe(true);
  const changed = (before: Uint8Array, after: Uint8Array): number => {
    let count = 0; for (let index = 0; index < before.length; index += 4) if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2]) count++;
    return count;
  };
  const cpuChanged = changed(unlit, renderer.pixels), glChanged = native === null ? null : changed(native.unlit, native.renderer.readPixels());
  expect(cpuChanged).toBeGreaterThan(0); if (glChanged !== null) expect(glChanged).toBeGreaterThan(0);
  const additive = submit(world.prepareFrame({ refdef, dynamicLights: [{ ...light, additive: true }] })).flatMap(view => view.batches)
    .filter(batch => batch.texture.kind === "bind-image" && batch.texture.image === builtins.find("*dlight")?.image);
  expect(additive.length).toBe(passes.length); expect(additive.every(batch => batch.state.blend.source === "one")).toBe(true);
  cvars.set("r_dynamiclight", "0"); submit(world.prepareFrame({ refdef, dynamicLights: [light] }));
  expect(renderer.pixels).toEqual(unlit); if (native !== null) expect(native.renderer.readPixels()).toEqual(native.unlit);
  console.info(`q3dm1 projected dlights: ${passes.length} passes, ${passes.reduce((total, batch) => total + batch.indices.length, 0)} indices, changed pixels CPU=${cpuChanged} GL=${glChanged}`);
  const entity = createModelEntity(await resources.registerModel("models/players/sarge/lower.md3"));
  entity.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  const modelRefdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const modelIndices = (x: number): number => submit(resources.prepareFrame({ refdef: modelRefdef,
    entities: [{ ...entity, origin: { x, y: 0, z: 0 } }] })).flatMap(view => view.batches).reduce((total, batch) => total + batch.indices.length, 0);
  const frontIndices = modelIndices(100);
  expect(frontIndices).toBeGreaterThan(0); expect(modelIndices(-1000)).toBe(0);
  cvars.set("r_nocull", "1"); expect(modelIndices(-1000)).toBe(frontIndices);
  cvars.set("r_nocull", "0"); expect(modelIndices(-1000)).toBe(0);
}, 30000);

test.skipIf(dataPath === undefined)("retail MD3 stencil shadows render through actual CPU and GL with source caster gates", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const fixture = await worldRenderer(files, { kind: "unaccounted" }, true, 8);
  const world = await fixture.resources.loadWorld("q3dm1"), camera = world.initialCamera(), refdef = cameraRefdef(camera, 320, 240);
  const entity = createModelEntity(await fixture.resources.registerModel("models/players/sarge/lower.md3"));
  entity.customSkin = await fixture.resources.registerSkin("models/players/sarge/lower_default.skin");
  entity.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  entity.origin = { x: camera.origin.x + refdef.viewAxis[0].x * 100, y: camera.origin.y + refdef.viewAxis[0].y * 100, z: camera.origin.z - 24 };
  const frame = { refdef, entities: [entity] };
  fixture.cvars.set("cg_shadows", "0"); fixture.submit(world.prepareFrame(frame));
  const unlit = fixture.renderer.pixels.slice(), nativeUnlit = fixture.gl?.readPixels();
  fixture.cvars.set("cg_shadows", "2"); fixture.submit(world.prepareFrame(frame));
  const operations = fixture.preparedViews.flatMap(view => view.operations), volumes = operations.filter(operation => operation.kind === "shadow-volume");
  expect(volumes.length).toBeGreaterThan(0); expect(volumes.some(volume => volume.indices.length > 0)).toBe(true);
  expect(operations.slice(-2).map(operation => operation.kind)).toEqual(["shadow-finish", "render-flares"]);
  const changed = (before: Uint8Array, after: Uint8Array): number => {
    let count = 0; for (let index = 0; index < before.length; index += 4) if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2]) count++;
    return count;
  };
  const cpuChanged = changed(unlit, fixture.renderer.pixels), glChanged = fixture.gl === null || nativeUnlit === undefined ? null : changed(nativeUnlit, fixture.gl.readPixels());
  console.info(`q3dm1 stencil shadows: ${volumes.length} volumes, ${volumes.reduce((sum, volume) => sum + volume.indices.length, 0)} indices, changed pixels CPU=${cpuChanged} GL=${glChanged}`);
  expect(cpuChanged).toBeGreaterThan(0); if (glChanged !== null) expect(glChanged).toBeGreaterThan(0);
  for (const renderFlags of [RF_NOSHADOW, RF_DEPTHHACK, RF_THIRD_PERSON]) {
    fixture.submit(world.prepareFrame({ ...frame, entities: [{ ...entity, renderFlags }] }));
    expect(fixture.preparedViews.flatMap(view => view.operations).some(operation => operation.kind === "shadow-volume")).toBe(false);
  }
  const marker = await fixture.resources.registerShader("white");
  expect(marker).not.toBeNull();
  await fixture.resources.remapShader("white", "<stencil shadow>", null);
  const submittedShadowDepthCalls = () => fixture.preparedViews.flatMap(view => view.operations)
    .filter(operation => operation.kind === "depth-range" || operation.kind === "shadow-volume" || operation.kind === "shadow-finish")
    .map(operation => operation.kind === "depth-range" ? operation.range : operation.kind);
  fixture.submit(world.prepareFrame({ ...frame, entities: [{ ...entity, renderFlags: RF_DEPTHHACK | RF_NOSHADOW, customShader: marker }] }));
  expect(submittedShadowDepthCalls()).toEqual([[1, 1], [0, 1], [0, 0.3], "shadow-volume", [0, 1], "shadow-finish"]);
  const skyName = world.map.shaders.find(shader => (shader.surfaceFlags & 4) !== 0)?.name;
  if (skyName === undefined) throw new Error("q3dm1 has no source sky shader");
  const skySprite = createSpriteEntity(); skySprite.origin = entity.origin; skySprite.radius = 16; skySprite.renderFlags = RF_DEPTHHACK;
  skySprite.customShader = await fixture.resources.registerShader(skyName);
  fixture.submit(world.prepareFrame({ refdef: { ...refdef, renderFlags: RDF_NOWORLDMODEL },
    entities: [skySprite, { ...entity, renderFlags: RF_DEPTHHACK | RF_NOSHADOW, customShader: marker }] }));
  expect(submittedShadowDepthCalls()).toEqual([[0, 0.3], [1, 1], [0, 1], "shadow-volume", [0, 1], "shadow-finish"]);
}, 30000);

test.skipIf(dataPath === undefined)("retail base and Team Arena portal and mirror views reach both backends", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const cases = [
    { product: "baseq3", map: "q3tourney6", origin: { x: 812, y: 328, z: 496 }, camera: null,
      viewer: { origin: { x: 832, y: 336, z: 600 }, angles: { x: 90, y: 0, z: 0 } } },
    { product: "baseq3", map: "q3dm0", origin: { x: -1152, y: -1816, z: 48 },
      camera: { origin: { x: 188, y: -376, z: 72 }, target: { x: 188, y: -296, z: 68 }, roll: 180 },
      viewer: { origin: { x: -1152, y: -1776, z: 56 }, angles: { x: 0, y: 270, z: 0 } } },
    { product: "missionpack", map: "mpteam4", origin: { x: 640, y: 1984, z: 116 },
      camera: { origin: { x: 1220, y: -1352, z: -184 }, target: { x: 1276, y: -1404, z: -188 }, roll: 90 },
      viewer: { origin: { x: 640, y: 2070, z: 116 }, angles: { x: 0, y: 270, z: 0 } } },
  ] satisfies readonly { product: "baseq3" | "missionpack"; map: string; origin: Vec3;
    camera: { origin: Vec3; target: Vec3; roll: number } | null; viewer: WorldCamera }[];
  for (const fixture of cases) {
    const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: fixture.product });
    const { resources, renderer, submit, cvars, gl, builtins } = await worldRenderer(files, { kind: "unaccounted" }, true);
    const world = await resources.loadWorld(fixture.map), portal = createPortalEntity();
    expect(world.map.entityRecords.some(entity => entity.get("classname") === "misc_portal_surface"
      && entity.get("origin") === `${fixture.origin.x} ${fixture.origin.y} ${fixture.origin.z}`)).toBe(true);
    portal.origin = fixture.origin; portal.oldOrigin = fixture.camera === null ? fixture.origin : fixture.camera.origin;
    if (fixture.camera !== null) {
      const forward = byteToDirection(directionToByte(normalize3(sub3(fixture.camera.target, fixture.camera.origin))));
      const side = scale3(perpendicularVector(forward), -1);
      portal.axis = [forward, side, cross3(forward, side)]; portal.oldFrame = 1; portal.skinNum = fixture.camera.roll;
    }
    const frame = { refdef: cameraRefdef(fixture.viewer, 320, 240), entities: [portal] };
    const views = submit(world.prepareFrame(frame));
    expect(views).toHaveLength(2); expect(views[0]?.state.clipPlane).toBeDefined(); expect(views[1]?.state.clipPlane).toBeUndefined();
    expect(views[0]?.batches.length).toBeGreaterThan(1);
    const reflected = renderer.pixels.slice();
    if (gl !== null) {
      const native = gl.readPixels(); let difference = 0;
      for (const [index, value] of native.entries()) {
        const cpu = reflected[index]; if (cpu === undefined) throw new Error("missing CPU portal pixel");
        difference += Math.abs(value - (index % 4 === 3 && gl.alphaBits === 0 ? 255 : cpu));
      }
      expect(difference / native.length).toBeLessThan(5);
    }
    cvars.set("r_noportals", "1");
    expect(submit(world.prepareFrame(frame))).toHaveLength(1);
    let changed = 0;
    for (const [index, value] of reflected.entries()) if (renderer.pixels[index] !== value) changed++;
    expect(changed).toBeGreaterThan(100);
    expect(world.diagnostics).not.toContain("portal views are not implemented");
    cvars.set("r_noportals", "0");
    const lighted = submit(world.prepareFrame({ ...frame, dynamicLights: [
      { origin: fixture.camera?.origin ?? fixture.viewer.origin, radius: 10000, color: { x: 0.05, y: 0.05, z: 0.05 } },
    ] }));
    expect(lighted).toHaveLength(2); expect(lighted[0]?.state.clipPlane).toEqual(views[0]?.state.clipPlane);
    expect(lighted[0]?.batches.some(batch => batch.texture.kind === "bind-image" && batch.texture.image === builtins.find("*dlight")?.image)).toBe(true);
  }
}, 30000);
test.skipIf(dataPath === undefined)("retail stitched brush curves use live distance LOD on CPU/GL and full grids for marks and hunk reservations", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const accounting = new SourceHunkAccounting(new HunkArena(64 * 1048576, () => {}));
  const { resources, renderer, submit, cvars, gl } = await worldRenderer(assets, { kind: "source-hunk", accounting }, true);
  const world = await resources.loadWorld("mpteam5");
  const grids = world.markGeometry.surfaces.filter(surface => surface.kind === "grid");
  expect(grids.length).toBeGreaterThan(0);
  const reservations = accounting.report();
  expect(reservations.missingComponents.some(component => component.startsWith("final stitched grids:"))).toBe(false);
  expect(reservations.trace.filter(event => event.source === "R_MovePatchSurfacesToHunk:grid").map(event => event.bytes)).toEqual(
    grids.map(grid => (grid.mesh.width * grid.mesh.height - 1) * SOURCE_HUNK_RELEASE32.drawVertex + SOURCE_HUNK_RELEASE32.grid));
  expect(world.diagnostics.some(message => message.includes("patch LOD"))).toBe(false);
  const entity = createModelEntity(world.inlineModel(2));
  entity.origin = { x: 200, y: 0, z: 0 }; entity.axis = anglesToAxis({ x: 0, y: 90, z: 0 });
  const refdef = { ...cameraRefdef({ origin: { x: 0, y: 0, z: 90 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  cvars.set("r_lodCurveError", "25");
  const near = submit(world.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
  expect(renderer.pixels.some((value, index) => index % 4 !== 3 && value > 20)).toBe(true);
  if (gl !== null) {
    const pixels = gl.readPixels();
    expect(pixels.some((value, index) => index % 4 !== 3 && value > 20)).toBe(true);
    let difference = 0;
    for (const [index, value] of pixels.entries()) {
      const cpu = renderer.pixels[index]; if (cpu === undefined) throw new Error("missing CPU pixel");
      difference += Math.abs(value - cpu);
    }
    expect(difference / pixels.length).toBeLessThan(5);
  }
  const far = submit(world.prepareFrame({ refdef, entities: [{ ...entity, origin: { x: 1200, y: 0, z: 0 } }] })).flatMap(view => view.batches);
  const count = (batches: typeof near) => batches.reduce((sum, batch) => sum + batch.indices.length, 0);
  expect(count(far)).toBeGreaterThan(0); expect(count(far)).toBeLessThan(count(near));
  cvars.set("r_nocurves", "1");
  const withoutCurves = submit(world.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
  expect(count(withoutCurves)).toBeLessThan(count(near));
  cvars.set("r_nocull", "1");
  const uncull = submit(world.prepareFrame({ refdef, entities: [entity] })).flatMap(view => view.batches);
  expect(count(uncull)).toBeGreaterThanOrEqual(count(near));
  cvars.set("r_nocull", "0"); cvars.set("r_nocurves", "0");
  cvars.set("r_lodCurveError", "250");
  const prepared = world.prepareFrame({ refdef, entities: [entity] });
  cvars.set("r_lodCurveError", "0");
  const coarse = submit(prepared).flatMap(view => view.batches);
  expect(count(coarse)).toBeLessThan(count(near));
  expect(accounting.report()).toEqual(reservations);
}, 30000);
test.skipIf(dataPath === undefined)("retail base and Team Arena scenes load and frame without further reads", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const cases: readonly { product: "baseq3" | "missionpack"; mapName: string }[] = [
    { product: "baseq3", mapName: "q3dm1" }, { product: "missionpack", mapName: "mpteam1" },
  ];
  for (const { product, mapName } of cases) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    let reads = 0;
    const fixture = await worldRenderer({ read: path => { reads++; return vfs.read(path); },
      readFileRetained: path => { reads++; return vfs.readFileRetained(path); }, readFileRetainedSync: path => vfs.readFileRetainedSync(path), freeFile: buffer => { vfs.freeFile(buffer); },
      readFileLength: path => vfs.readFileLength(path), readFileOptional: path => { reads++; return vfs.readFileOptional(path); }, has: path => vfs.has(path), list: prefix => vfs.list(prefix) });
    const { resources, renderer, submit, clock } = fixture;
    const world = await resources.loadWorld(mapName);
    const before = reads, camera = world.initialCamera();
    const first = submit(world.prepareFrame({ refdef: cameraRefdef(camera, 320, 240) }));
    expect(first.length).toBeGreaterThan(0);
    const sky = batchesBetweenDepthCalls(fixture.submittedEvents, [1, 1]).filter(batch => batch.vertices.length > 0);
    expect(sky.length).toBeGreaterThan(0);
    expect(world.diagnostics.some(message => /unsupported sky|unsupported deform (autosprite|autosprite2|normal)/.test(message))).toBe(false);
    clock.time = 1000;
    submit(world.prepareFrame({ refdef: cameraRefdef(camera, 320, 240, 1000) }));
    const laterSky = batchesBetweenDepthCalls(fixture.submittedEvents, [1, 1]).filter(batch => batch.vertices.length > 0);
    expect(laterSky.map(batch => batch.vertices.map(vertex => vertex.texCoord))).not.toEqual(sky.map(batch => batch.vertices.map(vertex => vertex.texCoord)));
    expect(submit(world.prepareFrame({ refdef: cameraRefdef(camera, 320, 240) }))).toEqual(first);
    expect(reads).toBe(before);
    let visiblePixels = 0;
    for (let index = 0; index < renderer.pixels.length; index += 4) {
      if (renderer.pixels[index] !== 0 || renderer.pixels[index + 1] !== 0 || renderer.pixels[index + 2] !== 0) visiblePixels++;
    }
    expect(visiblePixels).toBeGreaterThan(320 * 240 * 0.75);
    for (const batch of first.flatMap(view => view.batches)) for (const vertex of batch.vertices) {
      expect([vertex.position.x, vertex.position.y, vertex.position.z, vertex.position.w, vertex.texCoord.x, vertex.texCoord.y].every(Number.isFinite)).toBe(true);
    }
  }
});

test.skipIf(dataPath === undefined)("retail fog volume emits depth-tested passes inside and outside its visible plane", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const { resources, submit, builtins } = await worldRenderer(vfs);
  const world = await resources.loadWorld("q3tourney5"), camera = world.initialCamera();
  expect(builtins.forImage(builtins.fogImage)?.wrap).toBe("clamp");
  expect(world.map.fogs.length).toBeGreaterThan(0);
  const volume = world.map.fogs[0];
  if (volume === undefined) throw new Error("Missing actual registered fog volume");
  expect(world.diagnostics.some(message => /fog passes are not implemented|missing fogparms/.test(message))).toBe(false);
  const views = [camera, { origin: { ...camera.origin, z: volume.bounds.max.z + 32 }, angles: { ...camera.angles, x: 30 } }];
  const coordinateSets: number[][] = [];
  for (const view of views) {
    const renderedViews = submit(world.prepareFrame({ refdef: cameraRefdef(view, 320, 240), dynamicLights: [
      { origin: view.origin, radius: 10000, color: { x: 0.1, y: 0.1, z: 0.1 } },
    ] }));
    const ordered = renderedViews.flatMap(view => view.batches);
    expect(ordered.some((batch, index) => {
      const previous = ordered[index - 1];
      return batch.texture.kind === "bind-image" && batch.texture.image === builtins.fogImage
        && previous?.texture.kind === "bind-image" && previous.texture.image === builtins.find("*dlight")?.image;
    })).toBe(true);
    const passes = renderedViews.flatMap(view => view.batches).filter(batch => batch.texture.kind === "bind-image"
      && batch.texture.image === builtins.fogImage && batch.texture.image.sourceWidth === 256 && batch.texture.image.sourceHeight === 32
      && batch.state.blend.source === "src-alpha");
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every(batch => !batch.state.depthWrite && batch.state.alphaTest === "none"
      && (batch.state.depthTest === "equal" || batch.state.depthTest === "less-equal"))).toBe(true);
    coordinateSets.push(passes.flatMap(batch => batch.vertices.map(vertex => vertex.texCoord.y)));
  }
  expect(coordinateSets[0]).not.toEqual(coordinateSets[1]);
});
