// Owned backEndData_t publication across the source render-thread boundary.
// Source: id Software renderer/tr_local.h, tr_scene.c and tr_backend.c.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { BspVertex } from "../assets/bsp.ts";
import type { Axis, Vec2, Vec3, Vec4 } from "../core/math.ts";
import { sourceBackendByteLength, SourceBackendMemory } from "./backend-memory.ts";
import type { SourceBackendSnapshot } from "./backend-memory.ts";
import type { FogVolume } from "./fog.ts";
import { captureMd3Surface, parseMd3SurfaceTransfer, restoreMd3Surface } from "./md3-resource.ts";
import type { Md3SurfaceTransfer } from "./md3-resource.ts";
import { captureMd4Surface, parseMd4SurfaceTransfer, restoreMd4Surface } from "./md4-resource.ts";
import type { Md4SurfaceTransfer } from "./md4-resource.ts";
import type { PatchGrid } from "./patch-lod.ts";
import type { RendererResourceReceiver, RendererResourceSender } from "./renderer-resource-transport.ts";
import { SourceSceneEntities } from "./scene-entities.ts";
import type { SourceSceneEntityRangeState, SourceSceneEntityState } from "./scene-entities.ts";
import { SourceSceneSubmissionMemory } from "./scene-submission-memory.ts";
import { retainSourceSceneCaptureAllocation, sourceSceneCaptureAllocation } from "./scene-submission.ts";
import type { SourceSceneCapture } from "./scene-submission.ts";
import type { SurfaceGeometry, SurfacePortalPlane, WorldBackendSurface, WorldBackendWorld } from "./world-backend.ts";

export interface FrameBackendSnapshot { readonly id: number; readonly allocation: SourceBackendSnapshot }
export interface FrameSceneSnapshot {
  readonly backend: FrameBackendSnapshot;
  /** Diagnostic submissions can own a separate polygon allocation. Source frames share one. */
  readonly entityBackend: FrameBackendSnapshot | null;
  readonly entityState: SourceSceneEntityState;
  readonly entityRange: SourceSceneEntityRangeState;
  readonly firstPoly: number;
  readonly polyCount: number;
  readonly firstLight: number;
  readonly lightCount: number;
  readonly numPolys: number;
  readonly numLights: number;
  readonly polyVertices: number;
}

interface SurfaceFields {
  readonly material: number;
  readonly fog: number;
  readonly entityOrder: number;
  readonly dlighted?: boolean | number;
}
export type WorldSurfaceTransfer = SurfaceFields & (
  | { readonly kind: "surface"; readonly mesh: SurfaceGeometry; readonly plane: SurfacePortalPlane;
      readonly grid: PatchGrid | null; readonly writer: "bsp-normal" | "poly";
      readonly lighting: Extract<WorldBackendSurface, { readonly kind: "surface" }>["lighting"];
      readonly worldSurface?: number; readonly dlightBeforeOverflow?: boolean }
  | { readonly kind: "md3"; readonly surface: Md3SurfaceTransfer }
  | { readonly kind: "md4"; readonly surface: Md4SurfaceTransfer }
  | { readonly kind: "entity" | "flare" | "skip" });
export interface WorldTransfer { readonly fogs: readonly FogVolume[]; readonly fogTexture: number | null }
export type WorldResourceRegistration =
  | { readonly kind: "surface"; readonly id: number; readonly value: WorldSurfaceTransfer }
  | { readonly kind: "world"; readonly id: number; readonly value: WorldTransfer }
  | { readonly kind: "remove-surface"; readonly id: number };
export interface WorldResourceJournal { readonly start: number; readonly entries: readonly WorldResourceRegistration[] }

function copyVertex(vertex: BspVertex): BspVertex {
  return { position: { ...vertex.position }, normal: { ...vertex.normal }, texCoord: { ...vertex.texCoord },
    lightmapCoord: { ...vertex.lightmapCoord }, color: { ...vertex.color } };
}
function copyMesh(mesh: SurfaceGeometry): SurfaceGeometry {
  return { vertices: Array.from(mesh.vertices, copyVertex), indices: Array.from(mesh.indices) };
}
function copyGrid(grid: PatchGrid | null): PatchGrid | null {
  if (grid === null) return null;
  const mesh = grid.mesh;
  return { lodOrigin: { ...grid.lodOrigin }, lodRadius: grid.lodRadius, mesh: { ...copyMesh(mesh),
    width: mesh.width, height: mesh.height, widthLodError: Array.from(mesh.widthLodError), heightLodError: Array.from(mesh.heightLodError) } };
}
function countRange(first: number, count: number, capacity: number, label: string): void {
  if (!Number.isInteger(first) || first < 0 || !Number.isInteger(count) || count < 0 || first + count > capacity)
    throw new RangeError(`Scene snapshot ${label} range exceeds its allocation`);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function record(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError("Scene transport requires a record");
  return input;
}
function number(input: unknown): number {
  if (typeof input !== "number") throw new TypeError("Scene transport requires a number");
  return input;
}
function integer(input: unknown): number {
  const value = number(input);
  if (!Number.isSafeInteger(value)) throw new TypeError("Scene transport requires a safe integer");
  return value;
}
function isUnknownArray(input: unknown): input is readonly unknown[] { return Array.isArray(input); }
function array(input: unknown): readonly unknown[] {
  if (!isUnknownArray(input)) throw new TypeError("Scene transport requires an array");
  return input;
}
function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") throw new TypeError("Scene transport requires a boolean");
  return input;
}
function vector2(input: unknown): Vec2 {
  const value = record(input); return { x: number(value["x"]), y: number(value["y"]) };
}
function vector3(input: unknown): Vec3 {
  const value = record(input); return { ...vector2(value), z: number(value["z"]) };
}
function vector4(input: unknown): Vec4 {
  const value = record(input); return { ...vector3(value), w: number(value["w"]) };
}
function parseBackendSnapshot(input: unknown): FrameBackendSnapshot {
  const value = record(input), allocation = record(value["allocation"]), limits = record(allocation["limits"]), bytes = allocation["bytes"];
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Scene transport allocation requires bytes");
  const result = { id: integer(value["id"]), allocation: { originalByteOffset: integer(allocation["originalByteOffset"]), bytes,
    limits: { maxPolys: integer(limits["maxPolys"]), maxPolyVertices: integer(limits["maxPolyVertices"]) } } };
  validateBackend(result);
  return result;
}

function validateBackend(snapshot: FrameBackendSnapshot): void {
  const allocation = snapshot.allocation, offset = allocation.originalByteOffset;
  if (!Number.isSafeInteger(snapshot.id) || snapshot.id < 1) throw new RangeError("Scene backend identity must be positive");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 4 !== 0 || offset + allocation.bytes.length > 0x100000000)
    throw new RangeError("Scene snapshot has an invalid release32 pointer base");
  if (allocation.bytes.length !== sourceBackendByteLength(allocation.limits)) throw new RangeError("Scene snapshot allocation has the wrong byte length");
}

function validateScene(snapshot: FrameSceneSnapshot): void {
  validateBackend(snapshot.backend);
  if (snapshot.entityBackend !== null) validateBackend(snapshot.entityBackend);
  const state = snapshot.entityState;
  if (!Number.isSafeInteger(state.generation) || state.generation < 0) throw new RangeError("Scene entity generation is invalid");
  countRange(0, state.count, 1022, "entity counters");
  countRange(0, state.firstSceneEntity, state.count, "entity counters");
  countRange(snapshot.entityRange.first, snapshot.entityRange.count, state.count, "entity");
  const limits = snapshot.backend.allocation.limits;
  countRange(0, snapshot.numPolys, limits.maxPolys, "polygon count");
  countRange(0, snapshot.numLights, 32, "light count");
  countRange(0, snapshot.polyVertices, limits.maxPolyVertices, "vertex count");
  countRange(snapshot.firstPoly, snapshot.polyCount, snapshot.numPolys, "polygon");
  countRange(snapshot.firstLight, snapshot.lightCount, snapshot.numLights, "light");
}

export function parseFrameSceneSnapshot(input: unknown): FrameSceneSnapshot {
  const value = record(input), state = record(value["entityState"]), range = record(value["entityRange"]);
  const result: FrameSceneSnapshot = { backend: parseBackendSnapshot(value["backend"]),
    entityBackend: value["entityBackend"] === null ? null : parseBackendSnapshot(value["entityBackend"]),
    entityState: { generation: integer(state["generation"]), count: integer(state["count"]), firstSceneEntity: integer(state["firstSceneEntity"]) },
    entityRange: { first: integer(range["first"]), count: integer(range["count"]) },
    firstPoly: integer(value["firstPoly"]), polyCount: integer(value["polyCount"]),
    firstLight: integer(value["firstLight"]), lightCount: integer(value["lightCount"]),
    numPolys: integer(value["numPolys"]), numLights: integer(value["numLights"]), polyVertices: integer(value["polyVertices"]) };
  validateScene(result);
  return result;
}

export function parseFrameBackendSnapshots(input: unknown): readonly FrameBackendSnapshot[] {
  return array(input).map(parseBackendSnapshot);
}

function parsePlane(input: unknown): import("../core/math.ts").Plane {
  const value = record(input); return { normal: vector3(value["normal"]), distance: number(value["distance"]) };
}
function parseMesh(input: unknown): SurfaceGeometry {
  const value = record(input);
  return { indices: array(value["indices"]).map(integer), vertices: array(value["vertices"]).map(input => {
    const vertex = record(input);
    return { position: vector3(vertex["position"]), normal: vector3(vertex["normal"]),
      texCoord: vector2(vertex["texCoord"]), lightmapCoord: vector2(vertex["lightmapCoord"]), color: vector4(vertex["color"]) };
  }) };
}
function parseGrid(input: unknown): PatchGrid | null {
  if (input === null) return null;
  const value = record(input), mesh = record(value["mesh"]);
  return { lodOrigin: vector3(value["lodOrigin"]), lodRadius: number(value["lodRadius"]),
    mesh: { ...parseMesh(mesh), width: integer(mesh["width"]), height: integer(mesh["height"]),
      widthLodError: array(mesh["widthLodError"]).map(number), heightLodError: array(mesh["heightLodError"]).map(number) } };
}
function parseLighting(input: unknown): Extract<WorldBackendSurface, { readonly kind: "surface" }>["lighting"] {
  if (input === null) return null;
  const value = record(input);
  return { ambientLight: vector3(value["ambientLight"]), directedLight: vector3(value["directedLight"]),
    lightDir: vector3(value["lightDir"]), ambientLightInt: integer(value["ambientLightInt"]) };
}

function parseSurface(input: unknown): WorldSurfaceTransfer {
  const value = record(input), kind = value["kind"], dlighted = value["dlighted"];
  const common: SurfaceFields = { material: integer(value["material"]), fog: integer(value["fog"]),
    entityOrder: integer(value["entityOrder"]), ...(dlighted === undefined ? {} : {
      dlighted: typeof dlighted === "boolean" ? dlighted : number(dlighted) }) };
  switch (kind) {
    case "surface": {
      const plane = record(value["plane"]), writer = value["writer"], worldSurface = value["worldSurface"], overflow = value["dlightBeforeOverflow"];
      if (writer !== "bsp-normal" && writer !== "poly") throw new TypeError("Scene transport has an invalid surface writer");
      if (plane["kind"] !== "triangle" && plane["kind"] !== "fixed") throw new TypeError("Scene transport has an invalid portal plane");
      return { ...common, kind, mesh: parseMesh(value["mesh"]), grid: parseGrid(value["grid"]), writer,
        plane: plane["kind"] === "triangle" ? { kind: "triangle" } : { kind: "fixed", plane: parsePlane(plane["plane"]) },
        lighting: parseLighting(value["lighting"]), ...(worldSurface === undefined ? {} : { worldSurface: integer(worldSurface) }),
        ...(overflow === undefined ? {} : { dlightBeforeOverflow: boolean(overflow) }) };
    }
    case "md3": return { ...common, kind, surface: parseMd3SurfaceTransfer(value["surface"]) };
    case "md4": return { ...common, kind, surface: parseMd4SurfaceTransfer(value["surface"]) };
    case "entity": case "flare": case "skip": return { ...common, kind };
    default: throw new TypeError("Scene transport has an invalid surface kind");
  }
}
function parseWorld(input: unknown): WorldTransfer {
  const value = record(input);
  return { fogTexture: value["fogTexture"] === null ? null : integer(value["fogTexture"]),
    fogs: array(value["fogs"]).map(input => {
      const fog = record(input), bounds = record(fog["bounds"]);
      return { bounds: { min: vector3(bounds["min"]), max: vector3(bounds["max"]) }, color: vector4(fog["color"]),
        tcScale: number(fog["tcScale"]), surface: fog["surface"] === null ? null : parsePlane(fog["surface"]) };
    }) };
}

export function parseWorldResourceJournal(input: unknown): WorldResourceJournal {
  const value = record(input);
  return { start: integer(value["start"]), entries: array(value["entries"]).map(input => {
    const entry = record(input), kind = entry["kind"], id = integer(entry["id"]);
    if (kind === "world") return { kind, id, value: parseWorld(entry["value"]) };
    if (kind === "surface") return { kind, id, value: parseSurface(entry["value"]) };
    if (kind === "remove-surface") return { kind, id };
    throw new TypeError("Scene transport has an invalid resource registration");
  }) };
}

export class SceneTransportSender {
  readonly #backendIds = new WeakMap<SourceBackendMemory, number>();
  readonly #backends = new Map<number, SourceBackendMemory>();
  readonly #surfaceIds = new WeakMap<object, Map<string, number>>();
  readonly #sharedSurfaceIds = new Map<string, number>();
  readonly #worldIds = new WeakMap<WorldBackendWorld, number>();
  readonly #lightmapOwners = new WeakMap<object, number>();
  readonly #journal: WorldResourceRegistration[] = [];
  readonly #transient = new Set<number>();
  #cursor = 0;
  #nextResource = 1;

  constructor(private readonly resources: Pick<RendererResourceSender, "materialHandle" | "sourceImageHandle" | "registerLightmapOwner">) {}

  private registerMaterialOwners(material: WorldBackendSurface["material"]): void {
    const visited = new Set<WorldBackendSurface["material"]>();
    let selected: WorldBackendSurface["material"] | null = material;
    while (selected !== null && !visited.has(selected)) {
      visited.add(selected);
      const lighting = selected.lighting;
      if (lighting.kind === "lightmap" && !this.#lightmapOwners.has(lighting.owner)) {
        const id = this.#nextResource++;
        this.resources.registerLightmapOwner(lighting.owner, id);
        this.#lightmapOwners.set(lighting.owner, id);
      }
      selected = selected.remapped;
    }
  }

  private backend(memory: SourceBackendMemory): FrameBackendSnapshot {
    let id = this.#backendIds.get(memory);
    if (id === undefined) {
      id = this.#backends.size + 1;
      this.#backendIds.set(memory, id);
      this.#backends.set(id, memory);
    }
    return { id, allocation: memory.snapshot() };
  }

  scene(capture: SourceSceneCapture): FrameSceneSnapshot {
    const allocation = sourceSceneCaptureAllocation(capture), entityMemory = allocation.entities.backendMemory;
    if (capture.polys.some(poly => typeof poly.shader !== "number"))
      throw new Error("Scene transport requires registered source polygon shader handles");
    return { backend: this.backend(allocation.memory.backend),
      entityBackend: entityMemory === allocation.memory.backend ? null : this.backend(entityMemory),
      entityState: allocation.entities.snapshotState(), entityRange: allocation.entities.rangeState(capture.entities),
      firstPoly: allocation.firstPoly, polyCount: capture.polys.length,
      firstLight: allocation.firstLight, lightCount: capture.dynamicLights.length,
      numPolys: allocation.numPolys, numLights: allocation.numLights, polyVertices: allocation.polyVertices };
  }

  /** The scheduler calls this only after the corresponding worker issue completes. */
  applyUpdates(updates: readonly FrameBackendSnapshot[]): void {
    for (const update of updates) {
      const memory = this.#backends.get(update.id);
      if (memory === undefined) throw new RangeError(`Unregistered source backend allocation ${update.id}`);
      memory.restoreSnapshot(update.allocation);
    }
  }

  surface(surface: WorldBackendSurface): number {
    this.registerMaterialOwners(surface.material);
    const material = this.resources.materialHandle(surface.material);
    const payload = surface.kind === "surface" ? surface.grid ?? surface.mesh
      : surface.kind === "md3" || surface.kind === "md4" ? surface.surface : null;
    const transient = surface.kind === "surface" && surface.writer === "poly";
    const plane = surface.kind === "surface" && surface.plane.kind === "fixed" ? surface.plane.plane : null;
    const key = surface.kind === "surface" ? `${surface.kind}/${surface.writer}/${surface.worldSurface}/${surface.dlightBeforeOverflow}/${plane === null
      ? "triangle" : `${plane.normal.x}/${plane.normal.y}/${plane.normal.z}/${plane.distance}`}` : surface.kind;
    let ids = payload === null ? this.#sharedSurfaceIds : this.#surfaceIds.get(payload);
    if (ids === undefined) { ids = new Map<string, number>(); if (payload !== null) this.#surfaceIds.set(payload, ids); }
    const cached = transient ? undefined : ids.get(key);
    if (cached !== undefined) return cached;
    const id = this.#nextResource++;
    const common: SurfaceFields = { material, fog: surface.fog,
      entityOrder: surface.entityOrder, ...(surface.dlighted === undefined ? {} : { dlighted: surface.dlighted }) };
    let value: WorldSurfaceTransfer;
    switch (surface.kind) {
      case "surface": value = { ...common, kind: surface.kind, mesh: copyMesh(surface.mesh), grid: copyGrid(surface.grid),
        plane: surface.plane.kind === "triangle" ? { kind: "triangle" } : { kind: "fixed", plane: {
          normal: { ...surface.plane.plane.normal }, distance: surface.plane.plane.distance } }, writer: surface.writer,
        lighting: surface.lighting === null ? null : { lightDir: { ...surface.lighting.lightDir },
          ambientLight: { ...surface.lighting.ambientLight }, directedLight: { ...surface.lighting.directedLight },
          ambientLightInt: surface.lighting.ambientLightInt },
        ...(surface.worldSurface === undefined ? {} : { worldSurface: surface.worldSurface }),
        ...(surface.dlightBeforeOverflow === undefined ? {} : { dlightBeforeOverflow: surface.dlightBeforeOverflow }) }; break;
      case "md3": value = { ...common, kind: surface.kind, surface: captureMd3Surface(surface.surface) }; break;
      case "md4": value = { ...common, kind: surface.kind, surface: captureMd4Surface(surface.surface) }; break;
      case "entity": case "flare": case "skip": value = { ...common, kind: surface.kind }; break;
    }
    if (transient) this.#transient.add(id);
    else ids.set(key, id);
    this.#journal.push({ kind: "surface", id, value });
    return id;
  }

  world(world: WorldBackendWorld): number {
    const cached = this.#worldIds.get(world);
    if (cached !== undefined) return cached;
    const id = this.#nextResource++;
    const value: WorldTransfer = { fogTexture: world.fogTexture === null ? null : this.resources.sourceImageHandle(world.fogTexture),
      fogs: world.fogs.map(fog => ({ bounds: { min: { ...fog.bounds.min }, max: { ...fog.bounds.max } },
        color: { ...fog.color }, tcScale: fog.tcScale,
        surface: fog.surface === null ? null : { normal: { ...fog.surface.normal }, distance: fog.surface.distance } })) };
    this.#worldIds.set(world, id);
    this.#journal.push({ kind: "world", id, value });
    return id;
  }

  takeJournal(): WorldResourceJournal {
    const result = { start: this.#cursor, entries: this.#journal.slice() };
    this.#cursor += result.entries.length;
    this.#journal.length = 0;
    for (const id of this.#transient) this.#journal.push({ kind: "remove-surface", id });
    this.#transient.clear();
    return result;
  }
}

export class SceneTransportReceiver {
  readonly #backends = new Map<number, SourceBackendMemory>();
  readonly #entities = new Map<number, SourceSceneEntities>();
  readonly #surfaces = new Map<number, WorldBackendSurface>();
  readonly #worlds = new Map<number, WorldBackendWorld>();
  readonly #lightmapOwners = new Map<number, object>();
  readonly #updated = new Set<number>();
  #issueBackends: ReadonlySet<number> | null = null;
  #cursor = 0;

  constructor(private readonly resources: Pick<RendererResourceReceiver, "resolveImage" | "resolveMaterial">,
    private readonly print: (text: string) => undefined = () => undefined) {}

  lightmapOwner(id: number): object {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("World lightmap owner identity must be positive");
    let owner = this.#lightmapOwners.get(id);
    if (owner === undefined) { owner = {}; this.#lightmapOwners.set(id, owner); }
    return owner;
  }

  private backend(snapshot: FrameBackendSnapshot): SourceBackendMemory {
    if (!Number.isSafeInteger(snapshot.id) || snapshot.id < 1) throw new RangeError("Scene backend identity must be positive");
    const prior = this.#backends.get(snapshot.id);
    if (prior !== undefined) {
      if (this.#issueBackends === null) prior.restoreSnapshot(snapshot.allocation);
      else if (!this.#issueBackends.has(snapshot.id)) throw new Error("Scene allocation was not installed for this issue");
      this.#updated.add(snapshot.id);
      return prior;
    }
    if (this.#issueBackends !== null) throw new Error("Scene allocation was not installed for this issue");
    const memory = SourceBackendMemory.fromSnapshot(snapshot.allocation);
    this.#backends.set(snapshot.id, memory);
    this.#updated.add(snapshot.id);
    return memory;
  }

  /** Source commands borrow the final frontend allocation throughout an issue. */
  beginIssue(scenes: readonly FrameSceneSnapshot[]): void {
    if (this.#issueBackends !== null) throw new Error("A scene issue is already active");
    for (const scene of scenes) validateScene(scene);
    const finalSnapshots = new Map<number, FrameBackendSnapshot>();
    for (const scene of scenes) {
      finalSnapshots.set(scene.backend.id, scene.backend);
      if (scene.entityBackend !== null) finalSnapshots.set(scene.entityBackend.id, scene.entityBackend);
    }
    this.#updated.clear();
    for (const snapshot of finalSnapshots.values()) this.backend(snapshot);
    this.#issueBackends = new Set(finalSnapshots.keys());
  }

  endIssue(): void { this.#issueBackends = null; }

  scene(snapshot: FrameSceneSnapshot): SourceSceneCapture {
    validateScene(snapshot);
    const backend = this.backend(snapshot.backend);
    const entitySnapshot = snapshot.entityBackend ?? snapshot.backend;
    const entityBackend = snapshot.entityBackend === null ? backend : this.backend(entitySnapshot);
    let entities = this.#entities.get(entitySnapshot.id);
    if (entities === undefined) { entities = new SourceSceneEntities(entityBackend); this.#entities.set(entitySnapshot.id, entities); }
    entities.restoreState(snapshot.entityState);
    const range = entities.restoreRange(snapshot.entityRange), memory = new SourceSceneSubmissionMemory(backend);
    const capture: SourceSceneCapture = {
      entities: range,
      polys: Array.from({ length: snapshot.polyCount }, (_, index) => memory.poly(snapshot.firstPoly + index)),
      dynamicLights: Array.from({ length: snapshot.lightCount }, (_, index) => memory.light(snapshot.firstLight + index)),
      transformDlights(origin: Vec3, axis: Axis) {
        for (let index = 0; index < snapshot.lightCount; index++) memory.transformLight(snapshot.firstLight + index, origin, axis);
        return Array.from({ length: snapshot.lightCount }, (_, index) => memory.light(snapshot.firstLight + index, true));
      },
    };
    retainSourceSceneCaptureAllocation(capture, { entities, memory, firstPoly: snapshot.firstPoly, firstLight: snapshot.firstLight,
      numPolys: snapshot.numPolys, numLights: snapshot.numLights, polyVertices: snapshot.polyVertices });
    return capture;
  }

  captureUpdates(): readonly FrameBackendSnapshot[] {
    const updates = Array.from(this.#updated, id => {
      const memory = this.#backends.get(id);
      if (memory === undefined) throw new Error("Updated backend allocation is missing");
      return { id, allocation: memory.snapshot() };
    });
    this.#updated.clear();
    return updates;
  }

  applyJournal(journal: WorldResourceJournal): void {
    if (journal.start !== this.#cursor) throw new Error("World resource journal is out of order");
    for (const entry of journal.entries) {
      if (entry.kind === "remove-surface") {
        this.#surfaces.delete(entry.id);
      } else if (entry.kind === "world") {
        this.#worlds.set(entry.id, { fogs: structuredClone(entry.value.fogs),
          fogTexture: entry.value.fogTexture === null ? null : this.resources.resolveImage(entry.value.fogTexture) });
      } else {
        const value = entry.value, common = { ...value, material: this.resources.resolveMaterial(value.material), entity: null };
        let surface: WorldBackendSurface;
        switch (value.kind) {
          case "surface": surface = { ...common, ...value, material: common.material, kind: value.kind,
            mesh: copyMesh(value.mesh), grid: copyGrid(value.grid), plane: structuredClone(value.plane), lighting: structuredClone(value.lighting) }; break;
          case "md3": surface = { ...common, kind: value.kind, surface: restoreMd3Surface(value.surface) }; break;
          case "md4": surface = { ...common, kind: value.kind, surface: restoreMd4Surface(value.surface, {
            shaderForHandle: handle => this.resources.resolveMaterial(handle), print: this.print }) }; break;
          case "entity": case "flare": case "skip": surface = { ...common, kind: value.kind }; break;
        }
        this.#surfaces.set(entry.id, surface);
      }
      this.#cursor++;
    }
  }

  surface(id: number): WorldBackendSurface {
    const value = this.#surfaces.get(id);
    if (value === undefined) throw new RangeError(`Unregistered worker world surface ${id}`);
    return value;
  }

  world(id: number): WorldBackendWorld {
    const value = this.#worlds.get(id);
    if (value === undefined) throw new RangeError(`Unregistered worker world ${id}`);
    return value;
  }
}
