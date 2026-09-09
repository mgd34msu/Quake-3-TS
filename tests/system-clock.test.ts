// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { DedicatedEventSource } from "../src/platform/dedicated-input.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { localTime } from "../src/platform/local-time.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Unix system clock independent of platform lifetime", () => {
  test("calendar projection samples the actual wall source without setting the elapsed-time base", () => {
    let now = Date.UTC(2026, 0, 2, 3, 4, 59, 999), samples = 0;
    const clock = new UnixSystemClock(() => { samples++; return now; });
    expect(samples).toBe(0);
    const first = clock.localCalendar(), expectedFirst = localTime(Math.floor(now / 1000));
    if (expectedFirst === null) throw new Error("Initial calendar fixture could not be converted");
    expect(first).toEqual(expectedFirst);
    now += 2001;
    expect(clock.milliseconds()).toBe(0);
    const second = clock.localCalendar(), expectedSecond = localTime(Math.floor(now / 1000));
    if (expectedSecond === null) throw new Error("Advanced calendar fixture could not be converted");
    expect(second).toEqual(expectedSecond);
    expect(samples).toBe(3);
    now = NaN; expect(() => clock.localCalendar()).toThrow("integer epoch");
  });

  test("real time samples once, narrows returned seconds and leaves the elapsed base lazy", () => {
    let now = 2147483648999, samples = 0;
    const clock = new UnixSystemClock(() => { samples++; return now; });
    expect(clock.realTime(null)).toBe(-2147483648);
    expect(samples).toBe(1);
    now = -1;
    expect(clock.realTime(null)).toBe(-1);
    now = 1055;
    let writes = 0;
    expect(clock.realTime((calendar) => {
      writes++;
      expect(calendar.second).toBe(1);
      expect(samples).toBe(3);
      now = 9099;
    })).toBe(1);
    expect(writes).toBe(1);
    expect(clock.milliseconds()).toBe(99);
    for (const invalid of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      now = invalid;
      expect(() => clock.realTime(null)).toThrow("integer epoch");
    }
  });

  test("host conversion returns owned records across the safe-integer seconds range", () => {
    const first = localTime(0);
    if (first === null) throw new Error("Epoch calendar fixture could not be converted");
    const saved = { ...first };
    localTime(1709251200);
    expect(first).toEqual(saved);
    expect(localTime(Number.MAX_SAFE_INTEGER)).not.toBeNull();
    expect(localTime(-Number.MAX_SAFE_INTEGER)).not.toBeNull();
    expect(new UnixSystemClock(() => Number.MAX_SAFE_INTEGER).realTime(null)).toBe(Math.floor(Number.MAX_SAFE_INTEGER / 1000) | 0);
    for (const invalid of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => localTime(invalid)).toThrow("integer epoch seconds");
    }
  });

  test("default calendar rules and pre-transition types use isolated authored timezone files", () => {
    for (const fixture of ["missing", "malformed", "one-type", "no-transitions", "pre-transition", "empty-table-footer", "rebasing", "leaps",
      "cached-zone", "missing-zone", "malformed-zone",
      "explicit-month", "explicit-julian", "explicit-day"]) {
      const directory = mkdtempSync(join(tmpdir(), "quake-calendar-default-"));
      try {
        if (fixture !== "missing" && fixture !== "missing-zone" && !fixture.startsWith("explicit-")) {
          const oneType = fixture === "one-type" || fixture === "leaps" || fixture === "cached-zone";
          const transition = fixture === "pre-transition" || fixture === "rebasing";
          const types = oneType ? 1 : 2, leaps = fixture === "leaps" ? 1 : 0;
          const bytes = new Uint8Array(44 + (transition ? 5 : 0) + types * 6 + 8 + leaps * 8);
          const view = new DataView(bytes.buffer);
          view.setUint32(0, 0x545a6966); view.setUint32(28, leaps);
          view.setUint32(32, transition ? 1 : 0); view.setUint32(36, types); view.setUint32(40, 8);
          if (transition) view.setInt32(44, 10000);
          const first = transition ? 49 : 44;
          view.setInt32(first, fixture === "cached-zone" ? 900 : 7200); bytes[first + 4] = 1;
          if (!oneType) { view.setInt32(first + 6, -3600); bytes[first + 11] = 4; }
          bytes.set([68, 83, 84, 0, 83, 84, 68, 0], first + types * 6);
          if (fixture === "rebasing") bytes.set([45, 48, 48, 0], first + types * 6 + 4);
          if (fixture === "leaps") {
            view.setInt32(first, 0); bytes[first + 4] = 0;
            bytes.set([85, 84, 67, 0], first + types * 6);
            const leap = first + types * 6 + 8;
            view.setInt32(leap, 78796800); view.setInt32(leap + 4, 1);
          }
          if (fixture === "empty-table-footer") {
            bytes[4] = 50;
            const footer = new TextEncoder().encode("\nAAA5BBB3,M3.2.0,M11.1.0\n");
            const extended = new Uint8Array(bytes.length * 2 + footer.length);
            extended.set(bytes); extended.set(bytes, bytes.length); extended.set(footer, bytes.length * 2);
            writeFileSync(join(directory, "posixrules"), extended);
          } else {
            writeFileSync(join(directory, "posixrules"), fixture === "malformed" || fixture === "malformed-zone" ? bytes.subarray(0, 43) : bytes);
          }
        }
        let timezone = "AAA5BBB3";
        if (fixture === "pre-transition" || fixture === "empty-table-footer" || fixture === "leaps" || fixture.endsWith("-zone")) {
          timezone = join(directory, "posixrules");
        }
        if (fixture === "explicit-month") timezone = "AAA0BBB,M1.1.0/-167,M1.2.0/0";
        if (fixture === "explicit-julian") timezone = "AAA0BBB,J1/-1,J2/0";
        if (fixture === "explicit-day") timezone = "AAA0BBB,0/-1,1/0";
        const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "--test-name-pattern", "isolated default-rule fixture"], {
          env: { ...process.env, TZDIR: directory, TZ: timezone,
            QUAKE_DEFAULT_CALENDAR_FIXTURE: fixture },
          stdout: "pipe", stderr: "pipe",
        });
        expect({ fixture, status: child.exitCode, error: child.exitCode === 0 ? "" : new TextDecoder().decode(child.stderr) })
          .toEqual({ fixture, status: 0, error: "" });
      } finally { rmSync(directory, { recursive: true }); }
    }
  });

  test.skipIf(process.env["QUAKE_DEFAULT_CALENDAR_FIXTURE"] === undefined)("isolated default-rule fixture", () => {
    const fixture = process.env["QUAKE_DEFAULT_CALENDAR_FIXTURE"];
    if (fixture === "missing" || fixture === "malformed" || fixture === "one-type") {
      expect(localTime(-15854400)).toMatchObject({ year: 69, month: 6, day: 1, hour: 7, isDst: 0 });
      // M3.2.0 at 02:00 standard time; M11.1.0 at 02:00 daylight time.
      const spring = Date.UTC(2024, 2, 10, 7) / 1000, autumn = Date.UTC(2024, 10, 3, 5) / 1000;
      expect(localTime(spring - 1)).toMatchObject({ hour: 1, minute: 59, second: 59, isDst: 0 });
      expect(localTime(spring)).toMatchObject({ hour: 4, minute: 0, second: 0, isDst: 1 });
      expect(localTime(autumn - 1)).toMatchObject({ hour: 1, minute: 59, second: 59, isDst: 1 });
      expect(localTime(autumn)).toMatchObject({ hour: 0, minute: 0, second: 0, isDst: 0 });
    } else if (fixture === "no-transitions") {
      expect(localTime(Date.UTC(2024, 6, 1, 12) / 1000)).toMatchObject({ hour: 7, isDst: 0 });
    } else if (fixture === "pre-transition") {
      expect(localTime(0)).toEqual({ second: 0, minute: 0, hour: 23, day: 31, month: 11,
        year: 69, weekday: 3, yearDay: 364, isDst: 0 });
      expect(localTime(9999)).toMatchObject({ hour: 1, minute: 46, second: 39, isDst: 0 });
      expect(localTime(10000)).toMatchObject({ hour: 4, minute: 46, second: 40, isDst: 1 });
    } else if (fixture === "empty-table-footer") {
      expect(localTime(Date.UTC(2024, 6, 1, 12) / 1000)).toMatchObject({ hour: 11, isDst: 0 });
    } else if (fixture === "missing-zone" || fixture === "malformed-zone") {
      expect(localTime(0)).toEqual({ second: 0, minute: 0, hour: 0, day: 1, month: 0,
        year: 70, weekday: 4, yearDay: 0, isDst: 0 });
    } else if (fixture === "cached-zone") {
      const clock = new UnixSystemClock(() => Date.UTC(2024, 1, 29, 23, 59, 58, 999));
      const expected = { second: 58, minute: 14, hour: 0, day: 1, month: 2,
        year: 124, weekday: 5, yearDay: 60, isDst: 1 };
      expect(clock.localCalendar()).toEqual(expected);
      const filename = process.env["TZ"];
      if (filename === undefined) throw new Error("Cached timezone fixture requires its authored TZ path");
      writeFileSync(filename, new Uint8Array([0]));
      expect(clock.localCalendar()).toEqual(expected);
    } else if (fixture === "rebasing") {
      expect(localTime(0)).toEqual({ second: 0, minute: 0, hour: 21, day: 31, month: 11,
        year: 69, weekday: 3, yearDay: 364, isDst: 1 });
    } else if (fixture === "explicit-month") {
      // 1969's first Sunday is January 5. libc adds that day to epoch zero,
      // then subtracts 167 hours, reaching December 29, 1969 at 01:00 UTC.
      expect(localTime(-255601)).toMatchObject({ year: 69, month: 11, day: 29, hour: 0, minute: 59, second: 59, isDst: 0 });
      expect(localTime(-255600)).toMatchObject({ year: 69, month: 11, day: 29, hour: 2, minute: 0, second: 0, isDst: 1 });
    } else if (fixture === "explicit-julian" || fixture === "explicit-day") {
      expect(localTime(-3601)).toMatchObject({ year: 69, month: 11, day: 31, hour: 22, minute: 59, second: 59, isDst: 0 });
      expect(localTime(-3600)).toMatchObject({ year: 70, month: 0, day: 1, hour: 0, minute: 0, second: 0, isDst: 1 });
    } else {
      expect(fixture).toBe("leaps");
      expect(localTime(78796799)).toEqual({ second: 59, minute: 59, hour: 23, day: 30, month: 5,
        year: 72, weekday: 5, yearDay: 181, isDst: 0 });
      const leap = { second: 60, minute: 59, hour: 23, day: 30, month: 5,
        year: 72, weekday: 5, yearDay: 181, isDst: 0 };
      expect(localTime(78796800)).toEqual(leap);
      expect(new UnixSystemClock(() => 78796800999).realTime(calendar => { expect(calendar).toEqual(leap); })).toBe(78796800);
      expect(localTime(78796801)).toEqual({ second: 0, minute: 0, hour: 0, day: 1, month: 6,
        year: 72, weekday: 6, yearDay: 182, isDst: 0 });
    }
  });

  test("UTC, zoneinfo and POSIX calendars use isolated native timezone environments", () => {
    for (const timezone of ["UTC", "America/New_York", "<+0545>-5:45", ":", "", "quake-calendar-invalid-zone",
      "EST5EDT,M3.2.0,M11.1.0", "AAA0BBB,J60/0,J61/0", "AAA0BBB,59/0,60/0",
      "AAA0BBB,M3.2.0/2,M3.2.0/3", "AAA0BBB,J1/0,J365/25", "AAA0BBB"]) {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "--test-name-pattern", "isolated calendar fixture"], {
        env: { ...process.env, TZDIR: "/usr/share/zoneinfo", TZ: timezone,
          QUAKE_CALENDAR_FIXTURE: timezone === "" ? "empty" : "1" },
        stdout: "pipe", stderr: "pipe",
      });
      expect({ timezone, status: child.exitCode, error: child.exitCode === 0 ? "" : new TextDecoder().decode(child.stderr) })
        .toEqual({ timezone, status: 0, error: "" });
    }
  });

  test.skipIf(process.env["QUAKE_CALENDAR_FIXTURE"] !== "1" && process.env["QUAKE_CALENDAR_FIXTURE"] !== "empty")("isolated calendar fixture", () => {
    const timezone = process.env["QUAKE_CALENDAR_FIXTURE"] === "empty" ? "" : process.env["TZ"];
    if (timezone === "UTC" || timezone === ":" || timezone === "" || timezone === "quake-calendar-invalid-zone") {
      const clock = new UnixSystemClock(() => Date.UTC(2024, 1, 29, 23, 59, 58, 999));
      const expected = { second: 58, minute: 59, hour: 23, day: 29, month: 1, year: 124, weekday: 4, yearDay: 59, isDst: 0 };
      expect(clock.localCalendar()).toEqual(expected);
      expect(clock.realTime((calendar) => { expect(calendar).toEqual(expected); })).toBe(1709251198);
      if (timezone === "UTC") {
        // Every 400 Gregorian years contain 146097 days, preserving weekday.
        const epoch = { second: 0, minute: 0, hour: 0, day: 1, month: 0, year: 70, weekday: 4, yearDay: 0, isDst: 0 };
        const cycleSeconds = 146097 * 86400;
        expect(localTime(400000 * cycleSeconds)).toEqual({ ...epoch, year: 160000070 });
        expect(localTime(-400000 * cycleSeconds)).toEqual({ ...epoch, year: -159999930 });
        const beyondDate = new UnixSystemClock(() => 713 * cycleSeconds * 1000);
        expect(beyondDate.localCalendar()).toEqual({ ...epoch, year: 285270 });
        expect(beyondDate.realTime(calendar => { expect(calendar).toEqual({ ...epoch, year: 285270 }); }))
          .toBe((713 * cycleSeconds) | 0);
      }
    } else if (timezone === "<+0545>-5:45") {
      const clock = new UnixSystemClock(() => Date.UTC(2024, 1, 29, 23, 59, 58, 999));
      expect(clock.localCalendar()).toEqual({ second: 58, minute: 44, hour: 5, day: 1, month: 2,
        year: 124, weekday: 5, yearDay: 60, isDst: 0 });
    } else if (timezone === "America/New_York" || timezone === "EST5EDT,M3.2.0,M11.1.0") {
      let now = Date.UTC(2024, 2, 10, 6, 59, 59, 999);
      const clock = new UnixSystemClock(() => now);
      expect(clock.localCalendar()).toEqual({ second: 59, minute: 59, hour: 1, day: 10, month: 2,
        year: 124, weekday: 0, yearDay: 69, isDst: 0 });
      now++;
      expect(clock.localCalendar()).toEqual({ second: 0, minute: 0, hour: 3, day: 10, month: 2,
        year: 124, weekday: 0, yearDay: 69, isDst: 1 });
      now = Date.UTC(2050, 2, 13, 6, 59, 59);
      expect(clock.localCalendar()).toEqual({ second: 59, minute: 59, hour: 1, day: 13, month: 2,
        year: 150, weekday: 0, yearDay: 71, isDst: 0 });
      now += 1000;
      expect(clock.localCalendar()).toEqual({ second: 0, minute: 0, hour: 3, day: 13, month: 2,
        year: 150, weekday: 0, yearDay: 71, isDst: 1 });
    } else if (timezone === "AAA0BBB,J60/0,J61/0") {
      let now = Date.UTC(2024, 1, 29, 23, 59, 59);
      const clock = new UnixSystemClock(() => now);
      expect(clock.localCalendar()).toMatchObject({ hour: 23, day: 29, isDst: 0 });
      now += 1000;
      expect(clock.localCalendar()).toMatchObject({ hour: 1, day: 1, isDst: 1 });
    } else if (timezone === "AAA0BBB,59/0,60/0") {
      const clock = new UnixSystemClock(() => Date.UTC(2024, 1, 29));
      expect(clock.localCalendar()).toMatchObject({ hour: 1, day: 29, isDst: 1 });
    } else if (timezone === "AAA0BBB,M3.2.0/2,M3.2.0/3") {
      const clock = new UnixSystemClock(() => Date.UTC(2024, 6, 1));
      expect(clock.localCalendar()).toMatchObject({ hour: 0, isDst: 0 });
    } else if (timezone === "AAA0BBB,J1/0,J365/25") {
      let now = Date.UTC(2024, 6, 1);
      const clock = new UnixSystemClock(() => now);
      expect(clock.localCalendar()).toMatchObject({ hour: 1, isDst: 1 });
      now = Date.UTC(2025, 0, 1);
      expect(clock.localCalendar()).toMatchObject({ hour: 1, isDst: 1 });
    } else {
      expect(timezone).toBe("AAA0BBB");
      const clock = new UnixSystemClock(() => Date.UTC(2025, 0, 1));
      expect(clock.localCalendar()).toMatchObject({ hour: 0, isDst: 0 });
      expect(localTime(Date.UTC(2024, 6, 1) / 1000)).toMatchObject({ hour: 1, isDst: 1 });
    }
  });
  test("construction does not sample; independent clocks retain lazy base, backward time and signed wrap", () => {
    let now = 1720000000789, samples = 0;
    const first = new UnixSystemClock(() => { samples++; return now; });
    const second = new UnixSystemClock(() => now);
    expect(samples).toBe(0);
    expect(first.milliseconds()).toBe(789);
    now += 2001; expect(first.milliseconds()).toBe(2790); expect(second.milliseconds()).toBe(790);
    now -= 2500; expect(first.milliseconds()).toBe(290); expect(second.milliseconds()).toBe(-1710);
    now = 1720000000000 + 2147483647; expect(first.milliseconds()).toBe(2147483647);
    now++; expect(first.milliseconds()).toBe(-2147483648);
    for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      now = invalid; expect(() => first.milliseconds()).toThrow("wall clock");
    }
  });

  test("early error clock and later event timestamps borrow the same base without earlier input polling", () => {
    let now = 1055, samples = 0;
    const clock = new UnixSystemClock(() => { samples++; return now; });
    expect(clock.milliseconds()).toBe(55);
    now = 2099;
    const input = new UnixIo(() => undefined, clock, { signals: "none" });
    const events = new DedicatedEventSource(input);
    expect(samples).toBe(1);
    try {
      input.queueEvent({ kind: "console", time: 0, text: "echo shared" });
      expect(events.getEvent()).toEqual({ kind: "console", time: 1099, text: "echo shared" });
      now++;
      expect(events.getEvent()).toEqual({ kind: "none", time: 1100 });
      input.close();
      expect(() => events.getEvent()).toThrow("closed");
      expect(samples).toBe(3);
      expect(clock.milliseconds()).toBe(1100);
    } finally { input.close(); }
  });
});
