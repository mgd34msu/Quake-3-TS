/*
 * Ported from id Software's game/g_client.c and g_team.c spawn selectors.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { add3, length3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, GameType, GIB_HEALTH, PersistentIndex, Team, Weapon, WeaponState, statSchema, weaponCount } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { ENTITYNUM_NONE, MoveFlags, PlayerAnimation } from "../shared/player-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import { playerStateToEntityState } from "../shared/snapshot-state.ts";
import { TrajectoryType } from "../shared/trajectory.ts";
import { clientEndFrame } from "./client-effects.ts";
import type { ClientEffectsContext } from "./client-effects.ts";
import type { ClientThinkRuntime } from "./client-think.ts";
import { setOrigin } from "./entities.ts";
import type { EntityPool } from "./entities.ts";
import { gameAtoi } from "./numeric.ts";
import type { GameRandom } from "./numeric.ts";
import type { SpawnVariables } from "./spawn.ts";
import { GameClient, GameFlags, MAX_GENTITIES, TeamState } from "./state.ts";
import type { EntityDie, GameEntity } from "./state.ts";
import { findEntity, useTargets } from "./utilities.ts";
import type { TargetUseContext } from "./utilities.ts";

const PLAYER_MINS = vec3(-15, -15, -24), PLAYER_MAXS = vec3(15, 15, 32);
const CONTENTS_BODY = 0x2000000, CONTENTS_CORPSE = 0x4000000, CONTENTS_NODROP = 0x80000000;
const EF_DEAD = 1, EF_TELEPORT_BIT = 4, EF_KAMIKAZE = 0x200, EF_VOTED = 0x4000, EF_TEAMVOTED = 0x80000;
export const BODY_QUEUE_SIZE = 8;

export interface SpawnPose { readonly origin: Vec3; readonly angles: Vec3 }
export interface SpawnPoint extends SpawnPose { readonly entity: GameEntity }
export interface ClientSpawnFrame {
  readonly time: number;
  readonly gameType: number;
  readonly inactivitySeconds: number;
  readonly intermissionTime: number;
}

/** Unported game rules remain required services; movement/effects are real existing modules. */
export interface ClientSpawnHost {
  readonly pool: EntityPool;
  readonly world: ServerWorld;
  readonly random: GameRandom;
  readonly think: ClientThinkRuntime;
  frame(): ClientSpawnFrame;
  userCommand(clientNum: number): UserCommand;
  handicap(clientNum: number): string;
  findIntermissionPoint(): SpawnPose;
  moveToIntermission(entity: GameEntity): void;
  killBox(entity: GameEntity): void;
  readonly playerDie: EntityDie;
  readonly bodyDie: EntityDie;
  effects(): ClientEffectsContext;
  targets(): TargetUseContext;
}

export function spawnDeathmatchPoint(entity: GameEntity, variables: SpawnVariables): void {
  if (variables.int("nobots", "0").value) entity.flags |= GameFlags.NO_BOTS;
  if (variables.int("nohumans", "0").value) entity.flags |= GameFlags.NO_HUMANS;
}

export function spawnPlayerStart(entity: GameEntity, variables: SpawnVariables): void {
  entity.classname = "info_player_deathmatch";
  spawnDeathmatchPoint(entity, variables);
}

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Client spawning requires a client entity");
  return entity.client;
}

/** QVM ANGLE2SHORT rounds both arithmetic operations before its integer conversion. */
export function setClientViewAngle(entity: GameEntity, angles: Vec3): void {
  const client = clientOf(entity);
  const delta = (angle: number, command: number): number => {
    const scaled = Math.fround(Math.fround(angle * 65536) / 360);
    const short = qvmFloatToInt(scaled) & 65535;
    return (short - command) | 0;
  };
  const command = client.pers.cmd.angles;
  client.ps.deltaAngles = { x: delta(angles.x, command.x), y: delta(angles.y, command.y), z: delta(angles.z, command.z) };
  entity.s.angles = vec3(angles.x, angles.y, angles.z);
  client.ps.viewangles = { ...entity.s.angles };
}

function pose(entity: GameEntity): SpawnPoint {
  return { entity, origin: add3(entity.s.origin, vec3(0, 0, 9)), angles: { ...entity.s.angles } };
}

export class ClientSpawnState {
  bodyQueue: { readonly entities: readonly GameEntity[]; index: number } | null = null;
}

export class ClientSpawnRuntime {
  constructor(readonly host: ClientSpawnHost, private readonly state = new ClientSpawnState()) {
    if (host.think.host.pool !== host.pool || host.think.host.world !== host.world) {
      throw new Error("Client spawning and thinking must share entity storage and world");
    }
  }

  private ownedClient(entity: GameEntity): GameClient {
    if (this.host.pool.get(entity.slot) !== entity || entity.slot >= this.host.pool.maxClients ||
      entity.client !== this.host.pool.clientAt(entity.slot)) throw new Error("Client does not belong to the configured pool slot");
    return clientOf(entity);
  }

  spotWouldTelefrag(spot: GameEntity): boolean {
    const bounds = { min: add3(spot.s.origin, PLAYER_MINS), max: add3(spot.s.origin, PLAYER_MAXS) };
    return this.host.world.areaEntities(bounds, MAX_GENTITIES).some(number => this.host.pool.at(number).client !== null);
  }

  selectNearestDeathmatchSpawnPoint(from: Vec3): GameEntity | null {
    let spot: GameEntity | null = null, nearest: GameEntity | null = null, nearestDistance = 999999;
    while ((spot = findEntity(this.host.pool, spot, "classname", "info_player_deathmatch")) !== null) {
      const distance = length3(sub3(spot.s.origin, from));
      if (distance < nearestDistance) { nearestDistance = distance; nearest = spot; }
    }
    return nearest;
  }

  selectRandomDeathmatchSpawnPoint(): GameEntity | null {
    const points: GameEntity[] = [];
    let spot: GameEntity | null = null;
    while ((spot = findEntity(this.host.pool, spot, "classname", "info_player_deathmatch")) !== null) {
      if (this.spotWouldTelefrag(spot)) continue;
      if (points.length === 128) throw new RangeError("SelectRandomDeathmatchSpawnPoint exceeds source 128-entry storage");
      points.push(spot);
    }
    if (points.length === 0) return findEntity(this.host.pool, null, "classname", "info_player_deathmatch");
    const chosen = points[this.host.random.rand() % points.length];
    if (chosen === undefined) throw new Error("Random spawn index invariant");
    return chosen;
  }

  /** SelectSpawnPoint selects from the farthest integer half, including random()=1. */
  selectSpawnPoint(avoid: Vec3): SpawnPoint {
    const points: { readonly entity: GameEntity; readonly distance: number }[] = [];
    let spot: GameEntity | null = null;
    while ((spot = findEntity(this.host.pool, spot, "classname", "info_player_deathmatch")) !== null) {
      if (this.spotWouldTelefrag(spot)) continue;
      const distance = length3(sub3(spot.s.origin, avoid));
      const insertion = points.findIndex(point => distance > point.distance);
      if (insertion >= 0) {
        points.splice(insertion, 0, { entity: spot, distance });
        if (points.length > 64) points.pop();
      } else if (points.length < 64) points.push({ entity: spot, distance });
    }
    if (points.length === 0) {
      const fallback = findEntity(this.host.pool, null, "classname", "info_player_deathmatch");
      if (fallback === null) throw new Error("Couldn't find a spawn point");
      return pose(fallback);
    }
    const index = Math.trunc(Math.fround(this.host.random.random() * Math.trunc(points.length / 2)));
    const selected = points[index];
    if (selected === undefined) throw new Error("Farthest spawn index invariant");
    return pose(selected.entity);
  }

  selectInitialSpawnPoint(): SpawnPoint {
    let spot: GameEntity | null = null;
    while ((spot = findEntity(this.host.pool, spot, "classname", "info_player_deathmatch")) !== null) {
      if (spot.spawnflags & 1) break;
    }
    return spot === null || this.spotWouldTelefrag(spot) ? this.selectSpawnPoint(vec3(0, 0, 0)) : pose(spot);
  }

  selectTeamSpawnPoint(team: Team, state: TeamState): SpawnPoint {
    if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return this.selectSpawnPoint(vec3(0, 0, 0));
    const name = `team_CTF_${team === Team.TEAM_RED ? "red" : "blue"}${state === TeamState.BEGIN ? "player" : "spawn"}`;
    const points: GameEntity[] = [];
    let spot: GameEntity | null = null;
    while ((spot = findEntity(this.host.pool, spot, "classname", name)) !== null) {
      if (this.spotWouldTelefrag(spot)) continue;
      points.push(spot);
      if (points.length === 32) break;
    }
    if (points.length === 0) {
      const fallback = findEntity(this.host.pool, null, "classname", name);
      return fallback === null ? this.selectSpawnPoint(vec3(0, 0, 0)) : pose(fallback);
    }
    const selected = points[this.host.random.rand() % points.length];
    if (selected === undefined) throw new Error("Team spawn index invariant");
    return pose(selected);
  }

  initBodyQueue(): void {
    if (this.state.bodyQueue !== null) throw new Error("Body queue is already initialized for this map");
    const entities = Array.from({ length: BODY_QUEUE_SIZE }, () => {
      const entity = this.host.pool.spawn();
      entity.classname = "bodyque";
      entity.neverFree = true;
      return entity;
    });
    this.state.bodyQueue = { entities, index: 0 };
  }

  bodySink(body: GameEntity): void {
    const time = this.host.frame().time;
    if (((time - body.timestamp) | 0) > 6500) {
      this.host.world.unlink(body.slot);
      body.physicsObject = false;
      return;
    }
    body.nextthink = (time + 100) | 0;
    body.s.pos = { ...body.s.pos, base: add3(body.s.pos.base, vec3(0, 0, -1)) };
  }

  copyToBodyQueue(entity: GameEntity): GameEntity | null {
    const client = this.ownedClient(entity), time = this.host.frame().time;
    this.host.world.unlink(entity.slot);
    if (this.host.world.pointContents(entity.s.origin, -1) & CONTENTS_NODROP) return null;
    const queue = this.state.bodyQueue;
    if (queue === null) throw new Error("Body queue must be initialized before copying a corpse");
    const body = queue.entities[queue.index];
    if (body === undefined) throw new Error("Body queue index invariant");
    queue.index = (queue.index + 1) % BODY_QUEUE_SIZE;
    this.host.world.unlink(body.slot);
    Object.assign(body.s, entity.s.copy());
    body.s.eFlags = EF_DEAD;
    if (client.ps.product === "missionpack" && (entity.s.eFlags & EF_KAMIKAZE)) {
      body.s.eFlags |= EF_KAMIKAZE;
      for (let index = 0; index < MAX_GENTITIES; index++) {
        const timer = this.host.pool.at(index);
        if (timer.inuse && timer.activator === entity && timer.classname === "kamikaze timer") { timer.activator = body; break; }
      }
    }
    body.s.powerups = 0;
    body.s.loopSound = 0;
    body.s.number = body.slot;
    body.timestamp = time;
    body.physicsObject = true;
    body.physicsBounce = 0;
    body.s.pos = body.s.groundEntityNum === ENTITYNUM_NONE
      ? { ...body.s.pos, type: TrajectoryType.TR_GRAVITY, time, delta: { ...client.ps.velocity } }
      : { ...body.s.pos, type: TrajectoryType.TR_STATIONARY };
    body.s.event = 0;
    const animation = body.s.legsAnim & ~128;
    body.s.torsoAnim = body.s.legsAnim = animation === PlayerAnimation.BOTH_DEATH1 || animation === PlayerAnimation.BOTH_DEAD1
      ? PlayerAnimation.BOTH_DEAD1 : animation === PlayerAnimation.BOTH_DEATH2 || animation === PlayerAnimation.BOTH_DEAD2
        ? PlayerAnimation.BOTH_DEAD2 : PlayerAnimation.BOTH_DEAD3;
    body.r.svFlags = entity.r.svFlags;
    body.r.mins = { ...entity.r.mins };
    body.r.maxs = { ...entity.r.maxs };
    body.clipmask = 1 | 0x10000;
    body.r.contents = CONTENTS_CORPSE;
    body.r.ownerNum = entity.s.number;
    body.nextthink = (time + 5000) | 0;
    body.think = self => { this.bodySink(self); };
    body.die = this.host.bodyDie;
    body.takedamage = entity.health > GIB_HEALTH;
    body.r.currentOrigin = { ...body.s.pos.base };
    this.host.world.link(body);
    return body;
  }

  clientSpawn(entity: GameEntity): void {
    const client = this.ownedClient(entity), frame = this.host.frame();
    let spawn: SpawnPose, spawnEntity: GameEntity | null = null;
    if (client.sess.sessionTeam === Team.TEAM_SPECTATOR) spawn = this.host.findIntermissionPoint();
    else if (frame.gameType >= GameType.GT_CTF) {
      const selected = this.selectTeamSpawnPoint(client.sess.sessionTeam, client.pers.teamState.state);
      spawn = selected; spawnEntity = selected.entity;
    } else {
      const states = new Set<number>();
      while (true) {
        // The low15 LCG has period32768. Selection consumes one draw or none;
        // initialSpawn flips once. Repeated state proves the same rejected stream.
        const state = (this.host.random.seed & 0x7fff) | (client.pers.initialSpawn ? 0x8000 : 0);
        if (states.has(state)) throw new Error("No permitted spawn point in the complete game RNG cycle");
        states.add(state);
        let selected: SpawnPoint;
        if (!client.pers.initialSpawn && client.pers.localClient) {
          client.pers.initialSpawn = true;
          selected = this.selectInitialSpawnPoint();
        } else selected = this.selectSpawnPoint(client.ps.origin);
        const bot = (entity.r.svFlags & ServerEntityFlags.BOT) !== 0;
        if ((selected.entity.flags & (bot ? GameFlags.NO_BOTS : GameFlags.NO_HUMANS)) !== 0) continue;
        spawn = selected; spawnEntity = selected.entity; break;
      }
    }
    client.pers.teamState.state = TeamState.ACTIVE;
    entity.s.eFlags &= ~EF_KAMIKAZE;
    const flags = (client.ps.eFlags & (EF_TELEPORT_BIT | EF_VOTED | EF_TEAMVOTED)) ^ EF_TELEPORT_BIT;
    const { pers, sess, accuracyHits, accuracyShots, ps } = client;
    const ping = ps.ping, persistant = ps.persistant.copy(), eventSequence = ps.eventSequence;
    const fresh = new GameClient(ps.product);
    Object.assign(client, fresh, { pers, sess, ps, accuracyHits, accuracyShots });
    Object.assign(ps, fresh.ps);
    ps.ping = ping;
    client.lastKilledClient = -1;
    for (const [index, value] of persistant.entries()) ps.persistant.set(index, value);
    ps.eventSequence = eventSequence;
    ps.persistant.set(PersistentIndex.PERS_SPAWN_COUNT, (ps.persistant.get(PersistentIndex.PERS_SPAWN_COUNT) + 1) | 0);
    ps.persistant.set(PersistentIndex.PERS_TEAM, sess.sessionTeam);
    client.airOutTime = (frame.time + 12000) | 0;
    pers.maxHealth = gameAtoi(this.host.handicap(entity.slot));
    if (pers.maxHealth < 1 || pers.maxHealth > 100) pers.maxHealth = 100;
    const schema = statSchema(ps.product);
    ps.stats.set(schema.maxHealth, pers.maxHealth);
    ps.eFlags = flags;
    entity.s.groundEntityNum = ENTITYNUM_NONE;
    entity.takedamage = true;
    entity.inuse = true;
    entity.classname = "player";
    entity.r.contents = CONTENTS_BODY;
    entity.clipmask = 1 | 0x10000 | CONTENTS_BODY;
    entity.die = this.host.playerDie;
    entity.waterlevel = 0;
    entity.watertype = 0;
    entity.flags = 0;
    entity.r.mins = { ...PLAYER_MINS };
    entity.r.maxs = { ...PLAYER_MAXS };
    ps.clientNum = entity.slot;
    ps.stats.set(schema.weapons, (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_GAUNTLET));
    ps.ammo.set(Weapon.WP_MACHINEGUN, frame.gameType === GameType.GT_TEAM ? 50 : 100);
    ps.ammo.set(Weapon.WP_GAUNTLET, -1);
    ps.ammo.set(Weapon.WP_GRAPPLING_HOOK, -1);
    entity.health = ps.health = (pers.maxHealth + 25) | 0;
    setOrigin(entity, spawn.origin);
    ps.origin = { ...spawn.origin };
    ps.pmFlags |= MoveFlags.RESPAWNED;
    const command = this.host.userCommand(entity.slot);
    pers.cmd = { ...command, angles: { ...command.angles } };
    setClientViewAngle(entity, spawn.angles);
    if (sess.sessionTeam !== Team.TEAM_SPECTATOR) {
      this.host.killBox(entity);
      this.host.world.link(entity);
      ps.weapon = Weapon.WP_MACHINEGUN;
      ps.weaponState = WeaponState.WEAPON_READY;
    }
    ps.pmFlags |= MoveFlags.TIME_KNOCKBACK;
    ps.pmTime = 100;
    client.respawnTime = frame.time;
    client.inactivityTime = (frame.time + Math.imul(frame.inactivitySeconds, 1000)) | 0;
    client.latchedButtons = 0;
    ps.torsoAnim = PlayerAnimation.TORSO_STAND;
    ps.legsAnim = PlayerAnimation.LEGS_IDLE;
    if (frame.intermissionTime !== 0) this.host.moveToIntermission(entity);
    else {
      useTargets(this.host.targets(), spawnEntity, entity);
      ps.weapon = Weapon.WP_GAUNTLET;
      for (let weapon = weaponCount(ps.product) - 1; weapon > 0; weapon--) {
        if (ps.stats.get(schema.weapons) & (1 << weapon)) { ps.weapon = weapon; break; }
      }
    }
    ps.commandTime = (frame.time - 100) | 0;
    pers.cmd.serverTime = frame.time;
    this.host.think.clientThink(entity.slot, this.host.userCommand(entity.slot));
    if (client.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
      playerStateToEntityState(ps, entity.s, true);
      entity.r.currentOrigin = { ...client.ps.origin };
      this.host.world.link(entity);
    }
    clientEndFrame(this.host.effects(), entity);
    playerStateToEntityState(ps, entity.s, true);
  }

  respawn(entity: GameEntity): void {
    this.copyToBodyQueue(entity);
    this.clientSpawn(entity);
    const temporary = this.host.pool.tempEntity(clientOf(entity).ps.origin, EntityEvent.EV_PLAYER_TELEPORT_IN);
    temporary.s.clientNum = entity.s.clientNum;
  }
}
