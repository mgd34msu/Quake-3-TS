import type { Vec2, Vec4 } from "../core/math.ts";
import type { RendererImage } from "./image-resource.ts";
import type { ShaderCinematicSource } from "./cinematic-command.ts";

export interface TextureImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  /** GL_TEXTURE_BORDER_COLOR; omitted means the source OpenGL default transparent black. */
  readonly borderColor?: Vec4;
}

export function validateTextureBorderColor(image: TextureImage): void {
  const color = image.borderColor;
  if (color !== undefined && ![color.x, color.y, color.z, color.w].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError("Texture border color must be finite and normalized");
  }
}

export interface RenderVertex {
  readonly position: Vec4;
  readonly texCoord: Vec2;
  readonly color: Vec4;
}

export interface MultitextureVertex extends RenderVertex {
  readonly texCoord2: Vec2;
}

export type BlendFactor = "zero" | "one" | "src-color" | "one-minus-src-color"
  | "dst-color" | "one-minus-dst-color" | "src-alpha" | "one-minus-src-alpha"
  | "dst-alpha" | "one-minus-dst-alpha" | "src-alpha-saturate";

export interface RenderState {
  readonly blend: { readonly source: BlendFactor; readonly destination: BlendFactor };
  readonly depthTest: "less-equal" | "equal" | "always";
  readonly depthWrite: boolean;
  readonly alphaTest: "none" | "gt0" | "lt128" | "ge128";
  readonly cull: "none" | "back" | "front";
  /** glDepthRange; omitted means the source default [0, 1]. Applied after clipping. */
  readonly depthRange?: readonly [number, number];
  /** GL_POLYGON_OFFSET_FILL; omitted disables the offset. */
  readonly polygonOffset?: { readonly factor: number; readonly units: number };
}

export type TextureEnvironment = "modulate" | "add" | "replace";
export type TextureFilter = "nearest" | "linear"
  | "nearest-mipmap-nearest" | "linear-mipmap-nearest"
  | "nearest-mipmap-linear" | "linear-mipmap-linear";
export interface TextureSampling {
  readonly wrap: "repeat" | "clamp";
  readonly filter: TextureFilter;
}
export type TextureBinding =
  | { readonly kind: "bind-image"; readonly image: RendererImage }
  | { readonly kind: "retain-current-texture" }
  | { readonly kind: "shader-cinematic"; readonly source: ShaderCinematicSource };
export interface SecondTextureBundle {
  readonly binding: TextureBinding;
  readonly environment: TextureEnvironment;
}

interface BatchData {
  readonly indices: readonly number[];
  readonly texture: TextureBinding;
  readonly state: RenderState;
}

type BatchPrimitive = { readonly primitive: "triangles" } | { readonly primitive: "lines"; readonly lineWidth: number };
export type SingleTextureBatch = BatchData & BatchPrimitive & {
  readonly texturing: "single";
  readonly vertices: readonly RenderVertex[];
};
export type MultitextureBatch = BatchData & BatchPrimitive & {
  readonly texturing: "pair";
  readonly vertices: readonly MultitextureVertex[];
  readonly secondTexture: SecondTextureBundle;
};
export type DrawBatch = SingleTextureBatch | MultitextureBatch;

/** Source tess arrays at this R_DrawElements call, indexed like batch.vertices. */
export interface SourceStageCell {
  readonly color: Vec4;
  readonly texCoord: Vec2;
  readonly texCoord2: Vec2;
  readonly rawTexCoord: Vec2;
  readonly rawTexCoord2: Vec2;
}

export type SourceStageData = { readonly stateBits: number } & (
  | { readonly kind: "generic-single" | "vertex-lit" | "dlight" | "fog";
      readonly batch: Extract<SingleTextureBatch, { primitive: "triangles" }>;
      readonly scratch: readonly SourceStageCell[] }
  | { readonly kind: "generic-pair" | "lightmapped-pair";
      readonly batch: Extract<MultitextureBatch, { primitive: "triangles" }>;
      readonly scratch: readonly SourceStageCell[] });

export type SourceGeometryAllocation = { readonly kind: "standalone" }
  | { readonly kind: "tess"; readonly slots: readonly number[]; readonly vertexCount: number };

export interface SourceDebugTris {
  readonly allocation: SourceGeometryAllocation;
  readonly whiteImage: RendererImage;
  readonly positions: readonly Vec4[];
  readonly indices: readonly number[];
  readonly scratch: readonly SourceStageCell[];
}
export interface SourceDebugNormals {
  readonly whiteImage: RendererImage;
  readonly segments: readonly (readonly [Vec4, Vec4])[];
}
export type SourceDebugOperation =
  | { readonly kind: "debug-tris"; readonly input: SourceDebugTris }
  | { readonly kind: "debug-normals"; readonly input: SourceDebugNormals };

export type ShadowViewOperation =
  | { readonly kind: "shadow-volume"; readonly positions: readonly Vec4[]; readonly indices: readonly number[];
      readonly mirror: boolean; readonly whiteImage: RendererImage }
  | { readonly kind: "shadow-finish"; readonly positions: readonly [Vec4, Vec4, Vec4, Vec4]; readonly whiteImage: RendererImage };
export type RenderStateOperation =
  | { readonly kind: "depth-range"; readonly range: readonly [number, number] }
  | { readonly kind: "cull"; readonly cull: RenderState["cull"] }
  | { readonly kind: "sky-box-state"; readonly identityLight: number }
  | { readonly kind: "polygon-offset"; readonly value: NonNullable<RenderState["polygonOffset"]> | null };
/** tr_surface.c, tr_sky.c and tr_main.c immediate calls consume retained backend state and texture coordinates. */
export type ImmediateViewOperation = ShadowViewOperation | RenderStateOperation
  | { readonly kind: "display-list"; readonly listNum: number }
  | { readonly kind: "disable-portal-clip" }
  | { readonly kind: "begin-source-arrays"; readonly positions: readonly Vec4[]; readonly slots: readonly number[]; readonly vertexCount: number }
  | { readonly kind: "end-source-arrays" }
  | { readonly kind: "log-comment"; readonly text: string }
  | { readonly kind: "sky-side"; readonly image: RendererImage;
      readonly strips: readonly (readonly Pick<RenderVertex, "position" | "texCoord">[])[] }
  | { readonly kind: "begin-generic-iterator"; readonly setArraysOnce: boolean; readonly scratch: readonly SourceStageCell[] }
  | { readonly kind: "begin-debug-surface"; readonly whiteImage: RendererImage; readonly cull: RenderState["cull"] }
  | { readonly kind: "debug-polygon"; readonly color: number; readonly positions: readonly Vec4[] }
  | { readonly kind: "entity-beam"; readonly positions: readonly Vec4[]; readonly whiteImage: RendererImage }
  | { readonly kind: "entity-axis"; readonly positions: readonly [Vec4, Vec4, Vec4, Vec4, Vec4, Vec4]; readonly whiteImage: RendererImage };
export type ViewOperation = ImmediateViewOperation | SourceDebugOperation
  | { readonly kind: "render-flares";
      readonly render: (depth: import("./flares.ts").SourceFlareDepth) => Iterable<SurfaceViewOperation, unknown, unknown> }
  | { readonly kind: "draw"; readonly batches: readonly DrawBatch[] }
  | { readonly kind: "source-tess-stage"; readonly stage: SourceStageData; readonly slots: readonly number[]; readonly vertexCount: number }
  | { readonly kind: "source-stage"; readonly stage: SourceStageData };
export type SurfaceViewOperation = Exclude<ViewOperation, { readonly kind: "shadow-finish" | "render-flares" }>;

export function validateRenderStateOperation(operation: RenderStateOperation): void {
  switch (operation.kind) {
    case "depth-range":
      if (operation.range.length !== 2 || !Number.isFinite(operation.range[0]) || !Number.isFinite(operation.range[1])) throw new RangeError("Depth range requires two finite endpoints");
      break;
    case "cull":
      if (!["none", "back", "front"].includes(operation.cull)) throw new RangeError("Physical cull face is invalid");
      break;
    case "sky-box-state":
      if (!Number.isFinite(operation.identityLight) || operation.identityLight < 0 || operation.identityLight > 1) throw new RangeError("Invalid identity light");
      break;
    case "polygon-offset":
      if (operation.value !== null && ![operation.value.factor, operation.value.units].every(value => Number.isFinite(Math.fround(value)))) throw new RangeError("Polygon offset must be finite float32");
      break;
  }
}

/** Window coordinates have a top-left origin, matching refdef_t. */
export interface RenderViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Nonzero coefficients of the source perspective projection: m0, m5, m10, m14. */
export type SourceClipProjection = readonly [xScale: number, yScale: number, zScale: number, zTranslation: number];
export type RenderClipPlane = Vec4
  | { readonly kind: "portal"; readonly eyePlane: Vec4; readonly projection: SourceClipProjection }
  | { readonly kind: "retain"; readonly projection: SourceClipProjection };

export function snapshotRenderClipPlane(plane: RenderClipPlane): RenderClipPlane {
  if (!("kind" in plane)) return { ...plane };
  const projection: SourceClipProjection = [...plane.projection];
  return plane.kind === "portal" ? { kind: "portal", eyePlane: { ...plane.eyePlane }, projection } : { kind: "retain", projection };
}

export function validateRenderClipPlane(plane: RenderClipPlane): void {
  if ("kind" in plane) {
    const p = plane.projection;
    if (!p.every(Number.isFinite)) throw new RangeError("view clip projection must be finite");
    if (plane.kind === "retain") return;
    if (p[0] === 0 || p[1] === 0 || p[3] === 0) throw new RangeError("view clip projection must be nonsingular");
    plane = plane.eyePlane;
  }
  if (![plane.x, plane.y, plane.z, plane.w].every(Number.isFinite)) throw new RangeError("view clip plane must be finite");
}

/** GL stores the user plane in eye coordinates independently of its enable bit. */
export class RenderClipState {
  private plane: { readonly kind: "eye" | "homogeneous"; readonly equation: Vec4 } | null = null;
  private enabled = false;

  disable(): void { this.enabled = false; }

  enterView(input: RenderClipPlane | undefined): Vec4 | null {
    if (input === undefined) { this.disable(); return null; }
    validateRenderClipPlane(input);
    if (!("kind" in input)) {
      const equation = copyRenderClipPlane(input);
      this.plane = { kind: "homogeneous", equation }; this.enabled = true;
      return equation;
    }
    if (input.kind === "portal") {
      this.plane = { kind: "eye", equation: { ...input.eyePlane } }; this.enabled = true;
    }
    if (!this.enabled) return null;
    const plane = this.plane;
    if (plane === null || plane.kind === "homogeneous") throw new Error("Retained source clipping requires a source eye plane, not a diagnostic homogeneous plane");
    const e = plane.equation, p = input.projection;
    if (p[0] === 0 || p[1] === 0 || p[3] === 0) throw new RangeError("Enabled retained clipping requires a nonsingular source projection");
    const projected = { x: e.x / p[0], y: e.y / p[1], z: e.w / p[3], w: -e.z + e.w * p[2] / p[3] };
    validateRenderClipPlane(projected);
    return copyRenderClipPlane(projected);
  }
}

export interface RenderView {
  readonly viewport: RenderViewport;
  readonly clear: { readonly depth: number; readonly color: Vec4 | null; readonly stencil: boolean };
  /** Source eye-plane update or retention; a bare Vec4 is a diagnostic homogeneous plane. Omission disables clipping. */
  readonly clipPlane?: RenderClipPlane;
  /** RB_DrawSurfs flushes retained tess before installing this view's state. */
  readonly beforeView?: readonly SurfaceViewOperation[];
  readonly operations: readonly ViewOperation[];
}

/** Source operations borrow retained state until the consumer advances the iterator. */
export interface SourceRenderView extends Omit<RenderView, "beforeView" | "operations"> {
  readonly beforeView?: Iterable<SurfaceViewOperation, unknown, unknown>;
  readonly operations: Iterable<ViewOperation, unknown, unknown>;
}

export function validateRenderViewHeader(view: Omit<RenderView, "beforeView" | "operations">): void {
  const viewport = view.viewport;
  if (![viewport.x, viewport.y, viewport.width, viewport.height].every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff)
    || viewport.width <= 0 || viewport.height <= 0) throw new RangeError("render viewport requires int32 coordinates and positive dimensions");
  const color = view.clear.color;
  if (!Number.isFinite(view.clear.depth) || (color !== null && ![color.x, color.y, color.z, color.w].every(Number.isFinite))) throw new RangeError("view clear values must be finite");
  if (typeof view.clear.stencil !== "boolean") throw new RangeError("view stencil clear must be boolean");
  const plane = view.clipPlane;
  if (plane !== undefined) validateRenderClipPlane(plane);
}

export function validateRenderView(view: RenderView): void {
  validateRenderViewHeader(view);
  for (const operation of view.beforeView ?? []) {
    switch (operation.kind) {
      case "disable-portal-clip": case "begin-source-arrays": case "end-source-arrays": case "source-tess-stage":
      case "draw": case "source-stage": case "debug-tris": case "debug-normals": case "shadow-volume": case "entity-beam": case "entity-axis":
      case "begin-debug-surface": case "begin-generic-iterator": case "debug-polygon": case "sky-side": case "log-comment": case "display-list": break;
      case "depth-range": case "cull": case "sky-box-state": case "polygon-offset":
        validateRenderStateOperation(operation); break;
      default: throw new Error("Before-view operations must be surfaces, not shadow finish");
    }
  }
  let finished = false;
  for (const operation of view.operations) {
    switch (operation.kind) {
      case "render-flares": case "disable-portal-clip": case "begin-source-arrays": case "end-source-arrays": case "source-tess-stage":
      case "draw": case "source-stage": case "debug-tris": case "debug-normals": case "shadow-volume": case "entity-beam": case "entity-axis":
      case "begin-debug-surface": case "begin-generic-iterator": case "debug-polygon": case "sky-side": case "log-comment": case "display-list": break;
      case "depth-range": case "cull": case "sky-box-state": case "polygon-offset":
        validateRenderStateOperation(operation);
        break;
      case "shadow-finish":
        if (finished) throw new Error("View contains more than one shadow finish");
        finished = true;
        break;
    }
  }
}

/** Copy a validated plane for backend use, preserving ordinary source coefficients. */
export function copyRenderClipPlane(plane: Vec4): Vec4 {
  const magnitude = Math.max(Math.abs(plane.x), Math.abs(plane.y), Math.abs(plane.z), Math.abs(plane.w));
  // Finite float32 positions are below 2**128. Eight products bound both
  // four-term distances and their subtraction at a crossing edge.
  if (magnitude <= Number.MAX_VALUE / (8 * 2 ** 128)) return { ...plane };
  return { x: plane.x / magnitude, y: plane.y / magnitude, z: plane.z / magnitude, w: plane.w / magnitude };
}

export const OPAQUE_STATE: RenderState = {
  blend: { source: "one", destination: "zero" },
  depthTest: "less-equal",
  depthWrite: true,
  alphaTest: "none",
  cull: "back",
};
