// In-game menu from id Software q3_ui/ui_ingame.c. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_SMALLFONT } from "../../render/font.ts";
import type { BaseConfirmMenu } from "./confirm.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBitmap, MenuProportional } from "./state.ts";

const FRAME = "menu/art/addbotframe";
enum InGameId { Team = 10, AddBots = 11, RemoveBots = 12, Setup = 13, ServerInfo = 14, Leave = 15, Restart = 16, Quit = 17, Resume = 18, TeamOrders = 19 }
export interface BaseInGameNavigation {
  team(): Promise<void>;
  addBots(): Promise<void>;
  removeBots(): Promise<void>;
  teamOrders(): Promise<void>;
  setup(): Promise<void>;
  serverInfo(): Promise<void>;
  credits(): Promise<void>;
}
function text(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
}
class InGameRecord {
  readonly menu = new BaseMenu();
  readonly frame: MenuBitmap = { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
  readonly team = text(); readonly addbots = text(); readonly removebots = text(); readonly teamorders = text();
  readonly setup = text(); readonly server = text(); readonly restart = text(); readonly resume = text();
  readonly leave = text(); readonly quit = text();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.frame.common, new MenuCommon()); this.frame.focuspic = null; this.frame.errorpic = null; this.frame.shader = null;
    this.frame.focusshader = null; this.frame.width = 0; this.frame.height = 0; this.frame.focuscolor = null;
    for (const item of [this.team, this.addbots, this.removebots, this.teamorders, this.setup, this.server, this.restart, this.resume, this.leave, this.quit]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
  }
}

export class BaseInGameMenu {
  private readonly record = new InGameRecord();
  constructor(readonly state: BaseUiState, private readonly confirm: BaseConfirmMenu, private readonly navigation: BaseInGameNavigation) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case InGameId.Team: await this.navigation.team(); break;
      case InGameId.Setup: await this.navigation.setup(); break;
      case InGameId.ServerInfo: await this.navigation.serverInfo(); break;
      case InGameId.AddBots: await this.navigation.addBots(); break;
      case InGameId.RemoveBots: await this.navigation.removeBots(); break;
      case InGameId.TeamOrders: await this.navigation.teamOrders(); break;
      case InGameId.Leave: this.state.services.consoleCommands.append("disconnect\n"); break;
      case InGameId.Restart:
        await this.confirm.show("RESTART ARENA?", null, async result => {
          this.state.assertActive(); if (!result) return;
          await popMenu(this.state); this.state.assertActive();
          this.state.services.consoleCommands.append("map_restart 0\n");
        });
        break;
      case InGameId.Quit:
        await this.confirm.show("EXIT GAME?", null, async result => {
          this.state.assertActive(); if (!result) return;
          await popMenu(this.state); this.state.assertActive();
          await this.navigation.credits(); this.state.assertActive();
        });
        break;
      case InGameId.Resume: await popMenu(this.state); break;
    }
    this.state.assertActive();
  }

  private value(name: string): number {
    const variable = this.state.services.cvars.registry.get(name);
    return variable === undefined ? 0 : variable.numericValue;
  }
  private configure(item: MenuProportional, id: InGameId, label: string, y: number): void {
    item.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus;
    item.common.x = 320; item.common.y = y; item.common.id = id;
    item.common.callback = (item, event) => this.event(item, event);
    item.text = label; item.color = COLORS.red; item.style = UI_CENTER | UI_SMALLFONT;
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    await this.state.services.resources.registerShaderNoMip(FRAME); this.state.assertActive();
  }
  async show(client: EngineClientSession): Promise<void> {
    this.state.assertActive();
    this.state.menuDepth = 0; this.state.cursorX = 319; this.state.cursorY = 80;
    const r = this.record; r.reset();
    await this.cache(); this.state.assertActive();
    r.menu.wrapAround = true; r.menu.fullscreen = false;
    r.frame.common.name = FRAME; r.frame.common.flags = MenuFlag.Inactive;
    r.frame.common.x = 87; r.frame.common.y = 74; r.frame.width = 466; r.frame.height = 332;
    this.configure(r.team, InGameId.Team, "START", 88);
    this.configure(r.addbots, InGameId.AddBots, "ADD BOTS", 116);
    if (this.value("sv_running") === 0 || this.value("bot_enable") === 0 || this.value("g_gametype") === 2) r.addbots.common.flags |= MenuFlag.Grayed;
    this.configure(r.removebots, InGameId.RemoveBots, "REMOVE BOTS", 144);
    if (this.value("sv_running") === 0 || this.value("bot_enable") === 0 || this.value("g_gametype") === 2) r.removebots.common.flags |= MenuFlag.Grayed;
    this.configure(r.teamorders, InGameId.TeamOrders, "TEAM ORDERS", 172);
    if (!(this.value("g_gametype") >= 3)) r.teamorders.common.flags |= MenuFlag.Grayed;
    else {
      const index = 544 + client.readSnapshotClientNumber(); this.state.assertActive();
      if (index < 0 || index >= 1024) throw new RangeError("Undefined native in-game player info buffer after invalid configstring index");
      const info = sourceCommandText((client.getConfigString(index) ?? "").slice(0, 1023)); this.state.assertActive();
      if (gameAtoi(infoValueForKey(info, "t")) === 3) r.teamorders.common.flags |= MenuFlag.Grayed;
    }
    this.configure(r.setup, InGameId.Setup, "SETUP", 200);
    this.configure(r.server, InGameId.ServerInfo, "SERVER INFO", 228);
    this.configure(r.restart, InGameId.Restart, "RESTART ARENA", 256);
    if (this.value("sv_running") === 0) r.restart.common.flags |= MenuFlag.Grayed;
    this.configure(r.resume, InGameId.Resume, "RESUME GAME", 284);
    this.configure(r.leave, InGameId.Leave, "LEAVE ARENA", 312);
    this.configure(r.quit, InGameId.Quit, "EXIT GAME", 340);
    for (const item of [r.frame, r.team, r.addbots, r.removebots, r.teamorders, r.setup, r.server, r.restart, r.resume, r.leave, r.quit]) addItem(this.state, r.menu, item);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
