// Ported from id Software's game/ai_cmd.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BotActionFlag } from "../botlib/actions.ts";
import { ChatDestination, stringContains } from "../botlib/chat.ts";
import type { ChatMatch } from "../botlib/chat.ts";
import { GoalFlags } from "../botlib/goals.ts";
import { TravelFlags } from "../botlib/routing.ts";
import { length3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { GameType, Team } from "../shared/definitions.ts";
import { botInitialChat } from "./ai-chat.ts";
import { botEntityInfo } from "./ai-combat.ts";
import type { GameAiContext } from "./ai-context.ts";
import { BotLongTermGoal, BotMatchContext, BotMatchSubtype, BotMatchVariable, BotMessage, BotPatrolFlag,
  BotTeamTaskPreference, CTF_GETFLAG_TIME, CTF_RETURNFLAG_TIME, CTF_RUSHBASE_TIME, TEAM_ACCOMPANY_TIME,
  TEAM_ATTACKENEMYBASE_TIME, TEAM_CAMP_TIME, TEAM_DEFENDKEYAREA_TIME, TEAM_GETITEM_TIME,
  TEAM_HARVEST_TIME, TEAM_HELP_TIME, TEAM_KILL_SOMEONE, TEAM_LEAD_TIME, TEAM_PATROL_TIME } from "./ai-definitions.ts";
import { botCreateWayPoint, botFindWayPoint, botFreeWaypoints, botGetAlternateRouteGoal, botPointAreaNum } from "./ai-navigation.ts";
import { botOppositeTeam, botRememberLastOrderedTask, botSameTeam, botSetTeamStatus, botTeam,
  clientFromName, clientName, clientOnSameTeamFromName, copyClientNameToTeamLeader, easyClientName } from "./ai-orders.ts";
import { BotGoalState } from "./ai-state.ts";
import type { BotState, BotWaypoint } from "./ai-state.ts";
import { botGetTeamMateTaskPreference, botSetTeamMateTaskPreference, botVoiceChat, botVoiceChatOnly } from "./ai-team.ts";
import { gameFormat } from "./format.ts";
import { gameAtof, scanGameVector } from "./numeric.ts";
import { MAX_CLIENTS } from "./state.ts";

const f = Math.fround;

/** ai_cmd.c globals and function-static caches, owned by the game AI instance. */
export class GameAiCommandState {
  readonly notLeader: boolean[] = Array.from({ length: MAX_CLIENTS }, () => false);
  readonly maxClients = new Map<string, number>();
}

/** ai_cmd.c DEBUG helper; the selected release leaves its normal callers inactive. */
export function botPrintTeamGoal(context: GameAiContext, state: BotState): void {
  const name = clientName(context, state.client, 36);
  let time = f(state.teamGoalTime - context.time);
  let action: string | null = null;
  switch (state.ltgType) {
    case BotLongTermGoal.TEAMHELP: action = "help a team mate"; break;
    case BotLongTermGoal.TEAMACCOMPANY: action = "accompany a team mate"; break;
    case BotLongTermGoal.GETFLAG: action = "get the flag"; break;
    case BotLongTermGoal.RUSHBASE: action = "rush to the base"; break;
    case BotLongTermGoal.RETURNFLAG: action = "try to return the flag"; break;
    case BotLongTermGoal.ATTACKENEMYBASE:
      if (context.game.options.product === "missionpack") action = "attack the enemy base";
      break;
    case BotLongTermGoal.HARVEST:
      if (context.game.options.product === "missionpack") action = "harvest";
      break;
    case BotLongTermGoal.DEFENDKEYAREA: action = "defend a key area"; break;
    case BotLongTermGoal.GETITEM: action = "get an item"; break;
    case BotLongTermGoal.KILL: action = "kill someone"; break;
    case BotLongTermGoal.CAMP:
    case BotLongTermGoal.CAMPORDER: action = "camp"; break;
    case BotLongTermGoal.PATROL: action = "patrol"; break;
  }
  if (action === null) {
    if (state.ctfRoamTime > context.time) {
      time = f(state.ctfRoamTime - context.time);
      action = "roam";
    } else {
      context.game.options.engine.print(gameFormat("%s: I've got a regular goal\n", [name], 2048));
      return;
    }
  }
  context.game.options.engine.print(gameFormat("%s: I'm gonna %s for %1.0f secs\n", [name, action, time], 2048));
}

function maximumClients(context: GameAiContext, name: string): number {
  let maximum = context.command.maxClients.get(name);
  if (maximum === undefined || maximum === 0) {
    const cvar = context.game.options.cvars.get("sv_maxclients");
    maximum = cvar === undefined ? 0 : cvar.integerValue;
    context.command.maxClients.set(name, maximum);
  }
  return Math.min(maximum, MAX_CLIENTS);
}

function variable(context: GameAiContext, match: ChatMatch, index: BotMatchVariable, size = 256): string {
  return context.library.chat.matchVariable(match, index, size);
}

function folded(text: string): string {
  const nul = text.indexOf("\0");
  return (nul < 0 ? text : text.slice(0, nul)).replace(/[a-z]/g, character => String.fromCharCode(character.charCodeAt(0) - 32));
}

export function botGetItemTeamGoal(context: GameAiContext, name: string, goal: BotGoalState): boolean {
  if (name.length === 0) return false;
  let index = -1;
  do {
    const item = context.library.goals.getLevelItemGoal(index, name, goal);
    if (item === null) return false;
    goal.copyFrom(item);
    index = item.number;
    if (index > 0 && (goal.flags & GoalFlags.Dropped) === 0) return true;
  } while (index > 0);
  return false;
}

export function botGetMessageTeamGoal(context: GameAiContext, state: BotState, name: string, goal: BotGoalState): boolean {
  if (botGetItemTeamGoal(context, name, goal)) return true;
  const checkpoint = botFindWayPoint(state.checkpoints, name);
  if (checkpoint === null) return false;
  goal.copyFrom(checkpoint.goal);
  return true;
}

export function botGetTime(context: GameAiContext, match: ChatMatch): number {
  if ((match.subtype & BotMatchSubtype.TIME) === 0) return 0;
  const timeMatch = context.library.chat.findMatch(variable(context, match, BotMatchVariable.TIME), BotMatchContext.TIME);
  if (timeMatch === null) return 0;
  let duration: number;
  if (timeMatch.type === BotMessage.FOREVER) duration = f(99999999);
  else if (timeMatch.type === BotMessage.FORAWHILE) duration = 600;
  else if (timeMatch.type === BotMessage.FORALONGTIME) duration = 1800;
  else {
    const text = variable(context, timeMatch, BotMatchVariable.TIME);
    duration = timeMatch.type === BotMessage.MINUTES ? f(gameAtof(text) * 60) : timeMatch.type === BotMessage.SECONDS ? gameAtof(text) : 0;
  }
  return duration > 0 ? f(context.time + duration) : 0;
}

export function findClientByName(context: GameAiContext, name: string): number {
  const maximum = maximumClients(context, "FindClientByName");
  for (let client = 0; client < maximum; client++) if (folded(clientName(context, client, 1024)) === folded(name)) return client;
  for (let client = 0; client < maximum; client++) if (stringContains(clientName(context, client, 1024), name, false) >= 0) return client;
  return -1;
}

export function findEnemyByName(context: GameAiContext, state: BotState, name: string): number {
  const maximum = maximumClients(context, "FindEnemyByName");
  for (let client = 0; client < maximum; client++) if (!botSameTeam(context, state, client) && folded(clientName(context, client, 1024)) === folded(name)) return client;
  for (let client = 0; client < maximum; client++) if (!botSameTeam(context, state, client) && stringContains(clientName(context, client, 1024), name, false) >= 0) return client;
  return -1;
}

export function numPlayersOnSameTeam(context: GameAiContext, state: BotState): number {
  const maximum = maximumClients(context, "NumPlayersOnSameTeam");
  let count = 0;
  for (let client = 0; client < maximum; client++) {
    // The original counts i+1 after checking player i's configstring.
    if (context.game.options.configstrings.get(544 + client).length !== 0 && botSameTeam(context, state, client + 1)) count++;
  }
  return count;
}

export function botGetPatrolWaypoints(context: GameAiContext, state: BotState, match: ChatMatch): boolean {
  let points: BotWaypoint | null = null;
  let flags = 0;
  let text = variable(context, match, BotMatchVariable.KEYAREA);
  const goal = new BotGoalState();
  while (true) {
    const areaMatch = context.library.chat.findMatch(text, BotMatchContext.PATROLKEYAREA);
    if (areaMatch === null) {
      context.library.actions.sayTeam(state.client, "what do you say?");
      botFreeWaypoints(context, points);
      state.patrolPoints = null;
      return false;
    }
    const areaName = variable(context, areaMatch, BotMatchVariable.KEYAREA);
    if (!botGetMessageTeamGoal(context, state, areaName, goal)) {
      botFreeWaypoints(context, points);
      state.patrolPoints = null;
      return false;
    }
    const point = botCreateWayPoint(context, areaName, goal.origin, goal.area);
    if (point === null) break;
    point.next = null;
    let tail = points;
    while (tail !== null && tail.next !== null) tail = tail.next;
    if (tail === null) { points = point; point.prev = null; }
    else { tail.next = point; point.prev = tail; }
    if ((areaMatch.subtype & BotMatchSubtype.BACK) !== 0) { flags = BotPatrolFlag.LOOP; break; }
    if ((areaMatch.subtype & BotMatchSubtype.REVERSE) !== 0) { flags = BotPatrolFlag.REVERSE; break; }
    if ((areaMatch.subtype & BotMatchSubtype.MORE) === 0) break;
    text = variable(context, areaMatch, BotMatchVariable.MORE);
  }
  if (points === null || points.next === null) {
    context.library.actions.sayTeam(state.client, "I need more key points to patrol\n");
    botFreeWaypoints(context, points);
    return false;
  }
  botFreeWaypoints(context, state.patrolPoints);
  state.patrolPoints = points;
  state.currentPatrolPoint = points;
  state.patrolFlags = flags;
  return true;
}

export function botAddressedToBot(context: GameAiContext, state: BotState, match: ChatMatch): boolean {
  const name = variable(context, match, BotMatchVariable.NETNAME);
  if (clientOnSameTeamFromName(context, state, name) < 0) return false;
  if ((match.subtype & BotMatchSubtype.ADDRESSED) !== 0) {
    let addressed = variable(context, match, BotMatchVariable.ADDRESSEE);
    const botName = clientName(context, state.client, 128);
    while (true) {
      const addressee = context.library.chat.findMatch(addressed, BotMatchContext.ADDRESSEE);
      if (addressee === null) break;
      if (addressee.type === BotMessage.EVERYONE) return true;
      const teammate = variable(context, addressee, BotMatchVariable.TEAMMATE);
      if (teammate.length !== 0 && (stringContains(botName, teammate, false) >= 0 || stringContains(state.subteam, teammate, false) >= 0)) return true;
      if (addressee.type !== BotMessage.MULTIPLENAMES) break;
      addressed = variable(context, addressee, BotMatchVariable.MORE);
    }
    return false;
  }
  const tell = context.library.chat.findMatch(match.text, BotMatchContext.REPLYCHAT);
  if ((tell === null || tell.type !== BotMessage.CHATTELL) && context.random() > f(1 / (numPlayersOnSameTeam(context, state) - 1))) return false;
  return true;
}

export function botGPSToPosition(context: GameAiContext, text: string): Vec3 {
  let offset = 0;
  const coordinate = (): number => {
    let number = 0;
    while (text.charAt(offset) === " ") offset++;
    const sign = text.charAt(offset) === "-" ? -1 : 1;
    if (sign === -1) offset++;
    while (offset < text.length && text.charAt(offset) !== "\0") {
      const character = text.charAt(offset++);
      if (character < "0" || character > "9") break;
      number = (Math.imul(number, 10) + character.charCodeAt(0) - 48) | 0;
    }
    const value = Math.imul(sign, number);
    context.game.options.engine.print(`${value}\n`);
    return f(value);
  };
  return vec3(coordinate(), coordinate(), coordinate());
}

function ordered(context: GameAiContext, state: BotState, client: number): void {
  state.decisionmaker = client;
  state.ordered = true;
  state.orderTime = f(context.time);
  state.teamMessageTime = f(context.time + f(2 * context.random()));
}

function locate(context: GameAiContext, client: number, goal: BotGoalState): void {
  goal.entity = -1;
  const info = botEntityInfo(context, client);
  if (!info.valid) return;
  const area = botPointAreaNum(context, info.origin);
  if (area === 0) return;
  goal.entity = client;
  goal.area = area;
  Object.assign(goal.origin, info.origin);
  Object.assign(goal.mins, vec3(-8, -8, -8));
  Object.assign(goal.maxs, vec3(8, 8, 8));
}

export function botMatchHelpAccompany(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const teammate = variable(context, match, BotMatchVariable.TEAMMATE);
  const teammateMatch = context.library.chat.findMatch(teammate, BotMatchContext.TEAMMATE);
  let netname: string | null = null;
  let client: number, other: boolean;
  if (teammateMatch !== null && teammateMatch.type === BotMessage.ME) {
    netname = variable(context, match, BotMatchVariable.NETNAME);
    client = clientFromName(context, netname);
    other = false;
  } else {
    client = findClientByName(context, teammate);
    if (client === state.client) other = false;
    else if (!botSameTeam(context, state, client)) return;
    else other = true;
  }
  if (client < 0) {
    if (netname === null) throw new Error("BotMatch_HelpAccompany reads an uninitialized source netname");
    botInitialChat(context, state, "whois", other ? teammate : netname);
    context.library.chat.enterChat(state.cs, clientFromName(context, netname), ChatDestination.Tell);
    return;
  }
  if (client === state.client) return;
  locate(context, client, state.teamGoal);
  if (state.teamGoal.entity < 0 && (match.subtype & BotMatchSubtype.NEARITEM) !== 0 &&
    !botGetMessageTeamGoal(context, state, variable(context, match, BotMatchVariable.ITEM), state.teamGoal)) return;
  if (state.teamGoal.entity < 0) {
    if (other) botInitialChat(context, state, "whereis", teammate);
    else {
      if (netname === null) throw new Error("BotMatch_HelpAccompany reads an uninitialized source netname");
      botInitialChat(context, state, "whereareyou", netname);
    }
    if (netname === null) throw new Error("BotMatch_HelpAccompany reads an uninitialized source reply recipient");
    context.library.chat.enterChat(state.cs, clientFromName(context, netname), ChatDestination.Team);
    return;
  }
  state.teammate = client;
  netname = variable(context, match, BotMatchVariable.NETNAME);
  client = clientFromName(context, netname);
  state.decisionmaker = client;
  state.ordered = true;
  state.orderTime = f(context.time);
  state.teammateVisibleTime = f(context.time);
  state.teamMessageTime = f(context.time + f(2 * context.random()));
  state.teamGoalTime = botGetTime(context, match);
  if (match.type === BotMessage.HELP) {
    state.ltgType = BotLongTermGoal.TEAMHELP;
    if (state.teamGoalTime === 0) state.teamGoalTime = f(context.time + TEAM_HELP_TIME);
  } else {
    state.ltgType = BotLongTermGoal.TEAMACCOMPANY;
    if (state.teamGoalTime === 0) state.teamGoalTime = f(context.time + TEAM_ACCOMPANY_TIME);
    state.formationDist = 112;
    state.arriveTime = 0;
    botSetTeamStatus(context, state);
    botRememberLastOrderedTask(context, state);
  }
}

export function botMatchDefendKeyArea(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  if (!botGetMessageTeamGoal(context, state, variable(context, match, BotMatchVariable.KEYAREA), state.teamGoal)) return;
  ordered(context, state, clientFromName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.DEFENDKEYAREA;
  state.teamGoalTime = botGetTime(context, match);
  if (state.teamGoalTime === 0) state.teamGoalTime = f(context.time + TEAM_DEFENDKEYAREA_TIME);
  state.defendAwayTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botMatchGetItem(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  if (!botGetMessageTeamGoal(context, state, variable(context, match, BotMatchVariable.ITEM), state.teamGoal)) return;
  ordered(context, state, clientOnSameTeamFromName(context, state, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.GETITEM;
  state.teamGoalTime = f(context.time + TEAM_GETITEM_TIME);
  botSetTeamStatus(context, state);
}

export function botMatchCamp(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const netname = variable(context, match, BotMatchVariable.NETNAME);
  const client = findClientByName(context, netname);
  if (client < 0) {
    botInitialChat(context, state, "whois", netname);
    context.library.chat.enterChat(state.cs, state.client, ChatDestination.Team);
    return;
  }
  const keyarea = variable(context, match, BotMatchVariable.KEYAREA);
  if ((match.subtype & BotMatchSubtype.THERE) !== 0) {
    state.teamGoal.entity = state.entityNum;
    state.teamGoal.area = state.areaNum;
    Object.assign(state.teamGoal.origin, state.origin);
    Object.assign(state.teamGoal.mins, vec3(-8, -8, -8));
    Object.assign(state.teamGoal.maxs, vec3(8, 8, 8));
  } else if ((match.subtype & BotMatchSubtype.HERE) !== 0) {
    if (client === state.client) return;
    locate(context, client, state.teamGoal);
    if (state.teamGoal.entity < 0) {
      botInitialChat(context, state, "whereareyou", netname);
      context.library.chat.enterChat(state.cs, clientFromName(context, netname), ChatDestination.Tell);
      return;
    }
  } else if (!botGetMessageTeamGoal(context, state, keyarea, state.teamGoal)) return;
  ordered(context, state, client);
  state.ltgType = BotLongTermGoal.CAMPORDER;
  state.teamGoalTime = botGetTime(context, match);
  if (state.teamGoalTime === 0) state.teamGoalTime = f(context.time + TEAM_CAMP_TIME);
  state.arriveTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botMatchPatrol(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match) || !botGetPatrolWaypoints(context, state, match)) return;
  ordered(context, state, findClientByName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.PATROL;
  state.teamGoalTime = botGetTime(context, match);
  if (state.teamGoalTime === 0) state.teamGoalTime = f(context.time + TEAM_PATROL_TIME);
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botMatchGetFlag(context: GameAiContext, state: BotState, match: ChatMatch): void {
  const goals = context.deathmatch;
  if (context.gameType === GameType.GT_CTF) {
    if (goals.ctfRedFlag.area === 0 || goals.ctfBlueFlag.area === 0) return;
  } else if (context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF) {
    if (goals.ctfNeutralFlag.area === 0 || goals.ctfRedFlag.area === 0 || goals.ctfBlueFlag.area === 0) return;
  } else return;
  if (!botAddressedToBot(context, state, match)) return;
  ordered(context, state, findClientByName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.GETFLAG;
  state.teamGoalTime = f(context.time + CTF_GETFLAG_TIME);
  if (context.gameType === GameType.GT_CTF) botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state));
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botMatchAttackEnemyBase(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType === GameType.GT_CTF) botMatchGetFlag(context, state, match);
  else if (context.game.options.product === "missionpack" && (context.gameType === GameType.GT_1FCTF || context.gameType === GameType.GT_OBELISK || context.gameType === GameType.GT_HARVESTER)) {
    if (context.deathmatch.redObelisk.area === 0 || context.deathmatch.blueObelisk.area === 0) return;
  } else return;
  // Source continues after GetFlag in CTF, including its second address check.
  if (!botAddressedToBot(context, state, match)) return;
  ordered(context, state, findClientByName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.ATTACKENEMYBASE;
  state.teamGoalTime = f(context.time + TEAM_ATTACKENEMYBASE_TIME);
  state.attackAwayTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botMatchHarvest(context: GameAiContext, state: BotState, match: ChatMatch): void {
  const goals = context.deathmatch;
  if (context.game.options.product !== "missionpack" || context.gameType !== GameType.GT_HARVESTER || goals.neutralObelisk.area === 0 || goals.redObelisk.area === 0 || goals.blueObelisk.area === 0) return;
  if (!botAddressedToBot(context, state, match)) return;
  ordered(context, state, findClientByName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.HARVEST;
  state.teamGoalTime = f(context.time + TEAM_HARVEST_TIME);
  state.harvestAwayTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botMatchRushBase(context: GameAiContext, state: BotState, match: ChatMatch): void {
  const goals = context.deathmatch;
  if (context.gameType === GameType.GT_CTF) {
    if (goals.ctfRedFlag.area === 0 || goals.ctfBlueFlag.area === 0) return;
  } else if (context.game.options.product === "missionpack" && (context.gameType === GameType.GT_1FCTF || context.gameType === GameType.GT_HARVESTER)) {
    if (goals.redObelisk.area === 0 || goals.blueObelisk.area === 0) return;
  } else return;
  if (!botAddressedToBot(context, state, match)) return;
  ordered(context, state, findClientByName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.RUSHBASE;
  state.teamGoalTime = f(context.time + CTF_RUSHBASE_TIME);
  state.rushBaseAwayTime = 0;
  botSetTeamStatus(context, state);
}

export function botMatchTaskPreference(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (folded(clientName(context, state.client, 36)) !== folded(state.teamLeader)) return;
  const teammate = clientFromName(context, variable(context, match, BotMatchVariable.NETNAME));
  if (teammate < 0) return;
  let preference = botGetTeamMateTaskPreference(context, state, teammate);
  switch (match.subtype) {
    case BotMatchSubtype.DEFENDER: preference = (preference & ~BotTeamTaskPreference.ATTACKER) | BotTeamTaskPreference.DEFENDER; break;
    case BotMatchSubtype.ATTACKER: preference = (preference & ~BotTeamTaskPreference.DEFENDER) | BotTeamTaskPreference.ATTACKER; break;
    case BotMatchSubtype.ROAMER: preference &= ~(BotTeamTaskPreference.ATTACKER | BotTeamTaskPreference.DEFENDER); break;
  }
  botSetTeamMateTaskPreference(context, state, teammate, preference);
  botInitialChat(context, state, "keepinmind", easyClientName(context, teammate, 256));
  context.library.chat.enterChat(state.cs, teammate, ChatDestination.Tell);
  botVoiceChatOnly(context, state, teammate, "yes");
  context.library.actions.action(state.client, BotActionFlag.AFFIRMATIVE);
}

export function botMatchReturnFlag(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType !== GameType.GT_CTF && !(context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF)) return;
  if (!botAddressedToBot(context, state, match)) return;
  ordered(context, state, findClientByName(context, variable(context, match, BotMatchVariable.NETNAME)));
  state.ltgType = BotLongTermGoal.RETURNFLAG;
  state.teamGoalTime = f(context.time + CTF_RETURNFLAG_TIME);
  state.rushBaseAwayTime = 0;
  botSetTeamStatus(context, state);
}

export function botMatchJoinSubteam(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const team = variable(context, match, BotMatchVariable.TEAMNAME);
  state.copySubteam(team);
  const name = variable(context, match, BotMatchVariable.NETNAME);
  botInitialChat(context, state, "joinedteam", team);
  context.library.chat.enterChat(state.cs, clientFromName(context, name), ChatDestination.Tell);
}

export function botMatchLeaveSubteam(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  if (state.subteam.length !== 0) {
    botInitialChat(context, state, "leftteam", state.subteam);
    context.library.chat.enterChat(state.cs, clientFromName(context, variable(context, match, BotMatchVariable.NETNAME)), ChatDestination.Tell);
  }
  state.clearSubteam();
}

export function botMatchWhichTeam(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  if (state.subteam.length !== 0) botInitialChat(context, state, "inteam", state.subteam);
  else botInitialChat(context, state, "noteam");
  context.library.chat.enterChat(state.cs, state.client, ChatDestination.Team);
}

export function botMatchCheckPoint(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM) return;
  const positionText = variable(context, match, BotMatchVariable.POSITION);
  const client = clientFromName(context, variable(context, match, BotMatchVariable.NETNAME));
  const scanned = scanGameVector(positionText);
  const position = vec3(scanned.x, scanned.y, f(scanned.z + 0.5));
  const area = botPointAreaNum(context, position);
  if (area === 0) {
    if (botAddressedToBot(context, state, match)) {
      botInitialChat(context, state, "checkpoint_invalid");
      context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
    }
    return;
  }
  const name = variable(context, match, BotMatchVariable.NAME);
  const old = botFindWayPoint(state.checkpoints, name);
  if (old !== null) {
    if (old.next !== null) old.next.prev = old.prev;
    if (old.prev !== null) old.prev.next = old.next;
    else state.checkpoints = old.next;
    old.inuse = false;
  }
  const checkpoint = botCreateWayPoint(context, name, position, area);
  if (checkpoint === null) throw new Error("BotMatch_CheckPoint exhausted the source waypoint heap");
  checkpoint.next = state.checkpoints;
  if (state.checkpoints !== null) state.checkpoints.prev = checkpoint;
  state.checkpoints = checkpoint;
  if (botAddressedToBot(context, state, match)) {
    const origin = checkpoint.goal.origin;
    botInitialChat(context, state, "checkpoint_confirm", checkpoint.name, gameFormat("%1.0f %1.0f %1.0f", [origin.x, origin.y, origin.z], 256));
    context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
  }
}

export function botMatchFormationSpace(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const value = gameAtof(variable(context, match, BotMatchVariable.NUMBER));
  let space = (match.subtype & BotMatchSubtype.FEET) !== 0 ? f(f(f(0.3048) * 32) * value) : f(32 * value);
  if (space < 48 || space > 500) space = 100;
  state.formationDist = space;
}

export function botMatchDismiss(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const client = clientFromName(context, variable(context, match, BotMatchVariable.NETNAME));
  state.decisionmaker = client;
  state.ltgType = 0;
  state.leadTime = 0;
  state.lastGoalLtgType = 0;
  botInitialChat(context, state, "dismissed");
  context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
}

export function botMatchSuicide(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  context.library.actions.command(state.client, "kill");
  botVoiceChat(context, state, clientFromName(context, variable(context, match, BotMatchVariable.NETNAME)), "taunt");
  context.library.actions.action(state.client, BotActionFlag.AFFIRMATIVE);
}

export function botMatchStartTeamLeaderShip(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM) return;
  if ((match.subtype & BotMatchSubtype.I) !== 0) {
    const name = variable(context, match, BotMatchVariable.NETNAME);
    state.copyTeamLeaderWithOverflow(name);
  } else {
    const client = findClientByName(context, variable(context, match, BotMatchVariable.TEAMMATE));
    if (client >= 0) copyClientNameToTeamLeader(context, state, client);
  }
}

export function botMatchStopTeamLeaderShip(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM) return;
  const teammate = variable(context, match, BotMatchVariable.TEAMMATE);
  const client = findClientByName(context, (match.subtype & BotMatchSubtype.I) !== 0 ? variable(context, match, BotMatchVariable.NETNAME) : teammate);
  if (client >= 0 && folded(state.teamLeader) === folded(clientName(context, client, 256))) {
    state.clearTeamLeader();
    context.command.notLeader[client] = true;
  }
}

export function botMatchWhoIsTeamLeader(context: GameAiContext, state: BotState, _match: ChatMatch): void {
  if (context.gameType >= GameType.GT_TEAM && folded(clientName(context, state.client, 256)) === folded(state.teamLeader)) {
    context.library.actions.sayTeam(state.client, "I'm the team leader\n");
  }
}

export function botMatchWhatAreYouDoing(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (!botAddressedToBot(context, state, match)) return;
  switch (state.ltgType) {
    case BotLongTermGoal.TEAMHELP: botInitialChat(context, state, "helping", easyClientName(context, state.teammate, 256)); break;
    case BotLongTermGoal.TEAMACCOMPANY: botInitialChat(context, state, "accompanying", easyClientName(context, state.teammate, 256)); break;
    case BotLongTermGoal.DEFENDKEYAREA: botInitialChat(context, state, "defending", context.library.goals.goalName(state.teamGoal.number).slice(0, 255)); break;
    case BotLongTermGoal.GETITEM: botInitialChat(context, state, "gettingitem", context.library.goals.goalName(state.teamGoal.number).slice(0, 255)); break;
    case BotLongTermGoal.KILL: botInitialChat(context, state, "killing", clientName(context, state.teamGoal.entity, 256)); break;
    case BotLongTermGoal.CAMP: case BotLongTermGoal.CAMPORDER: botInitialChat(context, state, "camping"); break;
    case BotLongTermGoal.PATROL: botInitialChat(context, state, "patrolling"); break;
    case BotLongTermGoal.GETFLAG: botInitialChat(context, state, "capturingflag"); break;
    case BotLongTermGoal.RUSHBASE: botInitialChat(context, state, "rushingbase"); break;
    case BotLongTermGoal.RETURNFLAG: botInitialChat(context, state, "returningflag"); break;
    case BotLongTermGoal.ATTACKENEMYBASE: botInitialChat(context, state, context.game.options.product === "missionpack" ? "attackingenemybase" : "roaming"); break;
    case BotLongTermGoal.HARVEST: botInitialChat(context, state, context.game.options.product === "missionpack" ? "harvesting" : "roaming"); break;
    default: botInitialChat(context, state, "roaming"); break;
  }
  context.library.chat.enterChat(state.cs, clientFromName(context, variable(context, match, BotMatchVariable.NETNAME)), ChatDestination.Tell);
}

export function botMatchWhatIsMyCommand(context: GameAiContext, state: BotState, _match: ChatMatch): void {
  if (folded(clientName(context, state.client, 36)) === folded(state.teamLeader)) state.forceOrders = true;
}

export function botNearestVisibleItem(context: GameAiContext, state: BotState, name: string, goal: BotGoalState): number {
  let bestDistance = 999999;
  let index = -1;
  const candidate = new BotGoalState();
  while (true) {
    const item = context.library.goals.getLevelItemGoal(index, name, candidate);
    if (item === null) break;
    candidate.copyFrom(item);
    index = item.number;
    if (folded(context.library.goals.goalName(candidate.number).slice(0, 63)) === folded(name)) {
      const distance = length3(sub3(candidate.origin, state.origin));
      if (distance < bestDistance) {
        const trace = context.game.world.trace({ start: state.eye, end: candidate.origin,
          shape: { kind: "point" }, passEntityNum: state.client, mask: 1 | 0x10000 });
        if (trace.fraction >= 1) { bestDistance = distance; goal.copyFrom(candidate); }
      }
    }
    if (index <= 0) break;
  }
  return f(bestDistance);
}

export function botMatchWhereAreYou(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const items = ["Shotgun", "Grenade Launcher", "Rocket Launcher", "Plasmagun", "Railgun", "Lightning Gun", "BFG10K",
    "Quad Damage", "Regeneration", "Battle Suit", "Speed", "Invisibility", "Flight", "Armor", "Heavy Armor", "Red Flag", "Blue Flag"];
  if (context.game.options.product === "missionpack") items.push("Nailgun", "Prox Launcher", "Chaingun", "Scout", "Guard", "Doubler", "Ammo Regen", "Neutral Flag", "Red Obelisk", "Blue Obelisk", "Neutral Obelisk");
  let nearest: string | null = null, bestDistance = 999999;
  const goal = new BotGoalState();
  for (const name of items) {
    const distance = botNearestVisibleItem(context, state, name, goal);
    if (distance < bestDistance) { bestDistance = distance; nearest = name; }
  }
  if (nearest === null) return;
  let red = 0, blue = 0;
  const flags = context.gameType === GameType.GT_CTF || context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF;
  const obelisks = context.game.options.product === "missionpack" && (context.gameType === GameType.GT_OBELISK || context.gameType === GameType.GT_HARVESTER);
  if (flags || obelisks) {
    const phase = context.library.aas.phase;
    if (phase.kind !== "loaded" && phase.kind !== "ready") throw new Error("BotMatch_WhereAreYou requires loaded AAS routing");
    const goals = context.deathmatch;
    red = phase.map.routing.areaTravelTimeToGoal({ area: state.areaNum, origin: state.origin,
      goalArea: flags ? goals.ctfRedFlag.area : goals.redObelisk.area, travelFlags: TravelFlags.DEFAULT });
    blue = phase.map.routing.areaTravelTimeToGoal({ area: state.areaNum, origin: state.origin,
      goalArea: flags ? goals.ctfBlueFlag.area : goals.blueObelisk.area, travelFlags: TravelFlags.DEFAULT });
  }
  if (red < f((red + blue) * f(0.4))) botInitialChat(context, state, "teamlocation", nearest, "red");
  else if (blue < f((red + blue) * f(0.4))) botInitialChat(context, state, "teamlocation", nearest, "blue");
  else botInitialChat(context, state, "location", nearest);
  context.library.chat.enterChat(state.cs, clientFromName(context, variable(context, match, BotMatchVariable.NETNAME)), ChatDestination.Tell);
}

export function botMatchLeadTheWay(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  let netname: string | null = null, teammate: string | null = null;
  let client: number, other: boolean;
  if ((match.subtype & BotMatchSubtype.SOMEONE) !== 0) {
    teammate = variable(context, match, BotMatchVariable.TEAMMATE);
    client = findClientByName(context, teammate);
    if (client === state.client) other = false;
    else if (!botSameTeam(context, state, client)) return;
    else other = true;
  } else {
    netname = variable(context, match, BotMatchVariable.NETNAME);
    client = clientFromName(context, netname);
    other = false;
  }
  if (client < 0) {
    if (netname === null) throw new Error("BotMatch_LeadTheWay reads an uninitialized source netname");
    botInitialChat(context, state, "whois", netname);
    context.library.chat.enterChat(state.cs, state.client, ChatDestination.Team);
    return;
  }
  locate(context, client, state.leadTeamGoal);
  // Source checks teamgoal here, after writing lead_teamgoal.
  if (state.teamGoal.entity < 0) {
    const name = other ? teammate : netname;
    if (name === null) throw new Error("BotMatch_LeadTheWay reads an uninitialized source teammate name");
    botInitialChat(context, state, other ? "whereis" : "whereareyou", name);
    context.library.chat.enterChat(state.cs, state.client, ChatDestination.Team);
    return;
  }
  state.leadTeammate = client;
  state.leadTime = f(context.time + TEAM_LEAD_TIME);
  state.leadVisibleTime = 0;
  state.leadMessageTime = f(-f(context.time + f(2 * context.random())));
}

export function botMatchKill(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType < GameType.GT_TEAM || !botAddressedToBot(context, state, match)) return;
  const enemy = variable(context, match, BotMatchVariable.ENEMY);
  const client = findEnemyByName(context, state, enemy);
  if (client < 0) {
    botInitialChat(context, state, "whois", enemy);
    context.library.chat.enterChat(state.cs, clientFromName(context, variable(context, match, BotMatchVariable.NETNAME)), ChatDestination.Tell);
    return;
  }
  state.teamGoal.entity = client;
  state.teamMessageTime = f(context.time + f(2 * context.random()));
  state.ltgType = BotLongTermGoal.KILL;
  state.teamGoalTime = f(context.time + TEAM_KILL_SOMEONE);
  botSetTeamStatus(context, state);
}

export function botMatchCTF(context: GameAiContext, state: BotState, match: ChatMatch): void {
  if (context.gameType === GameType.GT_CTF) {
    const flag = variable(context, match, BotMatchVariable.FLAG, 128);
    if ((match.subtype & BotMatchSubtype.GOTFLAG) !== 0) {
      if (folded(flag) === "RED") {
        state.redFlagStatus = 1;
        if (botTeam(context, state) === Team.TEAM_BLUE) state.flagCarrier = clientFromName(context, variable(context, match, BotMatchVariable.NETNAME, 36));
      } else {
        state.blueFlagStatus = 1;
        if (botTeam(context, state) === Team.TEAM_RED) state.flagCarrier = clientFromName(context, variable(context, match, BotMatchVariable.NETNAME, 36));
      }
      state.flagStatusChanged = true;
      state.lastFlagCaptureTime = f(context.time);
    } else if ((match.subtype & BotMatchSubtype.CAPTUREDFLAG) !== 0) {
      state.redFlagStatus = 0;
      state.blueFlagStatus = 0;
      state.flagCarrier = 0;
      state.flagStatusChanged = true;
    } else if ((match.subtype & BotMatchSubtype.RETURNEDFLAG) !== 0) {
      if (folded(flag) === "RED") state.redFlagStatus = 0;
      else state.blueFlagStatus = 0;
      state.flagStatusChanged = true;
    }
  } else if (context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF && (match.subtype & BotMatchSubtype.ONEFLAG_CTF_GOTFLAG) !== 0) {
    state.flagCarrier = clientFromName(context, variable(context, match, BotMatchVariable.NETNAME, 36));
  }
}

export function botMatchEnterGame(context: GameAiContext, _state: BotState, match: ChatMatch): void {
  const client = findClientByName(context, variable(context, match, BotMatchVariable.NETNAME, 36));
  if (client >= 0) context.command.notLeader[client] = false;
}

export function botMatchNewLeader(context: GameAiContext, state: BotState, match: ChatMatch): void {
  const name = variable(context, match, BotMatchVariable.NETNAME, 36);
  if (!botSameTeam(context, state, findClientByName(context, name))) return;
  state.copyTeamLeader(name);
}

export function botMatchMessage(context: GameAiContext, state: BotState, message: string): boolean {
  const match = context.library.chat.findMatch(message, BotMatchContext.MISC | BotMatchContext.INITIALTEAMCHAT | BotMatchContext.CTF);
  if (match === null) return false;
  switch (match.type) {
    case BotMessage.HELP: case BotMessage.ACCOMPANY: botMatchHelpAccompany(context, state, match); break;
    case BotMessage.DEFENDKEYAREA: botMatchDefendKeyArea(context, state, match); break;
    case BotMessage.CAMP: botMatchCamp(context, state, match); break;
    case BotMessage.PATROL: botMatchPatrol(context, state, match); break;
    case BotMessage.GETFLAG: botMatchGetFlag(context, state, match); break;
    case BotMessage.ATTACKENEMYBASE:
      if (context.game.options.product === "missionpack") botMatchAttackEnemyBase(context, state, match);
      else context.game.options.engine.print("unknown match type\n");
      break;
    case BotMessage.HARVEST:
      if (context.game.options.product === "missionpack") botMatchHarvest(context, state, match);
      else context.game.options.engine.print("unknown match type\n");
      break;
    case BotMessage.RUSHBASE: botMatchRushBase(context, state, match); break;
    case BotMessage.RETURNFLAG: botMatchReturnFlag(context, state, match); break;
    case BotMessage.TASKPREFERENCE: botMatchTaskPreference(context, state, match); break;
    case BotMessage.CTF: botMatchCTF(context, state, match); break;
    case BotMessage.GETITEM: botMatchGetItem(context, state, match); break;
    case BotMessage.JOINSUBTEAM: botMatchJoinSubteam(context, state, match); break;
    case BotMessage.LEAVESUBTEAM: botMatchLeaveSubteam(context, state, match); break;
    case BotMessage.WHICHTEAM: botMatchWhichTeam(context, state, match); break;
    case BotMessage.CHECKPOINT: botMatchCheckPoint(context, state, match); break;
    case BotMessage.CREATENEWFORMATION: case BotMessage.FORMATIONPOSITION:
      context.library.actions.sayTeam(state.client, "the part of my brain to create formations has been damaged"); break;
    case BotMessage.FORMATIONSPACE: botMatchFormationSpace(context, state, match); break;
    case BotMessage.DOFORMATION: case BotMessage.WAIT: break;
    case BotMessage.DISMISS: botMatchDismiss(context, state, match); break;
    case BotMessage.STARTTEAMLEADERSHIP: botMatchStartTeamLeaderShip(context, state, match); break;
    case BotMessage.STOPTEAMLEADERSHIP: botMatchStopTeamLeaderShip(context, state, match); break;
    case BotMessage.WHOISTEAMLAEDER: botMatchWhoIsTeamLeader(context, state, match); break;
    case BotMessage.WHATAREYOUDOING: botMatchWhatAreYouDoing(context, state, match); break;
    case BotMessage.WHATISMYCOMMAND: botMatchWhatIsMyCommand(context, state, match); break;
    case BotMessage.WHEREAREYOU: botMatchWhereAreYou(context, state, match); break;
    case BotMessage.LEADTHEWAY: botMatchLeadTheWay(context, state, match); break;
    case BotMessage.KILL: botMatchKill(context, state, match); break;
    case BotMessage.ENTERGAME: botMatchEnterGame(context, state, match); break;
    case BotMessage.NEWLEADER: botMatchNewLeader(context, state, match); break;
    case BotMessage.SUICIDE: botMatchSuicide(context, state, match); break;
    default: context.game.options.engine.print("unknown match type\n"); break;
  }
  return true;
}
