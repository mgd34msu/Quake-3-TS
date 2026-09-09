// Ported from id Software's game/g_weapon.c and g_combat.c ray/invulnerability helpers.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, cross3, dot3, length3, normalize3, normalize3OrZero, perpendicularVector, scale3, sub3, vec3, vectorToAngles } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { Vec3 } from "../core/math.ts";
import { qCrandom, qvmFloatToInt } from "../core/numeric.ts";
import type { ServerTraceResult } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Powerup, Weapon } from "../shared/definitions.ts";
import { directionToByte } from "../shared/direction-byte.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../shared/player-state.ts";
import { damage, DamageFlags } from "./combat.ts";
import { setOrigin } from "./entities.ts";
import type { EntityPool } from "./entities.ts";
import { snapVector, snapVectorTowards } from "./missile.ts";
import type { MissileDirection, MissileRuntime } from "./missile.ts";
import type { GameRandom } from "./numeric.ts";
import { MAX_CLIENTS } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";

const MASK_SHOT = 0x6000001, SURF_NOIMPACT = 0x10;
const AWARD_FLAGS = 0x8 | 0x40 | 0x800 | 0x8000 | 0x10000 | 0x20000;

/** quadFactor is read for each attack; random shares the map RNG used by missiles. */
export interface WeaponHost {
  readonly missiles: MissileRuntime;
  readonly quadFactor: number;
  readonly random: Pick<GameRandom, "rand" | "random" | "crandom">;
}

export type SphereIntersections = readonly [] | readonly [Vec3] | readonly [Vec3, Vec3];
export type InvulnerabilityImpact = { readonly kind: "miss" } |
  { readonly kind: "hit"; readonly impactPoint: Vec3; readonly bounceDirection: Vec3 };

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Weapon attack requires a client entity");
  return entity.client;
}

function normal(trace: ServerTraceResult): Vec3 {
  return trace.contact.kind === "plane" ? trace.contact.plane.normal : vec3(0, 0, 0);
}

/** Source normalizes dir in place, retains intersection order, and does not reject negative ray times. */
export function raySphereIntersections(origin: Vec3, radius: number, point: Vec3, direction: MissileDirection): SphereIntersections {
  const dir = normalize3(vec3(direction.x, direction.y, direction.z));
  direction.x = dir.x; direction.y = dir.y; direction.z = dir.z;
  const offset = sub3(point, origin);
  const b = Math.fround(2 * dot3(dir, offset));
  const c = Math.fround(dot3(offset, offset) - Math.fround(radius * radius));
  const discriminant = Math.fround(Math.fround(b * b) - Math.fround(4 * c));
  if (discriminant > 0) {
    const root = Math.fround(Math.sqrt(discriminant));
    const first = Math.fround(Math.fround(-b + root) / 2), second = Math.fround(Math.fround(-b - root) / 2);
    return [add3(point, scale3(dir, first)), add3(point, scale3(dir, second))];
  }
  if (discriminant === 0) return [add3(point, scale3(dir, Math.fround(-b / 2)))];
  return [];
}

export function invulnerabilityEffect(pool: EntityPool, target: GameEntity, direction: Vec3, point: Vec3): InvulnerabilityImpact {
  if (pool.options.product !== "missionpack") throw new Error("Invulnerability effects require missionpack");
  if (target.client === null) return { kind: "miss" };
  const backwards = { x: -direction.x, y: -direction.y, z: -direction.z };
  const intersections = raySphereIntersections(target.client.ps.origin, 42, point, backwards);
  const impactPoint = intersections[0];
  if (impactPoint === undefined) return { kind: "miss" };
  const impact = pool.tempEntity(target.client.ps.origin, EntityEvent.EV_INVUL_IMPACT);
  const offset = sub3(impactPoint, target.client.ps.origin), angles = vectorToAngles(offset);
  let pitch = Math.fround(angles.x + 90);
  if (pitch > 360) pitch = Math.fround(pitch - 360);
  impact.s.angles = vec3(pitch, angles.y, angles.z);
  return { kind: "hit", impactPoint, bounceDirection: normalize3(offset) };
}

export function logAccuracyHit(gameType: number, target: GameEntity, attacker: GameEntity): boolean {
  return target.takedamage && target !== attacker && target.client !== null && attacker.client !== null &&
    target.client.ps.health > 0 && (gameType < GameType.GT_TEAM || target.client.sess.sessionTeam !== attacker.client.sess.sessionTeam);
}

function bounceProjectile(start: Vec3, impact: Vec3, direction: Vec3): Vec3 {
  const incoming = sub3(impact, start);
  const reflection = add3(incoming, scale3(direction, Math.fround(-2 * dot3(incoming, direction))));
  return add3(impact, scale3(normalize3(reflection), 8192));
}

interface Attack {
  forward: MissileDirection;
  readonly right: Vec3;
  readonly up: Vec3;
  muzzle: Vec3;
  readonly quad: number;
}

export class WeaponRuntime {
  constructor(readonly host: WeaponHost) {}

  private owned(entity: GameEntity): void {
    if (this.host.missiles.host.combat.entities.get(entity.slot) !== entity) throw new Error("Weapon entity does not belong to this pool");
  }

  private quad(entity: GameEntity): number {
    const client = clientOf(entity);
    let factor = client.ps.powerups.get(Powerup.PW_QUAD) ? Math.fround(this.host.quadFactor) : 1;
    if (this.host.missiles.host.combat.product === "missionpack" && client.persistantPowerup?.item?.tag === Powerup.PW_DOUBLER) factor = Math.fround(factor * 2);
    return factor;
  }

  private attack(entity: GameEntity, quad: number): Attack {
    const client = clientOf(entity), vectors = qvmAngleVectors(client.ps.viewangles);
    const eye = vec3(entity.s.pos.base.x, entity.s.pos.base.y, Math.fround(entity.s.pos.base.z + client.ps.viewheight));
    // CalcMuzzlePointOrigin deliberately ignores oldOrigin, exactly like CalcMuzzlePoint.
    return { ...vectors, forward: { ...vectors.forward }, muzzle: snapVector(add3(eye, scale3(vectors.forward, 14))), quad };
  }

  private trace(entity: GameEntity, start: Vec3, end: Vec3, pass = entity.s.number): ServerTraceResult {
    return this.host.missiles.host.world.trace({ start, end, shape: { kind: "point" }, passEntityNum: pass, mask: MASK_SHOT });
  }

  private scaled(amount: number, attack: Attack): number { return qvmFloatToInt(Math.fround(Math.fround(amount) * attack.quad)); }

  checkGauntletAttack(entity: GameEntity): boolean {
    this.owned(entity);
    const combat = this.host.missiles.host.combat, pool = combat.entities, attack = this.attack(entity, 1);
    const trace = this.trace(entity, attack.muzzle, add3(attack.muzzle, scale3(attack.forward, 32)));
    if (trace.surfaceFlags & SURF_NOIMPACT) return false;
    const target = pool.at(trace.entityNum);
    if (target.takedamage && target.client !== null) {
      const event = pool.tempEntity(trace.end, EntityEvent.EV_MISSILE_HIT);
      event.s.otherEntityNum = target.s.number; event.s.eventParm = directionToByte(normal(trace)); event.s.weapon = entity.s.weapon;
    }
    if (!target.takedamage) return false;
    if (clientOf(entity).ps.powerups.get(Powerup.PW_QUAD)) pool.addEvent(entity, EntityEvent.EV_POWERUP_QUAD);
    damage(combat, target, entity, entity, attack.forward, trace.end, this.scaled(50, { ...attack, quad: this.quad(entity) }), 0, 2);
    return true;
  }

  fire(entity: GameEntity): void {
    this.owned(entity);
    const client = clientOf(entity), missiles = this.host.missiles, combat = missiles.host.combat;
    const quad = this.quad(entity);
    if (entity.s.weapon !== Weapon.WP_GRAPPLING_HOOK && entity.s.weapon !== Weapon.WP_GAUNTLET) {
      client.accuracyShots = (client.accuracyShots + (combat.product === "missionpack" && entity.s.weapon === Weapon.WP_NAILGUN ? 15 : 1)) | 0;
    }
    const attack = this.attack(entity, quad);
    const multiply = (projectile: GameEntity): void => {
      projectile.damage = this.scaled(projectile.damage, attack); projectile.splashDamage = this.scaled(projectile.splashDamage, attack);
    };
    switch (entity.s.weapon) {
      case Weapon.WP_GAUNTLET: return; // Source Weapon_Gauntlet has an empty body; contact is checked before pmove.
      case Weapon.WP_LIGHTNING: this.lightning(entity, attack); return;
      case Weapon.WP_SHOTGUN: this.shotgun(entity, attack); return;
      case Weapon.WP_MACHINEGUN: this.bullet(entity, attack, 200, combat.gameType === GameType.GT_TEAM ? 5 : 7); return;
      case Weapon.WP_GRENADE_LAUNCHER:
        attack.forward = { ...normalize3(vec3(attack.forward.x, attack.forward.y, Math.fround(attack.forward.z + Math.fround(0.2)))) };
        multiply(missiles.fireGrenade(entity, attack.muzzle, attack.forward)); return;
      case Weapon.WP_ROCKET_LAUNCHER: multiply(missiles.fireRocket(entity, attack.muzzle, attack.forward)); return;
      case Weapon.WP_PLASMAGUN: multiply(missiles.firePlasma(entity, attack.muzzle, attack.forward)); return;
      case Weapon.WP_RAILGUN: this.railgun(entity, attack); return;
      case Weapon.WP_BFG: multiply(missiles.fireBfg(entity, attack.muzzle, attack.forward)); return;
      case Weapon.WP_GRAPPLING_HOOK:
        if (!client.fireHeld && client.hook === null) missiles.fireGrapple(entity, attack.muzzle, attack.forward);
        client.fireHeld = true; return;
      case Weapon.WP_NAILGUN:
        if (combat.product === "missionpack") for (let count = 0; count < 15; count++) multiply(missiles.fireNail(entity, attack.muzzle, attack.forward, attack.right, attack.up));
        return;
      case Weapon.WP_PROX_LAUNCHER:
        if (combat.product === "missionpack") {
          attack.forward = { ...normalize3(vec3(attack.forward.x, attack.forward.y, Math.fround(attack.forward.z + Math.fround(0.2)))) };
          multiply(missiles.fireProx(entity, attack.muzzle, attack.forward));
        }
        return;
      case Weapon.WP_CHAINGUN: if (combat.product === "missionpack") this.bullet(entity, attack, 600, 7); return;
      case Weapon.WP_NONE: return;
    }
  }

  private bullet(entity: GameEntity, attack: Attack, spread: number, amount: number): void {
    const combat = this.host.missiles.host.combat, pool = combat.entities, random = this.host.random;
    const angle = Math.fround(Math.fround(random.random() * Math.fround(Math.PI)) * 2);
    const vertical = Math.fround(Math.fround(Math.fround(Math.fround(Math.sin(angle)) * random.crandom()) * spread) * 16);
    const horizontal = Math.fround(Math.fround(Math.fround(Math.fround(Math.cos(angle)) * random.crandom()) * spread) * 16);
    let end = add3(add3(add3(attack.muzzle, scale3(attack.forward, 131072)), scale3(attack.right, horizontal)), scale3(attack.up, vertical));
    let pass = entity.s.number;
    for (let count = 0; count < 10; count++) {
      const trace = this.trace(entity, attack.muzzle, end, pass);
      if (trace.surfaceFlags & SURF_NOIMPACT) return;
      const target = pool.at(trace.entityNum), point = snapVectorTowards(trace.end, attack.muzzle);
      const flesh = target.takedamage && target.client !== null;
      const event = pool.tempEntity(point, flesh ? EntityEvent.EV_BULLET_HIT_FLESH : EntityEvent.EV_BULLET_HIT_WALL);
      event.s.eventParm = flesh ? target.s.number : directionToByte(normal(trace)); event.s.otherEntityNum = entity.s.number;
      if (flesh && logAccuracyHit(combat.gameType, target, entity)) clientOf(entity).accuracyHits = (clientOf(entity).accuracyHits + 1) | 0;
      if (target.takedamage) {
        if (combat.product === "missionpack" && target.client !== null && target.client.invulnerabilityTime > combat.time) {
          const impact = invulnerabilityEffect(pool, target, attack.forward, point);
          if (impact.kind === "hit") {
            end = bounceProjectile(attack.muzzle, impact.impactPoint, impact.bounceDirection); attack.muzzle = impact.impactPoint; pass = ENTITYNUM_NONE;
          } else { attack.muzzle = point; pass = target.s.number; }
          continue;
        }
        damage(combat, target, entity, entity, attack.forward, point, this.scaled(amount, attack), 0, 3);
      }
      break;
    }
  }

  private pellet(entity: GameEntity, attack: Attack, start: Vec3, end: Vec3): boolean {
    const combat = this.host.missiles.host.combat, pool = combat.entities;
    let pass = entity.s.number;
    for (let count = 0; count < 10; count++) {
      const trace = this.trace(entity, start, end, pass), target = pool.at(trace.entityNum);
      if (trace.surfaceFlags & SURF_NOIMPACT) return false;
      if (target.takedamage) {
        if (combat.product === "missionpack" && target.client !== null && target.client.invulnerabilityTime > combat.time) {
          const impact = invulnerabilityEffect(pool, target, attack.forward, trace.end);
          if (impact.kind === "hit") { end = bounceProjectile(start, impact.impactPoint, impact.bounceDirection); start = impact.impactPoint; pass = ENTITYNUM_NONE; }
          else { start = trace.end; pass = target.s.number; }
          continue;
        }
        damage(combat, target, entity, entity, attack.forward, trace.end, this.scaled(10, attack), 0, 1);
        return logAccuracyHit(combat.gameType, target, entity);
      }
      return false;
    }
    return false;
  }

  private shotgun(entity: GameEntity, attack: Attack): void {
    const combat = this.host.missiles.host.combat, event = combat.entities.tempEntity(attack.muzzle, EntityEvent.EV_SHOTGUN);
    event.s.origin2 = snapVector(scale3(attack.forward, 4096)); event.s.eventParm = this.host.random.rand() & 255;
    event.s.otherEntityNum = entity.s.number;
    const forward = normalize3OrZero(event.s.origin2), right = perpendicularVector(forward), up = cross3(forward, right);
    let seed = event.s.eventParm, hitClient = false;
    for (let count = 0; count < 11; count++) {
      const r = qCrandom(seed), u = qCrandom(r.seed); seed = u.seed;
      const horizontal = Math.fround(Math.fround(r.value * 700) * 16), vertical = Math.fround(Math.fround(u.value * 700) * 16);
      const end = add3(add3(add3(event.s.pos.base, scale3(forward, 131072)), scale3(right, horizontal)), scale3(up, vertical));
      if (this.pellet(entity, attack, event.s.pos.base, end) && !hitClient) {
        hitClient = true; clientOf(entity).accuracyHits = (clientOf(entity).accuracyHits + 1) | 0;
      }
    }
  }

  private railTrail(entity: GameEntity, attack: Attack, point: Vec3, parameter: number): void {
    const event = this.host.missiles.host.combat.entities.tempEntity(point, EntityEvent.EV_RAILTRAIL);
    event.s.clientNum = entity.s.clientNum;
    event.s.origin2 = add3(add3(attack.muzzle, scale3(attack.right, 4)), scale3(attack.up, -1)); event.s.eventParm = parameter;
  }

  private railgun(entity: GameEntity, attack: Attack): void {
    const combat = this.host.missiles.host.combat, world = this.host.missiles.host.world, pool = combat.entities;
    let end = add3(attack.muzzle, scale3(attack.forward, 8192)), pass = entity.s.number, hits = 0;
    const unlinked: GameEntity[] = [];
    let trace: ServerTraceResult;
    do {
      trace = this.trace(entity, attack.muzzle, end, pass);
      if (trace.entityNum >= ENTITYNUM_WORLD) break;
      const target = pool.at(trace.entityNum);
      if (target.takedamage) {
        if (combat.product === "missionpack" && target.client !== null && target.client.invulnerabilityTime > combat.time) {
          const impact = invulnerabilityEffect(pool, target, attack.forward, trace.end);
          if (impact.kind === "hit") {
            end = bounceProjectile(attack.muzzle, impact.impactPoint, impact.bounceDirection);
            trace = { ...trace, end: snapVectorTowards(trace.end, attack.muzzle) };
            this.railTrail(entity, attack, trace.end, 255);
            attack.muzzle = impact.impactPoint; pass = ENTITYNUM_NONE;
          }
        } else {
          if (logAccuracyHit(combat.gameType, target, entity)) hits++;
          damage(combat, target, entity, entity, attack.forward, trace.end, this.scaled(100, attack), 0, 10);
        }
      }
      if (trace.contents & 1) break;
      world.unlink(target.slot); unlinked.push(target);
    } while (unlinked.length < 4);
    for (const target of unlinked) world.link(target);
    this.railTrail(entity, attack, snapVectorTowards(trace.end, attack.muzzle), trace.surfaceFlags & SURF_NOIMPACT ? 255 : directionToByte(normal(trace)));
    const client = clientOf(entity);
    if (hits === 0) client.accurateCount = 0;
    else {
      client.accurateCount = (client.accurateCount + hits) | 0;
      if (client.accurateCount >= 2) {
        client.accurateCount = (client.accurateCount - 2) | 0;
        client.ps.persistant.set(PersistentIndex.PERS_IMPRESSIVE_COUNT, client.ps.persistant.get(PersistentIndex.PERS_IMPRESSIVE_COUNT) + 1);
        client.ps.eFlags = (client.ps.eFlags & ~AWARD_FLAGS) | 0x8000; client.rewardTime = (combat.time + 2000) | 0;
      }
      client.accuracyHits = (client.accuracyHits + 1) | 0;
    }
  }

  private lightning(entity: GameEntity, attack: Attack): void {
    const combat = this.host.missiles.host.combat, pool = combat.entities;
    let pass = entity.s.number;
    for (let count = 0; count < 10; count++) {
      const trace = this.trace(entity, attack.muzzle, add3(attack.muzzle, scale3(attack.forward, 768)), pass);
      if (combat.product === "missionpack" && count !== 0) pool.tempEntity(attack.muzzle, EntityEvent.EV_LIGHTNINGBOLT).s.origin2 = snapVector(trace.end);
      if (trace.entityNum === ENTITYNUM_NONE) return;
      const target = pool.at(trace.entityNum);
      if (target.takedamage) {
        if (combat.product === "missionpack" && target.client !== null && target.client.invulnerabilityTime > combat.time) {
          const impact = invulnerabilityEffect(pool, target, attack.forward, trace.end);
          if (impact.kind === "hit") {
            const end = bounceProjectile(attack.muzzle, impact.impactPoint, impact.bounceDirection);
            attack.muzzle = impact.impactPoint; attack.forward = { ...normalize3(sub3(end, impact.impactPoint)) }; pass = ENTITYNUM_NONE;
          } else { attack.muzzle = trace.end; pass = target.s.number; }
          continue;
        }
        damage(combat, target, entity, entity, attack.forward, trace.end, this.scaled(8, attack), 0, 11);
      }
      if (target.takedamage && target.client !== null) {
        const event = pool.tempEntity(trace.end, EntityEvent.EV_MISSILE_HIT);
        event.s.otherEntityNum = target.s.number; event.s.eventParm = directionToByte(normal(trace)); event.s.weapon = entity.s.weapon;
        if (logAccuracyHit(combat.gameType, target, entity)) clientOf(entity).accuracyHits = (clientOf(entity).accuracyHits + 1) | 0;
      } else if (!(trace.surfaceFlags & SURF_NOIMPACT)) pool.tempEntity(trace.end, EntityEvent.EV_MISSILE_MISS).s.eventParm = directionToByte(normal(trace));
      break;
    }
  }

  startKamikaze(entity: GameEntity): GameEntity {
    this.owned(entity);
    const combat = this.host.missiles.host.combat, pool = combat.entities;
    if (combat.product !== "missionpack") throw new Error("Kamikaze requires missionpack");
    const explosion = pool.spawn(); explosion.s.eType = EntityType.ET_EVENTS + EntityEvent.EV_KAMIKAZE; explosion.eventTime = combat.time;
    const source = entity.client !== null ? entity : entity.activator;
    if (source === null) throw new Error("Kamikaze timer requires its activator");
    const position = snapVector(source.s.pos.base); setOrigin(explosion, position); explosion.classname = "kamikaze";
    explosion.kamikazeTime = combat.time; explosion.think = self => { this.kamikazeDamage(self); }; explosion.nextthink = (combat.time + 100) | 0;
    explosion.count = 0; explosion.movedir = vec3(0, 0, 0); this.host.missiles.host.world.link(explosion);
    if (entity.client !== null) {
      explosion.activator = entity; entity.s.eFlags &= ~0x200;
      damage(combat, entity, entity, entity, null, null, 100000, DamageFlags.NO_PROTECTION, 26);
    } else explosion.activator = source.classname === "bodyque" ? pool.at(source.r.ownerNum) : source;
    const event = pool.tempEntity(position, EntityEvent.EV_GLOBAL_TEAM_SOUND); event.r.svFlags |= ServerEntityFlags.BROADCAST; event.s.eventParm = 13;
    return explosion;
  }

  private kamikazeArea(origin: Vec3, attacker: GameEntity | null, amount: number, radius: number, shock: boolean): void {
    const combat = this.host.missiles.host.combat, world = this.host.missiles.host.world;
    radius = Math.max(1, Math.fround(radius));
    const extent = vec3(radius, radius, radius);
    const candidates = world.areaEntities({ min: sub3(origin, extent), max: add3(origin, extent) });
    for (const number of candidates) {
      const target = combat.entities.at(number);
      if (shock ? target.kamikazeShockTime > combat.time : !target.takedamage || target.kamikazeTime > combat.time) continue;
      const link = world.linkState(number);
      if (link === undefined) throw new Error("Kamikaze area query returned an unlinked entity");
      const axis = (p: number, min: number, max: number): number => p < min ? min - p : p > max ? p - max : 0;
      const dist = length3(vec3(axis(origin.x, link.absbounds.min.x, link.absbounds.max.x), axis(origin.y, link.absbounds.min.y, link.absbounds.max.y), axis(origin.z, link.absbounds.min.z, link.absbounds.max.z)));
      if (dist >= radius) continue;
      const offset = sub3(target.r.currentOrigin, origin), direction = { x: offset.x, y: offset.y, z: Math.fround(offset.z + 24) };
      damage(combat, target, null, attacker, direction, origin, amount, DamageFlags.RADIUS | DamageFlags.NO_TEAM_PROTECTION, 26);
      if (shock) {
        const horizontal = normalize3(vec3(direction.x, direction.y, 0));
        if (target.client !== null) target.client.ps.velocity = vec3(Math.fround(horizontal.x * 400), Math.fround(horizontal.y * 400), 100);
        target.kamikazeShockTime = (combat.time + 3000) | 0;
      } else target.kamikazeTime = (combat.time + 3000) | 0;
    }
  }

  private kamikazeDamage(entity: GameEntity): void {
    const combat = this.host.missiles.host.combat, random = this.host.random;
    entity.count = (entity.count + 100) | 0;
    if (entity.count >= 0) this.kamikazeArea(entity.s.pos.base, entity.activator, 25, Math.trunc(Math.imul(entity.count, 1320) / 2000), true);
    if (entity.count >= 250) this.kamikazeArea(entity.s.pos.base, entity.activator, 400, Math.trunc(Math.imul(entity.count - 250, 720) / 1750), false);
    if (entity.count >= 2000) { combat.entities.free(entity); return; }
    entity.nextthink = (combat.time + 100) | 0;
    const angles = vec3(Math.fround(random.crandom() * 2), Math.fround(random.crandom() * 2), 0);
    const short = (angle: number): number => qvmFloatToInt(Math.fround(Math.fround(angle * 65536) / 360)) & 65535;
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const target = combat.entities.at(index), client = target.client;
      if (!target.inuse || client === null) continue;
      if (client.ps.groundEntityNum !== ENTITYNUM_NONE) client.ps.velocity = vec3(
        Math.fround(client.ps.velocity.x + Math.fround(random.crandom() * 120)),
        Math.fround(client.ps.velocity.y + Math.fround(random.crandom() * 120)),
        Math.fround(30 + Math.fround(random.random() * 25)));
      const delta = sub3(angles, entity.movedir), old = client.ps.deltaAngles;
      client.ps.deltaAngles = { x: (old.x + short(delta.x)) | 0, y: (old.y + short(delta.y)) | 0, z: (old.z + short(delta.z)) | 0 };
    }
    entity.movedir = angles;
  }
}
