import { describe, expect, test } from "bun:test";
import { identityMat4, transformVec4, vec3, vec4 } from "../src/core/math.ts";
import type { Vec3, Vec4 } from "../src/core/math.ts";
import { ShadowEdgeState, stencilShadowFinishVertices } from "../src/render/stencil-shadows.ts";
import type { StencilShadowGeometry } from "../src/render/stencil-shadows.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { viewProjection } from "../src/render/view.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { PreparedBackendDraw, RendererBackend } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import type { MaterialRecord } from "../src/render/material-registry.ts";
import { finishFailedShader } from "../src/render/material-finish.ts";
import { evaluateStencilShadowSurface } from "../src/render/picture-material.ts";
import { OPAQUE_STATE, validateRenderView } from "../src/render/types.ts";
import { SourceStateBit } from "../src/render/source-state.ts";
import type { DrawBatch, ImmediateViewOperation, RenderState, ShadowViewOperation, SurfaceViewOperation, ViewOperation } from "../src/render/types.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { loadGl } from "../src/platform/gl.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { RgbaSnapshot } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import type { RenderViewState } from "../src/render/commands.ts";
import { BatchRecordingBackend, executeStaticBatch, publishTexture } from "./render-target-fixture.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const square = [vec3(-1, -1, 1), vec3(1, -1, 1), vec3(1, 1, 1), vec3(-1, 1, 1)];
const squareIndices = [0, 1, 2, 0, 2, 3];

function setShadowTess(tess: SourceTessState, positions: readonly Vec3[], indices: readonly number[], direction: Vec3): void {
  tess.setEntity({ ...tess.context, lighting: { ...tess.context.lighting, lightDir: direction } });
  tess.replaceGeometry({ vertices: positions.map(position => ({ position, normal: vec3(0, 0, 1), texCoord: { x: 0.25, y: 0.5 },
    lightmapCoord: { x: 0.5, y: 0.25 }, color: vec4(255, 128, 64, 32) })), indices });
}

function buildTestShadow(positions: readonly Vec3[], indices: readonly number[], direction: Vec3): StencilShadowGeometry {
  const tess = new SourceTessState();
  setShadowTess(tess, positions, indices, direction);
  return new ShadowEdgeState().build(tess);
}

test("shadow tessellation removes a lit reverse pair and retains the source strip winding", () => {
  const result = buildTestShadow(square, squareIndices, vec3(0, 0, 1));
  expect(result.kind).toBe("volume");
  if (result.kind !== "volume") throw new Error("Expected square silhouette");
  expect(result.positions).toEqual([...square, vec3(-1, -1, -511), vec3(1, -1, -511), vec3(1, 1, -511), vec3(-1, 1, -511)]);
  expect(result.indices).toEqual([0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3, 3, 6, 7, 3, 7, 0, 0, 7, 4]);
  expect(square).toEqual([vec3(-1, -1, 1), vec3(1, -1, 1), vec3(1, 1, 1), vec3(-1, 1, 1)]);
});

test("shadow light direction is copied without normalization and extrusion stores float32", () => {
  const result = buildTestShadow([vec3(1, 2, 3), vec3(2, 2, 3), vec3(1, 3, 3)], [0, 1, 2], vec3(2, -3, 4));
  if (result.kind !== "volume") throw new Error("Expected triangle silhouette");
  expect(result.positions[3]).toEqual(vec3(-1023, 1538, -2045));
  const rounded = buildTestShadow([vec3(0.1, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)], [0, 1, 2], vec3(1 / 3, 0, 1));
  if (rounded.kind !== "volume") throw new Error("Expected rounded triangle silhouette");
  expect(rounded.positions[3]?.x).toBe(-170.56666564941406);
});

test("unlit and degenerate nonempty tessellations still produce the source state-changing volume operation", () => {
  for (const light of [vec3(0, 0, -1), vec3(0, 0, 0), vec3(1, 0, 0)]) {
    const result = buildTestShadow(square, squareIndices, light);
    expect(result.kind).toBe("volume");
    if (result.kind !== "volume") throw new Error("Expected nonempty source tessellation");
    expect(result.indices).toEqual([]);
    expect(result.positions.length).toBe(8);
  }
  expect(buildTestShadow(square, [0, 0, 0], vec3(0, 0, 1))).toEqual({ kind: "volume", positions: [...square,
    vec3(-1, -1, -511), vec3(1, -1, -511), vec3(1, 1, -511), vec3(-1, 1, -511)], indices: [] });
});

test("dangling and overfanned edges follow source reverse-lit membership rather than manifold assumptions", () => {
  const positions = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, -2, 0)];
  const result = buildTestShadow(positions, [0, 1, 2, 1, 0, 3, 1, 0, 4], vec3(0, 0, 1));
  if (result.kind !== "volume") throw new Error("Expected overfanned silhouette");
  expect(result.indices).toEqual([0, 5, 3, 3, 5, 8, 0, 5, 4, 4, 5, 9,
    1, 6, 2, 2, 6, 7, 2, 7, 0, 0, 7, 5, 3, 8, 1, 1, 8, 6, 4, 9, 1, 1, 9, 6]);
});

test("the source retains exactly the first 32 outgoing definitions per vertex", () => {
  const positions: Vec3[] = [vec3(0, 0, 0)], indices: number[] = [];
  for (let triangle = 0; triangle < 33; triangle++) {
    positions.push(vec3(1, 0, 0), vec3(0, 1, 0));
    indices.push(0, triangle * 2 + 1, triangle * 2 + 2);
  }
  const result = buildTestShadow(positions, indices, vec3(0, 0, 1));
  if (result.kind !== "volume") throw new Error("Expected source capped-edge silhouette");
  expect(result.indices.length).toBe((32 + 33 * 2) * 6);
  expect(result.indices.slice(31 * 6, 33 * 6)).toEqual([0, 67, 63, 63, 67, 130, 1, 68, 2, 2, 68, 69]);
  expect(result.indices.slice(-12)).toEqual([65, 132, 66, 66, 132, 133, 66, 133, 0, 0, 133, 67]);
});

test("source empty and 500-vertex branches remain distinct from malformed source tessellations", () => {
  expect(buildTestShadow([], [], vec3(0, 0, 1))).toEqual({ kind: "empty" });
  expect(buildTestShadow(Array.from({ length: 500 }, () => vec3(0, 0, 0)), [0, 1, 2], vec3(0, 0, 1)))
    .toEqual({ kind: "source-vertex-limit" });
  expect(buildTestShadow(Array.from({ length: 499 }, () => vec3(0, 0, 0)), [0, 1, 2], vec3(0, 0, 1)).kind).toBe("volume");
  expect(() => buildTestShadow(square, [0, 1], vec3(0, 0, 1))).toThrow("complete source tessellation");
  expect(buildTestShadow(square, [0, 1, 4], vec3(0, 0, 1)).kind).toBe("volume");
  expect(() => buildTestShadow(square, [0, 1, 1000], vec3(0, 0, 1))).toThrow("outside scratch allocation");
  expect(() => buildTestShadow(square, [0, 1, 1.5], vec3(0, 0, 1))).toThrow("outside scratch allocation");
  expect(() => buildTestShadow(square, squareIndices, vec3(Infinity, 0, 1))).toThrow("finite float32");
});

test("indexed facing reads the committed active extrusion while farther endpoints retain actual XYZ", () => {
  const tess = new SourceTessState(), edges = new ShadowEdgeState(), light = vec3(0, 0, 1);
  const seed = Array.from({ length: 9 }, (_, index) => vec3(index, index, index));
  seed[5] = vec3(0, -1, 0);
  setShadowTess(tess, seed, [], light);
  const tail = tess.allocatedVertex(5), far = tess.allocatedVertex(8);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)], [0, 1, 5], light);
  const result = edges.build(tess);
  if (result.kind !== "volume") throw new Error("Expected indexed shadow volume");
  expect(result.indices).toEqual([0, 3, 1, 1, 3, 4, 1, 4, 5, 5, 4, 6]);
  expect(result.positions).toEqual([vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0),
    vec3(0, 0, -512), vec3(1, 0, -512), vec3(0, 1, -512), far.position]);
  expect(tess.allocatedVertex(5)).toEqual({ ...tail, position: vec3(0, 1, -512) });
  expect(tess.allocatedVertex(8)).toEqual(far);
  expect([tess.numVertexes, tess.numIndexes, tess.snapshotGeometry().vertices.length]).toEqual([3, 3, 3]);
  setShadowTess(tess, square, squareIndices, light);
  edges.build(tess);
  expect(result.positions[6]).toEqual(vec3(8, 8, 8));
  expect(result.indices).toEqual([0, 3, 1, 1, 3, 4, 1, 4, 5, 5, 4, 6]);
});

test("inactive reverse edges survive smaller surfaces and frame transitions but clear when their start becomes active", () => {
  const tess = new SourceTessState(), edges = new ShadowEdgeState(), light = vec3(0, 0, 1);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, -1, 0)], [4, 0, 5], light);
  edges.build(tess);
  const active = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)];
  const retained = [2, 5, 0, 0, 5, 3], fresh = [0, 3, 4, 4, 3, 6, ...retained];
  for (let frame = 0; frame < 3; frame++) {
    tess.endSurface(); tess.resetGeometry(); tess.endFrame();
    setShadowTess(tess, active, [0, 4, 2], light);
    const result = edges.build(tess);
    if (result.kind !== "volume") throw new Error("Expected retained reverse-edge volume");
    expect(result.indices).toEqual(retained);
    const independent = new ShadowEdgeState().build(tess);
    if (independent.kind !== "volume") throw new Error("Expected independent renderer volume");
    expect(independent.indices).toEqual(fresh);
  }
  setShadowTess(tess, [...active, vec3(0, 0, 0), vec3(0, 0, 0)], [0, 0, 0], light);
  edges.build(tess);
  setShadowTess(tess, active, [0, 4, 2], light);
  const cleared = edges.build(tess);
  if (cleared.kind !== "volume") throw new Error("Expected cleared reverse-edge volume");
  expect(cleared.indices).toEqual(fresh);
});

test("zero active vertices can still populate allocated inactive adjacency for a later surface", () => {
  const tess = new SourceTessState(), edges = new ShadowEdgeState(), light = vec3(0, 0, 1);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, -1, 0)], [], light);
  setShadowTess(tess, [], [4, 0, 5], light);
  expect(edges.build(tess)).toEqual({ kind: "volume", positions: [], indices: [] });
  expect([tess.numVertexes, tess.numIndexes]).toEqual([0, 3]);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)], [0, 4, 2], light);
  const result = edges.build(tess);
  if (result.kind !== "volume") throw new Error("Expected inactive adjacency to survive");
  expect(result.indices).toEqual([2, 5, 0, 0, 5, 3]);
});

test("the 32-edge cap includes retained inactive definitions before new reverse edges are appended", () => {
  for (const previousEdges of [30, 31, 32]) {
    const tess = new SourceTessState(), edges = new ShadowEdgeState(), light = vec3(0, 0, 1);
    const seed = Array.from({ length: 13 }, () => vec3(0, 0, 0));
    seed[10] = vec3(1, 0, 0); seed[11] = vec3(0, 1, 0);
    setShadowTess(tess, seed, [], light);
    setShadowTess(tess, [vec3(0, 0, 0)], Array.from({ length: previousEdges }, () => [10, 12, 11]).flat(), light);
    expect(edges.build(tess)).toEqual({ kind: "volume", positions: [vec3(0, 0, 0), vec3(0, 0, -512)], indices: [] });
    setShadowTess(tess, [vec3(0, 0, 0), vec3(0, -1, 0), vec3(0, 1, 0)], [0, 10, 2, 10, 0, 1], light);
    const result = edges.build(tess);
    if (result.kind !== "volume") throw new Error("Expected capped inactive reverse-edge volume");
    const common = [0, 3, 1, 1, 3, 4, 1, 4, 6, 6, 4, 7, 2, 5, 0, 0, 5, 3];
    expect(result.indices).toEqual(previousEdges === 30 ? common : [0, 3, 6, 6, 3, 7, ...common]);
  }
});

test("only emitted endpoint offsets require an allocated XYZ cell", () => {
  const tess = new SourceTessState(), light = vec3(0, 0, 1), seed = Array.from({ length: 999 }, () => vec3(0, 0, 0));
  seed[997] = vec3(1, 0, 0); seed[998] = vec3(0, 1, 0);
  setShadowTess(tess, seed, [], light);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(0, 0, 0)], [0, 997, 998], light);
  const boundary = new ShadowEdgeState().build(tess);
  if (boundary.kind !== "volume") throw new Error("Expected allocated endpoint 999");
  expect(boundary.indices).toEqual([0, 2, 4, 4, 2, 5]);
  expect(boundary.positions[4]).toEqual(vec3(1, 0, 0));
  expect(boundary.positions[5]).toEqual(vec3(0, 0, 0));
  setShadowTess(tess, [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 1, 0)], [0, 997, 2], light);
  expect(() => new ShadowEdgeState().build(tess)).toThrow("outside scratch allocation");

  const suppressed = new ShadowEdgeState();
  seed[998] = vec3(0, -1, 0);
  setShadowTess(tess, seed, [], light);
  setShadowTess(tess, [], [997, 0, 998], light);
  suppressed.build(tess);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 1, 0)], [0, 997, 2], light);
  const unneeded = suppressed.build(tess);
  if (unneeded.kind !== "volume") throw new Error("Expected suppressed unallocated endpoint");
  expect(unneeded.indices).toEqual([2, 5, 0, 0, 5, 3]);
});

test("shadow publication does not pad through unreferenced retained cells", () => {
  const tess = new SourceTessState(), light = vec3(0, 0, 1), seed = Array.from({ length: 504 }, () => vec3(0, 0, 0));
  seed[100] = vec3(NaN, NaN, NaN); seed[500] = vec3(1, 0, 0); seed[503] = vec3(7, 8, 9);
  setShadowTess(tess, seed, [], light);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 1, 0)], [0, 500, 2], light);
  const result = new ShadowEdgeState().build(tess);
  if (result.kind !== "volume") throw new Error("Expected sparse retained endpoints");
  expect(result.indices).toEqual([0, 3, 6, 6, 3, 7, 2, 5, 0, 0, 5, 3]);
  expect(result.positions.length).toBe(8);
  expect(result.positions.slice(6)).toEqual([vec3(1, 0, 0), vec3(7, 8, 9)]);
});

test("empty and vertex-limit skips preserve adjacency and do not publish extrusion", () => {
  const tess = new SourceTessState(), edges = new ShadowEdgeState(), light = vec3(0, 0, 1);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, -1, 0)], [4, 0, 5], light);
  edges.build(tess);
  setShadowTess(tess, Array.from({ length: 500 }, () => vec3(2, 3, 4)), [0, 1, 2], vec3(Infinity, 0, 0));
  const largeTail = tess.allocatedVertex(500);
  expect(edges.build(tess)).toEqual({ kind: "source-vertex-limit" });
  expect(tess.allocatedVertex(500)).toEqual(largeTail);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)], [], light);
  const emptyTail = tess.allocatedVertex(3);
  expect(edges.build(tess)).toEqual({ kind: "empty" });
  expect(tess.allocatedVertex(3)).toEqual(emptyTail);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)], [0, 4, 2], light);
  const retained = edges.build(tess);
  if (retained.kind !== "volume") throw new Error("Expected adjacency to survive both gates");
  expect(retained.indices).toEqual([2, 5, 0, 0, 5, 3]);
});

test("source shadow finish uses the eye-space quad at z=-10 and retains the supplied projection", () => {
  expect(stencilShadowFinishVertices(identityMat4())).toEqual([
    { x: -100, y: 100, z: -10, w: 1 }, { x: 100, y: 100, z: -10, w: 1 },
    { x: 100, y: -100, z: -10, w: 1 }, { x: -100, y: -100, z: -10, w: 1 },
  ]);
  const view = createRefdef(); view.fovX = 90; view.fovY = 90;
  const vertices = stencilShadowFinishVertices(viewProjection(view, 2048));
  expect(vertices[0].x).toBe(-100);
  expect(vertices[0].y).toBe(100);
  expect(vertices[0].w).toBe(10);
  // Stored projection coefficients are -1.00391387939453125 and -8.015655517578125.
  expect(vertices[0].z).toBe(2.0234832763671875);
});

const viewport = { x: 0, y: 0, width: 32, height: 32 };
const gray = vec4(200 / 255, 200 / 255, 200 / 255, 1);
const red = vec4(1, 0, 0, 1);
const quadIndices = [0, 1, 2, 0, 2, 3];
function quadPositions(depth: number, left = -1, right = 1): readonly [Vec4, Vec4, Vec4, Vec4] {
  return [vec4(left, -1, depth, 1), vec4(right, -1, depth, 1), vec4(right, 1, depth, 1), vec4(left, 1, depth, 1)];
}
function colorQuad(image: RendererImage, color: Vec4, depth: number, left = -1, right = 1, state: RenderState = OPAQUE_STATE): Extract<DrawBatch, { texturing: "single"; primitive: "triangles" }> {
  return { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, indices: quadIndices, state,
    vertices: quadPositions(depth, left, right).map(position => ({ position, texCoord: { x: 0, y: 0 }, color })) };
}
function volume(image: RendererImage, depth = -0.5): Extract<ShadowViewOperation, { kind: "shadow-volume" }> {
  return { kind: "shadow-volume", positions: quadPositions(depth), indices: quadIndices, mirror: false, whiteImage: image };
}
function finish(image: RendererImage, depth = -0.75): Extract<ShadowViewOperation, { kind: "shadow-finish" }> {
  return { kind: "shadow-finish", positions: quadPositions(depth), whiteImage: image };
}
function pixel(pixels: () => Uint8Array, x = 16, y = 16): number[] {
  return [...pixels().subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
}
function withBackend(kind: "cpu" | "gl", bits: number,
  action: (backend: RendererBackend, image: RendererImage, pixels: () => Uint8Array, target: RenderTarget) => void): void {
  const images = new RendererImageCatalog();
  const window = kind === "gl" ? SdlWindow.open({ title: "Source stencil shadow proof", width: 32, height: 32, backend: "gl", stencilBits: bits, hidden: true }) : null;
  let target: RenderTarget | null = null;
  try {
    const backend = window === null ? new SoftwareRenderer(32, 32, images, 8, bits) : new GlRenderer(window, images);
    target = new RenderTarget(images, [backend]);
    if (backend instanceof GlRenderer) backend.initializeDefaultState(backend.capabilities.textureUnits > 1, () => {
      images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST");
    });
    expect(backend.stencilBits).toBe(bits);
    const pixels = backend instanceof SoftwareRenderer ? () => backend.pixels : () => backend.readPixels();
    const image = publishTexture(images, { name: "stencil white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    publishTexture(images, { name: "stencil sentinel", width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: true } });
    action(backend, image, pixels, target);
  } finally { target?.close(); window?.close(); }
}

test("the actual picture marker uses tess-owned adjacency and its hardware skip preserves it", () => withBackend("cpu", 8, (_backend, image, _pixels, target) => {
  const tess = new SourceTessState(), settings = createRendererSettings(), light = vec3(0, 0, 1);
  const finished = finishFailedShader({ name: "default", lightmapIndex: -1, profile: settings.registrationProfile() });
  const content = { definition: null, image, whiteImage: image, defaulted: true, sky: null, finished };
  const material: MaterialRecord = { ...content, kind: "ordinary", name: "default", order: 0, sortedIndex: 0, sort: finished.sort,
    lighting: { kind: "none" }, mip: true, remapped: null, timeOffset: 0 };
  const marker = new MaterialRegistry(async () => content, text => { throw new Error(text); }).registerStencilShadow(material);
  const project = (position: Vec3): Vec4 => vec4(position.x, position.y, position.z, 1);
  tess.beginSurface(marker, 0, 0);
  setShadowTess(tess, [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, -1, 0)], [4, 0, 5], light);
  expect(evaluateStencilShadowSurface(tess, project, target.stencilBits)).toHaveLength(1);
  setShadowTess(tess, Array.from({ length: 5 }, () => vec3(9, 8, 7)), [0, 0, 0], light);
  const tail = tess.allocatedVertex(5);
  expect(evaluateStencilShadowSurface(tess, project, 0)).toEqual([]);
  expect(tess.allocatedVertex(5)).toEqual(tail);
  const active = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)];
  for (let frame = 0; frame < 3; frame++) {
    tess.endSurface(); tess.endFrame(); tess.beginSurface(marker, 0, frame);
    setShadowTess(tess, active, [0, 4, 2], light);
    const operations = evaluateStencilShadowSurface(tess, project, target.stencilBits);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.indices).toEqual([2, 5, 0, 0, 5, 3]);
    expect([tess.numVertexes, tess.numIndexes]).toEqual([3, 3]);
  }
  const independent = new SourceTessState(); independent.beginSurface(marker, 0, 0);
  setShadowTess(independent, active, [0, 4, 2], light);
  expect(evaluateStencilShadowSurface(independent, project, target.stencilBits)[0]?.indices).toEqual([0, 3, 4, 4, 3, 6, 2, 5, 0, 0, 5, 3]);
}));

for (const kind of ["cpu", "gl"] satisfies readonly ("cpu" | "gl")[]) {
  describe.skipIf(kind === "gl" && process.env["QUAKE_GL_TEST"] !== "1")(`${kind} source stencil execution`, () => {
    test("translated silhouette shadows the receiver once and preserves the caster and surrounding pixels", () => withBackend(kind, 8, (backend, image, pixels) => {
      const caster = [vec3(0, -64, 64), vec3(64, -64, 64), vec3(64, 64, 64), vec3(0, 64, 64)];
      const project = (point: Vec3): Vec4 => vec4(point.x / 256, point.y / 128, -point.z / 128, 1);
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      executeStaticBatch(backend, { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, indices: quadIndices,
        state: OPAQUE_STATE, vertices: caster.map(position => ({ position: project(position), texCoord: { x: 0, y: 0 }, color: red })) });
      const geometry = buildTestShadow(caster, quadIndices, vec3(Math.SQRT1_2, 0, Math.SQRT1_2));
      if (geometry.kind !== "volume") throw new Error("Expected source caster volume");
      const operation: ShadowViewOperation = { kind: "shadow-volume", positions: geometry.positions.map(project), indices: geometry.indices,
        mirror: false, whiteImage: image };
      backend.drawImmediate(operation); backend.drawImmediate(operation);
      expect(pixel(pixels, 14, 16)).toEqual([200, 200, 200, 255]);
      backend.drawImmediate(finish(image));
      expect(pixel(pixels, 14, 16)).toEqual([120, 120, 120, 255]);
      expect(pixel(pixels, 18, 16)).toEqual([255, 0, 0, 255]);
      expect(pixel(pixels, 10, 16)).toEqual([200, 200, 200, 255]);
    }));

    test("mirror reverses the source increment/decrement culls", () => withBackend(kind, 8, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      const source = volume(image);
      backend.drawImmediate({ ...source, mirror: true, positions: source.positions.map(position => ({ ...position, x: -position.x })) });
      backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([120, 120, 120, 255]);
    }));

    test("stencil increment and decrement saturate at 255 and zero without wrapping", () => withBackend(kind, 8, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      for (let index = 0; index < 256; index++) backend.drawImmediate(volume(image));
      backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([120, 120, 120, 255]);
      backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: true } });
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
      backend.drawImmediate({ ...volume(image), indices: [0, 2, 1, 0, 3, 2] });
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
      backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
    }));

    test("later ordinary triangles and lines retain DECR, with alpha and depth failure leaving stencil intact", () => withBackend(kind, 8, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      backend.drawImmediate(volume(image));
      executeStaticBatch(backend, colorQuad(image, red, 0.5));
      executeStaticBatch(backend, colorQuad(image, { ...red, w: 0 }, -0.6, -1, 1, { ...OPAQUE_STATE, alphaTest: "gt0" }));
      executeStaticBatch(backend, colorQuad(image, gray, -0.6, -1, 0, { ...OPAQUE_STATE, depthWrite: false }));
      executeStaticBatch(backend, { primitive: "lines", lineWidth: 1, texturing: "single", texture: { kind: "bind-image", image }, indices: [0, 1],
        state: { ...OPAQUE_STATE, depthWrite: false }, vertices: [vec4(0, -0.03125, -0.6, 1), vec4(1, -0.03125, -0.6, 1)]
          .map(position => ({ position, texCoord: { x: 0, y: 0 }, color: gray })) });
      backend.drawImmediate(finish(image));
      expect(pixel(pixels, 8, 8)).toEqual([200, 200, 200, 255]);
      expect(pixel(pixels, 24, 8)).toEqual([120, 120, 120, 255]);
      expect(pixel(pixels, 24, 16)).toEqual([200, 200, 200, 255]);
    }));

    test("retained volume depth range is applied after clipping and fragments never write depth or color", () => withBackend(kind, 8, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      backend.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      backend.drawImmediate(volume(image, 0.5));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
      executeStaticBatch(backend, colorQuad(image, red, -0.25, -1, 0, { ...OPAQUE_STATE, depthWrite: false }));
      backend.drawImmediate(finish(image));
      expect(pixel(pixels, 8, 16)).toEqual([255, 0, 0, 255]);
      expect(pixel(pixels, 24, 16)).toEqual([120, 120, 120, 255]);
    }));

    test("depth-hacked shadow vertices outside the far clip plane are still rejected", () => withBackend(kind, 8, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      backend.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      backend.drawImmediate(volume(image, 2));
      backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
    }));

    test("finish uses LEQUAL, retains the depth range, writes depth, and disables stencil for following draws", () => withBackend(kind, 8, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, -0.9, -1, 0));
      executeStaticBatch(backend, colorQuad(image, gray, 0, 0, 1));
      backend.drawImmediate({ kind: "depth-range", range: [0, 0.3] });
      backend.drawImmediate(volume(image, -1));
      backend.drawImmediate(finish(image));
      expect(pixel(pixels, 8, 16)).toEqual([120, 120, 120, 255]);
      expect(pixel(pixels, 24, 16)).toEqual([120, 120, 120, 255]);
      executeStaticBatch(backend, colorQuad(image, red, -0.5));
      expect(pixel(pixels, 24, 16)).toEqual([120, 120, 120, 255]);
      executeStaticBatch(backend, colorQuad(image, red, -0.95));
      expect(pixel(pixels)).toEqual([255, 0, 0, 255]);
    }));

    test("portal clipping affects volumes, finish disables it, and stencil clear respects each view scissor", () => withBackend(kind, 8, (backend, image, pixels) => {
      backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: true }, clipPlane: vec4(1, 0, 0, 0) });
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      backend.drawImmediate(volume(image));
      backend.drawImmediate(finish(image));
      expect(pixel(pixels, 8, 16)).toEqual([200, 200, 200, 255]);
      expect(pixel(pixels, 24, 16)).toEqual([120, 120, 120, 255]);
      executeStaticBatch(backend, colorQuad(image, red, -0.95));
      expect(pixel(pixels, 8, 16)).toEqual([255, 0, 0, 255]);
      backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: true } });
      backend.drawImmediate(volume(image)); backend.drawImmediate(volume(image));
      backend.drawImmediate(finish(image));
      backend.beginView({ viewport: { x: 8, y: 8, width: 16, height: 16 }, clear: { depth: 1, color: gray, stencil: true } });
      backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
      backend.beginView({ viewport, clear: null });
      backend.drawImmediate(finish(image, -0.8));
      expect(pixel(pixels, 4, 4)).toEqual([72, 72, 72, 255]);
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
    }));

    test("zero-edge volumes still bind white and enable retained stencil updates", () => withBackend(kind, 8, (backend, image, pixels, target) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      backend.drawImmediate(volume(image)); backend.drawImmediate(volume(image));
      backend.drawImmediate(finish(image));
      backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: false } });
      const black = publishTexture(target.images, { name: "retained black", width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]),
        internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      executeStaticBatch(backend, colorQuad(black, gray, 0));
      expect(pixel(pixels)).toEqual([0, 0, 0, 255]);
      backend.drawImmediate({ ...volume(image), positions: [], indices: [] });
      const retained: DrawBatch = { ...colorQuad(image, gray, -0.5), texture: { kind: "retain-current-texture" } };
      executeStaticBatch(backend, retained);
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
      backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
    }));

    test("the actual command buffer snapshots interleaved color and shadow operations", () => withBackend(kind, 8, (backend, image, pixels, target) => {
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      try {
        const positions = [...quadPositions(-0.5)];
        const operations: ViewOperation[] = [
          { kind: "draw", batches: [colorQuad(image, gray, 0)] }, { ...volume(image), positions },
          { kind: "draw", batches: [colorQuad(image, gray, -0.6, -1, 0, { ...OPAQUE_STATE, depthWrite: false })] },
          volume(image), finish(image),
        ];
        commands.addView({ viewport, clear: { depth: 1, color: gray, stencil: true }, operations });
        positions.fill(vec4(0, 0, 0, 1)); operations.length = 0;
        expect(commands.submit()).toEqual({ commands: 1, views: 1, batches: 2 });
        expect(pixel(pixels, 8, 16)).toEqual([120, 120, 120, 255]);
        expect(pixel(pixels, 24, 16)).toEqual([120, 120, 120, 255]);
        backend.beginView({ viewport, clear: null });
        executeStaticBatch(backend, colorQuad(image, red, -0.95));
        expect(pixel(pixels)).toEqual([255, 0, 0, 255]);
      } finally { commands.close("discard"); }
    }));

    test("retained tess replay after finish executes before the next view clear", () => withBackend(kind, 8, (_backend, image, pixels, target) => {
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      try {
        commands.addView({ viewport, clear: { depth: 1, color: gray, stencil: true }, operations: [
          { kind: "draw", batches: [colorQuad(image, gray, 0)] }, volume(image), finish(image), volume(image, -0.9),
        ] });
        commands.submit();
        expect(pixel(pixels)).toEqual([120, 120, 120, 255]);
        commands.addView({ viewport, clear: { depth: 1, color: gray, stencil: false }, operations: [finish(image)] });
        commands.submit();
        expect(pixel(pixels)).toEqual([120, 120, 120, 255]);
      } finally { commands.close("discard"); }
    }));

    test("frame submission replays a retained world shadow exactly once while an empty mid-frame issue retains it", () => withBackend(kind, 8, (backend, image, pixels, target) => {
      const settings = createRendererSettings(), tess = new SourceTessState();
      const content = { definition: null, image, whiteImage: image, defaulted: true, sky: null,
        finished: finishFailedShader({ name: "default", lightmapIndex: -1, profile: settings.registrationProfile() }) };
      const defaultMaterial: MaterialRecord = { ...content, kind: "ordinary", name: "default", order: 0, sortedIndex: 0, sort: content.finished.sort,
        lighting: { kind: "none" }, mip: true, remapped: null, timeOffset: 0 };
      const marker = new MaterialRegistry(async () => content, text => { throw new Error(text); }).registerStencilShadow(defaultMaterial);
      const refdef = createRefdef(); refdef.fovX = refdef.fovY = 90;
      const projection = viewProjection(refdef, 2048), project = (position: Vec3): Vec4 => transformVec4(projection, vec4(position.x, position.y, position.z, 1));
      const caster = [vec3(0, -4, -8), vec3(4, -4, -8), vec3(4, 4, -8), vec3(0, 4, -8)];
      const receiver: DrawBatch = { texturing: "single", primitive: "triangles", texture: { kind: "bind-image", image }, indices: quadIndices, state: OPAQUE_STATE,
        vertices: [vec3(-16, -16, -16), vec3(16, -16, -16), vec3(16, 16, -16), vec3(-16, 16, -16)]
          .map(position => ({ position: project(position), texCoord: { x: 0, y: 0 }, color: gray })) };
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess, runtime: settings.runtime });
      try {
        commands.addPreparedViews(() => {
          tess.beginSurface(marker, 0, 0); tess.setProjector(project);
          tess.setEntity({ ...tess.context, lighting: { ...tess.context.lighting, lightDir: vec3(Math.SQRT1_2, 0, Math.SQRT1_2) } });
          tess.appendGeometry({ vertices: caster.map(position => ({ position, normal: vec3(0, 0, 1),
            texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 }, color: red })), indices: quadIndices }, "stamp");
          return [{ viewport, clear: { depth: 1, color: gray, stencil: true }, operations: [
            { kind: "draw", batches: [receiver] }, ...evaluateStencilShadowSurface(tess, position => tess.projectPosition(position), target.stencilBits),
          ] }];
        });
        commands.submit(); commands.submit();
        expect(tess.numIndexes).toBe(6);
        expect(commands.submitFrame()).toEqual({ commands: 0, views: 0, batches: 0 });
        expect(tess.numIndexes).toBe(6);
        backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: false } });
        executeStaticBatch(backend, receiver);
        backend.drawImmediate({ kind: "shadow-finish", positions: stencilShadowFinishVertices(projection), whiteImage: image });
        expect(pixel(pixels, 10, 16)).toEqual([120, 120, 120, 255]);
        backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: false } });
        backend.drawImmediate({ kind: "shadow-finish", positions: stencilShadowFinishVertices(projection), whiteImage: image });
        expect(pixel(pixels, 10, 16)).toEqual([200, 200, 200, 255]);
      } finally { commands.close("discard"); }
    }));

    test("a selected zero-bit profile follows both source hardware skips", () => withBackend(kind, 0, (backend, image, pixels) => {
      executeStaticBatch(backend, colorQuad(image, gray, 0));
      backend.drawImmediate(volume(image)); backend.drawImmediate(finish(image));
      expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
    }));

    for (const source of ["queued", "prepared"]) test(`${source} before-view surfaces own their inputs and use the retained viewport before clear`, () => withBackend(kind, 8, (backend, image, pixels, target) => {
      backend.beginView({ viewport: { x: 0, y: 0, width: 16, height: 32 }, clear: { depth: 1, color: red, stencil: true } });
      const positions = [...quadPositions(-0.5)], indices = [...quadIndices], batches = [colorQuad(image, gray, 0)];
      const beforeView: SurfaceViewOperation[] = [{ kind: "draw", batches }, { ...volume(image), positions, indices }];
      const view = { viewport: { x: 16, y: 0, width: 16, height: 32 }, clear: { depth: 1, color: gray, stencil: true }, beforeView, operations: [] };
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1,
        tess: new SourceTessState(), runtime: createRendererSettings().runtime });
      const prepare = backend.prepareGeometry;
      const mutate = (): void => { positions.fill(vec4(0, 0, 0, 1)); indices.length = batches.length = beforeView.length = 0; };
      try {
        if (source === "queued") { commands.addView(view); mutate(); }
        else {
          commands.addPreparedViews(() => [view]);
          backend.prepareGeometry = batch => { mutate(); return prepare.call(backend, batch); };
        }
        expect(commands.submit()).toEqual({ commands: 1, views: 1, batches: 1 });
        backend.beginView({ viewport, clear: null }); backend.drawImmediate(finish(image));
        expect(pixel(pixels, 8, 16)).toEqual([120, 120, 120, 255]);
        expect(pixel(pixels, 24, 16)).toEqual([200, 200, 200, 255]);
      } finally { backend.prepareGeometry = prepare; commands.close("discard"); }
    }));
  });
}

test("CPU r_nobind volumes ignore unused coordinates and retain depth, stencil, alpha, and binding behavior", () => withBackend("cpu", 8, (backend, image, pixels, target) => {
  const dlight = publishTexture(target.images, { name: "nonuniform volume override", width: 2, height: 1,
    pixels: new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255]), internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  target.images.setDlightImage(dlight);
  executeStaticBatch(backend, colorQuad(image, gray, 0));
  executeStaticBatch(backend, colorQuad(image, red, -0.75, -1, 1, { ...OPAQUE_STATE, alphaTest: "lt128" }));
  target.images.setBindingSettings({ noBind: true });
  const stencil = new Uint8Array(32 * 32);
  expect(() => backend.drawImmediate(volume(image, 0.5))).not.toThrow();
  backend.readStencilOverdraw(stencil);
  expect(stencil.every(value => value === 0)).toBe(true);
  expect(() => backend.drawImmediate(volume(image))).not.toThrow();
  backend.readStencilOverdraw(stencil);
  expect(stencil.every(value => value === 1)).toBe(true);
  expect(pixel(pixels)).toEqual([200, 200, 200, 255]);

  target.images.setBindingSettings({ noBind: false });
  const probe = colorQuad(image, vec4(1, 1, 1, 1), -0.25, -1, 1, { ...OPAQUE_STATE, depthWrite: false });
  const retained: DrawBatch = { ...probe, texture: { kind: "retain-current-texture" },
    vertices: probe.vertices.map(vertex => ({ ...vertex, texCoord: { x: 0.25, y: 0.5 } })) };
  executeStaticBatch(backend, { ...retained, state: { ...retained.state, alphaTest: "gt0" } });
  backend.readStencilOverdraw(stencil);
  expect(stencil.every(value => value === 1)).toBe(true);
  expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
  executeStaticBatch(backend, retained);
  backend.readStencilOverdraw(stencil);
  expect(stencil.every(value => value === 0)).toBe(true);
  expect(pixel(pixels)).toEqual([255, 0, 0, 0]);
}));

test("CPU r_nobind shadow finish still rejects consumed source-indeterminate coordinates", () => withBackend("cpu", 8, (backend, image, pixels, target) => {
  const dlight = publishTexture(target.images, { name: "nonuniform finish override", width: 2, height: 1,
    pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), internalFormat: "rgba8",
    sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  target.images.setDlightImage(dlight);
  executeStaticBatch(backend, colorQuad(image, gray, 0));
  target.images.setBindingSettings({ noBind: true });
  backend.drawImmediate(volume(image));
  expect(() => backend.drawImmediate(finish(image))).toThrow("source-indeterminate coordinates");
  const stencil = new Uint8Array(32 * 32);
  backend.readStencilOverdraw(stencil);
  expect(stencil.every(value => value === 1)).toBe(true);
  expect(pixel(pixels)).toEqual([200, 200, 200, 255]);
  target.images.setBindingSettings({ noBind: false });
  backend.drawImmediate(finish(image));
  expect(pixel(pixels)).toEqual([120, 120, 120, 255]);
}));

test("CPU shadow finish binding failure retains the reached stencil, clip and cull prefix but not later color or state", () => withBackend("cpu", 8, (backend, image, pixels, target) => {
  const black = publishTexture(target.images, { name: "finish prefix black", width: 1, height: 1,
    pixels: new Uint8Array([0, 0, 0, 255]), internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
  backend.drawImmediate(volume(image));
  backend.beginView({ viewport, clear: { depth: 1, color: gray, stencil: false }, clipPlane: vec4(1, 0, 0, 0) });
  backend.drawImmediate({ kind: "cull", cull: "front" });
  withBackend("cpu", 0, (_other, foreign) => {
    expect(() => backend.drawImmediate(finish(foreign))).toThrow("belongs to another catalog");
  });
  const rect = { x: 0, y: 0, width: 32, height: 32 };
  backend.drawShowImage(image, rect, false);
  expect(pixel(pixels, 8, 16)).toEqual([51, 51, 51, 255]);
  expect(pixel(pixels, 24, 16)).toEqual([51, 51, 51, 255]);
  backend.drawShowImage(black, rect, false);
  expect(pixel(pixels, 8, 16)).toEqual([51, 51, 51, 255]);
  expect(pixel(pixels, 24, 16)).toEqual([51, 51, 51, 255]);
}));

test("CPU stencil precision controls saturation while the source finish tests only mask 255", () => {
  for (const bits of [3, 4, 16, 32]) withBackend("cpu", bits, (backend, image, pixels) => {
    executeStaticBatch(backend, colorQuad(image, gray, 0));
    for (let index = 0; index < 256; index++) backend.drawImmediate(volume(image));
    backend.drawImmediate(finish(image));
    expect(pixel(pixels)).toEqual(bits === 4 ? [120, 120, 120, 255] : [200, 200, 200, 255]);
  });
  const images = new RendererImageCatalog();
  expect(() => new SoftwareRenderer(32, 32, images, 8, -1)).toThrow("stencil precision");
  expect(() => new SoftwareRenderer(32, 32, images, 8, 33)).toThrow("stencil precision");
});

test("target parity rejects differing actual stencil precision and view validation rejects duplicate finish", () => {
  const images = new RendererImageCatalog(), zero = new SoftwareRenderer(32, 32, images), eight = new SoftwareRenderer(32, 32, images, 8, 8);
  try { expect(() => new RenderTarget(images, [zero, eight])).toThrow("target mismatch"); }
  finally { zero.close(); eight.close(); }
  withBackend("cpu", 8, (_backend, image) => {
    expect(() => validateRenderView({ viewport, clear: { depth: 1, color: gray, stencil: true }, operations: [volume(image), finish(image), volume(image)] })).not.toThrow();
    expect(() => validateRenderView({ viewport, clear: { depth: 1, color: gray, stencil: true }, operations: [finish(image), finish(image)] })).toThrow("more than one");
  });
});

test("raw source cull changes preserve the logical cache for later shader and 2D calls", () => {
  const tess = new SourceTessState();
  expect(tess.cullState("back")).toBe("back");
  tess.setActualCull("front"); expect(tess.cullState("back")).toBe("front");
  tess.setActualCull("none"); expect(tess.cullState("back")).toBe("none");
  tess.setGL2D(1); expect(tess.cullState("back")).toBe("none");
});

test("physical depth range survives view and 2D transitions without sharing mutable tuples", () => {
  const tess = new SourceTessState(), input: [number, number] = [0, 0.3];
  tess.setDepthRange(input); input[1] = 0.5;
  tess.setGL2D(1); tess.beginDrawingView(); tess.endFrame();
  tess.enterView({ origin: vec3(0, 0, 0), axis: [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)], mirror: false }, 1, createRefdef());
  expect(tess.actualDepthRange).toEqual([0, 0.3]);
  expect(tess.actualDepthRange).not.toBe(tess.actualDepthRange);
  expect(() => tess.setDepthRange([0, Infinity])).toThrow("finite");
});

test("retained position projection starts at native identity and changes only at actual matrix-setting calls", () => {
  const tess = new SourceTessState(), input = vec3(2, 3, 4), result = vec4(5, 6, 7, 8);
  expect(tess.projectPosition(input)).toEqual(vec4(2, 3, 4, 1));
  tess.setProjector(() => result);
  tess.setGL2D(1); tess.beginDrawingView(); tess.endFrame();
  expect(tess.projectPosition(input)).toEqual(result);
  expect(tess.projectPosition(input)).not.toBe(result);
  tess.setProjector(position => vec4(position.x * 2, position.y, position.z, 1));
  expect(tess.projectPosition(input)).toEqual(vec4(4, 3, 4, 1));
});

test("source tess binds one ordinary evaluator and resets accumulated light bits only at BeginSurface", () => withBackend("cpu", 8, (_backend, image) => {
  const tess = new SourceTessState(), settings = createRendererSettings();
  const finished = finishFailedShader({ name: "default", lightmapIndex: -1, profile: settings.registrationProfile() });
  const material: MaterialRecord = { definition: null, image, whiteImage: image, defaulted: true, sky: null, finished,
    kind: "ordinary", name: "default", order: 0, sortedIndex: 0, sort: finished.sort, lighting: { kind: "none" }, mip: true, remapped: null, timeOffset: 0 };
  const evaluate = (): readonly SurfaceViewOperation[] => {
    const batch = colorQuad(image, gray, 0);
    const scratch = batch.vertices.map((vertex, index) => ({ color: vertex.color, texCoord: vertex.texCoord, texCoord2: tess.stageTexCoord(1, index),
      rawTexCoord: vertex.texCoord, rawTexCoord2: { x: 0, y: 0 } }));
    return [{ kind: "begin-generic-iterator", setArraysOnce: true, scratch },
      { kind: "source-stage", stage: { kind: "generic-single", stateBits: SourceStateBit.DEFAULT, batch, scratch } }];
  };
  expect(tess.surfaceEvaluator).toBeNull();
  tess.bindSurfaceEvaluator(evaluate);
  expect(() => tess.bindSurfaceEvaluator(evaluate)).toThrow("already bound");
  tess.beginSurface(material, 0, 0);
  expect(tess.dlightBits).toBe(0);
  tess.addDlightBits(1); tess.addDlightBits(4); tess.addDlightBits(0x80000000);
  expect(tess.dlightBits).toBe(-2147483643);
  tess.endSurface(); tess.resetGeometry(); tess.setGL2D(1); tess.beginDrawingView(); tess.endFrame();
  expect(tess.dlightBits).toBe(-2147483643);
  expect(tess.surfaceEvaluator).toBe(evaluate);
  tess.beginSurface(material, 0, 0);
  expect(tess.dlightBits).toBe(0);
  tess.addDlightBits(2);
  tess.beginSurface(material, 0, 0);
  expect(tess.dlightBits).toBe(0);
  expect(tess.surfaceEvaluator).toBe(evaluate);
}));

test("shadow scratch writeback preserves active geometry, counts, stage colors, and texture coordinates", () => {
  const tess = new SourceTessState();
  tess.appendGeometry({ vertices: square.map(position => ({ position, normal: vec3(0, 0, 1),
    texCoord: { x: 0.25, y: 0.5 }, lightmapCoord: { x: 0.5, y: 0.25 }, color: { x: 255, y: 128, z: 64, w: 32 } })), indices: squareIndices }, "stamp");
  tess.writeStageColor(4, red); tess.writeStageTexCoord(0, 4, { x: 0.25, y: 0.75 });
  const before = tess.snapshotGeometry(), geometry = buildTestShadow(square, squareIndices, vec3(0, 0, 1));
  if (geometry.kind !== "volume") throw new Error("Expected source square volume");
  tess.writeShadowPositions(geometry.positions);
  expect(tess.snapshotGeometry()).toEqual(before);
  expect([tess.numVertexes, tess.numIndexes]).toEqual([4, 6]);
  expect(tess.stageColor(4)).toEqual(red);
  expect(tess.stageTexCoord(0, 4)).toEqual({ x: 0.25, y: 0.75 });
  expect(() => tess.writeShadowPositions(square)).toThrow("active tess allocation");
});

test("source r_finish distinguishes first view, frame reset, UI-only swap, and unconditional raw barriers", () => {
  class FinishRecorder extends SoftwareRenderer {
    readonly events: string[] = [];
    override beginView(view: RenderViewState): undefined { super.beginView(view); this.events.push("view"); return undefined; }
    override finish(): undefined { super.finish(); this.events.push("finish"); return undefined; }
  }
  for (const value of [0, 1, 2, -1]) {
    const cvars = new CvarRegistry(); cvars.set("r_finish", String(value), true);
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    const images = new RendererImageCatalog(), backend = new FinishRecorder(1, 1, images), target = new RenderTarget(images, [backend]);
    const tess = new SourceTessState(), commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess, runtime: settings.runtime });
    try {
      const image = publishTexture(images, { name: "finish white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
        internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
      const view = { viewport: { x: 0, y: 0, width: 1, height: 1 }, clear: { depth: 1, color: null, stencil: false }, operations: [] };
      commands.beginFrame(); commands.addView(view); commands.addView(view); commands.submit();
      expect(backend.events).toEqual(value === 1 ? ["finish", "view", "view"] : ["view", "view"]);
      commands.submitFrame();
      expect(backend.events).toEqual(value === 1 ? ["finish", "view", "view"] : value === 0 ? ["view", "view"] : ["view", "view", "finish"]);
      backend.events.length = 0;
      commands.beginFrame();
      commands.stretchPixels({ x: 0, y: 0, width: 1, height: 1 }, { s: 0, t: 0, s2: 1, t2: 1 },
        { kind: "image", name: "finish white", texture: { kind: "bind-image", image }, state: OPAQUE_STATE, color: { rgb: "identity", alpha: "identity" } });
      commands.submitFrame();
      expect(backend.events).toEqual(["view", "finish"]);
      expect(tess.is2D).toBe(false);
      backend.events.length = 0;
      commands.beginFrame();
      commands.stretchRaw({ x: 0, y: 0, width: 1, height: 1 }, { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
        captureAfterBarrier: () => ({ upload: { image, sourceWidth: 1, sourceHeight: 1, uploadWidth: 1, uploadHeight: 1, dirty: true,
          content: new RgbaSnapshot(1, 1, new Uint8Array([255, 255, 255, 255])) }, afterUiDraw: () => undefined }) });
      commands.submitFrame();
      expect(backend.events.filter(event => event === "finish")).toEqual(["finish", "finish"]);
    } finally { commands.close("discard"); target.close(); }
  }
});

test("pre-view draws precede finish bookkeeping and record initial draws without a synthetic view", () => {
  class PrefixRecorder extends BatchRecordingBackend {
    readonly events: string[] = [];
    override beginView(view: RenderViewState): undefined { super.beginView(view); this.events.push("view"); return undefined; }
    override finish(): undefined { super.finish(); this.events.push("finish"); return undefined; }
    override drawImmediate(operation: ImmediateViewOperation): undefined { super.drawImmediate(operation); this.events.push(operation.kind); return undefined; }
    override prepareGeometry(batch: DrawBatch): PreparedBackendDraw {
      const prepared = super.prepareGeometry(batch);
      return { begin: () => prepared.begin(), applyTexture: (unit, operation) => prepared.applyTexture(unit, operation),
        draw: () => { prepared.draw(); this.events.push("draw"); return undefined; }, cleanup: () => prepared.cleanup() };
    }
  }
  const images = new RendererImageCatalog(), recording = new PrefixRecorder(new SoftwareRenderer(32, 32, images, 8, 8)), target = new RenderTarget(images, [recording]);
  const cvars = new CvarRegistry(); cvars.set("r_finish", "1", true);
  const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock: { milliseconds: () => 0 }, identityLight: 1, tess: new SourceTessState(), runtime: settings.runtime });
  try {
    const image = publishTexture(images, { name: "prefix white", width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
      internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
    const draw: SurfaceViewOperation = { kind: "draw", batches: [colorQuad(image, gray, 0)] };
    commands.beginFrame();
    commands.addView({ viewport, clear: { depth: 1, color: red, stencil: true }, beforeView: [draw, volume(image)], operations: [] });
    commands.submitFrame();
    expect(recording.events).toEqual(["draw", "shadow-volume", "finish", "view", "log-comment"]);
    expect(recording.initialBatches).toHaveLength(1); expect(recording.initialBatches).not.toBe(recording.initialBatches);
    expect(recording.trace()).toHaveLength(1); expect(recording.trace()[0]?.batches).toHaveLength(0);
    commands.addView({ viewport, clear: { depth: 1, color: red, stencil: true }, beforeView: [draw], operations: [] }); commands.submit();
    expect(recording.initialBatches).toHaveLength(1); expect(recording.trace()[0]?.batches).toHaveLength(1);
    expect(recording.trace()).toHaveLength(2);
  } finally { commands.close("discard"); target.close(); }
});

test.skipIf(process.env["QUAKE_GL_TEST"] !== "1")("native stencil-clear refresh preserves both units, disabled texturing, bindings, and independent selectors", () => withBackend("gl", 8, (backend, image) => {
  if (!(backend instanceof GlRenderer)) throw new Error("Expected actual GL backend");
  const library = loadGl(backend.window), gl = library.symbols;
  const value = new Int32Array(1);
  const integer = (name: number): number => {
    gl.glGetIntegerv(name, value); const result = value[0];
    if (result === undefined) throw new Error("Missing native state query"); return result;
  };
  try {
    const pair: DrawBatch = { ...colorQuad(image, gray, 0), texturing: "pair", secondTexture: { binding: { kind: "bind-image", image }, environment: "modulate" },
      vertices: quadPositions(0).map(position => ({ position, texCoord: { x: 0, y: 0 }, texCoord2: { x: 0, y: 0 }, color: gray })) };
    executeStaticBatch(backend, pair);
    for (const enabled of [[true, true], [false, true], [true, false], [false, false]] satisfies readonly (readonly [boolean, boolean])[]) {
      const bindings: number[] = [];
      for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
        gl.glActiveTexture(0x84c0 + unit);
        if (enabled[unit]) gl.glEnable(0xde1); else gl.glDisable(0xde1);
        bindings.push(integer(0x8069));
      }
      gl.glActiveTexture(0x84c1); gl.glClientActiveTexture(0x84c0);
      backend.beginView({ viewport, clear: { depth: 1, color: null, stencil: true } });
      expect(integer(0x84e0)).toBe(0x84c1); expect(integer(0x84e1)).toBe(0x84c0);
      for (const unit of [0, 1] satisfies readonly (0 | 1)[]) {
        gl.glActiveTexture(0x84c0 + unit);
        const binding = bindings[unit];
        if (binding === undefined) throw new Error("Missing native binding snapshot");
        expect(gl.glIsEnabled(0xde1) !== 0).toBe(enabled[unit]);
        expect(integer(0x8069)).toBe(binding);
      }
    }
    expect(gl.glGetError()).toBe(0);
  } finally {
    gl.glActiveTexture(0x84c1); gl.glDisable(0xde1); gl.glActiveTexture(0x84c0); gl.glEnable(0xde1); gl.glClientActiveTexture(0x84c0);
    library.close();
  }
}));
