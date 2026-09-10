/*
 * Ported from id Software's code/game/g_client.c ClientCleanName,
 * ClientUserinfoChanged, ClientConnect, ClientBegin and ClientDisconnect.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */

import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, GameType, PersistentIndex, Powerup, Team, statSchema } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { PlayerState, PlayerStateSlots, UserCommand } from "../shared/player-state.ts";
import type { ClientSpawnRuntime } from "./client-spawn.ts";
import type { DeathRuntime } from "./death.ts";
import { initGameEntity } from "./entities.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import type { MatchRuntime, MatchState } from "./match.ts";
import { gameAtoi } from "./numeric.ts";
import { pickTeam } from "./session.ts";
import type { GameSessionManager, SessionUserinfo } from "./session.ts";
import { ClientPersistant, ClientSession, ConnectionState, GameClient, PlayerTeamState, SpectatorState, TeamState } from "./state.ts";
import type { GameEntity } from "./state.ts";

const MAX_INFO_STRING = 1024;
const MAX_QPATH = 64;
const MAX_NETNAME = 36;
const CS_PLAYERS = 544;

export interface ClientAdmissionSettings {
  readonly gameType: number;
  readonly password: string;
}

export interface ClientAdmissionCommands {
  broadcastTeamChange(clientNum: number, oldTeam: Team | -1): void;
  stopFollowing(entity: GameEntity): void;
}

export type ClientBotServices =
  | { readonly kind: "available";
    removeQueuedBegin(clientNum: number): void;
    connect(clientNum: number, restart: boolean): boolean;
    shutdownClient(clientNum: number, restart: boolean): void;
  }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ClientAdmissionHost {
  readonly product: Product;
  readonly pool: EntityPool;
  readonly teamScores: PlayerStateSlots;
  readonly world: Pick<ServerWorld, "linkState" | "unlink">;
  readonly state: MatchState & { readonly newSession: boolean };
  readonly session: Pick<GameSessionManager, "initializeClient" | "readClient">;
  readonly spawn: Pick<ClientSpawnRuntime, "clientSpawn">;
  readonly death: Pick<DeathRuntime, "tossClientItems" | "tossClientPersistantPowerups" | "tossClientCubes">;
  readonly match: Pick<MatchRuntime, "calculateRanks">;
  readonly commands: ClientAdmissionCommands;
  readonly bots: ClientBotServices;
  settings(): ClientAdmissionSettings;
  getUserinfo(clientNum: number): string;
  setConfigstring(index: number, value: string): void;
  sendServerCommand(clientNum: number, value: string): void;
  log(value: string): void;
  filterPacket(address: string): boolean;
}

export class ClientCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientCapabilityError";
  }
}

function byteBuffer(value: string, capacity: number, label: string): string {
  const nul = value.indexOf("\0");
  const visible = nul < 0 ? value : value.slice(0, nul);
  const bounded = visible.slice(0, capacity - 1);
  for (let index = 0; index < bounded.length; index++) {
    if (bounded.charCodeAt(index) > 255) throw new RangeError(`${label} requires byte characters`);
  }
  return bounded;
}

function asciiUpper(byte: number): number {
  return byte >= 97 && byte <= 122 ? byte - 32 : byte;
}

function caseInsensitiveEqual(first: string, second: string): boolean {
  let index = 0;
  while (true) {
    const left = index < first.length ? first.charCodeAt(index) : 0;
    const right = index < second.length ? second.charCodeAt(index) : 0;
    const difference = asciiUpper(left) - asciiUpper(right);
    if (difference !== 0) return false;
    if (left === 0) return true;
    index++;
  }
}

/** Source Info_ValueForKey: first matching key, ASCII case-insensitive. */
function valueForKey(info: string, wanted: string): string {
  let cursor = info.startsWith("\\") ? 1 : 0;
  while (true) {
    const keyStart = cursor;
    while (cursor < info.length && info.charCodeAt(cursor) !== 92) cursor++;
    if (cursor === info.length) return "";
    const key = info.slice(keyStart, cursor);
    cursor++;
    const valueStart = cursor;
    while (cursor < info.length && info.charCodeAt(cursor) !== 92) cursor++;
    const value = info.slice(valueStart, cursor);
    if (caseInsensitiveEqual(wanted, key)) return value;
    if (cursor === info.length) return "";
    cursor++;
  }
}

/** Client-sized Info_ValueForKey boundary for engine-owned raw userinfo bytes. */
export function clientInfoValue(info: string, wanted: string): string {
  return valueForKey(byteBuffer(info, MAX_INFO_STRING, "userinfo"), byteBuffer(wanted, MAX_INFO_STRING, "userinfo key"));
}

function validInfo(info: string): boolean {
  return !info.includes('"') && !info.includes(";");
}

/** The 36-byte netname cleaner used by ClientUserinfoChanged. */
export function cleanClientName(input: string): string {
  const source = byteBuffer(input, MAX_INFO_STRING, "client name");
  const outputSize = MAX_NETNAME - 1;
  let output = "";
  let colorlessLength = 0;
  let spaces = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source.charCodeAt(cursor++);
    if (output.length === 0 && character === 32) continue;
    if (character === 94) {
      if (cursor === source.length) break;
      const color = source.charCodeAt(cursor);
      if (((color - 48) & 7) === 0) { cursor++; continue; }
      if (output.length > outputSize - 2) break;
      output += `^${String.fromCharCode(color)}`;
      cursor++;
      continue;
    }
    if (character === 32) {
      spaces++;
      if (spaces > 3) continue;
    } else spaces = 0;
    if (output.length > outputSize - 1) break;
    output += String.fromCharCode(character);
    colorlessLength++;
  }
  return output.length === 0 || colorlessLength === 0 ? "UnnamedPlayer" : output;
}

function clearSlots(slots: PlayerStateSlots): void {
  for (let index = 0; index < slots.length; index++) slots.set(index, 0);
}

function resetCommand(command: UserCommand): void {
  command.serverTime = 0;
  command.angles = { x: 0, y: 0, z: 0 };
  command.buttons = 0;
  command.weapon = 0;
  command.forwardmove = 0;
  command.rightmove = 0;
  command.upmove = 0;
}

/** Memset a playerState_t while retaining the TypeScript owners of its fixed arrays and vectors. */
function resetPlayerState(state: PlayerState): void {
  const fresh = new GameClient(state.product).ps;
  const origin = state.origin, velocity = state.velocity, deltaAngles = state.deltaAngles;
  const grapplePoint = state.grapplePoint, viewangles = state.viewangles;
  const events = state.events, eventParms = state.eventParms, stats = state.stats;
  const persistant = state.persistant, powerups = state.powerups, ammo = state.ammo;
  Object.assign(state, fresh, { origin, velocity, deltaAngles, grapplePoint, viewangles,
    events, eventParms, stats, persistant, powerups, ammo });
  Object.assign(origin, fresh.origin);
  Object.assign(velocity, fresh.velocity);
  Object.assign(deltaAngles, fresh.deltaAngles);
  Object.assign(grapplePoint, fresh.grapplePoint);
  Object.assign(viewangles, fresh.viewangles);
  clearSlots(events);
  clearSlots(eventParms);
  clearSlots(stats);
  clearSlots(persistant);
  clearSlots(powerups);
  clearSlots(ammo);
}

/** ClientConnect's gclient_t memset, preserving the pool's stable object graph. */
function resetClient(client: GameClient, product: Product): void {
  const fresh = new GameClient(product);
  const ps = client.ps, pers = client.pers, sess = client.sess, ammoTimes = client.ammoTimes;
  const oldOrigin = client.oldOrigin, damageFrom = client.damageFrom;
  const command = pers.cmd, commandAngles = command.angles, teamState = pers.teamState;
  Object.assign(client, fresh, { ps, pers, sess, ammoTimes, oldOrigin, damageFrom });
  resetPlayerState(ps);
  Object.assign(pers, new ClientPersistant(), { cmd: command, teamState });
  resetCommand(command);
  command.angles = commandAngles;
  Object.assign(commandAngles, { x: 0, y: 0, z: 0 });
  Object.assign(teamState, new PlayerTeamState());
  Object.assign(sess, new ClientSession());
  clearSlots(ammoTimes);
  Object.assign(oldOrigin, fresh.oldOrigin);
  Object.assign(damageFrom, fresh.damageFrom);
}

export class ClientAdmissionRuntime {
  constructor(readonly host: ClientAdmissionHost) {
    if (host.pool.options.product !== host.product) throw new Error("Client admission product differs from its entity pool");
    if (host.teamScores.length !== Team.TEAM_NUM_TEAMS) throw new RangeError("Client admission requires four shared team-score slots");
  }

  private clientEntity(clientNum: number): GameEntity {
    if (!Number.isInteger(clientNum) || clientNum < 0 || clientNum >= this.host.pool.maxClients) {
      throw new RangeError(`client ${clientNum} outside configured clients`);
    }
    return this.host.pool.at(clientNum);
  }

  private userinfo(clientNum: number): string {
    return byteBuffer(this.host.getUserinfo(clientNum), MAX_INFO_STRING, "userinfo");
  }

  userinfoChanged(clientNum: number): void {
    const entity = this.clientEntity(clientNum), client = this.host.pool.clientAt(clientNum);
    let userinfo = this.userinfo(clientNum);
    if (!validInfo(userinfo)) userinfo = "\\name\\badinfo";

    if (clientInfoValue(userinfo, "ip") === "localhost") client.pers.localClient = true;
    client.pers.predictItemPickup = gameAtoi(clientInfoValue(userinfo, "cg_predictItems")) !== 0;
    const oldName = byteBuffer(client.pers.netname, MAX_INFO_STRING, "client name");
    client.pers.netname = cleanClientName(clientInfoValue(userinfo, "name"));
    if (client.sess.sessionTeam === Team.TEAM_SPECTATOR && client.sess.spectatorState === SpectatorState.SCOREBOARD) {
      client.pers.netname = "scoreboard";
    }
    if (client.pers.connected === ConnectionState.CONNECTED && oldName !== client.pers.netname) {
      this.host.sendServerCommand(-1, gameFormat('print "%s^7 renamed to %s\n"', [oldName, client.pers.netname]));
    }

    let health = gameAtoi(clientInfoValue(userinfo, "handicap"));
    if (this.host.product === "missionpack" && client.ps.powerups.get(Powerup.PW_GUARD) !== 0) health = 200;
    else if (health < 1 || health > 100) health = 100;
    client.pers.maxHealth = health;
    client.ps.stats.set(statSchema(this.host.product).maxHealth, health);

    const settings = this.host.settings(), gameType = settings.gameType;
    const model = byteBuffer(clientInfoValue(userinfo, gameType >= GameType.GT_TEAM ? "team_model" : "model"), MAX_QPATH, "model");
    const headModel = byteBuffer(clientInfoValue(userinfo, gameType >= GameType.GT_TEAM ? "team_headmodel" : "headmodel"), MAX_QPATH, "head model");
    let team = client.sess.sessionTeam;
    if (gameType >= GameType.GT_TEAM && (entity.r.svFlags & ServerEntityFlags.BOT) !== 0) {
      const requested = clientInfoValue(userinfo, "team");
      if (caseInsensitiveEqual(requested, "red") || caseInsensitiveEqual(requested, "r")) team = Team.TEAM_RED;
      else if (caseInsensitiveEqual(requested, "blue") || caseInsensitiveEqual(requested, "b")) team = Team.TEAM_BLUE;
      else team = pickTeam({ clients: this.host.pool.clients, maxClients: this.host.pool.maxClients,
        teamScores: this.host.teamScores }, clientNum);
    }

    if (this.host.product === "missionpack" && gameType >= GameType.GT_TEAM) client.pers.teamInfo = true;
    else {
      const overlay = clientInfoValue(userinfo, "teamoverlay");
      client.pers.teamInfo = overlay.length === 0 || gameAtoi(overlay) !== 0;
    }
    const teamTask = gameAtoi(clientInfoValue(userinfo, "teamtask"));
    const teamLeader = client.sess.teamLeader;
    const color1 = clientInfoValue(userinfo, "color1"), color2 = clientInfoValue(userinfo, "color2");
    let config: string;
    if ((entity.r.svFlags & ServerEntityFlags.BOT) !== 0) {
      config = gameFormat("n\\%s\\t\\%i\\model\\%s\\hmodel\\%s\\c1\\%s\\c2\\%s\\hc\\%i\\w\\%i\\l\\%i\\skill\\%s\\tt\\%d\\tl\\%d",
        [client.pers.netname, team, model, headModel, color1, color2, client.pers.maxHealth,
          client.sess.wins, client.sess.losses, clientInfoValue(userinfo, "skill"), teamTask, teamLeader]);
    } else {
      config = gameFormat("n\\%s\\t\\%i\\model\\%s\\hmodel\\%s\\g_redteam\\%s\\g_blueteam\\%s\\c1\\%s\\c2\\%s\\hc\\%i\\w\\%i\\l\\%i\\tt\\%d\\tl\\%d",
        [client.pers.netname, client.sess.sessionTeam, model, headModel, clientInfoValue(userinfo, "g_redteam"),
          clientInfoValue(userinfo, "g_blueteam"), color1, color2, client.pers.maxHealth,
          client.sess.wins, client.sess.losses, teamTask, teamLeader]);
    }
    this.host.setConfigstring(CS_PLAYERS + clientNum, config);
    this.host.log(gameFormat("ClientUserinfoChanged: %i %s\n", [clientNum, config]));
  }

  connect(clientNum: number, firstTime: boolean, isBot: boolean): string | null {
    const entity = this.clientEntity(clientNum), userinfo = this.userinfo(clientNum);
    const address = clientInfoValue(userinfo, "ip");
    if (this.host.filterPacket(address)) return "You are banned from this server.";
    const password = byteBuffer(this.host.settings().password, MAX_INFO_STRING, "password");
    if ((entity.r.svFlags & ServerEntityFlags.BOT) === 0 && address !== "localhost" && password.length !== 0 &&
      !caseInsensitiveEqual(password, "none") && password !== clientInfoValue(userinfo, "password")) return "Invalid password";

    const client = this.host.pool.clientAt(clientNum);
    entity.client = client;
    resetClient(client, this.host.product);
    client.pers.connected = ConnectionState.CONNECTING;
    const sessionInfo: SessionUserinfo = { valueForKey: () => clientInfoValue(userinfo, "team") };
    if (firstTime || this.host.state.newSession) this.host.session.initializeClient(clientNum, sessionInfo);
    this.host.session.readClient(clientNum);
    if (isBot) {
      entity.r.svFlags |= ServerEntityFlags.BOT;
      entity.inuse = true;
      if (this.host.bots.kind === "unavailable") return this.host.bots.reason;
      if (!this.host.bots.connect(clientNum, !firstTime)) return "BotConnectfailed";
    }
    this.host.log(gameFormat("ClientConnect: %i\n", [clientNum]));
    this.userinfoChanged(clientNum);
    if (firstTime) this.host.sendServerCommand(-1, gameFormat('print "%s^7 connected\n"', [client.pers.netname]));
    const gameType = this.host.settings().gameType;
    if (gameType >= GameType.GT_TEAM && client.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
      this.host.commands.broadcastTeamChange(clientNum, -1);
    }
    this.host.match.calculateRanks();
    return null;
  }

  begin(clientNum: number): void {
    const entity = this.clientEntity(clientNum), client = this.host.pool.clientAt(clientNum);
    if (this.host.world.linkState(entity.slot)?.linked === true) this.host.world.unlink(entity.slot);
    initGameEntity(entity);
    entity.touch = null;
    entity.pain = null;
    entity.client = client;
    client.pers.connected = ConnectionState.CONNECTED;
    client.pers.enterTime = this.host.state.time;
    client.pers.teamState.state = TeamState.BEGIN;
    const flags = client.ps.eFlags;
    resetPlayerState(client.ps);
    client.ps.eFlags = flags;
    this.host.spawn.clientSpawn(entity);
    if (client.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
      const temporary = this.host.pool.tempEntity(client.ps.origin, EntityEvent.EV_PLAYER_TELEPORT_IN);
      temporary.s.clientNum = entity.s.clientNum;
      if (this.host.settings().gameType !== GameType.GT_TOURNAMENT) {
        this.host.sendServerCommand(-1, gameFormat('print "%s^7 entered the game\n"', [client.pers.netname]));
      }
    }
    this.host.log(gameFormat("ClientBegin: %i\n", [clientNum]));
    this.host.match.calculateRanks();
  }

  disconnect(clientNum: number): void {
    const entity = this.clientEntity(clientNum);
    if (this.host.bots.kind === "available") this.host.bots.removeQueuedBegin(clientNum);
    else if ((entity.r.svFlags & ServerEntityFlags.BOT) !== 0) throw new ClientCapabilityError(this.host.bots.reason);
    if (entity.client === null) return;
    const client = entity.client;
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const follower = this.host.pool.clientAt(index);
      if (follower.sess.sessionTeam === Team.TEAM_SPECTATOR && follower.sess.spectatorState === SpectatorState.FOLLOW &&
        follower.sess.spectatorClient === clientNum) this.host.commands.stopFollowing(this.host.pool.at(index));
    }
    if (client.pers.connected === ConnectionState.CONNECTED && client.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
      const temporary = this.host.pool.tempEntity(client.ps.origin, EntityEvent.EV_PLAYER_TELEPORT_OUT);
      temporary.s.clientNum = entity.s.clientNum;
      this.host.death.tossClientItems(entity);
      if (this.host.product === "missionpack") {
        this.host.death.tossClientPersistantPowerups(entity);
        if (this.host.settings().gameType === GameType.GT_HARVESTER) this.host.death.tossClientCubes(entity);
      }
    }
    this.host.log(gameFormat("ClientDisconnect: %i\n", [clientNum]));
    const gameType = this.host.settings().gameType;
    if (gameType === GameType.GT_TOURNAMENT && this.host.state.intermissionTime === 0 && this.host.state.warmupTime === 0 &&
      this.host.state.sortedClients[1] === clientNum) {
      const winner = this.host.state.sortedClients[0];
      if (winner === undefined) throw new RangeError("tournament winner is absent from sorted clients");
      const winnerClient = this.host.pool.clientAt(winner);
      winnerClient.sess.wins = (winnerClient.sess.wins + 1) | 0;
      this.userinfoChanged(winner);
    }
    this.host.world.unlink(entity.slot);
    entity.s.modelindex = 0;
    entity.inuse = false;
    entity.classname = "disconnected";
    client.pers.connected = ConnectionState.DISCONNECTED;
    client.ps.persistant.set(PersistentIndex.PERS_TEAM, Team.TEAM_FREE);
    client.sess.sessionTeam = Team.TEAM_FREE;
    this.host.setConfigstring(CS_PLAYERS + clientNum, "");
    this.host.match.calculateRanks();
    if ((entity.r.svFlags & ServerEntityFlags.BOT) !== 0 && this.host.bots.kind === "available") {
      this.host.bots.shutdownClient(clientNum, false);
    }
  }
}
