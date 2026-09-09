// View calculations and model tools from id Software's code/cgame/cg_view.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, dot3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmAngleVectors, qvmAnglesToAxis } from "../core/qvm-math.ts";
import { copyRefdef, createRefdef, RDF_HYPERSPACE, RDF_NOWORLDMODEL } from "../render/refdef.ts";
import type { Refdef } from "../render/refdef.ts";
import { copyRefEntity, createModelEntity, createSpriteEntity, RF_DEPTHHACK, RF_FIRST_PERSON, RF_MINLIGHT } from "../render/ref-entity.ts";
import type { RefEntity, RefSpriteEntity, SceneModel, SceneShader } from "../render/ref-entity.ts";
import { MoveType, statSchema } from "../shared/definitions.ts";
import { MoveFlags } from "../shared/player-state.ts";
import type { PredictionRuntime } from "./prediction.ts";
import type { ClientGameState } from "./state.ts";

const f32 = Math.fround;
const PI = f32(Math.PI);

export interface ViewSettings {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly viewSize: number;
  readonly thirdPerson: boolean;
  readonly thirdPersonRange: number;
  readonly thirdPersonAngle: number;
  readonly cameraMode: boolean;
  readonly cameraOrbitInteger: number;
  readonly cameraOrbitValue: number;
  readonly cameraOrbitDelay: number;
  readonly errorDecay: number;
  readonly runPitch: number;
  readonly runRoll: number;
  readonly bobPitch: number;
  readonly bobRoll: number;
  readonly bobUp: number;
  readonly fov: number;
  readonly zoomFov: number;
  readonly dmFlags: number;
  readonly gunX: number;
  readonly gunY: number;
  readonly gunZ: number;
}

export interface ViewHost {
  settings(): ViewSettings;
  setViewSize(value: number): void;
  /** Source changes the cached vmCvar value, without setting its console string. */
  setThirdPersonAngleValue(value: number): void;
  registerModel(path: string): Promise<SceneModel>;
  print(message: string): void;
}

function multiplyAdd(origin: Vec3, scale: number, direction: Vec3): Vec3 {
  return add3(origin, scale3(direction, scale));
}

export class ViewRuntime {
  private modelRevision = 0;

  constructor(readonly state: ClientGameState, readonly prediction: Pick<PredictionRuntime, "state" | "trace" | "pointContents">, readonly host: ViewHost) {
    if (prediction.state !== state) throw new Error("View and prediction must share one client state");
  }

  /** Requires a current snapshot and completed prediction; scene population follows this call. */
  calculateViewValues(): boolean {
    const state = this.state, snapshot = state.snap;
    if (snapshot === null) throw new Error("CG_CalcViewValues requires a current snapshot");
    const settings = this.host.settings(), ps = state.predictedPlayerState;
    state.refdef = createRefdef();
    const refdef = state.refdef;
    let size = snapshot.playerState.pmType === MoveType.PM_INTERMISSION ? 100 : settings.viewSize;
    if (size < 30) { this.host.setViewSize(30); size = 30; }
    else if (size > 100) { this.host.setViewSize(100); size = 100; }
    refdef.width = Math.trunc(Math.imul(settings.videoWidth, size) / 100) & ~1;
    refdef.height = Math.trunc(Math.imul(settings.videoHeight, size) / 100) & ~1;
    refdef.x = ((settings.videoWidth - refdef.width) / 2) | 0;
    refdef.y = ((settings.videoHeight - refdef.height) / 2) | 0;
    if (refdef.width <= 0 || refdef.height <= 0) throw new RangeError("Camera view requires a positive viewport");
    state.renderingThirdPerson = settings.thirdPerson || snapshot.playerState.health <= 0;
    refdef.viewOrigin = { ...ps.origin };
    state.refdefViewAngles = { ...ps.viewangles };
    if (ps.pmType === MoveType.PM_INTERMISSION) {
      refdef.viewAxis = qvmAnglesToAxis(state.refdefViewAngles);
      return this.calculateFov(settings);
    }
    state.bobCycle = (ps.bobCycle & 128) >> 7;
    state.bobFracSin = Math.abs(f32(Math.sin(f32(f32((ps.bobCycle & 127) / 127) * PI))));
    state.xyspeed = f32(Math.sqrt(f32(f32(ps.velocity.x * ps.velocity.x) + f32(ps.velocity.y * ps.velocity.y))));
    let thirdPersonAngle = f32(settings.thirdPersonAngle);
    if (settings.cameraOrbitInteger !== 0 && state.time > state.nextOrbitTime) {
      state.nextOrbitTime = (state.time + settings.cameraOrbitDelay) | 0;
      thirdPersonAngle = f32(thirdPersonAngle + f32(settings.cameraOrbitValue));
      this.host.setThirdPersonAngleValue(thirdPersonAngle);
    }
    if (settings.errorDecay > 0) {
      const elapsed = (state.time - state.predictedErrorTime) | 0;
      const factor = f32(f32(f32(settings.errorDecay) - f32(elapsed)) / f32(settings.errorDecay));
      if (factor > 0 && factor < 1) refdef.viewOrigin = multiplyAdd(refdef.viewOrigin, factor, state.predictedError);
      else state.predictedErrorTime = 0;
    }
    if (state.renderingThirdPerson) this.offsetThirdPerson(settings, thirdPersonAngle);
    else this.offsetFirstPerson(settings);
    refdef.viewAxis = qvmAnglesToAxis(state.refdefViewAngles);
    if (state.hyperspace) refdef.renderFlags |= RDF_NOWORLDMODEL | RDF_HYPERSPACE;
    return this.calculateFov(settings);
  }

  /** CG_DrawActiveFrame publishes clock and area visibility after adding scene entities. */
  finishRefdef(): Refdef {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("Finishing the view requires a current snapshot");
    this.state.refdef.time = this.state.time;
    this.state.refdef.areaMask = new Uint8Array(snapshot.areaMask);
    return copyRefdef(this.state.refdef);
  }

  zoomDown(): void {
    if (this.state.zoomed) return;
    this.state.zoomed = true;
    this.state.zoomTime = this.state.time;
  }

  zoomUp(): void {
    if (!this.state.zoomed) return;
    this.state.zoomed = false;
    this.state.zoomTime = this.state.time;
  }

  private offsetThirdPerson(settings: ViewSettings, angle: number): void {
    const state = this.state, refdef = state.refdef, ps = state.predictedPlayerState;
    refdef.viewOrigin = vec3(refdef.viewOrigin.x, refdef.viewOrigin.y, refdef.viewOrigin.z + f32(ps.viewheight));
    let focusAngles = { ...state.refdefViewAngles };
    if (ps.health <= 0) {
      const yaw = ps.stats.get(statSchema(ps.product).deadYaw);
      focusAngles = vec3(focusAngles.x, yaw, focusAngles.z);
      state.refdefViewAngles = vec3(state.refdefViewAngles.x, yaw, state.refdefViewAngles.z);
    }
    if (focusAngles.x > 45) focusAngles = vec3(45, focusAngles.y, focusAngles.z);
    let focusPoint = multiplyAdd(refdef.viewOrigin, 512, qvmAngleVectors(focusAngles).forward);
    let view = vec3(refdef.viewOrigin.x, refdef.viewOrigin.y, refdef.viewOrigin.z + 8);
    state.refdefViewAngles = vec3(f32(state.refdefViewAngles.x * 0.5), state.refdefViewAngles.y, state.refdefViewAngles.z);
    const vectors = qvmAngleVectors(state.refdefViewAngles);
    const radians = f32(f32(angle / 180) * PI);
    view = multiplyAdd(view, f32(-f32(settings.thirdPersonRange) * f32(Math.cos(radians))), vectors.forward);
    view = multiplyAdd(view, f32(-f32(settings.thirdPersonRange) * f32(Math.sin(radians))), vectors.right);
    if (!settings.cameraMode) {
      const bounds = { min: vec3(-4, -4, -4), max: vec3(4, 4, 4) };
      const trace = this.prediction.trace(refdef.viewOrigin, view, bounds, ps.clientNum, 1);
      if (trace.fraction !== 1) {
        view = vec3(trace.end.x, trace.end.y, trace.end.z + f32(f32(1 - trace.fraction) * 32));
        view = this.prediction.trace(refdef.viewOrigin, view, bounds, ps.clientNum, 1).end;
      }
    }
    refdef.viewOrigin = view;
    focusPoint = sub3(focusPoint, view);
    const distance = Math.max(1, f32(Math.sqrt(f32(f32(focusPoint.x * focusPoint.x) + f32(focusPoint.y * focusPoint.y)))));
    // q3lcc folds this quotient before storing its float32 constant.
    state.refdefViewAngles = vec3(f32(f32(-180 / Math.PI) * f32(Math.atan2(focusPoint.z, distance))),
      f32(state.refdefViewAngles.y - angle), state.refdefViewAngles.z);
  }

  private offsetFirstPerson(settings: ViewSettings): void {
    const state = this.state, snapshot = state.snap;
    if (snapshot === null) throw new Error("First-person offset requires a snapshot");
    if (snapshot.playerState.pmType === MoveType.PM_INTERMISSION) return;
    const refdef = state.refdef, ps = state.predictedPlayerState;
    if (snapshot.playerState.health <= 0) {
      state.refdefViewAngles = vec3(-15, snapshot.playerState.stats.get(statSchema(ps.product).deadYaw), 40);
      refdef.viewOrigin = vec3(refdef.viewOrigin.x, refdef.viewOrigin.y, refdef.viewOrigin.z + f32(ps.viewheight));
      return;
    }
    let angles = add3(state.refdefViewAngles, state.kickAngles);
    if (state.damageTime !== 0) {
      let ratio = f32(f32(state.time) - state.damageTime);
      if (ratio < 100) ratio = f32(ratio / 100);
      else ratio = f32(1 - f32(f32(ratio - 100) / 400));
      if (f32(f32(state.time) - state.damageTime) < 100 || ratio > 0) {
        angles = vec3(angles.x + f32(ratio * state.damagePitch), angles.y, angles.z + f32(ratio * state.damageRoll));
      }
    }
    // Source refdef was zeroed before this function; the final view axis is built afterward.
    angles = vec3(angles.x + f32(dot3(ps.velocity, refdef.viewAxis[0]) * f32(settings.runPitch)), angles.y,
      angles.z - f32(dot3(ps.velocity, refdef.viewAxis[1]) * f32(settings.runRoll)));
    const speed = Math.max(state.xyspeed, 200);
    let pitch = f32(f32(state.bobFracSin * f32(settings.bobPitch)) * speed);
    let roll = f32(f32(state.bobFracSin * f32(settings.bobRoll)) * speed);
    if ((ps.pmFlags & MoveFlags.DUCKED) !== 0) { pitch = f32(pitch * 3); roll = f32(roll * 3); }
    if ((state.bobCycle & 1) !== 0) roll = -roll;
    state.refdefViewAngles = vec3(angles.x + pitch, angles.y, angles.z + roll);
    let height = f32(refdef.viewOrigin.z + f32(ps.viewheight));
    const duckDelta = (state.time - state.duckTime) | 0;
    if (duckDelta < 100) height = f32(height - f32(f32(state.duckChange * f32((100 - duckDelta) | 0)) / 100));
    height = f32(height + Math.min(6, f32(f32(state.bobFracSin * state.xyspeed) * f32(settings.bobUp))));
    let landDelta = f32((state.time - state.landTime) | 0);
    if (landDelta < 150) height = f32(height + f32(state.landChange * f32(landDelta / 150)));
    else if (landDelta < 450) {
      landDelta = f32(landDelta - 150);
      height = f32(height + f32(state.landChange * f32(1 - f32(landDelta / 300))));
    }
    const stepDelta = (state.time - state.stepTime) | 0;
    if (stepDelta < 200) height = f32(height - f32(f32(state.stepChange * f32((200 - stepDelta) | 0)) / 200));
    refdef.viewOrigin = add3(vec3(refdef.viewOrigin.x, refdef.viewOrigin.y, height), state.kickOrigin);
  }

  private calculateFov(settings: ViewSettings): boolean {
    const state = this.state, refdef = state.refdef;
    let fov = 90;
    if (state.predictedPlayerState.pmType !== MoveType.PM_INTERMISSION) {
      fov = (settings.dmFlags & 16) !== 0 ? 90 : Math.max(1, Math.min(160, f32(settings.fov)));
      const zoom = Math.max(1, Math.min(160, f32(settings.zoomFov)));
      const fraction = f32(f32((state.time - state.zoomTime) | 0) / 150);
      if (state.zoomed) fov = fraction > 1 ? zoom : f32(fov + f32(fraction * f32(zoom - fov)));
      else if (fraction <= 1) fov = f32(zoom + f32(fraction * f32(fov - zoom)));
    }
    const radians = f32(f32(fov / 360) * PI);
    const tangent = f32(f32(Math.sin(radians)) / f32(Math.cos(radians)));
    const x = f32(f32(refdef.width) / tangent);
    let vertical = f32(f32(f32(Math.atan2(f32(refdef.height), x)) * 360) / PI);
    const inWater = (this.prediction.pointContents(refdef.viewOrigin, -1) & (8 | 16 | 32)) !== 0;
    if (inWater) {
      const phase = f32(f32(f32(f32(f32(state.time) / 1000) * f32(0.4)) * PI) * 2);
      const wave = f32(Math.sin(phase));
      fov = f32(fov + wave);
      vertical = f32(vertical - wave);
    }
    refdef.fovX = fov;
    refdef.fovY = vertical;
    state.zoomSensitivity = state.zoomed ? f32(vertical / 75) : 1;
    return inWater;
  }

  damageBlendBlob(shader: SceneShader | null, ragePro: boolean): RefSpriteEntity | null {
    const state = this.state, elapsed = Math.trunc(f32(f32(state.time) - state.damageTime)) | 0;
    if (state.damageValue === 0 || ragePro || elapsed <= 0 || elapsed >= 500) return null;
    const entity = createSpriteEntity();
    entity.renderFlags = RF_FIRST_PERSON;
    entity.origin = multiplyAdd(state.refdef.viewOrigin, 8, state.refdef.viewAxis[0]);
    entity.origin = multiplyAdd(entity.origin, f32(state.damageX * -8), state.refdef.viewAxis[1]);
    entity.origin = multiplyAdd(entity.origin, f32(state.damageY * 8), state.refdef.viewAxis[2]);
    entity.radius = f32(state.damageValue * 3);
    entity.customShader = shader;
    entity.shaderRGBA = { x: 255, y: 255, z: 255, w: Math.trunc(f32(200 * f32(1 - f32(elapsed / 500)))) & 255 };
    return entity;
  }

  clearTestModel(): void {
    this.modelRevision++;
    this.state.testModelName = "";
    this.state.testModelEntity = createModelEntity();
    this.state.testGun = false;
  }

  async testModel(name: string | null, backLerp: number | null = null): Promise<void> {
    await this.requestTestModel(name, backLerp, false);
  }

  async testGun(name: string | null, backLerp: number | null = null): Promise<void> {
    await this.requestTestModel(name, backLerp, true);
  }

  private async requestTestModel(name: string | null, backLerp: number | null, gun: boolean): Promise<void> {
    const revision = ++this.modelRevision, entity = createModelEntity();
    this.state.testModelEntity = entity;
    if (name !== null) {
      const nul = name.indexOf("\0");
      this.state.testModelName = name.slice(0, nul < 0 ? 63 : Math.min(nul, 63));
      const model = await this.host.registerModel(this.state.testModelName);
      if (revision !== this.modelRevision) return;
      entity.model = model;
      if (backLerp !== null) { entity.backLerp = f32(backLerp); entity.frame = 1; }
      if (model.kind === "default") this.host.print("Can't register model\n");
      else {
        entity.origin = multiplyAdd(this.state.refdef.viewOrigin, 100, this.state.refdef.viewAxis[0]);
        entity.axis = qvmAnglesToAxis(vec3(0, f32(180 + this.state.refdefViewAngles.y), 0));
        this.state.testGun = false;
      }
    }
    if (revision !== this.modelRevision) return;
    if (gun) { this.state.testGun = true; entity.renderFlags = RF_MINLIGHT | RF_DEPTHHACK | RF_FIRST_PERSON; }
  }

  nextModelFrame(): void {
    this.state.testModelEntity.frame = (this.state.testModelEntity.frame + 1) | 0;
    this.host.print(`frame ${this.state.testModelEntity.frame}\n`);
  }

  previousModelFrame(): void {
    this.state.testModelEntity.frame = Math.max(0, (this.state.testModelEntity.frame - 1) | 0);
    this.host.print(`frame ${this.state.testModelEntity.frame}\n`);
  }

  nextModelSkin(): void {
    this.state.testModelEntity.skinNum = (this.state.testModelEntity.skinNum + 1) | 0;
    this.host.print(`skin ${this.state.testModelEntity.skinNum}\n`);
  }

  previousModelSkin(): void {
    this.state.testModelEntity.skinNum = Math.max(0, (this.state.testModelEntity.skinNum - 1) | 0);
    this.host.print(`skin ${this.state.testModelEntity.skinNum}\n`);
  }

  async addTestModel(): Promise<RefEntity | null> {
    const revision = this.modelRevision, entity = this.state.testModelEntity;
    if (entity.model.kind === "default") return null;
    const model = await this.host.registerModel(this.state.testModelName);
    if (revision !== this.modelRevision) return null;
    entity.model = model;
    if (model.kind === "default") { this.host.print("Can't register model\n"); return null; }
    if (this.state.testGun) {
      const refdef = this.state.refdef, settings = this.host.settings();
      entity.axis = [{ ...refdef.viewAxis[0] }, { ...refdef.viewAxis[1] }, { ...refdef.viewAxis[2] }];
      entity.origin = multiplyAdd(refdef.viewOrigin, f32(settings.gunX), refdef.viewAxis[0]);
      entity.origin = multiplyAdd(entity.origin, f32(settings.gunY), refdef.viewAxis[1]);
      entity.origin = multiplyAdd(entity.origin, f32(settings.gunZ), refdef.viewAxis[2]);
    }
    return copyRefEntity(entity);
  }
}
