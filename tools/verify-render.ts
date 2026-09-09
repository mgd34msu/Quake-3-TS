import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { decodeTga } from "../src/assets/tga.ts";
import { findDataPath } from "../src/engine/data-path.ts";
import { encodePng } from "../src/core/png.ts";
import { anglesToAxis, vec3 } from "../src/core/math.ts";
import { createRefdef } from "../src/render/refdef.ts";
import type { Axis, Vec3 } from "../src/core/math.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererResources } from "../src/render/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { createImageColorMappings } from "../src/render/image-upload.ts";
import type { ImageUploadProfile } from "../src/render/image-upload.ts";
import { loadModelFixture } from "./model-fixture.ts";
import { parseRenderClockTrace } from "./render-clock.ts";
import { MeasuredRendererBackend } from "./render-measurement.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string" }, map: { type: "string", default: "q3dm1" },
    product: { type: "string", default: "baseq3" }, output: { type: "string", default: ".artifacts/render" },
    frames: { type: "string" },
    models: { type: "boolean", default: false },
    width: { type: "string", default: "320" }, height: { type: "string", default: "240" },
    origin: { type: "string" }, angles: { type: "string" }, time: { type: "string" },
    "view-axis": { type: "string" }, "fov-x": { type: "string" }, "fov-y": { type: "string" },
    reference: { type: "string" },
    "shader-remaps": { type: "string" },
    "cinematic-time": { type: "string" }, "clock-trace": { type: "string" },
  },
});
if (values.product !== "baseq3" && values.product !== "missionpack") throw new Error("Invalid product");
interface ShaderRemap { readonly original: string; readonly replacement: string; readonly timeOffset: string }
function parseShaderRemaps(text: string): readonly ShaderRemap[] {
  const records: unknown = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error("shader-remaps must contain an array");
  return records.map((record: unknown): ShaderRemap => {
    if (typeof record !== "object" || record === null || !("original" in record) || !("replacement" in record)
      || !("timeOffset" in record) || typeof record.original !== "string" || typeof record.replacement !== "string"
      || typeof record.timeOffset !== "string") throw new Error("Each shader remap requires original, replacement and timeOffset strings");
    for (const name of [record.original, record.replacement]) {
      if (name.length === 0 || name.length >= 64 || /[^\x20-\x7e]/.test(name)) throw new Error("Shader remap names require 1..63 printable ASCII characters");
    }
    if (record.timeOffset.trim() === "" || !Number.isFinite(Math.fround(Number(record.timeOffset)))) {
      throw new Error("Shader remap timeOffset must be a finite float32 numeric string");
    }
    return { original: record.original, replacement: record.replacement, timeOffset: record.timeOffset };
  });
}
const remapPath = values["shader-remaps"];
const remapText = remapPath === undefined ? null : await Bun.file(remapPath).text();
const shaderRemaps = remapText === null ? [] : parseShaderRemaps(remapText);
const requestedFrames = Number(values.frames ?? "1");
if (!Number.isSafeInteger(requestedFrames) || requestedFrames < 1 || requestedFrames > 100_000) throw new RangeError("frames must be an integer in 1..100000");
const width = Number(values.width), height = Number(values.height), requestedTime = Number(values.time ?? "0");
const requestedCinematicTime = Number(values["cinematic-time"] ?? "0");
if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 4096)) throw new RangeError("dimensions must be integers in 1..4096");
if (!Number.isFinite(requestedTime) || requestedTime < 0 || requestedTime + (requestedFrames - 1) / 60 > 0x7fffffff / 1000) throw new RangeError("time must fit the nonnegative game clock");
if (!Number.isFinite(requestedCinematicTime) || requestedCinematicTime < 0 || requestedCinematicTime + (requestedFrames - 1) * 1000 / 60 > 0x7fffffff) throw new RangeError("cinematic-time must fit the nonnegative client clock in milliseconds");
const tracePath = values["clock-trace"];
if (tracePath !== undefined && (values.frames !== undefined || values.time !== undefined || values["cinematic-time"] !== undefined)) {
  throw new Error("clock-trace supplies all clocks; do not combine it with frames, time or cinematic-time");
}
const traceText = tracePath === undefined ? null : await Bun.file(tracePath).text();
const clocks = traceText === null ? Array.from({ length: requestedFrames }, (_, frame) => ({
  time: requestedTime + frame / 60, cinematicTime: requestedCinematicTime + frame * 1000 / 60,
})) : parseRenderClockTrace(traceText);
const firstClock = clocks[0], lastClock = clocks.at(-1);
if (firstClock === undefined || lastClock === undefined) throw new Error("No render clock samples");
const frames = clocks.length, startTime = firstClock.time, cinematicStartTime = firstClock.cinematicTime;
function vector(text: string): Vec3 {
  const values = text.trim().split(/\s+/).map(Number);
  const x = values[0], y = values[1], z = values[2];
  if (values.length !== 3 || x === undefined || y === undefined || z === undefined || !values.every(value => Number.isFinite(Math.fround(value)))) {
    throw new Error("origin/angles require three finite float32 components");
  }
  return vec3(x, y, z);
}
function viewAxis(text: string): Axis {
  const components = text.trim().split(/\s+/);
  if (components.length !== 9) throw new Error("view-axis requires nine finite float32 components in forward, left, up order");
  return [vector(components.slice(0, 3).join(" ")), vector(components.slice(3, 6).join(" ")), vector(components.slice(6, 9).join(" "))];
}
function fieldOfView(text: string | undefined, fallback: number): number {
  const value = text === undefined ? fallback : Math.fround(Number(text));
  if (!Number.isFinite(value) || value <= 0 || value >= 180) throw new RangeError("Field of view must be between 0 and 180 degrees");
  return value;
}
const requestedAxis = values["view-axis"] === undefined ? null : viewAxis(values["view-axis"]);
const fovX = fieldOfView(values["fov-x"], 90);
const fovY = fieldOfView(values["fov-y"], Math.atan(height / width * Math.tan(fovX * Math.PI / 360)) * 360 / Math.PI);
const dataPath = await findDataPath(values.data);
const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: values.product });
let window: SdlWindow | null = null;
let gl: GlRenderer | null = null;
let cpu: SoftwareRenderer | null = null;
let target: RenderTarget | null = null;
let commands: RenderCommandBuffer | null = null;
let cinematics: EngineCinematics | null = null;
let failure: { readonly cause: unknown } | null = null;
try {
const platform = process.platform === "linux" ? "linux" : "other";
const registered = new RegisteredRendererCvars(new CvarRegistry(), platform);
window = SdlWindow.open({ title: "Quake III render parity", width, height, backend: "gl", hidden: true });
const images = new RendererImageCatalog();
gl = new GlRenderer(window, images);
const alphaBits = gl.alphaBits;
if (alphaBits !== 0 && alphaBits !== 8) throw new RangeError(`CPU/GL comparison requires 0 or 8 framebuffer alpha bits; OpenGL reports ${alphaBits}`);
cpu = new SoftwareRenderer(width, height, images, gl.subpixelBits, 0, alphaBits);
const timedCpu = new MeasuredRendererBackend(cpu), timedGl = new MeasuredRendererBackend(gl);
target = new RenderTarget(images, [timedCpu, timedGl]);
const settings = new SourceRendererSettings(registered, gl.capabilities);
gl.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
  if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
});
const uploadProfile: ImageUploadProfile = { ...settings.imageUploadSettings(), textureCompression: "none", maxTextureSize: gl.maxTextureSize,
  colorMappings: createImageColorMappings(settings.colorMappingInputs({ deviceSupportsGamma: false,
    isFullscreen: false, colorBits: gl.colorBits })) };
const imageProfile = () => uploadProfile;
const builtins = new BuiltinImages(images, imageProfile);
let diagnosticMilliseconds = Math.trunc(firstClock.cinematicTime);
const pictureClock = { milliseconds: () => diagnosticMilliseconds };
const mixer = new AudioMixer(44100, pictureClock.milliseconds);
cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), files: { kind: "retained", current: () => vfs }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: pictureClock.milliseconds }, scratchImages: builtins,
  print: text => { process.stderr.write(text); },
  developerPrint: text => { process.stderr.write(text); },
  console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl.maxTextureSize } });
const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings,
  { patchMemory: { kind: "diagnostic" }, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics, imageProfile,
    print: text => { process.stderr.write(text); } });
commands = new RenderCommandBuffer(target, { print: (text: string) => { process.stderr.write(text); }, clock: pictureClock, identityLight: uploadProfile.colorMappings.identityLight,
  tess: resources.tess, runtime: settings.runtime });
const scene = await resources.loadWorld(values.map);
for (const remap of shaderRemaps) await resources.remapShader(remap.original, remap.replacement, remap.timeOffset);
const initialCamera = scene.initialCamera();
const camera = { origin: values.origin === undefined ? initialCamera.origin : vector(values.origin),
  angles: values.angles === undefined ? initialCamera.angles : vector(values.angles) };
const modelFixture = values.models ? await loadModelFixture(scene, vfs, camera, values.product) : null;
let entities = modelFixture?.(startTime) ?? [];
const refdef = createRefdef();
refdef.width = width; refdef.height = height;
refdef.fovX = fovX; refdef.fovY = fovY;
refdef.viewOrigin = camera.origin; refdef.viewAxis = requestedAxis ?? anglesToAxis(camera.angles);
let finalFrameMeasured = false;
const clear = { x: 0.05, y: 0.05, z: 0.08, w: 1 };
for (const [index, clock] of clocks.entries()) {
  entities = modelFixture?.(clock.time) ?? [];
  refdef.time = Math.trunc(clock.time * 1000);
  diagnosticMilliseconds = Math.trunc(clock.cinematicTime);
  commands.beginFrame();
  commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: clear, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
  commands.addPreparedViews(scene.prepareFrame({ refdef, entities }));
  const finalFrame = index === clocks.length - 1;
  if (finalFrame) { timedCpu.beginMeasurement(); timedGl.beginMeasurement(); finalFrameMeasured = true; }
  commands.submitFrame();
  resources.tess.endFrame();
}
if (!finalFrameMeasured) throw new Error("Final render frame was not measured");
const readbackStarted = performance.now();
  const pixels = gl.readPixels();
const readbackMilliseconds = performance.now() - readbackStarted;
const cpuMeasurement = timedCpu.endMeasurement(), glMeasurement = timedGl.endMeasurement();
const cpuMilliseconds = cpuMeasurement.milliseconds;
// Interleaved mirrored execution plus synchronized GL readback; this is not an isolated GPU timer.
const glMilliseconds = glMeasurement.milliseconds + readbackMilliseconds;
const batches = cpuMeasurement.successfulBatches;
  const cpuData = new DataView(cpu.pixels.buffer, cpu.pixels.byteOffset, cpu.pixels.byteLength);
  const glData = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const difference = new Uint8Array(pixels.length);
  let total = 0, maximum = 0, aboveOne = 0, aboveSixteen = 0;
  for (let offset = 0; offset < pixels.length; offset++) {
    if (offset % 4 === 3) { difference[offset] = 255; continue; }
    const error = Math.abs(cpuData.getUint8(offset) - glData.getUint8(offset));
    total += error;
    maximum = Math.max(maximum, error);
    if (error > 1) aboveOne++;
    if (error > 16) aboveSixteen++;
    difference[offset] = Math.min(255, error * 8);
  }
  const channels = width * height * 3;
  let reference: { readonly path: string; readonly sha256: string; readonly cpuMeanRgbError: number;
    readonly glMeanRgbError: number; readonly cpuMaximumRgbError: number; readonly glMaximumRgbError: number;
    readonly cpuFractionAboveSixteen: number; readonly glFractionAboveSixteen: number; readonly acceptance: "not-established" } | null = null;
  if (values.reference !== undefined) {
    const bytes = await Bun.file(values.reference).bytes();
    const original = decodeTga(bytes, values.reference);
    if (original.width !== width || original.height !== height) throw new Error("Reference dimensions must match exactly; reference images are never resized");
    let cpuTotal = 0, glTotal = 0, cpuMaximum = 0, glMaximum = 0, cpuAbove = 0, glAbove = 0;
    const referenceData = new DataView(original.pixels.buffer, original.pixels.byteOffset, original.pixels.byteLength);
    const referenceDifference = new Uint8Array(pixels.length);
    for (let offset = 0; offset < pixels.length; offset++) {
      if (offset % 4 === 3) { referenceDifference[offset] = 255; continue; }
      const expected = referenceData.getUint8(offset);
      const cpuError = Math.abs(cpuData.getUint8(offset) - expected), glError = Math.abs(glData.getUint8(offset) - expected);
      cpuTotal += cpuError; glTotal += glError;
      cpuMaximum = Math.max(cpuMaximum, cpuError); glMaximum = Math.max(glMaximum, glError);
      if (cpuError > 16) cpuAbove++;
      if (glError > 16) glAbove++;
      referenceDifference[offset] = Math.min(255, cpuError * 8);
    }
    reference = { path: values.reference, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
      cpuMeanRgbError: cpuTotal / channels, glMeanRgbError: glTotal / channels,
      cpuMaximumRgbError: cpuMaximum, glMaximumRgbError: glMaximum,
      cpuFractionAboveSixteen: cpuAbove / channels, glFractionAboveSixteen: glAbove / channels, acceptance: "not-established" };
    await mkdir(values.output, { recursive: true });
    await Bun.write(join(values.output, `${values.map}-reference.png`), encodePng(width, height, original.pixels));
    await Bun.write(join(values.output, `${values.map}-reference-difference.png`), encodePng(width, height, referenceDifference));
  }
  const report = {
    map: values.map, product: values.product, width, height, frames, startTime, time: lastClock.time, camera, batches: batches.length,
    view: { origin: refdef.viewOrigin, axis: refdef.viewAxis, fovX: refdef.fovX, fovY: refdef.fovY },
    cinematicStartTime, cinematicTime: lastClock.cinematicTime,
    shaderRemaps: remapText === null ? null : { path: remapPath, records: shaderRemaps },
    clockTrace: traceText === null ? null : { path: tracePath, sha256: Bun.CryptoHasher.hash("sha256", traceText, "hex"), clocks },
    triangles: batches.reduce((total, batch) => total + batch.indexCount / 3, 0),
    modelFixture: values.models,
    entities: entities.map(entity => ({ model: entity.model.path, skin: entity.customSkin?.path ?? null, origin: entity.origin,
      frame: entity.frame, oldFrame: entity.oldFrame, backLerp: entity.backLerp })),
    cpuMilliseconds, glMilliseconds,
    glReadbackMilliseconds: readbackMilliseconds,
    timingScope: "summed interleaved backend-call wall time; GL also includes final synchronized readback",
    meanRgbError: total / channels, maximumRgbError: maximum,
    fractionAboveOne: aboveOne / channels, fractionAboveSixteen: aboveSixteen / channels,
    driver: gl.driver, subpixelBits: gl.subpixelBits, alphaBits, diagnostics: scene.diagnostics,
    reference,
  };
  await mkdir(values.output, { recursive: true });
  for (const [name, rgba] of [["cpu", cpu.pixels], ["gl", pixels], ["difference", difference]] satisfies readonly [string, Uint8Array][]) {
    await Bun.write(join(values.output, `${values.map}-${name}.png`), encodePng(width, height, rgba));
  }
  await Bun.write(join(values.output, `${values.map}.json`), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (reference !== null) process.stdout.write("Reference metrics are descriptive, not a parity acceptance: confirm original camera, clock and render settings separately.\n");
  if (report.meanRgbError > 2 || report.fractionAboveSixteen > 0.01) {
    throw new Error("CPU/GL comparison exceeded declared gate: mean RGB error <=2 and <=1% channels differ by more than16");
  }
} catch (cause: unknown) {
  failure = { cause };
  if (target !== null) try { target.fail(cause); } catch { /* The original failure remains authoritative. */ }
} finally {
  const cleanup = (operation: () => unknown): void => {
    try { operation(); } catch (cause: unknown) { if (failure === null) failure = { cause }; }
  };
  cleanup(() => commands?.close(failure === null ? "require-empty" : "discard"));
  cleanup(() => target?.close());
  if (target === null) cleanup(() => gl?.close());
  cleanup(() => cinematics?.dispose());
  cleanup(() => window?.close());
  cleanup(() => vfs.close());
}
if (failure !== null) throw failure.cause;
