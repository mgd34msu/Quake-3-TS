// Server cvar registration from id Software's code/server/sv_init.c:SV_Init.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";

type ServerCvarRegistration = readonly [name: string, defaultValue: string, flags: number];

const registrations: readonly ServerCvarRegistration[] = [
  ["dmflags", "0", CvarFlag.ServerInfo],
  ["fraglimit", "20", CvarFlag.ServerInfo],
  ["timelimit", "0", CvarFlag.ServerInfo],
  ["g_gametype", "0", CvarFlag.ServerInfo | CvarFlag.Latch],
  ["sv_keywords", "", CvarFlag.ServerInfo],
  ["protocol", "68", CvarFlag.ServerInfo | CvarFlag.ReadOnly],
  ["mapname", "nomap", CvarFlag.ServerInfo | CvarFlag.ReadOnly],
  ["sv_privateClients", "0", CvarFlag.ServerInfo],
  ["sv_hostname", "noname", CvarFlag.ServerInfo | CvarFlag.Archive],
  ["sv_maxclients", "8", CvarFlag.ServerInfo | CvarFlag.Latch],
  ["sv_maxRate", "0", CvarFlag.Archive | CvarFlag.ServerInfo],
  ["sv_minPing", "0", CvarFlag.Archive | CvarFlag.ServerInfo],
  ["sv_maxPing", "0", CvarFlag.Archive | CvarFlag.ServerInfo],
  ["sv_floodProtect", "1", CvarFlag.Archive | CvarFlag.ServerInfo],
  ["sv_cheats", "1", CvarFlag.SystemInfo | CvarFlag.ReadOnly],
  ["sv_serverid", "0", CvarFlag.SystemInfo | CvarFlag.ReadOnly],
  ["sv_pure", "1", CvarFlag.SystemInfo],
  ["sv_paks", "", CvarFlag.SystemInfo | CvarFlag.ReadOnly],
  ["sv_pakNames", "", CvarFlag.SystemInfo | CvarFlag.ReadOnly],
  ["sv_referencedPaks", "", CvarFlag.SystemInfo | CvarFlag.ReadOnly],
  ["sv_referencedPakNames", "", CvarFlag.SystemInfo | CvarFlag.ReadOnly],
  ["rconPassword", "", CvarFlag.Temporary],
  ["sv_privatePassword", "", CvarFlag.Temporary],
  ["sv_fps", "20", CvarFlag.Temporary],
  ["sv_timeout", "200", CvarFlag.Temporary],
  ["sv_zombietime", "2", CvarFlag.Temporary],
  ["nextmap", "", CvarFlag.Temporary],
  ["sv_allowDownload", "0", CvarFlag.ServerInfo],
  ["sv_master1", "master.quake3arena.com", CvarFlag.None],
  ["sv_master2", "", CvarFlag.Archive],
  ["sv_master3", "", CvarFlag.Archive],
  ["sv_master4", "", CvarFlag.Archive],
  ["sv_master5", "", CvarFlag.Archive],
  ["sv_reconnectlimit", "3", CvarFlag.None],
  ["sv_showloss", "0", CvarFlag.None],
  ["sv_padPackets", "0", CvarFlag.None],
  ["sv_killserver", "0", CvarFlag.None],
  ["sv_mapChecksum", "", CvarFlag.ReadOnly],
  ["sv_lanForceRate", "1", CvarFlag.Archive],
  ["sv_strictAuth", "1", CvarFlag.Archive],
];

/** Registers only SV_Init's dmflags-through-sv_strictAuth cvars; operator commands and bot initialization are separate owners. */
export function registerServerCvars(cvars: Pick<CvarRegistry, "register">): void {
  for (const [name, defaultValue, flags] of registrations) cvars.register(name, defaultValue, flags);
}
