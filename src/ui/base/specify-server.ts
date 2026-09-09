// Specify Server from id Software q3_ui/ui_specifyserver.c. GPL-2.0-or-later.
import { UI_CENTER } from "../../render/font.ts";
import { MenuField } from "./field.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuFieldItem } from "./state.ts";

const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const GO = "menu/art/fight_0", GO_FOCUS = "menu/art/fight_1";
enum SpecifyId { Back = 102, Go = 103 }

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
class SpecifyRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly domain: MenuFieldItem = { kind: "field", common: new MenuCommon(), field: new MenuField() };
  readonly port: MenuFieldItem = { kind: "field", common: new MenuCommon(), field: new MenuField() };
  readonly go = bitmap();
  readonly back = bitmap();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.color = COLORS.white; this.banner.style = 0;
    for (const item of [this.frameLeft, this.frameRight, this.go, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    for (const item of [this.domain, this.port]) {
      Object.assign(item.common, new MenuCommon()); item.field.reset();
    }
  }
}

export class BaseSpecifyServerMenu {
  private readonly record = new SpecifyRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  constructor(readonly state: BaseUiState) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case SpecifyId.Go: {
        const domain = this.record.domain.field.text;
        if (domain.length === 0) return;
        const port = this.record.port.field.text;
        let destination = domain;
        if (port.length !== 0) {
          const suffix = `:${port}`;
          if (suffix.length >= 128) {
            this.state.services.print(`Com_sprintf: overflow of ${suffix.length} in 128\n`);
            this.state.assertActive();
          }
          // Q_strncpyz writes all 128 bytes, including padding, into buff[256].
          if (domain.length > 128) throw new RangeError("Undefined native specify server destination write");
          destination += suffix.slice(0, 127);
        }
        this.state.services.consoleCommands.append(`connect ${destination}\n`);
        break;
      }
      case SpecifyId.Back:
        await popMenu(this.state); this.state.assertActive();
        break;
    }
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS, GO, GO_FOCUS]) {
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
    r.banner.text = "SPECIFY SERVER"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = FRAME_LEFT; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 0; r.frameLeft.common.y = 78; r.frameLeft.width = 256; r.frameLeft.height = 329;
    r.frameRight.common.name = FRAME_RIGHT; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    r.domain.common.name = "Address:"; r.domain.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
    r.domain.common.x = 206; r.domain.common.y = 220; r.domain.field.widthInChars = 38; r.domain.field.maxchars = 80;
    r.port.common.name = "Port:"; r.port.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont | MenuFlag.NumbersOnly;
    r.port.common.x = 206; r.port.common.y = 250; r.port.field.widthInChars = 6; r.port.field.maxchars = 5;
    r.go.common.name = GO; r.go.common.flags = MenuFlag.RightJustify | MenuFlag.PulseIfFocus;
    r.go.common.callback = this.callback; r.go.common.id = SpecifyId.Go;
    r.go.common.x = 640; r.go.common.y = 416; r.go.width = 128; r.go.height = 64; r.go.focuspic = GO_FOCUS;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.callback = this.callback; r.back.common.id = SpecifyId.Back;
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.domain, r.port, r.go, r.back]) addItem(this.state, r.menu, item);
    r.port.field.setText("27960");
  }

  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive();
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
  }
}
