import { expect, test } from "bun:test";
import { anglesToAxis, dot3, sub3, vec3 } from "../src/core/math.ts";
import type { Mat4 } from "../src/core/math.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { viewProjection, viewProjector } from "../src/render/view.ts";
import { modelWorldPoint } from "../src/render/scene-models.ts";

test("viewer translation is stored before source point and projection arithmetic", () => {
  const view = createRefdef();
  view.viewOrigin = vec3(1357.31, -423.92, 817.18);
  view.viewAxis = anglesToAxis(vec3(17, 23, 9));
  view.fovX = 90; view.fovY = 60;
  const point = vec3(1369.4, -417.6, 812.5), project = viewProjector(view, viewProjection(view, 2048));
  const result = project(point);
  expect(result.w).toBe(14.372314453125);
  expect(result.w).not.toBe(dot3(sub3(point, view.viewOrigin), view.viewAxis[0]));
  for (const coordinate of [result.x, result.y, result.z, result.w]) expect(coordinate).toBe(Math.fround(coordinate));
});

test("source projection consumes every matrix row after stored eye coordinates", () => {
  const view = createRefdef();
  view.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
  const matrix: Mat4 = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
  // Identity Q3 camera: source (x,y,z) becomes OpenGL eye (-y,z,-x,1).
  expect(viewProjector(view, matrix)(vec3(3, 5, 7))).toEqual({
    x: -10 + 77 - 69 + 41, y: -15 + 91 - 87 + 43,
    z: -25 + 119 - 93 + 47, w: -35 + 133 - 111 + 53,
  });
});

test("entity matrices are precomposed and retained before local vertices are projected", () => {
  const view = createRefdef();
  view.viewOrigin = vec3(1357.31, -423.92, 817.18);
  view.viewAxis = anglesToAxis(vec3(17, 23, 9)); view.fovX = 90; view.fovY = 60;
  const entity = { origin: vec3(1360, -420, 810), axis: anglesToAxis(vec3(19, -7, 5)) };
  const projection = viewProjection(view, 2048), point = vec3(13.37, -4.125, 2.98);
  const project = viewProjector(view, projection, entity), clip = project(point);
  const f = Math.fround, forward = view.viewAxis[0];
  // The final modelview Z row from myGlMultMatrix(glMatrix, world.modelMatrix).
  const coefficient = (axis: { x: number; y: number; z: number }): number =>
    f(f(f(f(axis.x * -forward.x) + f(axis.y * -forward.y)) + f(axis.z * -forward.z)) + 0);
  const translation = f(coefficient(entity.origin) + dot3(view.viewOrigin, forward));
  const eyeZ = f(f(f(f(point.x * coefficient(entity.axis[0])) + f(point.y * coefficient(entity.axis[1])))
    + f(point.z * coefficient(entity.axis[2]))) + translation);
  expect(clip.w).toBe(-eyeZ);
  expect(clip.w).not.toBe(viewProjector(view, projection)(modelWorldPoint(entity, point)).w);
  entity.origin = vec3(0, 0, 0);
  entity.axis = anglesToAxis(vec3(0, 0, 0));
  expect(project(point)).toEqual(clip);
});
