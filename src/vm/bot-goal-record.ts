/*
 * bot_goal_t from id Software's code/game/be_ai_goal.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotGoal } from "../botlib/goals.ts";
import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";

export const QVM_BOT_GOAL_BYTES = 56;

function referenceField(pointer: () => Uint8Array | null, offset: number): DataView {
  const bytes = pointer();
  if (bytes === null) throw new RangeError("QVM bot goal input requires a nonnull pointer");
  if (offset + 4 > bytes.byteLength) throw new RangeError("QVM bot goal input exceeds allocation");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
}

function referenceVector(pointer: () => Uint8Array | null, offset: number): Vec3 {
  return {
    get x(): number { return referenceField(pointer, offset).getFloat32(0, true); },
    get y(): number { return referenceField(pointer, offset + 4).getFloat32(0, true); },
    get z(): number { return referenceField(pointer, offset + 8).getFloat32(0, true); },
  };
}

/** Reads only reached fields and observes writes through overlapping VM pointers. */
export function readQvmBotGoalReference(pointer: () => Uint8Array | null): BotGoal {
  return {
    origin: referenceVector(pointer, 0),
    get area(): number { return referenceField(pointer, 12).getInt32(0, true); },
    mins: referenceVector(pointer, 16),
    maxs: referenceVector(pointer, 28),
    get entity(): number { return referenceField(pointer, 40).getInt32(0, true); },
    get number(): number { return referenceField(pointer, 44).getInt32(0, true); },
    get flags(): number { return referenceField(pointer, 48).getInt32(0, true); },
    get itemInfo(): number { return referenceField(pointer, 52).getInt32(0, true); },
  };
}

function requireRecord(view: DataView, length: number): void {
  if (view.byteLength < length) {
    throw new BinaryError("QVM bot_goal_t", 0,
      `record requires ${length} bytes, received ${view.byteLength}`);
  }
}

function readVector(view: DataView, offset: number): Vec3 {
  return {
    x: view.getFloat32(offset, true),
    y: view.getFloat32(offset + 4, true),
    z: view.getFloat32(offset + 8, true),
  };
}

function writeVector(view: DataView, offset: number, value: Vec3): void {
  view.setFloat32(offset, value.x, true);
  view.setFloat32(offset + 4, value.y, true);
  view.setFloat32(offset + 8, value.z, true);
}

/** Reads an owned goal from an already-resolved source record. */
export function readQvmBotGoal(view: DataView): BotGoal {
  requireRecord(view, QVM_BOT_GOAL_BYTES);
  return {
    origin: readVector(view, 0),
    area: view.getInt32(12, true),
    mins: readVector(view, 16),
    maxs: readVector(view, 28),
    entity: view.getInt32(40, true),
    number: view.getInt32(44, true),
    flags: view.getInt32(48, true),
    itemInfo: view.getInt32(52, true),
  };
}

/** BotPushGoal/GetTopGoal/GetSecondGoal use memcpy, including noncanonical float words. */
export function copyQvmBotGoal(view: DataView, source: Uint8Array): void {
  requireRecord(view, QVM_BOT_GOAL_BYTES);
  if (source.byteLength < QVM_BOT_GOAL_BYTES) {
    throw new BinaryError("QVM bot_goal_t", 0,
      `record requires ${QVM_BOT_GOAL_BYTES} bytes, received ${source.byteLength}`);
  }
  new Uint8Array(view.buffer, view.byteOffset, QVM_BOT_GOAL_BYTES).set(source.subarray(0, QVM_BOT_GOAL_BYTES));
}

/** Queries write only their source fields; the remaining bytes are never read. */
export function writeQvmBotGoal(
  view: DataView, goal: BotGoal, fields: "full" | "level-item" | "location" = "full",
): void {
  requireRecord(view, fields === "full" ? QVM_BOT_GOAL_BYTES : fields === "level-item" ? 52 : 44);
  view.setInt32(12, goal.area, true);
  writeVector(view, 0, goal.origin);
  view.setInt32(40, goal.entity, true);
  writeVector(view, 16, goal.mins);
  writeVector(view, 28, goal.maxs);
  if (fields === "location") return;
  view.setInt32(44, goal.number, true);
  view.setInt32(48, goal.flags, true);
  if (fields === "full") view.setInt32(52, goal.itemInfo, true);
}
