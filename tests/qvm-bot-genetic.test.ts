// Authored cases for sv_game.c genetic traps and be_ai_gen.c publication order.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { afterEach, describe, expect, test } from "bun:test";
import { SourceFileHandles } from "../src/assets/file-handles.ts";
import type { FileHandle } from "../src/assets/file-handles.ts";
import { BotLibrary } from "../src/botlib/library.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { qvmBotGeneticSyscall } from "../src/vm/bot-genetic-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";

const libraries: BotLibrary[] = [];
afterEach(() => { for (const library of libraries.splice(0)) library.disposeResources(); });

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return view;
}

function unexpected(): never { throw new Error("Unexpected service in authored genetic fixture"); }

class ObservedRandom extends LinuxNativeRandom {
  readonly draws: number[] = [];
  beforeNext: () => void = () => {};
  calls = 0;

  constructor() { super(1); }

  override next(): number {
    this.calls++;
    this.beforeNext();
    return this.draws.shift() ?? super.next();
  }
}

function fixture() {
  const files = new Map<string, Uint8Array>();
  const handles = new SourceFileHandles();
  const cursors = new Map<FileHandle, { readonly bytes: Uint8Array; offset: number }>();
  const reads: string[] = [], printed: { readonly severity: number; readonly text: string }[] = [];
  const control = { beforePrint: (_text: string): void => {} };
  const assets = {
    openRead: (path: string) => {
      reads.push(path);
      const bytes = files.get(path);
      if (bytes === undefined) return undefined;
      for (let slot = 1; slot <= 63; slot++) {
        const file = handles.fromSlot(slot);
        if (file !== null && !cursors.has(file)) {
          cursors.set(file, { bytes, offset: 0 });
          return { file, length: bytes.length };
        }
      }
      throw new Error("Authored genetic file slots exhausted");
    },
    readInto: (file: FileHandle, destination: Uint8Array): number => {
      const cursor = cursors.get(file);
      if (cursor === undefined) throw new Error("Authored genetic file is closed");
      const count = Math.max(0, Math.min(destination.length, cursor.bytes.length - cursor.offset));
      destination.set(cursor.bytes.subarray(cursor.offset, cursor.offset + count));
      cursor.offset += count;
      return count;
    },
    seekFile: (file: FileHandle, offset: number, origin: number): number => {
      const cursor = cursors.get(file);
      if (cursor === undefined) throw new Error("Authored genetic file is closed");
      if (origin !== 0 && origin !== 1 && origin !== 2) throw new Error("Bad authored file seek origin");
      const position = (origin === 0 ? cursor.offset : origin === 1 ? cursor.bytes.length : 0) + offset;
      if (!Number.isSafeInteger(position) || position < 0) return -1;
      cursor.offset = position;
      return 0;
    },
    closeFile: (file: FileHandle): void => {
      if (!cursors.delete(file)) throw new Error("Authored genetic file is already closed");
    },
    readSync: unexpected,
  };
  const random = new ObservedRandom();
  const library = new BotLibrary({ assets: () => assets, random,
    print: (severity, text) => { printed.push({ severity, text }); control.beforePrint(text); return undefined; },
    commonPrint: unexpected,
    openLog: unexpected, openWrite: unexpected, milliseconds: () => 0, permanentLine: unexpected,
    movementDebug: { kind: "enabled", print: unexpected, line: unexpected, clearLines: unexpected },
    clientCommand: unexpected,
  });
  libraries.push(library);
  const memory = new QvmMemory(new Uint8Array(2048).fill(0xa5));
  const call = (args: DataView): number | null => qvmBotGeneticSyscall("game", args, memory, library);
  const putRanks = (values: readonly number[], pointer = 32): void => {
    const view = memory.view(pointer, values.length * 4);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  };
  const output = (pointer: number): number => memory.view(pointer, 4).getInt32(0, true);
  const addFile = (path: string, source: string): void => { files.set(`botfiles/${path}`, new TextEncoder().encode(source)); };
  const loadGoal = (path: string, source: string): number => {
    if (library.goals.itemConfig === null) {
      addFile("items.c", 'iteminfo "item_health" { name "Health" modelindex 5 }');
      expect(library.goals.setup()).toBe(0);
    }
    addFile(path, source);
    const handle = library.goals.allocGoalState(1);
    expect(library.goals.loadItemWeights(handle, path)).toBe(0);
    return handle;
  };
  return { library, memory, call, random, reads, printed, control, putRanks, output, loadGoal };
}

describe("QVM game bot genetic traps", () => {
  test("gates roles and unhandled traps before reading arguments or owners", () => {
    const { library, memory, call, printed, random } = fixture(), empty = words();
    expect(qvmBotGeneticSyscall("ui", empty, memory, library)).toBeNull();
    expect(qvmBotGeneticSyscall("cgame", empty, memory, library)).toBeNull();
    for (const trap of [-1, 0, 544, 546, 563, 567]) expect(call(words(trap))).toBeNull();
    expect(printed).toEqual([]); expect(random.calls).toBe(0);
  });

  test("SAVE checks state without consuming a filename word, pointer, weight or file", () => {
    const { library, call, memory, reads, printed, random } = fixture();
    const handle = library.goals.allocGoalState(1), before = memory.bytes.slice();
    expect(call(words(545, handle))).toBe(0);
    expect(call(words(545, handle, 0))).toBe(0);
    expect(call(words(545, handle, 2047))).toBe(0);
    expect(call(words(545, 0))).toBe(0);
    expect(printed).toEqual([{ severity: 4, text: "goal state handle 0 out of range\n" }]);
    expect(reads).toEqual([]); expect(random.calls).toBe(0); expect(memory.bytes).toEqual(before);
  });

  test("uses the actual library stream and publishes before each following draw", () => {
    const { library, call, putRanks, output, random } = fixture();
    putRanks([10, 20, 30, 40]);
    const initial = output(128), seen: number[][] = [];
    random.beforeNext = () => { seen.push([output(128), output(132), output(136)]); };
    expect(call(words(564, 4, 32, 128, 132, 136))).toBe(1);
    expect(seen).toEqual([[initial, initial, initial], [3, initial, initial], [3, 2, initial]]);
    expect([output(128), output(132), output(136)]).toEqual([3, 2, 0]);
    expect(random.calls).toBe(3);
    const expected = new LinuxNativeRandom(1);
    expected.next(); expected.next(); expected.next();
    random.beforeNext = () => {};
    expect(random.next()).toBe(expected.next());
    expect(library.geneticSelection([10, 20, 30, 40])).toEqual({ kind: "selected", parent1: 3, parent2: 2, child: 0 });
    expect(random.calls).toBe(7);
  });

  test("counts live ranks before copying and keeps that copy through callbacks and output aliases", () => {
    const { library, call, putRanks, output, random, memory } = fixture();
    const reads: number[] = [], writes: string[] = [];
    random.draws.push(0, 0, 0);
    expect(library.geneticSelection({ count: 4, rank: index => {
      reads.push(index);
      return reads.length <= 4 ? 1 : (index + 1) * 10;
    }, write: (target, value) => { writes.push(`${target}:${value}`); } })).toEqual({ kind: "selected", parent1: 3, parent2: 2, child: 0 });
    expect(reads).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(writes).toEqual(["parent1:3", "parent2:2", "child:0"]);
    putRanks([10, 20, 30, 40], 2048);
    const initial = output(12), seen: number[] = [];
    random.beforeNext = () => { seen.push(output(12)); memory.bytes.subarray(0, 16).fill(0); };
    expect(call(words(564, 4, -2048, 12, 12, 12))).toBe(1);
    expect(seen).toEqual([initial, 3, 2]);
    expect(output(12)).toBe(0); expect(random.calls).toBe(6);
  });

  test("warns before right-to-left error writes and never reads unused rank pointers", () => {
    const { call, output, random, printed, control, memory } = fixture();
    const initial = output(128), snapshots: number[][] = [];
    control.beforePrint = () => { snapshots.push([output(128), output(132), output(136)]); };
    expect(() => call(words(564, 257, 0, 128, 0, 136))).toThrow(RangeError);
    expect(snapshots).toEqual([[initial, initial, initial]]);
    expect([output(128), output(132), output(136)]).toEqual([initial, initial, 0]);
    expect(printed).toEqual([{ severity: 2, text: "GeneticParentsAndChildSelection: too many bots\n" }]);
    memory.bytes.fill(0xa5);
    expect(() => call(words(564, -1, 0, 0, 132, 136))).toThrow(RangeError);
    expect([output(128), output(132), output(136)]).toEqual([initial, 0, 0]);
    expect(printed.at(-1)).toEqual({ severity: 2, text: "GeneticParentsAndChildSelection: too few valid bots\n" });
    expect(random.calls).toBe(0);
    expect(call(words(564, 257, 0, 128, 132, 136))).toBe(0);
    expect([output(128), output(132), output(136)]).toEqual([0, 0, 0]);
    expect(call(words(564, -2147483648, 0, 128, 132, 136))).toBe(0);
    expect(random.calls).toBe(0);
  });

  test("warning exceptions leave every output intact and preserve callback writes", () => {
    const { call, output, control, memory, random } = fixture();
    const failure = new Error("authored warning interruption"), initial = output(128);
    control.beforePrint = () => { memory.view(136, 4).setInt32(0, 19, true); throw failure; };
    expect(() => call(words(564, 0, 0, 128, 132, 136))).toThrow(failure);
    expect([output(128), output(132), output(136)]).toEqual([initial, initial, 19]);
    expect(random.calls).toBe(0);
  });

  test("checks only reached allocation extents and retains outputs before later faults", () => {
    const { call, putRanks, output, random, printed } = fixture();
    putRanks([1, 2, 3], 2036);
    const initial = output(128);
    expect(() => call(words(564, 4, 2036, 128, 132, 136))).toThrow(RangeError);
    expect(output(128)).toBe(initial); expect(printed).toEqual([]); expect(random.calls).toBe(0);
    putRanks([10, 20, 30, 40]);
    expect(() => call(words(564, 4, 32, 128, 2047, 136))).toThrow(RangeError);
    expect([output(128), output(136)]).toEqual([3, initial]); expect(random.calls).toBe(2);
    expect(() => call(words(564, 4, 32, 0, 132, 136))).toThrow(RangeError);
    expect(output(132)).toBe(initial); expect(random.calls).toBe(3);
  });

  test("accepts all 256 ranks and source comparisons for negative, zero and NaN ranks", () => {
    const { call, putRanks, output, random, printed } = fixture();
    const ranks = new Array<number>(256).fill(-1);
    ranks[253] = 1; ranks[254] = 2; ranks[255] = 3;
    putRanks(ranks); random.draws.push(0, 0, 0);
    expect(call(words(564, 256, 32, 1200, 1204, 1208))).toBe(1);
    expect([output(1200), output(1204), output(1208)]).toEqual([255, 254, 253]);
    putRanks([-0, -1, 0, 0]); random.draws.push(8192, 8192, 8192);
    expect(call(words(564, 4, 32, 128, 132, 136))).toBe(1);
    expect([output(128), output(132), output(136)]).toEqual([2, 3, 0]);
    putRanks([Number.NaN, 1, 2, 3]); random.draws.push(0, 16384, 32766);
    expect(call(words(564, 4, 32, 128, 132, 136))).toBe(1);
    expect([output(128), output(132), output(136)]).toEqual([1, 2, 3]);
    expect(printed).toEqual([]);
  });

  test("rejects the source's one-past random endpoint without inventing an output", () => {
    const { call, putRanks, output, random, printed } = fixture(), initial = output(128);
    putRanks([0, 0, 0]); random.draws.push(32767);
    expect(() => call(words(564, 3, 32, 128, 132, 136))).toThrow("undefined one-past random index");
    expect([output(128), output(132), output(136)]).toEqual([initial, initial, initial]);
    putRanks([5, 5, 5]); random.draws.push(32767, 32767, 32767);
    expect(() => call(words(564, 3, 32, 128, 132, 136))).toThrow("undefined one-past random index");
    expect([output(128), output(132), output(136)]).toEqual([2, 1, initial]);
    expect(printed).toEqual([]); expect(random.calls).toBe(4);
  });

  test("MUTATE uses owner weights, ignores the range word and retains binary32 subtraction", () => {
    const { library, call, loadGoal, random, reads } = fixture();
    const handle = loadGoal("mutate.c", 'weight "item_health" return balance(0, 1, 33554432);');
    const config = library.weights.load("mutate.c"), beforeReads = [...reads];
    random.draws.push(0, 1);
    expect(call(words(566, handle))).toBe(0);
    expect(config.evaluate(0, [0])).toBe(-33552384);
    expect(random.calls).toBe(2); expect(reads).toEqual(beforeReads);
    random.draws.push(32767, 16384);
    expect(call(words(566, handle, 0x7fc00000))).toBe(0);
    expect(random.calls).toBe(4);
  });

  test("MUTATE follows child-before-next order and keeps earlier changes on a random exception", () => {
    const { library, call, loadGoal, random } = fixture();
    const handle = loadGoal("ordered.c", 'weight "item_health" switch(0) { case 1: { switch(1) { default: return balance(4, 0, 8); } } default: return balance(10, 0, 20); }');
    const config = library.weights.load("ordered.c"), failure = new Error("authored random interruption");
    random.draws.push(0, 32767);
    random.beforeNext = () => { if (random.calls === 3) throw failure; };
    expect(() => call(words(566, handle))).toThrow(failure);
    expect(config.evaluate(0, [0, 0])).toBe(12);
    expect(config.evaluate(0, [2, 0])).toBe(10);
    expect(random.calls).toBe(3);
  });

  test("INTERBREED publishes each source error before later weight mutations", () => {
    const { library, call, loadGoal, control, printed, random } = fixture();
    const first = loadGoal("first.c", 'weight "a" return balance(2, 0, 10); weight "b" return balance(4, 0, 10); weight "c" return balance(6, 0, 10);');
    const second = loadGoal("second.c", 'weight "a" return balance(8, 0, 10); weight "b" return 4; weight "c" return balance(10, 0, 10);');
    const child = loadGoal("child.c", 'weight "a" return balance(0, 0, 1); weight "b" return balance(0, 0, 1); weight "c" return balance(0, 0, 1);');
    const output = library.weights.load("child.c"), parent = library.weights.load("second.c");
    printed.length = 0;
    const seen: number[][] = [];
    control.beforePrint = () => {
      seen.push([output.evaluate(0, [0]), output.evaluate(1, [0]), output.evaluate(2, [0])]);
      parent.scaleWeight("c", 0.2);
    };
    expect(call(words(565, first, second, child))).toBe(0);
    expect(seen).toEqual([[5, 0, 0]]);
    expect([output.evaluate(0, [0]), output.evaluate(1, [0]), output.evaluate(2, [0])]).toEqual([5, 0, 4]);
    expect(printed).toEqual([{ severity: 3, text: "cannot interbreed weight configs, unequal balance\n" }]);
    expect(random.calls).toBe(0);
  });

  test("INTERBREED keeps partial weights when source diagnostics throw", () => {
    const { library, call, loadGoal, control } = fixture();
    const first = loadGoal("first.c", 'weight "a" return balance(2, 0, 10); weight "b" return balance(4, 0, 10); weight "c" return balance(6, 0, 10);');
    const second = loadGoal("second.c", 'weight "a" return balance(8, 0, 10); weight "b" return 4; weight "c" return balance(10, 0, 10);');
    const child = loadGoal("child.c", 'weight "a" return balance(0, 0, 1); weight "b" return balance(0, 0, 1); weight "c" return balance(0, 0, 1);');
    const output = library.weights.load("child.c"), failure = new Error("authored interbreed interruption");
    control.beforePrint = () => { throw failure; };
    expect(() => call(words(565, first, second, child))).toThrow(failure);
    expect([output.evaluate(0, [0]), output.evaluate(1, [0]), output.evaluate(2, [0])]).toEqual([5, 0, 0]);
  });

  test("INTERBREED retains the source's second-parent child recursion and aliased owner", () => {
    const { library, call, loadGoal } = fixture();
    const first = loadGoal("first.c", 'weight "item_health" switch(0) { default: { switch(1) { default: return balance(2, 0, 10); } } }');
    const second = loadGoal("second.c", 'weight "item_health" switch(0) { default: { switch(1) { default: return balance(8, 0, 10); } } }');
    const output = library.weights.load("first.c");
    expect(call(words(565, first, second, first))).toBe(0);
    expect(output.evaluate(0, [0, 0])).toBe(8);
  });
});
