// UI_Pause, _UI_SetActiveMenu and UI input entrypoints from code/ui/ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { KEY_CHAR_FLAG, KeyCatcher, KeyCode } from "../../core/key-codes.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { ClientKeys } from "../../engine/client-keys.ts";
import { UiMenuCommand } from "../public.ts";
import type { UiRuntime } from "../runtime.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { TeamArenaPlayerList } from "./player-list.ts";
import type { TeamArenaUiMenuLoader } from "./menu-loader.ts";

export interface TeamArenaMenuServices {
  readonly runtime: UiRuntime;
  readonly keys: ClientKeys;
  readonly cvars: TeamArenaUiCvars;
  readonly players: TeamArenaPlayerList;
  readonly loader: Pick<TeamArenaUiMenuLoader, "inGameLoad" | "loadNonIngame">;
  readClient(): Parameters<TeamArenaPlayerList["build"]>[0];
  assertActive(): void;
}

/** The selected source never sets uiInfo.inGameLoad: _UI_Init's assignment is commented out. */
export class TeamArenaMenuController {
  cursorX = 0;
  cursorY = 0;

  constructor(private readonly services: TeamArenaMenuServices) {}

  isFullscreen(): boolean {
    this.services.assertActive();
    return this.services.runtime.anyFullScreenVisible();
  }

  async pause(paused: boolean): Promise<void> {
    const services = this.services;
    services.assertActive();
    if (paused) {
      services.cvars.registry.set("cl_paused", "1", true); services.assertActive();
      services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
    } else {
      services.keys.setCatcher(services.keys.getCatcher() & ~KeyCatcher.Ui); services.assertActive();
      await services.keys.clearStates(); services.assertActive();
      services.cvars.registry.set("cl_paused", "0", true); services.assertActive();
    }
  }

  async keyEvent(key: number, down: boolean): Promise<void> {
    const services = this.services, runtime = services.runtime;
    services.assertActive();
    if (runtime.menuCount() === 0) return;
    const focused = runtime.focusedMenuHandle();
    if (focused === undefined) {
      await this.pause(false);
    } else if (key === KeyCode.Escape && down && !runtime.anyFullScreenVisible()) {
      await runtime.closeAll(); services.assertActive();
    } else {
      await runtime.handleCapturedKey(focused, (key & KEY_CHAR_FLAG) !== 0 && down
        ? { kind: "character", code: key & ~KEY_CHAR_FLAG } : { kind: "key", code: key, down });
      services.assertActive();
    }
  }

  async mouseEvent(dx: number, dy: number): Promise<void> {
    const services = this.services, runtime = services.runtime;
    services.assertActive();
    for (const delta of [dx, dy]) {
      if (!Number.isInteger(delta) || delta < -2147483648 || delta > 2147483647) {
        throw new RangeError("Team Arena mouse deltas require source int32 values");
      }
    }
    this.cursorX = Math.max(0, Math.min(640, Math.fround(Math.fround(this.cursorX) + Math.fround(dx))));
    this.cursorY = Math.max(0, Math.min(480, Math.fround(Math.fround(this.cursorY) + Math.fround(dy))));
    runtime.setDisplayCursor(this.cursorX, this.cursorY);
    if (runtime.menuCount() > 0) {
      await runtime.pointerMove(this.cursorX, this.cursorY); services.assertActive();
    }
  }

  async setActiveMenu(menu: UiMenuCommand): Promise<void> {
    const services = this.services, runtime = services.runtime;
    services.assertActive();
    if (runtime.menuCount() === 0) return;
    switch (menu) {
      case UiMenuCommand.None:
        services.keys.setCatcher(services.keys.getCatcher() & ~KeyCatcher.Ui); services.assertActive();
        await services.keys.clearStates(); services.assertActive();
        services.cvars.registry.set("cl_paused", "0", true); services.assertActive();
        await runtime.closeAll(); services.assertActive();
        return;
      case UiMenuCommand.Main: {
        services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
        if (services.loader.inGameLoad) { await services.loader.loadNonIngame(); services.assertActive(); }
        await runtime.closeAll(); services.assertActive();
        await runtime.activate("main"); services.assertActive();
        const error = sourceCommandText(services.cvars.registry.get("com_errorMessage")?.value ?? "").slice(0, 255);
        if (error.length !== 0) {
          if (services.cvars.get("ui_singlePlayerActive").integerValue === 0) {
            await runtime.activate("error_popmenu"); services.assertActive();
          } else {
            services.cvars.registry.set("com_errorMessage", "", true); services.assertActive();
          }
        }
        return;
      }
      case UiMenuCommand.Team:
        services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
        await runtime.activate("team"); services.assertActive();
        return;
      case UiMenuCommand.NeedCd:
      case UiMenuCommand.BadCdKey:
        return;
      case UiMenuCommand.Postgame:
        services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
        if (services.loader.inGameLoad) { await services.loader.loadNonIngame(); services.assertActive(); }
        await runtime.closeAll(); services.assertActive();
        await runtime.activate("endofgame"); services.assertActive();
        return;
      case UiMenuCommand.InGame:
        services.cvars.registry.set("cl_paused", "1", true); services.assertActive();
        services.keys.setCatcher(KeyCatcher.Ui); services.assertActive();
        {
          const client = services.readClient(); services.assertActive();
          services.players.build(client); services.assertActive();
        }
        await runtime.closeAll(); services.assertActive();
        await runtime.activate("ingame"); services.assertActive();
        return;
    }
  }
}
