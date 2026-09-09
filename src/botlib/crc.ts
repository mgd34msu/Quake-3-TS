/*
 * CRC operations translated from id Software's botlib/l_crc.c and l_crc.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// The source declares 257 entries; its final, unlisted entry is zero-initialized.
const CRC_TABLE = Uint16Array.from({ length: 257 }, (_, index) => {
  if (index === 256) return 0;
  let value = index << 8;
  for (let bit = 0; bit < 8; bit++) {
    value = ((value << 1) ^ ((value & 0x8000) === 0 ? 0 : 0x1021)) & 0xffff;
  }
  return value;
});

function tableValue(index: number): number {
  const value = CRC_TABLE[index];
  if (value === undefined) {
    throw new RangeError("CRC table index outside source allocation, undefined signed-char continuation");
  }
  return value;
}

function checkedLength(bytes: Uint8Array, length: number): number {
  if (!Number.isInteger(length) || length < -0x80000000 || length > 0x7fffffff) {
    throw new RangeError("CRC length must be a signed 32-bit integer");
  }
  if (length > bytes.length) throw new RangeError("CRC length exceeds input allocation");
  return length;
}

export function CRC_Init(): number {
  return 0xffff;
}

export function CRC_ProcessByte(crc: number, data: number): number {
  const value = crc & 0xffff;
  return ((value << 8) ^ tableValue((value >>> 8) ^ (data & 0xff))) & 0xffff;
}

export function CRC_Value(crc: number): number {
  return crc & 0xffff;
}

/** Unsigned byte continuation used to checksum separately serialized AAS records. */
export function crc16(bytes: Uint8Array, initial = CRC_Init()): number {
  let crc = initial & 0xffff;
  for (const byte of bytes) crc = CRC_ProcessByte(crc, byte);
  return CRC_Value(crc);
}

/** Processes exactly length bytes, including embedded NULs. Negative lengths process none. */
export function CRC_ProcessString(bytes: Uint8Array, length = bytes.length): number {
  const count = checkedLength(bytes, length);
  let crc = CRC_Init();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
    let tableIndex = (crc >>> 8) ^ data.getUint8(index);
    if (tableIndex < 0 || tableIndex > 256) tableIndex = 0;
    crc = ((crc << 8) ^ tableValue(tableIndex)) & 0xffff;
  }
  return CRC_Value(crc);
}

/** Source char is signed on the target. Negative table indexes have no defined C result. */
export function CRC_ContinueProcessString(crc: number, bytes: Uint8Array, length = bytes.length): number {
  const count = checkedLength(bytes, length);
  let value = crc & 0xffff;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
    value = ((value << 8) ^ tableValue((value >>> 8) ^ data.getInt8(index))) & 0xffff;
  }
  return value;
}
