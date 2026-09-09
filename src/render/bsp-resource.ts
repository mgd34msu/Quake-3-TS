// Renderer BSP ownership and loading translated from id Software's tr_bsp.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { BspLeaf, BspModel, BspNode, BspPlane, BspShader, BspVertex, BspVisibility } from "../assets/bsp.ts";
import type { RetainedFileBuffer } from "../assets/read-file-memory.ts";
import { BinaryError } from "../core/binary.ts";
import { CommonError } from "../core/common-error.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import { dot3, vec3 } from "../core/math.ts";
import type { Bounds, Plane, Vec2, Vec3, Vec4 } from "../core/math.ts";
import { parseEntities } from "../core/text.ts";
import type { FogVolume } from "./fog.ts";
import { SOURCE_HUNK_RELEASE32 } from "./hunk-accounting.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";
import type { LightGrid } from "./lighting.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { ShaderDefinition } from "./material.ts";
import { createPatchGrid, preparePatchGrids } from "./patch-lod.ts";
import type { PatchGrid } from "./patch-lod.ts";
import { tessellatePatch, TemporaryPatchMesh } from "./patch.ts";
import type { PatchMemoryProfile } from "./patch.ts";
import type { RendererBspSettings } from "./settings.ts";

export type RendererBspSurface = { readonly shader: number; readonly fog: number } & (
  { readonly type: "planar"; readonly plane: Plane }
  | { readonly type: "patch" | "triangles" | "flare" }
);
export interface SourceBspVisibilityNode {
  readonly contents: number;
  /** Combined node/leaf allocation index; the stored -1 represents a null source pointer. */
  readonly parent: number | null;
  readonly cluster: number;
  readonly area: number;
  visFrame: number;
}
/** The renderer loads these records. Collision and full disk diagnostics own separate maps. */
export interface RendererBspMap {
  readonly entities: string;
  readonly entityRecords: ReturnType<typeof parseEntities>;
  readonly shaders: readonly BspShader[];
  readonly planes: readonly BspPlane[];
  readonly nodes: readonly BspNode[];
  readonly leaves: readonly Pick<BspLeaf, "cluster" | "area" | "bounds" | "firstSurface" | "surfaceCount">[];
  readonly leafSurfaces: readonly number[];
  readonly models: readonly Pick<BspModel, "bounds" | "firstSurface" | "surfaceCount">[];
  readonly surfaces: readonly RendererBspSurface[];
  readonly fogs: readonly FogVolume[];
  readonly visibility: BspVisibility | null;
}
export interface RendererBspGeometry { readonly vertices: readonly BspVertex[]; readonly indices: readonly number[] }
interface Lump { readonly offset: number; readonly length: number }
type FogParameters = NonNullable<ShaderDefinition["fog"]>;
interface SurfaceLoadServices {
  findShader(shader: BspShader, lightmap: number): Promise<MaterialRecord>;
  readonly defaultMaterial: MaterialRecord;
  profile(): RendererBspSettings;
  colorShift(): number;
}

class BspAllocation {
  private readonly data: Uint8Array;
  private readonly dataView: DataView;
  constructor(private readonly hunk: HunkAllocation | null, length: number) {
    this.data = hunk === null ? new Uint8Array(length) : hunk.bytes;
    this.dataView = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
  get bytes(): Uint8Array { return this.hunk === null ? this.data : this.hunk.bytes; }
  get view(): DataView { void this.bytes; return this.dataView; }
  get address(): number { return this.hunk?.byteOffset ?? 0; }
}

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Renderer BSP index ${index} outside ${values.length}`);
  return value;
}
function cells<T>(count: number, read: (index: number) => T): T[] {
  const result: T[] = [];
  for (let index = 0; index < count; index++) Object.defineProperty(result, index, { enumerable: true, get: () => read(index) });
  return result;
}
function vector(block: BspAllocation, offset: number): Vec3 {
  return { get x() { return block.view.getFloat32(offset, true); },
    get y() { return block.view.getFloat32(offset + 4, true); }, get z() { return block.view.getFloat32(offset + 8, true); } };
}
function putVector(block: BspAllocation, offset: number, value: Vec3): void {
  block.view.setFloat32(offset, value.x, true); block.view.setFloat32(offset + 4, value.y, true); block.view.setFloat32(offset + 8, value.z, true);
}
function bounds(block: BspAllocation, offset: number): Bounds { return { min: vector(block, offset), max: vector(block, offset + 12) }; }
function plane(block: BspAllocation, offset: number): Plane {
  return { normal: vector(block, offset), get distance() { return block.view.getFloat32(offset + 12, true); } };
}
function putPlane(block: BspAllocation, offset: number, value: Plane): void {
  putVector(block, offset, value.normal); block.view.setFloat32(offset + 12, value.distance, true);
  block.view.setUint8(offset + 16, value.normal.x === 1 ? 0 : value.normal.y === 1 ? 1 : value.normal.z === 1 ? 2 : 3);
  block.view.setUint8(offset + 17, (value.normal.x < 0 ? 1 : 0) | (value.normal.y < 0 ? 2 : 0) | (value.normal.z < 0 ? 4 : 0));
}
function color(block: BspAllocation, offset: number): Vec4 {
  return { get x() { return block.view.getUint8(offset); }, get y() { return block.view.getUint8(offset + 1); },
    get z() { return block.view.getUint8(offset + 2); }, get w() { return block.view.getUint8(offset + 3); } };
}
function uv(block: BspAllocation, offset: number): Vec2 {
  return { get x() { return block.view.getFloat32(offset, true); }, get y() { return block.view.getFloat32(offset + 4, true); } };
}
function vertex(block: BspAllocation, offset: number, faceNormal: Vec3 | null = null): BspVertex {
  return { position: vector(block, offset), texCoord: uv(block, offset + 12), lightmapCoord: uv(block, offset + 20),
    normal: faceNormal ?? vector(block, offset + 28), color: color(block, offset + (faceNormal === null ? 40 : 28)) };
}
function shifted(red: number, green: number, blue: number, shift: number): Vec3 {
  const r = red << shift, g = green << shift, b = blue << shift;
  if ((r | g | b) <= 255) return { x: r, y: g, z: b };
  const maximum = Math.max(r, g, b);
  return { x: Math.trunc(r * 255 / maximum), y: Math.trunc(g * 255 / maximum), z: Math.trunc(b * 255 / maximum) };
}
function sourceString(bytes: Uint8Array, offset: number, limit: number): string {
  let value = "";
  for (let index = 0; index < limit; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw new RangeError("Renderer BSP string exceeds its allocation");
    if (byte === 0) return value;
    value += String.fromCharCode(byte);
  }
  return value;
}

/** Reached source reads use the retained file; published records read their own allocations. */
export class SourceBspResource {
  readonly map: RendererBspMap;
  readonly materials: MaterialRecord[] = [];
  readonly geometry: RendererBspGeometry[] = [];
  readonly patches = new Map<number, PatchGrid>();
  lightGrid: LightGrid | null = null;
  lightmapCount = 0;
  private readonly lumps: Lump[] = [];
  private readonly shaders: BspShader[] = [];
  private readonly planes: BspPlane[] = [];
  private readonly nodes: BspNode[] = [];
  private readonly leaves: RendererBspMap["leaves"][number][] = [];
  private visibilityNodes: readonly SourceBspVisibilityNode[] = [];
  private marksurfaces: readonly number[] = [];
  private readonly models: RendererBspMap["models"][number][] = [];
  private readonly surfaces: RendererBspSurface[] = [];
  private readonly surfaceDlights: ({ readonly block: Pick<BspAllocation, "view">; readonly offset: 4 | 24 } | null)[] = [];
  private readonly fogs: FogVolume[] = [];
  private readonly blocks: BspAllocation[] = [];
  private readonly registeredMaterials = new Map<number, MaterialRecord>();
  private visibility: BspVisibility | null = null;
  private novis: BspAllocation | null = null;
  private entityData: BspAllocation | null = null;
  private gridSize: Vec3 = { x: 64, y: 64, z: 128 };
  private clusters = 0;
  private surfaceData: BspAllocation | null = null;
  private file: RetainedFileBuffer | null;
  private start: BspAllocation | null = null;
  dataSize = 0;

  constructor(file: RetainedFileBuffer, readonly source: string, private readonly memory: HunkAccountingProfile,
    private readonly print: (text: string) => undefined, private readonly patchMemory: PatchMemoryProfile) {
    this.file = file;
    const resource = this;
    this.map = { get entities() { return resource.entityData === null ? "" : sourceString(resource.entityData.bytes, 0, resource.entityData.bytes.length); },
      get entityRecords() { return parseEntities(this.entities, `${source}:entities`); }, shaders: this.shaders, planes: this.planes,
      nodes: this.nodes, leaves: this.leaves, get leafSurfaces() { return resource.marksurfaces; }, models: this.models,
      surfaces: this.surfaces, fogs: this.fogs, get visibility() { return resource.visibility; } };
  }
  private allocate(call: string, length: number, suffix = ""): BspAllocation {
    const hunk = this.memory.kind === "source-hunk" ? this.memory.accounting.reserve(call, `${this.source}${suffix}`, length, "low") : null;
    const block = new BspAllocation(hunk, length);
    this.blocks.push(block);
    return block;
  }
  private bytes(offset: number, length: number): Uint8Array {
    const file = this.file;
    if (file === null) throw new Error("Renderer BSP file has already been released");
    const bytes = file.terminatedBytes;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length)
      throw new BinaryError(this.source, offset, `reached renderer read of ${length} bytes exceeds ${bytes.length}-byte file allocation`);
    return bytes.subarray(offset, offset + length);
  }
  private int(offset: number): number { const bytes = this.bytes(offset, 4); return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true); }
  private float(offset: number): number { const bytes = this.bytes(offset, 4); return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true); }
  private float3(offset: number): Vec3 { return { x: this.float(offset), y: this.float(offset + 4), z: this.float(offset + 8) }; }
  private lump(index: number): Lump { return at(this.lumps, index); }
  private count(index: number, stride: number): number {
    const lump = this.lump(index);
    if (lump.length % stride !== 0) throw new CommonError("drop", `LoadMap: funny lump size in ${this.source}`);
    if (lump.length < 0) throw new BinaryError(this.source, 12 + index * 8, "negative renderer lump allocation size");
    return lump.length / stride;
  }

  surfaceDlightBits(index: number, smpFrame: 0 | 1): number {
    const storage = at(this.surfaceDlights, index);
    return storage === null ? 0 : storage.block.view.getInt32(storage.offset + smpFrame * 4, true);
  }

  setSurfaceDlightBits(index: number, smpFrame: 0 | 1, bits: number): void {
    const storage = at(this.surfaceDlights, index);
    if (storage !== null) storage.block.view.setInt32(storage.offset + smpFrame * 4, bits, true);
  }

  get visibilityNodeCount(): number { return this.visibilityNodes.length; }
  visibilityNode(index: number): SourceBspVisibilityNode { return at(this.visibilityNodes, index); }
  get numClusters(): number { return this.clusters; }

  /** R_ClusterPVS selects a row; the consumer's byte read stays within its actual allocation. */
  clusterVisibilityByte(fromCluster: number, byteIndex: number): number {
    if (!Number.isInteger(fromCluster) || !Number.isSafeInteger(byteIndex) || byteIndex < 0)
      throw new RangeError("Renderer BSP visibility requires an integer cluster and nonnegative byte index");
    const visibility = this.visibility;
    if (visibility === null || fromCluster < 0 || fromCluster >= this.clusters) {
      const novis = this.novis;
      if (novis === null) throw new Error("Renderer BSP visibility has not been loaded");
      return at(novis.bytes, byteIndex);
    }
    const offset = fromCluster * visibility.bytesPerCluster + byteIndex;
    if (!Number.isSafeInteger(offset)) throw new RangeError("Renderer BSP visibility offset exceeds the integer range");
    return at(visibility.bits, offset);
  }

  begin(): void {
    this.start = this.allocate("RE_LoadWorldMap:startMarker", 0);
    const version = this.int(4);
    if (version !== 46) throw new CommonError("drop", `RE_LoadWorldMap: ${this.source} has wrong version number (${version} should be 46)`);
    // LittleLong's complete header walk precedes every lump consumer. IBSP is not tested here in the source.
    for (let offset = 0; offset < 144; offset += 4) void this.int(offset);
    for (let index = 0; index < 17; index++) this.lumps.push({ offset: this.int(8 + index * 8), length: this.int(12 + index * 8) });
  }

  loadShaders(): void {
    const count = this.count(1, 72), block = this.allocate("R_LoadShaders", count * 72), lump = this.lump(1);
    for (let index = 0; index < count; index++) {
      const offset = index * 72;
      this.shaders.push({ get name() { return sourceString(block.bytes, offset, block.bytes.length - offset); },
        get surfaceFlags() { return block.view.getInt32(offset + 64, true); }, get contentFlags() { return block.view.getInt32(offset + 68, true); } });
    }
    block.bytes.set(this.bytes(lump.offset, count * 72));
  }

  loadLightmaps(sync: () => void, vertexLighting: () => boolean, upload: (data: Uint8Array, index: number) => void): boolean {
    const lump = this.lump(14), lightmapBytes = 128 * 128 * 3;
    if (lump.length === 0) return false;
    sync();
    this.lightmapCount = Math.trunc(lump.length / lightmapBytes);
    const singleLightmap = this.lightmapCount === 1;
    if (singleLightmap) this.lightmapCount++;
    if (vertexLighting()) return false;
    for (let index = 0; index < this.lightmapCount; index++) {
      const offset = lump.offset + index * lightmapBytes;
      if (index >= 256) throw new BinaryError(this.source, offset, "source lightmap table capacity exceeded");
      if (singleLightmap && index === 1) {
        const file = this.file;
        if (file === null) throw new Error("Renderer BSP file has already been released");
        const available = file.terminatedBytes.length - offset;
        if (available < lightmapBytes) {
          // tr_bsp.c R_LoadLightmaps adds this image without adding file storage. Preserve known bytes; define only its out-of-allocation tail.
          const prefix = this.bytes(offset, available), data = new Uint8Array(lightmapBytes);
          data.set(prefix);
          this.print(`R_LoadLightmaps: ${this.source}: single-lightmap companion zero-filled ${lightmapBytes - available} bytes outside FS_ReadFile allocation\n`);
          upload(data, index);
          continue;
        }
      }
      upload(this.bytes(offset, lightmapBytes), index);
    }
    return true;
  }

  loadPlanes(): void {
    const count = this.count(2, 16), block = this.allocate("R_LoadPlanes", count * 2 * SOURCE_HUNK_RELEASE32.plane), lump = this.lump(2);
    for (let index = 0; index < count; index++) this.planes.push(plane(block, index * 20));
    for (let index = 0; index < count; index++) {
      const offset = lump.offset + index * 16, output = index * 20;
      for (let axis = 0; axis < 3; axis++) block.view.setFloat32(output + axis * 4, this.float(offset + axis * 4), true);
      block.view.setFloat32(output + 12, this.float(offset + 12), true);
      putPlane(block, output, plane(block, output));
    }
  }

  async loadFogs(findShader: (name: string) => Promise<FogParameters>, identityLight: number): Promise<void> {
    const count = this.count(12, 72), block = this.allocate("R_LoadFogs", (count + 1) * SOURCE_HUNK_RELEASE32.fog);
    if (count === 0) return;
    const brushCount = this.count(8, 12), sideCount = this.count(9, 8), fogLump = this.lump(12);
    for (let index = 0; index < count; index++) {
      const input = fogLump.offset + index * 72, output = (index + 1) * 72, brush = this.int(input + 64);
      block.view.setInt32(output, brush, true);
      if ((brush >>> 0) >= brushCount) throw new CommonError("drop", "fog brushNumber out of range");
      const firstSide = this.int(this.lump(8).offset + brush * 12);
      if ((firstSide >>> 0) > ((sideCount - 6) >>> 0)) throw new CommonError("drop", "fog brush sideNumber out of range");
      const sidePlane = (side: number): BspPlane => at(this.planes, this.int(this.lump(9).offset + (firstSide + side) * 8));
      for (let side = 0; side < 6; side++) {
        const distance = sidePlane(side).distance;
        block.view.setFloat32(output + 4 + Math.floor(side / 2) * 4 + (side % 2 === 0 ? 0 : 12), side % 2 === 0 ? -distance : distance, true);
      }
      const name = this.cstring(input), parameters = await findShader(name);
      putVector(block, output + 36, parameters.color); block.view.setFloat32(output + 48, parameters.depthForOpaque, true);
      const packed = (value: number): number => Math.trunc(Math.fround(Math.fround(value * identityLight) * 255)) & 255;
      block.bytes.set([packed(parameters.color.x), packed(parameters.color.y), packed(parameters.color.z), 255], output + 28);
      block.view.setFloat32(output + 32, Math.fround(1 / Math.fround(Math.max(1, parameters.depthForOpaque) * 8)), true);
      const visible = this.int(input + 68);
      block.view.setInt32(output + 52, visible === -1 ? 0 : 1, true);
      if (visible !== -1) {
        const outside = sidePlane(visible);
        putVector(block, output + 56, { x: -outside.normal.x, y: -outside.normal.y, z: -outside.normal.z });
        block.view.setFloat32(output + 68, -outside.distance, true);
      }
      const bytes = color(block, output + 28);
      this.fogs.push({ bounds: bounds(block, output + 4), get surface() { return block.view.getInt32(output + 52, true) === 0 ? null : plane(block, output + 56); },
        color: { get x() { return bytes.x / 255; }, get y() { return bytes.y / 255; }, get z() { return bytes.z / 255; }, get w() { return bytes.w / 255; } },
        get tcScale() { return block.view.getFloat32(output + 32, true); } });
    }
  }

  async loadSurfaces(services: SurfaceLoadServices): Promise<void> {
    const count = this.count(13, 104);
    this.count(10, 44); this.count(11, 4);
    const table = this.allocate("R_LoadSurfaces", count * SOURCE_HUNK_RELEASE32.surface);
    this.surfaceData = table;
    this.registeredMaterials.set(services.defaultMaterial.order, services.defaultMaterial);
    this.surfaces.length = count; this.materials.length = count; this.geometry.length = count; this.surfaceDlights.length = count;
    const counts = { planar: 0, patch: 0, triangles: 0, flare: 0 };
    for (let index = 0; index < count; index++) {
      const input = this.lump(13).offset + index * 104, output = index * 16, diskType = this.int(input + 8);
      const type = diskType === 1 ? "planar" : diskType === 2 ? "patch" : diskType === 3 ? "triangles" : diskType === 4 ? "flare" : null;
      if (type === null) throw new CommonError("drop", "Bad surfaceType");
      const lightmap = type === "planar" || type === "patch" ? this.int(input + 28) : -3;
      table.view.setInt32(output + 8, (this.int(input + 4) + 1) | 0, true);
      const shaderIndex = this.int(input);
      if (shaderIndex < 0 || shaderIndex >= this.shaders.length) throw new CommonError("drop", `ShaderForShaderNum: bad num ${shaderIndex}`);
      const shader = at(this.shaders, shaderIndex);
      let material = await services.findShader(shader, lightmap);
      if (services.profile().singleShader && material.definition?.sky == null) material = services.defaultMaterial;
      this.registeredMaterials.set(material.order, material);
      table.view.setInt32(output + 4, material.order, true);
      Object.defineProperty(this.materials, index, { enumerable: true, get: () => {
        const registered = this.registeredMaterials.get(table.view.getInt32(output + 4, true));
        if (registered === undefined) throw new Error("BSP surface references an unregistered shader");
        return registered;
      } });
      const shared = { shader: shaderIndex, get fog() { return table.view.getInt32(output + 8, true) - 1; } };
      if (type === "patch") {
        this.surfaces[index] = { ...shared, type };
        this.surfaceDlights[index] = null;
        if ((shader.surfaceFlags & 0x80) !== 0) this.geometry[index] = { vertices: [], indices: [] };
        else {
          const width = this.int(input + 96), height = this.int(input + 100), firstVertex = this.int(input + 12), points: BspVertex[] = [];
          if (width < 0 || height < 0 || width * height > 32 * 32) throw new BinaryError(this.source, input + 96, "patch control points exceed source temporary allocation");
          for (let point = 0; point < width * height; point++) points.push(this.drawVertex(firstVertex + point, services.colorShift()));
          const mesh = TemporaryPatchMesh.create(tessellatePatch(points, width, height, services.profile().subdivisions), this.patchMemory);
          this.geometry[index] = mesh;
          this.surfaceDlights[index] = { block: mesh.block, offset: 4 };
          table.view.setInt32(output + 12, mesh.block.address, true);
          this.patches.set(index, createPatchGrid(mesh, [this.float3(input + 60), this.float3(input + 72)]));
        }
      } else if (type === "flare") {
        const block = this.allocate("ParseFlare", SOURCE_HUNK_RELEASE32.flare, `#${index}`);
        block.view.setInt32(0, 8, true); table.view.setInt32(output + 12, block.address, true);
        this.surfaces[index] = { ...shared, type }; this.geometry[index] = { vertices: [], indices: [] };
        this.surfaceDlights[index] = null;
        for (let axis = 0; axis < 3; axis++) {
          block.view.setFloat32(4 + axis * 4, this.float(input + 48 + axis * 4), true);
          block.view.setFloat32(28 + axis * 4, this.float(input + 60 + axis * 4), true);
          block.view.setFloat32(16 + axis * 4, this.float(input + 84 + axis * 4), true);
        }
      } else {
        let vertexCount = this.int(input + 16);
        if (type === "planar" && vertexCount > 64) {
          this.print(`WARNING: MAX_FACE_POINTS exceeded: ${vertexCount}\n`); vertexCount = 64;
          table.view.setInt32(output + 4, services.defaultMaterial.order, true);
        }
        const indexCount = this.int(input + 24), vertexOffset = type === "planar" ? 44 : 68, stride = type === "planar" ? 32 : 44;
        const indexOffset = vertexOffset + vertexCount * stride;
        const block = this.allocate(type === "planar" ? "ParseFace" : "ParseTriSurf", indexOffset + indexCount * 4, `#${index}`);
        this.surfaceDlights[index] = { block, offset: type === "planar" ? 24 : 4 };
        block.view.setInt32(0, type === "planar" ? 2 : 4, true);
        if (type === "planar") {
          block.view.setInt32(32, vertexCount, true); block.view.setInt32(36, indexCount, true); block.view.setInt32(40, indexOffset, true);
        } else {
          block.view.setInt32(52, indexCount, true); block.view.setInt32(56, block.address + indexOffset, true);
          block.view.setInt32(60, vertexCount, true); block.view.setInt32(64, block.address + vertexOffset, true);
          table.view.setInt32(output + 12, block.address, true);
          this.surfaces[index] = { ...shared, type };
          putVector(block, 12, vec3(99999, 99999, 99999)); putVector(block, 24, vec3(-99999, -99999, -99999));
        }
        const firstVertex = this.int(input + 12);
        for (let point = 0; point < vertexCount; point++) {
          const disk = this.lump(10).offset + (firstVertex + point) * 44, dest = vertexOffset + point * stride;
          if (type === "planar") {
            for (let field = 0; field < 3; field++) block.view.setFloat32(dest + field * 4, this.float(disk + field * 4), true);
            for (let field = 0; field < 2; field++) {
              block.view.setFloat32(dest + 12 + field * 4, this.float(disk + 12 + field * 4), true);
              block.view.setFloat32(dest + 20 + field * 4, this.float(disk + 20 + field * 4), true);
            }
            this.copyColor(disk + 40, block, dest + 28, services.colorShift());
          } else {
            for (let axis = 0; axis < 3; axis++) {
              const value = this.float(disk + axis * 4);
              block.view.setFloat32(dest + axis * 4, value, true);
              block.view.setFloat32(dest + 28 + axis * 4, this.float(disk + 28 + axis * 4), true);
            }
            for (let axis = 0; axis < 3; axis++) {
              const value = block.view.getFloat32(dest + axis * 4, true);
              if (value < block.view.getFloat32(12 + axis * 4, true)) block.view.setFloat32(12 + axis * 4, value, true);
              if (value > block.view.getFloat32(24 + axis * 4, true)) block.view.setFloat32(24 + axis * 4, value, true);
            }
            for (let axis = 0; axis < 2; axis++) {
              block.view.setFloat32(dest + 12 + axis * 4, this.float(disk + 12 + axis * 4), true);
              block.view.setFloat32(dest + 20 + axis * 4, this.float(disk + 20 + axis * 4), true);
            }
            this.copyColor(disk + 40, block, dest + 40, services.colorShift());
          }
        }
        const firstIndex = this.int(input + 20);
        for (let item = 0; item < indexCount; item++) {
          const value = this.int(this.lump(11).offset + (firstIndex + item) * 4);
          block.view.setInt32(indexOffset + item * 4, value, true);
          if (type === "triangles" && (value < 0 || value >= vertexCount)) throw new CommonError("drop", "Bad index in triangle surface");
        }
        const face = type === "planar" ? plane(block, 4) : null;
        if (face !== null) {
          for (let axis = 0; axis < 3; axis++) block.view.setFloat32(4 + axis * 4, this.float(input + 84 + axis * 4), true);
          putPlane(block, 4, { normal: face.normal, distance: dot3(vector(block, vertexOffset), face.normal) });
          this.surfaces[index] = { ...shared, type: "planar", plane: face };
          table.view.setInt32(output + 12, block.address, true);
        }
        this.geometry[index] = { vertices: Array.from({ length: vertexCount }, (_, point) => vertex(block, vertexOffset + point * stride, face?.normal ?? null)),
          indices: cells(indexCount, item => block.view.getInt32(indexOffset + item * 4, true)) };
      }
      const surface = at(this.surfaces, index);
      Object.defineProperty(surface, "fog", { enumerable: true, get: () => table.view.getInt32(output + 8, true) - 1 });
      counts[type]++;
    }
    this.movePatchSurfaces();
    this.print(`...loaded ${counts.planar} faces, ${counts.patch} meshes, ${counts.triangles} trisurfs, ${counts.flare} flares\n`);
  }

  private copyColor(input: number, block: BspAllocation, output: number, shift: number): void {
    const bytes = this.bytes(input, 4), rgb = shifted(at(bytes, 0), at(bytes, 1), at(bytes, 2), shift);
    block.bytes.set([rgb.x, rgb.y, rgb.z, at(bytes, 3)], output);
  }
  private drawVertex(index: number, shift: number): BspVertex {
    const offset = this.lump(10).offset + index * 44, position = { x: 0, y: 0, z: 0 }, normal = { x: 0, y: 0, z: 0 };
    for (const [axis, word] of [["x", 0], ["y", 1], ["z", 2]] satisfies readonly (readonly [keyof Vec3, number])[]) {
      position[axis] = this.float(offset + word * 4); normal[axis] = this.float(offset + 28 + word * 4);
    }
    const texCoord = { x: this.float(offset + 12), y: this.float(offset + 16) };
    const lightmapCoord = { x: this.float(offset + 20), y: this.float(offset + 24) }, bytes = this.bytes(offset + 40, 4);
    const rgb = shifted(at(bytes, 0), at(bytes, 1), at(bytes, 2), shift);
    return { position, normal, texCoord, lightmapCoord, color: { ...rgb, w: at(bytes, 3) } };
  }

  private movePatchSurfaces(): void {
    const surfaceIndices = [...this.patches.keys()];
    const table = this.surfaceData;
    if (table === null) throw new Error("Patch hunk move requires the loaded surface allocation");
    const grids = preparePatchGrids([...this.patches.values()], count => { this.print(`stitched ${count} LoD cracks\n`); }, (index, grid) => {
      const surfaceIndex = at(surfaceIndices, index), mesh = grid.mesh;
      if (!(mesh instanceof TemporaryPatchMesh)) throw new Error("Patch stitching requires its temporary source allocation");
      this.patches.set(surfaceIndex, grid); this.geometry[surfaceIndex] = mesh;
      this.surfaceDlights[surfaceIndex] = { block: mesh.block, offset: 4 };
      table.view.setInt32(surfaceIndex * 16 + 12, mesh.block.address, true);
    });
    for (const [index, surfaceIndex] of surfaceIndices.entries()) {
      const grid = at(grids, index), mesh = grid.mesh, suffix = `#${surfaceIndex}`;
      if (!(mesh instanceof TemporaryPatchMesh)) throw new Error("Patch hunk move requires its temporary source allocation");
      const owned = mesh.moveToHunk((call, length) => this.allocate(call, length, suffix)), block = owned.block;
      this.patches.set(surfaceIndex, owned); this.geometry[surfaceIndex] = owned.mesh;
      this.surfaceDlights[surfaceIndex] = { block, offset: 4 };
      table.view.setInt32(surfaceIndex * 16 + 12, block.address, true);
    }
  }

  loadMarksurfaces(): void {
    const count = this.count(5, 4), block = this.allocate("R_LoadMarksurfaces", count * 4);
    this.marksurfaces = cells(count, index => block.view.getInt32(index * 4, true));
    for (let index = 0; index < count; index++) block.view.setInt32(index * 4, this.int(this.lump(5).offset + index * 4), true);
  }

  loadNodesAndLeafs(): void {
    const nodeCount = this.count(3, 36), leafCount = this.count(4, 48), block = this.allocate("R_LoadNodesAndLeafs", (nodeCount + leafCount) * 64);
    this.visibilityNodes = Array.from({ length: nodeCount + leafCount }, (_, index): SourceBspVisibilityNode => {
      const offset = index * 64;
      // Source-zeroed parent pointers use the typed index profile's null encoding.
      block.view.setInt32(offset + 32, -1, true);
      return {
        get contents() { return block.view.getInt32(offset, true); },
        get parent() { const parent = block.view.getInt32(offset + 32, true); return parent === -1 ? null : parent; },
        get cluster() { return block.view.getInt32(offset + 48, true); },
        get area() { return block.view.getInt32(offset + 52, true); },
        get visFrame() { return block.view.getInt32(offset + 4, true); },
        set visFrame(value: number) { block.view.setInt32(offset + 4, value, true); },
      };
    });
    for (let index = 0; index < nodeCount; index++) {
      const input = this.lump(3).offset + index * 36, output = index * 64;
      this.nodes.push({ bounds: bounds(block, output + 8), get plane() { return block.view.getInt32(output + 36, true); },
        get children(): readonly [number, number] { return [block.view.getInt32(output + 40, true), block.view.getInt32(output + 44, true)]; } });
      for (let axis = 0; axis < 3; axis++) {
        block.view.setFloat32(output + 8 + axis * 4, this.int(input + 12 + axis * 4), true);
        block.view.setFloat32(output + 20 + axis * 4, this.int(input + 24 + axis * 4), true);
      }
      block.view.setInt32(output + 36, this.int(input), true); block.view.setInt32(output, -1, true);
      block.view.setInt32(output + 40, this.int(input + 4), true); block.view.setInt32(output + 44, this.int(input + 8), true);
    }
    for (let index = 0; index < leafCount; index++) {
      const input = this.lump(4).offset + index * 48, output = (nodeCount + index) * 64;
      this.leaves.push({ bounds: bounds(block, output + 8), get cluster() { return block.view.getInt32(output + 48, true); },
        get area() { return block.view.getInt32(output + 52, true); }, get firstSurface() { return block.view.getInt32(output + 56, true); },
        get surfaceCount() { return block.view.getInt32(output + 60, true); } });
      for (let axis = 0; axis < 3; axis++) {
        block.view.setFloat32(output + 8 + axis * 4, this.int(input + 8 + axis * 4), true);
        block.view.setFloat32(output + 20 + axis * 4, this.int(input + 20 + axis * 4), true);
      }
      const cluster = this.int(input);
      block.view.setInt32(output + 48, cluster, true); block.view.setInt32(output + 52, this.int(input + 4), true);
      if (cluster >= this.clusters) this.clusters = (cluster + 1) | 0;
      block.view.setInt32(output + 56, this.int(input + 32), true); block.view.setInt32(output + 60, this.int(input + 36), true);
    }
    const visiting = new Set<number>(), pending = [{ index: 0, parent: -1, exit: false }];
    while (pending.length !== 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current.exit) { visiting.delete(current.index); continue; }
      const index = current.index < 0 ? nodeCount - 1 - current.index : current.index;
      if (index < 0 || index >= nodeCount + leafCount) throw new BinaryError(this.source, this.lump(3).offset, "R_SetParent reached an out-of-range node");
      block.view.setInt32(index * 64 + 32, current.parent, true);
      if (index >= nodeCount) continue;
      if (visiting.has(index)) throw new BinaryError(this.source, this.lump(3).offset + index * 36, "R_SetParent reached a BSP node cycle");
      visiting.add(index);
      const node = at(this.nodes, index);
      pending.push({ ...current, exit: true }, { index: node.children[1], parent: index, exit: false }, { index: node.children[0], parent: index, exit: false });
    }
  }

  loadSubmodels(publish: (index: number) => void): void {
    const count = this.count(7, 40), block = this.allocate("R_LoadSubmodels", count * SOURCE_HUNK_RELEASE32.brushModel);
    for (let index = 0; index < count; index++) {
      const input = this.lump(7).offset + index * 40, output = index * 32;
      this.models.push({ bounds: bounds(block, output), get firstSurface() { return block.view.getInt32(output + 24, true); },
        get surfaceCount() { return block.view.getInt32(output + 28, true); } });
      publish(index);
      for (let axis = 0; axis < 3; axis++) {
        block.view.setFloat32(output + axis * 4, this.float(input + axis * 4), true);
        block.view.setFloat32(output + 12 + axis * 4, this.float(input + 12 + axis * 4), true);
      }
      block.view.setInt32(output + 24, this.int(input + 24), true); block.view.setInt32(output + 28, this.int(input + 28), true);
    }
  }

  loadVisibility(externalVisData: () => Uint8Array | null): void {
    this.novis = this.allocate("R_LoadVisibility:novis", (this.clusters + 63) & ~63);
    this.novis.bytes.fill(255);
    const lump = this.lump(16);
    if (lump.length === 0) return;
    this.clusters = this.int(lump.offset);
    const clusterCount = this.clusters, bytesPerCluster = this.int(lump.offset + 4);
    const external = externalVisData();
    if (external !== null) this.visibility = { clusterCount, bytesPerCluster, bits: external };
    else {
      const block = this.allocate("R_LoadVisibility", lump.length - 8);
      block.bytes.set(this.bytes(lump.offset + 8, lump.length - 8));
      this.visibility = { clusterCount, bytesPerCluster, get bits() { return block.bytes; } };
    }
  }

  private cstring(offset: number): string {
    let result = "";
    for (let index = offset; ; index++) {
      const value = this.bytes(index, 1)[0];
      if (value === undefined) throw new BinaryError(this.source, index, "missing source string byte");
      if (value === 0) return result;
      result += String.fromCharCode(value);
    }
  }
  async loadEntities(publish: (text: string) => void, remap: (original: string, replacement: string) => Promise<void>, vertexLighting: () => boolean): Promise<void> {
    this.gridSize = { x: 64, y: 64, z: 128 };
    const lump = this.lump(0), block = this.allocate("R_LoadEntities", lump.length + 1);
    this.entityData = block;
    let index = 0;
    for (;; index++) {
      const byte = this.bytes(lump.offset + index, 1)[0];
      if (byte === undefined) throw new BinaryError(this.source, lump.offset + index, "missing entity string byte");
      if (index >= block.bytes.length) throw new BinaryError(this.source, lump.offset + index, "entity strcpy exceeds the source allocation");
      block.bytes[index] = byte;
      if (byte === 0) break;
    }
    const text = this.map.entities;
    publish(text);
    const parser = new CommonParseState(), cursor = new CommonParseCursor(text);
    const first = parser.parse(cursor, true);
    if (first.length === 0 || first[0] !== "{") return;
    for (;;) {
      const key = parser.parse(cursor, true).slice(0, 1023);
      if (key.length === 0 || key[0] === "}") break;
      const value = parser.parse(cursor, true).slice(0, 1023);
      if (value.length === 0 || value[0] === "}") break;
      const vertexRemap = key.startsWith("vertexremapshader"), ordinaryRemap = key.startsWith("remapshader");
      if (vertexRemap || ordinaryRemap) {
        const semicolon = value.indexOf(";");
        if (semicolon < 0) { this.print(`WARNING: no semi colon in ${vertexRemap ? "vertexshaderremap" : "shaderremap"} '${value}'\n`); break; }
        if (!vertexRemap || vertexLighting()) await remap(value.slice(0, semicolon), value.slice(semicolon + 1));
      } else if (key.toLowerCase() === "gridsize") this.readGridSize(value);
    }
  }
  private readGridSize(value: string): void {
    const size = { ...this.gridSize };
    for (const axis of ["x", "y", "z"] satisfies readonly (keyof Vec3)[]) {
      const match = /^\s*[+-]?(?:0x(?:[\da-f]+\.?[\da-f]*|\.[\da-f]+)(?:p[+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|infinity|inf|nan)/i.exec(value);
      if (match === null) break;
      const token = match[0].trim().toLowerCase();
      if (/^[+-]?0x/.test(token)) {
        const exponentIndex = token.indexOf("p"), mantissa = (exponentIndex < 0 ? token : token.slice(0, exponentIndex)).replace(/^[+-]?0x/, "");
        const exponent = exponentIndex < 0 ? 0 : Number.parseInt(token.slice(exponentIndex + 1), 10), dot = mantissa.indexOf(".");
        size[axis] = Math.fround((token.startsWith("-") ? -1 : 1) * Number.parseInt(mantissa.replace(".", ""), 16) * 2 ** (exponent - (dot < 0 ? 0 : mantissa.length - dot - 1) * 4));
      } else size[axis] = /^[+-]?inf/.test(token) ? token.startsWith("-") ? -Infinity : Infinity : Math.fround(Number.parseFloat(token));
      value = value.slice(match[0].length);
    }
    this.gridSize = size;
  }

  loadLightGrid(shift: number): void {
    const world = at(this.models, 0), size = this.gridSize, origin = { x: 0, y: 0, z: 0 }, counts = { x: 0, y: 0, z: 0 };
    const inverseSize = vec3(1 / size.x, 1 / size.y, 1 / size.z);
    for (const axis of ["x", "y", "z"] satisfies readonly (keyof Vec3)[]) {
      origin[axis] = Math.fround(size[axis] * Math.ceil(Math.fround(world.bounds.min[axis] / size[axis])));
      const end = Math.fround(size[axis] * Math.floor(Math.fround(world.bounds.max[axis] / size[axis])));
      const bound = Math.fround(Math.fround(Math.fround(end - origin[axis]) / size[axis]) + 1);
      if (!Number.isFinite(bound) || bound < -0x80000000 || bound >= 0x80000000)
        throw new BinaryError(this.source, this.lump(15).offset, "light-grid bounds require an undefined source float-to-int conversion");
      counts[axis] = Math.trunc(bound);
    }
    const count = Math.imul(Math.imul(counts.x, counts.y), counts.z), lump = this.lump(15);
    if (lump.length !== Math.imul(count, 8)) { this.print("WARNING: light grid mismatch\n"); this.lightGrid = null; return; }
    const block = this.allocate("R_LoadLightGrid", lump.length);
    block.bytes.set(this.bytes(lump.offset, lump.length));
    this.lightGrid = { origin, size, inverseSize, bounds: counts, samples: Array.from({ length: count }, (_, index) => {
      const offset = index * 8;
      return { ambient: { get x() { return block.view.getUint8(offset); }, get y() { return block.view.getUint8(offset + 1); }, get z() { return block.view.getUint8(offset + 2); } },
        directed: { get x() { return block.view.getUint8(offset + 3); }, get y() { return block.view.getUint8(offset + 4); }, get z() { return block.view.getUint8(offset + 5); } },
        latLong: { get x() { return block.view.getUint8(offset + 6); }, get y() { return block.view.getUint8(offset + 7); } } };
    }) };
    for (let index = 0; index < count; index++) for (const offset of [index * 8, index * 8 + 3]) {
      const rgb = shifted(block.view.getUint8(offset), block.view.getUint8(offset + 1), block.view.getUint8(offset + 2), shift);
      block.bytes.set([rgb.x, rgb.y, rgb.z], offset);
    }
  }

  finish(): void {
    const end = this.allocate("RE_LoadWorldMap:endMarker", 0);
    if (this.start === null) throw new Error("Renderer BSP start marker was not allocated");
    this.dataSize = end.address - this.start.address;
    this.file = null;
  }
}
