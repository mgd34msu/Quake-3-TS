import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { ClientDrawIcons } from "../src/cgame/draw-icons.ts";
import { ClientDrawTools } from "../src/cgame/draw-tools.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererResources } from "../src/render/world.ts";
import type { WorldFrame } from "../src/render/world.ts";
import type { RefModelEntity, SourceRefEntity } from "../src/render/ref-entity.ts";
import { modelBounds } from "../src/render/model-bounds.ts";
import { DEFAULT_MODEL, RF_NOSHADOW } from "../src/render/ref-entity.ts";
import { RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { vec3 } from "../src/core/math.ts";
import { Team, Powerup } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList, findItemForPowerup } from "../src/shared/items.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { createHash } from "node:crypto";
import { parseBsp } from "../src/assets/bsp.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { pictureQuads } from "./picture-quads-fixture.ts";

import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const box = { x: 10.9, y: 20.9, width: 60.9, height: 70.9 }, white = { x: 1, y: 1, z: 1, w: 1 };
type CapturedFrame = Omit<WorldFrame, "entities"> & { readonly entities: readonly SourceRefEntity[] };
function sceneModel(frame: CapturedFrame | undefined): RefModelEntity {
  const entity = frame?.entities[0];
  if (entity?.kind !== "model") throw new Error("Missing model scene");
  if (typeof entity.model === "number" || typeof entity.customShader === "number" || typeof entity.customSkin === "number")
    throw new Error("Typed icon caller submitted a numeric resource");
  return { ...entity, model: entity.model, customShader: entity.customShader, customSkin: entity.customSkin };
}
function md3Bytes(low = -10, high = 20): Uint8Array {
  const bytes = new Uint8Array(400), data = new DataView(bytes.buffer), encode = new TextEncoder();
  bytes.set(encode.encode("IDP3")); data.setInt32(4, 15, true); bytes.set(encode.encode("fixture"), 8);
  for (const [offset, value] of [[76, 1], [84, 1], [92, 108], [96, 164], [100, 164], [104, 400]] satisfies readonly (readonly [number, number])[]) data.setInt32(offset, value, true);
  for (const [i, value] of [-1, -5, low, 1, 5, high, 0, 0, 0, 100].entries()) data.setFloat32(108 + i * 4, value, true);
  bytes.set(encode.encode("frame"), 148); bytes.set(encode.encode("IDP3"), 164); bytes.set(encode.encode("body"), 168);
  for (const [offset, value] of [[72, 1], [76, 1], [80, 3], [84, 1], [88, 108], [92, 120], [96, 188], [100, 212], [104, 236]] satisfies readonly (readonly [number, number])[]) data.setInt32(164 + offset, value, true);
  data.setInt32(276, 1, true); data.setInt32(280, 2, true); bytes.set(encode.encode("fixture/model"), 284);
  for (const [i, coordinates] of [[0, -5, low], [0, 5, low], [0, 0, high]].entries()) {
    for (const [axis, coordinate] of coordinates.entries()) data.setInt16(376 + i * 8 + axis * 2, coordinate * 64, true);
  }
  return bytes;
}
async function fixture(product: Product = "baseq3", width = 1280, height = 720) {
  const tga = new Uint8Array(22); tga[2] = 2; tga[12] = 1; tga[14] = 1; tga[16] = 32; tga[17] = 0x20; tga.fill(255, 18);
  const shader = new TextEncoder().encode("fixture/model { cull none { map $whiteimage rgbGen identity } }");
  const read = (path: string): Uint8Array => path === "scripts/fixture.shader" ? shader : path.endsWith(".md3")
    ? md3Bytes(path.includes("short") ? -1 : path.includes("blue") ? -50 : -10, path.includes("short") ? 2 : path.includes("blue") ? 50 : 20) : tga;
  const assets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ list: () => ["scripts/fixture.shader"], has: path => path.endsWith(".md3") || path.endsWith(".tga") || path === "scripts/fixture.shader", read: async path => read(path), readSync: read,
    readFileLength(path) { return this.has(path) ? read(path).byteLength : -1; },
    async readFileOptional(path) { return this.has(path) ? read(path) : undefined; },
    readFileOptionalSync(path) { return this.has(path) ? read(path) : undefined; } });
  const state = new ClientGameState(product, 0, 0), clock = { cinematicTime: 9000, samples: new Array<number>() };
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), rendererClock = { milliseconds: () => { clock.samples.push(clock.cinematicTime); return clock.cinematicTime; } };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: rendererClock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const rendererSettings = createRendererSettings();
  const actual = await RendererResources.create(assets, { kind: "unaccounted" }, rendererSettings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics }), frames: CapturedFrame[] = [];
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: rendererClock, identityLight: 1, tess: actual.tess, runtime: rendererSettings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { cinematics.dispose(); } } });
  const resources: RendererResources = { ...actual, renderScene: refdef => {
    frames.push({ refdef, entities: actual.sceneEntities.sceneRange().copyRefEntities() });
    return actual.renderScene(refdef);
  } };
  const soundDebugMessages: string[] = [];
  const cgs = new ClientGameStaticState(product), media = new ClientMedia(product, cgs, resources, new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => {} }));
  const picture = await resources.registerShaderNoMip("fixture/picture");
  media.graphics.deferShader = picture; media.graphics.teamStatusBar = picture; media.graphics.whiteShader = picture;
  media.graphics.redFlagModel = await resources.registerModel("red.md3"); media.graphics.blueFlagModel = await resources.registerModel("blue.md3"); media.graphics.neutralFlagModel = await resources.registerModel("neutral.md3");
  const ci = cgs.clientInfo[0]; if (ci === undefined) throw new Error("Missing client fixture");
  ci.headModel = await resources.registerModel("head.md3"); ci.modelIcon = picture;
  const settings = { drawIcons: true, draw3dIcons: true };
  const tools = new ClientDrawTools(commands.draw2D("stretch-640"), media);
  const icons = new ClientDrawIcons(state, tools, () => settings, commands);
  return { icons, state, cgs, media, tools, commands, settings, frames, ci, clock, recording, cpu };
}

test("Draw3DModel builds source-zero entity and NOWORLDMODEL refdef with truncated scaled viewport and separate clocks", async () => {
  const value = await fixture(); value.state.time = 1234;
  value.tools.fillRect({ x: 0, y: 0, width: 640, height: 480 }, white);
  value.icons.draw3DModel(box, value.ci.headModel, null, vec3(100, 2, 3), vec3(0, 90, 0));
  value.tools.fillRect({ x: 5, y: 5, width: 3, height: 3 }, white);
  const frame = value.frames[0]; if (frame === undefined) throw new Error("Missing scene");
  expect(frame.refdef).toEqual({ x: 21, y: 31, width: 121, height: 106, fovX: 30, fovY: 30, time: 1234, renderFlags: RDF_NOWORLDMODEL,
    viewOrigin: vec3(0, 0, 0), viewAxis: [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)], areaMask: new Uint8Array(32), text: ["", "", "", "", "", "", "", ""] });
  expect(frame.entities).toHaveLength(1);
  const entity = sceneModel(frame);
  expect(entity.renderFlags).toBe(RF_NOSHADOW); expect(entity.shaderRGBA).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  expect(entity.origin).toEqual(vec3(100, 2, 3)); expect(entity.oldOrigin).toEqual(vec3(0, 0, 0)); expect(entity.frame).toBe(0); expect(entity.oldFrame).toBe(0);
  expect(entity.axis[0].y).toBe(1); expect(entity.axis[1].x).toBe(-1);
  value.commands.submitFrame();
  expect(value.recording.trace().map(view => view.state.clear === null ? "2d" : "view")).toEqual(["2d", "view", "2d"]);
  expect(value.clock.samples).toContain(9000); expect(value.clock.samples.every(sample => sample === 9000)).toBe(true);
  value.icons.draw3DModel(box, value.ci.headModel, null, vec3(100, 0, 0), vec3(0, 0, 0));
  expect(value.frames[1]?.entities).toHaveLength(1);
});

test("Draw3DModel uses source QVM angle conversion before trigonometry", async () => {
  const value = await fixture();
  value.icons.draw3DModel(box, value.ci.headModel, null, vec3(100, 0, 0), vec3(0, 27, 0));
  const entity = sceneModel(value.frames[0]);
  expect(entity.axis[0].y).toBe(0.45399048924446106);
  expect(entity.axis[1].x).toBe(-0.45399048924446106);
  expect(Object.is(entity.axis[0].z, -0)).toBe(true);
});

test("head bounds use first MD3 frame and offsets, with missing-head return before deferred cross", async () => {
  const value = await fixture(); value.ci.headOffset = vec3(1, 2, 3); value.ci.deferred = true;
  value.icons.drawHead(box, 0, vec3(0, 0, 0));
  expect(sceneModel(value.frames[0]).origin).toEqual(vec3(Math.fround(Math.fround(21 / Math.fround(0.268)) + 1), 2, -2));
  value.commands.submitFrame();
  expect(value.recording.trace().map(view => view.state.clear === null ? "2d" : "view")).toEqual(["view", "2d"]);
  const missing = await fixture(); missing.ci.headModel = DEFAULT_MODEL; missing.ci.deferred = true;
  missing.icons.drawHead(box, 0, vec3(0, 0, 0)); expect(missing.frames).toHaveLength(0); missing.commands.submitFrame(); expect(missing.recording.trace()).toHaveLength(0);
  const disabled = await fixture(); disabled.settings.drawIcons = false; disabled.ci.deferred = true;
  disabled.icons.drawHead(box, 0, vec3(0, 0, 0)); expect(disabled.frames).toHaveLength(0); disabled.commands.submitFrame(); expect(disabled.recording.trace().map(view => view.state.clear === null ? "2d" : "view")).toEqual(["2d"]);
});

test("2D head and deferred cross preserve draw order and source independent icon conditions", async () => {
  const value = await fixture(); value.settings.draw3dIcons = false; value.ci.deferred = true;
  value.icons.drawHead(box, 0, vec3(0, 0, 0));
  value.commands.submitFrame();
  const batches = value.recording.trace().flatMap(view => view.batches); expect(batches).toHaveLength(1);
  // Both source quads share one shader, so RB_StretchPic appends them to one tess surface.
  expect(batches[0]?.indices).toEqual([3, 0, 2, 2, 0, 1, 7, 4, 6, 6, 4, 5]);
  value.settings.drawIcons = false;
  value.icons.drawHead(box, 0, vec3(0, 0, 0)); value.commands.submitFrame();
  expect(value.recording.trace().flatMap(view => view.batches).slice(batches.length)).toHaveLength(1);
  const count = value.recording.trace().flatMap(view => view.batches).length;
  value.ci.deferred = false; value.icons.drawHead(box, 0, vec3(0, 0, 0)); value.commands.submitFrame();
  expect(value.recording.trace().flatMap(view => view.batches).slice(count)).toHaveLength(0);
});

test("head distance retains the QVM float32 literal and division profile", async () => {
  const value = await fixture(); value.ci.headModel = await value.media.resources.registerModel("short-head.md3");
  value.icons.drawHead(box, 0, vec3(0, 0, 0));
  // q3lcc stores 0.7 and 0.268 as float32. Native double division instead ends in 67489624.
  expect(sceneModel(value.frames[0]).origin).toEqual(vec3(7.835820198059082, 0, -0.5));
});

test("blue and neutral flags reuse red model bounds and source sine yaw; force2D selects actual item icon", async () => {
  const value = await fixture("missionpack"); value.state.time = 1000;
  for (const team of [Team.TEAM_RED, Team.TEAM_BLUE, Team.TEAM_FREE]) value.icons.drawFlagModel(box, team, false);
  for (const frame of value.frames) expect(sceneModel(frame).origin).toEqual(vec3(Math.fround(15 / Math.fround(0.268)), 0, -5));
  expect(value.frames.map(frame => sceneModel(frame).model.path)).toEqual(["red.md3", "blue.md3", "neutral.md3"]);
  const expectedYaw = Math.fround(60 * Math.fround(Math.sin(0.5)));
  expect(sceneModel(value.frames[0]).axis[0].y).toBeCloseTo(Math.sin(expectedYaw * Math.PI / 180), 6);
  const item = findItemForPowerup("missionpack", Powerup.PW_BLUEFLAG); if (item === null) throw new Error("Missing source flag item");
  const index = itemList("missionpack").indexOf(item); await value.media.weaponRegistry.registerItemVisuals(index);
  value.icons.drawFlagModel(box, Team.TEAM_BLUE, true);
  const visual = value.media.weaponRegistry.items[index]; if (visual === undefined) throw new Error("Missing registered flag item");
  value.commands.submitFrame();
  const actualBatches = pictureQuads(value.recording.trace().filter(view => view.state.clear === null).flatMap(view => view.batches));
  const count = value.recording.trace().flatMap(view => view.batches).length;
  value.tools.draw.drawPic(box, value.media.resources.picture(visual.icon)); value.commands.submitFrame();
  const expectedBatches = pictureQuads(value.recording.trace().flatMap(view => view.batches).slice(count));
  expect(actualBatches).toHaveLength(1); expect(expectedBatches).toHaveLength(1);
  const actualBatch = actualBatches[0], expectedBatch = expectedBatches[0];
  if (actualBatch === undefined || expectedBatch === undefined) throw new Error("Missing evaluated flag icon batch");
  expect(expectedBatch.state.cull).toBe("none");
  // RB_SetGL2D disables culling without changing GL_Cull's cached mode.
  expect(actualBatch).toEqual({ ...expectedBatch, state: { ...expectedBatch.state, cull: "front" } });
  const actualTexture = actualBatch.texture, expectedTexture = expectedBatch.texture;
  if (actualTexture.kind !== "bind-image" || expectedTexture.kind !== "bind-image") throw new Error("Missing evaluated flag icon texture");
  expect(actualTexture.image).toBe(expectedTexture.image);
  value.settings.drawIcons = false; value.icons.drawFlagModel(box, Team.TEAM_RED, false); expect(value.frames).toHaveLength(3);
  value.icons.drawFlagModel(box, Team.TEAM_SPECTATOR, false); expect(value.frames).toHaveLength(3);
  const base = await fixture(); base.icons.drawFlagModel(box, Team.TEAM_FREE, true); base.commands.submitFrame(); expect(base.recording.trace()).toHaveLength(0);
});

test("team background ignores icon cvars, truncates source integer arguments and resets color", async () => {
  const value = await fixture(); value.settings.drawIcons = false; value.settings.draw3dIcons = false;
  value.icons.drawTeamBackground(box, 0.33, Team.TEAM_BLUE);
  value.commands.submitFrame();
  const vertex = value.recording.trace().flatMap(view => view.batches)[0]?.vertices[0]; if (vertex === undefined) throw new Error("Missing background");
  expect(vertex.color).toEqual({ x: 0, y: 0, z: 1, w: 84 / 255 });
  expect((vertex.position.x + 1) * 640).toBeCloseTo(20, 4); expect((1 - vertex.position.y) * 360).toBeCloseTo(30, 4);
  value.tools.drawPic(box, value.media.graphics.whiteShader);
  value.commands.submitFrame();
  const second = value.recording.trace().flatMap(view => view.batches)[1]; if (second === undefined) throw new Error("Missing second picture");
  for (const index of second.indices) expect(second.vertices[index]?.color).toEqual(white);
  value.icons.drawTeamBackground(box, 1, Team.TEAM_FREE); value.commands.submitFrame(); expect(value.recording.trace().flatMap(view => view.batches)).toHaveLength(2);
});

test("model bounds return owned source frame-zero/default values", async () => {
  const value = await fixture(), model = value.ci.headModel;
  expect(modelBounds(DEFAULT_MODEL)).toEqual({ min: vec3(0, 0, 0), max: vec3(0, 0, 0) });
  expect(modelBounds(model)).toEqual({ min: vec3(-1, -5, -10), max: vec3(1, 5, 20) });
  if (model.kind !== "md3" || model.md3[0] === null) throw new Error("Missing MD3");
  expect(modelBounds(model).min).not.toBe(model.md3[0].frames[0]?.bounds.min);
  const first = model.md3[0].frames[0]; if (first === undefined) throw new Error("Missing first frame");
  expect(modelBounds({ ...model, md3: [{ ...model.md3[0], frames: [first, { ...first, bounds: { min: vec3(-500, -500, -500), max: vec3(500, 500, 500) } }] }, model.md3[1], model.md3[2]] })).toEqual(first.bounds);
  const map = parseBsp(renderBspFixture([{ shader: "fixture", lightmap: -1 }, { shader: "fixture", lightmap: -1 }], []));
  expect(modelBounds({ kind: "inline", path: "*0", index: 0, map })).toEqual({ min: vec3(0, -64, -64), max: vec3(96, 64, 64) });
  expect(() => modelBounds({ kind: "inline", path: "*1", index: 1, map })).toThrow("outside its BSP");
});

test("draw3DModel suppresses disabled icons and empty source viewport without clearing pending2D", async () => {
  const value = await fixture(); value.tools.fillRect(box, white);
  value.settings.drawIcons = false; value.icons.draw3DModel(box, DEFAULT_MODEL, null, vec3(100, 0, 0), vec3(0, 0, 0));
  value.settings.drawIcons = true; value.settings.draw3dIcons = false; value.icons.draw3DModel(box, DEFAULT_MODEL, null, vec3(100, 0, 0), vec3(0, 0, 0));
  expect(value.frames).toHaveLength(0); value.commands.submitFrame(); expect(value.recording.trace().flatMap(view => view.batches)).toHaveLength(1);
  value.settings.draw3dIcons = true; value.icons.draw3DModel({ ...box, width: 0 }, DEFAULT_MODEL, null, vec3(100, 0, 0), vec3(0, 0, 0));
  expect(value.frames).toHaveLength(1); value.commands.submitFrame(); expect(value.recording.trace().map(view => view.state.clear === null ? "2d" : "view")).toEqual(["2d"]);
});

test.skipIf(process.env["Q3_DATA"] === undefined)("retail head skins and flag models render in ordered scoreboard-style CPU and GL commands", async () => {
  const dataPath = process.env["Q3_DATA"]; if (dataPath === undefined) throw new Error("Missing retail path");
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const images = new RendererImageCatalog();
    const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: `Cgame icons ${product}`, width: 320, height: 240, backend: "gl", hidden: true }) : null;
    const gl = window === null ? null : new GlRenderer(window, images);
    const settings = createRendererSettings();
    gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const cpu = new SoftwareRenderer(320, 240, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
    const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]), builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 2000 };
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
    const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    cleanup.push(() => { try { commands.close("require-empty"); } finally { try { target.close(); } finally { try { cinematics.dispose(); } finally { window?.close(); } } } });
    const soundDebugMessages: string[] = [];
    const state = new ClientGameState(product, 0, 0), cgs = new ClientGameStaticState(product), media = new ClientMedia(product, cgs, resources, new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => {} })); state.time = 1000;
    const client = cgs.clientInfo[0]; if (client === undefined) throw new Error("Missing retail client");
    client.headModel = await resources.registerModel("models/players/sarge/head.md3"); client.headSkin = await resources.registerSkin("models/players/sarge/head_default.skin");
    expect(client.headModel.kind).toBe("md3"); expect(client.headSkin).not.toBeNull();
    media.graphics.redFlagModel = await resources.registerModel("models/flags/r_flag.md3"); media.graphics.blueFlagModel = await resources.registerModel("models/flags/b_flag.md3");
    media.graphics.neutralFlagModel = await resources.registerModel("models/flags/n_flag.md3");
    media.graphics.whiteShader = await resources.registerShader("white"); media.graphics.teamStatusBar = await resources.registerShader("gfx/2d/colorbar.tga"); media.graphics.deferShader = await resources.registerShaderNoMip("gfx/2d/defer.tga");
    expect(media.graphics.whiteShader).not.toBeNull();
    const tools = new ClientDrawTools(commands.draw2D("stretch-640"), media);
    const icons = new ClientDrawIcons(state, tools, () => ({ drawIcons: true, draw3dIcons: true }), commands);
    tools.fillRect({ x: 0, y: 0, width: 640, height: 480 }, { x: 0.04, y: 0.06, z: 0.1, w: 1 });
    icons.drawTeamBackground({ x: 16, y: 100, width: 608, height: 150 }, 0.33, Team.TEAM_RED);
    icons.drawHead({ x: 20, y: 100, width: 128, height: 128 }, 0, vec3(0, 180, 0));
    client.deferred = true; icons.drawHead({ x: 170, y: 100, width: 128, height: 128 }, 0, vec3(0, 160, 0));
    icons.drawFlagModel({ x: 330, y: 100, width: 128, height: 128 }, Team.TEAM_RED, false);
    icons.drawFlagModel({ x: 480, y: 100, width: 128, height: 128 }, Team.TEAM_BLUE, false);
    tools.drawRect({ x: 16, y: 100, width: 608, height: 150 }, 2, white);
    commands.submitFrame();
    expect(Array.from(cpu.pixels.subarray(0, 4))).toEqual([10, 15, 25, 255]);
    const head = cpu.pixels.subarray((70 * 320 + 20) * 4, (70 * 320 + 60) * 4); expect(new Set(head).size).toBeGreaterThan(8);
    const output = process.env["Q3_ICONS_CAPTURE"];
    const save = async (suffix: string, pixels: Uint8Array): Promise<void> => {
      if (output === undefined) return;
      const bytes = new Uint8Array(18 + pixels.length), view = new DataView(bytes.buffer); bytes[2] = 2; view.setUint16(12, 320, true); view.setUint16(14, 240, true); bytes[16] = 32; bytes[17] = 0x28;
      for (let i = 0; i < pixels.length; i += 4) { const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3]; if (r === undefined || g === undefined || b === undefined || a === undefined) throw new Error("Missing pixel"); bytes.set([b, g, r, a], 18 + i); }
      await Bun.write(`${output}.${product}.${suffix}.tga`, bytes);
    };
    await save("cpu", cpu.pixels);
    if (gl !== null) {
      const pixels = gl.readPixels(); await save("gl", pixels);
      let maximum = 0, total = 0, largeRgbDifferences = 0, alphaMaximum = 0;
      for (const [index, value] of cpu.pixels.entries()) {
        const other = pixels[index]; if (other === undefined) throw new Error("Missing GL channel");
        const delta = Math.abs(value - other); maximum = Math.max(maximum, delta); total += delta;
        if (index % 4 === 3) alphaMaximum = Math.max(alphaMaximum, delta);
        else if (delta > 4) largeRgbDifferences++;
      }
      process.stdout.write(`${product} icons CPU ${createHash("sha256").update(cpu.pixels).digest("hex")} GL ${createHash("sha256").update(pixels).digest("hex")} driver ${JSON.stringify(gl.driver)} subpixelBits ${gl.subpixelBits} mean ${total / pixels.length} max ${maximum} RGB>4 ${largeRgbDifferences}\n`);
      // NVIDIA 610.57.04, RTX 3090/5060 Ti, eight subpixel bits: two thin flagpole red samples are 65/60.
      // This bounded filtering tolerance is not a bit-exact original-renderer claim.
      expect(total / pixels.length).toBeLessThanOrEqual(0.02); expect(maximum).toBeLessThanOrEqual(5);
      expect(largeRgbDifferences).toBeLessThanOrEqual(2); expect(alphaMaximum).toBeLessThanOrEqual(4);
    }
  }
}, 120000);
