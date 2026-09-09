/*
 * UI_SetBestScores, UI_LoadBestScores and UI_ClearScores from code/ui/ui_atoms.c.
 * postGameInfo_t from code/ui/ui_local.h. Copyright (C) 1999-2005 Id Software, Inc.
 * GPL-2.0-or-later. The QVM32/little-endian record is also native Linux x86/x64's
 * 16-int layout. Formatting follows bg_lib.c, including its libc-different INT_MIN.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { BinaryReader, BinaryWriter } from "../../core/binary.ts";
import type { CvarRegistry } from "../../core/cvar.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { gameFormat } from "../../game/format.ts";
import type { GameFormatArgument } from "../../game/format.ts";

/** Source field order is the saved .game record's 64-byte layout. */
export class PostGameInfo {
  score = 0;
  redScore = 0;
  blueScore = 0;
  perfects = 0;
  accuracy = 0;
  impressives = 0;
  excellents = 0;
  defends = 0;
  assists = 0;
  gauntlets = 0;
  captures = 0;
  time = 0;
  timeBonus = 0;
  shutoutBonus = 0;
  skillBonus = 0;
  baseScore = 0;
}

export interface TeamArenaScoreServices {
  readonly files: CommonFileState;
  readonly cvars: CvarRegistry;
  readonly print: (text: string) => void;
  readonly assertActive: () => void;
}

function readPostGameInfo(bytes: Uint8Array, source: string): PostGameInfo {
  const reader = new BinaryReader(bytes, source), info = new PostGameInfo();
  info.score = reader.i32();
  info.redScore = reader.i32();
  info.blueScore = reader.i32();
  info.perfects = reader.i32();
  info.accuracy = reader.i32();
  info.impressives = reader.i32();
  info.excellents = reader.i32();
  info.defends = reader.i32();
  info.assists = reader.i32();
  info.gauntlets = reader.i32();
  info.captures = reader.i32();
  info.time = reader.i32();
  info.timeBonus = reader.i32();
  info.shutoutBonus = reader.i32();
  info.skillBonus = reader.i32();
  info.baseScore = reader.i32();
  return info;
}

export class TeamArenaScores {
  demoAvailable = false;

  constructor(private readonly services: TeamArenaScoreServices) {}

  private set(name: string, format: string, args: readonly GameFormatArgument[]): void {
    this.services.assertActive();
    this.services.cvars.set(name, gameFormat(format, args), true);
    this.services.assertActive();
  }

  private publish(info: Readonly<PostGameInfo>, suffix: string): void {
    this.set(`ui_scoreAccuracy${suffix}`, "%i%%", [info.accuracy]);
    this.set(`ui_scoreImpressives${suffix}`, "%i", [info.impressives]);
    this.set(`ui_scoreExcellents${suffix}`, "%i", [info.excellents]);
    this.set(`ui_scoreDefends${suffix}`, "%i", [info.defends]);
    this.set(`ui_scoreAssists${suffix}`, "%i", [info.assists]);
    this.set(`ui_scoreGauntlets${suffix}`, "%i", [info.gauntlets]);
    this.set(`ui_scoreScore${suffix}`, "%i", [info.score]);
    this.set(`ui_scorePerfect${suffix}`, "%i", [info.perfects]);
    this.set(`ui_scoreTeam${suffix}`, "%i to %i", [info.redScore, info.blueScore]);
    this.set(`ui_scoreBase${suffix}`, "%i", [info.baseScore]);
    this.set(`ui_scoreTimeBonus${suffix}`, "%i", [info.timeBonus]);
    this.set(`ui_scoreSkillBonus${suffix}`, "%i", [info.skillBonus]);
    this.set(`ui_scoreShutoutBonus${suffix}`, "%i", [info.shutoutBonus]);
    this.set(`ui_scoreTime${suffix}`, "%02i:%02i", [Math.trunc(info.time / 60), info.time % 60]);
    this.set(`ui_scoreCaptures${suffix}`, "%i", [info.captures]);
  }

  setBestScores(info: Readonly<PostGameInfo>, postGame: boolean): void {
    this.services.assertActive();
    this.publish(info, "");
    if (postGame) this.publish(info, "2");
  }

  private path(format: string, args: readonly GameFormatArgument[]): string {
    const text = gameFormat(format, args);
    if (text.length >= 64) {
      this.services.print(`Com_sprintf: overflow of ${text.length} in 64\n`);
      this.services.assertActive();
    }
    return text.slice(0, 63);
  }

  scorePath(map: string | null, game: number): string {
    this.services.assertActive();
    return this.path("games/%s_%i.game", [map, game]);
  }

  /** Both score readers zero the header and record before merging actual short reads. */
  readRecord(filename: string): PostGameInfo {
    const services = this.services;
    services.assertActive();
    let info = new PostGameInfo();
    const opened = services.files.current.openRead(filename);
    services.assertActive();
    if (opened !== undefined) {
      const size = new Uint8Array(4);
      services.files.current.readInto(opened.file, size);
      services.assertActive();
      if (new BinaryReader(size, filename).i32() === 64) {
        const record = new Uint8Array(64);
        services.files.current.readInto(opened.file, record);
        services.assertActive();
        info = readPostGameInfo(record, filename);
      }
      services.files.current.closeFile(opened.file);
      services.assertActive();
    }
    return info;
  }

  writeRecord(filename: string, info: Readonly<PostGameInfo>): void {
    const services = this.services;
    services.assertActive();
    const file = services.files.writable.openBinaryWrite(filename);
    services.assertActive();
    // FS_FOpenFileByMode returns -1 when the write handle is zero.
    if (file === null) return;
    const header = new BinaryWriter(4);
    header.i32(64);
    file.writeBytes(header.finish());
    services.assertActive();
    const record = new BinaryWriter(64);
    for (const value of [info.score, info.redScore, info.blueScore, info.perfects, info.accuracy,
      info.impressives, info.excellents, info.defends, info.assists, info.gauntlets, info.captures,
      info.time, info.timeBonus, info.shutoutBonus, info.skillBonus, info.baseScore]) record.i32(value);
    file.writeBytes(record.finish());
    services.assertActive();
    file.close();
    services.assertActive();
  }

  loadBestScores(map: string | null, game: number): void {
    const services = this.services;
    const info = this.readRecord(this.scorePath(map, game));
    this.setBestScores(info, false);
    const protocol = qvmFloatToInt(services.cvars.get("protocol")?.numericValue ?? 0);
    const demoPath = this.path("demos/%s_%d.dm_%d", [map, game, protocol]);
    this.demoAvailable = false;
    const demo = services.files.current.openRead(demoPath);
    services.assertActive();
    if (demo !== undefined) {
      this.demoAvailable = true;
      services.files.current.closeFile(demo.file);
      services.assertActive();
    }
  }

  clearScores(): void {
    const services = this.services, list = new Uint8Array(4096);
    services.assertActive();
    const count = services.files.current.getFileList("games", "game", list);
    services.assertActive();
    const header = new BinaryWriter(4), record = new BinaryWriter(64);
    header.i32(64);
    for (let field = 0; field < 16; field++) record.i32(0);
    const sizeBytes = header.finish(), recordBytes = record.finish();
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const end = list.indexOf(0, offset);
      if (end < 0) throw new RangeError("UI_ClearScores source filename list lacks a terminator");
      const name = String.fromCharCode(...list.subarray(offset, end));
      const file = services.files.writable.openBinaryWrite(gameFormat("games/%s", [name]));
      services.assertActive();
      if (file !== null) {
        file.writeBytes(sizeBytes);
        services.assertActive();
        file.writeBytes(recordBytes);
        services.assertActive();
        file.close();
        services.assertActive();
      }
      offset = end + 1;
    }
    this.setBestScores(new PostGameInfo(), false);
  }
}
