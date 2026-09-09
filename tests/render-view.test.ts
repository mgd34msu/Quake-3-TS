import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { expect, test } from "bun:test";
import { vec3, vec4 } from "../src/core/math.ts";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { Vec3, Vec4 } from "../src/core/math.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, ImmediateViewOperation, RenderView, SourceClipProjection } from "../src/render/types.ts";
import { createRefdef, RDF_HYPERSPACE, RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { boundsInFrustum, farClip, snapshotView, viewFrustum, viewProjection, viewProjector } from "../src/render/view.ts";
import { RendererResources } from "../src/render/world.ts";
import type { RendererResourceServices } from "../src/render/world.ts";
import { createPortalEntity, createSpriteEntity } from "../src/render/ref-entity.ts";
import { cameraRefdef } from "./refdef-fixture.ts";
import { renderBspFixture } from "./render-bsp-fixture.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererImageCatalog, type RendererImage } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget, type RendererBackend } from "../src/render/commands.ts";
import type { RenderViewState, SourcePreparedViews } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { executeStaticBatch, publishTexture, recordPreparedViews } from "./render-target-fixture.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const red = vec4(1, 0, 0, 1), green = vec4(0, 1, 0, 1), blue = vec4(0, 0, 1, 1);
function quad(image: RendererImage, color: Vec4, depth: number): DrawBatch {
  return { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, state: OPAQUE_STATE, indices: [0, 1, 2, 0, 2, 3],
    vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(point => {
      const [x, y] = point; if (x === undefined || y === undefined) throw new Error("quad coordinate missing");
      return { position: vec4(x, y, depth, 1), texCoord: { x: 0, y: 0 }, color };
    }) };
}
function sample(pixels: Uint8Array, x: number, y: number): number[] { return Array.from(pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)); }
const fullViewport = { x: 0, y: 0, width: 16, height: 16 };
function whiteImage(images: RendererImageCatalog): RendererImage {
  const image = publishTexture(images, { name: "view-white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(images, { name: "view-sentinel", width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  return image;
}
function viewCommands(target: RenderTarget): RenderCommandBuffer {
  return new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: createRendererSettings().runtime });
}
function drawView(commands: RenderCommandBuffer, view: RenderView): void {
  commands.addView(view); commands.submit();
}

function exercise(renderer: RendererBackend, image: RendererImage, target: RenderTarget, pixels: () => Uint8Array): void {
  const commands = viewCommands(target);
  renderer.beginView({ viewport: fullViewport, clear: { stencil: false, color: blue, depth: 1 } });
  drawView(commands, { viewport: { x: 2, y: 3, width: 8, height: 6 }, clear: { stencil: false, depth: 1, color: null }, operations: [{ kind: "draw", batches: [quad(image, red, -0.5)] }] });
  drawView(commands, { viewport: { x: 6, y: 5, width: 8, height: 6 }, clear: { stencil: false, depth: 1, color: null }, operations: [{ kind: "draw", batches: [quad(image, green, 0.5)] }] });
  expect(sample(pixels(), 0, 0)).toEqual([0, 0, 255, 255]);
  expect(sample(pixels(), 3, 4)).toEqual([255, 0, 0, 255]);
  expect(sample(pixels(), 7, 6)).toEqual([0, 255, 0, 255]);
  expect(sample(pixels(), 14, 10)).toEqual([0, 0, 255, 255]);
  renderer.beginView({ viewport: fullViewport, clear: null });
  executeStaticBatch(renderer, quad(image, blue, 0));
  expect(sample(pixels(), 0, 0)).toEqual([0, 0, 255, 255]);
  expect(sample(pixels(), 3, 4)).toEqual([255, 0, 0, 255]);
  expect(sample(pixels(), 7, 6)).toEqual([0, 0, 255, 255]);
  drawView(commands, { viewport: { x: -3, y: 13, width: 6, height: 6 }, clear: { stencil: false, depth: 1, color: green }, operations: [{ kind: "draw", batches: [] }] });
  expect(sample(pixels(), 0, 15)).toEqual([0, 255, 0, 255]);
  expect(sample(pixels(), 3, 15)).toEqual([0, 0, 255, 255]);
  renderer.beginView({ viewport: fullViewport, clear: { stencil: false, color: red, depth: 1 } });
  expect(sample(pixels(), 15, 0)).toEqual([255, 0, 0, 255]);
}

test("CPU views apply top-left viewport/scissor, clear overlapping depth, preserve outside color, and restore full-target draw", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images), target = new RenderTarget(images, [cpu]);
  try { exercise(cpu, whiteImage(images), target, () => cpu.pixels); } finally { target.close(); }
});
test("CPU line iteration is bounded by the drawable scissor even for an int32-wide viewport", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images), target = new RenderTarget(images, [cpu]);
  const batch: DrawBatch = { texturing: "single", primitive: "lines", lineWidth: 3, texture: { kind: "bind-image", image: whiteImage(images) }, state: OPAQUE_STATE, indices: [0, 1],
    vertices: [-1, 1].map(x => ({ position: vec4(x, 0, 0, 1), texCoord: { x: 0, y: 0 }, color: red })) };
  try {
    cpu.beginView({ viewport: fullViewport, clear: { stencil: false, color: blue, depth: 1 } });
    drawView(viewCommands(target), { viewport: { x: 0, y: 0, width: 2147483647, height: 16 }, clear: { stencil: false, depth: 1, color: null }, operations: [{ kind: "draw", batches: [batch] }] });
    expect(sample(cpu.pixels, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(sample(cpu.pixels, 8, 0)).toEqual([0, 0, 255, 255]);
  } finally { target.close(); }
});
test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL views share viewport, scissor, clear, and full-target transitions with CPU", () => {
  const window = SdlWindow.open({ title: "Canonical view parity", width: 16, height: 16, backend: "gl", hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images), target = new RenderTarget(images, [gl]);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  try { exercise(gl, whiteImage(images), target, () => gl.readPixels()); } finally { target.close(); window.close(); }
});

function exerciseRetainedClip(renderer: RendererBackend, image: RendererImage, target: RenderTarget, pixels: () => Uint8Array): void {
  const commands = viewCommands(target), clear = { stencil: true, color: blue, depth: 1 };
  const eyePlane = { x: 1, y: 0, z: 0, w: -1 }, projection: [number, number, number, number] = [1, 1, -1, -2];
  commands.addView({ viewport: fullViewport, clear, clipPlane: { kind: "portal", eyePlane, projection },
    operations: [{ kind: "draw", batches: [quad(image, red, 0)] }] });
  eyePlane.x = -1; projection[0] = 2;
  commands.submit();
  // x_eye - w_eye >= 0 becomes x_clip >= 0.5 at this depth.
  expect(sample(pixels(), 11, 8)).toEqual([0, 0, 255, 255]);
  expect(sample(pixels(), 14, 8)).toEqual([255, 0, 0, 255]);

  const nextProjection: [number, number, number, number] = [0.5, 1, -2, -4];
  commands.addView({ viewport: fullViewport, clear, clipPlane: { kind: "retain", projection: nextProjection },
    operations: [{ kind: "draw", batches: [quad(image, red, 0)] }] });
  nextProjection[0] = 2;
  commands.submit();
  // The same eye plane under the changed projection now clips at x_clip = 0.25.
  expect(sample(pixels(), 8, 8)).toEqual([0, 0, 255, 255]);
  expect(sample(pixels(), 11, 8)).toEqual([255, 0, 0, 255]);
  drawView(commands, { viewport: fullViewport, clear, operations: [{ kind: "draw", batches: [quad(image, green, 0)] }] });
  expect(sample(pixels(), 0, 8)).toEqual([0, 255, 0, 255]);

  const sourceProjection: SourceClipProjection = [1, 1, -1, -2];
  const portal = { kind: "portal", eyePlane: { x: 1, y: 0, z: 0, w: -1 }, projection: sourceProjection } satisfies NonNullable<RenderView["clipPlane"]>;
  for (const reset of ["shadow-finish", "2d"]) {
    renderer.beginView({ viewport: fullViewport, clear, clipPlane: portal });
    if (reset === "shadow-finish") renderer.drawImmediate({ kind: "shadow-finish", whiteImage: image,
      positions: [vec4(-1, -1, 0, 1), vec4(1, -1, 0, 1), vec4(1, 1, 0, 1), vec4(-1, 1, 0, 1)] });
    else renderer.beginView({ viewport: fullViewport, clear: null });
    drawView(commands, { viewport: fullViewport, clear, clipPlane: { kind: "retain", projection: sourceProjection },
      operations: [{ kind: "draw", batches: [quad(image, red, 0)] }] });
    expect(sample(pixels(), 0, 8)).toEqual([255, 0, 0, 255]);
  }
  expect(() => commands.addView({ viewport: fullViewport, clear, clipPlane: { kind: "portal", eyePlane, projection: [0, 1, -1, -2] }, operations: [] })).toThrow("nonsingular");
  drawView(commands, { viewport: fullViewport, clear, clipPlane: { kind: "retain", projection: [1, 1, 1, 0] }, operations: [] });
  expect(() => commands.addView({ viewport: fullViewport, clear, clipPlane: { kind: "portal", eyePlane: vec4(NaN, 0, 0, 0), projection: sourceProjection }, operations: [] })).toThrow("finite");
  commands.close("discard");
}

test("CPU retains the source eye clip plane across hyperspace projection changes until an ordinary view, shadow finish or 2D disables it", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images, 8, 8), target = new RenderTarget(images, [cpu]);
  try { exerciseRetainedClip(cpu, whiteImage(images), target, () => cpu.pixels); } finally { target.close(); }
});
test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("actual GL retains and reprojects the source eye plane with the same hyperspace and disable transitions", () => {
  const window = SdlWindow.open({ title: "Hyperspace clip retention", width: 16, height: 16, backend: "gl", stencilBits: 8, hidden: true });
  const images = new RendererImageCatalog(), gl = new GlRenderer(window, images), target = new RenderTarget(images, [gl]);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  try { exerciseRetainedClip(gl, whiteImage(images), target, () => gl.readPixels()); } finally { target.close(); window.close(); }
});
test("view projection preserves independent FOVs and supplied non-Euler basis without normalization", () => {
  const view = createRefdef(); view.width = 100; view.height = 100; view.fovX = 90; view.fovY = 60;
  view.viewAxis = [vec3(2, 0, 0), vec3(0.25, 3, 0), vec3(0, 0.5, 4)];
  const copied = snapshotView(view), project = viewProjector(copied, viewProjection(copied, 2048));
  const point = project(vec3(10, 2, 3));
  expect(point.w).toBe(20); expect(point.x).toBe(-8.5); expect(point.y).toBeCloseTo(13 * Math.sqrt(3), 5);
  expect(viewFrustum(copied)[0].normal.x).toBeCloseTo(2.25 / Math.sqrt(2), 5);
  expect(boundsInFrustum({ min: vec3(-10, -1, -1), max: vec3(-5, 1, 1) }, viewFrustum(copied))).toBe(false);
  view.viewAxis = [vec3(1, 0, 0), view.viewAxis[1], view.viewAxis[2]]; view.areaMask.fill(255);
  expect(copied.viewAxis[0]).toEqual(vec3(2, 0, 0)); expect(copied.areaMask[0]).toBe(0);
});
test("far clip uses visible bounds corners, with source no-world distance2048", () => {
  const view = createRefdef(); view.viewOrigin = vec3(1, 2, 3);
  expect(farClip(view, { min: vec3(1, 2, 3), max: vec3(4, 6, 3) })).toBe(5);
  view.renderFlags = RDF_NOWORLDMODEL;
  expect(farClip(view, { min: vec3(1, 2, 3), max: vec3(4, 6, 3) })).toBe(2048);
});
test("canonical scene honors no-world, hyperspace clear without discarding entities, int32 clocks, and zero viewport", async () => {
  const script = new TextEncoder().encode(`test/red { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }
    test/mirror { portal { map $whiteimage blendFunc GL_ZERO GL_ONE depthWrite } }
    test/black { { map $whiteimage rgbGen const ( 0 0 0 ) } }`);
  const bsp = renderBspFixture([{ shader: "test/mirror", lightmap: -1 }, { shader: "test/black", lightmap: -1 }], []);
  bsp.set([1, 2], bsp.length - 2);
  const files = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: (name: string) => name.startsWith("maps/") ? bsp.byteLength : name === "scripts/test.shader" ? script.byteLength : -1,
    readFileOptional: async (name: string) => name.startsWith("maps/") ? bsp : name === "scripts/test.shader" ? script : undefined,
    has: (name: string) => name === "scripts/test.shader", list: () => ["scripts/test.shader"],
    read: async (name: string) => name.startsWith("maps/") ? bsp : script });
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Source near-plane cvar", width: 16, height: 16, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const cpu = new SoftwareRenderer(16, 16, images, gl?.subpixelBits), target = new RenderTarget(images, gl === null ? [cpu] : [cpu, gl]);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), gl === null ? cpu.capabilities : gl.capabilities);
  if (gl !== null) gl.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cinematicMixer = new AudioMixer(22050, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, drawDebugSurface: () => undefined,
    imageProfile: identityImageUploadProfile, target, images, builtins, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: resources.tess, runtime: resources.settings.runtime });
  try {
    expect(resources.worldBaseName).toBeNull();
    const view = createRefdef(); view.width = 16; view.height = 16; view.fovX = view.fovY = 90;
    view.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    expect(() => resources.frame({ refdef: view })).toThrow("NULL worldmodel");
    view.renderFlags = RDF_NOWORLDMODEL | RDF_HYPERSPACE; view.time = 384;
    const sprite = { ...createSpriteEntity(), origin: vec3(20, 0, 0), radius: 2, customShader: await resources.registerShader("test/red") };
    const views = resources.frame({ refdef: view, entities: [sprite] });
    expect(views[0]?.clipPlane).toEqual({ kind: "retain", projection: [1, 1, viewProjection(view, 2048)[10], viewProjection(view, 2048)[14]] });
    expect(views[0]?.operations.flatMap(operation => operation.kind === "draw" ? operation.batches : operation.kind === "source-stage" ? [operation.stage.batch] : []).length).toBe(1);
    expect(views[0]?.clear.color).toEqual(vec4(128 / 255, 128 / 255, 128 / 255, 1));
    for (const rendered of views) commands.addView(rendered);
    commands.submit();
    expect(sample(cpu.pixels, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(sample(cpu.pixels, 0, 0)).toEqual([128, 128, 128, 255]);
    const prepared = resources.prepareFrame({ refdef: view, entities: [sprite] });
    cvars.set("r_znear", "32");
    commands.addPreparedViews(prepared); commands.submit();
    expect(sample(cpu.pixels, 8, 8)).toEqual([255, 0, 0, 255]);
    if (gl !== null) expect(sample(gl.readPixels(), 8, 8)).toEqual([255, 0, 0, 255]);
    commands.addPreparedViews(resources.prepareFrame({ refdef: view, entities: [sprite] })); commands.submit();
    expect(sample(cpu.pixels, 8, 8)).toEqual([128, 128, 128, 255]);
    if (gl !== null) expect(sample(gl.readPixels(), 8, 8)).toEqual([128, 128, 128, 255]);
    expect(() => resources.frame({ refdef: { ...view, time: 0.5 } })).toThrow("int32");
    expect(resources.frame({ refdef: { ...view, renderFlags: RDF_NOWORLDMODEL | 2 } })).toEqual(resources.frame({ refdef: { ...view, renderFlags: RDF_NOWORLDMODEL } }));
    expect(resources.frame({ refdef: { ...view, width: 0 } })).toEqual([]);
    cvars.set("r_znear", "4");
    const world = await resources.loadWorld("maps/folder/portal.test.bsp");
    expect(resources.worldBaseName).toBe("portal");
    const portal = createPortalEntity(); portal.origin = vec3(32, -12, 0); portal.oldOrigin = portal.origin;
    const mirrorFrame = { refdef: cameraRefdef({ origin: vec3(0, -12, 0), angles: vec3(0, 0, 0) }, 16, 16), entities: [portal],
      polys: [{ shader: sprite.customShader, vertices: [[-16, -16], [16, -16], [16, 16], [-16, 16]].map(([y, z]) => {
        if (y === undefined || z === undefined) throw new Error("missing mirror quad coordinate");
        return { position: vec3(0, y - 12, z), texCoord: { x: 0, y: 0 }, color: vec4(255, 255, 255, 255) };
      }) }] };
    function mirrorViews(prepared: SourcePreparedViews): readonly RenderView[] {
      const views: RenderView[] = [];
      commands.addView({ viewport: fullViewport, clear: { stencil: false, color: vec4(0, 0, 0, 1), depth: 1 }, operations: [] });
      commands.addPreparedViews(drawSurfs => recordPreparedViews(prepared(drawSurfs), views)); commands.submit();
      return views;
    }
    mirrorViews(world.prepareFrame(mirrorFrame));
    const original = mirrorViews(world.prepareFrame(mirrorFrame));
    const portalPlane = original[0]?.clipPlane;
    expect(portalPlane !== undefined && "kind" in portalPlane ? portalPlane.kind : null).toBe("portal");
    expect(original).toHaveLength(2); expect(sample(cpu.pixels, 8, 8)).toEqual([255, 0, 0, 255]);
    const captured = world.prepareFrame(mirrorFrame);
    cvars.set("r_znear", "80");
    expect(mirrorViews(captured)).toEqual(original);
    expect(sample(cpu.pixels, 8, 8)).toEqual([255, 0, 0, 255]);
    if (gl !== null) expect(sample(gl.readPixels(), 8, 8)).toEqual([255, 0, 0, 255]);
    cvars.set("r_znear", "4"); cvars.set("r_portalOnly", "1");
    const portalOnly = mirrorViews(world.prepareFrame(mirrorFrame));
    expect(portalOnly).toHaveLength(1);
    const retainedPortal = portalOnly[0]?.clipPlane;
    expect(retainedPortal !== undefined && "kind" in retainedPortal ? retainedPortal.kind : null).toBe("portal");
    const hyperspaceViews: RenderView[] = [];
    const hyperspace = world.prepareFrame({ ...mirrorFrame, refdef: { ...mirrorFrame.refdef, renderFlags: RDF_HYPERSPACE } });
    commands.addPreparedViews(drawSurfs => recordPreparedViews(hyperspace(drawSurfs), hyperspaceViews)); commands.submit();
    expect(hyperspaceViews.length).toBeGreaterThan(0);
    for (const rendered of hyperspaceViews) {
      const plane = rendered.clipPlane;
      expect(plane !== undefined && "kind" in plane ? plane.kind : null).toBe("retain");
    }
    const longName = "A".repeat(70);
    const longNameResources = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" },
      print: () => undefined, drawDebugSurface: () => undefined, imageProfile: identityImageUploadProfile,
      target, images, builtins, shaderCinematics: cinematics.shaderCinematics });
    await longNameResources.loadWorld(`maps/${longName}.bsp`);
    expect(longNameResources.worldBaseName).toBe("A".repeat(58));
  } finally { commands.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
});

class DebugSurfaceRenderer extends SoftwareRenderer {
  readonly events: string[] = [];
  readonly immediate: ImmediateViewOperation[] = [];
  afterView: (() => undefined) | null = null;
  override beginView(view: RenderViewState): undefined {
    super.beginView(view);
    this.events.push("view");
    this.afterView?.();
  }
  override drawImmediate(operation: ImmediateViewOperation): undefined {
    super.drawImmediate(operation);
    this.immediate.push(operation);
    if (operation.kind === "begin-debug-surface" || operation.kind === "debug-polygon") this.events.push(operation.kind);
  }
  override finish(): undefined { super.finish(); this.events.push("finish"); }
}

async function debugSurfaceFixture(drawDebugSurface: RendererResourceServices["drawDebugSurface"], stencilBits = 8) {
  const script = new TextEncoder().encode(`test/red { cull none { map $whiteimage rgbGen const ( 1 0 0 ) } }
    test/blue { cull none { map $whiteimage rgbGen const ( 0 0 1 ) } }
    test/mirror { portal { map $whiteimage blendFunc GL_ZERO GL_ONE depthWrite } }
    test/black { { map $whiteimage rgbGen const ( 0 0 0 ) } }`);
  const bsp = renderBspFixture([{ shader: "test/mirror", lightmap: -1 }, { shader: "test/black", lightmap: -1 }], []);
  bsp.set([1, 2], bsp.length - 2);
  const files = withRetainedFiles<AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">>({ readFileLength: (name: string) => name.startsWith("maps/") ? bsp.byteLength : name === "scripts/test.shader" ? script.byteLength : -1,
    readFileOptional: async (name: string) => name.startsWith("maps/") ? bsp : name === "scripts/test.shader" ? script : undefined,
    has: (name: string) => name === "scripts/test.shader", list: () => ["scripts/test.shader"],
    read: async (name: string) => name.startsWith("maps/") ? bsp : script });
  const images = new RendererImageCatalog(), cpu = new DebugSurfaceRenderer(16, 16, images, 8, stencilBits);
  const target = new RenderTarget(images, [cpu]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const mixer = new AudioMixer(22050, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => mixer },
    clock: { sample: () => 0 }, scratchImages: builtins, console: { kind: "absent" },
    settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), cpu.capabilities);
  const resources = await RendererResources.create(files, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, drawDebugSurface,
    imageProfile: identityImageUploadProfile, target, images, builtins, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: () => undefined, clock: { milliseconds: () => 0 },
    identityLight: 1, tess: resources.tess, runtime: settings.runtime });
  const refdef = createRefdef(); refdef.width = refdef.height = 16; refdef.fovX = refdef.fovY = 90;
  refdef.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]; refdef.renderFlags = RDF_NOWORLDMODEL;
  return { cpu, target, resources, commands, refdef, cvars, settings, builtins,
    close: () => { commands.close("discard"); target.close(); cinematics.dispose(); } };
}

test("R_DebugGraphics uses the live integer cheat gate and synchronizes queued views before the CM callback", async () => {
  let callbacks = 0;
  const fixture = await debugSurfaceFixture(() => { callbacks++; fixture.cpu.events.push("provider"); });
  const { resources, refdef, commands, cvars, cpu, settings } = fixture;
  try {
    expect(cvars.get("r_debugSurface")).toMatchObject({ value: "0", resetValue: "0", flags: CvarFlag.Cheat });
    resources.renderFrame({ refdef });
    expect(cpu.events).toEqual([]);
    cvars.set("r_debugSurface", "0.75");
    expect(settings.runtime.debugSurface).toBe(0);
    resources.renderFrame({ refdef });
    expect(cpu.events).toEqual([]);
    cvars.set("r_debugSurface", "-2");
    resources.renderFrame({ refdef });
    expect(cpu.events).toEqual(["view", "view", "view", "begin-debug-surface", "provider"]);
    expect(callbacks).toBe(1);
    expect(cpu.immediate.at(-1)).toMatchObject({ kind: "begin-debug-surface", cull: "front", whiteImage: fixture.builtins.find("*white")?.image });
    expect(commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
    resources.renderFrame({ refdef: { ...refdef, width: 0 } });
    expect(callbacks).toBe(1);
    expect(commands.submit().commands).toBe(0);
  } finally { fixture.close(); }
});

test("R_DebugPolygon consumes the retained world transform, detaches only the requested points and draws immediately", async () => {
  const points: Vec3[] = [vec3(20, 8, -8), vec3(20, 8, 8), vec3(20, -8, 8), vec3(20, -8, -8), vec3(NaN, NaN, NaN)];
  const fixture = await debugSurfaceFixture(draw => {
    fixture.cpu.events.push("provider");
    expect(sample(fixture.cpu.pixels, 8, 8)).toEqual([0, 0, 255, 255]);
    draw(2, 4, points);
    expect(sample(fixture.cpu.pixels, 8, 8)).toEqual([0, 255, 255, 255]);
    points[0] = vec3(999, 999, 999);
    fixture.cpu.events.push("provider-return");
  });
  try {
    fixture.cvars.set("r_debugSurface", "2");
    const picture = fixture.resources.picture(await fixture.resources.registerShaderNoMip("test/blue"));
    fixture.commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 16, height: 16 }, vec4(1, 1, 1, 1), picture);
    fixture.resources.renderFrame({ refdef: fixture.refdef });
    expect(fixture.cpu.events).toEqual(["view", "view", "begin-debug-surface", "provider", "debug-polygon", "provider-return"]);
    const polygon = fixture.cpu.immediate.find(operation => operation.kind === "debug-polygon");
    if (polygon?.kind !== "debug-polygon") throw new Error("Missing source debug polygon");
    expect(polygon.color).toBe(2); expect(polygon.positions).toHaveLength(4);
    expect(polygon.positions[0]).toMatchObject({ x: -8, y: -8, w: 20 });
    expect(fixture.resources.tess.actualDepthRange).toEqual([0, 1]);
  } finally { fixture.close(); }
});

test("R_DebugGraphics rereads CM state after draining and retains empty polygon state calls", async () => {
  const modes: number[] = [];
  const fixture = await debugSurfaceFixture(draw => {
    modes.push(fixture.settings.runtime.debugSurface);
    draw(7, 0, [vec3(NaN, NaN, NaN)]);
    draw(-1, -3, [vec3(NaN, NaN, NaN)]);
  });
  try {
    fixture.cvars.set("r_debugSurface", "1");
    fixture.cpu.afterView = () => { fixture.cvars.set("r_debugSurface", "2"); };
    fixture.resources.renderFrame({ refdef: fixture.refdef });
    expect(modes).toEqual([2]);
    expect(fixture.cpu.events).toEqual(["view", "begin-debug-surface", "debug-polygon", "debug-polygon"]);
    expect(fixture.cpu.immediate.filter(operation => operation.kind === "debug-polygon")).toEqual([
      { kind: "debug-polygon", color: 7, positions: [] }, { kind: "debug-polygon", color: -1, positions: [] },
    ]);
  } finally { fixture.close(); }
});

test("R_DebugPolygon preserves the projection-only modelview left by stencil shadow finish", async () => {
  const point = vec3(3, 5, -10);
  const fixture = await debugSurfaceFixture(draw => draw(1, 1, [point]));
  try {
    fixture.cvars.set("r_debugSurface", "2");
    fixture.refdef.viewOrigin = vec3(-17, 2, -8);
    fixture.resources.renderFrame({ refdef: fixture.refdef });
    const world = fixture.cpu.immediate.find(operation => operation.kind === "debug-polygon");
    if (world?.kind !== "debug-polygon") throw new Error("Missing world-transformed polygon");
    expect(world.positions[0]).toMatchObject({ x: -3, y: -2, w: 20 });
    fixture.cpu.immediate.length = 0;
    fixture.cvars.set("cg_shadows", "2");
    const sprite = { ...createSpriteEntity(), origin: vec3(20, 0, 0), radius: 2, customShader: await fixture.resources.registerShader("test/black") };
    fixture.resources.renderFrame({ refdef: fixture.refdef, entities: [sprite] });
    expect(fixture.cpu.immediate.some(operation => operation.kind === "shadow-finish")).toBe(true);
    expect(fixture.cpu.immediate.find(operation => operation.kind === "begin-debug-surface")).toMatchObject({ cull: "none" });
    const identity = fixture.cpu.immediate.find(operation => operation.kind === "debug-polygon");
    if (identity?.kind !== "debug-polygon") throw new Error("Missing projection-only polygon");
    expect(identity.positions[0]).toMatchObject({ x: 3, y: 5, w: 10 });
    fixture.cpu.immediate.length = 0;
    fixture.refdef.renderFlags |= RDF_HYPERSPACE;
    fixture.resources.renderFrame({ refdef: fixture.refdef });
    expect(fixture.cpu.immediate.find(operation => operation.kind === "begin-debug-surface")).toMatchObject({ cull: "none" });
    fixture.cpu.immediate.length = 0;
    fixture.refdef.renderFlags &= ~RDF_HYPERSPACE;
    fixture.resources.renderFrame({ refdef: fixture.refdef });
    expect(fixture.cpu.immediate.find(operation => operation.kind === "begin-debug-surface")).toMatchObject({ cull: "front" });
  } finally { fixture.close(); }
});

test("R_DebugGraphics runs child before parent and still runs the portal-only parent callback", async () => {
  const fixture = await debugSurfaceFixture(() => { fixture.cpu.events.push("provider"); });
  try {
    const world = await fixture.resources.loadWorld("maps/portal.bsp"), portal = createPortalEntity();
    portal.origin = vec3(32, -12, 0); portal.oldOrigin = portal.origin;
    const frame = { refdef: cameraRefdef({ origin: vec3(0, -12, 0), angles: vec3(0, 0, 0) }, 16, 16), entities: [portal] };
    fixture.cvars.set("r_debugSurface", "2");
    world.renderFrame(frame);
    expect(fixture.cpu.events).toEqual(["view", "begin-debug-surface", "provider", "view", "begin-debug-surface", "provider"]);
    expect(fixture.cpu.immediate.filter(operation => operation.kind === "begin-debug-surface").map(operation => operation.cull)).toEqual(["back", "front"]);
    fixture.cpu.events.length = 0; fixture.cpu.immediate.length = 0;
    fixture.cvars.set("r_portalOnly", "1");
    world.renderFrame(frame);
    expect(fixture.cpu.events).toEqual(["view", "begin-debug-surface", "provider", "begin-debug-surface", "provider"]);
    expect(fixture.cpu.immediate.filter(operation => operation.kind === "begin-debug-surface").map(operation => operation.cull)).toEqual(["back", "back"]);
    expect(fixture.commands.submit().commands).toBe(0);
  } finally { fixture.close(); }
});
