// Ported from id Software's code/cgame/cg_drawtools.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Vec4 } from "../core/math.ts";
import { Draw2D } from "../render/draw2d.ts";
import type { Rect2D } from "../render/draw2d.ts";
import { drawCgString, drawChar, drawCgProportionalString, drawCgBannerString, UI_SMALLFONT, proportionalStringWidth, bannerStringWidth } from "../render/font.ts";
import type { FixedTextOptions, UiTextOptions, LegacyFonts } from "../render/font.ts";
import type { SceneShader } from "../render/ref-entity.ts";
import type { Refdef } from "../render/refdef.ts";
import { ARMOR_PROTECTION, Team, statSchema } from "../shared/definitions.ts";
import type { ClientMedia } from "./media.ts";
import type { ClientGameState } from "./state.ts";

const f = Math.fround;
const ZERO_UV = { s: 0, t: 0, s2: 0, t2: 0 };
const white = (alpha: number): Vec4 => ({ x: 1, y: 1, z: 1, w: f(alpha) });

export function drawStrlen(text: string): number {
  for (let i = 0; i < text.length && text.charCodeAt(i) !== 0; i++) if (text.charCodeAt(i) > 255) throw new RangeError("Cgame text requires byte characters");
  let count = 0;
  for (let i = 0; i < text.length && text.charCodeAt(i) !== 0; i++) {
    if (text[i] === "^" && i + 1 < text.length && text.charCodeAt(i + 1) !== 0 && text[i + 1] !== "^") i++;
    else count++;
  }
  return count;
}

export { proportionalStringWidth, bannerStringWidth };
export function proportionalSizeScale(style: number): number { return (style & UI_SMALLFONT) !== 0 ? 0.75 : 1; }

export function fadeColor(time: number, startMsec: number, totalMsec: number): Vec4 | null {
  const start = startMsec | 0, total = totalMsec | 0, elapsed = ((time | 0) - start) | 0;
  if (start === 0 || elapsed >= total) return null;
  const remaining = (total - elapsed) | 0;
  return white(remaining < 200 ? remaining / 200 : 1);
}

export function teamColor(team: number): Vec4 {
  switch (team) {
    case Team.TEAM_RED: return { x: 1, y: f(0.2), z: f(0.2), w: 1 };
    case Team.TEAM_BLUE: return { x: f(0.2), y: f(0.2), z: 1, w: 1 };
    case Team.TEAM_SPECTATOR: return { x: f(0.7), y: f(0.7), z: f(0.7), w: 1 };
    default: return white(1);
  }
}

export function getColorForHealth(health: number, armor: number): Vec4 {
  health |= 0; armor |= 0;
  if (health <= 0) return { x: 0, y: 0, z: 0, w: 1 };
  const maximum = (health * ARMOR_PROTECTION / (1 - ARMOR_PROTECTION)) | 0;
  health = (health + Math.min(armor, maximum)) | 0;
  return { x: 1, y: health > 60 ? 1 : health < 30 ? 0 : f((health - 30) / 30),
    z: health >= 100 ? 1 : health < 66 ? 0 : f((health - 66) / 33), w: 1 };
}

export function colorForHealth(state: ClientGameState): Vec4 {
  const snapshot = state.snap;
  if (snapshot === null) throw new Error("CG_ColorForHealth requires a current snapshot");
  const stats = statSchema(snapshot.playerState.product);
  return getColorForHealth(snapshot.playerState.stats.get(stats.health), snapshot.playerState.stats.get(stats.armor));
}

/** One cgame draw recorder; media handles resolve through the live renderer cache. */
export class ClientDrawTools {
  constructor(readonly draw: Draw2D, readonly media: ClientMedia) {
    if (draw.space !== "stretch-640") throw new Error("Cgame drawing requires stretch-640 coordinates");
  }

  private picture(shader: SceneShader | null) {
    return this.media.resources.picture(shader);
  }

  private legacyFonts(): LegacyFonts {
    const graphics = this.media.graphics;
    return { charset: this.picture(graphics.charsetShader), proportional: this.picture(graphics.charsetProp),
      glow: this.picture(graphics.charsetPropGlow), banner: this.picture(graphics.charsetPropB) };
  }
  drawProportionalString(options: UiTextOptions): void { drawCgProportionalString(this.draw, this.legacyFonts(), options); }
  drawBannerString(options: UiTextOptions): void { drawCgBannerString(this.draw, this.legacyFonts(), options); }

  adjustFrom640(rect: Rect2D): Rect2D { return this.draw.adjust(rect); }
  fillRect(rect: Rect2D, color: Vec4 | null): void {
    this.draw.setColor(color);
    this.draw.stretchPic(rect, ZERO_UV, this.picture(this.media.graphics.whiteShader));
    this.draw.setColor(null);
  }
  drawSides(rect: Rect2D, size: number): void {
    const r = this.adjustFrom640(rect), width = f(f(size) * this.draw.scaleX), picture = this.picture(this.media.graphics.whiteShader);
    this.draw.stretchPixels({ ...r, width }, ZERO_UV, picture);
    this.draw.stretchPixels({ ...r, x: f(f(r.x + r.width) - width), width }, ZERO_UV, picture);
  }
  drawTopBottom(rect: Rect2D, size: number): void {
    const r = this.adjustFrom640(rect), height = f(f(size) * this.draw.scaleY), picture = this.picture(this.media.graphics.whiteShader);
    this.draw.stretchPixels({ ...r, height }, ZERO_UV, picture);
    this.draw.stretchPixels({ ...r, y: f(f(r.y + r.height) - height), height }, ZERO_UV, picture);
  }
  drawRect(rect: Rect2D, size: number, color: Vec4 | null): void {
    this.draw.setColor(color); this.drawTopBottom(rect, size); this.drawSides(rect, size); this.draw.setColor(null);
  }
  drawPic(rect: Rect2D, shader: SceneShader | null): void { this.draw.drawPic(rect, this.picture(shader)); }
  drawChar(x: number, y: number, width: number, height: number, code: number): void {
    if ((code & 255) === 32) return;
    drawChar(this.draw, this.picture(this.media.graphics.charsetShader), x | 0, y | 0, width | 0, height | 0, code);
  }
  drawStringExt(options: FixedTextOptions): void { drawCgString(this.draw, this.picture(this.media.graphics.charsetShader), options); }
  drawBigString(x: number, y: number, text: string, alpha: number): void {
    this.drawStringExt({ x, y, text, color: white(alpha), forceColor: false, shadow: true, charWidth: 16, charHeight: 16, maxChars: 0 });
  }
  drawBigStringColor(x: number, y: number, text: string, color: Vec4): void {
    this.drawStringExt({ x, y, text, color, forceColor: true, shadow: true, charWidth: 16, charHeight: 16, maxChars: 0 });
  }
  drawSmallString(x: number, y: number, text: string, alpha: number): void {
    this.drawStringExt({ x, y, text, color: white(alpha), forceColor: false, shadow: false, charWidth: 8, charHeight: 16, maxChars: 0 });
  }
  drawSmallStringColor(x: number, y: number, text: string, color: Vec4): void {
    this.drawStringExt({ x, y, text, color, forceColor: true, shadow: false, charWidth: 8, charHeight: 16, maxChars: 0 });
  }
  private tileClearBox(x: number, y: number, width: number, height: number): void {
    this.draw.stretchPixels({ x, y, width, height }, { s: x / 64, t: y / 64, s2: (x + width) / 64, t2: (y + height) / 64 }, this.picture(this.media.graphics.backTileShader));
  }
  tileClear(refdef: Refdef): void {
    const width = this.draw.width, height = this.draw.height;
    if (refdef.x === 0 && refdef.y === 0 && refdef.width === width && refdef.height === height) return;
    const top = refdef.y | 0, bottom = (top + (refdef.height | 0) - 1) | 0, left = refdef.x | 0, right = (left + (refdef.width | 0) - 1) | 0;
    this.tileClearBox(0, 0, width, top);
    this.tileClearBox(0, bottom, width, height - bottom);
    this.tileClearBox(0, top, left, bottom - top + 1);
    this.tileClearBox(right, top, width - right, bottom - top + 1);
  }
}
