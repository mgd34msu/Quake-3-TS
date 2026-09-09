// Ported from id Software's code/game/g_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { vec3 } from "../core/math.ts";
import { Team, Weapon, weaponCount } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { EntityShared } from "../shared/entity-shared.ts";
import type { SharedEntity } from "../shared/entity-shared.ts";
import { EntityState } from "../shared/entity-state.ts";
import type { ItemDefinition } from "../shared/items.ts";
import { createPlayerState, PlayerStateSlots } from "../shared/player-state.ts";
import type { PlayerState, UserCommand } from "../shared/player-state.ts";
import type { MovementTrace } from "../shared/slide-move.ts";

export const MAX_CLIENTS = 64;
export const MAX_GENTITIES = 1024;

export enum ConnectionState {
  DISCONNECTED = 0, CONNECTING = 1, CONNECTED = 2,
}
export enum SpectatorState {
  NOT = 0, FREE = 1, FOLLOW = 2, SCOREBOARD = 3,
}
export enum TeamState {
  BEGIN = 0, ACTIVE = 1,
}
export enum MoverState {
  POS1 = 0, POS2 = 1, ONE_TO_TWO = 2, TWO_TO_ONE = 3,
}
export enum GameFlags {
  GODMODE = 0x10, NOTARGET = 0x20, TEAMSLAVE = 0x400, NO_KNOCKBACK = 0x800,
  DROPPED_ITEM = 0x1000, NO_BOTS = 0x2000, NO_HUMANS = 0x4000, FORCE_GESTURE = 0x8000,
}

export class PlayerTeamState {
  state = TeamState.BEGIN;
  location = 0;
  captures = 0;
  baseDefense = 0;
  carrierDefense = 0;
  flagRecovery = 0;
  fragCarrier = 0;
  assists = 0;
  lastHurtCarrier = 0;
  lastReturnedFlag = 0;
  flagSince = 0;
  lastFraggedCarrier = 0;
}

/** Session values survive maps; persistence to cvars belongs to g_session. */
export class ClientSession {
  sessionTeam = Team.TEAM_FREE;
  spectatorTime = 0;
  spectatorState = SpectatorState.NOT;
  spectatorClient = 0;
  wins = 0;
  losses = 0;
  teamLeader = false;
}

/** Source clientPersistant_t survives respawn, but not ClientBegin reset. */
export class ClientPersistant {
  connected = ConnectionState.DISCONNECTED;
  cmd: UserCommand = { serverTime: 0, angles: vec3(0, 0, 0), buttons: 0,
    weapon: Weapon.WP_NONE, forwardmove: 0, rightmove: 0, upmove: 0 };
  localClient = false;
  initialSpawn = false;
  predictItemPickup = false;
  pmoveFixed = false;
  netname = "";
  maxHealth = 0;
  enterTime = 0;
  teamState = new PlayerTeamState();
  voteCount = 0;
  teamVoteCount = 0;
  teamInfo = false;
}

/** Source-zero gclient_t. Construction performs no connection/spawn effects. */
export class GameClient {
  ps: PlayerState;
  pers = new ClientPersistant();
  sess = new ClientSession();
  readyToExit = false;
  noclip = false;
  lastCmdTime = 0;
  buttons = 0;
  oldButtons = 0;
  latchedButtons = 0;
  oldOrigin = vec3(0, 0, 0);
  damageArmor = 0;
  damageBlood = 0;
  damageKnockback = 0;
  damageFrom = vec3(0, 0, 0);
  damageFromWorld = false;
  accurateCount = 0;
  accuracyShots = 0;
  accuracyHits = 0;
  lastKilledClient = 0;
  lastHurtClient = 0;
  lastHurtMod = 0;
  respawnTime = 0;
  inactivityTime = 0;
  inactivityWarning = false;
  rewardTime = 0;
  airOutTime = 0;
  lastKillTime = 0;
  fireHeld = false;
  hook: GameEntity | null = null;
  switchTeamTime = 0;
  timeResidual = 0;
  // Missionpack fields stay zero/unused in baseq3, matching the shared superset convention.
  persistantPowerup: GameEntity | null = null;
  portalID = 0;
  readonly ammoTimes: PlayerStateSlots;
  invulnerabilityTime = 0;
  areabits: Uint8Array | null = null;

  constructor(product: Product) {
    this.ps = createPlayerState(product);
    this.ammoTimes = new PlayerStateSlots(weaponCount(product));
  }
}

export type EntityThink = (self: GameEntity) => void;
export type EntityBlocked = (self: GameEntity, other: GameEntity) => void;
export type EntityTouch = (self: GameEntity, other: GameEntity, trace: MovementTrace) => void;
export type EntityUse = (self: GameEntity, other: GameEntity | null, activator: GameEntity | null) => void;
export type EntityPain = (self: GameEntity, attacker: GameEntity, damage: number) => void;
export type EntityDie = (self: GameEntity, inflictor: GameEntity, attacker: GameEntity,
  damage: number, methodOfDeath: number) => void;

/** Source-zero gentity_t; slot is owned-table metadata independent of memset-zero s.number. */
export class GameEntity implements SharedEntity {
  s = new EntityState();
  r = new EntityShared();
  client: GameClient | null = null;
  inuse = false;
  private classnameState: { kind: "value"; value: string | null } | { kind: "client-name"; client: GameClient } = { kind: "value", value: null };
  get classname(): string | null {
    return this.classnameState.kind === "value" ? this.classnameState.value : this.classnameState.client.pers.netname;
  }
  set classname(value: string | null) { this.classnameState = { kind: "value", value }; }
  bindClientName(client: GameClient): void { this.classnameState = { kind: "client-name", client }; }
  spawnflags = 0;
  neverFree = false;
  flags = 0;
  model: string | null = null;
  model2: string | null = null;
  freetime = 0;
  eventTime = 0;
  freeAfterEvent = false;
  unlinkAfterEvent = false;
  physicsObject = false;
  physicsBounce = 0;
  clipmask = 0;
  moverState = MoverState.POS1;
  soundPos1 = 0;
  sound1to2 = 0;
  sound2to1 = 0;
  soundPos2 = 0;
  soundLoop = 0;
  parent: GameEntity | null = null;
  nextTrain: GameEntity | null = null;
  prevTrain: GameEntity | null = null;
  pos1 = vec3(0, 0, 0);
  pos2 = vec3(0, 0, 0);
  message: string | null = null;
  timestamp = 0;
  angle = 0;
  target: string | null = null;
  targetname: string | null = null;
  team: string | null = null;
  targetShaderName: string | null = null;
  targetShaderNewName: string | null = null;
  targetEnt: GameEntity | null = null;
  speed = 0;
  movedir = vec3(0, 0, 0);
  nextthink = 0;
  think: EntityThink | null = null;
  reached: EntityThink | null = null;
  blocked: EntityBlocked | null = null;
  touch: EntityTouch | null = null;
  use: EntityUse | null = null;
  pain: EntityPain | null = null;
  die: EntityDie | null = null;
  painDebounceTime = 0;
  flySoundDebounceTime = 0;
  lastMoveTime = 0;
  health = 0;
  takedamage = false;
  damage = 0;
  splashDamage = 0;
  splashRadius = 0;
  methodOfDeath = 0;
  splashMethodOfDeath = 0;
  count = 0;
  chain: GameEntity | null = null;
  enemy: GameEntity | null = null;
  activator: GameEntity | null = null;
  teamchain: GameEntity | null = null;
  teammaster: GameEntity | null = null;
  kamikazeTime = 0;
  kamikazeShockTime = 0;
  watertype = 0;
  waterlevel = 0;
  noiseIndex = 0;
  wait = 0;
  random = 0;
  item: ItemDefinition | null = null;

  constructor(readonly slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_GENTITIES) throw new RangeError("Game entity slot outside 0..1023");
  }
}

export function createGameClient(product: Product): GameClient { return new GameClient(product); }
export function createGameEntity(slot: number): GameEntity { return new GameEntity(slot); }
