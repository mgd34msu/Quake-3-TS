/*
 * CPU implementation of the fixed-function state used by Quake III Arena
 * code/renderer/tr_backend.c GL_State/GL_Cull and tr_image.c R_CreateImage.
 * Debug polygons follow tr_main.c R_DebugPolygon/R_DebugGraphics.
 * Original renderer copyright (C) 1999-2005 Id Software, Inc.
 * Clipping and rasterization are new TypeScript algorithms.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { blend, byte, clamp, colorWord, LITTLE_ENDIAN, passesAlpha, runTriangleRows, sampleBound, sampleLineBound, stencilFragment, textureColor, textureHasAlpha } from "./triangle-kernel.ts";
import type { BoundTexture, Framebuffer, Sample, TexturePlaneDerivative, TextureStorage, TriangleSetup, UploadedTexture } from "./triangle-kernel.ts";
import type { CpuTriangleExecution } from "./triangle-execution.ts";
import type { Vec2, Vec4 } from "../../core/math.ts";
import type { BlendFactor, DrawBatch, ImmediateViewOperation, MultitextureVertex, RenderState, RenderViewport, SingleTextureBatch, SourceDebugNormals, SourceDebugTris, SourceGeometryAllocation, SourceStageCell, SourceStageData, TextureEnvironment, TextureFilter, TextureSampling } from "../types.ts";
import { RenderClipState, validateRenderStateOperation, validateRenderView } from "../types.ts";
import type { BeginImageOperation, RendererImageCatalog, RendererImage, ImageInternalFormat, ImageResourceOperation, ImageUploadPhase } from "../image-resource.ts";
import { RgbaSnapshot } from "../image-resource.ts";
import type { CinematicUpload } from "../cinematic-command.ts";
import type { Rect2D } from "../draw2d.ts";
import type { RendererBackend, RendererDrawBuffer, PreparedBackendDebugTris, PreparedBackendDraw, PreparedBackendRawDraw, PreparedBackendSourceDraw, RawGeometry, RenderViewState, ResolvedTextureOperation } from "../commands.ts";
import { emitSourceTriangleStrips, sourcePrimitiveMode } from "../primitives.ts";
import { SourceStateBit, sourceStateBits, sourceStateChanges } from "../source-state.ts";
import { rasterizeAliasedLine } from "./lines.ts";
import type { LineFragment } from "./lines.ts";

interface ScreenVertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly inverseW: number;
  readonly texCoord: Vec2;
  readonly texCoord2: Vec2;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

type ClipPlane = "left" | "right" | "bottom" | "top" | "near" | "far" | Vec4;
const CLIP_PLANES: readonly ClipPlane[] = ["left", "right", "bottom", "top", "near", "far"];
/** Precision used for the polygon-offset resolvable-depth unit, not depth quantization. */
export const CPU_OFFSET_DEPTH_BITS = 24;
const COPY_PIXELS = RgbaSnapshot.prototype.copyPixels;

function finiteVector(value: Vec4): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.z) && Number.isFinite(value.w);
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height * 8)) {
    throw new RangeError("Image dimensions must be positive integers with a safe storage size");
  }
}

function validateBatch(batch: DrawBatch, images: RendererImageCatalog, validateBindings: boolean): void {
  if (batch.primitive !== "triangles" && batch.primitive !== "lines") throw new RangeError("CPU primitive is invalid");
  if (batch.texturing !== "single" && batch.texturing !== "pair") throw new RangeError("CPU texturing kind is invalid");
  if (validateBindings) {
    const blendFactors: readonly BlendFactor[] = ["zero", "one", "src-color", "one-minus-src-color", "dst-color", "one-minus-dst-color",
      "src-alpha", "one-minus-src-alpha", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturate"];
    if (!blendFactors.includes(batch.state.blend.source) || !blendFactors.includes(batch.state.blend.destination)
      || batch.state.blend.destination === "src-alpha-saturate") throw new RangeError("CPU blend factors are invalid");
    if (!["less-equal", "equal", "always"].includes(batch.state.depthTest) || typeof batch.state.depthWrite !== "boolean"
      || !["none", "back", "front"].includes(batch.state.cull) || !["none", "gt0", "lt128", "ge128"].includes(batch.state.alphaTest)) throw new RangeError("CPU render state is invalid");
    if (batch.state.depthRange !== undefined && !batch.state.depthRange.every(Number.isFinite)) throw new RangeError("Depth range must be finite");
    if (batch.state.polygonOffset !== undefined && ![batch.state.polygonOffset.factor, batch.state.polygonOffset.units].every(value => Number.isFinite(Math.fround(value)))) throw new RangeError("Polygon offset must be finite float32");
  }
  if (batch.indices.length % (batch.primitive === "lines" ? 2 : 3) !== 0) throw new RangeError("Primitive index count has incomplete vertices");
  if (batch.primitive === "lines" && (!Number.isFinite(batch.lineWidth) || batch.lineWidth <= 0 || batch.lineWidth > Number.MAX_SAFE_INTEGER / 4)) throw new RangeError("Line width must be positive, finite, and permit safe pixel stepping");
  for (const index of batch.indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= batch.vertices.length) {
      throw new RangeError("Triangle vertex index is outside the vertex array");
    }
  }
  for (const vertex of batch.vertices) {
    if (vertex === undefined || !finiteVector(vertex.position) || !finiteVector(vertex.color)
      || !Number.isFinite(vertex.texCoord.x) || !Number.isFinite(vertex.texCoord.y)) {
      throw new RangeError("Vertex attributes must be finite");
    }
  }
  if (batch.texturing === "pair") for (const vertex of batch.vertices) {
    if (!Number.isFinite(vertex.texCoord2.x) || !Number.isFinite(vertex.texCoord2.y)) throw new RangeError("Secondary vertex coordinates must be finite");
  }
  if (validateBindings) {
    const bindings = batch.texturing === "pair" ? [batch.texture, batch.secondTexture.binding] : [batch.texture];
    for (const binding of bindings) {
      if (binding.kind === "bind-image") images.requireOwned(binding.image);
      else if (binding.kind === "shader-cinematic") images.requireOwned(binding.source.image);
      else if (binding.kind !== "retain-current-texture") throw new RangeError("CPU texture binding is invalid");
    }
  }
  if (validateBindings && batch.texturing === "pair" && !["modulate", "add", "replace"].includes(batch.secondTexture.environment)) throw new RangeError("CPU texture environment is invalid");
}

function snapshotState(state: RenderState): RenderState {
  return { ...state, blend: { ...state.blend },
    ...(state.depthRange === undefined ? {} : { depthRange: [state.depthRange[0], state.depthRange[1]] satisfies readonly [number, number] }),
    ...(state.polygonOffset === undefined ? {} : { polygonOffset: { ...state.polygonOffset } }) };
}

function snapshotSourceCells(scratch: readonly SourceStageCell[]): readonly SourceStageCell[] {
  return scratch.map(cell => ({ color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 },
    rawTexCoord: { ...cell.rawTexCoord }, rawTexCoord2: { ...cell.rawTexCoord2 } }));
}

function snapshotBatch(batch: DrawBatch): DrawBatch {
  const state = snapshotState(batch.state);
  if (batch.texturing === "pair") return { ...batch, state, indices: [...batch.indices],
    vertices: batch.vertices.map(vertex => ({ position: { ...vertex.position }, color: { ...vertex.color }, texCoord: { ...vertex.texCoord }, texCoord2: { ...vertex.texCoord2 } })),
    texture: { ...batch.texture }, secondTexture: { ...batch.secondTexture, binding: { ...batch.secondTexture.binding } } };
  return { ...batch, state, indices: [...batch.indices], texture: { ...batch.texture },
    vertices: batch.vertices.map(vertex => ({ position: { ...vertex.position }, color: { ...vertex.color }, texCoord: { ...vertex.texCoord } })) };
}

function snapshotSourceBatch(batch: SourceStageData["batch"], state: RenderState): DrawBatch {
  const indices = [...batch.indices];
  if (batch.texturing === "pair") return { texturing: "pair", primitive: "triangles", state, indices,
    vertices: batch.vertices.map(vertex => ({ position: { ...vertex.position }, color: { ...vertex.color }, texCoord: { ...vertex.texCoord }, texCoord2: { ...vertex.texCoord2 } })),
    get texture() { return batch.texture; },
    secondTexture: {
      get binding() { return batch.secondTexture.binding; },
      get environment() { return batch.secondTexture.environment; },
    } };
  return { texturing: "single", primitive: "triangles", state, indices,
    vertices: batch.vertices.map(vertex => ({ position: { ...vertex.position }, color: { ...vertex.color }, texCoord: { ...vertex.texCoord } })),
    get texture() { return batch.texture; } };
}

function indexedVertex(batch: DrawBatch, offset: number): MultitextureVertex {
  const index = batch.indices[offset];
  if (index === undefined) throw new RangeError("Missing triangle index");
  if (batch.texturing === "pair") {
    const vertex = batch.vertices[index];
    if (vertex === undefined) throw new RangeError("Missing triangle vertex");
    return vertex;
  }
  const vertex = batch.vertices[index];
  if (vertex === undefined) throw new RangeError("Missing triangle vertex");
  return { ...vertex, texCoord2: { x: 0, y: 0 } };
}

function planeDistance(vertex: MultitextureVertex, plane: ClipPlane): number {
  const p = vertex.position;
  if (typeof plane !== "string") return p.x * plane.x + p.y * plane.y + p.z * plane.z + p.w * plane.w;
  switch (plane) {
    case "left": return p.w + p.x;
    case "right": return p.w - p.x;
    case "bottom": return p.w + p.y;
    case "top": return p.w - p.y;
    case "near": return p.w + p.z;
    case "far": return p.w - p.z;
  }
}

function intersect(a: MultitextureVertex, b: MultitextureVertex, da: number, db: number, plane: ClipPlane): MultitextureVertex {
  // Symmetric weights give the same intersection for a shared edge in either direction.
  const scale = Math.max(Math.abs(da), Math.abs(db));
  const ad = Math.abs(da) / scale;
  const bd = Math.abs(db) / scale;
  const aw = bd / (ad + bd);
  const bw = ad / (ad + bd);
  const coordinate = (left: number, right: number): number => {
    const anchor = Math.min(left, right);
    return anchor + (left - anchor) * aw + (right - anchor) * bw;
  };
  const w = a.position.w * aw + b.position.w * bw;
  let x = a.position.x * aw + b.position.x * bw;
  let y = a.position.y * aw + b.position.y * bw;
  let z = a.position.z * aw + b.position.z * bw;
  switch (plane) {
    case "left": x = -w; break;
    case "right": x = w; break;
    case "bottom": y = -w; break;
    case "top": y = w; break;
    case "near": z = -w; break;
    case "far": z = w; break;
  }
  return {
    position: { x, y, z, w },
    texCoord: { x: coordinate(a.texCoord.x, b.texCoord.x), y: coordinate(a.texCoord.y, b.texCoord.y) },
    texCoord2: { x: coordinate(a.texCoord2.x, b.texCoord2.x), y: coordinate(a.texCoord2.y, b.texCoord2.y) },
    color: {
      x: a.color.x * aw + b.color.x * bw,
      y: a.color.y * aw + b.color.y * bw,
      z: a.color.z * aw + b.color.z * bw,
      w: a.color.w * aw + b.color.w * bw,
    },
  };
}

function clipPolygon(vertices: readonly MultitextureVertex[], extraPlane: Vec4 | null): readonly MultitextureVertex[] {
  let polygon = [...vertices];
  let magnitude = 0;
  for (const vertex of polygon) {
    const p = vertex.position;
    magnitude = Math.max(magnitude, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z), Math.abs(p.w));
  }
  if (magnitude > Number.MAX_VALUE / 4) {
    // Homogeneous coordinates admit a common scale. Bound the plane sums
    // without rejecting otherwise finite input or overflowing intersections.
    polygon = polygon.map((vertex) => ({
      position: { x: vertex.position.x / magnitude, y: vertex.position.y / magnitude,
        z: vertex.position.z / magnitude, w: vertex.position.w / magnitude },
      color: vertex.color,
      texCoord: vertex.texCoord,
      texCoord2: vertex.texCoord2,
    }));
  }
  for (const plane of extraPlane === null ? CLIP_PLANES : [...CLIP_PLANES, extraPlane]) {
    const last = polygon[polygon.length - 1];
    if (last === undefined) return polygon;
    if (polygon.every((vertex) => planeDistance(vertex, plane) >= 0)) continue;
    const output: MultitextureVertex[] = [];
    let previous = last;
    let previousDistance = planeDistance(previous, plane);
    for (const current of polygon) {
      const distance = planeDistance(current, plane);
      if ((distance >= 0) !== (previousDistance >= 0)) {
        output.push(intersect(previous, current, previousDistance, distance, plane));
      }
      if (distance >= 0) output.push(current);
      previous = current;
      previousDistance = distance;
    }
    polygon = output;
  }
  // All six planes permit w=0 only at the homogeneous origin. It has no
  // projected area; remove it before division instead of inventing an epsilon plane.
  return polygon.filter((vertex) => vertex.position.w > 0);
}

function subpixel(value: number, scale: number): number {
  const scaled = Math.fround(value) * scale, lower = Math.floor(scaled), fraction = scaled - lower;
  return (fraction < 0.5 || (fraction === 0.5 && lower % 2 === 0) ? lower : lower + 1) / scale;
}

function project(vertex: MultitextureVertex, viewport: RenderViewport, wScale: number, subpixelScale: number): ScreenVertex {
  const p = vertex.position;
  // A common scale preserves all perspective ratios and bounds reciprocals.
  const inverseW = wScale / p.w;
  return {
    x: subpixel(viewport.x + (p.x / p.w + 1) * viewport.width * 0.5, subpixelScale),
    y: subpixel(viewport.y + (1 - p.y / p.w) * viewport.height * 0.5, subpixelScale),
    z: p.z / p.w,
    inverseW,
    texCoord: vertex.texCoord,
    texCoord2: vertex.texCoord2,
    r: vertex.color.x * inverseW,
    g: vertex.color.y * inverseW,
    b: vertex.color.z * inverseW,
    a: vertex.color.w * inverseW,
  };
}

function edge(a: ScreenVertex, b: ScreenVertex, x: number, y: number): number {
  return (a.y - b.y) * x + (b.x - a.x) * y + (a.x * b.y - a.y * b.x);
}

function lowerLeft(a: ScreenVertex, b: ScreenVertex): boolean {
  return b.y < a.y || (b.y === a.y && b.x < a.x);
}

type CurrentTexCoord = { readonly kind: "known"; readonly value: Vec2 } | { readonly kind: "source-indeterminate" };
type CurrentColor = { readonly kind: "known"; readonly value: Vec4 } | { readonly kind: "source-indeterminate" };
interface CapturedTriangle {
  readonly setup: TriangleSetup;
  readonly color: CurrentColor;
  readonly coordinates: readonly [CurrentTexCoord, CurrentTexCoord];
}
const MAX_CAPTURED_TRIANGLES = 256;

function copyCoordinate(coordinate: CurrentTexCoord): CurrentTexCoord {
  return coordinate.kind === "known" ? { kind: "known", value: { ...coordinate.value } } : coordinate;
}
interface ClientTexCoordArray {
  readonly origin: "svars0" | "svars1" | "raw0" | "raw1" | "local" | "direct";
  readonly values: readonly Vec2[];
}

interface TextureObject {
  levels: TextureStorage[];
  sampling: TextureSampling;
  magnificationFilter: "nearest" | "linear";
  borderColor: Vec4;
}
interface RegisteredTexture {
  readonly object: TextureObject;
  readonly mipmap: boolean;
  uploadPhase: ImageUploadPhase;
  sourceWidth: number;
  sourceHeight: number;
  uploadWidth: number;
  uploadHeight: number;
}

function textureObject(): TextureObject {
  return { levels: [], sampling: { wrap: "repeat", filter: "nearest-mipmap-linear" }, magnificationFilter: "linear",
    borderColor: { x: 0, y: 0, z: 0, w: 0 } };
}

function textureStorage(content: RgbaSnapshot, internalFormat: ImageInternalFormat): TextureStorage {
  if (internalFormat === "rgb4-s3tc") throw new Error("CPU texture storage does not support the rgb4-s3tc compressed diagnostic profile");
  const copyPixels = content.copyPixels;
  const pixels: unknown = Reflect.apply(copyPixels, content, []);
  if (!(pixels instanceof Uint8Array)) throw new TypeError("Image snapshot copy must return Uint8Array storage");
  const data = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const componentMaximum = internalFormat === "rgb5" ? 31 : internalFormat === "rgba4" ? 15 : 255;
  const alpha = textureHasAlpha(internalFormat);
  // Deterministic CPU storage precision. Each already-prepared upload level is
  // converted independently; low-bit codes remain normalized by 31 or 15.
  for (let offset = 0; offset < data.byteLength; offset++) {
    data.setUint8(offset, !alpha && offset % 4 === 3 ? componentMaximum
      : Math.floor(data.getUint8(offset) * componentMaximum / 255 + 0.5));
  }
  return { revision: {}, canonical: copyPixels === COPY_PIXELS,
    width: content.width, height: content.height, pixels, data, internalFormat, hasAlpha: alpha, componentMaximum,
    uniform: uniformTexels(data, componentMaximum) };
}

function uniformTexels(data: DataView, maximum: number): Readonly<Sample> | null {
  const first = data.getUint32(0);
  for (let offset = 4; offset < data.byteLength; offset += 4) if (data.getUint32(offset) !== first) return null;
  return { r: data.getUint8(0) / maximum, g: data.getUint8(1) / maximum, b: data.getUint8(2) / maximum, a: data.getUint8(3) / maximum };
}

function mipFilter(filter: TextureFilter): boolean {
  return filter !== "nearest" && filter !== "linear";
}

function linearFilter(filter: TextureFilter): boolean {
  return filter === "linear" || filter === "linear-mipmap-nearest" || filter === "linear-mipmap-linear";
}

function boundTexture(object: TextureObject): UploadedTexture | { readonly kind: "incomplete" } {
  const base = object.levels[0];
  if (base === undefined) return { kind: "incomplete" };
  const filter = object.sampling.filter, magnifyLinear = object.magnificationFilter === "linear";
  const mipmapping = !mipFilter(filter) ? "none"
    : filter === "nearest-mipmap-linear" || filter === "linear-mipmap-linear" ? "linear" : "nearest";
  const levels: [TextureStorage, ...TextureStorage[]] = [base];
  // OpenGL 2.1 section 3.8.10. A cinematic can replace only level zero;
  // its new dimensions and format determine which retained children matter.
  if (mipmapping !== "none") {
    let width = base.width, height = base.height;
    for (let index = 1; width > 1 || height > 1; index++) {
      width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
      const child = object.levels[index];
      if (child === undefined || child.width !== width || child.height !== height || child.internalFormat !== base.internalFormat) return { kind: "incomplete" };
      levels.push(child);
    }
  }
  // Filter classification is invariant for this bound draw. Section 3.8.9
  // gives the unequal initial MIN/MAG pair a lambda=0.5 transition.
  const magnificationLimit = magnifyLinear && (filter === "nearest-mipmap-nearest" || filter === "nearest-mipmap-linear") ? Math.SQRT2 : 1;
  return { kind: "image", internalFormat: base.internalFormat, wrap: object.sampling.wrap,
    minifyLinear: linearFilter(filter), magnifyLinear, mipmapping, magnificationLimit, levels, borderColor: object.borderColor };
}

/** RGBA rows run top to bottom. The deterministic default triangle profile uses
 * eight fractional window-coordinate bits, nearest-even rounding and lower-left
 * edge ownership. This profile matches measured native GL behavior, not every
 * possible driver. Comparisons pass the driver's reported GL_SUBPIXEL_BITS. */
export class SoftwareRenderer implements RendererBackend {
  readonly capabilities = Object.freeze({ textureUnits: 2, textureEnvAdd: true });
  // There is no GL maximum texture dimension. RgbaSnapshot validates int32 dimensions;
  // actual storage is limited by allocation and checked image byte counts.
  readonly configuration: {
    readonly kind: "cpu"; readonly colorBits: number; readonly depthBits: number;
    readonly depthStorage: "binary64"; readonly stencilBits: number; readonly stereoEnabled: boolean; readonly maxTextureSize: null;
  };
  readonly pixels: Uint8Array;
  private readonly colorWords: Int32Array;
  private readonly framebuffer: Framebuffer;
  private readonly depth: Float64Array;
  private readonly stencil: Uint32Array | null;
  private readonly stencilMaximum: number;
  private stencilEnabled = false;
  private stencilFunction: "always" | "nonzero" = "always";
  private stencilCompareMask = 0xffffffff;
  private stencilWriteMask = 0xffffffff;
  private stencilClear = 0;
  private stencilDepthFail: "keep" | "increment" | "decrement" = "keep";
  private stencilDepthPass: "keep" | "increment" | "decrement" = "keep";
  private colorWrite = true;
  private clearColor: Vec4 = { x: 0, y: 0, z: 0, w: 0 };
  private clearDepth = 1;
  private readonly sampled: Sample = { r: 1, g: 1, b: 1, a: 1 };
  private readonly fullViewport: RenderViewport;
  private viewport: RenderViewport;
  private clipPlane: Vec4 | null = null;
  private portalView = false;
  private readonly clipState = new RenderClipState();
  private readonly subpixelScale: number;
  private readonly textures = new Map<RendererImage, RegisteredTexture>();
  private dlightImage: RendererImage | null = null;
  private readonly zeroTexture = textureObject();
  private readonly textureUnits: [TextureObject, TextureObject] = [this.zeroTexture, this.zeroTexture];
  private readonly cachedTextureUnits: [RendererImage | null, RendererImage | null] = [null, null];
  private currentUnit: 0 | 1 = 0;
  private genericArraysOnce = false;
  private colorClientEnabled = false;
  private primaryEnabled = true;
  private primaryClientEnabled = false;
  private secondaryEnabled = false;
  private secondaryClientEnabled = false;
  private readonly clientTexCoords: [ClientTexCoordArray | null, ClientTexCoordArray | null] = [null, null];
  private secondaryEnvironment: TextureEnvironment = "modulate";
  private readonly currentTexCoords: [CurrentTexCoord, CurrentTexCoord] = [
    { kind: "known", value: { x: 0, y: 0 } }, { kind: "known", value: { x: 0, y: 0 } },
  ];
  private currentColor: CurrentColor = { kind: "known", value: { x: 1, y: 1, z: 1, w: 1 } };
  private polygonMode: "fill" | "line" = "fill";
  private lineWidth = 1;
  private retainedState: RenderState = { blend: { source: "one", destination: "zero" }, depthTest: "less-equal",
    depthWrite: true, alphaTest: "none", cull: "none" };
  private sourceBits: number | null = SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.DEPTHMASK_TRUE;
  private blendEnabled = false;
  private depthTestEnabled = false;
  private closed = false;

  constructor(readonly width: number, readonly height: number, readonly images: RendererImageCatalog, readonly subpixelBits = 8, readonly stencilBits = 0,
    readonly alphaBits: 0 | 8 = 8, private readonly triangleExecution: CpuTriangleExecution | null = null) {
    validateDimensions(width, height);
    if (!Number.isInteger(subpixelBits) || subpixelBits < 4 || subpixelBits > 16) throw new RangeError("CPU subpixel precision must be between 4 and 16 bits");
    if (!Number.isInteger(stencilBits) || stencilBits < 0 || stencilBits > 32) throw new RangeError("CPU stencil precision must be an integer in 0..32");
    if (alphaBits !== 0 && alphaBits !== 8) throw new RangeError("CPU framebuffer alpha precision must be 0 or 8 bits");
    this.configuration = Object.freeze({ kind: "cpu", colorBits: 24, depthBits: 64,
      depthStorage: "binary64", stencilBits, stereoEnabled: false, maxTextureSize: null });
    this.subpixelScale = 2 ** subpixelBits;
    this.fullViewport = { x: 0, y: 0, width, height };
    this.viewport = this.fullViewport;
    this.pixels = new Uint8Array(width * height * 4);
    this.colorWords = new Int32Array(this.pixels.buffer);
    if (alphaBits === 0) this.colorWords.fill(colorWord(0, 0, 0, 1));
    this.depth = new Float64Array(width * height);
    this.depth.fill(1);
    this.stencil = stencilBits === 0 ? null : new Uint32Array(width * height);
    this.stencilMaximum = 2 ** stencilBits - 1;
    this.framebuffer = { width, height, pixels: this.pixels, colorWords: this.colorWords,
      depth: this.depth, stencil: this.stencil, originX: 0, originY: 0, stride: width };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("CPU renderer is closed");
  }

  private applySourceState(bits: number): void {
    for (const change of sourceStateChanges(this.sourceBits, bits)) {
      switch (change.kind) {
        case "depth-function": this.retainedState = { ...this.retainedState, depthTest: change.value }; break;
        case "blend":
          this.blendEnabled = change.enabled;
          if (change.enabled) this.retainedState = { ...this.retainedState,
            blend: { source: change.source, destination: change.destination } };
          break;
        case "depth-write": this.retainedState = { ...this.retainedState, depthWrite: change.value }; break;
        case "polygon-mode": this.polygonMode = change.value; break;
        case "depth-test": this.depthTestEnabled = change.enabled; break;
        case "alpha-test": this.retainedState = { ...this.retainedState, alphaTest: change.value }; break;
        default: {
          const invalid: never = change;
          throw new Error(`Invalid source state operation ${invalid}`);
        }
      }
    }
    this.sourceBits = bits;
  }

  private applyDiagnosticState(state: RenderState): void {
    const { source, destination } = state.blend;
    const blendEnabled = source !== "one" || destination !== "zero";
    if (state.depthTest === "always" || source === "src-color" || source === "one-minus-src-color"
      || destination === "dst-color" || destination === "one-minus-dst-color" || destination === "src-alpha-saturate") {
      this.retainedState = state;
      this.blendEnabled = blendEnabled;
      this.depthTestEnabled = true;
      this.polygonMode = "fill";
      this.sourceBits = null;
      return;
    }
    this.applySourceState(sourceStateBits({ depthTest: state.depthTest, depthWrite: state.depthWrite,
      alphaTest: state.alphaTest, blend: blendEnabled ? { source, destination } : null }));
    const { depthRange, polygonOffset, ...retained } = this.retainedState;
    this.retainedState = { ...retained, cull: state.cull,
      ...(state.depthRange === undefined ? {} : { depthRange: state.depthRange }),
      ...(state.polygonOffset === undefined ? {} : { polygonOffset: state.polygonOffset }) };
  }

  private rasterState(): RenderState {
    let state = this.retainedState;
    if (!this.blendEnabled) state = { ...state, blend: { source: "one", destination: "zero" } };
    if (!this.depthTestEnabled) state = { ...state, depthTest: "always", depthWrite: false };
    return state;
  }

  finish(): undefined { this.assertOpen(); }

  /** tr_flares.c RB_TestFlare reads GL_FLOAT depth at bottom-left window coordinates. */
  readDepthPixel(windowX: number, windowY: number): number {
    this.assertOpen();
    if (!Number.isInteger(windowX) || !Number.isInteger(windowY)
      || windowX < 0 || windowX >= this.width || windowY < 0 || windowY >= this.height) {
      throw new RangeError("CPU depth readback coordinates must be integers inside the framebuffer");
    }
    const depth = this.depth[(this.height - 1 - windowY) * this.width + windowX];
    if (depth === undefined) throw new RangeError("Readback pixel is outside the depth buffer");
    return Math.fround(depth);
  }

  /** tr_backend.c RB_DrawBuffer. Mono front/back share pixels presented at frame end. */
  selectDrawBuffer(buffer: RendererDrawBuffer, clear: boolean): undefined {
    this.assertOpen();
    if (buffer !== "front" && buffer !== "back") throw new Error("CPU stereo draw buffers are unavailable");
    if (!clear) return;
    this.clearColor = { x: 1, y: 0, z: 0.5, w: 1 };
    this.clearColorBuffer();
    if (!this.retainedState.depthWrite) return;
    const { x, y, width, height } = this.viewport;
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
      const begin = row * this.width + Math.max(0, x), end = row * this.width + Math.min(this.width, x + width);
      if (begin < end) this.depth.fill(this.clearDepth, begin, end);
    }
  }

  /** tr_cmds.c RE_BeginFrame retains stencil parameters when measurement is disabled. */
  setOverdrawMeasurement(enabled: boolean): undefined {
    this.assertOpen();
    if (!enabled) { this.stencilEnabled = false; return; }
    if (this.stencil === null) throw new Error("CPU overdraw measurement requires stencil storage");
    this.stencilEnabled = true;
    this.stencilWriteMask = 0xffffffff;
    this.stencilClear = 0;
    this.stencilFunction = "always";
    this.stencilCompareMask = 0xffffffff;
    this.stencilDepthFail = "increment";
    this.stencilDepthPass = "increment";
  }

  /** tr_backend.c RB_SwapBuffers reads bottom-up unsigned-byte stencil indices. */
  readStencilOverdraw(destination: Uint8Array): undefined {
    this.assertOpen();
    const stencil = this.stencil;
    if (stencil === null) throw new Error("CPU stencil readback requires stencil storage");
    const stride = Math.ceil(this.width / 4) * 4, required = stride * (this.height - 1) + this.width;
    if (destination.length < required) throw new RangeError("CPU stencil readback destination is too small for source PACK_ALIGNMENT=4");
    for (let row = 0; row < this.height; row++) for (let x = 0; x < this.width; x++) {
      const value = stencil[(this.height - 1 - row) * this.width + x];
      if (value === undefined) throw new RangeError("Readback pixel is outside the stencil buffer");
      destination[row * stride + x] = value & 255;
    }
  }

  close(): undefined {
    if (this.closed) return;
    this.closed = true;
    this.textures.clear();
  }

  private beginImage(creation: BeginImageOperation): RegisteredTexture {
    this.images.requireOwned(creation.image);
    if (this.textures.has(creation.image)) throw new Error("CPU image is already registered");
    const registered: RegisteredTexture = { object: textureObject(), mipmap: creation.mipmap, uploadPhase: { kind: "pending" },
      sourceWidth: creation.image.sourceWidth, sourceHeight: creation.image.sourceHeight, uploadWidth: 0, uploadHeight: 0 };
    this.textures.set(creation.image, registered);
    creation.image.setUploadDimensions(0, 0);
    this.currentUnit = creation.registrationUnit;
    this.bindImage(creation.image);
    return registered;
  }

  private uploadImageLevel(operation: Extract<ImageResourceOperation, { readonly kind: "upload-image-level" }>): void {
    const registered = this.registeredTexture(operation.image), phase = registered.uploadPhase;
    const nextLevel = phase.kind === "uploading" ? phase.nextLevel : phase.kind === "pending" ? 0 : null;
    if (nextLevel === null) throw new Error("CPU image upload is already checked");
    if (operation.index !== nextLevel) throw new Error("CPU image upload levels are out of order");
    this.textureUnits[this.currentUnit].levels[operation.index] = textureStorage(operation.content, operation.internalFormat);
    registered.uploadPhase = { kind: "uploading", nextLevel: operation.index + 1 };
  }

  private setImageUploadDescriptor(operation: Extract<ImageResourceOperation, { readonly kind: "set-image-upload-descriptor" }>): void {
    const registered = this.registeredTexture(operation.image);
    if (registered.uploadPhase.kind !== "pending" && registered.uploadPhase.kind !== "uploading") throw new Error("CPU image upload is already checked");
    registered.uploadWidth = operation.width; registered.uploadHeight = operation.height;
    operation.image.setUploadDescriptor(operation.width, operation.height, operation.internalFormat);
  }

  private finishImageUpload(image: RendererImage, filter: TextureFilter): void {
    const registered = this.registeredTexture(image);
    if (registered.uploadPhase.kind !== "uploading") throw new Error("CPU image upload has no unchecked levels");
    const object = this.textureUnits[this.currentUnit];
    object.sampling = { ...object.sampling, filter };
    object.magnificationFilter = linearFilter(filter) ? "linear" : "nearest";
    registered.uploadPhase = { kind: "checked" };
  }

  applyImageResource(operation: ImageResourceOperation): undefined {
    this.assertOpen();
    if (operation.kind === "begin-image") { this.beginImage(operation.creation); return; }
    if (operation.kind === "upload-image-level") { this.uploadImageLevel(operation); return; }
    if (operation.kind === "set-image-upload-descriptor") { this.setImageUploadDescriptor(operation); return; }
    if (operation.kind === "finish-image-upload") { this.finishImageUpload(operation.image, operation.filter); return; }
    if (operation.kind === "dlight-image") {
      this.registeredTexture(operation.image);
      this.dlightImage = operation.image;
      return;
    }
    if (operation.kind === "current-border-color") {
      const color = operation.color;
      this.textureUnits[this.currentUnit].borderColor = { x: Math.fround(color.x), y: Math.fround(color.y), z: Math.fround(color.z), w: Math.fround(color.w) };
      return;
    }
    if (operation.kind === "texture-mode") {
      // GL_TextureMode visits tr.images in creation order on the current TMU.
      // GL_Bind can suppress a bind after R_CreateImage raw-unbound the object.
      for (const [image, registered] of this.textures) if (registered.mipmap) {
        this.bindImage(image);
        const object = this.textureUnits[this.currentUnit];
        object.sampling = { ...object.sampling, filter: operation.filter };
        object.magnificationFilter = linearFilter(operation.filter) ? "linear" : "nearest";
      }
      return;
    }
    const creation = operation.creation;
    this.images.requireOwned(creation.image);
    let registered = this.textures.get(creation.image);
    if (registered === undefined) {
      registered = this.beginImage(creation);
      this.setImageUploadDescriptor({ kind: "set-image-upload-descriptor", image: creation.image,
        width: creation.levels[0].width, height: creation.levels[0].height, internalFormat: creation.internalFormat });
      for (const [index, content] of creation.levels.entries()) this.uploadImageLevel({ kind: "upload-image-level",
        image: creation.image, index, content, internalFormat: creation.internalFormat });
      this.finishImageUpload(creation.image, creation.sampling.filter);
    }
    if (registered.uploadPhase.kind !== "checked") throw new Error("CPU image creation did not reach its upload check");
    const object = this.textureUnits[this.currentUnit];
    object.sampling = { ...object.sampling, wrap: creation.sampling.wrap };
    // R_CreateImage raw-unbinds without changing GL_Bind's cached identity.
    this.textureUnits[this.currentUnit] = this.zeroTexture;
    if (creation.registrationUnit === 1) this.currentUnit = 0;
    registered.uploadPhase = { kind: "complete" };
  }

  beginView(view: RenderViewState): undefined {
    this.assertOpen();
    validateRenderView({ ...view, clear: view.clear ?? { color: null, depth: 1, stencil: false }, operations: [] });
    this.viewport = { ...view.viewport };
    this.clipPlane = this.clipState.enterView(view.clipPlane);
    if (view.clear === null) {
      this.applySourceState(SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.SRCBLEND_SRC_ALPHA | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA);
      this.retainedState = { ...this.retainedState, cull: "none" };
      return;
    }
    this.portalView = view.clipPlane !== undefined && "kind" in view.clipPlane && view.clipPlane.kind === "portal";
    this.applySourceState(SourceStateBit.DEFAULT);
    const { x, y, width, height } = view.viewport;
    this.clearDepth = clamp(view.clear.depth);
    const color = view.clear.color;
    if (color !== null) {
      this.clearColor = { x: Math.fround(color.x), y: Math.fround(color.y), z: Math.fround(color.z), w: Math.fround(color.w) };
      this.clearColorBuffer();
    }
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
      const begin = row * this.width + Math.max(0, x), end = row * this.width + Math.min(this.width, x + width);
      if (begin >= end) continue;
      this.depth.fill(this.clearDepth, begin, end);
      if (view.clear.stencil && this.stencil !== null) {
        const clear = this.stencilClear & this.stencilWriteMask & this.stencilMaximum;
        if (this.stencilWriteMask === 0xffffffff) this.stencil.fill(clear, begin, end);
        else for (let index = begin; index < end; index++) {
          const previous = this.stencil[index];
          if (previous === undefined) throw new RangeError("Clear pixel is outside the stencil buffer");
          this.stencil[index] = ((previous & ~this.stencilWriteMask) | clear) >>> 0;
        }
      }
    }
  }

  clearColorBuffer(): undefined {
    this.assertOpen();
    if (!this.colorWrite) return;
    const { x, y, width, height } = this.viewport, color = this.clearColor;
    const word = colorWord(color.x, color.y, color.z, this.alphaBits === 0 ? 1 : color.w);
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
      const begin = row * this.width + Math.max(0, x), end = row * this.width + Math.min(this.width, x + width);
      if (begin < end) this.colorWords.fill(word, begin, end);
    }
  }

  // tr_backend.c RB_ShowImages supplies UV0 but retains color and the active bind unit.
  drawShowImage(image: RendererImage, rect: Rect2D, proportional: boolean): undefined {
    this.assertOpen();
    const registered = this.registeredTexture(image);
    const left = Math.fround(rect.x), top = Math.fround(rect.y);
    let width = Math.fround(rect.width), height = Math.fround(rect.height);
    if (proportional) {
      width = Math.fround(width * Math.fround(Math.fround(registered.uploadWidth) / 512));
      height = Math.fround(height * Math.fround(Math.fround(registered.uploadHeight) / 512));
    }
    const right = Math.fround(left + width), bottom = Math.fround(top + height);
    if (![left, top, width, height, right, bottom].every(Number.isFinite)) throw new RangeError("Show-images geometry must be finite float32");
    this.bindImage(image);
    if (this.currentColor.kind !== "known") throw new Error("CPU show-images color is source-indeterminate");
    const color = this.currentColor.value;
    const points = [{ x: left, y: top, s: 0, t: 0 }, { x: right, y: top, s: 1, t: 0 },
      { x: right, y: bottom, s: 1, t: 1 }, { x: left, y: bottom, s: 0, t: 1 }];
    const vertices = points.map(point => ({ position: { x: point.x * 2 / this.width - 1, y: 1 - point.y * 2 / this.height, z: -1, w: 1 },
      color, texCoord: { x: point.s, y: point.t }, texCoord2: { x: 0, y: 0 } }));
    const batch = this.retainedBatch(vertices, [0, 1, 2, 0, 2, 3], "triangles");
    const texture = this.enabledTexture(0), secondary = this.secondaryEnabled ? this.immediateTexture(1) : { kind: "incomplete" } satisfies BoundTexture;
    if (this.polygonMode === "line") this.drawPolygonOutline(clipPolygon(vertices, this.clipPlane), batch, texture, secondary);
    else this.drawBatch(batch, texture, secondary);
    this.currentTexCoords[0] = { kind: "known", value: { x: 0, y: 1 } };
  }

  private enabledTexture(unit: 0 | 1): UploadedTexture | { readonly kind: "incomplete" } {
    return (unit === 0 ? this.primaryEnabled : this.secondaryEnabled) ? boundTexture(this.textureUnits[unit]) : { kind: "incomplete" };
  }

  private refreshSourceCoordinates(scratch: readonly SourceStageCell[]): void {
    for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
      const array = this.clientTexCoords[unit];
      if (array === null || array.origin === "local" || array.origin === "direct") continue;
      const origin = array.origin;
      const values = scratch.map(cell => {
        switch (origin) {
          case "svars0": return cell.texCoord;
          case "svars1": return cell.texCoord2;
          case "raw0": return cell.rawTexCoord;
          case "raw1": return cell.rawTexCoord2;
        }
      });
      this.clientTexCoords[unit] = { origin, values };
    }
  }

  private validateClientCoordinates(indices: readonly number[]): void {
    for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
      if (!(unit === 0 ? this.primaryClientEnabled : this.secondaryClientEnabled)) continue;
      const array = this.clientTexCoords[unit];
      if (array === null) throw new Error(`CPU texture unit ${unit} has no source client coordinate array`);
      for (const index of indices) {
        const coordinate = array.values[index];
        if (coordinate === undefined) throw new RangeError(`CPU texture unit ${unit} client coordinate index is outside its array`);
        if (!Number.isFinite(Math.fround(coordinate.x)) || !Number.isFinite(Math.fround(coordinate.y)))
          throw new RangeError("CPU source client coordinates must be finite float32 values");
      }
    }
  }

  private immediateTexture(unit: 0 | 1): BoundTexture {
    const object = this.textureUnits[unit], texture = this.enabledTexture(unit), coordinate = this.currentTexCoords[unit];
    if (texture.kind === "incomplete") return texture;
    // tr_shadows.c RB_ShadowTessEnd masks color and disables alpha testing.
    // Those fragments consume only depth/stencil, leaving this texture unsampled.
    if (!this.colorWrite && this.retainedState.alphaTest === "none") return texture;
    if (coordinate.kind === "known") {
      const value: Sample = { r: 1, g: 1, b: 1, a: 1 };
      sampleBound(texture, coordinate.value.x, coordinate.value.y, 0, value);
      return { kind: "constant", internalFormat: texture.internalFormat, sample: value };
    }
    const uniform = texture.levels[0].uniform;
    const alpha = textureHasAlpha(texture.internalFormat);
    // Unknown current coordinates require a proof across every reachable level,
    // including its actual storage conversion, and all possible border taps.
    if (uniform !== null && texture.levels.every(level => level.uniform !== null
      && level.uniform.r === uniform.r && level.uniform.g === uniform.g && level.uniform.b === uniform.b
      && (!alpha || level.uniform.a === uniform.a))
      && (object.sampling.wrap === "repeat" || object.magnificationFilter === "nearest"
        || Math.fround(object.borderColor.x) === uniform.r && Math.fround(object.borderColor.y) === uniform.g
          && Math.fround(object.borderColor.z) === uniform.b && (!alpha || Math.fround(object.borderColor.w) === uniform.a))) {
      return { kind: "constant", internalFormat: texture.internalFormat, sample: uniform };
    }
    // OpenGL 1.2.1 section 2.8 leaves enabled current attributes indeterminate
    // after DrawElements. A coordinate-dependent read has no source-defined sample.
    throw new Error(`CPU immediate texture unit ${unit} has source-indeterminate coordinates and coordinate-dependent texels`);
  }

  private rasterizeImmediate(batch: DrawBatch): void {
    if (batch.indices.length === 0) return;
    this.drawBatch(batch, this.immediateTexture(0), this.secondaryEnabled ? this.immediateTexture(1) : { kind: "incomplete" });
  }

  private rasterizeImmediatePolygon(positions: readonly Vec4[], color: Vec4): void {
    if (positions.length < 3) return;
    // GL_POLYGON supplies no UVs. Retained samples resolve these unused channels.
    const vertices = positions.map(position => ({ position, color, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0 } }));
    const indices: number[] = [];
    for (let index = 1; index + 1 < positions.length; index++) indices.push(0, index, index + 1);
    const batch = this.retainedBatch(vertices, indices, "triangles"), texture = this.immediateTexture(0);
    const secondary = this.secondaryEnabled ? this.immediateTexture(1) : { kind: "incomplete" } satisfies BoundTexture;
    if (this.polygonMode === "line") this.drawPolygonOutline(clipPolygon(vertices, this.clipPlane), batch, texture, secondary);
    else this.drawBatch(batch, texture, secondary);
  }

  private immediateBatch(positions: readonly Vec4[], indices: readonly number[], colors: readonly Vec4[], primitive: "triangles" | "lines"): DrawBatch {
    // Immediate source calls supply no UVs. These unused interpolation channels
    // never select texels: rasterizeImmediate resolves retained coordinates first.
    const vertices = positions.map((position, index) => {
      const color = colors[index];
      if (color === undefined) throw new RangeError("Immediate vertex color is missing");
      return { position, color, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0 } };
    });
    return this.retainedBatch(vertices, indices, primitive);
  }

  private retainedBatch(vertices: readonly MultitextureVertex[], indices: readonly number[], primitive: "triangles" | "lines"): DrawBatch {
    const state = this.rasterState();
    const common = { vertices, indices, state, texture: { kind: "retain-current-texture" },
      ...(primitive === "triangles" ? { primitive } : { primitive, lineWidth: this.lineWidth }) } satisfies Omit<SingleTextureBatch, "texturing">;
    return this.secondaryEnabled ? { ...common, texturing: "pair", secondTexture: { binding: { kind: "retain-current-texture" }, environment: this.secondaryEnvironment } }
      : { ...common, texturing: "single" };
  }

  drawImmediate(operation: ImmediateViewOperation): undefined {
    this.assertOpen();
    // The source renderer never defines a display list. In this CPU context
    // every name is undefined, which CallList ignores without changing state.
    // External native GL list definitions have no CPU counterpart.
    if (operation.kind === "display-list") return;
    if (operation.kind === "disable-portal-clip") {
      this.clipState.disable();
      this.clipPlane = null;
      return;
    }
    if (operation.kind === "log-comment") return;
    // Compiled vertex-array locks have no CPU storage or client-state effects.
    if (operation.kind === "begin-source-arrays" || operation.kind === "end-source-arrays") return;
    if (operation.kind === "depth-range" || operation.kind === "cull" || operation.kind === "sky-box-state" || operation.kind === "polygon-offset") {
      validateRenderStateOperation(operation);
      switch (operation.kind) {
        case "depth-range": this.retainedState = { ...this.retainedState, depthRange: [operation.range[0], operation.range[1]] }; break;
        case "cull": this.retainedState = { ...this.retainedState, cull: operation.cull }; break;
        case "sky-box-state":
          this.applySourceState(0);
          this.currentColor = { kind: "known", value: { x: Math.fround(operation.identityLight), y: Math.fround(operation.identityLight), z: Math.fround(operation.identityLight), w: 1 } };
          break;
        case "polygon-offset": {
          const { polygonOffset, ...state } = this.retainedState;
          this.retainedState = operation.value === null ? state : { ...state, polygonOffset: { ...operation.value } };
          break;
        }
      }
      return;
    }
    if (operation.kind === "sky-side") {
      // tr_sky.c DrawSkySide binds on the retained unit, but TexCoord2fv
      // supplies UV0. The row strips neither write color nor use client arrays.
      this.bindImage(operation.image);
      for (const strip of operation.strips) {
        if (strip.length < 2 || strip.length % 2 !== 0) throw new RangeError("Sky side rows require an even count of at least two vertices");
        const vertices = strip.map(vertex => ({
          position: { x: Math.fround(vertex.position.x), y: Math.fround(vertex.position.y), z: Math.fround(vertex.position.z), w: Math.fround(vertex.position.w) },
          texCoord: { x: Math.fround(vertex.texCoord.x), y: Math.fround(vertex.texCoord.y) },
        }));
        if (!vertices.every(vertex => finiteVector(vertex.position) && Number.isFinite(vertex.texCoord.x) && Number.isFinite(vertex.texCoord.y)))
          throw new RangeError("Sky side vertices must be finite float32 values");
        const texture = this.enabledTexture(0);
        let secondary: BoundTexture | null = null;
        let first: Pick<MultitextureVertex, "position" | "texCoord"> | null = null;
        let second: Pick<MultitextureVertex, "position" | "texCoord"> | null = null;
        let even = true;
        for (const vertex of vertices) {
          this.currentTexCoords[0] = { kind: "known", value: vertex.texCoord };
          if (first === null) first = vertex;
          else if (second === null) second = vertex;
          else {
            if (this.currentColor.kind !== "known") throw new Error("CPU sky side color is source-indeterminate");
            const color = this.currentColor.value;
            // UV1 is not supplied by DrawSkySide. Its retained sample, rather
            // than this unused interpolation channel, selects secondary texels.
            const a = { ...(even ? first : second), color, texCoord2: { x: 0, y: 0 } };
            const b = { ...(even ? second : first), color, texCoord2: { x: 0, y: 0 } };
            const c = { ...vertex, color, texCoord2: { x: 0, y: 0 } };
            secondary ??= this.secondaryEnabled ? this.immediateTexture(1) : { kind: "incomplete" };
            this.drawTriangle(a, b, c, this.retainedBatch([a, b, c], [0, 1, 2], "triangles"), texture, secondary);
            first = second; second = vertex; even = !even;
          }
        }
      }
      return;
    }
    if (operation.kind === "begin-generic-iterator") {
      if (typeof operation.setArraysOnce !== "boolean") throw new RangeError("CPU generic iterator array mode must be boolean");
      const scratch = snapshotSourceCells(operation.scratch);
      this.refreshSourceCoordinates(scratch);
      this.genericArraysOnce = operation.setArraysOnce;
      this.colorClientEnabled = true;
      if (this.currentUnit === 0) this.primaryClientEnabled = true;
      else this.secondaryClientEnabled = true;
      if (operation.setArraysOnce) this.clientTexCoords[this.currentUnit] = { origin: "svars0",
        values: scratch.length === 0 ? this.clientTexCoords[this.currentUnit]?.values ?? [] : scratch.map(cell => cell.texCoord) };
      return;
    }
    if (operation.kind === "begin-debug-surface") {
      this.bindImage(operation.whiteImage);
      validateRenderStateOperation({ kind: "cull", cull: operation.cull });
      this.retainedState = { ...this.retainedState, cull: operation.cull };
      return;
    }
    if (operation.kind === "debug-polygon") {
      if (!Number.isInteger(operation.color) || operation.color < -0x80000000 || operation.color > 0x7fffffff)
        throw new RangeError("Debug polygon color must be int32");
      const positions = operation.positions.map(position => ({ x: Math.fround(position.x), y: Math.fround(position.y), z: Math.fround(position.z), w: Math.fround(position.w) }));
      if (!positions.every(finiteVector)) throw new RangeError("Debug polygon positions must be finite float32 values");
      this.applySourceState(SourceStateBit.DEPTHMASK_TRUE | SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE);
      const color = { x: operation.color & 1, y: (operation.color >> 1) & 1, z: (operation.color >> 2) & 1, w: 1 };
      this.currentColor = { kind: "known", value: color };
      this.rasterizeImmediatePolygon(positions, color);
      this.applySourceState(SourceStateBit.POLYMODE_LINE | SourceStateBit.DEPTHMASK_TRUE | SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE);
      this.retainedState = { ...this.retainedState, depthRange: [0, 0] };
      const white = { x: 1, y: 1, z: 1, w: 1 };
      this.currentColor = { kind: "known", value: white };
      this.rasterizeImmediatePolygon(positions, white);
      this.retainedState = { ...this.retainedState, depthRange: [0, 1] };
      return;
    }
    if (operation.kind === "entity-beam" || operation.kind === "entity-axis") {
      const beam = operation.kind === "entity-beam";
      if (operation.positions.length !== (beam ? 14 : 6)) throw new RangeError(beam ? "Entity beam requires fourteen strip positions" : "Entity axis requires six line positions");
      const positions = operation.positions.map(position => ({ x: Math.fround(position.x), y: Math.fround(position.y), z: Math.fround(position.z), w: Math.fround(position.w) }));
      if (!positions.every(finiteVector)) throw new RangeError("Entity positions must be finite float32 values");
      this.registeredTexture(operation.whiteImage);
      this.bindImage(operation.whiteImage);
      if (beam) {
        this.applySourceState(SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE);
      } else this.lineWidth = 3;
      const indices: number[] = [];
      if (beam) for (let index = 0; index < 12; index++) indices.push(index + (index % 2), index + 1 - (index % 2), index + 2);
      else indices.push(0, 1, 2, 3, 4, 5);
      const colors = positions.map((_position, index) => ({ x: beam || index < 2 ? 1 : 0, y: !beam && index >= 2 && index < 4 ? 1 : 0, z: !beam && index >= 4 ? 1 : 0, w: 1 }));
      if (beam) {
        this.currentColor = { kind: "known", value: { x: 1, y: 0, z: 0, w: 1 } };
        this.rasterizeImmediate(this.immediateBatch(positions, indices, colors, "triangles"));
      } else {
        for (let offset = 0; offset < positions.length; offset += 2) {
          const color = colors[offset];
          if (color === undefined) throw new RangeError("Entity axis color is missing");
          this.currentColor = { kind: "known", value: color };
          this.rasterizeImmediate(this.immediateBatch(positions, [offset, offset + 1], colors, "lines"));
        }
        this.lineWidth = 1;
      }
      return;
    }
    if (this.stencilBits < 4) return;
    const finishing = operation.kind === "shadow-finish";
    if (finishing && operation.positions.length !== 4) throw new RangeError("Shadow finish requires four positions");
    const shade = Math.fround(finishing ? 0.6 : 0.2);
    const positions = operation.positions.map(position => ({ x: Math.fround(position.x), y: Math.fround(position.y), z: Math.fround(position.z), w: Math.fround(position.w) }));
    if (!positions.every(finiteVector)) throw new RangeError("Shadow positions must be finite float32 values");
    const indices = operation.kind === "shadow-volume" ? [...operation.indices] : [0, 1, 2, 0, 2, 3];
    if (indices.length % 3 !== 0) throw new RangeError("Shadow triangle indices are incomplete");
    for (const index of indices) if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length) throw new RangeError("Shadow vertex index is outside its position array");
    if (finishing) {
      this.stencilEnabled = true;
      this.stencilFunction = "nonzero";
      this.stencilCompareMask = 255;
      this.clipState.disable();
      this.clipPlane = null;
      this.retainedState = { ...this.retainedState, cull: "none" };
    }
    this.bindImage(operation.whiteImage);
    this.currentColor = { kind: "known", value: { x: shade, y: shade, z: shade, w: 1 } };
    this.applySourceState(finishing ? SourceStateBit.DEPTHMASK_TRUE | SourceStateBit.SRCBLEND_DST_COLOR | SourceStateBit.DSTBLEND_ZERO
      : SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ZERO);
    if (operation.kind === "shadow-volume") this.retainedState = { ...this.retainedState, cull: operation.mirror ? "front" : "back" };
    const colors = positions.map(() => ({ x: shade, y: shade, z: shade, w: 1 }));
    if (finishing) {
      this.rasterizeImmediate(this.immediateBatch(positions, indices, colors, "triangles"));
      this.currentColor = { kind: "known", value: { x: 1, y: 1, z: 1, w: 1 } };
      this.stencilEnabled = false;
      return;
    }
    this.colorWrite = false;
    this.stencilEnabled = true;
    this.stencilFunction = "always";
    this.stencilCompareMask = 255;
    this.stencilDepthFail = "keep";
    this.stencilDepthPass = "increment";
    this.rasterizeImmediate(this.immediateBatch(positions, indices, colors, "triangles"));
    this.stencilDepthPass = "decrement";
    this.retainedState = { ...this.retainedState, cull: this.retainedState.cull === "front" ? "back" : "front" };
    this.rasterizeImmediate(this.immediateBatch(positions, indices, colors, "triangles"));
    this.colorWrite = true;
  }

  prepareGeometry(input: DrawBatch): PreparedBackendDraw {
    const prepared = this.prepareDraw(input, null);
    return { ...prepared, draw: () => prepared.draw(2) };
  }

  prepareSourceGeometry(stage: SourceStageData, _allocation: SourceGeometryAllocation = { kind: "standalone" }): PreparedBackendSourceDraw {
    return this.prepareDraw(stage.batch, stage);
  }

  // tr_shade.c DrawTris/DrawNormals leave these GL_State bits installed.
  private debugState(): void {
    this.applySourceState(SourceStateBit.POLYMODE_LINE | SourceStateBit.DEPTHMASK_TRUE);
  }

  prepareDebugTris(input: SourceDebugTris): PreparedBackendDebugTris {
    this.assertOpen();
    const whiteImage = input.whiteImage, indices = [...input.indices];
    const positions = input.positions.map(position => ({ ...position }));
    const scratch = snapshotSourceCells(input.scratch);
    let phase: "prepared" | "begun" | "drawing" | "drawn" | "cleaned" = "prepared";
    return {
      begin: () => {
        this.assertOpen();
        if (phase !== "prepared") throw new Error("CPU debug triangles have already begun");
        this.refreshSourceCoordinates(scratch);
        this.bindImage(whiteImage);
        this.currentColor = { kind: "known", value: { x: 1, y: 1, z: 1, w: 1 } };
        this.debugState();
        this.retainedState = { ...this.retainedState, depthRange: [0, 0] };
        this.colorClientEnabled = false;
        if (this.currentUnit === 0) this.primaryClientEnabled = false;
        else this.secondaryClientEnabled = false;
        phase = "begun";
      },
      draw: primitives => {
        this.assertOpen();
        if (phase !== "begun") throw new Error("CPU debug triangles are not ready to draw");
        phase = "drawing";
        const mode = sourcePrimitiveMode(primitives, false);
        if (mode !== "none" && indices.length !== 0) {
          if (indices.length % 3 !== 0) throw new RangeError("CPU debug triangle indices are incomplete");
          const discrete = mode === "discrete-strips";
          if (!discrete) this.validateClientCoordinates(indices);
          const coordinate = (index: number, unit: 0 | 1): Vec2 => {
            const cell = scratch[index];
            if (cell === undefined) throw new RangeError("CPU debug scratch vertex is missing");
            const source = unit === 0 ? cell.texCoord : cell.texCoord2;
            const value = { x: Math.fround(source.x), y: Math.fround(source.y) };
            if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new RangeError("CPU debug texture coordinates must be finite float32 values");
            return value;
          };
          const vertex = (index: number): MultitextureVertex => {
            if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("CPU debug vertex index is invalid");
            if (discrete) {
              const cell = scratch[index];
              if (cell === undefined) throw new RangeError("CPU debug scratch vertex is missing");
              if (!finiteVector(cell.color)) throw new RangeError("CPU debug color must be finite");
              this.currentColor = { kind: "known", value: { x: byte(cell.color.x) / 255, y: byte(cell.color.y) / 255,
                z: byte(cell.color.z) / 255, w: byte(cell.color.w) / 255 } };
              if (this.currentUnit !== 0) throw new Error("Unsupported source R_ArrayElementDiscrete multitexture targets 0 and 1");
            }
            const current0 = this.currentTexCoords[0], current1 = this.currentTexCoords[1];
            // Unknown disabled channels are sampled through immediateTexture's
            // coordinate-independent proof, never through these unused values.
            const texCoord = discrete ? coordinate(index, 0) : this.primaryClientEnabled ? this.clientTexCoords[0]?.values[index]
              : current0.kind === "known" ? current0.value : { x: 0, y: 0 };
            if (texCoord === undefined) throw new RangeError("CPU debug primary client coordinate is missing");
            if (mode !== "elements" && (discrete || this.primaryClientEnabled)) this.currentTexCoords[0] = { kind: "known", value: texCoord };
            const texCoord2 = !discrete && this.secondaryClientEnabled ? this.clientTexCoords[1]?.values[index]
              : current1.kind === "known" ? current1.value : { x: 0, y: 0 };
            if (texCoord2 === undefined) throw new RangeError("CPU debug secondary client coordinate is missing");
            if (mode !== "elements" && !discrete && this.secondaryClientEnabled) this.currentTexCoords[1] = { kind: "known", value: texCoord2 };
            const source = positions[index];
            if (source === undefined) throw new RangeError("CPU debug vertex index is outside its position array");
            const position = { x: Math.fround(source.x), y: Math.fround(source.y), z: Math.fround(source.z), w: Math.fround(source.w) };
            if (!finiteVector(position)) throw new RangeError("CPU debug positions must be finite float32 values");
            if (this.currentColor.kind !== "known") throw new Error("CPU debug color is source-indeterminate");
            return { position, color: this.currentColor.value, texCoord, texCoord2 };
          };
          const triangle = (a: MultitextureVertex, b: MultitextureVertex, c: MultitextureVertex): void => {
            const texture = discrete || this.primaryClientEnabled ? this.enabledTexture(0) : this.immediateTexture(0);
            const secondary = !this.secondaryEnabled ? { kind: "incomplete" } satisfies BoundTexture
              : !discrete && this.secondaryClientEnabled ? this.enabledTexture(1) : this.immediateTexture(1);
            this.drawTriangle(a, b, c, this.retainedBatch([a, b, c], [0, 1, 2], "triangles"), texture, secondary);
          };
          if (mode === "elements") {
            for (let offset = 0; offset < indices.length; offset += 3) {
              const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2];
              if (a === undefined || b === undefined || c === undefined) throw new RangeError("CPU debug triangle index is missing");
              triangle(vertex(a), vertex(b), vertex(c));
            }
            if (this.primaryClientEnabled) this.currentTexCoords[0] = { kind: "source-indeterminate" };
            if (this.secondaryClientEnabled) this.currentTexCoords[1] = { kind: "source-indeterminate" };
          } else {
            let first: MultitextureVertex | null = null, second: MultitextureVertex | null = null, even = true;
            emitSourceTriangleStrips(indices, {
              begin: () => { first = null; second = null; even = true; },
              element: index => {
                const next = vertex(index);
                if (first === null) first = next;
                else if (second === null) second = next;
                else {
                  triangle(even ? first : second, even ? second : first, next);
                  first = second; second = next; even = !even;
                }
              },
              end: () => {},
            });
          }
        }
        phase = "drawn";
      },
      cleanup: () => {
        this.assertOpen();
        if (phase !== "drawn") throw new Error("CPU debug triangles have not completed");
        this.retainedState = { ...this.retainedState, depthRange: [0, 1] };
        phase = "cleaned";
      },
    };
  }

  drawDebugNormals(input: SourceDebugNormals): undefined {
    this.assertOpen();
    this.bindImage(input.whiteImage);
    const color = { x: 1, y: 1, z: 1, w: 1 };
    this.currentColor = { kind: "known", value: color };
    this.retainedState = { ...this.retainedState, depthRange: [0, 0] };
    this.debugState();
    for (const segment of input.segments) {
      const positions = segment.map(source => ({ x: Math.fround(source.x), y: Math.fround(source.y), z: Math.fround(source.z), w: Math.fround(source.w) }));
      if (!positions.every(finiteVector)) throw new RangeError("CPU debug normal positions must be finite float32 values");
      this.rasterizeImmediate(this.immediateBatch(positions, [0, 1], [color, color], "lines"));
    }
    this.retainedState = { ...this.retainedState, depthRange: [0, 1] };
  }

  private prepareDraw(input: DrawBatch, source: SourceStageData | null): PreparedBackendSourceDraw {
    this.assertOpen();
    let batch = source === null ? snapshotBatch(input) : snapshotSourceBatch(source.batch, this.retainedState);
    validateBatch(batch, this.images, source === null);
    const paired = batch.texturing === "pair";
    const sourceKind = source === null ? null : source.kind;
    const scratch = source === null ? null : snapshotSourceCells(source.scratch);
    if (scratch !== null) {
      if (scratch.length !== batch.vertices.length) throw new RangeError("CPU source scratch must match published vertices");
      for (const cell of scratch) if (!finiteVector(cell.color)
        || ![cell.texCoord.x, cell.texCoord.y, cell.texCoord2.x, cell.texCoord2.y].every(value => Number.isFinite(Math.fround(value))))
        throw new RangeError("CPU source scratch attributes must be finite float32 values");
    }
    if (source === null) for (const binding of batch.texturing === "pair" ? [batch.texture, batch.secondTexture.binding] : [batch.texture]) {
      if (binding.kind === "bind-image") this.registeredTexture(binding.image);
      if (binding.kind === "shader-cinematic") this.registeredTexture(binding.source.image);
    }
    let phase: "prepared" | "begun" | "textured" | "drawn" | "cleaned" = "prepared", nextUnit = 0;
    let pendingUnit: 0 | 1 | null = null;
    const sourceCoordinates = (secondary: boolean): void => {
      const origin = sourceKind === null ? "direct" : secondary ? sourceKind === "lightmapped-pair" ? "raw1" : "svars1"
        : sourceKind === "lightmapped-pair" || sourceKind === "vertex-lit" ? "raw0" : sourceKind === "dlight" ? "local" : "svars0";
      let values: readonly Vec2[];
      if (batch.vertices.length === 0) values = this.clientTexCoords[this.currentUnit]?.values ?? [];
      else if (origin === "raw0" || origin === "raw1") {
        if (scratch === null) throw new Error("CPU raw source coordinates require stage scratch");
        values = scratch.map(cell => origin === "raw0" ? cell.rawTexCoord : cell.rawTexCoord2);
      } else if (secondary) {
        if (batch.texturing !== "pair") throw new Error("CPU secondary client coordinates require a paired batch");
        values = batch.vertices.map(vertex => vertex.texCoord2);
      } else values = batch.vertices.map(vertex => vertex.texCoord);
      this.clientTexCoords[this.currentUnit] = { origin, values };
    };
    const stateBeforeBinding = sourceKind === null || sourceKind === "generic-pair" || sourceKind === "lightmapped-pair";
    const applyState = (): void => {
      // GL_State leaves physical cull, depth range and polygon offset to their
      // explicit surface operations. Single stages reach it after binding.
      if (source === null) this.applyDiagnosticState(batch.state);
      else this.applySourceState(source.stateBits);
      // DrawMultitextured applies this driver workaround without updating GL_State's cache.
      if (sourceKind === "generic-pair" && this.portalView) this.polygonMode = "fill";
      if (batch.primitive === "lines") this.lineWidth = batch.lineWidth;
    };
    const prepareTexture = (unit: 0 | 1): undefined => {
      this.assertOpen();
      if (phase !== "begun" || pendingUnit !== null || unit !== nextUnit || unit === 1 && batch.texturing !== "pair")
        throw new Error("CPU prepared texture slot order is invalid");
      if (unit === 1 && sourceKind === "lightmapped-pair") sourceCoordinates(false);
      if (sourceKind === null || batch.texturing === "pair") this.currentUnit = unit;
      if (unit === 0) {
        if (sourceKind === null) this.primaryEnabled = true;
        if (sourceKind === null || sourceKind === "lightmapped-pair") this.primaryClientEnabled = true;
        if (sourceKind !== "lightmapped-pair" && (sourceKind !== "generic-single" || !this.genericArraysOnce)) sourceCoordinates(false);
      } else if (batch.texturing === "pair") {
        this.secondaryEnabled = true;
        if (sourceKind !== "lightmapped-pair") this.secondaryClientEnabled = true;
        const environment = batch.secondTexture.environment;
        if (!["modulate", "add", "replace"].includes(environment)) throw new RangeError("CPU texture environment is invalid");
        this.secondaryEnvironment = environment;
        if (sourceKind !== "lightmapped-pair") sourceCoordinates(true);
      }
      pendingUnit = unit;
    };
    return {
      begin: () => {
        this.assertOpen();
        if (phase !== "prepared") throw new Error("CPU prepared draw has already begun");
        if (scratch !== null) this.refreshSourceCoordinates(scratch);
        if (sourceKind !== "generic-single" && sourceKind !== "generic-pair" || !this.genericArraysOnce) this.colorClientEnabled = true;
        if (sourceKind === "vertex-lit" || sourceKind === "dlight" || sourceKind === "fog") {
          if (this.currentUnit === 0) this.primaryClientEnabled = true;
          else this.secondaryClientEnabled = true;
        }
        if (stateBeforeBinding) applyState();
        phase = "begun";
      },
      prepareTexture,
      applyTexture: (unit, operation) => {
        this.assertOpen();
        if (sourceKind === null) prepareTexture(unit);
        if (phase !== "begun" || pendingUnit !== unit) throw new Error("CPU prepared texture slot has not begun");
        this.applyTexture(operation);
        pendingUnit = null;
        nextUnit++;
      },
      finishTextures: () => {
        this.assertOpen();
        if (phase !== "begun" || pendingUnit !== null || nextUnit !== (batch.texturing === "pair" ? 2 : 1))
          throw new Error("CPU prepared draw has unapplied texture slots");
        if (!stateBeforeBinding) applyState();
        if (sourceKind === "lightmapped-pair") {
          if (this.currentUnit === 0) this.primaryClientEnabled = true;
          else this.secondaryClientEnabled = true;
          sourceCoordinates(true);
        }
        phase = "textured";
      },
      draw: primitives => {
        this.assertOpen();
        if (phase !== (sourceKind === null ? "begun" : "textured") || pendingUnit !== null || nextUnit !== (batch.texturing === "pair" ? 2 : 1))
          throw new Error("CPU prepared draw has unapplied texture slots");
        const mode = sourcePrimitiveMode(primitives, false), discrete = mode === "discrete-strips";
        const state = this.rasterState();
        let sourceVertices: readonly MultitextureVertex[] | null = null;
        if (sourceKind !== null) {
          if (mode !== "none" && !discrete && batch.indices.length !== 0) this.validateClientCoordinates(batch.indices);
          let retainedColor: Vec4 | null = null;
          if (!discrete && !this.colorClientEnabled && mode !== "none" && batch.indices.length !== 0) {
            if (this.currentColor.kind !== "known") throw new Error("CPU source draw color is source-indeterminate");
            retainedColor = this.currentColor.value;
          }
          const primary = !discrete && this.primaryClientEnabled ? this.clientTexCoords[0]?.values : undefined;
          const secondary = !discrete && this.secondaryClientEnabled ? this.clientTexCoords[1]?.values : undefined;
          sourceVertices = batch.vertices.map((vertex, index): MultitextureVertex => {
            const cell = scratch?.[index];
            if (cell === undefined) throw new RangeError("CPU source scratch vertex is missing");
            // Only indexed vertices consume retained array slots. Unreferenced
            // allocation tails keep their unused coordinates.
            return { position: vertex.position,
              color: discrete ? { x: byte(cell.color.x) / 255, y: byte(cell.color.y) / 255, z: byte(cell.color.z) / 255, w: byte(cell.color.w) / 255 } : retainedColor ?? vertex.color,
              texCoord: discrete ? { x: Math.fround(cell.texCoord.x), y: Math.fround(cell.texCoord.y) } : primary?.[index] ?? vertex.texCoord,
              texCoord2: secondary?.[index] ?? cell.texCoord2 };
          });
          if (this.secondaryEnabled) {
            batch = { texturing: "pair", primitive: "triangles", vertices: sourceVertices, indices: batch.indices,
              texture: { kind: "retain-current-texture" }, secondTexture: {
                binding: { kind: "retain-current-texture" }, environment: this.secondaryEnvironment,
              }, state };
          } else batch = { texturing: "single", primitive: "triangles", vertices: sourceVertices, indices: batch.indices,
              texture: { kind: "retain-current-texture" }, state };
        } else batch = { ...batch, state };
        if (batch.indices.length !== 0 && mode !== "none") {
          const captured: CapturedTriangle[] | null = batch.primitive === "triangles" && this.polygonMode !== "line"
            && this.triangleExecution?.canCapture(this.framebuffer, this.textureUnits[0].levels, this.textureUnits[1].levels) ? [] : null;
          try {
            if (mode === "elements") {
              if (sourceKind === null) this.drawBatch(batch, this.enabledTexture(0), this.enabledTexture(1), captured);
              else this.drawBatch(batch, this.primaryClientEnabled ? this.enabledTexture(0) : this.immediateTexture(0),
                this.secondaryClientEnabled ? this.enabledTexture(1) : this.immediateTexture(1), captured);
              this.flushTriangles(captured);
              if (sourceKind === null || this.colorClientEnabled) this.currentColor = { kind: "source-indeterminate" };
              if (sourceKind === null || this.primaryClientEnabled) this.currentTexCoords[0] = { kind: "source-indeterminate" };
              if (sourceKind === null ? batch.texturing === "pair" : this.secondaryClientEnabled)
                this.currentTexCoords[1] = { kind: "source-indeterminate" };
            } else {
              if (sourceVertices === null) throw new Error("CPU source strips require stage scratch");
              const vertices = sourceVertices;
              const texture = this.enabledTexture(0), secondary = this.enabledTexture(1);
              const uv0 = { x: 0, y: 0 }, uv1 = { x: 0, y: 0 };
              const current0: CurrentTexCoord = { kind: "known", value: uv0 }, current1: CurrentTexCoord = { kind: "known", value: uv1 };
              let first: MultitextureVertex | null = null, second: MultitextureVertex | null = null, even = true;
              emitSourceTriangleStrips(batch.indices, {
                begin: () => { first = null; second = null; even = true; },
                element: index => {
                  const vertex = vertices[index];
                  if (vertex === undefined) throw new RangeError("CPU source strip vertex is missing");
                  if (discrete || this.colorClientEnabled) this.currentColor = { kind: "known", value: vertex.color };
                  if (discrete && this.currentUnit !== 0)
                    throw new Error("Unsupported source R_ArrayElementDiscrete multitexture targets 0 and 1");
                  if (discrete || this.primaryClientEnabled) {
                    uv0.x = Math.fround(vertex.texCoord.x); uv0.y = Math.fround(vertex.texCoord.y);
                    this.currentTexCoords[0] = current0;
                  }
                  if (!discrete && this.secondaryClientEnabled) {
                    uv1.x = Math.fround(vertex.texCoord2.x); uv1.y = Math.fround(vertex.texCoord2.y);
                    this.currentTexCoords[1] = current1;
                  }
                  if (first === null) first = vertex;
                  else if (second === null) second = vertex;
                  else {
                    // Strip parity emits (a,b,c), then (c,b,d), then (c,d,e):
                    // exactly the source triples, including their third/provoking vertex.
                    const primaryTexture = discrete || this.primaryClientEnabled ? texture : this.immediateTexture(0);
                    const secondaryTexture = !discrete && this.secondaryClientEnabled ? secondary : this.immediateTexture(1);
                    this.drawTriangle(even ? first : second, even ? second : first, vertex, batch, primaryTexture, secondaryTexture, captured);
                    first = second; second = vertex; even = !even;
                  }
                },
                end: () => {},
              });
            }
          } catch (error: unknown) {
            this.flushTriangles(captured);
            throw error;
          }
          this.flushTriangles(captured);
        }
        phase = "drawn";
      },
      cleanup: () => {
        this.assertOpen();
        if (phase !== "drawn") throw new Error("CPU prepared draw has not completed");
        if (paired) {
          if (sourceKind === null) this.currentUnit = 1;
          if (this.currentUnit === 0) {
            this.primaryEnabled = false;
            if (sourceKind !== "generic-pair") this.primaryClientEnabled = false;
          } else {
            this.secondaryEnabled = false;
            if (sourceKind !== "generic-pair") this.secondaryClientEnabled = false;
          }
          this.currentUnit = 0;
        }
        if (sourceKind === null && batch.state.polygonOffset !== undefined) {
          const { polygonOffset, ...state } = this.retainedState;
          if (polygonOffset !== undefined) this.retainedState = state;
        }
        if (batch.primitive === "lines") this.lineWidth = 1;
        phase = "cleaned";
      },
    };
  }

  prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    this.assertOpen();
    const { x, y, width, height } = geometry.rect;
    const { uploadWidth, uploadHeight, identityLight } = geometry;
    if (![x, y, width, height, x + width, y + height, identityLight].every(value => Number.isFinite(Math.fround(value)))) throw new RangeError("Raw geometry must be finite float32");
    if (![x, y, width, height].every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff)) throw new RangeError("Raw rectangle must contain int32 values");
    validateDimensions(uploadWidth, uploadHeight);
    const light = Math.fround(identityLight), left = Math.fround(x), top = Math.fround(y);
    const right = Math.fround(x + width), bottom = Math.fround(y + height);
    const s0 = Math.fround(0.5 / uploadWidth), t0 = Math.fround(0.5 / uploadHeight);
    const s1 = Math.fround(Math.fround(uploadWidth - 0.5) / uploadWidth), t1 = Math.fround(Math.fround(uploadHeight - 0.5) / uploadHeight);
    const points = [{ x: left, y: top, s: s0, t: t0 }, { x: right, y: top, s: s1, t: t0 },
      { x: right, y: bottom, s: s1, t: t1 }, { x: left, y: bottom, s: s0, t: t1 }];
    const vertices = points.map(point => ({ position: { x: point.x * 2 / this.width - 1, y: 1 - point.y * 2 / this.height, z: -1, w: 1 },
      texCoord: { x: point.s, y: point.t }, texCoord2: { x: 0, y: 0 }, color: { x: light, y: light, z: light, w: 1 } }));
    let phase: "prepared" | "uploaded" | "drawn" = "prepared";
    return {
      uploadCurrent: upload => {
        this.assertOpen();
        if (phase !== "prepared") throw new Error("CPU raw upload has already executed");
        if (upload.uploadWidth !== uploadWidth || upload.uploadHeight !== uploadHeight) throw new Error("Raw geometry and upload dimensions disagree");
        this.uploadCinematic(upload); phase = "uploaded";
      },
      draw: () => {
        this.assertOpen();
        if (phase !== "uploaded") throw new Error("CPU raw draw has no upload");
        // RE_StretchRaw always calls RB_SetGL2D, but never selects texture0.
        // Legacy glTexCoord2f supplies unit0 coordinates even when unit1 is active.
        this.viewport = this.fullViewport;
        this.clipState.disable();
        this.clipPlane = null;
        this.applySourceState(SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.SRCBLEND_SRC_ALPHA | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA);
        this.retainedState = { ...this.retainedState, cull: "none" };
        this.currentColor = { kind: "known", value: { x: light, y: light, z: light, w: 1 } };
        const batch = this.retainedBatch(vertices, [0, 1, 2, 0, 2, 3], "triangles");
        this.drawBatch(batch, this.enabledTexture(0), this.secondaryEnabled ? this.immediateTexture(1) : { kind: "incomplete" });
        this.currentTexCoords[0] = { kind: "known", value: { x: s0, y: t1 } };
        phase = "drawn";
      },
    };
  }

  private registeredTexture(image: RendererImage): RegisteredTexture {
    this.images.requireOwned(image);
    const registered = this.textures.get(image);
    if (registered === undefined) throw new Error("CPU image has not been replayed into this backend");
    return registered;
  }

  private bindImage(image: RendererImage): RegisteredTexture {
    const registered = this.registeredTexture(image);
    const selected = this.images.noBind && this.dlightImage !== null ? this.dlightImage : image;
    if (this.cachedTextureUnits[this.currentUnit] !== selected) {
      const object = selected === image ? registered.object : this.registeredTexture(selected).object;
      this.images.markUsed(image);
      this.cachedTextureUnits[this.currentUnit] = selected;
      this.textureUnits[this.currentUnit] = object;
    }
    // Cinematic dimensions belong to the requested scratch image, even when GL_Bind redirects storage.
    return registered;
  }

  private applyTexture(operation: ResolvedTextureOperation): void {
    switch (operation.kind) {
      case "retain-current-texture": return;
      case "bind-image": this.bindImage(operation.image); return;
      case "cinematic-upload": this.uploadCinematic(operation.upload); return;
    }
  }

  private uploadCinematic(upload: CinematicUpload): void {
    validateDimensions(upload.uploadWidth, upload.uploadHeight);
    if (upload.content.width !== upload.uploadWidth || upload.content.height !== upload.uploadHeight) throw new RangeError("Cinematic content dimensions disagree with its upload");
    const registered = this.bindImage(upload.image), object = this.textureUnits[this.currentUnit];
    if (registered.sourceWidth !== upload.uploadWidth || registered.sourceHeight !== upload.uploadHeight) {
      this.images.resizeCinematic(upload.image, upload.uploadWidth, upload.uploadHeight);
      registered.sourceWidth = upload.uploadWidth;
      registered.sourceHeight = upload.uploadHeight;
      registered.uploadWidth = upload.uploadWidth;
      registered.uploadHeight = upload.uploadHeight;
      object.levels[0] = textureStorage(upload.content, "rgb8");
      object.sampling = { wrap: "clamp", filter: "linear" };
      object.magnificationFilter = "linear";
    } else if (upload.dirty) {
      const storage = object.levels[0];
      // Native glTexSubImage2D errors leave storage unchanged. Source defaults
      // r_ignoreGLErrors=1 and does not check errors inside cinematic upload.
      if (storage === undefined || upload.uploadWidth > storage.width || upload.uploadHeight > storage.height) return;
      const update = textureStorage(upload.content, storage.internalFormat), pixels = update.pixels;
      storage.canonical = storage.canonical && update.canonical;
      storage.revision = {};
      for (let row = 0; row < upload.uploadHeight; row++) {
        const from = row * upload.uploadWidth * 4, to = row * storage.width * 4;
        storage.pixels.set(pixels.subarray(from, from + upload.uploadWidth * 4), to);
      }
      storage.uniform = uniformTexels(storage.data, storage.componentMaximum);
    }
  }

  private flushTriangles(captured: CapturedTriangle[] | null): void {
    if (captured === null || captured.length === 0) return;
    const jobs = captured.splice(0);
    if (this.triangleExecution === null) throw new Error("Captured CPU draw requires its execution owner");
    const result = this.triangleExecution.draw(jobs.map(job => job.setup), this.framebuffer, this.sampled);
    if (result.kind === "failed") {
      const job = jobs[result.index];
      if (job === undefined) throw new Error("CPU execution returned an invalid failed ordinal");
      this.currentColor = job.color;
      this.currentTexCoords[0] = job.coordinates[0];
      this.currentTexCoords[1] = job.coordinates[1];
      throw result.error;
    }
  }

  private drawBatch(batch: DrawBatch, texture: BoundTexture = this.enabledTexture(0), secondary: BoundTexture = this.enabledTexture(1),
    captured: CapturedTriangle[] | null = null): void {
    if (batch.indices.length === 0) return;
    if (batch.primitive === "lines") {
      for (let offset = 0; offset < batch.indices.length; offset += 2) {
        this.drawLine(indexedVertex(batch, offset), indexedVertex(batch, offset + 1), batch.lineWidth, batch, texture, secondary);
      }
      return;
    }
    for (let offset = 0; offset < batch.indices.length; offset += 3) {
      this.drawTriangle(indexedVertex(batch, offset), indexedVertex(batch, offset + 1), indexedVertex(batch, offset + 2), batch, texture, secondary, captured);
    }
  }

  private drawLine(first: MultitextureVertex, second: MultitextureVertex, width: number,
    batch: DrawBatch, texture: BoundTexture, secondary: BoundTexture): void {
    let a = first, b = second;
    if (this.clipPlane !== null) {
      const da = planeDistance(a, this.clipPlane), db = planeDistance(b, this.clipPlane);
      if (da < 0 && db < 0) return;
      if (da < 0) a = intersect(a, b, da, db, this.clipPlane);
      else if (db < 0) b = intersect(a, b, da, db, this.clipPlane);
    }
    this.rasterizeLine(a, b, width, batch, texture, secondary);
  }

  private rasterizeLine(a: MultitextureVertex, b: MultitextureVertex, width: number,
    batch: DrawBatch, texture: BoundTexture, secondary: BoundTexture): void {
    const scissor = { minX: Math.max(0, -this.viewport.x), minY: Math.max(0, -this.viewport.y),
      maxX: Math.min(this.viewport.width - 1, this.width - 1 - this.viewport.x),
      maxY: Math.min(this.viewport.height - 1, this.height - 1 - this.viewport.y) };
    rasterizeAliasedLine(a, b, this.viewport.width, this.viewport.height, width, scissor, fragment => {
      const x = fragment.x + this.viewport.x, y = fragment.y + this.viewport.y;
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) this.lineFragment({ ...fragment, x, y }, batch, texture, secondary);
    });
  }

  private drawTriangle(a: MultitextureVertex, b: MultitextureVertex, c: MultitextureVertex,
    batch: DrawBatch, texture: BoundTexture, secondary: BoundTexture, captured: CapturedTriangle[] | null = null): void {
    const original: readonly [MultitextureVertex, MultitextureVertex, MultitextureVertex] = [a, b, c];
    const polygon = clipPolygon(original, this.clipPlane);
    const first = polygon[0];
    if (first === undefined) return;
    if (this.polygonMode === "line") {
      this.drawPolygonOutline(polygon, batch, texture, secondary);
      return;
    }
    let interpolation: readonly [ScreenVertex, ScreenVertex, ScreenVertex] | null = null;
    if (original.every(vertex => vertex.position.w > 0 && vertex.position.z >= -vertex.position.w && vertex.position.z <= vertex.position.w)
      && original.some(vertex => Math.abs(vertex.position.x) > vertex.position.w || Math.abs(vertex.position.y) > vertex.position.w)) {
      // The measured GL profile retains the original snapped interpolation
      // plane. Rebuilding it from newly snapped clip vertices changes UVs on
      // thin triangles. Coverage still uses the bounded clipped polygon.
      const scale = Math.min(original[0].position.w, original[1].position.w, original[2].position.w);
      const projected: readonly [ScreenVertex, ScreenVertex, ScreenVertex] = [project(original[0], this.viewport, scale, this.subpixelScale),
        project(original[1], this.viewport, scale, this.subpixelScale), project(original[2], this.viewport, scale, this.subpixelScale)];
      const area = edge(projected[0], projected[1], projected[2].x, projected[2].y);
      if (Number.isFinite(area)) {
        if (area === 0) return;
        interpolation = projected;
      }
    }
    for (let index = 1; index + 1 < polygon.length; index++) {
      const second = polygon[index];
      const third = polygon[index + 1];
      if (second === undefined || third === undefined) throw new RangeError("Missing clipped vertex");
      const wScale = Math.min(first.position.w, second.position.w, third.position.w);
      this.triangle(project(first, this.viewport, wScale, this.subpixelScale),
        project(second, this.viewport, wScale, this.subpixelScale), project(third, this.viewport, wScale, this.subpixelScale), batch, texture, secondary, interpolation, captured);
    }
  }

  private drawPolygonOutline(polygon: readonly MultitextureVertex[], batch: DrawBatch, texture: BoundTexture, secondary: BoundTexture): void {
    const first = polygon[0];
    if (first === undefined) return;
    const projected = polygon.map(vertex => project(vertex, this.viewport, 1, this.subpixelScale));
    let area = 0, previous = projected[projected.length - 1];
    if (previous === undefined) return;
    for (const current of projected) {
      area += previous.x * current.y - previous.y * current.x;
      previous = current;
    }
    if (!Number.isFinite(area) || batch.state.cull === "back" && area >= 0 || batch.state.cull === "front" && area < 0) return;
    // GL_POLYGON_OFFSET_FILL has no effect on polygon-line fragments.
    // Keep the clipping-created boundary and never draw triangulation spokes.
    let edgeStart = first;
    for (let index = 1; index <= polygon.length; index++) {
      const edgeEnd = index === polygon.length ? first : polygon[index];
      if (edgeEnd === undefined) throw new RangeError("Missing clipped perimeter vertex");
      // clipPolygon already applied the portal plane. A second test can
      // reject its rounded boundary points.
      this.rasterizeLine(edgeStart, edgeEnd, this.lineWidth, batch, texture, secondary);
      edgeStart = edgeEnd;
    }
  }

  private lineFragment(fragment: LineFragment, batch: DrawBatch, texture: BoundTexture, secondaryTexture: BoundTexture): void {
    const index = fragment.y * this.width + fragment.x, previousDepth = this.depth[index];
    if (previousDepth === undefined) throw new RangeError("Line fragment outside framebuffer");
    const state = batch.state, near = clamp(state.depthRange?.[0] ?? 0), far = clamp(state.depthRange?.[1] ?? 1);
    const depth = clamp(fragment.depth) * (far - near) + near;
    const depthPassed = !((state.depthTest === "less-equal" && depth > previousDepth) || (state.depthTest === "equal" && depth !== previousDepth));
    if (!depthPassed && !this.stencilEnabled) return;
    const textureConsumed = this.colorWrite || state.alphaTest !== "none";
    let r = clamp(fragment.color.x), g = clamp(fragment.color.y), b = clamp(fragment.color.z), alpha = clamp(fragment.color.w);
    if (textureConsumed && texture.kind !== "incomplete") {
      sampleLineBound(texture, fragment.texCoord, fragment.texCoordDerivative, this.sampled);
      r *= this.sampled.r; g *= this.sampled.g; b *= this.sampled.b;
      if (textureHasAlpha(texture.internalFormat)) alpha *= this.sampled.a;
    }
    if (textureConsumed && batch.texturing === "pair" && secondaryTexture.kind !== "incomplete") {
      const secondary = batch.secondTexture;
      sampleLineBound(secondaryTexture, fragment.texCoord2, fragment.texCoord2Derivative, this.sampled);
      r = textureColor(r, this.sampled.r, secondary.environment); g = textureColor(g, this.sampled.g, secondary.environment);
      b = textureColor(b, this.sampled.b, secondary.environment);
      if (textureHasAlpha(secondaryTexture.internalFormat)) alpha = secondary.environment === "replace" ? this.sampled.a : alpha * this.sampled.a;
    }
    if (!passesAlpha(alpha, state.alphaTest)) return;
    if (this.stencilEnabled && !stencilFragment(this.stencil, index, depthPassed, this.stencilFunction, this.stencilCompareMask,
      this.stencilWriteMask, this.stencilMaximum, this.stencilDepthFail, this.stencilDepthPass)) return;
    if (!this.colorWrite) return;
    const destination = this.colorWords[index];
    if (destination === undefined) throw new RangeError("Line fragment outside color buffer");
    const dr = (LITTLE_ENDIAN ? destination & 255 : destination >>> 24) / 255;
    const dg = ((destination >>> (LITTLE_ENDIAN ? 8 : 16)) & 255) / 255;
    const db = ((destination >>> (LITTLE_ENDIAN ? 16 : 8)) & 255) / 255;
    const da = this.alphaBits === 0 ? 1 : (LITTLE_ENDIAN ? destination >>> 24 : destination & 255) / 255;
    const offset = index * 4;
    this.pixels[offset] = blend(r, dr, alpha, da, state, false);
    this.pixels[offset + 1] = blend(g, dg, alpha, da, state, false);
    this.pixels[offset + 2] = blend(b, db, alpha, da, state, false);
    this.pixels[offset + 3] = this.alphaBits === 0 ? 255 : blend(alpha, da, alpha, da, state, true);
    if (state.depthWrite) this.depth[index] = depth;
  }

  private triangle(a: ScreenVertex, b: ScreenVertex, c: ScreenVertex, batch: DrawBatch,
    texture: BoundTexture, secondaryTexture: BoundTexture, interpolation: readonly [ScreenVertex, ScreenVertex, ScreenVertex] | null,
    captured: CapturedTriangle[] | null): void {
    let area = edge(a, b, c.x, c.y);
    if (!Number.isFinite(area) || area === 0) return;
    if ((batch.state.cull === "back" && area > 0) || (batch.state.cull === "front" && area < 0)) return;
    if (area < 0) {
      const previous = b;
      b = c;
      c = previous;
      area = -area;
    }
    const minX = Math.max(0, this.viewport.x, Math.ceil(Math.min(a.x, b.x, c.x) - 0.5));
    const maxX = Math.min(this.width - 1, this.viewport.x + this.viewport.width - 1, Math.floor(Math.max(a.x, b.x, c.x) - 0.5));
    const minY = Math.max(0, this.viewport.y, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
    const maxY = Math.min(this.height - 1, this.viewport.y + this.viewport.height - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
    const edgeAInclusive = lowerLeft(b, c);
    const edgeBInclusive = lowerLeft(c, a);
    const edgeCInclusive = lowerLeft(a, b);
    const attributes: readonly [ScreenVertex, ScreenVertex, ScreenVertex] = interpolation ?? [a, b, c];
    const [ia, ib, ic] = attributes;
    const inverseArea = 1 / (interpolation === null ? area : edge(ia, ib, ic.x, ic.y));
    const state = batch.state;
    const depthNear = clamp(state.depthRange?.[0] ?? 0), depthFar = clamp(state.depthRange?.[1] ?? 1);
    const white = ia.r === ia.inverseW && ia.g === ia.inverseW && ia.b === ia.inverseW && ia.a === ia.inverseW
      && ib.r === ib.inverseW && ib.g === ib.inverseW && ib.b === ib.inverseW && ib.a === ib.inverseW
      && ic.r === ic.inverseW && ic.g === ic.inverseW && ic.b === ic.inverseW && ic.a === ic.inverseW;
    const blending = state.blend.source === "one" && state.blend.destination === "zero" ? "opaque"
      : state.blend.source === "src-alpha" && state.blend.destination === "one-minus-src-alpha" ? "alpha"
      : state.blend.source === "one" && state.blend.destination === "one" ? "add"
        : (state.blend.source === "dst-color" && state.blend.destination === "zero")
          || (state.blend.source === "zero" && state.blend.destination === "src-color") ? "multiply"
          : state.blend.source === "dst-color" && state.blend.destination === "one-minus-dst-alpha" ? "dst-color-inverse-dst-alpha" : "general";
    const depthTest = state.depthTest, depthWrite = state.depthWrite, alphaTest = state.alphaTest;
    const stencilEnabled = this.stencilEnabled, colorWrite = this.colorWrite;
    const textureConsumed = colorWrite || alphaTest !== "none";
    const primaryAlpha = texture.kind !== "incomplete" && textureHasAlpha(texture.internalFormat);
    const secondaryAlpha = secondaryTexture.kind !== "incomplete" && textureHasAlpha(secondaryTexture.internalFormat);
    const secondaryEnvironment = batch.texturing === "pair" ? batch.secondTexture.environment : null;
    const edgeAX = b.y - c.y, edgeAY = c.x - b.x, edgeAC = b.x * c.y - b.y * c.x;
    const edgeBX = c.y - a.y, edgeBY = a.x - c.x, edgeBC = c.x * a.y - c.y * a.x;
    const edgeCX = a.y - b.y, edgeCY = b.x - a.x, edgeCC = a.x * b.y - a.y * b.x;
    const attributeAX = ib.y - ic.y, attributeAY = ic.x - ib.x, attributeAC = ib.x * ic.y - ib.y * ic.x;
    const attributeBX = ic.y - ia.y, attributeBY = ia.x - ic.x, attributeBC = ic.x * ia.y - ic.y * ia.x;
    const attributeCX = ia.y - ib.y, attributeCY = ib.x - ia.x, attributeCC = ia.x * ib.y - ia.y * ib.x;
    const az = ia.z, bz = ib.z, cz = ic.z;
    const constantDepth = az === bz && bz === cz;
    const slope = Math.max(Math.abs(az * attributeAX + bz * attributeBX + cz * attributeCX), Math.abs(az * attributeAY + bz * attributeBY + cz * attributeCY))
      * Math.abs(inverseArea) * 0.5 * Math.abs(depthFar - depthNear);
    // Fixed-point 24-bit depth resolution, matching the SDL GL depth buffer.
    const polygonDepthOffset = state.polygonOffset === undefined ? 0 : slope * Math.fround(state.polygonOffset.factor) + 2 ** -CPU_OFFSET_DEPTH_BITS * Math.fround(state.polygonOffset.units);
    const planeDepth = clamp(clamp(az * 0.5 + 0.5) * (depthFar - depthNear) + depthNear + polygonDepthOffset);
    const aiw = ia.inverseW, biw = ib.inverseW, ciw = ic.inverseW;
    // Delay UV/W until a common anchor is known. Subtracting U' - s*Q' with
    // large absolute s can invent a nonzero LOD for a constant coordinate.
    const uAnchor = ia.texCoord.x, vAnchor = ia.texCoord.y;
    const au = (ia.texCoord.x - uAnchor) * aiw, bu = (ib.texCoord.x - uAnchor) * biw, cu = (ic.texCoord.x - uAnchor) * ciw;
    const av = (ia.texCoord.y - vAnchor) * aiw, bv = (ib.texCoord.y - vAnchor) * biw, cv = (ic.texCoord.y - vAnchor) * ciw;
    const u2Anchor = ia.texCoord2.x, v2Anchor = ia.texCoord2.y;
    const au2 = (ia.texCoord2.x - u2Anchor) * aiw, bu2 = (ib.texCoord2.x - u2Anchor) * biw, cu2 = (ic.texCoord2.x - u2Anchor) * ciw;
    const av2 = (ia.texCoord2.y - v2Anchor) * aiw, bv2 = (ib.texCoord2.y - v2Anchor) * biw, cv2 = (ic.texCoord2.y - v2Anchor) * ciw;
    const qDx = (aiw * attributeAX + biw * attributeBX + ciw * attributeCX) * inverseArea;
    const qDy = (aiw * attributeAY + biw * attributeBY + ciw * attributeCY) * inverseArea;
    const derivative: TexturePlaneDerivative = {
      uAnchor, vAnchor,
      uDx: (au * attributeAX + bu * attributeBX + cu * attributeCX) * inverseArea,
      vDx: (av * attributeAX + bv * attributeBX + cv * attributeCX) * inverseArea, qDx,
      uDy: (au * attributeAY + bu * attributeBY + cu * attributeCY) * inverseArea,
      vDy: (av * attributeAY + bv * attributeBY + cv * attributeCY) * inverseArea, qDy,
    };
    const secondaryDerivative: TexturePlaneDerivative = {
      uAnchor: u2Anchor, vAnchor: v2Anchor,
      uDx: (au2 * attributeAX + bu2 * attributeBX + cu2 * attributeCX) * inverseArea,
      vDx: (av2 * attributeAX + bv2 * attributeBX + cv2 * attributeCX) * inverseArea, qDx,
      uDy: (au2 * attributeAY + bu2 * attributeBY + cu2 * attributeCY) * inverseArea,
      vDy: (av2 * attributeAY + bv2 * attributeBY + cv2 * attributeCY) * inverseArea, qDy,
    };
    const ar = ia.r, br = ib.r, cr = ic.r, ag = ia.g, bg = ib.g, cg = ic.g;
    const ab = ia.b, bb = ib.b, cb = ic.b, aa = ia.a, ba = ib.a, ca = ic.a;
    const setup: TriangleSetup = {
      minX, maxX, minY, maxY, inverseArea, depthNear,
      depthFar, edgeAX, edgeAY, edgeAC, edgeBX, edgeBY,
      edgeBC, edgeCX, edgeCY, edgeCC, attributeAX, attributeAY,
      attributeAC, attributeBX, attributeBY, attributeBC, attributeCX, attributeCY,
      attributeCC, az, bz, cz, polygonDepthOffset, planeDepth,
      aiw, biw, ciw, au, bu, cu,
      av, bv, cv, au2, bu2, cu2,
      av2, bv2, cv2, ar, br, cr,
      ag, bg, cg, ab, bb, cb,
      aa, ba, ca, edgeAInclusive, edgeBInclusive, edgeCInclusive,
      white, depthWrite, stencilEnabled, colorWrite, textureConsumed, primaryAlpha,
      secondaryAlpha, constantDepth, blending, depthTest, alphaTest, secondaryEnvironment,
      texture, secondaryTexture, derivative, secondaryDerivative,
      width: this.width, height: this.height,
      state: { blend: { ...state.blend } }, alphaBits: this.alphaBits,
      stencilFunction: this.stencilFunction, stencilCompareMask: this.stencilCompareMask, stencilWriteMask: this.stencilWriteMask,
      stencilMaximum: this.stencilMaximum, stencilDepthFail: this.stencilDepthFail, stencilDepthPass: this.stencilDepthPass,
    };
    if (captured === null) runTriangleRows(setup, this.framebuffer, this.sampled);
    else {
      if (minX > maxX || minY > maxY) return;
      captured.push({ setup,
        color: this.currentColor.kind === "known" ? { kind: "known", value: { ...this.currentColor.value } } : this.currentColor,
        coordinates: [copyCoordinate(this.currentTexCoords[0]), copyCoordinate(this.currentTexCoords[1])] });
      if (captured.length === MAX_CAPTURED_TRIANGLES) this.flushTriangles(captured);
    }
  }
}
