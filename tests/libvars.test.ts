import { describe, expect, test } from "bun:test";
import { BotLibVars, libVarStringValue } from "../src/botlib/libvars.ts";

function bits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

describe("LibVarStringValue unchanged-source native x64 binary32/signed-char goldens", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["", 0x00000000], ["0", 0x00000000], ["01", 0x3f800000], ["123", 0x42f60000],
    ["1.5", 0x3fc00000], [".x", 0x40e66666], [".-", 0xbe99999a], ["..", 0xbe4ccccd],
    [". ", 0xbfcccccd], [".\xff", 0xc09ccccd], [".\x80", 0xc18ccccd], [".9", 0x3f666666],
    ["0.00000001", 0x322bcc77], ["1.23456789", 0x3f9e0652], [".x1234567", 0x40e6cb88],
    ["-1", 0], ["+1", 0], [" 1", 0], ["1e3", 0], ["1..2", 0x3f51eb85],
    ["123\0.ignored", 0x42f60000], ["16777217", 0x4b800000], ["123456789", 0x4ceb79a3],
    ["1015568748", 0x4e722165],
    ["999999999999999999999999999999999999999", 0x7f800000],
  ];
  for (const [text, expected] of cases) {
    test(JSON.stringify(text), () => expect(bits(libVarStringValue(text))).toBe(expected));
  }

  test("integral 10.0 promotes the multiplication and addition together before float storage", () => {
    expect(libVarStringValue("1015568748")).toBe(1015568704);
    expect(libVarStringValue("1015568748")).not.toBe(1015568768);
  });

  test("invalid bytes return zero in source order, not after a whole-string fractional precheck", () => {
    for (const text of ["-.", "x.123456789", "1.12345678x", ".x1234567x", "1.2.3", "\xff", ".\xffx"]) {
      expect(bits(libVarStringValue(text))).toBe(0);
    }
  });

  test("first NUL ends the byte string and hides suffixes outside the source input", () => {
    expect(libVarStringValue("12\0\u2603")).toBe(12);
    expect(libVarStringValue("\0.")).toBe(0);
    expect(libVarStringValue("1.5\0.123456789")).toBe(1.5);
    expect(() => libVarStringValue("12\u2603")).toThrow("only Latin-1 bytes before NUL");
  });
});

describe("LibVarStringValue approved source-undefined input boundary (not native goldens)", () => {
  test("terminal dot has a zero numeric value without reading beyond the owned string", () => {
    for (const text of [".", "1.", "1.\0ignored", ".\0\xff", "1.2."]) {
      expect(bits(libVarStringValue(text))).toBe(0);
    }
  });

  test("relative directory variables retain their strings through creation and replacement", () => {
    const vars = new BotLibVars();
    vars.set("basedir", ".");
    expect(vars.getString("basedir")).toBe(".");
    expect(vars.getValue("basedir")).toBe(0);
    const record = vars.getOrCreate("cddir", ".\0ignored");
    expect(record.string).toBe(".");
    expect(record.value).toBe(0);
    vars.setNotModified("cddir");
    vars.set("cddir", "1.");
    expect(vars.get("cddir")).toBe(record);
    expect(record.string).toBe("1.");
    expect(record.value).toBe(0);
    expect(record.modified).toBe(true);
  });

  test("ninth fractional consumption rejects signed-int overflow, including at the end", () => {
    for (const text of [".123456789", "0.000000000", "1.123456789x", ".x12345678", ".\xff12345678"]) {
      expect(() => libVarStringValue(text)).toThrow("fractional denominator would overflow the source signed int");
    }
  });

  test("rejection publishes no partial record or mutation", () => {
    const vars = new BotLibVars();
    expect(() => vars.getOrCreate("missing", ".123456789")).toThrow(RangeError);
    expect(vars.get("missing")).toBeNull();
    expect(() => vars.set("missing", ".123456789")).toThrow(RangeError);
    expect(vars.get("missing")).toBeNull();
    const record = vars.getOrCreate("existing", "17");
    vars.setNotModified("existing");
    expect(() => vars.set("existing", ".123456789")).toThrow(RangeError);
    expect(record.string).toBe("17");
    expect(record.value).toBe(17);
    expect(record.modified).toBe(false);
  });
});

describe("BotLibVars source lifetime and caller-facing APIs", () => {
  test("noncreating getters and resets leave a missing name absent", () => {
    const vars = new BotLibVars();
    expect(vars.get("missing")).toBeNull();
    expect(vars.getString("missing")).toBe("");
    expect(vars.getValue("missing")).toBe(0);
    expect(vars.changed("missing")).toBe(false);
    vars.setNotModified("missing");
    expect(vars.get("missing")).toBeNull();
    expect(vars.getOrCreate("missing", "7").value).toBe(7);
  });

  test("creation has zero flags, modified true, original spelling and stable case-insensitive handles", () => {
    const vars = new BotLibVars();
    const first = vars.getOrCreate("Speed", "1.5");
    expect(first).toEqual({ name: "Speed", string: "1.5", value: 1.5, flags: 0, modified: true });
    expect(vars.getOrCreate("sPEED", "999")).toBe(first);
    expect(vars.get("SPEED")).toBe(first);
    expect(vars.string("speed", "3")).toBe("1.5");
    expect(vars.value("speed", "4")).toBe(1.5);
    expect(vars.string("createdString", "12")).toBe("12");
    expect(vars.value("createdValue", "13")).toBe(13);
  });

  test("an existing name returns before evaluating an unused default", () => {
    const vars = new BotLibVars();
    const record = vars.getOrCreate("existing", "42");
    vars.setNotModified("existing");
    expect(vars.getOrCreate("EXISTING", ".")).toBe(record);
    expect(vars.string("existing", ".123456789")).toBe("42");
    expect(vars.value("existing", "\u2603")).toBe(42);
    expect(record.modified).toBe(false);
  });

  test("same-value Set still marks modified and updates retained handles without resetting name or flags", () => {
    const vars = new BotLibVars();
    const record = vars.getOrCreate("Speed", "1.5");
    vars.setNotModified("SPEED");
    expect(record.modified).toBe(false);
    expect(vars.changed("speed")).toBe(false);
    vars.set("speed", "1.5");
    expect(vars.get("speed")).toBe(record);
    expect(record.modified).toBe(true);
    vars.set("SPEED", ".x");
    expect(record.name).toBe("Speed");
    expect(record.string).toBe(".x");
    expect(bits(record.value)).toBe(0x40e66666);
    expect(record.flags).toBe(0);
    vars.setNotModified("speed");
    expect(record.modified).toBe(false);
    expect(record.value).toBe(Math.fround(7.2));
    vars.set("from-set", "9");
    expect(vars.get("from-set")).toEqual({ name: "from-set", string: "9", value: 9, flags: 0, modified: true });
  });

  test("empty names and values are legal; ASCII folds but high Latin-1 bytes do not", () => {
    const vars = new BotLibVars();
    expect(vars.getOrCreate("", "").value).toBe(0);
    expect(vars.get("")?.name).toBe("");
    vars.set("", "17");
    expect(vars.value("", "99")).toBe(17);
    const high = vars.getOrCreate("\xc0a", "1");
    expect(vars.get("\xc0A")).toBe(high);
    expect(vars.get("\xe0a")).toBeNull();
    expect(vars.getOrCreate("\xe0a", "2")).not.toBe(high);
  });

  test("all methods use the visible Latin-1 C-string prefix", () => {
    const vars = new BotLibVars();
    const record = vars.getOrCreate("Name\0\u2603", "1.5\0\u2603");
    expect(record.name).toBe("Name");
    expect(record.string).toBe("1.5");
    expect(vars.get("name\0other")).toBe(record);
    expect(vars.getString("name\0other")).toBe("1.5");
    expect(vars.getValue("name\0other")).toBe(1.5);
    expect(vars.changed("name\0other")).toBe(true);
    vars.setNotModified("name\0other");
    expect(record.modified).toBe(false);
    vars.set("name\0other", ".\xff\0\u2603");
    expect(record.string).toBe(".\xff");
    expect(bits(record.value)).toBe(0xc09ccccd);
    expect(() => vars.get("\u2603")).toThrow(RangeError);
    expect(() => vars.getOrCreate("valid", "\u2603")).toThrow(RangeError);
    expect(() => vars.set("name", "\u2603")).toThrow(RangeError);
    expect(record.string).toBe(".\xff");
  });

  test("Q_stricmp compares exactly the first 99999 bytes, including the NUL boundary", () => {
    const vars = new BotLibVars();
    const prefix = "a".repeat(99999);
    const first = vars.getOrCreate(`${prefix}x`, "42");
    expect(vars.get(`${prefix.toUpperCase()}y`)).toBe(first);
    expect(vars.get(prefix)).toBe(first);
    expect(vars.get(`${prefix}\0ignored`)).toBe(first);
    expect(vars.get("a".repeat(99998))).toBeNull();
    expect(vars.get(`${"A".repeat(99998)}z`)).toBeNull();
    expect(first.name).toBe(`${prefix}x`);
  });

  test("shutdown empties the owner, recreation uses new defaults, and owners do not share records", () => {
    const left = new BotLibVars();
    const right = new BotLibVars();
    const old = left.getOrCreate("speed", "1");
    const independent = right.getOrCreate("speed", "2");
    expect(old).not.toBe(independent);
    left.clear();
    left.clear();
    expect(left.get("speed")).toBeNull();
    expect(left.changed("speed")).toBe(false);
    const replacement = left.getOrCreate("speed", "3");
    expect(replacement).not.toBe(old);
    expect(replacement.value).toBe(3);
    expect(replacement.flags).toBe(0);
    expect(replacement.modified).toBe(true);
    expect(right.get("speed")).toBe(independent);
    expect(independent.value).toBe(2);
  });
});
