// Source VM table lifetimes and command output. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { QvmOpcode, parseQvm } from "../src/assets/qvm.ts";
import { ReadFileMemory } from "../src/assets/read-file-memory.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { HunkArena } from "../src/core/hunk.ts";
import type { HunkAllocation, HunkPreference } from "../src/core/hunk.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";
import { QvmInterpreter } from "../src/vm/interpreter.ts";
import { VmRegistry } from "../src/vm/registry.ts";

function image() {
  const writer = new BinaryWriter(50);
  for (const word of [0x12721444, 3, 32, 18, 50, 0, 0, 129]) writer.i32(word);
  writer.u8(QvmOpcode.OP_ENTER); writer.i32(0);
  writer.u8(QvmOpcode.OP_CONST); writer.i32(19);
  writer.u8(QvmOpcode.OP_LEAVE); writer.i32(0);
  writer.u8(0); writer.u8(0); writer.u8(0);
  return parseQvm(writer.finish(), "authored-registry.qvm");
}

function info(registry: VmRegistry): string {
  let output = "";
  registry.printInfo(text => { output += text; });
  return output;
}

test("VM reservations publish cleared source fields, reuse names and retain three slots", () => {
  const registry = new VmRegistry();
  expect(info(registry)).toBe("Registered virtual machines:\n");
  const ui = registry.reserve("ui");
  expect(ui.binding.kind).toBe("initializing");
  expect(registry.reserve("UI")).toBe(ui);
  expect(info(registry)).toBe("Registered virtual machines:\nui : interpreted\n    code length :       0\n    table length:       0\n    data length :       1\n");
  const cgame = registry.reserve("cgame"), game = registry.reserve("qagame");
  expect(() => registry.reserve("fourth")).toThrow("VM_Create: no free vm_t");
  cgame.free();
  expect(info(registry)).not.toContain("qagame");
  const replacement = registry.reserve("other");
  expect(replacement).not.toBe(cgame);
  expect(info(registry)).toContain("qagame");
  cgame.free();
  expect(replacement.binding.kind).toBe("initializing");
  registry.clear();
  expect(ui.binding.kind).toBe("freed");
  expect(game.binding.kind).toBe("freed");
  expect(replacement.binding.kind).toBe("freed");
  expect(() => ui.called()).toThrow("freed");
  expect(() => registry.reserve("")).toThrow("VM_Create: bad parms");
});

test("vminfo reads actual source fields before each interpreter allocation and after binding", () => {
  const registry = new VmRegistry(), vm = registry.reserve("qagame"), observations: string[] = [];
  class ObservedAccounting extends SourceHunkAccounting {
    override reserve(source: string, resource: string, bytes: number, preference: HunkPreference): HunkAllocation {
      observations.push(`${source}\n${info(registry)}`);
      return super.reserve(source, resource, bytes, preference);
    }
  }
  const accounting = new ObservedAccounting(new HunkArena(2048, () => undefined));
  const interpreter = new QvmInterpreter(image(), () => 0, { kind: "source-hunk", accounting }, vm);
  expect(observations).toEqual([
    "VM_Create:dataBase\nRegistered virtual machines:\nqagame : interpreted\n    code length :       0\n    table length:       0\n    data length :       1\n",
    "VM_Create:instructionPointers\nRegistered virtual machines:\nqagame : interpreted\n    code length :       0\n    table length:      12\n    data length :     256\n",
    "VM_PrepareInterpreter\nRegistered virtual machines:\nqagame : interpreted\n    code length :      18\n    table length:      12\n    data length :     256\n",
  ]);
  expect(vm.binding).toEqual({ kind: "interpreted", interpreter });
  expect(interpreter.codeLength).toBe(18);
  expect(interpreter.instructionPointersLength).toBe(12);
  expect(info(registry)).toBe("Registered virtual machines:\nqagame : interpreted\n    code length :      18\n    table length:      12\n    data length :     256\n");
  expect(() => vm.bindTypeScript()).toThrow("already bound");
});

test("vminfo follows source print boundaries and a reused cell during printing", () => {
  const registry = new VmRegistry(), vm = registry.reserve("ui");
  const pieces: string[] = [];
  registry.printInfo(text => {
    pieces.push(text);
    if (text === "ui : ") { vm.free(); registry.reserve("other").bindTypeScript(); }
  });
  expect(pieces).toEqual(["Registered virtual machines:\n", "ui : ", "TypeScript replacement\n"]);
  expect(info(registry)).toBe("Registered virtual machines:\nother : TypeScript replacement\n");
});

test("vmprofile selects the last called live VM, while any VM_Free clears that selection", async () => {
  const registry = new VmRegistry(), first = registry.reserve("ui"), second = registry.reserve("cgame");
  const interpreter = new QvmInterpreter(image(), () => 0, { kind: "unaccounted" }, first);
  const memory = new ReadFileMemory(), text = "0 0 vmMain\n";
  interpreter.loadSymbols({ name: "ui", developer: 1, print: () => undefined,
    files: {
      readFileRetainedSync: () => memory.read(text.length, bytes => { bytes.set(new TextEncoder().encode(text)); }),
      freeFile: buffer => { memory.freeFile(buffer); },
    } });
  second.bindTypeScript();
  const printed: string[] = [];
  const print = (output: string): void => { printed.push(output); };
  registry.printProfile(print);
  expect(printed).toEqual([]);
  first.called();
  expect(await interpreter.invoke([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(19);
  registry.printProfile(print);
  expect(printed).toEqual(["vmprofile: percentages are undefined with zero total instructions; DEBUG_VM is disabled.\n",
    "            0 vmMain\n", "            0 total\n"]);
  printed.length = 0;
  second.called(); registry.printProfile(print);
  expect(printed).toEqual([]);
  first.called(); second.free(); registry.printProfile(print);
  expect(printed).toEqual([]);
  first.called(); registry.clear(); registry.printProfile(print);
  expect(printed).toEqual([]);
});

test("ordinary calls without developer symbols and TypeScript replacements print no profile", () => {
  const registry = new VmRegistry(), vm = registry.reserve("ui");
  new QvmInterpreter(image(), () => 0, { kind: "unaccounted" }, vm);
  vm.called();
  const printed: string[] = [];
  registry.printProfile(text => { printed.push(text); });
  expect(printed).toEqual([]);
  vm.free();
  const retail = registry.reserve("qagame");
  retail.bindTypeScript(); retail.called();
  registry.printProfile(text => { printed.push(text); });
  expect(printed).toEqual([]);
  expect(info(registry)).toBe("Registered virtual machines:\nqagame : TypeScript replacement\n");
});
