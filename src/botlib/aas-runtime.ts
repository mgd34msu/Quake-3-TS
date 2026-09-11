/*
 * AAS lifecycle translated from id Software's botlib/be_aas_main.c,
 * be_aas_file.c, be_aas_sample.c, be_aas_reach.c, be_aas_cluster.c
 * and be_aas_route.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BspMap } from "../assets/bsp.ts";
import type { VirtualFileSystem } from "../assets/vfs.ts";
import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { vec3 } from "../core/math.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { parseAas } from "./aas.ts";
import type { AasFace, AasPlane, AasWorld } from "./aas.ts";
import { AasHideRouting, aasNextModelReachability } from "./aas-route-queries.ts";
import { AasStringIndexes } from "./aas-string-indexes.ts";
import { aasAreaGroundFace, aasFacePlane, aasTraceEndFace, aasPlaneFromNum } from "./aas-sample-queries.ts";
import { AasClustering } from "./aas-cluster.ts";
import { printAasFileInfo, writeAasFile } from "./aas-file.ts";
import type { AasFileWriteHost } from "./aas-file.ts";
import { AasMovement, AasMovementSettings, initAasMovementSettings } from "./aas-movement.ts";
import type { AasClientMoveOutput, AasMovementDebug, AasMovementPrediction, AasMovementQueries, AasPredictionRequest } from "./aas-movement.ts";
import { AasLinkHeap } from "./aas-links.ts";
import { aasOptimize } from "./aas-optimize.ts";
import { AasReachabilityGenerator } from "./aas-reachability.ts";
import type { AasReachabilityDebugState } from "./aas-reachability.ts";
import { writeEmptyRouteCache } from "./aas-route-cache.ts";
import type { AasRouteCacheWriteHost } from "./aas-route-cache.ts";
import { AasWorldState } from "./aas-world.ts";
import { AasBspEntities } from "./bsp-entities.ts";
import { AasEntityHistory } from "./entity.ts";
import type { AasEntityHost, AasEntityInfo, AasEntityMap, BotEntityUpdate } from "./entity.ts";
import type { BotLibVar, BotLibVars } from "./libvars.ts";
import { BotMemory } from "./memory.ts";
import { AasRouting, initializeAasRoutePrediction, RouteStopEvent, TravelFlags } from "./routing.ts";
import type { AasRoutePredictionOutput, AlternativeGoal, AlternativeRouteQuery, AlternativeRoutingLog,
  AreaTravelTimeQuery, PredictRouteQuery, AasRoutingDebug, AasAlternativeRouteDebug } from "./routing.ts";
import { AasSpatial, BotBrushModelTypes, presenceTypeBounds } from "./spatial.ts";
import type { AasAreaCrossing, AasSpatialHost, AasTrace, AasGoalPosition } from "./spatial.ts";

export interface AasAreaInfo {
  readonly contents: number;
  readonly flags: number;
  readonly presenceType: number;
  readonly cluster: number;
  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly center: Vec3;
}

export interface AasRuntimeOptions {
  readonly routingDebug?: AasRoutingDebug;
  readonly alternativeRouteDebug?: AasAlternativeRouteDebug;
  readonly fileDebug?: boolean;
  readonly sampleDebug?: boolean;
  readonly reachabilityDebugState?: AasReachabilityDebugState;
  readonly memory?: BotMemory;
  readonly variables: BotLibVars;
  readonly print: (severity: 1 | 2 | 3 | 4 | 5, text: string) => undefined;
  readonly commonPrint: (text: string) => undefined;
  readonly log: AlternativeRoutingLog;
  readonly developer: () => boolean;
  readonly milliseconds: () => number;
  readonly openWrite: AasFileWriteHost["openWrite"];
  readonly permanentLine: (start: Vec3, end: Vec3, color: number) => undefined;
  readonly movementDebug: Extract<AasMovementDebug, { readonly kind: "enabled" }>;
}

export type AasMapSpatialHost = Omit<AasSpatialHost, "entityModelIndex">;

export interface AasMapInput {
  readonly name: string | null;
  readonly bsp: Pick<BspMap, "entities">;
  readonly spatialHost: AasMapSpatialHost;
  readonly assets: Pick<VirtualFileSystem, "readSync" | "openRead" | "readInto" | "seekFile" | "closeFile">;
}

export interface AasRuntimeMap {
  readonly name: string;
  readonly filename: string;
  readonly bspEntities: AasBspEntities;
  readonly world: AasWorld;
  readonly spatial: AasSpatial;
  readonly routing: AasRouting;
}

export type AasInitialization = { readonly kind: "pending" };

export type AasRuntimePhase = { readonly kind: "unloaded" }
  | { readonly kind: "data-loaded"; readonly name: string; readonly world: AasWorldState }
  | { readonly kind: "loaded"; readonly map: AasRuntimeMap; readonly initialization: AasInitialization }
  | { readonly kind: "ready"; readonly map: AasRuntimeMap };

interface OwnedAasMap extends AasRuntimeMap {
  readonly world: AasWorldState;
  readonly assets: AasMapInput["assets"];
  readonly reachability: AasReachabilityGenerator;
  readonly clustering: AasClustering;
}

type AasReadResult = { readonly kind: "loaded"; readonly world: AasWorld; readonly close: () => void }
  | { readonly kind: "failed"; readonly error: 4 | 5 | 6 | 7 };

function sourceInteger(value: number, operation: string): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647) {
    throw new RangeError(`${operation}: source float-to-int conversion is undefined`);
  }
  return integer;
}

function mapName(value: string): string {
  const terminator = value.indexOf("\0");
  const name = terminator < 0 ? value : value.slice(0, terminator);
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) > 255) throw new RangeError("AAS_LoadFiles requires a byte-valued map name");
  }
  if (name.length >= 64) throw new RangeError("AAS_LoadFiles: map name exceeds the source MAX_PATH allocation");
  return name;
}

/** AAS_Setup owns history; AAS_LoadMap replaces only map allocations and links. */
export class AasRuntime implements AasEntityHost {
  readonly bspEntities: AasBspEntities;
  readonly stringIndexes: AasStringIndexes;
  private readonly hideRouting: AasHideRouting;
  readonly brushModelTypes = new BotBrushModelTypes();
  readonly linkHeap: AasLinkHeap;
  private readonly movementSettings = new AasMovementSettings();
  private history: AasEntityHistory | null = null;
  private currentPhase: AasRuntimePhase = { kind: "unloaded" };
  private currentInitialized = false;
  private ownedMap: OwnedAasMap | null = null;
  private currentSpatialHost: AasMapSpatialHost | null = null;
  private currentTime = 0;
  private currentFrame = 0;
  private currentMapName = "";
  private currentFilename = "";
  private clientCapacity = 0;
  private entityCapacity = 0;
  private saveRoutingCache: BotLibVar | null = null;

  constructor(private readonly options: AasRuntimeOptions, initialization: "setup" | "unallocated" = "setup") {
    const memory = options.memory ?? new BotMemory();
    this.stringIndexes = new AasStringIndexes(memory, (severity, text) => { options.print(severity, text); });
    this.hideRouting = new AasHideRouting(memory);
    this.linkHeap = new AasLinkHeap(() => {
      if (options.developer()) options.print(4, "empty aas link heap\n");
    }, options.memory);
    this.bspEntities = new AasBspEntities((severity, text) => options.print(severity, text), options.memory);
    if (initialization === "setup") this.setup();
  }

  setup(): 0 {
    this.clientCapacity = sourceInteger(this.options.variables.value("maxclients", "128"), "AAS_Setup maxclients");
    this.entityCapacity = sourceInteger(this.options.variables.value("maxentities", "1024"), "AAS_Setup maxentities");
    this.saveRoutingCache = this.options.variables.getOrCreate("saveroutingcache", "0");
    this.history = new AasEntityHistory(this.entityCapacity, this, this.linkHeap, this.options.memory, () => this.initialized);
    this.history.invalidateEntities();
    this.currentFrame = 0;
    return 0;
  }

  get phase(): AasRuntimePhase {
    const phase = this.currentPhase;
    if (phase.kind !== "loaded" && phase.kind !== "ready") return phase;
    return this.currentInitialized ? { kind: "ready", map: phase.map }
      : { kind: "loaded", map: phase.map, initialization: { kind: "pending" } };
  }
  get loaded(): boolean { return this.currentPhase.kind !== "unloaded"; }
  get initialized(): boolean { return this.currentInitialized; }
  setInitialized(): void {
    this.currentInitialized = true;
    this.options.print(1, "AAS initialized.\n");
  }
  get maxClients(): number { return this.clientCapacity; }
  get maxEntities(): number { return this.entityCapacity; }
  get name(): string { return this.currentMapName; }
  get filename(): string { return this.currentFilename; }
  get entities(): AasEntityHistory {
    if (this.history === null) throw new Error("AAS entity allocation has been shut down");
    return this.history;
  }

  map(): AasEntityMap {
    const phase = this.phase;
    if (phase.kind === "unloaded") return phase;
    if (phase.kind === "data-loaded") {
      throw new Error("AAS spatial initialization was interrupted after loading its data");
    }
    return { kind: phase.kind, spatial: phase.map.spatial };
  }

  time(): number { return this.currentTime; }
  frameNumber(): number { return this.currentFrame; }

  modelFromIndex(index: number): string { return this.stringIndexes.modelFromIndex(index); }
  indexFromModel(model: string): number { return this.stringIndexes.indexFromModel(model); }
  updateStringIndexes(count: number, strings: readonly (string | null)[]): void { this.stringIndexes.update(count, strings); }

  areaGroundFace(area: number, point: Vec3): AasFace | null {
    return aasAreaGroundFace(this.queryWorld(), area, point, this.options.sampleDebug ? text => { this.options.print(1, text); } : null);
  }
  areaCrouch(area: number): number { return Number((this.areaSettingsRecord(area).presenceType & 2) === 0); }
  areaSwim(area: number): number { return Number((this.areaSettingsRecord(area).flags & 4) !== 0); }
  areaLiquid(area: number): number { return this.areaSwim(area); }
  areaLava(area: number): number { return this.areaSettingsRecord(area).contents & 2; }
  areaSlime(area: number): number { return this.areaSettingsRecord(area).contents & 4; }
  areaGrounded(area: number): number { return this.areaSettingsRecord(area).flags & 1; }
  areaLadder(area: number): number { return this.areaSettingsRecord(area).flags & 2; }
  areaJumpPad(area: number): number { return this.areaSettingsRecord(area).contents & 128; }
  areaTeleporter(area: number): number { return this.areaSettingsRecord(area).contents & 64; }
  areaClusterPortal(area: number): number { return this.areaSettingsRecord(area).contents & 8; }
  areaDoNotEnter(area: number): number { return this.areaSettingsRecord(area).contents & 256; }

  private areaSettingsRecord(area: number): AasWorld["areaSettings"][number] {
    const settings = this.queryWorld()?.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS area query exceeds source area-settings allocation");
    return settings;
  }

  areaCluster(area: number): number {
    const world = this.queryWorld();
    if (world === null || area <= 0 || area >= world.areas.length) {
      this.options.print(3, "AAS_AreaCluster: invalid area number\n");
      return 0;
    }
    const settings = world.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS_AreaCluster exceeds source area-settings allocation");
    return settings.cluster;
  }

  areaPresenceType(area: number): number {
    const world = this.queryWorld();
    if (world === null) return 0;
    if (area <= 0 || area >= world.areas.length) {
      this.options.print(3, "AAS_AreaPresenceType: invalid area number\n");
      return 0;
    }
    const settings = world.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS_AreaPresenceType exceeds source area-settings allocation");
    return settings.presenceType;
  }

  traceEndFace(trace: AasTrace): AasFace | null {
    return aasTraceEndFace(this.queryWorld(), trace, this.options.sampleDebug ? text => { this.options.print(1, text); } : null);
  }
  planeFromNum(plane: number): AasPlane | null { return aasPlaneFromNum(this.queryWorld(), plane); }
  facePlane(face: number): AasPlane {
    const world = this.queryWorld();
    if (world === null) throw new RangeError("AAS_FacePlane reached a source null world allocation");
    return aasFacePlane(world, face);
  }

  nearestHideArea(origin: Vec3, area: number, enemyOrigin: Vec3, enemyArea: number, travelFlags: number): number {
    return this.queryMap().routing.nearestHideArea(origin, area, enemyOrigin, enemyArea, travelFlags);
  }

  nextModelReachability(previous: number, model: number): number {
    const world = this.queryWorld();
    if (world === null) return 0;
    return aasNextModelReachability(world, previous, model);
  }

  randomGoalArea(area: number, travelFlags: number, random: () => number): AasGoalPosition | null {
    if (this.areaReachability(area) === 0) return null;
    const map = this.queryMap();
    return map.routing.randomGoalArea(map.spatial, area, travelFlags, random, text => { this.options.log.write(text); });
  }

  /** AAS_CreateAllRoutingCache changes the source initialized flag even on an unloaded world. */
  createAllRoutingCache(): void {
    this.currentInitialized = true;
    this.options.print(1, "AAS_CreateAllRoutingCache\n");
    const world = this.queryWorld();
    if (world !== null) {
      for (let area = 1; area < world.areas.length; area++) {
        if (this.areaReachability(area) === 0) continue;
        for (let goalArea = 1; goalArea < world.areas.length; goalArea++) {
          if (area === goalArea || this.areaReachability(goalArea) === 0) continue;
          const origin = world.areas[area]?.center;
          if (origin === undefined) throw new RangeError("AAS_CreateAllRoutingCache area exceeds source allocation");
          this.areaTravelTimeToGoal({ area, origin, goalArea, travelFlags: TravelFlags.DEFAULT });
        }
      }
    }
    this.currentInitialized = false;
  }
  print(severity: 1 | 4, text: string): void { this.options.print(severity, text); }

  pointArea(origin: Vec3): number {
    const phase = this.currentPhase;
    if (phase.kind === "unloaded") {
      this.options.print(3, "AAS_PointAreaNum: aas not loaded\n");
      return 0;
    }
    return phase.kind === "data-loaded" ? phase.world.pointArea(origin) : phase.map.world.pointArea(origin);
  }

  presenceBounds(presence: number): Bounds {
    if (presence !== 2 && presence !== 4) {
      this.options.print(4, "AAS_PresenceTypeBoundingBox: unknown presence type\n");
      return presenceTypeBounds(4);
    }
    return presenceTypeBounds(presence);
  }

  pointPresenceType(origin: Vec3): number {
    const world = this.queryWorld();
    if (world === null) return 0;
    const area = this.pointArea(origin);
    if (area === 0) return 0;
    const settings = world.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS point presence area exceeds its allocation");
    return settings.presenceType;
  }

  predictClientMovement(request: AasPredictionRequest, pointContents: AasSpatialHost["pointContents"],
    output?: AasClientMoveOutput): AasMovementPrediction {
    const runtime = this;
    const queries: AasMovementQueries = {
      get world(): AasWorld {
        const world = runtime.queryWorld();
        if (world === null) throw new Error("AAS movement reached a source null world allocation");
        return world;
      },
      host: { pointContents, trace: (start, end, bounds, passEntity, mask) =>
        runtime.queryMap().spatial.host.trace(start, end, bounds, passEntity, mask) },
      pointArea: origin => runtime.pointArea(origin),
      pointPresenceType: origin => runtime.pointPresenceType(origin),
      presenceBounds: presence => runtime.presenceBounds(presence),
      traceClientBBox: (start, end, presence, passEntity) => {
        const world = runtime.queryWorld();
        if (world === null) return { startSolid: false, fraction: 0, end: vec3(0, 0, 0),
          entityNum: 0, plane: 0, area: 0, lastArea: 0 };
        return AasSpatial.traceWorldClientBBox(world, start, end, presence, passEntity, (area, segmentStart, segmentEnd) => {
          const bounds = runtime.presenceBounds(presence);
          const spatial = runtime.ownedMap?.spatial;
          if (spatial === undefined) throw new Error("AAS movement reached source null entity-link heads");
          const host = runtime.currentSpatialHost;
          if (host === null) throw new Error("AAS movement entity collision has no current host");
          return spatial.traceAreaEntityCollision(area, segmentStart, segmentEnd, bounds, passEntity,
            (entity, entityStart, entityEnd, entityBounds, mask) => host.entityTrace(entity, entityStart, entityEnd, entityBounds, mask));
        }, text => { runtime.options.print(3, text); }, runtime.options.sampleDebug);
      },
      traceAreas: (start, end, maximum) => {
        const crossings: AasAreaCrossing[] = [];
        runtime.writeTraceAreas(start, end, maximum, crossing => { crossings.push(crossing); return undefined; });
        return crossings;
      },
      pointInsideFace: (face, point, epsilon) => runtime.queryMap().spatial.pointInsideFace(face, point, epsilon),
    };
    return new AasMovement(queries, this.movementSettings, this.options.movementDebug).predictClientMovement(request, output);
  }

  /** Null requests the source zero fill, after its diagnostic has returned. */
  entityInfo(entity: number): AasEntityInfo | null {
    if (!this.initialized) {
      this.options.print(4, "AAS_EntityInfo: aasworld not initialized\n");
      return null;
    }
    return this.entities.info(entity);
  }

  private queryWorld(): AasWorld | null {
    const phase = this.currentPhase;
    return phase.kind === "unloaded" ? null : phase.kind === "data-loaded" ? phase.world : phase.map.world;
  }

  /** Borrow only at a reached spatial operation; point queries also work during data load. */
  queryMap(): AasRuntimeMap {
    const phase = this.currentPhase;
    if (phase.kind !== "loaded" && phase.kind !== "ready") {
      throw new Error("AAS query reached spatial allocations before their initialization");
    }
    return phase.map;
  }

  areaInfo(area: number): AasAreaInfo | null {
    const world = this.queryWorld();
    if (world === null || area <= 0 || area >= world.areas.length) {
      this.options.print(3, `AAS_AreaInfo: areanum ${area} out of range\n`);
      return null;
    }
    const settings = world.areaSettings[area], geometry = world.areas[area];
    if (settings === undefined || geometry === undefined) throw new RangeError("AAS area info exceeds its allocation");
    return { cluster: settings.cluster, contents: settings.contents, flags: settings.flags,
      presenceType: settings.presenceType, mins: geometry.bounds.min, maxs: geometry.bounds.max, center: geometry.center };
  }

  areaReachability(area: number): number {
    const world = this.queryWorld();
    if (world === null || area < 0 || area >= world.areas.length) {
      this.options.print(4, `AAS_AreaReachability: areanum ${area} out of range`);
      return 0;
    }
    const settings = world.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS reachability area exceeds its allocation");
    return settings.reachableAreaCount;
  }

  writeTraceAreas(start: Vec3, end: Vec3, maximumAreas: number,
    publish: (crossing: AasAreaCrossing, index: number) => undefined): number {
    if (!this.loaded) return 0;
    if (this.currentPhase.kind === "data-loaded") {
      return AasSpatial.writeWorldTraceAreas(this.currentPhase.world, start, end, maximumAreas, publish,
        text => { this.options.print(3, text); }, this.options.sampleDebug);
    }
    return this.queryMap().spatial.writeTraceAreas(start, end, maximumAreas, publish);
  }

  writeBBoxAreas(bounds: Bounds, maximumAreas: number, publish: (area: number, index: number) => undefined): number {
    if (!this.loaded) {
      this.options.print(3, "AAS_LinkEntity: aas not loaded\n");
      return 0;
    }
    return this.queryMap().spatial.writeBBoxAreas(bounds, maximumAreas, publish);
  }

  enableRoutingArea(area: number, enable: number): number {
    const world = this.queryWorld();
    if (world === null || area <= 0 || area >= world.areas.length) {
      if (this.options.developer()) this.options.print(3, `AAS_EnableRoutingArea: areanum ${area} out of range\n`);
      return 0;
    }
    const settings = world.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS enabled area exceeds its allocation");
    const previous = Number((settings.flags & 8) === 0);
    if (enable < 0) return previous;
    if (!(world instanceof AasWorldState)) throw new Error("AAS routing mutation requires the owned world allocation");
    if (this.currentPhase.kind !== "data-loaded") this.queryMap().routing.setAreaEnabled(area, enable !== 0);
    world.areaSettingsRecord(area).flags = enable !== 0 ? settings.flags & ~8 : settings.flags | 8;
    return previous;
  }

  areaTravelTimeToGoal(query: AreaTravelTimeQuery): number {
    if (!this.initialized) return 0;
    if (query.area === query.goalArea) return 1;
    const world = this.queryWorld();
    if (world === null) {
      if (this.options.developer()) this.options.print(3, `AAS_AreaTravelTimeToGoalArea: areanum ${query.area} out of range\n`);
      return 0;
    }
    return this.queryMap().routing.areaTravelTimeToGoal(query, "source");
  }

  pointReachabilityAreaIndex(origin: Vec3 | null): number {
    if (!this.initialized) return 0;
    const world = this.queryWorld();
    if (origin === null) return world === null ? 0 : world.clusters.reduce((total, cluster) => (total + cluster.reachabilityAreaCount) | 0, 0);
    const area = this.pointArea(origin);
    if (area === 0 || this.areaReachability(area) === 0) return 0;
    if (world === null) throw new RangeError("AAS reachability index reached a source null area allocation");
    const settings = world.areaSettings[area];
    if (settings === undefined) throw new RangeError("AAS reachability index area exceeds its allocation");
    if (settings.cluster < 0) {
      throw new RangeError("AAS_PointReachabilityAreaIndex source reuses frontcluster as a negative portal index");
    }
    let index = 0;
    for (let cluster = 0; cluster < settings.cluster; cluster++) {
      const record = world.clusters[cluster];
      if (record === undefined) throw new RangeError("AAS reachability cluster index exceeds its allocation");
      index = (index + record.reachabilityAreaCount) | 0;
    }
    return (index + settings.clusterAreaNumber) | 0;
  }

  writeAlternativeRouteGoals(query: AlternativeRouteQuery,
    publish: (goal: AlternativeGoal, index: number) => undefined): number {
    if (query.startArea === 0 || query.goalArea === 0 || !this.loaded) return 0;
    return this.queryMap().routing.writeAlternativeRouteGoals(query, publish);
  }

  writePredictRoute(query: PredictRouteQuery, output: AasRoutePredictionOutput): boolean {
    const phase = this.currentPhase;
    if (phase.kind === "loaded" || phase.kind === "ready") return phase.map.routing.writePredictRoute(query, output);
    initializeAasRoutePrediction(query, output);
    // Source still copies origin into its local even when its loop cannot run.
    const origin = { x: query.origin.x, y: query.origin.y, z: query.origin.z };
    void origin;
    if (phase.kind === "data-loaded" && query.area !== query.goalArea
      && query.maximumAreas >= 0 && phase.world.areas.length !== 0) output.stopEvent = RouteStopEvent.NO_ROUTE;
    return query.area === query.goalArea;
  }

  loadMap(input: AasMapInput): number {
    if (input.name === null) return 0;
    this.currentSpatialHost = input.spatialHost;
    const entities = this.entities;
    const outgoing = this.ownedMap;
    this.currentInitialized = false;
    if (this.currentPhase.kind === "ready") {
      this.currentPhase = { kind: "loaded", map: this.currentPhase.map, initialization: { kind: "pending" } };
    }
    outgoing?.routing.shutdownRouting();
    const name = mapName(input.name);
    this.currentMapName = name;
    entities.resetEntityLinks();
    this.bspEntities.load(input.bsp.entities);
    const filename = this.sourceFilename(`maps/${name}.aas`);
    this.options.print(1, `trying to load ${filename}\n`);
    this.dumpAasData();
    this.currentPhase = { kind: "unloaded" };
    const result = this.readAas(input.assets, filename);
    if (result.kind === "failed") return result.error;
    const world = new AasWorldState(result.world,
      this.options.sampleDebug ? (severity, text) => { this.options.print(severity, text); } : null);
    this.currentPhase = { kind: "data-loaded", name, world };
    result.close();
    if (this.options.fileDebug === true) printAasFileInfo(world, this.options.print);
    this.options.print(1, `loaded ${filename}\n`);
    this.currentFilename = filename;
    const settings = initAasMovementSettings((variable, initial) => this.options.variables.value(variable, initial), this.movementSettings);
    this.linkHeap.initialize(() => this.options.variables.value("max_aaslinks", "6144"));
    outgoing?.spatial.freeLinkedEntities();
    const spatialHost: AasSpatialHost = {
      print: (text, severity) => {
        if (severity === undefined) input.spatialHost.print(text);
        else this.options.print(severity, text);
      },
      trace: (start, end, bounds, passEntity, mask) => input.spatialHost.trace(start, end, bounds, passEntity, mask),
      pointContents: point => input.spatialHost.pointContents(point),
      entityTrace: (entity, start, end, bounds, mask) => input.spatialHost.entityTrace(entity, start, end, bounds, mask),
      entityModelIndex: entity => this.entities.entityModelIndex(entity),
      modelBounds: (model, angles) => input.spatialHost.modelBounds(model, angles),
    };
    const spatial = new AasSpatial(world, this.bspEntities, spatialHost, settings, this.brushModelTypes, this.linkHeap,
      this.options.movementDebug, () => this.options.variables.value("bot_visualizejumppads", "0"), this.options.sampleDebug);
    const routing = new AasRouting(world, {
      milliseconds: () => this.options.milliseconds(),
      ...(this.options.routingDebug === undefined ? {} : { routingDebug: this.options.routingDebug }),
      ...(this.options.alternativeRouteDebug === undefined ? {} : { alternativeRouteDebug: this.options.alternativeRouteDebug }),
      ...(this.options.memory === undefined ? {} : { memory: this.options.memory }), hideRouting: this.hideRouting, host: {
      initialized: () => this.initialized, developer: () => this.options.developer(),
      print: (severity, text) => this.options.print(severity, text),
    } });
    const reachability = new AasReachabilityGenerator({ world, spatial, bspEntities: this.bspEntities,
      ...(this.options.reachabilityDebugState === undefined ? {} : { debugState: this.options.reachabilityDebugState }),
      variables: this.options.variables, print: (severity, text) => this.options.print(severity, text),
      log: text => { this.options.log.write(text); return undefined; },
      milliseconds: () => this.options.milliseconds(),
      permanentLine: (start, end, color) => this.options.permanentLine(start, end, color) });
    const clustering = new AasClustering(world, { variables: this.options.variables,
      print: (severity, text) => this.options.print(severity, text), log: this.options.log });
    const map: OwnedAasMap = { name, filename, world, spatial, routing, bspEntities: this.bspEntities,
      assets: input.assets, reachability, clustering };
    this.ownedMap = map;
    this.currentPhase = { kind: "loaded", map, initialization: { kind: "pending" } };
    reachability.initialize();
    outgoing?.routing.shutdownAlternativeRouting();
    routing.initializeAlternativeRouting(this.options.log);
    return 0;
  }

  startFrame(time: number): 0 {
    const entities = this.entities;
    this.currentTime = Math.fround(time);
    entities.unlinkInvalidEntities();
    entities.invalidateEntities();
    this.continueInit();
    this.ownedMap?.routing.resetFrameRoutingUpdates();
    this.frameEffects();
    this.currentFrame = (this.currentFrame + 1) | 0;
    return 0;
  }

  updateEntity(entity: number, state: BotEntityUpdate | null | (() => BotEntityUpdate | null)): number {
    return this.entities.update(entity, state);
  }

  shutdown(): void {
    this.ownedMap?.routing.shutdownAlternativeRouting();
    this.bspEntities.dump();
    this.ownedMap?.routing.shutdownRouting();
    this.linkHeap.free();
    this.ownedMap?.spatial.freeLinkedEntities();
    this.dumpAasData();
    this.clearOwnedState();
    this.options.print(1, "AAS shutdown.\n");
  }

  /** Terminal ownership cleanup does not replay source diagnostics or host callbacks. */
  disposeResources(): void {
    this.ownedMap?.routing.shutdownAlternativeRouting();
    this.bspEntities.dump();
    this.ownedMap?.routing.shutdownRouting();
    this.linkHeap.free();
    this.ownedMap?.spatial.freeLinkedEntities();
    this.dumpAasData();
    this.clearOwnedState();
  }

  private dumpAasData(): void {
    const world = this.currentPhase.kind === "data-loaded" ? this.currentPhase.world : this.ownedMap?.world;
    world?.dumpData();
  }

  private clearOwnedState(): void {
    this.stringIndexes.clear();
    this.currentInitialized = false;
    this.ownedMap = null;
    this.currentPhase = { kind: "unloaded" };
    this.history = null;
    this.currentTime = 0;
    this.currentFrame = 0;
    this.currentMapName = "";
    this.currentFilename = "";
    this.clientCapacity = 0;
    this.entityCapacity = 0;
  }

  private readAas(assets: AasMapInput["assets"], filename: string): AasReadResult {
    const opened = assets.openRead(filename);
    if (opened === undefined) {
      this.options.print(4, `can't open ${filename}\n`);
      return { kind: "failed", error: 4 };
    }
    const { file, length } = opened;
    let seekFailed = false;
    try {
      const bytes = new Uint8Array(124);
      if (assets.readInto(file, bytes) !== bytes.length) {
        throw new BinaryError(filename, 0, "truncated AAS header");
      }
      const header = new BinaryReader(bytes, filename);
      if (header.u32() !== 0x53414145) {
        this.options.print(4, `${filename} is not an AAS file\n`);
        assets.closeFile(file);
        return { kind: "failed", error: 5 };
      }
      const version = header.i32();
      if (version !== 4 && version !== 5) {
        this.options.print(4, `aas file ${filename} is version ${version}, not 5\n`);
        assets.closeFile(file);
        return { kind: "failed", error: 6 };
      }
      const checksumBytes = header.bytes(4);
      if (version === 5) {
        for (let index = 0; index < checksumBytes.length; index++) {
          const byte = checksumBytes[index];
          if (byte === undefined) throw new BinaryError(filename, 8 + index, "truncated AAS checksum");
          checksumBytes[index] = byte ^ ((index * 119) & 255);
        }
      }
      const checksum = new BinaryReader(checksumBytes, filename).i32();
      if (checksum !== nativeAtoi(this.options.variables.getString("sv_mapChecksum"))) {
        this.options.print(4, `aas file ${filename} is out of date\n`);
        assets.closeFile(file);
        return { kind: "failed", error: 6 };
      }
      let lastOffset = 124;
      const world = parseAas(bytes, filename, this.options.memory, {
        length,
        load: (lump, stride, memory) => {
          if (lump.length === 0) return memory.allocate(stride + 1, "hunk", true);
          if (lump.offset !== lastOffset) {
            this.options.print(2, "AAS file not sequentially read\n");
            if (assets.seekFile(file, lump.offset, 2) !== 0) {
              seekFailed = true;
              this.options.print(4, "can't seek to aas lump\n");
              this.dumpAasData();
              assets.closeFile(file);
              throw new BinaryError(filename, lump.offset, "can't seek to aas lump");
            }
          }
          const allocation = memory.allocate(lump.length + 1, "hunk", true);
          assets.readInto(file, allocation.bytes.subarray(0, lump.length));
          lastOffset += lump.length;
          return allocation;
        },
      });
      return { kind: "loaded", world, close: () => assets.closeFile(file) };
    } catch (error) {
      if (!(error instanceof BinaryError)) throw error;
      if (!seekFailed) {
        this.options.print(4, `error reading AAS lump from ${filename}: ${error.message}\n`);
        assets.closeFile(file);
      }
      return { kind: "failed", error: 7 };
    }
  }

  private continueInit(): void {
    const phase = this.currentPhase;
    if (phase.kind === "unloaded" || this.currentInitialized) return;
    if (phase.kind === "data-loaded") throw new Error("AAS initialization cannot continue after an interrupted map load");
    const map = this.ownedMap;
    if (map === null) throw new Error("AAS loaded map allocation is absent");
    if (map.reachability.continueInitialization(this.currentTime)) return;
    map.clustering.initialize();
    if (map.world.saveFile || sourceInteger(this.options.variables.getValue("forcewrite"), "AAS_ContinueInit") !== 0) {
      if (sourceInteger(this.options.variables.value("aasoptimize", "0"), "AAS_ContinueInit") !== 0) {
        aasOptimize(map.world, text => this.options.print(1, text));
      }
      if (writeAasFile(map.world, this.currentFilename, {
        openWrite: filename => this.options.openWrite(filename),
        print: (severity, text) => this.options.print(severity, text),
      })) {
        this.options.print(1, `${this.currentFilename} written succesfully\n`);
      } else {
        this.options.print(3, `couldn't write ${this.currentFilename}\n`);
      }
    }
    map.routing.initializeRouting(map.spatial, () => this.routingCacheBytes(), () => this.currentTime);
    const cacheFilename = this.sourceFilename(`maps/${this.currentMapName}.rcd`);
    map.routing.readRouteCache(cacheFilename, {
      openRead: filename => map.assets.openRead(filename),
      readInto: (file, bytes) => map.assets.readInto(file, bytes),
      closeFile: file => { map.assets.closeFile(file); },
      print: (severity, text) => this.options.print(severity, text),
    });
    this.currentPhase = { kind: "ready", map };
    this.setInitialized();
  }

  private routingCacheBytes(): number {
    const value = this.options.variables.value("max_routingcache", "4096");
    const bytes = sourceInteger(value, "AAS_InitRouting max_routingcache") * 1024;
    if (bytes < 0 || bytes > 2147483647) throw new RangeError("AAS routing cache capacity exceeds the source signed allocation range");
    return bytes;
  }

  private frameEffects(): void {
    const variables = this.options.variables;
    if (this.options.developer()) {
      if (variables.getValue("showcacheupdates") !== 0) {
        const statistics = this.ownedMap?.routing.cacheStatistics;
        this.options.print(1, `${statistics?.areaUpdates ?? 0} area cache updates\n`);
        this.options.print(1, `${statistics?.portalUpdates ?? 0} portal cache updates\n`);
        this.options.print(1, `${statistics?.bytes ?? 0} bytes routing cache\n`);
        variables.set("showcacheupdates", "0");
      }
      for (const variable of ["showmemoryusage", "memorydump"]) {
        if (variables.getValue(variable) === 0) continue;
        // Release l_memory.c leaves both diagnostic functions empty.
        variables.set(variable, "0");
      }
    }
    if (this.saveRoutingCache === null) throw new Error("AAS saveroutingcache variable has not been initialized");
    if (this.saveRoutingCache.value !== 0) {
      const phase = this.currentPhase;
      if (phase.kind === "data-loaded") throw new Error("AAS_WriteRouteCache: source routing cache tables have not been allocated");
      const host: AasRouteCacheWriteHost = {
        openWrite: filename => this.options.openWrite(filename),
        print: (severity, text) => this.options.print(severity, text),
      };
      const filename = (): string => this.sourceFilename(`maps/${this.currentMapName}.rcd`);
      if (phase.kind === "unloaded") writeEmptyRouteCache(filename(), host);
      else phase.map.routing.writeRouteCache(filename, host);
      variables.set("saveroutingcache", "0");
    }
  }

  private sourceFilename(text: string): string {
    if (text.length >= 64) this.options.commonPrint(`Com_sprintf: overflow of ${text.length} in 64\n`);
    return text.slice(0, 63);
  }
}
