// Ported from id Software's game/g_missile.c and g_weapon.c grapple helpers.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, dot3, length3, normalize3, scale3, sub3, vec3, vectorToAngles } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { ServerTraceResult, ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, Weapon } from "../shared/definitions.ts";
import { directionToByte } from "../shared/direction-byte.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { ENTITYNUM_NONE, MoveFlags } from "../shared/player-state.ts";
import { evaluateTrajectory, evaluateTrajectoryDelta, TrajectoryType } from "../shared/trajectory.ts";
import { canDamage, damage, DamageFlags, radiusDamage } from "./combat.ts";
import type { CombatContext } from "./combat.ts";
import { runThink, setOrigin } from "./entities.ts";
import type { GameRandom } from "./numeric.ts";
import type { EntityTouch, GameClient, GameEntity } from "./state.ts";

const MASK_SHOT = 1 | 0x2000000 | 0x4000000;
const EF_BOUNCE = 0x10, EF_BOUNCE_HALF = 0x20, EF_NODRAW = 0x80, EF_TICKING = 2;
const SURF_NOIMPACT = 0x10, SURF_METALSTEPS = 0x1000;

/** Source fire_* normalizes this argument in place. */
export interface MissileDirection { x: number; y: number; z: number }

export interface MissionpackMissileServices {
  readonly proxMineTimeout: number;
  readonly random: Pick<GameRandom, "random" | "crandom">;
  soundIndex(path: string): number;
  /** G_InvulnerabilityEffect publishes the impact effect and supplies its sphere normal. */
  invulnerabilityImpact(target: GameEntity, direction: Vec3, point: Vec3):
    { readonly kind: "miss" } | { readonly kind: "hit"; readonly bounceDirection: Vec3 };
}

/** Time and cvar properties must be live across scheduled think/touch callbacks. */
export type MissileHost = { readonly world: ServerWorld; readonly previousTime: number } & (
  | { readonly combat: Extract<CombatContext, { product: "baseq3" }>; readonly missionpack: null }
  | { readonly combat: Extract<CombatContext, { product: "missionpack" }>; readonly missionpack: MissionpackMissileServices }
);

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Missile rule requires a client entity");
  return entity.client;
}

function parentOf(entity: GameEntity): GameEntity {
  if (entity.parent === null) throw new Error("Missile rule requires its source parent");
  return entity.parent;
}

function normalOf(trace: ServerTraceResult): Vec3 {
  return trace.contact.kind === "plane" ? trace.contact.plane.normal : vec3(0, 0, 0);
}

export function snapVector(value: Vec3): Vec3 {
  return vec3(qvmFloatToInt(value.x), qvmFloatToInt(value.y), qvmFloatToInt(value.z));
}

// g_weapon.c intentionally uses truncation plus one, even for negative coordinates.
export function snapVectorTowards(value: Vec3, toward: Vec3): Vec3 {
  const axis = (v: number, to: number): number => (qvmFloatToInt(v) + (to <= v ? 0 : 1)) | 0;
  return vec3(axis(value.x, toward.x), axis(value.y, toward.y), axis(value.z, toward.z));
}

function normalizeDirection(direction: MissileDirection): Vec3 {
  const normalized = normalize3(vec3(direction.x, direction.y, direction.z));
  direction.x = normalized.x; direction.y = normalized.y; direction.z = normalized.z;
  return normalized;
}

function center(entity: GameEntity): Vec3 {
  return add3(entity.r.currentOrigin, scale3(add3(entity.r.mins, entity.r.maxs), 0.5));
}

export class MissileRuntime {
  private readonly proximityTouch: EntityTouch = (self, other) => { this.proximityTrigger(self, other); };

  constructor(readonly host: MissileHost) {
    if (host.combat.entities.options.product !== host.combat.product) throw new Error("Missile product does not match its entity pool");
  }

  private owned(entity: GameEntity): void {
    if (this.host.combat.entities.get(entity.slot) !== entity) throw new Error("Missile entity does not belong to this pool");
  }

  isProximityTrigger(entity: GameEntity): boolean {
    this.owned(entity);
    return entity.touch === this.proximityTouch;
  }

  private missionpack(): MissionpackMissileServices {
    if (this.host.missionpack === null) throw new Error("Projectile requires missionpack");
    return this.host.missionpack;
  }

  private accuracy(owner: GameEntity): void { const client = clientOf(owner); client.accuracyHits = (client.accuracyHits + 1) | 0; }

  bounce(entity: GameEntity, trace: ServerTraceResult): void {
    this.owned(entity);
    const time = this.host.combat.time, previous = this.host.previousTime;
    const elapsed = Math.fround((time - previous) | 0);
    const hitTime = qvmFloatToInt(Math.fround(Math.fround(previous) + Math.fround(elapsed * Math.fround(trace.fraction))));
    const velocity = evaluateTrajectoryDelta(entity.s.pos, hitTime), normal = normalOf(trace);
    let delta = add3(velocity, scale3(normal, Math.fround(-2 * dot3(velocity, normal))));
    if (entity.s.eFlags & EF_BOUNCE_HALF) delta = scale3(delta, Math.fround(0.65));
    entity.s.pos = { ...entity.s.pos, delta };
    if ((entity.s.eFlags & EF_BOUNCE_HALF) && normal.z > Math.fround(0.2) && length3(delta) < 40) {
      setOrigin(entity, trace.end);
      return;
    }
    entity.r.currentOrigin = add3(entity.r.currentOrigin, normal);
    entity.s.pos = { ...entity.s.pos, base: { ...entity.r.currentOrigin }, time };
  }

  explode(entity: GameEntity): void {
    this.owned(entity);
    const combat = this.host.combat, pool = combat.entities;
    setOrigin(entity, snapVector(evaluateTrajectory(entity.s.pos, combat.time)));
    entity.s.eType = EntityType.ET_GENERAL;
    pool.addEvent(entity, EntityEvent.EV_MISSILE_MISS, directionToByte(vec3(0, 0, 1)));
    entity.freeAfterEvent = true;
    if (entity.splashDamage !== 0 && radiusDamage(combat, entity.r.currentOrigin, parentOf(entity), entity.splashDamage,
      entity.splashRadius, entity, entity.splashMethodOfDeath)) this.accuracy(pool.at(entity.r.ownerNum));
    this.host.world.link(entity);
  }

  impact(entity: GameEntity, trace: ServerTraceResult): void {
    this.owned(entity);
    const combat = this.host.combat, pool = combat.entities, other = pool.at(trace.entityNum);
    const normal = normalOf(trace);
    let hitClient = false;
    if (!other.takedamage && (entity.s.eFlags & (EF_BOUNCE | EF_BOUNCE_HALF))) {
      this.bounce(entity, trace); pool.addEvent(entity, EntityEvent.EV_GRENADE_BOUNCE); return;
    }
    if (this.host.missionpack !== null && other.takedamage && entity.s.weapon !== Weapon.WP_PROX_LAUNCHER &&
      other.client !== null && other.client.invulnerabilityTime > combat.time) {
      const effect = this.host.missionpack.invulnerabilityImpact(other, normalize3(entity.s.pos.delta), entity.s.pos.base);
      if (effect.kind === "hit") {
        const flags = entity.s.eFlags & EF_BOUNCE_HALF;
        entity.s.eFlags &= ~EF_BOUNCE_HALF;
        this.bounce(entity, { ...trace, contact: { kind: "plane", plane: { normal: effect.bounceDirection, distance: 0 } } });
        entity.s.eFlags |= flags;
      }
      entity.targetEnt = other; return;
    }
    if (other.takedamage && entity.damage !== 0) {
      const owner = pool.at(entity.r.ownerNum);
      if (combat.logAccuracyHit(other, owner)) { this.accuracy(owner); hitClient = true; }
      let velocity = evaluateTrajectoryDelta(entity.s.pos, combat.time);
      if (length3(velocity) === 0) velocity = vec3(velocity.x, velocity.y, 1);
      damage(combat, other, entity, owner, velocity, entity.s.origin, entity.damage, 0, entity.methodOfDeath);
    }
    if (this.host.missionpack !== null && entity.s.weapon === Weapon.WP_PROX_LAUNCHER) {
      if (entity.s.pos.type !== TrajectoryType.TR_GRAVITY) return;
      if (other.s.eType === EntityType.ET_PLAYER && other.health > 0) { this.proximityPlayer(entity, other); return; }
      setOrigin(entity, snapVectorTowards(trace.end, entity.s.pos.base));
      pool.addEvent(entity, EntityEvent.EV_PROXIMITY_MINE_STICK, trace.surfaceFlags);
      entity.think = self => { this.proximityActivate(self); }; entity.nextthink = (combat.time + 2000) | 0;
      const angles = vectorToAngles(normal); entity.s.angles = vec3(angles.x + 90, angles.y, angles.z);
      entity.enemy = other; entity.die = self => { this.proximityDie(self); }; entity.movedir = { ...normal };
      entity.r.mins = vec3(-4, -4, -4); entity.r.maxs = vec3(4, 4, 4);
      this.host.world.link(entity); return;
    }
    if (entity.classname === "hook") {
      const event = pool.spawn();
      let position: Vec3;
      if (other.takedamage && other.client !== null) {
        pool.addEvent(event, EntityEvent.EV_MISSILE_HIT, directionToByte(normal)); event.s.otherEntityNum = other.s.number;
        entity.enemy = other; position = snapVectorTowards(center(other), entity.s.pos.base);
      } else {
        position = trace.end; pool.addEvent(event, EntityEvent.EV_MISSILE_MISS, directionToByte(normal)); entity.enemy = null;
      }
      position = snapVectorTowards(position, entity.s.pos.base);
      event.freeAfterEvent = true; event.s.eType = EntityType.ET_GENERAL; entity.s.eType = EntityType.ET_GRAPPLE;
      setOrigin(entity, position); setOrigin(event, position);
      entity.think = self => { this.hookThink(self); }; entity.nextthink = (combat.time + 100) | 0;
      const client = clientOf(parentOf(entity)); client.ps.pmFlags |= MoveFlags.GRAPPLE_PULL;
      client.ps.grapplePoint = { ...entity.r.currentOrigin };
      this.host.world.link(entity); this.host.world.link(event); return;
    }
    if (other.takedamage && other.client !== null) {
      pool.addEvent(entity, EntityEvent.EV_MISSILE_HIT, directionToByte(normal)); entity.s.otherEntityNum = other.s.number;
    } else pool.addEvent(entity, trace.surfaceFlags & SURF_METALSTEPS ? EntityEvent.EV_MISSILE_MISS_METAL :
      EntityEvent.EV_MISSILE_MISS, directionToByte(normal));
    entity.freeAfterEvent = true; entity.s.eType = EntityType.ET_GENERAL;
    const position = snapVectorTowards(trace.end, entity.s.pos.base); setOrigin(entity, position);
    if (entity.splashDamage !== 0 && radiusDamage(combat, position, parentOf(entity), entity.splashDamage,
      entity.splashRadius, other, entity.splashMethodOfDeath) && !hitClient) this.accuracy(pool.at(entity.r.ownerNum));
    this.host.world.link(entity);
  }

  run(entity: GameEntity): void {
    this.owned(entity);
    const combat = this.host.combat, world = this.host.world;
    const destination = evaluateTrajectory(entity.s.pos, combat.time);
    const pass = entity.targetEnt !== null ? entity.targetEnt.s.number :
      this.host.missionpack !== null && entity.s.weapon === Weapon.WP_PROX_LAUNCHER && entity.count !== 0 ? ENTITYNUM_NONE : entity.r.ownerNum;
    const query = { start: entity.r.currentOrigin, end: destination,
      shape: { kind: "box", mins: entity.r.mins, maxs: entity.r.maxs }, passEntityNum: pass, mask: entity.clipmask } satisfies Parameters<ServerWorld["trace"]>[0];
    let trace = world.trace(query);
    if (trace.solidity !== "clear") trace = { ...world.trace({ ...query, end: entity.r.currentOrigin }), fraction: 0 };
    else entity.r.currentOrigin = { ...trace.end };
    world.link(entity);
    if (trace.fraction !== 1) {
      if (trace.surfaceFlags & SURF_NOIMPACT) {
        const client = entity.parent?.client;
        if (client !== undefined && client !== null && client.hook === entity) client.hook = null;
        combat.entities.free(entity); return;
      }
      this.impact(entity, trace);
      if (entity.s.eType !== EntityType.ET_MISSILE) return;
    }
    if (this.host.missionpack !== null && entity.s.weapon === Weapon.WP_PROX_LAUNCHER && entity.count === 0) {
      const body = world.trace({ start: entity.r.currentOrigin, end: entity.r.currentOrigin,
        shape: { kind: "box", mins: entity.r.mins, maxs: entity.r.maxs },
        passEntityNum: ENTITYNUM_NONE, mask: entity.clipmask });
      if (body.solidity === "clear" || body.entityNum !== entity.r.ownerNum) entity.count = 1;
    }
    runThink(entity, combat.time);
  }

  hookFree(entity: GameEntity): void {
    this.owned(entity);
    const client = clientOf(parentOf(entity)); client.hook = null; client.ps.pmFlags &= ~MoveFlags.GRAPPLE_PULL;
    this.host.combat.entities.free(entity);
  }

  hookThink(entity: GameEntity): void {
    this.owned(entity);
    if (entity.enemy !== null) setOrigin(entity, snapVectorTowards(center(entity.enemy), entity.r.currentOrigin));
    clientOf(parentOf(entity)).ps.grapplePoint = { ...entity.r.currentOrigin };
  }

  private proximityExplode(mine: GameEntity): void {
    this.explode(mine);
    if (mine.activator !== null) { this.host.combat.entities.free(mine.activator); mine.activator = null; }
  }

  private proximityDie(mine: GameEntity): void {
    mine.think = self => { this.proximityExplode(self); }; mine.nextthink = (this.host.combat.time + 1) | 0;
  }

  private proximityTrigger(trigger: GameEntity, other: GameEntity): void {
    if (other.client === null) return;
    const mine = parentOf(trigger), combat = this.host.combat;
    if (length3(sub3(trigger.s.pos.base, other.s.pos.base)) > mine.splashRadius) return;
    if (combat.gameType >= GameType.GT_TEAM && mine.s.generic1 === other.client.sess.sessionTeam) return;
    if (!canDamage(combat, other, trigger.s.pos.base)) return;
    mine.s.loopSound = 0; combat.entities.addEvent(mine, EntityEvent.EV_PROXIMITY_MINE_TRIGGER);
    mine.nextthink = (combat.time + 500) | 0; combat.entities.free(trigger);
  }

  private proximityActivate(mine: GameEntity): void {
    const services = this.missionpack(), combat = this.host.combat;
    mine.think = self => { this.proximityExplode(self); }; mine.nextthink = (combat.time + services.proxMineTimeout) | 0;
    mine.takedamage = true; mine.health = 1; mine.die = self => { this.proximityDie(self); };
    mine.s.loopSound = services.soundIndex("sound/weapons/proxmine/wstbtick.wav");
    const trigger = combat.entities.spawn(), radius = Math.fround(mine.splashRadius);
    trigger.classname = "proxmine_trigger"; trigger.r.mins = vec3(-radius, -radius, -radius); trigger.r.maxs = vec3(radius, radius, radius);
    setOrigin(trigger, mine.s.pos.base); trigger.parent = mine; trigger.r.contents = 0x40000000;
    trigger.touch = this.proximityTouch;
    this.host.world.link(trigger); mine.activator = trigger;
  }

  private proximityExplodeOnPlayer(mine: GameEntity): void {
    const player = mine.enemy;
    if (player === null) throw new Error("Attached proximity mine requires its player");
    const client = clientOf(player), combat = this.host.combat;
    client.ps.eFlags &= ~EF_TICKING;
    if (client.invulnerabilityTime > combat.time) {
      damage(combat, player, parentOf(mine), parentOf(mine), vec3(0, 0, 0), mine.s.origin, 1000, DamageFlags.NO_KNOCKBACK, 27);
      client.invulnerabilityTime = 0; combat.entities.tempEntity(client.ps.origin, EntityEvent.EV_JUICED);
    } else {
      setOrigin(mine, player.s.pos.base); mine.r.svFlags &= ~ServerEntityFlags.NOCLIENT;
      mine.splashMethodOfDeath = 25; this.explode(mine);
    }
  }

  private proximityPlayer(mine: GameEntity, player: GameEntity): void {
    if (mine.s.eFlags & EF_NODRAW) return;
    const combat = this.host.combat; combat.entities.addEvent(mine, EntityEvent.EV_PROXIMITY_MINE_STICK);
    if (player.s.eFlags & EF_TICKING) {
      if (player.activator === null) throw new Error("Ticking player requires its proximity mine");
      player.activator.splashDamage = (player.activator.splashDamage + mine.splashDamage) | 0;
      player.activator.splashRadius = Math.fround(player.activator.splashRadius * Math.fround(1.5));
      mine.think = self => { combat.entities.free(self); }; mine.nextthink = combat.time; return;
    }
    const client = clientOf(player); client.ps.eFlags |= EF_TICKING; player.activator = mine;
    mine.s.eFlags |= EF_NODRAW; mine.r.svFlags |= ServerEntityFlags.NOCLIENT;
    mine.s.pos = { ...mine.s.pos, type: TrajectoryType.TR_LINEAR, delta: vec3(0, 0, 0) };
    mine.enemy = player; mine.think = self => { this.proximityExplodeOnPlayer(self); };
    mine.nextthink = (combat.time + (client.invulnerabilityTime > combat.time ? 2000 : 10000)) | 0;
  }

  private launch(self: GameEntity, start: Vec3, direction: Vec3, weapon: Weapon, classname: string, speed: number,
    duration: number, gravity: boolean, direct: number, splash: number, radius: number, method: number, splashMethod: number): GameEntity {
    this.owned(self);
    const time = this.host.combat.time, bolt = this.host.combat.entities.spawn();
    bolt.classname = classname; bolt.nextthink = (time + duration) | 0; bolt.think = entity => { this.explode(entity); };
    bolt.s.eType = EntityType.ET_MISSILE; bolt.r.svFlags = ServerEntityFlags.USE_CURRENT_ORIGIN; bolt.s.weapon = weapon;
    bolt.r.ownerNum = self.s.number; bolt.parent = self; bolt.damage = direct; bolt.splashDamage = splash; bolt.splashRadius = radius;
    bolt.methodOfDeath = method; bolt.splashMethodOfDeath = splashMethod; bolt.clipmask = MASK_SHOT; bolt.targetEnt = null;
    bolt.s.pos = { ...bolt.s.pos, type: gravity ? TrajectoryType.TR_GRAVITY : TrajectoryType.TR_LINEAR,
      time: (time - 50) | 0, base: vec3(start.x, start.y, start.z), delta: snapVector(scale3(direction, speed)) };
    bolt.r.currentOrigin = vec3(start.x, start.y, start.z); return bolt;
  }

  firePlasma(self: GameEntity, start: Vec3, direction: MissileDirection): GameEntity {
    return this.launch(self, start, normalizeDirection(direction), Weapon.WP_PLASMAGUN, "plasma", 2000, 10000, false, 20, 15, 20, 8, 9);
  }
  fireGrenade(self: GameEntity, start: Vec3, direction: MissileDirection): GameEntity {
    const bolt = this.launch(self, start, normalizeDirection(direction), Weapon.WP_GRENADE_LAUNCHER, "grenade", 700, 2500, true, 100, 100, 150, 4, 5);
    bolt.s.eFlags = EF_BOUNCE_HALF; return bolt;
  }
  fireRocket(self: GameEntity, start: Vec3, direction: MissileDirection): GameEntity {
    return this.launch(self, start, normalizeDirection(direction), Weapon.WP_ROCKET_LAUNCHER, "rocket", 900, 15000, false, 100, 100, 120, 6, 7);
  }
  fireBfg(self: GameEntity, start: Vec3, direction: MissileDirection): GameEntity {
    return this.launch(self, start, normalizeDirection(direction), Weapon.WP_BFG, "bfg", 2000, 10000, false, 100, 100, 120, 12, 13);
  }
  fireGrapple(self: GameEntity, start: Vec3, direction: MissileDirection): GameEntity {
    const bolt = this.launch(self, start, normalizeDirection(direction), Weapon.WP_GRAPPLING_HOOK, "hook", 800, 10000, false, 0, 0, 0,
      this.host.combat.product === "baseq3" ? 23 : 28, 0);
    bolt.think = entity => { this.hookFree(entity); }; bolt.s.otherEntityNum = self.s.number; clientOf(self).hook = bolt; return bolt;
  }
  fireProx(self: GameEntity, start: Vec3, direction: MissileDirection): GameEntity {
    this.missionpack();
    const bolt = this.launch(self, start, normalizeDirection(direction), Weapon.WP_PROX_LAUNCHER, "prox mine", 700, 3000, true, 0, 100, 150, 25, 25);
    bolt.s.generic1 = clientOf(self).sess.sessionTeam; return bolt;
  }
  fireNail(self: GameEntity, start: Vec3, forward: Vec3, right: Vec3, up: Vec3): GameEntity {
    const random = this.missionpack().random;
    const bolt = this.launch(self, start, vec3(0, 0, 0), Weapon.WP_NAILGUN, "nail", 0, 10000, false, 20, 0, 0, 23, 0);
    const angle = Math.fround(Math.fround(random.random() * Math.fround(Math.PI)) * 2);
    const vertical = Math.fround(Math.fround(Math.fround(Math.fround(Math.sin(angle)) * random.crandom()) * 500) * 16);
    const horizontal = Math.fround(Math.fround(Math.fround(Math.fround(Math.cos(angle)) * random.crandom()) * 500) * 16);
    const end = add3(add3(add3(start, scale3(forward, 8192 * 16)), scale3(right, horizontal)), scale3(up, vertical));
    const direction = normalize3(sub3(end, start));
    const speed = Math.fround(555 + Math.fround(random.random() * 1800));
    bolt.s.pos = { ...bolt.s.pos, time: this.host.combat.time, delta: snapVector(scale3(direction, speed)) };
    return bolt;
  }
}
