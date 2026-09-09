// R_AddEdgeDef, R_RenderShadowEdges, RB_ShadowTessEnd and RB_ShadowFinish
// from id Software renderer/tr_shadows.c. Copyright (C) 1999-2005 Id Software, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { cross3, dot3, sub3, transformVec4, vec3, vec4 } from "../core/math.ts";
import type { Mat4, Vec3, Vec4 } from "../core/math.ts";
import type { SourceTessState } from "./tess-state.ts";

export type StencilShadowGeometry =
  | { readonly kind: "empty" }
  | { readonly kind: "source-vertex-limit" }
  | { readonly kind: "volume"; readonly positions: readonly Vec3[]; readonly indices: readonly number[] };

interface EdgeDef { readonly end: number; readonly facing: boolean }
const f = Math.fround;

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError("Stencil shadow index is outside its source array");
  return value;
}

/** Renderer-lived numEdgeDefs/edgeDefs. Only active starts are cleared per draw. */
export class ShadowEdgeState {
  private readonly edges: EdgeDef[][] = Array.from({ length: 1000 }, () => []);

  build(tess: SourceTessState): StencilShadowGeometry {
    if (tess.numIndexes === 0) return { kind: "empty" };
    const count = tess.numVertexes;
    if (count >= 500) return { kind: "source-vertex-limit" };
    const input = tess.snapshotGeometry(), indices = input.indices;
    if (indices.length >= 6000 || indices.length % 3 !== 0) throw new RangeError("Stencil shadow needs a complete source tessellation index array");
    const positions = input.vertices.map(vertex => vec3(vertex.position.x, vertex.position.y, vertex.position.z));
    const direction = tess.context.lighting.lightDir, lightDir = vec3(direction.x, direction.y, direction.z);
    for (const position of [...positions, lightDir]) {
      if (![position.x, position.y, position.z].every(Number.isFinite)) throw new RangeError("Stencil shadow inputs must be finite float32 vectors");
    }
    for (let index = 0; index < count; index++) {
      const position = at(positions, index);
      const extruded = vec3(position.x + f(-512 * lightDir.x), position.y + f(-512 * lightDir.y), position.z + f(-512 * lightDir.z));
      if (![extruded.x, extruded.y, extruded.z].every(Number.isFinite)) throw new RangeError("Stencil shadow extrusion exceeds finite float32 coordinates");
      positions.push(extruded);
    }
    // Triangle indexes can read the XYZ cells this write just replaced.
    tess.writeShadowPositions(positions);
    for (let index = 0; index < count; index++) at(this.edges, index).length = 0;
    for (let offset = 0; offset < indices.length; offset += 3) {
      const i1 = at(indices, offset), i2 = at(indices, offset + 1), i3 = at(indices, offset + 2);
      const v1 = tess.allocatedVertex(i1).position, v2 = tess.allocatedVertex(i2).position, v3 = tess.allocatedVertex(i3).position;
      const facing = dot3(cross3(sub3(v2, v1), sub3(v3, v1)), lightDir) > 0;
      this.addEdge(i1, i2, facing); this.addEdge(i2, i3, facing); this.addEdge(i3, i1, facing);
    }
    const retainedPositions = new Map<number, number>();
    const outputIndex = (index: number): number => {
      if (index < count * 2) return index;
      const previous = retainedPositions.get(index);
      if (previous !== undefined) return previous;
      const position = tess.allocatedVertex(index).position;
      if (![position.x, position.y, position.z].every(Number.isFinite)) throw new RangeError("Stencil shadow endpoint must be a finite float32 vector");
      const output = positions.length;
      positions.push(position);
      retainedPositions.set(index, output);
      return output;
    };
    const silhouette: number[] = [];
    for (let start = 0; start < count; start++) for (const edge of at(this.edges, start)) {
      if (!edge.facing || at(this.edges, edge.end).some(reverse => reverse.end === start && reverse.facing)) continue;
      const end = outputIndex(edge.end), extrudedEnd = outputIndex(edge.end + count);
      // Source strip order is original-start, extruded-start, original-end, extruded-end.
      silhouette.push(start, start + count, end, end, start + count, extrudedEnd);
    }
    return { kind: "volume", positions, indices: silhouette };
  }

  private addEdge(start: number, end: number, facing: boolean): void {
    const definitions = at(this.edges, start);
    if (definitions.length < 32) definitions.push({ end, facing });
  }
}

/** RB_ShadowFinish loads identity modelview and retains the view projection. */
export function stencilShadowFinishVertices(projection: Mat4): readonly [Vec4, Vec4, Vec4, Vec4] {
  return [transformVec4(projection, vec4(-100, 100, -10, 1)), transformVec4(projection, vec4(100, 100, -10, 1)),
    transformVec4(projection, vec4(100, -100, -10, 1)), transformVec4(projection, vec4(-100, -100, -10, 1))];
}
