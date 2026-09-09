// Ported from id Software's game/ai_main.h, g_local.h, q_shared.h and ai_main.c state operations.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import type { BotGoal } from "../botlib/goals.ts";
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { MAX_ITEMS, MoveType, Weapon, WeaponState } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { PlayerState, PlayerStateSlots } from "../shared/player-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import { MAX_CLIENTS, MAX_GENTITIES } from "./state.ts";
import { MAX_ACTIVATEAREAS, MAX_ACTIVATESTACK, MAX_PROXMINES } from "./ai-definitions.ts";
import type { BotPresenceType } from "./ai-definitions.ts";
import type { GameMemory, GameMemoryAllocation } from "./memory.ts";

// ai_main.h release32 layout: 57 scalar ints, 56 floats, 12 vec3s, five pointers,
// three int arrays, five 56-byte goals, eight 244-byte activate goals and 80 chars.
// Embedded playerState/usercmd/settings are 468/24/292 bytes; both products match.
export const BOT_STATE_SOURCE_BYTES = 57 * 4 + 56 * 4 + 12 * 12 + 5 * 4
  + (1024 + 256 + 64) * 4 + 5 * 56 + 8 * 244 + 80 + 468 + 24 + 292;

const COMMAND_WEAPONS = [Weapon.WP_NONE, Weapon.WP_GAUNTLET, Weapon.WP_MACHINEGUN, Weapon.WP_SHOTGUN,
  Weapon.WP_GRENADE_LAUNCHER, Weapon.WP_ROCKET_LAUNCHER, Weapon.WP_LIGHTNING, Weapon.WP_RAILGUN,
  Weapon.WP_PLASMAGUN, Weapon.WP_BFG, Weapon.WP_GRAPPLING_HOOK, Weapon.WP_NAILGUN,
  Weapon.WP_PROX_LAUNCHER, Weapon.WP_CHAINGUN];
const PLAYER_MOVE_TYPES = [MoveType.PM_NORMAL, MoveType.PM_NOCLIP, MoveType.PM_SPECTATOR,
  MoveType.PM_DEAD, MoveType.PM_FREEZE, MoveType.PM_INTERMISSION, MoveType.PM_SPINTERMISSION];
const PLAYER_WEAPON_STATES = [WeaponState.WEAPON_READY, WeaponState.WEAPON_RAISING,
  WeaponState.WEAPON_DROPPING, WeaponState.WEAPON_FIRING];

export interface BotSettings {
  characterfile: string;
  skill: number;
  team: string;
}

/** The eleven implemented AINode functions. NULL remains a distinct source state. */
export type AiNode = "intermission" | "observer" | "respawn" | "stand"
  | "seek-activate-entity" | "seek-nbg" | "seek-ltg"
  | "battle-fight" | "battle-chase" | "battle-retreat" | "battle-nbg";

export type BotSetupStage = "allocated" | "character" | "settings" | "goal-state"
  | "item-weights" | "weapon-state" | "weapon-weights" | "chat-state" | "chat-file"
  | "chat-gender" | "published" | "move-state" | "walker" | "counted"
  | "scheduled" | "interbred" | "session";

/** Progress does not own handles or imply inuse, including after a nested disconnect. */
export type BotSetupProgress = { readonly kind: "empty" }
  | { readonly kind: "setting-up"; readonly stage: BotSetupStage }
  | { readonly kind: "failed"; readonly stage: "aas" | "character" }
  | { readonly kind: "failed"; readonly stage: "item-weights" | "weapon-weights" | "chat-file"; readonly errorCode: number }
  | { readonly kind: "complete" };

/** An inline bot_goal_t cell implements the canonical botlib goal contract. */
export class BotGoalState implements BotGoal {
  origin = vec3(0, 0, 0);
  area = 0;
  mins = vec3(0, 0, 0);
  maxs = vec3(0, 0, 0);
  entity = 0;
  number = 0;
  flags = 0;
  itemInfo = 0;

  constructor(source: DataView | null = null) {
    const view = source ?? new DataView(new ArrayBuffer(56));
    if (view.byteLength !== 56) throw new RangeError("bot_goal_t requires 56 bytes");
    bindSourceVector(this, "origin", view, 0);
    bindSourceNumber(this, "area", view, 12, "int");
    bindSourceVector(this, "mins", view, 16);
    bindSourceVector(this, "maxs", view, 28);
    bindSourceNumber(this, "entity", view, 40, "int");
    bindSourceNumber(this, "number", view, 44, "int");
    bindSourceNumber(this, "flags", view, 48, "int");
    bindSourceNumber(this, "itemInfo", view, 52, "int");
  }

  copyFrom(source: BotGoal): void {
    Object.assign(this.origin, source.origin);
    this.area = source.area;
    Object.assign(this.mins, source.mins);
    Object.assign(this.maxs, source.maxs);
    this.entity = source.entity;
    this.number = source.number;
    this.flags = source.flags;
    this.itemInfo = source.itemInfo;
  }

  clear(): void {
    clearVector(this.origin);
    this.area = 0;
    clearVector(this.mins);
    clearVector(this.maxs);
    this.entity = 0;
    this.number = 0;
    this.flags = 0;
    this.itemInfo = 0;
  }
}

export class BotWaypoint {
  inuse = false;
  name = "";
  readonly goal = new BotGoalState();
  next: BotWaypoint | null = null;
  prev: BotWaypoint | null = null;
}

export class BotActivateGoal {
  inuse = false;
  readonly goal: BotGoalState;
  time = 0;
  startTime = 0;
  justUsedTime = 0;
  shoot = false;
  weapon = 0;
  target = vec3(0, 0, 0);
  origin = vec3(0, 0, 0);
  readonly areas: number[];
  numAreas = 0;
  areasDisabled = false;
  next: BotActivateGoal | null = null;

  constructor(source: DataView | null = null) {
    const view = source ?? new DataView(new ArrayBuffer(244));
    if (view.byteLength !== 244) throw new RangeError("bot_activategoal_t requires 244 bytes");
    bindSourceBoolean(this, "inuse", view, 0);
    this.goal = new BotGoalState(sourceRecord(view, 4, 56));
    bindSourceNumber(this, "time", view, 60, "float");
    bindSourceNumber(this, "startTime", view, 64, "float");
    bindSourceNumber(this, "justUsedTime", view, 68, "float");
    bindSourceBoolean(this, "shoot", view, 72);
    bindSourceNumber(this, "weapon", view, 76, "int");
    bindSourceVector(this, "target", view, 80);
    bindSourceVector(this, "origin", view, 92);
    this.areas = sourceIntArray(view, 104, MAX_ACTIVATEAREAS);
    bindSourceNumber(this, "numAreas", view, 232, "int");
    bindSourceBoolean(this, "areasDisabled", view, 236);
    // The source next pointer remains a typed object reference.
  }

  copyFrom(source: BotActivateGoal): void {
    this.inuse = source.inuse;
    this.goal.copyFrom(source.goal);
    this.time = source.time;
    this.startTime = source.startTime;
    this.justUsedTime = source.justUsedTime;
    this.shoot = source.shoot;
    this.weapon = source.weapon;
    Object.assign(this.target, source.target);
    Object.assign(this.origin, source.origin);
    for (let index = 0; index < MAX_ACTIVATEAREAS; index++) {
      const area = source.areas[index];
      if (area === undefined) throw new RangeError(`Missing bot activation area slot ${index}`);
      this.areas[index] = area;
    }
    this.numAreas = source.numAreas;
    this.areasDisabled = source.areasDisabled;
    this.next = source.next;
  }

  clear(): void {
    this.inuse = false;
    this.goal.clear();
    this.time = 0;
    this.startTime = 0;
    this.justUsedTime = 0;
    this.shoot = false;
    this.weapon = 0;
    clearVector(this.target);
    clearVector(this.origin);
    this.areas.fill(0);
    this.numAreas = 0;
    this.areasDisabled = false;
    this.next = null;
  }
}

/** bot_state_t data uses source storage; function and object pointers retain typed identities. */
export class BotState {
  inuse = false;
  botThinkResidual = 0;
  client = 0;
  entityNum = 0;
  readonly curPs: PlayerState;
  lastEFlags = 0;
  readonly lastUcmd: UserCommand;
  readonly entityEventTime: number[];
  readonly settings: BotSettings;
  aiNode: AiNode | null = null;
  thinkTime = 0;
  origin = vec3(0, 0, 0);
  velocity = vec3(0, 0, 0);
  presenceType: 0 | BotPresenceType = 0;
  eye = vec3(0, 0, 0);
  areaNum = 0;
  readonly inventory: number[];
  tfl = 0;
  flags = 0;
  respawnWait = false;
  lastHealth = 0;
  lastKilledPlayer = 0;
  lastKilledBy = 0;
  botDeathType = 0;
  enemyDeathType = 0;
  botSuicide = false;
  enemySuicide = false;
  setupCount = 0;
  mapRestart = false;
  enterGameChat = false;
  numDeaths = 0;
  numKills = 0;
  revengeEnemy = 0;
  revengeKills = 0;
  lastFrameHealth = 0;
  lastHitCount = 0;
  chatTo = 0;
  walker = 0;
  ltime = 0;
  enterGameTime = 0;
  ltgTime = 0;
  nbgTime = 0;
  respawnTime = 0;
  respawnChatTime = 0;
  chaseTime = 0;
  enemyVisibleTime = 0;
  checkTime = 0;
  standTime = 0;
  lastChatTime = 0;
  kamikazeTime = 0;
  invulnerabilityTime = 0;
  standFindEnemyTime = 0;
  attackStrafeTime = 0;
  attackCrouchTime = 0;
  attackChaseTime = 0;
  attackJumpTime = 0;
  enemySightTime = 0;
  enemyDeathTime = 0;
  enemyPositionTime = 0;
  defendAwayTime = 0;
  defendAwayRange = 0;
  rushBaseAwayTime = 0;
  attackAwayTime = 0;
  harvestAwayTime = 0;
  ctfRoamTime = 0;
  killedEnemyTime = 0;
  arriveTime = 0;
  lastAirTime = 0;
  teleportTime = 0;
  campTime = 0;
  campRange = 0;
  weaponChangeTime = 0;
  fireThrottleWaitTime = 0;
  fireThrottleShootTime = 0;
  notBlockedTime = 0;
  blockedByAvoidSpotTime = 0;
  predictObstaclesTime = 0;
  predictObstaclesGoalAreaNum = 0;
  aimTarget = vec3(0, 0, 0);
  enemyVelocity = vec3(0, 0, 0);
  enemyOrigin = vec3(0, 0, 0);
  kamikazeBody = 0;
  readonly proxMines: number[];
  numProxMines = 0;
  character = 0;
  ms = 0;
  gs = 0;
  cs = 0;
  ws = 0;
  enemy = 0;
  lastEnemyAreaNum = 0;
  lastEnemyOrigin = vec3(0, 0, 0);
  weaponNum = 0;
  viewangles = vec3(0, 0, 0);
  idealViewangles = vec3(0, 0, 0);
  viewangleSpeed = vec3(0, 0, 0);
  ltgType = 0;
  teammate = 0;
  decisionmaker = 0;
  ordered = false;
  orderTime = 0;
  ownDecisionTime = 0;
  readonly teamGoal: BotGoalState;
  readonly altRouteGoal: BotGoalState;
  reachedAltRouteGoalTime = 0;
  teamMessageTime = 0;
  teamGoalTime = 0;
  teammateVisibleTime = 0;
  teamTaskPreference = 0;
  lastGoalDecisionmaker = 0;
  lastGoalLtgType = 0;
  lastGoalTeammate = 0;
  readonly lastGoalTeamGoal: BotGoalState;
  leadTeammate = 0;
  readonly leadTeamGoal: BotGoalState;
  leadTime = 0;
  leadVisibleTime = 0;
  leadMessageTime = 0;
  leadBackupTime = 0;
  teamLeader = "";
  askTeamLeaderTime = 0;
  becomeTeamLeaderTime = 0;
  teamGiveOrdersTime = 0;
  lastFlagCaptureTime = 0;
  numTeammates = 0;
  redFlagStatus = 0;
  blueFlagStatus = 0;
  neutralFlagStatus = 0;
  flagStatusChanged = false;
  forceOrders = false;
  flagCarrier = 0;
  ctfStrategy = 0;
  subteam = "";
  formationDist = 0;
  formationTeammate = "";
  formationAngle = 0;
  formationDir = vec3(0, 0, 0);
  formationOrigin = vec3(0, 0, 0);
  readonly formationGoal: BotGoalState;
  activateStack: BotActivateGoal | null = null;
  readonly activateGoalHeap: readonly BotActivateGoal[];
  checkpoints: BotWaypoint | null = null;
  patrolPoints: BotWaypoint | null = null;
  currentPatrolPoint: BotWaypoint | null = null;
  patrolFlags = 0;
  setup: BotSetupProgress = { kind: "empty" };

  readonly #bytes: Uint8Array;

  /**
   * G_Alloc does not clear its retained pool. Field accessors borrow that storage.
   * Only function/object pointers remain typed values outside the source bytes.
   * Diagnostic states own one bounded record and do not charge a GameMemory pool.
   */
  constructor(readonly product: Product, readonly sourceAllocation: GameMemoryAllocation | null = null) {
    const bytes = sourceAllocation?.bytes ?? new Uint8Array(BOT_STATE_SOURCE_BYTES);
    if (bytes.byteLength < BOT_STATE_SOURCE_BYTES) throw new RangeError("bot_state_t requires 9088 bytes");
    this.#bytes = bytes.subarray(0, BOT_STATE_SOURCE_BYTES);
    const view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength);
    this.curPs = sourcePlayerState(product, sourceRecord(view, 16, 468));
    this.lastUcmd = sourceCommand(sourceRecord(view, 488, 24));
    this.entityEventTime = sourceIntArray(view, 512, MAX_GENTITIES);
    this.settings = { characterfile: "", skill: 0, team: "" };
    bindSourceText(this.settings, "characterfile", this.#bytes, 4608, 144);
    bindSourceNumber(this.settings, "skill", view, 4752, "float");
    bindSourceText(this.settings, "team", this.#bytes, 4756, 144);
    bindSourceText(this, "teamLeader", this.#bytes, 6900, 32);
    bindSourceText(this, "subteam", this.#bytes, 6980, 32);
    bindSourceText(this, "formationTeammate", this.#bytes, 7016, 16);
    this.inventory = sourceIntArray(view, 4952, MAX_ITEMS);
    this.proxMines = sourceIntArray(view, 6260, MAX_PROXMINES);
    this.teamGoal = new BotGoalState(sourceRecord(view, 6624, 56));
    this.altRouteGoal = new BotGoalState(sourceRecord(view, 6680, 56));
    this.lastGoalTeamGoal = new BotGoalState(sourceRecord(view, 6768, 56));
    this.leadTeamGoal = new BotGoalState(sourceRecord(view, 6828, 56));
    this.formationGoal = new BotGoalState(sourceRecord(view, 7060, 56));
    this.activateGoalHeap = Array.from({ length: MAX_ACTIVATESTACK },
      (_, index) => new BotActivateGoal(sourceRecord(view, 7120 + index * 244, 244)));
    bindSourceBoolean(this, "inuse", view, 0);
    bindSourceNumber(this, "botThinkResidual", view, 4, "int");
    bindSourceNumber(this, "client", view, 8, "int");
    bindSourceNumber(this, "entityNum", view, 12, "int");
    bindSourceNumber(this, "lastEFlags", view, 484, "int");
    bindSourceNumber(this, "thinkTime", view, 4904, "float");
    bindSourceNumber(this, "areaNum", view, 4948, "int");
    bindSourceNumber(this, "tfl", view, 5976, "int");
    bindSourceNumber(this, "flags", view, 5980, "int");
    bindSourceBoolean(this, "respawnWait", view, 5984);
    bindSourceNumber(this, "lastHealth", view, 5988, "int");
    bindSourceNumber(this, "lastKilledPlayer", view, 5992, "int");
    bindSourceNumber(this, "lastKilledBy", view, 5996, "int");
    bindSourceNumber(this, "botDeathType", view, 6000, "int");
    bindSourceNumber(this, "enemyDeathType", view, 6004, "int");
    bindSourceBoolean(this, "botSuicide", view, 6008);
    bindSourceBoolean(this, "enemySuicide", view, 6012);
    bindSourceNumber(this, "setupCount", view, 6016, "int");
    bindSourceBoolean(this, "mapRestart", view, 6020);
    bindSourceBoolean(this, "enterGameChat", view, 6024);
    bindSourceNumber(this, "numDeaths", view, 6028, "int");
    bindSourceNumber(this, "numKills", view, 6032, "int");
    bindSourceNumber(this, "revengeEnemy", view, 6036, "int");
    bindSourceNumber(this, "revengeKills", view, 6040, "int");
    bindSourceNumber(this, "lastFrameHealth", view, 6044, "int");
    bindSourceNumber(this, "lastHitCount", view, 6048, "int");
    bindSourceNumber(this, "chatTo", view, 6052, "int");
    bindSourceNumber(this, "walker", view, 6056, "float");
    bindSourceNumber(this, "ltime", view, 6060, "float");
    bindSourceNumber(this, "enterGameTime", view, 6064, "float");
    bindSourceNumber(this, "ltgTime", view, 6068, "float");
    bindSourceNumber(this, "nbgTime", view, 6072, "float");
    bindSourceNumber(this, "respawnTime", view, 6076, "float");
    bindSourceNumber(this, "respawnChatTime", view, 6080, "float");
    bindSourceNumber(this, "chaseTime", view, 6084, "float");
    bindSourceNumber(this, "enemyVisibleTime", view, 6088, "float");
    bindSourceNumber(this, "checkTime", view, 6092, "float");
    bindSourceNumber(this, "standTime", view, 6096, "float");
    bindSourceNumber(this, "lastChatTime", view, 6100, "float");
    bindSourceNumber(this, "kamikazeTime", view, 6104, "float");
    bindSourceNumber(this, "invulnerabilityTime", view, 6108, "float");
    bindSourceNumber(this, "standFindEnemyTime", view, 6112, "float");
    bindSourceNumber(this, "attackStrafeTime", view, 6116, "float");
    bindSourceNumber(this, "attackCrouchTime", view, 6120, "float");
    bindSourceNumber(this, "attackChaseTime", view, 6124, "float");
    bindSourceNumber(this, "attackJumpTime", view, 6128, "float");
    bindSourceNumber(this, "enemySightTime", view, 6132, "float");
    bindSourceNumber(this, "enemyDeathTime", view, 6136, "float");
    bindSourceNumber(this, "enemyPositionTime", view, 6140, "float");
    bindSourceNumber(this, "defendAwayTime", view, 6144, "float");
    bindSourceNumber(this, "defendAwayRange", view, 6148, "float");
    bindSourceNumber(this, "rushBaseAwayTime", view, 6152, "float");
    bindSourceNumber(this, "attackAwayTime", view, 6156, "float");
    bindSourceNumber(this, "harvestAwayTime", view, 6160, "float");
    bindSourceNumber(this, "ctfRoamTime", view, 6164, "float");
    bindSourceNumber(this, "killedEnemyTime", view, 6168, "float");
    bindSourceNumber(this, "arriveTime", view, 6172, "float");
    bindSourceNumber(this, "lastAirTime", view, 6176, "float");
    bindSourceNumber(this, "teleportTime", view, 6180, "float");
    bindSourceNumber(this, "campTime", view, 6184, "float");
    bindSourceNumber(this, "campRange", view, 6188, "float");
    bindSourceNumber(this, "weaponChangeTime", view, 6192, "float");
    bindSourceNumber(this, "fireThrottleWaitTime", view, 6196, "float");
    bindSourceNumber(this, "fireThrottleShootTime", view, 6200, "float");
    bindSourceNumber(this, "notBlockedTime", view, 6204, "float");
    bindSourceNumber(this, "blockedByAvoidSpotTime", view, 6208, "float");
    bindSourceNumber(this, "predictObstaclesTime", view, 6212, "float");
    bindSourceNumber(this, "predictObstaclesGoalAreaNum", view, 6216, "int");
    bindSourceNumber(this, "kamikazeBody", view, 6256, "int");
    bindSourceNumber(this, "numProxMines", view, 6516, "int");
    bindSourceNumber(this, "character", view, 6520, "int");
    bindSourceNumber(this, "ms", view, 6524, "int");
    bindSourceNumber(this, "gs", view, 6528, "int");
    bindSourceNumber(this, "cs", view, 6532, "int");
    bindSourceNumber(this, "ws", view, 6536, "int");
    bindSourceNumber(this, "enemy", view, 6540, "int");
    bindSourceNumber(this, "lastEnemyAreaNum", view, 6544, "int");
    bindSourceNumber(this, "weaponNum", view, 6560, "int");
    bindSourceNumber(this, "ltgType", view, 6600, "int");
    bindSourceNumber(this, "teammate", view, 6604, "int");
    bindSourceNumber(this, "decisionmaker", view, 6608, "int");
    bindSourceBoolean(this, "ordered", view, 6612);
    bindSourceNumber(this, "orderTime", view, 6616, "float");
    bindSourceNumber(this, "ownDecisionTime", view, 6620, "int");
    bindSourceNumber(this, "reachedAltRouteGoalTime", view, 6736, "float");
    bindSourceNumber(this, "teamMessageTime", view, 6740, "float");
    bindSourceNumber(this, "teamGoalTime", view, 6744, "float");
    bindSourceNumber(this, "teammateVisibleTime", view, 6748, "float");
    bindSourceNumber(this, "teamTaskPreference", view, 6752, "int");
    bindSourceNumber(this, "lastGoalDecisionmaker", view, 6756, "int");
    bindSourceNumber(this, "lastGoalLtgType", view, 6760, "int");
    bindSourceNumber(this, "lastGoalTeammate", view, 6764, "int");
    bindSourceNumber(this, "leadTeammate", view, 6824, "int");
    bindSourceNumber(this, "leadTime", view, 6884, "float");
    bindSourceNumber(this, "leadVisibleTime", view, 6888, "float");
    bindSourceNumber(this, "leadMessageTime", view, 6892, "float");
    bindSourceNumber(this, "leadBackupTime", view, 6896, "float");
    bindSourceNumber(this, "askTeamLeaderTime", view, 6932, "float");
    bindSourceNumber(this, "becomeTeamLeaderTime", view, 6936, "float");
    bindSourceNumber(this, "teamGiveOrdersTime", view, 6940, "float");
    bindSourceNumber(this, "lastFlagCaptureTime", view, 6944, "float");
    bindSourceNumber(this, "numTeammates", view, 6948, "int");
    bindSourceNumber(this, "redFlagStatus", view, 6952, "int");
    bindSourceNumber(this, "blueFlagStatus", view, 6956, "int");
    bindSourceNumber(this, "neutralFlagStatus", view, 6960, "int");
    bindSourceBoolean(this, "flagStatusChanged", view, 6964);
    bindSourceBoolean(this, "forceOrders", view, 6968);
    bindSourceNumber(this, "flagCarrier", view, 6972, "int");
    bindSourceNumber(this, "ctfStrategy", view, 6976, "int");
    bindSourceNumber(this, "formationDist", view, 7012, "float");
    bindSourceNumber(this, "formationAngle", view, 7032, "float");
    bindSourceNumber(this, "patrolFlags", view, 9084, "int");
    bindSourceVector(this, "origin", view, 4908);
    bindSourceVector(this, "velocity", view, 4920);
    bindSourceVector(this, "eye", view, 4936);
    bindSourceVector(this, "aimTarget", view, 6220);
    bindSourceVector(this, "enemyVelocity", view, 6232);
    bindSourceVector(this, "enemyOrigin", view, 6244);
    bindSourceVector(this, "lastEnemyOrigin", view, 6548);
    bindSourceVector(this, "viewangles", view, 6564);
    bindSourceVector(this, "idealViewangles", view, 6576);
    bindSourceVector(this, "viewangleSpeed", view, 6588);
    bindSourceVector(this, "formationDir", view, 7036);
    bindSourceVector(this, "formationOrigin", view, 7048);
    Object.defineProperty(this, "presenceType", {
      enumerable: true,
      get(): 0 | BotPresenceType {
        const value = view.getInt32(4932, true);
        if (value !== 0 && value !== 1 && value !== 2 && value !== 4) {
          throw new RangeError(`Unsupported bot presence type ${value}`);
        }
        return value;
      },
      set(value: 0 | BotPresenceType): void { view.setInt32(4932, value, true); },
    });
  }

  /** ClientName writes its fixed buffer before Q_CleanStr edits those same bytes. */
  copyTeamLeaderClientName(rawName: string): void {
    sourceStrncpy(this.#bytes, 6900, rawName, 31);
    this.#bytes[6931] = 0;
    cleanSourceString(this.#bytes, 6900);
  }

  /** ai_cmd.c and ai_team.c both terminate at teamleader[sizeof(teamleader)]. */
  copyTeamLeaderWithOverflow(name: string): void {
    sourceStrncpy(this.#bytes, 6900, name, 32);
    this.#bytes[6932] = 0;
  }

  /** BotMatch_NewLeader uses Q_strncpyz, which pads the complete destination. */
  copyTeamLeader(name: string): void {
    sourceStrncpy(this.#bytes, 6900, name, 31);
    this.#bytes[6931] = 0;
  }

  clearTeamLeader(): void { this.#bytes[6900] = 0; }

  copySubteam(name: string): void {
    sourceStrncpy(this.#bytes, 6980, name, 32);
    this.#bytes[7011] = 0;
  }

  clearSubteam(): void { this.#bytes[6980] = 0; }

  /** BotResetState's memset/restore portion; its caller frees waypoints first and resets botlib after. */
  resetDecisionState(): void {
    // BotResetState's memset/restore leaves inuse/client/entitynum, cur_ps, settings,
    // entergame_time and character/ms/gs/cs/ws unchanged, including their raw bits.
    this.#bytes.fill(0, 4, 8);
    this.#bytes.fill(0, 484, 4608);
    this.#bytes.fill(0, 4900, 6064);
    this.#bytes.fill(0, 6068, 6520);
    this.#bytes.fill(0, 6540);
    this.aiNode = null;
    this.activateStack = null;
    for (const goal of this.activateGoalHeap) goal.next = null;
    this.checkpoints = null;
    this.patrolPoints = null;
    this.currentPatrolPoint = null;
  }

  /** BotAIShutdownClient's final memset. Freeing source resources belongs to its caller. */
  clear(): void {
    this.#bytes.fill(0);
    this.resetDecisionState();
    this.setup = { kind: "empty" };
  }
}

/** botstates[MAX_CLIENTS]: lazy allocation survives source shutdown and slot reuse. */
export class BotStateStore {
  private readonly cells: (BotState | null)[] = Array.from({ length: MAX_CLIENTS }, () => null);

  constructor(readonly product: Product) {}

  get(client: number): BotState | null {
    const state = this.cells[client];
    if (state === undefined) throw new RangeError(`Bot client ${client} outside ${MAX_CLIENTS} slots`);
    return state;
  }

  acquire(client: number, memory: GameMemory): BotState {
    const state = this.get(client);
    if (state !== null) return state;
    const allocation = memory.allocate(BOT_STATE_SOURCE_BYTES);
    const allocated = new BotState(this.product, allocation);
    this.cells[client] = allocated;
    return allocated;
  }

  /** BotAISetup(false) zeros the pointer array without clearing its former records. */
  clear(): void { this.cells.fill(null); }
}

/** Source player-state memcpy keeps the destination's embedded arrays and vectors. */
export function copyBotPlayerState(destination: PlayerState, source: PlayerState): void {
  if (destination.product !== source.product) throw new Error("Bot player-state product differs from its client state");
  const origin = destination.origin, velocity = destination.velocity, deltaAngles = destination.deltaAngles;
  const grapplePoint = destination.grapplePoint, viewangles = destination.viewangles;
  const events = destination.events, eventParms = destination.eventParms, stats = destination.stats;
  const persistant = destination.persistant, powerups = destination.powerups, ammo = destination.ammo;
  Object.assign(destination, source, { origin, velocity, deltaAngles, grapplePoint, viewangles,
    events, eventParms, stats, persistant, powerups, ammo });
  Object.assign(origin, source.origin);
  Object.assign(velocity, source.velocity);
  Object.assign(deltaAngles, source.deltaAngles);
  Object.assign(grapplePoint, source.grapplePoint);
  Object.assign(viewangles, source.viewangles);
  for (let index = 0; index < events.length; index++) {
    events.set(index, source.events.get(index));
    eventParms.set(index, source.eventParms.get(index));
  }
  for (let index = 0; index < stats.length; index++) {
    stats.set(index, source.stats.get(index));
    persistant.set(index, source.persistant.get(index));
    powerups.set(index, source.powerups.get(index));
    ammo.set(index, source.ammo.get(index));
  }
}

function clearVector(vector: Vec3): void { Object.assign(vector, { x: 0, y: 0, z: 0 }); }

/** Field bindings are enumerable because botlib copies goal records with object spread. */
function bindSourceNumber<T extends object>(
  record: T, key: keyof T, view: DataView, offset: number, kind: "int" | "float",
): void {
  Object.defineProperty(record, key, {
    enumerable: true,
    get(): number { return kind === "float" ? view.getFloat32(offset, true) : view.getInt32(offset, true); },
    set(value: number): void {
      if (kind === "float") view.setFloat32(offset, value, true);
      else view.setInt32(offset, value, true);
    },
  });
}

function bindSourceBoolean<T extends object>(record: T, key: keyof T, view: DataView, offset: number): void {
  Object.defineProperty(record, key, {
    enumerable: true,
    get(): boolean { return view.getInt32(offset, true) !== 0; },
    set(value: boolean): void { view.setInt32(offset, value ? 1 : 0, true); },
  });
}

/** Ordinary text assignments use Q_strncpyz; source callers use named operations for other writes. */
function bindSourceText<T extends object>(
  record: T, key: keyof T, bytes: Uint8Array, offset: number, size: number,
): void {
  const remaining = new Uint8Array(bytes.buffer, bytes.byteOffset + offset);
  Object.defineProperty(record, key, {
    enumerable: true,
    get(): string {
      const end = remaining.indexOf(0);
      if (end < 0) throw new RangeError(`Bot ${String(key)} string reads beyond source storage`);
      let value = "";
      for (let index = 0; index < end; index++) {
        const byte = remaining[index];
        if (byte === undefined) throw new RangeError("Bot string byte exceeds source storage");
        value += String.fromCharCode(byte);
      }
      return value;
    },
    set(value: string): void {
      sourceStrncpy(bytes, offset, value, size - 1);
      bytes[offset + size - 1] = 0;
    },
  });
}

/** strncpy copies source bytes until NUL and pads the rest, with no extra terminator at count. */
function sourceStrncpy(bytes: Uint8Array, offset: number, source: string, count: number): void {
  const nul = source.indexOf("\0");
  const length = Math.min(nul < 0 ? source.length : nul, count);
  for (let index = 0; index < length; index++) {
    if (source.charCodeAt(index) > 255) throw new RangeError("Bot strings require source byte characters");
  }
  for (let index = 0; index < length; index++) bytes[offset + index] = source.charCodeAt(index);
  bytes.fill(0, offset + length, offset + count);
}

/** Q_CleanStr leaves bytes after its new terminator untouched. */
function cleanSourceString(bytes: Uint8Array, offset: number): void {
  let read = offset, write = offset;
  for (;;) {
    const byte = bytes[read];
    if (byte === undefined) throw new RangeError("Bot name reads beyond source storage");
    if (byte === 0) break;
    const next = bytes[read + 1];
    if (byte === 94 && next !== undefined && next !== 0 && next !== 94) read += 2;
    else {
      if (byte >= 32 && byte <= 126) bytes[write++] = byte;
      read++;
    }
  }
  bytes[write] = 0;
}

function bindSourceVector<T extends object>(
  record: T, key: keyof T, view: DataView, offset: number, integer = false,
): void {
  const vector: Vec3 = {
    get x(): number { return integer ? view.getInt32(offset, true) : view.getFloat32(offset, true); },
    set x(value: number) { if (integer) view.setInt32(offset, value, true); else view.setFloat32(offset, value, true); },
    get y(): number { return integer ? view.getInt32(offset + 4, true) : view.getFloat32(offset + 4, true); },
    set y(value: number) { if (integer) view.setInt32(offset + 4, value, true); else view.setFloat32(offset + 4, value, true); },
    get z(): number { return integer ? view.getInt32(offset + 8, true) : view.getFloat32(offset + 8, true); },
    set z(value: number) { if (integer) view.setInt32(offset + 8, value, true); else view.setFloat32(offset + 8, value, true); },
  };
  Object.defineProperty(record, key, {
    enumerable: true,
    get(): Vec3 { return vector; },
    set(value: Vec3): void { Object.assign(vector, value); },
  });
}

/** Keep the existing number[] callers while each fixed slot reads and writes its source int. */
function sourceIntArray(view: DataView, offset: number, length: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < length; index++) {
    const fieldOffset = offset + index * 4;
    Object.defineProperty(values, index, {
      enumerable: true,
      get(): number { return view.getInt32(fieldOffset, true); },
      set(value: number): void { view.setInt32(fieldOffset, value, true); },
    });
  }
  Object.defineProperty(values, "length", { writable: false });
  return Object.preventExtensions(values);
}

function sourceRecord(view: DataView, offset: number, length: number): DataView {
  if (offset + length > view.byteLength) throw new RangeError("Embedded bot record exceeds source storage");
  return new DataView(view.buffer, view.byteOffset + offset, length);
}

/** q_shared.h playerState_t uses the same 468-byte layout in both products. */
function sourcePlayerState(product: Product, view: DataView): PlayerState {
  const state = new PlayerState(product);
  bindSourceNumber(state, "commandTime", view, 0, "int");
  bindSourceEnum(state, "pmType", view, 4, PLAYER_MOVE_TYPES);
  bindSourceNumber(state, "bobCycle", view, 8, "int");
  bindSourceNumber(state, "pmFlags", view, 12, "int");
  bindSourceNumber(state, "pmTime", view, 16, "int");
  bindSourceVector(state, "origin", view, 20);
  bindSourceVector(state, "velocity", view, 32);
  bindSourceNumber(state, "weaponTime", view, 44, "int");
  bindSourceNumber(state, "gravity", view, 48, "int");
  bindSourceNumber(state, "speed", view, 52, "int");
  bindSourceVector(state, "deltaAngles", view, 56, true);
  bindSourceNumber(state, "groundEntityNum", view, 68, "int");
  bindSourceNumber(state, "legsTimer", view, 72, "int");
  bindSourceNumber(state, "legsAnim", view, 76, "int");
  bindSourceNumber(state, "torsoTimer", view, 80, "int");
  bindSourceNumber(state, "torsoAnim", view, 84, "int");
  bindSourceNumber(state, "movementDir", view, 88, "int");
  bindSourceVector(state, "grapplePoint", view, 92);
  bindSourceNumber(state, "eFlags", view, 104, "int");
  bindSourceNumber(state, "eventSequence", view, 108, "int");
  bindSourcePlayerSlots(state, "events", view, 112, 2);
  bindSourcePlayerSlots(state, "eventParms", view, 120, 2);
  bindSourceNumber(state, "externalEvent", view, 128, "int");
  bindSourceNumber(state, "externalEventParm", view, 132, "int");
  bindSourceNumber(state, "externalEventTime", view, 136, "int");
  bindSourceNumber(state, "clientNum", view, 140, "int");
  bindSourceEnum(state, "weapon", view, 144, COMMAND_WEAPONS);
  bindSourceEnum(state, "weaponState", view, 148, PLAYER_WEAPON_STATES);
  bindSourceVector(state, "viewangles", view, 152);
  bindSourceNumber(state, "viewheight", view, 164, "int");
  bindSourceNumber(state, "damageEvent", view, 168, "int");
  bindSourceNumber(state, "damageYaw", view, 172, "int");
  bindSourceNumber(state, "damagePitch", view, 176, "int");
  bindSourceNumber(state, "damageCount", view, 180, "int");
  bindSourcePlayerSlots(state, "stats", view, 184, 16);
  bindSourcePlayerSlots(state, "persistant", view, 248, 16);
  bindSourcePlayerSlots(state, "powerups", view, 312, 16);
  bindSourcePlayerSlots(state, "ammo", view, 376, 16);
  bindSourceNumber(state, "generic1", view, 440, "int");
  bindSourceNumber(state, "loopSound", view, 444, "int");
  bindSourceNumber(state, "jumppadEnt", view, 448, "int");
  bindSourceNumber(state, "ping", view, 452, "int");
  bindSourceNumber(state, "pmoveFramecount", view, 456, "int");
  bindSourceNumber(state, "jumppadFrame", view, 460, "int");
  bindSourceNumber(state, "entityEventSequence", view, 464, "int");
  return state;
}

function bindSourceEnum<T extends object, E extends number>(
  record: T, key: keyof T, view: DataView, offset: number, members: readonly E[],
): void {
  Object.defineProperty(record, key, {
    enumerable: true,
    get(): E {
      const value = view.getInt32(offset, true);
      for (const member of members) if (value === member) return member;
      throw new RangeError(`Unsupported bot player ${String(key)} ${value}`);
    },
    set(value: E): void { view.setInt32(offset, value, true); },
  });
}

function bindSourcePlayerSlots(
  state: PlayerState, key: "events" | "eventParms" | "stats" | "persistant" | "powerups" | "ammo",
  view: DataView, offset: number, length: number,
): void {
  const slots = new PlayerStateSlots(length, new Int32Array(view.buffer, view.byteOffset + offset, length));
  Object.defineProperty(state, key, {
    enumerable: true,
    get(): PlayerStateSlots { return slots; },
    set(source: PlayerStateSlots): void {
      for (let index = 0; index < length; index++) slots.set(index, source.get(index));
    },
  });
}

function sourceCommand(view: DataView): UserCommand {
  const command: UserCommand = {
    serverTime: 0, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_NONE,
    forwardmove: 0, rightmove: 0, upmove: 0,
  };
  bindSourceNumber(command, "serverTime", view, 0, "int");
  bindSourceVector(command, "angles", view, 4, true);
  bindSourceNumber(command, "buttons", view, 16, "int");
  Object.defineProperty(command, "weapon", {
    enumerable: true,
    get(): Weapon {
      const value = view.getUint8(20);
      for (const weapon of COMMAND_WEAPONS) if (value === weapon) return weapon;
      throw new RangeError(`Unsupported bot command weapon ${value}`);
    },
    set(value: Weapon): void { view.setUint8(20, value); },
  });
  const moves: readonly (readonly ["forwardmove" | "rightmove" | "upmove", number])[] = [
    ["forwardmove", 21], ["rightmove", 22], ["upmove", 23],
  ];
  for (const [key, offset] of moves) {
    Object.defineProperty(command, key, {
      enumerable: true,
      get(): number { return view.getInt8(offset); },
      set(value: number): void { view.setInt8(offset, value); },
    });
  }
  return command;
}
