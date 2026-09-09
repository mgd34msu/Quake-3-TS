/*
 * Game bot lifecycle and scheduling translated from id Software's game/ai_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { Characteristic } from "../botlib/character.ts";
import { ChatDestination, ChatGender } from "../botlib/chat.ts";
import type { BotEntityUpdate } from "../botlib/entity.ts";
import type { BotLibrary } from "../botlib/library.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { Vec3 } from "../core/math.ts";
import { EntityType, GameType, Team, Weapon } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { BotInventory, BotLongTermGoal } from "./ai-definitions.ts";
import { botChatExitGame, botChatTest } from "./ai-chat.ts";
import { botDeathmatchAI } from "./ai-combat.ts";
import { GameAiContext } from "./ai-context.ts";
import type { GameAiHost } from "./ai-context.ts";
import { botAddDeltaAngles, botSubtractDeltaAngles, botUpdateInput } from "./ai-input.ts";
import { botClearActivateGoalStack, botFreeWaypoints, botPointAreaNum, botSetupDeathmatchAI } from "./ai-navigation.ts";
import { bot1FCTFCarryingFlag, botCTFCarryingFlag, botHarvesterCarryingCubes, botTeam, clientFromName, clientName, easyClientName } from "./ai-orders.ts";
import { copyBotPlayerState } from "./ai-state.ts";
import type { BotSettings, BotState } from "./ai-state.ts";
import { botVoiceChatCommand } from "./ai-voice.ts";
import { clientInfoValue } from "./client-admission.ts";
import { gameFormat } from "./format.ts";
import { gameAtoi, scanGameFloat } from "./numeric.ts";
import type { GameRuntime } from "./runtime.ts";
import { ConnectionState, MAX_CLIENTS, MAX_GENTITIES } from "./state.ts";

const f = Math.fround;
const CS_PLAYERS = 544;
const CS_BOTINFO = 25;
const setupCvars: readonly (readonly [string, string])[] = [["bot_thinktime", "100"], ["bot_memorydump", "0"],
  ["bot_saveroutingcache", "0"], ["bot_pause", "0"], ["bot_report", "0"], ["bot_testsolid", "0"],
  ["bot_testclusters", "0"], ["bot_developer", "0"]];

function asciiEqual(first: string, second: string): boolean {
  return first.replace(/[A-Z]/g, c => c.toLowerCase()) === second.replace(/[A-Z]/g, c => c.toLowerCase());
}

/** Q_IsColorString skips any non-NUL byte after ^ except another ^. */
export function removeColorEscapeSequences(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index);
    if (character === 0) break;
    const next = text.charCodeAt(index + 1);
    if (character === 94 && Number.isFinite(next) && next !== 0 && next !== 94) { index++; continue; }
    // The VM's signed char values above 127 pass this source comparison.
    if (character < 128 && character > 0x7e) continue;
    result += text.charAt(index);
  }
  return result;
}

function inventory(state: BotState, index: BotInventory): number {
  const value = state.inventory[index];
  if (value === undefined) throw new RangeError(`Missing bot inventory slot ${index}`);
  return value;
}

function carrying(context: GameAiContext, state: BotState, colored: boolean): string {
  const team = botTeam(context, state);
  const prefix = colored ? team === Team.TEAM_RED ? "^1" : "^4" : "";
  if (context.gameType === GameType.GT_CTF && botCTFCarryingFlag(context, state) !== 0) return `${prefix}F `;
  if (context.game.options.product === "missionpack") {
    if (context.gameType === GameType.GT_1FCTF && bot1FCTFCarryingFlag(context, state)) return `${prefix}F `;
    if (context.gameType === GameType.GT_HARVESTER && botHarvesterCarryingCubes(context, state)) {
      return gameFormat("%s%2d", [prefix, inventory(state, team === Team.TEAM_RED ? BotInventory.REDCUBE : BotInventory.BLUECUBE)], 32);
    }
  }
  return "  ";
}

function actionDescription(context: GameAiContext, state: BotState, withGoal: boolean): string {
  switch (state.ltgType) {
    case BotLongTermGoal.TEAMHELP: return `helping ${easyClientName(context, state.teammate, 256)}`;
    case BotLongTermGoal.TEAMACCOMPANY: return `accompanying ${easyClientName(context, state.teammate, 256)}`;
    case BotLongTermGoal.DEFENDKEYAREA: return `defending ${context.library.goals.goalName(state.teamGoal.number)}`;
    case BotLongTermGoal.GETITEM: return `getting item ${context.library.goals.goalName(state.teamGoal.number)}`;
    case BotLongTermGoal.KILL: return `killing ${clientName(context, state.teamGoal.entity, 256)}`;
    case BotLongTermGoal.CAMP: case BotLongTermGoal.CAMPORDER: return "camping";
    case BotLongTermGoal.PATROL: return "patrolling";
    case BotLongTermGoal.GETFLAG: return "capturing flag";
    case BotLongTermGoal.RUSHBASE: return "rushing base";
    case BotLongTermGoal.RETURNFLAG: return "returning flag";
    case BotLongTermGoal.ATTACKENEMYBASE: return "attacking the enemy base";
    case BotLongTermGoal.HARVEST: return "harvesting";
    default: {
      if (!withGoal) return "roaming";
      const goal = context.library.goals.getTopGoal(state.gs);
      if (goal === null) throw new Error("BotSetInfoConfigString reads an uninitialized source goal when the goal stack is empty");
      return `roaming ${context.library.goals.goalName(goal.number)}`;
    }
  }
}

export function botReportStatus(context: GameAiContext, state: BotState): void {
  const name = clientName(context, state.client, 256);
  context.game.options.engine.print(gameFormat("%-20s%s%s: %s\n", [name, asciiEqual(name, state.teamLeader) ? "L" : " ", carrying(context, state, true), actionDescription(context, state, false)], 2048));
}

export function botTeamplayReport(context: GameAiContext): void {
  for (const team of [Team.TEAM_RED, Team.TEAM_BLUE]) {
    context.game.options.engine.print(team === Team.TEAM_RED ? "^1RED\n" : "^4BLUE\n");
    for (let index = 0; index < context.maxClients && index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      if (state === null || !state.inuse) continue;
      const info = context.game.options.configstrings.get(CS_PLAYERS + index).slice(0, 1023);
      if (info.length !== 0 && clientInfoValue(info, "n").length !== 0 && gameAtoi(clientInfoValue(info, "t")) === team) botReportStatus(context, state);
    }
  }
}

export function botTestAAS(context: GameAiContext, origin: Vec3): void {
  const solid = context.cvar("bot_testsolid"), clusters = context.cvar("bot_testclusters");
  solid.update();
  clusters.update();
  if (solid.integerValue !== 0) {
    if (!context.library.aasInitialized) return;
    context.game.options.engine.print(botPointAreaNum(context, origin) !== 0 ? "\remtpy area" : "\r^1SOLID area");
  } else if (clusters.integerValue !== 0) {
    if (!context.library.aasInitialized) return;
    const area = botPointAreaNum(context, origin);
    if (area === 0) context.game.options.engine.print("\r^1Solid!                              ");
    else {
      const phase = context.library.aas.phase;
      if (phase.kind !== "ready") throw new Error("BotTestAAS requires the initialized AAS world");
      const settings = phase.map.world.areaSettings[area];
      if (settings === undefined) throw new RangeError(`BotTestAAS area ${area} is outside AAS storage`);
      context.game.options.engine.print(gameFormat("\rarea %d, cluster %d       ", [area, settings.cluster], 2048));
    }
  }
}

export function botUpdateInfoConfigStrings(context: GameAiContext): void {
  for (let index = 0; index < context.maxClients && index < MAX_CLIENTS; index++) {
    const state = context.states.get(index);
    if (state === null || !state.inuse) continue;
    const info = context.game.options.configstrings.get(CS_PLAYERS + index).slice(0, 1023);
    if (info.length === 0 || clientInfoValue(info, "n").length === 0) continue;
    const leader = asciiEqual(clientName(context, state.client, 256), state.teamLeader) ? "L" : " ";
    context.game.options.configstrings.set(CS_BOTINFO + state.client, `l\\${leader}\\c\\${carrying(context, state, false)}\\a\\${actionDescription(context, state, true).slice(0, 255)}`);
  }
}

export function botTeamLeader(context: GameAiContext, state: BotState): boolean {
  const client = clientFromName(context, state.teamLeader);
  if (client < 0) return false;
  const leader = context.states.get(client);
  return leader !== null && leader.inuse;
}

function readSessionInteger(text: string, cursor: { offset: number }): number {
  let index = cursor.offset;
  if (index > text.length) throw new RangeError("Bot session scan reads past its source string");
  while (index < text.length) {
    const byte = text.charCodeAt(index), signed = byte < 128 ? byte : byte - 256;
    if (signed > 32) break;
    if (byte === 0) return 0;
    index++;
  }
  if (index === text.length) return 0;
  let sign = 1;
  if (text.charAt(index) === "-" || text.charAt(index) === "+") { if (text.charAt(index) === "-") sign = -1; index++; }
  let value = 0;
  while (true) {
    if (index > text.length) throw new RangeError("Bot session integer scan reads past its source string");
    const byte = index === text.length ? 0 : text.charCodeAt(index);
    index++;
    if (byte < 48 || byte > 57) break;
    value = (Math.imul(value, 10) + byte - 48) | 0;
  }
  cursor.offset = index;
  return Math.imul(value, sign);
}

function readSession(context: GameAiContext, state: BotState): void {
  const text = (context.game.options.cvars.get(`botsession${state.client}`)?.value ?? "").slice(0, 1023);
  const cursor = { offset: 0 }, goal = state.lastGoalTeamGoal;
  state.lastGoalDecisionmaker = readSessionInteger(text, cursor);
  state.lastGoalLtgType = readSessionInteger(text, cursor);
  state.lastGoalTeammate = readSessionInteger(text, cursor);
  goal.area = readSessionInteger(text, cursor);
  goal.entity = readSessionInteger(text, cursor);
  goal.flags = readSessionInteger(text, cursor);
  goal.itemInfo = readSessionInteger(text, cursor);
  goal.number = readSessionInteger(text, cursor);
  function next(): number { const result = scanGameFloat(text, cursor.offset); cursor.offset = result.nextOffset; return result.value; }
  for (const vector of [goal.origin, goal.mins, goal.maxs]) {
    Object.assign(vector, { x: next() });
    Object.assign(vector, { y: next() });
    Object.assign(vector, { z: next() });
  }
}

function writeSession(context: GameAiContext, state: BotState): void {
  const goal = state.lastGoalTeamGoal;
  const text = gameFormat("%i %i %i %i %i %i %i %i %f %f %f %f %f %f %f %f %f", [
    state.lastGoalDecisionmaker, state.lastGoalLtgType, state.lastGoalTeammate, goal.area, goal.entity, goal.flags, goal.itemInfo, goal.number,
    goal.origin.x, goal.origin.y, goal.origin.z, goal.mins.x, goal.mins.y, goal.mins.z, goal.maxs.x, goal.maxs.y, goal.maxs.z,
  ], 32000);
  context.game.options.cvars.set(`botsession${state.client}`, text, true);
}

/** A fresh instance represents a fresh game VM, while its library survives fast restart. */
export class GameAi {
  readonly context: GameAiContext;
  private localTime = 0;
  private botlibResidual = 0;
  private lastBotThinkTime = 0;

  constructor(game: GameRuntime, library: BotLibrary, host: GameAiHost) {
    this.context = new GameAiContext(game, library, host);
  }

  testAas(origin: Vec3): void { botTestAAS(this.context, origin); }

  setup(restart: boolean): boolean {
    const context = this.context;
    for (const [name, value] of setupCvars) {
      context.registerCvar(name, value, CvarFlag.Cheat);
    }
    context.registerCvar("bot_interbreedchar", "");
    context.registerCvar("bot_interbreedbots", "10");
    context.registerCvar("bot_interbreedcycle", "20");
    context.registerCvar("bot_interbreedwrite", "");
    if (restart) return true;
    context.states.clear();
    return this.initializeLibrary() === 0;
  }

  private initializeLibrary(): number {
    const { game, library } = this.context;
    const read = (name: string): string => (game.options.cvars.get(name)?.value ?? "").slice(0, 143);
    library.variables.set("maxclients", read("sv_maxclients") || "8");
    library.variables.set("maxentities", String(MAX_GENTITIES));
    for (const name of ["sv_mapChecksum", "max_aaslinks", "max_levelitems"]) { const value = read(name); if (value.length !== 0) library.variables.set(name, value); }
    const gameType = read("g_gametype") || "0";
    library.variables.set("g_gametype", gameType);
    library.variables.set("bot_developer", this.context.cvar("bot_developer").value);
    library.variables.set("log", gameType);
    if (read("bot_nochat").length !== 0) library.variables.set("nochat", "0");
    const forwarding: readonly (readonly [string, string])[] = [["bot_visualizejumppads", "bot_visualizejumppads"],
      ["bot_forceclustering", "forceclustering"], ["bot_forcereachability", "forcereachability"], ["bot_forcewrite", "forcewrite"],
      ["bot_aasoptimize", "aasoptimize"], ["bot_saveroutingcache", "saveroutingcache"]];
    for (const [source, destination] of forwarding) { const value = read(source); if (value.length !== 0) library.variables.set(destination, value); }
    library.variables.set("bot_reloadcharacters", read("bot_reloadcharacters") || "0");
    const directories: readonly (readonly [string, string])[] = [["fs_basepath", "basedir"], ["fs_game", "gamedir"], ["fs_cdpath", "cddir"]];
    for (const [source, destination] of directories) { const value = read(source); if (value.length !== 0) library.variables.set(destination, value); }
    if (game.options.product === "missionpack") library.globals.add("MISSIONPACK");
    return library.setup();
  }

  loadMap(restart: boolean): boolean {
    const context = this.context;
    if (!restart) {
      const mapName = context.game.options.cvars.registerVm("mapname", "", CvarFlag.ServerInfo | CvarFlag.ReadOnly);
      context.host.loadMap(mapName.value);
    }
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      if (state === null || !state.inuse) continue;
      context.resetState(state);
      state.setupCount = 4;
    }
    botSetupDeathmatchAI(context);
    return true;
  }

  setupClient(client: number, settings: BotSettings, restart: boolean): boolean {
    const context = this.context, library = context.library, state = context.states.acquire(client, context.game.memory);
    if (state.inuse) { context.game.options.engine.print(`^1Fatal: BotAISetupClient: client ${client} already setup\n`); return false; }
    state.setup = { kind: "setting-up", stage: "allocated" };
    if (!library.aasInitialized) {
      context.game.options.engine.print("^1Fatal: AAS not initialized\n");
      state.setup = { kind: "failed", stage: "aas" };
      return false;
    }
    state.character = library.characters.load(settings.characterfile, settings.skill);
    state.setup = { kind: "setting-up", stage: "character" };
    if (state.character === 0) {
      context.game.options.engine.print(gameFormat("^1Fatal: couldn't load skill %f from %s\n", [settings.skill, settings.characterfile], 2048));
      state.setup = { kind: "failed", stage: "character" };
      return false;
    }
    Object.assign(state.settings, settings);
    state.setup = { kind: "setting-up", stage: "settings" };
    state.gs = library.goals.allocGoalState(client);
    state.setup = { kind: "setting-up", stage: "goal-state" };
    const itemError = library.goals.loadItemWeights(state.gs, library.characters.string(state.character, Characteristic.ItemWeights).slice(0, 143));
    if (itemError !== 0) {
      library.goals.freeGoalState(state.gs);
      state.setup = { kind: "failed", stage: "item-weights", errorCode: itemError };
      return false;
    }
    state.setup = { kind: "setting-up", stage: "item-weights" };
    state.ws = library.weapons.allocateState();
    state.setup = { kind: "setting-up", stage: "weapon-state" };
    const weaponError = library.weapons.loadWeights(state.ws, library.characters.string(state.character, Characteristic.WeaponWeights).slice(0, 143));
    if (weaponError !== 0) {
      library.goals.freeGoalState(state.gs);
      library.weapons.freeState(state.ws);
      state.setup = { kind: "failed", stage: "weapon-weights", errorCode: weaponError };
      return false;
    }
    state.setup = { kind: "setting-up", stage: "weapon-weights" };
    state.cs = library.chat.allocate();
    state.setup = { kind: "setting-up", stage: "chat-state" };
    const filename = library.characters.string(state.character, Characteristic.ChatFile).slice(0, 143);
    const name = library.characters.string(state.character, Characteristic.ChatName).slice(0, 143);
    if (!library.chat.loadChatFile(state.cs, filename, name)) {
      library.chat.free(state.cs);
      library.goals.freeGoalState(state.gs);
      library.weapons.freeState(state.ws);
      state.setup = { kind: "failed", stage: "chat-file", errorCode: 8 };
      return false;
    }
    state.setup = { kind: "setting-up", stage: "chat-file" };
    const gender = library.characters.string(state.character, Characteristic.Gender).slice(0, 143);
    library.chat.setGender(state.cs, /^[fF]/.test(gender) ? ChatGender.Female : /^[mM]/.test(gender) ? ChatGender.Male : ChatGender.Genderless);
    state.setup = { kind: "setting-up", stage: "chat-gender" };
    state.inuse = true;
    state.client = client;
    state.entityNum = client;
    state.setupCount = 4;
    state.enterGameTime = context.time;
    state.setup = { kind: "setting-up", stage: "published" };
    state.ms = library.moveStates.allocate();
    state.setup = { kind: "setting-up", stage: "move-state" };
    state.walker = library.characters.boundedFloat(state.character, Characteristic.Walker, 0, 1);
    state.setup = { kind: "setting-up", stage: "walker" };
    context.numBots = (context.numBots + 1) | 0;
    state.setup = { kind: "setting-up", stage: "counted" };
    if ((context.game.options.cvars.get("bot_testichat")?.integerValue ?? 0) !== 0) { library.variables.set("bot_testichat", "1"); botChatTest(context, state); }
    this.scheduleThink();
    state.setup = { kind: "setting-up", stage: "scheduled" };
    if (context.interbreed) library.goals.mutateGoalFuzzyLogic(state.gs, 1);
    state.setup = { kind: "setting-up", stage: "interbred" };
    if (restart) readSession(context, state);
    state.setup = { kind: "complete" };
    return true;
  }

  shutdownClient(client: number, restart: boolean): boolean {
    const context = this.context, library = context.library, state = context.states.get(client);
    if (state === null || !state.inuse) return false;
    if (restart) writeSession(context, state);
    if (botChatExitGame(context, state)) library.chat.enterChat(state.cs, state.client, ChatDestination.All);
    library.moveStates.free(state.ms);
    library.goals.freeGoalState(state.gs);
    library.chat.free(state.cs);
    library.weapons.freeState(state.ws);
    library.characters.free(state.character);
    botFreeWaypoints(context, state.checkpoints);
    botFreeWaypoints(context, state.patrolPoints);
    botClearActivateGoalStack(context, state);
    state.clear();
    context.numBots = (context.numBots - 1) | 0;
    return true;
  }

  shutdown(restart: boolean): boolean {
    if (restart) {
      for (let index = 0; index < MAX_CLIENTS; index++) {
        const state = this.context.states.get(index);
        if (state !== null && state.inuse) this.shutdownClient(state.client, restart);
      }
    } else this.context.library.shutdown();
    return true;
  }

  private scheduleThink(): void {
    let botNumber = 0;
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = this.context.states.get(index);
      if (state === null || !state.inuse) continue;
      if (this.context.numBots === 0) throw new Error("BotScheduleBotThink divides by zero with an active bot");
      state.botThinkResidual = Math.trunc(Math.imul(this.context.cvar("bot_thinktime").integerValue, botNumber) / this.context.numBots) | 0;
      botNumber++;
    }
  }

  private ai(client: number, thinkTime: number): boolean {
    const context = this.context, library = context.library;
    library.actions.resetInput(client);
    const state = context.states.get(client);
    if (state === null || !state.inuse) { context.game.options.engine.print(`^1Fatal: BotAI: client ${client} is not setup\n`); return false; }
    const entity = context.game.pool.at(client);
    if (entity.inuse && entity.client !== null) copyBotPlayerState(state.curPs, entity.client.ps);
    while (true) {
      const command = context.host.getConsoleMessage(client);
      if (command === null) break;
      const buffer = command.slice(0, 1023), split = buffer.indexOf(" ");
      if (split < 0) continue;
      const verb = buffer.slice(0, split), argumentsText = removeColorEscapeSequences(buffer.slice(split + 1));
      if (asciiEqual(verb, "print") || asciiEqual(verb, "chat") || asciiEqual(verb, "tchat")) {
        if (argumentsText.length < 2) throw new Error("BotAI reads outside the source quoted server command buffer");
        library.chat.queueConsoleMessage(state.cs, asciiEqual(verb, "print") ? 0 : 1, argumentsText.slice(1, -1));
      } else if (context.game.options.product === "missionpack") {
        if (asciiEqual(verb, "vchat")) botVoiceChatCommand(context, state, 0, argumentsText);
        else if (asciiEqual(verb, "vtchat")) botVoiceChatCommand(context, state, 1, argumentsText);
        else if (asciiEqual(verb, "vtell")) botVoiceChatCommand(context, state, 2, argumentsText);
      }
    }
    botAddDeltaAngles(state);
    state.ltime = f(state.ltime + thinkTime);
    state.thinkTime = thinkTime;
    Object.assign(state.origin, state.curPs.origin);
    Object.assign(state.eye, state.curPs.origin);
    Object.assign(state.eye, { z: f(state.eye.z + f(state.curPs.viewheight)) });
    state.areaNum = botPointAreaNum(context, state.origin);
    botDeathmatchAI(context, state, thinkTime);
    library.actions.selectWeapon(state.client, state.weaponNum);
    botSubtractDeltaAngles(state);
    return true;
  }

  startFrame(time: number): boolean {
    if (!Number.isInteger(time) || time < -2147483648 || time > 2147483647) throw new RangeError("Bot frame time must be signed 32-bit milliseconds");
    const context = this.context, library = context.library;
    context.host.checkBotSpawn();
    for (const name of ["bot_rocketjump", "bot_grapple", "bot_fastchat", "bot_nochat", "bot_testrchat", "bot_thinktime", "bot_memorydump", "bot_saveroutingcache", "bot_pause", "bot_report"]) context.cvar(name).update();
    if (context.cvar("bot_report").integerValue !== 0) botUpdateInfoConfigStrings(context);
    if (context.cvar("bot_pause").integerValue !== 0) {
      for (let index = 0; index < MAX_CLIENTS; index++) {
        const state = context.states.get(index);
        if (state === null || !state.inuse || !this.connected(index)) continue;
        state.lastUcmd.forwardmove = 0; state.lastUcmd.rightmove = 0; state.lastUcmd.upmove = 0;
        state.lastUcmd.buttons = 0; state.lastUcmd.serverTime = time;
        context.host.userCommand(state.client, state.lastUcmd);
      }
      return true;
    }
    for (const name of ["bot_memorydump", "bot_saveroutingcache"]) {
      if (context.cvar(name).integerValue === 0) continue;
      library.variables.set(name.slice(4), "1");
      context.game.options.cvars.set(name, "0", true);
    }
    this.interbreeding();
    const botThinkTime = context.cvar("bot_thinktime").integerValue;
    if (botThinkTime > 200) context.game.options.cvars.set("bot_thinktime", "200", true);
    if (botThinkTime !== this.lastBotThinkTime) { this.lastBotThinkTime = botThinkTime; this.scheduleThink(); }
    const elapsed = (time - this.localTime) | 0;
    this.localTime = time;
    this.botlibResidual = (this.botlibResidual + elapsed) | 0;
    const thinkTime = elapsed > botThinkTime ? elapsed : botThinkTime;
    if (this.botlibResidual >= thinkTime) {
      this.botlibResidual = (this.botlibResidual - thinkTime) | 0;
      library.startFrame(f(f(time) / 1000));
      if (!library.aasInitialized) return false;
      for (let index = 0; index < MAX_GENTITIES; index++) library.updateEntity(index, this.entityObservation(index));
      if (context.regularUpdateTime < context.time) {
        library.goals.updateEntityItems();
        context.regularUpdateTime = f(context.time + f(0.3));
      }
    }
    context.time = library.time();
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      if (state === null || !state.inuse) continue;
      state.botThinkResidual = (state.botThinkResidual + elapsed) | 0;
      if (state.botThinkResidual < thinkTime) continue;
      state.botThinkResidual = (state.botThinkResidual - thinkTime) | 0;
      if (!library.aasInitialized) return false;
      if (this.connected(index)) this.ai(index, f(f(thinkTime) / 1000));
    }
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      if (state === null || !state.inuse || !this.connected(index)) continue;
      botUpdateInput(context, state, time, elapsed);
      context.host.userCommand(state.client, state.lastUcmd);
    }
    return true;
  }

  private connected(client: number): boolean {
    const gameClient = this.context.game.pool.at(client).client;
    if (gameClient === null) throw new Error("BotAIStartFrame reads a null game client");
    return gameClient.pers.connected === ConnectionState.CONNECTED;
  }

  private entityObservation(index: number): BotEntityUpdate | null {
    const game = this.context.game, entity = game.pool.at(index), source = entity.s, shared = entity.r;
    if (!entity.inuse || game.world.linkState(index)?.linked !== true || (shared.svFlags & ServerEntityFlags.NOCLIENT) !== 0) return null;
    if (source.eType === EntityType.ET_MISSILE && source.weapon !== Weapon.WP_GRAPPLING_HOOK) return null;
    if (source.eType > EntityType.ET_EVENTS) return null;
    if (game.options.product === "missionpack" && shared.contents === 0x40000000 && game.missiles.isProximityTrigger(entity)) return null;
    return { type: source.eType, flags: source.eFlags, origin: shared.currentOrigin, angles: index < MAX_CLIENTS ? source.apos.base : shared.currentAngles,
      oldOrigin: source.origin2, mins: shared.mins, maxs: shared.maxs, groundEntity: source.groundEntityNum,
      solid: shared.model.kind === "inline" ? 3 : 2, modelIndex: source.modelindex, modelIndex2: source.modelindex2, frame: source.frame,
      event: source.event, eventParameter: source.eventParm, powerups: source.powerups, weapon: source.weapon,
      legsAnimation: source.legsAnim, torsoAnimation: source.torsoAnim };
  }

  private interbreeding(): void {
    const context = this.context, variable = context.cvar("bot_interbreedchar");
    variable.update();
    if (variable.value.length === 0) return;
    if (context.gameType !== GameType.GT_TOURNAMENT) {
      context.game.options.cvars.set("g_gametype", String(GameType.GT_TOURNAMENT), true);
      context.game.match.exitLevel();
      return;
    }
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      if (state !== null && state.inuse) this.shutdownClient(state.client, false);
    }
    context.library.variables.set("bot_reloadcharacters", "1");
    for (let index = 0; index < context.cvar("bot_interbreedbots").integerValue; index++) {
      context.host.insertConsoleCommand(gameFormat("addbot %s 4 free %i %s%d\n", [variable.value, Math.imul(index, 50), variable.value, index], 32000));
    }
    context.game.options.cvars.set("bot_interbreedchar", "", true);
    context.interbreed = true;
  }

  interbreedEndMatch(): void {
    const context = this.context;
    if (!context.interbreed) return;
    context.interbreedMatchCount = (context.interbreedMatchCount + 1) | 0;
    if (context.interbreedMatchCount < context.cvar("bot_interbreedcycle").integerValue) return;
    context.interbreedMatchCount = 0;
    const output = context.cvar("bot_interbreedwrite");
    output.update();
    if (output.value.length !== 0) {
      let best: BotState | null = null, bestRank = 0;
      for (let index = 0; index < MAX_CLIENTS; index++) {
        const state = context.states.get(index);
        const rank = state !== null && state.inuse ? f((Math.imul(state.numKills, 2) - state.numDeaths) | 0) : -1;
        if (rank > bestRank) { bestRank = rank; best = state; }
      }
      if (best !== null) context.library.goals.saveGoalFuzzyLogic(best.gs, output.value);
      context.game.options.cvars.set("bot_interbreedwrite", "", true);
    }
    const ranks: number[] = [];
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      ranks.push(state !== null && state.inuse ? f((Math.imul(state.numKills, 2) - state.numDeaths) | 0) : -1);
    }
    const selection = context.library.geneticSelection(ranks);
    if (selection.kind === "selected") {
      const first = context.states.get(selection.parent1), second = context.states.get(selection.parent2), child = context.states.get(selection.child);
      if (first === null || second === null || child === null) throw new Error("Bot interbreeding selected an unallocated bot state");
      context.library.goals.interbreedGoalFuzzyLogic(first.gs, second.gs, child.gs);
      context.library.goals.mutateGoalFuzzyLogic(child.gs, 1);
    }
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const state = context.states.get(index);
      if (state !== null && state.inuse) { state.numKills = 0; state.numDeaths = 0; }
    }
  }
}
