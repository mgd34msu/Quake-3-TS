// Port of id Software's code/game/q_shared.h entityState_t. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { TrajectoryType } from "./trajectory.ts";
import type { Trajectory } from "./trajectory.ts";

function zeroTrajectory<T extends number>(type: T): Trajectory<T> {
  return { type, time: 0, duration: 0, base: vec3(0, 0, 0), delta: vec3(0, 0, 0) };
}

function copyVector(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function copyTrajectory<T extends number>(value: Trajectory<T>): Trajectory<T> {
  return { type: value.type, time: value.time, duration: value.duration,
    base: copyVector(value.base), delta: copyVector(value.delta) };
}

export type EntityStateFields<T extends number = number> = Omit<EntityStateRecord<T>, "copy" | "copyFrom">;

/** Owned entityState_t storage. Immutable vector and trajectory records are replaced on updates. */
export class EntityStateRecord<T extends number> {
  number = 0;
  eType = 0;
  eFlags = 0;
  pos: Trajectory<T>;
  apos: Trajectory<T>;
  time = 0;
  time2 = 0;
  origin = vec3(0, 0, 0);
  origin2 = vec3(0, 0, 0);
  angles = vec3(0, 0, 0);
  angles2 = vec3(0, 0, 0);
  otherEntityNum = 0;
  otherEntityNum2 = 0;
  groundEntityNum = 0;
  constantLight = 0;
  loopSound = 0;
  modelindex = 0;
  modelindex2 = 0;
  clientNum = 0;
  frame = 0;
  solid = 0;
  event = 0;
  eventParm = 0;
  powerups = 0;
  weapon = 0;
  legsAnim = 0;
  torsoAnim = 0;
  generic1 = 0;

  constructor(zeroType: T) {
    this.pos = zeroTrajectory(zeroType);
    this.apos = zeroTrajectory(zeroType);
  }

  copy(): EntityStateRecord<T> {
    const result = new EntityStateRecord(this.pos.type);
    result.copyFrom(this);
    return result;
  }

  copyFrom(source: Readonly<EntityStateFields<T>>): void {
    copyEntityStateFields(this, source);
  }
}

export type SourceEntityState = EntityStateRecord<number>;

/** Source enum storage retains raw tags; creation follows memset-zero. */
export class EntityState extends EntityStateRecord<number> {
  constructor() {
    super(TrajectoryType.TR_STATIONARY);
  }

  override copy(): EntityState {
    const result = new EntityState();
    result.copyFrom(this);
    return result;
  }
}

export function copyEntityStateFields<T extends number>(target: EntityStateFields<T>, source: Readonly<EntityStateFields<T>>): void {
  target.number = source.number;
  target.eType = source.eType;
  target.eFlags = source.eFlags;
  target.pos = copyTrajectory(source.pos);
  target.apos = copyTrajectory(source.apos);
  target.time = source.time;
  target.time2 = source.time2;
  target.origin = copyVector(source.origin);
  target.origin2 = copyVector(source.origin2);
  target.angles = copyVector(source.angles);
  target.angles2 = copyVector(source.angles2);
  target.otherEntityNum = source.otherEntityNum;
  target.otherEntityNum2 = source.otherEntityNum2;
  target.groundEntityNum = source.groundEntityNum;
  target.constantLight = source.constantLight;
  target.loopSound = source.loopSound;
  target.modelindex = source.modelindex;
  target.modelindex2 = source.modelindex2;
  target.clientNum = source.clientNum;
  target.frame = source.frame;
  target.solid = source.solid;
  target.event = source.event;
  target.eventParm = source.eventParm;
  target.powerups = source.powerups;
  target.weapon = source.weapon;
  target.legsAnim = source.legsAnim;
  target.torsoAnim = source.torsoAnim;
  target.generic1 = source.generic1;
}
