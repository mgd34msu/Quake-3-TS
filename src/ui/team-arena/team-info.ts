/*
 * Team_Parse, Character_Parse, Alias_Parse, UI_ParseTeamInfo and UI_LoadTeams
 * from id Software's code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommonParseCursor } from "../../core/common-parse.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import { infoSlot, parseInfoString } from "./game-info.ts";
import type { TeamArenaInfoServices } from "./game-info.ts";
import { UiMemoryAllocation } from "./memory.ts";
import type { UiStringReference } from "./memory.ts";

export class TeamArenaTeam {
  readonly strings = UiMemoryAllocation.zeroed(28);
  get teamName(): string | null { return this.strings.getString(0) ?? null; }
  set teamName(value: string | null) { this.strings.setString(0, value ?? undefined); }
  get imageName(): string | null { return this.strings.getString(4) ?? null; }
  set imageName(value: string | null) { this.strings.setString(4, value ?? undefined); }
  readonly teamMembers = this.strings.stringArray(8, 5);
  teamIcon: SceneShader | null | -1 = null;
  teamIconMetal: SceneShader | null = null;
  teamIconName: SceneShader | null = null;
  cinematic = 0;
}
export class TeamArenaCharacter {
  readonly strings = UiMemoryAllocation.zeroed(16);
  get name(): string | null { return this.strings.getString(0) ?? null; }
  set name(value: string | null) { this.strings.setString(0, value ?? undefined); }
  get imageName(): string | null { return this.strings.getString(4) ?? null; }
  set imageName(value: string | null) { this.strings.setString(4, value ?? undefined); }
  get base(): string | null { return this.strings.getString(12) ?? null; }
  set base(value: string | null) { this.strings.setString(12, value ?? undefined); }
  headImage: { readonly kind: "unregistered" } | { readonly kind: "registered"; readonly shader: SceneShader | null } = { kind: "registered", shader: null };
  active = false;
  reference = 0;
}
export class TeamArenaAlias {
  readonly strings = UiMemoryAllocation.zeroed(12);
  get name(): string | null { return this.strings.getString(0) ?? null; }
  set name(value: string | null) { this.strings.setString(0, value ?? undefined); }
  get ai(): string | null { return this.strings.getString(4) ?? null; }
  set ai(value: string | null) { this.strings.setString(4, value ?? undefined); }
  get action(): string | null { return this.strings.getString(8) ?? null; }
  set action(value: string | null) { this.strings.setString(8, value ?? undefined); }
}

export class TeamArenaTeamInfo {
  readonly teamList: readonly TeamArenaTeam[] = Array.from({ length: 64 }, () => new TeamArenaTeam());
  readonly characterList: readonly TeamArenaCharacter[] = Array.from({ length: 64 }, () => new TeamArenaCharacter());
  readonly aliasList: readonly TeamArenaAlias[] = Array.from({ length: 64 }, () => new TeamArenaAlias());
  teamCount = 0;
  characterCount = 0;
  aliasCount = 0;

  constructor(private readonly services: TeamArenaInfoServices) {}

  async loadTeams(): Promise<void> {
    const services = this.services, list = new Uint8Array(4096);
    services.assertActive();
    const count = services.menuBuffer.files.current.getFileList("", "team", list);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const end = list.indexOf(0, offset);
      if (end < 0) throw new RangeError("UI_LoadTeams source list has no filename terminator");
      await this.parseTeamInfo(String.fromCharCode(...list.subarray(offset, end)));
      services.assertActive();
      offset = end + 1;
    }
  }

  async parseTeamInfo(filename: string): Promise<void> {
    const services = this.services, cursor = services.menuBuffer.read(filename);
    if (cursor === null) return;
    while (true) {
      services.assertActive();
      const token = services.sourceParser.parse(cursor);
      if (token.length === 0 || token.startsWith("}")) break;
      if (token.toLowerCase() === "teams") {
        if (await this.parseTeams(cursor)) continue;
        break;
      }
      if (token.toLowerCase() === "characters") this.parseCharacters(cursor);
      // The original token pointer aliases COM_Parse's static token after Character_Parse.
      if (services.sourceParser.token.toLowerCase() === "aliases") this.parseAliases(cursor);
    }
  }

  private async parseTeams(cursor: CommonParseCursor): Promise<boolean> {
    const services = this.services, parser = services.sourceParser;
    if (!parser.parse(cursor).startsWith("{")) return false;
    while (true) {
      const token = parser.parse(cursor);
      if (token === "}") return true;
      if (token.length === 0) return false;
      if (!token.startsWith("{")) continue;
      const row = infoSlot(this.teamList, this.teamCount);
      if (!parseInfoString(services, cursor, value => { row.strings.setString(0, value ?? undefined); })
        || !parseInfoString(services, cursor, value => { row.strings.setString(4, value ?? undefined); })) return false;
      const imageName = row.imageName;
      if (imageName === null) throw new RangeError("Team_Parse passes a failed String_Alloc to shader registration");
      services.assertActive();
      const icon = await services.resources.registerShaderNoMip(imageName);
      services.assertActive();
      row.teamIcon = icon;
      const metal = await services.resources.registerShaderNoMip(`${imageName}_metal`);
      services.assertActive();
      row.teamIconMetal = metal;
      const name = await services.resources.registerShaderNoMip(`${imageName}_name`);
      services.assertActive();
      row.teamIconName = name;
      row.cinematic = -1;
      for (let index = 0; index < 5; index++) {
        row.teamMembers[index] = null;
        if (!parseInfoString(services, cursor, value => { row.strings.setString(8 + index * 4, value ?? undefined); })) return false;
      }
      services.print(`Loaded team ${row.teamName ?? "(null)"} with team icon ${imageName}.\n`);
      services.assertActive();
      this.teamCount++;
      if (!parser.parse(cursor).startsWith("}")) return false;
    }
  }

  private parseCharacters(cursor: CommonParseCursor): boolean {
    const services = this.services, parser = services.sourceParser;
    if (!parser.parse(cursor).startsWith("{")) return false;
    while (true) {
      const token = parser.parse(cursor);
      if (token === "}") return true;
      if (token.length === 0) return false;
      if (!token.startsWith("{")) continue;
      const row = infoSlot(this.characterList, this.characterCount);
      const sex: { text: UiStringReference | null } = { text: null };
      if (!parseInfoString(services, cursor, value => { row.strings.setString(0, value ?? undefined); })
        || !parseInfoString(services, cursor, value => { sex.text = value; })) return false;
      row.headImage = { kind: "unregistered" };
      row.strings.setString(4, services.memory.stringAllocReference(`models/players/heads/${row.name ?? "(null)"}/icon_default.tga`) ?? undefined);
      const base = sex.text?.read().toLowerCase();
      row.strings.setString(12, services.memory.stringAllocReference(base === "female" ? "Janet" : base === "male" ? "James" : sex.text?.read() ?? "(null)") ?? undefined);
      services.print(`Loaded ${row.base ?? "(null)"} character ${row.name ?? "(null)"}.\n`);
      services.assertActive();
      this.characterCount++;
      if (!parser.parse(cursor).startsWith("}")) return false;
    }
  }

  private parseAliases(cursor: CommonParseCursor): boolean {
    const services = this.services, parser = services.sourceParser;
    if (!parser.parse(cursor).startsWith("{")) return false;
    while (true) {
      const token = parser.parse(cursor);
      if (token === "}") return true;
      if (token.length === 0) return false;
      if (!token.startsWith("{")) continue;
      const row = infoSlot(this.aliasList, this.aliasCount);
      if (!parseInfoString(services, cursor, value => { row.strings.setString(0, value ?? undefined); })
        || !parseInfoString(services, cursor, value => { row.strings.setString(4, value ?? undefined); })
        || !parseInfoString(services, cursor, value => { row.strings.setString(8, value ?? undefined); })) return false;
      services.print(`Loaded character alias ${row.name ?? "(null)"} using character ai ${row.ai ?? "(null)"}.\n`);
      services.assertActive();
      this.aliasCount++;
      if (!parser.parse(cursor).startsWith("}")) return false;
    }
  }
}
