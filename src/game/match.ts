// Match rules translated from id Software's game/g_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { sub3, vec3, vectorToAngles } from "../core/math.ts";
import { EntityType, GameType, MoveType, PersistentIndex, Team, statSchema } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { PlayerStateSlots } from "../shared/player-state.ts";
import type { ClientSpawnRuntime, SpawnPose } from "./client-spawn.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { gameAtoi } from "./numeric.ts";
import type { GameRandom } from "./numeric.ts";
import { teamCount } from "./session.ts";
import { ConnectionState, MAX_CLIENTS, SpectatorState } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";
import { findEntity, pickTarget } from "./utilities.ts";

export class VoteState {
  time = 0; yes = 0; no = 0; string = ""; displayString = ""; executeTime = 0;
}
export class TeamVoteState { time = 0; yes = 0; no = 0; string = ""; }

/** The runtime extends this same level record; clients and scores remain in shared stores. */
export class MatchState {
  time = 0; startTime = 0; warmupTime = 0; warmupModificationCount = 0; restarted = false;
  numConnectedClients = 0; numNonSpectatorClients = 0; numPlayingClients = 0; numVotingClients = 0;
  readonly numTeamVotingClients: [number, number] = [0, 0];
  readonly sortedClients: number[] = Array.from({ length: MAX_CLIENTS }, () => 0);
  follow1 = 0; follow2 = 0;
  intermissionTime = 0; intermissionQueued = 0;
  intermissionOrigin = vec3(0, 0, 0); intermissionAngle = vec3(0, 0, 0);
  changemap: string | null = null; readyToExit = false; exitTime = 0;
  readonly vote = new VoteState();
  readonly teamVotes: [TeamVoteState, TeamVoteState] = [new TeamVoteState(), new TeamVoteState()];
}

export interface MatchSettings {
  readonly gameType: number;
  readonly timeLimit: number;
  readonly fragLimit: number;
  readonly captureLimit: number;
  readonly warmupSeconds: number;
  readonly warmupModificationCount: number;
  readonly password: string;
  readonly passwordModificationCount: number;
}
interface MatchServices {
  readonly state: MatchState;
  readonly pool: EntityPool;
  readonly teamScores: PlayerStateSlots;
  readonly random: Pick<GameRandom, "rand">;
  readonly spawn: Pick<ClientSpawnRuntime, "selectSpawnPoint" | "respawn">;
  settings(): MatchSettings;
  setTeam(entity: GameEntity, team: "f" | "s"): void;
  stopFollowing(entity: GameEntity): void;
  sendScoreboard(entity: GameEntity): void;
  clientUserinfoChanged(clientNum: number): void;
  writeSessionData(): void;
  appendConsoleCommand(text: string): void;
  sendServerCommand(clientNum: number, text: string): void;
  setConfigstring(index: number, text: string): void;
  setCvar(name: "g_restarted" | "g_needpass" | "ui_singlePlayerActive", value: string): void;
  log(text: string): void;
  warn(text: string): void;
  botInterbreedEndMatch(): void;
  updateTournamentInfo(): void;
}
export type MatchHost = MatchServices & (
  | { readonly product: "baseq3"; spawnModelsOnVictoryPads(): void }
  | { readonly product: "missionpack"; singlePlayer(): boolean }
);

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError("Match rank index has no source storage");
  return value;
}

/* The following rank-sort algorithm is translated from game/bg_lib.c qsort.
 * Copyright (c) 1992, 1993 The Regents of the University of California.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. All advertising materials mentioning features or use of this software
 *    must display the following acknowledgement: This product includes software
 *    developed by the University of California, Berkeley and its contributors.
 * 4. Neither the name of the University nor the names of its contributors may
 *    be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function sortRankPrefix(values: number[], count: number, compare: (first: number, second: number) => number): void {
  const cmp = (first: number, second: number): number => compare(at(values, first), at(values, second));
  const swap = (first: number, second: number): void => { const value = at(values, first); values[first] = at(values, second); values[second] = value; };
  const swapRange = (first: number, second: number, length: number): void => {
    for (let index = 0; index < length; index++) swap(first + index, second + index);
  };
  const median = (a: number, b: number, c: number): number => cmp(a, b) < 0
    ? cmp(b, c) < 0 ? b : cmp(a, c) < 0 ? c : a
    : cmp(b, c) > 0 ? b : cmp(a, c) < 0 ? a : c;
  const insertion = (start: number, length: number): void => {
    for (let mid = start + 1; mid < start + length; mid++) {
      for (let left = mid; left > start && cmp(left - 1, left) > 0; left--) swap(left, left - 1);
    }
  };
  function sort(start: number, length: number): void {
    while (true) {
      if (length < 7) { insertion(start, length); return; }
      let mid = start + Math.trunc(length / 2);
      if (length > 7) {
        let left = start, end = start + length - 1;
        if (length > 40) {
          const distance = Math.trunc(length / 8);
          left = median(left, left + distance, left + 2 * distance);
          mid = median(mid - distance, mid, mid + distance);
          end = median(end - 2 * distance, end - distance, end);
        }
        mid = median(left, mid, end);
      }
      swap(start, mid);
      let a = start + 1, b = a, c = start + length - 1, d = c, swapped = false;
      while (true) {
        while (b <= c) { const result = cmp(b, start); if (result > 0) break;
          if (result === 0) { swapped = true; swap(a, b); a++; } b++; }
        while (b <= c) { const result = cmp(c, start); if (result < 0) break;
          if (result === 0) { swapped = true; swap(c, d); d--; } c--; }
        if (b > c) break;
        swap(b, c); swapped = true; b++; c--;
      }
      if (!swapped) { insertion(start, length); return; }
      const end = start + length;
      let range = Math.min(a - start, b - a); swapRange(start, b - range, range);
      range = Math.min(d - c, end - d - 1); swapRange(b, end - range, range);
      if (b - a > 1) sort(start, b - a);
      range = d - c;
      if (range <= 1) return;
      start = end - range; length = range;
    }
  }
  sort(0, count);
}

export class MatchModuleState {
  passwordModificationCount = -1;
}

export class MatchRuntime {
  constructor(readonly host: MatchHost, private readonly moduleState = new MatchModuleState()) {
    if (host.pool.options.product !== host.product) throw new Error("Match product differs from its entity pool");
    if (host.teamScores.length !== 4) throw new RangeError("Match needs the shared four-team score storage");
  }
  private get level(): MatchState { return this.host.state; }
  private client(entity: GameEntity): GameClient {
    if (this.host.pool.get(entity.slot) !== entity || entity.client === null) throw new Error("Match requires an owned client entity");
    return entity.client;
  }
  private sorted(index: number): number { return at(this.level.sortedClients, index); }
  private score(index: number): number { return this.host.pool.clientAt(index).ps.persistant.get(PersistentIndex.PERS_SCORE); }

  addTournamentPlayer(): void {
    if (this.level.numPlayingClients >= 2 || this.level.intermissionTime !== 0) return;
    let selected: number | null = null;
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index);
      if (client.pers.connected !== ConnectionState.CONNECTED || client.sess.sessionTeam !== Team.TEAM_SPECTATOR ||
        client.sess.spectatorState === SpectatorState.SCOREBOARD || client.sess.spectatorClient < 0) continue;
      if (selected === null || client.sess.spectatorTime < this.host.pool.clientAt(selected).sess.spectatorTime) selected = index;
    }
    if (selected === null) return;
    this.level.warmupTime = -1; this.host.setTeam(this.host.pool.at(selected), "f");
  }
  private removeTournamentPlayer(rank: number): void {
    if (this.level.numPlayingClients !== 2) return;
    const number = this.sorted(rank);
    if (this.host.pool.clientAt(number).pers.connected === ConnectionState.CONNECTED) this.host.setTeam(this.host.pool.at(number), "s");
  }
  removeTournamentLoser(): void { this.removeTournamentPlayer(1); }
  removeTournamentWinner(): void { this.removeTournamentPlayer(0); }
  adjustTournamentScores(): void {
    const winner = this.sorted(0), first = this.host.pool.clientAt(winner);
    if (first.pers.connected === ConnectionState.CONNECTED) { first.sess.wins = (first.sess.wins + 1) | 0; this.host.clientUserinfoChanged(winner); }
    const loser = this.sorted(1), second = this.host.pool.clientAt(loser);
    if (second.pers.connected === ConnectionState.CONNECTED) { second.sess.losses = (second.sess.losses + 1) | 0; this.host.clientUserinfoChanged(loser); }
  }
  sortRanks(first: number, second: number): number {
    const a = this.host.pool.clientAt(first), b = this.host.pool.clientAt(second);
    if (a.sess.spectatorState === SpectatorState.SCOREBOARD || a.sess.spectatorClient < 0) return 1;
    if (b.sess.spectatorState === SpectatorState.SCOREBOARD || b.sess.spectatorClient < 0) return -1;
    if (a.pers.connected === ConnectionState.CONNECTING) return 1;
    if (b.pers.connected === ConnectionState.CONNECTING) return -1;
    if (a.sess.sessionTeam === Team.TEAM_SPECTATOR && b.sess.sessionTeam === Team.TEAM_SPECTATOR) {
      return a.sess.spectatorTime < b.sess.spectatorTime ? -1 : a.sess.spectatorTime > b.sess.spectatorTime ? 1 : 0;
    }
    if (a.sess.sessionTeam === Team.TEAM_SPECTATOR) return 1;
    if (b.sess.sessionTeam === Team.TEAM_SPECTATOR) return -1;
    return this.score(first) > this.score(second) ? -1 : this.score(first) < this.score(second) ? 1 : 0;
  }
  calculateRanks(): void {
    const level = this.level, pool = this.host.pool, gameType = this.host.settings().gameType;
    level.follow1 = level.follow2 = -1;
    level.numConnectedClients = level.numNonSpectatorClients = level.numPlayingClients = level.numVotingClients = 0;
    // Source clears four integers through a two-integer array; do not corrupt adjacent spawn state.
    level.numTeamVotingClients[0] = level.numTeamVotingClients[1] = 0;
    for (let index = 0; index < pool.maxClients; index++) {
      const client = pool.clientAt(index);
      if (client.pers.connected === ConnectionState.DISCONNECTED) continue;
      level.sortedClients[level.numConnectedClients++] = index;
      if (client.sess.sessionTeam === Team.TEAM_SPECTATOR) continue;
      level.numNonSpectatorClients++;
      if (client.pers.connected !== ConnectionState.CONNECTED) continue;
      level.numPlayingClients++;
      if ((pool.at(index).r.svFlags & ServerEntityFlags.BOT) === 0) {
        level.numVotingClients++;
        if (client.sess.sessionTeam === Team.TEAM_RED) level.numTeamVotingClients[0]++;
        else if (client.sess.sessionTeam === Team.TEAM_BLUE) level.numTeamVotingClients[1]++;
      }
      if (level.follow1 === -1) level.follow1 = index; else if (level.follow2 === -1) level.follow2 = index;
    }
    sortRankPrefix(level.sortedClients, level.numConnectedClients, (a, b) => this.sortRanks(a, b));
    if (gameType >= GameType.GT_TEAM) {
      const red = this.host.teamScores.get(Team.TEAM_RED), blue = this.host.teamScores.get(Team.TEAM_BLUE);
      for (let index = 0; index < level.numConnectedClients; index++) pool.clientAt(this.sorted(index)).ps.persistant.set(PersistentIndex.PERS_RANK,
        red === blue ? 2 : red > blue ? 0 : 1);
    } else {
      let rank = -1, score = 0;
      for (let index = 0; index < level.numPlayingClients; index++) {
        const client = pool.clientAt(this.sorted(index)), newScore = client.ps.persistant.get(PersistentIndex.PERS_SCORE);
        if (index === 0 || newScore !== score) { rank = index; client.ps.persistant.set(PersistentIndex.PERS_RANK, rank); }
        else { pool.clientAt(this.sorted(index - 1)).ps.persistant.set(PersistentIndex.PERS_RANK, rank | 0x4000);
          client.ps.persistant.set(PersistentIndex.PERS_RANK, rank | 0x4000); }
        score = newScore;
        if (gameType === GameType.GT_SINGLE_PLAYER && level.numPlayingClients === 1) client.ps.persistant.set(PersistentIndex.PERS_RANK, rank | 0x4000);
      }
    }
    if (gameType >= GameType.GT_TEAM) {
      this.host.setConfigstring(6, gameFormat("%i", [this.host.teamScores.get(Team.TEAM_RED)]));
      this.host.setConfigstring(7, gameFormat("%i", [this.host.teamScores.get(Team.TEAM_BLUE)]));
    } else {
      this.host.setConfigstring(6, gameFormat("%i", [level.numConnectedClients === 0 ? -9999 : this.score(this.sorted(0))]));
      this.host.setConfigstring(7, gameFormat("%i", [level.numConnectedClients < 2 ? -9999 : this.score(this.sorted(1))]));
    }
    this.checkExitRules();
    if (level.intermissionTime !== 0) this.sendScoreboardMessageToAllClients();
  }
  sendScoreboardMessageToAllClients(): void {
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      if (this.host.pool.clientAt(index).pers.connected === ConnectionState.CONNECTED) this.host.sendScoreboard(this.host.pool.at(index));
    }
  }
  moveClientToIntermission(entity: GameEntity): void {
    let client = this.client(entity);
    if (client.sess.spectatorState === SpectatorState.FOLLOW) this.host.stopFollowing(entity);
    client = this.client(entity);
    entity.s.origin = { ...this.level.intermissionOrigin }; client.ps.origin = { ...this.level.intermissionOrigin };
    client.ps.viewangles = { ...this.level.intermissionAngle }; client.ps.pmType = MoveType.PM_INTERMISSION;
    for (let index = 0; index < client.ps.powerups.length; index++) client.ps.powerups.set(index, 0);
    client.ps.eFlags = entity.s.eFlags = 0; entity.s.eType = EntityType.ET_GENERAL;
    entity.s.modelindex = entity.s.loopSound = entity.s.event = entity.r.contents = 0;
  }
  findIntermissionPoint(): SpawnPose {
    const entity = findEntity(this.host.pool, null, "classname", "info_player_intermission");
    if (entity === null) {
      const selected = this.host.spawn.selectSpawnPoint(vec3(0, 0, 0));
      this.level.intermissionOrigin = { ...selected.origin }; this.level.intermissionAngle = { ...selected.angles };
    } else {
      this.level.intermissionOrigin = { ...entity.s.origin }; this.level.intermissionAngle = { ...entity.s.angles };
      if (entity.target !== null) {
        const target = pickTarget({ pool: this.host.pool, randomInt: () => this.host.random.rand(), warn: text => { this.host.warn(text); } }, entity.target);
        if (target !== null) this.level.intermissionAngle = vectorToAngles(sub3(target.s.origin, this.level.intermissionOrigin));
      }
    }
    return { origin: { ...this.level.intermissionOrigin }, angles: { ...this.level.intermissionAngle } };
  }
  beginIntermission(): void {
    if (this.level.intermissionTime !== 0) return;
    if (this.host.settings().gameType === GameType.GT_TOURNAMENT) this.adjustTournamentScores();
    this.level.intermissionTime = this.level.time; this.findIntermissionPoint();
    if (this.host.product === "missionpack") {
      if (this.host.singlePlayer()) { this.host.setCvar("ui_singlePlayerActive", "0"); this.host.updateTournamentInfo(); }
    } else if (this.host.settings().gameType === GameType.GT_SINGLE_PLAYER) { this.host.updateTournamentInfo(); this.host.spawnModelsOnVictoryPads(); }
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const entity = this.host.pool.at(index); if (!entity.inuse) continue;
      if (entity.health <= 0) this.host.spawn.respawn(entity);
      this.moveClientToIntermission(entity);
    }
    this.sendScoreboardMessageToAllClients();
  }
  exitLevel(): void {
    this.host.botInterbreedEndMatch();
    if (this.host.settings().gameType === GameType.GT_TOURNAMENT) {
      if (!this.level.restarted) {
        this.removeTournamentLoser(); this.host.appendConsoleCommand("map_restart 0\n"); this.level.restarted = true;
        this.level.changemap = null; this.level.intermissionTime = 0;
      }
      return;
    }
    this.host.appendConsoleCommand("vstr nextmap\n"); this.level.changemap = null; this.level.intermissionTime = 0;
    this.host.teamScores.set(Team.TEAM_RED, 0); this.host.teamScores.set(Team.TEAM_BLUE, 0);
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index); if (client.pers.connected === ConnectionState.CONNECTED) client.ps.persistant.set(PersistentIndex.PERS_SCORE, 0);
    }
    this.host.writeSessionData();
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index); if (client.pers.connected === ConnectionState.CONNECTED) client.pers.connected = ConnectionState.CONNECTING;
    }
  }
  logExit(reason: string): void {
    const settings = this.host.settings(); let won = true;
    this.host.log(gameFormat("Exit: %s\n", [reason], 1024)); this.level.intermissionQueued = this.level.time; this.host.setConfigstring(22, "1");
    if (settings.gameType >= GameType.GT_TEAM) this.host.log(gameFormat("red:%i  blue:%i\n", [this.host.teamScores.get(Team.TEAM_RED), this.host.teamScores.get(Team.TEAM_BLUE)], 1024));
    for (let index = 0; index < Math.min(this.level.numConnectedClients, 32); index++) {
      const number = this.sorted(index), client = this.host.pool.clientAt(number);
      if (client.sess.sessionTeam === Team.TEAM_SPECTATOR || client.pers.connected === ConnectionState.CONNECTING) continue;
      this.host.log(gameFormat("score: %i  ping: %i  client: %i %s\n", [this.score(number), Math.min(client.ps.ping, 999), number, client.pers.netname], 1024));
      if (this.host.product === "missionpack" && this.host.singlePlayer() && settings.gameType === GameType.GT_TOURNAMENT &&
        (this.host.pool.at(number).r.svFlags & ServerEntityFlags.BOT) !== 0 && client.ps.persistant.get(PersistentIndex.PERS_RANK) === 0) won = false;
    }
    if (this.host.product === "missionpack" && this.host.singlePlayer()) {
      if (settings.gameType >= GameType.GT_CTF) won = this.host.teamScores.get(Team.TEAM_RED) > this.host.teamScores.get(Team.TEAM_BLUE);
      this.host.appendConsoleCommand(won ? "spWin\n" : "spLose\n");
    }
  }
  checkIntermissionExit(): void {
    if (this.host.settings().gameType === GameType.GT_SINGLE_PLAYER) return;
    let ready = 0, notReady = 0, mask = 0;
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index);
      if (client.pers.connected !== ConnectionState.CONNECTED || (this.host.pool.at(client.ps.clientNum).r.svFlags & ServerEntityFlags.BOT) !== 0) continue;
      if (client.readyToExit) { ready++; if (index < 16) mask |= 1 << index; } else notReady++;
    }
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index);
      if (client.pers.connected === ConnectionState.CONNECTED) client.ps.stats.set(statSchema(this.host.product).clientsReady, mask);
    }
    if (this.level.time < ((this.level.intermissionTime + 5000) | 0)) return;
    if (ready === 0) { this.level.readyToExit = false; return; }
    if (notReady === 0) { this.exitLevel(); return; }
    if (!this.level.readyToExit) { this.level.readyToExit = true; this.level.exitTime = this.level.time; }
    if (this.level.time >= ((this.level.exitTime + 10000) | 0)) this.exitLevel();
  }
  scoreIsTied(): boolean {
    if (this.level.numPlayingClients < 2) return false;
    return this.host.settings().gameType >= GameType.GT_TEAM
      ? this.host.teamScores.get(Team.TEAM_RED) === this.host.teamScores.get(Team.TEAM_BLUE) : this.score(this.sorted(0)) === this.score(this.sorted(1));
  }
  checkExitRules(): void {
    if (this.level.intermissionTime !== 0) { this.checkIntermissionExit(); return; }
    if (this.level.intermissionQueued !== 0) {
      const delay = this.host.product === "missionpack" && this.host.singlePlayer() ? 5000 : 1000;
      if (((this.level.time - this.level.intermissionQueued) | 0) >= delay) { this.level.intermissionQueued = 0; this.beginIntermission(); }
      return;
    }
    if (this.scoreIsTied()) return;
    const settings = this.host.settings();
    if (settings.timeLimit !== 0 && this.level.warmupTime === 0 && ((this.level.time - this.level.startTime) | 0) >= Math.imul(settings.timeLimit, 60000)) {
      this.host.sendServerCommand(-1, 'print "Timelimit hit.\n"'); this.logExit("Timelimit hit."); return;
    }
    if (this.level.numPlayingClients < 2) return;
    if (settings.gameType < GameType.GT_CTF && settings.fragLimit !== 0) {
      for (const [team, name] of [[Team.TEAM_RED, "Red"], [Team.TEAM_BLUE, "Blue"]] satisfies (readonly [Team, string])[]) {
        if (this.host.teamScores.get(team) >= settings.fragLimit) { this.host.sendServerCommand(-1, `print "${name} hit the fraglimit.\n"`); this.logExit("Fraglimit hit."); return; }
      }
      for (let index = 0; index < this.host.pool.maxClients; index++) {
        const client = this.host.pool.clientAt(index);
        if (client.pers.connected !== ConnectionState.CONNECTED || client.sess.sessionTeam !== Team.TEAM_FREE) continue;
        if (this.score(index) >= settings.fragLimit) {
          this.logExit("Fraglimit hit."); this.host.sendServerCommand(-1, gameFormat('print "%s^7 hit the fraglimit.\n"', [client.pers.netname], 1024)); return;
        }
      }
    }
    if (settings.gameType >= GameType.GT_CTF && settings.captureLimit !== 0) {
      for (const [team, name] of [[Team.TEAM_RED, "Red"], [Team.TEAM_BLUE, "Blue"]] satisfies (readonly [Team, string])[]) {
        if (this.host.teamScores.get(team) >= settings.captureLimit) { this.host.sendServerCommand(-1, `print "${name} hit the capturelimit.\n"`); this.logExit("Capturelimit hit."); return; }
      }
    }
  }
  checkTournament(): void {
    if (this.level.numPlayingClients === 0) return;
    let settings = this.host.settings();
    if (settings.gameType === GameType.GT_TOURNAMENT) {
      if (this.level.numPlayingClients < 2) this.addTournamentPlayer();
      if (this.level.numPlayingClients !== 2) { this.waitForPlayers(); return; }
      if (this.level.warmupTime === 0) return;
    } else {
      if (settings.gameType === GameType.GT_SINGLE_PLAYER || this.level.warmupTime === 0) return;
      const world = { clients: this.host.pool.clients, maxClients: this.host.pool.maxClients };
      const notEnough = settings.gameType > GameType.GT_TEAM ? teamCount(world, -1, Team.TEAM_RED) < 1 || teamCount(world, -1, Team.TEAM_BLUE) < 1 : this.level.numPlayingClients < 2;
      if (notEnough) { this.waitForPlayers(); return; }
    }
    settings = this.host.settings();
    if (settings.warmupModificationCount !== this.level.warmupModificationCount) {
      this.level.warmupModificationCount = settings.warmupModificationCount; this.level.warmupTime = -1;
    }
    if (this.level.warmupTime < 0) {
      this.level.warmupTime = (this.level.time + Math.imul((settings.warmupSeconds - 1) | 0, 1000)) | 0;
      this.host.setConfigstring(5, gameFormat("%i", [this.level.warmupTime])); return;
    }
    if (this.level.time > this.level.warmupTime) {
      this.level.warmupTime = (this.level.warmupTime + 10000) | 0; this.host.setCvar("g_restarted", "1");
      this.host.appendConsoleCommand("map_restart 0\n"); this.level.restarted = true;
    }
  }
  private waitForPlayers(): void {
    if (this.level.warmupTime === -1) return;
    this.level.warmupTime = -1; this.host.setConfigstring(5, "-1"); this.host.log("Warmup:\n");
  }
  checkVote(): void {
    const vote = this.level.vote;
    if (vote.executeTime !== 0 && vote.executeTime < this.level.time) { vote.executeTime = 0; this.host.appendConsoleCommand(`${vote.string}\n`); }
    if (vote.time === 0) return;
    if (((this.level.time - vote.time) | 0) >= 30000) this.host.sendServerCommand(-1, 'print "Vote failed.\n"');
    else if (vote.yes > Math.trunc(this.level.numVotingClients / 2)) {
      this.host.sendServerCommand(-1, 'print "Vote passed.\n"'); vote.executeTime = (this.level.time + 3000) | 0;
    } else if (vote.no >= Math.trunc(this.level.numVotingClients / 2)) this.host.sendServerCommand(-1, 'print "Vote failed.\n"');
    else return;
    vote.time = 0; this.host.setConfigstring(8, "");
  }
  printTeam(team: Team, message: string): void {
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      if (this.host.pool.clientAt(index).sess.sessionTeam === team) this.host.sendServerCommand(index, message);
    }
  }
  setLeader(team: Team, clientNum: number): void {
    const client = this.host.pool.clientAt(clientNum);
    if (client.pers.connected === ConnectionState.DISCONNECTED) { this.printTeam(team, gameFormat('print "%s is not connected\n"', [client.pers.netname], 1024)); return; }
    if (client.sess.sessionTeam !== team) { this.printTeam(team, gameFormat('print "%s is not on the team anymore\n"', [client.pers.netname], 1024)); return; }
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const other = this.host.pool.clientAt(index);
      if (other.sess.sessionTeam === team && other.sess.teamLeader) { other.sess.teamLeader = false; this.host.clientUserinfoChanged(index); }
    }
    client.sess.teamLeader = true; this.host.clientUserinfoChanged(clientNum);
    this.printTeam(team, gameFormat('print "%s is the new team leader\n"', [client.pers.netname], 1024));
  }
  checkTeamLeader(team: Team): void {
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index); if (client.sess.sessionTeam === team && client.sess.teamLeader) return;
    }
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index);
      if (client.sess.sessionTeam === team && (this.host.pool.at(index).r.svFlags & ServerEntityFlags.BOT) === 0) { client.sess.teamLeader = true; break; }
    }
    // The second source loop is unconditional and may make a preceding bot a second leader.
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const client = this.host.pool.clientAt(index); if (client.sess.sessionTeam === team) { client.sess.teamLeader = true; break; }
    }
  }
  checkTeamVote(team: Team): void {
    if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return;
    const offset = team === Team.TEAM_RED ? 0 : 1, vote = this.level.teamVotes[offset];
    if (vote.time === 0) return;
    const majority = Math.trunc(this.level.numTeamVotingClients[offset] / 2);
    if (((this.level.time - vote.time) | 0) >= 30000) this.host.sendServerCommand(-1, 'print "Team vote failed.\n"');
    else if (vote.yes > majority) {
      this.host.sendServerCommand(-1, 'print "Team vote passed.\n"');
      if (vote.string.startsWith("leader")) this.setLeader(team, gameAtoi(vote.string.slice(7)));
      else this.host.appendConsoleCommand(`${vote.string}\n`);
    } else if (vote.no >= majority) this.host.sendServerCommand(-1, 'print "Team vote failed.\n"');
    else return;
    vote.time = 0; this.host.setConfigstring(12 + offset, "");
  }
  checkCvars(): void {
    const settings = this.host.settings();
    if (settings.passwordModificationCount === this.moduleState.passwordModificationCount) return;
    this.moduleState.passwordModificationCount = settings.passwordModificationCount;
    this.host.setCvar("g_needpass", settings.password.length !== 0 && settings.password.toLowerCase() !== "none" ? "1" : "0");
  }
}
