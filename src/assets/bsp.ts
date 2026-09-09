// BSP v46 layout and loading semantics from id Software's GPL-2.0-or-later
// code/qcommon/qfiles.h, cm_load.c and code/renderer/tr_bsp.c.
import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { Bounds, Vec2, Vec3, Vec4 } from "../core/math.ts";
import { parseEntities } from "../core/text.ts";

export interface BspShader { readonly name: string; readonly surfaceFlags: number; readonly contentFlags: number }
export interface BspPlane { readonly normal: Vec3; readonly distance: number }
export interface BspNode { readonly plane: number; readonly children: readonly [number, number]; readonly bounds: Bounds }
export interface BspLeaf {
  readonly cluster: number;
  readonly area: number;
  readonly bounds: Bounds;
  readonly firstSurface: number;
  readonly surfaceCount: number;
  readonly firstBrush: number;
  readonly brushCount: number;
}
export interface BspModel {
  readonly bounds: Bounds;
  readonly firstSurface: number;
  readonly surfaceCount: number;
  readonly firstBrush: number;
  readonly brushCount: number;
}
export interface BspBrush { readonly firstSide: number; readonly sideCount: number; readonly shader: number }
export interface BspBrushSide { readonly plane: number; readonly shader: number }
export interface BspVertex {
  readonly position: Vec3;
  readonly texCoord: Vec2;
  /** Stored UVs may be non-finite on unlit retail patches; only lightmapped surfaces consume them. */
  readonly lightmapCoord: Vec2;
  readonly normal: Vec3;
  readonly color: Vec4;
}
export interface BspFog { readonly shader: string; readonly brush: number; readonly visibleSide: number }
interface BspSurfaceFields {
  readonly shader: number;
  readonly fog: number;
  readonly firstVertex: number;
  readonly vertexCount: number;
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly lightmap: number;
  readonly lightmapX: number;
  readonly lightmapY: number;
  readonly lightmapWidth: number;
  readonly lightmapHeight: number;
  readonly lightmapOrigin: Vec3;
  readonly lightmapVectors: readonly [Vec3, Vec3, Vec3];
  readonly patchWidth: number;
  readonly patchHeight: number;
}
export type BspSurface = BspSurfaceFields & (
  { readonly type: "planar" } | { readonly type: "patch" }
  | { readonly type: "triangles" } | { readonly type: "flare" }
);
export interface BspLightGridPoint { readonly ambient: Vec3; readonly directed: Vec3; readonly latLong: Vec2 }
export interface BspVisibility { readonly clusterCount: number; readonly bytesPerCluster: number; readonly bits: Uint8Array }
export interface BspMap {
  readonly entities: string;
  readonly entityRecords: ReturnType<typeof parseEntities>;
  readonly shaders: readonly BspShader[];
  readonly planes: readonly BspPlane[];
  readonly nodes: readonly BspNode[];
  readonly leaves: readonly BspLeaf[];
  readonly leafSurfaces: readonly number[];
  readonly leafBrushes: readonly number[];
  readonly models: readonly BspModel[];
  readonly brushes: readonly BspBrush[];
  readonly brushSides: readonly BspBrushSide[];
  readonly vertices: readonly BspVertex[];
  readonly indices: readonly number[];
  readonly fogs: readonly BspFog[];
  readonly surfaces: readonly BspSurface[];
  readonly lightmaps: readonly Uint8Array[];
  readonly lightGrid: readonly BspLightGridPoint[];
  readonly visibility: BspVisibility | null;
}

interface Lump { readonly offset: number; readonly length: number }
const HEADER_SIZE = 8 + 17 * 8;
const LIGHTMAP_SIZE = 128 * 128 * 3;

function vec2(reader: BinaryReader): Vec2 { return { x: reader.finiteF32(), y: reader.finiteF32() }; }
function vec3(reader: BinaryReader): Vec3 { return { x: reader.finiteF32(), y: reader.finiteF32(), z: reader.finiteF32() }; }
function intVec3(reader: BinaryReader): Vec3 { return { x: reader.i32(), y: reader.i32(), z: reader.i32() }; }
function byteVec3(reader: BinaryReader): Vec3 { return { x: reader.u8(), y: reader.u8(), z: reader.u8() }; }

// C strings contain bytes, not UTF-8. Preserve all byte values, including mod text.
function string(reader: BinaryReader, length: number): string {
  const bytes = reader.bytes(length);
  let result = "";
  for (const byte of bytes) {
    if (byte === 0) break;
    result += String.fromCharCode(byte);
  }
  return result;
}

function surface(reader: BinaryReader): BspSurface {
  const shader = reader.i32();
  const fog = reader.i32();
  const typeOffset = reader.offset;
  const type = reader.i32();
  const fields: BspSurfaceFields = {
    shader, fog, firstVertex: reader.i32(), vertexCount: reader.i32(),
    firstIndex: reader.i32(), indexCount: reader.i32(), lightmap: reader.i32(),
    lightmapX: reader.i32(), lightmapY: reader.i32(),
    lightmapWidth: reader.i32(), lightmapHeight: reader.i32(),
    lightmapOrigin: vec3(reader), lightmapVectors: [vec3(reader), vec3(reader), vec3(reader)],
    patchWidth: reader.i32(), patchHeight: reader.i32(),
  };
  switch (type) {
    case 1: return { ...fields, type: "planar" };
    case 2: return { ...fields, type: "patch" };
    case 3: return { ...fields, type: "triangles" };
    case 4: return { ...fields, type: "flare" };
    default: throw new BinaryError(reader.source, typeOffset, `unknown BSP surface type ${type}`);
  }
}

/** Parse the stored map data; renderer overbright shifts and collision bounds expansion are separate operations. */
export function parseBsp(data: Uint8Array, source = "<bsp>"): BspMap {
  const reader = new BinaryReader(data, source);
  if (reader.u32() !== 0x50534249) throw new BinaryError(source, 0, "expected IBSP magic");
  if (reader.i32() !== 46) throw new BinaryError(source, 4, "expected BSP version 46");
  const lumps: Lump[] = [];
  for (let index = 0; index < 17; index++) {
    const offset = reader.i32();
    const length = reader.i32();
    if (offset < 0 || length < 0 || offset > data.length - length || (length > 0 && offset < HEADER_SIZE)) {
      throw new BinaryError(source, 8 + index * 8, `invalid lump ${index} range ${offset}+${length}`);
    }
    lumps.push({ offset, length });
  }
  function lump(index: number): Lump {
    const value = lumps[index];
    if (value === undefined) throw new RangeError(`unknown BSP lump ${index}`);
    return value;
  }
  function records<T>(index: number, stride: number, read: (input: BinaryReader) => T): T[] {
    const section = lump(index);
    if (section.length % stride !== 0) {
      throw new BinaryError(source, section.offset, `lump ${index} length ${section.length} is not a multiple of ${stride}`);
    }
    reader.seek(section.offset);
    const result: T[] = [];
    for (let index = 0; index < section.length / stride; index++) result.push(read(reader));
    return result;
  }
  reader.seek(lump(0).offset);
  const entities = string(reader, lump(0).length);
  const shaders = records<BspShader>(1, 72, r => ({ name: string(r, 64), surfaceFlags: r.i32(), contentFlags: r.i32() }));
  const planes = records<BspPlane>(2, 16, r => ({ normal: vec3(r), distance: r.finiteF32() }));
  const nodes = records<BspNode>(3, 36, r => ({ plane: r.i32(), children: [r.i32(), r.i32()], bounds: { min: intVec3(r), max: intVec3(r) } }));
  const leaves = records<BspLeaf>(4, 48, r => ({
    cluster: r.i32(), area: r.i32(), bounds: { min: intVec3(r), max: intVec3(r) },
    firstSurface: r.i32(), surfaceCount: r.i32(), firstBrush: r.i32(), brushCount: r.i32(),
  }));
  const leafSurfaces = records(5, 4, r => r.i32());
  const leafBrushes = records(6, 4, r => r.i32());
  const models = records<BspModel>(7, 40, r => ({
    bounds: { min: vec3(r), max: vec3(r) }, firstSurface: r.i32(), surfaceCount: r.i32(),
    firstBrush: r.i32(), brushCount: r.i32(),
  }));
  const brushes = records<BspBrush>(8, 12, r => ({ firstSide: r.i32(), sideCount: r.i32(), shader: r.i32() }));
  const brushSides = records<BspBrushSide>(9, 8, r => ({ plane: r.i32(), shader: r.i32() }));
  const vertices = records<BspVertex>(10, 44, r => ({
    position: vec3(r), texCoord: vec2(r), lightmapCoord: { x: r.f32(), y: r.f32() }, normal: vec3(r),
    color: { x: r.u8(), y: r.u8(), z: r.u8(), w: r.u8() },
  }));
  const indices = records(11, 4, r => r.i32());
  const fogs = records<BspFog>(12, 72, r => ({ shader: string(r, 64), brush: r.i32(), visibleSide: r.i32() }));
  const surfaces = records(13, 104, surface);
  const lightmaps = records(14, LIGHTMAP_SIZE, r => r.bytes(LIGHTMAP_SIZE));
  const lightGrid = records<BspLightGridPoint>(15, 8, r => ({ ambient: byteVec3(r), directed: byteVec3(r), latLong: { x: r.u8(), y: r.u8() } }));
  const visibilityLump = lump(16);
  let visibility: BspVisibility | null = null;
  if (visibilityLump.length !== 0) {
    reader.seek(visibilityLump.offset);
    if (visibilityLump.length < 8) throw new BinaryError(source, reader.offset, "truncated visibility header");
    const clusterCount = reader.i32();
    const bytesPerCluster = reader.i32();
    if (clusterCount < 0 || bytesPerCluster < Math.ceil(clusterCount / 8)
      || clusterCount * bytesPerCluster !== visibilityLump.length - 8) {
      throw new BinaryError(source, visibilityLump.offset, "invalid visibility dimensions");
    }
    visibility = { clusterCount, bytesPerCluster, bits: reader.bytes(visibilityLump.length - 8) };
  }
  function fail(offset: number, message: string): never { throw new BinaryError(source, offset, message); }
  function reference(value: number, count: number, offset: number, name: string): void {
    if (value < 0 || value >= count) fail(offset, `${name} index ${value} outside 0..${count - 1}`);
  }
  function range(first: number, count: number, total: number, offset: number, name: string): void {
    if (first < 0 || count < 0 || first > total - count) fail(offset, `${name} range ${first}+${count} exceeds ${total}`);
  }
  for (const [index, node] of nodes.entries()) {
    const offset = lump(3).offset + index * 36;
    reference(node.plane, planes.length, offset, "node plane");
    for (const [side, child] of node.children.entries()) {
      reference(child < 0 ? -child - 1 : child, child < 0 ? leaves.length : nodes.length, offset + 4 + side * 4, "node child");
    }
  }
  // Iterative depth-first traversal checks disconnected nodes too, without a stack-depth limit.
  const visited = new Uint8Array(nodes.length);
  const stack: { node: number; exiting: boolean }[] = [];
  for (let root = 0; root < nodes.length; root++) {
    if (visited[root] === 2) continue;
    stack.push({ node: root, exiting: false });
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.exiting) { visited[current.node] = 2; continue; }
      if (visited[current.node] === 1) fail(lump(3).offset + current.node * 36, "cycle in BSP nodes");
      if (visited[current.node] === 2) continue;
      visited[current.node] = 1;
      const node = nodes[current.node];
      if (node === undefined) fail(lump(3).offset, "missing BSP node");
      stack.push({ node: current.node, exiting: true });
      for (const child of node.children) if (child >= 0) stack.push({ node: child, exiting: false });
    }
  }
  for (const [index, leaf] of leaves.entries()) {
    const offset = lump(4).offset + index * 48;
    if (leaf.cluster < -1 || (visibility !== null && leaf.cluster >= visibility.clusterCount)) fail(offset, "invalid leaf cluster");
    if (leaf.area < -1) fail(offset + 4, "invalid leaf area");
    range(leaf.firstSurface, leaf.surfaceCount, leafSurfaces.length, offset + 32, "leaf surfaces");
    range(leaf.firstBrush, leaf.brushCount, leafBrushes.length, offset + 40, "leaf brushes");
  }
  for (const [index, value] of leafSurfaces.entries()) reference(value, surfaces.length, lump(5).offset + index * 4, "leaf surface");
  for (const [index, value] of leafBrushes.entries()) reference(value, brushes.length, lump(6).offset + index * 4, "leaf brush");
  for (const [index, model] of models.entries()) {
    const offset = lump(7).offset + index * 40;
    range(model.firstSurface, model.surfaceCount, surfaces.length, offset + 24, "model surfaces");
    range(model.firstBrush, model.brushCount, brushes.length, offset + 32, "model brushes");
  }
  for (const [index, brush] of brushes.entries()) {
    const offset = lump(8).offset + index * 12;
    range(brush.firstSide, brush.sideCount, brushSides.length, offset, "brush sides");
    reference(brush.shader, shaders.length, offset + 8, "brush shader");
  }
  for (const [index, side] of brushSides.entries()) {
    reference(side.plane, planes.length, lump(9).offset + index * 8, "brush side plane");
    reference(side.shader, shaders.length, lump(9).offset + index * 8 + 4, "brush side shader");
  }
  for (const [index, fog] of fogs.entries()) {
    const offset = lump(12).offset + index * 72;
    reference(fog.brush, brushes.length, offset + 64, "fog brush");
    const brush = brushes[fog.brush];
    if (brush === undefined) fail(offset + 64, "missing fog brush");
    if (fog.visibleSide !== -1) reference(fog.visibleSide, brush.sideCount, offset + 68, "fog visible side");
  }
  const lightmapUse = new Uint8Array(vertices.length);
  for (const [index, item] of surfaces.entries()) {
    const offset = lump(13).offset + index * 104;
    reference(item.shader, shaders.length, offset, "surface shader");
    // Retail mpteam1 stores zero in 277 flare fog fields despite an empty fog lump.
    const retailFlareFog = item.type === "flare" && item.fog === 0 && fogs.length === 0;
    if (item.fog !== -1 && !retailFlareFog) reference(item.fog, fogs.length, offset + 4, "surface fog");
    range(item.firstVertex, item.vertexCount, vertices.length, offset + 12, "surface vertices");
    range(item.firstIndex, item.indexCount, indices.length, offset + 20, "surface indices");
    // R_FindShader falls back to vertex lighting for missing lightmaps, including retail texturegrab.
    const usesLightmap = (item.type === "planar" || item.type === "patch")
      && item.lightmap >= 0 && item.lightmap < lightmaps.length;
    if (item.type === "planar" || item.type === "patch") {
      if (item.lightmap < -4) fail(offset + 28, "invalid lightmap sentinel");
    }
    for (let index = item.firstVertex; index < item.firstVertex + item.vertexCount; index++) {
      if (usesLightmap) lightmapUse[index] = 2;
      else if (lightmapUse[index] !== 2) lightmapUse[index] = 1;
    }
    if (item.type === "patch") {
      if (item.patchWidth < 3 || item.patchHeight < 3 || item.patchWidth % 2 !== 1 || item.patchHeight % 2 !== 1
        || item.patchWidth * item.patchHeight !== item.vertexCount) fail(offset + 96, "invalid patch control grid");
    }
    if ((item.type === "planar" || item.type === "triangles") && item.indexCount % 3 !== 0) fail(offset + 24, "triangle index count is not a multiple of 3");
    for (let index = item.firstIndex; index < item.firstIndex + item.indexCount; index++) {
      const value = indices[index];
      if (value === undefined) fail(lump(11).offset + index * 4, "missing surface index");
      reference(value, item.vertexCount, lump(11).offset + index * 4, "surface local vertex");
    }
  }
  // mpterra3 has NaN lightmap UVs on patches with lightmap=-1. Preserve unused
  // bytes, while rejecting non-finite coordinates used for actual lightmap sampling.
  for (const [index, vertex] of vertices.entries()) {
    if (lightmapUse[index] === 1) continue;
    if (!Number.isFinite(vertex.lightmapCoord.x)) fail(lump(10).offset + index * 44 + 20, "non-finite lightmap coordinate");
    if (!Number.isFinite(vertex.lightmapCoord.y)) fail(lump(10).offset + index * 44 + 24, "non-finite lightmap coordinate");
  }
  return { entities, entityRecords: parseEntities(entities, `${source}:entities`), shaders, planes, nodes, leaves,
    leafSurfaces, leafBrushes, models, brushes, brushSides, vertices, indices, fogs,
    surfaces, lightmaps, lightGrid, visibility };
}
