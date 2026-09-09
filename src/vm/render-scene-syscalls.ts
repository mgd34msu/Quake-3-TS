/*
 * Scene traps from id Software code/client/cl_cgame.c and cl_ui.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { Vec3 } from "../core/math.ts";
import { CommonError } from "../core/common-error.ts";
import type { RendererResources } from "../render/world.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_POLY_VERTEX_BYTES, QVM_REF_ENTITY_BYTES, QVM_REFDEF_BYTES,
  readQvmPolyVertices, readQvmRefEntity, readQvmRefdef } from "./render-record.ts";

function vector(view: DataView): Vec3 {
  return { x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true) };
}

function writeVector(view: DataView, value: Vec3): void {
  view.setFloat32(0, value.x, true); view.setFloat32(4, value.y, true); view.setFloat32(8, value.z, true);
}

/** Scene calls borrow the actual renderer allocation, including its early-return gates. */
export function qvmRenderSceneSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, resources: RendererResources,
): number | null {
  if (role === "game") return null;
  const trap = words.getInt32(0, true);
  if (trap === (role === "ui" ? 21 : 40)) {
    resources.clearScene();
    return 0;
  }
  if (trap === (role === "ui" ? 22 : 41)) {
    const entityWord = words.getInt32(4, true);
    resources.addRefEntityRecord(() => {
      const type = memory.view(entityWord, 4).getInt32(0, true);
      if (type < 0 || type >= 8) throw new CommonError("drop", `RE_AddRefEntityToScene: bad reType ${type}`);
      return readQvmRefEntity(memory.view(entityWord, QVM_REF_ENTITY_BYTES));
    });
    return 0;
  }
  if (trap === (role === "ui" ? 23 : 42) || (role === "cgame" && trap === 87)) {
    const shader = words.getInt32(4, true), numVerts = words.getInt32(8, true), verticesWord = words.getInt32(12, true);
    const numPolys = trap === 87 ? words.getInt32(16, true) : 1;
    // VM_ArgPtr masks the base once. Subsequent polygons advance inside that allocation.
    let vertices: Uint8Array | null = null;
    resources.addPolysByHandle(shader, numVerts, numPolys, index => {
      if (vertices === null) vertices = memory.pointer(verticesWord);
      if (vertices === null) throw new RangeError("QVM polygon vertices require a nonnull pointer");
      const length = numVerts * QVM_POLY_VERTEX_BYTES, offset = index * length;
      if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset) || offset < 0
        || offset + length > vertices.byteLength) throw new RangeError("QVM polygon vertices exceed allocation");
      return readQvmPolyVertices(new DataView(vertices.buffer, vertices.byteOffset + offset, length), numVerts);
    });
    return 0;
  }
  if (trap === (role === "ui" ? 24 : 43) || (role === "cgame" && trap === 85)) {
    const originWord = words.getInt32(4, true), radius = words.getFloat32(8, true);
    const color = { x: words.getFloat32(12, true), y: words.getFloat32(16, true), z: words.getFloat32(20, true) };
    resources.addLightRecord(radius, color, trap === 85, () => vector(memory.view(originWord, 12)));
    return 0;
  }
  if (trap === (role === "ui" ? 25 : 44)) {
    const refdefWord = words.getInt32(4, true);
    resources.renderSceneRecord(() => memory.view(refdefWord, 80).getInt32(76, true),
      () => readQvmRefdef(memory.view(refdefWord, QVM_REFDEF_BYTES)));
    return 0;
  }
  if (role === "cgame" && trap === 73) {
    const pointWord = words.getInt32(4, true), ambientWord = words.getInt32(8, true);
    const directedWord = words.getInt32(12, true), directionWord = words.getInt32(16, true);
    const sample = resources.lightForPointRecord(() => vector(memory.view(pointWord, 12)));
    if (sample === null) return 0;
    writeVector(memory.view(ambientWord, 12), sample.ambientLight);
    writeVector(memory.view(directedWord, 12), sample.directedLight);
    writeVector(memory.view(directionWord, 12), sample.lightDir);
    return 1;
  }
  return null;
}
