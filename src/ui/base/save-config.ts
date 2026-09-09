// Save Config from id Software q3_ui/ui_saveconfig.c. GPL-2.0-or-later.
import { UI_CENTER, UI_LEFT, UI_PULSE, UI_SMALLFONT } from "../../render/font.ts";
import { drawProportional, fillRect } from "./draw.ts";
import { MenuField } from "./field.ts";
import { addItem, menuItemAtCursor, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuFieldItem } from "./state.ts";

const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const SAVE = "menu/art/save_0", SAVE_FOCUS = "menu/art/save_1", BACKGROUND = "menu/art/cut_frame";

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
class SaveConfigRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly background = bitmap();
  readonly savename: MenuFieldItem = { kind: "field", common: new MenuCommon(), field: new MenuField() };
  readonly back = bitmap();
  readonly save = bitmap();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.color = COLORS.white; this.banner.style = 0;
    for (const item of [this.background, this.back, this.save]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    Object.assign(this.savename.common, new MenuCommon()); this.savename.field.reset();
  }
}

// q_shared.c COM_StripExtension stops at the first dot, including dots in directories.
function configStem(text: string): string {
  const dot = text.indexOf("."), length = dot === -1 ? text.length : dot;
  if (length >= 64) throw new RangeError("Undefined native save config filename write");
  return text.slice(0, length);
}

export class BaseSaveConfigMenu {
  private readonly record = new SaveConfigRecord();
  constructor(readonly state: BaseUiState) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async backEvent(event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
  }

  private async saveEvent(event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const text = this.record.savename.field.text;
    if (text.length === 0) return;
    this.state.services.consoleCommands.append(`writeconfig ${configStem(text)}.cfg\n`);
    await popMenu(this.state); this.state.assertActive();
  }

  private async savenameDraw(item: BaseMenuItem): Promise<void> {
    this.state.assertActive();
    if (item.kind !== "field") throw new Error("Save config ownerdraw requires a menu field");
    const focused = item === menuItemAtCursor(this.record.menu);
    const style = UI_LEFT | UI_SMALLFONT | (focused ? UI_PULSE : 0);
    drawProportional(this.state, 320, 192, "Enter filename:", UI_CENTER | UI_SMALLFONT, COLORS.normal);
    fillRect(this.state, item.common.x, item.common.y, item.field.widthInChars * 8, 16, COLORS.black);
    item.field.draw(this.state, item.common.x, item.common.y, style, focused ? COLORS.highlight : COLORS.red);
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [BACK, BACK_FOCUS, SAVE, SAVE_FOCUS, BACKGROUND]) {
      await this.state.services.resources.registerShaderNoMip(name);
      this.state.assertActive();
    }
  }

  private async initialize(): Promise<void> {
    this.state.assertActive();
    const r = this.record;
    r.reset();
    await this.cache(); this.state.assertActive();
    r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "SAVE CONFIG"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.background.common.name = BACKGROUND; r.background.common.flags = MenuFlag.Inactive;
    r.background.common.x = 142; r.background.common.y = 118; r.background.width = 359; r.background.height = 256;
    r.savename.common.flags = MenuFlag.NoDefaultInit | MenuFlag.Uppercase;
    r.savename.common.ownerdraw = item => this.savenameDraw(item);
    r.savename.field.widthInChars = 20; r.savename.field.maxchars = 20;
    r.savename.common.x = 240; r.savename.common.y = 227;
    r.savename.common.left = 240; r.savename.common.top = 227; r.savename.common.right = 393; r.savename.common.bottom = 245;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus; r.back.common.id = 11;
    r.back.common.callback = (_item, event) => this.backEvent(event);
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    r.save.common.name = SAVE; r.save.common.flags = MenuFlag.RightJustify | MenuFlag.PulseIfFocus; r.save.common.id = 12;
    r.save.common.callback = (_item, event) => this.saveEvent(event);
    r.save.common.x = 640; r.save.common.y = 416; r.save.width = 128; r.save.height = 64; r.save.focuspic = SAVE_FOCUS;
    for (const item of [r.banner, r.background, r.savename, r.back, r.save]) addItem(this.state, r.menu, item);
  }

  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive();
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
  }
}
