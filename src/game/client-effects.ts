// Ported from id Software's code/game/g_active.c client effects, timers,
// event publication and ClientEndFrame. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.

import { vectorToAngles } from "../core/math.ts";
import { EntityEvent, EntityType, MoveType, Powerup, Team, Weapon, statSchema } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { itemAt } from "../shared/items.ts";
import type { PlayerState } from "../shared/player-state.ts";
import { playerStateToEntityState, playerStateToEntityStateExtraPolate } from "../shared/snapshot-state.ts";
import { damage, DamageFlags } from "./combat.ts";
import type { CombatContext } from "./combat.ts";
import { GameFlags } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";

export interface ClientEffectsContext {
  readonly combat: CombatContext;
  readonly intermissionTime: number;
  readonly smoothClients: boolean;
  readonly frySound: number;
  randomInt(): number;
  soundIndex(path: string): number;
  sound(entity: GameEntity, channel: number, soundIndex: number): void;
  spectatorEndFrame(entity: GameEntity): void;
}

type EventContext = Pick<ClientEffectsContext, "combat">;
const CONTENTS_LAVA = 8;
const CONTENTS_SLIME = 16;
const EF_TICKING = 2;
const EF_CONNECTION = 0x2000;
const EF_PLAYER_EVENT = 0x10;
const CHAN_VOICE = 3;

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Client effects require a client entity");
  return entity.client;
}

export function damageFeedback(context: EventContext, player: GameEntity): void {
  const client = clientOf(player);
  if (client.ps.pmType === MoveType.PM_DEAD) return;
  const count = Math.min(255, Math.fround((client.damageBlood + client.damageArmor) | 0));
  if (count === 0) return;
  if (client.damageFromWorld) {
    client.ps.damagePitch = 255;
    client.ps.damageYaw = 255;
    client.damageFromWorld = false;
  } else {
    const angles = vectorToAngles(client.damageFrom);
    client.ps.damagePitch = Math.trunc(Math.fround(Math.fround(angles.x / 360) * 256)) | 0;
    client.ps.damageYaw = Math.trunc(Math.fround(Math.fround(angles.y / 360) * 256)) | 0;
  }
  if (context.combat.time > player.painDebounceTime && (player.flags & GameFlags.GODMODE) === 0) {
    player.painDebounceTime = (context.combat.time + 700) | 0;
    context.combat.entities.addEvent(player, EntityEvent.EV_PAIN, player.health);
    client.ps.damageEvent = (client.ps.damageEvent + 1) | 0;
  }
  client.ps.damageCount = Math.trunc(count);
  client.damageBlood = 0;
  client.damageArmor = 0;
  client.damageKnockback = 0;
}

export function worldEffects(context: ClientEffectsContext, entity: GameEntity): void {
  const client = clientOf(entity);
  const time = context.combat.time;
  if (client.noclip) {
    client.airOutTime = (time + 12000) | 0;
    return;
  }
  const waterlevel = entity.waterlevel;
  const suit = client.ps.powerups.get(Powerup.PW_BATTLESUIT) > time;
  if (waterlevel === 3) {
    if (suit) client.airOutTime = (time + 10000) | 0;
    if (client.airOutTime < time) {
      client.airOutTime = (client.airOutTime + 1000) | 0;
      if (entity.health > 0) {
        entity.damage = Math.min(15, (entity.damage + 2) | 0);
        const path = entity.health <= entity.damage ? "*drown.wav"
          : (context.randomInt() & 1) !== 0 ? "sound/player/gurp1.wav" : "sound/player/gurp2.wav";
        context.sound(entity, CHAN_VOICE, context.soundIndex(path));
        entity.painDebounceTime = (time + 200) | 0;
        damage(context.combat, entity, null, null, null, null, entity.damage, DamageFlags.NO_ARMOR, 14);
      }
    }
  } else {
    client.airOutTime = (time + 12000) | 0;
    entity.damage = 2;
  }
  if (waterlevel !== 0 && (entity.watertype & (CONTENTS_LAVA | CONTENTS_SLIME)) !== 0 &&
    entity.health > 0 && entity.painDebounceTime <= time) {
    if (suit) context.combat.entities.addEvent(entity, EntityEvent.EV_POWERUP_BATTLESUIT, 0);
    else {
      if ((entity.watertype & CONTENTS_LAVA) !== 0) damage(context.combat, entity, null, null, null, null, Math.imul(30, waterlevel), 0, 16);
      if ((entity.watertype & CONTENTS_SLIME) !== 0) damage(context.combat, entity, null, null, null, null, Math.imul(10, waterlevel), 0, 15);
    }
  }
}

export function setClientSound(context: ClientEffectsContext, entity: GameEntity): void {
  clientOf(entity).ps.loopSound = context.combat.product === "missionpack" && (entity.s.eFlags & EF_TICKING) !== 0
    ? context.soundIndex("sound/weapons/proxmine/wstbtick.wav")
    : entity.waterlevel !== 0 && (entity.watertype & (CONTENTS_LAVA | CONTENTS_SLIME)) !== 0 ? context.frySound : 0;
}

const ammoRegeneration: readonly { readonly weapon: Weapon; readonly max: number; readonly increment: number; readonly time: number }[] = [
  { weapon: Weapon.WP_MACHINEGUN, max: 50, increment: 4, time: 1000 },
  { weapon: Weapon.WP_SHOTGUN, max: 10, increment: 1, time: 1500 },
  { weapon: Weapon.WP_GRENADE_LAUNCHER, max: 10, increment: 1, time: 2000 },
  { weapon: Weapon.WP_ROCKET_LAUNCHER, max: 10, increment: 1, time: 1750 },
  { weapon: Weapon.WP_LIGHTNING, max: 50, increment: 5, time: 1500 },
  { weapon: Weapon.WP_RAILGUN, max: 10, increment: 1, time: 1750 },
  { weapon: Weapon.WP_PLASMAGUN, max: 50, increment: 5, time: 1500 },
  { weapon: Weapon.WP_BFG, max: 10, increment: 1, time: 4000 },
  { weapon: Weapon.WP_NAILGUN, max: 10, increment: 1, time: 1250 },
  { weapon: Weapon.WP_PROX_LAUNCHER, max: 5, increment: 1, time: 2000 },
  { weapon: Weapon.WP_CHAINGUN, max: 100, increment: 5, time: 1000 },
];

function persistentTag(client: GameClient): number {
  const schema = statSchema(client.ps.product);
  return schema.product === "baseq3" ? Powerup.PW_NONE : itemAt("missionpack", client.ps.stats.get(schema.persistentPowerup)).tag;
}

export function clientTimerActions(context: EventContext, entity: GameEntity, msec: number): void {
  const client = clientOf(entity);
  const ps = client.ps;
  const schema = statSchema(ps.product);
  client.timeResidual = (client.timeResidual + msec) | 0;
  while (client.timeResidual >= 1000) {
    client.timeResidual -= 1000;
    const maximum = ps.stats.get(schema.maxHealth);
    const maxHealth = ps.product === "missionpack" && persistentTag(client) === Powerup.PW_GUARD
      ? Math.trunc(maximum / 2) : ps.powerups.get(Powerup.PW_REGEN) !== 0 ? maximum : 0;
    if ((ps.product === "baseq3" && ps.powerups.get(Powerup.PW_REGEN) !== 0) || maxHealth !== 0) {
      if (entity.health < maxHealth) {
        entity.health = (entity.health + 15) | 0;
        const regenerationCap = Math.fround(Math.fround(maxHealth) * Math.fround(1.1));
        if (Math.fround(entity.health) > regenerationCap) entity.health = Math.trunc(regenerationCap) | 0;
        context.combat.entities.addEvent(entity, EntityEvent.EV_POWERUP_REGEN, 0);
      } else if (entity.health < Math.imul(maxHealth, 2)) {
        entity.health = (entity.health + 5) | 0;
        if (entity.health > Math.imul(maxHealth, 2)) entity.health = Math.imul(maxHealth, 2);
        context.combat.entities.addEvent(entity, EntityEvent.EV_POWERUP_REGEN, 0);
      }
    } else if (entity.health > maximum) entity.health = (entity.health - 1) | 0;
    if (ps.stats.get(schema.armor) > maximum) ps.stats.set(schema.armor, ps.stats.get(schema.armor) - 1);
  }
  if (ps.product === "missionpack" && persistentTag(client) === Powerup.PW_AMMOREGEN) {
    for (const rule of ammoRegeneration) {
      let elapsed = (client.ammoTimes.get(rule.weapon) + msec) | 0;
      if (ps.ammo.get(rule.weapon) >= rule.max) elapsed = 0;
      if (elapsed >= rule.time) {
        while (elapsed >= rule.time) elapsed -= rule.time;
        ps.ammo.set(rule.weapon, Math.min(rule.max, (ps.ammo.get(rule.weapon) + rule.increment) | 0));
      }
      client.ammoTimes.set(rule.weapon, elapsed);
    }
  }
}

export function sendPendingPredictableEvents(context: EventContext, ps: PlayerState): void {
  if (ps.entityEventSequence >= ps.eventSequence) return;
  const event = ps.events.get(ps.entityEventSequence & 1) | ((ps.entityEventSequence & 3) << 8);
  const external = ps.externalEvent;
  ps.externalEvent = 0;
  const temporary = context.combat.entities.tempEntity(ps.origin, event);
  const number = temporary.s.number;
  playerStateToEntityState(ps, temporary.s, true);
  temporary.s.number = number;
  temporary.s.eType = EntityType.ET_EVENTS + event;
  temporary.s.eFlags |= EF_PLAYER_EVENT;
  temporary.s.otherEntityNum = ps.clientNum;
  temporary.r.svFlags |= ServerEntityFlags.NOTSINGLECLIENT;
  temporary.r.singleClient = ps.clientNum;
  ps.externalEvent = external;
}

export function clientEndFrame(context: ClientEffectsContext, entity: GameEntity): void {
  const client = clientOf(entity);
  if (client.sess.sessionTeam === Team.TEAM_SPECTATOR) {
    context.spectatorEndFrame(entity);
    return;
  }
  const time = context.combat.time;
  for (let index = 0; index < client.ps.powerups.length; index++) {
    if (client.ps.powerups.get(index) < time) client.ps.powerups.set(index, 0);
  }
  if (context.combat.product === "missionpack") {
    const tag = persistentTag(client);
    for (const powerup of [Powerup.PW_GUARD, Powerup.PW_SCOUT, Powerup.PW_DOUBLER, Powerup.PW_AMMOREGEN]) {
      if (tag === powerup) client.ps.powerups.set(powerup, time);
    }
    if (client.invulnerabilityTime > time) client.ps.powerups.set(Powerup.PW_INVULNERABILITY, time);
  }
  if (context.intermissionTime !== 0) return;
  worldEffects(context, entity);
  damageFeedback(context, entity);
  const current = clientOf(entity);
  if (((time - current.lastCmdTime) | 0) > 1000) entity.s.eFlags |= EF_CONNECTION;
  else entity.s.eFlags &= ~EF_CONNECTION;
  current.ps.health = entity.health;
  setClientSound(context, entity);
  if (context.smoothClients) playerStateToEntityStateExtraPolate(current.ps, entity.s, current.ps.commandTime, true);
  else playerStateToEntityState(current.ps, entity.s, true);
  sendPendingPredictableEvents(context, current.ps);
}
