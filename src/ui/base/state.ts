// Base UI state and menu records from id Software q3_ui/ui_local.h. GPL-2.0-or-later.
import type { PcmSound } from "../../assets/wav.ts";
import { CommonParseState } from "../../core/common-parse.ts";
import { GameRandom } from "../../game/numeric.ts";
import type { AudioMixer } from "../../audio/mixer.ts";
import type { ClientSoundBank } from "../../cgame/sound-bank.ts";
import type { FieldClipboard } from "../../core/edit-field.ts";
import type { Vec4 } from "../../core/math.ts";
import type { ClientKeys, ClientKeyPhase } from "../../engine/client-keys.ts";
import type { RenderCommandBuffer } from "../../render/commands.ts";
import type { Draw2D } from "../../render/draw2d.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { RendererResources } from "../../render/world.ts";
import type { BaseUiCvars } from "./cvars.ts";
import type { CommandBuffer } from "../../core/commands.ts";
import type { MenuField } from "./field.ts";
export enum MenuFlag {
  Blink = 0x1,
  SmallFont = 0x2,
  LeftJustify = 0x4,
  CenterJustify = 0x8,
  RightJustify = 0x10,
  NumbersOnly = 0x20,
  Highlight = 0x40,
  HighlightIfFocus = 0x80,
  PulseIfFocus = 0x100,
  HasMouseFocus = 0x200,
  NoOnOffText = 0x400,
  MouseOnly = 0x800,
  Hidden = 0x1000,
  Grayed = 0x2000,
  Inactive = 0x4000,
  NoDefaultInit = 0x8000,
  OwnerDraw = 0x10000,
  Pulse = 0x20000,
  Lowercase = 0x40000,
  Uppercase = 0x80000,
  Silent = 0x100000
}
export enum MenuEvent {
  GotFocus = 1,
  LostFocus = 2,
  Activated = 3
}
export type MenuSound = {
  readonly kind: "none";
} | {
  readonly kind: "consumed";
} | {
  readonly kind: "sound";
  readonly sound: PcmSound;
};
export const NO_SOUND: MenuSound = { kind: "none" };
export const CONSUMED: MenuSound = { kind: "consumed" };
export function menuSound(sound: PcmSound | null): MenuSound { return sound === null ? NO_SOUND : { kind: "sound", sound }; }
export type MenuCallback = (item: BaseMenuItem, event: MenuEvent) => Promise<void>;
export type MenuItemDraw = (item: BaseMenuItem) => Promise<void>;
export class MenuCommon {
  name: string | null = null;
  id = 0;
  x = 0;
  y = 0;
  left = 0;
  top = 0;
  right = 0;
  bottom = 0;
  parent: BaseMenu | null = null;
  menuPosition = 0;
  flags = 0;
  callback: MenuCallback | null = null;
  statusbar: MenuItemDraw | null = null;
  ownerdraw: MenuItemDraw | null = null;
}
export interface MenuSlider {
  readonly kind: "slider";
  readonly common: MenuCommon;
  minvalue: number;
  maxvalue: number;
  curvalue: number;
  range: number;
}
export interface MenuAction {
  readonly kind: "action";
  readonly common: MenuCommon;
}
export interface MenuListData {
  readonly common: MenuCommon;
  oldvalue: number;
  curvalue: number;
  numitems: number;
  top: number;
  itemnames: readonly string[];
  width: number;
  height: number;
  columns: number;
  separation: number;
}
export interface MenuSpin extends MenuListData {
  readonly kind: "spin";
}
export interface MenuScroll extends MenuListData {
  readonly kind: "scroll";
}
export interface MenuFieldItem {
  readonly kind: "field";
  readonly common: MenuCommon;
  readonly field: MenuField;
}
export interface MenuRadio {
  readonly kind: "radio";
  readonly common: MenuCommon;
  curvalue: number;
}
export interface MenuBitmap {
  readonly kind: "bitmap";
  readonly common: MenuCommon;
  focuspic: string | null;
  errorpic: string | null;
  shader: SceneShader | null;
  focusshader: SceneShader | null;
  width: number;
  height: number;
  focuscolor: Vec4 | null;
}
export interface MenuTextData {
  readonly common: MenuCommon;
  text: string | null;
  style: number;
  color: Vec4;
}
export interface MenuText extends MenuTextData {
  readonly kind: "text";
}
export interface MenuProportional extends MenuTextData {
  readonly kind: "proportional";
}
export interface MenuBanner extends MenuTextData {
  readonly kind: "banner";
}
export type BaseMenuItem = MenuSlider | MenuAction | MenuSpin | MenuScroll | MenuFieldItem | MenuRadio | MenuBitmap | MenuText | MenuProportional | MenuBanner;
export class BaseMenu {
  cursor = 0;
  cursorPrev = 0;
  itemCount = 0;
  readonly items: BaseMenuItem[] = [];
  draw: (() => Promise<void>) | null = null;
  key: ((key: number) => Promise<MenuSound>) | null = null;
  wrapAround = false;
  fullscreen = false;
  showlogo = false;
}
export class BaseUiMedia {
  charset: SceneShader | null = null;
  proportional: SceneShader | null = null;
  glow: SceneShader | null = null;
  banner: SceneShader | null = null;
  cursor: SceneShader | null = null;
  radioOn: SceneShader | null = null;
  radioOff: SceneShader | null = null;
  white: SceneShader | null = null;
  background: SceneShader | null = null;
  backgroundNoLogo: SceneShader | null = null;
  slider: SceneShader | null = null;
  sliderButton: SceneShader | null = null;
  sliderFocus: SceneShader | null = null;
  enter: PcmSound | null = null;
  move: PcmSound | null = null;
  out: PcmSound | null = null;
  buzz: PcmSound | null = null;
  weaponChange: PcmSound | null = null;
  nullSound: MenuSound = NO_SOUND;
}
export interface BaseUiServices {
  readonly cvars: BaseUiCvars;
  readonly keys: Pick<ClientKeys, "getCatcher" | "setCatcher" | "clearStates" | "isDown" | "getOverstrike" | "setOverstrike" | "getBinding" | "setBinding">;
  readonly clipboard: FieldClipboard;
  readonly resources: RendererResources;
  readonly commands: RenderCommandBuffer;
  readonly consoleCommands: Pick<CommandBuffer, "append">;
  readonly sounds: ClientSoundBank;
  readonly audio: Pick<AudioMixer, "startLocalSound">;
  readonly hardware: "generic" | "ragepro";
  readClientPhase(): ClientKeyPhase;
  print(text: string): undefined;
  assertCurrentOperation(): undefined;
}
export class BaseUiState {
  readonly sourceParser = new CommonParseState();
  readonly random = new GameRandom();
  readonly media = new BaseUiMedia();
  readonly stack: BaseMenu[] = [];
  activeMenu: BaseMenu | null = null;
  menuDepth = 0;
  cursorX = 0;
  cursorY = 0;
  realtime = 0;
  frameTime = 0;
  firstDraw = false;
  enterSound = false;
  demoVersion = false;
  debug = false;
  pulseColor: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
  readonly draw: Draw2D;
  private retired = false;
  constructor(readonly services: BaseUiServices) {
    if (services.commands.target.images !== services.resources.images || services.commands.tess !== services.resources.tess
      || services.commands.runtime !== services.resources.settings.runtime)
      throw new Error("Base UI requires the engine's actual renderer queue and resources");
    this.draw = services.commands.draw2D("base-ui-640");
  }
  assertActive(): void {
    this.services.assertCurrentOperation();
    if (this.retired)
      throw new Error("Base UI instance has retired");
  }
  retire(): void {
    if (this.retired) throw new Error("Base UI instance has retired");
    this.retired = true;
  }
  play(sound: PcmSound | null): void {
    this.assertActive();
    const resolved = this.services.sounds.resolveForPlayback(sound);
    if (resolved !== null)
      this.services.audio.startLocalSound(resolved, 6);
  }
}
export function itemAt<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new RangeError(`Undefined native base UI array index ${index}`);
  return value;
}
export function nativeInt(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648)
    throw new RangeError("Undefined native base UI integer conversion");
  return Math.trunc(value) || 0;
}
export function menuParent(item: BaseMenuItem): BaseMenu {
  if (item.common.parent === null)
    throw new Error("Base menu item has no source parent");
  return item.common.parent;
}
export const COLORS = {
  black: { x: 0, y: 0, z: 0, w: 1 }, white: { x: 1, y: 1, z: 1, w: 1 }, red: { x: 1, y: 0, z: 0, w: 1 },
  menuText: { x: 1, y: 1, z: 1, w: 1 }, disabled: { x: .5, y: .5, z: .5, w: 1 },
  highlight: { x: 1, y: 1, z: 0, w: 1 }, normal: { x: 1, y: Math.fround(.43), z: 0, w: 1 },
  listbar: { x: 1, y: Math.fround(.43), z: 0, w: Math.fround(.30) },
} satisfies Record<string, Vec4>;
