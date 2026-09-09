// Ported from id Software's code/game/g_items.c pickup functions.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { GameType, Holdable, ItemType, MissionpackStatIndex, PersistentIndex,
  Powerup, statSchema, Weapon } from "../shared/definitions.ts";
import { itemAt, itemList } from "../shared/items.ts";
import type { ItemDefinition } from "../shared/items.ts";
import { dot3, length3, normalize3, sub3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { Vec3 } from "../core/math.ts";
import { ConnectionState, GameFlags } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";
import { gameAtof } from "./numeric.ts";

const RESPAWN_AMMO = 40;
const RESPAWN_ARMOR = 25;
const RESPAWN_HEALTH = 35;
const RESPAWN_HOLDABLE = 60;
const RESPAWN_MEGAHEALTH = 35;
const RESPAWN_POWERUP = 120;
const EF_KAMIKAZE = 0x200;
const PLAYEREVENT_DENIED_REWARD = 0x0001;

interface PickupInput {
  readonly client: GameClient;
  readonly item: ItemDefinition;
  readonly itemIndex: number;
}

export interface WeaponPickupContext {
  readonly gameType: number;
  readonly weaponRespawnSeconds: number;
  readonly teamWeaponRespawnSeconds: number;
}

export interface PowerupSightTrace {
  readonly fraction: number;
}

export interface PowerupPickupContext {
  readonly time: number;
  readonly gameType: number;
  readonly clients: readonly GameClient[];
  readonly traceSolidLine: (start: Vec3, end: Vec3) => PowerupSightTrace;
}

export interface ItemPickupContext extends WeaponPickupContext, PowerupPickupContext {
  readonly handicapForClient: (clientNum: number) => string;
}

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Item pickup requires a client entity");
  return entity.client;
}

function pickupInput(itemEntity: GameEntity, other: GameEntity): PickupInput {
  const client = clientOf(other);
  const item = itemEntity.item;
  if (item === null) throw new Error("Item pickup requires an item definition");
  const itemIndex = itemList(client.ps.product).indexOf(item);
  if (itemIndex < 0) throw new Error(`Item does not belong to ${client.ps.product}`);
  return { client, item, itemIndex };
}

function hasGuard(client: GameClient): boolean {
  if (client.ps.product === "baseq3") return false;
  const itemIndex = client.ps.stats.get(MissionpackStatIndex.STAT_PERSISTANT_POWERUP);
  return itemAt("missionpack", itemIndex).tag === Powerup.PW_GUARD;
}

function addAmmoTo(client: GameClient, weapon: Weapon, count: number): void {
  const ammo = client.ps.ammo;
  const total = (ammo.get(weapon) + count) | 0;
  ammo.set(weapon, total > 200 ? 200 : total);
}

export function addAmmo(other: GameEntity, weapon: Weapon, count: number): void {
  addAmmoTo(clientOf(other), weapon, count);
}

function pickupAmmoFrom(itemEntity: GameEntity, client: GameClient, item: ItemDefinition): number {
  if (item.type !== ItemType.IT_AMMO) throw new Error("Pickup_Ammo requires an ammo item");
  const quantity = itemEntity.count !== 0 ? itemEntity.count : item.quantity;
  addAmmoTo(client, item.tag, quantity);
  return RESPAWN_AMMO;
}

export function pickupAmmo(itemEntity: GameEntity, other: GameEntity): number {
  const input = pickupInput(itemEntity, other);
  return pickupAmmoFrom(itemEntity, input.client, input.item);
}

function pickupWeaponFrom(
  itemEntity: GameEntity,
  client: GameClient,
  item: ItemDefinition,
  context: WeaponPickupContext,
): number {
  if (item.type !== ItemType.IT_WEAPON) throw new Error("Pickup_Weapon requires a weapon item");
  let quantity: number;
  if (itemEntity.count < 0) {
    quantity = 0;
  } else {
    quantity = itemEntity.count !== 0 ? itemEntity.count : item.quantity;
    if ((itemEntity.flags & GameFlags.DROPPED_ITEM) === 0 && context.gameType !== GameType.GT_TEAM) {
      const currentAmmo = client.ps.ammo.get(item.tag);
      quantity = currentAmmo < quantity ? quantity - currentAmmo : 1;
    }
  }

  const weapons = statSchema(client.ps.product).weapons;
  client.ps.stats.set(weapons, client.ps.stats.get(weapons) | (1 << item.tag));
  addAmmoTo(client, item.tag, quantity);
  if (item.tag === Weapon.WP_GRAPPLING_HOOK) client.ps.ammo.set(item.tag, -1);
  return context.gameType === GameType.GT_TEAM
    ? context.teamWeaponRespawnSeconds
    : context.weaponRespawnSeconds;
}

export function pickupWeapon(itemEntity: GameEntity, other: GameEntity, context: WeaponPickupContext): number {
  const input = pickupInput(itemEntity, other);
  return pickupWeaponFrom(itemEntity, input.client, input.item, context);
}

function pickupHealthFrom(itemEntity: GameEntity, client: GameClient, item: ItemDefinition, other: GameEntity): number {
  if (item.type !== ItemType.IT_HEALTH) throw new Error("Pickup_Health requires a health item");
  const maxHealth = client.ps.stats.get(statSchema(client.ps.product).maxHealth);
  const limit = hasGuard(client) || (item.quantity !== 5 && item.quantity !== 100) ? maxHealth : maxHealth * 2;
  const quantity = itemEntity.count !== 0 ? itemEntity.count : item.quantity;
  other.health = (other.health + quantity) | 0;
  if (other.health > limit) other.health = limit;
  client.ps.stats.set(statSchema(client.ps.product).health, other.health);
  return item.quantity === 100 ? RESPAWN_MEGAHEALTH : RESPAWN_HEALTH;
}

export function pickupHealth(itemEntity: GameEntity, other: GameEntity): number {
  const input = pickupInput(itemEntity, other);
  return pickupHealthFrom(itemEntity, input.client, input.item, other);
}

function pickupArmorFrom(client: GameClient, item: ItemDefinition): number {
  if (item.type !== ItemType.IT_ARMOR) throw new Error("Pickup_Armor requires an armor item");
  const schema = statSchema(client.ps.product);
  const armor = (client.ps.stats.get(schema.armor) + item.quantity) | 0;
  const maxHealth = client.ps.stats.get(schema.maxHealth);
  const limit = hasGuard(client) ? maxHealth : maxHealth * 2;
  client.ps.stats.set(schema.armor, armor > limit ? limit : armor);
  return RESPAWN_ARMOR;
}

export function pickupArmor(itemEntity: GameEntity, other: GameEntity): number {
  const input = pickupInput(itemEntity, other);
  return pickupArmorFrom(input.client, input.item);
}

function pickupHoldableFrom(client: GameClient, item: ItemDefinition, itemIndex: number): number {
  if (item.type !== ItemType.IT_HOLDABLE) throw new Error("Pickup_Holdable requires a holdable item");
  client.ps.stats.set(statSchema(client.ps.product).holdableItem, itemIndex);
  if (item.tag === Holdable.HI_KAMIKAZE) client.ps.eFlags |= EF_KAMIKAZE;
  return RESPAWN_HOLDABLE;
}

export function pickupHoldable(itemEntity: GameEntity, other: GameEntity): number {
  const input = pickupInput(itemEntity, other);
  return pickupHoldableFrom(input.client, input.item, input.itemIndex);
}

function sourceHandicap(rawHandicap: string): number {
  const parsed = gameAtof(rawHandicap);
  return parsed <= 0 || parsed > 100 ? 100 : parsed;
}

function pickupPersistentPowerupFrom(
  itemEntity: GameEntity,
  client: GameClient,
  item: ItemDefinition,
  itemIndex: number,
  readHandicap: () => string,
  other: GameEntity,
): number {
  if (client.ps.product !== "missionpack") throw new Error("Persistent powerups require missionpack player state");
  if (item.type !== ItemType.IT_PERSISTANT_POWERUP) {
    throw new Error("Pickup_PersistantPowerup requires a persistent powerup item");
  }
  client.ps.stats.set(MissionpackStatIndex.STAT_PERSISTANT_POWERUP, itemIndex);
  client.persistantPowerup = itemEntity;
  const handicap = sourceHandicap(readHandicap());
  const playerMaximum = Math.trunc(handicap);

  switch (item.tag) {
    case Powerup.PW_GUARD: {
      const maximum = Math.trunc(2 * handicap);
      other.health = maximum;
      client.ps.stats.set(MissionpackStatIndex.STAT_HEALTH, maximum);
      client.ps.stats.set(MissionpackStatIndex.STAT_MAX_HEALTH, maximum);
      client.ps.stats.set(MissionpackStatIndex.STAT_ARMOR, maximum);
      client.pers.maxHealth = maximum;
      break;
    }
    case Powerup.PW_SCOUT:
      client.pers.maxHealth = playerMaximum;
      client.ps.stats.set(MissionpackStatIndex.STAT_ARMOR, 0);
      break;
    case Powerup.PW_DOUBLER:
      client.pers.maxHealth = playerMaximum;
      break;
    case Powerup.PW_AMMOREGEN:
      client.pers.maxHealth = playerMaximum;
      for (let index = 0; index < client.ammoTimes.length; index++) client.ammoTimes.set(index, 0);
      break;
    default:
      client.pers.maxHealth = playerMaximum;
      break;
  }
  return -1;
}

export function pickupPersistentPowerup(itemEntity: GameEntity, other: GameEntity, rawHandicap: string): number {
  const input = pickupInput(itemEntity, other);
  return pickupPersistentPowerupFrom(itemEntity, input.client, input.item, input.itemIndex, () => rawHandicap, other);
}

function pickupPowerupFrom(
  itemEntity: GameEntity,
  client: GameClient,
  item: ItemDefinition,
  context: PowerupPickupContext,
): number {
  if (item.type !== ItemType.IT_POWERUP) throw new Error("Pickup_Powerup requires a powerup item");
  if (!Number.isInteger(context.time) || context.time < -2_147_483_648 || context.time > 2_147_483_647) {
    throw new RangeError("Powerup pickup time must be a signed 32-bit millisecond value");
  }
  let expiration = client.ps.powerups.get(item.tag);
  if (expiration === 0) expiration = context.time - (context.time % 1000);
  const quantity = itemEntity.count !== 0 ? itemEntity.count : item.quantity;
  client.ps.powerups.set(item.tag, (expiration + quantity * 1000) | 0);

  for (const candidate of context.clients) {
    if (candidate === client || candidate.pers.connected === ConnectionState.DISCONNECTED) continue;
    const candidateSchema = statSchema(candidate.ps.product);
    if (candidate.ps.stats.get(candidateSchema.health) <= 0) continue;
    if (context.gameType >= GameType.GT_TEAM && candidate.sess.sessionTeam === client.sess.sessionTeam) continue;

    const delta = sub3(itemEntity.s.pos.base, candidate.ps.origin);
    if (length3(delta) > 192) continue;
    const direction = normalize3(delta);
    if (dot3(direction, qvmAngleVectors(candidate.ps.viewangles).forward) < 0.4) continue;
    if (context.traceSolidLine(candidate.ps.origin, itemEntity.s.pos.base).fraction !== 1) continue;
    const events = candidate.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS);
    candidate.ps.persistant.set(PersistentIndex.PERS_PLAYEREVENTS, events ^ PLAYEREVENT_DENIED_REWARD);
  }
  return RESPAWN_POWERUP;
}

export function pickupPowerup(itemEntity: GameEntity, other: GameEntity, context: PowerupPickupContext): number {
  const input = pickupInput(itemEntity, other);
  return pickupPowerupFrom(itemEntity, input.client, input.item, context);
}

export function pickupItem(itemEntity: GameEntity, other: GameEntity, context: ItemPickupContext): number {
  const input = pickupInput(itemEntity, other);
  switch (input.item.type) {
    case ItemType.IT_WEAPON:
      return pickupWeaponFrom(itemEntity, input.client, input.item, context);
    case ItemType.IT_AMMO:
      return pickupAmmoFrom(itemEntity, input.client, input.item);
    case ItemType.IT_ARMOR:
      return pickupArmorFrom(input.client, input.item);
    case ItemType.IT_HEALTH:
      return pickupHealthFrom(itemEntity, input.client, input.item, other);
    case ItemType.IT_POWERUP:
      return pickupPowerupFrom(itemEntity, input.client, input.item, context);
    case ItemType.IT_HOLDABLE:
      return pickupHoldableFrom(input.client, input.item, input.itemIndex);
    case ItemType.IT_PERSISTANT_POWERUP:
      return pickupPersistentPowerupFrom(
        itemEntity,
        input.client,
        input.item,
        input.itemIndex,
        () => context.handicapForClient(input.client.ps.clientNum),
        other,
      );
    case ItemType.IT_TEAM:
      throw new Error("Pickup_Item: IT_TEAM requires the team objective pickup handler");
    case ItemType.IT_BAD:
      throw new Error("Pickup_Item: IT_BAD cannot be picked up");
    default: {
      const exhaustive: never = input.item;
      throw new Error(`Pickup_Item: unknown item ${String(exhaustive)}`);
    }
  }
}
