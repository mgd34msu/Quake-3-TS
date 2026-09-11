/*
 * Goal AI translated from id Software's code/botlib/be_ai_goal.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { add3, sub3, scale3, length3, type Vec3, type Bounds } from "../core/math.ts";
import { float32ToBits } from "../core/numeric.ts";
import { ScriptLanguageError, type ScriptDiagnostic, type ScriptToken, type SourceLocation } from "../script/lexer.ts";
import { ScriptSourceReader, type ScriptPreprocessorOptions } from "../script/preprocessor.ts";
import { StructureReader } from "../script/structure.ts";
import { WeightConfigError, WeightConfigLoadError, WeightConfigStore, type BotRandom, type WeightConfig, type WeightInventory } from "./weights.ts";
import type { BotLog } from "./log.ts";
import type { BotScriptReader } from "./script-sources.ts";
import { presenceTypeBounds, type AasSpatial, type AasSpatialHost } from "./spatial.ts";
import type { AasRouting } from "./routing.ts";
import type { AasBspEntities } from "./bsp-entities.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";

export const GoalFlags = Object.freeze({ Item: 1, Roam: 2, Dropped: 4 });
export const GoalError = Object.freeze({ None: 0, CannotLoadItemWeights: 9, CannotLoadItemConfig: 10 });
export const MAX_GOAL_STATES = 64;
export const MAX_GOAL_STACK = 8;
export const MAX_AVOID_GOALS = 256;

export interface BotGoal {
  readonly origin: Vec3;
  readonly area: number;
  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly entity: number;
  readonly number: number;
  readonly flags: number;
  readonly itemInfo: number;
}

export interface ItemInfo {
  readonly classname: string;
  readonly name: string;
  readonly model: string;
  readonly modelIndex: number;
  readonly type: number;
  readonly index: number;
  readonly respawnTime: number;
  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly number: number;
}

export interface ItemConfig {
  readonly path: string;
  readonly items: readonly ItemInfo[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  free(): void;
}

export interface ItemConfigOptions {
  readonly memory?: BotMemory;
  readonly maxItems?: number;
  readonly preprocessor?: ScriptPreprocessorOptions;
  readonly report?: (diagnostic: GoalDiagnostic) => undefined;
}

function configError(message: string, location: SourceLocation, diagnostics: readonly ScriptDiagnostic[]): never {
  const diagnostic: ScriptDiagnostic = { severity: "error", message, location };
  throw new ScriptLanguageError(diagnostic, [...diagnostics, diagnostic]);
}

class ItemConfigTokens {
  private unreadToken: ScriptToken | undefined;
  constructor(private readonly source: ScriptSourceReader, private readonly callbackAborted: () => boolean) {}
  get diagnostics(): readonly ScriptDiagnostic[] { return this.source.diagnostics; }
  get diagnosticCallbackAborted(): boolean { return this.callbackAborted(); }
  next(): ScriptToken | undefined {
    if (this.unreadToken !== undefined) {
      const token = this.unreadToken;
      this.unreadToken = undefined;
      return token;
    }
    try { return this.source.next()?.token; }
    catch (error) {
      if (!this.source.isSourceFailure(error)) throw error;
      return undefined;
    }
  }
  unread(token: ScriptToken): void { this.unreadToken = token; }
  dispose(): void { this.source.dispose(); }
  disposeRecordOnly(): void { this.source.disposeRecordOnly(); }
}

class ItemClassnameError extends ScriptLanguageError {}

function vector(x = 0, y = 0, z = 0): Vec3 {
  return Object.freeze({ x, y, z });
}

function overlay(previous: Vec3, values: readonly number[]): Vec3 {
  return vector(values[0] ?? previous.x, values[1] ?? previous.y, values[2] ?? previous.z);
}

// be_ai_goal.c: 32-bit itemconfig_t followed by max_iteminfo iteminfo_t cells.
const ITEM_CONFIG_BYTES = 8;
const ITEM_INFO_BYTES = 236;

class ItemConfigCell {
  constructor(private readonly allocation: BotMemoryAllocation, private readonly offset: number) {}
  private get view(): DataView {
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset + this.offset, ITEM_INFO_BYTES);
  }
  private text(offset: number, length: number): string {
    const bytes = this.allocation.bytes.subarray(this.offset + offset, this.offset + offset + length);
    let result = "";
    for (const byte of bytes) { if (byte === 0) break; result += String.fromCharCode(byte); }
    return result;
  }
  private writeText(offset: number, length: number, value: string): void {
    const bytes = this.allocation.bytes.subarray(this.offset + offset, this.offset + offset + length);
    bytes.fill(0);
    for (let index = 0; index < Math.min(value.length, length - 1); index++) {
      const byte = value.charCodeAt(index);
      if (byte === 0) break;
      if (byte > 255) throw new RangeError("item configuration strings require source bytes");
      bytes[index] = byte;
    }
  }
  private readVector(offset: number): Vec3 {
    const view = this.view;
    return vector(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
  }
  private writeVector(offset: number, value: Vec3): void {
    const view = this.view;
    view.setFloat32(offset, value.x, true);
    view.setFloat32(offset + 4, value.y, true);
    view.setFloat32(offset + 8, value.z, true);
  }
  get classname(): string { return this.text(0, 32); }
  set classname(value: string) { this.writeText(0, 32, value); }
  get name(): string { return this.text(32, 80); }
  set name(value: string) { this.writeText(32, 80, value); }
  get model(): string { return this.text(112, 80); }
  set model(value: string) { this.writeText(112, 80, value); }
  get modelIndex(): number { return this.view.getInt32(192, true); }
  set modelIndex(value: number) { this.view.setInt32(192, value, true); }
  get type(): number { return this.view.getInt32(196, true); }
  set type(value: number) { this.view.setInt32(196, value, true); }
  get index(): number { return this.view.getInt32(200, true); }
  set index(value: number) { this.view.setInt32(200, value, true); }
  get respawnTime(): number { return this.view.getFloat32(204, true); }
  set respawnTime(value: number) { this.view.setFloat32(204, value, true); }
  get mins(): Vec3 { return this.readVector(208); }
  set mins(value: Vec3) { this.writeVector(208, value); }
  get maxs(): Vec3 { return this.readVector(220); }
  set maxs(value: Vec3) { this.writeVector(220, value); }
  get number(): number { return this.view.getInt32(232, true); }
  set number(value: number) { this.view.setInt32(232, value, true); }
}

function itemConfigView(allocation: BotMemoryAllocation, offset: number) {
  const cell = new ItemConfigCell(allocation, offset);
  return {
    get classname(): string { return cell.classname; }, set classname(value: string) { cell.classname = value; },
    get name(): string { return cell.name; }, set name(value: string) { cell.name = value; },
    get model(): string { return cell.model; }, set model(value: string) { cell.model = value; },
    get modelIndex(): number { return cell.modelIndex; }, set modelIndex(value: number) { cell.modelIndex = value; },
    get type(): number { return cell.type; }, set type(value: number) { cell.type = value; },
    get index(): number { return cell.index; }, set index(value: number) { cell.index = value; },
    get respawnTime(): number { return cell.respawnTime; }, set respawnTime(value: number) { cell.respawnTime = value; },
    get mins(): Vec3 { return cell.mins; }, set mins(value: Vec3) { cell.mins = value; },
    get maxs(): Vec3 { return cell.maxs; }, set maxs(value: Vec3) { cell.maxs = value; },
    get number(): number { return cell.number; }, set number(value: number) { cell.number = value; },
  };
}

export function loadItemConfig(resolver: BotScriptReader, path: string, options: ItemConfigOptions = {}): ItemConfig {
  const maximum = options.maxItems ?? 256;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 0x7fffffff) {
    throw new RangeError("maximum item definitions must be a nonnegative signed 32-bit integer");
  }
  const root = resolver.resolveRoot(path);
  if (root === undefined) {
    options.report?.({ severity: "error", message: `counldn't load ${path}\n` });
    configError(`couldn't load ${path}`, { path, line: 1, column: 1 }, []);
  }
  let diagnosticCallbackAborted = false;
  const reportedDiagnostics = new Set<ScriptDiagnostic>();
  const reportDiagnostics = (diagnostics: readonly ScriptDiagnostic[]): void => {
    for (const diagnostic of diagnostics) {
      if (reportedDiagnostics.has(diagnostic)) continue;
      reportScriptDiagnostic(options, diagnostic);
      reportedDiagnostics.add(diagnostic);
    }
  };
  let preprocessor: ItemConfigTokens;
  try {
    preprocessor = new ItemConfigTokens(ScriptSourceReader.open(root, resolver, {
      ...options.preprocessor,
      globals: resolver.globals,
      ...(resolver.debugEval === undefined ? {} : { debugEval: (text: string) => {
        try { resolver.debugEval?.(text); }
        catch (error) { diagnosticCallbackAborted = true; throw error; }
      } }),
      report: diagnostic => {
        try {
          options.preprocessor?.report?.(diagnostic);
          reportDiagnostics([diagnostic]);
        }
        catch (error) { diagnosticCallbackAborted = true; throw error; }
      },
    }), () => diagnosticCallbackAborted);
  } catch (error) {
    if (diagnosticCallbackAborted || !(error instanceof ScriptLanguageError)) throw error;
    reportDiagnostics(error.diagnostics);
    throw error;
  }
  reportDiagnostics(preprocessor.diagnostics);
  const config = readItemConfig(preprocessor, root.path, maximum, options.memory ?? new BotMemory(), error => {
    if (diagnosticCallbackAborted) return false;
    reportDiagnostics(error.diagnostics);
    return true;
  });
  reportDiagnostics(preprocessor.diagnostics);
  preprocessor.dispose();
  if (config.items.length === 0) options.report?.({ severity: "warning", message: "no item info loaded\n" });
  options.report?.({ severity: "message", message: `loaded ${path}\n` });
  return config;
}

function reportScriptDiagnostic(options: ItemConfigOptions, diagnostic: ScriptDiagnostic): void {
  options.report?.({ severity: diagnostic.severity, message: `file ${diagnostic.location.path}, line ${diagnostic.location.line}: ${diagnostic.message}\n` });
}

function readItemConfig(preprocessor: ItemConfigTokens, path: string, maximum: number, memory: BotMemory,
  reportError: (error: ScriptLanguageError) => boolean): ItemConfig {
  const allocation = memory.allocate(ITEM_CONFIG_BYTES + maximum * ITEM_INFO_BYTES, "hunk", true);
  // Pointer slots contain allocation-relative offsets in the managed 32-bit layout.
  const bytes = allocation.bytes;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(4, ITEM_CONFIG_BYTES, true);
  try {
    return parseItemConfig(preprocessor, path, maximum, allocation, memory);
  } catch (error) {
    if (error instanceof ScriptLanguageError && reportError(error)) {
      memory.free(allocation);
      // Failed PC_ExpectTokenType uses FreeMemory(source), leaving its scripts.
      if (error instanceof ItemClassnameError) preprocessor.disposeRecordOnly();
      else preprocessor.dispose();
    }
    throw error;
  }
}

function parseItemConfig(preprocessor: ItemConfigTokens, path: string, maximum: number, allocation: BotMemoryAllocation, memory: BotMemory): ItemConfig {
  const reader = new StructureReader(preprocessor, path, preprocessor.diagnostics);
  const items: ItemInfo[] = [];
  for (let token = preprocessor.next(); token !== undefined; token = preprocessor.next()) {
    if (token.text !== "iteminfo") configError(`unknown definition ${token.text}\n`, token.location, reader.diagnostics);
    const bytes = allocation.bytes;
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
    if (count >= maximum) configError(`more than ${maximum} item info defined\n`, token.location, reader.diagnostics);
    bytes.fill(0, ITEM_CONFIG_BYTES + count * ITEM_INFO_BYTES, ITEM_CONFIG_BYTES + (count + 1) * ITEM_INFO_BYTES);
    const item = itemConfigView(allocation, ITEM_CONFIG_BYTES + count * ITEM_INFO_BYTES);
    try {
      item.classname = reader.readString(31);
    } catch (error) {
      if (error instanceof ScriptLanguageError && !preprocessor.diagnosticCallbackAborted) {
        throw new ItemClassnameError(error.diagnostic, error.diagnostics);
      }
      throw error;
    }
    reader.begin();
    for (let field = reader.nextField(); field !== undefined; field = reader.nextField()) {
      switch (field.name) {
        case "name": item.name = reader.readString(); break;
        case "model": item.model = reader.readString(); break;
        case "modelindex": item.modelIndex = reader.readInt(); break;
        case "type": item.type = reader.readInt(); break;
        case "index": item.index = reader.readInt(); break;
        case "respawntime": item.respawnTime = reader.readFloat(); break;
        case "mins": item.mins = overlay(item.mins, reader.readFloatArray(3)); break;
        case "maxs": item.maxs = overlay(item.maxs, reader.readFloatArray(3)); break;
        default: configError(`unknown structure field ${field.name}`, field.location, reader.diagnostics);
      }
    }
    item.number = count;
    items.push(Object.freeze(item));
    const currentBytes = allocation.bytes;
    new DataView(currentBytes.buffer, currentBytes.byteOffset, currentBytes.byteLength).setInt32(0, count + 1, true);
  }
  const diagnostics = [...preprocessor.diagnostics];
  if (items.length === 0) diagnostics.push({ severity: "warning", message: "no item info loaded", location: { path, line: 1, column: 1 } });
  return Object.freeze({ path, items: Object.freeze(items), diagnostics: Object.freeze(diagnostics), free: () => memory.free(allocation) });
}

export interface GoalDiagnostic {
  readonly severity: "message" | "warning" | "error" | "fatal";
  readonly message: string;
}

export interface GoalLibraryOptions {
  readonly debug?: boolean;
  readonly memory?: BotMemory;
  readonly resolver: BotScriptReader;
  readonly weightStore: WeightConfigStore;
  readonly log: Pick<BotLog, "write">;
  readonly clock: () => number;
  readonly random: BotRandom;
  readonly gameType: () => number;
  readonly maxItemInfo?: { get(): number; set(value: number): void };
  readonly maxLevelItems?: () => number;
  readonly droppedWeight?: () => number;
  readonly preprocessor?: ScriptPreprocessorOptions;
  readonly report?: (diagnostic: GoalDiagnostic) => undefined;
  readonly developer?: () => boolean;
}

export interface GoalEntityInfo {
  readonly type: number;
  readonly modelIndex: number;
  readonly origin: Vec3;
  readonly lastVisibleOrigin: Vec3;
  readonly lastUpdateTime: number;
}

export interface GoalWorldHost extends Pick<AasSpatialHost, "trace" | "pointContents"> {
  nextEntity(after: number): number;
  entityInfo(entity: number): GoalEntityInfo;
}

interface GoalNavigation {
  readonly spatial: AasSpatial;
  readonly routing: AasRouting;
}

export interface GoalWorld {
  readonly bspEntities: AasBspEntities;
  readonly navigation: GoalNavigation | null;
  readonly host: GoalWorldHost;
  readonly pointArea: (origin: Vec3) => number;
}

const LEVEL_ITEM_BYTES = 60;
const MAP_LOCATION_BYTES = 148;
const CAMP_SPOT_BYTES = 164;

class GoalMapCell {
  constructor(readonly allocation: BotMemoryAllocation, private readonly offset: number, private readonly size: number) {}
  protected get view(): DataView {
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset + this.offset, this.size);
  }
  protected readVector(offset: number): Vec3 {
    const view = this.view;
    return vector(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
  }
  protected writeVector(offset: number, value: Vec3): void {
    const view = this.view;
    view.setFloat32(offset, value.x, true); view.setFloat32(offset + 4, value.y, true); view.setFloat32(offset + 8, value.z, true);
  }
}

class LevelItem extends GoalMapCell {
  constructor(allocation: BotMemoryAllocation, readonly pointer: number, private readonly itemInfo: (index: number) => ItemInfo) {
    super(allocation, (pointer - 1) * LEVEL_ITEM_BYTES, LEVEL_ITEM_BYTES);
  }
  clear(): void { this.allocation.bytes.fill(0, (this.pointer - 1) * LEVEL_ITEM_BYTES, this.pointer * LEVEL_ITEM_BYTES); }
  get number(): number { return this.view.getInt32(0, true); }
  set number(value: number) { this.view.setInt32(0, value, true); }
  get infoIndex(): number { return this.view.getInt32(4, true); }
  set infoIndex(value: number) { this.view.setInt32(4, value, true); }
  get info(): ItemInfo { return this.itemInfo(this.infoIndex); }
  get flags(): number { return this.view.getInt32(8, true); }
  set flags(value: number) { this.view.setInt32(8, value, true); }
  get weight(): number { return this.view.getFloat32(12, true); }
  set weight(value: number) { this.view.setFloat32(12, value, true); }
  get origin(): Vec3 { return this.readVector(16); }
  set origin(value: Vec3) { this.writeVector(16, value); }
  get goalArea(): number { return this.view.getInt32(28, true); }
  set goalArea(value: number) { this.view.setInt32(28, value, true); }
  get goalOrigin(): Vec3 { return this.readVector(32); }
  set goalOrigin(value: Vec3) { this.writeVector(32, value); }
  get entity(): number { return this.view.getInt32(44, true); }
  set entity(value: number) { this.view.setInt32(44, value, true); }
  get timeout(): number { return this.view.getFloat32(48, true); }
  set timeout(value: number) { this.view.setFloat32(48, value, true); }
  get prev(): number { return this.view.getUint32(52, true); }
  set prev(value: number) { this.view.setUint32(52, value, true); }
  get next(): number { return this.view.getUint32(56, true); }
  set next(value: number) { this.view.setUint32(56, value, true); }
}

class MapLocation extends GoalMapCell {
  constructor(allocation: BotMemoryAllocation, readonly pointer: number, private readonly nextOffset = 144) {
    super(allocation, 0, nextOffset + 4);
  }
  get origin(): Vec3 { return this.readVector(0); }
  set origin(value: Vec3) { this.writeVector(0, value); }
  get area(): number { return this.view.getInt32(12, true); }
  set area(value: number) { this.view.setInt32(12, value, true); }
  get name(): string {
    const bytes = this.allocation.bytes.subarray(16, 144);
    let text = "";
    for (const byte of bytes) { if (byte === 0) break; text += String.fromCharCode(byte); }
    return text;
  }
  readName(bsp: AasBspEntities, entity: number): void { bsp.value(entity, "message", this.allocation.bytes.subarray(16, 144)); }
  get next(): number { return this.view.getUint32(this.nextOffset, true); }
  set next(value: number) { this.view.setUint32(this.nextOffset, value, true); }
}

class CampSpot extends MapLocation {
  constructor(allocation: BotMemoryAllocation, pointer: number) { super(allocation, pointer, 160); }
  get range(): number { return this.view.getFloat32(144, true); }
  set range(value: number) { this.view.setFloat32(144, value, true); }
  get weight(): number { return this.view.getFloat32(148, true); }
  set weight(value: number) { this.view.setFloat32(148, value, true); }
  get wait(): number { return this.view.getFloat32(152, true); }
  set wait(value: number) { this.view.setFloat32(152, value, true); }
  get random(): number { return this.view.getFloat32(156, true); }
  set random(value: number) { this.view.setFloat32(156, value, true); }
}

function bspString(entities: AasBspEntities, entity: number, key: string): string | null {
  const bytes = new Uint8Array(128);
  if (!entities.value(entity, key, bytes)) return null;
  let text = "";
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}
function sameVector(first: Vec3, second: Vec3): boolean { return first.x === second.x && first.y === second.y && first.z === second.z; }
function goalNameKey(text: string): string {
  const terminator = text.indexOf("\0"), length = terminator < 0 ? text.length : terminator;
  return text.slice(0, Math.min(length, 99999)).replace(/[a-z]/g, character => character.toUpperCase());
}
function goalNameMatches(query: string | ((candidate: string) => boolean), candidate: string): boolean {
  if (typeof query === "function") return query(candidate);
  return goalNameKey(query) === goalNameKey(candidate);
}
// Log_Write promotes the stored float to double; %f rounds decimal ties to even.
function goalFloatText(value: number, digits: number): string {
  const bits = float32ToBits(value), exponent = (bits >>> 23) & 255;
  const negative = (bits >>> 31) !== 0;
  if (exponent === 255) return Number.isNaN(value) ? "nan" : negative ? "-inf" : "inf";
  const mantissa = BigInt((bits & 0x7fffff) | (exponent === 0 ? 0 : 0x800000));
  const shift = exponent === 0 ? -149 : exponent - 150;
  let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift);
  else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator;
  const remainder = (numerator % denominator) * 2n;
  if (remainder > denominator || (remainder === denominator && (rounded & 1n) !== 0n)) rounded++;
  const text = rounded.toString().padStart(digits + 1, "0");
  return `${negative ? "-" : ""}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}
function itemBounds(info: ItemInfo): Bounds { return { min: info.mins, max: info.maxs }; }
function defaultAvoidTime(info: ItemInfo): number { return Math.max(10, info.respawnTime === 0 ? 30 : info.respawnTime); }
function blankGoal(): BotGoal { return { origin: vector(), area: 0, mins: vector(), maxs: vector(), entity: 0, number: 0, flags: 0, itemInfo: 0 }; }

export function touchingGoal(origin: Vec3, goal: BotGoal): boolean {
  const player = presenceTypeBounds(2);
  const min = add3(sub3(goal.mins, player.max), goal.origin);
  const max = add3(sub3(goal.maxs, player.min), goal.origin);
  if (origin.x < min.x || origin.x > max.x) return false;
  if (origin.y < min.y || origin.y > max.y) return false;
  if (origin.z < min.z || origin.z > max.z) return false;
  return true;
}

interface AvoidGoal { number: number; expires: number }
// be_ai_goal.c bot_goalstate_t, using the source 32-bit pointer layout.
const GOAL_BYTES = 56;
const GOAL_STACK_OFFSET = 16;
const GOAL_STACK_TOP_OFFSET = GOAL_STACK_OFFSET + MAX_GOAL_STACK * GOAL_BYTES;
const AVOID_GOALS_OFFSET = GOAL_STACK_TOP_OFFSET + 4;
const AVOID_TIMES_OFFSET = AVOID_GOALS_OFFSET + MAX_AVOID_GOALS * 4;
const GOAL_STATE_BYTES = AVOID_TIMES_OFFSET + MAX_AVOID_GOALS * 4;

interface GoalReferences {
  nextId: number;
  readonly configs: Map<number, WeightConfig>;
  readonly configIds: WeakMap<WeightConfig, number>;
  readonly indexes: Map<number, BotMemoryAllocation>;
}

function allocationView(allocation: BotMemoryAllocation): DataView {
  const bytes = allocation.bytes;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

class GoalState {
  readonly avoid: readonly AvoidGoal[];
  constructor(readonly allocation: BotMemoryAllocation, private readonly references: GoalReferences) {
    const state = this;
    this.avoid = Array.from({ length: MAX_AVOID_GOALS }, (_, index) => ({
      get number(): number { return state.view.getInt32(AVOID_GOALS_OFFSET + index * 4, true); },
      set number(value: number) { state.view.setInt32(AVOID_GOALS_OFFSET + index * 4, value, true); },
      get expires(): number { return state.view.getFloat32(AVOID_TIMES_OFFSET + index * 4, true); },
      set expires(value: number) { state.view.setFloat32(AVOID_TIMES_OFFSET + index * 4, value, true); },
    }));
  }
  private get view(): DataView { return allocationView(this.allocation); }
  get client(): number { return this.view.getInt32(8, true); }
  set client(value: number) { this.view.setInt32(8, value, true); }
  get lastReachabilityArea(): number { return this.view.getInt32(12, true); }
  set lastReachabilityArea(value: number) { this.view.setInt32(12, value, true); }
  get stackTop(): number { return this.view.getInt32(GOAL_STACK_TOP_OFFSET, true); }
  set stackTop(value: number) { this.view.setInt32(GOAL_STACK_TOP_OFFSET, value, true); }
  get weightConfig(): WeightConfig | null {
    const id = this.view.getUint32(0, true);
    if (id === 0) return null;
    const config = this.references.configs.get(id);
    if (config === undefined) throw new Error("Invalid goal weight configuration pointer");
    return config;
  }
  set weightConfig(config: WeightConfig | null) {
    if (config === null) { this.view.setUint32(0, 0, true); return; }
    let id = this.references.configIds.get(config);
    if (id === undefined) {
      id = this.nextReference();
      this.references.configIds.set(config, id);
      this.references.configs.set(id, config);
    }
    this.view.setUint32(0, id, true);
  }
  get weightIndexes(): BotMemoryAllocation | null {
    const id = this.view.getUint32(4, true);
    if (id === 0) return null;
    const allocation = this.references.indexes.get(id);
    if (allocation === undefined) throw new Error("Invalid goal item weight index pointer");
    return allocation;
  }
  set weightIndexes(allocation: BotMemoryAllocation | null) {
    if (allocation === null) {
      this.references.indexes.delete(this.view.getUint32(4, true));
      this.view.setUint32(4, 0, true);
      return;
    }
    const id = this.nextReference();
    this.references.indexes.set(id, allocation);
    this.view.setUint32(4, id, true);
  }
  private nextReference(): number {
    // Managed objects use owner-local IDs, not host addresses, in pointer words.
    if (this.references.nextId > 0xffffffff) throw new RangeError("Goal pointer IDs exhausted");
    return this.references.nextId++;
  }
  readGoal(index: number): BotGoal {
    const offset = this.goalOffset(index), view = this.view;
    const readVector = (start: number): Vec3 => vector(view.getFloat32(start, true), view.getFloat32(start + 4, true), view.getFloat32(start + 8, true));
    return Object.freeze({ origin: readVector(offset), area: view.getInt32(offset + 12, true),
      mins: readVector(offset + 16), maxs: readVector(offset + 28), entity: view.getInt32(offset + 40, true),
      number: view.getInt32(offset + 44, true), flags: view.getInt32(offset + 48, true), itemInfo: view.getInt32(offset + 52, true) });
  }
  goalBytes(index: number): Uint8Array {
    const offset = this.goalOffset(index);
    return this.allocation.bytes.subarray(offset, offset + GOAL_BYTES);
  }
  writeGoal(index: number, goal: BotGoal | Uint8Array): void {
    if (goal instanceof Uint8Array) {
      if (goal.byteLength < GOAL_BYTES) throw new RangeError("goal source record requires 56 bytes");
      this.goalBytes(index).set(goal.subarray(0, GOAL_BYTES));
      return;
    }
    const offset = this.goalOffset(index), view = this.view;
    const writeVector = (start: number, value: Vec3): void => {
      view.setFloat32(start, value.x, true); view.setFloat32(start + 4, value.y, true); view.setFloat32(start + 8, value.z, true);
    };
    writeVector(offset, goal.origin); view.setInt32(offset + 12, goal.area, true);
    writeVector(offset + 16, goal.mins); writeVector(offset + 28, goal.maxs);
    view.setInt32(offset + 40, goal.entity, true); view.setInt32(offset + 44, goal.number, true);
    view.setInt32(offset + 48, goal.flags, true); view.setInt32(offset + 52, goal.itemInfo, true);
  }
  clearStack(): void { this.allocation.bytes.fill(0, GOAL_STACK_OFFSET, GOAL_STACK_TOP_OFFSET + 4); }
  private goalOffset(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_GOAL_STACK) throw new RangeError("goal stack index exceeds its allocation");
    return GOAL_STACK_OFFSET + index * GOAL_BYTES;
  }
}

export interface AvoidGoalDump { readonly number: number; readonly remaining: number }

function copyGoal(goal: BotGoal): BotGoal {
  return Object.freeze({ ...goal, origin: vector(goal.origin.x, goal.origin.y, goal.origin.z), mins: vector(goal.mins.x, goal.mins.y, goal.mins.z), maxs: vector(goal.maxs.x, goal.maxs.y, goal.maxs.z) });
}

function finiteFloat(value: number, name: string): number {
  const result = Math.fround(value);
  if (!Number.isFinite(result)) throw new RangeError(`${name} must be finite float32`);
  return result;
}

class RetiredGoalSetup extends Error {}

export class BotGoalLibrary {
  private readonly options: GoalLibraryOptions;
  private readonly memory: BotMemory;
  private readonly references: GoalReferences = { nextId: 1, configs: new Map<number, WeightConfig>(),
    configIds: new WeakMap<WeightConfig, number>(), indexes: new Map<number, BotMemoryAllocation>() };
  private readonly states = new Map<number, GoalState>();
  private readonly reported: GoalDiagnostic[] = [];
  private generation = 0;
  private setupRevision = 0;
  private mapRevision = 0;
  private config: ItemConfig | null = null;
  private configuredGameType = 0;
  private world: GoalWorld | null = null;
  private levelItemHeap: BotMemoryAllocation | null = null;
  // Source globals: levelitems, freelevelitems, numlevelitems, maplocations, campspots.
  private readonly mapWords = new DataView(new ArrayBuffer(20));
  private readonly infoEntities = new Map<number, MapLocation>();
  private nextInfoPointer = 1;

  private get levelHead(): number { return this.mapWords.getUint32(0, true); }
  private set levelHead(value: number) { this.mapWords.setUint32(0, value, true); }
  private get freeLevelHead(): number { return this.mapWords.getUint32(4, true); }
  private set freeLevelHead(value: number) { this.mapWords.setUint32(4, value, true); }
  private get initialItemCount(): number { return this.mapWords.getInt32(8, true); }
  private set initialItemCount(value: number) { this.mapWords.setInt32(8, value, true); }
  private get locationHead(): number { return this.mapWords.getUint32(12, true); }
  private set locationHead(value: number) { this.mapWords.setUint32(12, value, true); }
  private get campHead(): number { return this.mapWords.getUint32(16, true); }
  private set campHead(value: number) { this.mapWords.setUint32(16, value, true); }

  constructor(options: GoalLibraryOptions) { this.options = options; this.memory = options.memory ?? new BotMemory(); }
  get diagnostics(): readonly GoalDiagnostic[] { return Object.freeze([...this.reported]); }
  get itemConfig(): ItemConfig | null { return this.config; }
  get gameType(): number { return this.configuredGameType; }

  setup(path = "items.c"): number {
    const generation = this.generation, revision = ++this.setupRevision;
    const checkCurrent = (): undefined => {
      if (generation !== this.generation || revision !== this.setupRevision) throw new RetiredGoalSetup();
      return undefined;
    };
    try {
      const gameType = Math.trunc(finiteFloat(this.options.gameType(), "game type"));
      checkCurrent();
      this.configuredGameType = gameType;
      let maximum = Math.trunc(finiteFloat(this.options.maxItemInfo?.get() ?? 256, "max_iteminfo"));
      checkCurrent();
      if (maximum < 0) {
        this.report("error", `max_iteminfo = ${maximum}\n`);
        checkCurrent();
        maximum = 256;
        this.options.maxItemInfo?.set(maximum);
        checkCurrent();
      }
      const resolver: BotScriptReader = {
        globals: this.options.resolver.globals,
        debugEval: this.options.resolver.debugEval,
        resolveRoot: filename => {
          const source = this.options.resolver.resolveRoot(filename);
          checkCurrent();
          return source;
        },
        resolve: request => {
          const source = this.options.resolver.resolve(request);
          checkCurrent();
          return source;
        },
      };
      const config = loadItemConfig(resolver, path, {
        maxItems: maximum,
        memory: this.memory,
        ...(this.options.preprocessor === undefined ? {} : { preprocessor: this.options.preprocessor }),
        report: diagnostic => {
          checkCurrent();
          this.report(diagnostic.severity, diagnostic.message);
          return checkCurrent();
        },
      });
      checkCurrent();
      this.config = config;
      return GoalError.None;
    } catch (error) {
      if (error instanceof RetiredGoalSetup) return GoalError.CannotLoadItemConfig;
      if (!(error instanceof ScriptLanguageError)) throw error;
      if (generation === this.generation && revision === this.setupRevision) {
        this.config = null;
        this.report("fatal", "couldn't load item config\n");
      }
      return GoalError.CannotLoadItemConfig;
    }
  }

  allocGoalState(client: number): number {
    if (!Number.isInteger(client)) throw new RangeError("client must be an integer");
    for (let handle = 1; handle <= MAX_GOAL_STATES; handle++) {
      if (this.states.has(handle)) continue;
      const state = new GoalState(this.memory.allocate(GOAL_STATE_BYTES, "heap", true), this.references);
      this.states.set(handle, state);
      state.client = client;
      return handle;
    }
    return 0;
  }

  freeGoalState(handle: number): void {
    if (Number.isInteger(handle) && handle > 0 && handle <= MAX_GOAL_STATES && !this.states.has(handle)) {
      this.report("fatal", `invalid goal state handle ${handle}\n`);
      return;
    }
    const state = this.state(handle);
    if (state === undefined) return;
    this.releaseWeights(state);
    this.memory.free(state.allocation);
    this.states.delete(handle);
  }

  loadItemWeights(handle: number, path: string | (() => string)): number {
    const state = this.state(handle);
    if (state === undefined) return GoalError.CannotLoadItemWeights;
    const generation = this.generation;
    const filename = typeof path === "function" ? path() : path;
    let config: WeightConfig;
    try {
      config = this.options.weightStore.load(filename);
    } catch (error) {
      if (!(error instanceof WeightConfigError) && !(error instanceof WeightConfigLoadError)) throw error;
      if (generation === this.generation && this.states.get(handle) === state) {
        state.weightConfig = null;
        this.report("fatal", "couldn't load weights\n");
      }
      return GoalError.CannotLoadItemWeights;
    }
    if (generation !== this.generation || this.states.get(handle) !== state) {
      this.options.weightStore.free(config);
      return GoalError.CannotLoadItemWeights;
    }
    state.weightConfig = config;
    const itemConfig = this.config;
    if (itemConfig === null) return GoalError.CannotLoadItemWeights;
    const indexes = this.memory.allocate(itemConfig.items.length * 4, "heap", true);
    for (let itemIndex = 0; itemIndex < itemConfig.items.length; itemIndex++) {
      const item = itemConfig.items[itemIndex];
      if (item === undefined) throw new RangeError("item info index exceeds its allocation");
      const index = config.find(item.classname);
      allocationView(indexes).setInt32(itemIndex * 4, index, true);
      if (index < 0) this.options.log.write(`item info ${itemIndex} "${item.classname}" has no fuzzy weight\r\n`);
    }
    if (generation !== this.generation || this.states.get(handle) !== state) return GoalError.CannotLoadItemWeights;
    state.weightIndexes = indexes;
    return GoalError.None;
  }

  freeItemWeights(handle: number): void {
    const state = this.state(handle);
    if (state !== undefined) this.releaseWeights(state);
  }

  interbreedGoalFuzzyLogic(parent1: number, parent2: number, child: number): readonly string[] {
    const first = this.state(parent1), second = this.state(parent2), output = this.state(child);
    if (first === undefined || second === undefined || output === undefined) return [];
    if (first.weightConfig === null || second.weightConfig === null || output.weightConfig === null) {
      this.report("fatal", "goal fuzzy interbreeding requires loaded item weights");
      return [];
    }
    return output.weightConfig.interbreedFrom(first.weightConfig, second.weightConfig,
      message => this.report("error", `${message}\n`));
  }

  mutateGoalFuzzyLogic(handle: number, _range?: number): void {
    const state = this.state(handle);
    if (state === undefined) return;
    if (state.weightConfig === null) { this.report("fatal", "goal fuzzy mutation requires loaded item weights"); return; }
    state.weightConfig.evolve(this.options.random);
  }

  // be_ai_goal.c:239-246 deliberately never calls WriteWeightConfig.
  saveGoalFuzzyLogic(handle: number, _filename?: string): void { this.state(handle); }

  pushGoal(handle: number, goal: BotGoal | Uint8Array | (() => BotGoal | Uint8Array)): void {
    const state = this.state(handle);
    if (state === undefined) return;
    if (state.stackTop >= MAX_GOAL_STACK - 1) {
      this.report("error", "goal heap overflow\n");
      this.dumpGoalStack(handle);
      return;
    }
    state.stackTop++;
    const input = typeof goal === "function" ? goal() : goal;
    state.writeGoal(state.stackTop, input);
  }
  popGoal(handle: number): void { const state = this.state(handle); if (state !== undefined && state.stackTop > 0) state.stackTop--; }
  emptyGoalStack(handle: number): void { const state = this.state(handle); if (state !== undefined) state.stackTop = 0; }
  getTopGoal(handle: number): BotGoal | null { const state = this.state(handle); return state === undefined || state.stackTop === 0 ? null : state.readGoal(state.stackTop); }
  getSecondGoal(handle: number): BotGoal | null { const state = this.state(handle); return state === undefined || state.stackTop <= 1 ? null : state.readGoal(state.stackTop - 1); }
  getTopGoalBytes(handle: number): Uint8Array | null { const state = this.state(handle); return state === undefined || state.stackTop === 0 ? null : state.goalBytes(state.stackTop); }
  getSecondGoalBytes(handle: number): Uint8Array | null { const state = this.state(handle); return state === undefined || state.stackTop <= 1 ? null : state.goalBytes(state.stackTop - 1); }
  dumpGoalStack(handle: number): readonly BotGoal[] {
    const state = this.state(handle), result: BotGoal[] = [];
    if (state === undefined) return result;
    for (let index = 1; index <= state.stackTop; index++) {
      const goal = state.readGoal(index);
      result.push(goal);
      this.options.log.write(`${index}: ${this.goalName(goal.number).slice(0, 31)}`);
    }
    return Object.freeze(result);
  }

  resetAvoidGoals(handle: number): void {
    const state = this.state(handle);
    if (state !== undefined) for (const goal of state.avoid) { goal.number = 0; goal.expires = 0; }
  }
  resetGoalState(handle: number): void {
    const state = this.state(handle);
    if (state === undefined) return;
    state.clearStack();
    for (const goal of state.avoid) { goal.number = 0; goal.expires = 0; }
  }
  setAvoidGoalTime(handle: number, number: number, duration: number): void {
    const state = this.state(handle);
    if (state === undefined) return;
    const time = Math.fround(duration);
    if (time < 0) {
      const item = this.findLevelItem(candidate => candidate.number === number);
      if (this.config !== null && item !== undefined) this.addAvoid(state, number, defaultAvoidTime(item.info));
      return;
    }
    this.addAvoid(state, number, time);
  }
  removeFromAvoidGoals(handle: number, number: number): void {
    const state = this.state(handle);
    if (state === undefined) return;
    const goal = state.avoid.find(candidate => candidate.number === number && candidate.expires >= this.now());
    if (goal !== undefined) goal.expires = 0;
  }
  avoidGoalTime(handle: number, number: number): number {
    const state = this.state(handle);
    if (state === undefined) return 0;
    const goal = state.avoid.find(candidate => candidate.number === number && candidate.expires >= this.now());
    return goal === undefined ? 0 : Math.fround(goal.expires - this.now());
  }
  dumpAvoidGoals(handle: number): readonly AvoidGoalDump[] {
    const state = this.state(handle);
    if (state === undefined) return [];
    const result: AvoidGoalDump[] = [];
    for (const goal of state.avoid) {
      if (!(goal.expires >= this.now())) continue;
      const name = this.goalName(goal.number).slice(0, 31);
      const remaining = Math.fround(goal.expires - this.now());
      result.push(Object.freeze({ number: goal.number, remaining }));
      this.options.log.write(`avoid goal ${name}, number ${goal.number} for ${goalFloatText(remaining, 6)} seconds`);
    }
    return Object.freeze(result);
  }

  shutdown(): void {
    this.generation++;
    this.setupRevision++;
    this.config?.free();
    this.config = null;
    this.world = null;
    if (this.levelItemHeap !== null) this.memory.free(this.levelItemHeap);
    this.levelItemHeap = null;
    this.levelHead = 0;
    this.freeLevelHead = 0;
    this.initialItemCount = 0;
    this.freeInfoEntities();
    for (let handle = 1; handle <= MAX_GOAL_STATES; handle++) if (this.states.has(handle)) this.freeGoalState(handle);
  }

  freeInfoEntities(): void {
    this.mapRevision++;
    for (let pointer = this.locationHead; pointer !== 0;) {
      const location = this.infoEntity(pointer);
      pointer = location.next;
      this.memory.free(location.allocation);
      this.infoEntities.delete(location.pointer);
    }
    this.locationHead = 0;
    for (let pointer = this.campHead; pointer !== 0;) {
      const camp = this.infoEntity(pointer);
      pointer = camp.next;
      this.memory.free(camp.allocation);
      this.infoEntities.delete(camp.pointer);
    }
    this.campHead = 0;
  }

  initInfoEntities(world: GoalWorld): void {
    this.freeInfoEntities();
    const revision = this.mapRevision, bsp = world.bspEntities;
    let locationCount = 0, campCount = 0;
    for (let entity = bsp.nextEntity(0); entity !== 0; entity = bsp.nextEntity(entity)) {
      const classname = bspString(bsp, entity, "classname");
      if (classname !== "target_location" && classname !== "info_camp") continue;
      if (this.nextInfoPointer > 0xffffffff) throw new RangeError("Goal info pointer IDs exhausted");
      if (classname === "target_location") {
        const location = new MapLocation(this.memory.allocate(MAP_LOCATION_BYTES, "heap", true), this.nextInfoPointer++);
        this.infoEntities.set(location.pointer, location);
        location.origin = bsp.vector(entity, "origin").value;
        location.readName(bsp, entity);
        const area = world.pointArea(location.origin);
        if (revision !== this.mapRevision) return;
        location.area = area;
        location.next = this.locationHead;
        this.locationHead = location.pointer;
        locationCount++;
      } else {
        const camp = new CampSpot(this.memory.allocate(CAMP_SPOT_BYTES, "heap", true), this.nextInfoPointer++);
        this.infoEntities.set(camp.pointer, camp);
        camp.origin = bsp.vector(entity, "origin").value;
        camp.readName(bsp, entity);
        camp.range = bsp.float(entity, "range").value; camp.weight = bsp.float(entity, "weight").value;
        camp.wait = bsp.float(entity, "wait").value; camp.random = bsp.float(entity, "random").value;
        const area = world.pointArea(camp.origin);
        if (revision !== this.mapRevision) return;
        camp.area = area;
        if (area === 0) {
          const origin = camp.origin;
          this.report("message", `camp spot at ${goalFloatText(origin.x, 1)} ${goalFloatText(origin.y, 1)} ${goalFloatText(origin.z, 1)} in solid\n`);
          if (revision !== this.mapRevision) return;
          this.memory.free(camp.allocation);
          this.infoEntities.delete(camp.pointer);
          continue;
        }
        camp.next = this.campHead;
        this.campHead = camp.pointer;
        campCount++;
      }
    }
    const developer = this.options.developer?.() ?? false;
    if (revision !== this.mapRevision) return;
    if (developer) {
      this.report("message", `${locationCount} map locations\n`);
      if (revision !== this.mapRevision) return;
      this.report("message", `${campCount} camp spots\n`);
    }
  }

  initLevelItems(world: GoalWorld | null = this.world): void {
    if (world === null) throw new Error("BotInitLevelItems requires a retained goal world");
    this.world = world;
    const revision = this.mapRevision + 1;
    this.initInfoEntities(world);
    if (revision !== this.mapRevision) return;
    if (this.levelItemHeap !== null) this.memory.free(this.levelItemHeap);
    const maximum = Math.trunc(finiteFloat(this.options.maxLevelItems?.() ?? 256, "max_levelitems"));
    if (revision !== this.mapRevision) return;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 0x7fffffff) throw new RangeError("maximum level items must be a positive signed 32-bit integer");
    this.levelItemHeap = this.memory.allocate(maximum * LEVEL_ITEM_BYTES, "heap", true);
    // Link words use one-based cell IDs; zero is the source NULL pointer.
    for (let pointer = 1; pointer < maximum; pointer++) this.levelItem(pointer).next = pointer + 1;
    this.freeLevelHead = 1;
    this.levelHead = 0;
    this.initialItemCount = 0;
    const config = this.config, navigation = world.navigation, bsp = world.bspEntities;
    if (config === null || navigation === null) return;
    for (const info of config.items) {
      if (info.modelIndex !== 0) continue;
      this.options.log.write(`item ${info.classname} has modelindex 0`);
      if (revision !== this.mapRevision) return;
    }
    for (let entity = bsp.nextEntity(0); entity !== 0; entity = bsp.nextEntity(entity)) {
      const classname = bspString(bsp, entity, "classname");
      if (classname === null) continue;
      const spawnFlags = bsp.int(entity, "spawnflags").value;
      const info = config.items.find(item => item.classname === classname);
      if (info === undefined) {
        this.options.log.write(`entity ${classname} unknown item\r\n`);
        if (revision !== this.mapRevision) return;
        continue;
      }
      const entityOrigin = bsp.vector(entity, "origin");
      if (!entityOrigin.found) {
        this.report("error", `item ${classname} without origin\n`);
        if (revision !== this.mapRevision) return;
        continue;
      }
      let origin = entityOrigin.value;
      const bounds = itemBounds(info);
      let goalArea = 0;
      if ((spawnFlags & 1) !== 0) {
        const contents = world.host.pointContents(origin);
        if (revision !== this.mapRevision) return;
        if ((contents & 32) === 0) {
          const end = add3(origin, vector(0, 0, -32));
          const trace = world.host.trace(origin, end, bounds, -1, 1 | 0x10000);
          if (revision !== this.mapRevision) return;
          if (trace.fraction >= 1) {
            goalArea = navigation.spatial.bestReachableFromJumpPadArea(origin, bounds);
            if (revision !== this.mapRevision) return;
            this.options.log.write(`item ${info.classname} reachable from jumppad area ${goalArea}\r\n`);
            if (revision !== this.mapRevision) return;
            if (goalArea === 0) continue;
          }
        }
      }
      const item = this.allocLevelItem();
      if (item === null) return;
      item.number = ++this.initialItemCount;
      item.timeout = 0; item.entity = 0; item.flags = 0;
      if (bsp.int(entity, "notfree").value !== 0) item.flags |= 1;
      if (bsp.int(entity, "notteam").value !== 0) item.flags |= 2;
      if (bsp.int(entity, "notsingle").value !== 0) item.flags |= 4;
      if (bsp.int(entity, "notbot").value !== 0) item.flags |= 8;
      if (classname === "item_botroam") { item.flags |= 16; item.weight = bsp.float(entity, "weight").value; }
      if ((spawnFlags & 1) === 0) {
        const dropped = navigation.spatial.dropToFloor(origin, bounds);
        if (revision !== this.mapRevision) return;
        origin = dropped.origin;
        if (!dropped.success) {
          this.report("message", `${classname} in solid at (${goalFloatText(origin.x, 1)} ${goalFloatText(origin.y, 1)} ${goalFloatText(origin.z, 1)})\n`);
          if (revision !== this.mapRevision) return;
        }
      }
      item.infoIndex = config.items.indexOf(info);
      item.origin = origin;
      const position = goalArea === 0 ? navigation.spatial.bestReachableArea(origin, bounds) : { area: goalArea, origin };
      if (revision !== this.mapRevision) return;
      item.goalArea = position.area; item.goalOrigin = position.origin;
      if (position.area === 0) {
        this.report("message", `${classname} not reachable for bots at (${goalFloatText(origin.x, 1)} ${goalFloatText(origin.y, 1)} ${goalFloatText(origin.z, 1)})\n`);
        if (revision !== this.mapRevision) return;
      }
      this.addLevelItem(item);
    }
    this.report("message", `found ${this.initialItemCount} level items\n`);
  }

  goalName(number: number): string { return this.config === null ? "" : this.findLevelItem(item => item.number === number)?.info.name ?? ""; }

  writeGoalName(number: number, found: (name: string) => undefined, missing: () => undefined): void {
    if (this.config === null) return;
    const item = this.findLevelItem(candidate => candidate.number === number);
    if (item === undefined) missing();
    else found(item.info.name);
  }

  /** Omitted prior means a zeroed C output struct; supplied prior preserves untouched itemInfo. */
  getLevelItemGoal(index: number, name: string | ((candidate: string) => boolean), prior: BotGoal = blankGoal()): BotGoal | null {
    if (this.config === null) return null;
    let pointer = this.levelHead;
    if (index >= 0) {
      const previous = this.findLevelItem(item => item.number === index);
      if (previous === undefined) return null;
      pointer = previous.next;
    }
    for (; pointer !== 0;) {
      const item = this.levelItem(pointer);
      if (this.allowed(item.flags) && (item.flags & 8) === 0 && goalNameMatches(name, item.info.name)) {
        return copyGoal({ ...prior, ...this.itemGoal(item), itemInfo: prior.itemInfo, flags: GoalFlags.Item | (item.timeout !== 0 ? GoalFlags.Dropped : 0) });
      }
      pointer = item.next;
    }
    return null;
  }

  /** Map and camp queries preserve prior number/flags/itemInfo, or initialize them to zero. */
  getMapLocationGoal(name: string | ((candidate: string) => boolean), prior: BotGoal = blankGoal()): BotGoal | null {
    for (let pointer = this.locationHead; pointer !== 0;) {
      const location = this.infoEntity(pointer);
      if (goalNameMatches(name, location.name)) return this.infoGoal(location, prior);
      pointer = location.next;
    }
    return null;
  }

  getNextCampSpotGoal(index: number, prior: BotGoal = blankGoal()): { readonly next: number; readonly goal: BotGoal } | null {
    if (!Number.isInteger(index)) throw new RangeError("camp spot index must be an integer");
    const position = Math.max(0, index);
    let remaining = position;
    for (let pointer = this.campHead; pointer !== 0;) {
      const camp = this.infoEntity(pointer);
      if (--remaining < 0) return { next: position + 1, goal: this.infoGoal(camp, prior) };
      pointer = camp.next;
    }
    return null;
  }

  findEntityForLevelItem(number: number): void {
    if (this.world === null || this.config === null) return;
    const item = this.findLevelItem(candidate => candidate.number === number);
    if (item === undefined) return;
    for (const entity of this.entityNumbers(this.world.host)) {
      const info = this.world.host.entityInfo(entity);
      if (info.modelIndex !== 0 && sameVector(info.origin, info.lastVisibleOrigin) && info.modelIndex === item.info.modelIndex && length3(sub3(item.origin, info.origin)) < 30) item.entity = entity;
    }
  }

  updateEntityItems(): void {
    for (let pointer = this.levelHead; pointer !== 0;) {
      const item = this.levelItem(pointer);
      pointer = item.next;
      if (item.timeout !== 0 && item.timeout < this.now()) { this.removeLevelItem(item); this.freeLevelItem(item); }
    }
    const world = this.world, config = this.config;
    if (world === null || config === null) return;
    const navigation = world.navigation;
    if (navigation === null) return;
    for (const entity of this.entityNumbers(world.host)) {
      const info = world.host.entityInfo(entity);
      if (info.type !== 2 || info.modelIndex === 0 || !sameVector(info.origin, info.lastVisibleOrigin)) continue;
      const existing = this.findLevelItem(item => item.entity !== 0 && item.entity === entity);
      if (existing !== undefined) {
        if (existing.info.modelIndex === info.modelIndex) { this.moveItem(existing, info.origin, navigation); continue; }
        this.removeLevelItem(existing); this.freeLevelItem(existing);
      }
      const unlinked = this.findLevelItem(item => item.entity === 0 && this.allowed(item.flags) && item.info.modelIndex === info.modelIndex && length3(sub3(item.origin, info.origin)) < 30);
      if (unlinked !== undefined) {
        unlinked.entity = entity;
        this.moveItem(unlinked, info.origin, navigation);
        if (this.options.debug) this.options.log.write(`linked item ${unlinked.info.classname} to an entity`);
        continue;
      }
      const itemInfo = config.items.find(item => item.modelIndex === info.modelIndex);
      if (itemInfo === undefined) continue;
      const item = this.allocLevelItem();
      if (item === null) continue;
      item.entity = entity; item.number = this.initialItemCount + entity;
      item.infoIndex = config.items.indexOf(itemInfo); item.origin = info.origin;
      const goal = navigation.spatial.bestReachableArea(item.origin, itemBounds(itemInfo));
      item.goalArea = goal.area; item.goalOrigin = goal.origin;
      const settings = navigation.spatial.world.areaSettings[goal.area];
      if (settings === undefined) throw new RangeError(`invalid item goal area ${goal.area}`);
      if ((settings.contents & 128) !== 0) { this.freeLevelItem(item); continue; }
      item.timeout = Math.fround(this.now() + 30);
      this.addLevelItem(item);
    }
  }

  chooseLTGItem(handle: number, origin: Vec3, inventory: WeightInventory, travelFlags: number): boolean {
    return this.chooseItem(handle, origin, inventory, travelFlags, { kind: "long" });
  }
  chooseNBGItem(handle: number, origin: Vec3, inventory: WeightInventory, travelFlags: number, longTermGoal: BotGoal | null, maxTime: number): boolean {
    return this.chooseItem(handle, origin, inventory, travelFlags, { kind: "nearby", longTermGoal, maxTime });
  }

  itemGoalInVisButNotVisible(viewer: number, eye: Vec3, _viewAngles: Vec3, goal: BotGoal): boolean {
    if ((goal.flags & GoalFlags.Item) === 0 || this.world === null) return false;
    // be_ai_goal.c:1647 adds mins to mins, not mins to maxs. Preserve its corner target.
    const middle = add3(goal.origin, scale3(add3(goal.mins, goal.mins), 0.5));
    if (this.world.host.trace(eye, middle, null, viewer, 1).fraction < 1 || goal.entity <= 0) return false;
    return this.world.host.entityInfo(goal.entity).lastUpdateTime < this.now() - 0.5;
  }

  private chooseItem(handle: number, origin: Vec3, inventory: WeightInventory, travelFlags: number, choice: { readonly kind: "long" } | { readonly kind: "nearby"; readonly longTermGoal: BotGoal | null; readonly maxTime: number }): boolean {
    const state = this.state(handle), world = this.world;
    if (state === undefined || state.weightConfig === null || world === null) return false;
    const navigation = world.navigation;
    if (navigation === null) return false;
    let area = navigation.spatial.reachabilityArea(origin, state.client);
    if (area === 0 || navigation.spatial.world.areaReachabilities(area).length === 0) area = state.lastReachabilityArea;
    state.lastReachabilityArea = area;
    if (area === 0) return false;
    const longTermTime = choice.kind === "nearby" && choice.longTermGoal !== null ? this.travelTime(navigation, area, origin, choice.longTermGoal.area, travelFlags) : 99999;
    if (this.config === null) return false;
    let bestWeight = 0, best: LevelItem | null = null;
    for (const item of this.levelItems()) {
      if (!this.allowed(item.flags) || (item.flags & 8) !== 0 || item.goalArea === 0 || (item.entity === 0 && (item.flags & 16) === 0)) continue;
      const indexes = state.weightIndexes;
      if (indexes === null) throw new RangeError("item weight indexes have not been initialized");
      const indexView = allocationView(indexes), offset = item.info.number * 4;
      if (!Number.isInteger(offset) || offset < 0 || offset + 4 > indexView.byteLength) throw new RangeError("item weight index is stale for the current item configuration");
      const index = indexView.getInt32(offset, true);
      if (index < 0) continue;
      let weight = state.weightConfig.evaluateUndecided(index, inventory, this.options.random);
      if (item.timeout !== 0) weight = Math.fround(weight + Math.fround(this.options.droppedWeight?.() ?? 1000));
      if ((item.flags & 16) !== 0) weight = Math.fround(weight * item.weight);
      if (!(weight > 0)) continue;
      const time = this.travelTime(navigation, area, origin, item.goalArea, travelFlags);
      if (time <= 0 || (choice.kind === "nearby" && !(time < Math.fround(choice.maxTime)))) continue;
      if (this.avoidGoalTime(handle, item.number) - time * 0.009 > 0) continue;
      weight = Math.fround(weight / (Math.fround(time) * 0.01));
      if (!(weight > bestWeight)) continue;
      if (choice.kind === "nearby") {
        // Source accepts an unreachable return leg (zero); dropped items skip the leg entirely.
        const back = choice.longTermGoal !== null && item.timeout === 0 ? this.travelTime(navigation, item.goalArea, item.goalOrigin, choice.longTermGoal.area, travelFlags) : 0;
        if (back > longTermTime) continue;
      }
      best = item; bestWeight = weight;
    }
    if (best === null) return false;
    this.addAvoid(state, best.number, best.timeout !== 0 ? 10 : defaultAvoidTime(best.info));
    this.pushGoal(handle, this.itemGoal(best));
    return true;
  }

  private travelTime(navigation: GoalNavigation, area: number, origin: Vec3, goalArea: number, travelFlags: number): number {
    const result = navigation.routing.route({ area, origin, goalArea, travelFlags });
    return result.kind === "found" ? result.travelTime : 0;
  }
  private allowed(flags: number): boolean { return (flags & (this.configuredGameType === 2 ? 4 : this.configuredGameType >= 3 ? 2 : 1)) === 0; }
  private levelItem(pointer: number): LevelItem {
    const heap = this.levelItemHeap;
    if (heap === null || !Number.isInteger(pointer) || pointer <= 0 || pointer * LEVEL_ITEM_BYTES > heap.bytes.length) {
      throw new RangeError("Invalid level item pointer");
    }
    return new LevelItem(heap, pointer, index => {
      const info = this.config?.items[index];
      if (info === undefined) throw new RangeError("level item info index is stale for the current item configuration");
      return info;
    });
  }
  private *levelItems(): Generator<LevelItem, void, unknown> {
    for (let pointer = this.levelHead; pointer !== 0;) {
      const item = this.levelItem(pointer);
      yield item;
      pointer = item.next;
    }
  }
  private findLevelItem(predicate: (item: LevelItem) => boolean): LevelItem | undefined {
    for (const item of this.levelItems()) if (predicate(item)) return item;
    return undefined;
  }
  private allocLevelItem(): LevelItem | null {
    if (this.freeLevelHead === 0) { this.report("fatal", "out of level items\n"); return null; }
    const item = this.levelItem(this.freeLevelHead);
    this.freeLevelHead = item.next;
    item.clear();
    return item;
  }
  private freeLevelItem(item: LevelItem): void { item.next = this.freeLevelHead; this.freeLevelHead = item.pointer; }
  private addLevelItem(item: LevelItem): void {
    if (this.levelHead !== 0) this.levelItem(this.levelHead).prev = item.pointer;
    item.prev = 0; item.next = this.levelHead; this.levelHead = item.pointer;
  }
  private removeLevelItem(item: LevelItem): void {
    if (item.prev !== 0) this.levelItem(item.prev).next = item.next;
    else this.levelHead = item.next;
    if (item.next !== 0) this.levelItem(item.next).prev = item.prev;
  }
  private infoEntity(pointer: number): MapLocation {
    const info = this.infoEntities.get(pointer);
    if (info === undefined) throw new RangeError("Invalid map info entity pointer");
    return info;
  }
  private itemGoal(item: LevelItem): BotGoal {
    return copyGoal({ origin: item.goalOrigin, area: item.goalArea, mins: item.info.mins, maxs: item.info.maxs, entity: item.entity, number: item.number, flags: GoalFlags.Item | (item.timeout !== 0 ? GoalFlags.Dropped : 0) | ((item.flags & 16) !== 0 ? GoalFlags.Roam : 0), itemInfo: item.info.number });
  }
  private infoGoal(info: MapLocation, prior: BotGoal): BotGoal { return copyGoal({ ...prior, origin: info.origin, area: info.area, entity: 0, mins: vector(-8, -8, -8), maxs: vector(8, 8, 8) }); }
  private moveItem(item: LevelItem, origin: Vec3, navigation: GoalNavigation): void {
    if (sameVector(item.origin, origin)) return;
    item.origin = origin;
    const position = navigation.spatial.bestReachableArea(item.origin, itemBounds(item.info));
    item.goalOrigin = position.origin; item.goalArea = position.area;
  }
  private *entityNumbers(host: GoalWorldHost): Generator<number, void, unknown> {
    let previous = 0;
    for (let entity = host.nextEntity(0); entity !== 0; entity = host.nextEntity(entity)) {
      if (!Number.isInteger(entity) || entity <= previous || entity > 1_000_000) throw new RangeError("AAS entity enumeration must increase within the configured entity range");
      yield entity;
      previous = entity;
    }
  }

  private addAvoid(state: GoalState, number: number, duration: number): void {
    // Source lines 751-774: expired slots use strict <, even when every slot is zero at time zero.
    const slot = state.avoid.find(goal => goal.number === number) ?? state.avoid.find(goal => goal.expires < this.now());
    if (slot !== undefined) { slot.number = number; slot.expires = Math.fround(this.now() + duration); }
  }
  private releaseWeights(state: GoalState): void {
    const config = state.weightConfig;
    if (config !== null) this.options.weightStore.free(config);
    const indexes = state.weightIndexes;
    if (indexes !== null) this.memory.free(indexes);
    state.weightConfig = null;
    state.weightIndexes = null;
    if (config !== null) {
      for (const other of this.states.values()) if (other.weightConfig === config) return;
      const id = this.references.configIds.get(config);
      if (id !== undefined) this.references.configs.delete(id);
      this.references.configIds.delete(config);
    }
  }
  private now(): number { return finiteFloat(this.options.clock(), "AAS time"); }
  private report(severity: GoalDiagnostic["severity"], message: string): void {
    const diagnostic = Object.freeze({ severity, message });
    this.reported.push(diagnostic);
    this.options.report?.(diagnostic);
  }
  private state(handle: number): GoalState | undefined {
    if (!Number.isInteger(handle) || handle <= 0 || handle > MAX_GOAL_STATES) { this.report("fatal", `goal state handle ${handle} out of range\n`); return undefined; }
    const state = this.states.get(handle);
    if (state === undefined) this.report("fatal", `invalid goal state ${handle}\n`);
    return state;
  }
}
