import type { BspMap, BspSurface, BspVertex } from "../src/assets/bsp.ts";
import { vec2, vec3, type Vec3 } from "../src/core/math.ts";
import { BspMarkProjector, type MarkGeometry, type MarkSurface } from "../src/render/marks.ts";

export function markVertex(position: Vec3): BspVertex {
  return { position, normal: vec3(0, 0, 1), texCoord: vec2(0, 0), lightmapCoord: vec2(0, 0), color: { x: 255, y: 255, z: 255, w: 255 } };
}
export function faceMarkSurface(z = 0): MarkSurface {
  return { kind: "face", surfaceFlags: 0, contentFlags: 1, plane: { normal: vec3(0, 0, 1), distance: z },
    vertices: [markVertex(vec3(-32, -32, z)), markVertex(vec3(32, -32, z)), markVertex(vec3(-32, 32, z)), markVertex(vec3(32, 32, z))], indices: [0, 2, 1, 1, 2, 3] };
}
export function markGeometry(surfaces: readonly MarkSurface[] = [faceMarkSurface()]): MarkGeometry & { readonly map: BspMap } {
  const fields: BspSurface = { type: "planar", shader: 0, fog: -1, firstVertex: 0, vertexCount: 4, firstIndex: 0, indexCount: 6, lightmap: -1, lightmapX: 0, lightmapY: 0, lightmapWidth: 0, lightmapHeight: 0, lightmapOrigin: vec3(0, 0, 0), lightmapVectors: [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 1)], patchWidth: 0, patchHeight: 0 };
  const map: BspMap = { entities: "", entityRecords: [], shaders: [], planes: [], nodes: [], leaves: [{ cluster: 0, area: 0, bounds: { min: vec3(-100, -100, -100), max: vec3(100, 100, 100) }, firstSurface: 0, surfaceCount: surfaces.length, firstBrush: 0, brushCount: 0 }], leafSurfaces: surfaces.map((_, index) => index), leafBrushes: [], models: [], brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: surfaces.map(() => fields), lightmaps: [], lightGrid: [], visibility: null };
  return { map, surfaces };
}
export function markProjector(surfaces?: readonly MarkSurface[]): BspMarkProjector { return new BspMarkProjector(markGeometry(surfaces)); }
export function markSquare(z = 1): readonly Vec3[] { return [vec3(-8, -8, z), vec3(-8, 8, z), vec3(8, 8, z), vec3(8, -8, z)]; }
