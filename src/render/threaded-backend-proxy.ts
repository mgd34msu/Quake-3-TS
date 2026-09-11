// Renderer frontend facade and concrete worker backend execution, tr_cmds.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { RendererBackend, PreparedBackendDraw, PreparedBackendSourceDraw, PreparedBackendDebugTris, PreparedBackendRawDraw, RawGeometry, RenderViewState, RendererDrawBuffer } from "./commands.ts";
import { RenderTarget } from "./commands.ts";
import type { DrawBatch, ImmediateViewOperation, SourceDebugNormals, SourceDebugTris, SourceGeometryAllocation, SourceStageData } from "./types.ts";
import type { Rect2D } from "./draw2d.ts";
import type { ShaderCinematicCall, ShaderCinematicSource } from "./cinematic-command.ts";
import type { RendererImage, ImageResourceOperation } from "./image-resource.ts";
import { RendererImageCatalog } from "./image-resource.ts";
import { RendererResourceSender, RendererResourceReceiver } from "./renderer-resource-transport.ts";
import { decodeResourceJournal, decodeImageFrameState, decodeImageUsageState } from "./renderer-resource-decode.ts";
import type { RenderThreadRuntime } from "./threaded-backend.ts";
import { SoftwareRenderer } from "./cpu/rasterizer.ts";
import { GlRenderer } from "./gl/renderer.ts";
import type { GlCallLoggingSink } from "./gl/logging.ts";
import { GlCallErrorDiagnostics } from "./platform-diagnostics.ts";
import { SdlWorkerRenderContext } from "../platform/sdl-render-context.ts";
import type { SdlWindow } from "../platform/sdl.ts";
import type { SourceGlExtensionSettings } from "./settings.ts";
import type { BackendWireResources, BackendWireSender } from "./threaded-backend-protocol.ts";
import { captureBatch, captureDebugNormals, captureDebugTris, captureImmediate, captureStage, captureTextureOperation, captureUpload,
  decodeAllocation, decodeBatch, decodeDebugNormals, decodeDebugTris, decodeImmediate, decodeRawGeometry, decodeStage, decodeTextureOperation, decodeUpload, decodeViewState,
  wireBoolean, wireBytes, wireInteger, wireNumber, wireRecord, wireRect, wireString } from "./threaded-backend-protocol.ts";

type ConcreteBackend = SoftwareRenderer | GlRenderer;
type Prepared = { readonly kind: "draw"; readonly value: PreparedBackendDraw }
  | { readonly kind: "source"; readonly value: PreparedBackendSourceDraw }
  | { readonly kind: "debug"; readonly value: PreparedBackendDebugTris }
  | { readonly kind: "raw"; readonly value: PreparedBackendRawDraw };

class WorkerGlErrors extends GlCallErrorDiagnostics {
  constructor(private readonly request: (payload: unknown) => unknown) {
    super({ enabled: () => wireBoolean(request({ kind: "backend-gl-log", operation: "error-enabled" })),
      print: text => { request({ kind: "backend-gl-log", operation: "print", text }); return undefined; },
      writeDiagnostic: text => { request({ kind: "backend-gl-log", operation: "diagnostic", text }); return undefined; } });
  }
  override check(name: string, getError: () => number): void {
    if (!wireBoolean(this.request({ kind: "backend-gl-log", operation: "error-enabled" }))) return;
    const error = getError();
    if (error !== 0) this.request({ kind: "backend-gl-log", operation: "error", name, error });
  }
}

/** Main owns the retained log and error count; only worker GL calls read driver errors. */
export function createWorkerGlLogging(request: (payload: unknown) => unknown): GlCallLoggingSink {
  const state = (operation: "state" | "reset" | "end-frame") => {
    const value = wireRecord(request({ kind: "backend-gl-log", operation }));
    return { enabled: wireBoolean(value["enabled"]), comments: wireBoolean(value["comments"]) };
  };
  let current = state("state");
  return {
    errors: new WorkerGlErrors(request),
    get enabled() { return current.enabled; },
    get commentEnabled() { return current.comments; },
    resetCalls() { current = state("reset"); },
    endFrame() { current = state("end-frame"); },
    call(text) { if (current.enabled) request({ kind: "backend-gl-log", operation: "call", text }); },
    comment(text) { if (current.comments) request({ kind: "backend-gl-log", operation: "comment", text }); },
  };
}

export interface ThreadedSourceContext {
  readonly backend: RendererBackend;
  readonly target: RenderTarget;
  readonly images: RendererImageCatalog;
  readonly resources: RendererResourceReceiver;
  readonly bindings: BackendWireResources;
  request(payload: unknown): unknown;
  readPixels(): Uint8Array;
  present(): undefined;
}

export function createThreadedBackendRuntime(initialization: unknown, request: (payload: unknown) => unknown,
  sourceFactory: (context: ThreadedSourceContext) => RenderThreadRuntime): RenderThreadRuntime {
  const init = wireRecord(initialization), filter = init["textureFilter"];
  if (filter !== "nearest" && filter !== "linear" && filter !== "nearest-mipmap-nearest" && filter !== "linear-mipmap-nearest"
    && filter !== "nearest-mipmap-linear" && filter !== "linear-mipmap-linear") throw new TypeError("Invalid initial renderer texture filter");
  const images = new RendererImageCatalog(filter);
  let context: SdlWorkerRenderContext | null = null;
  let backend: ConcreteBackend;
  if (init["kind"] === "cpu") {
    const alpha = wireInteger(init["alphaBits"]);
    if (alpha !== 0 && alpha !== 8) throw new RangeError("Invalid CPU alpha bits");
    backend = new SoftwareRenderer(wireInteger(init["width"]), wireInteger(init["height"]), images,
      wireInteger(init["subpixelBits"]), wireInteger(init["stencilBits"]), alpha);
  } else if (init["kind"] === "gl") {
    context = SdlWorkerRenderContext.adopt(init["context"]);
    try { backend = new GlRenderer(context, images, createWorkerGlLogging(request)); }
    catch (error) { context.release(); throw error; }
  } else throw new TypeError("Invalid renderer runtime initialization");
  let target: RenderTarget;
  try { target = new RenderTarget(images, [backend]); }
  catch (error) { backend.close(); context?.release(); throw error; }
  const owners = new Map<number, object>();
  const cinematicSources = new Map<number, ShaderCinematicSource>();
  const cinematic = (id: number): ShaderCinematicSource => {
    const prior = cinematicSources.get(id);
    if (prior !== undefined) return prior;
    const imageId = wireInteger(request({ kind: "backend-cinematic-image", id }));
    const source: ShaderCinematicSource = { image: resources.resolveImage(imageId), prepareAtExecution: () => {
      const result = request({ kind: "backend-cinematic-prepare", id });
      if (result === null) return null;
      const reply = wireRecord(result), token = wireInteger(reply["token"]);
      return { upload: decodeUpload(reply["upload"], wire), afterShaderUpload: () => { request({ kind: "backend-cinematic-complete", token }); return undefined; } };
    } };
    cinematicSources.set(id, source); return source;
  };
  const resources = new RendererResourceReceiver(images, cinematic, id => {
    const prior = owners.get(id); if (prior !== undefined) return prior;
    const owner = Object.freeze({ id }); owners.set(id, owner); return owner;
  });
  const wire: BackendWireResources = { image: id => resources.resolveImage(id), cinematic };
  const present = (): undefined => {
    if (context !== null) context.swap();
    else request({ kind: "backend-cpu-frame", pixels: rpc.readPixels(), width: backend.width, height: backend.height });
    return undefined;
  };
  const rpc = new BackendRpcDispatcher(backend, wire, request, present);
  let source: RenderThreadRuntime;
  try { source = sourceFactory({ backend, target, images, resources, bindings: wire, request, readPixels: () => rpc.readPixels(), present }); }
  catch (error) { try { target.close(); } finally { context?.release(); } throw error; }
  let closed = false;
  return { description: describe(backend), dispatch: payload => {
    if (closed) throw new Error("Renderer worker runtime is closed");
    const message = wireRecord(payload);
    if (message["kind"] !== "backend") return source.dispatch(payload);
    if (message["method"] === "resources") {
      const journal = decodeResourceJournal(message["journal"]), state = decodeImageFrameState(message["state"]);
      resources.applyState(state);
      resources.applyJournal(journal);
      return resources.captureUsage();
    }
    return rpc.dispatch(payload);
  }, close: () => {
    if (closed) return; closed = true;
    try { source.close(); } finally { try { target.close(); } finally { context?.release(); } }
  } };
}

export interface BackendDescription {
  readonly kind: "cpu" | "gl";
  readonly width: number; readonly height: number; readonly stencilBits: number; readonly subpixelBits: number;
  readonly colorBits: number; readonly alphaBits: number; readonly depthBits: number; readonly stereoEnabled: boolean;
  readonly maxTextureSize: number | null;
  readonly capabilities: { readonly textureUnits: number; readonly textureEnvAdd: boolean };
  readonly driver: { readonly vendor: string; readonly renderer: string; readonly version: string };
  readonly extensions: string;
}
export function decodeBackendDescription(value: unknown): BackendDescription {
  const v = wireRecord(value), caps = wireRecord(v["capabilities"]), driver = wireRecord(v["driver"]), kind = v["kind"];
  if (kind !== "cpu" && kind !== "gl") throw new TypeError("Invalid threaded backend kind");
  return { kind, width: wireInteger(v["width"]), height: wireInteger(v["height"]), stencilBits: wireInteger(v["stencilBits"]), subpixelBits: wireInteger(v["subpixelBits"]),
    colorBits: wireInteger(v["colorBits"]), alphaBits: wireInteger(v["alphaBits"]), depthBits: wireInteger(v["depthBits"]), stereoEnabled: wireBoolean(v["stereoEnabled"]),
    maxTextureSize: v["maxTextureSize"] === null ? null : wireInteger(v["maxTextureSize"]), extensions: wireString(v["extensions"]),
    capabilities: { textureUnits: wireInteger(caps["textureUnits"]), textureEnvAdd: wireBoolean(caps["textureEnvAdd"]) },
    driver: { vendor: wireString(driver["vendor"]), renderer: wireString(driver["renderer"]), version: wireString(driver["version"]) } };
}
function describe(backend: ConcreteBackend): BackendDescription {
  const common = { width: backend.width, height: backend.height, stencilBits: backend.stencilBits, subpixelBits: backend.subpixelBits, alphaBits: backend.alphaBits, capabilities: backend.capabilities };
  return backend instanceof SoftwareRenderer ? { ...common, ...backend.configuration,
    driver: { vendor: "Quake 3 TypeScript", renderer: "TypeScript CPU renderer", version: "1" }, extensions: "" }
    : { ...common, kind: "gl", colorBits: backend.colorBits, depthBits: backend.depthBits, stereoEnabled: backend.stereoEnabled,
      maxTextureSize: backend.maxTextureSize, driver: backend.driver, extensions: backend.extensions };
}

/** Retains real prepared draws in the worker until their source cleanup phase. */
export class BackendRpcDispatcher {
  private readonly prepared = new Map<number, Prepared>();
  private nextPrepared = 1;
  constructor(readonly backend: ConcreteBackend, private readonly resources: BackendWireResources,
    private readonly request: (payload: unknown) => unknown, private readonly presentFrame: () => undefined) {}

  private retain(prepared: Prepared): number { const id = this.nextPrepared++; this.prepared.set(id, prepared); return id; }
  private require(id: unknown): Prepared {
    const value = this.prepared.get(wireInteger(id));
    if (value === undefined) throw new RangeError("Unknown prepared backend draw");
    return value;
  }
  readPixels(): Uint8Array { return this.backend instanceof SoftwareRenderer ? new Uint8Array(this.backend.pixels) : this.backend.readPixels(); }

  dispatch(payload: unknown): unknown {
    const message = wireRecord(payload);
    if (message["kind"] !== "backend") throw new TypeError("Expected backend RPC");
    const method = wireString(message["method"]), arg = message["args"];
    switch (method) {
      case "beginView": return this.backend.beginView(decodeViewState(arg));
      case "drawImmediate": return this.backend.drawImmediate(decodeImmediate(arg, this.resources));
      case "prepareGeometry": return this.retain({ kind: "draw", value: this.backend.prepareGeometry(decodeBatch(arg, this.resources)) });
      case "prepareSourceGeometry": {
        const a = wireRecord(arg); return this.retain({ kind: "source", value: this.backend.prepareSourceGeometry(decodeStage(a["stage"], this.resources), decodeAllocation(a["allocation"])) });
      }
      case "prepareDebugTris": return this.retain({ kind: "debug", value: this.backend.prepareDebugTris(decodeDebugTris(arg, this.resources)) });
      case "drawDebugNormals": return this.backend.drawDebugNormals(decodeDebugNormals(arg, this.resources));
      case "prepareRawGeometry": return this.retain({ kind: "raw", value: this.backend.prepareRawGeometry(decodeRawGeometry(arg)) });
      case "prepared": return this.executePrepared(wireRecord(arg));
      case "selectDrawBuffer": {
        const a = wireRecord(arg), buffer = a["buffer"];
        if (buffer !== "front" && buffer !== "back" && buffer !== "back-left" && buffer !== "back-right") throw new TypeError("Invalid draw buffer");
        return this.backend.selectDrawBuffer(buffer, wireBoolean(a["clear"]));
      }
      case "setOverdrawMeasurement": return this.backend.setOverdrawMeasurement(wireBoolean(arg));
      case "readStencilOverdraw": {
        const size = wireInteger(arg);
        if (size < 0 || size > this.backend.width * this.backend.height * 4) throw new RangeError("Invalid stencil readback size");
        const destination = new Uint8Array(size); this.backend.readStencilOverdraw(destination); return destination;
      }
      case "readDepthPixel": { const a = wireRecord(arg); return this.backend.readDepthPixel(wireNumber(a["x"]), wireNumber(a["y"])); }
      case "readPixels": return this.readPixels();
      case "clearColorBuffer": return this.backend.clearColorBuffer();
      case "drawShowImage": { const a = wireRecord(arg); return this.backend.drawShowImage(this.resources.image(wireInteger(a["image"])), wireRect(a["rect"]), wireBoolean(a["proportional"])); }
      case "finish": return this.backend.finish();
      case "present": return this.presentFrame();
      case "getError": return this.requireGl().getError();
      case "checkFrameErrors": return this.requireGl().checkFrameErrors();
      case "checkDiagnosticFrameErrors": return this.requireGl().checkDiagnosticFrameErrors();
      case "endFrameLogging": return this.requireGl().endFrameLogging();
      case "updateRenderingEnabled": return this.requireGl().updateRenderingEnabled(wireNumber(arg), text => { this.request({ kind: "backend-print", text }); return undefined; });
      case "initializeAppleTransformHint": return this.requireGl().initializeAppleTransformHint(
        () => wireBoolean(this.request({ kind: "backend-apple-transform-enabled" })),
        text => { this.request({ kind: "backend-print", text }); return undefined; });
      case "initializeExtensions": {
        const a = wireRecord(arg);
        this.requireGl().initializeExtensions({ allow: wireBoolean(a["allow"]), compressedTextures: wireBoolean(a["compressedTextures"]), compiledVertexArrays: wireBoolean(a["compiledVertexArrays"]), textureEnvAdd: wireBoolean(a["textureEnvAdd"]), multitexture: wireBoolean(a["multitexture"]), print: text => { this.request({ kind: "backend-print", text }); } });
        return this.extensionState();
      }
      case "initializeDefaultState": {
        this.requireGl().initializeDefaultState(wireBoolean(arg), () => { this.request({ kind: "backend-texture-mode" }); return undefined; }); return undefined;
      }
      case "extensionState": return this.extensionState();
      default: throw new TypeError(`Unknown backend RPC method ${method}`);
    }
  }
  private requireGl(): GlRenderer {
    if (!(this.backend instanceof GlRenderer)) throw new Error("GL operation requires the GL backend");
    return this.backend;
  }
  private extensionState(): unknown {
    const gl = this.requireGl(); return { textureCompression: gl.textureCompression, compiledVertexArrays: gl.compiledVertexArrays, textureExtensions: gl.textureExtensions };
  }
  private executePrepared(a: Record<string, unknown>): undefined {
    const p = this.require(a["id"]), phase = wireString(a["phase"]);
    switch (phase) {
      case "begin": if (p.kind !== "raw") return p.value.begin(); break;
      case "cleanup": if (p.kind !== "raw") { p.value.cleanup(); this.prepared.delete(wireInteger(a["id"])); return; } break;
      case "applyTexture": {
        const unit = wireInteger(a["unit"]);
        if (unit !== 0 && unit !== 1) throw new TypeError("Invalid texture unit");
        if (p.kind === "draw" || p.kind === "source") return p.value.applyTexture(unit, decodeTextureOperation(a["operation"], this.resources)); break;
      }
      case "prepareTexture": {
        const unit = wireInteger(a["unit"]);
        if (unit !== 0 && unit !== 1) throw new TypeError("Invalid texture unit");
        if (p.kind === "source") return p.value.prepareTexture(unit); break;
      }
      case "finishTextures": if (p.kind === "source") return p.value.finishTextures(); break;
      case "draw":
        if (p.kind === "draw") return p.value.draw();
        if (p.kind === "raw") { p.value.draw(); this.prepared.delete(wireInteger(a["id"])); return; }
        return p.value.draw(wireNumber(a["primitives"]));
      case "uploadCurrent": if (p.kind === "raw") return p.value.uploadCurrent(decodeUpload(a["upload"], this.resources)); break;
    }
    throw new TypeError(`Invalid ${p.kind} prepared phase ${phase}`);
  }
  close(): undefined { this.prepared.clear(); return this.backend.close(); }
}

export interface BackendRpcConnection {
  call(payload: unknown): unknown;
  callbackCall(payload: unknown): unknown;
  synchronize(): unknown;
  close(): undefined;
}

export interface BackendHostCallbacks {
  cinematic(id: number): ShaderCinematicSource;
  print(text: string): void;
  textureMode(): undefined;
  presentPixels(pixels: Uint8Array, width: number, height: number): undefined;
}

/** The main thread's concrete RendererBackend, with worker-owned prepared draw IDs. */
export class ThreadedRendererBackend implements RendererBackend {
  readonly description: BackendDescription;
  readonly resources: RendererResourceSender;
  private readonly wire: BackendWireSender;
  private closed = false;
  private resourceCallback = false;
  private nextCinematicCall = 1;
  private readonly cinematicCalls = new Map<number, ShaderCinematicCall>();
  private initializationPrint: ((text: string) => void) | null = null;
  private textureModeCallback: (() => undefined) | null = null;
  private appleTransformEnabled: (() => boolean) | null = null;
  private compression: "none" | "s3tc" = "none";
  private compiledArrays = false;
  private textureExtensionState: GlRenderer["textureExtensions"] | null = null;

  constructor(readonly thread: BackendRpcConnection, readonly images: RendererImageCatalog,
    description: unknown, cinematicId: (source: ShaderCinematicSource) => number) {
    this.description = decodeBackendDescription(description);
    this.resources = new RendererResourceSender(images, () => { if (!this.resourceCallback) thread.synchronize(); }, cinematicId);
    this.wire = { image: image => this.resources.sourceImageHandle(image), cinematic: cinematicId };
  }
  get width(): number { return this.description.width; }
  get height(): number { return this.description.height; }
  get stencilBits(): number { return this.description.stencilBits; }
  get subpixelBits(): number { return this.description.subpixelBits; }
  get alphaBits(): number { return this.description.alphaBits; }
  get capabilities(): BackendDescription["capabilities"] { return this.description.capabilities; }
  get driver(): BackendDescription["driver"] { return this.description.driver; }
  get extensions(): string { return this.description.extensions; }
  get colorBits(): number { return this.description.colorBits; }
  get depthBits(): number { return this.description.depthBits; }
  get stereoEnabled(): boolean { return this.description.stereoEnabled; }
  get maxTextureSize(): number | null { return this.description.maxTextureSize; }
  get pixels(): Uint8Array { return this.readPixels(); }
  get bindings(): BackendWireSender { return this.wire; }
  get configuration(): SoftwareRenderer["configuration"] {
    if (this.description.kind !== "cpu") throw new Error("CPU configuration requires the CPU backend");
    return { kind: "cpu", colorBits: this.colorBits, depthBits: this.depthBits, depthStorage: "binary64", stencilBits: this.stencilBits, stereoEnabled: this.stereoEnabled, maxTextureSize: null };
  }
  get textureCompression(): "none" | "s3tc" { return this.compression; }
  get compiledVertexArrays(): boolean { return this.compiledArrays; }
  get textureExtensions(): GlRenderer["textureExtensions"] {
    if (this.textureExtensionState === null) throw new Error("Source texture extensions have not initialized");
    return this.textureExtensionState;
  }

  handleHostRequest(payload: unknown, callbacks: BackendHostCallbacks): unknown {
    const message = wireRecord(payload);
    switch (message["kind"]) {
      case "backend-print": (this.initializationPrint ?? callbacks.print)(wireString(message["text"])); return undefined;
      case "backend-apple-transform-enabled":
        if (this.appleTransformEnabled === null) throw new Error("Apple transform callback is not active");
        return this.appleTransformEnabled();
      case "backend-texture-mode":
        if (this.resourceCallback) throw new Error("Reentrant backend texture mode callback");
        this.resourceCallback = true;
        try { return (this.textureModeCallback ?? callbacks.textureMode)(); } finally { this.resourceCallback = false; }
      case "backend-cpu-frame": {
        const width = wireInteger(message["width"]), height = wireInteger(message["height"]), pixels = wireBytes(message["pixels"]);
        if (width !== this.width || height !== this.height || pixels.length !== width * height * 4) throw new Error("CPU frame publication dimensions changed");
        return callbacks.presentPixels(pixels, width, height);
      }
      case "backend-cinematic-image": return this.wire.image(callbacks.cinematic(wireInteger(message["id"])).image);
      case "backend-cinematic-prepare": {
        const call = callbacks.cinematic(wireInteger(message["id"])).prepareAtExecution();
        if (call === null) return null;
        const token = this.nextCinematicCall++;
        this.cinematicCalls.set(token, call);
        return { token, upload: captureUpload(call.upload, this.wire) };
      }
      case "backend-cinematic-complete": {
        const token = wireInteger(message["token"]), call = this.cinematicCalls.get(token);
        if (call === undefined) throw new Error("Unknown backend cinematic completion");
        this.cinematicCalls.delete(token); return call.afterShaderUpload();
      }
      default: throw new Error("Unknown backend host callback");
    }
  }

  flushResources(): undefined {
    const payload = { kind: "backend", method: "resources", journal: this.resources.takeJournal(), state: this.resources.captureState() };
    const result = this.resourceCallback ? this.thread.callbackCall(payload) : this.thread.call(payload);
    this.resources.applyUsage(decodeImageUsageState(result));
  }
  private call(method: string, args?: unknown): unknown {
    if (this.closed) throw new Error("Threaded renderer backend is closed");
    this.flushResources();
    return this.thread.call({ kind: "backend", method, args: structuredClone(args) });
  }
  private phase(id: number, phase: string, fields: Readonly<Record<string, unknown>> = {}): undefined { this.call("prepared", { id, phase, ...fields }); }
  applyImageResource(_operation: ImageResourceOperation): undefined { this.flushResources(); }
  beginView(view: RenderViewState): undefined { this.call("beginView", view); }
  drawImmediate(operation: ImmediateViewOperation): undefined { this.call("drawImmediate", captureImmediate(operation, this.wire)); }
  prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const id = wireInteger(this.call("prepareGeometry", captureBatch(batch, this.wire)));
    return { begin: () => this.phase(id, "begin"), applyTexture: (unit, operation) => this.phase(id, "applyTexture", { unit, operation: captureTextureOperation(operation, this.wire) }), draw: () => this.phase(id, "draw"), cleanup: () => this.phase(id, "cleanup") };
  }
  prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    const id = wireInteger(this.call("prepareSourceGeometry", { stage: captureStage(stage, this.wire), allocation }));
    return { begin: () => this.phase(id, "begin"), prepareTexture: unit => this.phase(id, "prepareTexture", { unit }), applyTexture: (unit, operation) => this.phase(id, "applyTexture", { unit, operation: captureTextureOperation(operation, this.wire) }), finishTextures: () => this.phase(id, "finishTextures"), draw: primitives => this.phase(id, "draw", { primitives }), cleanup: () => this.phase(id, "cleanup") };
  }
  prepareDebugTris(input: SourceDebugTris): PreparedBackendDebugTris {
    const id = wireInteger(this.call("prepareDebugTris", captureDebugTris(input, this.wire)));
    return { begin: () => this.phase(id, "begin"), draw: primitives => this.phase(id, "draw", { primitives }), cleanup: () => this.phase(id, "cleanup") };
  }
  drawDebugNormals(input: SourceDebugNormals): undefined { this.call("drawDebugNormals", captureDebugNormals(input, this.wire)); }
  prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    const id = wireInteger(this.call("prepareRawGeometry", geometry));
    return { uploadCurrent: upload => this.phase(id, "uploadCurrent", { upload: captureUpload(upload, this.wire) }), draw: () => this.phase(id, "draw") };
  }
  selectDrawBuffer(buffer: RendererDrawBuffer, clear: boolean): undefined { this.call("selectDrawBuffer", { buffer, clear }); }
  setOverdrawMeasurement(enabled: boolean): undefined { this.call("setOverdrawMeasurement", enabled); }
  readStencilOverdraw(destination: Uint8Array): undefined { const bytes = wireBytes(this.call("readStencilOverdraw", destination.length)); if (bytes.length !== destination.length) throw new Error("Stencil readback size changed"); destination.set(bytes); }
  readDepthPixel(x: number, y: number): number { return wireNumber(this.thread.callbackCall({ kind: "backend", method: "readDepthPixel", args: { x, y } })); }
  readPixels(): Uint8Array { return wireBytes(this.thread.callbackCall({ kind: "backend", method: "readPixels" })); }
  clearColorBuffer(): undefined { this.call("clearColorBuffer"); }
  drawShowImage(image: RendererImage, rect: Rect2D, proportional: boolean): undefined { this.call("drawShowImage", { image: this.wire.image(image), rect, proportional }); }
  finish(): undefined { this.call("finish"); }
  present(): undefined { this.thread.callbackCall({ kind: "backend", method: "present" }); }
  getError(): number { return wireInteger(this.thread.callbackCall({ kind: "backend", method: "getError" })); }
  checkFrameErrors(): undefined { this.thread.callbackCall({ kind: "backend", method: "checkFrameErrors" }); }
  checkDiagnosticFrameErrors(): void { this.thread.callbackCall({ kind: "backend", method: "checkDiagnosticFrameErrors" }); }
  endFrameLogging(): void { this.thread.callbackCall({ kind: "backend", method: "endFrameLogging" }); }
  updateRenderingEnabled(value: number, print: (text: string) => undefined): void {
    if (this.initializationPrint !== null) throw new Error("Reentrant GL rendering update");
    this.initializationPrint = print;
    try { this.thread.callbackCall({ kind: "backend", method: "updateRenderingEnabled", args: value }); }
    finally { this.initializationPrint = null; }
  }
  initializeAppleTransformHint(enabled: () => boolean, print: (text: string) => undefined): void {
    if (this.appleTransformEnabled !== null || this.initializationPrint !== null) throw new Error("Reentrant Apple transform initialization");
    this.appleTransformEnabled = enabled; this.initializationPrint = print;
    try { this.call("initializeAppleTransformHint"); }
    finally { this.appleTransformEnabled = null; this.initializationPrint = null; }
  }
  initializeExtensions(settings: SourceGlExtensionSettings): void {
    if (this.initializationPrint !== null) throw new Error("Reentrant GL extension initialization");
    this.initializationPrint = settings.print;
    try {
      const value = wireRecord(this.call("initializeExtensions", { allow: settings.allow, compressedTextures: settings.compressedTextures,
        compiledVertexArrays: settings.compiledVertexArrays, textureEnvAdd: settings.textureEnvAdd, multitexture: settings.multitexture }));
      const compression = value["textureCompression"], extensions = wireRecord(value["textureExtensions"]);
      if (compression !== "none" && compression !== "s3tc") throw new Error("Invalid worker texture compression");
      this.compression = compression; this.compiledArrays = wireBoolean(value["compiledVertexArrays"]);
      this.textureExtensionState = { maxActiveTextures: wireInteger(extensions["maxActiveTextures"]), textureEnvAddAvailable: wireBoolean(extensions["textureEnvAddAvailable"]) };
    } finally { this.initializationPrint = null; }
  }
  initializeDefaultState(multitexture: boolean, textureMode: () => undefined): undefined {
    if (this.textureModeCallback !== null) throw new Error("Reentrant GL default state initialization");
    this.textureModeCallback = textureMode;
    try { this.call("initializeDefaultState", multitexture); } finally { this.textureModeCallback = null; }
  }
  extensionState(): unknown { return this.call("extensionState"); }
  close(): undefined { if (this.closed) return; this.closed = true; this.cinematicCalls.clear(); this.thread.close(); }
}

export class ThreadedSoftwareRenderer extends ThreadedRendererBackend {
  constructor(thread: BackendRpcConnection, images: RendererImageCatalog, description: unknown,
    cinematicId: (source: ShaderCinematicSource) => number) {
    super(thread, images, description, cinematicId);
    if (this.description.kind !== "cpu") throw new Error("Software renderer proxy requires a CPU worker");
  }
}

export class ThreadedGlRenderer extends ThreadedRendererBackend {
  constructor(thread: BackendRpcConnection, images: RendererImageCatalog, description: unknown,
    cinematicId: (source: ShaderCinematicSource) => number, readonly window: SdlWindow) {
    super(thread, images, description, cinematicId);
    if (this.description.kind !== "gl") throw new Error("GL renderer proxy requires a GL worker");
  }
  override get maxTextureSize(): number {
    const maximum = this.description.maxTextureSize;
    if (maximum === null) throw new Error("GL worker did not publish its texture limit");
    return maximum;
  }
}
