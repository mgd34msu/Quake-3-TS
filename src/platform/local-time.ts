// Host localtime service for qcommon/common.c Com_RealTime.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { dlopen } from "bun:ffi";

export interface LocalCalendarTime {
  /** month is zero-based; year is the source tm_year offset from 1900. */
  readonly month: number; readonly day: number; readonly year: number;
  readonly hour: number; readonly minute: number;
}

export interface SourceCalendarTime extends LocalCalendarTime {
  readonly second: number;
  readonly weekday: number;
  readonly yearDay: number;
  readonly isDst: number;
}

function loadCalendar() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Host local time currently requires Linux x64 glibc");
  }
  return dlopen("libc.so.6", {
    localtime_r: { args: ["buffer", "buffer"], returns: "ptr" },
    tzset: { args: [], returns: "void" },
  });
}

let library: ReturnType<typeof loadCalendar> | undefined;

export function localTime(epochSeconds: number): SourceCalendarTime | null {
  if (!Number.isSafeInteger(epochSeconds)) throw new RangeError("Local time requires integer epoch seconds");
  const calendar = (library ??= loadCalendar()).symbols;
  // Linux x64 glibc bits/{typesizes,types/struct_tm}.h: signed 64-bit time_t;
  // tm has nine int32 fields, padding to 40, then an int64 offset and pointer.
  const seconds = new Uint8Array(8), bytes = new Uint8Array(56);
  new DataView(seconds.buffer).setBigInt64(0, BigInt(epochSeconds), true);
  // localtime refreshes TZ on each call; localtime_r alone need not do so.
  calendar.tzset();
  if (calendar.localtime_r(seconds, bytes) === null) return null;
  const time = new DataView(bytes.buffer);
  return {
    second: time.getInt32(0, true), minute: time.getInt32(4, true), hour: time.getInt32(8, true),
    day: time.getInt32(12, true), month: time.getInt32(16, true), year: time.getInt32(20, true),
    weekday: time.getInt32(24, true), yearDay: time.getInt32(28, true), isDst: time.getInt32(32, true),
  };
}
