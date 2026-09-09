import { anglesToAxis } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { createRefdef } from "../src/render/refdef.ts";
import type { Refdef } from "../src/render/refdef.ts";

/** Test camera input is Euler-authored; the renderer receives only its exact basis. */
export function cameraRefdef(camera: { readonly origin: Vec3; readonly angles: Vec3 }, width: number, height: number, time = 0): Refdef {
  const result = createRefdef();
  result.width = width; result.height = height;
  result.fovX = 90; result.fovY = Math.atan(height / width) * 360 / Math.PI;
  result.viewOrigin = camera.origin; result.viewAxis = anglesToAxis(camera.angles); result.time = time;
  return result;
}
