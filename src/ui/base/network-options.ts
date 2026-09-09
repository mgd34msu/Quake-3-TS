// Network options from id Software q3_ui/ui_network.c. GPL-2.0-or-later.
import { UI_CENTER, UI_RIGHT } from "../../render/font.ts";
import { addItem, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional, MenuSpin } from "./state.ts";

const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r";
const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const RATE_ITEMS: readonly string[] = ["<= 28.8K", "33.6K", "56K", "ISDN", "LAN/Cable/xDSL"];
enum NetworkId { Graphics = 10, Display = 11, Sound = 12, Network = 13, Rate = 14, Back = 15 }

export interface BaseNetworkOptionsNavigation {
  graphics(): Promise<void>;
  display(): Promise<void>;
  sound(): Promise<void>;
}

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function proportional(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
}
class NetworkRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap();
  readonly frameRight = bitmap();
  readonly graphics = proportional();
  readonly display = proportional();
  readonly sound = proportional();
  readonly network = proportional();
  readonly rate: MenuSpin = { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0,
    top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 };
  readonly back = bitmap();

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    for (const item of [this.banner, this.graphics, this.display, this.sound, this.network]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    for (const item of [this.frameLeft, this.frameRight, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    Object.assign(this.rate.common, new MenuCommon());
    this.rate.oldvalue = 0; this.rate.curvalue = 0; this.rate.numitems = 0; this.rate.top = 0;
    this.rate.itemnames = []; this.rate.width = 0; this.rate.height = 0; this.rate.columns = 0; this.rate.separation = 0;
  }
}

export class BaseNetworkOptionsMenu {
  private readonly record = new NetworkRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  constructor(readonly state: BaseUiState, private readonly navigation: BaseNetworkOptionsNavigation) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case NetworkId.Graphics:
        await popMenu(this.state); this.state.assertActive();
        await this.navigation.graphics(); this.state.assertActive();
        break;
      case NetworkId.Display:
        await popMenu(this.state); this.state.assertActive();
        await this.navigation.display(); this.state.assertActive();
        break;
      case NetworkId.Sound:
        await popMenu(this.state); this.state.assertActive();
        await this.navigation.sound(); this.state.assertActive();
        break;
      case NetworkId.Network:
        break;
      case NetworkId.Rate: {
        const value = this.record.rate.curvalue;
        if (value === 0) this.state.services.cvars.registry.setValue("rate", 2500);
        else if (value === 1) this.state.services.cvars.registry.setValue("rate", 3000);
        else if (value === 2) this.state.services.cvars.registry.setValue("rate", 4000);
        else if (value === 3) this.state.services.cvars.registry.setValue("rate", 5000);
        else if (value === 4) this.state.services.cvars.registry.setValue("rate", 25000);
        break;
      }
      case NetworkId.Back:
        await popMenu(this.state); this.state.assertActive();
        break;
    }
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS]) {
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
    r.banner.common.flags = MenuFlag.CenterJustify; r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "SYSTEM SETUP"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = FRAME_LEFT; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 0; r.frameLeft.common.y = 78; r.frameLeft.width = 256; r.frameLeft.height = 329;
    r.frameRight.common.name = FRAME_RIGHT; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    const tabs: readonly (readonly [MenuProportional, NetworkId, string, number])[] = [
      [r.graphics, NetworkId.Graphics, "GRAPHICS", 186], [r.display, NetworkId.Display, "DISPLAY", 213],
      [r.sound, NetworkId.Sound, "SOUND", 240], [r.network, NetworkId.Network, "NETWORK", 267],
    ];
    for (const [item, id, text, y] of tabs) {
      item.common.flags = MenuFlag.RightJustify | (id === NetworkId.Network ? 0 : MenuFlag.PulseIfFocus);
      item.common.id = id; item.common.callback = this.callback; item.common.x = 216; item.common.y = y;
      item.text = text; item.style = UI_RIGHT; item.color = COLORS.red;
    }
    r.rate.common.name = "Data Rate:"; r.rate.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
    r.rate.common.callback = this.callback; r.rate.common.id = NetworkId.Rate;
    r.rate.common.x = 400; r.rate.common.y = 222; r.rate.itemnames = RATE_ITEMS;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.callback = this.callback; r.back.common.id = NetworkId.Back;
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.graphics, r.display, r.sound, r.network, r.rate, r.back]) {
      addItem(this.state, r.menu, item);
    }
    const variable = this.state.services.cvars.registry.get("rate");
    const rate = nativeInt(variable === undefined ? 0 : variable.numericValue);
    if (rate <= 2500) r.rate.curvalue = 0;
    else if (rate <= 3000) r.rate.curvalue = 1;
    else if (rate <= 4000) r.rate.curvalue = 2;
    else if (rate <= 5000) r.rate.curvalue = 3;
    else r.rate.curvalue = 4;
  }

  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive();
    await pushMenu(this.state, this.record.menu); this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.network); this.state.assertActive();
  }
}
