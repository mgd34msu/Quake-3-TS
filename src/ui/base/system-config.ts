// System configuration menu from id Software q3_ui/ui_options.c. GPL-2.0-or-later.
import { UI_CENTER } from "../../render/font.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuProportional } from "./state.ts";

const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
enum OptionsId { Graphics = 10, Display = 11, Sound = 12, Network = 13, Back = 14 }
export interface BaseSystemConfigNavigation {
  graphics(): Promise<void>;
  display(): Promise<void>;
  sound(): Promise<void>;
  network(): Promise<void>;
}
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function text(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
}
class OptionsRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap(); readonly frameRight = bitmap(); readonly back = bitmap();
  readonly graphics = text(); readonly display = text(); readonly sound = text(); readonly network = text();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.banner, this.graphics, this.display, this.sound, this.network]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    for (const item of [this.frameLeft, this.frameRight, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null;
      item.shader = null; item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
  }
}

export class BaseSystemConfigMenu {
  private readonly record = new OptionsRecord();
  constructor(private readonly state: BaseUiState, private readonly navigation: BaseSystemConfigNavigation) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case OptionsId.Graphics: await this.navigation.graphics(); break;
      case OptionsId.Display: await this.navigation.display(); break;
      case OptionsId.Sound: await this.navigation.sound(); break;
      case OptionsId.Network: await this.navigation.network(); break;
      case OptionsId.Back: await popMenu(this.state); break;
    }
    this.state.assertActive();
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }

  private async initialize(): Promise<void> {
    this.state.assertActive();
    const r = this.record; r.reset();
    await this.cache(); this.state.assertActive();
    r.menu.wrapAround = true;
    switch (this.state.services.readClientPhase()) {
      case "uninitialized": case "disconnected": case "connecting": case "challenging": r.menu.fullscreen = true; break;
      case "connected": case "loading": case "primed": case "active": case "cinematic": r.menu.fullscreen = false; break;
    }
    r.banner.common.flags = MenuFlag.CenterJustify; r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "SYSTEM SETUP"; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = FRAME_LEFT; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 8; r.frameLeft.common.y = 76; r.frameLeft.width = 256; r.frameLeft.height = 334;
    r.frameRight.common.name = FRAME_RIGHT; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    const entries: readonly (readonly [MenuProportional, OptionsId, string])[] = [
      [r.graphics, OptionsId.Graphics, "GRAPHICS"], [r.display, OptionsId.Display, "DISPLAY"],
      [r.sound, OptionsId.Sound, "SOUND"], [r.network, OptionsId.Network, "NETWORK"],
    ];
    let y = 168;
    for (const [item, id, label] of entries) {
      item.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus; item.common.id = id;
      item.common.x = 320; item.common.y = y; item.common.callback = (item, event) => this.event(item, event);
      item.text = label; item.color = COLORS.red; item.style = UI_CENTER; y += 34;
    }
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.id = OptionsId.Back; r.back.common.callback = (item, event) => this.event(item, event);
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.graphics, r.display, r.sound, r.network, r.back]) addItem(this.state, r.menu, item);
  }

  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive();
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
  }
}
