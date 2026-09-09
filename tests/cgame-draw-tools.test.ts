import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { ClientDrawTools, drawStrlen, fadeColor, teamColor, getColorForHealth, colorForHealth } from "../src/cgame/draw-tools.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ClientMedia } from "../src/cgame/media.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { RendererResources } from "../src/render/world.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { Team } from "../src/shared/definitions.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { UI_CENTER, UI_SMALLFONT, UI_INVERSE, UI_DROPSHADOW } from "../src/render/font.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { statSchema } from "../src/shared/definitions.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { pictureQuads } from "./picture-quads-fixture.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
type ObservedTools = ClientDrawTools & { readonly commands: RenderCommandBuffer; readonly recording: BatchRecordingBackend; readonly cpu: SoftwareRenderer; readonly tess: RendererResources["tess"] };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const WHITE = { x: 1, y: 1, z: 1, w: 1 };
async function fixture(width = 1280, height = 720): Promise<ObservedTools> {
  const image = new Uint8Array(22); image[2] = 2; image[12] = 1; image[14] = 1; image[16] = 32; image[17] = 0x20; image.fill(255, 18);
  const assets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ list: () => [], has: path => path.endsWith(".tga"),
    read: () => Promise.resolve(image), readSync: () => image,
    readFileLength: path => path.endsWith(".tga") ? image.byteLength : -1,
    readFileOptional: async path => path.endsWith(".tga") ? image : undefined,
    readFileOptionalSync: path => path.endsWith(".tga") ? image : undefined });
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images);
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 0 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const settings = createRendererSettings();
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => { try { commands.close("discard"); } finally { try { target.close(); } finally { cinematics.dispose(); } } });
  const soundDebugMessages: string[] = [];
  const media = new ClientMedia("baseq3", new ClientGameStaticState("baseq3"), resources, new ClientSoundBank(assets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => {} }));
  const shader = await resources.registerShaderNoMip("fixture");
  media.graphics.whiteShader = shader; media.graphics.charsetShader = shader; media.graphics.backTileShader = shader;
  media.graphics.charsetProp = shader; media.graphics.charsetPropGlow = shader; media.graphics.charsetPropB = shader;
  return Object.assign(new ClientDrawTools(commands.draw2D("stretch-640"), media), { commands, recording, cpu, tess: resources.tess });
}
function batch(tools: ObservedTools, index: number): DrawBatch {
  const result = pictureQuads(tools.recording.trace().flatMap(view => view.batches))[index]; if (result === undefined) throw new Error(`Missing batch ${index}`); return result;
}
function rect(tools: ObservedTools, index: number): readonly number[] {
  const vertices = batch(tools, index).vertices, first = vertices[0], last = vertices[2];
  if (first === undefined || last === undefined) throw new Error("Missing rectangle vertices");
  return [(first.position.x + 1) * tools.draw.width / 2, (1 - first.position.y) * tools.draw.height / 2,
    (last.position.x - first.position.x) * tools.draw.width / 2, (first.position.y - last.position.y) * tools.draw.height / 2];
}
function expectRect(tools: ObservedTools, index: number, expected: readonly number[]): void {
  for (const [axis, value] of rect(tools, index).entries()) {
    const target = expected[axis]; if (target === undefined) throw new Error("Missing expected axis"); expect(value).toBeCloseTo(target, 3);
  }
}

test("quad inspection follows emitted source indices, retains grouping, and rejects other geometry", async () => {
  const tools = await fixture(640, 480), shader = tools.media.graphics.whiteShader;
  tools.drawPic({ x: 1, y: 2, width: 3, height: 4 }, shader);
  tools.drawPic({ x: 10, y: 20, width: 30, height: 40 }, shader);
  tools.commands.submit();
  const batches = tools.recording.trace().flatMap(view => view.batches), grouped = batches[0];
  if (grouped === undefined || grouped.texturing !== "single" || grouped.primitive !== "triangles") throw new Error("Missing source single-texture picture group");
  expect(batches).toHaveLength(1);
  expect(grouped.indices).toEqual([3, 0, 2, 2, 0, 1, 7, 4, 6, 6, 4, 5]);
  expect(pictureQuads(batches)).toHaveLength(2);
  expect(grouped.vertices).toHaveLength(8);
  expect(tools.tess.numVertexes).toBe(8); expect(tools.tess.numIndexes).toBe(0);
  tools.drawPic({ x: 50, y: 60, width: 7, height: 8 }, shader);
  tools.commands.submit();
  const continued = tools.recording.trace().flatMap(view => view.batches), tail = continued[1];
  if (tail === undefined) throw new Error("Missing post-EndSurface picture group");
  expect(tail.indices).toEqual([3, 0, 2, 2, 0, 1]); expect(tail.vertices).toHaveLength(4);
  expect(tools.tess.numVertexes).toBe(12); expect(tools.tess.numIndexes).toBe(0);
  expect(pictureQuads(continued)).toHaveLength(3); expectRect(tools, 2, [50, 60, 7, 8]);
  expect(() => pictureQuads([{ ...grouped, primitive: "lines", lineWidth: 1 }])).toThrow("single-texture triangles");
  expect(() => pictureQuads([{ ...grouped, texturing: "pair", vertices: grouped.vertices.map(vertex => ({ ...vertex, texCoord2: { x: 0, y: 0 } })),
    secondTexture: { binding: grouped.texture, environment: "modulate" } }])).toThrow("single-texture triangles");
  expect(() => pictureQuads([{ ...grouped, indices: [] }])).toThrow("complete emitted quads");
  expect(() => pictureQuads([{ ...grouped, indices: [0, 1, 2] }])).toThrow("complete emitted quads");
  expect(() => pictureQuads([{ ...grouped, indices: [3, 0, 2, 2, 0, 1, 3, 0, 2, 2, 0, 1] }])).toThrow("RB_StretchPic order");
  expect(() => pictureQuads([{ ...grouped, indices: [7, 4, 6, 6, 4, 5, 3, 0, 2, 2, 0, 1] }])).toThrow("quad span");
  expect(() => pictureQuads([{ ...grouped, vertices: grouped.vertices.slice(0, 7) }])).toThrow("quad span");
  expect(() => pictureQuads([{ ...grouped, indices: [0, -3, -1, -1, -3, -2] }])).toThrow("vertex prefix");
});

test("CG_AdjustFrom640 and rectangle traps preserve axis scales, order, UV zero and reset", async () => {
  const tools = await fixture();
  expect(tools.adjustFrom640({ x: 10, y: 20, width: 40, height: 30 })).toEqual({ x: 20, y: 30, width: 80, height: 45 });
  tools.drawRect({ x: 10, y: 20, width: 40, height: 30 }, 2, { x: 1, y: 0, z: 0, w: 0.5 });
  tools.commands.submit();
  expectRect(tools, 0, [20, 30, 80, 3]); expectRect(tools, 1, [20, 72, 80, 3]);
  expectRect(tools, 2, [20, 30, 4, 45]); expectRect(tools, 3, [96, 30, 4, 45]);
  for (const draw of tools.recording.trace().flatMap(view => view.batches)) for (const vertex of draw.vertices) {
    expect(vertex.texCoord).toEqual({ x: 0, y: 0 }); expect(vertex.color).toEqual({ x: 1, y: 0, z: 0, w: 127 / 255 });
  }
  tools.drawPic({ x: 0, y: 0, width: -10, height: 20 }, tools.media.graphics.whiteShader);
  tools.commands.submit();
  expectRect(tools, 4, [0, 0, -20, 30]); expect(batch(tools, 4).vertices[0]?.color).toEqual(WHITE);
  expect(batch(tools, 4).vertices[0]?.texCoord).toEqual({ x: 0, y: 0 });
});

test("CG_TileClear uses physical coordinates and source inclusive bottom/right overlap", async () => {
  const tools = await fixture(640, 480), view = createRefdef();
  view.width = 640; view.height = 480; tools.tileClear(view); tools.commands.submit(); expect(pictureQuads(tools.recording.trace().flatMap(view => view.batches))).toHaveLength(0);
  view.x = 64; view.y = 48; view.width = 512; view.height = 384; tools.tileClear(view);
  tools.commands.submit();
  expectRect(tools, 0, [0, 0, 640, 48]); expectRect(tools, 1, [0, 431, 640, 49]);
  expectRect(tools, 2, [0, 48, 64, 384]); expectRect(tools, 3, [575, 48, 65, 384]);
  expect(batch(tools, 3).vertices[0]?.texCoord).toEqual({ x: 575 / 64, y: 48 / 64 });
  expect(batch(tools, 3).vertices[2]?.texCoord).toEqual({ x: 10, y: 432 / 64 });
});

test("CG fixed text wrappers keep 16x16 and 8x16 metrics, escapes, shadow and forced color", async () => {
  const tools = await fixture(640, 480);
  tools.drawBigString(10, 20, "^1A B", 0.5);
  tools.commands.submit();
  expect(pictureQuads(tools.recording.trace().flatMap(view => view.batches))).toHaveLength(4);
  expectRect(tools, 0, [12, 22, 16, 16]); expectRect(tools, 1, [44, 22, 16, 16]);
  expectRect(tools, 2, [10, 20, 16, 16]); expectRect(tools, 3, [42, 20, 16, 16]);
  expect(batch(tools, 2).vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 127 / 255 });
  tools.drawSmallStringColor(0, 0, "^1AB", WHITE);
  tools.commands.submit();
  expectRect(tools, 4, [0, 0, 8, 16]); expectRect(tools, 5, [8, 0, 8, 16]);
  expect(batch(tools, 4).vertices[0]?.color).toEqual(WHITE);
  tools.drawChar(0, 0, 8, 16, 288); tools.commands.submit(); expect(pictureQuads(tools.recording.trace().flatMap(view => view.batches))).toHaveLength(6);
  expect(drawStrlen("^1A ^^B^2C\0ignored")).toBe(4);
});

test("CG_FadeColor exact 200ms fade boundary, zero sentinel and signed time wrap", () => {
  expect(fadeColor(100, 0, 1000)).toBeNull(); expect(fadeColor(1100, 100, 1000)).toBeNull();
  expect(fadeColor(900, 100, 1000)).toEqual(WHITE);
  expect(fadeColor(1000, 100, 1000)).toEqual({ ...WHITE, w: 0.5 });
  expect(fadeColor(1099, 100, 1000)?.w).toBe(Math.fround(0.005));
  expect(fadeColor(-2147483648, 2147483647, 100)).toEqual({ ...WHITE, w: Math.fround(99 / 200) });
});

test("CG health and team colors preserve source armor cap and boundary ramps", () => {
  expect(getColorForHealth(0, 200)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(getColorForHealth(1, 200)).toEqual({ x: 1, y: 0, z: 0, w: 1 });
  expect(getColorForHealth(30, 15)).toEqual({ x: 1, y: 0.5, z: 0, w: 1 });
  expect(getColorForHealth(33, 200)).toEqual({ x: 1, y: 1, z: Math.fround(31 / 33), w: 1 });
  expect(getColorForHealth(99, 0)).toEqual(WHITE); expect(getColorForHealth(100, 0)).toEqual(WHITE);
  expect(teamColor(Team.TEAM_RED)).toEqual({ x: 1, y: Math.fround(0.2), z: Math.fround(0.2), w: 1 });
  expect(teamColor(Team.TEAM_BLUE)).toEqual({ x: Math.fround(0.2), y: Math.fround(0.2), z: 1, w: 1 });
  expect(teamColor(Team.TEAM_SPECTATOR)).toEqual({ x: Math.fround(0.7), y: Math.fround(0.7), z: Math.fround(0.7), w: 1 });
  expect(teamColor(99)).toEqual(WHITE);
  expect(() => colorForHealth(new ClientGameState("baseq3", 0, 0))).toThrow("current snapshot");
  const state = new ClientGameState("missionpack", 0, 0), playerState = createPlayerState("missionpack");
  playerState.stats.set(statSchema("missionpack").health, 30); playerState.stats.set(statSchema("missionpack").armor, 15);
  state.snap = { playerState, messageNumber: 1, serverTime: 100, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(32), entities: [] };
  expect(colorForHealth(state)).toEqual({ x: 1, y: 0.5, z: 0, w: 1 });
});

test("cgame proportional and banner wrappers retain X-only vertical scaling and source unsupported glyph advance", async () => {
  const tools = await fixture();
  tools.drawProportionalString({ x: 320, y: 96, text: "A\u0001B", color: WHITE, style: UI_SMALLFONT | UI_CENTER | UI_INVERSE, time: 0 });
  // Source width39*.75 truncates29, centered x306. A27px +gap4.5, unsupported gap4.5, thenB.
  tools.commands.submit();
  expectRect(tools, 0, [612, 192, 27, 40.5]); expectRect(tools, 1, [648, 192, 27, 40.5]);
  expect(batch(tools, 0).vertices[0]?.color).toEqual({ x: 0.8, y: 0.8, z: 0.8, w: 1 });
  tools.drawBannerString({ x: 10, y: 20, text: "A", color: WHITE, style: UI_DROPSHADOW, time: 0 });
  tools.commands.submit();
  expectRect(tools, 2, [24, 44, 66, 72]); expectRect(tools, 3, [20, 40, 66, 72]);
});
