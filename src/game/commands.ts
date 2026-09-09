/*
 * Ported from id Software's code/game/g_cmds.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { vec3 } from "../core/math.ts";
import { infoSetValueForKey } from "../core/info-string.ts";
import { GameType, PersistentIndex, Team, Weapon, statSchema, weaponCount } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { findItem } from "../shared/items.ts";
import { MoveFlags } from "../shared/player-state.ts";
import type { PlayerStateSlots } from "../shared/player-state.ts";
import type { ClientAdmissionRuntime } from "./client-admission.ts";
import type { ClientSpawnRuntime } from "./client-spawn.ts";
import type { DeathRuntime } from "./death.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { finishSpawningItem, spawnItem, touchItem } from "./item-lifecycle.ts";
import type { ItemLifecycleContext } from "./item-lifecycle.ts";
import type { MatchRuntime, MatchState } from "./match.ts";
import { teleportPlayer } from "./misc.ts";
import type { TeleportContext } from "./misc.ts";
import { gameAtof, gameAtoi } from "./numeric.ts";
import { pickTeam, teamCount } from "./session.ts";
import { SpawnVariables } from "./spawn.ts";
import { ConnectionState, GameFlags, MAX_CLIENTS, SpectatorState, TeamState } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";
import { onSameTeam } from "./team.ts";
import type { TeamRuntime } from "./team.ts";

const EF_VOTED = 0x4000, EF_TEAMVOTED = 0x80000;
const MAX_VOTE_COUNT = 3, MAX_STRING_CHARS = 1024, MAX_SAY_TEXT = 150;
const MOD_GAUNTLET = 2, MOD_SUICIDE = 20;
const orders = ["hold your position", "hold this position", "come here", "cover me", "guard location", "search and destroy", "report"];
const gameNames = ["Free For All", "Tournament", "Single Player", "Team Deathmatch", "Capture the Flag", "One Flag CTF", "Overload", "Harvester"];

export type SayMode = "all" | "team" | "tell";

export interface CommandSettings {
  readonly gameType: number;
  readonly cheats: boolean;
  readonly teamForceBalance: boolean;
  readonly maxGameClients: number;
  readonly dedicated: boolean;
  readonly allowVote: boolean;
}

/** Engine imports consume source command strings; they do not re-escape chat/votes. */
export interface GameCommandImports {
  sendServerCommand(clientNum: number, text: string): void;
  setConfigstring(index: number, text: string): void;
  appendConsoleCommand(text: string): void;
  getCvar(name: string): string;
  getUserinfo(clientNum: number): string;
  setUserinfo(clientNum: number, text: string): void;
  log(text: string): void;
  print(text: string): void;
}

export interface GameCommandHost {
  readonly pool: EntityPool;
  readonly state: MatchState;
  readonly teamScores: PlayerStateSlots;
  readonly settings: CommandSettings;
  readonly imports: GameCommandImports;
  readonly team: Pick<TeamRuntime, "getLocationMessage">;
  readonly death: Pick<DeathRuntime, "playerDie">;
  readonly spawn: Pick<ClientSpawnRuntime, "copyToBodyQueue">;
  readonly admission: Pick<ClientAdmissionRuntime, "begin" | "userinfoChanged">;
  readonly match: Pick<MatchRuntime, "beginIntermission" | "setLeader" | "checkTeamLeader">;
  readonly items: ItemLifecycleContext;
  readonly teleport: TeleportContext;
}

export class GameCommandError extends Error {
  constructor(message: string) { super(message); this.name = "GameCommandError"; }
}

/** trap_Argv and Q_strncpyz operate on byte strings with a terminating NUL. */
function bounded(text: string, capacity: number): string {
  const nul = text.indexOf("\0");
  const result = text.slice(0, Math.min(nul < 0 ? text.length : nul, capacity - 1));
  for (let index = 0; index < result.length; index++) {
    if (result.charCodeAt(index) > 255) throw new GameCommandError("Game commands require byte strings");
  }
  return result;
}

class Arguments {
  readonly values: readonly string[];

  constructor(values: readonly string[]) {
    if (values.length > 1024) throw new GameCommandError("Command exceeds MAX_STRING_TOKENS");
    this.values = values.map(value => bounded(value, MAX_STRING_CHARS));
  }

  get length(): number { return this.values.length; }
  at(index: number, capacity = MAX_STRING_CHARS): string {
    const value = this.values[index];
    return value === undefined ? "" : bounded(value, capacity);
  }

  concat(start: number): string {
    let result = "";
    for (let index = start; index < this.values.length; index++) {
      const value = this.at(index);
      if (result.length + value.length >= MAX_STRING_CHARS - 1) break;
      result += value;
      if (index !== this.values.length - 1) result += " ";
    }
    return result;
  }
}

export function concatCommandArgs(argv: readonly string[], start: number): string {
  if (!Number.isInteger(start) || start < 0) throw new GameCommandError("ConcatArgs start must be a nonnegative integer");
  return new Arguments(argv).concat(start);
}

function lower(text: string): string { return text.replace(/[A-Z]/g, character => character.toLowerCase()); }

/** SanitizeString intentionally recognizes ESC pairs, not Quake caret colors. */
function sanitize(text: string): string {
  let result = "";
  const input = bounded(text, MAX_STRING_CHARS);
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code === 27) {
      if (index + 1 === input.length) throw new GameCommandError("SanitizeString ESC pair crosses the terminating NUL");
      index++;
    } else if (code >= 32 && code < 128) result += lower(input.charAt(index));
  }
  return result;
}

function cleanName(text: string): string {
  let result = "";
  const input = bounded(text, 36);
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (input.charAt(index) === "^" && index + 1 < input.length && input.charAt(index + 1) !== "^") index++;
    else if (code >= 32 && code <= 126) result += input.charAt(index);
  }
  return lower(result);
}

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new GameCommandError("Player command requires a client entity");
  return entity.client;
}

export class GameCommandRuntime {
  constructor(readonly host: GameCommandHost) {
    if (host.teamScores.length !== 4) throw new GameCommandError("Commands require the shared four-slot team score table");
  }

  private print(entity: GameEntity, text: string): void {
    this.host.imports.sendServerCommand(entity.slot, gameFormat('print "%s"', [text]));
  }

  scoreboard(entity: GameEntity): void {
    const { state, pool } = this.host;
    let text = "", count = 0;
    for (; count < state.numConnectedClients; count++) {
      const slot = state.sortedClients[count];
      if (slot === undefined) throw new GameCommandError("Scoreboard sorted-client prefix exceeds its backing storage");
      const client = pool.clientAt(slot), persistent = client.ps.persistant;
      const ping = client.pers.connected === ConnectionState.CONNECTING ? -1 : Math.min(client.ps.ping, 999);
      const accuracy = client.accuracyShots === 0 ? 0 : Math.trunc(Math.imul(client.accuracyHits, 100) / client.accuracyShots) | 0;
      const perfect = persistent.get(PersistentIndex.PERS_RANK) === 0 && persistent.get(PersistentIndex.PERS_KILLED) === 0 ? 1 : 0;
      const entry = gameFormat(" %i %i %i %i %i %i %i %i %i %i %i %i %i %i", [
        slot, persistent.get(PersistentIndex.PERS_SCORE), ping, Math.trunc(((state.time - client.pers.enterTime) | 0) / 60000),
        0, pool.at(slot).s.powerups, accuracy, persistent.get(PersistentIndex.PERS_IMPRESSIVE_COUNT),
        persistent.get(PersistentIndex.PERS_EXCELLENT_COUNT), persistent.get(PersistentIndex.PERS_GAUNTLET_FRAG_COUNT),
        persistent.get(PersistentIndex.PERS_DEFEND_COUNT), persistent.get(PersistentIndex.PERS_ASSIST_COUNT), perfect,
        persistent.get(PersistentIndex.PERS_CAPTURES),
      ], 1024);
      if (text.length + entry.length > 1024) break;
      text += entry;
    }
    this.host.imports.sendServerCommand(entity.slot, gameFormat("scores %i %i %i%s", [count,
      this.host.teamScores.get(Team.TEAM_RED), this.host.teamScores.get(Team.TEAM_BLUE), text]));
  }

  private cheatsOk(entity: GameEntity): boolean {
    if (!this.host.settings.cheats) { this.print(entity, "Cheats are not enabled on this server.\n"); return false; }
    if (entity.health <= 0) { this.print(entity, "You must be alive to use this command.\n"); return false; }
    return true;
  }

  clientNumberFromString(entity: GameEntity, text: string): number | null {
    const input = bounded(text, MAX_STRING_CHARS), first = input.charAt(0);
    if (first >= "0" && first <= "9") {
      const slot = gameAtoi(input);
      if (slot < 0 || slot >= this.host.pool.maxClients) { this.print(entity, gameFormat("Bad client slot: %i\n", [slot])); return null; }
      if (this.host.pool.clientAt(slot).pers.connected !== ConnectionState.CONNECTED) {
        this.print(entity, gameFormat("Client %i is not active\n", [slot])); return null;
      }
      return slot;
    }
    const name = sanitize(input);
    for (let slot = 0; slot < this.host.pool.maxClients; slot++) {
      const client = this.host.pool.clientAt(slot);
      if (client.pers.connected === ConnectionState.CONNECTED && sanitize(client.pers.netname) === name) return slot;
    }
    this.print(entity, gameFormat("User %s is not on the server\n", [input]));
    return null;
  }

  private give(entity: GameEntity, args: Arguments): void {
    if (!this.cheatsOk(entity)) return;
    const name = args.concat(1), key = lower(name), all = key === "all";
    const client = clientOf(entity), schema = statSchema(client.ps.product);
    if (all || key === "health") { entity.health = client.ps.stats.get(schema.maxHealth); if (!all) return; }
    if (all || key === "weapons") {
      client.ps.stats.set(schema.weapons, (1 << weaponCount(client.ps.product)) - 1 - (1 << Weapon.WP_GRAPPLING_HOOK) - (1 << Weapon.WP_NONE));
      if (!all) return;
    }
    if (all || key === "ammo") { for (let index = 0; index < 16; index++) client.ps.ammo.set(index, 999); if (!all) return; }
    if (all || key === "armor") { client.ps.stats.set(schema.armor, 200); if (!all) return; }
    const award = key === "excellent" ? PersistentIndex.PERS_EXCELLENT_COUNT : key === "impressive" ? PersistentIndex.PERS_IMPRESSIVE_COUNT
      : key === "gauntletaward" ? PersistentIndex.PERS_GAUNTLET_FRAG_COUNT : key === "defend" ? PersistentIndex.PERS_DEFEND_COUNT
      : key === "assist" ? PersistentIndex.PERS_ASSIST_COUNT : null;
    if (award !== null) { client.ps.persistant.set(award, client.ps.persistant.get(award) + 1); return; }
    if (all) return;
    const item = findItem(client.ps.product, name);
    if (item === null) return;
    const temporary = this.host.pool.spawn();
    temporary.s.origin = { ...entity.r.currentOrigin };
    temporary.classname = item.className;
    spawnItem(temporary, item, new SpawnVariables([]), () => gameAtoi(this.host.imports.getCvar(`disable_${item.className}`)) !== 0, this.host.items);
    finishSpawningItem(temporary, this.host.items);
    touchItem(temporary, entity, { fraction: 0, end: vec3(0, 0, 0), solidity: "clear", contact: { kind: "none" }, contents: 0, surfaceFlags: 0, entityNum: 0 }, this.host.items);
    if (temporary.inuse) this.host.pool.free(temporary);
  }

  private toggle(entity: GameEntity, command: "god" | "notarget" | "noclip"): void {
    if (!this.cheatsOk(entity)) return;
    const client = clientOf(entity);
    let enabled: boolean;
    if (command === "noclip") { client.noclip = !client.noclip; enabled = client.noclip; }
    else { const flag = command === "god" ? GameFlags.GODMODE : GameFlags.NOTARGET; entity.flags ^= flag; enabled = (entity.flags & flag) !== 0; }
    this.print(entity, `${command === "god" ? "godmode" : command} ${enabled ? "ON" : "OFF"}\n`);
  }

  private kill(entity: GameEntity): void {
    const client = clientOf(entity);
    if (client.sess.sessionTeam === Team.TEAM_SPECTATOR || entity.health <= 0) return;
    entity.flags &= ~GameFlags.GODMODE;
    entity.health = -999;
    client.ps.stats.set(statSchema(client.ps.product).health, -999);
    this.host.death.playerDie(entity, entity, entity, 100000, MOD_SUICIDE);
  }

  private levelShot(entity: GameEntity): void {
    if (!this.cheatsOk(entity)) return;
    if (this.host.settings.gameType !== GameType.GT_FFA) { this.print(entity, "Must be in g_gametype 0 for levelshot\n"); return; }
    this.host.match.beginIntermission();
    this.host.imports.sendServerCommand(entity.slot, "clientLevelShot");
  }

  private teamTask(entity: GameEntity, args: Arguments): void {
    if (args.length !== 2) return;
    const userinfo = bounded(this.host.imports.getUserinfo(entity.slot), MAX_STRING_CHARS);
    this.host.imports.setUserinfo(entity.slot, infoSetValueForKey(userinfo, "teamtask", gameFormat("%d", [gameAtoi(args.at(1))]), text => this.host.imports.print(text)));
    this.host.admission.userinfoChanged(entity.slot);
  }

  broadcastTeamChange(clientNum: number, oldTeam: Team | -1): void {
    const client = this.host.pool.clientAt(clientNum);
    const team = client.sess.sessionTeam;
    const announcement = team === Team.TEAM_RED ? "joined the red team." : team === Team.TEAM_BLUE ? "joined the blue team."
      : team === Team.TEAM_SPECTATOR && oldTeam !== Team.TEAM_SPECTATOR ? "joined the spectators." : team === Team.TEAM_FREE ? "joined the battle." : null;
    if (announcement !== null) this.host.imports.sendServerCommand(-1, gameFormat('cp "%s^7 %s\n"', [client.pers.netname, announcement]));
  }

  setTeam(entity: GameEntity, request: string): void {
    const client = clientOf(entity), key = lower(bounded(request, MAX_STRING_CHARS)), settings = this.host.settings, state = this.host.state;
    let team: Team, spectatorState = SpectatorState.NOT, spectatorClient = 0;
    if (key === "scoreboard" || key === "score") { team = Team.TEAM_SPECTATOR; spectatorState = SpectatorState.SCOREBOARD; }
    else if (key === "follow1" || key === "follow2") {
      team = Team.TEAM_SPECTATOR; spectatorState = SpectatorState.FOLLOW; spectatorClient = key === "follow1" ? -1 : -2;
    } else if (key === "spectator" || key === "s") { team = Team.TEAM_SPECTATOR; spectatorState = SpectatorState.FREE; }
    else if (settings.gameType >= GameType.GT_TEAM) {
      const counts = { clients: this.host.pool.clients, maxClients: this.host.pool.maxClients, teamScores: this.host.teamScores };
      team = key === "red" || key === "r" ? Team.TEAM_RED : key === "blue" || key === "b" ? Team.TEAM_BLUE : pickTeam(counts, entity.slot);
      if (settings.teamForceBalance) {
        const red = teamCount(counts, client.ps.clientNum, Team.TEAM_RED), blue = teamCount(counts, client.ps.clientNum, Team.TEAM_BLUE);
        if (team === Team.TEAM_RED && red - blue > 1) {
          this.host.imports.sendServerCommand(client.ps.clientNum, 'cp "Red team has too many players.\n"'); return;
        }
        if (team === Team.TEAM_BLUE && blue - red > 1) {
          this.host.imports.sendServerCommand(client.ps.clientNum, 'cp "Blue team has too many players.\n"'); return;
        }
      }
    } else team = Team.TEAM_FREE;
    if (settings.gameType === GameType.GT_TOURNAMENT && state.numNonSpectatorClients >= 2) team = Team.TEAM_SPECTATOR;
    else if (settings.maxGameClients > 0 && state.numNonSpectatorClients >= settings.maxGameClients) team = Team.TEAM_SPECTATOR;
    const oldTeam = client.sess.sessionTeam;
    if (team === oldTeam && team !== Team.TEAM_SPECTATOR) return;
    if (client.ps.stats.get(statSchema(client.ps.product).health) <= 0) this.host.spawn.copyToBodyQueue(entity);
    client.pers.teamState.state = TeamState.BEGIN;
    if (oldTeam !== Team.TEAM_SPECTATOR) {
      entity.flags &= ~GameFlags.GODMODE;
      entity.health = 0;
      client.ps.stats.set(statSchema(client.ps.product).health, 0);
      this.host.death.playerDie(entity, entity, entity, 100000, MOD_SUICIDE);
    }
    if (team === Team.TEAM_SPECTATOR) client.sess.spectatorTime = state.time;
    client.sess.sessionTeam = team;
    client.sess.spectatorState = spectatorState;
    client.sess.spectatorClient = spectatorClient;
    client.sess.teamLeader = false;
    if (team === Team.TEAM_RED || team === Team.TEAM_BLUE) {
      let leader: GameEntity | null = null;
      for (let slot = 0; slot < this.host.pool.maxClients; slot++) {
        const candidate = this.host.pool.clientAt(slot);
        if (candidate.pers.connected !== ConnectionState.DISCONNECTED && candidate.sess.sessionTeam === team && candidate.sess.teamLeader) { leader = this.host.pool.at(slot); break; }
      }
      if (leader === null || ((entity.r.svFlags & ServerEntityFlags.BOT) === 0 && (leader.r.svFlags & ServerEntityFlags.BOT) !== 0)) this.host.match.setLeader(team, entity.slot);
    }
    if (oldTeam === Team.TEAM_RED || oldTeam === Team.TEAM_BLUE) this.host.match.checkTeamLeader(oldTeam);
    this.broadcastTeamChange(entity.slot, oldTeam);
    this.host.admission.userinfoChanged(entity.slot);
    this.host.admission.begin(entity.slot);
  }

  stopFollowing(entity: GameEntity): void {
    const client = clientOf(entity);
    client.ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_SPECTATOR);
    client.sess.sessionTeam = Team.TEAM_SPECTATOR;
    client.sess.spectatorState = SpectatorState.FREE;
    client.ps.pmFlags &= ~MoveFlags.FOLLOW;
    entity.r.svFlags &= ~ServerEntityFlags.BOT;
    client.ps.clientNum = entity.slot;
  }

  private teamCommand(entity: GameEntity, args: Arguments): void {
    const client = clientOf(entity);
    if (args.length !== 2) {
      const team = client.sess.sessionTeam;
      this.print(entity, `${team === Team.TEAM_RED ? "Red" : team === Team.TEAM_BLUE ? "Blue" : team === Team.TEAM_FREE ? "Free" : "Spectator"} team\n`);
      return;
    }
    if (client.switchTeamTime > this.host.state.time) { this.print(entity, "May not switch teams more than once per 5 seconds.\n"); return; }
    if (this.host.settings.gameType === GameType.GT_TOURNAMENT && client.sess.sessionTeam === Team.TEAM_FREE) client.sess.losses = (client.sess.losses + 1) | 0;
    this.setTeam(entity, args.at(1));
    client.switchTeamTime = (this.host.state.time + 5000) | 0;
  }

  private follow(entity: GameEntity, args: Arguments): void {
    const client = clientOf(entity);
    if (args.length !== 2) { if (client.sess.spectatorState === SpectatorState.FOLLOW) this.stopFollowing(entity); return; }
    const target = this.clientNumberFromString(entity, args.at(1));
    if (target === null || target === entity.slot || this.host.pool.clientAt(target).sess.sessionTeam === Team.TEAM_SPECTATOR) return;
    if (this.host.settings.gameType === GameType.GT_TOURNAMENT && client.sess.sessionTeam === Team.TEAM_FREE) client.sess.losses = (client.sess.losses + 1) | 0;
    if (client.sess.sessionTeam !== Team.TEAM_SPECTATOR) this.setTeam(entity, "spectator");
    client.sess.spectatorState = SpectatorState.FOLLOW;
    client.sess.spectatorClient = target;
  }

  followCycle(entity: GameEntity, direction: 1 | -1): void {
    const client = clientOf(entity);
    if (this.host.settings.gameType === GameType.GT_TOURNAMENT && client.sess.sessionTeam === Team.TEAM_FREE) client.sess.losses = (client.sess.losses + 1) | 0;
    if (client.sess.spectatorState === SpectatorState.NOT) this.setTeam(entity, "spectator");
    const original = client.sess.spectatorClient;
    let slot = original;
    for (let visited = 0; visited < this.host.pool.maxClients; visited++) {
      slot += direction;
      if (slot >= this.host.pool.maxClients) slot = 0;
      if (slot < 0) slot = this.host.pool.maxClients - 1;
      const target = this.host.pool.clientAt(slot);
      if (target.pers.connected === ConnectionState.CONNECTED && target.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
        client.sess.spectatorClient = slot; client.sess.spectatorState = SpectatorState.FOLLOW; return;
      }
      if (slot === original) return;
    }
    throw new GameCommandError("Cmd_FollowCycle_f cannot terminate from an automatic-follow sentinel without an active player");
  }

  private sayTo(entity: GameEntity, target: GameEntity, mode: SayMode, color: number, name: string, text: string): void {
    if (!target.inuse || target.client === null || target.client.pers.connected !== ConnectionState.CONNECTED) return;
    if (mode === "team" && !onSameTeam(this.host.settings.gameType, entity, target)) return;
    if (this.host.settings.gameType === GameType.GT_TOURNAMENT && target.client.sess.sessionTeam === Team.TEAM_FREE && clientOf(entity).sess.sessionTeam !== Team.TEAM_FREE) return;
    this.host.imports.sendServerCommand(target.slot, gameFormat('%s "%s%c%c%s"', [mode === "team" ? "tchat" : "chat", name, 94, color, text]));
  }

  say(entity: GameEntity, target: GameEntity | null, mode: SayMode, chatText: string): void {
    const client = clientOf(entity), gameType = this.host.settings.gameType;
    if (gameType < GameType.GT_TEAM && mode === "team") mode = "all";
    let name: string, color: number;
    if (mode === "all") {
      this.host.imports.log(gameFormat("say: %s: %s\n", [client.pers.netname, chatText]));
      name = gameFormat("%s^7\x19: ", [client.pers.netname], 64); color = 50;
    } else if (mode === "team") {
      this.host.imports.log(gameFormat("sayteam: %s: %s\n", [client.pers.netname, chatText]));
      const location = this.host.team.getLocationMessage(entity, 64);
      name = location === null ? gameFormat("\x19(%s^7\x19)\x19: ", [client.pers.netname], 64)
        : gameFormat("\x19(%s^7\x19) (%s)\x19: ", [client.pers.netname, location], 64);
      color = 53;
    } else {
      const location = target !== null && gameType >= GameType.GT_TEAM && clientOf(target).sess.sessionTeam === client.sess.sessionTeam
        ? this.host.team.getLocationMessage(entity, 64) : null;
      name = location === null ? gameFormat("\x19[%s^7\x19]\x19: ", [client.pers.netname], 64)
        : gameFormat("\x19[%s^7\x19] (%s)\x19: ", [client.pers.netname, location], 64);
      color = 54;
    }
    const text = bounded(chatText, MAX_SAY_TEXT);
    if (target !== null) { this.sayTo(entity, target, mode, color, name, text); return; }
    if (this.host.settings.dedicated) this.host.imports.print(gameFormat("%s%s\n", [name, text]));
    for (let slot = 0; slot < this.host.pool.maxClients; slot++) this.sayTo(entity, this.host.pool.at(slot), mode, color, name, text);
  }

  private sayCommand(entity: GameEntity, args: Arguments, mode: SayMode, arg0: boolean): void {
    if (args.length < 2 && !arg0) return;
    this.say(entity, null, mode, args.concat(arg0 ? 0 : 1));
  }

  private tell(entity: GameEntity, args: Arguments): void {
    if (args.length < 2) return;
    const slot = gameAtoi(args.at(1));
    if (slot < 0 || slot >= this.host.pool.maxClients) return;
    const target = this.host.pool.at(slot);
    if (!target.inuse || target.client === null) return;
    const text = args.concat(2);
    this.host.imports.log(gameFormat("tell: %s to %s: %s\n", [clientOf(entity).pers.netname, target.client.pers.netname, text]));
    this.say(entity, target, "tell", text);
    if (entity !== target && (entity.r.svFlags & ServerEntityFlags.BOT) === 0) this.say(entity, entity, "tell", text);
  }

  private voiceTo(entity: GameEntity, target: GameEntity, mode: SayMode, id: string, voiceOnly: boolean): void {
    if (!target.inuse || target.client === null) return;
    if (mode === "team" && !onSameTeam(this.host.settings.gameType, entity, target)) return;
    if (this.host.settings.gameType === GameType.GT_TOURNAMENT) return;
    const color = mode === "team" ? 53 : mode === "tell" ? 54 : 50;
    const command = mode === "team" ? "vtchat" : mode === "tell" ? "vtell" : "vchat";
    this.host.imports.sendServerCommand(target.slot, gameFormat("%s %d %d %d %s", [command, voiceOnly ? 1 : 0, entity.s.number, color, id]));
  }

  voice(entity: GameEntity, target: GameEntity | null, mode: SayMode, id: string, voiceOnly: boolean): void {
    if (this.host.settings.gameType < GameType.GT_TEAM && mode === "team") mode = "all";
    if (target !== null) { this.voiceTo(entity, target, mode, id, voiceOnly); return; }
    if (this.host.settings.dedicated) this.host.imports.print(gameFormat("voice: %s %s\n", [clientOf(entity).pers.netname, id]));
    for (let slot = 0; slot < this.host.pool.maxClients; slot++) this.voiceTo(entity, this.host.pool.at(slot), mode, id, voiceOnly);
  }

  private voiceCommand(entity: GameEntity, args: Arguments, mode: SayMode, voiceOnly: boolean): void {
    if (args.length < 2) return;
    this.voice(entity, null, mode, args.concat(1), voiceOnly);
  }

  private voiceTell(entity: GameEntity, args: Arguments, voiceOnly: boolean): void {
    if (args.length < 2) return;
    const slot = gameAtoi(args.at(1));
    if (slot < 0 || slot >= this.host.pool.maxClients) return;
    const target = this.host.pool.at(slot);
    if (!target.inuse || target.client === null) return;
    const id = args.concat(2);
    this.host.imports.log(gameFormat("vtell: %s to %s: %s\n", [clientOf(entity).pers.netname, target.client.pers.netname, id]));
    this.voice(entity, target, "tell", id, voiceOnly);
    if (entity !== target && (entity.r.svFlags & ServerEntityFlags.BOT) === 0) this.voice(entity, entity, "tell", id, voiceOnly);
  }

  private voiceTaunt(entity: GameEntity): void {
    const client = clientOf(entity);
    const pair = (target: GameEntity, id: string): void => {
      if ((target.r.svFlags & ServerEntityFlags.BOT) === 0) this.voice(entity, target, "tell", id, false);
      if ((entity.r.svFlags & ServerEntityFlags.BOT) === 0) this.voice(entity, entity, "tell", id, false);
    };
    if (entity.enemy?.client !== null && entity.enemy !== null && entity.enemy.client.lastKilledClient === entity.s.number) {
      pair(entity.enemy, "death_insult"); entity.enemy = null; return;
    }
    if (client.lastKilledClient >= 0 && client.lastKilledClient !== entity.s.number) {
      const target = this.host.pool.at(client.lastKilledClient);
      if (target.client !== null) {
        pair(target, target.client.lastHurtMod === MOD_GAUNTLET ? "kill_gauntlet" : "kill_insult");
        client.lastKilledClient = -1; return;
      }
    }
    if (this.host.settings.gameType >= GameType.GT_TEAM) {
      for (let slot = 0; slot < MAX_CLIENTS; slot++) {
        const target = this.host.pool.at(slot);
        if (target.client !== null && target !== entity && target.client.sess.sessionTeam === client.sess.sessionTeam && target.client.rewardTime > this.host.state.time) {
          pair(target, "praise"); return;
        }
      }
    }
    this.voice(entity, null, "all", "taunt", false);
  }

  private gameCommand(entity: GameEntity, args: Arguments): void {
    const slot = gameAtoi(args.at(1)), order = gameAtoi(args.at(2));
    if (slot < 0 || slot >= MAX_CLIENTS || order < 0 || order > orders.length) return;
    const text = orders[order];
    if (text === undefined) throw new GameCommandError("Cmd_GameCommand_f order 7 reads beyond the source order table");
    this.say(entity, this.host.pool.at(slot), "tell", text);
    this.say(entity, entity, "tell", text);
  }

  private callVote(entity: GameEntity, args: Arguments): void {
    const client = clientOf(entity), state = this.host.state, vote = state.vote;
    if (!this.host.settings.allowVote) { this.print(entity, "Voting not allowed here.\n"); return; }
    if (vote.time !== 0) { this.print(entity, "A vote is already in progress.\n"); return; }
    if (client.pers.voteCount >= MAX_VOTE_COUNT) { this.print(entity, "You have called the maximum number of votes.\n"); return; }
    if (client.sess.sessionTeam === Team.TEAM_SPECTATOR) { this.print(entity, "Not allowed to call a vote as spectator.\n"); return; }
    const command = args.at(1), parameter = args.at(2), key = lower(command);
    if (command.includes(";") || parameter.includes(";")) { this.print(entity, "Invalid vote string.\n"); return; }
    if (!["map_restart", "nextmap", "map", "g_gametype", "kick", "clientkick", "g_dowarmup", "timelimit", "fraglimit"].includes(key)) {
      this.print(entity, "Invalid vote string.\n");
      this.print(entity, "Vote commands are: map_restart, nextmap, map <mapname>, g_gametype <n>, kick <player>, clientkick <clientnum>, g_doWarmup, timelimit <time>, fraglimit <frags>.\n");
      return;
    }
    if (vote.executeTime !== 0) {
      vote.executeTime = 0;
      this.host.imports.appendConsoleCommand(gameFormat("%s\n", [vote.string]));
    }
    if (key === "g_gametype") {
      const type = gameAtoi(parameter);
      if (type === GameType.GT_SINGLE_PLAYER || type < GameType.GT_FFA || type >= GameType.GT_MAX_GAME_TYPE) {
        this.print(entity, "Invalid gametype.\n"); return;
      }
      const name = gameNames[type];
      if (name === undefined) throw new GameCommandError("Vote gametype has no source display name");
      vote.string = gameFormat("%s %d", [command, type], MAX_STRING_CHARS);
      vote.displayString = gameFormat("%s %s", [command, name], MAX_STRING_CHARS);
    } else if (key === "map") {
      const nextmap = bounded(this.host.imports.getCvar("nextmap"), MAX_STRING_CHARS);
      vote.string = nextmap.length > 0 ? gameFormat('%s %s; set nextmap "%s"', [command, parameter, nextmap], MAX_STRING_CHARS)
        : gameFormat("%s %s", [command, parameter], MAX_STRING_CHARS);
      vote.displayString = vote.string;
    } else if (key === "nextmap") {
      if (bounded(this.host.imports.getCvar("nextmap"), MAX_STRING_CHARS).length === 0) { this.print(entity, "nextmap not set.\n"); return; }
      vote.string = "vstr nextmap"; vote.displayString = vote.string;
    } else {
      vote.string = gameFormat('%s "%s"', [command, parameter], MAX_STRING_CHARS);
      vote.displayString = vote.string;
    }
    this.host.imports.sendServerCommand(-1, gameFormat('print "%s called a vote.\n"', [client.pers.netname]));
    vote.time = state.time; vote.yes = 1; vote.no = 0;
    for (let slot = 0; slot < this.host.pool.maxClients; slot++) this.host.pool.clientAt(slot).ps.eFlags &= ~EF_VOTED;
    client.ps.eFlags |= EF_VOTED;
    this.host.imports.setConfigstring(8, gameFormat("%i", [vote.time]));
    this.host.imports.setConfigstring(9, vote.displayString);
    this.host.imports.setConfigstring(10, gameFormat("%i", [vote.yes]));
    this.host.imports.setConfigstring(11, gameFormat("%i", [vote.no]));
  }

  private vote(entity: GameEntity, args: Arguments): void {
    const client = clientOf(entity), vote = this.host.state.vote;
    if (vote.time === 0) { this.print(entity, "No vote in progress.\n"); return; }
    if ((client.ps.eFlags & EF_VOTED) !== 0) { this.print(entity, "Vote already cast.\n"); return; }
    if (client.sess.sessionTeam === Team.TEAM_SPECTATOR) { this.print(entity, "Not allowed to vote as spectator.\n"); return; }
    this.print(entity, "Vote cast.\n");
    client.ps.eFlags |= EF_VOTED;
    const text = args.at(1, 64);
    // Both g_cmds vote handlers test uppercase Y and digit 1 at index one.
    if (text.charAt(0) === "y" || text.charAt(1) === "Y" || text.charAt(1) === "1") {
      vote.yes = (vote.yes + 1) | 0;
      this.host.imports.setConfigstring(10, gameFormat("%i", [vote.yes]));
    } else {
      vote.no = (vote.no + 1) | 0;
      this.host.imports.setConfigstring(11, gameFormat("%i", [vote.no]));
    }
  }

  private callTeamVote(entity: GameEntity, args: Arguments): void {
    const client = clientOf(entity), team = client.sess.sessionTeam;
    const offset = team === Team.TEAM_RED ? 0 : team === Team.TEAM_BLUE ? 1 : null;
    if (offset === null) return;
    const vote = this.host.state.teamVotes[offset];
    if (!this.host.settings.allowVote) { this.print(entity, "Voting not allowed here.\n"); return; }
    if (vote.time !== 0) { this.print(entity, "A team vote is already in progress.\n"); return; }
    if (client.pers.teamVoteCount >= MAX_VOTE_COUNT) { this.print(entity, "You have called the maximum number of team votes.\n"); return; }
    const command = args.at(1);
    let parameter = "";
    for (let index = 2; index < args.length; index++) {
      if (index > 2) parameter += " ";
      if (parameter.length >= MAX_STRING_CHARS) throw new GameCommandError("Team vote arguments overflow the source string buffer");
      parameter += args.at(index, MAX_STRING_CHARS - parameter.length);
    }
    if (command.includes(";") || parameter.includes(";")) { this.print(entity, "Invalid vote string.\n"); return; }
    if (lower(command) !== "leader") {
      this.print(entity, "Invalid vote string.\n"); this.print(entity, "Team vote commands are: leader <player>.\n"); return;
    }
    let target = client.ps.clientNum;
    if (parameter.length > 0) {
      let digits = 0;
      while (digits < 3 && parameter.charAt(digits) >= "0" && parameter.charAt(digits) <= "9") digits++;
      if (digits >= 3 || parameter.charAt(digits) === "") {
        target = gameAtoi(parameter);
        if (target < 0 || target >= this.host.pool.maxClients) { this.print(entity, gameFormat("Bad client slot: %i\n", [target])); return; }
        if (!this.host.pool.at(target).inuse) { this.print(entity, gameFormat("Client %i is not active\n", [target])); return; }
      } else {
        const name = cleanName(parameter);
        for (target = 0; target < this.host.pool.maxClients; target++) {
          const candidate = this.host.pool.clientAt(target);
          if (candidate.pers.connected !== ConnectionState.DISCONNECTED && candidate.sess.sessionTeam === team && cleanName(candidate.pers.netname) === name) break;
        }
        if (target >= this.host.pool.maxClients) { this.print(entity, gameFormat("%s is not a valid player on your team.\n", [parameter])); return; }
      }
    }
    vote.string = gameFormat("%s %d", [command, target], MAX_STRING_CHARS);
    for (let slot = 0; slot < this.host.pool.maxClients; slot++) {
      const candidate = this.host.pool.clientAt(slot);
      if (candidate.pers.connected !== ConnectionState.DISCONNECTED && candidate.sess.sessionTeam === team) {
        this.host.imports.sendServerCommand(slot, gameFormat('print "%s called a team vote.\n"', [client.pers.netname]));
      }
    }
    vote.time = this.host.state.time; vote.yes = 1; vote.no = 0;
    for (let slot = 0; slot < this.host.pool.maxClients; slot++) {
      const candidate = this.host.pool.clientAt(slot);
      if (candidate.sess.sessionTeam === team) candidate.ps.eFlags &= ~EF_TEAMVOTED;
    }
    client.ps.eFlags |= EF_TEAMVOTED;
    this.host.imports.setConfigstring(12 + offset, gameFormat("%i", [vote.time]));
    this.host.imports.setConfigstring(14 + offset, vote.string);
    this.host.imports.setConfigstring(16 + offset, gameFormat("%i", [vote.yes]));
    this.host.imports.setConfigstring(18 + offset, gameFormat("%i", [vote.no]));
  }

  private teamVote(entity: GameEntity, args: Arguments): void {
    const client = clientOf(entity), team = client.sess.sessionTeam;
    const offset = team === Team.TEAM_RED ? 0 : team === Team.TEAM_BLUE ? 1 : null;
    if (offset === null) return;
    const vote = this.host.state.teamVotes[offset];
    if (vote.time === 0) { this.print(entity, "No team vote in progress.\n"); return; }
    if ((client.ps.eFlags & EF_TEAMVOTED) !== 0) { this.print(entity, "Team vote already cast.\n"); return; }
    this.print(entity, "Team vote cast.\n");
    client.ps.eFlags |= EF_TEAMVOTED;
    const text = args.at(1, 64);
    if (text.charAt(0) === "y" || text.charAt(1) === "Y" || text.charAt(1) === "1") {
      vote.yes = (vote.yes + 1) | 0;
      this.host.imports.setConfigstring(16 + offset, gameFormat("%i", [vote.yes]));
    } else {
      vote.no = (vote.no + 1) | 0;
      this.host.imports.setConfigstring(18 + offset, gameFormat("%i", [vote.no]));
    }
  }

  private setViewPosition(entity: GameEntity, args: Arguments): void {
    if (!this.host.settings.cheats) { this.print(entity, "Cheats are not enabled on this server.\n"); return; }
    if (args.length !== 5) { this.print(entity, "usage: setviewpos x y z yaw\n"); return; }
    teleportPlayer(this.host.teleport, entity, vec3(gameAtof(args.at(1)), gameAtof(args.at(2)), gameAtof(args.at(3))), vec3(0, gameAtof(args.at(4)), 0));
  }

  dispatch(clientNum: number, argv: readonly string[]): void {
    const entity = this.host.pool.at(clientNum);
    if (entity.client === null) return;
    const args = new Arguments(argv), command = args.at(0), key = lower(command);
    switch (key) {
      case "say": this.sayCommand(entity, args, "all", false); return;
      case "say_team": this.sayCommand(entity, args, "team", false); return;
      case "tell": this.tell(entity, args); return;
      case "vsay": this.voiceCommand(entity, args, "all", false); return;
      case "vsay_team": this.voiceCommand(entity, args, "team", false); return;
      case "vtell": this.voiceTell(entity, args, false); return;
      case "vosay": this.voiceCommand(entity, args, "all", true); return;
      case "vosay_team": this.voiceCommand(entity, args, "team", true); return;
      case "votell": this.voiceTell(entity, args, true); return;
      case "vtaunt": this.voiceTaunt(entity); return;
      case "score": this.scoreboard(entity); return;
    }
    if (this.host.state.intermissionTime !== 0) { this.sayCommand(entity, args, "all", true); return; }
    switch (key) {
      case "give": this.give(entity, args); return;
      case "god": case "notarget": case "noclip": this.toggle(entity, key); return;
      case "kill": this.kill(entity); return;
      case "teamtask": this.teamTask(entity, args); return;
      case "levelshot": this.levelShot(entity); return;
      case "follow": this.follow(entity, args); return;
      case "follownext": this.followCycle(entity, 1); return;
      case "followprev": this.followCycle(entity, -1); return;
      case "team": this.teamCommand(entity, args); return;
      case "where": this.print(entity, gameFormat("%s\n", [this.host.pool.utilities.vtos(entity.s.origin).readString()])); return;
      case "callvote": this.callVote(entity, args); return;
      case "vote": this.vote(entity, args); return;
      case "callteamvote": this.callTeamVote(entity, args); return;
      case "teamvote": this.teamVote(entity, args); return;
      case "gc": this.gameCommand(entity, args); return;
      case "setviewpos": this.setViewPosition(entity, args); return;
      case "stats": return; // Cmd_Stats_f is an empty source body.
      default: this.print(entity, gameFormat("unknown cmd %s\n", [command]));
    }
  }
}
