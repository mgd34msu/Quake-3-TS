// CM_LoadMap records from id Software's code/qcommon/cm_load.c and cm_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { BspMap, BspShader } from "../assets/bsp.ts";
import { BinaryError } from "../core/binary.ts";
import { CommonError } from "../core/common-error.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import { add3, sub3, vec3 } from "../core/math.ts";
import type { Bounds, Plane, Vec3 } from "../core/math.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import { SOURCE_HUNK_RELEASE32 } from "../render/hunk-accounting.ts";
import { generatePatchCollide } from "./patch.ts";
import type { CollisionDebugSurface, PatchCollide } from "./patch.ts";

export interface CollisionPlane extends Plane { readonly type: number; readonly signbits: number }
export interface CollisionNode { readonly plane: number; readonly children: readonly [number, number] }
export interface CollisionLeaf {
  readonly cluster: number; readonly area: number;
  readonly firstBrush: number; readonly brushCount: number;
  readonly firstSurface: number; readonly surfaceCount: number;
}
export interface CollisionIndexes { readonly length: number; at(index: number): number }
export interface CollisionModel {
  readonly bounds: Bounds; readonly brushes: CollisionIndexes; readonly surfaces: CollisionIndexes;
}
export interface CollisionBrush {
  readonly shader: number; readonly contents: number; readonly bounds: Bounds;
  readonly firstSide: number; readonly sideCount: number;
  checkCount: number;
}
export interface CollisionBrushSide { readonly plane: number; readonly shader: number; readonly surfaceFlags: number }
export interface CollisionPatch { readonly contents: number; readonly surfaceFlags: number; readonly collide: PatchCollide; checkCount: number }
export interface CollisionArea { flood: number; floodValid: number }
export interface CollisionPortalCounts { at(index: number): number; set(index: number, value: number): void }
export interface CollisionBoxStorage {
  readonly bounds: Bounds; readonly brush: CollisionBrush; readonly checkCount: number;
  readSide(index: number): { readonly plane: CollisionPlane; readonly surfaceFlags: number };
  setBounds(mins: Vec3, maxs: Vec3, capsule: boolean): void;
}

/** Unlike clipMap_t, the source's static box_model survives CM_ClearMap. */
export class CollisionBoxModel {
  bounds: Bounds = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
}

/** CM consumers borrow these records. The asset parser remains a separate diagnostic reader. */
export interface CollisionMapData {
  readonly kind: "collision-map";
  checkCount: number;
  readonly entities: string;
  readonly shaders: readonly BspShader[];
  readonly planes: readonly CollisionPlane[];
  readonly nodes: readonly CollisionNode[];
  readonly leaves: readonly CollisionLeaf[];
  readonly leafBrushes: CollisionIndexes;
  readonly leafSurfaces: CollisionIndexes;
  readonly brushes: readonly CollisionBrush[];
  readonly brushSides: readonly CollisionBrushSide[];
  readonly models: readonly CollisionModel[];
  patch(index: number): CollisionPatch | null;
  readonly areas: readonly CollisionArea[];
  readonly portals: CollisionPortalCounts;
  readonly clusterCount: number;
  readonly visibility: Uint8Array;
  readonly visibilityRowBytes: number | null;
  readonly box: CollisionBoxStorage | null;
}

interface Lump { readonly offset: number; readonly length: number }

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`CM source record ${index} outside allocation`);
  return value;
}
function indexOffset(index: number, stride: number, length: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`CM source index ${index} outside allocation of ${length} records`);
  }
  return index * stride;
}
function pointer(base: HunkAllocation, index: number, stride: number): number {
  const address = base.byteOffset + index * stride;
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) {
    throw new RangeError("CM source pointer exceeds the 32-bit address space");
  }
  return address;
}
const recordViews = new WeakMap<HunkAllocation, { bytes: Uint8Array; view: DataView }>();
function recordView(allocation: HunkAllocation): DataView {
  const bytes = allocation.bytes;
  const cached = recordViews.get(allocation);
  if (cached !== undefined && cached.bytes === bytes) return cached.view;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  recordViews.set(allocation, { bytes, view });
  return view;
}
function vector(allocation: HunkAllocation, offset: number): Vec3 {
  return {
    get x(): number { return recordView(allocation).getFloat32(offset, true); },
    get y(): number { return recordView(allocation).getFloat32(offset + 4, true); },
    get z(): number { return recordView(allocation).getFloat32(offset + 8, true); },
  };
}
function bounds(allocation: HunkAllocation, offset: number): Bounds {
  return { min: vector(allocation, offset), max: vector(allocation, offset + 12) };
}
function cstring(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw new RangeError("CM string outside allocation");
    if (byte === 0) return result;
    result += String.fromCharCode(byte);
  }
  throw new RangeError("CM string has no terminator inside its allocation");
}
function indexes(allocation: HunkAllocation, count: number): CollisionIndexes {
  return { length: count, at(index: number): number {
    return recordView(allocation).getInt32(indexOffset(index, 4, count), true);
  } };
}
function plane(allocation: HunkAllocation, index: number): CollisionPlane {
  const offset = index * 20;
  return {
    normal: vector(allocation, offset),
    get distance(): number { return recordView(allocation).getFloat32(offset + 12, true); },
    get type(): number { return recordView(allocation).getUint8(offset + 16); },
    get signbits(): number { return recordView(allocation).getUint8(offset + 17); },
  };
}
function emptyIndexes(): CollisionIndexes {
  return { length: 0, at(index: number): never { throw new RangeError(`CM unloaded index ${index}`); } };
}

/** A source load mutates its reached allocations in place and keeps them after a source abort. */
export class CollisionMapResource implements CollisionMapData {
  readonly kind = "collision-map";
  checkCount = 0;
  shaders: readonly BspShader[] = [];
  planes: readonly CollisionPlane[] = [];
  nodes: readonly CollisionNode[] = [];
  leaves: readonly CollisionLeaf[] = [];
  leafBrushes: CollisionIndexes = emptyIndexes();
  leafSurfaces: CollisionIndexes = emptyIndexes();
  brushes: readonly CollisionBrush[] = [];
  brushSides: readonly CollisionBrushSide[] = [];
  models: readonly CollisionModel[] = [];
  private readonly patches = new Map<number, CollisionPatch>();
  areas: readonly CollisionArea[] = [];
  portals: CollisionPortalCounts = { at(index: number): never { throw new RangeError(`CM unloaded portal ${index}`); },
    set(index: number): never { throw new RangeError(`CM unloaded portal ${index}`); } };
  clusterCount = 0;
  visibilityRowBytes: number | null = null;
  box: CollisionBoxStorage | null = null;
  private entityAllocation: HunkAllocation | null = null;
  private visibilityAllocation: HunkAllocation | null = null;
  private surfaceAllocation: HunkAllocation | null = null;
  private planeAllocation: HunkAllocation | null = null;
  private sideAllocation: HunkAllocation | null = null;
  private brushAllocation: HunkAllocation | null = null;
  private leafBrushAllocation: HunkAllocation | null = null;
  private numPlanes = 0;
  private numSides = 0;
  private numBrushes = 0;
  private numLeafBrushes = 0;
  private diagnosticOffset = 32;

  constructor(private readonly source: string, private readonly memory: HunkAccountingProfile,
    private readonly debug: CollisionDebugSurface | null, private readonly boxModel = new CollisionBoxModel()) {}

  get entities(): string {
    const allocation = this.entityAllocation;
    if (allocation === null) throw new Error("CM entity string has not been loaded");
    return cstring(allocation.bytes, 0, allocation.byteLength);
  }
  get visibility(): Uint8Array {
    if (this.visibilityAllocation === null) throw new Error("CM visibility has not been loaded");
    return this.visibilityAllocation.bytes;
  }
  patch(index: number): CollisionPatch | null {
    const allocation = this.surfaceAllocation;
    if (allocation === null) throw new Error("CM surfaces have not been loaded");
    const pointer = recordView(allocation).getUint32(indexOffset(index, 4, allocation.byteLength / 4), true);
    if (pointer === 0) return null;
    const patch = this.patches.get(pointer);
    if (patch === undefined) throw new RangeError("CM patch pointer outside source allocation");
    return patch;
  }

  private allocate(source: string, bytes: number, resource = this.source): HunkAllocation {
    if (this.memory.kind === "source-hunk") return this.memory.accounting.reserve(source, resource, bytes, "high");
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0x7fffffff) throw new RangeError("Invalid CM allocation size");
    const byteOffset = this.diagnosticOffset;
    this.diagnosticOffset += Math.ceil(bytes / 32) * 32;
    return { kind: "permanent", byteOffset, byteLength: bytes, bytes: new Uint8Array(bytes) };
  }

  load(raw: Uint8Array): void {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const range = (offset: number, length: number): void => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > raw.length - length) {
        throw new BinaryError(this.source, offset, `CM source read of ${length} bytes outside ${raw.length}-byte file`);
      }
    };
    const int = (offset: number): number => { range(offset, 4); return view.getInt32(offset, true); };
    const float = (offset: number): number => { range(offset, 4); return view.getFloat32(offset, true); };
    const copy = (allocation: HunkAllocation, offset: number, length: number): void => {
      range(offset, length); allocation.bytes.set(raw.subarray(offset, offset + length));
    };
    range(0, 144);
    const version = int(4);
    const lumps: Lump[] = Array.from({ length: 17 }, (_, index) => ({ offset: int(8 + index * 8), length: int(12 + index * 8) }));
    if (version !== 46) throw new CommonError("drop", `CM_LoadMap: ${this.source} has wrong version number (${version} should be 46)`);
    const lump = (index: number): Lump => at(lumps, index);
    const count = (section: Lump, stride: number, message = "MOD_LoadBmodel: funny lump size"): number => {
      if (section.length % stride !== 0) throw new CommonError("drop", message);
      return section.length / stride;
    };
    const sizes = SOURCE_HUNK_RELEASE32;

    const shaderLump = lump(1), shaderCount = count(shaderLump, 72, "CMod_LoadShaders: funny lump size");
    if (shaderCount < 1) throw new CommonError("drop", "Map with no shaders");
    const shaderAllocation = this.allocate("CMod_LoadShaders", shaderCount * sizes.diskShader);
    this.shaders = Array.from({ length: shaderCount }, (_, index) => ({
      get name(): string { return cstring(shaderAllocation.bytes, index * 72, 64); },
      get surfaceFlags(): number { return recordView(shaderAllocation).getInt32(index * 72 + 64, true); },
      get contentFlags(): number { return recordView(shaderAllocation).getInt32(index * 72 + 68, true); },
    }));
    copy(shaderAllocation, shaderLump.offset, shaderLump.length);

    const leafLump = lump(4), leafCount = count(leafLump, 48);
    if (leafCount < 1) throw new CommonError("drop", "Map with no leafs");
    const leafAllocation = this.allocate("CMod_LoadLeafs:leafs", (leafCount + 2) * sizes.leaf);
    this.leaves = Array.from({ length: leafCount }, (_, index) => ({
      get cluster(): number { return recordView(leafAllocation).getInt32(index * 24, true); },
      get area(): number { return recordView(leafAllocation).getInt32(index * 24 + 4, true); },
      get firstBrush(): number { return recordView(leafAllocation).getInt32(index * 24 + 8, true); },
      get brushCount(): number { return recordView(leafAllocation).getInt32(index * 24 + 12, true); },
      get firstSurface(): number { return recordView(leafAllocation).getInt32(index * 24 + 16, true); },
      get surfaceCount(): number { return recordView(leafAllocation).getInt32(index * 24 + 20, true); },
    }));
    let areaCount = 0;
    for (let index = 0; index < leafCount; index++) {
      const input = leafLump.offset + index * 48, output = index * 24, target = recordView(leafAllocation);
      target.setInt32(output, int(input), true);
      target.setInt32(output + 4, int(input + 4), true);
      target.setInt32(output + 8, int(input + 40), true);
      target.setInt32(output + 12, int(input + 44), true);
      target.setInt32(output + 16, int(input + 32), true);
      target.setInt32(output + 20, int(input + 36), true);
      const leaf = at(this.leaves, index);
      if (leaf.cluster >= this.clusterCount) this.clusterCount = (leaf.cluster + 1) | 0;
      if (leaf.area >= areaCount) areaCount = (leaf.area + 1) | 0;
    }
    const areaAllocation = this.allocate("CMod_LoadLeafs:areas", areaCount * sizes.area);
    this.areas = Array.from({ length: areaCount }, (_, index) => ({
      get flood(): number { return recordView(areaAllocation).getInt32(index * 8, true); },
      set flood(value: number) { recordView(areaAllocation).setInt32(index * 8, value, true); },
      get floodValid(): number { return recordView(areaAllocation).getInt32(index * 8 + 4, true); },
      set floodValid(value: number) { recordView(areaAllocation).setInt32(index * 8 + 4, value, true); },
    }));
    const portalAllocation = this.allocate("CMod_LoadLeafs:areaPortals", areaCount * areaCount * 4);
    this.portals = {
      at(index: number): number { return recordView(portalAllocation).getInt32(indexOffset(index, 4, areaCount * areaCount), true); },
      set(index: number, value: number): void { recordView(portalAllocation).setInt32(indexOffset(index, 4, areaCount * areaCount), value, true); },
    };

    const leafBrushLump = lump(6);
    this.numLeafBrushes = count(leafBrushLump, 4);
    const leafBrushAllocation = this.allocate("CMod_LoadLeafBrushes", (this.numLeafBrushes + 1) * 4);
    this.leafBrushAllocation = leafBrushAllocation;
    this.leafBrushes = indexes(leafBrushAllocation, this.numLeafBrushes + 1);
    for (let index = 0; index < this.numLeafBrushes; index++) recordView(leafBrushAllocation).setInt32(index * 4, int(leafBrushLump.offset + index * 4), true);

    const leafSurfaceLump = lump(5), leafSurfaceCount = count(leafSurfaceLump, 4);
    const leafSurfaceAllocation = this.allocate("CMod_LoadLeafSurfaces", leafSurfaceCount * 4);
    this.leafSurfaces = indexes(leafSurfaceAllocation, leafSurfaceCount);
    for (let index = 0; index < leafSurfaceCount; index++) recordView(leafSurfaceAllocation).setInt32(index * 4, int(leafSurfaceLump.offset + index * 4), true);

    const planeLump = lump(2);
    this.numPlanes = count(planeLump, 16);
    if (this.numPlanes < 1) throw new CommonError("drop", "Map with no planes");
    const planeAllocation = this.allocate("CMod_LoadPlanes", (this.numPlanes + 12) * sizes.plane);
    this.planeAllocation = planeAllocation;
    this.planes = Array.from({ length: this.numPlanes + 12 }, (_, index) => plane(planeAllocation, index));
    for (let index = 0; index < this.numPlanes; index++) {
      const input = planeLump.offset + index * 16, output = index * 20, target = recordView(planeAllocation);
      let signs = 0;
      for (let axis = 0; axis < 3; axis++) {
        const value = float(input + axis * 4);
        target.setFloat32(output + axis * 4, value, true);
        if (value < 0) signs |= 1 << axis;
      }
      target.setFloat32(output + 12, float(input + 12), true);
      const normal = at(this.planes, index).normal;
      target.setUint8(output + 16, normal.x === 1 ? 0 : normal.y === 1 ? 1 : normal.z === 1 ? 2 : 3);
      target.setUint8(output + 17, signs);
    }

    const sideLump = lump(9);
    this.numSides = count(sideLump, 8);
    const sideAllocation = this.allocate("CMod_LoadBrushSides", (this.numSides + 6) * sizes.brushSide);
    this.sideAllocation = sideAllocation;
    this.brushSides = Array.from({ length: this.numSides + 6 }, (_, index) => ({
      get plane(): number { return (recordView(sideAllocation).getUint32(index * 12, true) - planeAllocation.byteOffset) / 20; },
      get surfaceFlags(): number { return recordView(sideAllocation).getInt32(index * 12 + 4, true); },
      get shader(): number { return recordView(sideAllocation).getInt32(index * 12 + 8, true); },
    }));
    for (let index = 0; index < this.numSides; index++) {
      const input = sideLump.offset + index * 8, output = index * 12, target = recordView(sideAllocation);
      target.setUint32(output, pointer(planeAllocation, int(input), 20), true);
      target.setInt32(output + 8, int(input + 4), true);
      const shader = at(this.brushSides, index).shader;
      if (shader < 0 || shader >= shaderCount) throw new CommonError("drop", `CMod_LoadBrushSides: bad shaderNum: ${shader}`);
      target.setInt32(output + 4, at(this.shaders, shader).surfaceFlags, true);
    }

    const brushLump = lump(8);
    this.numBrushes = count(brushLump, 12);
    const brushAllocation = this.allocate("CMod_LoadBrushes", (this.numBrushes + 1) * sizes.brush);
    this.brushAllocation = brushAllocation;
    this.brushes = Array.from({ length: this.numBrushes + 1 }, (_, index) => ({
      get shader(): number { return recordView(brushAllocation).getInt32(index * 44, true); },
      get contents(): number { return recordView(brushAllocation).getInt32(index * 44 + 4, true); },
      bounds: bounds(brushAllocation, index * 44 + 8),
      get sideCount(): number { return recordView(brushAllocation).getInt32(index * 44 + 32, true); },
      get firstSide(): number { return (recordView(brushAllocation).getUint32(index * 44 + 36, true) - sideAllocation.byteOffset) / 12; },
      get checkCount(): number { return recordView(brushAllocation).getInt32(index * 44 + 40, true); },
      set checkCount(value: number) { recordView(brushAllocation).setInt32(index * 44 + 40, value, true); },
    }));
    for (let index = 0; index < this.numBrushes; index++) {
      const input = brushLump.offset + index * 12, output = index * 44, target = recordView(brushAllocation);
      target.setUint32(output + 36, pointer(sideAllocation, int(input), 12), true);
      target.setInt32(output + 32, int(input + 4), true);
      target.setInt32(output, int(input + 8), true);
      const brush = at(this.brushes, index);
      if (brush.shader < 0 || brush.shader >= shaderCount) throw new CommonError("drop", `CMod_LoadBrushes: bad shaderNum: ${brush.shader}`);
      target.setInt32(output + 4, at(this.shaders, brush.shader).contentFlags, true);
      for (let axis = 0; axis < 3; axis++) {
        target.setFloat32(output + 8 + axis * 4, -at(this.planes, at(this.brushSides, brush.firstSide + axis * 2).plane).distance, true);
        target.setFloat32(output + 20 + axis * 4, at(this.planes, at(this.brushSides, brush.firstSide + axis * 2 + 1).plane).distance, true);
      }
    }

    const modelLump = lump(7), modelCount = count(modelLump, 40, "CMod_LoadSubmodels: funny lump size");
    if (modelCount < 1) throw new CommonError("drop", "Map with no models");
    const modelAllocation = this.allocate("CMod_LoadSubmodels", modelCount * sizes.collisionModel);
    const modelBrushes = new Map<number, HunkAllocation>(), modelSurfaces = new Map<number, HunkAllocation>();
    const modelIndexes = (index: number, countOffset: number, firstOffset: number, base: HunkAllocation,
      allocations: ReadonlyMap<number, HunkAllocation>): CollisionIndexes => ({
      get length(): number { return recordView(modelAllocation).getInt32(index * 48 + countOffset, true); },
      at(item: number): number {
        const model = recordView(modelAllocation), length = model.getInt32(index * 48 + countOffset, true);
        indexOffset(item, 4, length);
        const allocation = allocations.get(index);
        if (allocation === undefined) throw new RangeError("CM inline index pointer is unallocated");
        const offset = model.getInt32(index * 48 + firstOffset, true) * 4 + base.byteOffset - allocation.byteOffset + item * 4;
        indexOffset(offset / 4, 4, allocation.byteLength / 4);
        return recordView(allocation).getInt32(offset, true);
      },
    });
    this.models = Array.from({ length: modelCount }, (_, index) => ({
      bounds: bounds(modelAllocation, index * 48),
      brushes: modelIndexes(index, 36, 32, leafBrushAllocation, modelBrushes),
      surfaces: modelIndexes(index, 44, 40, leafSurfaceAllocation, modelSurfaces),
    }));
    if (modelCount > 256) throw new CommonError("drop", "MAX_SUBMODELS exceeded");
    for (let index = 0; index < modelCount; index++) {
      const input = modelLump.offset + index * 40, output = index * 48, target = recordView(modelAllocation);
      for (let axis = 0; axis < 3; axis++) {
        target.setFloat32(output + axis * 4, float(input + axis * 4) - 1, true);
        target.setFloat32(output + 12 + axis * 4, float(input + 12 + axis * 4) + 1, true);
      }
      if (index === 0) continue;
      target.setInt32(output + 36, int(input + 36), true);
      const brushCount = target.getInt32(output + 36, true);
      const brushes = this.allocate("CMod_LoadSubmodels:brushes", brushCount * 4);
      target.setInt32(output + 32, (brushes.byteOffset - leafBrushAllocation.byteOffset) / 4, true);
      modelBrushes.set(index, brushes);
      for (let item = 0; item < brushCount; item++) recordView(brushes).setInt32(item * 4, (int(input + 32) + item) | 0, true);
      target.setInt32(output + 44, int(input + 28), true);
      const surfaceCount = target.getInt32(output + 44, true);
      const surfaces = this.allocate("CMod_LoadSubmodels:surfaces", surfaceCount * 4);
      target.setInt32(output + 40, (surfaces.byteOffset - leafSurfaceAllocation.byteOffset) / 4, true);
      modelSurfaces.set(index, surfaces);
      for (let item = 0; item < surfaceCount; item++) recordView(surfaces).setInt32(item * 4, (int(input + 24) + item) | 0, true);
    }

    const nodeLump = lump(3), nodeCount = count(nodeLump, 36);
    if (nodeCount < 1) throw new CommonError("drop", "Map has no nodes");
    const nodeAllocation = this.allocate("CMod_LoadNodes", nodeCount * sizes.collisionNode);
    this.nodes = Array.from({ length: nodeCount }, (_, index) => ({
      get plane(): number { return (recordView(nodeAllocation).getUint32(index * 12, true) - planeAllocation.byteOffset) / 20; },
      get children(): readonly [number, number] {
        const data = recordView(nodeAllocation);
        return [data.getInt32(index * 12 + 4, true), data.getInt32(index * 12 + 8, true)];
      },
    }));
    for (let index = 0; index < nodeCount; index++) {
      const input = nodeLump.offset + index * 36, output = index * 12, target = recordView(nodeAllocation);
      target.setUint32(output, pointer(planeAllocation, int(input), 20), true);
      target.setInt32(output + 4, int(input + 4), true);
      target.setInt32(output + 8, int(input + 8), true);
    }

    const entities = lump(0);
    this.entityAllocation = this.allocate("CMod_LoadEntityString", entities.length);
    copy(this.entityAllocation, entities.offset, entities.length);

    const visibility = lump(16);
    if (visibility.length === 0) {
      this.visibilityAllocation = this.allocate("CMod_LoadVisibility:novis", (this.clusterCount + 31) & ~31);
      this.visibilityAllocation.bytes.fill(255);
    } else {
      this.visibilityRowBytes = 0;
      this.visibilityAllocation = this.allocate("CMod_LoadVisibility", visibility.length);
      this.clusterCount = int(visibility.offset);
      this.visibilityRowBytes = int(visibility.offset + 4);
      copy(this.visibilityAllocation, visibility.offset + 8, visibility.length - 8);
    }
    const surfaceLump = lump(13), surfaceCount = count(surfaceLump, 104);
    const surfaceAllocation = this.allocate("CMod_LoadPatches:surfaces", surfaceCount * sizes.pointer);
    this.surfaceAllocation = surfaceAllocation;
    const vertexLump = lump(10);
    count(vertexLump, 44);
    for (let index = 0; index < surfaceCount; index++) {
      const input = surfaceLump.offset + index * 104;
      if (int(input + 8) !== 2) continue;
      const patchAllocation = this.allocate("CMod_LoadPatches:patch", sizes.collisionPatch, `${this.source}#${index}`);
      recordView(surfaceAllocation).setUint32(index * 4, patchAllocation.byteOffset, true);
      const generated: { allocation: HunkAllocation | null; collide: PatchCollide | null } = { allocation: null, collide: null };
      this.patches.set(patchAllocation.byteOffset, {
        get checkCount(): number { return recordView(patchAllocation).getInt32(0, true); },
        set checkCount(value: number) { recordView(patchAllocation).setInt32(0, value, true); },
        get contents(): number { return recordView(patchAllocation).getInt32(8, true); },
        get surfaceFlags(): number { return recordView(patchAllocation).getInt32(4, true); },
        get collide(): PatchCollide {
          if (generated.allocation === null || generated.collide === null
            || recordView(patchAllocation).getUint32(12, true) !== generated.allocation.byteOffset) {
            throw new RangeError("CM patch collision pointer outside source allocation");
          }
          return generated.collide;
        },
      });
      const width = int(input + 96), height = int(input + 100), pointsCount = Math.imul(width, height);
      if (pointsCount > 1024) throw new CommonError("drop", "ParseMesh: MAX_PATCH_VERTS");
      const firstVertex = int(input + 12), points: Vec3[] = [];
      for (let item = 0; item < pointsCount; item++) {
        const offset = vertexLump.offset + (firstVertex + item) * 44;
        points.push(vec3(float(offset), float(offset + 4), float(offset + 8)));
      }
      const shader = at(this.shaders, int(input));
      recordView(patchAllocation).setInt32(8, shader.contentFlags, true);
      recordView(patchAllocation).setInt32(4, shader.surfaceFlags, true);
      const collide = generatePatchCollide(width, height, points, this.debug,
        (site, length) => {
          const allocation = this.allocate(site, length, `${this.source}#${index}`);
          if (site === "CM_GeneratePatchCollide") generated.allocation = allocation;
          return allocation;
        });
      if (generated.allocation === null) throw new Error("CM patch generator did not allocate its result");
      recordView(patchAllocation).setUint32(12, generated.allocation.byteOffset, true);
      generated.collide = collide;
    }
  }

  /** CM_LoadMap reaches this only after FS_FreeFile succeeds. */
  initializeBoxHull(): void {
    const planes = this.planeAllocation, sides = this.sideAllocation, brushes = this.brushAllocation, leafBrushes = this.leafBrushAllocation;
    if (planes === null || sides === null || brushes === null || leafBrushes === null) throw new Error("CM box hull requires loaded collision allocations");
    const brushOffset = this.numBrushes * 44;
    recordView(brushes).setInt32(brushOffset + 32, 6, true);
    recordView(brushes).setUint32(brushOffset + 36, sides.byteOffset + this.numSides * 12, true);
    recordView(brushes).setInt32(brushOffset + 4, 0x02000000, true);
    recordView(leafBrushes).setInt32(this.numLeafBrushes * 4, this.numBrushes, true);
    for (let index = 0; index < 6; index++) {
      const side = (this.numSides + index) * 12;
      recordView(sides).setUint32(side, planes.byteOffset + (this.numPlanes + index * 2 + (index & 1)) * 20, true);
      recordView(sides).setInt32(side + 4, 0, true);
      for (let opposite = 0; opposite < 2; opposite++) {
        const offset = (this.numPlanes + index * 2 + opposite) * 20, data = recordView(planes);
        data.setUint8(offset + 16, (index >> 1) + opposite * 3);
        data.setUint8(offset + 17, opposite === 0 ? 0 : 1 << (index >> 1));
        for (let axis = 0; axis < 3; axis++) data.setFloat32(offset + axis * 4, axis === (index >> 1) ? opposite === 0 ? 1 : -1 : 0, true);
      }
    }
    const model = this.boxModel;
    const firstPlane = this.numPlanes;
    const owner = this;
    const brush = at(this.brushes, this.numBrushes);
    this.box = {
      get bounds(): Bounds { return model.bounds; },
      brush,
      get checkCount(): number { return owner.checkCount; },
      readSide(index: number): { readonly plane: CollisionPlane; readonly surfaceFlags: number } {
        const side = at(owner.brushSides, brush.firstSide + index);
        return {
          get plane(): CollisionPlane { return at(owner.planes, side.plane); },
          get surfaceFlags(): number { return side.surfaceFlags; },
        };
      },
      setBounds(mins: Vec3, maxs: Vec3, capsule: boolean): void {
        model.bounds = { min: vec3(mins.x, mins.y, mins.z), max: vec3(maxs.x, maxs.y, maxs.z) };
        if (capsule) return;
        const distances = [maxs.x, -maxs.x, mins.x, -mins.x, maxs.y, -maxs.y, mins.y, -mins.y, maxs.z, -maxs.z, mins.z, -mins.z];
        for (const [index, distance] of distances.entries()) recordView(planes).setFloat32((firstPlane + index) * 20 + 12, distance, true);
        const data = recordView(brushes);
        for (const [index, value] of [mins.x, mins.y, mins.z, maxs.x, maxs.y, maxs.z].entries()) data.setFloat32(brushOffset + 8 + index * 4, value, true);
      },
    };
  }
}

function diagnosticIndexes(values: readonly number[]): CollisionIndexes {
  return { length: values.length, at(index: number): number { return at(values, index); } };
}

/** Authored geometry tests can supply decoded data without pretending to execute CM_LoadMap. */
export function diagnosticCollisionMap(map: BspMap, debug: CollisionDebugSurface | null): CollisionMapData {
  const planes = map.planes.map(value => ({ ...value,
    type: value.normal.x === 1 ? 0 : value.normal.y === 1 ? 1 : value.normal.z === 1 ? 2 : 3,
    signbits: Number(value.normal.x < 0) | (Number(value.normal.y < 0) << 1) | (Number(value.normal.z < 0) << 2),
  }));
  const patches = new Map<number, CollisionPatch>();
  for (const [index, surface] of map.surfaces.entries()) {
    if (surface.type !== "patch") continue;
    const shader = at(map.shaders, surface.shader);
    patches.set(index, { checkCount: 0, contents: shader.contentFlags, surfaceFlags: shader.surfaceFlags,
      collide: generatePatchCollide(surface.patchWidth, surface.patchHeight,
        map.vertices.slice(surface.firstVertex, surface.firstVertex + surface.vertexCount).map(vertex => vertex.position), debug) });
  }
  let areaCount = 0, clusterCount = 0;
  for (const leaf of map.leaves) { areaCount = Math.max(areaCount, leaf.area + 1); clusterCount = Math.max(clusterCount, leaf.cluster + 1); }
  const areas = Array.from({ length: areaCount }, () => ({ flood: 0, floodValid: 0 }));
  const portals = new Int32Array(areaCount * areaCount);
  const visibility = map.visibility === null ? new Uint8Array((clusterCount + 31) & ~31).fill(255) : new Uint8Array(map.visibility.bits.length + 8);
  if (map.visibility !== null) visibility.set(map.visibility.bits);
  return {
    kind: "collision-map", checkCount: 0, entities: map.entities, shaders: map.shaders, planes, nodes: map.nodes, leaves: map.leaves,
    leafBrushes: diagnosticIndexes(map.leafBrushes), leafSurfaces: diagnosticIndexes(map.leafSurfaces),
    brushes: map.brushes.map(brush => ({ ...brush, checkCount: 0, contents: at(map.shaders, brush.shader).contentFlags,
      // Tests can deliberately supply fewer than six sides; bounds are consumed only by the reached source test.
      get bounds(): Bounds {
        const distance = (side: number): number => at(planes, at(map.brushSides, brush.firstSide + side).plane).distance;
        return { min: vec3(-distance(0), -distance(2), -distance(4)), max: vec3(distance(1), distance(3), distance(5)) };
      },
    })),
    brushSides: map.brushSides.map(side => ({ ...side, surfaceFlags: at(map.shaders, side.shader).surfaceFlags })),
    models: map.models.map(model => ({ bounds: { min: sub3(model.bounds.min, vec3(1, 1, 1)), max: add3(model.bounds.max, vec3(1, 1, 1)) },
      brushes: diagnosticIndexes(Array.from({ length: model.brushCount }, (_, index) => model.firstBrush + index)),
      surfaces: diagnosticIndexes(Array.from({ length: model.surfaceCount }, (_, index) => model.firstSurface + index)),
    })),
    patch(index: number): CollisionPatch | null {
      at(map.surfaces, index);
      return patches.get(index) ?? null;
    },
    areas, portals: {
      at(index: number): number { indexOffset(index, 4, portals.length); const value = portals[index]; if (value === undefined) throw new RangeError("CM portal outside allocation"); return value; },
      set(index: number, value: number): void { indexOffset(index, 4, portals.length); portals[index] = value; },
    },
    clusterCount: map.visibility?.clusterCount ?? clusterCount, visibility,
    visibilityRowBytes: map.visibility?.bytesPerCluster ?? null, box: null,
  };
}
