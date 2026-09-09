// CG_Draw3DModel/DrawHead/DrawFlagModel/DrawTeamBackground from code/cgame/cg_draw.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, vec3 } from "../core/math.ts";
import { qvmAnglesToAxis } from "../core/qvm-math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import type { Rect2D } from "../render/draw2d.ts";
import type { RenderCommandBuffer } from "../render/commands.ts";
import { modelBounds } from "../render/model-bounds.ts";
import { createModelEntity, RF_NOSHADOW } from "../render/ref-entity.ts";
import type { SceneModel, SceneSkin } from "../render/ref-entity.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../render/refdef.ts";
import { Powerup, Team } from "../shared/definitions.ts";
import { findItemForPowerup, itemList } from "../shared/items.ts";
import type { ClientDrawTools } from "./draw-tools.ts";
import type { ClientGameState } from "./state.ts";

export interface ClientDrawIconSettings { readonly drawIcons: boolean; readonly draw3dIcons: boolean }
const f = Math.fround;

function iconOrigin(bounds: Bounds, fraction: number): Vec3 {
  const length = f(f(fraction) * f(bounds.max.z - bounds.min.z));
  return vec3(f(length / f(0.268)), f(0.5 * f(bounds.min.y + bounds.max.y)), f(-0.5 * f(bounds.min.z + bounds.max.z)));
}

export class ClientDrawIcons {
  constructor(readonly state: ClientGameState, readonly tools: ClientDrawTools,
    private readonly settings: () => ClientDrawIconSettings, readonly commands: RenderCommandBuffer) {
    if (tools.draw.commands !== commands) throw new Error("Draw icons and command buffer must share the engine drawing queue");
    if (state.product !== tools.media.product) throw new Error("Draw icons and media products differ");
  }

  draw3DModel(rect: Rect2D, model: SceneModel, skin: SceneSkin | null, origin: Vec3, angles: Vec3): void {
    const settings = this.settings();
    if (!settings.draw3dIcons || !settings.drawIcons) return;
    const viewport = this.tools.adjustFrom640(rect), refdef = createRefdef(), entity = createModelEntity(model);
    entity.axis = qvmAnglesToAxis(angles); entity.origin = vec3(origin.x, origin.y, origin.z); entity.customSkin = skin; entity.renderFlags = RF_NOSHADOW;
    refdef.renderFlags = RDF_NOWORLDMODEL; refdef.viewAxis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    refdef.fovX = 30; refdef.fovY = 30; refdef.time = this.state.time;
    refdef.x = Math.trunc(viewport.x); refdef.y = Math.trunc(viewport.y); refdef.width = Math.trunc(viewport.width); refdef.height = Math.trunc(viewport.height);
    // ClearScene starts an empty scene without discarding previously queued draw commands.
    const scene = this.tools.media.resources;
    scene.clearScene();
    scene.addRefEntity(entity);
    scene.renderScene(refdef);
  }

  drawHead(rect: Rect2D, clientNum: number, headAngles: Vec3): void {
    const client = this.tools.media.staticState.clientInfo[clientNum];
    if (client === undefined) throw new RangeError("CG_DrawHead: invalid client number");
    const settings = this.settings();
    if (settings.draw3dIcons) {
      if (client.headModel.kind === "default") return;
      const origin = add3(iconOrigin(modelBounds(client.headModel), 0.7), client.headOffset);
      this.draw3DModel(rect, client.headModel, client.headSkin, origin, headAngles);
    } else if (settings.drawIcons) this.tools.drawPic(rect, client.modelIcon);
    if (client.deferred) this.tools.drawPic(rect, this.tools.media.graphics.deferShader);
  }

  drawFlagModel(rect: Rect2D, team: number, force2D: boolean): void {
    const settings = this.settings(), media = this.tools.media;
    if (!force2D && settings.draw3dIcons) {
      const origin = iconOrigin(modelBounds(media.graphics.redFlagModel), 0.5);
      const angles = vec3(0, f(60 * f(Math.sin(f(f(this.state.time) / 2000)))), 0);
      let model: SceneModel;
      if (team === Team.TEAM_RED) model = media.graphics.redFlagModel;
      else if (team === Team.TEAM_BLUE) model = media.graphics.blueFlagModel;
      else if (team === Team.TEAM_FREE) model = media.graphics.neutralFlagModel;
      else return;
      this.draw3DModel(rect, model, null, origin, angles);
    } else if (settings.drawIcons) {
      let powerup: Powerup;
      if (team === Team.TEAM_RED) powerup = Powerup.PW_REDFLAG;
      else if (team === Team.TEAM_BLUE) powerup = Powerup.PW_BLUEFLAG;
      else if (team === Team.TEAM_FREE) powerup = Powerup.PW_NEUTRALFLAG;
      else return;
      const item = findItemForPowerup(media.product, powerup);
      if (item !== null) {
        const index = itemList(media.product).indexOf(item), visual = media.weaponRegistry.items[index];
        if (visual === undefined) throw new Error("Flag item has no cgame visual slot");
        this.tools.drawPic(rect, visual.icon);
      }
    }
  }

  drawTeamBackground(rect: Rect2D, alpha: number, team: number): void {
    if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return;
    this.tools.draw.setColor({ x: team === Team.TEAM_RED ? 1 : 0, y: 0, z: team === Team.TEAM_BLUE ? 1 : 0, w: f(alpha) });
    this.tools.drawPic({ x: Math.trunc(rect.x), y: Math.trunc(rect.y), width: Math.trunc(rect.width), height: Math.trunc(rect.height) }, this.tools.media.graphics.teamStatusBar);
    this.tools.draw.setColor(null);
  }
}
