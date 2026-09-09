// CopyString / Z_Free from id Software's code/qcommon/common.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonError } from "./common-error.ts";
import { sourceCommandText } from "./text.ts";
import { ZoneTag } from "./zone.ts";
import type { ZoneAllocation, ZoneArena } from "./zone.ts";

export interface ZoneString {
  readonly value: string;
}

class AllocatedZoneString implements ZoneString {
  constructor(private readonly allocation: ZoneAllocation) {}

  get value(): string {
    const bytes = this.allocation.bytes;
    let text = "";
    for (const byte of bytes) {
      if (byte === 0) return text;
      text += String.fromCharCode(byte);
    }
    throw new CommonError("fatal", "CopyString: unterminated allocated string");
  }
}

/** The source's empty and single-digit strings are static, outside either zone. */
export class SourceZoneStrings {
  private readonly allocations = new WeakMap<ZoneString, ZoneAllocation | null>();
  private readonly statics = new Map<string, ZoneString>();

  constructor(readonly zone: ZoneArena) {
    for (const text of ["", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      const value: ZoneString = Object.freeze({ value: text });
      this.statics.set(text, value);
      this.allocations.set(value, null);
    }
  }

  copy(value: string): ZoneString {
    const text = sourceCommandText(value);
    const shared = this.statics.get(text);
    if (shared !== undefined) return shared;
    const allocation = this.zone.allocate(text.length + 1, ZoneTag.Small, false);
    const bytes = allocation.bytes;
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    bytes[text.length] = 0;
    const result = new AllocatedZoneString(allocation);
    this.allocations.set(result, allocation);
    return result;
  }

  free(value: ZoneString | null): void {
    if (value === null) { this.zone.free(null); return; }
    const allocation = this.allocations.get(value);
    if (allocation === undefined) throw new CommonError("fatal", "Z_Free: freed a pointer without ZONEID");
    if (allocation !== null) this.zone.free(allocation);
  }
}
