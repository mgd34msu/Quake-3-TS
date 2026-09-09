// UI/cgame CIN_* trap profiles, id Software code/ui/ui_main.c and cgame/cg_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import { EngineCinematics, cinematicPixelRect, type EngineCinematicHandle } from "./cinematics.ts";
import type { Draw2D } from "../render/draw2d.ts";
import type { UiRect } from "../ui/menu.ts";
import type { UiCinematicAsset, UiCinematicInstance, UiRuntimeCinematics } from "../ui/runtime.ts";

class CinematicInstance implements UiCinematicInstance {
  constructor(readonly asset: UiCinematicAsset, readonly handle: EngineCinematicHandle) { Object.freeze(this); }
}
export type EngineUiCinematicInstance = CinematicInstance;

/** Profile only: the engine owner outlives this UI/cgame adapter and every level. */
export class EngineUiCinematics implements UiRuntimeCinematics {
  constructor(readonly owner: EngineCinematics, readonly profile: "ui" | "cgame") {}

  play(asset: UiCinematicAsset, rect: UiRect): EngineUiCinematicInstance | undefined {
    const handle = this.owner.playNonSystem(asset, rect, {
      looping: true, holdAtEnd: false, silent: this.profile === "ui", shader: false,
    });
    return handle === undefined ? undefined : new CinematicInstance(asset, handle);
  }

  run(index: number, _time: number): void {
    const handle = this.owner.handleAtSlot(index);
    if (handle !== undefined) this.owner.run(handle);
  }

  draw(index: number, rect: UiRect, draw: Draw2D): void {
    const handle = this.owner.handleAtSlot(index);
    if (handle === undefined) return;
    this.owner.setExtents(handle, rect);
    const call = this.owner.prepareUiRaw(handle);
    if (call === null) return;
    const sourceRect = { x: Math.trunc(rect.x), y: Math.trunc(rect.y), width: Math.trunc(rect.width), height: Math.trunc(rect.height) };
    draw.stretchRawPixels(cinematicPixelRect(sourceRect, draw.width, draw.height), call);
  }

  stop(index: number): void { this.owner.stopSlot(index); }
}
