// Setup menu from id Software q3_ui/ui_setup.c. GPL-2.0-or-later.
import { UI_CENTER, UI_SMALLFONT } from "../../render/font.ts";
import type { BaseConfirmMenu } from "./confirm.ts";
import { drawProportional } from "./draw.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuProportional } from "./state.ts";

const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
enum SetupId { Player = 10, Controls = 11, System = 12, Game = 13, CdKey = 14, Defaults = 17, Back = 18 }
export interface BaseSetupNavigation {
  playerSettings(): Promise<void>;
  controls(): Promise<void>;
  graphics(): Promise<void>;
  preferences(): Promise<void>;
  cdKey(): Promise<void>;
}
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function text(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
}
class SetupRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap(); readonly frameRight = bitmap(); readonly back = bitmap();
  readonly player = text(); readonly controls = text(); readonly system = text();
  readonly game = text(); readonly cdkey = text(); readonly defaults = text();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.banner, this.player, this.controls, this.system, this.game, this.cdkey, this.defaults]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    for (const item of [this.frameLeft, this.frameRight, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
  }
}

export class BaseSetupMenu {
  private readonly record = new SetupRecord();
  constructor(readonly state: BaseUiState, private readonly confirm: BaseConfirmMenu, private readonly navigation: BaseSetupNavigation) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case SetupId.Player: await this.navigation.playerSettings(); break;
      case SetupId.Controls: await this.navigation.controls(); break;
      case SetupId.System: await this.navigation.graphics(); break;
      case SetupId.Game: await this.navigation.preferences(); break;
      case SetupId.CdKey: await this.navigation.cdKey(); break;
      case SetupId.Defaults:
        await this.confirm.show("SET TO DEFAULTS?", async () => {
          this.state.assertActive();
          drawProportional(this.state, 320, 356, "WARNING: This will reset *ALL*", UI_CENTER | UI_SMALLFONT, COLORS.highlight);
          drawProportional(this.state, 320, 383, "options to their default values.", UI_CENTER | UI_SMALLFONT, COLORS.highlight);
        }, async result => {
          this.state.assertActive();
          if (!result) return;
          this.state.services.consoleCommands.append("exec default.cfg\n");
          this.state.services.consoleCommands.append("cvar_restart\n");
          this.state.services.consoleCommands.append("vid_restart\n");
        });
        break;
      case SetupId.Back: await popMenu(this.state); break;
    }
    this.state.assertActive();
  }

  private paused(): boolean {
    const value = this.state.services.cvars.registry.get("cl_paused");
    return value !== undefined && value.numericValue !== 0;
  }
  private configure(item: MenuProportional, id: SetupId, label: string, y: number): void {
    item.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus;
    item.common.x = 320; item.common.y = y; item.common.id = id;
    item.common.callback = (item, event) => this.event(item, event);
    item.text = label; item.color = COLORS.red; item.style = UI_CENTER;
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [BACK, BACK_FOCUS, FRAME_LEFT, FRAME_RIGHT]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }

  async show(): Promise<void> {
    await this.cache(); this.state.assertActive();
    const r = this.record; r.reset(); r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "SETUP"; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = FRAME_LEFT; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 0; r.frameLeft.common.y = 78; r.frameLeft.width = 256; r.frameLeft.height = 329;
    r.frameRight.common.name = FRAME_RIGHT; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    this.configure(r.player, SetupId.Player, "PLAYER", 134);
    this.configure(r.controls, SetupId.Controls, "CONTROLS", 168);
    this.configure(r.system, SetupId.System, "SYSTEM", 202);
    this.configure(r.game, SetupId.Game, "GAME OPTIONS", 236);
    this.configure(r.cdkey, SetupId.CdKey, "CD Key", 270);
    if (!this.paused()) this.configure(r.defaults, SetupId.Defaults, "DEFAULTS", 304);
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.id = SetupId.Back; r.back.common.callback = (item, event) => this.event(item, event);
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.player, r.controls, r.system, r.game, r.cdkey]) addItem(this.state, r.menu, item);
    if (!this.paused()) addItem(this.state, r.menu, r.defaults);
    addItem(this.state, r.menu, r.back);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
