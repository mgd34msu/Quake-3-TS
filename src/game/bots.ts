/*
 * Ported from id Software's code/game/g_bot.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonFileState } from "../assets/filesystem-state.ts";
import { CommonParseCursor } from "../core/common-parse.ts";
import type { CommonParseState } from "../core/common-parse.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { VmCvar } from "../core/cvar.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { sourceCommandText } from "../core/text.ts";
import { GameType, Team } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { BOT_SETTINGS_PATH_LENGTH } from "./ai-definitions.ts";
import type { BotSettings } from "./ai-state.ts";
import { gameFormat } from "./format.ts";
import type { GameMemory, GameMemoryAllocation } from "./memory.ts";
import { gameAtof, gameAtoi } from "./numeric.ts";
import type { GameRuntime } from "./runtime.ts";
import { pickTeam } from "./session.ts";
import { ConnectionState } from "./state.ts";

const MAX_INFOS = 1024, MAX_TEXT = 8192, MAX_INFO = 1024;
const BOT_BEGIN_DELAY_BASE = 2000, BOT_BEGIN_DELAY_INCREMENT = 1500;
const BOT_SPAWN_QUEUE_DEPTH = 16;

function equal(left: string, right: string): boolean {
  const fold = (text: string): string => sourceCommandText(text).replace(/[A-Z]/g, byte => String.fromCharCode(byte.charCodeAt(0) + 32));
  return fold(left) === fold(right);
}

/** Q_CleanStr strips color pairs and non-printable bytes, without renaming blanks. */
function clean(text: string): string {
  const input = sourceCommandText(text);
  let result = "";
  for (let i = 0; i < input.length; i++) {
    const character = input.charCodeAt(i);
    if (character === 94 && i + 1 < input.length && input.charCodeAt(i + 1) !== 94) { i++; continue; }
    if (character >= 32 && character <= 126) result += input.charAt(i);
  }
  return result;
}

/** G_ParseInfos uses the same COM_ParseExt state as other source game text. */
export function parseGameInfos(cursor: CommonParseCursor, maximum: number, parser: CommonParseState,
  print: (text: string) => void, memory: GameMemory, infos: GameMemoryAllocation[], start = infos.length): number {
  let count = 0;
  while (true) {
    const token = parser.parse(cursor);
    if (token.length === 0) break;
    if (token !== "{") { print("Missing { in info file\n"); break; }
    if (count === maximum) { print("Max infos exceeded\n"); break; }
    let info = "";
    while (true) {
      const key = parser.parse(cursor);
      if (key.length === 0) { print("Unexpected end of info file\n"); break; }
      if (key === "}") break;
      const value = parser.parse(cursor, false);
      info = infoSetValueForKey(info, key, value.length === 0 ? "<NULL>" : value, print);
    }
    const allocation = memory.allocate(info.length + "\\num\\".length + String(MAX_INFOS).length + 1);
    infos[start + count] = allocation;
    allocation.writeString(info);
    count++;
  }
  return count;
}

interface GameInfoCatalog { readonly infos: GameMemoryAllocation[]; count: number }

function catalogInfo(catalog: GameInfoCatalog, index: number): GameMemoryAllocation {
  const allocation = catalog.infos[index];
  if (allocation === undefined) throw new RangeError("Game catalog index has no source pointer");
  return allocation;
}

export interface GameBotCatalogHost {
  allocateClient(): number;
  setupClient(clientNum: number, settings: BotSettings, restart: boolean): boolean;
  shutdownClient(clientNum: number, restart: boolean): void;
}

/** Owns only g_bot.c catalogs, VM cvar and delayed begins; the game owns clients. */
export class GameBotCatalog {
  private readonly bots: GameInfoCatalog = { infos: [], count: 0 };
  private readonly arenas: GameInfoCatalog = { infos: [], count: 0 };
  private readonly queue = Array.from({ length: BOT_SPAWN_QUEUE_DEPTH }, () => ({ clientNum: 0, spawnTime: 0 }));
  private minimumPlayers: VmCvar | null = null;
  private checkMinimumTime = 0;

  constructor(readonly game: GameRuntime, private readonly files: CommonFileState,
    private readonly parser: CommonParseState, private readonly host: GameBotCatalogHost) {}

  get numBots(): number { return this.bots.count; }
  get numArenas(): number { return this.arenas.count; }
  private print(text: string): void { this.game.options.engine.print(text); }
  private cvarString(name: string, capacity = MAX_INFO): string {
    return (this.game.options.cvars.get(name)?.value ?? "").slice(0, capacity - 1);
  }
  private cvarInteger(name: string): number { return this.game.options.cvars.get(name)?.integerValue ?? 0; }
  private cvarValue(name: string): number { return gameAtof(this.cvarString(name, 128)); }
  private setCvar(name: string, value: string): void { this.game.options.cvars.set(name, value, true); }
  private setInfo(info: string, key: string, value: string): string {
    return infoSetValueForKey(info, key, value, text => this.print(text));
  }

  private loadFile(filename: string, destination: GameInfoCatalog): void {
    const opened = this.files.current.openRead(filename);
    if (opened === undefined) { this.print(`^1file not found: ${filename}\n`); return; }
    if (opened.length >= MAX_TEXT) {
      this.print(`^1file too large: ${filename} is ${opened.length}, max allowed is ${MAX_TEXT}`);
      this.files.current.closeFile(opened.file);
      return;
    }
    const buffer = new Uint8Array(opened.length);
    const copied = this.files.current.readInto(opened.file, buffer);
    this.files.current.closeFile(opened.file);
    const cursor = new CommonParseCursor(String.fromCharCode(...buffer.subarray(0, copied)),
      copied < opened.length ? "uninitialized" : "terminated");
    const parsed = parseGameInfos(cursor, MAX_INFOS - destination.count, this.parser,
      text => this.print(text), this.game.memory, destination.infos, destination.count);
    destination.count += parsed;
  }

  private loadCatalog(kind: "bots" | "arenas", destination: GameInfoCatalog): void {
    destination.count = 0;
    const variable = this.game.options.cvars.registerVm(kind === "bots" ? "g_botsFile" : "g_arenasFile", "", CvarFlag.Init | CvarFlag.ReadOnly);
    this.loadFile(variable.value || `scripts/${kind}.txt`, destination);
    const list = new Uint8Array(1024);
    const count = this.files.current.getFileList("scripts", kind === "bots" ? ".bot" : ".arena", list);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const end = list.indexOf(0, offset);
      if (end < 0) throw new RangeError("Game catalog file list has no filename terminator");
      const filename = `scripts/${String.fromCharCode(...list.subarray(offset, end))}`;
      if (filename.length >= 128) throw new RangeError("Game catalog filename exceeds source 128-byte storage");
      this.loadFile(filename, destination);
      offset = end + 1;
    }
    this.print(`${destination.count} ${kind} parsed\n`);
  }

  getBotInfoByNumber(number: number): string | null {
    if (number < 0 || number >= this.bots.count) { this.print(`^1Invalid bot number: ${number}\n`); return null; }
    return catalogInfo(this.bots, number).readString();
  }
  getBotInfoByName(name: string): string | null {
    for (let index = 0; index < this.bots.count; index++) {
      const info = catalogInfo(this.bots, index).readString();
      if (equal(infoValueForKey(info, "name"), name)) return info;
    }
    return null;
  }
  getArenaInfoByMap(map: string): string | null {
    for (let index = 0; index < this.arenas.count; index++) {
      const info = catalogInfo(this.arenas, index).readString();
      if (equal(infoValueForKey(info, "map"), map)) return info;
    }
    return null;
  }

  initializeBots(restart: boolean): void {
    if (this.cvarInteger("bot_enable") !== 0) this.loadCatalog("bots", this.bots);
    this.loadCatalog("arenas", this.arenas);
    for (let index = 0; index < this.arenas.count; index++) {
      const allocation = catalogInfo(this.arenas, index);
      allocation.writeString(this.setInfo(allocation.readString(), "num", String(index)));
    }
    this.minimumPlayers = this.game.options.cvars.registerVm("bot_minplayers", "0", CvarFlag.ServerInfo);
    if (this.game.gameType !== GameType.GT_SINGLE_PLAYER) return;
    const serverinfo = this.game.options.cvars.infoString(CvarFlag.ServerInfo);
    const arena = this.getArenaInfoByMap(infoValueForKey(serverinfo, "mapname").slice(0, 63));
    if (arena === null) return;
    const frag = infoValueForKey(arena, "fraglimit"), time = infoValueForKey(arena, "timelimit");
    const fragLimit = gameAtoi(frag), timeLimit = gameAtoi(time);
    this.setCvar("fraglimit", fragLimit !== 0 ? frag : "0");
    this.setCvar("timelimit", timeLimit !== 0 ? time : "0");
    if (fragLimit === 0 && timeLimit === 0) { this.setCvar("fraglimit", "10"); this.setCvar("timelimit", "0"); }
    const delay = BOT_BEGIN_DELAY_BASE + (equal(infoValueForKey(arena, "special"), "training") ? 10000 : 0);
    if (!restart) this.spawnBots(infoValueForKey(arena, "bots"), delay);
  }

  private spawnBots(botList: string, baseDelay: number): void {
    this.game.arenas.resetPodiumPlayers();
    let skill = this.cvarValue("g_spSkill");
    if (skill < 1) { this.setCvar("g_spSkill", "1"); skill = 1; }
    else if (skill > 5) { this.setCvar("g_spSkill", "5"); skill = 5; }
    const list = sourceCommandText(botList).slice(0, 1023);
    let position = 0, delay = baseDelay;
    while (position < list.length) {
      while (list.charAt(position) === " ") position++;
      const start = position;
      while (position < list.length && list.charAt(position) !== " ") position++;
      const bot = list.slice(start, position);
      if (position < list.length) position++;
      this.game.options.engine.insertConsoleCommand(gameFormat("addbot %s %f free %i\n", [bot, skill, delay]));
      delay = (delay + BOT_BEGIN_DELAY_INCREMENT) | 0;
    }
  }

  connect(clientNum: number, restart: boolean): boolean {
    const info = this.game.options.engine.getUserinfo(clientNum).slice(0, 1023);
    const settings: BotSettings = {
      characterfile: infoValueForKey(info, "characterfile").slice(0, BOT_SETTINGS_PATH_LENGTH - 1),
      skill: gameAtof(infoValueForKey(info, "skill")),
      team: infoValueForKey(info, "team").slice(0, BOT_SETTINGS_PATH_LENGTH - 1),
    };
    if (!this.host.setupClient(clientNum, settings, restart)) {
      this.game.options.engine.dropClient(clientNum, "BotAISetupClient failed");
      return false;
    }
    return true;
  }

  shutdownClient(clientNum: number, restart: boolean): void { this.host.shutdownClient(clientNum, restart); }

  private addBot(name: string, skill: number, requestedTeam: string, delay: number, alternateName: string): void {
    skill = Math.fround(skill);
    const info = this.getBotInfoByName(name);
    if (info === null) { this.print(`^1Error: Bot '${name}' not defined\n`); return; }
    let userinfo = "";
    const set = (key: string, value: string): void => { userinfo = this.setInfo(userinfo, key, value); };
    set("name", alternateName || infoValueForKey(info, "funname") || infoValueForKey(info, "name"));
    set("rate", "25000"); set("snaps", "20"); set("skill", gameFormat("%1.2f", [skill]));
    if (skill >= 1 && skill < 2) set("handicap", "50");
    else if (skill >= 2 && skill < 3) set("handicap", "70");
    else if (skill >= 3 && skill < 4) set("handicap", "90");
    const model = infoValueForKey(info, "model") || "visor/default";
    set("model", model); set("team_model", model);
    const headmodel = infoValueForKey(info, "headmodel") || model;
    set("headmodel", headmodel); set("team_headmodel", headmodel);
    set("sex", infoValueForKey(info, "gender") || "male");
    set("color1", infoValueForKey(info, "color1") || "4");
    set("color2", infoValueForKey(info, "color2") || "5");
    if (!infoValueForKey(info, "aifile")) { this.print("^1Error: bot has no aifile specified\n"); return; }
    const clientNum = this.host.allocateClient();
    if (clientNum === -1) {
      this.print("^1Unable to add bot.  All player slots are in use.\n");
      this.print("^1Start server with more 'open' slots (or check setting of sv_maxclients cvar).\n");
      return;
    }
    let team = requestedTeam;
    if (!team) {
      team = this.game.gameType >= GameType.GT_TEAM
        ? pickTeam({ clients: this.game.pool.clients, maxClients: this.game.pool.maxClients, teamScores: this.game.level.teamScores }, clientNum) === Team.TEAM_RED ? "red" : "blue"
        : "red";
    }
    set("characterfile", infoValueForKey(info, "aifile"));
    set("skill", gameFormat("%5.2f", [skill])); set("team", team);
    const bot = this.game.pool.at(clientNum);
    bot.r.svFlags |= ServerEntityFlags.BOT;
    bot.inuse = true;
    this.game.options.engine.setUserinfo(clientNum, userinfo);
    if (this.game.clientConnect(clientNum, true, true) !== null) return;
    if (delay === 0) { this.game.clientBegin(clientNum); return; }
    this.addToSpawnQueue(clientNum, delay);
  }

  consoleCommand(argv: readonly string[]): void {
    const command = argv[0] ?? "";
    if (equal(command, "botlist")) { this.listBots(); return; }
    if (!equal(command, "addbot") || this.cvarInteger("bot_enable") === 0) return;
    const argument = (index: number): string => sourceCommandText(argv[index] ?? "").slice(0, 1023);
    const name = argument(1);
    if (!name) { this.print("Usage: Addbot <botname> [skill 1-5] [team] [msec delay] [altname]\n"); return; }
    const skill = argument(2), delay = argument(4);
    this.addBot(name, skill ? gameAtof(skill) : 4, argument(3), delay ? gameAtoi(delay) : 0, argument(5));
    if (((this.game.level.time - this.game.level.startTime) | 0) > 1000 && this.cvarInteger("cl_running") !== 0) {
      this.game.options.engine.sendServerCommand(-1, "loaddefered\n");
    }
  }

  private listBots(): void {
    this.print("^1name             model            aifile              funname\n");
    for (let index = 0; index < this.bots.count; index++) {
      const info = catalogInfo(this.bots, index).readString();
      this.print(gameFormat("%-16s %-16s %-20s %-20s\n", [
        infoValueForKey(info, "name") || "UnnamedPlayer", infoValueForKey(info, "model") || "visor/default",
        infoValueForKey(info, "aifile") || "bots/default_c.c", infoValueForKey(info, "funname"),
      ]));
    }
  }

  private addToSpawnQueue(clientNum: number, delay: number): void {
    for (const slot of this.queue) if (slot.spawnTime === 0) {
      slot.spawnTime = (this.game.level.time + delay) | 0;
      slot.clientNum = clientNum;
      return;
    }
    this.print("^3Unable to delay spawn\n");
    this.game.clientBegin(clientNum);
  }

  removeQueuedBegin(clientNum: number): void {
    for (const slot of this.queue) if (slot.clientNum === clientNum) { slot.spawnTime = 0; return; }
  }

  checkSpawn(): void {
    this.checkMinimumPlayers();
    for (const slot of this.queue) {
      if (slot.spawnTime === 0 || slot.spawnTime > this.game.level.time) continue;
      this.game.clientBegin(slot.clientNum);
      slot.spawnTime = 0;
      if (this.game.gameType === GameType.GT_SINGLE_PLAYER) {
        const userinfo = this.game.options.engine.getUserinfo(slot.clientNum).slice(0, 1023);
        const model = infoValueForKey(userinfo, "model").slice(0, 63);
        const slash = model.lastIndexOf("/");
        let skin = slash < 0 ? model : model.slice(slash + 1);
        if (equal(skin, "default")) skin = slash < 0 ? model : model.slice(0, slash);
        this.game.options.engine.appendConsoleCommand(gameFormat("play sound/player/announce/%s.wav\n", [skin]));
      }
    }
  }

  private eligibleClient(number: number, team: number, bot: boolean): boolean {
    const client = this.game.pool.clientAt(number);
    return client.pers.connected === ConnectionState.CONNECTED
      && ((this.game.pool.at(client.ps.clientNum).r.svFlags & ServerEntityFlags.BOT) !== 0) === bot
      && (team < 0 || client.sess.sessionTeam === team);
  }

  countHumanPlayers(team: number): number {
    let count = 0;
    for (let i = 0; i < this.game.pool.maxClients; i++) if (this.eligibleClient(i, team, false)) count++;
    return count;
  }
  countBotPlayers(team: number): number {
    let count = 0;
    for (let i = 0; i < this.game.pool.maxClients; i++) if (this.eligibleClient(i, team, true)) count++;
    // Source counts due queued begins for every team, and excludes future begins.
    for (const slot of this.queue) if (slot.spawnTime !== 0 && slot.spawnTime <= this.game.level.time) count++;
    return count;
  }

  private nameInUse(name: string, team: number): boolean {
    for (let i = 0; i < this.game.pool.maxClients; i++) {
      if (this.eligibleClient(i, team, true) && equal(name, this.game.pool.clientAt(i).pers.netname)) return true;
    }
    return false;
  }
  addRandomBot(team: number): void {
    let count = 0;
    for (let index = 0; index < this.bots.count; index++) {
      if (!this.nameInUse(infoValueForKey(catalogInfo(this.bots, index).readString(), "name"), team)) count++;
    }
    let selected = qvmFloatToInt(Math.fround(this.game.random.random() * count));
    for (let index = 0; index < this.bots.count; index++) {
      const info = catalogInfo(this.bots, index).readString();
      const name = infoValueForKey(info, "name");
      if (this.nameInUse(name, team)) continue;
      selected--;
      if (selected > 0) continue;
      const skill = this.cvarValue("g_spSkill");
      const teamName = team === Team.TEAM_RED ? "red" : team === Team.TEAM_BLUE ? "blue" : "";
      this.game.options.engine.insertConsoleCommand(gameFormat("addbot %s %f %s %i\n", [clean(name.slice(0, 35)), skill, teamName, 0]));
      return;
    }
  }

  removeRandomBot(team: number): boolean {
    for (let i = 0; i < this.game.pool.maxClients; i++) {
      if (!this.eligibleClient(i, team, true)) continue;
      const name = this.game.pool.clientAt(i).pers.netname;
      if (name.length >= 36) throw new RangeError("Bot netname exceeds source 36-byte storage");
      this.game.options.engine.insertConsoleCommand(gameFormat("kick %s\n", [clean(name)]));
      return true;
    }
    return false;
  }

  checkMinimumPlayers(): void {
    if (this.game.level.intermissionTime !== 0) return;
    const time = this.game.level.time;
    if (this.checkMinimumTime > ((time - 10000) | 0)) return;
    this.checkMinimumTime = time;
    if (this.minimumPlayers === null) throw new Error("G_CheckMinimumPlayers requires G_InitBots");
    this.minimumPlayers.update();
    let minimum = this.minimumPlayers.integerValue;
    if (minimum <= 0) return;
    const maxClients = this.game.pool.maxClients;
    const check = (countTeam: number, addTeam: number, removeTeam: number, tournament: boolean): void => {
      const humans = this.countHumanPlayers(countTeam), bots = this.countBotPlayers(countTeam);
      if (humans + bots < minimum) this.addRandomBot(addTeam);
      else if (humans + bots > minimum && bots !== 0) {
        if (!tournament || !this.removeRandomBot(Team.TEAM_SPECTATOR)) this.removeRandomBot(removeTeam);
      }
    };
    if (this.game.gameType >= GameType.GT_TEAM) {
      const half = Math.trunc(maxClients / 2);
      if (minimum >= half) minimum = half - 1;
      check(Team.TEAM_RED, Team.TEAM_RED, Team.TEAM_RED, false);
      check(Team.TEAM_BLUE, Team.TEAM_BLUE, Team.TEAM_BLUE, false);
    } else if (this.game.gameType === GameType.GT_TOURNAMENT) {
      if (minimum >= maxClients) minimum = maxClients - 1;
      check(-1, Team.TEAM_FREE, -1, true);
    } else if (this.game.gameType === GameType.GT_FFA) {
      if (minimum >= maxClients) minimum = maxClients - 1;
      check(Team.TEAM_FREE, Team.TEAM_FREE, Team.TEAM_FREE, false);
    }
  }
}
