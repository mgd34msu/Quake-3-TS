// Backend world execution translated from id Software renderer/tr_backend.c,
// tr_shade.c, tr_surface.c, tr_sky.c and tr_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { BspVertex } from "../assets/bsp.ts";
import type { Md3Surface } from "../assets/md3.ts";
import type { RegisteredMd4Surface } from "./md4-resource.ts";
import { md3SurfaceSource } from "./md3-resource.ts";
import { CommonError } from "../core/common-error.ts";
import { add3, dot3, planeFromPoints, transformVec4, vec3 } from "../core/math.ts";
import type { Axis, Mat4, Plane, Vec3, Vec4 } from "../core/math.ts";
import type { SourceFlareScene } from "./flares.ts";
import type { DrawBatch, RenderClipPlane, RenderView, SourceClipProjection, SourceRenderView, SurfaceViewOperation, ViewOperation } from "./types.ts";
import type { RenderTarget } from "./commands.ts";
import type { BuiltinImages } from "./builtin-images.ts";
import type { RendererImage } from "./image-resource.ts";
import type { Refdef, RenderText } from "./refdef.ts";
import { RDF_HYPERSPACE, RDF_NOWORLDMODEL } from "./refdef.ts";
import { snapshotView, viewProjector } from "./view.ts";
import type { FrameSceneSnapshot } from "./scene-transport.ts";
import { parseFrameSceneSnapshot } from "./scene-transport.ts";
import { rendererFloatTime } from "./material-registry.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { RendererRuntimeSettings, RendererSettings } from "./settings.ts";
import { selectPatchLod } from "./patch-lod.ts";
import type { PatchGrid } from "./patch-lod.ts";
import type { SourceSkyFaceName } from "./material.ts";
import { deformGeometry, RendererNoise } from "./deform.ts";
import { snapshotSourceDebugOperations } from "./debug-draw.ts";
import { SkyBuilder } from "./sky.ts";
import { drawSun } from "./sun.ts";
import { fogCoordinates } from "./fog.ts";
import type { FogVolume } from "./fog.ts";
import type { DynamicLight, EntityLighting } from "./lighting.ts";
import { modelViewOrigin, modelWorldPoint } from "./scene-models.ts";
import type { SourceRefEntityRecord } from "./ref-entity.ts";
import { RF_DEPTHHACK } from "./ref-entity.ts";
import { railGeometry, spriteGeometry } from "./entity-primitives.ts";
import { iterateMaterialOperations, evaluateStencilShadowSurface } from "./picture-material.ts";
import { stencilShadowFinishVertices } from "./stencil-shadows.ts";
import type { SourceTessState, TessWriter } from "./tess-state.ts";
import { decomposeSourceDrawSort, SOURCE_DRAW_ENTITY_WORLD } from "./draw-surfaces.ts";
import type { SourceDrawSortRange } from "./draw-sort.ts";
import type { SourceSceneCapture } from "./scene-submission.ts";
import { portalAxisPositions, portalBeamPositions, portalEyePlane, portalGridGeometry, portalSurfaceIsMirror, portalSurfaceOffscreen, portalViewForSurface } from "./portal.ts";
import type { PortalView } from "./portal.ts";
import { iterateProjectedDlights, receivesProjectedDlights } from "./dlight.ts";

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new RangeError(`world backend index ${index} outside ${items.length}`);
  return value;
}
export interface SurfaceGeometry { readonly vertices: readonly BspVertex[]; readonly indices: readonly number[] }
export type SurfacePortalPlane = { readonly kind: "fixed"; readonly plane: Plane } | { readonly kind: "triangle" };
interface SurfaceSubmissionData {
  readonly kind: "surface";
  readonly mesh: SurfaceGeometry;
  readonly plane: SurfacePortalPlane;
  readonly grid: PatchGrid | null;
  readonly material: MaterialRecord;
  readonly fog: number;
  readonly entityOrder: number;
  readonly entity: SourceRefEntityRecord | null;
  readonly lighting: EntityLighting | null;
  readonly worldSurface?: number;
  readonly dlighted?: boolean | number;
  readonly dlightBeforeOverflow?: boolean;
}
type SurfaceSubmission = SurfaceSubmissionData & { readonly writer: "bsp-normal" | "poly" };
/** R_AddMD3Surfaces retains the source pointer without touching its mesh payload. */
interface Md3Submission {
  readonly kind: "md3";
  readonly surface: Md3Surface;
  readonly material: MaterialRecord;
  readonly entity: SourceRefEntityRecord | null;
  readonly entityOrder: number;
  readonly fog: number;
}
/** R_AddEntitySurfaces publishes the shared SF_ENTITY pointer without geometry. */
interface ProceduralSubmission {
  readonly kind: "entity";
  readonly entity: SourceRefEntityRecord | null;
  readonly material: MaterialRecord;
  readonly entityOrder: number;
  readonly fog: number;
}
/** SF_FLARE and SF_SKIP emit no geometry; sorted shader/entity state still runs. */
type EmptySubmission = Pick<SurfaceSubmissionData, "material" | "fog" | "entityOrder"> & {
  readonly kind: "flare" | "skip";
  readonly entity: SourceRefEntityRecord | null;
};
interface Md4Submission {
  readonly kind: "md4";
  readonly surface: RegisteredMd4Surface;
  readonly material: MaterialRecord;
  readonly entity: SourceRefEntityRecord | null;
  readonly entityOrder: number;
  readonly fog: number;
}
export type WorldBackendSurface = (SurfaceSubmission | ProceduralSubmission | EmptySubmission | Md3Submission | Md4Submission)
  & { readonly dlighted?: boolean | number };
export interface SceneDlights {
  readonly lights: readonly DynamicLight[];
  transformed: readonly DynamicLight[] | null;
}
export const defaultPortalPlane = { kind: "fixed", plane: { normal: { x: 1, y: 0, z: 0 }, distance: 0 } } satisfies SurfacePortalPlane;

export function trianglePortalPlane(mesh: SurfaceGeometry): Plane {
  const plane = planeFromPoints(at(mesh.vertices, at(mesh.indices, 0)).position,
    at(mesh.vertices, at(mesh.indices, 1)).position, at(mesh.vertices, at(mesh.indices, 2)).position);
  if (plane === null) throw new Error("R_PlaneForSurface: degenerate portal triangle has an undefined source plane distance");
  return plane;
}


export interface WorldBackendWorld {
  readonly fogs: readonly FogVolume[];
  readonly fogTexture: RendererImage | null;
}
export interface WorldBackendResolvedView {
  readonly smpFrame: 0 | 1;
  readonly refdef: Readonly<Refdef>;
  readonly projection: Mat4;
  readonly mirror: boolean;
  readonly portal: PortalView | null;
  readonly viewFar: number;
  readonly polygonOffset?: { readonly factor: number; readonly units: number };
  readonly scene: SourceFlareScene;
  readonly capture: SourceSceneCapture;
  readonly dlights: SceneDlights;
  readonly world: WorldBackendWorld;
  readonly drawRange: SourceDrawSortRange;
  readonly flushBeforeView: boolean;
  surface(index: number): WorldBackendSurface;
  surfaceDlightBits(index: number, smpFrame: 0 | 1): number;
}
export interface WorldBackendView {
  readonly worldId: number;
  readonly refdef: Readonly<Refdef>;
  readonly projection: Mat4;
  readonly mirror: boolean;
  readonly portal: PortalView | null;
  readonly viewFar: number;
  readonly polygonOffset: { readonly factor: number; readonly units: number } | null;
  readonly sceneFrame: SourceFlareScene;
  readonly smpFrame: 0 | 1;
  readonly flushBeforeView: boolean;
  readonly drawSurfaces: readonly { readonly sort: number; readonly surfaceId: number }[];
  readonly sceneMemory: FrameSceneSnapshot;
  readonly dynamicLights: readonly DynamicLight[];
  readonly transformedDynamicLights: readonly DynamicLight[] | null;
  readonly surfaceDlightBits: readonly { readonly surface: number; readonly bits: readonly [number, number] }[];
}
export interface WorldBackendSender {
  world(world: WorldBackendWorld): number;
  surface(surface: WorldBackendSurface): number;
  scene(scene: SourceSceneCapture): FrameSceneSnapshot;
}
export interface WorldBackendReceiver {
  world(id: number): WorldBackendWorld;
  surface(id: number): WorldBackendSurface;
  scene(snapshot: FrameSceneSnapshot): SourceSceneCapture;
}
export interface WorldBackendTransport {
  capture(view: WorldBackendResolvedView, executionRange?: SourceDrawSortRange): WorldBackendView;
  /** Executes on the retained backend after the renderer's synchronous worker barrier. */
  probe(view: WorldBackendResolvedView, surfaceIndex: number): PortalView | null;
  initializeSky(height: number): void;
  drawSun(direction: Vec3): void;
  beginDebugSurface(): void;
  debugPolygon(color: number, numPoints: number, points: readonly Vec3[]): void;
}
function isPacketRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function packetRecord(value: unknown): Record<string, unknown> {
  if (!isPacketRecord(value)) throw new TypeError("World backend packet requires a record");
  return value;
}
function packetArray(value: unknown, length: number | null = null): readonly unknown[] {
  if (!isPacketArray(value) || length !== null && value.length !== length)
    throw new TypeError("World backend packet has an invalid array");
  return value;
}
function isPacketArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function packetNumber(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("World backend packet requires a number");
  return value;
}
function packetInteger(value: unknown, min: number, max: number): number {
  const number = packetNumber(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new RangeError("World backend packet integer is outside its range");
  return number;
}
function packetBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("World backend packet requires a boolean");
  return value;
}
function packetString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("World backend packet requires a string");
  return value;
}
function packetVector(value: unknown): Vec3 {
  const input = packetRecord(value);
  return { x: packetNumber(input["x"]), y: packetNumber(input["y"]), z: packetNumber(input["z"]) };
}
function packetAxis(value: unknown): Axis {
  const input = packetArray(value, 3);
  return [packetVector(input[0]), packetVector(input[1]), packetVector(input[2])];
}
function packetProjection(value: unknown): Mat4 {
  const input = packetArray(value, 16);
  return [packetNumber(input[0]), packetNumber(input[1]), packetNumber(input[2]), packetNumber(input[3]),
    packetNumber(input[4]), packetNumber(input[5]), packetNumber(input[6]), packetNumber(input[7]),
    packetNumber(input[8]), packetNumber(input[9]), packetNumber(input[10]), packetNumber(input[11]),
    packetNumber(input[12]), packetNumber(input[13]), packetNumber(input[14]), packetNumber(input[15])];
}
function packetRefdef(value: unknown): Readonly<Refdef> {
  const input = packetRecord(value), rows = packetArray(input["text"], 8), mask = input["areaMask"];
  if (!(mask instanceof Uint8Array) || mask.length !== 32) throw new TypeError("World backend packet requires 32 area-mask bytes");
  const text: RenderText = [packetString(rows[0]), packetString(rows[1]), packetString(rows[2]), packetString(rows[3]),
    packetString(rows[4]), packetString(rows[5]), packetString(rows[6]), packetString(rows[7])];
  return snapshotView({ x: packetNumber(input["x"]), y: packetNumber(input["y"]),
    width: packetNumber(input["width"]), height: packetNumber(input["height"]),
    fovX: packetNumber(input["fovX"]), fovY: packetNumber(input["fovY"]),
    viewOrigin: packetVector(input["viewOrigin"]), viewAxis: packetAxis(input["viewAxis"]),
    time: packetNumber(input["time"]), renderFlags: packetNumber(input["renderFlags"]), areaMask: mask, text });
}
function packetPortal(value: unknown): PortalView | null {
  if (value === null) return null;
  const input = packetRecord(value), plane = packetRecord(input["plane"]);
  return { origin: packetVector(input["origin"]), axis: packetAxis(input["axis"]), pvsOrigin: packetVector(input["pvsOrigin"]),
    mirror: packetBoolean(input["mirror"]), plane: { normal: packetVector(plane["normal"]), distance: packetNumber(plane["distance"]) } };
}
function packetLights(value: unknown): readonly DynamicLight[] {
  return packetArray(value).map(value => {
    const light = packetRecord(value), additive = light["additive"];
    return { origin: packetVector(light["origin"]), color: packetVector(light["color"]), radius: packetNumber(light["radius"]),
      ...(additive === undefined ? {} : { additive: packetBoolean(additive) }) };
  });
}
/** Untrusted worker messages narrow before any retained backend state changes. */
export function parseWorldBackendView(value: unknown): WorldBackendView {
  const input = packetRecord(value), scene = packetRecord(input["sceneFrame"]), frame = input["smpFrame"];
  if (frame !== 0 && frame !== 1) throw new RangeError("World backend packet requires SMP bank zero or one");
  const polygon = input["polygonOffset"] === null ? null : packetRecord(input["polygonOffset"]);
  return {
    worldId: packetInteger(input["worldId"], 1, Number.MAX_SAFE_INTEGER), refdef: packetRefdef(input["refdef"]),
    projection: packetProjection(input["projection"]), mirror: packetBoolean(input["mirror"]), portal: packetPortal(input["portal"]),
    viewFar: packetNumber(input["viewFar"]), polygonOffset: polygon === null ? null : {
      factor: packetNumber(polygon["factor"]), units: packetNumber(polygon["units"]) },
    sceneFrame: { frameCount: packetInteger(scene["frameCount"], -0x80000000, 0x7fffffff),
      frameSceneNum: packetInteger(scene["frameSceneNum"], -0x80000000, 0x7fffffff) }, smpFrame: frame,
    flushBeforeView: packetBoolean(input["flushBeforeView"]),
    drawSurfaces: packetArray(input["drawSurfaces"]).map(value => {
      const surface = packetRecord(value);
      return { sort: packetInteger(surface["sort"], 0, 0xffffffff), surfaceId: packetInteger(surface["surfaceId"], 1, Number.MAX_SAFE_INTEGER) };
    }),
    sceneMemory: parseFrameSceneSnapshot(input["sceneMemory"]), dynamicLights: packetLights(input["dynamicLights"]),
    transformedDynamicLights: input["transformedDynamicLights"] === null ? null : packetLights(input["transformedDynamicLights"]),
    surfaceDlightBits: packetArray(input["surfaceDlightBits"]).map(value => {
      const surface = packetRecord(value), bits = packetArray(surface["bits"], 2);
      return { surface: packetInteger(surface["surface"], 0, 0x7fffffff),
        bits: [packetInteger(bits[0], -0x80000000, 0x7fffffff), packetInteger(bits[1], -0x80000000, 0x7fffffff)] satisfies readonly [number, number] };
    }),
  };
}
function copyLight(light: DynamicLight): DynamicLight {
  return { origin: { ...light.origin }, color: { ...light.color }, radius: light.radius,
    ...(light.additive === undefined ? {} : { additive: light.additive }) };
}
/** Capture only owned transport values; geometry writers run in prepare/probe. */
export function captureWorldBackendView(view: WorldBackendResolvedView, sender: WorldBackendSender,
  executionRange: SourceDrawSortRange = view.drawRange): WorldBackendView {
  const masks = new Map<number, readonly [number, number]>();
  const drawSurfaces = Array.from({ length: executionRange.length }, (_, index) => {
    const surface = view.surface(index);
    if (surface.kind === "surface" && surface.worldSurface !== undefined)
      masks.set(surface.worldSurface, [view.surfaceDlightBits(surface.worldSurface, 0), view.surfaceDlightBits(surface.worldSurface, 1)]);
    return { sort: executionRange.getSort(index), surfaceId: sender.surface(surface) };
  });
  const portal = view.portal;
  return {
    worldId: sender.world(view.world), refdef: snapshotView(view.refdef), projection: [...view.projection],
    mirror: view.mirror, portal: portal === null ? null : {
      origin: { ...portal.origin }, axis: [{ ...portal.axis[0] }, { ...portal.axis[1] }, { ...portal.axis[2] }],
      pvsOrigin: { ...portal.pvsOrigin }, mirror: portal.mirror,
      plane: { normal: { ...portal.plane.normal }, distance: portal.plane.distance },
    },
    viewFar: view.viewFar, polygonOffset: view.polygonOffset === undefined ? null : { ...view.polygonOffset },
    sceneFrame: { ...view.scene }, smpFrame: view.smpFrame, flushBeforeView: view.flushBeforeView,
    drawSurfaces, sceneMemory: sender.scene(view.capture),
    dynamicLights: view.dlights.lights.map(copyLight),
    transformedDynamicLights: view.dlights.transformed?.map(copyLight) ?? null,
    surfaceDlightBits: Array.from(masks, ([surface, bits]) => ({ surface, bits })),
  };
}
export function resolveWorldBackendView(packet: WorldBackendView, resources: WorldBackendReceiver): WorldBackendResolvedView {
  const surfaces = packet.drawSurfaces.map(surface => ({ ...surface }));
  const drawRange: SourceDrawSortRange = {
    length: surfaces.length,
    getSort(index) { return at(surfaces, index).sort; },
    setSort(index, value) { at(surfaces, index).sort = value; },
    swap(first, second) {
      const a = at(surfaces, first), b = at(surfaces, second);
      surfaces[first] = b; surfaces[second] = a;
    },
  };
  const masks = new Map(packet.surfaceDlightBits.map(entry => [entry.surface, entry.bits] satisfies [number, readonly [number, number]]));
  return {
    refdef: packet.refdef, projection: packet.projection, mirror: packet.mirror, portal: packet.portal,
    viewFar: packet.viewFar, ...(packet.polygonOffset === null ? {} : { polygonOffset: packet.polygonOffset }),
    smpFrame: packet.smpFrame, scene: packet.sceneFrame, capture: resources.scene(packet.sceneMemory),
    dlights: { lights: packet.dynamicLights, transformed: packet.transformedDynamicLights },
    world: resources.world(packet.worldId), drawRange, flushBeforeView: packet.flushBeforeView,
    surface: index => resources.surface(at(surfaces, index).surfaceId),
    surfaceDlightBits(index, smpFrame) {
      const bits = masks.get(index);
      if (bits === undefined) throw new RangeError(`World backend surface ${index} has no captured dynamic-light mask`);
      return bits[smpFrame];
    },
  };
}
export interface WorldBackendServices {
  readonly debugBuild?: boolean;
  readonly tess: SourceTessState;
  readonly settings: Pick<RendererSettings, "runtime" | "flares" | "rail">;
  readonly builtins: Pick<BuiltinImages, "defaultImage" | "find">;
  readonly identityLight: () => number;
  readonly print: (text: string) => undefined;
  readonly target: Pick<RenderTarget, "height" | "stencilBits" | "executeSurfaceOperations">;
  readonly defaultMaterial: MaterialRecord;
  readonly flareMaterial: MaterialRecord;
  readonly sunMaterial: MaterialRecord;
  materialBySortedIndex(index: number): MaterialRecord | null;
}
export interface WorldBackendRuntime {
  prepare(view: WorldBackendView, resources: WorldBackendReceiver): Iterable<SourceRenderView, unknown, unknown>;
  probe(view: WorldBackendView, surfaceIndex: number, resources: WorldBackendReceiver): PortalView | null;
  prepareResolved(view: WorldBackendResolvedView, executionRange?: SourceDrawSortRange): SourceRenderView;
  probeResolved(view: WorldBackendResolvedView, submission: WorldBackendSurface): PortalView | null;
  initializeSky(height: number): void;
  drawSun(direction: Vec3): Iterable<SurfaceViewOperation, unknown, unknown>;
  beginDebugSurface(): Iterable<SurfaceViewOperation, unknown, unknown>;
  debugPolygon(color: number, numPoints: number, points: readonly Vec3[]): Iterable<SurfaceViewOperation, unknown, unknown>;
}
export function createWorldBackendRuntime(services: WorldBackendServices): WorldBackendRuntime {
  const { tess, settings, builtins: builtinImages } = services;
  const performance = tess.performance;
  const fallback = builtinImages.defaultImage;
  const white = builtinImages.find("*white");
  if (white === undefined) throw new Error("Renderer builtin white image was not initialized");
  const whiteImage = white.image;
  const noise = new RendererNoise();
  const skyBuilder = new SkyBuilder();
  let backendFar = 0;
  let skyRenderedThisView = false;
  let backendSunProjector = tess.projector;
  let backendEntityInitialized = false;
  let backendDlights: SceneDlights | null = null;
  let backendPolygonOffset: WorldBackendResolvedView["polygonOffset"];
  function* evaluateWorldSurface(dlightBits: number, identityLight: number, rendererNoise: RendererNoise, runtime: RendererRuntimeSettings): Generator<SurfaceViewOperation, void, unknown> {
    if (tess.numIndexes === 0) return;
    const material = tess.material;
    if (material === null) throw new Error("Retained world surface has no begun material");
    if (material.kind === "stencil-shadow") {
      yield* evaluateStencilShadowSurface(tess, position => tess.projectPosition(position), services.target.stencilBits);
      return;
    }
    const debugSort = runtime.debugSort;
    if (debugSort !== 0 && debugSort < material.sort) return;
    performance.backEnd.c_shaders = (performance.backEnd.c_shaders + 1) | 0;
    performance.backEnd.c_vertexes = (performance.backEnd.c_vertexes + tess.numVertexes) | 0;
    performance.backEnd.c_indexes = (performance.backEnd.c_indexes + tess.numIndexes) | 0;
    performance.backEnd.c_totalIndexes = (performance.backEnd.c_totalIndexes + tess.numIndexes * material.finished.numUnfoggedPasses) | 0;
    const definition = material.definition, entity = tess.context.entity;
    const sky = material.finished.iterator.kind === "sky" ? material.sky : null;
    if (material.finished.iterator.kind === "sky" && sky === null) throw new Error(`${material.name}: sky iterator has no registered sky data`);
    const projectVertex = (position: Vec3): Vec4 => tess.projectPosition(position);
    let input = dlightBits === 0 ? null : tess.snapshotGeometry();
    if (sky !== null) {
      if (settings.runtime.fastSky !== 0) {
        yield* snapshotSourceDebugOperations(tess, projectVertex, material.whiteImage, runtime);
        tess.endSurface();
        yield { kind: "log-comment", text: "----------\n" };
        return;
      }
      // RB_ClipSkyPolygons subtracts the world view origin from local tess cells,
      // even on entities. Box translation/cloud positions then use the current projector.
      skyBuilder.clip([tess.snapshotIndexedGeometry()], tess.view.origin);
      const depth = settings.runtime.showSky !== 0 ? 0 : 1;
      tess.setDepthRange([depth, depth]);
      yield { kind: "depth-range", range: tess.actualDepthRange };
      const skyMesh = skyBuilder.build(tess.view.origin, backendFar);
      const drawFaces: readonly SourceSkyFaceName[] = ["rt", "lf", "bk", "ft", "up", "dn"];
      if (sky.outer !== null && sky.outer.image("rt").image !== fallback) {
        yield { kind: "sky-box-state", identityLight };
        for (const face of skyMesh.box) {
          const registered = sky.outer.image(at(drawFaces, face.face));
          yield { kind: "sky-side", image: registered.image, strips: face.strips.map(strip => strip.map(index => {
            const vertex = at(face.geometry.vertices, index);
            return { position: projectVertex(vertex.position), texCoord: vertex.texCoord };
          })) };
        }
      }
      tess.resetGeometry();
      if (sky.cloudHeight !== 0) for (let stage = 0; stage < material.finished.numUnfoggedPasses; stage++) {
        tess.appendGeometry({ vertices: skyMesh.clouds.vertices, indices: stage === 0 ? skyMesh.clouds.indices : [] }, "cloud");
      }
      input = dlightBits === 0 ? null : tess.snapshotGeometry();
    }
    const deformed = definition === null || definition.deforms.length === 0 ? input : deformGeometry(tess, definition.deforms,
      { axis: tess.view.axis, mirror: tess.view.mirror, entityAxis: tess.context.kind === "world" ? null : tess.context.orientationAxis,
        nonNormalizedAxis: entity !== null && "nonNormalizedAxes" in entity && entity.nonNormalizedAxes ? entity.axis[0] : null }, tess.shaderTime, rendererNoise,
      entity !== null && "shadowPlane" in entity ? { axis: tess.context.orientationAxis, origin: tess.context.orientationOrigin, shadowPlane: entity.shadowPlane,
        lightDir: tess.context.lighting.lightDir } : null);
    const projectedLights = function* (): Generator<DrawBatch, void, unknown> {
      if (dlightBits === 0 || deformed === null || !receivesProjectedDlights(material) || backendDlights === null || backendDlights.lights.length === 0) return;
      const image = builtinImages.find("*dlight");
      if (image === undefined) throw new Error("source dynamic-light image is not registered");
      if (backendDlights.transformed === null) throw new Error("source projected light origins have not been transformed");
      for (let index = 0; index < backendDlights.transformed.length; index++) {
        const mask = dlightBits & (1 << index);
        if (mask !== 0) yield* iterateProjectedDlights(deformed, mask, backendDlights.transformed, image.image, projectVertex,
          tess.actualCullState, performance);
      }
    };
    yield* iterateMaterialOperations(material, tess, projectVertex, identityLight, rendererNoise,
      runtime, projectedLights(), backendPolygonOffset);
    if (sky !== null) {
      tess.setDepthRange([0, 1]);
      yield { kind: "depth-range", range: tess.actualDepthRange };
      skyRenderedThisView = true;
    }
    yield* snapshotSourceDebugOperations(tess, projectVertex, material.whiteImage, runtime);
    tess.endSurface();
    yield { kind: "log-comment", text: "----------\n" };
  }

  function* flushRetainedSurface(): Generator<SurfaceViewOperation, void, unknown> {
    if (tess.numIndexes === 0) return;
    if (tess.material?.kind === "stencil-shadow") yield* evaluateStencilShadowSurface(tess, position => tess.projectPosition(position), services.target.stencilBits);
    else yield* evaluateWorldSurface(tess.dlightBits, services.identityLight(), noise, settings.runtime);
  }

  function prepareResolved(view: WorldBackendResolvedView, executionRange?: SourceDrawSortRange): SourceRenderView {

    const { refdef, projection, mirror, portal, viewFar, capture, dlights, drawRange } = view;
    const { fogs, fogTexture } = view.world;
    const entityRange = capture.entities;
    const dynamicLights = dlights.lights;
    const project = viewProjector(refdef, projection);
    const viewAxis = refdef.viewAxis;
    const fogCoords = fogs.map(fog => fogCoordinates(fog, refdef.viewOrigin, viewAxis[0]));
    const backendSurfaceDlightBits = (index: number): number => view.surfaceDlightBits(index, tess.backEndSmpFrame);

    const readDrawSurface = (index: number, sorts: SourceDrawSortRange): WorldBackendSurface => {
      const fields = decomposeSourceDrawSort(sorts.getSort(index));
      const material = services.materialBySortedIndex(fields.shader);
      if (material === null) throw new RangeError(`R_DecomposeSort: sorted shader ${fields.shader} has no allocated shader`);
      const entity = fields.entity === SOURCE_DRAW_ENTITY_WORLD ? null : entityRange.allocatedEntity(fields.entity).entity;
      return { ...view.surface(index), material, entity, entityOrder: fields.entity, fog: fields.fog - 1, dlighted: fields.dlight };
    };
    const noWorld = (refdef.renderFlags & RDF_NOWORLDMODEL) !== 0;
      const originalTime = rendererFloatTime(refdef.time);
      const worldAxis = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] satisfies import("../core/math.ts").Axis;
      const enterView = function* (): Generator<SurfaceViewOperation, void, unknown> {
        if (view.flushBeforeView) yield* flushRetainedSurface();
        backendFar = viewFar;
        backendSunProjector = viewProjector(refdef, projection, { origin: refdef.viewOrigin, axis: worldAxis });
        backendDlights = dlights;
        backendPolygonOffset = view.polygonOffset;
        tess.enterView({ origin: refdef.viewOrigin, axis: viewAxis, mirror }, originalTime, refdef);
      };
      const drawView = function* (executionRange: SourceDrawSortRange): Generator<ViewOperation, void, unknown> {
      if ((refdef.renderFlags & RDF_HYPERSPACE) === 0) {
        tess.invalidateCull();
        skyRenderedThisView = false;
      }
      backendEntityInitialized = true;
      tess.setProjector(project);
      tess.selectWorldEntity(tess.context);
      performance.backEnd.c_surfaces = (performance.backEnd.c_surfaces + executionRange.length) | 0;
      const flushSurface = function* (): Generator<SurfaceViewOperation, void, unknown> {
        if (tess.numIndexes === 0) return;
        if (tess.fog > 0) {
          if (fogTexture === null) throw new Error("fogged source surface has no registered world fog texture");
          const fog = tess.fog - 1, coordinates = at(fogCoords, fog), context = tess.context;
          const currentEntity = context.kind === "entity" ? context.entity : null;
          tess.setFogContext({ volume: at(fogs, fog), texture: fogTexture,
            coordinates: currentEntity?.kind === "model" ? position => coordinates(modelWorldPoint(currentEntity, position)) : coordinates });
        }
        yield* flushRetainedSurface();
      };
      const restartSurface = function* (): Generator<SurfaceViewOperation, void, unknown> {
        const material = tess.material, fog = tess.fog;
        if (material === null) throw new Error("RB_CheckOverflow without a begun source shader");
        yield* flushSurface();
        tess.beginSurface(material, fog, tess.floatTime);
      };
      const checkOverflow = function* (vertices: number, indices: number): Generator<SurfaceViewOperation, void, unknown> {
        if (vertices >= 1000 || indices >= 6000) {
          yield* flushSurface();
          if (vertices >= 1000) throw new CommonError("drop", `RB_CheckOverflow: verts > MAX (${vertices} > 1000)`);
          throw new CommonError("drop", `RB_CheckOverflow: indices > MAX (${indices} > 6000)`);
        }
        if (tess.numVertexes + vertices >= 1000 || tess.numIndexes + indices >= 6000) yield* restartSurface();
      };
      const writeGeometry = (mesh: SurfaceGeometry, writer: TessWriter): void => {
        const material = tess.material;
        tess.appendGeometry(mesh, writer === "bsp-normal" && (material === services.defaultMaterial || material?.kind === "stencil-shadow") ? "bsp" : writer);
      };
      let oldMaterial: MaterialRecord | null = null;
      let oldFog = -1, oldDlighted = 0, oldDlightEntity = -1, oldDepthRange = false, depthHack = false;
      // RB_RenderDrawSurfList selects shader/entity state before calling the surface writer.
      for (let index = 0; index < executionRange.length; index++) {
        const submission = readDrawSurface(index, executionRange), dlighted = Number(submission.dlighted ?? false);
        if (submission.material !== oldMaterial || submission.fog !== oldFog || dlighted !== oldDlighted
          || (submission.entityOrder !== oldDlightEntity && !submission.material.definition?.entityMergable)) {
          if (oldMaterial !== null) yield* flushSurface();
          tess.beginSurface(submission.material, submission.fog + 1, tess.floatTime);
          oldMaterial = submission.material; oldFog = submission.fog; oldDlighted = dlighted;
        }
        if (submission.entityOrder !== oldDlightEntity) {
          oldDlightEntity = submission.entityOrder;
          const drawEntity = submission.entity;
          const orientation = { localViewOrigin: drawEntity?.kind === "model" ? modelViewOrigin(drawEntity, refdef.viewOrigin) : refdef.viewOrigin,
            orientationAxis: drawEntity?.kind === "model" ? drawEntity.axis : worldAxis,
            orientationOrigin: drawEntity?.kind === "model" ? drawEntity.origin : { x: 0, y: 0, z: 0 } };
          if (drawEntity === null) tess.selectWorldEntity(orientation);
          else tess.selectSceneEntity(entityRange.allocatedEntity(submission.entityOrder), orientation);
          tess.setFloatTime(Math.fround(originalTime - Math.fround(drawEntity?.shaderTime ?? 0)));
          const material = tess.material;
          if (material === null) throw new Error("RB_RenderDrawSurfList entity selection without a begun source shader");
          tess.setShaderTime(tess.floatTime - material.timeOffset);
          tess.setProjector(drawEntity?.kind === "model" ? viewProjector(refdef, projection, drawEntity) : project);
          if (submission.entity === null) dlights.transformed = dynamicLights.length === 0 ? [] : capture.transformDlights({ x: 0, y: 0, z: 0 }, worldAxis);
          else if (entityRange.allocatedEntity(submission.entityOrder).needDlights && submission.entity.kind === "model") {
            dlights.transformed = dynamicLights.length === 0 ? [] : capture.transformDlights(submission.entity.origin, submission.entity.axis);
          }
          depthHack = submission.entity !== null && (submission.entity.renderFlags & RF_DEPTHHACK) !== 0;
          if (oldDepthRange !== depthHack) {
            tess.setDepthRange([0, depthHack ? 0.3 : 1]);
            oldDepthRange = depthHack;
            yield { kind: "depth-range", range: tess.actualDepthRange };
          }
        }
        if (submission.kind === "md3") {
          switch (md3SurfaceSource(submission.surface).surfaceType) {
            case 0: services.print("Bad surface tesselated.\n"); break;
            case 1: case 8: break;
            case 6: yield* tess.appendMd3(submission.surface, flushSurface); break;
            default: throw new Error("RB_SurfaceMesh: unsupported dispatch through retained MD3 surface allocation");
          }
        } else if (submission.kind === "md4") {
          const surfaceType = submission.surface.surfaceType;
          switch (surfaceType) {
            case 0: services.print("Bad surface tesselated.\n"); break;
            case 1: case 8: break;
            default:
              if (surfaceType === 7) yield* checkOverflow(submission.surface.numVerts, submission.surface.numIndexes);
              tess.appendMd4(submission.surface);
              break;
          }
        } else if (submission.kind === "surface") {
          if (submission.grid !== null) {
            if (submission.worldSurface !== undefined) tess.addDlightBits(backendSurfaceDlightBits(submission.worldSurface));
            const grid = submission.grid;
            const worldOrigin = submission.entity?.kind === "model" ? modelWorldPoint(submission.entity, grid.lodOrigin) : grid.lodOrigin;
            const mesh = selectPatchLod(grid, worldOrigin, refdef.viewOrigin, refdef.viewAxis[0], settings.runtime.lodCurveError);
            let used = 0;
            while (used < mesh.height - 1) {
              const vrows = Math.trunc((1000 - tess.numVertexes) / mesh.width), irows = Math.trunc((6000 - tess.numIndexes) / (mesh.width * 6));
              if (vrows < 2 || irows < 1) { yield* restartSurface(); continue; }
              const rows = Math.min(irows, vrows - 1, mesh.height - used);
              writeGeometry({ vertices: mesh.vertices.slice(used * mesh.width, (used + rows) * mesh.width),
                indices: mesh.indices.slice(used * (mesh.width - 1) * 6, (used + rows - 1) * (mesh.width - 1) * 6).map(index => index - used * mesh.width) }, submission.writer);
              used += rows - 1;
            }
          } else {
            const mesh = submission.mesh;
            if (submission.dlightBeforeOverflow === true && submission.worldSurface !== undefined)
              tess.addDlightBits(backendSurfaceDlightBits(submission.worldSurface));
            yield* checkOverflow(mesh.vertices.length, submission.writer === "poly" ? 3 * (mesh.vertices.length - 2) : mesh.indices.length);
            if (submission.dlightBeforeOverflow !== true && submission.worldSurface !== undefined)
              tess.addDlightBits(backendSurfaceDlightBits(submission.worldSurface));
            writeGeometry(mesh, submission.writer);
          }
        } else if (submission.kind === "entity") {
          const entity = tess.context.entity;
          if (entity?.kind === "sprite") {
            const mesh = spriteGeometry(entity, tess.view.axis, tess.view.mirror);
            yield* checkOverflow(4, 6);
            writeGeometry(mesh, "stamp");
          } else if (entity?.kind === "rail-core" || entity?.kind === "rail-rings" || entity?.kind === "lightning") {
            const mesh = railGeometry(entity, tess.view.origin, settings.rail);
            for (let vertex = 0; vertex < mesh.vertices.length; vertex += 4) {
              yield* checkOverflow(4, 6);
              writeGeometry({ vertices: mesh.vertices.slice(vertex, vertex + 4),
                indices: mesh.indices.slice(vertex / 4 * 6, vertex / 4 * 6 + 6).map(value => value - vertex) }, "rail");
            }
          } else if (entity?.kind === "beam") {
            const positions = portalBeamPositions(entity, position => tess.projectPosition(position));
            if (positions.length !== 0) yield { kind: "entity-beam", positions, whiteImage };
          } else yield { kind: "entity-axis", positions: portalAxisPositions(position => tess.projectPosition(position)), whiteImage };
        }
      }
      tess.setFloatTime(originalTime);
      if (oldMaterial !== null) yield* flushSurface();
      tess.setProjector(project);
      if (depthHack) {
        tess.setDepthRange([0, 1]);
        yield { kind: "depth-range", range: tess.actualDepthRange };
      }
      if (settings.runtime.shadows === 2 && services.target.stencilBits >= 4) {
        tess.setActualCull("none");
        tess.setProjector(position => transformVec4(projection, { ...position, w: 1 }));
        yield { kind: "shadow-finish", positions: stencilShadowFinishVertices(projection), whiteImage };
      }
      yield { kind: "render-flares", render: depth => tess.flares.renderFlares({ ...view.scene,
        inPortal: portal !== null, time: refdef.time, origin: refdef.viewOrigin, projection,
        viewport: { x: refdef.x, y: services.target.height - refdef.y - refdef.height, width: refdef.width, height: refdef.height } },
      settings.flares, depth, { tess, shader: services.flareMaterial, get identityLight() { return services.identityLight(); },
        endSurface: flushSurface, *disablePortalClip() { yield { kind: "disable-portal-clip" }; } }) };
      };
      const clipProjection: SourceClipProjection = [projection[0], projection[5], projection[10], projection[14]];
      const clipPlane: RenderClipPlane | undefined = (refdef.renderFlags & RDF_HYPERSPACE) !== 0
        ? { kind: "retain", projection: clipProjection }
        : portal === null ? undefined : { kind: "portal", eyePlane: portalEyePlane(portal.plane, refdef), projection: clipProjection };
      return { viewport: { x: refdef.x, y: refdef.y, width: refdef.width, height: refdef.height },
        ...(clipPlane === undefined ? {} : { clipPlane }),
        get clear(): RenderView["clear"] {
          const stencil = settings.runtime.measureOverdraw !== 0 || settings.runtime.shadows === 2;
          const fastSky = settings.runtime.fastSky !== 0 && !noWorld;
          const gray = Math.fround((refdef.time & 255) / 255);
          return { depth: 1, stencil, color: (refdef.renderFlags & RDF_HYPERSPACE) !== 0 ? { x: gray, y: gray, z: gray, w: 1 }
            : fastSky ? services.debugBuild === true
              ? { x: Math.fround(0.8), y: Math.fround(0.7), z: Math.fround(0.4), w: 1 }
              : { x: 0, y: 0, z: 0, w: 1 } : null };
        },
        beforeView: enterView(), operations: drawView(executionRange ?? drawRange) };

  }
  function probeResolved(view: WorldBackendResolvedView, submission: WorldBackendSurface): PortalView | null {

    const { refdef, projection, capture } = view;
    const { fogs, fogTexture } = view.world;
    const entityRange = capture.entities;
    const project = viewProjector(refdef, projection);
    const backendSurfaceDlightBits = (index: number): number => view.surfaceDlightBits(index, tess.backEndSmpFrame);
    const entities = Array.from({ length: entityRange.length }, (_, index) => entityRange.entity(index).entity);
        tess.beginSurface(submission.material, submission.fog + 1, tess.floatTime);
        if (submission.fog >= 0 && submission.kind !== "flare") {
          if (fogTexture === null) throw new Error("fogged source portal probe has no registered world fog texture");
          const fog = at(fogs, submission.fog), coordinates = fogCoordinates(fog, tess.view.origin, tess.view.axis[0]);
          const { orientationAxis: axis, orientationOrigin: origin } = tess.context;
          tess.setFogContext({ volume: fog, texture: fogTexture,
            coordinates: position => coordinates(add3(vec3(
              dot3(position, { x: axis[0].x, y: axis[1].x, z: axis[2].x }),
              dot3(position, { x: axis[0].y, y: axis[1].y, z: axis[2].y }),
              dot3(position, { x: axis[0].z, y: axis[1].z, z: axis[2].z })), origin)) });
        }
        const entitySurface = submission.kind === "entity";
        if ((entitySurface || submission.kind === "md4" && submission.surface.surfaceType === 7) && tess.context.entity === null && !backendEntityInitialized) {
          throw new Error("SurfIsOffscreen: source backEnd.currentEntity is NULL before the first backend entity selection");
        }
        if (entitySurface) {
          const retained = tess.context.entity;
          if (retained?.kind === "sprite") tess.appendGeometry(spriteGeometry(retained, tess.view.axis, tess.view.mirror), "stamp");
          else if (retained?.kind === "rail-core" || retained?.kind === "rail-rings" || retained?.kind === "lightning") {
            const mesh = railGeometry(retained, tess.view.origin, settings.rail);
            for (let vertex = 0; vertex < mesh.vertices.length; vertex += 4) {
              if (tess.wouldOverflow(4, 6)) {
                const material = tess.material;
                if (material === null) throw new Error("portal rail overflow without a begun source shader");
                const fog = tess.fog;
                services.target.executeSurfaceOperations(flushRetainedSurface());
                tess.beginSurface(material, fog, tess.floatTime);
              }
              tess.appendGeometry({ vertices: mesh.vertices.slice(vertex, vertex + 4),
                indices: mesh.indices.slice(vertex / 4 * 6, vertex / 4 * 6 + 6).map(index => index - vertex) }, "rail");
            }
          } else if (retained?.kind === "beam") {
            const positions = portalBeamPositions(retained, position => tess.projectPosition(position));
            if (positions.length !== 0) services.target.executeSurfaceOperations([{ kind: "entity-beam", positions, whiteImage }]);
          } else services.target.executeSurfaceOperations([{ kind: "entity-axis", positions: portalAxisPositions(position => tess.projectPosition(position)), whiteImage }]);
        } else if (submission.kind === "md3") {
          switch (md3SurfaceSource(submission.surface).surfaceType) {
            case 0: services.print("Bad surface tesselated.\n"); break;
            case 1: case 8: break;
            case 6: services.target.executeSurfaceOperations(tess.appendMd3(submission.surface, flushRetainedSurface)); break;
            default: throw new Error("SurfIsOffscreen: unsupported dispatch through retained MD3 surface allocation");
          }
        } else if (submission.kind === "md4") {
          switch (submission.surface.surfaceType) {
            case 0: services.print("Bad surface tesselated.\n"); break;
            case 1: case 8: break;
            default: tess.appendMd4(submission.surface); break;
          }
        } else if (submission.kind === "surface") {
          const mesh = submission.grid === null ? submission.mesh : portalGridGeometry(submission.grid, tess.context, tess.view, settings.runtime.lodCurveError);
          const probeMaterial = tess.material;
          tess.appendGeometry(mesh, submission.writer === "bsp-normal" && (probeMaterial === services.defaultMaterial || probeMaterial?.kind === "stencil-shadow") ? "bsp" : submission.writer);
          if (submission.worldSurface !== undefined) tess.addDlightBits(backendSurfaceDlightBits(submission.worldSurface));
        }
        const surfacePlane = (): Plane => submission.kind !== "surface" ? defaultPortalPlane.plane
          : submission.plane.kind === "fixed" ? submission.plane.plane : trianglePortalPlane(submission.mesh);
        const model = submission.entity?.kind === "model" ? submission.entity : null;
        if (portalSurfaceOffscreen(tess, refdef.viewOrigin, project, tess.material?.definition?.portalRange ?? 0,
          () => portalSurfaceIsMirror(surfacePlane(), model, entities))) return null;
        const child = portalViewForSurface(surfacePlane(), model, entities, refdef);
        return child;

  }
  tess.bindSurfaceEvaluator((_identityLight, rendererNoise, runtime) => evaluateWorldSurface(tess.dlightBits, services.identityLight(), rendererNoise, runtime));
  return {
    prepareResolved, probeResolved,
    *prepare(packet, resources) {
      const view = resolveWorldBackendView(packet, resources);
      tess.backEndSmpFrame = packet.smpFrame;
      yield prepareResolved(view);
    },
    probe(packet, surfaceIndex, resources) {
      const view = resolveWorldBackendView(packet, resources);
      const fields = decomposeSourceDrawSort(view.drawRange.getSort(surfaceIndex));
      const material = services.materialBySortedIndex(fields.shader);
      if (material === null) throw new RangeError(`R_DecomposeSort: sorted shader ${fields.shader} has no allocated shader`);
      const entity = fields.entity === SOURCE_DRAW_ENTITY_WORLD ? null : view.capture.entities.allocatedEntity(fields.entity).entity;
      return probeResolved(view, { ...view.surface(surfaceIndex), material, entity, entityOrder: fields.entity,
        fog: fields.fog - 1, dlighted: fields.dlight });
    },
    initializeSky(height) { backendFar = 1024; skyBuilder.initializeCloudCoordinates(height); },
    drawSun(direction) { return drawSun(tess, services.sunMaterial,
      { skyRendered: skyRenderedThisView, far: backendFar, direction, project: backendSunProjector }, settings.runtime,
      () => evaluateWorldSurface(tess.dlightBits, services.identityLight(), noise, settings.runtime)); },
    *beginDebugSurface() { yield { kind: "begin-debug-surface", whiteImage, cull: tess.cullState("front") }; },
    *debugPolygon(color, numPoints, points) {
      if (!Number.isInteger(numPoints) || numPoints < -0x80000000 || numPoints > 0x7fffffff)
        throw new RangeError("R_DebugPolygon point count must be int32");
      const positions: Vec4[] = [];
      for (let index = 0; index < numPoints; index++) positions.push(tess.projectPosition(at(points, index)));
      yield { kind: "debug-polygon", color, positions };
      tess.setDepthRange([0, 1]);
    },
  };
}
