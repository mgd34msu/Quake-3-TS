import { describe, expect, expectTypeOf, test } from "bun:test";
import { BinaryWriter } from "../src/core/binary.ts";
import type { Vec3 } from "../src/core/math.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasWorld } from "../src/botlib/aas.ts";
import { AasSpatial, BotBrushModelTypes } from "../src/botlib/spatial.ts";
import { AasBspEntities } from "../src/botlib/bsp-entities.ts";
import { AasLinkHeap } from "../src/botlib/aas-links.ts";
import { DEFAULT_AAS_MOVEMENT_SETTINGS } from "../src/botlib/aas-movement.ts";
import { AasRouting, TravelFlags, TravelType } from "../src/botlib/routing.ts";
import type { AreaTravelTimeQuery, RouteQuery, RouteResult } from "../src/botlib/routing.ts";

function linkHeap(): AasLinkHeap {
  const heap = new AasLinkHeap(() => { throw new Error("Unexpected empty AAS fixture link heap"); });
  heap.initialize(() => 6144);
  return heap;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
function readyRouting(world: AasWorld, maximumCacheBytes = 16 * 1024 * 1024): AasRouting {
  const unexpected = (): never => { throw new Error("Routing graph fixture requested BSP host services"); };
  const entities = new AasBspEntities(unexpected);
  entities.load("");
  const spatial = new AasSpatial(world, entities, { print: unexpected, trace: unexpected, pointContents: unexpected,
    entityTrace: unexpected, entityModelIndex: unexpected, modelBounds: unexpected }, DEFAULT_AAS_MOVEMENT_SETTINGS, new BotBrushModelTypes(), linkHeap(), { kind: "disabled" }, () => 0);
  const routing = new AasRouting(world);
  routing.initializeRouting(spatial, () => maximumCacheBytes, () => 0);
  return routing;
}
interface Area { readonly cluster: number; readonly contents?: number }
interface Link { readonly from: number; readonly to: number; readonly time: number; readonly start?: Vec3 }
interface Portal { readonly area: number; readonly front: number; readonly back: number }
interface Graph { readonly areas: readonly Area[]; readonly links: readonly Link[]; readonly portals: readonly Portal[] }

// Same binary fixture convention as routing.test.ts; real parseAas and caches execute.
function fixture(graph: Graph): Uint8Array {
  const { areas, links, portals } = graph;
  const clusterCount = Math.max(1, ...areas.map(area => area.cluster), ...portals.flatMap(portal => [portal.front, portal.back]));
  const members = Array.from({ length: clusterCount + 1 }, (_, cluster) => areas.flatMap((area, index) => {
    const portal = portals.find(portal => portal.area === index + 1);
    return area.cluster === cluster || (portal !== undefined && (portal.front === cluster || portal.back === cluster)) ? [index + 1] : [];
  }));
  const grouped = areas.map((_, index) => links.filter(link => link.from === index + 1));
  function encode(size: number, write: (writer: BinaryWriter) => void): Uint8Array {
    const writer = new BinaryWriter(size); write(writer); return writer.finish();
  }
  function vector(writer: BinaryWriter, point: Vec3): void { writer.f32(point.x); writer.f32(point.y); writer.f32(point.z); }
  function memberList(cluster: number): readonly number[] {
    const list = members[cluster]; if (list === undefined) throw new Error("Invalid fixture cluster"); return list;
  }
  const lumps: Uint8Array[] = Array.from({ length: 14 }, () => new Uint8Array(0));
  lumps[2] = encode(20, writer => { vector(writer, { x: 1, y: 0, z: 0 }); writer.f32(0); writer.i32(0); });
  lumps[7] = encode((areas.length + 1) * 48, writer => {
    for (let area = 0; area <= areas.length; area++) {
      writer.i32(area); writer.i32(0); writer.i32(0); vector(writer, ZERO);
      vector(writer, { x: 1, y: 1, z: 1 }); vector(writer, ZERO);
    }
  });
  lumps[8] = encode((areas.length + 1) * 28, writer => {
    writer.bytes(new Uint8Array(28));
    let first = 1;
    for (const [index, area] of areas.entries()) {
      const outgoing = grouped[index]; if (outgoing === undefined) throw new Error("Missing fixture links");
      writer.i32(area.contents ?? 0); writer.i32(1); writer.i32(2); writer.i32(area.cluster);
      writer.i32(area.cluster > 0 ? memberList(area.cluster).indexOf(index + 1) : 0);
      writer.i32(outgoing.length); writer.i32(first); first += outgoing.length;
    }
  });
  lumps[9] = encode((links.length + 1) * 44, writer => {
    writer.bytes(new Uint8Array(44));
    for (const outgoing of grouped) for (const link of outgoing) {
      writer.i32(link.to); writer.i32(0); writer.i32(0); vector(writer, link.start ?? ZERO); vector(writer, ZERO);
      writer.i32(TravelType.WALK); writer.u16(link.time); writer.u16(0);
    }
  });
  lumps[10] = new Uint8Array(24);
  lumps[11] = encode((portals.length + 1) * 20, writer => {
    writer.bytes(new Uint8Array(20));
    for (const portal of portals) {
      writer.i32(portal.area); writer.i32(portal.front); writer.i32(portal.back);
      writer.i32(memberList(portal.front).indexOf(portal.area)); writer.i32(memberList(portal.back).indexOf(portal.area));
    }
  });
  const portalLists = members.map((_, cluster) => portals.flatMap((portal, index) => portal.front === cluster || portal.back === cluster ? [index + 1] : []));
  lumps[12] = encode(portalLists.flat().length * 4, writer => { for (const list of portalLists) for (const portal of list) writer.i32(portal); });
  lumps[13] = encode(members.length * 16, writer => {
    let first = 0;
    for (const [cluster, list] of members.entries()) {
      const clusterPortals = portalLists[cluster]; if (clusterPortals === undefined) throw new Error("Missing fixture portals");
      writer.i32(list.length); writer.i32(list.length); writer.i32(clusterPortals.length); writer.i32(first); first += clusterPortals.length;
    }
  });
  const writer = new BinaryWriter(124 + lumps.reduce((sum, lump) => sum + lump.length, 0));
  writer.u32(0x53414145); writer.i32(4); writer.i32(0);
  let offset = 124;
  for (const lump of lumps) { writer.i32(offset); writer.i32(lump.length); offset += lump.length; }
  for (const lump of lumps) writer.bytes(lump);
  return writer.finish();
}

function chain(firstTime = 10, firstStart: Vec3 = ZERO): Graph {
  return { areas: [{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }, { cluster: -2 }, { cluster: 3 }, { cluster: 3 }],
    links: [{ from: 1, to: 2, time: firstTime, start: firstStart }, { from: 2, to: 3, time: 10 },
      { from: 3, to: 4, time: 10 }, { from: 4, to: 5, time: 10 }],
    portals: [{ area: 2, front: 1, back: 2 }, { area: 4, front: 2, back: 3 }] };
}
function alternatives(firstTime = 10, secondTime = 10): Graph {
  return { areas: [{ cluster: 1 }, { cluster: -1 }, { cluster: -2 }, { cluster: 2 }],
    links: [{ from: 1, to: 2, time: firstTime }, { from: 1, to: 3, time: secondTime },
      { from: 2, to: 4, time: 10 }, { from: 3, to: 4, time: 10 }],
    portals: [{ area: 2, front: 1, back: 2 }, { area: 3, front: 1, back: 2 }] };
}
function clusterDetour(): Graph {
  return { areas: [{ cluster: 1 }, { cluster: -1 }, { cluster: 2 }, { cluster: -2 }, { cluster: 1 }],
    links: [{ from: 1, to: 2, time: 10 }, { from: 2, to: 3, time: 10 }, { from: 3, to: 4, time: 10 }, { from: 4, to: 5, time: 10 }],
    portals: [{ area: 2, front: 1, back: 2 }, { area: 4, front: 1, back: 2 }] };
}
function query(area: number, goalArea: number, origin: Vec3 | null = null, travelFlags: number = TravelFlags.DEFAULT): AreaTravelTimeQuery {
  return { area, goalArea, origin, travelFlags };
}
function fullRoute(router: AasRouting, area: number, goalArea: number, origin: Vec3 = ZERO): RouteResult {
  return router.route({ area, goalArea, origin, travelFlags: TravelFlags.DEFAULT });
}

describe("source omitted-origin AAS travel time", () => {
  test("keeps non-null route types and the existing valid-area and validation order", () => {
    expectTypeOf<RouteQuery["origin"]>().toEqualTypeOf<Vec3>();
    expectTypeOf<AreaTravelTimeQuery["origin"]>().toEqualTypeOf<Vec3 | null>();
    const router = readyRouting(parseAas(fixture(chain())));
    for (const [area, goal] of [[0, 0], [-1, -1], [7, 7], [0, 5], [1.5, 5]] satisfies readonly [number, number][]) {
      expect(router.areaTravelTimeToGoal(query(area, goal))).toBe(0);
      expect(fullRoute(router, area, goal)).toEqual({ kind: "unreachable" });
    }
    expect(router.areaTravelTimeToGoal(query(0, 0, { x: NaN, y: 0, z: 0 }, NaN))).toBe(0);
    expect(() => router.areaTravelTimeToGoal(query(1, 1, null, NaN))).toThrow("32-bit mask");
    expect(() => router.areaTravelTimeToGoal(query(1, 1, { x: Infinity, y: 0, z: 0 }))).toThrow("finite float32");
    expect(router.areaTravelTimeToGoal(query(1, 1))).toBe(1);
    expect(router.cacheStatistics.entries).toBe(0);
  });

  test("defined same-cluster and start-portal branches retain successful zero time", () => {
    const router = readyRouting(parseAas(fixture(chain())));
    for (const [area, goal, time] of [[1, 2, 11], [2, 3, 11], [2, 5, 35], [2, 6, 0], [1, 6, 0]] satisfies readonly [number, number, number][]) {
      expect(router.areaTravelTimeToGoal(query(area, goal))).toBe(time);
    }
    expect(fullRoute(router, 2, 6)).toEqual({ kind: "found", travelTime: 0, nextReachability: 2 });
    expect(fullRoute(router, 1, 6)).toEqual({ kind: "unreachable" });
  });

  test("approved undefined-success repair publishes candidate time without fabricating an origin", () => {
    // Unchanged C, explicit reach output 0: 24/47. An initial -1 instead returns
    // false and leaves the time output untouched. This is a success-policy repair.
    const router = readyRouting(parseAas(fixture(chain())));
    expect(router.areaTravelTimeToGoal(query(1, 3))).toBe(24);
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(47);
    expect(fullRoute(router, 1, 3)).toEqual({ kind: "found", travelTime: 25, nextReachability: 1 });
    expect(fullRoute(router, 1, 5)).toEqual({ kind: "found", travelTime: 48, nextReachability: 1 });
    const shifted = readyRouting(parseAas(fixture(chain(10, { x: 300, y: 0, z: 0 }))));
    expect(shifted.areaTravelTimeToGoal(query(1, 2))).toBe(11);
    expect(shifted.areaTravelTimeToGoal(query(1, 3))).toBe(24);
    expect(shifted.areaTravelTimeToGoal(query(1, 2, ZERO))).toBe(110);
    expect(shifted.areaTravelTimeToGoal(query(1, 3, ZERO))).toBe(123);
  });

  test("same-cluster cache uint16 and non-null result int remain distinct", () => {
    const graph: Graph = { areas: [{ cluster: 1 }, { cluster: 1 }], links: [{ from: 1, to: 2, time: 65534 }], portals: [] };
    const router = readyRouting(parseAas(fixture(graph)));
    expect(router.areaTravelTimeToGoal(query(1, 2))).toBe(65535);
    expect(router.areaTravelTimeToGoal(query(1, 2, ZERO))).toBe(65536);
    expect(fullRoute(router, 1, 2)).toEqual({ kind: "found", travelTime: 65536, nextReachability: 1 });
  });

  test("same-cluster misses still search portals and preserve contents/travel restrictions", () => {
    const detour = readyRouting(parseAas(fixture(clusterDetour())));
    expect(detour.areaTravelTimeToGoal(query(1, 5))).toBe(47);
    expect(fullRoute(detour, 1, 5)).toEqual({ kind: "found", travelTime: 48, nextReachability: 1 });
    const graph: Graph = { areas: [{ cluster: 1 }, { cluster: 1, contents: 256 }, { cluster: 1 }],
      links: [{ from: 1, to: 2, time: 10 }, { from: 2, to: 3, time: 10 }], portals: [] };
    const restricted = readyRouting(parseAas(fixture(graph)));
    expect(restricted.areaTravelTimeToGoal(query(1, 3))).toBe(0);
    expect(restricted.areaTravelTimeToGoal(query(1, 2))).toBe(11);
    expect(restricted.areaTravelTimeToGoal(query(1, 3, null, TravelFlags.DEFAULT | TravelFlags.DONOTENTER))).toBe(22);
    expect(restricted.areaTravelTimeToGoal(query(1, 3, null, 0))).toBe(0);
  });

  test("multiple portals preserve equal ties and source zero-best replacement", () => {
    const tied = readyRouting(parseAas(fixture(alternatives())));
    expect(tied.areaTravelTimeToGoal(query(1, 4))).toBe(24);
    expect(fullRoute(tied, 1, 4)).toEqual({ kind: "found", travelTime: 25, nextReachability: 1 });
    const cheaper = readyRouting(parseAas(fixture(alternatives(10, 3))));
    expect(cheaper.areaTravelTimeToGoal(query(1, 4))).toBe(17);
    expect(fullRoute(cheaper, 1, 4)).toEqual({ kind: "found", travelTime: 18, nextReachability: 2 });
    const zeroThenLater = readyRouting(parseAas(fixture(alternatives(65522, 10))));
    expect(zeroThenLater.areaTravelTimeToGoal(query(1, 4))).toBe(24);
    expect(fullRoute(zeroThenLater, 1, 4)).toEqual({ kind: "found", travelTime: 1, nextReachability: 1 });
    const onlyZero = readyRouting(parseAas(fixture(chain(65522))));
    expect(onlyZero.areaTravelTimeToGoal(query(1, 3))).toBe(0);
    expect(fullRoute(onlyZero, 1, 3)).toEqual({ kind: "found", travelTime: 1, nextReachability: 1 });
  });

  test("both APIs share warmed caches and disabled-area invalidation", () => {
    const router = readyRouting(parseAas(fixture(chain())));
    expect(fullRoute(router, 1, 5).kind).toBe("found");
    const warmed = router.cacheStatistics;
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(47);
    expect(router.cacheStatistics).toEqual(warmed);
    expect(router.setAreaEnabled(2, false)).toBe(true);
    // Disabling portal 2 clears clusters 1/2 and portal caches, not cluster 3.
    expect(router.cacheStatistics.entries).toBe(1);
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(0);
    expect(fullRoute(router, 1, 5)).toEqual({ kind: "unreachable" });
    expect(router.setAreaEnabled(2, true)).toBe(false);
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(47);
    const rebuilt = router.cacheStatistics;
    expect(fullRoute(router, 1, 5)).toEqual({ kind: "found", travelTime: 48, nextReachability: 1 });
    expect(router.cacheStatistics).toEqual(rebuilt);
  });

  test("time-only reads update the same eviction order and caches stay instance-local", () => {
    const graph: Graph = { areas: Array.from({ length: 4 }, () => ({ cluster: 1 })),
      links: [{ from: 1, to: 2, time: 10 }, { from: 1, to: 3, time: 10 }, { from: 1, to: 4, time: 10 }], portals: [] };
    const world = parseAas(fixture(graph)), router = readyRouting(world, 2 * (64 + 3 * 4));
    fullRoute(router, 1, 2); fullRoute(router, 1, 3);
    expect(router.cacheStatistics).toEqual({ areaUpdates: 2, portalUpdates: 0, entries: 2, bytes: 152 });
    expect(router.areaTravelTimeToGoal(query(1, 2))).toBe(11);
    expect(router.areaTravelTimeToGoal(query(1, 4))).toBe(11);
    expect(router.cacheStatistics.areaUpdates).toBe(3);
    fullRoute(router, 1, 2);
    expect(router.cacheStatistics.areaUpdates).toBe(3);
    fullRoute(router, 1, 3);
    expect(router.cacheStatistics).toEqual({ areaUpdates: 4, portalUpdates: 0, entries: 2, bytes: 152 });
    const separate = readyRouting(world);
    expect(separate.cacheStatistics.entries).toBe(0);
    router.clearCaches();
    expect(router.cacheStatistics.entries).toBe(0);
    expect(separate.areaTravelTimeToGoal(query(1, 2))).toBe(11);
    expect(router.cacheStatistics.entries).toBe(0);
  });
});

interface NativeRow { readonly success: number; readonly time: number; readonly reach: number }
interface NativeCache { readonly allocations: number; readonly frees: number; readonly goals: readonly number[] }
const nativeOracle = process.env["Q3_ROUTING_TIME_ORACLE"];
function nativeRun(graph: Graph, commands: string): { readonly rows: readonly NativeRow[]; readonly caches: readonly NativeCache[] } {
  if (nativeOracle === undefined) throw new Error("No external routing-time oracle configured");
  const bytes = fixture(graph), text = new TextEncoder().encode(commands);
  const input = new Uint8Array(4 + bytes.length + text.length);
  new DataView(input.buffer).setUint32(0, bytes.length, true); input.set(bytes, 4); input.set(text, 4 + bytes.length);
  const child = Bun.spawnSync([nativeOracle], { stdin: input, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  if (child.exitCode !== 0) throw new Error(`Native routing-time oracle failed: ${new TextDecoder().decode(child.stderr)}`);
  const rows: NativeRow[] = [], caches: NativeCache[] = [];
  for (const line of new TextDecoder().decode(child.stdout).trim().split("\n")) {
    const [kind, ...tokens] = line.split(" "), values = tokens.map(Number);
    if (!values.every(Number.isSafeInteger)) throw new Error(`Invalid native numbers: ${line}`);
    switch (kind) {
      case "ROUTE": {
        const [success, time, reach] = values;
        if (values.length !== 3 || success === undefined || time === undefined || reach === undefined) throw new Error(`Malformed native route: ${line}`);
        rows.push({ success, time, reach }); break;
      }
      case "CACHE": {
        const [allocations, frees, count, ...goals] = values;
        if (allocations === undefined || frees === undefined || count !== goals.length) throw new Error(`Malformed native cache: ${line}`);
        caches.push({ allocations, frees, goals }); break;
      }
      case "ENABLE": if (values.length !== 1) throw new Error(`Malformed native enable: ${line}`); break;
      default: throw new Error(`Unknown native output: ${line}`);
    }
  }
  return { rows, caches };
}
function nativeCommand(area: number, goal: number, seed = 0, origin: Vec3 | null = null): string {
  const point = origin === null ? ZERO : origin;
  return `0 ${area} ${goal} ${TravelFlags.DEFAULT} ${seed} ${origin === null ? 0 : 1} ${point.x} ${point.y} ${point.z}\n`;
}

describe.skipIf(nativeOracle === undefined)("unchanged external C lower-level reference", () => {
  test("defined null branches and explicitly normalized success match exact native times", () => {
    const cases: readonly { readonly graph: Graph; readonly area: number; readonly goal: number }[] = [
      ...[1, 2, 3, 5, 6].map(goal => ({ graph: chain(), area: 1, goal })),
      { graph: chain(), area: 2, goal: 5 }, { graph: chain(), area: 2, goal: 6 },
      { graph: chain(10, { x: 300, y: 0, z: 0 }), area: 1, goal: 3 },
      { graph: alternatives(), area: 1, goal: 4 }, { graph: alternatives(10, 3), area: 1, goal: 4 },
      { graph: alternatives(65522, 10), area: 1, goal: 4 }, { graph: chain(65522), area: 1, goal: 3 },
      { graph: clusterDetour(), area: 1, goal: 5 },
    ];
    for (const item of cases) {
      const router = readyRouting(parseAas(fixture(item.graph)));
      const { rows } = nativeRun(item.graph, nativeCommand(item.area, item.goal) + nativeCommand(item.area, item.goal, 0, ZERO));
      const omitted = rows[0], supplied = rows[1];
      if (rows.length !== 2 || omitted === undefined || supplied === undefined) throw new Error("Missing native query rows");
      expect(router.areaTravelTimeToGoal(query(item.area, item.goal))).toBe(omitted.success ? omitted.time : 0);
      const route = fullRoute(router, item.area, item.goal);
      expect(route).toEqual(supplied.success ? { kind: "found", travelTime: supplied.time, nextReachability: supplied.reach } : { kind: "unreachable" });
      expect(router.areaTravelTimeToGoal(query(item.area, item.goal, ZERO))).toBe(supplied.success ? supplied.time : 0);
    }
  });

  test("negative output proves repaired success is not merely a discarded native field", () => {
    const { rows } = nativeRun(chain(), nativeCommand(1, 3, -1) + nativeCommand(1, 3, 0) + nativeCommand(1, 3, 2147483647));
    expect(rows).toEqual([{ success: 0, time: 305419896, reach: -1 }, { success: 1, time: 24, reach: 0 },
      { success: 1, time: 24, reach: 2147483647 }]);
    const router = readyRouting(parseAas(fixture(chain())));
    expect(router.areaTravelTimeToGoal(query(1, 3))).toBe(24);
  });

  test("disabled and re-enabled routing areas preserve the normalized time", () => {
    const { rows } = nativeRun(chain(), nativeCommand(1, 5) + "1 2 0\n" + nativeCommand(1, 5) + "1 2 1\n" + nativeCommand(1, 5));
    expect(rows.map(row => row.success ? row.time : 0)).toEqual([47, 0, 47]);
    const router = readyRouting(parseAas(fixture(chain())));
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(47); router.setAreaEnabled(2, false);
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(0); router.setAreaEnabled(2, true);
    expect(router.areaTravelTimeToGoal(query(1, 5))).toBe(47);
  });

  test("null queries retain source cache touch order before controlled memory-pressure eviction", () => {
    const graph: Graph = { areas: Array.from({ length: 4 }, () => ({ cluster: 1 })),
      links: [{ from: 1, to: 2, time: 10 }, { from: 1, to: 3, time: 10 }, { from: 1, to: 4, time: 10 }], portals: [] };
    const { caches } = nativeRun(graph, nativeCommand(1, 2) + "3\n" + nativeCommand(1, 3) + "3\n"
      + nativeCommand(1, 2) + "3\n2 1\n" + nativeCommand(1, 4) + "3\n");
    expect(caches.map(cache => cache.goals)).toEqual([[2], [2, 3], [3, 2], [2, 4]]);
    expect(caches.map(cache => cache.frees)).toEqual([0, 0, 0, 1]);
    const first = caches[0]; if (first === undefined) throw new Error("Missing native cache observation");
    expect(caches.map(cache => cache.allocations - first.allocations)).toEqual([0, 1, 1, 2]);
    const router = readyRouting(parseAas(fixture(graph)), 2 * (64 + 3 * 4));
    for (const goal of [2, 3, 2, 4]) expect(router.areaTravelTimeToGoal(query(1, goal))).toBe(11);
    const warmed = router.cacheStatistics;
    expect(fullRoute(router, 1, 2).kind).toBe("found");
    expect(router.cacheStatistics).toEqual(warmed);
    expect(fullRoute(router, 1, 3).kind).toBe("found");
    expect(router.cacheStatistics.areaUpdates).toBe(warmed.areaUpdates + 1);
  });
});
