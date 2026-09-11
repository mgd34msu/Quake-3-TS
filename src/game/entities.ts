// Ported from id Software's code/game/g_utils.c and g_main.c event/think timing.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { EntityType, EVENT_VALID_MSEC, EV_EVENT_BIT1, EV_EVENT_BITS } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../shared/player-state.ts";
import type { PredictableEvent, PredictableEventDebug } from "../shared/player-state.ts";
import { TrajectoryType } from "../shared/trajectory.ts";
import { GameClient, GameEntity, MAX_CLIENTS, MAX_GENTITIES } from "./state.ts";
import { gameFormat } from "./format.ts";
import { GameUtilityScratch } from "./utilities.ts";

export interface EntityPoolOptions {
  readonly eventDebug?: PredictableEventDebug;
  readonly product: Product;
  readonly maxClients: number;
  readonly mapStartTime: number;
  readonly time: () => number;
  readonly print: (message: string) => void;
  readonly link: (entity: GameEntity) => void;
  /** Resolve the stable entity.slot, since G_FreeEntity clears s.number. */
  readonly unlink: (entity: GameEntity) => void;
}

/** Result of the event-lifetime section of G_RunFrame, before entity-type dispatch. */
export type EntityEventStatus = "inactive" | "active" | "waiting" | "freed";

function checkTime(time: number): number {
  if (!Number.isInteger(time) || time < -2147483648 || time > 2147483647) {
    throw new RangeError("Game time must be a signed 32-bit millisecond value");
  }
  return time;
}

/** G_InitGentity changes only these four fields; it does not memset the record. */
export function initGameEntity(entity: GameEntity): void {
  entity.inuse = true;
  entity.classname = "noclass";
  entity.s.number = entity.slot;
  entity.r.ownerNum = ENTITYNUM_NONE;
}

/** G_SetOrigin stores a fixed trajectory and current collision origin; linking is separate. */
export function setOrigin(entity: GameEntity, origin: Vec3): void {
  entity.s.pos = { type: TrajectoryType.TR_STATIONARY, time: 0, duration: 0,
    base: vec3(origin.x, origin.y, origin.z), delta: vec3(0, 0, 0) };
  entity.r.currentOrigin = vec3(origin.x, origin.y, origin.z);
}

/** G_RunThink clears the schedule before calling a callback that may reschedule itself. */
export function runThink(entity: GameEntity, time: number): void {
  const thinkTime = Math.fround(entity.nextthink);
  if (thinkTime <= 0 || thinkTime > time) return;
  entity.nextthink = 0;
  if (entity.think === null) throw new Error("NULL ent->think");
  entity.think(entity);
}

/** Loaded-module g_entities/g_clients storage. Construction has no link/unlink effects. */
export class EntityPool {
  readonly clients: readonly GameClient[];
  readonly utilities: GameUtilityScratch;
  readonly #entities: readonly GameEntity[];
  #numEntities = MAX_CLIENTS;
  #maxClients: number;

  constructor(readonly options: EntityPoolOptions) {
    if (!Number.isInteger(options.maxClients) || options.maxClients < 1 || options.maxClients > MAX_CLIENTS) {
      throw new RangeError("Configured clients must be within 1..64");
    }
    checkTime(options.mapStartTime);
    this.#maxClients = options.maxClients;
    this.utilities = new GameUtilityScratch(options.print);
    this.clients = Array.from({ length: MAX_CLIENTS }, () => new GameClient(options.product));
    if (options.eventDebug !== undefined) {
      for (const client of this.clients) client.ps.setEventDebug(options.eventDebug);
    }
    this.#entities = Array.from({ length: MAX_GENTITIES }, (_, index) => new GameEntity(index));
    for (let index = 0; index < options.maxClients; index++) this.at(index).client = this.clientAt(index);
  }

  get numEntities(): number { return this.#numEntities; }
  get maxClients(): number { return this.#maxClients; }

  /** These counts live in level, separately from the retained entity/client arrays. */
  clearLevel(): void { this.#numEntities = 0; this.#maxClients = 0; }

  clearEntities(): void {
    for (const entity of this.#entities) {
      const fresh = new GameEntity(entity.slot), { s, r } = entity;
      s.copyFrom(fresh.s); Object.assign(r, fresh.r);
      Object.assign(entity, fresh, { s, r });
    }
  }

  initializeClients(maxClients: number): void {
    if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > MAX_CLIENTS) {
      throw new RangeError("Configured clients must be within 1..64");
    }
    this.#maxClients = maxClients;
    for (const client of this.clients) {
      const fresh = new GameClient(this.options.product), { ps, pers, sess, ammoTimes } = client;
      const teamState = pers.teamState;
      ps.copyFrom(fresh.ps);
      Object.assign(teamState, fresh.pers.teamState);
      Object.assign(pers, fresh.pers, { teamState }); Object.assign(sess, fresh.sess);
      for (let index = 0; index < ammoTimes.length; index++) ammoTimes.set(index, 0);
      Object.assign(client, fresh, { ps, pers, sess, ammoTimes });
    }
    for (let index = 0; index < maxClients; index++) this.at(index).client = this.clientAt(index);
    this.#numEntities = MAX_CLIENTS;
  }

  get(number: number): GameEntity | undefined { return this.#entities[number]; }

  at(number: number): GameEntity {
    const entity = this.get(number);
    if (entity === undefined) throw new RangeError(`Game entity ${number} is unavailable`);
    return entity;
  }

  clientAt(number: number): GameClient {
    const client = this.clients[number];
    if (client === undefined) throw new RangeError(`Game client ${number} is unavailable`);
    return client;
  }

  private owned(entity: GameEntity): void {
    if (this.get(entity.slot) !== entity) throw new Error("Game entity does not belong to this pool");
  }

  private initializeSlot(slot: number): GameEntity {
    // g_entities is a fixed array: parent/enemy/target pointers survive reuse.
    const entity = this.at(slot);
    initGameEntity(entity);
    return entity;
  }

  spawn(): GameEntity {
    const now = checkTime(this.options.time());
    for (let index = MAX_CLIENTS; index < this.#numEntities; index++) {
      const entity = this.at(index);
      if (entity.inuse) continue;
      if (entity.freetime > ((this.options.mapStartTime + 2000) | 0) && ((now - entity.freetime) | 0) < 1000) continue;
      return this.initializeSlot(index);
    }
    // In this baseline G_Spawn tests MAX_GENTITIES before its forced pass,
    // but stops growth at ENTITYNUM_MAX_NORMAL. The forced pass is unreachable.
    if (this.#numEntities === ENTITYNUM_WORLD) {
      for (let index = 0; index < MAX_GENTITIES; index++) {
        this.options.print(gameFormat("%4i: %s\n", [index, this.at(index).classname]));
      }
      throw new Error("G_Spawn: no free entities");
    }
    const slot = this.#numEntities;
    this.#numEntities++;
    return this.initializeSlot(slot);
  }

  /** G_EntitiesFree only searches opened non-client slots, ignoring the cooldown. */
  entitiesFree(): boolean {
    for (let index = MAX_CLIENTS; index < this.#numEntities; index++) {
      if (!this.at(index).inuse) return true;
    }
    return false;
  }

  free(entity: GameEntity): void {
    this.owned(entity);
    this.options.unlink(entity);
    if (entity.neverFree) return;
    const now = checkTime(this.options.time());
    // Preserve the slot pointer while clearing its fields, including the shared link state.
    Object.assign(entity, new GameEntity(entity.slot));
    entity.classname = "freed";
    entity.freetime = now;
  }

  tempEntity(origin: Vec3, event: number): GameEntity {
    const entity = this.spawn();
    entity.s.eType = EntityType.ET_EVENTS + event;
    entity.classname = "tempEntity";
    entity.eventTime = checkTime(this.options.time());
    entity.freeAfterEvent = true;
    // g_utils.c uses the integer-conversion SnapVector macro, not Sys_SnapVector.
    setOrigin(entity, vec3(qvmFloatToInt(origin.x), qvmFloatToInt(origin.y), qvmFloatToInt(origin.z)));
    this.options.link(entity);
    return entity;
  }

  addPredictableEvent(entity: GameEntity, event: number, parameter = 0): PredictableEvent | null {
    this.owned(entity);
    return entity.client === null ? null : entity.client.ps.addEvent(event, parameter);
  }

  addEvent(entity: GameEntity, event: number, parameter = 0): void {
    this.owned(entity);
    if (event === 0) {
      this.options.print(gameFormat("G_AddEvent: zero event added for entity %i\n", [entity.s.number]));
      return;
    }
    const now = checkTime(this.options.time());
    if (entity.client !== null) {
      const ps = entity.client.ps;
      const bits = ((ps.externalEvent & EV_EVENT_BITS) + EV_EVENT_BIT1) & EV_EVENT_BITS;
      ps.externalEvent = event | bits;
      ps.externalEventParm = parameter;
      ps.externalEventTime = now;
    } else {
      const bits = ((entity.s.event & EV_EVENT_BITS) + EV_EVENT_BIT1) & EV_EVENT_BITS;
      entity.s.event = event | bits;
      entity.s.eventParm = parameter;
    }
    entity.eventTime = now;
  }

  /** Caller still owns G_RunFrame's missile/item/mover/client dispatch. */
  expireEvents(entity: GameEntity): EntityEventStatus {
    this.owned(entity);
    if (!entity.inuse) return "inactive";
    if (((checkTime(this.options.time()) - entity.eventTime) | 0) > EVENT_VALID_MSEC) {
      if (entity.s.event !== 0) {
        entity.s.event = 0;
        if (entity.client !== null) entity.client.ps.externalEvent = 0;
      }
      if (entity.freeAfterEvent) { this.free(entity); return entity.inuse ? "waiting" : "freed"; }
      if (entity.unlinkAfterEvent) {
        entity.unlinkAfterEvent = false;
        this.options.unlink(entity);
      }
    }
    return entity.freeAfterEvent ? "waiting" : "active";
  }
}
