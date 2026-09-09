import type { DrawBatch, SingleTextureBatch } from "../src/render/types.ts";

/** Inspect RB_StretchPic's emitted quads without changing backend submissions. */
export function pictureQuads(batches: readonly DrawBatch[]): readonly SingleTextureBatch[] {
  const quads: SingleTextureBatch[] = [];
  const pattern = [3, 0, 2, 2, 0, 1];
  for (const batch of batches) {
    if (batch.texturing !== "single" || batch.primitive !== "triangles") throw new Error("Picture inspection requires single-texture triangles");
    if (batch.indices.length === 0 || batch.indices.length % 6 !== 0) throw new Error("Picture inspection requires complete emitted quads");
    const first = batch.indices[1];
    if (first === undefined || !Number.isInteger(first) || first < 0) throw new Error("Invalid picture vertex prefix");
    // RB_EndSurface preserves numVertexes. Only indexed vertices belong to this
    // emission; a prior finish can leave an unreferenced prefix in the array.
    if (first + batch.indices.length / 6 * 4 !== batch.vertices.length) throw new Error("Picture vertices do not match the emitted quad span");
    for (let offset = 0; offset < batch.indices.length; offset += 6) {
      const base = first + offset / 6 * 4;
      for (const [component, relative] of pattern.entries()) {
        if (batch.indices[offset + component] !== base + relative) throw new Error("Picture indices do not match RB_StretchPic order");
      }
      const a = batch.vertices[base], b = batch.vertices[base + 1], c = batch.vertices[base + 2], d = batch.vertices[base + 3];
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("Picture index outside the vertex array");
      quads.push({ ...batch, vertices: [a, b, c, d], indices: [...pattern] });
    }
  }
  return quads;
}
