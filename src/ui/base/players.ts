// Player previews from id Software's code/q3_ui/ui_players.c and ui_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Animation } from "../../assets/animation.ts";
import type { CommonFileState } from "../../assets/filesystem-state.ts";
import { lerpModelTag } from "../../render/model-tags.ts";
import { CommonParseCursor } from "../../core/common-parse.ts";
import { add3, dot3, scale3, sub3, vec3 } from "../../core/math.ts";
import type { Axis, Vec3 } from "../../core/math.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { qvmAngleMod, qvmAnglesToAxis, qvmAngleVectors } from "../../core/qvm-math.ts";
import { sourceCommandText } from "../../core/text.ts";
import { gameAtof, gameAtoi } from "../../game/numeric.ts";
import type { Rect2D } from "../../render/draw2d.ts";
import { createModelEntity, createSpriteEntity, DEFAULT_MODEL, RF_LIGHTING_ORIGIN, RF_NOSHADOW } from "../../render/ref-entity.ts";
import type { RefModelEntity, SceneModel, SceneSkin } from "../../render/ref-entity.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../../render/refdef.ts";
import { ItemType, Weapon } from "../../shared/definitions.ts";
import { itemList } from "../../shared/items.ts";
import { PlayerAnimation } from "../../shared/player-state.ts";
import { runBasePlayerLerpFrame } from "./player-animation.ts";
import type { BasePlayerLerpFrame } from "./player-animation.ts";
import { itemAt } from "./state.ts";
import type { BaseUiState } from "./state.ts";

const f = Math.fround;
const TOGGLE = 128;
const PI = f(Math.PI);
// Q3_VM bg_lib.c tan calls the binary32 sin/cos traps before division.
function tangent(angle: number): number { return f(f(Math.sin(angle)) / f(Math.cos(angle))); }
type MutableAnimation = { -readonly [K in keyof Animation]: Animation[K] };
interface PlayerLerpFrame extends BasePlayerLerpFrame {
  yawAngle: number;
  yawing: boolean;
  pitchAngle: number;
  pitching: boolean;
}
function zeroAnimation(): MutableAnimation {
  return { firstFrame: 0, numFrames: 0, loopFrames: 0, frameLerp: 0, initialLerp: 0, reversed: false, flipflop: false };
}
function zeroFrame(): PlayerLerpFrame {
  return { oldFrame: 0, oldFrameTime: 0, frame: 0, frameTime: 0, backLerp: 0, animationNumber: 0,
    currentAnimation: null, animationTime: 0, yawAngle: 0, yawing: false, pitchAngle: 0, pitching: false };
}

/** Embedded lerp frames and animation cells retain their identities through memset/reload. */
export class BasePlayerInfo {
  legsModel: SceneModel = DEFAULT_MODEL;
  legsSkin: SceneSkin | null = null;
  readonly legs = zeroFrame();
  torsoModel: SceneModel = DEFAULT_MODEL;
  torsoSkin: SceneSkin | null = null;
  readonly torso = zeroFrame();
  headModel: SceneModel = DEFAULT_MODEL;
  headSkin: SceneSkin | null = null;
  readonly animations: readonly MutableAnimation[] = Array.from({ length: 31 }, zeroAnimation);
  weaponModel: SceneModel = DEFAULT_MODEL;
  barrelModel: SceneModel = DEFAULT_MODEL;
  flashModel: SceneModel = DEFAULT_MODEL;
  flashDlightColor = vec3(0, 0, 0);
  muzzleFlashTime = 0;
  viewAngles = vec3(0, 0, 0);
  moveAngles = vec3(0, 0, 0);
  currentWeapon = 0;
  legsAnim = 0;
  torsoAnim = 0;
  weapon = 0;
  lastWeapon = 0;
  pendingWeapon = 0;
  weaponTimer = 0;
  pendingLegsAnim = 0;
  torsoAnimationTimer = 0;
  pendingTorsoAnim = 0;
  legsAnimationTimer = 0;
  chat = false;
  newModel = false;
  barrelSpinning = false;
  barrelAngle = 0;
  barrelTime = 0;
  realWeapon = 0;
}

export function clearBasePlayerInfo(info: BasePlayerInfo): void {
  // Object assignment must not replace the embedded records referenced by UI interpolation.
  const zero = new BasePlayerInfo();
  Object.assign(info, zero, { legs: info.legs, torso: info.torso, animations: info.animations });
  Object.assign(info.legs, zero.legs);
  Object.assign(info.torso, zero.torso);
  for (const animation of info.animations) Object.assign(animation, zeroAnimation());
}
function sourceInteger(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw new RangeError("Player preview requires source int32 storage");
  return value;
}
function angleSubtract(a: number, b: number): number {
  let angle = f(a - b);
  // Source loops cannot progress at nonfinite or excessively large float spacing.
  while (angle > 180) {
    const next = f(angle - 360);
    if (next === angle) throw new RangeError("Nonprogressing source AngleSubtract");
    angle = next;
  }
  while (angle < -180) {
    const next = f(angle + 360);
    if (next === angle) throw new RangeError("Nonprogressing source AngleSubtract");
    angle = next;
  }
  return angle;
}
function anglesSubtract(a: Vec3, b: Vec3): Vec3 {
  return vec3(angleSubtract(a.x, b.x), angleSubtract(a.y, b.y), angleSubtract(a.z, b.z));
}
function identityAxis(): Axis { return [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]; }
function hasModel(model: SceneModel): boolean { return model.kind !== "default"; }
function multiplyAxis(a: Axis, b: Axis): Axis {
  const x = vec3(b[0].x, b[1].x, b[2].x), y = vec3(b[0].y, b[1].y, b[2].y), z = vec3(b[0].z, b[1].z, b[2].z);
  const row = (v: Vec3): Vec3 => vec3(dot3(v, x), dot3(v, y), dot3(v, z));
  return [row(a[0]), row(a[1]), row(a[2])];
}
function positionOnTag(entity: RefModelEntity, parent: RefModelEntity, model: SceneModel, name: string, rotated: boolean): void {
  const tag = lerpModelTag(model, name, parent.oldFrame, parent.frame, f(1 - parent.backLerp));
  const origin = tag === null ? vec3(0, 0, 0) : tag.origin;
  const axis = tag === null ? identityAxis() : tag.axes;
  entity.origin = add3(add3(add3(parent.origin, scale3(parent.axis[0], origin.x)), scale3(parent.axis[1], origin.y)), scale3(parent.axis[2], origin.z));
  // UI's rotated multiplication order differs from CG_PositionRotatedEntityOnTag.
  entity.axis = rotated ? multiplyAxis(axis, multiplyAxis(entity.axis, parent.axis)) : multiplyAxis(axis, parent.axis);
  if (!rotated) entity.backLerp = parent.backLerp;
}
function forceLegs(info: BasePlayerInfo, animation: number): void {
  info.legsAnim = ((info.legsAnim & TOGGLE) ^ TOGGLE) | animation;
  if (animation === PlayerAnimation.LEGS_JUMP) info.legsAnimationTimer = 1000;
}
function setLegs(info: BasePlayerInfo, animation: number): void {
  if (info.pendingLegsAnim !== 0) { animation = info.pendingLegsAnim; info.pendingLegsAnim = 0; }
  forceLegs(info, animation);
}
function forceTorso(info: BasePlayerInfo, animation: number): void {
  info.torsoAnim = ((info.torsoAnim & TOGGLE) ^ TOGGLE) | animation;
  if (animation === PlayerAnimation.TORSO_GESTURE) info.torsoAnimationTimer = 2300;
  if (animation === PlayerAnimation.TORSO_ATTACK || animation === PlayerAnimation.TORSO_ATTACK2) info.torsoAnimationTimer = 500;
}
function setTorso(info: BasePlayerInfo, animation: number): void {
  if (info.pendingTorsoAnim !== 0) { animation = info.pendingTorsoAnim; info.pendingTorsoAnim = 0; }
  forceTorso(info, animation);
}

export class BaseUiPlayers {
  private realtime = 0;
  private jumpHeight = 0;
  constructor(readonly state: BaseUiState, readonly files: CommonFileState) {}

  private filename(value: string): string {
    if (value.length >= 64) this.state.services.print(`Com_sprintf: overflow of ${value.length} in 64\n`);
    return value.slice(0, 63);
  }
  private async setWeapon(info: BasePlayerInfo, weapon: number): Promise<void> {
    info.currentWeapon = weapon;
    while (true) {
      info.realWeapon = weapon;
      info.weaponModel = DEFAULT_MODEL; info.barrelModel = DEFAULT_MODEL; info.flashModel = DEFAULT_MODEL;
      if (weapon === Weapon.WP_NONE) return;
      const item = itemList("baseq3").find(candidate => candidate.type === ItemType.IT_WEAPON && candidate.tag === weapon);
      const path = item === undefined ? null : item.worldModels[0];
      if (path !== null) {
        const model = await this.state.services.resources.registerModel(path); this.state.assertActive();
        info.weaponModel = model;
      }
      if (info.weaponModel.kind === "default") {
        weapon = weapon === Weapon.WP_MACHINEGUN ? Weapon.WP_NONE : Weapon.WP_MACHINEGUN;
        continue;
      }
      if (path === null) throw new Error("UI weapon model has no source item path");
      // strcpy/strcat use 64-byte storage, unlike Com_sprintf's defined truncation.
      if (path.length >= 64) throw new RangeError("UI weapon path exceeds source strcpy storage");
      const dot = path.indexOf("."), stem = dot === -1 ? path : path.slice(0, dot);
      if (weapon === Weapon.WP_MACHINEGUN || weapon === Weapon.WP_GAUNTLET || weapon === Weapon.WP_BFG) {
        const barrelPath = stem + "_barrel.md3";
        if (barrelPath.length >= 64) throw new RangeError("UI barrel path exceeds source strcat storage");
        const model = await this.state.services.resources.registerModel(barrelPath); this.state.assertActive(); info.barrelModel = model;
      }
      const flashPath = stem + "_flash.md3";
      if (flashPath.length >= 64) throw new RangeError("UI flash path exceeds source strcat storage");
      const flash = await this.state.services.resources.registerModel(flashPath); this.state.assertActive(); info.flashModel = flash;
      switch (weapon) {
        case Weapon.WP_GAUNTLET: case Weapon.WP_LIGHTNING: case Weapon.WP_PLASMAGUN: case Weapon.WP_GRAPPLING_HOOK:
          info.flashDlightColor = vec3(.6, .6, 1); break;
        case Weapon.WP_MACHINEGUN: case Weapon.WP_SHOTGUN: info.flashDlightColor = vec3(1, 1, 0); break;
        case Weapon.WP_GRENADE_LAUNCHER: info.flashDlightColor = vec3(1, .7, .5); break;
        case Weapon.WP_ROCKET_LAUNCHER: info.flashDlightColor = vec3(1, .75, 0); break;
        case Weapon.WP_RAILGUN: info.flashDlightColor = vec3(1, .5, 0); break;
        case Weapon.WP_BFG: info.flashDlightColor = vec3(1, .7, 1); break;
        default: info.flashDlightColor = vec3(1, 1, 1); break;
      }
      return;
    }
  }
  private async registerSkin(info: BasePlayerInfo, model: string, skin: string): Promise<boolean> {
    const resources = this.state.services.resources;
    const legs = await resources.registerSkin(this.filename(`models/players/${model}/lower_${skin}.skin`)); this.state.assertActive(); info.legsSkin = legs;
    const torso = await resources.registerSkin(this.filename(`models/players/${model}/upper_${skin}.skin`)); this.state.assertActive(); info.torsoSkin = torso;
    const head = await resources.registerSkin(this.filename(`models/players/${model}/head_${skin}.skin`)); this.state.assertActive(); info.headSkin = head;
    return info.legsSkin !== null && info.torsoSkin !== null && info.headSkin !== null;
  }
  private parseAnimations(filename: string, animations: readonly MutableAnimation[]): boolean {
    for (const animation of animations) Object.assign(animation, zeroAnimation());
    const files = this.files.current, opened = files.openRead(filename);
    // Source leaks these handles; CommonFileState owns their eventual disposal.
    if (opened === undefined || opened.length <= 0) return false;
    if (opened.length >= 19999) { this.state.services.print(`File ${filename} too long\n`); return false; }
    const bytes = new Uint8Array(opened.length), copied = files.readInto(opened.file, bytes);
    files.closeFile(opened.file);
    let text = "";
    for (const byte of bytes.subarray(0, copied)) text += String.fromCharCode(byte);
    const cursor = new CommonParseCursor(text, copied === opened.length ? "terminated" : "uninitialized"), parser = this.state.sourceParser;
    while (true) {
      const previous = cursor.offset, token = parser.parse(cursor), lower = token.toLowerCase();
      if (lower === "footsteps" || lower === "sex") { parser.parse(cursor); continue; }
      if (lower === "headoffset") { parser.parse(cursor); parser.parse(cursor); parser.parse(cursor); continue; }
      const first = token.charAt(0);
      if (first >= "0" && first <= "9") { cursor.offset = previous; break; }
      this.state.services.print(`unknown token '${token}' is ${filename}\n`);
      // COM_Parse's pointer is never NULL. At EOF the optional prelude repeats forever.
      if (previous === cursor.offset) throw new RangeError("UI animation prelude reached the source nonprogress cycle");
    }
    let skip = 0;
    for (let index = 0; index < 31; index++) {
      const row = itemAt(animations, index);
      row.firstFrame = gameAtoi(parser.parse(cursor));
      if (index === PlayerAnimation.LEGS_WALKCR) skip = (row.firstFrame - itemAt(animations, PlayerAnimation.TORSO_GESTURE).firstFrame) | 0;
      if (index >= PlayerAnimation.LEGS_WALKCR) row.firstFrame = (row.firstFrame - skip) | 0;
      row.numFrames = gameAtoi(parser.parse(cursor));
      row.loopFrames = gameAtoi(parser.parse(cursor));
      let fps = gameAtof(parser.parse(cursor));
      if (fps === 0) fps = 1;
      row.frameLerp = qvmFloatToInt(f(1000 / fps)); row.initialLerp = qvmFloatToInt(f(1000 / fps));
    }
    return true;
  }
  async registerClientModelname(info: BasePlayerInfo, modelSkinName: string): Promise<boolean> {
    this.state.assertActive();
    info.torsoModel = DEFAULT_MODEL; info.headModel = DEFAULT_MODEL;
    const input = sourceCommandText(modelSkinName.slice(0, 63));
    if (input.length === 0) return false;
    const copied = input.slice(0, 63), slash = copied.indexOf("/");
    const model = slash === -1 ? copied : copied.slice(0, slash), skin = slash === -1 ? "default" : copied.slice(slash + 1);
    let filename = this.filename(`models/players/${model}/lower.md3`);
    const legs = await this.state.services.resources.registerModel(filename); this.state.assertActive(); info.legsModel = legs;
    if (legs.kind === "default") { this.state.services.print(`Failed to load model file ${filename}\n`); return false; }
    filename = this.filename(`models/players/${model}/upper.md3`);
    const torso = await this.state.services.resources.registerModel(filename); this.state.assertActive(); info.torsoModel = torso;
    if (torso.kind === "default") { this.state.services.print(`Failed to load model file ${filename}\n`); return false; }
    filename = this.filename(`models/players/${model}/head.md3`);
    const head = await this.state.services.resources.registerModel(filename); this.state.assertActive(); info.headModel = head;
    if (head.kind === "default") { this.state.services.print(`Failed to load model file ${filename}\n`); return false; }
    const requestedSkin = await this.registerSkin(info, model, skin); this.state.assertActive();
    if (!requestedSkin) {
      const defaultSkin = await this.registerSkin(info, model, "default"); this.state.assertActive();
      if (!defaultSkin) {
        this.state.services.print(`Failed to load skin file: ${model} : ${skin}\n`); return false;
      }
    }
    filename = this.filename(`models/players/${model}/animation.cfg`);
    if (!this.parseAnimations(filename, info.animations)) { this.state.services.print(`Failed to load animation file ${filename}\n`); return false; }
    return true;
  }
  async setModel(info: BasePlayerInfo, model: string): Promise<void> {
    this.state.assertActive(); clearBasePlayerInfo(info);
    await this.registerClientModelname(info, model); this.state.assertActive();
    info.weapon = Weapon.WP_MACHINEGUN; info.currentWeapon = info.weapon; info.lastWeapon = info.weapon;
    info.pendingWeapon = -1; info.weaponTimer = 0; info.chat = false; info.newModel = true;
    await this.setWeapon(info, info.weapon); this.state.assertActive();
  }
  async setInfo(info: BasePlayerInfo, input: { readonly legsAnim: number; readonly torsoAnim: number; readonly viewAngles: Vec3;
    readonly moveAngles: Vec3; readonly weaponNumber: number; readonly chat: boolean }): Promise<void> {
    this.state.assertActive();
    let legs = sourceInteger(input.legsAnim), torso = sourceInteger(input.torsoAnim);
    const weapon = sourceInteger(input.weaponNumber);
    info.chat = input.chat;
    info.viewAngles = vec3(input.viewAngles.x, input.viewAngles.y, input.viewAngles.z);
    info.moveAngles = vec3(input.moveAngles.x, input.moveAngles.y, input.moveAngles.z);
    if (info.newModel) {
      info.newModel = false; this.jumpHeight = 0; info.pendingLegsAnim = 0;
      forceLegs(info, legs); info.legs.yawAngle = f(input.viewAngles.y); info.legs.yawing = false;
      info.pendingTorsoAnim = 0; forceTorso(info, torso); info.torso.yawAngle = f(input.viewAngles.y); info.torso.yawing = false;
      if (weapon !== -1) {
        info.weapon = weapon; info.currentWeapon = weapon; info.lastWeapon = weapon; info.pendingWeapon = -1; info.weaponTimer = 0;
        await this.setWeapon(info, info.weapon); this.state.assertActive();
      }
      return;
    }
    if (weapon === -1) { info.pendingWeapon = -1; info.weaponTimer = 0; }
    else if (weapon !== Weapon.WP_NONE) { info.pendingWeapon = weapon; info.weaponTimer = (this.realtime + 250) | 0; }
    const weaponNum = info.lastWeapon; info.weapon = weaponNum;
    if (torso === PlayerAnimation.BOTH_DEATH1 || legs === PlayerAnimation.BOTH_DEATH1) {
      torso = PlayerAnimation.BOTH_DEATH1; legs = PlayerAnimation.BOTH_DEATH1;
      info.weapon = Weapon.WP_NONE; info.currentWeapon = Weapon.WP_NONE;
      await this.setWeapon(info, info.weapon); this.state.assertActive();
      this.jumpHeight = 0; info.pendingLegsAnim = 0; forceLegs(info, legs); info.pendingTorsoAnim = 0; forceTorso(info, torso); return;
    }
    let current = info.legsAnim & ~TOGGLE;
    if (legs !== PlayerAnimation.LEGS_JUMP && (current === PlayerAnimation.LEGS_JUMP || current === PlayerAnimation.LEGS_LAND)) info.pendingLegsAnim = legs;
    else if (legs !== current) { this.jumpHeight = 0; info.pendingLegsAnim = 0; forceLegs(info, legs); }
    if (torso === PlayerAnimation.TORSO_STAND || torso === PlayerAnimation.TORSO_STAND2)
      torso = weaponNum === Weapon.WP_NONE || weaponNum === Weapon.WP_GAUNTLET ? PlayerAnimation.TORSO_STAND2 : PlayerAnimation.TORSO_STAND;
    if (torso === PlayerAnimation.TORSO_ATTACK || torso === PlayerAnimation.TORSO_ATTACK2) {
      torso = weaponNum === Weapon.WP_NONE || weaponNum === Weapon.WP_GAUNTLET ? PlayerAnimation.TORSO_ATTACK2 : PlayerAnimation.TORSO_ATTACK;
      info.muzzleFlashTime = (this.realtime + 20) | 0;
    }
    current = info.torsoAnim & ~TOGGLE;
    if (weaponNum !== info.currentWeapon || current === PlayerAnimation.TORSO_RAISE || current === PlayerAnimation.TORSO_DROP) info.pendingTorsoAnim = torso;
    else if ((current === PlayerAnimation.TORSO_GESTURE || current === PlayerAnimation.TORSO_ATTACK) && torso !== current) info.pendingTorsoAnim = torso;
    else if (torso !== current) { info.pendingTorsoAnim = 0; forceTorso(info, torso); }
  }
  private swing(destination: number, tolerance: number, clamp: number, speed: number, angle: number, swinging: boolean): { angle: number; swinging: boolean } {
    if (!swinging) { const swing = angleSubtract(angle, destination); if (swing > tolerance || swing < -tolerance) swinging = true; }
    if (!swinging) return { angle, swinging };
    let swing = angleSubtract(destination, angle), scale = Math.abs(swing);
    scale = scale < f(tolerance * .5) ? .5 : scale < tolerance ? 1 : 2;
    if (swing >= 0) {
      let move = f(f(f(this.state.frameTime) * scale) * speed);
      if (move >= swing) { move = swing; swinging = false; }
      angle = qvmAngleMod(f(angle + move));
    } else if (swing < 0) {
      let move = f(f(f(this.state.frameTime) * scale) * -speed);
      if (move <= swing) { move = swing; swinging = false; }
      angle = qvmAngleMod(f(angle + move));
    }
    swing = angleSubtract(destination, angle);
    if (swing > clamp) angle = qvmAngleMod(f(destination - f(clamp - 1)));
    else if (swing < -clamp) angle = qvmAngleMod(f(destination + f(clamp - 1)));
    return { angle, swinging };
  }
  private playerAngles(info: BasePlayerInfo): { legs: Axis; torso: Axis; head: Axis } {
    const head = vec3(info.viewAngles.x, qvmAngleMod(info.viewAngles.y), info.viewAngles.z);
    if ((info.legsAnim & ~TOGGLE) !== PlayerAnimation.LEGS_IDLE || (info.torsoAnim & ~TOGGLE) !== PlayerAnimation.TORSO_STAND) {
      info.torso.yawing = true; info.torso.pitching = true; info.legs.yawing = true;
    }
    const move = qvmAngleVectors(sub3(info.viewAngles, info.moveAngles)).forward;
    const x = Math.abs(move.x) < f(.01) ? 0 : move.x, y = Math.abs(move.y) < f(.01) ? 0 : move.y;
    let adjust = -22;
    if (y === 0 && x > 0) adjust = 0;
    else if (y < 0 && x > 0) adjust = 22;
    else if (y < 0 && x === 0) adjust = 45;
    else if (y < 0 && x < 0) adjust = -22;
    else if (y === 0 && x < 0) adjust = 0;
    else if (y > 0 && x < 0) adjust = 22;
    else if (y > 0 && x === 0) adjust = -45;
    const torsoYaw = this.swing(f(head.y + f(.25 * adjust)), 25, 90, f(.3), info.torso.yawAngle, info.torso.yawing);
    info.torso.yawAngle = torsoYaw.angle; info.torso.yawing = torsoYaw.swinging;
    const legsYaw = this.swing(f(head.y + adjust), 40, 90, f(.3), info.legs.yawAngle, info.legs.yawing);
    info.legs.yawAngle = legsYaw.angle; info.legs.yawing = legsYaw.swinging;
    const pitch = this.swing(f((head.x > 180 ? f(-360 + head.x) : head.x) * .75), 15, 30, f(.1), info.torso.pitchAngle, info.torso.pitching);
    info.torso.pitchAngle = pitch.angle; info.torso.pitching = pitch.swinging;
    const torso = vec3(info.torso.pitchAngle, info.torso.yawAngle, 0), legs = vec3(0, info.legs.yawAngle, 0);
    return { legs: qvmAnglesToAxis(legs), torso: qvmAnglesToAxis(anglesSubtract(torso, legs)), head: qvmAnglesToAxis(anglesSubtract(head, torso)) };
  }
  private legsSequencing(info: BasePlayerInfo): void {
    const current = info.legsAnim & ~TOGGLE;
    if (info.legsAnimationTimer > 0) {
      if (current === PlayerAnimation.LEGS_JUMP) this.jumpHeight = f(56 * f(Math.sin(f(f(PI * f((1000 - info.legsAnimationTimer) | 0)) / 1000))));
      return;
    }
    if (current === PlayerAnimation.LEGS_JUMP) { forceLegs(info, PlayerAnimation.LEGS_LAND); info.legsAnimationTimer = 130; this.jumpHeight = 0; return; }
    if (current === PlayerAnimation.LEGS_LAND) setLegs(info, PlayerAnimation.LEGS_IDLE);
  }
  private async torsoSequencing(info: BasePlayerInfo): Promise<void> {
    const current = info.torsoAnim & ~TOGGLE;
    if (info.weapon !== info.currentWeapon && current !== PlayerAnimation.TORSO_DROP) {
      info.torsoAnimationTimer = 300; forceTorso(info, PlayerAnimation.TORSO_DROP);
    }
    if (info.torsoAnimationTimer > 0) return;
    if (current === PlayerAnimation.TORSO_GESTURE || current === PlayerAnimation.TORSO_ATTACK || current === PlayerAnimation.TORSO_ATTACK2) {
      setTorso(info, PlayerAnimation.TORSO_STAND); return;
    }
    if (current === PlayerAnimation.TORSO_DROP) {
      await this.setWeapon(info, info.weapon); this.state.assertActive();
      info.torsoAnimationTimer = 300; forceTorso(info, PlayerAnimation.TORSO_RAISE); return;
    }
    if (current === PlayerAnimation.TORSO_RAISE) setTorso(info, PlayerAnimation.TORSO_STAND);
  }
  private async playerAnimation(info: BasePlayerInfo, legs: RefModelEntity, torso: RefModelEntity): Promise<void> {
    info.legsAnimationTimer = Math.max(0, (info.legsAnimationTimer - this.state.frameTime) | 0);
    this.legsSequencing(info);
    const animation = info.legs.yawing && (info.legsAnim & ~TOGGLE) === PlayerAnimation.LEGS_IDLE ? PlayerAnimation.LEGS_TURN : info.legsAnim;
    runBasePlayerLerpFrame(info.animations, info.legs, { animationNumber: animation, realtime: this.realtime });
    legs.oldFrame = info.legs.oldFrame; legs.frame = info.legs.frame; legs.backLerp = info.legs.backLerp;
    info.torsoAnimationTimer = Math.max(0, (info.torsoAnimationTimer - this.state.frameTime) | 0);
    await this.torsoSequencing(info); this.state.assertActive();
    runBasePlayerLerpFrame(info.animations, info.torso, { animationNumber: info.torsoAnim, realtime: this.realtime });
    torso.oldFrame = info.torso.oldFrame; torso.frame = info.torso.frame; torso.backLerp = info.torso.backLerp;
  }
  private machinegunSpinAngle(info: BasePlayerInfo): number {
    let delta = (this.realtime - info.barrelTime) | 0;
    let angle: number;
    if (info.barrelSpinning) angle = f(info.barrelAngle + f(f(delta) * f(.9)));
    else {
      if (delta > 1000) delta = 1000;
      const speed = f(.5 * f(f(.9) + f(f((1000 - delta) | 0) / 1000)));
      angle = f(info.barrelAngle + f(f(delta) * speed));
    }
    let animation = info.torsoAnim & ~TOGGLE;
    if (animation === PlayerAnimation.TORSO_ATTACK2) animation = PlayerAnimation.TORSO_ATTACK;
    if (info.barrelSpinning === (animation !== PlayerAnimation.TORSO_ATTACK)) {
      info.barrelTime = this.realtime; info.barrelAngle = qvmAngleMod(angle); info.barrelSpinning = animation === PlayerAnimation.TORSO_ATTACK;
    }
    return angle;
  }
  async drawPlayer(rect: Rect2D, info: BasePlayerInfo, time: number): Promise<void> {
    this.state.assertActive();
    if (!hasModel(info.legsModel) || !hasModel(info.torsoModel) || !hasModel(info.headModel) || itemAt(info.animations, 0).numFrames === 0) return;
    this.realtime = sourceInteger(time);
    if (info.pendingWeapon !== -1 && this.realtime > info.weaponTimer) {
      info.weapon = info.pendingWeapon; info.lastWeapon = info.pendingWeapon; info.pendingWeapon = -1; info.weaponTimer = 0;
      if (info.currentWeapon !== info.weapon) {
        const sound = this.state.services.sounds.resolveForPlayback(this.state.media.weaponChange);
        if (sound !== null) this.state.services.audio.startLocalSound(sound, 1);
        this.state.assertActive();
      }
    }
    const viewport = this.state.draw.adjust(rect), refdef = createRefdef();
    refdef.renderFlags = RDF_NOWORLDMODEL; refdef.viewAxis = identityAxis();
    refdef.x = qvmFloatToInt(viewport.x); refdef.y = qvmFloatToInt(f(viewport.y - this.jumpHeight));
    refdef.width = qvmFloatToInt(viewport.width); refdef.height = qvmFloatToInt(viewport.height);
    refdef.fovX = f(qvmFloatToInt(f(f(f(refdef.width) / 640) * 90)));
    const xx = f(f(refdef.width) / tangent(f(f(refdef.fovX / 360) * PI)));
    refdef.fovY = f(Math.atan2(f(refdef.height), xx)); refdef.fovY = f(refdef.fovY * f(360 / Math.PI));
    const len = f(f(.7) * 56);
    const origin = vec3(f(len / tangent(f(f(f(refdef.fovX * PI) / 180) * .5))), 0, -4);
    refdef.time = this.realtime;
    const sceneEntities = this.state.services.resources;
    sceneEntities.clearScene();
    const legs = createModelEntity(), torso = createModelEntity(), head = createModelEntity();
    const angles = this.playerAngles(info); legs.axis = angles.legs; torso.axis = angles.torso; head.axis = angles.head;
    await this.playerAnimation(info, legs, torso); this.state.assertActive();
    const flags = RF_LIGHTING_ORIGIN | RF_NOSHADOW;
    legs.model = info.legsModel; legs.customSkin = info.legsSkin; legs.origin = { ...origin }; legs.lightingOrigin = { ...origin };
    legs.renderFlags = flags; legs.oldOrigin = { ...legs.origin }; sceneEntities.addRefEntity(legs);
    if (legs.model.kind === "default") return;
    torso.model = info.torsoModel; if (torso.model.kind === "default") return;
    torso.customSkin = info.torsoSkin; torso.lightingOrigin = { ...origin };
    positionOnTag(torso, legs, info.legsModel, "tag_torso", true); torso.renderFlags = flags; sceneEntities.addRefEntity(torso);
    head.model = info.headModel; if (head.model.kind === "default") return;
    head.customSkin = info.headSkin; head.lightingOrigin = { ...origin };
    positionOnTag(head, torso, info.torsoModel, "tag_head", true); head.renderFlags = flags; sceneEntities.addRefEntity(head);
    let gun: RefModelEntity | null = null;
    if (info.currentWeapon !== Weapon.WP_NONE) {
      gun = createModelEntity(info.weaponModel); gun.lightingOrigin = { ...origin };
      positionOnTag(gun, torso, info.torsoModel, "tag_weapon", false); gun.renderFlags = flags; sceneEntities.addRefEntity(gun);
    }
    if (info.realWeapon === Weapon.WP_MACHINEGUN || info.realWeapon === Weapon.WP_GAUNTLET || info.realWeapon === Weapon.WP_BFG) {
      const barrel = createModelEntity(info.barrelModel); barrel.lightingOrigin = { ...origin }; barrel.renderFlags = flags;
      const spin = this.machinegunSpinAngle(info);
      barrel.axis = qvmAnglesToAxis(info.realWeapon === Weapon.WP_GAUNTLET || info.realWeapon === Weapon.WP_BFG ? vec3(spin, 0, 0) : vec3(0, 0, spin));
      if (gun === null) throw new RangeError("UI barrel attachment reaches uninitialized source gun");
      positionOnTag(barrel, gun, info.weaponModel, "tag_barrel", true); sceneEntities.addRefEntity(barrel);
    }
    if (this.realtime <= info.muzzleFlashTime) {
      let flash: RefModelEntity | null = null;
      if (info.flashModel.kind !== "default") {
        flash = createModelEntity(info.flashModel); flash.lightingOrigin = { ...origin };
        if (gun === null) throw new RangeError("UI flash attachment reaches uninitialized source gun");
        positionOnTag(flash, gun, info.weaponModel, "tag_flash", false); flash.renderFlags = flags; sceneEntities.addRefEntity(flash);
      }
      const color = info.flashDlightColor;
      if (color.x !== 0 || color.y !== 0 || color.z !== 0) {
        const radius = 200 + (this.state.random.rand() & 31);
        if (flash === null) throw new RangeError("UI muzzle light reaches uninitialized source flash origin");
        sceneEntities.addLight({ origin: { ...flash.origin }, radius, color: { ...color } });
      }
    }
    if (info.chat) {
      const shader = await this.state.services.resources.registerShaderNoMip("sprites/balloon3"); this.state.assertActive();
      const sprite = createSpriteEntity(); sprite.origin = vec3(origin.x, origin.y, f(origin.z + 48)); sprite.customShader = shader; sprite.radius = 10; sceneEntities.addRefEntity(sprite);
    }
    let accent = vec3(f(origin.x - 100), f(origin.y + 100), f(origin.z + 100));
    sceneEntities.addLight({ origin: accent, radius: 500, color: vec3(1, 1, 1) });
    accent = vec3(f(accent.x - 100), f(accent.y - 100), f(accent.z - 100));
    sceneEntities.addLight({ origin: accent, radius: 500, color: vec3(1, 0, 0) });
    sceneEntities.renderScene(refdef);
  }
}
