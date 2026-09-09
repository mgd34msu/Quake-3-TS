/*
 * Goal traps from id Software's code/server/sv_game.c, game/g_public.h,
 * game/be_ai_goal.h and botlib/be_ai_goal.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { touchingGoal } from "../botlib/goals.ts";
import type { BotGoalLibrary } from "../botlib/goals.ts";
import type { Vec3 } from "../core/math.ts";
import { float32ToBits } from "../core/numeric.ts";
import { QVM_BOT_GOAL_BYTES, copyQvmBotGoal, readQvmBotGoalReference, writeQvmBotGoal } from "./bot-goal-record.ts";
import type { QvmMemory } from "./memory.ts";

function field(bytes: Uint8Array | null, offset: number): DataView {
  if (bytes === null) throw new RangeError("QVM bot goal input requires a nonnull pointer");
  if (offset + 4 > bytes.byteLength) throw new RangeError("QVM bot goal input exceeds allocation");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
}

function vector(bytes: Uint8Array | null, offset = 0): Vec3 {
  return {
    get x(): number { return field(bytes, offset).getFloat32(0, true); },
    get y(): number { return field(bytes, offset + 4).getFloat32(0, true); },
    get z(): number { return field(bytes, offset + 8).getFloat32(0, true); },
  };
}

function inventory(memory: QvmMemory, word: number): (index: number) => number {
  return index => memory.view(word, 4, index * 4).getInt32(0, true);
}

function goalName(bytes: Uint8Array | null): (candidate: string) => boolean {
  return candidate => {
    if (bytes === null) return false;
    for (let index = 0; index <= candidate.length; index++) {
      const byte = bytes[index];
      if (byte === undefined) throw new RangeError("QVM bot goal name exceeds allocation");
      const expected = index === candidate.length ? 0 : candidate.charCodeAt(index);
      const folded = byte >= 97 && byte <= 122 ? byte - 32 : byte;
      const foldedExpected = expected >= 97 && expected <= 122 ? expected - 32 : expected;
      if (folded !== foldedExpected) return false;
      if (byte === 0) return true;
    }
    return false;
  };
}

/** Borrows the actual goal owner and reads pointer fields only at reached uses. */
export function qvmBotGoalSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, goals: BotGoalLibrary,
): number | null {
  if (role !== "game") return null;
  switch (words.getInt32(0, true)) {
    case 525: goals.resetGoalState(words.getInt32(4, true)); return 0;
    case 526: goals.resetAvoidGoals(words.getInt32(4, true)); return 0;
    case 527: {
      const handle = words.getInt32(4, true), goalWord = words.getInt32(8, true);
      goals.pushGoal(handle, () => {
        const view = memory.view(goalWord, QVM_BOT_GOAL_BYTES);
        return new Uint8Array(view.buffer, view.byteOffset, QVM_BOT_GOAL_BYTES);
      });
      return 0;
    }
    case 528: goals.popGoal(words.getInt32(4, true)); return 0;
    case 529: goals.emptyGoalStack(words.getInt32(4, true)); return 0;
    case 530: goals.dumpAvoidGoals(words.getInt32(4, true)); return 0;
    case 531: goals.dumpGoalStack(words.getInt32(4, true)); return 0;
    case 532: {
      const number = words.getInt32(4, true), outputWord = words.getInt32(8, true), size = words.getInt32(12, true);
      goals.writeGoalName(number, name => {
        memory.writeBoundedString(outputWord, name, size);
        return undefined;
      }, () => {
        memory.view(outputWord, 1).setUint8(0, 0);
        return undefined;
      });
      return 0;
    }
    case 533:
    case 534: {
      const trap = words.getInt32(0, true), handle = words.getInt32(4, true), outputWord = words.getInt32(8, true);
      const goal = trap === 533 ? goals.getTopGoalBytes(handle) : goals.getSecondGoalBytes(handle);
      if (goal === null) return 0;
      copyQvmBotGoal(memory.view(outputWord, QVM_BOT_GOAL_BYTES), goal);
      return 1;
    }
    case 535: {
      const handle = words.getInt32(4, true), originWord = words.getInt32(8, true);
      const inventoryWord = words.getInt32(12, true), travelFlags = words.getInt32(16, true);
      return Number(goals.chooseLTGItem(handle, vector(memory.pointer(originWord)),
        inventory(memory, inventoryWord), travelFlags));
    }
    case 536: {
      const handle = words.getInt32(4, true), originWord = words.getInt32(8, true);
      const inventoryWord = words.getInt32(12, true), travelFlags = words.getInt32(16, true);
      const longTermWord = words.getInt32(20, true), maxTime = words.getFloat32(24, true);
      return Number(goals.chooseNBGItem(handle, vector(memory.pointer(originWord)),
        inventory(memory, inventoryWord), travelFlags,
        longTermWord === 0 ? null : readQvmBotGoalReference(() => memory.pointer(longTermWord)), maxTime));
    }
    case 537: {
      const originWord = words.getInt32(4, true), goalWord = words.getInt32(8, true);
      return Number(touchingGoal(vector(memory.pointer(originWord)), readQvmBotGoalReference(() => memory.pointer(goalWord))));
    }
    case 538: {
      const viewer = words.getInt32(4, true), eyeWord = words.getInt32(8, true);
      const viewAnglesWord = words.getInt32(12, true), goalWord = words.getInt32(16, true);
      return Number(goals.itemGoalInVisButNotVisible(viewer, vector(memory.pointer(eyeWord)),
        vector(memory.pointer(viewAnglesWord)), readQvmBotGoalReference(() => memory.pointer(goalWord))));
    }
    case 539: {
      const index = words.getInt32(4, true), nameWord = words.getInt32(8, true), outputWord = words.getInt32(12, true);
      const goal = goals.getLevelItemGoal(index, goalName(memory.pointer(nameWord)));
      if (goal === null) return -1;
      writeQvmBotGoal(memory.view(outputWord, 52), goal, "level-item");
      return goal.number;
    }
    case 540: {
      const handle = words.getInt32(4, true), number = words.getInt32(8, true);
      return float32ToBits(goals.avoidGoalTime(handle, number)) | 0;
    }
    case 541: goals.initLevelItems(); return 0;
    case 542: goals.updateEntityItems(); return 0;
    case 543: {
      const handle = words.getInt32(4, true), nameWord = words.getInt32(8, true);
      return goals.loadItemWeights(handle, () => memory.readString(nameWord));
    }
    case 544: goals.freeItemWeights(words.getInt32(4, true)); return 0;
    case 546: return goals.allocGoalState(words.getInt32(4, true));
    case 547: goals.freeGoalState(words.getInt32(4, true)); return 0;
    case 567: {
      const index = words.getInt32(4, true), outputWord = words.getInt32(8, true);
      const result = goals.getNextCampSpotGoal(index);
      if (result === null) return 0;
      writeQvmBotGoal(memory.view(outputWord, 44), result.goal, "location");
      return result.next;
    }
    case 568: {
      const nameWord = words.getInt32(4, true), outputWord = words.getInt32(8, true);
      const goal = goals.getMapLocationGoal(goalName(memory.pointer(nameWord)));
      if (goal === null) return 0;
      writeQvmBotGoal(memory.view(outputWord, 44), goal, "location");
      return 1;
    }
    case 571: {
      const handle = words.getInt32(4, true), number = words.getInt32(8, true);
      goals.removeFromAvoidGoals(handle, number);
      return 0;
    }
    case 573: {
      const handle = words.getInt32(4, true), number = words.getInt32(8, true), duration = words.getFloat32(12, true);
      goals.setAvoidGoalTime(handle, number, duration);
      return 0;
    }
    default: return null;
  }
}
