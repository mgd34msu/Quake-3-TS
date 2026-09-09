// Port of id Software's code/qcommon/msg.c state field tables and delta codecs.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import { bitsToFloat32, float32ToBits } from "../core/numeric.ts";
import type { Vec3 } from "../core/math.ts";
import { copyEntityStateFields, EntityStateRecord } from "../shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../shared/entity-state.ts";
import type { Product } from "../shared/definitions.ts";
import { ENTITYNUM_NONE, PlayerStateRecord } from "../shared/player-state.ts";
import type { PlayerStateFields, PlayerStateSlots, SourcePlayerState } from "../shared/player-state.ts";
import { MessageReader, MessageWriter } from "./message.ts";

export const ENTITY_NUMBER_BITS = 10;
export const MAX_ENTITIES = 1 << ENTITY_NUMBER_BITS;
const FLOAT_INT_BITS = 13;
const FLOAT_INT_BIAS = 4096;

export interface DeltaMessageDiagnostics {
  readonly shownet: () => number;
  readonly print: (message: string) => undefined;
  readonly offset: number;
}

function diagnosticBitPosition(reader: MessageReader, offset: number): number {
  const bit = reader.bitPosition + offset * 8;
  const count = reader.readCount + offset;
  return bit === 0 ? count * 8 - ENTITY_NUMBER_BITS : (count - 1) * 8 + bit - ENTITY_NUMBER_BITS;
}

/** Linux Com_Printf uses C-locale %f: six decimal places, rounded to nearest/even. */
function diagnosticFloat(bits: number): string {
  const exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff;
  const sign = (bits >>> 31) === 0 ? "" : "-";
  if (exponent === 255) return `${sign}${fraction === 0 ? "inf" : "nan"}`;
  const coefficient = BigInt(exponent === 0 ? fraction : fraction | 0x800000) * 1000000n;
  const shift = exponent === 0 ? -149 : exponent - 150;
  let rounded: bigint;
  if (shift >= 0) rounded = coefficient << BigInt(shift);
  else {
    const divisor = 1n << BigInt(-shift), quotient = coefficient / divisor, twiceRemainder = 2n * (coefficient % divisor);
    rounded = quotient + (twiceRemainder > divisor || (twiceRemainder === divisor && (quotient & 1n) !== 0n) ? 1n : 0n);
  }
  return `${sign}${rounded / 1000000n}.${(rounded % 1000000n).toString().padStart(6, "0")}`;
}

interface NetField<T> {
  readonly name: string;
  readonly bits: number;
  readonly get: (state: Readonly<T>) => number;
  readonly set: (state: T, value: number) => void;
}

function entityInteger(key: "eType" | "eFlags" | "time" | "time2" | "otherEntityNum" | "otherEntityNum2" | "groundEntityNum" | "constantLight" | "loopSound" | "modelindex" | "modelindex2" | "clientNum" | "frame" | "solid" | "event" | "eventParm" | "powerups" | "weapon" | "legsAnim" | "torsoAnim" | "generic1", bits: number): NetField<EntityStateFields> {
  return { name: key, bits, get: (s) => s[key], set: (s, value) => { s[key] = value; } };
}

function vectorField<T>(name: string, get: (state: Readonly<T>) => Vec3, set: (state: T, value: Vec3) => void, axis: keyof Vec3, bits = 0): NetField<T> {
  return { name, bits, get: (s) => get(s)[axis], set: (s, value) => { set(s, { ...get(s), [axis]: value }); } };
}

function trajectoryInteger(key: "pos" | "apos", component: "type" | "time" | "duration", sourceName: string, bits: number): NetField<EntityStateFields> {
  return {
    name: `${key}.${sourceName}`, bits, get: (s) => s[key][component],
    set: (s, value) => {
      const trajectory = s[key];
      s[key] = { ...trajectory, [component]: value };
    },
  };
}

function trajectoryVector(key: "pos" | "apos", component: "base" | "delta", axis: keyof Vec3, index: number): NetField<EntityStateFields> {
  return vectorField(`${key}.${component === "base" ? "trBase" : "trDelta"}[${index}]`, (s: Readonly<EntityStateFields>) => s[key][component], (s, vector) => { s[key] = { ...s[key], [component]: vector }; }, axis);
}

function entityVector(key: "origin" | "origin2" | "angles" | "angles2", axis: keyof Vec3, index: number): NetField<EntityStateFields> {
  return vectorField(`${key}[${index}]`, (s: Readonly<EntityStateFields>) => s[key], (s, vector) => { s[key] = vector; }, axis);
}

const ENTITY_FIELDS: readonly NetField<EntityStateFields>[] = [
  trajectoryInteger("pos", "time", "trTime", 32),
  trajectoryVector("pos", "base", "x", 0), trajectoryVector("pos", "base", "y", 1),
  trajectoryVector("pos", "delta", "x", 0), trajectoryVector("pos", "delta", "y", 1),
  trajectoryVector("pos", "base", "z", 2), trajectoryVector("apos", "base", "y", 1),
  trajectoryVector("pos", "delta", "z", 2), trajectoryVector("apos", "base", "x", 0),
  entityInteger("event", 10), entityVector("angles2", "y", 1), entityInteger("eType", 8),
  entityInteger("torsoAnim", 8), entityInteger("eventParm", 8), entityInteger("legsAnim", 8),
  entityInteger("groundEntityNum", 10), trajectoryInteger("pos", "type", "trType", 8),
  entityInteger("eFlags", 19), entityInteger("otherEntityNum", 10), entityInteger("weapon", 8),
  entityInteger("clientNum", 8), entityVector("angles", "y", 1), trajectoryInteger("pos", "duration", "trDuration", 32),
  trajectoryInteger("apos", "type", "trType", 8), entityVector("origin", "x", 0),
  entityVector("origin", "y", 1), entityVector("origin", "z", 2), entityInteger("solid", 24),
  entityInteger("powerups", 16), entityInteger("modelindex", 8), entityInteger("otherEntityNum2", 10),
  entityInteger("loopSound", 8), entityInteger("generic1", 8), entityVector("origin2", "z", 2),
  entityVector("origin2", "x", 0), entityVector("origin2", "y", 1), entityInteger("modelindex2", 8),
  entityVector("angles", "x", 0), entityInteger("time", 32), trajectoryInteger("apos", "time", "trTime", 32),
  trajectoryInteger("apos", "duration", "trDuration", 32), trajectoryVector("apos", "base", "z", 2),
  trajectoryVector("apos", "delta", "x", 0), trajectoryVector("apos", "delta", "y", 1),
  trajectoryVector("apos", "delta", "z", 2), entityInteger("time2", 32), entityVector("angles", "z", 2),
  entityVector("angles2", "x", 0), entityVector("angles2", "z", 2), entityInteger("constantLight", 32), entityInteger("frame", 16),
];

function playerInteger(key: "commandTime" | "bobCycle" | "weaponTime" | "legsTimer" | "pmTime" | "eventSequence" | "torsoAnim" | "movementDir" | "legsAnim" | "pmFlags" | "groundEntityNum" | "weaponState" | "eFlags" | "externalEvent" | "gravity" | "speed" | "externalEventParm" | "viewheight" | "damageEvent" | "damageYaw" | "damagePitch" | "damageCount" | "generic1" | "pmType" | "torsoTimer" | "clientNum" | "weapon" | "jumppadEnt" | "loopSound", bits: number, name: string = key): NetField<PlayerStateFields> {
  return { name, bits, get: (s) => s[key], set: (s, value) => { s[key] = value; } };
}

function playerVector(key: "origin" | "velocity" | "viewangles" | "deltaAngles" | "grapplePoint", axis: keyof Vec3, index: number, bits = 0): NetField<PlayerStateFields> {
  return vectorField(`${key === "deltaAngles" ? "delta_angles" : key}[${index}]`, (s: Readonly<PlayerStateFields>) => s[key], (s, vector) => { s[key] = vector; }, axis, bits);
}

function playerEvent(key: "events" | "eventParms", index: number): NetField<PlayerStateFields> {
  return { name: `${key}[${index}]`, bits: 8, get: (s) => s[key].get(index), set: (s, value) => { s[key].set(index, value); } };
}

const PLAYER_FIELDS: readonly NetField<PlayerStateFields>[] = [
  playerInteger("commandTime", 32), playerVector("origin", "x", 0), playerVector("origin", "y", 1),
  playerInteger("bobCycle", 8), playerVector("velocity", "x", 0), playerVector("velocity", "y", 1),
  playerVector("viewangles", "y", 1), playerVector("viewangles", "x", 0), playerInteger("weaponTime", -16),
  playerVector("origin", "z", 2), playerVector("velocity", "z", 2), playerInteger("legsTimer", 8),
  playerInteger("pmTime", -16, "pm_time"), playerInteger("eventSequence", 16), playerInteger("torsoAnim", 8),
  playerInteger("movementDir", 4), playerEvent("events", 0), playerInteger("legsAnim", 8), playerEvent("events", 1),
  playerInteger("pmFlags", 16, "pm_flags"), playerInteger("groundEntityNum", 10),
  playerInteger("weaponState", 4, "weaponstate"),
  playerInteger("eFlags", 16), playerInteger("externalEvent", 10), playerInteger("gravity", 16),
  playerInteger("speed", 16), playerVector("deltaAngles", "y", 1, 16), playerInteger("externalEventParm", 8),
  playerInteger("viewheight", -8), playerInteger("damageEvent", 8), playerInteger("damageYaw", 8),
  playerInteger("damagePitch", 8), playerInteger("damageCount", 8), playerInteger("generic1", 8),
  playerInteger("pmType", 8, "pm_type"),
  playerVector("deltaAngles", "x", 0, 16), playerVector("deltaAngles", "z", 2, 16), playerInteger("torsoTimer", 12),
  playerEvent("eventParms", 0), playerEvent("eventParms", 1), playerInteger("clientNum", 8),
  playerInteger("weapon", 5),
  playerVector("viewangles", "z", 2), playerVector("grapplePoint", "x", 0), playerVector("grapplePoint", "y", 1),
  playerVector("grapplePoint", "z", 2), playerInteger("jumppadEnt", 10, "jumppad_ent"), playerInteger("loopSound", 16),
];

/** Wire metadata is exposed without mutable getter/setter tables. */
export function stateDeltaFields(kind: "entity" | "player"): readonly { readonly name: string; readonly bits: number }[] {
  return (kind === "entity" ? ENTITY_FIELDS : PLAYER_FIELDS).map(({ name, bits }) => ({ name, bits }));
}

function rawValue<T>(field: NetField<T>, state: Readonly<T>): number {
  const value = field.get(state);
  return field.bits === 0 ? float32ToBits(value) : value | 0;
}

function lastChanged<T>(fields: readonly NetField<T>[], from: Readonly<T>, to: Readonly<T>): number {
  let last = 0;
  for (const [i, field] of fields.entries()) if (rawValue(field, from) !== rawValue(field, to)) last = i + 1;
  return last;
}

function writeField<T>(writer: MessageWriter, field: NetField<T>, from: Readonly<T>, to: Readonly<T>, entity: boolean): void {
  const changed = rawValue(field, from) !== rawValue(field, to);
  writer.writeBits(changed ? 1 : 0, 1);
  if (!changed) return;
  const value = field.bits === 0 ? Math.fround(field.get(to)) : field.get(to) | 0;
  if (entity) {
    writer.writeBits(value === 0 ? 0 : 1, 1);
    if (value === 0) {
      if (field.bits === 0) writer.sourceState?.addOldsize(FLOAT_INT_BITS);
      return;
    }
  }
  if (field.bits !== 0) {
    writer.writeBits(value, field.bits);
    return;
  }
  const compact = Number.isInteger(value) && value >= -FLOAT_INT_BIAS && value < FLOAT_INT_BIAS;
  writer.writeBits(compact ? 0 : 1, 1);
  if (compact) writer.writeBits(value + FLOAT_INT_BIAS, FLOAT_INT_BITS);
  else writer.writeFloat(value);
}

function readField<T>(reader: MessageReader, field: NetField<T>, from: Readonly<T>, state: T, entity: boolean, diagnostics: DeltaMessageDiagnostics | null): void {
  if (reader.readBits(1) === 0) { field.set(state, field.get(from)); return; }
  let value: number;
  let text: string | null = null;
  if (entity && reader.readBits(1) === 0) value = 0;
  else if (field.bits !== 0) {
    value = reader.readBits(field.bits);
    text = String(value | 0);
  } else if (reader.readBits(1) === 0) {
    value = reader.readBits(FLOAT_INT_BITS) - FLOAT_INT_BIAS;
    text = String(value);
  } else {
    const bits = reader.readBits(32);
    value = bitsToFloat32(bits);
    if (diagnostics !== null) text = diagnosticFloat(bits);
  }
  field.set(state, value);
  if (diagnostics !== null && text !== null) diagnostics.print(`${field.name}:${text} `);
}

function checkEntityNumber(number: number): void {
  if (!Number.isInteger(number) || number < 0 || number >= MAX_ENTITIES) throw new RangeError(`Bad delta entity number ${number}`);
}

export function writeDeltaEntity(writer: MessageWriter, from: Readonly<EntityStateFields> | null, to: Readonly<EntityStateFields> | null, force = false): void {
  if (to === null) {
    if (from === null) return;
    checkEntityNumber(from.number);
    writer.writeBits(from.number, ENTITY_NUMBER_BITS);
    writer.writeBits(1, 1);
    return;
  }
  checkEntityNumber(to.number);
  const baseline = from === null ? new EntityStateRecord<number>(0) : from;
  const last = lastChanged(ENTITY_FIELDS, baseline, to);
  if (last === 0 && !force) return;
  writer.writeBits(to.number, ENTITY_NUMBER_BITS);
  writer.writeBits(0, 1);
  writer.writeBits(last === 0 ? 0 : 1, 1);
  if (last === 0) return;
  writer.writeByte(last);
  writer.sourceState?.addOldsize(ENTITY_FIELDS.length);
  for (const field of ENTITY_FIELDS.slice(0, last)) writeField(writer, field, baseline, to, true);
}

export function readDeltaEntity(reader: MessageReader, from: Readonly<EntityStateFields>, number: number, diagnostics?: DeltaMessageDiagnostics | null): SourceEntityState;
export function readDeltaEntity(reader: MessageReader, from: Readonly<EntityStateFields>, number: number, diagnostics: DeltaMessageDiagnostics | null, destination: EntityStateFields): EntityStateFields;
export function readDeltaEntity(reader: MessageReader, from: Readonly<EntityStateFields>, number: number, diagnostics: DeltaMessageDiagnostics | null = null, destination: EntityStateFields = new EntityStateRecord<number>(0)): EntityStateFields {
  checkEntityNumber(number);
  const offset = diagnostics === null ? 0 : diagnostics.offset;
  const startBit = diagnosticBitPosition(reader, offset);
  if (reader.readBits(1) !== 0) {
    copyEntityStateFields(destination, new EntityStateRecord<number>(0));
    destination.number = ENTITYNUM_NONE;
    if (diagnostics !== null && (diagnostics.shownet() >= 2 || diagnostics.shownet() === -1)) {
      diagnostics.print(`${String(reader.readCount + offset).padStart(3)}: #${String(number).padEnd(3)} remove\n`);
    }
    return destination;
  }
  if (reader.readBits(1) === 0) {
    copyEntityStateFields(destination, from);
    destination.number = number;
    return destination;
  }
  const last = reader.readByte();
  const printing = diagnostics !== null && (diagnostics.shownet() >= 2 || diagnostics.shownet() === -1) ? diagnostics : null;
  if (printing !== null) printing.print(`${String(reader.readCount + offset).padStart(3)}: #${String(destination.number | 0).padEnd(3)} `);
  destination.number = number;
  if (last > ENTITY_FIELDS.length) throw new BinaryError(reader.source, reader.readCount, `Invalid entity last field ${last}`);
  for (const field of ENTITY_FIELDS.slice(0, last)) readField(reader, field, from, destination, true, printing);
  for (const field of ENTITY_FIELDS.slice(last)) field.set(destination, field.get(from));
  if (printing !== null) printing.print(` (${diagnosticBitPosition(reader, offset) - startBit} bits)\n`);
  return destination;
}

interface SlotField {
  readonly key: "stats" | "persistant" | "ammo" | "powerups";
  readonly width: 16 | 32;
}
const SLOT_FIELDS: readonly SlotField[] = [{ key: "stats", width: 16 }, { key: "persistant", width: 16 }, { key: "ammo", width: 16 }, { key: "powerups", width: 32 }];

function slotMask(from: PlayerStateSlots, to: PlayerStateSlots): number {
  let bits = 0;
  for (let i = 0; i < 16; i++) if (from.get(i) !== to.get(i)) bits |= 1 << i;
  return bits;
}

function copyPlayerState(from: Readonly<PlayerStateFields>): SourcePlayerState {
  const result = new PlayerStateRecord<number, number, number>(from.product, 0, 0, 0);
  result.copyFrom(from);
  return result;
}

export function writeDeltaPlayerState(writer: MessageWriter, from: Readonly<PlayerStateFields> | null, to: Readonly<PlayerStateFields>): void {
  if (from !== null && from.product !== to.product) throw new RangeError("Player delta cannot cross products");
  const baseline = from === null ? new PlayerStateRecord<number, number, number>(to.product, 0, 0, 0) : from;
  const last = lastChanged(PLAYER_FIELDS, baseline, to);
  writer.writeByte(last);
  writer.sourceState?.addOldsize(PLAYER_FIELDS.length - last);
  for (const field of PLAYER_FIELDS.slice(0, last)) writeField(writer, field, baseline, to, false);
  const changed = SLOT_FIELDS.some(({ key }) => slotMask(baseline[key], to[key]) !== 0);
  writer.writeBits(changed ? 1 : 0, 1);
  if (!changed) { writer.sourceState?.addOldsize(4); return; }
  for (const { key, width } of SLOT_FIELDS) {
    const mask = slotMask(baseline[key], to[key]);
    writer.writeBits(mask === 0 ? 0 : 1, 1);
    if (mask === 0) continue;
    writer.writeShort(mask);
    for (let i = 0; i < 16; i++) if (mask & (1 << i)) writer.writeBits(to[key].get(i), width);
  }
}

export function readDeltaPlayerState(reader: MessageReader, from: Readonly<PlayerStateFields> | null, product: Product, diagnostics: DeltaMessageDiagnostics | null = null): SourcePlayerState {
  if (from !== null && from.product !== product) throw new RangeError("Player delta cannot cross products");
  const baseline = from === null ? new PlayerStateRecord<number, number, number>(product, 0, 0, 0) : from;
  const result = copyPlayerState(baseline);
  const offset = diagnostics === null ? 0 : diagnostics.offset;
  const startBit = diagnosticBitPosition(reader, offset);
  const printing = diagnostics !== null && (diagnostics.shownet() >= 2 || diagnostics.shownet() === -2) ? diagnostics : null;
  if (printing !== null) printing.print(`${String(reader.readCount + offset).padStart(3)}: playerstate `);
  const last = reader.readByte();
  if (last > PLAYER_FIELDS.length) throw new BinaryError(reader.source, reader.readCount, `Invalid player last field ${last}`);
  for (const field of PLAYER_FIELDS.slice(0, last)) readField(reader, field, baseline, result, false, printing);
  for (const field of PLAYER_FIELDS.slice(last)) field.set(result, field.get(baseline));
  if (reader.readBits(1) !== 0) {
    for (const { key, width } of SLOT_FIELDS) {
      if (reader.readBits(1) === 0) continue;
      if (diagnostics !== null && diagnostics.shownet() === 4) diagnostics.print(`PS_${key.toUpperCase()} `);
      const mask = reader.readShort();
      for (let i = 0; i < 16; i++) if (mask & (1 << i)) result[key].set(i, width === 16 ? reader.readShort() : reader.readLong());
    }
  }
  if (printing !== null) printing.print(` (${diagnosticBitPosition(reader, offset) - startBit} bits)\n`);
  return result;
}
