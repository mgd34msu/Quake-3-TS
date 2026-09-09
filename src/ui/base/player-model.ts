// Player model menu from id Software q3_ui/ui_playermodel.c. GPL-2.0-or-later.
import type { HunkArena } from "../../core/hunk.ts";
import { KeyCode } from "../../core/key-codes.ts";
import { vec3 } from "../../core/math.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { UI_CENTER } from "../../render/font.ts";
import { Weapon } from "../../shared/definitions.ts";
import { PlayerAnimation } from "../../shared/player-state.ts";
import { drawProportional } from "./draw.ts";
import { addItem, defaultKey, menuItemAtCursor, popMenu, pushMenu, setCursor, setCursorToItem } from "./framework.ts";
import { BasePlayerInfo, clearBasePlayerInfo } from "./players.ts";
import type { BaseUiPlayers } from "./players.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, menuSound } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuProportional, MenuSound } from "./state.ts";

const LOW_MEMORY = 5 * 1024 * 1024;
const ART = ["back_0", "back_1", "opponents_select", "opponents_selected", "frame1_l", "frame1_r",
  "player_models_ports", "gs_arrows_0", "gs_arrows_l", "gs_arrows_r"];
const imagePath = (name: string): string => `menu/art/${name}`;
function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function label(): MenuProportional {
  return { kind: "proportional", common: new MenuCommon(), text: "", style: 0, color: COLORS.white };
}
function clean(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "^" && index + 1 < text.length && text[index + 1] !== "^") { index++; continue; }
    const code = text.charCodeAt(index);
    if (code >= 32 && code <= 126) result += text.charAt(index);
  }
  return result;
}
function upper(text: string): string { return text.replace(/[a-z]/g, value => value.toUpperCase()); }
function lower(text: string): string { return text.replace(/[A-Z]/g, value => value.toLowerCase()); }
function strings(bytes: Uint8Array, count: number): string[] {
  const result: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    let value = "", byte = itemAt(bytes, offset++);
    while (byte !== 0) { value += String.fromCharCode(byte); byte = itemAt(bytes, offset++); }
    result.push(value);
  }
  return result;
}

export class BasePlayerModelMenu {
  readonly menu = new BaseMenu();
  private readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.white };
  private readonly frameLeft = bitmap();
  private readonly frameRight = bitmap();
  private readonly ports = bitmap();
  private readonly pics = Array.from({ length: 16 }, bitmap);
  private readonly buttons = Array.from({ length: 16 }, bitmap);
  private readonly player = bitmap();
  private readonly arrows = bitmap();
  private readonly left = bitmap();
  private readonly right = bitmap();
  private readonly back = bitmap();
  private readonly modelName = label();
  private readonly skinName = label();
  private readonly playerName = label();
  private readonly playerInfo = new BasePlayerInfo();
  private readonly modelNames: string[] = [];
  private modelPage = 0;
  private numPages = 0;
  private modelSkin = "";
  private selectedModel = 0;
  private modelLabel = "";
  private skinLabel = "";
  private playerLabel = "";

  constructor(readonly state: BaseUiState, readonly players: BaseUiPlayers, readonly hunk: HunkArena) {}

  private reset(): void {
    this.menu.items.length = 0; Object.assign(this.menu, new BaseMenu(), { items: this.menu.items });
    for (const item of [this.frameLeft, this.frameRight, this.ports, ...this.pics, ...this.buttons, this.player, this.arrows, this.left, this.right, this.back]) {
      Object.assign(item, bitmap(), { common: item.common }); Object.assign(item.common, new MenuCommon());
    }
    Object.assign(this.banner.common, new MenuCommon()); Object.assign(this.banner, { text: null, style: 0, color: COLORS.white });
    for (const item of [this.modelName, this.skinName, this.playerName]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.style = 0; item.color = COLORS.white;
    }
    clearBasePlayerInfo(this.playerInfo);
    this.modelNames.length = 0; this.modelPage = 0; this.numPages = 0; this.modelSkin = ""; this.selectedModel = 0;
  }
  private variable(name: string, size: number): string {
    this.state.assertActive();
    return sourceCommandText(this.state.services.cvars.registry.get(name)?.value ?? "").slice(0, size - 1);
  }
  private setupBitmap(item: MenuBitmap, name: string | null, x: number, y: number, width: number, height: number, flags: number): void {
    Object.assign(item.common, new MenuCommon(), { name: name === null ? null : imagePath(name), x, y, flags });
    Object.assign(item, { focuspic: null, errorpic: null, shader: null, focusshader: null, width, height, focuscolor: null });
  }
  private async buildList(): Promise<void> {
    this.modelPage = 0; this.modelNames.length = 0;
    const precache = qvmFloatToInt(this.state.services.cvars.registry.get("com_buildscript")?.numericValue ?? 0) !== 0;
    const dirs = new Uint8Array(2048), files = new Uint8Array(2048);
    const directories = strings(dirs, this.players.files.current.getFileList("models/players", "/", dirs));
    for (const directory of directories) {
      if (this.modelNames.length >= 256) break;
      const dir = directory.endsWith("/") ? directory.slice(0, -1) : directory;
      if (dir === "." || dir === "..") continue;
      const names = strings(files, this.players.files.current.getFileList(`models/players/${dir}`, "tga", files));
      for (const name of names) {
        if (this.modelNames.length >= 256) break;
        const dot = name.indexOf("."), skin = dot === -1 ? name : name.slice(0, dot);
        if (skin.length >= 64) throw new RangeError("Player model skin exceeds source COM_StripExtension storage");
        if (lower(skin.slice(0, 5)) === "icon_") {
          const path = `models/players/${dir}/${skin}`;
          if (path.length >= 128) this.state.services.print(`Com_sprintf: overflow of ${path.length} in 128\n`);
          this.modelNames.push(path.slice(0, 127));
        }
        if (precache) {
          await this.state.services.sounds.registerSound(`sound/player/announce/${skin}_wins.wav`, false);
          this.state.assertActive();
        }
      }
    }
    this.numPages = Math.ceil(this.modelNames.length / 16);
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const art of ART) { await this.state.services.resources.registerShaderNoMip(imagePath(art)); this.state.assertActive(); }
    await this.buildList(); this.state.assertActive();
    for (const name of this.modelNames) { await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive(); }
  }
  private updateGrid(): void {
    for (let index = 0; index < 16; index++) {
      const pic = itemAt(this.pics, index), button = itemAt(this.buttons, index), model = this.modelPage * 16 + index;
      if (model < this.modelNames.length) { pic.common.name = itemAt(this.modelNames, model); button.common.flags &= ~MenuFlag.Inactive; }
      else { pic.common.name = null; button.common.flags |= MenuFlag.Inactive; }
      pic.common.flags &= ~MenuFlag.Highlight; pic.shader = null; button.common.flags |= MenuFlag.PulseIfFocus;
    }
    if (Math.trunc(this.selectedModel / 16) === this.modelPage) {
      itemAt(this.pics, this.selectedModel % 16).common.flags |= MenuFlag.Highlight;
      itemAt(this.buttons, this.selectedModel % 16).common.flags &= ~MenuFlag.PulseIfFocus;
    }
    this.left.common.flags |= MenuFlag.Inactive; this.right.common.flags |= MenuFlag.Inactive;
    if (this.numPages > 1) {
      if (this.modelPage > 0) this.left.common.flags &= ~MenuFlag.Inactive;
      if (this.modelPage < this.numPages - 1) this.right.common.flags &= ~MenuFlag.Inactive;
    }
  }
  private async updateModel(): Promise<void> {
    await this.players.setModel(this.playerInfo, this.modelSkin); this.state.assertActive();
    await this.players.setInfo(this.playerInfo, { legsAnim: PlayerAnimation.LEGS_IDLE, torsoAnim: PlayerAnimation.TORSO_STAND,
      viewAngles: vec3(0, 150, 0), moveAngles: vec3(0, 0, 0), weaponNumber: Weapon.WP_MACHINEGUN, chat: false });
    this.state.assertActive();
  }
  private splitModel(index: number): { modelSkin: string; value: string; icon: number } | null {
    const value = itemAt(this.modelNames, index).slice("models/players/".length), icon = value.indexOf("icon_");
    if (icon === -1) return null;
    const modelSkin = value.slice(0, icon) + value.slice(icon + 5);
    if (modelSkin.length >= 64) throw new RangeError("Player model name exceeds source strcat storage");
    return { modelSkin, value, icon };
  }
  private setLabels(value: string, icon: number): void {
    if (icon === 0) throw new RangeError("Player model label Q_strncpyz: destsize < 1");
    this.modelLabel = upper(value.slice(0, Math.min(icon, 16) - 1)); this.modelName.text = this.modelLabel;
    this.skinLabel = upper(value.slice(icon + 5, icon + 20)); this.skinName.text = this.skinLabel;
  }
  private async pictureEvent(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    if (event !== MenuEvent.Activated) return;
    this.state.assertActive();
    for (let index = 0; index < 16; index++) {
      itemAt(this.pics, index).common.flags &= ~MenuFlag.Highlight;
      itemAt(this.buttons, index).common.flags |= MenuFlag.PulseIfFocus;
    }
    const index = item.common.id;
    itemAt(this.pics, index).common.flags |= MenuFlag.Highlight;
    itemAt(this.buttons, index).common.flags &= ~MenuFlag.PulseIfFocus;
    const model = this.modelPage * 16 + index, parts = this.splitModel(model);
    if (parts !== null) {
      this.modelSkin = parts.modelSkin; this.setLabels(parts.value, parts.icon); this.selectedModel = model;
      if (this.hunk.memoryRemaining() > LOW_MEMORY) { await this.updateModel(); this.state.assertActive(); }
    }
  }
  private saveChanges(): void {
    this.state.assertActive();
    for (const name of ["model", "headmodel", "team_model", "team_headmodel"]) this.state.services.cvars.registry.set(name, this.modelSkin, true);
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    if (event !== MenuEvent.Activated) return;
    this.state.assertActive();
    if (item.common.id === 100 && this.modelPage > 0) { this.modelPage--; this.updateGrid(); }
    if (item.common.id === 101 && this.modelPage < this.numPages - 1) { this.modelPage++; this.updateGrid(); }
    if (item.common.id === 102) { this.saveChanges(); await popMenu(this.state); this.state.assertActive(); }
  }
  private async key(key: number): Promise<MenuSound> {
    this.state.assertActive();
    const left = key === KeyCode.Left || key === KeyCode.KeypadLeft;
    if (left || key === KeyCode.Right || key === KeyCode.KeypadRight) {
      const item = menuItemAtCursor(this.menu);
      if (item === null) throw new RangeError("PlayerModel_MenuKey dereferenced an absent cursor item");
      const pic = item.common.id;
      if (pic >= 0 && pic <= 15) {
        if (left ? pic > 0 : pic < 15 && this.modelPage * 16 + pic + 1 < this.modelNames.length) {
          await setCursor(this.state, this.menu, this.menu.cursor + (left ? -1 : 1)); this.state.assertActive();
          return menuSound(this.state.media.move);
        }
        if (left ? this.modelPage > 0 : pic === 15 && this.modelPage < this.numPages - 1) {
          this.modelPage += left ? -1 : 1;
          await setCursor(this.state, this.menu, this.menu.cursor + (left ? 15 : -15)); this.state.assertActive();
          this.updateGrid(); return menuSound(this.state.media.move);
        }
        return menuSound(this.state.media.buzz);
      }
    }
    if (key === KeyCode.Escape || key === KeyCode.Mouse2) this.saveChanges();
    const sound = await defaultKey(this.state, this.menu, key); this.state.assertActive(); return sound;
  }
  async show(): Promise<void> {
    this.state.assertActive();
    this.reset();
    await this.cache(); this.state.assertActive();
    this.menu.key = key => this.key(key); this.menu.wrapAround = true; this.menu.fullscreen = true;
    Object.assign(this.banner.common, new MenuCommon(), { x: 320, y: 16 });
    Object.assign(this.banner, { text: "PLAYER MODEL", style: UI_CENTER, color: COLORS.white });
    const inactive = MenuFlag.LeftJustify | MenuFlag.Inactive, button = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
    this.setupBitmap(this.frameLeft, "frame1_l", 0, 78, 256, 329, inactive);
    this.setupBitmap(this.frameRight, "frame1_r", 376, 76, 256, 334, inactive);
    this.setupBitmap(this.ports, "player_models_ports", 50, 59, 274, 274, inactive);
    for (let index = 0; index < 16; index++) {
      const pic = itemAt(this.pics, index), hit = itemAt(this.buttons, index), x = 50 + index % 4 * 70, y = 59 + Math.trunc(index / 4) * 70;
      this.setupBitmap(pic, null, x, y, 64, 64, inactive); pic.focuspic = imagePath("opponents_selected"); pic.focuscolor = COLORS.red;
      this.setupBitmap(hit, null, x - 16, y - 16, 128, 128, button | MenuFlag.NoDefaultInit);
      Object.assign(hit.common, { id: index, left: x, top: y, right: x + 64, bottom: y + 64, callback: (item: BaseMenuItem, event: MenuEvent) => this.pictureEvent(item, event) });
      hit.focuspic = imagePath("opponents_select"); hit.focuscolor = COLORS.red;
    }
    for (const [item, x, y] of [[this.playerName, 320, 440], [this.modelName, 497, 54], [this.skinName, 497, 394]] satisfies [MenuProportional, number, number][]) {
      Object.assign(item.common, new MenuCommon(), { x, y, flags: MenuFlag.CenterJustify | MenuFlag.Inactive });
      // The source's static backing strings survive the surrounding record memset.
      item.style = UI_CENTER; item.color = COLORS.normal;
    }
    this.playerName.text = this.playerLabel; this.modelName.text = this.modelLabel; this.skinName.text = this.skinLabel;
    this.setupBitmap(this.player, null, 400, -40, 320, 560, MenuFlag.Inactive);
    this.player.common.ownerdraw = async () => {
      this.state.assertActive();
      if (this.hunk.memoryRemaining() <= LOW_MEMORY) { drawProportional(this.state, 400, 240, "LOW MEMORY", 0, COLORS.red); return; }
      await this.players.drawPlayer({ x: 400, y: -40, width: 320, height: 560 }, this.playerInfo, Math.trunc(this.state.realtime / 2)); this.state.assertActive();
    };
    this.setupBitmap(this.arrows, "gs_arrows_0", 125, 340, 128, 32, MenuFlag.Inactive);
    this.setupBitmap(this.left, null, 125, 340, 64, 32, button); this.left.focuspic = imagePath("gs_arrows_l"); this.left.common.id = 100;
    this.setupBitmap(this.right, null, 186, 340, 64, 32, button); this.right.focuspic = imagePath("gs_arrows_r"); this.right.common.id = 101;
    this.setupBitmap(this.back, "back_0", 0, 416, 128, 64, button); this.back.focuspic = imagePath("back_1"); this.back.common.id = 102;
    for (const item of [this.left, this.right, this.back]) item.common.callback = (item, event) => this.event(item, event);
    for (const item of [this.banner, this.frameLeft, this.frameRight, this.ports, this.playerName, this.modelName, this.skinName]) addItem(this.state, this.menu, item);
    for (let index = 0; index < 16; index++) { addItem(this.state, this.menu, itemAt(this.pics, index)); addItem(this.state, this.menu, itemAt(this.buttons, index)); }
    for (const item of [this.player, this.arrows, this.left, this.right, this.back]) addItem(this.state, this.menu, item);
    this.playerLabel = clean(this.variable("name", 16)); this.playerName.text = this.playerLabel; this.modelSkin = this.variable("model", 64);
    for (let index = 0; index < this.modelNames.length; index++) {
      const parts = this.splitModel(index);
      if (parts !== null && lower(parts.modelSkin) === lower(this.modelSkin)) {
        this.selectedModel = index; this.modelPage = Math.trunc(index / 16); this.setLabels(parts.value, parts.icon); break;
      }
    }
    this.updateGrid(); await this.updateModel(); this.state.assertActive();
    await pushMenu(this.state, this.menu); this.state.assertActive();
    await setCursorToItem(this.state, this.menu, itemAt(this.pics, this.selectedModel % 16)); this.state.assertActive();
  }
}
