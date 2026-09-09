// Projection and four-plane culling from id Software's tr_main.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import { add3, dot3, scale3, sub3 } from "../core/math.ts";
import type { Bounds, Mat4, Plane, Vec3, Vec4 } from "../core/math.ts";
import { copyRefdef, RDF_NOWORLDMODEL } from "./refdef.ts";
import type { Refdef } from "./refdef.ts";
import type { RefModelEntity } from "./ref-entity.ts";

/** R_TransformModelToClip stores each eye and clip component as a source float. */
export function sourceTransformModelToClip(point: Vec3, model: Mat4, projection: Mat4): { readonly eye: Vec4; readonly clip: Vec4 } {
  const f = Math.fround;
  const transform = (matrix: Mat4, value: Vec4): Vec4 => {
    const component = (a: number, b: number, c: number, d: number): number =>
      f(f(f(f(value.x * a) + f(value.y * b)) + f(value.z * c)) + f(value.w * d));
    return { x: component(matrix[0], matrix[4], matrix[8], matrix[12]),
      y: component(matrix[1], matrix[5], matrix[9], matrix[13]),
      z: component(matrix[2], matrix[6], matrix[10], matrix[14]),
      w: component(matrix[3], matrix[7], matrix[11], matrix[15]) };
  };
  const eye = transform(model, { x: f(point.x), y: f(point.y), z: f(point.z), w: 1 });
  return { eye, clip: transform(projection, eye) };
}

/** R_TransformClipToWindow writes three components, leaving both source w cells untouched. */
export function sourceTransformClipToWindow(clip: Vec4, viewport: { readonly width: number; readonly height: number }):
  { readonly normalized: Vec3; readonly window: Vec3 } {
  const f = Math.fround;
  const normalized = { x: f(clip.x / clip.w), y: f(clip.y / clip.w), z: f(f(clip.z + clip.w) / f(2 * clip.w)) };
  const coordinate = (value: number, size: number): number => {
    const rounded = Math.trunc(f(f(0.5 * f(1 + value)) * f(size)) + 0.5);
    if (!Number.isFinite(rounded) || rounded < -0x80000000 || rounded > 0x7fffffff)
      throw new RangeError("R_TransformClipToWindow: undefined source float-to-int conversion");
    return f(rounded);
  };
  return { normalized, window: { x: coordinate(normalized.x, viewport.width), y: coordinate(normalized.y, viewport.height), z: normalized.z } };
}

export function snapshotView(input: Readonly<Refdef>): Refdef {
  const view = copyRefdef(input);
  if (![view.x, view.y, view.width, view.height, view.time, view.renderFlags].every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff)) throw new RangeError("refdef viewport, time and flags require signed int32 values");
  if (view.width <= 0 || view.height <= 0) return view;
  if (![view.fovX, view.fovY].every(value => Number.isFinite(value) && value > 0 && value < 180)
    || ![view.viewOrigin, ...view.viewAxis].every(value => [value.x, value.y, value.z].every(Number.isFinite))) throw new RangeError("refdef requires finite view coordinates and FOV between 0 and 180 degrees");
  return view;
}

export function viewFrustum(view: Readonly<Refdef>): readonly [Plane, Plane, Plane, Plane] {
  const side = (direction: Vec3, fov: number, sign: number): Plane => {
    const angle = Math.fround(Math.fround(fov / 180) * Math.PI * 0.5);
    const normal = add3(scale3(view.viewAxis[0], Math.fround(Math.sin(angle))), scale3(direction, Math.fround(Math.cos(angle)) * sign));
    return { normal, distance: dot3(view.viewOrigin, normal) };
  };
  return [side(view.viewAxis[1], view.fovX, 1), side(view.viewAxis[1], view.fovX, -1),
    side(view.viewAxis[2], view.fovY, 1), side(view.viewAxis[2], view.fovY, -1)];
}

export function boundsInFrustum(bounds: Bounds, planes: readonly Plane[]): boolean {
  return planes.every(plane => dot3({ x: plane.normal.x >= 0 ? bounds.max.x : bounds.min.x,
    y: plane.normal.y >= 0 ? bounds.max.y : bounds.min.y,
    z: plane.normal.z >= 0 ? bounds.max.z : bounds.min.z }, plane.normal) >= plane.distance);
}

export function farClip(view: Readonly<Refdef>, bounds: Bounds): number {
  if ((view.renderFlags & RDF_NOWORLDMODEL) !== 0) return 2048;
  let maximum = 0;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const relative = sub3({ x, y, z }, view.viewOrigin);
    maximum = Math.max(maximum, dot3(relative, relative));
  }
  return Math.fround(Math.sqrt(maximum));
}

export function viewProjection(view: Readonly<Refdef>, far: number, near = 4): Mat4 {
  const width = Math.fround(2 * Math.fround(near * Math.tan(view.fovX * Math.PI / 360)));
  const height = Math.fround(2 * Math.fround(near * Math.tan(view.fovY * Math.PI / 360)));
  const depth = Math.fround(far - near);
  if (depth === 0) throw new RangeError("source projection is singular when far clip equals near clip");
  return [Math.fround(2 * near / width), 0, 0, 0, 0, Math.fround(2 * near / height), 0, 0,
    0, 0, Math.fround(-Math.fround(far + near) / depth), -1, 0, 0, Math.fround(Math.fround(-2 * far * near) / depth), 0];
}

export function viewProjector(view: Readonly<Refdef>, projection: Mat4,
  entity?: Pick<RefModelEntity, "origin" | "axis">): (point: Vec3) => Vec4 {
  const [forward, left, up] = view.viewAxis;
  // R_RotateForViewer stores translation before any point reaches the matrix.
  const translateX = dot3(view.viewOrigin, left), translateY = -dot3(view.viewOrigin, up), translateZ = dot3(view.viewOrigin, forward);
  const xAxis = scale3(left, -1), zAxis = scale3(forward, -1);
  // R_RotateForEntity multiplies the two matrices before transforming vertices.
  const row = (axis: Vec3, translation: number): Vec4 => entity === undefined
    ? { ...axis, w: translation }
    : { x: Math.fround(dot3(entity.axis[0], axis) + 0), y: Math.fround(dot3(entity.axis[1], axis) + 0),
      z: Math.fround(dot3(entity.axis[2], axis) + 0), w: Math.fround(dot3(entity.origin, axis) + translation) };
  const eyeX = row(xAxis, translateX), eyeY = row(up, translateY), eyeZ = row(zAxis, translateZ);
  const component = (x: number, y: number, z: number, a: number, b: number, c: number, d: number): number =>
    Math.fround(Math.fround(Math.fround(Math.fround(x * a) + Math.fround(y * b)) + Math.fround(z * c)) + d);
  return point => {
    const x = Math.fround(dot3(point, eyeX) + eyeX.w), y = Math.fround(dot3(point, eyeY) + eyeY.w);
    const z = Math.fround(dot3(point, eyeZ) + eyeZ.w);
    return { x: component(x, y, z, projection[0], projection[4], projection[8], projection[12]),
      y: component(x, y, z, projection[1], projection[5], projection[9], projection[13]),
      z: component(x, y, z, projection[2], projection[6], projection[10], projection[14]),
      w: component(x, y, z, projection[3], projection[7], projection[11], projection[15]) };
  };
}
