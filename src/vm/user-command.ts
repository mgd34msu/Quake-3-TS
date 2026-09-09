/*
 * QVM usercmd_t layout from Quake III Arena game/q_shared.h.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { UserCommand } from "../shared/player-state.ts";

export const QVM_USER_COMMAND_BYTES = 24;

function checkView(view: DataView): void {
  if (view.byteLength < QVM_USER_COMMAND_BYTES) throw new RangeError("Truncated QVM usercmd_t");
}

/** The view starts at a resolved VM pointer; this is not a network delta record. */
export function readQvmUserCommand(view: DataView): UserCommand {
  checkView(view);
  return {
    serverTime: view.getInt32(0, true),
    // These are full integer angle words, not binary32 vector components.
    angles: { x: view.getInt32(4, true), y: view.getInt32(8, true), z: view.getInt32(12, true) },
    buttons: view.getInt32(16, true), weapon: view.getUint8(20),
    forwardmove: view.getInt8(21), rightmove: view.getInt8(22), upmove: view.getInt8(23),
  };
}

export function writeQvmUserCommand(view: DataView, command: UserCommand): void {
  checkView(view);
  view.setInt32(0, command.serverTime, true);
  view.setInt32(4, command.angles.x, true);
  view.setInt32(8, command.angles.y, true);
  view.setInt32(12, command.angles.z, true);
  view.setInt32(16, command.buttons, true);
  view.setUint8(20, command.weapon);
  view.setInt8(21, command.forwardmove);
  view.setInt8(22, command.rightmove);
  view.setInt8(23, command.upmove);
}
