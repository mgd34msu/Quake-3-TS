// Upload32, ResampleTexture, R_MipMap[2], R_LightScaleTexture and R_SetColorMappings,
// id Software, code/renderer/tr_image.c. SPDX-License-Identifier: GPL-2.0-or-later
import type { ImageInternalFormat, ImageLevel, ImageUpload } from "./image-resource.ts";
import type { SourceImageRequest } from "./material.ts";
import type { TextureImage } from "./types.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";

export interface PreparedImageUpload extends ImageUpload {
  /** Upload32's normal tail, after GL_CheckErrors. Aborts retain its temporary blocks. */
  finishUpload(): undefined;
}

export type ImageUploadStep =
  | { readonly kind: "upload-level"; readonly index: number; readonly level: ImageLevel; readonly internalFormat: ImageInternalFormat }
  | { readonly kind: "set-upload-descriptor"; readonly width: number; readonly height: number; readonly internalFormat: ImageInternalFormat }
  | { readonly kind: "finish-upload" };

export type ImageUploadSteps = Generator<ImageUploadStep, undefined, undefined>;

export interface ImageColorMappings {
  readonly deviceSupportsGamma: boolean;
  readonly overbrightBits: 0 | 1 | 2;
  readonly identityLight: number;
  readonly identityLightByte: number;
  readonly gammaTable: readonly number[];
  readonly intensityTable: readonly number[];
}
export interface ColorMappingInputs {
  readonly gamma: number;
  readonly intensity: number;
  readonly requestedOverbrightBits: number;
  readonly deviceSupportsGamma: boolean;
  readonly isFullscreen: boolean;
  readonly colorBits: number;
}
export type ImageColorLighting = Pick<ImageColorMappings, "deviceSupportsGamma" | "overbrightBits" | "identityLight" | "identityLightByte">;
export interface ImageUploadProfile {
  readonly picmip: number;
  readonly roundImagesDown: boolean;
  readonly simpleMipMaps: boolean;
  readonly colorMipLevels: boolean;
  readonly textureBits: number;
  readonly textureCompression: "none" | "s3tc";
  readonly maxTextureSize: number | null;
  readonly colorMappings: ImageColorMappings;
}

function sourceInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`${label}: undefined source int32 domain`);
  }
  return value;
}

/** R_SetColorMappings publishes these scalars before either cvar clamp can print. */
export function imageColorLighting(input: Pick<ColorMappingInputs, "requestedOverbrightBits" | "deviceSupportsGamma" | "isFullscreen" | "colorBits">): ImageColorLighting {
  sourceInteger(input.requestedOverbrightBits, "Overbright bits");
  sourceInteger(input.colorBits, "Framebuffer color bits");
  const requested = input.deviceSupportsGamma && input.isFullscreen ? input.requestedOverbrightBits : 0;
  const overbrightBits = requested <= 0 ? 0 : requested >= 2 && input.colorBits > 16 ? 2 : 1;
  const identityLight = 1 / (1 << overbrightBits);
  return { deviceSupportsGamma: input.deviceSupportsGamma, overbrightBits,
    identityLight, identityLightByte: Math.trunc(255 * identityLight) };
}

export function createImageColorMappings(input: ColorMappingInputs): ImageColorMappings {
  const gamma = Math.fround(input.gamma), intensity = Math.fround(input.intensity);
  if (!Number.isFinite(gamma) || gamma < 0.5 || gamma > 3 || !Number.isFinite(intensity) || intensity < 1) {
    throw new RangeError("Color mappings require source-clamped gamma and intensity");
  }
  const lighting = imageColorLighting(input), { overbrightBits } = lighting;
  const gammaTable: number[] = [], intensityTable: number[] = [];
  for (let i = 0; i < 256; i++) {
    const corrected = gamma === 1 ? i : Math.trunc(255 * Math.pow(Math.fround(i / 255), Math.fround(1 / gamma)) + 0.5);
    gammaTable.push(Math.min(255, corrected << overbrightBits));
    const scaled = sourceInteger(Math.trunc(Math.fround(i * intensity)), "Intensity conversion");
    intensityTable.push(Math.min(255, scaled));
  }
  return Object.freeze({ ...lighting,
    gammaTable: Object.freeze(gammaTable), intensityTable: Object.freeze(intensityTable) });
}

function byteCount(width: number, height: number): number {
  sourceInteger(width, "Image width"); sourceInteger(height, "Image height");
  if (width <= 0 || height <= 0) throw new RangeError("Image dimensions must be positive");
  return sourceInteger(width * height * 4, "Image allocation");
}

function powerOfTwo(value: number, roundDown: boolean): number {
  let result = 1;
  while (result < value) result = sourceInteger(result * 2, "Image power-of-two rounding");
  return roundDown && result > value ? result >> 1 : result;
}

function resample(input: ImageLevel, width: number, height: number, pixels: Uint8Array): ImageLevel {
  if (width > 2048) throw new RangeError("ResampleTexture: max width (source ERR_DROP)");
  const bytes = new DataView(input.pixels.buffer, input.pixels.byteOffset, input.pixels.byteLength);
  const step = Math.trunc(sourceInteger(input.width * 0x10000, "ResampleTexture horizontal step") / width) >>> 0;
  const p1: number[] = [], p2: number[] = [];
  let frac = step >>> 2;
  for (let x = 0; x < width; x++, frac = (frac + step) >>> 0) p1.push(4 * (frac >>> 16));
  frac = 3 * (step >>> 2);
  for (let x = 0; x < width; x++, frac = (frac + step) >>> 0) p2.push(4 * (frac >>> 16));
  for (let y = 0; y < height; y++) {
    const row1 = input.width * Math.trunc((y + 0.25) * input.height / height) * 4;
    const row2 = input.width * Math.trunc((y + 0.75) * input.height / height) * 4;
    for (let x = 0; x < width; x++) {
      const a = p1[x], b = p2[x];
      if (a === undefined || b === undefined) throw new RangeError("Missing resample column");
      for (let c = 0; c < 4; c++) pixels[(y * width + x) * 4 + c] =
        (bytes.getUint8(row1 + a + c) + bytes.getUint8(row1 + b + c)
          + bytes.getUint8(row2 + a + c) + bytes.getUint8(row2 + b + c)) >> 2;
    }
  }
  return { width, height, pixels };
}

function mip(input: ImageLevel, simple: boolean, memory: HunkAccountingProfile, name: string): ImageLevel {
  const width = Math.max(1, input.width >> 1), height = Math.max(1, input.height >> 1);
  const temporaryBytes = (input.width >> 1) * (input.height >> 1) * 4;
  const temporary = !simple && memory.kind === "source-hunk"
    ? memory.accounting.allocateTemp("R_MipMap2", name, temporaryBytes) : null;
  // R_MipMap2 has zero temporary pixels on either one-dimensional tail.
  if (!simple && (input.width === 1 || input.height === 1)) {
    if (temporary !== null && memory.kind === "source-hunk") memory.accounting.freeTemp("R_MipMap2", name, temporary);
    return { width, height, pixels: input.pixels.subarray(0, width * height * 4) };
  }
  const pixels = simple ? input.pixels.subarray(0, width * height * 4)
    : temporary === null ? new Uint8Array(temporaryBytes) : temporary.bytes;
  const bytes = new DataView(input.pixels.buffer, input.pixels.byteOffset, input.pixels.byteLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    let value = 0;
    if (simple) {
      const offset = (y * 2 * input.width + x * 2) * 4 + c;
      value = input.width === 1 || input.height === 1
        ? (bytes.getUint8((y * width + x) * 8 + c) + bytes.getUint8((y * width + x) * 8 + 4 + c)) >> 1
        : (bytes.getUint8(offset) + bytes.getUint8(offset + 4)
          + bytes.getUint8(offset + input.width * 4) + bytes.getUint8(offset + input.width * 4 + 4)) >> 2;
    } else {
      for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
        const weight = (dy === -1 || dy === 2 ? 1 : 2) * (dx === -1 || dx === 2 ? 1 : 2);
        const offset = (((y * 2 + dy) & (input.height - 1)) * input.width + ((x * 2 + dx) & (input.width - 1))) * 4 + c;
        value += weight * bytes.getUint8(offset);
      }
      value = Math.trunc(value / 36);
    }
    pixels[(y * width + x) * 4 + c] = value;
  }
  if (!simple) {
    input.pixels.set(pixels);
    if (temporary !== null && memory.kind === "source-hunk") memory.accounting.freeTemp("R_MipMap2", name, temporary);
  }
  return { width, height, pixels: input.pixels.subarray(0, width * height * 4) };
}

function lightScale(level: ImageLevel, mipmap: boolean, mappings: ImageColorMappings): void {
  for (let i = 0; i < level.pixels.length; i += 4) for (let c = 0; c < 3; c++) {
    let value = level.pixels[i + c];
    if (value === undefined) throw new RangeError("Missing light scale pixel");
    if (mipmap) value = mappings.intensityTable[value];
    if (value === undefined) throw new RangeError("Missing intensity table entry");
    if (!mappings.deviceSupportsGamma) value = mappings.gammaTable[value];
    if (value === undefined) throw new RangeError("Missing gamma table entry");
    level.pixels[i + c] = value;
  }
}

function tint(level: ImageLevel, mipLevel: number): void {
  if (mipLevel >= 16) throw new RangeError("Color mip index: undefined source table domain");
  for (let i = 0; i < level.pixels.length; i += 4) for (let c = 0; c < 3; c++) {
    const value = level.pixels[i + c];
    if (value === undefined) throw new RangeError("Missing color mip pixel");
    level.pixels[i + c] = (value * 127 + (c === (mipLevel - 1) % 3 ? 255 * 128 : 0)) >> 9;
  }
}

function internalFormat(input: ImageLevel, name: string, textureBits: number, compression: ImageUploadProfile["textureCompression"]): ImageInternalFormat {
  if (name.startsWith("*lightmap")) return "rgb";
  let alpha = false;
  for (let i = 3; i < input.pixels.length; i += 4) if (input.pixels[i] !== 255) { alpha = true; break; }
  if (!alpha && compression === "s3tc") return "rgb4-s3tc";
  return textureBits === 16 ? alpha ? "rgba4" : "rgb5"
    : textureBits === 32 ? alpha ? "rgba8" : "rgb8" : alpha ? "rgba" : "rgb";
}

/** Each upload borrows its pixels until the next step. Aborts retain reached hunk allocations. */
export function* imageUploadSteps(source: TextureImage,
  request: Pick<SourceImageRequest, "name" | "mipmap" | "allowPicmip">, profile: ImageUploadProfile,
  memory: HunkAccountingProfile = { kind: "unaccounted" }): ImageUploadSteps {
  const { width: sourceWidth, height: sourceHeight, pixels } = source;
  if (pixels.length !== byteCount(sourceWidth, sourceHeight)) throw new RangeError("Image RGBA byte count does not match dimensions");
  if (!Number.isInteger(profile.picmip) || profile.picmip < 0 || profile.picmip > 16) throw new RangeError("Picmip must be the source-clamped integer in 0..16");
  sourceInteger(profile.textureBits, "Texture bits");
  if (profile.maxTextureSize !== null && (sourceInteger(profile.maxTextureSize, "Texture limit") <= 0)) throw new RangeError("Texture limit must be positive");
  let current: ImageLevel = { width: sourceWidth, height: sourceHeight,
    pixels: memory.kind === "source-hunk" ? pixels : new Uint8Array(pixels) };
  let width = powerOfTwo(sourceWidth, profile.roundImagesDown), height = powerOfTwo(sourceHeight, profile.roundImagesDown);
  let resampled: HunkAllocation | null = null;
  if (width !== sourceWidth || height !== sourceHeight) {
    const size = byteCount(width, height);
    resampled = memory.kind === "source-hunk" ? memory.accounting.allocateTemp("Upload32:resampledBuffer", request.name, size) : null;
    current = resample(current, width, height, resampled === null ? new Uint8Array(size) : resampled.bytes);
  }
  if (request.allowPicmip) { width >>= profile.picmip; height >>= profile.picmip; }
  width = Math.max(1, width); height = Math.max(1, height);
  if (profile.maxTextureSize !== null) while (width > profile.maxTextureSize || height > profile.maxTextureSize) {
    width >>= 1; height >>= 1;
  }
  const scaledBytes = byteCount(width, height);
  const scaled = memory.kind === "source-hunk" ? memory.accounting.allocateTemp("Upload32:scaledBuffer", request.name, scaledBytes) : null;
  const scaledPixels = scaled === null ? new Uint8Array(scaledBytes) : scaled.bytes;
  const format = internalFormat(current, request.name, profile.textureBits, profile.textureCompression);
  const direct = width === current.width && height === current.height && !request.mipmap;
  if (!direct) {
    while (current.width > width || current.height > height) current = mip(current, profile.simpleMipMaps, memory, request.name);
    scaledPixels.set(current.pixels);
    current = { width, height, pixels: scaledPixels };
    lightScale(current, request.mipmap, profile.colorMappings);
  }
  if (!direct) yield { kind: "set-upload-descriptor", width, height, internalFormat: format };
  yield { kind: "upload-level", index: 0, level: current, internalFormat: format };
  if (direct) yield { kind: "set-upload-descriptor", width, height, internalFormat: format };
  let index = 0;
  if (request.mipmap) while (current.width > 1 || current.height > 1) {
    current = mip(current, profile.simpleMipMaps, memory, request.name);
    index++;
    if (profile.colorMipLevels) tint(current, index);
    yield { kind: "upload-level", index, level: current, internalFormat: format };
  }
  yield { kind: "finish-upload" };
  if (memory.kind === "source-hunk") {
    if (scaled !== null) memory.accounting.freeTemp("Upload32:scaledBuffer", request.name, scaled);
    if (resampled !== null) memory.accounting.freeTemp("Upload32:resampledBuffer", request.name, resampled);
  }
  return undefined;
}

/** Snapshot collector for pure fixtures and already-prepared diagnostic creations. */
export function prepareImageUpload(source: TextureImage,
  request: Pick<SourceImageRequest, "name" | "mipmap" | "allowPicmip">, profile: ImageUploadProfile,
  memory: HunkAccountingProfile = { kind: "unaccounted" }): PreparedImageUpload {
  const steps = imageUploadSteps(source, request, profile, memory), levels: ImageLevel[] = [];
  let format: ImageInternalFormat | null = null, checked = false;
  while (!checked) {
    const step = steps.next();
    if (step.done) throw new Error("Image preparation ended before its upload check");
    switch (step.value.kind) {
      case "upload-level": {
        const level = step.value.level;
        levels.push(Object.freeze({ width: level.width, height: level.height, pixels: new Uint8Array(level.pixels) }));
        break;
      }
      case "set-upload-descriptor": format = step.value.internalFormat; break;
      case "finish-upload": checked = true; break;
    }
  }
  const first = levels[0];
  if (first === undefined || format === null) throw new Error("Image preparation has no base upload descriptor");
  const snapshots: readonly [ImageLevel, ...ImageLevel[]] = Object.freeze([first, ...levels.slice(1)]);
  let completion: { readonly kind: "pending" | "complete" } | { readonly kind: "failed"; readonly cause: unknown } = { kind: "pending" };
  return Object.freeze({ levels: snapshots, internalFormat: format,
    finishUpload(): undefined {
      if (completion.kind === "complete") return;
      if (completion.kind === "failed") throw completion.cause;
      try {
        if (!steps.next().done) throw new Error("Image preparation continued after its upload check");
        completion = { kind: "complete" };
      } catch (cause: unknown) {
        completion = { kind: "failed", cause };
        throw cause;
      }
    } });
}
