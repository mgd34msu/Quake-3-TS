// Source coordinate helpers, id Software cg_drawtools.c and ui_atoms.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Vec4 } from "../core/math.ts";
import type { RenderState } from "./types.ts";
import type { PictureAsset } from "./picture-material.ts";
import type { RenderCommandBuffer } from "./commands.ts";
import type { PreparedUiRawCall } from "./cinematic-command.ts";
export type { ImagePicture, MaterialPicture, PictureAsset, PictureClock } from "./picture-material.ts";

export interface Rect2D { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface TextureRect { readonly s: number; readonly t: number; readonly s2: number; readonly t2: number }
export type CoordinateSpace = "pixels" | "stretch-640" | "base-ui-640" | "team-ui-640";
export const UI_PICTURE_STATE: RenderState = {
  blend: { source: "src-alpha", destination: "one-minus-src-alpha" },
  depthTest: "always", depthWrite: false, alphaTest: "none", cull: "none",
};
const FULL_UV: TextureRect = { s: 0, t: 0, s2: 1, t2: 1 };
const f = Math.fround;

/** A coordinate profile borrowing the engine's command queue and color state. */
export class Draw2D {
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly biasX: number;
  constructor(readonly commands: RenderCommandBuffer, readonly space: CoordinateSpace) {
    this.width = commands.target.width; this.height = commands.target.height;
    switch (space) {
      case "pixels": this.scaleX = 1; this.scaleY = 1; break;
      case "stretch-640": this.scaleX = f(f(this.width) / 640); this.scaleY = f(f(this.height) / 480); break;
      case "base-ui-640": this.scaleX = f(f(this.height) * f(1 / 480)); this.scaleY = this.scaleX; break;
      case "team-ui-640":
        this.scaleX = f(f(this.width) * f(1 / 640));
        this.scaleY = f(f(this.height) * f(1 / 480));
        break;
    }
    this.biasX = space === "base-ui-640" && Math.imul(this.width, 480) > Math.imul(this.height, 640)
      ? f(0.5 * f(f(this.width) - f(f(this.height) * f(640 / 480)))) : 0;
  }
  setColor(color: Vec4 | null): void { this.commands.setColor(color); }
  adjust(rect: Rect2D): Rect2D {
    const x = f(f(rect.x) * this.scaleX);
    return { x: this.space === "team-ui-640" ? x : f(x + this.biasX), y: f(f(rect.y) * this.scaleY), width: f(f(rect.width) * this.scaleX), height: f(f(rect.height) * this.scaleY) };
  }
  stretchPic(rect: Rect2D, uv: TextureRect, picture: PictureAsset | (() => PictureAsset)): void { this.stretchPixels(this.adjust(rect), uv, picture); }
  stretchPixels(rect: Rect2D, uv: TextureRect, picture: PictureAsset | (() => PictureAsset)): void { this.commands.stretchPixels(rect, uv, picture); }
  stretchRawPixels(rect: Rect2D, call: PreparedUiRawCall): undefined { return this.commands.stretchRaw(rect, call); }
  drawPic(rect: Rect2D, picture: PictureAsset): void { this.stretchPic(rect, FULL_UV, picture); }
  drawHandlePic(rect: Rect2D, picture: PictureAsset | (() => PictureAsset)): void {
    this.stretchPic({ ...rect, width: Math.abs(rect.width), height: Math.abs(rect.height) }, {
      s: rect.width < 0 ? 1 : 0, s2: rect.width < 0 ? 0 : 1,
      t: rect.height < 0 ? 1 : 0, t2: rect.height < 0 ? 0 : 1,
    }, picture);
  }
  fillRect(rect: Rect2D, color: Vec4, whitePicture: PictureAsset): void {
    this.setColor(color); this.stretchPic(rect, { s: 0, t: 0, s2: 0, t2: 0 }, whitePicture); this.setColor(null);
  }
  /** Base UI outlines use one physical pixel, unlike scaled cgame outlines. */
  drawUiRect(rect: Rect2D, color: Vec4, whitePicture: PictureAsset): void {
    this.setColor(color);
    if (this.space === "base-ui-640") {
      const r = this.adjust(rect), uv = { s: 0, t: 0, s2: 0, t2: 0 };
      this.stretchPixels({ ...r, height: 1 }, uv, whitePicture);
      this.stretchPixels({ ...r, width: 1 }, uv, whitePicture);
      this.stretchPixels({ ...r, y: f(f(r.y + r.height) - 1), height: 1 }, uv, whitePicture);
      this.stretchPixels({ ...r, x: f(f(r.x + r.width) - 1), width: 1 }, uv, whitePicture);
    } else {
      this.drawUiTopBottom(rect, whitePicture);
      this.drawUiSides(rect, whitePicture);
    }
    this.setColor(null);
  }
  drawUiTopBottom(rect: Rect2D, whitePicture: PictureAsset): void {
    const r = this.adjust(rect), uv = { s: 0, t: 0, s2: 0, t2: 0 };
    this.stretchPixels({ ...r, height: 1 }, uv, whitePicture);
    this.stretchPixels({ ...r, y: f(f(r.y + r.height) - 1), height: 1 }, uv, whitePicture);
  }
  drawUiSides(rect: Rect2D, whitePicture: PictureAsset): void {
    const r = this.adjust(rect), uv = { s: 0, t: 0, s2: 0, t2: 0 };
    this.stretchPixels({ ...r, width: 1 }, uv, whitePicture);
    this.stretchPixels({ ...r, x: f(f(r.x + r.width) - 1), width: 1 }, uv, whitePicture);
  }
  drawCgRect(rect: Rect2D, size: number, color: Vec4, whitePicture: PictureAsset): void {
    this.setColor(color);
    this.drawCgTopBottom(rect, size, whitePicture);
    this.drawCgSides(rect, size, whitePicture);
    this.setColor(null);
  }
  drawCgTopBottom(rect: Rect2D, size: number, whitePicture: PictureAsset): void {
    const uv = { s: 0, t: 0, s2: 0, t2: 0 }, r = this.adjust(rect);
    const vertical = f(f(size) * this.scaleY);
    this.stretchPixels({ ...r, height: vertical }, uv, whitePicture);
    this.stretchPixels({ ...r, y: f(f(r.y + r.height) - vertical), height: vertical }, uv, whitePicture);
  }
  drawCgSides(rect: Rect2D, size: number, whitePicture: PictureAsset): void {
    const uv = { s: 0, t: 0, s2: 0, t2: 0 }, r = this.adjust(rect);
    const horizontal = f(f(size) * this.scaleX);
    this.stretchPixels({ ...r, width: horizontal }, uv, whitePicture);
    this.stretchPixels({ ...r, x: f(f(r.x + r.width) - horizontal), width: horizontal }, uv, whitePicture);
  }
}
