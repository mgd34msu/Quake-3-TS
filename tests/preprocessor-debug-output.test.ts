import { expect, test } from "bun:test";
import { ScriptPreprocessor } from "../src/script/preprocessor.ts";

const resolver = { resolve: () => undefined };

test("DEBUG_EVAL retains the failed reduction result after the source diagnostic", () => {
  const lines: string[] = [];
  expect(() => ScriptPreprocessor.create({ path: "debug.c", text: "#eval 7 / 0" }, resolver, {
    debugEval: text => lines.push(text), report: diagnostic => lines.push(diagnostic.message),
  })).toThrow("divide by zero");
  expect(lines).toEqual([
    "operator /, value1 = 7", "value2 = 0", "divide by zero in #if/#elif\n", "result value = 7",
  ]);
});

test("DEBUG_EVAL logs macro arguments, reduction priority, and expanded hash tokens", () => {
  const lines: string[] = [];
  const parser = ScriptPreprocessor.create({ path: "debug.c", text: "#define SUM(x,y) x + y\n#eval SUM(2,3) * 4\n" }, resolver,
    { debugEval: text => lines.push(text) });
  expect(parser.all().map(token => token.text)).toEqual(["14"]);
  expect(lines).toEqual([
    "define parms 0:", "2", "define parms 1:", "3",
    "operator *, value1 = 3", "value2 = 4", "result value = 12",
    "operator +, value1 = 2", "value2 = 12", "result value = 14",
    "eval:", " 2", " +", " 3", " *", " 4", "eval result: 14",
  ]);
  parser.dispose();
});

test("DEBUG_EVAL preserves float values, unary next-value logging, and dollar labels", () => {
  const lines: string[] = [];
  const parser = ScriptPreprocessor.create({ path: "debug.c", text: "$evalfloat(!0.0 + -1.125)" }, resolver,
    { debugEval: text => lines.push(text) });
  expect(parser.all().map(token => token.text)).toEqual(["-", "0.12"]);
  expect(lines).toEqual([
    "operator !, value1 = 0.000000", "value2 = -1.125000", "result value = 1.000000",
    "operator +, value1 = 1.000000", "value2 = -1.125000", "result value = -0.125000",
    "$eval:", " !", " 0.0", " +", " -", " 1.125", "$eval result: -0.125000",
  ]);
  parser.dispose();
});

test("DEBUG_EVAL also traces conditionals and leaves the release result unchanged", () => {
  const text = "#if 0 ? 2 : 3\nselected\n#endif\n$evalint(1 + 2)";
  const lines: string[] = [];
  const debug = ScriptPreprocessor.create({ path: "debug.c", text }, resolver, { debugEval: text => lines.push(text) });
  const release = ScriptPreprocessor.create({ path: "debug.c", text }, resolver);
  expect(debug.all()).toEqual(release.all());
  expect(lines.slice(0, 6)).toEqual([
    "operator ?, value1 = 0", "value2 = 2", "result value = 0",
    "operator :, value1 = 2", "value2 = 3", "result value = 3",
  ]);
  expect(lines).toContain("eval result: 3");
  expect(lines.at(-1)).toBe("$eval result: 3");
  debug.dispose();
  release.dispose();
});
