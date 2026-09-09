// Ported from id Software's code/game/q_shared.h and bg_public.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { MoveType, Weapon, WeaponState, statSchema } from "./definitions.ts";
import type { Product } from "./definitions.ts";

export const ENTITYNUM_WORLD = 1022;
export const ENTITYNUM_NONE = 1023;

export enum MoveFlags {
  DUCKED = 1, JUMP_HELD = 2, BACKWARDS_JUMP = 8, BACKWARDS_RUN = 16,
  TIME_LAND = 32, TIME_KNOCKBACK = 64, TIME_WATERJUMP = 256,
  RESPAWNED = 512, USE_ITEM_HELD = 1024, GRAPPLE_PULL = 2048,
  FOLLOW = 4096, SCOREBOARD = 8192, INVULEXPAND = 16384,
}

export enum CommandButtons {
  ATTACK = 1, TALK = 2, USE_HOLDABLE = 4, GESTURE = 8, WALKING = 16,
  AFFIRMATIVE = 32, NEGATIVE = 64, GETFLAG = 128, GUARDBASE = 256,
  PATROL = 512, FOLLOWME = 1024, ANY = 2048,
}

export enum PlayerAnimation {
  BOTH_DEATH1 = 0, BOTH_DEAD1 = 1, BOTH_DEATH2 = 2, BOTH_DEAD2 = 3,
  BOTH_DEATH3 = 4, BOTH_DEAD3 = 5, TORSO_GESTURE = 6,
  TORSO_ATTACK = 7, TORSO_ATTACK2 = 8, TORSO_DROP = 9, TORSO_RAISE = 10,
  TORSO_STAND = 11, TORSO_STAND2 = 12, LEGS_WALKCR = 13, LEGS_WALK = 14,
  LEGS_RUN = 15, LEGS_BACK = 16, LEGS_SWIM = 17, LEGS_JUMP = 18,
  LEGS_LAND = 19, LEGS_JUMPB = 20, LEGS_LANDB = 21, LEGS_IDLE = 22,
  LEGS_IDLECR = 23, LEGS_TURN = 24, TORSO_GETFLAG = 25, TORSO_GUARDBASE = 26,
  TORSO_PATROL = 27, TORSO_FOLLOWME = 28, TORSO_AFFIRMATIVE = 29,
  TORSO_NEGATIVE = 30, LEGS_BACKCR = 32, LEGS_BACKWALK = 33,
  FLAG_RUN = 34, FLAG_STAND = 35, FLAG_STAND2RUN = 36,
}

export interface UserCommand {
  serverTime: number;
  angles: Vec3;
  buttons: number;
  weapon: number;
  forwardmove: number;
  rightmove: number;
  upmove: number;
}

/** Fixed source arrays with checked access, including unused protocol slots. */
export class PlayerStateSlots {
  private readonly values: Int32Array;

  constructor(readonly length: number, sourceValues: Int32Array | null = null) {
    if (sourceValues !== null && sourceValues.length !== length) {
      throw new RangeError(`Player state source slots require ${length} values, got ${sourceValues.length}`);
    }
    this.values = sourceValues ?? new Int32Array(length);
  }

  get(index: number): number {
    const value = this.values[index];
    if (value === undefined) throw new RangeError(`Player state slot ${index} outside ${this.length}`);
    return value;
  }

  set(index: number, value: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Player state slot ${index} outside ${this.length}`);
    }
    this.values[index] = value;
  }

  copy(): Int32Array { return this.values.slice(); }
}

export interface PredictableEvent {
  readonly sequence: number;
  readonly event: number;
  readonly parameter: number;
}

export type PlayerStateFields<M extends number = number, W extends number = number, S extends number = number> =
  Omit<PlayerStateRecord<M, W, S>, "copy" | "copyFrom" | "health" | "addEvent">;

function copyVector(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function copySlots(target: PlayerStateSlots, source: PlayerStateSlots): void {
  for (let index = 0; index < target.length; index++) target.set(index, source.get(index));
}

/** Owned playerState_t storage; the engine transports game-defined integer words unchanged. */
export class PlayerStateRecord<M extends number, W extends number, S extends number> {
  commandTime = 0;
  pmType: M;
  bobCycle = 0;
  pmFlags = 0;
  pmTime = 0;
  origin = vec3(0, 0, 0);
  velocity = vec3(0, 0, 0);
  weaponTime = 0;
  gravity = 0;
  speed = 0;
  deltaAngles = vec3(0, 0, 0);
  groundEntityNum = 0;
  legsTimer = 0;
  legsAnim = 0;
  torsoTimer = 0;
  torsoAnim = 0;
  movementDir = 0;
  grapplePoint = vec3(0, 0, 0);
  eFlags = 0;
  eventSequence = 0;
  readonly events = new PlayerStateSlots(2);
  readonly eventParms = new PlayerStateSlots(2);
  externalEvent = 0;
  externalEventParm = 0;
  externalEventTime = 0;
  clientNum = 0;
  weapon: W;
  weaponState: S;
  viewangles = vec3(0, 0, 0);
  viewheight = 0;
  damageEvent = 0;
  damageYaw = 0;
  damagePitch = 0;
  damageCount = 0;
  readonly stats = new PlayerStateSlots(16);
  readonly persistant = new PlayerStateSlots(16);
  readonly powerups = new PlayerStateSlots(16);
  readonly ammo = new PlayerStateSlots(16);
  generic1 = 0;
  loopSound = 0;
  jumppadEnt = 0;
  ping = 0;
  pmoveFramecount = 0;
  jumppadFrame = 0;
  entityEventSequence = 0;

  constructor(private stateProduct: Product, pmType: M, weapon: W, weaponState: S) {
    this.pmType = pmType;
    this.weapon = weapon;
    this.weaponState = weaponState;
  }

  get product(): Product { return this.stateProduct; }

  copy(): PlayerStateRecord<M, W, S> {
    const result = new PlayerStateRecord(this.product, this.pmType, this.weapon, this.weaponState);
    result.copyFrom(this);
    return result;
  }

  copyFrom(source: Readonly<PlayerStateFields<M, W, S>>): void {
    this.stateProduct = source.product;
    this.commandTime = source.commandTime;
    this.pmType = source.pmType;
    this.bobCycle = source.bobCycle;
    this.pmFlags = source.pmFlags;
    this.pmTime = source.pmTime;
    this.origin = copyVector(source.origin);
    this.velocity = copyVector(source.velocity);
    this.weaponTime = source.weaponTime;
    this.gravity = source.gravity;
    this.speed = source.speed;
    this.deltaAngles = copyVector(source.deltaAngles);
    this.groundEntityNum = source.groundEntityNum;
    this.legsTimer = source.legsTimer;
    this.legsAnim = source.legsAnim;
    this.torsoTimer = source.torsoTimer;
    this.torsoAnim = source.torsoAnim;
    this.movementDir = source.movementDir;
    this.grapplePoint = copyVector(source.grapplePoint);
    this.eFlags = source.eFlags;
    this.eventSequence = source.eventSequence;
    copySlots(this.events, source.events);
    copySlots(this.eventParms, source.eventParms);
    this.externalEvent = source.externalEvent;
    this.externalEventParm = source.externalEventParm;
    this.externalEventTime = source.externalEventTime;
    this.clientNum = source.clientNum;
    this.weapon = source.weapon;
    this.weaponState = source.weaponState;
    this.viewangles = copyVector(source.viewangles);
    this.viewheight = source.viewheight;
    this.damageEvent = source.damageEvent;
    this.damageYaw = source.damageYaw;
    this.damagePitch = source.damagePitch;
    this.damageCount = source.damageCount;
    copySlots(this.stats, source.stats);
    copySlots(this.persistant, source.persistant);
    copySlots(this.powerups, source.powerups);
    copySlots(this.ammo, source.ammo);
    this.generic1 = source.generic1;
    this.loopSound = source.loopSound;
    this.jumppadEnt = source.jumppadEnt;
    this.ping = source.ping;
    this.pmoveFramecount = source.pmoveFramecount;
    this.jumppadFrame = source.jumppadFrame;
    this.entityEventSequence = source.entityEventSequence;
  }

  get health(): number { return this.stats.get(statSchema(this.product).health); }
  set health(value: number) { this.stats.set(statSchema(this.product).health, value); }

  addEvent(event: number, parameter = 0): PredictableEvent {
    const sequence = this.eventSequence;
    this.events.set(sequence & 1, event);
    this.eventParms.set(sequence & 1, parameter);
    this.eventSequence = (sequence + 1) | 0;
    return { sequence, event, parameter };
  }
}

export type SourcePlayerState = PlayerStateRecord<number, number, number>;

/** Retail creation is source memset-zero; spawning supplies health, speed and gravity. */
export class PlayerState extends PlayerStateRecord<MoveType, Weapon, WeaponState> {
  constructor(product: Product) {
    super(product, MoveType.PM_NORMAL, Weapon.WP_NONE, WeaponState.WEAPON_READY);
  }

  override copy(): PlayerState {
    const result = new PlayerState(this.product);
    result.copyFrom(this);
    return result;
  }
}

export function createPlayerState(product: Product): PlayerState {
  return new PlayerState(product);
}
