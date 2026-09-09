// Display options from id Software q3_ui/ui_display.c. GPL-2.0-or-later.
import type { RendererConfigurationSnapshot } from "../../render/configuration.ts";
import { UI_CENTER, UI_RIGHT } from "../../render/font.ts";
import { addItem, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional, MenuSlider } from "./state.ts";

const ART = ["menu/art/frame2_l", "menu/art/frame1_r", "menu/art/back_0", "menu/art/back_1"];
const f = Math.fround;
enum Id { Graphics = 10, Display = 11, Sound = 12, Network = 13, Brightness = 14, ScreenSize = 15, Back = 16 }
export interface BaseDisplayOptionsNavigation {
  graphics(): Promise<void>;
  sound(): Promise<void>;
  network(): Promise<void>;
}
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null, width: 0, height: 0, focuscolor: null };
}
function proportional(): MenuProportional { return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 }; }
function slider(): MenuSlider { return { kind: "slider", common: new MenuCommon(), minvalue: 0, maxvalue: 0, curvalue: 0, range: 0 }; }
// Cvar_SetValue's binary32 argument and libc fixed-six, nearest-even formatting.
function cvarValue(value: number): string {
  const integer = nativeInt(value);
  if (value === integer) return String(integer);
  const scaled = Math.abs(value) * 1_000_000, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = fraction > .5 || (fraction === .5 && lower % 2 !== 0) ? lower + 1 : lower;
  return `${value < 0 ? "-" : ""}${Math.trunc(rounded / 1_000_000)}.${String(rounded % 1_000_000).padStart(6, "0")}`;
}
class DisplayRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap(); readonly frameRight = bitmap(); readonly back = bitmap();
  readonly graphics = proportional(); readonly display = proportional(); readonly sound = proportional(); readonly network = proportional();
  readonly brightness = slider(); readonly screenSize = slider();
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
    for (const item of [this.brightness, this.screenSize]) {
      Object.assign(item.common, new MenuCommon()); item.minvalue = 0; item.maxvalue = 0; item.curvalue = 0; item.range = 0;
    }
  }
}

export class BaseDisplayOptionsMenu {
  private readonly record = new DisplayRecord();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  /** uiConfiguration is borrowed from UI_Init's retained copy after game-info initialization.
   * Construction, cache and show never sample the live renderer configuration.
   */
  constructor(readonly state: BaseUiState, private readonly uiConfiguration: RendererConfigurationSnapshot, private readonly navigation: BaseDisplayOptionsNavigation) {}
  get menu(): BaseMenu { return this.record.menu; }
  private variable(name: string): number {
    const value = this.state.services.cvars.registry.get(name);
    return value === undefined ? 0 : value.numericValue;
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return;
    switch (item.common.id) {
      case Id.Graphics: await popMenu(this.state); this.state.assertActive(); await this.navigation.graphics(); this.state.assertActive(); break;
      case Id.Display: break;
      case Id.Sound: await popMenu(this.state); this.state.assertActive(); await this.navigation.sound(); this.state.assertActive(); break;
      case Id.Network: await popMenu(this.state); this.state.assertActive(); await this.navigation.network(); this.state.assertActive(); break;
      case Id.Brightness: this.state.services.cvars.registry.set("r_gamma", cvarValue(f(f(this.record.brightness.curvalue) / 10)), true); break;
      case Id.ScreenSize: this.state.services.cvars.registry.set("cg_viewsize", cvarValue(f(f(this.record.screenSize.curvalue) * 10)), true); break;
      case Id.Back: await popMenu(this.state); this.state.assertActive(); break;
    }
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of ART) { await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive(); }
  }
  private async initialize(): Promise<void> {
    this.state.assertActive(); const r = this.record; r.reset(); await this.cache(); this.state.assertActive();
    r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.banner.common.flags = MenuFlag.CenterJustify; r.banner.common.x = 320; r.banner.common.y = 16;
    r.banner.text = "SYSTEM SETUP"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frameLeft.common.name = "menu/art/frame2_l"; r.frameLeft.common.flags = MenuFlag.Inactive;
    r.frameLeft.common.x = 0; r.frameLeft.common.y = 78; r.frameLeft.width = 256; r.frameLeft.height = 329;
    r.frameRight.common.name = "menu/art/frame1_r"; r.frameRight.common.flags = MenuFlag.Inactive;
    r.frameRight.common.x = 376; r.frameRight.common.y = 76; r.frameRight.width = 256; r.frameRight.height = 334;
    const tabs: readonly (readonly [MenuProportional, Id, string, number])[] = [
      [r.graphics, Id.Graphics, "GRAPHICS", 186], [r.display, Id.Display, "DISPLAY", 213],
      [r.sound, Id.Sound, "SOUND", 240], [r.network, Id.Network, "NETWORK", 267],
    ];
    for (const [item, id, text, y] of tabs) {
      item.common.flags = MenuFlag.RightJustify | (id === Id.Display ? 0 : MenuFlag.PulseIfFocus);
      item.common.id = id; item.common.callback = this.callback; item.common.x = 216; item.common.y = y;
      item.text = text; item.style = UI_RIGHT; item.color = COLORS.red;
    }
    for (const [item, id, name, y, min, max] of [
      [r.brightness, Id.Brightness, "Brightness:", 222, 5, 20], [r.screenSize, Id.ScreenSize, "Screen Size:", 240, 3, 10],
    ] satisfies readonly (readonly [MenuSlider, Id, string, number, number, number])[]) {
      item.common.name = name; item.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
      item.common.callback = this.callback; item.common.id = id; item.common.x = 400; item.common.y = y; item.minvalue = min; item.maxvalue = max;
    }
    if (!this.uiConfiguration.deviceSupportsGamma) r.brightness.common.flags |= MenuFlag.Grayed;
    r.back.common.name = "menu/art/back_0"; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    r.back.common.callback = this.callback; r.back.common.id = Id.Back; r.back.common.x = 0; r.back.common.y = 416;
    r.back.width = 128; r.back.height = 64; r.back.focuspic = "menu/art/back_1";
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.graphics, r.display, r.sound, r.network, r.brightness, r.screenSize, r.back]) addItem(this.state, r.menu, item);
    r.brightness.curvalue = f(this.variable("r_gamma") * 10); r.screenSize.curvalue = f(this.variable("cg_viewsize") / 10);
  }
  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive(); await pushMenu(this.state, this.record.menu); this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.display); this.state.assertActive();
  }
}
