// Ported from id Software's code/game/bg_public.h and q_shared.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

export type Product = "baseq3" | "missionpack";

export const DEFAULT_GRAVITY = 800;
export const GIB_HEALTH = -40;
export const ARMOR_PROTECTION = 0.66;
export const MAX_ITEMS = 256;
export const EVENT_VALID_MSEC = 300;
export const EV_EVENT_BIT1 = 0x100;
export const EV_EVENT_BIT2 = 0x200;
export const EV_EVENT_BITS = 0x300;

export enum GameType {
  GT_FFA = 0,
  GT_TOURNAMENT = 1,
  GT_SINGLE_PLAYER = 2,
  GT_TEAM = 3,
  GT_CTF = 4,
  GT_1FCTF = 5,
  GT_OBELISK = 6,
  GT_HARVESTER = 7,
  GT_MAX_GAME_TYPE = 8,
}

export enum MoveType {
  PM_NORMAL = 0,
  PM_NOCLIP = 1,
  PM_SPECTATOR = 2,
  PM_DEAD = 3,
  PM_FREEZE = 4,
  PM_INTERMISSION = 5,
  PM_SPINTERMISSION = 6,
}

export enum WeaponState {
  WEAPON_READY = 0,
  WEAPON_RAISING = 1,
  WEAPON_DROPPING = 2,
  WEAPON_FIRING = 3,
}

export enum Powerup {
  PW_NONE = 0,
  PW_QUAD = 1,
  PW_BATTLESUIT = 2,
  PW_HASTE = 3,
  PW_INVIS = 4,
  PW_REGEN = 5,
  PW_FLIGHT = 6,
  PW_REDFLAG = 7,
  PW_BLUEFLAG = 8,
  PW_NEUTRALFLAG = 9,
  PW_SCOUT = 10,
  PW_GUARD = 11,
  PW_DOUBLER = 12,
  PW_AMMOREGEN = 13,
  PW_INVULNERABILITY = 14,
  PW_NUM_POWERUPS = 15,
}

export enum Holdable {
  HI_NONE = 0,
  HI_TELEPORTER = 1,
  HI_MEDKIT = 2,
  HI_KAMIKAZE = 3,
  HI_PORTAL = 4,
  HI_INVULNERABILITY = 5,
  HI_NUM_HOLDABLE = 6,
}

export enum Weapon {
  WP_NONE = 0,
  WP_GAUNTLET = 1,
  WP_MACHINEGUN = 2,
  WP_SHOTGUN = 3,
  WP_GRENADE_LAUNCHER = 4,
  WP_ROCKET_LAUNCHER = 5,
  WP_LIGHTNING = 6,
  WP_RAILGUN = 7,
  WP_PLASMAGUN = 8,
  WP_BFG = 9,
  WP_GRAPPLING_HOOK = 10,
  WP_NAILGUN = 11,
  WP_PROX_LAUNCHER = 12,
  WP_CHAINGUN = 13,
}

export enum EntityEvent {
  EV_NONE = 0,
  EV_FOOTSTEP = 1,
  EV_FOOTSTEP_METAL = 2,
  EV_FOOTSPLASH = 3,
  EV_FOOTWADE = 4,
  EV_SWIM = 5,
  EV_STEP_4 = 6,
  EV_STEP_8 = 7,
  EV_STEP_12 = 8,
  EV_STEP_16 = 9,
  EV_FALL_SHORT = 10,
  EV_FALL_MEDIUM = 11,
  EV_FALL_FAR = 12,
  EV_JUMP_PAD = 13,
  EV_JUMP = 14,
  EV_WATER_TOUCH = 15,
  EV_WATER_LEAVE = 16,
  EV_WATER_UNDER = 17,
  EV_WATER_CLEAR = 18,
  EV_ITEM_PICKUP = 19,
  EV_GLOBAL_ITEM_PICKUP = 20,
  EV_NOAMMO = 21,
  EV_CHANGE_WEAPON = 22,
  EV_FIRE_WEAPON = 23,
  EV_USE_ITEM0 = 24,
  EV_USE_ITEM1 = 25,
  EV_USE_ITEM2 = 26,
  EV_USE_ITEM3 = 27,
  EV_USE_ITEM4 = 28,
  EV_USE_ITEM5 = 29,
  EV_USE_ITEM6 = 30,
  EV_USE_ITEM7 = 31,
  EV_USE_ITEM8 = 32,
  EV_USE_ITEM9 = 33,
  EV_USE_ITEM10 = 34,
  EV_USE_ITEM11 = 35,
  EV_USE_ITEM12 = 36,
  EV_USE_ITEM13 = 37,
  EV_USE_ITEM14 = 38,
  EV_USE_ITEM15 = 39,
  EV_ITEM_RESPAWN = 40,
  EV_ITEM_POP = 41,
  EV_PLAYER_TELEPORT_IN = 42,
  EV_PLAYER_TELEPORT_OUT = 43,
  EV_GRENADE_BOUNCE = 44,
  EV_GENERAL_SOUND = 45,
  EV_GLOBAL_SOUND = 46,
  EV_GLOBAL_TEAM_SOUND = 47,
  EV_BULLET_HIT_FLESH = 48,
  EV_BULLET_HIT_WALL = 49,
  EV_MISSILE_HIT = 50,
  EV_MISSILE_MISS = 51,
  EV_MISSILE_MISS_METAL = 52,
  EV_RAILTRAIL = 53,
  EV_SHOTGUN = 54,
  EV_BULLET = 55,
  EV_PAIN = 56,
  EV_DEATH1 = 57,
  EV_DEATH2 = 58,
  EV_DEATH3 = 59,
  EV_OBITUARY = 60,
  EV_POWERUP_QUAD = 61,
  EV_POWERUP_BATTLESUIT = 62,
  EV_POWERUP_REGEN = 63,
  EV_GIB_PLAYER = 64,
  EV_SCOREPLUM = 65,
  EV_PROXIMITY_MINE_STICK = 66,
  EV_PROXIMITY_MINE_TRIGGER = 67,
  EV_KAMIKAZE = 68,
  EV_OBELISKEXPLODE = 69,
  EV_OBELISKPAIN = 70,
  EV_INVUL_IMPACT = 71,
  EV_JUICED = 72,
  EV_LIGHTNINGBOLT = 73,
  EV_DEBUG_LINE = 74,
  EV_STOPLOOPINGSOUND = 75,
  EV_TAUNT = 76,
  EV_TAUNT_YES = 77,
  EV_TAUNT_NO = 78,
  EV_TAUNT_FOLLOWME = 79,
  EV_TAUNT_GETFLAG = 80,
  EV_TAUNT_GUARDBASE = 81,
  EV_TAUNT_PATROL = 82,
}

export enum Team {
  TEAM_FREE = 0,
  TEAM_RED = 1,
  TEAM_BLUE = 2,
  TEAM_SPECTATOR = 3,
  TEAM_NUM_TEAMS = 4,
}

export enum ItemType {
  IT_BAD = 0,
  IT_WEAPON = 1,
  IT_AMMO = 2,
  IT_ARMOR = 3,
  IT_HEALTH = 4,
  IT_POWERUP = 5,
  IT_HOLDABLE = 6,
  IT_PERSISTANT_POWERUP = 7,
  IT_TEAM = 8,
}

export enum EntityType {
  ET_GENERAL = 0,
  ET_PLAYER = 1,
  ET_ITEM = 2,
  ET_MISSILE = 3,
  ET_MOVER = 4,
  ET_BEAM = 5,
  ET_PORTAL = 6,
  ET_SPEAKER = 7,
  ET_PUSH_TRIGGER = 8,
  ET_TELEPORT_TRIGGER = 9,
  ET_INVISIBLE = 10,
  ET_GRAPPLE = 11,
  ET_TEAM = 12,
  ET_EVENTS = 13,
}

export enum PersistentIndex {
  PERS_SCORE = 0,
  PERS_HITS = 1,
  PERS_RANK = 2,
  PERS_TEAM = 3,
  PERS_SPAWN_COUNT = 4,
  PERS_PLAYEREVENTS = 5,
  PERS_ATTACKER = 6,
  PERS_ATTACKEE_ARMOR = 7,
  PERS_KILLED = 8,
  PERS_IMPRESSIVE_COUNT = 9,
  PERS_EXCELLENT_COUNT = 10,
  PERS_DEFEND_COUNT = 11,
  PERS_ASSIST_COUNT = 12,
  PERS_GAUNTLET_FRAG_COUNT = 13,
  PERS_CAPTURES = 14,
}

export enum BaseStatIndex {
  STAT_HEALTH = 0,
  STAT_HOLDABLE_ITEM = 1,
  STAT_WEAPONS = 2,
  STAT_ARMOR = 3,
  STAT_DEAD_YAW = 4,
  STAT_CLIENTS_READY = 5,
  STAT_MAX_HEALTH = 6,
}

export enum MissionpackStatIndex {
  STAT_HEALTH = 0,
  STAT_HOLDABLE_ITEM = 1,
  STAT_PERSISTANT_POWERUP = 2,
  STAT_WEAPONS = 3,
  STAT_ARMOR = 4,
  STAT_DEAD_YAW = 5,
  STAT_CLIENTS_READY = 6,
  STAT_MAX_HEALTH = 7,
}

export interface StatSchema {
  readonly health: number;
  readonly holdableItem: number;
  readonly weapons: number;
  readonly armor: number;
  readonly deadYaw: number;
  readonly clientsReady: number;
  readonly maxHealth: number;
}

const baseStats = Object.freeze({
  product: "baseq3",
  health: BaseStatIndex.STAT_HEALTH,
  holdableItem: BaseStatIndex.STAT_HOLDABLE_ITEM,
  weapons: BaseStatIndex.STAT_WEAPONS,
  armor: BaseStatIndex.STAT_ARMOR,
  deadYaw: BaseStatIndex.STAT_DEAD_YAW,
  clientsReady: BaseStatIndex.STAT_CLIENTS_READY,
  maxHealth: BaseStatIndex.STAT_MAX_HEALTH,
} satisfies StatSchema & { readonly product: "baseq3" });

const missionpackStats = Object.freeze({
  product: "missionpack",
  health: MissionpackStatIndex.STAT_HEALTH,
  holdableItem: MissionpackStatIndex.STAT_HOLDABLE_ITEM,
  persistentPowerup: MissionpackStatIndex.STAT_PERSISTANT_POWERUP,
  weapons: MissionpackStatIndex.STAT_WEAPONS,
  armor: MissionpackStatIndex.STAT_ARMOR,
  deadYaw: MissionpackStatIndex.STAT_DEAD_YAW,
  clientsReady: MissionpackStatIndex.STAT_CLIENTS_READY,
  maxHealth: MissionpackStatIndex.STAT_MAX_HEALTH,
} satisfies StatSchema & { readonly product: "missionpack"; readonly persistentPowerup: number });

export function statSchema(product: Product): typeof baseStats | typeof missionpackStats {
  return product === "baseq3" ? baseStats : missionpackStats;
}

export function weaponCount(product: Product): number {
  return product === "baseq3" ? 11 : 14;
}

export function weaponAvailable(product: Product, weapon: Weapon): boolean {
  return weapon > Weapon.WP_NONE && weapon < weaponCount(product);
}
