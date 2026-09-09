/*
 * Renderer resource and picture traps from Quake III Arena cl_ui.c/cl_cgame.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { Vec3 } from "../core/math.ts";
import type { RenderCommandBuffer } from "../render/commands.ts";
import { modelBounds } from "../render/model-bounds.ts";
import { lerpModelTag } from "../render/model-tags.ts";
import { md3TagCount } from "../render/md3-resource.ts";
import type { RendererResources } from "../render/world.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_ORIENTATION_BYTES, writeQvmOrientation } from "./render-record.ts";

interface ResourceTraps {
  readonly model: number;
  readonly skin: number;
  readonly shader: number | null;
  readonly shaderNoMip: number;
  readonly color: number;
  readonly picture: number;
  readonly bounds: number;
  readonly tag: number;
  readonly remap: number;
}
const ui: ResourceTraps = { model: 18, skin: 19, shader: null, shaderNoMip: 20,
  color: 26, picture: 27, bounds: 56, tag: 29, remap: 80 };
const cgame: ResourceTraps = { model: 37, skin: 38, shader: 39, shaderNoMip: 57,
  color: 45, picture: 46, bounds: 47, tag: 48, remap: 79 };

function writeVector(view: DataView, value: Vec3): void {
  view.setFloat32(0, value.x, true); view.setFloat32(4, value.y, true); view.setFloat32(8, value.z, true);
}

/** Resource/2D subset. Scene, screen and configuration traps remain separate. */
export function qvmRenderResourceSyscall(
  role: "game" | "cgame" | "ui", words: DataView, memory: QvmMemory,
  resources: RendererResources, commands: RenderCommandBuffer,
): number | Promise<number> | null {
  if (role === "game") return null;
  const trap = words.getInt32(0, true), ids = role === "ui" ? ui : cgame;
  if (trap === ids.model) {
    const nameWord = words.getInt32(4, true);
    return resources.registerModel(nameWord === 0 ? "" : memory.readString(nameWord)).then(model => resources.modelHandle(model));
  }
  if (trap === ids.skin) {
    const nameWord = words.getInt32(4, true);
    return resources.registerSkin(nameWord === 0 ? "" : memory.readString(nameWord)).then(skin => resources.skinHandle(skin));
  }
  if (trap === ids.shader || trap === ids.shaderNoMip) {
    const name = memory.readString(words.getInt32(4, true));
    const pending = trap === ids.shader ? resources.registerShader(name) : resources.registerShaderNoMip(name);
    return pending.then(shader => resources.shaderHandle(shader));
  }
  if (trap === ids.color) {
    const word = words.getInt32(4, true);
    if (word === 0) commands.setColor(null);
    else {
      const color = memory.view(word, 16);
      commands.setColor({ x: color.getFloat32(0, true), y: color.getFloat32(4, true),
        z: color.getFloat32(8, true), w: color.getFloat32(12, true) });
    }
    return 0;
  }
  if (trap === ids.picture) {
    const rect = { x: words.getFloat32(4, true), y: words.getFloat32(8, true),
      width: words.getFloat32(12, true), height: words.getFloat32(16, true) };
    const uv = { s: words.getFloat32(20, true), t: words.getFloat32(24, true),
      s2: words.getFloat32(28, true), t2: words.getFloat32(32, true) };
    const shaderWord = words.getInt32(36, true);
    commands.stretchPixels(rect, uv, () => resources.picture(resources.shaderForHandle(shaderWord)));
    return 0;
  }
  if (trap === ids.bounds) {
    const modelWord = words.getInt32(4, true);
    const min = memory.view(words.getInt32(8, true), 12), max = memory.view(words.getInt32(12, true), 12);
    const bounds = modelBounds(resources.modelForHandle(modelWord));
    writeVector(min, bounds.min); writeVector(max, bounds.max);
    return 0;
  }
  if (trap === ids.tag) {
    const destination = memory.view(words.getInt32(4, true), QVM_ORIENTATION_BYTES);
    const modelWord = words.getInt32(8, true), start = words.getInt32(12, true), end = words.getInt32(16, true);
    const fraction = words.getFloat32(20, true), nameWord = words.getInt32(24, true);
    const model = resources.modelForHandle(modelWord);
    const base = model.kind === "default" || model.kind === "inline" ? null : model.md3[0];
    // R_LerpTag/R_GetTag do not consume tagName when no tag storage exists.
    const tag = base === null || md3TagCount(base) <= 0 ? null
      : lerpModelTag(model, memory.readString(nameWord), start, end, fraction);
    if (tag === null) writeQvmOrientation(destination, { origin: { x: 0, y: 0, z: 0 },
      axes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] });
    else writeQvmOrientation(destination, tag);
    // UI's switch discards LerpTag's result; cgame returns it.
    return role === "ui" || tag === null ? 0 : 1;
  }
  if (trap === ids.remap) {
    const original = memory.readString(words.getInt32(4, true)), replacement = memory.readString(words.getInt32(8, true));
    const offsetWord = words.getInt32(12, true), offset = offsetWord === 0 ? null : memory.readString(offsetWord);
    return resources.remapShader(original, replacement, offset).then(() => 0);
  }
  return null;
}
