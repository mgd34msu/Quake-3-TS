/*
 * Bot character profiles translated from id Software's be_ai_char.c and
 * game/chars.h. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { float32, int32 } from "../core/numeric.ts";
import { ScriptSourceReader } from "../script/preprocessor.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";
import type { BotScriptReader } from "./script-sources.ts";
import type { BotLog } from "./log.ts";
import {
  NumberFlag,
  Punctuation,
  ScriptLanguageError,
  type ScriptToken,
  type SourceLocation,
} from "../script/lexer.ts";

export enum Characteristic {
  Name = 0,
  Gender = 1,
  AttackSkill = 2,
  WeaponWeights = 3,
  ViewFactor = 4,
  ViewMaxChange = 5,
  ReactionTime = 6,
  AimAccuracy = 7,
  AimAccuracyMachinegun = 8,
  AimAccuracyShotgun = 9,
  AimAccuracyRocketLauncher = 10,
  AimAccuracyGrenadeLauncher = 11,
  AimAccuracyLightning = 12,
  AimAccuracyPlasmaGun = 13,
  AimAccuracyRailgun = 14,
  AimAccuracyBfg10k = 15,
  AimSkill = 16,
  AimSkillRocketLauncher = 17,
  AimSkillGrenadeLauncher = 18,
  AimSkillPlasmaGun = 19,
  AimSkillBfg10k = 20,
  ChatFile = 21,
  ChatName = 22,
  ChatCpm = 23,
  ChatInsult = 24,
  ChatMisc = 25,
  ChatStartEndLevel = 26,
  ChatEnterExitGame = 27,
  ChatKill = 28,
  ChatDeath = 29,
  ChatEnemySuicide = 30,
  ChatHitTalking = 31,
  ChatHitNoDeath = 32,
  ChatHitNoKill = 33,
  ChatRandom = 34,
  ChatReply = 35,
  Croucher = 36,
  Jumper = 37,
  WeaponJumping = 38,
  GrappleUser = 39,
  ItemWeights = 40,
  Aggression = 41,
  SelfPreservation = 42,
  Vengefulness = 43,
  Camper = 44,
  EasyFragger = 45,
  Alertness = 46,
  FireThrottle = 47,
  Walker = 48,
}

export type CharacterDiagnosticCode =
  | "loaded"
  | "missing-source"
  | "missing-skill"
  | "fallback"
  | "parse-error"
  | "invalid-input"
  | "invalid-handle"
  | "invalid-index"
  | "uninitialized"
  | "wrong-type"
  | "invalid-bounds"
  | "unsupported-log-format";

export interface CharacterDiagnostic {
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly code: CharacterDiagnosticCode;
  readonly source: string;
  readonly message: string;
  readonly location: SourceLocation | null;
}

export class CharacterError extends Error {
  constructor(readonly diagnostic: CharacterDiagnostic) {
    super(diagnostic.message);
    this.name = "CharacterError";
  }
}

export interface BotCharacterLibraryOptions {
  readonly debug?: { readonly milliseconds: () => number; readonly developer: () => boolean };
  readonly memory?: BotMemory;
  readonly log?: Pick<BotLog, "write" | "filePointer">;
  readonly reloadCharacters?: () => boolean;
  readonly report?: (diagnostic: CharacterDiagnostic) => undefined;
}

type CharacteristicValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "string"; readonly value: string };

type LoadAttempt =
  | { readonly kind: "loaded"; readonly profile: CharacterProfile }
  | { readonly kind: "missing-source" }
  | { readonly kind: "missing-skill" }
  | { readonly kind: "parse-error" };

const DEFAULT_CHARACTER = "bots/default_c.c";
const MAX_CHARACTERISTICS = 80;
// The source allocates c[1] plus MAX_CHARACTERISTICS extra records. Its loader
// accepts index 80, while defaulting, interpolation and getters only visit 0..79.
const STORED_CHARACTERISTICS = MAX_CHARACTERISTICS + 1;
const MAX_CHARACTER_HANDLES = 64;
const MAX_QPATH = 64;
const CHARACTERISTIC_BYTES = 8;
const CHARACTERISTICS_OFFSET = MAX_QPATH + 4;
const PROFILE_BYTES = CHARACTERISTICS_OFFSET + STORED_CHARACTERISTICS * CHARACTERISTIC_BYTES;

function characterFloatText(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";
  const negative = value < 0 || Object.is(value, -0), absolute = Math.abs(value);
  if (absolute >= 1e21) return `${negative ? "-" : ""}${BigInt(absolute)}.000000`;
  const scaled = absolute * 1_000_000, whole = Math.floor(scaled);
  if (Number.isSafeInteger(whole) && scaled - whole === 0.5) {
    const rounded = whole % 2 === 0 ? whole : whole + 1;
    return `${negative ? "-" : ""}${(rounded / 1_000_000).toFixed(6)}`;
  }
  return `${negative ? "-" : ""}${absolute.toFixed(6)}`;
}

interface CharacterStrings {
  readonly allocations: Map<number, BotMemoryAllocation>;
  nextPointer: number;
}

function readString(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) { if (byte === 0) break; result += String.fromCharCode(byte); }
  return result;
}

function encodeString(text: string): Uint8Array {
  const end = text.indexOf("\0");
  const length = end < 0 ? text.length : end, bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const byte = text.charCodeAt(index);
    if (byte > 255) throw new RangeError("character strings require source bytes");
    bytes[index] = byte;
  }
  return bytes;
}

// Release32: filename[64], float skill, then 81 char/padding/union records.
// String words are managed pointer identities; their target bytes own the text.
class CharacterProfile {
  private readonly allocation: BotMemoryAllocation;

  constructor(private readonly memory: BotMemory, private readonly strings: CharacterStrings) {
    this.allocation = memory.allocate(PROFILE_BYTES, "heap", true);
  }

  private get view(): DataView {
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get filename(): string { return readString(this.allocation.bytes.subarray(0, MAX_QPATH)); }
  set filename(value: string) {
    const bytes = encodeString(value);
    this.allocation.bytes.set(bytes, 0);
    this.allocation.bytes[bytes.length] = 0;
  }
  get skill(): number { return this.view.getFloat32(MAX_QPATH, true); }
  set skill(value: number) { this.view.setFloat32(MAX_QPATH, value, true); }

  value(index: number): CharacteristicValue | undefined {
    const offset = CHARACTERISTICS_OFFSET + index * CHARACTERISTIC_BYTES;
    const profile = this;
    switch (this.view.getUint8(offset)) {
      case 0: return undefined;
      case 1: return { kind: "integer", get value(): number { return profile.view.getInt32(offset + 4, true); } };
      case 2: return { kind: "float", get value(): number { return profile.view.getFloat32(offset + 4, true); } };
      case 3: return { kind: "string", get value(): string {
        return readString(profile.stringAllocation(profile.view.getUint32(offset + 4, true)).bytes);
      } };
      default: throw new Error("Invalid bot characteristic type byte");
    }
  }

  setValue(index: number, value: CharacteristicValue, typeBeforeAllocation = false): void {
    const offset = CHARACTERISTICS_OFFSET + index * CHARACTERISTIC_BYTES;
    switch (value.kind) {
      case "integer":
        this.view.setInt32(offset + 4, value.value, true);
        this.view.setUint8(offset, 1);
        break;
      case "float":
        this.view.setFloat32(offset + 4, value.value, true);
        this.view.setUint8(offset, 2);
        break;
      case "string": {
        if (typeBeforeAllocation) this.view.setUint8(offset, 3);
        const bytes = encodeString(value.value);
        const allocation = this.memory.allocate(bytes.length + 1, "heap", false);
        const pointer = this.strings.nextPointer++;
        if (pointer > 0xffffffff) throw new RangeError("Bot character string pointer space exhausted");
        this.strings.allocations.set(pointer, allocation);
        this.view.setUint32(offset + 4, pointer, true);
        allocation.bytes.set(bytes);
        allocation.bytes[bytes.length] = 0;
        this.view.setUint8(offset, 3);
        break;
      }
    }
  }

  free(): void {
    // The source loader accepts 80, but its string-free loop stops at 79.
    for (let index = 0; index < MAX_CHARACTERISTICS; index++) {
      const offset = CHARACTERISTICS_OFFSET + index * CHARACTERISTIC_BYTES;
      if (this.view.getUint8(offset) !== 3) continue;
      const pointer = this.view.getUint32(offset + 4, true);
      if (pointer === 0) continue;
      this.memory.free(this.stringAllocation(pointer));
      this.strings.allocations.delete(pointer);
    }
    this.memory.free(this.allocation);
  }

  private stringAllocation(pointer: number): BotMemoryAllocation {
    const allocation = this.strings.allocations.get(pointer);
    if (allocation === undefined) throw new Error("Invalid bot characteristic string pointer");
    return allocation;
  }
}

function locationCopy(location: SourceLocation): SourceLocation {
  return Object.freeze({ path: location.path, line: location.line, column: location.column });
}

function diagnostic(
  severity: CharacterDiagnostic["severity"],
  code: CharacterDiagnosticCode,
  source: string,
  message: string,
  location: SourceLocation | null = null,
): CharacterDiagnostic {
  return Object.freeze({
    severity,
    code,
    source,
    message,
    location: location === null ? null : locationCopy(location),
  } satisfies CharacterDiagnostic);
}

function isPunctuation(token: ScriptToken | undefined, punctuation: Punctuation): boolean {
  return token?.kind === "punctuation" && token.punctuation === punctuation;
}

function hasNumberFlag(token: ScriptToken, flag: NumberFlag): boolean {
  return token.kind === "number" && (token.flags & flag) !== 0;
}

export class BotCharacterLibrary {
  private readonly profiles: (CharacterProfile | undefined)[] = Array.from(
    { length: MAX_CHARACTER_HANDLES + 1 },
    (): CharacterProfile | undefined => undefined,
  );
  private readonly reported: CharacterDiagnostic[] = [];
  private readonly reloadCharacters: () => boolean;
  private readonly reportDiagnostic: BotCharacterLibraryOptions["report"];
  private readonly log: BotCharacterLibraryOptions["log"];
  private readonly debug: BotCharacterLibraryOptions["debug"];
  private generation = 0;
  private readonly memory: BotMemory;
  private readonly strings: CharacterStrings = { allocations: new Map<number, BotMemoryAllocation>(), nextPointer: 1 };

  constructor(
    private readonly reader: BotScriptReader,
    options: BotCharacterLibraryOptions = {},
  ) {
    this.reloadCharacters = options.reloadCharacters ?? (() => false);
    this.reportDiagnostic = options.report;
    this.log = options.log;
    this.debug = options.debug;
    this.memory = options.memory ?? new BotMemory();
  }

  get diagnostics(): readonly CharacterDiagnostic[] {
    return Object.freeze([...this.reported]);
  }

  load(characterFile: string | (() => string), skill: number): number {
    let desiredSkill = float32(skill);
    if (desiredSkill < 1) desiredSkill = 1;
    else if (desiredSkill > 5) desiredSkill = 5;
    if (!Number.isFinite(desiredSkill)) {
      const filename = typeof characterFile === "string" ? characterFile : characterFile();
      const issue = diagnostic("error", "invalid-input", filename, "character skill must be finite");
      this.record(issue);
      throw new CharacterError(issue);
    }
    return this.loadTransaction(characterFile, desiredSkill, this.generation);
  }

  private loadTransaction(characterFile: string | (() => string), desiredSkill: number, generation: number): number {
    if (desiredSkill === 1 || desiredSkill === 4 || desiredSkill === 5) {
      return this.loadSkill(characterFile, desiredSkill, generation);
    }
    const cached = this.findCached(characterFile, desiredSkill);
    if (cached !== 0) {
      const filename = this.validateFilename(characterFile);
      this.emit("info", "loaded", filename, `loaded cached skill ${characterFloatText(desiredSkill)} from ${filename}`);
      return this.isCurrent(generation) ? cached : 0;
    }

    let firstSkill: number;
    let secondSkill: number;
    if (desiredSkill < 4) {
      firstSkill = this.loadSkill(characterFile, 1, generation);
      if (firstSkill === 0) return 0;
      secondSkill = this.loadSkill(characterFile, 4, generation);
    } else {
      firstSkill = this.loadSkill(characterFile, 4, generation);
      if (firstSkill === 0) return 0;
      secondSkill = this.loadSkill(characterFile, 5, generation);
    }
    if (!this.isCurrent(generation)) return 0;
    if (secondSkill === 0) return firstSkill;
    const handle = this.interpolate(firstSkill, secondSkill, desiredSkill);
    if (handle !== 0 && this.isCurrent(generation)) this.dumpCharacter(handle);
    return this.isCurrent(generation) ? handle : 0;
  }

  /** BotDumpCharacter. The source skill format has no defined C varargs result. */
  dumpCharacter(handle: number): void {
    const profile = this.profile(handle);
    if (profile === undefined) return;
    this.log?.write(profile.filename);
    if (this.log !== undefined && this.log.filePointer() !== null) {
      this.emit("warning", "unsupported-log-format", profile.filename,
        "BotDumpCharacter: omitted undefined skill log format (%d receives a promoted float)");
    }
    this.log?.write("{\n");
    for (let index = 0; index < MAX_CHARACTERISTICS; index++) {
      const value = profile.value(index);
      if (value === undefined) continue;
      const text = value.kind === "float" ? characterFloatText(value.value) : String(value.value);
      this.log?.write(` ${String(index).padStart(4, " ")} ${text}\n`);
    }
    this.log?.write("}\n");
  }

  free(handle: number): void {
    if (!this.reloadCharacters()) return;
    const profile = this.profile(handle);
    if (profile === undefined) return;
    profile.free();
    this.profiles[handle] = undefined;
  }

  shutdown(): void {
    this.generation += 1;
    for (let handle = 1; handle <= MAX_CHARACTER_HANDLES; handle++) {
      this.profiles[handle]?.free();
      this.profiles[handle] = undefined;
    }
  }

  float(handle: number, index: number): number {
    const value = this.value(handle, index);
    if (value === undefined) return 0;
    switch (value.kind) {
      case "integer": return float32(value.value);
      case "float": return value.value;
      case "string":
        this.emit("error", "wrong-type", this.profileSource(handle), `characteristic ${index} is not a float`);
        return 0;
      default: {
        const exhaustive: never = value;
        throw new Error(`unknown characteristic ${String(exhaustive)}`);
      }
    }
  }

  boundedFloat(handle: number, index: number, minimum: number, maximum: number): number {
    if (this.profile(handle) === undefined) return 0;
    const min = float32(minimum);
    const max = float32(maximum);
    if (min > max) {
      this.emit("error", "invalid-bounds", this.profileSource(handle),
        `cannot bound characteristic ${index} between ${characterFloatText(min)} and ${characterFloatText(max)}`);
      return 0;
    }
    const value = this.float(handle, index);
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  integer(handle: number, index: number): number {
    const value = this.value(handle, index);
    if (value === undefined) return 0;
    switch (value.kind) {
      case "integer": return value.value;
      case "float": return int32(Math.trunc(value.value));
      case "string":
        this.emit("error", "wrong-type", this.profileSource(handle), `characteristic ${index} is not a integer`);
        return 0;
      default: {
        const exhaustive: never = value;
        throw new Error(`unknown characteristic ${String(exhaustive)}`);
      }
    }
  }

  boundedInteger(handle: number, index: number, minimum: number, maximum: number): number {
    if (this.profile(handle) === undefined) return 0;
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum)) {
      this.emit("error", "invalid-bounds", this.profileSource(handle), "integer characteristic bounds must be integers");
      return 0;
    }
    const min = int32(minimum);
    const max = int32(maximum);
    if (min > max) {
      this.emit("error", "invalid-bounds", this.profileSource(handle),
        `cannot bound characteristic ${index} between ${min} and ${max}`);
      return 0;
    }
    const value = this.integer(handle, index);
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  string(handle: number, index: number): string {
    let text = "";
    this.writeString(handle, index, value => { text = value; });
    return text;
  }

  writeString(handle: number, index: number, write: (text: string) => undefined): void {
    const value = this.value(handle, index);
    if (value === undefined) return;
    if (value.kind === "string") {
      write(value.value);
      return;
    }
    this.emit("error", "wrong-type", this.profileSource(handle), `characteristic ${index} is not a string`);
  }

  private validateFilename(characterFile: string | (() => string)): string {
    const filename = typeof characterFile === "string" ? characterFile : characterFile();
    return readString(encodeString(filename));
  }

  private loadSkill(filename: string | (() => string), skill: number, generation: number): number {
    const defaultHandle = this.loadCached(DEFAULT_CHARACTER, skill, false, generation);
    if (!this.isCurrent(generation)) return 0;
    const handle = this.loadCached(filename, skill, this.reloadCharacters(), generation);
    if (!this.isCurrent(generation)) return 0;
    if (defaultHandle !== 0 && handle !== 0) {
      const profile = this.profiles[handle];
      const defaultProfile = this.profiles[defaultHandle];
      if (profile !== undefined && defaultProfile !== undefined) {
        this.withDefaults(profile, defaultProfile);
      }
    }
    return handle;
  }

  private loadCached(characterFile: string | (() => string), skill: number, reload: boolean, generation: number): number {
    const startTime = this.debug?.milliseconds();
    if (!this.isCurrent(generation)) return 0;
    const handle = this.freeHandle();
    if (handle === 0) return 0;
    if (!reload) {
      const cached = this.findCached(characterFile, skill);
      if (cached !== 0) {
        const filename = this.validateFilename(characterFile);
        this.emit("info", "loaded", filename, `loaded cached skill ${characterFloatText(skill)} from ${filename}`);
        return cached;
      }
    }

    const integerSkill = Math.trunc(skill + 0.5);
    const exact = this.loadFromFile(characterFile, integerSkill, generation);
    if (!this.isCurrent(generation)) return 0;
    if (exact.kind === "loaded") {
      const result = this.store(exact.profile, handle, "loaded", characterFile, `loaded skill ${integerSkill}`);
      if (!this.isCurrent(generation)) return 0;
      if (this.debug !== undefined && startTime !== undefined && this.debug.developer()) {
        if (!this.isCurrent(generation)) return 0;
        const elapsed = (this.debug.milliseconds() - startTime) | 0;
        if (!this.isCurrent(generation)) return 0;
        const filename = this.validateFilename(characterFile);
        this.emit("info", "loaded", filename, `skill ${integerSkill} loaded in ${elapsed} msec from ${filename}`);
      }
      return result;
    }
    const missingFilename = this.validateFilename(characterFile);
    this.emit("warning", "missing-skill", missingFilename, `couldn't find skill ${integerSkill} in ${missingFilename}`);
    if (!this.isCurrent(generation)) return 0;

    if (!reload) {
      const cachedDefault = this.findCached(DEFAULT_CHARACTER, skill);
      if (cachedDefault !== 0) {
        const filename = this.validateFilename(characterFile);
        this.emit("info", "fallback", filename, `loaded cached default skill ${integerSkill} from ${filename}`);
        return cachedDefault;
      }
    }
    const exactDefault = this.loadFromFile(DEFAULT_CHARACTER, integerSkill, generation);
    if (!this.isCurrent(generation)) return 0;
    if (exactDefault.kind === "loaded") {
      return this.store(exactDefault.profile, handle, "fallback", characterFile, `loaded default skill ${integerSkill}`);
    }

    if (!reload) {
      const cachedAny = this.findCached(characterFile, -1);
      const cachedProfile = this.profiles[cachedAny];
      if (cachedProfile !== undefined) {
        const filename = this.validateFilename(characterFile);
        this.emit("info", "fallback", filename, `loaded cached skill ${characterFloatText(cachedProfile.skill)} from ${filename}`);
        return cachedAny;
      }
    }
    const arbitrarySkill = this.loadFromFile(characterFile, -1, generation);
    if (!this.isCurrent(generation)) return 0;
    if (arbitrarySkill.kind === "loaded") {
      return this.store(arbitrarySkill.profile, handle, "fallback", characterFile, `loaded skill ${characterFloatText(arbitrarySkill.profile.skill)}`);
    }

    if (!reload) {
      const cachedDefaultAny = this.findCached(DEFAULT_CHARACTER, -1);
      const cachedProfile = this.profiles[cachedDefaultAny];
      if (cachedProfile !== undefined) {
        const filename = this.validateFilename(characterFile);
        this.emit("info", "fallback", filename, `loaded cached default skill ${characterFloatText(cachedProfile.skill)} from ${filename}`);
        return cachedDefaultAny;
      }
    }
    const defaultAny = this.loadFromFile(DEFAULT_CHARACTER, -1, generation);
    if (!this.isCurrent(generation)) return 0;
    if (defaultAny.kind === "loaded") {
      return this.store(defaultAny.profile, handle, "fallback", characterFile, `loaded default skill ${characterFloatText(defaultAny.profile.skill)}`);
    }
    const filename = this.validateFilename(characterFile);
    this.emit("warning", "fallback", filename, `couldn't load any skill from ${filename}`);
    return 0;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private loadFromFile(characterFile: string | (() => string), desiredSkill: number, generation: number): LoadAttempt {
    if (!this.isCurrent(generation)) return { kind: "parse-error" };
    const filename = this.validateFilename(characterFile);
    if (!this.isCurrent(generation)) return { kind: "parse-error" };
    const source = this.reader.resolveRoot(filename);
    if (source === undefined) {
      if (this.isCurrent(generation)) {
        const currentFilename = this.validateFilename(characterFile);
        this.emit("error", "missing-source", currentFilename, `counldn't load ${currentFilename}`);
      }
      return Object.freeze({ kind: "missing-source" });
    }
    if (!this.isCurrent(generation)) return Object.freeze({ kind: "parse-error" });
    const storedFilename = this.validateFilename(characterFile);
    if (!this.isCurrent(generation)) return { kind: "parse-error" };
    const callbackState: { failure?: { readonly error: unknown } } = {};
    const invokeCallback = <T>(callback: () => T): T => {
      try { return callback(); }
      catch (error) { callbackState.failure = { error }; throw error; }
    };
    const report = (issue: CharacterDiagnostic): void => invokeCallback(() => this.record(issue));
    const tokens = ScriptSourceReader.open(source, {
      resolve: request => invokeCallback(() => this.reader.resolve(request)),
    }, {
      globals: this.reader.globals,
      ...(this.reader.debugEval === undefined ? {} : { debugEval: (text: string) => invokeCallback(() => this.reader.debugEval?.(text)) }),
      report: item => {
        if (this.isCurrent(generation)) {
          report(diagnostic(item.severity, "parse-error", filename, item.message, item.location));
        }
      },
    });
    const profile = new CharacterProfile(this.memory, this.strings);
    if (encodeString(storedFilename).length >= MAX_QPATH) {
      const issue = diagnostic("error", "invalid-input", storedFilename,
        "character filename copy exceeds MAX_QPATH destination");
      this.record(issue);
      throw new CharacterError(issue);
    }
    profile.filename = storedFilename;

    let result: LoadAttempt;
    try {
      result = this.parseTokens(filename, profile, desiredSkill, tokens, generation, report);
    } catch (error) {
      if (callbackState.failure !== undefined) throw callbackState.failure.error;
      if (!(error instanceof ScriptLanguageError)) throw error;
      result = { kind: "parse-error" };
    }
    tokens.dispose();
    if (result.kind !== "loaded") profile.free();
    return result;
  }

  private parseTokens(
    filename: string,
    profile: CharacterProfile,
    desiredSkill: number,
    tokens: ScriptSourceReader,
    generation: number,
    report: (issue: CharacterDiagnostic) => void,
  ): LoadAttempt {
    const next = (): ScriptToken | undefined => {
      try { return tokens.next()?.token; }
      catch (error) { if (!tokens.isSourceFailure(error)) throw error; return undefined; }
    };
    const parseError = (token: ScriptToken | undefined, message: string): LoadAttempt => {
      if (this.isCurrent(generation)) {
        report(diagnostic("error", "parse-error", filename, message, { path: tokens.currentScriptFilename,
          line: tokens.position.line, column: token?.location.column ?? 1 }));
      }
      return { kind: "parse-error" };
    };
    while (true) {
      const definition = next();
      if (!this.isCurrent(generation)) return { kind: "parse-error" };
      if (definition === undefined) return { kind: "missing-skill" };
      if (definition?.kind !== "name" || definition.value !== "skill") {
        return parseError(definition, `unknown definition ${definition?.text ?? "<eof>"}\n`);
      }
      const skillToken = next();
      if (!this.isCurrent(generation)) return { kind: "parse-error" };
      if (skillToken === undefined) return parseError(skillToken, "couldn't read expected token");
      if (skillToken.kind !== "number") return parseError(skillToken, `expected a number, found ${skillToken.text}`);
      const open = next();
      if (!this.isCurrent(generation)) return { kind: "parse-error" };
      if (!isPunctuation(open, Punctuation.BraceOpen)) {
        return parseError(open, open === undefined ? "couldn't find expected {" : `expected {, found ${open.text}`);
      }
      if (desiredSkill < 0 || skillToken.integerValue === desiredSkill) {
        profile.skill = skillToken.integerValue;
        while (true) {
          const indexToken = next();
          if (!this.isCurrent(generation)) return { kind: "parse-error" };
          if (isPunctuation(indexToken, Punctuation.BraceClose)) return { kind: "loaded", profile };
          if (indexToken === undefined) {
            // PC_ExpectAnyToken reports EOF, but this source loop still returns ch.
            parseError(indexToken, "couldn't read expected token");
            return this.isCurrent(generation) ? { kind: "loaded", profile } : { kind: "parse-error" };
          }
          if (indexToken?.kind !== "number" || !hasNumberFlag(indexToken, NumberFlag.Integer)) {
            return parseError(indexToken,
              `expected integer index, found ${indexToken?.text ?? "<eof>"}\n`);
          }
          const index = indexToken.integerValue;
          if (index < 0 || index > MAX_CHARACTERISTICS) {
            return parseError(indexToken,
              `characteristic index out of range [0, ${MAX_CHARACTERISTICS}]\n`);
          }
          if (profile.value(index) !== undefined) {
            return parseError(indexToken, `characteristic ${index} already initialized\n`);
          }
          const valueToken = next();
          if (!this.isCurrent(generation)) return { kind: "parse-error" };
          if (valueToken === undefined) return parseError(valueToken, "couldn't read expected token");
          if (valueToken?.kind === "number") {
            if (hasNumberFlag(valueToken, NumberFlag.Float)) {
              const value = float32(valueToken.floatValue);
              if (!Number.isFinite(value)) {
                return parseError(valueToken, "non-finite characteristic float");
              }
              profile.setValue(index, { kind: "float", value });
            } else {
              profile.setValue(index, { kind: "integer", value: int32(valueToken.integerValue) });
            }
          } else if (valueToken?.kind === "string") {
            profile.setValue(index, { kind: "string", value: valueToken.value });
          } else {
            return parseError(valueToken,
              `expected integer, float or string, found ${valueToken.text}\n`);
          }
        }
      }

      let depth = 1;
      while (depth > 0) {
        const token = next();
        if (!this.isCurrent(generation)) return { kind: "parse-error" };
        if (token === undefined) return parseError(token, "couldn't read expected token");
        if (isPunctuation(token, Punctuation.BraceOpen)) depth++;
        else if (isPunctuation(token, Punctuation.BraceClose)) depth--;
      }
    }
  }

  private withDefaults(profile: CharacterProfile, defaults: CharacterProfile): void {
    for (let index = 0; index < MAX_CHARACTERISTICS; index++) {
      if (profile.value(index) !== undefined) continue;
      const value = defaults.value(index);
      if (value !== undefined) profile.setValue(index, value, true);
    }
  }

  private interpolate(firstHandle: number, secondHandle: number, desiredSkill: number): number {
    const first = this.profiles[firstHandle];
    const second = this.profiles[secondHandle];
    if (first === undefined || second === undefined) return 0;
    const handle = this.freeHandle();
    if (handle === 0) return 0;
    const profile = new CharacterProfile(this.memory, this.strings);
    profile.skill = desiredSkill;
    profile.filename = first.filename;
    this.profiles[handle] = profile;
    const scale = float32(float32(desiredSkill - first.skill) / float32(second.skill - first.skill));
    for (let index = 0; index < MAX_CHARACTERISTICS; index++) {
      const lower = first.value(index);
      const upper = second.value(index);
      if (lower?.kind === "float" && upper?.kind === "float") {
        const delta = float32(upper.value - lower.value);
        profile.setValue(index, { kind: "float", value: float32(lower.value + float32(delta * scale)) });
      } else if (lower?.kind === "integer" || lower?.kind === "string") {
        profile.setValue(index, lower, true);
      }
    }
    return handle;
  }

  private findCached(characterFile: string | (() => string), skill: number): number {
    const generation = this.generation;
    for (let handle = 1; handle <= MAX_CHARACTER_HANDLES; handle++) {
      const profile = this.profiles[handle];
      if (profile === undefined) continue;
      const filename = this.validateFilename(characterFile);
      if (!this.isCurrent(generation)) return 0;
      if (this.profiles[handle] !== profile) continue;
      if (profile.filename === filename
        && (skill < 0 || Math.abs(profile.skill - skill) < 0.01)) return handle;
    }
    return 0;
  }

  private freeHandle(): number {
    for (let handle = 1; handle <= MAX_CHARACTER_HANDLES; handle++) {
      if (this.profiles[handle] === undefined) return handle;
    }
    return 0;
  }

  private store(
    profile: CharacterProfile, handle: number, code: "loaded" | "fallback",
    characterFile: string | (() => string), message: string,
  ): number {
    this.profiles[handle] = profile;
    const filename = this.validateFilename(characterFile);
    this.emit("info", code, filename, `${message} from ${filename}`);
    return handle;
  }

  private profile(handle: number): CharacterProfile | undefined {
    if (!Number.isInteger(handle) || handle <= 0 || handle > MAX_CHARACTER_HANDLES) {
      this.emit("fatal", "invalid-handle", "<character-library>", `character handle ${handle} out of range`);
      return undefined;
    }
    const profile = this.profiles[handle];
    if (profile === undefined) {
      this.emit("fatal", "invalid-handle", "<character-library>", `invalid character ${handle}`);
      return undefined;
    }
    return profile;
  }

  private value(handle: number, index: number): CharacteristicValue | undefined {
    const profile = this.profile(handle);
    if (profile === undefined) return undefined;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHARACTERISTICS) {
      this.emit("error", "invalid-index", profile.filename, `characteristic ${index} does not exist`);
      return undefined;
    }
    const value = profile.value(index);
    if (value === undefined) this.emit("error", "uninitialized", profile.filename, `characteristic ${index} is not initialized`);
    return value;
  }

  private profileSource(handle: number): string {
    return this.profiles[handle]?.filename ?? "<character-library>";
  }

  private emit(
    severity: CharacterDiagnostic["severity"],
    code: CharacterDiagnosticCode,
    source: string,
    message: string,
  ): void {
    this.record(diagnostic(severity, code, source, message));
  }

  private record(issue: CharacterDiagnostic): void {
    this.reported.push(issue);
    this.reportDiagnostic?.(issue);
  }
}
