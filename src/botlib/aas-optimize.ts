/*
 * Translated from id Software's code/botlib/be_aas_optimize.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { allocateAasAreas, allocateAasEdges, allocateAasFaces, allocateAasIndexes, allocateAasVertices } from "./aas-storage.ts";
import type { AasWorldState } from "./aas-world.ts";
import { TravelType } from "./routing.ts";

const FACE_LADDER = 2;

function cell<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`AAS_Optimize: index ${index} outside source allocation ${values.length}`);
  return value;
}

/** optimized_t and AAS_OptimizeAlloc. Counts remain separate from source capacity. */
class Optimized {
  readonly vertices: ReturnType<typeof allocateAasVertices>;
  readonly edges: ReturnType<typeof allocateAasEdges>;
  readonly edgeIndexes: ReturnType<typeof allocateAasIndexes>;
  readonly faces: ReturnType<typeof allocateAasFaces>;
  readonly faceIndexes: ReturnType<typeof allocateAasIndexes>;
  readonly areas: ReturnType<typeof allocateAasAreas>;
  readonly vertexMap: ReturnType<typeof allocateAasIndexes>;
  readonly edgeMap: ReturnType<typeof allocateAasIndexes>;
  readonly faceMap: ReturnType<typeof allocateAasIndexes>;
  vertexCount = 0;
  edgeCount = 1;
  edgeIndexCount = 0;
  faceCount = 1;
  faceIndexCount = 0;

  constructor(readonly world: AasWorldState) {
    this.vertices = allocateAasVertices(world.memory, world.vertices.length);
    this.edges = allocateAasEdges(world.memory, world.edges.length);
    this.edgeIndexes = allocateAasIndexes(world.memory, world.edgeIndexes.length);
    this.faces = allocateAasFaces(world.memory, world.faces.length);
    this.faceIndexes = allocateAasIndexes(world.memory, world.faceIndexes.length);
    this.areas = allocateAasAreas(world.memory, world.areas.length);
    this.vertexMap = allocateAasIndexes(world.memory, world.vertices.length);
    this.edgeMap = allocateAasIndexes(world.memory, world.edges.length);
    this.faceMap = allocateAasIndexes(world.memory, world.faces.length);
  }

  /** AAS_OptimizeEdge. AAS_KeepEdge always returns one in the active source. */
  edge(edgeNumber: number): number {
    const edge = cell(this.world.edges, Math.abs(edgeNumber));
    const existing = cell(this.edgeMap.values, Math.abs(edgeNumber));
    if (existing !== 0) return edgeNumber > 0 ? existing : -existing;
    const output = cell(this.edges.values, this.edgeCount);
    for (const index of [0, 1]) {
      const vertexNumber = cell(edge.vertices, index);
      const mapped = cell(this.vertexMap.values, vertexNumber);
      if (mapped !== 0) output.vertices[index] = mapped;
      else {
        const vertex = cell(this.world.vertices, vertexNumber);
        Object.assign(cell(this.vertices.values, this.vertexCount), vertex);
        output.vertices[index] = this.vertexCount;
        // The source uses zero for both the first output vertex and an unmapped vertex.
        this.vertexMap.values[vertexNumber] = this.vertexCount;
        this.vertexCount++;
      }
    }
    this.edgeMap.values[Math.abs(edgeNumber)] = this.edgeCount;
    const result = this.edgeCount++;
    return edgeNumber > 0 ? result : -result;
  }

  /** AAS_KeepFace and AAS_OptimizeFace. */
  face(faceNumber: number): number {
    const face = cell(this.world.faces, Math.abs(faceNumber));
    if ((face.flags & FACE_LADDER) === 0) return 0;
    const existing = cell(this.faceMap.values, Math.abs(faceNumber));
    if (existing !== 0) return faceNumber > 0 ? existing : -existing;
    const output = cell(this.faces.values, this.faceCount);
    Object.assign(output, face);
    output.edgeCount = 0;
    output.firstEdge = this.edgeIndexCount;
    for (let index = 0; index < face.edgeCount; index++) {
      const edgeNumber = this.edge(cell(this.world.edgeIndexes, face.firstEdge + index));
      if (edgeNumber !== 0) {
        const offset = output.firstEdge + output.edgeCount;
        cell(this.edgeIndexes.values, offset);
        this.edgeIndexes.values[offset] = edgeNumber;
        output.edgeCount++;
        this.edgeIndexCount++;
      }
    }
    this.faceMap.values[Math.abs(faceNumber)] = this.faceCount;
    const result = this.faceCount++;
    return faceNumber > 0 ? result : -result;
  }

  /** AAS_OptimizeArea. Area zero remains the cleared allocation sentinel. */
  area(areaNumber: number): void {
    const area = cell(this.world.areas, areaNumber);
    const output = cell(this.areas.values, areaNumber);
    Object.assign(output, area);
    output.faceCount = 0;
    output.firstFace = this.faceIndexCount;
    for (let index = 0; index < area.faceCount; index++) {
      const faceNumber = this.face(cell(this.world.faceIndexes, area.firstFace + index));
      if (faceNumber !== 0) {
        const offset = output.firstFace + output.faceCount;
        cell(this.faceIndexes.values, offset);
        this.faceIndexes.values[offset] = faceNumber;
        output.faceCount++;
        this.faceIndexCount++;
      }
    }
  }

  /** AAS_OptimizeStore transfers output allocations, then frees the three maps. */
  publish(world: AasWorldState): void {
    world.replaceVertices(this.vertices, this.vertexCount);
    cell(this.edges.values, this.edgeCount - 1);
    world.replaceEdges(this.edges, this.edgeCount);
    world.replaceEdgeIndexes(this.edgeIndexes, this.edgeIndexCount);
    cell(this.faces.values, this.faceCount - 1);
    world.replaceFaces(this.faces, this.faceCount);
    world.replaceFaceIndexes(this.faceIndexes, this.faceIndexCount);
    world.replaceAreas(this.areas);
    world.memory.free(this.vertexMap.allocation);
    world.memory.free(this.edgeMap.allocation);
    world.memory.free(this.faceMap.allocation);
  }
}

/** AAS_Optimize: prune geometry and remap the canonical world's reachability cells. */
export function aasOptimize(world: AasWorldState, print: (message: string) => undefined): void {
  const optimized = new Optimized(world);
  for (let area = 1; area < world.areas.length; area++) optimized.area(area);
  for (let index = 0; index < world.reachabilitySize; index++) {
    const reachability = world.reachabilityRecord(index);
    const travelType = reachability.travelType & TravelType.MASK;
    if (travelType === TravelType.ELEVATOR || travelType === TravelType.JUMPPAD || travelType === TravelType.FUNCBOB) continue;
    const face = reachability.face;
    reachability.face = cell(optimized.faceMap.values, Math.abs(face));
    if (face < 0) reachability.face = -reachability.face | 0;
    const edge = reachability.edge;
    reachability.edge = cell(optimized.edgeMap.values, Math.abs(edge));
    if (edge < 0) reachability.edge = -reachability.edge | 0;
  }
  optimized.publish(world);
  print("AAS data optimized.\n");
}
