// Ported from id Software's code/game/g_misc.c spawn wrappers and shooters.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, cross3, normalize3, perpendicularVector, scale3, sub3 } from "../core/math.ts";
import { EntityEvent, Weapon } from "../shared/definitions.ts";
import { findItemForWeapon } from "../shared/items.ts";
import { setOrigin } from "./entities.ts";
import type { EntityPool } from "./entities.ts";
import type { ItemRegistry } from "./item-lifecycle.ts";
import { spawnPortalCamera, spawnPortalSurface } from "./misc.ts";
import type { MissileDirection, MissileRuntime } from "./missile.ts";
import type { GameRandom } from "./numeric.ts";
import type { SpawnHandler, SpawnVariables } from "./spawn.ts";
import type { GameEntity } from "./state.ts";
import { moveDirection, pickTarget } from "./utilities.ts";
import type { TargetSelectionContext } from "./utilities.ts";
import type { ServerWorld } from "../server/world.ts";

const f32 = Math.fround;

export interface MiscSpawnHost {
  readonly missiles: MissileRuntime;
  readonly itemRegistry: ItemRegistry;
  readonly random: Pick<GameRandom, "rand" | "crandom">;
  warn(message: string): void;
}

class MiscSpawns {
  constructor(readonly host: MiscSpawnHost) {
    if (host.itemRegistry.product !== host.missiles.host.combat.product) {
      throw new Error("Misc spawn item registry does not match its missile product");
    }
  }

  private get pool(): EntityPool { return this.host.missiles.host.combat.entities; }
  private get world(): ServerWorld { return this.host.missiles.host.world; }
  private get time(): number { return this.host.missiles.host.combat.time; }

  private owned(entity: GameEntity): void {
    if (this.pool.get(entity.slot) !== entity) {
      throw new Error("Misc spawn entity does not belong to its entity pool or was replaced");
    }
  }

  private selection(): TargetSelectionContext {
    return { pool: this.pool, randomInt: () => this.host.random.rand(),
      warn: (message: string): void => { this.host.warn(message); } };
  }

  infoCamp(entity: GameEntity): void {
    this.owned(entity);
    setOrigin(entity, entity.s.origin);
  }

  infoNull(entity: GameEntity): void {
    this.owned(entity);
    this.pool.free(entity);
  }

  infoNotNull(entity: GameEntity): void {
    this.owned(entity);
    setOrigin(entity, entity.s.origin);
  }

  light(entity: GameEntity): void {
    this.owned(entity);
    this.pool.free(entity);
  }

  teleporterDestination(entity: GameEntity): void {
    this.owned(entity);
    // SP_misc_teleporter_dest intentionally retains the spawn-boundary state unchanged.
  }

  model(entity: GameEntity): void {
    this.owned(entity);
    this.pool.free(entity);
  }

  portalSurface(entity: GameEntity): void {
    this.owned(entity);
    spawnPortalSurface({ pool: this.pool, world: this.world, time: this.time,
      randomInt: () => this.host.random.rand(), warn: message => { this.host.warn(message); } }, entity);
  }

  portalCamera(entity: GameEntity, variables: SpawnVariables): void {
    this.owned(entity);
    spawnPortalCamera(this.world, entity, variables.float("roll", "0").value);
  }

  private crandom(): number {
    const value = this.host.random.crandom();
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw new RangeError("Shooter crandom() must return a value within [-1, 1]");
    }
    return f32(value);
  }

  private fire(entity: GameEntity, direction: MissileDirection): void {
    switch (entity.s.weapon) {
      case Weapon.WP_GRENADE_LAUNCHER: this.host.missiles.fireGrenade(entity, entity.s.origin, direction); break;
      case Weapon.WP_ROCKET_LAUNCHER: this.host.missiles.fireRocket(entity, entity.s.origin, direction); break;
      case Weapon.WP_PLASMAGUN: this.host.missiles.firePlasma(entity, entity.s.origin, direction); break;
    }
  }

  private useShooter(entity: GameEntity): void {
    this.owned(entity);
    const initial = entity.enemy === null ? entity.movedir : normalize3(sub3(entity.enemy.r.currentOrigin, entity.s.origin));
    const up = perpendicularVector(initial);
    const right = cross3(up, initial);
    const vertical = f32(this.crandom() * f32(entity.random));
    const withVertical = add3(initial, scale3(up, vertical));
    const horizontal = f32(this.crandom() * f32(entity.random));
    const direction = normalize3(add3(withVertical, scale3(right, horizontal)));
    this.fire(entity, { x: direction.x, y: direction.y, z: direction.z });
    this.pool.addEvent(entity, EntityEvent.EV_FIRE_WEAPON, 0);
  }

  private finishShooter(entity: GameEntity): void {
    entity.enemy = pickTarget(this.selection(), entity.target);
    entity.think = null;
    entity.nextthink = 0;
  }

  shooter(entity: GameEntity, weapon: Weapon): void {
    this.owned(entity);
    entity.use = self => { this.useShooter(self); };
    entity.s.weapon = weapon;
    this.host.itemRegistry.register(findItemForWeapon(this.pool.options.product, weapon));
    const moved = moveDirection(entity.s.angles);
    entity.movedir = moved.direction;
    entity.s.angles = moved.angles;
    if (entity.random === 0) entity.random = 1;
    const radians = f32(f32(f32(Math.PI) * f32(entity.random)) / f32(180));
    entity.random = f32(Math.sin(radians));
    if (entity.target !== null) {
      entity.think = self => { this.finishShooter(self); };
      entity.nextthink = (this.time + 500) | 0;
    }
    this.pool.options.link(entity);
  }
}

/** Spawn table entries for the remaining concrete g_misc.c map entities. */
export function miscSpawnHandlers(host: MiscSpawnHost): ReadonlyMap<string, SpawnHandler> {
  const spawns = new MiscSpawns(host);
  return new Map<string, SpawnHandler>([
    ["info_camp", entity => { spawns.infoCamp(entity); }],
    ["info_null", entity => { spawns.infoNull(entity); }],
    ["info_notnull", entity => { spawns.infoNotNull(entity); }],
    ["light", entity => { spawns.light(entity); }],
    ["misc_teleporter_dest", entity => { spawns.teleporterDestination(entity); }],
    ["misc_model", entity => { spawns.model(entity); }],
    ["misc_portal_surface", entity => { spawns.portalSurface(entity); }],
    ["misc_portal_camera", (entity, variables) => { spawns.portalCamera(entity, variables); }],
    ["shooter_rocket", entity => { spawns.shooter(entity, Weapon.WP_ROCKET_LAUNCHER); }],
    ["shooter_plasma", entity => { spawns.shooter(entity, Weapon.WP_PLASMAGUN); }],
    ["shooter_grenade", entity => { spawns.shooter(entity, Weapon.WP_GRENADE_LAUNCHER); }],
  ]);
}
