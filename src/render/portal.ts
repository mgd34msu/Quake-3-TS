// Portal orientation and visibility from id Software's renderer/tr_main.c;
// retained mesh pose from tr_surface.c and clip-plane conversion from tr_backend.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { md3SurfaceSource } from "./md3-resource.ts";
import type { Md3Surface } from "../assets/md3.ts";
import type { Axis, Mat4, Plane, Vec3, Vec4 } from "../core/math.ts";
import { add3, cross3, dot3, length3, normalize3, perpendicularVector, rotatePointAroundVector, scale3, sub3, vec3 } from "../core/math.ts";
import type { RefBeamEntity, RefModelEntity, RefPortalEntity, SourceRefEntity } from "./ref-entity.ts";
import type { Refdef } from "./refdef.ts";
import type { PatchGrid } from "./patch-lod.ts";
import { selectPatchLod } from "./patch-lod.ts";
import type { PatchMesh } from "./patch.ts";
import { SourceTessState } from "./tess-state.ts";
import type { TessEntityContext, TessViewContext } from "./tess-state.ts";
import type { EntityGeometry } from "./entity-primitives.ts";

export interface PortalView {
  readonly origin: Vec3;
  readonly axis: Axis;
  readonly pvsOrigin: Vec3;
  readonly mirror: boolean;
  readonly plane: Plane;
}
type PortalModelPose = Pick<RefModelEntity, "origin" | "axis">;
type BeamPose = Omit<RefBeamEntity, "customShader">;

const f = Math.fround;
function matchingPortal(original: Plane, model: PortalModelPose | null, entities: readonly SourceRefEntity[]): RefPortalEntity | null {
  // Source matching translates the original plane without rotating its normal.
  const distance = model === null ? original.distance : f(original.distance + dot3(original.normal, model.origin));
  for (const entity of entities) {
    if (entity.kind === "portal-surface" && Math.abs(f(dot3(entity.origin, original.normal) - distance)) <= 64) return entity;
  }
  return null;
}

function isMirror(entity: RefPortalEntity): boolean {
  return entity.oldOrigin.x === entity.origin.x && entity.oldOrigin.y === entity.origin.y && entity.oldOrigin.z === entity.origin.z;
}

/** IsMirror runs after clip/backface rejection and before portal range rejection. */
export function portalSurfaceIsMirror(original: Plane, model: PortalModelPose | null, entities: readonly SourceRefEntity[]): boolean {
  const entity = matchingPortal(original, model, entities);
  return entity !== null && isMirror(entity);
}

function transform(vector: Vec3, surface: Axis, camera: Axis): Vec3 {
  let result = vec3(0, 0, 0);
  for (const index of [0, 1, 2] satisfies readonly (0 | 1 | 2)[]) {
    result = add3(result, scale3(camera[index], dot3(vector, surface[index])));
  }
  return result;
}

/** R_GetPortalOrientations selects the first entity within 64 units, not the nearest. */
export function portalViewForSurface(original: Plane, model: PortalModelPose | null, entities: readonly SourceRefEntity[], view: Readonly<Refdef>): PortalView | null {
  const normal = model === null ? original.normal : vec3(
    dot3(original.normal, { x: model.axis[0].x, y: model.axis[1].x, z: model.axis[2].x }),
    dot3(original.normal, { x: model.axis[0].y, y: model.axis[1].y, z: model.axis[2].y }),
    dot3(original.normal, { x: model.axis[0].z, y: model.axis[1].z, z: model.axis[2].z }));
  const distance = model === null ? original.distance : f(original.distance + dot3(normal, model.origin));
  const entity = matchingPortal(original, model, entities);
  if (entity === null) return null;
  const side = perpendicularVector(normal), surfaceAxis: Axis = [normal, side, cross3(normal, side)];
  const mirror = isMirror(entity);
  let surfaceOrigin: Vec3, cameraOrigin: Vec3, cameraAxis: Axis;
  if (mirror) {
    surfaceOrigin = scale3(normal, distance);
    cameraOrigin = surfaceOrigin;
    cameraAxis = [scale3(normal, -1), surfaceAxis[1], surfaceAxis[2]];
  } else {
    surfaceOrigin = add3(entity.origin, scale3(normal, -f(dot3(entity.origin, normal) - distance)));
    cameraOrigin = entity.oldOrigin;
    const forward = scale3(entity.axis[0], -1), left = scale3(entity.axis[1], -1);
    let angle: number | null = null;
    if (entity.oldFrame !== 0) {
      angle = entity.frame !== 0 ? f(f(f(view.time) / 1000) * f(entity.frame))
        : f(f(entity.skinNum) + f(f(Math.sin(f(f(view.time) * f(0.003)))) * 4));
    } else if (entity.skinNum !== 0) angle = f(entity.skinNum);
    const rotated = angle === null ? left : rotatePointAroundVector(forward, left, angle);
    cameraAxis = [forward, rotated, angle === null ? entity.axis[2] : cross3(forward, rotated)];
  }
  const planeNormal = scale3(cameraAxis[0], -1);
  return { origin: add3(transform(sub3(view.viewOrigin, surfaceOrigin), surfaceAxis, cameraAxis), cameraOrigin),
    axis: [transform(view.viewAxis[0], surfaceAxis, cameraAxis), transform(view.viewAxis[1], surfaceAxis, cameraAxis), transform(view.viewAxis[2], surfaceAxis, cameraAxis)],
    pvsOrigin: { ...entity.oldOrigin }, mirror, plane: { normal: planeNormal, distance: dot3(cameraOrigin, planeNormal) } };
}

/** SurfIsOffscreen consumes source tess attributes before stage deformations. */
export function portalSurfaceOffscreen(tess: SourceTessState,
  origin: Vec3, project: (point: Vec3) => Vec4, range: number, isMirror: () => boolean): boolean {
  const mesh = tess.snapshotGeometry();
  let pointAnd = -1;
  for (const vertex of mesh.vertices) {
    const clip = project(vertex.position);
    let flags = 0;
    for (const [index, component] of [clip.x, clip.y, clip.z].entries()) {
      if (component >= clip.w) flags |= 1 << (index * 2);
      else if (component <= -clip.w) flags |= 1 << (index * 2 + 1);
    }
    pointAnd &= flags;
  }
  if (pointAnd !== 0) return true;
  let triangles = mesh.indices.length / 3, shortest = 100000000;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const vertexIndex = mesh.indices[index];
    if (vertexIndex === undefined) throw new RangeError("portal tess triangle index is missing");
    const vertex = tess.allocatedVertex(vertexIndex);
    const relative = sub3(vertex.position, origin);
    shortest = Math.min(shortest, dot3(relative, relative));
    if (dot3(relative, vertex.normal) >= 0) triangles--;
  }
  return triangles === 0 || (!isMirror() && shortest > f(f(range) * f(range)));
}

/** SurfIsOffscreen calls RB_SurfaceGrid with the previous backend's orientation and view. */
export function portalGridGeometry(grid: PatchGrid, context: TessEntityContext, view: TessViewContext, curveError: number): PatchMesh {
  const local = grid.lodOrigin, axis = context.orientationAxis;
  const world = add3(vec3(dot3(local, { x: axis[0].x, y: axis[1].x, z: axis[2].x }),
    dot3(local, { x: axis[0].y, y: axis[1].y, z: axis[2].y }),
    dot3(local, { x: axis[0].z, y: axis[1].z, z: axis[2].z })), context.orientationOrigin);
  return selectPatchLod(grid, world, view.origin, view.axis[0], curveError);
}

/** Detached probe inspection runs the same source writer as actual portal/backend execution. */
export function portalMd3Geometry(surface: Md3Surface, entity: SourceRefEntity | null): EntityGeometry {
  if (entity === null) throw new Error("RB_SurfaceMesh: source backEnd.currentEntity is NULL before pose access");
  if (md3SurfaceSource(surface).surfaceType !== 6) throw new Error("RB_SurfaceMesh: unsupported source surface dispatch");
  const tess = new SourceTessState();
  tess.setEntity({ ...tess.context, kind: "entity", entity });
  for (const operation of tess.appendMd3(surface, () => { throw new RangeError("Detached MD3 probe exceeds tess capacity"); }))
    throw new Error(`Detached MD3 probe emitted unexpected ${operation.kind}`);
  return tess.snapshotGeometry();
}

/** RB_SurfaceBeam emits a closed immediate strip without adding the entity origin. */
export function portalBeamPositions(entity: BeamPose, project: (position: Vec3) => Vec4): readonly Vec4[] {
  const direction = sub3(entity.oldOrigin, entity.origin);
  if (length3(direction) === 0) return [];
  const normalized = normalize3(direction), perpendicular = scale3(perpendicularVector(normalized), 4);
  const positions: Vec4[] = [];
  for (let index = 0; index <= 6; index++) {
    const start = rotatePointAroundVector(normalized, perpendicular, (index % 6) * 60);
    positions.push(project(start), project(add3(start, direction)));
  }
  return positions;
}

/** RB_SurfaceAxis uses only the current GL matrices, not an entity transform of its own. */
export function portalAxisPositions(project: (position: Vec3) => Vec4): readonly [Vec4, Vec4, Vec4, Vec4, Vec4, Vec4] {
  return [project(vec3(0, 0, 0)), project(vec3(16, 0, 0)), project(vec3(0, 0, 0)),
    project(vec3(0, 16, 0)), project(vec3(0, 0, 0)), project(vec3(0, 0, 16))];
}

/** Inverse-transpose projection of RB_BeginDrawingView's source eye plane. */
export function portalClipPlane(plane: Plane, view: Readonly<Refdef>, projection: Mat4): Vec4 {
  const eye = portalEyePlane(plane, view);
  return { x: eye.x / projection[0], y: eye.y / projection[5], z: eye.w / projection[14], w: -eye.z + eye.w * projection[10] / projection[14] };
}

/** qglClipPlane transforms plane2 by the inverse transpose of s_flipMatrix. */
export function portalEyePlane(plane: Plane, view: Readonly<Refdef>): Vec4 {
  const a = dot3(view.viewAxis[0], plane.normal), b = dot3(view.viewAxis[1], plane.normal), c = dot3(view.viewAxis[2], plane.normal);
  const d = f(dot3(plane.normal, view.viewOrigin) - plane.distance);
  return { x: -b, y: c, z: -a, w: d };
}
