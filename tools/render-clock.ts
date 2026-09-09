export interface RenderClock {
  readonly time: number;
  readonly cinematicTime: number;
}

/** Parses captured scene/client clock pairs without requiring either clock to be monotonic. */
export function parseRenderClockTrace(text: string): readonly RenderClock[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new RangeError("Render clock trace must contain 1..100000 clock pairs");
  }
  return value.map((row: unknown, index: number): RenderClock => {
    if (typeof row !== "object" || row === null || !("time" in row) || !("cinematicTime" in row)) {
      throw new Error(`Render clock trace entry ${index} requires time and cinematicTime`);
    }
    const time = row.time, cinematicTime = row.cinematicTime;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 0x7fffffff / 1000
      || typeof cinematicTime !== "number" || !Number.isFinite(cinematicTime) || cinematicTime < 0 || cinematicTime > 0x7fffffff) {
      throw new RangeError(`Render clock trace entry ${index} exceeds nonnegative scene/client clocks`);
    }
    return { time, cinematicTime };
  });
}
