// Client-static lifetime and clock cvar registration from id Software's client.h
// and cl_main.c:CL_Init. Copyright (C) 1999-2005 Id Software, Inc.
// GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { ClientReliableCommands } from "../protocol/reliable.ts";
import type { Ipv4Address } from "../platform/network.ts";
import type { LoopbackAddress } from "../protocol/loopback.ts";
import type { ClientDemoRecording } from "./client-demo-recording.ts";
import type { ClientDemoPlayback } from "./client-demo-playback.ts";
import type { ClientDownloads } from "./client-download.ts";

export type ClientPacketAddress = Ipv4Address | LoopbackAddress;

export type ClientConnectionPhase =
  | "uninitialized" | "disconnected" | "connecting" | "challenging"
  | "connected" | "loading" | "primed" | "active" | "cinematic";

/** Borrowed by connections; only the engine client owner advances these clocks. */
export class ClientStaticState {
  phase: ClientConnectionPhase = "uninitialized";
  servername = "";
  updateInfoString = "";
  realtime = 0;
  realFrameTime = 0;
  frameTime = 0;
  frameCount = 0;
  // CL_GetServerCommand's static assembly buffer survives both cl and clc clears.
  bigConfigString = "";
}

/** Created before admission; preserved across gamestates, reset at disconnect. */
export class ClientConnectionState {
  readonly reliable = new ClientReliableCommands();
  readonly serverCommands = Array.from({ length: 64 }, () => "");
  serverCommandSequence = 0;
  lastExecutedServerCommand = 0;
  serverAddress: ClientPacketAddress | null = null;
  challenge = 0;
  connectTime = 0;
  connectPacketCount = 0;
  serverMessage = "";
  demoPlaying = false;
  demoWaiting = false;
  demoRecording: ClientDemoRecording | null = null;
  demoPlayback: ClientDemoPlayback | null = null;
  downloads: ClientDownloads | null = null;
  connectedToPureServer = false;
  downloadTempName = "";
  lastPacketTime = 0;
  lastPacketSentTime = 0;
}

export type ClientClockCvarGroup = "nudge" | "delta-and-freeze" | "active-action" | "timedemo";

/** CL_Init interleaves shownet/showSend and rconPassword between these groups. */
export function registerClientClockCvars(cvars: CvarRegistry, group: ClientClockCvarGroup): void {
  switch (group) {
    case "nudge": cvars.register("cl_timeNudge", "0", CvarFlag.Temporary); break;
    case "delta-and-freeze":
      cvars.register("cl_showTimeDelta", "0", CvarFlag.Temporary);
      cvars.register("cl_freezeDemo", "0", CvarFlag.Temporary);
      break;
    case "active-action": cvars.register("activeAction", "", CvarFlag.Temporary); break;
    case "timedemo": cvars.register("timedemo", "0", CvarFlag.None); break;
  }
}
