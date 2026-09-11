/*
 * MD4 registration and bone animation translated from Quake III Arena's
 * renderer/tr_model.c, renderer/tr_animation.c and qcommon/qfiles.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BspVertex } from "../assets/bsp.ts";
import type { Md4Bone, Md4Frame, Md4Model, Md4Surface, Md4Triangle, Md4Vertex, Md4Weight } from "../assets/md4.ts";
import { BinaryError, BinaryReader } from "../core/binary.ts";
import { CommonError } from "../core/common-error.ts";
import type { Vec3, Vec4 } from "../core/math.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { RefModelEntity } from "./ref-entity.ts";

const f = Math.fround;
const SF_MD4 = 7;
type Md4Pose = Pick<RefModelEntity, "frame" | "oldFrame" | "backLerp">;
export type Md4AnimatedVertex = Pick<BspVertex, "position" | "normal" | "texCoord">;

export class Md4AllocationReadError extends RangeError {
  constructor(readonly source: string, readonly offset: number, readonly byteLength: number, readonly operation: string) {
    super(`${source}: ${operation} read at ${offset} exceeds copied MD4 allocation 0..${byteLength}`);
    this.name = "Md4AllocationReadError";
  }
}

/** Explicit boundaries for unrepresented dispatch and undefined source arithmetic or stack access. */
export class Md4SourceProfileError extends Error {
  constructor(readonly source: string, readonly profile: "surface-dispatch" | "bone-stack-overflow" | "integer-overflow", detail: string) {
    super(`${source}: unsupported MD4 source profile ${profile}: ${detail}`);
    this.name = "Md4SourceProfileError";
  }
}

/** The caller supplies the actual low-hunk storage and publishes the source pointer. */
export interface Md4RegistrationHost {
  allocate(byteLength: number): Uint8Array;
  publish(resource: Md4Resource): undefined;
  print(text: string): undefined;
  shaderForHandle(index: number): MaterialRecord | null;
}

class Md4Allocation {
  readonly #view: DataView;
  readonly byteLength: number;

  constructor(readonly bytes: Uint8Array, readonly source: string) {
    this.byteLength = bytes.byteLength;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private read(offset: number, size: number, operation: string): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.byteLength - size) {
      throw new Md4AllocationReadError(this.source, offset, this.byteLength, operation);
    }
    return offset;
  }

  i32(offset: number, operation: string): number { return this.#view.getInt32(this.read(offset, 4, operation), true); }
  f32(offset: number, operation = "bone"): number { return this.#view.getFloat32(this.read(offset, 4, operation), true); }
  writeI32(offset: number, value: number, operation: string): void { this.#view.setInt32(this.read(offset, 4, operation), value, true); }

  string(offset: number, lowercase = false): string {
    let value = "";
    for (let cursor = offset; ; cursor++) {
      let byte = this.#view.getUint8(this.read(cursor, 1, "surface string"));
      if (byte === 0) return value;
      if (lowercase && byte >= 65 && byte <= 90) {
        byte += 32;
        this.#view.setUint8(cursor, byte);
      }
      value += String.fromCharCode(byte);
    }
  }

  fixedName(offset: number): string {
    let result = "";
    for (let index = 0; index < 64; index++) {
      const byte = this.#view.getUint8(this.read(offset + index, 1, "model name"));
      if (byte === 0) break;
      result += String.fromCharCode(byte);
    }
    return result;
  }

  vec3(offset: number, operation: string): Vec3 {
    return { x: this.f32(offset, operation), y: this.f32(offset + 4, operation), z: this.f32(offset + 8, operation) };
  }

  row(offset: number): Vec4 { return { ...this.vec3(offset, "bone"), w: this.f32(offset + 12) }; }
  bone(offset: number): Md4Bone { return { matrix: [this.row(offset), this.row(offset + 16), this.row(offset + 32)] }; }

  *vertices(surface: number): Generator<Md4Vertex, undefined, undefined> {
    let cursor = surface + this.i32(surface + 144, "vertex offset");
    for (let index = 0; index < this.i32(surface + 140, "vertex count"); index++) {
      const normal = this.vec3(cursor, "vertex normal"), texCoords = { x: this.f32(cursor + 12, "vertex UV"), y: this.f32(cursor + 16, "vertex UV") };
      const count = this.i32(cursor + 20, "vertex weight count"), weights: Md4Weight[] = [];
      for (let weight = 0; weight < count; weight++) {
        const offset = cursor + 24 + weight * 20;
        weights.push({ boneIndex: this.i32(offset, "weight bone index"), boneWeight: this.f32(offset + 4, "bone weight"), offset: this.vec3(offset + 8, "weight offset") });
      }
      yield { normal, texCoords, weights };
      cursor += 24 + count * 20;
    }
  }

  surface(offset: number): Md4Surface {
    const allocation = this;
    // Inspection records are lazy. Registration and tessellation read their own reached fields.
    return Object.freeze({
      get name() { return allocation.string(offset + 4); },
      get shader() { return allocation.string(offset + 68); },
      get vertices() { return Object.freeze(Array.from(allocation.vertices(offset), vertex => {
        Object.freeze(vertex.normal); Object.freeze(vertex.texCoords);
        for (const weight of vertex.weights) { Object.freeze(weight.offset); Object.freeze(weight); }
        Object.freeze(vertex.weights); return Object.freeze(vertex);
      })); },
      get triangles() {
        const triangles: Md4Triangle[] = [], start = offset + allocation.i32(offset + 152, "triangle offset");
        for (let index = 0; index < allocation.i32(offset + 148, "triangle count"); index++) {
          const cursor = start + index * 12;
          const indices: readonly [number, number, number] = Object.freeze([allocation.i32(cursor, "triangle index"),
            allocation.i32(cursor + 4, "triangle index"), allocation.i32(cursor + 8, "triangle index")]);
          triangles.push(Object.freeze({ indices }));
        }
        return Object.freeze(triangles);
      },
      get boneReferences() {
        const references: number[] = [], start = offset + allocation.i32(offset + 160, "bone reference offset");
        for (let index = 0; index < allocation.i32(offset + 156, "bone reference count"); index++) references.push(allocation.i32(start + index * 4, "bone reference"));
        return Object.freeze(references);
      },
    });
  }
}

function int32(value: number, source: string, operation: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Md4SourceProfileError(source, "integer-overflow", `${operation} exceeds the source signed integer range`);
  }
  return value;
}

function dot(row: Vec4, value: Vec3): number {
  return f(f(f(row.x * value.x) + f(row.y * value.y)) + f(row.z * value.z));
}

class ResourceSurface {
  readonly source: Md4Surface;

  constructor(readonly owner: Resource, readonly offset: number, private readonly allocation: Md4Allocation) {
    this.source = allocation.surface(offset);
    Object.freeze(this);
  }

  get surfaceType(): number { return this.allocation.i32(this.offset, "surface dispatch"); }
  get numVerts(): number { return this.allocation.i32(this.offset + 140, "vertex count"); }
  get numIndexes(): number { return int32(this.allocation.i32(this.offset + 148, "triangle count") * 3, this.allocation.source, "triangle index count"); }
  get material(): MaterialRecord { return this.owner.materialForHandle(this.allocation.i32(this.offset + 132, "surface shader index")); }

  *triangleIndices(): Generator<number, undefined, undefined> {
    const start = this.offset + this.allocation.i32(this.offset + 152, "triangle offset"), count = this.numIndexes;
    for (let index = 0; index < count; index++) yield this.allocation.i32(start + index * 4, "triangle index");
  }

  /** Header pointer reads precede RB_CheckOverflow; bone reads follow index publication. */
  animationHeader(): { readonly header: number; readonly stride: number; readonly frames: number; readonly numBones: number } {
    const dispatch = this.surfaceType;
    if (dispatch !== SF_MD4) throw new Md4SourceProfileError(this.allocation.source, "surface-dispatch",
      `surface at ${this.offset} dispatches source surface type ${dispatch}, not RB_SurfaceAnim`);
    const allocation = this.allocation, header = this.offset + allocation.i32(this.offset + 136, "surface header offset");
    const numBones = allocation.i32(header + 76, "animation bone count");
    const stride = int32(40 + numBones * 48, allocation.source, "frame stride");
    return { header, stride, frames: header + allocation.i32(header + 84, "frame offset"), numBones };
  }

  /** Called after the tess owner has written indices and advanced numIndexes. */
  *animateVertices(pose: Md4Pose, header = this.animationHeader()): Generator<Md4AnimatedVertex, undefined, undefined> {
    for (const frame of [pose.frame, pose.oldFrame]) int32(frame, this.allocation.source, "entity frame");
    const allocation = this.allocation, current = header.frames + pose.frame * header.stride + 40, old = header.frames + pose.oldFrame * header.stride + 40;
    const back = pose.frame === pose.oldFrame ? 0 : f(pose.backLerp), front = f(1 - back);
    const interpolated: number[] | null = back === 0 ? null : [];
    if (interpolated !== null) for (let index = 0; index < header.numBones * 12; index++) {
      if (index >= 128 * 12) throw new Md4SourceProfileError(allocation.source, "bone-stack-overflow", "interpolation writes beyond the 128-bone source stack allocation");
      interpolated.push(f(f(front * allocation.f32(current + index * 4)) + f(back * allocation.f32(old + index * 4))));
    }
    const component = (index: number): number => {
      if (interpolated === null) return allocation.f32(current + index * 4);
      const value = interpolated[index];
      if (value === undefined) throw new Md4SourceProfileError(allocation.source, "bone-stack-overflow", `weight reads an uninitialized or out-of-allocation interpolated bone component ${index}`);
      return value;
    };
    const row = (index: number): Vec4 => ({ x: component(index), y: component(index + 1), z: component(index + 2), w: component(index + 3) });
    let cursor = this.offset + allocation.i32(this.offset + 144, "vertex offset");
    for (let vertex = 0; vertex < this.numVerts; vertex++) {
      let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0;
      const count = allocation.i32(cursor + 20, "vertex weight count");
      for (let weight = 0; weight < count; weight++) {
        const start = cursor + 24 + weight * 20, index = allocation.i32(start, "weight bone index") * 12;
        const a = row(index), b = row(index + 4), c = row(index + 8), boneWeight = allocation.f32(start + 4, "bone weight");
        const offset = allocation.vec3(start + 8, "weight offset"), normal = allocation.vec3(cursor, "vertex normal");
        x = f(x + f(boneWeight * f(dot(a, offset) + a.w)));
        y = f(y + f(boneWeight * f(dot(b, offset) + b.w)));
        z = f(z + f(boneWeight * f(dot(c, offset) + c.w)));
        nx = f(nx + f(boneWeight * dot(a, normal)));
        ny = f(ny + f(boneWeight * dot(b, normal)));
        nz = f(nz + f(boneWeight * dot(c, normal)));
      }
      yield { position: { x, y, z }, normal: { x: nx, y: ny, z: nz },
        texCoord: { x: allocation.f32(cursor + 12, "vertex UV"), y: allocation.f32(cursor + 16, "vertex UV") } };
      cursor += 24 + count * 20;
    }
  }

  animate(pose: Md4Pose): readonly Md4AnimatedVertex[] { return Array.from(this.animateVertices(pose)); }
}

class Resource {
  readonly byteLength: number;
  private readonly surfaces = new Map<number, ResourceSurface>();
  private readonly loadedLods: ResourceSurface[][] = [];

  constructor(private readonly allocation: Md4Allocation, private readonly registration: Pick<Md4RegistrationHost, "shaderForHandle" | "print">, private readonly defaultMaterial: MaterialRecord) {
    this.byteLength = allocation.byteLength;
  }

  get lods(): readonly (readonly ResourceSurface[])[] { return this.loadedLods; }

  captureSurface(offset: number): Md4SurfaceTransfer {
    return { bytes: new Uint8Array(this.allocation.bytes), source: this.allocation.source, offset,
      defaultMaterial: this.defaultMaterial.order, lodOffsets: this.loadedLods.map(lod => lod.map(surface => surface.offset)) };
  }

  restoreSurfaces(lods: readonly (readonly number[])[], offset: number): RegisteredMd4Surface {
    const checked = (offset: number): ResourceSurface => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.byteLength - 168)
        throw new RangeError("MD4 transferred surface lies outside its retained allocation");
      return this.surface(offset);
    };
    for (const lod of lods) this.loadedLods.push(lod.map(checked));
    return checked(offset);
  }

  get model(): Md4Model {
    const allocation = this.allocation, numBones = allocation.i32(76, "bone count"), frames: Md4Frame[] = [];
    const start = allocation.i32(84, "frame offset"), stride = 40 + numBones * 48;
    for (let index = 0; index < allocation.i32(72, "frame count"); index++) {
      const offset = start + index * stride, bones: Md4Bone[] = [];
      for (let bone = 0; bone < numBones; bone++) {
        const record = allocation.bone(offset + 40 + bone * 48);
        for (const row of record.matrix) Object.freeze(row);
        Object.freeze(record.matrix); bones.push(Object.freeze(record));
      }
      frames.push(Object.freeze({ bounds: Object.freeze({ min: Object.freeze(allocation.vec3(offset, "frame bounds")), max: Object.freeze(allocation.vec3(offset + 12, "frame bounds")) }),
        localOrigin: Object.freeze(allocation.vec3(offset + 24, "frame origin")), radius: allocation.f32(offset + 36, "frame radius"), bones: Object.freeze(bones) }));
    }
    return Object.freeze({ version: allocation.i32(4, "version"), name: allocation.fixedName(8), numBones, byteLength: this.byteLength,
      frames: Object.freeze(frames), lods: Object.freeze(this.loadedLods.map(lod => Object.freeze({ surfaces: Object.freeze(lod.map(surface => surface.source)) }))) });
  }

  materialForHandle(index: number): MaterialRecord {
    const material = this.registration.shaderForHandle(index);
    if (material !== null) return material;
    this.registration.print(`R_GetShaderByHandle: out of range hShader '${index}'\n`);
    return this.defaultMaterial;
  }

  private surface(offset: number): ResourceSurface {
    let surface = this.surfaces.get(offset);
    if (surface === undefined) { surface = new ResourceSurface(this, offset, this.allocation); this.surfaces.set(offset, surface); }
    return surface;
  }

  *drawSurfaces(): Generator<ResourceSurface, undefined, undefined> {
    const allocation = this.allocation, lod = allocation.i32(92, "first LOD offset");
    let offset = lod + allocation.i32(lod + 4, "first LOD surface offset");
    for (let index = 0; index < allocation.i32(lod, "first LOD surface count"); index++) {
      yield this.surface(offset);
      offset += allocation.i32(offset + 164, "next surface offset");
    }
  }

  firstLodSurfaces(): readonly ResourceSurface[] {
    const surfaces = Array.from(this.drawSurfaces());
    const declared = this.loadedLods[0];
    return declared !== undefined && declared.length === surfaces.length && declared.every((surface, index) => surface === surfaces[index]) ? declared : surfaces;
  }

  /** R_LoadMD4 on the little-endian release profile, including unused field omissions. */
  async load(material: (name: string) => Promise<MaterialRecord>): Promise<boolean> {
    const allocation = this.allocation;
    for (const offset of [0, 4, 72, 76, 88, 84, 92, 96]) allocation.i32(offset, "header endian conversion");
    if (allocation.i32(72, "frame count") < 1) {
      this.registration.print(`R_LoadMD4: ${allocation.source} has no frames\n`);
      return false;
    }
    const stride = int32(40 + allocation.i32(76, "bone count") * 48, allocation.source, "frame stride");
    for (let index = 0; index < allocation.i32(72, "frame count"); index++) {
      const frame = allocation.i32(84, "frame offset") + index * stride;
      allocation.f32(frame + 36, "frame radius");
      for (let axis = 0; axis < 3; axis++) {
        allocation.f32(frame + axis * 4, "frame bounds");
        allocation.f32(frame + 12 + axis * 4, "frame bounds");
        allocation.f32(frame + 24 + axis * 4, "frame origin");
      }
      for (let bone = 0; bone < allocation.i32(76, "bone count") * 12; bone++) allocation.f32(frame + 40 + bone * 4);
    }
    let lod = allocation.i32(92, "LOD offset");
    for (let index = 0; index < allocation.i32(88, "LOD count"); index++) {
      let offset = lod + allocation.i32(lod + 4, "LOD surface offset");
      const surfaces: ResourceSurface[] = [];
      this.loadedLods.push(surfaces);
      for (let surface = 0; surface < allocation.i32(lod, "LOD surface count"); surface++) {
        for (const field of [0, 148, 152, 140, 144, 164]) allocation.i32(offset + field, "surface endian conversion");
        const verts = allocation.i32(offset + 140, "vertex count"), triangles = allocation.i32(offset + 148, "triangle count");
        if (verts > 1000) throw new CommonError("drop", `R_LoadMD3: ${allocation.source} has more than 1000 verts on a surface (${verts})`);
        if (int32(triangles * 3, allocation.source, "triangle index count") > 6000) {
          throw new CommonError("drop", `R_LoadMD3: ${allocation.source} has more than 2000 triangles on a surface (${triangles})`);
        }
        allocation.writeI32(offset, SF_MD4, "surface identifier");
        allocation.string(offset + 4, true);
        const shader = await material(allocation.string(offset + 68));
        allocation.writeI32(offset + 132, shader.defaulted ? 0 : int32(shader.order, allocation.source, "shader index"), "surface shader index");
        const record = this.surface(offset);
        surfaces.push(record);
        for (const unused of record.triangleIndices()) void unused;
        for (const unused of allocation.vertices(offset)) void unused;
        offset += allocation.i32(offset + 164, "next surface offset");
      }
      lod += allocation.i32(lod + 8, "next LOD offset");
    }
    return true;
  }
}

export type RegisteredMd4Surface = ResourceSurface;
export type Md4Resource = Resource;

export interface Md4SurfaceTransfer {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly offset: number;
  readonly defaultMaterial: number;
  readonly lodOffsets: readonly (readonly number[])[];
}

export function parseMd4SurfaceTransfer(input: unknown): Md4SurfaceTransfer {
  if (typeof input !== "object" || input === null || !("bytes" in input) || !(input.bytes instanceof Uint8Array)
    || !("source" in input) || typeof input.source !== "string" || !("offset" in input) || typeof input.offset !== "number"
    || !("defaultMaterial" in input) || typeof input.defaultMaterial !== "number" || !("lodOffsets" in input))
    throw new TypeError("Invalid MD4 transfer record");
  const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
  const array = (value: unknown): readonly unknown[] => {
    if (!isArray(value)) throw new TypeError("Invalid MD4 transfer LOD array");
    return value;
  };
  const bytes = new Uint8Array(input.bytes);
  const offset = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > bytes.byteLength - 168)
      throw new RangeError("Invalid MD4 transferred surface offset");
    return value;
  };
  if (!Number.isSafeInteger(input.defaultMaterial) || input.defaultMaterial < 0) throw new RangeError("Invalid MD4 transferred shader handle");
  return { bytes, source: input.source, offset: offset(input.offset), defaultMaterial: input.defaultMaterial,
    lodOffsets: array(input.lodOffsets).map(lod => array(lod).map(offset)) };
}

export function captureMd4Surface(surface: RegisteredMd4Surface): Md4SurfaceTransfer {
  return surface.owner.captureSurface(surface.offset);
}

export function restoreMd4Surface(transfer: Md4SurfaceTransfer,
  host: Pick<Md4RegistrationHost, "shaderForHandle" | "print">): RegisteredMd4Surface {
  const fallback = host.shaderForHandle(transfer.defaultMaterial);
  if (fallback === null) throw new Error("Transferred MD4 default shader is not registered");
  const resource = new Resource(new Md4Allocation(new Uint8Array(transfer.bytes), transfer.source), host, fallback);
  return resource.restoreSurfaces(transfer.lodOffsets, transfer.offset);
}

export async function loadMd4Resource(input: {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly material: (name: string) => Promise<MaterialRecord>;
  readonly defaultMaterial: MaterialRecord;
  readonly registration: Md4RegistrationHost;
}): Promise<Md4Resource | null> {
  const reader = new BinaryReader(input.bytes, input.source);
  reader.seek(4);
  const version = reader.i32();
  if (version !== 1) {
    input.registration.print(`R_LoadMD4: ${input.source} has wrong version (${version} should be 1)\n`);
    return null;
  }
  reader.seek(96);
  const length = reader.i32(), bytes = input.registration.allocate(length);
  if (bytes.byteLength !== length) throw new RangeError("MD4 hunk allocator returned a different requested extent");
  const allocation = new Md4Allocation(bytes, input.source), resource = new Resource(allocation, input.registration, input.defaultMaterial);
  input.registration.publish(resource);
  if (length > input.bytes.byteLength) throw new BinaryError(input.source, 96, "MD4 copy exceeds source file allocation");
  bytes.set(input.bytes.subarray(0, length));
  return await resource.load(input.material) ? resource : null;
}
