/*
 * Route cache dump fields and CRC translated from id Software's
 * botlib/be_aas_route.c, be_aas_def.h and l_crc.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { VirtualFileSystem } from "../assets/vfs.ts";
import type { WritableBinaryFile } from "../assets/writable-files.ts";
import { BinaryError, BinaryWriter } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";
import type { AasArea, AasCluster, AasWorld } from "./aas.ts";
import type { BotMemory, BotMemoryAllocation } from "./memory.ts";
import { crc16 } from "./crc.ts";

export { crc16 as routeCacheCrc16 } from "./crc.ts";

export const ROUTE_CACHE_IDENT = 0x4352454d;
export const ROUTE_CACHE_VERSION = 2;
export const ROUTE_CACHE_HEADER_BYTES = 32;
export const ROUTING_CACHE_STRUCT_BYTES = 64;

export type AasRouteCacheReadHost = Pick<VirtualFileSystem, "openRead" | "readInto" | "closeFile"> & {
  print(type: 1 | 4, message: string): undefined;
};
export interface AasRouteCacheWriteHost {
  openWrite(filename: string): Pick<WritableBinaryFile, "writeBytes" | "close"> | null;
  print(type: 1 | 4, message: string): undefined;
}

function vector(writer: BinaryWriter, value: Vec3): void {
  writer.f32(value.x); writer.f32(value.y); writer.f32(value.z);
}

export function routeCacheAreaCrc(areas: readonly AasArea[]): number {
  let crc = 0xffff;
  for (const area of areas) {
    const writer = new BinaryWriter(48);
    writer.i32(area.areaNumber); writer.i32(area.faceCount); writer.i32(area.firstFace);
    vector(writer, area.bounds.min); vector(writer, area.bounds.max); vector(writer, area.center);
    crc = crc16(writer.finish(), crc);
  }
  return crc;
}

export function routeCacheClusterCrc(clusters: readonly AasCluster[]): number {
  let crc = 0xffff;
  for (const cluster of clusters) {
    const writer = new BinaryWriter(16);
    writer.i32(cluster.areaCount); writer.i32(cluster.reachabilityAreaCount);
    writer.i32(cluster.portalCount); writer.i32(cluster.firstPortal);
    crc = crc16(writer.finish(), crc);
  }
  return crc;
}

export function routeCacheHeader(world: AasWorld, portalCount: number, areaCount: number): Uint8Array {
  const writer = new BinaryWriter(ROUTE_CACHE_HEADER_BYTES);
  writer.i32(ROUTE_CACHE_IDENT); writer.i32(ROUTE_CACHE_VERSION);
  writer.i32(world.areas.length); writer.i32(world.clusters.length);
  writer.i32(routeCacheAreaCrc(world.areas)); writer.i32(routeCacheClusterCrc(world.clusters));
  writer.i32(portalCount); writer.i32(areaCount);
  return writer.finish();
}

export function writeRouteCacheDump(
  filename: string,
  host: AasRouteCacheWriteHost,
  header: () => Uint8Array,
  records: () => Iterable<RoutingCache, void, unknown>,
): boolean {
  const file = host.openWrite(filename);
  if (file === null) {
    host.print(4, `Unable to open file: ${filename}\n`);
    return false;
  }
  file.writeBytes(header());
  let totalSize = 0;
  for (const cache of records()) {
    file.writeBytes(cache.dumpBytes());
    totalSize = (totalSize + cache.bytes.length) | 0;
  }
  file.close();
  host.print(1, `\nroute cache written to ${filename}\n`);
  host.print(1, `written ${totalSize} bytes of routing cache\n`);
  return true;
}

/** The source's unloaded zero-count tables require no AAS allocation. */
export function writeEmptyRouteCache(filename: string, host: AasRouteCacheWriteHost): boolean {
  return writeRouteCacheDump(filename, host, () => {
    const writer = new BinaryWriter(ROUTE_CACHE_HEADER_BYTES);
    writer.i32(ROUTE_CACHE_IDENT); writer.i32(ROUTE_CACHE_VERSION);
    writer.i32(0); writer.i32(0); writer.i32(0xffff); writer.i32(0xffff);
    writer.i32(0); writer.i32(0);
    return writer.finish();
  }, () => []);
}

export type RoutingCacheKind = "area" | "portal";

/** Explicit i386 allocation with owner-scoped cache IDs in its four link words.
 * The reachability pointer is an allocation-relative offset plus one. */
export class RoutingCache {
  private scalarView: { readonly bytes: Uint8Array; readonly view: DataView } | null = null;
  private timeView: { readonly bytes: Uint8Array; readonly view: Uint16Array } | null = null;
  private reachabilityView: { readonly bytes: Uint8Array; readonly offset: number; readonly view: Uint8Array } | null = null;

  private constructor(
    private readonly memory: BotMemory,
    private readonly allocation: BotMemoryAllocation,
    readonly pointer: number,
  ) {}

  get bytes(): Uint8Array { return this.allocation.bytes; }
  private get view(): DataView {
    const bytes = this.bytes;
    if (this.scalarView?.bytes !== bytes) {
      this.scalarView = { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    }
    return this.scalarView.view;
  }
  get kind(): RoutingCacheKind {
    const type = this.view.getUint8(0);
    if (type !== 0 && type !== 1) throw new RangeError("routing cache has an invalid source type");
    return type === 0 ? "portal" : "area";
  }
  get size(): number { return this.view.getInt32(8, true); }
  get cluster(): number { return this.view.getInt32(12, true); }
  get goal(): number { return this.view.getInt32(16, true); }
  get startTravelTime(): number { return this.view.getFloat32(32, true); }
  get flags(): number { return this.view.getInt32(36, true); }
  get previous(): number { return this.view.getUint32(40, true); }
  set previous(pointer: number) { this.view.setUint32(40, pointer, true); }
  get next(): number { return this.view.getUint32(44, true); }
  set next(pointer: number) { this.view.setUint32(44, pointer, true); }
  get timePrevious(): number { return this.view.getUint32(48, true); }
  set timePrevious(pointer: number) { this.view.setUint32(48, pointer, true); }
  get timeNext(): number { return this.view.getUint32(52, true); }
  set timeNext(pointer: number) { this.view.setUint32(52, pointer, true); }
  get count(): number {
    const size = this.size, count = (size - ROUTING_CACHE_STRUCT_BYTES) / 3;
    if (size !== this.bytes.length || !Number.isInteger(count) || count < 0) {
      throw new RangeError("routing cache size does not match its source allocation");
    }
    return count;
  }
  get times(): Uint16Array {
    const bytes = this.bytes, count = this.count;
    if (this.timeView?.bytes !== bytes || this.timeView.view.length !== count) {
      this.timeView = { bytes, view: new Uint16Array(bytes.buffer, bytes.byteOffset + 60, count) };
    }
    return this.timeView.view;
  }
  get reachabilities(): Uint8Array {
    const bytes = this.bytes, count = this.count, offset = this.view.getUint32(56, true) - 1;
    if (offset < 0 || offset + count > bytes.length) throw new RangeError("routing reachabilities exceed their source allocation");
    if (this.reachabilityView?.bytes !== bytes || this.reachabilityView.offset !== offset || this.reachabilityView.view.length !== count) {
      this.reachabilityView = { bytes, offset, view: bytes.subarray(offset, offset + count) };
    }
    return this.reachabilityView.view;
  }

  /** Source cache-head aliases can expose the two header time words even at count zero. */
  timeAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("routing travel-time index must be nonnegative");
    return this.view.getUint16(60 + index * 2, true);
  }

  reachabilityAt(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("routing reachability index must be nonnegative");
    const offset = this.view.getUint32(56, true) - 1;
    if (offset < 0) throw new RangeError("routing reachability pointer is null");
    return this.view.getUint8(offset + index);
  }

  /** Process addresses and managed IDs are not portable RCD data. */
  dumpBytes(): Uint8Array { const bytes = this.bytes.slice(); bytes.fill(0, 40, 60); return bytes; }

  free(): void { this.memory.free(this.allocation); }

  setTime(time: number): void { this.view.setFloat32(4, time, true); }
  setKind(kind: RoutingCacheKind): void { this.view.setUint8(0, kind === "portal" ? 0 : 1); }

  static allocate(memory: BotMemory, cluster: number, goal: number, flags: number, origin: Vec3, count: number, pointer: number): RoutingCache {
    const size = ROUTING_CACHE_STRUCT_BYTES + count * 3;
    if (!Number.isInteger(count) || count < 0 || size > 0x7fffffff) throw new RangeError("routing cache allocation exceeds source signed size");
    const allocation = memory.allocate(size, "heap", true), bytes = allocation.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setInt32(8, size, true); view.setInt32(12, cluster, true); view.setInt32(16, goal, true);
    view.setFloat32(20, origin.x, true); view.setFloat32(24, origin.y, true); view.setFloat32(28, origin.z, true);
    view.setFloat32(32, 1, true); view.setInt32(36, flags, true);
    view.setUint32(56, ROUTING_CACHE_STRUCT_BYTES + count * 2 + 1, true);
    return new RoutingCache(memory, allocation, pointer);
  }

  static fromDump(memory: BotMemory, allocation: BotMemoryAllocation, expectedKind: RoutingCacheKind, source: string, offset: number, pointer: number): RoutingCache {
    const bytes = allocation.bytes;
    if (bytes.length < ROUTING_CACHE_STRUCT_BYTES) throw new BinaryError(source, offset, "truncated routing cache struct");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getInt32(8, true), count = (size - ROUTING_CACHE_STRUCT_BYTES) / 3;
    if (size !== bytes.length || !Number.isInteger(count) || count < 0) {
      throw new BinaryError(source, offset + 8, "routing cache size does not match the i386 writer allocation");
    }
    if (view.getUint8(0) !== (expectedKind === "portal" ? 0 : 1)) {
      throw new BinaryError(source, offset, "routing cache type does not match its dump section");
    }
    // Repair the native process-address fields. The source reader's relocation
    // expression also points two bytes before the writer's reachability array.
    bytes.fill(0, 40, 60);
    view.setUint32(56, ROUTING_CACHE_STRUCT_BYTES + count * 2 + 1, true);
    return new RoutingCache(memory, allocation, pointer);
  }
}
