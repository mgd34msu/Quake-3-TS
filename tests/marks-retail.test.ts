import { HunkArena } from "../src/core/hunk.ts";
import { afterEach, expect, test } from "bun:test";
import { cameraRefdef } from "./refdef-fixture.ts";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { ImpactMarkSystem } from "../src/cgame/marks.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { add3, angleVectors, scale3, vec3, type Vec4 } from "../src/core/math.ts";
import { encodePng } from "../src/core/png.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { BspMarkProjector } from "../src/render/marks.ts";
import { RendererResources, type WorldFrame } from "../src/render/world.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";

const dataPath = process.env["Q3_DATA"];
const imageDirectory = process.env["Q3_MARKS_IMAGE_DIR"];
const cases: readonly { product: "baseq3" | "missionpack"; map: string }[] = [{ product: "baseq3", map: "q3dm1" }, { product: "missionpack", map: "mpteam1" }];
const width = 160, height = 120, clear: Vec4 = { x: 0, y: 0, z: 0, w: 1 };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function retailImpact(entry: { product: "baseq3" | "missionpack"; map: string }, native: boolean) {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: entry.product });
  const images = new RendererImageCatalog();
  const window = native ? SdlWindow.open({ title: "Retail impact marks", width, height, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), cpu = new SoftwareRenderer(width, height, images, gl?.subpixelBits ?? 8);
  const target = new RenderTarget(images, gl === null ? [cpu] : [cpu, gl]);
  const settings = createRendererSettings();
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1 && settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cinematicMixer = new AudioMixer(44100, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 100 },
    scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  cleanup.push(() => { try { target.close(); } finally { cinematics.dispose(); window?.close(); } });
  const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings,
    { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics }), world = await resources.loadWorld(entry.map);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 100 }, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  cleanup.push(() => commands.close("discard"));
  function submit(frame: WorldFrame): Uint8Array {
    commands.addView({ viewport: { x: 0, y: 0, width, height }, clear: { stencil: false, color: clear, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
    commands.addPreparedViews(world.prepareFrame(frame)); commands.submit();
    return new Uint8Array(cpu.pixels);
  }
  const shader = await resources.registerShader("gfx/damage/bullet_mrk"), collisionMap = parseBsp(await vfs.read(`maps/${entry.map}.bsp`));
  const collision = new CollisionWorld(collisionMap, { kind: "unaccounted" }, { kind: "disabled" });
  const clock = { time: 100 }, marks = new ImpactMarkSystem(new BspMarkProjector(world.markGeometry), { clock: () => clock.time, enabled: () => true, energyShader: () => null });
  const camera = world.initialCamera();
  for (const pitch of [0, 30, 60, -30]) for (let yaw = 0; yaw < 360; yaw += 15) {
    const angles = vec3(pitch, yaw, 0), direction = angleVectors(angles).forward;
    const trace = collision.trace({ start: camera.origin, end: add3(camera.origin, scale3(direction, 2048)), shape: { kind: "point" }, mask: 1 });
    if (trace.contact.kind !== "plane" || trace.solidity !== "clear" || trace.fraction * 2048 < 40 || (trace.surfaceFlags & 0x30) !== 0) continue;
    const request = { shader, origin: trace.end, direction: trace.contact.plane.normal, orientation: 23, color: { x: 1, y: 1, z: 1, w: 1 }, alphaFade: true, radius: 32, temporary: false };
    if (marks.impactMark({ ...request, temporary: true }).length === 0) continue;
    marks.impactMark(request);
    const view: WorldFrame = { refdef: cameraRefdef({ origin: camera.origin, angles }, width, height, 100) };
    return { view, marks, clock, submit, gl };
  }
  throw new Error(`${entry.map}: no markable world collision found from spawn`);
}
function changedPixels(before: Uint8Array | Uint8ClampedArray, after: Uint8Array | Uint8ClampedArray): number {
  let count = 0;
  for (let index = 0; index < before.length; index += 4) if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2]) count++;
  return count;
}

test.skipIf(dataPath === undefined)("retail collision impacts produce visible CPU decals and disappear after their source lifetime in both products", async () => {
  for (const entry of cases) {
    const { view, marks, clock, submit } = await retailImpact(entry, false);
    const render = (): Uint8Array => submit({ ...view, polys: marks.addMarks() });
    const withMark = render(); expect(marks.activeMarkCount).toBeGreaterThan(0);
    clock.time = 10101; const expired = render(); expect(marks.activeMarkCount).toBe(0);
    expect(changedPixels(expired, withMark), entry.map).toBeGreaterThan(10);
    if (imageDirectory !== undefined) {
      await Bun.write(join(imageDirectory, `${entry.map}-marked-cpu.png`), encodePng(width, height, withMark));
      await Bun.write(join(imageDirectory, `${entry.map}-expired-cpu.png`), encodePng(width, height, expired));
    }
    expect(expired).toEqual(submit(view));
  }
}, 120000);

test.skipIf(dataPath === undefined || process.env["QUAKE_GL_TEST"] !== "1")("retail collision decals render through system OpenGL and agree with CPU decal coverage", async () => {
    for (const entry of cases) {
      const { view, marks, submit, gl } = await retailImpact(entry, true);
      if (gl === null) throw new Error("Native fixture requires OpenGL");
      const cpuBefore = submit(view), glBefore = gl.readPixels();
      const cpuAfter = submit({ ...view, polys: marks.addMarks() }), glAfter = gl.readPixels();
      if (imageDirectory !== undefined) await Bun.write(join(imageDirectory, `${entry.map}-marked-gl.png`), encodePng(width, height, glAfter));
      const glChanges = changedPixels(glBefore, glAfter), cpuChanges = changedPixels(cpuBefore, cpuAfter);
      expect(glChanges, entry.map).toBeGreaterThan(10); expect(cpuChanges, entry.map).toBeGreaterThan(10);
      expect(Math.abs(glChanges - cpuChanges) / Math.max(glChanges, cpuChanges), entry.map).toBeLessThan(0.2);
    }
}, 120000);
