// Packet entity presentation from id Software's code/cgame/cg_ents.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { lerpModelTag } from "../render/model-tags.ts";
import type { PcmSound } from "../assets/wav.ts";
import { CommonError } from "../core/common-error.ts";
import { add3, cross3, dot3, length3, normalize3OrZero, perpendicularVector, scale3, sub3, vec3, vec4 } from "../core/math.ts";
import type { Axis, Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { qvmAnglesToAxis, qvmRotatePointAroundVector } from "../core/qvm-math.ts";
import type { DynamicLight } from "../render/lighting.ts";
import { createBeamEntity, createModelEntity, createPortalEntity, createSpriteEntity, RF_MINLIGHT, RF_THIRD_PERSON, RF_NOSHADOW } from "../render/ref-entity.ts";
import type { RefEntity, RefModelEntity, SceneModel, SceneShader, SceneSkin } from "../render/ref-entity.ts";
import { EntityType, GameType, Holdable, ItemType, Team, Weapon } from "../shared/definitions.ts";
import { byteToDirection } from "../shared/direction-byte.ts";
import type { EntityState } from "../shared/entity-state.ts";
import { itemAt, itemList } from "../shared/items.ts";
import { playerStateToEntityState } from "../shared/snapshot-state.ts";
import { evaluateTrajectory, evaluateTrajectoryDelta, TrajectoryType } from "../shared/trajectory.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";

const f = Math.fround;
const SOLID_BMODEL = 0xffffff;
const CHAN_ITEM = 4, CHAN_BODY = 5;

export type MissileTrail = "rocket" | "grenade" | "grapple" | "nail" | "plasma";

/** The cg_weapons registration owner supplies these already-loaded resources. */
export interface PacketWeaponInfo {
  readonly weaponModel: SceneModel;
  readonly weaponMidpoint: Vec3;
  readonly barrelModel: SceneModel | null;
  readonly missileModel: SceneModel;
  readonly missileRenderfx: number;
  readonly missileSound: PcmSound | null;
  readonly missileDlight: number;
  readonly missileDlightColor: Vec3;
  readonly missileTrail: MissileTrail | null;
  readonly trailRadius: number;
  readonly trailTime: number;
}

export interface PacketItemVisual {
  readonly models: readonly [SceneModel, SceneModel | null];
  readonly icon: SceneShader | null;
}

export interface PacketMissionMedia {
  readonly weaponHoverSound: PcmSound | null;
  readonly blueProxMine: SceneModel;
  readonly overloadBaseModel: SceneModel;
  readonly overloadEnergyModel: SceneModel;
  readonly overloadLightsModel: SceneModel;
  readonly overloadTargetModel: SceneModel;
  readonly obeliskRespawnSound: PcmSound | null;
  readonly harvesterModel: SceneModel;
  readonly harvesterNeutralModel: SceneModel;
  readonly harvesterRedSkin: SceneSkin | null;
  readonly harvesterBlueSkin: SceneSkin | null;
}

export interface PacketEntityMedia {
  readonly gameModels: readonly SceneModel[];
  readonly gameSounds: readonly (PcmSound | null)[];
  readonly inlineModels: readonly { readonly model: SceneModel; readonly midpoint: Vec3 }[];
  readonly items: readonly PacketItemVisual[];
  readonly weapons: readonly PacketWeaponInfo[];
  readonly plasmaBallShader: SceneShader | null;
  readonly redFlagBaseModel: SceneModel;
  readonly blueFlagBaseModel: SceneModel;
  readonly neutralFlagBaseModel: SceneModel;
  readonly variant: { readonly product: "baseq3" } | { readonly product: "missionpack"; readonly media: PacketMissionMedia };
}

/** Real renderer/audio traps and separately-owned cg_players/cg_weapons effects. */
export interface PacketEntityImports {
  addRefEntity(entity: RefEntity): void;
  addLight(light: DynamicLight): void;
  updateSoundPosition(entity: number, origin: Vec3): void;
  addLoopSound(entity: number, origin: Vec3, velocity: Vec3, sound: PcmSound | null, realLoop: boolean): void;
  startSound(origin: Vec3 | null, entity: number, channel: number, sound: PcmSound | null): void;
  /** The shared cgame rand(), not Q_random: bg_lib uses low 15 bits. */
  randomInteger(): number;
  player(entity: ClientEntity): void;
  missileTrail(kind: MissileTrail, entity: ClientEntity, weapon: PacketWeaponInfo): void;
  grappleTrail(entity: ClientEntity, weapon: PacketWeaponInfo): void;
  addEntityWithPowerups(entity: RefModelEntity, state: EntityState, team: Team): void;
}

export interface PacketEntityOptions {
  readonly gameType: GameType;
  readonly smoothClients: boolean;
  readonly simpleItems: boolean;
  readonly obeliskRespawnDelay: number;
}

function indexed<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`${name} index ${index} is not registered`);
  return value;
}

function identityAxis(): Axis { return [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]; }
function scaleAxis(axis: Axis, scale: number): Axis { return [scale3(axis[0], scale), scale3(axis[1], scale), scale3(axis[2], scale)]; }
function multiplyAxis(left: Axis, right: Axis): Axis {
  const x = vec3(right[0].x, right[1].x, right[2].x);
  const y = vec3(right[0].y, right[1].y, right[2].y);
  const z = vec3(right[0].z, right[1].z, right[2].z);
  const row = (value: Vec3): Vec3 => vec3(dot3(value, x), dot3(value, y), dot3(value, z));
  return [row(left[0]), row(left[1]), row(left[2])];
}

function tagOrientation(parent: RefModelEntity, model: SceneModel, name: string): { readonly origin: Vec3; readonly axis: Axis } {
  const tag = lerpModelTag(model, name, parent.oldFrame, parent.frame, f(1 - parent.backLerp));
  // R_LerpTag clears the orientation on a missing tag or non-MD3 handle.
  return tag === null ? { origin: vec3(0, 0, 0), axis: identityAxis() } : { origin: tag.origin, axis: tag.axes };
}

function tagOrigin(parent: RefModelEntity, tag: Vec3): Vec3 {
  let origin = add3(parent.origin, scale3(parent.axis[0], tag.x));
  origin = add3(origin, scale3(parent.axis[1], tag.y));
  return add3(origin, scale3(parent.axis[2], tag.z));
}

export function positionEntityOnTag(entity: RefModelEntity, parent: RefModelEntity, parentModel: SceneModel, tagName: string): void {
  const tag = tagOrientation(parent, parentModel, tagName);
  entity.origin = tagOrigin(parent, tag.origin);
  entity.axis = multiplyAxis(tag.axis, parent.axis);
  entity.backLerp = parent.backLerp;
}

export function positionRotatedEntityOnTag(entity: RefModelEntity, parent: RefModelEntity, parentModel: SceneModel, tagName: string): void {
  const tag = tagOrientation(parent, parentModel, tagName);
  entity.origin = tagOrigin(parent, tag.origin);
  entity.axis = multiplyAxis(multiplyAxis(entity.axis, tag.axis), parent.axis);
}

export function adjustPositionForMover(state: ClientGameState, input: Vec3, moverNum: number, fromTime: number, toTime: number): Vec3 {
  if (moverNum <= 0 || moverNum >= 1022) return vec3(input.x, input.y, input.z);
  const mover = state.entityAt(moverNum).currentState;
  if (mover.eType !== EntityType.ET_MOVER) return vec3(input.x, input.y, input.z);
  const oldOrigin = evaluateTrajectory(mover.pos, fromTime);
  evaluateTrajectory(mover.apos, fromTime);
  const origin = evaluateTrajectory(mover.pos, toTime);
  evaluateTrajectory(mover.apos, toTime);
  // The baseline computes angular deltas but only applies translation (its FIXME).
  return add3(input, sub3(origin, oldOrigin));
}

function lerpAngle(from: number, to: number, fraction: number): number {
  if (f(to - from) > 180) to = f(to - 360);
  if (f(to - from) < -180) to = f(to + 360);
  return f(from + f(fraction * f(to - from)));
}

function interpolate(from: Vec3, to: Vec3, fraction: number): Vec3 {
  return add3(from, scale3(sub3(to, from), fraction));
}

function directionAxis(direction: Vec3, yaw: number): Axis {
  let side = perpendicularVector(direction);
  if (yaw !== 0) side = qvmRotatePointAroundVector(direction, side, f(yaw));
  return [direction, side, cross3(direction, side)];
}

function missileDirection(delta: Vec3): Vec3 {
  const length = length3(delta);
  const direction = normalize3OrZero(delta);
  return length === 0 ? vec3(0, 0, 1) : direction;
}

export class PacketEntityPresenter {
  constructor(readonly state: ClientGameState, readonly media: PacketEntityMedia, readonly imports: PacketEntityImports) {
    if (state.product !== media.variant.product) throw new Error("packet entity media product differs from cgame state");
  }

  setEntitySoundPosition(entity: ClientEntity): void {
    const current = entity.currentState;
    const origin = current.solid === SOLID_BMODEL
      ? add3(entity.lerpOrigin, indexed(this.media.inlineModels, current.modelindex, "inline model").midpoint)
      : entity.lerpOrigin;
    this.imports.updateSoundPosition(current.number, origin);
  }

  calculateLerpPositions(entity: ClientEntity, smoothClients: boolean): void {
    const state = this.state, snap = state.snap;
    if (snap === null) throw new Error("CG_CalcEntityLerpPositions: cg.snap == NULL");
    const current = entity.currentState;
    if (!smoothClients && current.number < 64) {
      current.pos = { ...current.pos, type: TrajectoryType.TR_INTERPOLATE };
      entity.nextState.pos = { ...entity.nextState.pos, type: TrajectoryType.TR_INTERPOLATE };
    }
    if (entity.interpolate && (current.pos.type === TrajectoryType.TR_INTERPOLATE || (current.pos.type === TrajectoryType.TR_LINEAR_STOP && current.number < 64))) {
      const next = state.nextSnap;
      if (next === null) throw new CommonError("drop", "CG_InterpoateEntityPosition: cg.nextSnap == NULL");
      entity.lerpOrigin = interpolate(evaluateTrajectory(current.pos, snap.serverTime), evaluateTrajectory(entity.nextState.pos, next.serverTime), state.frameInterpolation);
      const a = evaluateTrajectory(current.apos, snap.serverTime), b = evaluateTrajectory(entity.nextState.apos, next.serverTime);
      entity.lerpAngles = vec3(lerpAngle(a.x, b.x, state.frameInterpolation), lerpAngle(a.y, b.y, state.frameInterpolation), lerpAngle(a.z, b.z, state.frameInterpolation));
      return;
    }
    entity.lerpOrigin = evaluateTrajectory(current.pos, state.time);
    entity.lerpAngles = evaluateTrajectory(current.apos, state.time);
    if (entity !== state.predictedPlayerEntity) entity.lerpOrigin = adjustPositionForMover(state, entity.lerpOrigin, current.groundEntityNum, snap.serverTime, state.time);
  }

  private effects(entity: ClientEntity): void {
    this.setEntitySoundPosition(entity);
    const current = entity.currentState;
    if (current.loopSound !== 0) this.imports.addLoopSound(current.number, entity.lerpOrigin, vec3(0, 0, 0), indexed(this.media.gameSounds, current.loopSound, "sound"), current.eType === EntityType.ET_SPEAKER);
    if (current.constantLight !== 0) {
      const light = current.constantLight;
      this.imports.addLight({ origin: entity.lerpOrigin, radius: ((light >> 24) & 255) * 4, color: vec3(light & 255, (light >> 8) & 255, (light >> 16) & 255) });
    }
  }

  private general(entity: ClientEntity): void {
    const current = entity.currentState;
    if (current.modelindex === 0) return;
    const ref = createModelEntity(indexed(this.media.gameModels, current.modelindex, "game model"));
    ref.frame = current.frame; ref.oldFrame = current.frame;
    ref.origin = entity.lerpOrigin; ref.oldOrigin = entity.lerpOrigin;
    if (this.state.snap !== null && current.number === this.state.snap.playerState.clientNum) ref.renderFlags |= RF_THIRD_PERSON;
    ref.axis = qvmAnglesToAxis(entity.lerpAngles);
    this.imports.addRefEntity(ref);
  }

  private speaker(entity: ClientEntity): void {
    const current = entity.currentState;
    if (current.clientNum === 0 || this.state.time < entity.miscTime) return;
    this.imports.startSound(null, current.number, CHAN_ITEM, indexed(this.media.gameSounds, current.eventParm, "sound"));
    const random = f((this.imports.randomInteger() & 0x7fff) / 0x7fff);
    const crandom = f(2 * f(random - 0.5));
    entity.miscTime = qvmFloatToInt(f(f((this.state.time + Math.imul(current.frame, 100)) | 0) + f(f(Math.imul(current.clientNum, 100)) * crandom)));
  }

  private item(entity: ClientEntity, options: PacketEntityOptions): void {
    const current = entity.currentState;
    if (current.modelindex >= itemList(this.state.product).length) throw new CommonError("drop", `Bad item index ${current.modelindex} on entity`);
    if (current.modelindex === 0 || (current.eFlags & 0x80) !== 0) return;
    const item = itemAt(this.state.product, current.modelindex);
    const visual = indexed(this.media.items, current.modelindex, "item visual");
    if (options.simpleItems && item.type !== ItemType.IT_TEAM) {
      const ref = createSpriteEntity();
      ref.origin = entity.lerpOrigin; ref.radius = 14; ref.customShader = visual.icon; ref.shaderRGBA = vec4(255, 255, 255, 255);
      this.imports.addRefEntity(ref);
      return;
    }
    const scale = f(f(0.005) + f(f(current.number) * f(0.00001)));
    const bob = f(4 + f(f(Math.cos(f(f((this.state.time + 1000) | 0) * scale))) * 4));
    entity.lerpOrigin = add3(entity.lerpOrigin, vec3(0, 0, bob));
    const ref = createModelEntity(visual.models[0]);
    const fast = item.type === ItemType.IT_HEALTH;
    entity.lerpAngles = fast ? this.state.autoAnglesFast : this.state.autoAngles;
    ref.axis = fast ? this.state.autoAxisFast : this.state.autoAxis;
    const weapon = item.type === ItemType.IT_WEAPON ? indexed(this.media.weapons, item.tag, "weapon") : null;
    if (weapon !== null) {
      const midpoint = weapon.weaponMidpoint;
      const offset = add3(add3(scale3(ref.axis[0], midpoint.x), scale3(ref.axis[1], midpoint.y)), scale3(ref.axis[2], midpoint.z));
      entity.lerpOrigin = add3(sub3(entity.lerpOrigin, offset), vec3(0, 0, 8));
    }
    ref.origin = entity.lerpOrigin; ref.oldOrigin = entity.lerpOrigin;
    const msec = (this.state.time - entity.miscTime) | 0;
    let fraction = 1;
    if (msec >= 0 && msec < 1000) {
      fraction = f(f(msec) / 1000);
      ref.axis = scaleAxis(ref.axis, fraction); ref.nonNormalizedAxes = true;
    }
    if (item.type === ItemType.IT_WEAPON || item.type === ItemType.IT_ARMOR) ref.renderFlags |= RF_MINLIGHT;
    if (item.type === ItemType.IT_WEAPON) {
      ref.axis = scaleAxis(ref.axis, 1.5); ref.nonNormalizedAxes = true;
      if (this.media.variant.product === "missionpack") this.imports.addLoopSound(current.number, entity.lerpOrigin, vec3(0, 0, 0), this.media.variant.media.weaponHoverSound, false);
    }
    if (this.media.variant.product === "missionpack" && item.type === ItemType.IT_HOLDABLE && item.tag === Holdable.HI_KAMIKAZE) {
      ref.axis = scaleAxis(ref.axis, 2); ref.nonNormalizedAxes = true;
    }
    this.imports.addRefEntity({ ...ref });
    if (this.media.variant.product === "missionpack" && weapon !== null && weapon.barrelModel !== null && weapon.barrelModel.kind !== "default") {
      const barrel = createModelEntity(weapon.barrelModel);
      barrel.lightingOrigin = ref.lightingOrigin; barrel.shadowPlane = ref.shadowPlane; barrel.renderFlags = ref.renderFlags;
      positionRotatedEntityOnTag(barrel, ref, weapon.weaponModel, "tag_barrel");
      barrel.axis = ref.axis; barrel.nonNormalizedAxes = ref.nonNormalizedAxes;
      this.imports.addRefEntity(barrel);
    }
    if (!options.simpleItems && (item.type === ItemType.IT_HEALTH || item.type === ItemType.IT_POWERUP) && visual.models[1] !== null && visual.models[1].kind !== "default") {
      ref.model = visual.models[1];
      let yaw = 0;
      if (item.type === ItemType.IT_POWERUP) {
        ref.origin = add3(ref.origin, vec3(0, 0, 12));
        yaw = f(((this.state.time & 1023) * 360) / -1024);
      }
      ref.axis = qvmAnglesToAxis(vec3(0, yaw, 0));
      if (fraction !== 1) { ref.axis = scaleAxis(ref.axis, fraction); ref.nonNormalizedAxes = true; }
      this.imports.addRefEntity(ref);
    }
  }

  private weapon(entity: ClientEntity): PacketWeaponInfo {
    // Source intentionally uses > rather than >= WP_NUM_WEAPONS.
    const count = this.state.product === "missionpack" ? 14 : 11;
    if (entity.currentState.weapon > count) entity.currentState.weapon = Weapon.WP_NONE;
    return indexed(this.media.weapons, entity.currentState.weapon, "weapon");
  }

  private missile(entity: ClientEntity): void {
    const current = entity.currentState, weapon = this.weapon(entity);
    entity.lerpAngles = vec3(current.angles.x, current.angles.y, current.angles.z);
    if (weapon.missileTrail !== null) this.imports.missileTrail(weapon.missileTrail, entity, weapon);
    if (weapon.missileDlight !== 0) this.imports.addLight({ origin: entity.lerpOrigin, radius: weapon.missileDlight, color: weapon.missileDlightColor });
    if (weapon.missileSound !== null) this.imports.addLoopSound(current.number, entity.lerpOrigin, evaluateTrajectoryDelta(current.pos, this.state.time), weapon.missileSound, false);
    if (current.weapon === Weapon.WP_PLASMAGUN) {
      const ref = createSpriteEntity();
      ref.origin = entity.lerpOrigin; ref.radius = 16; ref.customShader = this.media.plasmaBallShader;
      this.imports.addRefEntity(ref);
      return;
    }
    const ref = createModelEntity(weapon.missileModel);
    ref.origin = entity.lerpOrigin; ref.oldOrigin = entity.lerpOrigin;
    ref.skinNum = this.state.clientFrame & 1; ref.renderFlags = weapon.missileRenderfx | RF_NOSHADOW;
    if (this.media.variant.product === "missionpack" && current.weapon === Weapon.WP_PROX_LAUNCHER && current.generic1 === Team.TEAM_BLUE) ref.model = this.media.variant.media.blueProxMine;
    const direction = missileDirection(current.pos.delta);
    if (current.pos.type !== TrajectoryType.TR_STATIONARY) ref.axis = directionAxis(direction, (this.state.time / 4) | 0);
    else if (this.state.product === "missionpack" && current.weapon === Weapon.WP_PROX_LAUNCHER) ref.axis = qvmAnglesToAxis(entity.lerpAngles);
    else ref.axis = directionAxis(direction, current.time);
    this.imports.addEntityWithPowerups(ref, current, Team.TEAM_FREE);
  }

  private grapple(entity: ClientEntity): void {
    const current = entity.currentState, weapon = this.weapon(entity);
    entity.lerpAngles = vec3(current.angles.x, current.angles.y, current.angles.z);
    this.imports.grappleTrail(entity, weapon);
    const ref = createModelEntity(weapon.missileModel);
    ref.origin = entity.lerpOrigin; ref.oldOrigin = entity.lerpOrigin;
    ref.skinNum = this.state.clientFrame & 1; ref.renderFlags = weapon.missileRenderfx | RF_NOSHADOW;
    // CG_Grapple only fills axis[0]; the two cleared axes remain zero.
    ref.axis = [missileDirection(current.pos.delta), ref.axis[1], ref.axis[2]];
    this.imports.addRefEntity(ref);
  }

  private mover(entity: ClientEntity): void {
    const current = entity.currentState;
    const model = current.solid === SOLID_BMODEL ? indexed(this.media.inlineModels, current.modelindex, "inline model").model : indexed(this.media.gameModels, current.modelindex, "game model");
    const ref = createModelEntity(model);
    ref.origin = entity.lerpOrigin; ref.oldOrigin = entity.lerpOrigin; ref.axis = qvmAnglesToAxis(entity.lerpAngles);
    ref.renderFlags = RF_NOSHADOW; ref.skinNum = (this.state.time >> 6) & 1;
    this.imports.addRefEntity({ ...ref });
    if (current.modelindex2 !== 0) {
      ref.skinNum = 0; ref.model = indexed(this.media.gameModels, current.modelindex2, "game model");
      this.imports.addRefEntity(ref);
    }
  }

  beam(entity: ClientEntity): void {
    const ref = createBeamEntity();
    ref.origin = entity.currentState.pos.base; ref.oldOrigin = entity.currentState.origin2; ref.renderFlags = RF_NOSHADOW;
    ref.axis = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];
    this.imports.addRefEntity(ref);
  }

  private portal(entity: ClientEntity): void {
    const current = entity.currentState, ref = createPortalEntity();
    ref.origin = entity.lerpOrigin; ref.oldOrigin = current.origin2;
    const forward = byteToDirection(current.eventParm), side = sub3(vec3(0, 0, 0), perpendicularVector(forward));
    ref.axis = [forward, side, cross3(forward, side)];
    ref.oldFrame = current.powerups; ref.frame = current.frame;
    ref.skinNum = qvmFloatToInt(f(f(f(current.clientNum) / 256) * 360));
    this.imports.addRefEntity(ref);
  }

  private team(entity: ClientEntity, options: PacketEntityOptions): void {
    const current = entity.currentState;
    const ref = createModelEntity();
    ref.origin = entity.lerpOrigin; ref.lightingOrigin = entity.lerpOrigin; ref.axis = qvmAnglesToAxis(current.angles);
    if (options.gameType === GameType.GT_CTF || (this.state.product === "missionpack" && options.gameType === GameType.GT_1FCTF)) {
      ref.model = current.modelindex === Team.TEAM_RED ? this.media.redFlagBaseModel : current.modelindex === Team.TEAM_BLUE ? this.media.blueFlagBaseModel : this.media.neutralFlagBaseModel;
      this.imports.addRefEntity(ref);
      return;
    }
    if (this.media.variant.product !== "missionpack") return;
    const media = this.media.variant.media;
    if (options.gameType === GameType.GT_HARVESTER) {
      ref.model = current.modelindex === Team.TEAM_RED || current.modelindex === Team.TEAM_BLUE ? media.harvesterModel : media.harvesterNeutralModel;
      ref.customSkin = current.modelindex === Team.TEAM_RED ? media.harvesterRedSkin : current.modelindex === Team.TEAM_BLUE ? media.harvesterBlueSkin : null;
      this.imports.addRefEntity(ref);
      return;
    }
    if (options.gameType !== GameType.GT_OBELISK) return;
    ref.model = media.overloadBaseModel;
    this.imports.addRefEntity({ ...ref });
    const health = qvmFloatToInt(f(current.modelindex2)) & 255;
    if (current.frame === 1) {
      ref.shaderRGBA = vec4(255, health, health, 255); ref.model = media.overloadEnergyModel;
      this.imports.addRefEntity({ ...ref });
    }
    if (current.frame !== 2) {
      entity.miscTime = 0; entity.muzzleFlashTime = 0;
      ref.shaderRGBA = vec4(255, health, health, 255); ref.model = media.overloadLightsModel;
      this.imports.addRefEntity({ ...ref });
      ref.origin = add3(ref.origin, vec3(0, 0, 56)); ref.model = media.overloadTargetModel;
      this.imports.addRefEntity(ref);
      return;
    }
    if (entity.miscTime === 0) entity.miscTime = this.state.time;
    const elapsed = (this.state.time - entity.miscTime) | 0, threshold = Math.imul((options.obeliskRespawnDelay - 5) | 0, 1000);
    const scale = elapsed > threshold ? Math.min(1, f(f((elapsed - threshold) | 0) / f(threshold))) : 0;
    const color = qvmFloatToInt(f(scale * 255)) & 255;
    ref.shaderRGBA = vec4(color, color, color, color); ref.model = media.overloadLightsModel;
    this.imports.addRefEntity({ ...ref });
    if (elapsed > threshold) {
      if (entity.muzzleFlashTime === 0) {
        this.imports.startSound(entity.lerpOrigin, 1023, CHAN_BODY, media.obeliskRespawnSound);
        entity.muzzleFlashTime = 1;
      }
      const spin = f(f(f(16 * f(Math.acos(f(1 - scale)))) * 180) / f(Math.PI));
      ref.axis = scaleAxis(qvmAnglesToAxis(vec3(current.angles.x, f(current.angles.y + spin), current.angles.z)), scale);
      // Source leaves nonNormalizedAxes false even while scaling this target.
      ref.shaderRGBA = vec4(255, 255, 255, 255);
      ref.origin = add3(ref.origin, vec3(0, 0, 56)); ref.model = media.overloadTargetModel;
      this.imports.addRefEntity(ref);
    }
  }

  addEntity(entity: ClientEntity, options: PacketEntityOptions): void {
    const type = entity.currentState.eType;
    if (type >= EntityType.ET_EVENTS) return;
    this.calculateLerpPositions(entity, options.smoothClients);
    this.effects(entity);
    switch (type) {
      case EntityType.ET_INVISIBLE: case EntityType.ET_PUSH_TRIGGER: case EntityType.ET_TELEPORT_TRIGGER: return;
      case EntityType.ET_GENERAL: this.general(entity); return;
      case EntityType.ET_PLAYER: this.imports.player(entity); return;
      case EntityType.ET_ITEM: this.item(entity, options); return;
      case EntityType.ET_MISSILE: this.missile(entity); return;
      case EntityType.ET_MOVER: this.mover(entity); return;
      case EntityType.ET_BEAM: this.beam(entity); return;
      case EntityType.ET_PORTAL: this.portal(entity); return;
      case EntityType.ET_SPEAKER: this.speaker(entity); return;
      case EntityType.ET_GRAPPLE: this.grapple(entity); return;
      case EntityType.ET_TEAM: this.team(entity, options); return;
      default: throw new CommonError("drop", `Bad entity type: ${type}\n`);
    }
  }

  addPacketEntities(options: PacketEntityOptions): void {
    const state = this.state, snap = state.snap;
    if (snap === null) throw new Error("CG_AddPacketEntities: cg.snap == NULL");
    const delta = state.nextSnap === null ? 0 : (state.nextSnap.serverTime - snap.serverTime) | 0;
    state.frameInterpolation = delta === 0 ? 0 : f(f((state.time - snap.serverTime) | 0) / f(delta));
    state.autoAngles = vec3(0, f((state.time & 2047) * 360 / 2048), 0);
    state.autoAnglesFast = vec3(0, f((state.time & 1023) * 360 / 1024), 0);
    state.autoAxis = qvmAnglesToAxis(state.autoAngles); state.autoAxisFast = qvmAnglesToAxis(state.autoAnglesFast);
    playerStateToEntityState(state.predictedPlayerState, state.predictedPlayerEntity.currentState, false);
    this.addEntity(state.predictedPlayerEntity, options);
    this.calculateLerpPositions(state.entityAt(snap.playerState.clientNum), options.smoothClients);
    for (const current of snap.entities) this.addEntity(state.entityAt(current.number), options);
  }
}
