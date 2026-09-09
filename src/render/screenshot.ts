// Screenshot readback and TGA encoding from id Software code/renderer/tr_init.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { WritableFileSystem } from "../assets/writable-files.ts";
import { encodeJpeg } from "../assets/jpeg-encoder.ts";
import type { ConfiguredRenderer, RendererConfiguration } from "./configuration.ts";
import type { ImageColorMappings } from "./image-upload.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";

function dimensions(width: number, height: number, rgba: Uint8Array): void {
  if (![width, height].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)
    || rgba.length !== width * height * 4) throw new RangeError("Screenshot requires a complete top-left RGBA framebuffer");
  // The source allocates tight RGB rows but keeps GL_PACK_ALIGNMENT=4.
  if (height > 1 && width % 4 !== 0) throw new RangeError("Screenshot RGB row packing overflows the source allocation at this width");
}
function header(width: number, height: number, output: Uint8Array): void {
  output.fill(0, 0, 18);
  output[2] = 2; output[12] = width & 255; output[13] = width >> 8;
  output[14] = height & 255; output[15] = height >> 8; output[16] = 24;
}
function gammaCorrect(output: Uint8Array, mappings: ImageColorMappings, start = 18): void {
  if (mappings.overbrightBits === 0 || !mappings.deviceSupportsGamma) return;
  for (let index = start; index < output.length; index++) {
    const value = output[index];
    if (value === undefined) throw new RangeError("Missing screenshot byte");
    const corrected = mappings.gammaTable[value];
    if (corrected === undefined) throw new RangeError("Missing screenshot gamma table entry");
    output[index] = corrected;
  }
}
function byte(rgba: Uint8Array, index: number): number {
  const value = rgba[index];
  if (value === undefined) throw new RangeError("Screenshot sample exceeds framebuffer");
  return value;
}

/** RB_TakeScreenshot: convert the backend's top-left RGBA into source bottom-left BGR. */
export function screenshotTga(width: number, height: number, rgba: Uint8Array, mappings: ImageColorMappings): Uint8Array {
  dimensions(width, height, rgba);
  const output = new Uint8Array(18 + width * height * 3);
  header(width, height, output);
  writeScreenshotTga(width, height, rgba, mappings, output);
  return output;
}

function readbackRgb(width: number, height: number, rgba: Uint8Array, output: Uint8Array): void {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = ((height - 1 - y) * width + x) * 4, destination = (y * width + x) * 3;
    output[destination] = byte(rgba, source); output[destination + 1] = byte(rgba, source + 1); output[destination + 2] = byte(rgba, source + 2);
  }
}

function writeScreenshotTga(width: number, height: number, rgba: Uint8Array, mappings: ImageColorMappings, output: Uint8Array): void {
  const end = 18 + width * height * 3;
  readbackRgb(width, height, rgba, output.subarray(18, end));
  for (let index = 18; index < end; index += 3) {
    const red = byte(output, index);
    output[index] = byte(output, index + 2); output[index + 2] = red;
  }
  gammaCorrect(output, mappings);
}

/** R_LevelShot: twelve source samples per output pixel, followed by byte truncation. */
export function levelshotTga(width: number, height: number, rgba: Uint8Array, mappings: ImageColorMappings): Uint8Array {
  dimensions(width, height, rgba);
  const source = new Uint8Array(width * height * 3), output = new Uint8Array(128 * 128 * 3 + 18);
  header(128, 128, output);
  readbackRgb(width, height, rgba, source);
  writeLevelshotTga(width, height, source, mappings, output);
  return output;
}

function writeLevelshotTga(width: number, height: number, source: Uint8Array, mappings: ImageColorMappings, output: Uint8Array): void {
  const xScale = Math.fround(width / 512), yScale = Math.fround(height / 384);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    let r = 0, g = 0, b = 0;
    for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 4; xx++) {
      const row = Math.trunc(Math.fround((y * 3 + yy) * yScale));
      const column = Math.trunc(Math.fround((x * 4 + xx) * xScale));
      const sample = (row * width + column) * 3;
      r += byte(source, sample); g += byte(source, sample + 1); b += byte(source, sample + 2);
    }
    const destination = 18 + (y * 128 + x) * 3;
    output[destination] = Math.trunc(b / 12); output[destination + 1] = Math.trunc(g / 12); output[destination + 2] = Math.trunc(r / 12);
  }
  gammaCorrect(output, mappings);
}

function temporary(profile: HunkAccountingProfile, source: string, resource: string, size: number): { readonly bytes: Uint8Array; free(): void } {
  if (profile.kind === "unaccounted") return { bytes: new Uint8Array(size), free() {} };
  const allocation = profile.accounting.allocateTemp(source, resource, size);
  return { bytes: allocation.bytes, free() { profile.accounting.freeTemp(source, resource, allocation); } };
}

/** R_TakeScreenshot's static filename remains aliased by all pending commands. */
export class ScreenshotFilename { value = ""; }
export type ScreenshotFormat = "tga" | "jpeg";
export interface SourceScreenshotParameters {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly jpeg: boolean;
}
export interface ScreenshotGraphics {
  readonly renderer: ConfiguredRenderer;
  readonly configuration: Pick<RendererConfiguration, "imageUploadProfile">;
  readonly width: number;
  readonly height: number;
}

/** A concrete backend/file operation; the command queue owns when it executes. */
export class ScreenshotCommand {
  constructor(private readonly graphics: ScreenshotGraphics,
    private readonly files: WritableFileSystem, private readonly filename: ScreenshotFilename,
    private readonly print: (text: string) => undefined, private readonly format: ScreenshotFormat = "tga",
    private readonly memoryProfile: HunkAccountingProfile = { kind: "unaccounted" }) {}

  get jpegFormat(): boolean { return this.format === "jpeg"; }
  get renderer(): ConfiguredRenderer { return this.graphics.renderer; }

  parameters(): SourceScreenshotParameters {
    return { x: 0, y: 0, width: this.graphics.width, height: this.graphics.height, jpeg: this.jpegFormat };
  }

  execute(source: SourceScreenshotParameters = this.parameters()): undefined {
    if (source.jpeg) this.jpeg(this.filename.value, source);
    else this.write(this.filename.value, "screenshot", source);
  }
  levelshot(filename: string): undefined { this.write(filename, "levelshot"); }
  private readPixels(source: SourceScreenshotParameters): Uint8Array {
    const { renderer } = this, frameWidth = renderer.backend.width, frameHeight = renderer.backend.height;
    const { x, y, width, height } = source;
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 0 || height < 0
      || x + width > frameWidth || y + height > frameHeight)
      throw new RangeError("Screenshot rectangle must be contained in the backend framebuffer");
    if (width === 0 || height === 0) return new Uint8Array(0);
    const pixels = renderer.kind === "cpu" ? renderer.backend.pixels : renderer.backend.readPixels();
    if (x === 0 && y === 0 && width === frameWidth && height === frameHeight) return pixels;
    const selected = new Uint8Array(width * height * 4), firstRow = frameHeight - y - height;
    for (let row = 0; row < height; row++) {
      const start = ((firstRow + row) * frameWidth + x) * 4;
      selected.set(pixels.subarray(start, start + width * 4), row * width * 4);
    }
    return selected;
  }

  private write(filename: string, kind: "screenshot" | "levelshot", sourceRectangle = this.parameters()): void {
    const { width, height } = sourceRectangle;
    const frame = this.renderer.backend;
    const mappings = this.graphics.configuration.imageUploadProfile().colorMappings;
    const source = kind === "levelshot" ? temporary(this.memoryProfile, "R_LevelShot:source", filename, width * height * 3) : null;
    const output = kind === "levelshot" ? temporary(this.memoryProfile, "R_LevelShot:buffer", filename, 128 * 128 * 3 + 18)
      : temporary(this.memoryProfile, "RB_TakeScreenshot", filename, frame.width * frame.height * 3 + 18);
    header(kind === "levelshot" ? 128 : width, kind === "levelshot" ? 128 : height, output.bytes);
    // GL readPixels still owns an additional top-down RGBA readback allocation.
    const pixels = this.readPixels(sourceRectangle);
    dimensions(width, height, pixels);
    if (source === null) writeScreenshotTga(width, height, pixels, mappings, output.bytes);
    else {
      readbackRgb(width, height, pixels, source.bytes);
      writeLevelshotTga(width, height, source.bytes, mappings, output.bytes);
    }
    this.writeFile(filename, kind === "levelshot" ? output.bytes : output.bytes.subarray(0, 18 + width * height * 3));
    output.free();
    source?.free();
  }
  private jpeg(filename: string, source: SourceScreenshotParameters): void {
    const { width, height } = source;
    const frame = this.renderer.backend;
    const mappings = this.graphics.configuration.imageUploadProfile().colorMappings;
    const input = temporary(this.memoryProfile, "RB_TakeScreenshotJPEG", filename, frame.width * frame.height * 4);
    const pixels = this.readPixels(source);
    const stride = width * 4;
    for (let row = 0; row < height; row++) input.bytes.set(pixels.subarray((height - 1 - row) * stride, (height - row) * stride), row * stride);
    gammaCorrect(input.bytes, mappings, 0);
    this.writeFile(filename, input.bytes.subarray(0, 1));
    const output = temporary(this.memoryProfile, "SaveJPG", filename, frame.width * frame.height * 4);
    this.writeFile(filename, encodeJpeg({ width: frame.width, height: frame.height, pixels: input.bytes }, 95,
      { kind: "source-destination", destination: output.bytes, rowOrder: "bottom-up" }));
    output.free();
    input.free();
  }
  private writeFile(filename: string, bytes: Uint8Array): void {
    const file = this.files.openBinaryWrite(filename);
    if (file === null) { this.print(`Failed to open ${filename}\n`); return; }
    try { file.writeBytes(bytes); } finally { file.close(); }
  }
}
