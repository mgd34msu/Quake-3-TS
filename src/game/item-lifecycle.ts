// Ported from id Software's code/game/g_items.c: item registration, Touch_Item,
// RespawnItem, FinishSpawningItem, and G_SpawnItem.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, Holdable, ItemType, MissionpackStatIndex, PersistentIndex,
  Powerup, statSchema, Weapon } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { canItemBeGrabbed, findItem, findItemForWeapon, itemList } from "../shared/items.ts";
import type { ItemDefinition, PlayerInventory } from "../shared/items.ts";
import { ENTITYNUM_NONE } from "../shared/player-state.ts";
import type { MovementTrace } from "../shared/slide-move.ts";
import { pickupItem } from "./item-pickup.ts";
import type { ItemPickupContext } from "./item-pickup.ts";
import { EntityPool, setOrigin } from "./entities.ts";
import { gameFormat } from "./format.ts";
import type { GameRandom } from "./numeric.ts";
import type { SpawnVariables } from "./spawn.ts";
import { GameFlags } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";

const CS_ITEMS = 27;
const CONTENTS_SOLID = 0x1;
const CONTENTS_TRIGGER = 0x40000000;
const EF_NODRAW = 0x80;
const ITEM_RADIUS = 15;
const FRAME_TIME = 100;

/** Only the two GameRandom operations called by these source functions. */
export type GameItemRandom = Pick<GameRandom, "rand" | "random">;

export type SetItemsConfigstring = (index: 27, value: string) => void;

/** Per-level equivalent of itemRegistered[MAX_ITEMS]. */
export class ItemRegistry {
  readonly #registered: Uint8Array;

  constructor(readonly product: Product) {
    this.#registered = new Uint8Array(itemList(product).length);
  }

  register(item: ItemDefinition): void {
    const index = itemList(this.product).indexOf(item);
    if (index < 0) throw new RangeError(`Registered item does not belong to ${this.product}`);
    this.#registered[index] = 1;
  }

  isRegistered(item: ItemDefinition): boolean {
    const index = itemList(this.product).indexOf(item);
    if (index < 0) throw new RangeError(`Registered item does not belong to ${this.product}`);
    return this.#registered[index] !== 0;
  }

  clear(gameType: number): void {
    this.#registered.fill(0);
    this.register(findItemForWeapon(this.product, Weapon.WP_MACHINEGUN));
    this.register(findItemForWeapon(this.product, Weapon.WP_GAUNTLET));
    if (this.product !== "missionpack" || gameType !== GameType.GT_HARVESTER) return;
    for (const pickupName of ["Red Cube", "Blue Cube"]) {
      const item = findItem(this.product, pickupName);
      if (item === null) throw new Error(`Required item ${pickupName} is missing`);
      this.register(item);
    }
  }

  save(setConfigstring: SetItemsConfigstring, log: (message: string) => void): number {
    let value = "";
    let count = 0;
    for (const registered of this.#registered) {
      if (registered !== 0) count++;
      value += registered !== 0 ? "1" : "0";
    }
    log(`${count} items registered\n`);
    setConfigstring(CS_ITEMS, value);
    return count;
  }
}

export interface ItemLifecycleContext {
  readonly entities: EntityPool;
  readonly world: ServerWorld;
  readonly product: Product;
  readonly gameType: number;
  readonly weaponRespawnSeconds: number;
  readonly teamWeaponRespawnSeconds: number;
  readonly handicapForClient: (clientNum: number) => string;
  readonly teamPickup: (item: GameEntity, player: GameEntity) => number;
  readonly useTargets: (item: GameEntity, activator: GameEntity) => void;
  readonly soundIndex: (path: string) => number;
  readonly random: GameItemRandom;
  readonly registry: ItemRegistry;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
}

function gameTime(context: ItemLifecycleContext): number {
  const time = context.entities.options.time();
  if (!Number.isInteger(time) || time < -2_147_483_648 || time > 2_147_483_647) {
    throw new RangeError("Item lifecycle time must be a signed 32-bit millisecond value");
  }
  return time;
}

function checkContext(context: ItemLifecycleContext): void {
  if (context.entities.options.product !== context.product || context.registry.product !== context.product) {
    throw new Error("Item lifecycle product does not match its entity pool and registry");
  }
}

function requireOwned(context: ItemLifecycleContext, entity: GameEntity): void {
  if (context.entities.get(entity.slot) !== entity) {
    throw new Error("Item lifecycle entity does not belong to its entity pool or was replaced");
  }
}

function requireItem(context: ItemLifecycleContext, entity: GameEntity): ItemDefinition {
  const item = entity.item;
  if (item === null || itemList(context.product).indexOf(item) < 1) {
    throw new Error(`Item entity does not contain a ${context.product} item definition`);
  }
  return item;
}

function tableIndex(context: ItemLifecycleContext, item: ItemDefinition): number {
  const index = itemList(context.product).indexOf(item);
  if (index < 1) throw new RangeError(`Item does not belong to the ${context.product} item table`);
  return index;
}

function requirePublishedItem(context: ItemLifecycleContext, entity: GameEntity): ItemDefinition {
  const item = requireItem(context, entity);
  if (entity.s.modelindex !== tableIndex(context, item)) {
    throw new Error("Item entity model index does not match its item definition");
  }
  return item;
}

function inventory(client: GameClient): PlayerInventory {
  const ps = client.ps;
  const schema = statSchema(ps.product);
  const shared = {
    health: ps.stats.get(schema.health),
    armor: ps.stats.get(schema.armor),
    maxHealth: ps.stats.get(schema.maxHealth),
    holdableItem: ps.stats.get(schema.holdableItem),
    team: ps.persistant.get(PersistentIndex.PERS_TEAM),
    ammo: (weapon: Weapon): number => ps.ammo.get(weapon),
    powerup: (powerup: Powerup): number => ps.powerups.get(powerup),
  };
  return ps.product === "baseq3"
    ? { ...shared, product: "baseq3" }
    : { ...shared, product: "missionpack", persistentPowerupIndex: ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP) };
}

function unitRandom(random: GameItemRandom): number {
  const value = random.random();
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("Game random() must return a value within [0, 1]");
  }
  return Math.fround(value);
}

function crandom(random: GameItemRandom): number {
  return Math.fround(2 * Math.fround(unitRandom(random) - 0.5));
}

function randomInteger(random: GameItemRandom): number {
  const value = random.rand();
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Game rand() must return a nonnegative safe integer");
  return value;
}

function pickupContext(context: ItemLifecycleContext, time: number): ItemPickupContext {
  return {
    gameType: context.gameType,
    weaponRespawnSeconds: context.weaponRespawnSeconds,
    teamWeaponRespawnSeconds: context.teamWeaponRespawnSeconds,
    time,
    clients: context.entities.clients.slice(0, context.entities.maxClients),
    traceSolidLine: (start: Vec3, end: Vec3) => context.world.trace({
      start, end, shape: { kind: "point" }, mask: CONTENTS_SOLID, passEntityNum: ENTITYNUM_NONE,
    }),
    handicapForClient: context.handicapForClient,
  };
}

function teamMember(context: ItemLifecycleContext, entity: GameEntity): GameEntity {
  if (entity.team === null) return entity;
  const master = entity.teammaster;
  if (master === null) throw new Error("RespawnItem: bad teammaster");
  let count = 0;
  let cursor: GameEntity | null = master;
  while (cursor !== null) {
    requireOwned(context, cursor);
    count++;
    if (count > context.entities.numEntities) throw new Error("RespawnItem: cyclic teamchain");
    cursor = cursor.teamchain;
  }
  const choice = randomInteger(context.random) % count;
  cursor = master;
  for (let index = 0; index < choice; index++) {
    if (cursor === null) throw new Error("RespawnItem: broken teamchain");
    cursor = cursor.teamchain;
  }
  if (cursor === null) throw new Error("RespawnItem: broken teamchain");
  return cursor;
}

function spawnRespawnSound(context: ItemLifecycleContext, entity: GameEntity, path: string): void {
  const event = entity.speed !== 0 ? EntityEvent.EV_GENERAL_SOUND : EntityEvent.EV_GLOBAL_SOUND;
  const temporary = context.entities.tempEntity(entity.s.pos.base, event);
  temporary.s.eventParm = context.soundIndex(path);
  temporary.r.svFlags |= ServerEntityFlags.BROADCAST;
}

/** RespawnItem may select a random member of an item team before restoring visibility. */
export function respawnItem(entity: GameEntity, context: ItemLifecycleContext): void {
  checkContext(context);
  requireOwned(context, entity);
  const selected = teamMember(context, entity);
  const item = requirePublishedItem(context, selected);
  selected.r.contents = CONTENTS_TRIGGER;
  selected.s.eFlags &= ~EF_NODRAW;
  selected.r.svFlags &= ~ServerEntityFlags.NOCLIENT;
  context.entities.options.link(selected);

  if (item.type === ItemType.IT_POWERUP) {
    spawnRespawnSound(context, selected, "sound/items/poweruprespawn.wav");
  }
  if (item.type === ItemType.IT_HOLDABLE && item.tag === Holdable.HI_KAMIKAZE) {
    spawnRespawnSound(context, selected, "sound/items/kamikazerespawn.wav");
  }
  context.entities.addEvent(selected, EntityEvent.EV_ITEM_RESPAWN, 0);
  selected.nextthink = 0;
}

/** Touch_Item validates eligibility, applies pickup rules, emits events, and hides or schedules the item. */
export function touchItem(entity: GameEntity, other: GameEntity, _trace: MovementTrace, context: ItemLifecycleContext): void {
  checkContext(context);
  requireOwned(context, entity);
  requireOwned(context, other);
  const client = other.client;
  if (client === null || other.health < 1) return;
  if (client.ps.product !== context.product) throw new Error("Item touch player product does not match lifecycle product");
  const item = requirePublishedItem(context, entity);
  const pickupState = { modelIndex: entity.s.modelindex, modelIndex2: entity.s.modelindex2, generic1: entity.s.generic1 };
  if (!canItemBeGrabbed(context.gameType, pickupState, inventory(client))) return;
  const className = item.className;
  if (className === null) throw new Error("Pickup item has no classname");
  context.log(`Item: ${other.s.number} ${className}\n`);

  let predict = client.pers.predictItemPickup;
  const now = gameTime(context);
  let respawn: number;
  if (item.type === ItemType.IT_TEAM) respawn = context.teamPickup(entity, other);
  else {
    respawn = pickupItem(entity, other, pickupContext(context, now));
    if (item.type === ItemType.IT_POWERUP) predict = false;
  }
  if (respawn === 0) return;

  if (predict) context.entities.addPredictableEvent(other, EntityEvent.EV_ITEM_PICKUP, entity.s.modelindex);
  else context.entities.addEvent(other, EntityEvent.EV_ITEM_PICKUP, entity.s.modelindex);

  if (item.type === ItemType.IT_POWERUP || item.type === ItemType.IT_TEAM) {
    const temporary = context.entities.tempEntity(entity.s.pos.base, EntityEvent.EV_GLOBAL_ITEM_PICKUP);
    temporary.s.eventParm = entity.s.modelindex;
    if (entity.speed === 0) temporary.r.svFlags |= ServerEntityFlags.BROADCAST;
    else {
      temporary.r.svFlags |= ServerEntityFlags.SINGLECLIENT;
      temporary.r.singleClient = other.s.number;
    }
  }

  context.useTargets(entity, other);
  if (entity.wait === -1) {
    entity.r.svFlags |= ServerEntityFlags.NOCLIENT;
    entity.s.eFlags |= EF_NODRAW;
    entity.r.contents = 0;
    entity.unlinkAfterEvent = true;
    return;
  }

  if (entity.wait !== 0) respawn = qvmFloatToInt(entity.wait);
  if (entity.random !== 0) {
    respawn = qvmFloatToInt(Math.fround(Math.fround(respawn) + Math.fround(crandom(context.random) * entity.random)));
    if (respawn < 1) respawn = 1;
  }
  if ((entity.flags & GameFlags.DROPPED_ITEM) !== 0) entity.freeAfterEvent = true;
  entity.r.svFlags |= ServerEntityFlags.NOCLIENT;
  entity.s.eFlags |= EF_NODRAW;
  entity.r.contents = 0;
  if (respawn <= 0) {
    entity.nextthink = 0;
    entity.think = null;
  } else {
    entity.nextthink = (now + Math.imul(respawn, 1_000)) | 0;
    entity.think = self => { respawnItem(self, context); };
  }
  context.entities.options.link(entity);
}

function sourceFloatSchedule(time: number, seconds: number): number {
  const milliseconds = Math.fround(Math.fround(seconds) * 1_000);
  return qvmFloatToInt(Math.fround(Math.fround(time) + milliseconds));
}

/** FinishSpawningItem installs item callbacks and either suspends, plants, hides, delays, or links the item. */
export function finishSpawningItem(entity: GameEntity, context: ItemLifecycleContext): void {
  checkContext(context);
  requireOwned(context, entity);
  const item = requireItem(context, entity);
  entity.r.mins = vec3(-ITEM_RADIUS, -ITEM_RADIUS, -ITEM_RADIUS);
  entity.r.maxs = vec3(ITEM_RADIUS, ITEM_RADIUS, ITEM_RADIUS);
  entity.s.eType = EntityType.ET_ITEM;
  entity.s.modelindex = tableIndex(context, item);
  entity.s.modelindex2 = 0;
  entity.r.contents = CONTENTS_TRIGGER;
  entity.touch = (self, other, trace) => { touchItem(self, other, trace, context); };
  entity.use = self => { respawnItem(self, context); };

  if ((entity.spawnflags & 1) !== 0) {
    setOrigin(entity, entity.s.origin);
  } else {
    const destination = vec3(entity.s.origin.x, entity.s.origin.y, entity.s.origin.z - 4_096);
    const trace = context.world.trace({
      start: entity.s.origin,
      end: destination,
      shape: { kind: "box", mins: entity.r.mins, maxs: entity.r.maxs },
      passEntityNum: entity.slot,
      mask: CONTENTS_SOLID,
    });
    if (trace.solidity !== "clear") {
      context.warn(gameFormat("FinishSpawningItem: %s startsolid at %s\n",
        [entity.classname, context.entities.utilities.vtos(entity.s.origin).readString()]));
      context.entities.free(entity);
      return;
    }
    entity.s.groundEntityNum = trace.entityNum;
    setOrigin(entity, trace.end);
  }

  if ((entity.flags & GameFlags.TEAMSLAVE) !== 0 || entity.targetname !== null) {
    entity.s.eFlags |= EF_NODRAW;
    entity.r.contents = 0;
    return;
  }

  if (item.type === ItemType.IT_POWERUP) {
    const delay = Math.fround(45 + Math.fround(crandom(context.random) * 15));
    entity.s.eFlags |= EF_NODRAW;
    entity.r.contents = 0;
    entity.nextthink = sourceFloatSchedule(gameTime(context), delay);
    entity.think = self => { respawnItem(self, context); };
    return;
  }
  context.entities.options.link(entity);
}

/** G_SpawnItem reads item spawn keys, registers the item, and schedules third-frame placement. */
export function spawnItem(
  entity: GameEntity,
  item: ItemDefinition,
  variables: SpawnVariables,
  isDisabled: () => boolean,
  context: ItemLifecycleContext,
): void {
  checkContext(context);
  requireOwned(context, entity);
  tableIndex(context, item);
  entity.random = variables.float("random", "0").value;
  entity.wait = variables.float("wait", "0").value;
  context.registry.register(item);
  if (isDisabled()) return;

  entity.item = item;
  entity.nextthink = (gameTime(context) + FRAME_TIME * 2) | 0;
  entity.think = self => { finishSpawningItem(self, context); };
  entity.physicsBounce = Math.fround(0.5);
  if (item.type === ItemType.IT_POWERUP) {
    context.soundIndex("sound/items/poweruprespawn.wav");
    entity.speed = variables.float("noglobalsound", "0").value;
  }
  if (context.product === "missionpack" && item.type === ItemType.IT_PERSISTANT_POWERUP) {
    entity.s.generic1 = entity.spawnflags;
  }
}
