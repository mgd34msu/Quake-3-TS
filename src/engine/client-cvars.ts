// CL_Init variable registration from id Software's code/client/cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { registerClientInputCvars } from "./client-input.ts";
import { registerClientClockCvars } from "./client-state.ts";

/** Linux client defaults, at the source CL_Init site after CL_InitInput. */
export function registerClientCvars(cvars: CvarRegistry): void {
  const archive = CvarFlag.Archive, userArchive = CvarFlag.UserInfo | archive;
  cvars.register("cl_noprint", "0");
  cvars.register("cl_motd", "1");
  cvars.register("cl_timeout", "200");
  registerClientClockCvars(cvars, "nudge");
  cvars.register("cl_shownet", "0", CvarFlag.Temporary);
  cvars.register("cl_showSend", "0", CvarFlag.Temporary);
  registerClientClockCvars(cvars, "delta-and-freeze");
  cvars.register("rconPassword", "", CvarFlag.Temporary);
  registerClientClockCvars(cvars, "active-action");
  registerClientClockCvars(cvars, "timedemo");
  cvars.register("cl_avidemo", "0");
  cvars.register("cl_forceavidemo", "0");
  cvars.register("rconAddress", "");
  registerClientInputCvars(cvars, "angle-speeds");
  cvars.register("cl_maxpackets", "30", archive);
  cvars.register("cl_packetdup", "1", archive);
  registerClientInputCvars(cvars, "movement");
  cvars.register("cl_allowDownload", "0", archive);
  cvars.register("cl_conXOffset", "0");
  cvars.register("r_inGameVideo", "1", archive);
  cvars.register("cl_serverStatusResendTime", "750");
  cvars.register("cg_autoswitch", "1", archive);
  registerClientInputCvars(cvars, "mouse");
  cvars.register("cl_motdString", "", CvarFlag.ReadOnly);
  cvars.register("cl_maxPing", "800", archive);
  cvars.register("name", "UnnamedPlayer", userArchive);
  cvars.register("rate", "3000", userArchive);
  cvars.register("snaps", "20", userArchive);
  cvars.register("model", "sarge", userArchive);
  cvars.register("headmodel", "sarge", userArchive);
  cvars.register("team_model", "james", userArchive);
  cvars.register("team_headmodel", "*james", userArchive);
  cvars.register("g_redTeam", "Stroggs", CvarFlag.ServerInfo | archive);
  cvars.register("g_blueTeam", "Pagans", CvarFlag.ServerInfo | archive);
  cvars.register("color1", "4", userArchive);
  cvars.register("color2", "5", userArchive);
  cvars.register("handicap", "100", userArchive);
  cvars.register("teamtask", "0", CvarFlag.UserInfo);
  cvars.register("sex", "male", userArchive);
  cvars.register("cl_anonymous", "0", userArchive);
  cvars.register("password", "", CvarFlag.UserInfo);
  cvars.register("cg_predictItems", "1", userArchive);
  cvars.register("cg_viewsize", "100", archive);
}
