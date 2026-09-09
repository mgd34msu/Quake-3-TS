import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BinaryWriter } from "../src/core/binary.ts";
import type { Vec3 } from "../src/core/math.ts";
import { ZoneArena } from "../src/core/zone.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasAreaSettings, AasWorld } from "../src/botlib/aas.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import { AasRouting, areaContentsTravelFlags, areaTravelTime, precomputeRouting, travelFlagForType, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import type { RouteQuery } from "../src/botlib/routing.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { SourceFileHandles } from "../src/assets/file-handles.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
function readyRouting(world: AasWorld, maximumCacheBytes = 16 * 1024 * 1024, memory?: BotMemory): AasRouting {
  const unexpected = (): never => { throw new Error("Routing graph fixture requested BSP host services"); };
  const entities = new AasBspEntities(unexpected);
  entities.load("");
  const spatial = new AasSpatial(world, entities, { print: unexpected, trace: unexpected, pointContents: unexpected,
    entityTrace: unexpected, entityModelIndex: unexpected, modelBounds: unexpected }, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  const routing = new AasRouting(world, memory === undefined ? {} : { memory });
  routing.initializeRouting(spatial, () => maximumCacheBytes, () => 0);
  return routing;
}
const WALK: AasAreaSettings = { contents: 0, flags: 1, presenceType: 2, cluster: 1, clusterAreaNumber: 0, reachableAreaCount: 0, firstReachableArea: 0 };
interface AreaSpec { readonly cluster?: number; readonly contents?: number; readonly flags?: number; readonly presenceType?: number }
interface LinkSpec { readonly from: number; readonly to: number; readonly time?: number; readonly type?: number; readonly start?: Vec3; readonly end?: Vec3 }
interface PortalSpec { readonly area: number; readonly front: number; readonly back: number }

function fixture(areas: readonly AreaSpec[], links: readonly LinkSpec[], portals: readonly PortalSpec[] = []): Uint8Array {
  const clusters = areas.map(area => area.cluster ?? 1);
  const clusterCount = Math.max(1, ...clusters, ...portals.flatMap(portal => [portal.front, portal.back]));
  const members = Array.from({ length: clusterCount + 1 }, (_, cluster) => areas.map((_, index) => index + 1).filter(area => {
    const direct = clusters[area - 1];
    if (direct === cluster) return true;
    const portal = portals.find(portal => portal.area === area);
    return portal !== undefined && (portal.front === cluster || portal.back === cluster);
  }));
  const grouped = areas.map((_, index) => links.filter(link => link.from === index + 1));
  function encode(size: number, write: (writer: BinaryWriter) => void): Uint8Array {
    const writer = new BinaryWriter(size); write(writer); return writer.finish();
  }
  function vector(writer: BinaryWriter, value: Vec3): void { writer.f32(value.x); writer.f32(value.y); writer.f32(value.z); }
  const lumps: Uint8Array[] = Array.from({ length: 14 }, () => new Uint8Array(0));
  lumps[2] = encode(20, writer => { vector(writer, { x: 1, y: 0, z: 0 }); writer.f32(0); writer.i32(0); });
  lumps[7] = encode((areas.length + 1) * 48, writer => {
    for (let area = 0; area <= areas.length; area++) {
      writer.i32(area); writer.i32(0); writer.i32(0);
      vector(writer, ZERO); vector(writer, { x: 1, y: 1, z: 1 }); vector(writer, ZERO);
    }
  });
  lumps[8] = encode((areas.length + 1) * 28, writer => {
    for (let i = 0; i < 7; i++) writer.i32(0);
    let first = 1;
    for (const [index, area] of areas.entries()) {
      const cluster = clusters[index];
      const outgoing = grouped[index];
      if (cluster === undefined || outgoing === undefined) throw new Error("invalid fixture area");
      const clusterMembers = members[cluster];
      writer.i32(area.contents ?? 0); writer.i32(area.flags ?? 1); writer.i32(area.presenceType ?? 2);
      writer.i32(cluster); writer.i32(cluster > 0 && clusterMembers !== undefined ? clusterMembers.indexOf(index + 1) : 0);
      writer.i32(outgoing.length); writer.i32(first); first += outgoing.length;
    }
  });
  lumps[9] = encode((links.length + 1) * 44, writer => {
    writer.bytes(new Uint8Array(44));
    for (const outgoing of grouped) for (const link of outgoing) {
      writer.i32(link.to); writer.i32(0); writer.i32(0);
      vector(writer, link.start ?? ZERO); vector(writer, link.end ?? ZERO);
      writer.i32(link.type ?? TravelType.WALK); writer.u16(link.time ?? 10); writer.u16(0);
    }
  });
  lumps[10] = encode(24, writer => { for (let i = 0; i < 6; i++) writer.i32(0); });
  lumps[11] = encode((portals.length + 1) * 20, writer => {
    writer.bytes(new Uint8Array(20));
    for (const portal of portals) {
      const front = members[portal.front]; const back = members[portal.back];
      if (front === undefined || back === undefined) throw new Error("invalid fixture portal");
      writer.i32(portal.area); writer.i32(portal.front); writer.i32(portal.back);
      writer.i32(front.indexOf(portal.area)); writer.i32(back.indexOf(portal.area));
    }
  });
  const portalLists = members.map((_, cluster) => portals.flatMap((portal, index) => portal.front === cluster || portal.back === cluster ? [index + 1] : []));
  lumps[12] = encode(portalLists.flat().length * 4, writer => { for (const list of portalLists) for (const portal of list) writer.i32(portal); });
  lumps[13] = encode(members.length * 16, writer => {
    let first = 0;
    for (const [cluster, areas] of members.entries()) {
      const list = portalLists[cluster]; if (list === undefined) throw new Error("missing fixture portal list");
      writer.i32(areas.length); writer.i32(areas.length); writer.i32(list.length); writer.i32(first); first += list.length;
    }
  });
  const output = new BinaryWriter(124 + lumps.reduce((size, lump) => size + lump.length, 0));
  output.u32(0x53414145); output.i32(4); output.i32(0);
  let offset = 124;
  for (const lump of lumps) { output.i32(offset); output.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) output.bytes(lump);
  return output.finish();
}

describe("source AAS routing foundations", () => {
  test("maps all travel types, the missing flag bit, and source reachability-team quirk", () => {
    expect(travelFlagForType(TravelType.LADDER)).toBe(0x20);
    expect(travelFlagForType(TravelType.WALKOFFLEDGE)).toBe(0x80);
    expect(travelFlagForType(TravelType.FUNCBOB)).toBe(0x1000000);
    expect(travelFlagForType(TravelType.JUMP | TravelType.NOTTEAM1 | TravelType.NOTTEAM2)).toBe(TravelFlags.JUMP);
    for (const type of [0, 1, 20, 31, 32, -1]) expect(travelFlagForType(type)).toBe(TravelFlags.INVALID);
    expect(TravelFlags.WALK | TravelFlags.CROUCH | TravelFlags.BARRIERJUMP | TravelFlags.JUMP
      | TravelFlags.LADDER | TravelFlags.WALKOFFLEDGE | TravelFlags.SWIM | TravelFlags.WATERJUMP | TravelFlags.TELEPORT
      | TravelFlags.ELEVATOR | TravelFlags.AIR | TravelFlags.WATER | TravelFlags.JUMPPAD | TravelFlags.FUNCBOB).toBe(TravelFlags.DEFAULT);
  });

  test("preserves water/slime/lava precedence and area team/bridge restrictions", () => {
    expect(areaContentsTravelFlags(WALK)).toBe(TravelFlags.AIR);
    expect(areaContentsTravelFlags({ ...WALK, contents: 7 })).toBe(TravelFlags.WATER);
    expect(areaContentsTravelFlags({ ...WALK, contents: 6 })).toBe(TravelFlags.SLIME);
    expect(areaContentsTravelFlags({ ...WALK, contents: 2 })).toBe(TravelFlags.LAVA);
    expect(areaContentsTravelFlags({ ...WALK, contents: 256 | 2048 | 4096, flags: 16 }))
      .toBe(TravelFlags.AIR | TravelFlags.DONOTENTER | TravelFlags.NOTTEAM1 | TravelFlags.NOTTEAM2 | TravelFlags.BRIDGE);
  });

  test("stores exact walking, crouching and swimming times as uint16", () => {
    const end = { x: 300, y: 400, z: 0 };
    expect(areaTravelTime(WALK, ZERO, end)).toBe(165);
    expect(areaTravelTime({ ...WALK, flags: 4 }, ZERO, end)).toBe(500);
    expect(areaTravelTime({ ...WALK, presenceType: 4, flags: 4 }, ZERO, end)).toBe(650);
    expect(areaTravelTime(WALK, ZERO, ZERO)).toBe(1);
    expect(areaTravelTime({ ...WALK, flags: 4 }, ZERO, { x: 65536, y: 0, z: 0 })).toBe(0);
    expect(areaTravelTime({ ...WALK, flags: 4 }, ZERO, { x: 65537, y: 0, z: 0 })).toBe(1);
    expect(() => areaTravelTime(WALK, ZERO, { x: NaN, y: 0, z: 0 })).toThrow(RangeError);
  });

  test("precomputes reversed insertion order and every entry-to-exit area time", () => {
    const world = parseAas(fixture([{}, {}, {}], [
      { from: 1, to: 2, end: { x: 100, y: 0, z: 0 } },
      { from: 2, to: 3, start: ZERO }, { from: 2, to: 1, start: { x: 200, y: 0, z: 0 } },
      { from: 3, to: 2, end: { x: 200, y: 0, z: 0 } },
    ]));
    const graph = precomputeRouting(world);
    expect(graph.reversedReachabilities[2]).toEqual([{ area: 3, reachability: 4 }, { area: 1, reachability: 1 }]);
    expect(graph.areaTravelTimes[2]?.map(row => [...row])).toEqual([[66, 33], [1, 33]]);
    expect(() => precomputeRouting(world, 0)).toThrow("allocation limit");
  });

  test("precomputes the maximum portal traversal cost", () => {
    const world = parseAas(fixture([{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }], [
      { from: 1, to: 2, end: { x: 100, y: 0, z: 0 } },
      { from: 2, to: 3, start: ZERO }, { from: 2, to: 1, start: { x: 200, y: 0, z: 0 } },
      { from: 3, to: 2, end: { x: 200, y: 0, z: 0 } },
    ], [{ area: 2, front: 1, back: 2 }]));
    expect([...precomputeRouting(world).portalMaxTravelTimes]).toEqual([0, 66]);
  });

  test("retains the outgoing cutoff and extends the zero goal seed for oversized incoming lists", () => {
    const areas = Array.from({ length: 131 }, () => ({}));
    const outgoing = parseAas(fixture(areas, Array.from({ length: 129 }, (_, index) => ({ from: 1, to: index + 2 }))));
    const graph = precomputeRouting(outgoing);
    expect(graph.truncatedReachabilityAreas).toEqual([1]);
    expect(graph.reversedReachabilities[129]).toHaveLength(1);
    expect(graph.reversedReachabilities[130]).toHaveLength(0);
    const incoming = parseAas(fixture(areas, Array.from({ length: 129 }, (_, index) => ({ from: index + 1, to: 131 }))));
    expect(precomputeRouting(incoming).reversedReachabilities[131]).toHaveLength(129);
    expect(route(readyRouting(incoming), 1, 131)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
  });
});

function route(router: AasRouting, area: number, goalArea: number, travelFlags: number = TravelFlags.DEFAULT) {
  return router.route({ area, goalArea, travelFlags, origin: ZERO });
}

describe("source ordered AAS caches", () => {
  function dummyClusterWorld(): AasWorld {
    const world = parseAas(fixture([{ cluster: 0 }, {}, {}], []));
    return { ...world,
      clusters: world.clusters.map((cluster, index) => index === 0
        ? { areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 } : cluster),
    };
  }

  test("a dummy start cluster still builds the goal's real portal and area caches", () => {
    const router = readyRouting(dummyClusterWorld());
    expect(route(router, 1, 3)).toEqual({ kind: "unreachable" });
    expect(router.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 1, entries: 2, bytes: 137 });
    expect(router.frameRoutingUpdates).toBe(1);
    expect(route(router, 1, 3)).toEqual({ kind: "unreachable" });
    expect(router.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 1, entries: 2, bytes: 137 });
  });

  test("a dummy goal cache aliases the next row and retains its cleared in-allocation time words", () => {
    const router = readyRouting(dummyClusterWorld());
    expect(route(router, 3, 1)).toEqual({ kind: "unreachable" });
    expect(router.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 1, entries: 2, bytes: 131 });
    expect(route(router, 3, 2)).toEqual({ kind: "unreachable" });
    expect(router.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 2, entries: 3, bytes: 198 });
    expect(router.frameRoutingUpdates).toBe(1);
    router.shutdownRouting();
    expect(router.cacheStatistics.entries).toBe(0);
    expect(router.cacheStatistics.bytes).toBe(0);
  });

  test("a dummy goal reuses an existing aliased cache but rejects missing dummy storage", () => {
    const world = dummyClusterWorld(), router = readyRouting(world);
    expect(route(router, 3, 2)).toEqual({ kind: "unreachable" });
    expect(route(router, 3, 1)).toEqual({ kind: "unreachable" });
    expect(router.cacheStatistics).toEqual({ areaUpdates: 1, portalUpdates: 2, entries: 3, bytes: 204 });
    expect(() => route(readyRouting({ ...world, portals: [] }), 3, 1)).toThrow(RangeError);
    const beyondHeads: AasWorld = { ...world,
      portals: [{ area: 0, frontCluster: 0, backCluster: 0, clusterAreaNumbers: [99, 99] }],
    };
    expect(() => route(readyRouting(beyondHeads), 3, 1)).toThrow(RangeError);
  });

  test("dummy-cluster writer records round-trip through the repaired reader with the retained head alias", () => {
    const world = dummyClusterWorld();
    for (const goals of [[1, 2], [2, 1]]) {
      const original = readyRouting(world), output = new BinaryWriter(4096);
      for (const goal of goals) route(original, 3, goal);
      expect(original.writeRouteCache(() => "authored-dummy.rcd", { print: () => undefined, openWrite: () => ({
        writeBytes: bytes => { output.bytes(bytes); return bytes.length; }, close: () => undefined,
      }) })).toBe(true);
      const bytes = output.finish();
      function readSaved(graph: AasWorld): AasRouting {
        const restored = readyRouting(graph), handles = new SourceFileHandles(), file = handles.selectFree();
        let cursor = 0, closed = false;
        expect(restored.readRouteCache("authored-dummy.rcd", { print: () => undefined,
          openRead: () => ({ file, length: bytes.length }),
          readInto: (handle, destination) => { expect(handle).toBe(file);
            const part = bytes.subarray(cursor, cursor + destination.length); destination.set(part); cursor += part.length; return part.length;
          }, closeFile: handle => { expect(handle).toBe(file); closed = true; },
        })).toBe(true);
        expect(closed).toBe(true); expect(cursor).toBe(bytes.length);
        return restored;
      }
      const restored = readSaved(world);
      const statistics = { ...original.cacheStatistics, areaUpdates: 0, portalUpdates: 0 };
      expect(restored.cacheStatistics).toEqual(statistics);
      expect(route(restored, 3, 1)).toEqual({ kind: "unreachable" });
      expect(route(restored, 3, 2)).toEqual({ kind: "unreachable" });
      expect(restored.cacheStatistics).toEqual(statistics);
      expect(restored.frameRoutingUpdates).toBe(0);
      restored.shutdownRouting(); expect(restored.cacheStatistics.bytes).toBe(0);
      expect(() => readSaved({ ...world, portals: [] })).toThrow();
      expect(() => readSaved({ ...world,
        portals: [{ area: 0, frontCluster: 1, backCluster: 1, clusterAreaNumbers: [0, 0] }],
      })).toThrow("routing cache goal does not belong to its cluster");
      if (goals[0] === 1) {
        expect(() => readSaved({ ...world,
          portals: [{ area: 0, frontCluster: 0, backCluster: 0, clusterAreaNumbers: [99, 99] }],
        })).toThrow(RangeError);
      }
    }
  });

  test("reads disabled flags from retained area settings before routing and re-enabling", () => {
    const world = new AasWorldState(parseAas(fixture([{}, {}, {}], [{ from: 1, to: 2 }, { from: 2, to: 3 }])));
    const router = readyRouting(world), settings = world.areaSettingsRecord(2);
    settings.flags |= 8;
    expect(router.isAreaEnabled(2)).toBe(false);
    expect(route(router, 1, 3)).toEqual({ kind: "unreachable" });
    expect(router.setAreaEnabled(2, true)).toBe(false);
    expect(settings.flags).toBe(1);
    expect(router.isAreaEnabled(2)).toBe(true);
    expect(route(router, 1, 3)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
  });
  test("skips foreign-portal reverse links after source cluster-slot mapping", () => {
    const world = parseAas(fixture([{ cluster: 1 }, { cluster: 1 }, { cluster: 3 }, { cluster: 3 }, { cluster: -1 }], [
      { from: 1, to: 2 }, { from: 5, to: 2 },
    ], [{ area: 5, front: 2, back: 3 }]));
    const router = readyRouting(world);
    // Portal 5's back-side slot is 2. Source maps that slot for cluster 1,
    // then skips it because cluster 1 has only two reachability slots.
    expect(route(router, 1, 2)).toEqual({ kind: "found", travelTime: 12, nextReachability: 1 });
    expect(router.frameRoutingUpdates).toBe(1);
  });

  test("includes entry/exit travel and keeps the first reverse-order winner on ties", () => {
    const router = readyRouting(parseAas(fixture([{}, {}, {}, {}], [
      { from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 },
    ])));
    expect(route(router, 1, 4)).toEqual({ kind: "found", travelTime: 23, nextReachability: 2 });
    const first = router.cacheStatistics;
    expect(route(router, 1, 4)).toEqual({ kind: "found", travelTime: 23, nextReachability: 2 });
    expect(router.cacheStatistics).toEqual(first);
    expect(route(router, 2, 2)).toEqual({ kind: "found", travelTime: 1, nextReachability: 0 });
  });

  test("invalidates disabled-area caches per instance and still permits exiting a disabled area", () => {
    const world = parseAas(fixture([{}, {}, {}], [{ from: 1, to: 2 }, { from: 2, to: 3 }]));
    const first = readyRouting(world); const second = readyRouting(world);
    expect(route(first, 1, 3)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
    expect(first.setAreaEnabled(2, false)).toBe(true);
    expect(first.isAreaEnabled(2)).toBe(false);
    expect(route(first, 1, 3)).toEqual({ kind: "unreachable" });
    expect(route(first, 2, 3)).toEqual({ kind: "found", travelTime: 12, nextReachability: 2 });
    expect(route(second, 1, 3)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
    expect(first.setAreaEnabled(2, true)).toBe(false);
    expect(route(first, 1, 3)).toEqual({ kind: "found", travelTime: 23, nextReachability: 1 });
  });

  test("filters destination contents, including team and bridge restrictions", () => {
    for (const [contents, flags, allow] of [
      [1, 4, TravelFlags.WATER], [4, 4, TravelFlags.SLIME], [2, 4, TravelFlags.LAVA],
      [2048, 1, TravelFlags.NOTTEAM1], [4096, 1, TravelFlags.NOTTEAM2], [0, 16, TravelFlags.BRIDGE],
    ] satisfies [number, number, number][]) {
      const router = readyRouting(parseAas(fixture([{}, { contents, flags }, {}], [{ from: 1, to: 2 }, { from: 2, to: 3 }])));
      const base = TravelFlags.DEFAULT & ~allow;
      expect(route(router, 1, 3, base)).toEqual({ kind: "unreachable" });
      expect(route(router, 1, 3, base | allow).kind).toBe("found");
    }
  });

  test("automatically allows do-not-enter when either endpoint needs it", () => {
    const through = readyRouting(parseAas(fixture([{}, { contents: 256 }, {}], [{ from: 1, to: 2 }, { from: 2, to: 3 }])));
    expect(route(through, 1, 3).kind).toBe("unreachable");
    expect(route(through, 1, 2).kind).toBe("found");
    expect(route(through, 2, 3).kind).toBe("found");
    expect(route(through, 1, 3, TravelFlags.DEFAULT | TravelFlags.DONOTENTER).kind).toBe("found");
    const restricted = readyRouting(parseAas(fixture([{}, {}], [{ from: 1, to: 2, type: TravelType.WALK | TravelType.NOTTEAM1 }])));
    expect(route(restricted, 1, 2).kind).toBe("found");
  });

  test("retains the different uint16 cache and int result storage boundaries", () => {
    const large = readyRouting(parseAas(fixture([{}, {}], [{ from: 1, to: 2, time: 65534 }])));
    expect(route(large, 1, 2)).toEqual({ kind: "found", travelTime: 65536, nextReachability: 1 });
    const wrapped = readyRouting(parseAas(fixture([{}, {}, {}], [{ from: 1, to: 2, time: 65534 }, { from: 2, to: 3, time: 3 }])));
    expect(route(wrapped, 1, 3)).toEqual({ kind: "found", travelTime: 4, nextReachability: 1 });
    const zero = readyRouting(parseAas(fixture([{}, {}], [{ from: 1, to: 2, time: 65535 }])));
    expect(route(zero, 1, 2)).toEqual({ kind: "unreachable" });
  });

  test("uses cluster portal caches and source portal maxima, then invalidates both sides", () => {
    const router = readyRouting(parseAas(fixture([{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }], [
      { from: 1, to: 2 }, { from: 2, to: 3 },
    ], [{ area: 2, front: 1, back: 2 }])));
    expect(route(router, 1, 3)).toEqual({ kind: "found", travelTime: 25, nextReachability: 1 });
    expect(router.cacheStatistics.portalUpdates).toBe(1);
    router.setAreaEnabled(2, false);
    expect(router.cacheStatistics.entries).toBe(0);
    expect(route(router, 1, 3)).toEqual({ kind: "unreachable" });
    router.setAreaEnabled(2, true);
    expect(route(router, 1, 3)).toEqual({ kind: "found", travelTime: 25, nextReachability: 1 });
  });

  test("prefers an available same-cluster route even when leaving the cluster would be shorter", () => {
    const router = readyRouting(parseAas(fixture([{ cluster: 1 }, { cluster: -1 }, { cluster: -2 }, { cluster: 1 }, { cluster: 2 }], [
      { from: 1, to: 4, time: 1000 }, { from: 1, to: 2, time: 1 },
      { from: 2, to: 5, time: 1 }, { from: 5, to: 3, time: 1 }, { from: 3, to: 4, time: 1 },
    ], [{ area: 2, front: 1, back: 2 }, { area: 3, front: 1, back: 2 }])));
    expect(route(router, 1, 4)).toEqual({ kind: "found", travelTime: 1002, nextReachability: 1 });
  });

  test("preserves success with zero time and untouched next-reachability byte for portal origins", () => {
    const router = readyRouting(parseAas(fixture([{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }, { cluster: -2 }, { cluster: 3 }], [
      { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 },
    ], [{ area: 2, front: 1, back: 2 }, { area: 4, front: 2, back: 3 }])));
    expect(route(router, 2, 5)).toEqual({ kind: "found", travelTime: 35, nextReachability: 2 });
    router.setAreaEnabled(4, false);
    expect(route(router, 2, 5)).toEqual({ kind: "found", travelTime: 0, nextReachability: 2 });
  });

  test("bounds external queries and cache allocation, evicts ordinary caches and can rebuild", () => {
    const world = parseAas(fixture([{}, {}, {}], [{ from: 1, to: 2 }, { from: 2, to: 3 }]));
    const router = readyRouting(world, 73);
    for (const area of [-1, 0, 4, 1.5, NaN]) expect(route(router, area, 3).kind).toBe("unreachable");
    expect(() => router.route({ area: 1, goalArea: 3, origin: { x: Infinity, y: 0, z: 0 }, travelFlags: TravelFlags.DEFAULT })).toThrow(RangeError);
    expect(() => route(router, 1, 3, NaN)).toThrow(RangeError);
    expect(route(router, 1, 2).kind).toBe("found");
    expect(route(router, 1, 3).kind).toBe("found");
    expect(router.cacheStatistics.entries).toBe(1);
    expect(router.cacheStatistics.bytes).toBe(73);
    router.clearCaches();
    expect(router.cacheStatistics.bytes).toBe(0);
    expect(route(router, 1, 3).kind).toBe("found");
    expect(() => route(readyRouting(world, 72), 1, 3)).toThrow("allocation limit");
  });

  test("a failed nested portal cache allocation releases the in-progress cache", () => {
    const router = readyRouting(parseAas(fixture([{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }], [
      { from: 1, to: 2 }, { from: 2, to: 3 },
    ], [{ area: 2, front: 1, back: 2 }])), 70);
    expect(() => route(router, 1, 3)).toThrow("allocation limit");
    expect(router.cacheStatistics.bytes).toBe(0);
    expect(router.cacheStatistics.entries).toBe(0);
    expect(route(router, 2, 3)).toEqual({ kind: "found", travelTime: 12, nextReachability: 2 });
  });
});

const oraclePath = Bun.env["Q3_ROUTING_ORACLE"];
function oracle(bytes: Uint8Array, commands: readonly string[], executable = oraclePath): readonly string[] {
  if (executable === undefined) throw new Error("Q3_ROUTING_ORACLE must point to the external original-C oracle");
  const commandBytes = new TextEncoder().encode(commands.join("\n") + "\n");
  const writer = new BinaryWriter(4 + bytes.length + commandBytes.length);
  writer.u32(bytes.length); writer.bytes(bytes); writer.bytes(commandBytes);
  const child = Bun.spawnSync([executable], { stdin: writer.finish(), timeout: 60_000 });
  if (child.exitCode !== 0) throw new Error(`routing oracle failed with exit ${child.exitCode}, signal ${child.signalCode}: ${child.stderr.toString()}`);
  return child.stdout.toString().trim().split("\n");
}

function queryCommand(query: RouteQuery): string {
  return `0 ${query.area} ${query.goalArea} ${query.travelFlags | 0} ${query.origin.x} ${query.origin.y} ${query.origin.z}`;
}
function queryResult(router: AasRouting, query: RouteQuery): string {
  const result = router.route(query);
  return result.kind === "unreachable" ? "0 0 0" : `1 ${result.travelTime} ${result.nextReachability}`;
}

test.skipIf(oraclePath === undefined)("matches original C across synthetic ties, flags, disabled areas, portals and uint16 wrap", () => {
  const cases: Uint8Array[] = [
    fixture([{}, {}, {}, {}], [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 }]),
    fixture([{}, {}, {}], [{ from: 1, to: 2, time: 65534 }, { from: 2, to: 3, time: 3 }]),
    fixture([{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }, { cluster: -2 }, { cluster: 3 }], [
      { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 },
    ], [{ area: 2, front: 1, back: 2 }, { area: 4, front: 2, back: 3 }]),
  ];
  for (const [contents, flags, presenceType] of [[1, 4, 2], [2, 4, 2], [4, 4, 2], [256, 1, 2], [2048, 1, 2], [4096, 1, 2], [0, 16, 2], [0, 1, 4]] satisfies [number, number, number][]) {
    cases.push(fixture([{}, { contents, flags, presenceType }, {}], [
      { from: 1, to: 2, type: TravelType.WALK | TravelType.NOTTEAM1 },
      { from: 2, to: 3, start: { x: 300, y: 400, z: 0 } },
    ]));
  }
  for (const bytes of cases) {
    const world = parseAas(bytes); const router = readyRouting(world);
    const commands: string[] = []; const expected: string[] = [];
    for (const enabled of [true, false, true]) {
      commands.push(`1 2 ${enabled ? 1 : 0}`); expected.push(router.setAreaEnabled(2, enabled) ? "1" : "0");
      for (const travelFlags of [TravelFlags.DEFAULT, 0x1fffffff, TravelFlags.WALK | TravelFlags.AIR]) {
        for (let area = 1; area < world.areas.length; area++) for (let goalArea = 1; goalArea < world.areas.length; goalArea++) {
          const query = { area, goalArea, travelFlags, origin: ZERO };
          commands.push(queryCommand(query)); expected.push(queryResult(router, query));
        }
      }
    }
    expect(oracle(bytes, commands)).toEqual(expected);
  }
});

const retailPath = Bun.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(oraclePath === undefined || !existsSync(join(retailPath, "missionpack/pak0.pk3")))("matches seeded original-C routes on q3dm1 and mpteam1", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "missionpack" });
  for (const name of ["q3dm1", "mpteam1"]) {
    const bytes = await vfs.read(`maps/${name}.aas`); const world = parseAas(bytes); const router = readyRouting(world);
    let seed = 0x1984;
    function random(max: number): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
    const areas = world.areaSettings.flatMap((settings, index) => settings.cluster !== 0 && settings.reachableAreaCount > 0 ? [index] : []);
    const commands: string[] = []; const expected: string[] = [];
    for (let iteration = 0; iteration < 240; iteration++) {
      const area = areas[random(areas.length)]; const goalArea = areas[random(areas.length)];
      if (area === undefined || goalArea === undefined) throw new Error("missing retail routing area");
      const record = world.areas[area]; if (record === undefined) throw new Error("missing retail area geometry");
      const query = { area, goalArea, origin: record.center, travelFlags: iteration % 3 === 0 ? 0x1fffffff : TravelFlags.DEFAULT };
      commands.push(queryCommand(query)); expected.push(queryResult(router, query));
      if (iteration % 12 === 0) {
        commands.push(`1 ${goalArea} 0`); expected.push(router.setAreaEnabled(goalArea, false) ? "1" : "0");
        commands.push(queryCommand(query)); expected.push(queryResult(router, query));
        commands.push(`1 ${goalArea} 1`); expected.push(router.setAreaEnabled(goalArea, true) ? "1" : "0");
      }
    }
    expect(oracle(bytes, commands)).toEqual(expected);
  }
}, 60_000);

// Captured using unchanged be_aas_route.c and q_math.c, source commit
// dbe4ddb10315479fc00086f08e25d968b4b43c49. Origins are the stored area centers.
interface RetailRouteFixture {
  readonly name: string;
  readonly sha256: string;
  readonly routes: readonly (readonly [number, number, number, number, number])[];
}
const RETAIL_ROUTES: readonly RetailRouteFixture[] = [
  { name: "q3dm1", sha256: "2070b35b34b9820b84a5e1e1cbdcd50791fb091f15d04aa68692ab561e7b44cc", routes: [
    [175, 5, 536870911, 325, 327], [731, 504, 18616254, 224, 1204], [831, 108, 18616254, 693, 1397],
    [760, 1515, 536870911, 16, 1266], [791, 8, 18616254, 784, 1347], [1591, 759, 18616254, 74, 1787],
  ] },
  { name: "mpteam1", sha256: "6b1893bbfd9c31de2eb4c1fa946b7caf43ff83f651dd001e4a811db3f7978e5f", routes: [
    [426, 5811, 536870911, 2219, 609], [3223, 528, 18616254, 950, 4455], [3326, 4085, 18616254, 991, 4497],
    [1990, 5229, 536870911, 1250, 2701], [7066, 4076, 18616254, 794, 10051], [5512, 1304, 18616254, 1650, 8011],
    [42, 5811, 18616254, 0, 66], [43, 5811, 18616254, 2067, 66], [44, 5811, 18616254, 0, 68], [45, 5811, 18616254, 0, 68],
  ] },
];

test.skipIf(!existsSync(join(retailPath, "missionpack/pak0.pk3")))("replays hash-identified retail source fixtures without a native oracle", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "missionpack" });
  for (const fixture of RETAIL_ROUTES) {
    const bytes = await vfs.read(`maps/${fixture.name}.aas`);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
    const world = parseAas(bytes), capacity = 16 * 1024 * 1024, zone = new ZoneArena(capacity);
    const routers = [readyRouting(world), readyRouting(world, capacity, new BotMemory(undefined, zone))];
    expect(zone.memoryRemaining()).toBeLessThan(capacity);
    for (const router of routers) {
      for (let pass = 0; pass < 3; pass++) {
        if (pass === 2) router.clearCaches();
        for (const [area, goalArea, travelFlags, travelTime, nextReachability] of fixture.routes) {
          const start = world.areas[area]; if (start === undefined) throw new Error("invalid retail fixture origin");
          expect(router.route({ area, goalArea, origin: start.center, travelFlags })).toEqual({ kind: "found", travelTime, nextReachability });
        }
      }
      router.shutdownRouting();
    }
    expect(zone.memoryRemaining()).toBe(capacity); zone.checkHeap(); zone.dispose();
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
  }
}, 60_000);

test.skipIf(!existsSync(join(retailPath, "missionpack/pak0.pk3")))("precomputes every installed graph and routes through the repaired retail goal seed", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath: retailPath, homePath: retailPath, cdPath: null, product: "missionpack" });
  const paths = vfs.list("maps").filter(path => path.startsWith("maps/") && path.endsWith(".aas"));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const bytes = await vfs.read(path);
    const world = parseAas(bytes);
    const graph = precomputeRouting(world);
    expect(graph.areaTravelTimes).toHaveLength(world.areas.length);
    expect(graph.portalMaxTravelTimes).toHaveLength(world.portals.length);
    if (path === "maps/mpq3tourney6.aas") {
      expect(graph.reversedReachabilities[1887]).toHaveLength(134);
      const incoming = graph.reversedReachabilities[1887]?.[0];
      if (incoming === undefined) throw new Error("missing retail overflow fixture link");
      const router = readyRouting(world);
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
        .toBe("2f9b74e7af07faaa9d3bf67d0d579eec1c23139e97258957f9e3efdd1ffcf929");
      // These are correction fixtures, not stock-C parity: the external oracle
      // extends the C zero seed to 256 shorts. Origins here are zero, not centers.
      for (const [area, travelTime, nextReachability] of [
        [2740, 484, 2683], [2321, 1302, 2290], [2319, 1302, 2289],
        [515, 1835, 594], [426, 1835, 513], [424, 1835, 512],
      ] satisfies [number, number, number][]) {
        expect(route(router, area, 1887, 0x1fffffff)).toEqual({ kind: "found", travelTime, nextReachability });
      }
      const correctedOracle = Bun.env["Q3_ROUTING_REPAIRED_ORACLE"];
      if (correctedOracle !== undefined) {
        const incoming = graph.reversedReachabilities[1887];
        if (incoming === undefined) throw new Error("missing retail portal incoming links");
        const queries = incoming.map(link => ({ area: link.area, goalArea: 1887, travelFlags: 0x1fffffff, origin: ZERO }));
        expect(oracle(bytes, queries.map(queryCommand), correctedOracle)).toEqual(queries.map(query => queryResult(router, query)));
      }
    }
  }
}, 60_000);
