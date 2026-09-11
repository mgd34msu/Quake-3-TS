// Ported from id Software's code/game/g_rankings.c: G_RankFireWeapon through
// G_RankUserTeamName. Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { GameType, Holdable, Powerup, Weapon } from "../shared/definitions.ts";
import { ENTITYNUM_WORLD } from "../shared/player-state.ts";
import type { GameRuntime } from "./runtime.ts";
import * as keys from "./rank-keys.ts";

// code/game/bg_public.h meansOfDeath_t. MOD_GRAPPLE is product dependent.
const MOD_UNKNOWN = 0, MOD_SHOTGUN = 1, MOD_GAUNTLET = 2, MOD_MACHINEGUN = 3;
const MOD_GRENADE = 4, MOD_GRENADE_SPLASH = 5, MOD_ROCKET = 6, MOD_ROCKET_SPLASH = 7;
const MOD_PLASMA = 8, MOD_PLASMA_SPLASH = 9, MOD_RAILGUN = 10, MOD_LIGHTNING = 11;
const MOD_BFG = 12, MOD_BFG_SPLASH = 13, MOD_WATER = 14, MOD_SLIME = 15;
const MOD_LAVA = 16, MOD_CRUSH = 17, MOD_TELEFRAG = 18, MOD_FALLING = 19;
const MOD_SUICIDE = 20, MOD_TRIGGER_HURT = 22;
const EF_AWARD_EXCELLENT = 0x00000008, EF_AWARD_IMPRESSIVE = 0x00008000;

export interface RankReportConsumer {
  reportInt(self: number, other: number, key: number, value: number, accumulate: number): void;
  reportString(self: number, other: number, key: number, value: string): void;
}
/** The supplied g_local.h lacks the weapon_change_time field used by this body.
 * The caller must supply its storage; this is not an integrated client field. */
export interface RankWeaponClock {
  weapon_change_time: number;
}
/** Callable report bodies only. No service authentication, transport, or gameplay hooks.
 * Retain one instance for the loaded game module's damage static-state lifetime. */
export class GameRankReports {
  private last_framenum = -1;
  private last_self = -1;
  private last_attacker = -1;
  private last_means_of_death = MOD_UNKNOWN;
  private readonly grappleMod: number;
  constructor(private readonly game: Pick<GameRuntime, "level" | "pool" | "gameType" | "product">, private readonly reports: RankReportConsumer) {
    this.grappleMod = game.product === "missionpack" ? 28 : 23;
  }
  private sameTeam(self: number, attacker: number): boolean {
    const first = this.game.pool.at(self), second = this.game.pool.at(attacker);
    if (first.client === null || second.client === null)
      return false;
    if (this.game.gameType < GameType.GT_TEAM)
      return false;
    return first.client.sess.sessionTeam === second.client.sess.sessionTeam;
  }
  fireWeapon(self: number, weapon: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    if (weapon === Weapon.WP_GAUNTLET) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED, 1, 1);
    switch (weapon) {
      case Weapon.WP_MACHINEGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_MACHINEGUN, 1, 1);
        break;
      case Weapon.WP_SHOTGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_SHOTGUN, 1, 1);
        break;
      case Weapon.WP_GRENADE_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_GRENADE, 1, 1);
        break;
      case Weapon.WP_ROCKET_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_ROCKET, 1, 1);
        break;
      case Weapon.WP_LIGHTNING:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_LIGHTNING, 1, 1);
        break;
      case Weapon.WP_RAILGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_RAILGUN, 1, 1);
        break;
      case Weapon.WP_PLASMAGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_PLASMA, 1, 1);
        break;
      case Weapon.WP_BFG:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_BFG, 1, 1);
        break;
      case Weapon.WP_GRAPPLING_HOOK:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SHOT_FIRED_GRAPPLE, 1, 1);
        break;
      default:
        break;
    }
  }
  damage(self: number, attacker: number, damage: number, means_of_death: number): void {
    let new_hit: boolean;
    let splash: number;
    let key_hit: number;
    let key_damage: number;
    let key_splash = -1;
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    new_hit = (this.game.level.frameNum !== this.last_framenum) ||
      (self !== this.last_self) ||
      (attacker !== this.last_attacker) ||
      (means_of_death !== this.last_means_of_death);
    this.last_framenum = this.game.level.frameNum;
    this.last_self = self;
    this.last_attacker = attacker;
    this.last_means_of_death = means_of_death;
    if ((attacker !== ENTITYNUM_WORLD) && (attacker !== self) &&
      (means_of_death === MOD_GAUNTLET) &&
      (this.game.pool.at(attacker).client !== null)) {
      this.reports.reportInt(attacker, -1, keys.QGR_KEY_SHOT_FIRED_GAUNTLET, 1, 1);
    }
    switch (means_of_death) {
      case MOD_WATER:
      case MOD_SLIME:
      case MOD_LAVA:
      case MOD_CRUSH:
      case MOD_TELEFRAG:
      case MOD_FALLING:
      case MOD_SUICIDE:
      case MOD_TRIGGER_HURT:
        return;
      default:
        break;
    }
    switch (means_of_death) {
      case MOD_GRENADE_SPLASH:
      case MOD_ROCKET_SPLASH:
      case MOD_PLASMA_SPLASH:
      case MOD_BFG_SPLASH:
        splash = damage;
        break;
      default:
        splash = 0;
        key_splash = -1;
        break;
    }
    switch (means_of_death) {
      case MOD_GAUNTLET:
        key_hit = keys.QGR_KEY_HIT_TAKEN_GAUNTLET;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_GAUNTLET;
        break;
      case MOD_MACHINEGUN:
        key_hit = keys.QGR_KEY_HIT_TAKEN_MACHINEGUN;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_MACHINEGUN;
        break;
      case MOD_SHOTGUN:
        key_hit = keys.QGR_KEY_HIT_TAKEN_SHOTGUN;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_SHOTGUN;
        break;
      case MOD_GRENADE:
      case MOD_GRENADE_SPLASH:
        key_hit = keys.QGR_KEY_HIT_TAKEN_GRENADE;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_GRENADE;
        key_splash = keys.QGR_KEY_SPLASH_TAKEN_GRENADE;
        break;
      case MOD_ROCKET:
      case MOD_ROCKET_SPLASH:
        key_hit = keys.QGR_KEY_HIT_TAKEN_ROCKET;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_ROCKET;
        key_splash = keys.QGR_KEY_SPLASH_TAKEN_ROCKET;
        break;
      case MOD_PLASMA:
      case MOD_PLASMA_SPLASH:
        key_hit = keys.QGR_KEY_HIT_TAKEN_PLASMA;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_PLASMA;
        key_splash = keys.QGR_KEY_SPLASH_TAKEN_PLASMA;
        break;
      case MOD_RAILGUN:
        key_hit = keys.QGR_KEY_HIT_TAKEN_RAILGUN;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_RAILGUN;
        break;
      case MOD_LIGHTNING:
        key_hit = keys.QGR_KEY_HIT_TAKEN_LIGHTNING;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_LIGHTNING;
        break;
      case MOD_BFG:
      case MOD_BFG_SPLASH:
        key_hit = keys.QGR_KEY_HIT_TAKEN_BFG;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_BFG;
        key_splash = keys.QGR_KEY_SPLASH_TAKEN_BFG;
        break;
      case this.grappleMod:
        key_hit = keys.QGR_KEY_HIT_TAKEN_GRAPPLE;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_GRAPPLE;
        break;
      default:
        key_hit = keys.QGR_KEY_HIT_TAKEN_UNKNOWN;
        key_damage = keys.QGR_KEY_DAMAGE_TAKEN_UNKNOWN;
        break;
    }
    if (new_hit) {
      this.reports.reportInt(self, -1, keys.QGR_KEY_HIT_TAKEN, 1, 1);
      this.reports.reportInt(self, -1, key_hit, 1, 1);
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_DAMAGE_TAKEN, damage, 1);
    this.reports.reportInt(self, -1, key_damage, damage, 1);
    if (splash !== 0) {
      this.reports.reportInt(self, -1, keys.QGR_KEY_SPLASH_TAKEN, splash, 1);
      this.reports.reportInt(self, -1, key_splash, splash, 1);
    }
    if ((attacker !== ENTITYNUM_WORLD) && (attacker !== self)) {
      switch (means_of_death) {
        case MOD_GAUNTLET:
          key_hit = keys.QGR_KEY_HIT_GIVEN_GAUNTLET;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_GAUNTLET;
          break;
        case MOD_MACHINEGUN:
          key_hit = keys.QGR_KEY_HIT_GIVEN_MACHINEGUN;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_MACHINEGUN;
          break;
        case MOD_SHOTGUN:
          key_hit = keys.QGR_KEY_HIT_GIVEN_SHOTGUN;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_SHOTGUN;
          break;
        case MOD_GRENADE:
        case MOD_GRENADE_SPLASH:
          key_hit = keys.QGR_KEY_HIT_GIVEN_GRENADE;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_GRENADE;
          key_splash = keys.QGR_KEY_SPLASH_GIVEN_GRENADE;
          break;
        case MOD_ROCKET:
        case MOD_ROCKET_SPLASH:
          key_hit = keys.QGR_KEY_HIT_GIVEN_ROCKET;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_ROCKET;
          key_splash = keys.QGR_KEY_SPLASH_GIVEN_ROCKET;
          break;
        case MOD_PLASMA:
        case MOD_PLASMA_SPLASH:
          key_hit = keys.QGR_KEY_HIT_GIVEN_PLASMA;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_PLASMA;
          key_splash = keys.QGR_KEY_SPLASH_GIVEN_PLASMA;
          break;
        case MOD_RAILGUN:
          key_hit = keys.QGR_KEY_HIT_GIVEN_RAILGUN;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_RAILGUN;
          break;
        case MOD_LIGHTNING:
          key_hit = keys.QGR_KEY_HIT_GIVEN_LIGHTNING;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_LIGHTNING;
          break;
        case MOD_BFG:
        case MOD_BFG_SPLASH:
          key_hit = keys.QGR_KEY_HIT_GIVEN_BFG;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_BFG;
          key_splash = keys.QGR_KEY_SPLASH_GIVEN_BFG;
          break;
        case this.grappleMod:
          key_hit = keys.QGR_KEY_HIT_GIVEN_GRAPPLE;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_GRAPPLE;
          break;
        default:
          key_hit = keys.QGR_KEY_HIT_GIVEN_UNKNOWN;
          key_damage = keys.QGR_KEY_DAMAGE_GIVEN_UNKNOWN;
          break;
      }
      if (this.game.pool.at(attacker).client !== null) {
        if (new_hit) {
          this.reports.reportInt(attacker, -1, keys.QGR_KEY_HIT_GIVEN, 1, 1);
          this.reports.reportInt(attacker, -1, key_hit, 1, 1);
        }
        this.reports.reportInt(attacker, -1, keys.QGR_KEY_DAMAGE_GIVEN, damage, 1);
        this.reports.reportInt(attacker, -1, key_damage, damage, 1);
        if (splash !== 0) {
          this.reports.reportInt(attacker, -1, keys.QGR_KEY_SPLASH_GIVEN, splash, 1);
          this.reports.reportInt(attacker, -1, key_splash, splash, 1);
        }
      }
    }
    if ((attacker !== self) &&
      this.sameTeam(self, attacker) &&
      (this.game.pool.at(attacker).client !== null)) {
      if (new_hit) {
        this.reports.reportInt(self, -1, keys.QGR_KEY_TEAMMATE_HIT_TAKEN, 1, 1);
        this.reports.reportInt(attacker, -1, keys.QGR_KEY_TEAMMATE_HIT_GIVEN, 1, 1);
      }
      this.reports.reportInt(self, -1, keys.QGR_KEY_TEAMMATE_DAMAGE_TAKEN, damage, 1);
      this.reports.reportInt(attacker, -1, keys.QGR_KEY_TEAMMATE_DAMAGE_GIVEN, damage, 1);
      if (splash !== 0) {
        this.reports.reportInt(self, -1, keys.QGR_KEY_TEAMMATE_SPLASH_TAKEN, splash, 1);
        this.reports.reportInt(attacker, -1, keys.QGR_KEY_TEAMMATE_SPLASH_GIVEN, splash, 1);
      }
    }
  }
  playerDie(self: number, attacker: number, means_of_death: number): void {
    let p1: number;
    let p2: number;
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    if (attacker === ENTITYNUM_WORLD) {
      p1 = self;
      p2 = -1;
      this.reports.reportInt(p1, p2, keys.QGR_KEY_HAZARD_DEATH, 1, 1);
      switch (means_of_death) {
        case MOD_WATER:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_WATER, 1, 1);
          break;
        case MOD_SLIME:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SLIME, 1, 1);
          break;
        case MOD_LAVA:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_LAVA, 1, 1);
          break;
        case MOD_CRUSH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_CRUSH, 1, 1);
          break;
        case MOD_TELEFRAG:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_TELEFRAG, 1, 1);
          break;
        case MOD_FALLING:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FALLING, 1, 1);
          break;
        case MOD_SUICIDE:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_CMD, 1, 1);
          break;
        case MOD_TRIGGER_HURT:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_TRIGGER_HURT, 1, 1);
          break;
        default:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_HAZARD_MISC, 1, 1);
          break;
      }
    }
    else if (attacker === self) {
      p1 = self;
      p2 = -1;
      this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE, 1, 1);
      switch (means_of_death) {
        case MOD_GAUNTLET:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_GAUNTLET, 1, 1);
          break;
        case MOD_MACHINEGUN:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_MACHINEGUN, 1, 1);
          break;
        case MOD_SHOTGUN:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_SHOTGUN, 1, 1);
          break;
        case MOD_GRENADE:
        case MOD_GRENADE_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_GRENADE, 1, 1);
          break;
        case MOD_ROCKET:
        case MOD_ROCKET_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_ROCKET, 1, 1);
          break;
        case MOD_PLASMA:
        case MOD_PLASMA_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_PLASMA, 1, 1);
          break;
        case MOD_RAILGUN:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_RAILGUN, 1, 1);
          break;
        case MOD_LIGHTNING:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_LIGHTNING, 1, 1);
          break;
        case MOD_BFG:
        case MOD_BFG_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_BFG, 1, 1);
          break;
        case this.grappleMod:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_GRAPPLE, 1, 1);
          break;
        default:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_SUICIDE_UNKNOWN, 1, 1);
          break;
      }
    }
    else {
      p1 = attacker;
      p2 = self;
      this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG, 1, 1);
      switch (means_of_death) {
        case MOD_GAUNTLET:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_GAUNTLET, 1, 1);
          break;
        case MOD_MACHINEGUN:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_MACHINEGUN, 1, 1);
          break;
        case MOD_SHOTGUN:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_SHOTGUN, 1, 1);
          break;
        case MOD_GRENADE:
        case MOD_GRENADE_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_GRENADE, 1, 1);
          break;
        case MOD_ROCKET:
        case MOD_ROCKET_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_ROCKET, 1, 1);
          break;
        case MOD_PLASMA:
        case MOD_PLASMA_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_PLASMA, 1, 1);
          break;
        case MOD_RAILGUN:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_RAILGUN, 1, 1);
          break;
        case MOD_LIGHTNING:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_LIGHTNING, 1, 1);
          break;
        case MOD_BFG:
        case MOD_BFG_SPLASH:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_BFG, 1, 1);
          break;
        case this.grappleMod:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_GRAPPLE, 1, 1);
          break;
        default:
          this.reports.reportInt(p1, p2, keys.QGR_KEY_FRAG_UNKNOWN, 1, 1);
          break;
      }
    }
  }
  weaponTime(self: number, weapon: number, clock: RankWeaponClock): void {
    let time: number;
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    if (this.game.pool.at(self).client === null)
      throw new Error("G_RankWeaponTime requires a client");
    time = Math.trunc(((this.game.level.time - clock.weapon_change_time) | 0) / 1000);
    clock.weapon_change_time = this.game.level.time;
    if (time <= 0) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_TIME, time, 1);
    switch (weapon) {
      case Weapon.WP_GAUNTLET:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_GAUNTLET, time, 1);
        break;
      case Weapon.WP_MACHINEGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_MACHINEGUN, time, 1);
        break;
      case Weapon.WP_SHOTGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_SHOTGUN, time, 1);
        break;
      case Weapon.WP_GRENADE_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_GRENADE, time, 1);
        break;
      case Weapon.WP_ROCKET_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_ROCKET, time, 1);
        break;
      case Weapon.WP_LIGHTNING:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_LIGHTNING, time, 1);
        break;
      case Weapon.WP_RAILGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_RAILGUN, time, 1);
        break;
      case Weapon.WP_PLASMAGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_PLASMA, time, 1);
        break;
      case Weapon.WP_BFG:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_BFG, time, 1);
        break;
      case Weapon.WP_GRAPPLING_HOOK:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TIME_GRAPPLE, time, 1);
        break;
      default:
        break;
    }
  }
  pickupWeapon(self: number, weapon: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_WEAPON, 1, 1);
    switch (weapon) {
      case Weapon.WP_GAUNTLET:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_GAUNTLET, 1, 1);
        break;
      case Weapon.WP_MACHINEGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_MACHINEGUN, 1, 1);
        break;
      case Weapon.WP_SHOTGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_SHOTGUN, 1, 1);
        break;
      case Weapon.WP_GRENADE_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_GRENADE, 1, 1);
        break;
      case Weapon.WP_ROCKET_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_ROCKET, 1, 1);
        break;
      case Weapon.WP_LIGHTNING:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_LIGHTNING, 1, 1);
        break;
      case Weapon.WP_RAILGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_RAILGUN, 1, 1);
        break;
      case Weapon.WP_PLASMAGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_PLASMA, 1, 1);
        break;
      case Weapon.WP_BFG:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_BFG, 1, 1);
        break;
      case Weapon.WP_GRAPPLING_HOOK:
        this.reports.reportInt(self, -1, keys.QGR_KEY_PICKUP_GRAPPLE, 1, 1);
        break;
      default:
        break;
    }
  }
  pickupAmmo(self: number, weapon: number, quantity: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES, 1, 1);
    this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS, quantity, 1);
    switch (weapon) {
      case Weapon.WP_MACHINEGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_BULLETS, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_BULLETS, quantity, 1);
        break;
      case Weapon.WP_SHOTGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_SHELLS, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_SHELLS, quantity, 1);
        break;
      case Weapon.WP_GRENADE_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_GRENADES, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_GRENADES, quantity, 1);
        break;
      case Weapon.WP_ROCKET_LAUNCHER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_ROCKETS, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_ROCKETS, quantity, 1);
        break;
      case Weapon.WP_LIGHTNING:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_LG_AMMO, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_LG_AMMO, quantity, 1);
        break;
      case Weapon.WP_RAILGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_SLUGS, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_SLUGS, quantity, 1);
        break;
      case Weapon.WP_PLASMAGUN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_CELLS, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_CELLS, quantity, 1);
        break;
      case Weapon.WP_BFG:
        this.reports.reportInt(self, -1, keys.QGR_KEY_BOXES_BFG_AMMO, 1, 1);
        this.reports.reportInt(self, -1, keys.QGR_KEY_ROUNDS_BFG_AMMO, quantity, 1);
        break;
      default:
        break;
    }
  }
  pickupHealth(self: number, quantity: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_HEALTH, 1, 1);
    this.reports.reportInt(self, -1, keys.QGR_KEY_HEALTH_TOTAL, quantity, 1);
    switch (quantity) {
      case 5:
        this.reports.reportInt(self, -1, keys.QGR_KEY_HEALTH_5, 1, 1);
        break;
      case 25:
        this.reports.reportInt(self, -1, keys.QGR_KEY_HEALTH_25, 1, 1);
        break;
      case 50:
        this.reports.reportInt(self, -1, keys.QGR_KEY_HEALTH_50, 1, 1);
        break;
      case 100:
        this.reports.reportInt(self, -1, keys.QGR_KEY_HEALTH_MEGA, 1, 1);
        break;
      default:
        break;
    }
  }
  pickupArmor(self: number, quantity: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_ARMOR, 1, 1);
    this.reports.reportInt(self, -1, keys.QGR_KEY_ARMOR_TOTAL, quantity, 1);
    switch (quantity) {
      case 5:
        this.reports.reportInt(self, -1, keys.QGR_KEY_ARMOR_SHARD, 1, 1);
        break;
      case 50:
        this.reports.reportInt(self, -1, keys.QGR_KEY_ARMOR_YELLOW, 1, 1);
        break;
      case 100:
        this.reports.reportInt(self, -1, keys.QGR_KEY_ARMOR_RED, 1, 1);
        break;
      default:
        break;
    }
  }
  pickupPowerup(self: number, powerup: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    if ((powerup === Powerup.PW_REDFLAG) || (powerup === Powerup.PW_BLUEFLAG)) {
      this.reports.reportInt(self, -1, keys.QGR_KEY_FLAG_PICKUP, 1, 1);
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_POWERUP, 1, 1);
    switch (powerup) {
      case Powerup.PW_QUAD:
        this.reports.reportInt(self, -1, keys.QGR_KEY_QUAD, 1, 1);
        break;
      case Powerup.PW_BATTLESUIT:
        this.reports.reportInt(self, -1, keys.QGR_KEY_SUIT, 1, 1);
        break;
      case Powerup.PW_HASTE:
        this.reports.reportInt(self, -1, keys.QGR_KEY_HASTE, 1, 1);
        break;
      case Powerup.PW_INVIS:
        this.reports.reportInt(self, -1, keys.QGR_KEY_INVIS, 1, 1);
        break;
      case Powerup.PW_REGEN:
        this.reports.reportInt(self, -1, keys.QGR_KEY_REGEN, 1, 1);
        break;
      case Powerup.PW_FLIGHT:
        this.reports.reportInt(self, -1, keys.QGR_KEY_FLIGHT, 1, 1);
        break;
      default:
        break;
    }
  }
  pickupHoldable(self: number, holdable: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    switch (holdable) {
      case Holdable.HI_MEDKIT:
        this.reports.reportInt(self, -1, keys.QGR_KEY_MEDKIT, 1, 1);
        break;
      case Holdable.HI_TELEPORTER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TELEPORTER, 1, 1);
        break;
      default:
        break;
    }
  }
  useHoldable(self: number, holdable: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    switch (holdable) {
      case Holdable.HI_MEDKIT:
        this.reports.reportInt(self, -1, keys.QGR_KEY_MEDKIT_USE, 1, 1);
        break;
      case Holdable.HI_TELEPORTER:
        this.reports.reportInt(self, -1, keys.QGR_KEY_TELEPORTER_USE, 1, 1);
        break;
      default:
        break;
    }
  }
  reward(self: number, award: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    switch (award) {
      case EF_AWARD_IMPRESSIVE:
        this.reports.reportInt(self, -1, keys.QGR_KEY_IMPRESSIVE, 1, 1);
        break;
      case EF_AWARD_EXCELLENT:
        this.reports.reportInt(self, -1, keys.QGR_KEY_EXCELLENT, 1, 1);
        break;
      default:
        break;
    }
  }
  capture(self: number): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    this.reports.reportInt(self, -1, keys.QGR_KEY_FLAG_CAPTURE, 1, 1);
  }
  userTeamName(self: number, team_name: string): void {
    if (this.game.level.warmupTime !== 0) {
      return;
    }
    this.reports.reportString(self, -1, keys.QGR_KEY_TEAM_NAME, team_name);
  }
}
