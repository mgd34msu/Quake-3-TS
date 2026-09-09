// Ported from id Software's code/game/g_mem.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "../core/common-error.ts";

export const GAME_MEMORY_BYTES = 256 * 1024;

/** A source pointer into the game pool; string reads can reach retained allocation tails. */
export class GameMemoryAllocation {
  constructor(readonly bytes: Uint8Array) {}

  readString(): string {
    const remaining = new Uint8Array(this.bytes.buffer, this.bytes.byteOffset);
    const end = remaining.indexOf(0);
    if (end < 0) throw new RangeError("Game string reads beyond the source memory pool");
    let text = "";
    for (let index = 0; index < end; index++) {
      const byte = remaining[index];
      if (byte === undefined) throw new RangeError("Game string byte is outside its source memory pool");
      text += String.fromCharCode(byte);
    }
    return text;
  }

  writeString(value: string): void {
    if (value.length + 1 > this.bytes.length) throw new RangeError("Game string exceeds its source allocation");
    for (let index = 0; index < value.length; index++) {
      const byte = value.charCodeAt(index);
      if (byte === 0 || byte > 255) throw new RangeError("Game strings require non-NUL source bytes");
      this.bytes[index] = byte;
    }
    this.bytes[value.length] = 0;
  }
}

/** Module-owned static storage. G_InitMemory rewinds it without clearing former bytes. */
export class GameMemory {
  private readonly pool = new Uint8Array(GAME_MEMORY_BYTES);
  private allocPoint = 0;

  constructor(private readonly debugInteger: () => number, private readonly print: (text: string) => void) {}

  get allocatedBytes(): number { return this.allocPoint; }

  allocate(size: number): GameMemoryAllocation {
    if (!Number.isInteger(size) || size < 0 || size > 0x7fffffff) throw new RangeError("G_Alloc requires a nonnegative source int size");
    const aligned = (size + 31) & ~31;
    if (this.debugInteger() !== 0) this.print(`G_Alloc of ${size} bytes (${(GAME_MEMORY_BYTES - this.allocPoint - aligned) | 0} left)\n`);
    if (this.allocPoint + size > GAME_MEMORY_BYTES) throw new CommonError("drop", `G_Alloc: failed on allocation of ${size} bytes\n`);
    const allocation = new GameMemoryAllocation(this.pool.subarray(this.allocPoint, this.allocPoint + size));
    this.allocPoint = (this.allocPoint + aligned) | 0;
    return allocation;
  }

  initialize(): void { this.allocPoint = 0; }

  status(): void { this.print(`Game memory status: ${this.allocPoint} out of ${GAME_MEMORY_BYTES} bytes allocated\n`); }
}
