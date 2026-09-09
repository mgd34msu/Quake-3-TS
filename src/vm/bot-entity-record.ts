/*
 * bot_entitystate_t from id Software's game/botlib.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotEntityUpdate } from "../botlib/entity.ts";
import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";

export const QVM_BOT_ENTITY_STATE_BYTES = 112;

function vector(view: DataView, offset: number): Vec3 {
  return { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
}

/** Borrows VM fields so source host callbacks can change later reads in this update. */
export function borrowQvmBotEntityState(view: DataView): BotEntityUpdate {
  if (view.byteLength < QVM_BOT_ENTITY_STATE_BYTES) {
    throw new BinaryError("QVM bot_entitystate_t", 0,
      `record requires ${QVM_BOT_ENTITY_STATE_BYTES} bytes, received ${view.byteLength}`);
  }
  return {
    get type(): number { return view.getInt32(0, true); },
    get flags(): number { return view.getInt32(4, true); },
    get origin(): Vec3 { return vector(view, 8); },
    get angles(): Vec3 { return vector(view, 20); },
    get oldOrigin(): Vec3 { return vector(view, 32); },
    get mins(): Vec3 { return vector(view, 44); },
    get maxs(): Vec3 { return vector(view, 56); },
    get groundEntity(): number { return view.getInt32(68, true); },
    get solid(): number { return view.getInt32(72, true); },
    get modelIndex(): number { return view.getInt32(76, true); },
    get modelIndex2(): number { return view.getInt32(80, true); },
    get frame(): number { return view.getInt32(84, true); },
    get event(): number { return view.getInt32(88, true); },
    get eventParameter(): number { return view.getInt32(92, true); },
    get powerups(): number { return view.getInt32(96, true); },
    get weapon(): number { return view.getInt32(100, true); },
    get legsAnimation(): number { return view.getInt32(104, true); },
    get torsoAnimation(): number { return view.getInt32(108, true); },
  };
}

/** Detached decoding for records which must outlive the VM call. */
export function readQvmBotEntityState(view: DataView): BotEntityUpdate {
  return { ...borrowQvmBotEntityState(view) };
}
