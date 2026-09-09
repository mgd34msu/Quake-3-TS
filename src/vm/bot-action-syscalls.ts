/*
 * Elementary bot action traps from id Software's server/sv_game.c,
 * game/g_public.h, botlib/be_ea.c and game/botlib.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { BotActionBuffer } from "../botlib/actions.ts";
import type { Vec3 } from "../core/math.ts";
import { runCalls } from "../core/call-steps.ts";
import type { QvmMemory } from "./memory.ts";

function vector(memory: QvmMemory, pointer: number): Vec3 {
  const view = memory.view(pointer, 12);
  return { x: view.getFloat32(0, true), y: view.getFloat32(4, true), z: view.getFloat32(8, true) };
}

/**
 * Borrows the actual botlib action allocation. Vector spans reject before copying any
 * component; output spans reject at the reached memcpy, after thinktime changes.
 */
export function qvmBotActionSyscall(
  role: "game" | "cgame" | "ui",
  words: DataView,
  memory: QvmMemory,
  actions: BotActionBuffer,
): number | Promise<number> | null {
  if (role !== "game") return null;
  const trap = words.getInt32(0, true);
  if (trap < 400 || trap > 423) return null;
  const client = words.getInt32(4, true);
  switch (trap) {
    case 400:
    case 401:
    case 402: {
      const textWord = words.getInt32(8, true);
      const text = memory.readString(textWord);
      const result = runCalls(trap === 400 ? actions.sayCalls(client, text)
        : trap === 401 ? actions.sayTeamCalls(client, text) : actions.commandCalls(client, text));
      return result instanceof Promise ? result.then(() => 0) : 0;
    }
    case 403: actions.action(client, words.getInt32(8, true)); return -1;
    case 404: actions.gesture(client); return 0;
    case 405: actions.talk(client); return 0;
    case 406: actions.attack(client); return 0;
    case 407: actions.use(client); return 0;
    case 408: actions.respawn(client); return 0;
    case 409: actions.crouch(client); return 0;
    case 410: actions.moveUp(client); return 0;
    case 411: actions.moveDown(client); return 0;
    case 412: actions.moveForward(client); return 0;
    case 413: actions.moveBack(client); return 0;
    case 414: actions.moveLeft(client); return 0;
    case 415: actions.moveRight(client); return 0;
    case 416: actions.selectWeapon(client, words.getInt32(8, true)); return 0;
    case 417: actions.jump(client); return 0;
    case 418: actions.delayedJump(client); return 0;
    case 419: {
      const directionWord = words.getInt32(8, true), speed = words.getFloat32(12, true);
      actions.move(client, () => vector(memory, directionWord), speed);
      return 0;
    }
    case 420: {
      const anglesWord = words.getInt32(8, true);
      actions.view(client, () => vector(memory, anglesWord));
      return 0;
    }
    case 421: {
      const thinkTime = words.getFloat32(8, true);
      actions.endRegular(client, thinkTime);
      return 0;
    }
    case 422: {
      const thinkTime = words.getFloat32(8, true), outputWord = words.getInt32(12, true);
      const input = actions.getInputBytes(client, thinkTime);
      const output = memory.view(outputWord, 40);
      new Uint8Array(output.buffer, output.byteOffset, output.byteLength).set(input);
      return 0;
    }
    case 423: actions.resetInput(client); return 0;
    default: return null;
  }
}
