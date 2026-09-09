/*
 * MD3 entity selection and geometry translated from renderer/tr_mesh.c,
 * tr_surface.c, tr_main.c and tr_model.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Md3Frame, Md3Model, Md3Surface, Md3Tag, Md3Vertex, SkinSurface } from "../assets/md3.ts";
import { md3FrameAt, md3FrameCount, md3InterpolateSurface, md3LerpTag, md3Surfaces } from "./md3-resource.ts";
import { add3, dot3, length3, scale3, vec3 } from "../core/math.ts";
import type { Axis, Bounds, Mat4, Plane, Vec2, Vec3 } from "../core/math.ts";
import type { Md3Slots, RefModelEntity } from "./ref-entity.ts";
import { RF_THIRD_PERSON, RF_WRAP_FRAMES } from "./ref-entity.ts";
import type { RendererPerformanceCounters } from "./performance.ts";

export interface ModelTransform {
  readonly origin: Vec3;
  readonly axis: Axis;
}

export interface Md3Entity extends ModelTransform {
  readonly nonNormalizedAxes: boolean;
  readonly frame: number;
  readonly oldFrame: number;
  readonly backLerp: number;
  readonly wrapFrames: boolean;
  readonly skinNum: number;
  /** Resolved name; invalid nonzero handles resolve to the registry's default name. Null is absent. */
  readonly customShader: string | null;
  /** Null represents an absent or invalid skin handle. */
  readonly customSkin: readonly SkinSurface[] | null;
  readonly thirdPerson: boolean;
}

export interface Md3View {
  readonly performance?: RendererPerformanceCounters;
  readonly origin: Vec3;
  readonly forward: Vec3;
  readonly projection: Mat4;
  /** The source renderer culls models against the four side planes only. */
  readonly frustum: readonly [Plane, Plane, Plane, Plane];
  readonly noCull: boolean;
  readonly isPortal: boolean;
  readonly lodScale: number;
  readonly lodBias: number;
}

export type ModelShaderSelection =
  | { readonly kind: "custom"; readonly name: string }
  | { readonly kind: "skin"; readonly name: string }
  | { readonly kind: "surface"; readonly name: string; readonly slot: number }
  | { readonly kind: "default"; readonly reason: "missing-skin-surface" | "no-surface-shaders" };

export interface ModelGeometryVertex extends Md3Vertex {
  readonly texCoord: Vec2;
}

export interface ModelSurfaceGeometry {
  readonly name: string;
  /** Selection is unresolved; it does not establish that a material exists. */
  readonly shader: ModelShaderSelection;
  /** Retained for entity-local lighting, texture generation and deformations. */
  readonly localVertices: readonly Md3Vertex[];
  /** World positions and world directions. Scaled axes do not renormalize normals. */
  readonly vertices: readonly ModelGeometryVertex[];
  readonly indices: readonly number[];
}

export interface Md3EntityGeometry {
  readonly frame: number;
  readonly oldFrame: number;
  readonly backLerp: number;
  readonly frameFallback: boolean;
  readonly lod: number;
  readonly cull: "in" | "clip" | "out";
  /** Suppress main surfaces outside portals; a later shadow pass may still use them. */
  readonly personalModel: boolean;
  /** Zero means no fog. Culled models do not evaluate fog selection. */
  readonly fogIndex: number;
  readonly surfaces: readonly ModelSurfaceGeometry[];
}

export interface Md3EntityInput {
  /** Actual registration slots; source gaps remain absent until consumed. */
  readonly md3: Md3Slots;
  readonly numLods: number;
  readonly entity: Md3Entity;
  readonly view: Md3View;
  /** Source fog indices, including reserved slot zero. Null is RDF_NOWORLDMODEL. */
  readonly fogBounds: readonly Bounds[] | null;
}

export interface Md3EntityPoseInput {
  readonly md3: Md3Slots;
  readonly numLods: number;
  readonly entity: Pick<RefModelEntity, "origin" | "axis" | "nonNormalizedAxes" | "frame" | "oldFrame" | "renderFlags">;
  readonly view: Md3View;
  readonly frameWarning: (oldFrame: number, frame: number) => undefined;
}

export interface Md3EntityPose extends Pick<Md3EntityGeometry, "frame" | "oldFrame" | "frameFallback" | "lod" | "cull" | "personalModel"> {
  readonly model: Md3Model;
  readonly currentFrame: Md3Frame;
}

const f = Math.fround;

function at<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`missing ${label} ${index}`);
  return value;
}

function integer(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError(`${label} must be int32`);
}

function finite(value: number): void {
  if (!Number.isFinite(f(value))) throw new RangeError("MD3 entity/view components must be finite float32 values");
}

function vector(value: Vec3): Vec3 {
  finite(value.x); finite(value.y); finite(value.z);
  return vec3(value.x, value.y, value.z);
}

function transform(value: ModelTransform): ModelTransform {
  return { origin: vector(value.origin), axis: [vector(value.axis[0]), vector(value.axis[1]), vector(value.axis[2])] };
}

function worldNormal(local: Vec3, entity: ModelTransform): Vec3 {
  return vec3(
    dot3(local, { x: entity.axis[0].x, y: entity.axis[1].x, z: entity.axis[2].x }),
    dot3(local, { x: entity.axis[0].y, y: entity.axis[1].y, z: entity.axis[2].y }),
    dot3(local, { x: entity.axis[0].z, y: entity.axis[1].z, z: entity.axis[2].z }),
  );
}

function worldPoint(local: Vec3, entity: ModelTransform): Vec3 {
  return add3(worldNormal(local, entity), entity.origin);
}

function lodIndex(input: Pick<Md3EntityPoseInput, "view" | "numLods">, frame: Md3Frame, entity: ModelTransform): number {
  const { view, numLods } = input;
  let lod = 0;
  if (numLods > 1) {
    const corner = vec3(Math.max(Math.abs(frame.bounds.min.x), Math.abs(frame.bounds.max.x)),
      Math.max(Math.abs(frame.bounds.min.y), Math.abs(frame.bounds.max.y)), Math.max(Math.abs(frame.bounds.min.z), Math.abs(frame.bounds.max.z)));
    const radius = length3(corner);
    const forward = vector(view.forward);
    const distance = f(dot3(forward, entity.origin) - dot3(forward, vector(view.origin)));
    let projectedRadius = 0;
    if (distance > 0) {
      const point = { x: 0, y: Math.abs(radius), z: -distance };
      const matrix = view.projection;
      const projectedY = f(dot3(point, { x: matrix[1], y: matrix[5], z: matrix[9] }) + matrix[13]);
      const projectedW = f(dot3(point, { x: matrix[3], y: matrix[7], z: matrix[11] }) + matrix[15]);
      projectedRadius = Math.min(f(projectedY / projectedW), 1);
      if (!Number.isFinite(projectedRadius)) throw new RangeError("MD3 LOD projection has no finite radius");
    }
    const fraction = projectedRadius !== 0 ? f(1 - f(projectedRadius * Math.min(f(view.lodScale), 20))) : 0;
    const converted = Math.trunc(f(fraction * numLods));
    integer(converted, "MD3 LOD float-to-int");
    lod = Math.max(0, Math.min(numLods - 1, converted));
  }
  return Math.max(0, Math.min(numLods - 1, lod + view.lodBias));
}

function sphereCull(frame: Md3Frame, entity: ModelTransform, view: Md3View): Md3EntityGeometry["cull"] {
  if (view.noCull) return "clip";
  const center = worldPoint(frame.origin, entity);
  let clipped = false;
  for (const plane of view.frustum) {
    const distance = f(dot3(center, plane.normal) - plane.distance);
    if (distance < -frame.radius) return "out";
    if (distance <= frame.radius) clipped = true;
  }
  return clipped ? "clip" : "in";
}

function cullModel(current: Md3Frame, previous: Md3Frame, entity: ModelTransform & { readonly nonNormalizedAxes: boolean }, view: Md3View): Md3EntityGeometry["cull"] {
  const counters = view.performance?.frontEnd;
  if (!entity.nonNormalizedAxes) {
    const first = sphereCull(current, entity, view);
    const second = current === previous ? first : sphereCull(previous, entity, view);
    if (first === second) {
      if (counters !== undefined) {
        const counter: `c_sphere_cull_md3_${Md3EntityGeometry["cull"]}` = `c_sphere_cull_md3_${first}`;
        counters[counter] = (counters[counter] + 1) | 0;
      }
      if (first !== "clip") return first;
    }
  }
  const result = cullModelBox(current, previous, entity, view);
  if (counters !== undefined) {
    const counter: `c_box_cull_md3_${Md3EntityGeometry["cull"]}` = `c_box_cull_md3_${result}`;
    counters[counter] = (counters[counter] + 1) | 0;
  }
  return result;
}

function cullModelBox(current: Md3Frame, previous: Md3Frame, entity: ModelTransform, view: Md3View): Md3EntityGeometry["cull"] {
  if (view.noCull) return "clip";
  const min = vec3(Math.min(current.bounds.min.x, previous.bounds.min.x), Math.min(current.bounds.min.y, previous.bounds.min.y), Math.min(current.bounds.min.z, previous.bounds.min.z));
  const max = vec3(Math.max(current.bounds.max.x, previous.bounds.max.x), Math.max(current.bounds.max.y, previous.bounds.max.y), Math.max(current.bounds.max.z, previous.bounds.max.z));
  const corners: Vec3[] = [];
  for (let index = 0; index < 8; index++) {
    // R_CullLocalBox stores each VectorMA result before applying the next axis.
    let corner = add3(entity.origin, scale3(entity.axis[0], index & 1 ? max.x : min.x));
    corner = add3(corner, scale3(entity.axis[1], index & 2 ? max.y : min.y));
    corners.push(add3(corner, scale3(entity.axis[2], index & 4 ? max.z : min.z)));
  }
  let clipped = false;
  for (const plane of view.frustum) {
    let front = false, back = false;
    for (const corner of corners) {
      if (dot3(corner, plane.normal) > plane.distance) front = true;
      else back = true;
    }
    if (!front) return "out";
    clipped ||= back;
  }
  return clipped ? "clip" : "in";
}

export function md3FogIndex(bounds: readonly Bounds[] | null, frame: Md3Frame, origin: Vec3): number {
  if (bounds === null) return 0;
  // R_ComputeFogNum deliberately adds localOrigin without rotating or scaling it.
  const center = add3(origin, frame.origin);
  for (let index = 1; index < bounds.length; index++) {
    const fog = at(bounds, index, "fog");
    if (f(center.x - frame.radius) >= fog.max.x || f(center.x + frame.radius) <= fog.min.x
      || f(center.y - frame.radius) >= fog.max.y || f(center.y + frame.radius) <= fog.min.y
      || f(center.z - frame.radius) >= fog.max.z || f(center.z + frame.radius) <= fog.min.z) continue;
    return index;
  }
  return 0;
}

function shaderSelection(surface: Md3Surface, entity: Md3Entity): ModelShaderSelection {
  if (entity.customShader !== null) return { kind: "custom", name: entity.customShader };
  if (entity.customSkin !== null) {
    const match = entity.customSkin.find(entry => entry.name === surface.name);
    return match === undefined ? { kind: "default", reason: "missing-skin-surface" } : { kind: "skin", name: match.shader };
  }
  if (surface.shaders.length === 0) return { kind: "default", reason: "no-surface-shaders" };
  integer(entity.skinNum, "skinNum");
  if (entity.skinNum < 0) throw new RangeError("negative MD3 skinNum would index before the source shader array");
  const slot = entity.skinNum % surface.shaders.length;
  const shader = at(surface.shaders, slot, "surface shader");
  return { kind: "surface", name: shader.name, slot };
}

/** R_AddMD3Surfaces publishes frame repair before LOD and culling consume the pose. */
export function prepareMd3EntityPose(input: Md3EntityPoseInput): Md3EntityPose {
  const base = input.md3[0];
  if (base === null) throw new RangeError("R_AddMD3Surfaces consumed absent MD3 slot 0");
  const frameCount = md3FrameCount(base);
  integer(input.entity.frame, "frame"); integer(input.entity.oldFrame, "oldFrame");
  const entity = input.entity;
  const personalModel = (entity.renderFlags & RF_THIRD_PERSON) !== 0 && !input.view.isPortal;
  if ((entity.renderFlags & RF_WRAP_FRAMES) !== 0) {
    if (frameCount === 0) throw new RangeError("MD3 frame wrapping divides by source zero frame count");
    entity.frame = (entity.frame % frameCount) | 0;
    entity.oldFrame = (entity.oldFrame % frameCount) | 0;
  }
  const frameFallback = entity.frame < 0 || entity.frame >= frameCount || entity.oldFrame < 0 || entity.oldFrame >= frameCount;
  if (frameFallback) {
    input.frameWarning(entity.oldFrame, entity.frame);
    entity.frame = 0;
    entity.oldFrame = 0;
  }
  integer(input.view.lodBias, "lodBias");
  for (const value of input.view.projection) finite(value);
  for (const plane of input.view.frustum) { vector(plane.normal); finite(plane.distance); }
  const pose = { ...transform(entity), nonNormalizedAxes: entity.nonNormalizedAxes };
  const { frame, oldFrame } = entity;
  const lod = lodIndex(input, md3FrameAt(base, frame, "base MD3 frame"), pose);
  const model = at(input.md3, lod, "MD3 LOD");
  if (model === null) throw new RangeError(`R_AddMD3Surfaces consumed absent MD3 slot ${lod}`);
  const current = md3FrameAt(model, frame, "LOD MD3 frame"), previous = md3FrameAt(model, oldFrame, "LOD old MD3 frame");
  const cull = cullModel(current, previous, pose, input.view);
  return { frame, oldFrame, frameFallback, lod, cull, personalModel, model, currentFrame: current };
}

/** Detached geometry inspection; actual RB_SurfaceMesh execution belongs to SourceTessState. */
export function prepareMd3Surface(surface: Md3Surface, entity: ModelTransform & Pick<Md3EntityGeometry, "frame" | "oldFrame" | "backLerp">): Omit<ModelSurfaceGeometry, "shader"> {
  finite(entity.backLerp);
  const pose = transform(entity);
  const localVertices = md3InterpolateSurface(surface, entity.frame, entity.oldFrame, entity.backLerp);
  const coordinates = surface.texCoords;
  const vertices = localVertices.map((vertex, index) => ({ position: worldPoint(vertex.position, pose), normal: worldNormal(vertex.normal, pose),
    texCoord: at(coordinates, index, "MD3 texture coordinate") }));
  return { name: surface.name, localVertices, vertices, indices: surface.triangles.flatMap(triangle => triangle.indices) };
}

/** Standalone geometry inspection composes the same pose and surface consumers. */
export function prepareMd3Entity(input: Md3EntityInput): Md3EntityGeometry {
  finite(input.entity.backLerp);
  const entity = { ...input.entity, ...transform(input.entity),
    renderFlags: (input.entity.wrapFrames ? RF_WRAP_FRAMES : 0) | (input.entity.thirdPerson ? RF_THIRD_PERSON : 0) };
  const prepared = prepareMd3EntityPose({ ...input, entity, frameWarning: () => undefined });
  const backLerp = prepared.frame === prepared.oldFrame ? 0 : f(entity.backLerp);
  const surfaces: ModelSurfaceGeometry[] = [];
  if (prepared.cull !== "out") {
    for (const surface of md3Surfaces(prepared.model)) {
      surfaces.push({ ...prepareMd3Surface(surface, { ...entity, backLerp }), shader: shaderSelection(surface, entity) });
    }
  }
  return { frame: prepared.frame, oldFrame: prepared.oldFrame, backLerp, frameFallback: prepared.frameFallback,
    lod: prepared.lod, cull: prepared.cull, personalModel: prepared.personalModel,
    fogIndex: prepared.cull === "out" ? 0 : md3FogIndex(input.fogBounds, prepared.currentFrame, entity.origin), surfaces };
}

/** R_LerpTag's frame clamp and missing-tag result, then parent entity placement. */
export function transformMd3Tag(model: Md3Model, name: string, startFrame: number, endFrame: number, fraction: number, parent: ModelTransform): Md3Tag | null {
  const tag = md3LerpTag(model, name, startFrame, endFrame, fraction);
  if (tag === null) return null;
  const entity = transform(parent);
  return { name: tag.name, origin: worldPoint(tag.origin, entity),
    axes: [worldNormal(tag.axes[0], entity), worldNormal(tag.axes[1], entity), worldNormal(tag.axes[2], entity)] };
}
