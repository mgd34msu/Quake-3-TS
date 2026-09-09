// Authored byte cases for id Software pc_token_t and PC_ReadTokenHandle.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { BotScriptSources } from "../src/botlib/script-sources.ts";
import { BinaryError } from "../src/core/binary.ts";
import { ScriptLanguageError, ScriptLexer } from "../src/script/lexer.ts";
import type { ScriptToken, ScriptTokenRecord } from "../src/script/lexer.ts";
import { ScriptGlobalDefines } from "../src/script/preprocessor.ts";
import { SOURCE_TOKEN_BYTES, SourceTokenMemory } from "../src/script/token-memory.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { QVM_SCRIPT_TOKEN_BYTES, writeQvmScriptToken } from "../src/vm/script-record.ts";
import { qvmScriptSyscall } from "../src/vm/script-syscalls.ts";

function lex(text: string): ScriptToken {
  const token = new ScriptLexer(text, "authored.script").next();
  if (token === undefined) throw new Error("Expected authored token");
  return token;
}

function destination(size = 1040) {
  const bytes = new Uint8Array(size + 14).fill(0xa5);
  return { bytes, view: new DataView(bytes.buffer, 7, size) };
}

function numeric(text: string): ScriptTokenRecord {
  const token = lex(text);
  if (token.kind !== "number") throw new Error("Expected authored numeric token");
  return { token, subtype: token.flags, integerValue: token.integerValue, floatValue: token.floatValue };
}

async function sourceFixture(text: string, print: (severity: 2 | 3, text: string) => undefined) {
  const root = await mkdtemp(join(tmpdir(), "quake3-retained-pc-token-"));
  const handles = new SourceFileHandles();
  await mkdir(join(root, "baseq3"));
  await writeFile(join(root, "baseq3", "fixture.pc"), text);
  const vfs = await VirtualFileSystem.openTracked({ dataPath: root, homePath: root, cdPath: null,
    product: "baseq3", handles, references: { checksumFeed: 0, random: () => 0 } });
  const sources = new BotScriptSources(vfs, new ScriptGlobalDefines(), print, (_text: string): undefined => undefined);
  return { sources, async close() {
    try { sources.disposeResources(); handles.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  } };
}

function readWords(trap: number, handle: number, pointer: number): DataView {
  const words = new DataView(new ArrayBuffer(12));
  words.setInt32(0, trap, true);
  words.setInt32(4, handle, true);
  words.setInt32(8, pointer, true);
  return words;
}

describe("QVM pc_token_t", () => {
  test("failed lexer reads publish their defined partial string and source fields", () => {
    const bytes = new Uint8Array(SOURCE_TOKEN_BYTES);
    const output = new SourceTokenMemory(() => bytes);
    const lexer = new ScriptLexer('"partial', "partial.c");
    expect(() => lexer.nextInto(output)).toThrow(ScriptLanguageError);
    const { view } = destination();
    writeQvmScriptToken(view, output);
    expect(view.getInt32(0, true)).toBe(1);
    expect(view.getInt32(4, true)).toBe(0);
    expect(view.getInt32(8, true)).toBe(0);
    expect(view.getFloat32(12, true)).toBe(0);
    expect([...new Uint8Array(view.buffer, view.byteOffset + 16, 11)])
      .toEqual([112, 97, 114, 116, 105, 97, 108, 0, 0, 165, 165]);
  });

  test("all VM roles publish retained false-return tokens and preserve invalid-handle output", async () => {
    const profiles: readonly { readonly role: "game" | "cgame" | "ui"; readonly trap: number }[] = [
      { role: "game", trap: 580 }, { role: "cgame", trap: 67 }, { role: "ui", trap: 60 },
    ];
    const cases = [
      { text: '#include "missing.h"', type: 5, subtype: 51, string: "#" },
      { text: "#unknown", type: 5, subtype: 51, string: "#" },
      { text: "$unknown", type: 5, subtype: 52, string: "$" },
      { text: '"unterminated', type: 1, subtype: 0, string: "unterminated" },
    ];
    for (const item of cases) {
      const diagnostics: string[] = [];
      const fixture = await sourceFixture(item.text, (_severity, message) => { diagnostics.push(message); return undefined; });
      try {
        for (const { role, trap } of profiles) {
          const memory = new QvmMemory(new Uint8Array(4096));
          const handle = fixture.sources.loadSourceHandle("fixture.pc");
          memory.span(1024, QVM_SCRIPT_TOKEN_BYTES).fill(0xa5);
          expect(qvmScriptSyscall(role, readWords(trap, 0, 0), memory, fixture.sources)).toBe(0);
          expect(memory.span(1024, QVM_SCRIPT_TOKEN_BYTES).every(byte => byte === 0xa5)).toBe(true);
          expect(qvmScriptSyscall(role, readWords(trap, handle, 1024), memory, fixture.sources)).toBe(0);
          const view = memory.view(1024, QVM_SCRIPT_TOKEN_BYTES);
          expect(view.getInt32(0, true)).toBe(item.type);
          expect(view.getInt32(4, true)).toBe(item.subtype);
          expect(view.getInt32(8, true)).toBe(0);
          expect(view.getFloat32(12, true)).toBe(0);
          expect(memory.readString(1040)).toBe(item.string);
          expect(view.getUint8(1039)).toBe(0xa5);
          fixture.sources.freeSourceHandle(handle);
        }
        expect(diagnostics.length).toBeGreaterThan(0);
      } finally { await fixture.close(); }
    }
  });

  test("VM report callback exceptions retain identity and do not reach output publication", async () => {
    const failure = new ScriptLanguageError({ severity: "error", message: "callback abort",
      location: { path: "callback", line: 1, column: 1 } }, []);
    const fixture = await sourceFixture("#unknown", () => { throw failure; });
    try {
      const handle = fixture.sources.loadSourceHandle("fixture.pc");
      const memory = new QvmMemory(new Uint8Array(4096));
      memory.span(1024, QVM_SCRIPT_TOKEN_BYTES).fill(0xa5);
      let caught: unknown;
      try { qvmScriptSyscall("game", readWords(580, handle, 1024), memory, fixture.sources); }
      catch (error) { caught = error; }
      expect(caught).toBe(failure);
      expect(memory.span(1024, QVM_SCRIPT_TOKEN_BYTES).every(byte => byte === 0xa5)).toBe(true);
    } finally { await fixture.close(); }
  });

  test("VM calls reject source-uninitialized evaluation and stringizing fields before publication", async () => {
    for (const text of ["#eval 7", "$evalint(-5)", "#define TEXT(x) #x\nTEXT(word)"]) {
      const fixture = await sourceFixture(text, () => undefined);
      try {
        const handle = fixture.sources.loadSourceHandle("fixture.pc");
        const memory = new QvmMemory(new Uint8Array(4096));
        memory.span(1024, QVM_SCRIPT_TOKEN_BYTES).fill(0xa5);
        expect(() => qvmScriptSyscall("game", readWords(580, handle, 1024), memory, fixture.sources))
          .toThrow("source token profile is unsupported");
        expect(memory.span(1024, QVM_SCRIPT_TOKEN_BYTES).every(byte => byte === 0xa5)).toBe(true);
      } finally { await fixture.close(); }
    }
  });

  test("1040-byte layout, signed low word, binary32 and exterior preservation", () => {
    const { view, bytes } = destination(1044);
    expect(QVM_SCRIPT_TOKEN_BYTES).toBe(1040);
    writeQvmScriptToken(view, numeric("4294967295UL"));
    expect(Array.from(bytes.subarray(7, 23))).toEqual([
      3, 0, 0, 0, 8, 112, 0, 0, 255, 255, 255, 255, 0, 0, 128, 79,
    ]);
    expect(Array.from(bytes.subarray(23, 34))).toEqual([52, 50, 57, 52, 57, 54, 55, 50, 57, 53, 0]);
    expect(view.getUint8(27)).toBe(0xa5);
    expect(bytes.subarray(0, 7).every(byte => byte === 0xa5)).toBe(true);
    expect(bytes.subarray(7 + 1040).every(byte => byte === 0xa5)).toBe(true);
  });

  test("source numeric bases, suffix subtype flags and f32 conversion", () => {
    const cases: readonly (readonly [string, number, number, number])[] = [
      ["0x2aUL", 0x7100, 42, 42], ["0755", 0x1200, 493, 493],
      ["0b101", 0x1400, 5, 5], ["09", 0x1008, 9, 9],
      [".1", 0x0808, 0, 0.10000000149011612], ["16777217", 0x1008, 16777217, 16777216],
      ["4294967297", 0x1008, 1, 1],
    ];
    for (const [text, subtype, integer, float] of cases) {
      const { view } = destination();
      writeQvmScriptToken(view, numeric(text));
      expect(view.getInt32(4, true)).toBe(subtype);
      expect(view.getInt32(8, true)).toBe(integer);
      expect(view.getFloat32(12, true)).toBe(float);
    }
  });

  test("string quote removal retains source subtype and copied NUL tail", () => {
    const { view, bytes } = destination();
    writeQvmScriptToken(view, { token: lex('"abc"'), subtype: 5, integerValue: 19, floatValue: -2.5 });
    expect(view.getInt32(0, true)).toBe(1);
    expect(view.getInt32(4, true)).toBe(5);
    expect(view.getInt32(8, true)).toBe(19);
    expect(view.getFloat32(12, true)).toBe(-2.5);
    expect(Array.from(bytes.subarray(23, 31))).toEqual([97, 98, 99, 0, 0, 0, 165, 165]);
    writeQvmScriptToken(view, { token: lex('""'), subtype: 2, integerValue: 0, floatValue: -0 });
    expect(Array.from(bytes.subarray(23, 30))).toEqual([0, 0, 0, 0, 0, 0, 165]);
    expect(view.getUint32(12, true)).toBe(0x80000000);
  });

  test("literal, name and punctuation retain raw numeric and subtype fields", () => {
    const cases: readonly (readonly [string, number, number, readonly number[]])[] = [
      ["'z'", 2, 3, [39, 122, 39, 0, 165]],
      ["merged_name", 4, 6, [109, 101, 114, 103, 101, 100, 95, 110, 97, 109, 101, 0, 165]],
      [">>=", 5, 1, [62, 62, 61, 0, 165]],
    ];
    for (const [text, type, subtype, expected] of cases) {
      const { view, bytes } = destination();
      writeQvmScriptToken(view, { token: lex(text), subtype, integerValue: -17, floatValue: 1.25 });
      expect(view.getInt32(0, true)).toBe(type);
      expect(view.getInt32(4, true)).toBe(subtype);
      expect(view.getInt32(8, true)).toBe(-17);
      expect(view.getFloat32(12, true)).toBe(1.25);
      expect(Array.from(bytes.subarray(23, 23 + expected.length))).toEqual([...expected]);
    }
  });

  test("byte characters, embedded NUL and maximum strcpy length", () => {
    const { view, bytes } = destination();
    const token = lex("name");
    writeQvmScriptToken(view, { token: { ...token, text: "\xff\0\u0100" },
      subtype: 3, integerValue: 0, floatValue: 0 });
    expect(Array.from(bytes.subarray(23, 27))).toEqual([255, 0, 165, 165]);
    writeQvmScriptToken(view, { token: { ...token, text: "x".repeat(1023) },
      subtype: 1023, integerValue: 0, floatValue: 0 });
    expect(view.getUint8(1038)).toBe(120);
    expect(view.getUint8(1039)).toBe(0);
    expect(bytes.subarray(1047).every(byte => byte === 0xa5)).toBe(true);
    writeQvmScriptToken(view, { token: lex('"a\\0b"'), subtype: 5, integerValue: 0, floatValue: 0 });
    expect(Array.from(bytes.subarray(23, 27))).toEqual([97, 0, 0, 120]);
  });

  test("short output and unsupported inputs fail before mutation", () => {
    const short = destination(1039);
    expect(() => writeQvmScriptToken(short.view, numeric("1"))).toThrow(BinaryError);
    expect(short.bytes.every(byte => byte === 0xa5)).toBe(true);
    const base = numeric("1");
    const invalid: readonly ScriptTokenRecord[] = [
      { ...base, token: { ...base.token, text: "x".repeat(1024) } },
      { ...base, token: { ...base.token, text: "\u0100" } },
      { ...base, subtype: 2147483648 }, { ...base, subtype: 0.5 },
      { ...base, integerValue: Number.MAX_SAFE_INTEGER + 1 }, { ...base, integerValue: 1.5 },
      { ...base, token: { ...lex('"x"'), text: "" } },
      { ...base, token: { ...lex('"x"'), text: '"\0' } },
    ];
    for (const value of invalid) {
      const { view, bytes } = destination();
      expect(() => writeQvmScriptToken(view, value)).toThrow(RangeError);
      expect(bytes.every(byte => byte === 0xa5)).toBe(true);
    }
  });
});
