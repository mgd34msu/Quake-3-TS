// QVM layouts from id Software code/cgame/tr_types.h and game/q_shared.h.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { Md3Tag } from "../assets/md3.ts";
import { BinaryError } from "../core/binary.ts";
import type { Axis, Vec3, Vec4 } from "../core/math.ts";
import type { RefPolyVertex, SourceRefEntityRecord } from "../render/ref-entity.ts";
import type { Refdef } from "../render/refdef.ts";

export const QVM_REF_ENTITY_BYTES = 140;
export const QVM_REFDEF_BYTES = 368;
export const QVM_POLY_VERTEX_BYTES = 24;
export const QVM_ORIENTATION_BYTES = 48;

function requireBytes(view: DataView, bytes: number, source: string): void {
  if (view.byteLength < bytes) throw new BinaryError(source, 0,
    `record requires ${bytes} bytes, received ${view.byteLength}`);
}

function readVector(view: DataView, offset: number): Vec3 {
  return { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
}

function readAxis(view: DataView, offset: number): Axis {
  return [readVector(view, offset), readVector(view, offset + 12), readVector(view, offset + 24)];
}

function readColor(view: DataView, offset: number): Vec4 {
  return { x: view.getUint8(offset), y: view.getUint8(offset + 1), z: view.getUint8(offset + 2), w: view.getUint8(offset + 3) };
}

/** Copies the source record without resolving its model, shader or skin handles. */
export function readQvmRefEntity(view: DataView): SourceRefEntityRecord {
  requireBytes(view, QVM_REF_ENTITY_BYTES, "QVM refEntity_t");
  const type = view.getInt32(0, true);
  if (type < 0 || type > 7) throw new BinaryError("QVM refEntity_t", 0, `unsupported entity type ${type}`);
  const record = {
    renderFlags: view.getInt32(4, true), model: view.getInt32(8, true), lightingOrigin: readVector(view, 12),
    shadowPlane: view.getFloat32(24, true), axis: readAxis(view, 28), nonNormalizedAxes: view.getInt32(64, true) !== 0,
    origin: readVector(view, 68), frame: view.getInt32(80, true), oldOrigin: readVector(view, 84), oldFrame: view.getInt32(96, true),
    backLerp: view.getFloat32(100, true), skinNum: view.getInt32(104, true), customSkin: view.getInt32(108, true),
    customShader: view.getInt32(112, true), shaderRGBA: readColor(view, 116),
    shaderTexCoord: { x: view.getFloat32(120, true), y: view.getFloat32(124, true) }, shaderTime: view.getFloat32(128, true),
    radius: view.getFloat32(132, true), rotation: view.getFloat32(136, true),
  };
  switch (type) {
    case 0: return { ...record, kind: "model" };
    case 1: return { ...record, kind: "poly" };
    case 2: return { ...record, kind: "sprite" };
    case 3: return { ...record, kind: "beam" };
    case 4: return { ...record, kind: "rail-core" };
    case 5: return { ...record, kind: "rail-rings" };
    case 6: return { ...record, kind: "lightning" };
    case 7: return { ...record, kind: "portal-surface" };
    default: throw new BinaryError("QVM refEntity_t", 0, `unsupported entity type ${type}`);
  }
}

function readTextRow(view: DataView, offset: number): string {
  let row = "";
  for (let index = 0; index < 32; index++) row += String.fromCharCode(view.getUint8(offset + index));
  if (!row.includes("\0")) throw new BinaryError("QVM refdef_t", offset, "render text row has no NUL within 32 bytes");
  return row;
}

/** Owns the mask and complete byte-character rows, including bytes after NUL. */
export function readQvmRefdef(view: DataView): Refdef {
  requireBytes(view, QVM_REFDEF_BYTES, "QVM refdef_t");
  return {
    x: view.getInt32(0, true), y: view.getInt32(4, true), width: view.getInt32(8, true), height: view.getInt32(12, true),
    fovX: view.getFloat32(16, true), fovY: view.getFloat32(20, true), viewOrigin: readVector(view, 24), viewAxis: readAxis(view, 36),
    time: view.getInt32(72, true), renderFlags: view.getInt32(76, true),
    areaMask: new Uint8Array(new Uint8Array(view.buffer, view.byteOffset + 80, 32)),
    text: [readTextRow(view, 112), readTextRow(view, 144), readTextRow(view, 176), readTextRow(view, 208),
      readTextRow(view, 240), readTextRow(view, 272), readTextRow(view, 304), readTextRow(view, 336)],
  };
}

/** The caller owns polygon admission and grouping for AddPoly/AddPolys. */
export function readQvmPolyVertices(view: DataView, count: number): readonly RefPolyVertex[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(view.byteLength / QVM_POLY_VERTEX_BYTES)) {
    throw new BinaryError("QVM polyVert_t", 0, `invalid vertex count ${count} for ${view.byteLength} bytes`);
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = index * QVM_POLY_VERTEX_BYTES;
    return { position: readVector(view, offset),
      texCoord: { x: view.getFloat32(offset + 12, true), y: view.getFloat32(offset + 16, true) }, color: readColor(view, offset + 20) };
  });
}

function writeVector(view: DataView, offset: number, value: Vec3): void {
  view.setFloat32(offset, value.x, true);
  view.setFloat32(offset + 4, value.y, true);
  view.setFloat32(offset + 8, value.z, true);
}

/** Writes the actual lerpTag result into orientation_t, checking extent before mutation. */
export function writeQvmOrientation(view: DataView, value: Pick<Md3Tag, "origin" | "axes">): void {
  requireBytes(view, QVM_ORIENTATION_BYTES, "QVM orientation_t");
  writeVector(view, 0, value.origin);
  writeVector(view, 12, value.axes[0]);
  writeVector(view, 24, value.axes[1]);
  writeVector(view, 36, value.axes[2]);
}
