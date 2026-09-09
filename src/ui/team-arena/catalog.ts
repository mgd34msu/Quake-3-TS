/*
 * Arena/bot catalog from id Software's code/ui/ui_gameinfo.c, MISSIONPACK.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { CommonParseCursor, compressCommonText } from "../../core/common-parse.ts";
import { CvarFlag } from "../../core/cvar.ts";
import type { CvarRegistry } from "../../core/cvar.ts";
import { infoSetValueForKey, infoValueForKey } from "../../core/info-string.ts";
import { GameType } from "../../shared/definitions.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo, TeamArenaInfoServices } from "./game-info.ts";
import type { UiStringReference } from "./memory.ts";

export interface TeamArenaCatalogServices extends Pick<TeamArenaInfoServices, "sourceParser" | "memory" | "print" | "assertActive"> {
  readonly files: CommonFileState;
  readonly cvars: CvarRegistry;
  readonly gameInfo: TeamArenaGameInfo;
}

/** Borrows the UI string/allocation pools without resetting them during catalog reloads. */
export class TeamArenaCatalog {
  private readonly arenas: (UiStringReference | null)[] = Array.from({ length: 1024 }, () => null);
  private readonly bots: (UiStringReference | null)[] = Array.from({ length: 1024 }, () => null);
  private numArenas = 0;
  private numBots = 0;

  constructor(private readonly services: TeamArenaCatalogServices) {}

  private print(text: string): void {
    this.services.assertActive();
    this.services.print(text);
    this.services.assertActive();
  }

  private parseInfos(cursor: CommonParseCursor, rows: (UiStringReference | null)[], start: number): number {
    const services = this.services, parser = services.sourceParser;
    let count = 0;
    while (true) {
      const token = parser.parse(cursor);
      if (token.length === 0) break;
      if (token !== "{") { this.print("Missing { in info file\n"); break; }
      if (count === 1024 - start) { this.print("Max infos exceeded\n"); break; }
      let info = "";
      while (true) {
        const key = parser.parse(cursor);
        if (key.length === 0) { this.print("Unexpected end of info file\n"); break; }
        if (key === "}") break;
        const value = parser.parse(cursor, false);
        if (value.length === 0) parser.overwriteToken("<NULL>");
        info = infoSetValueForKey(info, key, parser.token, text => { this.print(text); });
      }
      // UI_ParseInfos reserves the original unused "\\num\\1024" suffix space.
      const allocation = services.memory.allocate(info.length + 10);
      services.assertActive();
      rows[start + count] = null;
      if (allocation !== null) {
        const span = services.memory.borrow(allocation, info.length + 10);
        span.writeString(info);
        rows[start + count] = span.stringReference();
        count++;
      }
    }
    return count;
  }

  private loadFile(filename: string, kind: "arenas" | "bots"): void {
    const services = this.services;
    services.assertActive();
    const opened = services.files.current.openRead(filename);
    if (opened === undefined) { this.print(`^1file not found: ${filename}\n`); return; }
    if (opened.length >= 8192) {
      this.print(`^1file too large: ${filename} is ${opened.length}, max allowed is 8192`);
      services.files.current.closeFile(opened.file);
      return;
    }
    services.assertActive();
    const buffer = new Uint8Array(opened.length);
    const copied = services.files.current.readInto(opened.file, buffer);
    services.assertActive();
    services.files.current.closeFile(opened.file);
    const text = String.fromCharCode(...buffer.subarray(0, copied));
    const end = copied < opened.length ? "uninitialized" : "terminated";
    const cursor = kind === "bots" ? new CommonParseCursor(compressCommonText(text, end)) : new CommonParseCursor(text, end);
    if (kind === "arenas") this.numArenas += this.parseInfos(cursor, this.arenas, this.numArenas);
    else this.numBots += this.parseInfos(cursor, this.bots, this.numBots);
  }

  private loadFiles(kind: "arenas" | "bots"): void {
    const services = this.services;
    services.assertActive();
    const variable = services.cvars.registerVm(kind === "arenas" ? "g_arenasFile" : "g_botsFile", "", CvarFlag.Init | CvarFlag.ReadOnly);
    services.assertActive();
    this.loadFile(variable.value || `scripts/${kind}.txt`, kind);
    const list = new Uint8Array(1024);
    services.assertActive();
    const count = services.files.current.getFileList("scripts", kind === "arenas" ? ".arena" : ".bot", list);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const end = list.indexOf(0, offset);
      if (end < 0) throw new RangeError("Team Arena catalog filename has no source list terminator");
      const filename = `scripts/${String.fromCharCode(...list.subarray(offset, end))}`;
      if (filename.length >= 128) throw new RangeError("Team Arena catalog filename exceeds source 128-byte storage");
      this.loadFile(filename, kind);
      offset = end + 1;
    }
  }

  loadArenas(): void {
    const services = this.services, game = services.gameInfo;
    services.assertActive();
    this.numArenas = 0;
    game.mapCount = 0;
    this.loadFiles("arenas");
    this.print(`${this.numArenas} arenas parsed\n`);
    if (services.memory.outOfMemory) this.print("^3WARNING: not anough memory in pool to load all arenas\n");
    for (let index = 0; index < this.numArenas; index++) {
      const reference = infoSlot(this.arenas, index);
      if (reference === null) throw new RangeError("Team Arena arena count references an unallocated info string");
      const info = reference.read();
      const row = infoSlot(game.mapList, game.mapCount);
      row.cinematic = -1;
      row.strings.setString(4, services.memory.stringAllocReference(infoValueForKey(info, "map")) ?? undefined);
      row.strings.setString(0, services.memory.stringAllocReference(infoValueForKey(info, "longname")) ?? undefined);
      row.levelShot = { kind: "unregistered" };
      row.strings.setString(8, services.memory.stringAllocReference(`levelshots/${row.mapLoadName ?? "(null)"}`) ?? undefined);
      row.typeBits = 0;
      const type = infoValueForKey(info, "type");
      if (type.length !== 0) {
        if (type.includes("ffa")) row.typeBits |= 1 << GameType.GT_FFA;
        if (type.includes("tourney")) row.typeBits |= 1 << GameType.GT_TOURNAMENT;
        if (type.includes("ctf")) row.typeBits |= 1 << GameType.GT_CTF;
        if (type.includes("oneflag")) row.typeBits |= 1 << GameType.GT_1FCTF;
        if (type.includes("overload")) row.typeBits |= 1 << GameType.GT_OBELISK;
        if (type.includes("harvester")) row.typeBits |= 1 << GameType.GT_HARVESTER;
      } else row.typeBits |= 1 << GameType.GT_FFA;
      game.mapCount++;
      if (game.mapCount >= 128) break;
    }
  }

  loadBots(): void {
    this.services.assertActive();
    this.numBots = 0;
    this.loadFiles("bots");
    this.print(`${this.numBots} bots parsed\n`);
  }

  getBotInfoByNumber(num: number): string | null {
    this.services.assertActive();
    if (num < 0 || num >= this.numBots) { this.print(`^1Invalid bot number: ${num}\n`); return null; }
    return infoSlot(this.bots, num)?.read() ?? null;
  }

  getBotInfoByName(name: string): string | null {
    this.services.assertActive();
    const fold = (text: string): string => text.split("\0", 1).join("")
      .replace(/[A-Z]/g, byte => String.fromCharCode(byte.charCodeAt(0) + 32));
    for (let index = 0; index < this.numBots; index++) {
      const reference = infoSlot(this.bots, index);
      if (reference === null) throw new RangeError("Team Arena bot count references an unallocated info string");
      const info = reference.read();
      if (fold(infoValueForKey(info, "name")) === fold(name)) return info;
    }
    return null;
  }

  getNumBots(): number { this.services.assertActive(); return this.numBots; }

  getBotNameByNumber(num: number): string {
    const info = this.getBotInfoByNumber(num);
    return info === null ? "Sarge" : infoValueForKey(info, "name");
  }
}
