/*
 * CG_CM_MARKFRAGMENTS from id Software code/client/cl_cgame.c and cgame/cg_public.h.
 * Output order follows renderer/tr_marks.c R_AddMarkFragments.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { Vec3 } from "../core/math.ts";
import type { RendererResources } from "../render/world.ts";
import type { QvmMemory } from "./memory.ts";

function span(bytes: Uint8Array | null, offset: number, length: number, name: string): DataView {
  if (bytes === null) throw new RangeError(`QVM mark ${name} requires a nonnull pointer`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.byteLength)
    throw new RangeError(`QVM mark ${name} exceeds allocation`);
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function vector(view: DataView): Vec3 {
  return { x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true) };
}

/** The active renderer owns both the BSP and its prepared mark grids. */
export function qvmMarkSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, resources: RendererResources,
): number | null {
  if (role !== "cgame") return null;
  if (words.getInt32(0, true) !== 27) return null;
  const pointCount = words.getInt32(4, true), inputWord = words.getInt32(8, true), projectionWord = words.getInt32(12, true);
  const maxPoints = words.getInt32(16, true), pointsWord = words.getInt32(20, true);
  const maxFragments = words.getInt32(24, true), fragmentsWord = words.getInt32(28, true);
  // VM_ArgPtr masks each allocation base once; subsequent records advance without wrapping.
  const input = memory.pointer(inputWord), projection = memory.pointer(projectionWord);
  const points = memory.pointer(pointsWord), fragments = memory.pointer(fragmentsWord);
  return resources.markFragments({
    pointCount, maxPoints, maxFragments,
    readProjection: () => vector(span(projection, 0, 12, "projection")),
    readPoint: index => vector(span(input, index * 12, 12, "input points")),
    writeFragment(index, fragment) {
      span(fragments, index * 8, 4, "fragments").setInt32(0, fragment.firstPoint, true);
      span(fragments, index * 8 + 4, 4, "fragments").setInt32(0, fragment.pointCount, true);
    },
    writePoints(firstPoint, values) {
      const output = span(points, firstPoint * 12, values.length * 12, "output points");
      for (const [index, point] of values.entries()) {
        output.setFloat32(index * 12, point.x, true);
        output.setFloat32(index * 12 + 4, point.y, true);
        output.setFloat32(index * 12 + 8, point.z, true);
      }
    },
  });
}
