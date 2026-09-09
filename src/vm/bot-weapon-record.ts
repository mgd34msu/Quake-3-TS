/*
 * weaponinfo_t copy from id Software's botlib/be_ai_weap.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BinaryError } from "../core/binary.ts";

export const QVM_WEAPON_INFO_BYTES = 552;

/** BotGetWeaponInfo copies the complete record, including bytes after string NULs. */
export function writeQvmWeaponInfo(view: DataView, source: Uint8Array): void {
  if (view.byteLength < QVM_WEAPON_INFO_BYTES || source.byteLength < QVM_WEAPON_INFO_BYTES) {
    throw new BinaryError("QVM weaponinfo_t", 0, `record requires ${QVM_WEAPON_INFO_BYTES} bytes`);
  }
  new Uint8Array(view.buffer, view.byteOffset, QVM_WEAPON_INFO_BYTES).set(source.subarray(0, QVM_WEAPON_INFO_BYTES));
}
