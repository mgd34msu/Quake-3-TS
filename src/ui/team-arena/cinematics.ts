/*
 * UI_PlayCinematic, UI_StopCinematic, UI_DrawCinematic and UI_RunCinematicFrame
 * from id Software's code/ui/ui_main.c. Copyright (C) 1999-2005 Id Software, Inc.
 * GPL-2.0-or-later.
 */
import { sourceCommandText } from "../../core/text.ts";
import { cinematicPixelRect } from "../../engine/cinematics.ts";
import type { EngineUiCinematics } from "../../engine/ui-cinematics.ts";
import type { Draw2D } from "../../render/draw2d.ts";
import type { UiRect } from "../menu.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaSelection } from "./selection.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";
import type { TeamArenaTeamInfo } from "./team-info.ts";

export interface TeamArenaUiCinematicServices {
  readonly cinematics: EngineUiCinematics;
  readonly game: TeamArenaGameInfo;
  readonly teams: TeamArenaTeamInfo;
  readonly selection: TeamArenaSelection;
  readonly cvars: TeamArenaUiCvars;
  readonly servers: TeamArenaServerBrowser;
  assertActive(): void;
}

/** UI integer values are the engine's cinematic table indexes, not UI-local handles. */
export class TeamArenaUiCinematics {
  constructor(private readonly services: TeamArenaUiCinematicServices) {
    services.assertActive();
    if (services.cinematics.profile !== "ui") throw new Error("Team Arena cinematic traps require the UI cinematic profile");
  }

  async play(path: string, rect: UiRect): Promise<number> {
    const services = this.services;
    services.assertActive();
    const asset = await services.cinematics.owner.prepare(path);
    services.assertActive();
    const instance = services.cinematics.play(asset, rect);
    services.assertActive();
    return instance === undefined ? -1 : instance.handle.index;
  }

  stop(index: number): void {
    const services = this.services;
    services.assertActive();
    if (index >= 0) {
      services.cinematics.owner.stopSlot(index);
      services.assertActive();
      return;
    }
    // QVM32 bg_lib abs uses integer negation; INT_MIN remains negative.
    const ownerDraw = index === -2147483648 ? index : -index;
    if (ownerDraw === 244) {
      const row = infoSlot(services.game.mapList, services.cvars.get("ui_currentMap").integerValue);
      if (row.cinematic >= 0) {
        services.cinematics.owner.stopSlot(row.cinematic);
        services.assertActive();
        row.cinematic = -1;
      }
    } else if (ownerDraw === 246) {
      if (services.servers.currentServerCinematic >= 0) {
        services.cinematics.owner.stopSlot(services.servers.currentServerCinematic);
        services.assertActive();
        services.servers.currentServerCinematic = -1;
      }
    } else if (ownerDraw === 251) {
      const name = sourceCommandText(services.cvars.registry.get("ui_teamName")?.value ?? "").slice(0, 1023);
      services.assertActive();
      const team = services.selection.teamIndexFromName(name);
      if (team >= 0 && team < services.teams.teamCount) {
        const row = infoSlot(services.teams.teamList, team);
        if (row.cinematic >= 0) {
          services.cinematics.owner.stopSlot(row.cinematic);
          services.assertActive();
          row.cinematic = -1;
        }
      }
    }
  }

  run(index: number): void {
    const services = this.services;
    services.assertActive();
    const handle = services.cinematics.owner.handleAtSlot(index);
    if (handle !== undefined) services.cinematics.owner.run(handle);
    services.assertActive();
  }

  draw(index: number, rect: UiRect, draw: Draw2D): void {
    const services = this.services;
    services.assertActive();
    const handle = services.cinematics.owner.handleAtSlot(index);
    if (handle === undefined) return;
    services.cinematics.owner.setExtents(handle, rect);
    services.assertActive();
    const call = services.cinematics.owner.prepareUiRaw(handle);
    if (call === null) return;
    const sourceRect = { x: Math.trunc(rect.x), y: Math.trunc(rect.y), width: Math.trunc(rect.width), height: Math.trunc(rect.height) };
    draw.stretchRawPixels(cinematicPixelRect(sourceRect, draw.width, draw.height), call);
    services.assertActive();
  }
}
