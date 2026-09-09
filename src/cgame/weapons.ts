// Weapon registration and presentation from id Software's code/cgame/cg_weapons.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import { CommonError } from "../core/common-error.ts";
import { modelBounds } from "../render/model-bounds.ts";
import { add3, cross3, dot3, length3, normalize3, normalize3OrZero, perpendicularVector, scale3, sub3, vec3, vec4 } from "../core/math.ts";
import { qvmAngleMod as angleMod, qvmAngleVectors as angleVectors, qvmAnglesToAxis as anglesToAxis, qvmRotatePointAroundVector as rotatePointAroundVector } from "../core/qvm-math.ts";
import type { Axis, Vec3, Vec4 } from "../core/math.ts";
import { qCrandom, qvmFloatToInt } from "../core/numeric.ts";
import type { GameRandom } from "../game/numeric.ts";
import { DEFAULT_MODEL, createModelEntity, createSpriteEntity, createLightningEntity, createRailCoreEntity, RF_DEPTHHACK, RF_FIRST_PERSON, RF_MINLIGHT } from "../render/ref-entity.ts";
import type { RefModelEntity, RefPoly, SceneModel, SceneShader } from "../render/ref-entity.ts";
import type { RendererResources } from "../render/world.ts";
import { EntityType, ItemType, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState, statSchema } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { itemAt, itemList } from "../shared/items.ts";
import type { ItemDefinition } from "../shared/items.ts";
import { positionEntityOnTag, positionRotatedEntityOnTag } from "./entities.ts";
import type { MissileTrail, PacketEntityImports, PacketItemVisual, PacketWeaponInfo } from "./entities.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";
import { MoveFlags, PlayerAnimation } from "../shared/player-state.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import { TrajectoryType, evaluateTrajectory } from "../shared/trajectory.ts";
import type { ClientEffects } from "./effects.ts";
import { LocalEntityFlags } from "./local-entities.ts";
import type { LocalEntityPool } from "./local-entities.ts";
import type { PredictionRuntime } from "./prediction.ts";
import type { ClientInfo } from "./client-info.ts";
import type { ImpactMarkSystem } from "./marks.ts";
import type { ParticleSystem } from "./particles.ts";

const f = Math.fround;
export enum ImpactSound { DEFAULT = 0, METAL = 1, FLESH = 2 }
export type BulletHit = { readonly kind: "wall"; readonly normal: Vec3 } | { readonly kind: "flesh"; readonly entityNum: number };
export interface MutableVec3 { x: number; y: number; z: number }
export interface ClientWeaponInfo extends PacketWeaponInfo {
  readonly item: ItemDefinition | null;
  readonly handsModel: SceneModel;
  readonly flashModel: SceneModel;
  readonly ammoModel: SceneModel;
  readonly weaponIcon: SceneShader | null;
  readonly ammoIcon: SceneShader | null;
  readonly flashDlightColor: Vec3;
  readonly flashSounds: readonly [PcmSound | null, PcmSound | null, PcmSound | null, PcmSound | null];
  readonly ejectBrass: "machinegun" | "shotgun" | "nailgun" | null;
  readonly readySound: PcmSound | null;
  readonly firingSound: PcmSound | null;
  readonly loopFireSound: boolean;
}

export class ClientWeaponSelection {
  constructor(readonly state: ClientGameState) {}
  private selectable(number: number): boolean {
    const snap = this.state.snap;
    if (snap === null) throw new Error("CG_WeaponSelectable: cg.snap == NULL");
    return snap.playerState.ammo.get(number) !== 0 && (snap.playerState.stats.get(statSchema(this.state.product).weapons) & (1 << number)) !== 0;
  }
  nextWeapon(): void { this.cycleWeapon(1); }
  previousWeapon(): void { this.cycleWeapon(-1); }
  private cycleWeapon(direction: 1 | -1): void {
    const snap = this.state.snap;
    if (snap === null || (snap.playerState.pmFlags & MoveFlags.FOLLOW) !== 0) return;
    this.state.weaponSelectTime = this.state.time;
    const original = this.state.weaponSelect;
    for (let i = 0; i < 16; i++) {
      this.state.weaponSelect = (this.state.weaponSelect + direction + 16) % 16;
      if (this.state.weaponSelect !== Weapon.WP_GAUNTLET && this.selectable(this.state.weaponSelect)) return;
    }
    this.state.weaponSelect = original;
  }
  selectWeapon(number: number): void {
    const snap = this.state.snap;
    if (snap === null || (snap.playerState.pmFlags & MoveFlags.FOLLOW) !== 0 || number < 1 || number > 15) return;
    this.state.weaponSelectTime = this.state.time;
    if ((snap.playerState.stats.get(statSchema(this.state.product).weapons) & (1 << number)) !== 0) this.state.weaponSelect = number;
  }
  outOfAmmoChange(): void {
    this.state.weaponSelectTime = this.state.time;
    for (let i = 15; i > 0; i--) if (this.selectable(i)) { this.state.weaponSelect = i; return; }
  }
}

type WeaponModelName = "machinegunBrass" | "shotgunBrass" | "dishFlash" | "ringFlash" | "bulletFlash";
type WeaponShaderName = "smokePuff" | "nailPuff" | "shotgunSmokePuff" | "invis" | "battleWeapon" | "quadWeapon"
  | "select" | "noammo" | "holeMark" | "burnMark" | "energyMark" | "bulletMark" | "tracer";
type WeaponSoundName = "quad" | "nailHitFlesh" | "nailHitMetal" | "nailHit" | "proxExplosion"
  | "rocketExplosion" | "plasmaExplosion" | "chaingunHitFlesh" | "chaingunHitMetal" | "chaingunHit"
  | "ricochet1" | "ricochet2" | "ricochet3" | "tracer";
export interface WeaponPresentationMedia {
  readonly models: Readonly<Record<WeaponModelName, SceneModel>>;
  readonly shaders: Readonly<Record<WeaponShaderName, SceneShader | null>>;
  readonly sounds: Readonly<Record<WeaponSoundName, PcmSound | null>>;
}
export interface WeaponPresentationSettings {
  readonly brassTime: number; readonly railTrailTime: number; readonly oldRail: boolean; readonly noProjectileTrail: boolean;
  readonly oldPlasma: boolean; readonly oldRocket: boolean; readonly trueLightning: number;
  readonly drawGun: boolean; readonly fov: number; readonly gunX: number; readonly gunY: number; readonly gunZ: number; readonly gunFrame: number;
  readonly tracerLength: number; readonly tracerWidth: number; readonly tracerChance: number; readonly hardware: "generic" | "ragepro";
}
export interface WeaponSelectionDrawing {
  fadeColor(start: number, duration: number): Vec4 | null;
  setColor(color: Vec4 | null): void;
  drawPic(x: number, y: number, width: number, height: number, shader: SceneShader | null): void;
  drawStringLength(text: string): number;
  drawBigStringColor(x: number, y: number, text: string, color: Vec4): void;
}
export interface ClientWeaponHost extends Pick<PacketEntityImports, "addRefEntity" | "addLight" | "startSound" | "addLoopSound"> {
  readonly prediction: Pick<PredictionRuntime, "trace" | "pointContents" | "collision">;
  readonly random: Pick<GameRandom, "rand" | "random" | "crandom">;
  readonly localEntities: LocalEntityPool;
  readonly effects: Pick<ClientEffects, "smokePuff" | "bubbleTrail" | "makeExplosion" | "bleed">;
  readonly marks: Pick<ImpactMarkSystem, "impactMark">;
  readonly particles: Pick<ParticleSystem, "explosion">;
  readonly media: WeaponPresentationMedia;
  readonly drawing: WeaponSelectionDrawing;
  settings(): WeaponPresentationSettings;
  clientInfo(number: number): Pick<ClientInfo, "color1" | "color2" | "animations">;
  /** Source first-use registration executes synchronously from previously prepared bytes. */
  sound(path: string, compressed: false): PcmSound | null;
  addPoly(poly: RefPoly): void;
}
function identity(): Axis { return [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]; }
function ma(origin: Vec3, scale: number, direction: Vec3): Vec3 { return add3(origin, scale3(direction, scale)); }
function transform(value: Vec3, axis: Axis): Vec3 {
  return vec3(dot3(value, vec3(axis[0].x, axis[1].x, axis[2].x)), dot3(value, vec3(axis[0].y, axis[1].y, axis[2].y)), dot3(value, vec3(axis[0].z, axis[1].z, axis[2].z)));
}
function bytes(color: Vec3, scale: number, alpha: number): Vec4 {
  return vec4(qvmFloatToInt(f(color.x * scale)) & 255, qvmFloatToInt(f(color.y * scale)) & 255, qvmFloatToInt(f(color.z * scale)) & 255, alpha);
}
const WHITE_BYTES = vec4(255, 255, 255, 255), ZERO = vec3(0, 0, 0);
const POINT_BOUNDS = { min: ZERO, max: ZERO };
const CONTENTS_WATER = 32, MASK_SHOT = 1 | 0x2000000 | 0x4000000, SURF_NOIMPACT = 16, SURF_METALSTEPS = 4096;

export class ClientWeaponRuntime extends ClientWeaponSelection {
  constructor(state: ClientGameState, readonly registry: ClientWeaponMediaRegistry, readonly host: ClientWeaponHost) {
    super(state);
    if (state.product !== registry.product) throw new Error("Weapon media product differs from cgame state");
  }
  fireWeapon(cent: ClientEntity): void {
    const ent = cent.currentState;
    if (ent.weapon === Weapon.WP_NONE) return;
    if (ent.weapon >= (this.state.product === "baseq3" ? 11 : 14)) throw new CommonError("drop", "CG_FireWeapon: ent->weapon >= WP_NUM_WEAPONS");
    const weapon = this.registry.weapon(ent.weapon);
    cent.muzzleFlashTime = this.state.time;
    if (ent.weapon === Weapon.WP_LIGHTNING && cent.player.lightningFiring !== 0) return;
    if ((ent.powerups & (1 << Powerup.PW_QUAD)) !== 0) this.host.startSound(null, ent.number, 4, this.host.media.sounds.quad);
    const count = weapon.flashSounds.findIndex(sound => sound === null);
    const length = count < 0 ? 4 : count;
    if (length > 0) {
      const sound = weapon.flashSounds[this.host.random.rand() % length];
      if (sound === undefined) throw new Error("Invalid flash sound index");
      if (sound !== null) this.host.startSound(null, ent.number, 2, sound);
    }
    if (weapon.ejectBrass !== null && this.host.settings().brassTime > 0) this.ejectBrass(cent, weapon.ejectBrass);
  }
  private ejectBrass(cent: ClientEntity, kind: "machinegun" | "shotgun" | "nailgun"): void {
    const axis = anglesToAxis(cent.lerpAngles), time = this.state.time, random = this.host.random;
    if (kind === "nailgun") {
      const smoke = this.host.effects.smokePuff({ origin: add3(cent.lerpOrigin, transform(vec3(0, -12, 24), axis)), velocity: vec3(0, 0, 64),
        radius: 32, color: vec4(1, 1, 1, 0.33), duration: 700, startTime: time, fadeInTime: 0, flags: 0, shader: this.host.media.shaders.smokePuff });
      smoke.leType = "scale-fade"; return;
    }
    const brassTime = this.host.settings().brassTime;
    if (brassTime <= 0) return;
    const shotgun = kind === "shotgun";
    for (let i = 0; i < (shotgun ? 2 : 1); i++) {
      const ref = createModelEntity(this.host.media.models[shotgun ? "shotgunBrass" : "machinegunBrass"]);
      const le = this.host.localEntities.allocate("fragment", ref);
      const velocity = shotgun ? vec3(f(60 + f(60 * random.crandom())), f((i === 0 ? 40 : -40) + f(10 * random.crandom())), f(100 + f(50 * random.crandom())))
        : vec3(0, f(-50 + f(40 * random.crandom())), f(100 + f(50 * random.crandom())));
      le.startTime = time;
      le.endTime = qvmFloatToInt(f(f((time + Math.imul(brassTime, shotgun ? 3 : 1)) | 0) + f(f(shotgun ? brassTime : Math.trunc(brassTime / 4)) * random.random())));
      const posTime = shotgun ? time : (time - (random.rand() & 15)) | 0;
      ref.origin = add3(cent.lerpOrigin, transform(vec3(8, shotgun ? 0 : -4, 24), axis));
      const water = (this.host.prediction.pointContents(ref.origin, -1) & CONTENTS_WATER) !== 0 ? f(0.1) : 1;
      le.pos = { type: TrajectoryType.TR_GRAVITY, time: posTime, duration: 0, base: { ...ref.origin }, delta: scale3(transform(velocity, axis), water) };
      ref.axis = identity(); le.bounceFactor = shotgun ? f(0.3) : f(f(0.4) * water);
      le.angles = { type: TrajectoryType.TR_LINEAR, time, duration: 0, base: vec3(random.rand() & 31, random.rand() & 31, random.rand() & 31), delta: shotgun ? vec3(1, 0.5, 0) : vec3(2, 1, 0) };
      le.leFlags = LocalEntityFlags.TUMBLE; le.leBounceSoundType = "brass"; le.leMarkType = "none";
    }
  }
  railTrail(clientNum: number, start: MutableVec3, end: Vec3): void {
    const ci = this.host.clientInfo(clientNum), time = this.state.time, settings = this.host.settings();
    start.z = f(start.z - 4);
    let move: Vec3 = { ...start };
    const delta = sub3(end, start), length = length3(delta), direction = normalize3(delta), temp = perpendicularVector(direction);
    const axis = Array.from({ length: 36 }, (_, i) => rotatePointAroundVector(direction, temp, i * 10));
    const ref = createRailCoreEntity(), le = this.host.localEntities.allocate("fade-rgb", ref);
    le.startTime = time; le.endTime = qvmFloatToInt(f(f(time) + settings.railTrailTime)); le.lifeRate = f(1 / f((le.endTime - time) | 0));
    ref.shaderTime = f(f(time) / 1000); ref.customShader = this.registry.effects.railCoreShader;
    ref.origin = { ...start }; ref.oldOrigin = { ...end }; ref.shaderRGBA = bytes(ci.color1, 255, 255);
    le.color = vec4(f(ci.color1.x * f(0.75)), f(ci.color1.y * f(0.75)), f(ci.color1.z * f(0.75)), 1);
    move = ma(move, 20, direction); const step = scale3(direction, 5);
    if (settings.oldRail) { ref.origin = add3(ref.origin, vec3(0, 0, -8)); ref.oldOrigin = add3(ref.oldOrigin, vec3(0, 0, -8)); return; }
    let skip = -1, j = 18;
    for (let i = 0; i < length; i += 5) {
      if (i !== skip) {
        skip = i + 5;
        const ref = createSpriteEntity(), le = this.host.localEntities.allocate("move-scale-fade", ref), side = axis[j];
        if (side === undefined) throw new Error("Missing rail spiral axis");
        le.leFlags = LocalEntityFlags.PUFF_DONT_SCALE; le.startTime = time; le.endTime = (time + (i >> 1) + 600) | 0;
        le.lifeRate = f(1 / f((le.endTime - time) | 0)); ref.shaderTime = f(f(time) / 1000); ref.radius = f(1.1);
        ref.customShader = this.registry.effects.railRingsShader; ref.shaderRGBA = bytes(ci.color2, 255, 255);
        le.color = vec4(f(ci.color2.x * f(0.75)), f(ci.color2.y * f(0.75)), f(ci.color2.z * f(0.75)), 1);
        le.pos = { type: TrajectoryType.TR_LINEAR, time, duration: 0, base: ma(move, 4, side), delta: scale3(side, 6) };
      }
      move = add3(move, step); j = (j + 1) % 36;
    }
  }
  missileTrail(kind: MissileTrail, cent: ClientEntity, weapon: PacketWeaponInfo): void {
    if (kind === "grapple") { this.grappleTrail(cent, weapon); return; }
    if (kind === "plasma") { this.plasmaTrail(cent, weapon); return; }
    if (this.host.settings().noProjectileTrail) return;
    const es = cent.currentState, time = this.state.time;
    let t = Math.imul(50, Math.trunc(((cent.trailTime + 50) | 0) / 50));
    const origin = evaluateTrajectory(es.pos, time), contents = this.host.prediction.pointContents(origin, -1);
    if (es.pos.type === TrajectoryType.TR_STATIONARY) { cent.trailTime = time; return; }
    const previous = evaluateTrajectory(es.pos, cent.trailTime), lastContents = this.host.prediction.pointContents(previous, -1);
    cent.trailTime = time;
    if ((contents & (32 | 16 | 8)) !== 0) {
      if ((contents & lastContents & CONTENTS_WATER) !== 0) this.host.effects.bubbleTrail(previous, origin, 8);
      return;
    }
    for (; t <= time; t = (t + 50) | 0) {
      const smoke = this.host.effects.smokePuff({ origin: evaluateTrajectory(es.pos, t), velocity: ZERO, radius: weapon.trailRadius,
        color: vec4(1, 1, 1, 0.33), duration: weapon.trailTime, startTime: t, fadeInTime: 0, flags: 0,
        shader: this.host.media.shaders[kind === "nail" ? "nailPuff" : "smokePuff"] });
      smoke.leType = "scale-fade";
    }
  }
  private plasmaTrail(cent: ClientEntity, _weapon: PacketWeaponInfo): void {
    const settings = this.host.settings();
    if (settings.noProjectileTrail || settings.oldPlasma) return;
    const time = this.state.time, random = this.host.random, origin = evaluateTrajectory(cent.currentState.pos, time);
    const ref = createSpriteEntity(), le = this.host.localEntities.allocate("move-scale-fade", ref);
    const velocity = vec3(f(60 - f(120 * random.crandom())), f(40 - f(80 * random.crandom())), f(100 - f(200 * random.crandom())));
    le.leFlags = LocalEntityFlags.TUMBLE; le.startTime = time; le.endTime = (time + 600) | 0;
    const axis = anglesToAxis(cent.lerpAngles);
    ref.origin = add3(origin, transform(vec3(2, 2, 2), axis));
    const water = (this.host.prediction.pointContents(ref.origin, -1) & CONTENTS_WATER) !== 0 ? f(0.1) : 1;
    le.pos = { type: TrajectoryType.TR_GRAVITY, time, duration: 0, base: { ...ref.origin }, delta: scale3(transform(velocity, axis), water) };
    ref.shaderTime = f(f(time) / 1000); ref.radius = f(0.25); ref.customShader = this.registry.effects.railRingsShader;
    le.bounceFactor = f(0.3);
    const color = this.registry.weapon(cent.currentState.weapon).flashDlightColor;
    ref.shaderRGBA = bytes(color, 63, 63); le.color = vec4(f(color.x * f(0.2)), f(color.y * f(0.2)), f(color.z * f(0.2)), f(0.25));
    le.angles = { type: TrajectoryType.TR_LINEAR, time, duration: 0, base: vec3(random.rand() & 31, random.rand() & 31, random.rand() & 31), delta: vec3(1, 0.5, 0) };
  }
  grappleTrail(cent: ClientEntity, _weapon: PacketWeaponInfo): void {
    const origin = evaluateTrajectory(cent.currentState.pos, this.state.time); cent.trailTime = this.state.time;
    const owner = this.state.entityAt(cent.currentState.otherEntityNum), beam = createLightningEntity();
    beam.origin = ma(add3(owner.lerpOrigin, vec3(0, 0, 26)), -6, angleVectors(owner.lerpAngles).up); beam.oldOrigin = origin;
    if (length3(sub3(beam.origin, beam.oldOrigin)) < 64) return;
    beam.customShader = this.registry.effects.lightningShader; beam.shaderRGBA = WHITE_BYTES; this.host.addRefEntity(beam);
  }
  missileHitWall(weapon: Weapon, clientNum: number, origin: Vec3, direction: Vec3, soundType: ImpactSound): void {
    const media = this.host.media, effects = this.registry.effects;
    let mark: SceneShader | null = null, shader: SceneShader | null = null, model: SceneModel = DEFAULT_MODEL, sound: PcmSound | null = null;
    let radius = 32, light = 0, lightColor = vec3(1, 1, 0), sprite = false, duration = 600;
    const impactWeapon = this.state.product === "baseq3" && (weapon === Weapon.WP_PROX_LAUNCHER || weapon === Weapon.WP_CHAINGUN)
      ? Weapon.WP_NONE : weapon;
    switch (impactWeapon) {
      default:
      case Weapon.WP_NAILGUN:
        if (this.state.product === "missionpack") {
          sound = media.sounds[soundType === ImpactSound.FLESH ? "nailHitFlesh" : soundType === ImpactSound.METAL ? "nailHitMetal" : "nailHit"];
          mark = media.shaders.holeMark; radius = 12; break;
        }
        { const r = this.host.random.rand() & 3; sound = effects.lightningHitSounds[r < 2 ? 1 : r === 2 ? 0 : 2]; }
        mark = media.shaders.holeMark; radius = 12; break;
      case Weapon.WP_LIGHTNING: {
        const r = this.host.random.rand() & 3;
        sound = effects.lightningHitSounds[r < 2 ? 1 : r === 2 ? 0 : 2]; mark = media.shaders.holeMark; radius = 12; break;
      }
      case Weapon.WP_PROX_LAUNCHER:
        model = media.models.dishFlash; shader = effects.grenadeExplosionShader; sound = media.sounds.proxExplosion;
        mark = media.shaders.burnMark; radius = 64; light = 300; sprite = true; break;
      case Weapon.WP_GRENADE_LAUNCHER:
        model = media.models.dishFlash; shader = effects.grenadeExplosionShader; sound = media.sounds.rocketExplosion;
        mark = media.shaders.burnMark; radius = 64; light = 300; sprite = true; break;
      case Weapon.WP_ROCKET_LAUNCHER:
        model = media.models.dishFlash; shader = effects.rocketExplosionShader; sound = media.sounds.rocketExplosion;
        mark = media.shaders.burnMark; radius = 64; light = 300; sprite = true; duration = 1000; lightColor = vec3(1, 0.75, 0);
        if (!this.host.settings().oldRocket) this.host.particles.explosion({ animation: "explode1", origin: ma(origin, 24, direction), velocity: scale3(direction, 64), duration: 1400, sizeStart: 20, sizeEnd: 30 });
        break;
      case Weapon.WP_RAILGUN:
        model = media.models.ringFlash; shader = effects.railExplosionShader; sound = media.sounds.plasmaExplosion;
        mark = media.shaders.energyMark; radius = 24; break;
      case Weapon.WP_PLASMAGUN:
        model = media.models.ringFlash; shader = effects.plasmaExplosionShader; sound = media.sounds.plasmaExplosion;
        mark = media.shaders.energyMark; radius = 16; break;
      case Weapon.WP_BFG:
        model = media.models.dishFlash; shader = effects.bfgExplosionShader; sound = media.sounds.rocketExplosion;
        mark = media.shaders.burnMark; radius = 32; sprite = true; break;
      case Weapon.WP_SHOTGUN:
        model = media.models.bulletFlash; shader = effects.bulletExplosionShader; mark = media.shaders.bulletMark; radius = 4; break;
      case Weapon.WP_CHAINGUN: {
        model = media.models.bulletFlash;
        sound = media.sounds[soundType === ImpactSound.FLESH ? "chaingunHitFlesh" : soundType === ImpactSound.METAL ? "chaingunHitMetal" : "chaingunHit"];
        mark = media.shaders.bulletMark;
        const r = this.host.random.rand() & 3;
        sound = media.sounds[r < 2 ? "ricochet1" : r === 2 ? "ricochet2" : "ricochet3"]; radius = 8; break;
      }
      case Weapon.WP_MACHINEGUN: {
        model = media.models.bulletFlash; shader = effects.bulletExplosionShader; mark = media.shaders.bulletMark;
        const r = this.host.random.rand() & 3;
        sound = media.sounds[r === 0 ? "ricochet1" : r === 1 ? "ricochet2" : "ricochet3"]; radius = 8; break;
      }
    }
    if (sound !== null) this.host.startSound(origin, 1022, 0, sound);
    if (model.kind !== "default") {
      const le = this.host.effects.makeExplosion({ origin, direction, model, shader, duration, sprite });
      le.light = light; le.lightColor = lightColor;
      if (weapon === Weapon.WP_RAILGUN) {
        const color = this.host.clientInfo(clientNum).color1; le.color = vec4(color.x, color.y, color.z, le.color.w);
      }
    }
    const color = weapon === Weapon.WP_RAILGUN ? this.host.clientInfo(clientNum).color2 : vec3(1, 1, 1);
    this.host.marks.impactMark({ shader: mark, origin, direction, orientation: f(this.host.random.random() * 360), color: vec4(color.x, color.y, color.z, 1),
      alphaFade: mark === media.shaders.energyMark, radius, temporary: false });
  }
  missileHitPlayer(weapon: Weapon, origin: Vec3, direction: Vec3, entityNum: number): void {
    this.host.effects.bleed(origin, entityNum);
    if (weapon === Weapon.WP_GRENADE_LAUNCHER || weapon === Weapon.WP_ROCKET_LAUNCHER || (this.state.product === "missionpack"
      && (weapon === Weapon.WP_NAILGUN || weapon === Weapon.WP_CHAINGUN || weapon === Weapon.WP_PROX_LAUNCHER))) {
      this.missileHitWall(weapon, 0, origin, direction, ImpactSound.FLESH);
    }
  }
  private shotgunPellet(start: Vec3, end: Vec3, skipNumber: number): void {
    const prediction = this.host.prediction, trace = prediction.trace(start, end, POINT_BOUNDS, skipNumber, MASK_SHOT);
    const sourceContents = prediction.collision.pointContents(start), destContents = prediction.collision.pointContents(trace.end);
    if (sourceContents === destContents) {
      if ((sourceContents & CONTENTS_WATER) !== 0) this.host.effects.bubbleTrail(start, trace.end, 32);
    } else if ((sourceContents & CONTENTS_WATER) !== 0) {
      const water = prediction.collision.trace({ start: end, end: start, shape: { kind: "point" }, mask: CONTENTS_WATER });
      this.host.effects.bubbleTrail(start, water.end, 32);
    } else if ((destContents & CONTENTS_WATER) !== 0) {
      const water = prediction.collision.trace({ start, end, shape: { kind: "point" }, mask: CONTENTS_WATER });
      this.host.effects.bubbleTrail(trace.end, water.end, 32);
    }
    if ((trace.surfaceFlags & SURF_NOIMPACT) !== 0) return;
    const normal = trace.contact.kind === "plane" ? trace.contact.plane.normal : ZERO;
    if (this.state.entityAt(trace.entityNum).currentState.eType === EntityType.ET_PLAYER) this.missileHitPlayer(Weapon.WP_SHOTGUN, trace.end, normal, trace.entityNum);
    else this.missileHitWall(Weapon.WP_SHOTGUN, 0, trace.end, normal, (trace.surfaceFlags & SURF_METALSTEPS) !== 0 ? ImpactSound.METAL : ImpactSound.DEFAULT);
  }
  shotgunFire(es: import("../shared/entity-state.ts").EntityState): void {
    const origin = ma(es.pos.base, 32, normalize3(sub3(es.origin2, es.pos.base)));
    if (this.host.settings().hardware !== "ragepro" && (this.host.prediction.collision.pointContents(es.pos.base) & CONTENTS_WATER) === 0) {
      this.host.effects.smokePuff({ origin, velocity: vec3(0, 0, 8), radius: 32, color: vec4(1, 1, 1, 0.33), duration: 900,
        startTime: this.state.time, fadeInTime: 0, flags: LocalEntityFlags.PUFF_DONT_SCALE, shader: this.host.media.shaders.shotgunSmokePuff });
    }
    const forward = normalize3OrZero(es.origin2), right = perpendicularVector(forward), up = cross3(forward, right);
    let seed = es.eventParm;
    for (let i = 0; i < 11; i++) {
      const r = qCrandom(seed); seed = r.seed; const u = qCrandom(seed); seed = u.seed;
      this.shotgunPellet(es.pos.base, ma(ma(ma(es.pos.base, 8192 * 16, forward), f(f(r.value * 700) * 16), right), f(f(u.value * 700) * 16), up), es.otherEntityNum);
    }
  }
  private muzzlePoint(entityNum: number): Vec3 | null {
    const snap = this.state.snap;
    if (snap === null) throw new Error("CG_CalcMuzzlePoint: cg.snap == NULL");
    if (entityNum === snap.playerState.clientNum) {
      return ma(add3(snap.playerState.origin, vec3(0, 0, snap.playerState.viewheight)), 14, angleVectors(snap.playerState.viewangles).forward);
    }
    const cent = this.state.entityAt(entityNum);
    if (!cent.currentValid) return null;
    const es = cent.currentState, anim = es.legsAnim & ~128;
    return ma(add3(es.pos.base, vec3(0, 0, anim === PlayerAnimation.LEGS_WALKCR || anim === PlayerAnimation.LEGS_IDLECR ? 12 : 26)), 14, angleVectors(es.apos.base).forward);
  }
  bullet(end: Vec3, source: number, hit: BulletHit): void {
    if (source >= 0 && this.host.settings().tracerChance > 0) {
      const start = this.muzzlePoint(source);
      if (start !== null) {
        const collision = this.host.prediction.collision, a = collision.pointContents(start), b = collision.pointContents(end);
        if (a === b && (a & CONTENTS_WATER) !== 0) this.host.effects.bubbleTrail(start, end, 32);
        else if ((a & CONTENTS_WATER) !== 0) {
          const water = collision.trace({ start: end, end: start, shape: { kind: "point" }, mask: CONTENTS_WATER }); this.host.effects.bubbleTrail(start, water.end, 32);
        } else if ((b & CONTENTS_WATER) !== 0) {
          const water = collision.trace({ start, end, shape: { kind: "point" }, mask: CONTENTS_WATER }); this.host.effects.bubbleTrail(water.end, end, 32);
        }
        if (this.host.random.random() < this.host.settings().tracerChance) this.tracer(start, end);
      }
    }
    if (hit.kind === "flesh") this.host.effects.bleed(end, hit.entityNum);
    else this.missileHitWall(Weapon.WP_MACHINEGUN, 0, end, hit.normal, ImpactSound.DEFAULT);
  }
  tracer(source: Vec3, destination: Vec3): void {
    const delta = sub3(destination, source), length = length3(delta), forward = normalize3(delta);
    if (length < 100) return;
    const settings = this.host.settings(), begin = f(50 + f(this.host.random.random() * f(length - 60)));
    const end = Math.min(f(begin + settings.tracerLength), length), start = ma(source, begin, forward), finish = ma(source, end, forward);
    const axis = this.state.refdef.viewAxis;
    const right = normalize3(ma(scale3(axis[1], dot3(forward, axis[2])), -dot3(forward, axis[1]), axis[2]));
    this.host.addPoly({ shader: this.host.media.shaders.tracer, vertices: [
      { position: ma(finish, settings.tracerWidth, right), texCoord: { x: 0, y: 1 }, color: WHITE_BYTES },
      { position: ma(finish, -settings.tracerWidth, right), texCoord: { x: 1, y: 0 }, color: WHITE_BYTES },
      { position: ma(start, -settings.tracerWidth, right), texCoord: { x: 1, y: 1 }, color: WHITE_BYTES },
      { position: ma(start, settings.tracerWidth, right), texCoord: { x: 0, y: 0 }, color: WHITE_BYTES },
    ] });
    this.host.startSound(scale3(add3(start, finish), 0.5), 1022, 0, this.host.media.sounds.tracer);
  }
  private lightningBolt(cent: ClientEntity, origin: Vec3): void {
    if (cent.currentState.weapon !== Weapon.WP_LIGHTNING) return;
    let angles = cent.lerpAngles;
    const trueLightning = this.host.settings().trueLightning;
    if (cent.currentState.number === this.state.predictedPlayerState.clientNum && trueLightning !== 0) {
      const blend = (actual: number, view: number): number => {
        let a = f(actual - view); if (a > 180) a = f(a - 360); if (a < -180) a = f(a + 360);
        let angle = f(view + f(a * f(1 - trueLightning))); if (angle < 0) angle = f(angle + 360); if (angle > 360) angle = f(angle - 360); return angle;
      };
      const view = this.state.refdefViewAngles; angles = vec3(blend(angles.x, view.x), blend(angles.y, view.y), blend(angles.z, view.z));
    }
    const forward = angleVectors(angles).forward, muzzle = ma(add3(cent.lerpOrigin, vec3(0, 0, 26)), 14, forward);
    const trace = this.host.prediction.trace(muzzle, ma(muzzle, 768, forward), POINT_BOUNDS, cent.currentState.number, MASK_SHOT);
    const beam = createLightningEntity(); beam.origin = { ...origin }; beam.oldOrigin = { ...trace.end };
    beam.customShader = this.registry.effects.lightningShader; this.host.addRefEntity(beam);
    if (trace.fraction < 1) {
      const ref = createModelEntity(this.registry.effects.lightningExplosionModel);
      ref.origin = ma(trace.end, -16, normalize3(sub3(beam.oldOrigin, beam.origin)));
      ref.axis = anglesToAxis(vec3(this.host.random.rand() % 360, this.host.random.rand() % 360, this.host.random.rand() % 360));
      this.host.addRefEntity(ref);
    }
  }
  private spinAngle(cent: ClientEntity): number {
    const player = cent.player;
    let delta = (this.state.time - player.barrelTime) | 0, angle: number;
    if (player.barrelSpinning) angle = f(player.barrelAngle + f(f(delta) * f(0.9)));
    else {
      if (delta > 1000) delta = 1000;
      const speed = f(f(0.5) * f(f(0.9) + f(f((1000 - delta) | 0) / 1000)));
      angle = f(player.barrelAngle + f(f(delta) * speed));
    }
    const firing = (cent.currentState.eFlags & 256) !== 0;
    if (player.barrelSpinning !== firing) {
      player.barrelTime = this.state.time; player.barrelAngle = angleMod(angle); player.barrelSpinning = firing;
      if (this.state.product === "missionpack" && cent.currentState.weapon === Weapon.WP_CHAINGUN && !firing) {
        this.host.startSound(null, cent.currentState.number, 2, this.host.sound("sound/weapons/vulcan/wvulwind.wav", false));
      }
    }
    return angle;
  }
  private addWeaponWithPowerups(gun: RefModelEntity, powerups: number): void {
    const shaders = this.host.media.shaders;
    if ((powerups & (1 << Powerup.PW_INVIS)) !== 0) { gun.customShader = shaders.invis; this.host.addRefEntity(gun); return; }
    this.host.addRefEntity(gun);
    if ((powerups & (1 << Powerup.PW_BATTLESUIT)) !== 0) { gun.customShader = shaders.battleWeapon; this.host.addRefEntity(gun); }
    if ((powerups & (1 << Powerup.PW_QUAD)) !== 0) { gun.customShader = shaders.quadWeapon; this.host.addRefEntity(gun); }
  }
  addPlayerWeapon(parent: RefModelEntity, ps: SourcePlayerState | null, cent: ClientEntity, _team: Team): void {
    const weaponNum = cent.currentState.weapon, weapon = this.registry.requireWeapon(weaponNum), state = this.state;
    const attached = (model: SceneModel): RefModelEntity => {
      const ref = createModelEntity(model); ref.lightingOrigin = { ...parent.lightingOrigin }; ref.shadowPlane = parent.shadowPlane; ref.renderFlags = parent.renderFlags; return ref;
    };
    const gun = attached(weapon.weaponModel);
    if (ps !== null) {
      if (state.predictedPlayerState.weapon === Weapon.WP_RAILGUN && state.predictedPlayerState.weaponState === WeaponState.WEAPON_FIRING) {
        const fraction = f(f(state.predictedPlayerState.weaponTime) / 1500), color = qvmFloatToInt(f(255 * f(1 - fraction))) & 255;
        gun.shaderRGBA = vec4(color, 0, color, 0);
      } else gun.shaderRGBA = WHITE_BYTES;
    }
    if (gun.model.kind === "default") return;
    if (ps === null) {
      cent.player.lightningFiring = 0;
      if ((cent.currentState.eFlags & 256) !== 0 && weapon.firingSound !== null) {
        this.host.addLoopSound(cent.currentState.number, cent.lerpOrigin, ZERO, weapon.firingSound, false); cent.player.lightningFiring = 1;
      } else if (weapon.readySound !== null) this.host.addLoopSound(cent.currentState.number, cent.lerpOrigin, ZERO, weapon.readySound, false);
    }
    positionEntityOnTag(gun, parent, parent.model, "tag_weapon"); this.addWeaponWithPowerups(gun, cent.currentState.powerups);
    if (weapon.barrelModel !== null) {
      const barrel = attached(weapon.barrelModel); barrel.axis = anglesToAxis(vec3(0, 0, this.spinAngle(cent)));
      positionRotatedEntityOnTag(barrel, gun, weapon.weaponModel, "tag_barrel"); this.addWeaponWithPowerups(barrel, cent.currentState.powerups);
    }
    const nonPredicted = state.entityAt(cent.currentState.clientNum);
    if (!((weaponNum === Weapon.WP_LIGHTNING || weaponNum === Weapon.WP_GAUNTLET || weaponNum === Weapon.WP_GRAPPLING_HOOK)
      && (nonPredicted.currentState.eFlags & 256) !== 0)) {
      if (((state.time - cent.muzzleFlashTime) | 0) > 20 && !cent.player.railgunFlash) return;
    }
    const flash = attached(weapon.flashModel);
    if (flash.model.kind === "default") return;
    flash.axis = anglesToAxis(vec3(0, 0, f(this.host.random.crandom() * 10)));
    if (weaponNum === Weapon.WP_RAILGUN) flash.shaderRGBA = bytes(this.host.clientInfo(cent.currentState.clientNum).color1, 255, 0);
    positionRotatedEntityOnTag(flash, gun, weapon.weaponModel, "tag_flash"); this.host.addRefEntity(flash);
    if (ps !== null || state.renderingThirdPerson || cent.currentState.number !== state.predictedPlayerState.clientNum) {
      this.lightningBolt(nonPredicted, flash.origin);
      if (weaponNum === Weapon.WP_RAILGUN && cent.player.railgunFlash) {
        cent.player.railgunFlash = true;
        this.railTrail(cent.currentState.clientNum, flash.origin, cent.player.railgunImpact);
      }
      const color = weapon.flashDlightColor;
      if (color.x !== 0 || color.y !== 0 || color.z !== 0) this.host.addLight({ origin: flash.origin, radius: 300 + (this.host.random.rand() & 31), color });
    }
  }
  private weaponPosition(): { readonly origin: Vec3; readonly angles: Vec3 } {
    const state = this.state, scale = (state.bobCycle & 1) !== 0 ? -state.xyspeed : state.xyspeed;
    const roll = f(f(scale * state.bobFracSin) * f(0.005)), yaw = f(f(scale * state.bobFracSin) * f(0.01));
    const pitch = f(f(state.xyspeed * state.bobFracSin) * f(0.005));
    let origin = { ...state.refdef.viewOrigin }, angles = add3(state.refdefViewAngles, vec3(pitch, yaw, roll));
    const delta = (state.time - state.landTime) | 0;
    if (delta < 150) origin = add3(origin, vec3(0, 0, f(f(f(state.landChange * f(0.25)) * f(delta)) / 150)));
    else if (delta < 450) origin = add3(origin, vec3(0, 0, f(f(f(state.landChange * f(0.25)) * f((450 - delta) | 0)) / 300)));
    const drift = f(f(f(state.xyspeed + 40) * f(Math.sin(f(f(state.time) * f(0.001))))) * f(0.01));
    angles = add3(angles, vec3(drift, drift, drift)); return { origin, angles };
  }
  private mapTorsoFrame(clientNum: number, frame: number): number {
    const animations = this.host.clientInfo(clientNum).animations;
    for (const index of [PlayerAnimation.TORSO_DROP, PlayerAnimation.TORSO_ATTACK, PlayerAnimation.TORSO_ATTACK2]) {
      const animation = animations[index];
      if (animation === undefined || animation === null) throw new Error(`Missing weapon torso animation ${index}`);
      if (frame >= animation.firstFrame && frame < animation.firstFrame + (index === PlayerAnimation.TORSO_DROP ? 9 : 6)) {
        return frame - animation.firstFrame + (index === PlayerAnimation.TORSO_DROP ? 6 : 1);
      }
    }
    return 0;
  }
  addViewWeapon(ps: SourcePlayerState): void {
    const state = this.state;
    if (ps.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR || ps.pmType === MoveType.PM_INTERMISSION || state.renderingThirdPerson) return;
    const settings = this.host.settings();
    if (!settings.drawGun) {
      if ((state.predictedPlayerState.eFlags & 256) !== 0) this.lightningBolt(state.entityAt(ps.clientNum), ma(state.refdef.viewOrigin, -8, state.refdef.viewAxis[2]));
      return;
    }
    if (state.testGun) return;
    const offset = settings.fov > 90 ? f(f(-0.2) * f((settings.fov - 90) | 0)) : 0;
    const cent = state.predictedPlayerEntity, weapon = this.registry.requireWeapon(ps.weapon), hand = createModelEntity(weapon.handsModel), position = this.weaponPosition();
    hand.origin = ma(ma(ma(position.origin, settings.gunX, state.refdef.viewAxis[0]), settings.gunY, state.refdef.viewAxis[1]), f(settings.gunZ + offset), state.refdef.viewAxis[2]);
    hand.axis = anglesToAxis(position.angles);
    if (settings.gunFrame !== 0) { hand.frame = settings.gunFrame; hand.oldFrame = settings.gunFrame; hand.backLerp = 0; }
    else {
      hand.frame = this.mapTorsoFrame(cent.currentState.clientNum, cent.player.torso.frame);
      hand.oldFrame = this.mapTorsoFrame(cent.currentState.clientNum, cent.player.torso.oldFrame); hand.backLerp = cent.player.torso.backLerp;
    }
    hand.renderFlags = RF_DEPTHHACK | RF_FIRST_PERSON | RF_MINLIGHT;
    const team = ps.persistant.get(PersistentIndex.PERS_TEAM);
    if (team !== Team.TEAM_FREE && team !== Team.TEAM_RED && team !== Team.TEAM_BLUE && team !== Team.TEAM_SPECTATOR) throw new RangeError("Invalid view weapon team");
    this.addPlayerWeapon(hand, ps, cent, team);
  }
  drawWeaponSelect(): void {
    if (this.state.predictedPlayerState.health <= 0) return;
    const drawing = this.host.drawing, color = drawing.fadeColor(this.state.weaponSelectTime, 1400);
    if (color === null) return;
    drawing.setColor(color); this.state.itemPickupTime = 0;
    const snap = this.state.snap;
    if (snap === null) throw new Error("CG_DrawWeaponSelect: cg.snap == NULL");
    const bits = snap.playerState.stats.get(statSchema(this.state.product).weapons);
    let count = 0; for (let i = 1; i < 16; i++) if ((bits & (1 << i)) !== 0) count++;
    let x = 320 - count * 20;
    for (let i = 1; i < 16; i++) {
      if ((bits & (1 << i)) === 0) continue;
      drawing.drawPic(x, 380, 32, 32, this.registry.requireWeapon(i).weaponIcon);
      if (i === this.state.weaponSelect) drawing.drawPic(x - 4, 376, 40, 40, this.host.media.shaders.select);
      if (snap.playerState.ammo.get(i) === 0) drawing.drawPic(x, 380, 32, 32, this.host.media.shaders.noammo);
      x += 40;
    }
    const item = this.registry.weapon(this.state.weaponSelect).item;
    if (item !== null && item.pickupName !== null) {
      const width = drawing.drawStringLength(item.pickupName) * 16;
      drawing.drawBigStringColor(Math.trunc((640 - width) / 2), 358, item.pickupName, color);
    }
    drawing.setColor(null);
  }
}
type MutableWeaponInfo = { -readonly [K in keyof ClientWeaponInfo]: ClientWeaponInfo[K] };

function emptyWeapon(): MutableWeaponInfo {
  return { item: null, weaponModel: DEFAULT_MODEL, weaponMidpoint: vec3(0, 0, 0), barrelModel: null,
    missileModel: DEFAULT_MODEL, missileRenderfx: 0, missileSound: null, missileDlight: 0, missileDlightColor: vec3(0, 0, 0),
    missileTrail: null, trailRadius: 0, trailTime: 0, handsModel: DEFAULT_MODEL, flashModel: DEFAULT_MODEL,
    ammoModel: DEFAULT_MODEL, weaponIcon: null, ammoIcon: null, flashDlightColor: vec3(0, 0, 0),
    flashSounds: [null, null, null, null], ejectBrass: null, readySound: null, firingSound: null, loopFireSound: false };
}

/** Only handles registered by CG_RegisterWeapon; other cgs.media belongs to its loading owner. */
export class RegisteredWeaponEffects {
  lightningShader: SceneShader | null = null;
  lightningExplosionModel: SceneModel = DEFAULT_MODEL;
  lightningHitSounds: readonly [PcmSound | null, PcmSound | null, PcmSound | null] = [null, null, null];
  bulletExplosionShader: SceneShader | null = null;
  rocketExplosionShader: SceneShader | null = null;
  grenadeExplosionShader: SceneShader | null = null;
  plasmaExplosionShader: SceneShader | null = null;
  railExplosionShader: SceneShader | null = null;
  bfgExplosionShader: SceneShader | null = null;
  railRingsShader: SceneShader | null = null;
  railCoreShader: SceneShader | null = null;
}

export interface WeaponRegistrationAudio {
  registerSound(path: string, compressed: false): Promise<PcmSound | null>;
}

/** C's synchronous registration recursion is serialized at the asynchronous asset boundary. */
export class ClientWeaponMediaRegistry {
  private readonly weaponRecords = Array.from({ length: 16 }, emptyWeapon);
  private readonly itemRecords: PacketItemVisual[];
  private readonly registeredWeapons = new Set<number>();
  private readonly readyWeapons = new Set<number>();
  private readonly registeredItems = new Set<number>();
  private registration: Promise<void> = Promise.resolve();
  readonly effects = new RegisteredWeaponEffects();

  constructor(readonly product: Product, readonly resources: RendererResources, readonly audio: WeaponRegistrationAudio) {
    this.itemRecords = itemList(product).map(() => ({ models: [DEFAULT_MODEL, null], icon: null }));
  }
  get weapons(): readonly ClientWeaponInfo[] { return this.weaponRecords; }
  get items(): readonly PacketItemVisual[] { return this.itemRecords; }
  weapon(number: number): ClientWeaponInfo {
    const weapon = this.weaponRecords[number];
    if (weapon === undefined) throw new RangeError(`Invalid weapon media index ${number}`);
    return weapon;
  }
  requireWeapon(number: number): ClientWeaponInfo {
    if (number !== 0 && !this.readyWeapons.has(number)) throw new Error(`Weapon ${number} must finish registration before synchronous presentation`);
    return this.weapon(number);
  }
  registerWeapon(number: number): Promise<void> {
    this.registration = this.registration.then(() => this.registerWeaponNow(number));
    return this.registration;
  }
  registerItemVisuals(number: number): Promise<void> {
    this.registration = this.registration.then(() => this.registerItemNow(number));
    return this.registration;
  }
  private async registerItemNow(number: number): Promise<void> {
    const count = itemList(this.product).length;
    if (number < 0 || number >= count) throw new CommonError("drop", `CG_RegisterItemVisuals: itemNum ${number} out of range [0-${count - 1}]`);
    const item = itemAt(this.product, number);
    if (this.registeredItems.has(number)) return;
    this.registeredItems.add(number);
    const model = item.worldModels[0] === null ? DEFAULT_MODEL : await this.resources.registerModel(item.worldModels[0]);
    const icon = item.icon === null ? null : await this.resources.registerShader(item.icon);
    this.itemRecords[number] = { models: [model, null], icon };
    if (item.type === ItemType.IT_WEAPON) await this.registerWeaponNow(item.tag);
    if ((item.type === ItemType.IT_POWERUP || item.type === ItemType.IT_HEALTH || item.type === ItemType.IT_ARMOR
      || item.type === ItemType.IT_HOLDABLE) && item.worldModels[1] !== null) {
      this.itemRecords[number] = { models: [model, await this.resources.registerModel(item.worldModels[1])], icon };
    }
  }
  private async registerWeaponNow(number: number): Promise<void> {
    this.weapon(number);
    if (number === 0 || this.registeredWeapons.has(number)) return;
    this.registeredWeapons.add(number);
    const items = itemList(this.product);
    const index = items.findIndex(item => item.type === ItemType.IT_WEAPON && item.tag === number);
    if (index < 0) throw new CommonError("drop", `Couldn't find weapon ${number}`);
    const item = itemAt(this.product, index);
    const weapon = emptyWeapon();
    weapon.item = item;
    this.weaponRecords[number] = weapon;
    await this.registerItemNow(index);
    const path = item.worldModels[0];
    if (path === null || item.icon === null) throw new Error(`Weapon ${number} has no world model or icon`);
    weapon.weaponModel = await this.resources.registerModel(path);
    const model = weapon.weaponModel;
    const bounds = modelBounds(model);
    weapon.weaponMidpoint = vec3(f(bounds.min.x + f(0.5 * f(bounds.max.x - bounds.min.x))),
      f(bounds.min.y + f(0.5 * f(bounds.max.y - bounds.min.y))), f(bounds.min.z + f(0.5 * f(bounds.max.z - bounds.min.z))));
    weapon.weaponIcon = await this.resources.registerShader(item.icon);
    weapon.ammoIcon = await this.resources.registerShader(item.icon);
    const ammo = items.find(candidate => candidate.type === ItemType.IT_AMMO && candidate.tag === number);
    if (ammo !== undefined && ammo.worldModels[0] !== null) weapon.ammoModel = await this.resources.registerModel(ammo.worldModels[0]);
    const dot = path.indexOf("."), stem = dot < 0 ? path : path.slice(0, dot);
    weapon.flashModel = await this.resources.registerModel(`${stem}_flash.md3`);
    const barrel = await this.resources.registerModel(`${stem}_barrel.md3`);
    weapon.barrelModel = barrel.kind === "default" ? null : barrel;
    weapon.handsModel = await this.resources.registerModel(`${stem}_hand.md3`);
    if (weapon.handsModel.kind === "default") weapon.handsModel = await this.resources.registerModel("models/weapons2/shotgun/shotgun_hand.md3");
    await this.registerWeaponSpecific(number, weapon);
    this.readyWeapons.add(number);
  }
  private async registerWeaponSpecific(number: number, weapon: MutableWeaponInfo): Promise<void> {
    const sound = (path: string) => this.audio.registerSound(path, false);
    const shader = (name: string) => this.resources.registerShader(name);
    const model = (name: string) => this.resources.registerModel(name);
    const flash = async (path: string): Promise<void> => { weapon.flashSounds = [await sound(path), null, null, null]; };
    switch (number) {
      case Weapon.WP_GAUNTLET:
        weapon.flashDlightColor = vec3(0.6, 0.6, 1); weapon.firingSound = await sound("sound/weapons/melee/fstrun.wav");
        await flash("sound/weapons/melee/fstatck.wav"); break;
      case Weapon.WP_LIGHTNING:
        weapon.flashDlightColor = vec3(0.6, 0.6, 1); weapon.readySound = await sound("sound/weapons/melee/fsthum.wav");
        weapon.firingSound = await sound("sound/weapons/lightning/lg_hum.wav"); await flash("sound/weapons/lightning/lg_fire.wav");
        this.effects.lightningShader = await shader("lightningBoltNew");
        this.effects.lightningExplosionModel = await model("models/weaphits/crackle.md3");
        this.effects.lightningHitSounds = [await sound("sound/weapons/lightning/lg_hit.wav"), await sound("sound/weapons/lightning/lg_hit2.wav"), await sound("sound/weapons/lightning/lg_hit3.wav")]; break;
      case Weapon.WP_GRAPPLING_HOOK:
        weapon.flashDlightColor = vec3(0.6, 0.6, 1); weapon.missileModel = await model("models/ammo/rocket/rocket.md3");
        weapon.missileTrail = "grapple"; weapon.missileDlight = 200; weapon.trailTime = 2000; weapon.trailRadius = 64;
        weapon.missileDlightColor = vec3(1, 0.75, 0); weapon.readySound = await sound("sound/weapons/melee/fsthum.wav");
        weapon.firingSound = await sound("sound/weapons/melee/fstrun.wav"); break;
      case Weapon.WP_CHAINGUN:
        weapon.firingSound = await sound("sound/weapons/vulcan/wvulfire.wav"); weapon.loopFireSound = true;
        weapon.flashDlightColor = vec3(1, 1, 0);
        weapon.flashSounds = [await sound("sound/weapons/vulcan/vulcanf1b.wav"), await sound("sound/weapons/vulcan/vulcanf2b.wav"), await sound("sound/weapons/vulcan/vulcanf3b.wav"), await sound("sound/weapons/vulcan/vulcanf4b.wav")];
        weapon.ejectBrass = "machinegun"; this.effects.bulletExplosionShader = await shader("bulletExplosion"); break;
      case Weapon.WP_MACHINEGUN:
        weapon.flashDlightColor = vec3(1, 1, 0);
        weapon.flashSounds = [await sound("sound/weapons/machinegun/machgf1b.wav"), await sound("sound/weapons/machinegun/machgf2b.wav"), await sound("sound/weapons/machinegun/machgf3b.wav"), await sound("sound/weapons/machinegun/machgf4b.wav")];
        weapon.ejectBrass = "machinegun"; this.effects.bulletExplosionShader = await shader("bulletExplosion"); break;
      case Weapon.WP_SHOTGUN:
        weapon.flashDlightColor = vec3(1, 1, 0); await flash("sound/weapons/shotgun/sshotf1b.wav"); weapon.ejectBrass = "shotgun"; break;
      case Weapon.WP_ROCKET_LAUNCHER:
        weapon.missileModel = await model("models/ammo/rocket/rocket.md3"); weapon.missileSound = await sound("sound/weapons/rocket/rockfly.wav");
        weapon.missileTrail = "rocket"; weapon.missileDlight = 200; weapon.trailTime = 2000; weapon.trailRadius = 64;
        weapon.missileDlightColor = vec3(1, 0.75, 0); weapon.flashDlightColor = vec3(1, 0.75, 0);
        await flash("sound/weapons/rocket/rocklf1a.wav"); this.effects.rocketExplosionShader = await shader("rocketExplosion"); break;
      case Weapon.WP_PROX_LAUNCHER:
      case Weapon.WP_GRENADE_LAUNCHER:
        weapon.missileModel = await model(number === Weapon.WP_PROX_LAUNCHER ? "models/weaphits/proxmine.md3" : "models/ammo/grenade1.md3");
        weapon.missileTrail = "grenade"; weapon.trailTime = 700; weapon.trailRadius = 32; weapon.flashDlightColor = vec3(1, 0.7, 0);
        await flash(number === Weapon.WP_PROX_LAUNCHER ? "sound/weapons/proxmine/wstbfire.wav" : "sound/weapons/grenade/grenlf1a.wav");
        this.effects.grenadeExplosionShader = await shader("grenadeExplosion"); break;
      case Weapon.WP_NAILGUN:
        weapon.ejectBrass = "nailgun"; weapon.missileTrail = "nail"; weapon.trailRadius = 16; weapon.trailTime = 250;
        weapon.missileModel = await model("models/weaphits/nail.md3"); weapon.flashDlightColor = vec3(1, 0.75, 0);
        await flash("sound/weapons/nailgun/wnalfire.wav"); break;
      case Weapon.WP_PLASMAGUN:
        weapon.missileTrail = "plasma"; weapon.missileSound = await sound("sound/weapons/plasma/lasfly.wav");
        weapon.flashDlightColor = vec3(0.6, 0.6, 1); await flash("sound/weapons/plasma/hyprbf1a.wav");
        this.effects.plasmaExplosionShader = await shader("plasmaExplosion"); this.effects.railRingsShader = await shader("railDisc"); break;
      case Weapon.WP_RAILGUN:
        weapon.readySound = await sound("sound/weapons/railgun/rg_hum.wav"); weapon.flashDlightColor = vec3(1, 0.5, 0);
        await flash("sound/weapons/railgun/railgf1a.wav"); this.effects.railExplosionShader = await shader("railExplosion");
        this.effects.railRingsShader = await shader("railDisc"); this.effects.railCoreShader = await shader("railCore"); break;
      case Weapon.WP_BFG:
        weapon.readySound = await sound("sound/weapons/bfg/bfg_hum.wav"); weapon.flashDlightColor = vec3(1, 0.7, 1);
        await flash("sound/weapons/bfg/bfg_fire.wav"); this.effects.bfgExplosionShader = await shader("bfgExplosion");
        weapon.missileModel = await model("models/weaphits/bfg.md3"); weapon.missileSound = await sound("sound/weapons/rocket/rockfly.wav"); break;
      default:
        weapon.flashDlightColor = vec3(1, 1, 1); await flash("sound/weapons/rocket/rocklf1a.wav"); break;
    }
  }
}
