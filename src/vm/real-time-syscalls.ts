// Com_RealTime traps from server/sv_game.c, client/cl_cgame.c and client/cl_ui.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { RealTimeClock } from "../platform/system-clock.ts";
import type { QvmMemory } from "./memory.ts";

export function qvmRealTimeSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, clock: RealTimeClock,
): number | null {
  if (words.getInt32(0, true) !== (role === "game" ? 41 : role === "cgame" ? 70 : 64)) return null;
  const pointer = memory.pointer(words.getInt32(4, true));
  if (pointer === null) return clock.realTime(null);
  const output = new DataView(pointer.buffer, pointer.byteOffset, pointer.byteLength);
  return clock.realTime((calendar) => {
    output.setInt32(0, calendar.second, true);
    output.setInt32(4, calendar.minute, true);
    output.setInt32(8, calendar.hour, true);
    output.setInt32(12, calendar.day, true);
    output.setInt32(16, calendar.month, true);
    output.setInt32(20, calendar.year, true);
    output.setInt32(24, calendar.weekday, true);
    output.setInt32(28, calendar.yearDay, true);
    output.setInt32(32, calendar.isDst, true);
  });
}
