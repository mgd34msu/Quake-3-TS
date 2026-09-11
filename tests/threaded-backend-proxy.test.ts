// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import { RenderTarget } from "../src/render/commands.ts";
import type { DrawBatch, SourceStageData } from "../src/render/types.ts";
import { createThreadedBackendRuntime, createWorkerGlLogging, ThreadedRendererBackend } from "../src/render/threaded-backend-proxy.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { GlCallLogging } from "../src/render/gl/logging.ts";
import type { RenderThreadRuntime } from "../src/render/threaded-backend.ts";
import { ThreadedBackend } from "../src/render/threaded-backend.ts";
import { decodeBatch, decodeImmediate, decodeStage, wireInteger, wireRecord, wireString } from "../src/render/threaded-backend-protocol.ts";

function fixture() {
  const images = new RendererImageCatalog();
  const frames: Uint8Array[] = [];
  const runtime = createThreadedBackendRuntime({ kind: "cpu", width: 4, height: 4, subpixelBits: 8, stencilBits: 8, alphaBits: 8,
    textureFilter: images.textureFilter }, payload => {
    const message = wireRecord(payload);
    if (message["kind"] === "backend-cpu-frame" && message["pixels"] instanceof Uint8Array) { frames.push(new Uint8Array(message["pixels"])); return undefined; }
    throw new Error("Unexpected host callback");
  }, () => ({ description: null, dispatch: () => { throw new Error("No source command submitted in direct backend test"); }, close: () => undefined }));
  const invoke = (payload: unknown): unknown => structuredClone(runtime.dispatch(structuredClone(payload)));
  const proxy = new ThreadedRendererBackend({ call: invoke, callbackCall: invoke, synchronize: () => undefined, close: () => runtime.close() }, images, runtime.description,
    () => { throw new Error("Unexpected cinematic"); });
  const target = new RenderTarget(images, [proxy]);
  const image = images.create({ name: "white", sourceWidth: 1, sourceHeight: 1, mipmap: false, internalFormat: "rgba8", registrationUnit: 0,
    levels: [{ width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]) }], sampling: { wrap: "repeat", filter: "nearest" } });
  const batch: DrawBatch = { primitive: "triangles", texturing: "single", indices: [0, 1, 2], texture: { kind: "bind-image", image },
    state: { blend: { source: "one", destination: "zero" }, depthTest: "less-equal", depthWrite: true, alphaTest: "none", cull: "none" },
    vertices: [
      { position: { x: -1, y: -1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } },
      { position: { x: 1, y: -1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } },
      { position: { x: -1, y: 1, z: 0, w: 1 }, texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } },
    ] };
  return { images, image, proxy, target, runtime, batch, frames };
}

test("actual CPU backend receives resources, owned prepared geometry, draw phases and readback", () => {
  const f = fixture();
  try {
    f.proxy.beginView({ viewport: { x: 0, y: 0, width: 4, height: 4 }, clear: { color: { x: 0, y: 0, z: 1, w: 1 }, depth: 1, stencil: true } });
    const draw = f.proxy.prepareGeometry(f.batch);
    draw.begin(); draw.applyTexture(0, { kind: "bind-image", image: f.image }); draw.draw(); draw.cleanup();
    const pixels = f.proxy.readPixels();
    expect([...pixels.subarray(12 * 4, 12 * 4 + 4)]).toEqual([255, 0, 0, 255]);
    expect([...pixels.subarray(3 * 4, 3 * 4 + 4)]).toEqual([0, 0, 255, 255]);
    expect(f.proxy.readDepthPixel(0, 0)).toBe(0.5);
    pixels.fill(77);
    expect(f.proxy.readPixels()[48]).toBe(255);
    f.proxy.present(); expect(f.frames).toHaveLength(1); expect(f.frames[0]).toEqual(f.proxy.readPixels());
    expect(() => draw.draw()).toThrow("Unknown prepared backend draw");
  } finally { f.target.close(); }
});

test("source stage phases and immediate state execute on retained CPU backend", () => {
  const f = fixture();
  try {
    f.proxy.beginView({ viewport: { x: 0, y: 0, width: 4, height: 4 }, clear: { color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1, stencil: true } });
    if (f.batch.primitive !== "triangles" || f.batch.texturing !== "single") throw new Error("Expected single triangle fixture");
    const stage: SourceStageData = { kind: "generic-single", batch: f.batch, stateBits: 0x100,
      scratch: f.batch.vertices.map(vertex => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: { x: 0, y: 0 }, rawTexCoord: vertex.texCoord, rawTexCoord2: { x: 0, y: 0 } })) };
    f.proxy.drawImmediate({ kind: "depth-range", range: [0.2, 0.6] });
    const prepared = f.proxy.prepareSourceGeometry(stage, { kind: "standalone" });
    prepared.begin(); prepared.prepareTexture(0); prepared.applyTexture(0, { kind: "bind-image", image: f.image }); prepared.finishTextures(); prepared.draw(2); prepared.cleanup();
    expect(f.proxy.readPixels()[48]).toBe(255);
    const stencil = new Uint8Array(16); f.proxy.readStencilOverdraw(stencil); expect(stencil).toEqual(new Uint8Array(16));
    f.proxy.clearColorBuffer(); expect([...f.proxy.readPixels().subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  } finally { f.target.close(); }
});

test("paired texture draws preserve both bindings and own captured vertex attributes", () => {
  const f = fixture();
  try {
    const second = f.images.create({ name: "second", sourceWidth: 1, sourceHeight: 1, mipmap: false, internalFormat: "rgba8", registrationUnit: 0,
      levels: [{ width: 1, height: 1, pixels: new Uint8Array([20, 80, 140, 255]) }], sampling: { wrap: "repeat", filter: "nearest" } });
    f.proxy.beginView({ viewport: { x: 0, y: 0, width: 4, height: 4 }, clear: { color: { x: 0, y: 0, z: 0, w: 1 }, depth: 1, stencil: true } });
    const color = { x: 1, y: 1, z: 1, w: 1 };
    const batch: DrawBatch = { ...f.batch, texturing: "pair", vertices: f.batch.vertices.map(v => ({ ...v, color, texCoord2: { x: 0, y: 0 } })),
      secondTexture: { binding: { kind: "bind-image", image: second }, environment: "modulate" } };
    const prepared = f.proxy.prepareGeometry(batch);
    color.x = 0; color.y = 0; color.z = 0;
    prepared.begin(); prepared.applyTexture(0, { kind: "bind-image", image: f.image }); prepared.applyTexture(1, { kind: "bind-image", image: second }); prepared.draw(); prepared.cleanup();
    expect([...f.proxy.readPixels().subarray(48, 52)]).toEqual([20, 80, 140, 255]);
  } finally { f.target.close(); }
});

test("backend wire decoder rejects malformed records, references and incompatible source stages", () => {
  const f = fixture();
  const resources = { image: (id: number) => { if (id !== f.image.ordinal) throw new RangeError("Unknown image"); return f.image; }, cinematic: () => { throw new Error("No cinematic"); } };
  try {
    expect(() => decodeBatch(null, resources)).toThrow();
    expect(() => decodeBatch({ ...f.batch, texture: { kind: "bind-image", image: 900 } }, resources)).toThrow("Unknown image");
    expect(() => decodeImmediate({ kind: "entity-axis", positions: [], whiteImage: 0 }, resources)).toThrow("six positions");
    expect(() => decodeImmediate({ kind: "depth-range", range: [0, Infinity] }, resources)).toThrow();
    expect(() => decodeStage({ kind: "generic-pair", batch: { ...f.batch, texture: { kind: "bind-image", image: 0 } }, scratch: [], stateBits: 0 }, resources)).toThrow();
    expect(() => f.runtime.dispatch({ kind: "backend", method: "prepared", args: { id: 200, phase: "draw" } })).toThrow("Unknown prepared");
    expect(() => f.runtime.dispatch({ kind: "backend", method: "selectDrawBuffer", args: { buffer: "bogus", clear: false } })).toThrow();
  } finally { f.target.close(); }
});

test("raw cinematic upload reaches the real CPU current texture exactly once", () => {
  const f = fixture();
  try {
    // R_CreateImage leaves its cached image raw-unbound. A distinct final registration
    // makes the scratch image's later GL_Bind select its real texture object.
    f.images.create({ name: "other", sourceWidth: 1, sourceHeight: 1, mipmap: false, internalFormat: "rgba8", registrationUnit: 0,
      levels: [{ width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) }], sampling: { wrap: "repeat", filter: "nearest" } });
    const raw = f.proxy.prepareRawGeometry({ rect: { x: 0, y: 0, width: 4, height: 4 }, uploadWidth: 1, uploadHeight: 1, identityLight: 1 });
    raw.uploadCurrent({ image: f.image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1,
      content: new RgbaSnapshot(1, 1, new Uint8Array([10, 200, 30, 255])), dirty: true });
    raw.draw();
    expect([...f.proxy.readPixels().subarray(0, 4)]).toEqual([10, 200, 30, 255]);
    expect(() => raw.draw()).toThrow("Unknown prepared backend draw");
  } finally { f.target.close(); }
});

test("failed source factory closes the actual CPU target and preserves the initialization error", () => {
  const fail = (): RenderThreadRuntime => { throw new Error("source initialization failed"); };
  expect(() => createThreadedBackendRuntime({ kind: "cpu", width: 4, height: 4, subpixelBits: 8, stencilBits: 0, alphaBits: 8, textureFilter: "nearest" }, () => undefined, fail)).toThrow("source initialization failed");
});

test("real worker publishes CPU pixels and services nested screenshot readback during presentation", async () => {
  let thread: ThreadedBackend | null = null;
  const nestedPixels: Uint8Array[] = [];
  let completions = 0;
  thread = await ThreadedBackend.open({ kind: "cpu", width: 2, height: 2, subpixelBits: 8, stencilBits: 0, alphaBits: 8, textureFilter: "nearest" }, {
    request(payload) {
      const message = wireRecord(payload);
      if (message["kind"] !== "backend-cpu-frame" || thread === null) throw new Error("Unexpected CPU worker callback");
      const result = thread.callbackCall({ kind: "backend", method: "readPixels" });
      if (!(result instanceof Uint8Array)) throw new Error("Worker returned invalid pixels");
      nestedPixels.push(result); return undefined;
    },
    completed() { completions++; return undefined; },
  });
  try {
    const color = { x: 0, y: 1, z: 0, w: 1 };
    thread.issue({ kind: "backend", method: "beginView", args: { viewport: { x: 0, y: 0, width: 2, height: 2 }, clear: { color, depth: 1, stencil: false } } });
    color.y = 0;
    thread.synchronize(); expect(completions).toBe(1);
    thread.call({ kind: "backend", method: "present" });
    expect(nestedPixels).toHaveLength(1);
    expect(nestedPixels[0]).toEqual(new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]));
  } finally { thread.close(); }
});

test("worker GL logging forwards real countdown and retained error reporting without reading errors inside Begin/End", () => {
  const cvars = new CvarRegistry(), writes: string[] = [], diagnostics: string[] = [], printed: string[] = [];
  cvars.register("r_logFile", "0"); cvars.register("fs_basepath", "/unused-test-path");
  let errorChecking = true, opens = 0, requests = 0, errorReads = 0;
  const log = new GlCallLogging({ cvars, openLog: () => { opens++; return { write: text => { writes.push(text); }, close: () => {} }; },
    localCalendar: () => ({ year: 126, month: 8, day: 9, hour: 1, minute: 2, second: 3, weekday: 3, yearDay: 251, isDst: 1 }),
    print: text => { printed.push(text); }, errorChecking: { enabled: () => errorChecking, writeDiagnostic: text => { diagnostics.push(text); } } });
  const request = (payload: unknown): unknown => {
    requests++;
    const p = wireRecord(payload);
    if (p["kind"] !== "backend-gl-log") throw new Error("Unexpected logging request");
    switch (p["operation"]) {
      case "reset": log.resetCalls(); break;
      case "end-frame": log.endFrame(); break;
      case "state": break;
      case "call": log.call(wireString(p["text"])); return undefined;
      case "comment": log.comment(wireString(p["text"])); return undefined;
      case "error-enabled": return errorChecking;
      case "error": log.errors?.report(wireString(p["name"]), wireInteger(p["error"])); return undefined;
      case "diagnostic": diagnostics.push(wireString(p["text"])); return undefined;
      case "print": printed.push(wireString(p["text"])); return undefined;
      default: throw new Error("Unknown logging request");
    }
    return { enabled: log.enabled, comments: log.commentEnabled };
  };
  try {
    const worker = createWorkerGlLogging(request), initialRequests = requests;
    worker.call("disabled\n"); worker.comment("unopened\n"); expect(requests).toBe(initialRequests);
    cvars.set("r_logFile", "2", true); worker.endFrame(); worker.call("first call\n");
    worker.endFrame(); expect(cvars.get("r_logFile")?.integerValue).toBe(1);
    worker.endFrame(); expect(cvars.get("r_logFile")?.integerValue).toBe(0);
    worker.call("disabled again\n"); worker.comment("retained comment\n");
    expect(writes.slice(1)).toEqual(["first call\n", "retained comment\n"]); expect(opens).toBe(1);
    const errors = worker.errors;
    if (errors === null) throw new Error("Missing worker GL diagnostics");
    const getError = () => { errorReads++; return 0x0502; };
    errors.wrap("glBegin", () => undefined, getError)(); expect(errorReads).toBe(0);
    errors.wrap("glEnd", () => undefined, getError)(); expect(errorReads).toBe(1);
    const replacement = createWorkerGlLogging(request);
    replacement.errors?.check("replacement context", getError);
    expect(diagnostics.filter(line => line.startsWith("BREAK ON"))).toHaveLength(1);
    expect(diagnostics.filter(line => line.startsWith("OpenGL Error"))).toHaveLength(2);
    errorChecking = false; replacement.errors?.check("disabled", getError); expect(errorReads).toBe(2);
    replacement.resetCalls(); expect(replacement.enabled).toBe(false); expect(replacement.commentEnabled).toBe(true);
  } finally { log.close(); }
});
