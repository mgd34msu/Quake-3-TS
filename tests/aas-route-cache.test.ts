import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, fstatSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { RoutingCache, routeCacheCrc16, writeEmptyRouteCache } from "../src/botlib/aas-route-cache.ts";
import { writeAasFile } from "../src/botlib/aas-file.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import type { BotMemoryAllocation } from "../src/botlib/memory.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import { RoutingStorage } from "../src/botlib/routing-storage.ts";
import type { AasRouteCacheReadHost, AasRouteCacheWriteHost } from "../src/botlib/routing.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { vec3 } from "../src/core/math.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";

const cleanups: (() => void)[] = [], roots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const zero = vec3(0, 0, 0), bounds = { min: zero, max: vec3(10, 10, 10) };
const query = { area: 1, goalArea: 3, origin: zero, travelFlags: TravelFlags.DEFAULT };

function world(portal = false): AasWorld {
  return {
    source: "route-cache-fixture", version: 4, bspChecksum: 0, bboxes: [], vertices: [],
    planes: [{ normal: vec3(1, 0, 0), distance: 5, type: 0 }], edges: [], edgeIndexes: [], faces: [], faceIndexes: [],
    areas: Array.from({ length: 4 }, (_, areaNumber) => ({ areaNumber, faceCount: 0, firstFace: 0, bounds, center: zero })),
    areaSettings: [
      { contents: 0, flags: 0, presenceType: 0, cluster: 0, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 },
      { contents: 0, flags: 1, presenceType: 2, cluster: 1, clusterAreaNumber: 0, reachableAreaCount: 1, firstReachableArea: 1 },
      { contents: 0, flags: 1, presenceType: 2, cluster: portal ? -1 : 1, clusterAreaNumber: 1, reachableAreaCount: 1, firstReachableArea: 2 },
      { contents: 0, flags: 1, presenceType: 2, cluster: portal ? 2 : 1, clusterAreaNumber: portal ? 1 : 2, reachableAreaCount: 0, firstReachableArea: 3 },
    ],
    reachability: [
      { area: 0, face: 0, edge: 0, start: zero, end: zero, travelType: 0, travelTime: 0, padding: 0 },
      { area: 2, face: 0, edge: 0, start: zero, end: zero, travelType: TravelType.WALK, travelTime: 10, padding: 0 },
      { area: 3, face: 0, edge: 0, start: zero, end: zero, travelType: TravelType.WALK, travelTime: 10, padding: 0 },
    ],
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -2] }],
    portals: portal ? [
      { area: 0, frontCluster: 0, backCluster: 0, clusterAreaNumbers: [0, 0] },
      { area: 2, frontCluster: 1, backCluster: 2, clusterAreaNumbers: [1, 0] },
    ] : [{ area: 0, frontCluster: 0, backCluster: 0, clusterAreaNumbers: [0, 0] }],
    portalIndex: portal ? [1, 1] : [],
    clusters: portal ? [
      { areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 },
      { areaCount: 2, reachabilityAreaCount: 2, portalCount: 1, firstPortal: 0 },
      { areaCount: 2, reachabilityAreaCount: 2, portalCount: 1, firstPortal: 1 },
    ] : [
      { areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 },
      { areaCount: 3, reachabilityAreaCount: 3, portalCount: 0, firstPortal: 0 },
    ],
    pointArea: point => point.x > 5 ? 1 : 2,
    areaReachabilities(area) {
      const settings = this.areaSettings[area];
      if (settings === undefined) throw new RangeError("fixture area");
      return this.reachability.slice(settings.firstReachableArea, settings.firstReachableArea + settings.reachableAreaCount);
    },
    areaBounds: () => bounds,
  };
}

function routingSpatial(map: AasWorld): AasSpatial {
  const unexpected = (): never => { throw new Error("routing fixture crossed unused collision boundary"); };
  const entities = new AasBspEntities(unexpected), links = new AasLinkHeap(unexpected);
  links.initialize(() => 64);
  return new AasSpatial(map, entities, { print: unexpected, trace: unexpected, pointContents: unexpected,
    entityTrace: unexpected, entityModelIndex: unexpected, modelBounds: unexpected }, DEFAULT_AAS_MOVEMENT_SETTINGS,
  new BotBrushModelTypes(), links, { kind: "disabled" }, () => 0);
}

function routing(map: AasWorld, clock: () => number, capacity = 4 * 1024 * 1024, memory?: BotMemory): AasRouting {
  const result = new AasRouting(map, memory === undefined ? {} : { memory });
  result.initializeRouting(routingSpatial(map), () => capacity, clock);
  return result;
}

async function files() {
  const root = await mkdtemp(join(tmpdir(), "quake3-route-cache-"));
  roots.push(root);
  await mkdir(join(root, "baseq3", "maps"), { recursive: true });
  const handles = new SourceFileHandles(), operations: string[] = [], messages: string[] = [];
  const writable = new WritableFileSystem({ homePath: root, product: "baseq3", handles, print: () => undefined });
  cleanups.push(() => { writable.closeAll(); handles.close(); });
  const host: AasRouteCacheReadHost & AasRouteCacheWriteHost = {
    openRead(filename) {
      operations.push(`open-read:${filename}`);
      const path = join(root, "baseq3", filename);
      if (!existsSync(path)) return undefined;
      const file = handles.selectFree(), descriptor = openSync(path, "r");
      handles.attachLooseRead(file, descriptor);
      return { file, length: fstatSync(descriptor).size };
    },
    readInto(file, bytes) { operations.push(`read:${bytes.length}`); return handles.readInto(file, bytes); },
    closeFile(file) { operations.push("close-read"); handles.closeFile(file); },
    openWrite(filename) {
      operations.push(`open-write:${filename}`);
      const file = writable.openBinaryWrite(filename);
      if (file === null) return null;
      return {
        writeBytes(bytes) { operations.push(`write:${bytes.length}`); return file.writeBytes(bytes); },
        close() { operations.push("close-write"); file.close(); },
      };
    },
    print(type, message) { messages.push(`${type}:${message}`); },
  };
  return { root, handles, writable, host, operations, messages,
    read: async (filename: string) => new Uint8Array(await readFile(join(root, "baseq3", filename))),
    write(filename: string, bytes: Uint8Array) {
      const file = writable.openBinaryWrite(filename);
      if (file === null) throw new Error("fixture write failed");
      file.writeBytes(bytes); file.close();
    } };
}

function recordViews(bytes: Uint8Array): readonly DataView[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), records: DataView[] = [];
  for (let offset = 32; offset < bytes.length;) {
    const size = view.getInt32(offset + 8, true);
    if (size < 64 || size > bytes.length - offset) throw new Error("invalid test dump record size");
    records.push(new DataView(bytes.buffer, bytes.byteOffset + offset, size));
    offset += size;
  }
  return records;
}

class CacheMemory extends BotMemory {
  readonly blocks: BotMemoryAllocation[] = [];
  readonly events: string[] = [];

  override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
    this.events.push(`allocate ${size} ${kind} ${clear}`);
    const allocation = super.allocate(size, kind, clear);
    this.blocks.push(allocation);
    return allocation;
  }

  override free(allocation: BotMemoryAllocation): void {
    this.events.push(`free ${allocation.bytes.length}`);
    super.free(allocation);
  }
}

test("reused cache views observe live fields, validate corruption and reject access after free", () => {
  const memory = new BotMemory(), cache = RoutingCache.allocate(memory, 1, 3, 7, zero, 3, 1);
  const bytes = cache.bytes, header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const times = cache.times, reaches = cache.reachabilities;
  expect(cache.times).toBe(times); expect(cache.reachabilities).toBe(reaches);
  header.setInt32(12, 9, true); header.setUint16(60, 65535, true);
  expect(cache.cluster).toBe(9); expect(cache.times[0]).toBe(65535);
  cache.previous = 27; cache.setTime(1 / 3);
  expect(header.getUint32(40, true)).toBe(27); expect(header.getFloat32(4, true)).toBe(Math.fround(1 / 3));
  header.setUint32(56, 69, true); bytes[68] = 19;
  expect(cache.reachabilities[0]).toBe(19); expect(cache.reachabilities).not.toBe(reaches);
  header.setUint32(56, 0, true); header.setInt32(8, 72, true);
  expect(() => cache.times).toThrow("routing cache size does not match its source allocation");
  expect(() => cache.reachabilities).toThrow("routing cache size does not match its source allocation");
  header.setInt32(8, 73, true);
  expect(cache.times).toBe(times);
  expect(() => cache.reachabilities).toThrow("routing reachabilities exceed their source allocation");
  header.setUint32(56, 72, true);
  expect(() => cache.reachabilities).toThrow("routing reachabilities exceed their source allocation");
  header.setUint32(56, 71, true);
  expect(cache.reachabilities.length).toBe(3);
  cache.free();
  expect(() => cache.cluster).toThrow("freed");
  expect(() => { cache.previous = 1; }).toThrow("freed");
  expect(() => cache.times).toThrow("freed");
  expect(() => cache.reachabilities).toThrow("freed");
});

test("cache views follow replacement allocation bytes and their newly validated count", () => {
  const memory = new BotMemory(), original = RoutingCache.allocate(memory, 1, 3, 7, zero, 3, 1);
  let bytes = original.dumpBytes();
  const cache = RoutingCache.fromDump(memory, { get bytes() { return bytes; } }, "portal", "fixture", 0, 2);
  const times = cache.times, reaches = cache.reachabilities;
  expect(cache.cluster).toBe(1);
  bytes = bytes.slice(0, 70);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  header.setInt32(8, 70, true); header.setInt32(12, 8, true); header.setUint32(56, 69, true);
  header.setUint16(60, 123, true); bytes[68] = 4;
  expect(cache.cluster).toBe(8);
  expect(Array.from(cache.times)).toEqual([123, 0]); expect(cache.times).not.toBe(times);
  expect(Array.from(cache.reachabilities)).toEqual([4, 0]); expect(cache.reachabilities).not.toBe(reaches);
  original.free();
});

test("zero-count cache arrays accept the allocation-end reachability pointer", () => {
  const cache = RoutingCache.allocate(new BotMemory(), 1, 3, 7, zero, 0, 1);
  expect(cache.times.length).toBe(0); expect(cache.reachabilities.length).toBe(0);
  expect(cache.times).toBe(cache.times); expect(cache.reachabilities).toBe(cache.reachabilities);
  cache.free(); expect(() => cache.times).toThrow("freed"); expect(() => cache.reachabilities).toThrow("freed");
});

test("source reachability warnings include exactly 128 and preserve the allocated prefix on print abort", () => {
  const base = world(), counts: readonly number[] = [0, 127, 128, 129];
  let first = 1;
  const areaSettings = base.areaSettings.map((settings, area) => {
    const count = counts[area];
    if (count === undefined) throw new Error("Missing warning fixture count");
    const result = { ...settings, reachableAreaCount: count, firstReachableArea: area === 0 ? 0 : first };
    first += count; return result;
  });
  const dummy = base.reachability[0], link = base.reachability[1];
  if (dummy === undefined || link === undefined) throw new Error("Missing warning fixture reachabilities");
  const map: AasWorld = { ...base, areaSettings,
    reachability: Array.from({ length: first }, (_, index) => index === 0 ? dummy : { ...link, area: 3 }) };
  const capacity = 2 * 1024 * 1024, zone = new ZoneArena(capacity), memory = new CacheMemory(undefined, zone);
  const warnings: [number, string][] = [], prefixes: number[] = [];
  const router = new AasRouting(map, { memory, host: {
    initialized: () => false, developer: () => false,
    print(severity, text) {
      warnings.push([severity, text]);
      const reversed = memory.blocks[3];
      if (reversed === undefined) throw new Error("Warning preceded reversed allocation publication");
      const view = new DataView(reversed.bytes.buffer, reversed.bytes.byteOffset, reversed.bytes.byteLength);
      const count = view.getInt32(24, true);
      prefixes.push(count);
      expect(view.getInt32(map.areas.length * 8 + count * 12, true)).toBe(0);
      return undefined;
    },
  } });
  router.initializeRouting(routingSpatial(map), () => 0, () => 0);
  expect(warnings).toEqual([[2, "area 2 has more than 128 reachabilities\n"], [2, "area 3 has more than 128 reachabilities\n"]]);
  expect(prefixes).toEqual([127, 255]);
  const reversed = memory.blocks[3];
  if (reversed === undefined) throw new Error("Missing warned reversed allocation");
  expect(new DataView(reversed.bytes.buffer, reversed.bytes.byteOffset, reversed.bytes.byteLength).getInt32(24, true)).toBe(383);
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(capacity); zone.checkHeap(); zone.dispose();

  const failedZone = new ZoneArena(capacity), failedMemory = new CacheMemory(undefined, failedZone);
  const failed = new AasRouting(map, { memory: failedMemory, host: {
    initialized: () => false, developer: () => false,
    print(severity, text) {
      expect([severity, text]).toEqual([2, "area 2 has more than 128 reachabilities\n"]);
      throw new Error("warning print aborted");
    },
  } });
  expect(() => failed.initializeRouting(routingSpatial(map), () => 0, () => 0)).toThrow("warning print aborted");
  expect(failedMemory.events).toEqual(["allocate 16 heap true", "allocate 120 heap true", "allocate 80 heap true", "allocate 4652 heap true"]);
  const retained = failedMemory.blocks[3];
  if (retained === undefined) throw new Error("Missing partial reversed allocation");
  const retainedView = new DataView(retained.bytes.buffer, retained.bytes.byteOffset, retained.bytes.byteLength);
  expect(retainedView.getInt32(24, true)).toBe(127);
  expect(retainedView.getInt32(map.areas.length * 8 + 127 * 12, true)).toBe(0);
  expect(failed.cacheStatistics.entries).toBe(0);
  failedMemory.events.length = 0; failed.shutdownRouting();
  expect(failedMemory.events).toEqual(["free 4652", "free 120", "free 80", "free 16"]);
  expect(failedZone.memoryRemaining()).toBe(capacity); failedZone.checkHeap(); failedZone.dispose();
});

test("route lookups read cache flags and times from the actual bot zone block", () => {
  const zone = new ZoneArena(2 * 1024 * 1024), memory = new CacheMemory(undefined, zone);
  const router = routing(world(), () => 1 / 3, 0, memory);
  const headBlock = memory.blocks[4];
  if (headBlock === undefined) throw new Error("Missing cluster cache heads");
  const heads = new DataView(headBlock.bytes.buffer, headBlock.bytes.byteOffset, headBlock.bytes.byteLength);
  const available = zone.memoryRemaining();
  memory.blocks.length = 0; memory.events.length = 0;
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
  expect(memory.events).toEqual(["allocate 73 heap true"]);
  const pointer = heads.getUint32(16, true);
  expect(pointer).toBeGreaterThan(0);
  expect(zone.memoryRemaining()).toBe(available - 104);
  const block = memory.blocks[0];
  if (block === undefined) throw new Error("Missing actual route cache allocation");
  const bytes = block.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([view.getUint8(0), view.getInt32(8, true), view.getInt32(12, true), view.getInt32(16, true)])
    .toEqual([1, 73, 1, 3]);
  expect(view.getFloat32(4, true)).toBe(Math.fround(1 / 3));
  expect(view.getUint16(60, true)).toBe(22);
  expect(bytes.subarray(66, 70)).toEqual(new Uint8Array(4));
  const flags = TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP;
  view.setInt32(36, flags, true); view.setUint16(60, 321, true);
  expect(router.route({ ...query, travelFlags: flags })).toEqual({ kind: "found", travelTime: 322, nextReachability: 1 });
  expect(memory.blocks.length).toBe(1);
  router.clearCaches();
  expect(() => block.bytes).toThrow("freed");
  expect(zone.memoryRemaining()).toBe(available);
  router.route(query);
  const reused = memory.blocks[1];
  if (reused === undefined) throw new Error("Missing reused route cache allocation");
  expect(reused.bytes.byteOffset).toBe(bytes.byteOffset);
  expect(heads.getUint32(16, true)).toBe(pointer);
  expect(() => block.bytes).toThrow("freed");
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024); zone.checkHeap(); zone.dispose();
});

test("cluster rows, bucket heads, cache links and reachability pointers are canonical live bytes", () => {
  const capacity = 2 * 1024 * 1024, zone = new ZoneArena(capacity), memory = new CacheMemory(undefined, zone);
  const router = routing(world(), () => 0, 0, memory), headBlock = memory.blocks[4];
  if (headBlock === undefined) throw new Error("Missing cluster cache head allocation");
  const heads = new DataView(headBlock.bytes.buffer, headBlock.bytes.byteOffset, headBlock.bytes.byteLength);
  memory.blocks.length = 0;
  router.route(query); router.route({ ...query, goalArea: 2 });
  router.route({ ...query, travelFlags: TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP });
  const [goal, other, variant] = memory.blocks.map(block => new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength));
  if (goal === undefined || other === undefined || variant === undefined) throw new Error("Missing cache pointer fixtures");
  const otherPointer = heads.getUint32(12, true), variantPointer = heads.getUint32(16, true), goalPointer = variant.getUint32(44, true);
  expect([heads.getUint32(4, true), goal.getUint32(40, true), goal.getUint32(44, true), variant.getUint32(40, true)])
    .toEqual([9, variantPointer, 0, 0]);
  expect(new Set([goalPointer, otherPointer, variantPointer]).size).toBe(3);

  heads.setUint32(4, 5, true);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  heads.setUint32(4, 9, true);
  heads.setUint32(16, otherPointer, true);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  heads.setUint32(16, variantPointer, true);

  goal.setUint16(60, 200, true);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 201, nextReachability: 1 });
  variant.setUint32(44, otherPointer, true);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  variant.setUint32(44, goalPointer, true);
  expect(goal.getUint32(56, true)).toBe(71);
  goal.setUint8(68, 1); goal.setUint32(56, 69, true);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 201, nextReachability: 2 });
  goal.setUint8(68, 0); goal.setUint32(56, 71, true);
  expect(router.cacheStatistics.entries).toBe(3);
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(capacity); zone.checkHeap(); zone.dispose();
});

test("source eviction follows live time links after skipping a pinned portal-goal cache", () => {
  const limit = 1024 * 1024, zone = new ZoneArena(2 * limit), memory = new CacheMemory(undefined, zone);
  const router = routing(world(true), () => 0, 0, memory), headBlock = memory.blocks[4];
  if (headBlock === undefined) throw new Error("Missing cluster cache head allocation");
  const heads = new DataView(headBlock.bytes.buffer, headBlock.bytes.byteOffset, headBlock.bytes.byteLength);
  memory.blocks.length = 0;
  const alternateFlags = TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP;
  router.route({ ...query, goalArea: 2 });
  router.route({ ...query, area: 2 });
  router.route({ ...query, area: 2, travelFlags: alternateFlags });
  router.route({ ...query, goalArea: 2, travelFlags: alternateFlags });
  const [firstBlock, secondBlock, thirdBlock, lastBlock] = memory.blocks;
  if (firstBlock === undefined || secondBlock === undefined || thirdBlock === undefined || lastBlock === undefined) {
    throw new Error("Missing linked eviction fixtures");
  }
  const first = new DataView(firstBlock.bytes.buffer, firstBlock.bytes.byteOffset, firstBlock.bytes.byteLength);
  const second = new DataView(secondBlock.bytes.buffer, secondBlock.bytes.byteOffset, secondBlock.bytes.byteLength);
  const third = new DataView(thirdBlock.bytes.buffer, thirdBlock.bytes.byteOffset, thirdBlock.bytes.byteLength);
  const last = new DataView(lastBlock.bytes.buffer, lastBlock.bytes.byteOffset, lastBlock.bytes.byteLength);
  const firstPointer = last.getUint32(44, true), secondPointer = third.getUint32(44, true);
  const thirdPointer = heads.getUint32(24, true), lastPointer = heads.getUint32(16, true);
  expect([first.getUint32(48, true), first.getUint32(52, true), second.getUint32(52, true), third.getUint32(52, true), last.getUint32(52, true)])
    .toEqual([0, secondPointer, thirdPointer, lastPointer, 0]);
  first.setUint32(52, thirdPointer, true);
  third.setUint32(48, firstPointer, true); third.setUint32(52, secondPointer, true);
  second.setUint32(48, thirdPointer, true); second.setUint32(52, lastPointer, true);
  last.setUint32(48, secondPointer, true);
  const pressure = zone.allocate(zone.memoryRemaining() - (limit - 4) - 24, ZoneTag.General);
  expect(router.route({ ...query, goalArea: 2 })).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  expect(() => thirdBlock.bytes).toThrow("freed");
  expect(secondBlock.bytes.length).toBe(70);
  expect(heads.getUint32(24, true)).toBe(secondPointer);
  expect(second.getUint32(40, true)).toBe(0);
  expect(router.cacheStatistics).toEqual({ areaUpdates: 4, portalUpdates: 0, entries: 3, bytes: 210 });
  zone.free(pressure);
  router.route({ ...query, area: 2, travelFlags: alternateFlags });
  expect(heads.getUint32(24, true)).toBe(thirdPointer);
  expect(new Set([firstPointer, secondPointer, heads.getUint32(24, true), lastPointer]).size).toBe(4);
  expect(() => thirdBlock.bytes).toThrow("freed");
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(2 * limit); zone.checkHeap(); zone.dispose();
});

test("pending cache IDs survive recursive allocation and return after an allocation abort", () => {
  class ReentrantMemory extends CacheMemory {
    beforeAllocate: () => void = () => undefined;
    override allocate(size: number, kind: "heap" | "hunk", clear: boolean): BotMemoryAllocation {
      this.beforeAllocate();
      return super.allocate(size, kind, clear);
    }
  }
  const memory = new ReentrantMemory(), router = routing(world(), () => 0, 4096, memory);
  const headBlock = memory.blocks[4];
  if (headBlock === undefined) throw new Error("Missing recursive cache heads");
  const heads = new DataView(headBlock.bytes.buffer, headBlock.bytes.byteOffset, headBlock.bytes.byteLength);
  router.route(query);
  const retired = heads.getUint32(16, true);
  router.clearCaches();
  memory.beforeAllocate = () => {
    memory.beforeAllocate = () => undefined;
    expect(router.route({ ...query, goalArea: 2 }).kind).toBe("found");
    expect(heads.getUint32(12, true)).not.toBe(retired);
    throw new Error("allocation callback abort");
  };
  expect(() => router.route(query)).toThrow("allocation callback abort");
  expect(router.cacheStatistics).toEqual({ areaUpdates: 2, portalUpdates: 0, entries: 1, bytes: 146 });
  expect(router.route(query).kind).toBe("found");
  expect(heads.getUint32(16, true)).toBe(retired);
  expect(heads.getUint32(12, true)).not.toBe(retired);
  router.shutdownRouting();
});

test("a failed free keeps its cache ID reserved through recursive allocation", () => {
  class ReentrantMemory extends CacheMemory {
    beforeFree: () => void = () => undefined;
    override free(allocation: BotMemoryAllocation): void {
      this.beforeFree();
      super.free(allocation);
    }
  }
  const memory = new ReentrantMemory(), router = routing(world(), () => 0, 4096, memory);
  const headBlock = memory.blocks[4];
  if (headBlock === undefined) throw new Error("Missing failing-free cache heads");
  const heads = new DataView(headBlock.bytes.buffer, headBlock.bytes.byteOffset, headBlock.bytes.byteLength);
  router.route(query);
  const retained = heads.getUint32(16, true);
  memory.beforeFree = () => {
    memory.beforeFree = () => undefined;
    router.route({ ...query, goalArea: 2 });
    expect(heads.getUint32(12, true)).not.toBe(retained);
    expect(heads.getUint32(16, true)).toBe(retained);
    throw new Error("free callback abort");
  };
  expect(() => router.clearCaches()).toThrow("free callback abort");
  router.route({ ...query, travelFlags: TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP });
  expect(new Set([retained, heads.getUint32(12, true), heads.getUint32(16, true)]).size).toBe(3);
  router.shutdownRouting();
});

test("rejected dump construction and world validation return only their unpublished cache IDs", async () => {
  const env = await files(), memory = new CacheMemory(), router = routing(world(), () => 0, 4096, memory);
  const headBlock = memory.blocks[4];
  if (headBlock === undefined) throw new Error("Missing dump cache heads");
  const heads = new DataView(headBlock.bytes.buffer, headBlock.bytes.byteOffset, headBlock.bytes.byteLength);
  router.route(query);
  const retired = heads.getUint32(16, true);
  router.writeRouteCache(() => "maps/reuse.rcd", env.host);
  const good = await env.read("maps/reuse.rcd");
  router.clearCaches();
  const retainedAllocations: BotMemoryAllocation[] = [];
  for (const [offset, value] of [[32, 0], [44, 99]] satisfies readonly [number, number][]) {
    const bad = good.slice();
    new DataView(bad.buffer).setInt32(offset, value, true);
    env.write("maps/reject.rcd", bad);
    expect(() => router.readRouteCache("maps/reject.rcd", env.host)).toThrow();
    expect(router.cacheStatistics.entries).toBe(0);
    const allocation = memory.blocks.at(-1);
    if (allocation === undefined) throw new Error("Missing rejected dump allocation");
    expect(allocation.bytes.length).toBe(73);
    retainedAllocations.push(allocation);
  }
  expect(router.readRouteCache("maps/reuse.rcd", env.host)).toBe(true);
  expect(heads.getUint32(16, true)).toBe(retired);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
  router.shutdownRouting();
  for (const allocation of retainedAllocations) memory.free(allocation);
});

test("AvailableMemory evicts at less than one MiB and retains portal-goal area caches", () => {
  const limit = 1024 * 1024, zone = new ZoneArena(2 * limit), memory = new CacheMemory(undefined, zone);
  const router = routing(world(), () => 0, 0, memory);
  memory.blocks.length = 0;
  router.route({ ...query, goalArea: 2 }); router.route(query);
  router.route({ ...query, travelFlags: TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP });
  const exact = zone.allocate(zone.memoryRemaining() - limit - 24, ZoneTag.General);
  expect(zone.memoryRemaining()).toBe(limit);
  router.route(query);
  expect(router.cacheStatistics.entries).toBe(3);
  zone.free(exact);
  const pressure = zone.allocate(zone.memoryRemaining() - (limit - 4) - 24, ZoneTag.General);
  expect(zone.memoryRemaining()).toBe(limit - 4);
  router.route(query);
  expect(router.cacheStatistics).toEqual({ areaUpdates: 3, portalUpdates: 0, entries: 2, bytes: 146 });
  expect(zone.memoryRemaining()).toBe(limit + 100);
  const oldest = memory.blocks[0];
  if (oldest === undefined) throw new Error("Missing oldest cache allocation");
  expect(() => oldest.bytes).toThrow("freed");
  zone.free(pressure); router.clearCaches();

  const portals = routing(world(true), () => 0, 0, memory);
  portals.route(query);
  const low = zone.allocate(zone.memoryRemaining() - (limit - 204) - 24, ZoneTag.General);
  const before = memory.blocks.length;
  expect(portals.route({ ...query, goalArea: 2 })).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  expect(portals.cacheStatistics).toEqual({ areaUpdates: 2, portalUpdates: 1, entries: 1, bytes: 70 });
  expect(memory.blocks.length).toBe(before);
  expect(zone.memoryRemaining()).toBe(limit - 4);
  zone.free(low); portals.shutdownRouting(); router.shutdownRouting();
  expect(zone.memoryRemaining()).toBe(2 * limit); zone.checkHeap(); zone.dispose();
});

test("alternative routing uses source midrange records and replaces its two allocations in order", () => {
  const zone = new ZoneArena(2 * 1024 * 1024), memory = new CacheMemory(undefined, zone);
  const router = routing(world(), () => 0, 0, memory);
  memory.blocks.length = 0; memory.events.length = 0;
  router.initializeAlternativeRouting({ write() {
    const midrange = memory.blocks[0];
    if (midrange === undefined) throw new Error("Missing alternative midrange allocation");
    const bytes = midrange.bytes;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(2 * 8 + 4, 99, true);
  } });
  expect(memory.events).toEqual(["allocate 32 heap false", "allocate 16 heap false"]);
  const [midrange, clusters] = memory.blocks;
  if (midrange === undefined || clusters === undefined) throw new Error("Missing alternative allocations");
  midrange.bytes.fill(0xa5); clusters.bytes.fill(0xa5);
  expect(router.alternativeRouteGoals({ start: zero, startArea: 1, goal: zero, goalArea: 3,
    travelFlags: TravelFlags.DEFAULT, maximumGoals: 4, type: 1 }))
    .toEqual([{ origin: zero, area: 2, startTravelTime: 99, goalTravelTime: 11, extraTravelTime: 87 }]);
  const mid = new DataView(midrange.bytes.buffer, midrange.bytes.byteOffset, midrange.bytes.byteLength);
  expect([mid.getInt32(16, true), mid.getUint16(20, true), mid.getUint16(22, true)]).toEqual([0, 99, 11]);
  expect(midrange.bytes.subarray(0, 16)).toEqual(new Uint8Array(16));
  const cluster = new DataView(clusters.bytes.buffer, clusters.bytes.byteOffset, clusters.bytes.byteLength);
  expect(cluster.getInt32(0, true)).toBe(2);
  expect(cluster.getUint32(12, true)).toBe(0xa5a5a5a5);
  memory.events.length = 0;
  router.initializeAlternativeRouting({ write() {} });
  expect(memory.events).toEqual(["free 32", "allocate 32 heap false", "free 16", "allocate 16 heap false"]);
  expect(() => midrange.bytes).toThrow("freed"); expect(() => clusters.bytes).toThrow("freed");
  expect(router.alternativeRouteGoals({ start: zero, startArea: 1, goal: zero, goalArea: 3,
    travelFlags: TravelFlags.DEFAULT, maximumGoals: 4, type: 1 }))
    .toEqual([{ origin: zero, area: 2, startTravelTime: 12, goalTravelTime: 11, extraTravelTime: 0 }]);
  memory.events.length = 0; router.shutdownAlternativeRouting();
  expect(memory.events).toEqual(["free 32", "free 16"]);
  expect(() => router.alternativeRouteGoals({ start: zero, startArea: 1, goal: zero, goalArea: 3,
    travelFlags: TravelFlags.DEFAULT, maximumGoals: 4, type: 1 })).toThrow("not been initialized");
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024); zone.checkHeap(); zone.dispose();
});

test("alternative routing revalidates warmed scalar views after allocation retirement", () => {
  for (const index of [0, 1]) {
    const memory = new CacheMemory(), router = routing(world(), () => 0, 4 * 1024 * 1024, memory);
    memory.blocks.length = 0;
    let retire = false;
    router.initializeAlternativeRouting({ write() {
      if (!retire) return;
      const allocation = memory.blocks[index];
      if (allocation === undefined) throw new Error("Missing alternative allocation to retire");
      memory.free(allocation);
    } });
    const alternative = { start: zero, startArea: 1, goal: zero, goalArea: 3,
      travelFlags: TravelFlags.DEFAULT, maximumGoals: 4, type: 1 };
    expect(router.alternativeRouteGoals(alternative)).toHaveLength(1);
    retire = true;
    expect(() => router.alternativeRouteGoals(alternative)).toThrow("freed");
    const remaining = memory.blocks[index === 0 ? 1 : 0];
    if (remaining === undefined) throw new Error("Missing remaining alternative allocation");
    memory.free(remaining);
    router.shutdownRouting();
  }
});

test("source allocation abort retains prior cache and alternative allocation publications", () => {
  const zone = new ZoneArena(2048), memory = new CacheMemory(undefined, zone);
  const router = routing(world(true), () => 0, 0, memory);
  const pressure = zone.allocate(zone.memoryRemaining() - 256 - 24, ZoneTag.General);
  memory.blocks.length = 0;
  expect(() => router.route(query)).toThrow("Z_Malloc");
  expect(router.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 1, entries: 2, bytes: 210 });
  expect(memory.blocks.length).toBe(2);
  router.clearCaches(); expect(zone.memoryRemaining()).toBe(256);
  zone.free(pressure); router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(2048); zone.dispose();

  const small = new ZoneArena(128), alternativeMemory = new CacheMemory(undefined, small);
  const alternative = new AasRouting(world(), { memory: alternativeMemory });
  expect(() => alternative.initializeAlternativeRouting({ write() {} })).toThrow("Z_Malloc");
  expect(alternativeMemory.events).toEqual(["allocate 32 heap false", "allocate 16 heap false"]);
  expect(alternativeMemory.blocks.length).toBe(1);
  alternative.shutdownAlternativeRouting();
  expect(alternativeMemory.events.at(-1)).toBe("free 32");
  expect(small.memoryRemaining()).toBe(128); small.checkHeap(); small.dispose();
});

test("source cache type and time links publish only after the routing clock returns", () => {
  const capacity = 2 * 1024 * 1024, zone = new ZoneArena(capacity), memory = new CacheMemory(undefined, zone);
  const router = routing(world(), () => { throw new Error("routing clock aborted"); }, 0, memory);
  memory.blocks.length = 0;
  expect(() => router.route(query)).toThrow("routing clock aborted");
  const block = memory.blocks[0];
  if (block === undefined) throw new Error("Missing published area cache");
  const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
  expect([view.getUint8(0), view.getFloat32(4, true), view.getUint32(48, true), view.getUint32(52, true)])
    .toEqual([0, 0, 0, 0]);
  expect(view.getUint16(60, true)).toBe(22);
  expect(router.cacheStatistics.entries).toBe(1);
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(capacity); zone.checkHeap(); zone.dispose();
});

test("routing graph layouts and query decisions use the actual common-zone allocations", () => {
  const zone = new ZoneArena(2 * 1024 * 1024), memory = new CacheMemory(undefined, zone);
  const router = routing(world(), () => 0, 0, memory);
  expect(memory.events).toEqual(["allocate 16 heap true", "allocate 120 heap true", "allocate 80 heap true",
    "allocate 68 heap true", "allocate 20 heap true", "allocate 16 heap true", "allocate 26 heap true",
    "allocate 4 heap true", "allocate 24 heap true", "allocate 384 heap true"]);
  expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024 - 1040);
  const [contents, areaUpdates, portalUpdates, reversed, clusterHeads, portalHeads, times, maxima, crossings, crossingIndex] = memory.blocks;
  if (contents === undefined || areaUpdates === undefined || portalUpdates === undefined
    || reversed === undefined || clusterHeads === undefined || portalHeads === undefined || times === undefined
    || maxima === undefined || crossings === undefined || crossingIndex === undefined) throw new Error("Missing routing graph allocations");
  const heads = new DataView(clusterHeads.bytes.buffer, clusterHeads.bytes.byteOffset, clusterHeads.bytes.byteLength);
  expect(Array.from({ length: 5 }, (_, index) => heads.getUint32(index * 4, true))).toEqual([9, 9, 0, 0, 0]);
  expect(portalHeads.bytes).toEqual(new Uint8Array(16));
  expect(crossings.bytes).toEqual(new Uint8Array(24));
  expect(crossingIndex.bytes).toEqual(new Uint8Array(384));
  const reverseView = new DataView(reversed.bytes.buffer, reversed.bytes.byteOffset, reversed.bytes.byteLength);
  expect([reverseView.getInt32(16, true), reverseView.getUint32(20, true),
    reverseView.getInt32(24, true), reverseView.getUint32(28, true)]).toEqual([1, 33, 1, 45]);
  expect([reverseView.getInt32(32, true), reverseView.getInt32(36, true), reverseView.getUint32(40, true),
    reverseView.getInt32(44, true), reverseView.getInt32(48, true), reverseView.getUint32(52, true)])
    .toEqual([1, 1, 0, 2, 2, 0]);
  const timeView = new DataView(times.bytes.buffer, times.bytes.byteOffset, times.bytes.byteLength);
  expect(Array.from({ length: 6 }, (_, index) => timeView.getUint32(index * 4, true))).toEqual([17, 17, 21, 27, 21, 25]);
  expect(timeView.getUint16(24, true)).toBe(1);
  expect(portalUpdates.bytes).toEqual(new Uint8Array(80));
  expect(maxima.bytes).toEqual(new Uint8Array(4));
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
  const updates = new DataView(areaUpdates.bytes.buffer, areaUpdates.bytes.byteOffset, areaUpdates.bytes.byteLength);
  expect([updates.getInt32(44, true), updates.getUint16(60, true), updates.getUint32(64, true),
    updates.getInt32(68, true), updates.getUint32(104, true)]).toEqual([2, 11, 25, 0, 0xffffffff]);

  timeView.setUint16(24, 100, true); router.clearCaches();
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 122, nextReachability: 1 });
  const flags = new DataView(contents.bytes.buffer, contents.bytes.byteOffset, contents.bytes.byteLength);
  flags.setInt32(8, TravelFlags.LAVA, true); router.clearCaches();
  expect(router.route(query)).toEqual({ kind: "unreachable" });
  flags.setInt32(8, TravelFlags.AIR, true);
  reverseView.setUint32(20, 0, true); router.clearCaches();
  expect(router.route(query)).toEqual({ kind: "unreachable" });
  reverseView.setUint32(20, 33, true);
  updates.setInt32(68, 1, true); router.clearCaches();
  expect(router.route(query)).toEqual({ kind: "unreachable" });
  updates.setInt32(68, 0, true); router.clearCaches();
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 122, nextReachability: 1 });
  memory.events.length = 0; router.shutdownRouting();
  expect(memory.events).toEqual(["free 73", "free 20", "free 16", "free 26", "free 4", "free 68",
    "free 120", "free 80", "free 24", "free 384", "free 16"]);
  for (const block of [contents, areaUpdates, portalUpdates, reversed, clusterHeads, portalHeads, times, maxima, crossings, crossingIndex]) {
    expect(() => block.bytes).toThrow("freed");
  }
  expect(router.route(query)).toEqual({ kind: "unreachable" });
  expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024); zone.checkHeap(); zone.dispose();
});

test("portal maxima and persistent portal update records retain their source int32 and uint16 cells", () => {
  const zone = new ZoneArena(2 * 1024 * 1024), memory = new CacheMemory(undefined, zone);
  const router = routing(world(true), () => 0, 0, memory);
  const portalUpdates = memory.blocks[2], maxima = memory.blocks[7];
  if (portalUpdates === undefined || maxima === undefined) throw new Error("Missing portal routing allocations");
  expect(maxima.bytes.length).toBe(8);
  const maximum = new DataView(maxima.bytes.buffer, maxima.bytes.byteOffset, maxima.bytes.byteLength);
  expect(maximum.getInt32(4, true)).toBe(1);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 25, nextReachability: 1 });
  maximum.setInt32(4, 50, true);
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 74, nextReachability: 1 });
  router.clearCaches();
  expect(router.route(query)).toEqual({ kind: "found", travelTime: 74, nextReachability: 1 });
  const updates = new DataView(portalUpdates.bytes.buffer, portalUpdates.bytes.byteOffset, portalUpdates.bytes.byteLength);
  expect([updates.getInt32(40, true), updates.getInt32(44, true), updates.getUint16(60, true),
    updates.getInt32(68, true), updates.getInt32(80, true), updates.getInt32(84, true), updates.getUint16(100, true)])
    .toEqual([1, 2, 62, 0, 2, 3, 1]);
  router.shutdownRouting(); expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024); zone.checkHeap(); zone.dispose();
});

test("a failed graph allocation retains earlier source pointers and frees them in source order", () => {
  const zone = new ZoneArena(512), memory = new CacheMemory(undefined, zone);
  const storage = new RoutingStorage(world(), memory);
  storage.initializeContents(); storage.initializeUpdates(); storage.initializeReversed(); storage.initializeAreaTravelTimes();
  expect(() => storage.initializePortalMaxima()).toThrow("Z_Malloc");
  expect(memory.events).toEqual(["allocate 16 heap true", "allocate 120 heap true", "allocate 80 heap true",
    "allocate 68 heap true", "allocate 26 heap true", "allocate 4 heap true"]);
  expect(memory.blocks.length).toBe(5);
  expect(storage.contentsFlags(2)).toBe(TravelFlags.AIR);
  expect([...storage.incoming(2)]).toEqual([{ reachability: 1, area: 1 }]);
  expect([...storage.areaTimeRow(2, 0)]).toEqual([1]);
  memory.events.length = 0;
  storage.freeGraphAndUpdates(); storage.freeContents();
  expect(memory.events).toEqual(["free 26", "free 68", "free 120", "free 80", "free 16"]);
  expect(zone.memoryRemaining()).toBe(512); zone.checkHeap(); zone.dispose();
});

test("cache-head reentry and crossing allocation failure preserve the source pointer publications", () => {
  const zone = new ZoneArena(160), memory = new CacheMemory(undefined, zone), storage = new RoutingStorage(world(), memory);
  storage.initializeClusterCacheHeads(); storage.initializePortalCacheHeads();
  const [clusters, portals] = memory.blocks;
  if (clusters === undefined || portals === undefined) throw new Error("Missing cache head allocations");
  expect(() => storage.initializeClusterCacheHeads()).toThrow("Z_Malloc");
  expect(memory.events).toEqual(["allocate 20 heap true", "allocate 16 heap true", "allocate 20 heap true"]);
  expect([clusters.bytes.length, portals.bytes.length, storage.clusterCacheHead(1, 2), storage.portalCacheHead(3)])
    .toEqual([20, 16, 0, 0]);
  storage.freeClusterCacheHeads(); storage.freePortalCacheHeads();
  expect(zone.memoryRemaining()).toBe(160); zone.checkHeap(); zone.dispose();

  const crossingZone = new ZoneArena(256), crossingMemory = new CacheMemory(undefined, crossingZone);
  const crossings = new RoutingStorage(world(), crossingMemory);
  expect(() => crossings.initializeCrossings()).toThrow("Z_Malloc");
  expect(crossingMemory.events).toEqual(["allocate 24 heap true", "allocate 384 heap true"]);
  expect(crossings.hasCrossings).toBe(true);
  expect(crossings.crossingCount(2)).toBe(0);
  expect(() => crossings.crossingArea(2, 0)).toThrow("not been initialized");
  crossings.freeCrossings(); expect(crossingMemory.events.at(-1)).toBe("free 24");
  expect(crossingZone.memoryRemaining()).toBe(256); crossingZone.checkHeap(); crossingZone.dispose();
});

describe("source i386 route cache dump and managed reader repairs", () => {
  test("preserves source header CRCs, struct offsets, bucket order, array gap and timestamps through actual files", async () => {
    expect(routeCacheCrc16(new Uint8Array(0))).toBe(0xffff);
    expect(routeCacheCrc16(new TextEncoder().encode("123456789"))).toBe(0x29b1);
    const env = await files(), map = world(true), router = routing(map, () => 1 / 3);
    expect(router.route(query)).toEqual({ kind: "found", travelTime: 25, nextReachability: 1 });
    expect(router.cacheStatistics.bytes).toBe(210);
    expect(router.writeRouteCache(() => "maps/layout.rcd", env.host)).toBe(true);
    const bytes = await env.read("maps/layout.rcd"), header = new DataView(bytes.buffer);
    expect([header.getInt32(0, true), header.getInt32(4, true), header.getInt32(8, true), header.getInt32(12, true),
      header.getInt32(24, true), header.getInt32(28, true)]).toEqual([0x4352454d, 2, 4, 3, 1, 2]);
    expect(env.operations).toEqual(["open-write:maps/layout.rcd", "write:32", "write:70", "write:70", "write:70", "close-write"]);
    expect(recordViews(bytes).map(record => [record.getUint8(0), record.getInt32(8, true), record.getInt32(12, true), record.getInt32(16, true)]))
      .toEqual([[0, 70, 2, 3], [1, 70, 1, 2], [1, 70, 2, 3]]);
    for (const record of recordViews(bytes)) {
      expect(record.getFloat32(4, true)).toBe(Math.fround(1 / 3));
      expect(record.getFloat32(32, true)).toBe(1);
      expect(record.getInt32(36, true)).toBe(TravelFlags.DEFAULT);
      for (let index = 40; index < 60; index++) expect(record.getUint8(index)).toBe(0);
      for (let index = 64; index < 68; index++) expect(record.getUint8(index)).toBe(0);
    }
    expect(writeAasFile(map, "maps/layout.aas", { openWrite: name => env.writable.openBinaryWrite(name), print: () => undefined })).toBe(true);
    const aas = await env.read("maps/layout.aas");
    for (let index = 8; index < 124; index++) {
      const value = aas[index];
      if (value === undefined) throw new Error("missing fixture header byte");
      aas[index] = value ^ ((index - 8) * 119);
    }
    const aasHeader = new DataView(aas.buffer);
    for (const [lump, field] of [[7, 16], [13, 20]] satisfies readonly [number, number][]) {
      const start = aasHeader.getInt32(12 + lump * 8, true), length = aasHeader.getInt32(16 + lump * 8, true);
      expect(header.getInt32(field, true)).toBe(routeCacheCrc16(aas.subarray(start, start + length)));
    }
    let time = 5;
    const zone = new ZoneArena(2 * 1024 * 1024), memory = new CacheMemory(undefined, zone);
    const loaded = routing(map, () => time, 0, memory);
    const available = zone.memoryRemaining(); memory.events.length = 0;
    env.operations.length = 0;
    expect(loaded.readRouteCache("maps/layout.rcd", env.host)).toBe(true);
    expect(memory.events).toEqual(["allocate 70 heap false", "allocate 70 heap false", "allocate 70 heap false"]);
    expect(zone.memoryRemaining()).toBe(available - 300);
    expect(env.operations).toEqual(["open-read:maps/layout.rcd", "read:32", "read:12", "read:58", "read:12", "read:58", "read:12", "read:58", "close-read"]);
    expect(loaded.cacheStatistics).toEqual({ areaUpdates: 0, portalUpdates: 0, entries: 3, bytes: 210 });
    expect(loaded.route(query)).toEqual(router.route(query));
    expect(loaded.cacheStatistics.areaUpdates).toBe(0);
    expect(loaded.frameRoutingUpdates).toBe(0);
    time = 8;
    expect(loaded.writeRouteCache(() => "maps/loaded.rcd", env.host)).toBe(true);
    expect(recordViews(await env.read("maps/loaded.rcd")).map(record => record.getFloat32(4, true))).toEqual([5, 5, Math.fround(1 / 3)]);
    expect(env.handles.selectFree().slot).toBe(1);
    loaded.shutdownRouting(); expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024); zone.dispose();
  });

  test("uses the writer reachability offset and relocates pointer bytes instead of interpreting addresses", async () => {
    const env = await files(), map = world(), original = routing(map, () => 2);
    original.route(query);
    original.writeRouteCache(() => "maps/offset.rcd", env.host);
    const bytes = await env.read("maps/offset.rcd"), view = new DataView(bytes.buffer);
    expect(view.getInt32(40, true)).toBe(73);
    bytes.fill(0xa5, 32 + 40, 32 + 60);
    // The correct array begins at 64 + 2*3. Poison the source reader's -2 slot.
    bytes[32 + 68] = 250; bytes[32 + 69] = 251;
    env.write("maps/offset.rcd", bytes);
    const loaded = routing(map, () => 3);
    expect(loaded.readRouteCache("maps/offset.rcd", env.host)).toBe(true);
    expect(loaded.route(query)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
    loaded.writeRouteCache(() => "maps/relocated.rcd", env.host);
    const relocated = await env.read("maps/relocated.rcd");
    expect(relocated.subarray(72, 92)).toEqual(new Uint8Array(20));
    expect(relocated.subarray(100, 102)).toEqual(new Uint8Array([250, 251]));
  });

  test("prepends loaded flag variants and restores the LRU in read order without changing stored times", async () => {
    const env = await files(), map = world();
    let time = 1;
    const original = routing(map, () => time), alternate = TravelFlags.DEFAULT | TravelFlags.ROCKETJUMP;
    original.route(query);
    time = 2; original.route({ ...query, goalArea: 2 });
    time = 3; original.route({ ...query, travelFlags: alternate });
    original.writeRouteCache(() => "maps/order.rcd", env.host);
    const loaded = routing(map, () => 9, 3 * 73);
    expect(loaded.readRouteCache("maps/order.rcd", env.host)).toBe(true);
    loaded.writeRouteCache(() => "maps/prepend.rcd", env.host);
    expect(recordViews(await env.read("maps/prepend.rcd")).map(record => [record.getInt32(16, true), record.getInt32(36, true), record.getFloat32(4, true)]))
      .toEqual([[2, TravelFlags.DEFAULT, 2], [3, TravelFlags.DEFAULT, 1], [3, alternate, 3]]);
    loaded.route({ ...query, travelFlags: TravelFlags.DEFAULT | TravelFlags.BFGJUMP });
    expect(loaded.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 0, entries: 3, bytes: 219 });
    loaded.writeRouteCache(() => "maps/evicted.rcd", env.host);
    expect(recordViews(await env.read("maps/evicted.rcd")).every(record => record.getInt32(16, true) === 3)).toBe(true);
  });

  test("keeps accepted cache records and real file-handle residue when a later record is truncated", async () => {
    const env = await files(), map = world(), original = routing(map, () => 2);
    original.route({ ...query, goalArea: 2 }); original.route(query);
    original.writeRouteCache(() => "maps/prefix.rcd", env.host);
    const bytes = await env.read("maps/prefix.rcd");
    env.write("maps/partial.rcd", bytes.subarray(0, 32 + 73 + 20));
    const zone = new ZoneArena(2 * 1024 * 1024), memory = new CacheMemory(undefined, zone);
    const loaded = routing(map, () => 3, 0, memory);
    const available = zone.memoryRemaining(); memory.events.length = 0;
    expect(() => loaded.readRouteCache("maps/partial.rcd", env.host)).toThrow("short route cache read");
    expect(memory.events).toEqual(["allocate 73 heap false", "allocate 73 heap false"]);
    expect(zone.memoryRemaining()).toBe(available - 208);
    expect(loaded.cacheStatistics).toEqual({ areaUpdates: 0, portalUpdates: 0, entries: 1, bytes: 73 });
    expect(loaded.route({ ...query, goalArea: 2 })).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
    expect(loaded.cacheStatistics.areaUpdates).toBe(0);
    expect(env.handles.selectFree().slot).toBe(2);
    loaded.shutdownRouting();
    expect(zone.memoryRemaining()).toBe(2 * 1024 * 1024 - 104);
    zone.dispose();
  });

  test("rejects incompatible headers and malformed record allocations before publishing them", async () => {
    const env = await files(), map = world(), original = routing(map, () => 0);
    original.route(query); original.writeRouteCache(() => "maps/good.rcd", env.host);
    const good = await env.read("maps/good.rcd");
    for (const [offset, value] of [[0, 0], [4, 3], [8, 100], [12, 100], [16, 0], [20, 0]] satisfies readonly [number, number][]) {
      const bytes = good.slice(); new DataView(bytes.buffer).setInt32(offset, value, true);
      env.write("maps/header.rcd", bytes);
      const loaded = routing(map, () => 0);
      expect(loaded.readRouteCache("maps/header.rcd", env.host)).toBe(false);
      expect(loaded.cacheStatistics.entries).toBe(0);
    }
    expect(env.handles.selectFree().slot).toBe(7);
    expect(env.messages).toContain("4:maps/header.rcd is not a route cache dump\n");
    for (const [offset, value] of [[40, -1], [40, 64], [40, 72], [40, 0x7fffffff], [44, 99], [48, 99], [32, 0]] satisfies readonly [number, number][]) {
      const bytes = good.slice(); new DataView(bytes.buffer).setInt32(offset, value, true);
      env.write("maps/record.rcd", bytes);
      const loaded = routing(map, () => 0);
      expect(() => loaded.readRouteCache("maps/record.rcd", env.host)).toThrow();
      expect(loaded.cacheStatistics.entries).toBe(0);
    }
    const short = routing(map, () => 0);
    env.write("maps/short.rcd", good.subarray(0, 10));
    expect(() => short.readRouteCache("maps/short.rcd", env.host)).toThrow("short route cache read");
    expect(short.readRouteCache("maps/missing.rcd", env.host)).toBe(false);
  });

  test("writes unloaded zero-count tables through the same actual writer", async () => {
    const env = await files();
    expect(writeEmptyRouteCache("maps/.rcd", env.host)).toBe(true);
    const bytes = await env.read("maps/.rcd"), header = new DataView(bytes.buffer);
    expect(bytes.length).toBe(32);
    expect(Array.from({ length: 8 }, (_, index) => header.getInt32(index * 4, true))).toEqual([0x4352454d, 2, 0, 0, 65535, 65535, 0, 0]);
    expect(env.operations).toEqual(["open-write:maps/.rcd", "write:32", "close-write"]);
    expect(env.messages.at(-1)).toBe("1:written 0 bytes of routing cache\n");
  });
});
