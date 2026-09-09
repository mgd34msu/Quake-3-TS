// Engine picture, text and field drawing from id Software cl_scrn.c and cl_keys.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { EditField } from "../core/edit-field.ts";
import type { Vec4 } from "../core/math.ts";
import { sourceCommandText } from "../core/text.ts";
import type { RenderCommandBuffer } from "../render/commands.ts";
import type { Draw2D, PictureAsset, Rect2D } from "../render/draw2d.ts";
import type { RendererResources } from "../render/world.ts";
import type { ClientKeys } from "./client-keys.ts";
import type { ClientStaticState } from "./client-state.ts";

export interface EngineScreenPictures {
  readonly charset: PictureAsset;
  readonly white: PictureAsset;
  readonly console: PictureAsset;
}
export interface EngineScreenDrawing {
  readonly commands: RenderCommandBuffer;
  readonly resources: RendererResources;
  readonly pictures: EngineScreenPictures;
  readonly pixels: Draw2D;
  readonly virtual: Draw2D;
  readonly state: ClientStaticState;
  readonly keys: Pick<ClientKeys, "getOverstrike">;
}
export function createEngineScreenDrawing(options: Omit<EngineScreenDrawing, "pixels" | "virtual">): EngineScreenDrawing {
  if (options.commands.target.images !== options.resources.images) throw new Error("Engine screen requires its renderer's actual image catalog");
  return Object.freeze({ ...options, pictures: Object.freeze({ ...options.pictures }),
    pixels: options.commands.draw2D("pixels"), virtual: options.commands.draw2D("stretch-640") });
}
const COLORS: readonly Vec4[] = [
  { x: 0, y: 0, z: 0, w: 1 }, { x: 1, y: 0, z: 0, w: 1 },
  { x: 0, y: 1, z: 0, w: 1 }, { x: 1, y: 1, z: 0, w: 1 },
  { x: 0, y: 0, z: 1, w: 1 }, { x: 0, y: 1, z: 1, w: 1 },
  { x: 1, y: 0, z: 1, w: 1 }, { x: 1, y: 1, z: 1, w: 1 },
];
export function screenColor(index: number): Vec4 {
  const color = COLORS[index];
  if (color === undefined) throw new RangeError("Engine color index outside 0..7");
  return color;
}
export function screenColorEscape(text: string, index: number): boolean {
  return text.charCodeAt(index) === 94 && index + 1 < text.length && text.charCodeAt(index + 1) !== 94;
}
function integer(value: number): number {
  if (!Number.isFinite(value) || value < -2147483648 || value >= 2147483648) throw new RangeError("Undefined native screen integer conversion");
  return Math.trunc(value) || 0;
}
export function screenAdjustFrom640(drawing: EngineScreenDrawing, rect: Rect2D): Rect2D {
  const { scaleX, scaleY } = drawing.virtual;
  return { x: Math.fround(Math.fround(rect.x) * scaleX), y: Math.fround(Math.fround(rect.y) * scaleY),
    width: Math.fround(Math.fround(rect.width) * scaleX), height: Math.fround(Math.fround(rect.height) * scaleY) };
}
export async function screenDrawNamedPic(drawing: EngineScreenDrawing, rect: Rect2D, name: string): Promise<void> {
  const captured = { x: Math.fround(rect.x), y: Math.fround(rect.y), width: Math.fround(rect.width), height: Math.fround(rect.height) };
  if (captured.width === 0) throw new RangeError("SCR_DrawNamedPic requires nonzero width");
  const handle = await drawing.resources.registerShader(name);
  screenDrawPic(drawing, captured, drawing.resources.picture(handle));
}
export function screenFillRect(drawing: EngineScreenDrawing, rect: Rect2D, color: Vec4): void {
  drawing.pixels.setColor(color);
  drawing.pixels.stretchPixels(screenAdjustFrom640(drawing, rect), { s: 0, t: 0, s2: 0, t2: 0 }, drawing.pictures.white);
  drawing.pixels.setColor(null);
}
export function screenDrawPic(drawing: EngineScreenDrawing, rect: Rect2D, picture: PictureAsset): void {
  drawing.pixels.stretchPixels(screenAdjustFrom640(drawing, rect), { s: 0, t: 0, s2: 1, t2: 1 }, picture);
}
function glyph(draw: Draw2D, picture: PictureAsset, rect: Rect2D, code: number): void {
  const s = (code & 15) * 0.0625, t = (code >> 4) * 0.0625;
  draw.stretchPixels(rect, { s, t, s2: s + 0.0625, t2: t + 0.0625 }, picture);
}
export function screenDrawChar(drawing: EngineScreenDrawing, x: number, y: number, size: number, code: number): void {
  const ch = integer(code) & 255, left = integer(x), top = integer(y), extent = Math.fround(size);
  if (ch === 32 || top < -extent) return;
  glyph(drawing.pixels, drawing.pictures.charset, screenAdjustFrom640(drawing, { x: left, y: top, width: extent, height: extent }), ch);
}
export function screenDrawSmallChar(drawing: EngineScreenDrawing, x: number, y: number, code: number): void {
  const ch = integer(code) & 255, left = integer(x), top = integer(y);
  if (ch === 32 || top < -16) return;
  glyph(drawing.pixels, drawing.pictures.charset, { x: left, y: top, width: 8, height: 16 }, ch);
}
export function screenDrawString(drawing: EngineScreenDrawing, x: number, y: number, size: number, input: string, color: Vec4, forceColor: boolean): void {
  const text = sourceCommandText(input), left = integer(x), top = integer(y), extent = Math.fround(size);
  for (const shadow of [true, false]) {
    drawing.pixels.setColor(shadow ? { x: 0, y: 0, z: 0, w: color.w } : color);
    let xx = left;
    for (let i = 0; i < text.length; i++) {
      if (screenColorEscape(text, i)) {
        if (!shadow && !forceColor) drawing.pixels.setColor({ ...screenColor((text.charCodeAt(i + 1) - 48) & 7), w: color.w });
        i++; continue;
      }
      screenDrawChar(drawing, xx + (shadow ? 2 : 0), top + (shadow ? 2 : 0), extent, text.charCodeAt(i));
      xx = integer(xx + extent);
    }
  }
  drawing.pixels.setColor(null);
}
export function screenDrawBigString(drawing: EngineScreenDrawing, x: number, y: number, text: string, alpha: number): void {
  screenDrawString(drawing, x, y, 16, text, { x: 1, y: 1, z: 1, w: alpha }, false);
}
export function screenDrawBigStringColor(drawing: EngineScreenDrawing, x: number, y: number, text: string, color: Vec4): void {
  screenDrawString(drawing, x, y, 16, text, color, true);
}
export function screenDrawSmallString(drawing: EngineScreenDrawing, x: number, y: number, input: string, color: Vec4, forceColor: boolean): void {
  const text = sourceCommandText(input), top = integer(y);
  let xx = integer(x);
  drawing.pixels.setColor(color);
  for (let i = 0; i < text.length; i++) {
    if (screenColorEscape(text, i)) {
      if (!forceColor) drawing.pixels.setColor({ ...screenColor((text.charCodeAt(i + 1) - 48) & 7), w: color.w });
      i++; continue;
    }
    screenDrawSmallChar(drawing, xx, top, text.charCodeAt(i)); xx = integer(xx + 8);
  }
  drawing.pixels.setColor(null);
}
export function screenStringLength(input: string): number {
  const text = sourceCommandText(input);
  let count = 0;
  for (let i = 0; i < text.length; i++) { if (screenColorEscape(text, i)) i++; else count++; }
  return count;
}
export function screenBigStringWidth(text: string): number { return integer(screenStringLength(text) * 16); }

export function screenDrawVariableField(drawing: EngineScreenDrawing, field: EditField, x: number, y: number, size: number, showCursor: boolean): void {
  x = integer(x); y = integer(y); size = integer(size);
  const text = field.text, len = text.length + 1;
  let drawLen = field.widthInChars, prestep: number;
  if (len <= drawLen) prestep = 0;
  else {
    if (field.scroll + drawLen > len) { field.scroll = len - drawLen; if (field.scroll < 0) field.scroll = 0; }
    prestep = field.scroll;
  }
  if (prestep + drawLen > len) drawLen = len - prestep;
  if (!Number.isInteger(drawLen) || drawLen < 0 || drawLen >= 1024 || !Number.isInteger(prestep) || prestep < 0 || prestep + drawLen > 256) {
    throw new RangeError("Undefined native field drawing copy range");
  }
  const visible = text.slice(prestep, prestep + drawLen);
  if (size === 8) screenDrawSmallString(drawing, x, y, visible, screenColor(7), false);
  else screenDrawBigString(drawing, x, y, visible, 1);
  if (!showCursor || ((drawing.state.realtime >> 8) & 1) !== 0) return;
  const cursor = drawing.keys.getOverstrike() ? 11 : 10;
  const skipped = drawLen - (screenStringLength(visible) + 1);
  const left = integer(x + (field.cursor - prestep - skipped) * size);
  if (size === 8) screenDrawSmallChar(drawing, left, y, cursor);
  else screenDrawBigString(drawing, left, y, String.fromCharCode(cursor), 1);
}
export function screenDrawField(drawing: EngineScreenDrawing, field: EditField, x: number, y: number, showCursor: boolean): void {
  screenDrawVariableField(drawing, field, x, y, 8, showCursor);
}
export function screenDrawBigField(drawing: EngineScreenDrawing, field: EditField, x: number, y: number, showCursor: boolean): void {
  screenDrawVariableField(drawing, field, x, y, 16, showCursor);
}
