/*
 * MD3 retained registration and source reads from id Software's renderer/tr_model.c,
 * tr_mesh.c, tr_surface.c and qcommon/qfiles.h. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { decodeMd3Normal, interpolateMd3Frames, interpolateMd3Tags, interpolateSurface, lerpTag } from "../assets/md3.ts";
import type { Md3Frame, Md3Model, Md3Shader, Md3Surface, Md3Tag, Md3Triangle, Md3Vertex } from "../assets/md3.ts";
import { BinaryError, BinaryReader } from "../core/binary.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec2, Vec3 } from "../core/math.ts";
import type { MaterialRecord } from "./material-registry.ts";

export class Md3AllocationReadError extends RangeError {
  constructor(readonly source: string, readonly offset: number, readonly byteLength: number, readonly operation: string) {
    super(`${source}: ${operation} read at ${offset} exceeds copied MD3 allocation 0..${byteLength}`);
    this.name = "Md3AllocationReadError";
  }
}

function int32(value: number, source: string, operation: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`${source}: ${operation} exceeds the source signed integer range`);
  }
  return value;
}

class ResourceSurface implements Md3Surface {
  constructor(readonly allocation: Resource, readonly offset: number) {}

  get name(): string { return this.allocation.string(this.offset + 4); }
  get flags(): number { return this.allocation.i32(this.offset + 68, "surface flags"); }
  get numShaders(): number { return this.allocation.i32(this.offset + 76, "surface shader count"); }
  get numVerts(): number { return this.allocation.i32(this.offset + 80, "surface vertex count"); }

  shader(index: number): Md3Shader {
    const allocation = this.allocation, offset = this.offset + allocation.i32(this.offset + 92, "surface shader offset") + index * 68;
    return { get name() { return allocation.string(offset); }, get index() { return allocation.i32(offset + 64, "shader index"); } };
  }

  get shaders(): readonly Md3Shader[] {
    const shaders: Md3Shader[] = [];
    for (let index = 0; index < this.numShaders; index++) shaders.push(this.shader(index));
    return shaders;
  }

  get triangles(): readonly Md3Triangle[] {
    const allocation = this.allocation, start = this.offset + allocation.i32(this.offset + 88, "surface triangle offset"), triangles: Md3Triangle[] = [];
    for (let index = 0; index < allocation.i32(this.offset + 84, "surface triangle count"); index++) {
      const offset = start + index * 12;
      triangles.push({ indices: [allocation.i32(offset, "triangle index"), allocation.i32(offset + 4, "triangle index"), allocation.i32(offset + 8, "triangle index")] });
    }
    return triangles;
  }

  get texCoords(): readonly Vec2[] {
    const allocation = this.allocation, start = this.offset + allocation.i32(this.offset + 96, "surface ST offset"), coordinates: Vec2[] = [];
    for (let index = 0; index < this.numVerts; index++) coordinates.push({ x: allocation.f32(start + index * 8, "texture coordinate"), y: allocation.f32(start + index * 8 + 4, "texture coordinate") });
    return coordinates;
  }

  frame(index: number): readonly Md3Vertex[] {
    const allocation = this.allocation, vertices: Md3Vertex[] = [], count = this.numVerts;
    const frameVertices = int32(int32(index, allocation.source, "surface frame") * count, allocation.source, "vertex frame product");
    const packedOffset = int32(frameVertices * 4, allocation.source, "packed vertex frame offset");
    const start = this.offset + allocation.i32(this.offset + 100, "surface vertex offset") + packedOffset * 2;
    for (let vertex = 0; vertex < count; vertex++) {
      const offset = start + vertex * 8;
      vertices.push({ position: { x: allocation.i16(offset, "vertex X") / 64, y: allocation.i16(offset + 2, "vertex Y") / 64, z: allocation.i16(offset + 4, "vertex Z") / 64 },
        normal: decodeMd3Normal(allocation.u16(offset + 6, "vertex normal")) });
    }
    return vertices;
  }

  get frames(): readonly (readonly Md3Vertex[])[] {
    const frames: (readonly Md3Vertex[])[] = [];
    for (let index = 0; index < this.allocation.i32(this.offset + 72, "surface frame count"); index++) frames.push(this.frame(index));
    return frames;
  }
}

/** Model-shaped views borrow the actual copied hunk allocation, including failed-load prefixes. */
class Resource implements Md3Model {
  private readonly view: DataView;
  private readonly frameViews = new Map<number, Md3Frame>();
  private readonly surfaceViews = new Map<number, ResourceSurface>();

  constructor(readonly bytes: Uint8Array, readonly source: string) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

  private read(offset: number, length: number, operation: string): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.bytes.byteLength - length) {
      throw new Md3AllocationReadError(this.source, offset, this.bytes.byteLength, operation);
    }
    return offset;
  }

  i32(offset: number, operation: string): number { return this.view.getInt32(this.read(offset, 4, operation), true); }
  i16(offset: number, operation: string): number { return this.view.getInt16(this.read(offset, 2, operation), true); }
  u16(offset: number, operation: string): number { return this.view.getUint16(this.read(offset, 2, operation), true); }
  f32(offset: number, operation: string): number { return this.view.getFloat32(this.read(offset, 4, operation), true); }
  writeI32(offset: number, value: number, operation: string): void { this.view.setInt32(this.read(offset, 4, operation), value, true); }
  writeByte(offset: number, value: number): void { this.view.setUint8(this.read(offset, 1, "surface name"), value); }
  vec3(offset: number, operation: string): Vec3 { return { x: this.f32(offset, operation), y: this.f32(offset + 4, operation), z: this.f32(offset + 8, operation) }; }

  string(offset: number, limit = Infinity, lowercase = false): string {
    let value = "";
    for (let index = 0; index < limit; index++) {
      let byte = this.view.getUint8(this.read(offset + index, 1, "C string"));
      if (byte === 0) break;
      if (lowercase && byte >= 65 && byte <= 90) { byte += 32; this.view.setUint8(offset + index, byte); }
      value += String.fromCharCode(byte);
    }
    return value;
  }

  get name(): string { return this.string(8, 64); }
  get flags(): number { return this.i32(72, "model flags"); }
  get skinCount(): number { return this.i32(88, "skin count"); }
  get numFrames(): number { return this.i32(76, "frame count"); }

  frame(index: number): Md3Frame {
    const offset = this.i32(92, "frame offset") + int32(index, this.source, "frame index") * 56;
    let frame = this.frameViews.get(offset);
    if (frame === undefined) {
      const allocation = this;
      frame = {
        bounds: { get min() { return allocation.vec3(offset, "frame minimum"); }, get max() { return allocation.vec3(offset + 12, "frame maximum"); } },
        get origin() { return allocation.vec3(offset + 24, "frame origin"); }, get radius() { return allocation.f32(offset + 36, "frame radius"); },
        get name() { return allocation.string(offset + 40, 16); },
      };
      this.frameViews.set(offset, frame);
    }
    return frame;
  }

  get frames(): readonly Md3Frame[] {
    const frames: Md3Frame[] = [];
    for (let index = 0; index < this.numFrames; index++) frames.push(this.frame(index));
    return frames;
  }

  private tag(offset: number): Md3Tag {
    const allocation = this;
    return { get name() { return allocation.string(offset); }, get origin() { return allocation.vec3(offset + 64, "tag origin"); },
      get axes(): Md3Tag["axes"] { return [allocation.vec3(offset + 76, "tag axis"), allocation.vec3(offset + 88, "tag axis"), allocation.vec3(offset + 100, "tag axis")]; } };
  }

  tagsAt(frame: number): readonly Md3Tag[] {
    const count = this.i32(80, "tag count"), start = this.i32(96, "tag offset") + int32(frame * count, this.source, "tag frame product") * 112, tags: Md3Tag[] = [];
    for (let index = 0; index < count; index++) tags.push(this.tag(start + index * 112));
    return tags;
  }

  findTag(frame: number, name: string): Md3Tag | undefined {
    int32(frame, this.source, "tag frame");
    return this.tagsAt(frame >= this.numFrames ? int32(this.numFrames - 1, this.source, "tag frame clamp") : frame).find(tag => tag.name === name);
  }

  get tags(): readonly (readonly Md3Tag[])[] {
    const frames: (readonly Md3Tag[])[] = [];
    for (let index = 0; index < this.numFrames; index++) frames.push(this.tagsAt(index));
    return frames;
  }

  *drawSurfaces(): Generator<Md3Surface, undefined, undefined> {
    let offset = this.i32(100, "surface offset");
    for (let index = 0; index < this.i32(84, "surface count"); index++) {
      let surface = this.surfaceViews.get(offset);
      if (surface === undefined) { surface = new ResourceSurface(this, offset); this.surfaceViews.set(offset, surface); }
      yield surface;
      offset += this.i32(offset + 104, "next surface offset");
    }
  }

  get surfaces(): readonly Md3Surface[] { return Array.from(this.drawSurfaces()); }
}

export function md3FrameCount(model: Md3Model): number { return model instanceof Resource ? model.numFrames : model.frames.length; }
export function md3TagCount(model: Md3Model): number {
  if (model instanceof Resource) return model.i32(80, "tag count");
  const tags = model.tags[0];
  if (tags === undefined) throw new RangeError("missing MD3 tag frame 0");
  return tags.length;
}

export function md3FrameAt(model: Md3Model, index: number, label = "MD3 frame"): Md3Frame {
  if (model instanceof Resource) return model.frame(index);
  const frame = model.frames[index];
  if (frame === undefined) throw new RangeError(`missing ${label} ${index}`);
  return frame;
}

export function md3Surfaces(model: Md3Model): Iterable<Md3Surface, undefined, undefined> { return model instanceof Resource ? model.drawSurfaces() : model.surfaces; }
export function md3ShaderCount(surface: Md3Surface): number { return surface instanceof ResourceSurface ? surface.numShaders : surface.shaders.length; }

export interface Md3SurfaceSource {
  readonly surfaceType: number;
  readonly numVerts: number;
  readonly numTriangles: number;
  vertexFrame(frame: number): {
    xyz(vertex: number, component: 0 | 1 | 2): number;
    normal(vertex: number): Vec3;
  };
  triangleIndices(): { at(index: number): number };
  textureCoordinates(): { at(index: number): number };
}

/** RB_SurfaceMesh resolves addresses and reads each cell at its reached execution phase. */
export function md3SurfaceSource(surface: Md3Surface): Md3SurfaceSource {
  if (surface instanceof ResourceSurface) {
    const allocation = surface.allocation, offset = surface.offset;
    return {
      get surfaceType() { return allocation.i32(offset, "surface dispatch"); },
      get numVerts() { return surface.numVerts; },
      get numTriangles() { return allocation.i32(offset + 84, "surface triangle count"); },
      vertexFrame(frame) {
        const vertices = offset + allocation.i32(offset + 100, "surface vertex offset");
        const frameVertices = int32(int32(frame, allocation.source, "surface frame") * surface.numVerts, allocation.source, "vertex frame product");
        const start = vertices + int32(frameVertices * 4, allocation.source, "packed vertex frame offset") * 2;
        return {
          xyz(vertex, component) {
            return allocation.i16(start + vertex * 8 + component * 2, component === 0 ? "vertex X" : component === 1 ? "vertex Y" : "vertex Z");
          },
          normal(vertex) { return decodeMd3Normal(allocation.u16(start + vertex * 8 + 6, "vertex normal")); },
        };
      },
      triangleIndices() {
        const start = offset + allocation.i32(offset + 88, "surface triangle offset");
        return { at(index) { return allocation.i32(start + index * 4, "triangle index"); } };
      },
      textureCoordinates() {
        const start = offset + allocation.i32(offset + 96, "surface ST offset");
        return { at(index) { return allocation.f32(start + index * 4, "texture coordinate"); } };
      },
    };
  }
  return {
    get surfaceType() { return 6; },
    get numVerts() { return surface.texCoords.length; },
    get numTriangles() { return surface.triangles.length; },
    vertexFrame(frame) {
      const at = (index: number): Md3Vertex => {
        const vertex = surface.frames[frame]?.[index];
        if (vertex === undefined) throw new RangeError(`missing MD3 frame ${frame} vertex ${index}`);
        return vertex;
      };
      return {
        xyz(vertex, component) {
          const position = at(vertex).position;
          return Math.fround((component === 0 ? position.x : component === 1 ? position.y : position.z) * 64);
        },
        normal(vertex) { return at(vertex).normal; },
      };
    },
    triangleIndices() {
      return { at(index) {
        const value = surface.triangles[Math.floor(index / 3)]?.indices[index % 3];
        if (value === undefined) throw new RangeError(`missing MD3 triangle index ${index}`);
        return value;
      } };
    },
    textureCoordinates() {
      return { at(index) {
        const coordinate = surface.texCoords[Math.floor(index / 2)], component = index % 2;
        if (coordinate === undefined || component !== 0 && component !== 1) throw new RangeError(`missing MD3 texture coordinate ${index}`);
        return component === 0 ? coordinate.x : coordinate.y;
      } };
    },
  };
}

export function md3ShaderIndex(surface: Md3Surface, skinNum: number): number {
  const count = md3ShaderCount(surface), slot = skinNum % count;
  if (count <= 0) throw new RangeError("MD3 shader index requested with no source shaders");
  if (surface instanceof ResourceSurface) { int32(skinNum, surface.allocation.source, "skin index"); return surface.shader(slot).index; }
  const shader = surface.shaders[slot];
  if (shader === undefined) throw new RangeError(`missing MD3 surface shader ${slot}`);
  return shader.index;
}

export function md3InterpolateSurface(surface: Md3Surface, frame: number, oldFrame: number, backLerp: number): readonly Md3Vertex[] {
  if (!(surface instanceof ResourceSurface)) return interpolateSurface(surface, frame, oldFrame, backLerp);
  const dispatch = surface.allocation.i32(surface.offset, "surface dispatch");
  if (dispatch !== 6) throw new Error(`${surface.allocation.source}: unsupported source surface dispatch ${dispatch} at MD3 surface ${surface.offset}`);
  if (!Number.isFinite(backLerp)) throw new RangeError("MD3 backlerp must be finite");
  const current = surface.frame(frame);
  return Math.fround(backLerp) === 0 || frame === oldFrame ? current : interpolateMd3Frames(current, surface.frame(oldFrame), backLerp);
}

export function md3LerpTag(model: Md3Model, name: string, startFrame: number, endFrame: number, fraction: number): Md3Tag | null {
  if (!(model instanceof Resource)) return lerpTag(model, name, startFrame, endFrame, fraction);
  const start = model.findTag(startFrame, name), end = model.findTag(endFrame, name);
  return start === undefined || end === undefined ? null : interpolateMd3Tags(start, end, name, fraction);
}

export async function loadMd3Resource(input: {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly material: (name: string) => Promise<MaterialRecord>;
  readonly registration: {
    allocate(byteLength: number): Uint8Array;
    publish(model: Md3Model): undefined;
    print(text: string): undefined;
  };
}): Promise<Md3Model | null> {
  const reader = new BinaryReader(input.bytes, input.source);
  reader.seek(4);
  const version = reader.i32();
  if (version !== 15) {
    input.registration.print(`R_LoadMD3: ${input.source} has wrong version (${version} should be 15)\n`);
    return null;
  }
  reader.seek(104);
  const length = reader.i32(), bytes = input.registration.allocate(length);
  if (bytes.byteLength !== length) throw new RangeError("MD3 hunk allocator returned a different requested extent");
  const resource = new Resource(bytes, input.source);
  input.registration.publish(resource);
  if (length > input.bytes.byteLength) throw new BinaryError(input.source, 104, "MD3 copy exceeds source file allocation");
  bytes.set(input.bytes.subarray(0, length));
  for (const field of [0, 4, 76, 80, 84, 92, 96, 100, 104]) resource.i32(field, "header endian conversion");
  if (resource.numFrames < 1) {
    input.registration.print(`R_LoadMD3: ${input.source} has no frames\n`);
    return null;
  }
  const frames = resource.i32(92, "frame offset");
  for (let index = 0; index < resource.numFrames; index++) {
    const frame = frames + index * 56;
    resource.f32(frame + 36, "frame radius");
    for (let axis = 0; axis < 3; axis++) {
      resource.f32(frame + axis * 4, "frame minimum"); resource.f32(frame + 12 + axis * 4, "frame maximum"); resource.f32(frame + 24 + axis * 4, "frame origin");
    }
  }
  const tags = resource.i32(96, "tag offset");
  for (let index = 0; index < int32(resource.i32(80, "tag count") * resource.numFrames, input.source, "tag count product"); index++) {
    const tag = tags + index * 112;
    for (let axis = 0; axis < 3; axis++) for (const field of [64, 76, 88, 100]) resource.f32(tag + field + axis * 4, "tag endian conversion");
  }
  let offset = resource.i32(100, "surface offset");
  for (let surface = 0; surface < resource.i32(84, "surface count"); surface++) {
    for (const field of [0, 68, 72, 76, 84, 88, 80, 92, 96, 100, 104]) resource.i32(offset + field, "surface endian conversion");
    const verts = resource.i32(offset + 80, "surface vertex count"), triangles = resource.i32(offset + 84, "surface triangle count");
    if (verts > 1000) throw new CommonError("drop", `R_LoadMD3: ${input.source} has more than 1000 verts on a surface (${verts})`);
    if (int32(triangles * 3, input.source, "triangle index count") > 6000) throw new CommonError("drop", `R_LoadMD3: ${input.source} has more than 2000 triangles on a surface (${triangles})`);
    resource.writeI32(offset, 6, "surface identifier");
    const name = resource.string(offset + 4, Infinity, true);
    if (name.length > 2 && name[name.length - 2] === "_") resource.writeByte(offset + 4 + name.length - 2, 0);
    const shaders = offset + resource.i32(offset + 92, "surface shader offset");
    for (let shader = 0; shader < resource.i32(offset + 76, "surface shader count"); shader++) {
      const start = shaders + shader * 68, material = await input.material(resource.string(start));
      resource.writeI32(start + 64, material.defaulted ? 0 : int32(material.order, input.source, "shader index"), "shader index");
    }
    const triangleStart = offset + resource.i32(offset + 88, "surface triangle offset");
    for (let triangle = 0; triangle < resource.i32(offset + 84, "surface triangle count"); triangle++) {
      for (let component = 0; component < 3; component++) resource.i32(triangleStart + triangle * 12 + component * 4, "triangle index");
    }
    const st = offset + resource.i32(offset + 96, "surface ST offset");
    for (let vertex = 0; vertex < resource.i32(offset + 80, "surface vertex count"); vertex++) {
      resource.f32(st + vertex * 8, "texture coordinate"); resource.f32(st + vertex * 8 + 4, "texture coordinate");
    }
    const xyz = offset + resource.i32(offset + 100, "surface vertex offset");
    for (let vertex = 0; vertex < int32(resource.i32(offset + 80, "surface vertex count") * resource.i32(offset + 72, "surface frame count"), input.source, "vertex frame product"); vertex++) {
      for (let component = 0; component < 4; component++) resource.i16(xyz + vertex * 8 + component * 2, "packed vertex");
    }
    offset += resource.i32(offset + 104, "next surface offset");
  }
  return resource;
}
