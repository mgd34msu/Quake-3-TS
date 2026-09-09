import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, test } from "bun:test";
import { parseBsp } from "../src/assets/bsp.ts";
import { interpolateSurface } from "../src/assets/md3.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { add3, anglesToAxis, scale3, vec4 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { encodePng } from "../src/core/png.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { transformMd3Tag } from "../src/render/model-geometry.ts";
import { diffuseColor, specularAlpha } from "../src/render/scene-models.ts";
import type { SceneModel, RefModelEntity, RefEntity } from "../src/render/ref-entity.ts";
import { createBeamEntity, createLightningEntity, createModelEntity, createPortalEntity, createRailCoreEntity, createRailRingsEntity, createSpriteEntity, RF_THIRD_PERSON, RF_SHADOW_PLANE, RF_NOSHADOW, RF_DEPTHHACK, RF_WRAP_FRAMES } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import type { WorldFrame } from "../src/render/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { PreparedBackendDraw, PreparedBackendSourceDraw, RenderViewState } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BatchRecordingBackend, recordPreparedViews } from "./render-target-fixture.ts";
import type { DrawBatch, ImmediateViewOperation, RenderView, SourceGeometryAllocation, SourceStageData, ViewOperation } from "../src/render/types.ts";
import { viewProjection, viewProjector } from "../src/render/view.ts";
import { railGeometry, spriteGeometry } from "../src/render/entity-primitives.ts";

const scripts = `
test/model_opaque { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }
test/model_translucent { sort blend cull none { map $whiteimage blendFunc blend rgbGen const ( 0 0 1 ) alphaGen const 0.5 } }
test/model_diffuse { cull none { map $whiteimage rgbGen lightingDiffuse } }
test/model_entity { cull none { map $whiteimage rgbGen entity alphaGen entity tcMod entityTranslate } }
test/model_specular { cull none { map $whiteimage alphaGen lightingSpecular } }
test/model_environment { cull none { map $whiteimage tcGen environment } }
test/model_lightmap { cull none { map $lightmap rgbGen identity } }
test/model_move { cull none deformVertexes move 4 0 0 sin 0 1 0 1 { map $whiteimage } }
test/model_offset { polygonOffset { map $whiteimage } }
test/model_vertex { { map $whiteimage rgbGen vertex } }
test/model_portal { portal cull none { map $whiteimage } }
test/model_merge { entityMergable cull none { map $whiteimage rgbGen entity } }
test/projection_picture { deformVertexes projectionShadow { map $whiteimage } }
`;

function first<T>(values: readonly T[]): T { const value = values[0]; if (value === undefined) throw new Error("fixture record missing"); return value; }
const dataPath = process.env["Q3_DATA"];
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class SurfaceRecordingBackend extends BatchRecordingBackend {
  readonly events: (ViewOperation | { readonly kind: "begin-view" })[] = [];
  override beginView(view: RenderViewState): undefined { super.beginView(view); this.events.push({ kind: "begin-view" }); }
  override drawImmediate(operation: ImmediateViewOperation): undefined { super.drawImmediate(operation); this.events.push(operation); }
  override prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const prepared = super.prepareGeometry(batch);
    return { ...prepared, draw: () => { prepared.draw(); this.events.push({ kind: "draw", batches: [batch] }); } };
  }
  override prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    const prepared = super.prepareSourceGeometry(stage, allocation);
    return { ...prepared, draw: primitives => { prepared.draw(primitives); this.events.push({ kind: "draw", batches: [stage.batch] }); } };
  }
  beforeView(start: number): readonly ViewOperation[] {
    const prefix: ViewOperation[] = [];
    for (const event of this.events.slice(start)) { if (event.kind === "begin-view") break; prefix.push(event); }
    return prefix;
  }
}

async function fixture(product: "baseq3" | "missionpack" = "baseq3", mapName = "q3dm1", transparentWorld = false, native = false) {
  if (dataPath === undefined) throw new Error("Q3_DATA is required");
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
  let source = scripts;
  if (transparentWorld) {
    const map = parseBsp(await assets.read(`maps/${mapName}.bsp`));
    source += map.shaders.map(shader => `${shader.name} { cull none sort blend { map $whiteimage blendFunc blend rgbGen const ( 0 1 0 ) alphaGen const 0.5 } }`).join("\n");
  }
  let reads = 0;
  const files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional"> = { ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: path => { reads++; return path === "scripts/000_model_scene.shader" ? Promise.resolve(new TextEncoder().encode(source)) : Promise.resolve(undefined); } }, assets),
    has: path => path === "scripts/000_model_scene.shader" || assets.has(path),
    list: prefix => ["scripts/000_model_scene.shader", ...assets.list(prefix)],
    read: path => { reads++; return path === "scripts/000_model_scene.shader" ? Promise.resolve(new TextEncoder().encode(source)) : assets.read(path); },
    readFileLength: path => path === "scripts/000_model_scene.shader" ? new TextEncoder().encode(source).byteLength : assets.readFileLength(path),
    readFileOptional: path => { reads++; return path === "scripts/000_model_scene.shader" ? Promise.resolve(new TextEncoder().encode(source)) : assets.readFileOptional(path); },
  };
  const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux");
  const images = new RendererImageCatalog();
  const window = native && process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Retail model scene", width: 320, height: 240, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), cpu = new SoftwareRenderer(320, 240, images, gl?.subpixelBits ?? 8);
  const recording = new SurfaceRecordingBackend(cpu), target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true }), clock = { milliseconds: () => 0 };
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: clock.milliseconds },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const prints: string[] = [];
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: text => { prints.push(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  const scene = await resources.loadWorld(mapName);
  expect(resources.worldBaseName).toBe(mapName);
  function submit(frame: WorldFrame) {
    const prepare = scene.prepareFrame(frame), start = recording.trace().length + 1;
    commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    commands.addPreparedViews(prepare); commands.submit();
    return recording.trace().slice(start);
  }
  const camera = scene.initialCamera();
  const view: WorldFrame = { refdef: cameraRefdef(camera, 160, 120) };
  return { scene, assets, view, readCount: () => reads, submit, commands, cpu, gl, cvars, recording, prints };
}

function entity(model: SceneModel, view: WorldFrame, distance = 40): RefModelEntity {
  const axes = view.refdef.viewAxis;
  const position = add3(view.refdef.viewOrigin, scale3(axes[0], distance));
  return { ...createModelEntity(model), model, origin: { ...position, z: position.z - 20 }, axis: [scale3(axes[0], -1), scale3(axes[1], -1), axes[2]],
    nonNormalizedAxes: false, frame: 0, oldFrame: 0, backLerp: 0, skinNum: 0, customSkin: null, customShader: null,
    shaderRGBA: { x: 255, y: 255, z: 255, w: 255 }, shaderTexCoord: { x: 0, y: 0 }, shaderTime: 0,
    lightingOrigin: position, renderFlags: 0 };
}

test.skipIf(dataPath === undefined)("invalid MD3 frame warning preserves the registered mixed-case model name", async () => {
  const f = await fixture(), modelName = "MoDeLs/Players/Sarge/Lower.MD3";
  const model = await f.scene.resources.registerModel(modelName);
  if (model.kind !== "md3") throw new Error("Warning fixture requires the registered retail MD3");
  f.cvars.set("developer", "1", true);
  f.prints.length = 0;
  f.submit({ refdef: { ...f.view.refdef, renderFlags: RDF_NOWORLDMODEL },
    entities: [{ ...entity(model, f.view), frame: -1, oldFrame: -2 }] });
  expect(f.prints).toContain(`R_AddMD3Surfaces: no such frame -2 to -1 for '${modelName}'\n`);
});

test.skipIf(dataPath === undefined)("actual model LOD cvars select retail geometry on CPU and GL and preserve prepared selections", async () => {
  const f = await fixture("baseq3", "q3dm1", false, true), resources = f.scene.resources;
  const model = await resources.registerModel("models/players/sarge/lower.md3");
  if (model.kind !== "md3" || model.numLods < 2) throw new Error("Expected retail model with source LOD files");
  f.cvars.set("cg_shadows", "0");
  const refdef = { ...cameraRefdef({ origin: { x: -96, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const modelEntity = createModelEntity(model); modelEntity.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  modelEntity.customShader = await resources.registerShader("test/model_opaque");
  const frame = { refdef, entities: [modelEntity] };
  const expected = Array.from({ length: model.numLods }, (_, index) => {
    const lod = model.md3[index];
    if (lod === undefined || lod === null) throw new Error("Expected retail MD3 LOD slot");
    return lod.surfaces.reduce((count, surface) => count + surface.triangles.length * 3, 0);
  });
  const secondLod = expected[1], lastLod = expected.at(-1);
  if (secondLod === undefined || lastLod === undefined) throw new Error("Expected retail LOD triangle counts");
  const draw = () => f.submit(frame).flatMap(view => view.batches).reduce((count, batch) => count + batch.indices.length, 0);
  f.cvars.set("r_lodscale", "20");
  expect(draw()).toBe(first(expected));
  f.cvars.set("r_lodscale", "inf");
  expect(draw()).toBe(first(expected));
  expect(f.cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
  if (f.gl !== null) expect(f.gl.readPixels().some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
  const prepared = f.scene.prepareFrame(frame);
  f.cvars.set("r_lodbias", "1.9");
  const retained: RenderView[] = [];
  f.commands.addPreparedViews(drawSurfs => recordPreparedViews(prepared(drawSurfs), retained)); f.commands.submit();
  expect(retained.flatMap(view => view.operations.flatMap(operation => operation.kind === "source-stage" ? [operation.stage.batch] : []))
    .reduce((count, batch) => count + batch.indices.length, 0)).toBe(first(expected));
  expect(draw()).toBe(secondLod);
  f.cvars.set("r_lodbias", "0"); f.cvars.set("r_lodscale", "0");
  expect(draw()).toBe(lastLod); expect(lastLod).not.toBe(first(expected));
  f.cvars.set("r_lodscale", "5"); f.cvars.set("r_lodbias", "-100");
  expect(draw()).toBe(first(expected));
});

test.skipIf(dataPath === undefined)("MD3 portal probes interpolate the submitted source surface using the retained backend pose", async () => {
  const f = await fixture("baseq3", "q3dm1", false, true), resources = f.scene.resources;
  const model = await resources.registerModel("models/players/sarge/lower.md3");
  if (model.kind !== "md3" || model.md3[0] === null) throw new Error("expected registered retail MD3");
  const refdef = { ...cameraRefdef({ origin: { x: -64, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const retained = createModelEntity(model);
  retained.axis = anglesToAxis({ x: 0, y: 0, z: 0 });
  retained.frame = model.md3[0].frames.length + 1; retained.oldFrame = model.md3[0].frames.length; retained.backLerp = 0.25;
  retained.renderFlags = RF_WRAP_FRAMES;
  retained.customShader = await resources.registerShader("test/model_opaque");
  f.cvars.set("cg_shadows", "0");
  f.cvars.set("r_lodbias", "-100");
  f.submit({ refdef, entities: [retained] });
  expect(resources.tess.context.entity).toMatchObject({ frame: 1, oldFrame: 0, backLerp: 0.25 });
  expect(retained.frame).toBe(model.md3[0].frames.length + 1);
  const submitted = { ...retained, frame: 0, oldFrame: 0, backLerp: 0,
    customShader: await resources.registerShader("test/model_portal") };
  const portal = createPortalEntity();
  let views: RenderView[] = [];
  const start = f.recording.events.length, prepare = f.scene.prepareFrame({ refdef, entities: [submitted, portal] });
  f.commands.addPreparedViews(drawSurfs => recordPreparedViews(prepare(drawSurfs), views));
  f.commands.submit();
  expect(views).toHaveLength(2);
  expect(f.recording.beforeView(start)[0]?.kind).toBe("cull");
  const prefix = f.recording.beforeView(start)[1];
  if (prefix?.kind !== "draw") throw new Error("expected retained MD3 portal probe draw before child clear");
  const source = first(model.md3[0].surfaces), pose = interpolateSurface(source, 1, 0, 0.25);
  const projector = viewProjector(refdef, viewProjection(refdef, 2048));
  const project = (position: Vec3) => { const clip = projector(position); return vec4(clip.x, clip.y, clip.z, clip.w); };
  expect(first(prefix.batches).vertices.map(vertex => vertex.position)).toEqual(pose.map(vertex => project(vertex.position)));
  expect(first(prefix.batches).vertices.map(vertex => vertex.position)).not.toEqual(first(source.frames).map(vertex => project(vertex.position)));
  const counts = (rendered: readonly RenderView[]) => rendered.map(view => view.operations.flatMap(operation => operation.kind === "source-stage" ? [operation.stage.batch] : [])
    .reduce((count, batch) => count + batch.indices.length, 0));
  const originalCounts = counts(views);
  expect(first(originalCounts)).toBeGreaterThan(0);
  f.submit({ refdef, entities: [retained] });
  const captured = f.scene.prepareFrame({ refdef, entities: [submitted, portal] });
  f.cvars.set("r_lodbias", "0"); f.cvars.set("r_lodscale", "0");
  f.commands.addPreparedViews(drawSurfs => { views = []; return recordPreparedViews(captured(drawSurfs), views); }); f.commands.submit();
  expect(counts(views)).toEqual(originalCounts);
  f.cvars.set("r_lodbias", "-100");
  f.submit({ refdef, entities: [{ ...retained, frame: -1, renderFlags: 0 }] });
  expect(resources.tess.context.entity).toMatchObject({ frame: 0, oldFrame: 0, backLerp: 0.25 });
});

test.skipIf(dataPath === undefined)("entity portal probes dispatch the retained sprite and rail producer and flush overflow before rejection", async () => {
  const f = await fixture("baseq3", "q3dm1", false, true), resources = f.scene.resources;
  f.cvars.set("cg_shadows", "0");
  const previous = { ...cameraRefdef({ origin: { x: -64, y: -8, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const refdef = { ...previous, viewOrigin: { x: -64, y: 0, z: 0 }, viewAxis: anglesToAxis({ x: 0, y: 0, z: 30 }) };
  const submitted = createBeamEntity(); submitted.customShader = await resources.registerShader("test/model_portal");
  const portal = createPortalEntity();
  expect(() => f.scene.prepareFrame({ refdef, entities: [submitted, portal] })).toThrow("source backEnd.currentEntity is NULL");
  let prefix: readonly ViewOperation[] = [];
  function probe(): readonly RenderView[] {
    const views: RenderView[] = [];
    const start = f.recording.events.length, prepare = f.scene.prepareFrame({ refdef, entities: [submitted, portal] });
    f.commands.addPreparedViews(drawSurfs => recordPreparedViews(prepare(drawSurfs), views)); f.commands.submit();
    prefix = f.recording.beforeView(start);
    return views;
  }
  const retained = createSpriteEntity();
  retained.origin = { x: 4, y: 0, z: 0 }; retained.radius = 8; retained.rotation = 13;
  retained.customShader = await resources.registerShader("test/model_opaque");
  const projector = viewProjector(previous, viewProjection(previous, 2048));
  const project = (position: Vec3) => { const clip = projector(position); return vec4(clip.x, clip.y, clip.z, clip.w); };
  f.submit({ refdef: previous, entities: [retained] });
  const spriteViews = probe(), sprite = prefix[1];
  expect(prefix[0]?.kind).toBe("cull");
  expect(spriteViews).toHaveLength(2);
  if (sprite?.kind !== "draw") throw new Error("expected retained sprite probe before child clear");
  expect(first(sprite.batches).vertices.map(vertex => vertex.position)).toEqual(spriteGeometry(retained, previous.viewAxis, false).vertices.map(vertex => project(vertex.position)));
  for (const rail of [createRailCoreEntity(), createRailRingsEntity(), createLightningEntity()]) {
    rail.origin = { x: 32, y: 0, z: 0 }; rail.oldOrigin = { x: 0, y: 8, z: 0 }; rail.customShader = retained.customShader;
    f.submit({ refdef: previous, entities: [retained, rail] });
    const geometry = railGeometry(rail, previous.viewOrigin); probe();
    expect(prefix[0]?.kind).toBe("cull");
    const draw = prefix[1];
    if (draw?.kind !== "draw") throw new Error("expected retained rail probe draw");
    expect(first(draw.batches).vertices.map(vertex => vertex.position)).toEqual(geometry.vertices.map(vertex => project(vertex.position)));
    expect(first(draw.batches).indices).toEqual(geometry.indices);
  }
  const longRail = createRailRingsEntity();
  longRail.origin = { x: 8200, y: 0, z: 0 }; longRail.customShader = retained.customShader;
  f.submit({ refdef: previous, entities: [longRail] });
  f.commands.addPreparedViews(f.scene.prepareFrame({ refdef: previous, entities: [] }));
  const overflowViews = probe();
  expect(overflowViews).toHaveLength(1);
  expect(prefix.map(operation => operation.kind)).toEqual(["cull", "draw", "cull", "draw"]);
  const overflowDraws = prefix.filter(operation => operation.kind === "draw");
  expect(overflowDraws.map(operation => first(operation.batches).vertices.length)).toEqual([996, 24]);
  expect(overflowDraws.map(operation => first(operation.batches).indices.length)).toEqual([1494, 36]);
});

test.skipIf(dataPath === undefined)("immediate entity portal probes preserve every rejected call and ordinary merged surfaces retain source draw order", async () => {
  const f = await fixture("baseq3", "q3dm1", false, true), resources = f.scene.resources;
  f.cvars.set("cg_shadows", "0");
  const refdef = { ...cameraRefdef({ origin: { x: -64, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240), renderFlags: RDF_NOWORLDMODEL };
  const submitted = createBeamEntity(); submitted.customShader = await resources.registerShader("test/model_portal");
  let prefix: readonly ViewOperation[] = [];
  function draw(entities: readonly RefEntity[]): readonly RenderView[] {
    const views: RenderView[] = [];
    const start = f.recording.events.length, prepare = f.scene.prepareFrame({ refdef, entities });
    prefix = f.recording.beforeView(start);
    f.commands.addPreparedViews(drawSurfs => recordPreparedViews(prepare(drawSurfs), views)); f.commands.submit();
    return views;
  }
  f.submit({ refdef, entities: [] });
  const axes = draw([submitted, submitted]);
  expect(axes).toHaveLength(1);
  expect(prefix.map(operation => operation.kind)).toEqual(["entity-axis", "entity-axis"]);
  expect(f.cpu.pixels.filter((value, index) => index % 4 !== 3 && value !== 0).length).toBeGreaterThan(0);
  if (f.gl !== null) expect(f.gl.readPixels().filter((value, index) => index % 4 !== 3 && value !== 0).length).toBeGreaterThan(0);
  const shader = await resources.registerShader("test/model_merge");
  const sprite = createSpriteEntity(); sprite.origin = { x: 32, y: 0, z: 0 }; sprite.radius = 6; sprite.customShader = shader;
  sprite.shaderRGBA = { x: 0, y: 0, z: 255, w: 255 };
  const beam = createBeamEntity(); beam.origin = { x: 1000, y: 0, z: 0 }; beam.oldOrigin = { x: 1016, y: 0, z: 0 };
  beam.customShader = shader; beam.renderFlags = RF_DEPTHHACK;
  const lastBeam = { ...beam, renderFlags: 0, oldOrigin: { x: 1024, y: 0, z: 0 }, shaderRGBA: { x: 0, y: 255, z: 0, w: 255 } };
  const merged = first(draw([sprite, beam, lastBeam])).operations;
  expect(merged.map(operation => operation.kind)).toEqual(["depth-range", "entity-beam", "depth-range", "entity-beam", "cull", "source-stage"]);
  expect(merged.filter(operation => operation.kind === "depth-range").map(operation => operation.range)).toEqual([[0, 0.3], [0, 1]]);
  const last = merged.at(-1);
  if (last?.kind !== "source-stage") throw new Error("expected accumulated sprite after immediate beams");
  expect(last.stage.batch.vertices.every(vertex => vertex.color.x === 0 && vertex.color.y === 1 && vertex.color.z === 0)).toBe(true);
  draw([submitted]); const retainedBeam = prefix[0];
  if (retainedBeam?.kind !== "entity-beam") throw new Error("expected retained beam probe before parent clear");
  expect(retainedBeam.positions).toHaveLength(14);
  expect(retainedBeam.positions[1]?.w).toBe(88);
  const tail = first(draw([beam])).operations;
  expect(tail.map(operation => operation.kind)).toEqual(["depth-range", "entity-beam", "depth-range"]);
  expect(tail.filter(operation => operation.kind === "depth-range").map(operation => operation.range)).toEqual([[0, 0.3], [0, 1]]);
  expect(first(draw([{ ...beam, oldOrigin: beam.origin }])).operations.map(operation => operation.kind)).toEqual(["depth-range", "depth-range"]);
});

describe("source model stage lighting", () => {
  test("diffuse stage truncates source byte colors and preserves packed ambient backfaces", () => {
    const lighting = { ambientLight: { x: 10.9, y: 20.9, z: 30.9 }, directedLight: { x: 100, y: 300, z: 400 },
      lightDir: { x: 1, y: 0, z: 0 }, ambientLightInt: 0xff1e140a };
    expect(diffuseColor({ x: 1, y: 0, z: 0 }, lighting)).toEqual({ x: 110, y: 255, z: 255 });
    expect(diffuseColor({ x: -1, y: 0, z: 0 }, lighting)).toEqual({ x: 10, y: 20, z: 30 });
  });
  test("specular stage uses the source fixed light and fourth-power viewer reflection", () => {
    const point = { x: -960, y: 1980, z: 0 }, normal = { x: 0, y: 0, z: 1 };
    const alpha = specularAlpha(point, normal, { ...point, z: 100 });
    expect(alpha).toBeGreaterThan(250); expect(alpha).toBeLessThanOrEqual(255);
    expect(specularAlpha(point, normal, { ...point, z: -100 })).toBe(0);
  });
});

describe.skipIf(dataPath === undefined)("registered model world scenes", () => {
  test("selects source projection shadows before personal-model suppression using cg_shadows and original shader sort", async () => {
    const { scene, view: camera, submit, cvars, commands, recording } = await fixture();
    const view = { ...camera, refdef: { ...camera.refdef, renderFlags: RDF_NOWORLDMODEL } };
    const model = await scene.resources.registerModel("models/players/sarge/lower.md3");
    const opaque = await scene.resources.registerShader("test/model_opaque"), translucent = await scene.resources.registerShader("test/model_translucent");
    if (opaque === null || translucent === null) throw new Error("fixture model shader registration failed");
    const posed = { ...entity(model, view), customShader: opaque, renderFlags: RF_SHADOW_PLANE | RF_THIRD_PERSON, shadowPlane: camera.refdef.viewOrigin.z - 30 };
    const batches = (value: RefModelEntity) => submit({ ...view, entities: [value] }).flatMap(value => value.batches);
    for (const setting of [0, 1, 2, 4]) {
      cvars.set("cg_shadows", String(setting));
      expect(batches(posed)).toHaveLength(0);
    }
    cvars.set("cg_shadows", "3");
    const shadow = batches(posed);
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow.every(batch => batch.state.polygonOffset !== undefined && batch.vertices.every(vertex => vertex.color.x === 0 && vertex.color.y === 0 && vertex.color.z === 0))).toBe(true);
    expect(batches({ ...posed, renderFlags: RF_THIRD_PERSON })).toHaveLength(0);
    expect(batches({ ...posed, customShader: translucent })).toHaveLength(0);
    expect(batches({ ...posed, renderFlags: posed.renderFlags | RF_NOSHADOW }).length).toBe(shadow.length);
    const depthStart = recording.events.length;
    const hacked = batches({ ...posed, renderFlags: posed.renderFlags | RF_DEPTHHACK });
    expect(hacked.length).toBe(shadow.length);
    const depthEvents = recording.events.slice(depthStart);
    const reduced = depthEvents.findIndex(event => event.kind === "depth-range" && event.range[0] === 0 && event.range[1] === 0.3);
    const restored = depthEvents.findIndex((event, index) => index > reduced && event.kind === "depth-range" && event.range[0] === 0 && event.range[1] === 1);
    expect(reduced).toBeGreaterThanOrEqual(0); expect(restored).toBeGreaterThan(reduced);
    expect(depthEvents.slice(reduced + 1, restored).some(event => event.kind === "draw" && event.batches.some(batch => batch.indices.length > 0))).toBe(true);
    expect(batches({ ...posed, origin: add3(view.refdef.viewOrigin, scale3(view.refdef.viewAxis[0], -1000)) })).toHaveLength(0);
    const both = batches({ ...posed, renderFlags: RF_SHADOW_PLANE });
    expect(both.length).toBeGreaterThan(shadow.length);
    await scene.resources.remapShader(opaque.name, translucent.name, null);
    expect(batches(posed)).toEqual(shadow);
    const picture = scene.resources.picture(await scene.resources.registerShaderNoMip("test/projection_picture"));
    commands.draw2D("pixels").drawPic({ x: 0, y: 0, width: 8, height: 8 }, picture); commands.submit();
    expect(scene.resources.tess.context.kind).toBe("2d");
    expect(scene.resources.tess.context.orientationOrigin).toEqual(posed.origin);
    expect(scene.resources.tess.snapshotGeometry().vertices.every(vertex => vertex.position.z === -posed.origin.z)).toBe(true);
  });
  test("caches registrations, performs no frame I/O, and rejects foreign scene handles", async () => {
    const a = await fixture(), b = await fixture();
    const model = await a.scene.resources.registerModel("models/players/sarge/upper.md3");
    const skin = await a.scene.resources.registerSkin("models/players/sarge/upper_default.skin");
    if (skin === null) throw new Error("retail Sarge skin failed registration");
    const shader = await a.scene.resources.registerShader("test/model_entity");
    if (shader === null) throw new Error("fixture model shader registration failed");
    expect(await a.scene.resources.registerModel(model.path)).toBe(model);
    expect(await a.scene.resources.registerSkin(skin.path)).toBe(skin);
    expect(await a.scene.resources.registerShader(shader.name)).toBe(shader);
    const shaderSkin = await a.scene.resources.registerSkin("test/model_entity");
    if (shaderSkin === null) throw new Error("single-shader skin failed registration");
    expect(shaderSkin.surfaces).toEqual([{ name: "", shader: "test/model_entity" }]);
    const before = a.readCount(), posed = { ...entity(model, a.view), customSkin: skin, customShader: shader };
    const firstFrame = a.submit({ ...a.view, entities: [posed] });
    expect(firstFrame.flatMap(view => view.batches).length).toBeGreaterThan(a.submit(a.view).flatMap(view => view.batches).length);
    expect(a.readCount()).toBe(before);
    expect(() => b.scene.prepareFrame({ ...b.view, entities: [posed] })).toThrow("model handle");
    const other = await b.scene.resources.registerModel(model.path);
    expect(() => b.scene.prepareFrame({ ...b.view, entities: [{ ...posed, model: other, customShader: null }] })).toThrow("skin handle");
    expect(() => b.scene.prepareFrame({ ...b.view, entities: [{ ...posed, model: other, customSkin: null }] })).toThrow("shader handle");
    const secondFrame = b.submit({ ...b.view, entities: [entity(other, b.view)] });
    expect(secondFrame.length).toBeGreaterThan(0);
    expect(a.submit({ ...a.view, entities: [posed] })).toEqual(firstFrame);
    const depthStart = a.recording.events.length;
    a.submit({ ...a.view, entities: [{ ...posed, renderFlags: RF_DEPTHHACK }] });
    const depthEvents = a.recording.events.slice(depthStart);
    // Source stages consume qglDepthRange's retained state when the real draw begins.
    const hacked = depthEvents.findIndex(event => event.kind === "depth-range" && event.range[0] === 0 && event.range[1] === 0.3);
    const restored = depthEvents.findIndex((event, index) => index > hacked && event.kind === "depth-range" && event.range[0] === 0 && event.range[1] === 1);
    expect(hacked).toBeGreaterThanOrEqual(0); expect(restored).toBeGreaterThan(hacked);
    expect(depthEvents.slice(hacked + 1, restored).some(event => event.kind === "draw" && event.batches.some(batch => batch.indices.length > 0))).toBe(true);
    expect(a.submit({ ...a.view, entities: [{ ...posed, renderFlags: 1024 }] })).toEqual(a.submit({ ...a.view, entities: [{ ...posed, renderFlags: 0 }] }));
    expect(() => a.scene.prepareFrame({ ...a.view, entities: [{ ...posed, renderFlags: 2 ** 32 }] })).toThrow("renderFlags");
    expect(a.submit({ ...a.view, entities: [{ ...posed, renderFlags: RF_THIRD_PERSON }] })).toEqual(a.submit(a.view));
  });

  test("sorts model opaque stages before transparent world surfaces and keeps model transparency later", async () => {
    const { scene, view, submit } = await fixture("baseq3", "q3dm1", true);
    const model = await scene.resources.registerModel("models/weapons2/machinegun/machinegun.md3");
    const opaque = await scene.resources.registerShader("test/model_opaque"), transparent = await scene.resources.registerShader("test/model_translucent");
    const batches = submit({ ...view, entities: [{ ...entity(model, view), customShader: transparent }, { ...entity(model, view), customShader: opaque }] }).flatMap(view => view.batches);
    const red = batches.findIndex(batch => batch.vertices.some(vertex => vertex.color.x === 1 && vertex.color.y === 0 && vertex.color.z === 0));
    const green = batches.findIndex(batch => batch.vertices.some(vertex => vertex.color.x === 0 && vertex.color.y === 1 && vertex.color.z === 0));
    const blue = batches.findIndex(batch => batch.vertices.some(vertex => vertex.color.x === 0 && vertex.color.y === 0 && vertex.color.z === 1));
    expect(red).toBeGreaterThanOrEqual(0); expect(green).toBeGreaterThan(red); expect(blue).toBeGreaterThan(green);
  });

  test("evaluates model lighting, entity colors, local environment coordinates, deformations and white model lightmaps", async () => {
    const { scene, view, submit, commands } = await fixture();
    const model = await scene.resources.registerModel("models/players/sarge/upper.md3");
    const base = entity(model, view), whiteImage = scene.resources.picture(null).material.whiteImage;
    async function selected(name: string, value: Partial<RefModelEntity> = {}, frame: Partial<WorldFrame> = {}) {
      const customShader = await scene.resources.registerShader(name);
      const all = submit({ ...view, ...frame, entities: [{ ...base, ...value, customShader }] }).flatMap(view => view.batches);
      return all.filter(batch => batch.texture.kind === "bind-image" && batch.texture.image === whiteImage && batch.state.cull === "none");
    }
    const tinted = await selected("test/model_entity", { shaderRGBA: { x: 77, y: 123, z: 201, w: 64 }, shaderTexCoord: { x: 0.2, y: 0.3 } }, { refdef: { ...view.refdef, time: 1000 } });
    expect(first(first(tinted).vertices).color).toEqual({ x: 77 / 255, y: 123 / 255, z: 201 / 255, w: 64 / 255 });
    const diffuse = await selected("test/model_diffuse");
    const lit = await selected("test/model_diffuse", {}, { dynamicLights: [{ origin: view.refdef.viewOrigin, radius: 250, color: { x: 1, y: 0, z: 0 } }] });
    expect(lit.map(batch => batch.vertices.map(vertex => vertex.color))).not.toEqual(diffuse.map(batch => batch.vertices.map(vertex => vertex.color)));
    const firstLights = Array.from({ length: 32 }, () => ({ origin: view.refdef.viewOrigin, radius: 1, color: { x: 0, y: 0, z: 0 } }));
    const acceptedLights = await selected("test/model_diffuse", {}, { dynamicLights: firstLights });
    const sourceCappedLights = await selected("test/model_diffuse", {}, { dynamicLights: [
      ...firstLights,
      { origin: view.refdef.viewOrigin, radius: 1000, color: { x: 1, y: 0, z: 0 } },
    ] });
    expect(sourceCappedLights.map(batch => batch.vertices.map(vertex => vertex.color))).toEqual(acceptedLights.map(batch => batch.vertices.map(vertex => vertex.color)));
    const specular = await selected("test/model_specular");
    expect(specular.flatMap(batch => batch.vertices).every(vertex => vertex.color.w >= 0 && vertex.color.w <= 1)).toBe(true);
    const environment = await selected("test/model_environment");
    const rotated = await selected("test/model_environment", { axis: [view.refdef.viewAxis[1], scale3(view.refdef.viewAxis[0], -1), view.refdef.viewAxis[2]] });
    expect(environment.map(batch => batch.vertices.map(vertex => vertex.texCoord))).not.toEqual(rotated.map(batch => batch.vertices.map(vertex => vertex.texCoord)));
    const moved = await selected("test/model_move", {}, { refdef: { ...view.refdef, time: 250 } });
    const unmoved = await selected("test/model_move", {}, { refdef: { ...view.refdef, time: 0 } });
    expect(first(first(moved).vertices).position).not.toEqual(first(first(unmoved).vertices).position);
    const lightmap = await selected("test/model_lightmap");
    expect(lightmap.length).toBeGreaterThan(0);
    expect(lightmap.every(batch => batch.texture.kind === "bind-image" && batch.texture.image === whiteImage
      && batch.vertices.every(vertex => vertex.color.x === 1 && vertex.color.y === 1 && vertex.color.z === 1))).toBe(true);
    const offset = await scene.resources.registerShader("test/model_offset");
    expect(submit({ ...view, entities: [{ ...base, customShader: offset }] }).flatMap(view => view.batches).some(batch => batch.state.polygonOffset?.units === -2)).toBe(true);
    const vertex = await scene.resources.registerShader("test/model_vertex");
    const whitePicture = scene.resources.picture(await scene.resources.registerShaderNoMip("white"));
    const draw = commands.draw2D("pixels");
    draw.setColor({ x: 0.5, y: 0.25, z: 0.75, w: 0.5 });
    for (let quad = 0; quad < 249; quad++) draw.drawPic({ x: -4, y: -4, width: 1, height: 1 }, whitePicture);
    commands.submit();
    // RB_SurfaceMesh leaves vertexColors untouched; CGEN_VERTEX consumes the preceding StretchPic bytes.
    const retained = submit({ ...view, refdef: { ...view.refdef, renderFlags: RDF_NOWORLDMODEL }, entities: [{ ...base, customShader: vertex }] }).flatMap(view => view.batches);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.flatMap(batch => batch.vertices).every(vertex => vertex.color.x === 127 / 255 && vertex.color.y === 63 / 255
      && vertex.color.z === 191 / 255 && vertex.color.w === 127 / 255)).toBe(true);
  });

  test("animates retail Sarge attachments, weapon and item through both products", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
      const { scene, view: camera, submit, cpu, gl } = await fixture(product, "q3dm1", false, true);
      const view = { ...camera, refdef: { ...camera.refdef, width: 320, height: 240 } };
      const lower = await scene.resources.registerModel("models/players/sarge/lower.md3"), upper = await scene.resources.registerModel("models/players/sarge/upper.md3");
      const head = await scene.resources.registerModel("models/players/sarge/head.md3");
      const weapon = await scene.resources.registerModel(product === "baseq3" ? "models/weapons2/machinegun/machinegun.md3" : "models/weapons/nailgun/nailgun.md3");
      const item = await scene.resources.registerModel("models/powerups/health/medium_cross.md3");
      if (lower.kind !== "md3" || upper.kind !== "md3" || lower.md3[0] === null || upper.md3[0] === null) throw new Error("retail MD3 registration failed");
      const legs = { ...entity(lower, view), frame: 60, oldFrame: 59, backLerp: 0.35, customSkin: await scene.resources.registerSkin("models/players/sarge/lower_default.skin") };
      const torsoTag = transformMd3Tag(lower.md3[0], "tag_torso", legs.oldFrame, legs.frame, 1 - legs.backLerp, legs);
      if (torsoTag === null) throw new Error("retail torso tag missing");
      const torso = { ...entity(upper, view), origin: torsoTag.origin, axis: torsoTag.axes, frame: 60, oldFrame: 59, backLerp: 0.35, customSkin: await scene.resources.registerSkin("models/players/sarge/upper_default.skin") };
      const headTag = transformMd3Tag(upper.md3[0], "tag_head", 59, 60, 0.65, torso), weaponTag = transformMd3Tag(upper.md3[0], "tag_weapon", 59, 60, 0.65, torso);
      if (headTag === null || weaponTag === null) throw new Error("retail head/weapon tag missing");
      const entities = [legs, torso, { ...entity(head, view), origin: headTag.origin, axis: headTag.axes, customSkin: await scene.resources.registerSkin("models/players/sarge/head_default.skin") },
        { ...entity(weapon, view), origin: weaponTag.origin, axis: weaponTag.axes }, { ...entity(item, view), origin: add3(legs.origin, scale3(view.refdef.viewAxis[1], -32)) }];
      const before = submit(view), worldPixels = new Uint8Array(cpu.pixels);
      const batches = submit({ ...view, entities });
      expect(batches.flatMap(view => view.batches).length).toBeGreaterThan(before.flatMap(view => view.batches).length);
      expect(cpu.pixels).not.toEqual(worldPixels);
      let changed = 0;
      for (let index = 0; index < cpu.pixels.length; index += 4) if (cpu.pixels[index] !== worldPixels[index]
        || cpu.pixels[index + 1] !== worldPixels[index + 1] || cpu.pixels[index + 2] !== worldPixels[index + 2]) changed++;
      expect(changed).toBeGreaterThan(1000);
      if (process.env["Q3_MODEL_IMAGES"] !== undefined) await Bun.write(`${process.env["Q3_MODEL_IMAGES"]}/${product}-models-cpu.png`, encodePng(view.refdef.width, view.refdef.height, cpu.pixels));
      if (gl !== null) {
          const pixels = gl.readPixels();
          let difference = 0;
          for (let index = 0; index < pixels.length; index++) { const a = pixels[index], b = cpu.pixels[index]; if (a === undefined || b === undefined) throw new Error("parity byte missing"); difference += Math.abs(a - b); }
          expect(difference / pixels.length).toBeLessThan(5);
          if (process.env["Q3_MODEL_IMAGES"] !== undefined) await Bun.write(`${process.env["Q3_MODEL_IMAGES"]}/${product}-models-gl.png`, encodePng(view.refdef.width, view.refdef.height, pixels));
      }
    }
  }, 30000);

  test("places each model fog pass beside its material stages using transformed world coordinates", async () => {
    const { scene, view: camera, submit, cvars } = await fixture("baseq3", "q3tourney5");
    const fog = scene.map.fogs[0];
    if (fog === undefined) throw new Error("retail fog volume missing");
    const center = scale3(add3(fog.bounds.min, fog.bounds.max), 0.5);
    const view = { ...camera, refdef: { ...camera.refdef, viewOrigin: add3(center, { x: 100, y: 0, z: 0 }), viewAxis: anglesToAxis({ x: 0, y: 180, z: 0 }) } };
    const model = await scene.resources.registerModel("models/weapons2/machinegun/machinegun.md3");
    const customShader = await scene.resources.registerShader("test/model_opaque");
    const batches = submit({ ...view, entities: [{ ...entity(model, view), origin: center, customShader }] }).flatMap(view => view.batches);
    const whiteImage = scene.resources.picture(null).material.whiteImage;
    const main = batches.findIndex(batch => batch.state.cull === "none" && batch.texture.kind === "bind-image" && batch.texture.image === whiteImage
      && batch.vertices.every(vertex => vertex.color.x === 1 && vertex.color.y === 0 && vertex.color.z === 0));
    expect(main).toBeGreaterThanOrEqual(0);
    const fogPass = batches[main + 1];
    if (fogPass === undefined) throw new Error("model fog pass missing");
    if (fogPass.texture.kind !== "bind-image") throw new Error("model fog texture missing");
    expect(fogPass.texture.image.sourceWidth).toBe(256); expect(fogPass.texture.image.sourceHeight).toBe(32);
    expect(fogPass.state.depthTest).toBe("equal"); expect(fogPass.state.depthWrite).toBe(false);
    cvars.set("cg_shadows", "3");
    expect(submit({ ...view, entities: [{ ...entity(model, view), origin: center, customShader, renderFlags: RF_SHADOW_PLANE }] }).flatMap(view => view.batches)).toEqual(batches);
  });
});
