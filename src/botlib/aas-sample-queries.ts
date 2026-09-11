// Port of id Software's botlib/be_aas_sample.c face sampling helpers.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { cross3, dot3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { AasFace, AasPlane, AasWorld } from "./aas.ts";
import type { AasTrace } from "./spatial.ts";

function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new RangeError(`AAS sample index ${index} exceeds source allocation ${rows.length}`);
  return row;
}

export function aasBoxOriginDistanceFromPlane(normal: Vec3, mins: Vec3, maxs: Vec3, side: boolean): number {
  const coordinate = (axis: keyof Vec3): number => normal[axis] > 0.001 ? (side ? maxs[axis] : mins[axis])
    : normal[axis] < -0.001 ? (side ? mins[axis] : maxs[axis]) : 0;
  return dot3(vec3(coordinate("x"), coordinate("y"), coordinate("z")), vec3(-normal.x, -normal.y, -normal.z));
}

export function aasPlaneFromNum(world: AasWorld | null, plane: number): AasPlane | null {
  return world === null ? null : at(world.planes, plane);
}

export function aasInsideFace(world: AasWorld | null, face: AasFace, normal: Vec3, point: Vec3,
  epsilon: number, sampleDebug: ((message: string) => void) | null = null): boolean {
  if (world === null) return false;
  let lastVertex = 0;
  for (let index = 0; index < face.edgeCount; index++) {
    const number = at(world.edgeIndexes, face.firstEdge + index), edge = at(world.edges, Math.abs(number));
    const first = edge.vertices[number < 0 ? 1 : 0], last = edge.vertices[number < 0 ? 0 : 1];
    const origin = at(world.vertices, first), direction = sub3(at(world.vertices, last), origin);
    if (sampleDebug !== null) {
      if (lastVertex !== 0 && lastVertex !== first) sampleDebug("winding not counter clockwise\n");
      lastVertex = last;
    }
    if (dot3(sub3(point, origin), cross3(direction, normal)) < -Math.fround(epsilon)) return false;
  }
  return true;
}

export function aasAreaGroundFace(world: AasWorld | null, areaNumber: number, point: Vec3,
  sampleDebug: ((message: string) => void) | null = null): AasFace | null {
  if (world === null) return null;
  const area = at(world.areas, areaNumber);
  for (let index = 0; index < area.faceCount; index++) {
    const face = at(world.faces, Math.abs(at(world.faceIndexes, area.firstFace + index)));
    if ((face.flags & 4) === 0) continue;
    const normal = at(world.planes, face.plane).normal.z < 0 ? vec3(-0, -0, -1) : vec3(0, 0, 1);
    if (aasInsideFace(world, face, normal, point, Math.fround(0.01), sampleDebug)) return face;
  }
  return null;
}

export function aasFacePlane(world: AasWorld, face: number): AasPlane {
  const plane = at(world.planes, at(world.faces, face).plane);
  return { normal: vec3(plane.normal.x, plane.normal.y, plane.normal.z), distance: plane.distance, type: plane.type };
}

export function aasTraceEndFace(world: AasWorld | null, trace: AasTrace,
  sampleDebug: ((message: string) => void) | null = null): AasFace | null {
  if (world === null || trace.startSolid) return null;
  const area = at(world.areas, trace.lastArea);
  for (let index = 0; index < area.faceCount; index++) {
    const face = at(world.faces, Math.abs(at(world.faceIndexes, area.firstFace + index)));
    if ((face.plane & ~1) !== (trace.plane & ~1)) continue;
    if (aasInsideFace(world, face, at(world.planes, face.plane).normal, trace.end, Math.fround(0.01), sampleDebug)) return face;
  }
  return null;
}
