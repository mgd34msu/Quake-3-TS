/*
 * AAS entities translated from id Software's botlib/be_aas_entity.c.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import { add3, length3, sub3, vec3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { EntityType } from "../shared/definitions.ts";
import type { AasLink, AasLinkHeap } from "./aas-links.ts";
import { BotMemory } from "./memory.ts";
import type { BotMemoryAllocation } from "./memory.ts";
import type { AasSpatial } from "./spatial.ts";

export interface BotEntityUpdate {
  readonly type: number;
  readonly flags: number;
  readonly origin: Vec3;
  readonly angles: Vec3;
  readonly oldOrigin: Vec3;
  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly groundEntity: number;
  readonly solid: number;
  readonly modelIndex: number;
  readonly modelIndex2: number;
  readonly frame: number;
  readonly event: number;
  readonly eventParameter: number;
  readonly powerups: number;
  readonly weapon: number;
  readonly legsAnimation: number;
  readonly torsoAnimation: number;
}

export interface AasEntityInfo extends BotEntityUpdate {
  readonly valid: boolean;
  readonly number: number;
  readonly lastVisibleOrigin: Vec3;
  readonly lastUpdateTime: number;
  readonly updateInterval: number;
}

export type AasEntityMap = { readonly kind: "unloaded" }
  | { readonly kind: "loaded"; readonly spatial: AasSpatial }
  | { readonly kind: "ready"; readonly spatial: AasSpatial };

/** A projection of the actual AAS owner, not another clock or readiness owner. */
export interface AasEntityHost {
  readonly maxEntities: number;
  map(): AasEntityMap;
  time(): number;
  frameNumber(): number;
  print(severity: 1 | 4, text: string): void;
}

export interface AasEntityBspData {
  readonly origin: Vec3;
  readonly angles: Vec3;
  readonly absoluteBounds: Bounds;
  readonly solid: number;
  readonly modelNum: number;
}

// game/be_aas.h aas_entityinfo_t: 140 bytes. be_aas_def.h aas_entity_t
// adds two release32 pointers; area heads use the retained link heap's slot domain.
const ENTITY_BYTES = 148;

class EntityRecord implements AasEntityInfo {
  private cachedView: { readonly bytes: Uint8Array; readonly view: DataView } | null = null;

  constructor(private readonly allocation: BotMemoryAllocation, private readonly offset: number,
    private readonly linkHeap: AasLinkHeap) {}

  private view(): DataView {
    // Reborrow on every access: a host callback can retire the common hunk.
    const bytes = this.allocation.bytes;
    let cached = this.cachedView;
    if (cached === null || cached.bytes !== bytes) {
      cached = { bytes, view: new DataView(bytes.buffer, bytes.byteOffset + this.offset, ENTITY_BYTES) };
      this.cachedView = cached;
    }
    return cached.view;
  }
  private integer(offset: number): number { return this.view().getInt32(offset, true); }
  private setInteger(offset: number, value: number): void { this.view().setInt32(offset, value, true); }
  private float(offset: number): number { return this.view().getFloat32(offset, true); }
  private setFloat(offset: number, value: number): void { this.view().setFloat32(offset, value, true); }
  private vector(offset: number): Vec3 {
    const view = this.view();
    return vec3(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
  }
  private setVector(offset: number, value: Vec3): void {
    this.setFloat(offset, value.x);
    this.setFloat(offset + 4, value.y);
    this.setFloat(offset + 8, value.z);
  }

  get valid(): boolean { return this.integer(0) !== 0; }
  set valid(value: boolean) { this.setInteger(0, value ? 1 : 0); }
  get type(): number { return this.integer(4); }
  set type(value: number) { this.setInteger(4, value); }
  get flags(): number { return this.integer(8); }
  set flags(value: number) { this.setInteger(8, value); }
  get lastUpdateTime(): number { return this.float(12); }
  set lastUpdateTime(value: number) { this.setFloat(12, value); }
  get updateInterval(): number { return this.float(16); }
  set updateInterval(value: number) { this.setFloat(16, value); }
  get number(): number { return this.integer(20); }
  set number(value: number) { this.setInteger(20, value); }
  get origin(): Vec3 { return this.vector(24); }
  set origin(value: Vec3) { this.setVector(24, value); }
  get angles(): Vec3 { return this.vector(36); }
  set angles(value: Vec3) { this.setVector(36, value); }
  get oldOrigin(): Vec3 { return this.vector(48); }
  set oldOrigin(value: Vec3) { this.setVector(48, value); }
  get lastVisibleOrigin(): Vec3 { return this.vector(60); }
  set lastVisibleOrigin(value: Vec3) { this.setVector(60, value); }
  get mins(): Vec3 { return this.vector(72); }
  set mins(value: Vec3) { this.setVector(72, value); }
  get maxs(): Vec3 { return this.vector(84); }
  set maxs(value: Vec3) { this.setVector(84, value); }
  get groundEntity(): number { return this.integer(96); }
  set groundEntity(value: number) { this.setInteger(96, value); }
  get solid(): number { return this.integer(100); }
  set solid(value: number) { this.setInteger(100, value); }
  get modelIndex(): number { return this.integer(104); }
  set modelIndex(value: number) { this.setInteger(104, value); }
  get modelIndex2(): number { return this.integer(108); }
  set modelIndex2(value: number) { this.setInteger(108, value); }
  get frame(): number { return this.integer(112); }
  set frame(value: number) { this.setInteger(112, value); }
  get event(): number { return this.integer(116); }
  set event(value: number) { this.setInteger(116, value); }
  get eventParameter(): number { return this.integer(120); }
  set eventParameter(value: number) { this.setInteger(120, value); }
  get powerups(): number { return this.integer(124); }
  set powerups(value: number) { this.setInteger(124, value); }
  get weapon(): number { return this.integer(128); }
  set weapon(value: number) { this.setInteger(128, value); }
  get legsAnimation(): number { return this.integer(132); }
  set legsAnimation(value: number) { this.setInteger(132, value); }
  get torsoAnimation(): number { return this.integer(136); }
  set torsoAnimation(value: number) { this.setInteger(136, value); }
  get areas(): AasLink | null { return this.linkHeap.decode(this.integer(140)); }
  set areas(value: AasLink | null) { this.setInteger(140, this.linkHeap.encode(value)); }
  get leaves(): number { return this.integer(144); }
  set leaves(value: number) { this.setInteger(144, value); }
}

function copyVector(value: Vec3): Vec3 { return vec3(value.x, value.y, value.z); }
function sameVector(left: Vec3, right: Vec3): boolean {
  return Math.fround(left.x) === right.x && Math.fround(left.y) === right.y && Math.fround(left.z) === right.z;
}
function copyInfo(value: AasEntityInfo): AasEntityInfo {
  return { valid: value.valid, type: value.type, flags: value.flags, lastUpdateTime: value.lastUpdateTime,
    updateInterval: value.updateInterval, number: value.number,
    origin: copyVector(value.origin), angles: copyVector(value.angles), oldOrigin: copyVector(value.oldOrigin),
    lastVisibleOrigin: copyVector(value.lastVisibleOrigin), mins: copyVector(value.mins), maxs: copyVector(value.maxs),
    groundEntity: value.groundEntity, solid: value.solid, modelIndex: value.modelIndex, modelIndex2: value.modelIndex2,
    frame: value.frame, event: value.event, eventParameter: value.eventParameter, powerups: value.powerups,
    weapon: value.weapon, legsAnimation: value.legsAnimation, torsoAnimation: value.torsoAnimation };
}
function emptyInfo(): AasEntityInfo {
  return { valid: false, type: 0, flags: 0, lastUpdateTime: 0, updateInterval: 0, number: 0,
    origin: vec3(0, 0, 0), angles: vec3(0, 0, 0), oldOrigin: vec3(0, 0, 0), lastVisibleOrigin: vec3(0, 0, 0),
    mins: vec3(0, 0, 0), maxs: vec3(0, 0, 0), groundEntity: 0, solid: 0, modelIndex: 0, modelIndex2: 0,
    frame: 0, event: 0, eventParameter: 0, powerups: 0, weapon: 0, legsAnimation: 0, torsoAnimation: 0 };
}

/** C abs takes int: truncate the source float, then reject only undefined conversions/negation. */
function nativeAbs(value: number): number {
  if (!(value >= -2147483648 && value < 2147483648)) {
    throw new RangeError("AAS_NearestEntity: source float-to-int conversion is undefined");
  }
  const integer = Math.trunc(value);
  if (integer === -2147483648) throw new RangeError("AAS_NearestEntity: source abs(INT_MIN) is undefined");
  return Math.abs(integer);
}

/** AAS_Setup allocation lifetime. AAS_LoadMap resets links, not these history records. */
export class AasEntityHistory {
  private readonly entities: readonly EntityRecord[];
  private readonly allocation: BotMemoryAllocation;

  constructor(capacity: number, readonly host: AasEntityHost, linkHeap: AasLinkHeap, memory = new BotMemory(),
    private readonly initialized: () => boolean = () => host.map().kind === "ready") {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 2147483647) {
      throw new RangeError("AAS entity capacity must be a nonnegative signed int");
    }
    this.allocation = memory.allocate(capacity * ENTITY_BYTES, "hunk", true);
    this.entities = Array.from({ length: capacity }, (_, number) => {
      const entity = new EntityRecord(this.allocation, number * ENTITY_BYTES, linkHeap);
      entity.number = number;
      return entity;
    });
  }

  get maxEntities(): number { return this.host.maxEntities; }

  private inRange(entity: number): boolean { return Number.isInteger(entity) && entity >= 0 && entity < this.maxEntities; }
  private record(entity: number): EntityRecord {
    const record = this.entities[entity];
    if (record === undefined) throw new RangeError(`AAS entity ${entity} would access outside the source entity allocation`);
    void this.allocation.bytes;
    return record;
  }

  update(entity: number, sourceState: BotEntityUpdate | null | (() => BotEntityUpdate | null)): number {
    const map = this.host.map();
    if (map.kind === "unloaded") {
      this.host.print(1, "AAS_UpdateEntity: not loaded\n");
      return 3;
    }
    const record = this.record(entity);
    const state = typeof sourceState === "function" ? sourceState() : sourceState;
    if (state === null) {
      map.spatial.unlinkFromAreas(record.areas);
      // be_aas_bspq3.c's unlink consumes the leaf pointer but does no work.
      void record.leaves;
      record.areas = null;
      record.leaves = 0;
      return 0;
    }
    record.updateInterval = Math.fround(Math.fround(this.host.time()) - record.lastUpdateTime);
    record.type = state.type;
    record.flags = state.flags;
    record.lastUpdateTime = Math.fround(this.host.time());
    record.lastVisibleOrigin = copyVector(record.origin);
    record.oldOrigin = copyVector(state.oldOrigin);
    record.solid = state.solid;
    record.groundEntity = state.groundEntity;
    record.modelIndex = state.modelIndex;
    record.modelIndex2 = state.modelIndex2;
    record.frame = state.frame;
    record.event = state.event;
    record.eventParameter = state.eventParameter;
    record.powerups = state.powerups;
    record.weapon = state.weapon;
    record.legsAnimation = state.legsAnimation;
    record.torsoAnimation = state.torsoAnimation;
    record.number = entity;
    record.valid = true;
    let relink = this.host.frameNumber() === 1;
    if (record.solid === 3) {
      if (!sameVector(state.angles, record.angles)) {
        record.angles = copyVector(state.angles);
        relink = true;
      }
      const model = map.spatial.host.modelBounds(record.modelIndex, record.angles);
      record.mins = copyVector(model.bounds.min);
      record.maxs = copyVector(model.bounds.max);
    } else if (record.solid === 2) {
      if (!sameVector(state.mins, record.mins) || !sameVector(state.maxs, record.maxs)) {
        record.mins = copyVector(state.mins);
        record.maxs = copyVector(state.maxs);
        relink = true;
      }
      record.angles = copyVector(state.angles);
    }
    if (!sameVector(state.origin, record.origin)) {
      record.origin = copyVector(state.origin);
      relink = true;
    }
    if (relink && entity !== 1022) {
      const bounds = { min: add3(record.mins, record.origin), max: add3(record.maxs, record.origin) };
      map.spatial.unlinkFromAreas(record.areas);
      record.areas = map.spatial.linkClientBounds(entity, bounds, 2);
      void record.leaves;
      // The pinned AAS_BSPLinkEntity returns NULL.
      record.leaves = 0;
    }
    return 0;
  }

  info(entity: number): AasEntityInfo {
    if (!this.initialized()) {
      this.host.print(4, "AAS_EntityInfo: aasworld not initialized\n");
      return emptyInfo();
    }
    if (!this.inRange(entity)) {
      this.host.print(4, `AAS_EntityInfo: entnum ${entity} out of range\n`);
      return emptyInfo();
    }
    return copyInfo(this.record(entity));
  }

  entityOrigin(entity: number): Vec3 {
    if (!this.inRange(entity)) {
      this.host.print(4, `AAS_EntityOrigin: entnum ${entity} out of range\n`);
      return vec3(0, 0, 0);
    }
    return copyVector(this.record(entity).origin);
  }

  entityModelIndex(entity: number): number {
    if (!this.inRange(entity)) { this.host.print(4, `AAS_EntityModelindex: entnum ${entity} out of range\n`); return 0; }
    return this.record(entity).modelIndex;
  }

  entityType(entity: number): number {
    if (!this.initialized()) return 0;
    if (!this.inRange(entity)) { this.host.print(4, `AAS_EntityType: entnum ${entity} out of range\n`); return 0; }
    return this.record(entity).type;
  }

  entityModelNum(entity: number): number {
    if (!this.initialized()) return 0;
    if (!this.inRange(entity)) { this.host.print(4, `AAS_EntityModelNum: entnum ${entity} out of range\n`); return 0; }
    return this.record(entity).modelIndex;
  }

  originOfMoverWithModelNum(model: number): Vec3 | null {
    for (let number = 0; number < this.maxEntities; number++) {
      const entity = this.record(number);
      if (entity.type === EntityType.ET_MOVER && entity.modelIndex === model) return copyVector(entity.origin);
    }
    return null;
  }

  entitySize(entity: number): Bounds | null {
    if (!this.initialized()) return null;
    if (!this.inRange(entity)) { this.host.print(4, `AAS_EntitySize: entnum ${entity} out of range\n`); return null; }
    const record = this.record(entity);
    return { min: copyVector(record.mins), max: copyVector(record.maxs) };
  }

  entityBspData(entity: number): AasEntityBspData {
    const record = this.record(entity);
    const origin = copyVector(record.origin), angles = copyVector(record.angles);
    const absoluteBounds = { min: add3(record.origin, record.mins), max: add3(record.origin, record.maxs) };
    if (record.modelIndex === -2147483648) throw new RangeError("AAS_EntityBSPData: source modelindex - 1 would overflow INT_MIN");
    return { origin, angles, absoluteBounds, solid: record.solid, modelNum: record.modelIndex - 1 };
  }

  /** Before replacing the outgoing map: forget heads, retain history and the old area's links. */
  resetEntityLinks(): void {
    for (let number = 0; number < this.maxEntities; number++) {
      const entity = this.record(number);
      entity.areas = null; entity.leaves = 0;
    }
  }

  entityAreas(entity: number): readonly number[] {
    const areas: number[] = [];
    for (let link = this.record(entity).areas; link !== null; link = link.nextArea) areas.push(link.area);
    return areas;
  }

  invalidateEntities(): void {
    for (let number = 0; number < this.maxEntities; number++) {
      const entity = this.record(number);
      entity.valid = false; entity.number = number;
    }
  }

  unlinkInvalidEntities(): void {
    const map = this.host.map();
    if (map.kind === "unloaded") return;
    for (let number = 0; number < this.maxEntities; number++) {
      const entity = this.record(number);
      if (!entity.valid) {
        map.spatial.unlinkFromAreas(entity.areas);
        entity.areas = null;
        void entity.leaves;
        entity.leaves = 0;
      }
    }
  }

  nearestEntity(origin: Vec3, modelIndex: number): number {
    origin = copyVector(origin);
    let bestEntity = 0, bestDistance = 99999;
    for (let number = 0; number < this.maxEntities; number++) {
      const entity = this.record(number);
      if (entity.modelIndex !== modelIndex) continue;
      const direction = sub3(entity.origin, origin);
      if (nativeAbs(direction.x) < 40 && nativeAbs(direction.y) < 40) {
        const distance = length3(direction);
        if (distance < bestDistance) { bestDistance = distance; bestEntity = number; }
      }
    }
    return bestEntity;
  }

  bestReachableEntityArea(entity: number): number {
    this.record(entity);
    const map = this.host.map();
    void this.allocation.bytes;
    return map.kind === "unloaded" ? 0 : map.spatial.bestReachableLinkArea(this.entityAreas(entity));
  }

  nextEntity(after: number): number {
    if (this.host.map().kind === "unloaded") return 0;
    if (!Number.isInteger(after) || after < -2147483648 || after > 2147483647) {
      throw new RangeError("AAS_NextEntity: predecessor must be a signed int");
    }
    if (after === 2147483647) throw new RangeError("AAS_NextEntity: source preincrement would overflow INT_MAX");
    for (let entity = after < 0 ? 0 : after + 1; entity < this.maxEntities; entity++) {
      if (this.record(entity).valid) return entity;
    }
    return 0;
  }
}
