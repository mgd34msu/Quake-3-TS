// Ported from id Software's code/game/g_combat.c: scoring, item tossing,
// death, gibbing, almost-score rewards and kamikaze death timers.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { length3, scale3, sub3, vec3, vectorToAngles } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, GIB_HEALTH, MissionpackStatIndex, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState, statSchema } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { findItem, findItemForPowerup, findItemForWeapon } from "../shared/items.ts";
import { ENTITYNUM_WORLD, PlayerAnimation } from "../shared/player-state.ts";
import type { PlayerStateSlots } from "../shared/player-state.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { dropItem, launchItem } from "./item-motion.ts";
import type { DropItemContext, LaunchItemContext } from "./item-motion.ts";
import type { MissileRuntime } from "./missile.ts";
import type { GameRandom } from "./numeric.ts";
import { ConnectionState, GameFlags, MAX_CLIENTS, MAX_GENTITIES } from "./state.ts";
import type { EntityDie, GameClient, GameEntity } from "./state.ts";
import { findEntity } from "./utilities.ts";

const CONTENTS_CORPSE = 0x4000000, CONTENTS_TRIGGER = 0x40000000, CONTENTS_NODROP = 0x80000000;
const EF_KAMIKAZE = 0x200, EF_TICKING = 0x2, EF_NODRAW = 0x80;
const AWARD_MASK = 0x8 | 0x40 | 0x800 | 0x8000 | 0x10000 | 0x20000;
const MOD_GAUNTLET = 2, MOD_SUICIDE = 20;
const COMMON_MOD_NAMES = ["MOD_UNKNOWN", "MOD_SHOTGUN", "MOD_GAUNTLET", "MOD_MACHINEGUN",
  "MOD_GRENADE", "MOD_GRENADE_SPLASH", "MOD_ROCKET", "MOD_ROCKET_SPLASH", "MOD_PLASMA",
  "MOD_PLASMA_SPLASH", "MOD_RAILGUN", "MOD_LIGHTNING", "MOD_BFG", "MOD_BFG_SPLASH",
  "MOD_WATER", "MOD_SLIME", "MOD_LAVA", "MOD_CRUSH", "MOD_TELEFRAG", "MOD_FALLING",
  "MOD_SUICIDE", "MOD_TARGET_LASER", "MOD_TRIGGER_HURT"];

export interface DeathFrame {
  readonly time: number;
  readonly gameType: number;
  readonly warmupTime: number;
  readonly intermissionTime: number;
  readonly blood: boolean;
}

interface DeathServices {
  readonly pool: EntityPool;
  readonly world: ServerWorld;
  readonly random: GameRandom;
  /** The same four-entry level.teamScores storage used by team rules and ranks. */
  readonly teamScores: PlayerStateSlots;
  readonly missiles: Pick<MissileRuntime, "hookFree">;
  readonly items: Pick<LaunchItemContext, "touchItem" | "droppedFlagThink" | "checkDroppedTeamItem">;
  frame(): DeathFrame;
  calculateRanks(): void;
  sendScoreboard(entity: GameEntity): void;
  log(message: string): void;
  teamFragBonuses(victim: GameEntity, inflictor: GameEntity | null, attacker: GameEntity | null): void;
  returnFlag(team: Team): void;
}

export type DeathHost = DeathServices & (
  | { readonly product: "baseq3" }
  | { readonly product: "missionpack";
    neutralObelisk(): GameEntity | null;
    cubeTimeoutSeconds(): number;
    startKamikaze(timer: GameEntity): void;
  }
);

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Death operation requires a client entity");
  return entity.client;
}

/** Owns the source static death-animation counter for one loaded game instance. */
export class DeathRuntime {
  #deathAnimation = 0;
  readonly #modNames: readonly string[];

  constructor(readonly host: DeathHost) {
    if (host.teamScores.length !== 4) throw new RangeError("Death scoring requires four shared team-score slots");
    if (host.pool.options.product !== host.product) throw new Error("Death product does not match its entity pool");
    this.#modNames = [...COMMON_MOD_NAMES,
      ...(host.product === "missionpack" ? ["MOD_NAIL", "MOD_CHAINGUN", "MOD_PROXIMITY_MINE", "MOD_KAMIKAZE", "MOD_JUICED"] : []),
      "MOD_GRAPPLE"];
  }

  private dropContext(): DropItemContext {
    const frame = this.host.frame();
    return { entities: this.host.pool, product: this.host.product, time: frame.time, gameType: frame.gameType,
      touchItem: this.host.items.touchItem, droppedFlagThink: this.host.items.droppedFlagThink,
      checkDroppedTeamItem: this.host.items.checkDroppedTeamItem, random: () => this.host.random.random() };
  }

  scorePlum(entity: GameEntity, origin: Vec3, score: number): void {
    const plum = this.host.pool.tempEntity(origin, EntityEvent.EV_SCOREPLUM);
    plum.r.svFlags |= ServerEntityFlags.SINGLECLIENT;
    plum.r.singleClient = entity.s.number;
    plum.s.otherEntityNum = entity.s.number;
    plum.s.time = score;
  }

  addScore(entity: GameEntity, origin: Vec3, score: number): void {
    const client = entity.client, frame = this.host.frame();
    if (client === null || frame.warmupTime !== 0) return;
    this.scorePlum(entity, origin, score);
    const persistent = client.ps.persistant;
    persistent.set(PersistentIndex.PERS_SCORE, persistent.get(PersistentIndex.PERS_SCORE) + score);
    if (frame.gameType === GameType.GT_TEAM) {
      const team = persistent.get(PersistentIndex.PERS_TEAM);
      this.host.teamScores.set(team, this.host.teamScores.get(team) + score);
    }
    this.host.calculateRanks();
  }

  tossClientItems(entity: GameEntity): void {
    const client = clientOf(entity), context = this.dropContext();
    let weapon = entity.s.weapon;
    if (weapon === Weapon.WP_MACHINEGUN || weapon === Weapon.WP_GRAPPLING_HOOK) {
      if (client.ps.weaponState === WeaponState.WEAPON_DROPPING) weapon = client.pers.cmd.weapon;
      if (!(client.ps.stats.get(statSchema(this.host.product).weapons) & (1 << weapon))) weapon = Weapon.WP_NONE;
    }
    if (weapon > Weapon.WP_MACHINEGUN && weapon !== Weapon.WP_GRAPPLING_HOOK && client.ps.ammo.get(weapon) !== 0) {
      dropItem(context, entity, findItemForWeapon(this.host.product, weapon), 0);
    }
    if (context.gameType === GameType.GT_TEAM) return;
    let angle = 45;
    for (let powerup = 1; powerup < Powerup.PW_NUM_POWERUPS; powerup++) {
      const expires = client.ps.powerups.get(powerup);
      if (expires <= context.time) continue;
      const item = findItemForPowerup(this.host.product, powerup);
      if (item === null) continue;
      const dropped = dropItem(context, entity, item, angle);
      dropped.count = Math.max(1, Math.trunc(((expires - context.time) | 0) / 1000));
      angle = Math.fround(angle + 45);
    }
  }

  tossClientCubes(entity: GameEntity): void {
    const host = this.host;
    if (host.product !== "missionpack") throw new Error("TossClientCubes requires missionpack");
    const client = clientOf(entity), time = host.frame().time;
    client.ps.generic1 = 0;
    if (!host.pool.entitiesFree()) return;
    const item = findItem(host.product, client.sess.sessionTeam === Team.TEAM_RED ? "Red Cube" : "Blue Cube");
    if (item === null) throw new Error("Missing source Harvester cube item");
    const forward = scale3(qvmAngleVectors(vec3(0, time % 360, 0)).forward, 150);
    const velocity = vec3(forward.x, forward.y, Math.fround(forward.z + Math.fround(200 + Math.fround(host.random.crandom() * 50))));
    const obelisk = host.neutralObelisk();
    const origin = obelisk === null ? vec3(0, 0, 0) : vec3(obelisk.s.pos.base.x, obelisk.s.pos.base.y, obelisk.s.pos.base.z + 44);
    const dropped = launchItem(this.dropContext(), item, origin, velocity);
    dropped.nextthink = (time + Math.imul(host.cubeTimeoutSeconds(), 1000)) | 0;
    dropped.think = self => { host.pool.free(self); };
    dropped.spawnflags = client.sess.sessionTeam;
  }

  tossClientPersistantPowerups(entity: GameEntity): void {
    if (this.host.product !== "missionpack") throw new Error("Persistent powerup tossing requires missionpack");
    const client = entity.client;
    if (client === null || client.persistantPowerup === null) return;
    const powerup = client.persistantPowerup;
    powerup.r.svFlags &= ~ServerEntityFlags.NOCLIENT;
    powerup.s.eFlags &= ~EF_NODRAW;
    powerup.r.contents = CONTENTS_TRIGGER;
    this.host.world.link(powerup);
    client.ps.stats.set(MissionpackStatIndex.STAT_PERSISTANT_POWERUP, 0);
    client.persistantPowerup = null;
  }

  lookAtKiller(self: GameEntity, inflictor: GameEntity | null, attacker: GameEntity | null): void {
    const target = attacker !== null && attacker !== self ? attacker : inflictor !== null && inflictor !== self ? inflictor : null;
    const yaw = target === null ? self.s.angles.y : vectorToAngles(sub3(target.s.pos.base, self.s.pos.base)).y;
    // STAT_DEAD_YAW is an int, with the QVM CVFI conversion before storage.
    const integer = yaw >= -2147483648 && yaw < 2147483648 ? Math.trunc(yaw) : -2147483648;
    clientOf(self).ps.stats.set(statSchema(this.host.product).deadYaw, integer);
  }

  gibEntity(self: GameEntity, killer: number): void {
    if (self.s.eFlags & EF_KAMIKAZE) {
      for (let index = 0; index < MAX_GENTITIES; index++) {
        const timer = this.host.pool.at(index);
        if (!timer.inuse || timer.activator !== self || timer.classname !== "kamikaze timer") continue;
        this.host.pool.free(timer); break;
      }
    }
    this.host.pool.addEvent(self, EntityEvent.EV_GIB_PLAYER, killer);
    self.takedamage = false;
    self.s.eType = EntityType.ET_INVISIBLE;
    self.r.contents = 0;
  }

  readonly bodyDie: EntityDie = self => {
    if (self.health > GIB_HEALTH) return;
    if (!this.host.frame().blood) { self.health = GIB_HEALTH + 1; return; }
    this.gibEntity(self, 0);
  };

  private kamikazeDeathTimer(self: GameEntity): void {
    const host = this.host;
    if (host.product !== "missionpack") throw new Error("Kamikaze death timer requires missionpack");
    const timer = host.pool.spawn();
    timer.classname = "kamikaze timer";
    timer.s.pos = { ...timer.s.pos, base: { ...self.s.pos.base } };
    timer.r.svFlags |= ServerEntityFlags.NOCLIENT;
    timer.think = entity => { host.startKamikaze(entity); host.pool.free(entity); };
    timer.nextthink = (host.frame().time + 5000) | 0;
    timer.activator = self;
  }

  private almostReward(self: GameEntity, attacker: GameEntity | null): void {
    const persistent = clientOf(self).ps.persistant;
    persistent.set(PersistentIndex.PERS_PLAYEREVENTS, persistent.get(PersistentIndex.PERS_PLAYEREVENTS) ^ 4);
    if (attacker === null) throw new Error("Source almost-score reward dereferences a null attacker");
    if (attacker.client !== null) {
      const attackerPersistent = attacker.client.ps.persistant;
      attackerPersistent.set(PersistentIndex.PERS_PLAYEREVENTS, attackerPersistent.get(PersistentIndex.PERS_PLAYEREVENTS) ^ 4);
    }
  }

  private checkAlmostCapture(self: GameEntity, attacker: GameEntity | null): void {
    const client = clientOf(self);
    if (!(client.ps.powerups.get(Powerup.PW_REDFLAG) || client.ps.powerups.get(Powerup.PW_BLUEFLAG) || client.ps.powerups.get(Powerup.PW_NEUTRALFLAG))) return;
    const blue = client.sess.sessionTeam === Team.TEAM_BLUE, ctf = this.host.frame().gameType === GameType.GT_CTF;
    const classname = (ctf ? blue : !blue) ? "team_CTF_blueflag" : "team_CTF_redflag";
    let goal: GameEntity | null = null;
    do { goal = findEntity(this.host.pool, goal, "classname", classname); }
    while (goal !== null && (goal.flags & GameFlags.DROPPED_ITEM));
    if (goal !== null && !(goal.r.svFlags & ServerEntityFlags.NOCLIENT) && length3(sub3(client.ps.origin, goal.s.origin)) < 200) {
      this.almostReward(self, attacker);
    }
  }

  private checkAlmostScored(self: GameEntity, attacker: GameEntity | null): void {
    const client = clientOf(self);
    if (client.ps.generic1 === 0) return;
    const classname = client.sess.sessionTeam === Team.TEAM_BLUE ? "team_redobelisk" : "team_blueobelisk";
    const goal = findEntity(this.host.pool, null, "classname", classname);
    if (goal !== null && length3(sub3(client.ps.origin, goal.s.origin)) < 200) this.almostReward(self, attacker);
  }

  private carriedFlag(self: GameEntity): { readonly team: Team; readonly powerup: Powerup } | null {
    const powerups = clientOf(self).ps.powerups;
    if (powerups.get(Powerup.PW_NEUTRALFLAG)) return { team: Team.TEAM_FREE, powerup: Powerup.PW_NEUTRALFLAG };
    if (powerups.get(Powerup.PW_REDFLAG)) return { team: Team.TEAM_RED, powerup: Powerup.PW_REDFLAG };
    if (powerups.get(Powerup.PW_BLUEFLAG)) return { team: Team.TEAM_BLUE, powerup: Powerup.PW_BLUEFLAG };
    return null;
  }

  readonly playerDie = (self: GameEntity, inflictor: GameEntity | null, attacker: GameEntity | null,
    _damage: number, meansOfDeath: number): void => {
    const client = clientOf(self), frame = this.host.frame();
    if (client.ps.pmType === MoveType.PM_DEAD || frame.intermissionTime !== 0) return;
    this.checkAlmostCapture(self, attacker);
    this.checkAlmostScored(self, attacker);
    if (client.hook !== null) this.host.missiles.hookFree(client.hook);
    if (this.host.product === "missionpack" && (client.ps.eFlags & EF_TICKING) && self.activator !== null) {
      client.ps.eFlags &= ~EF_TICKING;
      self.activator.think = entity => { this.host.pool.free(entity); };
      self.activator.nextthink = frame.time;
    }
    client.ps.pmType = MoveType.PM_DEAD;
    let killer = attacker === null ? ENTITYNUM_WORLD : attacker.s.number;
    let killerName = attacker === null ? "<world>" : attacker.client === null ? "<non-client>" : attacker.client.pers.netname;
    if (killer < 0 || killer >= MAX_CLIENTS) { killer = ENTITYNUM_WORLD; killerName = "<world>"; }
    const obituary = this.#modNames[meansOfDeath] ?? "<bad obituary>";
    this.host.log(gameFormat("Kill: %i %i %i: %s killed %s by %s\n", [killer, self.s.number, meansOfDeath, killerName, client.pers.netname, obituary]));
    const obituaryEvent = this.host.pool.tempEntity(self.r.currentOrigin, EntityEvent.EV_OBITUARY);
    obituaryEvent.s.eventParm = meansOfDeath;
    obituaryEvent.s.otherEntityNum = self.s.number;
    obituaryEvent.s.otherEntityNum2 = killer;
    obituaryEvent.r.svFlags = ServerEntityFlags.BROADCAST;
    self.enemy = attacker;
    client.ps.persistant.set(PersistentIndex.PERS_KILLED, client.ps.persistant.get(PersistentIndex.PERS_KILLED) + 1);
    if (attacker !== null && attacker.client !== null) {
      const killerClient = attacker.client;
      killerClient.lastKilledClient = self.s.number;
      const sameTeam = frame.gameType >= GameType.GT_TEAM && client.sess.sessionTeam === killerClient.sess.sessionTeam;
      if (attacker === self || sameTeam) this.addScore(attacker, self.r.currentOrigin, -1);
      else {
        this.addScore(attacker, self.r.currentOrigin, 1);
        if (meansOfDeath === MOD_GAUNTLET) {
          killerClient.ps.persistant.set(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT, killerClient.ps.persistant.get(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT) + 1);
          killerClient.ps.eFlags = (killerClient.ps.eFlags & ~AWARD_MASK) | 0x40;
          killerClient.rewardTime = (frame.time + 2000) | 0;
          client.ps.persistant.set(PersistentIndex.PERS_PLAYEREVENTS, client.ps.persistant.get(PersistentIndex.PERS_PLAYEREVENTS) ^ 2);
        }
        if (((frame.time - killerClient.lastKillTime) | 0) < 3000) {
          killerClient.ps.persistant.set(PersistentIndex.PERS_EXCELLENT_COUNT, killerClient.ps.persistant.get(PersistentIndex.PERS_EXCELLENT_COUNT) + 1);
          killerClient.ps.eFlags = (killerClient.ps.eFlags & ~AWARD_MASK) | 0x8;
          killerClient.rewardTime = (frame.time + 2000) | 0;
        }
        killerClient.lastKillTime = frame.time;
      }
    } else this.addScore(self, self.r.currentOrigin, -1);
    this.host.teamFragBonuses(self, inflictor, attacker);
    if (meansOfDeath === MOD_SUICIDE) {
      const flag = this.carriedFlag(self);
      if (flag !== null) { this.host.returnFlag(flag.team); client.ps.powerups.set(flag.powerup, 0); }
    }
    const contents = this.host.world.pointContents(self.r.currentOrigin, -1);
    if (!(contents & CONTENTS_NODROP)) this.tossClientItems(self);
    else {
      const flag = this.carriedFlag(self);
      if (flag !== null) this.host.returnFlag(flag.team);
    }
    if (this.host.product === "missionpack") {
      this.tossClientPersistantPowerups(self);
      if (frame.gameType === GameType.GT_HARVESTER) this.tossClientCubes(self);
    }
    this.host.sendScoreboard(self);
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const follower = this.host.pool.clientAt(index);
      if (follower.pers.connected === ConnectionState.CONNECTED && follower.sess.sessionTeam === Team.TEAM_SPECTATOR &&
        follower.sess.spectatorClient === self.s.number) this.host.sendScoreboard(this.host.pool.at(index));
    }
    self.takedamage = true;
    self.s.weapon = Weapon.WP_NONE;
    self.s.powerups = 0;
    self.r.contents = CONTENTS_CORPSE;
    self.s.angles = vec3(0, self.s.angles.y, 0);
    this.lookAtKiller(self, inflictor, attacker);
    client.ps.viewangles = { ...self.s.angles };
    self.s.loopSound = 0;
    self.r.maxs = vec3(self.r.maxs.x, self.r.maxs.y, -8);
    client.respawnTime = (frame.time + 1700) | 0;
    for (let index = 0; index < client.ps.powerups.length; index++) client.ps.powerups.set(index, 0);
    if ((self.health <= GIB_HEALTH && !(contents & CONTENTS_NODROP) && frame.blood) || meansOfDeath === MOD_SUICIDE) {
      this.gibEntity(self, killer);
    } else {
      const animation = this.#deathAnimation === 0 ? PlayerAnimation.BOTH_DEATH1 : this.#deathAnimation === 1 ? PlayerAnimation.BOTH_DEATH2 : PlayerAnimation.BOTH_DEATH3;
      if (self.health <= GIB_HEALTH) self.health = GIB_HEALTH + 1;
      client.ps.legsAnim = ((client.ps.legsAnim & 128) ^ 128) | animation;
      client.ps.torsoAnim = ((client.ps.torsoAnim & 128) ^ 128) | animation;
      this.host.pool.addEvent(self, EntityEvent.EV_DEATH1 + this.#deathAnimation, killer);
      self.die = this.bodyDie;
      this.#deathAnimation = (this.#deathAnimation + 1) % 3;
      if (this.host.product === "missionpack" && (self.s.eFlags & EF_KAMIKAZE)) this.kamikazeDeathTimer(self);
    }
    this.host.world.link(self);
  };
}
