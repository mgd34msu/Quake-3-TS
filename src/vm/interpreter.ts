/*
 * Translated from Quake III Arena qcommon/vm.c and vm_interpreted.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { QvmOpcode } from "../assets/qvm.ts";
import type { QvmDataImage, QvmImage } from "../assets/qvm.ts";
import { CommonError } from "../core/common-error.ts";
import type { HunkAllocation } from "../core/hunk.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import { evaluateQvmBinary, evaluateQvmBranch, evaluateQvmUnary } from "./operations.ts";
import { QvmMemory } from "./memory.ts";
import type { VmRegistration } from "./registry.ts";
import { QvmSymbols } from "./symbols.ts";
import type { QvmSymbolLoadOptions } from "./symbols.ts";

export type QvmArguments = readonly [
  number, number, number, number, number, number, number, number, number, number,
];

export interface QvmSyscall {
  /** Live little-endian words: syscall number, followed by its arguments. */
  readonly words: DataView;
  readonly memory: Uint8Array;
  /** Recursive entry is valid only while this callback owns the suspended frame. */
  invoke(args: QvmArguments): Promise<number>;
}

export type QvmSystemCall = (call: QvmSyscall) => number | Promise<number>;

class Operands {
  private readonly cells: (number | undefined)[] = new Array<number | undefined>(256);
  private depth = 0;

  reserve(): void {
    if (this.depth === 255) throw new Error("QVM operand stack overflow");
    this.depth++;
  }

  push(word: number): void { this.reserve(); this.cells[this.depth] = word; }

  peek(): number {
    const word = this.cells[this.depth];
    if (word === undefined) throw new Error("QVM reads an uninitialized operand");
    return word;
  }

  set(word: number): void {
    this.cells[this.depth] = word;
  }

  pop(): number { const word = this.peek(); this.drop(); return word; }

  drop(): void {
    if (this.depth === 0) throw new Error("QVM operand stack underflow");
    this.depth--;
  }

  complementPrevious(): void {
    // This is the pinned interpreter's OP_BCOM, not the JIT's unary operation.
    if (this.depth === 0) throw new Error("QVM operand stack underflow");
    this.cells[this.depth - 1] = ~this.peek();
  }

  result(): number {
    if (this.depth !== 1) throw new CommonError("drop", `Interpreter error: opStack = ${this.depth}`);
    return this.peek();
  }
}

interface Invocation { readonly operands: Operands }
interface SyscallScope {
  open: boolean;
  pending: Promise<void> | null;
  failure: { readonly error: unknown } | null;
}

function signedWord(value: number): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError("QVM host value must be a signed 32-bit integer");
  }
  return value | 0;
}

/** External-mod bytecode owner. Retail game modules remain direct TypeScript. */
export class QvmInterpreter {
  readonly memory: Uint8Array;
  readonly symbols: QvmSymbols;
  callLevel = 0;
  private readonly addressSpace: QvmMemory;
  private readonly data: DataView;
  private readonly code: Int32Array;
  private readonly instructionPointers: Int32Array;
  private readonly allocations: readonly HunkAllocation[];
  private readonly source: string;
  private readonly dataMask: number;
  private programStack: number;
  private active: Invocation | null = null;
  private rootActive = false;
  private breaks = 0;

  constructor(image: QvmImage, private readonly systemCall: QvmSystemCall,
    profile: HunkAccountingProfile = { kind: "unaccounted" },
    private readonly registration: VmRegistration | null = null,
  ) {
    this.source = image.source;
    const allocations: HunkAllocation[] = [];
    const allocate = (source: string, bytes: number, resource = image.source): Uint8Array => {
      if (profile.kind === "unaccounted") return new Uint8Array(bytes);
      const allocation = profile.accounting.reserve(source, resource, bytes, "high");
      allocations.push(allocation);
      return allocation.bytes;
    };
    this.memory = allocate("VM_Create:dataBase", image.allocatedDataLength);
    registration?.bindData(this.memory);
    this.addressSpace = new QvmMemory(this.memory);
    this.memory.set(image.initializedData);
    this.data = new DataView(this.memory.buffer, this.memory.byteOffset, this.memory.byteLength);
    this.dataMask = image.dataMask;
    this.programStack = this.memory.length;
    // Source preparation expands each code byte to an int slot. Operand tails
    // and alignment slots remain zero, and return PCs address these slots too.
    registration?.bindInstructionPointersLength(image.instructions.length * 4);
    const pointers = allocate("VM_Create:instructionPointers", image.instructions.length * 4);
    this.instructionPointers = new Int32Array(pointers.buffer, pointers.byteOffset, image.instructions.length);
    registration?.bindCodeLength(image.codeLength);
    const code = allocate("VM_PrepareInterpreter", image.codeLength * 4);
    this.code = new Int32Array(code.buffer, code.byteOffset, image.codeLength);
    this.allocations = allocations;
    this.symbols = new QvmSymbols(this.instructionPointers,
      (bytes, resource) => allocate("VM_LoadSymbols", bytes, resource), () => this.live());
    for (const [index, instruction] of image.instructions.entries()) this.instructionPointers[index] = instruction.byteOffset;
    for (const instruction of image.instructions) {
      this.code[instruction.byteOffset] = instruction.opcode;
      if (instruction.operandWidth !== 0) {
        this.code[instruction.byteOffset + 1] =
          instruction.opcode >= QvmOpcode.OP_EQ && instruction.opcode <= QvmOpcode.OP_GEF
            ? this.targetPC(instruction.operand) : instruction.operand;
      }
    }
    registration?.bindInterpreter(this);
  }

  get breakCount(): number { return this.breaks; }
  get codeLength(): number { this.live(); return this.code.length; }
  get instructionPointersLength(): number { this.live(); return this.instructionPointers.byteLength; }

  indent(): string {
    if (!Number.isInteger(this.callLevel) || this.callLevel < 0) throw new RangeError("VM indentation requires a nonnegative call level");
    return " ".repeat(2 * Math.min(this.callLevel, 20));
  }

  stackTrace(programCounter: number, programStack: number,
    print: (text: string) => void = text => { this.registration?.print(text); },
  ): void {
    this.live();
    let count = 0;
    do {
      print(`${this.symbols.valueToSymbol(programCounter)}\n`);
      programStack = this.readWord(programStack + 4);
      programCounter = this.readWord(programStack);
    } while (programCounter !== -1 && ++count < 32);
  }

  loadSymbols(options: QvmSymbolLoadOptions): void { this.symbols.load(options); }

  private live(): void {
    for (const allocation of this.allocations) void allocation.bytes;
  }

  pointer(word: number): Uint8Array | null {
    this.live();
    return this.addressSpace.pointer(word);
  }

  restart(image: QvmDataImage): void {
    if (this.rootActive) throw new Error("Cannot restart an active QVM");
    this.live();
    if (image.allocatedDataLength > this.memory.length) throw new Error("QVM restart would exceed its original allocation");
    this.memory.fill(0, 0, image.allocatedDataLength);
    this.memory.set(image.initializedData);
  }

  async invoke(args: QvmArguments): Promise<number> {
    if (this.rootActive) throw new Error("QVM is already active; recursive calls belong to the current syscall");
    this.live();
    this.rootActive = true;
    try { return await this.execute(args); }
    finally { this.rootActive = false; }
  }

  private range(address: number, length: number): void {
    if (address < 0 || address > this.memory.length - length) {
      throw new RangeError(`${this.source}: QVM memory access ${address}+${length} exceeds allocation`);
    }
  }

  private stack(address: number): number {
    this.range(address, 0);
    if (address % 4 !== 0) throw new Error("QVM program stack is misaligned");
    return address;
  }

  private readWord(address: number): number {
    this.range(address, 4);
    return this.data.getInt32(address, true);
  }

  private writeWord(address: number, word: number): void {
    this.range(address, 4);
    this.data.setInt32(address, word, true);
  }

  private targetPC(index: number): number {
    const pc = this.instructionPointers[index];
    if (pc === undefined) throw new Error(`${this.source}: invalid QVM instruction index ${index}`);
    return pc;
  }

  private codeWord(pc: number): number {
    const word = this.code[pc];
    if (word === undefined) throw new Error(`${this.source}: invalid QVM byte PC ${pc}`);
    return word;
  }

  private trap(frame: Invocation, sp: number): number | Promise<number> {
    const scope: SyscallScope = { open: true, pending: null, failure: null };
    const complete = (value: number): number | Promise<number> => {
      scope.open = false;
      const checked = (): number => {
        if (scope.failure !== null) throw scope.failure.error;
        this.live();
        return signedWord(value);
      };
      return scope.pending === null ? checked() : scope.pending.then(checked);
    };
    const failed = (error: unknown): never | Promise<number> => {
      scope.open = false;
      if (scope.pending !== null) return scope.pending.then(() => { throw error; });
      throw error;
    };
    const invoke = (args: QvmArguments): Promise<number> => {
      if (!scope.open || scope.pending !== null || this.active !== frame) {
        return Promise.reject(new Error("QVM recursive call requires the active, unoccupied syscall"));
      }
      const child = this.execute(args);
      scope.pending = child.then(
        () => { scope.pending = null; },
        (error: unknown) => { scope.pending = null; scope.failure = { error }; },
      );
      return child;
    };
    try {
      this.range(sp + 4, 4);
      const result = this.systemCall({
        words: new DataView(this.memory.buffer, this.memory.byteOffset + sp + 4, this.memory.byteLength - sp - 4),
        memory: this.memory, invoke,
      });
      return typeof result === "number" ? complete(result) : result.then(complete, failed);
    } catch (error) { return failed(error); }
  }

  private async execute(args: QvmArguments): Promise<number> {
    for (const word of args) signedWord(word);
    this.registration?.printCall(args[0]);
    const entryStack = this.programStack;
    let sp = this.stack(entryStack - 48);
    const previous = this.active;
    const frame: Invocation = { operands: new Operands() };
    const operands = frame.operands;
    this.active = frame;
    try {
      this.writeWord(sp, -1);
      this.writeWord(sp + 4, 0);
      args.forEach((word, index) => this.writeWord(sp + 8 + index * 4, word));
      this.callLevel = 0;
      this.registration?.debug(0);
      let pc = 0;
      for (;;) {
        const opcode = this.codeWord(pc++);
        switch (opcode) {
          case QvmOpcode.OP_UNDEF: case QvmOpcode.OP_IGNORE: break;
          case QvmOpcode.OP_BREAK: this.breaks = (this.breaks + 1) | 0; break;
          case QvmOpcode.OP_CONST: operands.push(this.codeWord(pc)); pc += 4; break;
          case QvmOpcode.OP_LOCAL: operands.push((sp + this.codeWord(pc)) | 0); pc += 4; break;
          case QvmOpcode.OP_PUSH: operands.reserve(); break;
          case QvmOpcode.OP_POP: operands.drop(); break;
          case QvmOpcode.OP_ENTER: sp = this.stack(sp - this.codeWord(pc)); pc += 4; break;
          case QvmOpcode.OP_LEAVE: {
            sp = this.stack(sp + this.codeWord(pc));
            const target = this.readWord(sp);
            if (target === -1) return operands.result();
            pc = target;
            break;
          }
          case QvmOpcode.OP_CALL: {
            this.writeWord(sp, pc);
            const target = operands.pop();
            if (target >= 0) pc = this.targetPC(target);
            else {
              this.programStack = sp - 4;
              this.writeWord(sp + 4, -1 - target);
              const result = this.trap(frame, sp);
              operands.push(typeof result === "number" ? result : await result);
              pc = this.readWord(sp);
            }
            break;
          }
          case QvmOpcode.OP_JUMP: pc = this.targetPC(operands.pop()); break;
          case QvmOpcode.OP_LOAD1: {
            const address = operands.peek() & this.dataMask;
            operands.set(this.data.getUint8(address));
            break;
          }
          case QvmOpcode.OP_LOAD2: {
            const address = operands.peek() & this.dataMask;
            this.range(address, 2);
            operands.set(this.data.getUint16(address, true));
            break;
          }
          case QvmOpcode.OP_LOAD4: operands.set(this.readWord(operands.peek() & this.dataMask)); break;
          case QvmOpcode.OP_STORE1: {
            const value = operands.pop();
            this.data.setUint8(operands.pop() & this.dataMask, value);
            break;
          }
          case QvmOpcode.OP_STORE2: {
            const value = operands.pop();
            const address = operands.pop() & (this.dataMask & ~1);
            this.range(address, 2);
            this.data.setUint16(address, value, true);
            break;
          }
          case QvmOpcode.OP_STORE4: {
            const value = operands.pop();
            this.writeWord(operands.pop() & (this.dataMask & ~3), value);
            break;
          }
          case QvmOpcode.OP_ARG: this.writeWord(sp + this.codeWord(pc++), operands.pop()); break;
          case QvmOpcode.OP_BLOCK_COPY: {
            const source = operands.pop() & this.dataMask;
            const destination = operands.pop() & this.dataMask;
            let count = ((source + this.codeWord(pc)) & this.dataMask) - source;
            pc += 4;
            count = ((destination + count) & this.dataMask) - destination;
            if ((source | destination | count) & 3) throw new CommonError("drop", "OP_BLOCK_COPY not dword aligned");
            for (let word = (count >> 2) - 1; word >= 0; word--) {
              this.writeWord(destination + word * 4, this.readWord(source + word * 4));
            }
            break;
          }
          case QvmOpcode.OP_BCOM: operands.complementPrevious(); break;
          case QvmOpcode.OP_SEX8: case QvmOpcode.OP_SEX16: case QvmOpcode.OP_NEGI:
          case QvmOpcode.OP_NEGF: case QvmOpcode.OP_CVIF: case QvmOpcode.OP_CVFI:
            operands.set(evaluateQvmUnary(opcode, operands.peek()));
            break;
          case QvmOpcode.OP_ADD: case QvmOpcode.OP_SUB: case QvmOpcode.OP_DIVI: case QvmOpcode.OP_DIVU:
          case QvmOpcode.OP_MODI: case QvmOpcode.OP_MODU: case QvmOpcode.OP_MULI: case QvmOpcode.OP_MULU:
          case QvmOpcode.OP_BAND: case QvmOpcode.OP_BOR: case QvmOpcode.OP_BXOR:
          case QvmOpcode.OP_LSH: case QvmOpcode.OP_RSHI: case QvmOpcode.OP_RSHU:
          case QvmOpcode.OP_ADDF: case QvmOpcode.OP_SUBF: case QvmOpcode.OP_DIVF: case QvmOpcode.OP_MULF: {
            const right = operands.pop();
            operands.set(evaluateQvmBinary(opcode, operands.peek(), right));
            break;
          }
          case QvmOpcode.OP_EQ: case QvmOpcode.OP_NE:
          case QvmOpcode.OP_LTI: case QvmOpcode.OP_LEI: case QvmOpcode.OP_GTI: case QvmOpcode.OP_GEI:
          case QvmOpcode.OP_LTU: case QvmOpcode.OP_LEU: case QvmOpcode.OP_GTU: case QvmOpcode.OP_GEU:
          case QvmOpcode.OP_EQF: case QvmOpcode.OP_NEF: case QvmOpcode.OP_LTF:
          case QvmOpcode.OP_LEF: case QvmOpcode.OP_GTF: case QvmOpcode.OP_GEF: {
            const right = operands.pop();
            const left = operands.pop();
            const target = this.codeWord(pc);
            pc = evaluateQvmBranch(opcode, left, right) ? target : pc + 4;
            break;
          }
          // The release interpreter has no default trap. A return into an
          // operand slot can therefore encounter a non-opcode integer as a nop.
          default: break;
        }
      }
    } finally {
      this.programStack = entryStack;
      this.active = previous;
    }
  }
}
