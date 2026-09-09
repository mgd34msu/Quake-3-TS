import { expect, test } from "bun:test";
import { ScriptLexer, LexerFlag, NumberFlag, ScriptTokenType, Punctuation } from "../src/script/lexer.ts";
import { ScriptSourceReader, ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { SourceTokenMemory, SOURCE_TOKEN_BYTES } from "../src/script/token-memory.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import { StructureReader, StructureFieldType as FT, findStructureField, writeFloat, writeIndent,
  writeStructure, type StructureDefinition, type StructureFieldDefinition } from "../src/script/structure.ts";

function field(name: string, offset: number, type: number,
  extra: Partial<StructureFieldDefinition> = {}): StructureFieldDefinition {
  return { name, offset, type, maxarray: 0, floatmin: 0, floatmax: 0, substruct: null, ...extra };
}

function reader(text: string): StructureReader { return new StructureReader(new ScriptLexer(text, "fixture"), "fixture"); }

test("structure integer paths interpret the source unsigned token word as signed long", () => {
  const definition: StructureDefinition = { size: 8, fields: [field("integer", 0, FT.Int), field("float", 4, FT.Float)] };
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  expect(reader("{ integer 0xffffffff float 0xffffffff }").readStructure(definition, bytes)).toBe(true);
  expect(view.getInt32(0, true)).toBe(-1);
  expect(view.getFloat32(4, true)).toBe(-1);
  expect(reader("0xffffffff").readInt()).toBe(-1);
  expect(reader("0xffffffff").readFloat()).toBe(-1);
});

test("source descriptors store signed bytes, unsigned bounded ints, literal chars and fixed strings", () => {
  const definition: StructureDefinition = { size: 96, fields: [
    field("byte", 0, FT.Char), field("literal", 1, FT.Char | FT.Unsigned),
    field("integer", 4, FT.Int | FT.Unsigned | FT.Bounded, { floatmin: 2.75, floatmax: 65535 }),
    field("float", 8, FT.Float), field("string", 12, FT.String),
  ] };
  const bytes = new Uint8Array(96).fill(0xaa), view = new DataView(bytes.buffer);
  const input = reader(`{ byte -128 literal 'é' integer 65535 float -3 string "${"é".repeat(90)}" }`);
  expect(input.readStructure(definition, bytes)).toBe(true);
  expect(view.getInt8(0)).toBe(-128);
  expect(view.getUint8(1)).toBe(233);
  expect(view.getUint32(4, true)).toBe(65535);
  expect(view.getFloat32(8, true)).toBe(-3);
  expect([...bytes.subarray(12, 91)]).toEqual(Array.from({ length: 79 }, () => 233));
  expect(bytes[91]).toBe(0);
  expect(bytes[92]).toBe(0xaa);
  expect(findStructureField(definition.fields, "BYTE")).toBeUndefined();
  expect(findStructureField(definition.fields, "byte\0tail")).toBe(definition.fields[0]);
});

test("source descriptor failures preserve earlier writes and signed punctuation rules", () => {
  const definition: StructureDefinition = { size: 8, fields: [field("first", 0, FT.Int), field("second", 4, FT.Int | FT.Unsigned)] };
  const bytes = new Uint8Array(8).fill(0xaa), view = new DataView(bytes.buffer);
  const input = reader("{ first 123 second -2 }");
  expect(input.readStructure(definition, bytes)).toBe(false);
  expect(view.getInt32(0, true)).toBe(123);
  expect(view.getUint32(4, true)).toBe(0xaaaaaaaa);
  expect(input.diagnostics.at(-1)?.message).toBe("expected unsigned value, found -");
});

test("source arrays retain tails and continue after the maximum element comma", () => {
  const definition: StructureDefinition = { size: 12, fields: [field("a", 0, FT.Float | FT.Array, { maxarray: 3 })] };
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  expect(reader("{ a { 1,2,3 } a { 4 } }").readStructure(definition, bytes)).toBe(true);
  expect([view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true)]).toEqual([4, 2, 3]);
  const excess = reader("{ a { 1,2,3,4 } }");
  expect(excess.readStructure(definition, bytes)).toBe(false);
  expect(excess.diagnostics.at(-1)?.message).toBe("unknown structure field 4");
});

test("nested read failure is ignored by its parent exactly where C ignores the return", () => {
  const nested: StructureDefinition = { size: 4, fields: [field("value", 0, FT.Int)] };
  const definition: StructureDefinition = { size: 8, fields: [field("child", 4, FT.Struct, { substruct: nested })] };
  const bytes = new Uint8Array(8);
  const input = reader("{ child { absent } }");
  expect(input.readStructure(definition, bytes)).toBe(true);
  expect(input.diagnostics.at(-1)?.message).toBe("unknown structure field absent");
});

test("writer preserves CRLF, signed storage, source nested base pointer and empty-array omission", () => {
  const nested: StructureDefinition = { size: 4, fields: [field("value", 0, FT.Int)] };
  const definition: StructureDefinition = { size: 12, fields: [
    field("byte", 8, FT.Char | FT.Unsigned), field("child", 4, FT.Struct, { substruct: nested }),
    field("empty", 0, FT.Int | FT.Array, { maxarray: 0 }),
  ] };
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  view.setInt32(0, 17, true); view.setInt32(4, 99, true); view.setUint8(8, 255);
  let text = "";
  expect(writeStructure(fragment => { text += fragment; return fragment.length; }, definition, bytes)).toBe(true);
  expect(text).toBe("{\r\n\tbyte\t-1\r\n\tchild\t\t{\r\n\t\tvalue\t17\r\n\t}\r\n\r\n\tempty\t{\r\n}\r\n");
});

test("WriteFloat rounds binary32 ties to even, strips zeros and retains negative zero", () => {
  const values = [0, -0, 0.0078125, 0.0234375, 1.25, 3.4028234663852886e38, Infinity, -Infinity];
  const written: string[] = [];
  for (const value of values) expect(writeFloat(text => { written.push(text); return text.length; }, value)).toBe(true);
  expect(written).toEqual(["0", "-0", "0.007812", "0.023438", "1.25", "340282346638528859811704183484516925440", "inf", "-inf"]);
});

test("writer stops at the exact failed fragment without reading later fields", () => {
  const definition: StructureDefinition = { size: 4, fields: [field("value", 0, FT.Int), field("bad", 99, FT.Int)] };
  const writes: string[] = [];
  expect(writeStructure(text => { writes.push(text); return writes.length === 3 ? -1 : text.length; }, definition, new Uint8Array(4))).toBe(false);
  expect(writes).toEqual(["{\r\n", "\t", "value\t"]);
  expect(writeIndent(() => { throw new Error("unreached"); }, -1)).toBe(true);
});

function tokenMemory(): SourceTokenMemory {
  const bytes = new Uint8Array(SOURCE_TOKEN_BYTES);
  return new SourceTokenMemory(() => bytes);
}

test("PS_Check rewinds only script pointer and whitespace traversal mutates actual allocation", () => {
  const input = new ScriptLexer("\nfirst second", "fixture", { memory: new BotMemory() });
  expect(input.checkTokenString("absent")).toBe(false);
  expect(input.currentLocation.line).toBe(2);
  expect(input.nextWhitespaceChar()).toBe(10);
  expect(input.nextWhitespaceChar()).toBe(0);
  expect(input.next()?.text).toBe("first");
  expect(input.currentLocation.line).toBe(3);
  expect(input.numLinesCrossed()).toBe(1);
  input.unreadLast(); input.unreadLast();
  expect(input.next()?.text).toBe("first");
  expect(input.next()?.text).toBe("second");
  input.dispose();
});

test("source lexer helpers preserve numeric subtype checks and custom longest punctuation order", () => {
  const input = new ScriptLexer("? ?? -12 1.25", "fixture", { memory: new BotMemory() });
  input.setPunctuations([{ text: "?", punctuation: Punctuation.Question }, { text: "??", punctuation: Punctuation.Colon }]);
  expect(input.punctuationFromNum(Punctuation.Colon)).toBe("??");
  expect(input.punctuationFromNum(-1)).toBe("unkown punctuation");
  expect(input.expectTokenString("?")).toBe(true);
  const output = tokenMemory();
  expect(input.checkTokenType(ScriptTokenType.Punctuation, Punctuation.Colon, output)).toBe(true);
  expect(output.string).toBe("??");
  input.setPunctuations(null);
  expect(input.readSignedInt()).toBe(-12);
  expect(input.readSignedFloat()).toBe(1.25);
  input.setScriptFlags(LexerFlag.NoErrors);
  expect(input.getScriptFlags()).toBe(1);
  expect(input.expectTokenString("missing")).toBe(false);
  expect(input.diagnostics).toEqual([]);
  input.dispose();
});

test("PS type-check mismatch retains destination and replays its source token", () => {
  const input = new ScriptLexer("name 17", "fixture", { memory: new BotMemory() });
  const output = tokenMemory(); output.writeString("untouched");
  expect(input.checkTokenType(ScriptTokenType.Number, NumberFlag.Integer, output)).toBe(false);
  expect(output.string).toBe("untouched");
  expect(input.skipUntilString("17")).toBe(true);
  expect(input.expectAnyToken(output)).toBe(false);
  expect(input.diagnostics.at(-1)?.message).toBe("couldn't read expected token");
  input.dispose();
});

test("PC helper calls read actual macro queue and preserve unmatched token allocations", () => {
  const input = ScriptSourceReader.open({ path: "fixture", text: "X 7 ; tail" }, { resolve: () => undefined }, { memory: new BotMemory() });
  expect(input.addDefine("X 42")).toBe(true);
  expect(input.checkTokenString("wrong")).toBe(false);
  const output = tokenMemory();
  expect(input.expectTokenType(ScriptTokenType.Number, NumberFlag.Decimal | NumberFlag.Integer, output)).toBe(true);
  expect(output.integerValue).toBe(42);
  expect(input.checkTokenType(ScriptTokenType.Number, NumberFlag.Integer, output)).toBe(true);
  expect(output.integerValue).toBe(7);
  expect(input.skipUntilString("tail")).toBe(true);
  expect(input.expectAnyToken(output)).toBe(false);
  expect(input.diagnostics.at(-1)?.message).toBe("couldn't read expected token");
  input.dispose();
});

test("PC_RemoveGlobalDefine preserves the source dangling link and rejects its later traversal", () => {
  const globals = new ScriptGlobalDefines(undefined, new BotMemory());
  expect(globals.add("A 1")).toBe(true);
  expect(globals.remove("missing")).toBe(false);
  expect(globals.remove("A")).toBe(true);
  expect(() => globals.snapshot()).toThrow("does not identify a live definition");
});

test("PC_PrintDefineHashTable writes every reached source fragment and SetPunctuations does not affect current lexer", () => {
  const input = ScriptSourceReader.open({ path: "fixture", text: ";" }, { resolve: () => undefined }, { memory: new BotMemory() });
  input.addDefine("A 1");
  const writes: string[] = [];
  input.printDefineHashTable(text => writes.push(text));
  expect(writes.length).toBe(2049);
  expect(writes[0]).toBe("   0:");
  expect(writes.filter(text => text === " A")).toHaveLength(1);
  input.setPunctuations([{ text: "@", punctuation: Punctuation.Question }]);
  expect(input.next()?.token.text).toBe(";");
  input.dispose();
});
