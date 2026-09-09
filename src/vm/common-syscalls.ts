/*
 * Shared cases from Quake III Arena's UI, cgame and game syscall switches.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CvarRegistry } from "../core/cvar.ts";
import { qvmConsoleSyscall } from "./console-syscalls.ts";
import type { QvmConsoleServices } from "./console-syscalls.ts";
import { qvmCvarSyscall } from "./cvar-syscalls.ts";
import { qvmMathSyscall } from "./math-syscalls.ts";
import type { QvmMemory } from "./memory.ts";
import { qvmMemorySyscall } from "./memory-syscalls.ts";
import { qvmVectorSyscall } from "./vector-syscalls.ts";
import { qvmSnapVectorSyscall } from "./snap-vector-syscalls.ts";

export interface QvmCommonServices extends QvmConsoleServices {
  readonly cvars: CvarRegistry;
}

/** Null leaves role-specific engine traps to their actual owners. */
export function qvmCommonSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory, services: QvmCommonServices,
): number | Promise<number> | null {
  return qvmConsoleSyscall(role, words, memory, services)
    ?? qvmCvarSyscall(role, words, memory, services.cvars)
    ?? qvmMemorySyscall(role, words, memory)
    ?? qvmMathSyscall(role, words)
    ?? qvmVectorSyscall(role, words, memory)
    ?? qvmSnapVectorSyscall(role, words, memory);
}
