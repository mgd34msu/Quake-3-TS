// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { localTime } from "../src/platform/local-time.ts";

function calendarTest(name: string, zone: string, run: () => void): void {
  test(name, async () => {
    if (process.env["QUAKE_CALENDAR_FIXTURE"] === name) { run(); return; }
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", name], {
      env: { ...process.env, TZ: zone, QUAKE_CALENDAR_FIXTURE: name },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [status, output, errors] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ status, details: status === 0 ? "" : output + errors }).toEqual({ status: 0, details: "" });
  });
}

describe("portable native calendar", () => {
  calendarTest("UTC preserves all source fields, leap days and post-2038 time", "UTC0", () => {
    expect(localTime(0)).toEqual({ second: 0, minute: 0, hour: 0, day: 1,
      month: 0, year: 70, weekday: 4, yearDay: 0, isDst: 0 });
    expect(localTime(Date.UTC(2024, 1, 29, 23, 59, 58) / 1000)).toEqual({
      second: 58, minute: 59, hour: 23, day: 29, month: 1, year: 124,
      weekday: 4, yearDay: 59, isDst: 0,
    });
    expect(localTime(2147483648)).toEqual({ second: 8, minute: 14, hour: 3,
      day: 19, month: 0, year: 138, weekday: 2, yearDay: 18, isDst: 0 });
  });

  calendarTest("host DST rules preserve spring gap and autumn repeated hour",
    process.platform === "win32" ? "EST5EDT" : "EST5EDT,M3.2.0/2,M11.1.0/2", () => {
      const spring = Date.UTC(2024, 2, 10, 7) / 1000;
      const autumn = Date.UTC(2024, 10, 3, 6) / 1000;
      expect(localTime(spring - 1)).toMatchObject({ hour: 1, minute: 59, second: 59,
        month: 2, day: 10, yearDay: 69, weekday: 0, isDst: 0 });
      expect(localTime(spring)).toMatchObject({ hour: 3, minute: 0, second: 0, isDst: 1 });
      expect(localTime(autumn - 1)).toMatchObject({ hour: 1, minute: 59, second: 59,
        month: 10, day: 3, yearDay: 307, weekday: 0, isDst: 1 });
      expect(localTime(autumn)).toMatchObject({ hour: 1, minute: 0, second: 0, isDst: 0 });
    });

  calendarTest("host fractional offset and owned records", "ABC-5:30", () => {
    const first = localTime(0);
    expect(first).toMatchObject({ hour: 5, minute: 30, isDst: 0 });
    expect(localTime(3600)).toMatchObject({ hour: 6, minute: 30, isDst: 0 });
    expect(localTime(0)).toEqual(first);
    expect(first).toMatchObject({ hour: 5, minute: 30 });
  });

  calendarTest("invalid numeric input rejects before FFI and native range limits are retained", "UTC0", () => {
    for (const value of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => localTime(value)).toThrow("integer epoch seconds");
    }
    if (process.platform === "win32") {
      expect(localTime(-1)).toBeNull();
      expect(localTime(Number.MAX_SAFE_INTEGER)).toBeNull();
      expect(localTime(-Number.MAX_SAFE_INTEGER)).toBeNull();
    } else {
      expect(localTime(-1)).toMatchObject({ year: 69, month: 11, day: 31, second: 59 });
      // glibc and Darwin's 64-bit time_t can represent the entire accepted input range.
      expect(localTime(Number.MAX_SAFE_INTEGER)).not.toBeNull();
      expect(localTime(-Number.MAX_SAFE_INTEGER)).not.toBeNull();
    }
  });

  if (process.platform === "win32") {
    calendarTest("Windows refreshes the UCRT timezone environment", "UTC0", () => {
      expect(localTime(0)).toMatchObject({ hour: 0, minute: 0 });
      process.env["TZ"] = "ABC-5:30";
      expect(localTime(0)).toMatchObject({ hour: 5, minute: 30 });
      process.env["TZ"] = "UTC0";
      expect(localTime(0)).toMatchObject({ hour: 0, minute: 0 });
    });
  }
});
