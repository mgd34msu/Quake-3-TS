import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
// Source scene admission and completion from renderer/tr_scene.c and tr_init.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { DynamicLight } from "../src/render/lighting.ts";
import { createModelEntity, createPortalEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import type { RefPoly, RefPolyVertex, SceneShader } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { SourceSceneSubmission } from "../src/render/scene-submission.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing authored scene fixture ${index}`);
  return value;
}

const shader: SceneShader = { name: "solid" };
function triangle(selected: SceneShader | null = shader): RefPoly {
  return { shader: selected, vertices: [[-8, -8], [8, -8], [0, 8]].map(([y, z]) => {
    if (y === undefined || z === undefined) throw new Error("Missing authored triangle coordinate");
    return { position: { x: 32, y, z }, texCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } };
  }) };
}
function light(radius = 64): DynamicLight {
  return { origin: { x: 24, y: 0, z: 0 }, radius, color: { x: 1, y: 0.25, z: 0.5 }, additive: true };
}
function storage(maxPolys = 600, maxPolyVertices = 3000) {
  const entities = new SourceSceneEntities(), printed: string[] = [];
  const state: { developer: boolean; fogs: Bounds[] } = { developer: false, fogs: [] };
  const scene = new SourceSceneSubmission(entities, { maxPolys, maxPolyVertices }, {
    fogBounds: () => state.fogs, developerEnabled: () => state.developer, print: text => { printed.push(text); },
  });
  return { scene, entities, printed, state };
}

describe("source shared scene submission", () => {
  test("copies accepted values and borrows the actual entity cells across scenes", () => {
    const { scene, entities } = storage(), entity = createModelEntity();
    const poly = triangle(), dynamic = light();
    scene.addRefEntity(entity); scene.addPoly(poly); scene.addLight(dynamic);
    const first = scene.captureScene();
    expect(first.entities.entity(0)).toBe(entities.sceneRange().entity(0));
    expect(first.polys[0]).toEqual({ shader, vertices: poly.vertices, fog: -1 });
    expect(first.polys[0]?.vertices).not.toBe(poly.vertices);
    expect(first.dynamicLights[0]).toEqual(dynamic);
    expect(first.dynamicLights[0]?.origin).not.toBe(dynamic.origin);
    entity.frame = 17;
    expect(first.entities.entity(0).entity).toMatchObject({ frame: 0 });
    scene.completeScene(first);
    scene.addRefEntity(entity); scene.addPoly(poly); scene.addLight(dynamic);
    const second = scene.captureScene();
    expect(second.entities.length).toBe(1);
    expect(second.entities.entity(0)).not.toBe(first.entities.entity(0));
    expect(second.entities.entity(0).entity).toMatchObject({ frame: 17 });
    expect(second.polys).toHaveLength(1); expect(second.dynamicLights).toHaveLength(1);
    expect(scene.captureScene().polys).toEqual(second.polys);
    scene.addRefEntity(entity); scene.addPoly(poly); scene.addLight(dynamic);
    scene.completeScene(second);
    expect(scene.captureScene()).toMatchObject({ entities: { length: 0 }, polys: [], dynamicLights: [] });
    expect(first.polys).toHaveLength(1); expect(first.dynamicLights).toHaveLength(1);
  });

  test("clear and completed scenes retain both frame budgets until rollover", () => {
    const { scene, entities, state, printed } = storage(2, 6);
    scene.addRefEntity(createModelEntity()); scene.addPoly(triangle()); scene.addLight(light());
    const first = scene.captureScene(), cell = first.entities.entity(0);
    scene.clearScene();
    expect(scene.captureScene()).toMatchObject({ entities: { length: 0 }, polys: [], dynamicLights: [] });
    scene.addPoly(triangle()); scene.completeScene(scene.captureScene());
    state.developer = true;
    scene.addPoly(triangle());
    expect(printed).toEqual(["^1WARNING: RE_AddPolyToScene: r_max_polys or r_max_polyverts reached\n"]);
    expect(scene.captureScene().polys).toHaveLength(0);
    scene.rolloverFrame();
    scene.addRefEntity(createModelEntity()); scene.addPoly(triangle());
    expect(scene.captureScene().polys).toHaveLength(1);
    expect(entities.sceneRange().entity(0)).toBe(cell);
    expect(() => scene.completeScene(first)).toThrow("completed frame");
    expect(() => storage().scene.completeScene(scene.captureScene())).toThrow("another submission owner");
  });

  test("zero shader and exhausted capacity precede vertex reads and preserve warning priority", () => {
    const { scene, state, printed } = storage(1, 3);
    const missing: RefPoly = { shader: null, get vertices(): readonly RefPolyVertex[] { throw new Error("Vertices must not be read"); } };
    scene.addPoly(missing);
    expect(printed).toEqual(["^3WARNING: RE_AddPolyToScene: NULL poly shader\n"]);
    scene.addPoly(triangle());
    const unreadable: RefPolyVertex = { get position(): Vec3 { throw new Error("Vertex must not be copied"); },
      texCoord: { x: 0, y: 0 }, color: { x: 0, y: 0, z: 0, w: 0 } };
    scene.addPoly({ shader, vertices: [unreadable, unreadable, unreadable] });
    expect(printed).toHaveLength(1);
    state.developer = true;
    scene.addPoly({ shader, vertices: [unreadable, unreadable, unreadable] });
    expect(printed[1]).toBe("^1WARNING: RE_AddPolyToScene: r_max_polys or r_max_polyverts reached\n");
    expect(scene.captureScene().polys).toHaveLength(1);
  });

  test("poly count and vertex count have independent inclusive limits", () => {
    const byVertices = storage(600, 3000).scene, point = at(triangle().vertices, 0);
    byVertices.addPoly({ shader, vertices: Array.from({ length: 2997 }, () => point) });
    byVertices.addPoly(triangle()); byVertices.addPoly(triangle());
    expect(byVertices.captureScene().polys).toHaveLength(2);
    const byCount = storage(600, 3000).scene;
    for (let index = 0; index < 601; index++) byCount.addPoly(triangle());
    expect(byCount.captureScene().polys).toHaveLength(600);
  });

  test("fog is selected at add from copied float32 bounds and retains the first intersection", () => {
    const { scene, state } = storage();
    state.fogs.push({ min: { x: 32, y: -8, z: -8 }, max: { x: 40, y: 8, z: 8 } },
      { min: { x: 0, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
    const vertices = triangle().vertices.map(vertex => ({ ...vertex, position: { ...vertex.position, x: 32 - 2 ** -22 } }));
    scene.addPoly({ shader, vertices });
    expect(scene.captureScene().polys[0]?.fog).toBe(0);
    for (const vertex of vertices) vertex.position.x = -99;
    state.fogs.length = 0;
    const captured = scene.captureScene();
    expect(captured.polys[0]?.vertices[0]?.position.x).toBe(32);
    expect(captured.polys[0]?.fog).toBe(0);
    scene.addPoly(triangle());
    expect(scene.captureScene().polys[1]?.fog).toBe(-1);
  });

  test("polygon and vertex counters are published before a failing fog lookup", () => {
    const entities = new SourceSceneEntities();
    let fogReads = 0;
    const scene = new SourceSceneSubmission(entities, { maxPolys: 600, maxPolyVertices: 3 }, {
      fogBounds: () => { fogReads++; throw new Error("Fog lookup stopped"); },
      developerEnabled: () => false, print: () => undefined,
    });
    expect(() => scene.addPoly(triangle())).toThrow("Fog lookup stopped");
    expect(scene.captureScene().polys).toHaveLength(1);
    scene.clearScene(); scene.addPoly(triangle());
    expect(fogReads).toBe(1); expect(scene.captureScene().polys).toHaveLength(0);
  });

  test("light intensity and the shared 32-slot limit precede copying", () => {
    const { scene } = storage();
    for (const radius of [0, -1, -Infinity]) scene.addLight({ radius,
      get origin(): Vec3 { throw new Error("Rejected light origin was read"); }, color: { x: 0, y: 0, z: 0 } });
    expect(scene.captureScene().dynamicLights).toHaveLength(0);
    for (let index = 0; index < 32; index++) scene.addLight(light(1.1));
    expect(scene.captureScene().dynamicLights[0]?.radius).toBe(Math.fround(1.1));
    scene.clearScene();
    scene.addLight({ get radius(): number { throw new Error("Overflow light radius was read"); },
      origin: { x: 0, y: 0, z: 0 }, color: { x: 0, y: 0, z: 0 } });
    expect(scene.captureScene().dynamicLights).toHaveLength(0);
    scene.rolloverFrame(); scene.addLight(light());
    expect(scene.captureScene().dynamicLights).toHaveLength(1);
    expect(() => scene.addLight(light(NaN))).toThrow("finite float32");
  });
});

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const camera = { origin: vec3(0, 0, 0), angles: vec3(0, 0, 0) };
const scripts = "solid { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }\n"
  + "world { cull none { map $whiteimage rgbGen const ( .1 .1 .1 ) } }\n"
  + "portal { portal cull none { map $whiteimage } }\n"
  + "fog { surfaceParm fog fogparms ( 0 0 1 ) 16 }";

async function renderer(files = new Map<string, Uint8Array>(), cvars = new CvarRegistry(),
  drawDebugSurface: () => undefined = () => undefined,
  readFile: (path: string) => Promise<Uint8Array | undefined> = async path => files.get(path)) {
  files.set("scripts/test.shader", new TextEncoder().encode(scripts));
  const assets: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({
    has: path => files.has(path), list: prefix => [...files.keys()].filter(path => prefix === undefined || path.startsWith(prefix)),
    read: async path => { const value = files.get(path); if (value === undefined) throw new Error(`Missing authored asset ${path}`); return value; },
    readFileLength: path => files.get(path)?.byteLength ?? -1, readFileOptional: readFile,
  });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(64, 48, images), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const printed: string[] = [], settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const clock = { milliseconds: () => 0 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets },
    sound: { kind: "diagnostic", readMixer: () => null }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  cleanup.push(() => { target.close(); cinematics.dispose(); });
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, images, builtins, target, imageProfile: identityImageUploadProfile, print: text => { printed.push(text); },
      drawDebugSurface, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime,
    print: text => { printed.push(text); } });
  cleanup.push(() => commands.close("discard"));
  return { resources, commands, cvars, settings, cpu, recording, images, printed };
}

/** Adds authored fog and six uniform light-grid samples to the two-quad BSP. */
function worldBytes(withFog = false, withGrid = false): Uint8Array {
  const base = renderBspFixture([{ shader: "world", lightmap: -1 }, { shader: "world", lightmap: -1 }], []);
  const header = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const lumps: Uint8Array[] = Array.from({ length: 17 }, (_, index) => {
    const offset = header.getInt32(8 + index * 8, true), length = header.getInt32(12 + index * 8, true);
    return base.slice(offset, offset + length);
  });
  if (withFog) {
    const planes = new BinaryWriter(112); planes.bytes(at(lumps, 2));
    for (const [normal, distance] of [[[-1, 0, 0], -16], [[1, 0, 0], 48], [[0, -1, 0], 16],
      [[0, 1, 0], 16], [[0, 0, -1], 16], [[0, 0, 1], 16]] satisfies readonly (readonly [readonly number[], number])[]) {
      for (const value of [...normal, distance]) planes.f32(value);
    }
    lumps[2] = planes.finish();
    const brushes = new BinaryWriter(12); for (const value of [0, 6, 0]) brushes.i32(value); lumps[8] = brushes.finish();
    const sides = new BinaryWriter(48); for (let index = 1; index <= 6; index++) { sides.i32(index); sides.i32(0); } lumps[9] = sides.finish();
    const fog = new BinaryWriter(72); fog.bytes(new TextEncoder().encode("fog")); fog.bytes(new Uint8Array(61)); fog.i32(0); fog.i32(-1); lumps[12] = fog.finish();
  }
  if (withGrid) lumps[15] = new Uint8Array(Array.from({ length: 6 }, () => [10, 20, 30, 40, 50, 60, 0, 0]).flat());
  const output = new BinaryWriter(144 + lumps.reduce((total, lump) => total + lump.byteLength, 0));
  output.bytes(new TextEncoder().encode("IBSP")); output.i32(46);
  let offset = 144;
  for (const lump of lumps) { output.i32(offset); output.i32(lump.byteLength); offset += lump.byteLength; }
  for (const lump of lumps) output.bytes(lump);
  return output.finish();
}

describe("actual renderer scene owner", () => {
  test("renderer cvars preserve source flags, allocation-time limits and the live common developer gate", async () => {
    const cvars = new CvarRegistry(); cvars.set("r_maxpolys", "601.9"); cvars.set("r_maxpolyverts", "3003");
    const f = await renderer(new Map<string, Uint8Array>(), cvars), selected = await f.resources.registerShader("solid");
    f.printed.length = 0;
    expect(cvars.get("r_maxpolys")).toMatchObject({ resetValue: "600", flags: 0 });
    expect(cvars.get("r_maxpolyverts")).toMatchObject({ resetValue: "3000", flags: 0 });
    expect(cvars.get("r_norefresh")).toMatchObject({ resetValue: "0", flags: CvarFlag.Cheat });
    expect(cvars.get("developer")).toBeUndefined();
    cvars.set("r_maxpolys", "900"); cvars.set("r_maxpolyverts", "9000");
    for (let index = 0; index < 601; index++) f.resources.addPoly(triangle(selected));
    f.resources.addPoly(triangle(selected));
    expect(f.printed).toEqual([]);
    cvars.register("developer", "0"); cvars.set("developer", "1");
    f.resources.addPoly(triangle(selected));
    expect(f.printed).toEqual(["^1WARNING: RE_AddPolyToScene: r_max_polys or r_max_polyverts reached\n"]);
    cvars.set("developer", "0.5"); f.resources.addPoly(triangle(selected));
    expect(f.printed).toHaveLength(1);
    f.resources.renderScene({ ...cameraRefdef(camera, 64, 48), renderFlags: RDF_NOWORLDMODEL });
    f.commands.submitFrame();
    expect(f.recording.trace().flatMap(view => view.batches).reduce((sum, batch) => sum + batch.indices.length, 0)).toBe(601 * 3);
    cvars.set("r_maxpolys", "-2"); cvars.set("r_maxpolyverts", "1");
    expect(f.settings.sceneLimits()).toEqual({ maxPolys: 600, maxPolyVertices: 3000 });
  });

  test("no-refresh and failed no-world rendering retain pending values before a successful CPU scene", async () => {
    const f = await renderer(), selected = await f.resources.registerShader("solid");
    const refdef = cameraRefdef(camera, 64, 48), entity = createSpriteEntity();
    f.resources.addRefEntity(entity); f.resources.addPoly(triangle(selected)); f.resources.addLight(light());
    expect(() => f.resources.renderScene(refdef)).toThrow(CommonError);
    expect(f.resources.sceneEntities.sceneRange().length).toBe(1);
    f.cvars.set("r_norefresh", "1"); refdef.width = NaN;
    expect(f.resources.renderScene(refdef)).toBeUndefined();
    expect(f.resources.sceneEntities.sceneRange().length).toBe(1);
    expect(f.commands.submit().commands).toBe(0);
    f.cvars.set("r_norefresh", "0"); refdef.width = 64; refdef.renderFlags = RDF_NOWORLDMODEL;
    f.resources.renderScene(refdef);
    expect(f.resources.sceneEntities.sceneRange().length).toBe(0);
    f.resources.renderScene(refdef); refdef.width = 8;
    expect(f.commands.submitFrame()).toMatchObject({ commands: 2, views: 2 });
    const first = at(f.recording.trace(), 0), second = at(f.recording.trace(), 1);
    expect(first.state.viewport.width).toBe(64); expect(first.batches.some(batch => batch.indices.length === 3)).toBe(true);
    expect(second.batches).toHaveLength(0);
    expect(Array.from(f.cpu.pixels.subarray((24 * 64 + 32) * 4, (24 * 64 + 32) * 4 + 4))).toEqual([255, 0, 0, 255]);
    f.resources.rolloverFrame();
  });

  test("loaded world, inline models, point lighting and add-time fog share the active compilation", async () => {
    const f = await renderer(new Map([["maps/fog.bsp", worldBytes(true, true)]]));
    expect(f.resources.lightForPoint(vec3(NaN, 0, 0))).toBeNull();
    const selected = await f.resources.registerShader("solid");
    f.resources.addPoly(triangle(selected));
    const world = await f.resources.loadWorld("fog");
    f.resources.addPoly(triangle(selected));
    const noWorld = { ...cameraRefdef(camera, 64, 48), renderFlags: RDF_NOWORLDMODEL };
    f.resources.renderScene(noWorld); f.commands.submitFrame();
    const batches = at(f.recording.trace(), 0).batches;
    expect(batches.filter(batch => batch.texture.kind === "bind-image" && batch.texture.image === f.resources.builtins.fogImage))
      .toHaveLength(1);
    expect(batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(9);
    expect(f.resources.lightForPoint(vec3(0, 0, 0))).toEqual(world.lightForPoint(vec3(0, 0, 0)));
    expect(f.resources.lightForPoint(vec3(0, 0, 0))?.directedLight).toEqual(vec3(160, 200, 240));
    f.resources.rolloverFrame();
    const inline = createModelEntity(world.inlineModel(0)); inline.axis = anglesToAxis(vec3(0, 0, 0));
    f.resources.addRefEntity(inline); f.resources.renderScene(noWorld); f.commands.submitFrame();
    expect(at(f.recording.trace(), 1).batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(12);
    f.resources.rolloverFrame();
    f.resources.renderScene(cameraRefdef(camera, 64, 48)); f.commands.submitFrame();
    expect(at(f.recording.trace(), 2).batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(12);
  });

  test("disabled dynamic lights consume frame slots across scenes and resume after queue consumption and rollover", async () => {
    const f = await renderer(new Map([["maps/test.bsp", worldBytes()]])), world = await f.resources.loadWorld("test");
    const noWorld = { ...cameraRefdef(camera, 64, 48), renderFlags: RDF_NOWORLDMODEL };
    f.cvars.set("r_dynamiclight", "0");
    for (let index = 0; index < 32; index++) f.resources.addLight(light());
    f.resources.renderScene(noWorld);
    f.cvars.set("r_dynamiclight", "1");
    const inline = createModelEntity(world.inlineModel(0)); inline.axis = anglesToAxis(vec3(0, 0, 0));
    f.resources.addRefEntity(inline); f.resources.addLight(light());
    const unlit = f.resources.sceneEntities.sceneRange().entity(0);
    f.resources.renderScene(noWorld);
    expect(unlit.needDlights).toBe(false);
    f.commands.submitFrame(); f.resources.rolloverFrame();
    f.resources.addRefEntity(inline); f.resources.addLight(light());
    const lit = f.resources.sceneEntities.sceneRange().entity(0);
    f.resources.renderScene(noWorld); expect(lit.needDlights).toBe(true);
    f.commands.submitFrame();
    const before = at(f.recording.trace(), 1).batches, after = at(f.recording.trace(), 2).batches;
    expect(before.some(batch => batch.texture.kind === "bind-image" && batch.texture.image.name === "*dlight")).toBe(false);
    expect(after.some(batch => batch.texture.kind === "bind-image" && batch.texture.image.name === "*dlight")).toBe(true);
  });

  test("debug failure after a queued parent view leaves entity and polygon membership pending", async () => {
    const f = await renderer(new Map<string, Uint8Array>(), new CvarRegistry(), () => { throw new Error("Debug frontend stopped"); });
    const refdef = { ...cameraRefdef(camera, 64, 48), renderFlags: RDF_NOWORLDMODEL };
    f.resources.addRefEntity(createPortalEntity()); f.resources.addPoly(triangle(await f.resources.registerShader("solid")));
    f.cvars.set("r_debugSurface", "1");
    expect(() => f.resources.renderScene(refdef)).toThrow("Debug frontend stopped");
    expect(f.resources.sceneEntities.sceneRange().length).toBe(1);
    expect(f.recording.trace()).toHaveLength(1);
    f.cvars.set("r_debugSurface", "0"); f.resources.renderScene(refdef); f.commands.submitFrame();
    expect(f.resources.sceneEntities.sceneRange().length).toBe(0);
    expect(at(f.recording.trace(), 0).batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(3);
    expect(at(f.recording.trace(), 1).batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(3);
  });

  test("a pending world load rejects a second load before replacing the source world", async () => {
    const files = new Map([["maps/older.bsp", worldBytes(false, false)], ["maps/current.bsp", worldBytes(false, true)]]);
    const delayed = Promise.withResolvers<Uint8Array | undefined>();
    const f = await renderer(files, new CvarRegistry(), () => undefined,
      path => path === "maps/older.bsp" ? delayed.promise : Promise.resolve(files.get(path)));
    const older = f.resources.loadWorld("older");
    await expect(f.resources.loadWorld("current")).rejects.toThrow("attempted to redundantly load world map");
    delayed.resolve(files.get("maps/older.bsp")); const world = await older;
    expect(f.resources.worldBaseName).toBe("older");
    expect(f.resources.lightForPoint(vec3(0, 0, 0))).toBeNull();
    const inline = createModelEntity(world.inlineModel(0)); inline.axis = anglesToAxis(vec3(0, 0, 0));
    f.resources.addRefEntity(inline);
    f.resources.renderScene({ ...cameraRefdef(camera, 64, 48), renderFlags: RDF_NOWORLDMODEL }); f.commands.submitFrame();
    expect(at(f.recording.trace(), 0).batches.reduce((total, batch) => total + batch.indices.length, 0)).toBe(12);
  });
});
