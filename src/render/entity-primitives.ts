// tr_surface.c RB_SurfaceSprite/Beam/Axis/RailCore/RailRings/LightningBolt and tr_main.c R_SpriteFogNum.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { BspVertex } from "../assets/bsp.ts";
import { add3, cross3, dot3, length3, normalize3, perpendicularVector, rotatePointAroundVector, scale3, sub3, vec3 } from "../core/math.ts";
import type { Axis, Bounds, Vec3, Vec4 } from "../core/math.ts";
import type { RefBeamEntity, RefModelEntity, RefPoly, RefRailEntity, RefSpriteEntity } from "./ref-entity.ts";
import { modelWorldPoint } from "./scene-models.ts";
import type { DrawBatch, RenderState, RenderVertex } from "./types.ts";
import type { RendererImage } from "./image-resource.ts";

export interface EntityGeometry { readonly vertices: readonly BspVertex[]; readonly indices: readonly number[] }
type RailPose = Omit<RefRailEntity, "customShader">;
type SpritePose = Omit<RefSpriteEntity, "customShader">;
type BeamPose = Omit<RefBeamEntity, "customShader">;
type ModelPose = Pick<RefModelEntity, "origin" | "axis">;

export interface RailSettings {
  readonly coreWidth: number;
  readonly ringWidth: number;
  readonly segmentLength: number;
}
export const DEFAULT_RAIL_SETTINGS: RailSettings = Object.freeze({ coreWidth: 6, ringWidth: 16, segmentLength: 32 });

/** RB_SurfaceRailCore/RailRings/LightningBolt, including integer length truncation. */
export function railGeometry(entity: RailPose, viewOrigin: Vec3, settings: RailSettings = DEFAULT_RAIL_SETTINGS): EntityGeometry {
  const vertices: BspVertex[] = [], indices: number[] = [];
  const start = entity.kind === "lightning" ? entity.origin : entity.oldOrigin;
  const end = entity.kind === "lightning" ? entity.oldOrigin : entity.origin;
  const delta = sub3(end, start), direction = normalize3(delta), length = Math.trunc(length3(delta));
  if (!Number.isInteger(length) || length < -0x80000000 || length > 0x7fffffff) throw new RangeError("rail length exceeds source int32 conversion");
  // Source rail calls leave normals, lightmap coordinates and alpha unwritten.
  // The retained tess writer preserves those cells.
  const vertex = (position: Vec3, s: number, t: number, dim = false): BspVertex => ({ position, normal: vec3(0, 0, 0),
    texCoord: { x: s, y: t }, lightmapCoord: { x: 0, y: 0 }, color: { x: dim ? Math.trunc(entity.shaderRGBA.x * 0.25) : entity.shaderRGBA.x,
      y: dim ? Math.trunc(entity.shaderRGBA.y * 0.25) : entity.shaderRGBA.y,
      z: dim ? Math.trunc(entity.shaderRGBA.z * 0.25) : entity.shaderRGBA.z, w: 0 } });
  function core(right: Vec3, width: number): void {
    if (!Number.isInteger(width) || width < -0x80000000 || width > 0x7fffffff) throw new RangeError("rail core width requires a source int32");
    const base = vertices.length, offset = scale3(right, Math.fround(width)), t = Math.fround(Math.fround(length) / 256);
    vertices.push(vertex(add3(start, offset), 0, 0, true), vertex(sub3(start, offset), 0, 1),
      vertex(add3(end, offset), t, 0), vertex(sub3(end, offset), t, 1));
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  if (entity.kind !== "rail-rings") {
    let right = normalize3(cross3(normalize3(sub3(start, viewOrigin)), normalize3(sub3(end, viewOrigin))));
    for (let index = 0; index < (entity.kind === "lightning" ? 4 : 1); index++) {
      core(right, entity.kind === "lightning" ? 8 : settings.coreWidth);
      if (entity.kind === "lightning") right = rotatePointAroundVector(direction, right, 45);
    }
    return { vertices, indices };
  }
  // MakeNormalVectors uses a permutation before Gram-Schmidt, not PerpendicularVector.
  const seed = vec3(direction.z, -direction.x, direction.y);
  const right = normalize3(sub3(seed, scale3(direction, dot3(seed, direction)))), up = cross3(right, direction);
  let segments = Math.trunc(Math.fround(Math.fround(length) / Math.fround(settings.segmentLength)));
  if (!Number.isInteger(segments) || segments < -0x80000000 || segments > 0x7fffffff) throw new RangeError("rail ring count exceeds source int32 conversion");
  if (segments <= 0) segments = 1;
  // VectorScale expands the live cvar read once per component.
  const step = vec3(direction.x * Math.fround(settings.segmentLength), direction.y * Math.fround(settings.segmentLength), direction.z * Math.fround(settings.segmentLength));
  const width = settings.ringWidth;
  if (!Number.isInteger(width) || width < -0x80000000 || width > 0x7fffffff) throw new RangeError("rail ring width requires a source int32");
  if (segments > 1_000_000) throw new RangeError("rail ring geometry exceeds safe allocation");
  if (segments > 1) segments--;
  const positions: Vec3[] = [];
  for (let index = 0; index < 4; index++) {
    const angle = (45 + index * 90) * Math.PI / 180;
    const c = Math.fround(Math.cos(angle)), s = Math.fround(Math.sin(angle));
    const offset = scale3(scale3(add3(scale3(right, c), scale3(up, s)), 0.25), Math.fround(width));
    const position = add3(start, offset);
    positions.push(segments > 1 ? add3(position, step) : position);
  }
  for (let segment = 0; segment < segments; segment++) {
    const base = vertices.length;
    for (const [index, position] of positions.entries()) {
      vertices.push(vertex(position, index < 2 ? 1 : 0, index !== 0 && index !== 3 ? 1 : 0));
      positions[index] = add3(position, step);
    }
    indices.push(base, base + 1, base + 3, base + 3, base + 1, base + 2);
  }
  return { vertices, indices };
}

/** RB_SurfacePolychain copies attributes and emits a triangle fan. */
export function polyGeometry(poly: Pick<RefPoly, "vertices">): EntityGeometry {
  const vertices = poly.vertices.map(vertex => ({ ...vertex, normal: vec3(0, 0, 0), lightmapCoord: { x: 0, y: 0 } }));
  const indices: number[] = [];
  for (let index = 0; index < vertices.length - 2; index++) indices.push(0, index + 1, index + 2);
  return { vertices, indices };
}

export function spriteGeometry(entity: SpritePose, viewAxis: Axis, mirror: boolean): EntityGeometry {
  const radius = Math.fround(entity.radius);
  let left: Vec3, up: Vec3;
  if (entity.rotation === 0) {
    left = scale3(viewAxis[1], radius);
    up = scale3(viewAxis[2], radius);
  } else {
    const angle = Math.fround(Math.PI * entity.rotation / 180), sine = Math.fround(Math.sin(angle)), cosine = Math.fround(Math.cos(angle));
    left = add3(scale3(viewAxis[1], Math.fround(cosine * radius)), scale3(viewAxis[2], Math.fround(-sine * radius)));
    up = add3(scale3(viewAxis[2], Math.fround(cosine * radius)), scale3(viewAxis[1], Math.fround(sine * radius)));
  }
  if (mirror) left = scale3(left, -1);
  const corner = (l: number, u: number): Vec3 => vec3(Math.fround(entity.origin.x + l * left.x) + u * up.x,
    Math.fround(entity.origin.y + l * left.y) + u * up.y, Math.fround(entity.origin.z + l * left.z) + u * up.z);
  const normal = scale3(viewAxis[0], -1);
  const vertex = (position: Vec3, s: number, t: number): BspVertex => ({ position, normal, texCoord: { x: s, y: t },
    lightmapCoord: { x: s, y: t }, color: { ...entity.shaderRGBA } });
  return { vertices: [vertex(corner(1, 1), 0, 0), vertex(corner(-1, 1), 1, 0), vertex(corner(-1, -1), 1, 1), vertex(corner(1, -1), 0, 1)],
    indices: [0, 1, 3, 3, 1, 2] };
}

/** Source uses the entity origin/radius for every generated primitive's fog. */
export function spriteFog(origin: Vec3, radius: number, bounds: readonly Bounds[]): number {
  return bounds.findIndex(fog => origin.x - radius < fog.max.x && origin.x + radius > fog.min.x
    && origin.y - radius < fog.max.y && origin.y + radius > fog.min.y
    && origin.z - radius < fog.max.z && origin.z + radius > fog.min.z);
}

export function beamBatch(entity: BeamPose, project: (point: Vec3) => Vec4, previous: RenderState, whiteImage: RendererImage): DrawBatch {
  const direction = sub3(entity.oldOrigin, entity.origin);
  if (length3(direction) === 0) return { texturing: "single", primitive: "triangles", vertices: [], indices: [], texture: { kind: "bind-image", image: whiteImage }, state: previous };
  const normalized = normalize3(direction), perpendicular = scale3(perpendicularVector(normalized), 4);
  const vertices: RenderVertex[] = [];
  for (let index = 0; index < 6; index++) {
    // The source's VectorAdd(start_points[i], origin, ...) is commented out.
    const start = rotatePointAroundVector(normalized, perpendicular, index * 60);
    for (const position of [start, add3(start, direction)]) vertices.push({ position: project(position), texCoord: { x: 0, y: 0 }, color: { x: 1, y: 0, z: 0, w: 1 } });
  }
  const indices: number[] = [];
  for (let index = 0; index < 12; index++) {
    if (index % 2 === 0) indices.push(index % 12, (index + 1) % 12, (index + 2) % 12);
    else indices.push((index + 1) % 12, index % 12, (index + 2) % 12);
  }
  return { texturing: "single", primitive: "triangles", vertices, indices, texture: { kind: "bind-image", image: whiteImage }, state: { ...previous,
    blend: { source: "one", destination: "one" }, depthTest: "less-equal", depthWrite: false, alphaTest: "none" } };
}

export function defaultModelBatch(entity: ModelPose, project: (point: Vec3) => Vec4, state: RenderState, whiteImage: RendererImage): DrawBatch {
  const vertices: RenderVertex[] = [];
  const colors: readonly Vec4[] = [{ x: 1, y: 0, z: 0, w: 1 }, { x: 0, y: 1, z: 0, w: 1 }, { x: 0, y: 0, z: 1, w: 1 }];
  for (const [index, color] of colors.entries()) {
    for (const local of [vec3(0, 0, 0), vec3(index === 0 ? 16 : 0, index === 1 ? 16 : 0, index === 2 ? 16 : 0)]) {
      vertices.push({ position: project(modelWorldPoint(entity, local)), color, texCoord: { x: 0, y: 0 } });
    }
  }
  return { texturing: "single", primitive: "lines", lineWidth: 3, vertices, indices: [0, 1, 2, 3, 4, 5], texture: { kind: "bind-image", image: whiteImage }, state };
}
