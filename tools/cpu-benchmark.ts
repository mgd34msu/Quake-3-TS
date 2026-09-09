import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { anglesToAxis } from "../src/core/math.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { findDataPath } from "../src/engine/data-path.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { createImageColorMappings, prepareImageUpload } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, RenderState, TextureSampling } from "../src/render/types.ts";
import { RendererResources } from "../src/render/world.ts";
import type { WorldFrame, WorldScene } from "../src/render/world.ts";
import { BACKEND_REQUEST_CHECKSUM_SCOPE, MeasuredRendererBackend } from "./render-measurement.ts";

interface BenchmarkMetadata { readonly name: string; readonly diagnostics: readonly string[] }
type BenchmarkCase = BenchmarkMetadata & ({ readonly kind: "batches"; readonly batches: readonly DrawBatch[] }
  | { readonly kind: "world"; readonly frame: WorldFrame; readonly world: Pick<WorldScene, "prepareFrame"> });

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return result;
}

function summary(samples: readonly number[]): { readonly minimum: number; readonly median: number; readonly p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const minimum = sorted[0], median = sorted[Math.floor(sorted.length / 2)], p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (minimum === undefined || median === undefined || p95 === undefined) throw new Error("Missing benchmark samples");
  return { minimum, median, p95 };
}

function checker(): Uint8Array {
  const pixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    pixels[offset] = (x ^ y) & 8 ? 224 : 32;
    pixels[offset + 1] = x * 4; pixels[offset + 2] = y * 4; pixels[offset + 3] = 192;
  }
  return pixels;
}

function publish(images: RendererImageCatalog, profile: ImageUploadProfile, name: string, pixels: Uint8Array, sampling: TextureSampling): RendererImage {
  const upload = prepareImageUpload({ width: 64, height: 64, pixels }, { name, mipmap: false, allowPicmip: false }, profile);
  return images.create({ ...upload, name, sourceWidth: 64, sourceHeight: 64, mipmap: false, sampling, registrationUnit: 1 });
}

function quad(name: string, state: RenderState, texture: RendererImage): BenchmarkCase {
  const color = { x: 1, y: 1, z: 1, w: 1 };
  return { kind: "batches", name, diagnostics: [], batches: [{ texturing: "single", primitive: "triangles",
    vertices: [
      { position: { x: -1, y: 1, z: 0, w: 1 }, color, texCoord: { x: -0.25, y: 0 } },
      { position: { x: 2, y: 2, z: 0, w: 2 }, color, texCoord: { x: 1.25, y: 0 } },
      { position: { x: 2, y: -2, z: 0, w: 2 }, color, texCoord: { x: 1.25, y: 1 } },
      { position: { x: -1, y: -1, z: 0, w: 1 }, color, texCoord: { x: -0.25, y: 1 } },
    ], indices: [0, 2, 1, 0, 3, 2], texture: { kind: "bind-image", image: texture }, state,
  }] };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    case: { type: "string", default: "all" }, data: { type: "string" }, map: { type: "string", default: "q3dm1" },
    width: { type: "string", default: "640" }, height: { type: "string", default: "480" },
    warmup: { type: "string", default: "10" }, frames: { type: "string", default: "20" },
    capture: { type: "string" }, reference: { type: "string" },
  } });
  const width = integer(values.width, "width", 1, 4096), height = integer(values.height, "height", 1, 4096);
  const warmup = integer(values.warmup, "warmup", 10, 10000), frames = integer(values.frames, "frames", 20, 10000);
  const allowed = ["all", "opaque", "nearest", "linear", "clamp", "alpha", "lightmap", "world"];
  if (!allowed.includes(values.case)) throw new Error("case must be all, opaque, nearest, linear, clamp, alpha, lightmap, or world");
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images, 8, 0, 0);
  const measured = new MeasuredRendererBackend(cpu), target = new RenderTarget(images, [measured]);
  let commands: RenderCommandBuffer | null = null;
  let cinematics: EngineCinematics | null = null;
  let vfs: VirtualFileSystem | null = null;
  let failure: { readonly cause: unknown } | null = null;
  try {
    const platform = process.platform === "linux" ? "linux" : "other";
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(new CvarRegistry(), platform), cpu.capabilities);
    const uploadProfile: ImageUploadProfile = { ...settings.imageUploadSettings(), textureCompression: "none", maxTextureSize: null,
      colorMappings: createImageColorMappings(settings.colorMappingInputs({ deviceSupportsGamma: false,
        isFullscreen: false, colorBits: cpu.configuration.colorBits })) };
    const imageProfile = () => uploadProfile;
    const clock = { milliseconds: () => 0 };
    const needsRetail = values.case === "world" || values.case === "all";
    let resources: RendererResources | null = null;
    let whiteImage: RendererImage;
    if (needsRetail) {
      const dataPath = await findDataPath(values.data);
      const openedFiles = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
      vfs = openedFiles;
      const builtins = new BuiltinImages(images, imageProfile), mixer = new AudioMixer(44100, clock.milliseconds);
      cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), files: { kind: "retained", current: () => openedFiles }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
        print: text => { process.stderr.write(text); },
        developerPrint: text => { process.stderr.write(text); },
        console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
      resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings,
        { patchMemory: { kind: "diagnostic" }, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics, imageProfile,
          print: text => { process.stderr.write(text); } });
      const white = builtins.find("*white");
      if (white === undefined) throw new Error("Builtin white image was not published");
      whiteImage = white.image;
    } else {
      const upload = prepareImageUpload({ width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]) },
        { name: "*benchmark-white", mipmap: false, allowPicmip: false }, uploadProfile);
      whiteImage = images.create({ ...upload, name: "*benchmark-white", sourceWidth: 1, sourceHeight: 1, mipmap: false,
        sampling: { wrap: "repeat", filter: "linear" }, registrationUnit: 1 });
    }
    const tess = resources === null ? new SourceTessState() : resources.tess;
    commands = new RenderCommandBuffer(target, { print: (text: string) => { process.stderr.write(text); }, clock, identityLight: uploadProfile.colorMappings.identityLight, tess, runtime: settings.runtime });
    const pixels = checker();
    const nearest = publish(images, uploadProfile, "*benchmark-nearest", pixels, { wrap: "repeat", filter: "nearest" });
    const linear = publish(images, uploadProfile, "*benchmark-linear", pixels, { wrap: "repeat", filter: "linear" });
    const clamp = publish(images, uploadProfile, "*benchmark-clamp", pixels, { wrap: "clamp", filter: "linear" });
    const cases: BenchmarkCase[] = [
      quad("opaque", OPAQUE_STATE, whiteImage), quad("nearest", OPAQUE_STATE, nearest),
      quad("linear", OPAQUE_STATE, linear), quad("clamp", OPAQUE_STATE, clamp),
      quad("alpha", { ...OPAQUE_STATE, blend: { source: "src-alpha", destination: "one-minus-src-alpha" } }, linear),
      quad("lightmap", { ...OPAQUE_STATE, blend: { source: "dst-color", destination: "zero" } }, linear),
    ];
    publish(images, uploadProfile, "*benchmark-bind-sentinel", pixels, { wrap: "repeat", filter: "nearest" });
    if (values.case === "world" || values.case === "all") {
      if (resources === null) throw new Error("World benchmark requires renderer resources");
      const world = await resources.loadWorld(values.map), camera = world.initialCamera(), refdef = createRefdef();
      refdef.width = width; refdef.height = height; refdef.fovX = 90; refdef.fovY = Math.atan(height / width) * 360 / Math.PI;
      refdef.viewOrigin = camera.origin; refdef.viewAxis = anglesToAxis(camera.angles);
      cases.push({ kind: "world", name: "world", frame: { refdef }, world, diagnostics: world.diagnostics });
    }
    const selected = values.case === "all" ? cases : cases.filter(item => item.name === values.case);
    if (values.capture !== undefined) await mkdir(values.capture, { recursive: true });
    const clear = { x: 0.05, y: 0.05, z: 0.08, w: 1 };
    for (const fixture of selected) {
      const user: number[] = [], system: number[] = [], wall: number[] = [], renderer: number[] = [];
      let checksum: string | null = null, inputChecksum: string | null = null;
      let successfulBatches: readonly { readonly indexCount: number }[] = [];
      for (let frame = 0; frame < warmup + frames; frame++) {
        const started = performance.now(), usage = process.cpuUsage();
        measured.beginMeasurement();
        commands.beginFrame();
        commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: clear, depth: 1 },
          operations: [{ kind: "draw", batches: fixture.kind === "batches" ? fixture.batches : [] }] });
        if (fixture.kind === "world") commands.addPreparedViews(fixture.world.prepareFrame(fixture.frame));
        commands.submitFrame();
        const measurement = measured.endMeasurement();
        commands.tess.endFrame();
        resources?.rolloverFrame();
        const elapsedCpu = process.cpuUsage(usage), elapsed = performance.now() - started;
        successfulBatches = measurement.successfulBatches;
        const currentInput = measurement.inputChecksum;
        if (frame >= warmup) {
          if (inputChecksum !== null && inputChecksum !== currentInput) throw new Error(`${fixture.name}: render inputs changed between identical frames`);
          inputChecksum = currentInput;
        }
        const hash = createHash("sha256").update(cpu.pixels).digest("hex");
        if (checksum !== null && checksum !== hash) throw new Error(`${fixture.name}: framebuffer changed between identical frames`);
        checksum = hash;
        if (frame >= warmup) {
          user.push(elapsedCpu.user / 1000); system.push(elapsedCpu.system / 1000); wall.push(elapsed);
          renderer.push(measurement.milliseconds);
        }
      }
      const filename = `${fixture.name}-${width}x${height}.rgba`;
      if (values.reference !== undefined) {
        const expected = await Bun.file(join(values.reference, filename)).bytes();
        if (expected.length !== cpu.pixels.length || !expected.every((value, index) => value === cpu.pixels[index])) {
          throw new Error(`${fixture.name}: framebuffer differs from ${join(values.reference, filename)}`);
        }
      }
      if (values.capture !== undefined) await Bun.write(join(values.capture, filename), cpu.pixels);
      if (inputChecksum === null) throw new Error("Missing benchmark input checksum");
      process.stdout.write(JSON.stringify({ name: fixture.name, width, height, warmupFrames: warmup, measuredFrames: frames,
        batches: successfulBatches.length, triangles: successfulBatches.reduce((sum, batch) => sum + batch.indexCount / 3, 0),
        userMilliseconds: summary(user), systemMilliseconds: summary(system), wallMilliseconds: summary(wall),
        rendererMilliseconds: summary(renderer),
        timingScope: "user/system/wall cover the instrumented full pass; renderer covers successful backend calls and excludes observer snapshots, hashing, and frontend work",
        inputChecksum, inputChecksumScope: BACKEND_REQUEST_CHECKSUM_SCOPE, checksum, diagnostics: fixture.diagnostics }) + "\n");
    }
  } catch (cause: unknown) {
    failure = { cause };
    try { target.fail(cause); } catch { /* The original failure remains authoritative. */ }
  } finally {
    const cleanup = (operation: () => unknown): void => {
      try { operation(); } catch (cause: unknown) { if (failure === null) failure = { cause }; }
    };
    cleanup(() => commands?.close(failure === null ? "require-empty" : "discard"));
    cleanup(() => target.close());
    cleanup(() => cinematics?.dispose());
    cleanup(() => vfs?.close());
  }
  if (failure !== null) throw failure.cause;
}

if (import.meta.main) await main();
