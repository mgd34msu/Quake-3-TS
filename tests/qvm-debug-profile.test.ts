// Authored QVM/map fixtures for qcommon/vm_interpreted.c DEBUG_VM and vm.c profiling.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { QvmOpcode as Op, parseQvm } from "../src/assets/qvm.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import type { QvmArguments, QvmSystemCall } from "../src/vm/interpreter.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import type { QvmExecutionProfile } from "../src/vm/registry.ts";

type Operation = readonly [Op, number?];
function image(operations: readonly Operation[], size = 512) {
  const code = new BinaryWriter(operations.length * 5);
  for (const [opcode, operand] of operations) {
    code.u8(opcode);
    if (operand !== undefined) {
      if (opcode === Op.OP_ARG) code.u8(operand);
      else code.i32(operand);
    }
  }
  const bytes = code.finish(), writer = new BinaryWriter(32 + bytes.length);
  for (const value of [0x12721444, operations.length, 32, bytes.length, 32 + bytes.length, 0, 0, size]) writer.i32(value);
  writer.bytes(bytes);
  return parseQvm(writer.finish(), "authored-debug.qvm");
}
function args(command = 0): QvmArguments { return [command, 0, 0, 0, 0, 0, 0, 0, 0, 0]; }
function fixture(operations: readonly Operation[], profile: QvmExecutionProfile,
  systemCall: QvmSystemCall = () => { throw new Error("Unexpected syscall"); }, size = 512,
) {
  const output: string[] = [], registry = new VmRegistry(text => { output.push(text); }, () => profile);
  const registration = registry.reserve("qagame");
  const vm = new QvmInterpreter(image(operations, size), systemCall, { kind: "unaccounted" }, registration);
  return { vm, registry, registration, output,
    load(text = "0 0 main\n"): void {
      const memory = new ReadFileMemory(), bytes = new TextEncoder().encode(text);
      vm.loadSymbols({ name: "qagame", developer: 1, print: () => undefined,
        files: { readFileRetainedSync: () => memory.read(bytes.length, destination => { destination.set(bytes); }),
          freeFile: buffer => { memory.freeFile(buffer); } } });
    },
    async invoke(command = 0): Promise<number> { registration.called(); return vm.invoke(args(command)); },
    profile(): string { let text = ""; registry.printProfile(chunk => { text += chunk; }); return text; },
  };
}
const nested: readonly Operation[] = [
  [Op.OP_ENTER, 16], [Op.OP_CONST, 4], [Op.OP_CALL], [Op.OP_LEAVE, 16],
  [Op.OP_ENTER, 16], [Op.OP_CONST, 7], [Op.OP_LEAVE, 16],
];
const silentDebug: QvmExecutionProfile = { kind: "debug", trace: 0, breakFunction: 0 };

test("debug dispatch updates actual profile cells in source ENTER/LEAVE order and vmprofile resets them", async () => {
  const f = fixture(nested, silentDebug);
  f.load("0 0 main\n0 4 helper\n");
  expect(await f.invoke()).toBe(7);
  expect(f.vm.symbols.entries).toEqual([
    { name: "main", value: 0, profileCount: 5 }, { name: "helper", value: 16, profileCount: 2 },
  ]);
  expect(f.output).toEqual([]);
  expect(f.profile()).toBe("28%         2 helper\n71%         5 main\n            7 total\n");
  expect(f.vm.symbols.entries.map(symbol => symbol.profileCount)).toEqual([0, 0]);
  expect(f.profile()).toBe("vmprofile: percentages are undefined with zero total instructions.\n            0 main\n            0 helper\n            0 total\n");
  expect(await f.invoke()).toBe(7);
  f.vm.restart(image(nested));
  expect(f.vm.symbols.entries.map(symbol => symbol.profileCount)).toEqual([5, 2]);
});

test("opcode and call traces follow operand depth, indentation and the nonzero function breakpoint", async () => {
  const f = fixture(nested, { kind: "debug", trace: 2, breakFunction: 16 });
  f.load("0 0 main\n0 4 helper\n");
  expect(await f.invoke()).toBe(7);
  expect(f.output).toEqual([
    "0 OP_ENTER\n", "0---> main\n", "  0 OP_CONST\n", "  1 OP_CALL\n",
    "  0 OP_ENTER\n", "  0---> helper\n", "    0 OP_CONST\n", "    1 OP_LEAVE\n",
    "  1<--- main+11\n", "  1 OP_LEAVE\n", "1<--- main+-1\n",
  ]);
  expect(f.vm.callLevel).toBe(0);
  expect(f.vm.breakCount).toBe(1);
  const silent = fixture(nested, { kind: "debug", trace: 0, breakFunction: 16 });
  expect(await silent.invoke()).toBe(7);
  expect(silent.vm.breakCount).toBe(0);
});

test("release remains silent with zero counters and does not install debug frame links", async () => {
  const f = fixture(nested, { kind: "release" });
  f.load("0 0 main\n0 4 helper\n");
  expect(await f.invoke()).toBe(7);
  expect(f.output).toEqual([]);
  expect(f.vm.symbols.entries.map(symbol => symbol.profileCount)).toEqual([0, 0]);
  expect(new DataView(f.vm.memory.buffer).getInt32(452, true)).toBe(0);
  expect(f.vm.debugEnabled).toBe(false);
});

test("debug frame links survive recursive system calls and restore call depth before return traces", async () => {
  const recursive: readonly Operation[] = [
    [Op.OP_ENTER, 16], [Op.OP_LOCAL, 24], [Op.OP_LOAD4], [Op.OP_CONST, 0], [Op.OP_EQ, 7],
    [Op.OP_CONST, 77], [Op.OP_LEAVE, 16],
    [Op.OP_CONST, -6], [Op.OP_CALL], [Op.OP_LEAVE, 16],
  ];
  const f = fixture(recursive, { kind: "debug", trace: 1, breakFunction: 0 }, async call => {
    expect(call.words.getInt32(0, true)).toBe(5);
    expect(f.vm.callLevel).toBe(1);
    expect(await call.invoke(args(1))).toBe(77);
    expect(call.words.getInt32(0, true)).toBe(5);
    return 78;
  });
  f.load();
  expect(await f.invoke()).toBe(78);
  const data = new DataView(f.vm.memory.buffer);
  expect(data.getInt32(452, true)).toBe(464);
  expect(data.getInt32(384, true)).toBe(396);
  expect(f.output).toEqual([
    "0---> main\n", "  0---> systemcall(5)\n", "0---> main\n", "1<--- main+-1\n",
    "  1<--- main+37\n", "1<--- main+-1\n",
  ]);
  expect(f.vm.callLevel).toBe(0);
  expect(f.vm.symbols.entries[0]?.profileCount).toBe(15);
});

test("debug stack tracing follows frame links written by real ENTER instructions", async () => {
  const program: readonly Operation[] = [
    [Op.OP_ENTER, 16], [Op.OP_CONST, 4], [Op.OP_CALL], [Op.OP_LEAVE, 16],
    [Op.OP_ENTER, 16], [Op.OP_CONST, -1], [Op.OP_CALL], [Op.OP_LEAVE, 16],
  ];
  const trace: string[] = [];
  const f = fixture(program, silentDebug, call => {
    const sp = call.words.byteOffset - 4;
    // During a trap the +4 cell holds the trap number. The caller frame remains live.
    f.vm.stackTrace(16, sp + 16, text => { trace.push(text); });
    return 9;
  });
  f.load("0 0 main\n0 4 helper\n");
  expect(await f.invoke()).toBe(9);
  expect(trace).toEqual(["helper\n"]);
  trace.length = 0;
  f.vm.stackTrace(16, 432, text => { trace.push(text); });
  expect(trace).toEqual(["helper\n", "main+11\n"]);
});

test("DEBUG_VM guards reject bad opcodes, unaligned loads and the source stackBottom equality", async () => {
  const bad: readonly (readonly [readonly Operation[], string])[] = [
    [[[Op.OP_IGNORE]], "Bad VM instruction"],
    [[[Op.OP_UNDEF]], "Bad VM instruction"],
    [[[Op.OP_ENTER, 16], [Op.OP_CONST, 1], [Op.OP_LOAD4]], "OP_LOAD4 misaligned"],
    [[[Op.OP_POP]], "VM opStack underflow"],
    [[[Op.OP_BCOM]], "VM opStack underflow"],
    [[[Op.OP_PUSH], [Op.OP_LOAD4]], "QVM reads an uninitialized operand"],
    [[[Op.OP_ENTER, 1]], "VM program stack misaligned"],
    [[[Op.OP_ENTER, 16]], "VM pc out of range"],
  ];
  for (const [program, error] of bad) await expect(fixture(program, silentDebug).invoke()).rejects.toThrow(error);
  const overflow: Operation[] = [[Op.OP_ENTER, 16]];
  for (let index = 0; index < 256; index++) overflow.push([Op.OP_CONST, index]);
  await expect(fixture(overflow, silentDebug).invoke()).rejects.toThrow("VM opStack overflow");
  const stack: readonly Operation[] = [[Op.OP_ENTER, 0x20000 - 48], [Op.OP_CONST, 3], [Op.OP_LEAVE, 0x20000 - 48]];
  await expect(fixture(stack, silentDebug, () => 0, 0x40000).invoke()).rejects.toThrow("VM stack overflow");
  expect(await fixture(stack, { kind: "release" }, () => 0, 0x40000).invoke()).toBe(3);
});

test("return PCs into unknown prepared operand slots trap only in the debug profile", async () => {
  const program: readonly Operation[] = [[Op.OP_ENTER, 16], [Op.OP_CONST, -1], [Op.OP_CALL],
    [Op.OP_CONST, 100], [Op.OP_LEAVE, 16]];
  const redirect: QvmSystemCall = call => {
    new DataView(call.memory.buffer).setInt32(call.words.byteOffset - 4, 12, true);
    return 3;
  };
  await expect(fixture(program, silentDebug, redirect).invoke()).rejects.toThrow("Bad VM instruction");
  expect(await fixture(program, { kind: "release" }, redirect).invoke()).toBe(3);
});

test("profile selection is sampled at entry and recursive child selection cannot replace its parent's profile", async () => {
  const selection: { profile: QvmExecutionProfile } = { profile: silentDebug };
  const output: string[] = [], registry = new VmRegistry(text => { output.push(text); }, () => selection.profile);
  const registration = registry.reserve("ui");
  const program: readonly Operation[] = [
    [Op.OP_ENTER, 16], [Op.OP_LOCAL, 24], [Op.OP_LOAD4], [Op.OP_CONST, 0], [Op.OP_EQ, 7],
    [Op.OP_CONST, 77], [Op.OP_LEAVE, 16], [Op.OP_CONST, -1], [Op.OP_CALL], [Op.OP_LEAVE, 16],
  ];
  const vm = new QvmInterpreter(image(program), async call => {
    selection.profile = { kind: "release" };
    const value = await call.invoke(args(1));
    expect(vm.debugEnabled).toBe(true);
    return value;
  }, { kind: "unaccounted" }, registration);
  expect(await vm.invoke(args())).toBe(77);
  expect(vm.debugEnabled).toBe(true);
  expect(await vm.invoke(args(1))).toBe(77);
  expect(vm.debugEnabled).toBe(false);
  expect(output).toEqual([]);
});

test("counted symbols use their real source hunk cells and fail after that allocation retires", async () => {
  const arena = new HunkArena(4096, () => undefined), accounting = new SourceHunkAccounting(arena);
  const registry = new VmRegistry(() => undefined, () => silentDebug), registration = registry.reserve("qagame");
  const vm = new QvmInterpreter(image(nested), () => 0, { kind: "source-hunk", accounting }, registration);
  const fileMemory = new ReadFileMemory(), bytes = new TextEncoder().encode("0 0 main\n0 4 helper\n");
  vm.loadSymbols({ name: "qagame", developer: 1, print: () => undefined,
    files: { readFileRetainedSync: () => fileMemory.read(bytes.length, destination => { destination.set(bytes); }),
      freeFile: file => { fileMemory.freeFile(file); } } });
  registration.called();
  expect(await vm.invoke(args())).toBe(7);
  const main = vm.symbols.valueToFunctionSymbol(0);
  expect(main.profileCount).toBe(5);
  registry.printProfile(() => undefined);
  expect(main.profileCount).toBe(0);
  arena.clear({ kind: "dedicated", shutdownGameProgs: () => undefined, clearVm: () => { registry.clear(); } });
  expect(() => main.profileCount).toThrow("no longer valid");
  await expect(vm.invoke(args())).rejects.toThrow("no longer valid");
});
