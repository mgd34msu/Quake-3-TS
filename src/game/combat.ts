// Ported from id Software's code/game/g_combat.c: CheckArmor, G_Damage,
// CanDamage and G_RadiusDamage; g_team.c: OnSameTeam. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.

import { add3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { ARMOR_PROTECTION, EntityEvent, EntityType, GameType, PersistentIndex, Powerup, statSchema } from "../shared/definitions.ts";
import { itemAt } from "../shared/items.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, MoveFlags } from "../shared/player-state.ts";
import type { EntityPool } from "./entities.ts";
import { GameFlags, MoverState } from "./state.ts";
import type { GameEntity } from "./state.ts";

export enum DamageFlags {
  RADIUS = 0x1,
  NO_ARMOR = 0x2,
  NO_KNOCKBACK = 0x4,
  NO_PROTECTION = 0x8,
  NO_TEAM_PROTECTION = 0x10,
}

const MOD_FALLING = 19;
const MOD_PROXIMITY_MINE = 25;
const MOD_JUICED = 27;

export interface DamageDiagnostic {
  readonly time: number;
  readonly entityNum: number;
  readonly health: number;
  readonly damage: number;
  readonly armor: number;
}

/** G_Damage normalizes its caller's direction after the pre-knockback early returns. */
export interface DamageDirection { x: number; y: number; z: number }

interface CombatServices {
  readonly time: number;
  readonly intermissionQueued: number;
  readonly gameType: number;
  readonly friendlyFire: boolean;
  readonly knockback: number;
  readonly entities: EntityPool;
  readonly world: Pick<ServerWorld, "trace" | "areaEntities" | "linkState">;
  readonly debugDamage: ((diagnostic: DamageDiagnostic) => void) | null;
  checkHurtCarrier(target: GameEntity, attacker: GameEntity): void;
  logAccuracyHit(target: GameEntity, attacker: GameEntity): boolean;
}

export type CombatContext = CombatServices & (
  | { readonly product: "baseq3" }
  | {
    readonly product: "missionpack";
    checkObeliskAttack(target: GameEntity, attacker: GameEntity): boolean;
    invulnerabilityEffect(target: GameEntity, direction: Vec3, point: Vec3): void;
  }
);

function onSameTeam(context: CombatContext, first: GameEntity, second: GameEntity): boolean {
  return first.client !== null && second.client !== null && context.gameType >= GameType.GT_TEAM &&
    first.client.sess.sessionTeam === second.client.sess.sessionTeam;
}

export function checkArmor(target: GameEntity, damage: number, flags: number): number {
  if (damage === 0 || target.client === null || (flags & DamageFlags.NO_ARMOR) !== 0) return 0;
  const ps = target.client.ps;
  const slot = statSchema(ps.product).armor;
  const scaledDamage = Math.fround(Math.fround(damage) * Math.fround(ARMOR_PROTECTION));
  const roundedSave = Math.ceil(scaledDamage);
  const armor = ps.stats.get(slot);
  const save = roundedSave >= armor ? armor : roundedSave;
  if (save === 0) return 0;
  ps.stats.set(slot, armor - save);
  return save;
}

/** Caller supplies already weapon-scaled damage. Doubler/quad scaling belongs to g_weapon. */
export function damage(context: CombatContext, target: GameEntity, inflictor: GameEntity | null,
  attacker: GameEntity | null, direction: DamageDirection | null, point: Vec3 | null,
  amount: number, flags: number, methodOfDeath: number): void {
  if (!target.takedamage || context.intermissionQueued !== 0) return;
  if (context.product === "missionpack" && target.client !== null && methodOfDeath !== MOD_JUICED &&
    target.client.invulnerabilityTime > context.time) {
    if (direction !== null && point !== null) context.invulnerabilityEffect(target, direction, point);
    return;
  }
  const source = inflictor ?? context.entities.at(ENTITYNUM_WORLD);
  const owner = attacker ?? context.entities.at(ENTITYNUM_WORLD);
  if (target.s.eType === EntityType.ET_MOVER) {
    if (target.use !== null && target.moverState === MoverState.POS1) target.use(target, source, owner);
    return;
  }
  if (context.product === "missionpack" && context.gameType === GameType.GT_OBELISK && context.checkObeliskAttack(target, owner)) return;
  if (owner.client !== null && owner !== target) {
    const schema = statSchema(context.product);
    let max = owner.client.ps.stats.get(schema.maxHealth);
    if (schema.product === "missionpack" &&
      itemAt("missionpack", owner.client.ps.stats.get(schema.persistentPowerup)).tag === Powerup.PW_GUARD) max = Math.trunc(max / 2);
    amount = Math.trunc(Math.imul(amount, max) / 100);
  }
  const client = target.client;
  if (client !== null && client.noclip) return;
  const dir = direction;
  if (dir === null) flags |= DamageFlags.NO_KNOCKBACK;
  else {
    const normalized = normalize3(dir);
    dir.x = normalized.x; dir.y = normalized.y; dir.z = normalized.z;
  }
  let knockback = Math.min(amount, 200);
  if ((target.flags & GameFlags.NO_KNOCKBACK) !== 0 || (flags & DamageFlags.NO_KNOCKBACK) !== 0) knockback = 0;
  if (knockback !== 0 && client !== null && dir !== null) {
    const impulse = Math.fround(Math.fround(Math.fround(context.knockback) * Math.fround(knockback)) / 200);
    client.ps.velocity = add3(client.ps.velocity, scale3(dir, impulse));
    if (client.ps.pmTime === 0) {
      client.ps.pmTime = Math.min(200, Math.max(50, Math.imul(knockback, 2)));
      client.ps.pmFlags |= MoveFlags.TIME_KNOCKBACK;
    }
  }
  if ((flags & DamageFlags.NO_PROTECTION) === 0) {
    const checkTeam = context.product === "baseq3" ||
      (methodOfDeath !== MOD_JUICED && (flags & DamageFlags.NO_TEAM_PROTECTION) === 0);
    if (checkTeam && target !== owner && onSameTeam(context, target, owner) && !context.friendlyFire) return;
    if (context.product === "missionpack" && methodOfDeath === MOD_PROXIMITY_MINE) {
      if (source.parent !== null && onSameTeam(context, target, source.parent)) return;
      if (target === owner) return;
    }
    if ((target.flags & GameFlags.GODMODE) !== 0) return;
  }
  if (client !== null && client.ps.powerups.get(Powerup.PW_BATTLESUIT) !== 0) {
    context.entities.addEvent(target, EntityEvent.EV_POWERUP_BATTLESUIT, 0);
    if ((flags & DamageFlags.RADIUS) !== 0 || methodOfDeath === MOD_FALLING) return;
    amount = Math.trunc(amount * 0.5);
  }
  if (owner.client !== null && target !== owner && target.health > 0 &&
    target.s.eType !== EntityType.ET_MISSILE && target.s.eType !== EntityType.ET_GENERAL) {
    const persistent = owner.client.ps.persistant;
    persistent.set(PersistentIndex.PERS_HITS, persistent.get(PersistentIndex.PERS_HITS) + (onSameTeam(context, target, owner) ? -1 : 1));
    if (client === null) throw new Error("G_Damage hit feedback requires a target client for this entity type");
    persistent.set(PersistentIndex.PERS_ATTACKEE_ARMOR, (target.health << 8) | client.ps.stats.get(statSchema(context.product).armor));
  }
  if (target === owner) amount = Math.trunc(amount * 0.5);
  if (amount < 1) amount = 1;
  const armor = checkArmor(target, amount, flags);
  const take = (amount - armor) | 0;
  context.debugDamage?.({ time: context.time, entityNum: target.s.number, health: target.health, damage: take, armor });
  if (client !== null) {
    client.ps.persistant.set(PersistentIndex.PERS_ATTACKER, owner.s.number);
    client.damageArmor = (client.damageArmor + armor) | 0;
    client.damageBlood = (client.damageBlood + take) | 0;
    client.damageKnockback = (client.damageKnockback + knockback) | 0;
    client.damageFrom = { ...(dir ?? target.r.currentOrigin) };
    client.damageFromWorld = dir === null;
  }
  if (context.gameType === GameType.GT_CTF || (context.product === "missionpack" && context.gameType === GameType.GT_1FCTF)) {
    context.checkHurtCarrier(target, owner);
  }
  if (target.client !== null) {
    target.client.lastHurtClient = owner.s.number;
    target.client.lastHurtMod = methodOfDeath;
  }
  if (take !== 0) {
    target.health = (target.health - take) | 0;
    if (target.client !== null) target.client.ps.health = target.health;
    if (target.health <= 0) {
      if (client !== null) target.flags |= GameFlags.NO_KNOCKBACK;
      if (target.health < -999) target.health = -999;
      target.enemy = owner;
      if (target.die === null) throw new Error("G_Damage lethal target has no die callback");
      target.die(target, source, owner, take, methodOfDeath);
    } else if (target.pain !== null) target.pain(target, owner, take);
  }
}

function absoluteBounds(context: CombatContext, target: GameEntity): Bounds {
  const link = context.world.linkState(target.s.number);
  if (link === undefined) throw new Error("Combat visibility requires source absolute bounds from a server link");
  return link.absbounds;
}

export function canDamage(context: CombatContext, target: GameEntity, origin: Vec3): boolean {
  const bounds = absoluteBounds(context, target);
  const midpoint = scale3(add3(bounds.min, bounds.max), 0.5);
  const trace = (end: Vec3) => context.world.trace({ start: origin, end, shape: { kind: "point" }, passEntityNum: ENTITYNUM_NONE, mask: 1 });
  const center = trace(midpoint);
  if (center.fraction === 1 || center.entityNum === target.s.number) return true;
  for (const [x, y] of [[15, 15], [15, -15], [-15, 15], [-15, -15]] satisfies readonly (readonly [number, number])[]) {
    if (trace(vec3(midpoint.x + x, midpoint.y + y, midpoint.z)).fraction === 1) return true;
  }
  return false;
}

export function radiusDamage(context: CombatContext, origin: Vec3, attacker: GameEntity,
  amount: number, radius: number, ignore: GameEntity | null, methodOfDeath: number): boolean {
  radius = Math.max(1, Math.fround(radius));
  amount = Math.fround(amount);
  const extent = vec3(radius, radius, radius);
  const candidates = context.world.areaEntities({ min: sub3(origin, extent), max: add3(origin, extent) });
  let hitClient = false;
  for (const number of candidates) {
    const target = context.entities.at(number);
    if (target === ignore || !target.takedamage) continue;
    const bounds = absoluteBounds(context, target);
    const distanceAxis = (value: number, min: number, max: number): number => value < min ? min - value : value > max ? value - max : 0;
    const distance = length3(vec3(distanceAxis(origin.x, bounds.min.x, bounds.max.x),
      distanceAxis(origin.y, bounds.min.y, bounds.max.y), distanceAxis(origin.z, bounds.min.z, bounds.max.z)));
    if (distance >= radius) continue;
    const points = Math.fround(amount * Math.fround(1 - Math.fround(distance / radius)));
    if (!canDamage(context, target, origin)) continue;
    if (context.logAccuracyHit(target, attacker)) hitClient = true;
    const direction = add3(sub3(target.r.currentOrigin, origin), vec3(0, 0, 24));
    damage(context, target, null, attacker, direction, origin, Math.trunc(points), DamageFlags.RADIUS, methodOfDeath);
  }
  return hitClient;
}
