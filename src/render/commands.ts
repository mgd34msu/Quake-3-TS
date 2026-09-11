// Ordered renderer commands, id Software tr_cmds.c and tr_backend.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Vec4 } from "../core/math.ts";
import type { SourceGeometryAllocation } from "./types.ts";
import type { HunkArena } from "../core/hunk.ts";
import { Draw2D } from "./draw2d.ts";
import type { CoordinateSpace, Rect2D, TextureRect } from "./draw2d.ts";
import { RendererNoise } from "./deform.ts";
import { iteratePictureSurface } from "./picture-material.ts";
import type { PictureAsset, PictureClock } from "./picture-material.ts";
import type { DrawBatch, ImmediateViewOperation, MultitextureBatch, RenderClipPlane, RenderStateOperation, RenderView, SingleTextureBatch, SourceDebugNormals, SourceDebugTris, SourceRenderView, SourceStageData, SurfaceViewOperation, TextureBinding, ViewOperation } from "./types.ts";
import { snapshotRenderClipPlane, validateRenderStateOperation, validateRenderView, validateRenderViewHeader } from "./types.ts";
import type { ImageCreationTarget, RendererImage, RendererImageCatalog, RendererImageSession } from "./image-resource.ts";
import type { CinematicUpload, PreparedUiRawCall, ShaderCinematicCall, ShaderCinematicSource } from "./cinematic-command.ts";
import type { SourceTessState } from "./tess-state.ts";
import type { RendererRuntimeSettings } from "./settings.ts";
import type { ScreenshotCommand } from "./screenshot.ts";
import type { SourceScreenshotParameters } from "./screenshot.ts";
import type { RendererFrameTimings, RendererPerformanceCounters } from "./performance.ts";
import type { SourceBackendMemory } from "./backend-memory.ts";
import type { SourceDrawSortRange } from "./draw-sort.ts";
import { SOURCE_COMMAND_RELEASE32, SOURCE_RENDER_COMMAND, SourceCommandMemory } from "./command-memory.ts";
import type { WorldBackendView } from "./world-backend.ts";

export type ResolvedTextureOperation =
  | { readonly kind: "bind-image"; readonly image: RendererImage }
  | { readonly kind: "retain-current-texture" }
  | { readonly kind: "cinematic-upload"; readonly upload: CinematicUpload };
export interface PreparedBackendDraw {
  begin(): undefined;
  applyTexture(unit: 0 | 1, operation: ResolvedTextureOperation): undefined;
  draw(): undefined;
  cleanup(): undefined;
}
export interface PreparedBackendSourceDraw extends Omit<PreparedBackendDraw, "draw"> {
  prepareTexture(unit: 0 | 1): undefined;
  finishTextures(): undefined;
  draw(primitives: number): undefined;
}
export interface PreparedBackendDebugTris {
  begin(): undefined;
  draw(primitives: number): undefined;
  cleanup(): undefined;
}
export interface RawGeometry {
  readonly rect: Rect2D;
  readonly uploadWidth: number;
  readonly uploadHeight: number;
  readonly identityLight: number;
}
export interface PreparedBackendRawDraw {
  uploadCurrent(upload: CinematicUpload): undefined;
  draw(): undefined;
}
export interface RenderViewState {
  readonly viewport: RenderView["viewport"];
  readonly clear: RenderView["clear"] | null;
  readonly clipPlane?: RenderClipPlane;
}
export type RendererDrawBuffer = "front" | "back" | "back-left" | "back-right";
export interface RendererBackend extends ImageCreationTarget {
  readonly width: number;
  readonly height: number;
  readonly stencilBits: number;
  selectDrawBuffer(buffer: RendererDrawBuffer, clear: boolean): undefined;
  setOverdrawMeasurement(enabled: boolean): undefined;
  readStencilOverdraw(destination: Uint8Array): undefined;
  readDepthPixel(windowX: number, windowY: number): number;
  beginView(view: RenderViewState): undefined;
  drawImmediate(operation: ImmediateViewOperation): undefined;
  prepareGeometry(batch: DrawBatch): PreparedBackendDraw;
  prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw;
  prepareDebugTris(input: SourceDebugTris): PreparedBackendDebugTris;
  drawDebugNormals(input: SourceDebugNormals): undefined;
  prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw;
  clearColorBuffer(): undefined;
  drawShowImage(image: RendererImage, rect: Rect2D, proportional: boolean): undefined;
  finish(): undefined;
  close(): undefined;
}
export interface RenderCommandOptions {
  readonly clock: PictureClock;
  readonly performanceClock?: PictureClock;
  readonly performance?: RendererPerformanceCounters;
  readonly temporaryMemory?: Pick<HunkArena, "allocateTemp" | "freeTemp">;
  readonly temporaryBuffer?: (bytes: number) => { readonly bytes: Uint8Array; release(): undefined };
  readonly commandStorage?: RendererCommandStorage;
  readonly identityLight: number;
  readonly tess: SourceTessState;
  readonly runtime: RendererRuntimeSettings;
  readonly print: (text: string) => undefined;
  readonly thread?: RendererCommandThread;
}
export interface SubmissionReceipt { readonly commands: number; readonly views: number; readonly batches: number }
interface Counts { commands: number; views: number; batches: number }
export type SourcePreparedViews = ((drawSurfs?: SourceDrawSortRange) => Iterable<SourceRenderView, unknown, unknown>) & {
  readonly captureThreadedView?: (drawSurfs?: SourceDrawSortRange) => WorldBackendView;
};
export type RendererCommandReference =
  | { readonly kind: "screenshot"; readonly command: Pick<ScreenshotCommand, "execute"> }
  | { readonly kind: "resolving-stretch-pic" }
  | { readonly kind: "stretch-pic"; readonly picture: PictureAsset }
  | { readonly kind: "prepared-views"; readonly execute: SourcePreparedViews; readonly drawSurfs: SourceDrawSortRange | null }
  | { readonly kind: "view"; readonly view: RenderView }
  | { readonly kind: "swap-buffers"; readonly present: (() => undefined) | null };
type CommandReference = RendererCommandReference;
export interface IssuedRendererCommands {
  readonly bytes: Uint8Array;
  readonly references: readonly { readonly offset: number; readonly reference: RendererCommandReference }[];
  readonly smpFrame: 0 | 1;
  readonly beginFrame: boolean;
  readonly identityLight: number;
  readonly resetPerformanceCounters: boolean;
}
export interface RendererCommandThread {
  beforeIssue(): void;
  synchronize(): void;
  issue(commands: IssuedRendererCommands): SubmissionReceipt;
  stretchRaw(rect: Rect2D, call: PreparedUiRawCall): undefined;
  endRegistration(): undefined;
}
type PendingCommand =
  | { readonly kind: "draw-buffer"; readonly buffer: RendererDrawBuffer }
  | { readonly kind: "screenshot"; readonly command: Pick<ScreenshotCommand, "execute">; readonly source: SourceScreenshotParameters }
  | { readonly kind: "set-color"; readonly color: Vec4 }
  | { readonly kind: "resolving-stretch-pic" }
  | { readonly kind: "stretch-pic"; readonly rect: Rect2D; readonly uv: TextureRect; readonly picture: PictureAsset }
  | { readonly kind: "prepared-views"; readonly execute: SourcePreparedViews; readonly drawSurfs: SourceDrawSortRange | undefined }
  | { readonly kind: "view"; readonly view: RenderView }
  | { readonly kind: "swap-buffers"; readonly present: (() => undefined) | null };

function writeScreenshot(memory: SourceCommandMemory<CommandReference>, offset: number,
  command: ScreenshotCommand, source: SourceScreenshotParameters): void {
  const output = memory.data();
  output.setInt32(offset + 4, source.x, true); output.setInt32(offset + 8, source.y, true);
  output.setInt32(offset + 12, source.width, true); output.setInt32(offset + 16, source.height, true);
  output.setInt32(offset + 24, source.jpeg ? 1 : 0, true);
  memory.retain(offset, { kind: "screenshot", command });
}

/** R_GetCommandBuffer can publish into backEndData before InitOpenGL creates a target. */
export class RendererCommandStorage {
  private localCommands: SourceCommandMemory<CommandReference> | null = null;
  private sourceCommands = new WeakMap<SourceBackendMemory, SourceCommandMemory<CommandReference>>();

  constructor(private readonly selectedBackend: () => SourceBackendMemory | null,
    private readonly profile: "source" | "isolated") {}

  memory(): SourceCommandMemory<CommandReference> {
    const backend = this.selectedBackend();
    if (backend === null) {
      if (this.profile === "source")
        throw new Error("R_GetCommandBuffer requires allocated backEndData; source null or retired pointer access is undefined");
      this.localCommands ??= SourceCommandMemory.local<CommandReference>();
      return this.localCommands;
    }
    const retained = this.sourceCommands.get(backend);
    if (retained !== undefined) return retained;
    const memory = SourceCommandMemory.fromBackend<CommandReference>(backend);
    this.sourceCommands.set(backend, memory);
    return memory;
  }

  takeScreenshot(command: ScreenshotCommand): boolean {
    const source = command.parameters();
    const memory = this.memory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.screenshotBytes);
    if (offset === null) return false;
    memory.data().setInt32(offset, SOURCE_RENDER_COMMAND.screenshot, true);
    writeScreenshot(memory, offset, command, source);
    return true;
  }

  discardReferences(): void {
    this.localCommands?.discardReferences();
    this.localCommands = null;
    this.sourceCommands = new WeakMap<SourceBackendMemory, SourceCommandMemory<CommandReference>>();
  }
}

type PreparedTextureSlot = Exclude<TextureBinding, { kind: "shader-cinematic" }>
  | { readonly kind: "shader-cinematic"; readonly source: ShaderCinematicSource; readonly image: RendererImage };
interface TargetData {
  readonly session: RendererImageSession;
  readonly backends: readonly [RendererBackend, ...RendererBackend[]];
  phase: "idle" | "executing" | "closing" | "closed";
  queue: { readonly kind: "unclaimed" } | { readonly kind: "claimed"; readonly discard: () => undefined;
    readonly executeSurfaceOperations: (operations: Iterable<SurfaceViewOperation, unknown, unknown>) => void;
    readonly queuePreparedViews: (prepare: SourcePreparedViews, drawSurfs: SourceDrawSortRange | null) => void;
    readonly fixShaderSort: (newShader: number) => void;
    readonly syncRenderThread: () => void };
}
const targets = new WeakMap<RenderTarget, TargetData>();
const f = Math.fround;
const white: Vec4 = { x: 1, y: 1, z: 1, w: 1 };

function drawBufferWord(buffer: RendererDrawBuffer): number {
  switch (buffer) {
    case "front": return 0x0404;
    case "back": return 0x0405;
    case "back-left": return 0x0402;
    case "back-right": return 0x0403;
  }
}
function drawBufferName(buffer: number): RendererDrawBuffer {
  switch (buffer) {
    case 0x0404: return "front";
    case 0x0405: return "back";
    case 0x0402: return "back-left";
    case 0x0403: return "back-right";
    default: throw new RangeError("Unsupported source draw buffer word");
  }
}

function dataOf(target: RenderTarget): TargetData {
  const data = targets.get(target);
  if (data === undefined) throw new Error("Unknown render target");
  return data;
}
function idle(data: TargetData): void {
  if (data.phase === "executing" || data.phase === "closing") data.session.poison(new Error("Reentrant render target operation"));
  if (data.phase === "closed") throw new Error("Render target is closed");
  data.session.assertExecutable();
}
function unclaimed(data: TargetData): void {
  if (data.queue.kind === "claimed") throw new Error("Render target already owns its lifetime command buffer");
}
function checked<T>(data: TargetData, operation: () => T): T {
  data.session.assertExecutable();
  const result = operation();
  data.session.assertExecutable();
  return result;
}
function* checkedValues<T>(data: TargetData, values: Iterable<T, unknown, unknown>): Generator<T, void, unknown> {
  const iterator = checked(data, () => values[Symbol.iterator]());
  for (;;) {
    const next = checked(data, (): IteratorResult<T, undefined> => {
      const result = iterator.next();
      return result.done ? { done: true, value: undefined } : { done: false, value: result.value };
    });
    if (next.done) return;
    yield next.value;
  }
}
function invoke<O, A extends unknown[], R>(data: TargetData, owner: O,
  select: (value: O) => (...args: A) => R, args: A): R {
  const method = checked(data, () => select(owner));
  return checked(data, () => method.apply(owner, args));
}
function execute(data: TargetData, operation: () => undefined): void {
  idle(data); data.phase = "executing";
  try { data.session.execute(operation); }
  finally { data.phase = "idle"; }
}
function rectangle(rect: Rect2D): Rect2D {
  const result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (![result.x, result.y, result.width, result.height].every(Number.isFinite)) throw new RangeError("Non-finite picture coordinate");
  return result;
}
function color(value: Vec4): Vec4 {
  const result = { x: f(value.x), y: f(value.y), z: f(value.z), w: f(value.w) };
  if (![result.x, result.y, result.z, result.w].every(Number.isFinite)) throw new RangeError("2D color must be finite float32");
  return result;
}
/** RB_SetColor stores bytes: this port uses truncating int32 conversion then byte narrowing. */
function colorByte(value: number): number {
  const scaled = f(value * 255);
  if (!Number.isFinite(scaled) || scaled < -2147483648 || scaled >= 2147483648) {
    throw new RangeError("RB_SetColor exceeds the source int32-to-byte conversion profile");
  }
  return Math.trunc(scaled) & 255;
}
function snapshotBinding(binding: TextureBinding): TextureBinding {
  switch (binding.kind) {
    case "bind-image": return { kind: binding.kind, image: binding.image };
    case "shader-cinematic": return { kind: binding.kind, source: binding.source };
    case "retain-current-texture": return { kind: binding.kind };
  }
}
function snapshotBatch(batch: Extract<SingleTextureBatch, { primitive: "triangles" }>): Extract<SingleTextureBatch, { primitive: "triangles" }>;
function snapshotBatch(batch: Extract<MultitextureBatch, { primitive: "triangles" }>): Extract<MultitextureBatch, { primitive: "triangles" }>;
function snapshotBatch(batch: DrawBatch): DrawBatch;
function snapshotBatch(batch: DrawBatch): DrawBatch {
  const state = { ...batch.state, blend: { ...batch.state.blend },
    ...(batch.state.depthRange === undefined ? {} : { depthRange: [batch.state.depthRange[0], batch.state.depthRange[1]] satisfies readonly [number, number] }),
    ...(batch.state.polygonOffset === undefined ? {} : { polygonOffset: { ...batch.state.polygonOffset } }) };
  const common = { texture: snapshotBinding(batch.texture), indices: [...batch.indices], state };
  if (batch.texturing === "pair") return { ...batch, ...common,
    vertices: batch.vertices.map(vertex => ({ position: { ...vertex.position }, texCoord: { ...vertex.texCoord }, texCoord2: { ...vertex.texCoord2 }, color: { ...vertex.color } })),
    secondTexture: { binding: snapshotBinding(batch.secondTexture.binding), environment: batch.secondTexture.environment } };
  return { ...batch, ...common, vertices: batch.vertices.map(vertex => ({ position: { ...vertex.position }, texCoord: { ...vertex.texCoord }, color: { ...vertex.color } })) };
}
function snapshotSourceStage(stage: SourceStageData): SourceStageData {
  const scratch = stage.scratch.map(cell => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
    rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } }));
  switch (stage.kind) {
    case "generic-pair": case "lightmapped-pair": return { kind: stage.kind, stateBits: stage.stateBits, batch: snapshotBatch(stage.batch), scratch };
    case "generic-single": case "vertex-lit": case "dlight": case "fog": return { kind: stage.kind, stateBits: stage.stateBits, batch: snapshotBatch(stage.batch), scratch };
  }
}
function snapshotSurfaceOperation(operation: SurfaceViewOperation): SurfaceViewOperation {
  switch (operation.kind) {
    case "begin-source-arrays": return { ...operation, positions: operation.positions.map(position => ({ ...position })), slots: [...operation.slots] };
    case "end-source-arrays": case "disable-portal-clip": return { ...operation };
    case "source-tess-stage": return { ...operation, stage: snapshotSourceStage(operation.stage), slots: [...operation.slots] };
    case "log-comment": case "display-list": return { ...operation };
    case "draw": return { kind: operation.kind, batches: operation.batches.map(snapshotBatch) };
    case "source-stage": return { kind: operation.kind, stage: snapshotSourceStage(operation.stage) };
    case "sky-side": return { kind: operation.kind, image: operation.image,
      strips: operation.strips.map(strip => strip.map(vertex => ({ position: { ...vertex.position }, texCoord: { ...vertex.texCoord } }))) };
    case "begin-generic-iterator": return { kind: operation.kind, setArraysOnce: operation.setArraysOnce,
      scratch: operation.scratch.map(cell => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
        rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } })) };
    case "debug-tris": return { kind: operation.kind, input: { whiteImage: operation.input.whiteImage,
      allocation: operation.input.allocation.kind === "tess" ? { ...operation.input.allocation, slots: [...operation.input.allocation.slots] } : { kind: "standalone" },
      positions: operation.input.positions.map(position => ({ ...position })), indices: [...operation.input.indices],
      scratch: operation.input.scratch.map(cell => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
        rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } })) } };
    case "debug-normals": return { kind: operation.kind, input: { whiteImage: operation.input.whiteImage,
      segments: operation.input.segments.map(([start, end]) => [{ ...start }, { ...end }]) } };
    case "depth-range": case "cull": case "sky-box-state": case "polygon-offset": {
      const owned: RenderStateOperation = operation.kind === "depth-range" ? { kind: operation.kind, range: [...operation.range] }
        : operation.kind === "polygon-offset" ? { kind: operation.kind, value: operation.value === null ? null : { ...operation.value } } : { ...operation };
      validateRenderStateOperation(owned); return owned;
    }
    case "shadow-volume": return { ...operation, positions: operation.positions.map(position => ({ ...position })), indices: [...operation.indices] };
    case "begin-debug-surface": return { ...operation };
    case "debug-polygon": return { ...operation, positions: operation.positions.map(position => ({ ...position })) };
    case "entity-beam": return { ...operation, positions: operation.positions.map(position => ({ ...position })) };
    case "entity-axis": return { ...operation, positions: [{ ...operation.positions[0] }, { ...operation.positions[1] }, { ...operation.positions[2] },
      { ...operation.positions[3] }, { ...operation.positions[4] }, { ...operation.positions[5] }] };
    default: throw new Error("Before-view operations must be surfaces, not shadow finish");
  }
}
function snapshotOperation(operation: ViewOperation): ViewOperation {
  if (operation.kind === "render-flares") return { ...operation };
  if (operation.kind !== "shadow-finish") return snapshotSurfaceOperation(operation);
  return { ...operation, positions: [{ ...operation.positions[0] }, { ...operation.positions[1] },
    { ...operation.positions[2] }, { ...operation.positions[3] }] };
}
function snapshotView(view: RenderView): RenderView {
  const beforeView = view.beforeView;
  const result = { viewport: { ...view.viewport }, clear: { depth: view.clear.depth, color: view.clear.color === null ? null : { ...view.clear.color }, stencil: view.clear.stencil },
    ...(beforeView === undefined ? {} : { beforeView: beforeView.map(snapshotSurfaceOperation) }),
    ...(view.clipPlane === undefined ? {} : { clipPlane: snapshotRenderClipPlane(view.clipPlane) }), operations: view.operations.map(snapshotOperation) };
  validateRenderView(result); return result;
}
function isSnapshotView(view: SourceRenderView): view is RenderView {
  return Array.isArray(view.operations) && (view.beforeView === undefined || Array.isArray(view.beforeView));
}
function isSurfaceArray(operations: Iterable<SurfaceViewOperation, unknown, unknown>): operations is readonly SurfaceViewOperation[] {
  return Array.isArray(operations);
}
function snapshotUpload(data: TargetData, input: CinematicUpload): CinematicUpload {
  const upload = checked(data, () => ({ image: input.image, sourceWidth: input.sourceWidth, sourceHeight: input.sourceHeight,
    uploadWidth: input.uploadWidth, uploadHeight: input.uploadHeight, content: input.content, dirty: input.dirty }));
  for (const value of [upload.sourceWidth, upload.sourceHeight, upload.uploadWidth, upload.uploadHeight]) {
    if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) throw new RangeError("Cinematic dimensions must be positive int32");
  }
  if (upload.content.width !== upload.uploadWidth || upload.content.height !== upload.uploadHeight) throw new Error("Cinematic snapshot dimensions disagree");
  return Object.freeze(upload);
}

/** One renderer context, its fixed backend group, and its private image session. */
export class RenderTarget {
  readonly width: number;
  readonly height: number;
  readonly stencilBits: number;
  constructor(readonly images: RendererImageCatalog, backends: readonly [RendererBackend, ...RendererBackend[]]) {
    const first = backends[0];
    this.width = first.width; this.height = first.height; this.stencilBits = first.stencilBits;
    if (!Number.isInteger(this.stencilBits) || this.stencilBits < 0 || this.stencilBits > 32) throw new RangeError("Invalid target stencil precision");
    if (![this.width, this.height].every(value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff)) throw new RangeError("Invalid target dimensions");
    const owned: readonly [RendererBackend, ...RendererBackend[]] = [first, ...backends.slice(1)];
    for (const backend of owned) if (backend.images !== images || backend.width !== this.width || backend.height !== this.height
      || backend.stencilBits !== this.stencilBits) throw new Error("Renderer backend target mismatch");
    const session = images.openSession();
    targets.set(this, { session, backends: Object.freeze(owned), phase: "idle", queue: { kind: "unclaimed" } });
    try { for (const backend of owned) session.attach(backend); session.beginExecution(); }
    catch (error: unknown) {
      for (const backend of owned) { try { backend.close(); } catch { /* Preserve the original construction failure. */ } }
      session.close(); throw error;
    }
  }
  fail(cause: unknown): never { return dataOf(this).session.poison(cause); }
  /** SurfIsOffscreen may issue source backend effects while ordinary commands remain queued. */
  executeSurfaceOperations(operations: Iterable<SurfaceViewOperation, unknown, unknown>): void {
    const data = dataOf(this); idle(data);
    if (data.queue.kind !== "claimed") throw new Error("Source surface execution requires the target's command buffer");
    data.queue.executeSurfaceOperations(operations);
  }
  queuePreparedViews(prepare: SourcePreparedViews, drawSurfs: SourceDrawSortRange | null = null): void {
    const data = dataOf(this); idle(data);
    if (data.queue.kind !== "claimed") throw new Error("Source view submission requires the target's command buffer");
    data.queue.queuePreparedViews(prepare, drawSurfs);
  }
  fixShaderSort(newShader: number): void {
    const data = dataOf(this); idle(data);
    if (data.queue.kind === "claimed") data.queue.fixShaderSort(newShader);
  }
  /** R_SyncRenderThread issues pending commands without a frame-end finish or presentation. */
  syncRenderThread(): void {
    const data = dataOf(this); idle(data);
    if (data.queue.kind !== "claimed") throw new Error("Render-thread synchronization requires the target's command buffer");
    data.queue.syncRenderThread();
  }
  close(): undefined {
    const data = dataOf(this);
    if (data.phase === "closed") return;
    if (data.phase !== "idle") data.session.poison(new Error("Reentrant render target close"));
    let executable = true;
    try { data.session.assertExecutable(); } catch { executable = false; }
    data.phase = "closing";
    if (data.queue.kind === "claimed") data.queue.discard();
    let failure: { readonly cause: unknown } | null = null;
    const dispose = (): undefined => {
      for (const backend of data.backends) {
        try { backend.close(); } catch (cause: unknown) { if (failure === null) failure = { cause }; }
      }
      if (failure !== null && executable) data.session.poison(failure.cause);
    };
    try { if (executable) data.session.execute(dispose); else dispose(); }
    catch (cause: unknown) { if (failure === null) failure = { cause }; }
    data.session.close(); data.phase = "closed";
    if (failure !== null) throw failure.cause;
  }
}

/** Engine-lived frontend queue; coordinate profiles share executed BSS-zero color. */
export class RenderCommandBuffer {
  readonly performance: RendererPerformanceCounters;
  private readonly performanceClock: PictureClock;
  private readonly temporaryMemory: Pick<HunkArena, "allocateTemp" | "freeTemp"> | null;
  private readonly temporaryBuffer: RenderCommandOptions["temporaryBuffer"];
  private timings: RendererFrameTimings = { frontEndMsec: 0, backEndMsec: 0 };
  private readonly commandStorage: RendererCommandStorage;
  private readonly profiles = new Map<CoordinateSpace, Draw2D>();
  private readonly noise = new RendererNoise();
  private readonly rawCalls = new WeakSet<PreparedUiRawCall>();
  private readonly shaderCalls = new WeakSet<ShaderCinematicCall>();
  private options: RenderCommandOptions;
  private color: Vec4 = { x: 0, y: 0, z: 0, w: 0 };
  private finishCalled = false;
  private threadFrameStart = false;
  private readonly thread: RendererCommandThread | null;
  private closed = false;
  constructor(readonly target: RenderTarget, options: RenderCommandOptions) {
    const data = dataOf(target); idle(data);
    unclaimed(data);
    const { clock, identityLight, tess, runtime, print } = options;
    this.performance = options.performance ?? tess.performance;
    this.thread = options.thread ?? null;
    this.performanceClock = options.performanceClock ?? clock;
    this.temporaryMemory = options.temporaryMemory ?? null;
    this.temporaryBuffer = options.temporaryBuffer;
    this.commandStorage = options.commandStorage ?? new RendererCommandStorage(() => tess.frontEndMemory, "isolated");
    if (this.performance !== tess.performance) throw new Error("Render commands require their tessellation performance counters");
    if (!Number.isFinite(identityLight) || identityLight < 0 || identityLight > 1) throw new RangeError("Invalid identity light");
    idle(data);
    unclaimed(data);
    this.options = { clock, identityLight: f(identityLight), tess, runtime, print };
    data.queue = { kind: "claimed", discard: () => { this.discard(); this.closed = true; },
      executeSurfaceOperations: operations => this.executeSurfaceOperations(operations),
      queuePreparedViews: (prepare, drawSurfs) => this.addPreparedViews(prepare, drawSurfs),
      fixShaderSort: newShader => this.fixShaderSort(newShader), syncRenderThread: () => { this.submit(); this.thread?.synchronize(); } };
  }
  private active(): TargetData {
    const data = dataOf(this.target); idle(data);
    if (this.closed) throw new Error("Render command buffer is closed");
    return data;
  }
  private commandMemory(): SourceCommandMemory<CommandReference> {
    return this.commandStorage.memory();
  }
  private discard(): void {
    this.commandStorage.discardReferences();
  }
  get tess(): SourceTessState { return this.options.tess; }
  get runtime(): RendererRuntimeSettings { return this.options.runtime; }
  get frameTimings(): RendererFrameTimings { return this.timings; }
  setIdentityLight(identityLight: number): void {
    this.active();
    if (!Number.isFinite(identityLight) || identityLight < 0 || identityLight > 1) throw new RangeError("Invalid identity light");
    this.options = { ...this.options, identityLight: f(identityLight) };
  }
  beginFrame(): void { this.active(); this.finishCalled = false; this.threadFrameStart = true; }
  drawBuffer(buffer: RendererDrawBuffer): void {
    this.active();
    const memory = this.commandMemory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.drawBufferBytes);
    if (offset === null) return;
    const data = memory.data();
    data.setInt32(offset, SOURCE_RENDER_COMMAND.drawBuffer, true);
    data.setInt32(offset + 4, drawBufferWord(buffer), true);
  }
  /** RE_BeginFrame changes stencil state only after R_SyncRenderThread. */
  setOverdrawMeasurement(enabled: boolean): undefined {
    this.submit();
    this.thread?.synchronize();
    const data = this.active();
    execute(data, () => {
      for (const backend of data.backends) invoke(data, backend, value => value.setOverdrawMeasurement, [enabled]);
      return undefined;
    });
  }
  draw2D(space: CoordinateSpace): Draw2D {
    this.active();
    const existing = this.profiles.get(space);
    if (existing !== undefined) return existing;
    const profile = new Draw2D(this, space); this.profiles.set(space, profile); return profile;
  }
  setColor(value: Vec4 | null): void {
    this.active();
    const memory = this.commandMemory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.setColorBytes);
    if (offset === null) return;
    memory.data().setInt32(offset, SOURCE_RENDER_COMMAND.setColor, true);
    const copy = color(value ?? white);
    this.active();
    const data = memory.data();
    data.setFloat32(offset + 4, copy.x, true); data.setFloat32(offset + 8, copy.y, true);
    data.setFloat32(offset + 12, copy.z, true); data.setFloat32(offset + 16, copy.w, true);
  }
  stretchPixels(rect: Rect2D, uv: TextureRect, picture: PictureAsset | (() => PictureAsset)): void {
    this.active();
    const memory = this.commandMemory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.stretchPicBytes);
    if (offset === null) return;
    memory.data().setInt32(offset, SOURCE_RENDER_COMMAND.stretchPic, true);
    // RE_StretchPic publishes its header before shader lookup can print or register shaders.
    const reserved: CommandReference = { kind: "resolving-stretch-pic" };
    memory.retain(offset, reserved);
    const resolved = typeof picture === "function" ? picture() : picture;
    this.active();
    if (memory.reference(offset) !== reserved) throw new Error("Picture command reservation was replaced during shader lookup");
    memory.retain(offset, { kind: "stretch-pic", picture: resolved });
    const ownedRect = rectangle(rect), ownedUv = { s: uv.s, t: uv.t, s2: uv.s2, t2: uv.t2 };
    if (![ownedUv.s, ownedUv.t, ownedUv.s2, ownedUv.t2].every(Number.isFinite)) throw new RangeError("Non-finite picture UV");
    this.active();
    const data = memory.data();
    data.setFloat32(offset + 8, ownedRect.x, true); data.setFloat32(offset + 12, ownedRect.y, true);
    data.setFloat32(offset + 16, ownedRect.width, true); data.setFloat32(offset + 20, ownedRect.height, true);
    data.setFloat32(offset + 24, ownedUv.s, true); data.setFloat32(offset + 28, ownedUv.t, true);
    data.setFloat32(offset + 32, ownedUv.s2, true); data.setFloat32(offset + 36, ownedUv.t2, true);
  }
  addView(view: RenderView): void {
    this.active();
    const copy = snapshotView(view);
    this.active();
    const memory = this.commandMemory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.drawSurfsBytes);
    if (offset === null) return;
    memory.data().setInt32(offset, SOURCE_RENDER_COMMAND.drawSurfs, true);
    memory.data().setInt32(offset + SOURCE_COMMAND_RELEASE32.drawSurfsCount, 0, true);
    memory.retain(offset, { kind: "view", view: copy });
  }
  addPreparedViews(run: SourcePreparedViews, drawSurfs: SourceDrawSortRange | null = null): void {
    this.active();
    const memory = this.commandMemory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.drawSurfsBytes);
    if (offset === null) return;
    memory.data().setInt32(offset, SOURCE_RENDER_COMMAND.drawSurfs, true);
    // Refdef/viewParms and native pointers retain their owned TypeScript representations.
    // Their reserved ABI bytes are not claimed to be populated native structures.
    memory.retain(offset, { kind: "prepared-views", execute: run, drawSurfs });
    memory.data().setInt32(offset + SOURCE_COMMAND_RELEASE32.drawSurfsCount, drawSurfs?.length ?? 0, true);
  }
  takeScreenshot(command: ScreenshotCommand): boolean {
    const data = this.active();
    const source = command.parameters();
    const memory = this.commandMemory(), offset = memory.reserve(SOURCE_COMMAND_RELEASE32.screenshotBytes);
    if (offset === null) return false;
    memory.data().setInt32(offset, SOURCE_RENDER_COMMAND.screenshot, true);
    if (!data.backends.includes(command.renderer.backend)) throw new Error("Screenshot requires a backend owned by this command target");
    writeScreenshot(memory, offset, command, source);
    return true;
  }
  private drawRange(memory: SourceCommandMemory<CommandReference>, offset: number, range: SourceDrawSortRange): SourceDrawSortRange {
    return {
      get length(): number { return memory.data().getInt32(offset + SOURCE_COMMAND_RELEASE32.drawSurfsCount, true); },
      getSort: index => range.getSort(index), setSort: (index, sort) => range.setSort(index, sort),
      swap: (first, second) => range.swap(first, second),
    };
  }
  private fixShaderSort(newShader: number): void {
    this.active();
    const memory = this.commandMemory();
    let offset = 0;
    for (;;) {
      const data = memory.data();
      switch (data.getInt32(offset, true)) {
        case SOURCE_RENDER_COMMAND.setColor: offset += SOURCE_COMMAND_RELEASE32.setColorBytes; break;
        case SOURCE_RENDER_COMMAND.stretchPic: offset += SOURCE_COMMAND_RELEASE32.stretchPicBytes; break;
        case SOURCE_RENDER_COMMAND.drawSurfs: {
          const count = data.getInt32(offset + SOURCE_COMMAND_RELEASE32.drawSurfsCount, true);
          if (count > 0) {
            const reference = memory.reference(offset);
            if (reference?.kind !== "prepared-views" || reference.drawSurfs === null)
              throw new Error("FixRenderCommandList reached an unavailable draw-surface pointer");
            for (let index = 0; index < count; index++) {
              const sort = reference.drawSurfs.getSort(index) >>> 0;
              const sortedIndex = (sort >>> 17) & 16383;
              if (sortedIndex < newShader) continue;
              const entityNum = (sort >>> 7) & 1023, fogNum = (sort >>> 2) & 31, dlightMap = sort & 3;
              // FixRenderCommandList repacks entityNum without its normal seven-bit shift.
              reference.drawSurfs.setSort(index, (((sortedIndex + 1) << 17) | entityNum | (fogNum << 2) | dlightMap) >>> 0);
            }
          }
          offset += SOURCE_COMMAND_RELEASE32.drawSurfsBytes; break;
        }
        case SOURCE_RENDER_COMMAND.drawBuffer: offset += SOURCE_COMMAND_RELEASE32.drawBufferBytes; break;
        case SOURCE_RENDER_COMMAND.swapBuffers: offset += SOURCE_COMMAND_RELEASE32.swapBuffersBytes; break;
        // The pinned source has no screenshot case and does not bound this scan by used.
        default: return;
      }
    }
  }
  private *commandStream(memory: SourceCommandMemory<CommandReference>): Generator<PendingCommand, void, undefined> {
    let offset = 0;
    for (;;) {
      const data = memory.data();
      switch (data.getInt32(offset, true)) {
        case SOURCE_RENDER_COMMAND.setColor:
          yield { kind: "set-color", color: { x: data.getFloat32(offset + 4, true), y: data.getFloat32(offset + 8, true),
            z: data.getFloat32(offset + 12, true), w: data.getFloat32(offset + 16, true) } };
          offset += SOURCE_COMMAND_RELEASE32.setColorBytes; break;
        case SOURCE_RENDER_COMMAND.stretchPic: {
          const reference = memory.reference(offset);
          if (reference?.kind === "resolving-stretch-pic") yield reference;
          else {
            if (reference?.kind !== "stretch-pic") throw new Error("Renderer command reached an unavailable picture pointer");
            const address = offset;
            yield { kind: "stretch-pic", picture: reference.picture,
              rect: {
                get x(): number { return memory.data().getFloat32(address + 8, true); },
                get y(): number { return memory.data().getFloat32(address + 12, true); },
                get width(): number { return memory.data().getFloat32(address + 16, true); },
                get height(): number { return memory.data().getFloat32(address + 20, true); },
              },
              uv: {
                get s(): number { return memory.data().getFloat32(address + 24, true); },
                get t(): number { return memory.data().getFloat32(address + 28, true); },
                get s2(): number { return memory.data().getFloat32(address + 32, true); },
                get t2(): number { return memory.data().getFloat32(address + 36, true); },
              } };
          }
          offset += SOURCE_COMMAND_RELEASE32.stretchPicBytes; break;
        }
        case SOURCE_RENDER_COMMAND.drawSurfs: {
          const reference = memory.reference(offset);
          if (reference?.kind === "view") yield reference;
          else {
            if (reference?.kind !== "prepared-views") throw new Error("Renderer command reached an unavailable draw-surface pointer");
            yield { kind: "prepared-views", execute: reference.execute,
              drawSurfs: reference.drawSurfs === null ? undefined : this.drawRange(memory, offset, reference.drawSurfs) };
          }
          offset += SOURCE_COMMAND_RELEASE32.drawSurfsBytes; break;
        }
        case SOURCE_RENDER_COMMAND.drawBuffer:
          yield { kind: "draw-buffer", buffer: drawBufferName(data.getInt32(offset + 4, true)) };
          offset += SOURCE_COMMAND_RELEASE32.drawBufferBytes; break;
        case SOURCE_RENDER_COMMAND.swapBuffers: {
          const reference = memory.reference(offset);
          if (reference?.kind !== "swap-buffers") throw new Error("Renderer command reached an unavailable frame presentation callback");
          yield reference;
          offset += SOURCE_COMMAND_RELEASE32.swapBuffersBytes; break;
        }
        case SOURCE_RENDER_COMMAND.screenshot: {
          const reference = memory.reference(offset);
          if (reference?.kind !== "screenshot") throw new Error("Renderer command reached an unavailable screenshot pointer");
          yield { kind: "screenshot", command: reference.command, source: {
            x: data.getInt32(offset + 4, true), y: data.getInt32(offset + 8, true),
            width: data.getInt32(offset + 12, true), height: data.getInt32(offset + 16, true), jpeg: data.getInt32(offset + 24, true) !== 0,
          } };
          offset += SOURCE_COMMAND_RELEASE32.screenshotBytes; break;
        }
        default: return;
      }
    }
  }
  private prepareSlot(data: TargetData, binding: TextureBinding): PreparedTextureSlot {
    if (binding.kind === "retain-current-texture") return { kind: binding.kind };
    if (binding.kind === "bind-image") { this.target.images.requireOwned(binding.image); return binding; }
    const image = checked(data, () => binding.source.image);
    this.target.images.requireOwned(image);
    return { kind: binding.kind, source: binding.source, image };
  }
  private binding(data: TargetData, draws: readonly Pick<PreparedBackendDraw, "applyTexture">[], unit: 0 | 1, binding: PreparedTextureSlot): void {
    let call: ShaderCinematicCall | null = null;
    let operation: ResolvedTextureOperation;
    if (binding.kind === "shader-cinematic") {
      call = invoke(data, binding.source, value => value.prepareAtExecution, []);
      if (call === null) operation = { kind: "retain-current-texture" };
      else {
        if (this.shaderCalls.has(call)) throw new Error("Shader cinematic call was already consumed");
        this.shaderCalls.add(call);
        const prepared = call;
        const upload = snapshotUpload(data, checked(data, () => prepared.upload));
        if (upload.image !== binding.image) throw new Error("Shader cinematic changed its registered scratch identity");
        this.target.images.requireOwned(upload.image);
        operation = { kind: "cinematic-upload", upload };
      }
    } else operation = binding;
    for (const draw of draws) invoke(data, draw, value => value.applyTexture, [unit, operation]);
    if (call !== null) invoke(data, call, value => value.afterShaderUpload, []);
  }
  private batch(data: TargetData, input: DrawBatch | SourceStageData, counts: Counts, allocation: SourceGeometryAllocation = { kind: "standalone" }): void {
    const batch = "kind" in input ? input.batch : input;
    const hasGeometry = batch.indices.length !== 0;
    const prepared: { readonly kind: "source-stage"; readonly draws: readonly PreparedBackendSourceDraw[] }
      | { readonly kind: "draw"; readonly first: PreparedTextureSlot; readonly second: PreparedTextureSlot | null;
        readonly draws: readonly PreparedBackendDraw[] } = "kind" in input
      ? { kind: "source-stage", draws: data.backends.map(backend => invoke(data, backend, value => value.prepareSourceGeometry, [input, allocation])) }
      : { kind: "draw", first: this.prepareSlot(data, batch.texture), second: batch.texturing === "pair" ? this.prepareSlot(data, batch.secondTexture.binding) : null,
        draws: data.backends.map(backend => invoke(data, backend, value => value.prepareGeometry, [input])) };
    if (!hasGeometry && prepared.kind === "draw") return;
    for (const draw of prepared.draws) invoke(data, draw, value => value.begin, []);
    if (prepared.kind === "source-stage") {
      for (const draw of prepared.draws) invoke(data, draw, value => value.prepareTexture, [0]);
      this.binding(data, prepared.draws, 0, this.prepareSlot(data, batch.texture));
      if (batch.texturing === "pair") {
        for (const draw of prepared.draws) invoke(data, draw, value => value.prepareTexture, [1]);
        this.binding(data, prepared.draws, 1, this.prepareSlot(data, batch.secondTexture.binding));
      }
      for (const draw of prepared.draws) invoke(data, draw, value => value.finishTextures, []);
      for (const draw of prepared.draws) {
        const method = checked(data, () => draw.draw);
        const primitives = checked(data, () => this.options.runtime.primitives);
        checked(data, () => method.call(draw, primitives));
      }
    } else {
      this.binding(data, prepared.draws, 0, prepared.first);
      if (prepared.second !== null) this.binding(data, prepared.draws, 1, prepared.second);
      for (const draw of prepared.draws) invoke(data, draw, value => value.draw, []);
    }
    for (const draw of prepared.draws) invoke(data, draw, value => value.cleanup, []);
    if (hasGeometry) counts.batches++;
  }
  private operations(data: TargetData, operations: Iterable<ViewOperation, unknown, unknown>, counts: Counts): void {
    let finished = false;
    for (const operation of checkedValues(data, operations)) {
      if (operation.kind === "shadow-finish") {
        if (finished) throw new Error("View contains more than one shadow finish");
        finished = true;
      }
      if (operation.kind === "render-flares") {
        this.operations(data, checked(data, () => operation.render({
          resetFinishCalled: () => {
            if (data.backends.length !== 1) throw new Error("Source flare depth queries require one backend; use independent renderer contexts for comparison");
            this.finishCalled = false;
          },
          readDepthPixel: (x, y) => {
            if (data.backends.length !== 1) throw new Error("Source flare depth queries require one backend; use independent renderer contexts for comparison");
            return invoke(data, data.backends[0], backend => backend.readDepthPixel, [x, y]);
          },
        })), counts);
      } else if (operation.kind === "draw") {
        for (const batch of operation.batches) this.batch(data, batch, counts);
      } else if (operation.kind === "source-stage") {
        this.batch(data, operation.stage, counts);
      } else if (operation.kind === "source-tess-stage") {
        this.batch(data, operation.stage, counts, { kind: "tess", slots: operation.slots, vertexCount: operation.vertexCount });
      } else if (operation.kind === "debug-tris") {
        this.target.images.requireOwned(operation.input.whiteImage);
        const draws = data.backends.map(backend => invoke(data, backend, value => value.prepareDebugTris, [operation.input]));
        for (const draw of draws) invoke(data, draw, value => value.begin, []);
        for (const draw of draws) {
          const method = checked(data, () => draw.draw);
          const primitives = checked(data, () => this.options.runtime.primitives);
          checked(data, () => method.call(draw, primitives));
        }
        for (const draw of draws) invoke(data, draw, value => value.cleanup, []);
      } else if (operation.kind === "debug-normals") {
        this.target.images.requireOwned(operation.input.whiteImage);
        for (const backend of data.backends) invoke(data, backend, value => value.drawDebugNormals, [operation.input]);
      } else {
        if (operation.kind === "sky-side") this.target.images.requireOwned(operation.image);
        if (operation.kind === "shadow-volume" || operation.kind === "shadow-finish" || operation.kind === "entity-beam" || operation.kind === "entity-axis"
          || operation.kind === "begin-debug-surface") this.target.images.requireOwned(operation.whiteImage);
        for (const backend of data.backends) invoke(data, backend, value => value.drawImmediate, [operation]);
      }
    }
  }
  private executeSurfaceOperations(operations: Iterable<SurfaceViewOperation, unknown, unknown>): void {
    const data = this.active();
    execute(data, () => {
      if (isSurfaceArray(operations)) {
        const owned = checked(data, () => operations.map(snapshotSurfaceOperation));
        this.operations(data, owned, { commands: 0, views: 0, batches: 0 });
      } else this.operations(data, operations, { commands: 0, views: 0, batches: 0 });
      return undefined;
    });
  }
  private view(data: TargetData, view: SourceRenderView, counts: Counts): void {
    const geometry = checked(data, () => ({ viewport: { ...view.viewport },
      ...(view.clipPlane === undefined ? {} : { clipPlane: snapshotRenderClipPlane(view.clipPlane) }) }));
    this.operations(data, checked(data, () => view.beforeView) ?? [], counts);
    const finish = checked(data, () => this.options.runtime.finish);
    if (finish === 1 && !this.finishCalled) {
      for (const backend of data.backends) invoke(data, backend, value => value.finish, []);
      this.finishCalled = true;
    }
    if (finish === 0) this.finishCalled = true;
    this.options.tess.beginDrawingView();
    const header = checked(data, () => {
      const clear = view.clear;
      return { ...geometry, clear: { depth: clear.depth, color: clear.color === null ? null : { ...clear.color }, stencil: clear.stencil } };
    });
    validateRenderViewHeader(header);
    for (const backend of data.backends) invoke(data, backend, value => value.beginView, [header]);
    this.operations(data, checked(data, () => view.operations), counts);
    counts.views++;
  }
  private setGL2D(data: TargetData): void {
    const { tess, clock } = this.options;
    tess.setGL2D(invoke(data, clock, value => value.milliseconds, []));
    const { width, height } = this.target;
    tess.setProjector(position => ({ x: f(position.x * 2 / width - 1), y: f(1 - position.y * 2 / height), z: f(-2 * position.z - 1), w: 1 }));
  }
  private enter2D(data: TargetData): void {
    if (this.options.tess.is2D) return;
    this.setGL2D(data);
    const view: RenderViewState = { viewport: { x: 0, y: 0, width: this.target.width, height: this.target.height }, clear: null };
    for (const backend of data.backends) invoke(data, backend, value => value.beginView, [view]);
  }
  private image(data: TargetData, picture: Extract<PictureAsset, { kind: "image" }>, rect: Rect2D, uv: TextureRect, counts: Counts): void {
    const { identityLight } = this.options, input = this.color, rgb = picture.color.rgb;
    const channel = (value: number): number => rgb === "identity" ? 1 : rgb === "identitylighting" ? Math.trunc(f(identityLight * 255)) / 255
      : rgb === "exactvertex" ? value / 255 : Math.trunc(f(value * identityLight)) / 255;
    const color = { x: channel(input.x), y: channel(input.y), z: channel(input.z),
      w: picture.color.alpha === "vertex" ? input.w / 255 : picture.color.alpha === "identitylighting" ? Math.trunc(f(identityLight * 255)) / 255 : 1 };
    const x = f(rect.x), y = f(rect.y), right = f(x + f(rect.width)), bottom = f(y + f(rect.height));
    const vertex = (px: number, py: number, s: number, t: number) => ({ position: { x: f(px * 2 / this.target.width - 1), y: f(1 - py * 2 / this.target.height), z: -1, w: 1 }, texCoord: { x: f(s), y: f(t) }, color });
    this.batch(data, { texturing: "single", primitive: "triangles", vertices: [vertex(x, y, uv.s, uv.t), vertex(right, y, uv.s2, uv.t), vertex(right, bottom, uv.s2, uv.t2), vertex(x, bottom, uv.s, uv.t2)], indices: [3, 0, 2, 2, 0, 1], texture: picture.texture, state: picture.state }, counts);
  }
  private consume(data: TargetData, counts: Counts, commands: SourceCommandMemory<CommandReference>): void {
    const { tess, identityLight, runtime } = this.options;
    const flush = (): void => {
      if (tess.numIndexes === 0) return;
      const operations = checked(data, () => iteratePictureSurface(tess, this.target.width, this.target.height, identityLight, this.noise, runtime, this.target.stencilBits));
      this.operations(data, operations, counts);
    };
    for (const command of this.commandStream(commands)) {
      if (command.kind === "swap-buffers") {
        flush();
        this.swapBuffers(data, command.present);
        continue;
      }
      counts.commands++;
      if (command.kind === "resolving-stretch-pic") throw new Error("Cannot execute an unfinished picture command during shader lookup");
      if (command.kind === "draw-buffer") {
        // RB_DrawBuffer changes targets without flushing a pending tess surface.
        const clear = checked(data, () => this.options.runtime.clear);
        for (const backend of data.backends) invoke(data, backend, value => value.selectDrawBuffer, [command.buffer, clear]);
        continue;
      }
      if (command.kind === "screenshot") {
        // RB_TakeScreenshotCmd deliberately leaves an unfinished tess surface pending.
        invoke(data, command.command, value => value.execute, [command.source]); continue;
      }
      if (command.kind === "set-color") {
        const c = command.color;
        this.color = { x: colorByte(c.x), y: colorByte(c.y), z: colorByte(c.z), w: colorByte(c.w) };
        continue;
      }
      if (command.kind !== "stretch-pic") {
        flush();
        if (command.kind === "view") this.view(data, command.view, counts);
        else for (const view of checkedValues(data, checked(data, () => command.execute(command.drawSurfs)))) {
          const snapshot = checked(data, () => isSnapshotView(view) ? snapshotView(view) : null);
          if (snapshot !== null) this.view(data, snapshot, counts);
          else this.view(data, view, counts);
        }
        continue;
      }
      this.enter2D(data);
      const { picture, rect, uv } = command;
      if (picture.kind === "image") { flush(); this.image(data, picture, rect, uv, counts); continue; }
      if (picture.material !== tess.material) {
        flush(); tess.selectEntity2D(); tess.beginSurface(picture.material, 0, tess.floatTime);
      }
      if (tess.wouldOverflow(4, 6)) {
        flush(); const material = tess.material;
        if (material === null) throw new Error("Overflowing picture has no material");
        tess.beginSurface(material, tess.fog, tess.floatTime);
      }
      const x = f(rect.x), y = f(rect.y), right = f(x + f(rect.width)), bottom = f(y + f(rect.height));
      const vertex = (px: number, py: number, s: number, t: number) => ({ position: { x: px, y: py, z: 0 }, normal: { x: 0, y: 0, z: 0 }, texCoord: { x: f(s), y: f(t) }, lightmapCoord: { x: 0, y: 0 }, color: { ...this.color } });
      tess.appendGeometry({ vertices: [vertex(x, y, uv.s, uv.t), vertex(right, y, uv.s2, uv.t), vertex(right, bottom, uv.s2, uv.t2), vertex(x, bottom, uv.s, uv.t2)], indices: [3, 0, 2, 2, 0, 1] }, "stretch-pic");
    }
  }
  private executeCommands(data: TargetData, counts: Counts, commands: SourceCommandMemory<CommandReference>, smpFrame: 0 | 1): void {
    if (checked(data, () => this.options.runtime.skipBackEnd)) return;
    const start = invoke(data, this.performanceClock, value => value.milliseconds, []);
    this.options.tess.backEndSmpFrame = this.options.runtime.smpRequested ? smpFrame : 0;
    this.consume(data, counts, commands);
    const end = invoke(data, this.performanceClock, value => value.milliseconds, []);
    this.performance.backEnd.msec = (end - start) | 0;
  }
  private captureIssued(commands: SourceCommandMemory<CommandReference>, smpFrame: 0 | 1,
    resetPerformanceCounters: boolean): IssuedRendererCommands {
    const data = commands.data();
    const bytes = new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const references: { readonly offset: number; readonly reference: RendererCommandReference }[] = [];
    for (let offset = 0; offset < SOURCE_COMMAND_RELEASE32.capacity;) {
      const kind = data.getInt32(offset, true);
      let size: number;
      switch (kind) {
        case SOURCE_RENDER_COMMAND.setColor: size = SOURCE_COMMAND_RELEASE32.setColorBytes; break;
        case SOURCE_RENDER_COMMAND.stretchPic: size = SOURCE_COMMAND_RELEASE32.stretchPicBytes; break;
        case SOURCE_RENDER_COMMAND.drawSurfs: size = SOURCE_COMMAND_RELEASE32.drawSurfsBytes; break;
        case SOURCE_RENDER_COMMAND.drawBuffer: size = SOURCE_COMMAND_RELEASE32.drawBufferBytes; break;
        case SOURCE_RENDER_COMMAND.swapBuffers: size = SOURCE_COMMAND_RELEASE32.swapBuffersBytes; break;
        case SOURCE_RENDER_COMMAND.screenshot: size = SOURCE_COMMAND_RELEASE32.screenshotBytes; break;
        default: return { bytes, references, smpFrame, beginFrame: this.threadFrameStart,
          identityLight: this.options.identityLight, resetPerformanceCounters };
      }
      const reference = commands.reference(offset);
      if (reference !== undefined) references.push({ offset, reference });
      offset += size;
    }
    return { bytes, references, smpFrame, beginFrame: this.threadFrameStart,
      identityLight: this.options.identityLight, resetPerformanceCounters };
  }
  /** Worker-side entry consumes the already issued source list without enqueueing it again. */
  executeIssued(input: IssuedRendererCommands): SubmissionReceipt {
    if (this.thread !== null) throw new Error("A renderer frontend cannot consume its own threaded command list");
    const data = this.active(), commands = this.commandMemory(), destination = commands.data();
    if (input.bytes.byteLength !== destination.byteLength) throw new RangeError("Issued renderer command allocation has the wrong size");
    if (input.beginFrame) this.beginFrame();
    this.setIdentityLight(input.identityLight);
    if (input.resetPerformanceCounters) this.performance.report(0, this.target.width, this.target.height, () => 0, () => undefined);
    commands.discardReferences();
    new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength).set(input.bytes);
    for (const entry of input.references) commands.retain(entry.offset, entry.reference);
    const counts: Counts = { commands: 0, views: 0, batches: 0 };
    execute(data, () => { this.executeCommands(data, counts, commands, input.smpFrame); return undefined; });
    return Object.freeze({ ...counts });
  }
  private swapBuffers(data: TargetData, present: (() => undefined) | null): void {
    if (checked(data, () => this.options.runtime.showImages) !== 0) this.showImages(data);
    if (checked(data, () => this.options.runtime.measureOverdraw) !== 0) {
      const memory = this.temporaryMemory;
      if (memory === null && this.temporaryBuffer === undefined) throw new Error("Overdraw measurement requires renderer temporary memory");
      const bytes = Math.imul(this.target.width, this.target.height);
      const allocation = memory === null ? null : invoke(data, memory, value => value.allocateTemp, [bytes]);
      const temporaryBuffer = this.temporaryBuffer;
      const owned = allocation === null && temporaryBuffer !== undefined ? checked(data, () => temporaryBuffer(bytes)) : null;
      const stencil = checked(data, () => {
        if (allocation !== null) return allocation.bytes;
        if (owned === null) throw new Error("Overdraw temporary memory did not return an allocation");
        return owned.bytes;
      });
      invoke(data, data.backends[0], value => value.readStencilOverdraw, [stencil]);
      let sum = 0;
      for (const value of stencil) sum += value;
      this.performance.backEnd.c_overDraw = f(this.performance.backEnd.c_overDraw + f(sum));
      if (memory !== null && allocation !== null) invoke(data, memory, value => value.freeTemp, [allocation]);
      else if (owned !== null) invoke(data, owned, value => value.release, []);
    }
    if (!this.finishCalled) for (const backend of data.backends) invoke(data, backend, value => value.finish, []);
    for (const backend of data.backends) invoke(data, backend, value => value.drawImmediate,
      [{ kind: "log-comment", text: "***************** RB_SwapBuffers *****************\n\n\n" }]);
    if (present !== null) checked(data, present);
    this.options.tess.endFrame();
  }
  private submission(completion: "mid-frame", present: null): SubmissionReceipt;
  private submission(completion: "frame-end", present: (() => undefined) | null): SubmissionReceipt | null;
  private submission(completion: "mid-frame" | "frame-end", present: (() => undefined) | null): SubmissionReceipt | null {
    const data = this.active(), counts: Counts = { commands: 0, views: 0, batches: 0 };
    const commands = this.commandMemory(), smpFrame = this.options.tess.frontEndSmpFrame;
    if (completion === "frame-end") {
      const offset = commands.reserve(SOURCE_COMMAND_RELEASE32.swapBuffersBytes);
      if (offset === null) return null;
      commands.data().setInt32(offset, SOURCE_RENDER_COMMAND.swapBuffers, true);
      commands.retain(offset, { kind: "swap-buffers", present });
    }
    commands.issue();
    let threadedReceipt: SubmissionReceipt | null = null;
    execute(data, () => {
      this.thread?.beforeIssue();
      this.thread?.synchronize();
      if (completion === "frame-end") this.performance.report(checked(data, () => this.options.runtime.speeds),
        this.target.width, this.target.height, () => invoke(data, this.target.images, value => value.sumOfUsedImages, []),
        text => invoke(data, this.options, value => value.print, [text]));
      if (this.thread === null) this.executeCommands(data, counts, commands, smpFrame);
      else if (!checked(data, () => this.options.runtime.skipBackEnd)) {
        const packet = this.captureIssued(commands, smpFrame, completion === "frame-end");
        threadedReceipt = this.thread.issue(packet);
        this.threadFrameStart = false;
      }
      return undefined;
    });
    if (completion === "frame-end") this.timings = Object.freeze(this.performance.finishFrame());
    return threadedReceipt ?? Object.freeze({ ...counts });
  }
  submit(): SubmissionReceipt { return this.submission("mid-frame", null); }
  submitFrame(present?: () => undefined): SubmissionReceipt | null { return this.submission("frame-end", present ?? null); }
  private showImages(data: TargetData): void {
    this.enter2D(data);
    for (const backend of data.backends) invoke(data, backend, value => value.clearColorBuffer, []);
    for (const backend of data.backends) invoke(data, backend, value => value.finish, []);
    const start = invoke(data, this.performanceClock, value => value.milliseconds, []);
    const images = invoke(data, this.target.images, value => value.registeredImages, []);
    const width = Math.trunc(this.target.width / 20), height = Math.trunc(this.target.height / 15);
    for (const [index, image] of images.entries()) {
      const rect = { x: f((index % 20) * width), y: f(Math.trunc(index / 20) * height), width, height };
      const proportional = checked(data, () => this.options.runtime.showImages) === 2;
      for (const backend of data.backends) invoke(data, backend, value => value.drawShowImage, [image, rect, proportional]);
    }
    for (const backend of data.backends) invoke(data, backend, value => value.finish, []);
    const end = invoke(data, this.performanceClock, value => value.milliseconds, []);
    invoke(data, this.options, value => value.print, [`${(end - start) | 0} msec to draw all images\n`]);
  }
  endRegistration(): undefined {
    if (this.thread !== null) { this.submit(); this.thread.synchronize(); return this.thread.endRegistration(); }
    this.submit();
    const data = this.active();
    execute(data, () => { this.showImages(data); return undefined; });
  }
  stretchRaw(rect: Rect2D, call: PreparedUiRawCall): undefined {
    if (this.thread !== null) { this.submit(); this.thread.synchronize(); return this.thread.stretchRaw(rect, call); }
    const data = this.active();
    execute(data, () => {
      if (this.rawCalls.has(call)) throw new Error("Raw cinematic call was already consumed");
      this.rawCalls.add(call);
      const ownedRect = checked(data, () => rectangle(rect));
      for (const value of [ownedRect.x, ownedRect.y, ownedRect.width, ownedRect.height]) {
        if (value < -0x80000000 || value > 0x7fffffff) throw new RangeError("Raw picture coordinate exceeds int32");
      }
      const rawRect = { x: Math.trunc(ownedRect.x), y: Math.trunc(ownedRect.y), width: Math.trunc(ownedRect.width), height: Math.trunc(ownedRect.height) };
      const captured = checked(data, () => ({ image: call.image, sourceWidth: call.sourceWidth, sourceHeight: call.sourceHeight,
        uploadWidth: call.uploadWidth, uploadHeight: call.uploadHeight, dirty: call.dirty }));
      this.target.images.requireOwned(captured.image);
      const commands = this.commandMemory(), smpFrame = this.options.tess.frontEndSmpFrame;
      commands.issue();
      this.executeCommands(data, { commands: 0, views: 0, batches: 0 }, commands, smpFrame);
      for (const backend of data.backends) invoke(data, backend, value => value.finish, []);
      const start = checked(data, () => this.options.runtime.speeds) !== 0
        ? invoke(data, this.performanceClock, value => value.milliseconds, []) : 0;
      for (const size of [captured.uploadWidth, captured.uploadHeight]) {
        if (!Number.isInteger(size) || size <= 0 || size > 0x40000000 || (size & (size - 1)) !== 0) throw new RangeError("Draw_StretchRaw: size not a power of 2");
      }
      const raw = invoke(data, call, value => value.captureAfterBarrier, []), upload = snapshotUpload(data, checked(data, () => raw.upload));
      if (upload.image !== captured.image || upload.sourceWidth !== captured.sourceWidth || upload.sourceHeight !== captured.sourceHeight
        || upload.uploadWidth !== captured.uploadWidth || upload.uploadHeight !== captured.uploadHeight || upload.dirty !== captured.dirty) throw new Error("Raw cinematic capture changed its pre-barrier metadata");
      const geometry: RawGeometry = { rect: rawRect, uploadWidth: captured.uploadWidth, uploadHeight: captured.uploadHeight, identityLight: this.options.identityLight };
      const draws = data.backends.map(backend => invoke(data, backend, value => value.prepareRawGeometry, [geometry]));
      for (const draw of draws) invoke(data, draw, value => value.uploadCurrent, [upload]);
      if (checked(data, () => this.options.runtime.speeds) !== 0) {
        const end = invoke(data, this.performanceClock, value => value.milliseconds, []);
        invoke(data, this.options, value => value.print,
          [`qglTexSubImage2D ${captured.uploadWidth}, ${captured.uploadHeight}: ${(end - start) | 0} msec\n`]);
      }
      this.setGL2D(data);
      for (const draw of draws) invoke(data, draw, value => value.draw, []);
      invoke(data, raw, value => value.afterUiDraw, []);
      return undefined;
    });
  }
  close(pending: "require-empty" | "discard"): undefined {
    const data = dataOf(this.target);
    if (data.phase === "executing" || data.phase === "closing") data.session.poison(new Error("Reentrant render command close"));
    if (this.closed) return;
    if (pending === "require-empty" && this.commandMemory().used > 0) throw new Error("Render commands remain pending");
    this.discard(); this.closed = true;
  }
}
