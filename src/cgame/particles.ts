/*
 * Particle pools from id Software code/cgame/cg_marks.c:296-2274 and
 * code/cgame/cg_particles.c:27-2018. The latter is an explicit dormant profile.
 * Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
 */
import { length3, sub3, vec2, vec3, vec4, vectorToAngles, type Axis, type Vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { CommonError } from "../core/common-error.ts";
import { Tokenizer } from "../core/text.ts";
import { gameAtof, gameAtoi, type GameRandom } from "../game/numeric.ts";
import type { RefPoly, RefPolyVertex, SceneShader } from "../render/ref-entity.ts";
import type { RendererResources } from "../render/world.ts";
import type { MovementTrace } from "../shared/movement.ts";
import { ENTITYNUM_WORLD } from "../shared/player-state.ts";
import type { PredictionRuntime } from "./prediction.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";

export const MAX_PARTICLES = 1024;
enum ParticleType { None, Weather, Flat, Smoke, Rotate, WeatherTurbulent, Animated, Bat, Bleed, FlatScaleUp, FlatScaleUpFade, WeatherFlurry, SmokeImpact, Bubble, BubbleTurbulent, Sprite }
enum ParticleColor { White = 0, Blood = 2, EmissiveFade = 3, Grey75 = 4 }
interface Particle {
  next: number; time: number; endTime: number; origin: Vec3; velocity: Vec3; acceleration: Vec3;
  color: ParticleColor; colorVelocity: number; alpha: number; alphaVelocity: number; type: ParticleType;
  shader: SceneShader | null; height: number; width: number; endHeight: number; endWidth: number;
  start: number; end: number; startFade: number; rotate: boolean; snum: number; link: boolean;
  shaderAnimation: number; roll: number; accumulatedRoll: number;
}
type AnimationFrames = readonly [SceneShader | null, ...(SceneShader | null)[]];
export interface ParticleAnimations { readonly explode1: AnimationFrames }
export interface StandaloneParticleAnimations extends ParticleAnimations {
  readonly blacksmokeanim: AnimationFrames; readonly twiltb2: AnimationFrames;
  readonly expblue: AnimationFrames; readonly blacksmokeanimb: AnimationFrames; readonly blood: AnimationFrames;
}
type ParticleAnimationName = keyof StandaloneParticleAnimations;
type ParticleSource = "cg_marks.c" | "cg_particles.c";
const ANIMATION_NAMES: readonly ParticleAnimationName[] = ["explode1", "blacksmokeanim", "twiltb2", "expblue", "blacksmokeanimb", "blood"];
const ANIMATIONS: Readonly<Record<ParticleAnimationName, { readonly count: number; readonly aspectRatio: number }>> = {
  explode1: { count: 23, aspectRatio: Math.fround(1.405) },
  blacksmokeanim: { count: 25, aspectRatio: 1 }, twiltb2: { count: 45, aspectRatio: 1 },
  expblue: { count: 25, aspectRatio: 1 }, blacksmokeanimb: { count: 23, aspectRatio: 1 }, blood: { count: 5, aspectRatio: 1 },
};
const SOURCE_PROFILES = {
  "cg_marks.c": { capacity: MAX_PARTICLES, explosionAlpha: 0.5 },
  "cg_particles.c": { capacity: 8192, explosionAlpha: 1 },
};
interface RegisteredAnimation {
  readonly name: ParticleAnimationName; readonly count: number; readonly aspectRatio: number;
  readonly frames: (SceneShader | null)[];
}
function registeredAnimation(name: ParticleAnimationName, frames: AnimationFrames, aspectRatio: number): RegisteredAnimation {
  const count = ANIMATIONS[name].count;
  if (frames.length !== count) throw new RangeError(`${name} requires its ${count} registered source frames`);
  return { name, count, aspectRatio, frames: [...frames] };
}
export interface ParticleMedia { readonly tracerShader: SceneShader | null; readonly smokePuffShader: SceneShader | null; readonly waterBubbleShader: SceneShader | null }
export interface ParticleHost {
  readonly animations: ParticleAnimations;
  readonly media: ParticleMedia;
  readonly prediction: Pick<PredictionRuntime, "trace">;
  readonly random: Pick<GameRandom, "rand" | "random" | "crandom">;
  readonly hardwareType: "generic" | "rage-pro";
  configString(index: number): string;
  print(message: string): void;
}
interface StandaloneParticleHost extends ParticleHost { readonly animations: StandaloneParticleAnimations }
export interface ParticleExplosionRequest {
  readonly animation: string; readonly origin: Vec3; readonly velocity: Vec3;
  readonly duration: number; readonly sizeStart: number; readonly sizeEnd: number;
}

/** Registration finishes before constructing a usable system; no frame awaits asset IO. */
export function loadParticleAnimations(resources: Pick<RendererResources, "registerShader">, source?: "cg_marks.c"): Promise<ParticleAnimations>;
export function loadParticleAnimations(resources: Pick<RendererResources, "registerShader">, source: "cg_particles.c"): Promise<StandaloneParticleAnimations>;
export async function loadParticleAnimations(resources: Pick<RendererResources, "registerShader">, source: ParticleSource = "cg_marks.c"): Promise<ParticleAnimations | StandaloneParticleAnimations> {
  const load = async (name: ParticleAnimationName): Promise<AnimationFrames> => {
    const first = await resources.registerShader(`${name}1`), frames: (SceneShader | null)[] = [];
    for (let frame = 2; frame <= ANIMATIONS[name].count; frame++) frames.push(await resources.registerShader(`${name}${frame}`));
    return [first, ...frames];
  };
  const explode1 = await load("explode1");
  if (source === "cg_marks.c") return { explode1 };
  return { explode1, blacksmokeanim: await load("blacksmokeanim"), twiltb2: await load("twiltb2"),
    expblue: await load("expblue"), blacksmokeanimb: await load("blacksmokeanimb"), blood: await load("blood") };
}

const f32 = Math.fround;
const add = (a: number, b: number): number => f32(f32(a) + f32(b));
const subtract = (a: number, b: number): number => f32(f32(a) - f32(b));
const multiply = (a: number, b: number): number => f32(f32(a) * f32(b));
const divide = (a: number, b: number): number => f32(f32(a) / f32(b));
const ZERO = vec3(0, 0, 0);
const ZERO_BOUNDS = { min: ZERO, max: ZERO };
function ma(origin: Vec3, scale: number, direction: Vec3): Vec3 { return vec3(add(origin.x, multiply(scale, direction.x)), add(origin.y, multiply(scale, direction.y)), add(origin.z, multiply(scale, direction.z))); }
function integer(value: number, label: string): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError(`${label} must be int32`);
  return value;
}
function zeroParticle(next: number): Particle {
  return { next, time: 0, endTime: 0, origin: ZERO, velocity: ZERO, acceleration: ZERO, color: ParticleColor.White, colorVelocity: 0,
    alpha: 0, alphaVelocity: 0, type: ParticleType.None, shader: null, height: 0, width: 0, endHeight: 0, endWidth: 0,
    start: 0, end: 0, startFade: 0, rotate: false, snum: 0, link: false, shaderAnimation: 0, roll: 0, accumulatedRoll: 0 };
}

/** Slots retain fields between allocation and release, exactly like the source pool. */
export class ParticleSystem {
  readonly state: ClientGameState;
  readonly host: ParticleHost;
  private readonly particles: Particle[] = [];
  private active = -1;
  private free = 0;
  private count = 0;
  private oldTime = 0;
  private viewRoll = 0;
  private viewAxes: Axis = [ZERO, ZERO, ZERO];
  private rotatedAxes: Axis = [ZERO, ZERO, ZERO];
  private readonly animations: readonly RegisteredAnimation[];
  private readonly profile: { readonly capacity: number; readonly explosionAlpha: number };

  constructor(...args: [state: ClientGameState, host: ParticleHost, source?: "cg_marks.c"] |
    [state: ClientGameState, host: StandaloneParticleHost, source: "cg_particles.c"]) {
    this.state = args[0]; this.host = args[1];
    this.profile = SOURCE_PROFILES[args[2] ?? "cg_marks.c"];
    if (args[2] === "cg_particles.c") {
      const animations = args[1].animations;
      this.animations = ANIMATION_NAMES.map(name => registeredAnimation(name, animations[name], ANIMATIONS[name].aspectRatio));
    } else this.animations = [registeredAnimation("explode1", args[1].animations.explode1, 1)];
    this.resetPool();
  }
  get activeCount(): number { return this.count; }
  async clear(resources: Pick<RendererResources, "registerShader">): Promise<void> {
    this.resetPool();
    for (const animation of this.animations) {
      for (let frame = 0; frame < animation.count; frame++) {
        animation.frames[frame] = await resources.registerShader(`${animation.name}${frame + 1}`);
      }
    }
  }
  private resetPool(): void {
    this.particles.length = 0;
    for (let index = 0; index < this.profile.capacity; index++) this.particles.push(zeroParticle(index + 1 === this.profile.capacity ? -1 : index + 1));
    this.active = -1; this.free = 0; this.count = 0; this.oldTime = f32(this.state.time);
  }
  private at(index: number): Particle { const particle = this.particles[index]; if (particle === undefined) throw new RangeError(`invalid particle slot ${index}`); return particle; }
  private allocate(): Particle | null {
    if (this.free === -1) return null;
    const index = this.free, particle = this.at(index);
    this.free = particle.next; particle.next = this.active; this.active = index; this.count++;
    particle.time = f32(this.state.time);
    return particle;
  }
  private release(index: number, particle: Particle): void {
    particle.next = this.free; this.free = index; particle.type = ParticleType.None; particle.color = ParticleColor.White; particle.alpha = 0; this.count--;
  }
  private warnShader(shader: SceneShader | null, name: string): void { if (shader === null) this.host.print(`${name} pshader == ZERO!\n`); }
  private after(duration: number): number { return f32((this.state.time + integer(duration, "particle duration")) | 0); }

  explosion(request: ParticleExplosionRequest): void {
    const animationIndex = this.animations.findIndex(animation => animation.name === request.animation.toLowerCase());
    const animation = this.animations[animationIndex];
    if (animation === undefined) throw new CommonError("drop", `CG_ParticleExplosion: unknown animation string: ${request.animation}\n`);
    let duration = integer(request.duration, "particle duration");
    integer(request.sizeStart, "particle start size"); integer(request.sizeEnd, "particle end size");
    const p = this.allocate(); if (p === null) return;
    p.alpha = this.profile.explosionAlpha; p.alphaVelocity = 0;
    if (duration < 0) { duration = -duration | 0; p.roll = 0; } else p.roll = qvmFloatToInt(multiply(this.host.random.crandom(), 179));
    p.shaderAnimation = animationIndex; p.width = f32(request.sizeStart); p.height = multiply(request.sizeStart, animation.aspectRatio);
    p.endHeight = f32(request.sizeEnd); p.endWidth = multiply(request.sizeEnd, animation.aspectRatio); p.endTime = this.after(duration); p.type = ParticleType.Animated;
    p.origin = vec3(request.origin.x, request.origin.y, request.origin.z); p.velocity = vec3(request.velocity.x, request.velocity.y, request.velocity.z); p.acceleration = ZERO;
  }

  snowFlurry(shader: SceneShader | null, entity: ClientEntity): void {
    this.warnShader(shader, "CG_ParticleSnowFlurry"); const p = this.allocate(); if (p === null) return;
    const source = entity.currentState;
    p.color = ParticleColor.White; p.alpha = f32(0.9); p.alphaVelocity = 0; p.start = source.origin2.x; p.end = source.origin2.y;
    p.endTime = this.after(source.time); p.startFade = this.after(source.time2); p.shader = shader;
    if (this.host.random.rand() % 100 > 90) { p.height = 32; p.width = 32; p.alpha = f32(0.1); } else { p.height = 1; p.width = 1; }
    p.type = ParticleType.WeatherFlurry; p.origin = { ...source.origin };
    p.velocity = vec3(add(multiply(source.angles.x, 32), multiply(this.host.random.crandom(), 16)), add(multiply(source.angles.y, 32), multiply(this.host.random.crandom(), 16)), add(-10, source.angles.z));
    p.acceleration = vec3(multiply(this.host.random.crandom(), 16), multiply(this.host.random.crandom(), 16), 0);
  }
  snow(shader: SceneShader | null, origin: Vec3, end: Vec3, turbulent: boolean, range: number, snum: number): void {
    if (!(origin.z > end.z)) throw new RangeError("snow start must exceed end to keep the source wrap loop finite");
    this.warnShader(shader, "CG_ParticleSnow"); const p = this.allocate(); if (p === null) return;
    p.color = ParticleColor.White; p.alpha = f32(0.4); p.alphaVelocity = 0; p.start = origin.z; p.end = end.z; p.shader = shader; p.height = 1; p.width = 1;
    p.type = turbulent ? ParticleType.WeatherTurbulent : ParticleType.Weather;
    p.origin = vec3(add(origin.x, multiply(this.host.random.crandom(), range)), add(origin.y, multiply(this.host.random.crandom(), range)), add(origin.z, multiply(this.host.random.crandom(), subtract(p.start, p.end))));
    p.velocity = vec3(turbulent ? multiply(this.host.random.crandom(), 16) : 0, turbulent ? multiply(this.host.random.crandom(), 16) : 0, turbulent ? multiply(-50, 1.3) : -50);
    p.acceleration = ZERO; p.snum = snum; p.link = true;
  }
  bubble(shader: SceneShader | null, origin: Vec3, end: Vec3, turbulent: boolean, range: number, snum: number): void {
    this.warnShader(shader, "CG_ParticleSnow"); const p = this.allocate(); if (p === null) return;
    p.color = ParticleColor.White; p.alpha = f32(0.4); p.alphaVelocity = 0; p.start = origin.z; p.end = end.z; p.shader = shader;
    p.height = p.width = add(1, multiply(this.host.random.crandom(), 0.5));
    let velocityZ = add(50, multiply(this.host.random.crandom(), 10)); if (turbulent) velocityZ = multiply(50, 1.3);
    p.type = turbulent ? ParticleType.BubbleTurbulent : ParticleType.Bubble;
    p.origin = vec3(add(origin.x, multiply(this.host.random.crandom(), range)), add(origin.y, multiply(this.host.random.crandom(), range)), add(origin.z, multiply(this.host.random.crandom(), subtract(p.start, p.end))));
    p.velocity = vec3(turbulent ? multiply(this.host.random.crandom(), 4) : 0, turbulent ? multiply(this.host.random.crandom(), 4) : 0, velocityZ);
    p.acceleration = ZERO; p.snum = snum; p.link = true;
  }
  smoke(shader: SceneShader | null, entity: ClientEntity): void {
    if (shader === null) this.host.print("CG_ParticleSmoke == ZERO!\n");
    const p = this.allocate(); if (p === null) return;
    const source = entity.currentState;
    p.endTime = this.after(source.time); p.startFade = this.after(source.time2); p.color = ParticleColor.White; p.alpha = 1; p.alphaVelocity = 0;
    p.start = source.origin.z; p.end = source.origin2.z; p.shader = shader; p.rotate = false; p.height = 8; p.width = 8; p.endHeight = 32; p.endWidth = 32; p.type = ParticleType.Smoke;
    p.origin = { ...source.origin }; p.velocity = vec3(0, 0, source.frame === 1 ? -5 : 5); p.acceleration = ZERO;
    p.roll = qvmFloatToInt(add(8, multiply(this.host.random.crandom(), 4)));
  }
  bulletDebris(origin: Vec3, velocity: Vec3, duration: number): void {
    const p = this.allocate(); if (p === null) return;
    p.endTime = this.after(duration); p.startFade = this.after(Math.trunc(duration / 2)); p.color = ParticleColor.EmissiveFade; p.alpha = 1; p.alphaVelocity = 0;
    p.height = p.width = p.endHeight = p.endWidth = 0.5; p.shader = this.host.media.tracerShader; p.type = ParticleType.Smoke;
    p.origin = { ...origin }; p.velocity = vec3(velocity.x, velocity.y, add(velocity.z, -20)); p.acceleration = vec3(0, 0, -60);
  }
  /** CG_AddParticleShrapnel is an intentional empty function in the pinned source. */
  addParticleShrapnel(): void { return; }
  newParticleArea(index: number): boolean {
    const text = this.host.configString(index); if (text.length === 0) return false;
    const tokens = new Tokenizer(text, `particle configstring ${index}`);
    const token = (): string => tokens.next()?.value ?? "";
    const type = gameAtoi(token());
    const range = type === 0 ? 256 : type === 1 ? 128 : type === 2 || type === 7 ? 64 : type === 3 || type === 6 ? 32 : type === 4 ? 8 : type === 5 ? 16 : 0;
    const origin = vec3(gameAtof(token()), gameAtof(token()), gameAtof(token()));
    const end = vec3(gameAtof(token()), gameAtof(token()), gameAtof(token()));
    const count = gameAtoi(token()), turbulent = gameAtoi(token()) !== 0, snum = gameAtoi(token());
    for (let item = 0; item < count; item++) {
      if (type >= 4) this.bubble(this.host.media.waterBubbleShader, origin, end, turbulent, range, snum);
      else this.snow(this.host.media.waterBubbleShader, origin, end, turbulent, range, snum);
    }
    return true;
  }
  snowLink(entity: ClientEntity, enabled: boolean): void {
    for (let index = this.active; index !== -1;) { const p = this.at(index); index = p.next; if ((p.type === ParticleType.Weather || p.type === ParticleType.WeatherTurbulent) && p.snum === entity.currentState.frame) p.link = enabled; }
  }
  impactSmokePuff(shader: SceneShader | null, origin: Vec3): void {
    this.warnShader(shader, "CG_ParticleImpactSmokePuff"); const p = this.allocate(); if (p === null) return;
    p.alpha = 0.25; p.alphaVelocity = 0; p.roll = qvmFloatToInt(multiply(this.host.random.crandom(), 179)); p.shader = shader;
    p.endTime = this.after(500); p.startFade = this.after(100); p.width = this.host.random.rand() % 4 + 8; p.height = this.host.random.rand() % 4 + 8;
    p.endHeight = multiply(p.height, 2); p.endWidth = multiply(p.width, 2); p.type = ParticleType.SmokeImpact;
    p.origin = { ...origin }; p.velocity = vec3(0, 0, 20); p.acceleration = vec3(0, 0, 20); p.rotate = true;
  }
  bleed(shader: SceneShader | null, start: Vec3, fleshEntityNum: number, duration: number): void {
    this.warnShader(shader, "CG_Particle_Bleed"); const p = this.allocate(); if (p === null) return;
    p.alpha = 0.75; p.alphaVelocity = 0; p.shader = shader; p.endTime = this.after(duration); p.startFade = this.after(fleshEntityNum !== 0 ? 0 : 100);
    p.width = p.height = 4; p.endHeight = 4 + this.host.random.rand() % 3; p.endWidth = p.endHeight; p.type = ParticleType.Smoke;
    p.origin = { ...start }; p.velocity = vec3(0, 0, -20); p.acceleration = ZERO; p.rotate = false; p.roll = this.host.random.rand() % 179; p.color = ParticleColor.Blood;
  }
  oilParticle(shader: SceneShader | null, entity: ClientEntity): void {
    const source = entity.currentState, ratio = subtract(1, divide(this.state.time, (this.state.time + source.time) | 0));
    if (shader === null) this.host.print("CG_Particle_OilParticle == ZERO!\n");
    const p = this.allocate(); if (p === null) return;
    p.alpha = 0.75; p.alphaVelocity = 0; p.shader = shader; p.endTime = add(this.state.time, 1500); p.startFade = p.endTime;
    p.width = p.endWidth = 1; p.height = p.endHeight = 3; p.type = ParticleType.Smoke; p.origin = { ...source.origin };
    p.velocity = vec3(multiply(source.origin2.x, multiply(16, ratio)), multiply(source.origin2.y, multiply(16, ratio)), source.origin2.z);
    p.snum = 1; p.acceleration = vec3(0, 0, -20); p.rotate = false; p.roll = this.host.random.rand() % 179;
  }
  oilSlick(shader: SceneShader | null, entity: ClientEntity): void {
    if (shader === null) this.host.print("CG_Particle_OilSlick == ZERO!\n");
    const p = this.allocate(); if (p === null) return;
    const source = entity.currentState;
    p.endTime = source.angles2.z !== 0 ? add(this.state.time, source.angles2.z) : this.after(60000); p.startFade = p.endTime;
    p.alpha = 0.75; p.alphaVelocity = 0; p.shader = shader;
    const sizes = source.angles2.x !== 0 || source.angles2.y !== 0;
    p.width = p.height = sizes ? source.angles2.x : 8; p.endHeight = p.endWidth = sizes ? source.angles2.y : 16;
    p.type = ParticleType.FlatScaleUp; p.snum = 1;
    p.origin = vec3(source.origin.x, source.origin.y, add(source.origin.z, add(0.55, multiply(this.host.random.crandom(), 0.5))));
    p.velocity = ZERO; p.acceleration = ZERO; p.rotate = false; p.roll = this.host.random.rand() % 179;
  }
  oilSlickRemove(): void {
    for (let index = this.active; index !== -1;) { const p = this.at(index); index = p.next; if (p.type === ParticleType.FlatScaleUp && p.snum === 1) { p.endTime = this.after(100); p.startFade = p.endTime; p.type = ParticleType.FlatScaleUpFade; } }
  }
  validBloodPool(start: Vec3): boolean {
    const axes = qvmAngleVectors(vectorToAngles(vec3(0, 0, 1))), center = ma(start, 0.5, vec3(0, 0, 1));
    for (let x = -8; x < 16; x += 16) for (let y = -8; y < 16; y += 16) {
      const point = ma(ma(center, x, axes.right), y, axes.up), end = ma(point, -1, vec3(0, 0, 1));
      const trace = this.host.prediction.trace(point, end, ZERO_BOUNDS, -1, 1);
      if (trace.entityNum < ENTITYNUM_WORLD || trace.solidity !== "clear" || trace.fraction >= 1) return false;
    }
    return true;
  }
  bloodPool(shader: SceneShader | null, trace: Pick<MovementTrace, "end">): void {
    this.warnShader(shader, "CG_BloodPool"); if (this.free === -1 || !this.validBloodPool(trace.end)) return;
    const p = this.allocate(); if (p === null) return;
    p.endTime = this.after(3000); p.startFade = p.endTime; p.alpha = 0.75; p.alphaVelocity = 0; p.shader = shader;
    const size = add(0.4, multiply(this.host.random.random(), 0.6)); p.width = p.height = multiply(8, size); p.endHeight = p.endWidth = multiply(16, size);
    p.type = ParticleType.FlatScaleUp; p.origin = { ...trace.end }; p.velocity = ZERO; p.acceleration = ZERO; p.rotate = false; p.roll = this.host.random.rand() % 179; p.color = ParticleColor.Blood;
  }
  bloodCloud(origin: Vec3, direction: Vec3): void {
    const count = Math.max(1, divide(length3(direction), 32));
    for (let index = 0; index < count; index++) {
      const p = this.allocate(); if (p === null) return;
      p.alpha = 0.75; p.alphaVelocity = 0; p.shader = this.host.media.smokePuffShader;
      p.endTime = add((this.state.time + 350) | 0, multiply(this.host.random.crandom(), 100)); p.startFade = f32(this.state.time);
      p.width = p.height = p.endHeight = p.endWidth = 32; p.type = ParticleType.Smoke; p.origin = { ...origin }; p.velocity = vec3(0, 0, -1); p.acceleration = ZERO; p.rotate = false; p.roll = this.host.random.rand() % 179; p.color = ParticleColor.Blood;
    }
  }
  sparks(origin: Vec3, velocity: Vec3, duration: number, x: number, y: number, speed: number): void {
    const p = this.allocate(); if (p === null) return;
    p.endTime = this.after(duration); p.startFade = this.after(Math.trunc(duration / 2)); p.color = ParticleColor.EmissiveFade; p.alpha = f32(0.4); p.alphaVelocity = 0;
    p.height = p.width = p.endHeight = p.endWidth = 0.5; p.shader = this.host.media.tracerShader; p.type = ParticleType.Smoke;
    p.origin = vec3(add(origin.x, multiply(this.host.random.crandom(), x)), add(origin.y, multiply(this.host.random.crandom(), y)), origin.z);
    p.velocity = vec3(add(velocity.x, multiply(this.host.random.crandom(), 4)), add(velocity.y, multiply(this.host.random.crandom(), 4)), add(velocity.z, multiply(add(20, multiply(this.host.random.crandom(), 10)), speed)));
    p.acceleration = vec3(multiply(this.host.random.crandom(), 4), multiply(this.host.random.crandom(), 4), 0);
  }
  dust(origin: Vec3, direction: Vec3): Vec3 {
    const negated = vec3(-direction.x, -direction.y, -direction.z), length = length3(negated), forward = qvmAngleVectors(vectorToAngles(negated)).forward;
    const count = Math.max(1, divide(length, 32)); let point = { ...origin };
    for (let index = 0; index < count; index++) {
      point = ma(point, 32, forward); const p = this.allocate(); if (p === null) break;
      p.alpha = 0.75; p.alphaVelocity = 0; p.shader = this.host.media.smokePuffShader;
      p.endTime = add((this.state.time + (length !== 0 ? 4500 : 750)) | 0, multiply(this.host.random.crandom(), length !== 0 ? 3500 : 500)); p.startFade = f32(this.state.time);
      p.width = p.height = length !== 0 ? 32 : multiply(32, 0.2); p.endHeight = p.endWidth = length !== 0 ? 96 : 16; p.type = ParticleType.Smoke;
      p.origin = point; p.velocity = vec3(multiply(this.host.random.crandom(), 6), multiply(this.host.random.crandom(), 6), multiply(this.host.random.random(), 20));
      this.host.random.crandom(); this.host.random.crandom(); // Source assigns random acceleration, then immediately clears it.
      p.acceleration = ZERO; p.rotate = false; p.roll = this.host.random.rand() % 179;
    }
    return negated;
  }
  misc(shader: SceneShader | null, origin: Vec3, size: number, duration: number, _alpha: number): void {
    this.warnShader(shader, "CG_ParticleImpactSmokePuff"); const p = this.allocate(); if (p === null) return;
    p.alpha = 1; p.alphaVelocity = 0; p.roll = this.host.random.rand() % 179; p.shader = shader; p.endTime = duration > 0 ? this.after(duration) : f32(duration);
    p.startFade = f32(this.state.time); p.width = p.height = p.endHeight = p.endWidth = f32(size); p.type = ParticleType.Sprite; p.origin = { ...origin }; p.rotate = false;
  }

  addParticles(): readonly RefPoly[] {
    const output: RefPoly[] = [];
    this.viewAxes = this.state.refdef.viewAxis;
    const angles = vectorToAngles(this.viewAxes[0]);
    this.viewRoll = add(this.viewRoll, multiply(subtract(this.state.time, this.oldTime), 0.1));
    const rotated = qvmAngleVectors(vec3(angles.x, angles.y, add(angles.z, multiply(this.viewRoll, 0.9))));
    this.rotatedAxes = [rotated.forward, rotated.right, rotated.up]; this.oldTime = f32(this.state.time);
    let head = -1, tail = -1;
    for (let index = this.active; index !== -1;) {
      const current = index, p = this.at(index); index = p.next;
      const elapsed = multiply(subtract(this.state.time, p.time), 0.001), alpha = add(p.alpha, multiply(elapsed, p.alphaVelocity));
      const timed = p.type === ParticleType.Smoke || p.type === ParticleType.Animated || p.type === ParticleType.Bleed || p.type === ParticleType.SmokeImpact || p.type === ParticleType.WeatherFlurry || p.type === ParticleType.FlatScaleUpFade;
      if (alpha <= 0 || (timed && f32(this.state.time) > p.endTime)) { this.release(current, p); continue; }
      if ((p.type === ParticleType.Bat || p.type === ParticleType.Sprite) && p.endTime < 0) {
        this.addToScene(p, p.origin, output); this.release(current, p); continue;
      }
      p.next = -1;
      if (tail === -1) head = current; else this.at(tail).next = current;
      tail = current;
      const squared = multiply(elapsed, elapsed);
      const origin = vec3(add(add(p.origin.x, multiply(p.velocity.x, elapsed)), multiply(p.acceleration.x, squared)),
        add(add(p.origin.y, multiply(p.velocity.y, elapsed)), multiply(p.acceleration.y, squared)),
        add(add(p.origin.z, multiply(p.velocity.z, elapsed)), multiply(p.acceleration.z, squared)));
      this.addToScene(p, origin, output);
    }
    this.active = head;
    return output;
  }

  private distance(origin: Vec3): number {
    if (this.state.snap === null) throw new Error("particle distance culling requires the current cgame snapshot");
    return length3(sub3(this.state.snap.playerState.origin, origin));
  }
  private rolledAxes(roll: number): readonly [Vec3, Vec3] {
    if (roll === 0) return [this.viewAxes[1], this.viewAxes[2]];
    const angles = vectorToAngles(this.state.refdef.viewAxis[0]), axes = qvmAngleVectors(vec3(angles.x, angles.y, add(angles.z, roll)));
    return [axes.right, axes.up];
  }
  private addToScene(p: Particle, origin: Vec3, output: RefPoly[]): void {
    const white = vec4(255, 255, 255, 255);
    const vertex = (position: Vec3, s: number, t: number, color = white): RefPolyVertex => ({ position, texCoord: vec2(s, t), color });
    const byte = (value: number): number => qvmFloatToInt(multiply(255, value)) & 255;
    const point = (height: number, width: number, right: Vec3, up: Vec3): Vec3 => ma(ma(origin, height, up), width, right);
    const quad = (width: number, height: number, right: Vec3, up: Vec3, color = white): readonly RefPolyVertex[] => [
      vertex(point(-height, -width, right, up), 0, 0, color), vertex(point(-height, width, right, up), 0, 1, color),
      vertex(point(height, width, right, up), 1, 1, color), vertex(point(height, -width, right, up), 1, 0, color),
    ];
    const sprite = (width: number, height: number): readonly RefPolyVertex[] => {
      const [right, up] = this.rolledAxes(p.roll);
      const a = point(-height, -width, right, up), b = ma(a, multiply(2, height), up), c = ma(b, multiply(2, width), right), d = ma(c, multiply(-2, height), up);
      return [vertex(a, 0, 0), vertex(b, 0, 1), vertex(c, 1, 1), vertex(d, 1, 0)];
    };
    const ratio = (): number => divide(subtract(this.state.time, p.time), subtract(p.endTime, p.time));
    const size = (start: number, end: number, amount: number): number => add(start, multiply(amount, subtract(end, start)));
    let vertices: readonly RefPolyVertex[];
    switch (p.type) {
      case ParticleType.Weather: case ParticleType.WeatherTurbulent: case ParticleType.WeatherFlurry: case ParticleType.Bubble: case ParticleType.BubbleTurbulent: {
        const bubble = p.type === ParticleType.Bubble || p.type === ParticleType.BubbleTurbulent;
        if (p.type !== ParticleType.WeatherFlurry) {
          if (bubble && origin.z > p.end) {
            p.time = f32(this.state.time); p.origin = vec3(origin.x, origin.y, add(p.start, multiply(this.host.random.crandom(), 4)));
            if (p.type === ParticleType.BubbleTurbulent) p.velocity = vec3(multiply(this.host.random.crandom(), 4), multiply(this.host.random.crandom(), 4), p.velocity.z);
          } else if (!bubble && origin.z < p.end) {
            p.time = f32(this.state.time); let z = origin.z;
            while (z < p.end) { const next = add(z, subtract(p.start, p.end)); if (!(next > z)) throw new RangeError("snow wrap cannot advance at source float32 precision"); z = next; }
            p.origin = vec3(origin.x, origin.y, z);
            if (p.type === ParticleType.WeatherTurbulent) p.velocity = vec3(multiply(this.host.random.crandom(), 16), multiply(this.host.random.crandom(), 16), p.velocity.z);
          }
          if (!p.link) return;
          p.alpha = 1;
        }
        if (this.distance(origin) > 1024) return;
        const color = vec4(255, 255, 255, byte(p.alpha));
        const right = this.viewAxes[1], up = this.viewAxes[2];
        vertices = bubble ? quad(p.width, p.height, right, up, color) : [vertex(point(-p.height, -p.width, right, up), 1, 0, color), vertex(point(p.height, -p.width, right, up), 0, 0, color), vertex(point(p.height, p.width, right, up), 0, 1, color)];
        break;
      }
      case ParticleType.Sprite: {
        // Both sources write opaque white vertices; their differing local color assignment is unused.
        const amount = ratio(); vertices = sprite(size(p.width, p.endWidth, amount), size(p.height, p.endHeight, amount)); break;
      }
      case ParticleType.Smoke: case ParticleType.SmokeImpact: {
        if (p.type === ParticleType.SmokeImpact && this.distance(origin) > 1024) return;
        let color = vec3(1, 1, 1);
        if (p.color === ParticleColor.Blood) color = vec3(0.22, 0, 0);
        else if (p.color === ParticleColor.Grey75) {
          const distance = this.distance(origin), grey = Math.min(multiply(0.25, divide(4096, distance === 0 ? 1 : distance)), 0.5); color = vec3(grey, grey, grey);
        }
        const amount = ratio(); let inverse: number;
        if (f32(this.state.time) > p.startFade) {
          inverse = subtract(1, divide(subtract(this.state.time, p.startFade), subtract(p.endTime, p.startFade)));
          if (p.color === ParticleColor.EmissiveFade) { const fade = Math.max(0, multiply(inverse, inverse)); color = vec3(fade, fade, fade); }
          inverse = multiply(inverse, p.alpha);
        } else inverse = p.alpha;
        if (this.host.hardwareType === "rage-pro") inverse = 1;
        if (inverse > 1) inverse = 1;
        let right: Vec3, up: Vec3;
        if (p.type !== ParticleType.SmokeImpact) {
          const angles = vectorToAngles(this.rotatedAxes[0]); p.accumulatedRoll = (p.accumulatedRoll + p.roll) | 0;
          const axes = qvmAngleVectors(vec3(angles.x, angles.y, add(angles.z, multiply(p.accumulatedRoll, 0.1)))); right = axes.right; up = axes.up;
        } else { right = this.rotatedAxes[1]; up = this.rotatedAxes[2]; }
        vertices = quad(p.rotate ? size(p.width, p.endWidth, amount) : p.width, p.rotate ? size(p.height, p.endHeight, amount) : p.height,
          p.rotate ? right : this.viewAxes[1], p.rotate ? up : this.viewAxes[2], vec4(byte(color.x), byte(color.y), byte(color.z), byte(inverse)));
        break;
      }
      case ParticleType.Bleed: {
        const [right, up] = this.rolledAxes(p.roll); vertices = quad(p.width, p.height, right, up, vec4(111, 19, 9, byte(this.host.hardwareType === "rage-pro" ? 1 : p.alpha))); break;
      }
      case ParticleType.FlatScaleUp: {
        const amount = ratio(), width = Math.min(size(p.width, p.endWidth, amount), p.endWidth), height = Math.min(size(p.height, p.endHeight, amount), p.endHeight);
        const radians = divide(multiply(p.roll, f32(Math.PI)), 180), root2 = f32(Math.sqrt(2));
        const sin = multiply(multiply(height, f32(Math.sin(radians))), root2), cos = multiply(multiply(width, f32(Math.cos(radians))), root2);
        const channel = p.color === ParticleColor.Blood ? 255 : byte(0.5), color = vec4(channel, channel, channel, 255);
        vertices = [vertex(vec3(subtract(origin.x, sin), subtract(origin.y, cos), origin.z), 0, 0, color), vertex(vec3(subtract(origin.x, cos), add(origin.y, sin), origin.z), 0, 1, color),
          vertex(vec3(add(origin.x, sin), add(origin.y, cos), origin.z), 1, 1, color), vertex(vec3(add(origin.x, cos), subtract(origin.y, sin), origin.z), 1, 0, color)];
        break;
      }
      case ParticleType.Flat:
        vertices = [vertex(vec3(subtract(origin.x, p.height), subtract(origin.y, p.width), origin.z), 0, 0), vertex(vec3(subtract(origin.x, p.height), add(origin.y, p.width), origin.z), 0, 1),
          vertex(vec3(add(origin.x, p.height), add(origin.y, p.width), origin.z), 1, 1), vertex(vec3(add(origin.x, p.height), subtract(origin.y, p.width), origin.z), 1, 0)]; break;
      case ParticleType.Animated: {
        let amount = ratio(); if (amount >= 1) amount = f32(0.9999);
        const width = size(p.width, p.endWidth, amount), height = size(p.height, p.endHeight, amount);
        if (this.distance(origin) < divide(width, 1.5)) return;
        const animation = this.animations[p.shaderAnimation];
        if (animation === undefined) throw new RangeError(`invalid particle animation ${p.shaderAnimation}`);
        const frame = qvmFloatToInt(Math.floor(multiply(amount, animation.count))), shader = animation.frames[frame];
        if (shader === undefined) throw new RangeError(`particle animation frame ${frame} outside source range`);
        p.shader = shader; vertices = sprite(width, height); break;
      }
      case ParticleType.None: case ParticleType.Rotate: case ParticleType.Bat: case ParticleType.FlatScaleUpFade:
        if (p.shader === null) return;
        throw new Error(`source particle type ${p.type} has no initialized polygon geometry`);
    }
    if (p.shader !== null) output.push({ shader: p.shader, vertices });
  }
}
