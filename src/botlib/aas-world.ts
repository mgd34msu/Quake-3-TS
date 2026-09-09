/*
 * Mutable AAS allocations and source counts from id Software's
 * botlib/be_aas_def.h, be_aas_reach.c and be_aas_cluster.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { dot3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { AasLoadedWorld } from "./aas.ts";
import type {
  AasArea, AasAreaSettings, AasBoundingBox, AasCluster, AasEdge, AasFace,
  AasNode, AasPlane, AasPortal, AasReachability, AasWorld,
} from "./aas.ts";
import { allocateAasClusters, allocateAasIndexes, allocateAasPortals, allocateAasReachability } from "./aas-storage.ts";
import type { AasHeapRecords, AasLumpName } from "./aas-storage.ts";
import { BotMemory } from "./memory.ts";
import type { BotMemoryAllocation } from "./memory.ts";

type Mutable<T> = { -readonly [Field in keyof T]: T[Field] };
type MutableVector = Mutable<Vec3>;
export type MutableAasAreaSettings = Mutable<AasAreaSettings>;
export type MutableAasReachability = Mutable<Omit<AasReachability, "start" | "end">>
  & { start: MutableVector; end: MutableVector };
export type MutableAasPortal = Mutable<Omit<AasPortal, "clusterAreaNumbers">>
  & { clusterAreaNumbers: [number, number] };
export type MutableAasCluster = Mutable<AasCluster>;
type PortalIndexStorage =
  | { readonly kind: "loaded"; readonly owner: AasLoadedWorld; readonly values: readonly number[] }
  | { readonly kind: "generated"; readonly values: number[] };

function allocationSize(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
    throw new RangeError(`${name}: allocation count must be a nonnegative source int`);
  }
  return value;
}

function cell<T>(allocation: readonly T[], index: number, name: string): T {
  const value = allocation[index];
  if (value === undefined) throw new RangeError(`${name}: index ${index} outside ${allocation.length} allocated cells`);
  return value;
}

function resizeView<T>(view: T[], allocation: readonly T[], count: number, name: string): void {
  allocationSize(count, name);
  if (count > allocation.length) throw new RangeError(`${name}: active count ${count} exceeds allocation ${allocation.length}`);
  if (count < view.length) view.length = count;
  else for (let index = view.length; index < count; index++) view.push(cell(allocation, index, name));
}

function resizeIndexView(view: number[], allocation: readonly number[], count: number): void {
  allocationSize(count, "portal indexes");
  if (count > allocation.length) throw new RangeError(`portal indexes: active count ${count} exceeds allocation ${allocation.length}`);
  if (count < view.length) view.length = count;
  else for (let index = view.length; index < count; index++) {
    Object.defineProperty(view, index, { configurable: true, enumerable: true,
      get: (): number => cell(allocation, index, "portal indexes") });
  }
}

function copyReachability(value: AasReachability): MutableAasReachability {
  return { ...value, start: { ...value.start }, end: { ...value.end } };
}

function copyPortal(value: AasPortal): MutableAasPortal {
  return { ...value, clusterAreaNumbers: [value.clusterAreaNumbers[0], value.clusterAreaNumbers[1]] };
}

/** One loaded world, borrowed by spatial queries, generation, routing and file writing. */
export class AasWorldState implements AasWorld {
  readonly source: string;
  readonly version: 4 | 5;
  readonly bspChecksum: number;
  readonly memory: BotMemory;
  saveFile = false;
  numReachabilityAreas = 0;

  private readonly allocations: Map<AasLumpName, BotMemoryAllocation>;
  private currentBboxes: readonly AasBoundingBox[];
  private currentVertices: readonly Vec3[];
  private currentPlanes: readonly AasPlane[];
  private currentEdges: readonly AasEdge[];
  private currentEdgeIndexes: readonly number[];
  private currentFaces: readonly AasFace[];
  private currentFaceIndexes: readonly number[];
  private currentAreas: readonly AasArea[];
  private settings: readonly MutableAasAreaSettings[];
  private currentNodes: readonly AasNode[];
  private reachabilityStorage: readonly MutableAasReachability[];
  private reachabilityView: MutableAasReachability[];
  private reachabilityCount: number;
  private portalStorage: readonly MutableAasPortal[];
  private portalView: MutableAasPortal[];
  private portalCount: number;
  private portalIndexStorage: PortalIndexStorage;
  private portalIndexView: number[];
  private portalIndexCount: number;
  private clusterStorage: readonly MutableAasCluster[];
  private clusterView: MutableAasCluster[];
  private clusterCount: number;

  constructor(parsed: AasWorld) {
    this.source = parsed.source;
    this.version = parsed.version;
    this.bspChecksum = parsed.bspChecksum;
    this.currentVertices = parsed.vertices;
    this.currentPlanes = parsed.planes;
    this.currentEdges = parsed.edges;
    this.currentEdgeIndexes = parsed.edgeIndexes;
    this.currentFaces = parsed.faces;
    this.currentFaceIndexes = parsed.faceIndexes;
    this.currentAreas = parsed.areas;
    this.currentNodes = parsed.nodes;
    this.currentBboxes = parsed.bboxes;
    const loaded = parsed instanceof AasLoadedWorld ? parsed : null;
    this.memory = loaded === null ? new BotMemory() : loaded.memory;
    this.allocations = loaded === null ? new Map<AasLumpName, BotMemoryAllocation>() : new Map(loaded.allocations);
    this.settings = loaded === null ? parsed.areaSettings.map(settings => ({ ...settings })) : loaded.areaSettings;
    this.reachabilityStorage = loaded === null ? parsed.reachability.map(copyReachability) : loaded.reachability;
    this.reachabilityCount = this.reachabilityStorage.length;
    this.reachabilityView = this.reachabilityStorage.slice();
    this.portalStorage = loaded === null ? parsed.portals.map(copyPortal) : loaded.portals;
    this.portalCount = this.portalStorage.length;
    this.portalView = this.portalStorage.slice();
    this.portalIndexStorage = loaded === null
      ? { kind: "generated", values: parsed.portalIndex.slice() }
      : { kind: "loaded", owner: loaded, values: loaded.portalIndex };
    this.portalIndexCount = this.portalIndexStorage.values.length;
    this.portalIndexView = [];
    resizeIndexView(this.portalIndexView, this.portalIndexStorage.values, this.portalIndexCount);
    this.clusterStorage = loaded === null ? parsed.clusters.map(cluster => ({ ...cluster })) : loaded.clusters;
    this.clusterCount = this.clusterStorage.length;
    this.clusterView = this.clusterStorage.slice();
  }

  get bboxes(): readonly AasBoundingBox[] { return this.currentBboxes; }
  get vertices(): readonly Vec3[] { return this.currentVertices; }
  get planes(): readonly AasPlane[] { return this.currentPlanes; }
  get edges(): readonly AasEdge[] { return this.currentEdges; }
  get edgeIndexes(): readonly number[] { return this.currentEdgeIndexes; }
  get faces(): readonly AasFace[] { return this.currentFaces; }
  get faceIndexes(): readonly number[] { return this.currentFaceIndexes; }
  get areas(): readonly AasArea[] { return this.currentAreas; }
  get areaSettings(): readonly AasAreaSettings[] { return this.settings; }
  get nodes(): readonly AasNode[] { return this.currentNodes; }
  get reachability(): readonly AasReachability[] {
    this.requireActiveCount(this.reachabilityCount, this.reachabilityStorage.length, "reachability");
    return this.reachabilityView;
  }
  get portals(): readonly AasPortal[] {
    this.requireActiveCount(this.portalCount, this.portalStorage.length, "portals");
    return this.portalView;
  }
  get portalIndex(): readonly number[] {
    this.requireActiveCount(this.portalIndexCount, this.portalIndexStorage.values.length, "portal indexes");
    return this.portalIndexView;
  }
  get clusters(): readonly AasCluster[] {
    this.requireActiveCount(this.clusterCount, this.clusterStorage.length, "clusters");
    return this.clusterView;
  }

  get reachabilitySize(): number { return this.reachabilityCount; }
  set reachabilitySize(count: number) {
    resizeView(this.reachabilityView, this.reachabilityStorage, count, "reachability");
    this.reachabilityCount = count;
  }
  get numPortals(): number { return this.portalCount; }
  set numPortals(count: number) {
    resizeView(this.portalView, this.portalStorage, count, "portals");
    this.portalCount = count;
  }
  get portalIndexSize(): number { return this.portalIndexCount; }
  set portalIndexSize(count: number) {
    resizeIndexView(this.portalIndexView, this.portalIndexStorage.values, count);
    this.portalIndexCount = count;
  }
  get numClusters(): number { return this.clusterCount; }
  set numClusters(count: number) {
    resizeView(this.clusterView, this.clusterStorage, count, "clusters");
    this.clusterCount = count;
  }

  areaSettingsRecord(index: number): MutableAasAreaSettings { return cell(this.settings, index, "area settings"); }
  reachabilityRecord(index: number): MutableAasReachability { return cell(this.reachabilityStorage, index, "reachability"); }
  portalRecord(index: number): MutableAasPortal { return cell(this.portalStorage, index, "portals"); }
  portalIndexValue(index: number): number { return cell(this.portalIndexStorage.values, index, "portal indexes"); }
  clusterRecord(index: number): MutableAasCluster { return cell(this.clusterStorage, index, "clusters"); }

  replaceVertices(values: readonly Vec3[] | AasHeapRecords<Vec3>, count?: number): void {
    this.currentVertices = this.replaceRecords("vertices", values, count);
  }
  replaceEdges(values: readonly AasEdge[] | AasHeapRecords<AasEdge>, count?: number): void {
    this.currentEdges = this.replaceRecords("edges", values, count);
  }
  replaceEdgeIndexes(values: readonly number[] | AasHeapRecords<number>, count?: number): void {
    this.currentEdgeIndexes = this.replaceIndexes("edgeIndexes", values, count);
  }
  replaceFaces(values: readonly AasFace[] | AasHeapRecords<AasFace>, count?: number): void {
    this.currentFaces = this.replaceRecords("faces", values, count);
  }
  replaceFaceIndexes(values: readonly number[] | AasHeapRecords<number>, count?: number): void {
    this.currentFaceIndexes = this.replaceIndexes("faceIndexes", values, count);
  }
  replaceAreas(values: readonly AasArea[] | AasHeapRecords<AasArea>, count?: number): void {
    this.currentAreas = this.replaceRecords("areas", values, count);
  }

  setPortalIndex(index: number, value: number): void {
    const storage = this.portalIndexStorage;
    cell(storage.values, index, "portal indexes");
    if (storage.kind === "loaded") storage.owner.setPortalIndex(index, value);
    else storage.values[index] = value;
  }

  allocateReachability(capacity: number): void {
    allocationSize(capacity, "reachability");
    this.freeAllocation("reachability");
    this.reachabilityStorage = [];
    this.reachabilityView = [];
    const storage = allocateAasReachability(this.memory, capacity);
    this.allocations.set("reachability", storage.allocation);
    this.reachabilityStorage = storage.values;
    resizeView(this.reachabilityView, this.reachabilityStorage, Math.min(this.reachabilityCount, capacity), "reachability");
  }

  allocatePortals(capacity: number): void {
    allocationSize(capacity, "portals");
    this.freeAllocation("portals");
    this.portalStorage = [];
    this.portalView = [];
    const storage = allocateAasPortals(this.memory, capacity);
    this.allocations.set("portals", storage.allocation);
    this.portalStorage = storage.values;
    resizeView(this.portalView, this.portalStorage, Math.min(this.portalCount, capacity), "portals");
  }

  allocatePortalIndexes(capacity: number): void {
    allocationSize(capacity, "portal indexes");
    this.freeAllocation("portalIndex");
    this.portalIndexStorage = { kind: "generated", values: [] };
    this.portalIndexView = [];
    const storage = allocateAasIndexes(this.memory, capacity);
    this.allocations.set("portalIndex", storage.allocation);
    this.portalIndexStorage = { kind: "generated", values: storage.values };
    resizeIndexView(this.portalIndexView, this.portalIndexStorage.values, Math.min(this.portalIndexCount, capacity));
  }

  allocateClusters(capacity: number): void {
    allocationSize(capacity, "clusters");
    this.freeAllocation("clusters");
    this.clusterStorage = [];
    this.clusterView = [];
    const storage = allocateAasClusters(this.memory, capacity);
    this.allocations.set("clusters", storage.allocation);
    this.clusterStorage = storage.values;
    resizeView(this.clusterView, this.clusterStorage, Math.min(this.clusterCount, capacity), "clusters");
  }

  /** AAS_DumpAASData frees heap payloads and leaves loaded hunk payloads to common. */
  dumpData(): void {
    this.currentBboxes = []; this.freeAllocation("bboxes");
    this.currentVertices = []; this.freeAllocation("vertices");
    this.currentPlanes = []; this.freeAllocation("planes");
    this.currentEdges = []; this.freeAllocation("edges");
    this.currentEdgeIndexes = []; this.freeAllocation("edgeIndexes");
    this.currentFaces = []; this.freeAllocation("faces");
    this.currentFaceIndexes = []; this.freeAllocation("faceIndexes");
    this.currentAreas = []; this.freeAllocation("areas");
    this.settings = []; this.freeAllocation("areaSettings");
    this.reachabilityCount = 0;
    this.reachabilityView = [];
    this.freeAllocation("reachability"); this.reachabilityStorage = [];
    this.currentNodes = []; this.freeAllocation("nodes");
    this.portalCount = 0;
    this.portalView = [];
    this.freeAllocation("portals"); this.portalStorage = [];
    this.freeAllocation("portalIndex");
    this.portalIndexStorage = { kind: "generated", values: [] }; this.portalIndexView = [];
    this.portalIndexCount = 0;
    this.freeAllocation("clusters"); this.clusterStorage = []; this.clusterView = [];
    this.clusterCount = 0;
    this.saveFile = false;
  }

  pointArea(point: Vec3): number {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      throw new RangeError("AAS point must be finite");
    }
    let nodeNumber = 1;
    while (nodeNumber > 0) {
      const node = cell(this.nodes, nodeNumber, "AAS nodes");
      const plane = cell(this.planes, node.plane, "AAS planes");
      const distance = Math.fround(dot3(point, plane.normal) - plane.distance);
      nodeNumber = distance > 0 ? node.children[0] : node.children[1];
    }
    return nodeNumber === 0 ? 0 : -nodeNumber;
  }

  areaReachabilities(areaNumber: number): readonly AasReachability[] {
    this.requireArea(areaNumber);
    const settings = cell(this.settings, areaNumber, "area settings");
    const first = settings.firstReachableArea, count = settings.reachableAreaCount;
    const reachability = this.reachability;
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0 || first > reachability.length - count) {
      throw new RangeError(`AAS area ${areaNumber} reachability range ${first}+${count} exceeds active storage`);
    }
    return Object.freeze(reachability.slice(first, first + count));
  }

  areaBounds(areaNumber: number): Bounds { return this.requireArea(areaNumber).bounds; }

  private requireArea(areaNumber: number): AasArea {
    if (!Number.isInteger(areaNumber) || areaNumber <= 0 || areaNumber >= this.areas.length) {
      throw new RangeError(`AAS area ${areaNumber} outside 1..${this.areas.length - 1}`);
    }
    return cell(this.areas, areaNumber, "AAS areas");
  }

  private requireActiveCount(count: number, capacity: number, name: string): void {
    if (count > capacity) throw new RangeError(`AAS ${name}: source active count ${count} exceeds current allocation ${capacity}`);
  }

  private freeAllocation(name: AasLumpName): void {
    const allocation = this.allocations.get(name);
    if (allocation === undefined) return;
    this.memory.free(allocation);
    this.allocations.delete(name);
  }

  private replaceRecords<T>(name: AasLumpName, values: readonly T[] | AasHeapRecords<T>, count: number | undefined): readonly T[] {
    // Array-only diagnostic replacements can still borrow the current allocation.
    if (!("allocation" in values)) return values;
    this.freeAllocation(name);
    this.allocations.set(name, values.allocation);
    const view: T[] = [];
    resizeView(view, values.values, count ?? values.values.length, name);
    return view;
  }

  private replaceIndexes(name: AasLumpName, values: readonly number[] | AasHeapRecords<number>, count: number | undefined): readonly number[] {
    if (!("allocation" in values)) return values;
    this.freeAllocation(name);
    this.allocations.set(name, values.allocation);
    const view: number[] = [];
    resizeIndexView(view, values.values, count ?? values.values.length);
    return view;
  }
}
