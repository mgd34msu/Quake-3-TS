/*
 * VM_Create, VM_Free, VM_Clear, VM_Call and VM_VmInfo_f from id Software's qcommon/vm.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { CommonError } from "../core/common-error.ts";
import type { QvmInterpreter } from "./interpreter.ts";

export type VmBinding =
  | { readonly kind: "initializing" }
  | { readonly kind: "interpreted"; readonly interpreter: QvmInterpreter }
  | { readonly kind: "typescript" }
  | { readonly kind: "freed" };

export interface VmRegistration {
  readonly name: string;
  readonly binding: VmBinding;
  bindData(memory: Uint8Array): void;
  bindInstructionPointersLength(length: number): void;
  bindCodeLength(length: number): void;
  bindInterpreter(interpreter: QvmInterpreter): void;
  bindTypeScript(): void;
  called(): void;
  debug(level: number): void;
  print(text: string): void;
  printCall(callnum: number): void;
  free(): void;
}

type VmRecord =
  | { readonly kind: "initializing"; dataLength: number; instructionPointersLength: number; codeLength: number }
  | { readonly kind: "interpreted"; readonly interpreter: QvmInterpreter }
  | { readonly kind: "typescript" }
  | { readonly kind: "freed" };

interface VmSlot {
  registration: VmRegistration | null;
  record: VmRecord;
}

function slot(): VmSlot { return { registration: null, record: { kind: "freed" } }; }
function lower(name: string): string {
  return name.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
}

/** Common-lived VM table. Its slots survive individual module and filesystem lifetimes. */
export class VmRegistry {
  private readonly slots: readonly [VmSlot, VmSlot, VmSlot] = [slot(), slot(), slot()];
  private lastCalled: VmRegistration | null = null;
  private debugLevel = 0;

  constructor(private readonly print: (text: string) => void = () => undefined) {}

  debug(level: number): void { this.debugLevel = level; }

  reserve(name: string): VmRegistration {
    const nul = name.indexOf("\0"), sourceName = nul < 0 ? name : name.slice(0, nul);
    if (sourceName.length === 0) throw new CommonError("fatal", "VM_Create: bad parms");
    for (const cell of this.slots) {
      const existing = cell.registration;
      if (existing !== null && lower(existing.name) === lower(sourceName)) return existing;
    }
    const cell = this.slots.find(candidate => candidate.registration === null);
    if (cell === undefined) throw new CommonError("fatal", "VM_Create: no free vm_t");
    const current = (): VmRecord => {
      if (cell.registration !== registration) throw new Error("VM registration has been freed");
      return cell.record;
    };
    const preparing = (): Extract<VmRecord, { kind: "initializing" }> => {
      const record = current();
      if (record.kind !== "initializing") throw new Error("VM registration is already bound");
      return record;
    };
    const registration: VmRegistration = {
      name: sourceName.slice(0, 63),
      get binding(): VmBinding { return cell.registration === registration ? cell.record : { kind: "freed" }; },
      bindData(memory): void { preparing().dataLength = memory.length; },
      bindInstructionPointersLength(length): void { preparing().instructionPointersLength = length; },
      bindCodeLength(length): void { preparing().codeLength = length; },
      bindInterpreter(interpreter): void { preparing(); cell.record = { kind: "interpreted", interpreter }; },
      bindTypeScript(): void { preparing(); cell.record = { kind: "typescript" }; },
      called: (): void => { current(); this.lastCalled = registration; },
      debug: (level): void => { current(); this.debug(level); },
      print: (text): void => { current(); this.print(text); },
      printCall: (callnum): void => {
        current();
        if (this.debugLevel !== 0) this.print(`VM_Call( ${callnum} )\n`);
      },
      free: (): void => {
        if (cell.registration !== registration) return;
        cell.registration = null;
        cell.record = { kind: "freed" };
        this.lastCalled = null;
      },
    };
    cell.record = { kind: "initializing", codeLength: 0, instructionPointersLength: 0, dataLength: 1 };
    cell.registration = registration;
    return registration;
  }

  clear(): void {
    for (const cell of this.slots) { cell.registration = null; cell.record = { kind: "freed" }; }
    this.lastCalled = null;
  }

  printInfo(print: (text: string) => void): void {
    print("Registered virtual machines:\n");
    for (const cell of this.slots) {
      const registration = cell.registration;
      if (registration === null) break;
      print(`${registration.name} : `);
      if (cell.record.kind === "typescript") { print("TypeScript replacement\n"); continue; }
      print("interpreted\n");
      print(`    code length : ${this.codeLength(cell).toString().padStart(7)}\n`);
      print(`    table length: ${this.tableLength(cell).toString().padStart(7)}\n`);
      print(`    data length : ${this.dataLength(cell).toString().padStart(7)}\n`);
    }
  }

  printProfile(print: (text: string) => void): void {
    const binding = this.lastCalled?.binding;
    if (binding?.kind === "interpreted") binding.interpreter.symbols.printProfile(print);
  }

  private codeLength(cell: VmSlot): number {
    const record = cell.record;
    return record.kind === "interpreted" ? record.interpreter.codeLength : record.kind === "initializing" ? record.codeLength : 0;
  }
  private tableLength(cell: VmSlot): number {
    const record = cell.record;
    return record.kind === "interpreted" ? record.interpreter.instructionPointersLength : record.kind === "initializing" ? record.instructionPointersLength : 0;
  }
  private dataLength(cell: VmSlot): number {
    const record = cell.record;
    return record.kind === "interpreted" ? record.interpreter.memory.length : record.kind === "initializing" ? record.dataLength : 1;
  }
}
