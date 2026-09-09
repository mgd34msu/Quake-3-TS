// Port of id Software's unix_shared.c Sys_Milliseconds and common.c Com_RealTime.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { localTime } from "./local-time.ts";
import type { LocalCalendarTime, SourceCalendarTime } from "./local-time.ts";
export type { LocalCalendarTime, SourceCalendarTime } from "./local-time.ts";

export interface SystemClock { milliseconds(): number }
export interface LocalCalendar { localCalendar(): LocalCalendarTime }
export interface RealTimeClock {
  realTime(write: ((calendar: SourceCalendarTime) => undefined) | null): number;
}

/** The base second is sampled lazily, independently of event/network initialization. */
export class UnixSystemClock implements SystemClock, LocalCalendar, RealTimeClock {
  private baseSecond: number | null = null;
  constructor(private readonly wallTime: () => number = Date.now) {}

  private epochSeconds(): number {
    const time = this.wallTime();
    if (!Number.isSafeInteger(time)) throw new RangeError("Calendar wall clock requires integer epoch milliseconds");
    return Math.floor(time / 1000);
  }

  localCalendar(): SourceCalendarTime {
    const calendar = localTime(this.epochSeconds());
    if (calendar === null) throw new Error("Host local time conversion failed");
    return calendar;
  }

  realTime(write: ((calendar: SourceCalendarTime) => undefined) | null): number {
    const seconds = this.epochSeconds();
    if (write !== null) {
      const calendar = localTime(seconds);
      if (calendar !== null) write(calendar);
    }
    return seconds | 0;
  }

  milliseconds(): number {
    const now = this.wallTime();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Dedicated wall clock requires nonnegative integer epoch milliseconds");
    if (this.baseSecond === null) this.baseSecond = Math.floor(now / 1000) * 1000;
    return (now - this.baseSecond) | 0;
  }
}
