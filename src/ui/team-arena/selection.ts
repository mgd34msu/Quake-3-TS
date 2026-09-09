/*
 * UI_MapCountByGameType, UI_hasSkinForBase, UI_HeadCountByTeam,
 * UI_TeamIndexFromName and active-list selection from code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { gameFormat } from "../../game/format.ts";
import { GameType } from "../../shared/definitions.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaTeamInfo } from "./team-info.ts";

export interface TeamArenaSelectedEntry { readonly name: string | null; readonly actual: number }

function namesEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const fold = (value: string): string => value.split("\0", 1).join("")
    .replace(/[a-z]/g, byte => String.fromCharCode(byte.charCodeAt(0) - 32));
  return fold(left) === fold(right);
}

/** Source active flags live on the original metadata rows, not a copied filtered list. */
export class TeamArenaSelection {
  private referencesInitialized = false;

  constructor(
    private readonly game: TeamArenaGameInfo,
    private readonly teams: TeamArenaTeamInfo,
    private readonly cvars: TeamArenaUiCvars,
    private readonly files: CommonFileState,
    private readonly print: (text: string) => void,
    private readonly assertActive: () => void,
  ) {}

  mapCountByGameType(singlePlayer: boolean): number {
    this.assertActive();
    const selection = this.cvars.get(singlePlayer ? "ui_gameType" : "ui_netGameType").integerValue;
    let game = infoSlot(this.game.gameTypes, selection).gtEnum, count = 0;
    if (game === GameType.GT_SINGLE_PLAYER) game++;
    if (game === GameType.GT_TEAM) game = GameType.GT_FFA;
    for (let index = 0; index < this.game.mapCount; index++) {
      const row = infoSlot(this.game.mapList, index);
      row.active = false;
      if ((row.typeBits & (1 << game)) === 0) continue;
      if (singlePlayer && (row.typeBits & (1 << GameType.GT_SINGLE_PLAYER)) === 0) continue;
      count++;
      row.active = true;
    }
    return count;
  }

  hasSkinForBase(base: string | null, team: string | null): boolean {
    this.assertActive();
    for (const format of ["models/players/%s/%s/lower_default.skin", "models/players/characters/%s/%s/lower_default.skin"]) {
      const path = gameFormat(format, [base, team]);
      if (path.length >= 1024) {
        this.print(`Com_sprintf: overflow of ${path.length} in 1024\n`);
        this.assertActive();
      }
      if (this.files.current.has(path.slice(0, 1023))) return true;
    }
    return false;
  }

  teamIndexFromName(name: string | null): number {
    this.assertActive();
    if (name !== null && !name.startsWith("\0") && name.length !== 0) {
      for (let index = 0; index < this.teams.teamCount; index++) {
        if (namesEqual(name, infoSlot(this.teams.teamList, index).teamName)) return index;
      }
    }
    return 0;
  }

  /** Active helpers in code/ui's !MISSIONPACK build; its selected UI has no callers. */
  opponentLeaderName(): string | null {
    this.assertActive();
    const name = this.cvars.registry.get("ui_opponentName")?.value.slice(0, 1023) ?? "";
    return infoSlot(infoSlot(this.teams.teamList, this.teamIndexFromName(name)).teamMembers, 0);
  }

  aiIndex(name: string | null): number {
    this.assertActive();
    for (let index = 0; index < this.teams.characterCount; index++) {
      if (namesEqual(name, infoSlot(this.teams.characterList, index).name)) return index;
    }
    return 0;
  }

  aiIndexFromName(name: string | null): number {
    this.assertActive();
    for (let index = 0; index < this.teams.aliasCount; index++) {
      const alias = infoSlot(this.teams.aliasList, index);
      if (namesEqual(alias.name, name)) return this.aiIndex(alias.ai);
    }
    return 0;
  }

  opponentLeaderHead(): string | null {
    const leader = this.opponentLeaderName();
    for (let index = 0; index < this.teams.aliasCount; index++) {
      const alias = infoSlot(this.teams.aliasList, index);
      if (namesEqual(alias.name, leader)) return alias.ai;
    }
    return "James";
  }

  opponentLeaderModel(): string | null {
    const head = this.opponentLeaderHead();
    for (let index = 0; index < this.teams.characterCount; index++) {
      const character = infoSlot(this.teams.characterList, index);
      if (namesEqual(head, character.name)) return character.base;
    }
    return "James";
  }

  headCountByTeam(): number {
    this.assertActive();
    if (!this.referencesInitialized) {
      for (let index = 0; index < this.teams.characterCount; index++) {
        const character = infoSlot(this.teams.characterList, index);
        character.reference = 0;
        for (let team = 0; team < this.teams.teamCount; team++) {
          if (this.hasSkinForBase(character.base, infoSlot(this.teams.teamList, team).teamName)) character.reference |= 1 << team;
        }
      }
      this.referencesInitialized = true;
    }
    const name = this.cvars.registry.get("ui_teamName");
    const teamIndex = this.teamIndexFromName(name === undefined ? "" : name.value.slice(0, 1023));
    let count = 0;
    for (let index = 0; index < this.teams.characterCount; index++) {
      const character = infoSlot(this.teams.characterList, index);
      character.active = false;
      for (let member = 0; member < 5; member++) {
        if (infoSlot(infoSlot(this.teams.teamList, teamIndex).teamMembers, member) !== null
          && (character.reference & (1 << teamIndex)) !== 0) {
          character.active = true;
          count++;
          break;
        }
      }
    }
    for (let member = 0; member < 5; member++) {
      for (let index = 0; index < this.teams.aliasCount; index++) {
        const alias = infoSlot(this.teams.aliasList, index);
        if (alias.name === null || !namesEqual(infoSlot(infoSlot(this.teams.teamList, teamIndex).teamMembers, member), alias.name)) continue;
        for (let head = 0; head < this.teams.characterCount; head++) {
          const character = infoSlot(this.teams.characterList, head);
          if (character.headImage.kind !== "unregistered" && (character.reference & (1 << teamIndex)) !== 0
            && namesEqual(alias.ai, character.name)) {
            if (!character.active) { character.active = true; count++; }
            break;
          }
        }
      }
    }
    return count;
  }

  selectedMap(index: number): TeamArenaSelectedEntry {
    this.assertActive();
    let count = 0;
    for (let actual = 0; actual < this.game.mapCount; actual++) {
      const row = infoSlot(this.game.mapList, actual);
      if (row.active && count++ === index) return { name: row.mapName, actual };
    }
    return { name: "", actual: 0 };
  }

  selectedHead(index: number): TeamArenaSelectedEntry {
    this.assertActive();
    let count = 0;
    for (let actual = 0; actual < this.teams.characterCount; actual++) {
      const row = infoSlot(this.teams.characterList, actual);
      if (row.active && count++ === index) return { name: row.name, actual };
    }
    return { name: "", actual: 0 };
  }

  indexFromSelection(actual: number): number {
    this.assertActive();
    let count = 0;
    for (let index = 0; index < this.game.mapCount; index++) {
      if (!infoSlot(this.game.mapList, index).active) continue;
      if (index === actual) return count;
      count++;
    }
    return 0;
  }
}
