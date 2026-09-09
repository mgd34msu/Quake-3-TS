// Player settings menu from id Software q3_ui/ui_playersettings.c. GPL-2.0-or-later.
import { KeyCode } from "../../core/key-codes.ts";
import { vec3 } from "../../core/math.ts";
import type { Vec4 } from "../../core/math.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { UI_BLINK, UI_CENTER, UI_PULSE, UI_SMALLFONT } from "../../render/font.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import { Weapon } from "../../shared/definitions.ts";
import { PlayerAnimation } from "../../shared/player-state.ts";
import { clampCvar, drawChar, drawHandle, drawProportional } from "./draw.ts";
import { MenuField } from "./field.ts";
import { addItem, defaultKey, popMenu, pushMenu } from "./framework.ts";
import type { BasePlayerModelMenu } from "./player-model.ts";
import { BasePlayerInfo, clearBasePlayerInfo } from "./players.ts";
import type { BaseUiPlayers } from "./players.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, menuParent } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuFieldItem, MenuSpin } from "./state.ts";

const GAME_TO_UI = [4, 2, 3, 0, 5, 1, 6];
const UI_TO_GAME = [4, 6, 2, 3, 1, 5, 7];
const HANDICAPS = ["None", "95", "90", "85", "80", "75", "70", "65", "60", "55", "50", "45", "40", "35", "30", "25", "20", "15", "10", "5"];
const FX = ["fx_red", "fx_yel", "fx_grn", "fx_teal", "fx_blue", "fx_cyan", "fx_white"];
const NAME_COLORS: readonly Vec4[] = [COLORS.black, COLORS.red, { x: 0, y: 1, z: 0, w: 1 }, COLORS.highlight,
  { x: 0, y: 0, z: 1, w: 1 }, { x: 0, y: 1, z: 1, w: 1 }, { x: 1, y: 0, z: 1, w: 1 }, COLORS.white];
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function spin(): MenuSpin {
  return { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0, top: 0,
    itemnames: [], width: 0, height: 0, columns: 0, separation: 0 };
}
function colorAt(text: string, index: number): boolean {
  return text.charAt(index) === "^" && index + 1 < text.length && text.charAt(index + 1) !== "^";
}
function clean(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    if (colorAt(text, index)) { index++; continue; }
    if (text.charCodeAt(index) >= 32 && text.charCodeAt(index) <= 126) result += text.charAt(index);
  }
  return result;
}

export class BasePlayerSettingsMenu {
  readonly menu = new BaseMenu();
  private readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
  private readonly frameLeft = bitmap();
  private readonly frameRight = bitmap();
  private readonly player = bitmap();
  private readonly name: MenuFieldItem = { kind: "field", common: new MenuCommon(), field: new MenuField() };
  private readonly handicap = spin();
  private readonly effects = spin();
  private readonly back = bitmap();
  private readonly model = bitmap();
  private readonly itemNull = bitmap();
  private fxBase: SceneShader | null = null;
  private readonly fxPics: Array<SceneShader | null> = Array.from({ length: 7 }, () => null);
  private readonly playerInfo = new BasePlayerInfo();
  private playerModel = "";

  constructor(readonly state: BaseUiState, readonly players: BaseUiPlayers, readonly modelMenu: BasePlayerModelMenu) {}

  private reset(): void {
    this.menu.items.length = 0; Object.assign(this.menu, new BaseMenu(), { items: this.menu.items });
    for (const item of [this.frameLeft, this.frameRight, this.player, this.back, this.model, this.itemNull]) {
      Object.assign(item, bitmap(), { common: item.common }); Object.assign(item.common, new MenuCommon());
    }
    Object.assign(this.banner.common, new MenuCommon()); Object.assign(this.banner, { text: null, style: 0, color: COLORS.white });
    Object.assign(this.name.common, new MenuCommon()); this.name.field.reset();
    for (const item of [this.handicap, this.effects]) {
      Object.assign(item, spin(), { common: item.common }); Object.assign(item.common, new MenuCommon());
    }
    clearBasePlayerInfo(this.playerInfo);
    this.playerModel = ""; this.fxBase = null; this.fxPics.fill(null);
  }
  private variable(name: string, size: number): string {
    this.state.assertActive();
    return sourceCommandText(this.state.services.cvars.registry.get(name)?.value ?? "").slice(0, size - 1);
  }
  private value(name: string): number { this.state.assertActive(); return this.state.services.cvars.registry.get(name)?.numericValue ?? 0; }
  private style(item: BaseMenuItem): { style: number; color: Vec4; focus: boolean } {
    const focus = menuParent(item).cursor === item.common.menuPosition;
    return { focus, style: UI_SMALLFONT | (focus ? UI_PULSE : 0), color: focus ? COLORS.highlight : COLORS.normal };
  }
  private drawName(): void {
    const item = this.name, { style, color, focus } = this.style(item), x = item.common.x, y = item.common.y;
    drawProportional(this.state, x, y, "Name", style, color);
    let drawX = x + 64, nameColor: Vec4 = COLORS.white;
    const text = item.field.text;
    for (let index = 0; index < text.length; index++) {
      if (!focus && colorAt(text, index)) {
        const code = (text.charCodeAt(index + 1) - 48) & 7;
        nameColor = itemAt(NAME_COLORS, code === 0 ? 7 : code); index++; continue;
      }
      drawChar(this.state, drawX, y + 27, text.charCodeAt(index), style, nameColor); drawX += 8;
    }
    if (focus) drawChar(this.state, x + 64 + item.field.cursor * 8, y + 27,
      this.state.services.keys.getOverstrike() ? 11 : 10, (style & ~UI_PULSE) | UI_BLINK, COLORS.white);
    drawProportional(this.state, 320, 440, clean(text.slice(0, 31)), UI_CENTER, COLORS.normal);
  }
  private drawHandicap(): void {
    const item = this.handicap, { style, color } = this.style(item);
    drawProportional(this.state, item.common.x, item.common.y, "Handicap", style, color);
    drawProportional(this.state, item.common.x + 64, item.common.y + 27, itemAt(HANDICAPS, item.curvalue), style, color);
  }
  private drawEffects(): void {
    const item = this.effects, { style, color } = this.style(item);
    drawProportional(this.state, item.common.x, item.common.y, "Effects", style, color);
    drawHandle(this.state, item.common.x + 64, item.common.y + 35, 128, 8, this.fxBase);
    drawHandle(this.state, item.common.x + 72 + item.curvalue * 16, item.common.y + 33, 16, 12, itemAt(this.fxPics, item.curvalue));
  }
  private async setInfo(): Promise<void> {
    await this.players.setInfo(this.playerInfo, { legsAnim: PlayerAnimation.LEGS_IDLE, torsoAnim: PlayerAnimation.TORSO_STAND,
      viewAngles: vec3(0, 150, 0), moveAngles: vec3(0, 0, 0), weaponNumber: Weapon.WP_MACHINEGUN, chat: false });
    this.state.assertActive();
  }
  private async drawPlayer(): Promise<void> {
    const model = this.variable("model", 64);
    if (model !== this.playerModel) {
      await this.players.setModel(this.playerInfo, model); this.state.assertActive();
      this.playerModel = model;
      await this.setInfo(); this.state.assertActive();
    }
    await this.players.drawPlayer({ x: 400, y: -40, width: 320, height: 560 }, this.playerInfo, Math.trunc(this.state.realtime / 2));
    this.state.assertActive();
  }
  private saveChanges(): void {
    this.state.assertActive();
    const cvars = this.state.services.cvars.registry;
    cvars.set("name", this.name.field.text, true);
    cvars.setValue("handicap", 100 - this.handicap.curvalue * 5);
    cvars.setValue("color1", itemAt(UI_TO_GAME, this.effects.curvalue));
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    if (event !== MenuEvent.Activated) return;
    this.state.assertActive();
    switch (item.common.id) {
      case 11: this.state.services.cvars.registry.set("handicap", String(100 - 25 * this.handicap.curvalue), true); break;
      case 14: this.saveChanges(); await this.modelMenu.show(); this.state.assertActive(); break;
      case 13: this.saveChanges(); await popMenu(this.state); this.state.assertActive(); break;
    }
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of ["frame2_l", "frame1_r", "model_0", "model_1", "back_0", "back_1"]) {
      await this.state.services.resources.registerShaderNoMip(`menu/art/${name}`); this.state.assertActive();
    }
    const base = await this.state.services.resources.registerShaderNoMip("menu/art/fx_base"); this.state.assertActive(); this.fxBase = base;
    for (let index = 0; index < FX.length; index++) {
      const shader = await this.state.services.resources.registerShaderNoMip(`menu/art/${itemAt(FX, index)}`); this.state.assertActive(); this.fxPics[index] = shader;
    }
  }
  private setupBitmap(item: MenuBitmap, name: string | null, x: number, y: number, width: number, height: number, flags: number): void {
    Object.assign(item.common, new MenuCommon(), { name: name === null ? null : `menu/art/${name}`, x, y, flags });
    Object.assign(item, { focuspic: null, errorpic: null, shader: null, focusshader: null, width, height, focuscolor: null });
  }
  async show(): Promise<void> {
    this.state.assertActive();
    this.reset();
    await this.cache(); this.state.assertActive();
    this.menu.key = async key => {
      this.state.assertActive();
      if (key === KeyCode.Escape || key === KeyCode.Mouse2) this.saveChanges();
      const sound = await defaultKey(this.state, this.menu, key); this.state.assertActive(); return sound;
    };
    this.menu.wrapAround = true; this.menu.fullscreen = true;
    Object.assign(this.banner.common, new MenuCommon(), { x: 320, y: 16 });
    Object.assign(this.banner, { text: "PLAYER SETTINGS", style: UI_CENTER, color: COLORS.white });
    const inactive = MenuFlag.LeftJustify | MenuFlag.Inactive;
    this.setupBitmap(this.frameLeft, "frame2_l", 0, 78, 256, 329, inactive);
    this.setupBitmap(this.frameRight, "frame1_r", 376, 76, 256, 334, inactive);
    for (const [item, y] of [[this.name, 144], [this.handicap, 225], [this.effects, 306]] satisfies [BaseMenuItem, number][]) {
      Object.assign(item.common, new MenuCommon(), { x: 192, y, flags: MenuFlag.NoDefaultInit, left: 184, top: y - 8, right: 392, bottom: y + 54 });
    }
    this.name.common.ownerdraw = async () => { this.drawName(); }; this.name.field.widthInChars = 20; this.name.field.maxchars = 20;
    this.handicap.common.id = 11; this.handicap.numitems = 20; this.handicap.common.ownerdraw = async () => { this.drawHandicap(); };
    this.effects.common.id = 12; this.effects.numitems = 7; this.effects.common.ownerdraw = async () => { this.drawEffects(); };
    this.setupBitmap(this.model, "model_0", 640, 416, 128, 64, MenuFlag.RightJustify | MenuFlag.PulseIfFocus);
    this.model.focuspic = "menu/art/model_1"; this.model.common.id = 14;
    this.setupBitmap(this.back, "back_0", 0, 416, 128, 64, MenuFlag.LeftJustify | MenuFlag.PulseIfFocus);
    this.back.focuspic = "menu/art/back_1"; this.back.common.id = 13;
    for (const item of [this.model, this.back]) item.common.callback = (item, event) => this.event(item, event);
    this.setupBitmap(this.player, null, 400, -40, 320, 560, MenuFlag.Inactive); this.player.common.ownerdraw = () => this.drawPlayer();
    this.setupBitmap(this.itemNull, null, 0, 0, 640, 480, MenuFlag.LeftJustify | MenuFlag.MouseOnly | MenuFlag.Silent);
    for (const item of [this.banner, this.frameLeft, this.frameRight, this.name, this.handicap, this.effects, this.model, this.back, this.player, this.itemNull]) addItem(this.state, this.menu, item);
    this.name.field.setText(this.variable("name", 256));
    let color = qvmFloatToInt(Math.fround(this.value("color1") - 1));
    if (color < 0 || color > 6) color = 6;
    this.effects.curvalue = itemAt(GAME_TO_UI, color);
    await this.players.setModel(this.playerInfo, this.variable("model", 1024)); this.state.assertActive();
    await this.setInfo(); this.state.assertActive();
    const handicap = qvmFloatToInt(clampCvar(5, 100, this.value("handicap")));
    this.handicap.curvalue = 20 - Math.trunc(handicap / 5);
    await pushMenu(this.state, this.menu); this.state.assertActive();
  }
}
