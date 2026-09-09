/*
 * Per-instance console variables translated from Quake III Arena's cvar.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */

import { sourceCommandText } from "./text.ts";
import { CommonError } from "./common-error.ts";
import { infoSetValueForKey, infoSetValueForKeyBig } from "./info-string.ts";
import { nativeAtof, nativeAtoi } from "./native-numeric.ts";
import { float32ToBits } from "./numeric.ts";
import type { SourceZoneStrings, ZoneString } from "./zone-strings.ts";

export enum CvarFlag {
  None = 0,
  Archive = 1,
  UserInfo = 2,
  ServerInfo = 4,
  SystemInfo = 8,
  Init = 16,
  Latch = 32,
  ReadOnly = 64,
  UserCreated = 128,
  Temporary = 256,
  Cheat = 512,
  NoRestart = 1024,
}

export interface CvarRead {
  readonly name: string;
  readonly value: string;
  readonly resetValue: string;
  readonly latchedValue: string | undefined;
  readonly flags: number;
  readonly modified: boolean;
  readonly modificationCount: number;
  readonly numericValue: number;
  readonly integerValue: number;
}

export type CvarSnapshot = CvarRead;

export type CvarStringInput = string | ZoneString;

/** A cvar_t may be cleared, then have individual fields rewritten by a resumed call. */
export interface CvarReference extends Pick<CvarRead, "flags" | "modified" | "modificationCount" | "numericValue" | "integerValue"> {
  readonly nameString: ZoneString | null;
  readonly currentString: ZoneString | null;
  readonly resetString: ZoneString | null;
  readonly latchedString: ZoneString | null;
}

/** The caller-owned interpreted-module words populated by Cvar_Register/Update. */
export interface VmCvarRead {
  readonly value: string;
  readonly numericValue: number;
  readonly integerValue: number;
  readonly modificationCount: number;
}

export interface VmCvarWords extends VmCvarRead {
  writeInteger(value: number): void;
}

export interface VmCvar extends VmCvarWords {
  update(): void;
}

export interface RegisterableVmCvar extends VmCvar {
  register(name: string, defaultValue: string, flags?: number): void;
}

export class CvarVmStringError extends CommonError {
  readonly length: number;
  constructor(value: string) {
    super("drop", `Cvar_Update: src ${value} length ${value.length} exceeds MAX_CVAR_VALUE_STRING`);
    this.name = "CvarVmStringError";
    this.length = value.length;
  }
}

class OwnedVmCvarWords implements VmCvarWords {
  protected text = "";
  protected numeric = 0;
  protected integer = 0;
  protected count = 0;

  get value(): string { return this.text; }
  get numericValue(): number { return this.numeric; }
  get integerValue(): number { return this.integer; }
  get modificationCount(): number { return this.count; }

  writeInteger(value: number): void {
    if (!Number.isSafeInteger(value)) throw new RangeError("VM cvar integer write requires a safe integer");
    this.integer = value | 0;
  }
}

export function createVmCvarWords(): VmCvarWords {
  return new OwnedVmCvarWords();
}

class RegistryVmCvar extends OwnedVmCvarWords implements RegisterableVmCvar {
  private handle = 0;

  constructor(
    private readonly bind: (name: string, defaultValue: string, flags: number) => number,
    private readonly read: (handle: number) => CvarSnapshot | undefined,
  ) {
    super();
  }

  register(name: string, defaultValue: string, flags = CvarFlag.None): void {
    this.handle = this.bind(name, defaultValue, flags);
    this.count = -1;
    this.update();
  }

  update(): void {
    const source = this.read(this.handle);
    if (source === undefined || source.modificationCount === this.count) return;
    this.count = source.modificationCount;
    if (source.value.length > 255) throw new CvarVmStringError(source.value);
    this.text = source.value;
    this.numeric = source.numericValue;
    this.integer = source.integerValue;
  }
}

class CvarState implements CvarReference {
  next: CvarState | undefined;
  latchedString: ZoneString | null = null;
  modified = true;
  modificationCount = 1;

  constructor(
    readonly index: number,
    public nameString: ZoneString | null,
    public currentString: ZoneString | null,
    public resetString: ZoneString | null,
    public flags: number,
    public numericValue: number,
    public integerValue: number,
  ) {}

  get name(): string { return requiredString(this.nameString).value; }
  get value(): string { return requiredString(this.currentString).value; }
  get resetValue(): string { return requiredString(this.resetString).value; }
  get latchedValue(): string | undefined { return this.latchedString?.value; }
}

function requiredString(value: ZoneString | null): ZoneString {
  if (value === null) throw new RangeError("Undefined native NULL cvar string dereference");
  return value;
}

function inputValue(value: CvarStringInput): string {
  return typeof value === "string" ? value : value.value;
}

/** Cvar_FindVar uses NUL-terminated bytes and Q_stricmp's ASCII-only identity. */
function cvarNameKey(name: string): string {
  return sourceCommandText(name).replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
}

function hasFlag(flags: number, flag: CvarFlag): boolean {
  return (flags & flag) !== 0;
}

function numericValue(value: string): number {
  return Math.fround(nativeAtof(value));
}

/** C-locale %f rounds the exact binary32 fraction to six decimals, ties to even. */
function setValueText(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("Cvar_SetValue requires a finite float");
  if (value >= -2147483648 && value < 2147483648 && value === Math.trunc(value)) return String(value);
  const bits = float32ToBits(value);
  const exponent = (bits >>> 23) & 255;
  const fraction = bits & 0x7fffff;
  const significand = BigInt(exponent === 0 ? fraction : fraction + 0x800000);
  const shift = exponent === 0 ? -149 : exponent - 150;
  const scaled = significand * 1000000n;
  let rounded: bigint;
  if (shift >= 0) rounded = scaled << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift);
    const lower = scaled / divisor;
    const remainder = scaled % divisor;
    rounded = remainder * 2n > divisor || (remainder * 2n === divisor && lower % 2n !== 0n)
      ? lower + 1n : lower;
  }
  return `${value < 0 ? "-" : ""}${rounded / 1000000n}.${String(rounded % 1000000n).padStart(6, "0")}`;
}

function snapshot(state: CvarReference): CvarSnapshot {
  return Object.freeze({
    name: requiredString(state.nameString).value,
    value: requiredString(state.currentString).value,
    resetValue: requiredString(state.resetString).value,
    latchedValue: state.latchedString?.value,
    flags: state.flags,
    modified: state.modified,
    modificationCount: state.modificationCount,
    numericValue: state.numericValue,
    integerValue: state.integerValue,
  });
}

export class CvarRegistry {
  private readonly variables = new Map<string, CvarState>();
  private readonly indexes: (CvarState | undefined)[] = [];
  private first: CvarState | undefined;
  private cheatsEnabled = true;
  private changedFlags = CvarFlag.None;

  constructor(
    private readonly print?: (text: string) => undefined,
    private readonly developerPrint?: (text: string) => undefined,
    private readonly strings?: SourceZoneStrings,
  ) {}

  get indexCount(): number { return this.indexes.length; }

  get modifiedFlags(): number {
    return this.changedFlags;
  }

  get(name: string): CvarSnapshot | undefined {
    const state = this.variables.get(name) ?? this.variables.get(cvarNameKey(name));
    return state === undefined ? undefined : snapshot(state);
  }

  /** Cvar_FindVar retains the same record across recursive callbacks. */
  find(name: string): CvarReference | undefined {
    return this.variables.get(name) ?? this.variables.get(cvarNameKey(name));
  }

  createVm(): RegisterableVmCvar {
    return new RegistryVmCvar(
      (name, defaultValue, flags) => this.bindVm(name, defaultValue, flags),
      handle => this.readVm(handle),
    );
  }

  /** Cvar_Register uses the same source index for typed and bytecode callers. */
  bindVm(name: string, defaultValue: string, flags: number): number {
    return this.registerState(sourceCommandText(name), sourceCommandText(defaultValue), flags).index;
  }

  /** Deleted cvar_restart slots stay empty and are never rebound by name. */
  readVm(handle: number): CvarSnapshot | undefined {
    if (!Number.isInteger(handle) || handle < 0 || handle >= this.indexes.length) {
      throw new CommonError("drop", "Cvar_Update: handle out of range");
    }
    const state = this.indexes[handle];
    return state === undefined ? undefined : snapshot(state);
  }

  registerVm(name: string, defaultValue: string, flags = CvarFlag.None): VmCvar {
    const mirror = this.createVm();
    mirror.register(name, defaultValue, flags);
    return mirror;
  }

  register(name: string, defaultValue: string, flags = CvarFlag.None): CvarSnapshot {
    return snapshot(this.registerState(sourceCommandText(name), sourceCommandText(defaultValue), flags));
  }

  private registerState(name: CvarStringInput, defaultValue: CvarStringInput, flags: number): CvarState {
    name = this.canonicalName(name);
    const key = cvarNameKey(inputValue(name));
    const existing = this.variables.get(key);
    if (existing !== undefined) {
      if (
        hasFlag(existing.flags, CvarFlag.UserCreated)
        && !hasFlag(flags, CvarFlag.UserCreated)
        && inputValue(defaultValue).length > 0
      ) {
        existing.flags &= ~CvarFlag.UserCreated;
        this.freeString(existing.resetString);
        existing.resetString = this.copyString(defaultValue);
        this.changedFlags |= flags;
      }
      existing.flags |= flags;
      if (existing.resetValue.length === 0) {
        this.freeString(existing.resetString);
        existing.resetString = this.copyString(defaultValue);
      } else if (inputValue(defaultValue).length > 0 && existing.resetValue !== inputValue(defaultValue)) {
        this.developerPrint?.(`Warning: cvar "${inputValue(name)}" given initial values: "${existing.resetValue}" and "${inputValue(defaultValue)}"\n`);
      }
      if (existing.latchedString !== null) {
        const latchedString = existing.latchedString;
        existing.latchedString = null;
        this.set2(name, latchedString, true);
        this.freeString(latchedString);
      }
      return existing;
    }

    if (this.indexes.length === 1024) throw new CommonError("fatal", "MAX_CVARS");
    const index = this.indexes.length;
    this.indexes.push(undefined);
    const nameString = this.copyString(name);
    const currentString = this.copyString(defaultValue);
    const numeric = numericValue(currentString.value);
    const integer = nativeAtoi(currentString.value);
    const resetString = this.copyString(defaultValue);
    const state = new CvarState(index, nameString, currentString, resetString, flags, numeric, integer);
    this.indexes[index] = state;
    state.next = this.first;
    this.first = state;
    this.variables.set(key, state);
    return state;
  }

  set(name: string, value: string, force = false): CvarSnapshot {
    return snapshot(this.set2(name, value, force));
  }

  /** Cvar_SetValue formats into its 32-byte Com_sprintf destination before Cvar_Set. */
  setValue(name: string, value: number): CvarSnapshot {
    const text = setValueText(Math.fround(value));
    if (text.length >= 32) this.print?.(`Com_sprintf: overflow of ${text.length} in 32\n`);
    return this.set(name, text.slice(0, 31), true);
  }

  set2(name: CvarStringInput | null, value: CvarStringInput, force?: boolean): CvarReference;
  set2(name: CvarStringInput | null, value: null, force?: boolean): CvarReference | undefined;
  set2(name: CvarStringInput | null, value: CvarStringInput | null, force?: boolean): CvarReference | undefined;
  set2(name: CvarStringInput | null, value: CvarStringInput | null, force = false): CvarReference | undefined {
    if (typeof name === "string") name = sourceCommandText(name);
    if (typeof value === "string") value = sourceCommandText(value);
    // Linux/glibc %s prints (null) for NULL operands; ISO C does not define that argument.
    this.developerPrint?.(`Cvar_Set2: ${name === null ? "(null)" : inputValue(name)} ${value === null ? "(null)" : inputValue(value)}\n`);
    name = this.canonicalName(name);
    const key = cvarNameKey(inputValue(name));
    const existing = this.variables.get(key);
    if (existing === undefined) {
      if (value === null) return undefined;
      const flags = force ? CvarFlag.None : CvarFlag.UserCreated;
      return this.registerState(name, value, flags);
    }

    if (value === null) value = requiredString(existing.resetString);
    if (inputValue(value) === existing.value) {
      return existing;
    }
    this.changedFlags |= existing.flags;

    if (!force) {
      if (hasFlag(existing.flags, CvarFlag.ReadOnly)) {
        this.print?.(`${inputValue(name)} is read only.\n`);
        return existing;
      }
      if (hasFlag(existing.flags, CvarFlag.Init)) {
        this.print?.(`${inputValue(name)} is write protected.\n`);
        return existing;
      }
      if (hasFlag(existing.flags, CvarFlag.Latch)) {
        if (existing.latchedValue === inputValue(value)) {
          return existing;
        }
        if (existing.latchedString !== null) this.freeString(existing.latchedString);
        this.print?.(`${inputValue(name)} will be changed upon restarting.\n`);
        existing.latchedString = this.copyString(value);
        existing.modified = true;
        existing.modificationCount++;
        return existing;
      }
      const cheats = this.variables.get("sv_cheats");
      if (hasFlag(existing.flags, CvarFlag.Cheat) && !(cheats === undefined ? this.cheatsEnabled : cheats.integerValue !== 0)) {
        this.print?.(`${inputValue(name)} is cheat protected.\n`);
        return existing;
      }
    } else {
      if (existing.latchedString !== null) {
        this.freeString(existing.latchedString);
        existing.latchedString = null;
      }
    }

    this.applyValue(existing, value);
    return existing;
  }

  applyLatched(name?: string): readonly CvarSnapshot[] {
    const changed: CvarSnapshot[] = [];
    if (name !== undefined) {
      const state = this.variables.get(cvarNameKey(name));
      if (state !== undefined && state.latchedString !== null) {
        const latchedString = state.latchedString;
        state.latchedString = null;
        this.applyValue(state, latchedString.value);
        this.freeString(latchedString);
        changed.push(snapshot(state));
      }
      return Object.freeze(changed);
    }

    for (const state of this.variables.values()) {
      if (state.latchedString !== null) {
        const latchedString = state.latchedString;
        state.latchedString = null;
        this.applyValue(state, latchedString.value);
        this.freeString(latchedString);
        changed.push(snapshot(state));
      }
    }
    return Object.freeze(changed);
  }

  reset(name: string, force = false): CvarSnapshot | undefined {
    const state = this.set2(name, null, force);
    return state === undefined ? undefined : snapshot(state);
  }

  resetAll(): void {
    let previous: CvarState | undefined;
    while (true) {
      const state = previous === undefined ? this.first : previous.next;
      if (state === undefined) break;
      if (
        hasFlag(state.flags, CvarFlag.ReadOnly)
        || hasFlag(state.flags, CvarFlag.Init)
        || hasFlag(state.flags, CvarFlag.NoRestart)
      ) {
        previous = state;
        continue;
      }
      if (hasFlag(state.flags, CvarFlag.UserCreated)) {
        if (previous === undefined) this.first = state.next;
        else previous.next = state.next;
        this.variables.delete(cvarNameKey(state.name));
        if (state.nameString !== null) this.freeString(state.nameString);
        if (state.currentString !== null) this.freeString(state.currentString);
        if (state.latchedString !== null) this.freeString(state.latchedString);
        if (state.resetString !== null) this.freeString(state.resetString);
        this.indexes[state.index] = undefined;
        state.next = undefined;
        state.nameString = null;
        state.currentString = null;
        state.resetString = null;
        state.latchedString = null;
        state.flags = CvarFlag.None;
        state.modified = false;
        state.modificationCount = 0;
        state.numericValue = 0;
        state.integerValue = 0;
        continue;
      }
      this.set2(requiredString(state.nameString), requiredString(state.resetString), true);
      previous = state;
    }
  }

  setCheatsEnabled(enabled: boolean): void {
    this.cheatsEnabled = enabled;
    if (enabled) {
      return;
    }
    for (const state of this.newestFirst()) {
      if (!hasFlag(state.flags, CvarFlag.Cheat)) {
        continue;
      }
      if (state.latchedString !== null) {
        this.freeString(state.latchedString);
        state.latchedString = null;
      }
      if (state.value !== state.resetValue) {
        this.set2(requiredString(state.nameString), requiredString(state.resetString), true);
      }
    }
  }

  snapshots(flags = CvarFlag.None): readonly CvarSnapshot[] {
    const result: CvarSnapshot[] = [];
    for (const state of this.newestFirst()) {
      if (flags === CvarFlag.None || (state.flags & flags) !== 0) {
        result.push(snapshot(state));
      }
    }
    return Object.freeze(result);
  }

  /** Each callback borrows the live source record; traversal reads next after it returns. */
  visit(flags: number, visitor: (value: CvarReference) => undefined): void {
    for (const state of this.newestFirst()) {
      if (flags === CvarFlag.None || (state.flags & flags) !== 0) visitor(state);
    }
  }

  infoString(flags: number, maximumLength: 1024 | 8192 = 1024): string {
    let info = "";
    const setValue = maximumLength === 8192 ? infoSetValueForKeyBig : infoSetValueForKey;
    for (const state of this.newestFirst()) {
      if ((state.flags & flags) === 0) continue;
      info = setValue(info, state.name, state.value, text => { this.print?.(text); });
    }
    return info;
  }

  archiveCommands(): readonly string[] {
    const commands: string[] = [];
    for (const state of this.newestFirst()) {
      if (hasFlag(state.flags, CvarFlag.Archive) && cvarNameKey(state.name) !== "cl_cdkey") {
        const value = state.latchedValue === undefined ? state.value : state.latchedValue;
        commands.push(`seta ${state.name} "${value}"`);
      }
    }
    return Object.freeze(commands);
  }

  /** Cvar_WriteVariables formats and writes each record before advancing the source list. */
  writeVariables(write: (text: string) => undefined): void {
    for (const state of this.newestFirst()) {
      if (cvarNameKey(state.name) === "cl_cdkey" || !hasFlag(state.flags, CvarFlag.Archive)) continue;
      const value = state.latchedValue === undefined ? state.value : state.latchedValue;
      const line = `seta ${state.name} "${value}"\n`;
      if (line.length >= 1024) this.print?.(`Com_sprintf: overflow of ${line.length} in 1024\n`);
      write(line.slice(0, 1023));
    }
  }

  takeModifiedFlags(): number {
    const flags = this.changedFlags;
    this.changedFlags = CvarFlag.None;
    return flags;
  }

  /** Source global dirty-mask writes, including Key_SetBinding. */
  markModifiedFlags(mask: number): void {
    this.changedFlags |= mask;
  }

  clearModifiedFlags(mask: number): void {
    this.changedFlags &= ~mask;
  }

  /** Cvar_SetA/SetU/SetS flag writes do not re-register or apply a pending latch. */
  addFlags(name: string, flags: number): void {
    const state = this.variables.get(cvarNameKey(name));
    if (state === undefined) throw new Error(`Cannot add flags to unregistered cvar ${name}`);
    state.flags |= flags;
  }

  /** Direct source cvar->modified clearing does not consume the global flag mask. */
  clearModified(name: string): void {
    const state = this.variables.get(cvarNameKey(name));
    if (state === undefined) throw new Error(`Cannot clear unregistered cvar ${name}`);
    state.modified = false;
  }

  private applyValue(state: CvarState, value: CvarStringInput): void {
    if (inputValue(value) === state.value) {
      return;
    }
    state.modified = true;
    state.modificationCount++;
    this.freeString(state.currentString);
    state.currentString = this.copyString(value);
    state.numericValue = numericValue(state.value);
    state.integerValue = nativeAtoi(state.value);
  }

  private copyString(value: CvarStringInput): ZoneString {
    const text = inputValue(value);
    return this.strings === undefined ? { value: text } : this.strings.copy(text);
  }

  private freeString(value: ZoneString | null): void {
    this.strings?.free(value);
  }

  private canonicalName(name: CvarStringInput | null): CvarStringInput {
    if (name === null) {
      this.print?.("invalid cvar name string: (null)\n");
      return "BADNAME";
    }
    const text = inputValue(name);
    if (!text.includes("\\") && !text.includes('"') && !text.includes(";")) return name;
    this.print?.(`invalid cvar name string: ${text}\n`);
    return "BADNAME";
  }

  private *newestFirst(): Generator<CvarState, void, unknown> {
    for (let state = this.first; state !== undefined; state = state.next) yield state;
  }
}
