import { describe, expect, test } from "bun:test";

import {
  INFO_STRING_MAX,
  TextParseError,
  Tokenizer,
  infoParse,
  infoRemove,
  infoSet,
  infoValidate,
  parseEntities,
  tokenizeCommand,
} from "../../src/core/text.ts";

describe("Tokenizer", () => {
  test("tracks source positions while skipping both Quake comment forms", () => {
    const tokenizer = new Tokenizer('alpha // ignored\n  "two words" /* across\nlines */ omega', "fixture.shader");

    expect(tokenizer.next()).toEqual({ value: "alpha", line: 1, column: 1, quoted: false });
    expect(tokenizer.next()).toEqual({ value: "two words", line: 2, column: 3, quoted: true });
    expect(tokenizer.next()).toEqual({ value: "omega", line: 3, column: 10, quoted: false });
    expect(tokenizer.next()).toBeUndefined();
  });

  test("reports a line boundary without losing the following token", () => {
    const tokenizer = new Tokenizer("key // comment\n value");

    expect(tokenizer.next(false)?.value).toBe("key");
    expect(tokenizer.next(false)).toBeUndefined();
    expect(tokenizer.next(false)).toEqual({ value: "value", line: 2, column: 2, quoted: false });
  });

  test("preserves an empty quoted token", () => {
    expect(new Tokenizer('"" tail').next()).toEqual({ value: "", line: 1, column: 1, quoted: true });
  });
});

describe("entity and command text", () => {
  test("parses entity key/value blocks and source comments", () => {
    const entities = parseEntities(`
      // worldspawn
      {
        "classname" "worldspawn"
        "message" "Arena Gate"
      }
      { "classname" "info_player_start" "angle" "90" }
    `);

    expect(entities.length).toBe(2);
    expect(Array.from(entities[0] ?? [])).toEqual([
      ["classname", "worldspawn"],
      ["message", "Arena Gate"],
    ]);
    expect(Array.from(entities[1] ?? [])).toEqual([
      ["classname", "info_player_start"],
      ["angle", "90"],
    ]);
  });

  test("rejects an entity value moved to another line", () => {
    expect(() => parseEntities('{ "classname"\n"worldspawn" }', "broken.ent")).toThrow(TextParseError);
  });

  test("matches Cmd_TokenizeString comments, quotes, and empty quoted args", () => {
    expect(tokenizeCommand('say "a;b" "" plain/* hidden */tail // ignored')).toEqual([
      "say",
      "a;b",
      "",
      "plain",
      "tail",
    ]);
  });
});

describe("Quake info strings", () => {
  test("sets at the front, replaces the first matching key, and removes empty values", () => {
    let info = infoSet("", "name", "Ranger");
    info = infoSet(info, "rate", "25000");
    expect(info).toBe("\\rate\\25000\\name\\Ranger");
    expect(Array.from(infoParse(info))).toEqual([
      ["rate", "25000"],
      ["name", "Ranger"],
    ]);
    expect(infoSet(info, "rate", "30000")).toBe("\\rate\\30000\\name\\Ranger");
    expect(infoSet(info, "rate", "")).toBe("\\name\\Ranger");
    expect(infoRemove(info, "name")).toBe("\\rate\\25000");
  });

  test("validates protocol-sensitive characters and byte limits", () => {
    expect(infoValidate("\\name\\Ranger")).toBe(true);
    expect(infoValidate('\\name\\bad"value')).toBe(false);
    expect(infoValidate("\\name\\bad;value")).toBe(false);
    expect(infoValidate("x".repeat(INFO_STRING_MAX))).toBe(false);
    expect(() => infoSet("", "bad\\key", "value")).toThrow(TypeError);
    expect(() => infoSet("", "key", "x".repeat(INFO_STRING_MAX))).toThrow(RangeError);
  });

  test("rejects a malformed key without a value", () => {
    expect(() => infoParse("\\name")).toThrow(TextParseError);
  });
});
