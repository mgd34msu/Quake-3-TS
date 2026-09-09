// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { UI_PICTURE_STATE } from "../src/render/draw2d.ts";
import type { PictureAsset } from "../src/render/draw2d.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { DrawBatch, ImmediateViewOperation, RenderStateOperation, RenderView, SourceStageData, SurfaceViewOperation } from "../src/render/types.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { SourceGeometryAllocation } from "../src/render/types.ts";
import { snapshotSourceDebugOperations } from "../src/render/debug-draw.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";
import { MeasuredRendererBackend } from "../tools/render-measurement.ts";
import { RendererPerformanceCounters } from "../src/render/performance.ts";
import { SourceStateBit } from "../src/render/source-state.ts";

const white = { x: 1, y: 1, z: 1, w: 1 }, red = { x: 1, y: 0, z: 0, w: 1 }, green = { x: 0, y: 1, z: 0, w: 1 };
// RB_SetGL2D disables depth testing for these nonwriting UI source stages.
const uiSourceStateBits = SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.SRCBLEND_SRC_ALPHA | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA;
function debugFixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images);
  const measured = new MeasuredRendererBackend(cpu), recording = new BatchRecordingBackend(measured), target = new RenderTarget(images, [recording]);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), cpu.capabilities);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: settings.runtime });
  const image = publishTexture(images, { name: "debug white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const positions = [{ x: -0.75, y: -0.75, z: 0, w: 1 }, { x: 0.75, y: -0.75, z: 0, w: 1 }, { x: 0, y: 0.75, z: 0, w: 1 }];
  const indices = [0, 1, 2], scratch = positions.map(() => ({ color: { ...red }, texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.25, y: 0.75 },
    rawTexCoord: { x: 0.125, y: 0.375 }, rawTexCoord2: { x: 0.625, y: 0.875 } }));
  const start = { x: 0, y: 0, z: 0, w: 1 }, end = { x: 0.5, y: 0, z: 0, w: 1 };
  const tris = { whiteImage: image, positions, indices, scratch, allocation: { kind: "standalone" } satisfies SourceGeometryAllocation };
  const normals = { whiteImage: image, segments: [[start, end] satisfies readonly [typeof start, typeof end]] };
  const operations: SurfaceViewOperation[] = [{ kind: "cull", cull: "none" }, { kind: "debug-tris", input: tris }, { kind: "debug-normals", input: normals }];
  const view: RenderView = { viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: null, depth: 1 }, operations };
  return { images, cpu, measured, recording, target, cvars, settings, commands, image, tris, normals, start, end, operations, view };
}

function sourceDebugTess(positions: readonly { readonly x: number; readonly y: number; readonly z: number }[]): SourceTessState {
  const tess = new SourceTessState();
  tess.replaceGeometry({ vertices: positions.map(position => ({
    position, normal: { x: 0.25, y: 0, z: 0 }, texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 },
    color: { x: 255, y: 255, z: 255, w: 255 },
  })), indices: [0, 1, 2] });
  return tess;
}

test("debug commands detach all triangle and normal fields while wrappers retain actual request meaning", () => {
  const f = debugFixture();
  try {
    f.cvars.set("r_showtris", "-2"); f.cvars.set("r_shownormals", "2"); f.cvars.set("r_primitives", "3");
    f.commands.addView(f.view);
    for (const position of f.tris.positions) position.x = 100;
    for (const cell of f.tris.scratch) {
      cell.color.x = 0; cell.texCoord.x = 5; cell.texCoord2.y = 9; cell.rawTexCoord.x = 7; cell.rawTexCoord2.y = 11;
    }
    f.tris.indices[0] = 99; f.start.y = 100; f.end.x = 100;
    f.measured.beginMeasurement(); f.commands.submit();
    const measurement = f.measured.endMeasurement();
    expect(f.recording.debugTris).toHaveLength(1); expect(f.recording.debugNormals).toHaveLength(1);
    const tris = f.recording.debugTris[0];
    if (tris === undefined) throw new Error("Missing recorded debug triangles");
    expect(tris.primitives).toBe(3); expect(tris.input.indices).toEqual([0, 1, 2]);
    expect(tris.input.positions[0]).toEqual({ x: -0.75, y: -0.75, z: 0, w: 1 });
    expect(tris.input.scratch[0]).toEqual({ color: red, texCoord: { x: 0.5, y: 0.5 }, texCoord2: { x: 0.25, y: 0.75 },
      rawTexCoord: { x: 0.125, y: 0.375 }, rawTexCoord2: { x: 0.625, y: 0.875 } });
    expect(f.recording.debugNormals[0]?.segments).toEqual([[{ x: 0, y: 0, z: 0, w: 1 }, { x: 0.5, y: 0, z: 0, w: 1 }]]);
    const request = measurement.requests.find(value => value.kind === "draw-request");
    if (request === undefined) throw new Error("Missing measured debug triangle request");
    expect(request.indexCount).toBe(3);
    const triangleRequest: unknown = JSON.parse(request.input);
    expect(triangleRequest).toMatchObject({ kind: "debug-tris", indices: [0, 1, 2], primitives: 3,
      whiteImage: { name: "debug white" }, positions: tris.input.positions, scratch: tris.input.scratch });
    const normals = measurement.requests.find(value => value.kind === "immediate-request" && value.input.includes("debug-normals"));
    if (normals === undefined || normals.kind !== "immediate-request") throw new Error("Missing measured normal request");
    const normalRequest: unknown = JSON.parse(normals.input);
    expect(normalRequest).toMatchObject({ kind: "debug-normals", segments: f.recording.debugNormals[0]?.segments });
    expect(f.cpu.pixels.some(value => value !== 0)).toBe(true);
  } finally { f.target.close(); }
});

test("shader upload enables debug at execution and each triangle draw can change the following primitive and normal reads", () => {
  const f = debugFixture(), second = new SoftwareRenderer(16, 16, f.images);
  f.target.close();
  const first = new SoftwareRenderer(16, 16, f.images), target = new RenderTarget(f.images, [first, second]);
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(f.cvars, "linux"), first.capabilities);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: settings.runtime }), events: string[] = [];
  const source = { image: f.image, prepareAtExecution: () => ({ upload: { image: f.image, sourceWidth: 1, sourceHeight: 1,
    uploadWidth: 1, uploadHeight: 1, content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])), dirty: true },
    afterShaderUpload: () => { events.push("upload"); f.cvars.set("r_showtris", "-2"); f.cvars.set("r_shownormals", "-2"); return undefined; } }) };
  const stage: SourceStageData = { kind: "generic-single", stateBits: uiSourceStateBits, batch: { texturing: "single", primitive: "triangles",
    texture: { kind: "shader-cinematic", source }, state: UI_PICTURE_STATE, indices: [], vertices: [] }, scratch: [] };
  for (const [index, backend] of [first, second].entries()) {
    const prepareStage = backend.prepareSourceGeometry.bind(backend), prepare = backend.prepareDebugTris.bind(backend), normals = backend.drawDebugNormals.bind(backend);
    backend.prepareSourceGeometry = input => { const draw = prepareStage(input); return { ...draw,
      draw: primitives => { draw.draw(primitives); events.push(`stage${index}`); if (index === 1) f.cvars.set("r_primitives", "1"); return undefined; } }; };
    backend.prepareDebugTris = input => { const draw = prepare(input); return { ...draw,
      draw: primitives => { draw.draw(primitives); events.push(`tris${index}:${primitives}`);
        if (index === 0) f.cvars.set("r_primitives", "-1");
        if (index === 1) f.cvars.set("r_shownormals", "0"); return undefined; } }; };
    backend.drawDebugNormals = input => { normals(input); events.push(`normals${index}`); return undefined; };
  }
  try {
    const tess = sourceDebugTess(f.tris.positions);
    function* operations(): Generator<SurfaceViewOperation, void, unknown> {
      yield { kind: "source-stage", stage };
      yield { kind: "cull", cull: "none" };
      yield* snapshotSourceDebugOperations(tess, position => ({ ...position, w: 1 }), f.image, settings.runtime);
    }
    commands.addPreparedViews(() => [{ ...f.view, operations: operations() }]);
    commands.submit();
    expect(events).toEqual(["upload", "stage0", "stage1", "tris0:1", "tris1:-1"]);
    f.cvars.set("r_showtris", "0"); f.cvars.set("r_shownormals", "-2");
    commands.addPreparedViews(() => [{ ...f.view, operations: snapshotSourceDebugOperations(tess,
      position => ({ ...position, w: 1 }), f.image, settings.runtime) }]); commands.submit();
    expect(events.slice(-2)).toEqual(["normals0", "normals1"]);
  } finally { target.close(); }
});

test("disabled debug skips foreign ownership and nonfinite data until its enabled call is reached", () => {
  for (const enabled of [false, true]) {
    const f = debugFixture(), foreign = new RendererImageCatalog();
    const image = publishTexture(foreign, { name: "foreign debug", width: 1, height: 1, pixels: new Uint8Array(4),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    try {
      const tess = sourceDebugTess(f.tris.positions.map(position => ({ ...position, x: NaN })));
      expect(() => f.commands.addPreparedViews(() => [{ ...f.view, operations: snapshotSourceDebugOperations(tess,
        position => ({ ...position, w: 1 }), image, f.settings.runtime) }])).not.toThrow();
      if (enabled) { f.cvars.set("r_showtris", "-2"); expect(() => f.commands.submit()).toThrow(); }
      else { f.measured.beginMeasurement(); f.commands.submit();
        expect(f.measured.endMeasurement().requests.map(request => request.kind)).toEqual(["begin-view-request"]); }
      expect(f.recording.debugTris).toHaveLength(0); expect(f.recording.debugNormals).toHaveLength(0);
    } finally { f.target.close(); }
  }
});

test("enabled empty debug calls execute their full state sequence and normals ignore primitive suppression", () => {
  const f = debugFixture();
  try {
    f.cvars.set("r_showtris", "2"); f.cvars.set("r_shownormals", "-2"); f.cvars.set("r_primitives", "-1");
    f.commands.addView({ ...f.view, operations: [{ kind: "debug-tris", input: { whiteImage: f.image, positions: [], indices: [], scratch: [], allocation: { kind: "standalone" } } },
      { kind: "debug-normals", input: { whiteImage: f.image, segments: [] } }] });
    f.measured.beginMeasurement(); f.commands.submit();
    expect(f.measured.endMeasurement().requests.map(request => request.kind)).toEqual([
      "begin-view-request", "begin-draw-request", "draw-request", "cleanup-request", "immediate-request",
    ]);
    expect(f.recording.debugTris).toHaveLength(1); expect(f.recording.debugNormals).toHaveLength(1);
  } finally { f.target.close(); }
});

test("each debug mode defers its own numeric validation until enabled", () => {
  for (const name of ["r_showtris", "r_shownormals"]) {
    const f = debugFixture();
    try {
      const tess = sourceDebugTess(f.tris.positions.map(position => ({ ...position, x: NaN })));
      const prepare = () => [{ ...f.view, operations: snapshotSourceDebugOperations(tess,
        position => ({ ...position, w: 1 }), f.image, f.settings.runtime) }];
      f.commands.addPreparedViews(prepare); expect(() => f.commands.submit()).not.toThrow();
      f.commands.addPreparedViews(prepare); f.cvars.set(name, "-2");
      expect(() => f.commands.submit()).toThrow();
    } finally { f.target.close(); }
  }
});

test("debug wrappers capture geometry and counts before genuine delegate preparation", () => {
  const f = debugFixture(), prepare = f.cpu.prepareDebugTris.bind(f.cpu);
  f.cpu.prepareDebugTris = input => {
    const draw = prepare(input);
    f.tris.indices.length = 0;
    for (const position of f.tris.positions) position.x = 99;
    for (const cell of f.tris.scratch) cell.color.x = 0;
    return draw;
  };
  try {
    f.recording.beginView(f.view); f.cpu.drawImmediate({ kind: "cull", cull: "none" });
    f.measured.beginMeasurement();
    const draw = f.recording.prepareDebugTris(f.tris); draw.begin(); draw.draw(3); draw.cleanup();
    const measurement = f.measured.endMeasurement(), request = measurement.successfulBatches[0];
    if (request === undefined) throw new Error("Missing measured debug triangle request");
    expect(request.indexCount).toBe(3);
    const triangleRequest: unknown = JSON.parse(request.input);
    expect(triangleRequest).toMatchObject({ kind: "debug-tris", indices: [0, 1, 2], primitives: 3,
      positions: [{ x: -0.75, y: -0.75, z: 0, w: 1 }, { x: 0.75, y: -0.75, z: 0, w: 1 }, { x: 0, y: 0.75, z: 0, w: 1 }] });
    expect(f.recording.debugTris[0]?.input.indices).toEqual([0, 1, 2]);
    expect(f.recording.debugTris[0]?.input.scratch[0]?.color).toEqual(red);
  } finally { f.target.close(); }
});

test("retirement during a debug begin prevents draws and does not invent cleanup or normal restoration", () => {
  const f = debugFixture(), events: string[] = [];
  const prepare = f.cpu.prepareDebugTris.bind(f.cpu);
  f.cpu.prepareDebugTris = input => { const draw = prepare(input); return {
    begin: () => { draw.begin(); events.push("begin"); try { f.target.close(); } catch { events.push("caught retirement"); } return undefined; },
    draw: primitives => { draw.draw(primitives); events.push("draw"); return undefined; },
    cleanup: () => { draw.cleanup(); events.push("cleanup"); return undefined; },
  }; };
  try {
    f.cvars.set("r_showtris", "1"); f.cvars.set("r_shownormals", "1");
    f.commands.addView(f.view); expect(() => f.commands.submit()).toThrow("Reentrant render target close");
    expect(events).toEqual(["begin", "caught retirement"]); expect(f.recording.debugNormals).toHaveLength(0);
  } finally { f.target.close(); }
});
function fixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images), recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, [recording]);
  const texture = publishTexture(images, { name: "white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(images, { name: "tail", width: 1, height: 1, pixels: new Uint8Array(4), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const tess = new SourceTessState(), settings = createRendererSettings(), clock = { now: 0, reads: 0 };
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => { clock.reads++; return clock.now; } }, performanceClock: { milliseconds: () => 0 }, identityLight: 1, tess, runtime: settings.runtime });
  const picture: PictureAsset = { kind: "image", name: "white", texture: { kind: "bind-image", image: texture }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } };
  return { images, cpu, recording, target, texture, tess, settings, clock, commands, draw: commands.draw2D("pixels"), picture };
}
function sequence(commands: RenderCommandBuffer, picture: PictureAsset): void {
  const draw = commands.draw2D("pixels");
  draw.fillRect({ x: 0, y: 0, width: 16, height: 16 }, red, picture);
  commands.addView({ viewport: { x: 4, y: 4, width: 8, height: 8 }, clear: { stencil: false, color: green, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
  draw.fillRect({ x: 6, y: 6, width: 4, height: 4 }, white, picture);
}
function verify(pixels: Uint8Array): void {
  const at = (x: number, y: number) => Array.from(pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
  expect(at(0, 0)).toEqual([255, 0, 0, 255]); expect(at(5, 5)).toEqual([0, 255, 0, 255]); expect(at(8, 8)).toEqual([255, 255, 255, 255]); expect(at(13, 13)).toEqual([255, 0, 0, 255]);
}
test("portal planes clip homogeneous triangles and lines, own queued values, and reset for parent, 2D and raw draws", () => {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Portal clip plane", width: 16, height: 16, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), cpu = new SoftwareRenderer(16, 16, images, gl?.subpixelBits);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: createRendererSettings().runtime });
  try {
    const image = publishTexture(images, { name: "portal-white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const picture: PictureAsset = { kind: "image", name: "portal-white", texture: { kind: "bind-image", image }, state: UI_PICTURE_STATE,
      color: { rgb: "vertex", alpha: "vertex" } };
    const viewport = { x: 0, y: 0, width: 16, height: 16 }, clear = { stencil: false, color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1 };
    const vertices = [{ x: -2, y: 2, z: 0, w: 2 }, { x: 1, y: 1, z: 0, w: 1 }, { x: 1, y: -1, z: 0, w: 1 }, { x: -2, y: -2, z: 0, w: 2 }]
      .map(position => ({ position, texCoord: { x: 0.5, y: 0.5 }, color: red }));
    const batch: DrawBatch = { texturing: "single", primitive: "triangles", vertices, indices: [0, 1, 2, 0, 2, 3],
      texture: picture.texture, state: UI_PICTURE_STATE };
    const check = (x: number, y: number, expected: number[]): void => {
      for (const pixels of gl === null ? [cpu.pixels] : [cpu.pixels, gl.readPixels()]) expect(Array.from(pixels.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4))).toEqual(expected);
    };
    const clipPlane = { x: 1, y: 0, z: 0, w: -0.25 };
    commands.addView({ viewport, clear, clipPlane, operations: [{ kind: "draw", batches: [batch] }] }); clipPlane.x = -1; commands.submit();
    expect(recording.trace()[0]?.state.clipPlane).toEqual({ x: 1, y: 0, z: 0, w: -0.25 });
    check(4, 4, [0, 0, 0, 255]); check(9, 4, [0, 0, 0, 255]); check(10, 4, [255, 0, 0, 255]); check(12, 12, [255, 0, 0, 255]);
    const trianglePixels = cpu.pixels.slice(), glTriangle = gl === null ? null : { renderer: gl, pixels: gl.readPixels() };
    const hugePlane = { x: 1e308, y: 0, z: 0, w: -2.5e307 };
    commands.addView({ viewport, clear, clipPlane: hugePlane, operations: [{ kind: "draw", batches: [batch] }] }); commands.submit();
    expect(cpu.pixels).toEqual(trianglePixels);
    if (glTriangle !== null) expect(glTriangle.renderer.readPixels()).toEqual(glTriangle.pixels);
    const lineBatch: DrawBatch = { ...batch, primitive: "lines", lineWidth: 1,
      vertices: [{ position: { x: -2, y: 0.125, z: 0, w: 2 }, texCoord: { x: 0.5, y: 0.5 }, color: red },
        { position: { x: 1, y: 0.0625, z: 0, w: 1 }, texCoord: { x: 0.5, y: 0.5 }, color: red }], indices: [0, 1] };
    commands.addView({ viewport, clear, clipPlane: { x: 1, y: 0, z: 0, w: -0.25 }, operations: [{ kind: "draw", batches: [lineBatch] }] });
    commands.submit(); check(4, 7, [0, 0, 0, 255]); check(12, 7, [255, 0, 0, 255]);
    const linePixels = cpu.pixels.slice(), glLine = gl === null ? null : { renderer: gl, pixels: gl.readPixels() };
    commands.addView({ viewport, clear, clipPlane: hugePlane, operations: [{ kind: "draw", batches: [lineBatch] }] }); commands.submit();
    expect(cpu.pixels).toEqual(linePixels);
    if (glLine !== null) expect(glLine.renderer.readPixels()).toEqual(glLine.pixels);
    commands.addView({ viewport, clear, clipPlane: { x: 0, y: 0, z: 1, w: -0.5 }, operations: [{ kind: "draw", batches: [batch] }] });
    commands.submit(); check(12, 7, [0, 0, 0, 255]);
    commands.addView({ viewport, clear, operations: [{ kind: "draw", batches: [batch] }] }); commands.submit(); check(4, 4, [255, 0, 0, 255]);
    commands.addView({ viewport, clear, clipPlane: { x: 0, y: 0, z: 0, w: -1 }, operations: [{ kind: "draw", batches: [] }] });
    commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 16, height: 16 }, green, picture); commands.submit(); check(4, 4, [0, 255, 0, 255]);
    commands.addView({ viewport, clear, clipPlane: { x: 0, y: 0, z: 0, w: -1 }, operations: [{ kind: "draw", batches: [] }] });
    commands.stretchRaw({ x: 0, y: 0, width: 16, height: 16 }, { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
      captureAfterBarrier: () => ({ upload: { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
        content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])) }, afterUiDraw: () => undefined }) });
    check(4, 4, [255, 255, 255, 255]);
    expect(() => commands.addView({ viewport, clear, clipPlane: { x: Number.NaN, y: 0, z: 0, w: 0 }, operations: [{ kind: "draw", batches: [] }] })).toThrow("clip plane");
  } finally { commands.close("discard"); target.close(); window?.close(); }
});
test("consuming submission retains SetColor across actual view insertion", () => {
  const f = fixture(); f.draw.setColor(red); f.draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, f.picture);
  f.commands.addView({ viewport: { x: 4, y: 4, width: 8, height: 8 }, clear: { stencil: false, color: null, depth: 1 }, operations: [{ kind: "draw", batches: [] }] });
  f.draw.drawPic({ x: 12, y: 12, width: 4, height: 4 }, f.picture);
  expect(f.recording.trace()).toHaveLength(0); expect(f.commands.submit()).toEqual({ commands: 4, views: 1, batches: 2 });
  const trace = f.recording.trace(); expect(trace).toHaveLength(3); expect(trace[2]?.batches[0]?.vertices[0]?.color).toEqual(red);
  expect(f.commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 }); expect(f.recording.trace()).toHaveLength(3); f.target.close();
});
test("queued diagnostic views own geometry, viewport, clear and state but retain image identity", () => {
  const f = fixture(), position = { x: 0, y: 0, z: 0, w: 1 }, color = { ...white };
  const vertices = [{ position, texCoord: { x: 0, y: 0 }, color }], indices = [0, 0, 0];
  const batch: DrawBatch = { texturing: "single", primitive: "triangles", vertices, indices, texture: { kind: "bind-image", image: f.texture }, state: UI_PICTURE_STATE };
  const viewport = { x: 0, y: 0, width: 16, height: 16 }, clear = { stencil: false, color, depth: 1 }, view: RenderView = { viewport, clear, operations: [{ kind: "draw", batches: [batch] }] };
  f.commands.addView(view); position.x = 9; color.x = 0; indices[0] = 7; viewport.width = 2; clear.depth = 0; vertices.length = 0;
  f.commands.submit(); const observed = f.recording.trace()[0];
  expect(observed?.state.viewport.width).toBe(16); expect(observed?.state.clear).toEqual({ stencil: false, color: white, depth: 1 });
  expect(observed?.batches[0]?.vertices[0]?.position.x).toBe(0); expect(observed?.batches[0]?.indices).toEqual([0, 0, 0]);
  const binding = observed?.batches[0]?.texture; if (binding?.kind !== "bind-image") throw new Error("Missing image binding");
  expect(binding.image).toBe(f.texture); expect(binding).not.toBe(batch.texture); f.target.close();
});
test("paired diagnostic views own both UV sets and bundle descriptors", () => {
  const f = fixture(), uv = { x: 0.25, y: 0.75 };
  const secondTexture = { binding: { kind: "bind-image", image: f.texture }, environment: "modulate" } satisfies Extract<DrawBatch, { texturing: "pair" }>["secondTexture"];
  const batch: DrawBatch = { texturing: "pair", primitive: "triangles", vertices: [{ position: { x: 0, y: 0, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, texCoord2: uv, color: white }], indices: [0, 0, 0], texture: { kind: "bind-image", image: f.texture }, secondTexture, state: UI_PICTURE_STATE };
  f.commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: null, depth: 1 }, operations: [{ kind: "draw", batches: [batch] }] }); uv.x = 42;
  f.commands.submit(); const snapshot = f.recording.trace()[0]?.batches[0]; if (snapshot?.texturing !== "pair") throw new Error("Missing paired batch");
  expect(snapshot.vertices[0]?.texCoord2).toEqual({ x: 0.25, y: 0.75 }); expect(snapshot.secondTexture).not.toBe(secondTexture);
  expect(snapshot.secondTexture.binding).not.toBe(secondTexture.binding); f.target.close();
});
test("actual CPU ordered submission restores full-target 2D after viewport scenes", () => {
  const f = fixture(); sequence(f.commands, f.picture); f.commands.submit(); verify(f.cpu.pixels); f.target.close();
});
test("empty submission preserves retained color without replaying the previous frame", () => {
  const f = fixture(); sequence(f.commands, f.picture); f.draw.setColor(red); f.commands.submit();
  expect(f.commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
  f.draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, f.picture); expect(f.commands.submit().batches).toBe(1);
  expect(f.recording.trace().at(-1)?.batches.at(-1)?.vertices[0]?.color).toEqual(red); f.target.close();
});
test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("one target executes identical CPU/GL viewport and 2D transitions", () => {
  const images = new RendererImageCatalog(), window = SdlWindow.open({ title: "Ordered draws", width: 16, height: 16, backend: "gl", hidden: true });
  const gl = new GlRenderer(window, images), cpu = new SoftwareRenderer(16, 16, images, gl.subpixelBits), target = new RenderTarget(images, [cpu, gl]);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  try {
    const texture = publishTexture(images, { name: "white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    publishTexture(images, { name: "tail", width: 1, height: 1, pixels: new Uint8Array(4), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: new SourceTessState(), runtime: createRendererSettings().runtime });
    sequence(commands, { kind: "image", name: "white", texture: { kind: "bind-image", image: texture }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } });
    commands.submit(); verify(cpu.pixels); verify(gl.readPixels());
  } finally { target.close(); window.close(); }
});
test("prepared views execute between pictures after awaited registration and retain native shader time", async () => {
  const f = fixture(); f.clock.now = 100;
  const definition = parseShaderScript("pic { { map $whiteimage rgbGen vertex } }")[0]; if (definition === undefined) throw new Error("Missing fixture shader");
  const finished = finishShader({ definition, lightmapIndex: -4, profile: f.settings.registrationProfile(), images: [{ kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image: f.texture } } } }] });
  const material = await new MaterialRegistry(async () => ({ definition, image: f.texture, whiteImage: f.texture, finished, defaulted: false, sky: null }), text => { throw new Error(text); }).register("pic", { kind: "picture" });
  const picture: PictureAsset = { kind: "material", name: "pic", material };
  f.draw.setColor(null); f.draw.drawPic({ x: 0, y: 0, width: 4, height: 4 }, picture);
  const seen: number[] = [];
  f.commands.addPreparedViews(() => {
    seen.push(f.tess.floatTime, f.tess.shaderTime, f.tess.numVertexes, f.recording.trace().flatMap(view => view.batches).length);
    f.tess.enterView({ origin: { x: 0, y: 0, z: 0 }, axis: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }], mirror: false }, 7, createRefdef()); f.clock.now = 5000;
    return [{ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: null, depth: 1 }, operations: [{ kind: "draw", batches: [] }] }];
  });
  f.draw.drawPic({ x: 8, y: 8, width: 4, height: 4 }, picture); await Promise.resolve(); f.clock.now = 2000;
  expect(f.clock.reads).toBe(0); expect(seen).toEqual([]); f.commands.submit();
  expect(seen).toEqual([2, 2, 4, 1]); expect(f.clock.reads).toBe(2); expect(f.tess.floatTime).toBe(5);
  expect(f.tess.shaderTime).toBe(2); expect(f.tess.numVertexes).toBe(8);
  f.commands.submit(); expect(f.clock.reads).toBe(2); expect(seen).toHaveLength(4); f.target.close();
});

test("queued SetColor preserves same-shader grouping and the source 1000-vertex overflow boundary", async () => {
  const f = fixture(), definition = parseShaderScript("pic { { map $whiteimage rgbGen vertex } }")[0];
  if (definition === undefined) throw new Error("Missing fixture shader");
  const finished = finishShader({ definition, lightmapIndex: -4, profile: f.settings.registrationProfile(), images: [{ kind: "loaded", tmu: 0,
    binding: { kind: "images", playback: { kind: "single", image: { image: f.texture } } } }] });
  const material = await new MaterialRegistry(async () => ({ definition, image: f.texture, whiteImage: f.texture, finished, defaulted: false, sky: null }), text => { throw new Error(text); }).register("pic", { kind: "picture" });
  const picture: PictureAsset = { kind: "material", name: "pic", material };
  for (let index = 0; index < 250; index++) {
    f.draw.setColor(index % 2 === 0 ? red : green); f.draw.drawPic({ x: 0, y: 0, width: 1, height: 1 }, picture);
  }
  expect(f.commands.submitFrame()).toEqual({ commands: 500, views: 0, batches: 2 });
  const batches = f.recording.trace().flatMap(view => view.batches);
  expect(batches.map(batch => batch.vertices.length)).toEqual([996, 4]);
  expect(batches[0]?.vertices[0]?.color).toEqual(red); expect(batches[0]?.vertices[4]?.color).toEqual(green);
  expect(batches[1]?.vertices[0]?.color).toEqual(green); expect(f.clock.reads).toBe(1); f.target.close();
});

test("source surface execution draws immediately without consuming queued views, entering a view, or finishing", () => {
  const f = fixture();
  let finishes = 0;
  const finish = f.cpu.finish.bind(f.cpu);
  f.cpu.finish = () => { finishes++; return finish(); };
  try {
    f.commands.addView({ viewport: { x: 0, y: 0, width: 8, height: 16 },
      clear: { stencil: false, color: green, depth: 1 }, operations: [] });
    f.commands.submit();
    f.commands.addView({ viewport: { x: 8, y: 0, width: 8, height: 16 },
      clear: { stencil: false, color: white, depth: 1 }, operations: [] });
    const batch: DrawBatch = { texturing: "single", primitive: "triangles", state: UI_PICTURE_STATE,
      texture: { kind: "bind-image", image: f.texture }, indices: [0, 1, 2, 0, 2, 3],
      vertices: [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(point => {
        const [x, y] = point;
        if (x === undefined || y === undefined) throw new Error("Missing source surface fixture position");
        return { position: { x, y, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: red };
      }) };
    f.target.executeSurfaceOperations([{ kind: "draw", batches: [batch] }]);
    expect(finishes).toBe(0); expect(f.clock.reads).toBe(0);
    expect(f.recording.trace()).toHaveLength(1);
    expect(Array.from(f.cpu.pixels.subarray((8 * 16 + 4) * 4, (8 * 16 + 5) * 4))).toEqual([255, 0, 0, 255]);
    expect(f.commands.submit()).toEqual({ commands: 1, views: 1, batches: 0 });
    expect(Array.from(f.cpu.pixels.subarray((8 * 16 + 12) * 4, (8 * 16 + 13) * 4))).toEqual([255, 255, 255, 255]);
    expect(f.recording.trace()).toHaveLength(2);
  } finally { f.target.close(); }
});

test("source surface execution requires a live claimed command owner", () => {
  const images = new RendererImageCatalog(), target = new RenderTarget(images, [new SoftwareRenderer(1, 1, images)]);
  try {
    expect(() => target.executeSurfaceOperations([])).toThrow("requires the target's command buffer");
    const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
      tess: new SourceTessState(), runtime: createRendererSettings().runtime });
    commands.close("require-empty");
    expect(() => target.executeSurfaceOperations([])).toThrow("command buffer is closed");
  } finally { target.close(); }
  expect(() => target.executeSurfaceOperations([])).toThrow("target is closed");
});

test("reentrant source surface execution poisons the actual target even if a producer catches it", () => {
  const f = fixture();
  try {
    f.commands.addPreparedViews(() => {
      expect(() => f.target.executeSurfaceOperations([])).toThrow("Reentrant render target operation");
      return [];
    });
    expect(() => f.commands.submit()).toThrow("Reentrant render target operation");
    expect(() => f.target.executeSurfaceOperations([])).toThrow("catalog is poisoned");
  } finally { f.target.close(); }
});

test("immediate source surfaces and queued draws share one cinematic consumption owner", () => {
  const f = fixture(), samples: number[] = [];
  let now = 1;
  const source = { image: f.texture, prepareAtExecution: () => {
    samples.push(now);
    return { upload: { image: f.texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
      content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])), dirty: true }, afterShaderUpload: () => undefined };
  } };
  const batch: DrawBatch = { texturing: "single", primitive: "triangles", state: UI_PICTURE_STATE,
    texture: { kind: "shader-cinematic", source }, indices: [0, 0, 0],
    vertices: [{ position: { x: 0, y: 0, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: white }] };
  try {
    f.commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 },
      clear: { stencil: false, color: null, depth: 1 }, operations: [{ kind: "draw", batches: [batch] }] });
    f.target.executeSurfaceOperations([{ kind: "draw", batches: [batch] }]);
    expect(samples).toEqual([1]); expect(f.recording.initialBatches).toHaveLength(1);
    now = 2;
    expect(f.commands.submit()).toEqual({ commands: 1, views: 1, batches: 1 });
    expect(samples).toEqual([1, 2]);
  } finally { f.target.close(); }
});

for (const placement of ["view", "before-view", "synchronous"]) {
  test(`${placement} surface state and source-stage inputs are copied before execution`, () => {
    const f = fixture(), observed: ImmediateViewOperation[] = [];
    const range: [number, number] = [0.2, 0.4], offset = { factor: 2, units: 3 };
    const cull: Extract<RenderStateOperation, { kind: "cull" }> = { kind: "cull", cull: "front" };
    const light = { kind: "sky-box-state", identityLight: 0.25 } satisfies RenderStateOperation;
    const indices: number[] = [], vertices: DrawBatch["vertices"] = [];
    const batch: DrawBatch = { texturing: "single", primitive: "triangles", vertices, indices,
      state: { ...UI_PICTURE_STATE, polygonOffset: offset }, texture: { kind: "bind-image", image: f.texture } };
    const operations: SurfaceViewOperation[] = [cull, { kind: "depth-range", range }, light,
      { kind: "polygon-offset", value: offset }, { kind: "source-stage", stage: { kind: "generic-single", stateBits: uiSourceStateBits, batch, scratch: [] } }, { kind: "polygon-offset", value: null }];
    const mutate = (): void => { range[0] = 1; range[1] = 1; offset.factor = 99; offset.units = 99;
      Reflect.set(cull, "cull", "back"); light.identityLight = 0.75; indices.push(7); operations.length = 0; };
    const immediate = f.cpu.drawImmediate.bind(f.cpu);
    f.cpu.drawImmediate = operation => { observed.push(operation); if (placement === "synchronous" && observed.length === 1) mutate(); return immediate(operation); };
    try {
      if (placement === "synchronous") f.target.executeSurfaceOperations(operations);
      else {
        f.commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: null, depth: 1 },
          ...(placement === "before-view" ? { beforeView: operations, operations: [] } : { operations }) });
        mutate(); expect(f.commands.submit()).toEqual({ commands: 1, views: 1, batches: 0 });
      }
      expect(observed).toEqual([{ kind: "cull", cull: "front" }, { kind: "depth-range", range: [0.2, 0.4] },
        { kind: "sky-box-state", identityLight: 0.25 }, { kind: "polygon-offset", value: { factor: 2, units: 3 } },
        { kind: "polygon-offset", value: null }]);
      const prepared = [...f.recording.initialBatches, ...f.recording.trace().flatMap(view => view.batches)];
      expect(prepared).toHaveLength(1); expect(prepared[0]?.indices).toEqual([]);
      expect(prepared[0]?.state.polygonOffset).toEqual({ factor: 2, units: 3 });
      expect(prepared[0]?.texture).toEqual({ kind: "bind-image", image: f.texture });
    } finally { f.target.close(); }
  });

  test(`${placement} rejects invalid state before any backend state is applied`, () => {
    const badCull: RenderStateOperation = { kind: "cull", cull: "none" }; Reflect.set(badCull, "cull", "invalid");
    const longRange: [number, number] = [0, 1]; longRange.push(2);
    const invalid: readonly RenderStateOperation[] = [badCull, { kind: "sky-box-state", identityLight: -0.1 },
      { kind: "sky-box-state", identityLight: Number.NaN }, { kind: "sky-box-state", identityLight: 1.1 },
      { kind: "polygon-offset", value: { factor: Number.MAX_VALUE, units: 0 } },
      { kind: "polygon-offset", value: { factor: 0, units: Infinity } }, { kind: "depth-range", range: [0, Infinity] },
      { kind: "depth-range", range: longRange }];
    for (const operation of invalid) {
      const f = fixture(); let calls = 0;
      const immediate = f.cpu.drawImmediate.bind(f.cpu);
      f.cpu.drawImmediate = value => { calls++; return immediate(value); };
      const operations: SurfaceViewOperation[] = [{ kind: "cull", cull: "back" }, operation];
      try {
        expect(() => {
          if (placement === "synchronous") f.target.executeSurfaceOperations(operations);
          else f.commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: null, depth: 1 },
            ...(placement === "before-view" ? { beforeView: operations, operations: [] } : { operations }) });
        }).toThrow();
        expect(calls).toBe(0); expect(f.recording.initialBatches).toHaveLength(0); expect(f.recording.trace()).toHaveLength(0);
      } finally { f.target.close(); }
    }
  });
}

test("source draws sample primitives after cinematic upload and each earlier backend while direct draws bypass it", () => {
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const images = new RendererImageCatalog(), first = new SoftwareRenderer(4, 4, images), second = new SoftwareRenderer(4, 4, images);
  const target = new RenderTarget(images, [first, second]), modes: number[] = [];
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: settings.runtime });
  const image = publishTexture(images, { name: "live primitive movie", width: 1, height: 1, pixels: new Uint8Array([255, 0, 0, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(images, { name: "live primitive binding guard", width: 1, height: 1, pixels: new Uint8Array(4),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  let uploads = 0;
  const source = { image, prepareAtExecution: () => ({ upload: { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
    content: new RgbaSnapshot(1, 1, new Uint8Array([0, 255, 0, 255])), dirty: true },
    afterShaderUpload: () => { uploads++; cvars.set("r_primitives", "1"); return undefined; } }) };
  const batch: DrawBatch = { texturing: "single", primitive: "triangles", state: UI_PICTURE_STATE,
    texture: { kind: "shader-cinematic", source }, indices: [0, 1, 2, 0, 2, 3],
    vertices: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }].map(position => ({
      position: { ...position, z: 0, w: 1 }, texCoord: { x: 0.5, y: 0.5 }, color: white,
    })) };
  const stage: SourceStageData = { kind: "generic-single", stateBits: uiSourceStateBits, batch,
    scratch: batch.vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0, y: 0 },
      rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0, y: 0 } })) };
  for (const backend of [first, second]) {
    const prepare = backend.prepareSourceGeometry.bind(backend);
    backend.prepareSourceGeometry = input => {
      const prepared = prepare(input);
      return { ...prepared, draw: primitives => { modes.push(primitives); prepared.draw(primitives);
        if (backend === first) cvars.set("r_primitives", "-1"); return undefined; } };
    };
  }
  const viewport = { x: 0, y: 0, width: 4, height: 4 }, clear = { stencil: false, color: red, depth: 1 };
  try {
    cvars.set("r_primitives", "2");
    commands.addView({ viewport, clear, operations: [{ kind: "source-stage", stage }] });
    cvars.set("r_primitives", "7");
    commands.submit();
    expect(uploads).toBe(1); expect(modes).toEqual([1, -1]);
    expect([...first.pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    expect([...second.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    commands.addView({ viewport, clear, operations: [{ kind: "draw", batches: [{ ...batch, texture: { kind: "bind-image", image } }] }] });
    commands.submit();
    expect(modes).toEqual([1, -1]);
    expect([...first.pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    expect(second.pixels).toEqual(first.pixels);
  } finally { commands.close("discard"); target.close(); }
});

test("queued source stages own retained scratch independently of their fast-path attributes", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(2, 2, images), target = new RenderTarget(images, [cpu]);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), cpu.capabilities);
  cvars.set("r_primitives", "3");
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: settings.runtime });
  const image = publishTexture(images, { name: "retained scratch UV", width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  publishTexture(images, { name: "retained scratch binding guard", width: 1, height: 1, pixels: new Uint8Array(4),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  const batch: DrawBatch = { texturing: "single", primitive: "triangles", state: UI_PICTURE_STATE, texture: { kind: "bind-image", image },
    indices: [0, 1, 2, 0, 2, 3], vertices: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }].map(position => ({
      position: { ...position, z: 0, w: 1 }, texCoord: { x: 0.25, y: 0.5 }, color: white,
    })) };
  const scratch = batch.vertices.map(vertex => ({ color: { ...vertex.color }, texCoord: { x: 0.75, y: 0.5 }, texCoord2: { x: 0, y: 0 },
    rawTexCoord: { ...vertex.texCoord }, rawTexCoord2: { x: 0, y: 0 } }));
  try {
    commands.addView({ viewport: { x: 0, y: 0, width: 2, height: 2 }, clear: { stencil: false, color: red, depth: 1 },
      operations: [{ kind: "source-stage", stage: { kind: "vertex-lit", stateBits: uiSourceStateBits, batch, scratch } }] });
    for (const cell of scratch) { cell.texCoord.x = 0.25; cell.color.y = 0; }
    commands.submit();
    expect([...cpu.pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  } finally { commands.close("discard"); target.close(); }
});

test("zero-index ordinary draws suppress execution while source stages run once through both actual backends", () => {
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Empty source stage fanout", width: 16, height: 16, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images), cpu = new SoftwareRenderer(16, 16, images, gl?.subpixelBits);
  if (gl !== null) gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const recording = new BatchRecordingBackend(cpu), target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
    tess: new SourceTessState(), runtime: createRendererSettings().runtime });
  try {
    const image = publishTexture(images, { name: "empty movie", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    publishTexture(images, { name: "empty sentinel", width: 1, height: 1, pixels: new Uint8Array(4),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    let samples = 0, uploads = 0;
    const source = { image, prepareAtExecution: () => { samples++; return { upload: { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
      content: new RgbaSnapshot(1, 1, new Uint8Array([0, 255, 0, 255])), dirty: true }, afterShaderUpload: () => { uploads++; return undefined; } }; } };
    const batch: DrawBatch = { texturing: "single", primitive: "triangles", state: UI_PICTURE_STATE,
      texture: { kind: "shader-cinematic", source }, indices: [], vertices: [] };
    commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: red, depth: 1 }, operations: [{ kind: "draw", batches: [batch] }] });
    expect(commands.submit()).toEqual({ commands: 1, views: 1, batches: 0 }); expect(samples).toBe(0); expect(uploads).toBe(0);
    expect(recording.trace()[0]?.batches).toHaveLength(0);
    commands.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: null, depth: 1 },
      operations: [{ kind: "source-stage", stage: { kind: "generic-single", stateBits: uiSourceStateBits, batch, scratch: [] } }] });
    expect(commands.submit()).toEqual({ commands: 1, views: 1, batches: 0 }); expect(samples).toBe(1); expect(uploads).toBe(1);
    expect(recording.trace()[1]?.batches).toHaveLength(1);
    expect([...cpu.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const picture: PictureAsset = { kind: "image", name: "retained movie", texture: { kind: "retain-current-texture" }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } };
    commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 16, height: 16 }, white, picture); commands.submit();
    expect([...cpu.pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    if (gl !== null) expect(gl.readPixels()).toEqual(cpu.pixels);
    expect(samples).toBe(1); expect(uploads).toBe(1);
  } finally { commands.close("discard"); target.close(); window?.close(); }
});

test("r_speeds reports before the next backend run and retains counts through mid-frame drains", async () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images, 8, 8), target = new RenderTarget(images, [cpu]);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), cpu.capabilities);
  const performance = new RendererPerformanceCounters(), tess = new SourceTessState(performance), output: string[] = [];
  const temporaryMemory = new HunkArena(4096, text => { throw new Error(text); });
  let now = 100;
  const commands = new RenderCommandBuffer(target, { clock: { milliseconds: () => 5000 }, performanceClock: { milliseconds: () => now },
    performance, temporaryMemory, tess, runtime: settings.runtime, identityLight: 1, print: text => { output.push(text); } });
  try {
    const image = publishTexture(images, { name: "performance white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const definition = parseShaderScript("pic { { map white rgbGen vertex } { map white blendFunc add rgbGen vertex } }")[0];
    if (definition === undefined) throw new Error("Missing performance fixture shader");
    const finished = finishShader({ definition, lightmapIndex: -4, profile: settings.registrationProfile(), images: [
      { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } },
      { kind: "loaded", tmu: 0, binding: { kind: "images", playback: { kind: "single", image: { image } } } },
    ] });
    const material = await new MaterialRegistry(async () => ({ definition, image, whiteImage: image, finished, defaulted: false, sky: null }),
      text => { throw new Error(text); }).register("pic", { kind: "picture" });
    expect(finished.numUnfoggedPasses).toBe(2);
    cvars.set("r_speeds", "1");
    cvars.set("r_measureOverdraw", "1");
    settings.beginOverdrawFrame(cpu.stencilBits, enabled => commands.setOverdrawMeasurement(enabled));
    performance.frontEnd.c_leafs = 5; performance.frontEndMsec = 9;
    commands.draw2D("pixels").fillRect({ x: 0, y: 0, width: 16, height: 16 }, white, { kind: "material", name: "pic", material });
    expect(commands.submitFrame(() => {
      expect(output).toEqual(["0/0 shaders/surfs 5 leafs 0 verts 0/0 tris 0.00 mtex 0.00 dc\n"]);
      expect([...cpu.pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
      now += 7;
    })).toEqual({ commands: 3, views: 0, batches: 2 });
    expect(commands.frameTimings).toEqual({ frontEndMsec: 9, backEndMsec: 7 });
    expect(performance.frontEndMsec).toBe(0); expect(performance.backEnd.msec).toBe(0);
    expect(performance.backEnd.c_shaders).toBe(1); expect(performance.backEnd.c_vertexes).toBe(4);
    expect(performance.backEnd.c_indexes).toBe(6); expect(performance.backEnd.c_totalIndexes).toBe(12);
    expect(performance.backEnd.c_overDraw).toBe(512); expect(temporaryMemory.memoryRemaining()).toBe(4096);
    performance.frontEnd.c_leafs = 11;
    commands.submit();
    expect(output).toHaveLength(1); expect(performance.frontEnd.c_leafs).toBe(11); expect(performance.backEnd.c_shaders).toBe(1);
    commands.submitFrame();
    expect(output[1]).toBe("1/0 shaders/surfs 11 leafs 4 verts 2/4 tris 0.00 mtex 2.00 dc\n");
    cvars.set("r_measureOverdraw", "0");
    settings.beginOverdrawFrame(cpu.stencilBits, enabled => commands.setOverdrawMeasurement(enabled));
    cvars.set("r_speeds", "0"); performance.frontEnd.c_leafs = 8; performance.backEnd.c_surfaces = 3;
    commands.submitFrame();
    expect(output).toHaveLength(2);
    const empty = new RendererPerformanceCounters();
    expect(performance.frontEnd).toEqual(empty.frontEnd); expect(performance.backEnd).toEqual(empty.backEnd);
  } finally { commands.close("discard"); target.close(); }
});

test("source performance modes preserve exact fields, conditional dlight output, rounding and retained view state", () => {
  const performance = new RendererPerformanceCounters(), front = performance.frontEnd, back = performance.backEnd, output: string[] = [];
  let imageReads = 0;
  const report = (mode: number): void => performance.report(mode, 16, 16, () => { imageReads++; return 1_125_000; }, text => { output.push(text); });
  Object.assign(back, { c_shaders: 4, c_surfaces: 7, c_vertexes: 10, c_indexes: 8, c_totalIndexes: 11, c_overDraw: 288 });
  front.c_leafs = 3; performance.viewCluster = -1; performance.zFar = 2.5; performance.frontEndMsec = 8;
  report(1);
  expect(output.pop()).toBe("4/7 shaders/surfs 3 leafs 10 verts 2/3 tris 1.12 mtex 1.12 dc\n");
  Object.assign(front, { c_sphere_cull_patch_in: 1, c_sphere_cull_patch_clip: 2, c_sphere_cull_patch_out: 3,
    c_box_cull_patch_in: 4, c_box_cull_patch_clip: 5, c_box_cull_patch_out: 6,
    c_sphere_cull_md3_in: 7, c_sphere_cull_md3_clip: 8, c_sphere_cull_md3_out: 9,
    c_box_cull_md3_in: 10, c_box_cull_md3_clip: 11, c_box_cull_md3_out: 12 });
  report(2);
  expect(output.splice(0)).toEqual(["(patch) 1 sin 2 sclip  3 sout 4 bin 5 bclip 6 bout\n", "(md3) 7 sin 8 sclip  9 sout 10 bin 11 bclip 12 bout\n"]);
  report(3); expect(output.pop()).toBe("viewcluster: -1\n");
  report(4); expect(output).toHaveLength(0);
  front.c_dlightSurfaces = 3; front.c_dlightSurfacesCulled = 2; back.c_dlightVertexes = 12; back.c_dlightIndexes = 8;
  report(4); expect(output.pop()).toBe("dlight srf:3  culled:2  verts:12  tris:2\n");
  report(5); expect(output.pop()).toBe("zFar: 2\n");
  performance.zFar = 3.5; report(5); expect(output.pop()).toBe("zFar: 4\n");
  report(6); expect(output.pop()).toBe("flare adds:0 tests:0 renders:0\n");
  back.c_vertexes = 4; front.c_leafs = 2; report(7);
  expect(output).toHaveLength(0); expect(imageReads).toBe(1);
  expect(performance.frontEnd).toBe(front); expect(performance.backEnd).toBe(back);
  const empty = new RendererPerformanceCounters();
  expect(front).toEqual(empty.frontEnd); expect(back).toEqual(empty.backEnd);
  expect(performance.viewCluster).toBe(-1); expect(performance.zFar).toBe(3.5); expect(performance.frontEndMsec).toBe(8);
});

test("raw r_speeds timing brackets upload after the finish barrier and prints before 2D drawing", () => {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(16, 16, images), target = new RenderTarget(images, [cpu]);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), cpu.capabilities);
  const tess = new SourceTessState(), events: string[] = [];
  let now = 10;
  const commands = new RenderCommandBuffer(target, { clock: { milliseconds: () => { events.push("2D clock"); return 5000; } },
    performanceClock: { milliseconds: () => { events.push(`timer ${now}`); return now; } },
    tess, runtime: settings.runtime, identityLight: 1, print: text => {
      expect(tess.is2D).toBe(false); expect([...cpu.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
      events.push(text);
    } });
  try {
    const image = publishTexture(images, { name: "performance movie", width: 1, height: 1, pixels: new Uint8Array(4),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    publishTexture(images, { name: "performance movie tail", width: 1, height: 1, pixels: new Uint8Array(4),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const finish = cpu.finish.bind(cpu);
    cpu.finish = () => { finish(); events.push("finish"); };
    cvars.set("r_speeds", "4");
    commands.stretchRaw({ x: 0, y: 0, width: 16, height: 16 }, { image, sourceWidth: 1, sourceHeight: 1,
      uploadWidth: 1, uploadHeight: 1, dirty: true, captureAfterBarrier: () => {
        events.push("capture"); now = 18;
        return { upload: { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
          content: new RgbaSnapshot(1, 1, new Uint8Array([255, 0, 0, 255])) }, afterUiDraw: () => { events.push("drawn"); } };
      } });
    expect(events).toEqual(["timer 10", "timer 10", "finish", "timer 10", "capture", "timer 18",
      "qglTexSubImage2D 1, 1: 8 msec\n", "2D clock", "drawn"]);
    expect([...cpu.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(tess.performance.backEnd.msec).toBe(0);
  } finally { commands.close("discard"); target.close(); }
});
