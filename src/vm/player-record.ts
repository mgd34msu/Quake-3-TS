// Ported from id Software's code/game/q_shared.h playerState_t.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";
import type { Product } from "../shared/definitions.ts";
import { PlayerStateRecord } from "../shared/player-state.ts";
import type { PlayerStateFields, PlayerStateSlots, SourcePlayerState } from "../shared/player-state.ts";

/** Selected 32-bit QVM ABI: 117 four-byte words, including the non-network tail. */
export const QVM_PLAYER_STATE_BYTES = 468;

function checkRecord(view: DataView): void {
  if (view.byteLength < QVM_PLAYER_STATE_BYTES) {
    throw new BinaryError("QVM playerState_t", 0, `requires ${QVM_PLAYER_STATE_BYTES} bytes, got ${view.byteLength}`);
  }
}

function readVector(view: DataView, offset: number): Vec3 {
  return { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
}

function writeVector(view: DataView, offset: number, value: Vec3): void {
  view.setFloat32(offset, value.x, true);
  view.setFloat32(offset + 4, value.y, true);
  view.setFloat32(offset + 8, value.z, true);
}

function readSlots(view: DataView, offset: number, slots: PlayerStateSlots): void {
  for (let index = 0; index < slots.length; index++) slots.set(index, view.getInt32(offset + 4 * index, true));
}

function writeSlots(view: DataView, offset: number, slots: PlayerStateSlots): void {
  for (let index = 0; index < slots.length; index++) view.setInt32(offset + 4 * index, slots.get(index), true);
}

/** The caller resolves the VM pointer; this view starts at the complete C record. */
export function readQvmPlayerState(view: DataView, product: Product): SourcePlayerState {
  checkRecord(view);
  const state = new PlayerStateRecord<number, number, number>(product, 0, 0, 0);
  state.commandTime = view.getInt32(0, true);
  state.pmType = view.getInt32(4, true);
  state.bobCycle = view.getInt32(8, true);
  state.pmFlags = view.getInt32(12, true);
  state.pmTime = view.getInt32(16, true);
  state.origin = readVector(view, 20);
  state.velocity = readVector(view, 32);
  state.weaponTime = view.getInt32(44, true);
  state.gravity = view.getInt32(48, true);
  state.speed = view.getInt32(52, true);
  state.deltaAngles = { x: view.getInt32(56, true), y: view.getInt32(60, true), z: view.getInt32(64, true) };
  state.groundEntityNum = view.getInt32(68, true);
  state.legsTimer = view.getInt32(72, true);
  state.legsAnim = view.getInt32(76, true);
  state.torsoTimer = view.getInt32(80, true);
  state.torsoAnim = view.getInt32(84, true);
  state.movementDir = view.getInt32(88, true);
  state.grapplePoint = readVector(view, 92);
  state.eFlags = view.getInt32(104, true);
  state.eventSequence = view.getInt32(108, true);
  readSlots(view, 112, state.events);
  readSlots(view, 120, state.eventParms);
  state.externalEvent = view.getInt32(128, true);
  state.externalEventParm = view.getInt32(132, true);
  state.externalEventTime = view.getInt32(136, true);
  state.clientNum = view.getInt32(140, true);
  state.weapon = view.getInt32(144, true);
  state.weaponState = view.getInt32(148, true);
  state.viewangles = readVector(view, 152);
  state.viewheight = view.getInt32(164, true);
  state.damageEvent = view.getInt32(168, true);
  state.damageYaw = view.getInt32(172, true);
  state.damagePitch = view.getInt32(176, true);
  state.damageCount = view.getInt32(180, true);
  readSlots(view, 184, state.stats);
  readSlots(view, 248, state.persistant);
  readSlots(view, 312, state.powerups);
  readSlots(view, 376, state.ammo);
  state.generic1 = view.getInt32(440, true);
  state.loopSound = view.getInt32(444, true);
  state.jumppadEnt = view.getInt32(448, true);
  state.ping = view.getInt32(452, true);
  state.pmoveFramecount = view.getInt32(456, true);
  state.jumppadFrame = view.getInt32(460, true);
  state.entityEventSequence = view.getInt32(464, true);
  return state;
}

/** Writes exactly playerState_t, preserving surrounding VM memory. */
export function writeQvmPlayerState(view: DataView, state: Readonly<PlayerStateFields>): void {
  checkRecord(view);
  view.setInt32(0, state.commandTime, true);
  view.setInt32(4, state.pmType, true);
  view.setInt32(8, state.bobCycle, true);
  view.setInt32(12, state.pmFlags, true);
  view.setInt32(16, state.pmTime, true);
  writeVector(view, 20, state.origin);
  writeVector(view, 32, state.velocity);
  view.setInt32(44, state.weaponTime, true);
  view.setInt32(48, state.gravity, true);
  view.setInt32(52, state.speed, true);
  view.setInt32(56, state.deltaAngles.x, true);
  view.setInt32(60, state.deltaAngles.y, true);
  view.setInt32(64, state.deltaAngles.z, true);
  view.setInt32(68, state.groundEntityNum, true);
  view.setInt32(72, state.legsTimer, true);
  view.setInt32(76, state.legsAnim, true);
  view.setInt32(80, state.torsoTimer, true);
  view.setInt32(84, state.torsoAnim, true);
  view.setInt32(88, state.movementDir, true);
  writeVector(view, 92, state.grapplePoint);
  view.setInt32(104, state.eFlags, true);
  view.setInt32(108, state.eventSequence, true);
  writeSlots(view, 112, state.events);
  writeSlots(view, 120, state.eventParms);
  view.setInt32(128, state.externalEvent, true);
  view.setInt32(132, state.externalEventParm, true);
  view.setInt32(136, state.externalEventTime, true);
  view.setInt32(140, state.clientNum, true);
  view.setInt32(144, state.weapon, true);
  view.setInt32(148, state.weaponState, true);
  writeVector(view, 152, state.viewangles);
  view.setInt32(164, state.viewheight, true);
  view.setInt32(168, state.damageEvent, true);
  view.setInt32(172, state.damageYaw, true);
  view.setInt32(176, state.damagePitch, true);
  view.setInt32(180, state.damageCount, true);
  writeSlots(view, 184, state.stats);
  writeSlots(view, 248, state.persistant);
  writeSlots(view, 312, state.powerups);
  writeSlots(view, 376, state.ammo);
  view.setInt32(440, state.generic1, true);
  view.setInt32(444, state.loopSound, true);
  view.setInt32(448, state.jumppadEnt, true);
  view.setInt32(452, state.ping, true);
  view.setInt32(456, state.pmoveFramecount, true);
  view.setInt32(460, state.jumppadFrame, true);
  view.setInt32(464, state.entityEventSequence, true);
}
