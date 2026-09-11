// SPDX-License-Identifier: GPL-2.0-or-later
// id Software tr_backend.c GL_State/GL_Bind/GL_SelectTexture/RE_UploadCinematic,
// tr_image.c R_CreateImage, tr_shade.c indexed fixed-function submission,
// tr_shadows.c stencil volume and shadow-finish submission,
// tr_init.c GL_SetDefaultState, tr_sky.c DrawSkySide,
// and tr_main.c R_DebugGraphics/R_DebugPolygon.
import { loadGl, loadGlCompiledVertexArrays } from "../../platform/gl.ts";
import type { Vec4 } from "../../core/math.ts";
import type { SourceGeometryAllocation, SourceStageCell } from "../types.ts";
import type { SourceGlExtensionSettings } from "../settings.ts";
import { createCheckedGlCalls, createLoggedGlCalls } from "./logging.ts";
import { applyAppleTransformHint } from "../platform-diagnostics.ts";
import type { GlCallLoggingSink, GlCalls } from "./logging.ts";
import { CommonError } from "../../core/common-error.ts";
import type { SdlRenderContext } from "../../platform/sdl-render-context.ts";
import type { CinematicUpload } from "../cinematic-command.ts";
import type { Rect2D } from "../draw2d.ts";
import type { BeginImageOperation, RendererImage, RendererImageCatalog, ImageInternalFormat, ImageResourceOperation, ImageUploadPhase } from "../image-resource.ts";
import type { PreparedBackendDebugTris, PreparedBackendDraw, PreparedBackendSourceDraw, PreparedBackendRawDraw, RawGeometry, RendererBackend, RendererDrawBuffer, RenderViewState, ResolvedTextureOperation } from "../commands.ts";
import type { BlendFactor, DrawBatch, ImmediateViewOperation, RenderState, SourceDebugNormals, SourceDebugTris, SourceStageData, TextureBinding, TextureEnvironment, TextureFilter, TextureSampling } from "../types.ts";
import { RenderClipState, validateRenderStateOperation } from "../types.ts";
import { emitSourceTriangleStrips, sourcePrimitiveMode } from "../primitives.ts";
import { SourceStateBit, sourceStateBits, sourceStateChanges } from "../source-state.ts";

const blendFactors: Record<BlendFactor, number> = {
  zero: 0, one: 1, "src-color": 0x300, "one-minus-src-color": 0x301,
  "src-alpha": 0x302, "one-minus-src-alpha": 0x303, "dst-alpha": 0x304,
  "one-minus-dst-alpha": 0x305, "dst-color": 0x306,
  "one-minus-dst-color": 0x307, "src-alpha-saturate": 0x308,
};
const drawBuffers: Record<RendererDrawBuffer, number> = { front: 0x404, back: 0x405, "back-left": 0x402, "back-right": 0x403 };
interface Arrays {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly texCoords: Float32Array;
  readonly texCoords2: Float32Array;
  readonly indices: Uint32Array;
}
/** Source coordinate allocation identity is independent of the selected texture unit. */
interface CoordinateClientArray {
  readonly origin: "svars0" | "svars1" | "raw0" | "raw1" | "local" | "direct";
  readonly values: Float32Array;
}
interface SourceCoordinateArrays {
  readonly svars0: Float32Array;
  readonly svars1: Float32Array;
  readonly raw0: Float32Array;
  readonly raw1: Float32Array;
}
interface GlTextureObject { readonly name: number; readonly handle: Uint32Array }
interface RegisteredImage {
  readonly object: GlTextureObject;
  readonly mipmap: boolean;
  uploadPhase: ImageUploadPhase;
  logicalWidth: number;
  logicalHeight: number;
  uploadWidth: number;
  uploadHeight: number;
}
const internalFormats: Record<ImageInternalFormat, number> = { rgb: 3, rgba: 4, rgb5: 0x8050, rgba4: 0x8056, rgb8: 0x8051, rgba8: 0x8058, "rgb4-s3tc": 0x83a1 };
const textureFilters: Record<TextureFilter, readonly [number, number]> = {
  nearest: [0x2600, 0x2600], linear: [0x2601, 0x2601],
  "nearest-mipmap-nearest": [0x2700, 0x2600], "linear-mipmap-nearest": [0x2701, 0x2601],
  "nearest-mipmap-linear": [0x2702, 0x2600], "linear-mipmap-linear": [0x2703, 0x2601],
};
function finite32(value: number): boolean { return Number.isFinite(Math.fround(value)); }
function finitePosition(x: number, y: number, z: number, w: number): boolean {
  return finite32(x) && finite32(y) && finite32(z) && finite32(w);
}
function storeFloat2(target: Float32Array, x: number, y: number, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > target.length) { target.set([x, y], offset); return; }
  target[offset] = x; target[offset + 1] = y;
}
function storeFloat4(target: Float32Array, x: number, y: number, z: number, w: number, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > target.length) { target.set([x, y, z, w], offset); return; }
  target[offset] = x; target[offset + 1] = y; target[offset + 2] = z; target[offset + 3] = w;
}
const activeContexts = new WeakSet<SdlRenderContext>();
interface GlContextState {
  currentUnit: 0 | 1;
  depthRange: readonly [number, number];
  bits: number | null;
  readonly textureEnvironments: [TextureEnvironment | null, TextureEnvironment | null];
  textureCompression: "none" | "s3tc" | null;
  compiledVertexArrays: boolean | null;
  textureExtensions: { readonly maxActiveTextures: number; readonly textureEnvAddAvailable: boolean } | null;
  extensionsInitialized: boolean;
}
// GLimp_Shutdown clears glState. RE_Shutdown(false) retains it with the context.
const contextStates = new WeakMap<SdlRenderContext, GlContextState>();

/** GLW_InitExtensions uses Q_stristr, without promoting core-version or ARB env-add support. */
export function sourceGlCapabilities(extensions: string, textureUnits: number): { readonly textureUnits: number; readonly textureEnvAdd: boolean } {
  const names = extensions.toLowerCase();
  return { textureUnits: names.includes("gl_arb_multitexture") ? textureUnits : 1,
    textureEnvAdd: names.includes("ext_texture_env_add") };
}

function pack(batch: DrawBatch): Arrays {
  const { vertices, indices } = batch;
  if (batch.primitive !== "lines" && batch.primitive !== "triangles") throw new Error("GL primitive is invalid");
  if (indices.length % (batch.primitive === "lines" ? 2 : 3) !== 0 || indices.length > 0x7fffffff) throw new Error("GL primitive index count is invalid");
  if (vertices.length > 0x1fffffff) throw new RangeError("GL vertex count exceeds packed storage limits");
  if (batch.primitive === "lines" && (!finite32(batch.lineWidth) || Math.fround(batch.lineWidth) <= 0)) throw new RangeError("GL line width must be positive and finite");
  for (const index of indices) if (!Number.isInteger(index) || index < 0 || index >= vertices.length || index > 0xffffffff) throw new Error("GL triangle index is out of range");
  const arrays: Arrays = { positions: new Float32Array(vertices.length * 4), colors: new Float32Array(vertices.length * 4),
    texCoords: new Float32Array(vertices.length * 2), texCoords2: new Float32Array(vertices.length * 2), indices: new Uint32Array(indices) };
  for (const [index, vertex] of vertices.entries()) {
    const position = vertex.position, color = vertex.color, uv = vertex.texCoord;
    storeFloat4(arrays.positions, position.x, position.y, position.z, position.w, index * 4);
    storeFloat4(arrays.colors, color.x, color.y, color.z, color.w, index * 4);
    storeFloat2(arrays.texCoords, uv.x, uv.y, index * 2);
  }
  if (batch.texturing === "pair") {
    for (const [index, vertex] of batch.vertices.entries()) storeFloat2(arrays.texCoords2, vertex.texCoord2.x, vertex.texCoord2.y, index * 2);
  } else if (batch.texturing !== "single") throw new Error("GL texturing kind is invalid");
  for (const array of [arrays.positions, arrays.colors, arrays.texCoords, arrays.texCoords2]) {
    for (let index = 0; index < array.length; index++) if (!Number.isFinite(array[index])) throw new Error("GL vertex components must be finite float32 values");
  }
  return arrays;
}

function copyState(input: RenderState): RenderState {
  const state: RenderState = { ...input, blend: { ...input.blend },
    ...(input.depthRange === undefined ? {} : { depthRange: [input.depthRange[0], input.depthRange[1]] satisfies readonly [number, number] }),
    ...(input.polygonOffset === undefined ? {} : { polygonOffset: { ...input.polygonOffset } }) };
  if (!Object.hasOwn(blendFactors, state.blend.source) || !Object.hasOwn(blendFactors, state.blend.destination)
    || state.blend.destination === "src-alpha-saturate") throw new Error("GL blend factors are invalid");
  if (!["less-equal", "equal", "always"].includes(state.depthTest) || typeof state.depthWrite !== "boolean"
    || !["none", "back", "front"].includes(state.cull) || !["none", "gt0", "lt128", "ge128"].includes(state.alphaTest)) throw new Error("GL render state is invalid");
  if (state.depthRange !== undefined && !state.depthRange.every(Number.isFinite)) throw new RangeError("Depth range must be finite");
  if (state.polygonOffset !== undefined && ![state.polygonOffset.factor, state.polygonOffset.units].every(finite32)) throw new RangeError("Polygon offset must be finite float32");
  return state;
}

export class GlRenderer implements RendererBackend {
  private readonly clipState = new RenderClipState();
  private portalView = false;
  private readonly library: ReturnType<typeof loadGl>;
  private readonly gl: GlCalls;
  private readonly textures = new Map<RendererImage, RegisteredImage>();
  private readonly cachedBindings: [RendererImage | null, RendererImage | null] = [null, null];
  private readonly zero: GlTextureObject = { name: 0, handle: new Uint32Array([0]) };
  private readonly actualObjects: [GlTextureObject, GlTextureObject] = [this.zero, this.zero];
  private readonly contextState: GlContextState;
  private compiledArrays: ReturnType<typeof loadGlCompiledVertexArrays> | null = null;
  private arraysLocked = false;
  private sourceArrays: { readonly positions: Float32Array; readonly slots: readonly number[]; readonly vertexCount: number } | null = null;
  private get currentUnit(): 0 | 1 { return this.contextState.currentUnit; }
  private set currentUnit(unit: 0 | 1) { this.contextState.currentUnit = unit; }
  private get actualDepthRange(): readonly [number, number] { return this.contextState.depthRange; }
  private set actualDepthRange(range: readonly [number, number]) { this.contextState.depthRange = range; }
  private vertexClientArray: Float32Array | null = null;
  private colorClientArray: Float32Array | null = null;
  private genericArraysOnce = false;
  private primaryClientArrayEnabled = false;
  private secondaryClientArrayEnabled = false;
  private readonly coordinateClientArrays: [CoordinateClientArray | null, CoordinateClientArray | null] = [null, null];
  private dlightImage: RendererImage | null = null;
  readonly maxTextureSize: number;
  readonly width: number;
  readonly height: number;
  readonly depthBits: number;
  readonly colorBits: number;
  readonly alphaBits: number;
  readonly stencilBits: number;
  readonly stereoEnabled: boolean;
  readonly extensions: string;
  readonly subpixelBits: number;
  private readonly borderParameter = new Float32Array(4);
  private readonly flareDepth = new Float32Array(1);
  private readonly flarePackState = new Int32Array(1);
  private closed = false;
  readonly driver: { readonly vendor: string; readonly renderer: string; readonly version: string };
  readonly capabilities: { readonly textureUnits: number; readonly textureEnvAdd: boolean };

  constructor(readonly window: SdlRenderContext, readonly images: RendererImageCatalog, private readonly logging: GlCallLoggingSink | null = null) {
    if (activeContexts.has(window)) throw new Error("SDL window/context already has an active GL renderer");
    activeContexts.add(window);
    if (!contextStates.has(window)) logging?.resetCalls();
    let library: ReturnType<typeof loadGl> | null = null;
    try {
      // Capability/resource initialization needs the context even when the next frame is disabled.
      window.setRenderingEnabled(true);
      this.library = loadGl(window); library = this.library;
      this.gl = createCheckedGlCalls(createLoggedGlCalls(this.library.symbols, logging), logging?.errors ?? null,
        () => this.library.symbols.glGetError());
      const gl = this.gl;
      const size = window.drawableSize; this.width = size.width; this.height = size.height;
      this.driver = { vendor: String(gl.glGetString(0x1f00)), renderer: String(gl.glGetString(0x1f01)), version: String(gl.glGetString(0x1f02)) };
      this.extensions = String(gl.glGetString(0x1f03));
      const maximum = new Int32Array(1);
      const integer = (name: number): number => {
        gl.glGetIntegerv(name, maximum);
        const value = maximum[0];
        if (value === undefined || value < 0) throw new Error("GL returned an invalid framebuffer attribute");
        return value;
      };
      this.colorBits = integer(0xd52) + integer(0xd53) + integer(0xd54);
      this.alphaBits = integer(0xd55);
      this.stencilBits = integer(0xd57);
      this.stereoEnabled = integer(0xc33) !== 0;
      gl.glGetIntegerv(0x84e2, maximum);
      const textureUnits = maximum[0];
      if (textureUnits === undefined || textureUnits < 1) throw new Error("GL returned invalid fixed-function texture unit count");
      this.capabilities = sourceGlCapabilities(this.extensions, textureUnits);
      gl.glGetIntegerv(0xd33, maximum);
      const maxTextureSize = maximum[0];
      if (maxTextureSize === undefined || maxTextureSize <= 0) throw new Error("GL returned invalid maximum texture size");
      this.maxTextureSize = maxTextureSize;
      gl.glGetIntegerv(0xd56, maximum);
      const depthBits = maximum[0];
      if (depthBits === undefined || depthBits <= 0) throw new Error("GL returned invalid depth precision");
      this.depthBits = depthBits;
      gl.glGetIntegerv(0xd50, maximum);
      const subpixelBits = maximum[0];
      if (subpixelBits === undefined || subpixelBits < 4 || subpixelBits > 24) throw new Error("GL returned unsupported subpixel precision");
      this.subpixelBits = subpixelBits;
      const retained = contextStates.get(window);
      if (retained === undefined) {
        this.contextState = { currentUnit: 0, depthRange: [0, 1], textureEnvironments: [null, null],
          bits: 0, textureCompression: null, compiledVertexArrays: null, textureExtensions: null, extensionsInitialized: false };
        contextStates.set(window, this.contextState);
      } else this.contextState = retained;
    } catch (error: unknown) {
      if (library !== null) library.close();
      activeContexts.delete(window); throw error;
    }
  }

  private available(): void { if (this.closed) throw new Error("GL renderer is closed"); }
  initializeExtensions(settings: SourceGlExtensionSettings): void {
    this.opened();
    const loadCompiledArrays = (): void => {
      try { this.compiledArrays = loadGlCompiledVertexArrays(this.window); }
      catch { throw new CommonError("fatal", "bad getprocaddress"); }
    };
    if (this.contextState.extensionsInitialized) {
      if (this.contextState.compiledVertexArrays && this.compiledArrays === null) loadCompiledArrays();
      return;
    }
    this.contextState.extensionsInitialized = true;
    this.contextState.textureCompression = "none"; this.contextState.compiledVertexArrays = false;
    this.contextState.textureExtensions = { maxActiveTextures: 0, textureEnvAddAvailable: false };
    const emit = (text: string): void => { settings.print(text); this.opened(); };
    if (!settings.allow) { emit("*** IGNORING OPENGL EXTENSIONS ***\n"); return; }
    emit("Initializing OpenGL extensions\n");
    const extensions = this.extensions.toLowerCase();
    if (extensions.includes("gl_s3_s3tc")) {
      if (settings.compressedTextures) { this.contextState.textureCompression = "s3tc"; emit("...using GL_S3_s3tc\n"); }
      else emit("...ignoring GL_S3_s3tc\n");
    } else emit("...GL_S3_s3tc not found\n");
    if (extensions.includes("ext_texture_env_add")) {
      if (settings.textureEnvAdd) {
        this.contextState.textureExtensions = { ...this.contextState.textureExtensions, textureEnvAddAvailable: true };
        emit("...using GL_EXT_texture_env_add\n");
      } else emit("...ignoring GL_EXT_texture_env_add\n");
    } else emit("...GL_EXT_texture_env_add not found\n");
    if (extensions.includes("gl_arb_multitexture")) {
      if (settings.multitexture) {
        this.contextState.textureExtensions = { ...this.contextState.textureExtensions, maxActiveTextures: this.capabilities.textureUnits };
        emit(this.capabilities.textureUnits > 1 ? "...using GL_ARB_multitexture\n" : "...not using GL_ARB_multitexture, < 2 texture units\n");
      } else emit("...ignoring GL_ARB_multitexture\n");
    } else emit("...GL_ARB_multitexture not found\n");
    if (extensions.includes("gl_ext_compiled_vertex_array")) {
      if (settings.compiledVertexArrays) {
        emit("...using GL_EXT_compiled_vertex_array\n"); loadCompiledArrays(); this.contextState.compiledVertexArrays = true;
      } else emit("...ignoring GL_EXT_compiled_vertex_array\n");
    } else emit("...GL_EXT_compiled_vertex_array not found\n");
  }
  get textureCompression(): "none" | "s3tc" { return this.contextState.textureCompression ?? "none"; }
  get compiledVertexArrays(): boolean { return this.compiledArrays !== null; }
  get textureExtensions(): {
    readonly maxActiveTextures: number; readonly textureEnvAddAvailable: boolean;
  } {
    this.available();
    if (this.contextState.textureExtensions === null) throw new Error("Source texture extensions have not initialized");
    return this.contextState.textureExtensions;
  }
  private lockArrays(count: number): void {
    if (this.compiledArrays === null) return;
    if (this.arraysLocked) throw new Error("Source vertex arrays are already locked");
    this.compiledArrays.symbols.glLockArraysEXT(0, count);
    this.arraysLocked = true;
    this.logging?.comment("glLockArraysEXT\n");
  }
  private unlockArrays(): void {
    if (!this.arraysLocked) return;
    if (this.compiledArrays === null) throw new Error("Locked source arrays lost their extension functions");
    this.compiledArrays.symbols.glUnlockArraysEXT();
    this.arraysLocked = false;
    this.logging?.comment("glUnlockArraysEXT\n");
  }
  endFrameLogging(): void { this.available(); this.logging?.endFrame(); }
  checkDiagnosticFrameErrors(): void {
    this.available();
    this.logging?.errors?.check("GLimp_EndFrame", () => this.library.symbols.glGetError());
  }
  initializeAppleTransformHint(enabled: () => boolean, print: (text: string) => undefined): void {
    this.opened();
    applyAppleTransformHint({ extensions: this.extensions, enabled, gl: this.gl,
      print: text => { print(text); this.opened(); } });
  }
  /** Mac GLimp_EndFrame applies this after the actual swap. */
  updateRenderingEnabled(value: number, print: (text: string) => undefined): void {
    this.available();
    if (Number(this.window.renderingEnabled) === value) return;
    print(value !== 0 ? "--- Enabling Renderer ---\n" : "--- Disabling Renderer ---\n");
    this.available();
    this.window.setRenderingEnabled(value !== 0);
  }
  private opened(): void { this.available(); this.window.makeCurrent(); }
  /** InitOpenGL reaches this after R_InitCommandBuffers and GfxInfo_f. */
  initializeDefaultState(multitexture: boolean, textureMode: () => undefined): void {
    this.opened();
    if (multitexture && this.capabilities.textureUnits < 2) throw new Error("GL default state requires the configured second texture unit");
    const gl = this.gl;
    gl.glClearDepth(1);
    gl.glCullFace(0x404);
    gl.glColor4f(1, 1, 1, 1);
    if (multitexture) {
      this.select(1);
      textureMode(); this.opened();
      this.textureEnvironment("modulate");
      gl.glDisable(0xde1);
      this.select(0);
    }
    gl.glEnable(0xde1);
    textureMode(); this.opened();
    this.textureEnvironment("modulate");
    gl.glShadeModel(0x1d01);
    gl.glDepthFunc(0x203);
    gl.glEnableClientState(0x8074);
    this.contextState.bits = SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.DEPTHMASK_TRUE;
    gl.glPolygonMode(0x408, 0x1b02);
    gl.glDepthMask(1);
    gl.glDisable(0xb71);
    gl.glEnable(0xc11);
    gl.glDisable(0xb44);
    gl.glDisable(0xbe2);
  }
  private registered(image: RendererImage): RegisteredImage {
    this.images.requireOwned(image);
    const registered = this.textures.get(image);
    if (registered === undefined) throw new Error("GL image has not been created on this backend");
    return registered;
  }
  private select(unit: 0 | 1): void {
    if (unit === this.currentUnit) return;
    const gl = this.gl;
    gl.glActiveTexture(0x84c0 + unit);
    this.logging?.comment(unit === 0 ? "glActiveTextureARB( GL_TEXTURE0_ARB )\n" : "glActiveTextureARB( GL_TEXTURE1_ARB )\n");
    gl.glClientActiveTexture(0x84c0 + unit);
    this.logging?.comment(unit === 0 ? "glClientActiveTextureARB( GL_TEXTURE0_ARB )\n" : "glClientActiveTextureARB( GL_TEXTURE1_ARB )\n");
    this.currentUnit = unit;
  }
  private textureEnvironment(environment: TextureEnvironment): void {
    if (this.contextState.textureEnvironments[this.currentUnit] === environment) return;
    this.contextState.textureEnvironments[this.currentUnit] = environment;
    this.gl.glTexEnvf(0x2300, 0x2200, environment === "modulate" ? 0x2100 : environment === "add" ? 0x104 : 0x1e01);
  }
  private coordinatePointer(array: CoordinateClientArray): void {
    if (array.values.length === 0) {
      // Empty stages still select an origin, but cannot pass a zero-length FFI pointer.
      const previous = this.coordinateClientArrays[this.currentUnit];
      this.coordinateClientArrays[this.currentUnit] = { origin: array.origin, values: previous === null ? array.values : previous.values };
      return;
    }
    this.coordinateClientArrays[this.currentUnit] = array;
    this.gl.glTexCoordPointer(2, 0x1406, 0, array.values);
  }
  private colorPointer(values: Float32Array): void {
    if (values.length === 0) return;
    this.colorClientArray = values;
    this.gl.glColorPointer(4, 0x1406, 0, values);
  }
  private refreshSourceCoordinates(arrays: SourceCoordinateArrays): void {
    const selected = this.currentUnit;
    for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
      const pointer = this.coordinateClientArrays[unit];
      if (pointer === null || pointer.origin === "local" || pointer.origin === "direct") continue;
      const values = arrays[pointer.origin];
      if (values.length === 0 || values === pointer.values) continue;
      this.select(unit); this.coordinatePointer({ origin: pointer.origin, values });
    }
    this.select(selected);
  }
  private validateCoordinateArrays(indices: readonly number[]): void {
    for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
      if (unit === 0 ? !this.primaryClientArrayEnabled : !this.secondaryClientArrayEnabled) continue;
      const pointer = this.coordinateClientArrays[unit];
      if (pointer === null) throw new RangeError("GL enabled texture coordinate array is unallocated");
      for (const index of indices) {
        const x = pointer.values[index * 2], y = pointer.values[index * 2 + 1];
        if (x === undefined || y === undefined) throw new RangeError("GL retained texture coordinates are outside their allocation");
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("GL texture coordinates must be finite float32 values");
      }
    }
  }
  private bind(image: RendererImage): RegisteredImage {
    const registered = this.registered(image);
    const selected = this.images.noBind && this.dlightImage !== null ? this.dlightImage : image;
    if (this.cachedBindings[this.currentUnit] !== selected) {
      const object = selected === image ? registered.object : this.registered(selected).object;
      this.images.markUsed(image);
      this.cachedBindings[this.currentUnit] = selected;
      this.gl.glBindTexture(0xde1, object.name);
      this.actualObjects[this.currentUnit] = object;
    }
    return registered;
  }
  private textureParameters(sampling: TextureSampling): void {
    this.textureFilter(sampling.filter);
    this.textureWrap(sampling.wrap);
  }
  private textureWrap(mode: TextureSampling["wrap"]): void {
    const gl = this.gl, wrap = mode === "repeat" ? 0x2901 : 0x2900;
    gl.glTexParameteri(0xde1, 0x2802, wrap); gl.glTexParameteri(0xde1, 0x2803, wrap);
  }
  private textureFilter(filter: TextureFilter): void {
    const gl = this.gl, [min, mag] = textureFilters[filter];
    gl.glTexParameteri(0xde1, 0x2801, min); gl.glTexParameteri(0xde1, 0x2800, mag);
  }
  /** tr_init.c GL_CheckErrors, reached by Upload32 before wrap parameters and unbind. */
  private checkUploadErrors(): void {
    const error = this.gl.glGetError();
    if (error === 0) return;
    if (this.images.ignoreGLErrors) return;
    let name: string;
    switch (error) {
      case 0x500: name = "GL_INVALID_ENUM"; break;
      case 0x501: name = "GL_INVALID_VALUE"; break;
      case 0x502: name = "GL_INVALID_OPERATION"; break;
      case 0x503: name = "GL_STACK_OVERFLOW"; break;
      case 0x504: name = "GL_STACK_UNDERFLOW"; break;
      case 0x505: name = "GL_OUT_OF_MEMORY"; break;
      default: name = String(error | 0); break;
    }
    throw new CommonError("fatal", `GL_CheckErrors: ${name}`);
  }
  private beginImage(creation: BeginImageOperation): RegisteredImage {
    const { image, mipmap, registrationUnit } = creation;
    this.images.requireOwned(image);
    if (this.textures.has(image)) throw new Error("GL image is already created");
    if (registrationUnit === 1 && this.capabilities.textureUnits < 2) throw new Error("GL renderer does not support image registration on texture unit one");
    const name = 1024 + image.ordinal;
    if (name > 0xffffffff) throw new RangeError("GL image name exceeds uint32");
    const object: GlTextureObject = { name, handle: new Uint32Array([name]) };
    const registered: RegisteredImage = { object, mipmap, uploadPhase: { kind: "pending" },
      logicalWidth: image.sourceWidth, logicalHeight: image.sourceHeight, uploadWidth: 0, uploadHeight: 0 };
    this.opened(); this.textures.set(image, registered);
    image.setUploadDimensions(0, 0);
    this.select(registrationUnit); this.bind(image);
    return registered;
  }

  private uploadImageLevel(operation: Extract<ImageResourceOperation, { readonly kind: "upload-image-level" }>): void {
    const registered = this.registered(operation.image), phase = registered.uploadPhase;
    const nextLevel = phase.kind === "uploading" ? phase.nextLevel : phase.kind === "pending" ? 0 : null;
    if (nextLevel === null) throw new Error("GL image upload is already checked");
    if (operation.index !== nextLevel) throw new Error("GL image upload levels are out of order");
    const level = operation.content;
    this.uploadDimensions(level.width, level.height);
    this.opened();
    this.gl.glTexImage2D(0xde1, operation.index, internalFormats[operation.internalFormat], level.width, level.height,
      0, 0x1908, 0x1401, level.copyPixels());
    registered.uploadPhase = { kind: "uploading", nextLevel: operation.index + 1 };
  }

  private setImageUploadDescriptor(operation: Extract<ImageResourceOperation, { readonly kind: "set-image-upload-descriptor" }>): void {
    const registered = this.registered(operation.image);
    if (registered.uploadPhase.kind !== "pending" && registered.uploadPhase.kind !== "uploading") throw new Error("GL image upload is already checked");
    registered.uploadWidth = operation.width; registered.uploadHeight = operation.height;
    operation.image.setUploadDescriptor(operation.width, operation.height, operation.internalFormat);
  }

  private finishImageUpload(image: RendererImage, filter: TextureFilter): void {
    const registered = this.registered(image);
    if (registered.uploadPhase.kind !== "uploading") throw new Error("GL image upload has no unchecked levels");
    this.opened();
    this.textureFilter(filter);
    this.checkUploadErrors();
    registered.uploadPhase = { kind: "checked" };
  }

  applyImageResource(operation: ImageResourceOperation): undefined {
    this.available();
    if (operation.kind === "begin-image") { this.beginImage(operation.creation); return; }
    if (operation.kind === "upload-image-level") { this.uploadImageLevel(operation); return; }
    if (operation.kind === "set-image-upload-descriptor") { this.setImageUploadDescriptor(operation); return; }
    if (operation.kind === "finish-image-upload") { this.finishImageUpload(operation.image, operation.filter); return; }
    if (operation.kind === "dlight-image") {
      this.registered(operation.image); this.dlightImage = operation.image; return;
    }
    if (operation.kind === "current-border-color") {
      const color = operation.color; this.borderParameter.set([color.x, color.y, color.z, color.w]);
      this.opened(); this.gl.glTexParameterfv(0xde1, 0x1004, this.borderParameter); return;
    }
    if (operation.kind === "texture-mode") {
      this.opened();
      // GL_TextureMode retains the current TMU and uses GL_Bind's cache, even
      // after R_CreateImage left the actual binding at object zero.
      for (const [image, registered] of this.textures) if (registered.mipmap) {
        this.bind(image); this.textureFilter(operation.filter);
      }
      return;
    }
    const { image, levels, internalFormat, sampling, registrationUnit } = operation.creation;
    this.images.requireOwned(image);
    let registered = this.textures.get(image);
    if (registered === undefined) {
      registered = this.beginImage(operation.creation);
      this.setImageUploadDescriptor({ kind: "set-image-upload-descriptor", image, width: levels[0].width, height: levels[0].height, internalFormat });
      for (const [index, content] of levels.entries()) this.uploadImageLevel({ kind: "upload-image-level", image, index, content, internalFormat });
      this.finishImageUpload(image, sampling.filter);
    }
    if (registered.uploadPhase.kind !== "checked") throw new Error("GL image creation did not reach its upload check");
    this.opened();
    const gl = this.gl;
    this.textureWrap(sampling.wrap);
    gl.glBindTexture(0xde1, 0); this.actualObjects[this.currentUnit] = this.zero;
    if (registrationUnit === 1) this.select(0);
    registered.uploadPhase = { kind: "complete" };
  }
  private uploadDimensions(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > this.maxTextureSize || height > this.maxTextureSize) throw new RangeError("GL upload dimensions exceed the device limits");
  }
  private cinematic(upload: CinematicUpload): void {
    this.uploadDimensions(upload.uploadWidth, upload.uploadHeight);
    if (upload.content.width !== upload.uploadWidth || upload.content.height !== upload.uploadHeight) throw new Error("GL cinematic snapshot dimensions do not match upload");
    const image = this.bind(upload.image), gl = this.gl;
    if (image.logicalWidth !== upload.uploadWidth || image.logicalHeight !== upload.uploadHeight) {
      this.images.resizeCinematic(upload.image, upload.uploadWidth, upload.uploadHeight);
      image.logicalWidth = upload.uploadWidth; image.logicalHeight = upload.uploadHeight;
      image.uploadWidth = upload.uploadWidth; image.uploadHeight = upload.uploadHeight;
      gl.glTexImage2D(0xde1, 0, 0x8051, upload.uploadWidth, upload.uploadHeight, 0, 0x1908, 0x1401, upload.content.copyPixels());
      this.textureParameters({ wrap: "clamp", filter: "linear" });
    } else if (upload.dirty) gl.glTexSubImage2D(0xde1, 0, 0, 0, upload.uploadWidth, upload.uploadHeight, 0x1908, 0x1401, upload.content.copyPixels());
    // Default r_ignoreGLErrors=1 preserves rejected subimages and sticky native
    // errors. Do not consume them here or turn them into upload exceptions.
  }
  private setDepthRange(range: readonly [number, number]): void {
    this.actualDepthRange = [Math.max(0, Math.min(1, range[0])), Math.max(0, Math.min(1, range[1]))];
    this.gl.glDepthRange(this.actualDepthRange[0], this.actualDepthRange[1]);
  }
  /** GL_State changes these bits independently of culling, depth range and polygon offset. */
  private stateBits(bits: number): void {
    const gl = this.gl;
    for (const change of sourceStateChanges(this.contextState.bits, bits)) {
      switch (change.kind) {
        case "depth-function": gl.glDepthFunc(change.value === "equal" ? 0x202 : 0x203); break;
        case "blend":
          if (change.enabled) { gl.glEnable(0xbe2); gl.glBlendFunc(blendFactors[change.source], blendFactors[change.destination]); }
          else gl.glDisable(0xbe2);
          break;
        case "depth-write": gl.glDepthMask(change.value ? 1 : 0); break;
        case "polygon-mode": gl.glPolygonMode(0x408, change.value === "line" ? 0x1b01 : 0x1b02); break;
        case "depth-test":
          if (change.enabled) gl.glEnable(0xb71);
          else gl.glDisable(0xb71);
          break;
        case "alpha-test":
          if (change.value === "none") gl.glDisable(0xbc0);
          else { gl.glEnable(0xbc0); gl.glAlphaFunc(change.value === "gt0" ? 0x204 : change.value === "lt128" ? 0x201 : 0x206, change.value === "gt0" ? 0 : 0.5); }
          break;
        default: { const unexpected: never = change; throw new Error(`Unknown source state change ${unexpected}`); }
      }
    }
    // A blend ERR_DROP leaves any earlier depth-function write and the old raw cache.
    this.contextState.bits = bits;
  }
  private state(state: RenderState, depthRange: readonly [number, number] | null): void {
    const gl = this.gl;
    const { source, destination } = state.blend;
    if (state.depthTest !== "always" && source !== "src-color" && source !== "one-minus-src-color"
      && destination !== "dst-color" && destination !== "one-minus-dst-color" && destination !== "src-alpha-saturate") {
      this.stateBits(sourceStateBits({ depthTest: state.depthTest, depthWrite: state.depthWrite, alphaTest: state.alphaTest,
        blend: source === "one" && destination === "zero" ? null : { source, destination } }));
    } else {
      // Diagnostic GL states can exceed the source bit encoding.
      this.contextState.bits = null;
      gl.glDepthFunc(state.depthTest === "less-equal" ? 0x203 : state.depthTest === "equal" ? 0x202 : 0x207);
      if (source === "one" && destination === "zero") gl.glDisable(0xbe2);
      else { gl.glEnable(0xbe2); gl.glBlendFunc(blendFactors[source], blendFactors[destination]); }
      gl.glDepthMask(state.depthWrite ? 1 : 0);
      gl.glPolygonMode(0x408, 0x1b02); gl.glEnable(0xb71);
      if (state.alphaTest === "none") gl.glDisable(0xbc0);
      else { gl.glEnable(0xbc0); gl.glAlphaFunc(state.alphaTest === "gt0" ? 0x204 : state.alphaTest === "lt128" ? 0x201 : 0x206, state.alphaTest === "gt0" ? 0 : 0.5); }
    }
    if (depthRange !== null) this.setDepthRange(depthRange);
    if (state.polygonOffset === undefined) gl.glDisable(0x8037);
    else { gl.glEnable(0x8037); gl.glPolygonOffset(state.polygonOffset.factor, state.polygonOffset.units); }
    if (state.cull === "none") gl.glDisable(0xb44);
    else { gl.glEnable(0xb44); gl.glCullFace(state.cull === "back" ? 0x405 : 0x404); }
  }
  beginView(view: RenderViewState): undefined {
    this.available();
    const { x, y, width, height } = view.viewport, bottom = this.height - y - height;
    if (![x, y, width, height, bottom].every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) || width <= 0 || height <= 0) throw new RangeError("GL viewport requires positive int32 dimensions");
    const clear = view.clear;
    if (clear !== null && (!Number.isFinite(clear.depth) || typeof clear.stencil !== "boolean"
      || clear.color !== null && ![clear.color.x, clear.color.y, clear.color.z, clear.color.w].every(finite32))) throw new Error("GL clear values must be finite with a boolean stencil clear");
    const equation = this.clipState.enterView(view.clipPlane);
    this.opened(); const gl = this.gl;
    gl.glViewport(x, bottom, width, height); gl.glEnable(0xc11); gl.glScissor(x, bottom, width, height);
    if (equation === null) gl.glDisable(0x3000);
    else {
      gl.glMatrixMode(0x1700); gl.glLoadIdentity();
      gl.glClipPlane(0x3000, new Float64Array([equation.x, equation.y, equation.z, equation.w]));
      gl.glEnable(0x3000);
    }
    if (clear !== null) {
      this.portalView = view.clipPlane !== undefined && "kind" in view.clipPlane && view.clipPlane.kind === "portal";
      this.stateBits(SourceStateBit.DEFAULT);
      gl.glClearDepth(clear.depth); const color = clear.color;
      if (color !== null) gl.glClearColor(color.x, color.y, color.z, color.w);
      gl.glClear(0x100 | (color === null ? 0 : 0x4000) | (clear.stencil ? 0x400 : 0));
      if (clear.stencil) {
        // NVIDIA 610.57.04 needs enabled texture state revalidated after a stencil clear.
        const selector = new Int32Array(1); gl.glGetIntegerv(0x84e0, selector);
        const active = selector[0];
        if (active === undefined || active < 0x84c0 || active >= 0x84c0 + this.capabilities.textureUnits) throw new Error("GL returned an invalid active texture selector");
        try {
          for (const unit of [0, 1]) if (unit < this.capabilities.textureUnits) {
            gl.glActiveTexture(0x84c0 + unit);
            if (gl.glIsEnabled(0xde1) !== 0) { gl.glDisable(0xde1); gl.glEnable(0xde1); }
          }
        } finally { gl.glActiveTexture(active); }
      }
    } else {
      this.stateBits(SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.SRCBLEND_SRC_ALPHA | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA);
      gl.glDisable(0xb44);
    }
  }
  drawImmediate(operation: ImmediateViewOperation): undefined {
    this.available();
    if (operation.kind === "display-list") {
      this.opened(); this.gl.glCallList(operation.listNum); return;
    }
    if (operation.kind === "disable-portal-clip") {
      this.opened(); this.gl.glDisable(0x3000); this.clipState.disable(); return;
    }
    if (operation.kind === "begin-source-arrays") {
      if (this.sourceArrays !== null) throw new Error("Source iterator vertex allocation is already active");
      if (!Number.isInteger(operation.vertexCount) || operation.vertexCount < 0 || operation.vertexCount > 1000
        || operation.positions.length !== operation.slots.length) throw new RangeError("Invalid source iterator vertex allocation");
      const positions = new Float32Array(operation.vertexCount * 4);
      for (const [index, slot] of operation.slots.entries()) {
        const position = operation.positions[index];
        if (position === undefined || !Number.isInteger(slot) || slot < 0 || slot >= operation.vertexCount
          || !finitePosition(position.x, position.y, position.z, position.w)) throw new RangeError("Invalid indexed source iterator position");
        storeFloat4(positions, position.x, position.y, position.z, position.w, slot * 4);
      }
      this.sourceArrays = { positions, slots: [...operation.slots], vertexCount: operation.vertexCount };
      return;
    }
    if (operation.kind === "end-source-arrays") {
      if (this.sourceArrays === null) throw new Error("Source iterator vertex allocation is not active");
      this.opened(); this.unlockArrays(); this.sourceArrays = null; return;
    }
    if (operation.kind === "log-comment") { this.logging?.comment(operation.text); return; }
    if (operation.kind === "begin-generic-iterator") {
      const count = this.sourceArrays?.vertexCount ?? operation.scratch.length;
      const colors = new Float32Array(count * 4);
      const svars0 = new Float32Array(count * 2), svars1 = new Float32Array(count * 2);
      const raw0 = new Float32Array(count * 2), raw1 = new Float32Array(count * 2);
      for (const [index, cell] of operation.scratch.entries()) {
        const slot = this.sourceArrays === null ? index : this.sourceArrays.slots[index];
        if (slot === undefined) throw new RangeError("Source generic scratch has no vertex slot");
        storeFloat4(colors, cell.color.x, cell.color.y, cell.color.z, cell.color.w, slot * 4);
        storeFloat2(svars0, cell.texCoord.x, cell.texCoord.y, slot * 2);
        storeFloat2(svars1, cell.texCoord2.x, cell.texCoord2.y, slot * 2);
        storeFloat2(raw0, cell.rawTexCoord.x, cell.rawTexCoord.y, slot * 2);
        storeFloat2(raw1, cell.rawTexCoord2.x, cell.rawTexCoord2.y, slot * 2);
      }
      this.opened(); const gl = this.gl;
      this.genericArraysOnce = operation.setArraysOnce;
      this.refreshSourceCoordinates({ svars0, svars1, raw0, raw1 });
      if (this.genericArraysOnce) {
        gl.glEnableClientState(0x8076); this.colorPointer(colors);
        gl.glEnableClientState(0x8078); this.coordinatePointer({ origin: "svars0", values: svars0 });
      } else {
        gl.glDisableClientState(0x8076); gl.glDisableClientState(0x8078);
      }
      if (this.sourceArrays !== null) {
        this.vertexClientArray = this.sourceArrays.positions;
        gl.glVertexPointer(4, 0x1406, 0, this.vertexClientArray);
        this.lockArrays(this.sourceArrays.vertexCount);
      }
      if (!this.genericArraysOnce) { gl.glEnableClientState(0x8078); gl.glEnableClientState(0x8076); }
      if (this.currentUnit === 0) this.primaryClientArrayEnabled = true;
      else this.secondaryClientArrayEnabled = true;
      return;
    }
    if (operation.kind === "depth-range" || operation.kind === "cull" || operation.kind === "sky-box-state" || operation.kind === "polygon-offset") {
      validateRenderStateOperation(operation);
      this.opened(); const gl = this.gl;
      switch (operation.kind) {
        case "depth-range": this.setDepthRange(operation.range); break;
        case "cull":
          if (operation.cull === "none") gl.glDisable(0xb44);
          else { gl.glEnable(0xb44); gl.glCullFace(operation.cull === "back" ? 0x405 : 0x404); }
          break;
        case "sky-box-state":
          gl.glColor3f(operation.identityLight, operation.identityLight, operation.identityLight);
          this.stateBits(0);
          break;
        case "polygon-offset":
          if (operation.value === null) gl.glDisable(0x8037);
          else { gl.glEnable(0x8037); gl.glPolygonOffset(operation.value.factor, operation.value.units); }
          break;
      }
      return;
    }
    if (operation.kind === "sky-side") {
      this.opened(); const gl = this.gl;
      this.bind(operation.image);
      if (operation.strips.length === 0) return;
      // Positions already include the source sky modelview and projection.
      for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
      for (const strip of operation.strips) {
        if (strip.length < 2 || strip.length % 2 !== 0) throw new RangeError("GL sky strips require pairs of row vertices");
        for (const vertex of strip) {
          const { position, texCoord } = vertex;
          if (![position.x, position.y, position.z, position.w, texCoord.x, texCoord.y].every(finite32))
            throw new RangeError("GL sky vertices must be finite float32 values");
        }
        gl.glBegin(5);
        for (const vertex of strip) {
          gl.glTexCoord2f(vertex.texCoord.x, vertex.texCoord.y);
          gl.glVertex4f(vertex.position.x, vertex.position.y, vertex.position.z, vertex.position.w);
        }
        gl.glEnd();
      }
      return;
    }
    if (operation.kind === "begin-debug-surface") {
      this.registered(operation.whiteImage);
      validateRenderStateOperation({ kind: "cull", cull: operation.cull });
      this.opened(); const gl = this.gl;
      this.bind(operation.whiteImage);
      if (operation.cull === "none") gl.glDisable(0xb44);
      else { gl.glEnable(0xb44); gl.glCullFace(operation.cull === "back" ? 0x405 : 0x404); }
      return;
    }
    if (operation.kind === "debug-polygon") {
      if (!Number.isInteger(operation.color) || operation.color < -0x80000000 || operation.color > 0x7fffffff) throw new RangeError("GL debug polygon color must be int32");
      for (const position of operation.positions) {
        if (!finitePosition(position.x, position.y, position.z, position.w)) throw new RangeError("GL debug polygon positions must be finite float32 values");
      }
      this.opened(); const gl = this.gl;
      for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
      const state = SourceStateBit.DEPTHMASK_TRUE | SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE;
      const draw = (): void => {
        gl.glBegin(9);
        for (const position of operation.positions) gl.glVertex4f(position.x, position.y, position.z, position.w);
        gl.glEnd();
      };
      this.stateBits(state);
      gl.glColor3f(operation.color & 1, (operation.color >> 1) & 1, (operation.color >> 2) & 1); draw();
      this.stateBits(state | SourceStateBit.POLYMODE_LINE); this.setDepthRange([0, 0]);
      gl.glColor3f(1, 1, 1); draw();
      this.setDepthRange([0, 1]);
      return;
    }
    if (operation.kind === "entity-beam" || operation.kind === "entity-axis") {
      const beam = operation.kind === "entity-beam";
      if (operation.positions.length !== (beam ? 14 : 6)) throw new RangeError(beam ? "Entity beam requires fourteen strip positions" : "Entity axis requires six line positions");
      for (const position of operation.positions) {
        if (!finitePosition(position.x, position.y, position.z, position.w)) throw new RangeError("Entity positions must be finite float32 values");
      }
      this.registered(operation.whiteImage);
      this.opened(); const gl = this.gl;
      this.bind(operation.whiteImage);
      // The frontend has already applied the retained source model/projection.
      for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
      if (beam) {
        this.stateBits(SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ONE);
        gl.glColor3f(1, 0, 0);
      } else gl.glLineWidth(3);
      gl.glBegin(beam ? 5 : 1);
      for (const [index, position] of operation.positions.entries()) {
        if (!beam && index % 2 === 0) gl.glColor3f(index === 0 ? 1 : 0, index === 2 ? 1 : 0, index === 4 ? 1 : 0);
        gl.glVertex4f(position.x, position.y, position.z, position.w);
      }
      gl.glEnd();
      if (!beam) gl.glLineWidth(1);
      return;
    }
    if (this.stencilBits < 4) return;
    if (operation.kind === "shadow-finish" && operation.positions.length !== 4) throw new RangeError("Shadow finish requires four positions");
    for (const position of operation.positions) {
      if (!finitePosition(position.x, position.y, position.z, position.w)) throw new RangeError("Shadow positions must be finite float32 values");
    }
    if (operation.kind === "shadow-finish") {
      this.opened(); const gl = this.gl;
      gl.glEnable(0xb90); gl.glStencilFunc(0x205, 0, 255);
      gl.glDisable(0x3000); this.clipState.disable(); gl.glDisable(0xb44);
      this.bind(operation.whiteImage);
      for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
      gl.glColor3f(0.6, 0.6, 0.6);
      this.stateBits(SourceStateBit.DEPTHMASK_TRUE | SourceStateBit.SRCBLEND_DST_COLOR | SourceStateBit.DSTBLEND_ZERO);
      gl.glBegin(7);
      for (const position of operation.positions) gl.glVertex4f(position.x, position.y, position.z, position.w);
      gl.glEnd();
      gl.glColor3f(1, 1, 1); gl.glDisable(0xb90);
      return;
    }
    const vertices = operation.indices.map(index => {
      if (!Number.isInteger(index) || index < 0) throw new RangeError("Shadow vertex index is invalid");
      const position = operation.positions[index];
      if (position === undefined) throw new RangeError("Shadow vertex index is outside its position array");
      return position;
    });
    if (operation.indices.length % 3 !== 0) throw new RangeError("Shadow triangle indices are incomplete");
    this.registered(operation.whiteImage);
    this.opened(); const gl = this.gl;
    this.bind(operation.whiteImage);
    for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
    gl.glEnable(0xb44);
    this.stateBits(SourceStateBit.SRCBLEND_ONE | SourceStateBit.DSTBLEND_ZERO);
    gl.glCullFace(operation.mirror ? 0x404 : 0x405);
    const draw = (): void => {
      gl.glBegin(4);
      for (const position of vertices) gl.glVertex4f(position.x, position.y, position.z, position.w);
      gl.glEnd();
    };
    gl.glEnable(0xb90);
    gl.glColor3f(0.2, 0.2, 0.2); gl.glColorMask(0, 0, 0, 0);
    gl.glStencilFunc(0x207, 1, 255); gl.glStencilOp(0x1e00, 0x1e00, 0x1e02); draw();
    gl.glCullFace(operation.mirror ? 0x405 : 0x404);
    gl.glStencilOp(0x1e00, 0x1e00, 0x1e03); draw();
    gl.glColorMask(1, 1, 1, 1);
  }
  private validateBinding(binding: TextureBinding): void {
    if (binding.kind === "bind-image") this.registered(binding.image);
    else if (binding.kind === "shader-cinematic") this.registered(binding.source.image);
    else if (binding.kind !== "retain-current-texture") throw new Error("GL texture binding is invalid");
  }
  private emitTriangleStrips(indices: readonly number[], element: (index: number) => undefined): void {
    let begun = false;
    const end = (): undefined => { begun = false; this.gl.glEnd(); };
    try {
      emitSourceTriangleStrips(indices, {
        begin: () => { this.gl.glBegin(5); begun = true; }, element, end,
      });
    } finally {
      if (begun) end();
    }
  }
  prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
    const prepared = this.prepareBatch(batch, null);
    return { begin: prepared.begin, applyTexture: prepared.applyTexture,
      draw: () => prepared.draw(2), cleanup: prepared.cleanup };
  }
  prepareSourceGeometry(stage: SourceStageData, allocation: SourceGeometryAllocation = { kind: "standalone" }): PreparedBackendSourceDraw {
    if (allocation.kind === "standalone") return this.prepareBatch(stage.batch, stage);
    const retained = this.sourceArrays;
    if (retained === null || retained.vertexCount !== allocation.vertexCount || allocation.slots.length !== stage.batch.vertices.length)
      throw new Error("Source stage does not match its retained vertex allocation");
    const zero: SourceStageCell = { color: { x: 0, y: 0, z: 0, w: 0 }, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0 },
      rawTexCoord: { x: 0, y: 0 }, rawTexCoord2: { x: 0, y: 0 } };
    const scratch: SourceStageCell[] = Array.from({ length: retained.vertexCount }, () => zero);
    const vertices = Array.from({ length: retained.vertexCount }, (_unused, index) => {
      const position: Vec4 = { x: retained.positions[index * 4] ?? 0, y: retained.positions[index * 4 + 1] ?? 0,
        z: retained.positions[index * 4 + 2] ?? 0, w: retained.positions[index * 4 + 3] ?? 0 };
      return { position, color: zero.color, texCoord: zero.texCoord, texCoord2: zero.texCoord2 };
    });
    for (const [index, slot] of allocation.slots.entries()) {
      const vertex = stage.batch.vertices[index], cell = stage.scratch[index];
      if (!Number.isInteger(slot) || slot < 0 || slot >= retained.vertexCount || vertex === undefined || cell === undefined)
        throw new RangeError("Source stage has an invalid retained vertex slot");
      scratch[slot] = cell;
      vertices[slot] = { ...vertex, texCoord2: "texCoord2" in vertex ? vertex.texCoord2 : zero.texCoord2 };
    }
    const indices = stage.batch.indices.map(index => {
      const slot = allocation.slots[index];
      if (slot === undefined) throw new RangeError("Source stage index has no retained vertex slot");
      return slot;
    });
    switch (stage.kind) {
      case "generic-pair": case "lightmapped-pair": {
        const expanded: SourceStageData = { ...stage, scratch, batch: { texturing: "pair", primitive: "triangles", vertices, indices,
          state: stage.batch.state, secondTexture: stage.batch.secondTexture, get texture() { return stage.batch.texture; } } };
        return this.prepareBatch(expanded.batch, expanded);
      }
      case "generic-single": case "vertex-lit": case "dlight": case "fog": {
        const expanded: SourceStageData = { ...stage, scratch, batch: { texturing: "single", primitive: "triangles", vertices, indices,
          state: stage.batch.state, get texture() { return stage.batch.texture; } } };
        return this.prepareBatch(expanded.batch, expanded);
      }
    }
  }
  private prepareBatch(batch: DrawBatch, source: SourceStageData | null): PreparedBackendSourceDraw {
    this.available();
    const state = source === null ? copyState(batch.state) : null;
    const packed = pack(batch), arrays: Arrays = source !== null && this.sourceArrays !== null
      ? { ...packed, positions: this.sourceArrays.positions } : packed;
    const mode = batch.primitive === "lines" ? 1 : 4;
    const lineWidth = batch.primitive === "lines" ? batch.lineWidth : 1;
    const paired = batch.texturing === "pair";
    const environment: TextureEnvironment = source === null && paired ? batch.secondTexture.environment : "modulate";
    const validateEnvironment = (value: TextureEnvironment): void => {
      if (!["modulate", "add", "replace"].includes(value) || value === "add" && !this.capabilities.textureEnvAdd) throw new Error("GL texture environment is unsupported");
    };
    if (source === null) {
      this.validateBinding(batch.texture);
      if (paired) {
        if (this.capabilities.textureUnits < 2) throw new Error("GL renderer does not support two fixed-function texture units");
        validateEnvironment(environment);
        this.validateBinding(batch.secondTexture.binding);
      }
    }
    if (source !== null && source.scratch.length !== batch.vertices.length) throw new RangeError("Source stage scratch must match its published vertex allocation");
    const scratchCoordinates0 = new Float32Array(source === null ? 0 : batch.vertices.length * 2);
    const scratchCoordinates1 = new Float32Array(source === null ? 0 : batch.vertices.length * 2);
    const rawCoordinates0 = new Float32Array(source === null ? 0 : batch.vertices.length * 2);
    const rawCoordinates1 = new Float32Array(source === null ? 0 : batch.vertices.length * 2);
    const sourceVertices = source === null ? null : batch.vertices.map((vertex, index) => {
      const cell = source.scratch[index];
      if (cell === undefined) throw new RangeError("Source stage scratch cell is unallocated");
      const colorX = cell.color.x, colorY = cell.color.y, colorZ = cell.color.z, colorW = cell.color.w;
      if (!Number.isFinite(colorX) || colorX < 0 || colorX > 1 || !Number.isFinite(colorY) || colorY < 0 || colorY > 1
        || !Number.isFinite(colorZ) || colorZ < 0 || colorZ > 1 || !Number.isFinite(colorW) || colorW < 0 || colorW > 1)
        throw new RangeError("Source stage colors must be normalized bytes");
      const texCoordX = cell.texCoord.x, texCoordY = cell.texCoord.y, texCoord2X = cell.texCoord2.x, texCoord2Y = cell.texCoord2.y;
      if (!finite32(texCoordX) || !finite32(texCoordY) || !finite32(texCoord2X) || !finite32(texCoord2Y))
        throw new RangeError("Source stage coordinates must be finite float32 values");
      storeFloat2(scratchCoordinates0, cell.texCoord.x, cell.texCoord.y, index * 2);
      storeFloat2(scratchCoordinates1, cell.texCoord2.x, cell.texCoord2.y, index * 2);
      storeFloat2(rawCoordinates0, cell.rawTexCoord.x, cell.rawTexCoord.y, index * 2);
      storeFloat2(rawCoordinates1, cell.rawTexCoord2.x, cell.rawTexCoord2.y, index * 2);
      return { position: { ...vertex.position }, color: { x: Math.round(cell.color.x * 255), y: Math.round(cell.color.y * 255),
        z: Math.round(cell.color.z * 255), w: Math.round(cell.color.w * 255) }, texCoord: { ...cell.texCoord } };
    });
    const retainSecondary = source?.kind === "generic-pair";
    const stripIndices = source === null ? [] : [...arrays.indices];
    const enableSourceCoordinates = (): void => {
      this.gl.glEnableClientState(0x8078);
      if (this.currentUnit === 0) this.primaryClientArrayEnabled = true;
      else this.secondaryClientArrayEnabled = true;
    };
    const sourceCoordinates = (secondary: boolean): void => {
      const origin: CoordinateClientArray["origin"] = source?.kind === "lightmapped-pair" ? secondary ? "raw1" : "raw0"
        : source?.kind === "vertex-lit" ? "raw0" : source?.kind === "dlight" ? "local" : secondary ? "svars1" : "svars0";
      const values = origin === "raw0" ? rawCoordinates0 : origin === "raw1" ? rawCoordinates1 : secondary ? arrays.texCoords2 : arrays.texCoords;
      this.coordinatePointer({ origin, values });
    };
    let phase: "prepared" | "begun" | "textures-ready" | "drawn" | "cleaned" = "prepared", nextUnit = 0;
    let preparedUnit: 0 | 1 | null = null;
    return {
      begin: () => {
        if (phase !== "prepared") throw new Error("GL prepared draw has already begun");
        this.opened(); const gl = this.gl;
        if (source !== null) this.refreshSourceCoordinates({ svars0: scratchCoordinates0, svars1: scratchCoordinates1,
          raw0: rawCoordinates0, raw1: rawCoordinates1 });
        if (state !== null) this.state(state, state.depthRange ?? [0, 1]);
        else if (source?.kind === "lightmapped-pair") this.stateBits(source.stateBits);
        for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
        const generic = source?.kind === "generic-single" || source?.kind === "generic-pair";
        gl.glEnableClientState(0x8074);
        if (!generic || !this.genericArraysOnce) gl.glEnableClientState(0x8076);
        if (arrays.positions.length !== 0) {
          if (this.vertexClientArray !== arrays.positions) {
            this.vertexClientArray = arrays.positions;
            gl.glVertexPointer(4, 0x1406, 0, this.vertexClientArray);
          }
          if (!generic || !this.genericArraysOnce) this.colorPointer(arrays.colors);
          else {
            const colors = this.colorClientArray;
            if (colors === null || colors.length < arrays.colors.length) throw new RangeError("GL generic color allocation does not match its iterator prefix");
            colors.set(arrays.colors);
          }
        }
        if (source?.kind === "vertex-lit" || source?.kind === "dlight" || source?.kind === "fog") enableSourceCoordinates();
        if (source?.kind === "generic-pair") {
          this.stateBits(source.stateBits);
          // DrawMultitextured's portal workaround changes physical mode, not glStateBits.
          if (this.portalView) gl.glPolygonMode(0x408, 0x1b02);
        }
        if (mode === 1) gl.glLineWidth(lineWidth); phase = "begun";
      },
      prepareTexture: (unit: 0 | 1) => {
        if (source === null || phase !== "begun" || preparedUnit !== null || unit !== nextUnit || unit === 1 && !paired) throw new Error("GL source texture slot order is invalid");
        this.opened(); const gl = this.gl;
        if (unit === 0) {
          if (paired) this.select(0);
          if (source.kind === "lightmapped-pair") enableSourceCoordinates();
          else if (source.kind !== "generic-single" || !this.genericArraysOnce) sourceCoordinates(false);
          if (source.kind === "vertex-lit" && this.sourceArrays !== null) this.lockArrays(this.sourceArrays.vertexCount);
        } else {
          if (source.kind === "lightmapped-pair") sourceCoordinates(false);
          if (this.capabilities.textureUnits < 2) throw new Error("GL renderer does not support two fixed-function texture units");
          this.select(1); gl.glEnable(0xde1);
          if (source.kind === "generic-pair") enableSourceCoordinates();
          if (batch.texturing !== "pair") throw new Error("GL source secondary texture is unavailable");
          const env = batch.secondTexture.environment;
          validateEnvironment(env);
          this.textureEnvironment(env);
          if (source.kind === "generic-pair") sourceCoordinates(true);
        }
        preparedUnit = unit;
      },
      applyTexture: (unit: 0 | 1, operation: ResolvedTextureOperation) => {
        if (phase !== "begun" || unit !== nextUnit || unit === 1 && !paired || source !== null && preparedUnit !== unit) throw new Error("GL prepared texture slot order is invalid");
        this.opened();
        if (source === null) {
          this.select(unit); const gl = this.gl; gl.glEnable(0xde1);
          const env = unit === 0 ? "modulate" : environment;
          this.textureEnvironment(env);
          gl.glEnableClientState(0x8078);
          if (unit === 0) this.primaryClientArrayEnabled = true;
          else this.secondaryClientArrayEnabled = true;
          if (arrays.texCoords.length !== 0) {
            this.coordinatePointer({ origin: "direct", values: unit === 0 ? arrays.texCoords : arrays.texCoords2 });
          }
        }
        if (operation.kind === "bind-image") this.bind(operation.image);
        else if (operation.kind === "cinematic-upload") this.cinematic(operation.upload);
        nextUnit++; preparedUnit = null;
      },
      finishTextures: () => {
        if (source === null || phase !== "begun" || preparedUnit !== null || nextUnit !== (paired ? 2 : 1)) throw new Error("GL source draw has unapplied texture slots");
        this.opened();
        if (source.kind === "lightmapped-pair") {
          enableSourceCoordinates(); sourceCoordinates(true);
          if (this.sourceArrays !== null) this.lockArrays(this.sourceArrays.vertexCount);
        }
        else if (!paired) this.stateBits(source.stateBits);
        phase = "textures-ready";
      },
      draw: (primitives: number) => {
        if (phase !== (source === null ? "begun" : "textures-ready") || nextUnit !== (paired ? 2 : 1)) throw new Error("GL prepared draw has unapplied texture slots");
        this.opened();
        if (arrays.indices.length !== 0) {
          const gl = this.gl, selected = source === null ? "elements" : sourcePrimitiveMode(primitives, this.compiledVertexArrays);
          if (source !== null && (selected === "elements" || selected === "array-strips")) this.validateCoordinateArrays(stripIndices);
          if (selected === "elements") {
            // Direct single batches have no source UV1 cells for the retained pointer.
            const suspendSecondary = source === null && !paired && this.secondaryClientArrayEnabled;
            const unit = this.currentUnit;
            if (suspendSecondary) { this.select(1); gl.glDisableClientState(0x8078); this.select(unit); }
            gl.glDrawElements(mode, arrays.indices.length, 0x1405, arrays.indices);
            if (suspendSecondary) { this.select(1); gl.glEnableClientState(0x8078); this.select(unit); }
          }
          else if (selected === "array-strips") this.emitTriangleStrips(stripIndices, index => { gl.glArrayElement(index); });
          else if (selected === "discrete-strips") {
            if (sourceVertices === null) throw new Error("Source discrete vertices are unavailable");
            this.emitTriangleStrips(stripIndices, index => {
              const vertex = sourceVertices[index];
              if (vertex === undefined) throw new RangeError("Source discrete vertex is unallocated");
              const color = vertex.color, uv = vertex.texCoord, position = vertex.position;
              gl.glColor4ub(color.x, color.y, color.z, color.w);
              if (this.currentUnit !== 0) throw new Error("r_primitives 3 reaches undefined source MultiTexCoordARB targets 0 and 1");
              gl.glTexCoord2f(uv.x, uv.y);
              gl.glVertex4f(position.x, position.y, position.z, position.w);
            });
          }
        }
        phase = "drawn";
      },
      cleanup: () => {
        if (phase !== "drawn") throw new Error("GL prepared draw has not completed");
        this.opened(); const gl = this.gl;
        if (paired) {
          if (source === null) this.select(1);
          gl.glDisable(0xde1);
          if (!retainSecondary) {
            gl.glDisableClientState(0x8078);
            if (this.currentUnit === 0) this.primaryClientArrayEnabled = false;
            else this.secondaryClientArrayEnabled = false;
          }
          this.select(0);
        }
        if (state?.polygonOffset !== undefined) gl.glDisable(0x8037);
        if (mode === 1) gl.glLineWidth(1); phase = "cleaned";
      },
    };
  }
  /** tr_shade.c DrawTris, retaining the selected texture unit and disabled client arrays. */
  prepareDebugTris(input: SourceDebugTris): PreparedBackendDebugTris {
    this.available(); this.registered(input.whiteImage);
    if (input.allocation.kind === "tess") {
      const { slots, vertexCount } = input.allocation;
      if (!Number.isInteger(vertexCount) || vertexCount < 0 || vertexCount > 1000 || slots.length !== input.positions.length)
        throw new RangeError("Invalid source debug vertex allocation");
      const positions: Vec4[] = Array.from({ length: vertexCount }, () => ({ x: 0, y: 0, z: 0, w: 0 }));
      const scratch: SourceStageCell[] = Array.from({ length: vertexCount }, () => ({ color: { x: 0, y: 0, z: 0, w: 0 },
        texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0 }, rawTexCoord: { x: 0, y: 0 }, rawTexCoord2: { x: 0, y: 0 } }));
      for (const [index, slot] of slots.entries()) {
        const position = input.positions[index], cell = input.scratch[index];
        if (!Number.isInteger(slot) || slot < 0 || slot >= vertexCount || position === undefined || cell === undefined)
          throw new RangeError("Invalid source debug vertex slot");
        positions[slot] = position; scratch[slot] = cell;
      }
      const indices = input.indices.map(index => {
        const slot = slots[index];
        if (slot === undefined) throw new RangeError("Source debug index has no retained vertex slot");
        return slot;
      });
      input = { ...input, positions, scratch, indices };
    }
    if (input.indices.length % 3 !== 0 || input.indices.length > 0x7fffffff) throw new RangeError("GL debug triangle index count is invalid");
    if (input.positions.length > 0x1fffffff) throw new RangeError("GL debug vertex count exceeds packed storage limits");
    if (input.scratch.length !== input.positions.length) throw new RangeError("GL debug scratch must match its published vertex allocation");
    for (const index of input.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= input.positions.length || index > 0xffffffff) throw new RangeError("GL debug triangle index is out of range");
    }
    const whiteImage = input.whiteImage, positions = new Float32Array(input.positions.length * 4);
    const texCoords = new Float32Array(input.positions.length * 2), texCoords2 = new Float32Array(input.positions.length * 2);
    const rawTexCoords = new Float32Array(input.positions.length * 2), rawTexCoords2 = new Float32Array(input.positions.length * 2);
    const indices = new Uint32Array(input.indices), stripIndices = [...indices];
    const vertices = input.positions.map((position, index) => {
      const cell = input.scratch[index];
      if (cell === undefined) throw new RangeError("GL debug scratch cell is unallocated");
      positions.set([position.x, position.y, position.z, position.w], index * 4);
      texCoords.set([cell.texCoord.x, cell.texCoord.y], index * 2);
      texCoords2.set([cell.texCoord2.x, cell.texCoord2.y], index * 2);
      rawTexCoords.set([cell.rawTexCoord.x, cell.rawTexCoord.y], index * 2);
      rawTexCoords2.set([cell.rawTexCoord2.x, cell.rawTexCoord2.y], index * 2);
      return { position: { ...position }, color: { ...cell.color }, texCoord: { ...cell.texCoord }, texCoord2: { ...cell.texCoord2 } };
    });
    let phase: "prepared" | "begun" | "drawn" | "cleaned" = "prepared";
    return {
      begin: () => {
        if (phase !== "prepared") throw new Error("GL debug draw has already begun");
        this.opened(); const gl = this.gl;
        this.bind(whiteImage); gl.glColor3f(1, 1, 1);
        this.stateBits(SourceStateBit.POLYMODE_LINE | SourceStateBit.DEPTHMASK_TRUE);
        this.setDepthRange([0, 0]);
        gl.glDisableClientState(0x8076); gl.glDisableClientState(0x8078);
        if (this.currentUnit === 0) this.primaryClientArrayEnabled = false;
        else this.secondaryClientArrayEnabled = false;
        if (positions.length !== 0) {
          this.vertexClientArray = positions; gl.glVertexPointer(4, 0x1406, 0, this.vertexClientArray);
          this.refreshSourceCoordinates({ svars0: texCoords, svars1: texCoords2, raw0: rawTexCoords, raw1: rawTexCoords2 });
        }
        for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
        this.lockArrays(positions.length / 4);
        phase = "begun";
      },
      draw: (primitives: number) => {
        if (phase !== "begun") throw new Error("GL debug draw has not begun");
        this.opened(); const gl = this.gl, selected = sourcePrimitiveMode(primitives, this.compiledVertexArrays);
        if (indices.length !== 0 && selected !== "none") {
          const discrete = selected === "discrete-strips";
          // Validate reached attributes before submitting geometry; a rejected
          // later vertex must not leave the native context inside glBegin.
          for (const index of stripIndices) {
            const vertex = vertices[index];
            if (vertex === undefined) throw new RangeError("GL debug vertex is unallocated");
            const { position, color } = vertex;
            if (!finitePosition(position.x, position.y, position.z, position.w)) throw new RangeError("GL debug positions must be finite float32 values");
            if (discrete && ![color.x, color.y, color.z, color.w].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError("GL debug colors must be normalized bytes");
            if (discrete && ![vertex.texCoord.x, vertex.texCoord.y].every(finite32)) throw new RangeError("GL debug coordinates must be finite float32 values");
          }
          if (!discrete) this.validateCoordinateArrays(stripIndices);
          if (selected === "elements") gl.glDrawElements(4, indices.length, 0x1405, indices);
          else if (selected === "array-strips") this.emitTriangleStrips(stripIndices, index => { gl.glArrayElement(index); });
          else if (selected === "discrete-strips") {
            this.emitTriangleStrips(stripIndices, index => {
              const vertex = vertices[index];
              if (vertex === undefined) throw new RangeError("GL debug discrete vertex is unallocated");
              const { position, color, texCoord } = vertex;
              gl.glColor4ub(Math.round(color.x * 255), Math.round(color.y * 255), Math.round(color.z * 255), Math.round(color.w * 255));
              if (this.currentUnit !== 0) throw new Error("r_primitives 3 reaches undefined source MultiTexCoordARB targets 0 and 1");
              gl.glTexCoord2f(texCoord.x, texCoord.y);
              gl.glVertex4f(position.x, position.y, position.z, position.w);
            });
          }
        }
        phase = "drawn";
      },
      cleanup: () => {
        if (phase !== "drawn") throw new Error("GL debug draw has not completed");
        this.opened(); this.unlockArrays(); this.setDepthRange([0, 1]); phase = "cleaned";
      },
    };
  }
  /** tr_shade.c DrawNormals emits immediate lines independently of r_primitives. */
  drawDebugNormals(input: SourceDebugNormals): undefined {
    this.available(); this.registered(input.whiteImage);
    const segments = input.segments.map(segment => {
      if (segment.length !== 2) throw new RangeError("GL debug normals require endpoint pairs");
      return segment.map(position => {
        if (!finitePosition(position.x, position.y, position.z, position.w)) throw new RangeError("GL debug normals must be finite float32 values");
        return { ...position };
      });
    });
    this.opened(); const gl = this.gl;
    this.bind(input.whiteImage); gl.glColor3f(1, 1, 1); this.setDepthRange([0, 0]);
    this.stateBits(SourceStateBit.POLYMODE_LINE | SourceStateBit.DEPTHMASK_TRUE);
    for (const matrix of [0x1700, 0x1701]) { gl.glMatrixMode(matrix); gl.glLoadIdentity(); }
    gl.glBegin(1);
    for (const segment of segments) for (const position of segment) gl.glVertex4f(position.x, position.y, position.z, position.w);
    gl.glEnd(); this.setDepthRange([0, 1]);
  }
  prepareRawGeometry(geometry: RawGeometry): PreparedBackendRawDraw {
    this.available();
    const { x, y, width, height } = geometry.rect, { uploadWidth, uploadHeight, identityLight } = geometry;
    if (![x, y, width, height, x + width, y + height, identityLight].every(finite32)) throw new RangeError("GL raw geometry must be finite float32");
    if (![x, y, width, height].every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff)) throw new RangeError("GL raw rectangle must contain int32 values");
    this.uploadDimensions(uploadWidth, uploadHeight);
    const s0 = Math.fround(0.5 / uploadWidth), t0 = Math.fround(0.5 / uploadHeight);
    const s1 = Math.fround(Math.fround(uploadWidth - 0.5) / uploadWidth), t1 = Math.fround(Math.fround(uploadHeight - 0.5) / uploadHeight);
    let phase: "prepared" | "uploaded" | "drawn" = "prepared";
    return {
      uploadCurrent: (upload: CinematicUpload) => {
        if (phase !== "prepared") throw new Error("GL raw upload has already executed");
        if (upload.uploadWidth !== uploadWidth || upload.uploadHeight !== uploadHeight) throw new Error("GL raw upload dimensions changed after preparation");
        this.opened(); this.cinematic(upload); phase = "uploaded";
      },
      draw: () => {
        if (phase !== "uploaded") throw new Error("GL raw draw has no upload");
        this.opened(); const gl = this.gl;
        gl.glViewport(0, 0, this.width, this.height); gl.glScissor(0, 0, this.width, this.height);
        gl.glMatrixMode(0x1701); gl.glLoadIdentity(); gl.glOrtho(0, this.width, this.height, 0, 0, 1);
        gl.glMatrixMode(0x1700); gl.glLoadIdentity();
        this.stateBits(SourceStateBit.DEPTHTEST_DISABLE | SourceStateBit.SRCBLEND_SRC_ALPHA | SourceStateBit.DSTBLEND_ONE_MINUS_SRC_ALPHA);
        gl.glDisable(0xb44); gl.glDisable(0x3000); this.clipState.disable(); gl.glColor3f(identityLight, identityLight, identityLight);
        gl.glBegin(7);
        gl.glTexCoord2f(s0, t0); gl.glVertex2f(x, y);
        gl.glTexCoord2f(s1, t0); gl.glVertex2f(x + width, y);
        gl.glTexCoord2f(s1, t1); gl.glVertex2f(x + width, y + height);
        gl.glTexCoord2f(s0, t1); gl.glVertex2f(x, y + height);
        gl.glEnd(); phase = "drawn";
      },
    };
  }
  /** tr_backend.c RB_DrawBuffer retains masks, scissor and the resulting clear color. */
  selectDrawBuffer(buffer: RendererDrawBuffer, clear: boolean): undefined {
    this.opened(); const gl = this.gl;
    gl.glDrawBuffer(drawBuffers[buffer]);
    if (clear) {
      gl.glClearColor(1, 0, 0.5, 1);
      gl.glClear(0x4000 | 0x100);
    }
  }
  clearColorBuffer(): undefined { this.opened(); this.gl.glClear(0x4000); }
  /** tr_backend.c RB_ShowImages retains color, selected TMU and all material state. */
  drawShowImage(image: RendererImage, rect: Rect2D, proportional: boolean): undefined {
    this.available();
    const registered = this.registered(image), x = Math.fround(rect.x), y = Math.fround(rect.y);
    const width = proportional ? Math.fround(Math.fround(rect.width) * Math.fround(registered.uploadWidth / 512)) : Math.fround(rect.width);
    const height = proportional ? Math.fround(Math.fround(rect.height) * Math.fround(registered.uploadHeight / 512)) : Math.fround(rect.height);
    const right = Math.fround(x + width), bottom = Math.fround(y + height);
    if (![x, y, width, height, right, bottom].every(Number.isFinite)) throw new RangeError("GL image grid rectangle must be finite float32");
    this.opened(); const gl = this.gl;
    // Ordinary batches publish clip coordinates, while raw cinematics retain
    // pixel matrices. This immediate source quad always uses pixel coordinates.
    gl.glMatrixMode(0x1701); gl.glLoadIdentity(); gl.glOrtho(0, this.width, this.height, 0, 0, 1);
    gl.glMatrixMode(0x1700); gl.glLoadIdentity();
    this.bind(image);
    gl.glBegin(7);
    gl.glTexCoord2f(0, 0); gl.glVertex2f(x, y);
    gl.glTexCoord2f(1, 0); gl.glVertex2f(right, y);
    gl.glTexCoord2f(1, 1); gl.glVertex2f(right, bottom);
    gl.glTexCoord2f(0, 1); gl.glVertex2f(x, bottom);
    gl.glEnd();
  }
  finish(): undefined { this.opened(); this.gl.glFinish(); }
  /** R_Init reads one error after image, shader, skin, model and font initialization. */
  getError(): number { this.opened(); return this.gl.glGetError(); }
  /** tr_cmds.c RE_BeginFrame reads one error after R_SyncRenderThread. */
  checkFrameErrors(): undefined {
    this.opened();
    const error = this.gl.glGetError();
    if (error !== 0) throw new CommonError("fatal", `RE_BeginFrame() - glGetError() failed (0x${error.toString(16)})!\n`);
  }
  /** tr_cmds.c RE_BeginFrame, after R_SyncRenderThread. */
  setOverdrawMeasurement(enabled: boolean): undefined {
    this.opened(); const gl = this.gl;
    if (!enabled) { gl.glDisable(0xb90); return; }
    gl.glEnable(0xb90);
    gl.glStencilMask(0xffffffff);
    gl.glClearStencil(0);
    gl.glStencilFunc(0x207, 0, 0xffffffff);
    gl.glStencilOp(0x1e00, 0x1e02, 0x1e02);
  }

  readStencilOverdraw(destination: Uint8Array): undefined {
    this.opened(); const gl = this.gl, state = new Int32Array(1);
    const pack = (name: number): number => {
      gl.glGetIntegerv(name, state);
      const value = state[0];
      if (value === undefined || value < 0) throw new Error("GL returned invalid pixel-pack state");
      return value;
    };
    const alignment = pack(0xd05), rowLength = pack(0xd02), skipRows = pack(0xd03), skipPixels = pack(0xd04);
    if (alignment !== 1 && alignment !== 2 && alignment !== 4 && alignment !== 8) throw new Error("GL returned invalid pixel-pack alignment");
    const stride = Math.ceil((rowLength === 0 ? this.width : rowLength) / alignment) * alignment;
    const required = (skipRows + this.height - 1) * stride + skipPixels + this.width;
    if (!Number.isSafeInteger(required) || required > destination.length) throw new RangeError("GL stencil readback destination is too small for current pixel-pack state");
    gl.glReadPixels(0, 0, this.width, this.height, 0x1901, 0x1401, destination);
  }

  /** tr_flares.c RB_TestFlare reads one float at absolute bottom-left window coordinates. */
  readDepthPixel(windowX: number, windowY: number): number {
    this.opened();
    if (!Number.isInteger(windowX) || !Number.isInteger(windowY)
      || windowX < 0 || windowY < 0 || windowX >= this.width || windowY >= this.height)
      throw new RangeError("GL flare depth coordinates are outside the framebuffer");
    // Alignment and row length cannot pad a single row's only float. Skips or
    // a pixel-pack buffer would redirect this source four-byte destination.
    for (const name of [0xd03, 0xd04, 0x88ed]) {
      this.gl.glGetIntegerv(name, this.flarePackState);
      if (this.flarePackState[0] !== 0) throw new RangeError("GL flare depth pixel-pack state exceeds the source float destination");
    }
    this.gl.glReadPixels(windowX, windowY, 1, 1, 0x1902, 0x1406, this.flareDepth);
    const depth = this.flareDepth[0];
    if (depth === undefined) throw new Error("GL flare depth allocation is missing");
    return depth;
  }

  readPixels(): Uint8Array {
    this.opened(); const pixels = new Uint8Array(this.width * this.height * 4);
    this.gl.glReadPixels(0, 0, this.width, this.height, 0x1908, 0x1401, pixels);
    const topDown = new Uint8Array(pixels.length);
    for (let row = 0; row < this.height; row++) topDown.set(pixels.subarray(row * this.width * 4, (row + 1) * this.width * 4), (this.height - 1 - row) * this.width * 4);
    return topDown;
  }
  close(): undefined {
    if (this.closed) return;
    this.window.makeCurrent(); const gl = this.gl;
    this.unlockArrays();
    gl.glDisableClientState(0x8074); gl.glDisableClientState(0x8076);
    for (const image of this.textures.values()) gl.glDeleteTextures(1, image.object.handle);
    // R_DeleteTextures unbinds both units and returns both selectors to unit zero.
    // Object zero itself survives a renderer restart, including its parameters.
    for (const unit of [1, 0]) if (unit < this.capabilities.textureUnits) {
      gl.glActiveTexture(0x84c0 + unit); gl.glClientActiveTexture(0x84c0 + unit);
      gl.glBindTexture(0xde1, 0); gl.glDisableClientState(0x8078);
    }
    this.currentUnit = 0;
    this.vertexClientArray = null; this.colorClientArray = null; this.coordinateClientArrays[0] = null; this.coordinateClientArrays[1] = null;
    this.textures.clear(); this.compiledArrays?.close(); this.compiledArrays = null;
    this.library.close(); this.closed = true;
    activeContexts.delete(this.window);
  }
}
