/*
 * Fuzzy weight configuration translated from id Software's
 * code/botlib/be_ai_weight.c and be_ai_weight.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
  ScriptSourceReader,
  type ScriptPreprocessorOptions,
} from "../script/preprocessor.ts";
import type { BotScriptReader } from "./script-sources.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";
import {
  NumberFlag,
  scriptNumberSubtypeName,
  ScriptLanguageError,
  type ScriptDiagnostic,
  type ScriptToken,
  type SourceLocation,
} from "../script/lexer.ts";

export const MAX_FUZZY_WEIGHTS = 128;
export const MAX_CACHED_WEIGHT_CONFIGS = 128;
export const MAX_INVENTORY_VALUE = 999_999;

const CACHED_FILENAME_LENGTH = 63;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const UINT32_MAX = 0xffff_ffff;
const WEIGHT_CONFIG_BYTES = 1092;
const WEIGHT_FILENAME_OFFSET = 1028;
const FUZZY_SEPARATOR_BYTES = 32;

export interface BotRandom {
  /** Host rand result. The botlib profile masks this value to 15 bits. */
  nextInt(): number;
}

export interface WeightConfigStoreOptions {
  readonly debug?: { readonly milliseconds: () => number; readonly developer: () => boolean };
  readonly memory?: BotMemory;
  readonly reloadCharacters?: boolean | (() => boolean);
  readonly print?: (severity: 1 | 2 | 3 | 4, text: string) => undefined;
  readonly maxCachedConfigs?: number;
  readonly preprocessor?: ScriptPreprocessorOptions;
}

export type WeightInventory = readonly number[] | ((index: number) => number);

export interface WeightConfig {
  readonly path: string;
  readonly weightCount: number;
  readonly names: readonly string[];
  readonly maxInventoryIndex: number;
  readonly diagnostics: readonly ScriptDiagnostic[];
  find(name: string): number;
  evaluate(weightIndex: number, inventory: WeightInventory): number;
  evaluateUndecided(weightIndex: number, inventory: WeightInventory, random: BotRandom): number;
  scaleWeight(name: string, scale: number): void;
  scaleBalanceRange(scale: number): void;
  evolve(random: BotRandom): void;
  /** Mutates this output in source order and does not roll back earlier changes on an error. */
  interbreedFrom(parent1: WeightConfig, parent2: WeightConfig, report?: (message: string) => void): readonly string[];
}

type SeparatorDecision =
  | { readonly kind: "leaf"; readonly leaf: FuzzySeparator }
  | { readonly kind: "branch"; readonly children: FuzzySeparator };

type WeightPointer =
  | { readonly kind: "name"; readonly allocation: BotMemoryAllocation }
  | { readonly kind: "separator"; readonly separator: FuzzySeparator };

function allocationView(allocation: BotMemoryAllocation): DataView {
  const bytes = allocation.bytes;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function terminatedBytes(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}

function stringBytes(text: string): Uint8Array {
  const end = text.indexOf("\0"), length = end < 0 ? text.length : end;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const byte = text.charCodeAt(index);
    if (byte > 255) throw new RangeError("fuzzy weight strings require source byte-valued characters");
    bytes[index] = byte;
  }
  return bytes;
}

/** Release32 pointer words are nonzero IDs scoped to this store, not native addresses. */
class WeightHeap {
  private readonly pointers = new Map<number, WeightPointer>();
  private nextPointer = 1;

  constructor(readonly memory: BotMemory) {}

  allocateName(name: string): number {
    const encoded = stringBytes(name);
    const allocation = this.memory.allocate(encoded.length + 1, "heap", true);
    allocation.bytes.set(encoded);
    const pointer = this.pointer();
    this.pointers.set(pointer, { kind: "name", allocation });
    return pointer;
  }

  name(pointer: number): string {
    const record = this.pointers.get(pointer);
    if (record?.kind !== "name") throw new Error(`invalid fuzzy weight name pointer ${pointer}`);
    let name = "";
    for (const byte of terminatedBytes(record.allocation.bytes)) name += String.fromCharCode(byte);
    return name;
  }

  freeName(pointer: number): void {
    const record = this.pointers.get(pointer);
    if (record?.kind !== "name") throw new Error(`invalid fuzzy weight name pointer ${pointer}`);
    this.memory.free(record.allocation);
    this.pointers.delete(pointer);
  }

  allocateSeparator(): FuzzySeparator {
    const allocation = this.memory.allocate(FUZZY_SEPARATOR_BYTES, "heap", true);
    const separator = new FuzzySeparator(this, allocation, this.pointer());
    this.pointers.set(separator.pointer, { kind: "separator", separator });
    return separator;
  }

  separator(pointer: number): FuzzySeparator | null {
    if (pointer === 0) return null;
    const record = this.pointers.get(pointer);
    if (record?.kind !== "separator") throw new Error(`invalid fuzzy separator pointer ${pointer}`);
    return record.separator;
  }

  freeSeparator(separator: FuzzySeparator): void {
    this.memory.free(separator.allocation);
    this.pointers.delete(separator.pointer);
  }

  private pointer(): number {
    if (this.nextPointer > UINT32_MAX) throw new RangeError("fuzzy weight pointer IDs exhausted");
    return this.nextPointer++;
  }
}

class FuzzySeparator {
  constructor(
    private readonly heap: WeightHeap,
    readonly allocation: BotMemoryAllocation,
    readonly pointer: number,
  ) {}

  private get view(): DataView { return allocationView(this.allocation); }
  get inventoryIndex(): number { return this.view.getInt32(0, true); }
  set inventoryIndex(value: number) { this.view.setInt32(0, value, true); }
  get threshold(): number { return this.view.getInt32(4, true); }
  set threshold(value: number) { this.view.setInt32(4, value, true); }
  get balanced(): boolean { return this.view.getInt32(8, true) === 1; }
  set balanced(value: boolean) { this.view.setInt32(8, value ? 1 : 0, true); }
  get weight(): number { return this.view.getFloat32(12, true); }
  set weight(value: number) { this.view.setFloat32(12, value, true); }
  get minWeight(): number { return this.view.getFloat32(16, true); }
  set minWeight(value: number) { this.view.setFloat32(16, value, true); }
  get maxWeight(): number { return this.view.getFloat32(20, true); }
  set maxWeight(value: number) { this.view.setFloat32(20, value, true); }
  get child(): FuzzySeparator | null { return this.heap.separator(this.view.getUint32(24, true)); }
  set child(value: FuzzySeparator | null) { this.view.setUint32(24, value?.pointer ?? 0, true); }
  get next(): FuzzySeparator | null { return this.heap.separator(this.view.getUint32(28, true)); }
  set next(value: FuzzySeparator | null) { this.view.setUint32(28, value?.pointer ?? 0, true); }
  get decision(): SeparatorDecision {
    const children = this.child;
    return children === null ? { kind: "leaf", leaf: this } : { kind: "branch", children };
  }

  free(): void { this.heap.freeSeparator(this); }
}

function freeSeparators(separator: FuzzySeparator | null): void {
  if (separator === null) return;
  freeSeparators(separator.child);
  freeSeparators(separator.next);
  separator.free();
}

export class WeightConfigError extends Error {
  readonly diagnostic: ScriptDiagnostic;
  readonly diagnostics: readonly ScriptDiagnostic[];

  constructor(diagnostic: ScriptDiagnostic, diagnostics: readonly ScriptDiagnostic[]) {
    super(`${diagnostic.location.path}:${diagnostic.location.line}:${diagnostic.location.column}: ${diagnostic.message}`);
    this.name = "WeightConfigError";
    this.diagnostic = diagnostic;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/** ReadWeightConfig returned NULL after an expected file or cache failure. */
export class WeightConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeightConfigLoadError";
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function frozenLocation(location: SourceLocation): SourceLocation {
  return Object.freeze({ path: location.path, line: location.line, column: location.column });
}

function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) {
    return false;
  }
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) {
      return false;
    }
  }
  return true;
}

class WeightParser {
  constructor(
    private readonly sourceLocation: () => SourceLocation,
    private readonly nextToken: () => ScriptToken | undefined,
    private readonly reported: ScriptDiagnostic[],
    private readonly heap: WeightHeap,
    private readonly config: OwnedWeightConfig,
    private readonly report: (diagnostic: ScriptDiagnostic) => undefined,
    private readonly isSourceFailure: (error: unknown) => boolean,
  ) {}

  parse(): OwnedWeightConfig {
    while (true) {
      const token = this.nextToken();
      if (token === undefined) {
        break;
      }
      if (token.text !== "weight") {
        this.fail(`invalid name ${token.text}\n`, token.location);
      }
      if (this.config.weightCount >= MAX_FUZZY_WEIGHTS) {
        this.warn("too many fuzzy weights\n", token.location);
        break;
      }
      const name = this.expectString();
      const weightIndex = this.config.weightCount;
      this.config.setName(weightIndex, name.value);
      const first = this.expectAny();
      let braced = false;
      let action = first;
      if (first.text === "{") {
        braced = true;
        action = this.expectAny();
      }
      let separators: FuzzySeparator;
      if (action.text === "switch") {
        separators = this.parseSwitch(action.location);
      } else if (action.text === "return") {
        separators = this.heap.allocateSeparator();
        separators.inventoryIndex = 0;
        separators.threshold = MAX_INVENTORY_VALUE;
        try {
          this.parseReturn(separators);
        } catch (error) {
          if (this.isSourceFailure(error)) separators.free();
          throw error;
        }
      } else {
        this.fail(`invalid name ${action.text}\n`, action.location);
      }
      this.config.setSeparators(weightIndex, separators);
      if (braced) {
        this.expectText("}");
      }
      this.config.weightCount = weightIndex + 1;
    }
    return this.config;
  }

  private parseSwitch(location: SourceLocation): FuzzySeparator {
    this.expectText("(");
    const inventoryIndex = this.expectInteger().integerValue | 0;
    this.expectText(")");
    this.expectText("{");

    let first: FuzzySeparator | null = null;
    let last: FuzzySeparator | null = null;
    let foundDefault = false;
    let freeOnError = true;
    try {
      let label = this.expectAny();
      while (true) {
        const isDefault = label.text === "default";
        if (!isDefault && label.text !== "case") {
          freeOnError = false;
          freeSeparators(first);
          this.fail(`invalid name ${label.text}\n`, label.location);
        }
        const separator = this.heap.allocateSeparator();
        separator.inventoryIndex = inventoryIndex;
        if (last === null) first = separator;
        else last.next = separator;
        last = separator;
        if (isDefault) {
          if (foundDefault) this.fail("switch already has a default\n", label.location);
          separator.threshold = MAX_INVENTORY_VALUE;
          foundDefault = true;
        } else {
          separator.threshold = this.expectInteger().integerValue | 0;
        }
        this.expectText(":");
        let action = this.expectAny();
        let braced = false;
        if (action.text === "{") {
          braced = true;
          action = this.expectAny();
        }
        if (action.text === "return") {
          this.parseReturn(separator);
        } else if (action.text === "switch") {
          separator.child = this.parseSwitch(action.location);
        } else {
          // This source return omits FreeFuzzySeperators_r for its local chain.
          freeOnError = false;
          this.fail(`invalid name ${action.text}\n`, action.location);
        }
        if (braced) this.expectText("}");
        label = this.expectAny();
        if (label.text === "}") break;
      }
      if (!foundDefault) {
        this.warn("switch without default\n", location);
        const separator = this.heap.allocateSeparator();
        separator.inventoryIndex = inventoryIndex;
        separator.threshold = MAX_INVENTORY_VALUE;
        if (last === null) first = separator;
        else last.next = separator;
      }
    } catch (error) {
      if (freeOnError && this.isSourceFailure(error)) {
        freeSeparators(first);
      }
      throw error;
    }
    if (first === null) throw new Error("fuzzy switch did not allocate a separator");
    return first;
  }

  private parseReturn(separator: FuzzySeparator): void {
    const first = this.nextToken();
    if (first?.text === "balance") {
      separator.balanced = true;
      this.expectText("(");
      separator.weight = this.readValue();
      this.expectText(",");
      separator.minWeight = this.readValue();
      this.expectText(",");
      separator.maxWeight = this.readValue();
      this.expectText(")");
    } else {
      separator.balanced = false;
      separator.weight = first === undefined ? this.readValue() : this.valueFromFirstToken(first);
      separator.minWeight = separator.weight;
      separator.maxWeight = separator.weight;
    }
    this.expectText(";");
  }

  private readValue(): number {
    return this.valueFromFirstToken(this.expectAny());
  }

  private valueFromFirstToken(first: ScriptToken): number {
    let token = first;
    if (token.text === "-") {
      this.warn("negative value set to zero\n", token.location);
      token = this.expectAny();
      if (token.kind !== "number") this.fail(`expected a number, found ${token.text}`, token.location);
    }
    if (token.kind !== "number") {
      this.fail(`invalid return value ${token.text}\n`, token.location);
    }
    if (!Number.isFinite(token.floatValue)) {
      this.fail("return value exceeds finite float32 range", token.location);
    }
    const value = Math.fround(token.floatValue);
    if (!Number.isFinite(value)) {
      this.fail("return value exceeds finite float32 range", token.location);
    }
    return value;
  }

  private expectInteger(): Extract<ScriptToken, { readonly kind: "number" }> {
    const token = this.expectAny();
    if (token.kind !== "number") this.fail(`expected a number, found ${token.text}`, token.location);
    if ((token.flags & NumberFlag.Integer) === 0) scriptNumberSubtypeName(NumberFlag.Integer);
    return token;
  }

  private expectString(): Extract<ScriptToken, { readonly kind: "string" }> {
    const token = this.expectAny();
    if (token.kind !== "string") {
      this.fail(`expected a string, found ${token.text}`, token.location);
    }
    return token;
  }

  private expectText(text: string): ScriptToken {
    const token = this.nextToken();
    if (token === undefined) this.fail(`couldn't find expected ${text}`, this.sourceLocation());
    if (token.text !== text) {
      this.fail(`expected ${text}, found ${token.text}`, token.location);
    }
    return token;
  }

  private expectAny(): ScriptToken {
    const token = this.nextToken();
    if (token === undefined) {
      this.fail("couldn't read expected token", this.sourceLocation());
    }
    return token;
  }

  private warn(message: string, location: SourceLocation): void {
    const diagnostic: ScriptDiagnostic = Object.freeze({ severity: "warning", message,
      location: frozenLocation({ ...this.sourceLocation(), column: location.column }) });
    this.reported.push(diagnostic);
    this.report(diagnostic);
  }

  private fail(message: string, location: SourceLocation): never {
    const diagnostic: ScriptDiagnostic = Object.freeze({
      severity: "error",
      message,
      location: frozenLocation({ ...this.sourceLocation(), column: location.column }),
    });
    this.reported.push(diagnostic);
    this.report(diagnostic);
    throw new WeightConfigError(diagnostic, this.reported);
  }
}

function inventoryValue(inventory: WeightInventory, index: number): number {
  const value = typeof inventory === "function" ? inventory(index) : inventory[index];
  if (value === undefined) {
    throw new RangeError(`inventory index ${index} is outside ${inventory.length} entries`);
  }
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new RangeError(`inventory value at index ${index} must be an int32`);
  }
  return value;
}

function sourceUnitRandom(random: BotRandom): number {
  const raw = random.nextInt();
  if (!Number.isInteger(raw) || raw < INT32_MIN || raw > UINT32_MAX) {
    throw new RangeError("bot random nextInt must return an int32 or uint32 value");
  }
  return Math.fround((raw & 0x7fff) / Math.fround(0x7fff));
}

function leafValue(separator: FuzzySeparator, inventory: WeightInventory): number {
  const decision = separator.decision;
  return decision.kind === "branch"
    ? evaluateSeparators(decision.children, inventory)
    : separator.weight;
}

function undecidedLeafValue(separator: FuzzySeparator, inventory: WeightInventory, random: BotRandom): number {
  const decision = separator.decision;
  if (decision.kind === "branch") {
    return evaluateUndecidedSeparators(decision.children, inventory, random);
  }
  const range = Math.fround(separator.maxWeight - separator.minWeight);
  return Math.fround(separator.minWeight + Math.fround(sourceUnitRandom(random) * range));
}

function sourceInterpolationScale(inventory: number, lower: number, upper: number): number {
  const numerator = (inventory - lower) | 0;
  const denominator = (upper - lower) | 0;
  if (denominator === 0) {
    throw new RangeError("fuzzy separator thresholds produce division by zero");
  }
  return Math.fround(Math.trunc(numerator / denominator));
}

function interpolate(scale: number, first: number, second: number): number {
  const firstPart = Math.fround(scale * first);
  const inverse = Math.fround(Math.fround(1) - scale);
  const secondPart = Math.fround(inverse * second);
  return Math.fround(firstPart + secondPart);
}

function evaluateSeparators(first: FuzzySeparator, inventory: WeightInventory): number {
  let separator = first;
  while (true) {
    if (inventoryValue(inventory, separator.inventoryIndex) < separator.threshold) {
      return Math.fround(leafValue(separator, inventory));
    }
    const next = separator.next;
    if (next === null) {
      return separator.weight;
    }
    if (inventoryValue(inventory, separator.inventoryIndex) < next.threshold) {
      const first = leafValue(separator, inventory);
      const second = leafValue(next, inventory);
      return interpolate(sourceInterpolationScale(
        inventoryValue(inventory, separator.inventoryIndex), separator.threshold, next.threshold,
      ), first, second);
    }
    separator = next;
  }
}

function evaluateUndecidedSeparators(
  first: FuzzySeparator,
  inventory: WeightInventory,
  random: BotRandom,
): number {
  let separator = first;
  while (true) {
    if (inventoryValue(inventory, separator.inventoryIndex) < separator.threshold) {
      return undecidedLeafValue(separator, inventory, random);
    }
    const next = separator.next;
    if (next === null) {
      return separator.weight;
    }
    if (inventoryValue(inventory, separator.inventoryIndex) < next.threshold) {
      const first = undecidedLeafValue(separator, inventory, random);
      const decision = next.decision;
      const second = decision.kind === "branch"
        ? evaluateSeparators(decision.children, inventory)
        : undecidedLeafValue(next, inventory, random);
      return interpolate(sourceInterpolationScale(
        inventoryValue(inventory, separator.inventoryIndex), separator.threshold, next.threshold,
      ), first, second);
    }
    separator = next;
  }
}

function visitLeaves(first: FuzzySeparator, visit: (leaf: FuzzySeparator) => void): void {
  let separator: FuzzySeparator | null = first;
  while (separator !== null) {
    const decision = separator.decision;
    if (decision.kind === "branch") {
      visitLeaves(decision.children, visit);
    } else {
      visit(decision.leaf);
    }
    separator = separator.next;
  }
}

function interbreedSeparators(
  parent1: FuzzySeparator,
  parent2: FuzzySeparator,
  output: FuzzySeparator,
  report: (message: string) => void,
): boolean {
  let first = parent1;
  let second = parent2;
  let destination = output;
  while (true) {
    const decision = first.decision;
    if (decision.kind === "branch") {
      const secondDecision = second.decision;
      const outputDecision = destination.decision;
      if (secondDecision.kind !== "branch" || outputDecision.kind !== "branch") {
        report("cannot interbreed weight configs, unequal child");
        return false;
      }
      if (!interbreedSeparators(secondDecision.children, secondDecision.children, outputDecision.children, report)) {
        return false;
      }
    } else if (first.balanced) {
      if (!second.balanced || !destination.balanced) {
        report("cannot interbreed weight configs, unequal balance");
        return false;
      }
      destination.weight = Math.fround(Math.fround(first.weight + second.weight) / Math.fround(2));
      if (destination.weight > destination.maxWeight) {
        destination.maxWeight = destination.weight;
      }
      if (destination.weight > destination.minWeight) {
        destination.minWeight = destination.weight;
      }
    }
    const next = first.next;
    if (next === null) return true;
    const secondNext = second.next;
    const outputNext = destination.next;
    if (secondNext === null || outputNext === null) {
      report("cannot interbreed weight configs, unequal next");
      return false;
    }
    first = next;
    second = secondNext;
    destination = outputNext;
  }
}

class OwnedWeightConfig implements WeightConfig {
  private disposed = false;

  constructor(
    readonly path: string,
    private readonly heap: WeightHeap,
    private readonly allocation: BotMemoryAllocation,
    private readonly reported: readonly ScriptDiagnostic[],
    filename: string,
  ) {
    const bytes = this.allocation.bytes.subarray(WEIGHT_FILENAME_OFFSET);
    bytes.set(stringBytes(filename).subarray(0, CACHED_FILENAME_LENGTH));
  }

  private get view(): DataView { return allocationView(this.allocation); }

  get weightCount(): number {
    this.requireOpen();
    const count = this.view.getInt32(0, true);
    if (count < 0 || count > MAX_FUZZY_WEIGHTS) throw new RangeError(`invalid fuzzy weight count ${count}`);
    return count;
  }

  set weightCount(count: number) { this.view.setInt32(0, count, true); }

  get diagnostics(): readonly ScriptDiagnostic[] { return Object.freeze([...this.reported]); }

  get maxInventoryIndex(): number {
    const maximum = (first: FuzzySeparator): number => {
      let result = -1;
      let separator: FuzzySeparator | null = first;
      while (separator !== null) {
        result = Math.max(result, separator.inventoryIndex);
        const child = separator.child;
        if (child !== null) result = Math.max(result, maximum(child));
        separator = separator.next;
      }
      return result;
    };
    let result = -1;
    for (let index = 0; index < this.weightCount; index++) result = Math.max(result, maximum(this.separators(index)));
    return result;
  }

  get names(): readonly string[] {
    const names: string[] = [];
    for (let index = 0; index < this.weightCount; index++) names.push(this.name(index));
    return Object.freeze(names);
  }

  matchesFilename(filename: Uint8Array): boolean {
    return equalBytes(terminatedBytes(this.allocation.bytes.subarray(WEIGHT_FILENAME_OFFSET)), terminatedBytes(filename));
  }

  setName(index: number, name: string): void {
    const pointer = this.heap.allocateName(name);
    this.view.setUint32(4 + index * 8, pointer, true);
  }

  setSeparators(index: number, separator: FuzzySeparator): void {
    this.view.setUint32(8 + index * 8, separator.pointer, true);
  }

  find(name: string): number {
    const end = name.indexOf("\0"), query = end < 0 ? name : name.slice(0, end);
    for (let index = 0; index < this.weightCount; index++) {
      if (this.name(index) === query) return index;
    }
    return -1;
  }

  evaluate(weightIndex: number, inventory: WeightInventory): number {
    this.requireOpen();
    return evaluateSeparators(this.separators(weightIndex), inventory);
  }

  evaluateUndecided(weightIndex: number, inventory: WeightInventory, random: BotRandom): number {
    this.requireOpen();
    return evaluateUndecidedSeparators(this.separators(weightIndex), inventory, random);
  }

  scaleWeight(name: string, scale: number): void {
    this.requireOpen();
    let storedScale = Math.fround(scale);
    if (storedScale < 0) {
      storedScale = 0;
    } else if (storedScale > 1) {
      storedScale = 1;
    }
    const index = this.find(name);
    if (index < 0) {
      return;
    }
    visitLeaves(this.separators(index), (leaf) => {
      if (!leaf.balanced) {
        return;
      }
      const sum = Math.fround(leaf.maxWeight + leaf.minWeight);
      leaf.weight = Math.fround(sum * storedScale);
      if (leaf.weight < leaf.minWeight) {
        leaf.weight = leaf.minWeight;
      } else if (leaf.weight > leaf.maxWeight) {
        leaf.weight = leaf.maxWeight;
      }
    });
  }

  scaleBalanceRange(scale: number): void {
    this.requireOpen();
    let storedScale = Math.fround(scale);
    if (storedScale < 0) {
      storedScale = 0;
    } else if (storedScale > 100) {
      storedScale = 100;
    }
    for (let index = 0; index < this.weightCount; index++) {
      visitLeaves(this.separators(index), (leaf) => {
        if (!leaf.balanced) {
          return;
        }
        const midpoint = Math.fround(Math.fround(leaf.minWeight + leaf.maxWeight) * Math.fround(0.5));
        leaf.maxWeight = Math.fround(midpoint
          + Math.fround(Math.fround(leaf.maxWeight - midpoint) * storedScale));
        leaf.minWeight = Math.fround(midpoint
          + Math.fround(Math.fround(leaf.minWeight - midpoint) * storedScale));
        if (leaf.maxWeight < leaf.minWeight) {
          leaf.maxWeight = leaf.minWeight;
        }
      });
    }
  }

  evolve(random: BotRandom): void {
    this.requireOpen();
    for (let index = 0; index < this.weightCount; index++) {
      visitLeaves(this.separators(index), (leaf) => {
        if (!leaf.balanced) {
          return;
        }
        const leap = sourceUnitRandom(random) < 0.01;
        const centered = 2 * (sourceUnitRandom(random) - 0.5);
        const range = Math.fround(leaf.maxWeight - leaf.minWeight);
        const delta = centered * range * (leap ? 1 : 0.5);
        leaf.weight = Math.fround(leaf.weight + delta);
        if (leaf.weight < leaf.minWeight) {
          leaf.minWeight = leaf.weight;
        } else if (leaf.weight > leaf.maxWeight) {
          leaf.maxWeight = leaf.weight;
        }
      });
    }
  }

  interbreedFrom(parent1: WeightConfig, parent2: WeightConfig, report?: (message: string) => void): readonly string[] {
    this.requireOpen();
    if (!(parent1 instanceof OwnedWeightConfig) || !(parent2 instanceof OwnedWeightConfig)) {
      throw new TypeError("interbreed parents must be weight configs from this module");
    }
    parent1.requireOpen();
    parent2.requireOpen();
    const errors: string[] = [];
    const reportError = (message: string): void => { errors.push(message); report?.(message); };
    if (parent1.weightCount !== parent2.weightCount || parent1.weightCount !== this.weightCount) {
      reportError("cannot interbreed weight configs, unequal numweights");
      return Object.freeze(errors);
    }
    for (let index = 0; index < parent1.weightCount; index++) {
      interbreedSeparators(parent1.separators(index), parent2.separators(index), this.separators(index), reportError);
    }
    return Object.freeze(errors);
  }

  free(): void {
    for (let index = 0; index < this.weightCount; index++) {
      freeSeparators(this.heap.separator(this.view.getUint32(8 + index * 8, true)));
      const namePointer = this.view.getUint32(4 + index * 8, true);
      if (namePointer !== 0) this.heap.freeName(namePointer);
    }
    this.heap.memory.free(this.allocation);
    this.disposed = true;
  }

  private name(index: number): string { return this.heap.name(this.view.getUint32(4 + index * 8, true)); }

  private separators(index: number): FuzzySeparator {
    if (!Number.isInteger(index)) {
      throw new RangeError("weight index must be an integer");
    }
    if (index < 0 || index >= this.weightCount) {
      throw new RangeError(`weight index ${index} is outside ${this.weightCount} entries`);
    }
    const separator = this.heap.separator(this.view.getUint32(8 + index * 8, true));
    if (separator === null) throw new Error(`weight ${index} has no fuzzy separator`);
    return separator;
  }

  private requireOpen(): void {
    if (this.disposed) {
      throw new Error(`weight config ${this.path} has been freed`);
    }
  }
}

export class WeightConfigStore {
  private readonly heap: WeightHeap;
  private readonly resolver: BotScriptReader;
  private readonly reloadCharacters: () => boolean;
  private readonly print: WeightConfigStoreOptions["print"];
  private readonly debug: WeightConfigStoreOptions["debug"];
  private readonly maxCachedConfigs: number;
  private readonly preprocessorOptions: ScriptPreprocessorOptions;
  private readonly cached: (OwnedWeightConfig | undefined)[] = [];
  private readonly owned = new Set<OwnedWeightConfig>();
  private generation = 0;

  constructor(resolver: BotScriptReader, options: WeightConfigStoreOptions = {}) {
    this.resolver = resolver;
    this.heap = new WeightHeap(options.memory ?? new BotMemory());
    const reloadCharacters = options.reloadCharacters ?? false;
    this.reloadCharacters = typeof reloadCharacters === "function" ? reloadCharacters : () => reloadCharacters;
    this.print = options.print;
    this.debug = options.debug;
    this.maxCachedConfigs = positiveInteger(
      options.maxCachedConfigs,
      MAX_CACHED_WEIGHT_CONFIGS,
      "maxCachedConfigs",
    );
    if (this.maxCachedConfigs > MAX_CACHED_WEIGHT_CONFIGS) {
      throw new RangeError(`maxCachedConfigs cannot exceed source limit ${MAX_CACHED_WEIGHT_CONFIGS}`);
    }
    this.preprocessorOptions = options.preprocessor ?? {};
  }

  load(path: string): WeightConfig {
    const startTime = this.debug?.milliseconds();
    const generation = this.generation;
    const reload = this.reloadCharacters();
    this.requireCurrent(generation, path);
    let available = 0;
    if (!reload) {
      const requestedFilename = stringBytes(path);
      available = -1;
      for (let index = 0; index < this.maxCachedConfigs; index++) {
        const config = this.cached[index];
        if (config === undefined) {
          if (available === -1) available = index;
          continue;
        }
        if (config.matchesFilename(requestedFilename)) return config;
      }
      if (available === -1) {
        this.print?.(3, `weightFileList was full trying to load ${path}\n`);
        throw new WeightConfigLoadError(`weight config cache is full at ${this.maxCachedConfigs} entries`);
      }
    }
    return this.readAndRetain(path, available, generation, startTime);
  }

  free(config: WeightConfig): void {
    if (!(config instanceof OwnedWeightConfig) || !this.owned.has(config)) {
      throw new Error("weight config is not owned by this store");
    }
    if (!this.reloadCharacters()) {
      return;
    }
    config.free();
    this.owned.delete(config);
  }

  shutdown(): void {
    this.generation++;
    for (let index = 0; index < this.maxCachedConfigs; index++) {
      const config = this.cached[index];
      if (config === undefined) continue;
      config.free();
      this.owned.delete(config);
      this.cached[index] = undefined;
    }
    this.cached.length = 0;
  }

  private readAndRetain(
    path: string,
    available: number,
    generation: number,
    startTime: number | undefined,
  ): OwnedWeightConfig {
    const config = this.read(path, generation);
    if (generation !== this.generation) {
      config.free();
      throw new Error(`weight config owner changed during synchronous source read: ${path}`);
    }
    this.owned.add(config);
    this.print?.(1, `loaded ${path}\n`);
    this.requireCurrent(generation, path);
    if (this.debug !== undefined && startTime !== undefined && this.debug.developer()) {
      this.requireCurrent(generation, path);
      const elapsed = (this.debug.milliseconds() - startTime) | 0;
      this.requireCurrent(generation, path);
      this.print?.(1, `weights loaded in ${elapsed} msec\n`);
    }
    this.requireCurrent(generation, path);
    const reload = this.reloadCharacters();
    this.requireCurrent(generation, path);
    if (!reload) this.cached[available] = config;
    return config;
  }

  private requireCurrent(generation: number, path: string): void {
    if (generation !== this.generation) {
      throw new Error(`weight config owner changed during synchronous source read: ${path}`);
    }
  }

  private report(diagnostic: ScriptDiagnostic, generation: number, path: string): undefined {
    this.requireCurrent(generation, path);
    this.print?.(diagnostic.severity === "warning" ? 2 : 3,
      `file ${diagnostic.location.path}, line ${diagnostic.location.line}: ${diagnostic.message}\n`);
    this.requireCurrent(generation, path);
    return undefined;
  }

  private read(path: string, generation: number): OwnedWeightConfig {
    const source = this.resolver.resolveRoot(path);
    this.requireCurrent(generation, path);
    if (source === undefined) {
      this.print?.(3, `counldn't load ${path}\n`);
      throw new WeightConfigLoadError(`could not load weight config ${path}`);
    }
    if (source.path.length === 0) {
      throw new Error("weight config resolver returned an empty canonical path");
    }
    const reported: ScriptDiagnostic[] = [];
    let callbackAborted = false;
    const invokeCallback = <T>(callback: () => T): T => {
      try { return callback(); }
      catch (error) { callbackAborted = true; throw error; }
    };
    const isSourceFailure = (error: unknown): boolean => !callbackAborted
      && (error instanceof WeightConfigError || error instanceof ScriptLanguageError);
    const report = (diagnostic: ScriptDiagnostic): undefined => invokeCallback(() => this.report(diagnostic, generation, path));
    const now = this.preprocessorOptions.now;
    const preprocessor = ScriptSourceReader.open(source, {
      resolve: request => invokeCallback(() => this.resolver.resolve(request)),
    }, {
      ...this.preprocessorOptions, globals: this.resolver.globals,
      ...(this.resolver.debugEval === undefined ? {} : { debugEval: (text: string) => invokeCallback(() => this.resolver.debugEval?.(text)) }),
      ...(now === undefined ? {} : { now: () => invokeCallback(now) }),
      report: diagnostic => {
        reported.push(diagnostic);
        invokeCallback(() => this.preprocessorOptions.report?.(diagnostic));
        report(diagnostic);
      },
    });
    this.requireCurrent(generation, path);
    const allocation = this.heap.memory.allocate(WEIGHT_CONFIG_BYTES, "heap", true);
    const config = new OwnedWeightConfig(source.path, this.heap, allocation, reported, path);
    const nextToken = (): ScriptToken | undefined => {
      this.requireCurrent(generation, path);
      let token: ScriptToken | undefined;
      try { token = preprocessor.next()?.token; }
      catch (error) {
        if (!preprocessor.isSourceFailure(error)) throw error;
      }
      this.requireCurrent(generation, path);
      return token;
    };
    try {
      new WeightParser(() => ({ path: preprocessor.currentScriptFilename, line: preprocessor.position.line, column: 1 }),
        nextToken, reported, this.heap, config,
        report, isSourceFailure).parse();
    } catch (error) {
      if (isSourceFailure(error)) {
        const reload = this.reloadCharacters();
        this.requireCurrent(generation, path);
        if (reload) config.free();
        preprocessor.dispose();
        if (error instanceof ScriptLanguageError) throw new WeightConfigError(error.diagnostic, error.diagnostics);
      }
      throw error;
    }
    preprocessor.dispose();
    return config;
  }
}
