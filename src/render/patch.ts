// Translated from id Software's GPL-2.0-or-later renderer/tr_curve.c.
import type { BspVertex } from "../assets/bsp.ts";
import { add3, cross3, dot3, length3, normalize3, normalize3OrZero, scale3, sub3, vec2 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { ZoneTag } from "../core/zone.ts";
import type { ZoneArena } from "../core/zone.ts";

export interface PatchMesh {
  readonly width: number;
  readonly height: number;
  readonly vertices: readonly BspVertex[];
  readonly indices: readonly number[];
  readonly widthLodError: readonly number[];
  readonly heightLodError: readonly number[];
}

export type PatchMemoryProfile =
  | { readonly kind: "diagnostic" }
  | { readonly kind: "source-zone"; readonly zone: ZoneArena };

interface PatchBlock {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly address: number;
}
interface TemporaryBlock { readonly block: PatchBlock; free(): void }

function temporaryBlock(profile: PatchMemoryProfile, length: number): TemporaryBlock {
  const allocation = profile.kind === "source-zone" ? profile.zone.allocate(length, ZoneTag.Renderer) : null;
  const data = allocation === null ? new Uint8Array(length) : allocation.bytes;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let live = true;
  const block: PatchBlock = {
    get bytes() {
      if (!live) throw new Error("Patch allocation is no longer valid");
      return allocation === null ? data : allocation.bytes;
    },
    get view() { void this.bytes; return view; },
    get address() { return this.bytes.byteOffset; },
  };
  return { block, free() {
    if (profile.kind === "source-zone") profile.zone.free(allocation);
    else void block.bytes;
    live = false;
  } };
}

function vector(block: PatchBlock, offset: number): Vec3 {
  return { get x() { return block.view.getFloat32(offset, true); },
    get y() { return block.view.getFloat32(offset + 4, true); }, get z() { return block.view.getFloat32(offset + 8, true); } };
}
function putVector(block: PatchBlock, offset: number, value: Vec3): void {
  block.view.setFloat32(offset, value.x, true); block.view.setFloat32(offset + 4, value.y, true); block.view.setFloat32(offset + 8, value.z, true);
}
function vertex(block: PatchBlock, offset: number): BspVertex {
  return { position: vector(block, offset), normal: vector(block, offset + 28),
    texCoord: { get x() { return block.view.getFloat32(offset + 12, true); }, get y() { return block.view.getFloat32(offset + 16, true); } },
    lightmapCoord: { get x() { return block.view.getFloat32(offset + 20, true); }, get y() { return block.view.getFloat32(offset + 24, true); } },
    color: { get x() { return block.view.getUint8(offset + 40); }, get y() { return block.view.getUint8(offset + 41); },
      get z() { return block.view.getUint8(offset + 42); }, get w() { return block.view.getUint8(offset + 43); } } };
}
function putVertex(block: PatchBlock, offset: number, value: BspVertex): void {
  putVector(block, offset, value.position); putVector(block, offset + 28, value.normal);
  block.view.setFloat32(offset + 12, value.texCoord.x, true); block.view.setFloat32(offset + 16, value.texCoord.y, true);
  block.view.setFloat32(offset + 20, value.lightmapCoord.x, true); block.view.setFloat32(offset + 24, value.lightmapCoord.y, true);
  block.bytes.set([value.color.x, value.color.y, value.color.z, value.color.w], offset + 40);
}
function errors(block: PatchBlock, count: number): number[] {
  const result: number[] = [];
  for (let index = 0; index < count; index++) Object.defineProperty(result, index, { enumerable: true,
    get: () => block.view.getFloat32(index * 4, true), set: (value: number) => { block.view.setFloat32(index * 4, value, true); } });
  return result;
}

/** The release32 srfGridMesh_t and its two separately allocated error arrays. */
class AllocatedPatchMesh implements PatchMesh {
  readonly vertices: readonly BspVertex[];
  readonly widthLodError: number[];
  readonly heightLodError: number[];
  readonly lodOrigin: Vec3;

  constructor(readonly block: PatchBlock, protected readonly widthBlock: PatchBlock, protected readonly heightBlock: PatchBlock,
    readonly indices: readonly number[]) {
    this.vertices = Array.from({ length: this.width * this.height }, (_, index) => vertex(block, 92 + index * 44));
    this.widthLodError = errors(widthBlock, this.width); this.heightLodError = errors(heightBlock, this.height);
    this.lodOrigin = vector(block, 52);
  }
  get mesh(): this { return this; }
  get width(): number { return this.block.view.getInt32(76, true); }
  get height(): number { return this.block.view.getInt32(80, true); }
  get lodRadius(): number { return this.block.view.getFloat32(64, true); }
  set lodRadius(value: number) { this.block.view.setFloat32(64, value, true); }
  get lodFixed(): number { return this.block.view.getInt32(68, true); }
  set lodFixed(value: number) { this.block.view.setInt32(68, value, true); }
  get lodStitched(): boolean { return this.block.view.getInt32(72, true) !== 0; }
  set lodStitched(value: boolean) { this.block.view.setInt32(72, value ? 1 : 0, true); }
  setLodVolume(origin: Vec3, radius: number): void { putVector(this.block, 52, origin); this.lodRadius = radius; }
}

/** PATCH_STITCHING uses CL_RefMalloc's TAG_RENDERER zone until the final hunk move. */
export class TemporaryPatchMesh extends AllocatedPatchMesh {
  private constructor(private readonly profile: PatchMemoryProfile,
    private readonly gridAllocation: TemporaryBlock, private readonly widthAllocation: TemporaryBlock,
    private readonly heightAllocation: TemporaryBlock, indices: readonly number[]) {
    super(gridAllocation.block, widthAllocation.block, heightAllocation.block, indices);
  }

  static create(mesh: PatchMesh, profile: PatchMemoryProfile): TemporaryPatchMesh {
    const grid = temporaryBlock(profile, 92 + mesh.width * mesh.height * 44), block = grid.block;
    block.bytes.fill(0);
    const width = temporaryBlock(profile, mesh.width * 4);
    block.view.setInt32(84, width.block.address, true);
    for (let index = 0; index < mesh.width; index++) width.block.view.setFloat32(index * 4, at(mesh.widthLodError, index), true);
    const height = temporaryBlock(profile, mesh.height * 4);
    block.view.setInt32(88, height.block.address, true);
    for (let index = 0; index < mesh.height; index++) height.block.view.setFloat32(index * 4, at(mesh.heightLodError, index), true);
    block.view.setInt32(76, mesh.width, true); block.view.setInt32(80, mesh.height, true); block.view.setInt32(0, 3, true);
    const minimum = { x: 99999, y: 99999, z: 99999 }, maximum = { x: -99999, y: -99999, z: -99999 };
    for (let x = 0; x < mesh.width; x++) for (let y = 0; y < mesh.height; y++) {
      const index = y * mesh.width + x, point = at(mesh.vertices, index);
      putVertex(block, 92 + index * 44, point);
      for (const axis of ["x", "y", "z"] satisfies readonly (keyof Vec3)[]) {
        if (point.position[axis] < minimum[axis]) minimum[axis] = point.position[axis];
        if (point.position[axis] > maximum[axis]) maximum[axis] = point.position[axis];
      }
    }
    putVector(block, 12, minimum); putVector(block, 24, maximum);
    const origin = scale3(add3(minimum, maximum), 0.5), radius = length3(sub3(minimum, origin));
    putVector(block, 36, origin); block.view.setFloat32(48, radius, true);
    const result = new TemporaryPatchMesh(profile, grid, width, height, mesh.indices);
    result.setLodVolume(origin, radius);
    return result;
  }

  replace(mesh: PatchMesh): TemporaryPatchMesh {
    const origin = { x: this.lodOrigin.x, y: this.lodOrigin.y, z: this.lodOrigin.z }, radius = this.lodRadius;
    this.free();
    const result = TemporaryPatchMesh.create(mesh, this.profile);
    result.setLodVolume(origin, radius);
    return result;
  }

  private free(): void { this.widthAllocation.free(); this.heightAllocation.free(); this.gridAllocation.free(); }

  moveToHunk(allocate: (call: string, length: number) => PatchBlock): AllocatedPatchMesh {
    const block = allocate("R_MovePatchSurfacesToHunk:grid", this.block.bytes.length);
    block.bytes.set(this.block.bytes);
    const width = allocate("R_MovePatchSurfacesToHunk:widthLodError", this.width * 4);
    width.bytes.set(this.widthBlock.bytes); block.view.setInt32(84, width.address, true);
    const height = allocate("R_MovePatchSurfacesToHunk:heightLodError", this.height * 4);
    block.view.setInt32(88, height.address, true);
    // Pinned tr_bsp.c self-copies the old height array. The new hunk array stays zeroed.
    this.heightBlock.bytes.set(this.heightBlock.bytes);
    this.free();
    return new AllocatedPatchMesh(block, width, height, this.indices);
  }
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`patch index ${index} outside ${values.length}`);
  return value;
}

function midpoint(a: BspVertex, b: BspVertex): BspVertex {
  return {
    position: scale3(add3(a.position, b.position), 0.5),
    normal: normalize3(add3(a.normal, b.normal)),
    texCoord: vec2(Math.fround(a.texCoord.x + b.texCoord.x) * 0.5, Math.fround(a.texCoord.y + b.texCoord.y) * 0.5),
    lightmapCoord: vec2(Math.fround(a.lightmapCoord.x + b.lightmapCoord.x) * 0.5, Math.fround(a.lightmapCoord.y + b.lightmapCoord.y) * 0.5),
    color: { x: (a.color.x + b.color.x) >> 1, y: (a.color.y + b.color.y) >> 1,
      z: (a.color.z + b.color.z) >> 1, w: (a.color.w + b.color.w) >> 1 },
  };
}

function transpose(rows: readonly (readonly BspVertex[])[]): BspVertex[][] {
  return at(rows, 0).map((_, x) => rows.map(row => at(row, x)));
}

/** Source adaptive quadratic subdivision, including linear-column removal and wrapped normals. */
export function tessellatePatch(points: readonly BspVertex[], width: number, height: number, subdivisions = 4): PatchMesh {
  // ParseMesh has 1024 input slots; tr_curve's working grid has 65 slots per axis.
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3
    || width > 65 || height > 65 || width * height > 1024 || width % 2 !== 1 || height % 2 !== 1 || points.length !== width * height
    || !Number.isFinite(subdivisions)) throw new RangeError("invalid quadratic patch dimensions or subdivision threshold");
  let rows = Array.from({ length: height }, (_, y) => points.slice(y * width, (y + 1) * width));
  const errors: number[][] = [];
  for (let direction = 0; direction < 2; direction++) {
    const error = new Array<number>(65).fill(0);
    errors.push(error);
    for (let x = 0; x + 2 < at(rows, 0).length; x += 2) {
      let maximum = 0;
      for (const row of rows) {
        const a = at(row, x).position, b = at(row, x + 1).position, c = at(row, x + 2).position;
        const curve = sub3(scale3(add3(add3(a, scale3(b, 2)), c), 0.25), a);
        const line = normalize3(sub3(c, a));
        const distance = sub3(curve, scale3(line, dot3(curve, line)));
        maximum = Math.max(maximum, dot3(distance, distance));
      }
      maximum = Math.fround(Math.sqrt(maximum));
      if (maximum < Math.fround(0.1)) { error[x + 1] = 999; continue; }
      if (at(rows, 0).length + 2 > 65 || maximum <= subdivisions) { error[x + 1] = Math.fround(1 / maximum); continue; }
      error[x + 2] = Math.fround(1 / maximum);
      for (const row of rows) {
        const previous = midpoint(at(row, x), at(row, x + 1));
        const next = midpoint(at(row, x + 1), at(row, x + 2));
        row.splice(x + 1, 1, previous, midpoint(previous, next), next);
      }
      x -= 2;
    }
    rows = transpose(rows);
  }
  width = at(rows, 0).length;
  height = rows.length;
  for (let x = 0; x < width; x++) {
    for (let y = 1; y < height; y += 2) {
      const row = at(rows, y), point = at(row, x);
      row[x] = midpoint(midpoint(point, at(at(rows, y + 1), x)), midpoint(point, at(at(rows, y - 1), x)));
    }
  }
  for (const row of rows) {
    for (let x = 1; x < width; x += 2) {
      const point = at(row, x);
      row[x] = midpoint(midpoint(point, at(row, x + 1)), midpoint(point, at(row, x - 1)));
    }
  }
  let widthError = at(errors, 0), heightError = at(errors, 1);
  for (let x = 1; x < width - 1; x++) {
    if (widthError[x] !== 999) continue;
    for (const row of rows) row.splice(x, 1);
    widthError.splice(x, 1); width--;
  }
  for (let y = 1; y < height - 1; y++) {
    if (heightError[y] !== 999) continue;
    rows.splice(y, 1); heightError.splice(y, 1); height--;
  }
  if (height > width) {
    rows = transpose(rows).map(row => row.reverse());
    const oldWidth = width, oldWidthError = widthError;
    width = height; height = oldWidth;
    widthError = heightError.slice(0, width).reverse();
    heightError = oldWidthError.slice(0, height);
  }
  return createMesh(rows, widthError.slice(0, width), heightError.slice(0, height));
}

/** R_GridInsertColumn / R_GridInsertRow: interpolate a strip, anchor only its matched edge, rebuild normals. */
export function insertPatchStrip(mesh: PatchMesh, direction: "width" | "height", index: number, edge: number,
  position: Vec3, lodError: number): PatchMesh {
  const width = mesh.width + (direction === "width" ? 1 : 0);
  const height = mesh.height + (direction === "height" ? 1 : 0);
  const oldSize = direction === "width" ? mesh.width : mesh.height;
  const edgeSize = direction === "width" ? mesh.height : mesh.width;
  if (width > 65 || height > 65 || !Number.isInteger(index) || index < 1 || index >= oldSize
    || !Number.isInteger(edge) || edge < 0 || edge >= edgeSize) throw new RangeError("invalid patch insertion");
  const rows = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const coordinate = direction === "width" ? x : y;
    if (coordinate !== index) {
      const oldX = x - (direction === "width" && x > index ? 1 : 0);
      const oldY = y - (direction === "height" && y > index ? 1 : 0);
      const point = at(mesh.vertices, oldY * mesh.width + oldX);
      return mesh instanceof TemporaryPatchMesh ? { position: { ...point.position }, normal: { ...point.normal },
        texCoord: { ...point.texCoord }, lightmapCoord: { ...point.lightmapCoord }, color: { ...point.color } } : point;
    }
    const next = y * mesh.width + x;
    const previous = next - (direction === "width" ? 1 : mesh.width);
    const point = midpoint(at(mesh.vertices, previous), at(mesh.vertices, next));
    return (direction === "width" ? y : x) === edge ? { ...point, position: { ...position } } : point;
  }));
  const widthError = [...mesh.widthLodError], heightError = [...mesh.heightLodError];
  (direction === "width" ? widthError : heightError).splice(index, 0, lodError);
  const result = createMesh(rows, widthError, heightError);
  return mesh instanceof TemporaryPatchMesh ? mesh.replace(result) : result;
}

function createMesh(rows: readonly (readonly BspVertex[])[], widthError: readonly number[], heightError: readonly number[]): PatchMesh {
  const width = at(rows, 0).length, height = rows.length;
  const wrapWidth = rows.every(row => dot3(sub3(at(row, 0).position, at(row, width - 1).position), sub3(at(row, 0).position, at(row, width - 1).position)) <= 1);
  const wrapHeight = at(rows, 0).every((point, x) => {
    const difference = sub3(point.position, at(at(rows, height - 1), x).position);
    return dot3(difference, difference) <= 1;
  });
  const neighbors: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
  const vertices = rows.flatMap((row, y) => row.map((point, x) => {
    const around = neighbors.map(([dx, dy]) => {
      for (let distance = 1; distance <= 3; distance++) {
        let nx = x + dx * distance, ny = y + dy * distance;
        if (wrapWidth) { if (nx < 0) nx = width - 1 + nx; else if (nx >= width) nx = 1 + nx - width; }
        if (wrapHeight) { if (ny < 0) ny = height - 1 + ny; else if (ny >= height) ny = 1 + ny - height; }
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
        const delta = sub3(at(at(rows, ny), nx).position, point.position);
        if (length3(delta) !== 0) return normalize3OrZero(delta);
      }
      return null;
    });
    let normal = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 8; k++) {
      const a = at(around, k), b = at(around, (k + 1) & 7);
      if (a !== null && b !== null) {
        const cross = cross3(b, a);
        if (length3(cross) !== 0) normal = add3(normal, normalize3OrZero(cross));
      }
    }
    return { ...point, normal: normalize3OrZero(normal) };
  }));
  const indices: number[] = [];
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const a = y * width + x, b = a + width;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { width, height, vertices, indices, widthLodError: widthError, heightLodError: heightError };
}
