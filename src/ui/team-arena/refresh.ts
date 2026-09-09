// _UI_Refresh from id Software's code/ui/ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Draw2D } from "../../render/draw2d.ts";
import type { UiRuntime } from "../runtime.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { TeamArenaMenuController } from "./menu-controller.ts";
import type { TeamArenaUiResources } from "./resources.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";
import type { TeamArenaServerStatus } from "./server-status.ts";

export interface TeamArenaRefreshServices {
  readonly cvars: TeamArenaUiCvars;
  readonly runtime: UiRuntime;
  readonly menus: TeamArenaMenuController;
  readonly resources: TeamArenaUiResources;
  readonly browser: TeamArenaServerBrowser;
  readonly status: TeamArenaServerStatus;
  assertActive(): void;
}

/** UI display time is also updated by UI_ConsoleCommand, without advancing the FPS history. */
export class TeamArenaUiRefresh {
  realTime = 0;
  frameTime = 0;
  framesPerSecond = 0;
  private index = 0;
  private readonly previousTimes = new Int32Array(4);

  constructor(private readonly services: TeamArenaRefreshServices) {}

  setTime(realTime: number): void {
    this.services.assertActive();
    if (!Number.isInteger(realTime) || realTime < -2147483648 || realTime > 2147483647) {
      throw new RangeError("Team Arena UI display time requires source int32 milliseconds");
    }
    this.frameTime = (realTime - this.realTime) | 0;
    this.realTime = realTime;
    this.services.runtime.setDisplayTime(realTime);
  }

  async refresh(realTime: number, draw: Draw2D): Promise<void> {
    const services = this.services;
    services.assertActive();
    if (draw.space !== "team-ui-640") throw new Error("Team Arena refresh requires its source team-ui-640 display profile");
    this.setTime(realTime);
    const slot = this.index % 4;
    if (slot < 0) throw new RangeError("_UI_Refresh writes before its source previousTimes array after signed index wrap");
    this.previousTimes[slot] = this.frameTime;
    this.index = (this.index + 1) | 0;
    if (this.index > 4) {
      let total = 0;
      for (const previous of this.previousTimes) total = (total + previous) | 0;
      if (total === 0) total = 1;
      this.framesPerSecond = Math.fround(Math.trunc(4000 / total) | 0);
    }
    services.cvars.update(); services.assertActive();
    if (services.runtime.menuCount() > 0) {
      await services.runtime.frame({ time: this.realTime, frameTime: this.frameTime, draw }, this.framesPerSecond);
      services.assertActive();
      await services.browser.doRefresh(this.realTime); services.assertActive();
      await services.status.buildServerStatus(false, this.realTime); services.assertActive();
      await services.status.buildFindPlayerList(false, this.realTime); services.assertActive();
    }
    draw.setColor(null); services.assertActive();
    if (services.runtime.menuCount() > 0) {
      draw.drawHandlePic({ x: Math.fround(services.menus.cursorX - 16), y: Math.fround(services.menus.cursorY - 16),
        width: 32, height: 32 }, services.resources.assets.cursor);
    }
  }
}
