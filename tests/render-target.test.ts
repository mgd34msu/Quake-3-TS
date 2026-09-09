import { expect, test } from "bun:test";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { PreparedBackendDraw, PreparedBackendSourceDraw, PreparedBackendRawDraw, RawGeometry, RenderViewState } from "../src/render/commands.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import type { PreparedUiRawCall, ShaderCinematicSource } from "../src/render/cinematic-command.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { UI_PICTURE_STATE } from "../src/render/draw2d.ts";
import type { DrawBatch, SourceGeometryAllocation, SourceStageData } from "../src/render/types.ts";
import type { ImagePicture } from "../src/render/picture-material.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";

const white = { x: 1, y: 1, z: 1, w: 1 }, black = { x: 0, y: 0, z: 0, w: 0 };
const runtime = { smpRequested: false, skipBackEnd: false, speeds: 0, clear: false, measureOverdraw: 0, showImages: 0, debugSort: 0, showTris: 0, showNormals: 0, primitives: 0, finish: 0, logFile: 0, lightmap: false, vertexLighting: false, polygonOffset: { factor: -1, units: -2 } };
class ObservedBackend extends BatchRecordingBackend {
  effect: (event: string) => undefined = () => undefined;
  constructor(cpu: SoftwareRenderer, readonly name: string, readonly events: string[]) { super(cpu); }
  private event(name: string): void { const event = `${this.name}:${name}`; this.events.push(event); this.effect(event); }
  override beginView(view: RenderViewState): undefined { this.event("view"); return super.beginView(view); }
  override prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    this.event("prepare"); const draw = super.prepareGeometry(batch);
    return { begin: () => { this.event("begin"); draw.begin(); },
      applyTexture: (unit, operation) => { this.event(`slot${unit}`); draw.applyTexture(unit, operation); },
      draw: () => { this.event("draw"); draw.draw(); }, cleanup: () => { this.event("cleanup"); draw.cleanup(); } };
  }
  override prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    this.event("prepare"); const draw = super.prepareSourceGeometry(stage, allocation);
    return { begin: () => { this.event("begin"); draw.begin(); },
      prepareTexture: unit => draw.prepareTexture(unit),
      applyTexture: (unit, operation) => { this.event(`slot${unit}`); draw.applyTexture(unit, operation); },
      finishTextures: () => draw.finishTextures(),
      draw: primitives => { this.event("draw"); draw.draw(primitives); }, cleanup: () => { this.event("cleanup"); draw.cleanup(); } };
  }
  override prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    this.event("raw-prepare"); const draw = super.prepareRawGeometry(geometry);
    return { uploadCurrent: upload => { this.event("raw-upload"); draw.uploadCurrent(upload); },
      draw: () => { this.event("raw-draw"); draw.draw(); } };
  }
  override finish(): undefined { this.event("finish"); return super.finish(); }
  override close(): undefined { this.event("close"); return super.close(); }
}
function image(images: RendererImageCatalog, name: string): RendererImage {
  return publishTexture(images, { name, width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "clamp", filter: "linear" }, registrationUnit: 0 });
}
function fixture(width = 16, height = 16) {
  const images = new RendererImageCatalog(), events: string[] = [];
  const first = new ObservedBackend(new SoftwareRenderer(width, height, images), "a", events);
  const second = new ObservedBackend(new SoftwareRenderer(width, height, images), "b", events);
  const target = new RenderTarget(images, [first, second]);
  const texture = image(images, "white"), scratch = image(images, "scratch");
  const tess = new SourceTessState(), clock = { time: 0, reads: 0 };
  const queue = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => { events.push("clock"); clock.reads++; return clock.time; } }, performanceClock: { milliseconds: () => clock.time }, identityLight: 1, tess, runtime });
  const picture: ImagePicture = { kind: "image", name: "white", texture: { kind: "bind-image", image: texture }, state: UI_PICTURE_STATE, color: { rgb: "vertex", alpha: "vertex" } };
  return { images, first, second, target, queue, picture, texture, scratch, tess, clock, events };
}
function triangle(texture: DrawBatch["texture"]): DrawBatch {
  return { texturing: "single", primitive: "triangles", texture, state: UI_PICTURE_STATE, indices: [0, 1, 2],
    vertices: [{ position: { x: -1, y: -1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: white },
      { position: { x: 1, y: -1, z: 0, w: 1 }, texCoord: { x: 1, y: 0 }, color: white },
      { position: { x: 0, y: 1, z: 0, w: 1 }, texCoord: { x: 0, y: 1 }, color: white }] };
}
function add(queue: RenderCommandBuffer, batch: DrawBatch): void {
  queue.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, color: black, depth: 1 }, operations: [{ kind: "draw", batches: [batch] }] });
}
function movie(texture: RendererImage, label: string, events: string[]): ShaderCinematicSource {
  return { image: texture, prepareAtExecution: () => {
    events.push(`${label}:prepare`);
    return { upload: { image: texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
      dirty: true, content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])) },
    afterShaderUpload: () => { events.push(`${label}:complete`); } };
  } };
}
function raw(texture: RendererImage, events: string[], bytes: Uint8Array, size = 1): PreparedUiRawCall {
  return { image: texture, sourceWidth: size, sourceHeight: size, uploadWidth: size, uploadHeight: size, dirty: true,
    captureAfterBarrier: () => { events.push("raw:capture"); return { upload: { image: texture, sourceWidth: size, sourceHeight: size,
      uploadWidth: size, uploadHeight: size, dirty: true, content: new RgbaSnapshot(size, size, bytes) },
    afterUiDraw: () => { events.push("raw:complete"); } }; } };
}

test("one target owns one private session and lifetime queue", () => {
  const f = fixture();
  expect(() => f.images.openSession()).toThrow("active session");
  expect(() => new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: f.tess, runtime })).toThrow("lifetime");
  f.queue.close("require-empty");
  expect(() => new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: f.tess, runtime })).toThrow("lifetime");
  f.target.close(); f.target.close(); expect(f.events.filter(event => event.endsWith(":close"))).toEqual(["a:close", "b:close"]);
  expect(() => f.queue.submit()).toThrow("closed");
  const cpu = new SoftwareRenderer(16, 16, f.images), fresh = new RenderTarget(f.images, [cpu]); fresh.close();
});

test("profiles share BSS-zero executed color, including color-only and empty frames", () => {
  const f = fixture(1280, 720), pixels = f.queue.draw2D("pixels"), cg = f.queue.draw2D("stretch-640"), ui = f.queue.draw2D("base-ui-640");
  expect(f.queue.draw2D("pixels")).toBe(pixels); expect(f.queue.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
  pixels.drawPic({ x: 0, y: 0, width: 1, height: 1 }, f.picture); f.queue.submit();
  expect(f.first.trace()[0]?.batches[0]?.vertices[0]?.color).toEqual(black);
  cg.setColor({ x: 0.5, y: 0.25, z: 1, w: 0.5 }); expect(f.queue.submit().batches).toBe(0); f.tess.endFrame();
  expect(f.queue.submit().commands).toBe(0);
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  expect(cg.adjust(rect)).toEqual({ x: 20, y: 30, width: 60, height: 60 });
  expect(ui.adjust(rect)).toEqual({ x: 175, y: 30.000001907348633, width: 45.000003814697266, height: 60.000003814697266 });
  cg.drawPic(rect, f.picture); ui.drawPic(rect, f.picture); pixels.drawPic(rect, f.picture); f.queue.submit();
  const batches = f.first.trace().flatMap(view => view.batches).slice(1);
  expect(batches.map(batch => batch.vertices[0]?.color)).toEqual(Array.from({ length: 3 }, () => ({ x: 127 / 255, y: 63 / 255, z: 1, w: 127 / 255 })));
  f.target.close();
});

test("ordinary StretchPic retains its external projection guard across mid-frame submits", () => {
  const f = fixture(), draw = f.queue.draw2D("pixels"), rect = { x: 0, y: 0, width: 1, height: 1 };
  f.clock.time = 2000; draw.setColor(null); draw.drawPic(rect, f.picture); f.queue.submit();
  f.clock.time = 5000; draw.drawPic(rect, f.picture); f.queue.submit();
  expect(f.clock.reads).toBe(1); expect(f.tess.floatTime).toBe(2);
  f.tess.endFrame(); draw.drawPic(rect, f.picture); f.queue.submit();
  expect(f.clock.reads).toBe(2); expect(f.tess.floatTime).toBe(5); f.target.close();
});

test("paired slots prepare once, complete after both uploads, then advance to slot1", () => {
  const f = fixture(), first = movie(f.texture, "m0", f.events), second = movie(f.scratch, "m1", f.events);
  const base = triangle({ kind: "shader-cinematic", source: first });
  const pair: DrawBatch = { ...base, texturing: "pair", vertices: base.vertices.map(vertex => ({ ...vertex, texCoord2: { ...vertex.texCoord } })),
    secondTexture: { binding: { kind: "shader-cinematic", source: second }, environment: "modulate" } };
  add(f.queue, pair); expect(f.events).toEqual([]); f.queue.submit();
  expect(f.events).toEqual(["a:view", "b:view", "a:prepare", "b:prepare", "a:begin", "b:begin", "m0:prepare", "a:slot0", "b:slot0", "m0:complete", "m1:prepare", "a:slot1", "b:slot1", "m1:complete", "a:draw", "b:draw", "a:cleanup", "b:cleanup"]);
  f.events.length = 0; expect(f.queue.submit()).toEqual({ commands: 0, views: 0, batches: 0 }); expect(f.events).toEqual([]); f.target.close();
});

test("all backend static validation and ownership precede movie preparation", () => {
  for (const mode of ["indices", "second-backend", "foreign-image"]) {
    const f = fixture(), source = movie(mode === "foreign-image" ? image(new RendererImageCatalog(), "foreign") : f.texture, "movie", f.events);
    const base = triangle({ kind: "shader-cinematic", source });
    if (mode === "second-backend") f.second.effect = event => { if (event === "b:prepare") throw new Error("backend capability"); };
    add(f.queue, mode === "indices" ? { ...base, indices: [0, 1, 99] } : base);
    expect(() => f.queue.submit()).toThrow(); expect(f.events).not.toContain("movie:prepare");
    expect(() => image(f.images, "later")).toThrow("poisoned"); f.target.close();
  }
});

test("empty and no-frame slots preserve source no-prepare and no-completion behavior", () => {
  const f = fixture(), source = movie(f.texture, "empty", f.events);
  add(f.queue, { ...triangle({ kind: "shader-cinematic", source }), indices: [] }); f.queue.submit();
  expect(f.events).toEqual(["a:view", "b:view", "a:prepare", "b:prepare"]);
  f.events.length = 0;
  const noFrame: ShaderCinematicSource = { image: f.texture, prepareAtExecution: () => { f.events.push("no-frame"); return null; } };
  add(f.queue, triangle({ kind: "shader-cinematic", source: noFrame })); f.queue.submit();
  expect(f.events.filter(event => event === "no-frame")).toHaveLength(1);
  expect(f.first.trace().at(-1)?.batches).toHaveLength(1); f.target.close();
});

test("swallowed command, close, and image reentry poison before any upload", () => {
  for (const mode of ["command", "close", "create", "new-buffer"]) {
    const f = fixture();
    const source: ShaderCinematicSource = { image: f.texture, prepareAtExecution: () => {
      try {
        if (mode === "command") f.queue.setColor(null);
        else if (mode === "close") f.target.close();
        else if (mode === "create") image(f.images, "reentry");
        else new RenderCommandBuffer(f.target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: f.tess, runtime });
      } catch { f.events.push("caught"); }
      return null;
    } };
    add(f.queue, triangle({ kind: "shader-cinematic", source })); expect(() => f.queue.submit()).toThrow();
    expect(f.events).toContain("caught"); expect(f.events).not.toContain("a:slot0"); expect(() => f.queue.submit()).toThrow("poisoned"); f.target.close();
  }
});

test("getter-caught reentry is checked before invoking the returned callback", () => {
  const f = fixture();
  const source: ShaderCinematicSource = { image: f.texture, get prepareAtExecution() {
    try { f.queue.submit(); } catch { f.events.push("caught"); }
    return () => { f.events.push("must-not-call"); return null; };
  } };
  add(f.queue, triangle({ kind: "shader-cinematic", source })); expect(() => f.queue.submit()).toThrow();
  expect(f.events).not.toContain("must-not-call"); f.target.close();
});

test("partial mirrored upload does not complete or requeue its suffix", () => {
  const f = fixture(); f.second.effect = event => { if (event === "b:slot0") throw new Error("upload failure"); };
  add(f.queue, triangle({ kind: "shader-cinematic", source: movie(f.texture, "movie", f.events) }));
  f.queue.addPreparedViews(() => { f.events.push("suffix"); return []; });
  expect(() => f.queue.submit()).toThrow("upload failure"); expect(f.events).toContain("a:slot0");
  expect(f.events).not.toContain("movie:complete"); expect(f.events).not.toContain("a:draw"); expect(f.events).not.toContain("suffix");
  expect(() => f.queue.submit()).toThrow("poisoned"); f.target.close();
});

test("source scratch identity is captured before preparation and cannot be replaced by another owned image", () => {
  const f = fixture();
  const source: ShaderCinematicSource = { image: f.texture, prepareAtExecution: () => ({
    upload: { image: f.scratch, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
      content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])) },
    afterShaderUpload: () => { f.events.push("wrong-completion"); },
  }) };
  add(f.queue, triangle({ kind: "shader-cinematic", source }));
  expect(() => f.queue.submit()).toThrow("scratch identity"); expect(f.events).not.toContain("a:slot0"); expect(f.events).not.toContain("wrong-completion"); f.target.close();
});

test("a swallowed completion reentry stops the next slot and partial draw failure stays terminal", () => {
  for (const mode of ["completion", "draw"]) {
    const f = fixture();
    const source: ShaderCinematicSource = { image: f.texture, prepareAtExecution: () => ({
      upload: { image: f.texture, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: false,
        content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])) },
      afterShaderUpload: () => { f.events.push("complete"); if (mode === "completion") { try { f.queue.close("discard"); } catch { f.events.push("caught"); } } },
    }) };
    if (mode === "draw") f.second.effect = event => { if (event === "b:draw") throw new Error("draw failure"); };
    add(f.queue, triangle({ kind: "shader-cinematic", source })); expect(() => f.queue.submit()).toThrow();
    expect(f.events).toContain("complete"); expect(f.events).not.toContain("a:cleanup");
    expect(f.first.trace()[0]?.batches).toHaveLength(mode === "draw" ? 1 : 0); f.target.close();
  }
});

test("raw drains genuine older shader work before capturing selected backing bytes", () => {
  const f = fixture(), bytes = new Uint8Array([4, 0, 0, 255]);
  const call = raw(f.texture, f.events, bytes);
  const source: ShaderCinematicSource = { image: f.texture, prepareAtExecution: () => { bytes[0] = 201; f.events.push("queued:mutate"); return null; } };
  add(f.queue, triangle({ kind: "shader-cinematic", source }));
  f.queue.setColor({ x: 1, y: 0, z: 0, w: 1 });
  f.clock.time = 1000; f.queue.stretchRaw({ x: 1.9, y: 2.9, width: 8.9, height: 9.9 }, call);
  expect(f.events.indexOf("queued:mutate")).toBeLessThan(f.events.indexOf("a:finish"));
  expect(f.events.indexOf("b:finish")).toBeLessThan(f.events.indexOf("raw:capture"));
  expect(f.events.slice(-6)).toEqual(["a:raw-upload", "b:raw-upload", "clock", "a:raw-draw", "b:raw-draw", "raw:complete"]);
  expect(f.first.rawDraws[0]?.rect).toEqual({ x: 1, y: 2, width: 8, height: 9 });
  expect(f.first.delegate instanceof SoftwareRenderer && f.first.delegate.pixels[(3 * 16 + 2) * 4]).toBe(201);
  f.clock.time = 2000; f.queue.stretchRaw({ x: 0, y: 0, width: 1, height: 1 }, raw(f.texture, f.events, bytes));
  expect(f.clock.reads).toBe(2); expect(f.tess.floatTime).toBe(2);
  f.queue.draw2D("pixels").drawPic({ x: 0, y: 0, width: 1, height: 1 }, f.picture); f.queue.submit();
  expect(f.first.trace().at(-1)?.batches.at(-1)?.vertices[0]?.color).toEqual({ x: 1, y: 0, z: 0, w: 1 }); f.target.close();
});

test("raw POT error occurs after older commands and finish but before capture", () => {
  const f = fixture(); f.queue.addPreparedViews(() => { f.events.push("older"); return []; });
  expect(() => f.queue.stretchRaw({ x: 0, y: 0, width: 1, height: 1 }, raw(f.texture, f.events, new Uint8Array(36), 3))).toThrow("power of 2");
  expect(f.events).toEqual(["older", "a:finish", "b:finish"]); f.target.close();
});

test("private pre-barrier resampling bytes remain independent of the queued decoder mutation", () => {
  const f = fixture(), decoder = new Uint8Array([4, 0, 0, 255]), resampled = new Uint8Array(decoder);
  const call = raw(f.texture, f.events, resampled);
  const source: ShaderCinematicSource = { image: f.texture, prepareAtExecution: () => { decoder[0] = 201; return null; } };
  add(f.queue, triangle({ kind: "shader-cinematic", source }));
  f.queue.stretchRaw({ x: 0, y: 0, width: 16, height: 16 }, call);
  expect(f.first.delegate instanceof SoftwareRenderer && f.first.delegate.pixels[0]).toBe(4);
  expect(decoder[0]).toBe(201); f.target.close();
});

test("raw metadata and integer-range failures reject before unsafe uploads", () => {
  for (const mode of ["range", "capture"]) {
    const f = fixture(), prepared = raw(f.texture, f.events, new Uint8Array([255, 255, 255, 255]));
    const call: PreparedUiRawCall = mode === "capture" ? { ...prepared, captureAfterBarrier: () => ({
      upload: { image: f.scratch, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
        content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])) }, afterUiDraw: () => undefined,
    }) } : prepared;
    expect(() => f.queue.stretchRaw({ x: mode === "range" ? 0x80000000 : 0, y: 0, width: 1, height: 1 }, call)).toThrow();
    expect(f.events).not.toContain("a:raw-upload"); if (mode === "range") expect(f.events).not.toContain("a:finish"); f.target.close();
  }
});

test("a prepared raw capability is consumed once and cannot drain or complete again", () => {
  const f = fixture(), call = raw(f.texture, f.events, new Uint8Array([255, 255, 255, 255]));
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  f.queue.stretchRaw(rect, call); f.events.length = 0;
  f.queue.addPreparedViews(() => { f.events.push("suffix"); return []; });
  expect(() => f.queue.stretchRaw(rect, call)).toThrow("already consumed");
  expect(f.events).toEqual([]); f.target.close();
});

test("registration does not submit pending views and target close discards them", () => {
  const f = fixture(); f.queue.addPreparedViews(() => { f.events.push("deferred"); return []; });
  image(f.images, "late"); expect(f.events).toEqual([]);
  expect(() => f.queue.close("require-empty")).toThrow("pending");
  f.target.close(); expect(f.events).toEqual(["a:close", "b:close"]); expect(() => f.queue.submit()).toThrow("closed");
});

test("frontend capture rechecks lifetime before publishing after a closing getter", () => {
  for (const mode of ["color", "picture", "view"]) {
    const f = fixture();
    const closing = { get x() { f.queue.close("discard"); return 0; }, y: 0, z: 0, w: 1 };
    if (mode === "color") expect(() => f.queue.setColor(closing)).toThrow("closed");
    else if (mode === "picture") expect(() => f.queue.draw2D("pixels").drawPic({ get x() { f.queue.close("discard"); return 0; }, y: 0, width: 1, height: 1 }, f.picture)).toThrow("closed");
    else expect(() => f.queue.addView({ viewport: { x: 0, y: 0, width: 16, height: 16 }, clear: { stencil: false, depth: 1, color: closing }, operations: [{ kind: "draw", batches: [] }] })).toThrow("closed");
    expect(f.first.trace()).toHaveLength(0); f.target.close();
  }
});

test("caught reentry during teardown poisons the catalog and still closes both devices", () => {
  const f = fixture(); f.first.effect = event => {
    if (event === "a:close") { try { image(f.images, "during-close"); } catch { f.events.push("caught"); } }
  };
  expect(() => f.target.close()).toThrow("Reentrant"); expect(f.events).toContain("b:close");
  expect(() => f.images.openSession()).toThrow("poisoned"); f.target.close();
});
