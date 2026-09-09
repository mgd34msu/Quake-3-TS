import { describe, expect, test } from "bun:test";
import type { BspVertex } from "../src/assets/bsp.ts";
import type { Md3Surface } from "../src/assets/md3.ts";
import { anglesToAxis, dot3 } from "../src/core/math.ts";
import type { Plane, Vec3 } from "../src/core/math.ts";
import { createBeamEntity, createModelEntity, createPortalEntity } from "../src/render/ref-entity.ts";
import type { SourceRefEntityRecord } from "../src/render/ref-entity.ts";
import { portalAxisPositions, portalBeamPositions, portalClipPlane, portalGridGeometry, portalMd3Geometry, portalSurfaceOffscreen, portalViewForSurface } from "../src/render/portal.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import type { PatchGrid } from "../src/render/patch-lod.ts";
import { viewProjection, viewProjector } from "../src/render/view.ts";
import { cameraRefdef } from "./refdef-fixture.ts";

const view = cameraRefdef({ origin: { x: 0, y: 0, z: 0 }, angles: { x: 0, y: 0, z: 0 } }, 320, 240);
const plane: Plane = { normal: { x: -1, y: 0, z: 0 }, distance: -32 };

describe("source portal orientation and culling", () => {
  test("the first entity inside the inclusive plane tolerance wins and mirrors reflect the exact basis", () => {
    const first = createPortalEntity(); first.origin = { x: 96, y: 8, z: 4 }; first.oldOrigin = first.origin;
    const nearest = createPortalEntity(); nearest.origin = { x: 32, y: 0, z: 0 }; nearest.oldOrigin = { x: 200, y: 0, z: 0 };
    const result = portalViewForSurface(plane, null, [first, nearest], view);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected mirror");
    expect(result.origin).toEqual({ x: 64, y: 0, z: 0 });
    expect(result.axis).toEqual([{ x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
    expect(result.pvsOrigin).toEqual(first.origin); expect(result.mirror).toBe(true);
    expect(result.plane).toEqual(plane);
    expect(portalViewForSurface(plane, null, [{ ...first, origin: { x: 96.001, y: 0, z: 0 } }], view)).toBeNull();
    expect(portalViewForSurface(plane, null, [], view)).toBeNull();
  });

  test("moving inline portals match the translated unrotated plane before orienting the camera", () => {
    const model = createModelEntity(); model.origin = { x: 100, y: 200, z: 0 }; model.axis = anglesToAxis({ x: 0, y: 90, z: 0 });
    const entity = createPortalEntity(); entity.origin = { x: 132, y: 232, z: 0 }; entity.oldOrigin = entity.origin;
    const result = portalViewForSurface(plane, model, [entity], { ...view, viewOrigin: { x: 100, y: 200, z: 0 } });
    expect(result?.mirror).toBe(true);
    expect(result?.origin.x).toBeCloseTo(100, 4); expect(result?.origin.y).toBeCloseTo(264, 4);
    expect(portalViewForSurface(plane, model, [{ ...entity, origin: { x: 200, y: 232, z: 0 } }], view)).toBeNull();
  });

  test("remote views preserve PVS camera origin and source continuous, fixed and bobbing roll", () => {
    const entity = createPortalEntity(); entity.origin = { x: 32, y: 0, z: 0 }; entity.oldOrigin = { x: 200, y: 20, z: 8 };
    entity.axis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }];
    const remote = portalViewForSurface(plane, null, [entity], view);
    expect(remote?.origin).toEqual({ x: 168, y: 20, z: 8 }); expect(remote?.pvsOrigin).toEqual(entity.oldOrigin);
    expect(remote?.mirror).toBe(false); expect(remote?.axis[0]).toEqual({ x: 1, y: 0, z: 0 });
    const fixed = portalViewForSurface(plane, null, [{ ...entity, skinNum: 90 }], view);
    const continuous = portalViewForSurface(plane, null, [{ ...entity, oldFrame: 1, frame: 90 }], { ...view, time: 1000 });
    const bobbing = portalViewForSurface(plane, null, [{ ...entity, oldFrame: 1, skinNum: 90 }], view);
    expect(continuous).toEqual(fixed); expect(bobbing).toEqual(fixed);
    if (fixed === null) throw new Error("expected fixed-roll portal");
    expect(fixed.axis[1].y).toBeCloseTo(0, 6); expect(Math.abs(fixed.axis[1].z)).toBeCloseTo(1, 6);
  });

  test("offscreen rejection uses the first index of each triangle, inclusive clip boundaries, and mirror range exemption", () => {
    const vertex = (x: number, y: number, z: number): BspVertex => ({ position: { x, y, z }, normal: { x: -1, y: 0, z: 0 },
      texCoord: { x: 0, y: 0 }, lightmapCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } });
    const mesh = { vertices: [vertex(32, 0, 0), vertex(32, 4, 0), vertex(32, 0, 4)], indices: [0, 1, 2] };
    const tess = new SourceTessState(); tess.appendGeometry(mesh, "stamp");
    const project = viewProjector(view, viewProjection(view, 2048));
    expect(portalSurfaceOffscreen(tess, view.viewOrigin, project, 32, () => false)).toBe(false);
    expect(portalSurfaceOffscreen(tess, view.viewOrigin, project, 31, () => false)).toBe(true);
    expect(portalSurfaceOffscreen(tess, view.viewOrigin, project, 0, () => true)).toBe(false);
    const noPlane = (): boolean => { throw new Error("source must not evaluate the plane before rejection"); };
    tess.resetGeometry(); tess.appendGeometry({ ...mesh, vertices: mesh.vertices.map(point => ({ ...point, normal: { x: 1, y: 0, z: 0 } })) }, "stamp");
    expect(portalSurfaceOffscreen(tess, view.viewOrigin, project, 0, noPlane)).toBe(true);
    expect(portalSurfaceOffscreen(tess, view.viewOrigin, () => ({ x: 1, y: 0, z: 0, w: 1 }), 0, noPlane)).toBe(true);
    tess.resetGeometry();
    expect(portalSurfaceOffscreen(tess, view.viewOrigin, project, 0, noPlane)).toBe(true);
  });

  test("portal grid LOD consumes retained backend view and orientation", () => {
    const vertex = (x: number, y: number): BspVertex => ({ position: { x, y, z: 0 }, normal: { x: 0, y: 0, z: 1 },
      texCoord: { x, y }, lightmapCoord: { x: 0, y: 0 }, color: { x: 255, y: 255, z: 255, w: 255 } });
    const grid: PatchGrid = { lodOrigin: { x: 0, y: 0, z: 0 }, lodRadius: 10,
      mesh: { width: 3, height: 2, vertices: [vertex(0, 0), vertex(1, 0), vertex(2, 0), vertex(0, 1), vertex(1, 1), vertex(2, 1)],
        indices: [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5], widthLodError: [0, 0.25, 0], heightLodError: [0, 0] } };
    const tess = new SourceTessState();
    tess.enterView({ origin: view.viewOrigin, axis: view.viewAxis, mirror: false }, 0, view);
    tess.setEntity({ ...tess.context, orientationAxis: view.viewAxis });
    expect(portalGridGeometry(grid, tess.context, tess.view, 250).width).toBe(3);
    tess.enterView({ origin: { x: 2010, y: 0, z: 0 }, axis: view.viewAxis, mirror: false }, 0, view);
    expect(portalGridGeometry(grid, tess.context, tess.view, 250).width).toBe(2);
    tess.setEntity({ ...tess.context, orientationOrigin: { x: 2010, y: 0, z: 0 } });
    expect(portalGridGeometry(grid, tess.context, tess.view, 250).width).toBe(3);
  });

  test("homogeneous plane retains the source world halfspace through perspective and rotated view", () => {
    const rotated = cameraRefdef({ origin: { x: 18, y: 3, z: -7 }, angles: { x: 14, y: 31, z: 8 } }, 320, 240);
    const projection = viewProjection(rotated, 2048), project = viewProjector(rotated, projection);
    const equation = portalClipPlane(plane, rotated, projection);
    for (const point of [{ x: 32, y: 7, z: 0 }, { x: 20, y: -6, z: 8 }, { x: 45, y: 12, z: 3 }]) {
      const clip = project(point), actual = clip.x * equation.x + clip.y * equation.y + clip.z * equation.z + clip.w * equation.w;
      expect(actual).toBeCloseTo(dot3(point, plane.normal) - plane.distance, 4);
    }
  });

  test("MD3 probes preserve unwritten color and lightmap slots and never normalize another surface's frame index", () => {
    const vertex = (x: number): BspVertex => ({ position: { x, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 },
      texCoord: { x: 0.5, y: 0.75 }, lightmapCoord: { x: 0.25, y: 0.125 }, color: { x: 17, y: 33, z: 65, w: 129 } });
    const source: Md3Surface = { name: "probe", flags: 0, shaders: [], triangles: [{ indices: [0, 1, 2] }],
      texCoords: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      frames: [[vertex(16), vertex(17), vertex(18)], [vertex(32), vertex(33), vertex(34)]] };
    const entity = createModelEntity(); entity.frame = 1; entity.backLerp = 0.25;
    const mesh = portalMd3Geometry(source, entity), tess = new SourceTessState();
    tess.appendGeometry({ vertices: [vertex(0), vertex(0), vertex(0)], indices: [0, 1, 2] }, "stamp");
    tess.resetGeometry(); tess.appendGeometry(mesh, "md3");
    const first = tess.snapshotGeometry().vertices[0];
    expect(first?.position.x).toBe(28);
    expect(first?.lightmapCoord).toEqual({ x: 0.25, y: 0.125 });
    expect(first?.color).toEqual({ x: 17, y: 33, z: 65, w: 129 });
    expect(first?.texCoord).toEqual({ x: 0, y: 0 });
    expect(portalMd3Geometry(source, { ...entity, oldFrame: 999, backLerp: 0 }).vertices[0]?.position.x).toBe(32);
    expect(() => portalMd3Geometry(source, { ...entity, frame: 2 })).toThrow();
    const retained: SourceRefEntityRecord = { ...entity, kind: "sprite", model: -31, customShader: 12345, customSkin: -29,
      radius: 0, rotation: 0 };
    expect(portalMd3Geometry(source, retained).vertices[0]?.position.x).toBe(28);
    expect(portalMd3Geometry(source, { ...retained, kind: "portal-surface" }).vertices[0]?.position.x).toBe(28);
    expect(portalMd3Geometry(source, { ...retained, kind: "poly" }).vertices[0]?.position.x).toBe(28);
  });

  test("immediate portal beam strips close in local space and axis pairs use only the retained projector", () => {
    const beam = createBeamEntity(); beam.origin = { x: 100, y: 2, z: 3 }; beam.oldOrigin = { x: 108, y: 2, z: 3 };
    const project = (position: Vec3) => ({ ...position, w: 1 });
    const positions = portalBeamPositions(beam, project);
    expect(positions).toHaveLength(14);
    expect(positions[0]).toEqual(positions[12]); expect(positions[1]).toEqual(positions[13]);
    expect(positions).toEqual(portalBeamPositions({ ...beam, origin: { x: 0, y: 0, z: 0 }, oldOrigin: { x: 8, y: 0, z: 0 } }, project));
    expect(portalBeamPositions({ ...beam, oldOrigin: beam.origin }, project)).toEqual([]);
    expect(portalAxisPositions(position => ({ x: position.x + 2, y: position.y + 3, z: position.z + 4, w: 2 }))).toEqual([
      { x: 2, y: 3, z: 4, w: 2 }, { x: 18, y: 3, z: 4, w: 2 }, { x: 2, y: 3, z: 4, w: 2 },
      { x: 2, y: 19, z: 4, w: 2 }, { x: 2, y: 3, z: 4, w: 2 }, { x: 2, y: 3, z: 20, w: 2 },
    ]);
  });
});
