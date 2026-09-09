/*
 * AAS record storage from id Software's botlib/aasfile.h, be_aas_file.c,
 * be_aas_reach.c, be_aas_cluster.c and be_aas_optimize.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import type {
  AasArea, AasBoundingBox, AasEdge, AasFace, AasNode, AasPlane,
} from "./aas.ts";
import type {
  MutableAasAreaSettings, MutableAasCluster, MutableAasPortal, MutableAasReachability,
} from "./aas-world.ts";
import type { BotMemory, BotMemoryAllocation } from "./memory.ts";

export interface AasLump { readonly offset: number; readonly length: number }
export interface AasLumpReader {
  readonly length: number;
  load(lump: AasLump, stride: number, memory: BotMemory): BotMemoryAllocation;
}
export type AasLumpName = "bboxes" | "vertices" | "planes" | "edges" | "edgeIndexes"
  | "faces" | "faceIndexes" | "areas" | "areaSettings" | "reachability" | "nodes"
  | "portals" | "portalIndex" | "clusters";
export interface AasHeapRecords<T> {
  readonly allocation: BotMemoryAllocation;
  readonly values: readonly T[];
}
export interface AasHeapIndexes extends AasHeapRecords<number> { readonly values: number[] }
type MutableVector = { x: number; y: number; z: number };
type MutableFace = { -readonly [Field in keyof AasFace]: AasFace[Field] };
type MutableArea = { -readonly [Field in keyof AasArea]: AasArea[Field] };

/** Every field access renews its borrow, so clearing the common hunk expires records. */
class LumpData {
  private retainedView: { readonly bytes: Uint8Array; readonly view: DataView } | null = null;

  constructor(private readonly allocation: BotMemoryAllocation) {}

  private view(): DataView {
    const bytes = this.allocation.bytes;
    const retained = this.retainedView;
    if (retained !== null && retained.bytes === bytes) {
      return retained.view;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.retainedView = { bytes, view };
    return view;
  }

  integer(offset: number): number { return this.view().getInt32(offset, true); }
  float(offset: number): number { return this.view().getFloat32(offset, true); }
  short(offset: number): number { return this.view().getUint16(offset, true); }
  setInteger(offset: number, value: number): void { this.view().setInt32(offset, value, true); }
  setFloat(offset: number, value: number): void { this.view().setFloat32(offset, value, true); }
  setShort(offset: number, value: number): void { this.view().setUint16(offset, value, true); }
}

function vector(data: LumpData, offset: number): Vec3 {
  return Object.freeze({
    get x(): number { return data.float(offset); },
    get y(): number { return data.float(offset + 4); },
    get z(): number { return data.float(offset + 8); },
  });
}

function mutableVector(data: LumpData, offset: number): MutableVector {
  return Object.freeze({
    get x(): number { return data.float(offset); },
    set x(value: number) { data.setFloat(offset, value); },
    get y(): number { return data.float(offset + 4); },
    set y(value: number) { data.setFloat(offset + 4, value); },
    get z(): number { return data.float(offset + 8); },
    set z(value: number) { data.setFloat(offset + 8, value); },
  });
}

function bounds(data: LumpData, offset: number): Bounds {
  return Object.freeze({ min: vector(data, offset), max: vector(data, offset + 12) });
}

function pair(data: LumpData, offset: number): readonly [number, number] {
  const values: [number, number] = [0, 0];
  Object.defineProperties(values, {
    0: { enumerable: true, get: (): number => data.integer(offset) },
    1: { enumerable: true, get: (): number => data.integer(offset + 4) },
  });
  return Object.freeze(values);
}

function mutablePair(data: LumpData, offset: number): [number, number] {
  const values: [number, number] = [0, 0];
  Object.defineProperties(values, {
    0: { enumerable: true, get: (): number => data.integer(offset),
      set: (value: number): void => data.setInteger(offset, value) },
    1: { enumerable: true, get: (): number => data.integer(offset + 4),
      set: (value: number): void => data.setInteger(offset + 4, value) },
  });
  // The source pair has fixed membership; its accessor setters still write payload bytes.
  Object.freeze(values);
  return values;
}

function indexes(data: LumpData, count: number): readonly number[] {
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    Object.defineProperty(values, index, {
      enumerable: true, get: (): number => data.integer(index * 4),
    });
  }
  return Object.freeze(values);
}

function bbox(data: LumpData, offset: number): AasBoundingBox {
  return Object.freeze({
    get presenceType(): number { return data.integer(offset); },
    get flags(): number { return data.integer(offset + 4); },
    bounds: bounds(data, offset + 8),
  });
}

function plane(data: LumpData, offset: number): AasPlane {
  return Object.freeze({ normal: vector(data, offset),
    get distance(): number { return data.float(offset + 12); },
    get type(): number { return data.integer(offset + 16); },
  });
}

function face(data: LumpData, offset: number): AasFace {
  return Object.freeze({
    get plane(): number { return data.integer(offset); },
    get flags(): number { return data.integer(offset + 4); },
    get edgeCount(): number { return data.integer(offset + 8); },
    get firstEdge(): number { return data.integer(offset + 12); },
    get frontArea(): number { return data.integer(offset + 16); },
    get backArea(): number { return data.integer(offset + 20); },
  });
}

function area(data: LumpData, offset: number): AasArea {
  return Object.freeze({
    get areaNumber(): number { return data.integer(offset); },
    get faceCount(): number { return data.integer(offset + 4); },
    get firstFace(): number { return data.integer(offset + 8); },
    bounds: bounds(data, offset + 12), center: vector(data, offset + 36),
  });
}

function mutableFace(data: LumpData, offset: number): MutableFace {
  return Object.freeze({
    get plane(): number { return data.integer(offset); },
    set plane(value: number) { data.setInteger(offset, value); },
    get flags(): number { return data.integer(offset + 4); },
    set flags(value: number) { data.setInteger(offset + 4, value); },
    get edgeCount(): number { return data.integer(offset + 8); },
    set edgeCount(value: number) { data.setInteger(offset + 8, value); },
    get firstEdge(): number { return data.integer(offset + 12); },
    set firstEdge(value: number) { data.setInteger(offset + 12, value); },
    get frontArea(): number { return data.integer(offset + 16); },
    set frontArea(value: number) { data.setInteger(offset + 16, value); },
    get backArea(): number { return data.integer(offset + 20); },
    set backArea(value: number) { data.setInteger(offset + 20, value); },
  });
}

function mutableArea(data: LumpData, offset: number): MutableArea {
  const min = mutableVector(data, offset + 12), max = mutableVector(data, offset + 24);
  const areaBounds: Bounds = Object.freeze({ min, max }), center = mutableVector(data, offset + 36);
  return Object.freeze({
    get areaNumber(): number { return data.integer(offset); },
    set areaNumber(value: number) { data.setInteger(offset, value); },
    get faceCount(): number { return data.integer(offset + 4); },
    set faceCount(value: number) { data.setInteger(offset + 4, value); },
    get firstFace(): number { return data.integer(offset + 8); },
    set firstFace(value: number) { data.setInteger(offset + 8, value); },
    get bounds(): Bounds { return areaBounds; },
    set bounds(value: Bounds) { Object.assign(min, value.min); Object.assign(max, value.max); },
    get center(): Vec3 { return center; },
    set center(value: Vec3) { Object.assign(center, value); },
  });
}

class SettingsRecord implements MutableAasAreaSettings {
  readonly #data: LumpData;
  readonly #offset: number;
  contents = 0;
  flags = 0;
  presenceType = 0;
  cluster = 0;
  clusterAreaNumber = 0;
  reachableAreaCount = 0;
  firstReachableArea = 0;

  private static readonly fields = {
    contents: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset, value); } },
    flags: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset + 4); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset + 4, value); } },
    presenceType: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset + 8); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset + 8, value); } },
    cluster: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset + 12); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset + 12, value); } },
    clusterAreaNumber: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset + 16); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset + 16, value); } },
    reachableAreaCount: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset + 20); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset + 20, value); } },
    firstReachableArea: { enumerable: true,
      get(this: SettingsRecord): number { return this.#data.integer(this.#offset + 24); },
      set(this: SettingsRecord, value: number): void { this.#data.setInteger(this.#offset + 24, value); } },
  };

  constructor(data: LumpData, offset: number) {
    this.#data = data;
    this.#offset = offset;
    Object.defineProperties(this, SettingsRecord.fields);
  }
}

function settings(data: LumpData, offset: number): MutableAasAreaSettings {
  return Object.freeze(new SettingsRecord(data, offset));
}

function reachability(data: LumpData, offset: number): MutableAasReachability {
  const start = mutableVector(data, offset + 12), end = mutableVector(data, offset + 24);
  return Object.freeze({
    get area(): number { return data.integer(offset); },
    set area(value: number) { data.setInteger(offset, value); },
    get face(): number { return data.integer(offset + 4); },
    set face(value: number) { data.setInteger(offset + 4, value); },
    get edge(): number { return data.integer(offset + 8); },
    set edge(value: number) { data.setInteger(offset + 8, value); },
    get start(): MutableVector { return start; },
    set start(value: MutableVector) { start.x = value.x; start.y = value.y; start.z = value.z; },
    get end(): MutableVector { return end; },
    set end(value: MutableVector) { end.x = value.x; end.y = value.y; end.z = value.z; },
    get travelType(): number { return data.integer(offset + 36); },
    set travelType(value: number) { data.setInteger(offset + 36, value); },
    get travelTime(): number { return data.short(offset + 40); },
    set travelTime(value: number) { data.setShort(offset + 40, value); },
    get padding(): number { return data.short(offset + 42); },
    set padding(value: number) { data.setShort(offset + 42, value); },
  });
}

function portal(data: LumpData, offset: number): MutableAasPortal {
  const clusterAreaNumbers = mutablePair(data, offset + 12);
  return Object.freeze({
    get area(): number { return data.integer(offset); },
    set area(value: number) { data.setInteger(offset, value); },
    get frontCluster(): number { return data.integer(offset + 4); },
    set frontCluster(value: number) { data.setInteger(offset + 4, value); },
    get backCluster(): number { return data.integer(offset + 8); },
    set backCluster(value: number) { data.setInteger(offset + 8, value); },
    get clusterAreaNumbers(): [number, number] { return clusterAreaNumbers; },
    set clusterAreaNumbers(value: [number, number]) {
      clusterAreaNumbers[0] = value[0]; clusterAreaNumbers[1] = value[1];
    },
  });
}

function cluster(data: LumpData, offset: number): MutableAasCluster {
  return Object.freeze({
    get areaCount(): number { return data.integer(offset); },
    set areaCount(value: number) { data.setInteger(offset, value); },
    get reachabilityAreaCount(): number { return data.integer(offset + 4); },
    set reachabilityAreaCount(value: number) { data.setInteger(offset + 4, value); },
    get portalCount(): number { return data.integer(offset + 8); },
    set portalCount(value: number) { data.setInteger(offset + 8, value); },
    get firstPortal(): number { return data.integer(offset + 12); },
    set firstPortal(value: number) { data.setInteger(offset + 12, value); },
  });
}

function heapRecords<T>(memory: BotMemory, count: number, stride: number,
  read: (data: LumpData, offset: number) => T): AasHeapRecords<T> {
  const allocation = memory.allocate(count * stride, "heap", true), data = new LumpData(allocation);
  const values = Object.freeze(Array.from({ length: count }, (_, index) => read(data, index * stride)));
  return Object.freeze({ allocation, values });
}

export function allocateAasVertices(memory: BotMemory, count: number): AasHeapRecords<MutableVector> {
  return heapRecords(memory, count, 12, mutableVector);
}

export function allocateAasEdges(memory: BotMemory, count: number): AasHeapRecords<{ readonly vertices: [number, number] }> {
  return heapRecords(memory, count, 8, (data, offset) => Object.freeze({ vertices: mutablePair(data, offset) }));
}

export function allocateAasFaces(memory: BotMemory, count: number): AasHeapRecords<MutableFace> {
  return heapRecords(memory, count, 24, mutableFace);
}

export function allocateAasAreas(memory: BotMemory, count: number): AasHeapRecords<MutableArea> {
  return heapRecords(memory, count, 48, mutableArea);
}

export function allocateAasReachability(memory: BotMemory, count: number): AasHeapRecords<MutableAasReachability> {
  return heapRecords(memory, count, 44, reachability);
}

export function allocateAasPortals(memory: BotMemory, count: number): AasHeapRecords<MutableAasPortal> {
  return heapRecords(memory, count, 20, portal);
}

export function allocateAasClusters(memory: BotMemory, count: number): AasHeapRecords<MutableAasCluster> {
  return heapRecords(memory, count, 16, cluster);
}

export function allocateAasIndexes(memory: BotMemory, count: number): AasHeapIndexes {
  const allocation = memory.allocate(count * 4, "heap", true), data = new LumpData(allocation);
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    Object.defineProperty(values, index, { enumerable: true,
      get: (): number => data.integer(index * 4),
      set: (value: number): void => data.setInteger(index * 4, value),
    });
  }
  Object.freeze(values);
  return Object.freeze({ allocation, values });
}

/** Loaded lump payloads occupy bot hunk storage. Record and array objects only name fields. */
export class AasLoadedLumps {
  readonly allocations: ReadonlyMap<AasLumpName, BotMemoryAllocation>;
  readonly bboxes: readonly AasBoundingBox[];
  readonly vertices: readonly Vec3[];
  readonly planes: readonly AasPlane[];
  readonly edges: readonly AasEdge[];
  readonly edgeIndexes: readonly number[];
  readonly faces: readonly AasFace[];
  readonly faceIndexes: readonly number[];
  readonly areas: readonly AasArea[];
  readonly areaSettings: readonly MutableAasAreaSettings[];
  readonly reachability: readonly MutableAasReachability[];
  readonly nodes: readonly AasNode[];
  readonly portals: readonly MutableAasPortal[];
  readonly portalIndex: readonly number[];
  readonly clusters: readonly MutableAasCluster[];
  private readonly portalIndexData: LumpData;

  constructor(bytes: Uint8Array, source: string, lumps: readonly AasLump[], readonly memory: BotMemory,
    reader?: AasLumpReader) {
    const allocations = new Map<AasLumpName, BotMemoryAllocation>();
    this.allocations = allocations;
    const names: readonly AasLumpName[] = ["bboxes", "vertices", "planes", "edges", "edgeIndexes", "faces",
      "faceIndexes", "areas", "areaSettings", "reachability", "nodes", "portals", "portalIndex", "clusters"];
    function load(index: number, stride: number): { readonly data: LumpData; readonly count: number } {
      const section = lumps[index], name = names[index];
      if (section === undefined || name === undefined) throw new RangeError(`unknown AAS lump ${index}`);
      if (section.length % stride !== 0) {
        throw new BinaryError(source, section.offset, `length ${section.length} is not a multiple of record size ${stride}`);
      }
      if (reader === undefined && section.length > 0) {
        new BinaryReader(bytes, source).records(section.offset, section.length, stride);
      }
      const allocation = reader === undefined
        ? memory.allocate((section.length === 0 ? stride : section.length) + 1, "hunk", true)
        : reader.load(section, stride, memory);
      allocations.set(name, allocation);
      if (reader === undefined) {
        allocation.bytes.set(bytes.subarray(section.offset, section.offset + section.length));
      }
      return { data: new LumpData(allocation), count: section.length / stride };
    }
    function records<T>(index: number, stride: number, read: (data: LumpData, offset: number) => T): readonly T[] {
      const loaded = load(index, stride);
      return Object.freeze(Array.from({ length: loaded.count }, (_, cell) => read(loaded.data, cell * stride)));
    }
    this.bboxes = records(0, 32, bbox);
    this.vertices = records(1, 12, vector);
    this.planes = records(2, 20, plane);
    this.edges = records(3, 8, (data, offset) => Object.freeze({ vertices: pair(data, offset) }));
    const edgeIndexes = load(4, 4);
    this.edgeIndexes = indexes(edgeIndexes.data, edgeIndexes.count);
    this.faces = records(5, 24, face);
    const faceIndexes = load(6, 4);
    this.faceIndexes = indexes(faceIndexes.data, faceIndexes.count);
    this.areas = records(7, 48, area);
    this.areaSettings = records(8, 28, settings);
    this.reachability = records(9, 44, reachability);
    this.nodes = records(10, 12, (data, offset) => Object.freeze({
      get plane(): number { return data.integer(offset); }, children: pair(data, offset + 4),
    }));
    this.portals = records(11, 20, portal);
    const portalIndexes = load(12, 4);
    this.portalIndexData = portalIndexes.data;
    this.portalIndex = indexes(portalIndexes.data, portalIndexes.count);
    this.clusters = records(13, 16, cluster);
  }

  setPortalIndex(index: number, value: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.portalIndex.length) {
      throw new RangeError(`portal indexes: index ${index} outside ${this.portalIndex.length} loaded cells`);
    }
    this.portalIndexData.setInteger(index * 4, value);
  }
}
