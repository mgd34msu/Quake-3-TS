import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AasClustering } from "../src/botlib/aas-cluster.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasArea, AasAreaSettings, AasFace, AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { BotLibVars } from "../src/botlib/libvars.ts";

interface FixtureFace {
  readonly front: number;
  readonly back: number;
  readonly plane: number;
  readonly edges: readonly number[];
  readonly flags: number;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`missing fixture entry ${index}`);
  return value;
}

function fixture(links: readonly (readonly number[])[], boundaries: readonly FixtureFace[] = []): AasWorldState {
  const zero = { x: 0, y: 0, z: 0 };
  const bounds = { min: zero, max: zero };
  const reach = (area: number): AasReachability => ({ area, face: 0, edge: 0, start: zero, end: zero, travelType: 2, travelTime: 1, padding: 0 });
  const reachability: AasReachability[] = [reach(0)];
  const faces: AasFace[] = [{ plane: 0, flags: 1, edgeCount: 0, firstEdge: 0, frontArea: 0, backArea: 0 }];
  const edgeIndexes: number[] = [], faceIndexes: number[] = [];
  for (const face of boundaries) {
    faces.push({ plane: face.plane, flags: face.flags, edgeCount: face.edges.length, firstEdge: edgeIndexes.length, frontArea: face.front, backArea: face.back });
    edgeIndexes.push(...face.edges);
  }
  const areas: AasArea[] = [], areaSettings: AasAreaSettings[] = [];
  for (const [area, destinations] of links.entries()) {
    const firstFace = faceIndexes.length;
    if (area !== 0) {
      for (const [number, face] of faces.entries()) {
        if (face.frontArea === area) faceIndexes.push(number);
        else if (face.backArea === area) faceIndexes.push(-number);
      }
    }
    areas.push({ areaNumber: area, faceCount: faceIndexes.length - firstFace, firstFace, bounds, center: zero });
    areaSettings.push({ contents: 0, flags: 0, presenceType: 6, cluster: 0, clusterAreaNumber: 77, reachableAreaCount: destinations.length, firstReachableArea: reachability.length });
    reachability.push(...destinations.map(reach));
  }
  const parsed: AasWorld = {
    source: "clustering geometry", version: 5, bspChecksum: 0, vertices: [], planes: [], edges: [], edgeIndexes,
    faces, faceIndexes, areas, areaSettings, reachability, nodes: [], portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea: () => 0,
    areaBounds: area => at(areas, area).bounds,
    areaReachabilities: area => {
      const settings = at(areaSettings, area);
      return reachability.slice(settings.firstReachableArea, settings.firstReachableArea + settings.reachableAreaCount);
    },
  };
  return new AasWorldState(parsed);
}

function clustering(world: AasWorldState) {
  const variables = new BotLibVars();
  const messages: string[] = [], logs: string[] = [], errors: string[] = [];
  const algorithm = new AasClustering(world, {
    variables,
    print: (severity, text) => { (severity === 4 ? errors : messages).push(text); },
    log: { write: text => { logs.push(text); } },
  });
  return { algorithm, variables, messages, logs, errors };
}

function portalFixture(): AasWorldState {
  const world = fixture([[], [2], [1, 3], [2]], [
    { front: 1, back: 2, plane: 0, edges: [1], flags: 0 },
    { front: 2, back: 3, plane: 2, edges: [-2], flags: 0 },
  ]);
  world.areaSettingsRecord(2).flags = 1;
  return world;
}

describe("source AAS clustering", () => {
  test("absorbs incoming-only chains and numbers reachable areas before dead ends", () => {
    const world = fixture([[], [2], [], [1], [3], []]);
    const run = clustering(world);
    run.algorithm.initialize();
    expect(world.areaSettings.map(area => [area.cluster, area.clusterAreaNumber])).toEqual([
      [0, 77], [1, 0], [1, 3], [1, 1], [1, 2], [0, 77],
    ]);
    expect(world.clusters).toEqual([
      { areaCount: 0, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 },
      { areaCount: 4, reachabilityAreaCount: 3, portalCount: 0, firstPortal: 0 },
    ]);
    expect(world.saveFile).toBe(true);
    expect(run.errors).toEqual([]);
    expect(run.messages.at(-1)).toBe("    36 AAS memory/CPU usage (the lower the better)\n");
  });

  test("detects two-plane portals and preserves the four numbering passes", () => {
    const world = portalFixture(), run = clustering(world);
    run.algorithm.initialize();
    expect(world.areaSettingsRecord(2).contents).toBe(8 | 32 | 512);
    expect(world.areaSettingsRecord(2).cluster).toBe(-1);
    const portal = world.portalRecord(1);
    expect({ ...portal, clusterAreaNumbers: Array.from(portal.clusterAreaNumbers) })
      .toEqual({ area: 2, frontCluster: 1, backCluster: 2, clusterAreaNumbers: [1, 1] });
    expect(Array.from(world.portalIndex)).toEqual([1, 1]);
    expect(world.clusters.slice(1)).toEqual([
      { areaCount: 2, reachabilityAreaCount: 2, portalCount: 1, firstPortal: 0 },
      { areaCount: 2, reachabilityAreaCount: 2, portalCount: 1, firstPortal: 1 },
    ]);
    world.areaSettingsRecord(2).reachableAreaCount = 0;
    run.algorithm.numberClusterAreas(1);
    expect(world.clusterRecord(1).reachabilityAreaCount).toBe(1);
    expect(world.portalRecord(1).clusterAreaNumbers[0]).toBe(1);
  });

  test("rejects shared front/back edges and groups lower-presence portal areas", () => {
    const rejected = fixture([[], [], [], []], [
      { front: 1, back: 2, plane: 0, edges: [4], flags: 0 },
      { front: 2, back: 3, plane: 2, edges: [-4], flags: 0 },
    ]);
    rejected.areaSettingsRecord(2).flags = 1;
    expect(clustering(rejected).algorithm.checkAreaForPossiblePortals(2)).toBe(0);
    const grouped = fixture([[], [], [], [], []], [
      { front: 1, back: 2, plane: 0, edges: [1], flags: 0 },
      { front: 2, back: 3, plane: 2, edges: [2], flags: 0 },
      { front: 1, back: 4, plane: 0, edges: [3], flags: 0 },
      { front: 4, back: 3, plane: 2, edges: [4], flags: 0 },
      { front: 2, back: 4, plane: 4, edges: [5], flags: 0 },
    ]);
    grouped.areaSettingsRecord(2).flags = 1;
    grouped.areaSettingsRecord(4).presenceType = 4;
    const run = clustering(grouped);
    expect(run.algorithm.checkAreaForPossiblePortals(2)).toBe(2);
    expect(run.logs).toEqual(["possible portal: 2\r\n", "possible portal: 4\r\n"]);
    expect(grouped.areaSettingsRecord(4).contents).toBe(8 | 32);
  });

  test("requires connected exterior areas and excludes solid faces from that connection", () => {
    const boundaries: FixtureFace[] = [
      { front: 1, back: 2, plane: 0, edges: [1], flags: 0 },
      { front: 4, back: 2, plane: 0, edges: [2], flags: 0 },
      { front: 2, back: 3, plane: 2, edges: [3], flags: 0 },
    ];
    for (const connecting of [null, 1, 0]) {
      const faces = connecting === null ? boundaries : [...boundaries, { front: 1, back: 4, plane: 4, edges: [4], flags: connecting }];
      const world = fixture([[], [], [], [], []], faces);
      world.areaSettingsRecord(2).flags = 1;
      expect(clustering(world).algorithm.checkAreaForPossiblePortals(2)).toBe(connecting === 0 ? 1 : 0);
    }
  });

  test("removes a portal touching three clusters and retains its view flag through retry", () => {
    const world = fixture([[], [4], [4], [4], []]);
    world.areaSettingsRecord(4).contents = 512;
    const run = clustering(world);
    run.algorithm.initialize();
    expect(run.logs).toContain("portal area 4 is seperating more than two clusters\r\n");
    expect(run.messages).toContain("\r     1");
    expect(world.numPortals).toBe(1);
    expect(world.numClusters).toBe(2);
    expect(world.areaSettingsRecord(4).contents).toBe(512);
    expect(world.areaSettings.slice(1).map(area => area.cluster)).toEqual([1, 1, 1, 1]);
    expect(world.portalRecord(1).area).toBe(4);
    expect(Array.from(world.portalRecord(1).clusterAreaNumbers)).toEqual([1, 1]);
  });

  test("removes one-sided portals one per test pass while preserving route and view flags", () => {
    const world = fixture([[], [2], [], []]);
    world.areaSettingsRecord(2).contents = 8 | 32;
    world.areaSettingsRecord(3).contents = 8;
    const run = clustering(world);
    run.algorithm.initialize();
    expect(run.logs).toContain("portal area 2 has no back cluster\r\n");
    expect(run.logs).toContain("portal area 3 has no front cluster\r\n");
    expect(run.messages.filter(message => /^\r +[0-9]+$/.test(message))).toEqual(["\r     0", "\r     1", "\r     2"]);
    expect(world.areaSettingsRecord(2).contents).toBe(32 | 512);
    expect(world.areaSettingsRecord(3).contents).toBe(512);
  });

  test("face flood includes zero-reachability areas and does not add a solid-face filter", () => {
    const world = fixture([[], [], []], [{ front: 1, back: 2, plane: 0, edges: [], flags: 1 }]);
    const run = clustering(world);
    run.algorithm.noFaceFlood = false;
    run.algorithm.initialize();
    expect(world.clusterRecord(1)).toEqual({ areaCount: 2, reachabilityAreaCount: 0, portalCount: 0, firstPortal: 0 });
    expect(world.areaSettings.slice(1).map(area => area.cluster)).toEqual([1, 1]);
  });

  test("preserves early force-variable reads and partial state at source diagnostics", () => {
    const world = portalFixture(), run = clustering(world);
    run.algorithm.initialize();
    const calls: string[] = [];
    new AasClustering(world, {
      variables: { getValue: name => { calls.push(name); return name === "forceclustering" ? 0.9 : 0; } },
      print: () => { throw new Error("unchanged stored clusters must return before printing"); },
      log: { write: () => undefined },
    }).initialize();
    expect(calls).toEqual(["forceclustering", "forcereachability"]);
    run.variables.set("forceclustering", "1");
    world.saveFile = false;
    const interrupted = new AasClustering(world, {
      variables: run.variables,
      print: (_severity, text) => { if (text === "\n") throw new Error("stop at source newline"); },
      log: { write: () => undefined },
    });
    expect(() => interrupted.initialize()).toThrow("stop at source newline");
    expect(world.numPortals).toBe(2);
    expect(world.numClusters).toBe(3);
    expect(world.areaSettingsRecord(2).cluster).toBe(-1);
    expect(world.saveFile).toBe(false);
  });

  test("preserves source fatal returns and writes before the portal-index limit", () => {
    const world = fixture([[], [0], []]), run = clustering(world);
    world.allocateClusters(65536);
    world.numClusters = 65536;
    expect(run.algorithm.findClusters()).toBe(false);
    expect(run.errors.pop()).toBe("AAS_MAX_CLUSTERS");
    world.numClusters = 2;
    world.allocatePortals(65536);
    world.numPortals = 65536;
    world.areaSettingsRecord(1).contents = 8;
    run.algorithm.createPortals();
    expect(run.errors.pop()).toBe("AAS_MAX_PORTALS");
    world.numPortals = 2;
    world.portalRecord(1).area = 1;
    world.allocatePortalIndexes(65536);
    world.portalIndexSize = 65536;
    expect(run.algorithm.updatePortal(1, 1)).toBe(true);
    expect(run.errors.pop()).toBe("AAS_MAX_PORTALINDEXSIZE");
    expect(world.portalRecord(1).frontCluster).toBe(1);
    expect(world.areaSettingsRecord(1).cluster).toBe(0);
    expect(world.clusterRecord(1).portalCount).toBe(0);
    expect(run.algorithm.updatePortal(2, 1)).toBe(true);
    expect(run.errors.pop()).toBe("no portal of area 2");
    expect(run.algorithm.floodClusterAreas(0, 1)).toBe(false);
    expect(run.errors.pop()).toBe("AAS_FloodClusterAreas_r: areanum out of range");
    world.areaSettingsRecord(2).cluster = 2;
    expect(run.algorithm.floodClusterAreas(2, 1)).toBe(false);
    expect(run.errors.pop()).toBe("cluster 1 touched cluster 2 at area 2\r\n");
  });

  test("rejects the source's unguarded portal-face scratch overflow", () => {
    const faces = Array.from({ length: 1025 }, (): FixtureFace => ({ front: 1, back: 2, plane: 0, edges: [], flags: 0 }));
    const world = fixture([[], [], []], faces);
    world.areaSettingsRecord(1).flags = 1;
    expect(() => clustering(world).algorithm.checkAreaForPossiblePortals(1)).toThrow("source frontfacenums[1024] write exceeds allocation");
    expect(world.areaSettingsRecord(1).contents).toBe(0);
  });
});

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
test.skipIf(!existsSync(join(dataPath, "baseq3/pak0.pk3")) || !existsSync(join(dataPath, "missionpack/pak0.pk3")))(
  "forces clustering on installed baseq3 and Team Arena AAS through the mutable world owner", async () => {
    for (const [product, name] of [["baseq3", "q3dm1"], ["missionpack", "mpteam1"]] satisfies readonly (readonly ["baseq3" | "missionpack", string])[]) {
      const files = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
      const parsed = parseAas(await files.read(`maps/${name}.aas`));
      const world = new AasWorldState(parsed), run = clustering(world);
      run.variables.set("forceclustering", "1");
      run.algorithm.initialize();
      expect(run.errors).toEqual([]);
      expect(world.numClusters).toBeGreaterThan(1);
      expect(world.saveFile).toBe(true);
      for (const [number, settings] of world.areaSettings.entries()) {
        if (settings.cluster === 0) continue;
        if (settings.cluster > 0) expect(settings.clusterAreaNumber).toBeLessThan(world.clusterRecord(settings.cluster).areaCount);
        else expect(world.portalRecord(-settings.cluster).area).toBe(number);
        expect(world.areaReachabilities(number)).toEqual(parsed.areaReachabilities(number));
      }
      for (const portal of world.portals.slice(1)) {
        expect(portal.frontCluster).toBeGreaterThan(0);
        expect(portal.backCluster).toBeGreaterThan(0);
        expect(portal.frontCluster).not.toBe(portal.backCluster);
        expect(portal.clusterAreaNumbers[0]).toBeLessThan(world.clusterRecord(portal.frontCluster).areaCount);
        expect(portal.clusterAreaNumbers[1]).toBeLessThan(world.clusterRecord(portal.backCluster).areaCount);
      }
      const first = JSON.stringify({ settings: world.areaSettings, portals: world.portals, index: world.portalIndex, clusters: world.clusters });
      run.algorithm.initialize();
      expect(JSON.stringify({ settings: world.areaSettings, portals: world.portals, index: world.portalIndex, clusters: world.clusters })).toBe(first);
      files.close();
    }
  }, 30_000,
);
