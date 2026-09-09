// Persistent tess/backEnd scratch from id Software renderer/tr_surface.c,
// tr_animation.c, tr_shade.c and tr_backend.c. SPDX-License-Identifier: GPL-2.0-or-later
import type { BspVertex } from "../assets/bsp.ts";
import type { Md3Surface } from "../assets/md3.ts";
import { CommonError } from "../core/common-error.ts";
import type { Axis, Vec2, Vec3, Vec4 } from "../core/math.ts";
import { vec2, vec3, vec4 } from "../core/math.ts";
import { normalizeFast3 } from "../core/renderer-math.ts";
import type { DeformGeometry, RendererNoise } from "./deform.ts";
import type { EntityLighting } from "./lighting.ts";
import type { FogVolume } from "./fog.ts";
import { rendererFloatTime, resolvedMaterial } from "./material-registry.ts";
import type { MaterialRecord } from "./material-registry.ts";
import { copySourceRefEntity } from "./ref-entity.ts";
import type { SourceRefEntity, SourceRefEntityRecord } from "./ref-entity.ts";
import type { ImmediateViewOperation, RenderState, SurfaceViewOperation } from "./types.ts";
import type { RendererImage } from "./image-resource.ts";
import type { RendererRuntimeSettings } from "./settings.ts";
import { copyRenderText, createRefdef } from "./refdef.ts";
import type { Refdef, RenderText } from "./refdef.ts";
import type { RegisteredMd4Surface } from "./md4-resource.ts";
import { md3SurfaceSource } from "./md3-resource.ts";
import type { SourceSceneEntity } from "./scene-entities.ts";
import { SourceRefEntityMemory } from "./scene-entity-memory.ts";
import { ShadowEdgeState } from "./stencil-shadows.ts";
import type { StencilShadowGeometry } from "./stencil-shadows.ts";
import { RendererPerformanceCounters } from "./performance.ts";
import { SourceFlares } from "./flares.ts";

/** tr_local.h srfDisplayList_t. No source frontend constructs this surface. */
export interface SourceDisplayListSurface {
  readonly kind: "display-list";
  readonly listNum: number;
}

/** tr_surface.c RB_SurfaceDisplayList calls GL without flushing or changing tess. */
export function sourceSurfaceDisplayList(surface: SourceDisplayListSurface): Extract<ImmediateViewOperation, { kind: "display-list" }> {
  const listNum = surface.listNum;
  if (!Number.isInteger(listNum) || listNum < -0x80000000 || listNum > 0x7fffffff)
    throw new RangeError("srfDisplayList_t.listNum requires a signed int32");
  return { kind: "display-list", listNum: listNum >>> 0 };
}

export type TessWriter = "bsp-normal" | "bsp" | "md3" | "stamp" | "poly" | "stretch-pic" | "rail" | "cloud";
export interface TessViewContext { readonly origin: Vec3; readonly axis: Axis; readonly mirror: boolean }
export interface TessFogContext {
  readonly volume: FogVolume;
  readonly texture: RendererImage;
  readonly coordinates: (localPosition: Vec3) => Vec2;
}
export interface TessEntityContext {
  readonly kind: "world" | "entity" | "2d";
  readonly entity: SourceRefEntity | null;
  readonly lighting: EntityLighting;
  readonly localViewOrigin: Vec3;
  readonly orientationAxis: Axis;
  readonly orientationOrigin: Vec3;
}
type TessOrientation = Omit<TessEntityContext, "kind" | "entity" | "lighting">;
type TessEntitySelection =
  | { readonly kind: "initial-null" | "detached" | "global"; readonly context: TessEntityContext }
  | { readonly kind: "scene-cell"; readonly cell: SourceSceneEntity; readonly orientation: TessOrientation };
type SurfaceEvaluator = (identityLight: number, noise: RendererNoise, runtime: RendererRuntimeSettings) => Iterable<SurfaceViewOperation, unknown, unknown>;

const f = Math.fround;
const VERTICES = 1000, INDEXES = 6000;
function zeroAxis(): Axis { return [vec3(0, 0, 0), vec3(0, 0, 0), vec3(0, 0, 0)]; }
function copyAxis(axis: Axis): Axis { return [{ ...axis[0] }, { ...axis[1] }, { ...axis[2] }]; }
function zeroLighting(): EntityLighting {
  return { ambientLight: vec3(0, 0, 0), directedLight: vec3(0, 0, 0), lightDir: vec3(0, 0, 0), ambientLightInt: 0 };
}
function globalEntity(): SourceRefEntityRecord {
  const storage = new DataView(new ArrayBuffer(192));
  return new SourceRefEntityMemory(() => storage).entity;
}
function zeroVertex(): BspVertex {
  return { position: vec3(0, 0, 0), normal: vec3(0, 0, 0), texCoord: vec2(0, 0), lightmapCoord: vec2(0, 0), color: { x: 0, y: 0, z: 0, w: 0 } };
}
function copyVertex(vertex: BspVertex): BspVertex {
  return { position: vec3(vertex.position.x, vertex.position.y, vertex.position.z), normal: vec3(vertex.normal.x, vertex.normal.y, vertex.normal.z),
    texCoord: vec2(vertex.texCoord.x, vertex.texCoord.y), lightmapCoord: vec2(vertex.lightmapCoord.x, vertex.lightmapCoord.y),
    color: { x: vertex.color.x & 255, y: vertex.color.y & 255, z: vertex.color.z & 255, w: vertex.color.w & 255 } };
}
function copyContext(context: TessEntityContext): TessEntityContext {
  return { ...context, entity: context.entity === null ? null : copySourceRefEntity(context.entity),
    lighting: { ...context.lighting, ambientLight: { ...context.lighting.ambientLight }, directedLight: { ...context.lighting.directedLight }, lightDir: { ...context.lighting.lightDir } },
    localViewOrigin: { ...context.localViewOrigin }, orientationAxis: copyAxis(context.orientationAxis), orientationOrigin: { ...context.orientationOrigin } };
}
function copyOrientation(orientation: TessOrientation): TessOrientation {
  return { localViewOrigin: { ...orientation.localViewOrigin }, orientationAxis: copyAxis(orientation.orientationAxis),
    orientationOrigin: { ...orientation.orientationOrigin } };
}
function md3IndexCount(triangles: number): number {
  const count = triangles * 3;
  if (!Number.isInteger(count) || count < -0x80000000 || count > 0x7fffffff)
    throw new RangeError("RB_SurfaceMesh: triangle index count exceeds the source signed integer range");
  return count;
}

/** One renderer-owned source BSS allocation. Begin/End never clear attribute arrays. */
export class SourceTessState {
  readonly flares: SourceFlares;
  constructor(readonly performance = new RendererPerformanceCounters()) { this.flares = new SourceFlares(performance.backEnd); }

  frontEndSmpFrame: 0 | 1 = 0;
  backEndSmpFrame: 0 | 1 = 0;
  frontEndMemory: import("./backend-memory.ts").SourceBackendMemory | null = null;

  private readonly vertices: BspVertex[] = Array.from({ length: VERTICES }, zeroVertex);
  private readonly indexes: number[] = Array.from({ length: INDEXES }, () => 0);
  private readonly colors: Vec4[] = Array.from({ length: VERTICES }, () => ({ x: 0, y: 0, z: 0, w: 0 }));
  private readonly coordinates: readonly [Vec2[], Vec2[]] = [Array.from({ length: VERTICES }, () => vec2(0, 0)), Array.from({ length: VERTICES }, () => vec2(0, 0))];
  private readonly shadowEdges = new ShadowEdgeState();
  // tr.worldEntity and backEnd.entity2D are distinct BSS records, never frame cells.
  private readonly worldEntity = globalEntity();
  private readonly entity2D = globalEntity();
  private readonly worldLighting = zeroLighting();
  private readonly entity2DLighting = zeroLighting();
  private vertexCount = 0;
  private indexCount = 0;
  private currentMaterial: MaterialRecord | null = null;
  private currentFog = 0;
  private currentDlightBits = 0;
  private currentFogContext: TessFogContext | null = null;
  private ordinaryEvaluator: SurfaceEvaluator | null = null;
  private currentShaderTime = 0;
  private refdefMilliseconds = 0;
  private refdefFloatTime = 0;
  private refdefText: RenderText = createRefdef().text;
  private projection2D = false;
  private cachedCull: RenderState["cull"] | null = null;
  private actualCull: RenderState["cull"] = "none";
  private currentDepthRange: readonly [number, number] = [0, 1];
  private positionProjector: (position: Vec3) => Vec4 = position => vec4(position.x, position.y, position.z, 1);
  private currentView: TessViewContext = { origin: vec3(0, 0, 0), axis: zeroAxis(), mirror: false };
  private currentContext: TessEntitySelection = { kind: "initial-null", context: { kind: "world", entity: null, lighting: zeroLighting(),
    localViewOrigin: vec3(0, 0, 0), orientationAxis: zeroAxis(), orientationOrigin: vec3(0, 0, 0) } };

  get numVertexes(): number { return this.vertexCount; }
  get numIndexes(): number { return this.indexCount; }
  get material(): MaterialRecord | null { return this.currentMaterial; }
  get fog(): number { return this.currentFog; }
  get dlightBits(): number { return this.currentDlightBits; }
  get fogContext(): TessFogContext | null { return this.currentFogContext; }
  get surfaceEvaluator(): SurfaceEvaluator | null { return this.ordinaryEvaluator; }
  get shaderTime(): number { return this.currentShaderTime; }
  get refdefTime(): number { return this.refdefMilliseconds; }
  get floatTime(): number { return this.refdefFloatTime; }
  get renderText(): RenderText { return this.refdefText; }
  get is2D(): boolean { return this.projection2D; }
  get view(): TessViewContext { return this.currentView; }
  get context(): TessEntityContext {
    const selection = this.currentContext;
    return selection.kind === "scene-cell"
      ? { kind: "entity", entity: selection.cell.entity, lighting: selection.cell.lighting, ...selection.orientation }
      : selection.context;
  }
  get actualDepthRange(): readonly [number, number] { return [this.currentDepthRange[0], this.currentDepthRange[1]]; }
  get actualCullState(): RenderState["cull"] { return this.actualCull; }

  bindSurfaceEvaluator(evaluate: SurfaceEvaluator): void {
    if (this.ordinaryEvaluator !== null) throw new Error("Tess surface evaluator is already bound");
    this.ordinaryEvaluator = evaluate;
  }

  addDlightBits(bits: number): void { this.currentDlightBits |= bits; }

  beginSurface(raw: MaterialRecord, fog: number, floatTime: number): void {
    this.vertexCount = 0;
    this.indexCount = 0;
    this.currentDlightBits = 0;
    const material = resolvedMaterial(raw);
    this.currentMaterial = material;
    this.currentFog = fog;
    if (fog === 0) this.currentFogContext = null;
    this.currentShaderTime = f(f(floatTime) - f(material.timeOffset));
    const clampTime = material.definition?.clampTime ?? 0;
    if (clampTime !== 0 && this.currentShaderTime >= clampTime) this.currentShaderTime = f(clampTime);
  }

  setFogContext(context: TessFogContext | null): void { this.currentFogContext = context; }

  /** RB_EndSurface's ordinary iterator path resets only numIndexes. */
  endSurface(): void { this.indexCount = 0; }

  /** R_BuildCloudData resets counts without beginning another shader. */
  resetGeometry(): void { this.vertexCount = this.indexCount = 0; }

  /** RB_CHECKOVERFLOW uses strict less-than: the final slots are sentinels. */
  wouldOverflow(vertices: number, indexes: number): boolean {
    if (!Number.isInteger(vertices) || vertices < 0 || vertices >= VERTICES || !Number.isInteger(indexes) || indexes < 0 || indexes >= INDEXES) {
      throw new RangeError("RB_CheckOverflow: single surface exceeds tess capacity");
    }
    return this.vertexCount + vertices >= VERTICES || this.indexCount + indexes >= INDEXES;
  }

  appendGeometry(mesh: DeformGeometry, writer: TessWriter): void {
    if (writer === "cloud") {
      const base = this.vertexCount;
      // FillCloudySkySide publishes the final allocated vertex before ERR_DROP.
      for (const vertex of mesh.vertices) {
        this.vertices[this.vertexCount] = { ...this.vertex(this.vertexCount),
          position: vec3(vertex.position.x, vertex.position.y, vertex.position.z), texCoord: vec2(vertex.texCoord.x, vertex.texCoord.y) };
        if (++this.vertexCount >= VERTICES) throw new CommonError("drop", "SHADER_MAX_VERTEXES hit in FillCloudySkySide()\n");
      }
      for (const index of mesh.indices) {
        if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length) throw new RangeError("tess source index outside submitted geometry");
        if (this.indexCount >= INDEXES) throw new RangeError("cloud index outside tess allocation");
        this.indexes[this.indexCount++] = base + index;
      }
      return;
    }
    if (this.wouldOverflow(mesh.vertices.length, mesh.indices.length)) throw new RangeError("tess append requires an End/Begin overflow boundary");
    for (const index of mesh.indices) if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length) throw new RangeError("tess source index outside submitted geometry");
    const base = this.vertexCount;
    for (const [offset, input] of mesh.vertices.entries()) {
      const index = base + offset, previous = this.vertex(index), full = writer === "bsp-normal" || writer === "stamp";
      const vertex = copyVertex(input);
      this.vertices[index] = {
        position: vertex.position, texCoord: vertex.texCoord,
        normal: full || writer === "md3" ? vertex.normal : previous.normal,
        lightmapCoord: full || writer === "bsp" ? vertex.lightmapCoord : previous.lightmapCoord,
        color: writer === "md3" ? previous.color : writer === "rail" ? { ...vertex.color, w: previous.color.w } : vertex.color,
      };
    }
    for (const index of mesh.indices) this.indexes[this.indexCount++] = base + index;
    this.vertexCount += mesh.vertices.length;
  }

  /** RB_RenderFlare writes XY, primary UV and RGBA; retained Z and other arrays survive. */
  appendFlare(windowX: number, windowY: number, size: number, color: Vec3): void {
    for (const [u, v] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
      if (u === undefined || v === undefined) throw new Error("Missing flare corner");
      const previous = this.vertex(this.vertexCount);
      this.vertices[this.vertexCount] = { ...previous,
        position: { x: f(f(windowX) + (u === 0 ? -size : size)), y: f(f(windowY) + (v === 0 ? -size : size)), z: previous.position.z },
        texCoord: { x: u, y: v }, color: { x: color.x & 255, y: color.y & 255, z: color.z & 255, w: 255 } };
      this.vertexCount++;
    }
    for (const index of [0, 1, 2, 0, 2, 3]) this.indexes[this.indexCount++] = index;
  }

  /** RB_SurfaceMesh reads only its backlerp before the reached End/Begin boundary. */
  *appendMd3(surface: Md3Surface, flush: () => Iterable<SurfaceViewOperation, unknown, unknown>): Generator<SurfaceViewOperation, void, unknown> {
    const entity = this.md3Entity(), oldFrame = entity.oldFrame, frame = entity.frame;
    let backLerp = 0;
    if (oldFrame !== frame) {
      if (!("backLerp" in entity)) throw new Error(`RB_SurfaceMesh: detached ${entity.kind} entity does not represent the source backlerp cell`);
      backLerp = f(entity.backLerp);
    }
    const source = md3SurfaceSource(surface);
    if (this.vertexCount + source.numVerts >= VERTICES || this.indexCount + md3IndexCount(source.numTriangles) >= INDEXES) {
      const vertices = source.numVerts, indexes = md3IndexCount(source.numTriangles);
      if (this.vertexCount + vertices >= VERTICES || this.indexCount + indexes >= INDEXES) {
        yield* flush();
        if (vertices >= VERTICES) throw new CommonError("drop", `RB_CheckOverflow: verts > MAX (${vertices} > ${VERTICES})`);
        if (indexes >= INDEXES) throw new CommonError("drop", `RB_CheckOverflow: indices > MAX (${indexes} > ${INDEXES})`);
        const material = this.currentMaterial;
        if (material === null) throw new Error("RB_CheckOverflow without a begun source shader");
        this.beginSurface(material, this.currentFog, this.refdefFloatTime);
      }
    }

    const baseVertex = this.vertexCount;
    const current = source.vertexFrame(this.md3Entity().frame);
    const newXyzScale = f((1 / 64) * (1 - backLerp)), newNormalScale = f(1 - backLerp);
    const vertexCount = source.numVerts;
    if (backLerp === 0) {
      for (let offset = 0; offset < vertexCount; offset++) {
        const index = baseVertex + offset;
        this.writePositionComponent(index, "x", current.xyz(offset, 0) * newXyzScale);
        this.writePositionComponent(index, "y", current.xyz(offset, 1) * newXyzScale);
        this.writePositionComponent(index, "z", current.xyz(offset, 2) * newXyzScale);
        const normal = current.normal(offset);
        this.vertices[index] = { ...this.vertex(index), normal: vec3(normal.x, normal.y, normal.z) };
      }
    } else {
      const previous = source.vertexFrame(this.md3Entity().oldFrame), oldXyzScale = f((1 / 64) * backLerp);
      for (let offset = 0; offset < vertexCount; offset++) {
        const index = baseVertex + offset;
        this.writePositionComponent(index, "x", f(previous.xyz(offset, 0) * oldXyzScale) + f(current.xyz(offset, 0) * newXyzScale));
        this.writePositionComponent(index, "y", f(previous.xyz(offset, 1) * oldXyzScale) + f(current.xyz(offset, 1) * newXyzScale));
        this.writePositionComponent(index, "z", f(previous.xyz(offset, 2) * oldXyzScale) + f(current.xyz(offset, 2) * newXyzScale));
        const newNormal = current.normal(offset), oldNormal = previous.normal(offset);
        this.vertices[index] = { ...this.vertex(index), normal: vec3(
          f(oldNormal.x * backLerp) + f(newNormal.x * newNormalScale),
          f(oldNormal.y * backLerp) + f(newNormal.y * newNormalScale),
          f(oldNormal.z * backLerp) + f(newNormal.z * newNormalScale)) };
      }
      // VectorArrayNormalize runs only after every unnormalized vertex was published.
      for (let offset = 0; offset < (vertexCount >>> 0); offset++) {
        const index = baseVertex + offset, vertex = this.vertex(index);
        this.vertices[index] = { ...vertex, normal: normalizeFast3(vertex.normal) };
      }
    }

    const triangles = source.triangleIndices(), indexes = md3IndexCount(source.numTriangles), baseIndex = this.indexCount;
    for (let offset = 0; offset < indexes; offset++) {
      const index = baseIndex + offset, value = (baseVertex + triangles.at(offset)) >>> 0;
      if (!Number.isInteger(index) || index < 0 || index >= INDEXES) throw new RangeError("tess index slot outside scratch allocation");
      this.indexes[index] = value;
    }
    this.indexCount += indexes;
    const coordinates = source.textureCoordinates(), count = source.numVerts;
    for (let offset = 0; offset < count; offset++) {
      const index = baseVertex + offset, x = coordinates.at(offset * 2);
      this.vertices[index] = { ...this.vertex(index), texCoord: { ...this.vertex(index).texCoord, x: f(x) } };
      const y = coordinates.at(offset * 2 + 1);
      this.vertices[index] = { ...this.vertex(index), texCoord: { ...this.vertex(index).texCoord, y: f(y) } };
    }
    this.vertexCount += source.numVerts;
  }

  private md3Entity() {
    const selection = this.currentContext;
    const entity = selection.kind === "scene-cell" ? selection.cell.entity : selection.context.entity;
    if (entity === null) throw new Error("RB_SurfaceMesh: source backEnd.currentEntity is NULL before pose access");
    if (!("frame" in entity && "oldFrame" in entity))
      throw new Error(`RB_SurfaceMesh: detached ${entity.kind} entity does not represent the source pose cells`);
    return entity;
  }

  private writePositionComponent(index: number, component: "x" | "y" | "z", value: number): void {
    const vertex = this.vertex(index);
    this.vertices[index] = { ...vertex, position: { ...vertex.position, [component]: f(value) } };
  }

  /** RB_SurfaceAnim uses the submitted allocation's bones and the selected backend pose. */
  appendMd4(surface: RegisteredMd4Surface): void {
    const selection = this.currentContext;
    if (selection.kind === "initial-null") throw new Error("RB_SurfaceAnim: source backEnd.currentEntity is NULL before pose access");
    const entity = selection.kind === "scene-cell" ? selection.cell.entity : selection.context.entity;
    if (entity === null) throw new Error("RB_SurfaceAnim: source backEnd.currentEntity is NULL before pose access");
    if (!("frame" in entity && "oldFrame" in entity))
      throw new Error(`RB_SurfaceAnim: detached ${entity.kind} entity does not represent the source pose cells`);
    const oldFrame = entity.oldFrame, frame = entity.frame;
    // e.oldframe @96, e.frame @80 and conditional e.backlerp @100 precede header reads.
    let backLerp = 0;
    if (oldFrame !== frame) {
      if (!("backLerp" in entity)) throw new Error(`RB_SurfaceAnim: detached ${entity.kind} entity does not represent the source backlerp cell`);
      backLerp = f(entity.backLerp);
    }
    const pose = { frame, oldFrame, backLerp };
    const animation = surface.animationHeader();
    const vertexCount = surface.numVerts, indexes = surface.numIndexes;
    if (this.wouldOverflow(vertexCount, indexes)) throw new RangeError("tess append requires an End/Begin overflow boundary");
    const baseIndex = this.indexCount, baseVertex = this.vertexCount;
    let offset = 0;
    for (const index of surface.triangleIndices()) this.indexes[baseIndex + offset++] = baseIndex + index;
    this.indexCount += indexes;
    let vertexOffset = 0;
    for (const vertex of surface.animateVertices(pose, animation)) {
      const index = baseVertex + vertexOffset++;
      this.vertices[index] = { ...this.vertex(index), position: vec3(vertex.position.x, vertex.position.y, vertex.position.z),
        normal: vec3(vertex.normal.x, vertex.normal.y, vertex.normal.z), texCoord: vec2(vertex.texCoord.x, vertex.texCoord.y) };
    }
    this.vertexCount += vertexCount;
  }

  snapshotIndices(): readonly number[] { return this.indexes.slice(0, this.indexCount); }

  snapshotGeometry(): DeformGeometry {
    return { vertices: this.vertices.slice(0, this.vertexCount).map(copyVertex), indices: this.indexes.slice(0, this.indexCount) };
  }

  /** Publish indexed allocation reads without changing active generation counts. */
  snapshotIndexedGeometry(): DeformGeometry {
    const indices = this.indexes.slice(0, this.indexCount);
    let count = this.vertexCount;
    for (const index of indices) {
      this.vertex(index);
      count = Math.max(count, index + 1);
    }
    return { vertices: this.vertices.slice(0, count).map(copyVertex), indices };
  }

  /** Indexed source draws can read retained cells beyond numVertexes. */
  allocatedVertex(index: number): BspVertex { return copyVertex(this.vertex(index)); }

  allocatedPosition(index: number): Vec3 {
    const vertex = this.vertex(index);
    return vec3(vertex.position.x, vertex.position.y, vertex.position.z);
  }

  allocatedTexturedPosition(index: number): Pick<BspVertex, "position" | "texCoord" | "lightmapCoord"> {
    const vertex = this.vertex(index);
    return { position: vec3(vertex.position.x, vertex.position.y, vertex.position.z),
      texCoord: vec2(vertex.texCoord.x, vertex.texCoord.y), lightmapCoord: vec2(vertex.lightmapCoord.x, vertex.lightmapCoord.y) };
  }

  allocatedTextureCoordinates(index: number): Pick<BspVertex, "texCoord" | "lightmapCoord"> {
    const vertex = this.vertex(index);
    return { texCoord: vec2(vertex.texCoord.x, vertex.texCoord.y), lightmapCoord: vec2(vertex.lightmapCoord.x, vertex.lightmapCoord.y) };
  }

  /** DeformText reads these allocated slots even when numVertexes is below four. */
  textQuad(): readonly [BspVertex, BspVertex, BspVertex, BspVertex] {
    return [copyVertex(this.vertex(0)), copyVertex(this.vertex(1)), copyVertex(this.vertex(2)), copyVertex(this.vertex(3))];
  }

  /** Deformation writes active attributes back; inactive tail and svars survive. */
  replaceGeometry(mesh: DeformGeometry): void {
    if (mesh.vertices.length >= VERTICES || mesh.indices.length >= INDEXES) throw new RangeError("deformed tess geometry exceeds capacity");
    for (const index of mesh.indices) this.vertex(index);
    for (const [index, vertex] of mesh.vertices.entries()) this.vertices[index] = copyVertex(vertex);
    for (const [offset, index] of mesh.indices.entries()) this.indexes[offset] = index;
    this.vertexCount = mesh.vertices.length;
    this.indexCount = mesh.indices.length;
  }

  /** RB_ShadowTessEnd retains edge counts outside active vertex starts. */
  shadowGeometry(): StencilShadowGeometry { return this.shadowEdges.build(this); }

  /** RB_ShadowTessEnd writes only xyz in the inactive second half of tess. */
  writeShadowPositions(positions: readonly Vec3[]): void {
    if (this.vertexCount >= VERTICES / 2 || positions.length !== this.vertexCount * 2) throw new RangeError("Shadow extrusion does not match the active tess allocation");
    for (let index = this.vertexCount; index < positions.length; index++) {
      const position = positions[index];
      if (position === undefined) throw new RangeError("Shadow extrusion position is missing");
      this.vertices[index] = { ...this.vertex(index), position: vec3(position.x, position.y, position.z) };
    }
  }

  private vertex(index: number): BspVertex {
    const vertex = this.vertices[index];
    if (vertex === undefined || !Number.isInteger(index)) throw new RangeError("tess vertex slot outside scratch allocation");
    return vertex;
  }

  stageColor(index: number): Vec4 {
    const color = this.colors[index];
    if (color === undefined || !Number.isInteger(index)) throw new RangeError("tess stage color slot outside scratch allocation");
    return { x: color.x / 255, y: color.y / 255, z: color.z / 255, w: color.w / 255 };
  }

  writeStageColor(index: number, color: Vec4): void {
    this.vertex(index);
    // Stage evaluators return normalized byte values; round reverses normalization.
    this.colors[index] = { x: Math.round(color.x * 255) & 255, y: Math.round(color.y * 255) & 255, z: Math.round(color.z * 255) & 255, w: Math.round(color.w * 255) & 255 };
  }

  stageTexCoord(bundle: 0 | 1, index: number): Vec2 {
    const uv = this.coordinates[bundle][index];
    if (uv === undefined || !Number.isInteger(index)) throw new RangeError("tess stage texture slot outside scratch allocation");
    return { ...uv };
  }

  writeStageTexCoord(bundle: 0 | 1, index: number, uv: Vec2): void {
    this.vertex(index);
    this.coordinates[bundle][index] = vec2(uv.x, uv.y);
  }

  enterView(view: TessViewContext, floatTime: number, refdef: Pick<Refdef, "text" | "time">): void {
    this.refdefText = copyRenderText(refdef.text);
    this.refdefMilliseconds = refdef.time | 0;
    this.currentView = { origin: { ...view.origin }, axis: copyAxis(view.axis), mirror: view.mirror };
    this.refdefFloatTime = f(floatTime);
  }

  setEntity(context: TessEntityContext): void {
    if (context.kind === "world" && context.entity === null) {
      this.currentContext = { kind: "global", context: { ...copyContext(context), entity: this.worldEntity } };
      return;
    }
    this.currentContext = { kind: "detached", context: copyContext(context) };
  }
  selectWorldEntity(orientation: TessOrientation): void {
    this.currentContext = { kind: "global", context: { kind: "world", entity: this.worldEntity,
      lighting: this.worldLighting, ...copyOrientation(orientation) } };
  }
  selectSceneEntity(cell: SourceSceneEntity, orientation: TessOrientation): void {
    this.currentContext = { kind: "scene-cell", cell, orientation: copyOrientation(orientation) };
  }
  setFloatTime(time: number): void { this.refdefFloatTime = f(time); }
  setShaderTime(time: number): void { this.currentShaderTime = f(time); }

  /** RB_SwapBuffers, unlike a mid-frame command issue, leaves 2D mode. */
  endFrame(): void { this.projection2D = false; }

  /** RB_BeginDrawingView leaves 2D mode without changing retained color or scratch. */
  beginDrawingView(): void { this.projection2D = false; }

  /** Raw draws call this unconditionally; ordinary stretches guard at the caller. */
  setGL2D(milliseconds: number): void {
    this.projection2D = true;
    this.refdefMilliseconds = milliseconds | 0;
    this.refdefFloatTime = rendererFloatTime(milliseconds);
    this.actualCull = "none";
  }

  /** Shader switches select entity2D but do not run R_RotateForEntity. */
  selectEntity2D(): void {
    this.currentContext = { kind: "global", context: { ...this.context, kind: "2d", entity: this.entity2D,
      lighting: this.entity2DLighting } };
  }

  /** Raw shadow cull calls change physical state without changing GL_Cull's key. */
  setActualCull(type: RenderState["cull"]): void { this.actualCull = type; }

  /** qglDepthRange is physical retained state, not RB_RenderDrawSurfList's RF cache. */
  setDepthRange(range: readonly [number, number]): void {
    if (!range.every(Number.isFinite)) throw new RangeError("Tess depth range must be finite");
    this.currentDepthRange = [range[0], range[1]];
  }

  /** A retained shadow tessellation is replayed under the current GL matrices. */
  setProjector(project: (position: Vec3) => Vec4): void { this.positionProjector = project; }

  get projector(): (position: Vec3) => Vec4 { return this.positionProjector; }

  projectPosition(position: Vec3): Vec4 {
    const result = this.positionProjector(vec3(position.x, position.y, position.z));
    return vec4(result.x, result.y, result.z, result.w);
  }

  /** GL_Cull's cached type and actual enable/face state are distinct. */
  invalidateCull(): void { this.cachedCull = null; }

  cullState(type: RenderState["cull"]): RenderState["cull"] {
    if (this.cachedCull === type) return this.actualCull;
    this.cachedCull = type;
    this.actualCull = !this.currentView.mirror || type === "none" ? type : type === "front" ? "back" : "front";
    return this.actualCull;
  }
}
