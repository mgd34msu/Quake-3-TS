// Retail cgame state from id Software's code/game/bg_public.h and q_shared.h,
// consumed by code/cgame/cg_snapshot.c. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import type { Snapshot } from "../protocol/server-message.ts";
import { EntityState } from "../shared/entity-state.ts";
import type { EntityStateFields } from "../shared/entity-state.ts";
import { PlayerStateRecord } from "../shared/player-state.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";

export interface RetailSnapshot extends Omit<Snapshot, "playerState" | "entities"> {
  readonly playerState: SourcePlayerState;
  readonly entities: readonly EntityState[];
}

function retailEntityState(source: Readonly<EntityStateFields>): EntityState {
  const result = new EntityState();
  result.copyFrom({
    number: source.number,
    eType: source.eType,
    eFlags: source.eFlags,
    pos: source.pos,
    apos: source.apos,
    time: source.time,
    time2: source.time2,
    origin: source.origin,
    origin2: source.origin2,
    angles: source.angles,
    angles2: source.angles2,
    otherEntityNum: source.otherEntityNum,
    otherEntityNum2: source.otherEntityNum2,
    groundEntityNum: source.groundEntityNum,
    constantLight: source.constantLight,
    loopSound: source.loopSound,
    modelindex: source.modelindex,
    modelindex2: source.modelindex2,
    clientNum: source.clientNum,
    frame: source.frame,
    solid: source.solid,
    event: source.event,
    eventParm: source.eventParm,
    powerups: source.powerups,
    weapon: source.weapon,
    legsAnim: source.legsAnim,
    torsoAnim: source.torsoAnim,
    generic1: source.generic1,
  });
  return result;
}

/** Raw transport becomes owned retail state only when TypeScript cgame consumes it. */
export function retailSnapshot(source: Snapshot): RetailSnapshot {
  const playerState = new PlayerStateRecord<number, number, number>(source.playerState.product, 0, 0, 0);
  playerState.copyFrom(source.playerState);
  return {
    messageNumber: source.messageNumber,
    serverTime: source.serverTime,
    deltaNumber: source.deltaNumber,
    flags: source.flags,
    serverCommandNumber: source.serverCommandNumber,
    parseEntitiesNumber: source.parseEntitiesNumber,
    areaMask: new Uint8Array(source.areaMask),
    playerState,
    entities: source.entities.map(retailEntityState),
  };
}
