// Effect constructors from id Software's code/cgame/cg_effects.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import { add3, cross3, length3, normalize3, perpendicularVector, scale3, sub3, vec3, vec4 } from "../core/math.ts";
import type { Axis, Vec3, Vec4 } from "../core/math.ts";
import { qRandom, qvmFloatToInt } from "../core/numeric.ts";
import { qvmAnglesToAxis as anglesToAxis, qvmRotatePointAroundVector as rotatePointAroundVector } from "../core/qvm-math.ts";
import { createModelEntity, createSpriteEntity, createLightningEntity, RF_THIRD_PERSON } from "../render/ref-entity.ts";
import type { SceneModel, SceneShader } from "../render/ref-entity.ts";
import { TrajectoryType } from "../shared/trajectory.ts";
import type { ClientGameState } from "./state.ts";
import { LocalEntityFlags } from "./local-entities.ts";
import type { LocalEntityPool, ModelLocalEntity, PassiveLocalEntity, ShadedLocalEntity, SpriteLocalEntity } from "./local-entities.ts";

export interface MissionEffectMedia {
  readonly lightningShader: SceneShader | null;
  readonly kamikazeEffectModel: SceneModel;
  readonly dishFlashModel: SceneModel;
  readonly rocketExplosionShader: SceneShader | null;
  readonly obeliskHitSounds: readonly [PcmSound | null, PcmSound | null, PcmSound | null];
  readonly invulnerabilityImpactModel: SceneModel;
  readonly invulnerabilityImpactSounds: readonly [PcmSound | null, PcmSound | null, PcmSound | null];
  readonly invulnerabilityJuicedModel: SceneModel;
  readonly invulnerabilityJuicedSound: PcmSound | null;
}
export interface EffectMedia {
  readonly waterBubbleShader: SceneShader | null;
  readonly smokePuffRageProShader: SceneShader | null;
  readonly bloodExplosionShader: SceneShader | null;
  readonly teleportEffectModel: SceneModel;
  readonly gibSkull: SceneModel; readonly gibBrain: SceneModel; readonly gibAbdomen: SceneModel;
  readonly gibArm: SceneModel; readonly gibChest: SceneModel; readonly gibFist: SceneModel;
  readonly gibFoot: SceneModel; readonly gibForearm: SceneModel; readonly gibIntestine: SceneModel; readonly gibLeg: SceneModel;
  readonly smoke2: SceneModel;
  readonly variant: { readonly product: "baseq3"; readonly teleportEffectShader: SceneShader | null }
    | { readonly product: "missionpack"; readonly media: MissionEffectMedia };
}
export interface EffectOptions {
  readonly noProjectileTrail: boolean; readonly blood: boolean; readonly gibs: boolean; readonly scorePlum: boolean;
  readonly hardware: "generic" | "ragepro";
}
export interface EffectImports {
  /** The cgame VM rand() stream, shared with its other consumers, returning 0..32767. */
  randomInteger(): number;
  startSound(origin: Vec3, entity: number, channel: number, sound: PcmSound | null): void;
}
export interface SmokePuffOptions {
  readonly origin: Vec3; readonly velocity: Vec3; readonly radius: number; readonly color: Vec4;
  readonly duration: number; readonly startTime: number; readonly fadeInTime: number; readonly flags: number; readonly shader: SceneShader | null;
}
export interface ExplosionOptions {
  readonly origin: Vec3; readonly direction: Vec3 | null; readonly model: SceneModel; readonly shader: SceneShader | null;
  readonly duration: number; readonly sprite: boolean;
}
const f = Math.fround;
const WHITE = vec4(1, 1, 1, 1), WHITE_BYTES = vec4(255, 255, 255, 255);
function identity(): Axis { return [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]; }
function copy(v: Vec3): Vec3 { return vec3(v.x, v.y, v.z); }
function seconds(time: number): number { return f(f(time) / 1000); }
function lifeRate(start: number, end: number): number { return f(1 / f((end - start) | 0)); }
function byte(value: number): number { return qvmFloatToInt(f(f(value) * 255)) & 255; }

/** Owns only cg_effects.c static state. LocalEntityPool owns the actual records; LocalEntitySystem updates them. */
export class ClientEffects {
  private smokeSeed = 0x92;
  private lastScorePosition = vec3(0, 0, 0);
  constructor(
    private readonly state: Pick<ClientGameState, "time" | "snap" | "predictedPlayerState" | "product">,
    readonly pool: LocalEntityPool,
    private readonly media: EffectMedia,
    private readonly options: EffectOptions,
    private readonly imports: EffectImports,
  ) {
    if (state.product !== media.variant.product) throw new Error("Effect media product differs from cgame product");
    if (state.product !== pool.product) throw new Error("Effect pool product differs from cgame product");
  }

  private rand(): number {
    const value = this.imports.randomInteger();
    if (!Number.isInteger(value) || value < 0 || value > 32767) throw new RangeError("cgame rand() must return a 15-bit integer");
    return value;
  }
  private random(): number { return f((this.rand() & 32767) / 32767); }
  private crandom(): number { return f(2 * f(this.random() - 0.5)); }
  private mission(): MissionEffectMedia {
    if (this.media.variant.product !== "missionpack") throw new Error("Missionpack effect requested in baseq3");
    return this.media.variant.media;
  }

  bubbleTrail(start: Vec3, end: Vec3, spacing: number): void {
    if (this.options.noProjectileTrail) return;
    spacing = f(spacing);
    if (!Number.isFinite(spacing) || Math.trunc(spacing) < 1 || spacing > 2147483647) throw new RangeError("Bubble spacing must have a positive integer divisor");
    const difference = sub3(end, start), length = length3(difference), direction = normalize3(difference);
    let i = this.rand() % Math.trunc(spacing), move = add3(start, scale3(direction, i));
    const step = scale3(direction, spacing);
    for (; i < length; i = qvmFloatToInt(f(f(i) + spacing))) {
      const ref = createSpriteEntity(), le = this.pool.allocate("move-scale-fade", ref);
      le.leFlags = LocalEntityFlags.PUFF_DONT_SCALE;
      le.startTime = this.state.time;
      le.endTime = qvmFloatToInt(f(f((this.state.time + 1000) | 0) + f(this.random() * 250)));
      le.lifeRate = lifeRate(le.startTime, le.endTime);
      ref.shaderTime = seconds(this.state.time); ref.radius = 3; ref.customShader = this.media.waterBubbleShader; ref.shaderRGBA = { ...WHITE_BYTES };
      le.color = vec4(0, 0, 0, 1);
      le.pos = { type: TrajectoryType.TR_LINEAR, time: this.state.time, duration: 0, base: copy(move), delta: vec3(f(this.crandom() * 5), f(this.crandom() * 5), f(f(this.crandom() * 5) + 6)) };
      move = add3(move, step);
    }
  }

  smokePuff(options: SmokePuffOptions): SpriteLocalEntity {
    const ref = createSpriteEntity(), le = this.pool.allocate("move-scale-fade", ref);
    le.leFlags = options.flags | 0; le.radius = f(options.radius);
    const rotation = qRandom(this.smokeSeed); this.smokeSeed = rotation.seed;
    ref.rotation = f(rotation.value * 360); ref.radius = le.radius; ref.shaderTime = seconds(options.startTime);
    le.startTime = options.startTime | 0; le.fadeInTime = options.fadeInTime | 0;
    le.endTime = qvmFloatToInt(f(f(le.startTime) + f(options.duration)));
    le.lifeRate = lifeRate(le.fadeInTime > le.startTime ? le.fadeInTime : le.startTime, le.endTime);
    le.color = vec4(options.color.x, options.color.y, options.color.z, options.color.w);
    le.pos = { type: TrajectoryType.TR_LINEAR, time: le.startTime, duration: 0, base: copy(options.origin), delta: copy(options.velocity) };
    ref.origin = copy(options.origin); ref.customShader = options.shader;
    if (this.options.hardware === "ragepro") { ref.customShader = this.media.smokePuffRageProShader; ref.shaderRGBA = { ...WHITE_BYTES }; }
    else ref.shaderRGBA = vec4(byte(le.color.x), byte(le.color.y), byte(le.color.z), 255);
    return le;
  }

  spawnEffect(origin: Vec3): ShadedLocalEntity {
    const ref = createModelEntity(this.media.teleportEffectModel), le = this.pool.allocate("fade-rgb", ref);
    le.startTime = this.state.time; le.endTime = (this.state.time + 500) | 0; le.lifeRate = lifeRate(le.startTime, le.endTime); le.color = { ...WHITE };
    ref.shaderTime = seconds(this.state.time); ref.axis = identity();
    const base = this.media.variant.product === "baseq3";
    ref.origin = vec3(origin.x, origin.y, f(origin.z) + (base ? -24 : 16));
    if (this.media.variant.product === "baseq3") ref.customShader = this.media.variant.teleportEffectShader;
    return le;
  }

  makeExplosion(options: ExplosionOptions): SpriteLocalEntity | ShadedLocalEntity {
    const duration = options.duration | 0;
    if (duration <= 0) throw new RangeError(`CG_MakeExplosion: msec = ${duration}`);
    if (options.sprite && options.direction === null) throw new Error("Sprite explosion requires a direction vector");
    const offset = this.rand() & 63;
    let le: SpriteLocalEntity | ShadedLocalEntity;
    if (options.sprite) {
      const direction = options.direction;
      if (direction === null) throw new Error("Sprite explosion requires a direction vector");
      const ref = { ...createModelEntity(), ...createSpriteEntity() };
      le = this.pool.allocate("sprite-explosion", ref);
      ref.rotation = this.rand() % 360; ref.origin = add3(scale3(direction, 16), options.origin);
      ref.oldOrigin = copy(ref.origin); ref.model = options.model;
    } else {
      const ref = createModelEntity();
      le = this.pool.allocate("explosion", ref);
      if (options.direction === null) ref.axis = identity();
      else {
        const angle = this.rand() % 360, forward = copy(options.direction), perpendicular = perpendicularVector(forward);
        const side = angle === 0 ? perpendicular : rotatePointAroundVector(forward, perpendicular, angle);
        ref.axis = [forward, side, cross3(forward, side)];
      }
      ref.origin = copy(options.origin); ref.oldOrigin = copy(options.origin); ref.model = options.model;
    }
    le.startTime = (this.state.time - offset) | 0; le.endTime = (le.startTime + duration) | 0;
    le.refEntity.shaderTime = seconds(le.startTime); le.refEntity.customShader = options.shader;
    le.color = vec4(1, 1, 1, 0);
    return le;
  }

  bleed(origin: Vec3, entityNum: number): void {
    if (!this.options.blood) return;
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("CG_Bleed requires a current snapshot");
    const ref = createSpriteEntity(), le = this.pool.allocate("explosion", ref);
    le.startTime = this.state.time; le.endTime = (le.startTime + 500) | 0;
    ref.origin = copy(origin); ref.rotation = this.rand() % 360; ref.radius = 24; ref.customShader = this.media.bloodExplosionShader;
    if (entityNum === snapshot.playerState.clientNum) ref.renderFlags |= RF_THIRD_PERSON;
  }

  launchGib(origin: Vec3, velocity: Vec3, model: SceneModel): ModelLocalEntity {
    const ref = createModelEntity(model), le = this.pool.allocate("fragment", ref);
    le.startTime = this.state.time; le.endTime = qvmFloatToInt(f(f((le.startTime + 5000) | 0) + f(this.random() * 3000)));
    ref.origin = copy(origin); ref.axis = identity();
    le.pos = { type: TrajectoryType.TR_GRAVITY, time: this.state.time, duration: 0, base: copy(origin), delta: copy(velocity) };
    le.bounceFactor = f(0.6); le.leBounceSoundType = "blood"; le.leMarkType = "blood";
    return le;
  }

  gibPlayer(origin: Vec3): void {
    if (!this.options.blood) return;
    const velocity = () => vec3(f(this.crandom() * 250), f(this.crandom() * 250), f(250 + f(this.crandom() * 250)));
    const firstVelocity = velocity(), head = (this.rand() & 1) !== 0 ? this.media.gibSkull : this.media.gibBrain;
    this.launchGib(origin, firstVelocity, head);
    if (!this.options.gibs) return;
    for (const model of [this.media.gibAbdomen, this.media.gibArm, this.media.gibChest, this.media.gibFist, this.media.gibFoot, this.media.gibForearm, this.media.gibIntestine, this.media.gibLeg, this.media.gibLeg]) this.launchGib(origin, velocity(), model);
  }

  launchExplode(origin: Vec3, velocity: Vec3, model: SceneModel): ModelLocalEntity {
    const ref = createModelEntity(model), le = this.pool.allocate("fragment", ref);
    le.startTime = this.state.time; le.endTime = qvmFloatToInt(f(f((le.startTime + 10000) | 0) + f(this.random() * 6000)));
    ref.origin = copy(origin); ref.axis = identity();
    le.pos = { type: TrajectoryType.TR_GRAVITY, time: this.state.time, duration: 0, base: copy(origin), delta: copy(velocity) };
    le.bounceFactor = f(0.1); le.leBounceSoundType = "brass"; le.leMarkType = "none";
    return le;
  }

  bigExplode(origin: Vec3): void {
    if (!this.options.blood) return;
    for (const scale of [1, 1, 1.5, 2, 2.5]) {
      const velocity = vec3(f(f(this.crandom() * 100) * scale), f(f(this.crandom() * 100) * scale), f(150 + f(this.crandom() * 100)));
      this.launchExplode(origin, velocity, this.media.smoke2);
    }
  }

  scorePlum(client: number, origin: Vec3, score: number): void {
    if (client !== this.state.predictedPlayerState.clientNum || !this.options.scorePlum) return;
    const ref = { ...createModelEntity(), ...createSpriteEntity() }, le = this.pool.allocate("score-plum", ref);
    le.startTime = this.state.time; le.endTime = (this.state.time + 4000) | 0; le.lifeRate = lifeRate(le.startTime, le.endTime);
    le.color = { ...WHITE }; le.radius = f(score | 0);
    const z = f(origin.z), lastZ = this.lastScorePosition.z;
    le.pos = { ...le.pos, base: vec3(origin.x, origin.y, z >= f(lastZ - 20) && z <= f(lastZ + 20) ? f(z - 20) : z) };
    this.lastScorePosition = copy(origin); ref.radius = 16; ref.axis = anglesToAxis(vec3(0, 0, 0));
  }

  lightningBoltBeam(start: Vec3, end: Vec3): PassiveLocalEntity {
    const media = this.mission(), ref = createLightningEntity(), le = this.pool.allocate("show-ref-entity", ref);
    le.startTime = this.state.time; le.endTime = (this.state.time + 50) | 0;
    ref.origin = copy(start); ref.oldOrigin = copy(end); ref.customShader = media.lightningShader;
    return le;
  }

  kamikazeEffect(origin: Vec3): ModelLocalEntity {
    const ref = createModelEntity(this.mission().kamikazeEffectModel), le = this.pool.allocate("kamikaze", ref);
    le.startTime = this.state.time; le.endTime = (this.state.time + 3000) | 0; le.lifeRate = lifeRate(le.startTime, le.endTime);
    le.color = { ...WHITE }; ref.shaderTime = seconds(this.state.time); ref.origin = copy(origin);
    return le;
  }

  obeliskExplode(origin: Vec3): void {
    const media = this.mission();
    const le = this.makeExplosion({ origin: vec3(origin.x, origin.y, f(origin.z) + 64), direction: vec3(0, 0, 0), model: media.dishFlashModel, shader: media.rocketExplosionShader, duration: 600, sprite: true });
    le.light = 300; le.lightColor = vec3(1, 0.75, 0);
  }

  private hitSound(sounds: readonly [PcmSound | null, PcmSound | null, PcmSound | null]): PcmSound | null {
    const choice = this.rand() & 3;
    return choice < 2 ? sounds[0] : choice === 2 ? sounds[1] : sounds[2];
  }
  obeliskPain(origin: Vec3): void { this.imports.startSound(copy(origin), 1023, 5, this.hitSound(this.mission().obeliskHitSounds)); }

  invulnerabilityImpact(origin: Vec3, angles: Vec3): ModelLocalEntity {
    const media = this.mission(), ref = createModelEntity(media.invulnerabilityImpactModel), le = this.pool.allocate("invul-impact", ref);
    le.startTime = this.state.time; le.endTime = (this.state.time + 1000) | 0; le.lifeRate = lifeRate(le.startTime, le.endTime);
    le.color = { ...WHITE }; ref.shaderTime = seconds(this.state.time); ref.origin = copy(origin); ref.axis = anglesToAxis(angles);
    this.imports.startSound(copy(origin), 1023, 5, this.hitSound(media.invulnerabilityImpactSounds));
    return le;
  }

  invulnerabilityJuiced(origin: Vec3): ModelLocalEntity {
    const media = this.mission(), ref = createModelEntity(media.invulnerabilityJuicedModel), le = this.pool.allocate("invul-juiced", ref);
    le.startTime = this.state.time; le.endTime = (this.state.time + 10000) | 0; le.lifeRate = lifeRate(le.startTime, le.endTime);
    le.color = { ...WHITE }; ref.shaderTime = seconds(this.state.time); ref.origin = copy(origin); ref.axis = anglesToAxis(vec3(0, 0, 0));
    this.imports.startSound(copy(origin), 1023, 5, media.invulnerabilityJuicedSound);
    return le;
  }
}
