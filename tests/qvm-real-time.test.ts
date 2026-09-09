// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { qvmRealTimeSyscall } from "../src/vm/real-time-syscalls.ts";

function argumentsView(...words: number[]): DataView {
  const view = new DataView(new ArrayBuffer(words.length * 4));
  for (const [index, word] of words.entries()) view.setInt32(index * 4, word, true);
  return view;
}

test("real-time role gates, null destination and truncated argument ordering", () => {
  let samples = 0;
  const clock = new UnixSystemClock(() => { samples++; return 2147483648999; });
  const memory = new QvmMemory(new Uint8Array(64).fill(0xa5));
  expect(qvmRealTimeSyscall("game", argumentsView(43), memory, clock)).toBeNull();
  expect(qvmRealTimeSyscall("cgame", argumentsView(41), memory, clock)).toBeNull();
  expect(qvmRealTimeSyscall("ui", argumentsView(70), memory, clock)).toBeNull();
  expect(() => qvmRealTimeSyscall("game", argumentsView(41), memory, clock)).toThrow(RangeError);
  expect(samples).toBe(0);
  expect(qvmRealTimeSyscall("game", argumentsView(41, 0), memory, clock)).toBe(-2147483648);
  expect(qvmRealTimeSyscall("cgame", argumentsView(70, 0), memory, clock)).toBe(-2147483648);
  expect(qvmRealTimeSyscall("ui", argumentsView(64, 0), memory, clock)).toBe(-2147483648);
  expect(samples).toBe(3);
  expect(memory.bytes).toEqual(new Uint8Array(64).fill(0xa5));
});

test("real-time writes all nine fields through masked borrowed QVM pointers", () => {
  const clock = new UnixSystemClock(() => Date.UTC(2024, 1, 29, 23, 59, 58, 999));
  const calendar = clock.localCalendar();
  const expected = [calendar.second, calendar.minute, calendar.hour, calendar.day, calendar.month, calendar.year,
    calendar.weekday, calendar.yearDay, calendar.isDst];
  const backing = new Uint8Array(96).fill(0xa5), memory = new QvmMemory(backing.subarray(16, 80));
  expect(qvmRealTimeSyscall("game", argumentsView(41, 64), memory, clock)).toBe(1709251198);
  expect(Array.from({ length: 9 }, (_, index) => memory.view(64, 36).getInt32(index * 4, true))).toEqual(expected);
  expect(qvmRealTimeSyscall("cgame", argumentsView(70, -64), memory, clock)).toBe(1709251198);
  expect(qvmRealTimeSyscall("ui", argumentsView(64, 64), memory, clock)).toBe(1709251198);
  expect(backing.subarray(0, 16)).toEqual(new Uint8Array(16).fill(0xa5));
  expect(backing.subarray(52)).toEqual(new Uint8Array(44).fill(0xa5));
});

test("time sampling precedes reached stores and tail failure retains complete field prefixes", () => {
  const memory = new QvmMemory(new Uint8Array(64).fill(0xa5));
  let samples = 0;
  const clock = new UnixSystemClock(() => { samples++; memory.bytes[0] = samples; return 58000; });
  const expected = clock.localCalendar();
  expect(() => qvmRealTimeSyscall("ui", argumentsView(64, -7), memory, clock)).toThrow(RangeError);
  expect(samples).toBe(2);
  expect(memory.bytes[0]).toBe(2);
  expect(memory.view(-7, 4).getInt32(0, true)).toBe(expected.second);
  expect(memory.bytes.subarray(61)).toEqual(new Uint8Array(3).fill(0xa5));
});
