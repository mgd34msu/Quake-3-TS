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
  if (process.platform === "win32" && process.arch === "x64") {
    // Microsoft CRT time.h: nine int32 fields; _localtime64_s returns errno_t.
    // https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/localtime-s-localtime32-s-localtime64-s
    const library = dlopen("ucrtbase.dll", {
      _localtime64_s: { args: ["buffer", "buffer"], returns: "i32" },
      _tzset: { args: [], returns: "void" },
      _putenv_s: { args: ["buffer", "buffer"], returns: "i32" },
    });
    const name = new TextEncoder().encode("TZ\0");
    return {
      size: 36,
      convert(seconds: Uint8Array, bytes: Uint8Array): boolean {
        // UCRT owns a separate environment copy. Empty values remove its TZ.
        const zone = new TextEncoder().encode(`${process.env["TZ"] ?? ""}\0`);
        if (library.symbols._putenv_s(name, zone) !== 0) return false;
        library.symbols._tzset();
        return library.symbols._localtime64_s(bytes, seconds) === 0;
      },
    };
  }
  if ((process.platform !== "linux" && process.platform !== "darwin")
    || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error(`Unsupported host calendar ABI: ${process.platform} ${process.arch}`);
  }
  // glibc bits/types/struct_tm.h and Apple Libc include/time.h: nine int32
  // fields, padding to 40, then a 64-bit long offset and a pointer (56 bytes).
  // https://github.com/apple-oss-distributions/Libc/blob/Libc-1439.141.1/include/time.h
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    localtime_r: { args: ["buffer", "buffer"], returns: "ptr" },
    tzset: { args: [], returns: "void" },
  });
  return {
    size: 56,
    convert(seconds: Uint8Array, bytes: Uint8Array): boolean {
      // localtime refreshes TZ on each call; localtime_r alone need not do so.
      library.symbols.tzset();
      return library.symbols.localtime_r(seconds, bytes) !== null;
    },
  };
}

let library: ReturnType<typeof loadCalendar> | undefined;

export function localTime(epochSeconds: number): SourceCalendarTime | null {
  if (!Number.isSafeInteger(epochSeconds)) throw new RangeError("Local time requires integer epoch seconds");
  const calendar = (library ??= loadCalendar());
  // All supported ABIs use signed 64-bit seconds and little-endian storage.
  const seconds = new Uint8Array(8), bytes = new Uint8Array(calendar.size);
  new DataView(seconds.buffer).setBigInt64(0, BigInt(epochSeconds), true);
  if (!calendar.convert(seconds, bytes)) return null;
  const time = new DataView(bytes.buffer);
  return {
    second: time.getInt32(0, true), minute: time.getInt32(4, true), hour: time.getInt32(8, true),
    day: time.getInt32(12, true), month: time.getInt32(16, true), year: time.getInt32(20, true),
    weekday: time.getInt32(24, true), yearDay: time.getInt32(28, true), isDst: time.getInt32(32, true),
  };
}
