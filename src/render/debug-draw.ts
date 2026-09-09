// DrawTris, DrawNormals and RB_EndSurface from id Software renderer/tr_shade.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, scale3 } from "../core/math.ts";
import type { Vec3, Vec4 } from "../core/math.ts";
import type { RendererImage } from "./image-resource.ts";
import type { SourceTessState } from "./tess-state.ts";
import type { RendererRuntimeSettings } from "./settings.ts";
import type { SourceDebugOperation } from "./types.ts";

/** Publish only indexed allocation reads for tris, and every active slot for normals. */
export function* snapshotSourceDebugOperations(
  tess: SourceTessState,
  project: (position: Vec3) => Vec4,
  whiteImage: RendererImage,
  runtime: Pick<RendererRuntimeSettings, "showTris" | "showNormals">,
): Generator<SourceDebugOperation, void, unknown> {
  if (runtime.showTris !== 0) {
    const geometry = tess.snapshotGeometry();
    const slots = [...new Set(geometry.indices)].sort((left, right) => left - right);
    const publishedSlots = new Map<number, number>();
    const positions = slots.map((slot, index) => {
      publishedSlots.set(slot, index);
      return { ...project(tess.allocatedVertex(slot).position) };
    });
    const indices = geometry.indices.map(slot => {
      const index = publishedSlots.get(slot);
      if (index === undefined) throw new Error("Indexed debug tess cell has no published slot");
      return index;
    });
    const scratch = slots.map(slot => {
      const source = tess.allocatedVertex(slot);
      return { color: tess.stageColor(slot), texCoord: tess.stageTexCoord(0, slot), texCoord2: tess.stageTexCoord(1, slot),
        rawTexCoord: source.texCoord, rawTexCoord2: source.lightmapCoord };
    });
    yield { kind: "debug-tris", input: { whiteImage, positions, indices, scratch,
      allocation: { kind: "tess", slots, vertexCount: tess.numVertexes } } };
  }
  if (runtime.showNormals !== 0) {
    const segments = tess.snapshotGeometry().vertices.map((vertex): readonly [Vec4, Vec4] => [
      { ...project(vertex.position) },
      { ...project(add3(vertex.position, scale3(vertex.normal, 2))) },
    ]);
    yield { kind: "debug-normals", input: { whiteImage, segments } };
  }
}
