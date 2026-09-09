// Translated from id Software's GPL-2.0-or-later renderer/tr_bsp.c and tr_surface.c.
import { add3, dot3, length3, scale3, sub3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { insertPatchStrip, TemporaryPatchMesh } from "./patch.ts";
import type { PatchMesh } from "./patch.ts";

export interface PatchGrid {
  readonly mesh: PatchMesh;
  readonly lodOrigin: Vec3;
  readonly lodRadius: number;
}

interface PreparingPatchGrid extends PatchGrid {
  readonly mesh: PatchMesh & { readonly widthLodError: number[]; readonly heightLodError: number[] };
  lodFixed: number;
  lodStitched: boolean;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`patch LOD index ${index} outside ${values.length}`);
  return value;
}

/** ParseMesh stores the shared curve-group volume from lightmapVecs[0..1]. */
export function createPatchGrid(mesh: PatchMesh, bounds: readonly [Vec3, Vec3]): PatchGrid {
  const lodOrigin = scale3(add3(bounds[0], bounds[1]), 0.5);
  const lodRadius = length3(sub3(bounds[0], lodOrigin));
  if (mesh instanceof TemporaryPatchMesh) { mesh.setLodVolume(lodOrigin, lodRadius); return mesh; }
  return { mesh, lodOrigin, lodRadius };
}

type Direction = "width" | "height";
interface Edge {
  readonly direction: Direction;
  readonly boundary: number;
  readonly count: number;
  readonly offset: number;
  readonly stride: number;
  readonly errors: readonly number[];
}

function edges(mesh: PatchMesh): readonly Edge[] {
  return [
    { direction: "width", boundary: 0, count: mesh.width, offset: 0, stride: 1, errors: mesh.widthLodError },
    { direction: "width", boundary: mesh.height - 1, count: mesh.width, offset: (mesh.height - 1) * mesh.width, stride: 1, errors: mesh.widthLodError },
    { direction: "height", boundary: 0, count: mesh.height, offset: 0, stride: mesh.width, errors: mesh.heightLodError },
    { direction: "height", boundary: mesh.width - 1, count: mesh.height, offset: mesh.width - 1, stride: mesh.width, errors: mesh.heightLodError },
  ];
}

function point(mesh: PatchMesh, edge: Edge, index: number): Vec3 {
  return at(mesh.vertices, edge.offset + edge.stride * index).position;
}

function matches(a: Vec3, b: Vec3): boolean {
  return Math.abs(Math.fround(a.x - b.x)) <= 0.1 && Math.abs(Math.fround(a.y - b.y)) <= 0.1
    && Math.abs(Math.fround(a.z - b.z)) <= 0.1;
}

function merged(mesh: PatchMesh, edge: Edge): boolean {
  for (let i = 1; i < edge.count - 1; i++) for (let j = i + 1; j < edge.count - 1; j++) {
    if (matches(point(mesh, edge, i), point(mesh, edge, j))) return true;
  }
  return false;
}

function sameGroup(a: Pick<PatchGrid, "lodOrigin" | "lodRadius">, b: PatchGrid): boolean {
  return a.lodRadius === b.lodRadius && a.lodOrigin.x === b.lodOrigin.x
    && a.lodOrigin.y === b.lodOrigin.y && a.lodOrigin.z === b.lodOrigin.z;
}

/** R_StitchPatches searches forward width, forward height, reverse width, reverse height. */
function stitch(source: PatchMesh, target: PatchMesh): PatchMesh | null {
  const targetEdges = edges(target);
  for (const reversed of [false, true]) for (const sourceEdge of edges(source)) {
    if (merged(source, sourceEdge)) continue;
    for (let k = reversed ? sourceEdge.count - 1 : 0; reversed ? k > 1 : k < sourceEdge.count - 2; k += reversed ? -2 : 2) {
      const next = k + (reversed ? -2 : 2), middle = k + (reversed ? -1 : 1);
      for (const targetEdge of targetEdges) {
        if (targetEdge.count >= 65) continue;
        for (let l = 0; l < targetEdge.count - 1; l++) {
          const a = point(target, targetEdge, l), b = point(target, targetEdge, l + 1);
          if (!matches(point(source, sourceEdge, k), a) || !matches(point(source, sourceEdge, next), b)) continue;
          if (Math.abs(Math.fround(a.x - b.x)) < 0.01 && Math.abs(Math.fround(a.y - b.y)) < 0.01
            && Math.abs(Math.fround(a.z - b.z)) < 0.01) continue;
          // Compatibility repair for native UB only: the first reverse segment reads k+1 outside
          // its allocation. Use the matched triple's actual midpoint k-1 there. Preserve the
          // source's k+1 lookup for every in-bounds segment, including reversed segments.
          const errorIndex = reversed && k + 1 === sourceEdge.count ? middle : k + 1;
          const error = at(sourceEdge.errors, errorIndex);
          return insertPatchStrip(target, targetEdge.direction, l + 1, targetEdge.boundary,
            point(source, sourceEdge, middle), error);
        }
      }
    }
  }
  return null;
}

/** R_StitchAllPatches then R_FixSharedVertexLodError, in BSP surface order. */
export function preparePatchGrids(input: readonly PatchGrid[], onStitched: (count: number) => void = () => undefined,
  onReplaced: (index: number, grid: PatchGrid) => void = () => undefined): readonly PatchGrid[] {
  const grids: PreparingPatchGrid[] = input.map(grid => grid.mesh instanceof TemporaryPatchMesh ? grid.mesh : { ...grid, lodFixed: 0, lodStitched: false,
    mesh: { ...grid.mesh, widthLodError: [...grid.mesh.widthLodError], heightLodError: [...grid.mesh.heightLodError] } });
  let stitchCount = 0;
  let visited: boolean;
  do {
    visited = false;
    for (let i = 0; i < grids.length; i++) {
      if (at(grids, i).lodStitched) continue;
      at(grids, i).lodStitched = true; visited = true;
      // The source retains grid1 after self-stitch frees it. Preserve its LOD volume
      // explicitly instead of reading the poisoned or reused allocation.
      const group = { lodOrigin: { ...at(grids, i).lodOrigin }, lodRadius: at(grids, i).lodRadius };
      for (let j = 0; j < grids.length; j++) {
        if (!sameGroup(group, at(grids, j))) continue;
        for (;;) {
          const target = at(grids, j), mesh = stitch(at(grids, i).mesh, target.mesh);
          if (mesh === null) break;
          grids[j] = mesh instanceof TemporaryPatchMesh ? mesh : { ...target, lodFixed: 0, lodStitched: false,
            mesh: { ...mesh, widthLodError: [...mesh.widthLodError], heightLodError: [...mesh.heightLodError] } };
          onReplaced(j, at(grids, j));
          stitchCount = (stitchCount + 1) | 0;
        }
      }
    }
  } while (visited);
  onStitched(stitchCount);

  function synchronize(start: number, sourceIndex: number): void {
    const source = at(grids, sourceIndex);
    for (let j = start; j < grids.length; j++) {
      const target = at(grids, j);
      if (target.lodFixed === 2 || !sameGroup(source, target)) continue;
      let touch = false;
      for (const sourceEdge of edges(source.mesh)) {
        if (merged(source.mesh, sourceEdge)) continue;
        for (let k = 1; k < sourceEdge.count - 1; k++) for (const targetEdge of edges(target.mesh)) {
          if (merged(target.mesh, targetEdge)) continue;
          for (let l = 1; l < targetEdge.count - 1; l++) {
            if (!matches(point(source.mesh, sourceEdge, k), point(target.mesh, targetEdge, l))) continue;
            const errors = targetEdge.direction === "width" ? target.mesh.widthLodError : target.mesh.heightLodError;
            errors[l] = at(sourceEdge.errors, k); touch = true;
          }
        }
      }
      if (touch) { target.lodFixed = 2; synchronize(start, j); }
    }
  }
  for (let i = 0; i < grids.length; i++) {
    if (at(grids, i).lodFixed !== 0) continue;
    at(grids, i).lodFixed = 2; synchronize(i + 1, i);
  }
  return grids;
}

/** LodErrorForVolume and RB_SurfaceGrid's row/column selection; batching remains the tess owner's job. */
export function selectPatchLod(grid: PatchGrid, worldLodOrigin: Vec3, viewOrigin: Vec3, viewForward: Vec3,
  lodCurveError: number): PatchMesh {
  let distance = dot3(sub3(worldLodOrigin, viewOrigin), viewForward);
  if (distance < 0) distance = -distance;
  distance = Math.fround(distance - grid.lodRadius);
  if (distance < 1) distance = 1;
  const error = lodCurveError < 0 ? 0 : Math.fround(lodCurveError / distance);
  const mesh = grid.mesh;
  function selected(errors: readonly number[]): number[] {
    const result = [0];
    for (let i = 1; i < errors.length - 1; i++) {
      const candidate = at(errors, i);
      if (candidate <= error) result.push(i);
    }
    result.push(errors.length - 1);
    return result;
  }
  const columns = selected(mesh.widthLodError), rows = selected(mesh.heightLodError);
  if (columns.length === mesh.width && rows.length === mesh.height) return mesh;
  const vertices = rows.flatMap(y => columns.map(x => at(mesh.vertices, y * mesh.width + x)));
  const indices: number[] = [];
  for (let y = 0; y < rows.length - 1; y++) for (let x = 0; x < columns.length - 1; x++) {
    const a = y * columns.length + x, b = a + columns.length;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { width: columns.length, height: rows.length, vertices, indices,
    widthLodError: columns.map(x => at(mesh.widthLodError, x)), heightLodError: rows.map(y => at(mesh.heightLodError, y)) };
}
