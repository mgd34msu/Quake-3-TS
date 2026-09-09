// UI_ConsoleCommand from id Software's code/ui/ui_atoms.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandContext } from "../../core/commands.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { RendererResources } from "../../render/world.ts";
import type { UiRuntime } from "../runtime.ts";
import type { TeamArenaCatalog } from "./catalog.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";
import type { TeamArenaUiMemory } from "./memory.ts";
import type { TeamArenaUiMenuLoader } from "./menu-loader.ts";
import type { TeamArenaPostGame } from "./postgame.ts";
import type { TeamArenaUiRefresh } from "./refresh.ts";

export interface TeamArenaConsoleServices {
  readonly refresh: TeamArenaUiRefresh;
  readonly runtime: UiRuntime;
  readonly memory: TeamArenaUiMemory;
  readonly loader: TeamArenaUiMenuLoader;
  readonly gameInfo: TeamArenaGameInfo;
  readonly catalog: TeamArenaCatalog;
  readonly postgame: TeamArenaPostGame;
  readonly renderer: RendererResources;
  readClient(): Parameters<TeamArenaPostGame["calculate"]>[1];
  assertActive(): void;
}

export class TeamArenaConsoleCommands {
  constructor(private readonly services: TeamArenaConsoleServices) {}

  async run(context: CommandContext, realTime: number): Promise<boolean> {
    const services = this.services;
    const current = (): void => { context.assertActive(); services.assertActive(); };
    current(); services.refresh.setTime(realTime); current();
    const arg = (index: number): string => {
      current(); return sourceCommandText(context.argv[index] ?? "").slice(0, 1023);
    };
    const command = arg(0).replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 32));
    if (command === "ui_test") { await services.postgame.show(true); current(); }
    switch (command) {
      case "ui_report": services.memory.report(); current(); return true;
      case "ui_load": await services.loader.reload(services.gameInfo, services.catalog); current(); return true;
      case "remapshader":
        if (context.argv.length === 4) {
          const original = arg(1).slice(0, 63), replacement = arg(2).slice(0, 63), offset = arg(3);
          await services.renderer.remapShader(original, replacement, offset); current(); return true;
        }
        return false;
      case "postgame": {
        const client = services.readClient(); current();
        await services.postgame.calculate(context, client, services.refresh.realTime); current(); return true;
      }
      case "ui_cache": await services.runtime.cacheAll(); current(); return true;
      // Both source calls are commented out, but the commands are still consumed.
      case "ui_teamorders": case "ui_cdkey": return true;
      default: return false; // ui_test shows postgame but deliberately falls through as unhandled.
    }
  }
}
