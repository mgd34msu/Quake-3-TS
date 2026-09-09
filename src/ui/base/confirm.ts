// Genuine confirmation and message menus from id Software q3_ui/ui_confirm.c. GPL-2.0-or-later.
import { KeyCode } from "../../core/key-codes.ts";
import { UI_CENTER, UI_INVERSE, UI_SMALLFONT } from "../../render/font.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuProportional, MenuSound } from "./state.ts";
import { drawNamed, drawProportional, stringWidth } from "./draw.ts";
import { addItem, defaultKey, drawMenu, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
type ConfirmAction = (result: boolean) => Promise<void>;
class ConfirmRecord {
  readonly menu = new BaseMenu();
  readonly yes: MenuProportional = { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.red, style: 0 };
  readonly no: MenuProportional = { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.red, style: 0 };
  slashX = 0;
  question = "";
  draw: (() => Promise<void>) | null = null;
  action: ConfirmAction | null = null;
  style = 0;
  lines: readonly string[] = [];
  reset(): void {
    this.menu.cursor = 0;
    this.menu.cursorPrev = 0;
    this.menu.itemCount = 0;
    this.menu.items.length = 0;
    this.menu.draw = null;
    this.menu.key = null;
    this.menu.wrapAround = false;
    this.menu.fullscreen = false;
    this.menu.showlogo = false;
    for (const item of [this.yes, this.no]) {
      Object.assign(item.common, new MenuCommon());
      item.text = null;
      item.style = 0;
      item.color = COLORS.red;
    }
    this.slashX = 0;
    this.question = "";
    this.draw = null;
    this.action = null;
    this.style = 0;
    this.lines = [];
  }
}
export class BaseConfirmMenu {
  private readonly record = new ConfirmRecord();
  constructor(readonly state: BaseUiState) { }
  get menu(): BaseMenu { return this.record.menu; }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated)
      return;
    await popMenu(this.state);
    this.state.assertActive();
    const result = item.common.id !== 10;
    const action = this.record.action;
    if (action !== null) {
      await action(result);
      this.state.assertActive();
    }
  }
  private async key(key: number): Promise<MenuSound> {
    if (key === KeyCode.Left || key === KeyCode.KeypadLeft || key === KeyCode.Right || key === KeyCode.KeypadRight)
      key = KeyCode.Tab;
    else if (key === 78 || key === 110) {
      await this.event(this.record.no, MenuEvent.Activated);
      this.state.assertActive();
    }
    else if (key === 89 || key === 121) {
      await this.event(this.record.yes, MenuEvent.Activated);
      this.state.assertActive();
    }
    return await defaultKey(this.state, this.record.menu, key);
  }
  private async draw(message: boolean): Promise<void> {
    await drawNamed(this.state, 142, 118, 359, 256, "menu/art/cut_frame");
    this.state.assertActive();
    if (message) {
      let y = 188;
      for (const line of this.record.lines) {
        drawProportional(this.state, 320, y, line, this.record.style, COLORS.red);
        y += 18;
      }
    }
    else {
      drawProportional(this.state, 320, 204, this.record.question, this.record.style, COLORS.red);
      drawProportional(this.state, this.record.slashX, 265, "/", UI_INVERSE, COLORS.red);
    }
    await drawMenu(this.state, this.record.menu);
    this.state.assertActive();
    const draw = this.record.draw;
    if (draw !== null) {
      await draw();
      this.state.assertActive();
    }
  }
  private async reset(): Promise<void> {
    this.state.assertActive();
    this.record.reset();
    await this.cache();
    this.state.assertActive();
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    await this.state.services.resources.registerShaderNoMip("menu/art/cut_frame");
    this.state.assertActive();
  }
  private configureMenu(message: boolean): void {
    const menu = this.record.menu;
    menu.draw = () => this.draw(message);
    menu.key = key => this.key(key);
    menu.wrapAround = true;
    const phase = this.state.services.readClientPhase();
    menu.fullscreen = phase === "uninitialized" || phase === "disconnected" || phase === "connecting" || phase === "challenging";
  }
  private configureItem(item: MenuProportional, id: number, x: number, y: number, text: string): void {
    item.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    item.common.callback = (item, event) => this.event(item, event);
    item.common.id = id;
    item.common.x = x;
    item.common.y = y;
    item.text = text;
  }
  async show(question: string, draw: (() => Promise<void>) | null, action: ConfirmAction | null, style = UI_CENTER | UI_INVERSE): Promise<void> {
    await this.reset();
    this.state.assertActive();
    const width = stringWidth("YES/NO"), yes = stringWidth("YES") + 3, slash = stringWidth("/") + 3;
    const left = 320 - nativeInt(width / 2);
    this.record.slashX = left + yes;
    this.record.question = question;
    this.record.draw = draw;
    this.record.action = action;
    this.record.style = style;
    this.configureMenu(false);
    this.configureItem(this.record.yes, 11, left, 264, "YES");
    this.configureItem(this.record.no, 10, left + yes + slash, 264, "NO");
    addItem(this.state, this.record.menu, this.record.yes);
    addItem(this.state, this.record.menu, this.record.no);
    await pushMenu(this.state, this.record.menu);
    this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.no);
    this.state.assertActive();
  }
  async message(lines: readonly string[]): Promise<void> {
    await this.reset();
    this.state.assertActive();
    this.record.lines = lines;
    this.record.style = UI_CENTER | UI_INVERSE | UI_SMALLFONT;
    this.configureMenu(true);
    this.configureItem(this.record.yes, 11, 320 - nativeInt(stringWidth("OK") / 2), 280, "OK");
    addItem(this.state, this.record.menu, this.record.yes);
    await pushMenu(this.state, this.record.menu);
    this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.yes);
    this.state.assertActive();
  }
}
