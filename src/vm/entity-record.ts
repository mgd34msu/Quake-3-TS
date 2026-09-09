// Port of id Software's code/game/q_shared.h trajectory_t and entityState_t.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { EntityStateFields, SourceEntityState } from "../shared/entity-state.ts";
import type { Trajectory } from "../shared/trajectory.ts";

// The selected 32-bit QVM ABI has four-byte int, enum, float and alignment.
export const QVM_ENTITY_STATE_BYTES = 208;

function requireRecord(view: DataView): void {
  if (view.byteLength < QVM_ENTITY_STATE_BYTES) {
    throw new BinaryError("QVM entityState_t", 0,
      `record requires ${QVM_ENTITY_STATE_BYTES} bytes, received ${view.byteLength}`);
  }
}

function readVector(view: DataView, offset: number): Vec3 {
  return {
    x: view.getFloat32(offset, true),
    y: view.getFloat32(offset + 4, true),
    z: view.getFloat32(offset + 8, true),
  };
}

function writeVector(view: DataView, offset: number, value: Vec3): void {
  view.setFloat32(offset, value.x, true);
  view.setFloat32(offset + 4, value.y, true);
  view.setFloat32(offset + 8, value.z, true);
}

function readTrajectory(view: DataView, offset: number): Trajectory<number> {
  return {
    type: view.getInt32(offset, true),
    time: view.getInt32(offset + 4, true),
    duration: view.getInt32(offset + 8, true),
    base: readVector(view, offset + 12),
    delta: readVector(view, offset + 24),
  };
}

function writeTrajectory(view: DataView, offset: number, value: Trajectory<number>): void {
  view.setInt32(offset, value.type, true);
  view.setInt32(offset + 4, value.time, true);
  view.setInt32(offset + 8, value.duration, true);
  writeVector(view, offset + 12, value.base);
  writeVector(view, offset + 24, value.delta);
}

/** Borrows live fields; immutable vectors and trajectories are sampled on access. */
class BorrowedEntityState implements SourceEntityState {
  constructor(private readonly view: DataView) {}

  get number(): number { return this.view.getInt32(0, true); }
  set number(value: number) { this.view.setInt32(0, value, true); }
  get eType(): number { return this.view.getInt32(4, true); }
  set eType(value: number) { this.view.setInt32(4, value, true); }
  get eFlags(): number { return this.view.getInt32(8, true); }
  set eFlags(value: number) { this.view.setInt32(8, value, true); }
  get pos(): Trajectory<number> { return readTrajectory(this.view, 12); }
  set pos(value: Trajectory<number>) { writeTrajectory(this.view, 12, value); }
  get apos(): Trajectory<number> { return readTrajectory(this.view, 48); }
  set apos(value: Trajectory<number>) { writeTrajectory(this.view, 48, value); }
  get time(): number { return this.view.getInt32(84, true); }
  set time(value: number) { this.view.setInt32(84, value, true); }
  get time2(): number { return this.view.getInt32(88, true); }
  set time2(value: number) { this.view.setInt32(88, value, true); }
  get origin(): Vec3 { return readVector(this.view, 92); }
  set origin(value: Vec3) { writeVector(this.view, 92, value); }
  get origin2(): Vec3 { return readVector(this.view, 104); }
  set origin2(value: Vec3) { writeVector(this.view, 104, value); }
  get angles(): Vec3 { return readVector(this.view, 116); }
  set angles(value: Vec3) { writeVector(this.view, 116, value); }
  get angles2(): Vec3 { return readVector(this.view, 128); }
  set angles2(value: Vec3) { writeVector(this.view, 128, value); }
  get otherEntityNum(): number { return this.view.getInt32(140, true); }
  set otherEntityNum(value: number) { this.view.setInt32(140, value, true); }
  get otherEntityNum2(): number { return this.view.getInt32(144, true); }
  set otherEntityNum2(value: number) { this.view.setInt32(144, value, true); }
  get groundEntityNum(): number { return this.view.getInt32(148, true); }
  set groundEntityNum(value: number) { this.view.setInt32(148, value, true); }
  get constantLight(): number { return this.view.getInt32(152, true); }
  set constantLight(value: number) { this.view.setInt32(152, value, true); }
  get loopSound(): number { return this.view.getInt32(156, true); }
  set loopSound(value: number) { this.view.setInt32(156, value, true); }
  get modelindex(): number { return this.view.getInt32(160, true); }
  set modelindex(value: number) { this.view.setInt32(160, value, true); }
  get modelindex2(): number { return this.view.getInt32(164, true); }
  set modelindex2(value: number) { this.view.setInt32(164, value, true); }
  get clientNum(): number { return this.view.getInt32(168, true); }
  set clientNum(value: number) { this.view.setInt32(168, value, true); }
  get frame(): number { return this.view.getInt32(172, true); }
  set frame(value: number) { this.view.setInt32(172, value, true); }
  get solid(): number { return this.view.getInt32(176, true); }
  set solid(value: number) { this.view.setInt32(176, value, true); }
  get event(): number { return this.view.getInt32(180, true); }
  set event(value: number) { this.view.setInt32(180, value, true); }
  get eventParm(): number { return this.view.getInt32(184, true); }
  set eventParm(value: number) { this.view.setInt32(184, value, true); }
  get powerups(): number { return this.view.getInt32(188, true); }
  set powerups(value: number) { this.view.setInt32(188, value, true); }
  get weapon(): number { return this.view.getInt32(192, true); }
  set weapon(value: number) { this.view.setInt32(192, value, true); }
  get legsAnim(): number { return this.view.getInt32(196, true); }
  set legsAnim(value: number) { this.view.setInt32(196, value, true); }
  get torsoAnim(): number { return this.view.getInt32(200, true); }
  set torsoAnim(value: number) { this.view.setInt32(200, value, true); }
  get generic1(): number { return this.view.getInt32(204, true); }
  set generic1(value: number) { this.view.setInt32(204, value, true); }

  copy(): SourceEntityState {
    const state = new EntityStateRecord<number>(0);
    state.copyFrom(this);
    return state;
  }

  copyFrom(source: Readonly<EntityStateFields>): void {
    writeQvmEntityState(this.view, source);
  }
}

/** Borrows live fields; immutable vectors and trajectories are sampled on access. */
export function borrowQvmEntityState(view: DataView): SourceEntityState {
  requireRecord(view);
  return new BorrowedEntityState(view);
}

/** Reads owned state from a view beginning at an already-resolved QVM pointer. */
export function readQvmEntityState(view: DataView): SourceEntityState {
  return borrowQvmEntityState(view).copy();
}

/** Writes exactly one source ABI record, checking its extent before mutation. */
export function writeQvmEntityState(view: DataView, state: Readonly<EntityStateFields>): void {
  const target = borrowQvmEntityState(view);
  target.number = state.number;
  target.eType = state.eType;
  target.eFlags = state.eFlags;
  target.pos = state.pos;
  target.apos = state.apos;
  target.time = state.time;
  target.time2 = state.time2;
  target.origin = state.origin;
  target.origin2 = state.origin2;
  target.angles = state.angles;
  target.angles2 = state.angles2;
  target.otherEntityNum = state.otherEntityNum;
  target.otherEntityNum2 = state.otherEntityNum2;
  target.groundEntityNum = state.groundEntityNum;
  target.constantLight = state.constantLight;
  target.loopSound = state.loopSound;
  target.modelindex = state.modelindex;
  target.modelindex2 = state.modelindex2;
  target.clientNum = state.clientNum;
  target.frame = state.frame;
  target.solid = state.solid;
  target.event = state.event;
  target.eventParm = state.eventParm;
  target.powerups = state.powerups;
  target.weapon = state.weapon;
  target.legsAnim = state.legsAnim;
  target.torsoAnim = state.torsoAnim;
  target.generic1 = state.generic1;
}
