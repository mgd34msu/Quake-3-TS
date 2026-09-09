/* trace_t and cplane_t from id Software's code/game/q_shared.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
import { BinaryError } from "../core/binary.ts";
import type { SourceTraceResult } from "../collision/world.ts";

export const QVM_TRACE_BYTES = 56;

/** The complete source record also carries a plane when that plane is invalid. */
export interface QvmTraceRecord extends SourceTraceResult {
  readonly entityNum: number;
}

/** Write a resolved allocation. The source trace work starts with zeroed padding. */
export function writeQvmTrace(view: DataView, value: QvmTraceRecord): void {
  if (view.byteLength < QVM_TRACE_BYTES) {
    throw new BinaryError("QVM trace_t", 0,
      `record requires ${QVM_TRACE_BYTES} bytes, received ${view.byteLength}`);
  }
  view.setInt32(0, Number(value.allSolid), true);
  view.setInt32(4, Number(value.startSolid), true);
  view.setFloat32(8, value.fraction, true);
  view.setFloat32(12, value.end.x, true);
  view.setFloat32(16, value.end.y, true);
  view.setFloat32(20, value.end.z, true);
  view.setFloat32(24, value.plane.normal.x, true);
  view.setFloat32(28, value.plane.normal.y, true);
  view.setFloat32(32, value.plane.normal.z, true);
  view.setFloat32(36, value.plane.distance, true);
  view.setUint8(40, value.plane.type);
  view.setUint8(41, value.plane.signbits);
  view.setUint16(42, 0, true);
  view.setInt32(44, value.surfaceFlags, true);
  view.setInt32(48, value.contents, true);
  view.setInt32(52, value.entityNum, true);
}
