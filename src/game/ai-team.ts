// Ported from id Software's code/game/ai_team.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { ChatDestination } from "../botlib/chat.ts";
import type { BotGoal } from "../botlib/goals.ts";
import { TravelFlags } from "../botlib/routing.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { GameType, Team } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { botInitialChat } from "./ai-chat.ts";
import type { GameAiContext } from "./ai-context.ts";
import { BotCtfStrategy, BotTeamTaskPreference } from "./ai-definitions.ts";
import { botPointAreaNum } from "./ai-navigation.ts";
import { botSameTeam, botSetLastOrderedTask, botTeam, clientFromName, clientName, copyClientNameToTeamLeader } from "./ai-orders.ts";
import type { BotState } from "./ai-state.ts";
import { botVoiceChatDefend } from "./ai-voice.ts";
import { gameAtoi } from "./numeric.ts";
import { MAX_CLIENTS } from "./state.ts";

const CS_PLAYERS = 544;
const f = Math.fround;

export class GameAiTeamState {
  readonly taskPreferences = Array.from({ length: MAX_CLIENTS }, () => ({ name: "", preference: 0 }));
  numTeamMatesMaxClients = 0;
  sortTeamMatesMaxClients = 0;
  teamOrdersMaxClients = 0;
  clientFromNameMaxClients = 0;
  clientOnSameTeamFromNameMaxClients = 0;
}

function element<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Bot team source array index ${index} is outside ${values.length} populated entries`);
  return value;
}

function teamMates(context: GameAiContext, state: BotState, maximum: number): number[] {
  const teammates: number[] = [];
  for (let i = 0; i < maximum && i < MAX_CLIENTS; i++) {
    const info = context.game.options.configstrings.get(CS_PLAYERS + i).slice(0, 1023);
    if (info.length === 0 || infoValueForKey(info, "n").length === 0 || gameAtoi(infoValueForKey(info, "t")) === Team.TEAM_SPECTATOR) continue;
    if (botSameTeam(context, state, i)) teammates.push(i);
  }
  return teammates;
}

export function botValidTeamLeader(context: GameAiContext, state: BotState): boolean {
  return state.teamLeader.length !== 0 && clientFromName(context, state.teamLeader) !== -1;
}

export function botNumTeamMates(context: GameAiContext, state: BotState): number {
  if (context.team.numTeamMatesMaxClients === 0) context.team.numTeamMatesMaxClients = context.game.options.cvars.get("sv_maxclients")?.integerValue ?? 0;
  return teamMates(context, state, context.team.numTeamMatesMaxClients).length;
}

export function botClientTravelTimeToGoal(context: GameAiContext, client: number, goal: BotGoal): number {
  const ps = context.getClientState(client);
  if (ps === null) throw new Error(`BotClientTravelTimeToGoal would read an uninitialized player state for client ${client}`);
  const area = botPointAreaNum(context, ps.origin);
  if (area === 0) return 1;
  const phase = context.library.aas.phase;
  if (phase.kind !== "ready" && phase.kind !== "loaded") return 0;
  return phase.map.routing.areaTravelTimeToGoal({ area, origin: ps.origin, goalArea: goal.area, travelFlags: TravelFlags.DEFAULT });
}

export function botSortTeamMatesByBaseTravelTime(context: GameAiContext, state: BotState, teammates: number[], maximum: number): number {
  const red = botTeam(context, state) === Team.TEAM_RED;
  const goal = context.gameType === GameType.GT_CTF || context.gameType === GameType.GT_1FCTF ?
    (red ? context.deathmatch.ctfRedFlag : context.deathmatch.ctfBlueFlag) :
    (red ? context.deathmatch.redObelisk : context.deathmatch.blueObelisk);
  if (state.product !== "missionpack" && context.gameType !== GameType.GT_CTF && context.gameType !== GameType.GT_1FCTF) {
    throw new Error("BotSortTeamMatesByBaseTravelTime has no source base goal in this base-game mode");
  }
  if (context.team.sortTeamMatesMaxClients === 0) context.team.sortTeamMatesMaxClients = context.game.options.cvars.get("sv_maxclients")?.integerValue ?? 0;
  const times: number[] = [];
  let count = 0;
  for (const client of teamMates(context, state, context.team.sortTeamMatesMaxClients)) {
    const time = botClientTravelTimeToGoal(context, client, goal);
    let at = 0;
    while (at < count && time >= element(times, at)) at++;
    for (let index = count; index > at; index--) {
      times[index] = element(times, index - 1);
      teammates[index] = element(teammates, index - 1);
    }
    times[at] = time; teammates[at] = client; count++;
    if (count >= maximum) break;
  }
  return count;
}

export function botSetTeamMateTaskPreference(context: GameAiContext, _state: BotState, teammate: number, preference: number): void {
  const entry = element(context.team.taskPreferences, teammate);
  entry.preference = preference;
  entry.name = clientName(context, teammate);
}

export function botGetTeamMateTaskPreference(context: GameAiContext, _state: BotState, teammate: number): number {
  const entry = element(context.team.taskPreferences, teammate);
  if (entry.preference === 0) return 0;
  return clientName(context, teammate).toLowerCase() === entry.name.toLowerCase() ? entry.preference : 0;
}

export function botSortTeamMatesByTaskPreference(context: GameAiContext, state: BotState, teammates: number[], count: number): number {
  const defenders: number[] = [], attackers: number[] = [], roamers: number[] = [];
  for (let i = 0; i < count; i++) {
    const teammate = element(teammates, i), preference = botGetTeamMateTaskPreference(context, state, teammate);
    if ((preference & BotTeamTaskPreference.DEFENDER) !== 0) defenders.push(teammate);
    else if ((preference & BotTeamTaskPreference.ATTACKER) !== 0) attackers.push(teammate);
    else roamers.push(teammate);
  }
  let next = 0;
  for (const teammate of [...defenders, ...roamers, ...attackers]) teammates[next++] = teammate;
  return next;
}

export function botSayTeamOrderAlways(context: GameAiContext, state: BotState, client: number): void {
  if (state.client === client) {
    const text = context.library.chat.getChatMessage(state.cs, 256), name = clientName(context, state.client);
    const message = `\x19(${name}\x19)\x19: ${text}`;
    if (message.length >= 256) context.game.options.engine.print(`Com_sprintf: overflow of ${message.length} in 256\n`);
    context.library.chat.queueConsoleMessage(state.cs, 1, message.slice(0, 255));
  } else context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
}

export function botSayTeamOrder(context: GameAiContext, state: BotState, client: number): void {
  if (state.product === "missionpack") context.library.chat.getChatMessage(state.cs, 256);
  else botSayTeamOrderAlways(context, state, client);
}

export function botVoiceChat(context: GameAiContext, state: BotState, client: number, voice: string): void {
  if (state.product === "missionpack") context.library.actions.command(state.client, client === -1 ? `vsay_team ${voice}` : `vtell ${client} ${voice}`);
}

export function botVoiceChatOnly(context: GameAiContext, state: BotState, client: number, voice: string): void {
  if (state.product === "missionpack") context.library.actions.command(state.client, client === -1 ? `vosay_team ${voice}` : `votell ${client} ${voice}`);
}

export function botSayVoiceTeamOrder(context: GameAiContext, state: BotState, client: number, voice: string): void {
  if (state.product === "missionpack") botVoiceChat(context, state, client, voice);
}

function sortedTeamMates(context: GameAiContext, state: BotState): number[] {
  const teammates: number[] = [];
  const count = botSortTeamMatesByBaseTravelTime(context, state, teammates, MAX_CLIENTS * 4);
  botSortTeamMatesByTaskPreference(context, state, teammates, count);
  return teammates;
}

function issue(context: GameAiContext, state: BotState, teammate: number, chat: string, voice: string,
  voiceClient = teammate, voiceFirst = false): void {
  botInitialChat(context, state, chat, clientName(context, teammate), null);
  if (voiceFirst) botSayVoiceTeamOrder(context, state, voiceClient, voice);
  botSayTeamOrder(context, state, teammate);
  if (!voiceFirst) botSayVoiceTeamOrder(context, state, voiceClient, voice);
}

function followCarrier(context: GameAiContext, state: BotState, teammate: number, carrierName: string): void {
  const name = clientName(context, teammate);
  if (state.flagCarrier === state.client) {
    botInitialChat(context, state, "cmd_accompanyme", name, null);
    botSayVoiceTeamOrder(context, state, teammate, "followme");
  } else {
    botInitialChat(context, state, "cmd_accompany", name, carrierName, null);
    botSayVoiceTeamOrder(context, state, teammate, "followflagcarrier");
  }
  botSayTeamOrder(context, state, teammate);
}

function countRole(count: number, fraction: number, maximum: number): number {
  return Math.min(Math.trunc(count * fraction + 0.5), maximum);
}

function aggressive(state: BotState): boolean { return (state.ctfStrategy & BotCtfStrategy.AGRESSIVE) !== 0; }

export function botCTFOrdersBothFlagsNotAtBase(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length;
  if (state.numTeammates === 1) return;
  if (state.numTeammates === 2) {
    const other = element(teammates, element(teammates, 0) !== state.flagCarrier ? 0 : 1);
    issue(context, state, other, "cmd_getflag", "getflag"); return;
  }
  if (state.numTeammates === 3) {
    const first = element(teammates, element(teammates, 0) !== state.flagCarrier ? 0 : 1);
    if (state.flagCarrier !== -1) followCarrier(context, state, first, clientName(context, state.flagCarrier));
    else issue(context, state, first, "cmd_getflag", "getflag", first, true);
    const last = element(teammates, element(teammates, 2) !== state.flagCarrier ? 2 : 1);
    issue(context, state, last, "cmd_getflag", "returnflag"); return;
  }
  const defenders = countRole(count, 0.4, 4), attackers = countRole(count, 0.5, 5);
  const carrierName = state.flagCarrier === -1 ? "" : clientName(context, state.flagCarrier);
  for (let i = 0; i < defenders; i++) {
    const teammate = element(teammates, i);
    if (teammate === state.flagCarrier) continue;
    if (state.flagCarrier !== -1) followCarrier(context, state, teammate, carrierName);
    else issue(context, state, teammate, "cmd_getflag", "getflag", teammate, true);
  }
  for (let i = 0; i < attackers; i++) {
    const teammate = element(teammates, count - i - 1);
    if (teammate !== state.flagCarrier) issue(context, state, teammate, "cmd_getflag", "returnflag");
  }
}

export function botCTFOrdersFlagNotAtBase(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (state.numTeammates === 1) return;
  if (state.numTeammates === 2) {
    issue(context, state, element(teammates, 0), attack ? "cmd_getflag" : "cmd_defendbase", "getflag");
    issue(context, state, element(teammates, 1), "cmd_getflag", "getflag"); return;
  }
  if (state.numTeammates === 3) {
    issue(context, state, element(teammates, 0), "cmd_defendbase", attack ? "getflag" : "defend");
    issue(context, state, element(teammates, 1), "cmd_getflag", "getflag");
    issue(context, state, element(teammates, 2), "cmd_getflag", "getflag"); return;
  }
  const defenders = countRole(count, attack ? 0.2 : 0.3, attack ? 2 : 3), attackers = countRole(count, 0.7, attack ? 7 : 6);
  for (let i = 0; i < defenders; i++) issue(context, state, element(teammates, i), "cmd_defendbase", "defend");
  for (let i = 0; i < attackers; i++) {
    const teammate = element(teammates, count - i - 1);
    issue(context, state, teammate, "cmd_getflag", "getflag", attack ? teammate : element(teammates, 0));
  }
}

export function botCTFOrdersEnemyFlagNotAtBase(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length;
  if (count === 1) return;
  if (count === 2 || count === 3) {
    issue(context, state, element(teammates, element(teammates, 0) === state.flagCarrier ? 1 : 0), "cmd_defendbase", "defend");
    if (count === 3) issue(context, state, element(teammates, element(teammates, 2) !== state.flagCarrier ? 2 : 1), "cmd_defendbase", "defend");
    return;
  }
  const defenders = countRole(count, 0.6, 6), attackers = countRole(count, 0.3, 3);
  for (let i = 0; i < defenders; i++) {
    const teammate = element(teammates, i);
    if (teammate !== state.flagCarrier) issue(context, state, teammate, "cmd_defendbase", "defend");
  }
  const carrierName = state.flagCarrier === -1 ? "" : clientName(context, state.flagCarrier);
  for (let i = 0; i < attackers; i++) {
    const teammate = element(teammates, count - i - 1);
    if (teammate === state.flagCarrier) continue;
    if (state.flagCarrier !== -1) followCarrier(context, state, teammate, carrierName);
    else issue(context, state, teammate, "cmd_getflag", "getflag", teammate, true);
  }
}

export function botCTFOrdersBothFlagsAtBase(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (count === 1) return;
  if (count === 2 || count === 3) {
    issue(context, state, element(teammates, 0), "cmd_defendbase", "defend");
    if (count === 3) issue(context, state, element(teammates, 1), attack ? "cmd_getflag" : "cmd_defendbase", attack ? "getflag" : "defend");
    issue(context, state, element(teammates, count - 1), "cmd_getflag", "getflag"); return;
  }
  const defenders = countRole(count, attack ? 0.4 : 0.5, attack ? 4 : 5), attackers = countRole(count, attack ? 0.5 : 0.4, attack ? 5 : 4);
  for (let i = 0; i < defenders; i++) issue(context, state, element(teammates, i), "cmd_defendbase", "defend");
  for (let i = 0; i < attackers; i++) issue(context, state, element(teammates, count - i - 1), "cmd_getflag", "getflag");
}

export function botCTFOrders(context: GameAiContext, state: BotState): void {
  const status = botTeam(context, state) === Team.TEAM_RED ? state.redFlagStatus * 2 + state.blueFlagStatus : state.blueFlagStatus * 2 + state.redFlagStatus;
  switch (status) {
    case 0: botCTFOrdersBothFlagsAtBase(context, state); break;
    case 1: botCTFOrdersEnemyFlagNotAtBase(context, state); break;
    case 2: botCTFOrdersFlagNotAtBase(context, state); break;
    case 3: botCTFOrdersBothFlagsNotAtBase(context, state); break;
  }
}

export function botCreateGroup(context: GameAiContext, state: BotState, teammates: readonly number[], groupSize: number): void {
  const leader = element(teammates, 0), leaderName = clientName(context, leader);
  for (let i = 1; i < groupSize; i++) {
    const teammate = element(teammates, i), name = clientName(context, teammate);
    if (leader === state.client) botInitialChat(context, state, "cmd_accompanyme", name, null);
    else botInitialChat(context, state, "cmd_accompany", name, leaderName, null);
    botSayTeamOrderAlways(context, state, teammate);
  }
}

export function botTeamOrders(context: GameAiContext, state: BotState): void {
  if (context.team.teamOrdersMaxClients === 0) context.team.teamOrdersMaxClients = context.game.options.cvars.get("sv_maxclients")?.integerValue ?? 0;
  const teammates = teamMates(context, state, context.team.teamOrdersMaxClients), count = teammates.length;
  switch (count) {
    case 1: case 2: break;
    case 3: botCreateGroup(context, state, teammates, 2); break;
    case 4: botCreateGroup(context, state, teammates, 2); botCreateGroup(context, state, teammates.slice(2), 2); break;
    case 5: botCreateGroup(context, state, teammates, 2); botCreateGroup(context, state, teammates.slice(2), 3); break;
    default:
      if (count <= 10) for (let i = 0; i < Math.trunc(count / 2); i++) botCreateGroup(context, state, teammates.slice(i * 2), 2);
      break;
  }
}

export function bot1FCTFOrdersFlagAtCenter(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (count === 1) return;
  if (count === 2 || count === 3) {
    issue(context, state, element(teammates, 0), "cmd_defendbase", "defend");
    if (count === 3) issue(context, state, element(teammates, 1), attack ? "cmd_getflag" : "cmd_defendbase", attack ? "getflag" : "defend", element(teammates, attack ? 1 : 0));
    issue(context, state, element(teammates, count - 1), "cmd_getflag", "getflag"); return;
  }
  const defenders = countRole(count, attack ? 0.3 : 0.5, attack ? 3 : 5), attackers = countRole(count, attack ? 0.6 : 0.4, attack ? 6 : 4);
  for (let i = 0; i < defenders; i++) issue(context, state, element(teammates, i), "cmd_defendbase", "defend");
  for (let i = 0; i < attackers; i++) issue(context, state, element(teammates, count - i - 1), "cmd_getflag", "getflag");
}

export function bot1FCTFOrdersTeamHasFlag(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (count === 1) return;
  if (count === 2) {
    const other = element(teammates, element(teammates, 0) === state.flagCarrier ? 1 : 0);
    issue(context, state, other, attack ? "cmd_defendbase" : "cmd_attackenemybase", attack ? "defend" : "offense"); return;
  }
  if (count === 3) {
    issue(context, state, element(teammates, element(teammates, 0) !== state.flagCarrier ? 0 : 1), "cmd_defendbase", "defend");
    const other = element(teammates, element(teammates, 2) !== state.flagCarrier ? 2 : 1);
    if (attack || state.flagCarrier !== -1) followCarrier(context, state, other, clientName(context, state.flagCarrier));
    else issue(context, state, other, "cmd_getflag", "getflag", other, true);
    return;
  }
  const defenders = countRole(count, attack ? 0.2 : 0.3, attack ? 2 : 3), attackers = countRole(count, attack ? 0.8 : 0.7, attack ? 8 : 7);
  for (let i = 0; i < defenders; i++) {
    const teammate = element(teammates, i);
    if (teammate !== state.flagCarrier) issue(context, state, teammate, "cmd_defendbase", "defend");
  }
  const carrierName = attack || state.flagCarrier !== -1 ? clientName(context, state.flagCarrier) : "";
  for (let i = 0; i < attackers; i++) {
    const teammate = element(teammates, count - i - 1);
    if (teammate === state.flagCarrier) continue;
    if (attack || state.flagCarrier !== -1) followCarrier(context, state, teammate, carrierName);
    else issue(context, state, teammate, "cmd_getflag", "getflag");
  }
}

export function bot1FCTFOrdersEnemyHasFlag(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (count === 1) return;
  if (count === 2 || count === 3) {
    issue(context, state, element(teammates, 0), "cmd_defendbase", "defend");
    issue(context, state, element(teammates, 1), "cmd_defendbase", "defend");
    if (count === 3) issue(context, state, element(teammates, 2), attack ? "cmd_returnflag" : "cmd_defendbase", attack ? "getflag" : "defend");
    return;
  }
  const defenders = countRole(count, attack ? 0.7 : 0.8, 8), attackers = countRole(count, attack ? 0.2 : 0.1, 2);
  for (let i = 0; i < defenders; i++) issue(context, state, element(teammates, i), "cmd_defendbase", "defend");
  for (let i = 0; i < attackers; i++) issue(context, state, element(teammates, count - i - 1), "cmd_returnflag", "getflag");
}

export function bot1FCTFOrdersEnemyDroppedFlag(context: GameAiContext, state: BotState): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (count === 1) return;
  if (count === 2 || count === 3) {
    issue(context, state, element(teammates, 0), "cmd_defendbase", "defend");
    if (count === 3) issue(context, state, element(teammates, 1), attack ? "cmd_getflag" : "cmd_defendbase", attack ? "getflag" : "defend");
    issue(context, state, element(teammates, count - 1), "cmd_getflag", "getflag"); return;
  }
  const defenders = countRole(count, attack ? 0.3 : 0.5, attack ? 3 : 5), attackers = countRole(count, attack ? 0.6 : 0.4, attack ? 6 : 4);
  for (let i = 0; i < defenders; i++) issue(context, state, element(teammates, i), "cmd_defendbase", "defend");
  for (let i = 0; i < attackers; i++) issue(context, state, element(teammates, count - i - 1), "cmd_getflag", attack ? "defend" : "getflag");
}

export function bot1FCTFOrders(context: GameAiContext, state: BotState): void {
  switch (state.neutralFlagStatus) {
    case 0: bot1FCTFOrdersFlagAtCenter(context, state); break;
    case 1: bot1FCTFOrdersTeamHasFlag(context, state); break;
    case 2: bot1FCTFOrdersEnemyHasFlag(context, state); break;
    case 3: bot1FCTFOrdersEnemyDroppedFlag(context, state); break;
  }
}

function obeliskOrHarvesterOrders(context: GameAiContext, state: BotState, attackCommand: string): void {
  const teammates = sortedTeamMates(context, state), count = teammates.length, attack = aggressive(state);
  if (count === 1) return;
  if (count === 2 || count === 3) {
    issue(context, state, element(teammates, 0), "cmd_defendbase", "defend");
    if (count === 3) issue(context, state, element(teammates, 1), attack ? attackCommand : "cmd_defendbase", attack ? "offense" : "defend");
    issue(context, state, element(teammates, count - 1), attackCommand, "offense"); return;
  }
  const defenders = countRole(count, attack ? 0.3 : 0.5, attack ? 3 : 5), attackers = countRole(count, attack ? 0.7 : 0.4, attack ? 7 : 4);
  for (let i = 0; i < defenders; i++) issue(context, state, element(teammates, i), "cmd_defendbase", "defend");
  for (let i = 0; i < attackers; i++) issue(context, state, element(teammates, count - i - 1), attackCommand, "offense");
}

export function botObeliskOrders(context: GameAiContext, state: BotState): void { obeliskOrHarvesterOrders(context, state, "cmd_attackenemybase"); }
export function botHarvesterOrders(context: GameAiContext, state: BotState): void { obeliskOrHarvesterOrders(context, state, "cmd_harvest"); }

export function findHumanTeamLeader(context: GameAiContext, state: BotState): boolean {
  for (let i = 0; i < MAX_CLIENTS; i++) {
    const entity = context.game.pool.at(i);
    if (entity.inuse && (entity.r.svFlags & ServerEntityFlags.BOT) === 0 && !element(context.command.notLeader, i) && botSameTeam(context, state, i)) {
      copyClientNameToTeamLeader(context, state, i);
      if (!botSetLastOrderedTask(context, state)) botVoiceChatDefend(context, state, i, 2);
      return true;
    }
  }
  return false;
}

export function botTeamAI(context: GameAiContext, state: BotState): void {
  if (context.gameType < GameType.GT_TEAM) return;
  if (!botValidTeamLeader(context, state) && !findHumanTeamLeader(context, state)) {
    if (state.askTeamLeaderTime === 0 && state.becomeTeamLeaderTime === 0) {
      if (f(state.enterGameTime + 10) > context.time) state.askTeamLeaderTime = f(f(context.time + 5) + f(context.random() * 10));
      else state.becomeTeamLeaderTime = f(f(context.time + 5) + f(context.random() * 10));
    }
    if (state.askTeamLeaderTime !== 0 && state.askTeamLeaderTime < context.time) {
      botInitialChat(context, state, "whoisteamleader", null); context.library.chat.enterChat(state.cs, 0, ChatDestination.Team);
      state.askTeamLeaderTime = 0; state.becomeTeamLeaderTime = f(f(context.time + 8) + f(context.random() * 10));
    }
    if (state.becomeTeamLeaderTime !== 0 && state.becomeTeamLeaderTime < context.time) {
      botInitialChat(context, state, "iamteamleader", null); context.library.chat.enterChat(state.cs, 0, ChatDestination.Team);
      botSayVoiceTeamOrder(context, state, -1, "startleader");
      state.copyTeamLeaderWithOverflow(clientName(context, state.client, 36));
      state.becomeTeamLeaderTime = 0;
    }
    return;
  }
  state.askTeamLeaderTime = 0; state.becomeTeamLeaderTime = 0;
  if (clientName(context, state.client).toLowerCase() !== state.teamLeader.toLowerCase()) return;
  const count = botNumTeamMates(context, state);
  switch (context.gameType) {
    case GameType.GT_TEAM:
      if (state.numTeammates !== count || state.forceOrders) { state.teamGiveOrdersTime = context.time; state.numTeammates = count; state.forceOrders = false; }
      if (state.teamGiveOrdersTime !== 0 && state.teamGiveOrdersTime < f(context.time - 5)) {
        botTeamOrders(context, state); state.teamGiveOrdersTime = f(context.time + 120);
      }
      break;
    case GameType.GT_CTF: case GameType.GT_1FCTF:
      if (context.gameType === GameType.GT_1FCTF && state.product !== "missionpack") break;
      if (state.numTeammates !== count || state.flagStatusChanged || state.forceOrders) {
        state.teamGiveOrdersTime = context.time; state.numTeammates = count; state.flagStatusChanged = false; state.forceOrders = false;
      }
      if (state.lastFlagCaptureTime < f(context.time - 240)) {
        state.lastFlagCaptureTime = context.time;
        if (context.random() < 0.4) { state.ctfStrategy ^= BotCtfStrategy.AGRESSIVE; state.teamGiveOrdersTime = context.time; }
      }
      if (state.teamGiveOrdersTime !== 0 && state.teamGiveOrdersTime < f(context.time - (context.gameType === GameType.GT_CTF ? 3 : 2))) {
        if (context.gameType === GameType.GT_CTF) botCTFOrders(context, state); else bot1FCTFOrders(context, state);
        state.teamGiveOrdersTime = 0;
      }
      break;
    case GameType.GT_OBELISK: case GameType.GT_HARVESTER:
      if (state.product !== "missionpack") break;
      if (state.numTeammates !== count || state.forceOrders) { state.teamGiveOrdersTime = context.time; state.numTeammates = count; state.forceOrders = false; }
      if (state.teamGiveOrdersTime !== 0 && state.teamGiveOrdersTime < f(context.time - 5)) {
        if (context.gameType === GameType.GT_OBELISK) botObeliskOrders(context, state); else botHarvesterOrders(context, state);
        state.teamGiveOrdersTime = f(context.time + 30);
      }
      break;
  }
}
