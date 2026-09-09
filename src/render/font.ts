// Ported from id Software's renderer/tr_font.c, q3_ui/ui_atoms.c,
// cgame/cg_drawtools.c, cgame/cg_draw.c and ui/ui_main.c. GPL-2.0-or-later.
import { BinaryError, BinaryReader } from "../core/binary.ts";
import type { Vec4 } from "../core/math.ts";
import { Draw2D } from "./draw2d.ts";
import type { PictureAsset, TextureRect } from "./draw2d.ts";
import type { RendererResources } from "./world.ts";

export interface GlyphMetrics extends TextureRect {
  readonly height: number; readonly top: number; readonly bottom: number; readonly pitch: number;
  readonly xSkip: number; readonly imageWidth: number; readonly imageHeight: number; readonly shaderName: string;
}
export interface FontData { readonly name: string; readonly glyphScale: number; readonly glyphs: readonly GlyphMetrics[] }
export interface RegisteredGlyph extends GlyphMetrics { readonly picture: PictureAsset | null }
export interface RegisteredFont extends FontData { readonly glyphs: readonly RegisteredGlyph[] }
export interface LegacyFonts { readonly charset: PictureAsset; readonly proportional: PictureAsset; readonly glow: PictureAsset; readonly banner: PictureAsset }
export interface FontSet {
  readonly small: RegisteredFont; readonly normal: RegisteredFont; readonly big: RegisteredFont;
  readonly profile: "ui" | "cgame"; readonly smallThreshold: number; readonly bigThreshold: number;
}
const f = Math.fround;
const WHITE: Vec4 = { x: 1, y: 1, z: 1, w: 1 };
const COLORS: readonly Vec4[] = [
  { x: 0, y: 0, z: 0, w: 1 }, { x: 1, y: 0, z: 0, w: 1 }, { x: 0, y: 1, z: 0, w: 1 }, { x: 1, y: 1, z: 0, w: 1 },
  { x: 0, y: 0, z: 1, w: 1 }, { x: 0, y: 1, z: 1, w: 1 }, { x: 1, y: 0, z: 1, w: 1 }, WHITE,
];

function byteText(text: string): string {
  const end = text.indexOf("\0"), value = end < 0 ? text : text.slice(0, end);
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 255) throw new RangeError("Quake text requires an 8-bit source string");
  return value;
}
function escapeAt(text: string, index: number): boolean { return text.charCodeAt(index) === 94 && index + 1 < text.length && text.charCodeAt(index + 1) !== 94; }
function escapeColor(code: number, alpha: number): Vec4 {
  const color = COLORS[(code - 48) & 7];
  if (color === undefined) throw new RangeError("Invalid color index");
  return { ...color, w: alpha };
}
function black(alpha: number): Vec4 { return { x: 0, y: 0, z: 0, w: alpha }; }

function fontFixedString(reader: BinaryReader, length: number): string {
  let text = "";
  for (const byte of reader.bytes(length)) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

/** tr_font.c readInt/readFloat copy serialized words without metric validation. */
export function readFontData(bytes: Uint8Array, source = "<font>"): FontData {
  if (bytes.length !== 20548) throw new BinaryError(source, 0, "fontInfo_t must contain exactly 20548 bytes");
  const reader = new BinaryReader(bytes, source), glyphs: GlyphMetrics[] = [];
  for (let i = 0; i < 256; i++) {
    const height = reader.i32(), top = reader.i32(), bottom = reader.i32(), pitch = reader.i32();
    const xSkip = reader.i32(), imageWidth = reader.i32(), imageHeight = reader.i32();
    const s = reader.f32(), t = reader.f32(), s2 = reader.f32(), t2 = reader.f32();
    reader.i32(); // Serialized process-local shader handles must be registered again.
    const shaderName = fontFixedString(reader, 32);
    glyphs.push({ height, top, bottom, pitch, xSkip, imageWidth, imageHeight, s, t, s2, t2, shaderName });
  }
  const glyphScale = reader.f32(), name = fontFixedString(reader, 64);
  return { name, glyphScale, glyphs };
}

/** Detached asset diagnostics; live font registration consumes the source record. */
export function parseFontData(bytes: Uint8Array, source = "<font>"): FontData {
  const data = readFontData(bytes, source);
  for (const [index, glyph] of data.glyphs.entries()) {
    for (const [component, value] of [glyph.s, glyph.t, glyph.s2, glyph.t2].entries())
      if (!Number.isFinite(value)) throw new BinaryError(source, index * 80 + 28 + component * 4, "non-finite float");
    if (glyph.height < 0 || glyph.pitch < 0 || glyph.imageWidth < 0 || glyph.imageHeight < 0)
      throw new BinaryError(source, index * 80, "Negative glyph bitmap dimension");
  }
  if (!Number.isFinite(data.glyphScale)) throw new BinaryError(source, 20480, "non-finite float");
  if (data.glyphScale <= 0) throw new BinaryError(source, 20480, "Font scale must be positive");
  return data;
}

/** UI and cgame borrow the same renderer's font and picture registrations. */
export class UiAssetRegistry {
  constructor(
    private readonly resources: Pick<RendererResources, "registerShader" | "registerShaderNoMip" | "picture" | "fonts">,
    private readonly print: (text: string) => void,
  ) {}

  async registerPicture(path: string, mode: "no-mip" | "mip" = "no-mip"): Promise<PictureAsset> {
    const shader = mode === "no-mip" ? await this.resources.registerShaderNoMip(path) : await this.resources.registerShader(path);
    return this.resources.picture(shader);
  }

  /** Null is RE_RegisterFont's no-write return; the caller retains its destination. */
  registerFont(path: string | null, pointSize: number): Promise<RegisteredFont | null> {
    return this.resources.fonts.registerFont(path, pointSize, this.print);
  }

  async loadLegacyFonts(): Promise<LegacyFonts> {
    const [charset, proportional, glow, banner] = await Promise.all([
      this.registerPicture("gfx/2d/bigchars"), this.registerPicture("menu/art/font1_prop.tga"),
      this.registerPicture("menu/art/font1_prop_glo.tga"), this.registerPicture("menu/art/font2_prop.tga"),
    ]);
    return { charset, proportional, glow, banner };
  }
}

export const UI_LEFT = 0, UI_CENTER = 1, UI_RIGHT = 2, UI_SMALLFONT = 0x10, UI_GIANTFONT = 0x40;
export const UI_DROPSHADOW = 0x800, UI_BLINK = 0x1000, UI_INVERSE = 0x2000, UI_PULSE = 0x4000;

export function drawChar(draw: Draw2D, charset: PictureAsset, x: number, y: number, width: number, height: number, code: number): void {
  const ch = code & 255;
  if (ch === 32) return;
  const s = (ch & 15) / 16, t = (ch >> 4) / 16;
  draw.stretchPic({ x, y, width, height }, { s, t, s2: s + 1 / 16, t2: t + 1 / 16 }, charset);
}

export interface FixedTextOptions {
  readonly x: number; readonly y: number; readonly text: string; readonly color: Vec4;
  readonly charWidth: number; readonly charHeight: number; readonly maxChars: number;
  readonly forceColor: boolean; readonly shadow: boolean;
}

export function drawCgString(draw: Draw2D, charset: PictureAsset, options: FixedTextOptions): void {
  const text = byteText(options.text), maximum = options.maxChars <= 0 ? 32767 : Math.trunc(options.maxChars);
  const pass = (shadow: boolean) => {
    let x = Math.trunc(options.x), count = 0;
    draw.setColor(shadow ? black(options.color.w) : options.color);
    for (let i = 0; i < text.length && count < maximum; i++) {
      if (escapeAt(text, i)) {
        if (!shadow && !options.forceColor) draw.setColor(escapeColor(text.charCodeAt(i + 1), options.color.w));
        i++; continue;
      }
      drawChar(draw, charset, x + (shadow ? 2 : 0), Math.trunc(options.y) + (shadow ? 2 : 0), Math.trunc(options.charWidth), Math.trunc(options.charHeight), text.charCodeAt(i));
      x += Math.trunc(options.charWidth); count++;
    }
  };
  if (options.shadow) pass(true);
  pass(false); draw.setColor(null);
}

export interface UiTextOptions { readonly x: number; readonly y: number; readonly text: string; readonly color: Vec4; readonly style: number; readonly time: number }
function alignedX(x: number, width: number, style: number): number { return Math.trunc(x) - ((style & 7) === UI_CENTER ? Math.trunc(width / 2) : (style & 7) === UI_RIGHT ? width : 0); }
function pulse(time: number): number {
  if (!Number.isInteger(time) || time < -2147483648 || time > 2147483647) throw new RangeError("Font pulse time requires a signed int32");
  return f(0.5 + f(0.5 * f(Math.sin(f(Math.trunc(time / 75) || 0)))));
}

export function drawUiString(draw: Draw2D, charset: PictureAsset, options: UiTextOptions): void {
  if ((options.style & UI_BLINK) !== 0 && (Math.trunc(options.time / 200) & 1) !== 0) return;
  const text = byteText(options.text), width = (options.style & UI_SMALLFONT) !== 0 ? 8 : (options.style & UI_GIANTFONT) !== 0 ? 32 : 16;
  const height = (options.style & UI_GIANTFONT) !== 0 && (options.style & UI_SMALLFONT) === 0 ? 48 : 16;
  let color = options.color;
  if ((options.style & UI_PULSE) !== 0) {
    const t = pulse(options.time), channel = (value: number) => {
      value = f(value);
      return f(Math.max(0, Math.min(1, f(value + f(t * f(f(f(0.8) * value) - value))))));
    };
    color = { x: channel(color.x), y: channel(color.y), z: channel(color.z), w: channel(color.w) };
  }
  const start = alignedX(options.x, text.length * width, options.style);
  const pass = (offset: number, passColor: Vec4) => {
    if (Math.trunc(options.y) + offset < -height) return;
    draw.setColor(passColor);
    const rect = draw.adjust({ x: start + offset, y: Math.trunc(options.y) + offset, width, height });
    let x = rect.x;
    for (let i = 0; i < text.length; i++) {
      if (escapeAt(text, i)) { draw.setColor(escapeColor(text.charCodeAt(++i), passColor.w)); continue; }
      const ch = (text.charCodeAt(i) << 24) >> 24, s = (ch & 15) / 16, t = (ch >> 4) / 16;
      if (ch !== 32) draw.stretchPixels({ ...rect, x }, { s, t, s2: s + 1 / 16, t2: t + 1 / 16 }, charset);
      x = f(x + rect.width);
    }
    draw.setColor(null);
  };
  if ((options.style & UI_DROPSHADOW) !== 0) pass(2, black(color.w));
  pass(0, color);
}

type AtlasMetric = readonly [number, number, number];
const INVALID_METRIC: AtlasMetric = [0, 0, -1];
const PROP_ASCII: readonly AtlasMetric[] = [
  [0,0,8],[11,122,7],[154,181,14],[55,122,17],[79,122,18],[101,122,23],[153,122,18],[9,93,7],
  [207,122,8],[230,122,9],[177,122,18],[30,152,18],[85,181,7],[34,93,11],[110,181,6],[130,152,14],
  [22,64,17],[41,64,12],[58,64,17],[78,64,18],[98,64,19],[120,64,18],[141,64,18],[204,64,16],
  [162,64,17],[182,64,18],[59,181,7],[35,181,7],[203,152,14],[56,93,14],[228,152,14],[177,181,18],
  [28,122,22],[5,4,18],[27,4,18],[48,4,18],[69,4,17],[90,4,13],[106,4,13],[121,4,18],
  [143,4,17],[164,4,8],[175,4,16],[195,4,18],[216,4,12],[230,4,23],[6,34,18],[27,34,18],
  [48,34,18],[68,34,18],[90,34,17],[110,34,18],[130,34,14],[146,34,18],[166,34,19],[185,34,29],
  [215,34,18],[234,34,18],[5,64,14],[60,152,7],[106,151,13],[83,152,7],[128,122,17],[4,152,21],
  [134,181,5],
];
const PROP_END: readonly AtlasMetric[] = [[153,152,13],[11,181,5],[180,152,13],[79,93,17]];
const BANNER: readonly AtlasMetric[] = [
  [11,12,33],[49,12,31],[85,12,31],[120,12,30],[156,12,21],[183,12,21],[207,12,32],
  [13,55,30],[49,55,13],[66,55,29],[101,55,31],[135,55,21],[158,55,40],[204,55,32],
  [12,97,31],[48,97,31],[82,97,30],[118,97,30],[153,97,30],[185,97,25],[213,97,30],
  [11,139,32],[42,139,51],[93,139,32],[126,139,31],[158,139,25],
];
function propMetric(code: number): AtlasMetric {
  let ch = code & 127;
  if (ch < 32 || ch === 127) return INVALID_METRIC;
  if (ch >= 97 && ch <= 122) ch -= 32;
  const metric = ch >= 123 ? PROP_END[ch - 123] : PROP_ASCII[ch - 32];
  if (metric === undefined) throw new RangeError("Invalid proportional glyph index");
  return metric;
}
function bannerMetric(code: number): AtlasMetric {
  const metric = BANNER[code - 65];
  if (metric === undefined) throw new RangeError("Invalid banner glyph index");
  return metric;
}
export function proportionalStringWidth(input: string): number {
  const text = byteText(input); let width = 0;
  for (let i = 0; i < text.length; i++) { const metric = propMetric(text.charCodeAt(i)); if (metric[2] !== -1) width += metric[2] + 3; }
  return width - 3;
}
export function bannerStringWidth(input: string): number {
  const text = byteText(input); let width = 0;
  for (let i = 0; i < text.length; i++) { const ch = text.charCodeAt(i); if (ch === 32) width += 12; else if (ch >= 65 && ch <= 90) width += bannerMetric(ch)[2] + 4; }
  return width - 4;
}

type LegacyProfile = "ui" | "cgame";
function atlasPass(draw: Draw2D, picture: PictureAsset, text: string, x: number, y: number, color: Vec4, size: number, banner: boolean, profile: LegacyProfile): void {
  draw.setColor(color);
  const position = draw.adjust({ x, y, width: 0, height: 0 });
  const verticalScale = profile === "cgame" ? draw.scaleX : draw.scaleY;
  const top = profile === "cgame" ? f(y * draw.scaleX) : position.y;
  let ax = position.x, aw = 0;
  const gap = f(f((banner ? 4 : 3) * draw.scaleX) * size), height = f(f((banner ? 36 : 27) * verticalScale) * size);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) & 127;
    if (banner && code !== 32 && (code < 65 || code > 90)) continue;
    const metric = banner && code !== 32 ? bannerMetric(code) : propMetric(code);
    if (code === 32) aw = f(f((banner ? 12 : 8) * draw.scaleX) * size);
    else if (metric[2] !== -1) {
      aw = f(f(metric[2] * draw.scaleX) * size);
      draw.stretchPixels({ x: ax, y: top, width: aw, height }, { s: metric[0] / 256, t: metric[1] / 256, s2: (metric[0] + metric[2]) / 256, t2: (metric[1] + (banner ? 36 : 27)) / 256 }, picture);
    } else if (profile === "cgame") aw = 0;
    ax = f(ax + f(aw + gap));
  }
  draw.setColor(null);
}

export function drawProportionalString(draw: Draw2D, fonts: LegacyFonts, options: UiTextOptions): void {
  proportionalText(draw, fonts, options, "ui");
}
export function drawCgProportionalString(draw: Draw2D, fonts: LegacyFonts, options: UiTextOptions): void {
  proportionalText(draw, fonts, options, "cgame");
}
function proportionalText(draw: Draw2D, fonts: LegacyFonts, options: UiTextOptions, profile: LegacyProfile): void {
  const text = byteText(options.text), size = (options.style & UI_SMALLFONT) !== 0 ? 0.75 : 1;
  const x = alignedX(options.x, Math.trunc(proportionalStringWidth(text) * size), options.style), y = Math.trunc(options.y);
  if ((options.style & UI_DROPSHADOW) !== 0) atlasPass(draw, fonts.proportional, text, x + 2, y + 2, black(options.color.w), size, false, profile);
  if ((options.style & UI_INVERSE) !== 0) {
    const inverse = f(profile === "cgame" ? 0.8 : 0.7);
    atlasPass(draw, fonts.proportional, text, x, y, { x: f(f(options.color.x) * inverse), y: f(f(options.color.y) * inverse), z: f(f(options.color.z) * inverse), w: options.color.w }, size, false, profile);
    return;
  }
  atlasPass(draw, fonts.proportional, text, x, y, options.color, size, false, profile);
  if ((options.style & UI_PULSE) !== 0) atlasPass(draw, fonts.glow, text, x, y, { ...options.color, w: pulse(options.time) }, size, false, profile);
}
export function drawBannerString(draw: Draw2D, fonts: LegacyFonts, options: UiTextOptions): void {
  bannerText(draw, fonts, options, "ui");
}
export function drawCgBannerString(draw: Draw2D, fonts: LegacyFonts, options: UiTextOptions): void {
  bannerText(draw, fonts, options, "cgame");
}
function bannerText(draw: Draw2D, fonts: LegacyFonts, options: UiTextOptions, profile: LegacyProfile): void {
  const text = byteText(options.text), x = alignedX(options.x, bannerStringWidth(text), options.style), y = Math.trunc(options.y);
  if ((options.style & UI_DROPSHADOW) !== 0) atlasPass(draw, fonts.banner, text, x + 2, y + 2, black(options.color.w), 1, true, profile);
  atlasPass(draw, fonts.banner, text, x, y, options.color, 1, true, profile);
}

function selectFont(fonts: FontSet, scale: number): RegisteredFont {
  if (!Number.isFinite(scale)) throw new RangeError("Non-finite text scale");
  return f(scale) <= f(fonts.smallThreshold) ? fonts.small : (fonts.profile === "ui" ? f(scale) >= f(fonts.bigThreshold) : f(scale) > f(fonts.bigThreshold)) ? fonts.big : fonts.normal;
}
function glyphAt(font: RegisteredFont, code: number): RegisteredGlyph {
  const glyph = font.glyphs[code];
  if (glyph === undefined) throw new RangeError(`Missing font glyph ${code}`);
  return glyph;
}
function textMetric(fonts: FontSet, input: string, scale: number, limit: number, height: boolean): number {
  const text = byteText(input), font = selectFont(fonts, scale), useScale = f(f(scale) * font.glyphScale);
  const maximum = limit > 0 ? Math.min(text.length, Math.trunc(limit)) : text.length;
  let value = 0, count = 0;
  for (let i = 0; i < text.length && count < maximum; i++) {
    if (escapeAt(text, i)) { i++; continue; }
    const glyph = glyphAt(font, text.charCodeAt(i));
    value = height ? Math.max(value, glyph.height) : f(value + glyph.xSkip); count++;
  }
  return Math.trunc(f(value * useScale));
}
export function textWidth(fonts: FontSet, text: string, scale: number, limit = 0): number { return textMetric(fonts, text, scale, limit, false); }
export function textHeight(fonts: FontSet, text: string, scale: number, limit = 0): number { return textMetric(fonts, text, scale, limit, true); }
export interface TextPaintOptions {
  readonly x: number; readonly y: number; readonly scale: number; readonly color: Vec4; readonly text: string;
  readonly adjust: number; readonly limit: number; readonly style: number;
}
function paintGlyph(draw: Draw2D, glyph: RegisteredGlyph, x: number, baseline: number, scale: number): void {
  if (glyph.picture !== null) draw.stretchPic({ x, y: f(baseline - f(scale * glyph.top)), width: f(glyph.imageWidth * scale), height: f(glyph.imageHeight * scale) }, glyph, glyph.picture);
}
export interface TextCursor { readonly position: number; readonly character: number; readonly time: number }
function paintText(draw: Draw2D, fonts: FontSet, options: TextPaintOptions, cursor: TextCursor | null): void {
  const text = byteText(options.text), font = selectFont(fonts, options.scale), scale = f(f(options.scale) * font.glyphScale);
  const maximum = options.limit > 0 ? Math.min(text.length, Math.trunc(options.limit)) : text.length;
  let x = f(options.x), color = options.color, count = 0;
  const cursorGlyph = cursor === null ? null : glyphAt(font, cursor.character & 255);
  const cursorVisible = cursor !== null && (Math.trunc(cursor.time / 200) & 1) === 0;
  draw.setColor(color);
  for (let i = 0; i < text.length && count < maximum; i++) {
    if (escapeAt(text, i)) { color = escapeColor(text.charCodeAt(++i), options.color.w); draw.setColor(color); continue; }
    const glyph = glyphAt(font, text.charCodeAt(i)), baseline = f(options.y);
    if (options.style === 3 || options.style === 6) {
      const offset = options.style === 3 ? 1 : 2;
      // Source offsets the already-adjusted glyph top, not the baseline before subtraction.
      if (glyph.picture !== null) {
        draw.setColor(black(color.w));
        draw.stretchPic({ x: f(x + offset), y: f(f(baseline - f(scale * glyph.top)) + offset), width: f(glyph.imageWidth * scale), height: f(glyph.imageHeight * scale) }, glyph, glyph.picture);
        draw.setColor(color);
      }
    }
    paintGlyph(draw, glyph, x, baseline, scale);
    if (cursorVisible && cursor !== null && cursor.position === count && cursorGlyph !== null) paintGlyph(draw, cursorGlyph, x, baseline, scale);
    x = f(x + f(f(glyph.xSkip * scale) + (cursor === null ? f(options.adjust) : 0))); count++;
  }
  // Text_PaintWithCursor compares against the raw strlen-based limit here, not count.
  if (cursorVisible && cursor !== null && cursor.position === maximum && cursorGlyph !== null) paintGlyph(draw, cursorGlyph, x, f(options.y), scale);
  draw.setColor(null);
}
export function textPaint(draw: Draw2D, fonts: FontSet, options: TextPaintOptions): void { paintText(draw, fonts, options, null); }
export function textPaintWithCursor(draw: Draw2D, fonts: FontSet, options: Omit<TextPaintOptions, "adjust">, cursor: TextCursor): void {
  paintText(draw, fonts, { ...options, adjust: 0 }, cursor);
}

/** Returns the source *maxX output: zero on overflow, otherwise the updated pen. */
export function textPaintLimit(draw: Draw2D, fonts: FontSet, options: Omit<TextPaintOptions, "style">, maxX: number): number {
  const text = byteText(options.text), font = selectFont({ ...fonts, profile: "cgame" }, options.scale), scale = f(f(options.scale) * font.glyphScale);
  const maximum = options.limit > 0 ? Math.min(text.length, Math.trunc(options.limit)) : text.length;
  let x = f(options.x), result = f(maxX), count = 0;
  draw.setColor(options.color);
  for (let i = 0; i < text.length && count < maximum; i++) {
    if (escapeAt(text, i)) { draw.setColor(escapeColor(text.charCodeAt(++i), options.color.w)); continue; }
    // UI source passes useScale back through Text_Width, selecting/scaling the font again.
    if (f(textWidth(fonts, text.slice(i), scale, 1) + x) > f(maxX)) { result = 0; break; }
    const glyph = glyphAt(font, text.charCodeAt(i));
    paintGlyph(draw, glyph, x, f(options.y), scale);
    x = f(x + f(f(glyph.xSkip * scale) + f(options.adjust))); result = x; count++;
  }
  draw.setColor(null);
  return result;
}
