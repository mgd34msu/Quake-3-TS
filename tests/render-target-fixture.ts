import type { DrawBatch, ImmediateViewOperation, RenderView, SourceDebugNormals, SourceDebugTris, SourceGeometryAllocation, SourceRenderView, SourceStageData, SurfaceViewOperation, TextureBinding, TextureSampling, ViewOperation } from "../src/render/types.ts";
import { snapshotRenderClipPlane } from "../src/render/types.ts";
import type { Rect2D } from "../src/render/draw2d.ts";
import type { ImageResourceOperation, ImageSource, RendererImage, RendererImageCatalog } from "../src/render/image-resource.ts";
import type { PreparedBackendDebugTris, PreparedBackendDraw, PreparedBackendRawDraw, PreparedBackendSourceDraw, RawGeometry, RendererBackend, RenderViewState, ResolvedTextureOperation } from "../src/render/commands.ts";

export interface TestTextureSource {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly internalFormat: ImageSource["internalFormat"];
  readonly sampling: TextureSampling;
  readonly registrationUnit: ImageSource["registrationUnit"];
}
export function publishTexture(images: RendererImageCatalog, source: TestTextureSource): RendererImage {
  return images.create({ name: source.name, sourceWidth: source.width, sourceHeight: source.height,
    levels: [{ width: source.width, height: source.height, pixels: source.pixels }], mipmap: false,
    internalFormat: source.internalFormat, sampling: source.sampling, registrationUnit: source.registrationUnit });
}
function staticBinding(binding: TextureBinding): ResolvedTextureOperation {
  if (binding.kind === "shader-cinematic") throw new Error("Static fixture submission cannot execute a cinematic source");
  return binding;
}
/** Analytic backend tests only. Live engine work must consume the target queue. */
export function executeStaticBatch(backend: RendererBackend, batch: DrawBatch): undefined {
  const first = staticBinding(batch.texture), second = batch.texturing === "pair" ? staticBinding(batch.secondTexture.binding) : null;
  const draw = backend.prepareGeometry(batch);
  if (batch.indices.length === 0) return;
  draw.begin(); draw.applyTexture(0, first);
  if (second !== null) draw.applyTexture(1, second);
  draw.draw(); draw.cleanup();
}
export interface RecordedView { readonly state: RenderViewState; readonly batches: readonly DrawBatch[] }
interface MutableView { readonly state: RenderViewState; readonly batches: DrawBatch[] }

export function* recordPreparedViews(views: Iterable<SourceRenderView, unknown, unknown>, recorded: RenderView[]): Generator<SourceRenderView, void, unknown> {
  function* recordOperations<T>(operations: Iterable<T, unknown, unknown>, output: T[]): Generator<T, void, unknown> {
    for (const operation of operations) { output.push(operation); yield operation; }
  }
  for (const view of views) {
    const operations: ViewOperation[] = [], beforeView: SurfaceViewOperation[] = [];
    const header = { viewport: view.viewport, ...(view.clipPlane === undefined ? {} : { clipPlane: view.clipPlane }) };
    let clear: RenderView["clear"] | undefined;
    const readClear = (): RenderView["clear"] => {
      if (clear === undefined) {
        const value = view.clear;
        clear = { ...value, color: value.color === null ? null : { ...value.color } };
      }
      return clear;
    };
    recorded.push({ ...header, get clear() { return readClear(); }, operations, ...(view.beforeView === undefined ? {} : { beforeView }) });
    yield { ...header, get clear() { return readClear(); }, operations: recordOperations(view.operations, operations),
      ...(view.beforeView === undefined ? {} : { beforeView: recordOperations(view.beforeView, beforeView) }) };
  }
}

/** Observes successful real backend submissions without resolving or replaying slots. */
export class BatchRecordingBackend implements RendererBackend {
  readonly images: RendererImageCatalog;
  readonly width: number;
  readonly height: number;
  readonly stencilBits: number;
  readonly rawDraws: RawGeometry[] = [];
  readonly showImageDraws: { readonly image: RendererImage; readonly rect: Rect2D; readonly proportional: boolean }[] = [];
  colorBufferClears = 0;
  readonly debugTris: { readonly input: SourceDebugTris; readonly primitives: number }[] = [];
  readonly debugNormals: SourceDebugNormals[] = [];
  private readonly views: MutableView[] = [];
  private readonly initial: DrawBatch[] = [];
  constructor(readonly delegate: RendererBackend) {
    this.images = delegate.images; this.width = delegate.width; this.height = delegate.height; this.stencilBits = delegate.stencilBits;
  }
  applyImageResource(operation: ImageResourceOperation): undefined { return this.delegate.applyImageResource(operation); }
  selectDrawBuffer(...args: Parameters<RendererBackend["selectDrawBuffer"]>): undefined { return this.delegate.selectDrawBuffer(...args); }
  setOverdrawMeasurement(enabled: boolean): undefined { return this.delegate.setOverdrawMeasurement(enabled); }
  readStencilOverdraw(destination: Uint8Array): undefined { return this.delegate.readStencilOverdraw(destination); }
  readDepthPixel(windowX: number, windowY: number): number { return this.delegate.readDepthPixel(windowX, windowY); }
  beginView(state: RenderViewState): undefined {
    this.delegate.beginView(state);
    this.views.push({ state: { viewport: { ...state.viewport }, clear: state.clear === null ? null : {
      depth: state.clear.depth, color: state.clear.color === null ? null : { ...state.clear.color }, stencil: state.clear.stencil },
      ...(state.clipPlane === undefined ? {} : { clipPlane: snapshotRenderClipPlane(state.clipPlane) }) }, batches: [] });
  }
  drawImmediate(operation: ImmediateViewOperation): undefined { return this.delegate.drawImmediate(operation); }
  prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const prepared = this.delegate.prepareGeometry(batch);
    let drawn = false;
    return {
      begin: () => prepared.begin(),
      applyTexture: (unit, operation) => prepared.applyTexture(unit, operation),
      draw: () => {
        if (drawn) throw new Error("Recorded draw was already consumed");
        const view = this.views.at(-1);
        prepared.draw(); drawn = true;
        if (view === undefined) this.initial.push(batch); else view.batches.push(batch);
      },
      cleanup: () => prepared.cleanup(),
    };
  }
  prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    const prepared = this.delegate.prepareSourceGeometry(stage, allocation);
    let drawn = false;
    return {
      begin: () => prepared.begin(),
      prepareTexture: unit => prepared.prepareTexture(unit),
      applyTexture: (unit, operation) => prepared.applyTexture(unit, operation),
      finishTextures: () => prepared.finishTextures(),
      draw: primitives => {
        if (drawn) throw new Error("Recorded source draw was already consumed");
        const view = this.views.at(-1);
        prepared.draw(primitives); drawn = true;
        if (view === undefined) this.initial.push(stage.batch); else view.batches.push(stage.batch);
      },
      cleanup: () => prepared.cleanup(),
    };
  }
  prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    const prepared = this.delegate.prepareRawGeometry(geometry);
    let drawn = false;
    return {
      uploadCurrent: upload => prepared.uploadCurrent(upload),
      draw: () => {
        if (drawn) throw new Error("Recorded raw draw was already consumed");
        prepared.draw(); drawn = true;
        this.rawDraws.push({ ...geometry, rect: { ...geometry.rect } });
        this.views.push({ state: { viewport: { x: 0, y: 0, width: this.width, height: this.height }, clear: null }, batches: [] });
      },
    };
  }
  prepareDebugTris(input: SourceDebugTris): PreparedBackendDebugTris {
    const snapshot: SourceDebugTris = { whiteImage: input.whiteImage,
      allocation: input.allocation.kind === "standalone" ? { kind: "standalone" }
        : { kind: "tess", slots: [...input.allocation.slots], vertexCount: input.allocation.vertexCount },
      positions: input.positions.map(position => ({ ...position })), indices: [...input.indices],
      scratch: input.scratch.map(cell => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
        rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } })) };
    const prepared = this.delegate.prepareDebugTris(input);
    let drawn = false;
    return {
      begin: () => prepared.begin(),
      draw: primitives => {
        if (drawn) throw new Error("Recorded debug draw was already consumed");
        prepared.draw(primitives); drawn = true;
        this.debugTris.push({ input: snapshot, primitives });
      },
      cleanup: () => prepared.cleanup(),
    };
  }
  drawDebugNormals(input: SourceDebugNormals): undefined {
    const snapshot: SourceDebugNormals = { whiteImage: input.whiteImage,
      segments: input.segments.map(([start, end]) => [{ ...start }, { ...end }]) };
    this.delegate.drawDebugNormals(input);
    this.debugNormals.push(snapshot);
  }
  clearColorBuffer(): undefined {
    this.delegate.clearColorBuffer();
    this.colorBufferClears++;
  }
  drawShowImage(image: RendererImage, rect: Rect2D, proportional: boolean): undefined {
    const input = { image, rect: { ...rect }, proportional };
    this.delegate.drawShowImage(image, rect, proportional);
    this.showImageDraws.push(input);
  }
  finish(): undefined { return this.delegate.finish(); }
  close(): undefined { return this.delegate.close(); }
  get initialBatches(): readonly DrawBatch[] { return this.initial.slice(); }
  trace(): readonly RecordedView[] { return this.views.map(view => ({ state: view.state, batches: view.batches.slice() })); }
}
