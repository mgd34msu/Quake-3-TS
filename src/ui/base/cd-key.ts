// CD key menu from id Software q3_ui/ui_cdkey.c. GPL-2.0-or-later.
import { validateCdKey } from "../../engine/cd-key.ts";
import type { CommonCdKeyState } from "../../engine/cd-key.ts";
import { UI_BLINK, UI_CENTER, UI_SMALLFONT } from "../../render/font.ts";
import { drawChar, drawProportional, drawString, fillRect } from "./draw.ts";
import { MenuField } from "./field.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, menuParent } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuFieldItem } from "./state.ts";

const FRAME = "menu/art/cut_frame";
const ACCEPT = "menu/art/accept_0", ACCEPT_FOCUS = "menu/art/accept_1";
const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
enum CdKeyId { Accept = 11, Back = 12 }

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function preValidateKey(key: string): number {
  if (key.length !== 16) return 1;
  for (const character of key) if (!"237abcdghjlprstw".includes(character)) return -1;
  return 0;
}
class CdKeyRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frame = bitmap();
  readonly cdkey: MenuFieldItem = { kind: "field", common: new MenuCommon(), field: new MenuField() };
  readonly accept = bitmap();
  readonly back = bitmap();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.color = COLORS.white; this.banner.style = 0;
    for (const item of [this.frame, this.accept, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    Object.assign(this.cdkey.common, new MenuCommon()); this.cdkey.field.reset();
  }
}

export class BaseCdKeyMenu {
  private readonly record = new CdKeyRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  constructor(readonly state: BaseUiState, private readonly keys: CommonCdKeyState, private readonly usesUniqueKey: () => number) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case CdKeyId.Accept:
        if (this.record.cdkey.field.text.length !== 0)
          this.keys.writeUiForCompiledModule(this.usesUniqueKey, () => this.record.cdkey.field.copyBytes(16));
        await popMenu(this.state); this.state.assertActive();
        break;
      case CdKeyId.Back:
        await popMenu(this.state); this.state.assertActive();
        break;
    }
  }

  private drawKey(item: BaseMenuItem): void {
    this.state.assertActive();
    if (item.kind !== "field") throw new Error("CD key ownerdraw requires its source field");
    const focus = menuParent(item).cursor === item.common.menuPosition;
    const color = focus ? COLORS.highlight : COLORS.normal;
    fillRect(this.state, 192, 232, 256, 16, COLORS.listbar);
    drawString(this.state, 192, 232, item.field.text, 0, color);
    if (focus) drawChar(this.state, 192 + item.field.cursor * 16, 232,
      this.state.services.keys.getOverstrike() ? 11 : 10, UI_BLINK, COLORS.white);
    const valid = preValidateKey(item.field.text);
    drawProportional(this.state, 320, 376,
      valid === 1 ? "Please enter your CD Key" : valid === 0 ? "The CD Key appears to be valid, thank you" : "The CD Key is not valid",
      UI_CENTER | UI_SMALLFONT, valid === 1 ? COLORS.highlight : valid === 0 ? COLORS.white : COLORS.red);
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [ACCEPT, ACCEPT_FOCUS, BACK, BACK_FOCUS, FRAME]) {
      await this.state.services.resources.registerShaderNoMip(name);
      this.state.assertActive();
    }
  }

  private async initialize(): Promise<void> {
    this.state.assertActive();
    this.state.services.cvars.registry.set("ui_cdkeychecked", "1", true);
    await this.cache(); this.state.assertActive();
    const r = this.record;
    r.reset(); r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "CD KEY"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frame.common.name = FRAME; r.frame.common.flags = MenuFlag.Inactive;
    r.frame.common.x = 142; r.frame.common.y = 118; r.frame.width = 359; r.frame.height = 256;
    r.cdkey.common.name = "CD Key:"; r.cdkey.common.flags = MenuFlag.Lowercase;
    r.cdkey.common.x = 280; r.cdkey.common.y = 232; r.cdkey.field.widthInChars = 16; r.cdkey.field.maxchars = 16;
    r.cdkey.common.ownerdraw = async item => { this.drawKey(item); };
    r.accept.common.name = ACCEPT; r.accept.common.flags = MenuFlag.RightJustify | MenuFlag.PulseIfFocus;
    r.accept.common.id = CdKeyId.Accept; r.accept.common.callback = this.callback;
    r.accept.common.x = 640; r.accept.common.y = 416; r.accept.width = 128; r.accept.height = 64; r.accept.focuspic = ACCEPT_FOCUS;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.id = CdKeyId.Back; r.back.common.callback = this.callback;
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frame, r.cdkey, r.accept]) addItem(this.state, r.menu, item);
    if (this.state.menuDepth !== 0) addItem(this.state, r.menu, r.back);
    const bytes = new Uint8Array(17);
    this.keys.readUiForCompiledModule(this.usesUniqueKey, () => bytes); r.cdkey.field.setBytes(bytes);
    if (!validateCdKey(r.cdkey.field.text, null)) r.cdkey.field.setText("");
  }

  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive();
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
  }
}
