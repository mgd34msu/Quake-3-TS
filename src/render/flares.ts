// Retained flare allocation and helpers from id Software renderer/tr_flares.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import { dot3, scale3, sub3 } from "../core/math.ts";
import type { Bounds, Mat4, Vec3 } from "../core/math.ts";
import { normalizeFast3 } from "../core/renderer-math.ts";
import type { DynamicLight } from "./lighting.ts";
import type { MaterialRecord } from "./material-registry.ts";
import type { RendererBackEndCounters } from "./performance.ts";
import type { SourceTessState } from "./tess-state.ts";
import type { SurfaceViewOperation } from "./types.ts";
import { sourceTransformClipToWindow, sourceTransformModelToClip } from "./view.ts";

const f = Math.fround;
function sourceInteger(value: number, site: string): number {
  const result = Math.trunc(value);
  if (!Number.isFinite(result) || result < -0x80000000 || result > 0x7fffffff)
    throw new RangeError(`${site}: undefined source float-to-int conversion`);
  return result;
}

export interface SourceFlareView {
  readonly frameCount: number;
  readonly frameSceneNum: number;
  readonly inPortal: boolean;
  readonly time: number;
  readonly origin: Vec3;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly projection: Mat4;
}

export interface SourceFlareScene { readonly frameCount: number; readonly frameSceneNum: number }

export interface SourceFlareSettings {
  readonly enabled: boolean;
  readonly fade: number;
  readonly size: number;
}

export interface SourceFlareDepth {
  resetFinishCalled(): void;
  readDepthPixel(x: number, y: number): number;
}

export interface SourceFlareDraw {
  readonly tess: SourceTessState;
  readonly shader: MaterialRecord;
  readonly identityLight: number;
  endSurface(): Iterable<SurfaceViewOperation, unknown, unknown>;
  disablePortalClip(): Iterable<SurfaceViewOperation, unknown, unknown>;
}

export class SourceFlare {
  next: SourceFlare | null = null;
  addedFrame = 0;
  inPortal = false;
  frameSceneNum = 0;
  surface: object | null = null;
  fogNum = 0;
  fadeTime = 0;
  visible = false;
  drawIntensity = 0;
  windowX = 0;
  windowY = 0;
  eyeZ = 0;
  color: Vec3 = { x: 0, y: 0, z: 0 };
}

/** Source BSS belongs to one renderer, across frames, scenes and portal views. */
export class SourceFlares {
  private readonly cells = Array.from({ length: 128 }, () => new SourceFlare());
  private active: SourceFlare | null = null;
  private inactive: SourceFlare | null = null;
  private frameSceneNum = 0;
  private sceneCount = 0;

  constructor(private readonly counters: RendererBackEndCounters) { this.clear(); }

  get activeHead(): SourceFlare | null { return this.active; }
  get scenesRendered(): number { return this.sceneCount; }

  beginFrame(): void { this.frameSceneNum = 0; }

  beginScene(frameCount: number): SourceFlareScene {
    this.frameSceneNum = (this.frameSceneNum + 1) | 0;
    this.sceneCount = (this.sceneCount + 1) | 0;
    return { frameCount, frameSceneNum: this.frameSceneNum };
  }

  clear(): void {
    this.active = this.inactive = null;
    for (const cell of this.cells) {
      Object.assign(cell, new SourceFlare());
      cell.next = this.inactive;
      this.inactive = cell;
    }
  }

  addFlare(surface: object | null, fogNum: number, point: Vec3, color: Vec3, normal: Vec3 | null,
    view: SourceFlareView, model: Mat4): void {
    this.counters.c_flareAdds = (this.counters.c_flareAdds + 1) | 0;
    const { eye, clip } = sourceTransformModelToClip(point, model, view.projection);
    for (const value of [clip.x, clip.y, clip.z]) if (value >= clip.w || value <= -clip.w) return;
    const { window } = sourceTransformClipToWindow(clip, view.viewport);
    if (window.x < 0 || window.x >= view.viewport.width || window.y < 0 || window.y >= view.viewport.height) return;
    let cell = this.active;
    while (cell !== null && (cell.surface !== surface || cell.frameSceneNum !== view.frameSceneNum || cell.inPortal !== view.inPortal)) cell = cell.next;
    if (cell === null) {
      cell = this.inactive;
      if (cell === null) return;
      this.inactive = cell.next;
      cell.next = this.active;
      this.active = cell;
      cell.surface = surface;
      cell.frameSceneNum = view.frameSceneNum;
      cell.inPortal = view.inPortal;
      cell.addedFrame = -1;
    }
    if (cell.addedFrame !== view.frameCount - 1) {
      cell.visible = false;
      cell.fadeTime = (view.time - 2000) | 0;
    }
    cell.addedFrame = view.frameCount;
    cell.fogNum = fogNum;
    cell.color = { x: f(color.x), y: f(color.y), z: f(color.z) };
    if (normal !== null) cell.color = scale3(cell.color, dot3(normalizeFast3(sub3(view.origin, point)), normal));
    cell.windowX = sourceInteger(f(f(view.viewport.x) + window.x), "RB_AddFlare windowX");
    cell.windowY = sourceInteger(f(f(view.viewport.y) + window.y), "RB_AddFlare windowY");
    cell.eyeZ = eye.z;
  }

  addDlightFlares(lights: readonly DynamicLight[], fogBounds: readonly Bounds[], settings: SourceFlareSettings,
    view: SourceFlareView, model: Mat4): void {
    if (!settings.enabled) return;
    for (const light of lights) {
      let fogNum = 0;
      for (let index = 0; index < fogBounds.length; index++) {
        const bounds = fogBounds[index];
        if (bounds === undefined) throw new RangeError("Missing source fog bounds");
        const point = light.origin;
        if (point.x < bounds.min.x || point.x > bounds.max.x || point.y < bounds.min.y || point.y > bounds.max.y
          || point.z < bounds.min.z || point.z > bounds.max.z) continue;
        fogNum = index + 1;
        break;
      }
      this.addFlare(light, fogNum, light.origin, light.color, null, view, model);
    }
  }

  testFlare(cell: SourceFlare, view: SourceFlareView, settings: SourceFlareSettings, depth: SourceFlareDepth): void {
    this.counters.c_flareTests = (this.counters.c_flareTests + 1) | 0;
    depth.resetFinishCalled();
    const value = f(depth.readDepthPixel(cell.windowX, cell.windowY));
    const screenZ = f(view.projection[14] / f(f(f(f(2 * value) - 1) * view.projection[11]) - view.projection[10]));
    const visible = f(-cell.eyeZ - -screenZ) < 24;
    if (visible !== cell.visible) {
      cell.visible = visible;
      cell.fadeTime = (view.time - 1) | 0;
    }
    let fade = f(f(f((view.time - cell.fadeTime) | 0) / 1000) * settings.fade);
    if (!visible) fade = f(1 - fade);
    if (fade < 0) fade = 0;
    if (fade > 1) fade = 1;
    cell.drawIntensity = fade;
  }

  *renderFlare(cell: SourceFlare, view: SourceFlareView, settings: SourceFlareSettings,
    draw: SourceFlareDraw): Generator<SurfaceViewOperation, void, unknown> {
    this.counters.c_flareRenders = (this.counters.c_flareRenders + 1) | 0;
    const color = scale3(cell.color, f(cell.drawIntensity * draw.identityLight));
    const integerColor = (value: number): number => sourceInteger(f(value * 255), "RB_RenderFlare color");
    const bytes = { x: integerColor(color.x), y: integerColor(color.y), z: integerColor(color.z) };
    const size = f(f(view.viewport.width) * f(f(settings.size / 640) + f(8 / -cell.eyeZ)));
    draw.tess.beginSurface(draw.shader, cell.fogNum, draw.tess.floatTime);
    draw.tess.appendFlare(cell.windowX, cell.windowY, size, bytes);
    yield* draw.endSurface();
  }

  *renderFlares(view: SourceFlareView, settings: SourceFlareSettings, depth: SourceFlareDepth,
    draw: SourceFlareDraw): Generator<SurfaceViewOperation, void, unknown> {
    if (!settings.enabled) return;
    let previous: SourceFlare | null = null, cell = this.active, visible = false;
    while (cell !== null) {
      let remove = cell.addedFrame < view.frameCount - 1;
      if (!remove) {
        cell.drawIntensity = 0;
        if (cell.frameSceneNum === view.frameSceneNum && cell.inPortal === view.inPortal) {
          this.testFlare(cell, view, settings, depth);
          if (cell.drawIntensity !== 0) visible = true;
          else remove = true;
        }
      }
      const next = cell.next;
      if (remove) {
        if (previous === null) this.active = next;
        else previous.next = next;
        cell.next = this.inactive;
        this.inactive = cell;
      } else previous = cell;
      cell = next;
    }
    if (!visible) return;
    if (view.inPortal) yield* draw.disablePortalClip();
    const oldProjector = draw.tess.projector;
    const { x, y, width, height } = view.viewport;
    const scaleX = f(2 / width), scaleY = f(2 / height), scaleZ = f(-2 / 199998);
    const offsetX = f(-(2 * x + width) / width), offsetY = f(-(2 * y + height) / height);
    draw.tess.setProjector(point => ({ x: f(f(point.x * scaleX) + offsetX), y: f(f(point.y * scaleY) + offsetY), z: f(point.z * scaleZ), w: 1 }));
    for (let active = this.active; active !== null; active = active.next) {
      if (active.frameSceneNum === view.frameSceneNum && active.inPortal === view.inPortal && active.drawIntensity !== 0)
        yield* this.renderFlare(active, view, settings, draw);
    }
    draw.tess.setProjector(oldProjector);
  }
}
