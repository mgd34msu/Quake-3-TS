// CM_LumpChecksum and CM_Checksum from id Software's code/qcommon/cm_load.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { blockChecksum } from "../core/md4.ts";

export interface CollisionChecksumLump { readonly offset: number; readonly length: number }

export function collisionLumpChecksum(bytes: Uint8Array, lump: CollisionChecksumLump): number {
  const { offset, length } = lump;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) {
    throw new RangeError("CM_LumpChecksum: lump outside source allocation");
  }
  return blockChecksum(bytes.subarray(offset, offset + length));
}

/** Compiled source helper; CM_LoadMap separately checksums the entire file. */
export function collisionChecksum(bytes: Uint8Array, lumps: readonly CollisionChecksumLump[]): number {
  const checksums = new Uint8Array(11 * 4), data = new DataView(checksums.buffer);
  const indexes = [1, 4, 6, 5, 2, 9, 8, 7, 3, 13, 10];
  for (const [index, lumpIndex] of indexes.entries()) {
    const lump = lumps[lumpIndex];
    if (lump === undefined) throw new RangeError(`CM_Checksum: missing header lump ${lumpIndex}`);
    data.setUint32(index * 4, collisionLumpChecksum(bytes, lump), true);
  }
  return blockChecksum(checksums);
}
