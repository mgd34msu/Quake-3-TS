/* Cgame collision traps from id Software's code/client/cl_cgame.c,
 * code/cgame/cg_public.h and cg_syscalls.asm.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
import type { SourceClipModels } from "../collision/clip-models.ts";
import { SOURCE_BOX_MODEL_HANDLE } from "../collision/clip-models.ts";
import type { SourceTraceResult, TraceShape } from "../collision/world.ts";
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_TRACE_BYTES, writeQvmTrace } from "./trace-record.ts";

function vector(memory: QvmMemory, word: number): Vec3 {
  const view = memory.view(word, 12);
  return vec3(view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true));
}

function boundsVector(memory: QvmMemory, word: number): Vec3 {
  return word === 0 ? vec3(0, 0, 0) : vector(memory, word);
}

/** The caller retains one actual collision owner for the cgame map lifetime. */
export function qvmCollisionSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, models: SourceClipModels,
): number | null {
  if (role !== "cgame") return null;
  const trap = words.getInt32(0, true);
  switch (trap) {
    case 19: return models.modelCount;
    case 20: return models.inlineModel(words.getInt32(4, true));
    case 22:
    case 82: return models.tempBoxModel(vector(memory, words.getInt32(4, true)),
      vector(memory, words.getInt32(8, true)), trap === 82);
    case 23: {
      const point = words.getInt32(4, true), handle = words.getInt32(8, true);
      return models.world.hasNodes ? models.pointContents(vector(memory, point), handle) : 0;
    }
    case 24: {
      const point = words.getInt32(4, true), handle = words.getInt32(8, true);
      const origin = words.getInt32(12, true), angles = words.getInt32(16, true);
      return models.transformedPointContents(vector(memory, point), handle, vector(memory, origin),
        handle === SOURCE_BOX_MODEL_HANDLE ? vec3(0, 0, 0) : vector(memory, angles));
    }
    case 25:
    case 26:
    case 83:
    case 84: {
      const output = memory.view(words.getInt32(4, true), QVM_TRACE_BYTES);
      const handle = words.getInt32(24, true), mask = words.getInt32(28, true);
      if (trap === 25 || trap === 83) {
        const unloaded = models.traceWithoutNodes(handle);
        if (unloaded !== null) { writeQvmTrace(output, { ...unloaded, entityNum: 0 }); return 0; }
      }
      const start = vector(memory, words.getInt32(8, true));
      const end = vector(memory, words.getInt32(12, true));
      const mins = boundsVector(memory, words.getInt32(16, true));
      const maxs = boundsVector(memory, words.getInt32(20, true));
      const shape: TraceShape = { kind: trap === 83 || trap === 84 ? "capsule" : "box", mins, maxs };
      const query = { start, end, shape, mask };
      let result: SourceTraceResult;
      if (trap === 26 || trap === 84) {
        const origin = words.getInt32(32, true), angles = words.getInt32(36, true);
        result = models.transformedTrace(query, handle, vector(memory, origin),
          handle === SOURCE_BOX_MODEL_HANDLE ? vec3(0, 0, 0) : vector(memory, angles));
      } else result = models.trace(query, handle);
      // CM_Trace clears the entire trace work; cgame assigns entity identity later.
      writeQvmTrace(output, { ...result, entityNum: 0 });
      return 0;
    }
    // CM_LoadMap requires the client map-loading lifetime; LoadModel is source-unused.
    default: return null;
  }
}
