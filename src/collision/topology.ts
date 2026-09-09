/* BSP topology and area connectivity translated from id Software's cm_test.c,
 * cm_load.c and q_math.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
import type { Bounds, Vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import { dot3, vec3 } from "../core/math.ts";
import { CollisionCounters } from "./counters.ts";
import type { CollisionBrush, CollisionMapData, CollisionPlane, CollisionPortalCounts } from "./map-resource.ts";

export interface BoxLeafList {
  readonly leaves: readonly number[];
  /** First node split by the bounds, or null when the query follows one branch. */
  readonly topnode: number | null;
  /** Last non-solid leaf visited, including leaves omitted after overflow. */
  readonly lastLeaf: number;
  readonly overflowed: boolean;
}

/** Borrowed CM_ClusterPVS pointer; offsets may cross rows within stored visibility bytes. */
export interface SourceClusterPVS {
  byteAt(offset: number): number;
}
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`collision topology index ${index} out of range`);
  return value;
}
function finite(point: Vec3): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z); }
function boxSide(bounds: Bounds, plane: CollisionPlane): 0 | 1 | 2 | 3 {
  const normal = plane.normal;
  if (plane.type === 0) return plane.distance <= bounds.min.x ? 1 : plane.distance >= bounds.max.x ? 2 : 3;
  if (plane.type === 1) return plane.distance <= bounds.min.y ? 1 : plane.distance >= bounds.max.y ? 2 : 3;
  if (plane.type === 2) return plane.distance <= bounds.min.z ? 1 : plane.distance >= bounds.max.z ? 2 : 3;
  const signs = plane.signbits;
  const far = signs < 8 ? dot3(normal, {
    x: (signs & 1) !== 0 ? bounds.min.x : bounds.max.x,
    y: (signs & 2) !== 0 ? bounds.min.y : bounds.max.y,
    z: (signs & 4) !== 0 ? bounds.min.z : bounds.max.z,
  }) : 0;
  const near = signs < 8 ? dot3(normal, {
    x: (signs & 1) !== 0 ? bounds.max.x : bounds.min.x,
    y: (signs & 2) !== 0 ? bounds.max.y : bounds.min.y,
    z: (signs & 4) !== 0 ? bounds.max.z : bounds.min.z,
  }) : 0;
  return far >= plane.distance ? near < plane.distance ? 3 : 1 : near < plane.distance ? 2 : 0;
}

export class CollisionTopology {
  readonly #map: CollisionMapData;
  readonly areaCount: number;
  readonly clusterCount: number;
  readonly #portals: CollisionPortalCounts;
  readonly #visibilityRowBytes: number | null;
  #floodValid = 0;
  #noAreas = false;

  constructor(map: CollisionMapData, private readonly counters = new CollisionCounters()) {
    this.#map = map;
    this.areaCount = map.areas.length;
    this.clusterCount = map.clusterCount;
    this.#portals = map.portals;
    this.#visibilityRowBytes = map.visibilityRowBytes;
    this.#floodAreas();
  }

  pointLeafnum(point: Vec3): number {
    if (!finite(point)) throw new RangeError("point leaf query requires finite coordinates");
    if (this.#map.nodes.length === 0) return 0;
    let index = 0;
    while (index >= 0) {
      const node = at(this.#map.nodes, index), plane = at(this.#map.planes, node.plane);
      const distance = Math.fround((plane.type === 0 ? point.x : plane.type === 1 ? point.y
        : plane.type === 2 ? point.z : dot3(point, plane.normal)) - plane.distance);
      index = node.children[distance < 0 ? 1 : 0];
    }
    this.counters.c_pointcontents = (this.counters.c_pointcontents + 1) | 0;
    return -1 - index;
  }

  boxLeafnums(bounds: Bounds, maxLeaves = 1024): BoxLeafList {
    if (!finite(bounds.min) || !finite(bounds.max) || bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z) throw new RangeError("box leaf query requires finite ordered bounds");
    if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 0) throw new RangeError("leaf capacity must be a nonnegative integer");
    this.#map.checkCount = (this.#map.checkCount + 1) | 0;
    const leaves: number[] = [];
    let lastLeaf = 0, overflowed = false;
    const topnode = this.#walkBounds(bounds, leafnum => {
      if (at(this.#map.leaves, leafnum).cluster !== -1) lastLeaf = leafnum;
      if (leaves.length === maxLeaves) overflowed = true;
      else leaves.push(leafnum);
    });
    return { leaves, topnode, lastLeaf, overflowed };
  }

  /** CM_BoxBrushes returns borrowed brush pointers, including their mutable checkcount. */
  boxBrushes(bounds: Bounds, maxBrushes = 1024): readonly CollisionBrush[] {
    if (!Number.isInteger(maxBrushes) || maxBrushes < -0x80000000 || maxBrushes > 0x7fffffff) throw new RangeError("brush capacity must be a source signed integer");
    const map = this.#map;
    map.checkCount = (map.checkCount + 1) | 0;
    const query = { min: vec3(bounds.min.x, bounds.min.y, bounds.min.z), max: vec3(bounds.max.x, bounds.max.y, bounds.max.z) };
    const brushes: CollisionBrush[] = [];
    this.#walkBounds(query, leafnum => {
      const leaf = at(map.leaves, leafnum);
      for (let index = 0; index < leaf.brushCount; index++) {
        const brush = at(map.brushes, map.leafBrushes.at(leaf.firstBrush + index));
        if (brush.checkCount === map.checkCount) continue;
        brush.checkCount = map.checkCount;
        const brushBounds = brush.bounds;
        if (brushBounds.min.x >= query.max.x || brushBounds.max.x <= query.min.x
          || brushBounds.min.y >= query.max.y || brushBounds.max.y <= query.min.y
          || brushBounds.min.z >= query.max.z || brushBounds.max.z <= query.min.z) continue;
        // CM_StoreBrushes stops only this leaf; the BSP walker continues its siblings.
        if (brushes.length >= maxBrushes) return;
        brushes.push(brush);
      }
    });
    return brushes;
  }

  /** CM_BoxLeafnums_r dispatches either CM_StoreLeafs or CM_StoreBrushes at each leaf. */
  #walkBounds(bounds: Bounds, storeLeaf: (leafnum: number) => void): number | null {
    let topnode: number | null = null;
    const pending = [this.#map.nodes.length === 0 ? -1 : 0];
    while (pending.length !== 0) {
      const index = pending.pop();
      if (index === undefined) throw new Error("leaf traversal stack invariant");
      if (index < 0) {
        storeLeaf(-1 - index);
        continue;
      }
      const node = at(this.#map.nodes, index);
      const side = boxSide(bounds, at(this.#map.planes, node.plane));
      if (side !== 1 && side !== 2 && topnode === null) topnode = index;
      if (side !== 1) pending.push(node.children[1]);
      if (side !== 2) pending.push(node.children[0]);
    }
    return topnode;
  }

  leafArea(index: number): number {
    if (Number.isInteger(index) && (index < 0 || index >= this.#map.leaves.length)) {
      throw new CommonError("drop", "CM_LeafArea: bad number");
    }
    return at(this.#map.leaves, index).area;
  }
  leafCluster(index: number): number {
    if (Number.isInteger(index) && (index < 0 || index >= this.#map.leaves.length)) {
      throw new CommonError("drop", "CM_LeafCluster: bad number");
    }
    return at(this.#map.leaves, index).cluster;
  }

  clusterPVS(cluster: number): SourceClusterPVS {
    if (!Number.isInteger(cluster)) throw new RangeError("cluster must be an integer");
    const rowBytes = this.#visibilityRowBytes;
    const map = this.#map;
    // CM_ClusterPVS returns the allocation start for invalid clusters or no vis.
    const baseOffset = rowBytes === null || cluster < 0 || cluster >= this.clusterCount ? 0 : cluster * rowBytes;
    return {
      byteAt(offset: number): number {
        if (!Number.isSafeInteger(offset)) throw new RangeError("PVS byte offset must be a safe integer");
        const bytes = map.visibility;
        const index = baseOffset + offset, byte = bytes[index];
        if (byte === undefined) throw new RangeError(`PVS byte ${index} outside stored visibility allocation of ${bytes.length} bytes`);
        return byte;
      },
    };
  }

  clusterVisible(from: number, to: number): boolean {
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new RangeError("clusters must be integers");
    if (to < 0 || to >= this.clusterCount) return false;
    const byte = this.clusterPVS(from).byteAt(to >> 3);
    return (byte & (1 << (to & 7))) !== 0;
  }

  setNoAreas(enabled: boolean): void { this.#noAreas = enabled; }

  #checkArea(area: number): void {
    if (!Number.isInteger(area) || area < 0 || area >= this.areaCount) throw new RangeError(`invalid area ${area}`);
  }

  adjustAreaPortalState(area1: number, area2: number, open: boolean): void {
    if (!Number.isInteger(area1) || !Number.isInteger(area2)) throw new RangeError("areas must be integers");
    if (area1 < 0 || area2 < 0) return;
    if (area1 >= this.areaCount || area2 >= this.areaCount) {
      throw new CommonError("drop", "CM_ChangeAreaPortalState: bad area number");
    }
    const index1 = area1 * this.areaCount + area2, index2 = area2 * this.areaCount + area1;
    const amount = open ? 1 : -1;
    this.#portals.set(index1, (this.#portals.at(index1) + amount) | 0);
    this.#portals.set(index2, (this.#portals.at(index2) + amount) | 0);
    if (!open && this.#portals.at(index2) < 0) throw new CommonError("drop", "CM_AdjustAreaPortalState: negative reference count");
    this.#floodAreas();
  }

  #floodAreas(): void {
    const areas = this.#map.areas;
    this.#floodValid = (this.#floodValid + 1) | 0;
    let flood = 0;
    for (let area = 0; area < this.areaCount; area++) {
      if (at(areas, area).floodValid === this.#floodValid) continue;
      flood++;
      const pending = [area];
      while (pending.length !== 0) {
        const current = pending.pop();
        if (current === undefined) throw new Error("area flood stack invariant");
        const cell = at(areas, current);
        if (cell.floodValid === this.#floodValid) {
          if (cell.flood !== flood) throw new CommonError("drop", "FloodArea_r: reflooded");
          continue;
        }
        cell.flood = flood;
        cell.floodValid = this.#floodValid;
        for (let adjacent = this.areaCount - 1; adjacent >= 0; adjacent--) {
          if (this.#portals.at(current * this.areaCount + adjacent) > 0) pending.push(adjacent);
        }
      }
    }
  }

  areasConnected(area1: number, area2: number): boolean {
    if (this.#noAreas) return true;
    if (!Number.isInteger(area1) || !Number.isInteger(area2)) throw new RangeError("areas must be integers");
    if (area1 < 0 || area2 < 0) return false;
    if (area1 >= this.areaCount || area2 >= this.areaCount) throw new CommonError("drop", "area >= cm.numAreas");
    return at(this.#map.areas, area1).flood === at(this.#map.areas, area2).flood;
  }

  writeAreaBits(buffer: Uint8Array, area: number): number {
    const bytes = (this.areaCount + 7) >> 3;
    if (buffer.length < bytes) throw new RangeError(`area bits need ${bytes} bytes`);
    if (this.#noAreas || area === -1) { buffer.fill(255, 0, bytes); return bytes; }
    this.#checkArea(area);
    const flood = at(this.#map.areas, area).flood;
    for (let other = 0; other < this.areaCount; other++) {
      if (at(this.#map.areas, other).flood !== flood) continue;
      const index = other >> 3, byte = buffer[index];
      if (byte === undefined) throw new Error("area bit buffer invariant");
      buffer[index] = byte | (1 << (other & 7));
    }
    return bytes;
  }

  areaBits(area: number): Uint8Array {
    const bits = new Uint8Array((this.areaCount + 7) >> 3);
    this.writeAreaBits(bits, area);
    return bits;
  }
}
