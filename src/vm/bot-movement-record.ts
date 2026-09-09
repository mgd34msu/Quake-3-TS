/*
 * bot_initmove_t and bot_moveresult_t from id Software's game/be_ai_move.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { MovementTarget } from "../botlib/movement-routing.ts";
import type { BotInitMove, BotMoveResult } from "../botlib/movement-state.ts";
import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";

export const QVM_BOT_INIT_MOVE_BYTES = 68;
export const QVM_BOT_MOVE_RESULT_BYTES = 52;

type Pointer = () => Uint8Array | null;

function field(pointer: Pointer, offset: number): DataView {
  const bytes = pointer();
  if (bytes === null) throw new RangeError("QVM bot movement requires a nonnull pointer");
  if (offset + 4 > bytes.byteLength) {
    throw new BinaryError("QVM bot movement record", offset,
      `field exceeds ${bytes.byteLength}-byte allocation`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
}

function vector(pointer: Pointer, offset: number): Vec3 {
  return {
    get x(): number { return field(pointer, offset).getFloat32(0, true); },
    get y(): number { return field(pointer, offset + 4).getFloat32(0, true); },
    get z(): number { return field(pointer, offset + 8).getFloat32(0, true); },
  };
}

function writeVector(pointer: Pointer, offset: number, value: Vec3): void {
  field(pointer, offset).setFloat32(0, value.x, true);
  field(pointer, offset + 4).setFloat32(0, value.y, true);
  field(pointer, offset + 8).setFloat32(0, value.z, true);
}

/** Field reads follow the owning BotInitMoveState handle check and copy order. */
export function qvmBotInitMoveReference(pointer: Pointer): BotInitMove {
  return {
    origin: vector(pointer, 0),
    velocity: vector(pointer, 12),
    viewOffset: vector(pointer, 24),
    get entityNum(): number { return field(pointer, 36).getInt32(0, true); },
    get client(): number { return field(pointer, 40).getInt32(0, true); },
    get thinkTime(): number { return field(pointer, 44).getFloat32(0, true); },
    get presenceType(): number { return field(pointer, 48).getInt32(0, true); },
    viewAngles: vector(pointer, 52),
    get orMoveFlags(): number { return field(pointer, 64).getInt32(0, true); },
  };
}

/** The source clears six words before checking the handle, leaving the tail live. */
export function qvmBotMoveResultReference(pointer: Pointer): BotMoveResult {
  return {
    get failure(): boolean { return field(pointer, 0).getInt32(0, true) !== 0; },
    set failure(value: boolean) { field(pointer, 0).setInt32(0, Number(value), true); },
    get type(): number { return field(pointer, 4).getInt32(0, true); },
    set type(value: number) { field(pointer, 4).setInt32(0, value, true); },
    get blocked(): boolean { return field(pointer, 8).getInt32(0, true) !== 0; },
    set blocked(value: boolean) { field(pointer, 8).setInt32(0, Number(value), true); },
    get blockEntity(): number { return field(pointer, 12).getInt32(0, true); },
    set blockEntity(value: number) { field(pointer, 12).setInt32(0, value, true); },
    get travelType(): number { return field(pointer, 16).getInt32(0, true); },
    set travelType(value: number) { field(pointer, 16).setInt32(0, value, true); },
    get flags(): number { return field(pointer, 20).getInt32(0, true); },
    set flags(value: number) { field(pointer, 20).setInt32(0, value, true); },
    get weapon(): number { return field(pointer, 24).getInt32(0, true); },
    set weapon(value: number) { field(pointer, 24).setInt32(0, value, true); },
    get moveDirection(): Vec3 { return vector(pointer, 28); },
    set moveDirection(value: Vec3) { writeVector(pointer, 28, value); },
    get idealViewAngles(): Vec3 { return vector(pointer, 40); },
    set idealViewAngles(value: Vec3) { writeVector(pointer, 40, value); },
  };
}

export function qvmBotMovementVector(pointer: Pointer): Vec3 { return vector(pointer, 0); }

/** Target writes are visible immediately, including a route query returning false. */
export function qvmBotMovementTarget(pointer: Pointer): MovementTarget {
  return {
    get value(): Vec3 { return vector(pointer, 0); },
    set value(value: Vec3) { writeVector(pointer, 0, value); },
  };
}
