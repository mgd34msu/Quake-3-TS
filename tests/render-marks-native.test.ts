import { HunkArena } from "../src/core/hunk.ts";
import { expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { add3, cross3, normalize3, perpendicularVector, scale3, vec3, type Vec3 } from "../src/core/math.ts";
import { BspMarkProjector, type MarkGeometry, type MarkProjection } from "../src/render/marks.ts";
import { RendererResources } from "../src/render/world.ts";
import { faceMarkSurface, markGeometry, markSquare } from "./marks-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";

// External executable includes the pinned, unchanged tr_marks.c. Its only math
// adapter gives Q_rsqrt the source's intended 32-bit alias on this LP64 host.
const oracle = process.env["Q3_MARKS_ORACLE"], dataPath = process.env["Q3_DATA"];
function vector(point: Vec3): number[] { return [point.x, point.y, point.z]; }
function input(geometry: MarkGeometry, queries: readonly MarkProjection[]): string {
  const map = geometry.map, values = [map.planes.length, map.nodes.length, map.leaves.length, geometry.surfaces.length];
  for (const plane of map.planes) values.push(...vector(plane.normal), plane.distance);
  for (const node of map.nodes) values.push(node.plane, ...node.children);
  for (const leaf of map.leaves) values.push(leaf.surfaceCount, ...map.leafSurfaces.slice(leaf.firstSurface, leaf.firstSurface + leaf.surfaceCount));
  for (const surface of geometry.surfaces) {
    if (surface.kind === "skip") { values.push(0); continue; }
    values.push(surface.kind === "face" ? 1 : 2, surface.surfaceFlags, surface.contentFlags);
    if (surface.kind === "face") {
      values.push(...vector(surface.plane.normal), surface.plane.distance, surface.vertices.length, surface.indices.length);
      for (const vertex of surface.vertices) values.push(...vector(vertex.position));
      values.push(...surface.indices);
    } else {
      values.push(surface.mesh.width, surface.mesh.height);
      for (const vertex of surface.mesh.vertices) values.push(...vector(vertex.position), ...vector(vertex.normal));
    }
  }
  values.push(queries.length);
  for (const query of queries) {
    values.push(query.points.length, query.maxPoints, query.maxFragments, ...vector(query.projection));
    for (const point of query.points) values.push(...vector(point));
  }
  return values.map(value => Object.is(value, -0) ? "-0" : String(value)).join(" ");
}
function bits(value: number): number { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); }
async function compare(geometry: MarkGeometry, queries: readonly MarkProjection[]): Promise<void> {
  if (oracle === undefined) throw new Error("Q3_MARKS_ORACLE required");
  const child = Bun.spawn([oracle], { stdin: new Blob([input(geometry, queries)]), stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const lines = output.trim().split("\n"); expect(lines).toHaveLength(queries.length);
  const projector = new BspMarkProjector(geometry);
  for (const [index, query] of queries.entries()) {
    const result = projector.markFragments(query);
    const expected = [result.fragments.length, ...result.fragments.flatMap(fragment => [fragment.firstPoint, fragment.pointCount]), ...result.points.flatMap(point => vector(point).map(bits))];
    expect(lines[index]?.split(" ").map(Number), `query ${index}`).toEqual(expected);
  }
}

test.skipIf(oracle === undefined)("native tr_marks clipping order, budgets and epsilon fixtures", async () => {
  const geometry = markGeometry([faceMarkSurface(-0), faceMarkSurface(-15), faceMarkSurface(-31), faceMarkSurface(19)]);
  const queries: MarkProjection[] = [];
  for (const z of [0, 0.49, 0.5, 0.51, 1, 10, 20, 32]) for (const budget of [3, 5, 12, 384]) for (const count of [1, 2, 128]) {
    queries.push({ points: markSquare(z), projection: vec3(0, 0, -20), maxPoints: budget, maxFragments: count });
  }
  for (const count of [1, 2, 3, 61, 62, 63, 64, 65]) queries.push({
    points: Array.from({ length: count }, (_, index) => vec3(8 * Math.cos(-index * 2 * Math.PI / count), 8 * Math.sin(-index * 2 * Math.PI / count), 1)),
    projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128,
  });
  queries.push({ points: markSquare().map(point => vec3(point.x * 10, point.y * 10, point.z)), projection: vec3(0, 0, -20), maxPoints: 384, maxFragments: 128 });
  await compare(geometry, queries);
});

test.skipIf(oracle === undefined || dataPath === undefined)("native tr_marks seeded retail face and prepared patch projections in both products", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const cases: readonly { product: "baseq3" | "missionpack"; map: string }[] = [{ product: "baseq3", map: "q3dm1" }, { product: "missionpack", map: "mpteam1" }];
  for (const entry of cases) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: entry.product });
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 32, images);
    const target = new RenderTarget(images, [cpu]), builtins = new BuiltinImages(images, identityImageUploadProfile);
    const cinematicMixer = new AudioMixer(44100, () => 0);
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 },
      scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    try {
    const scene = await (await RendererResources.create(vfs, { kind: "unaccounted" }, createRendererSettings(),
      { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics })).loadWorld(entry.map), queries: MarkProjection[] = [];
    let faces = 0, grids = 0, faceHits = 0, gridHits = 0, state = 0x12345678;
    const projector = new BspMarkProjector(scene.markGeometry);
    const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
    for (const surface of scene.markGeometry.surfaces) {
      if (surface.kind === "skip") continue;
      if (surface.kind === "face" ? faces >= 128 : grids >= 128) continue;
      const vertices = surface.kind === "face" ? surface.vertices : surface.mesh.vertices;
      const vertex = vertices[Math.floor(random() * vertices.length)];
      if (vertex === undefined) throw new Error("retail surface lacks vertices");
      const normal = surface.kind === "face" ? surface.plane.normal : normalize3(vertex.normal);
      const axis = perpendicularVector(normal), other = cross3(normal, axis), radius = 4 + random() * 40;
      const origin = add3(vertex.position, scale3(normal, 0.75));
      const point = (x: number, y: number): Vec3 => add3(add3(origin, scale3(axis, x * radius)), scale3(other, y * radius));
      // Clockwise winding viewed from the outward normal.
      const query: MarkProjection = { points: [point(-1, -1), point(-1, 1), point(1, 1), point(1, -1)], projection: scale3(normal, -20), maxPoints: 384, maxFragments: 128 };
      queries.push(query);
      if (projector.markFragments(query).fragments.length > 0) { if (surface.kind === "face") faceHits++; else gridHits++; }
      if (surface.kind === "face") faces++; else grids++;
    }
    expect(faces).toBeGreaterThan(0); expect(grids).toBeGreaterThan(0);
    expect(faceHits).toBeGreaterThan(0); expect(gridHits).toBeGreaterThan(0);
    await compare(scene.markGeometry, queries);
    } finally { target.close(); cinematics.dispose(); }
  }
}, 120000);
