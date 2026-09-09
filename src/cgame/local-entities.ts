// Local effect pool and frame processing from id Software code/cgame/cg_localents.c.
// Copyright (C) 1999-2005 Id Software, Inc. SPDX-License-Identifier: GPL-2.0-or-later
import type { PcmSound } from "../assets/wav.ts";
import type { StartSoundOptions } from "../audio/mixer.ts";
import type { CollisionWorld, TraceResult } from "../collision/world.ts";
import { add3, cross3, dot3, length3, normalize3, scale3, sub3, vec3, vec4 } from "../core/math.ts";
import type { Axis, Vec3, Vec4 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { qvmAnglesToAxis as anglesToAxis } from "../core/qvm-math.ts";
import type { GameRandom } from "../game/numeric.ts";
import type { DynamicLight } from "../render/lighting.ts";
import { copyRefEntity, createModelEntity, RF_LIGHTING_ORIGIN } from "../render/ref-entity.ts";
import type { RefEntity, RefModelEntity, RefSpriteEntity, SceneModel, SceneShader } from "../render/ref-entity.ts";
import { ENTITYNUM_WORLD } from "../shared/player-state.ts";
import { evaluateTrajectory, evaluateTrajectoryDelta, TrajectoryType } from "../shared/trajectory.ts";
import type { Trajectory } from "../shared/trajectory.ts";
import type { Product } from "../shared/definitions.ts";
import type { PredictionRuntime } from "./prediction.ts";
import type { PacketEntityImports } from "./entities.ts";
import type { ImpactMarkSystem } from "./marks.ts";
import type { ClientEffects } from "./effects.ts";

export const MAX_LOCAL_ENTITIES = 512;
export const LocalEntityFlags = Object.freeze({ PUFF_DONT_SCALE: 1, TUMBLE: 2, SOUND1: 4, SOUND2: 8 });
type ShadedRefEntity = Exclude<RefEntity, { kind: "portal-surface" }>;
interface LocalEntityFields {
  leFlags: number;
  startTime: number;
  endTime: number;
  fadeInTime: number;
  lifeRate: number;
  pos: Trajectory;
  angles: Trajectory;
  bounceFactor: number;
  color: Vec4;
  radius: number;
  light: number;
  lightColor: Vec3;
  leMarkType: "none" | "burn" | "blood";
  leBounceSoundType: "none" | "blood" | "brass";
}
export interface SpriteLocalEntity extends LocalEntityFields {
  leType: "move-scale-fade" | "fall-scale-fade" | "scale-fade" | "score-plum" | "sprite-explosion";
  refEntity: RefSpriteEntity;
}
export interface ModelLocalEntity extends LocalEntityFields {
  leType: "fragment" | "kamikaze" | "invul-impact" | "invul-juiced";
  refEntity: RefModelEntity;
}
export interface ShadedLocalEntity extends LocalEntityFields {
  leType: "fade-rgb" | "explosion";
  refEntity: ShadedRefEntity;
}
export interface PassiveLocalEntity extends LocalEntityFields {
  leType: "mark" | "show-ref-entity";
  refEntity: RefEntity;
}
export type LocalEntity = SpriteLocalEntity | ModelLocalEntity | ShadedLocalEntity | PassiveLocalEntity;
export interface LocalEntityMedia {
  readonly bloodTrailShader: SceneShader | null;
  readonly bloodMarkShader: SceneShader | null;
  readonly burnMarkShader: SceneShader | null;
  readonly numberShaders: readonly [SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null];
  readonly gibBounceSounds: readonly [PcmSound | null, PcmSound | null, PcmSound | null];
}
export interface MissionLocalEntityMedia extends LocalEntityMedia {
  readonly kamikazeShockWave: SceneModel;
  readonly kamikazeExplodeSound: PcmSound | null;
  readonly kamikazeImplodeSound: PcmSound | null;
}
interface LocalEntityServices {
  readonly prediction: Pick<PredictionRuntime, "trace">;
  readonly collision: CollisionWorld;
  /** The engine adapter resolves source handle zero; local effects must still issue its sound call. */
  readonly audio: { readonly startSound: (sound: PcmSound | null, options: StartSoundOptions) => void };
  readonly clientNum: number;
  /** One caller-owned cgame RNG shared with other effects, never the server game RNG. */
  readonly random: Pick<GameRandom, "rand" | "random">;
  readonly marks: Pick<ImpactMarkSystem, "impactMark">;
}
export type LocalEntityHost = LocalEntityServices & (
  | { readonly product: "baseq3"; readonly media: LocalEntityMedia }
  | { readonly product: "missionpack"; readonly media: MissionLocalEntityMedia }
);
export interface LocalEntityFrame { readonly time: number; readonly frameTime: number; readonly viewOrigin: Vec3 }
export interface LocalEntityScene { readonly entities: RefEntity[]; readonly dynamicLights: DynamicLight[] }
export type LocalEntitySceneSink = Pick<PacketEntityImports, "addRefEntity" | "addLight">;
interface Slot { prev: number; next: number; entity: LocalEntity | null; active: boolean }
const f32 = Math.fround;
const ZERO_BOUNDS = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
function zeroTrajectory(): Trajectory {
  return { type: TrajectoryType.TR_STATIONARY, time: 0, duration: 0, base: vec3(0, 0, 0), delta: vec3(0, 0, 0) };
}
function zeroFields(): LocalEntityFields {
  return { leFlags: 0, startTime: 0, endTime: 0, fadeInTime: 0, lifeRate: 0, pos: zeroTrajectory(), angles: zeroTrajectory(),
    bounceFactor: 0, color: vec4(0, 0, 0, 0), radius: 0, light: 0, lightColor: vec3(0, 0, 0), leMarkType: "none", leBounceSoundType: "none" };
}
function byte(value: number): number { return qvmFloatToInt(value) & 255; }
function remaining(entity: LocalEntity, time: number): number { return f32(f32((entity.endTime - time) | 0) * entity.lifeRate); }
function scaledAxis(axis: Axis, scale: number): Axis { return [scale3(axis[0], scale), scale3(axis[1], scale), scale3(axis[2], scale)]; }
function rgba(color: Vec4, scale: number): Vec4 {
  return vec4(byte(f32(color.x * scale)), byte(f32(color.y * scale)), byte(f32(color.z * scale)), byte(f32(color.w * scale)));
}

/** Records expire at free/reset/oldest eviction; stable linked slots own traversal, not stale record references. */
export class LocalEntityPool {
  private readonly slots: Slot[] = Array.from({ length: MAX_LOCAL_ENTITIES }, () => ({ prev: -1, next: -1, entity: null, active: false }));
  private readonly recordSlots = new WeakMap<LocalEntity, number>();
  private head = -1;
  private tail = -1;
  private freeHead = 0;
  private count = 0;

  constructor(readonly product: Product) { this.initialize(); }
  get activeCount(): number { return this.count; }
  /** Fresh newest-to-oldest reference array; records retain allocate()'s validity lifetime. */
  activeEntities(): readonly LocalEntity[] {
    const entities: LocalEntity[] = [];
    for (let index = this.head; index !== -1; index = this.slot(index).next) entities.push(this.record(index));
    return Object.freeze(entities);
  }
  initialize(): void {
    this.head = -1; this.tail = -1; this.freeHead = 0; this.count = 0;
    for (let index = 0; index < MAX_LOCAL_ENTITIES; index++) {
      const slot = this.slot(index);
      slot.prev = -1; slot.next = index + 1 === MAX_LOCAL_ENTITIES ? -1 : index + 1; slot.entity = null; slot.active = false;
    }
  }
  allocate(type: SpriteLocalEntity["leType"], refEntity: RefSpriteEntity): SpriteLocalEntity;
  allocate(type: ModelLocalEntity["leType"], refEntity: RefModelEntity): ModelLocalEntity;
  allocate(type: ShadedLocalEntity["leType"], refEntity: ShadedRefEntity): ShadedLocalEntity;
  allocate(type: PassiveLocalEntity["leType"], refEntity: RefEntity): PassiveLocalEntity;
  allocate(type: LocalEntity["leType"], refEntity: RefEntity): LocalEntity {
    if (this.product === "baseq3" && (type === "kamikaze" || type === "invul-impact" || type === "invul-juiced" || type === "show-ref-entity")) {
      throw new Error(`${type} requires missionpack local entities`);
    }
    let entity: LocalEntity;
    switch (type) {
      case "move-scale-fade": case "fall-scale-fade": case "scale-fade": case "score-plum": case "sprite-explosion":
        if (refEntity.kind !== "sprite") throw new TypeError(`${type} requires a sprite`);
        entity = { ...zeroFields(), leType: type, refEntity }; break;
      case "fragment": case "kamikaze": case "invul-impact": case "invul-juiced":
        if (refEntity.kind !== "model") throw new TypeError(`${type} requires a model`);
        entity = { ...zeroFields(), leType: type, refEntity }; break;
      case "fade-rgb": case "explosion":
        if (refEntity.kind === "portal-surface") throw new TypeError(`${type} requires a shaded entity`);
        entity = { ...zeroFields(), leType: type, refEntity }; break;
      case "mark": case "show-ref-entity": entity = { ...zeroFields(), leType: type, refEntity }; break;
    }
    if (this.freeHead === -1) this.freeSlot(this.tail);
    const index = this.freeHead, slot = this.slot(index);
    this.freeHead = slot.next;
    slot.entity = entity; slot.active = true; slot.prev = -1; slot.next = this.head;
    if (this.head !== -1) this.slot(this.head).prev = index;
    else this.tail = index;
    this.head = index; this.count++; this.recordSlots.set(entity, index);
    return entity;
  }
  isActive(entity: LocalEntity): boolean {
    const index = this.recordSlots.get(entity);
    return index !== undefined && this.slot(index).active && this.slot(index).entity === entity;
  }
  free(entity: LocalEntity): void {
    const index = this.recordSlots.get(entity);
    if (index === undefined || !this.isActive(entity)) throw new Error("CG_FreeLocalEntity: not active");
    this.freeSlot(index);
  }
  private slot(index: number): Slot {
    const slot = this.slots[index];
    if (slot === undefined) throw new RangeError(`Invalid local entity slot ${index}`);
    return slot;
  }
  private record(index: number): LocalEntity {
    const record = this.slot(index).entity;
    if (record === null) throw new Error("Local entity slot has no record");
    return record;
  }
  private freeSlot(index: number): void {
    const slot = this.slot(index);
    if (!slot.active) throw new Error("CG_FreeLocalEntity: not active");
    if (slot.prev === -1) this.head = slot.next; else this.slot(slot.prev).next = slot.next;
    if (slot.next === -1) this.tail = slot.prev; else this.slot(slot.next).prev = slot.prev;
    slot.active = false; slot.next = this.freeHead; this.freeHead = index; this.count--;
  }
  /** Cache the source prev pointer before each callback; readCurrent follows same-slot recycling during it. */
  forEachOldestFirst(visit: (entity: LocalEntity, readCurrent: () => LocalEntity) => void): void {
    for (let index = this.tail; index !== -1;) {
      const current = index, next = this.slot(current).prev;
      visit(this.record(current), () => this.record(current));
      index = next;
    }
  }
}

/** The processor is constructed after real effect creators, and derives their sole allocation pool. */
export class LocalEntitySystem {
  readonly pool: LocalEntityPool;
  constructor(readonly effects: ClientEffects, readonly host: LocalEntityHost) {
    this.pool = effects.pool;
    if (this.pool.product !== host.product) throw new Error("Local entity media product differs from its pool");
  }
  /** Owned diagnostic snapshots; production passes its actual renderer sink to addEntities. */
  collectEntities(frame: LocalEntityFrame): LocalEntityScene {
    const scene: LocalEntityScene = { entities: [], dynamicLights: [] };
    this.addEntities(frame, {
      addRefEntity: entity => { scene.entities.push(copyRefEntity(entity)); },
      addLight: light => { scene.dynamicLights.push({ ...light, origin: { ...light.origin }, color: { ...light.color } }); },
    });
    return scene;
  }
  /** Renderer calls borrow each value synchronously at its reached source statement. */
  addEntities(frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    this.pool.forEachOldestFirst((entity, readCurrent) => {
      if (frame.time >= entity.endTime) this.pool.free(entity);
      else switch (entity.leType) {
        case "mark": break;
        case "fragment": this.fragment(readCurrent, entity, frame, scene); break;
        case "move-scale-fade": case "fall-scale-fade": case "scale-fade": this.scaleFade(entity, frame, scene); break;
        case "fade-rgb": entity.refEntity.shaderRGBA = rgba(entity.color, f32(remaining(entity, frame.time) * 255)); scene.addRefEntity(entity.refEntity); break;
        case "explosion": scene.addRefEntity(entity.refEntity); this.explosionLight(entity, frame.time, scene); break;
        case "sprite-explosion": this.spriteExplosion(entity, frame, scene); break;
        case "score-plum": this.scorePlum(entity, frame, scene); break;
        case "kamikaze": this.kamikaze(entity, frame, scene); break;
        case "invul-impact": case "show-ref-entity": scene.addRefEntity(entity.refEntity); break;
        case "invul-juiced": this.invulnerabilityJuiced(entity, frame, scene); break;
      }
    });
  }
  private scaleFade(entity: SpriteLocalEntity, frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    const re = entity.refEntity;
    let c = remaining(entity, frame.time);
    if (entity.leType === "move-scale-fade" && entity.fadeInTime > entity.startTime && frame.time < entity.fadeInTime) {
      c = f32(1 - f32(f32((entity.fadeInTime - frame.time) | 0) / f32((entity.fadeInTime - entity.startTime) | 0)));
    }
    re.shaderRGBA = { ...re.shaderRGBA, w: byte(f32(f32(255 * c) * entity.color.w)) };
    if (entity.leType !== "move-scale-fade" || !(entity.leFlags & LocalEntityFlags.PUFF_DONT_SCALE)) {
      re.radius = f32(f32(entity.radius * f32(1 - c)) + (entity.leType === "fall-scale-fade" ? 16 : 8));
    }
    if (entity.leType === "move-scale-fade") re.origin = evaluateTrajectory(entity.pos, frame.time);
    else if (entity.leType === "fall-scale-fade") re.origin = { ...re.origin, z: f32(entity.pos.base.z - f32(f32(1 - c) * entity.pos.delta.z)) };
    if (length3(sub3(re.origin, frame.viewOrigin)) < entity.radius) { this.pool.free(entity); return; }
    scene.addRefEntity(re);
  }
  private explosionLight(entity: SpriteLocalEntity | ShadedLocalEntity, time: number, scene: LocalEntitySceneSink): void {
    if (!entity.light) return;
    let light = f32(f32((time - entity.startTime) | 0) / f32((entity.endTime - entity.startTime) | 0));
    light = light < 0.5 ? 1 : f32(1 - f32(f32(light - 0.5) * 2));
    scene.addLight({ origin: entity.refEntity.origin, radius: f32(entity.light * light), color: entity.lightColor });
  }
  private spriteExplosion(entity: SpriteLocalEntity, frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    const c = Math.min(1, f32(f32((entity.endTime - frame.time) | 0) / f32((entity.endTime - entity.startTime) | 0)));
    const re = { ...entity.refEntity, shaderRGBA: vec4(255, 255, 255, byte(f32(f32(255 * c) * f32(0.33)))), radius: f32(f32(42 * f32(1 - c)) + 30) };
    scene.addRefEntity(re); this.explosionLight(entity, frame.time, scene);
  }
  private fragment(readCurrent: () => LocalEntity, entity: ModelLocalEntity, frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    const re = entity.refEntity;
    if (entity.pos.type === TrajectoryType.TR_STATIONARY) {
      const t = (entity.endTime - frame.time) | 0;
      if (t < 1000) {
        re.lightingOrigin = { ...re.origin }; re.renderFlags |= RF_LIGHTING_ORIGIN;
        const origin = re.origin;
        re.origin = { ...origin, z: f32(origin.z - f32(16 * f32(1 - f32(f32(t) / 1000)))) };
        scene.addRefEntity(re); re.origin = origin;
      } else scene.addRefEntity(re);
      return;
    }
    const newOrigin = evaluateTrajectory(entity.pos, frame.time);
    const trace = this.host.prediction.trace(re.origin, newOrigin, ZERO_BOUNDS, -1, 1);
    if (trace.fraction === 1) {
      re.origin = newOrigin;
      if (entity.leFlags & LocalEntityFlags.TUMBLE) re.axis = anglesToAxis(evaluateTrajectory(entity.angles, frame.time));
      scene.addRefEntity(re);
      if (entity.leBounceSoundType === "blood") this.bloodTrail(readCurrent, frame);
      return;
    }
    if (this.host.collision.pointContents(trace.end, 0) & 0x80000000) { this.pool.free(entity); return; }
    // CM allsolid leaves the zero-initialized source plane untouched; this is not an invented impact plane.
    const normal = trace.contact.kind === "plane" ? trace.contact.plane.normal : vec3(0, 0, 0);
    if (trace.contact.kind === "none" && trace.solidity !== "all-solid") throw new Error("Fragment impact has no trace plane");
    this.bounceMark(entity, trace.end, normal);
    this.bounceSound(entity, trace.end);
    this.reflectVelocity(entity, trace, normal, frame);
    scene.addRefEntity(re);
  }
  private reflectVelocity(entity: ModelLocalEntity, trace: TraceResult, normal: Vec3, frame: LocalEntityFrame): void {
    const hitTime = qvmFloatToInt(f32(f32((frame.time - frame.frameTime) | 0) + f32(f32(frame.frameTime) * trace.fraction)));
    const velocity = evaluateTrajectoryDelta(entity.pos, hitTime), dot = dot3(velocity, normal);
    const delta = scale3(add3(velocity, scale3(normal, f32(-2 * dot))), entity.bounceFactor);
    const stationary = trace.solidity === "all-solid" || (normal.z > 0 && (delta.z < 40 || delta.z < f32(f32(-frame.frameTime) * delta.z)));
    entity.pos = { ...entity.pos, base: { ...trace.end }, time: frame.time, delta, type: stationary ? TrajectoryType.TR_STATIONARY : entity.pos.type };
  }
  private bounceMark(entity: ModelLocalEntity, origin: Vec3, normal: Vec3): void {
    if (entity.leMarkType !== "none") {
      const blood = entity.leMarkType === "blood", radius = (blood ? 16 : 8) + (this.host.random.rand() & (blood ? 31 : 15));
      this.host.marks.impactMark({ shader: blood ? this.host.media.bloodMarkShader : this.host.media.burnMarkShader, origin, direction: normal,
        orientation: f32(this.host.random.random() * 360), color: vec4(1, 1, 1, 1), alphaFade: true, radius, temporary: false });
    }
    entity.leMarkType = "none";
  }
  private bounceSound(entity: ModelLocalEntity, origin: Vec3): void {
    if (entity.leBounceSoundType === "blood" && (this.host.random.rand() & 1)) {
      const value = this.host.random.rand() & 3, sounds = this.host.media.gibBounceSounds;
      this.host.audio.startSound(value === 0 ? sounds[0] : value === 1 ? sounds[1] : sounds[2],
        { entity: ENTITYNUM_WORLD, channel: 0, origin: { kind: "fixed", position: origin }, volume: 127 });
    }
    entity.leBounceSoundType = "none";
  }
  private bloodTrail(readCurrent: () => LocalEntity, frame: LocalEntityFrame): void {
    const step = 150, start = Math.imul(step, Math.trunc(((frame.time - frame.frameTime + step) | 0) / step));
    const end = Math.imul(step, Math.trunc(frame.time / step));
    for (let time = start; time <= end; time = (time + step) | 0) {
      // A full pool can recycle this very slot while spawning a puff, as in the C array.
      const origin = evaluateTrajectory(readCurrent().pos, time);
      const blood = this.effects.smokePuff({ origin, velocity: vec3(0, 0, 0), radius: 20, color: vec4(1, 1, 1, 1),
        duration: 2000, startTime: time, fadeInTime: 0, flags: 0, shader: this.host.media.bloodTrailShader });
      blood.leType = "fall-scale-fade"; blood.pos = { ...blood.pos, delta: { ...blood.pos.delta, z: 40 } };
    }
  }
  private scorePlum(entity: SpriteLocalEntity, frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    const re = entity.refEntity, c = remaining(entity, frame.time);
    let score = qvmFloatToInt(entity.radius);
    let color = score < 0 ? vec4(255, 17, 17, 255) : score >= 50 ? vec4(255, 0, 255, 255)
      : score >= 20 ? vec4(0, 0, 255, 255) : score >= 10 ? vec4(255, 255, 0, 255)
        : score >= 2 ? vec4(0, 255, 0, 255) : vec4(255, 255, 255, 255);
    if (c < 0.25) color = { ...color, w: byte(f32(f32(255 * 4) * c)) };
    re.shaderRGBA = color; re.radius = 4;
    let origin = { ...entity.pos.base, z: f32(entity.pos.base.z + f32(110 - f32(c * 100))) };
    const direction = normalize3(cross3(sub3(frame.viewOrigin, origin), vec3(0, 0, 1)));
    const phase = f32(f32(c * 2) * f32(Math.PI));
    origin = add3(origin, scale3(direction, f32(-10 + f32(20 * f32(Math.sin(phase))))));
    if (length3(sub3(origin, frame.viewOrigin)) < 20) { this.pool.free(entity); return; }
    const negative = score < 0;
    if (negative) score = -score;
    const digits: number[] = [];
    do { digits.push(score % 10); score = Math.trunc(score / 10); } while (score !== 0);
    if (negative) digits.push(10);
    for (let index = 0; index < digits.length; index++) {
      re.origin = add3(origin, scale3(direction, f32(f32(f32(digits.length / 2) - index) * 8)));
      const digit = digits[digits.length - 1 - index];
      if (digit === undefined) throw new Error("Missing score digit");
      const shader = this.host.media.numberShaders[digit];
      if (shader === undefined) throw new Error("Missing score digit shader");
      re.customShader = shader; scene.addRefEntity(re);
    }
  }
  private kamikaze(entity: ModelLocalEntity, frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    const host = this.host;
    if (host.product !== "missionpack") throw new Error("Kamikaze requires missionpack media");
    const t = (frame.time - entity.startTime) | 0, re = entity.refEntity, axis = anglesToAxis(vec3(0, 0, 0));
    if (t > 0 && t < 2000) {
      if (!(entity.leFlags & LocalEntityFlags.SOUND1)) {
        host.audio.startSound(host.media.kamikazeExplodeSound, { entity: host.clientNum, channel: 0, origin: { kind: "local" }, volume: 127 });
        entity.leFlags |= LocalEntityFlags.SOUND1;
      }
      this.shockwave(entity, axis, t, 0, 2000, 1500, 1320, scene);
    }
    if (t > 250 && t < 2250) {
      re.shaderRGBA = rgba(entity.color, f32(remaining(entity, frame.time) * 255));
      let c: number;
      if (t < 2000) c = f32(f32(t - 250) / 1750);
      else {
        if (!(entity.leFlags & LocalEntityFlags.SOUND2)) {
          host.audio.startSound(host.media.kamikazeImplodeSound, { entity: host.clientNum, channel: 0, origin: { kind: "local" }, volume: 127 });
          entity.leFlags |= LocalEntityFlags.SOUND2;
        }
        c = f32(f32(2250 - t) / 250);
      }
      re.axis = scaledAxis(axis, f32(f32(c * 720) / 72)); re.nonNormalizedAxes = true;
      scene.addRefEntity(re);
      scene.addLight({ origin: re.origin, radius: f32(c * 1000), color: vec3(1, 1, c) });
    }
    if (t > 2000 && t < 3000) {
      const angles = entity.angles.base;
      if (angles.x === 0 && angles.y === 0 && angles.z === 0) entity.angles = { ...entity.angles,
        base: vec3(f32(host.random.random() * 360), f32(host.random.random() * 360), f32(host.random.random() * 360)) };
      this.shockwave(entity, anglesToAxis(entity.angles.base), t, 2000, 3000, 2500, 704, scene);
    }
  }
  private shockwave(entity: ModelLocalEntity, axis: Axis, time: number, start: number, end: number, fade: number, radius: number, scene: LocalEntitySceneSink): void {
    if (this.host.product !== "missionpack") throw new Error("Shockwave requires missionpack media");
    const re = createModelEntity(this.host.media.kamikazeShockWave);
    re.shaderTime = entity.refEntity.shaderTime; re.origin = { ...entity.refEntity.origin };
    const c = f32(f32(time - start) / f32(end - start));
    re.axis = scaledAxis(axis, f32(f32(c * radius) / 88)); re.nonNormalizedAxes = true;
    const alpha = time > fade ? f32(f32(time - fade) / f32(end - fade)) : 0;
    const channel = byte(f32(255 - f32(alpha * 255)));
    re.shaderRGBA = vec4(channel, channel, channel, channel); scene.addRefEntity(re);
  }
  private invulnerabilityJuiced(entity: ModelLocalEntity, frame: LocalEntityFrame, scene: LocalEntitySceneSink): void {
    const t = (frame.time - entity.startTime) | 0, re = entity.refEntity;
    if (t > 3000) {
      const xy = f32(1 + f32(f32(f32(0.3) * f32(t - 3000)) / 2000));
      const z = f32(f32(0.7) + f32(f32(f32(0.3) * f32(2000 - (t - 3000))) / 2000));
      re.axis = [{ ...re.axis[0], x: xy }, { ...re.axis[1], y: xy }, { ...re.axis[2], z }];
    }
    if (t > 5000) { entity.endTime = 0; this.effects.gibPlayer(re.origin); }
    else scene.addRefEntity(re);
  }
}
