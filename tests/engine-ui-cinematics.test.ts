import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AssetReader } from "../src/assets/reader.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { RoqDecoder } from "../src/cinematic/roq.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommonError } from "../src/core/common-error.ts";
import { HunkArena, type HunkAllocation } from "../src/core/hunk.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { EngineUiCinematics } from "../src/engine/ui-cinematics.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget, type PreparedBackendRawDraw, type RawGeometry } from "../src/render/commands.ts";
import type { CinematicUpload } from "../src/render/cinematic-command.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import type { CoordinateSpace } from "../src/render/draw2d.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { DrawBatch } from "../src/render/types.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const rect = { x: 0, y: 0, width: 640, height: 480 };
function chunk(id: number, payload: readonly number[], flags = 0): Uint8Array {
  const writer = new BinaryWriter(payload.length + 8);
  writer.u16(id); writer.u32(payload.length); writer.u16(flags); writer.bytes(Uint8Array.from(payload));
  return writer.finish();
}
function stream(chunks: readonly Uint8Array[]): Uint8Array {
  const writer = new BinaryWriter(8 + chunks.reduce((sum, value) => sum + value.length, 0));
  writer.u16(0x1084); writer.u32(0xffffffff); writer.u16(30);
  for (const value of chunks) writer.bytes(value);
  return writer.finish();
}
function movie(width = 16, height = 16): Uint8Array {
  const blocks = width * height / 64, vq: number[] = [];
  for (let index = 0; index < blocks; index += 8) {
    const count = Math.min(blocks - index, 8);
    let modes = 0; for (let n = 0; n < count; n++) modes |= 2 << (14 - n * 2);
    vq.push(modes & 255, modes >>> 8, ...new Array<number>(count).fill(0));
  }
  return stream([chunk(0x1001, [width & 255, width >>> 8, height & 255, height >>> 8, 8, 0, 4, 0]),
    chunk(0x1002, [255, 255, 255, 255, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, vq), chunk(0x1013, [])]);
}
function detailedMovie(width: number, height: number): Uint8Array {
  const actions: { readonly code: number; readonly bytes: readonly number[] }[] = [];
  for (let block = 0; block < width * height / 64; block++) {
    actions.push({ code: 3, bytes: [] });
    for (let quarter = 0; quarter < 4; quarter++) actions.push({ code: 2, bytes: [0] });
  }
  const encoded: number[] = [];
  for (let start = 0; start < actions.length; start += 8) {
    const group = actions.slice(start, start + 8); let bits = 0;
    for (const [index, action] of group.entries()) bits |= action.code << (14 - index * 2);
    encoded.push(bits & 255, bits >>> 8); for (const action of group) encoded.push(...action.bytes);
  }
  return stream([chunk(0x1001, [width & 255, width >>> 8, height & 255, height >>> 8, 8, 0, 4, 0]),
    chunk(0x1002, [0, 255, 64, 128, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, encoded), chunk(0x1013, [])]);
}

/** Records the real CPU path without replacing upload, sampling or drawing. */
class ObservedCpu extends SoftwareRenderer {
  readonly uploads: CinematicUpload[] = [];
  readonly geometry: RawGeometry[] = [];
  finishes = 0;
  override finish(): undefined { this.finishes++; return super.finish(); }
  override prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    this.geometry.push(geometry);
    const prepared = super.prepareRawGeometry(geometry);
    return { uploadCurrent: upload => { this.uploads.push(upload); return prepared.uploadCurrent(upload); }, draw: () => prepared.draw() };
  }
}
function fixture(files: AssetReader, width = 16, height = 16, space: CoordinateSpace = "pixels", maxTextureSize = 4096,
  hardware: "generic" | "ragepro" = "generic", window: SdlWindow | null = null) {
  const images = new RendererImageCatalog(), gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new ObservedCpu(width, height, images, gl === null ? 8 : gl.subpixelBits);
  const target = gl === null ? new RenderTarget(images, [cpu]) : new RenderTarget(images, [cpu, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0);
  const temporaryMemory = new HunkArena(1024 * 1024, () => undefined);
  const clock = { time: 0, sample(): number { return this.time; } }, rendererClock = { reads: 0, milliseconds(): number { this.reads++; return 1234; } };
  const owner = new EngineCinematics({ developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock, scratchImages: builtins, console: { kind: "absent" },
    temporaryMemory,
    settings: { hardware, maxTextureSize, inGameVideo: () => 1 } });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: rendererClock, identityLight: 1, tess: new SourceTessState(), runtime: settings.runtime });
  const draw = commands.draw2D(space), runtime = new EngineUiCinematics(owner, "cgame");
  const close = (): void => { owner.dispose(); commands.close("require-empty"); target.close(); };
  return { owner, runtime, clock, rendererClock, cpu, gl, builtins, commands, draw, temporaryMemory, close };
}
function files(data = movie()): AssetReader { return { has: () => true, list: () => [], read: async () => data }; }
async function start(f: ReturnType<typeof fixture>, name = "test") {
  const instance = f.runtime.play(await f.owner.prepare(name), rect);
  if (instance === undefined) throw new Error("Missing movie");
  f.runtime.run(instance.handle.index, 0); f.clock.time += 34; f.runtime.run(instance.handle.index, 0);
  return instance;
}
function latest(f: ReturnType<typeof fixture>): CinematicUpload {
  const upload = f.cpu.uploads.at(-1); if (upload === undefined) throw new Error("Missing actual raw upload"); return upload;
}

describe("UI cinematic adapter over the consuming renderer", () => {
  test("absent frame does not drain; a real raw call consumes earlier work and does not replay", async () => {
    const f = fixture(files()); let issued = 0;
    const instance = f.runtime.play(await f.owner.prepare("test"), rect); if (instance === undefined) throw new Error("No movie");
    f.commands.addPreparedViews(() => { issued++; return []; });
    f.runtime.draw(instance.handle.index, rect, f.draw);
    expect(issued).toBe(0); expect(f.cpu.finishes).toBe(0); expect(f.rendererClock.reads).toBe(0);
    f.runtime.run(instance.handle.index, 900000); f.clock.time = 34; f.runtime.run(instance.handle.index, 900000);
    f.runtime.draw(instance.handle.index, rect, f.draw);
    expect(issued).toBe(1); expect(f.cpu.finishes).toBe(1); expect(f.rendererClock.reads).toBe(3);
    expect(f.owner.prepareUiRaw(instance.handle)?.dirty).toBe(false);
    expect(f.cpu.pixels.every(value => value === 255)).toBe(true);
    expect(f.commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
    expect(f.cpu.uploads).toHaveLength(1);
    f.close();
  });

  test("raw extents are integer source stretching, independent of widescreen UI bias", async () => {
    const f = fixture(files(), 1280, 720, "base-ui-640"), instance = await start(f);
    f.runtime.draw(instance.handle.index, { x: 10.9, y: 20.9, width: 100.9, height: 80.9 }, f.draw);
    expect(f.cpu.geometry[0]).toEqual({ rect: { x: 20, y: 30, width: 200, height: 120 }, uploadWidth: 16, uploadHeight: 16, identityLight: 1 });
    const pixel = (x: number, y: number) => f.cpu.pixels[(y * 1280 + x) * 4];
    expect(pixel(19, 30)).toBe(0); expect(pixel(20, 30)).toBe(255); expect(pixel(219, 149)).toBe(255); expect(pixel(220, 149)).toBe(0);
    expect(latest(f).image).toBe(f.builtins.scratchImage(instance.handle.index));
    f.close();
  });

  test("older real shader work mutates a selected direct pointer, not a private resample, then UI clears new dirty", async () => {
    for (const size of [16, 512]) {
      const codes: number[] = [], blocks = size * size / 64;
      for (let index = 0; index < blocks; index += 8) {
        const count = Math.min(8, blocks - index); let bits = 0;
        for (let n = 0; n < count; n++) bits |= 2 << (14 - n * 2);
        codes.push(bits & 255, bits >>> 8, ...new Array<number>(count).fill(0));
      }
      const data = stream([chunk(0x1001, [size & 255, size >>> 8, size & 255, size >>> 8, 8, 0, 4, 0]),
        chunk(0x1002, [255, 255, 255, 255, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, codes),
        chunk(0x1002, [80, 80, 80, 80, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, codes), chunk(0x1011, codes), chunk(0x1013, [])]);
      const f = fixture(files(data), 16, 16, "pixels", size === 512 ? 256 : 4096), instance = await start(f);
      const source = await f.owner.shaderCinematics.playShaderCinematic("test"); if (source === null) throw new Error("No shared shader handle");
      const vertex = (x: number, y: number) => ({ position: { x, y, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 1, z: 1, w: 1 } });
      const batch: DrawBatch = { primitive: "triangles", texturing: "single", vertices: [vertex(-1, -1), vertex(3, -1), vertex(-1, 3)],
        indices: [0, 1, 2], texture: { kind: "shader-cinematic", source },
        state: { blend: { source: "one", destination: "zero" }, depthTest: "always", depthWrite: false, alphaTest: "none", cull: "none" } };
      f.commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, depth: 1, color: null }, operations: [{ kind: "draw", batches: [batch] }] });
      f.clock.time = 100;
      f.runtime.draw(instance.handle.index, rect, f.draw);
      // Frame 2 reused physical buffer 0 during the older shader draw.
      expect(latest(f).content.copyPixels()[0]).toBe(size === 16 ? 81 : 255);
      expect(f.cpu.pixels[0]).toBe(size === 16 ? 81 : 255);
      expect(f.owner.prepareUiRaw(instance.handle)?.dirty).toBe(false);
      expect(f.commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
      f.close();
    }
  });

  test("cross-film skips preserve native physical offsets and old-handle aliasing", async () => {
    // Unchanged cl_cin.c oracle /tmp/q3-ui-model-oracle-569un1/cinematic-shared.c.
    const aData = stream([chunk(0x1001, [16, 0, 16, 0, 8, 0, 4, 0]),
      chunk(0x1002, [255, 255, 255, 255, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, [0, 0]), chunk(0x1011, [0, 170, 0, 0, 0, 0]), chunk(0x1013, [])]);
    const bData = stream([chunk(0x1001, [8, 0, 8, 0, 8, 0, 4, 0]),
      chunk(0x1002, [80, 80, 80, 80, 128, 128, 0, 0, 0, 0], 0x0101), chunk(0x1011, [0, 128, 0]), chunk(0x1013, [])]);
    const f = fixture({ has: () => true, list: () => [], read: async path => path === "video/a" ? aData : bData });
    const a = await start(f, "a"), b = f.runtime.play(await f.owner.prepare("b"), rect); if (b === undefined) throw new Error("No b");
    f.clock.time = 100; f.runtime.run(b.handle.index, 0); f.clock.time = 134; f.runtime.run(b.handle.index, 0);
    f.runtime.draw(a.handle.index, rect, f.draw); let bytes = latest(f).content.copyPixels();
    expect([bytes[0], bytes[256], bytes[512]]).toEqual([81, 81, 0]);
    for (const time of [200, 234, 268]) { f.clock.time = time; f.runtime.run(a.handle.index, 0); }
    f.runtime.draw(a.handle.index, rect, f.draw); bytes = latest(f).content.copyPixels();
    expect([bytes[0], bytes[512]]).toEqual([81, 0]);
    f.clock.time = 301; f.runtime.run(a.handle.index, 0); f.runtime.draw(a.handle.index, rect, f.draw);
    expect(latest(f).content.copyPixels()[0]).toBe(255);
    f.close();
  });

  test("new play clears frames but retains codebooks; stopped numeric slot retains the real scratch image", async () => {
    const reuse = stream([chunk(0x1001, [8, 0, 8, 0, 8, 0, 4, 0]), chunk(0x1011, [0, 128, 0]), chunk(0x1013, [])]);
    const f = fixture({ has: () => true, list: () => [], read: async path => path === "video/new" ? reuse : movie() });
    const a = await start(f, "a"), oldIndex = a.handle.index;
    f.runtime.draw(oldIndex, rect, f.draw); const image = latest(f).image;
    const b = f.runtime.play(await f.owner.prepare("new"), rect); if (b === undefined) throw new Error("No b");
    f.runtime.draw(oldIndex, rect, f.draw); expect(latest(f).content.copyPixels()[0]).toBe(0);
    f.clock.time = 100; f.runtime.run(b.handle.index, 0); f.clock.time = 134; f.runtime.run(b.handle.index, 0); f.runtime.draw(b.handle.index, rect, f.draw);
    expect(latest(f).content.copyPixels()[0]).toBe(255);
    f.runtime.stop(oldIndex); const replacement = f.runtime.play(await f.owner.prepare("replacement"), rect);
    expect(replacement?.handle).toBe(a.handle);
    if (replacement === undefined) throw new Error("No replacement");
    expect(replacement.handle.index).toBe(oldIndex);
    f.runtime.run(oldIndex, 0); f.clock.time = 168; f.runtime.run(oldIndex, 0); f.runtime.draw(oldIndex, rect, f.draw);
    expect(latest(f).image).toBe(image);
    f.close();
  });

  test("source 2x1/2x2 averaging and 1x2 row selection reach actual raw uploads", async () => {
    for (const dimensions of [{ width: 512, height: 256, first: 128, second: 97 },
      { width: 512, height: 512, first: 112, second: 112 }, { width: 256, height: 512, first: 1, second: 1 }]) {
      const f = fixture(files(detailedMovie(dimensions.width, dimensions.height)), 16, 16, "pixels", 4096, "ragepro"), instance = await start(f);
      f.runtime.draw(instance.handle.index, rect, f.draw);
      const upload = latest(f), bytes = upload.content.copyPixels();
      expect([upload.uploadWidth, upload.uploadHeight]).toEqual([256, 256]);
      expect(bytes[0]).toBe(dimensions.first); expect(bytes[256 * 4]).toBe(dimensions.second);
      expect(f.cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
      f.close();
    }
  });

  test("downsample uses real hunk capacity before the barrier and frees after draw and dirty clear", async () => {
    for (const hardware of ["generic", "ragepro"] satisfies ("generic" | "ragepro")[]) {
      const f = fixture(files(movie(512, 512)), 16, 16, "pixels", hardware === "generic" ? 256 : 4096, hardware);
      const instance = await start(f), memory = f.temporaryMemory;
      const payload = 256 * 256 * 4, charged = payload + 8;
      memory.allocate(memory.byteLength - payload, "low");
      const before = memory.snapshot();
      let olderDraws = 0;
      f.commands.addPreparedViews(() => { olderDraws++; return []; });
      let failure: unknown;
      try { f.owner.draw(instance.handle, f.draw); } catch (error: unknown) { failure = error; }
      if (!(failure instanceof CommonError)) throw new Error("Expected real cinematic hunk exhaustion");
      expect([failure.code, failure.message]).toEqual(["drop", `Hunk_AllocateTempMemory: failed on ${charged}`]);
      expect(memory.snapshot()).toEqual({ ...before, permanentBank: "high", temporaryBank: "low" });
      expect([olderDraws, f.cpu.finishes, f.cpu.uploads.length, f.cpu.geometry.length]).toEqual([0, 0, 0, 0]);

      memory.clearToMark();
      const allocations: HunkAllocation[] = [], events: string[] = [];
      const allocate = memory.allocateTemp.bind(memory), free = memory.freeTemp.bind(memory);
      memory.allocateTemp = size => {
        events.push("allocate");
        const allocation = allocate(size); allocations.push(allocation); return allocation;
      };
      const prepare = f.cpu.prepareRawGeometry.bind(f.cpu);
      f.cpu.prepareRawGeometry = geometry => {
        const prepared = prepare(geometry);
        return { uploadCurrent: upload => prepared.uploadCurrent(upload), draw: () => {
          events.push("draw");
          expect(memory.memoryRemaining()).toBe(memory.byteLength - charged);
          prepared.draw();
        } };
      };
      memory.freeTemp = allocation => {
        events.push("free");
        expect(allocation.byteLength).toBe(payload);
        expect(allocation.bytes.every(value => value === 255)).toBe(true);
        expect(f.owner.prepareUiRaw(instance.handle)?.dirty).toBe(false);
        expect(f.cpu.pixels.every(value => value === 255)).toBe(true);
        free(allocation);
      };
      f.owner.draw(instance.handle, f.draw);
      expect(events).toEqual(["allocate", "draw", "free"]);
      expect(olderDraws).toBe(1);
      expect(latest(f).dirty).toBe(true);
      expect(memory.memoryRemaining()).toBe(memory.byteLength);
      expect(memory.snapshot().low.tempHighwater).toBe(charged);
      const allocation = allocations[0];
      if (allocation === undefined) throw new Error("Missing cinematic temporary allocation");
      expect(memory.ownsLiveAllocation(allocation)).toBe(false);
      expect(() => allocation.bytes).toThrow("no longer valid");
      expect(f.owner.prepareUiRaw(instance.handle)?.dirty).toBe(false);
      expect(allocations).toHaveLength(1);
      f.close();
    }
  });

  test("downsample draw failure retains the real temporary block and dirty frame", async () => {
    const f = fixture(files(movie(512, 512)), 16, 16, "pixels", 256), instance = await start(f);
    const memory = f.temporaryMemory, allocations: HunkAllocation[] = [];
    const allocate = memory.allocateTemp.bind(memory), free = memory.freeTemp.bind(memory);
    let frees = 0;
    memory.allocateTemp = size => { const allocation = allocate(size); allocations.push(allocation); return allocation; };
    memory.freeTemp = allocation => { frees++; free(allocation); };
    const prepare = f.cpu.prepareRawGeometry.bind(f.cpu), failure = new Error("cinematic draw failure");
    f.cpu.prepareRawGeometry = geometry => {
      const prepared = prepare(geometry);
      return { uploadCurrent: upload => prepared.uploadCurrent(upload), draw: () => { throw failure; } };
    };
    expect(() => f.owner.draw(instance.handle, f.draw)).toThrow(failure);
    expect(frees).toBe(0);
    const allocation = allocations[0];
    if (allocation === undefined) throw new Error("Missing failed draw allocation");
    expect(memory.ownsLiveAllocation(allocation)).toBe(true);
    expect(memory.memoryRemaining()).toBe(memory.byteLength - 262152);
    expect(allocation.bytes.every(value => value === 255)).toBe(true);
    const next = f.owner.prepareUiRaw(instance.handle);
    if (next === null) throw new Error("Failed draw lost the cinematic frame");
    expect(next.dirty).toBe(true);
    expect(allocations).toHaveLength(2);
    next.captureAfterBarrier().afterUiDraw();
    expect(memory.ownsLiveAllocation(allocation)).toBe(true);
    expect(memory.memoryRemaining()).toBe(memory.byteLength - 262152);
    memory.clearTemp();
    expect(memory.ownsLiveAllocation(allocation)).toBe(false);
    f.close();
  });
});

const retail = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(retail, "baseq3/pak0.pk3")))("retail UI frame is captured once and consumed by actual CPU and optional GL", async () => {
  const assets = await VirtualFileSystem.openInspection({ dataPath: retail, homePath: retail, cdPath: null, product: "missionpack" });
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Shared cinematic", width: 128, height: 128, backend: "gl", hidden: true }) : null;
  const f = fixture(assets, 128, 128, "pixels", 4096, "generic", window);
  try {
    const instance = await start(f, "video/mpteam1.roq"); f.runtime.draw(instance.handle.index, rect, f.draw);
    const decoded = new RoqDecoder(await assets.read("video/mpteam1.roq")).next();
    if (decoded.kind !== "frame") throw new Error("Missing retail frame");
    expect(latest(f).content.copyPixels()).toEqual(decoded.rgba);
    expect(f.cpu.pixels.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true);
    expect(f.commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
    if (f.gl !== null) {
      const pixels = f.gl.readPixels(); let difference = 0;
      for (const [index, pixel] of pixels.entries()) { const expected = f.cpu.pixels[index]; if (expected === undefined) throw new Error("Missing CPU pixel"); difference += Math.abs(pixel - expected); }
      expect(difference / pixels.length).toBeLessThan(1);
    }
  } finally { f.close(); window?.close(); }
});
