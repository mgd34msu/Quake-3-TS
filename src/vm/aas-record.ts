/*
 * AAS VM records from id Software's code/game/be_aas.h and botlib/be_aas_*.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { AasAreaInfo } from "../botlib/aas-runtime.ts";
import type { AasClientMoveOutput } from "../botlib/aas-movement.ts";
import type { AasEntityInfo } from "../botlib/entity.ts";
import type { AasRoutePredictionOutput, AlternativeGoal } from "../botlib/routing.ts";
import type { AasTrace } from "../botlib/spatial.ts";
import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";
import type { QvmMemory } from "./memory.ts";

export const QVM_AAS_ENTITY_INFO_BYTES = 140;
export const QVM_AAS_AREA_INFO_BYTES = 52;
export const QVM_AAS_TRACE_BYTES = 36;
export const QVM_AAS_CLIENT_MOVE_BYTES = 84;
export const QVM_AAS_PREDICT_ROUTE_BYTES = 36;
export const QVM_AAS_ALTERNATIVE_GOAL_BYTES = 24;

function requireRecord(view: DataView, length: number): void {
  if (view.byteLength < length) throw new BinaryError("QVM AAS record", 0,
    `record requires ${length} bytes, received ${view.byteLength}`);
}

/** Offsets apply after VM_ArgPtr masks the pointer once. */
export function qvmAasField(bytes: Uint8Array | null, offset: number, length: number): DataView {
  if (bytes === null) throw new RangeError("QVM AAS field requires a nonnull pointer");
  if (offset < 0 || offset + length > bytes.byteLength) throw new RangeError("QVM AAS field exceeds allocation");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

export function qvmAasVector(bytes: Uint8Array | null, offset = 0): Vec3 {
  return {
    get x(): number { return qvmAasField(bytes, offset, 4).getFloat32(0, true); },
    get y(): number { return qvmAasField(bytes, offset + 4, 4).getFloat32(0, true); },
    get z(): number { return qvmAasField(bytes, offset + 8, 4).getFloat32(0, true); },
  };
}

function writeVector(view: DataView, offset: number, value: Vec3): void {
  view.setFloat32(offset, value.x, true);
  view.setFloat32(offset + 4, value.y, true);
  view.setFloat32(offset + 8, value.z, true);
}

export function writeQvmAasVector(bytes: Uint8Array | null, offset: number, value: Vec3): void {
  qvmAasField(bytes, offset, 4).setFloat32(0, value.x, true);
  qvmAasField(bytes, offset + 4, 4).setFloat32(0, value.y, true);
  qvmAasField(bytes, offset + 8, 4).setFloat32(0, value.z, true);
}

export function writeQvmAasEntityInfo(view: DataView, info: AasEntityInfo): void {
  requireRecord(view, QVM_AAS_ENTITY_INFO_BYTES);
  view.setInt32(0, Number(info.valid), true);
  view.setInt32(4, info.type, true);
  view.setInt32(8, info.flags, true);
  view.setFloat32(12, info.lastUpdateTime, true);
  view.setFloat32(16, info.updateInterval, true);
  view.setInt32(20, info.number, true);
  writeVector(view, 24, info.origin);
  writeVector(view, 36, info.angles);
  writeVector(view, 48, info.oldOrigin);
  writeVector(view, 60, info.lastVisibleOrigin);
  writeVector(view, 72, info.mins);
  writeVector(view, 84, info.maxs);
  view.setInt32(96, info.groundEntity, true);
  view.setInt32(100, info.solid, true);
  view.setInt32(104, info.modelIndex, true);
  view.setInt32(108, info.modelIndex2, true);
  view.setInt32(112, info.frame, true);
  view.setInt32(116, info.event, true);
  view.setInt32(120, info.eventParameter, true);
  view.setInt32(124, info.powerups, true);
  view.setInt32(128, info.weapon, true);
  view.setInt32(132, info.legsAnimation, true);
  view.setInt32(136, info.torsoAnimation, true);
}

export function writeQvmAasAreaInfo(view: DataView, info: AasAreaInfo): void {
  requireRecord(view, QVM_AAS_AREA_INFO_BYTES);
  view.setInt32(12, info.cluster, true);
  view.setInt32(0, info.contents, true);
  view.setInt32(4, info.flags, true);
  view.setInt32(8, info.presenceType, true);
  writeVector(view, 16, info.mins);
  writeVector(view, 28, info.maxs);
  writeVector(view, 40, info.center);
}

function readTrace(view: DataView): AasTrace {
  requireRecord(view, QVM_AAS_TRACE_BYTES);
  return { startSolid: view.getInt32(0, true) !== 0, fraction: view.getFloat32(4, true),
    end: { x: view.getFloat32(8, true), y: view.getFloat32(12, true), z: view.getFloat32(16, true) },
    entityNum: view.getInt32(20, true), lastArea: view.getInt32(24, true),
    area: view.getInt32(28, true), plane: view.getInt32(32, true) };
}

export function writeQvmAasTrace(view: DataView, trace: AasTrace): void {
  requireRecord(view, QVM_AAS_TRACE_BYTES);
  view.setInt32(0, Number(trace.startSolid), true);
  view.setFloat32(4, trace.fraction, true);
  writeVector(view, 8, trace.end);
  view.setInt32(20, trace.entityNum, true);
  view.setInt32(24, trace.lastArea, true);
  view.setInt32(28, trace.area, true);
  view.setInt32(32, trace.plane, true);
}

/** Source fields occupy 22 bytes; the two-byte structure tail stays untouched. */
export function writeQvmAasAlternativeGoal(view: DataView, goal: AlternativeGoal): void {
  requireRecord(view, 22);
  writeVector(view, 0, goal.origin);
  view.setInt32(12, goal.area, true);
  view.setUint16(16, goal.startTravelTime, true);
  view.setUint16(18, goal.goalTravelTime, true);
  view.setUint16(20, goal.extraTravelTime, true);
}

/** The actual route owner publishes each field at its source assignment. */
export function qvmAasRouteOutput(memory: QvmMemory, word: number): AasRoutePredictionOutput {
  const bytes = memory.pointer(word);
  const field = (offset: number): DataView => qvmAasField(bytes, offset, 4);
  return {
    get endPosition(): Vec3 { return qvmAasVector(bytes); },
    set endPosition(value: Vec3) { writeQvmAasVector(bytes, 0, value); },
    get endArea(): number { return field(12).getInt32(0, true); },
    set endArea(value: number) { field(12).setInt32(0, value, true); },
    get stopEvent(): number { return field(16).getInt32(0, true); },
    set stopEvent(value: number) { field(16).setInt32(0, value, true); },
    get endContents(): number { return field(20).getInt32(0, true); },
    set endContents(value: number) { field(20).setInt32(0, value, true); },
    get endTravelFlags(): number { return field(24).getInt32(0, true); },
    set endTravelFlags(value: number) { field(24).setInt32(0, value, true); },
    get time(): number { return field(32).getInt32(0, true); },
    set time(value: number) { field(32).setInt32(0, value, true); },
  };
}

export function qvmAasClientMoveOutput(memory: QvmMemory, word: number): AasClientMoveOutput {
  const bytes = memory.pointer(word);
  const field = (offset: number): DataView => qvmAasField(bytes, offset, 4);
  return {
    clear(): undefined { memory.span(word, QVM_AAS_CLIENT_MOVE_BYTES).fill(0); return undefined; },
    get end(): Vec3 { return qvmAasVector(bytes); },
    set end(value: Vec3) { writeQvmAasVector(bytes, 0, value); },
    get endArea(): number { return field(12).getInt32(0, true); },
    set endArea(value: number) { field(12).setInt32(0, value, true); },
    get velocity(): Vec3 { return qvmAasVector(bytes, 16); },
    set velocity(value: Vec3) { writeQvmAasVector(bytes, 16, value); },
    get trace(): AasTrace { return readTrace(qvmAasField(bytes, 28, QVM_AAS_TRACE_BYTES)); },
    set trace(value: AasTrace) { writeQvmAasTrace(qvmAasField(bytes, 28, QVM_AAS_TRACE_BYTES), value); },
    get presence(): number { return field(64).getInt32(0, true); },
    set presence(value: number) { field(64).setInt32(0, value, true); },
    get stopEvent(): number { return field(68).getInt32(0, true); },
    set stopEvent(value: number) { field(68).setInt32(0, value, true); },
    get endContents(): number { return field(72).getInt32(0, true); },
    set endContents(value: number) { field(72).setInt32(0, value, true); },
    get time(): number { return field(76).getFloat32(0, true); },
    set time(value: number) { field(76).setFloat32(0, value, true); },
    get frames(): number { return field(80).getInt32(0, true); },
    set frames(value: number) { field(80).setInt32(0, value, true); },
  };
}
