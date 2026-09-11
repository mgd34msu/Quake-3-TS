// Source expectations: renderer/tr_backend.c and tr_main.c:SurfIsOffscreen.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SourceBackendMemory } from "../src/render/backend-memory.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { packSourceDrawSort, SOURCE_DRAW_ENTITY_WORLD, SourceDrawSurfaces } from "../src/render/draw-surfaces.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { createSpriteEntity } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { RendererResourceReceiver, RendererResourceSender } from "../src/render/renderer-resource-transport.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission } from "../src/render/scene-submission.ts";
import { SceneTransportReceiver, SceneTransportSender } from "../src/render/scene-transport.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { viewProjection } from "../src/render/view.ts";
import { captureWorldBackendView, createWorldBackendRuntime, parseWorldBackendView, resolveWorldBackendView } from "../src/render/world-backend.ts";
import type { WorldBackendResolvedView, WorldBackendSurface } from "../src/render/world-backend.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function vertex(y: number, z: number): BspVertex {
  return { position: { x: 32, y, z }, normal: { x: -1, y: 0, z: 0 }, texCoord: { x: 0, y: 0 },
    lightmapCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } };
}
async function fixture(debugBuild = false, fastSky = false) {
  const settings = createRendererSettings(), images = new RendererImageCatalog();
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const white = builtins.find("*white");
  if (white === undefined) throw new Error("Missing fixture white image");
  const definitions = parseShaderScript("solid { cull none { map $whiteimage rgbGen vertex } }");
  const definition = definitions[0];
  if (definition === undefined) throw new Error("Missing fixture shader");
  const registry = new MaterialRegistry(async () => ({ definition, image: white.image, whiteImage: white.image,
    defaulted: false, sky: null, finished: finishShader({ definition, lightmapIndex: -1,
      images: [{ kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image: white.image } } } }],
      profile: settings.registrationProfile() }) }), () => undefined);
  const material = await registry.register("solid", { kind: "vertex" });
  const alternate = await registry.register("alternate", { kind: "vertex" });
  const limits = { maxPolys: 4, maxPolyVertices: 1200 }, memory = SourceBackendMemory.local(limits);
  const entities = new SourceSceneEntities(memory);
  const submission = new SourceSceneSubmission(entities, limits, { fogBounds: () => [], developerEnabled: () => false, print: () => undefined },
    { kind: "source", backend: memory, shaderHandle: () => material.order });
  const refdef = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 64, 48, 1250);
  refdef.renderFlags = RDF_NOWORLDMODEL;
  const tess = new SourceTessState(), cpu = new SoftwareRenderer(64, 48, images), target = new RenderTarget(images, [cpu]);
  const backendSettings = { runtime: { ...settings.runtime, fastSky: fastSky ? 1 : 0 }, flares: settings.flares, rail: settings.rail };
  const runtime = createWorldBackendRuntime({ tess, settings: backendSettings, builtins, target, identityLight: () => 1, debugBuild,
    print: () => undefined, defaultMaterial: material, flareMaterial: material, sunMaterial: material,
    materialBySortedIndex: index => registry.findBySortedIndex(index) });
  const sender = new RendererResourceSender(images, () => undefined, () => { throw new Error("Unexpected cinematic"); });
  sender.materialHandle(material); sender.materialHandle(alternate);
  const scenes = new SceneTransportSender(sender);
  const remoteImages = new RendererImageCatalog();
  const receiver = new RendererResourceReceiver(remoteImages, () => { throw new Error("Unexpected cinematic"); },
    () => { throw new Error("Unexpected lightmap owner"); });
  const remoteScenes = new SceneTransportReceiver(receiver);
  const remoteTess = new SourceTessState(), remoteCpu = new SoftwareRenderer(64, 48, remoteImages);
  const remoteTarget = new RenderTarget(remoteImages, [remoteCpu]);
  function transfer() {
    receiver.applyJournal(structuredClone(sender.takeJournal()));
    remoteScenes.applyJournal(structuredClone(scenes.takeJournal()));
  }
  transfer();
  const remoteRuntime = createWorldBackendRuntime({ tess: remoteTess, settings: backendSettings, target: remoteTarget, debugBuild,
    builtins: { defaultImage: receiver.resolveImage(builtins.defaultImage.ordinal), find(name) {
      const entry = builtins.find(name);
      return entry === undefined ? undefined : { ...entry, image: receiver.resolveImage(entry.image.ordinal) };
    } }, identityLight: () => 1, print: () => undefined,
    defaultMaterial: receiver.resolveMaterial(material.order), flareMaterial: receiver.resolveMaterial(material.order),
    sunMaterial: receiver.resolveMaterial(material.order), materialBySortedIndex: index => receiver.materialBySortedIndex(index) });
  const commands = new RenderCommandBuffer(target, { tess, runtime: settings.runtime, identityLight: 1,
    clock: { milliseconds: () => 0 }, print: () => undefined });
  const remoteCommands = new RenderCommandBuffer(remoteTarget, { tess: remoteTess, runtime: settings.runtime, identityLight: 1,
    clock: { milliseconds: () => 0 }, print: () => undefined });
  function view(surfaces: readonly WorldBackendSurface[]): WorldBackendResolvedView {
    const draws = new SourceDrawSurfaces<WorldBackendSurface>(memory);
    for (const surface of surfaces) draws.add(surface, surface.material.sortedIndex, surface.entityOrder, surface.fog + 1, 0);
    const drawRange = draws.viewRange(0);
    return { refdef, projection: viewProjection(refdef, 4096, 4), mirror: false, portal: null, viewFar: 4096,
      smpFrame: 1, scene: { frameCount: 1, frameSceneNum: 1 }, capture: submission.captureScene(),
      dlights: { lights: [], transformed: null }, world: { fogs: [], fogTexture: null }, drawRange,
      flushBeforeView: false, surface: index => drawRange.surface(index), surfaceDlightBits: (_index, frame) => frame === 0 ? 17 : 34 };
  }
  function surface(vertices = [vertex(-8, -8), vertex(8, -8), vertex(0, 8)]): WorldBackendSurface {
    return { kind: "surface", writer: "poly", mesh: { vertices, indices: [0, 1, 2] }, plane: { kind: "triangle" },
      grid: null, material, fog: -1, entity: null, entityOrder: SOURCE_DRAW_ENTITY_WORLD, lighting: null };
  }
  return { material, alternate, entities, submission, refdef, tess, cpu, runtime, sender, scenes, receiver,
    remoteScenes, remoteTess, remoteCpu, remoteRuntime, commands, remoteCommands, transfer, view, surface,
    close() { remoteCommands.close("discard"); commands.close("discard"); remoteTarget.close(); target.close(); } };
}

test("owned world packets run the shared lazy backend with identical CPU pixels and captured sort changes", async () => {
  const f = await fixture();
  try {
    const view = f.view([f.surface()]);
    view.drawRange.setSort(0, packSourceDrawSort(f.alternate.sortedIndex, SOURCE_DRAW_ENTITY_WORLD, 0, 0));
    const packet = parseWorldBackendView(structuredClone(captureWorldBackendView(view, f.scenes)));
    f.transfer();
    expect(f.tess.numVertexes).toBe(0);
    expect(f.remoteTess.numVertexes).toBe(0);
    f.commands.addPreparedViews(() => [f.runtime.prepareResolved(view)]); f.commands.submit();
    f.remoteCommands.addPreparedViews(() => f.remoteRuntime.prepare(packet, f.remoteScenes)); f.remoteCommands.submit();
    expect(f.remoteCpu.pixels).toEqual(f.cpu.pixels);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++)
      expect(f.remoteCpu.readDepthPixel(x, y)).toBe(f.cpu.readDepthPixel(x, y));
    expect(f.remoteTess.material?.name).toBe("alternate");
    expect(f.remoteTess.refdefTime).toBe(1250);
    expect(f.remoteTess.performance.backEnd.c_surfaces).toBe(1);
  } finally { f.close(); }
});

test("world packet ownership includes refdef, both retained light-mask banks and scene allocation bytes", async () => {
  const f = await fixture();
  try {
    const source = f.surface();
    if (source.kind !== "surface") throw new Error("Fixture surface kind");
    const view = f.view([{ ...source, worldSurface: 7 }]);
    const packet = structuredClone(captureWorldBackendView(view, f.scenes));
    f.refdef.time = 99; f.refdef.viewOrigin = { x: 100, y: 200, z: 300 };
    f.transfer();
    const resolved = resolveWorldBackendView(packet, f.remoteScenes);
    expect(resolved.refdef.time).toBe(1250);
    expect(resolved.refdef.viewOrigin).toEqual({ x: 0, y: 0, z: 0 });
    expect(resolved.surfaceDlightBits(7, 0)).toBe(17);
    expect(resolved.surfaceDlightBits(7, 1)).toBe(34);
    expect(() => resolved.surfaceDlightBits(8, 0)).toThrow("no captured dynamic-light mask");
    expect(packet.sceneMemory.backend.allocation.bytes.buffer).not.toBe(f.entities.backendMemory.bytes.buffer);
  } finally { f.close(); }
});

test("worker world overflow publishes the earlier draw before retaining the reached source error", async () => {
  const f = await fixture();
  try {
    const view = f.view([f.surface(), f.surface(Array.from({ length: 1000 }, (_, index) => vertex(index % 3, index % 2)))]);
    const packet = structuredClone(captureWorldBackendView(view, f.scenes)); f.transfer();
    f.remoteCommands.addPreparedViews(() => f.remoteRuntime.prepare(packet, f.remoteScenes));
    expect(() => f.remoteCommands.submit()).toThrow("RB_CheckOverflow: verts > MAX (1000 > 1000)");
    expect(f.remoteTess.performance.backEnd.c_shaders).toBe(1);
    expect(f.remoteTess.numIndexes).toBe(0);
    expect(f.remoteTess.numVertexes).toBe(3);
    expect(f.tess.numVertexes).toBe(0);
  } finally { f.close(); }
});

test("worker packet validation rejects malformed nested fields before backend state changes", async () => {
  const f = await fixture();
  try {
    const packet = captureWorldBackendView(f.view([f.surface()]), f.scenes);
    expect(() => parseWorldBackendView({ ...packet, smpFrame: 2 })).toThrow("SMP bank");
    expect(() => parseWorldBackendView({ ...packet, projection: [1, 2] })).toThrow("invalid array");
    expect(() => parseWorldBackendView({ ...packet, refdef: { ...packet.refdef, areaMask: new Uint8Array(31) } })).toThrow("area-mask");
    expect(() => parseWorldBackendView({ ...packet, surfaceDlightBits: [{ surface: 0, bits: [1] }] })).toThrow("invalid array");
    expect(() => parseWorldBackendView({ ...packet, drawSurfaces: [{ sort: -1, surfaceId: 1 }] })).toThrow("outside its range");
    expect(() => parseWorldBackendView({ ...packet, sceneMemory: null })).toThrow();
    expect(f.remoteTess.numVertexes).toBe(0);
    expect(f.remoteTess.refdefTime).toBe(0);
  } finally { f.close(); }
});

for (const debugBuild of [false, true]) test(`fast-sky source debug clear profile ${debugBuild} agrees across backend transport`, async () => {
  const f = await fixture(debugBuild, true);
  try {
    f.refdef.renderFlags = 0;
    const view = f.view([]), packet = captureWorldBackendView(view, f.scenes); f.transfer();
    const expected = debugBuild ? { x: Math.fround(0.8), y: Math.fround(0.7), z: Math.fround(0.4), w: 1 }
      : { x: 0, y: 0, z: 0, w: 1 };
    expect(f.runtime.prepareResolved(view).clear.color).toEqual(expected);
    const remote = Array.from(f.remoteRuntime.prepare(packet, f.remoteScenes))[0];
    if (remote === undefined) throw new Error("Missing transported view");
    expect(remote.clear.color).toEqual(expected);
  } finally { f.close(); }
});

test("worker portal probes use the backend's retained entity pose and leave main tess untouched", async () => {
  const f = await fixture();
  try {
    const sprite = createSpriteEntity();
    sprite.origin = { x: 32, y: 0, z: 0 }; sprite.radius = 4;
    f.entities.addRefEntity(sprite);
    const surface: WorldBackendSurface = { kind: "entity", entity: null, material: f.material, entityOrder: 0, fog: -1 };
    const view = f.view([surface]);
    const packet = structuredClone(captureWorldBackendView(view, f.scenes)); f.transfer();
    f.remoteCommands.addPreparedViews(() => f.remoteRuntime.prepare(packet, f.remoteScenes)); f.remoteCommands.submit();
    const nextSprite = createSpriteEntity();
    nextSprite.origin = { x: 32, y: 50, z: 0 }; nextSprite.radius = 20;
    f.entities.addRefEntity(nextSprite);
    const probeView = f.view([{ ...surface, entityOrder: 1 }]);
    const probePacket = structuredClone(captureWorldBackendView(probeView, f.scenes)); f.transfer();
    f.remoteRuntime.probe(probePacket, 0, f.remoteScenes);
    expect(f.remoteTess.numVertexes).toBe(4);
    const retained = f.remoteTess.snapshotGeometry();
    expect(retained.vertices.map(vertex => vertex.position.y).sort((a, b) => a - b)).toEqual([-4, -4, 4, 4]);
    expect(f.remoteTess.context.entity?.origin.y).toBe(0);
    expect(f.tess.numVertexes).toBe(0);
  } finally { f.close(); }
});
