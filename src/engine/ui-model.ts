// Item_Model_Paint from id Software's code/ui/ui_shared.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import { qvmAnglesToAxis } from "../core/qvm-math.ts";
import type { RenderCommandBuffer } from "../render/commands.ts";
import { modelBounds } from "../render/model-bounds.ts";
import { createModelEntity, RF_LIGHTING_ORIGIN, RF_NOSHADOW } from "../render/ref-entity.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../render/refdef.ts";
import type { RendererResources } from "../render/world.ts";
import type { UiModelPaintRequest } from "../ui/runtime.ts";

const f = Math.fround;

export class EngineUiModelPainter {
  constructor(readonly resources: RendererResources, readonly commands: RenderCommandBuffer) {}

  paint(request: UiModelPaintRequest): void {
    if (request.draw.commands !== this.commands) throw new Error("UI model painter and command buffer must share the engine drawing queue");
    const viewport = request.draw.adjust(request.rect), refdef = createRefdef();
    refdef.renderFlags = RDF_NOWORLDMODEL;
    refdef.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    refdef.x = Math.trunc(viewport.x); refdef.y = Math.trunc(viewport.y);
    refdef.width = Math.trunc(viewport.width); refdef.height = Math.trunc(viewport.height);
    refdef.fovX = request.fieldOfViewX !== 0 ? f(request.fieldOfViewX) : viewport.width;
    refdef.fovY = request.fieldOfViewY !== 0 ? f(request.fieldOfViewY) : viewport.height;
    refdef.time = request.time | 0;
    const bounds = modelBounds(request.model), entity = createModelEntity(request.model);
    const length = f(0.5 * f(bounds.max.z - bounds.min.z));
    entity.origin = vec3(f(length / f(0.268)), f(0.5 * f(bounds.min.y + bounds.max.y)), f(-0.5 * f(bounds.min.z + bounds.max.z)));
    entity.lightingOrigin = { ...entity.origin };
    entity.oldOrigin = { ...entity.origin };
    entity.axis = qvmAnglesToAxis(vec3(0, request.angle, 0));
    entity.renderFlags = RF_LIGHTING_ORIGIN | RF_NOSHADOW;
    this.resources.clearScene();
    this.resources.addRefEntity(entity);
    this.resources.renderScene(refdef);
  }
}
