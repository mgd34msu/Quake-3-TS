/*
 * Shader remap state translated from code/game/g_utils.c AddRemap and
 * BuildShaderStateConfig.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { gameFormat } from "./format.ts";

const MAX_QPATH = 64;
const MAX_SHADER_REMAPS = 128;
const ENTRY_BUFFER_BYTES = MAX_QPATH * 2 + 5;
const STATE_BUFFER_BYTES = 1024 * 4;

interface ShaderRemap {
  readonly oldName: string;
  readonly newName: string;
  readonly timeOffset: number;
}

function quakePath(value: string): string {
  const terminator = value.indexOf("\0");
  const path = terminator < 0 ? value : value.slice(0, terminator);
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) > 255) {
      throw new RangeError("shader remap paths must contain byte-valued code units");
    }
  }
  if (path.length >= MAX_QPATH) {
    throw new RangeError("shader remap paths must fit MAX_QPATH including the terminator");
  }
  return path;
}

function foldedAsciiByte(value: number): number {
  return value >= 97 && value <= 122 ? value - 32 : value;
}

function quakePathEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (foldedAsciiByte(left.charCodeAt(index)) !== foldedAsciiByte(right.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

function storedTimeOffset(value: number): number {
  const stored = Math.fround(value);
  if (!Number.isFinite(stored) || Math.abs(stored) > 2_147_483_647) {
    throw new RangeError("shader remap time is outside the source formatter's safe int-cast range");
  }
  return stored;
}

export class ShaderRemapRegistry {
  private readonly remaps: ShaderRemap[] = [];

  constructor(private readonly print: (message: string) => void) {}

  add(oldName: string, newName: string, timeOffset: number): void {
    const oldPath = quakePath(oldName);
    const newPath = quakePath(newName);
    const storedTime = storedTimeOffset(timeOffset);
    for (let index = 0; index < this.remaps.length; index++) {
      const remap = this.remaps[index];
      if (remap !== undefined && quakePathEqual(oldPath, remap.oldName)) {
        this.remaps[index] = { oldName: remap.oldName, newName: newPath, timeOffset: storedTime };
        return;
      }
    }
    if (this.remaps.length < MAX_SHADER_REMAPS) {
      this.remaps.push({ oldName: oldPath, newName: newPath, timeOffset: storedTime });
    }
  }

  buildShaderStateConfig(): string {
    let state = "";
    for (const remap of this.remaps) {
      const formatted = gameFormat(
        "%s=%s:%5.2f@",
        [remap.oldName, remap.newName, remap.timeOffset],
      );
      if (formatted.length >= ENTRY_BUFFER_BYTES) {
        this.print(gameFormat(
          "Com_sprintf: overflow of %i in %i\n",
          [formatted.length, ENTRY_BUFFER_BYTES],
        ));
      }
      const entry = formatted.slice(0, ENTRY_BUFFER_BYTES - 1);
      const writableBytes = STATE_BUFFER_BYTES - state.length - 1;
      if (writableBytes > 0) state += entry.slice(0, writableBytes);
    }
    return state;
  }
}
