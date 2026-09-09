/*
 * Common console traps from Quake III Arena cl_ui.c, cl_cgame.c and sv_game.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommandBuffer } from "../core/commands.ts";
import { CommonError } from "../core/common-error.ts";
import type { ConsoleOutput } from "../core/console-output.ts";
import type { SystemClock } from "../platform/system-clock.ts";
import type { QvmMemory } from "./memory.ts";

export interface QvmConsoleServices {
  readonly commands: CommandBuffer;
  readonly output: ConsoleOutput;
  readonly clock: SystemClock;
}

interface ConsoleTraps {
  readonly print: number;
  readonly error: number;
  readonly argc: number;
  readonly argv: number;
  readonly execute: number;
}

const ui: ConsoleTraps = { print: 1, error: 0, argc: 10, argv: 11, execute: 12 };
const cgame: ConsoleTraps = { print: 0, error: 1, argc: 7, argv: 8, execute: 14 };
const game: ConsoleTraps = { print: 0, error: 1, argc: 8, argv: 9, execute: 14 };

/** Unhandled traps remain available to the role's other engine services. */
export function qvmConsoleSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, services: QvmConsoleServices,
): number | Promise<number> | null {
  const trap = words.getInt32(0, true), ids = role === "ui" ? ui : role === "cgame" ? cgame : game;
  const { commands, output, clock } = services;
  if (trap === ids.print) { output.print(memory.readString(words.getInt32(4, true))); return 0; }
  if (trap === ids.error) throw new CommonError("drop", memory.readString(words.getInt32(4, true)).slice(0, 4095));
  if (trap === 2) return clock.milliseconds();
  if (trap === ids.argc) return commands.tokenizedArguments.length;
  if (trap === ids.argv) {
    // Cmd_Argv deliberately returns an empty string for an out-of-range index.
    const value = commands.tokenizedArguments[words.getInt32(4, true)] ?? "";
    memory.writeString(words.getInt32(8, true), value, words.getInt32(12, true));
    return 0;
  }
  if (role === "cgame" && trap === 9) {
    const value = commands.tokenizedArguments.slice(1).join(" ");
    if (value.length >= 1024) throw new RangeError("Cmd_Args exceeds its source buffer");
    memory.writeString(words.getInt32(4, true), value, words.getInt32(8, true));
    return 0;
  }
  if (role === "cgame" && trap === 15) {
    commands.registerFallbackName(memory.readString(words.getInt32(4, true)));
    return 0;
  }
  if (role === "cgame" && trap === 72) {
    commands.unregister(memory.readString(words.getInt32(4, true)));
    return 0;
  }
  if (trap !== ids.execute) return null;
  if (role === "cgame") {
    commands.append(memory.readString(words.getInt32(4, true)));
    return 0;
  }
  const when = words.getInt32(4, true), textWord = words.getInt32(8, true);
  switch (when) {
    case 0: return commands.executeNowAsync(textWord === 0 ? null : memory.readString(textWord)).then(() => 0);
    case 1: commands.insert(memory.readString(textWord)); return 0;
    case 2: commands.append(memory.readString(textWord)); return 0;
    default: throw new CommonError("fatal", "Cbuf_ExecuteText: bad exec_when");
  }
}
