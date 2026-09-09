/*
 * Movement traps from id Software's server/sv_game.c, game/g_public.h and
 * botlib/be_ai_move.c. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotGoal } from "../botlib/goals.ts";
import { BotMovement } from "../botlib/movement.ts";
import { BotMovementRouting } from "../botlib/movement-routing.ts";
import type { BotMoveStateStore } from "../botlib/movement-state.ts";
import { runCalls } from "../core/call-steps.ts";
import { readQvmBotGoalReference } from "./bot-goal-record.ts";
import { qvmBotInitMoveReference, qvmBotMoveResultReference,
  qvmBotMovementTarget, qvmBotMovementVector } from "./bot-movement-record.ts";
import type { QvmMemory } from "./memory.ts";

function goalReference(memory: QvmMemory, word: number): BotGoal | null {
  return word === 0 ? null : readQvmBotGoalReference(() => memory.pointer(word));
}

/** State calls work before map loading; map calls borrow the current real owners. */
export function qvmBotMovementSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory,
  states: BotMoveStateStore, movement: () => BotMovement, routing: () => BotMovementRouting,
): number | Promise<number> | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 548: states.reset(words.getInt32(4, true)); return 0;
    case 549: {
      const resultWord = words.getInt32(4, true), handle = words.getInt32(8, true);
      const goalWord = words.getInt32(12, true), travelFlags = words.getInt32(16, true);
      const result = runCalls(BotMovement.moveToGoalCalls(qvmBotMoveResultReference(() => memory.pointer(resultWord)),
        handle, goalReference(memory, goalWord), travelFlags, states, movement));
      return result instanceof Promise ? result.then(() => 0) : 0;
    }
    case 550: {
      const handle = words.getInt32(4, true), directionWord = words.getInt32(8, true);
      const speed = words.getFloat32(12, true), type = words.getInt32(16, true);
      return Number(BotMovement.moveInDirection(handle,
        qvmBotMovementVector(() => memory.pointer(directionWord)), speed, type, states, movement));
    }
    case 551: states.resetAvoidReach(words.getInt32(4, true)); return 0;
    case 552: states.resetLastAvoidReach(words.getInt32(4, true)); return 0;
    case 553: {
      const originWord = words.getInt32(4, true), client = words.getInt32(8, true);
      return routing().spatial.reachabilityArea(qvmBotMovementVector(() => memory.pointer(originWord)), client);
    }
    case 554: {
      const handle = words.getInt32(4, true), goalWord = words.getInt32(8, true);
      const travelFlags = words.getInt32(12, true), lookahead = words.getFloat32(16, true);
      const targetWord = words.getInt32(20, true);
      return Number(BotMovementRouting.movementViewTarget(handle, goalReference(memory, goalWord),
        travelFlags, lookahead, qvmBotMovementTarget(() => memory.pointer(targetWord)), states, routing));
    }
    case 555: return states.allocate();
    case 556: states.free(words.getInt32(4, true)); return 0;
    case 557: {
      const handle = words.getInt32(4, true), initWord = words.getInt32(8, true);
      states.initialize(handle, qvmBotInitMoveReference(() => memory.pointer(initWord)));
      return 0;
    }
    case 572: {
      const originWord = words.getInt32(4, true), area = words.getInt32(8, true);
      const goalWord = words.getInt32(12, true), travelFlags = words.getInt32(16, true);
      const targetWord = words.getInt32(20, true);
      return Number(BotMovementRouting.predictVisiblePosition(qvmBotMovementVector(() => memory.pointer(originWord)),
        area, goalReference(memory, goalWord), travelFlags,
        qvmBotMovementTarget(() => memory.pointer(targetWord)), routing));
    }
    case 574: {
      const handle = words.getInt32(4, true), originWord = words.getInt32(8, true);
      const radius = words.getFloat32(12, true), type = words.getInt32(16, true);
      states.addAvoidSpot(handle, qvmBotMovementVector(() => memory.pointer(originWord)), radius, type);
      return 0;
    }
    default: return null;
  }
}
