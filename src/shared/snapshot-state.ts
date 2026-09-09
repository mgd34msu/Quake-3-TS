// Ported from id Software's code/game/bg_misc.c, BG_PlayerStateToEntityState
// and BG_PlayerStateToEntityStateExtraPolate. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.

import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { EntityType, GIB_HEALTH, MoveType } from "./definitions.ts";
import type { EntityState } from "./entity-state.ts";
import type { SourcePlayerState } from "./player-state.ts";
import { TrajectoryType } from "./trajectory.ts";

// q_shared.h's SnapVector casts to int, unlike Sys_SnapVector's nearest rounding.
// The out-of-range conversion matches the native x86 source's indefinite integer.
function sourceSnapComponent(component: number): number {
  const value = Math.fround(component);
  return value >= -2147483648 && value < 2147483648 ? Math.trunc(value) + 0 : -2147483648;
}

function copyPosition(value: Vec3, snap: boolean): Vec3 {
  return snap
    ? vec3(sourceSnapComponent(value.x), sourceSnapComponent(value.y), sourceSnapComponent(value.z))
    : { ...value };
}

function convertPlayerState(ps: SourcePlayerState, s: EntityState, snap: boolean, extrapolationTime: number | null): void {
  s.eType = ps.pmType === MoveType.PM_INTERMISSION || ps.pmType === MoveType.PM_SPECTATOR || ps.health <= GIB_HEALTH
    ? EntityType.ET_INVISIBLE : EntityType.ET_PLAYER;
  s.number = ps.clientNum;
  s.pos = {
    type: extrapolationTime === null ? TrajectoryType.TR_INTERPOLATE : TrajectoryType.TR_LINEAR_STOP,
    base: copyPosition(ps.origin, snap),
    delta: { ...ps.velocity },
    time: extrapolationTime === null ? s.pos.time : extrapolationTime,
    duration: extrapolationTime === null ? s.pos.duration : 50,
  };
  s.apos = { ...s.apos, type: TrajectoryType.TR_INTERPOLATE, base: copyPosition(ps.viewangles, snap) };
  s.angles2 = { ...s.angles2, y: Math.fround(ps.movementDir) };
  s.legsAnim = ps.legsAnim;
  s.torsoAnim = ps.torsoAnim;
  s.clientNum = ps.clientNum;
  s.eFlags = ps.health <= 0 ? ps.eFlags | 1 : ps.eFlags & ~1;

  if (ps.externalEvent !== 0) {
    s.event = ps.externalEvent;
    s.eventParm = ps.externalEventParm;
  } else if (ps.entityEventSequence < ps.eventSequence) {
    const oldest = (ps.eventSequence - 2) | 0;
    if (ps.entityEventSequence < oldest) ps.entityEventSequence = oldest;
    const slot = ps.entityEventSequence & 1;
    s.event = ps.events.get(slot) | ((ps.entityEventSequence & 3) << 8);
    s.eventParm = ps.eventParms.get(slot);
    ps.entityEventSequence = (ps.entityEventSequence + 1) | 0;
  }

  s.weapon = ps.weapon;
  s.groundEntityNum = ps.groundEntityNum;
  s.powerups = 0;
  for (let index = 0; index < ps.powerups.length; index++) {
    if (ps.powerups.get(index) !== 0) s.powerups |= 1 << index;
  }
  s.loopSound = ps.loopSound;
  s.generic1 = ps.generic1;
}

/** Updates source-owned fields and consumes one pending predictable event. */
export function playerStateToEntityState(ps: SourcePlayerState, destination: EntityState, snap: boolean): void {
  convertPlayerState(ps, destination, snap, null);
}

/** Publishes at most 50ms of linear extrapolation, matching the source's fixed duration. */
export function playerStateToEntityStateExtraPolate(ps: SourcePlayerState, destination: EntityState, time: number, snap: boolean): void {
  convertPlayerState(ps, destination, snap, time);
}
