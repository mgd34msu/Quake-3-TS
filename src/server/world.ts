// Port of id Software's code/server/sv_world.c and sv_game.c:SV_EntityContact.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, radiusFromBounds, sub3, vec3 } from "../core/math.ts";
import { float32ToBits } from "../core/numeric.ts";
import { CommonError } from "../core/common-error.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { emptySourceTrace, sourceTraceView } from "../collision/world.ts";
import type { CollisionWorld, SourceTraceResult, TraceQuery, TraceResult } from "../collision/world.ts";
import { createBoxModel, createCapsuleModel } from "../collision/model.ts";
import type { EntityShared, SharedEntity } from "../shared/entity-shared.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../shared/player-state.ts";

const CONTENTS_SOLID = 1;
const CONTENTS_BODY = 0x2000000;
const SOLID_BMODEL = 0xffffff;
const MAX_ENT_CLUSTERS = 16;
const MAX_TOTAL_ENT_LEAFS = 128;
const MAX_GENTITIES = 1024;

export interface LinkState {
  readonly linked: boolean;
  readonly linkcount: number;
  readonly absbounds: Bounds;
  readonly clusters: readonly number[];
  readonly lastCluster: number;
  readonly areanum: number;
  readonly areanum2: number;
  /** Diagnostic BSP split metadata; source snapshot overflow uses lastCluster. */
  readonly topnode: number | null;
  readonly leafOverflowed: boolean;
}

export interface ServerTraceQuery extends Omit<TraceQuery, "modelIndex"> {
  readonly passEntityNum: number;
}
export type ServerTraceResult = TraceResult & { readonly entityNum: number };
export type ServerSourceTraceResult = SourceTraceResult & { readonly entityNum: number };

export interface ServerWorldHost {
  readonly loading: boolean;
  print(text: string): undefined;
  developerPrint(text: string): undefined;
}

type SectorPartition =
  | { readonly kind: "unused" | "leaf" }
  | { readonly kind: "split"; readonly axis: "x" | "y"; readonly distance: number;
      readonly front: Sector; readonly back: Sector };
interface Sector { partition: SectorPartition; head: EntitySectorLink | null }
interface EntitySectorLink { readonly number: number; sector: Sector | null; next: EntitySectorLink | null }
interface SpatialLink {
  clusters: number[];
  lastCluster: number;
  areanum: number;
  areanum2: number;
  topnode: number | null;
  leafOverflowed: boolean;
}

function checkBounds(bounds: Bounds): void {
  for (const axis of ["x", "y", "z"] satisfies readonly (keyof Vec3)[]) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis]) || bounds.min[axis] > bounds.max[axis]) {
      throw new RangeError("server world requires finite ordered bounds");
    }
  }
}

/** Engine-lived sv_worldSectors and svEntity membership cells, without map or game borrows. */
export class ServerWorldSectors {
  readonly #sectors: Sector[] = Array.from({ length: 64 }, () => ({ partition: { kind: "unused" }, head: null }));
  readonly #entities: EntitySectorLink[] = Array.from({ length: MAX_GENTITIES }, (_, number) => ({ number, sector: null, next: null }));
  #root: Sector | null = null;

  /** SV_ClearServer memsets sv.svEntities but leaves the global sector heads intact. */
  clearServer(): void {
    for (const entity of this.#entities) { entity.sector = null; entity.next = null; }
  }

  clearWorld(bounds: Bounds): void {
    checkBounds(bounds);
    for (const sector of this.#sectors) { sector.partition = { kind: "unused" }; sector.head = null; }
    let allocated = 0;
    const create = (bounds: Bounds, depth: number): Sector => {
      const sector = this.#sectors[allocated++];
      if (sector === undefined) throw new Error("server world sector allocation exhausted");
      if (depth === 4) { sector.partition = { kind: "leaf" }; return sector; }
      const size = sub3(bounds.max, bounds.min);
      const axis = size.x > size.y ? "x" : "y";
      const distance = Math.fround(0.5 * Math.fround(bounds.max[axis] + bounds.min[axis]));
      sector.partition = { kind: "split", axis, distance,
        front: create({ min: { ...bounds.min, [axis]: distance }, max: bounds.max }, depth + 1),
        back: create({ min: bounds.min, max: { ...bounds.max, [axis]: distance } }, depth + 1) };
      return sector;
    };
    this.#root = create(bounds, 0);
  }

  #entity(number: number): EntitySectorLink {
    const entity = this.#entities[number];
    if (!Number.isInteger(number) || entity === undefined) throw new RangeError("server membership slot must be within 0..1023");
    return entity;
  }

  hasSector(number: number): boolean { return this.#entity(number).sector !== null; }

  unlink(number: number): boolean {
    const entity = this.#entity(number), sector = entity.sector;
    if (sector === null) return true;
    entity.sector = null;
    if (sector.head === entity) { sector.head = entity.next; return true; }
    for (let previous = sector.head; previous !== null; previous = previous.next) {
      if (previous.next === entity) { previous.next = entity.next; return true; }
    }
    return false;
  }

  link(number: number, absbounds: Bounds): void {
    const entity = this.#entity(number);
    checkBounds(absbounds);
    const root = this.#root;
    if (root === null) throw new Error("server world sectors require map bounds before linking");
    let sector: Sector = root;
    while (sector.partition.kind === "split") {
      const partition: Extract<SectorPartition, { readonly kind: "split" }> = sector.partition;
      if (absbounds.min[partition.axis] > partition.distance) sector = partition.front;
      else if (absbounds.max[partition.axis] < partition.distance) sector = partition.back;
      else break;
    }
    entity.sector = sector; entity.next = sector.head; sector.head = entity;
  }

  visitCandidates(bounds: Bounds, visit: (number: number) => "continue" | "stop-this-sector"): void {
    checkBounds(bounds);
    const visitSector = (sector: Sector): void => {
      for (let entity = sector.head; entity !== null;) {
        const next = entity.next;
        if (visit(entity.number) === "stop-this-sector") return;
        entity = next;
      }
      const partition = sector.partition;
      if (partition.kind !== "split") return;
      if (bounds.max[partition.axis] > partition.distance) visitSector(partition.front);
      if (bounds.min[partition.axis] < partition.distance) visitSector(partition.back);
    };
    if (this.#root !== null) visitSector(this.#root);
  }

  sectorCounts(): readonly number[] {
    return this.#sectors.map(sector => {
      let count = 0;
      for (let entity = sector.head; entity !== null; entity = entity.next) count++;
      return count;
    });
  }
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.min.x <= b.max.x && a.min.y <= b.max.y && a.min.z <= b.max.z &&
    a.max.x >= b.min.x && a.max.y >= b.min.y && a.max.z >= b.min.z;
}

function copyState(shared: EntityShared, link: SpatialLink): LinkState {
  const min = shared.absmin, max = shared.absmax;
  return { linked: shared.linked, linkcount: shared.linkcount,
    absbounds: { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } },
    clusters: [...link.clusters], lastCluster: link.lastCluster, areanum: link.areanum,
    areanum2: link.areanum2, topnode: link.topnode, leafOverflowed: link.leafOverflowed };
}

function absoluteBounds(entity: SharedEntity): Bounds {
  const shared = entity.r;
  let bounds: Bounds;
  if (shared.model.kind === "inline" && (shared.currentAngles.x !== 0 || shared.currentAngles.y !== 0 || shared.currentAngles.z !== 0)) {
    const radius = radiusFromBounds({ min: shared.mins, max: shared.maxs });
    const extent = vec3(radius, radius, radius);
    bounds = { min: sub3(shared.currentOrigin, extent), max: add3(shared.currentOrigin, extent) };
  } else {
    bounds = { min: add3(shared.currentOrigin, shared.mins), max: add3(shared.currentOrigin, shared.maxs) };
  }
  const epsilon = vec3(1, 1, 1);
  return { min: sub3(bounds.min, epsilon), max: add3(bounds.max, epsilon) };
}

function encodeSolid(entity: SharedEntity): number {
  if (entity.r.model.kind === "inline") return SOLID_BMODEL;
  if ((entity.r.contents & (CONTENTS_SOLID | CONTENTS_BODY)) === 0) return 0;
  const byte = (value: number): number => Math.max(1, Math.min(255, Math.trunc(value)));
  return (byte(Math.fround(entity.r.maxs.z + 32)) << 16) | (byte(-entity.r.mins.z) << 8) | byte(entity.r.maxs.x);
}

function sharedEntityNumber(entity: SharedEntity): number {
  const number = entity.s.number;
  if (!Number.isInteger(number) || number < 0 || number >= MAX_GENTITIES) {
    throw new CommonError("drop", "SV_SvEntityForGentity: bad gEnt");
  }
  return number;
}

function copySourceTrace(source: SourceTraceResult): SourceTraceResult {
  const end = source.end, plane = source.plane, normal = plane.normal;
  return { ...source, end: { x: end.x, y: end.y, z: end.z },
    plane: { ...plane, normal: { x: normal.x, y: normal.y, z: normal.z } } };
}

/** C-locale %f for source binary32 coordinates, including round-to-even ties. */
function diagnosticCoordinate(value: number): string {
  const bits = float32ToBits(value), exponent = (bits >>> 23) & 255;
  const fraction = bits & 0x7fffff;
  const sign = bits >>> 31 !== 0 ? "-" : "";
  if (exponent === 255) return `${sign}${fraction === 0 ? "inf" : "nan"}`;
  const significand = BigInt(exponent === 0 ? fraction : fraction + 0x800000);
  const shift = exponent === 0 ? -149 : exponent - 150;
  const scaled = significand * 1000000n;
  let rounded: bigint;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), lower = scaled / divisor, remainder = scaled % divisor;
    rounded = remainder * 2n > divisor || (remainder * 2n === divisor && lower % 2n !== 0n)
      ? lower + 1n : lower;
  }
  return `${sign}${rounded / 1000000n}.${String(rounded % 1000000n).padStart(6, "0")}`;
}

/** Map-owned collision and link metadata borrow the engine's actual sector membership. */
export class ServerWorld {
  readonly #collision: CollisionWorld;
  readonly #bounds: Bounds;
  readonly #entityForNumber: (number: number) => SharedEntity | undefined;
  readonly #host: ServerWorldHost;
  readonly #links = new Map<number, SpatialLink>();
  readonly #sectors: ServerWorldSectors;

  constructor(collision: CollisionWorld, worldBounds: Bounds, entityForNumber: (number: number) => SharedEntity | undefined,
    host: ServerWorldHost, sectors = new ServerWorldSectors()) {
    checkBounds(worldBounds);
    this.#collision = collision;
    this.#bounds = { min: { ...worldBounds.min }, max: { ...worldBounds.max } };
    this.#entityForNumber = entityForNumber;
    this.#host = host;
    this.#sectors = sectors;
    this.#sectors.clearWorld(this.#bounds);
  }

  clear(): void { this.#links.clear(); this.#sectors.clearServer(); this.#sectors.clearWorld(this.#bounds); }

  #entity(number: number): SharedEntity {
    const entity = this.#entityForNumber(number);
    if (entity === undefined) throw new RangeError(`server entity ${number} is unavailable`);
    return entity;
  }

  linkState(number: number): LinkState | undefined {
    const link = this.#links.get(number);
    if (link === undefined) return undefined;
    const current = this.#entityForNumber(number);
    return current === undefined ? undefined : copyState(current.r, link);
  }

  adjustAreaPortalState(entity: SharedEntity, open: boolean): void {
    const link = this.#links.get(sharedEntityNumber(entity));
    if (link === undefined) {
      // Before first link, area numbers retain SV_ClearServer's zero values.
      this.#collision.adjustAreaPortalState(0, 0, open);
      return;
    }
    if (link.areanum2 === -1) return;
    this.#collision.adjustAreaPortalState(link.areanum, link.areanum2, open);
  }

  unlink(number: number): void { this.unlinkEntity(this.#entity(number)); }

  unlinkEntity(entity: SharedEntity): void {
    const number = sharedEntityNumber(entity);
    entity.r.linked = false;
    if (!this.#sectors.unlink(number)) this.#host.print("WARNING: SV_UnlinkEntity: not found in worldSector\n");
  }

  link(entity: SharedEntity): LinkState {
    const number = sharedEntityNumber(entity);
    checkBounds({ min: entity.r.mins, max: entity.r.maxs });
    checkBounds(absoluteBounds(entity));
    if (this.#sectors.hasSector(number)) {
      entity.r.linked = false;
      if (!this.#sectors.unlink(number)) this.#host.print("WARNING: SV_UnlinkEntity: not found in worldSector\n");
    }
    entity.s.solid = encodeSolid(entity);
    const absbounds = absoluteBounds(entity);
    entity.r.absmin = absbounds.min;
    entity.r.absmax = absbounds.max;
    const link: SpatialLink = this.#links.get(number) ?? { clusters: [], lastCluster: 0, areanum: -1, areanum2: -1,
      topnode: null, leafOverflowed: false };
    link.clusters.length = 0;
    link.lastCluster = 0;
    link.areanum = -1;
    link.areanum2 = -1;
    link.topnode = null;
    link.leafOverflowed = false;
    this.#links.set(number, link);
    const leafs = this.#collision.boxLeafnums({ min: entity.r.absmin, max: entity.r.absmax }, MAX_TOTAL_ENT_LEAFS);
    link.topnode = leafs.topnode;
    link.leafOverflowed = leafs.overflowed;
    if (leafs.leaves.length === 0) return copyState(entity.r, link);
    for (const leaf of leafs.leaves) {
      const area = this.#collision.leafArea(leaf);
      if (area === -1) continue;
      if (link.areanum !== -1 && link.areanum !== area) {
        if (link.areanum2 !== -1 && link.areanum2 !== area && this.#host.loading) {
          const min = entity.r.absmin;
          this.#host.developerPrint(`Object ${entity.s.number} touching 3 areas at ${diagnosticCoordinate(min.x)} ${diagnosticCoordinate(min.y)} ${diagnosticCoordinate(min.z)}\n`);
        }
        link.areanum2 = area;
      }
      else link.areanum = area;
    }
    link.clusters.length = 0;
    for (const leaf of leafs.leaves) {
      const cluster = this.#collision.leafCluster(leaf);
      if (cluster === -1) continue;
      link.clusters.push(cluster);
      if (link.clusters.length === MAX_ENT_CLUSTERS) {
        link.lastCluster = this.#collision.leafCluster(leafs.lastLeaf);
        break;
      }
    }
    entity.r.linkcount = (entity.r.linkcount + 1) | 0;
    this.#sectors.link(number, { min: entity.r.absmin, max: entity.r.absmax });
    entity.r.linked = true;
    return copyState(entity.r, link);
  }

  areaEntities(bounds: Bounds, maxCount = MAX_GENTITIES): readonly number[] {
    if (!Number.isSafeInteger(maxCount) || maxCount < 0 || maxCount > MAX_GENTITIES) throw new RangeError("area entity capacity must be between zero and MAX_GENTITIES");
    const result: number[] = [];
    this.areaEntitiesInto(bounds, maxCount, number => { result.push(number); });
    return result;
  }

  areaEntitiesInto(bounds: Bounds, maxCount: number, publish: (number: number, index: number) => undefined): number {
    checkBounds(bounds);
    if (!Number.isInteger(maxCount) || maxCount < -0x80000000 || maxCount > 0x7fffffff) {
      throw new RangeError("area entity capacity must be a signed 32-bit integer");
    }
    let count = 0;
    this.#sectors.visitCandidates(bounds, number => {
      const current = this.#entity(number);
      const absbounds = { min: current.r.absmin, max: current.r.absmax };
      if (!intersects(absbounds, bounds)) return "continue";
      if (count === maxCount) {
        this.#host.print("SV_AreaEntities: MAXCOUNT\n");
        return "stop-this-sector";
      }
      publish(number, count);
      count++;
      return "continue";
    });
    return count;
  }

  #traceEntityGeometrySource(query: Omit<TraceQuery, "modelIndex">, entity: SharedEntity, angles: Vec3): SourceTraceResult {
    const shared = entity.r;
    const model = shared.model;
    switch (model.kind) {
      case "inline": return this.#collision.transformedTraceSource({ ...query, modelIndex: entity.s.modelindex }, shared.currentOrigin, angles);
      case "box": return createBoxModel({ min: shared.mins, max: shared.maxs }, this.#collision.counters).transformedTraceSource(query, shared.currentOrigin, angles);
      case "capsule": return createCapsuleModel({ min: shared.mins, max: shared.maxs }, this.#collision.counters).transformedTraceSource(query, shared.currentOrigin, angles);
      default: { const exhaustive: never = model; return exhaustive; }
    }
  }

  #clipToEntitySource(entity: SharedEntity, query: Omit<TraceQuery, "modelIndex">): ServerSourceTraceResult {
    if ((query.mask & entity.r.contents) === 0) {
      return { ...emptySourceTrace(), entityNum: 0 };
    }
    const angles = entity.r.model.kind === "inline" ? entity.r.currentAngles : vec3(0, 0, 0);
    const result = copySourceTrace(this.#traceEntityGeometrySource(query, entity, angles));
    return { ...result, entityNum: result.fraction < 1 ? entity.s.number : 0 };
  }

  /** SV_ClipToEntity traces current entity storage without sector or owner filtering. */
  traceEntity(entityNum: number, query: Omit<TraceQuery, "modelIndex">): ServerTraceResult {
    if (!Number.isInteger(entityNum) || entityNum < 0 || entityNum >= MAX_GENTITIES) {
      throw new RangeError("entity trace slot must be within 0..1023");
    }
    const result = this.#clipToEntitySource(this.#entity(entityNum), query);
    return { ...sourceTraceView(result), entityNum: result.entityNum };
  }

  entityContact(bounds: Bounds, entity: SharedEntity, shape: "box" | "capsule" = "box"): boolean {
    checkBounds(bounds);
    const origin = vec3(0, 0, 0);
    const result = this.#traceEntityGeometrySource({ start: origin, end: origin,
      shape: { kind: shape, mins: bounds.min, maxs: bounds.max }, mask: -1 }, entity, entity.r.currentAngles);
    return result.allSolid || result.startSolid;
  }

  trace(query: ServerTraceQuery): ServerTraceResult {
    const result = this.traceSource(query);
    return { ...sourceTraceView(result), entityNum: result.entityNum };
  }

  traceSource(query: ServerTraceQuery): ServerSourceTraceResult {
    const world = copySourceTrace(this.#collision.traceSource(query));
    let result: ServerSourceTraceResult = { ...world, entityNum: world.fraction !== 1 ? ENTITYNUM_WORLD : ENTITYNUM_NONE };
    if (result.fraction === 0) return result;
    const end = { x: query.end.x, y: query.end.y, z: query.end.z };
    const entityQuery = { start: query.start, end, shape: query.shape, mask: query.mask };
    const zero = vec3(0, 0, 0);
    const mins = query.shape.kind === "point" ? zero : query.shape.mins;
    const maxs = query.shape.kind === "point" ? zero : query.shape.maxs;
    const bounds: Bounds = {
      min: sub3(add3(vec3(Math.min(query.start.x, end.x), Math.min(query.start.y, end.y), Math.min(query.start.z, end.z)), mins), vec3(1, 1, 1)),
      max: add3(add3(vec3(Math.max(query.start.x, end.x), Math.max(query.start.y, end.y), Math.max(query.start.z, end.z)), maxs), vec3(1, 1, 1)),
    };
    const candidates = this.areaEntities(bounds);
    // Floating bot items pass -1. Define that source out-of-array owner read as no exclusion.
    const hasPassEntity = query.passEntityNum !== ENTITYNUM_NONE && query.passEntityNum !== -1;
    let passOwnerNum = -1;
    if (hasPassEntity) {
      passOwnerNum = this.#entity(query.passEntityNum).r.ownerNum;
      if (passOwnerNum === ENTITYNUM_NONE) passOwnerNum = -1;
    }
    for (const number of candidates) {
      if (result.allSolid) break;
      const entity = this.#entity(number);
      if (hasPassEntity && (number === query.passEntityNum || entity.r.ownerNum === query.passEntityNum || entity.r.ownerNum === passOwnerNum)) continue;
      const hit = this.#clipToEntitySource(entity, entityQuery);
      if (hit.allSolid) result = { ...result, allSolid: true };
      else if (hit.startSolid) result = { ...result, startSolid: true };
      if (hit.fraction < result.fraction) {
        result = { ...hit, entityNum: entity.s.number, startSolid: hit.startSolid || result.startSolid };
      }
    }
    return result;
  }

  pointContents(point: Vec3, passEntityNum: number): number {
    let contents = this.#collision.pointContents(point);
    for (const number of this.areaEntities({ min: point, max: point })) {
      if (number === passEntityNum) continue;
      const entity = this.#entity(number), shared = entity.r, model = shared.model;
      switch (model.kind) {
        case "inline": contents |= this.#collision.transformedPointContents(point, entity.s.modelindex, entity.s.origin, entity.s.angles); break;
        case "box": contents |= createBoxModel({ min: shared.mins, max: shared.maxs }, this.#collision.counters).transformedPointContents(point, entity.s.origin, entity.s.angles); break;
        case "capsule": contents |= createCapsuleModel({ min: shared.mins, max: shared.maxs }, this.#collision.counters).transformedPointContents(point, entity.s.origin, entity.s.angles); break;
        default: { const exhaustive: never = model; return exhaustive; }
      }
    }
    return contents;
  }
}
