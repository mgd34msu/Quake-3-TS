/*
 * MD3 v15 loading and interpolation translated from Quake III Arena's
 * qfiles.h, tr_model.c and tr_surface.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BinaryError, BinaryReader } from "../core/binary.ts";
import { normalize3 } from "../core/math.ts";
import type { Axis, Bounds, Vec2, Vec3 } from "../core/math.ts";
import { normalizeFast3, rendererSine } from "../core/renderer-math.ts";

const MD3_IDENT = 0x33504449;
const MD3_VERSION = 15;
const HEADER_SIZE = 108;
const FRAME_SIZE = 56;
const TAG_SIZE = 112;
const SURFACE_HEADER_SIZE = 108;
const SHADER_SIZE = 68;
const TRIANGLE_SIZE = 12;
const TEX_COORD_SIZE = 8;
const VERTEX_SIZE = 8;
const XYZ_SCALE = 1 / 64;
const FUNCTION_TABLE_SIZE = 1024;

const MAX_FRAMES = 1024;
const MAX_TAGS = 16;
const MAX_SURFACES = 32;
const MAX_SHADERS = 256;
const MAX_VERTICES = 4096;
const MAX_TRIANGLES = 8192;

export interface Md3Frame {
  readonly bounds: Bounds;
  readonly origin: Vec3;
  readonly radius: number;
  readonly name: string;
}

export interface Md3Tag {
  readonly name: string;
  readonly origin: Vec3;
  readonly axes: Axis;
}

export interface Md3Shader {
  readonly name: string;
  readonly index: number;
}

export interface Md3Triangle {
  readonly indices: readonly [number, number, number];
}

export interface Md3Vertex {
  readonly position: Vec3;
  readonly normal: Vec3;
}

export interface Md3Surface {
  readonly name: string;
  readonly flags: number;
  readonly shaders: readonly Md3Shader[];
  readonly triangles: readonly Md3Triangle[];
  readonly texCoords: readonly Vec2[];
  readonly frames: readonly (readonly Md3Vertex[])[];
}

export interface Md3Model {
  readonly name: string;
  readonly flags: number;
  readonly skinCount: number;
  readonly frames: readonly Md3Frame[];
  readonly tags: readonly (readonly Md3Tag[])[];
  readonly surfaces: readonly Md3Surface[];
}

export interface SkinSurface {
  readonly name: string;
  readonly shader: string;
}

function cString(reader: BinaryReader, length: number): string {
  const bytes = reader.bytes(length);
  let result = "";
  for (const byte of bytes) {
    if (byte === 0) break;
    result += String.fromCharCode(byte);
  }
  return result;
}

function vec3(reader: BinaryReader): Vec3 {
  return { x: reader.finiteF32(), y: reader.finiteF32(), z: reader.finiteF32() };
}

function fail(source: string, offset: number, message: string): never {
  throw new BinaryError(source, offset, message);
}

function count(value: number, maximum: number, source: string, offset: number, name: string): number {
  if (value < 0 || value > maximum) fail(source, offset, `${name} count ${value} outside 0..${maximum}`);
  return value;
}

function byteLength(recordCount: number, stride: number, source: string, offset: number, name: string): number {
  const length = recordCount * stride;
  if (!Number.isSafeInteger(length)) fail(source, offset, `${name} byte length is not safe`);
  return length;
}

function range(offset: number, length: number, start: number, end: number, source: string, fieldOffset: number, name: string): void {
  if (offset < start || length < 0 || offset > end - length) {
    fail(source, fieldOffset, `${name} range ${offset}+${length} exceeds ${start}..${end}`);
  }
}

function readFrame(reader: BinaryReader): Md3Frame {
  const minimum = vec3(reader);
  const maximum = vec3(reader);
  const origin = vec3(reader);
  const radius = reader.finiteF32();
  const name = cString(reader, 16);
  return { bounds: { min: minimum, max: maximum }, origin, radius, name };
}

function readTag(reader: BinaryReader): Md3Tag {
  return {
    name: cString(reader, 64),
    origin: vec3(reader),
    axes: [vec3(reader), vec3(reader), vec3(reader)],
  };
}

/** Decode the lat-long normal with the renderer's 1024-entry sine table semantics. */
export function decodeMd3Normal(packed: number): Vec3 {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffff) {
    throw new RangeError(`packed MD3 normal ${packed} outside uint16`);
  }
  const latitude = ((packed >>> 8) & 0xff) * (FUNCTION_TABLE_SIZE / 256);
  const longitude = (packed & 0xff) * (FUNCTION_TABLE_SIZE / 256);
  return {
    x: Math.fround(rendererSine(latitude + FUNCTION_TABLE_SIZE / 4) * rendererSine(longitude)),
    y: Math.fround(rendererSine(latitude) * rendererSine(longitude)),
    z: rendererSine(longitude + FUNCTION_TABLE_SIZE / 4),
  };
}

function surfaceName(name: string): string {
  const lower = name.toLowerCase();
  return lower.length > 2 && lower[lower.length - 2] === "_" ? lower.slice(0, -2) : lower;
}

function parseSurface(
  reader: BinaryReader,
  source: string,
  surfaceOffset: number,
  modelEnd: number,
  modelFrameCount: number,
): { readonly surface: Md3Surface; readonly nextOffset: number } {
  range(surfaceOffset, SURFACE_HEADER_SIZE, HEADER_SIZE, modelEnd, source, surfaceOffset, "surface header");
  reader.seek(surfaceOffset);
  if (reader.u32() !== MD3_IDENT) fail(source, surfaceOffset, "expected IDP3 surface magic");
  const name = surfaceName(cString(reader, 64));
  const flags = reader.i32();
  const frameCount = count(reader.i32(), MAX_FRAMES, source, surfaceOffset + 72, "surface frame");
  const shaderCount = count(reader.i32(), MAX_SHADERS, source, surfaceOffset + 76, "surface shader");
  const vertexCount = count(reader.i32(), MAX_VERTICES, source, surfaceOffset + 80, "surface vertex");
  const triangleCount = count(reader.i32(), MAX_TRIANGLES, source, surfaceOffset + 84, "surface triangle");
  const trianglesOffset = reader.i32();
  const shadersOffset = reader.i32();
  const texCoordsOffset = reader.i32();
  const verticesOffset = reader.i32();
  const surfaceLength = reader.i32();
  if (frameCount !== modelFrameCount) {
    fail(source, surfaceOffset + 72, `surface has ${frameCount} frames, model has ${modelFrameCount}`);
  }
  if (surfaceLength < SURFACE_HEADER_SIZE || surfaceOffset > modelEnd - surfaceLength) {
    fail(source, surfaceOffset + 104, `surface end ${surfaceLength} exceeds model end ${modelEnd}`);
  }
  const surfaceEnd = surfaceOffset + surfaceLength;
  const shaderBytes = byteLength(shaderCount, SHADER_SIZE, source, surfaceOffset + 76, "shaders");
  const triangleBytes = byteLength(triangleCount, TRIANGLE_SIZE, source, surfaceOffset + 84, "triangles");
  const texCoordBytes = byteLength(vertexCount, TEX_COORD_SIZE, source, surfaceOffset + 80, "texture coordinates");
  const vertexRecords = byteLength(frameCount, vertexCount, source, surfaceOffset + 72, "vertex frames");
  const vertexBytes = byteLength(vertexRecords, VERTEX_SIZE, source, surfaceOffset + 80, "vertices");
  range(shadersOffset, shaderBytes, SURFACE_HEADER_SIZE, surfaceLength, source, surfaceOffset + 92, "shaders");
  range(trianglesOffset, triangleBytes, SURFACE_HEADER_SIZE, surfaceLength, source, surfaceOffset + 88, "triangles");
  range(texCoordsOffset, texCoordBytes, SURFACE_HEADER_SIZE, surfaceLength, source, surfaceOffset + 96, "texture coordinates");
  range(verticesOffset, vertexBytes, SURFACE_HEADER_SIZE, surfaceLength, source, surfaceOffset + 100, "vertices");

  reader.seek(surfaceOffset + shadersOffset);
  const shaders: Md3Shader[] = [];
  for (let index = 0; index < shaderCount; index++) {
    shaders.push({ name: cString(reader, 64), index: reader.i32() });
  }

  reader.seek(surfaceOffset + trianglesOffset);
  const triangles: Md3Triangle[] = [];
  for (let index = 0; index < triangleCount; index++) {
    const triangleOffset = surfaceOffset + trianglesOffset + index * TRIANGLE_SIZE;
    const indices: readonly [number, number, number] = [reader.i32(), reader.i32(), reader.i32()];
    for (const vertex of indices) {
      if (vertex < 0 || vertex >= vertexCount) {
        fail(source, triangleOffset, `triangle vertex ${vertex} outside 0..${vertexCount - 1}`);
      }
    }
    triangles.push({ indices });
  }

  reader.seek(surfaceOffset + texCoordsOffset);
  const texCoords: Vec2[] = [];
  for (let index = 0; index < vertexCount; index++) {
    texCoords.push({ x: reader.finiteF32(), y: reader.finiteF32() });
  }

  reader.seek(surfaceOffset + verticesOffset);
  const frames: Md3Vertex[][] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const vertices: Md3Vertex[] = [];
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const position: Vec3 = {
        x: Math.fround(reader.i16() * XYZ_SCALE),
        y: Math.fround(reader.i16() * XYZ_SCALE),
        z: Math.fround(reader.i16() * XYZ_SCALE),
      };
      vertices.push({ position, normal: decodeMd3Normal(reader.u16()) });
    }
    frames.push(vertices);
  }
  return { surface: { name, flags, shaders, triangles, texCoords, frames }, nextOffset: surfaceEnd };
}

/** Parse a complete little-endian MD3 version 15 model. */
export function parseMd3(data: Uint8Array, source = "<md3>"): Md3Model {
  const reader = new BinaryReader(data, source);
  if (reader.u32() !== MD3_IDENT) fail(source, 0, "expected IDP3 magic");
  if (reader.i32() !== MD3_VERSION) fail(source, 4, "expected MD3 version 15");
  const name = cString(reader, 64);
  const flags = reader.i32();
  const frameCount = count(reader.i32(), MAX_FRAMES, source, 76, "frame");
  const tagCount = count(reader.i32(), MAX_TAGS, source, 80, "tag");
  const surfaceCount = count(reader.i32(), MAX_SURFACES, source, 84, "surface");
  const skinCount = reader.i32();
  const framesOffset = reader.i32();
  const tagsOffset = reader.i32();
  const surfacesOffset = reader.i32();
  const modelEnd = reader.i32();
  if (frameCount < 1) fail(source, 76, "MD3 has no frames");
  if (skinCount < 0) fail(source, 88, `negative skin count ${skinCount}`);
  if (modelEnd < HEADER_SIZE || modelEnd > data.byteLength) {
    fail(source, 104, `model end ${modelEnd} outside ${HEADER_SIZE}..${data.byteLength}`);
  }
  const frameBytes = byteLength(frameCount, FRAME_SIZE, source, 76, "frames");
  const tagRecords = byteLength(frameCount, tagCount, source, 80, "tags");
  const tagBytes = byteLength(tagRecords, TAG_SIZE, source, 80, "tags");
  range(framesOffset, frameBytes, HEADER_SIZE, modelEnd, source, 92, "frames");
  range(tagsOffset, tagBytes, HEADER_SIZE, modelEnd, source, 96, "tags");
  range(surfacesOffset, 0, HEADER_SIZE, modelEnd, source, 100, "surfaces");

  reader.seek(framesOffset);
  const frames: Md3Frame[] = [];
  for (let index = 0; index < frameCount; index++) {
    frames.push(readFrame(reader));
  }

  reader.seek(tagsOffset);
  const tags: Md3Tag[][] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const frameTags: Md3Tag[] = [];
    for (let index = 0; index < tagCount; index++) frameTags.push(readTag(reader));
    tags.push(frameTags);
  }

  const surfaces: Md3Surface[] = [];
  let surfaceOffset = surfacesOffset;
  for (let index = 0; index < surfaceCount; index++) {
    const parsed = parseSurface(reader, source, surfaceOffset, modelEnd, frameCount);
    surfaces.push(parsed.surface);
    surfaceOffset = parsed.nextOffset;
  }
  if (surfaceOffset !== modelEnd) {
    fail(source, surfaceOffset, `surface chain ends at ${surfaceOffset}, model ends at ${modelEnd}`);
  }
  return { name, flags, skinCount, frames, tags, surfaces };
}

function frameAt(surface: Md3Surface, index: number, name: string): readonly Md3Vertex[] {
  if (!Number.isInteger(index) || index < 0 || index >= surface.frames.length) {
    throw new RangeError(`${name} MD3 frame ${index} outside 0..${surface.frames.length - 1}`);
  }
  const frame = surface.frames[index];
  if (frame === undefined) throw new RangeError(`missing ${name} MD3 frame ${index}`);
  return frame;
}

/** Interpolate a surface using the renderer's old-frame backlerp convention. */
export function interpolateSurface(
  surface: Md3Surface,
  frame: number,
  oldFrame: number,
  backLerp: number,
): readonly Md3Vertex[] {
  if (!Number.isFinite(backLerp)) throw new RangeError("MD3 backlerp must be finite");
  const current = frameAt(surface, frame, "current");
  const oldNormalScale = Math.fround(backLerp);
  if (oldNormalScale === 0 || frame === oldFrame) return current;
  const previous = frameAt(surface, oldFrame, "old");
  return interpolateMd3Frames(current, previous, backLerp);
}

/** Shared arithmetic for parsed inspection data and allocation-backed renderer reads. */
export function interpolateMd3Frames(current: readonly Md3Vertex[], previous: readonly Md3Vertex[], backLerp: number): readonly Md3Vertex[] {
  const oldNormalScale = Math.fround(backLerp);
  const newNormalScale = Math.fround(1 - oldNormalScale);
  const oldXyzScale = Math.fround(XYZ_SCALE * oldNormalScale);
  const newXyzScale = Math.fround(XYZ_SCALE * newNormalScale);
  function positionComponent(oldValue: number, newValue: number): number {
    const oldXyz = Math.fround(oldValue * 64);
    const newXyz = Math.fround(newValue * 64);
    return Math.fround(Math.fround(oldXyz * oldXyzScale) + Math.fround(newXyz * newXyzScale));
  }
  function normalComponent(oldValue: number, newValue: number): number {
    return Math.fround(
      Math.fround(oldValue * oldNormalScale) + Math.fround(newValue * newNormalScale),
    );
  }
  const result: Md3Vertex[] = [];
  for (let index = 0; index < current.length; index++) {
    const currentVertex = current[index];
    const previousVertex = previous[index];
    if (currentVertex === undefined || previousVertex === undefined) {
      throw new RangeError(`missing MD3 surface vertex ${index}`);
    }
    result.push({
      position: {
        x: positionComponent(previousVertex.position.x, currentVertex.position.x),
        y: positionComponent(previousVertex.position.y, currentVertex.position.y),
        z: positionComponent(previousVertex.position.z, currentVertex.position.z),
      },
      normal: normalizeFast3({
        x: normalComponent(previousVertex.normal.x, currentVertex.normal.x),
        y: normalComponent(previousVertex.normal.y, currentVertex.normal.y),
        z: normalComponent(previousVertex.normal.z, currentVertex.normal.z),
      }),
    });
  }
  return result;
}

function tagAt(model: Md3Model, frame: number, name: string): Md3Tag | undefined {
  if (!Number.isInteger(frame) || frame < 0) throw new RangeError(`MD3 tag frame ${frame} must be non-negative`);
  const clamped = Math.min(frame, model.frames.length - 1);
  const tags = model.tags[clamped];
  if (tags === undefined) return undefined;
  return tags.find(tag => tag.name === name);
}

/** Interpolate a named tag. Oversized frame numbers clamp as R_GetTag does. */
export function lerpTag(
  model: Md3Model,
  name: string,
  startFrame: number,
  endFrame: number,
  fraction: number,
): Md3Tag | null {
  const start = tagAt(model, startFrame, name);
  const end = tagAt(model, endFrame, name);
  if (start === undefined || end === undefined) return null;
  return interpolateMd3Tags(start, end, name, fraction);
}

/** R_LerpTag's arithmetic after both source tag pointers have been resolved. */
export function interpolateMd3Tags(start: Md3Tag, end: Md3Tag, name: string, fraction: number): Md3Tag {
  if (!Number.isFinite(fraction)) throw new RangeError("MD3 tag fraction must be finite");
  const frontLerp = Math.fround(fraction);
  const backLerp = Math.fround(1 - frontLerp);
  function interpolate(from: Vec3, to: Vec3): Vec3 {
    return {
      x: Math.fround(Math.fround(from.x * backLerp) + Math.fround(to.x * frontLerp)),
      y: Math.fround(Math.fround(from.y * backLerp) + Math.fround(to.y * frontLerp)),
      z: Math.fround(Math.fround(from.z * backLerp) + Math.fround(to.z * frontLerp)),
    };
  }
  return {
    name,
    origin: interpolate(start.origin, end.origin),
    axes: [
      normalize3(interpolate(start.axes[0], end.axes[0])),
      normalize3(interpolate(start.axes[1], end.axes[1])),
      normalize3(interpolate(start.axes[2], end.axes[2])),
    ],
  };
}

class SkinTokenizer {
  private offset = 0;

  private readonly text: string;

  constructor(text: string) {
    const terminator = text.indexOf("\0");
    this.text = terminator < 0 ? text : text.slice(0, terminator);
    for (let index = 0; index < this.text.length; index++) {
      if (this.text.charCodeAt(index) > 255) throw new RangeError("CommaParse requires source byte text");
    }
  }

  skipComma(): void {
    if (this.text[this.offset] === ",") this.offset++;
  }

  next(): string | undefined {
    while (true) {
      while (this.offset < this.text.length) {
        const character = this.text[this.offset];
        if (character === undefined || (character.charCodeAt(0) > 32 && character.charCodeAt(0) < 128)) break;
        this.offset++;
      }
      if (this.text.startsWith("//", this.offset)) {
        while (this.offset < this.text.length && this.text[this.offset] !== "\n") this.offset++;
        continue;
      }
      if (this.text.startsWith("/*", this.offset)) {
        this.offset += 2;
        while (this.offset < this.text.length && !this.text.startsWith("*/", this.offset)) this.offset++;
        if (this.text.startsWith("*/", this.offset)) this.offset += 2;
        continue;
      }
      break;
    }
    const first = this.text[this.offset];
    if (first === undefined) return undefined;
    let result = "";
    if (first === "\"") {
      this.offset++;
      while (this.offset < this.text.length) {
        const character = this.text[this.offset];
        if (character === undefined || character === "\"") break;
        result += character;
        this.offset++;
      }
      if (this.text[this.offset] === "\"") this.offset++;
      if (result.length >= 1024) throw new RangeError("CommaParse quoted token exceeds its source allocation");
      return result;
    }
    // CommaParse always consumes the first byte, even when it is a comma.
    result = first;
    this.offset++;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset];
      if (character === undefined || character === "," || character.charCodeAt(0) <= 32 || character.charCodeAt(0) >= 128) break;
      if (result.length < 1024) result += character;
      this.offset++;
    }
    return result.length === 1024 ? "" : result;
  }
}

/** RE_RegisterSkin consumes one mapping before it calls R_FindShader. */
export function* iterateSkinSurfaces(text: string): Generator<SkinSurface, void, unknown> {
  const tokenizer = new SkinTokenizer(text);
  while (true) {
    const name = tokenizer.next();
    if (name === undefined || name.length === 0) return;
    tokenizer.skipComma();
    if (name.includes("tag_")) continue;
    const shader = tokenizer.next() ?? "";
    yield { name: name.slice(0, 63).replace(/[A-Z]/g, letter => letter.toLowerCase()), shader };
  }
}

/** Detached inspection of the renderer's comma-separated skin mappings. */
export function parseSkin(text: string): readonly SkinSurface[] {
  return Array.from(iterateSkinSurfaces(text));
}
