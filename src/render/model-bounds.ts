// R_ModelBounds from id Software's code/renderer/tr_model.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Bounds } from "../core/math.ts";
import type { SceneModel } from "./ref-entity.ts";
import { md3FrameAt } from "./md3-resource.ts";

export function modelBounds(model: SceneModel): Bounds {
  switch (model.kind) {
    case "default": return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    case "md3": case "md4": case "bad": {
      const base = model.md3[0];
      if (base === null) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
      const frame = md3FrameAt(base, 0);
      return { min: { ...frame.bounds.min }, max: { ...frame.bounds.max } };
    }
    case "inline": {
      const inline = model.map.models[model.index];
      if (inline === undefined) throw new RangeError("Inline model index is outside its BSP");
      return { min: { ...inline.bounds.min }, max: { ...inline.bounds.max } };
    }
    default: { const exhaustive: never = model; return exhaustive; }
  }
}
