import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, expect, test } from "bun:test";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { RoqDecoder } from "../src/cinematic/roq.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget, type PreparedBackendDraw, type PreparedBackendSourceDraw } from "../src/render/commands.ts";
import type { CinematicUpload, ShaderCinematicSource } from "../src/render/cinematic-command.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources, type WorldScene } from "../src/render/world.ts";
import type { DrawBatch, SourceStageData, TextureBinding } from "../src/render/types.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function chunk(id: number, bytes: readonly number[], flags = 0): Uint8Array {
  const writer = new BinaryWriter(bytes.length + 8);
  writer.u16(id); writer.u32(bytes.length); writer.u16(flags); writer.bytes(Uint8Array.from(bytes)); return writer.finish();
}
function smallMovie(): Uint8Array {
  const chunks = [chunk(0x1001, [8, 0, 8, 0, 8, 0, 4, 0]),
    chunk(0x1002, [0, 0, 0, 0, 128, 128, 255, 255, 255, 255, 128, 128, 0, 0, 0, 0, 1, 1, 1, 1], 0x0202),
    chunk(0x1021, [1, 2, 3, 4]), chunk(0x1011, [0, 128, 0]), chunk(0x1020, [5, 6]), chunk(0x1011, [0, 128, 1]), chunk(0x1013, [])];
  const writer = new BinaryWriter(8 + chunks.reduce((total, item) => total + item.length, 0));
  writer.u16(0x1084); writer.u32(0xffffffff); writer.u16(30);
  for (const item of chunks) writer.bytes(item);
  return writer.finish();
}
function hash(bytes: Uint8Array): string { return Bun.CryptoHasher.hash("sha256", bytes, "hex"); }
class UploadCpu extends SoftwareRenderer {
  uploadCount = 0;
  latestUpload: CinematicUpload | null = null;
  private bindings: TextureBinding[] = [];
  retains = 0;
  get pendingBindingCount(): number { return this.bindings.length; }
  takeBindings(): readonly TextureBinding[] {
    const bindings = this.bindings;
    this.bindings = [];
    return bindings;
  }
  override prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const draw = super.prepareGeometry(batch);
    return { begin: () => draw.begin(), draw: () => {
      draw.draw();
      this.bindings.push(batch.texture);
      if (batch.texturing === "pair") this.bindings.push(batch.secondTexture.binding);
    }, cleanup: () => draw.cleanup(), applyTexture: (unit, operation) => {
      draw.applyTexture(unit, operation);
      if (operation.kind === "cinematic-upload") { this.uploadCount++; this.latestUpload = operation.upload; }
      if (operation.kind === "retain-current-texture") this.retains++;
    } };
  }
  override prepareSourceGeometry(stage: SourceStageData): PreparedBackendSourceDraw {
    const draw = super.prepareSourceGeometry(stage), batch = stage.batch;
    return { begin: () => draw.begin(), prepareTexture: unit => draw.prepareTexture(unit),
      finishTextures: () => draw.finishTextures(), draw: primitives => {
      draw.draw(primitives);
      this.bindings.push(batch.texture);
      if (batch.texturing === "pair") this.bindings.push(batch.secondTexture.binding);
    }, cleanup: () => draw.cleanup(), applyTexture: (unit, operation) => {
      draw.applyTexture(unit, operation);
      if (operation.kind === "cinematic-upload") { this.uploadCount++; this.latestUpload = operation.upload; }
      if (operation.kind === "retain-current-texture") this.retains++;
    } };
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, width = 64, height = 64, window: SdlWindow | null = null) {
  const images = new RendererImageCatalog(), gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new UploadCpu(width, height, images, gl?.subpixelBits ?? 8);
  const target = gl === null ? new RenderTarget(images, [cpu]) : new RenderTarget(images, [cpu, gl]);
  const settings = createRendererSettings();
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { time: 0, milliseconds(): number { return this.time; } };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: () => clock.milliseconds() }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanups.push(() => { commands.close("discard"); cinematics.dispose(); target.close(); window?.close(); });
  function screen(source: ShaderCinematicSource): readonly TextureBinding[] {
    commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, depth: 1, color: { x: 0, y: 0, z: 0, w: 1 } }, operations: [{ kind: "draw", batches: [screenBatch(source)] }] });
    commands.submit(); resources.tess.endFrame();
    return cpu.takeBindings();
  }
  function worldFrame(world: WorldScene, sceneSeconds: number): readonly TextureBinding[] {
    commands.addPreparedViews(world.prepareFrame({ refdef: cameraRefdef(world.initialCamera(), width, height, Math.trunc(sceneSeconds * 1000)) }));
    commands.submit(); resources.tess.endFrame();
    return cpu.takeBindings();
  }
  return { resources, cinematics, builtins, clock, cpu, gl, mixer, screen, worldFrame };
}
function latest(f: Awaited<ReturnType<typeof fixture>>): CinematicUpload {
  const upload = f.cpu.latestUpload; if (upload === null) throw new Error("Missing executed cinematic upload"); return upload;
}
async function smallFixture() {
  const bytes = smallMovie(), f = await fixture(withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: path => path === "video/fixture.roq" ? bytes.byteLength : -1,
    readFileOptional: async path => path === "video/fixture.roq" ? bytes : undefined,
    has: path => path === "video/fixture.roq", list: () => [], read: async () => bytes }));
  const source = await f.cinematics.shaderCinematics.playShaderCinematic("fixture.roq"); if (source === null) throw new Error("Missing movie");
  const advance = (time: number): readonly TextureBinding[] => { f.clock.time = time; return f.screen(source); };
  const frameHash = (): string => hash(latest(f).content.copyPixels().subarray(0, 8 * 8 * 4));
  return { ...f, source, advance, frameHash };
}

test("video material retains one real scratch identity through silent loops and backward source clocks", async () => {
  const f = await smallFixture(); const firstBindings = f.advance(5000);
  expect(f.cpu.uploadCount).toBe(0); expect(f.source.image).toBe(f.builtins.scratchImage(0));
  expect(f.cpu.retains).toBe(1);
  expect(firstBindings[0]?.kind).toBe("shader-cinematic");
  expect(f.cpu.pendingBindingCount).toBe(0);
  f.advance(5034); const first = f.frameHash(), upload = latest(f);
  expect([upload.uploadWidth, upload.uploadHeight]).toEqual([256, 256]);
  f.advance(5034); expect(f.frameHash()).toBe(first); expect(latest(f).image).toBe(upload.image);
  f.advance(5067); expect(f.frameHash()).not.toBe(first); expect(latest(f).image).toBe(upload.image);
  expect(f.mixer.rawEnd).toBe(0);
  f.advance(5101); f.advance(5101); f.advance(5135); expect(f.frameHash()).toBe(first);
  f.advance(0); expect(f.frameHash()).not.toBe(first);
  f.advance(0); f.advance(34); expect(f.frameHash()).toBe(first); expect(f.mixer.rawEnd).toBe(0);
});
test("shader pause gaps preserve the last decoded image", async () => {
  const f = await smallFixture(); f.advance(0); f.advance(34); const first = f.frameHash();
  f.advance(1000); expect(f.frameHash()).toBe(first); f.advance(1034); expect(f.frameHash()).not.toBe(first);
});

const dataPath = process.env["Q3_DATA"];
async function retailFiles(): Promise<VirtualFileSystem> {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  return VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
}
test.skipIf(dataPath === undefined)("retail videoMap shares path handles and ignores shader clampTime", async () => {
  const vfs = await retailFiles(), overridePath = "scripts/000_video_material_test.shader";
  const script = new TextEncoder().encode("textures/proto2/mpteam1 { clampTime 0.001 { videoMap mpteam1.roq } { videoMap video/mpteam1.roq blendFunc add } }");
  let reads = 0;
  const f = await fixture({ ...withRetainedFiles<Pick<SourceFileReader, "readFileOptional">>({ readFileOptional: path => path === overridePath ? Promise.resolve(script) : Promise.resolve(undefined) }, vfs), readFileLength: path => path === overridePath ? script.byteLength : vfs.readFileLength(path),
    readFileOptional: path => path === overridePath ? Promise.resolve(script) : vfs.readFileOptional(path),
    read: path => { if (path === overridePath) return Promise.resolve(script); if (path === "video/mpteam1.roq") reads++; return vfs.read(path); },
    has: path => path === overridePath || vfs.has(path), list: prefix => prefix === "scripts/" ? [overridePath, ...vfs.list(prefix)] : vfs.list(prefix) }, 320, 240);
  const world = await f.resources.loadWorld("mpteam1"); expect(reads).toBe(1);
  f.clock.time = 100000;
  const bindings = f.worldFrame(world, 100).filter(binding => binding.kind === "shader-cinematic");
  expect(bindings).toHaveLength(2);
  const a = bindings[0], b = bindings[1]; if (a?.kind !== "shader-cinematic" || b?.kind !== "shader-cinematic") throw new Error("Missing movie passes");
  expect(a.source.image).toBe(b.source.image); expect(f.cpu.uploadCount).toBe(0);
  const reference = new RoqDecoder(await vfs.read("video/mpteam1.roq")); let firstHash = "";
  for (let frame = 1; frame <= 30; frame++) {
    f.clock.time = 100000 + frame * 1000 / 30 + 0.001; f.worldFrame(world, 100 + frame / 30 + 0.000001);
    const expected = reference.next(); if (expected.kind !== "frame") throw new Error("Expected silent retail frame");
    expect(hash(latest(f).content.copyPixels())).toBe(hash(expected.rgba));
    if (frame === 1) firstHash = hash(expected.rgba);
  }
  expect(hash(latest(f).content.copyPixels())).not.toBe(firstHash); expect(reads).toBe(1);
  expect(world.diagnostics.some(message => message.includes("unsupported stage map video"))).toBe(false);
  f.clock.time = 0; f.worldFrame(world, 0); f.clock.time = 34; f.worldFrame(world, .034);
  expect(hash(latest(f).content.copyPixels())).toBe(firstHash);
}, 20000);

test.skipIf(dataPath === undefined)("missing and invalid video headers disable the source stage prefix", async () => {
  const vfs = await retailFiles();
  for (const invalid of [false, true]) {
    const f = await fixture({ readFileLength: path => vfs.readFileLength(path), readFileOptional: path => vfs.readFileOptional(path),
      readFileRetained: path => vfs.readFileRetained(path), readFileRetainedSync: path => vfs.readFileRetainedSync(path), freeFile: buffer => { vfs.freeFile(buffer); },
      read: path => path === "video/mpteam1.roq" ? Promise.resolve(new Uint8Array(8)) : vfs.read(path),
      has: path => path === "video/mpteam1.roq" ? invalid : vfs.has(path), list: prefix => vfs.list(prefix) });
    const world = await f.resources.loadWorld("mpteam1");
    expect(world.diagnostics.some(message => message.includes("CIN_PlayCinematic failed"))).toBe(true);
    expect(f.worldFrame(world, 0).some(binding => binding.kind === "shader-cinematic")).toBe(false);
    expect(f.cpu.uploadCount).toBe(0);
  }
}, 20000);
test.skipIf(dataPath === undefined)("scene time and live engine cinematic clock advance and rewind independently", async () => {
  const vfs = await retailFiles(), f = await fixture(vfs), world = await f.resources.loadWorld("mpteam1");
  f.clock.time = 5000; expect(f.worldFrame(world, 12).some(binding => binding.kind === "shader-cinematic")).toBe(true);
  const decoder = new RoqDecoder(await vfs.read("video/mpteam1.roq"));
  for (const pair of [{ scene: 12, live: 5034 }, { scene: 0, live: 5067 }, { scene: 20, live: 5100 }]) {
    f.clock.time = pair.live; f.worldFrame(world, pair.scene);
    const expected = decoder.next(); if (expected.kind !== "frame") throw new Error("Expected silent retail frame");
    expect(hash(latest(f).content.copyPixels())).toBe(hash(expected.rgba));
  }
  const held = hash(latest(f).content.copyPixels());
  for (const time of [0, 100, 1]) { f.worldFrame(world, time); expect(hash(latest(f).content.copyPixels())).toBe(held); }
}, 20000);

function screenBatch(source: ShaderCinematicSource): DrawBatch {
  const white = { x: 1, y: 1, z: 1, w: 1 };
  return { texturing: "single", primitive: "triangles", vertices: [
    { position: { x: -1, y: -1, z: 0, w: 1 }, texCoord: { x: 0, y: 1 }, color: white },
    { position: { x: 1, y: -1, z: 0, w: 1 }, texCoord: { x: 1, y: 1 }, color: white },
    { position: { x: 1, y: 1, z: 0, w: 1 }, texCoord: { x: 1, y: 0 }, color: white },
    { position: { x: -1, y: 1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: white },
  ], indices: [0, 1, 2, 0, 2, 3], texture: { kind: "shader-cinematic", source }, state: OPAQUE_STATE };
}
test.skipIf(dataPath === undefined || process.env["QUAKE_GL_TEST"] !== "1")("retail movie CPU/GL target parity survives uploads and a complete source loop", async () => {
  const vfs = await retailFiles(), bytes = await vfs.read("video/mpteam1.roq");
  const decoder = new RoqDecoder(bytes, "mpteam1.roq", { endPolicy: "cinematic-lookahead" });
  let frameCount = 0;
  for (;;) { const event = decoder.next(); if (event.kind === "end") break; if (event.kind === "frame") frameCount++; }
  expect(frameCount).toBe(592); // Native lookahead retains frame591; the format-complete decoder has593.
  const window = SdlWindow.open({ title: "video material parity", width: 64, height: 64, backend: "gl", hidden: true });
  const f = await fixture(vfs, 64, 64, window), world = await f.resources.loadWorld("mpteam1");
  const source = await f.cinematics.shaderCinematics.playShaderCinematic("video/mpteam1.roq"); if (source === null) throw new Error("Missing retail video");
  f.worldFrame(world, 0); let firstHash = "";
  function compare(): void {
    if (f.gl === null) throw new Error("Missing GL target");
    const pixels = f.gl.readPixels(); let total = 0, above16 = 0;
    for (const [index, actual] of pixels.entries()) {
      if (index % 4 === 3) continue;
      const expected = f.cpu.pixels[index]; if (expected === undefined) throw new Error("Missing renderer pixel");
      const difference = Math.abs(actual - expected); total += difference; if (difference > 16) above16++;
    }
    expect(total / (64 * 64 * 3)).toBeLessThanOrEqual(2);
    expect(above16 / (64 * 64 * 3)).toBeLessThanOrEqual(.01);
  }
  for (let frame = 1; frame <= frameCount + 2; frame++) {
    f.clock.time = frame * 1000 / 30 + .001; f.worldFrame(world, frame / 30 + .000001);
    expect(f.cpu.pendingBindingCount).toBe(0);
    const worldHash = hash(latest(f).content.copyPixels()); if (frame === 1) firstHash = worldHash;
    if (frame === 1 || frame === 30 || frame === frameCount + 2) compare();
    f.screen(source); expect(hash(latest(f).content.copyPixels())).toBe(worldHash);
    expect(f.cpu.pendingBindingCount).toBe(0);
    if (frame === 1 || frame === 30 || frame === frameCount + 2) compare();
  }
  expect(hash(latest(f).content.copyPixels())).toBe(firstHash); expect(f.mixer.rawEnd).toBe(0);
}, 30000);
