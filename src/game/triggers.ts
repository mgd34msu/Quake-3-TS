// Ported from id Software's code/game/g_trigger.c and bg_misc.c:BG_TouchJumpPad.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, dot3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, MoveType, Team } from "../shared/definitions.ts";
import { touchJumpPad } from "../shared/jump-pad.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { damage, DamageFlags } from "./combat.ts";
import type { CombatContext } from "./combat.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { teleportPlayer } from "./misc.ts";
import type { GameRandom } from "./numeric.ts";
import type { SpawnHandler, SpawnVariables } from "./spawn.ts";
import type { GameEntity } from "./state.ts";
import { moveDirection, pickTarget, useTargets } from "./utilities.ts";
import type { TargetSelectionContext } from "./utilities.ts";

const FRAMETIME = 100;
const CONTENTS_TRIGGER = 0x40000000;
const MOD_TRIGGER_HURT = 22;
const f32 = Math.fround;

export interface TriggerHost {
  readonly entities: EntityPool;
  readonly world: ServerWorld;
  readonly random: Pick<GameRandom, "rand" | "crandom">;
  combat(): CombatContext;
  gravity(): number;
  /** SV_SetBrushModel, including its source-side immediate link. */
  setBrushModel(entity: GameEntity, name: string | null): void;
  soundIndex(path: string): number;
  remapShader(oldName: string, newName: string, timeSeconds: number): void;
  warn(message: string): void;
}

export interface AimAtTargetContext extends TargetSelectionContext {
  gravity(): number;
}

function gameTime(host: TriggerHost): number {
  const time = host.entities.options.time();
  if (!Number.isInteger(time) || time < -2_147_483_648 || time > 2_147_483_647) {
    throw new RangeError("Trigger host time must be a signed 32-bit millisecond value");
  }
  return time;
}

function requireOwned(host: TriggerHost, entity: GameEntity): void {
  if (host.entities.get(entity.slot) !== entity) {
    throw new Error("Trigger entity does not belong to its entity pool or was replaced");
  }
}

function combatContext(host: TriggerHost): CombatContext {
  const combat = host.combat();
  if (combat.entities !== host.entities || combat.world !== host.world) {
    throw new Error("Trigger combat context does not match its entity pool and world");
  }
  if (combat.time !== gameTime(host)) throw new Error("Trigger combat context contains stale game time");
  return combat;
}

function dispatchTargets(host: TriggerHost, entity: GameEntity, activator: GameEntity | null): void {
  useTargets({ pool: host.entities, time: gameTime(host),
    remapShader: (oldName, newName, timeSeconds) => { host.remapShader(oldName, newName, timeSeconds); },
    warn: message => { host.warn(message); } }, entity, activator);
}

function targetSelection(host: TriggerHost): TargetSelectionContext {
  return { pool: host.entities, randomInt: () => host.random.rand(), warn: message => { host.warn(message); } };
}

function sourceFloatToInt(value: number): number {
  return value >= -2_147_483_648 && value < 2_147_483_648 ? Math.trunc(value) + 0 : -2_147_483_648;
}

function sourceSchedule(time: number, wait: number, random: number, crandom: number): number {
  const seconds = f32(f32(wait) + f32(f32(random) * f32(crandom)));
  const milliseconds = f32(f32(1_000) * seconds);
  return sourceFloatToInt(f32(f32(time) + milliseconds));
}

function checkedCrandom(host: TriggerHost): number {
  const value = host.random.crandom();
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new RangeError("Game crandom() must return a value within [-1, 1]");
  }
  return f32(value);
}

/** Shared source AimAtTarget math; callers supply the source abs-bounds center. */
export function aimAtTarget(context: AimAtTargetContext, entity: GameEntity, origin: Vec3): void {
  const target = pickTarget(context, entity.target);
  if (target === null) {
    context.pool.free(entity);
    return;
  }
  const height = f32(target.s.origin.z - origin.z);
  const gravity = f32(context.gravity());
  // g_syscalls.asm binds sqrt to TRAP_SQRT, not bg_lib.c's fallback.
  const time = f32(Math.sqrt(f32(height / f32(f32(0.5) * gravity))));
  if (time === 0) {
    context.pool.free(entity);
    return;
  }
  const offset = sub3(target.s.origin, origin);
  const horizontal = vec3(offset.x, offset.y, 0);
  const distance = f32(Math.sqrt(dot3(horizontal, horizontal)));
  const direction = distance === 0 ? horizontal : scale3(horizontal, f32(1 / distance));
  const forward = f32(distance / time);
  const velocity = scale3(direction, forward);
  entity.s.origin2 = vec3(velocity.x, velocity.y, f32(time * gravity));
}

function initTrigger(host: TriggerHost, entity: GameEntity): void {
  const angles = entity.s.angles;
  if (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) {
    const moved = moveDirection(angles);
    entity.movedir = moved.direction;
    entity.s.angles = moved.angles;
  }
  host.setBrushModel(entity, entity.model);
  entity.r.contents = CONTENTS_TRIGGER;
  entity.r.svFlags = ServerEntityFlags.NOCLIENT;
}

function multiWait(entity: GameEntity): void {
  entity.nextthink = 0;
}

function multiTrigger(host: TriggerHost, entity: GameEntity, activatorValue: GameEntity | null): void {
  if (activatorValue !== null) requireOwned(host, activatorValue);
  entity.activator = activatorValue;
  if (entity.nextthink !== 0) return;
  if (activatorValue === null) throw new Error("trigger_multiple requires an activator");
  const client = activatorValue.client;
  if (client !== null) {
    if ((entity.spawnflags & 1) !== 0 && client.sess.sessionTeam !== Team.TEAM_RED) return;
    if ((entity.spawnflags & 2) !== 0 && client.sess.sessionTeam !== Team.TEAM_BLUE) return;
  }
  dispatchTargets(host, entity, activatorValue);
  if (entity.wait > 0) {
    entity.think = multiWait;
    entity.nextthink = sourceSchedule(gameTime(host), entity.wait, entity.random, checkedCrandom(host));
  } else {
    entity.touch = null;
    entity.nextthink = (gameTime(host) + FRAMETIME) | 0;
    entity.think = self => { host.entities.free(self); };
  }
}

function spawnTriggerMultiple(host: TriggerHost, entity: GameEntity, variables: SpawnVariables): void {
  requireOwned(host, entity);
  entity.wait = variables.float("wait", "0.5").value;
  entity.random = variables.float("random", "0").value;
  if (entity.random >= entity.wait && entity.wait >= 0) {
    entity.random = f32(entity.wait - FRAMETIME);
    host.warn("trigger_multiple has random >= wait\n");
  }
  entity.touch = (self, other) => {
    if (other.client !== null) multiTrigger(host, self, other);
  };
  entity.use = (self, _other, activator) => { multiTrigger(host, self, activator); };
  initTrigger(host, entity);
  host.entities.options.link(entity);
}

function spawnTriggerAlways(host: TriggerHost, entity: GameEntity): void {
  requireOwned(host, entity);
  entity.nextthink = (gameTime(host) + 300) | 0;
  entity.think = self => {
    dispatchTargets(host, self, self);
    host.entities.free(self);
  };
}

function spawnTriggerPush(host: TriggerHost, entity: GameEntity): void {
  requireOwned(host, entity);
  initTrigger(host, entity);
  entity.r.svFlags &= ~ServerEntityFlags.NOCLIENT;
  host.soundIndex("sound/world/jumppad.wav");
  entity.s.eType = EntityType.ET_PUSH_TRIGGER;
  entity.touch = (self, other) => { if (other.client !== null) touchJumpPad(other.client.ps, self.s); };
  entity.think = self => {
    aimAtTarget({ pool: host.entities, randomInt: () => host.random.rand(), gravity: () => host.gravity(),
      warn: message => { host.warn(message); } }, self, scale3(add3(self.r.absmin, self.r.absmax), 0.5));
  };
  entity.nextthink = (gameTime(host) + FRAMETIME) | 0;
  host.entities.options.link(entity);
}

function spawnTriggerTeleport(host: TriggerHost, entity: GameEntity): void {
  requireOwned(host, entity);
  initTrigger(host, entity);
  if ((entity.spawnflags & 1) !== 0) entity.r.svFlags |= ServerEntityFlags.NOCLIENT;
  else entity.r.svFlags &= ~ServerEntityFlags.NOCLIENT;
  host.soundIndex("sound/world/jumppad.wav");
  entity.s.eType = EntityType.ET_TELEPORT_TRIGGER;
  entity.touch = (self, other) => {
    const client = other.client;
    if (client === null || client.ps.pmType === MoveType.PM_DEAD) return;
    if ((self.spawnflags & 1) !== 0 && client.sess.sessionTeam !== Team.TEAM_SPECTATOR) return;
    const destination = pickTarget(targetSelection(host), self.target);
    if (destination === null) {
      host.warn("Couldn't find teleporter destination\n");
      return;
    }
    teleportPlayer({ combat: combatContext(host), world: host.world }, other,
      destination.s.origin, destination.s.angles);
  };
  host.entities.options.link(entity);
}

function soundAt(host: TriggerHost, entity: GameEntity, sound: number): void {
  const event = host.entities.tempEntity(entity.r.currentOrigin, EntityEvent.EV_GENERAL_SOUND);
  event.s.eventParm = sound;
}

function spawnTriggerHurt(host: TriggerHost, entity: GameEntity): void {
  requireOwned(host, entity);
  initTrigger(host, entity);
  entity.noiseIndex = host.soundIndex("sound/world/electro.wav");
  entity.touch = (self, other) => {
    if (!other.takedamage || self.timestamp > gameTime(host)) return;
    self.timestamp = (gameTime(host) + ((self.spawnflags & 16) !== 0 ? 1_000 : FRAMETIME)) | 0;
    if ((self.spawnflags & 4) === 0) soundAt(host, other, self.noiseIndex);
    const flags = (self.spawnflags & 8) !== 0 ? DamageFlags.NO_PROTECTION : 0;
    damage(combatContext(host), other, self, self, null, null,
      self.damage, flags, MOD_TRIGGER_HURT);
  };
  if (entity.damage === 0) entity.damage = 5;
  entity.r.contents = CONTENTS_TRIGGER;
  if ((entity.spawnflags & 2) !== 0) {
    entity.use = self => {
      if (self.r.linked) host.entities.options.unlink(self);
      else host.entities.options.link(self);
    };
  }
  if ((entity.spawnflags & 1) === 0) host.entities.options.link(entity);
}

function timerThink(host: TriggerHost, entity: GameEntity): void {
  dispatchTargets(host, entity, entity.activator);
  entity.nextthink = sourceSchedule(gameTime(host), entity.wait, entity.random, checkedCrandom(host));
}

function spawnFuncTimer(host: TriggerHost, entity: GameEntity, variables: SpawnVariables): void {
  requireOwned(host, entity);
  entity.random = variables.float("random", "1").value;
  entity.wait = variables.float("wait", "1").value;
  entity.use = (self, _other, activator) => {
    if (activator !== null) requireOwned(host, activator);
    self.activator = activator;
    if (self.nextthink !== 0) self.nextthink = 0;
    else timerThink(host, self);
  };
  entity.think = self => { timerThink(host, self); };
  if (entity.random >= entity.wait) {
    entity.random = f32(entity.wait - FRAMETIME);
    host.warn(gameFormat("func_timer at %s has random >= wait\n", [host.entities.utilities.vtos(entity.s.origin).readString()]));
  }
  if ((entity.spawnflags & 1) !== 0) {
    entity.nextthink = (gameTime(host) + FRAMETIME) | 0;
    entity.activator = entity;
  }
  entity.r.svFlags = ServerEntityFlags.NOCLIENT;
}

/** Spawn table entries for every concrete g_trigger.c entity except target_push. */
export function triggerSpawnHandlers(host: TriggerHost): ReadonlyMap<string, SpawnHandler> {
  return new Map<string, SpawnHandler>([
    ["trigger_multiple", (entity, variables) => { spawnTriggerMultiple(host, entity, variables); }],
    ["trigger_always", entity => { spawnTriggerAlways(host, entity); }],
    ["trigger_push", entity => { spawnTriggerPush(host, entity); }],
    ["trigger_teleport", entity => { spawnTriggerTeleport(host, entity); }],
    ["trigger_hurt", entity => { spawnTriggerHurt(host, entity); }],
    ["func_timer", (entity, variables) => { spawnFuncTimer(host, entity, variables); }],
  ]);
}
