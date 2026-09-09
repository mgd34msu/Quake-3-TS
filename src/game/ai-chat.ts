// Ported from id Software's game/ai_chat.c and ai_main.c:BotAI_BotInitialChat.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { ChatDestination } from "../botlib/chat.ts";
import type { ChatVariables } from "../botlib/chat.ts";
import { presenceTypeBounds } from "../botlib/spatial.ts";
import { CvarFlag } from "../core/cvar.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { vec3 } from "../core/math.ts";
import { GameType, PersistentIndex, Team } from "../shared/definitions.ts";
import { ENTITYNUM_WORLD } from "../shared/player-state.ts";
import { botEntityInfo, botEntityVisible, botIsDead, botIsObserver,
  entityIsDead, entityIsInvisible, entityIsShooting } from "./ai-combat.ts";
import type { GameAiContext } from "./ai-context.ts";
import { BotCharacteristic, BotInventory, BotLongTermGoal } from "./ai-definitions.ts";
import { botSameTeam, botSynonymContext, clientName, easyClientName } from "./ai-orders.ts";
import type { BotState } from "./ai-state.ts";
import { gameAtoi } from "./numeric.ts";
import { MAX_CLIENTS } from "./state.ts";

const TIME_BETWEEN_CHATTING = 25;
const INVALID_VARIABLE = "[invalid var]";

/** ai_chat.c's separate function-static maxclients cells. */
export class GameAiChatState {
  readonly maxClients = new Map<string, number>();
}

function cachedMaxClients(context: GameAiContext, name: string): number {
  let value = context.chat.maxClients.get(name);
  if (value === undefined || value === 0) {
    const cvar = context.game.options.cvars.get("sv_maxclients");
    value = cvar === undefined ? 0 : cvar.integerValue;
    context.chat.maxClients.set(name, value);
  }
  return Math.min(value, MAX_CLIENTS);
}

function activePlayer(context: GameAiContext, client: number): boolean {
  const config = context.game.options.configstrings.get(544 + client).slice(0, 1023);
  return config.length !== 0 && infoValueForKey(config, "n").length !== 0 &&
    gameAtoi(infoValueForKey(config, "t")) !== Team.TEAM_SPECTATOR;
}

export function botNumActivePlayers(context: GameAiContext): number {
  const maximum = cachedMaxClients(context, "BotNumActivePlayers");
  let count = 0;
  for (let client = 0; client < maximum; client++) if (activePlayer(context, client)) count++;
  return count;
}

export function botIsFirstInRankings(context: GameAiContext, state: BotState): boolean {
  const maximum = cachedMaxClients(context, "BotIsFirstInRankings");
  const score = state.curPs.persistant.get(PersistentIndex.PERS_SCORE);
  for (let client = 0; client < maximum; client++) {
    if (!activePlayer(context, client)) continue;
    const player = context.getClientState(client);
    if (player === null) throw new Error("BotIsFirstInRankings: active player has no client state");
    if (score < player.persistant.get(PersistentIndex.PERS_SCORE)) return false;
  }
  return true;
}

export function botIsLastInRankings(context: GameAiContext, state: BotState): boolean {
  const maximum = cachedMaxClients(context, "BotIsLastInRankings");
  const score = state.curPs.persistant.get(PersistentIndex.PERS_SCORE);
  for (let client = 0; client < maximum; client++) {
    if (!activePlayer(context, client)) continue;
    const player = context.getClientState(client);
    if (player === null) throw new Error("BotIsLastInRankings: active player has no client state");
    if (score > player.persistant.get(PersistentIndex.PERS_SCORE)) return false;
  }
  return true;
}

function rankedClient(context: GameAiContext, first: boolean): string {
  const maximum = cachedMaxClients(context, first ? "BotFirstClientInRankings" : "BotLastClientInRankings");
  let score = first ? -999999 : 999999;
  let selected = 0;
  for (let client = 0; client < maximum; client++) {
    if (!activePlayer(context, client)) continue;
    const player = context.getClientState(client);
    if (player === null) throw new Error("BotClientInRankings: active player has no client state");
    const current = player.persistant.get(PersistentIndex.PERS_SCORE);
    if (first ? current > score : current < score) { score = current; selected = client; }
  }
  return easyClientName(context, selected, 32);
}

export function botFirstClientInRankings(context: GameAiContext): string { return rankedClient(context, true); }
export function botLastClientInRankings(context: GameAiContext): string { return rankedClient(context, false); }

export function botRandomOpponentName(context: GameAiContext, state: BotState): string {
  const maximum = cachedMaxClients(context, "BotRandomOpponentName");
  const opponents: number[] = [];
  for (let client = 0; client < maximum; client++) {
    if (client !== state.client && activePlayer(context, client) && !botSameTeam(context, state, client)) opponents.push(client);
  }
  let count = Math.trunc(Math.fround(context.random() * opponents.length));
  for (const opponent of opponents) if (--count <= 0) return easyClientName(context, opponent, 32);
  // The source initializes opponents[0] to zero even when there are no opponents.
  const first = opponents[0];
  return easyClientName(context, first === undefined ? 0 : first, 32);
}

export function botMapTitle(context: GameAiContext): string {
  return infoValueForKey(context.game.options.cvars.infoString(CvarFlag.ServerInfo), "mapname").slice(0, 127);
}

export function botWeaponNameForMeansOfDeath(context: GameAiContext, method: number): string {
  switch (method) {
    case 1: return "Shotgun";
    case 2: return "Gauntlet";
    case 3: return "Machinegun";
    case 4: case 5: return "Grenade Launcher";
    case 6: case 7: return "Rocket Launcher";
    case 8: case 9: return "Plasmagun";
    case 10: return "Railgun";
    case 11: return "Lightning Gun";
    case 12: case 13: return "BFG10K";
    case 23: return context.game.options.product === "missionpack" ? "Nailgun" : "Grapple";
    case 24: if (context.game.options.product === "missionpack") return "Chaingun"; break;
    case 25: if (context.game.options.product === "missionpack") return "Proximity Launcher"; break;
    case 26: if (context.game.options.product === "missionpack") return "Kamikaze"; break;
    case 27: if (context.game.options.product === "missionpack") return "Prox mine"; break;
    case 28: if (context.game.options.product === "missionpack") return "Grapple"; break;
  }
  return "[unknown weapon]";
}

export function botRandomWeaponName(context: GameAiContext): string {
  const missionpack = context.game.options.product === "missionpack";
  const selected = Math.trunc(Math.fround(context.random() * Math.fround(missionpack ? 11.9 : 8.9)));
  switch (selected) {
    case 0: return "Gauntlet";
    case 1: return "Shotgun";
    case 2: return "Machinegun";
    case 3: return "Grenade Launcher";
    case 4: return "Rocket Launcher";
    case 5: return "Plasmagun";
    case 6: return "Railgun";
    case 7: return "Lightning Gun";
    case 8: if (missionpack) return "Nailgun"; break;
    case 9: if (missionpack) return "Chaingun"; break;
    case 10: if (missionpack) return "Proximity Launcher"; break;
  }
  return "BFG10K";
}

export function botVisibleEnemies(context: GameAiContext, state: BotState): boolean {
  for (let client = 0; client < MAX_CLIENTS; client++) {
    if (client === state.client) continue;
    const info = botEntityInfo(context, client);
    if (!info.valid || entityIsDead(context, info) || info.number === state.entityNum) continue;
    if (entityIsInvisible(context, info) && !entityIsShooting(info)) continue;
    if (botSameTeam(context, state, client)) continue;
    if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, client) > 0) return true;
  }
  return false;
}

export function botValidChatPosition(context: GameAiContext, state: BotState): boolean {
  if (botIsDead(context, state)) return true;
  for (const index of [BotInventory.QUAD, BotInventory.HASTE, BotInventory.INVISIBILITY, BotInventory.REGEN, BotInventory.FLIGHT]) {
    const amount = state.inventory[index];
    if (amount === undefined) throw new RangeError(`Missing bot inventory slot ${index}`);
    if (amount !== 0) return false;
  }
  const origin = state.origin;
  if ((context.game.world.pointContents(vec3(origin.x, origin.y, Math.fround(origin.z - 24)), state.entityNum) & (8 | 16)) !== 0) return false;
  if ((context.game.world.pointContents(vec3(origin.x, origin.y, Math.fround(origin.z + 32)), state.entityNum) & (8 | 16 | 32)) !== 0) return false;
  const bounds = presenceTypeBounds(4);
  const trace = context.game.world.trace({ start: vec3(origin.x, origin.y, Math.fround(origin.z + 1)),
    end: vec3(origin.x, origin.y, Math.fround(origin.z - 10)), shape: { kind: "box", mins: bounds.min, maxs: bounds.max },
    passEntityNum: state.client, mask: 1 });
  return trace.entityNum === ENTITYNUM_WORLD;
}

export function botInitialChat(context: GameAiContext, state: BotState, type: string, ...variables: readonly (string | null)[]): void {
  const values: [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null] =
    [null, null, null, null, null, null, null, null];
  for (let index = 0; index < 8; index++) {
    const value = variables[index];
    if (value === null || value === undefined) break;
    values[index] = value;
  }
  context.library.chat.initialChat(state.cs, type, botSynonymContext(context, state), values);
}

function unavailable(context: GameAiContext, state: BotState): boolean {
  return context.cvar("bot_nochat").integerValue !== 0 || state.lastChatTime > Math.fround(context.time - TIME_BETWEEN_CHATTING);
}
function characteristic(context: GameAiContext, state: BotState, index: BotCharacteristic): number {
  return context.library.characters.boundedFloat(state.character, index, 0, 1);
}
function randomRefused(context: GameAiContext, probability: number): boolean {
  return context.cvar("bot_fastchat").integerValue === 0 && context.random() > probability;
}
function allChat(context: GameAiContext, state: BotState): true {
  state.lastChatTime = Math.fround(context.time);
  state.chatTo = ChatDestination.All;
  return true;
}

export function botChatEnterGame(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state) || context.gameType >= GameType.GT_TEAM || context.gameType === GameType.GT_TOURNAMENT) return false;
  if (randomRefused(context, characteristic(context, state, BotCharacteristic.CHAT_ENTEREXITGAME))) return false;
  if (botNumActivePlayers(context) <= 1 || !botValidChatPosition(context, state)) return false;
  botInitialChat(context, state, "game_enter", easyClientName(context, state.client, 32), botRandomOpponentName(context, state), INVALID_VARIABLE, INVALID_VARIABLE, botMapTitle(context));
  return allChat(context, state);
}

export function botChatExitGame(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state) || context.gameType >= GameType.GT_TEAM || context.gameType === GameType.GT_TOURNAMENT) return false;
  if (randomRefused(context, characteristic(context, state, BotCharacteristic.CHAT_ENTEREXITGAME))) return false;
  if (botNumActivePlayers(context) <= 1) return false;
  botInitialChat(context, state, "game_exit", easyClientName(context, state.client, 32), botRandomOpponentName(context, state), INVALID_VARIABLE, INVALID_VARIABLE, botMapTitle(context));
  return allChat(context, state);
}

export function botChatStartLevel(context: GameAiContext, state: BotState): boolean {
  if (context.cvar("bot_nochat").integerValue !== 0 || botIsObserver(context, state) || state.lastChatTime > Math.fround(context.time - TIME_BETWEEN_CHATTING)) return false;
  if (context.gameType >= GameType.GT_TEAM) { context.library.actions.command(state.client, "vtaunt"); return false; }
  if (context.gameType === GameType.GT_TOURNAMENT) return false;
  if (randomRefused(context, characteristic(context, state, BotCharacteristic.CHAT_STARTENDLEVEL)) || botNumActivePlayers(context) <= 1) return false;
  botInitialChat(context, state, "level_start", easyClientName(context, state.client, 32));
  return allChat(context, state);
}

export function botChatEndLevel(context: GameAiContext, state: BotState): boolean {
  if (context.cvar("bot_nochat").integerValue !== 0 || botIsObserver(context, state) || state.lastChatTime > Math.fround(context.time - TIME_BETWEEN_CHATTING)) return false;
  if (context.gameType >= GameType.GT_TEAM) {
    if (botIsFirstInRankings(context, state)) context.library.actions.command(state.client, "vtaunt");
    return true;
  }
  if (context.gameType === GameType.GT_TOURNAMENT) return false;
  if (randomRefused(context, characteristic(context, state, BotCharacteristic.CHAT_STARTENDLEVEL)) || botNumActivePlayers(context) <= 1) return false;
  const first = botIsFirstInRankings(context, state);
  const last = !first && botIsLastInRankings(context, state);
  botInitialChat(context, state, first ? "level_end_victory" : last ? "level_end_lose" : "level_end",
    easyClientName(context, state.client, 32), botRandomOpponentName(context, state),
    first ? INVALID_VARIABLE : botFirstClientInRankings(context), last ? INVALID_VARIABLE : botLastClientInRankings(context), botMapTitle(context));
  return allChat(context, state);
}

export function botChatDeath(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state)) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_DEATH);
  if (context.gameType === GameType.GT_TOURNAMENT || randomRefused(context, chance) || botNumActivePlayers(context) <= 1) return false;
  const name = state.lastKilledBy >= 0 && state.lastKilledBy < MAX_CLIENTS ? easyClientName(context, state.lastKilledBy, 32) : "[world]";
  if (context.gameType >= GameType.GT_TEAM && botSameTeam(context, state, state.lastKilledBy)) {
    if (state.lastKilledBy === state.client) return false;
    botInitialChat(context, state, "death_teammate", name);
    state.chatTo = ChatDestination.Team;
  } else {
    if (context.gameType >= GameType.GT_TEAM) { context.library.actions.command(state.client, "vtaunt"); return true; }
    const method = state.botDeathType;
    if (method === 14) botInitialChat(context, state, "death_drown", botRandomOpponentName(context, state));
    else if (method === 15) botInitialChat(context, state, "death_slime", botRandomOpponentName(context, state));
    else if (method === 16) botInitialChat(context, state, "death_lava", botRandomOpponentName(context, state));
    else if (method === 19) botInitialChat(context, state, "death_cratered", botRandomOpponentName(context, state));
    else if (state.botSuicide || method === 17 || method === 20 || method === 21 || method === 22 || method === 0) botInitialChat(context, state, "death_suicide", botRandomOpponentName(context, state));
    else if (method === 18) botInitialChat(context, state, "death_telefrag", name);
    else if (context.game.options.product === "missionpack" && method === 26 && context.library.chat.numInitialChats(state.cs, "death_kamikaze") !== 0) botInitialChat(context, state, "death_kamikaze", name);
    else {
      let type: string;
      if ((method === 2 || method === 10 || method === 12 || method === 13) && context.random() < 0.5) type = method === 2 ? "death_gauntlet" : method === 10 ? "death_rail" : "death_bfg";
      else type = context.random() < characteristic(context, state, BotCharacteristic.CHAT_INSULT) ? "death_insult" : "death_praise";
      botInitialChat(context, state, type, name, botWeaponNameForMeansOfDeath(context, method));
    }
    state.chatTo = ChatDestination.All;
  }
  state.lastChatTime = Math.fround(context.time);
  return true;
}

export function botChatKill(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state)) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_KILL);
  if (context.gameType === GameType.GT_TOURNAMENT || randomRefused(context, chance) || state.lastKilledPlayer === state.client) return false;
  if (botNumActivePlayers(context) <= 1 || !botValidChatPosition(context, state) || botVisibleEnemies(context, state)) return false;
  const name = easyClientName(context, state.lastKilledPlayer, 32);
  state.chatTo = ChatDestination.All;
  if (context.gameType >= GameType.GT_TEAM && botSameTeam(context, state, state.lastKilledPlayer)) {
    botInitialChat(context, state, "kill_teammate", name);
    state.chatTo = ChatDestination.Team;
  } else {
    if (context.gameType >= GameType.GT_TEAM) { context.library.actions.command(state.client, "vtaunt"); return false; }
    const method = state.enemyDeathType;
    let type: string;
    if (method === 2) type = "kill_gauntlet";
    else if (method === 10) type = "kill_rail";
    else if (method === 18) type = "kill_telefrag";
    // The source tests botdeathtype here rather than enemydeathtype.
    else if (context.game.options.product === "missionpack" && state.botDeathType === 26 && context.library.chat.numInitialChats(state.cs, "kill_kamikaze") !== 0) type = "kill_kamikaze";
    else type = context.random() < characteristic(context, state, BotCharacteristic.CHAT_INSULT) ? "kill_insult" : "kill_praise";
    botInitialChat(context, state, type, name);
  }
  state.lastChatTime = Math.fround(context.time);
  return true;
}

export function botChatEnemySuicide(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state) || botNumActivePlayers(context) <= 1) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_KILL);
  if (context.gameType >= GameType.GT_TEAM || context.gameType === GameType.GT_TOURNAMENT || randomRefused(context, chance)) return false;
  if (!botValidChatPosition(context, state) || botVisibleEnemies(context, state)) return false;
  botInitialChat(context, state, "enemy_suicide", state.enemy >= 0 ? easyClientName(context, state.enemy, 32) : "");
  return allChat(context, state);
}

export function botChatHitTalking(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state) || botNumActivePlayers(context) <= 1) return false;
  const client = context.game.pool.at(state.client).client;
  if (client === null) throw new Error("BotChat_HitTalking requires a client");
  const attacker = client.lastHurtClient;
  if (attacker === 0 || attacker === state.client || attacker < 0 || attacker >= MAX_CLIENTS) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_HITTALKING);
  if (context.gameType >= GameType.GT_TEAM || context.gameType === GameType.GT_TOURNAMENT || randomRefused(context, chance * 0.5)) return false;
  if (!botValidChatPosition(context, state)) return false;
  // Source passes lasthurt_client, not lasthurt_mod, in this one branch.
  botInitialChat(context, state, "hit_talking", clientName(context, attacker, 32), botWeaponNameForMeansOfDeath(context, attacker));
  return allChat(context, state);
}

export function botChatHitNoDeath(context: GameAiContext, state: BotState): boolean {
  const client = context.game.pool.at(state.client).client;
  if (client === null) throw new Error("BotChat_HitNoDeath requires a client");
  const attacker = client.lastHurtClient;
  if (attacker === 0 || attacker === state.client || attacker < 0 || attacker >= MAX_CLIENTS) return false;
  if (unavailable(context, state) || botNumActivePlayers(context) <= 1) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_HITNODEATH);
  if (context.gameType >= GameType.GT_TEAM || context.gameType === GameType.GT_TOURNAMENT || randomRefused(context, chance * 0.5)) return false;
  if (!botValidChatPosition(context, state) || botVisibleEnemies(context, state) || entityIsShooting(botEntityInfo(context, state.enemy))) return false;
  botInitialChat(context, state, "hit_nodeath", clientName(context, attacker, 32), botWeaponNameForMeansOfDeath(context, client.lastHurtMod));
  return allChat(context, state);
}

export function botChatHitNoKill(context: GameAiContext, state: BotState): boolean {
  if (unavailable(context, state) || botNumActivePlayers(context) <= 1) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_HITNOKILL);
  if (context.gameType >= GameType.GT_TEAM || context.gameType === GameType.GT_TOURNAMENT || randomRefused(context, chance * 0.5)) return false;
  if (!botValidChatPosition(context, state) || botVisibleEnemies(context, state) || entityIsShooting(botEntityInfo(context, state.enemy))) return false;
  const enemy = context.game.pool.at(state.enemy).client;
  if (enemy === null) throw new Error("BotChat_HitNoKill requires an enemy client");
  botInitialChat(context, state, "hit_nokill", clientName(context, state.enemy, 32), botWeaponNameForMeansOfDeath(context, enemy.lastHurtMod));
  return allChat(context, state);
}

export function botChatRandom(context: GameAiContext, state: BotState): boolean {
  if (context.cvar("bot_nochat").integerValue !== 0 || botIsObserver(context, state) || state.lastChatTime > Math.fround(context.time - TIME_BETWEEN_CHATTING)) return false;
  if (context.gameType === GameType.GT_TOURNAMENT || state.ltgType === BotLongTermGoal.TEAMHELP || state.ltgType === BotLongTermGoal.TEAMACCOMPANY || state.ltgType === BotLongTermGoal.RUSHBASE) return false;
  const chance = characteristic(context, state, BotCharacteristic.CHAT_RANDOM);
  if (context.random() > Math.fround(state.thinkTime * Math.fround(0.1))) return false;
  if (context.cvar("bot_fastchat").integerValue === 0 && (context.random() > chance || context.random() > 0.25)) return false;
  if (botNumActivePlayers(context) <= 1 || !botValidChatPosition(context, state) || botVisibleEnemies(context, state)) return false;
  const name = state.lastKilledPlayer === state.client ? botRandomOpponentName(context, state) : easyClientName(context, state.lastKilledPlayer, 32);
  if (context.gameType >= GameType.GT_TEAM) { context.library.actions.command(state.client, "vtaunt"); return false; }
  const type = context.random() < characteristic(context, state, BotCharacteristic.CHAT_MISC) ? "random_misc" : "random_insult";
  botInitialChat(context, state, type, botRandomOpponentName(context, state), name, INVALID_VARIABLE, INVALID_VARIABLE, botMapTitle(context), botRandomWeaponName(context));
  return allChat(context, state);
}

export function botChatTime(context: GameAiContext, state: BotState): number {
  context.library.characters.boundedInteger(state.character, BotCharacteristic.CHAT_CPM, 1, 4000);
  return 2;
}

export function botChatTest(context: GameAiContext, state: BotState): void {
  const emit = (type: string, variables: () => ChatVariables): void => {
    const count = context.library.chat.numInitialChats(state.cs, type);
    for (let index = 0; index < count; index++) {
      botInitialChat(context, state, type, ...variables());
      context.library.chat.enterChat(state.cs, 0, ChatDestination.All);
    }
  };
  for (const type of ["game_enter", "game_exit"]) emit(type, () => [easyClientName(context, state.client, 32), botRandomOpponentName(context, state), INVALID_VARIABLE, INVALID_VARIABLE, botMapTitle(context), null, null, null]);
  emit("level_start", () => [easyClientName(context, state.client, 32), null, null, null, null, null, null, null]);
  for (const type of ["level_end_victory", "level_end_lose", "level_end"]) emit(type, () => [easyClientName(context, state.client, 32), botRandomOpponentName(context, state), botFirstClientInRankings(context), botLastClientInRankings(context), botMapTitle(context), null, null, null]);
  let name = easyClientName(context, state.lastKilledBy, 32);
  for (const type of ["death_drown", "death_slime", "death_lava", "death_cratered", "death_suicide", "death_telefrag"]) emit(type, () => [name, null, null, null, null, null, null, null]);
  for (const type of ["death_gauntlet", "death_rail", "death_bfg", "death_insult", "death_praise"]) emit(type, () => [name, botWeaponNameForMeansOfDeath(context, state.botDeathType), null, null, null, null, null, null]);
  name = easyClientName(context, state.lastKilledPlayer, 32);
  for (const type of ["kill_gauntlet", "kill_rail", "kill_telefrag", "kill_insult", "kill_praise", "enemy_suicide"]) emit(type, () => [name, null, null, null, null, null, null, null]);
  const client = context.game.pool.at(state.client).client;
  if (client === null) throw new Error("BotChatTest requires a client");
  name = clientName(context, client.lastHurtClient, 32);
  const weapon = botWeaponNameForMeansOfDeath(context, client.lastHurtClient);
  for (const type of ["hit_talking", "hit_nodeath", "hit_nokill"]) emit(type, () => [name, weapon, null, null, null, null, null, null]);
  name = state.lastKilledPlayer === state.client ? botRandomOpponentName(context, state) : easyClientName(context, state.lastKilledPlayer, 32);
  for (const type of ["random_misc", "random_insult"]) emit(type, () => [botRandomOpponentName(context, state), name, INVALID_VARIABLE, INVALID_VARIABLE, botMapTitle(context), botRandomWeaponName(context), null, null]);
}
