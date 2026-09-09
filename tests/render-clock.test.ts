import { expect, test } from "bun:test";
import { parseRenderClockTrace } from "../tools/render-clock.ts";

test("render traces preserve independent, repeated and backward clock samples", () => {
  const clocks = [{ time: 1.995, cinematicTime: 1000 }, { time: 1.995, cinematicTime: 1034 },
    { time: 1.995, cinematicTime: 0 }, { time: 0, cinematicTime: 0 }];
  expect(parseRenderClockTrace(JSON.stringify(clocks))).toEqual(clocks);
  expect(parseRenderClockTrace('[{"time":0,"cinematicTime":0}]')).toEqual([{ time: 0, cinematicTime: 0 }]);
});

test("render traces reject malformed or unsafe external samples", () => {
  for (const text of ["null", "{}", "[]", "[null]", "[1]", "[[]]", '[{"time":0}]',
    '[{"time":"0","cinematicTime":0}]', '[{"time":0,"cinematicTime":-1}]',
    '[{"time":-1,"cinematicTime":0}]', '[{"time":1e999,"cinematicTime":0}]',
    '[{"time":0,"cinematicTime":1e999}]', '[{"time":0,"cinematicTime":2147483648}]',
    '[{"time":2147484,"cinematicTime":0}]', "not JSON"]) {
    expect(() => parseRenderClockTrace(text)).toThrow();
  }
  expect(() => parseRenderClockTrace(JSON.stringify(Array.from({ length: 100001 }, () => ({ time: 0, cinematicTime: 0 }))))).toThrow("100000");
});
