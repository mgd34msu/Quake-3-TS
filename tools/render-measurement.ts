// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from "node:crypto";
import type { CinematicUpload } from "../src/render/cinematic-command.ts";
import type { Rect2D } from "../src/render/draw2d.ts";
import type { PreparedBackendDebugTris, PreparedBackendDraw, PreparedBackendRawDraw, PreparedBackendSourceDraw, RawGeometry, RendererBackend,
  RenderViewState, ResolvedTextureOperation } from "../src/render/commands.ts";
import type { CreateImageOperation, ImageInternalFormat, ImageResourceOperation, RendererImage, RendererImageCatalog } from "../src/render/image-resource.ts";
import type { DrawBatch, ImmediateViewOperation, MultitextureBatch, SourceDebugNormals, SourceDebugTris, SourceGeometryAllocation, SourceStageData, TextureFilter, TextureSampling } from "../src/render/types.ts";

export const BACKEND_REQUEST_CHECKSUM_SCOPE = "successful backend-request inputs";

export interface ImageCreationProvenance {
  readonly ordinal: number;
  readonly name: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly uploadWidth: number;
  readonly uploadHeight: number;
  readonly internalFormat: ImageInternalFormat;
  readonly mipmap: boolean;
  readonly levels: readonly { readonly width: number; readonly height: number; readonly payloadSha256: string }[];
  readonly sampling: TextureSampling;
  readonly registrationUnit: 0 | 1;
  readonly payloadSha256: string;
}

export type TextureRequestInput =
  | { readonly kind: "bind-image-request"; readonly image: ImageCreationProvenance }
  | { readonly kind: "retain-current-texture-request" }
  | { readonly kind: "cinematic-upload-request"; readonly image: ImageCreationProvenance;
    readonly sourceWidth: number; readonly sourceHeight: number; readonly uploadWidth: number; readonly uploadHeight: number;
    readonly dirty: boolean; readonly payloadSha256: string };

export type BackendRequestInput =
  | { readonly kind: "create-image-request"; readonly creation: ImageCreationProvenance }
  | { readonly kind: "dlight-image-request"; readonly image: ImageCreationProvenance }
  | { readonly kind: "current-border-color-request"; readonly color: readonly [number, number, number, number] }
  | { readonly kind: "texture-mode-request"; readonly filter: TextureFilter }
  | { readonly kind: "begin-view-request"; readonly input: string }
  | { readonly kind: "begin-draw-request" }
  | { readonly kind: "texture-request"; readonly unit: 0 | 1; readonly operation: TextureRequestInput }
  | { readonly kind: "draw-request"; readonly input: string; readonly indexCount: number }
  | { readonly kind: "immediate-request"; readonly input: string }
  | { readonly kind: "cleanup-request" }
  | { readonly kind: "raw-upload-request"; readonly upload: Extract<TextureRequestInput, { kind: "cinematic-upload-request" }> }
  | { readonly kind: "raw-draw-request"; readonly input: string }
  | { readonly kind: "clear-color-buffer-request" }
  | { readonly kind: "show-image-request"; readonly image: ImageCreationProvenance; readonly rect: Rect2D; readonly proportional: boolean }
  | { readonly kind: "finish-request" };

export interface CompletedBackendMeasurement {
  readonly milliseconds: number;
  readonly successfulBatches: readonly Extract<BackendRequestInput, { kind: "draw-request" }>[];
  readonly requests: readonly BackendRequestInput[];
  readonly inputChecksum: string;
  /** Successful backend-request inputs only; retained bindings and effective texture storage are outside this hash. */
  readonly checksumScope: typeof BACKEND_REQUEST_CHECKSUM_SCOPE;
}

interface ActiveMeasurement {
  milliseconds: number;
  readonly requests: BackendRequestInput[];
  readonly successfulBatches: Extract<BackendRequestInput, { kind: "draw-request" }>[];
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function creationProvenance(creation: CreateImageOperation): ImageCreationProvenance {
  return Object.freeze({ ordinal: creation.image.ordinal, name: creation.image.name,
    sourceWidth: creation.image.sourceWidth, sourceHeight: creation.image.sourceHeight,
    uploadWidth: creation.levels[0].width, uploadHeight: creation.levels[0].height,
    internalFormat: creation.internalFormat, mipmap: creation.mipmap,
    levels: Object.freeze(creation.levels.map(level => Object.freeze({ width: level.width, height: level.height,
      payloadSha256: digest(level.copyPixels()) }))),
    sampling: Object.freeze({ wrap: creation.sampling.wrap, filter: creation.sampling.filter }),
    registrationUnit: creation.registrationUnit, payloadSha256: digest(creation.levels[0].copyPixels()) });
}

function json(value: unknown): string { return JSON.stringify(value); }

function viewInput(view: RenderViewState): string {
  return json({ viewport: { ...view.viewport }, clear: view.clear === null ? null : {
    depth: view.clear.depth, color: view.clear.color === null ? null : { ...view.clear.color }, stencil: view.clear.stencil,
  } });
}

function geometryInput(batch: DrawBatch) {
  const state = { ...batch.state, blend: { ...batch.state.blend },
    ...(batch.state.depthRange === undefined ? {} : { depthRange: [batch.state.depthRange[0], batch.state.depthRange[1]] }),
    ...(batch.state.polygonOffset === undefined ? {} : { polygonOffset: { ...batch.state.polygonOffset } }) };
  const vertices = batch.texturing === "pair" ? batch.vertices.map(vertex => ({
    position: { ...vertex.position }, texCoord: { ...vertex.texCoord }, texCoord2: { ...vertex.texCoord2 }, color: { ...vertex.color },
  })) : batch.vertices.map(vertex => ({
    position: { ...vertex.position }, texCoord: { ...vertex.texCoord }, color: { ...vertex.color },
  }));
  return { texturing: batch.texturing, primitive: batch.primitive,
    ...(batch.primitive === "lines" ? { lineWidth: batch.lineWidth } : {}),
    vertices,
    indices: [...batch.indices], state };
}

function drawInput(batch: DrawBatch) {
  return { ...geometryInput(batch),
    ...(batch.texturing === "pair" ? { secondTextureEnvironment: batch.secondTexture.environment } : {}) };
}

function rawInput(geometry: RawGeometry): string {
  return json({ rect: { ...geometry.rect }, uploadWidth: geometry.uploadWidth, uploadHeight: geometry.uploadHeight,
    identityLight: geometry.identityLight });
}

function freezeTextureRequest(operation: TextureRequestInput): TextureRequestInput { return Object.freeze(operation); }

/** Times genuine backend calls and snapshots their successful request inputs without inferring backend storage. */
export class MeasuredRendererBackend implements RendererBackend {
  readonly images: RendererImageCatalog;
  readonly width: number;
  readonly height: number;
  get stencilBits(): number { return this.backend.stencilBits; }
  private measurement: ActiveMeasurement | null = null;
  private readonly creations = new Map<RendererImage, ImageCreationProvenance>();

  constructor(private readonly backend: RendererBackend) {
    this.images = backend.images;
    this.width = backend.width;
    this.height = backend.height;
  }

  private timed<T>(operation: () => T): T {
    const measurement = this.measurement;
    if (measurement === null) return operation();
    const started = performance.now();
    try { return operation(); }
    finally { measurement.milliseconds += performance.now() - started; }
  }

  setOverdrawMeasurement(enabled: boolean): undefined { return this.timed(() => this.backend.setOverdrawMeasurement(enabled)); }
  selectDrawBuffer(...args: Parameters<RendererBackend["selectDrawBuffer"]>): undefined { return this.timed(() => this.backend.selectDrawBuffer(...args)); }
  readStencilOverdraw(destination: Uint8Array): undefined { return this.timed(() => this.backend.readStencilOverdraw(destination)); }
  readDepthPixel(windowX: number, windowY: number): number { return this.timed(() => this.backend.readDepthPixel(windowX, windowY)); }

  private provenance(image: RendererImage): ImageCreationProvenance {
    const provenance = this.creations.get(image);
    if (provenance === undefined) throw new Error(`Renderer image was not published to the measured backend: ${image.name}`);
    return provenance;
  }

  private uploadInput(upload: CinematicUpload): Extract<TextureRequestInput, { kind: "cinematic-upload-request" }> {
    const request: Extract<TextureRequestInput, { kind: "cinematic-upload-request" }> = Object.freeze({
      kind: "cinematic-upload-request", image: this.provenance(upload.image),
      sourceWidth: upload.sourceWidth, sourceHeight: upload.sourceHeight, uploadWidth: upload.uploadWidth,
      uploadHeight: upload.uploadHeight, dirty: upload.dirty, payloadSha256: digest(upload.content.copyPixels()),
    });
    return request;
  }

  private textureInput(operation: ResolvedTextureOperation): TextureRequestInput {
    switch (operation.kind) {
      case "bind-image": return freezeTextureRequest({ kind: "bind-image-request", image: this.provenance(operation.image) });
      case "retain-current-texture": return freezeTextureRequest({ kind: "retain-current-texture-request" });
      case "cinematic-upload": return this.uploadInput(operation.upload);
    }
  }

  private record(measurement: ActiveMeasurement | null, request: BackendRequestInput): void {
    if (measurement !== null) measurement.requests.push(Object.freeze(request));
  }

  beginMeasurement(): void {
    if (this.measurement !== null) throw new Error("Renderer measurement is already active");
    this.measurement = { milliseconds: 0, requests: [], successfulBatches: [] };
  }

  endMeasurement(): CompletedBackendMeasurement {
    const measurement = this.measurement;
    if (measurement === null) throw new Error("Renderer measurement is not active");
    this.measurement = null;
    const requests = Object.freeze(measurement.requests.slice());
    const successfulBatches = Object.freeze(measurement.successfulBatches.slice());
    const inputChecksum = createHash("sha256").update(json(requests)).digest("hex");
    return Object.freeze({ milliseconds: measurement.milliseconds, successfulBatches, requests, inputChecksum,
      checksumScope: BACKEND_REQUEST_CHECKSUM_SCOPE });
  }

  applyImageResource(operation: ImageResourceOperation): undefined {
    const measurement = this.measurement;
    if (operation.kind === "begin-image" || operation.kind === "upload-image-level"
      || operation.kind === "set-image-upload-descriptor" || operation.kind === "finish-image-upload")
      return this.timed(() => this.backend.applyImageResource(operation));
    if (operation.kind === "create-image") {
      const creation = creationProvenance(operation.creation);
      const result = this.timed(() => this.backend.applyImageResource(operation));
      this.creations.set(operation.creation.image, creation);
      this.record(measurement, { kind: "create-image-request", creation });
      return result;
    }
    if (operation.kind === "texture-mode") {
      const result = this.timed(() => this.backend.applyImageResource(operation));
      this.record(measurement, { kind: "texture-mode-request", filter: operation.filter });
      return result;
    }
    if (operation.kind === "dlight-image") {
      const image = this.provenance(operation.image);
      const result = this.timed(() => this.backend.applyImageResource(operation));
      this.record(measurement, { kind: "dlight-image-request", image });
      return result;
    }
    const values: [number, number, number, number] = [operation.color.x, operation.color.y, operation.color.z, operation.color.w];
    const color: readonly [number, number, number, number] = Object.freeze(values);
    const result = this.timed(() => this.backend.applyImageResource(operation));
    this.record(measurement, { kind: "current-border-color-request", color });
    return result;
  }

  beginView(view: RenderViewState): undefined {
    const measurement = this.measurement;
    const input = viewInput(view);
    const result = this.timed(() => this.backend.beginView(view));
    this.record(measurement, { kind: "begin-view-request", input });
    return result;
  }

  drawImmediate(operation: ImmediateViewOperation): undefined {
    const measurement = this.measurement;
    let input: string;
    switch (operation.kind) {
      case "begin-generic-iterator": case "log-comment": case "display-list": case "begin-source-arrays": case "end-source-arrays": case "disable-portal-clip": input = json(operation); break;
      case "begin-debug-surface": input = json({ kind: operation.kind, cull: operation.cull, whiteImage: this.provenance(operation.whiteImage) }); break;
      case "debug-polygon": input = json({ kind: operation.kind, color: operation.color, positions: operation.positions.map(position => ({ ...position })) }); break;
      case "depth-range": input = json({ kind: operation.kind, range: [...operation.range] }); break;
      case "cull": input = json({ kind: operation.kind, cull: operation.cull }); break;
      case "sky-box-state": input = json({ kind: operation.kind, identityLight: operation.identityLight }); break;
      case "sky-side": input = json({ kind: operation.kind, image: this.provenance(operation.image),
        strips: operation.strips.map(strip => strip.map(vertex => ({ position: { ...vertex.position }, texCoord: { ...vertex.texCoord } }))) }); break;
      case "polygon-offset": input = json({ kind: operation.kind, value: operation.value === null ? null : { ...operation.value } }); break;
      case "entity-axis": case "entity-beam": case "shadow-volume": case "shadow-finish":
        input = json({ kind: operation.kind, positions: operation.positions.map(position => ({ ...position })),
          ...(operation.kind === "shadow-volume" ? { indices: [...operation.indices], mirror: operation.mirror } : {}),
          whiteImage: this.provenance(operation.whiteImage) });
        break;
    }
    const result = this.timed(() => this.backend.drawImmediate(operation));
    this.record(measurement, { kind: "immediate-request", input });
    return result;
  }

  prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const input = json(drawInput(batch));
    const indexCount = batch.indices.length;
    const prepared = this.timed(() => this.backend.prepareGeometry(batch));
    return this.measurePreparedGeometry(prepared, () => input, indexCount);
  }

  prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation): PreparedBackendSourceDraw {
    const input = { ...geometryInput(stage.batch), allocation: allocation.kind === "standalone" ? { kind: allocation.kind }
      : { kind: allocation.kind, slots: [...allocation.slots], vertexCount: allocation.vertexCount },
      sourceStage: stage.kind, stateBits: stage.stateBits, scratch: stage.scratch.map(cell => ({
      color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
      rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 },
    })) };
    const indexCount = stage.batch.indices.length;
    let secondTextureEnvironment: MultitextureBatch["secondTexture"]["environment"] | undefined;
    let delegatedStage = stage;
    if (stage.kind === "generic-pair" || stage.kind === "lightmapped-pair") {
      const batch = stage.batch;
      delegatedStage = { kind: stage.kind, stateBits: stage.stateBits, scratch: stage.scratch, batch: {
        texturing: "pair", primitive: "triangles", vertices: batch.vertices, indices: batch.indices, state: batch.state,
        get texture() { return batch.texture; },
        get secondTexture() {
          const second = batch.secondTexture;
          return {
            get binding() { return second.binding; },
            get environment() { const value = second.environment; secondTextureEnvironment = value; return value; },
          };
        },
      } };
    }
    const prepared = this.timed(() => this.backend.prepareSourceGeometry(delegatedStage, allocation));
    return {
      ...this.measurePreparedGeometry(prepared, primitives => json({ ...input,
        ...(secondTextureEnvironment === undefined ? {} : { secondTextureEnvironment }), primitives }), indexCount),
      prepareTexture: unit => this.timed(() => prepared.prepareTexture(unit)),
      finishTextures: () => this.timed(() => prepared.finishTextures()),
    };
  }

  prepareDebugTris(tris: SourceDebugTris): PreparedBackendDebugTris {
    const input = { kind: "debug-tris", whiteImage: this.provenance(tris.whiteImage),
      positions: tris.positions.map(position => ({ ...position })), indices: [...tris.indices],
      scratch: tris.scratch.map(cell => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
        rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } })) };
    const indexCount = tris.indices.length;
    const prepared = this.timed(() => this.backend.prepareDebugTris(tris));
    return {
      begin: () => {
        const measurement = this.measurement;
        const result = this.timed(() => prepared.begin());
        this.record(measurement, { kind: "begin-draw-request" });
        return result;
      },
      draw: primitives => {
        const measurement = this.measurement;
        const snapshot = json({ ...input, primitives });
        const result = this.timed(() => prepared.draw(primitives));
        if (measurement !== null) {
          const request: Extract<BackendRequestInput, { kind: "draw-request" }> = Object.freeze({
            kind: "draw-request", input: snapshot, indexCount,
          });
          measurement.requests.push(request);
          if (indexCount !== 0) measurement.successfulBatches.push(request);
        }
        return result;
      },
      cleanup: () => {
        const measurement = this.measurement;
        const result = this.timed(() => prepared.cleanup());
        this.record(measurement, { kind: "cleanup-request" });
        return result;
      },
    };
  }

  drawDebugNormals(normals: SourceDebugNormals): undefined {
    const measurement = this.measurement;
    const input = json({ kind: "debug-normals", whiteImage: this.provenance(normals.whiteImage),
      segments: normals.segments.map(([start, end]) => [{ ...start }, { ...end }]) });
    const result = this.timed(() => this.backend.drawDebugNormals(normals));
    this.record(measurement, { kind: "immediate-request", input });
    return result;
  }

  private measurePreparedGeometry<A extends [] | [primitives: number]>(
    prepared: Omit<PreparedBackendDraw, "draw"> & { draw(...args: A): undefined },
    input: (...args: A) => string, indexCount: number,
  ): Omit<PreparedBackendDraw, "draw"> & { draw(...args: A): undefined } {
    return {
      begin: () => {
        const measurement = this.measurement;
        const result = this.timed(() => prepared.begin());
        this.record(measurement, { kind: "begin-draw-request" });
        return result;
      },
      applyTexture: (unit: 0 | 1, operation: ResolvedTextureOperation) => {
        const measurement = this.measurement;
        const snapshot = this.textureInput(operation);
        const result = this.timed(() => prepared.applyTexture(unit, operation));
        this.record(measurement, { kind: "texture-request", unit, operation: snapshot });
        return result;
      },
      draw: (...args: A) => {
        const measurement = this.measurement;
        const snapshot = input(...args);
        const result = this.timed(() => prepared.draw(...args));
        if (measurement !== null) {
          const request: Extract<BackendRequestInput, { kind: "draw-request" }> = Object.freeze({
            kind: "draw-request", input: snapshot, indexCount,
          });
          measurement.requests.push(request);
          if (indexCount !== 0) measurement.successfulBatches.push(request);
        }
        return result;
      },
      cleanup: () => {
        const measurement = this.measurement;
        const result = this.timed(() => prepared.cleanup());
        this.record(measurement, { kind: "cleanup-request" });
        return result;
      },
    };
  }

  prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    const input = rawInput(geometry);
    const prepared = this.timed(() => this.backend.prepareRawGeometry(geometry));
    return {
      uploadCurrent: upload => {
        const measurement = this.measurement;
        const snapshot = this.uploadInput(upload);
        const result = this.timed(() => prepared.uploadCurrent(upload));
        this.record(measurement, { kind: "raw-upload-request", upload: snapshot });
        return result;
      },
      draw: () => {
        const measurement = this.measurement;
        const result = this.timed(() => prepared.draw());
        this.record(measurement, { kind: "raw-draw-request", input });
        return result;
      },
    };
  }

  clearColorBuffer(): undefined {
    const measurement = this.measurement;
    const result = this.timed(() => this.backend.clearColorBuffer());
    this.record(measurement, { kind: "clear-color-buffer-request" });
    return result;
  }

  drawShowImage(image: RendererImage, rect: Rect2D, proportional: boolean): undefined {
    const measurement = this.measurement;
    const provenance = this.provenance(image), inputRect = Object.freeze({ ...rect });
    const result = this.timed(() => this.backend.drawShowImage(image, rect, proportional));
    this.record(measurement, { kind: "show-image-request", image: provenance, rect: inputRect, proportional });
    return result;
  }

  finish(): undefined {
    const measurement = this.measurement;
    const result = this.timed(() => this.backend.finish());
    this.record(measurement, { kind: "finish-request" });
    return result;
  }

  close(): undefined { return this.backend.close(); }
}
