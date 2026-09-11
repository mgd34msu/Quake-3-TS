import { expect, test } from "bun:test";
import { FreeTypeFontLibrary } from "../src/platform/freetype.ts";
import { freeTypeLayout, freeTypeMetric } from "../src/platform/freetype-layout.ts";

test("FreeType uses LP64 on Unix targets and LLP64 on Windows x64", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const arch of ["x64", "arm64"]) {
      expect(freeTypeLayout(platform, arch, "LE")).toEqual({
        longBytes: 8, signedLong: "i64", unsignedLong: "u64",
        faceGlyph: 152, slotFormat: 144, slotOutline: 200,
      });
    }
  }
  expect(freeTypeLayout("win32", "x64", "LE")).toEqual({
    longBytes: 4, signedLong: "i32", unsignedLong: "u32",
    faceGlyph: 120, slotFormat: 96, slotOutline: 152,
  });
  for (const [platform, arch, byteOrder] of [
    ["linux", "ia32", "LE"], ["win32", "arm64", "LE"], ["darwin", "arm64", "BE"], ["freebsd", "x64", "LE"],
  ]) {
    if (platform === undefined || arch === undefined || byteOrder === undefined) throw new Error("Incomplete ABI fixture");
    expect(freeTypeLayout(platform, arch, byteOrder)).toBeNull();
  }
});

test("FreeType metrics decode signed source limits and reject truncated or overflowing native records", () => {
  for (const platform of ["linux", "win32"]) {
    const layout = freeTypeLayout(platform, "x64", "LE");
    if (layout === null) throw new Error("Expected a supported ABI");
    const view = new DataView(new ArrayBuffer(48 + 8 * layout.longBytes));
    const metrics = [640, 768, -64, 704, 832, -2147483648, 2147483647, 0];
    for (const [index, value] of metrics.entries()) {
      const offset = 48 + index * layout.longBytes;
      if (layout.longBytes === 4) view.setInt32(offset, value, true);
      else view.setBigInt64(offset, BigInt(value), true);
      expect(freeTypeMetric(view, offset, layout)).toBe(value);
    }
    expect(() => freeTypeMetric(new DataView(new ArrayBuffer(layout.longBytes - 1)), 0, layout)).toThrow(RangeError);
    if (layout.longBytes === 8) {
      for (const value of [-2147483649n, 2147483648n]) {
        view.setBigInt64(48, value, true);
        expect(() => freeTypeMetric(view, 48, layout)).toThrow("source int32");
      }
    }
  }
});

test("a missing optional FreeType override retains unavailable initialization", () => {
  const previous = process.env["QUAKE_FREETYPE_LIBRARY"];
  process.env["QUAKE_FREETYPE_LIBRARY"] = "quake3-test-absent-freetype-library";
  try {
    const printed: string[] = [];
    expect(FreeTypeFontLibrary.open(text => { printed.push(text); })).toEqual({ kind: "unavailable" });
    expect(printed).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env["QUAKE_FREETYPE_LIBRARY"];
    else process.env["QUAKE_FREETYPE_LIBRARY"] = previous;
  }
});
