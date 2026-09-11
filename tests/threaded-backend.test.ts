// Source thread ordering from tr_cmds.c and RB_RenderThread, with actual Bun workers.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import type { BspVertex } from "../src/assets/bsp.ts";
import { SourceBackendMemory } from "../src/render/backend-memory.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { ShaderCinematicSource } from "../src/render/cinematic-command.ts";
import { UI_PICTURE_STATE } from "../src/render/draw2d.ts";
import { SOURCE_DRAW_ENTITY_WORLD, SourceDrawSurfaces } from "../src/render/draw-surfaces.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import type { MaterialRecord } from "../src/render/material-registry.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission } from "../src/render/scene-submission.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { viewProjection } from "../src/render/view.ts";
import type { WorldBackendResolvedView, WorldBackendSurface } from "../src/render/world-backend.ts";
import { ThreadedBackend } from "../src/render/threaded-backend.ts";
import { ThreadedRendererBackend } from "../src/render/threaded-backend-proxy.ts";
import { ThreadedCommandBridge } from "../src/render/threaded-command-runtime.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { cameraRefdef } from "./refdef-fixture.ts";

async function fixture(milliseconds: () => number = () => 0,
  diagnostics: { readonly print?: (text: string) => undefined; readonly showSmp?: () => boolean } = {}) {
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const white = builtins.find("*white");
  if (white === undefined) throw new Error("Missing white fixture image");
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const definition = parseShaderScript("solid { cull none { map $whiteimage rgbGen vertex } }")[0];
  if (definition === undefined) throw new Error("Missing fixture material");
  const registry = new MaterialRegistry(async () => ({ definition, image: white.image, whiteImage: white.image, defaulted: false, sky: null,
    finished: finishShader({ definition, lightmapIndex: -1, images: [{ kind: "loaded", tmu: 0,
      binding: { kind: "images", playback: { kind: "single", image: { image: white.image } } } }], profile: settings.registrationProfile() }) }), () => undefined);
  const material = await registry.register("solid", { kind: "vertex" });
  let bridge: ThreadedCommandBridge | null = null;
  let ownedBackend: ThreadedRendererBackend | null = null;
  const cinematicSources = new Map<number, ShaderCinematicSource>();
  const thread = await ThreadedBackend.open({ kind: "cpu", textureFilter: images.textureFilter, width: 8, height: 8,
    subpixelBits: 8, stencilBits: 0, alphaBits: 8 }, {
    request(payload) {
      if (bridge === null) throw new Error("Unexpected source callback before fixture initialization");
      if (typeof payload === "object" && payload !== null && "kind" in payload && typeof payload.kind === "string" && payload.kind.startsWith("source-"))
        return bridge.request(payload);
      if (ownedBackend === null) throw new Error("Unexpected backend callback before fixture initialization");
      return ownedBackend.handleHostRequest(payload, {
        cinematic(id) { const source = cinematicSources.get(id); if (source === undefined) throw new Error("Unknown fixture cinematic"); return source; },
        print: () => { throw new Error("Unexpected backend print"); }, textureMode: () => { throw new Error("Unexpected texture mode callback"); },
        presentPixels: () => { throw new Error("Unexpected fixture CPU publication"); },
      });
    },
    completed(payload) { if (bridge === null) throw new Error("Unexpected source completion"); bridge.completed(payload); },
  }, 3000);
  const backend = new ThreadedRendererBackend(thread, images, thread.description, source => {
    for (const [id, prior] of cinematicSources) if (source === prior) return id;
    const id = cinematicSources.size + 1; cinematicSources.set(id, source); return id;
  });
  ownedBackend = backend;
  const target = new RenderTarget(images, [backend]), tess = new SourceTessState();
  const hunk = new HunkArena(1024 * 1024, () => undefined);
  bridge = new ThreadedCommandBridge({ thread, backend, settings, tess, clock: { milliseconds }, performanceClock: { milliseconds },
    temporaryMemory: hunk, identityLight: () => 1, backendMaterials: () => ({ defaultMaterial: material, flareMaterial: material, sunMaterial: material }),
    print: diagnostics.print ?? (text => { throw new Error(`Unexpected renderer print: ${text}`); }),
    showSmp: diagnostics.showSmp ?? (() => false), debugBuild: false });
  const commands = new RenderCommandBuffer(target, { clock: { milliseconds }, identityLight: 1, tess, runtime: settings.runtime,
    print: () => undefined, thread: bridge });
  const picture = { kind: "image", name: "white", texture: { kind: "bind-image", image: white.image }, state: UI_PICTURE_STATE,
    color: { rgb: "vertex", alpha: "vertex" } } satisfies import("../src/render/picture-material.ts").ImagePicture;
  return { thread, backend, target, commands, bridge, images, material, picture, tess, cvars, hunk,
    close() { commands.close("discard"); try { bridge.close(); } finally { target.close(); } } };
}

test("source command issue overlaps next frontend work and waits only at synchronization", async () => {
  const events: string[] = [];
  let frontendAdvanced = false;
  const f = await fixture(() => { events.push(frontendAdvanced ? "backend-after-frontend" : "backend-too-early"); return 0; });
  try {
    const draw = f.commands.draw2D("pixels");
    f.commands.beginFrame(); draw.setColor({ x: 1, y: 0, z: 0, w: 1 });
    draw.drawPic({ x: 0, y: 0, width: 8, height: 8 }, f.picture);
    f.commands.submitFrame(() => { events.push("present"); return undefined; });
    expect(events).toEqual([]);
    frontendAdvanced = true;
    draw.setColor({ x: 0, y: 1, z: 0, w: 1 });
    f.bridge.synchronize();
    expect(events.includes("backend-too-early")).toBe(false);
    expect(events.includes("present")).toBe(true);
    expect([...f.backend.readPixels().subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    draw.drawPic({ x: 0, y: 0, width: 8, height: 8 }, f.picture);
    f.commands.submitFrame(); f.bridge.synchronize();
    expect([...f.backend.readPixels().subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  } finally { f.close(); }
});

test("raw cinematic capture and completion stay behind the actual worker finish barrier", async () => {
  const f = await fixture(), events: string[] = [];
  try {
    f.commands.draw2D("pixels").setColor({ x: 1, y: 0, z: 0, w: 1 });
    f.commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 8, height: 8 }, f.picture);
    f.commands.stretchRaw({ x: 0, y: 0, width: 8, height: 8 }, { image: f.picture.texture.image,
      sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
      captureAfterBarrier: () => {
        events.push("capture");
        return { upload: { image: f.picture.texture.image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
          content: new RgbaSnapshot(1, 1, new Uint8Array([10, 120, 200, 255])), dirty: true }, afterUiDraw: () => { events.push("complete"); } };
      } });
    expect(events).toEqual(["capture", "complete"]);
    expect([...f.backend.readPixels().subarray(0, 4)]).toEqual([10, 120, 200, 255]);
  } finally { f.close(); }
});

test("worker completes real drawing while the frontend continues without a synchronization call", async () => {
  const f = await fixture();
  let presented = false, frontendIterations = 0;
  try {
    f.commands.beginFrame(); f.commands.draw2D("pixels").setColor({ x: 0, y: 0, z: 1, w: 1 });
    f.commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 8, height: 8 }, f.picture);
    f.commands.submitFrame(() => { presented = true; });
    const deadline = performance.now() + 2000;
    while (!presented && performance.now() < deadline) {
      for (let i = 0; i < 256; i++) frontendIterations++;
      await Bun.sleep(1);
    }
    expect(presented).toBe(true);
    expect(frontendIterations).toBeGreaterThan(0);
    expect([...f.backend.readPixels().subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  } finally { f.close(); }
});

test("actual worker owns world tessellation and detached frontend view memory", async () => {
  const f = await fixture();
  try {
    const limits = { maxPolys: 4, maxPolyVertices: 1200 }, memory = SourceBackendMemory.local(limits);
    const entities = new SourceSceneEntities(memory);
    const submission = new SourceSceneSubmission(entities, limits, { fogBounds: () => [], developerEnabled: () => false, print: () => undefined },
      { kind: "source", backend: memory, shaderHandle: () => f.material.order });
    const vertex = (y: number, z: number): BspVertex => ({ position: { x: 32, y, z }, normal: { x: -1, y: 0, z: 0 },
      texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } });
    const surface: WorldBackendSurface = { kind: "surface", writer: "poly", mesh: { vertices: [vertex(-16, -16), vertex(16, -16), vertex(0, 16)], indices: [0, 1, 2] },
      plane: { kind: "triangle" }, grid: null, material: f.material, fog: -1, entity: null, entityOrder: SOURCE_DRAW_ENTITY_WORLD, lighting: null };
    const draws = new SourceDrawSurfaces<WorldBackendSurface>(memory);
    draws.add(surface, f.material.sortedIndex, SOURCE_DRAW_ENTITY_WORLD, 0, 0);
    const drawRange = draws.viewRange(0), refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 8, 8, 1250);
    refdef.renderFlags = RDF_NOWORLDMODEL;
    const view: WorldBackendResolvedView = { refdef, projection: viewProjection(refdef, 4096, 4), mirror: false, portal: null, viewFar: 4096,
      smpFrame: 1, scene: { frameCount: 1, frameSceneNum: 1 }, capture: submission.captureScene(), dlights: { lights: [], transformed: null },
      world: { fogs: [], fogTexture: null }, drawRange, flushBeforeView: false, surface: index => drawRange.surface(index), surfaceDlightBits: () => 0 };
    f.commands.addPreparedViews(Object.assign(() => { throw new Error("World backend executed on the frontend"); }, {
      captureThreadedView: () => f.bridge.worldTransport.capture(view, drawRange),
    }), drawRange);
    f.commands.submit();
    refdef.viewOrigin = { x: 4096, y: 0, z: 0 };
    f.bridge.synchronize();
    expect(f.tess.numVertexes).toBe(0);
    expect(f.tess.performance.backEnd.c_surfaces).toBe(1);
    expect(f.tess.performance.backEnd.c_indexes).toBe(3);
    expect([...f.backend.readPixels().subarray((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4)]).toEqual([255, 255, 255, 255]);
    expect(f.backend.readDepthPixel(4, 4)).toBeLessThan(1);
  } finally { f.close(); }
});

test("source failure publishes already-drawn backend counters before rethrowing", async () => {
  const f = await fixture(), error = new CommonError("drop", "fixture presentation failure");
  f.commands.beginFrame(); f.commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 8, height: 8 },
    { kind: "material", name: f.material.name, material: f.material });
  f.commands.submitFrame(() => { throw error; });
  expect(() => f.bridge.synchronize()).toThrow(error);
  expect(f.tess.performance.backEnd.c_indexes).toBe(6);
  expect(f.tess.performance.backEnd.c_shaders).toBe(1);
  expect(() => f.close()).toThrow(error);
});

test("worker callback failure preserves the actual source error and never replays the frame", async () => {
  const error = new CommonError("drop", "fixture source clock failure");
  let reads = 0;
  const f = await fixture(() => { reads++; throw error; });
  f.commands.beginFrame(); f.commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 8, height: 8 }, f.picture);
  f.commands.submitFrame();
  expect(() => f.bridge.synchronize()).toThrow(error);
  expect(() => f.bridge.synchronize()).toThrow(error);
  expect(reads).toBe(1);
  expect(() => f.close()).toThrow(error);
  expect(() => f.thread.close()).not.toThrow();
});

for (const asynchronous of [false, true]) test(`completion callback failures are sticky at the first barrier (asynchronous=${asynchronous})`, async () => {
  const error = new CommonError("drop", "fixture completion failure");
  let completed = 0;
  const thread = await ThreadedBackend.open({ kind: "cpu", width: 2, height: 2, subpixelBits: 8, stencilBits: 0, alphaBits: 8, textureFilter: "nearest" }, {
    request() { throw new Error("Unexpected host request"); },
    completed() { completed++; throw error; },
  }, 1000);
  thread.issue({ kind: "backend", method: "finish" });
  if (asynchronous) {
    const deadline = performance.now() + 1000;
    while (completed === 0 && performance.now() < deadline) await Bun.sleep(1);
  }
  expect(() => thread.synchronize()).toThrow(error);
  expect(() => thread.synchronize()).toThrow(error);
  expect(completed).toBe(1);
  expect(() => thread.close()).toThrow(error);
  expect(() => thread.close()).not.toThrow();
});

test("source SMP markers read real backend activity before the source wait", async () => {
  const markers: string[] = [];
  let sample: () => undefined = () => undefined, sampled = false;
  const f = await fixture(() => { if (!sampled) { sampled = true; sample(); } return 0; }, {
    print: text => { markers.push(text); }, showSmp: () => true,
  });
  sample = () => { f.bridge.beforeIssue(); };
  try {
    f.commands.submit();
    expect(markers).toEqual(["."]);
    f.bridge.synchronize();
    expect(markers).toEqual([".", "R"]);
  } finally { f.close(); }
});

test("observed source failure retires permanently and frees only its outstanding real hunk temporary", async () => {
  const f = await fixture();
  try {
    expect(f.bridge.retireAfterFailure()).toBe(false);
    f.cvars.set("r_measureOverdraw", "1", true);
    f.commands.submitFrame();
    expect(() => f.bridge.synchronize()).toThrow("CPU stencil readback requires stencil storage");
    const before = f.hunk.snapshot();
    expect(before.low.temp + before.high.temp).toBeGreaterThan(0);
    expect(f.bridge.retireAfterFailure()).toBe(true);
    expect(f.thread.retired).toBe(true);
    const after = f.hunk.snapshot();
    expect(after.low.temp + after.high.temp).toBe(0);
    expect(() => f.thread.call({ kind: "backend", method: "finish" })).toThrow("Render thread is closed");
  } finally { f.close(); }
});

test("worker videoMap reaches main cinematic upload callbacks at the source draw phase", async () => {
  const f = await fixture(), events: string[] = [], pixelsBeforeDraw: number[] = [];
  try {
    f.backend.beginView({ viewport: { x: 0, y: 0, width: 8, height: 8 }, clear: { color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1, stencil: false } });
    const stage = f.material.finished.sourceStages[0], pass = f.material.finished.iterator.passes[0];
    if (stage === undefined || !stage.active || pass === undefined) throw new Error("Missing fixture stage");
    const source: ShaderCinematicSource = { image: f.picture.texture.image, prepareAtExecution() {
      events.push("prepare");
      return { upload: { image: f.picture.texture.image, sourceWidth: 2, sourceHeight: 2, uploadWidth: 2, uploadHeight: 2,
        content: new RgbaSnapshot(2, 2, new Uint8Array([60, 180, 20, 255, 60, 180, 20, 255, 60, 180, 20, 255, 60, 180, 20, 255])), dirty: true }, afterShaderUpload() {
          events.push("uploaded"); pixelsBeforeDraw.push(...f.backend.readPixels().subarray(0, 4));
        } };
    } };
    const video = { ...stage, binding: { kind: "video", source } } satisfies typeof stage;
    const material: MaterialRecord = { ...f.material, name: "fixture-video", order: f.material.order + 1, sortedIndex: f.material.sortedIndex + 1,
      finished: { ...f.material.finished, sourceStages: [video], iterator: { ...f.material.finished.iterator, passes: [{ ...pass, bundles: [video] }] } } };
    f.commands.beginFrame(); f.commands.draw2D("pixels").setColor({ x: 1, y: 1, z: 1, w: 1 });
    f.commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 8, height: 8 }, { kind: "material", name: material.name, material });
    f.commands.submitFrame(() => { events.push("present"); });
    expect(events).toEqual([]);
    f.bridge.synchronize();
    expect(events).toEqual(["prepare", "uploaded", "present"]);
    expect(pixelsBeforeDraw.slice(0, 3)).toEqual([0, 0, 0]);
    expect([...f.backend.readPixels().subarray((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4)]).toEqual([60, 180, 20, 255]);
  } finally { f.close(); }
});
