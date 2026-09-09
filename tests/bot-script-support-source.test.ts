import { expect, test } from "bun:test";
import { ScriptLexer, LexerFlag, ScriptLanguageError, Punctuation, stripDoubleQuotes, stripSingleQuotes } from "../src/script/lexer.ts";
import { ScriptSourceReader } from "../src/script/preprocessor.ts";
import { writeQvmScriptToken, QVM_SCRIPT_TOKEN_BYTES } from "../src/vm/script-record.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import { AasDebugLines } from "../src/botlib/aas-debug.ts";
import { BotDebugPolygons } from "../src/server/bot-debug.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { SourceTokenMemory, SOURCE_TOKEN_BYTES } from "../src/script/token-memory.ts";

test("primitive mode keeps type zero and does not consume semicolon", () => {
  const lexer = new ScriptLexer("path/name+value ; 12", "primitive", { flags: LexerFlag.Primitive, memory: new BotMemory() });
  const bytes = new Uint8Array(SOURCE_TOKEN_BYTES), output = new SourceTokenMemory(() => bytes);
  expect(lexer.nextInto(output)?.token.kind).toBe("primitive");
  expect(output.string).toBe("path/name+value");
  expect(output.type).toBe(0);
  expect(output.subtype).toBe(0);
  const published = new DataView(new ArrayBuffer(QVM_SCRIPT_TOKEN_BYTES));
  writeQvmScriptToken(published, output);
  expect(published.getInt32(0, true)).toBe(0);
  expect(lexer.nextInto(output)?.token.text).toBe("");
  expect(lexer.nextInto(output)?.token.text).toBe("");
  lexer.setScriptFlags(0);
  expect(lexer.next()?.text).toBe(";");
  lexer.setScriptFlags(LexerFlag.Primitive);
  expect(lexer.next()?.kind).toBe("number");
  lexer.dispose();
});

test("custom punctuation IDs roundtrip raw tokens beyond the default enum", () => {
  const lexer = new ScriptLexer("@@ @", "custom", { memory: new BotMemory() });
  lexer.setPunctuations([{ text: "@", punctuation: 0 }, { text: "@@", punctuation: 65536 }]);
  const first = lexer.next();
  expect(first?.kind).toBe("punctuation");
  if (first?.kind !== "punctuation") throw new Error("expected punctuation");
  expect(first.punctuation).toBe(65536);
  lexer.unread(first);
  expect(lexer.next()).toEqual(first);
  expect(lexer.next()?.text).toBe("@");
  expect(lexer.punctuationFromNum(0)).toBe("@");
  expect(lexer.punctuationFromNum(Punctuation.Question)).toBe("unkown punctuation");
  lexer.dispose();
});

test("source diagnostic suppression flags preserve false reads and suppress only selected messages", () => {
  const messages: string[] = [];
  const lexer = new ScriptLexer("`", "errors", { flags: LexerFlag.NoErrors, report: issue => messages.push(issue.message) });
  const bytes = new Uint8Array(SOURCE_TOKEN_BYTES), output = new SourceTokenMemory(() => bytes);
  expect(lexer.expectAnyToken(output)).toBe(false);
  expect(messages).toEqual([]);
  expect(lexer.diagnostics).toEqual([]);
  const warnings = new ScriptLexer('"\\999"', "warnings", { flags: LexerFlag.NoWarnings, report: issue => messages.push(issue.message) });
  expect(warnings.next()?.text).toBe('"ÿ"');
  expect(messages).toEqual([]);
});

test("lexer expectation helpers preserve report callback exception identity", () => {
  const issue = { severity: "error", message: "callback", location: { path: "host", line: 9, column: 2 } } satisfies ConstructorParameters<typeof ScriptLanguageError>[0];
  const marker = new ScriptLanguageError(issue, [issue]);
  const lexer = new ScriptLexer("`", "callback", { report: () => { throw marker; } });
  let caught: unknown;
  try { lexer.expectTokenString("value"); } catch (error) { caught = error; }
  expect(caught).toBe(marker);
});

test("active PS_ReadLiteral helper preserves signed subtype and skipped trailing quote bug", () => {
  const bytes = new Uint8Array(SOURCE_TOKEN_BYTES), output = new SourceTokenMemory(() => bytes);
  const regular = new ScriptLexer("'é'", "literal", { memory: new BotMemory() });
  expect(regular.readLiteralInto(output)).toBe(true);
  expect(output.string).toBe("'é'");
  expect(output.subtype).toBe(-23);
  regular.dispose();
  const multiple = new ScriptLexer("'ab'Z", "literal");
  expect(multiple.readLiteralInto(output)).toBe(true);
  expect(output.string).toBe("'aZ");
  expect(multiple.diagnostics.at(-1)?.message).toBe("too many characters in literal, ignored");
  expect(multiple.endOfScript).toBe(true);
});

test("quote stripping uses C string termination and preserves the source empty-input boundary", () => {
  expect(stripDoubleQuotes('"hello"\0tail')).toBe("hello");
  expect(stripDoubleQuotes('""')).toBe("");
  expect(stripSingleQuotes("'x'")).toBe("x");
  expect(stripDoubleQuotes('plain"')).toBe("plain");
  expect(() => stripSingleQuotes("")).toThrow("before the source string");
});

test("PC_ReadLine keeps a crossed token on the actual pending queue and clears source whitespace fields", () => {
  const input = ScriptSourceReader.open({ path: "line", text: "one \\\n two\nthree" }, { resolve: () => undefined }, { memory: new BotMemory() });
  const bytes = new Uint8Array(SOURCE_TOKEN_BYTES), output = new SourceTokenMemory(() => bytes);
  expect(input.readLineInto(output)).toBe(true); expect(output.string).toBe("one");
  expect(input.readLineInto(output)).toBe(true); expect(output.string).toBe("two");
  expect(input.readLineInto(output)).toBe(false); expect(output.string).toBe("three");
  expect(output.whitespaceBefore).toBe(true);
  output.clearWhitespace();
  expect(output.whitespaceBefore).toBe(false); expect(output.linesCrossed).toBe(0);
  expect(input.next()?.token.text).toBe("three");
  input.dispose();
});

test("source expression reduction preserves unary ordering and independent 64-value capacity", () => {
  const expression = (text: string): number => {
    const input = ScriptSourceReader.open({ path: "eval", text: `$evalint(${text})` }, { resolve: () => undefined });
    const token = input.next();
    let sign = 1;
    let numeric = token;
    if (token?.token.text === "-") { sign = -1; numeric = input.next(); }
    if (numeric?.token.kind !== "number") throw new Error("expected expression number");
    const value = sign * numeric.integerValue;
    input.dispose();
    return value;
  };
  expect(expression(Array.from({ length: 64 }, () => "1").join("+"))).toBe(64);
  expect(expression("!~1 == -1")).toBe(1);
  expect(expression("1 ? 2 : 3")).toBe(2);
  expect(expression("0 ? 2 : 3")).toBe(3);
  expect(expression("1++2")).toBe(1);
  expect(expression("0xffffffff < 0")).toBe(1);
  expect(expression(`${"! ".repeat(64)}1`)).toBe(1);
  const badMinus = ScriptSourceReader.open({ path: "eval", text: "$evalint(-(1))" }, { resolve: () => undefined });
  expect(() => badMinus.next()).toThrow("misplaced minus sign in #if/#elif");
  const nested = ScriptSourceReader.open({ path: "eval", text: "$evalint(1 ? 2 ? 3 : 4 : 5)" }, { resolve: () => undefined });
  expect(() => nested.next()).toThrow("? after ? in #if/#elif");
  const capacity = ScriptSourceReader.open({ path: "eval", text: `$evalint(${Array.from({ length: 65 }, () => "1").join("+")})` }, { resolve: () => undefined });
  expect(() => capacity.next()).toThrow("out of value space");
  const operators = ScriptSourceReader.open({ path: "eval", text: `$evalint(${"! ".repeat(65)}1)` }, { resolve: () => undefined });
  expect(() => operators.next()).toThrow("out of operator space");
});

test("directive failures retain source wording and definitions delay the parameter limit until invocation", () => {
  const failures: readonly (readonly [string, string])[] = [
    ["#", "found # without name"], ["#\nvalue", "found # at end of line"],
    ["$", "found $ without name"], ["$\nvalue", "found $ at end of line"],
    ["#42", "unknown precompiler directive 42"], ["#define", "#define without name"],
    ["#define 1", "expected name after #define, found 1"], ["#undef", "undef without name"],
    ["#ifndef", "#ifdef without name"], ["#ifdef 1", "expected name after #ifdef, found 1"],
    ["#if", "no value after #if/#elif"], ["$evalint", "nothing to evaluate"],
    ["#error", "#error directive: "], ["#line 3", "#line directive not supported"],
    ["#include <>", "#include without file name between < >"],
  ];
  for (const [text, message] of failures) {
    const input = ScriptSourceReader.open({ path: "directive", text }, { resolve: () => undefined });
    expect(() => input.next()).toThrow(message);
    input.dispose();
  }
  const parameters = Array.from({ length: 129 }, (_, index) => `arg${index}`).join(",");
  const input = ScriptSourceReader.open({ path: "parameters", text: `#define LARGE(${parameters}) 1\nkept LARGE(` }, { resolve: () => undefined });
  expect(input.next()?.token.text).toBe("kept");
  expect(() => input.next()).toThrow("define with more than 128 parameters");
  input.dispose();
});

test("source includes have no invented 64-frame ceiling while requested diagnostic limits remain explicit", () => {
  const resolver = { resolve: (request: { readonly requestedPath: string }) => {
    const index = Number(request.requestedPath);
    return { path: request.requestedPath, text: index < 70 ? `#include "${index + 1}"` : "reached" };
  } };
  const source = { path: "0", text: '#include "1"' };
  const input = ScriptSourceReader.open(source, resolver);
  expect(input.next()?.token.text).toBe("reached");
  expect(input.next()).toBeUndefined();
  input.dispose();
  const limited = ScriptSourceReader.open(source, resolver, { maxIncludeDepth: 64 });
  expect(() => limited.next()).toThrow("include depth exceeds 64");
  limited.dispose();
});

test("unknown source escapes report an error but return NUL without consuming the following character", () => {
  const lexer = new ScriptLexer('"a\\jb" "\\999"', "escape", { flags: LexerFlag.NoStringConcatenation });
  expect(lexer.next()?.text).toBe('"a\0jb"');
  expect(lexer.diagnostics.map(diagnostic => diagnostic.message)).toEqual(["unknown escape char"]);
  expect(lexer.next()?.text).toBe('"ÿ"');
  expect(lexer.diagnostics.at(-1)?.message).toBe("too large value in escape character");
});

test("signed readers continue with the source-cleared EOF token and primitive reads do not replace the unread token", () => {
  const empty = new ScriptLexer("", "signed");
  expect(empty.readSignedInt()).toBe(0);
  expect(empty.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
    "couldn't read expected token", "expected integer value, found \n",
  ]);
  expect(empty.readSignedFloat()).toBe(0);
  const primitive = new ScriptLexer("12 fragment", "primitive", { flags: LexerFlag.Primitive });
  expect(primitive.next()?.text).toBe("12");
  expect(primitive.next()?.text).toBe("fragment");
  primitive.unreadLast();
  expect(primitive.next()?.text).toBe("12");
});

test("include recursion compares source ASCII letters without Unicode folding", () => {
  const input = ScriptSourceReader.open({ path: "É", text: '#include "é"' }, {
    resolve: request => ({ path: request.requestedPath, text: "included" }),
  });
  expect(input.next()?.token.text).toBe("included");
  expect(input.diagnostics).toEqual([]);
  input.dispose();
});

test("NumberValue accumulates every integer radix in the source unsigned-long word", () => {
  const lexer = new ScriptLexer("4294967297 0x100000001 040000000001 0b100000000000000000000000000000001 18446744073709551617", "unsigned");
  for (let index = 0; index < 5; index++) expect(lexer.next()).toMatchObject({ integerValue: 1, floatValue: 1 });
  const maximum = new ScriptLexer("4294967295.75", "unsigned");
  expect(maximum.next()).toMatchObject({ integerValue: 4294967295, floatValue: 4294967295.75 });
  const outside = new ScriptLexer("4294967296.0", "unsigned");
  expect(() => outside.next()).toThrow("source unsigned-long range");
  const divisor = new ScriptLexer(`0.${"0".repeat(32)}1`, "divisor");
  expect(divisor.next()).toMatchObject({ integerValue: 1, floatValue: 1 });
});

test("escape warnings retain the source last-digit cursor and signed overflow remains qualified", () => {
  let column = 0;
  const lexer = new ScriptLexer('"\\999"', "escape", { report: () => { column = lexer.currentLocation.column; } });
  expect(lexer.next()?.text).toBe('"ÿ"');
  expect(column).toBe(5);
  for (const text of ['"\\2147483648"', '"\\x80000000"']) {
    const invalid = new ScriptLexer(text, "escape");
    expect(() => invalid.next()).toThrow("source signed-int range");
    expect(invalid.diagnostics).toEqual([]);
  }
});

test("expression undefined signed arithmetic is qualified instead of widened or silently wrapped", () => {
  for (const text of ["2147483647 + 1", "0x80000000 / -1", "0x80000000 % -1", "-0x80000000", "1 << 31", "1 >> 32"]) {
    const input = ScriptSourceReader.open({ path: "overflow", text: `$evalint(${text})` }, { resolve: () => undefined });
    expect(() => input.next()).toThrow(RangeError);
    expect(input.diagnostics).toEqual([]);
    input.dispose();
  }
});

test("ValidClientNumber uses source globals before setup and includes its upper bound", () => {
  const messages: string[] = [];
  const unavailable = (): never => { throw new Error("unexpected host call"); };
  const debug = new AasDebugLines(new BotDebugPolygons(), unavailable);
  const library = new BotLibrary({
    assets: unavailable, random: new LinuxNativeRandom(1),
    print: (severity, text) => { messages.push(`${severity}:${text}`); }, commonPrint: unavailable,
    openLog: unavailable, openWrite: unavailable, milliseconds: () => 0,
    movementDebug: debug.movement, permanentLine: unavailable,
    *clientCommand(): ReturnType<BotLibrary["actions"]["commandCalls"]> { return undefined; },
  });
  expect(library.validClientNumber(0, "Probe")).toBe(true);
  expect(library.validClientNumber(1, "Probe")).toBe(false);
  expect(library.validClientNumber(-1, "Probe")).toBe(false);
  expect(messages).toEqual(["3:Probe: invalid client number 1, [0, 0]\n", "3:Probe: invalid client number -1, [0, 0]\n"]);
  expect(() => library.validClientNumber(0.5, "Probe")).toThrow("source signed client number");
});
