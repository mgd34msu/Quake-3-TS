import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import { aasOptimize } from "../src/botlib/aas-optimize.ts";
import { writeAasFile } from "../src/botlib/aas-file.ts";
import { AasWorldState } from "../src/botlib/aas-world.ts";
import { parseAas } from "../src/botlib/aas.ts";
import type { AasReachability, AasWorld } from "../src/botlib/aas.ts";
import { vec3 } from "../src/core/math.ts";

function fixture(): AasWorldState {
  const bounds = { min: vec3(-10, -20, -30), max: vec3(10, 20, 30) };
  const reachability: AasReachability[] = [
    { area: 0, face: 0, edge: 0, start: vec3(0, 0, 0), end: vec3(0, 0, 0), travelType: 0, travelTime: 0, padding: 0xabcd },
    { area: 2, face: -2, edge: -3, start: vec3(1, 2, 3), end: vec3(4, 5, 6), travelType: 0x1000006, travelTime: 99, padding: 0x1234 },
    { area: 1, face: -1, edge: -1, start: vec3(1, 2, 3), end: vec3(4, 5, 6), travelType: 2, travelTime: 20, padding: 2 },
    ...[0x100000b, 18, 0x2000013].map(travelType => ({
      area: 2, face: -1000, edge: 0x12345678, start: vec3(7, 8, 9), end: vec3(-1, -2, -3),
      travelType, travelTime: 65535, padding: 0xffff,
    })),
  ];
  return new AasWorldState({
    source: "optimizer-fixture", version: 5, bspChecksum: 12345,
    vertices: [vec3(90, 91, 92), vec3(1.25, -0, 3), vec3(4, 5, 6), vec3(7, 8, 9), vec3(10, 11, 12)],
    planes: [{ normal: vec3(1, 0, 0), distance: 0, type: 0 }],
    edges: [{ vertices: [0, 0] }, { vertices: [0, 4] }, { vertices: [1, 2] }, { vertices: [1, 3] }],
    edgeIndexes: [1, -2, 3, 2],
    faces: [
      { plane: 0, flags: 0, edgeCount: 0, firstEdge: 0, frontArea: 0, backArea: 0 },
      { plane: 0, flags: 1, edgeCount: 1, firstEdge: 0, frontArea: 1, backArea: 0 },
      { plane: 0, flags: 6, edgeCount: 2, firstEdge: 1, frontArea: 2, backArea: 1 },
      { plane: 0, flags: 2, edgeCount: 1, firstEdge: 3, frontArea: 1, backArea: 2 },
    ],
    faceIndexes: [1, -2, 3, 2, -3],
    areas: [
      { areaNumber: 0, faceCount: 0, firstFace: 0, bounds, center: vec3(99, 98, 97) },
      { areaNumber: 1, faceCount: 3, firstFace: 0, bounds, center: vec3(1, 0, 0) },
      { areaNumber: 2, faceCount: 2, firstFace: 3, bounds, center: vec3(-1, 0, 0) },
    ],
    areaSettings: [0, 1, 2].map(index => ({ contents: 0, flags: 1, presenceType: 2, cluster: 0,
      clusterAreaNumber: index, reachableAreaCount: index === 1 ? 5 : 0, firstReachableArea: 1 })),
    reachability,
    nodes: [{ plane: 0, children: [0, 0] }, { plane: 0, children: [-1, -2] }],
    portals: [], portalIndex: [], clusters: [], bboxes: [],
    pointArea: point => point.x > 0 ? 1 : 2,
    areaBounds: () => bounds,
    areaReachabilities: area => area === 1 ? reachability.slice(1) : [],
  });
}

test("source ladder pruning preserves signed remaps, vertex zero duplication, payloads and canonical reachability cells", () => {
  const world = fixture();
  const originalVertices = world.vertices;
  const originalAreas = world.areas;
  const bounds = world.areaBounds(1);
  const settings = world.areaSettings;
  const retained = world.areaReachabilities(1);
  const messages: string[] = [];
  aasOptimize(world, message => { messages.push(message); expect(world.faces).toHaveLength(3); });
  expect(messages).toEqual(["AAS data optimized.\n"]);
  expect(world.vertices).toEqual([vec3(1.25, -0, 3), vec3(4, 5, 6), vec3(1.25, -0, 3), vec3(7, 8, 9)]);
  expect(world.edges.map(edge => [...edge.vertices])).toEqual([[0, 0], [0, 1], [2, 3]]);
  expect([...world.edgeIndexes]).toEqual([-1, 2, 1]);
  expect([...world.faceIndexes]).toEqual([-1, 2, 1, -2]);
  expect(world.faces).toEqual([
    { plane: 0, flags: 0, edgeCount: 0, firstEdge: 0, frontArea: 0, backArea: 0 },
    { plane: 0, flags: 6, edgeCount: 2, firstEdge: 0, frontArea: 2, backArea: 1 },
    { plane: 0, flags: 2, edgeCount: 1, firstEdge: 2, frontArea: 1, backArea: 2 },
  ]);
  expect(world.areas[0]).toEqual({ areaNumber: 0, faceCount: 0, firstFace: 0,
    bounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) }, center: vec3(0, 0, 0) });
  expect(world.areas.slice(1).map(area => [area.firstFace, area.faceCount])).toEqual([[0, 2], [2, 2]]);
  expect(world.areaBounds(1)).toEqual(bounds);
  expect(world.areaSettings).toBe(settings);
  expect(world.areaReachabilities(1)[0]).toBe(retained[0]);
  expect(world.reachability.map(reach => [reach.face, reach.edge, reach.padding])).toEqual([
    [0, 0, 0xabcd], [-1, -2, 0x1234], [0, 0, 2],
    [-1000, 0x12345678, 0xffff], [-1000, 0x12345678, 0xffff], [-1000, 0x12345678, 0xffff],
  ]);
  expect(originalVertices).toHaveLength(5);
  expect(originalAreas[1]?.faceCount).toBe(3);
});

test("zero signed indexes follow the source negative branch when dummy geometry is explicitly referenced", () => {
  const world = fixture();
  world.replaceEdges([{ vertices: [1, 2] }, ...world.edges.slice(1)]);
  world.replaceFaces([{ plane: 0, flags: 2, firstEdge: 0, edgeCount: 1, frontArea: 1, backArea: 2 }, ...world.faces.slice(1)]);
  world.replaceFaceIndexes([0, 0, 0, 0, 0]);
  world.replaceEdgeIndexes([0, 0, 0, 0]);
  aasOptimize(world, () => undefined);
  expect([...world.faceIndexes]).toEqual([-1, -1, -1, -1, -1]);
  expect([...world.edgeIndexes]).toEqual([-1]);
  expect(world.reachabilityRecord(0).face).toBe(1);
  expect(world.reachabilityRecord(0).edge).toBe(1);
});

test("source vertex allocation overflow is explicit and does not publish unfinished geometry", () => {
  const world = fixture();
  world.replaceVertices(world.vertices.slice(0, 3));
  world.replaceEdges([{ vertices: [0, 0] }, { vertices: [0, 2] }, { vertices: [1, 2] }, { vertices: [1, 0] }]);
  const vertices = world.vertices;
  const reachability = world.reachabilityRecord(1);
  expect(() => aasOptimize(world, () => undefined)).toThrow("index 3 outside source allocation 3");
  expect(world.vertices).toBe(vertices);
  expect(reachability.face).toBe(-2);
});

test("an absent source dummy allocation cannot silently shorten the published sentinel count", () => {
  const world = fixture();
  world.replaceAreas([]);
  world.replaceEdges([]);
  world.reachabilitySize = 0;
  expect(() => aasOptimize(world, () => undefined)).toThrow("index 0 outside source allocation 0");
});

function expectWorldData(actual: AasWorld, expected: AasWorld): void {
  for (const key of ["bspChecksum", "vertices", "planes", "faces", "areas",
    "areaSettings", "reachability", "clusters", "bboxes"] satisfies readonly (keyof AasWorld)[]) {
    expect(actual[key]).toEqual(expected[key]);
  }
  for (const key of ["edgeIndexes", "faceIndexes", "portalIndex"] satisfies readonly (keyof AasWorld)[]) {
    expect(Array.from(actual[key])).toEqual(Array.from(expected[key]));
  }
  expect(actual.edges.map(edge => Array.from(edge.vertices)))
    .toEqual(expected.edges.map(edge => Array.from(edge.vertices)));
  expect(actual.nodes.map(node => [node.plane, ...node.children]))
    .toEqual(expected.nodes.map(node => [node.plane, ...node.children]));
  expect(actual.portals.map(portal => [portal.area, portal.frontCluster, portal.backCluster, ...portal.clusterAreaNumbers]))
    .toEqual(expected.portals.map(portal => [portal.area, portal.frontCluster, portal.backCluster, ...portal.clusterAreaNumbers]));
}

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retailAvailable = existsSync(join(dataPath, "baseq3", "pak0.pk3"))
  && existsSync(join(dataPath, "missionpack", "pak0.pk3"));

test.skipIf(!retailAvailable)("both-product retail optimizer writes and reparses the actual canonical world", async () => {
  const root = await mkdtemp(join(tmpdir(), "quake3-aas-optimize-"));
  try {
    for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
      const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
      const files = new WritableFileSystem({ homePath: root, product, print: () => undefined });
      try {
        const filename = product === "baseq3" ? "maps/q3dm7.aas" : "maps/mpteam1.aas";
        const original = parseAas(await vfs.read(filename), filename);
        const world = new AasWorldState(original);
        const settings = world.areaSettings;
        const reaches = world.reachability;
        aasOptimize(world, () => undefined);
        expect(world.faces.slice(1).every(face => (face.flags & 2) !== 0)).toBe(true);
        expect(world.areas).toHaveLength(original.areas.length);
        expect(world.areaSettings).toBe(settings);
        expect(world.reachability).toBe(reaches);
        expect(writeAasFile(world, filename, { openWrite: path => files.openBinaryWrite(path), print: () => undefined })).toBe(true);
        const reparsed = parseAas(new Uint8Array(await readFile(join(root, product, filename))), "optimized.aas");
        expectWorldData(reparsed, world);
        expect(world.pointArea(vec3(0, 0, 0))).toBe(original.pointArea(vec3(0, 0, 0)));
        for (let area = 1; area < original.areas.length; area++) {
          const before = original.areaReachabilities(area);
          const after = reparsed.areaReachabilities(area);
          expect(after.map(reach => [reach.area, reach.travelType, reach.travelTime, reach.start, reach.end, reach.padding]))
            .toEqual(before.map(reach => [reach.area, reach.travelType, reach.travelTime, reach.start, reach.end, reach.padding]));
        }
      } finally { vfs.close(); files.closeAll(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
