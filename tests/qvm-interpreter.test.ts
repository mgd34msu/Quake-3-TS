import { describe, expect, test } from "bun:test";
import { QvmOpcode as Op, parseQvm } from "../src/assets/qvm.ts";
import type { QvmImage } from "../src/assets/qvm.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ConsoleOutput } from "../src/core/console-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { HunkArena } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import type { HunkAccountingProfile } from "../src/render/hunk-accounting.ts";
import { Weapon } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { readQvmEntityState, writeQvmEntityState } from "../src/vm/entity-record.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { qvmMathSyscall } from "../src/vm/math-syscalls.ts";
import { qvmCommonSyscall } from "../src/vm/common-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { VmRegistry } from "../src/vm/registry.ts";
import { readQvmPlayerState, writeQvmPlayerState } from "../src/vm/player-record.ts";
import { readQvmUserCommand, writeQvmUserCommand } from "../src/vm/user-command.ts";
import type { QvmArguments, QvmSyscall, QvmSystemCall } from "../src/vm/interpreter.ts";

type Operation = readonly [Op, number?];

function image(operations: readonly Operation[], words: readonly number[] = [], size = 512): QvmImage {
  const code = new BinaryWriter(operations.length * 5);
  for (const [opcode, operand] of operations) {
    code.u8(opcode);
    if (operand !== undefined) {
      if (opcode === Op.OP_ARG) code.u8(operand);
      else code.i32(operand);
    }
  }
  const bytes = code.finish();
  const writer = new BinaryWriter(32 + bytes.length + words.length * 4);
  for (const word of [0x12721444, operations.length, 32, bytes.length, 32 + bytes.length,
    words.length * 4, 0, size - words.length * 4]) writer.i32(word);
  writer.bytes(bytes);
  for (const word of words) writer.i32(word);
  return parseQvm(writer.finish(), "synthetic.qvm");
}

function args(command = 0, value = 0): QvmArguments { return [command, value, 0, 0, 0, 0, 0, 0, 0, 0]; }
function noTrap(): never { throw new Error("Unexpected syscall"); }
function machine(code: readonly Operation[], words: readonly number[] = []): QvmInterpreter {
  return new QvmInterpreter(image(code, words), noTrap);
}

const recursiveProgram: readonly Operation[] = [
  [Op.OP_ENTER, 16], [Op.OP_LOCAL, 24], [Op.OP_LOAD4], [Op.OP_CONST, 0], [Op.OP_EQ, 7],
  [Op.OP_CONST, 77], [Op.OP_LEAVE, 16],
  [Op.OP_LOCAL, 28], [Op.OP_LOAD4], [Op.OP_ARG, 8], [Op.OP_CONST, -6], [Op.OP_CALL], [Op.OP_LEAVE, 16],
];

describe("QVM interpreter", () => {
  test("VM_Debug prints VM_Call through the common owner then interpreter entry clears the shared level", async () => {
    const output: string[] = [], registry = new VmRegistry(text => { output.push(text); });
    const registration = registry.reserve("qagame");
    const vm = new QvmInterpreter(image([[Op.OP_ENTER, 0], [Op.OP_CONST, 7], [Op.OP_LEAVE, 0]]),
      noTrap, { kind: "unaccounted" }, registration);
    registry.debug(-2);
    vm.callLevel = 3;
    expect(await vm.invoke(args(9))).toBe(7);
    expect(vm.callLevel).toBe(0);
    expect(output).toEqual(["VM_Call( 9 )\n"]);
    await vm.invoke(args(10));
    expect(output).toEqual(["VM_Call( 9 )\n"]);
    const data = new DataView(vm.memory.buffer);
    data.setInt32(68, 96, true);
    data.setInt32(96, -1, true);
    vm.stackTrace(0, 64);
    expect(output.at(-1)).toBe("NO SYMBOLS\n");
  });

  test("common command trap awaits actual command execution and a recursive VM call", async () => {
    const commands = new CommandBuffer(), nested: number[] = [];
    const services = { commands, cvars: new CvarRegistry(), output: new ConsoleOutput(() => undefined),
      clock: { milliseconds: () => 0 } };
    const vm = new QvmInterpreter(image([
      [Op.OP_ENTER, 16], [Op.OP_LOCAL, 24], [Op.OP_LOAD4], [Op.OP_CONST, 0], [Op.OP_EQ, 7],
      [Op.OP_CONST, 77], [Op.OP_LEAVE, 16],
      [Op.OP_CONST, 0], [Op.OP_ARG, 8], [Op.OP_CONST, 64], [Op.OP_ARG, 12],
      [Op.OP_CONST, -13], [Op.OP_CALL], [Op.OP_LEAVE, 16],
    ]), call => {
      commands.registerAsync("nested", async context => {
        nested.push(await call.invoke(args(1)));
        context.assertActive();
      });
      const result = qvmCommonSyscall("ui", call.words, new QvmMemory(call.memory), services);
      if (result === null) throw new Error("Unexpected common syscall");
      return result;
    });
    new QvmMemory(vm.memory).writeString(64, "nested", 16);
    expect(await vm.invoke(args())).toBe(0);
    expect(nested).toEqual([77]);
    expect(commands.tokenizedArguments).toEqual(["nested"]);
    expect(await vm.invoke(args(1))).toBe(77);
  });

  test("common cvar trap shares registry indices and publishes consumed VM record bytes", async () => {
    const cvars = new CvarRegistry(), services = { cvars, commands: new CommandBuffer(),
      output: new ConsoleOutput(() => undefined), clock: { milliseconds: () => 0 } };
    const vm = new QvmInterpreter(image([
      [Op.OP_ENTER, 24], [Op.OP_CONST, 64], [Op.OP_ARG, 8], [Op.OP_CONST, 16], [Op.OP_ARG, 12],
      [Op.OP_CONST, 32], [Op.OP_ARG, 16], [Op.OP_CONST, 0], [Op.OP_ARG, 20],
      [Op.OP_CONST, -51], [Op.OP_CALL], [Op.OP_POP], [Op.OP_CONST, 76], [Op.OP_LOAD4], [Op.OP_LEAVE, 24],
    ]), call => {
      const result = qvmCommonSyscall("ui", call.words, new QvmMemory(call.memory), services);
      if (result === null) throw new Error("Unexpected common syscall");
      return result;
    });
    const memory = new QvmMemory(vm.memory);
    memory.writeString(16, "mod_value", 16);
    memory.writeString(32, "123", 16);
    expect(await vm.invoke(args())).toBe(123);
    expect(cvars.get("mod_value")?.value).toBe("123");
    cvars.set("mod_value", "456", true);
    expect(await vm.invoke(args())).toBe(456);
    expect(cvars.indexCount).toBe(1);
    expect(memory.readString(80)).toBe("456");
  });

  test("initializes the ten-word entry frame and restores it for the next call", async () => {
    const vm = machine([[Op.OP_ENTER, 16], [Op.OP_LOCAL, 60], [Op.OP_LOAD4], [Op.OP_LEAVE, 16]]);
    expect(await vm.invoke([1, 2, 3, 4, 5, 6, 7, 8, 9, -10])).toBe(-10);
    const memory = new DataView(vm.memory.buffer);
    expect(memory.getInt32(464, true)).toBe(-1);
    expect(memory.getInt32(468, true)).toBe(0);
    expect(memory.getInt32(472, true)).toBe(1);
    expect(await vm.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 25])).toBe(25);
  });

  test("calls instruction indices but stores byte return PCs in shared memory", async () => {
    const vm = machine([
      [Op.OP_ENTER, 16], [Op.OP_CONST, 6], [Op.OP_CALL], [Op.OP_CONST, 100], [Op.OP_ADD], [Op.OP_LEAVE, 16],
      [Op.OP_ENTER, 8], [Op.OP_LOCAL, 8], [Op.OP_LOAD4], [Op.OP_LEAVE, 8],
    ]);
    expect(await vm.invoke(args())).toBe(111);
    expect(new DataView(vm.memory.buffer).getInt32(448, true)).toBe(11);
  });

  test("branches and jumps to instruction indices without executing skipped opcodes", async () => {
    const branch = machine([
      [Op.OP_ENTER, 0], [Op.OP_CONST, 7], [Op.OP_CONST, 7], [Op.OP_EQ, 6],
      [Op.OP_CONST, 1], [Op.OP_LEAVE, 0], [Op.OP_CONST, 9], [Op.OP_LEAVE, 0],
    ]);
    expect(await branch.invoke(args())).toBe(9);
    const jump = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 4], [Op.OP_JUMP], [Op.OP_BREAK],
      [Op.OP_UNDEF], [Op.OP_IGNORE], [Op.OP_BREAK], [Op.OP_CONST, 2], [Op.OP_LEAVE, 0]]);
    expect(await jump.invoke(args())).toBe(2);
    expect(jump.breakCount).toBe(1);
  });

  test("keeps stale PUSH cells and the pinned preceding-cell BCOM behavior", async () => {
    const stale = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 42], [Op.OP_POP], [Op.OP_PUSH], [Op.OP_LEAVE, 0]]);
    expect(await stale.invoke(args())).toBe(42);
    const complement = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 123], [Op.OP_CONST, 5],
      [Op.OP_BCOM], [Op.OP_POP], [Op.OP_LEAVE, 0]]);
    expect(await complement.invoke(args())).toBe(-6);
    const reserved = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 5], [Op.OP_BCOM], [Op.OP_LEAVE, 0]]);
    expect(await reserved.invoke(args())).toBe(5);
    const zeroCell = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 5], [Op.OP_BCOM], [Op.OP_POP],
      [Op.OP_NEGI], [Op.OP_PUSH], [Op.OP_LEAVE, 0]]);
    expect(await zeroCell.invoke(args())).toBe(5);
    const belowZero = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 5], [Op.OP_BCOM], [Op.OP_POP], [Op.OP_BCOM]]);
    await expect(belowZero.invoke(args())).rejects.toThrow("underflow");
    await expect(machine([[Op.OP_ENTER, 0], [Op.OP_PUSH], [Op.OP_LEAVE, 0]]).invoke(args())).rejects.toThrow("uninitialized");
    expect(await machine([[Op.OP_ENTER, 0], [Op.OP_PUSH], [Op.OP_POP], [Op.OP_CONST, 7],
      [Op.OP_LEAVE, 0]]).invoke(args())).toBe(7);
  });

  test("masks addresses, aligns stores but leaves loads unaligned", async () => {
    const vm = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, -511], [Op.OP_CONST, 0x12345678], [Op.OP_STORE4],
      [Op.OP_CONST, 1], [Op.OP_LOAD4], [Op.OP_LEAVE, 0]]);
    expect(await vm.invoke(args())).toBe(0x00123456);
    expect(vm.memory.subarray(0, 4)).toEqual(new Uint8Array([0x78, 0x56, 0x34, 0x12]));
    const half = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 511], [Op.OP_CONST, 0xcafe], [Op.OP_STORE2],
      [Op.OP_CONST, 510], [Op.OP_LOAD2], [Op.OP_LEAVE, 0]]);
    expect(await half.invoke(args())).toBe(0xcafe);
    const byte = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, -512], [Op.OP_CONST, 0x1ff], [Op.OP_STORE1],
      [Op.OP_CONST, 512], [Op.OP_LOAD1], [Op.OP_LEAVE, 0]]);
    expect(await byte.invoke(args())).toBe(255);
    expect(vm.pointer(0)).toBeNull();
    expect(vm.pointer(512)?.byteOffset).toBe(0);
    expect(vm.pointer(-1)?.byteOffset).toBe(511);
  });

  test("BLOCK_COPY copies backward and retains both source range reductions", async () => {
    const copy = (destination: number, source: number, count: number): QvmInterpreter => machine([
      [Op.OP_ENTER, 0], [Op.OP_CONST, destination], [Op.OP_CONST, source], [Op.OP_BLOCK_COPY, count],
      [Op.OP_CONST, 0], [Op.OP_LEAVE, 0],
    ], [1, 2, 3, 4]);
    for (const [vm, expected] of [
      [copy(0, 4, 12), [4, 4, 4, 4]], [copy(4, 0, 12), [1, 1, 2, 3]], [copy(0, 4, 512), [1, 2, 3, 4]],
    ] satisfies readonly (readonly [QvmInterpreter, readonly number[]])[]) {
      await vm.invoke(args());
      const view = new DataView(vm.memory.buffer);
      expect([0, 4, 8, 12].map(offset => view.getInt32(offset, true))).toEqual(expected);
    }
    await expect(copy(1, 0, 4).invoke(args())).rejects.toEqual(new CommonError("drop", "OP_BLOCK_COPY not dword aligned"));
  });

  test("restart reloads data in place, retaining code and untouched allocation tail", async () => {
    const vm = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 0], [Op.OP_LOAD4], [Op.OP_LEAVE, 0]], [3]);
    const originalMemory = vm.memory;
    vm.memory.fill(99);
    vm.restart(image([[Op.OP_CONST, 999]], [7], 256));
    expect(vm.memory).toBe(originalMemory);
    expect(vm.memory[100]).toBe(0);
    expect(vm.memory[400]).toBe(99);
    expect(await vm.invoke(args())).toBe(7);
    expect(() => vm.restart(image([[Op.OP_BREAK]], [], 1024))).toThrow("original allocation");
  });

  test("source hunk storage backs the actual data, jump table and prepared code", async () => {
    const arena = new HunkArena(2048, () => undefined), accounting = new SourceHunkAccounting(arena);
    const guard = arena.allocate(32, "low"); guard.bytes.fill(0x5a);
    const module = image([
      [Op.OP_ENTER, 16], [Op.OP_CONST, 4], [Op.OP_CALL], [Op.OP_LEAVE, 16],
      [Op.OP_ENTER, 16], [Op.OP_CONST, 41], [Op.OP_LEAVE, 16],
      [Op.OP_ENTER, 16], [Op.OP_CONST, 99], [Op.OP_LEAVE, 16],
    ]);
    const vm = new QvmInterpreter(module, noTrap, { kind: "source-hunk", accounting });
    expect(vm.memory.buffer).toBe(guard.bytes.buffer);
    expect(vm.memory.byteOffset).toBe(1536);
    const trace = accounting.report().trace;
    expect(trace.map(row => [row.source, row.bytes, row.reservedBytes, row.offset])).toEqual([
      ["VM_Create:dataBase", 512, 512, 1536], ["VM_Create:instructionPointers", 40, 64, 1472],
      ["VM_PrepareInterpreter", 184, 192, 1280],
    ]);
    expect(arena.memoryRemaining()).toBe(1248);
    expect(await vm.invoke(args())).toBe(41);
    const pointers = new Int32Array(vm.memory.buffer, 1472, 10);
    pointers[4] = 31;
    expect(await vm.invoke(args())).toBe(99);
    const code = new Int32Array(vm.memory.buffer, 1280, 46);
    code[37] = 123;
    expect(await vm.invoke(args())).toBe(123);
    expect(guard.bytes).toEqual(new Uint8Array(32).fill(0x5a));
  });

  test("source hunk syscall words use the VM offset and cannot extend into adjacent owners", async () => {
    const arena = new HunkArena(2048, () => undefined), accounting = new SourceHunkAccounting(arena);
    const guard = arena.allocate(32, "low"); guard.bytes.fill(0x73);
    const file = arena.allocateTemp(32);
    const vm = new QvmInterpreter(image(recursiveProgram), call => {
      expect(call.memory.buffer).toBe(guard.bytes.buffer);
      expect(call.memory.byteOffset).toBe(1536);
      expect(call.words.byteOffset).toBe(1536 + 448 + 4);
      expect(call.words.byteLength).toBe(60);
      expect(call.words.getInt32(0, true)).toBe(5);
      expect(call.words.getInt32(4, true)).toBe(29);
      expect(() => call.words.getInt32(60, true)).toThrow(RangeError);
      return 81;
    }, { kind: "source-hunk", accounting });
    expect(await vm.invoke(args(0, 29))).toBe(81);
    expect(guard.bytes).toEqual(new Uint8Array(32).fill(0x73));
    expect(file.bytes.byteLength).toBe(32);
    arena.freeTemp(file);
  });

  test("server mark retains actual VM storage through client clear and data-only restart", async () => {
    const arena = new HunkArena(4096, () => undefined), accounting = new SourceHunkAccounting(arena);
    const profile = { kind: "source-hunk", accounting } satisfies HunkAccountingProfile;
    const vm = new QvmInterpreter(image([[Op.OP_ENTER, 0], [Op.OP_CONST, 0], [Op.OP_LOAD4], [Op.OP_LEAVE, 0]], [3]), noTrap, profile);
    const remaining = arena.memoryRemaining();
    accounting.setMark();
    const client = new QvmInterpreter(image([[Op.OP_ENTER, 0], [Op.OP_CONST, 91], [Op.OP_LEAVE, 0]]), noTrap, profile);
    expect(await client.invoke(args())).toBe(91);
    accounting.clearToMark();
    expect(arena.memoryRemaining()).toBe(remaining);
    await expect(client.invoke(args())).rejects.toThrow("no longer valid");
    const beforeRestart = accounting.report().trace.length, original = vm.memory;
    original.fill(99);
    vm.restart(image([[Op.OP_CONST, 999]], [7], 256));
    expect(vm.memory).toBe(original);
    expect(vm.memory[400]).toBe(99);
    expect(await vm.invoke(args())).toBe(7);
    expect(arena.memoryRemaining()).toBe(remaining);
    expect(accounting.report().trace.length).toBe(beforeRestart);
    await accounting.clearAsync({ kind: "dedicated", shutdownGameProgs: () => undefined, clearVm: () => undefined });
    expect(arena.memoryRemaining()).toBe(4096);
    await expect(vm.invoke(args())).rejects.toThrow("no longer valid");
  });

  test("source VM exhaustion retains only the allocations reached before failure", () => {
    const arena = new HunkArena(512, () => undefined), accounting = new SourceHunkAccounting(arena);
    expect(() => new QvmInterpreter(image([[Op.OP_ENTER, 0], [Op.OP_CONST, 1], [Op.OP_LEAVE, 0]]), noTrap,
      { kind: "source-hunk", accounting })).toThrow("Hunk_Alloc failed on 32");
    expect(arena.memoryRemaining()).toBe(0);
    expect(accounting.report().trace.map(row => row.source)).toEqual(["VM_Create:dataBase"]);
  });

  test("rejects undefined memory, stack, host-word and control-flow accesses", async () => {
    const invalid: readonly (readonly [readonly Operation[], string])[] = [
      [[[Op.OP_ENTER, 0], [Op.OP_CONST, 511], [Op.OP_LOAD2]], "exceeds allocation"],
      [[[Op.OP_ENTER, 0], [Op.OP_CONST, 510], [Op.OP_LOAD4]], "exceeds allocation"],
      [[[Op.OP_ENTER, 1]], "misaligned"],
      [[[Op.OP_ENTER, 1024]], "exceeds allocation"],
      [[[Op.OP_POP]], "underflow"],
      [[[Op.OP_ENTER, 0], [Op.OP_CONST, 9], [Op.OP_JUMP]], "instruction index"],
      [[[Op.OP_ENTER, 0], [Op.OP_CONST, 9], [Op.OP_CALL]], "instruction index"],
      [[[Op.OP_ENTER, 0], [Op.OP_CONST, 1], [Op.OP_CONST, 2], [Op.OP_LEAVE, 0]], "Interpreter error: opStack = 2"],
    ];
    for (const [code, message] of invalid) await expect(machine(code).invoke(args())).rejects.toThrow(message);
    const vm = machine([[Op.OP_ENTER, 0], [Op.OP_CONST, 3], [Op.OP_LEAVE, 0]]);
    await expect(vm.invoke(args(0x80000000))).rejects.toThrow("signed 32-bit");
    expect(await vm.invoke(args())).toBe(3);
  });
});

describe("QVM syscall ownership", () => {
  test("consumes typed engine records written into real VM pointer arguments", async () => {
    const entity = new EntityState(); entity.generic1 = 11;
    const player = new PlayerState("missionpack"); player.entityEventSequence = 5;
    player.deltaAngles = { x: 0x7fffffff, y: -0x80000000, z: 0x1000001 };
    const vm = new QvmInterpreter(image([
      [Op.OP_ENTER, 24], [Op.OP_CONST, 64], [Op.OP_ARG, 8], [Op.OP_CONST, 128], [Op.OP_ARG, 12],
      [Op.OP_CONST, 512], [Op.OP_ARG, 16], [Op.OP_CONST, -1], [Op.OP_CALL], [Op.OP_POP],
      [Op.OP_CONST, 68], [Op.OP_LOAD4], [Op.OP_CONST, 332], [Op.OP_LOAD4], [Op.OP_ADD],
      [Op.OP_CONST, 976], [Op.OP_LOAD4], [Op.OP_ADD], [Op.OP_LEAVE, 24],
    ], [], 2048), call => {
      const view = (argument: number): DataView => {
        const pointer = vm.pointer(call.words.getInt32(argument * 4, true));
        if (pointer === null) throw new Error("Unexpected null record pointer");
        return new DataView(pointer.buffer, pointer.byteOffset, pointer.byteLength);
      };
      writeQvmUserCommand(view(1), { serverTime: 7, angles: { x: 0x1000001, y: 0, z: 0 },
        buttons: 0, weapon: Weapon.WP_NAILGUN, forwardmove: -128, rightmove: 0, upmove: 0 });
      writeQvmEntityState(view(2), entity);
      writeQvmPlayerState(view(3), player);
      return 0;
    });
    expect(await vm.invoke(args())).toBe(0x1000011);
    expect(readQvmUserCommand(new DataView(vm.memory.buffer, 64)).angles.x).toBe(0x1000001);
    expect(readQvmEntityState(new DataView(vm.memory.buffer, 128)).generic1).toBe(11);
    expect(readQvmPlayerState(new DataView(vm.memory.buffer, 512), "missionpack").deltaAngles).toEqual(player.deltaAngles);
  });

  test("executes module-specific scalar math traps through actual argument words", async () => {
    const cases: readonly (readonly ["game" | "cgame" | "ui", number, number, number, number])[] = [
      ["game", 103, 0, 0, 0], ["ui", 104, 0, 0, 0x3f800000],
      ["cgame", 105, 0x3f800000, 0, 0x3fc90fdb], ["game", 106, 0x40c80000, 0, 0x40200000],
      ["game", 110, -1080033280, 0, -1073741824], ["game", 111, -1080033280, 0, -1082130432],
      ["ui", 107, -1080033280, 0, -1073741824], ["ui", 108, -1080033280, 0, -1082130432],
      ["cgame", 111, -1082130432, 0, 0x40490fdb],
    ];
    for (const [role, trap, first, second, expected] of cases) {
      const vm = new QvmInterpreter(image([
        [Op.OP_ENTER, 16], [Op.OP_CONST, first], [Op.OP_ARG, 8], [Op.OP_CONST, second], [Op.OP_ARG, 12],
        [Op.OP_CONST, -1 - trap], [Op.OP_CALL], [Op.OP_LEAVE, 16],
      ]), call => {
        const result = qvmMathSyscall(role, call.words);
        if (result === null) throw new Error("Unexpected non-math trap");
        return result;
      });
      expect(await vm.invoke(args())).toBe(expected);
    }
    const words = new DataView(new ArrayBuffer(8));
    words.setInt32(0, 107, true);
    expect(qvmMathSyscall("game", words)).toBeNull(); // MatrixMultiply, not floor.
    words.setInt32(0, 111, true);
    expect(qvmMathSyscall("ui", words)).toBeNull();
    words.setFloat32(4, 2, true);
    const outside = qvmMathSyscall("cgame", words);
    if (outside === null) throw new Error("Expected acos trap");
    expect(outside & 0x7f800000).toBe(0x7f800000);
    expect(outside & 0x7fffff).not.toBe(0); // Q_acos(2) is NaN, not a clamped zero.
  });

  test("exposes live arguments and supports asynchronous sequential recursive calls", async () => {
    const offsets: number[] = [];
    const vm = new QvmInterpreter(image(recursiveProgram), async call => {
      offsets.push(call.words.byteOffset);
      expect(call.words.getInt32(0, true)).toBe(5);
      expect(call.words.getInt32(4, true)).toBe(123);
      expect(new DataView(call.memory.buffer).getInt32(call.words.byteOffset - 4, true)).toBe(45);
      const first = await call.invoke(args(1));
      const second = await call.invoke(args(1));
      expect(call.words.getInt32(0, true)).toBe(5);
      return first + second;
    });
    expect(await vm.invoke(args(0, 123))).toBe(154);
    expect(offsets).toEqual([452]);
    expect(new DataView(vm.memory.buffer).getInt32(396, true)).toBe(-1);
    expect(await vm.invoke(args(1))).toBe(77);
  });

  test("rereads the byte return PC after a syscall mutates shared memory", async () => {
    const vm = new QvmInterpreter(image([[Op.OP_ENTER, 16], [Op.OP_CONST, -1], [Op.OP_CALL],
      [Op.OP_CONST, 100], [Op.OP_ADD], [Op.OP_LEAVE, 16]]), call => {
      const memory = new DataView(call.memory.buffer);
      expect(memory.getInt32(call.words.byteOffset - 4, true)).toBe(11);
      memory.setInt32(call.words.byteOffset - 4, 17, true); // LEAVE's byte PC, not its index 5.
      return 3;
    });
    expect(await vm.invoke(args())).toBe(3);
  });

  test("executes prepared operand slots and their zero-filled tails as source byte PCs", async () => {
    const cases: readonly (readonly [number, number])[] = [[Op.OP_NEGI, -3], [100, 3]];
    for (const [operand, expected] of cases) {
      const vm = new QvmInterpreter(image([[Op.OP_ENTER, 16], [Op.OP_CONST, -1], [Op.OP_CALL],
        [Op.OP_CONST, operand], [Op.OP_LEAVE, 16]]), call => {
        new DataView(call.memory.buffer).setInt32(call.words.byteOffset - 4, 12, true);
        return 3;
      });
      expect(await vm.invoke(args())).toBe(expected);
    }
  });

  test("rejects concurrent roots, restart, overlapping children and expired capabilities", async () => {
    const gate = Promise.withResolvers<void>();
    const calls: QvmSyscall[] = [];
    const vm = new QvmInterpreter(image(recursiveProgram), async call => {
      calls.push(call);
      await gate.promise;
      const first = call.invoke(args(1));
      await expect(call.invoke(args(1))).rejects.toThrow("unoccupied syscall");
      return first;
    });
    const running = vm.invoke(args());
    await expect(vm.invoke(args())).rejects.toThrow("already active");
    expect(() => vm.restart(image(recursiveProgram))).toThrow("active QVM");
    gate.resolve();
    expect(await running).toBe(77);
    const expired = calls[0];
    if (expired === undefined) throw new Error("Expected syscall");
    await expect(expired.invoke(args(1))).rejects.toThrow("unoccupied syscall");
    expect(await vm.invoke(args(1))).toBe(77);
  });

  test("joins detached children before parent continuation, including child rejection", async () => {
    for (const rejectChild of [false, true]) {
      const gate = Promise.withResolvers<void>();
      let trapCount = 0;
      let parentDone = false;
      const handler: QvmSystemCall = call => {
        trapCount++;
        if (trapCount === 1) {
          void call.invoke(args());
          return 9;
        }
        return gate.promise.then(() => {
          if (rejectChild) throw new Error("nested failure");
          return 7;
        });
      };
      const vm = new QvmInterpreter(image(recursiveProgram), handler);
      const running = vm.invoke(args()).finally(() => { parentDone = true; });
      await Promise.resolve();
      expect(parentDone).toBe(false);
      gate.resolve();
      if (rejectChild) await expect(running).rejects.toThrow("nested failure");
      else expect(await running).toBe(9);
      expect(await vm.invoke(args(1))).toBe(77);
    }
  });

  test("waits for descendants on callback failure and rejects non-word results", async () => {
    const gate = Promise.withResolvers<void>();
    let trapCount = 0;
    let parentDone = false;
    const vm = new QvmInterpreter(image(recursiveProgram), call => {
      if (++trapCount > 1) return gate.promise.then(() => 7);
      void call.invoke(args());
      throw new Error("parent failure");
    });
    const running = vm.invoke(args()).finally(() => { parentDone = true; });
    await Promise.resolve();
    expect(parentDone).toBe(false);
    gate.resolve();
    await expect(running).rejects.toThrow("parent failure");
    expect(await vm.invoke(args(1))).toBe(77);
    const invalid = new QvmInterpreter(image(recursiveProgram), () => 1.5);
    await expect(invalid.invoke(args())).rejects.toThrow("signed 32-bit");
    expect(await new QvmInterpreter(image(recursiveProgram), () => -0).invoke(args())).toBe(0);
  });
});
