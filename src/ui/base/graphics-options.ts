// Graphics options and Driver Info from id Software q3_ui/ui_video.c. GPL-2.0-or-later.
import type { RendererConfigurationSnapshot } from "../../render/configuration.ts";
import { defaultOpenGlDriver } from "../../platform/native-libraries.ts";
import { UI_CENTER, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import { drawString } from "./draw.ts";
import { addItem, drawMenu, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional, MenuSlider, MenuSpin } from "./state.ts";

const FRAME_LEFT = "menu/art/frame2_l", FRAME_RIGHT = "menu/art/frame1_r", BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const ACCEPT = "menu/art/accept_0", ACCEPT_FOCUS = "menu/art/accept_1", f = Math.fround;
enum Id { Back = 101, Fullscreen = 102, List = 103, Mode = 104, DriverInfo = 105, Graphics = 106, Display = 107, Sound = 108, Network = 109 }
export interface BaseGraphicsOptionsNavigation {
  display(): Promise<void>;
  sound(): Promise<void>;
  network(): Promise<void>;
}
interface VideoOptions {
  readonly mode: number; readonly fullscreen: number; readonly tq: number; readonly lighting: number; readonly colordepth: number;
  readonly texturebits: number; readonly geometry: number; readonly filter: number; readonly driver: number; readonly extensions: number;
}
const TEMPLATES: readonly VideoOptions[] = [
  { mode: 4, fullscreen: 1, tq: 2, lighting: 0, colordepth: 2, texturebits: 2, geometry: 1, filter: 1, driver: 0, extensions: 1 },
  { mode: 3, fullscreen: 1, tq: 2, lighting: 0, colordepth: 0, texturebits: 0, geometry: 1, filter: 0, driver: 0, extensions: 1 },
  { mode: 2, fullscreen: 1, tq: 1, lighting: 0, colordepth: 1, texturebits: 0, geometry: 0, filter: 0, driver: 0, extensions: 1 },
  { mode: 2, fullscreen: 1, tq: 1, lighting: 1, colordepth: 1, texturebits: 0, geometry: 0, filter: 0, driver: 0, extensions: 1 },
  { mode: 3, fullscreen: 1, tq: 1, lighting: 0, colordepth: 0, texturebits: 0, geometry: 1, filter: 0, driver: 0, extensions: 1 },
];
function bitmap(): MenuBitmap { return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null, width: 0, height: 0, focuscolor: null }; }
function proportional(): MenuProportional { return { kind: "proportional", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 }; }
function spin(): MenuSpin { return { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0, top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 }; }
function resetMenu(menu: BaseMenu): void {
  menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
  menu.draw = null; menu.key = null; menu.wrapAround = false; menu.fullscreen = false; menu.showlogo = false;
}
function resetBitmap(item: MenuBitmap): void {
  Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
  item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
}
function frame(item: MenuBitmap, left: boolean): void {
  item.common.name = left ? FRAME_LEFT : FRAME_RIGHT; item.common.flags = MenuFlag.Inactive;
  item.common.x = left ? 0 : 376; item.common.y = left ? 78 : 76; item.width = 256; item.height = left ? 329 : 334;
}
function cvarValue(value: number): string {
  const integer = nativeInt(value);
  if (value === integer) return String(integer);
  const scaled = Math.abs(value) * 1_000_000, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = fraction > .5 || (fraction === .5 && lower % 2 !== 0) ? lower + 1 : lower;
  return `${value < 0 ? "-" : ""}${Math.trunc(rounded / 1_000_000)}.${String(rounded % 1_000_000).padStart(6, "0")}`;
}

class DriverInfoMenu {
  readonly menu = new BaseMenu();
  private readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  private readonly frameLeft = bitmap(); private readonly frameRight = bitmap(); private readonly back = bitmap();
  private readonly strings: string[] = [];
  constructor(private readonly state: BaseUiState, private readonly configuration: RendererConfigurationSnapshot) {}
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS]) { await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive(); }
  }
  private async draw(): Promise<void> {
    this.state.assertActive(); await drawMenu(this.state, this.menu); this.state.assertActive();
    const c = this.configuration;
    for (const [y, text] of [[80, "VENDOR"], [152, "PIXELFORMAT"], [192, "EXTENSIONS"]] satisfies readonly (readonly [number, string])[])
      drawString(this.state, 320, y, text, UI_CENTER | UI_SMALLFONT, COLORS.red);
    for (const [y, text] of [[96, c.vendorString], [112, c.versionString], [128, c.rendererString],
      [168, c.backend === "cpu" ? `color(${c.colorBits}-bits) Z(binary64) stencil(${c.stencilBits}-bits)`
        : `color(${c.colorBits}-bits) Z(${c.depthBits}-bits) stencil(${c.stencilBits}-bits)`],
    ] satisfies readonly (readonly [number, string])[]) drawString(this.state, 320, y, text, UI_CENTER | UI_SMALLFONT, COLORS.normal);
    let y = 208;
    for (let i = 0; i < Math.trunc(this.strings.length / 2); i++, y += 16) {
      drawString(this.state, 316, y, itemAt(this.strings, i * 2), UI_RIGHT | UI_SMALLFONT, COLORS.normal);
      drawString(this.state, 324, y, itemAt(this.strings, i * 2 + 1), UI_SMALLFONT, COLORS.normal);
    }
    if ((this.strings.length & 1) !== 0) drawString(this.state, 320, y, itemAt(this.strings, this.strings.length - 1), UI_CENTER | UI_SMALLFONT, COLORS.normal);
  }
  async show(): Promise<void> {
    this.state.assertActive(); resetMenu(this.menu); this.strings.length = 0;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.color = COLORS.white; this.banner.style = 0;
    for (const item of [this.frameLeft, this.frameRight, this.back]) resetBitmap(item);
    await this.cache(); this.state.assertActive(); this.menu.fullscreen = true; this.menu.draw = () => this.draw();
    this.banner.common.x = 320; this.banner.common.y = 16; this.banner.text = "DRIVER INFO"; this.banner.style = UI_CENTER;
    frame(this.frameLeft, true); frame(this.frameRight, false);
    this.back.common.name = BACK; this.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    this.back.common.id = 100; this.back.common.x = 0; this.back.common.y = 416; this.back.width = 128; this.back.height = 64; this.back.focuspic = BACK_FOCUS;
    this.back.common.callback = async (item, event) => {
      this.state.assertActive(); if (event !== MenuEvent.Activated || item.common.id !== 100) return;
      await popMenu(this.state); this.state.assertActive();
    };
    // At the 40-pointer limit, the source leaves the last word's separator intact.
    // Its final entry includes the remaining suffix, including spaces.
    const text = this.configuration.extensionsString.split("\0", 1).join("").slice(0, 1023);
    let offset = 0;
    while (offset < text.length && this.strings.length < 40) {
      while (text.charAt(offset) === " ") offset++;
      if (offset === text.length) break;
      const start = offset;
      while (offset < text.length && text.charAt(offset) !== " ") offset++;
      const word = text.slice(start, this.strings.length === 39 ? text.length : offset);
      this.strings.push(word.length > 32 ? `${word.slice(0, -1)}>` : word);
    }
    for (const item of [this.banner, this.frameLeft, this.frameRight, this.back]) addItem(this.state, this.menu, item);
    await pushMenu(this.state, this.menu); this.state.assertActive();
  }
}

class GraphicsRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frameLeft = bitmap(); readonly frameRight = bitmap(); readonly back = bitmap(); readonly apply = bitmap();
  readonly graphics = proportional(); readonly display = proportional(); readonly sound = proportional(); readonly network = proportional(); readonly driverinfo = proportional();
  readonly list = spin(); readonly mode = spin(); readonly driver = spin(); readonly fs = spin(); readonly lighting = spin();
  readonly extensions = spin(); readonly texturebits = spin(); readonly colordepth = spin(); readonly geometry = spin(); readonly filter = spin();
  readonly tq: MenuSlider = { kind: "slider", common: new MenuCommon(), minvalue: 0, maxvalue: 0, curvalue: 0, range: 0 };
  reset(): void {
    resetMenu(this.menu);
    for (const item of [this.banner, this.graphics, this.display, this.sound, this.network, this.driverinfo]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.color = COLORS.white; item.style = 0;
    }
    for (const item of [this.frameLeft, this.frameRight, this.back, this.apply]) resetBitmap(item);
    for (const item of [this.list, this.mode, this.driver, this.fs, this.lighting, this.extensions, this.texturebits, this.colordepth, this.geometry, this.filter]) {
      Object.assign(item.common, new MenuCommon()); item.oldvalue = 0; item.curvalue = 0; item.numitems = 0; item.top = 0;
      item.itemnames = []; item.width = 0; item.height = 0; item.columns = 0; item.separation = 0;
    }
    Object.assign(this.tq.common, new MenuCommon()); this.tq.minvalue = 0; this.tq.maxvalue = 0; this.tq.curvalue = 0; this.tq.range = 0;
  }
  values(): VideoOptions {
    return { mode: this.mode.curvalue, fullscreen: this.fs.curvalue, tq: this.tq.curvalue, lighting: this.lighting.curvalue,
      colordepth: this.colordepth.curvalue, texturebits: this.texturebits.curvalue, geometry: this.geometry.curvalue,
      filter: this.filter.curvalue, driver: this.driver.curvalue, extensions: this.extensions.curvalue };
  }
}

export class BaseGraphicsOptionsMenu {
  private readonly record = new GraphicsRecord();
  private readonly driverInfo: DriverInfoMenu;
  private initial: VideoOptions = this.record.values();
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  /** Borrow UI_Init's retained configuration copied after game info, never a live getter. */
  constructor(readonly state: BaseUiState, private readonly uiConfiguration: RendererConfigurationSnapshot, private readonly navigation: BaseGraphicsOptionsNavigation) {
    this.driverInfo = new DriverInfoMenu(state, uiConfiguration);
  }
  get menu(): BaseMenu { return this.record.menu; }
  private variable(name: string): number { const value = this.state.services.cvars.registry.get(name); return value === undefined ? 0 : value.numericValue; }
  private string(name: string): string { const value = this.state.services.cvars.registry.get(name); return value === undefined ? "" : value.value; }
  private setValue(name: string, value: number): void { this.state.assertActive(); this.state.services.cvars.registry.set(name, cvarValue(f(value)), true); }
  private update(): void {
    const r = this.record;
    if (r.fs.curvalue === 0) { r.colordepth.curvalue = 0; r.colordepth.common.flags |= MenuFlag.Grayed; }
    else r.colordepth.common.flags &= ~MenuFlag.Grayed;
    if (r.extensions.curvalue === 0 && r.texturebits.curvalue === 0) r.texturebits.curvalue = 1;
    const current = r.values();
    r.apply.common.flags |= MenuFlag.Hidden | MenuFlag.Inactive;
    const initial = this.initial;
    if (initial.mode !== current.mode || initial.fullscreen !== current.fullscreen || initial.tq !== current.tq
      || initial.lighting !== current.lighting || initial.colordepth !== current.colordepth || initial.texturebits !== current.texturebits
      || initial.geometry !== current.geometry || initial.filter !== current.filter || initial.driver !== current.driver
      || initial.extensions !== current.extensions) r.apply.common.flags &= ~(MenuFlag.Hidden | MenuFlag.Inactive);
    r.list.curvalue = 4;
    for (const [index, template] of TEMPLATES.entries()) {
      // Source intentionally omits texturebits and extensions from preset detection.
      if (template.colordepth === current.colordepth && template.driver === current.driver && template.mode === current.mode
        && template.fullscreen === current.fullscreen && template.tq === current.tq && template.lighting === current.lighting
        && template.geometry === current.geometry && template.filter === current.filter) { r.list.curvalue = index; break; }
    }
  }
  private apply(event: MenuEvent): void {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return;
    const r = this.record, cvars = this.state.services.cvars.registry;
    switch (r.texturebits.curvalue) { case 0: this.setValue("r_texturebits", 0); break; case 1: this.setValue("r_texturebits", 16); break; case 2: this.setValue("r_texturebits", 32); break; }
    this.setValue("r_picmip", f(3 - f(r.tq.curvalue))); this.setValue("r_allowExtensions", r.extensions.curvalue);
    this.setValue("r_mode", r.mode.curvalue); this.setValue("r_fullscreen", r.fs.curvalue);
    // CPU has no native GL driver. Preserve its dormant cvar; GL uses the source Linux name.
    if (this.uiConfiguration.backend === "gl") cvars.set("r_glDriver", defaultOpenGlDriver(), true);
    switch (r.colordepth.curvalue) {
      case 0: this.setValue("r_colorbits", 0); this.setValue("r_depthbits", 0); this.setValue("r_stencilbits", 0); break;
      case 1: this.setValue("r_colorbits", 16); this.setValue("r_depthbits", 16); this.setValue("r_stencilbits", 0); break;
      case 2: this.setValue("r_colorbits", 32); this.setValue("r_depthbits", 24); break;
    }
    this.setValue("r_vertexLight", r.lighting.curvalue);
    this.setValue("r_lodBias", r.geometry.curvalue === 2 ? 0 : 1);
    this.setValue("r_subdivisions", r.geometry.curvalue === 2 ? 4 : r.geometry.curvalue === 1 ? 12 : 20);
    cvars.set("r_textureMode", r.filter.curvalue !== 0 ? "GL_LINEAR_MIPMAP_LINEAR" : "GL_LINEAR_MIPMAP_NEAREST", true);
    this.state.services.consoleCommands.append("vid_restart\n");
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return;
    const r = this.record;
    switch (item.common.id) {
      case Id.Mode: break; // Legacy Voodoo mode restriction has no supported SDL backend.
      case Id.List: {
        const v = itemAt(TEMPLATES, r.list.curvalue);
        r.mode.curvalue = v.mode; r.tq.curvalue = v.tq; r.lighting.curvalue = v.lighting; r.colordepth.curvalue = v.colordepth;
        r.texturebits.curvalue = v.texturebits; r.geometry.curvalue = v.geometry; r.filter.curvalue = v.filter; r.fs.curvalue = v.fullscreen;
        break;
      }
      case Id.DriverInfo: await this.driverInfo.show(); this.state.assertActive(); break;
      case Id.Back: await popMenu(this.state); this.state.assertActive(); break;
      case Id.Graphics: break;
      case Id.Display: await popMenu(this.state); this.state.assertActive(); await this.navigation.display(); this.state.assertActive(); break;
      case Id.Sound: await popMenu(this.state); this.state.assertActive(); await this.navigation.sound(); this.state.assertActive(); break;
      case Id.Network: await popMenu(this.state); this.state.assertActive(); await this.navigation.network(); this.state.assertActive(); break;
    }
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME_LEFT, FRAME_RIGHT, BACK, BACK_FOCUS, ACCEPT, ACCEPT_FOCUS]) { await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive(); }
  }
  async cacheDriverInfo(): Promise<void> { await this.driverInfo.cache(); this.state.assertActive(); }
  private async initialize(): Promise<void> {
    this.state.assertActive(); const r = this.record; r.reset(); await this.cache(); this.state.assertActive();
    r.menu.wrapAround = true; r.menu.fullscreen = true;
    r.menu.draw = async () => { this.state.assertActive(); this.update(); await drawMenu(this.state, r.menu); this.state.assertActive(); };
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "SYSTEM SETUP"; r.banner.style = UI_CENTER;
    frame(r.frameLeft, true); frame(r.frameRight, false);
    for (const [item, id, text, y] of [
      [r.graphics, Id.Graphics, "GRAPHICS", 186], [r.display, Id.Display, "DISPLAY", 213], [r.sound, Id.Sound, "SOUND", 240], [r.network, Id.Network, "NETWORK", 267],
    ] satisfies readonly (readonly [MenuProportional, Id, string, number])[]) {
      item.common.flags = MenuFlag.RightJustify | (id === Id.Graphics ? 0 : MenuFlag.PulseIfFocus); item.common.id = id;
      item.common.callback = this.callback; item.common.x = 216; item.common.y = y; item.text = text; item.style = UI_RIGHT; item.color = COLORS.red;
    }
    for (const [item, name, y, names] of [
      [r.list, "Graphics Settings:", 132, ["High Quality", "Normal", "Fast", "Fastest", "Custom"]],
      [r.driver, "Renderer:", 168, [this.uiConfiguration.backend === "cpu" ? "CPU" : "System OpenGL"]],
      [r.extensions, "GL Extensions:", 186, ["Off", "On"]],
      [r.mode, "Video Mode:", 204, ["320x240", "400x300", "512x384", "640x480", "800x600", "960x720", "1024x768", "1152x864", "1280x1024", "1600x1200", "2048x1536", "856x480 wide screen"]],
      [r.colordepth, "Color Depth:", 222, ["Default", "16 bit", "32 bit"]], [r.fs, "Fullscreen:", 240, ["Off", "On"]],
      [r.lighting, "Lighting:", 258, ["Lightmap", "Vertex"]], [r.geometry, "Geometric Detail:", 276, ["Low", "Medium", "High"]],
      [r.texturebits, "Texture Quality:", 312, ["Default", "16 bit", "32 bit"]], [r.filter, "Texture Filter:", 330, ["Bilinear", "Trilinear"]],
    ] satisfies readonly (readonly [MenuSpin, string, number, readonly string[]])[]) {
      item.common.name = name; item.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
      item.common.x = 400; item.common.y = y; item.itemnames = names;
    }
    // Only CPU and system GL exist; do not offer the source's Voodoo driver.
    r.driver.common.flags |= MenuFlag.Grayed;
    r.list.common.callback = this.callback; r.list.common.id = Id.List; r.mode.common.callback = this.callback; r.mode.common.id = Id.Mode;
    r.tq.common.name = "Texture Detail:"; r.tq.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont; r.tq.common.x = 400; r.tq.common.y = 294;
    r.tq.minvalue = 0; r.tq.maxvalue = 3;
    r.tq.common.callback = async (_item, event) => { this.state.assertActive(); if (event === MenuEvent.Activated) r.tq.curvalue = f(nativeInt(f(r.tq.curvalue) + .5)); };
    r.driverinfo.common.flags = MenuFlag.CenterJustify | MenuFlag.PulseIfFocus; r.driverinfo.common.callback = this.callback;
    r.driverinfo.common.id = Id.DriverInfo; r.driverinfo.common.x = 320; r.driverinfo.common.y = 362;
    r.driverinfo.text = "Driver Info"; r.driverinfo.style = UI_CENTER | UI_SMALLFONT; r.driverinfo.color = COLORS.red;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus; r.back.common.callback = this.callback;
    r.back.common.id = Id.Back; r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    r.apply.common.name = ACCEPT; r.apply.common.flags = MenuFlag.RightJustify | MenuFlag.PulseIfFocus | MenuFlag.Hidden | MenuFlag.Inactive;
    r.apply.common.callback = async (_item, event) => { this.apply(event); }; r.apply.common.x = 640; r.apply.common.y = 416;
    r.apply.width = 128; r.apply.height = 64; r.apply.focuspic = ACCEPT_FOCUS;
    for (const item of [r.banner, r.frameLeft, r.frameRight, r.graphics, r.display, r.sound, r.network, r.list, r.driver, r.extensions,
      r.mode, r.colordepth, r.fs, r.lighting, r.geometry, r.tq, r.texturebits, r.filter, r.driverinfo, r.back, r.apply]) addItem(this.state, r.menu, item);
    r.mode.curvalue = nativeInt(this.variable("r_mode")); if (r.mode.curvalue < 0) r.mode.curvalue = 3;
    r.fs.curvalue = nativeInt(this.variable("r_fullscreen")); r.extensions.curvalue = nativeInt(this.variable("r_allowExtensions"));
    r.tq.curvalue = Math.min(3, Math.max(0, f(3 - this.variable("r_picmip")))); r.lighting.curvalue = this.variable("r_vertexLight") !== 0 ? 1 : 0;
    const texturebits = nativeInt(this.variable("r_texturebits")); r.texturebits.curvalue = texturebits === 16 ? 1 : texturebits === 32 ? 2 : 0;
    r.filter.curvalue = this.string("r_textureMode").toLowerCase() === "gl_linear_mipmap_nearest" ? 0 : 1;
    r.geometry.curvalue = this.variable("r_lodBias") > 0 ? this.variable("r_subdivisions") >= 20 ? 0 : 1 : 2;
    const colorbits = nativeInt(this.variable("r_colorbits")); r.colordepth.curvalue = colorbits === 16 ? 1 : colorbits === 32 ? 2 : 0;
    if (r.fs.curvalue === 0) r.colordepth.curvalue = 0;
    this.initial = { ...r.values(), tq: nativeInt(r.tq.curvalue) };
  }
  async show(): Promise<void> {
    await this.initialize(); this.state.assertActive(); await pushMenu(this.state, this.record.menu); this.state.assertActive();
    await setCursorToItem(this.state, this.record.menu, this.record.graphics); this.state.assertActive();
  }
}
