/*
 * q3_ui/ui_gameinfo.c and game/bg_lib.c atoi, id Software.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 * Managed strings retain the source 128 KiB allocation accounting. Packed
 * reads use the common filesystem's qualified whole-entry decoder.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { CommonParseCursor } from "../../core/common-parse.ts";
import { CvarFlag } from "../../core/cvar.ts";
import { infoSetValueForKey, infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { itemAt } from "./state.ts";
import type { BaseUiState } from "./state.ts";

const MAX_INFOS = 1024, MAX_TEXT = 8192, POOL_SIZE = 128 * 1024, ARENAS_PER_TIER = 4;

function equalBytes(left: string, right: string): boolean {
  const fold = (text: string): string => text.split("\0", 1).join("")
    .replace(/[A-Z]/g, byte => String.fromCharCode(byte.charCodeAt(0) + 32));
  return fold(left) === fold(right);
}

/** UI_CanShowTierVideo also serves the Cinematics menu without loading a catalog. */
export function canShowTierVideo(state: BaseUiState, tier: number): boolean {
  state.assertActive();
  if (tier === 0 || (state.demoVersion && tier !== 8)) return false;
  const variable = state.services.cvars.registry.get("g_spVideos");
  state.assertActive();
  return gameAtoi(infoValueForKey((variable?.value ?? "").slice(0, 1023), `tier${tier}`)) !== 0;
}

export class BaseUiGameInfo {
  private readonly arenas: string[] = [];
  private readonly bots: string[] = [];
  private numArenas = 0;
  private numBots = 0;
  private numSinglePlayerArenas = 0;
  private numSpecialSinglePlayerArenas = 0;
  private allocPoint = 0;
  private outOfMemory = false;

  constructor(private readonly state: BaseUiState, private readonly files: CommonFileState) {}

  initialize(): void {
    this.state.assertActive();
    this.allocPoint = 0;
    this.outOfMemory = false;
    this.loadArenas();
    this.loadBots();
    this.state.demoVersion = this.cvarNumber("fs_restrict") !== 0
      || (this.numSpecialSinglePlayerArenas === 0 && this.numSinglePlayerArenas === 4);
  }

  private print(text: string): void { this.state.assertActive(); this.state.services.print(text); }
  private cvarString(name: string): string {
    this.state.assertActive();
    return (this.state.services.cvars.registry.get(name)?.value ?? "").slice(0, 1023);
  }
  private cvarNumber(name: string): number {
    this.state.assertActive();
    return this.state.services.cvars.registry.get(name)?.numericValue ?? 0;
  }
  private setCvar(name: string, value: string): void {
    this.state.assertActive();
    this.state.services.cvars.registry.set(name, value, true);
  }
  private setInfo(info: string, key: string, value: string): string {
    return infoSetValueForKey(info, key, value, text => this.print(text));
  }
  private allocate(size: number): boolean {
    if (this.allocPoint + size > POOL_SIZE) { this.outOfMemory = true; return false; }
    this.allocPoint += (size + 31) & ~31;
    return true;
  }

  private parseInfos(text: string, infos: string[], start: number, unreadTail: boolean): number {
    const cursor = new CommonParseCursor(text, unreadTail ? "uninitialized" : "terminated");
    const parse = (allowLineBreaks = true): string => this.state.sourceParser.parse(cursor, allowLineBreaks);
    let count = 0;
    while (true) {
      const token = parse();
      if (token.length === 0) break;
      if (token !== "{") { this.print("Missing { in info file\n"); break; }
      if (count === MAX_INFOS - start) { this.print("Max infos exceeded\n"); break; }
      let info = "";
      while (true) {
        const key = parse();
        if (key.length === 0) { this.print("Unexpected end of info file\n"); break; }
        if (key === "}") break;
        const value = parse(false);
        info = this.setInfo(info, key, value.length === 0 ? "<NULL>" : value);
      }
      if (this.allocate(info.length + "\\num\\".length + String(MAX_INFOS).length + 1)) {
        infos[start + count] = info;
        count++;
      }
    }
    return count;
  }

  private loadFile(filename: string, kind: "arenas" | "bots"): void {
    this.state.assertActive();
    const opened = this.files.current.openRead(filename);
    if (opened === undefined) { this.print(`^1file not found: ${filename}\n`); return; }
    if (opened.length >= MAX_TEXT) {
      this.print(`^1file too large: ${filename} is ${opened.length}, max allowed is ${MAX_TEXT}`);
      this.state.assertActive();
      this.files.current.closeFile(opened.file);
      return;
    }
    const buffer = new Uint8Array(opened.length);
    this.state.assertActive();
    const copied = this.files.current.readInto(opened.file, buffer);
    this.state.assertActive();
    this.files.current.closeFile(opened.file);
    const text = String.fromCharCode(...buffer.subarray(0, copied));
    const unreadTail = copied < opened.length;
    if (kind === "arenas") this.numArenas += this.parseInfos(text, this.arenas, this.numArenas, unreadTail);
    else {
      this.numBots += this.parseInfos(text, this.bots, this.numBots, unreadTail);
      if (this.outOfMemory) this.print("^3WARNING: not anough memory in pool to load all bots\n");
    }
  }

  private loadListedFiles(kind: "arenas" | "bots"): void {
    const extension = kind === "arenas" ? ".arena" : ".bot";
    const list = new Uint8Array(1024);
    this.state.assertActive();
    const count = this.files.current.getFileList("scripts", extension, list);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const end = list.indexOf(0, offset);
      if (end < 0) throw new RangeError("UI file list has no filename terminator");
      const filename = `scripts/${String.fromCharCode(...list.subarray(offset, end))}`;
      if (filename.length >= 128) throw new RangeError("UI filename exceeds source 128-byte storage");
      this.loadFile(filename, kind);
      offset = end + 1;
    }
  }

  private loadArenas(): void {
    this.numArenas = 0;
    this.state.assertActive();
    const mirror = this.state.services.cvars.registry.registerVm("g_arenasFile", "", CvarFlag.Init | CvarFlag.ReadOnly);
    this.loadFile(mirror.value || "scripts/arenas.txt", "arenas");
    this.loadListedFiles("arenas");
    this.print(`${this.numArenas} arenas parsed\n`);
    if (this.outOfMemory) this.print("^3WARNING: not anough memory in pool to load all arenas\n");
    for (let n = 0; n < this.numArenas; n++) this.arenas[n] = this.setInfo(itemAt(this.arenas, n), "num", String(n));
    this.numSinglePlayerArenas = 0;
    this.numSpecialSinglePlayerArenas = 0;
    for (let n = 0; n < this.numArenas; n++) {
      const info = itemAt(this.arenas, n);
      if (!infoValueForKey(info, "type").includes("single")) continue;
      if (infoValueForKey(info, "special")) this.numSpecialSinglePlayerArenas++;
      else this.numSinglePlayerArenas++;
    }
    const ignored = this.numSinglePlayerArenas % ARENAS_PER_TIER;
    if (ignored !== 0) {
      this.numSinglePlayerArenas -= ignored;
      this.print(`${ignored} arenas ignored to make count divisible by ${ARENAS_PER_TIER}\n`);
    }
    let single = 0, special = this.numSinglePlayerArenas, other = special + this.numSpecialSinglePlayerArenas;
    for (let n = 0; n < this.numArenas; n++) {
      const info = itemAt(this.arenas, n);
      const number = infoValueForKey(info, "type").includes("single")
        ? infoValueForKey(info, "special") ? special++ : single++ : other++;
      this.arenas[n] = this.setInfo(info, "num", String(number));
    }
  }

  private loadBots(): void {
    this.numBots = 0;
    this.state.assertActive();
    const mirror = this.state.services.cvars.registry.registerVm("g_botsFile", "", CvarFlag.Init | CvarFlag.ReadOnly);
    this.loadFile(mirror.value || "scripts/bots.txt", "bots");
    this.loadListedFiles("bots");
    this.print(`${this.numBots} bots parsed\n`);
  }

  getArenaInfoByNumber(num: number): string | null {
    this.state.assertActive();
    if (num < 0 || num >= this.numArenas) { this.print(`^1Invalid arena number: ${num}\n`); return null; }
    for (let n = 0; n < this.numArenas; n++) {
      const info = itemAt(this.arenas, n), value = infoValueForKey(info, "num");
      if (value && gameAtoi(value) === num) return info;
    }
    return null;
  }
  getArenaInfoByMap(map: string): string | null { this.state.assertActive(); return this.findInfo(this.arenas, this.numArenas, "map", map); }
  getSpecialArenaInfo(tag: string): string | null { this.state.assertActive(); return this.findInfo(this.arenas, this.numArenas, "special", tag); }
  getBotInfoByNumber(num: number): string | null {
    this.state.assertActive();
    if (num < 0 || num >= this.numBots) { this.print(`^1Invalid bot number: ${num}\n`); return null; }
    return itemAt(this.bots, num);
  }
  getBotInfoByName(name: string): string | null { this.state.assertActive(); return this.findInfo(this.bots, this.numBots, "name", name); }
  private findInfo(infos: readonly string[], count: number, key: string, wanted: string): string | null {
    for (let n = 0; n < count; n++) {
      const info = itemAt(infos, n);
      if (equalBytes(infoValueForKey(info, key), wanted)) return info;
    }
    return null;
  }
  getNumArenas(): number { this.state.assertActive(); return this.numArenas; }
  getNumSPArenas(): number { this.state.assertActive(); return this.numSinglePlayerArenas; }
  getNumSPTiers(): number { this.state.assertActive(); return this.numSinglePlayerArenas / ARENAS_PER_TIER; }
  getNumBots(): number { this.state.assertActive(); return this.numBots; }

  getBestScore(level: number, result: { score: number; skill: number }): void {
    this.state.assertActive();
    if (level < 0 || level > this.numArenas) return;
    let score = 0, skill = 0;
    for (let n = 1; n <= 5; n++) {
      const current = gameAtoi(infoValueForKey(this.cvarString(`g_spScores${n}`), `l${level}`));
      if (current < 1 || current > 8) continue;
      if (!score || current <= score) { score = current; skill = n; }
    }
    result.score = score;
    result.skill = skill;
  }
  setBestScore(level: number, score: number): void {
    this.state.assertActive();
    if (score < 1 || score > 8) return;
    const skill = qvmFloatToInt(this.cvarNumber("g_spSkill"));
    if (skill < 1 || skill > 5) return;
    const scores = this.cvarString(`g_spScores${skill}`), key = `l${level}`;
    const old = gameAtoi(infoValueForKey(scores, key));
    if (old && old <= score) return;
    this.setCvar(`g_spScores${skill}`, this.setInfo(scores, key, String(score)));
  }
  logAwardData(award: number, data: number): void {
    this.state.assertActive();
    if (data === 0) return;
    if (award > 5) { this.print(`^1Bad award ${award} in UI_LogAwardData\n`); return; }
    const awards = this.cvarString("g_spAwards"), key = `a${award}`;
    this.setCvar("g_spAwards", this.setInfo(awards, key, String((gameAtoi(infoValueForKey(awards, key)) + data) | 0)));
  }
  getAwardLevel(award: number): number {
    this.state.assertActive();
    return gameAtoi(infoValueForKey(this.cvarString("g_spAwards"), `a${award}`));
  }
  tierCompleted(levelWon: number): number {
    this.state.assertActive();
    const tier = Math.trunc(levelWon / ARENAS_PER_TIER);
    let level = tier * ARENAS_PER_TIER;
    if (tier === this.getNumSPTiers()) {
      const training = this.getSpecialArenaInfo("training");
      if (levelWon === gameAtoi(infoValueForKey(training ?? "", "num"))) return 0;
      const final = this.getSpecialArenaInfo("final");
      return final === null || levelWon === gameAtoi(infoValueForKey(final, "num")) ? tier + 1 : -1;
    }
    const result = { score: 0, skill: 0 };
    for (let n = 0; n < ARENAS_PER_TIER; n++, level++) {
      this.getBestScore(level, result);
      if (n === 0 && (level < 0 || level > this.numArenas))
        throw new RangeError("UI_TierCompleted reads an uninitialized source score");
      if (result.score !== 1) return -1;
    }
    return tier + 1;
  }
  showTierVideo(tier: number): boolean {
    this.state.assertActive();
    if (tier <= 0) return false;
    const videos = this.cvarString("g_spVideos"), key = `tier${tier}`;
    if (gameAtoi(infoValueForKey(videos, key))) return false;
    this.setCvar("g_spVideos", this.setInfo(videos, key, "1"));
    return true;
  }
  canShowTierVideo(tier: number): boolean {
    return canShowTierVideo(this.state, tier);
  }
  getCurrentGame(): number {
    this.state.assertActive();
    const result = { score: 0, skill: 0 }, training = this.getSpecialArenaInfo("training");
    if (training !== null) {
      const level = gameAtoi(infoValueForKey(training, "num"));
      this.getBestScore(level, result);
      if (!result.score || result.score > 1) return level;
    }
    for (let level = 0; level < this.numSinglePlayerArenas; level++) {
      this.getBestScore(level, result);
      if (!result.score || result.score > 1) return level;
    }
    const final = this.getSpecialArenaInfo("final");
    return final === null ? -1 : gameAtoi(infoValueForKey(final, "num"));
  }
  newGame(): void {
    this.state.assertActive();
    for (let skill = 1; skill <= 5; skill++) this.setCvar(`g_spScores${skill}`, "");
    this.setCvar("g_spAwards", "");
    this.setCvar("g_spVideos", "");
  }
  /** UI_SPUnlock_f through its final print; the future SP menu owns ReInit. */
  unlockLevelScores(): void {
    this.state.assertActive();
    let scores = this.cvarString("g_spScores1");
    for (let level = 0; level < this.numSinglePlayerArenas + this.numSpecialSinglePlayerArenas; level++)
      scores = this.setInfo(scores, `l${level}`, "1");
    this.setCvar("g_spScores1", scores);
    for (let tier = 1; tier <= 8; tier++) this.showTierVideo(tier);
    this.print("All levels unlocked at skill level 1\n");
  }
  unlockMedals(): void {
    this.state.assertActive();
    let awards = this.cvarString("g_spAwards");
    for (let n = 0; n < 6; n++) awards = this.setInfo(awards, `a${n}`, "100");
    this.setCvar("g_spAwards", awards);
    this.print("All levels unlocked at 100\n");
  }
}
