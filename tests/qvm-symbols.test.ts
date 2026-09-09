// Authored map/QVM fixtures for qcommon/vm.c. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { QvmOpcode, parseQvm } from "../src/assets/qvm.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import type { RetainedFileBuffer } from "../src/assets/read-file-memory.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";

function image() {
  const writer = new BinaryWriter(47);
  for (const word of [0x12721444, 3, 32, 15, 47, 0, 0, 256]) writer.i32(word);
  writer.u8(QvmOpcode.OP_ENTER); writer.i32(0);
  writer.u8(QvmOpcode.OP_CONST); writer.i32(73);
  writer.u8(QvmOpcode.OP_LEAVE); writer.i32(0);
  return parseQvm(writer.finish(), "authored-symbols.qvm");
}

function fixture(text: string | null) {
  const events: string[] = [], arena = new HunkArena(8192, message => { events.push(message); });
  const memory = new ReadFileMemory(() => arena), accounting = new SourceHunkAccounting(arena);
  const interpreter = new QvmInterpreter(image(), () => { throw new Error("Unexpected syscall"); }, { kind: "source-hunk", accounting });
  const files = {
    readFileRetainedSync(path: string): RetainedFileBuffer | undefined {
      events.push(`read ${path}`);
      if (text === null) return undefined;
      return memory.read(text.length, bytes => {
        for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
      });
    },
    freeFile(buffer: RetainedFileBuffer): void { events.push(`free ${memory.loadStack}`); memory.freeFile(buffer); },
  };
  return { events, memory, accounting, interpreter, files, arena,
    load(developer = 1, name = "authored.qvm"): void {
      interpreter.loadSymbols({ name, developer, files, print: message => { events.push(`print ${memory.loadStack} ${message}`); } });
    } };
}

test("developer map loading preserves COM_Parse order, code filtering and prepared-PC relocation", () => {
  const f = fixture('1 00000001 data\n0 00000002 tail\n// comment\n0 0x0G1 "middle symbol"\n0 00000000 entry\n0 FFFFFFFF negative\n0 00000003 outside\n');
  f.load();
  expect(f.interpreter.symbols.count).toBe(5);
  expect(f.interpreter.symbols.entries).toEqual([
    { value: 10, name: "tail", profileCount: 0 }, { value: 5, name: "middle symbol", profileCount: 0 },
    { value: 0, name: "entry", profileCount: 0 }, { value: -1, name: "negative", profileCount: 0 },
    { value: 3, name: "outside", profileCount: 0 },
  ]);
  expect(f.events).toEqual(["read vm/authored.map", "print 1 5 symbols parsed from vm/authored.map\n", "free 1"]);
  expect(f.memory.loadStack).toBe(0);
  expect(f.accounting.report().trace.filter(event => event.source === "VM_LoadSymbols")
    .map(event => [event.resource, event.bytes, event.reservedBytes, event.preference])).toEqual([
    ["vm/authored.map", 20, 32, "high"], ["vm/authored.map", 29, 32, "high"],
    ["vm/authored.map", 21, 32, "high"], ["vm/authored.map", 24, 32, "high"], ["vm/authored.map", 23, 32, "high"],
  ]);
});

test("developer zero performs no read, while missing and empty maps remain distinct", () => {
  const absent = fixture(null);
  absent.load(0);
  expect(absent.events).toEqual([]);
  absent.load(-1);
  expect(absent.events).toEqual(["read vm/authored.map", "print 0 Couldn't load symbol file: vm/authored.map\n"]);
  const empty = fixture("");
  empty.load();
  expect(empty.events).toEqual(["read vm/authored.map", "print 1 0 symbols parsed from vm/authored.map\n", "free 1"]);
  expect(empty.interpreter.symbols.entries).toEqual([]);
});

test("incomplete code rows retain their parsed prefix and warn before the summary and free", () => {
  for (const tail of ["0", "0 1"]) {
    const f = fixture(`0 0 entry\n${tail}`);
    f.load();
    expect(f.interpreter.symbols.entries).toEqual([{ value: 0, name: "entry", profileCount: 0 }]);
    expect(f.events).toEqual(["read vm/authored.map", "print 1 WARNING: incomplete line at end of file\n",
      "print 1 1 symbols parsed from vm/authored.map\n", "free 1"]);
  }
  const skipped = fixture("1");
  skipped.load();
  expect(skipped.events).toEqual(["read vm/authored.map", "print 1 0 symbols parsed from vm/authored.map\n", "free 1"]);
});

test("symbol paths use the first dot and source MAX_QPATH formatting", () => {
  const f = fixture("");
  f.load(1, "sub.dir/module.qvm");
  expect(f.events[0]).toBe("read vm/sub.map");
  const long = fixture(null);
  long.load(1, "x".repeat(63));
  expect(long.events).toEqual(["print 0 Com_sprintf: overflow of 70 in 64\n", `read vm/${"x".repeat(60)}`,
    `print 0 Couldn't load symbol file: vm/${"x".repeat(60)}\n`]);
});

test("release bytecode calls never increment developer symbols and restart preserves the table", async () => {
  const f = fixture("0 0 entry\n0 1 helper\n");
  f.load();
  expect(await f.interpreter.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(73);
  expect(await f.interpreter.invoke([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(73);
  const loaded = f.interpreter.symbols.entries;
  expect(loaded.map(symbol => symbol.profileCount)).toEqual([0, 0]);
  f.interpreter.restart(image());
  expect(f.interpreter.symbols.entries).toEqual(loaded);
  const profile: string[] = [];
  f.interpreter.symbols.printProfile(text => { profile.push(text); });
  expect(profile).toEqual([
    "vmprofile: percentages are undefined with zero total instructions; DEBUG_VM is disabled.\n",
    "            0 entry\n", "            0 helper\n", "            0 total\n",
  ]);
  expect(f.interpreter.symbols.entries).toEqual(loaded);
});

test("symbol data follows the actual hunk lifetime and a missing reload preserves loaded symbols", () => {
  const f = fixture("0 0 entry\n");
  f.load();
  f.interpreter.loadSymbols({ name: "absent", developer: 1,
    files: { readFileRetainedSync: () => undefined, freeFile: () => { throw new Error("No file was read"); } },
    print: () => undefined });
  expect(f.interpreter.symbols.count).toBe(1);
  f.arena.clear({ kind: "dedicated", shutdownGameProgs: () => undefined, clearVm: () => undefined });
  expect(() => f.interpreter.symbols.entries).toThrow("no longer valid");
});

test("symbol lookups retain linked order, duplicate aliases, signed offsets and live profile cells", () => {
  const f = fixture("0 1 first\n0 2 duplicate\n0 0 backwards\n0 3 duplicate\n0 2 last\n");
  f.load();
  const symbols = f.interpreter.symbols;
  expect(symbols.valueToSymbol(-2)).toBe("first+-7");
  expect(symbols.valueToSymbol(5)).toBe("first");
  expect(symbols.valueToSymbol(9)).toBe("first+4");
  expect(symbols.valueToSymbol(10)).toBe("last");
  expect(symbols.valueToSymbol(11)).toBe("last+1");
  expect(symbols.symbolToValue("duplicate")).toBe(10);
  expect(symbols.symbolToValue("first\0ignored")).toBe(5);
  expect(symbols.symbolToValue("FIRST")).toBe(0);
  const symbol = symbols.valueToFunctionSymbol(11);
  expect(symbols.valueToFunctionSymbol(10)).toBe(symbol);
  symbol.profileCount = 7;
  expect(symbols.entries.at(-1)?.profileCount).toBe(7);
  const output: string[] = [];
  symbols.printProfile(text => { output.push(text); });
  expect(output.at(-2)).toBe("100%         7 last\n");
  expect(symbol.profileCount).toBe(0);
  f.arena.clear({ kind: "dedicated", shutdownGameProgs: () => undefined, clearVm: () => undefined });
  expect(() => symbol.profileCount).toThrow("no longer valid");
});

test("empty symbol maps share the source null profile cell and formatted offsets obey MAX_TOKEN_CHARS", () => {
  const first = fixture(null), second = fixture(null);
  expect(first.interpreter.symbols.valueToSymbol(7)).toBe("NO SYMBOLS");
  expect(first.interpreter.symbols.symbolToValue("absent")).toBe(0);
  expect(first.interpreter.symbols.valueToFunctionSymbol(0)).toBe(second.interpreter.symbols.valueToFunctionSymbol(50));
  const name = "n".repeat(1023), f = fixture(`0 0 ${name}\n`);
  f.load();
  expect(f.interpreter.symbols.valueToSymbol(0)).toBe(name);
  expect(f.interpreter.symbols.valueToSymbol(1)).toBe(name);
  expect(f.events.at(-1)).toBe("print 0 Com_sprintf: overflow of 1025 in 1024\n");
});

test("VM stack traces follow saved frames after each print and cap cycles at 32 rows", () => {
  const f = fixture("0 0 entry\n0 1 helper\n0 2 tail\n");
  f.load();
  const data = new DataView(f.interpreter.memory.buffer), output: string[] = [];
  data.setInt32(68, 96, true);
  data.setInt32(96, 5, true);
  data.setInt32(100, 128, true);
  data.setInt32(128, -1, true);
  f.interpreter.stackTrace(0, 64, text => { output.push(text); });
  expect(output).toEqual(["entry\n", "helper\n"]);
  output.length = 0;
  f.interpreter.stackTrace(0, 64, text => {
    output.push(text);
    data.setInt32(68, 128, true);
  });
  expect(output).toEqual(["entry\n"]);
  data.setInt32(68, 64, true);
  data.setInt32(64, 10, true);
  output.length = 0;
  f.interpreter.stackTrace(10, 64, text => { output.push(text); });
  expect(output).toEqual(Array.from({ length: 32 }, () => "tail\n"));
  for (const level of [0, 1, 20, 21]) {
    f.interpreter.callLevel = level;
    expect(f.interpreter.indent().length).toBe(Math.min(level, 20) * 2);
  }
});
