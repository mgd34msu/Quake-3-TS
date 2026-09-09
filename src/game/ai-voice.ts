// Ported from id Software's game/ai_vcmd.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { BotActionFlag } from "../botlib/actions.ts";
import { ChatDestination } from "../botlib/chat.ts";
import { vec3 } from "../core/math.ts";
import { GameType, Team } from "../shared/definitions.ts";
import { botInitialChat } from "./ai-chat.ts";
import { botEntityInfo } from "./ai-combat.ts";
import type { GameAiContext } from "./ai-context.ts";
import { BotLongTermGoal, BotTeamTaskPreference, CTF_GETFLAG_TIME, CTF_RETURNFLAG_TIME,
  TEAM_ACCOMPANY_TIME, TEAM_ATTACKENEMYBASE_TIME, TEAM_CAMP_TIME, TEAM_DEFENDKEYAREA_TIME, TEAM_HARVEST_TIME } from "./ai-definitions.ts";
import { botGetAlternateRouteGoal, botPointAreaNum } from "./ai-navigation.ts";
import { botOppositeTeam, botRememberLastOrderedTask, botSameTeam, botSetTeamStatus, botTeam,
  botTeamFlagCarrier, clientName, copyClientNameToTeamLeader, easyClientName } from "./ai-orders.ts";
import type { BotState } from "./ai-state.ts";
import { botGetTeamMateTaskPreference, botSetTeamMateTaskPreference, botVoiceChatOnly } from "./ai-team.ts";
import { gameAtoi } from "./numeric.ts";

function ordered(context: GameAiContext, state: BotState, client: number, type: BotLongTermGoal, duration: number): void {
  state.decisionmaker = client;
  state.ordered = true;
  state.orderTime = Math.fround(context.time);
  state.teamMessageTime = Math.fround(context.time + Math.fround(2 * context.random()));
  state.ltgType = type;
  state.teamGoalTime = Math.fround(context.time + duration);
}

export function botVoiceChatGetFlag(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  const goals = context.deathmatch;
  if (context.gameType === GameType.GT_CTF) {
    if (goals.ctfRedFlag.area === 0 || goals.ctfBlueFlag.area === 0) return;
  } else if (context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF) {
    if (goals.ctfNeutralFlag.area === 0 || goals.ctfRedFlag.area === 0 || goals.ctfBlueFlag.area === 0) return;
  } else return;
  ordered(context, state, client, BotLongTermGoal.GETFLAG, CTF_GETFLAG_TIME);
  if (context.gameType === GameType.GT_CTF) botGetAlternateRouteGoal(context, state, botOppositeTeam(context, state));
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botVoiceChatOffense(context: GameAiContext, state: BotState, client: number, mode: number): void {
  if (context.gameType === GameType.GT_CTF || context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF) {
    botVoiceChatGetFlag(context, state, client, mode);
    return;
  }
  if (context.game.options.product === "missionpack" && context.gameType === GameType.GT_HARVESTER) {
    ordered(context, state, client, BotLongTermGoal.HARVEST, TEAM_HARVEST_TIME);
    state.harvestAwayTime = 0;
  } else {
    ordered(context, state, client, BotLongTermGoal.ATTACKENEMYBASE, TEAM_ATTACKENEMYBASE_TIME);
    state.attackAwayTime = 0;
  }
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botVoiceChatDefend(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  const goals = context.deathmatch, team = botTeam(context, state);
  if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return;
  if (context.game.options.product === "missionpack" && (context.gameType === GameType.GT_OBELISK || context.gameType === GameType.GT_HARVESTER)) {
    state.teamGoal.copyFrom(team === Team.TEAM_RED ? goals.redObelisk : goals.blueObelisk);
  } else if (context.gameType === GameType.GT_CTF || context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF) {
    state.teamGoal.copyFrom(team === Team.TEAM_RED ? goals.ctfRedFlag : goals.ctfBlueFlag);
  } else return;
  ordered(context, state, client, BotLongTermGoal.DEFENDKEYAREA, TEAM_DEFENDKEYAREA_TIME);
  state.defendAwayTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botVoiceChatDefendFlag(context: GameAiContext, state: BotState, client: number, mode: number): void {
  botVoiceChatDefend(context, state, client, mode);
}

export function botVoiceChatPatrol(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  state.decisionmaker = client;
  state.ltgType = BotLongTermGoal.NONE;
  state.leadTime = 0;
  state.lastGoalLtgType = 0;
  botInitialChat(context, state, "dismissed");
  context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
  botVoiceChatOnly(context, state, -1, "onpatrol");
  botSetTeamStatus(context, state);
}

function locateRequester(context: GameAiContext, state: BotState, client: number): boolean {
  state.teamGoal.entity = -1;
  const info = botEntityInfo(context, client);
  if (info.valid) {
    const area = botPointAreaNum(context, info.origin);
    if (area !== 0) {
      state.teamGoal.entity = client;
      state.teamGoal.area = area;
      Object.assign(state.teamGoal.origin, info.origin);
      Object.assign(state.teamGoal.mins, vec3(-8, -8, -8));
      Object.assign(state.teamGoal.maxs, vec3(8, 8, 8));
    }
  }
  if (state.teamGoal.entity >= 0) return true;
  botInitialChat(context, state, "whereareyou", easyClientName(context, client, 36));
  context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
  return false;
}

export function botVoiceChatCamp(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  if (!locateRequester(context, state, client)) return;
  ordered(context, state, client, BotLongTermGoal.CAMPORDER, TEAM_CAMP_TIME);
  state.teammate = client;
  state.arriveTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botVoiceChatFollowMe(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  if (!locateRequester(context, state, client)) return;
  state.decisionmaker = client;
  state.ordered = true;
  state.orderTime = Math.fround(context.time);
  state.teammate = client;
  state.teammateVisibleTime = Math.fround(context.time);
  state.teamMessageTime = Math.fround(context.time + Math.fround(2 * context.random()));
  state.teamGoalTime = Math.fround(context.time + TEAM_ACCOMPANY_TIME);
  state.ltgType = BotLongTermGoal.TEAMACCOMPANY;
  state.formationDist = 112;
  state.arriveTime = 0;
  botSetTeamStatus(context, state);
  botRememberLastOrderedTask(context, state);
}

export function botVoiceChatFollowFlagCarrier(context: GameAiContext, state: BotState, _client: number, mode: number): void {
  const carrier = botTeamFlagCarrier(context, state);
  if (carrier >= 0) botVoiceChatFollowMe(context, state, carrier, mode);
}

export function botVoiceChatReturnFlag(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  if (context.gameType !== GameType.GT_CTF && !(context.game.options.product === "missionpack" && context.gameType === GameType.GT_1FCTF)) return;
  ordered(context, state, client, BotLongTermGoal.RETURNFLAG, CTF_RETURNFLAG_TIME);
  state.rushBaseAwayTime = 0;
  botSetTeamStatus(context, state);
}

export function botVoiceChatStartLeader(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  copyClientNameToTeamLeader(context, state, client);
}

export function botVoiceChatStopLeader(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  if (folded(state.teamLeader) !== folded(clientName(context, client, 256))) return;
  state.clearTeamLeader();
  if (client < 0 || client >= context.command.notLeader.length) throw new RangeError("BotVoiceChat_StopLeader: client outside notleader array");
  context.command.notLeader[client] = true;
}

export function botVoiceChatWhoIsLeader(context: GameAiContext, state: BotState, _client: number, _mode: number): void {
  if (context.gameType < GameType.GT_TEAM || folded(clientName(context, state.client, 256)) !== folded(state.teamLeader)) return;
  botInitialChat(context, state, "iamteamleader");
  context.library.chat.enterChat(state.cs, 0, ChatDestination.Team);
  botVoiceChatOnly(context, state, -1, "startleader");
}

function taskPreference(context: GameAiContext, state: BotState, client: number, desired: BotTeamTaskPreference, removed: BotTeamTaskPreference): void {
  const preference = (botGetTeamMateTaskPreference(context, state, client) & ~removed) | desired;
  botSetTeamMateTaskPreference(context, state, client, preference);
  botInitialChat(context, state, "keepinmind", easyClientName(context, client, 36));
  context.library.chat.enterChat(state.cs, client, ChatDestination.Tell);
  botVoiceChatOnly(context, state, client, "yes");
  context.library.actions.action(state.client, BotActionFlag.AFFIRMATIVE);
}

export function botVoiceChatWantOnDefense(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  taskPreference(context, state, client, BotTeamTaskPreference.DEFENDER, BotTeamTaskPreference.ATTACKER);
}

export function botVoiceChatWantOnOffense(context: GameAiContext, state: BotState, client: number, _mode: number): void {
  taskPreference(context, state, client, BotTeamTaskPreference.ATTACKER, BotTeamTaskPreference.DEFENDER);
}

const voiceCommands: ReadonlyMap<string, (context: GameAiContext, state: BotState, client: number, mode: number) => void> = new Map([
  ["getflag", botVoiceChatGetFlag], ["offense", botVoiceChatOffense], ["defend", botVoiceChatDefend],
  ["defendflag", botVoiceChatDefendFlag], ["patrol", botVoiceChatPatrol], ["camp", botVoiceChatCamp],
  ["followme", botVoiceChatFollowMe], ["followflagcarrier", botVoiceChatFollowFlagCarrier],
  ["returnflag", botVoiceChatReturnFlag], ["startleader", botVoiceChatStartLeader], ["stopleader", botVoiceChatStopLeader],
  ["whoisleader", botVoiceChatWhoIsLeader], ["wantondefense", botVoiceChatWantOnDefense], ["wantonoffense", botVoiceChatWantOnOffense],
]);

function folded(text: string): string {
  const nul = text.indexOf("\0");
  return (nul < 0 ? text : text.slice(0, nul)).replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
}

export function botVoiceChatCommand(context: GameAiContext, state: BotState, mode: number, voiceChat: string): boolean {
  if (context.gameType < GameType.GT_TEAM || mode === 0) return false;
  const nul = voiceChat.indexOf("\0");
  const text = (nul < 0 ? voiceChat : voiceChat.slice(0, nul)).slice(0, 255);
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 255) throw new RangeError("Bot voice chat requires source byte characters");
  let offset = 0;
  const byte = (): number => {
    const value = text.charCodeAt(offset);
    return value < 128 ? value : value - 256;
  };
  const token = (): string => {
    const start = offset;
    while (offset < text.length && byte() > 32) offset++;
    const value = text.slice(start, offset);
    while (offset < text.length && byte() <= 32) offset++;
    return value;
  };
  gameAtoi(token());
  const client = gameAtoi(token());
  gameAtoi(token());
  if (!botSameTeam(context, state, client)) return false;
  const handler = voiceCommands.get(folded(text.slice(offset)));
  if (handler === undefined) return false;
  handler(context, state, client, mode);
  return true;
}
