/*
 * AAS v5 file layout and point sampling translated from id Software's
 * code/botlib/aasfile.h, be_aas_file.c and be_aas_sample.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { BinaryError, BinaryReader } from "../core/binary.ts";
import { dot3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { AasLoadedLumps } from "./aas-storage.ts";
import type { AasLump, AasLumpReader } from "./aas-storage.ts";
import { BotMemory } from "./memory.ts";

export interface AasBoundingBox {
  readonly presenceType: number;
  readonly flags: number;
  readonly bounds: Bounds;
}

export interface AasPlane {
  readonly normal: Vec3;
  readonly distance: number;
  readonly type: number;
}

export interface AasEdge { readonly vertices: readonly [number, number] }

export interface AasFace {
  readonly plane: number;
  readonly flags: number;
  readonly edgeCount: number;
  readonly firstEdge: number;
  readonly frontArea: number;
  readonly backArea: number;
}

export interface AasArea {
  readonly areaNumber: number;
  readonly faceCount: number;
  readonly firstFace: number;
  readonly bounds: Bounds;
  readonly center: Vec3;
}

export interface AasAreaSettings {
  readonly contents: number;
  readonly flags: number;
  readonly presenceType: number;
  readonly cluster: number;
  readonly clusterAreaNumber: number;
  readonly reachableAreaCount: number;
  readonly firstReachableArea: number;
}

export interface AasReachability {
  readonly area: number;
  readonly face: number;
  readonly edge: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly travelType: number;
  readonly travelTime: number;
  readonly padding: number;
}

export interface AasNode {
  readonly plane: number;
  readonly children: readonly [number, number];
}

export interface AasPortal {
  readonly area: number;
  readonly frontCluster: number;
  readonly backCluster: number;
  readonly clusterAreaNumbers: readonly [number, number];
}

export interface AasCluster {
  readonly areaCount: number;
  readonly reachabilityAreaCount: number;
  readonly portalCount: number;
  readonly firstPortal: number;
}

export interface AasWorld {
  readonly source: string;
  readonly version: 4 | 5;
  readonly bspChecksum: number;
  readonly vertices: readonly Vec3[];
  readonly planes: readonly AasPlane[];
  readonly edges: readonly AasEdge[];
  readonly edgeIndexes: readonly number[];
  readonly faces: readonly AasFace[];
  readonly faceIndexes: readonly number[];
  readonly areas: readonly AasArea[];
  readonly areaSettings: readonly AasAreaSettings[];
  readonly reachability: readonly AasReachability[];
  readonly nodes: readonly AasNode[];
  readonly portals: readonly AasPortal[];
  readonly portalIndex: readonly number[];
  readonly clusters: readonly AasCluster[];
  readonly bboxes: readonly AasBoundingBox[];
  pointArea(point: Vec3): number;
  areaReachabilities(areaNumber: number): readonly AasReachability[];
  areaBounds(areaNumber: number): Bounds;
}

const AAS_IDENT = 0x53414145;
const AAS_VERSION = 5;
const LUMP_COUNT = 14;
const HEADER_SIZE = 12 + LUMP_COUNT * 8;

const BBOXES = 0;
const VERTICES = 1;
const PLANES = 2;
const EDGES = 3;
const EDGE_INDEXES = 4;
const FACES = 5;
const FACE_INDEXES = 6;
const AREAS = 7;
const AREA_SETTINGS = 8;
const REACHABILITY = 9;
const NODES = 10;
const PORTALS = 11;
const PORTAL_INDEX = 12;
const CLUSTERS = 13;

/** Identifies records that the mutable runtime must borrow from the loaded hunk. */
export class AasLoadedWorld extends AasLoadedLumps implements AasWorld {
  constructor(data: Uint8Array, readonly source: string, readonly version: 4 | 5,
    readonly bspChecksum: number, lumps: readonly AasLump[], memory: BotMemory, reader?: AasLumpReader) {
    super(data, source, lumps, memory, reader);
  }

  pointArea(point: Vec3): number {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      throw new RangeError("AAS point must be finite");
    }
    let nodeNumber = 1;
    while (nodeNumber > 0) {
      const node = this.nodes[nodeNumber];
      if (node === undefined) throw new RangeError(`missing AAS node ${nodeNumber}`);
      const plane = this.planes[node.plane];
      if (plane === undefined) throw new RangeError(`missing AAS plane ${node.plane}`);
      const distance = Math.fround(dot3(point, plane.normal) - plane.distance);
      nodeNumber = distance > 0 ? node.children[0] : node.children[1];
    }
    return nodeNumber === 0 ? 0 : -nodeNumber;
  }

  areaReachabilities(areaNumber: number): readonly AasReachability[] {
    this.requireArea(areaNumber);
    const settings = this.areaSettings[areaNumber];
    if (settings === undefined) throw new RangeError(`missing settings for AAS area ${areaNumber}`);
    const first = settings.firstReachableArea, count = settings.reachableAreaCount;
    if (first < 0 || count < 0 || first > this.reachability.length - count) {
      throw new RangeError(`AAS area ${areaNumber} reachability range ${first}+${count} exceeds loaded storage`);
    }
    return Object.freeze(this.reachability.slice(first, first + count));
  }

  areaBounds(areaNumber: number): Bounds { return this.requireArea(areaNumber).bounds; }

  private requireArea(areaNumber: number): AasArea {
    if (!Number.isInteger(areaNumber) || areaNumber <= 0 || areaNumber >= this.areas.length) {
      throw new RangeError(`AAS area ${areaNumber} outside 1..${this.areas.length - 1}`);
    }
    const area = this.areas[areaNumber];
    if (area === undefined) throw new RangeError(`missing AAS area ${areaNumber}`);
    return area;
  }
}

/** Parse a Quake III AAS v5 asset, or the source-supported retail v4 variant. */
export function parseAas(data: Uint8Array, source = "<aas>", memory = new BotMemory(),
  lumpReader?: AasLumpReader): AasWorld {
  const reader = new BinaryReader(data, source);
  if (reader.u32() !== AAS_IDENT) throw new BinaryError(source, 0, "expected EAAS magic");
  const version = reader.i32();
  if (version !== 4 && version !== AAS_VERSION) throw new BinaryError(source, 4, "expected AAS version 4 or 5");

  // AAS_DData starts at header byte 8. Its index restarts at zero there.
  const decodedHeader = reader.bytes(HEADER_SIZE - 8);
  if (version === AAS_VERSION) {
    for (let index = 0; index < decodedHeader.length; index++) {
      const byte = decodedHeader[index];
      if (byte === undefined) throw new BinaryError(source, 8 + index, "truncated AAS header");
      decodedHeader[index] = byte ^ ((index * 119) & 0xff);
    }
  }
  const header = new BinaryReader(decodedHeader, `${source}:header`);
  const bspChecksum = header.i32();
  const lumps: AasLump[] = [];
  for (let index = 0; index < LUMP_COUNT; index++) {
    const offset = header.i32();
    const length = header.i32();
    if (length < 0 || (length > 0
      && (offset < 0 || offset > (lumpReader?.length ?? data.length) - length))) {
      throw new BinaryError(source, 12 + index * 8, `invalid AAS lump ${index} range ${offset}+${length}`);
    }
    lumps.push(Object.freeze({ offset, length } satisfies AasLump));
  }

  function lump(index: number): AasLump {
    const value = lumps[index];
    if (value === undefined) throw new RangeError(`unknown AAS lump ${index}`);
    return value;
  }

  const world = new AasLoadedWorld(data, source, version, bspChecksum, lumps, memory, lumpReader);
  const { bboxes, vertices, planes, edges, edgeIndexes, faces, faceIndexes, areas,
    areaSettings, reachability, nodes, portals, portalIndex, clusters } = world;

  function fail(offset: number, message: string): never {
    throw new BinaryError(source, offset, message);
  }
  function reference(value: number, count: number, offset: number, name: string): void {
    if (value < 0 || value >= count) fail(offset, `${name} index ${value} outside 0..${count - 1}`);
  }
  function signedReference(value: number, count: number, offset: number, name: string): void {
    if (value === -0x80000000) fail(offset, `${name} index cannot negate INT32_MIN`);
    reference(Math.abs(value), count, offset, name);
  }
  function range(first: number, count: number, total: number, offset: number, name: string): void {
    if (first < 0 || count < 0 || first > total - count) {
      fail(offset, `${name} range ${first}+${count} exceeds ${total}`);
    }
  }
  function validBounds(value: Bounds, offset: number, name: string): void {
    validVector(value.min, offset, `${name} minimum`);
    validVector(value.max, offset + 12, `${name} maximum`);
    if (value.min.x > value.max.x || value.min.y > value.max.y || value.min.z > value.max.z) {
      fail(offset, `${name} minimum exceeds maximum`);
    }
  }
  function validVector(value: Vec3, offset: number, name: string): void {
    if (!Number.isFinite(value.x)) fail(offset, `non-finite ${name} x`);
    if (!Number.isFinite(value.y)) fail(offset + 4, `non-finite ${name} y`);
    if (!Number.isFinite(value.z)) fail(offset + 8, `non-finite ${name} z`);
  }

  if (planes.length === 0) fail(lump(PLANES).offset, "AAS has no planes");
  if (areas.length === 0) fail(lump(AREAS).offset, "AAS has no dummy area");
  if (areaSettings.length !== areas.length) {
    fail(lump(AREA_SETTINGS).offset, `area settings count ${areaSettings.length} differs from area count ${areas.length}`);
  }
  if (nodes.length < 2) fail(lump(NODES).offset, "AAS has no root node 1");

  for (const [index, bbox] of bboxes.entries()) validBounds(bbox.bounds, lump(BBOXES).offset + index * 32 + 8, "bounding box");
  for (const [index, vertex] of vertices.entries()) validVector(vertex, lump(VERTICES).offset + index * 12, "float vertex");
  for (const [index, plane] of planes.entries()) {
    const offset = lump(PLANES).offset + index * 20;
    validVector(plane.normal, offset, "float plane normal");
    if (!Number.isFinite(plane.distance)) fail(offset + 12, "non-finite float plane distance");
  }
  for (const [index, edge] of edges.entries()) {
    // Edge zero is the format's dummy sentinel and may reference absent vertices.
    if (index === 0) continue;
    reference(edge.vertices[0], vertices.length, lump(EDGES).offset + index * 8, "edge vertex");
    reference(edge.vertices[1], vertices.length, lump(EDGES).offset + index * 8 + 4, "edge vertex");
  }
  for (const [index, edge] of edgeIndexes.entries()) {
    signedReference(edge, edges.length, lump(EDGE_INDEXES).offset + index * 4, "edge index");
  }
  for (const [index, face] of faces.entries()) {
    // Face zero is the format's dummy sentinel.
    if (index === 0) continue;
    const offset = lump(FACES).offset + index * 24;
    reference(face.plane, planes.length, offset, "face plane");
    range(face.firstEdge, face.edgeCount, edgeIndexes.length, offset + 8, "face edges");
    reference(face.frontArea, areas.length, offset + 16, "face front area");
    reference(face.backArea, areas.length, offset + 20, "face back area");
  }
  for (const [index, face] of faceIndexes.entries()) {
    signedReference(face, faces.length, lump(FACE_INDEXES).offset + index * 4, "face index");
  }
  for (const [index, area] of areas.entries()) {
    const offset = lump(AREAS).offset + index * 48;
    if (area.areaNumber !== index) fail(offset, `stored area number ${area.areaNumber} differs from index ${index}`);
    range(area.firstFace, area.faceCount, faceIndexes.length, offset + 4, "area faces");
    // Area zero is a dummy record whose geometric fields are not sampled.
    if (index > 0) {
      validBounds(area.bounds, offset + 12, "area bounds");
      validVector(area.center, offset + 36, "area center");
    }
  }
  for (const [index, settings] of areaSettings.entries()) {
    const offset = lump(AREA_SETTINGS).offset + index * 28;
    range(settings.firstReachableArea, settings.reachableAreaCount, reachability.length, offset + 20, "area reachabilities");
    if (settings.cluster > 0) reference(settings.cluster, clusters.length, offset + 12, "area cluster");
    if (settings.cluster < 0) signedReference(settings.cluster, portals.length, offset + 12, "area portal");
    if (settings.clusterAreaNumber < 0) fail(offset + 16, "negative cluster area number");
  }
  for (const [index, reach] of reachability.entries()) {
    const offset = lump(REACHABILITY).offset + index * 44;
    reference(reach.area, areas.length, offset, "reachability area");
    // AAS_StoreReachability reserves record zero as a dummy.
    if (index > 0) {
      validVector(reach.start, offset + 12, "reachability start");
      validVector(reach.end, offset + 24, "reachability end");
    }
    // Despite their historical names, face and edge are travel-type payloads:
    // movers pack model/spawn flags and jump pads store velocity components.
    // They therefore are not general face/edge references.
  }
  for (const [index, node] of nodes.entries()) {
    // Node zero is never traversed: zero child values denote a solid leaf.
    if (index === 0) continue;
    const offset = lump(NODES).offset + index * 12;
    reference(node.plane, planes.length, offset, "node plane");
    for (const [side, child] of node.children.entries()) {
      const childOffset = offset + 4 + side * 4;
      if (child > 0) reference(child, nodes.length, childOffset, "node child");
      if (child < 0) signedReference(child, areas.length, childOffset, "node area");
    }
  }
  const visits = new Uint8Array(nodes.length);
  const stack: { readonly node: number; readonly exiting: boolean }[] = [];
  for (let root = 1; root < nodes.length; root++) {
    if (visits[root] === 2) continue;
    stack.push({ node: root, exiting: false });
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.exiting) { visits[current.node] = 2; continue; }
      if (visits[current.node] === 1) fail(lump(NODES).offset + current.node * 12, "cycle in AAS nodes");
      if (visits[current.node] === 2) continue;
      visits[current.node] = 1;
      const node = nodes[current.node];
      if (node === undefined) fail(lump(NODES).offset, "missing AAS node");
      stack.push({ node: current.node, exiting: true });
      for (const child of node.children) if (child > 0) stack.push({ node: child, exiting: false });
    }
  }
  for (const [index, portal] of portals.entries()) {
    // Portal and cluster arrays use index zero as a sentinel in generated files.
    if (index === 0) continue;
    const offset = lump(PORTALS).offset + index * 20;
    reference(portal.area, areas.length, offset, "portal area");
    reference(portal.frontCluster, clusters.length, offset + 4, "portal front cluster");
    reference(portal.backCluster, clusters.length, offset + 8, "portal back cluster");
    if (portal.clusterAreaNumbers[0] < 0 || portal.clusterAreaNumbers[1] < 0) {
      fail(offset + 12, "negative portal cluster area number");
    }
  }
  for (const [index, portal] of portalIndex.entries()) {
    reference(portal, portals.length, lump(PORTAL_INDEX).offset + index * 4, "portal index");
  }
  for (const [index, cluster] of clusters.entries()) {
    if (index === 0) continue;
    const offset = lump(CLUSTERS).offset + index * 16;
    if (cluster.areaCount < 0 || cluster.reachabilityAreaCount < 0
      || cluster.reachabilityAreaCount > cluster.areaCount) fail(offset, "invalid cluster area counts");
    range(cluster.firstPortal, cluster.portalCount, portalIndex.length, offset + 8, "cluster portals");
  }

  return Object.freeze(world);
}
