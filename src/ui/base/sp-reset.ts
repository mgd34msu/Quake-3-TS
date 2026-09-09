// Legacy reset menu from id Software q3_ui/ui_spreset.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { KeyCode } from "../../core/key-codes.ts";
import { UI_CENTER, UI_INVERSE, UI_SMALLFONT } from "../../render/font.ts";
import { drawNamed, drawProportional, stringWidth } from "./draw.ts";
import { addItem, defaultKey, drawMenu, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import type { BaseSpLevelMenu } from "./sp-level.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuProportional, MenuSound } from "./state.ts";

const YELLOW = { x: 1, y: 1, z: 0, w: 1 };

export class BaseSpResetMenu {
  readonly menu = new BaseMenu();
  private readonly yes: MenuProportional = { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.red, style: 0 };
  private readonly no: MenuProportional = { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.red, style: 0 };
  private slashX = 0;

  constructor(readonly state: BaseUiState, private readonly gameInfo: BaseUiGameInfo, private readonly level: BaseSpLevelMenu) {}

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state);
    this.state.assertActive();
    if (item.common.id === 100) return;
    this.gameInfo.newGame();
    this.state.services.cvars.registry.set("ui_spSelection", "0", true);
    await popMenu(this.state);
    this.state.assertActive();
    await this.level.show();
    this.state.assertActive();
  }

  private async key(key: number): Promise<MenuSound> {
    if (key === KeyCode.KeypadLeft || key === KeyCode.Left || key === KeyCode.KeypadRight || key === KeyCode.Right) key = KeyCode.Tab;
    else if (key === 110 || key === 78) {
      await this.event(this.no, MenuEvent.Activated);
      this.state.assertActive();
    } else if (key === 121 || key === 89) {
      await this.event(this.yes, MenuEvent.Activated);
      this.state.assertActive();
    }
    return await defaultKey(this.state, this.menu, key);
  }

  private async draw(): Promise<void> {
    await drawNamed(this.state, 142, 118, 359, 256, "menu/art/cut_frame");
    this.state.assertActive();
    drawProportional(this.state, 320, 204, "RESET GAME?", UI_CENTER | UI_INVERSE, COLORS.red);
    drawProportional(this.state, this.slashX, 265, "/", UI_INVERSE, COLORS.red);
    await drawMenu(this.state, this.menu);
    this.state.assertActive();
    drawProportional(this.state, 320, 356, "WARNING: This resets all of the", UI_CENTER | UI_SMALLFONT, YELLOW);
    drawProportional(this.state, 320, 383, "single player game variables.", UI_CENTER | UI_SMALLFONT, YELLOW);
    drawProportional(this.state, 320, 410, "Do this only if you want to", UI_CENTER | UI_SMALLFONT, YELLOW);
    drawProportional(this.state, 320, 437, "start over from the beginning.", UI_CENTER | UI_SMALLFONT, YELLOW);
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    await this.state.services.resources.registerShaderNoMip("menu/art/cut_frame");
    this.state.assertActive();
  }

  async show(): Promise<void> {
    this.state.assertActive();
    this.menu.cursor = 0; this.menu.cursorPrev = 0;
    this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null;
    this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.yes, this.no]) {
      Object.assign(item.common, new MenuCommon());
      item.text = null; item.color = COLORS.red; item.style = 0;
    }
    this.slashX = 0;
    await this.cache();
    this.state.assertActive();
    const left = 320 - nativeInt(stringWidth("YES/NO") / 2);
    this.slashX = left + stringWidth("YES") + 3;
    this.menu.draw = () => this.draw();
    this.menu.key = key => this.key(key);
    this.menu.wrapAround = true;
    const phase = this.state.services.readClientPhase();
    this.menu.fullscreen = phase === "uninitialized" || phase === "disconnected" || phase === "connecting" || phase === "challenging";
    this.configure(this.yes, 101, left, "YES");
    this.configure(this.no, 100, this.slashX + stringWidth("/") + 3, "NO");
    addItem(this.state, this.menu, this.yes);
    addItem(this.state, this.menu, this.no);
    await pushMenu(this.state, this.menu);
    this.state.assertActive();
    await setCursorToItem(this.state, this.menu, this.no);
    this.state.assertActive();
  }

  private configure(item: MenuProportional, id: number, x: number, text: string): void {
    item.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    item.common.callback = (item, event) => this.event(item, event);
    item.common.id = id;
    item.common.x = x;
    item.common.y = 264;
    item.text = text;
  }
}
