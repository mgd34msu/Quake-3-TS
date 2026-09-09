// Draw-surface storage from id Software renderer/tr_main.c and tr_scene.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import { SOURCE_BACKEND_RELEASE32 } from "./backend-memory.ts";
import type { SourceBackendMemory } from "./backend-memory.ts";
import type { SourceDrawSortRange } from "./draw-sort.ts";

const MAX_DRAWSURFS = SOURCE_BACKEND_RELEASE32.drawSurfaceCount;
const DRAWSURF_MASK = MAX_DRAWSURFS - 1;

// tr_world.c and tr_scene.c use q_shared.h's ENTITYNUM_WORLD.
export const SOURCE_DRAW_ENTITY_WORLD = 1022;

export function packSourceDrawSort(shader: number, entity: number, fog: number, dlight: number): number {
  return ((shader << 17) | (entity << 7) | (fog << 2) | dlight) >>> 0;
}

export function decomposeSourceDrawSort(sort: number): {
  readonly shader: number; readonly entity: number; readonly fog: number; readonly dlight: number;
} {
  return { shader: (sort >>> 17) & 16383, entity: (sort >>> 7) & 1023, fog: (sort >>> 2) & 31, dlight: sort & 3 };
}

export interface SourceDrawSurfaceRange<Surface> extends SourceDrawSortRange {
  readonly backendMemory: SourceBackendMemory;
  readonly first: number;
  /** The source surface pointer is a typed binding; the raw +4 word is not a native address. */
  readonly pointerRepresentation: "typed-surface-bindings";
  surface(index: number): Surface;
}

/** One backEndData_t draw array. Refdef counters retain their source frame lifetime. */
export class SourceDrawSurfaces<Surface extends object> {
  readonly #surfaces = new Array<Surface | undefined>(MAX_DRAWSURFS);
  #numDrawSurfs = 0;
  #firstSceneDrawSurf = 0;

  constructor(readonly backendMemory: SourceBackendMemory) {}

  get numDrawSurfs(): number { this.backendMemory.assertLive(); return this.#numDrawSurfs; }
  get firstSceneDrawSurf(): number { this.backendMemory.assertLive(); return this.#firstSceneDrawSurf; }

  /** RE_RenderScene restarts at the last successful scene, retaining failed-prefix writes. */
  beginScene(): void {
    this.backendMemory.assertLive();
    this.#numDrawSurfs = this.#firstSceneDrawSurf;
  }

  /** R_AddDrawSurf masks the write, not the later view's contiguous range. */
  add(surface: Surface, shader: number, entity: number, fog: number, dlight: number): void {
    const index = this.#numDrawSurfs & DRAWSURF_MASK;
    this.backendMemory.drawSurfaceData(index).setUint32(0, packSourceDrawSort(shader, entity, fog, dlight), true);
    this.#surfaces[index] = surface;
    this.#numDrawSurfs = (this.#numDrawSurfs + 1) | 0;
  }

  /** R_SortDrawSurfs caps only the count. Crossing the actual array has no typed source profile. */
  viewRange(first: number): SourceDrawSurfaceRange<Surface> {
    this.backendMemory.assertLive();
    const count = (this.#numDrawSurfs - first) | 0;
    const length = Math.min(count, MAX_DRAWSURFS);
    if (!Number.isInteger(first) || first < 0 || length < 0 || first + length > MAX_DRAWSURFS) {
      throw new RangeError("R_SortDrawSurfs: contiguous source range exceeds the draw-surface allocation");
    }
    const slot = (index: number): number => {
      this.backendMemory.assertLive();
      if (!Number.isInteger(index) || index < 0 || index >= length)
        throw new RangeError("Source draw-surface index is outside the captured range");
      return first + index;
    };
    const surface = (index: number): Surface => {
      const value = this.#surfaces[slot(index)];
      if (value === undefined) throw new Error("Source draw-surface slot has no typed surface binding");
      return value;
    };
    return Object.freeze({
      backendMemory: this.backendMemory, first, length, pointerRepresentation: "typed-surface-bindings",
      surface,
      getSort: (index: number): number => this.backendMemory.drawSurfaceData(slot(index)).getUint32(0, true),
      setSort: (index: number, sort: number): void => { this.backendMemory.drawSurfaceData(slot(index)).setUint32(0, sort, true); },
      swap: (firstIndex: number, secondIndex: number): void => {
        const firstSlot = slot(firstIndex), secondSlot = slot(secondIndex);
        const firstSurface = surface(firstIndex), secondSurface = surface(secondIndex);
        const firstData = this.backendMemory.drawSurfaceData(firstSlot), secondData = this.backendMemory.drawSurfaceData(secondSlot);
        const sort = firstData.getUint32(0, true), pointerWord = firstData.getUint32(4, true);
        firstData.setUint32(0, secondData.getUint32(0, true), true);
        firstData.setUint32(4, secondData.getUint32(4, true), true);
        secondData.setUint32(0, sort, true);
        secondData.setUint32(4, pointerWord, true);
        this.#surfaces[firstSlot] = secondSurface;
        this.#surfaces[secondSlot] = firstSurface;
      },
    } satisfies SourceDrawSurfaceRange<Surface>);
  }

  /** RE_ClearScene does not reach this watermark. */
  completeScene(): void {
    this.backendMemory.assertLive();
    this.#firstSceneDrawSurf = this.#numDrawSurfs;
  }

  /** R_ToggleSmpFrame retains allocation pointers for FixRenderCommandList's stale-tail scan. */
  rolloverFrame(): void {
    this.backendMemory.assertLive();
    this.#numDrawSurfs = 0;
    this.#firstSceneDrawSurf = 0;
  }
}
