// Base UI drawing from id Software q3_ui/ui_atoms.c and ui_qmenu.c. GPL-2.0-or-later.
import type { Vec4 } from "../../core/math.ts";
import { sourceCommandText } from "../../core/text.ts";
import { drawUiString, drawProportionalString, drawBannerString, proportionalStringWidth, UI_SMALLFONT } from "../../render/font.ts";
import type { LegacyFonts } from "../../render/font.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import { COLORS, CONSUMED, itemAt, nativeInt } from "./state.ts";
import type { BaseUiState } from "./state.ts";
const f = Math.fround;
export function clampCvar(min: number, max: number, value: number): number {
  min = f(min);
  max = f(max);
  value = f(value);
  return value < min ? min : value > max ? max : value;
}
export function lerpColor(a: Vec4, b: Vec4, fraction: number): Vec4 {
  const t = f(fraction), channel = (a: number, b: number) => clampCvar(0, 1, f(f(a) + f(t * f(f(b) - f(a)))));
  return { x: channel(a.x, b.x), y: channel(a.y, b.y), z: channel(a.z, b.z), w: channel(a.w, b.w) };
}
export function proportionalScale(style: number): number { return (style & UI_SMALLFONT) !== 0 ? .75 : 1; }
export function stringWidth(text: string | null): number {
  if (text === null)
    throw new Error("Undefined native proportional string pointer");
  return proportionalStringWidth(text);
}
function fonts(state: BaseUiState): LegacyFonts {
  const resources = state.services.resources, media = state.media;
  return { charset: resources.picture(media.charset), proportional: resources.picture(media.proportional), glow: resources.picture(media.glow), banner: resources.picture(media.banner) };
}
export function drawString(state: BaseUiState, x: number, y: number, text: string | null, style: number, color: Vec4): void {
  if (text === null)
    return;
  state.assertActive();
  drawUiString(state.draw, state.services.resources.picture(state.media.charset), { x, y, text, style, color, time: state.realtime });
}
export function drawChar(state: BaseUiState, x: number, y: number, character: number, style: number, color: Vec4): void {
  drawString(state, x, y, String.fromCharCode(nativeInt(character) & 255), style, color);
}
export function drawProportional(state: BaseUiState, x: number, y: number, text: string | null, style: number, color: Vec4): void {
  state.assertActive();
  if (text === null)
    throw new Error("Undefined native proportional string pointer");
  drawProportionalString(state.draw, fonts(state), { x, y, text, style, color, time: state.realtime });
}
export function drawBanner(state: BaseUiState, x: number, y: number, text: string | null, style: number, color: Vec4): void {
  state.assertActive();
  if (text === null)
    throw new Error("Undefined native banner string pointer");
  drawBannerString(state.draw, fonts(state), { x, y, text, style, color, time: state.realtime });
}
export function autoWrapped(state: BaseUiState, x: number, y: number, maxWidth: number, yStep: number, text: string | null, style: number, color: Vec4): void {
  if (text === null || text.length === 0 || text.charCodeAt(0) === 0)
    return;
  state.assertActive();
  const bytes = new Uint8Array(1024), input = sourceCommandText(text).slice(0, 1023);
  for (let i = 0; i < input.length; i++)
    bytes[i] = input.charCodeAt(i);
  const read = (at: number) => itemAt(bytes, at);
  const substring = (start: number): string => {
    let result = "";
    for (let i = start; read(i) !== 0; i++)
      result += String.fromCharCode(read(i));
    return result;
  };
  let first = 0, last = 0, next = 0;
  while (true) {
    do {
      next++;
    } while (read(next) !== 32 && read(next) !== 0);
    const saved = read(next);
    bytes[next] = 0;
    const width = nativeInt(f(stringWidth(substring(first)) * proportionalScale(style)));
    bytes[next] = saved;
    if (width > maxWidth) {
      if (first === last)
        last = next;
      bytes[last] = 0;
      drawProportional(state, x, y, substring(first), style, color);
      y += yStep;
      if (saved === 0) {
        last++;
        if (read(last) !== 0)
          drawProportional(state, x, y, substring(last), style, color);
        break;
      }
      last++;
      first = last;
      next = last;
    }
    else {
      last = next;
      if (saved === 0) {
        drawProportional(state, x, y, substring(first), style, color);
        break;
      }
    }
  }
}
export function drawHandle(state: BaseUiState, x: number, y: number, width: number, height: number, shader: SceneShader | null): void {
  state.assertActive();
  state.draw.drawHandlePic({ x, y, width, height }, state.services.resources.picture(shader));
}
export async function drawNamed(state: BaseUiState, x: number, y: number, width: number, height: number, name: string): Promise<void> {
  state.assertActive();
  const shader = await state.services.resources.registerShaderNoMip(name);
  state.assertActive();
  state.draw.drawPic({ x, y, width, height }, state.services.resources.picture(shader));
}
export function fillRect(state: BaseUiState, x: number, y: number, width: number, height: number, color: Vec4): void {
  state.assertActive();
  state.draw.fillRect({ x, y, width, height }, color, state.services.resources.picture(state.media.white));
}
export function drawRect(state: BaseUiState, x: number, y: number, width: number, height: number, color: Vec4): void {
  state.assertActive();
  state.draw.drawUiRect({ x, y, width, height }, color, state.services.resources.picture(state.media.white));
}
export function drawTextBox(state: BaseUiState, x: number, y: number, width: number, lines: number): void {
  fillRect(state, x + 8, y + 8, (width + 1) * 16, (lines + 1) * 16, COLORS.black);
  drawRect(state, x + 8, y + 8, (width + 1) * 16, (lines + 1) * 16, COLORS.white);
}
export function cursorInRect(state: BaseUiState, x: number, y: number, width: number, height: number): boolean {
  return !(state.cursorX < x || state.cursorY < y || state.cursorX > x + width || state.cursorY > y + height);
}
export async function cacheMenu(state: BaseUiState): Promise<void> {
  state.assertActive();
  const media = state.media, resources = state.services.resources, sounds = state.services.sounds;
  const charset = await resources.registerShaderNoMip("gfx/2d/bigchars");
  state.assertActive();
  media.charset = charset;
  const proportional = await resources.registerShaderNoMip("menu/art/font1_prop.tga");
  state.assertActive();
  media.proportional = proportional;
  const glow = await resources.registerShaderNoMip("menu/art/font1_prop_glo.tga");
  state.assertActive();
  media.glow = glow;
  const banner = await resources.registerShaderNoMip("menu/art/font2_prop.tga");
  state.assertActive();
  media.banner = banner;
  const cursor = await resources.registerShaderNoMip("menu/art/3_cursor2");
  state.assertActive();
  media.cursor = cursor;
  const radioOn = await resources.registerShaderNoMip("menu/art/switch_on");
  state.assertActive();
  media.radioOn = radioOn;
  const radioOff = await resources.registerShaderNoMip("menu/art/switch_off");
  state.assertActive();
  media.radioOff = radioOff;
  const white = await resources.registerShaderNoMip("white");
  state.assertActive();
  media.white = white;
  const background = await resources.registerShaderNoMip(state.services.hardware === "ragepro" ? "menubackRagePro" : "menuback");
  state.assertActive();
  media.background = background;
  const backgroundNoLogo = await resources.registerShaderNoMip("menubacknologo");
  state.assertActive();
  media.backgroundNoLogo = backgroundNoLogo;
  const enter = await sounds.registerSound("sound/misc/menu1.wav", false);
  state.assertActive();
  media.enter = enter;
  const move = await sounds.registerSound("sound/misc/menu2.wav", false);
  state.assertActive();
  media.move = move;
  const out = await sounds.registerSound("sound/misc/menu3.wav", false);
  state.assertActive();
  media.out = out;
  const buzz = await sounds.registerSound("sound/misc/menu4.wav", false);
  state.assertActive();
  media.buzz = buzz;
  const weaponChange = await sounds.registerSound("sound/weapons/change.wav", false);
  state.assertActive();
  media.weaponChange = weaponChange;
  media.nullSound = CONSUMED;
  const slider = await resources.registerShaderNoMip("menu/art/slider2");
  state.assertActive();
  media.slider = slider;
  const sliderButton = await resources.registerShaderNoMip("menu/art/sliderbutt_0");
  state.assertActive();
  media.sliderButton = sliderButton;
  const sliderFocus = await resources.registerShaderNoMip("menu/art/sliderbutt_1");
  state.assertActive();
  media.sliderFocus = sliderFocus;
}
