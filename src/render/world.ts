// World traversal and lighting translated from id Software's GPL-2.0-or-later
// code/renderer/tr_world.c, tr_bsp.c, tr_main.c, tr_surface.c and tr_backend.c.
import { createWorldBackendRuntime, defaultPortalPlane } from "./world-backend.ts";
import type { SurfaceGeometry, SurfacePortalPlane, WorldBackendSurface, SceneDlights, WorldBackendResolvedView, WorldBackendRuntime, WorldBackendTransport, WorldBackendWorld } from "./world-backend.ts";
import type { BspVisibility } from "../assets/bsp.ts";
import { SourceBspResource } from "./bsp-resource.ts";
import { SourceWorldVisibility } from "./visibility.ts";
import type { RendererBspMap } from "./bsp-resource.ts";
import { md3Surfaces, md3ShaderCount, md3ShaderIndex } from "./md3-resource.ts";
import type { AssetReader, SourceFileReader } from "../assets/reader.ts";
import type { RetainedFileReader } from "../assets/read-file-memory.ts";
import { CommonError } from "../core/common-error.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";
import type { SourceClusterPVS } from "../collision/topology.ts";
import { add3, boxOnPlaneSide, dot3, length3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Bounds, Plane, Vec3, Vec4 } from "../core/math.ts";
import type { SourceFlareScene } from "./flares.ts";
import type { RenderView, SourceRenderView, SurfaceViewOperation, TextureImage, ViewOperation } from "./types.ts";
import type { RenderTarget, SourcePreparedViews } from "./commands.ts";
import type { BuiltinImages } from "./builtin-images.ts";
import type { RendererImage, RendererImageCatalog } from "./image-resource.ts";
import { imageUploadSteps } from "./image-upload.ts";
import { loadRendererImage } from "./image-loader.ts";
import type { ImageUploadProfile } from "./image-upload.ts";
import type { ShaderCinematicRegistry } from "./cinematic-command.ts";
import type { Refdef } from "./refdef.ts";
import { RDF_NOWORLDMODEL } from "./refdef.ts";
import { farClip, snapshotView, viewFrustum, viewProjection } from "./view.ts";
import { MaterialRegistry } from "./material-registry.ts";
import { ShaderTextPrograms } from "./shader-text.ts";
import type { MaterialLighting, MaterialRecord } from "./material-registry.ts";
import { finishFailedShader, finishImplicitShader, finishShader } from "./material-finish.ts";
import type { FinishLoadedImageMetadata, FinishShaderProfile } from "./material-finish.ts";
import type { RendererSettings } from "./settings.ts";
import type { PatchGrid } from "./patch-lod.ts";
import type { PatchMemoryProfile } from "./patch.ts";
import { BspMarkProjector } from "./marks.ts";
import type { MarkGeometry, MarkSurface, SourceMarkProjection } from "./marks.ts";
import { materialFlags } from "./material-flags.ts";
import { normalizeShaderName, stripShaderExtension } from "./material.ts";
import type { FinishedStageImage, RegisteredImage, RegisteredShaderVideo, RegisteredSun, SourceImageRequest } from "./material.ts";
import { normalize3 } from "../core/math.ts";
import { lightForPoint } from "./lighting.ts";
import type { DynamicLight, LightingSample } from "./lighting.ts";
import { md3FogIndex, prepareMd3EntityPose } from "./model-geometry.ts";
import { SceneModelRegistry, modelViewOrigin, modelWorldPoint } from "./scene-models.ts";
import type { RefEntity, RefPoly, RefPolyVertex, SceneInlineModel, SceneModel, SceneShader, SceneSkin, SourceRefEntity } from "./ref-entity.ts";
import { RF_DEPTHHACK, RF_FIRST_PERSON, RF_THIRD_PERSON, RF_SHADOW_PLANE, RF_NOSHADOW } from "./ref-entity.ts";
import { polyGeometry, spriteFog } from "./entity-primitives.ts";
import type { MaterialPicture } from "./picture-material.ts";
import { snapshotStageBindings } from "./picture-material.ts";
import { SourceTessState } from "./tess-state.ts";
import type { RendererPerformanceCounters } from "./performance.ts";
import { RendererFontRegistry } from "./font-registry.ts";
import type { FontGenerationServices } from "./font-registry.ts";
import { SourceSceneEntities } from "./scene-entities.ts";
import { SOURCE_BACKEND_RELEASE32, SourceBackendMemory } from "./backend-memory.ts";
import { decomposeSourceDrawSort, SOURCE_DRAW_ENTITY_WORLD, SourceDrawSurfaces } from "./draw-surfaces.ts";
import { sortDrawSurfs } from "./draw-sort.ts";
import type { SourceDrawSortRange } from "./draw-sort.ts";
import type { SourceSceneRange } from "./scene-entities.ts";
import { SourceSceneSubmission } from "./scene-submission.ts";
import type { SourceSceneCapture } from "./scene-submission.ts";
import type { HunkAccountingProfile } from "./hunk-accounting.ts";
import type { PortalView } from "./portal.ts";
import { bmodelDlightMask, faceDlightMask, gridDlightMask, splitDlightMask } from "./dlight.ts";

export interface WorldCamera { readonly origin: Vec3; readonly angles: Vec3 }
export interface WorldFrame {
  readonly refdef: Readonly<Refdef>;
  /** Detached diagnostics can supply an existing source range or submit copied arrays. */
  readonly entities?: readonly RefEntity[] | SourceSceneRange;
  readonly polys?: readonly RefPoly[];
  readonly polygonOffset?: { readonly factor: number; readonly units: number };
  /** Source scene lights feed entity lighting and projected world/inline passes. */
  readonly dynamicLights?: readonly DynamicLight[];
}
type SceneViewInput = Pick<WorldFrame, "refdef" | "polygonOffset">;
export interface WorldScene {
  readonly map: RendererBspMap;
  readonly markGeometry: MarkGeometry;
  lightForPoint(point: Vec3): LightingSample | null;
  readonly diagnostics: readonly string[];
  initialCamera(): WorldCamera;
  readonly resources: RendererResources;
  inlineModel(index: number): SceneInlineModel;
  /** Diagnostic array admission and rendering, including R_RenderView debug barriers. */
  renderFrame(view: WorldFrame): void;
  /** Detached diagnostic evaluation; production uses resources.renderScene. */
  frame(view: WorldFrame): readonly RenderView[];
  /** Frontend preparation with source backend execution deferred until command consumption. */
  prepareFrame(view: WorldFrame): SourcePreparedViews;
}

export interface RendererResources {
  readonly performance: RendererPerformanceCounters;
  readonly images: RendererImageCatalog;
  readonly builtins: BuiltinImages;
  readonly memoryProfile: HunkAccountingProfile;
  readonly tess: SourceTessState;
  readonly worldBackend: WorldBackendRuntime;
  readonly backendMaterials: { readonly defaultMaterial: MaterialRecord; readonly flareMaterial: MaterialRecord; readonly sunMaterial: MaterialRecord };
  readonly fonts: RendererFontRegistry;
  readonly sceneEntities: SourceSceneEntities;
  readonly settings: RendererSettings;
  readonly diagnostics: readonly string[];
  readonly worldBaseName: string | null;
  /** Callable RB_DrawSun body; the original draw-list caller is disabled. */
  drawSun(): void;
  clearScene(): undefined;
  addRefEntity(entity: RefEntity): undefined;
  addRefEntityRecord(read: () => SourceRefEntity): undefined;
  addPoly(poly: RefPoly): undefined;
  addPolysByHandle(shaderHandle: number, numVerts: number, numPolys: number, readVertices: (index: number) => readonly RefPolyVertex[]): undefined;
  addLight(light: DynamicLight): undefined;
  addLightRecord(radius: number, color: Vec3, additive: boolean, readOrigin: () => Vec3): undefined;
  /** Actual RE_RenderScene, including portal children and debug barriers. */
  renderScene(refdef: Readonly<Refdef>): undefined;
  renderSceneRecord(readFlags: () => number, read: () => Readonly<Refdef>): undefined;
  lightForPoint(point: Vec3): LightingSample | null;
  lightForPointRecord(readPoint: () => Vec3): LightingSample | null;
  markFragments(query: SourceMarkProjection): number;
  getEntityToken(write: (token: string) => undefined): boolean;
  inPVS(readFirst: () => Vec3, readSecond: () => Vec3, clusterPVS: (cluster: number) => SourceClusterPVS): boolean;
  /** Call after the backend has consumed the previous frame's command queue. */
  rolloverFrame(): undefined;
  listShaders(sorted: boolean, print: (text: string) => undefined): void;
  listModels(print: (text: string) => undefined): void;
  listSkins(print: (text: string) => undefined): void;
  registerModel(path: string | null): Promise<SceneModel>;
  registerSkin(path: string): Promise<SceneSkin | null>;
  registerShader(name: string): Promise<SceneShader | null>;
  registerShaderNoMip(name: string | null): Promise<SceneShader | null>;
  modelHandle(model: SceneModel): number;
  modelForHandle(handle: number): SceneModel;
  skinHandle(skin: SceneSkin | null): number;
  /** MD3 custom-skin validity; failed allocated rows still select default shading. */
  skinForHandle(handle: number): SceneSkin | null;
  shaderHandle(shader: SceneShader | null): number;
  /** Zero omits an entity override; invalid nonzero words select the default shader. */
  shaderForHandle(handle: number): SceneShader | null;
  remapShader(original: string, replacement: string, timeOffset: string | null): Promise<void>;
  /** Registered identity is retained until queued backend material evaluation. */
  picture(shader: SceneShader | null): MaterialPicture;
  loadWorld(mapName: string): Promise<WorldScene>;
  setWorldVisData(bytes: Uint8Array | null): undefined;
  /** Diagnostic array admission; RDF_NOWORLDMODEL also works before a BSP loads. */
  renderFrame(view: WorldFrame): void;
  /** Detached diagnostic evaluation; production uses renderScene. */
  frame(view: WorldFrame): readonly RenderView[];
  /** Frontend preparation with source backend execution deferred until command consumption. */
  prepareFrame(view: WorldFrame): SourcePreparedViews;
}
export const RendererResources = Object.freeze({ create: createRendererResources });

export interface RendererResourceServices {
  readonly debugBuild?: boolean;
  readonly worldTransport?: WorldBackendTransport;
  readonly patchMemory: PatchMemoryProfile;
  /** R_Init's already reset tess and selected command backend, shared with the live queue. */
  readonly tess?: SourceTessState;
  readonly performance?: RendererPerformanceCounters;
  readonly clock?: { milliseconds(): number };
  readonly target: Pick<RenderTarget, "height" | "stencilBits" | "executeSurfaceOperations" | "queuePreparedViews" | "fixShaderSort" | "syncRenderThread">;
  readonly images: RendererImageCatalog;
  readonly builtins: BuiltinImages;
  readonly shaderCinematics: ShaderCinematicRegistry;
  readonly imageProfile: () => ImageUploadProfile;
  readonly print: (text: string) => undefined;
  readonly publishListings?: (listings:
    | { readonly kind: "shaders"; readonly listShaders: RendererResources["listShaders"] }
    | { readonly kind: "models"; readonly listModels: RendererResources["listModels"]; readonly listSkins: RendererResources["listSkins"] }) => undefined;
  readonly drawDebugSurface: (drawPoly: (color: number, numPoints: number, points: readonly Vec3[]) => undefined) => undefined;
  readonly fontGeneration?: Pick<FontGenerationServices, "saveFontData" | "writeFile">;
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new RangeError(`world index ${index} outside ${items.length}`);
  return value;
}

/** A camera on a splitting plane belongs to child 1, matching R_PointInLeaf. */
export function pointInLeaf(map: Pick<RendererBspMap, "nodes" | "leaves" | "planes">, point: Vec3): number {
  if (map.nodes.length === 0) return map.leaves.length > 0 ? 0 : -1;
  let index = 0;
  while (index >= 0 && index < map.nodes.length) {
    const node = at(map.nodes, index), plane = at(map.planes, node.plane);
    index = dot3(point, plane.normal) - plane.distance > 0 ? node.children[0] : node.children[1];
  }
  return index >= 0 ? index - map.nodes.length : -index - 1;
}

export function clusterVisible(visibility: BspVisibility | null, from: number, to: number): boolean {
  if (from < 0) return true;
  if (to < 0) return false;
  if (visibility === null || from >= visibility.clusterCount) return true;
  if (to >= visibility.clusterCount) return false;
  const bits = visibility.bits[from * visibility.bytesPerCluster + (to >> 3)];
  if (bits === undefined) throw new RangeError("truncated world PVS");
  return (bits & (1 << (to & 7))) !== 0;
}

/** R_RecursiveWorldNode visits child zero first and drops plane tests once an
 * ancestor box is wholly inside that plane. Leaf ordering affects tied draws. */
function* frustumLeaves(source: SourceBspResource, visibility: SourceWorldVisibility,
  planes: readonly Plane[], lights: readonly DynamicLight[], noCull: boolean): Generator<{
  readonly leaf: RendererBspMap["leaves"][number]; readonly dlightBits: number;
}, void, undefined> {
  const map = source.map;
  // The source shifts by 32 at capacity, which is undefined C. Keep all 32 slots.
  const dlightBits = lights.length === 32 ? -1 : (1 << lights.length) - 1;
  const pending = map.nodes.length === 0 ? map.leaves.length === 0 ? [] : [{ index: -1, bits: 15, dlightBits }] : [{ index: 0, bits: 15, dlightBits }];
  while (pending.length > 0) {
    const item = pending.pop(); if (item === undefined) throw new Error("world traversal stack lost a node");
    const combinedIndex = item.index >= 0 ? item.index : map.nodes.length - 1 - item.index;
    const record = source.visibilityNode(combinedIndex);
    if (record.visFrame !== visibility.visCount) continue;
    const leafIndex = record.contents === -1 ? null : combinedIndex - map.nodes.length;
    const node = leafIndex === null ? at(map.nodes, combinedIndex) : at(map.leaves, leafIndex);
    let bits = item.bits, culled = false;
    if (!noCull) for (const [index, plane] of planes.entries()) {
      if ((bits & (1 << index)) === 0) continue;
      const side = boxOnPlaneSide(node.bounds, plane);
      if (side === 2) { culled = true; break; }
      if (side === 1) bits &= ~(1 << index);
    }
    if (culled) continue;
    if (leafIndex !== null) yield { leaf: at(map.leaves, leafIndex), dlightBits: item.dlightBits };
    else {
      const branch = at(map.nodes, combinedIndex), children = branch.children;
      const masks = splitDlightMask(lights, item.dlightBits, at(map.planes, branch.plane));
      pending.push({ index: children[1], bits, dlightBits: masks[1] }, { index: children[0], bits, dlightBits: masks[0] });
    }
  }
}

/** R_ColorShiftLightingBytes converts stored map range to effective renderer range. */
export function shiftLighting(color: Vec4, shift = 2): Vec4 {
  const red = color.x << shift, green = color.y << shift, blue = color.z << shift;
  const maximum = Math.max(red, green, blue);
  return (red | green | blue) > 255
    ? { x: Math.trunc(red * 255 / maximum), y: Math.trunc(green * 255 / maximum), z: Math.trunc(blue * 255 / maximum), w: color.w }
    : { x: Math.trunc(red), y: Math.trunc(green), z: Math.trunc(blue), w: color.w };
}

function lightmapImage(data: Uint8Array, shift: number, lightmapMode: number): { readonly image: TextureImage; readonly maximum: number } {
  const pixels = new Uint8Array(128 * 128 * 4);
  let maximum = 0;
  for (let index = 0; index < 128 * 128; index++) {
    const r = data[index * 3], g = data[index * 3 + 1], b = data[index * 3 + 2];
    if (r === undefined || g === undefined || b === undefined) throw new RangeError("truncated world lightmap");
    if (lightmapMode === 2) {
      let intensity = Math.fround(Math.fround(Math.fround(Math.fround(0.33) * r) + Math.fround(Math.fround(0.685) * g)) + Math.fround(Math.fround(0.063) * b));
      intensity = intensity > 255 ? 1 : Math.fround(intensity / 255);
      if (intensity > maximum) maximum = intensity;
      const hue = Math.fround(intensity * 5), segment = Math.floor(hue), fraction = Math.fround(hue - segment);
      const q = Math.fround(0.5 * Math.fround(1 - fraction)), t = Math.fround(0.5 * fraction);
      const rgb = segment === 0 ? { x: 0.5, y: t, z: 0 } : segment === 1 ? { x: q, y: 0.5, z: 0 }
        : segment === 2 ? { x: 0, y: 0.5, z: t } : segment === 3 ? { x: 0, y: q, z: 0.5 }
          : segment === 4 ? { x: t, y: 0, z: 0.5 } : { x: 0.5, y: 0, z: q };
      pixels.set([Math.fround(rgb.x * 255), Math.fround(rgb.y * 255), Math.fround(rgb.z * 255), 255], index * 4);
    } else {
      const color = shiftLighting({ x: r, y: g, z: b, w: 255 }, shift);
      pixels.set([color.x, color.y, color.z, 255], index * 4);
    }
  }
  return { image: { width: 128, height: 128, pixels }, maximum };
}

function parseVector(value: string): Vec3 {
  const components = value.trim().split(/\s+/).map(Number);
  if (components.length !== 3 || !components.every(Number.isFinite)) throw new Error(`invalid map entity vector ${value}`);
  return { x: at(components, 0), y: at(components, 1), z: at(components, 2) };
}

function initialCamera(map: RendererBspMap): WorldCamera {
  const entity = map.entityRecords.find(record => record.get("classname") === "info_player_deathmatch")
    ?? map.entityRecords.find(record => record.get("classname") === "info_player_start")
    ?? map.entityRecords.find(record => record.get("classname") === "info_player_intermission");
  if (entity === undefined) throw new Error("map has no player spawn or intermission camera");
  const origin = parseVector(entity.get("origin") ?? "0 0 0");
  const yaw = Number(entity.get("angle") ?? "0");
  if (!Number.isFinite(yaw)) throw new Error("invalid map spawn angle");
  const anglesText = entity.get("angles");
  const angles = anglesText === undefined ? { x: 0, y: yaw, z: 0 } : parseVector(anglesText);
  return { origin: { ...origin, z: origin.z + 26 }, angles };
}

type SourceModelEntity = Extract<SourceRefEntity, { readonly kind: "model" }>;
async function createRendererResources(vfs: AssetReader & RetainedFileReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">,
  memoryProfile: HunkAccountingProfile, settings: RendererSettings,
  services: RendererResourceServices): Promise<RendererResources> {
  const { images, builtins: builtinImages, shaderCinematics } = services;
  const tess = services.tess ?? new SourceTessState(services.performance);
  const performance = tess.performance;
  if (services.performance !== undefined && services.performance !== performance)
    throw new Error("Renderer resources require their tessellation performance counters");
  if (builtinImages.images !== images) throw new Error("Renderer built-ins belong to another image catalog");
  const primaryMemory = memoryProfile.kind === "source-hunk" ? memoryProfile.accounting.rendererBackend(0)
    : SourceBackendMemory.local(settings.sceneLimits());
  if (primaryMemory === null) throw new Error("R_Init must allocate renderer backend storage before resource initialization");
  const limits = primaryMemory.limits;
  const secondaryMemory = memoryProfile.kind === "source-hunk" ? memoryProfile.accounting.rendererBackend(1)
    : settings.runtime.smpRequested ? SourceBackendMemory.local(limits) : null;
  function createSceneStorage(backend: SourceBackendMemory) {
    const entities = new SourceSceneEntities(backend, {
      model: model => modelRegistry.modelHandle(model),
      skin: skin => modelRegistry.skinHandle(skin),
      shader: shader => shader === null ? 0 : shaderMaterial(shader).order,
    });
    const submission = new SourceSceneSubmission(entities, limits, {
      fogBounds: () => activeLightmaps === null ? [] : activeLightmaps.compiled.fogBounds,
      developerEnabled: () => settings.runtime.developerEnabled,
      print: services.print,
    }, { kind: "source", backend, shaderHandle: shader => shaderMaterial(shader).order }, settings.hardwareType);
    return { backend, entities, submission, drawSurfaces: new SourceDrawSurfaces<WorldBackendSurface>(backend) };
  }
  const primaryScene = createSceneStorage(primaryMemory);
  const secondaryScene = secondaryMemory === null ? null : createSceneStorage(secondaryMemory);
  let smpFrame: 0 | 1 = services.tess === undefined ? settings.runtime.smpRequested ? 1 : 0 : tess.frontEndSmpFrame;
  function selectSceneStorage() {
    const selected = smpFrame === 0 ? primaryScene : secondaryScene;
    if (selected === null) throw new Error("R_ToggleSmpFrame selected an unallocated renderer backend");
    return selected;
  }
  let activeScene = selectSceneStorage(), sceneEntities = activeScene.entities, sceneSubmission = activeScene.submission;
  if (services.tess === undefined) {
    tess.frontEndSmpFrame = smpFrame;
    tess.frontEndMemory = activeScene.backend;
  } else if (tess.frontEndMemory !== activeScene.backend) {
    throw new Error("Renderer resources require R_Init's selected command backend");
  }
  const diagnostics = new Set<string>();
  const programs = new ShaderTextPrograms();
  const textures = new Map<string, { readonly request: SourceImageRequest; readonly image: Promise<RendererImage | null> }>();
  const fallback = builtinImages.defaultImage;
  const white = builtinImages.find("*white");
  if (white === undefined) throw new Error("Renderer builtin white image was not initialized");
  const whiteImage = white.image;
  /** R_DebugGraphics and R_DebugPolygon retain the completed backend view's matrices. */
  function debugGraphics(): void {
    if (settings.runtime.debugSurface === 0) return;
    services.target.syncRenderThread();
    if (services.worldTransport === undefined) services.target.executeSurfaceOperations(worldBackend.beginDebugSurface());
    else services.worldTransport.beginDebugSurface();
    services.drawDebugSurface((color, numPoints, points) => {
      if (services.worldTransport === undefined) services.target.executeSurfaceOperations(worldBackend.debugPolygon(color, numPoints, points));
      else services.worldTransport.debugPolygon(color, numPoints, points);
    });
  }
  function publishImage(request: SourceImageRequest, decoded: TextureImage): RendererImage {
    if (request.name.length >= 64) throw new CommonError("drop", `R_CreateImage: "${request.name}" is too long\n`);
    const image = images.createUploaded({ name: request.name, sourceWidth: decoded.width, sourceHeight: decoded.height,
      mipmap: request.mipmap, allowPicmip: request.allowPicmip,
      sampling: { wrap: request.wrap, filter: request.mipmap ? images.textureFilter : "linear" },
      registrationUnit: request.name.startsWith("*lightmap") && settings.registrationProfile().iterator.multitexture ? 1 : 0 },
    () => imageUploadSteps(decoded, request, services.imageProfile(), images.hunk));
    textures.set(request.name, { request, image: Promise.resolve(image) });
    return image;
  }
  function warnImageReuse(request: SourceImageRequest, original: Pick<SourceImageRequest, "mipmap" | "allowPicmip" | "wrap">): void {
    if (request.name === "*white") return;
    if (request.mipmap !== original.mipmap) diagnostics.add(`WARNING: reused image ${request.name} with mixed mipmap parm`);
    if (request.allowPicmip !== original.allowPicmip) diagnostics.add(`WARNING: reused image ${request.name} with mixed allowPicmip parm`);
    if (request.wrap !== original.wrap) diagnostics.add(`WARNING: reused image ${request.name} with mixed glWrapClampMode parm`);
  }
  function texture(request: SourceImageRequest): Promise<RendererImage | null> {
    const end = request.name.indexOf("\0");
    if (end >= 0) request = { ...request, name: request.name.slice(0, end) };
    const { name } = request;
    const builtin = builtinImages.find(name);
    if (builtin !== undefined) { warnImageReuse(request, builtin); return Promise.resolve(builtin.image); }
    // R_FindImageFile's hash is case-insensitive, but its cache equality is strcmp.
    const key = name;
    const cached = textures.get(key);
    if (cached !== undefined) return cached.image.then(image => {
      if (image !== null) warnImageReuse(request, cached.request);
      return image;
    });
    const result = (async () => {
      const image = await loadRendererImage(vfs, name, services.print);
      if (image !== null) return publishImage(request, image);
      diagnostics.add(`missing texture ${name}`); return null;
    })();
    textures.set(key, { request, image: result });
    return result.then(image => {
      if (image === null && textures.get(key)?.image === result) textures.delete(key);
      return image;
    }, (error: unknown) => {
      if (textures.get(key)?.image === result) textures.delete(key);
      throw error;
    });
  }
  function implicitImageName(name: string): string {
    const end = name.indexOf("\0");
    const copied = (end < 0 ? name : name.slice(0, end)).slice(0, 63);
    for (let index = 0; index < copied.length; index++) {
      if (copied.charCodeAt(index) > 255) throw new RangeError("R_FindShader image names require source bytes");
    }
    // COM_DefaultExtension checks neither the first character nor backslashes.
    for (let index = copied.length - 1; index > 0 && copied[index] !== "/"; index--) {
      if (copied[index] === ".") return copied;
    }
    const extended = `${copied}.tga`;
    if (extended.length >= 64) diagnostics.add(`Com_sprintf: overflow of ${extended.length} in 64`);
    return extended.slice(0, 63);
  }
  function stageImage(image: RendererImage): FinishedStageImage { return { image }; }
  function loadedImage(image: RendererImage, tmu: 0 | 1 = 0): FinishLoadedImageMetadata {
    return { kind: "loaded", tmu, binding: { kind: "images", playback: { kind: "single", image: stageImage(image) } } };
  }
  function registeredImage(image: RendererImage, tmu: 0 | 1 = 0): RegisteredImage { return { frame: stageImage(image), tmu }; }
  let sun: RegisteredSun = { light: { x: 0, y: 0, z: 0 }, direction: normalize3(vec3(0.45, 0.3, 0.9)) };
  const worldBackend = createWorldBackendRuntime({
    ...(services.debugBuild === undefined ? {} : { debugBuild: services.debugBuild }),
    tess, settings, builtins: builtinImages, identityLight: () => services.imageProfile().colorMappings.identityLight, print: services.print, target: services.target,
    get defaultMaterial() { return defaultMaterial; },
    get flareMaterial() { return flareMaterial; },
    get sunMaterial() { return sunMaterial; },
    materialBySortedIndex: index => materialRegistry.findBySortedIndex(index),
  });
  async function playShaderCinematic(name: string): Promise<RegisteredShaderVideo | null> {
    const source = await shaderCinematics.playShaderCinematic(name);
    if (source === null) { diagnostics.add(`${name}: CIN_PlayCinematic failed`); return null; }
    images.requireOwned(source.image);
    return { source, image: registeredImage(source.image) };
  }
  function lightmapBinding(lighting: Extract<MaterialLighting, { kind: "lightmap" }>, profile: FinishShaderProfile): FinishLoadedImageMetadata {
    return loadedImage(lighting.image, profile.iterator.multitexture ? 1 : 0);
  }
  let initializingDefaultMaterial = true;
  const materialRegistry = new MaterialRegistry(async (name, lighting, mip) => {
    const program = programs.find(stripShaderExtension(name));
    if (program !== undefined && settings.runtime.printShaders) services.print(`*SHADER* ${name}\n`);
    const profile = settings.registrationProfile();
    const lightmapIndex = lighting.kind === "lightmap" ? lighting.index : lighting.kind === "none" ? -1
      : lighting.kind === "white" ? -2 : lighting.kind === "vertex" ? -3 : -4;
    if (program !== undefined) {
      const registered = await program.register({ whiteImage: registeredImage(whiteImage), defaultImage: registeredImage(fallback),
        printWarning: message => services.print(message),
        lightmapImage: lighting.kind === "lightmap" ? registeredImage(lighting.image, profile.iterator.multitexture ? 1 : 0) : registeredImage(whiteImage),
        async findImage(request) {
          const image = await texture(request);
          return image === null ? null : registeredImage(image);
        }, playShaderCinematic,
        applySun(value) { sun = value; },
        initializeSkyTexCoords(height) {
          if (services.worldTransport === undefined) worldBackend.initializeSky(height);
          else services.worldTransport.initializeSky(height);
        } });
      const finished = finishShader({ definition: registered.definition, lightmapIndex, images: registered.stages, profile });
      if (registered.kind === "defaulted") diagnostics.add(registered.failure.kind === "source-text" ? registered.failure.error.message
        : `${name}: required image ${registered.failure.request.name} was not found`);
      for (const diagnostic of finished.diagnostics) diagnostics.add(`${name}: ${diagnostic.message}`);
      return { definition: registered.definition, image: fallback, defaulted: registered.kind === "defaulted", finished, whiteImage, sky: registered.sky };
    }
    const image = initializingDefaultMaterial ? fallback : await texture({ name: implicitImageName(name), mipmap: mip, allowPicmip: mip, wrap: mip ? "repeat" : "clamp" });
    const defaulted = image === null;
    const fields = { name, baseImage: loadedImage(image ?? fallback), profile };
    const finished = defaulted ? finishFailedShader({ name, lightmapIndex, profile })
        : initializingDefaultMaterial ? finishImplicitShader({ ...fields, kind: "default" })
          : lighting.kind === "lightmap" ? finishImplicitShader({ ...fields, kind: "lightmap", lightmapIndex: lighting.index, lightmapImage: lightmapBinding(lighting, profile) })
            : lighting.kind === "white" ? finishImplicitShader({ ...fields, kind: "white", whiteImage: loadedImage(whiteImage) })
              : finishImplicitShader({ ...fields, kind: lighting.kind === "none" ? "dynamic" : lighting.kind });
    for (const diagnostic of finished.diagnostics) diagnostics.add(`${name}: ${diagnostic.message}`);
    return { definition: null, image: image ?? fallback, defaulted, finished, whiteImage, sky: null };
  }, text => services.print(text), memoryProfile, newShader => { services.target.fixShaderSort(newShader); });
  const listShaders: RendererResources["listShaders"] = (sorted, print) => materialRegistry.listShaders(sorted, print);
  services.publishListings?.({ kind: "shaders", listShaders });
  const readyModelMaterials = new Map<string, MaterialRecord>();
  const shaderHandles = new Map<string, Promise<SceneShader | null>>();
  const shaderMaterials = new Map<SceneShader, MaterialRecord>();
  const materialShaders = new WeakMap<MaterialRecord, SceneShader>();
  const pictures = new Map<SceneShader | null, MaterialPicture>();
  const inlineOwners = new WeakSet<SceneInlineModel>();
  function findMaterial(name: string, lighting: MaterialLighting, mip = true): Promise<MaterialRecord> {
    // R_FindShader returns the existing default before any lookup for name[0] == 0.
    if (name.length === 0 || name[0] === "\0") return Promise.resolve(defaultMaterial);
    return materialRegistry.register(name, lighting, mip);
  }
  async function registerMaterial(name: string): Promise<MaterialRecord> {
    const material = await findMaterial(name, { kind: "none" });
    readyModelMaterials.set(normalizeShaderName(name), material);
    return material;
  }
  const defaultMaterial = await materialRegistry.register("*default", { kind: "none" });
  initializingDefaultMaterial = false;
  readyModelMaterials.set("*default", defaultMaterial);
  const stencilShadowMaterial = materialRegistry.registerStencilShadow(defaultMaterial);
  readyModelMaterials.set(stencilShadowMaterial.name, stencilShadowMaterial);
  await programs.load({ kind: "retained", source: vfs }, memoryProfile, services.print);
  const projectionShadowMaterial = await registerMaterial("projectionShadow");
  const flareMaterial = await registerMaterial("flareShader");
  const sunMaterial = await registerMaterial("sun");
  let activeLightmaps: { readonly map: RendererBspMap; readonly images: readonly RendererImage[];
    readonly inlineModels: readonly SceneInlineModel[]; readonly compiled: Awaited<ReturnType<typeof compileScene>> } | null = null;
  let worldMapLoaded = false;
  let externalVisData: Uint8Array | null = null;
  let worldBaseName: string | null = null;
  let loadingWorld: { readonly source: SourceBspResource; readonly images: RendererImage[] } | null = null;
  let entityCursor = new CommonParseCursor("");
  const entityParser = new CommonParseState();
  function pointCluster(readPoint: () => Vec3): number {
    if (activeLightmaps === null) throw new CommonError("drop", "R_PointInLeaf: bad model");
    const map = activeLightmaps.map;
    const leaf = map.nodes.length === 0 ? 0 : pointInLeaf(map, readPoint());
    return at(map.leaves, leaf).cluster;
  }
  const modelRegistry = new SceneModelRegistry(vfs, registerMaterial, memoryProfile, defaultMaterial, services.print,
    index => materialRegistry.findByHandle(index), () => services.target.syncRenderThread(), services.debugBuild ?? false);
  const listModels: RendererResources["listModels"] = print => modelRegistry.listModels(print);
  const listSkins: RendererResources["listSkins"] = print => modelRegistry.listSkins(print);
  services.publishListings?.({ kind: "models", listModels, listSkins });
  modelRegistry.initializeSkins();
  modelRegistry.initializeModels();
  function shaderForMaterial(material: MaterialRecord): SceneShader {
    const cached = materialShaders.get(material);
    if (cached !== undefined) return cached;
    const shader: SceneShader = { name: material.name };
    shaderMaterials.set(shader, material);
    materialShaders.set(material, shader);
    return shader;
  }
  function registerShader(name: string | null, mip: boolean): Promise<SceneShader | null> {
    if (name === null) throw new RangeError(`${mip ? "RE_RegisterShader" : "RE_RegisterShaderNoMip"}: undefined source NULL name read`);
    const end = name.indexOf("\0");
    if (end !== -1) name = name.slice(0, end);
    if (name.length === 0 || name.length >= 64) return Promise.resolve(null);
    const key = normalizeShaderName(name), cached = shaderHandles.get(key);
    if (cached !== undefined) return cached;
    const pending = findMaterial(name, { kind: "picture" }, mip).then(material => {
      if (material === defaultMaterial) { shaderHandles.delete(key); return null; }
      if (material.defaulted) return null;
      return shaderForMaterial(material);
    }, (error: unknown) => {
      shaderHandles.delete(key);
      throw error;
    });
    shaderHandles.set(key, pending);
    return pending;
  }
  function shaderMaterial(shader: SceneShader, kind = "shader"): MaterialRecord {
    const material = shaderMaterials.get(shader);
    if (material === undefined) throw new Error(`${kind} handle belongs to another renderer or is unregistered`);
    return material;
  }
  function sceneShaderMaterial(shader: SceneShader | number | null, kind = "shader"): MaterialRecord {
    const selected = typeof shader === "number" ? resources.shaderForHandle(shader) : shader;
    return selected === null ? defaultMaterial : shaderMaterial(selected, kind);
  }
  async function compileScene(source: SourceBspResource | null, lightmaps: readonly RendererImage[] = []): Promise<{
    readonly renderFrame: (view: WorldFrame) => void;
    readonly frame: (view: WorldFrame) => readonly RenderView[];
    readonly prepareFrame: (view: WorldFrame) => SourcePreparedViews;
    readonly prepareScene: (view: SceneViewInput, capture: SourceSceneCapture, submit: boolean) => SourcePreparedViews;
    readonly fogBounds: readonly Bounds[];
    readonly markSurfaces: readonly MarkSurface[];
    readonly lightForPoint: (point: Vec3) => LightingSample | null;
    readonly lightmaps: readonly RendererImage[];
    readonly hasLightGrid: boolean;
  }> {
  const map = source?.map ?? null, fogs = map?.fogs ?? [], worldMaterials = source?.materials ?? [];
  const visibility = source === null ? null : new SourceWorldVisibility(source, settings.visibility, performance, services.print);
  const fogTexture = fogs.length === 0 ? null : builtinImages.fogImage;
  const backendWorld: WorldBackendWorld = { fogs, fogTexture };
  const lightGrid = { grid: source?.lightGrid ?? null }, patches = source?.patches ?? new Map<number, PatchGrid>();
  const geometry: readonly SurfaceGeometry[] = source?.geometry ?? [];
  const markSurfaces: readonly MarkSurface[] = map === null ? [] : map.surfaces.map((surface, index): MarkSurface => {
    const flags = materialFlags(at(worldMaterials, index).definition), mesh = at(geometry, index);
    if (surface.type === "patch") {
      const patch = patches.get(index);
      return patch === undefined ? { kind: "skip" } : { kind: "grid", ...flags, mesh: patch.mesh };
    }
    if (surface.type !== "planar" || mesh.vertices.length === 0) return { kind: "skip" };
    return { kind: "face", ...flags, plane: surface.plane,
      vertices: mesh.vertices, indices: mesh.indices };
  });
  const geometryBounds = geometry.map(mesh => {
    let min = vec3(99999, 99999, 99999), max = vec3(-99999, -99999, -99999);
    for (const { position } of mesh.vertices) {
      min = vec3(Math.min(min.x, position.x), Math.min(min.y, position.y), Math.min(min.z, position.z));
      max = vec3(Math.max(max.x, position.x), Math.max(max.y, position.y), Math.max(max.z, position.z));
    }
    return { min, max };
  });
  function localBoxCull(bounds: Bounds, frustum: readonly Plane[], entity: SourceModelEntity | null): "in" | "clip" | "out" {
    if (resources.settings.runtime.noCull) return "clip";
    const corners: Vec3[] = [];
    for (let index = 0; index < 8; index++) {
      const x = (index & 1) === 0 ? bounds.min.x : bounds.max.x;
      const y = (index & 2) === 0 ? bounds.min.y : bounds.max.y;
      const z = (index & 4) === 0 ? bounds.min.z : bounds.max.z;
      // R_CullLocalBox stores each of its three VectorMA results separately.
      corners.push(entity === null ? vec3(x, y, z) : add3(add3(add3(entity.origin,
        scale3(entity.axis[0], x)), scale3(entity.axis[1], y)), scale3(entity.axis[2], z)));
    }
    let clipped = false;
    for (const plane of frustum) {
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
  function surfaceCulled(index: number, material: MaterialRecord, localView: Vec3, frustum: readonly Plane[], entity: SourceModelEntity | null): boolean {
    if (resources.settings.runtime.noCull) return false;
    if (map === null) throw new Error("world surface culling requires a map");
    const surface = at(map.surfaces, index), bounds = at(geometryBounds, index);
    if (surface.type === "triangles") return localBoxCull(bounds, frustum, entity) === "out";
    if (surface.type === "patch") {
      if (resources.settings.runtime.noCurves) return true;
      const center = scale3(add3(bounds.min, bounds.max), 0.5), radius = length3(sub3(bounds.min, center));
      const origin = entity === null ? center : modelWorldPoint(entity, center);
      let clipped = false;
      for (const plane of frustum) {
        const distance = Math.fround(dot3(origin, plane.normal) - plane.distance);
        if (distance < -radius) {
          performance.frontEnd.c_sphere_cull_patch_out = (performance.frontEnd.c_sphere_cull_patch_out + 1) | 0;
          return true;
        }
        if (distance <= radius) clipped = true;
      }
      if (!clipped) {
        performance.frontEnd.c_sphere_cull_patch_in = (performance.frontEnd.c_sphere_cull_patch_in + 1) | 0;
        return false;
      }
      performance.frontEnd.c_sphere_cull_patch_clip = (performance.frontEnd.c_sphere_cull_patch_clip + 1) | 0;
      const boxCull = localBoxCull(bounds, frustum, entity);
      const counter: `c_box_cull_patch_${typeof boxCull}` = `c_box_cull_patch_${boxCull}`;
      performance.frontEnd[counter] = (performance.frontEnd[counter] + 1) | 0;
      return boxCull === "out";
    }
    const cull = material.definition?.cull ?? "front";
    if (surface.type !== "planar" || cull === "none" || !resources.settings.runtime.facePlaneCull) return false;
    const { normal, distance } = surface.plane;
    const viewer = dot3(localView, normal);
    return cull === "front" ? viewer < Math.fround(distance - 8) : viewer > Math.fround(distance + 8);
  }
  function lightSurface(index: number, incoming: number, lights: readonly DynamicLight[], smpFrame: 0 | 1): boolean {
    if (incoming === 0) return false; // The source retains the previous surface mask.
    if (map === null || source === null) throw new Error("world dlight surface requires a map");
    const surface = at(map.surfaces, index);
    let mask = incoming;
    if (surface.type === "planar") mask = faceDlightMask(lights, mask, surface.plane);
    else if (surface.type === "patch") mask = gridDlightMask(lights, mask, at(geometryBounds, index));
    else if (surface.type !== "triangles") mask = 0;
    if (mask === 0 && (surface.type === "planar" || surface.type === "patch"))
      performance.frontEnd.c_dlightSurfacesCulled = (performance.frontEnd.c_dlightSurfacesCulled + 1) | 0;
    source.setSurfaceDlightBits(index, smpFrame, mask);
    if (mask !== 0) performance.frontEnd.c_dlightSurfaces = (performance.frontEnd.c_dlightSurfaces + 1) | 0;
    return mask !== 0;
  }
  function backendSurfaceDlightBits(index: number, frame: 0 | 1): number {
    if (source === null) throw new Error("world dlight surface requires a map");
    return source.surfaceDlightBits(index, frame);
  }
  function surfacePortalPlane(index: number): SurfacePortalPlane {
    if (map === null) throw new Error("world portal surface requires a map");
    const surface = at(map.surfaces, index);
    if (surface.type === "planar") {
      return { kind: "fixed", plane: surface.plane };
    }
    return surface.type === "triangles" ? { kind: "triangle" } : defaultPortalPlane;
  }
  const worldSunDirection = sun.direction;
  function prepareFrame(input: WorldFrame, submit = false): SourcePreparedViews {
    const submitted = input.entities;
    let entities: SourceSceneRange;
    if (submitted !== undefined && "entity" in submitted) {
      sceneEntities.validateRange(submitted);
      entities = submitted;
    } else {
      sceneSubmission.clearScene();
      for (const entity of submitted ?? []) sceneSubmission.addRefEntity(entity);
      entities = sceneEntities.sceneRange();
    }
    for (const poly of input.polys ?? []) sceneSubmission.addPoly(poly);
    for (const light of input.dynamicLights ?? []) sceneSubmission.addLight(light);
    if (settings.runtime.noRefresh) return () => [];
    const started = services.clock?.milliseconds();
    const capture = sceneSubmission.captureScene(entities);
    const prepared = prepareScene(input, capture, submit);
    activeScene.drawSurfaces.completeScene();
    sceneSubmission.completeScene(capture);
    if (started !== undefined && services.clock !== undefined)
      performance.frontEndMsec = (performance.frontEndMsec + services.clock.milliseconds() - started) | 0;
    return prepared;
  }
  function prepareScene(input: SceneViewInput, capture: SourceSceneCapture, submit: boolean): SourcePreparedViews {
    if (map === null && (input.refdef.renderFlags & RDF_NOWORLDMODEL) === 0)
      throw new CommonError("drop", "R_RenderScene: NULL worldmodel");
    visibility?.beginScene(input.refdef);
    const lights = resources.settings.runtime.dynamicLights ? capture.dynamicLights : [];
    const scene = tess.flares.beginScene(images.frameCount);
    const frontend = { smpFrame: tess.frontEndSmpFrame, zNear: resources.settings.runtime.zNear,
      lodScale: resources.settings.runtime.lodScale, lodBias: resources.settings.runtime.lodBias,
      scene };
    const drawSurfaces = activeScene.drawSurfaces;
    drawSurfaces.beginScene();
    return prepareView(input, capture, null, { lights, transformed: null }, frontend, submit, drawSurfaces);
  }
  function prepareView(input: SceneViewInput, capture: SourceSceneCapture, portal: PortalView | null, dlights: SceneDlights,
    frontend: Pick<RendererSettings["runtime"], "zNear" | "lodScale" | "lodBias"> & { readonly smpFrame: 0 | 1; readonly scene: SourceFlareScene }, submit: boolean,
    drawSurfaces: SourceDrawSurfaces<WorldBackendSurface>, inheritedBounds: Bounds = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) }): SourcePreparedViews {
      const refdef = snapshotView(input.refdef);
      const view: WorldFrame = { ...input, refdef,
        ...(input.polygonOffset === undefined ? {} : { polygonOffset: { ...input.polygonOffset } }) };
      const mirror = portal !== null && portal.mirror;
      const noWorld = (refdef.renderFlags & RDF_NOWORLDMODEL) !== 0;
      if (refdef.width <= 0 || refdef.height <= 0) return () => [];
      const entityRange = capture.entities;
      const dynamicLights = dlights.lights;
      const frustum = viewFrustum(refdef);
      const drawWorld = resources.settings.visibility.drawWorld && !noWorld;
      if (drawWorld && map !== null && visibility !== null)
        visibility.markLeaves(() => map.nodes.length + pointInLeaf(map, portal === null ? refdef.viewOrigin : portal.pvsOrigin));
      const submittedSurfaces = new Set<number>();
      const firstDrawSurf = drawSurfaces.numDrawSurfs;
      const addDrawSurf = (submission: WorldBackendSurface): void => {
        drawSurfaces.add(submission, submission.material.sortedIndex, submission.entityOrder, submission.fog + 1,
          Number(submission.dlighted ?? false));
      };
      let visibleBounds: Bounds = drawWorld
        ? { min: { x: 99999, y: 99999, z: 99999 }, max: { x: -99999, y: -99999, z: -99999 } } : inheritedBounds;
      for (const { leaf, dlightBits } of !drawWorld || source === null || visibility === null ? []
        : frustumLeaves(source, visibility, frustum, dynamicLights, resources.settings.runtime.noCull)) {
        if (map === null) throw new Error("world traversal requires a map");
        performance.frontEnd.c_leafs = (performance.frontEnd.c_leafs + 1) | 0;
        visibleBounds = { min: { x: Math.min(visibleBounds.min.x, leaf.bounds.min.x), y: Math.min(visibleBounds.min.y, leaf.bounds.min.y), z: Math.min(visibleBounds.min.z, leaf.bounds.min.z) },
          max: { x: Math.max(visibleBounds.max.x, leaf.bounds.max.x), y: Math.max(visibleBounds.max.y, leaf.bounds.max.y), z: Math.max(visibleBounds.max.z, leaf.bounds.max.z) } };
        for (let index = 0; index < leaf.surfaceCount; index++) {
          const surfaceIndex = at(map.leafSurfaces, leaf.firstSurface + index);
          if (submittedSurfaces.has(surfaceIndex)) continue;
          submittedSurfaces.add(surfaceIndex);
          const surface = at(map.surfaces, surfaceIndex), mesh = at(geometry, surfaceIndex), material = at(worldMaterials, surfaceIndex);
          if (surface.type === "flare") {
            addDrawSurf({ kind: "flare", material, fog: surface.fog, entityOrder: SOURCE_DRAW_ENTITY_WORLD, entity: null });
            continue;
          }
          if (surface.type === "patch" && !patches.has(surfaceIndex)) {
            addDrawSurf({ kind: "skip", material, fog: surface.fog, entityOrder: SOURCE_DRAW_ENTITY_WORLD, entity: null });
            continue;
          }
          if (surfaceCulled(surfaceIndex, material, refdef.viewOrigin, frustum, null)) continue;
          addDrawSurf({ kind: "surface", writer: "bsp-normal", mesh, plane: surfacePortalPlane(surfaceIndex), grid: patches.get(surfaceIndex) ?? null, material, fog: surface.fog,
            entityOrder: SOURCE_DRAW_ENTITY_WORLD, entity: null, lighting: null, worldSurface: surfaceIndex, dlighted: lightSurface(surfaceIndex, dlightBits, dynamicLights, frontend.smpFrame),
            dlightBeforeOverflow: surface.type === "triangles" });
        }
      }
      const viewFar = farClip(refdef, visibleBounds);
      performance.zFar = viewFar;
      const projection = viewProjection(refdef, viewFar, frontend.zNear);
      const entities = Array.from({ length: entityRange.length }, (_, index) => entityRange.entity(index).entity);
      const md3View = entities.length === 0 ? null : { origin: refdef.viewOrigin, forward: refdef.viewAxis[0], projection, frustum, performance,
        isPortal: portal !== null, noCull: resources.settings.runtime.noCull };
      const materialByName = (name: string): MaterialRecord => {
        const material = readyModelMaterials.get(normalizeShaderName(name));
        if (material === undefined) throw new Error(`entity material ${name} was not registered before frame`);
        return material;
      };
      for (const poly of capture.polys) {
        const material = sceneShaderMaterial(poly.shader, "polygon shader"), mesh = polyGeometry(poly), fog = poly.fog;
        addDrawSurf({ kind: "surface", writer: "poly", mesh, plane: { kind: "triangle" }, grid: null, material, fog,
          entityOrder: SOURCE_DRAW_ENTITY_WORLD, entity: null, lighting: null });
      }
      if (resources.settings.runtime.drawEntities) for (const [entityOrder, entity] of entities.entries()) {
        const cell = entityRange.entity(entityOrder);
        cell.needDlights = false;
        if (portal !== null && (entity.renderFlags & RF_FIRST_PERSON) !== 0) continue;
        if (entity.kind === "poly") throw new CommonError("drop", "R_AddEntitySurfaces: Bad reType");
        if (![entity.origin.x, entity.origin.y, entity.origin.z].every(Number.isFinite)) throw new RangeError("entity origin must be finite");
        if (entity.kind === "portal-surface") {
          if (![entity.oldOrigin, ...entity.axis].every(vector => [vector.x, vector.y, vector.z].every(Number.isFinite))
            || ![entity.frame, entity.oldFrame, entity.skinNum, entity.renderFlags].every(value => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff)) {
            throw new RangeError("portal entity requires finite coordinates and signed int32 fields");
          }
          continue;
        }
        if (entity.kind !== "model") {
          if (portal === null && (entity.renderFlags & RF_THIRD_PERSON) !== 0) continue;
          if (!Number.isInteger(entity.renderFlags) || entity.renderFlags < -0x80000000 || entity.renderFlags > 0x7fffffff) throw new RangeError("entity renderFlags must be a signed int32");
          if (![entity.radius, entity.shaderTime, entity.shaderTexCoord.x, entity.shaderTexCoord.y].every(Number.isFinite)) throw new RangeError("procedural entity parameters must be finite");
          if (![entity.shaderRGBA.x, entity.shaderRGBA.y, entity.shaderRGBA.z, entity.shaderRGBA.w].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new RangeError("entity shaderRGBA requires byte values");
          if (entity.kind === "sprite" ? !Number.isFinite(entity.rotation) : ![entity.oldOrigin.x, entity.oldOrigin.y, entity.oldOrigin.z].every(Number.isFinite)) throw new RangeError("procedural entity orientation must be finite");
          const material = sceneShaderMaterial(entity.customShader);
          const fog = noWorld ? -1 : spriteFog(entity.origin, entity.radius, fogs.map(fog => fog.bounds));
          addDrawSurf({ kind: "entity", entity, material, entityOrder, fog });
          continue;
        }
        modelRegistry.validateParameters(entity);
        // R_RotateForEntity runs before R_GetModelByHandle, including MOD_BAD.
        const localView = modelViewOrigin(entity, refdef.viewOrigin);
        const model = typeof entity.model === "number" ? modelRegistry.modelForHandle(entity.model) : entity.model;
        modelRegistry.validateModel(model);
        if (md3View === null) throw new Error("model view was not prepared");
        if (model.kind === "default" || model.kind === "bad") {
          if (portal === null && (entity.renderFlags & RF_THIRD_PERSON) !== 0) continue;
          sceneShaderMaterial(entity.customShader);
          addDrawSurf({ kind: "entity", entity, material: defaultMaterial, entityOrder, fog: -1 });
          continue;
        }
        if (model.kind === "md4") {
          for (const surface of model.md4.drawSurfaces()) {
            addDrawSurf({ kind: "md4", surface, material: surface.material, entity, entityOrder, fog: -1 });
          }
          continue;
        }
        if (model.kind === "inline") {
          if (model.map !== map || !inlineOwners.has(model)) throw new Error("inline model belongs to another world or is unregistered");
          if (source === null) throw new Error("inline model requires a loaded BSP resource");
          const inline = at(model.map.models, model.index);
          if (localBoxCull(inline.bounds, md3View.frustum, entity) === "out") continue;
          dlights.transformed = dynamicLights.length === 0 ? [] : capture.transformDlights(entity.origin, entity.axis);
          const inlineMask = bmodelDlightMask(dlights.transformed, inline.bounds);
          cell.needDlights = inlineMask !== 0;
          for (let offset = 0; offset < inline.surfaceCount; offset++) source.setSurfaceDlightBits(inline.firstSurface + offset, frontend.smpFrame, inlineMask);
          for (let offset = 0; offset < inline.surfaceCount; offset++) {
            const index = inline.firstSurface + offset;
            if (submittedSurfaces.has(index)) continue;
            submittedSurfaces.add(index);
            const surface = at(model.map.surfaces, index), mesh = at(geometry, index);
            const material = at(worldMaterials, index);
            if (surface.type === "flare") {
              addDrawSurf({ kind: "flare", material, fog: surface.fog, entityOrder, entity });
              continue;
            }
            if (surface.type === "patch" && !patches.has(index)) {
              addDrawSurf({ kind: "skip", material, fog: surface.fog, entityOrder, entity });
              continue;
            }
            if (surfaceCulled(index, material, localView, frustum, entity)) continue;
            addDrawSurf({ kind: "surface", writer: "bsp-normal", mesh, plane: surfacePortalPlane(index), grid: patches.get(index) ?? null, material, fog: surface.fog, entityOrder, entity, lighting: null,
              worldSurface: index, dlighted: lightSurface(index, inlineMask === 0 ? 0 : 1, dynamicLights, frontend.smpFrame), dlightBeforeOverflow: surface.type === "triangles" });
          }
          continue;
        }
        const prepared = prepareMd3EntityPose({ md3: model.md3, numLods: model.numLods, entity,
          view: { ...md3View, lodScale: frontend.lodScale, lodBias: frontend.lodBias },
          frameWarning: (oldFrame, frame) => {
            if (settings.runtime.developerEnabled)
              services.print(`R_AddMD3Surfaces: no such frame ${oldFrame} to ${frame} for '${modelRegistry.modelName(model)}'\n`);
          } });
        if (prepared.cull === "out") continue;
        const shadows = resources.settings.runtime.shadows;
        if (!prepared.personalModel || shadows > 1) {
          const { identityLight, identityLightByte } = services.imageProfile().colorMappings;
          cell.setupLighting({ grid: lightGrid.grid, noWorldModel: noWorld, identityLight, identityLightByte,
            ambientScale: settings.lighting.ambientScale, directedScale: settings.lighting.directedScale,
            sunDirection: map === null ? sun.direction : worldSunDirection, dynamicLights },
          { get enabled() { return settings.runtime.debugLight; }, print: text => services.print(text) });
        }
        const fogIndex = md3FogIndex(noWorld || fogs.length === 0 ? null : [at(fogs, 0).bounds, ...fogs.map(fog => fog.bounds)],
          prepared.currentFrame, entity.origin);
        for (const md3 of md3Surfaces(prepared.model)) {
          let material: MaterialRecord;
          const customShader = entity.customShader !== null && entity.customShader !== 0;
          if (customShader) material = sceneShaderMaterial(entity.customShader);
          else {
            const skin = typeof entity.customSkin === "number" ? modelRegistry.skinForHandle(entity.customSkin) : entity.customSkin;
            if (skin !== null) {
              modelRegistry.validateSkin(skin);
              const selected = skin.surfaces.find(surface => surface.name === md3.name);
              material = selected === undefined ? defaultMaterial : materialByName(selected.shader);
              if (settings.runtime.developerEnabled) {
                if (material === defaultMaterial) services.print(`WARNING: no shader for surface ${md3.name} in skin ${skin.path}\n`);
                else if (material.defaulted) services.print(`WARNING: shader ${material.name} in skin ${skin.path} not found\n`);
              }
            } else if (md3ShaderCount(md3) <= 0) material = defaultMaterial;
            else {
              const shaderIndex = md3ShaderIndex(md3, entity.skinNum);
              const registered = materialRegistry.findByHandle(shaderIndex);
              if (registered === null) throw new RangeError(`R_AddMD3Surfaces: shader index ${shaderIndex} has no allocated shader`);
              material = registered;
            }
          }
          const stencilShadow = !prepared.personalModel && resources.settings.runtime.shadows === 2 && fogIndex === 0
            && (entity.renderFlags & (RF_NOSHADOW | RF_DEPTHHACK)) === 0 && material.sort === 3;
          const projectionShadow = resources.settings.runtime.shadows === 3 && fogIndex === 0
            && (entity.renderFlags & RF_SHADOW_PLANE) !== 0 && material.sort === 3;
          if (prepared.personalModel && !projectionShadow) continue;
          if (stencilShadow) {
            addDrawSurf({ kind: "md3", surface: md3, material: stencilShadowMaterial, fog: -1, entityOrder, entity });
          }
          if (projectionShadow) {
            addDrawSurf({ kind: "md3", surface: md3, material: projectionShadowMaterial, fog: -1, entityOrder, entity });
          }
          if (prepared.personalModel) continue;
          addDrawSurf({ kind: "md3", surface: md3, material, fog: fogIndex - 1, entityOrder, entity });
        }
      }
      const drawRange = drawSurfaces.viewRange(firstDrawSurf);
      sortDrawSurfs(drawRange);
      const drawMaterial = (sort: number): MaterialRecord => {
        const shaderIndex = decomposeSourceDrawSort(sort).shader;
        const material = materialRegistry.findBySortedIndex(shaderIndex);
        if (material === null) throw new RangeError(`R_DecomposeSort: sorted shader ${shaderIndex} has no allocated shader`);
        return material;
      };
      const readDrawSurface = (index: number, sorts: SourceDrawSortRange): WorldBackendSurface => {
        const sort = sorts.getSort(index), fields = decomposeSourceDrawSort(sort);
        const surface = drawRange.surface(index), material = drawMaterial(sort);
        const entity = fields.entity === SOURCE_DRAW_ENTITY_WORLD ? null : entityRange.allocatedEntity(fields.entity).entity;
        const state = { material, entity, entityOrder: fields.entity, fog: fields.fog - 1, dlighted: fields.dlight };
        return { ...surface, ...state };
      };
      const earlierViews: SourcePreparedViews[] = [];
      const backendView: WorldBackendResolvedView = {
        smpFrame: frontend.smpFrame,
        refdef, projection, mirror, portal, viewFar, capture, dlights,
        ...(view.polygonOffset === undefined ? {} : { polygonOffset: view.polygonOffset }),
        scene: frontend.scene, world: backendWorld, drawRange,
        get flushBeforeView() { return earlierViews.length !== 0; },
        surface: index => drawRange.surface(index),
        surfaceDlightBits: backendSurfaceDlightBits,
      };
      for (let index = 0; index < drawRange.length; index++) {
        const material = drawMaterial(drawRange.getSort(index));
        if (material.sort > 1) break;
        if (material.sort === 0) throw new CommonError("drop", `Shader '${material.name}'with sort == SS_BAD`);
        if (portal !== null) { diagnostics.add("WARNING: recursive mirror/portal found"); continue; }
        if (resources.settings.runtime.noPortals || resources.settings.runtime.fastSky === 1) continue;
        const child = services.worldTransport === undefined
          ? worldBackend.probeResolved(backendView, readDrawSurface(index, drawRange))
          : services.worldTransport.probe(backendView, index);
        if (child === null) continue;
        const prepareChild = prepareView({ ...view, refdef: { ...refdef, viewOrigin: child.origin, viewAxis: child.axis } }, capture, child, dlights, frontend, submit, drawSurfaces, visibleBounds);
        performance.zFar = viewFar; // R_MirrorViewBySurface restores viewParms, but not tr.viewCluster.
        if (!submit) earlierViews.push(prepareChild);
        if (resources.settings.runtime.portalOnly) {
          if (submit) debugGraphics();
          return prepareChild;
        }
        break;
      }
      const serialPrepare = function* (executionRange: SourceDrawSortRange = drawRange): Generator<SourceRenderView, void, unknown> {
        for (const earlier of earlierViews) yield* earlier();
        yield worldBackend.prepareResolved(backendView, executionRange);
      };
      const transport = services.worldTransport;
      const prepare = transport === undefined ? serialPrepare : Object.assign(serialPrepare, {
        captureThreadedView(executionRange: SourceDrawSortRange = drawRange) {
          if (earlierViews.length !== 0) throw new Error("Collected portal views require serial diagnostic execution");
          return transport.capture(backendView, executionRange);
        },
      });
      if (submit) {
        services.target.queuePreparedViews(prepare, drawRange);
        debugGraphics();
      }
      return prepare;
    }
    return { markSurfaces, lightmaps, hasLightGrid: lightGrid.grid !== null, fogBounds: fogs.map(fog => fog.bounds), prepareScene,
      lightForPoint: point => lightForPoint(lightGrid.grid, point, settings.lighting),
      renderFrame: view => { prepareFrame(view, true); }, prepareFrame,
      frame(view) {
        if (tess.flares.activeHead !== null) throw new Error("Collected diagnostic frames cannot retain live flare state; execute prepareFrame with an independent renderer context");
        const result: RenderView[] = [];
        for (const sourceView of prepareFrame(view)()) {
          const collect = (operation: SurfaceViewOperation): SurfaceViewOperation => operation.kind === "source-stage" || operation.kind === "source-tess-stage"
            ? { ...operation, stage: snapshotStageBindings(operation.stage) } : operation;
          const beforeView: SurfaceViewOperation[] = [], operations: ViewOperation[] = [];
          const header = { viewport: sourceView.viewport,
            ...(sourceView.clipPlane === undefined ? {} : { clipPlane: sourceView.clipPlane }) };
          for (const operation of sourceView.beforeView ?? []) beforeView.push(collect(operation));
          tess.beginDrawingView();
          const clear = sourceView.clear;
          for (const operation of sourceView.operations) {
            if (operation.kind === "render-flares") {
              if (tess.flares.activeHead !== null) throw new Error("Collected diagnostic frames cannot retain live flare state; execute prepareFrame with an independent renderer context");
              const rejectDepth = (): never => { throw new Error("Collected diagnostic frames cannot read live flare depth"); };
              for (const surface of operation.render({ resetFinishCalled: rejectDepth, readDepthPixel: rejectDepth })) operations.push(collect(surface));
            } else operations.push(operation.kind === "shadow-finish" ? operation : collect(operation));
          }
          result.push({ ...header, clear, beforeView, operations });
        }
        return result;
      } };
  }
  const noWorldFrame = await compileScene(null);
  const resources: RendererResources = {
    performance,
    images,
    builtins: builtinImages,
    memoryProfile,
    tess,
    worldBackend,
    backendMaterials: { defaultMaterial, flareMaterial, sunMaterial },
    fonts: new RendererFontRegistry(vfs, async path => resources.picture(await resources.registerShaderNoMip(path)),
      () => services.target.syncRenderThread(), services.fontGeneration === undefined ? null : {
        ...services.fontGeneration,
        async registerImage(name, rgba) {
          const image = publishImage({ name, mipmap: false, allowPicmip: false, wrap: "clamp" }, { width: 256, height: 256, pixels: rgba });
          const material = await materialRegistry.registerFromImage(name, { kind: "picture" }, image, false,
            { whiteImage, profile: settings.registrationProfile(), smp: () => settings.runtime.smpRequested ? 1 : 0,
              synchronize: () => services.target.syncRenderThread() });
          return resources.picture(shaderForMaterial(material));
        },
      }),
    get sceneEntities() { return sceneEntities; },
    settings,
    get diagnostics() { return [...diagnostics]; },
    get worldBaseName() { return worldBaseName; },
    drawSun() {
      if (services.worldTransport === undefined) services.target.executeSurfaceOperations(worldBackend.drawSun(sun.direction));
      else services.worldTransport.drawSun(sun.direction);
    },
    clearScene: () => sceneSubmission.clearScene(),
    addRefEntity: entity => sceneSubmission.addRefEntity(entity),
    addRefEntityRecord: read => sceneSubmission.addRefEntityRecord(read),
    addPoly: poly => sceneSubmission.addPoly(poly),
    addPolysByHandle: (shaderHandle, numVerts, numPolys, readVertices) => sceneSubmission.addPolysByHandle(shaderHandle, numVerts, numPolys, readVertices),
    addLight: light => sceneSubmission.addLight(light),
    addLightRecord: (radius, color, additive, readOrigin) => sceneSubmission.addLightRecord(radius, color, additive, readOrigin),
    renderScene: refdef => resources.renderSceneRecord(() => refdef.renderFlags, () => refdef),
    renderSceneRecord(readFlags, read) {
      services.target.executeSurfaceOperations([{ kind: "log-comment", text: "====== RE_RenderScene =====\n" }]);
      if (settings.runtime.noRefresh) return;
      const started = services.clock?.milliseconds();
      if (activeLightmaps === null && (readFlags() & RDF_NOWORLDMODEL) === 0)
        throw new CommonError("drop", "R_RenderScene: NULL worldmodel");
      const refdef = read();
      const capture = sceneSubmission.captureScene();
      (activeLightmaps === null ? noWorldFrame : activeLightmaps.compiled).prepareScene({ refdef }, capture, true);
      activeScene.drawSurfaces.completeScene();
      sceneSubmission.completeScene(capture);
      if (started !== undefined && services.clock !== undefined)
        performance.frontEndMsec = (performance.frontEndMsec + services.clock.milliseconds() - started) | 0;
    },
    lightForPoint: point => resources.lightForPointRecord(() => point),
    lightForPointRecord: readPoint => activeLightmaps === null || !activeLightmaps.compiled.hasLightGrid
      ? null : activeLightmaps.compiled.lightForPoint(readPoint()),
    markFragments(query) {
      if (activeLightmaps === null) throw new CommonError("drop", "R_MarkFragments: NULL worldmodel");
      return new BspMarkProjector({ map: activeLightmaps.map, surfaces: activeLightmaps.compiled.markSurfaces }).markFragmentsRecord(query);
    },
    getEntityToken(write) {
      const token = entityParser.parse(entityCursor);
      write(token);
      if (entityCursor.offset === null || token.length === 0) {
        entityCursor.offset = 0;
        return false;
      }
      return true;
    },
    inPVS(readFirst, readSecond, clusterPVS) {
      const visibility = clusterPVS(pointCluster(readFirst));
      const cluster = pointCluster(readSecond), byte = visibility.byteAt(cluster >> 3);
      return (byte & (1 << (cluster & 7))) !== 0;
    },
    rolloverFrame() {
      sceneSubmission.rolloverFrame();
      activeScene.drawSurfaces.rolloverFrame();
      smpFrame = settings.runtime.smpRequested ? smpFrame === 0 ? 1 : 0 : 0;
      const selected = selectSceneStorage();
      selected.backend.commandsData().setInt32(SOURCE_BACKEND_RELEASE32.commandBytes, 0, true);
      if (selected !== activeScene) { selected.submission.rolloverFrame(); selected.drawSurfaces.rolloverFrame(); }
      activeScene = selected; sceneEntities = selected.entities; sceneSubmission = selected.submission;
      tess.frontEndSmpFrame = smpFrame;
      tess.frontEndMemory = selected.backend;
    },
    listShaders,
    listModels,
    listSkins,
    registerModel: path => modelRegistry.registerModel(path),
    registerSkin: path => modelRegistry.registerSkin(path),
    registerShader: name => registerShader(name, true),
    registerShaderNoMip: name => registerShader(name, false),
    modelHandle: model => modelRegistry.modelHandle(model),
    modelForHandle: handle => modelRegistry.modelForHandle(handle),
    skinHandle: skin => modelRegistry.skinHandle(skin),
    skinForHandle: handle => modelRegistry.skinForHandle(handle),
    shaderHandle: shader => shader === null ? 0 : shaderMaterial(shader).order,
    shaderForHandle(handle) {
      const material = materialRegistry.findByHandle(handle);
      if (material === null) {
        services.print(`R_GetShaderByHandle: out of range hShader '${handle}'\n`);
        return shaderForMaterial(defaultMaterial);
      }
      return handle === 0 ? null : shaderForMaterial(material);
    },
    async remapShader(original, replacement, timeOffset) {
      const world = activeLightmaps, image = world === null ? loadingWorld?.images[0] : world.images[0];
      const map = world === null ? loadingWorld?.source.map : world.map;
      const lighting: MaterialLighting = map === undefined || image === undefined ? { kind: "vertex" }
        : { kind: "lightmap", owner: map, index: 0, image };
      async function lookup(name: string): Promise<MaterialRecord | null> {
        const end = name.indexOf("\0");
        if (end !== -1) name = name.slice(0, end);
        const existing = materialRegistry.find(name);
        if (existing !== null && existing !== defaultMaterial) return existing;
        if (name.length === 0 || name.length >= 64) return null;
        const registered = await findMaterial(name, lighting);
        return registered.defaulted || registered === defaultMaterial ? null : registered;
      }
      if (await lookup(original) === null) { diagnostics.add(`WARNING: R_RemapShader: shader ${original} not found`); return; }
      const target = await lookup(replacement);
      if (target === null) { diagnostics.add(`WARNING: R_RemapShader: new shader ${replacement} not found`); return; }
      materialRegistry.remap(original, target, timeOffset);
    },
    picture(shader) {
      const cached = pictures.get(shader);
      if (cached !== undefined) return cached;
      const picture: MaterialPicture = { kind: "material", name: shader?.name ?? "<default>",
        material: shader === null ? defaultMaterial : shaderMaterial(shader) };
      pictures.set(shader, picture);
      return picture;
    },
    async loadWorld(mapName) {
      if (worldMapLoaded) throw new CommonError("drop", "ERROR: attempted to redundantly load world map\n");
      sun = { ...sun, direction: normalize3(vec3(0.45, 0.3, 0.9)) };
      worldMapLoaded = true;
      const mapPath = mapName.startsWith("maps/") ? mapName : `maps/${mapName}`;
      const filename = mapPath.endsWith(".bsp") ? mapPath : `${mapPath}.bsp`;
      const file = await vfs.readFileRetained(filename);
      if (file === undefined) throw new CommonError("drop", `RE_LoadWorldMap: ${filename} not found`);
      activeLightmaps = null;
      entityCursor = new CommonParseCursor("");
      // R_LoadWorldMap copies name[MAX_QPATH] before COM_SkipPath / COM_StripExtension.
      const sourceName = filename.slice(0, 63).replace(/\0.*$/s, "");
      const baseName = sourceName.slice(sourceName.lastIndexOf("/") + 1).replace(/\..*$/s, "");
      worldBaseName = baseName;
      const source = new SourceBspResource(file, filename, memoryProfile, text => { diagnostics.add(text.trimEnd()); return services.print(text); }, services.patchMemory);
      const lightmaps: RendererImage[] = [];
      loadingWorld = { source, images: lightmaps };
      const map = source.map;
      source.begin();
      source.loadShaders();
      const colorShift = (): number => settings.bspProfile().mapOverbrightBits - services.imageProfile().colorMappings.overbrightBits;
      const vertexLighting = (): boolean => settings.bspProfile().vertexLight || settings.registrationProfile().hardware === "permedia2";
      let maximumIntensity = 0;
      const uploadedLightmaps = source.loadLightmaps(() => services.target.syncRenderThread(), vertexLighting, (data, index) => {
        const converted = lightmapImage(data, colorShift(), settings.bspProfile().lightmap);
        if (converted.maximum > maximumIntensity) maximumIntensity = converted.maximum;
        lightmaps[index] = publishImage({ name: `*lightmap${index}`, mipmap: false, allowPicmip: false, wrap: "clamp" }, converted.image);
      });
      if (uploadedLightmaps && settings.bspProfile().lightmap === 2) services.print(`Brightest lightmap value: ${Math.trunc(Math.fround(maximumIntensity * 255))}\n`);
      source.loadPlanes();
      await source.loadFogs(async name => {
        const material = await findMaterial(name, { kind: "none" }), parameters = material.definition?.fog;
        if (parameters !== undefined && parameters !== null) return parameters;
        diagnostics.add(`${name}: missing fogparms; source default black fog depth 1`);
        return { color: { x: 0, y: 0, z: 0 }, depthForOpaque: 0 };
      }, services.imageProfile().colorMappings.identityLight);
      await source.loadSurfaces({ defaultMaterial, profile: () => settings.bspProfile(), colorShift, findShader: async (shader, inputLightmap) => {
        let index = inputLightmap;
        if (vertexLighting()) index = -3;
        if (settings.bspProfile().fullbright) index = -2;
        const image = lightmaps[index];
        const lighting: MaterialLighting = index >= 0 ? image === undefined ? { kind: "vertex" } : { kind: "lightmap", owner: map, index, image }
          : index === -1 ? { kind: "none" } : index === -2 ? { kind: "white" } : index === -3 ? { kind: "vertex" } : index === -4 ? { kind: "picture" }
            : (() => { throw new RangeError(`invalid BSP lightmap mode ${index}`); })();
        const material = await findMaterial(shader.name, lighting);
        return material.defaulted ? defaultMaterial : material;
      } });
      source.loadMarksurfaces();
      source.loadNodesAndLeafs();
      const inlineModels: SceneInlineModel[] = [];
      source.loadSubmodels(index => {
        const model: SceneInlineModel = { kind: "inline", path: `*${index}`, index, map };
        modelRegistry.allocateInlineModels([model]); inlineOwners.add(model); inlineModels.push(model);
      });
      source.loadVisibility(() => externalVisData);
      await source.loadEntities(text => { entityCursor = new CommonParseCursor(text); },
        async (original, replacement) => { await resources.remapShader(original, replacement, "0"); }, () => settings.bspProfile().vertexLight);
      source.loadLightGrid(colorShift());
      const compiled = await compileScene(source, lightmaps);
      source.finish();
      activeLightmaps = { map, images: lightmaps, inlineModels, compiled };
      loadingWorld = null;
      vfs.freeFile(file);
      return { map, resources, markGeometry: { map, surfaces: compiled.markSurfaces }, lightForPoint: compiled.lightForPoint,
        get diagnostics() { return [...diagnostics]; }, initialCamera: () => initialCamera(map),
        inlineModel: index => at(inlineModels, index), renderFrame: compiled.renderFrame, frame: compiled.frame, prepareFrame: compiled.prepareFrame };
    },
    setWorldVisData(bytes) { externalVisData = bytes; return undefined; },
    renderFrame: view => (activeLightmaps === null ? noWorldFrame : activeLightmaps.compiled).renderFrame(view),
    frame: view => (activeLightmaps === null ? noWorldFrame : activeLightmaps.compiled).frame(view),
    prepareFrame: view => (activeLightmaps === null ? noWorldFrame : activeLightmaps.compiled).prepareFrame(view),
  };
  return resources;
}
