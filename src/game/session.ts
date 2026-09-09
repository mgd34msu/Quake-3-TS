/*
 * Session persistence translated from id Software's code/game/g_session.c,
 * with its required TeamCount/PickTeam dependency from g_client.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { Team, GameType } from "../shared/definitions.ts";
import type { PlayerStateSlots } from "../shared/player-state.ts";
import { gameFormat } from "./format.ts";
import { gameAtoi } from "./numeric.ts";
import { ConnectionState, SpectatorState } from "./state.ts";
import type { GameClient } from "./state.ts";

const MAX_STRING_CHARS = 1024;

export type SessionCvarName = "session" | `session${number}`;

export interface SessionCvarService {
  get(name: SessionCvarName): string;
  set(name: SessionCvarName, value: string): void;
}

export interface SessionUserinfo {
  valueForKey(key: "team"): string;
}

export interface SessionWorldState {
  readonly clients: readonly GameClient[];
  readonly maxClients: number;
  readonly teamScores: PlayerStateSlots;
  gameType: number;
  teamAutoJoin: boolean;
  maxGameClients: number;
  time: number;
  numNonSpectatorClients: number;
  newSession: boolean;
}

export interface SessionServices {
  readonly cvars: SessionCvarService;
  print(message: string): void;
  broadcastTeamChange(clientNum: number, oldTeam: Team | -1): void;
}

export class SessionDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDataError";
  }
}

interface IntegerScan {
  readonly value: number;
  readonly nextOffset: number;
}

function cvarBuffer(value: string): string {
  const nul = value.indexOf("\0");
  const visible = nul < 0 ? value : value.slice(0, nul);
  const bounded = visible.slice(0, MAX_STRING_CHARS - 1);
  for (let index = 0; index < bounded.length; index++) {
    if (bounded.charCodeAt(index) > 255) throw new SessionDataError("session cvar must contain byte characters");
  }
  return bounded;
}

function signedByte(buffer: string, offset: number): number {
  const byte = buffer.charCodeAt(offset);
  return byte < 128 ? byte : byte - 256;
}

/** Q3_VM bg_lib.c _atoi, with gameAtoi retaining the canonical wrapped value. */
function scanInteger(buffer: string, offset: number): IntegerScan {
  if (offset > buffer.length) {
    throw new SessionDataError("truncated session data scans beyond its terminating NUL");
  }
  const value = gameAtoi(buffer.slice(offset));
  let cursor = offset;
  while (cursor < buffer.length && signedByte(buffer, cursor) <= 32) cursor++;
  if (cursor === buffer.length) return { value, nextOffset: cursor };
  const sign = buffer.charCodeAt(cursor);
  if (sign === 43 || sign === 45) cursor++;
  while (true) {
    if (cursor === buffer.length) return { value, nextOffset: cursor + 1 };
    const character = buffer.charCodeAt(cursor);
    cursor++;
    if (character < 48 || character > 57) return { value, nextOffset: cursor };
  }
}

function clientAt(world: Pick<SessionWorldState, "clients" | "maxClients">, clientNum: number): GameClient {
  if (!Number.isInteger(clientNum) || clientNum < 0 || clientNum >= world.maxClients) {
    throw new RangeError(`session client ${clientNum} outside configured clients`);
  }
  const client = world.clients[clientNum];
  if (client === undefined) throw new RangeError(`session client ${clientNum} has no backing state`);
  return client;
}

export function teamCount(
  world: Pick<SessionWorldState, "clients" | "maxClients">,
  ignoreClientNum: number,
  team: Team,
): number {
  let count = 0;
  for (let index = 0; index < world.maxClients; index++) {
    if (index === ignoreClientNum) continue;
    const client = clientAt(world, index);
    if (client.pers.connected === ConnectionState.DISCONNECTED) continue;
    if (client.sess.sessionTeam === team) count++;
  }
  return count;
}

export function pickTeam(
  world: Pick<SessionWorldState, "clients" | "maxClients" | "teamScores">,
  ignoreClientNum: number,
): Team {
  const blueCount = teamCount(world, ignoreClientNum, Team.TEAM_BLUE);
  const redCount = teamCount(world, ignoreClientNum, Team.TEAM_RED);
  if (blueCount > redCount) return Team.TEAM_RED;
  if (redCount > blueCount) return Team.TEAM_BLUE;
  if (world.teamScores.get(Team.TEAM_BLUE) > world.teamScores.get(Team.TEAM_RED)) return Team.TEAM_RED;
  return Team.TEAM_BLUE;
}

export class GameSessionManager {
  constructor(
    private readonly world: SessionWorldState,
    private readonly services: SessionServices,
  ) {
    if (!Number.isInteger(world.maxClients) || world.maxClients < 0 || world.maxClients > world.clients.length) {
      throw new RangeError("session maxClients exceeds its client storage");
    }
    if (world.teamScores.length !== Team.TEAM_NUM_TEAMS) {
      throw new RangeError("session team scores require TEAM_NUM_TEAMS slots");
    }
  }

  writeClient(clientNum: number): void {
    const session = clientAt(this.world, clientNum).sess;
    const value = gameFormat("%i %i %i %i %i %i %i", [
      session.sessionTeam,
      session.spectatorTime,
      session.spectatorState,
      session.spectatorClient,
      session.wins,
      session.losses,
      session.teamLeader ? 1 : 0,
    ], MAX_STRING_CHARS);
    this.services.cvars.set(`session${clientNum}`, value);
  }

  readClient(clientNum: number): void {
    const session = clientAt(this.world, clientNum).sess;
    const buffer = cvarBuffer(this.services.cvars.get(`session${clientNum}`));
    let scan = scanInteger(buffer, 0);
    const sessionTeam = scan.value;
    scan = scanInteger(buffer, scan.nextOffset);
    session.spectatorTime = scan.value;
    scan = scanInteger(buffer, scan.nextOffset);
    const spectatorState = scan.value;
    scan = scanInteger(buffer, scan.nextOffset);
    session.spectatorClient = scan.value;
    scan = scanInteger(buffer, scan.nextOffset);
    session.wins = scan.value;
    scan = scanInteger(buffer, scan.nextOffset);
    session.losses = scan.value;
    scan = scanInteger(buffer, scan.nextOffset);
    const teamLeader = scan.value;
    session.sessionTeam = sessionTeam;
    session.spectatorState = spectatorState;
    session.teamLeader = teamLeader !== 0;
  }

  initializeClient(clientNum: number, userinfo: SessionUserinfo): void {
    const client = clientAt(this.world, clientNum);
    const session = client.sess;
    if (this.world.gameType >= GameType.GT_TEAM) {
      if (this.world.teamAutoJoin) {
        session.sessionTeam = pickTeam(this.world, -1);
        this.services.broadcastTeamChange(clientNum, -1);
      } else {
        session.sessionTeam = Team.TEAM_SPECTATOR;
      }
    } else if (userinfo.valueForKey("team").startsWith("s")) {
      session.sessionTeam = Team.TEAM_SPECTATOR;
    } else {
      switch (this.world.gameType) {
        case GameType.GT_TOURNAMENT:
          session.sessionTeam = this.world.numNonSpectatorClients >= 2 ? Team.TEAM_SPECTATOR : Team.TEAM_FREE;
          break;
        case GameType.GT_FFA:
        case GameType.GT_SINGLE_PLAYER:
        default:
          session.sessionTeam = this.world.maxGameClients > 0
            && this.world.numNonSpectatorClients >= this.world.maxGameClients
            ? Team.TEAM_SPECTATOR : Team.TEAM_FREE;
          break;
      }
    }
    session.spectatorState = SpectatorState.FREE;
    session.spectatorTime = this.world.time;
    this.writeClient(clientNum);
  }

  initializeWorld(): void {
    const previousGameType = gameAtoi(cvarBuffer(this.services.cvars.get("session")));
    if (this.world.gameType !== previousGameType) {
      this.world.newSession = true;
      this.services.print("Gametype changed, clearing session data.\n");
    }
  }

  writeWorld(): void {
    this.services.cvars.set("session", gameFormat("%i", [this.world.gameType], MAX_STRING_CHARS));
    for (let index = 0; index < this.world.maxClients; index++) {
      if (clientAt(this.world, index).pers.connected === ConnectionState.CONNECTED) this.writeClient(index);
    }
  }
}
