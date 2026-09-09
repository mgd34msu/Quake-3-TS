import { describe, expect, test } from "bun:test";

import { ScriptLanguageError, ScriptLexer } from "../src/script/lexer.ts";
import { StructureReader } from "../src/script/structure.ts";

function reader(source: string): StructureReader {
  const lexer = new ScriptLexer(source, "structure.c");
  return new StructureReader(lexer, "structure.c", lexer.diagnostics);
}

describe("botlib structure reader", () => {
  test("reads unordered and repeated fields while callers retain typed writes", () => {
    const input = reader('{ speed 4 name "first" speed - 2 name "second" }');
    let speed = 0;
    let name = "";
    input.begin();
    while (true) {
      const field = input.nextField();
      if (field === undefined) {
        break;
      }
      if (field.name === "speed") {
        speed = input.readFloat();
      } else if (field.name === "name") {
        name = input.readString();
      } else {
        throw new Error(`unexpected fixture field ${field.name}`);
      }
    }

    expect(speed).toBe(-2);
    expect(name).toBe("second");
  });

  test("preserves signed FT_INT range and rejects float tokens", () => {
    const values = reader("{ low -32768 high 32767 }");
    values.begin();
    expect(values.nextField()?.name).toBe("low");
    expect(values.readInt()).toBe(-32_768);
    expect(values.nextField()?.name).toBe("high");
    expect(values.readInt()).toBe(32_767);
    expect(values.nextField()).toBeUndefined();

    const overflow = reader("{ value 32768 }");
    overflow.begin();
    overflow.nextField();
    expect(() => overflow.readInt()).toThrow("out of range [-32768, 32767]");

    const float = reader("{ value 1.0 }");
    float.begin();
    float.nextField();
    expect(() => float.readInt()).toThrow("unexpected float");
  });

  test("stores integer and floating tokens at float32 precision", () => {
    const input = reader("{ integer - 3 decimal 1.23456789 }");
    input.begin();
    input.nextField();
    expect(input.readFloat()).toBe(-3);
    input.nextField();
    expect(input.readFloat()).toBe(Math.fround(1.23456789));
    expect(input.nextField()).toBeUndefined();
  });

  test("returns only written array values for repeated short-array overlay", () => {
    const input = reader("{ recoil { 1, 2, 3 } recoil { 4 } empty { } }");
    const stored = [0, 0, 0];
    input.begin();
    while (true) {
      const field = input.nextField();
      if (field === undefined) {
        break;
      }
      const values = input.readFloatArray(3);
      if (field.name === "recoil") {
        for (let index = 0; index < values.length; index++) {
          const value = values[index];
          if (value === undefined) {
            throw new Error("array fixture contained a missing value");
          }
          stored[index] = value;
        }
      }
    }
    expect(stored).toEqual([4, 2, 3]);
  });

  test("matches array comma failures and the source max-element exit", () => {
    const missingComma = reader("{ value { 1 2 } }");
    missingComma.begin();
    missingComma.nextField();
    expect(() => missingComma.readFloatArray(3)).toThrow("expected a comma, found 2");

    const excess = reader("{ value { 1, 2, 3, 4 } }");
    excess.begin();
    excess.nextField();
    expect(excess.readFloatArray(3)).toEqual([1, 2, 3]);
    expect(excess.nextField()?.name).toBe("4");
  });

  test("truncates fixed strings as source bytes", () => {
    const ascii = reader(`{ value "${"a".repeat(90)}" }`);
    ascii.begin();
    ascii.nextField();
    expect(ascii.readString()).toBe("a".repeat(79));

    const multibyte = reader(`{ value "${"é".repeat(40)}" }`);
    multibyte.begin();
    multibyte.nextField();
    const value = multibyte.readString();
    expect(value).toBe("é".repeat(40));
    expect(value).not.toContain("�");
  });

  test("terminates decoded C strings at NUL without losing subsequent tokens", () => {
    const input = reader('{ value "Alpha\\0Suffix" empty "\\0hidden" next "ok" }');
    input.begin();
    expect(input.nextField()?.name).toBe("value");
    expect(input.readString()).toBe("Alpha");
    expect(input.nextField()?.name).toBe("empty");
    expect(input.readString()).toBe("");
    expect(input.nextField()?.name).toBe("next");
    expect(input.readString()).toBe("ok");
    expect(input.nextField()).toBeUndefined();

    const bounded = reader('{ value "Alpha\\0Suffix" }');
    bounded.begin();
    bounded.nextField();
    expect(bounded.readString(3)).toBe("Alp");
  });

  test("reports malformed structure tokens with source locations and prior diagnostics", () => {
    const lexer = new ScriptLexer("{ value +2 }", "bad.c");
    const input = new StructureReader(lexer, "bad.c", [{
      severity: "warning",
      message: "earlier warning",
      location: { path: "bad.c", line: 1, column: 1 },
    }]);
    input.begin();
    input.nextField();
    try {
      input.readInt();
      throw new Error("malformed value unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptLanguageError);
      if (!(error instanceof ScriptLanguageError)) {
        throw error;
      }
      expect(error.diagnostic.location).toEqual({ path: "bad.c", line: 1, column: 9 });
      expect(error.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
        "earlier warning",
        "unexpected punctuation +",
      ]);
    }
  });
});
