// Ported from id Software's code/game/ai_dmq3.c team, identity and objective AI.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BotActionFlag } from "../botlib/actions.ts";
import type { BotGoal } from "../botlib/goals.ts";
import { TravelFlags } from "../botlib/routing.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import { dot3, length3, sub3 } from "../core/math.ts";
import { GameType, Team } from "../shared/definitions.ts";
import type { GameAiContext } from "./ai-context.ts";
import { botAggression, botEntityVisible, entityCarriesCubes, entityCarriesFlag } from "./ai-combat.ts";
import { botPrintTeamGoal } from "./ai-command.ts";
import { BotCtfFlag, BotInventory, BotLongTermGoal, BotTeamTaskPreference,
  CTF_GETFLAG_TIME, CTF_RETURNFLAG_TIME, CTF_ROAM_TIME, CTF_RUSHBASE_TIME,
  TEAM_ACCOMPANY_TIME, TEAM_ATTACKENEMYBASE_TIME, TEAM_DEFENDKEYAREA_TIME, TEAM_HARVEST_TIME } from "./ai-definitions.ts";
import { botTeamLeader } from "./ai-main.ts";
import { botGetAlternateRouteGoal } from "./ai-navigation.ts";
import type { BotState } from "./ai-state.ts";
import { botVoiceChat } from "./ai-team.ts";
import { gameAtoi } from "./numeric.ts";
import { MAX_CLIENTS } from "./state.ts";

const CS_PLAYERS = 544;
const f = Math.fround;

/** Q_CleanStr keeps printable ASCII and removes source color escape pairs. */
export function botCleanString(text: string): string {
  let output = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) break;
    if (code === 94 && i + 1 < text.length && text.charCodeAt(i + 1) !== 94 && text.charCodeAt(i + 1) !== 0) { i++; continue; }
    if (code >= 32 && code <= 126) output += text.charAt(i);
  }
  return output;
}

function rawClientName(context: GameAiContext, client: number): string | null {
  if (client < 0 || client >= MAX_CLIENTS) {
    context.game.options.engine.print("^1Error: ClientName: client out of range\n");
    return null;
  }
  return infoValueForKey(context.game.options.configstrings.get(CS_PLAYERS + client).slice(0, 1023), "n");
}

export function clientName(context: GameAiContext, client: number, size = 36): string {
  const name = rawClientName(context, client);
  return name === null ? "[client out of range]" : botCleanString(name.slice(0, size - 1));
}

export function copyClientNameToTeamLeader(context: GameAiContext, state: BotState, client: number): void {
  const name = rawClientName(context, client);
  if (name !== null) state.copyTeamLeaderClientName(name);
}

export function clientSkin(context: GameAiContext, client: number, size = 128): string {
  if (client < 0 || client >= MAX_CLIENTS) {
    context.game.options.engine.print("^1Error: ClientSkin: client out of range\n");
    return "[client out of range]";
  }
  return infoValueForKey(context.game.options.configstrings.get(CS_PLAYERS + client).slice(0, 1023), "model").slice(0, size - 1);
}

export function clientFromName(context: GameAiContext, name: string): number {
  if (context.team.clientFromNameMaxClients === 0) context.team.clientFromNameMaxClients = context.game.options.cvars.get("sv_maxclients")?.integerValue ?? 0;
  for (let i = 0; i < context.team.clientFromNameMaxClients && i < MAX_CLIENTS; i++) {
    const info = botCleanString(context.game.options.configstrings.get(CS_PLAYERS + i).slice(0, 1023));
    if (infoValueForKey(info, "n").toLowerCase() === name.toLowerCase()) return i;
  }
  return -1;
}

export function clientOnSameTeamFromName(context: GameAiContext, state: BotState, name: string): number {
  if (context.team.clientOnSameTeamFromNameMaxClients === 0) context.team.clientOnSameTeamFromNameMaxClients = context.game.options.cvars.get("sv_maxclients")?.integerValue ?? 0;
  for (let i = 0; i < context.team.clientOnSameTeamFromNameMaxClients && i < MAX_CLIENTS; i++) {
    if (!botSameTeam(context, state, i)) continue;
    const info = botCleanString(context.game.options.configstrings.get(CS_PLAYERS + i).slice(0, 1023));
    if (infoValueForKey(info, "n").toLowerCase() === name.toLowerCase()) return i;
  }
  return -1;
}

export function stristr(text: string, part: string): string | null {
  const fold = (value: string): string => value.replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32));
  const textEnd = text.indexOf("\0"), partEnd = part.indexOf("\0");
  const input = textEnd < 0 ? text : text.slice(0, textEnd), pattern = partEnd < 0 ? part : part.slice(0, partEnd);
  const offset = fold(input).indexOf(fold(pattern));
  return offset < 0 || offset >= input.length ? null : input.slice(offset);
}

export function easyClientName(context: GameAiContext, client: number, size = 36): string {
  let name = Array.from(clientName(context, client, 128), character => String.fromCharCode(character.charCodeAt(0) & 127)).join("").replaceAll(" ", "");
  const left = name.indexOf("["), right = name.indexOf("]");
  if (left >= 0 && right >= 0) name = name.slice(0, Math.min(left, right)) + name.slice(Math.max(left, right) + 1);
  if (/^mr/i.test(name)) name = name.slice(2);
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, size - 1);
}

export function botSetUserInfo(context: GameAiContext, state: BotState, key: string, value: string): void {
  const engine = context.game.options.engine;
  const info = infoSetValueForKey(engine.getUserinfo(state.client).slice(0, 1023), key, value, text => engine.print(text));
  engine.setUserinfo(state.client, info);
  context.game.clientUserinfoChanged(state.client);
}

export function teamPlayIsOn(context: GameAiContext): boolean { return context.gameType >= GameType.GT_TEAM; }

export function botTeam(context: GameAiContext, state: BotState): Team {
  if (state.client < 0 || state.client >= MAX_CLIENTS) return Team.TEAM_FREE;
  const team = gameAtoi(infoValueForKey(context.game.options.configstrings.get(CS_PLAYERS + state.client).slice(0, 1023), "t"));
  return team === Team.TEAM_RED ? Team.TEAM_RED : team === Team.TEAM_BLUE ? Team.TEAM_BLUE : Team.TEAM_FREE;
}

export function botOppositeTeam(context: GameAiContext, state: BotState): Team {
  const team = botTeam(context, state);
  return team === Team.TEAM_RED ? Team.TEAM_BLUE : team === Team.TEAM_BLUE ? Team.TEAM_RED : Team.TEAM_FREE;
}

export function botSameTeam(context: GameAiContext, state: BotState, entity: number): boolean {
  if (state.client < 0 || state.client >= MAX_CLIENTS || entity < 0 || entity >= MAX_CLIENTS || !teamPlayIsOn(context)) return false;
  const strings = context.game.options.configstrings;
  return gameAtoi(infoValueForKey(strings.get(CS_PLAYERS + state.client).slice(0, 1023), "t")) ===
    gameAtoi(infoValueForKey(strings.get(CS_PLAYERS + entity).slice(0, 1023), "t"));
}

export function botEnemyFlag(context: GameAiContext, state: BotState): BotGoal {
  return botTeam(context, state) === Team.TEAM_RED ? context.deathmatch.ctfBlueFlag : context.deathmatch.ctfRedFlag;
}

export function botTeamFlag(context: GameAiContext, state: BotState): BotGoal {
  return botTeam(context, state) === Team.TEAM_RED ? context.deathmatch.ctfRedFlag : context.deathmatch.ctfBlueFlag;
}

function inventory(state: BotState, slot: BotInventory): number {
  const value = state.inventory[slot];
  if (value === undefined) throw new RangeError(`Missing bot inventory slot ${slot}`);
  return value;
}

export function botCTFCarryingFlag(context: GameAiContext, state: BotState): BotCtfFlag {
  if (context.gameType !== GameType.GT_CTF) return BotCtfFlag.NONE;
  if (inventory(state, BotInventory.REDFLAG) > 0) return BotCtfFlag.RED;
  if (inventory(state, BotInventory.BLUEFLAG) > 0) return BotCtfFlag.BLUE;
  return BotCtfFlag.NONE;
}

export function bot1FCTFCarryingFlag(context: GameAiContext, state: BotState): boolean {
  return context.gameType === GameType.GT_1FCTF && inventory(state, BotInventory.NEUTRALFLAG) > 0;
}

export function botHarvesterCarryingCubes(context: GameAiContext, state: BotState): boolean {
  return context.gameType === GameType.GT_HARVESTER && (inventory(state, BotInventory.REDCUBE) > 0 || inventory(state, BotInventory.BLUECUBE) > 0);
}

export function botSynonymContext(context: GameAiContext, state: BotState): number {
  let result = 1 | 2 | 1024;
  const red = botTeam(context, state) === Team.TEAM_RED;
  if (context.gameType === GameType.GT_CTF || (state.product === "missionpack" && context.gameType === GameType.GT_1FCTF)) result |= red ? 4 : 8;
  else if (state.product === "missionpack" && context.gameType === GameType.GT_OBELISK) result |= red ? 32 : 64;
  else if (state.product === "missionpack" && context.gameType === GameType.GT_HARVESTER) result |= red ? 128 : 256;
  return result;
}

function carrier(context: GameAiContext, state: BotState, teammate: boolean, visible: boolean, cubes: boolean): number {
  for (let i = 0; i < context.maxClients && i < MAX_CLIENTS; i++) {
    if (i === state.client) continue;
    const info = context.library.aas.entities.info(i);
    if (!info.valid || !(cubes ? entityCarriesCubes(context, info) : entityCarriesFlag(context, info))) continue;
    if (botSameTeam(context, state, i) !== teammate) continue;
    if (visible && botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, i) <= 0) continue;
    return i;
  }
  return -1;
}

export function botTeamFlagCarrierVisible(context: GameAiContext, state: BotState): number { return carrier(context, state, true, true, false); }
export function botTeamFlagCarrier(context: GameAiContext, state: BotState): number { return carrier(context, state, true, false, false); }
export function botEnemyFlagCarrierVisible(context: GameAiContext, state: BotState): number { return carrier(context, state, false, true, false); }
export function botTeamCubeCarrierVisible(context: GameAiContext, state: BotState): number { return carrier(context, state, true, true, true); }
export function botEnemyCubeCarrierVisible(context: GameAiContext, state: BotState): number { return carrier(context, state, false, true, true); }

/** The source deliberately counts only flag carriers in this helper. */
export function botVisibleTeamMatesAndEnemies(context: GameAiContext, state: BotState, range: number): { teammates: number; enemies: number } {
  let teammates = 0, enemies = 0;
  for (let i = 0; i < context.maxClients && i < MAX_CLIENTS; i++) {
    if (i === state.client) continue;
    const info = context.library.aas.entities.info(i);
    if (!info.valid || !entityCarriesFlag(context, info)) continue;
    const direction = sub3(info.origin, state.origin);
    if (dot3(direction, direction) > f(range * range)) continue;
    if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, i) <= 0) continue;
    if (botSameTeam(context, state, i)) teammates++; else enemies++;
  }
  return { teammates, enemies };
}

export function botRememberLastOrderedTask(_context: GameAiContext, state: BotState): void {
  if (!state.ordered) return;
  state.lastGoalDecisionmaker = state.decisionmaker;
  state.lastGoalLtgType = state.ltgType;
  state.lastGoalTeamGoal.copyFrom(state.teamGoal);
  state.lastGoalTeammate = state.teammate;
}

export function botSetTeamStatus(context: GameAiContext, state: BotState): void {
  if (state.product !== "missionpack") return;
  let task = 3;
  switch (state.ltgType) {
    case BotLongTermGoal.TEAMACCOMPANY: {
      const info = context.library.aas.entities.info(state.teammate);
      task = ((context.gameType === GameType.GT_CTF || context.gameType === GameType.GT_1FCTF) && entityCarriesFlag(context, info)) ||
        (context.gameType === GameType.GT_HARVESTER && entityCarriesCubes(context, info)) ? 6 : 4;
      break;
    }
    case BotLongTermGoal.DEFENDKEYAREA: case BotLongTermGoal.RUSHBASE: task = 2; break;
    case BotLongTermGoal.GETFLAG: case BotLongTermGoal.HARVEST: case BotLongTermGoal.ATTACKENEMYBASE: task = 1; break;
    case BotLongTermGoal.RETURNFLAG: task = 5; break;
    case BotLongTermGoal.CAMP: case BotLongTermGoal.CAMPORDER: task = 7; break;
  }
  botSetUserInfo(context, state, "teamtask", String(task));
}

export function botSetLastOrderedTask(context: GameAiContext, state: BotState): boolean {
  if (context.gameType === GameType.GT_CTF && state.lastGoalLtgType === BotLongTermGoal.RETURNFLAG &&
    (botTeam(context, state) === Team.TEAM_RED ? state.redFlagStatus : state.blueFlagStatus) === 0) state.lastGoalLtgType = 0;
  if (state.lastGoalLtgType === 0) return false;
  state.decisionmaker = state.lastGoalDecisionmaker;
  state.ordered = true;
  state.ltgType = state.lastGoalLtgType;
  state.teamGoal.copyFrom(state.lastGoalTeamGoal);
  state.teammate = state.lastGoalTeammate;
  state.teamGoalTime = f(context.time + 300);
  botSetTeamStatus(context, state);
  if (context.gameType === GameType.GT_CTF && state.ltgType === BotLongTermGoal.GETFLAG) {
    const phase = context.library.aas.phase;
    if (phase.kind === "ready" || phase.kind === "loaded") {
      const team = phase.map.routing.areaTravelTimeToGoal({ area: state.areaNum, origin: state.origin, goalArea: botTeamFlag(context, state).area, travelFlags: TravelFlags.DEFAULT });
      const enemy = phase.map.routing.areaTravelTimeToGoal({ area: state.areaNum, origin: state.origin, goalArea: botEnemyFlag(context, state).area, travelFlags: TravelFlags.DEFAULT });
      if (enemy > team) botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state));
    }
  }
  return true;
}

export function botRefuseOrder(context: GameAiContext, state: BotState): void {
  if (!state.ordered) return;
  if (state.orderTime !== 0 && state.orderTime > f(context.time - 10)) {
    context.library.actions.action(state.client, BotActionFlag.NEGATIVE);
    botVoiceChat(context, state, state.decisionmaker, "no");
    state.orderTime = 0;
  }
}

function decideForSelf(state: BotState): void { state.decisionmaker = state.client; state.ordered = false; }

function ownDecisionDeadline(time: number): number {
  const deadline = f(time + 5);
  if (!Number.isFinite(deadline) || deadline < -2147483648 || deadline > 2147483647) {
    throw new RangeError("Bot own-decision deadline has undefined source float-to-int conversion");
  }
  return Math.trunc(deadline) | 0;
}

function accompany(context: GameAiContext, state: BotState, teammate: number): void {
  decideForSelf(state);
  state.teammate = teammate;
  state.teammateVisibleTime = context.time;
  state.teamMessageTime = 0;
  state.arriveTime = 1;
  botVoiceChat(context, state, teammate, "onfollow");
  state.teamGoalTime = f(context.time + TEAM_ACCOMPANY_TIME);
  state.ltgType = BotLongTermGoal.TEAMACCOMPANY;
  state.formationDist = 3.5 * 32;
  botSetTeamStatus(context, state);
}

function rushBase(context: GameAiContext, state: BotState): void {
  botRefuseOrder(context, state);
  state.ltgType = BotLongTermGoal.RUSHBASE;
  state.teamGoalTime = f(context.time + CTF_RUSHBASE_TIME);
  state.rushBaseAwayTime = 0;
  decideForSelf(state);
}

function protectOrderedGoal(type: number): boolean {
  return type === BotLongTermGoal.TEAMHELP || type === BotLongTermGoal.TEAMACCOMPANY || type === BotLongTermGoal.CAMPORDER ||
    type === BotLongTermGoal.PATROL || type === BotLongTermGoal.GETITEM;
}

function ctfGoal(type: number, oneFlag: boolean): boolean {
  return protectOrderedGoal(type) || type === BotLongTermGoal.DEFENDKEYAREA || type === BotLongTermGoal.GETFLAG || type === BotLongTermGoal.RUSHBASE ||
    type === BotLongTermGoal.RETURNFLAG || type === BotLongTermGoal.MAKELOVE_UNDER || type === BotLongTermGoal.MAKELOVE_ONTOP ||
    (oneFlag && type === BotLongTermGoal.ATTACKENEMYBASE);
}

function thresholds(state: BotState): readonly [number, number] {
  if ((state.teamTaskPreference & (BotTeamTaskPreference.ATTACKER | BotTeamTaskPreference.DEFENDER)) !== 0) {
    return [(state.teamTaskPreference & BotTeamTaskPreference.ATTACKER) !== 0 ? f(0.7) : f(0.2), f(0.9)];
  }
  return [f(0.4), f(0.7)];
}

function defend(context: GameAiContext, state: BotState, goal: BotGoal): void {
  decideForSelf(state);
  state.teamGoal.copyFrom(goal);
  state.ltgType = BotLongTermGoal.DEFENDKEYAREA;
  state.teamGoalTime = f(context.time + TEAM_DEFENDKEYAREA_TIME);
  state.defendAwayTime = 0;
  botSetTeamStatus(context, state);
}

function roam(context: GameAiContext, state: BotState): void {
  state.ltgType = 0;
  state.ctfRoamTime = f(context.time + CTF_ROAM_TIME);
  botSetTeamStatus(context, state);
}

export function botCTFSeekGoals(context: GameAiContext, state: BotState): void {
  const goals = context.deathmatch;
  if (botCTFCarryingFlag(context, state) !== BotCtfFlag.NONE) {
    if (state.ltgType !== BotLongTermGoal.RUSHBASE) {
      rushBase(context, state);
      const team = botTeam(context, state);
      const direction = team === Team.TEAM_RED ? sub3(state.origin, goals.ctfBlueFlag.origin) :
        team === Team.TEAM_BLUE ? sub3(state.origin, goals.ctfRedFlag.origin) : { x: 999, y: 999, z: 999 };
      if (length3(direction) < 128) botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state));
      else state.altRouteGoal.area = 0;
      botSetUserInfo(context, state, "teamtask", "1");
      botVoiceChat(context, state, -1, "ihaveflag");
    } else if (state.rushBaseAwayTime > context.time && (botTeam(context, state) === Team.TEAM_RED ? state.redFlagStatus : state.blueFlagStatus) === 0) state.rushBaseAwayTime = 0;
    return;
  }
  if (state.ltgType === BotLongTermGoal.TEAMACCOMPANY && !state.ordered && !entityCarriesFlag(context, context.library.aas.entities.info(state.teammate))) state.ltgType = 0;
  const flagStatus = botTeam(context, state) === Team.TEAM_RED ? state.redFlagStatus * 2 + state.blueFlagStatus : state.blueFlagStatus * 2 + state.redFlagStatus;
  if (flagStatus === 1) {
    if (state.ownDecisionTime < context.time && !(state.ltgType === BotLongTermGoal.DEFENDKEYAREA &&
      (state.teamGoal.number === goals.ctfRedFlag.number || state.teamGoal.number === goals.ctfBlueFlag.number))) {
      const teammate = botTeamFlagCarrierVisible(context, state);
      if (teammate >= 0 && (state.ltgType !== BotLongTermGoal.TEAMACCOMPANY || state.teammate !== teammate)) {
        botRefuseOrder(context, state); accompany(context, state, teammate); state.ownDecisionTime = ownDecisionDeadline(context.time);
      }
    }
    return;
  }
  if (flagStatus === 2) {
    if (state.ownDecisionTime < context.time) {
      botEnemyFlagCarrierVisible(context, state);
      if (state.ltgType !== BotLongTermGoal.GETFLAG && state.ltgType !== BotLongTermGoal.RETURNFLAG && !protectOrderedGoal(state.ltgType)) {
        botRefuseOrder(context, state); decideForSelf(state);
        state.ltgType = context.random() < 0.5 ? BotLongTermGoal.GETFLAG : BotLongTermGoal.RETURNFLAG;
        state.teamMessageTime = 0; state.teamGoalTime = f(context.time + CTF_GETFLAG_TIME);
        botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state));
        botSetTeamStatus(context, state); state.ownDecisionTime = ownDecisionDeadline(context.time);
      }
    }
    return;
  }
  if (flagStatus === 3) {
    if (state.ownDecisionTime < context.time && state.ltgType !== BotLongTermGoal.RETURNFLAG && state.ltgType !== BotLongTermGoal.TEAMACCOMPANY) {
      const teammate = botTeamFlagCarrierVisible(context, state);
      botRefuseOrder(context, state);
      if (teammate >= 0) accompany(context, state, teammate);
      else {
        decideForSelf(state); state.teamMessageTime = f(context.time + f(2 * context.random()));
        state.ltgType = BotLongTermGoal.RETURNFLAG; state.teamGoalTime = f(context.time + CTF_RETURNFLAG_TIME);
        botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state)); botSetTeamStatus(context, state);
      }
      state.ownDecisionTime = ownDecisionDeadline(context.time);
    }
    return;
  }
  if (botTeamLeader(context, state)) return;
  if (state.lastGoalLtgType !== 0) state.teamGoalTime = f(state.teamGoalTime + 60);
  if (!state.ordered && state.lastGoalLtgType !== 0) state.ltgType = 0;
  if (ctfGoal(state.ltgType, false) || botSetLastOrderedTask(context, state)) return;
  if (state.ownDecisionTime > context.time || state.ctfRoamTime > context.time || botAggression(context, state) < 50) return;
  state.teamMessageTime = f(context.time + f(2 * context.random()));
  const [attack, defense] = thresholds(state), random = context.random();
  if (random < attack && goals.ctfRedFlag.area !== 0 && goals.ctfBlueFlag.area !== 0) {
    decideForSelf(state); state.ltgType = BotLongTermGoal.GETFLAG; state.teamGoalTime = f(context.time + CTF_GETFLAG_TIME);
    botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state)); botSetTeamStatus(context, state);
  } else if (random < defense && goals.ctfRedFlag.area !== 0 && goals.ctfBlueFlag.area !== 0) defend(context, state, botTeamFlag(context, state));
  else roam(context, state);
  state.ownDecisionTime = ownDecisionDeadline(context.time);
  if (context.library.debugBuild) botPrintTeamGoal(context, state);
}

export function botCTFRetreatGoals(context: GameAiContext, state: BotState): void {
  if (botCTFCarryingFlag(context, state) !== BotCtfFlag.NONE && state.ltgType !== BotLongTermGoal.RUSHBASE) { rushBase(context, state); botSetTeamStatus(context, state); }
}

export function bot1FCTFSeekGoals(context: GameAiContext, state: BotState): void {
  const goals = context.deathmatch;
  if (bot1FCTFCarryingFlag(context, state)) {
    if (state.ltgType !== BotLongTermGoal.RUSHBASE) {
      rushBase(context, state); botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state));
      botSetTeamStatus(context, state); botVoiceChat(context, state, -1, "ihaveflag");
    }
    return;
  }
  if (state.ltgType === BotLongTermGoal.TEAMACCOMPANY && !state.ordered && !entityCarriesFlag(context, context.library.aas.entities.info(state.teammate))) state.ltgType = 0;
  if (state.neutralFlagStatus === 1) {
    if (state.ownDecisionTime < context.time) {
      if (state.ltgType !== BotLongTermGoal.TEAMACCOMPANY) {
        const teammate = botTeamFlagCarrierVisible(context, state);
        if (teammate >= 0) { botRefuseOrder(context, state); accompany(context, state, teammate); state.ownDecisionTime = ownDecisionDeadline(context.time); return; }
      }
      if (ctfGoal(state.ltgType, true) && state.ltgType !== BotLongTermGoal.RETURNFLAG) return;
      if (state.ltgType !== BotLongTermGoal.ATTACKENEMYBASE) {
        botRefuseOrder(context, state); decideForSelf(state); state.teamGoal.copyFrom(botEnemyFlag(context, state));
        state.ltgType = BotLongTermGoal.ATTACKENEMYBASE; state.teamGoalTime = f(context.time + TEAM_ATTACKENEMYBASE_TIME);
        botSetTeamStatus(context, state); state.ownDecisionTime = ownDecisionDeadline(context.time);
      }
    }
    return;
  }
  if (state.neutralFlagStatus === 2) {
    if (state.ownDecisionTime < context.time) {
      botEnemyFlagCarrierVisible(context, state);
      if (protectOrderedGoal(state.ltgType)) return;
      if (state.ltgType !== BotLongTermGoal.DEFENDKEYAREA) {
        botRefuseOrder(context, state); defend(context, state, botTeamFlag(context, state)); state.ownDecisionTime = ownDecisionDeadline(context.time);
      }
    }
    return;
  }
  if (botTeamLeader(context, state)) return;
  if (state.lastGoalLtgType !== 0) state.teamGoalTime = f(state.teamGoalTime + 60);
  if (!state.ordered && state.lastGoalLtgType !== 0) state.ltgType = 0;
  if (ctfGoal(state.ltgType, true) || botSetLastOrderedTask(context, state)) return;
  if (state.ownDecisionTime > context.time || state.ctfRoamTime > context.time || botAggression(context, state) < 50) return;
  state.teamMessageTime = f(context.time + f(2 * context.random()));
  const [attack, defense] = thresholds(state), random = context.random();
  if (random < attack && goals.ctfNeutralFlag.area !== 0) {
    decideForSelf(state); state.ltgType = BotLongTermGoal.GETFLAG; state.teamGoalTime = f(context.time + CTF_GETFLAG_TIME); botSetTeamStatus(context, state);
  } else if (random < defense && goals.ctfRedFlag.area !== 0 && goals.ctfBlueFlag.area !== 0) defend(context, state, botTeamFlag(context, state));
  else roam(context, state);
  state.ownDecisionTime = ownDecisionDeadline(context.time);
  if (context.library.debugBuild) botPrintTeamGoal(context, state);
}

export function bot1FCTFRetreatGoals(context: GameAiContext, state: BotState): void {
  if (bot1FCTFCarryingFlag(context, state) && state.ltgType !== BotLongTermGoal.RUSHBASE) {
    rushBase(context, state); botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state)); botSetTeamStatus(context, state);
  }
}

export function botObeliskSeekGoals(context: GameAiContext, state: BotState): void {
  if (botTeamLeader(context, state)) return;
  if (state.lastGoalLtgType !== 0) state.teamGoalTime = f(state.teamGoalTime + 60);
  if (ctfGoal(state.ltgType, true) || botSetLastOrderedTask(context, state)) return;
  if (state.ctfRoamTime > context.time || botAggression(context, state) < 50) return;
  state.teamMessageTime = f(context.time + f(2 * context.random()));
  const [attack, defense] = thresholds(state), random = context.random(), goals = context.deathmatch;
  if (random < attack && goals.redObelisk.area !== 0 && goals.blueObelisk.area !== 0) {
    decideForSelf(state); state.teamGoal.copyFrom(botTeam(context, state) === Team.TEAM_RED ? goals.blueObelisk : goals.redObelisk);
    state.ltgType = BotLongTermGoal.ATTACKENEMYBASE; state.teamGoalTime = f(context.time + TEAM_ATTACKENEMYBASE_TIME);
    botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state)); botSetTeamStatus(context, state);
  } else if (random < defense && goals.redObelisk.area !== 0 && goals.blueObelisk.area !== 0) {
    defend(context, state, botTeam(context, state) === Team.TEAM_RED ? goals.redObelisk : goals.blueObelisk);
  } else roam(context, state);
}

export function botGoHarvest(context: GameAiContext, state: BotState): void {
  state.teamGoal.copyFrom(botTeam(context, state) === Team.TEAM_RED ? context.deathmatch.blueObelisk : context.deathmatch.redObelisk);
  state.ltgType = BotLongTermGoal.HARVEST; state.teamGoalTime = f(context.time + TEAM_HARVEST_TIME); state.harvestAwayTime = 0;
  botSetTeamStatus(context, state);
}

/** BotObeliskRetreatGoals has an empty body in the reference. */
export function botObeliskRetreatGoals(_context: GameAiContext, _state: BotState): void {}

export function botHarvesterSeekGoals(context: GameAiContext, state: BotState): void {
  if (botHarvesterCarryingCubes(context, state)) {
    if (state.ltgType !== BotLongTermGoal.RUSHBASE) {
      rushBase(context, state); botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state)); botSetTeamStatus(context, state);
    }
    return;
  }
  if (botTeamLeader(context, state)) return;
  if (state.ltgType === BotLongTermGoal.TEAMACCOMPANY && !state.ordered && !entityCarriesCubes(context, context.library.aas.entities.info(state.teammate))) state.ltgType = 0;
  if (state.lastGoalLtgType !== 0) state.teamGoalTime = f(state.teamGoalTime + 60);
  if ((ctfGoal(state.ltgType, true) && state.ltgType !== BotLongTermGoal.RUSHBASE && state.ltgType !== BotLongTermGoal.RETURNFLAG) ||
    state.ltgType === BotLongTermGoal.HARVEST || botSetLastOrderedTask(context, state)) return;
  if (state.ctfRoamTime > context.time || botAggression(context, state) < 50) return;
  state.teamMessageTime = f(context.time + f(2 * context.random()));
  botEnemyCubeCarrierVisible(context, state);
  if (state.ltgType !== BotLongTermGoal.TEAMACCOMPANY) {
    const teammate = botTeamCubeCarrierVisible(context, state);
    if (teammate >= 0) { accompany(context, state, teammate); return; }
  }
  const [attack, defense] = thresholds(state), random = context.random(), goals = context.deathmatch;
  if (random < attack && goals.redObelisk.area !== 0 && goals.blueObelisk.area !== 0) { decideForSelf(state); botGoHarvest(context, state); }
  else if (random < defense && goals.redObelisk.area !== 0 && goals.blueObelisk.area !== 0) {
    defend(context, state, botTeam(context, state) === Team.TEAM_RED ? goals.redObelisk : goals.blueObelisk);
  } else roam(context, state);
}

export function botHarvesterRetreatGoals(context: GameAiContext, state: BotState): void {
  if (botHarvesterCarryingCubes(context, state) && state.ltgType !== BotLongTermGoal.RUSHBASE) { rushBase(context, state); botSetTeamStatus(context, state); }
}

export function botTeamGoals(context: GameAiContext, state: BotState, retreat: boolean): void {
  if (context.gameType === GameType.GT_CTF) {
    if (retreat) botCTFRetreatGoals(context, state); else botCTFSeekGoals(context, state);
  } else if (state.product === "missionpack") {
    switch (context.gameType) {
      case GameType.GT_1FCTF: if (retreat) bot1FCTFRetreatGoals(context, state); else bot1FCTFSeekGoals(context, state); break;
      case GameType.GT_OBELISK: if (retreat) botObeliskRetreatGoals(context, state); else botObeliskSeekGoals(context, state); break;
      case GameType.GT_HARVESTER: if (retreat) botHarvesterRetreatGoals(context, state); else botHarvesterSeekGoals(context, state); break;
    }
  }
  state.orderTime = 0;
}
