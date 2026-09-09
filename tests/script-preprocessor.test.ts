import { describe, expect, test } from "bun:test";
import { posix } from "node:path";

import { VirtualFileSystem } from "../src/assets/vfs.ts";
import {
  ScriptPreprocessor,
  type IncludeRequest,
  type IncludeResolver,
  type ScriptSource,
} from "../src/script/preprocessor.ts";
import { NumberFlag, ScriptLanguageError, type ScriptToken } from "../src/script/lexer.ts";

class MemoryResolver implements IncludeResolver {
  readonly requests: IncludeRequest[] = [];
  private readonly sources: ReadonlyMap<string, string>;

  constructor(sources: ReadonlyMap<string, string>) {
    this.sources = sources;
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    this.requests.push(request);
    const text = this.sources.get(request.requestedPath);
    return text === undefined ? undefined : { path: `resolved/${request.requestedPath}`, text };
  }
}

class VfsIncludeResolver implements IncludeResolver {
  private readonly vfs: VirtualFileSystem;

  constructor(vfs: VirtualFileSystem) {
    this.vfs = vfs;
  }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    const candidates = [
      posix.join(posix.dirname(request.fromPath), request.requestedPath),
      request.requestedPath,
      posix.join("botfiles", request.requestedPath),
      posix.join("ui", request.requestedPath),
    ];
    const visited = new Set<string>();
    for (const candidate of candidates) {
      if (visited.has(candidate)) {
        continue;
      }
      visited.add(candidate);
      if (this.vfs.has(candidate)) {
        return { path: candidate, text: new TextDecoder().decode(this.vfs.readSync(candidate)) };
      }
    }
    return undefined;
  }
}

const emptyResolver: IncludeResolver = {
  resolve(): undefined {
    return undefined;
  },
};

function texts(tokens: readonly ScriptToken[]): readonly string[] {
  return tokens.map((token) => token.text);
}

describe("botlib script preprocessor", () => {
  test("evalfloat formats exact binary64 ties with source fixed decimals", () => {
    for (const { expression, expected } of [
      { expression: "9.0 / 8.0", expected: ["1.12"] },
      { expression: "11.0 / 8.0", expected: ["1.38"] },
      { expression: "-9.0 / 8.0", expected: ["-", "1.12"] },
      { expression: "-11.0 / 8.0", expected: ["-", "1.38"] },
      { expression: "-0.0", expected: ["0.00"] },
      { expression: "1.005", expected: ["1.00"] },
    ]) {
      for (const text of [`#evalfloat (${expression})`, `$evalfloat(${expression})`]) {
        const preprocessor = ScriptPreprocessor.create({ path: "rounding.c", text }, emptyResolver);
        expect(texts(preprocessor.all())).toEqual(expected);
      }
    }
  });

  test("hash evalfloat keeps fixed notation and source nonfinite spellings", () => {
    const factor = " * 1073741824.0";
    const seed = "(3.0 / 2.0 - 1.0)";
    const large = ScriptPreprocessor.create({ path: "large.c", text: `#evalfloat ${seed}${factor.repeat(3)}` }, emptyResolver);
    expect(texts(large.all())).toEqual(["618970019642690137449562112.00"]);
    const infinity = `${seed}${factor.repeat(35)}`;
    for (const { expression, expected } of [{ expression: infinity, expected: "inf" }, { expression: `${infinity} * 0.0`, expected: "nan" }]) {
      const preprocessor = ScriptPreprocessor.create({ path: "nonfinite.c", text: `#evalfloat ${expression}` }, emptyResolver);
      expect(texts(preprocessor.all())).toEqual([expected]);
    }
  });

  test("expands object and function macros, stringizes arguments, pastes tokens, and rescans", async () => {
    const source = [
      "#define VALUE 3",
      "#define TWICE(x) ((x) + (x))",
      "#define TEXT(x) #x",
      "#define JOIN(a,b) a ## b",
      "TWICE(VALUE) TEXT(alpha beta) JOIN(menu,Def)",
    ].join("\n");
    const preprocessor = await ScriptPreprocessor.create({ path: "macro.c", text: source }, emptyResolver);

    expect(texts(preprocessor.all())).toEqual([
      "(", "(", "3", ")", "+", "(", "3", ")", ")", '"alphabeta"', "menuDef",
    ]);
    expect(preprocessor.diagnostics).toEqual([]);
  });

  test("preserves early nested-argument termination, empty parameters, chained calls, and continued definitions", async () => {
    const source = [
      "#define FIRST(a,b) a",
      "#define EMPTY() vacant",
      "#define TARGET(x) x",
      "#define CALL TARGET",
      "#define CONTINUED(a, \\",
      "b) a ## b",
      "FIRST((one,two), three) EMPTY() CALL(7) CONTINUED(menu,Def)",
    ].join("\n");
    const preprocessor = await ScriptPreprocessor.create({ path: "nested.c", text: source }, emptyResolver);

    expect(texts(preprocessor.all())).toEqual([
      "one", ",", "two", ",", "three", ")", "vacant", "(", ")", "7", "menuDef",
    ]);
    expect(preprocessor.diagnostics.map(diagnostic => diagnostic.message)).toEqual(["too few define parms"]);
  });

  test("evaluates conditionals and both source evaluation directive forms", async () => {
    const source = [
      "#define A 2",
      "#if defined(A) && (A << 2) == 8",
      "selected",
      "#elif 1",
      "second_selected",
      "#else",
      "wrong_else",
      "#endif",
      "#eval (1 + 2 * 3)",
      "#evalfloat (5.0 / 2.0)",
      "$evalint((4 + 1) * 2)",
      "$evalfloat(3.0 / 2.0)",
    ].join("\n");
    const preprocessor = await ScriptPreprocessor.create({ path: "eval.c", text: source }, emptyResolver);
    const output = preprocessor.all();

    expect(texts(output)).toEqual(["selected", "second_selected", "7", "2.50", "10", "1.50"]);
    expect(output[2]).toMatchObject({
      kind: "number",
      flags: NumberFlag.Decimal | NumberFlag.Integer | NumberFlag.Long,
      integerValue: 7,
    });
    expect(output[3]).toMatchObject({
      kind: "number",
      flags: NumberFlag.Decimal | NumberFlag.Float | NumberFlag.Long,
      floatValue: 2.5,
    });
  });

  test("allows each source #elif condition to independently select a branch", async () => {
    const source = [
      "#if 1",
      "first",
      "#elif 1",
      "second",
      "#else",
      "not_selected",
      "#endif",
      "#eval 1 + 2 << 2",
      "#eval (0 ? 4 : 9)",
      "#eval -5",
      "#evalfloat (1.5 * 2.0)",
    ].join("\n");
    const preprocessor = await ScriptPreprocessor.create({ path: "branches.c", text: source }, emptyResolver);

    expect(texts(preprocessor.all())).toEqual(["first", "second", "12", "9", "-", "5", "3.00"]);
  });

  test("still evaluates nested conditions and rejects unknown directives while a parent is skipped", async () => {
    expect(() => ScriptPreprocessor.create(
      { path: "inactive-if.c", text: "#if 0\n#if UNKNOWN_NAME +\n#endif\n#endif" },
      emptyResolver,
    )).toThrow("can't evaluate UNKNOWN_NAME, not defined");

    expect(() => ScriptPreprocessor.create(
      { path: "inactive-unknown.c", text: "#if 0\n#not_a_directive value\n#endif" },
      emptyResolver,
    )).toThrow("unknown precompiler directive not_a_directive");
  });

  test("rejects non-source expression operators instead of applying a default", async () => {
    expect(() => ScriptPreprocessor.create(
      { path: "operator.c", text: "#if 1 = 1\nwrong\n#endif" },
      emptyResolver,
    )).toThrow("invalid operator = in #if/#elif");
  });

  test("resolves quoted and system includes to resolver-owned canonical paths", async () => {
    const resolver = new MemoryResolver(new Map([
      ["local.inc", "#define LOCAL inside"],
      ["system.inc", "LOCAL system"],
    ]));
    const root = {
      path: "root/main.c",
      text: '#include "local.inc"\n#include <system.inc>\nLOCAL',
    };
    const preprocessor = await ScriptPreprocessor.create(root, resolver);

    expect(texts(preprocessor.all())).toEqual(["inside", "system", "inside"]);
    expect(resolver.requests).toEqual([
      { kind: "quoted", fromPath: "root/main.c", requestedPath: "local.inc" },
      { kind: "system", fromPath: "root/main.c", requestedPath: "system.inc" },
    ]);
  });

  test("provides deterministic builtins and per-instance define state", async () => {
    const fixedTime = new Date(2026, 8, 5, 14, 3, 9);
    const one = await ScriptPreprocessor.create(
      { path: "one.c", text: "__FILE__ __LINE__ __DATE__ __TIME__ EXTERNAL" },
      emptyResolver,
      { installBuiltins: true, initialDefines: ["EXTERNAL 9"], now: () => fixedTime },
    );
    const two = await ScriptPreprocessor.create({ path: "two.c", text: "EXTERNAL" }, emptyResolver);

    expect(texts(one.all())).toEqual(["one.c", "1", '"Sep  5 2026"', '"14:03:09"', "9"]);
    expect(texts(two.all())).toEqual(["EXTERNAL"]);
  });

  test("preserves source macro line behavior and warns when a fixed define is not removed", async () => {
    const preprocessor = await ScriptPreprocessor.create(
      { path: "lines.c", text: "#define DEFINITION_LINE __LINE__\n#undef __LINE__\nDEFINITION_LINE __LINE__" },
      emptyResolver,
      { installBuiltins: true },
    );

    expect(texts(preprocessor.all())).toEqual(["1", "3"]);
    expect(preprocessor.diagnostics).toEqual([{
      severity: "warning",
      message: "can't undef __LINE__",
      location: { path: "lines.c", line: 2, column: 16 },
    }]);
  });

  test("keeps warnings observable and makes unsupported or unbounded work explicit", async () => {
    const warningSource = "#pragma once\n#define LOOP LOOP\nLOOP";
    const warned = await ScriptPreprocessor.create({ path: "warning.c", text: warningSource }, emptyResolver);
    expect(texts(warned.all())).toEqual([]);
    expect(warned.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["warning", "error"]);

    expect(() => ScriptPreprocessor.create(
      { path: "line.c", text: "#line 20\nvalue" },
      emptyResolver,
    )).toThrow(ScriptLanguageError);

    expect(() => ScriptPreprocessor.create(
      { path: "cycle.c", text: "#define A B\n#define B A\nA" },
      emptyResolver,
      { maxMacroExpansions: 8 },
    )).toThrow("macro expansion count exceeds 8");
  });

  test("checks include, expansion queue, and output capacity boundaries", async () => {
    const recursive = new MemoryResolver(new Map([["again.c", '#include "again.c"']]));
    const recursiveSource = ScriptPreprocessor.create(
      { path: "again.c", text: '#include "again.c"' },
      recursive,
    );
    expect(recursiveSource.all()).toEqual([]);
    expect(recursiveSource.diagnostics.map(diagnostic => diagnostic.message)).toEqual(["resolved/again.c recursively included"]);

    expect(() => ScriptPreprocessor.create(
      { path: "queue.c", text: "#define MANY(a) a a a a\nMANY(x)" },
      emptyResolver,
      { maxQueuedTokens: 3 },
    )).toThrow("macro expansion queue exceeds 3 tokens");

    expect(() => ScriptPreprocessor.create(
      { path: "output.c", text: "one two three" },
      emptyResolver,
      { maxOutputTokens: 2 },
    )).toThrow("preprocessor output exceeds 2 tokens");
  });

  test("supports one-token unread and reset over the immutable output", async () => {
    const preprocessor = await ScriptPreprocessor.create({ path: "read.c", text: "one two" }, emptyResolver);
    const first = preprocessor.next();
    if (first === undefined) {
      throw new Error("fixture did not produce its first token");
    }
    preprocessor.unread(first);

    expect(preprocessor.next()).toBe(first);
    expect(preprocessor.next()?.text).toBe("two");
    preprocessor.reset();
    expect(preprocessor.next()?.text).toBe("one");
  });

  test("preprocesses retail bot character and Team Arena menu sources through the VFS", async () => {
    const retailRoot = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
    const vfs = await VirtualFileSystem.openInspection({ dataPath: retailRoot, homePath: retailRoot, cdPath: null, product: "missionpack" });
    const resolver = new VfsIncludeResolver(vfs);

    const botPath = "botfiles/bots/anarki_c.c";
    const bot = await ScriptPreprocessor.create(
      { path: botPath, text: new TextDecoder().decode(await vfs.read(botPath)) },
      resolver,
    );
    expect(bot.all().length).toBeGreaterThan(100);
    expect(texts(bot.all())).toContain('"Anarki"');
    expect(texts(bot.all())).not.toContain("CHARACTERISTIC_NAME");

    const weaponsPath = "botfiles/weapons.c";
    const weapons = await ScriptPreprocessor.create(
      { path: weaponsPath, text: new TextDecoder().decode(await vfs.read(weaponsPath)) },
      resolver,
    );
    expect(weapons.all().length).toBeGreaterThan(200);
    expect(texts(weapons.all())).not.toContain("evalfloat");

    const menuPath = "ui/main.menu";
    const menu = await ScriptPreprocessor.create(
      { path: menuPath, text: new TextDecoder().decode(await vfs.read(menuPath)) },
      resolver,
    );
    expect(menu.all().length).toBeGreaterThan(1_000);
    expect(texts(menu.all())).toContain("menuDef");
    expect(texts(menu.all())).not.toContain("WINDOW_VISIBLE");
  });
});
