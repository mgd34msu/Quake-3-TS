/*
 * GetMenuBuffer, GameType_Parse, MapList_Parse and UI_ParseGameInfo from
 * id Software's code/ui/ui_main.c; String_Parse/Int_Parse from ui_shared.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { CommonParseCursor } from "../../core/common-parse.ts";
import type { CommonParseState } from "../../core/common-parse.ts";
import { gameAtoi } from "../../game/numeric.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { RendererResources } from "../../render/world.ts";
import { UiMemoryAllocation } from "./memory.ts";
import type { TeamArenaUiMemory, UiStringReference } from "./memory.ts";

/** GetMenuBuffer's static storage belongs to one UI lifetime and survives individual reads. */
export class TeamArenaMenuBuffer {
  private readonly buffer = new Uint8Array(32768);
  defaultMenu: string | null = null;

  constructor(
    readonly files: CommonFileState,
    private readonly print: (text: string) => void,
    private readonly assertActive: () => void,
  ) {}

  read(filename: string): CommonParseCursor | null {
    this.assertActive();
    const opened = this.files.current.openRead(filename);
    if (opened === undefined) {
      this.print(`^1menu file not found: ${filename}, using default\n`);
      this.assertActive();
      return this.defaultMenu === null ? null : new CommonParseCursor(this.defaultMenu);
    }
    if (opened.length >= this.buffer.length) {
      this.print(`^1menu file too large: ${filename} is ${opened.length}, max allowed is ${this.buffer.length}`);
      this.assertActive();
      this.files.current.closeFile(opened.file);
      return this.defaultMenu === null ? null : new CommonParseCursor(this.defaultMenu);
    }
    this.assertActive();
    this.files.current.readInto(opened.file, this.buffer.subarray(0, opened.length));
    this.buffer[opened.length] = 0;
    this.assertActive();
    this.files.current.closeFile(opened.file);
    return new CommonParseCursor(String.fromCharCode(...this.buffer.subarray(0, opened.length)));
  }
}

/** Callers serialize and await operations sharing this parser, menu buffer and memory. */
export interface TeamArenaInfoServices {
  readonly menuBuffer: TeamArenaMenuBuffer;
  readonly sourceParser: CommonParseState;
  readonly memory: TeamArenaUiMemory;
  readonly resources: Pick<RendererResources, "registerShaderNoMip">;
  readonly print: (text: string) => void;
  readonly assertActive: () => void;
}

export function parseInfoString(services: TeamArenaInfoServices, cursor: CommonParseCursor, assign: (text: UiStringReference | null) => void): boolean {
  const token = services.sourceParser.parse(cursor, false);
  if (token.length === 0) return false;
  assign(services.memory.stringAllocReference(token));
  return true;
}

function parseInt(services: TeamArenaInfoServices, cursor: CommonParseCursor, assign: (value: number) => void): boolean {
  const token = services.sourceParser.parse(cursor, false);
  if (token.length === 0) return false;
  assign(gameAtoi(token));
  return true;
}

export function infoSlot<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new RangeError(`Team Arena metadata write exceeds source ${rows.length}-entry array at ${index}`);
  return row;
}

export class TeamArenaGameType {
  readonly strings = UiMemoryAllocation.zeroed(4);
  get gameType(): string | null { return this.strings.getString(0) ?? null; }
  set gameType(value: string | null) { this.strings.setString(0, value ?? undefined); }
  gtEnum = 0;
}
export class TeamArenaMap {
  readonly strings = UiMemoryAllocation.zeroed(16);
  get mapName(): string | null { return this.strings.getString(0) ?? null; }
  set mapName(value: string | null) { this.strings.setString(0, value ?? undefined); }
  get mapLoadName(): string | null { return this.strings.getString(4) ?? null; }
  set mapLoadName(value: string | null) { this.strings.setString(4, value ?? undefined); }
  get imageName(): string | null { return this.strings.getString(8) ?? null; }
  set imageName(value: string | null) { this.strings.setString(8, value ?? undefined); }
  get opponentName(): string | null { return this.strings.getString(12) ?? null; }
  set opponentName(value: string | null) { this.strings.setString(12, value ?? undefined); }
  teamMembers = 0;
  typeBits = 0;
  cinematic = 0;
  readonly timeToBeat = new Int32Array(16);
  levelShot: { readonly kind: "unregistered" } | { readonly kind: "registered"; readonly shader: SceneShader | null } = { kind: "registered", shader: null };
  active = false;
}

export class TeamArenaGameInfo {
  readonly gameTypes: readonly TeamArenaGameType[] = Array.from({ length: 16 }, () => new TeamArenaGameType());
  readonly joinGameTypes: readonly TeamArenaGameType[] = Array.from({ length: 16 }, () => new TeamArenaGameType());
  readonly mapList: readonly TeamArenaMap[] = Array.from({ length: 128 }, () => new TeamArenaMap());
  numGameTypes = 0;
  numJoinGameTypes = 0;
  mapCount = 0;

  constructor(private readonly services: TeamArenaInfoServices) {}

  async parseGameInfo(filename: string): Promise<void> {
    const cursor = this.services.menuBuffer.read(filename);
    if (cursor === null) return;
    while (true) {
      this.services.assertActive();
      const token = this.services.sourceParser.parse(cursor);
      if (token.length === 0 || token.startsWith("}")) break;
      if (token.toLowerCase() === "gametypes") {
        if (this.parseGameTypes(cursor, false)) continue;
        break;
      }
      if (token.toLowerCase() === "joingametypes") {
        if (this.parseGameTypes(cursor, true)) continue;
        break;
      }
      if (token.toLowerCase() === "maps") await this.parseMaps(cursor);
    }
  }

  private parseGameTypes(cursor: CommonParseCursor, join: boolean): boolean {
    const services = this.services, parser = services.sourceParser;
    if (!parser.parse(cursor).startsWith("{")) return false;
    if (join) this.numJoinGameTypes = 0;
    else this.numGameTypes = 0;
    while (true) {
      const token = parser.parse(cursor);
      if (token === "}") return true;
      if (token.length === 0) return false;
      if (!token.startsWith("{")) continue;
      const row = infoSlot(join ? this.joinGameTypes : this.gameTypes, join ? this.numJoinGameTypes : this.numGameTypes);
      if (!parseInfoString(services, cursor, value => { row.strings.setString(0, value ?? undefined); })
        || !parseInt(services, cursor, value => { row.gtEnum = value; })) return false;
      if (join) this.numJoinGameTypes++;
      else this.numGameTypes++;
      if (!parser.parse(cursor).startsWith("}")) return false;
    }
  }

  private async parseMaps(cursor: CommonParseCursor): Promise<boolean> {
    const services = this.services, parser = services.sourceParser;
    if (!parser.parse(cursor).startsWith("{")) return false;
    this.mapCount = 0;
    while (true) {
      const token = parser.parse(cursor);
      if (token === "}") return true;
      if (token.length === 0) return false;
      if (!token.startsWith("{")) continue;
      const row = infoSlot(this.mapList, this.mapCount);
      if (!parseInfoString(services, cursor, value => { row.strings.setString(0, value ?? undefined); })
        || !parseInfoString(services, cursor, value => { row.strings.setString(4, value ?? undefined); })
        || !parseInt(services, cursor, value => { row.teamMembers = value; })
        || !parseInfoString(services, cursor, value => { row.strings.setString(12, value ?? undefined); })) return false;
      row.typeBits = 0;
      while (true) {
        const type = parser.parse(cursor).charCodeAt(0) - 48;
        if (!(type >= 0 && type <= 9)) break;
        row.typeBits |= 1 << type;
        if (!parseInt(services, cursor, value => { row.timeToBeat[type] = value; })) return false;
      }
      row.cinematic = -1;
      services.assertActive();
      const levelShot = await services.resources.registerShaderNoMip(`levelshots/${row.mapLoadName ?? "(null)"}_small`);
      services.assertActive();
      row.levelShot = { kind: "registered", shader: levelShot };
      this.mapCount++;
    }
  }
}
