// R_LerpTag from id Software's code/renderer/tr_model.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { md3LerpTag } from "./md3-resource.ts";
import type { Md3Tag } from "../assets/md3.ts";
import type { SceneModel } from "./ref-entity.ts";

/** Tag storage is independent of the model's final renderer dispatch type. */
export function lerpModelTag(model: SceneModel, name: string, startFrame: number, endFrame: number, fraction: number): Md3Tag | null {
  if (model.kind === "default" || model.kind === "inline") return null;
  const base = model.md3[0];
  return base === null ? null : md3LerpTag(base, name, startFrame, endFrame, fraction);
}
