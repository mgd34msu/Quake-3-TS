// Port of id Software's code/game/g_public.h sharedEntity_t and
// code/server/sv_world.c SV_ClipHandleForEntity. GPL-2.0-or-later.
// Copyright (C) 1999-2005 Id Software, Inc.
import { BinaryError } from "../core/binary.ts";
import type { Vec3 } from "../core/math.ts";
import type { EntityCollisionModel, SharedEntity } from "../shared/entity-shared.ts";
import { borrowQvmEntityState } from "./entity-record.ts";

// The pinned g_public.h includes an unused entityState_t at r.s, bytes 208..415.
export const QVM_SHARED_ENTITY_BYTES = 516;
const SVF_CAPSULE = 0x00000400;

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

/** Borrows the source shared prefix without decoding or replacing its storage. */
export function borrowQvmSharedEntity(view: DataView): SharedEntity {
  if (view.byteLength < QVM_SHARED_ENTITY_BYTES) {
    throw new BinaryError("QVM sharedEntity_t", 0,
      `record requires ${QVM_SHARED_ENTITY_BYTES} bytes, received ${view.byteLength}`);
  }
  const s = borrowQvmEntityState(view);
  return {
    s,
    r: {
      get linked(): boolean { return view.getInt32(416, true) !== 0; },
      set linked(value: boolean) { view.setInt32(416, value ? 1 : 0, true); },
      get linkcount(): number { return view.getInt32(420, true); },
      set linkcount(value: number) { view.setInt32(420, value, true); },
      get svFlags(): number { return view.getInt32(424, true); },
      set svFlags(value: number) { view.setInt32(424, value, true); },
      get singleClient(): number { return view.getInt32(428, true); },
      set singleClient(value: number) { view.setInt32(428, value, true); },
      get mins(): Vec3 { return readVector(view, 436); },
      set mins(value: Vec3) { writeVector(view, 436, value); },
      get maxs(): Vec3 { return readVector(view, 448); },
      set maxs(value: Vec3) { writeVector(view, 448, value); },
      get contents(): number { return view.getInt32(460, true); },
      set contents(value: number) { view.setInt32(460, value, true); },
      get absmin(): Vec3 { return readVector(view, 464); },
      set absmin(value: Vec3) { writeVector(view, 464, value); },
      get absmax(): Vec3 { return readVector(view, 476); },
      set absmax(value: Vec3) { writeVector(view, 476, value); },
      get currentOrigin(): Vec3 { return readVector(view, 488); },
      set currentOrigin(value: Vec3) { writeVector(view, 488, value); },
      get currentAngles(): Vec3 { return readVector(view, 500); },
      set currentAngles(value: Vec3) { writeVector(view, 500, value); },
      get ownerNum(): number { return view.getInt32(512, true); },
      set ownerNum(value: number) { view.setInt32(512, value, true); },
      get model(): EntityCollisionModel {
        if (view.getInt32(432, true) !== 0) return { kind: "inline", index: s.modelindex };
        return (view.getInt32(424, true) & SVF_CAPSULE) !== 0
          ? { kind: "capsule" } : { kind: "box" };
      },
      set model(value: EntityCollisionModel) {
        switch (value.kind) {
          case "inline":
            s.modelindex = value.index;
            view.setInt32(432, 1, true);
            break;
          case "box":
            view.setInt32(432, 0, true);
            view.setInt32(424, view.getInt32(424, true) & ~SVF_CAPSULE, true);
            break;
          case "capsule":
            view.setInt32(432, 0, true);
            view.setInt32(424, view.getInt32(424, true) | SVF_CAPSULE, true);
            break;
        }
      },
    },
  };
}
