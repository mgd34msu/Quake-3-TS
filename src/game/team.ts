// Ported from id Software's code/game/g_team.c and g_team.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { dot3, length3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, GameType, PersistentIndex, Powerup, Team, statSchema } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { ENTITYNUM_NONE } from "../shared/player-state.ts";
import type { PlayerStateSlots } from "../shared/player-state.ts";
import { setOrigin } from "./entities.ts";
import type { EntityPool } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { ConnectionState, GameFlags, MAX_CLIENTS } from "./state.ts";
import type { EntityDie, EntityPain, EntityThink, EntityTouch, GameClient, GameEntity } from "./state.ts";
import { findEntity } from "./utilities.ts";

export enum FlagStatus { AT_BASE = 0, TAKEN = 1, TAKEN_RED = 2, TAKEN_BLUE = 3, DROPPED = 4 }
export enum GlobalTeamSound {
  RED_CAPTURE = 0, BLUE_CAPTURE = 1, RED_RETURN = 2, BLUE_RETURN = 3, RED_TAKEN = 4, BLUE_TAKEN = 5,
  RED_OBELISK_ATTACKED = 6, BLUE_OBELISK_ATTACKED = 7, RED_SCORED = 8, BLUE_SCORED = 9,
  RED_TOOK_LEAD = 10, BLUE_TOOK_LEAD = 11, TIED = 12, KAMIKAZE = 13,
}

interface TeamServices {
  readonly pool: EntityPool;
  readonly world: ServerWorld;
  readonly gameType: number;
  readonly time: number;
  readonly teamScores: PlayerStateSlots;
  readonly sortedClients: readonly number[];
  readonly locationHead: GameEntity | null;
  sendServerCommand(clientNum: number, text: string): void;
  setConfigstring(index: number, text: string): void;
  warn(text: string): void;
  addScore(player: GameEntity, origin: Vec3, score: number): void;
  calculateRanks(): void;
  respawnItem(item: GameEntity): void;
  inPVS(first: Vec3, second: Vec3): boolean;
}

export interface ObeliskSettings {
  readonly health: number;
  readonly regenPeriodSeconds: number;
  readonly regenAmount: number;
  readonly respawnDelaySeconds: number;
}
export type TeamHost = TeamServices & ({ readonly product: "baseq3" } |
  { readonly product: "missionpack"; readonly obelisk: ObeliskSettings });

function sortClients(first: number, second: number): number {
  return first - second;
}

export class TeamGameState {
  lastFlagCapture = 0;
  lastCaptureTeam = 0;
  redStatus: FlagStatus | -1 = FlagStatus.AT_BASE;
  blueStatus: FlagStatus | -1 = FlagStatus.AT_BASE;
  flagStatus: FlagStatus | -1 = FlagStatus.AT_BASE;
  redTakenTime = 0;
  blueTakenTime = 0;
  redObeliskAttackedTime = 0;
  blueObeliskAttackedTime = 0;
}

export function otherTeam(team: Team): Team {
  return team === Team.TEAM_RED ? Team.TEAM_BLUE : team === Team.TEAM_BLUE ? Team.TEAM_RED : team;
}
export function teamName(team: Team): string {
  return team === Team.TEAM_RED ? "RED" : team === Team.TEAM_BLUE ? "BLUE" : team === Team.TEAM_SPECTATOR ? "SPECTATOR" : "FREE";
}
export function otherTeamName(team: Team): string { return teamName(otherTeam(team)); }
export function teamColorString(team: Team): string {
  return team === Team.TEAM_RED ? "^1" : team === Team.TEAM_BLUE ? "^4" : team === Team.TEAM_SPECTATOR ? "^3" : "^7";
}
export function onSameTeam(gameType: number, first: GameEntity, second: GameEntity): boolean {
  return first.client !== null && second.client !== null && gameType >= GameType.GT_TEAM &&
    first.client.sess.sessionTeam === second.client.sess.sessionTeam;
}

/** All four SP_team_CTF_{red,blue}{player,spawn} source bodies are empty.
 * The spawn selectors consume the entity's unchanged map fields later. */
export function spawnTeamPoint(_entity: GameEntity): void {}

const AWARDS = 0x8 | 0x40 | 0x800 | 0x8000 | 0x10000 | 0x20000;
function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Team player operation requires a client");
  return entity.client;
}
function flagTeam(entity: GameEntity): Team | null {
  if (entity.item === null) throw new Error("Team item operation requires an item");
  if (entity.item.tag === Powerup.PW_REDFLAG) return Team.TEAM_RED;
  if (entity.item.tag === Powerup.PW_BLUEFLAG) return Team.TEAM_BLUE;
  if (entity.item.tag === Powerup.PW_NEUTRALFLAG) return Team.TEAM_FREE;
  return null;
}
function ctfStatus(status: FlagStatus | -1): string {
  // Team_InitGame first reads ctfFlagStatusRemap[-1]. The baseline QVM
  // has a zero byte there; preserve its transient one-character publication.
  switch (status) {
    case -1: return "\0";
    case FlagStatus.AT_BASE: return "0";
    case FlagStatus.TAKEN: return "1";
    case FlagStatus.TAKEN_RED: case FlagStatus.TAKEN_BLUE: return "*";
    case FlagStatus.DROPPED: return "2";
  }
}

export class TeamRuntime {
  readonly state = new TeamGameState();
  neutralObelisk: GameEntity | null = null;
  lastTeamLocationTime = 0;

  constructor(readonly host: TeamHost) {
    if (host.teamScores.length !== 4) throw new RangeError("Team scores require four source team slots");
  }

  initGame(): void {
    Object.assign(this.state, new TeamGameState());
    if (this.host.gameType === GameType.GT_CTF) {
      this.state.redStatus = this.state.blueStatus = -1;
      this.setFlagStatus(Team.TEAM_RED, FlagStatus.AT_BASE);
      this.setFlagStatus(Team.TEAM_BLUE, FlagStatus.AT_BASE);
    } else if (this.host.product === "missionpack" && this.host.gameType === GameType.GT_1FCTF) {
      this.state.flagStatus = -1;
      this.setFlagStatus(Team.TEAM_FREE, FlagStatus.AT_BASE);
    }
  }

  printMessage(entity: GameEntity | null, text: string): void {
    const end = text.indexOf("\0");
    const message = (end < 0 ? text : text.slice(0, end)).replaceAll('"', "'");
    if (message.length > 1024) throw new Error("PrintMsg overrun");
    this.host.sendServerCommand(entity === null ? -1 : entity.slot, `print "${message}"`);
  }

  addTeamScore(origin: Vec3, team: Team, score: number): void {
    const event = this.host.pool.tempEntity(origin, EntityEvent.EV_GLOBAL_TEAM_SOUND);
    event.r.svFlags |= ServerEntityFlags.BROADCAST;
    const red = this.host.teamScores.get(Team.TEAM_RED), blue = this.host.teamScores.get(Team.TEAM_BLUE);
    if (team === Team.TEAM_RED) {
      event.s.eventParm = ((red + score) | 0) === blue ? GlobalTeamSound.TIED
        : red <= blue && ((red + score) | 0) > blue ? GlobalTeamSound.RED_TOOK_LEAD : GlobalTeamSound.RED_SCORED;
    } else {
      event.s.eventParm = ((blue + score) | 0) === red ? GlobalTeamSound.TIED
        : blue <= red && ((blue + score) | 0) > red ? GlobalTeamSound.BLUE_TOOK_LEAD : GlobalTeamSound.BLUE_SCORED;
    }
    this.host.teamScores.set(team, this.host.teamScores.get(team) + score);
  }

  setFlagStatus(team: Team, status: FlagStatus): void {
    const key = team === Team.TEAM_RED ? "redStatus" : team === Team.TEAM_BLUE ? "blueStatus" : team === Team.TEAM_FREE ? "flagStatus" : null;
    if (key === null || this.state[key] === status) return;
    this.state[key] = status;
    const value = this.host.gameType === GameType.GT_CTF ? ctfStatus(this.state.redStatus) + ctfStatus(this.state.blueStatus) : String(this.state.flagStatus);
    const nul = value.indexOf("\0");
    this.host.setConfigstring(23, nul < 0 ? value : value.slice(0, nul));
  }

  checkDroppedItem(entity: GameEntity): void {
    const team = flagTeam(entity);
    if (team !== null) this.setFlagStatus(team, FlagStatus.DROPPED);
  }

  forceGesture(team: Team): void {
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const entity = this.host.pool.at(index);
      if (entity.inuse && entity.client !== null && entity.client.sess.sessionTeam === team) entity.flags |= GameFlags.FORCE_GESTURE;
    }
  }

  private award(player: GameEntity, flag: number): void {
    const client = clientOf(player);
    client.ps.eFlags = (client.ps.eFlags & ~AWARDS) | flag;
    client.rewardTime = (this.host.time + 2000) | 0;
  }

  checkHurtCarrier(target: GameEntity, attacker: GameEntity): void {
    if (target.client === null || attacker.client === null) return;
    const flag = target.client.sess.sessionTeam === Team.TEAM_RED ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG;
    if ((target.client.ps.powerups.get(flag) !== 0 || target.client.ps.generic1 !== 0) &&
      target.client.sess.sessionTeam !== attacker.client.sess.sessionTeam) {
      attacker.client.pers.teamState.lastHurtCarrier = Math.fround(this.host.time);
    }
  }

  fragBonuses(target: GameEntity, _inflictor: GameEntity | null, attacker: GameEntity | null): void {
    if (target.client === null || attacker === null || attacker.client === null || target === attacker || onSameTeam(this.host.gameType, target, attacker)) return;
    const victim = target.client, killer = attacker.client, team = victim.sess.sessionTeam, opposing = otherTeam(team);
    const flag = team === Team.TEAM_RED ? Powerup.PW_REDFLAG : Powerup.PW_BLUEFLAG;
    const enemyFlag = this.host.gameType === GameType.GT_1FCTF ? Powerup.PW_NEUTRALFLAG : team === Team.TEAM_RED ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG;
    const tokens = this.host.product === "missionpack" && this.host.gameType === GameType.GT_HARVESTER ? victim.ps.generic1 : 0;
    const mission = this.host.product === "missionpack";
    if (victim.ps.powerups.get(enemyFlag) !== 0 || tokens !== 0) {
      const hasFlag = victim.ps.powerups.get(enemyFlag) !== 0;
      killer.pers.teamState.lastFraggedCarrier = Math.fround(this.host.time);
      this.host.addScore(attacker, target.r.currentOrigin, hasFlag ? mission ? 20 : 2 : Math.imul(Math.imul(mission ? 20 : 2, tokens), tokens));
      killer.pers.teamState.fragCarrier = (killer.pers.teamState.fragCarrier + 1) | 0;
      this.printMessage(null, `${killer.pers.netname}^7 fragged ${teamName(team)}'s ${hasFlag ? "flag" : "skull"} carrier!\n`);
      for (let index = 0; index < this.host.pool.maxClients; index++) {
        const entity = this.host.pool.at(index);
        if (entity.inuse && clientOf(entity).sess.sessionTeam === opposing) clientOf(entity).pers.teamState.lastHurtCarrier = 0;
      }
      return;
    }
    // The source's second danger-protect branch removes the first branch's
    // flag restriction without introducing a game-type or token check.
    if (victim.pers.teamState.lastHurtCarrier !== 0 && Math.fround(Math.fround(this.host.time) - victim.pers.teamState.lastHurtCarrier) < 8000) {
      this.host.addScore(attacker, target.r.currentOrigin, mission ? 5 : 2);
      killer.pers.teamState.carrierDefense = (killer.pers.teamState.carrierDefense + 1) | 0;
      victim.pers.teamState.lastHurtCarrier = 0;
      killer.ps.persistant.set(PersistentIndex.PERS_DEFEND_COUNT, killer.ps.persistant.get(PersistentIndex.PERS_DEFEND_COUNT) + 1);
      this.award(attacker, 0x10000);
      return;
    }
    let classname: string;
    let carrier: GameEntity | null = null;
    if (mission && this.host.gameType === GameType.GT_OBELISK) {
      if (killer.sess.sessionTeam !== Team.TEAM_RED && killer.sess.sessionTeam !== Team.TEAM_BLUE) return;
      classname = killer.sess.sessionTeam === Team.TEAM_RED ? "team_redobelisk" : "team_blueobelisk";
    } else if (mission && this.host.gameType === GameType.GT_HARVESTER) classname = "team_neutralobelisk";
    else {
      if (killer.sess.sessionTeam !== Team.TEAM_RED && killer.sess.sessionTeam !== Team.TEAM_BLUE) return;
      classname = killer.sess.sessionTeam === Team.TEAM_RED ? "team_CTF_redflag" : "team_CTF_blueflag";
      for (let index = 0; index < this.host.pool.maxClients; index++) {
        const entity = this.host.pool.at(index);
        if (entity.inuse && clientOf(entity).ps.powerups.get(flag) !== 0) { carrier = entity; break; }
      }
    }
    let base: GameEntity | null = null;
    while ((base = findEntity(this.host.pool, base, "classname", classname)) !== null) if ((base.flags & GameFlags.DROPPED_ITEM) === 0) break;
    if (base === null) return;
    const targetDistance = length3(sub3(target.r.currentOrigin, base.r.currentOrigin));
    const attackerDistance = length3(sub3(attacker.r.currentOrigin, base.r.currentOrigin));
    if (((targetDistance < 1000 && this.host.inPVS(base.r.currentOrigin, target.r.currentOrigin)) ||
      (attackerDistance < 1000 && this.host.inPVS(base.r.currentOrigin, attacker.r.currentOrigin))) && killer.sess.sessionTeam !== victim.sess.sessionTeam) {
      this.host.addScore(attacker, target.r.currentOrigin, mission ? 10 : 1);
      killer.pers.teamState.baseDefense = (killer.pers.teamState.baseDefense + 1) | 0;
      killer.ps.persistant.set(PersistentIndex.PERS_DEFEND_COUNT, killer.ps.persistant.get(PersistentIndex.PERS_DEFEND_COUNT) + 1);
      this.award(attacker, 0x10000);
      return;
    }
    if (carrier !== null && carrier !== attacker) {
      // Source writes v1 twice and leaves v2 measured from the base flag.
      const distance = length3(sub3(attacker.r.currentOrigin, carrier.r.currentOrigin));
      if (((distance < 1000 && this.host.inPVS(carrier.r.currentOrigin, target.r.currentOrigin)) ||
        (attackerDistance < 1000 && this.host.inPVS(carrier.r.currentOrigin, attacker.r.currentOrigin))) && killer.sess.sessionTeam !== victim.sess.sessionTeam) {
        this.host.addScore(attacker, target.r.currentOrigin, mission ? 2 : 1);
        killer.pers.teamState.carrierDefense = (killer.pers.teamState.carrierDefense + 1) | 0;
        killer.ps.persistant.set(PersistentIndex.PERS_DEFEND_COUNT, killer.ps.persistant.get(PersistentIndex.PERS_DEFEND_COUNT) + 1);
        this.award(attacker, 0x10000);
      }
    }
  }

  resetFlag(team: Team): GameEntity | null {
    const classname = team === Team.TEAM_RED ? "team_CTF_redflag" : team === Team.TEAM_BLUE ? "team_CTF_blueflag" : team === Team.TEAM_FREE ? "team_CTF_neutralflag" : null;
    if (classname === null) return null;
    let entity: GameEntity | null = null, base: GameEntity | null = null;
    while ((entity = findEntity(this.host.pool, entity, "classname", classname)) !== null) {
      if ((entity.flags & GameFlags.DROPPED_ITEM) !== 0) this.host.pool.free(entity);
      else { base = entity; this.host.respawnItem(entity); }
    }
    this.setFlagStatus(team, FlagStatus.AT_BASE);
    return base;
  }

  resetFlags(): void {
    if (this.host.gameType === GameType.GT_CTF) { this.resetFlag(Team.TEAM_RED); this.resetFlag(Team.TEAM_BLUE); }
    else if (this.host.product === "missionpack" && this.host.gameType === GameType.GT_1FCTF) this.resetFlag(Team.TEAM_FREE);
  }

  private flagSound(entity: GameEntity, sound: GlobalTeamSound): void {
    const event = this.host.pool.tempEntity(entity.s.pos.base, EntityEvent.EV_GLOBAL_TEAM_SOUND);
    event.s.eventParm = sound;
    event.r.svFlags |= ServerEntityFlags.BROADCAST;
  }

  returnFlagSound(entity: GameEntity | null, team: Team): void {
    if (entity === null) { this.host.warn("Warning:  NULL passed to Team_ReturnFlagSound\n"); return; }
    this.flagSound(entity, team === Team.TEAM_BLUE ? GlobalTeamSound.RED_RETURN : GlobalTeamSound.BLUE_RETURN);
  }

  takeFlagSound(entity: GameEntity | null, team: Team): void {
    if (entity === null) { this.host.warn("Warning:  NULL passed to Team_TakeFlagSound\n"); return; }
    if (team === Team.TEAM_RED) {
      if (this.state.blueStatus !== FlagStatus.AT_BASE && this.state.blueTakenTime > ((this.host.time - 10000) | 0)) return;
      this.state.blueTakenTime = this.host.time;
    } else if (team === Team.TEAM_BLUE) {
      if (this.state.redStatus !== FlagStatus.AT_BASE && this.state.redTakenTime > ((this.host.time - 10000) | 0)) return;
      this.state.redTakenTime = this.host.time;
    }
    this.flagSound(entity, team === Team.TEAM_BLUE ? GlobalTeamSound.RED_TAKEN : GlobalTeamSound.BLUE_TAKEN);
  }

  captureFlagSound(entity: GameEntity | null, team: Team): void {
    if (entity === null) { this.host.warn("Warning:  NULL passed to Team_CaptureFlagSound\n"); return; }
    this.flagSound(entity, team === Team.TEAM_BLUE ? GlobalTeamSound.BLUE_CAPTURE : GlobalTeamSound.RED_CAPTURE);
  }

  returnFlag(team: Team): void {
    this.returnFlagSound(this.resetFlag(team), team);
    this.printMessage(null, team === Team.TEAM_FREE ? "The flag has returned!\n" : `The ${teamName(team)} flag has returned!\n`);
  }

  freeEntity(entity: GameEntity): void { const team = flagTeam(entity); if (team !== null) this.returnFlag(team); }
  droppedFlagThink(entity: GameEntity): void {
    const team = flagTeam(entity) ?? Team.TEAM_FREE;
    this.returnFlagSound(this.resetFlag(team), team);
  }

  touchOurFlag(entity: GameEntity, other: GameEntity, team: Team): number {
    const client = clientOf(other), mission = this.host.product === "missionpack";
    const oneFlag = mission && this.host.gameType === GameType.GT_1FCTF;
    const enemyFlag = oneFlag ? Powerup.PW_NEUTRALFLAG : client.sess.sessionTeam === Team.TEAM_RED ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG;
    if (!oneFlag && (entity.flags & GameFlags.DROPPED_ITEM) !== 0) {
      this.printMessage(null, `${client.pers.netname}^7 returned the ${teamName(team)} flag!\n`);
      this.host.addScore(other, entity.r.currentOrigin, mission ? 10 : 1);
      client.pers.teamState.flagRecovery = (client.pers.teamState.flagRecovery + 1) | 0;
      client.pers.teamState.lastReturnedFlag = Math.fround(this.host.time);
      this.returnFlagSound(this.resetFlag(team), team);
      return 0;
    }
    if (client.ps.powerups.get(enemyFlag) === 0) return 0;
    this.printMessage(null, oneFlag ? `${client.pers.netname}^7 captured the flag!\n` : `${client.pers.netname}^7 captured the ${otherTeamName(team)} flag!\n`);
    client.ps.powerups.set(enemyFlag, 0);
    this.state.lastFlagCapture = Math.fround(this.host.time);
    this.state.lastCaptureTeam = team;
    this.addTeamScore(entity.s.pos.base, client.sess.sessionTeam, 1);
    this.forceGesture(client.sess.sessionTeam);
    client.pers.teamState.captures = (client.pers.teamState.captures + 1) | 0;
    this.award(other, 0x800);
    client.ps.persistant.set(PersistentIndex.PERS_CAPTURES, client.ps.persistant.get(PersistentIndex.PERS_CAPTURES) + 1);
    this.host.addScore(other, entity.r.currentOrigin, mission ? 100 : 5);
    this.captureFlagSound(entity, team);
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const player = this.host.pool.at(index);
      if (!player.inuse) continue;
      const teammate = clientOf(player);
      if (teammate.sess.sessionTeam !== client.sess.sessionTeam) teammate.pers.teamState.lastHurtCarrier = -5;
      else {
        if (player !== other) this.host.addScore(player, entity.r.currentOrigin, mission ? 25 : 0);
        let bonus: number | null = null;
        if (Math.fround(teammate.pers.teamState.lastReturnedFlag + 10000) > Math.fround(this.host.time)) bonus = mission ? 10 : 1;
        else if (Math.fround(teammate.pers.teamState.lastFraggedCarrier + 10000) > Math.fround(this.host.time)) bonus = mission ? 10 : 2;
        if (bonus !== null) {
          this.host.addScore(player, entity.r.currentOrigin, bonus);
          client.pers.teamState.assists = (client.pers.teamState.assists + 1) | 0;
          teammate.ps.persistant.set(PersistentIndex.PERS_ASSIST_COUNT, teammate.ps.persistant.get(PersistentIndex.PERS_ASSIST_COUNT) + 1);
          this.award(player, 0x20000);
        }
      }
    }
    this.resetFlags();
    this.host.calculateRanks();
    return 0;
  }

  touchEnemyFlag(entity: GameEntity, other: GameEntity, team: Team): number {
    const client = clientOf(other), mission = this.host.product === "missionpack";
    if (mission && this.host.gameType === GameType.GT_1FCTF) {
      this.printMessage(null, `${client.pers.netname}^7 got the flag!\n`);
      client.ps.powerups.set(Powerup.PW_NEUTRALFLAG, 2147483647);
      this.setFlagStatus(Team.TEAM_FREE, team === Team.TEAM_RED ? FlagStatus.TAKEN_RED : FlagStatus.TAKEN_BLUE);
    } else {
      this.printMessage(null, `${client.pers.netname}^7 got the ${teamName(team)} flag!\n`);
      client.ps.powerups.set(team === Team.TEAM_RED ? Powerup.PW_REDFLAG : Powerup.PW_BLUEFLAG, 2147483647);
      this.setFlagStatus(team, FlagStatus.TAKEN);
    }
    this.host.addScore(other, entity.r.currentOrigin, mission ? 10 : 0);
    client.pers.teamState.flagSince = Math.fround(this.host.time);
    this.takeFlagSound(entity, team);
    return -1;
  }

  pickupTeam(entity: GameEntity, other: GameEntity): number {
    const client = clientOf(other);
    if (this.host.product === "missionpack") {
      if (this.host.gameType === GameType.GT_OBELISK) { this.host.pool.free(entity); return 0; }
      if (this.host.gameType === GameType.GT_HARVESTER) {
        if (entity.spawnflags !== client.sess.sessionTeam) client.ps.generic1 = (client.ps.generic1 + 1) | 0;
        this.host.pool.free(entity);
        return 0;
      }
    }
    const team = entity.classname === "team_CTF_redflag" ? Team.TEAM_RED : entity.classname === "team_CTF_blueflag" ? Team.TEAM_BLUE
      : this.host.product === "missionpack" && entity.classname === "team_CTF_neutralflag" ? Team.TEAM_FREE : null;
    if (team === null) { this.printMessage(other, "Don't know what team the flag is on.\n"); return 0; }
    if (this.host.product === "missionpack" && this.host.gameType === GameType.GT_1FCTF) {
      if (team === Team.TEAM_FREE) return this.touchEnemyFlag(entity, other, client.sess.sessionTeam);
      return team !== client.sess.sessionTeam ? this.touchOurFlag(entity, other, client.sess.sessionTeam) : 0;
    }
    return team === client.sess.sessionTeam ? this.touchOurFlag(entity, other, team) : this.touchEnemyFlag(entity, other, team);
  }

  getLocation(entity: GameEntity): GameEntity | null {
    let best: GameEntity | null = null, bestLength = 3 * 8192 * 8192;
    for (let location = this.host.locationHead; location !== null; location = location.nextTrain) {
      const delta = sub3(entity.r.currentOrigin, location.r.currentOrigin);
      const length = dot3(delta, delta);
      if (length > bestLength || !this.host.inPVS(entity.r.currentOrigin, location.r.currentOrigin)) continue;
      bestLength = length;
      best = location;
    }
    return best;
  }

  getLocationMessage(entity: GameEntity, capacity: number): string | null {
    const location = this.getLocation(entity);
    if (location === null) return null;
    if (location.count !== 0) {
      location.count = Math.max(0, Math.min(7, location.count));
      return gameFormat("%c%c%s^7", [94, location.count + 48, location.message], capacity);
    }
    return gameFormat("%s", [location.message], capacity);
  }

  teamplayInfoMessage(entity: GameEntity): void {
    if (!clientOf(entity).pers.teamInfo) return;
    const clients: number[] = [];
    for (let index = 0; index < this.host.pool.maxClients && clients.length < 32; index++) {
      const clientNum = this.host.sortedClients[index];
      if (clientNum === undefined) throw new RangeError(`Missing sorted client slot ${index}`);
      const player = this.host.pool.at(clientNum);
      if (player.inuse && clientOf(player).sess.sessionTeam === clientOf(entity).sess.sessionTeam) {
        const selected = this.host.sortedClients[index];
        if (selected === undefined) throw new RangeError(`Missing sorted client slot ${index}`);
        clients.push(selected);
      }
    }
    clients.sort(sortClients);
    let message = "", count = 0;
    // Source sorts a local clients[] that is never read by this output loop.
    for (let index = 0; index < this.host.pool.maxClients && count < 32; index++) {
      const player = this.host.pool.at(index);
      if (!player.inuse || clientOf(player).sess.sessionTeam !== clientOf(entity).sess.sessionTeam) continue;
      const client = clientOf(player);
      const entry = gameFormat(" %i %i %i %i %i %i", [index, client.pers.teamState.location,
        Math.max(0, client.ps.health), Math.max(0, client.ps.stats.get(statSchema(this.host.product).armor)), client.ps.weapon, player.s.powerups], 1024);
      if (message.length + entry.length > 8192) break;
      message += entry;
      count++;
    }
    this.host.sendServerCommand(entity.slot, gameFormat("tinfo %i %s", [count, message]));
  }

  checkTeamStatus(): void {
    if (((this.host.time - this.lastTeamLocationTime) | 0) <= 1000) return;
    this.lastTeamLocationTime = this.host.time;
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const entity = this.host.pool.at(index), client = clientOf(entity);
      if (client.pers.connected !== ConnectionState.CONNECTED) continue;
      if (entity.inuse && (client.sess.sessionTeam === Team.TEAM_RED || client.sess.sessionTeam === Team.TEAM_BLUE)) {
        client.pers.teamState.location = this.getLocation(entity)?.health ?? 0;
      }
    }
    for (let index = 0; index < this.host.pool.maxClients; index++) {
      const entity = this.host.pool.at(index), client = clientOf(entity);
      if (client.pers.connected !== ConnectionState.CONNECTED) continue;
      if (entity.inuse && (client.sess.sessionTeam === Team.TEAM_RED || client.sess.sessionTeam === Team.TEAM_BLUE)) this.teamplayInfoMessage(entity);
    }
  }

  private obeliskSettings(): ObeliskSettings {
    if (this.host.product !== "missionpack") throw new Error("Obelisk handlers belong to the missionpack product");
    return this.host.obelisk;
  }

  private obeliskModel(entity: GameEntity): GameEntity {
    if (entity.activator === null) throw new Error("Obelisk callback requires its spawned model entity");
    return entity.activator;
  }

  readonly obeliskRegen: EntityThink = self => {
    const settings = this.obeliskSettings();
    self.nextthink = (this.host.time + Math.imul(settings.regenPeriodSeconds, 1000)) | 0;
    if (self.health >= settings.health) return;
    this.host.pool.addEvent(self, EntityEvent.EV_POWERUP_REGEN, 0);
    self.health = Math.min((self.health + settings.regenAmount) | 0, settings.health);
    const model = this.obeliskModel(self);
    model.s.modelindex2 = Math.trunc(Math.imul(self.health, 255) / settings.health) | 0;
    model.s.frame = 0;
  };

  readonly obeliskRespawn: EntityThink = self => {
    const settings = this.obeliskSettings();
    self.takedamage = true;
    self.health = settings.health;
    self.think = this.obeliskRegen;
    self.nextthink = (this.host.time + Math.imul(settings.regenPeriodSeconds, 1000)) | 0;
    this.obeliskModel(self).s.frame = 0;
  };

  readonly obeliskDie: EntityDie = (self, _inflictor, attacker, _damage, _method) => {
    const team = this.obeliskTeam(self);
    const opposing = otherTeam(team);
    this.addTeamScore(self.s.pos.base, opposing, 1);
    this.forceGesture(opposing);
    this.host.calculateRanks();
    self.takedamage = false;
    self.think = this.obeliskRespawn;
    self.nextthink = (this.host.time + Math.imul(this.obeliskSettings().respawnDelaySeconds, 1000)) | 0;
    const model = this.obeliskModel(self);
    model.s.modelindex2 = 255;
    model.s.frame = 2;
    this.host.pool.addEvent(model, EntityEvent.EV_OBELISKEXPLODE, 0);
    this.host.addScore(attacker, self.r.currentOrigin, 100);
    this.award(attacker, 0x800);
    const ps = clientOf(attacker).ps;
    ps.persistant.set(PersistentIndex.PERS_CAPTURES, ps.persistant.get(PersistentIndex.PERS_CAPTURES) + 1);
    this.state.redObeliskAttackedTime = 0;
    this.state.blueObeliskAttackedTime = 0;
  };

  readonly obeliskTouch: EntityTouch = (self, other, _trace) => {
    if (other.client === null || otherTeam(other.client.sess.sessionTeam) !== self.spawnflags) return;
    const tokens = other.client.ps.generic1;
    if (tokens <= 0) return;
    this.printMessage(null, gameFormat("%s^7 brought in %i skull%s.\n", [other.client.pers.netname, tokens, tokens !== 0 ? "s" : ""]));
    this.addTeamScore(self.s.pos.base, other.client.sess.sessionTeam, tokens);
    this.forceGesture(other.client.sess.sessionTeam);
    this.host.addScore(other, self.r.currentOrigin, Math.imul(100, tokens));
    this.award(other, 0x800);
    other.client.ps.persistant.set(PersistentIndex.PERS_CAPTURES, other.client.ps.persistant.get(PersistentIndex.PERS_CAPTURES) + tokens);
    other.client.ps.generic1 = 0;
    this.host.calculateRanks();
    this.captureFlagSound(self, this.obeliskTeam(self));
  };

  readonly obeliskPain: EntityPain = (self, attacker, amount) => {
    const actualDamage = Math.max(1, Math.trunc(amount / 10));
    const model = this.obeliskModel(self);
    model.s.modelindex2 = Math.trunc(Math.imul(self.health, 255) / this.obeliskSettings().health) | 0;
    if (model.s.frame === 0) this.host.pool.addEvent(self, EntityEvent.EV_OBELISKPAIN, 0);
    model.s.frame = 1;
    this.host.addScore(attacker, self.r.currentOrigin, actualDamage);
  };

  private obeliskTeam(entity: GameEntity): Team {
    switch (entity.spawnflags) {
      case Team.TEAM_FREE: case Team.TEAM_RED: case Team.TEAM_BLUE: case Team.TEAM_SPECTATOR: return entity.spawnflags;
      default: throw new Error("Spawned obelisk has no source team");
    }
  }

  spawnObelisk(origin: Vec3, team: Team, spawnflags: number): GameEntity {
    const settings = this.obeliskSettings();
    const entity = this.host.pool.spawn();
    entity.s.origin = { ...origin };
    entity.s.pos = { ...entity.s.pos, base: { ...origin } };
    entity.r.currentOrigin = { ...origin };
    entity.r.mins = vec3(-15, -15, 0);
    entity.r.maxs = vec3(15, 15, 87);
    entity.s.eType = EntityType.ET_GENERAL;
    entity.flags = GameFlags.NO_KNOCKBACK;
    if (this.host.gameType === GameType.GT_OBELISK) {
      entity.r.contents = 1;
      entity.takedamage = true;
      entity.health = settings.health;
      entity.die = this.obeliskDie;
      entity.pain = this.obeliskPain;
      entity.think = this.obeliskRegen;
      entity.nextthink = (this.host.time + Math.imul(settings.regenPeriodSeconds, 1000)) | 0;
    }
    if (this.host.gameType === GameType.GT_HARVESTER) {
      entity.r.contents = 0x40000000;
      entity.touch = this.obeliskTouch;
    }
    if ((spawnflags & 1) !== 0) setOrigin(entity, entity.s.origin);
    else {
      entity.s.origin = vec3(origin.x, origin.y, origin.z + 1);
      const destination = vec3(entity.s.origin.x, entity.s.origin.y, entity.s.origin.z - 4096);
      const trace = this.host.world.trace({ start: entity.s.origin, end: destination,
        shape: { kind: "box", mins: entity.r.mins, maxs: entity.r.maxs }, passEntityNum: entity.s.number, mask: 1 });
      if (trace.solidity !== "clear") {
        entity.s.origin = vec3(entity.s.origin.x, entity.s.origin.y, entity.s.origin.z - 1);
        this.host.warn(gameFormat("SpawnObelisk: %s startsolid at %s\n",
          [entity.classname, this.host.pool.utilities.vtos(entity.s.origin).readString()]));
        entity.s.groundEntityNum = ENTITYNUM_NONE;
        setOrigin(entity, entity.s.origin);
      } else {
        entity.s.groundEntityNum = trace.entityNum;
        setOrigin(entity, trace.end);
      }
    }
    entity.spawnflags = team;
    this.host.world.link(entity);
    return entity;
  }

  spawnTeamObelisk(entity: GameEntity, team: Team.TEAM_RED | Team.TEAM_BLUE): void {
    this.obeliskSettings();
    if (this.host.gameType <= GameType.GT_TEAM) { this.host.pool.free(entity); return; }
    entity.s.eType = EntityType.ET_TEAM;
    if (this.host.gameType === GameType.GT_OBELISK || this.host.gameType === GameType.GT_HARVESTER) {
      const obelisk = this.spawnObelisk(entity.s.origin, team, entity.spawnflags);
      obelisk.activator = entity;
      if (this.host.gameType === GameType.GT_OBELISK) { entity.s.modelindex2 = 255; entity.s.frame = 0; }
    }
    entity.s.modelindex = team;
    this.host.world.link(entity);
  }

  spawnNeutralObelisk(entity: GameEntity): void {
    this.obeliskSettings();
    if (this.host.gameType !== GameType.GT_1FCTF && this.host.gameType !== GameType.GT_HARVESTER) { this.host.pool.free(entity); return; }
    entity.s.eType = EntityType.ET_TEAM;
    if (this.host.gameType === GameType.GT_HARVESTER) this.neutralObelisk = this.spawnObelisk(entity.s.origin, Team.TEAM_FREE, entity.spawnflags);
    entity.s.modelindex = Team.TEAM_FREE;
    this.host.world.link(entity);
  }

  checkObeliskAttack(obelisk: GameEntity, attacker: GameEntity): boolean {
    if (obelisk.die !== this.obeliskDie || attacker.client === null) return false;
    if (obelisk.spawnflags === attacker.client.sess.sessionTeam) return true;
    const red = obelisk.spawnflags === Team.TEAM_RED, blue = obelisk.spawnflags === Team.TEAM_BLUE;
    if ((red && this.state.redObeliskAttackedTime < ((this.host.time - 20000) | 0)) ||
      (blue && this.state.blueObeliskAttackedTime < ((this.host.time - 20000) | 0))) {
      this.flagSound(obelisk, red ? GlobalTeamSound.RED_OBELISK_ATTACKED : GlobalTeamSound.BLUE_OBELISK_ATTACKED);
      if (red) this.state.redObeliskAttackedTime = this.host.time;
      else this.state.blueObeliskAttackedTime = this.host.time;
    }
    return false;
  }
}
