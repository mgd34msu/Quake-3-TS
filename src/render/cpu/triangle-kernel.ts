/*
 * CPU implementation of the fixed-function state used by Quake III Arena
 * code/renderer/tr_backend.c GL_State/GL_Cull and tr_image.c R_CreateImage.
 * Debug polygons follow tr_main.c R_DebugPolygon/R_DebugGraphics.
 * Original renderer copyright (C) 1999-2005 Id Software, Inc.
 * Clipping and rasterization are new TypeScript algorithms.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Vec2, Vec4 } from "../../core/math.ts";
import type { BlendFactor, RenderState, TextureEnvironment, TextureSampling } from "../types.ts";
import type { ImageInternalFormat } from "../image-resource.ts";
import type { LineTextureDerivative } from "./lines.ts";

export interface Sample {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface RowSpan {
  min: number;
  max: number;
}

export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function byte(value: number): number {
  return Math.round(clamp(value) * 255);
}

export function colorWord(r: number, g: number, b: number, a: number): number {
  return LITTLE_ENDIAN ? byte(r) | (byte(g) << 8) | (byte(b) << 16) | (byte(a) << 24)
    : (byte(r) << 24) | (byte(g) << 16) | (byte(b) << 8) | byte(a);
}

function trimSpan(span: RowSpan, slope: number, row: number, constant: number, inclusive: boolean): void {
  if (span.min > span.max) return;
  if (slope === 0) {
    const value = row + constant;
    if (value < 0 || (value === 0 && !inclusive)) span.max = span.min - 1;
    return;
  }
  const crossing = -(row + constant) / slope - 0.5;
  // Algebra locates the crossing; the original edge expression corrects
  // rounding and lower-left equality at the boundary. The expression is
  // monotone across the row, so every pixel in the resulting span is covered.
  if (slope > 0) {
    let min = Math.max(span.min, Math.min(span.max + 1, Math.floor(crossing)));
    while (min > span.min) {
      const value = slope * (min - 0.5) + row + constant;
      if (!(value > 0 || (value === 0 && inclusive))) break;
      min--;
    }
    while (min <= span.max) {
      const value = slope * (min + 0.5) + row + constant;
      if (value > 0 || (value === 0 && inclusive)) break;
      min++;
    }
    span.min = min;
  } else {
    let max = Math.max(span.min - 1, Math.min(span.max, Math.ceil(crossing)));
    while (max < span.max) {
      const value = slope * (max + 1.5) + row + constant;
      if (!(value > 0 || (value === 0 && inclusive))) break;
      max++;
    }
    while (max >= span.min) {
      const value = slope * (max + 0.5) + row + constant;
      if (value > 0 || (value === 0 && inclusive)) break;
      max--;
    }
    span.max = max;
  }
}

function factor(kind: BlendFactor, source: number, destination: number, sourceAlpha: number,
  destinationAlpha: number, alphaChannel: boolean): number {
  switch (kind) {
    case "zero": return 0;
    case "one": return 1;
    case "src-color": return source;
    case "one-minus-src-color": return 1 - source;
    case "dst-color": return destination;
    case "one-minus-dst-color": return 1 - destination;
    case "src-alpha": return sourceAlpha;
    case "one-minus-src-alpha": return 1 - sourceAlpha;
    case "dst-alpha": return destinationAlpha;
    case "one-minus-dst-alpha": return 1 - destinationAlpha;
    case "src-alpha-saturate": return alphaChannel ? 1 : Math.min(sourceAlpha, 1 - destinationAlpha);
  }
}

export function blend(source: number, destination: number, sourceAlpha: number, destinationAlpha: number,
  state: Pick<RenderState, "blend">, alphaChannel: boolean): number {
  return byte(source * factor(state.blend.source, source, destination, sourceAlpha, destinationAlpha, alphaChannel)
    + destination * factor(state.blend.destination, source, destination, sourceAlpha, destinationAlpha, alphaChannel));
}

export function passesAlpha(alpha: number, test: RenderState["alphaTest"]): boolean {
  switch (test) {
    case "none": return true;
    case "gt0": return alpha > 0;
    case "lt128": return alpha < 0.5;
    case "ge128": return alpha >= 0.5;
  }
}

function wrapTexel(index: number, size: number): number {
  // UVs were reduced to [0,1), so bilinear neighbors are at most one texel outside.
  return index < 0 ? index + size : index >= size ? index - size : index;
}

function sampleLevel(texture: TextureStorage, border: Vec4, u: number, v: number,
  wrap: TextureSampling["wrap"], linear: boolean, output: Sample): void {
  const width = texture.width, height = texture.height, data = texture.data, maximum = texture.componentMaximum;
  u = wrap === "repeat" ? u - Math.floor(u) : clamp(u);
  v = wrap === "repeat" ? v - Math.floor(v) : clamp(v);
  if (!linear) {
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const offset = (y * width + x) * 4;
    output.r = data.getUint8(offset) / maximum;
    output.g = data.getUint8(offset + 1) / maximum;
    output.b = data.getUint8(offset + 2) / maximum;
    output.a = data.getUint8(offset + 3) / maximum;
    return;
  }
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (wrap === "repeat") {
    x0 = wrapTexel(x0, width); x1 = wrapTexel(x1, width);
    y0 = wrapTexel(y0, height); y1 = wrapTexel(y1, height);
  }
  const w00 = (1 - fx) * (1 - fy) / maximum;
  const w10 = fx * (1 - fy) / maximum;
  const w01 = (1 - fx) * fy / maximum;
  const w11 = fx * fy / maximum;
  const hasBorder = wrap === "clamp" && (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height);
  // Channel extraction consumes signed 32-bit words; avoid unsigned-number conversion.
  let c00: number, c10: number, c01: number, c11: number, borderWeight = 0;
  if (hasBorder) {
    // A negative offset denotes a GL_CLAMP border tap, not the nearest edge texel.
    const p00 = x0 < 0 || y0 < 0 ? -1 : (y0 * width + x0) * 4;
    const p10 = x1 >= width || y0 < 0 ? -1 : (y0 * width + x1) * 4;
    const p01 = x0 < 0 || y1 >= height ? -1 : (y1 * width + x0) * 4;
    const p11 = x1 >= width || y1 >= height ? -1 : (y1 * width + x1) * 4;
    c00 = p00 < 0 ? 0 : data.getInt32(p00);
    c10 = p10 < 0 ? 0 : data.getInt32(p10);
    c01 = p01 < 0 ? 0 : data.getInt32(p01);
    c11 = p11 < 0 ? 0 : data.getInt32(p11);
    borderWeight = ((p00 < 0 ? w00 : 0) + (p10 < 0 ? w10 : 0) + (p01 < 0 ? w01 : 0) + (p11 < 0 ? w11 : 0)) * maximum;
  } else {
    c00 = data.getInt32((y0 * width + x0) * 4);
    c10 = data.getInt32((y0 * width + x1) * 4);
    c01 = data.getInt32((y1 * width + x0) * 4);
    c11 = data.getInt32((y1 * width + x1) * 4);
  }
  output.r = (c00 >>> 24) * w00 + (c10 >>> 24) * w10 + (c01 >>> 24) * w01 + (c11 >>> 24) * w11;
  output.g = ((c00 >>> 16) & 255) * w00 + ((c10 >>> 16) & 255) * w10 + ((c01 >>> 16) & 255) * w01 + ((c11 >>> 16) & 255) * w11;
  output.b = ((c00 >>> 8) & 255) * w00 + ((c10 >>> 8) & 255) * w10 + ((c01 >>> 8) & 255) * w01 + ((c11 >>> 8) & 255) * w11;
  // RGB storage contributes no alpha to any texture environment.
  output.a = texture.hasAlpha ? (c00 & 255) * w00 + (c10 & 255) * w10 + (c01 & 255) * w01 + (c11 & 255) * w11 : 1;
  if (hasBorder) {
    output.r += Math.fround(border.x) * borderWeight;
    output.g += Math.fround(border.y) * borderWeight;
    output.b += Math.fround(border.z) * borderWeight;
    if (texture.hasAlpha) output.a += Math.fround(border.w) * borderWeight;
  }
}

// RGBA texture environments run before alpha testing, blending and framebuffer
// conversion. GL_ADD saturates RGB but modulates alpha, unlike additive blending.
export function textureColor(previous: number, texel: number, environment: TextureEnvironment): number {
  switch (environment) {
    case "modulate": return previous * texel;
    case "add": return clamp(previous + texel);
    case "replace": return texel;
  }
}

export interface UploadedTexture {
  readonly kind: "image";
  readonly internalFormat: ImageInternalFormat;
  readonly wrap: TextureSampling["wrap"];
  readonly minifyLinear: boolean;
  readonly magnifyLinear: boolean;
  readonly mipmapping: "none" | "nearest" | "linear";
  readonly magnificationLimit: number;
  readonly levels: readonly [TextureStorage, ...TextureStorage[]];
  readonly borderColor: Vec4;
}
interface ConstantTexture {
  readonly kind: "constant";
  readonly internalFormat: ImageInternalFormat;
  readonly sample: Readonly<Sample>;
}
export type BoundTexture = UploadedTexture | ConstantTexture | { readonly kind: "incomplete" };
export interface TextureStorage {
  /** Changes before retained texel writes, including an interrupted update. */
  revision: object;
  /** Overrides and their later dirty updates require serial sampling. */
  canonical: boolean;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly data: DataView;
  readonly internalFormat: ImageInternalFormat;
  readonly hasAlpha: boolean;
  readonly componentMaximum: 15 | 31 | 255;
  uniform: Readonly<Sample> | null;
}
export function textureHasAlpha(internalFormat: ImageInternalFormat): boolean {
  return internalFormat === "rgba" || internalFormat === "rgba4" || internalFormat === "rgba8";
}

export function sampleBound(texture: UploadedTexture | ConstantTexture, u: number, v: number, rho: number, output: Sample): void {
  sampleBoundComponents(texture, u, v, rho, output, 0, 0, 0, 0);
}

function sampleBoundComponents(texture: UploadedTexture | ConstantTexture, u: number, v: number, rho: number | null,
  output: Sample, xU: number, xV: number, yU: number, yV: number): void {
  if (texture.kind === "constant") {
    output.r = texture.sample.r; output.g = texture.sample.g; output.b = texture.sample.b; output.a = texture.sample.a;
    return;
  }
  const { levels, wrap, borderColor, minifyLinear, magnifyLinear, mipmapping, magnificationLimit } = texture;
  let estimated = false;
  if (rho === null) {
    const estimate = mipmapping === "nearest" ? nearestRhoEstimate(xU, xV, yU, yV) : 0;
    if (estimate > 0 && (estimate * (1 + NEAREST_MIP_GUARD) <= magnificationLimit
      || estimate * (1 - NEAREST_MIP_GUARD) > magnificationLimit)) {
      rho = estimate;
      estimated = true;
    } else rho = Math.max(derivativeLength(xU, xV), derivativeLength(yU, yV));
  }
  // OpenGL 2.1 equations 3.18, 3.27-3.29. This CPU profile uses ideal rho;
  // drivers may approximate it, so LOD is deterministic rather than driver exact.
  if (rho <= magnificationLimit) {
    sampleLevel(levels[0], borderColor, u, v, wrap, magnifyLinear, output);
    return;
  }
  if (mipmapping === "none") {
    sampleLevel(levels[0], borderColor, u, v, wrap, minifyLinear, output);
    return;
  }
  const lastLevel = levels.length - 1;
  let lambda = Math.min(lastLevel, Math.log2(rho));
  if (estimated) {
    const shifted = lambda + 0.5, fraction = shifted - Math.floor(shifted);
    if (!Number.isInteger(lastLevel) || lastLevel < 0
      || !(fraction > NEAREST_MIP_GUARD && 1 - fraction > NEAREST_MIP_GUARD)) {
      rho = Math.max(derivativeLength(xU, xV), derivativeLength(yU, yV));
      lambda = Math.min(lastLevel, Math.log2(rho));
    }
  }
  const betweenLevels = mipmapping === "linear";
  const selected = betweenLevels ? Math.floor(lambda) : Math.max(0, Math.ceil(lambda + 0.5) - 1);
  const first = levels[selected];
  if (first === undefined) throw new RangeError("Texture LOD is outside its complete mip chain");
  sampleLevel(first, borderColor, u, v, wrap, minifyLinear, output);
  const fraction = lambda - selected;
  if (!betweenLevels || fraction === 0) return;
  const second = levels[selected + 1];
  if (second === undefined) throw new RangeError("Texture LOD blend is outside its complete mip chain");
  const { r, g, b, a } = output;
  sampleLevel(second, borderColor, u, v, wrap, minifyLinear, output);
  output.r = r * (1 - fraction) + output.r * fraction;
  output.g = g * (1 - fraction) + output.g * fraction;
  output.b = b * (1 - fraction) + output.b * fraction;
  output.a = a * (1 - fraction) + output.a * fraction;
}

export interface TexturePlaneDerivative {
  readonly uAnchor: number; readonly vAnchor: number;
  readonly uDx: number; readonly vDx: number; readonly qDx: number;
  readonly uDy: number; readonly vDy: number; readonly qDy: number;
}

function derivativeLength(x: number, y: number): number {
  if (x === 0) return Math.abs(y);
  if (y === 0) return Math.abs(x);
  return Math.hypot(x, y);
}

function samplePerspectiveBound(texture: UploadedTexture | ConstantTexture, u: number, v: number, reciprocal: number,
  derivative: TexturePlaneDerivative, output: Sample): void {
  let rho: number | null = 0;
  let xU = 0, xV = 0, yU = 0, yV = 0;
  if (texture.kind === "image") {
    if (texture.mipmapping === "none") {
      sampleLevel(texture.levels[0], texture.borderColor, derivative.uAnchor + u, derivative.vAnchor + v,
        texture.wrap, texture.magnifyLinear, output);
      return;
    }
    const { width, height } = texture.levels[0];
    // u/v are the quotient relative to a per-unit anchor. The common offset
    // contributes no derivative and never enters this cancellation-prone sum.
    xU = (derivative.uDx - u * derivative.qDx) * reciprocal * width;
    xV = (derivative.vDx - v * derivative.qDx) * reciprocal * height;
    yU = (derivative.uDy - u * derivative.qDy) * reciprocal * width;
    yV = (derivative.vDy - v * derivative.qDy) * reciprocal * height;
    rho = null;
  }
  sampleBoundComponents(texture, derivative.uAnchor + u, derivative.vAnchor + v, rho, output, xU, xV, yU, yV);
}

const NEAREST_MIP_GUARD = 2 ** -32;
const MIN_NEAREST_COMPONENT = 2 ** -200;
const MAX_NEAREST_COMPONENT = 2 ** 200;

function nearestRhoEstimate(xU: number, xV: number, yU: number, yV: number): number {
  const axU = Math.abs(xU), axV = Math.abs(xV), ayU = Math.abs(yU), ayV = Math.abs(yV);
  if ((axU === 0 || axU >= MIN_NEAREST_COMPONENT && axU <= MAX_NEAREST_COMPONENT)
    && (axV === 0 || axV >= MIN_NEAREST_COMPONENT && axV <= MAX_NEAREST_COMPONENT)
    && (ayU === 0 || ayU >= MIN_NEAREST_COMPONENT && ayU <= MAX_NEAREST_COMPONENT)
    && (ayV === 0 || ayV >= MIN_NEAREST_COMPONENT && ayV <= MAX_NEAREST_COMPONENT)) {
    return Math.sqrt(Math.max(xU * xU + xV * xV, yU * yU + yV * yV));
  }
  return 0;
}

interface NearestMipCursor {
  readonly texture: UploadedTexture;
  selected: number;
  lowerSquared: number;
  upperSquared: number;
}

function sampleWorkerNearest(cursor: NearestMipCursor, u: number, v: number, reciprocal: number,
  derivative: TexturePlaneDerivative, output: Sample): void {
  const texture = cursor.texture;
  const { levels, wrap, borderColor, minifyLinear, magnifyLinear, magnificationLimit } = texture;
  const { width, height } = levels[0];
  const xU = (derivative.uDx - u * derivative.qDx) * reciprocal * width;
  const xV = (derivative.vDx - v * derivative.qDx) * reciprocal * height;
  const yU = (derivative.uDy - u * derivative.qDy) * reciprocal * width;
  const yV = (derivative.vDy - v * derivative.qDy) * reciprocal * height;
  const axU = Math.abs(xU), axV = Math.abs(xV), ayU = Math.abs(yU), ayV = Math.abs(yV);
  if ((axU === 0 || axU >= MIN_NEAREST_COMPONENT && axU <= MAX_NEAREST_COMPONENT)
    && (axV === 0 || axV >= MIN_NEAREST_COMPONENT && axV <= MAX_NEAREST_COMPONENT)
    && (ayU === 0 || ayU >= MIN_NEAREST_COMPONENT && ayU <= MAX_NEAREST_COMPONENT)
    && (ayV === 0 || ayV >= MIN_NEAREST_COMPONENT && ayV <= MAX_NEAREST_COMPONENT)) {
    const square = Math.max(xU * xU + xV * xV, yU * yU + yV * yV);
    if (square > cursor.lowerSquared && square < cursor.upperSquared) {
      const first = levels[cursor.selected];
      if (first === undefined) throw new RangeError("Texture LOD is outside its complete mip chain");
      sampleLevel(first, borderColor, derivative.uAnchor + u, derivative.vAnchor + v, wrap, minifyLinear, output);
      return;
    }
    const estimate = Math.sqrt(square);
    if (estimate > 0) {
      // Reviewed Bun/Linux math bounds enclose the original hypot result here.
      const lower = estimate * (1 - NEAREST_MIP_GUARD), upper = estimate * (1 + NEAREST_MIP_GUARD);
      if (upper <= magnificationLimit) {
        sampleLevel(levels[0], borderColor, derivative.uAnchor + u, derivative.vAnchor + v, wrap, magnifyLinear, output);
        return;
      }
      if (lower > magnificationLimit) {
        const shifted = Math.min(levels.length - 1, Math.log2(estimate)) + 0.5;
        const fraction = shifted - Math.floor(shifted);
        if (fraction > NEAREST_MIP_GUARD && 1 - fraction > NEAREST_MIP_GUARD) {
          const selected = Math.max(0, Math.ceil(shifted) - 1);
          const first = levels[selected];
          if (first === undefined) throw new RangeError("Texture LOD is outside its complete mip chain");
          cursor.selected = selected;
          if (selected >= 0 && selected <= 30 && (magnificationLimit === 1 || magnificationLimit === Math.SQRT2)) {
            const boundary = Math.SQRT2 * (1 << selected);
            const lowerBin = Math.max(magnificationLimit, selected === 0 ? 0 : (boundary * 0.5) * (1 + 2 * NEAREST_MIP_GUARD));
            const upperBin = selected === levels.length - 1 ? Infinity : boundary * (1 - 2 * NEAREST_MIP_GUARD);
            cursor.lowerSquared = (lowerBin * lowerBin) * (1 + 4 * NEAREST_MIP_GUARD);
            cursor.upperSquared = upperBin === Infinity ? Infinity : (upperBin * upperBin) * (1 - 4 * NEAREST_MIP_GUARD);
          } else {
            cursor.lowerSquared = Infinity;
            cursor.upperSquared = -Infinity;
          }
          sampleLevel(first, borderColor, derivative.uAnchor + u, derivative.vAnchor + v, wrap, minifyLinear, output);
          return;
        }
      }
    }
  }
  const rho = Math.max(derivativeLength(xU, xV), derivativeLength(yU, yV));
  sampleBound(texture, derivative.uAnchor + u, derivative.vAnchor + v, rho, output);
}

export function sampleLineBound(texture: UploadedTexture | ConstantTexture, coordinate: Vec2, derivative: LineTextureDerivative, output: Sample): void {
  const rho = texture.kind === "image" && texture.mipmapping !== "none"
    ? Math.hypot(derivative.dsPerPixel * texture.levels[0].width, derivative.dtPerPixel * texture.levels[0].height) : 0;
  sampleBound(texture, coordinate.x, coordinate.y, rho, output);
}

export interface Framebuffer {
  /** Original framebuffer dimensions, independent of packed region storage. */
  readonly width: number; readonly height: number;
  readonly pixels: Uint8Array;
  readonly colorWords: Int32Array;
  readonly depth: Float64Array;
  readonly stencil: Uint32Array | null;
  /** Absolute origin of storage; stride is measured in pixels. */
  readonly originX: number; readonly originY: number; readonly stride: number;
}

export interface TriangleSetup {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly inverseArea: number;
  readonly depthNear: number;
  readonly depthFar: number;
  readonly edgeAX: number;
  readonly edgeAY: number;
  readonly edgeAC: number;
  readonly edgeBX: number;
  readonly edgeBY: number;
  readonly edgeBC: number;
  readonly edgeCX: number;
  readonly edgeCY: number;
  readonly edgeCC: number;
  readonly attributeAX: number;
  readonly attributeAY: number;
  readonly attributeAC: number;
  readonly attributeBX: number;
  readonly attributeBY: number;
  readonly attributeBC: number;
  readonly attributeCX: number;
  readonly attributeCY: number;
  readonly attributeCC: number;
  readonly az: number;
  readonly bz: number;
  readonly cz: number;
  readonly polygonDepthOffset: number;
  readonly planeDepth: number;
  readonly aiw: number;
  readonly biw: number;
  readonly ciw: number;
  readonly au: number;
  readonly bu: number;
  readonly cu: number;
  readonly av: number;
  readonly bv: number;
  readonly cv: number;
  readonly au2: number;
  readonly bu2: number;
  readonly cu2: number;
  readonly av2: number;
  readonly bv2: number;
  readonly cv2: number;
  readonly ar: number;
  readonly br: number;
  readonly cr: number;
  readonly ag: number;
  readonly bg: number;
  readonly cg: number;
  readonly ab: number;
  readonly bb: number;
  readonly cb: number;
  readonly aa: number;
  readonly ba: number;
  readonly ca: number;
  readonly edgeAInclusive: boolean;
  readonly edgeBInclusive: boolean;
  readonly edgeCInclusive: boolean;
  readonly white: boolean;
  readonly depthWrite: boolean;
  readonly stencilEnabled: boolean;
  readonly colorWrite: boolean;
  readonly textureConsumed: boolean;
  readonly primaryAlpha: boolean;
  readonly secondaryAlpha: boolean;
  readonly constantDepth: boolean;
  readonly width: number; readonly height: number;
  readonly state: Pick<RenderState, "blend">;
  readonly alphaBits: 0 | 8;
  readonly blending: "opaque" | "alpha" | "add" | "multiply" | "dst-color-inverse-dst-alpha" | "general";
  readonly depthTest: RenderState["depthTest"];
  readonly alphaTest: RenderState["alphaTest"];
  readonly secondaryEnvironment: TextureEnvironment | null;
  readonly texture: BoundTexture; readonly secondaryTexture: BoundTexture;
  readonly derivative: TexturePlaneDerivative; readonly secondaryDerivative: TexturePlaneDerivative;
  readonly stencilFunction: "always" | "nonzero";
  readonly stencilCompareMask: number; readonly stencilWriteMask: number; readonly stencilMaximum: number;
  readonly stencilDepthFail: "keep" | "increment" | "decrement";
  readonly stencilDepthPass: "keep" | "increment" | "decrement";
}

/** Limits restrict iteration only; coverage and interpolation retain absolute coordinates. */
export function runTriangleRows(setup: TriangleSetup, framebuffer: Framebuffer, sampled: Sample,
  firstY = setup.minY, lastY = setup.maxY): boolean {
  return runTriangleRowsInternal(setup, framebuffer, sampled, firstY, lastY, "public");
}

/** The fixed worker calls this only after decoding its native-cloned job. */
export function runWorkerTriangleRows(setup: TriangleSetup, framebuffer: Framebuffer, sampled: Sample,
  firstY: number, lastY: number): boolean {
  return runTriangleRowsInternal(setup, framebuffer, sampled, firstY, lastY, "decoded-worker");
}

function runTriangleRowsInternal(setup: TriangleSetup, framebuffer: Framebuffer, sampled: Sample,
  firstY: number, lastY: number, mode: "public" | "decoded-worker"): boolean {
  const {
    minX, maxX, minY, maxY, inverseArea, depthNear, depthFar, edgeAX,
    edgeAY, edgeAC, edgeBX, edgeBY, edgeBC, edgeCX, edgeCY, edgeCC,
    attributeAX, attributeAY, attributeAC, attributeBX, attributeBY, attributeBC, attributeCX, attributeCY,
    attributeCC, az, bz, cz, polygonDepthOffset, planeDepth, aiw, biw,
    ciw, au, bu, cu, av, bv, cv, au2,
    bu2, cu2, av2, bv2, cv2, ar, br, cr,
    ag, bg, cg, ab, bb, cb, aa, ba,
    ca, edgeAInclusive, edgeBInclusive, edgeCInclusive, white, depthWrite, stencilEnabled, colorWrite,
    textureConsumed, primaryAlpha, secondaryAlpha, constantDepth, blending, depthTest, alphaTest, secondaryEnvironment,
    texture, secondaryTexture, derivative, secondaryDerivative, stencilFunction, stencilCompareMask, stencilWriteMask, stencilMaximum,
    stencilDepthFail, stencilDepthPass, state, alphaBits,
  } = setup;
  const depths = framebuffer.depth, colors = framebuffer.colorWords;
  const span: RowSpan = { min: minX, max: maxX };
  const primaryCursor: NearestMipCursor | null = textureConsumed && mode === "decoded-worker" && texture.kind === "image" && texture.mipmapping === "nearest"
    ? { texture, selected: 0, lowerSquared: Infinity, upperSquared: -Infinity } : null;
  const secondaryCursor: NearestMipCursor | null = textureConsumed && secondaryEnvironment !== null && mode === "decoded-worker"
    && secondaryTexture.kind === "image" && secondaryTexture.mipmapping === "nearest"
    ? { texture: secondaryTexture, selected: 0, lowerSquared: Infinity, upperSquared: -Infinity } : null;
  let didSample = false;
  for (let y = Math.max(minY, firstY); y <= Math.min(maxY, lastY); y++) {
    const sampleY = y + 0.5, rowA = edgeAY * sampleY, rowB = edgeBY * sampleY, rowC = edgeCY * sampleY;
    const attributeRowA = attributeAY * sampleY, attributeRowB = attributeBY * sampleY, attributeRowC = attributeCY * sampleY;
    const rowOffset = (y - framebuffer.originY) * framebuffer.stride - framebuffer.originX;
    span.min = minX;
    span.max = maxX;
    trimSpan(span, edgeAX, rowA, edgeAC, edgeAInclusive);
    trimSpan(span, edgeBX, rowB, edgeBC, edgeBInclusive);
    trimSpan(span, edgeCX, rowC, edgeCC, edgeCInclusive);
    for (let x = span.min; x <= span.max; x++) {
      const sampleX = x + 0.5;
      const wa = (attributeAX * sampleX + attributeRowA + attributeAC) * inverseArea;
      const wb = (attributeBX * sampleX + attributeRowB + attributeBC) * inverseArea;
      const wc = (attributeCX * sampleX + attributeRowC + attributeCC) * inverseArea;
      const depth = constantDepth ? planeDepth : clamp(clamp((az * wa + bz * wb + cz * wc) * 0.5 + 0.5) * (depthFar - depthNear) + depthNear + polygonDepthOffset);
      const pixel = rowOffset + x;
      const oldDepth = depths[pixel];
      if (oldDepth === undefined) throw new RangeError("Fragment is outside the depth buffer");
      const depthPassed = !((depthTest === "less-equal" && depth > oldDepth) || (depthTest === "equal" && depth !== oldDepth));
      if (!depthPassed && !stencilEnabled) continue;
      const inverseW = aiw * wa + biw * wb + ciw * wc;
      const reciprocal = 1 / inverseW;
      let r: number;
      let g: number;
      let blue: number;
      let alpha: number;
      if (white) {
        r = g = blue = alpha = clamp(inverseW * reciprocal);
      } else {
        r = clamp((ar * wa + br * wb + cr * wc) * reciprocal);
        g = clamp((ag * wa + bg * wb + cg * wc) * reciprocal);
        blue = clamp((ab * wa + bb * wb + cb * wc) * reciprocal);
        alpha = clamp((aa * wa + ba * wb + ca * wc) * reciprocal);
      }
      if (textureConsumed && texture.kind !== "incomplete") {
        const u = (au * wa + bu * wb + cu * wc) * reciprocal;
        const v = (av * wa + bv * wb + cv * wc) * reciprocal;
        if (primaryCursor !== null) sampleWorkerNearest(primaryCursor, u, v, reciprocal, derivative, sampled);
        else samplePerspectiveBound(texture, u, v, reciprocal, derivative, sampled);
        didSample = true;
        r *= sampled.r;
        g *= sampled.g;
        blue *= sampled.b;
        if (primaryAlpha) alpha *= sampled.a;
      }
      if (textureConsumed && secondaryEnvironment !== null && secondaryTexture.kind !== "incomplete") {
        const u = (au2 * wa + bu2 * wb + cu2 * wc) * reciprocal;
        const v = (av2 * wa + bv2 * wb + cv2 * wc) * reciprocal;
        if (secondaryCursor !== null) sampleWorkerNearest(secondaryCursor, u, v, reciprocal, secondaryDerivative, sampled);
        else samplePerspectiveBound(secondaryTexture, u, v, reciprocal, secondaryDerivative, sampled);
        didSample = true;
        switch (secondaryEnvironment) {
          case "modulate":
            r *= sampled.r; g *= sampled.g; blue *= sampled.b;
            if (secondaryAlpha) alpha *= sampled.a;
            break;
          case "add":
            r = clamp(r + sampled.r); g = clamp(g + sampled.g); blue = clamp(blue + sampled.b);
            if (secondaryAlpha) alpha *= sampled.a;
            break;
          case "replace":
            r = sampled.r; g = sampled.g; blue = sampled.b;
            if (secondaryAlpha) alpha = sampled.a;
            break;
        }
      }
      if (alphaTest !== "none" && !passesAlpha(alpha, alphaTest)) continue;
      if (stencilEnabled && !stencilFragment(framebuffer.stencil, pixel, depthPassed, stencilFunction, stencilCompareMask, stencilWriteMask, stencilMaximum, stencilDepthFail, stencilDepthPass)) continue;
      if (!colorWrite) continue;
      if (blending === "opaque") colors[pixel] = colorWord(r, g, blue, alphaBits === 0 ? 1 : alpha);
      else writeFragment(framebuffer, alphaBits, pixel, r, g, blue, alpha, state, blending);
      if (depthWrite) depths[pixel] = depth;
    }
  }
  return didSample;
}

function writeFragment(framebuffer: Framebuffer, alphaBits: 0 | 8, pixel: number, r: number, g: number, blue: number, alpha: number,
  state: Pick<RenderState, "blend">, mode: "alpha" | "add" | "multiply" | "dst-color-inverse-dst-alpha" | "general"): void {
  const colors = framebuffer.colorWords;
  const destination = colors[pixel];
  if (destination === undefined) throw new RangeError("Fragment is outside the color buffer");
  const dr = (LITTLE_ENDIAN ? destination & 255 : destination >>> 24) / 255;
  const dg = ((destination >>> (LITTLE_ENDIAN ? 8 : 16)) & 255) / 255;
  const db = ((destination >>> (LITTLE_ENDIAN ? 16 : 8)) & 255) / 255;
  const da = alphaBits === 0 ? 1 : (LITTLE_ENDIAN ? destination >>> 24 : destination & 255) / 255;
  if (mode === "alpha") {
    const inverseAlpha = 1 - alpha;
    colors[pixel] = colorWord(r * alpha + dr * inverseAlpha, g * alpha + dg * inverseAlpha,
      blue * alpha + db * inverseAlpha, alphaBits === 0 ? 1 : alpha * alpha + da * inverseAlpha);
  } else if (mode === "add") {
    colors[pixel] = colorWord(r + dr, g + dg, blue + db, alphaBits === 0 ? 1 : alpha + da);
  } else if (mode === "multiply") {
    colors[pixel] = colorWord(r * dr, g * dg, blue * db, alphaBits === 0 ? 1 : alpha * da);
  } else if (mode === "dst-color-inverse-dst-alpha") {
    const inverseDestinationAlpha = 1 - da;
    colors[pixel] = colorWord(r * dr + dr * inverseDestinationAlpha, g * dg + dg * inverseDestinationAlpha,
      blue * db + db * inverseDestinationAlpha, alphaBits === 0 ? 1 : alpha * da + da * inverseDestinationAlpha);
  } else {
    const pixels = framebuffer.pixels, offset = pixel * 4;
    pixels[offset] = blend(r, dr, alpha, da, state, false);
    pixels[offset + 1] = blend(g, dg, alpha, da, state, false);
    pixels[offset + 2] = blend(blue, db, alpha, da, state, false);
    pixels[offset + 3] = alphaBits === 0 ? 255 : blend(alpha, da, alpha, da, state, true);
  }
}

export function stencilFragment(stencil: Uint32Array | null, index: number, depthPassed: boolean,
  stencilFunction: "always" | "nonzero", stencilCompareMask: number, stencilWriteMask: number, stencilMaximum: number,
  stencilDepthFail: "keep" | "increment" | "decrement", stencilDepthPass: "keep" | "increment" | "decrement"): boolean {
  if (stencil === null) throw new Error("Stencil test has no configured storage");
  const previous = stencil[index];
  if (previous === undefined) throw new RangeError("Fragment is outside the stencil buffer");
  if (stencilFunction === "nonzero" && (previous & stencilCompareMask) === 0) return false;
  const operation = depthPassed ? stencilDepthPass : stencilDepthFail;
  const next = operation === "increment" ? Math.min(stencilMaximum, previous + 1)
    : operation === "decrement" ? Math.max(0, previous - 1) : previous;
  stencil[index] = ((previous & ~stencilWriteMask) | (next & stencilWriteMask)) >>> 0;
  return depthPassed;
}
