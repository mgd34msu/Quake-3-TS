// Port of id Software's unix_main.c Sys_Init and unix_shared.c Sys_GetCurrentUser.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { arch, platform, userInfo } from "node:os";
import type { CvarRegistry } from "../core/cvar.ts";

function currentUser(): string {
  try { return userInfo().username; }
  catch { return "player"; }
}

export function initializeSystemCvars(cvars: CvarRegistry): void {
  cvars.set("arch", `${platform()} ${arch()} TypeScript`, true);
  cvars.set("username", currentUser(), true);
}
