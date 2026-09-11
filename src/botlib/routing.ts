/*
 * AAS routing translated from id Software's code/botlib/be_aas_route.c
 * and be_aas_routealt.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Vec3 } from "../core/math.ts";
import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { AasAreaSettings, AasReachability, AasWorld } from "./aas.ts";
import { AasWorldState } from "./aas-world.ts";
import { BotMemory } from "./memory.ts";
import type { BotMemoryAllocation } from "./memory.ts";
import { ROUTING_START_TIME_POINTER, RoutingStorage, routingAreaTravelTime } from "./routing-storage.ts";
import type { ReversedReachability, RoutingUpdate } from "./routing-storage.ts";
import { AasHideRouting, aasNextModelReachability, aasRandomGoalArea } from "./aas-route-queries.ts";
import type { AasGoalPosition } from "./spatial.ts";
export { areaContentsTravelFlags } from "./routing-storage.ts";
export type { ReversedReachability } from "./routing-storage.ts";
import type { AasSpatial } from "./spatial.ts";
import { ROUTE_CACHE_HEADER_BYTES, ROUTE_CACHE_IDENT, ROUTE_CACHE_VERSION, ROUTING_CACHE_STRUCT_BYTES,
  RoutingCache, routeCacheAreaCrc, routeCacheClusterCrc, routeCacheHeader, writeRouteCacheDump } from "./aas-route-cache.ts";
import type { AasRouteCacheReadHost, AasRouteCacheWriteHost, RoutingCacheKind } from "./aas-route-cache.ts";
export type { AasRouteCacheReadHost, AasRouteCacheWriteHost } from "./aas-route-cache.ts";

export const TravelType = Object.freeze({
  INVALID: 1, WALK: 2, CROUCH: 3, BARRIERJUMP: 4, JUMP: 5, LADDER: 6,
  WALKOFFLEDGE: 7, SWIM: 8, WATERJUMP: 9, TELEPORT: 10, ELEVATOR: 11,
  ROCKETJUMP: 12, BFGJUMP: 13, GRAPPLEHOOK: 14, DOUBLEJUMP: 15,
  RAMPJUMP: 16, STRAFEJUMP: 17, JUMPPAD: 18, FUNCBOB: 19,
  MASK: 0xffffff, NOTTEAM1: 1 << 24, NOTTEAM2: 2 << 24,
});

export const TravelFlags = Object.freeze({
  INVALID: 0x00000001, WALK: 0x00000002, CROUCH: 0x00000004,
  BARRIERJUMP: 0x00000008, JUMP: 0x00000010, LADDER: 0x00000020,
  WALKOFFLEDGE: 0x00000080, SWIM: 0x00000100, WATERJUMP: 0x00000200,
  TELEPORT: 0x00000400, ELEVATOR: 0x00000800, ROCKETJUMP: 0x00001000,
  BFGJUMP: 0x00002000, GRAPPLEHOOK: 0x00004000, DOUBLEJUMP: 0x00008000,
  RAMPJUMP: 0x00010000, STRAFEJUMP: 0x00020000, JUMPPAD: 0x00040000,
  AIR: 0x00080000, WATER: 0x00100000, SLIME: 0x00200000, LAVA: 0x00400000,
  DONOTENTER: 0x00800000, FUNCBOB: 0x01000000, FLIGHT: 0x02000000,
  BRIDGE: 0x04000000, NOTTEAM1: 0x08000000, NOTTEAM2: 0x10000000,
  DEFAULT: 0x011c0fbe,
});

const TYPE_FLAGS: readonly number[] = [
  TravelFlags.INVALID, TravelFlags.INVALID, TravelFlags.WALK, TravelFlags.CROUCH,
  TravelFlags.BARRIERJUMP, TravelFlags.JUMP, TravelFlags.LADDER, TravelFlags.WALKOFFLEDGE,
  TravelFlags.SWIM, TravelFlags.WATERJUMP, TravelFlags.TELEPORT, TravelFlags.ELEVATOR,
  TravelFlags.ROCKETJUMP, TravelFlags.BFGJUMP, TravelFlags.GRAPPLEHOOK, TravelFlags.DOUBLEJUMP,
  TravelFlags.RAMPJUMP, TravelFlags.STRAFEJUMP, TravelFlags.JUMPPAD, TravelFlags.FUNCBOB,
];

/** The source's lines 174-178 test zero tfl, so reachability team bits are ignored. */
export function travelFlagForType(travelType: number): number {
  const flag = TYPE_FLAGS[travelType & TravelType.MASK];
  return flag === undefined ? TravelFlags.INVALID : flag;
}

function finiteVector(vector: Vec3): void {
  if (!Number.isFinite(Math.fround(vector.x)) || !Number.isFinite(Math.fround(vector.y))
    || !Number.isFinite(Math.fround(vector.z))) throw new RangeError("routing position must contain finite float32 coordinates");
}

/** Source hundredths of a second, including float32 operations and unsigned-short storage. */
export function areaTravelTime(settings: AasAreaSettings, start: Vec3, end: Vec3): number {
  finiteVector(start);
  finiteVector(end);
  return routingAreaTravelTime(settings, start, end);
}

function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`routing index ${index} outside ${values.length} entries`);
  return value;
}

function scalar(values: Uint16Array | Uint8Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`routing index ${index} outside ${values.length} entries`);
  return value;
}

export interface RoutingGraph {
  readonly reversedReachabilities: readonly (readonly ReversedReachability[])[];
  /** Area, outgoing reachability offset, incoming reversed-link ordinal. */
  readonly areaTravelTimes: readonly (readonly Uint16Array[])[];
  readonly portalMaxTravelTimes: Uint16Array;
  /** The original router ignores outgoing links after the first 128 in an area. */
  readonly truncatedReachabilityAreas: readonly number[];
}

export function precomputeRouting(world: AasWorld, maximumTravelTimeBytes = 64 * 1024 * 1024): RoutingGraph {
  if (!Number.isSafeInteger(maximumTravelTimeBytes) || maximumTravelTimeBytes < 0) throw new RangeError("invalid area travel-time allocation limit");
  const storage = new RoutingStorage(world, new BotMemory());
  storage.initializeReversed(); storage.initializeAreaTravelTimes(maximumTravelTimeBytes); storage.initializePortalMaxima();
  // Diagnostic callers retain the existing array projection. Runtime queries
  // use RoutingStorage directly, including its live counts and pointer words.
  return {
    reversedReachabilities: world.areas.map((_, area) => [...storage.incoming(area)]),
    areaTravelTimes: world.areas.map((_, area) => Array.from(
      { length: item(world.areaSettings, area).reachableAreaCount }, (_, outgoing) => storage.areaTimeRow(area, outgoing))),
    portalMaxTravelTimes: Uint16Array.from(world.portals, (_, portal) => storage.portalMaximum(portal)),
    truncatedReachabilityAreas: world.areaSettings.flatMap((settings, area) => area > 0 && settings.reachableAreaCount > 128 ? [area] : []),
  };
}

export interface RouteQuery {
  readonly area: number;
  /** Required: the source reads an uninitialized reachnum for intercluster queries with a null origin. */
  readonly origin: Vec3;
  readonly goalArea: number;
  readonly travelFlags: number;
}
export type AreaTravelTimeQuery = Omit<RouteQuery, "origin"> & { readonly origin: Vec3 | null };
export const AlternativeRouteType = Object.freeze({ ALL: 1, CLUSTER_PORTALS: 2, VIEW_PORTALS: 4 });
export interface AlternativeRouteQuery {
  readonly start: Vec3;
  readonly startArea: number;
  /** The original parameter is unused; its coordinates are never read. */
  readonly goal: Vec3;
  readonly goalArea: number;
  readonly travelFlags: number;
  /** Checked after publishing each goal, so zero and negative limits can yield one. */
  readonly maximumGoals: number;
  readonly type: number;
}
export interface AlternativeGoal {
  readonly origin: Vec3;
  /** Zero is the source fallback when no distance is less than 999999. */
  readonly area: number;
  readonly startTravelTime: number;
  readonly goalTravelTime: number;
  readonly extraTravelTime: number;
}
export interface AlternativeRoutingLog { write(text: string): void }

/** be_aas_routealt.c owns two independent GetMemory allocations. */
class AlternativeRoutingScratch {
  private midrange: BotMemoryAllocation | null = null;
  private clusters: BotMemoryAllocation | null = null;
  private midrangeData: DataView | null = null;
  private clusterData: DataView | null = null;
  private output: AlternativeRoutingLog | null = null;

  constructor(private readonly memory: BotMemory) {}

  initialize(count: number, log: AlternativeRoutingLog): void {
    if (this.midrange !== null) this.memory.free(this.midrange);
    this.midrange = this.memory.allocate(count * 8, "heap", false);
    this.midrangeData = null;
    if (this.clusters !== null) this.memory.free(this.clusters);
    this.clusters = this.memory.allocate(count * 4, "heap", false);
    this.clusterData = null;
    this.output = log;
  }

  shutdown(): void {
    if (this.midrange !== null) { this.memory.free(this.midrange); this.midrange = null; this.midrangeData = null; }
    if (this.clusters !== null) { this.memory.free(this.clusters); this.clusters = null; this.clusterData = null; }
    this.output = null;
  }

  private get midrangeBytes(): Uint8Array {
    if (this.midrange === null) throw new Error("alternative routing has not been initialized");
    return this.midrange.bytes;
  }
  private get midrangeView(): DataView {
    const bytes = this.midrangeBytes;
    return this.midrangeData ??= new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private get clusterView(): DataView {
    if (this.clusters === null) throw new Error("alternative routing cluster allocation has not been initialized");
    const bytes = this.clusters.bytes;
    return this.clusterData ??= new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  clear(): void { this.midrangeBytes.fill(0); }
  valid(area: number): boolean { return this.midrangeView.getInt32(area * 8, true) !== 0; }
  invalidate(area: number): void { this.midrangeView.setInt32(area * 8, 0, true); }
  startTime(area: number): number { return this.midrangeView.getUint16(area * 8 + 4, true); }
  goalTime(area: number): number { return this.midrangeView.getUint16(area * 8 + 6, true); }
  setCandidate(area: number, startTime: number, goalTime: number): void {
    const view = this.midrangeView, offset = area * 8;
    view.setInt32(offset, 1, true);
    view.setUint16(offset + 4, startTime, true);
    view.setUint16(offset + 6, goalTime, true);
  }
  clusterArea(index: number): number { return this.clusterView.getInt32(index * 4, true); }
  setClusterArea(index: number, area: number): void { this.clusterView.setInt32(index * 4, area, true); }
  log(text: string): void {
    if (this.output === null) throw new Error("alternative routing has not been initialized");
    this.output.write(text);
  }
}
export type RouteResult = { readonly kind: "found"; readonly travelTime: number; readonly nextReachability: number }
  | { readonly kind: "unreachable" };
export const RouteStopEvent = Object.freeze({
  NONE: 0, NO_ROUTE: 1, USE_TRAVEL_TYPE: 2, ENTER_CONTENTS: 4, ENTER_AREA: 8,
});
export interface PredictRouteQuery extends RouteQuery {
  readonly maximumAreas: number;
  readonly maximumTime: number;
  readonly stopEvent: number;
  readonly stopContents: number;
  readonly stopTravelFlags: number;
  readonly stopArea: number;
}
/** All fields written by AAS_PredictRoute, plus its return value. The full-export
 * caller retains numareas separately: the source never writes that field. */
export interface PredictedRoute {
  readonly succeeded: boolean;
  readonly stopEvent: number;
  readonly endArea: number;
  readonly endContents: number;
  readonly endTravelFlags: number;
  readonly endPosition: Vec3;
  readonly time: number;
}
export type AasRoutePredictionOutput = {
  -readonly [Field in keyof Omit<PredictedRoute, "succeeded">]: PredictedRoute[Field];
};

/** Source initialization leaves numareas untouched and can alias origin. */
export function initializeAasRoutePrediction(query: PredictRouteQuery, output: AasRoutePredictionOutput): void {
  output.stopEvent = RouteStopEvent.NONE;
  output.endArea = query.goalArea;
  output.endContents = 0;
  output.endTravelFlags = 0;
  output.endPosition = query.origin;
  output.time = 0;
}
type RouteEvaluation = RouteResult | { readonly kind: "time-only"; readonly travelTime: number };
export interface RoutingOptions {
  readonly milliseconds?: () => number;
  readonly routingDebug?: AasRoutingDebug;
  readonly alternativeRouteDebug?: AasAlternativeRouteDebug;
  readonly maximumTravelTimeBytes?: number;
  readonly memory?: BotMemory;
  readonly hideRouting?: AasHideRouting;
  readonly host?: {
    readonly initialized: () => boolean;
    readonly developer: () => boolean;
    readonly print: (severity: 2 | 3, text: string) => undefined;
  };
}

export interface AasRoutingDebug {
  readonly milliseconds: () => number;
  readonly print: (severity: 1, text: string) => undefined;
}

export interface AasAlternativeRouteDebug extends AasRoutingDebug {
  readonly showAreaPolygons: (world: AasWorld, area: number, color: number, groundOnly: boolean) => void;
}

interface InitializedRouting {
  /** Diagnostic compositions without a common zone enforce this managed cap.
   * The source initializes max_routingcachesize but never reads it. */
  readonly maximumCacheBytes: number;
  readonly time: () => number;
}
// Each area/portal has one update record; queue storage stays bounded when a
// better cost requeues an already-processed record, as in the source linked list.
class UpdateQueue {
  private first: RoutingUpdate | null;
  private last: RoutingUpdate | null;

  constructor(first: RoutingUpdate) {
    first.next = null; first.prev = null;
    this.first = this.last = first;
  }

  push(value: RoutingUpdate): void {
    value.next = null;
    value.prev = this.last;
    if (this.last === null) this.first = value;
    else this.last.next = value;
    this.last = value;
    value.inList = true;
  }

  shift(): RoutingUpdate | null {
    const value = this.first;
    if (value === null) return null;
    this.first = value.next;
    if (this.first === null) this.last = null;
    else this.first.prev = null;
    value.inList = false;
    return value;
  }
}

/** Source cluster/portal caches, with independent disabled-area state and FIFO relaxation order. */
export class AasRouting {
  private initializedRouting: InitializedRouting | null = null;
  private readonly enabled: Uint8Array;
  private readonly maximumTravelTimeBytes: number | undefined;
  private readonly host: RoutingOptions["host"];
  private readonly memory: BotMemory;
  private readonly storage: RoutingStorage;
  // This registry resolves managed pointer IDs only. Membership and ordering
  // are read from the actual source head tables and cache link words.
  private readonly cachePointers = new Map<number, RoutingCache>();
  private readonly retiredCachePointers: number[] = [];
  private nextCachePointer = 1;
  private oldestCache = 0;
  private newestCache = 0;
  private allocatedBytes = 0;
  private areaUpdates = 0;
  private portalUpdates = 0;
  private currentFrameRoutingUpdates = 0;
  private readonly alternativeScratch: AlternativeRoutingScratch;
  private readonly hideRouting: AasHideRouting;
  private alternativeClusterCount = 0;
  private readonly routingDebug: AasRoutingDebug | undefined;
  private readonly milliseconds: (() => number) | undefined;
  private readonly alternativeRouteDebug: AasAlternativeRouteDebug | undefined;

  constructor(private readonly world: AasWorld, options: RoutingOptions = {}) {
    this.maximumTravelTimeBytes = options.maximumTravelTimeBytes;
    this.host = options.host;
    this.routingDebug = options.routingDebug;
    this.milliseconds = options.milliseconds ?? options.routingDebug?.milliseconds;
    this.alternativeRouteDebug = options.alternativeRouteDebug;
    this.memory = options.memory ?? new BotMemory();
    this.hideRouting = options.hideRouting ?? new AasHideRouting(this.memory);
    this.storage = new RoutingStorage(world, this.memory);
    this.alternativeScratch = new AlternativeRoutingScratch(this.memory);
    this.enabled = Uint8Array.from(world.areaSettings, settings => (settings.flags & 8) === 0 ? 1 : 0);
  }

  /** AAS_InitRouting, reached by AAS_ContinueInit on this retained owner. */
  initializeRouting(spatial: AasSpatial, maximumCacheBytes: () => number, routingTime: () => number): void {
    if (spatial.world !== this.world) throw new Error("routing and spatial owners must share the same AAS world");
    this.initializedRouting = null;
    this.storage.initializeContents();
    this.storage.initializeUpdates();
    const reversedStart = this.routingDebug?.milliseconds();
    this.storage.initializeReversed(this.host);
    if (this.routingDebug !== undefined && reversedStart !== undefined) {
      this.routingDebug.print(1, `reversed reachability ${(this.routingDebug.milliseconds() - reversedStart) | 0} msec\n`);
    }
    this.storage.initializeClusterCacheHeads();
    this.storage.initializePortalCacheHeads();
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = item(this.world.areaSettings, area);
      if (settings.cluster > 0) this.clusterCacheArea(settings.cluster, area);
      else if (settings.cluster < 0) {
        const portal = item(this.world.portals, -settings.cluster);
        this.clusterCacheArea(portal.frontCluster, area);
        this.clusterCacheArea(portal.backCluster, area);
      }
    }
    const travelStart = this.milliseconds?.();
    this.storage.initializeAreaTravelTimes(this.maximumTravelTimeBytes);
    if (this.routingDebug !== undefined && travelStart !== undefined) {
      this.routingDebug.print(1, `area travel times ${(this.routingDebug.milliseconds() - travelStart) | 0} msec\n`);
    }
    this.storage.initializePortalMaxima();
    this.initializeReachabilityAreas(spatial);
    this.areaUpdates = 0;
    this.portalUpdates = 0;
    this.allocatedBytes = 0;
    const cacheBytes = maximumCacheBytes();
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new RangeError("invalid routing cache allocation limit");
    this.initializedRouting = { maximumCacheBytes: cacheBytes, time: routingTime };
  }

  get frameRoutingUpdates(): number { return this.currentFrameRoutingUpdates; }

  nearestHideArea(origin: Vec3, area: number, enemyOrigin: Vec3, enemyArea: number, travelFlags: number): number {
    return this.hideRouting.nearestHideArea(this.world, this.storage, origin, area, enemyOrigin, enemyArea, travelFlags);
  }

  nextModelReachability(previous: number, model: number): number {
    return aasNextModelReachability(this.world, previous, model);
  }

  randomGoalArea(spatial: AasSpatial, area: number, travelFlags: number, random: () => number,
    log: (text: string) => void): AasGoalPosition | null {
    return aasRandomGoalArea(spatial, this, area, travelFlags, random, log);
  }

  resetFrameRoutingUpdates(): void { this.currentFrameRoutingUpdates = 0; }

  get cacheStatistics(): { readonly areaUpdates: number; readonly portalUpdates: number; readonly entries: number; readonly bytes: number } {
    let entries = 0;
    for (const _cache of this.areaCacheRecords()) entries++;
    for (const _cache of this.portalCacheRecords()) entries++;
    return { areaUpdates: this.areaUpdates, portalUpdates: this.portalUpdates,
      entries, bytes: this.allocatedBytes };
  }

  private validArea(area: number): boolean { return Number.isInteger(area) && area > 0 && area < this.world.areas.length; }

  private routingData(): InitializedRouting {
    const routing = this.initializedRouting;
    if (routing === null) throw new Error("routing has not been initialized");
    return routing;
  }

  isAreaEnabled(area: number): boolean {
    return this.validArea(area) && this.areaEnabled(area);
  }

  private areaEnabled(area: number): boolean {
    return this.world instanceof AasWorldState ? (item(this.world.areaSettings, area).flags & 8) === 0
      : scalar(this.enabled, area) !== 0;
  }

  /** Returns the previous enabled state, as AAS_EnableRoutingArea does. */
  setAreaEnabled(area: number, enabled: boolean): boolean {
    if (!this.validArea(area)) return false;
    const previous = this.areaEnabled(area);
    if (previous === enabled) return previous;
    if (this.world instanceof AasWorldState) {
      const settings = this.world.areaSettingsRecord(area);
      settings.flags = enabled ? settings.flags & ~8 : settings.flags | 8;
    } else this.enabled[area] = enabled ? 1 : 0;
    const cluster = item(this.world.areaSettings, area).cluster;
    const affected = cluster >= 0 ? [cluster] : [item(this.world.portals, -cluster).frontCluster, item(this.world.portals, -cluster).backCluster];
    for (const cluster of affected) this.freeClusterCacheEntries(cluster);
    this.freePortalCacheEntries();
    return previous;
  }

  clearCaches(): void {
    for (let cluster = 0; cluster < this.world.clusters.length; cluster++) this.freeClusterCacheEntries(cluster);
    this.freePortalCacheEntries();
    this.oldestCache = this.newestCache = 0;
    this.allocatedBytes = 0;
  }

  /** AAS_FreeRoutingCaches. Cache-only diagnostic invalidation stays separate. */
  shutdownRouting(): void {
    for (let cluster = 0; cluster < this.world.clusters.length; cluster++) this.freeClusterCacheEntries(cluster);
    this.storage.freeClusterCacheHeads();
    this.freePortalCacheEntries();
    this.storage.freePortalCacheHeads();
    this.storage.freeGraphAndUpdates();
    this.storage.freeCrossings();
    this.storage.freeContents();
    this.initializedRouting = null;
  }

  private *portalCacheRecords(): Generator<RoutingCache, void, unknown> {
    if (!this.storage.hasPortalCacheHeads) return;
    for (let area = 0; area < this.world.areas.length; area++) {
      yield* this.cacheList(this.storage.portalCacheHead(area));
    }
  }

  private *areaCacheRecords(): Generator<RoutingCache, void, unknown> {
    if (!this.storage.hasClusterCacheHeads) return;
    for (const [cluster, settings] of this.world.clusters.entries()) {
      for (let area = 0; area < settings.areaCount; area++) {
        yield* this.cacheList(this.storage.clusterCacheHead(cluster, area));
      }
    }
  }

  private *orderedCacheRecords(): Generator<RoutingCache, void, unknown> {
    yield* this.portalCacheRecords();
    yield* this.areaCacheRecords();
  }

  /** AAS_WriteRouteCache. Managed references occupy zeroed i386 pointer slots. */
  writeRouteCache(filename: () => string, host: AasRouteCacheWriteHost): boolean {
    this.routingData();
    let portalCount = 0, areaCount = 0;
    for (const _cache of this.portalCacheRecords()) portalCount++;
    for (const _cache of this.areaCacheRecords()) areaCount++;
    return writeRouteCacheDump(filename(), host, () => routeCacheHeader(this.world, portalCount, areaCount),
      () => this.orderedCacheRecords());
  }

  /** AAS_ReadRouteCache with the source writer's size and array offsets repaired.
   * Header rejection retains its open handle; completed records publish in order. */
  readRouteCache(filename: string, host: AasRouteCacheReadHost): boolean {
    this.routingData();
    const opened = host.openRead(filename);
    if (opened === undefined) return false;
    let offset = 0;
    const read = (bytes: Uint8Array): void => {
      const count = host.readInto(opened.file, bytes);
      if (count !== bytes.length) {
        throw new BinaryError(filename, offset, `short route cache read: ${count} of ${bytes.length} bytes; source leaves unread memory undefined`);
      }
      offset += count;
    };
    const headerBytes = new Uint8Array(ROUTE_CACHE_HEADER_BYTES);
    read(headerBytes);
    const header = new BinaryReader(headerBytes, filename);
    if (header.i32() !== ROUTE_CACHE_IDENT) {
      // The source omits the argument for its %s. Supply the actual filename.
      host.print(4, `${filename} is not a route cache dump\n`);
      return false;
    }
    const version = header.i32();
    if (version !== ROUTE_CACHE_VERSION) {
      host.print(4, `route cache dump has wrong version ${version}, should be ${ROUTE_CACHE_VERSION}`);
      return false;
    }
    if (header.i32() !== this.world.areas.length) return false;
    if (header.i32() !== this.world.clusters.length) return false;
    if (header.i32() !== routeCacheAreaCrc(this.world.areas)) return false;
    if (header.i32() !== routeCacheClusterCrc(this.world.clusters)) return false;
    const portalCount = header.i32(), areaCount = header.i32();
    const readCache = (kind: RoutingCacheKind): void => {
      const start = offset, prefix = new Uint8Array(12);
      read(prefix);
      const size = new DataView(prefix.buffer).getInt32(8, true);
      let maximumCount = this.world.portals.length;
      if (kind === "area") {
        maximumCount = 0;
        for (const cluster of this.world.clusters) maximumCount = Math.max(maximumCount, cluster.reachabilityAreaCount);
      }
      if (size < ROUTING_CACHE_STRUCT_BYTES || (size - ROUTING_CACHE_STRUCT_BYTES) % 3 !== 0
        || size > ROUTING_CACHE_STRUCT_BYTES + maximumCount * 3) {
        throw new BinaryError(filename, start + 8, "routing cache size is outside this world's i386 writer allocations");
      }
      const allocation = this.memory.allocate(size, "heap", false), bytes = allocation.bytes;
      bytes.set(prefix);
      read(bytes.subarray(prefix.length));
      const pointer = this.allocateCachePointer();
      let cache: RoutingCache;
      try {
        cache = RoutingCache.fromDump(this.memory, allocation, kind, filename, start, pointer);
        const cluster = this.world.clusters[cache.cluster], settings = this.world.areaSettings[cache.goal];
        if (cluster === undefined || cache.cluster < 0 || settings === undefined || !this.validArea(cache.goal)) {
          throw new BinaryError(filename, start + 12, "routing cache cluster or goal is outside the world");
        }
        const portal = settings.cluster <= 0 ? this.world.portals[-settings.cluster] : undefined;
        if (settings.cluster > 0 ? settings.cluster !== cache.cluster
          : portal === undefined || (portal.frontCluster !== cache.cluster && portal.backCluster !== cache.cluster)) {
          throw new BinaryError(filename, start + 12, "routing cache goal does not belong to its cluster");
        }
        const expectedCount = kind === "area" ? cluster.reachabilityAreaCount : this.world.portals.length;
        if (cache.times.length !== expectedCount) throw new BinaryError(filename, start + 8, "routing cache array count does not match its world table");
        this.reserveCacheBytes(cache.bytes.length);
      } catch (error) {
        this.retiredCachePointers.push(pointer);
        throw error;
      }
      this.cachePointers.set(cache.pointer, cache);
      this.prependCache(cache, kind);
      // Native time links are addresses from another process. Relocate the LRU
      // in read order, preserving the stored timestamp and source bucket prepend.
      this.linkCache(cache);
    };
    for (let index = 0; index < portalCount; index++) readCache("portal");
    for (let index = 0; index < areaCount; index++) readCache("area");
    host.closeFile(opened.file);
    return true;
  }

  /** AAS_InitAlternativeRouting. Each source pointer is assigned only after
   * its allocation returns; an aborted replacement retains its freed pointer. */
  initializeAlternativeRouting(log: AlternativeRoutingLog): void {
    this.alternativeScratch.initialize(this.world.areas.length, log);
  }

  shutdownAlternativeRouting(): void {
    this.alternativeScratch.shutdown();
    this.alternativeClusterCount = 0;
  }

  /** AAS_AlternativeRouteGoals. Null-origin candidate times use the accepted
   * time-only repair; they do not claim parity with the source wrapper's UB. */
  alternativeRouteGoals(query: AlternativeRouteQuery): readonly AlternativeGoal[] {
    const goals: AlternativeGoal[] = [];
    this.writeAlternativeRouteGoals(query, goal => { goals.push(goal); return undefined; });
    return goals;
  }

  writeAlternativeRouteGoals(query: AlternativeRouteQuery,
    publish: (goal: AlternativeGoal, index: number) => undefined): number {
    const debug = this.alternativeRouteDebug;
    const started = debug?.milliseconds();
    if (query.startArea === 0 || query.goalArea === 0) return 0;
    for (const value of [query.startArea, query.goalArea, query.maximumGoals]) {
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("alternative route parameter must be a signed int32");
    }
    for (const value of [query.travelFlags, query.type]) {
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) throw new RangeError("alternative route mask must be a 32-bit integer");
    }
    const goalTime = this.areaTravelTimeToGoal({ area: query.startArea, origin: query.start,
      goalArea: query.goalArea, travelFlags: query.travelFlags }, "source");
    const scratch = this.alternativeScratch;
    scratch.clear();
    const f = Math.fround;
    let candidateCount = 0;
    for (let area = 1; area < this.world.areas.length; area++) {
      const settings = item(this.world.areaSettings, area);
      if ((query.type & AlternativeRouteType.ALL) === 0
        && !((query.type & AlternativeRouteType.CLUSTER_PORTALS) !== 0 && (settings.contents & 8) !== 0)
        && !((query.type & AlternativeRouteType.VIEW_PORTALS) !== 0 && (settings.contents & 512) !== 0)) continue;
      if (settings.reachableAreaCount === 0) continue;
      const startTime = this.areaTravelTimeToGoal({ area: query.startArea, origin: query.start,
        goalArea: area, travelFlags: query.travelFlags }, "source");
      if (startTime === 0 || startTime > f(f(1.1) * f(goalTime))) continue;
      const endTime = this.areaTravelTimeToGoal({ area, origin: null, goalArea: query.goalArea, travelFlags: query.travelFlags }, "source");
      if (endTime === 0 || endTime > f(f(0.8) * f(goalTime))) continue;
      scratch.setCandidate(area, startTime, endTime);
      scratch.log(`${candidateCount} midrange area ${area}`);
      candidateCount++;
    }
    let goalCount = 0;
    for (let area = 1; area < this.world.areas.length; area++) {
      if (!scratch.valid(area)) continue;
      this.alternativeClusterCount = 0;
      this.floodAlternativeCluster(scratch, area);
      let x = 0, y = 0, z = 0;
      for (let index = 0; index < this.alternativeClusterCount; index++) {
        const center = item(this.world.areas, scratch.clusterArea(index)).center;
        x = f(x + center.x); y = f(y + center.y); z = f(z + center.z);
      }
      // VectorScale's macro multiplies by this double reciprocal before storing float.
      const scale = 1 / this.alternativeClusterCount;
      x = f(x * scale); y = f(y * scale); z = f(z * scale);
      let bestDistance = 999999, bestArea = 0;
      for (let index = 0; index < this.alternativeClusterCount; index++) {
        const candidate = scratch.clusterArea(index), center = item(this.world.areas, candidate).center;
        const dx = f(x - center.x), dy = f(y - center.y), dz = f(z - center.z);
        const distance = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
        if (distance < bestDistance) { bestDistance = distance; bestArea = candidate; }
      }
      const center = item(this.world.areas, bestArea).center;
      const startTravelTime = scratch.startTime(bestArea), goalTravelTime = scratch.goalTime(bestArea);
      publish({ origin: { x: center.x, y: center.y, z: center.z }, area: bestArea, startTravelTime, goalTravelTime,
        extraTravelTime: (startTravelTime + goalTravelTime - goalTime) & 0xffff }, goalCount++);
      debug?.showAreaPolygons(this.world, bestArea, 1, true);
      if (goalCount >= query.maximumGoals) break;
    }
    if (debug !== undefined && started !== undefined) {
      debug.print(1, `alternative route goals in ${(debug.milliseconds() - started) | 0} msec\n`);
    }
    return goalCount;
  }

  /** Recursive source preorder, with explicit frames retaining each next-face position. */
  private floodAlternativeCluster(scratch: AlternativeRoutingScratch, first: number): void {
    const stack: { readonly area: number; nextFace: number }[] = [];
    const enter = (area: number): void => {
      scratch.setClusterArea(this.alternativeClusterCount, area);
      this.alternativeClusterCount++;
      scratch.invalidate(area);
      stack.push({ area, nextFace: 0 });
    };
    enter(first);
    while (stack.length > 0) {
      const frame = item(stack, stack.length - 1), area = item(this.world.areas, frame.area);
      if (frame.nextFace >= area.faceCount) { stack.pop(); continue; }
      const face = item(this.world.faces, Math.abs(item(this.world.faceIndexes, area.firstFace + frame.nextFace)));
      frame.nextFace++;
      const other = face.frontArea === frame.area ? face.backArea : face.frontArea;
      if (other !== 0 && scratch.valid(other)) enter(other);
    }
  }

  /** AAS_InitReachabilityAreas. Geometry comes from this map's actual spatial
   * owner. This step alone does not establish the enclosing AAS ready state. */
  initializeReachabilityAreas(spatial: AasSpatial): void {
    if (spatial.world !== this.world) throw new Error("routing and spatial owners must share the same AAS world");
    this.storage.initializeCrossings();
    let first = 0;
    for (const [index, reach] of this.world.reachability.entries()) {
      let crossed: ReturnType<AasSpatial["traceAreas"]> = [];
      switch (reach.travelType & TravelType.MASK) {
        case TravelType.BARRIERJUMP:
        case TravelType.WATERJUMP:
          crossed = spatial.traceAreas(reach.start, { x: reach.start.x, y: reach.start.y, z: reach.end.z }, 32);
          break;
        case TravelType.WALKOFFLEDGE:
          crossed = spatial.traceAreas({ x: reach.end.x, y: reach.end.y, z: reach.start.z }, reach.end, 32);
          break;
        case TravelType.GRAPPLEHOOK:
          crossed = spatial.traceAreas(reach.start, reach.end, 32);
          break;
        default: break;
      }
      first = this.storage.writeCrossings(index, first, crossed);
    }
  }

  /** AAS_PredictRoute, including its partial outputs and original-start time
   * accumulation. The source's never-assigned numareas is not synthesized. */
  predictRoute(query: PredictRouteQuery): PredictedRoute {
    if (!this.storage.hasCrossings) throw new Error("reachability areas have not been initialized");
    this.routingData();
    finiteVector(query.origin);
    const result: AasRoutePredictionOutput = { stopEvent: 0, endArea: 0, endContents: 0,
      endTravelFlags: 0, time: 0, endPosition: { x: 0, y: 0, z: 0 } };
    const succeeded = this.writePredictRoute(query, result);
    return { ...result, endPosition: { x: result.endPosition.x, y: result.endPosition.y, z: result.endPosition.z }, succeeded };
  }

  writePredictRoute(query: PredictRouteQuery, result: AasRoutePredictionOutput): boolean {
    initializeAasRoutePrediction(query, result);
    for (const value of [query.area, query.goalArea, query.maximumAreas, query.maximumTime, query.stopArea]) {
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("route prediction areas and limits must be signed 32-bit integers");
    }
    for (const value of [query.travelFlags, query.stopEvent, query.stopContents, query.stopTravelFlags]) {
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) throw new RangeError("route prediction flags must be 32-bit masks");
    }
    let area = query.area, origin = { x: Math.fround(query.origin.x), y: Math.fround(query.origin.y), z: Math.fround(query.origin.z) };
    for (let i = 0; area !== query.goalArea && (query.maximumAreas === 0 || i < query.maximumAreas) && i < this.world.areas.length; i++) {
      const next = this.evaluateRoute({ area, origin, goalArea: query.goalArea, travelFlags: query.travelFlags });
      if (next.kind === "unreachable" || next.nextReachability === 0) { result.stopEvent = RouteStopEvent.NO_ROUTE; return false; }
      const reach = item(this.world.reachability, next.nextReachability);
      const flags = travelFlagForType(reach.travelType);
      if ((query.stopEvent & RouteStopEvent.USE_TRAVEL_TYPE) !== 0) {
        if ((flags & query.stopTravelFlags) !== 0) {
          result.stopEvent = RouteStopEvent.USE_TRAVEL_TYPE;
          result.endArea = area;
          result.endContents = item(this.world.areaSettings, area).contents;
          result.endTravelFlags = flags;
          result.endPosition = reach.start;
          return true;
        }
        const contentsFlags = this.storage.contentsFlags(reach.area);
        if ((contentsFlags & query.stopTravelFlags) !== 0) {
          result.stopEvent = RouteStopEvent.USE_TRAVEL_TYPE;
          result.endArea = reach.area;
          result.endContents = item(this.world.areaSettings, reach.area).contents;
          result.endTravelFlags = contentsFlags;
          result.endPosition = reach.end;
          this.addPredictionTime(result, query, reach);
          return true;
        }
      }
      for (let j = 0; j < this.storage.crossingCount(next.nextReachability) + 1; j++) {
        const testArea = j >= this.storage.crossingCount(next.nextReachability)
          ? reach.area : this.storage.crossingArea(next.nextReachability, j);
        if ((query.stopEvent & RouteStopEvent.ENTER_CONTENTS) !== 0) {
          const contents = item(this.world.areaSettings, testArea).contents;
          if ((contents & query.stopContents) !== 0) {
            result.stopEvent = RouteStopEvent.ENTER_CONTENTS;
            result.endArea = testArea;
            result.endContents = contents;
            result.endPosition = reach.end;
            this.addPredictionTime(result, query, reach);
            return true;
          }
        }
        if ((query.stopEvent & RouteStopEvent.ENTER_AREA) !== 0 && testArea === query.stopArea) {
          result.stopEvent = RouteStopEvent.ENTER_AREA;
          result.endArea = testArea;
          result.endContents = item(this.world.areaSettings, testArea).contents;
          result.endPosition = reach.start;
          return true;
        }
      }
      this.addPredictionTime(result, query, reach);
      result.endArea = reach.area;
      result.endContents = item(this.world.areaSettings, reach.area).contents;
      result.endTravelFlags = flags;
      result.endPosition = reach.end;
      area = reach.area; origin = reach.end;
      if (query.maximumTime !== 0 && result.time > query.maximumTime) break;
    }
    return area === query.goalArea;
  }

  private addPredictionTime(output: AasRoutePredictionOutput, query: PredictRouteQuery, reach: AasReachability): void {
    const areaTime = output.time + areaTravelTime(item(this.world.areaSettings, query.area), query.origin, reach.start);
    if (areaTime > 0x7fffffff) throw new RangeError("predicted route time exceeds source int range");
    output.time = areaTime;
    const time = output.time + reach.travelTime;
    if (time > 0x7fffffff) throw new RangeError("predicted route time exceeds source int range");
    output.time = time;
  }

  private clusterArea(cluster: number, area: number): number {
    const settings = item(this.world.areaSettings, area);
    let number = settings.clusterAreaNumber;
    if (settings.cluster <= 0) {
      const portal = item(this.world.portals, -settings.cluster);
      number = portal.clusterAreaNumbers[portal.frontCluster === cluster ? 0 : 1];
    }
    if (!Number.isInteger(number) || number < 0) throw new RangeError(`area ${area} has invalid index ${number} in cluster ${cluster}`);
    return number;
  }

  private clusterCacheArea(cluster: number, area: number): number {
    const number = this.clusterArea(cluster, area), count = item(this.world.clusters, cluster).areaCount;
    // The zero-area dummy row points at the next row in the same source allocation.
    // RoutingStorage checks the actual flat allocation when that head is accessed.
    if (cluster === 0) return number;
    if (number >= count) throw new RangeError(`area ${area} has invalid cache index ${number} in cluster ${cluster}`);
    return number;
  }

  private allocateCachePointer(): number {
    const retired = this.retiredCachePointers.pop();
    if (retired !== undefined) return retired;
    if (this.nextCachePointer > 0xffffffff) throw new RangeError("routing cache managed pointer IDs exhausted");
    return this.nextCachePointer++;
  }

  private resolveCache(pointer: number): RoutingCache | null {
    if (pointer === 0) return null;
    const cache = this.cachePointers.get(pointer);
    if (cache === undefined) throw new RangeError("routing cache pointer does not identify a live allocation in this owner");
    return cache;
  }

  private *cacheList(pointer: number): Generator<RoutingCache, void, unknown> {
    let remaining = this.cachePointers.size;
    for (let cache = this.resolveCache(pointer); cache !== null; cache = this.resolveCache(cache.next)) {
      if (--remaining < 0) throw new RangeError("routing cache contains a cyclic managed link");
      yield cache;
    }
  }

  private cacheHead(kind: RoutingCacheKind, cluster: number, goal: number): number {
    return kind === "area" ? this.storage.clusterCacheHead(cluster, this.clusterCacheArea(cluster, goal))
      : this.storage.portalCacheHead(goal);
  }

  private findCache(kind: RoutingCacheKind, cluster: number, goal: number, flags: number): RoutingCache | undefined {
    const head = this.cacheHead(kind, cluster, goal);
    let remaining = this.cachePointers.size;
    for (let cache = this.resolveCache(head); cache !== null; cache = this.resolveCache(cache.next)) {
      if (--remaining < 0) throw new RangeError("routing cache contains a cyclic managed link");
      if (cache.flags === flags) return cache;
    }
    return undefined;
  }

  private setCacheHead(cache: RoutingCache, pointer: number, kind: RoutingCacheKind): void {
    if (kind === "area") this.storage.setClusterCacheHead(cache.cluster, this.clusterCacheArea(cache.cluster, cache.goal), pointer);
    else this.storage.setPortalCacheHead(cache.goal, pointer);
  }

  private prependCache(cache: RoutingCache, kind: RoutingCacheKind): void {
    const head = this.cacheHead(kind, cache.cluster, cache.goal), next = this.resolveCache(head);
    cache.previous = 0; cache.next = head;
    if (next !== null) next.previous = cache.pointer;
    this.setCacheHead(cache, cache.pointer, kind);
  }

  private unlinkCache(cache: RoutingCache): void {
    const next = this.resolveCache(cache.timeNext), previous = this.resolveCache(cache.timePrevious);
    if (next !== null) next.timePrevious = cache.timePrevious;
    else this.newestCache = cache.timePrevious;
    if (previous !== null) previous.timeNext = cache.timeNext;
    else this.oldestCache = cache.timeNext;
    cache.timeNext = 0; cache.timePrevious = 0;
  }

  private linkCache(cache: RoutingCache): void {
    const newest = this.resolveCache(this.newestCache);
    if (newest !== null) newest.timeNext = cache.pointer;
    else this.oldestCache = cache.pointer;
    cache.timePrevious = this.newestCache;
    cache.timeNext = 0;
    this.newestCache = cache.pointer;
  }

  private freeCache(cache: RoutingCache): void {
    // Diagnostic budget rejection can retire an unpublished LRU entry. Source
    // FreeRoutingCache always executes its unconditional time-list unlink.
    if (this.memory.zone !== undefined || cache.pointer === this.oldestCache || cache.timePrevious !== 0 || cache.timeNext !== 0) {
      this.unlinkCache(cache);
    }
    this.allocatedBytes -= cache.size;
    cache.free();
    if (this.cachePointers.delete(cache.pointer)) this.retiredCachePointers.push(cache.pointer);
  }

  private removeCache(cache: RoutingCache, kind = cache.kind): void {
    const previous = this.resolveCache(cache.previous), next = this.resolveCache(cache.next);
    if (previous !== null) previous.next = cache.next;
    else this.setCacheHead(cache, cache.next, kind);
    if (next !== null) next.previous = cache.previous;
    this.freeCache(cache);
  }

  private freeClusterCacheEntries(cluster: number): void {
    if (!this.storage.hasClusterCacheHeads) return;
    const count = item(this.world.clusters, cluster).areaCount;
    for (let area = 0; area < count; area++) {
      let cache = this.resolveCache(this.storage.clusterCacheHead(cluster, area));
      while (cache !== null) {
        const next = this.resolveCache(cache.next);
        this.freeCache(cache); cache = next;
      }
      this.storage.setClusterCacheHead(cluster, area, 0);
    }
  }

  private freePortalCacheEntries(): void {
    if (!this.storage.hasPortalCacheHeads) return;
    for (let area = 0; area < this.world.areas.length; area++) {
      let cache = this.resolveCache(this.storage.portalCacheHead(area));
      while (cache !== null) {
        const next = this.resolveCache(cache.next);
        this.freeCache(cache); cache = next;
      }
      this.storage.setPortalCacheHead(area, 0);
    }
  }

  private reserveCacheBytes(bytes: number): void {
    const routing = this.routingData();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("routing cache allocation limit exceeded");
    if (this.memory.zone === undefined) {
      if (bytes > routing.maximumCacheBytes) throw new RangeError("routing cache allocation limit exceeded");
      while (this.allocatedBytes + bytes > routing.maximumCacheBytes) {
        if (!this.freeOldestCache()) throw new RangeError("routing cache allocation limit exhausted by pinned portal-area caches");
      }
    }
    this.allocatedBytes += bytes;
  }

  private freeOldestCache(): boolean {
    let remaining = this.cachePointers.size;
    for (let cache = this.resolveCache(this.oldestCache); cache !== null; cache = this.resolveCache(cache.timeNext)) {
      if (--remaining < 0) throw new RangeError("routing cache contains a cyclic managed time link");
      // AAS_FreeOldestCache never evicts an area cache whose goal is a portal.
      if (cache.kind === "area" && item(this.world.areaSettings, cache.goal).cluster < 0) continue;
      this.removeCache(cache);
      return true;
    }
    return false;
  }

  private allocateCache(cluster: number, goal: number, flags: number, size: number): RoutingCache {
    this.reserveCacheBytes(ROUTING_CACHE_STRUCT_BYTES + size * 3);
    const origin = item(this.world.areas, goal).center, pointer = this.allocateCachePointer();
    let cache: RoutingCache;
    try {
      cache = RoutingCache.allocate(this.memory, cluster, goal, flags, origin, size, pointer);
    } catch (error) {
      this.retiredCachePointers.push(pointer);
      throw error;
    }
    this.cachePointers.set(cache.pointer, cache);
    return cache;
  }

  private touch(cache: RoutingCache, kind: RoutingCacheKind): void {
    cache.setTime(this.routingData().time());
    cache.setKind(kind);
    this.linkCache(cache);
  }

  private areaCache(cluster: number, goal: number, flags: number): RoutingCache {
    let cache = this.findCache("area", cluster, goal, flags);
    if (cache === undefined) {
      cache = this.allocateCache(cluster, goal, flags, item(this.world.clusters, cluster).reachabilityAreaCount);
      this.prependCache(cache, "area");
      try { this.updateAreaCache(cache); }
      catch (error) {
        if (this.memory.zone === undefined) this.removeCache(cache, "area");
        throw error;
      }
    } else this.unlinkCache(cache);
    this.touch(cache, "area");
    return cache;
  }

  private updateAreaCache(cache: RoutingCache): void {
    this.routingData();
    this.areaUpdates++;
    // This relaxation kernel has no host calls or allocation lifecycle changes.
    const times = cache.times, count = times.length;
    this.currentFrameRoutingUpdates = (this.currentFrameRoutingUpdates + 1) | 0;
    const cluster = cache.cluster, goalIndex = this.clusterArea(cluster, cache.goal);
    if (goalIndex >= count) return;
    const updates = this.storage.areaUpdates;
    const first = updates.at(goalIndex);
    first.area = cache.goal;
    // Compatibility correction: all goal-entry costs are zero. The C seed holds
    // only 128 shorts, but retail mpq3tourney6 area 1887 has 134 incoming links.
    const startTimes = new Uint16Array(this.storage.reversedCount(cache.goal));
    first.areaTimesPointer = ROUTING_START_TIME_POINTER;
    first.time = cache.startTravelTime;
    times[goalIndex] = cache.startTravelTime;
    const queue = new UpdateQueue(first);
    const badFlags = ~cache.flags;
    let reachabilities: Uint8Array | null = null;
    for (let current = queue.shift(); current !== null; current = queue.shift()) {
      let ordinal = 0;
      for (const link of this.storage.incoming(current.area)) {
        const incomingOrdinal = ordinal++;
        const reach = item(this.world.reachability, link.reachability);
        if ((travelFlagForType(reach.travelType) & badFlags) !== 0) continue;
        if (!this.areaEnabled(reach.area)) continue;
        if ((this.storage.contentsFlags(reach.area) & badFlags) !== 0) continue;
        const settings = item(this.world.areaSettings, link.area);
        if (settings.cluster > 0 && settings.cluster !== cluster) continue;
        const nextIndex = this.clusterArea(cluster, link.area);
        if (nextIndex >= count) continue;
        const time = (current.time + this.storage.areaTime(current.areaTimesPointer, incomingOrdinal, startTimes) + reach.travelTime) & 0xffff;
        const previous = cache.timeAt(nextIndex);
        if (previous !== 0 && previous <= time) continue;
        times[nextIndex] = time;
        const offset = link.reachability - settings.firstReachableArea;
        reachabilities ??= cache.reachabilities;
        reachabilities[nextIndex] = offset;
        const next = updates.at(nextIndex);
        next.area = link.area; next.time = time;
        next.areaTimesPointer = this.storage.areaTimePointer(link.area, offset);
        if (!next.inList) queue.push(next);
      }
    }
  }

  private portalCache(cluster: number, goal: number, flags: number): RoutingCache {
    // Source lookup is keyed by goal and flags, even when the goal belongs to two clusters.
    let cache = this.findCache("portal", cluster, goal, flags);
    if (cache === undefined) {
      cache = this.allocateCache(cluster, goal, flags, this.world.portals.length);
      this.prependCache(cache, "portal");
      try { this.updatePortalCache(cache); }
      catch (error) {
        if (this.memory.zone === undefined) this.removeCache(cache, "portal");
        throw error;
      }
    } else this.unlinkCache(cache);
    this.touch(cache, "portal");
    return cache;
  }

  private updatePortalCache(cache: RoutingCache): void {
    this.routingData();
    this.portalUpdates++;
    const updates = this.storage.portalUpdates;
    const first = updates.at(this.world.portals.length);
    first.cluster = cache.cluster; first.area = cache.goal; first.time = cache.startTravelTime;
    const goalCluster = item(this.world.areaSettings, cache.goal).cluster;
    if (goalCluster < 0) cache.times[-goalCluster] = cache.startTravelTime;
    const queue = new UpdateQueue(first);
    for (let current = queue.shift(); current !== null; current = queue.shift()) {
      const cluster = item(this.world.clusters, current.cluster);
      const local = this.areaCache(current.cluster, current.area, cache.flags);
      for (let offset = 0; offset < cluster.portalCount; offset++) {
        const portalNumber = item(this.world.portalIndex, cluster.firstPortal + offset);
        const portal = item(this.world.portals, portalNumber);
        if (portal.area === current.area) continue;
        const areaIndex = this.clusterArea(current.cluster, portal.area);
        if (areaIndex >= cluster.reachabilityAreaCount) continue;
        const localTime = local.timeAt(areaIndex);
        if (localTime === 0) continue;
        const time = (localTime + current.time) & 0xffff;
        const times = cache.times;
        const previous = cache.timeAt(portalNumber);
        if (previous !== 0 && previous <= time) continue;
        times[portalNumber] = time;
        const next = updates.at(portalNumber);
        next.cluster = portal.frontCluster === current.cluster ? portal.backCluster : portal.frontCluster;
        next.area = portal.area;
        next.time = time + this.storage.portalMaximum(portalNumber);
        if (!next.inList) queue.push(next);
      }
    }
    // Source AAS_UpdatePortalRoutingCache never assigns cache->reachabilities.
  }

  route(query: RouteQuery): RouteResult {
    if (!this.checkedRouteQuery(query)) return { kind: "unreachable" };
    return this.evaluateRoute(query);
  }

  /** Omitted-origin time only. Resolves the source's undefined success test by
   * publishing a selected candidate, as an external caller with reachnum=0 does. */
  areaTravelTimeToGoal(query: AreaTravelTimeQuery, reads: "checked" | "source" = "checked"): number {
    if (reads === "checked" && !this.checkedRouteQuery(query)) return 0;
    const result = this.evaluateRoute(query);
    return result.kind === "unreachable" ? 0 : result.travelTime;
  }

  private checkedRouteQuery(query: AreaTravelTimeQuery): boolean {
    if (this.initializedRouting === null || !this.validArea(query.area) || !this.validArea(query.goalArea)) return false;
    if (query.origin !== null) finiteVector(query.origin);
    if (!Number.isInteger(query.travelFlags) || query.travelFlags < -0x80000000 || query.travelFlags > 0xffffffff) {
      throw new RangeError("travel flags must be a 32-bit mask");
    }
    return true;
  }

  private evaluateRoute(query: RouteQuery): RouteResult;
  private evaluateRoute(query: AreaTravelTimeQuery): RouteEvaluation;
  private evaluateRoute(query: AreaTravelTimeQuery): RouteEvaluation {
    const routing = this.initializedRouting;
    const host = this.host;
    if (routing === null || (host !== undefined && !host.initialized())) return { kind: "unreachable" };
    if (query.area === query.goalArea) return { kind: "found", travelTime: 1, nextReachability: 0 };
    for (const [label, area] of [["areanum", query.area], ["goalareanum", query.goalArea]] satisfies readonly (readonly [string, number])[]) {
      if (this.validArea(area)) continue;
      if (host !== undefined && host.developer()) {
        host.print(3, `AAS_AreaTravelTimeToGoalArea: ${label} ${area} out of range\n`);
      }
      return { kind: "unreachable" };
    }
    // Diagnostic memory has no common zone to query. Source compositions use
    // Z_AvailableZoneMemory here, before any area/portal cache lookup or update.
    const zone = this.memory.zone;
    if (zone !== undefined) {
      while (zone.memoryRemaining() < 1024 * 1024) if (!this.freeOldestCache()) break;
    }
    if (!Number.isInteger(query.travelFlags) || query.travelFlags < -0x80000000 || query.travelFlags > 0xffffffff) throw new RangeError("travel flags must be a 32-bit mask");
    const area = query.area; const goal = query.goalArea;
    const startSettings = item(this.world.areaSettings, area);
    const goalSettings = item(this.world.areaSettings, goal);
    let flags = query.travelFlags | 0;
    if (((startSettings.contents | goalSettings.contents) & 256) !== 0) flags |= TravelFlags.DONOTENTER;
    let cluster = startSettings.cluster;
    let goalCluster = goalSettings.cluster;
    if (cluster < 0 && goalCluster > 0) {
      const portal = item(this.world.portals, -cluster);
      if (portal.frontCluster === goalCluster || portal.backCluster === goalCluster) cluster = goalCluster;
    } else if (cluster > 0 && goalCluster < 0) {
      const portal = item(this.world.portals, -goalCluster);
      if (portal.frontCluster === cluster || portal.backCluster === cluster) goalCluster = cluster;
    }
    if (cluster > 0 && cluster === goalCluster) {
      const cache = this.areaCache(cluster, goal, flags);
      const index = this.clusterArea(cluster, area);
      if (index >= item(this.world.clusters, cluster).reachabilityAreaCount) return { kind: "unreachable" };
      const time = cache.timeAt(index);
      if (time !== 0) {
        if (query.origin === null) return { kind: "time-only", travelTime: time };
        const nextReachability = startSettings.firstReachableArea + cache.reachabilityAt(index);
        const first = item(this.world.reachability, nextReachability);
        // Unlike the intercluster branch, this addition is assigned directly to an int.
        return { kind: "found", travelTime: time + routingAreaTravelTime(startSettings, query.origin, first.start), nextReachability };
      }
    }
    cluster = startSettings.cluster;
    goalCluster = goalSettings.cluster;
    if (goalCluster < 0) goalCluster = item(this.world.portals, -goalCluster).frontCluster;
    const portalCache = this.portalCache(goalCluster, goal, flags);
    if (cluster < 0) {
      // The C function returns qtrue here even if the cached time is zero.
      if (query.origin === null) return { kind: "time-only", travelTime: portalCache.timeAt(-cluster) };
      return { kind: "found", travelTime: portalCache.timeAt(-cluster),
        nextReachability: startSettings.firstReachableArea + portalCache.reachabilityAt(-cluster) };
    }
    let bestTime = 0;
    let best: RouteEvaluation = { kind: "unreachable" };
    const startCluster = item(this.world.clusters, cluster);
    for (let offset = 0; offset < startCluster.portalCount; offset++) {
      const portalNumber = item(this.world.portalIndex, startCluster.firstPortal + offset);
      const portalTime = portalCache.timeAt(portalNumber);
      if (portalTime === 0) continue;
      const portal = item(this.world.portals, portalNumber);
      const local = this.areaCache(cluster, portal.area, flags);
      const index = this.clusterArea(cluster, area);
      if (index >= startCluster.reachabilityAreaCount) continue;
      const localTime = local.timeAt(index);
      if (localTime === 0) continue;
      const nextReachability = query.origin === null ? null : startSettings.firstReachableArea + local.reachabilityAt(index);
      let time = (portalTime + localTime) & 0xffff;
      time = (time + this.storage.portalMaximum(portalNumber)) & 0xffff;
      if (query.origin !== null && nextReachability !== null) {
        time = (time + routingAreaTravelTime(startSettings, query.origin, item(this.world.reachability, nextReachability).start)) & 0xffff;
      }
      if (bestTime === 0 || time < bestTime) {
        bestTime = time;
        best = nextReachability === null ? { kind: "time-only", travelTime: time }
          : { kind: "found", travelTime: time, nextReachability };
      }
    }
    return best;
  }
}
