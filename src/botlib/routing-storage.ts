/*
 * Routing graph and update allocations translated from id Software's
 * botlib/be_aas_route.c and be_aas_def.h, using the release i386 layouts.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Vec3 } from "../core/math.ts";
import type { AasAreaSettings, AasWorld } from "./aas.ts";
import type { BotMemory, BotMemoryAllocation } from "./memory.ts";

export const ROUTING_START_TIME_POINTER = 0xffffffff;

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`routing index ${index} outside ${values.length} entries`);
  return value;
}

export function areaContentsTravelFlags(settings: AasAreaSettings): number {
  const contents = settings.contents;
  let flags = (contents & 1) !== 0 ? 0x00100000
    : (contents & 4) !== 0 ? 0x00200000 : (contents & 2) !== 0 ? 0x00400000 : 0x00080000;
  if ((contents & 256) !== 0) flags |= 0x00800000;
  if ((contents & 2048) !== 0) flags |= 0x08000000;
  if ((contents & 4096) !== 0) flags |= 0x10000000;
  if ((settings.flags & 16) !== 0) flags |= 0x04000000;
  return flags;
}

export function routingAreaTravelTime(settings: AasAreaSettings, start: Vec3, end: Vec3): number {
  const f = Math.fround;
  const x = f(f(start.x) - f(end.x));
  const y = f(f(start.y) - f(end.y));
  const z = f(f(start.z) - f(end.z));
  const distance = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
  const factor = (settings.presenceType & 2) === 0 ? f(1.3) : (settings.flags & 4) !== 0 ? 1 : f(0.33);
  const value = Math.trunc(f(distance * factor));
  if (!Number.isFinite(value) || value > 0x7fffffff) throw new RangeError("area travel distance exceeds source int range");
  return Math.max(1, value) & 0xffff;
}

class RoutingBlock {
  private readonly data: DataView;

  constructor(private readonly memory: BotMemory, private readonly allocation: BotMemoryAllocation) {
    const bytes = allocation.bytes;
    this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get bytes(): Uint8Array { return this.allocation.bytes; }
  get view(): DataView { this.allocation.bytes; return this.data; }
  free(): void { this.memory.free(this.allocation); }
}

/** Pointer words use byte-offset-plus-one within their owning allocation.
 * The stack seed has its own sentinel; these are managed references, not addresses. */
export class RoutingUpdate {
  constructor(private readonly table: RoutingUpdateTable, readonly offset: number) {}

  get cluster(): number { return this.table.view.getInt32(this.offset, true); }
  set cluster(value: number) { this.table.view.setInt32(this.offset, value, true); }
  get area(): number { return this.table.view.getInt32(this.offset + 4, true); }
  set area(value: number) { this.table.view.setInt32(this.offset + 4, value, true); }
  get time(): number { return this.table.view.getUint16(this.offset + 20, true); }
  set time(value: number) { this.table.view.setUint16(this.offset + 20, value, true); }
  get areaTimesPointer(): number { return this.table.view.getUint32(this.offset + 24, true); }
  set areaTimesPointer(value: number) { this.table.view.setUint32(this.offset + 24, value, true); }
  get inList(): boolean { return this.table.view.getInt32(this.offset + 28, true) !== 0; }
  set inList(value: boolean) { this.table.view.setInt32(this.offset + 28, value ? 1 : 0, true); }
  get next(): RoutingUpdate | null { return this.table.resolve(this.table.view.getUint32(this.offset + 32, true)); }
  set next(value: RoutingUpdate | null) { this.table.view.setUint32(this.offset + 32, this.table.pointer(value), true); }
  get prev(): RoutingUpdate | null { return this.table.resolve(this.table.view.getUint32(this.offset + 36, true)); }
  set prev(value: RoutingUpdate | null) { this.table.view.setUint32(this.offset + 36, this.table.pointer(value), true); }
}

export class RoutingUpdateTable {
  private readonly records = new Map<number, RoutingUpdate>();

  constructor(private readonly block: RoutingBlock) {}

  get view(): DataView { return this.block.view; }
  free(): void { this.block.free(); }

  at(index: number): RoutingUpdate {
    const offset = index * 40;
    if (!Number.isInteger(index) || index < 0 || offset + 40 > this.view.byteLength) {
      throw new RangeError("routing update index exceeds its source allocation");
    }
    let record = this.records.get(offset);
    if (record === undefined) { record = new RoutingUpdate(this, offset); this.records.set(offset, record); }
    return record;
  }

  resolve(pointer: number): RoutingUpdate | null {
    return pointer === 0 ? null : this.at((pointer - 1) / 40);
  }

  pointer(record: RoutingUpdate | null): number {
    if (record === null) return 0;
    if (this.records.get(record.offset) !== record) throw new Error("routing update link belongs to another allocation");
    return record.offset + 1;
  }
}

export interface ReversedReachability { readonly area: number; readonly reachability: number }

/** These are the independently replaced aasworld pointers. Assignment follows
 * allocation, so an abort retains each previously published or freed pointer. */
export class RoutingStorage {
  private contents: RoutingBlock | null = null;
  private areas: RoutingUpdateTable | null = null;
  private portals: RoutingUpdateTable | null = null;
  private reversed: RoutingBlock | null = null;
  private clusterHeads: RoutingBlock | null = null;
  private portalHeads: RoutingBlock | null = null;
  private times: RoutingBlock | null = null;
  private maxima: RoutingBlock | null = null;
  private crossings: RoutingBlock | null = null;
  private crossingIndex: RoutingBlock | null = null;

  constructor(private readonly world: AasWorld, private readonly memory: BotMemory) {}

  private allocate(size: number): RoutingBlock {
    return new RoutingBlock(this.memory, this.memory.allocate(size, "heap", true));
  }

  initializeContents(): void {
    if (this.contents !== null) this.contents.free();
    this.contents = this.allocate(this.world.areas.length * 4);
    for (let area = 0; area < this.world.areas.length; area++) {
      this.contents.view.setInt32(area * 4, areaContentsTravelFlags(at(this.world.areaSettings, area)), true);
    }
  }

  contentsFlags(area: number): number {
    if (this.contents === null) throw new Error("routing contents flags have not been initialized");
    return this.contents.view.getInt32(area * 4, true);
  }

  initializeUpdates(): void {
    if (this.areas !== null) this.areas.free();
    let maximum = 0;
    for (const cluster of this.world.clusters) maximum = Math.max(maximum, cluster.reachabilityAreaCount);
    this.areas = new RoutingUpdateTable(this.allocate(maximum * 40));
    if (this.portals !== null) this.portals.free();
    this.portals = new RoutingUpdateTable(this.allocate((this.world.portals.length + 1) * 40));
  }

  get areaUpdates(): RoutingUpdateTable {
    if (this.areas === null) throw new Error("area routing updates have not been initialized");
    return this.areas;
  }
  get portalUpdates(): RoutingUpdateTable {
    if (this.portals === null) throw new Error("portal routing updates have not been initialized");
    return this.portals;
  }

  initializeReversed(diagnostics?: { readonly print: (severity: 2, text: string) => undefined }): void {
    if (this.reversed !== null) this.reversed.free();
    const headBytes = this.world.areas.length * 8;
    this.reversed = this.allocate(headBytes + this.world.reachability.length * 12);
    const block = this.reversed;
    let cursor = headBytes;
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = at(this.world.areaSettings, area);
      if (settings.reachableAreaCount >= 128) diagnostics?.print(2, `area ${area} has more than 128 reachabilities\n`);
      for (let offset = 0; offset < settings.reachableAreaCount && offset < 128; offset++) {
        const reachability = settings.firstReachableArea + offset;
        const destination = at(this.world.reachability, reachability).area, head = destination * 8;
        const view = block.view;
        view.setInt32(cursor, reachability, true); view.setInt32(cursor + 4, area, true);
        view.setUint32(cursor + 8, view.getUint32(head + 4, true), true);
        view.setUint32(head + 4, cursor + 1, true);
        view.setInt32(head, view.getInt32(head, true) + 1, true);
        cursor += 12;
      }
    }
  }

  reversedCount(area: number): number {
    if (this.reversed === null) throw new Error("reversed reachability has not been initialized");
    return this.reversed.view.getInt32(area * 8, true);
  }

  *incoming(area: number): Generator<ReversedReachability, void, unknown> {
    const block = this.reversed;
    if (block === null) throw new Error("reversed reachability has not been initialized");
    const headBytes = this.world.areas.length * 8;
    let pointer = block.view.getUint32(area * 8 + 4, true), remaining = this.world.reachability.length;
    while (pointer !== 0) {
      const offset = pointer - 1, view = block.view;
      if (--remaining < 0 || offset < headBytes || (offset - headBytes) % 12 !== 0 || offset + 12 > view.byteLength) {
        throw new RangeError("reversed reachability contains an invalid managed link");
      }
      yield { reachability: view.getInt32(offset, true), area: view.getInt32(offset + 4, true) };
      pointer = block.view.getUint32(offset + 8, true);
    }
  }

  /** AAS_InitClusterAreaCache does not free the previous pointer on reentry. */
  initializeClusterCacheHeads(): void {
    let size = this.world.clusters.length * 4;
    for (const cluster of this.world.clusters) size += cluster.areaCount * 4;
    this.clusterHeads = this.allocate(size);
    const view = this.clusterHeads.view;
    let offset = this.world.clusters.length * 4;
    for (const [index, cluster] of this.world.clusters.entries()) {
      view.setUint32(index * 4, offset + 1, true);
      offset += cluster.areaCount * 4;
    }
  }

  initializePortalCacheHeads(): void {
    this.portalHeads = this.allocate(this.world.areas.length * 4);
  }

  get hasClusterCacheHeads(): boolean { return this.clusterHeads !== null; }
  get hasPortalCacheHeads(): boolean { return this.portalHeads !== null; }

  clusterCacheHead(cluster: number, area: number): number {
    if (this.clusterHeads === null) throw new Error("cluster cache heads have not been initialized");
    const view = this.clusterHeads.view, row = view.getUint32(cluster * 4, true);
    if (row === 0) throw new RangeError("cluster cache row contains a null managed pointer");
    return view.getUint32(row - 1 + area * 4, true);
  }

  setClusterCacheHead(cluster: number, area: number, pointer: number): void {
    if (this.clusterHeads === null) throw new Error("cluster cache heads have not been initialized");
    const view = this.clusterHeads.view, row = view.getUint32(cluster * 4, true);
    if (row === 0) throw new RangeError("cluster cache row contains a null managed pointer");
    view.setUint32(row - 1 + area * 4, pointer, true);
  }

  portalCacheHead(area: number): number {
    if (this.portalHeads === null) throw new Error("portal cache heads have not been initialized");
    return this.portalHeads.view.getUint32(area * 4, true);
  }

  setPortalCacheHead(area: number, pointer: number): void {
    if (this.portalHeads === null) throw new Error("portal cache heads have not been initialized");
    this.portalHeads.view.setUint32(area * 4, pointer, true);
  }

  freeClusterCacheHeads(): void {
    if (this.clusterHeads !== null) { this.clusterHeads.free(); this.clusterHeads = null; }
  }

  freePortalCacheHeads(): void {
    if (this.portalHeads !== null) { this.portalHeads.free(); this.portalHeads = null; }
  }

  initializeAreaTravelTimes(maximumTravelTimeBytes = 64 * 1024 * 1024): void {
    if (this.times !== null) this.times.free();
    if (!Number.isSafeInteger(maximumTravelTimeBytes) || maximumTravelTimeBytes < 0) {
      throw new RangeError("invalid area travel-time allocation limit");
    }
    let size = this.world.areas.length * 4, timingBytes = 0;
    for (let area = 0; area < this.world.areas.length; area++) {
      const outgoing = at(this.world.areaSettings, area).reachableAreaCount;
      const bytes = outgoing * this.reversedCount(area) * 2;
      timingBytes += bytes; size += outgoing * 4 + bytes;
      if (!Number.isSafeInteger(size) || size > 0x7fffffff
        || (this.memory.zone === undefined && timingBytes > maximumTravelTimeBytes)) {
        throw new RangeError("area travel-time allocation limit exceeded");
      }
    }
    this.times = this.allocate(size);
    const view = this.times.view;
    let cursor = this.world.areas.length * 4;
    for (let area = 0; area < this.world.areas.length; area++) {
      const settings = at(this.world.areaSettings, area), count = this.reversedCount(area);
      const pointers = cursor;
      view.setUint32(area * 4, pointers + 1, true);
      cursor += settings.reachableAreaCount * 4;
      for (let outgoing = 0; outgoing < settings.reachableAreaCount; outgoing++) {
        view.setUint32(pointers + outgoing * 4, cursor + 1, true);
        const start = at(this.world.reachability, settings.firstReachableArea + outgoing).start;
        let ordinal = 0;
        for (const link of this.incoming(area)) {
          view.setUint16(cursor + ordinal++ * 2,
            routingAreaTravelTime(settings, at(this.world.reachability, link.reachability).end, start), true);
        }
        cursor += count * 2;
      }
    }
  }

  areaTimePointer(area: number, outgoing: number): number {
    if (this.times === null) throw new Error("area travel times have not been initialized");
    const view = this.times.view, pointers = view.getUint32(area * 4, true);
    if (pointers === 0) throw new RangeError("area travel-time table contains a null managed pointer");
    return view.getUint32(pointers - 1 + outgoing * 4, true);
  }

  areaTime(pointer: number, ordinal: number, startTimes: Uint16Array): number {
    if (pointer === ROUTING_START_TIME_POINTER) {
      const time = startTimes[ordinal];
      if (time === undefined) throw new RangeError("routing seed index exceeds its stack allocation");
      return time;
    }
    if (this.times === null) throw new Error("area travel times have not been initialized");
    if (pointer === 0) throw new RangeError("area travel-time row contains a null managed pointer");
    return this.times.view.getUint16(pointer - 1 + ordinal * 2, true);
  }

  areaTimeRow(area: number, outgoing: number): Uint16Array {
    const pointer = this.areaTimePointer(area, outgoing);
    if (this.times === null || pointer === 0) throw new RangeError("area travel-time row contains a null managed pointer");
    const bytes = this.times.bytes;
    return new Uint16Array(bytes.buffer, bytes.byteOffset + pointer - 1, this.reversedCount(area));
  }

  initializePortalMaxima(): void {
    if (this.maxima !== null) this.maxima.free();
    this.maxima = this.allocate(this.world.portals.length * 4);
    for (const [index, portal] of this.world.portals.entries()) {
      let maximum = 0;
      const settings = at(this.world.areaSettings, portal.area);
      for (let outgoing = 0; outgoing < settings.reachableAreaCount; outgoing++) {
        for (const time of this.areaTimeRow(portal.area, outgoing)) maximum = Math.max(maximum, time);
      }
      this.maxima.view.setInt32(index * 4, maximum, true);
    }
  }

  portalMaximum(portal: number): number {
    if (this.maxima === null) throw new Error("portal maximum travel times have not been initialized");
    return this.maxima.view.getInt32(portal * 4, true);
  }

  /** Both allocations precede tracing; failures retain the published prefix. */
  initializeCrossings(): void {
    if (this.crossings !== null) this.crossings.free();
    if (this.crossingIndex !== null) this.crossingIndex.free();
    this.crossings = this.allocate(this.world.reachability.length * 8);
    this.crossingIndex = this.allocate(this.world.reachability.length * 32 * 4);
  }

  get hasCrossings(): boolean { return this.crossings !== null; }

  writeCrossings(reachability: number, first: number, areas: readonly { readonly area: number }[]): number {
    if (this.crossings === null || this.crossingIndex === null) throw new Error("reachability areas have not been initialized");
    this.crossings.view.setInt32(reachability * 8, first, true);
    this.crossings.view.setInt32(reachability * 8 + 4, areas.length, true);
    for (const crossing of areas) this.crossingIndex.view.setInt32(first++ * 4, crossing.area, true);
    return first;
  }

  crossingCount(reachability: number): number {
    if (this.crossings === null) throw new Error("reachability areas have not been initialized");
    return this.crossings.view.getInt32(reachability * 8 + 4, true);
  }

  crossingArea(reachability: number, ordinal: number): number {
    if (this.crossings === null || this.crossingIndex === null) throw new Error("reachability areas have not been initialized");
    const first = this.crossings.view.getInt32(reachability * 8, true);
    return this.crossingIndex.view.getInt32((first + ordinal) * 4, true);
  }

  freeGraphAndUpdates(): void {
    if (this.times !== null) { this.times.free(); this.times = null; }
    if (this.maxima !== null) { this.maxima.free(); this.maxima = null; }
    if (this.reversed !== null) { this.reversed.free(); this.reversed = null; }
    if (this.areas !== null) { this.areas.free(); this.areas = null; }
    if (this.portals !== null) { this.portals.free(); this.portals = null; }
  }

  freeContents(): void {
    if (this.contents !== null) { this.contents.free(); this.contents = null; }
  }

  freeCrossings(): void {
    if (this.crossings !== null) { this.crossings.free(); this.crossings = null; }
    if (this.crossingIndex !== null) { this.crossingIndex.free(); this.crossingIndex = null; }
  }
}
