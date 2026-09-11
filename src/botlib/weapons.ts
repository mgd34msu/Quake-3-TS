/*
 * Bot weapon configuration and selection translated from id Software's
 * code/botlib/be_ai_weap.c and code/game/be_ai_weap.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { Vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import { ScriptLanguageError, type ScriptDiagnostic, type ScriptToken, type SourceLocation } from "../script/lexer.ts";
import { ScriptSourceReader, type ScriptPreprocessorOptions } from "../script/preprocessor.ts";
import { StructureReader, StructureFieldType, writeStructure, type StructureDefinition, type StructureField, type StructureFieldDefinition } from "../script/structure.ts";
import type { BotLog } from "./log.ts";
import {
  WeightConfigError,
  WeightConfigLoadError,
  type WeightConfig,
  type WeightConfigStore,
  type WeightInventory,
} from "./weights.ts";
import type { BotScriptReader } from "./script-sources.ts";
import { BotMemory, type BotMemoryAllocation } from "./memory.ts";

export const MAX_WEAPON_STATES = 64;
export const PROJECTILE_WINDOW_DAMAGE = 1;
export const PROJECTILE_RETURN = 2;
export const WEAPON_FIRE_RELEASED = 1;
export const DAMAGE_TYPE_IMPACT = 1;
export const DAMAGE_TYPE_RADIAL = 2;
export const DAMAGE_TYPE_VISIBLE = 4;

const DEFAULT_WEAPON_CAPACITY = 32;
const DEFAULT_PROJECTILE_CAPACITY = 32;
const MAX_CONFIG_PATH_BYTES = 63;

export enum WeaponLoadResult {
  NoError = 0,
  CannotLoadWeaponWeights = 11,
  CannotLoadWeaponConfig = 12,
}

export interface ProjectileInfo {
  readonly name: string;
  readonly model: string;
  readonly flags: number;
  readonly gravity: number;
  readonly damage: number;
  readonly radius: number;
  readonly visibleDamage: number;
  readonly damageType: number;
  readonly healthIncrease: number;
  readonly push: number;
  readonly detonation: number;
  readonly bounce: number;
  readonly bounceFriction: number;
  readonly bounceStop: number;
}

export interface WeaponInfo {
  readonly valid: boolean;
  readonly number: number;
  readonly name: string;
  readonly model: string;
  readonly level: number;
  readonly weaponInventoryIndex: number;
  readonly flags: number;
  readonly projectile: string;
  readonly projectileCount: number;
  readonly horizontalSpread: number;
  readonly verticalSpread: number;
  readonly speed: number;
  readonly acceleration: number;
  readonly recoil: Vec3;
  readonly offset: Vec3;
  readonly angleOffset: Vec3;
  readonly extraZVelocity: number;
  readonly ammoAmount: number;
  readonly ammoInventoryIndex: number;
  readonly activate: number;
  readonly reload: number;
  readonly spinUp: number;
  readonly spinDown: number;
  readonly projectileInfo: ProjectileInfo;
}

export interface WeaponConfig {
  readonly path: string;
  readonly weaponCapacity: number;
  readonly definedWeaponCount: number;
  readonly weapons: readonly (WeaponInfo | undefined)[];
  readonly projectiles: readonly ProjectileInfo[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  weaponBytes(index: number): Uint8Array;
  projectileBytes(index: number): Uint8Array;
  weaponInfo(index: number): WeaponInfo;
  free(): void;
}

export interface WeaponAiHost {
  readonly resolver: BotScriptReader;
  readonly weights: WeightConfigStore;
}

export interface WeaponAiOptions {
  readonly debug?: { readonly log: Pick<BotLog, "filePointer" | "flush"> };
  readonly memory?: BotMemory;
  readonly maxWeaponInfo?: number | (() => number);
  readonly maxProjectileInfo?: number | (() => number);
  readonly preprocessor?: ScriptPreprocessorOptions;
  readonly report?: (diagnostic: WeaponDiagnostic) => undefined;
}

export type WeaponDiagnosticSeverity = "message" | "warning" | "error" | "fatal";

export interface WeaponDiagnostic {
  readonly origin: "source" | "print";
  readonly severity: WeaponDiagnosticSeverity;
  readonly message: string;
  readonly location: SourceLocation;
}

class WeaponPrintDiagnostic {
  constructor(readonly severity: "warning" | "error", readonly message: string, readonly location: SourceLocation) {}
}

type WeaponPointer =
  | { readonly kind: "config"; readonly config: WeightConfig; references: number }
  | { readonly kind: "indexes"; readonly allocation: BotMemoryAllocation };

// Release32 pointer words identify typed records owned by this WeaponAi.
// They preserve borrowed configuration identity, not native addresses.
class WeaponPointers {
  private readonly records = new Map<number, WeaponPointer>();
  private readonly configs = new WeakMap<WeightConfig, number>();
  private next = 1;

  config(config: WeightConfig): number {
    const existing = this.configs.get(config);
    if (existing !== undefined) {
      const record = this.records.get(existing);
      if (record?.kind === "config") record.references++;
      else this.records.set(existing, { kind: "config", config, references: 1 });
      return existing;
    }
    const pointer = this.add({ kind: "config", config, references: 1 });
    this.configs.set(config, pointer);
    return pointer;
  }

  add(record: WeaponPointer): number {
    if (this.next > 0xffffffff) throw new RangeError("weapon pointer IDs exhausted");
    const pointer = this.next++;
    this.records.set(pointer, record);
    return pointer;
  }

  resolve(pointer: number): WeaponPointer | undefined {
    if (pointer === 0) return undefined;
    const record = this.records.get(pointer);
    if (record === undefined) throw new Error(`invalid weapon pointer ${pointer}`);
    return record;
  }

  forgetIndexes(pointer: number): void { this.records.delete(pointer); }

  releaseConfig(pointer: number): void {
    const record = this.resolve(pointer);
    if (record === undefined) return;
    if (record.kind !== "config") throw new Error("weapon configuration pointer has wrong type");
    if (--record.references === 0) this.records.delete(pointer);
  }
}

class WeaponState {
  revision = 0;
  constructor(readonly allocation: BotMemoryAllocation, private readonly pointers: WeaponPointers) {}

  private get view(): DataView {
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get config(): WeightConfig | undefined {
    const record = this.pointers.resolve(this.view.getUint32(0, true));
    if (record === undefined) return undefined;
    if (record.kind !== "config") throw new Error("weapon configuration pointer has wrong type");
    return record.config;
  }
  set config(config: WeightConfig | undefined) {
    const view = this.view;
    const pointer = config === undefined ? 0 : this.pointers.config(config);
    this.pointers.releaseConfig(view.getUint32(0, true));
    view.setUint32(0, pointer, true);
  }
  get indexPointer(): number { return this.view.getUint32(4, true); }
  set indexPointer(pointer: number) { this.view.setUint32(4, pointer, true); }
  get indexes(): BotMemoryAllocation | undefined {
    const record = this.pointers.resolve(this.indexPointer);
    if (record === undefined) return undefined;
    if (record.kind !== "indexes") throw new Error("weapon index pointer has wrong type");
    return record.allocation;
  }

  reset(): void {
    const view = this.view;
    const config = view.getUint32(0, true), indexes = view.getUint32(4, true);
    view.setUint32(0, config, true);
    view.setUint32(4, indexes, true);
  }
}

function location(path: string, line = 1, column = 1): SourceLocation {
  return Object.freeze({ path, line, column });
}

function vector(x = 0, y = 0, z = 0): Vec3 {
  return Object.freeze({ x: Math.fround(x), y: Math.fround(y), z: Math.fround(z) });
}

function emptyProjectile(): ProjectileInfo {
  return Object.freeze({
    name: "",
    model: "",
    flags: 0,
    gravity: 0,
    damage: 0,
    radius: 0,
    visibleDamage: 0,
    damageType: 0,
    healthIncrease: 0,
    push: 0,
    detonation: 0,
    bounce: 0,
    bounceFriction: 0,
    bounceStop: 0,
  });
}

const EMPTY_PROJECTILE = emptyProjectile();

function emptyWeapon(): WeaponInfo {
  return Object.freeze({
    valid: false,
    number: 0,
    name: "",
    model: "",
    level: 0,
    weaponInventoryIndex: 0,
    flags: 0,
    projectile: "",
    projectileCount: 0,
    horizontalSpread: 0,
    verticalSpread: 0,
    speed: 0,
    acceleration: 0,
    recoil: vector(),
    offset: vector(),
    angleOffset: vector(),
    extraZVelocity: 0,
    ammoAmount: 0,
    ammoInventoryIndex: 0,
    activate: 0,
    reload: 0,
    spinUp: 0,
    spinDown: 0,
    projectileInfo: EMPTY_PROJECTILE,
  });
}

const EMPTY_WEAPON = emptyWeapon();

function overlayVector(current: Vec3, values: readonly number[]): Vec3 {
  const first = values[0];
  const second = values[1];
  const third = values[2];
  return vector(
    first === undefined ? current.x : first,
    second === undefined ? current.y : second,
    third === undefined ? current.z : third,
  );
}

function sourceCapacity(value: number | undefined, fallback: number, label: string): {
  readonly value: number;
  readonly corrected: boolean;
} {
  if (value === undefined) {
    return Object.freeze({ value: fallback, corrected: false });
  }
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${label} must be a finite integer`);
  }
  if (value < 0) {
    return Object.freeze({ value: fallback, corrected: true });
  }
  if (value > 0x7fffffff) {
    throw new RangeError(`${label} must fit a source signed 32-bit integer`);
  }
  return Object.freeze({ value, corrected: false });
}

function freezeWeapon(weapon: WeaponInfo, projectileInfo: ProjectileInfo, valid: boolean): WeaponInfo {
  return Object.freeze({
    ...weapon,
    valid,
    recoil: vector(weapon.recoil.x, weapon.recoil.y, weapon.recoil.z),
    offset: vector(weapon.offset.x, weapon.offset.y, weapon.offset.z),
    angleOffset: vector(weapon.angleOffset.x, weapon.angleOffset.y, weapon.angleOffset.z),
    projectileInfo: Object.freeze({ ...projectileInfo }),
  });
}


// be_ai_weap.c and be_ai_weap.h, selected 32-bit source layout.
const WEAPON_CONFIG_BYTES = 16;
const WEAPON_INFO_BYTES = 552;
const PROJECTILE_INFO_BYTES = 208;

function dumpField(name: string, offset: number, type: number, maxarray = 0): StructureFieldDefinition {
  return { name, offset, type, maxarray, floatmin: 0, floatmax: 0, substruct: null };
}

const projectileDumpDefinition: StructureDefinition = {
  size: PROJECTILE_INFO_BYTES,
  fields: [
    dumpField("name", 0, StructureFieldType.String),
    dumpField("model", 88, StructureFieldType.String),
    dumpField("flags", 160, StructureFieldType.Int),
    dumpField("gravity", 164, StructureFieldType.Float),
    dumpField("damage", 168, StructureFieldType.Int),
    dumpField("radius", 172, StructureFieldType.Float),
    dumpField("visdamage", 176, StructureFieldType.Int),
    dumpField("damagetype", 180, StructureFieldType.Int),
    dumpField("healthinc", 184, StructureFieldType.Int),
    dumpField("push", 188, StructureFieldType.Float),
    dumpField("detonation", 192, StructureFieldType.Float),
    dumpField("bounce", 196, StructureFieldType.Float),
    dumpField("bouncefric", 200, StructureFieldType.Float),
    dumpField("bouncestop", 204, StructureFieldType.Float),
  ],
};

const weaponDumpDefinition: StructureDefinition = {
  size: WEAPON_INFO_BYTES,
  fields: [
    dumpField("number", 4, StructureFieldType.Int),
    dumpField("name", 8, StructureFieldType.String),
    dumpField("level", 168, StructureFieldType.Int),
    dumpField("model", 88, StructureFieldType.String),
    dumpField("weaponindex", 172, StructureFieldType.Int),
    dumpField("flags", 176, StructureFieldType.Int),
    dumpField("projectile", 180, StructureFieldType.String),
    dumpField("numprojectiles", 260, StructureFieldType.Int),
    dumpField("hspread", 264, StructureFieldType.Float),
    dumpField("vspread", 268, StructureFieldType.Float),
    dumpField("speed", 272, StructureFieldType.Float),
    dumpField("acceleration", 276, StructureFieldType.Float),
    dumpField("recoil", 280, StructureFieldType.Float | StructureFieldType.Array, 3),
    dumpField("offset", 292, StructureFieldType.Float | StructureFieldType.Array, 3),
    dumpField("angleoffset", 304, StructureFieldType.Float | StructureFieldType.Array, 3),
    dumpField("extrazvelocity", 316, StructureFieldType.Float),
    dumpField("ammoamount", 320, StructureFieldType.Int),
    dumpField("ammoindex", 324, StructureFieldType.Int),
    dumpField("activate", 328, StructureFieldType.Float),
    dumpField("reload", 332, StructureFieldType.Float),
    dumpField("spinup", 336, StructureFieldType.Float),
    dumpField("spindown", 340, StructureFieldType.Float),
  ],
};

class WeaponConfigCell {
  constructor(private readonly allocation: BotMemoryAllocation, private readonly offset: number) {}
  private get view(): DataView {
    const bytes = this.allocation.bytes;
    return new DataView(bytes.buffer, bytes.byteOffset + this.offset, bytes.byteLength - this.offset);
  }
  int(offset: number): number { return this.view.getInt32(offset, true); }
  setInt(offset: number, value: number): void { this.view.setInt32(offset, value, true); }
  float(offset: number): number { return this.view.getFloat32(offset, true); }
  setFloat(offset: number, value: number): void { this.view.setFloat32(offset, value, true); }
  text(offset: number): string {
    const bytes = this.allocation.bytes.subarray(this.offset + offset, this.offset + offset + 80);
    let result = "";
    for (const byte of bytes) { if (byte === 0) break; result += String.fromCharCode(byte); }
    return result;
  }
  setText(offset: number, value: string): void {
    const bytes = this.allocation.bytes.subarray(this.offset + offset, this.offset + offset + 80);
    bytes.fill(0);
    for (let index = 0; index < Math.min(value.length, 79); index++) {
      const byte = value.charCodeAt(index);
      if (byte === 0) break;
      if (byte > 255) throw new RangeError("weapon configuration strings require source bytes");
      bytes[index] = byte;
    }
  }
  vector(offset: number): Vec3 {
    const view = this.view;
    return vector(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
  }
  setVector(offset: number, value: Vec3): void {
    const view = this.view;
    view.setFloat32(offset, value.x, true);
    view.setFloat32(offset + 4, value.y, true);
    view.setFloat32(offset + 8, value.z, true);
  }
}

function projectileConfigView(allocation: BotMemoryAllocation, offset: number) {
  const cell = new WeaponConfigCell(allocation, offset);
  return {
    get name(): string { return cell.text(0); },
    set name(value: string) { cell.setText(0, value); },
    get model(): string { return cell.text(80); },
    set model(value: string) { cell.setText(80, value); },
    get flags(): number { return cell.int(160); },
    set flags(value: number) { cell.setInt(160, value); },
    get gravity(): number { return cell.float(164); },
    set gravity(value: number) { cell.setFloat(164, value); },
    get damage(): number { return cell.int(168); },
    set damage(value: number) { cell.setInt(168, value); },
    get radius(): number { return cell.float(172); },
    set radius(value: number) { cell.setFloat(172, value); },
    get visibleDamage(): number { return cell.int(176); },
    set visibleDamage(value: number) { cell.setInt(176, value); },
    get damageType(): number { return cell.int(180); },
    set damageType(value: number) { cell.setInt(180, value); },
    get healthIncrease(): number { return cell.int(184); },
    set healthIncrease(value: number) { cell.setInt(184, value); },
    get push(): number { return cell.float(188); },
    set push(value: number) { cell.setFloat(188, value); },
    get detonation(): number { return cell.float(192); },
    set detonation(value: number) { cell.setFloat(192, value); },
    get bounce(): number { return cell.float(196); },
    set bounce(value: number) { cell.setFloat(196, value); },
    get bounceFriction(): number { return cell.float(200); },
    set bounceFriction(value: number) { cell.setFloat(200, value); },
    get bounceStop(): number { return cell.float(204); },
    set bounceStop(value: number) { cell.setFloat(204, value); },
  };
}

function weaponConfigView(allocation: BotMemoryAllocation, offset: number) {
  const cell = new WeaponConfigCell(allocation, offset);
  const projectileInfo = Object.freeze(projectileConfigView(allocation, offset + 344));
  return {
    get valid(): boolean { return cell.int(0) !== 0; },
    set valid(value: boolean) { cell.setInt(0, value ? 1 : 0); },
    get number(): number { return cell.int(4); },
    set number(value: number) { cell.setInt(4, value); },
    get name(): string { return cell.text(8); },
    set name(value: string) { cell.setText(8, value); },
    get model(): string { return cell.text(88); },
    set model(value: string) { cell.setText(88, value); },
    get level(): number { return cell.int(168); },
    set level(value: number) { cell.setInt(168, value); },
    get weaponInventoryIndex(): number { return cell.int(172); },
    set weaponInventoryIndex(value: number) { cell.setInt(172, value); },
    get flags(): number { return cell.int(176); },
    set flags(value: number) { cell.setInt(176, value); },
    get projectile(): string { return cell.text(180); },
    set projectile(value: string) { cell.setText(180, value); },
    get projectileCount(): number { return cell.int(260); },
    set projectileCount(value: number) { cell.setInt(260, value); },
    get horizontalSpread(): number { return cell.float(264); },
    set horizontalSpread(value: number) { cell.setFloat(264, value); },
    get verticalSpread(): number { return cell.float(268); },
    set verticalSpread(value: number) { cell.setFloat(268, value); },
    get speed(): number { return cell.float(272); },
    set speed(value: number) { cell.setFloat(272, value); },
    get acceleration(): number { return cell.float(276); },
    set acceleration(value: number) { cell.setFloat(276, value); },
    get recoil(): Vec3 { return cell.vector(280); },
    set recoil(value: Vec3) { cell.setVector(280, value); },
    get offset(): Vec3 { return cell.vector(292); },
    set offset(value: Vec3) { cell.setVector(292, value); },
    get angleOffset(): Vec3 { return cell.vector(304); },
    set angleOffset(value: Vec3) { cell.setVector(304, value); },
    get extraZVelocity(): number { return cell.float(316); },
    set extraZVelocity(value: number) { cell.setFloat(316, value); },
    get ammoAmount(): number { return cell.int(320); },
    set ammoAmount(value: number) { cell.setInt(320, value); },
    get ammoInventoryIndex(): number { return cell.int(324); },
    set ammoInventoryIndex(value: number) { cell.setInt(324, value); },
    get activate(): number { return cell.float(328); },
    set activate(value: number) { cell.setFloat(328, value); },
    get reload(): number { return cell.float(332); },
    set reload(value: number) { cell.setFloat(332, value); },
    get spinUp(): number { return cell.float(336); },
    set spinUp(value: number) { cell.setFloat(336, value); },
    get spinDown(): number { return cell.float(340); },
    set spinDown(value: number) { cell.setFloat(340, value); },
    get projectileInfo(): ProjectileInfo { return projectileInfo; },
    set projectileInfo(value: ProjectileInfo) { Object.assign(projectileInfo, value); },
  };
}

class WeaponConfigTokens {
  private unreadToken: ScriptToken | undefined;
  constructor(private readonly source: ScriptSourceReader) {}
  get diagnostics(): readonly ScriptDiagnostic[] { return this.source.diagnostics; }
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
}

class RetiredWeaponSetup extends Error {}

class WeaponConfigParser {
  private readonly preprocessor: WeaponConfigTokens;
  private readonly reader: StructureReader;
  private readonly path: string;
  private readonly weaponCapacity: number;
  private readonly projectileCapacity: number;
  private readonly allocation: BotMemoryAllocation;

  constructor(
    preprocessor: WeaponConfigTokens,
    path: string,
    weaponCapacity: number,
    projectileCapacity: number,
    allocation: BotMemoryAllocation,
    private readonly completeSource: () => void,
    private readonly freeConfig: () => void,
  ) {
    this.preprocessor = preprocessor;
    this.reader = new StructureReader(preprocessor, path, preprocessor.diagnostics);
    this.path = path;
    this.weaponCapacity = weaponCapacity;
    this.projectileCapacity = projectileCapacity;
    this.allocation = allocation;
  }

  parse(): WeaponConfig {
    // The fixup loop reads only the four-byte valid flag for an unused record.
    const availableWeapons = Math.floor((this.allocation.bytes.length - WEAPON_CONFIG_BYTES + WEAPON_INFO_BYTES - 4) / WEAPON_INFO_BYTES);
    const weapons = new Array<WeaponInfo | undefined>(Math.min(this.weaponCapacity, availableWeapons)).fill(undefined);
    const projectiles: ProjectileInfo[] = [];
    while (true) {
      const definition = this.preprocessor.next();
      if (definition === undefined) {
        break;
      }
      if (definition.text === "weaponinfo") {
        const weapon = this.readWeapon();
        if (weapon.number < 0 || weapon.number >= this.weaponCapacity) {
          this.fail(`weapon info number ${weapon.number} out of range in ${this.path}`, definition.location);
        }
        const offset = WEAPON_CONFIG_BYTES + weapon.number * WEAPON_INFO_BYTES;
        this.allocation.bytes.fill(0, offset, offset + WEAPON_INFO_BYTES);
        const stored = weaponConfigView(this.allocation, offset);
        Object.assign(stored, weapon);
        stored.valid = true;
        weapons[weapon.number] = Object.freeze(stored);
      } else if (definition.text === "projectileinfo") {
        const header = new WeaponConfigCell(this.allocation, 0);
        const count = header.int(4);
        if (count >= this.projectileCapacity) {
          this.fail(
            `more than ${this.projectileCapacity} projectiles defined in ${this.path}`,
            definition.location,
          );
        }
        const offset = ((WEAPON_CONFIG_BYTES + Math.imul(this.weaponCapacity, WEAPON_INFO_BYTES)) >>> 0) + count * PROJECTILE_INFO_BYTES;
        projectiles.push(this.readProjectile(offset));
        header.setInt(4, count + 1);
      } else {
        this.fail(`unknown definition ${definition.text} in ${this.path}`, definition.location);
      }
    }

    this.completeSource();
    let definedWeaponCount = 0;
    for (let index = 0; index < weapons.length; index++) {
      const weapon = weapons[index];
      if (weapon === undefined) {
        continue;
      }
      definedWeaponCount++;
      if (weapon.name.length === 0) {
        this.fail(`weapon ${index} has no name in ${this.path}`, location(this.path));
      }
      if (weapon.projectile.length === 0) {
        this.fail(`weapon ${weapon.name} has no projectile in ${this.path}`, location(this.path));
      }
      const projectileIndex = projectiles.findIndex((candidate) => candidate.name === weapon.projectile);
      if (projectileIndex < 0) {
        this.fail(`weapon ${weapon.name} uses undefined projectile in ${this.path}`, location(this.path));
      }
      const bytes = this.allocation.bytes;
      const projectileOffset = ((WEAPON_CONFIG_BYTES + Math.imul(this.weaponCapacity, WEAPON_INFO_BYTES)) >>> 0) + projectileIndex * PROJECTILE_INFO_BYTES;
      bytes.copyWithin(WEAPON_CONFIG_BYTES + index * WEAPON_INFO_BYTES + 344, projectileOffset, projectileOffset + PROJECTILE_INFO_BYTES);
    }
    if (weapons.length < this.weaponCapacity) {
      throw new RangeError("weapon validation exceeds the source configuration allocation");
    }
    const diagnostics = [...this.preprocessor.diagnostics];
    if (this.weaponCapacity === 0) {
      diagnostics.push(new WeaponPrintDiagnostic("warning", "no weapon info loaded", location(this.path)));
    }
    const allocation = this.allocation;
    const weaponOffset = (index: number): number => {
      const start = WEAPON_CONFIG_BYTES + index * WEAPON_INFO_BYTES;
      if (!Number.isInteger(index) || start < WEAPON_CONFIG_BYTES || start + WEAPON_INFO_BYTES > allocation.bytes.length) {
        throw new RangeError("weapon info copy exceeds the source configuration allocation");
      }
      return start;
    };
    return Object.freeze({
      path: this.path,
      get weaponCapacity(): number { return new WeaponConfigCell(allocation, 0).int(0); },
      definedWeaponCount,
      weapons: Object.freeze(weapons),
      projectiles: Object.freeze(projectiles),
      diagnostics: Object.freeze(diagnostics),
      weaponBytes(index: number): Uint8Array {
        const start = weaponOffset(index);
        return allocation.bytes.subarray(start, start + WEAPON_INFO_BYTES);
      },
      projectileBytes(index: number): Uint8Array {
        const start = ((WEAPON_CONFIG_BYTES + Math.imul(this.weaponCapacity, WEAPON_INFO_BYTES)) >>> 0) + index * PROJECTILE_INFO_BYTES;
        if (!Number.isInteger(index) || index < 0 || index >= this.projectiles.length || start + PROJECTILE_INFO_BYTES > allocation.bytes.length) {
          throw new RangeError("projectile dump exceeds the source configuration allocation");
        }
        return allocation.bytes.subarray(start, start + PROJECTILE_INFO_BYTES);
      },
      weaponInfo(index: number): WeaponInfo { return Object.freeze(weaponConfigView(allocation, weaponOffset(index))); },
      free: this.freeConfig,
    });
  }

  private readProjectile(offset: number): ProjectileInfo {
    const bytes = this.allocation.bytes;
    if (offset < 0 || offset + PROJECTILE_INFO_BYTES > bytes.length) {
      throw new RangeError("projectile clear exceeds the source configuration allocation");
    }
    bytes.fill(0, offset, offset + PROJECTILE_INFO_BYTES);
    const projectile = projectileConfigView(this.allocation, offset);
    this.reader.begin();
    while (true) {
      const field = this.reader.nextField();
      if (field === undefined) {
        return Object.freeze(projectile);
      }
      switch (field.name) {
        case "name": projectile.name = this.reader.readString(); break;
        // be_ai_weap.c uses WEAPON_OFS(model), eight bytes past projectile.model.
        case "model": new WeaponConfigCell(this.allocation, offset).setText(88, this.reader.readString()); break;
        case "flags": projectile.flags = this.reader.readInt(); break;
        case "gravity": projectile.gravity = this.reader.readFloat(); break;
        case "damage": projectile.damage = this.reader.readInt(); break;
        case "radius": projectile.radius = this.reader.readFloat(); break;
        case "visdamage": projectile.visibleDamage = this.reader.readInt(); break;
        case "damagetype": projectile.damageType = this.reader.readInt(); break;
        case "healthinc": projectile.healthIncrease = this.reader.readInt(); break;
        case "push": projectile.push = this.reader.readFloat(); break;
        case "detonation": projectile.detonation = this.reader.readFloat(); break;
        case "bounce": projectile.bounce = this.reader.readFloat(); break;
        case "bouncefric": projectile.bounceFriction = this.reader.readFloat(); break;
        case "bouncestop": projectile.bounceStop = this.reader.readFloat(); break;
        default: this.reader.rejectField(field);
      }
    }
  }

  private readWeapon(): WeaponInfo {
    const weapon = {
      ...EMPTY_WEAPON,
      recoil: vector(),
      offset: vector(),
      angleOffset: vector(),
    };
    this.reader.begin();
    while (true) {
      const field = this.reader.nextField();
      if (field === undefined) {
        return freezeWeapon(weapon, EMPTY_PROJECTILE, false);
      }
      this.readWeaponField(weapon, field);
    }
  }

  private readWeaponField(weapon: {
    valid: boolean;
    number: number;
    name: string;
    model: string;
    level: number;
    weaponInventoryIndex: number;
    flags: number;
    projectile: string;
    projectileCount: number;
    horizontalSpread: number;
    verticalSpread: number;
    speed: number;
    acceleration: number;
    recoil: Vec3;
    offset: Vec3;
    angleOffset: Vec3;
    extraZVelocity: number;
    ammoAmount: number;
    ammoInventoryIndex: number;
    activate: number;
    reload: number;
    spinUp: number;
    spinDown: number;
    projectileInfo: ProjectileInfo;
  }, field: StructureField): void {
    switch (field.name) {
      case "number": weapon.number = this.reader.readInt(); break;
      case "name": weapon.name = this.reader.readString(); break;
      case "level": weapon.level = this.reader.readInt(); break;
      case "model": weapon.model = this.reader.readString(); break;
      case "weaponindex": weapon.weaponInventoryIndex = this.reader.readInt(); break;
      case "flags": weapon.flags = this.reader.readInt(); break;
      case "projectile": weapon.projectile = this.reader.readString(); break;
      case "numprojectiles": weapon.projectileCount = this.reader.readInt(); break;
      case "hspread": weapon.horizontalSpread = this.reader.readFloat(); break;
      case "vspread": weapon.verticalSpread = this.reader.readFloat(); break;
      case "speed": weapon.speed = this.reader.readFloat(); break;
      case "acceleration": weapon.acceleration = this.reader.readFloat(); break;
      case "recoil": weapon.recoil = overlayVector(weapon.recoil, this.reader.readFloatArray(3)); break;
      case "offset": weapon.offset = overlayVector(weapon.offset, this.reader.readFloatArray(3)); break;
      case "angleoffset": weapon.angleOffset = overlayVector(weapon.angleOffset, this.reader.readFloatArray(3)); break;
      case "extrazvelocity": weapon.extraZVelocity = this.reader.readFloat(); break;
      case "ammoamount": weapon.ammoAmount = this.reader.readInt(); break;
      case "ammoindex": weapon.ammoInventoryIndex = this.reader.readInt(); break;
      case "activate": weapon.activate = this.reader.readFloat(); break;
      case "reload": weapon.reload = this.reader.readFloat(); break;
      case "spinup": weapon.spinUp = this.reader.readFloat(); break;
      case "spindown": weapon.spinDown = this.reader.readFloat(); break;
      default: this.reader.rejectField(field);
    }
  }

  private fail(message: string, failureLocation: SourceLocation): never {
    const diagnostic = new WeaponPrintDiagnostic("error", message, Object.freeze({ ...failureLocation }));
    throw new ScriptLanguageError(diagnostic, [...this.reader.diagnostics, diagnostic]);
  }
}

function loadConfig(
  resolver: BotScriptReader,
  path: string,
  weaponCapacity: number,
  projectileCapacity: number,
  options: ScriptPreprocessorOptions,
  memory: BotMemory,
  reportDiagnostics: (diagnostics: readonly ScriptDiagnostic[]) => boolean,
  diagnosticCallbackAborted: () => boolean,
): WeaponConfig {
  const source = resolver.resolveRoot(path);
  if (source === undefined) {
    throw new Error(`counldn't load ${path}`);
  }
  if (source.path.length === 0) {
    throw new Error("weapon config resolver returned an empty canonical path");
  }
  const reportedDiagnostics = new Set<ScriptDiagnostic>();
  const reportPendingDiagnostics = (diagnostics: readonly ScriptDiagnostic[]): boolean => {
    const pending = diagnostics.filter(diagnostic => !reportedDiagnostics.has(diagnostic));
    const reported = reportDiagnostics(pending);
    for (const diagnostic of pending) reportedDiagnostics.add(diagnostic);
    return reported;
  };
  let preprocessor: WeaponConfigTokens;
  try {
    preprocessor = new WeaponConfigTokens(ScriptSourceReader.open(source, resolver, {
      ...options, globals: resolver.globals,
      report: diagnostic => {
        options.report?.(diagnostic);
        if (!reportPendingDiagnostics([diagnostic])) throw new RetiredWeaponSetup();
      },
    }));
  } catch (error) {
    if (!diagnosticCallbackAborted() && error instanceof ScriptLanguageError) reportPendingDiagnostics(error.diagnostics);
    throw error;
  }
  const size = (WEAPON_CONFIG_BYTES + Math.imul(weaponCapacity, WEAPON_INFO_BYTES) + Math.imul(projectileCapacity, PROJECTILE_INFO_BYTES)) | 0;
  const allocation = memory.allocate(size, "hunk", true);
  const header = new WeaponConfigCell(allocation, 0);
  header.setInt(0, weaponCapacity);
  // Managed pointers are allocation-relative offsets in the selected 32-bit layout.
  header.setInt(8, WEAPON_CONFIG_BYTES + Math.imul(weaponCapacity, WEAPON_INFO_BYTES));
  header.setInt(12, WEAPON_CONFIG_BYTES);
  try {
    const config = new WeaponConfigParser(preprocessor, source.path, weaponCapacity, projectileCapacity, allocation, () => {
      if (!reportPendingDiagnostics(preprocessor.diagnostics)) throw new RetiredWeaponSetup();
      preprocessor.dispose();
    }, () => memory.free(allocation)).parse();
    if (!reportPendingDiagnostics(config.diagnostics)) throw new RetiredWeaponSetup();
    return config;
  } catch (error) {
    if (!diagnosticCallbackAborted() && error instanceof ScriptLanguageError && reportPendingDiagnostics(error.diagnostics)) {
      memory.free(allocation);
      preprocessor.dispose();
    }
    throw error;
  }
}

export class WeaponAi {
  private readonly memory: BotMemory;
  private readonly pointers = new WeaponPointers();
  private readonly host: WeaponAiHost;
  private readonly maxWeaponInfo: number | (() => number);
  private readonly maxProjectileInfo: number | (() => number);
  private readonly preprocessorOptions: ScriptPreprocessorOptions;
  private readonly report: ((diagnostic: WeaponDiagnostic) => undefined) | undefined;
  private readonly states: (WeaponState | undefined)[] = Array.from(
    { length: MAX_WEAPON_STATES + 1 },
    (): WeaponState | undefined => undefined,
  );
  private readonly reported: WeaponDiagnostic[] = [];
  private currentConfig: WeaponConfig | undefined;
  private generation = 0;
  private setupRevision = 0;
  private readonly debug: WeaponAiOptions["debug"];

  constructor(host: WeaponAiHost, options: WeaponAiOptions = {}) {
    this.host = host;
    this.debug = options.debug;
    this.memory = options.memory ?? new BotMemory();
    this.report = options.report;
    const weapons = typeof options.maxWeaponInfo === "function"
      ? options.maxWeaponInfo
      : sourceCapacity(options.maxWeaponInfo, DEFAULT_WEAPON_CAPACITY, "maxWeaponInfo");
    const projectiles = typeof options.maxProjectileInfo === "function"
      ? options.maxProjectileInfo
      : sourceCapacity(options.maxProjectileInfo, DEFAULT_PROJECTILE_CAPACITY, "maxProjectileInfo");
    this.maxWeaponInfo = typeof weapons === "function" ? weapons : weapons.value;
    this.maxProjectileInfo = typeof projectiles === "function" ? projectiles : projectiles.value;
    this.preprocessorOptions = options.preprocessor ?? {};
    if (typeof weapons !== "function" && weapons.corrected) {
      this.emit("error", `max_weaponinfo = ${options.maxWeaponInfo}`, "<weapon-ai>");
    }
    if (typeof projectiles !== "function" && projectiles.corrected) {
      this.emit("error", `max_projectileinfo = ${options.maxProjectileInfo}`, "<weapon-ai>");
    }
  }

  get config(): WeaponConfig | undefined {
    return this.currentConfig;
  }

  get diagnostics(): readonly WeaponDiagnostic[] {
    return Object.freeze([...this.reported]);
  }

  setup(path = "weapons.c"): WeaponLoadResult {
    this.validateConfigPath(path);
    const generation = this.generation;
    const revision = ++this.setupRevision;
    const current = (): boolean => generation === this.generation && revision === this.setupRevision;
    const weaponValue = typeof this.maxWeaponInfo === "function" ? this.maxWeaponInfo() : this.maxWeaponInfo;
    if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
    const weapons = sourceCapacity(weaponValue, DEFAULT_WEAPON_CAPACITY, "maxWeaponInfo");
    if (weapons.corrected) {
      this.emit("error", `max_weaponinfo = ${weaponValue}`, "<weapon-ai>");
      if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
    }
    const projectileValue = typeof this.maxProjectileInfo === "function" ? this.maxProjectileInfo() : this.maxProjectileInfo;
    if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
    const projectiles = sourceCapacity(projectileValue, DEFAULT_PROJECTILE_CAPACITY, "maxProjectileInfo");
    if (projectiles.corrected) {
      this.emit("error", `max_projectileinfo = ${projectileValue}`, "<weapon-ai>");
      if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
    }
    let diagnosticCallbackAborted = false;
    let config: WeaponConfig;
    try {
      config = loadConfig(
        this.host.resolver,
        path,
        weapons.value,
        projectiles.value,
        {
          ...this.preprocessorOptions,
          ...(this.host.resolver.debugEval === undefined ? {} : { debugEval: (text: string) => {
            try { this.host.resolver.debugEval?.(text); }
            catch (error) { diagnosticCallbackAborted = true; throw error; }
          } }),
          report: diagnostic => {
            try { this.preprocessorOptions.report?.(diagnostic); }
            catch (error) { diagnosticCallbackAborted = true; throw error; }
          },
        },
        this.memory,
        diagnostics => {
          try { return this.appendScriptDiagnostics(diagnostics, current); }
          catch (error) { diagnosticCallbackAborted = true; throw error; }
        },
        () => diagnosticCallbackAborted,
      );
    } catch (error) {
      if (diagnosticCallbackAborted || error instanceof CommonError) throw error;
      if (!current()) {
        return WeaponLoadResult.CannotLoadWeaponConfig;
      }
      if (!(error instanceof ScriptLanguageError)) {
        this.emit("error", error instanceof Error ? error.message : String(error), path);
      }
      if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
      this.currentConfig = undefined;
      this.emit("fatal", "couldn't load the weapon config", path);
      return WeaponLoadResult.CannotLoadWeaponConfig;
    }
    if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
    this.emit("message", `loaded ${config.path}`, config.path);
    if (!current()) return WeaponLoadResult.CannotLoadWeaponConfig;
    this.currentConfig = config;
    if (this.debug !== undefined) {
      const file = this.debug.log.filePointer();
      if (file !== null) {
        const write = (text: string): number => file.write(text) ?? text.length;
        for (let index = 0; index < config.projectiles.length; index++) {
          writeStructure(write, projectileDumpDefinition, config.projectileBytes(index));
          this.debug.log.flush();
        }
        for (let index = 0; index < config.weaponCapacity; index++) {
          writeStructure(write, weaponDumpDefinition, config.weaponBytes(index));
          this.debug.log.flush();
        }
      }
    }
    return WeaponLoadResult.NoError;
  }

  allocateState(): number {
    for (let handle = 1; handle <= MAX_WEAPON_STATES; handle++) {
      if (this.states[handle] === undefined) {
        this.states[handle] = new WeaponState(this.memory.allocate(8, "heap", true), this.pointers);
        return handle;
      }
    }
    return 0;
  }

  freeState(handle: number): void {
    const state = this.state(handle);
    if (state === undefined) {
      return;
    }
    state.revision++;
    this.releaseWeights(state);
    this.memory.free(state.allocation);
    this.states[handle] = undefined;
  }

  freeWeights(handle: number): void {
    const state = this.state(handle);
    if (state === undefined) {
      return;
    }
    state.revision++;
    this.releaseWeights(state);
  }

  resetState(handle: number): void {
    this.state(handle)?.reset();
  }

  loadWeights(handle: number, sourcePath: string | (() => string)): WeaponLoadResult {
    const state = this.state(handle);
    if (state === undefined) {
      return WeaponLoadResult.CannotLoadWeaponWeights;
    }
    state.revision++;
    const revision = state.revision;
    const generation = this.generation;
    this.releaseWeights(state);
    const path = typeof sourcePath === "function" ? sourcePath() : sourcePath;
    let weights: WeightConfig;
    try {
      weights = this.host.weights.load(path);
    } catch (error) {
      if (!(error instanceof WeightConfigError) && !(error instanceof WeightConfigLoadError)) throw error;
      if (generation !== this.generation || this.states[handle] !== state || state.revision !== revision) {
        return WeaponLoadResult.CannotLoadWeaponWeights;
      }
      this.emit("fatal", `couldn't load weapon config ${path}`, path);
      return WeaponLoadResult.CannotLoadWeaponWeights;
    }
    if (generation !== this.generation || this.states[handle] !== state || state.revision !== revision) {
      this.host.weights.free(weights);
      return WeaponLoadResult.CannotLoadWeaponWeights;
    }
    state.config = weights;
    const config = this.currentConfig;
    if (config === undefined) {
      return WeaponLoadResult.CannotLoadWeaponConfig;
    }
    const indexes = this.memory.allocate(config.weaponCapacity * 4, "heap", true);
    for (let index = 0; index < config.weaponCapacity; index++) {
      const weapon = config.weapons[index];
      const weightIndex = weights.find(weapon === undefined ? "" : weapon.name);
      const bytes = indexes.bytes;
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(index * 4, weightIndex, true);
    }
    state.indexPointer = this.pointers.add({ kind: "indexes", allocation: indexes });
    return WeaponLoadResult.NoError;
  }

  private weaponInfoConfig(handle: number, weaponNumber: number): WeaponConfig | undefined {
    const config = this.currentConfig;
    if (config === undefined) {
      return undefined;
    }
    if (!Number.isInteger(weaponNumber) || weaponNumber <= 0 || weaponNumber > config.weaponCapacity) {
      this.emit("error", "weapon number out of range", config.path);
      return undefined;
    }
    if (this.state(handle) === undefined) {
      return undefined;
    }
    return config;
  }

  weaponInfoBytes(handle: number, weaponNumber: number): Uint8Array | undefined {
    return this.weaponInfoConfig(handle, weaponNumber)?.weaponBytes(weaponNumber);
  }

  getWeaponInfo(handle: number, weaponNumber: number): WeaponInfo | undefined {
    const config = this.weaponInfoConfig(handle, weaponNumber);
    if (config === undefined) return undefined;
    const weapon = config.weaponInfo(weaponNumber);
    return freezeWeapon(weapon, weapon.projectileInfo, weapon.valid);
  }

  chooseBestFightWeapon(handle: number, inventory: WeightInventory): number {
    const state = this.state(handle);
    const config = this.currentConfig;
    if (state === undefined || config === undefined || state.config === undefined) {
      return 0;
    }
    let bestWeight = Math.fround(0);
    let bestWeapon = 0;
    for (let index = 0; index < config.weaponCapacity; index++) {
      const weapon = config.weapons[index];
      if (weapon === undefined || !weapon.valid) {
        continue;
      }
      const indexes = state.indexes;
      if (indexes === undefined) return bestWeapon;
      const bytes = indexes.bytes;
      // Retain the managed bound for a setup that grows the weapon table.
      if (index * 4 >= bytes.byteLength) continue;
      const weightIndex = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(index * 4, true);
      if (weightIndex < 0) {
        continue;
      }
      const weights = state.config;
      if (weights === undefined) return bestWeapon;
      const weight = weights.evaluate(weightIndex, inventory);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestWeapon = index;
      }
    }
    return bestWeapon;
  }

  shutdown(): void {
    this.generation++;
    this.setupRevision++;
    this.currentConfig?.free();
    this.currentConfig = undefined;
    for (let handle = 1; handle <= MAX_WEAPON_STATES; handle++) {
      const state = this.states[handle];
      if (state !== undefined) {
        state.revision++;
        this.releaseWeights(state);
        this.memory.free(state.allocation);
        this.states[handle] = undefined;
      }
    }
  }

  private releaseWeights(state: WeaponState): void {
    const config = state.config;
    if (config !== undefined) {
      this.host.weights.free(config);
      // Source leaves dangling pointers. Retain the existing managed clear
      // after each successful free, without hiding a later failure's residue.
      state.config = undefined;
    }
    const indexes = state.indexes;
    if (indexes !== undefined) {
      this.memory.free(indexes);
      this.pointers.forgetIndexes(state.indexPointer);
      state.indexPointer = 0;
    }
  }

  private state(handle: number): WeaponState | undefined {
    if (!Number.isInteger(handle) || handle <= 0 || handle > MAX_WEAPON_STATES) {
      this.emit("fatal", `move state handle ${handle} out of range`, "<weapon-ai>");
      return undefined;
    }
    const state = this.states[handle];
    if (state === undefined) {
      this.emit("fatal", `invalid move state ${handle}`, "<weapon-ai>");
    }
    return state;
  }

  private validateConfigPath(path: string): void {
    if (path.length === 0) {
      throw new RangeError("weapon config path cannot be empty");
    }
    if (path.length > MAX_CONFIG_PATH_BYTES) {
      throw new RangeError(`weapon config path cannot exceed ${MAX_CONFIG_PATH_BYTES} source bytes`);
    }
    for (let index = 0; index < path.length; index++) {
      if (path.charCodeAt(index) > 255) throw new RangeError("weapon config path requires source byte-valued characters");
    }
  }

  private appendScriptDiagnostics(diagnostics: readonly ScriptDiagnostic[], current: () => boolean): boolean {
    for (const diagnostic of diagnostics) {
      if (!current()) return false;
      const duplicate = this.reported.some((candidate) => candidate.severity === diagnostic.severity
        && candidate.message === diagnostic.message
        && candidate.location.path === diagnostic.location.path
        && candidate.location.line === diagnostic.location.line
        && candidate.location.column === diagnostic.location.column);
      const reported: WeaponDiagnostic = Object.freeze({
        origin: diagnostic instanceof WeaponPrintDiagnostic ? "print" : "source",
        severity: diagnostic.severity,
        message: diagnostic.message,
        location: Object.freeze({ ...diagnostic.location }),
      });
      if (!duplicate) this.reported.push(reported);
      this.report?.(reported);
    }
    return current();
  }

  private emit(severity: WeaponDiagnosticSeverity, message: string, path: string): void {
    const diagnostic: WeaponDiagnostic = Object.freeze({ origin: "print", severity, message, location: location(path) });
    this.reported.push(diagnostic);
    this.report?.(diagnostic);
  }
}
