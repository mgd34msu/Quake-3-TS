/*
 * Game AAS traps from id Software's code/server/sv_game.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { aasSwimming } from "../botlib/aas-movement.ts";
import type { AasMapSpatialHost, AasRuntime } from "../botlib/aas-runtime.ts";
import { float32ToBits } from "../core/numeric.ts";
import {
  QVM_AAS_ALTERNATIVE_GOAL_BYTES, QVM_AAS_AREA_INFO_BYTES, QVM_AAS_ENTITY_INFO_BYTES,
  qvmAasClientMoveOutput, qvmAasField, qvmAasRouteOutput, qvmAasVector,
  writeQvmAasAlternativeGoal, writeQvmAasAreaInfo, writeQvmAasEntityInfo, writeQvmAasVector,
} from "./aas-record.ts";
import type { QvmMemory } from "./memory.ts";

function epairKey(bytes: Uint8Array | null): (candidate: string) => boolean {
  return candidate => {
    if (bytes === null) throw new RangeError("QVM AAS epair comparison requires a nonnull key");
    for (let index = 0; index <= candidate.length; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("QVM AAS epair key exceeds allocation");
      if (byte !== (index === candidate.length ? 0 : candidate.charCodeAt(index))) return false;
    }
    return true;
  };
}

/** Borrows AAS and the actual server import. Scalar/role dispatch never acquires a map. */
export function qvmAasSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, aas: AasRuntime,
  pointContents: AasMapSpatialHost["pointContents"],
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 300: return aas.enableRoutingArea(words.getInt32(4, true), words.getInt32(8, true));
    case 301: {
      const mins = words.getInt32(4, true), maxs = words.getInt32(8, true);
      const areas = memory.pointer(words.getInt32(12, true)), maximum = words.getInt32(16, true);
      return aas.writeBBoxAreas({ min: qvmAasVector(memory.pointer(mins)), max: qvmAasVector(memory.pointer(maxs)) },
        maximum, (area, index) => { qvmAasField(areas, index * 4, 4).setInt32(0, area, true); return undefined; });
    }
    case 302: {
      const area = words.getInt32(4, true), output = words.getInt32(8, true);
      if (output === 0) return 0;
      const info = aas.areaInfo(area);
      if (info === null) return 0;
      writeQvmAasAreaInfo(memory.view(output, QVM_AAS_AREA_INFO_BYTES), info);
      return QVM_AAS_AREA_INFO_BYTES;
    }
    case 303: {
      const entity = words.getInt32(4, true), output = words.getInt32(8, true);
      const info = aas.entityInfo(entity);
      if (info === null) memory.span(output, QVM_AAS_ENTITY_INFO_BYTES).fill(0);
      else writeQvmAasEntityInfo(memory.view(output, QVM_AAS_ENTITY_INFO_BYTES), info);
      return 0;
    }
    case 304: return Number(aas.initialized);
    case 305: {
      const presence = words.getInt32(4, true), mins = words.getInt32(8, true), maxs = words.getInt32(12, true);
      const bounds = aas.presenceBounds(presence);
      writeQvmAasVector(memory.pointer(mins), 0, bounds.min);
      writeQvmAasVector(memory.pointer(maxs), 0, bounds.max);
      return 0;
    }
    case 306: return float32ToBits(aas.time()) | 0;
    case 307: return aas.pointArea(qvmAasVector(memory.pointer(words.getInt32(4, true))));
    case 308: {
      const start = words.getInt32(4, true), end = words.getInt32(8, true);
      const areas = memory.pointer(words.getInt32(12, true)), points = memory.pointer(words.getInt32(16, true));
      const maximum = words.getInt32(20, true);
      qvmAasField(areas, 0, 4).setInt32(0, 0, true);
      return aas.writeTraceAreas(qvmAasVector(memory.pointer(start)), qvmAasVector(memory.pointer(end)), maximum,
        (crossing, index) => {
          qvmAasField(areas, index * 4, 4).setInt32(0, crossing.area, true);
          if (points !== null) writeQvmAasVector(points, index * 12, crossing.point);
          return undefined;
        });
    }
    case 309: return pointContents(qvmAasVector(memory.pointer(words.getInt32(4, true))));
    case 310: return aas.bspEntities.nextEntity(words.getInt32(4, true));
    case 311: {
      const entity = words.getInt32(4, true), key = memory.pointer(words.getInt32(8, true));
      const output = memory.pointer(words.getInt32(12, true)), size = words.getInt32(16, true);
      if (output === null) throw new RangeError("QVM AAS epair value requires a nonnull output");
      return Number(aas.bspEntities.value(entity, epairKey(key), output, size));
    }
    case 312: {
      const entity = words.getInt32(4, true), key = memory.pointer(words.getInt32(8, true));
      const output = memory.pointer(words.getInt32(12, true));
      writeQvmAasVector(output, 0, { x: 0, y: 0, z: 0 });
      const result = aas.bspEntities.vector(entity, epairKey(key));
      if (result.found) writeQvmAasVector(output, 0, result.value);
      return Number(result.found);
    }
    case 313:
    case 314: {
      const trap = words.getInt32(0, true), entity = words.getInt32(4, true);
      const key = memory.pointer(words.getInt32(8, true)), output = memory.view(words.getInt32(12, true), 4);
      output.setInt32(0, 0, true);
      const result = trap === 313 ? aas.bspEntities.float(entity, epairKey(key)) : aas.bspEntities.int(entity, epairKey(key));
      if (result.found) {
        if (trap === 313) output.setFloat32(0, result.value, true);
        else output.setInt32(0, result.value, true);
      }
      return Number(result.found);
    }
    case 315: return aas.areaReachability(words.getInt32(4, true));
    case 316: {
      const area = words.getInt32(4, true), origin = words.getInt32(8, true);
      const goalArea = words.getInt32(12, true), travelFlags = words.getInt32(16, true);
      return aas.areaTravelTimeToGoal({ area, origin: origin === 0 ? null : qvmAasVector(memory.pointer(origin)), goalArea, travelFlags });
    }
    case 317: return Number(aasSwimming(qvmAasVector(memory.pointer(words.getInt32(4, true))), pointContents));
    case 318: {
      const output = words.getInt32(4, true), entityNum = words.getInt32(8, true), origin = words.getInt32(12, true);
      const presence = words.getInt32(16, true), onGround = words.getInt32(20, true) !== 0;
      const velocity = words.getInt32(24, true), commandMove = words.getInt32(28, true);
      const commandFrames = words.getInt32(32, true), maxFrames = words.getInt32(36, true);
      const frameTime = words.getFloat32(40, true), stopEvents = words.getInt32(44, true);
      const stopArea = words.getInt32(48, true), visualize = words.getInt32(52, true) !== 0;
      return Number(aas.predictClientMovement({ entityNum,
        origin: qvmAasVector(memory.pointer(origin)), presence, onGround,
        velocity: qvmAasVector(memory.pointer(velocity)), commandMove: qvmAasVector(memory.pointer(commandMove)),
        commandFrames, maxFrames, frameTime, stopEvents, stopArea, visualize }, pointContents, qvmAasClientMoveOutput(memory, output)).success);
    }
    case 575: {
      const start = words.getInt32(4, true), startArea = words.getInt32(8, true), goal = words.getInt32(12, true);
      const goalArea = words.getInt32(16, true), travelFlags = words.getInt32(20, true);
      const output = memory.pointer(words.getInt32(24, true)), maximumGoals = words.getInt32(28, true), type = words.getInt32(32, true);
      return aas.writeAlternativeRouteGoals({ start: qvmAasVector(memory.pointer(start)), startArea,
        goal: qvmAasVector(memory.pointer(goal)), goalArea, travelFlags, maximumGoals, type }, (value, index) => {
        writeQvmAasAlternativeGoal(qvmAasField(output, index * QVM_AAS_ALTERNATIVE_GOAL_BYTES, 22), value);
        return undefined;
      });
    }
    case 576: {
      const output = words.getInt32(4, true), area = words.getInt32(8, true), origin = words.getInt32(12, true);
      const goalArea = words.getInt32(16, true), travelFlags = words.getInt32(20, true);
      const maximumAreas = words.getInt32(24, true), maximumTime = words.getInt32(28, true);
      const stopEvent = words.getInt32(32, true), stopContents = words.getInt32(36, true);
      const stopTravelFlags = words.getInt32(40, true), stopArea = words.getInt32(44, true);
      return Number(aas.writePredictRoute({ area, origin: qvmAasVector(memory.pointer(origin)), goalArea,
        travelFlags, maximumAreas, maximumTime, stopEvent, stopContents, stopTravelFlags, stopArea },
      qvmAasRouteOutput(memory, output)));
    }
    case 577: {
      const origin = words.getInt32(4, true);
      return aas.pointReachabilityAreaIndex(origin === 0 ? null : qvmAasVector(memory.pointer(origin)));
    }
    default: return null;
  }
}
