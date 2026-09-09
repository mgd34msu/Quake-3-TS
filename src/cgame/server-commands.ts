// Ported from id Software's code/cgame/cg_servercmds.c, plus
// cg_main.c CG_StartMusic/CG_BuildSpectatorString and q_shared.c COM_ParseExt.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PlayerGender } from "../assets/animation.ts";
import type { PcmSound } from "../assets/wav.ts";
import type { CvarSnapshot } from "../core/cvar.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { gameAtoi } from "../game/numeric.ts";
import type { GameRandom } from "../game/numeric.ts";
import type { RendererResources } from "../render/world.ts";
import type { SoundAssetReader } from "./sound-bank.ts";
import { GameType, Team } from "../shared/definitions.ts";
import type { ClientInfoStore } from "./players.ts";
import type { ClientEntity, ClientGameState, ClientGameStaticState, ClientScore } from "./state.ts";

export type ClientServerCommandCvar = "cg_teamChatHeight" | "cg_teamChatTime" | "cg_teamChatsOnly" | "cg_showmiss"
  | "ui_singlePlayerActive" | "ui_recordSPDemo" | "ui_recordSPDemoName" | "com_buildScript" | "cg_noVoiceChats" | "cg_noVoiceText" | "cg_noTaunt";
export type ClientServerCommandSound = "countPrepareSound" | "countPrepareTeamSound" | "countFightSound" | "talkSound" | "voteNow" | "votePassed" | "voteFailed";

export interface ClientServerCommandHost {
  readonly state: ClientGameState;
  readonly staticState: ClientGameStaticState;
  readonly clients: Pick<ClientInfoStore, "clientInfo" | "newClientInfo" | "loadDeferredPlayers" | "reset">;
  readonly resources: Pick<RendererResources, "registerModel">;
  readonly assets: SoundAssetReader;
  readonly random: Pick<GameRandom, "random">;
  resetPlayerEntity(entity: ClientEntity): void;
  /** The engine claims disconnect/bcs commands and integrates cs at this sequence. */
  getServerCommand(sequence: number): readonly string[] | null | Promise<readonly string[] | null>;
  /** Copies the engine gamestate into the cgame-owned configstring snapshot. */
  refreshGameState(): void;
  configString(index: number): string;
  readVmCvar(name: ClientServerCommandCvar): CvarSnapshot;
  setCvar(name: string, value: string): void;
  print(text: string): void;
  centerPrint(text: string, y: number, charWidth: number): void;
  sendConsoleCommand(text: string): void;
  sound(name: ClientServerCommandSound): PcmSound | null;
  registerSound(path: string, compressed: boolean): Promise<PcmSound | null>;
  startLocalSound(sound: PcmSound | null, channel: number): void;
  startBackgroundTrack(intro: string, loop: string): Promise<void>;
  remapShader(original: string, replacement: string, timeOffset: string): Promise<void>;
  clearLocalEntities(): void;
  clearMarks(): void;
  clearParticles(): void | Promise<void>;
  clearLoopingSounds(killAll: boolean): void;
  setScoreSelection(): void;
  showResponseHead(): Promise<void>;
  memoryRemaining(): number;
}

interface VoiceChat { id: string; numSounds: number; sounds: (PcmSound | null)[]; chats: string[] }
interface VoiceChatList { name: string; gender: PlayerGender; numVoiceChats: number; voiceChats: VoiceChat[] }
interface HeadVoice { headmodel: string; voiceChatNum: number }
interface BufferedVoice { clientNum: number; snd: PcmSound | null; voiceOnly: boolean; cmd: string; message: string }
function emptyVoice(): BufferedVoice { return { clientNum: 0, snd: null, voiceOnly: false, cmd: "", message: "" }; }
function emptyList(): VoiceChatList {
  return { name: "", gender: "male", numVoiceChats: 0, voiceChats: Array.from({ length: 64 }, () => ({ id: "", numSounds: 0,
    sounds: Array.from({ length: 64 }, () => null), chats: Array.from({ length: 64 }, () => "") })) };
}
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new RangeError(`Source array index ${index} outside ${items.length}`);
  return value;
}
function bytes(input: string): string {
  const nul = input.indexOf("\0"), text = nul < 0 ? input : input.slice(0, nul);
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 255) throw new RangeError("Cgame text requires source byte characters");
  return text;
}
function fold(text: string): string { return text.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32)); }
function argv(values: readonly string[], index: number): string {
  const value = values[index];
  return value === undefined ? "" : bytes(value).slice(0, 1023);
}
function integer(values: readonly string[], index: number): number { return gameAtoi(argv(values, index)); }
function commandCopy(values: readonly string[]): readonly string[] {
  if (values.length > 1024) throw new RangeError("Server command exceeds MAX_STRING_TOKENS");
  return values.map(value => bytes(value).slice(0, 1023));
}
/** COM_ParseExt byte semantics differ from the generic asset tokenizer inside CRLF quotes. */
class SourceByteTokenizer {
  private offset = 0;
  private readonly text: string;
  constructor(input: string) { this.text = bytes(input); }
  private byte(): number {
    if (this.offset >= this.text.length) return 0;
    const value = this.text.charCodeAt(this.offset); return value >= 128 ? value - 256 : value;
  }
  next(allowLineBreaks = true): string {
    let newline = false;
    while (true) {
      while (this.byte() <= 32) {
        if (this.byte() === 0) return "";
        if (this.byte() === 10) newline = true;
        this.offset++;
      }
      if (newline && !allowLineBreaks) return "";
      if (this.text.startsWith("//", this.offset)) {
        this.offset += 2; while (this.byte() !== 0 && this.byte() !== 10) this.offset++;
      } else if (this.text.startsWith("/*", this.offset)) {
        this.offset += 2;
        while (this.byte() !== 0 && !this.text.startsWith("*/", this.offset)) this.offset++;
        if (this.byte() !== 0) this.offset += 2;
      } else break;
    }
    if (this.byte() === 34) {
      const start = ++this.offset;
      while (this.byte() !== 0 && this.byte() !== 34) this.offset++;
      const value = this.text.slice(start, this.offset);
      if (value.length >= 1024) throw new RangeError("Quoted source token overflows MAX_TOKEN_CHARS");
      if (this.byte() === 34) this.offset++;
      return value;
    }
    const start = this.offset;
    while (this.byte() > 32) this.offset++;
    const value = this.text.slice(start, this.offset);
    return value.length >= 1024 ? "" : value;
  }
}
function validGameType(value: number): GameType {
  switch (value) {
    case GameType.GT_FFA: case GameType.GT_TOURNAMENT: case GameType.GT_SINGLE_PLAYER: case GameType.GT_TEAM:
    case GameType.GT_CTF: case GameType.GT_1FCTF: case GameType.GT_OBELISK: case GameType.GT_HARVESTER: return value;
    default: throw new RangeError(`Invalid server game type ${value}`);
  }
}
function emptyScore(): ClientScore {
  return { client: 0, score: 0, ping: 0, time: 0, scoreFlags: 0, accuracy: 0, impressiveCount: 0, excellentCount: 0,
    guantletCount: 0, defendCount: 0, assistCount: 0, perfect: 0, captures: 0, team: Team.TEAM_FREE };
}
function orderTask(command: string): number {
  switch (fold(command)) {
    case "getflag": case "offense": return 1;
    case "defend": case "defendflag": return 2;
    case "patrol": return 3;
    case "followme": return 4;
    case "returnflag": return 5;
    case "followflagcarrier": return 6;
    case "camp": return 7;
    default: return -1;
  }
}

/** An awaited command stream. Rejection or disposal permanently stops this instance. */
export class ClientServerCommandRuntime {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly voiceLists = Array.from({ length: 8 }, emptyList);
  private readonly headVoices: HeadVoice[] = Array.from({ length: 64 }, () => ({ headmodel: "", voiceChatNum: 0 }));
  private readonly voices = Array.from({ length: 32 }, emptyVoice);
  constructor(readonly host: ClientServerCommandHost) {
    if (host.state.product !== host.staticState.product) throw new Error("Cgame state products differ");
    for (let i = 0; i < 64; i++) if (host.clients.clientInfo(i) !== at(host.staticState.clientInfo, i)) throw new Error("ClientInfoStore must use canonical cgs slots");
  }
  dispose(): void { this.closed = true; this.host.clients.reset(); }
  private open(): void { if (this.closed) throw new Error("Cgame command runtime is closed"); }
  private async wait<T>(promise: Promise<T>): Promise<T> { const result = await promise; this.open(); return result; }
  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(async () => { this.open(); await work(); }).catch((error: unknown) => {
      if (!this.closed) this.dispose();
      throw error;
    });
    this.pending = next;
    return next;
  }
  private cvar(name: ClientServerCommandCvar): CvarSnapshot { return this.host.readVmCvar(name); }
  private config(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= 1024) throw new RangeError("CG_ConfigString: bad index");
    const value = bytes(this.host.configString(index));
    if (value.length >= 16000) throw new RangeError("Configstring exceeds MAX_GAMESTATE_CHARS");
    return value;
  }
  private localSound(name: ClientServerCommandSound, channel = 7): void { this.host.startLocalSound(this.host.sound(name), channel); }

  executeNewServerCommands(latestSequence: number): Promise<void> {
    if (!Number.isInteger(latestSequence) || latestSequence < 0 || latestSequence > 0x7fffffff) return Promise.reject(new RangeError("Invalid reliable command sequence"));
    return this.queue(async () => {
      while (this.host.staticState.serverCommandSequence < latestSequence) {
        const sequence = ++this.host.staticState.serverCommandSequence;
        const command = await this.host.getServerCommand(sequence);
        this.open();
        if (command !== null) await this.dispatch(commandCopy(command));
      }
    });
  }
  executeCommand(command: readonly string[]): Promise<void> {
    const owned = commandCopy(command);
    return this.queue(() => this.dispatch(owned));
  }

  parseServerInfo(): void {
    this.open();
    const info = this.config(0), state = this.host.staticState;
    const value = (key: string) => infoValueForKey(info, key, 8192);
    state.gameType = validGameType(gameAtoi(value("g_gametype")));
    this.host.setCvar("g_gametype", String(state.gameType));
    state.dmFlags = gameAtoi(value("dmflags")); state.teamFlags = gameAtoi(value("teamflags"));
    state.fraglimit = gameAtoi(value("fraglimit")); state.capturelimit = gameAtoi(value("capturelimit"));
    state.timelimit = gameAtoi(value("timelimit")); state.maxclients = gameAtoi(value("sv_maxclients"));
    state.mapname = `maps/${value("mapname")}.bsp`.slice(0, 63);
    state.redTeam = value("g_redTeam").slice(0, 63); this.host.setCvar("g_redTeam", state.redTeam);
    state.blueTeam = value("g_blueTeam").slice(0, 63); this.host.setCvar("g_blueTeam", state.blueTeam);
  }
  private flagStatus(): void {
    const value = this.config(23), state = this.host.staticState;
    if (state.gameType === GameType.GT_CTF) {
      if (value.length < 1) throw new RangeError("CTF flag status leaves source bytes uninitialized");
      state.redflag = value.charCodeAt(0) - 48;
      state.blueflag = (value.length === 1 ? 0 : value.charCodeAt(1)) - 48;
    } else if (this.host.state.product === "missionpack" && state.gameType === GameType.GT_1FCTF) state.flagStatus = (value.length === 0 ? 0 : value.charCodeAt(0)) - 48;
  }
  setConfigValues(): void {
    this.open(); const state = this.host.staticState;
    state.scores1 = gameAtoi(this.config(6)); state.scores2 = gameAtoi(this.config(7)); state.levelStartTime = gameAtoi(this.config(21));
    this.flagStatus(); this.host.state.warmup = gameAtoi(this.config(5));
  }
  private parseWarmup(): void {
    const state = this.host.state, warmup = gameAtoi(this.config(5)); state.warmupCount = -1;
    if (warmup > 0 && state.warmup <= 0) this.localSound(state.product === "missionpack"
      && this.host.staticState.gameType >= GameType.GT_CTF && this.host.staticState.gameType <= GameType.GT_HARVESTER ? "countPrepareTeamSound" : "countPrepareSound");
    state.warmup = warmup;
  }
  private parseScores(command: readonly string[]): void {
    const state = this.host.state;
    state.numScores = Math.min(integer(command, 1), 64);
    state.teamScores[0] = integer(command, 2); state.teamScores[1] = integer(command, 3);
    for (let i = 0; i < 64; i++) Object.assign(at(state.scores, i), emptyScore());
    for (let i = 0; i < state.numScores; i++) {
      const base = i * 14, clientNumber = integer(command, base + 4);
      const client = clientNumber < 0 || clientNumber >= 64 ? 0 : clientNumber, info = this.host.clients.clientInfo(client);
      const score: ClientScore = { client, score: integer(command, base + 5), ping: integer(command, base + 6), time: integer(command, base + 7),
        scoreFlags: integer(command, base + 8), accuracy: integer(command, base + 10), impressiveCount: integer(command, base + 11),
        excellentCount: integer(command, base + 12), guantletCount: integer(command, base + 13), defendCount: integer(command, base + 14),
        assistCount: integer(command, base + 15), perfect: integer(command, base + 16), captures: integer(command, base + 17), team: info.team };
      Object.assign(at(state.scores, i), score); info.score = score.score; info.powerups = integer(command, base + 9);
    }
    if (state.product === "missionpack") this.host.setScoreSelection();
  }
  private parseTeamInfo(command: readonly string[]): void {
    const count = integer(command, 1), state = this.host.state;
    if (count > 8) throw new RangeError("Team overlay exceeds TEAM_MAXOVERLAY");
    state.numSortedTeamPlayers = count;
    for (let i = 0; i < count; i++) {
      const client = integer(command, i * 6 + 2), info = this.host.clients.clientInfo(client);
      state.sortedTeamPlayers[i] = client;
      info.location = integer(command, i * 6 + 3); info.health = integer(command, i * 6 + 4);
      info.armor = integer(command, i * 6 + 5); info.curWeapon = integer(command, i * 6 + 6); info.powerups = integer(command, i * 6 + 7);
    }
  }
  async shaderStateChanged(): Promise<void> {
    this.open(); const value = this.config(24); let offset = 0;
    while (offset < value.length) {
      const equals = value.indexOf("=", offset); if (equals < 0) break;
      const colon = value.indexOf(":", equals + 1); if (colon < 0) break;
      const end = value.indexOf("@", colon + 1); if (end < 0) break;
      const original = value.slice(offset, equals), replacement = value.slice(equals + 1, colon), time = value.slice(colon + 1, end);
      if (original.length >= 64 || replacement.length >= 64 || time.length >= 16) throw new RangeError("Shader remap exceeds source scratch buffers");
      await this.wait(this.host.remapShader(original, replacement, time)); offset = end + 1;
    }
  }
  async startMusic(): Promise<void> {
    this.open(); const tokenizer = new SourceByteTokenizer(this.config(2));
    const first = tokenizer.next(), second = tokenizer.next();
    await this.wait(this.host.startBackgroundTrack(first.slice(0, 63), second.slice(0, 63)));
  }
  buildSpectatorString(): void {
    this.open(); const state = this.host.state; state.spectatorList = "";
    for (let i = 0; i < 64; i++) {
      const info = this.host.clients.clientInfo(i);
      if (info.infoValid && info.team === Team.TEAM_SPECTATOR) state.spectatorList = `${state.spectatorList}${info.name}     `.slice(0, 1023);
    }
    if (state.spectatorList.length !== state.spectatorLen) { state.spectatorLen = state.spectatorList.length; state.spectatorWidth = -1; }
  }
  private async configModified(command: readonly string[]): Promise<void> {
    const index = integer(command, 1); this.host.refreshGameState();
    const value = this.config(index), state = this.host.staticState;
    switch (index) {
      case 0: this.parseServerInfo(); return;
      case 2: await this.startMusic(); return;
      case 5: this.parseWarmup(); return;
      case 6: state.scores1 = gameAtoi(value); return;
      case 7: state.scores2 = gameAtoi(value); return;
      case 8: state.voteTime = gameAtoi(value); state.voteModified = true; return;
      case 9: state.voteString = value.slice(0, 1023); if (this.host.state.product === "missionpack") this.localSound("voteNow"); return;
      case 10: state.voteYes = gameAtoi(value); state.voteModified = true; return;
      case 11: state.voteNo = gameAtoi(value); state.voteModified = true; return;
      case 21: state.levelStartTime = gameAtoi(value); return;
      case 22: this.host.state.intermissionStarted = gameAtoi(value) !== 0; return;
      case 23: this.flagStatus(); return;
      case 24: await this.shaderStateChanged(); return;
    }
    if (index >= 12 && index <= 19) {
      const slot = index % 2;
      if (index < 14) { state.teamVoteTime[slot] = gameAtoi(value); state.teamVoteModified[slot] = true; }
      else if (index < 16) {
        if (value.length >= 1024) throw new RangeError("Team vote string exceeds source row buffer");
        state.teamVoteString[slot] = value; if (this.host.state.product === "missionpack") this.localSound("voteNow");
      }
      else if (index < 18) { state.teamVoteYes[slot] = gameAtoi(value); state.teamVoteModified[slot] = true; }
      else { state.teamVoteNo[slot] = gameAtoi(value); state.teamVoteModified[slot] = true; }
    } else if (index >= 32 && index < 288) state.gameModels[index - 32] = await this.wait(this.host.resources.registerModel(value));
    else if (index >= 288 && index < 544) {
      if (!value.startsWith("*")) state.gameSounds[index - 288] = await this.wait(this.host.registerSound(value, false));
    } else if (index >= 544 && index < 608) {
      await this.wait(this.host.clients.newClientInfo(index - 544, value));
      this.buildSpectatorString();
    }
  }

  addToTeamChat(input: string): void {
    this.open(); const height = Math.min(this.cvar("cg_teamChatHeight").integerValue, 8), state = this.host.staticState;
    if (height <= 0 || this.cvar("cg_teamChatTime").integerValue <= 0) { state.teamChatPos = 0; state.teamLastChatPos = 0; return; }
    const text = bytes(input); let offset = 0, line = "", visible = 0, lastSpace = -1, color = "7";
    const publish = () => {
      if (line.length > 240) throw new RangeError("Team chat exceeds source color-expanded line buffer");
      state.teamChatMsgs[state.teamChatPos % height] = line; state.teamChatMsgTimes[state.teamChatPos % height] = this.host.state.time;
      state.teamChatPos = (state.teamChatPos + 1) | 0;
    };
    while (offset < text.length) {
      if (visible > 79) {
        if (lastSpace >= 0) { offset -= line.length - lastSpace; offset++; line = line.slice(0, lastSpace); }
        publish(); line = `^${color}`; visible = 0; lastSpace = -1;
      }
      const character = text.charAt(offset), next = text.charAt(offset + 1);
      if (character === "^" && next !== "" && next !== "^") { line += character + next; color = next; offset += 2; continue; }
      if (character === " ") lastSpace = line.length;
      line += character; offset++; visible++;
    }
    publish();
    if (state.teamChatPos - state.teamLastChatPos > height) state.teamLastChatPos = state.teamChatPos - height;
  }
  private async mapRestart(): Promise<void> {
    const state = this.host.state;
    if (this.cvar("cg_showmiss").integerValue !== 0) this.host.print("CG_MapRestart\n");
    this.host.clearLocalEntities(); this.host.clearMarks(); await this.host.clearParticles();
    state.fraglimitWarnings = 0; state.timelimitWarnings = 0; state.intermissionStarted = false;
    this.host.staticState.voteTime = 0; state.mapRestart = true;
    await this.startMusic(); this.host.clearLoopingSounds(true);
    if (state.warmup === 0) { this.localSound("countFightSound"); this.host.centerPrint("FIGHT!", 120, 64); }
    if (state.product === "missionpack" && this.cvar("ui_singlePlayerActive").integerValue !== 0) {
      this.host.setCvar("ui_matchStartTime", String(state.time));
      const demo = bytes(this.cvar("ui_recordSPDemoName").value);
      if (this.cvar("ui_recordSPDemo").integerValue !== 0 && demo !== "") this.host.sendConsoleCommand(`set g_synchronousclients 1 ; record ${demo} \n`);
    }
    this.host.setCvar("cg_thirdPerson", "0");
  }

  private async dispatch(command: readonly string[]): Promise<void> {
    const name = argv(command, 0), state = this.host.state;
    switch (name) {
      case "": return;
      case "cp": this.host.centerPrint(argv(command, 1), state.product === "baseq3" ? 143 : 144, 16); return;
      case "cs": await this.configModified(command); return;
      case "print": {
        const value = argv(command, 1); this.host.print(value);
        if (state.product === "missionpack") {
          const text = fold(value);
          if (text.startsWith("vote failed") || text.startsWith("team vote failed")) this.localSound("voteFailed");
          else if (text.startsWith("vote passed") || text.startsWith("team vote passed")) this.localSound("votePassed");
        }
        return;
      }
      case "chat": case "tchat": {
        if (name === "chat" && this.cvar("cg_teamChatsOnly").integerValue !== 0) return;
        this.localSound("talkSound", 6);
        const value = argv(command, 1).slice(0, 149).replace(/\x19/g, "");
        if (name === "tchat") this.addToTeamChat(value);
        this.host.print(`${value}\n`); return;
      }
      case "vchat": case "vtchat": case "vtell":
        if (state.product === "missionpack") {
          const id = argv(command, 4);
          if (this.cvar("cg_noTaunt").integerValue !== 0 && ["kill_insult", "taunt", "death_insult", "kill_gauntlet", "praise"].includes(id)) return;
          await this.voiceChatLocal(name === "vchat" ? 0 : name === "vtchat" ? 1 : 2, integer(command, 1) !== 0, integer(command, 2), integer(command, 3), id);
        }
        return;
      case "scores": this.parseScores(command); return;
      case "tinfo": this.parseTeamInfo(command); return;
      case "map_restart": await this.mapRestart(); return;
      case "loaddefered": await this.wait(this.host.clients.loadDeferredPlayers(entity => this.host.resetPlayerEntity(entity))); return;
      case "clientLevelShot": state.levelShot = true; return;
    }
    let remainingName = name;
    if (fold(name) === "remapshader" && command.length === 4) {
      // Q3_VM evaluates argv1/2/3 in order; every pointer aliases CG_Argv's one static buffer.
      remainingName = argv(command, 3);
      await this.wait(this.host.remapShader(remainingName, remainingName, remainingName));
      if (remainingName === "loaddefered") { await this.wait(this.host.clients.loadDeferredPlayers(entity => this.host.resetPlayerEntity(entity))); return; }
      if (remainingName === "clientLevelShot") { state.levelShot = true; return; }
    }
    this.host.print(`Unknown client game command: ${remainingName}\n`);
  }

  private async voiceFile(filename: string, missingWarning: boolean): Promise<string | null> {
    this.open();
    if (!this.host.assets.has(filename)) {
      if (missingWarning) this.host.print(`^1voice chat file not found: ${filename}\n`);
      return null;
    }
    const data = await this.wait(this.host.assets.read(filename));
    if (data.length >= 16384) { this.host.print(`^1voice chat file too large: ${filename} is ${data.length}, max allowed is 16384`); return null; }
    return bytes(String.fromCharCode(...data));
  }
  async parseVoiceChats(filename: string, listIndex: number, maximumChats = 64): Promise<boolean> {
    this.open();
    if (!Number.isInteger(maximumChats) || maximumChats < 1 || maximumChats > 64) throw new RangeError("Invalid voice chat count");
    const compressed = this.cvar("com_buildScript").integerValue === 0;
    const list = at(this.voiceLists, listIndex), text = await this.voiceFile(filename, true);
    if (text === null) return false;
    list.name = bytes(filename).slice(0, 63);
    for (let i = 0; i < maximumChats; i++) at(list.voiceChats, i).id = "";
    const tokenizer = new SourceByteTokenizer(text), next = () => tokenizer.next();
    const gender = fold(next()); if (gender === "") return true;
    if (gender !== "male" && gender !== "female" && gender !== "neuter") { this.host.print(`^1expected gender not found in voice chat file: ${filename}\n`); return false; }
    list.gender = gender; list.numVoiceChats = 0;
    while (true) {
      const id = next(); if (id === "") return true;
      const chat = at(list.voiceChats, list.numVoiceChats); chat.id = id.slice(0, 63);
      const brace = next(); if (brace !== "{") { this.host.print(`^1expected { found ${brace} in voice chat file: ${filename}\n`); return false; }
      chat.numSounds = 0;
      while (true) {
        const path = next(); if (path === "") return true; if (path === "}") break;
        const sound = await this.wait(this.host.registerSound(path, compressed));
        chat.sounds[chat.numSounds] = sound;
        const message = next(); if (message === "") return true;
        chat.chats[chat.numSounds] = message.slice(0, 63);
        if (sound !== null) chat.numSounds++;
        if (chat.numSounds >= 64) break;
      }
      list.numVoiceChats++; if (list.numVoiceChats >= maximumChats) return true;
    }
  }
  async loadVoiceChats(): Promise<void> {
    this.open(); const before = this.host.memoryRemaining();
    const files = ["female1", "female2", "female3", "male1", "male2", "male3", "male4", "male5"];
    for (let i = 0; i < files.length; i++) await this.parseVoiceChats(`scripts/${at(files, i)}.voice`, i);
    this.host.print(`voice chat memory size = ${before - this.host.memoryRemaining()}\n`);
  }
  private headModelVoiceChats(filename: string): number {
    if (!this.host.assets.has(filename)) return -1;
    const data = this.host.assets.readSync(filename);
    if (data.length >= 16384) { this.host.print(`^1voice chat file too large: ${filename} is ${data.length}, max allowed is 16384`); return -1; }
    const text = bytes(String.fromCharCode(...data));
    const token = new SourceByteTokenizer(text).next(); if (token === "") return -1;
    return this.voiceLists.findIndex(list => fold(list.name) === fold(token));
  }
  private voiceListForClient(clientNum: number): VoiceChatList {
    const info = this.host.clients.clientInfo(clientNum < 0 || clientNum >= 64 ? 0 : clientNum);
    const model = info.headModelName.startsWith("*") ? info.headModelName.slice(1) : info.headModelName;
    let head = "";
    for (const candidate of [`${model}/${info.headSkinName}`, model]) {
      head = candidate.slice(0, 63);
      const cached = this.headVoices.find(entry => fold(entry.headmodel) === fold(head));
      if (cached !== undefined) return at(this.voiceLists, cached.voiceChatNum);
      const free = this.headVoices.find(entry => entry.headmodel === "");
      if (free !== undefined) {
        const index = this.headModelVoiceChats(`scripts/${head}.vc`.slice(0, 63));
        if (index >= 0) { free.headmodel = head; free.voiceChatNum = index; return at(this.voiceLists, index); }
      }
    }
    const remember = (index: number) => {
      const free = this.headVoices.find(entry => entry.headmodel === "");
      if (free !== undefined) { free.headmodel = head; free.voiceChatNum = index; }
      return at(this.voiceLists, index);
    };
    for (const gender of info.gender === "male" ? ["male"] : [info.gender, "male"]) {
      const index = this.voiceLists.findIndex(list => list.name !== "" && list.gender === gender);
      if (index >= 0) return remember(index);
    }
    return remember(0);
  }
  async voiceChatLocal(mode: number, voiceOnly: boolean, clientNumber: number, color: number, command: string): Promise<void> {
    this.open(); const state = this.host.state;
    if (state.product !== "missionpack" || state.intermissionStarted) return;
    const clientNum = clientNumber < 0 || clientNumber >= 64 ? 0 : clientNumber, info = this.host.clients.clientInfo(clientNum);
    this.host.staticState.currentVoiceClient = clientNum;
    const list = this.voiceListForClient(clientNum);
    const chat = list.voiceChats.slice(0, list.numVoiceChats).find(entry => fold(entry.id) === fold(command));
    if (chat === undefined) return;
    const index = Math.trunc(Math.fround(this.host.random.random() * chat.numSounds));
    const sound = at(chat.sounds, index), message = at(chat.chats, index);
    if (mode !== 1 && this.cvar("cg_teamChatsOnly").integerValue !== 0) return;
    const name = mode === 2 ? `[${info.name}]` : mode === 1 ? `(${info.name})` : info.name;
    await this.addBufferedVoiceChat({ clientNum, snd: sound, voiceOnly, cmd: bytes(command).slice(0, 149), message: bytes(`${name}: ^${String.fromCharCode(color & 255)}${message}`).slice(0, 149) });
  }
  private async addBufferedVoiceChat(voice: BufferedVoice): Promise<void> {
    const state = this.host.state;
    if (state.intermissionStarted) return;
    at(this.voices, state.voiceChatBufferIn);
    this.voices[state.voiceChatBufferIn] = { ...voice };
    state.voiceChatBufferIn = (state.voiceChatBufferIn + 1) % 32;
    if (state.voiceChatBufferIn === state.voiceChatBufferOut) { await this.playVoiceChat(at(this.voices, state.voiceChatBufferOut)); state.voiceChatBufferOut++; }
  }
  private async playVoiceChat(voice: BufferedVoice): Promise<void> {
    const state = this.host.state, cgs = this.host.staticState;
    if (state.intermissionStarted) return;
    if (this.cvar("cg_noVoiceChats").integerValue === 0) {
      this.host.startLocalSound(voice.snd, 3);
      if (state.snap === null) throw new Error("Voice playback requires the current snapshot");
      if (voice.clientNum !== state.snap.playerState.clientNum) {
        const order = orderTask(voice.cmd);
        if (order > 0) { cgs.acceptOrderTime = (state.time + 5000) | 0; cgs.acceptVoice = voice.cmd.slice(0, 31); cgs.acceptTask = order; cgs.acceptLeader = voice.clientNum; }
        await this.wait(this.host.showResponseHead());
      }
    }
    if (!voice.voiceOnly && this.cvar("cg_noVoiceText").integerValue === 0) { this.addToTeamChat(voice.message); this.host.print(`${voice.message}\n`); }
    at(this.voices, state.voiceChatBufferOut).snd = null;
  }
  async playBufferedVoiceChats(): Promise<void> {
    this.open(); const state = this.host.state;
    if (state.product !== "missionpack" || state.voiceChatTime >= state.time) return;
    if (state.voiceChatBufferOut !== state.voiceChatBufferIn && at(this.voices, state.voiceChatBufferOut).snd !== null) {
      await this.playVoiceChat(at(this.voices, state.voiceChatBufferOut));
      state.voiceChatBufferOut = (state.voiceChatBufferOut + 1) % 32; state.voiceChatTime = (state.time + 1000) | 0;
    }
  }
}
