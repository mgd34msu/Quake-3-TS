// Player media and presentation from id Software's code/cgame/cg_players.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { parsePlayerAnimationConfig, PlayerAnimationParseError } from "../assets/animation.ts";
import { lerpModelTag } from "../render/model-tags.ts";
import type { PcmSound } from "../assets/wav.ts";
import { CommonError } from "../core/common-error.ts";
import { add3, cross3, dot3, length3, normalize3, scale3, sub3, vec3, vec4 } from "../core/math.ts";
import type { Bounds, Vec3, Vec4 } from "../core/math.ts";
import { qvmAnglesToAxis } from "../core/qvm-math.ts";
import { float32ToBits } from "../core/numeric.ts";
import { gameFormat } from "../game/format.ts";
import type { GameFormatArgument } from "../game/format.ts";
import { CommonParseState } from "../core/common-parse.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { gameAtoi } from "../game/numeric.ts";
import type { GameRandom } from "../game/numeric.ts";
import { createModelEntity, createSpriteEntity, RF_THIRD_PERSON, RF_LIGHTING_ORIGIN, RF_SHADOW_PLANE } from "../render/ref-entity.ts";
import type { RefEntity, RefModelEntity, RefPoly, RefPolyVertex, SceneModel, SceneShader, SceneSkin } from "../render/ref-entity.ts";
import type { DynamicLight, LightingSample } from "../render/lighting.ts";
import type { RendererResources } from "../render/world.ts";
import type { AssetReader } from "../assets/reader.ts";
import { EntityType, GameType, PersistentIndex, Powerup, Team } from "../shared/definitions.ts";
import type { EntityState } from "../shared/entity-state.ts";
import { PlayerAnimation } from "../shared/player-state.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import { evaluateTrajectory } from "../shared/trajectory.ts";
import type { CollisionWorld, TraceResult } from "../collision/world.ts";
import { clearLerpFrame, createLerpFrame, runLerpFrame, ANIMATION_TOGGLE_BIT } from "./animation.ts";
import { calculatePlayerPose, swingAngles } from "./player-pose.ts";
import { positionEntityOnTag, positionRotatedEntityOnTag } from "./entities.ts";
import type { ClientEffects } from "./effects.ts";
import type { ImpactMarkSystem } from "./marks.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";
import { ClientInfo } from "./client-info.ts";

export const CUSTOM_SOUND_NAMES: readonly string[] = ["*death1.wav", "*death2.wav", "*death3.wav", "*jump1.wav",
  "*pain25_1.wav", "*pain50_1.wav", "*pain75_1.wav", "*pain100_1.wav", "*falling1.wav", "*gasp.wav", "*drown.wav", "*fall1.wav", "*taunt.wav"];


export interface ClientInfoSettings {
  readonly gameType: GameType;
  readonly maxClients: number;
  readonly forceModel: boolean;
  readonly model: string;
  readonly headModel: string;
  readonly redTeamName: string;
  readonly blueTeamName: string;
  readonly deferPlayers: boolean;
  readonly buildScript: boolean;
  readonly loading: boolean;
}
export interface ClientInfoHost {
  readonly state: ClientGameState;
  readonly assets: AssetReader;
  readonly resources: Pick<RendererResources, "registerModel" | "registerSkin">;
  settings(): ClientInfoSettings;
  memoryRemaining(): number;
  registerShaderNoMip(name: string): Promise<SceneShader | null>;
  registerSound(name: string, compressed: false): Promise<PcmSound | null>;
  /** Synchronous registration trap, backed by the engine's preloaded sound cache during frames. */
  sound(name: string, compressed: false): PcmSound | null;
  print(message: string): void;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Player index ${index} outside ${values.length}`);
  return value;
}
function integer(value: string): number { return gameAtoi(value); }
function qpath(value: string): string { return value.slice(0, 63); }
function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function color(value: string): Vec3 {
  const bits = integer(value);
  return bits < 1 || bits > 7 ? vec3(1, 1, 1) : vec3((bits & 4) !== 0 ? 1 : 0, (bits & 2) !== 0 ? 1 : 0, (bits & 1) !== 0 ? 1 : 0);
}

export interface PlayerMedia {
  readonly connectionShader: SceneShader | null; readonly balloonShader: SceneShader | null;
  readonly medalImpressive: SceneShader | null; readonly medalExcellent: SceneShader | null;
  readonly medalGauntlet: SceneShader | null; readonly medalDefend: SceneShader | null;
  readonly medalAssist: SceneShader | null; readonly medalCapture: SceneShader | null; readonly friendShader: SceneShader | null;
  readonly shadowMarkShader: SceneShader | null; readonly wakeMarkShader: SceneShader | null;
  readonly invisShader: SceneShader | null; readonly quadShader: SceneShader | null; readonly redQuadShader: SceneShader | null;
  readonly regenShader: SceneShader | null; readonly battleSuitShader: SceneShader | null; readonly hastePuffShader: SceneShader | null;
  readonly flightSound: PcmSound | null;
  readonly redFlagModel: SceneModel; readonly blueFlagModel: SceneModel; readonly neutralFlagModel: SceneModel;
  readonly flagPoleModel: SceneModel; readonly flagFlapModel: SceneModel;
  readonly redFlagFlapSkin: SceneSkin | null; readonly blueFlagFlapSkin: SceneSkin | null; readonly neutralFlagFlapSkin: SceneSkin | null;
}
export interface MissionPlayerMedia {
  readonly redCubeModel: SceneModel; readonly blueCubeModel: SceneModel;
  readonly kamikazeHeadModel: SceneModel; readonly kamikazeHeadTrail: SceneModel;
  readonly guardPowerupModel: SceneModel; readonly scoutPowerupModel: SceneModel; readonly doublerPowerupModel: SceneModel;
  readonly ammoRegenPowerupModel: SceneModel; readonly invulnerabilityPowerupModel: SceneModel; readonly medkitUsageModel: SceneModel;
  readonly shotgunSmokePuffShader: SceneShader | null; readonly dustPuffShader: SceneShader | null;
}
export interface PlayerPresentationSettings {
  readonly gameType: GameType; readonly cameraMode: boolean;
  readonly noPlayerAnimations: boolean; readonly animationSpeed: number; readonly swingSpeed: number;
  readonly drawFriend: boolean; readonly shadows: number; readonly enableBreath: boolean; readonly enableDust: boolean;
  readonly debugPosition: boolean; readonly debugAnimation: boolean;
}
export interface PlayerPolyVertex extends RefPolyVertex { color: Vec4 }
interface PlayerServices {
  readonly state: ClientGameState;
  readonly media: PlayerMedia;
  readonly clients: Pick<ClientInfoStore, "clientInfo">;
  readonly collision: Pick<CollisionWorld, "trace" | "pointContents">;
  readonly effects: Pick<ClientEffects, "smokePuff">;
  readonly random: Pick<GameRandom, "rand">;
  settings(): PlayerPresentationSettings;
  trace(start: Vec3, end: Vec3, bounds: Bounds, skipNumber: number, mask: number): TraceResult;
  addEntity(entity: RefEntity): void;
  addLight(light: DynamicLight): void;
  addPoly(poly: RefPoly): void;
  lightForPoint(point: Vec3): LightingSample;
  readonly marks: Pick<ImpactMarkSystem, "impactMark">;
  addLoopingSound(entityNum: number, origin: Vec3, velocity: Vec3, sound: PcmSound | null): void;
  addPlayerWeapon(parent: RefModelEntity, ps: SourcePlayerState | null, entity: ClientEntity, team: Team): void;
  print(message: string): void;
}
export type PlayerPresentationHost = PlayerServices & ({ readonly product: "baseq3" }
  | { readonly product: "missionpack"; readonly missionMedia: MissionPlayerMedia });

const f = Math.fround;
const ZERO = vec3(0, 0, 0), WHITE = vec4(1, 1, 1, 1), WHITE_BYTES = vec4(255, 255, 255, 255);
const MASK_PLAYERSOLID = 1 | 0x10000 | 0x2000000, MASK_WATER = 8 | 16 | 32;
const DEAD = 1, KAMIKAZE = 0x200;
function powered(state: EntityState, powerup: Powerup): boolean { return (state.powerups & (1 << powerup)) !== 0; }
function cloneModel(entity: RefModelEntity): RefModelEntity {
  return { ...entity, origin: { ...entity.origin }, oldOrigin: { ...entity.oldOrigin }, lightingOrigin: { ...entity.lightingOrigin },
    axis: [{ ...entity.axis[0] }, { ...entity.axis[1] }, { ...entity.axis[2] }], shaderRGBA: { ...entity.shaderRGBA }, shaderTexCoord: { ...entity.shaderTexCoord } };
}
function sphereAngle(time: number, divisor: number): number { return f(f(f((Math.trunc(time / divisor) & 255) * f(Math.PI * 2))) / 255); }

/** Frame presentation never performs I/O. All handles belong to its client's loaded media lifetime. */
export class PlayerPresenter {
  constructor(readonly host: PlayerPresentationHost) {
    if (host.product !== host.state.product) throw new Error("Player media product differs from cgame product");
  }
  private get time(): number { return this.host.state.time; }
  private snapshot(): SourcePlayerState {
    const snap = this.host.state.snap;
    if (snap === null) throw new Error("CG_Player requires an active snapshot");
    return snap.playerState;
  }
  resetPlayerEntity(entity: ClientEntity): void {
    const ci = this.host.clients.clientInfo(entity.currentState.clientNum);
    const print = this.host.settings().debugAnimation ? (message: string) => this.host.print(message) : null;
    entity.errorTime = -99999; entity.extrapolated = false;
    clearLerpFrame(ci, entity.player.legs, entity.currentState.legsAnim, this.time, print);
    clearLerpFrame(ci, entity.player.torso, entity.currentState.torsoAnim, this.time, print);
    entity.lerpOrigin = evaluateTrajectory(entity.currentState.pos, this.time);
    entity.lerpAngles = evaluateTrajectory(entity.currentState.apos, this.time);
    entity.rawOrigin = { ...entity.lerpOrigin }; entity.rawAngles = { ...entity.lerpAngles };
    // The source memset follows ClearLerpFrame and discards its timing/animation pointer.
    Object.assign(entity.player.legs, createLerpFrame(), { yawAngle: entity.rawAngles.y, yawing: false, pitchAngle: 0, pitching: false });
    Object.assign(entity.player.torso, createLerpFrame(), { yawAngle: entity.rawAngles.y, yawing: false, pitchAngle: entity.rawAngles.x, pitching: false });
    if (this.host.settings().debugPosition) this.host.print(gameFormat("%i ResetPlayerEntity yaw=%i\n", [entity.currentState.number, float32ToBits(entity.player.torso.yawAngle) | 0]));
  }
  addRefEntityWithPowerups(entity: RefModelEntity, state: EntityState, team: Team): void {
    const media = this.host.media;
    if (powered(state, Powerup.PW_INVIS)) { entity.customShader = media.invisShader; this.host.addEntity(entity); return; }
    this.host.addEntity(entity);
    if (powered(state, Powerup.PW_QUAD)) { entity.customShader = team === Team.TEAM_RED ? media.redQuadShader : media.quadShader; this.host.addEntity(entity); }
    if (powered(state, Powerup.PW_REGEN) && Math.trunc(this.time / 100) % 10 === 1) { entity.customShader = media.regenShader; this.host.addEntity(entity); }
    if (powered(state, Powerup.PW_BATTLESUIT)) { entity.customShader = media.battleSuitShader; this.host.addEntity(entity); }
  }
  lightVerts(normal: Vec3, vertices: readonly [PlayerPolyVertex, ...PlayerPolyVertex[]]): boolean {
    const light = this.host.lightForPoint(vertices[0].position), incoming = dot3(normal, light.lightDir);
    const component = (ambient: number, directed: number): number => incoming <= 0 ? Math.trunc(ambient) & 255 : Math.min(255, Math.trunc(f(ambient + f(incoming * directed)))) & 255;
    for (const vertex of vertices) vertex.color = vec4(component(light.ambientLight.x, light.directedLight.x),
      component(light.ambientLight.y, light.directedLight.y), component(light.ambientLight.z, light.directedLight.z), 255);
    return true;
  }
  private animation(entity: ClientEntity, ci: ClientInfo, legs: RefModelEntity, torso: RefModelEntity, options: PlayerPresentationSettings): void {
    if (options.noPlayerAnimations) return;
    const state = entity.currentState, speedScale = powered(state, Powerup.PW_HASTE) ? 1.5 : 1;
    const animation = entity.player.legs.yawing && (state.legsAnim & ~ANIMATION_TOGGLE_BIT) === PlayerAnimation.LEGS_IDLE ? PlayerAnimation.LEGS_TURN : state.legsAnim;
    const print = options.debugAnimation ? (message: string) => this.host.print(message) : null;
    runLerpFrame(ci, entity.player.legs, { timeMs: this.time, newAnimation: animation, speedScale, noPlayerAnimations: options.animationSpeed === 0 }, print);
    runLerpFrame(ci, entity.player.torso, { timeMs: this.time, newAnimation: state.torsoAnim, speedScale, noPlayerAnimations: options.animationSpeed === 0 }, print);
    legs.oldFrame = entity.player.legs.oldFrame; legs.frame = entity.player.legs.frame; legs.backLerp = entity.player.legs.backLerp;
    torso.oldFrame = entity.player.torso.oldFrame; torso.frame = entity.player.torso.frame; torso.backLerp = entity.player.torso.backLerp;
  }
  private sprite(entity: ClientEntity, shader: SceneShader | null): void {
    const sprite = createSpriteEntity();
    sprite.origin = add3(entity.lerpOrigin, vec3(0, 0, 48)); sprite.customShader = shader; sprite.radius = 10;
    sprite.renderFlags = entity.currentState.number === this.snapshot().clientNum && !this.host.state.renderingThirdPerson ? RF_THIRD_PERSON : 0;
    sprite.shaderRGBA = { ...WHITE_BYTES }; this.host.addEntity(sprite);
  }
  private sprites(entity: ClientEntity, ci: ClientInfo, options: PlayerPresentationSettings): void {
    const media = this.host.media;
    const choices: readonly (readonly [number, SceneShader | null])[] = [[0x2000, media.connectionShader], [0x1000, media.balloonShader],
      [0x8000, media.medalImpressive], [8, media.medalExcellent], [64, media.medalGauntlet], [0x10000, media.medalDefend], [0x20000, media.medalAssist], [0x800, media.medalCapture]];
    for (const [flag, shader] of choices) if (entity.currentState.eFlags & flag) { this.sprite(entity, shader); return; }
    if (!(entity.currentState.eFlags & DEAD) && this.snapshot().persistant.get(PersistentIndex.PERS_TEAM) === ci.team && options.gameType >= GameType.GT_TEAM && options.drawFriend) this.sprite(entity, media.friendShader);
  }
  private shadow(entity: ClientEntity, options: PlayerPresentationSettings): { readonly visible: boolean; readonly plane: number } {
    if (options.shadows === 0 || powered(entity.currentState, Powerup.PW_INVIS)) return { visible: false, plane: 0 };
    const trace = this.host.collision.trace({ start: entity.lerpOrigin, end: add3(entity.lerpOrigin, vec3(0, 0, -128)),
      shape: { kind: "box", mins: vec3(-15, -15, 0), maxs: vec3(15, 15, 2) }, mask: MASK_PLAYERSOLID });
    if (trace.fraction === 1 || trace.solidity !== "clear") return { visible: false, plane: 0 };
    const plane = f(trace.end.z + 1);
    if (options.shadows !== 1) return { visible: true, plane };
    if (trace.contact.kind !== "plane") throw new Error("Player shadow hit has no contact plane");
    const alpha = f(1 - trace.fraction);
    for (const poly of this.host.marks.impactMark({ shader: this.host.media.shadowMarkShader, origin: trace.end, direction: trace.contact.plane.normal,
      orientation: entity.player.legs.yawAngle, color: vec4(alpha, alpha, alpha, 1), alphaFade: false, radius: 24, temporary: true })) this.host.addPoly(poly);
    return { visible: true, plane };
  }
  private splash(entity: ClientEntity, options: PlayerPresentationSettings): void {
    if (options.shadows === 0) return;
    const end = add3(entity.lerpOrigin, vec3(0, 0, -24));
    if (!(this.host.collision.pointContents(end) & MASK_WATER)) return;
    const start = add3(entity.lerpOrigin, vec3(0, 0, 32));
    if (this.host.collision.pointContents(start) & (1 | MASK_WATER)) return;
    const trace = this.host.collision.trace({ start, end, shape: { kind: "point" }, mask: MASK_WATER });
    if (trace.fraction === 1) return;
    const vertex = (x: number, y: number, s: number, t: number): PlayerPolyVertex => ({ position: add3(trace.end, vec3(x, y, 0)), texCoord: { x: s, y: t }, color: { ...WHITE_BYTES } });
    this.host.addPoly({ shader: this.host.media.wakeMarkShader, vertices: [vertex(-32, -32, 0, 0), vertex(-32, 32, 0, 1), vertex(32, 32, 1, 1), vertex(32, -32, 1, 0)] });
  }
  private hasteTrail(entity: ClientEntity): void {
    if (entity.trailTime > this.time) return;
    const animation = entity.player.legs.animationNumber & ~ANIMATION_TOGGLE_BIT;
    if (animation !== PlayerAnimation.LEGS_RUN && animation !== PlayerAnimation.LEGS_BACK) return;
    entity.trailTime = (entity.trailTime + 100) | 0;
    if (entity.trailTime < this.time) entity.trailTime = this.time;
    const smoke = this.host.effects.smokePuff({ origin: add3(entity.lerpOrigin, vec3(0, 0, -16)), velocity: ZERO, radius: 8,
      color: WHITE, duration: 500, startTime: this.time, fadeInTime: 0, flags: 0, shader: this.host.media.hastePuffShader });
    smoke.leType = "scale-fade";
  }
  private breath(entity: ClientEntity, head: RefModelEntity, options: PlayerPresentationSettings, media: MissionPlayerMedia): void {
    if (!options.enableBreath || entity.currentState.number === this.snapshot().clientNum && !this.host.state.renderingThirdPerson || entity.currentState.eFlags & DEAD) return;
    const ci = this.host.clients.clientInfo(entity.currentState.number);
    if (this.host.collision.pointContents(head.origin) & MASK_WATER || ci.breathPuffTime > this.time) return;
    this.host.effects.smokePuff({ origin: add3(add3(head.origin, scale3(head.axis[0], 8)), scale3(head.axis[2], -4)), velocity: vec3(0, 0, 8),
      radius: 16, color: vec4(1, 1, 1, 0.66), duration: 1500, startTime: this.time, fadeInTime: (this.time + 400) | 0, flags: 1, shader: media.shotgunSmokePuffShader });
    ci.breathPuffTime = (this.time + 2000) | 0;
  }
  private dust(entity: ClientEntity, options: PlayerPresentationSettings, media: MissionPlayerMedia): void {
    if (!options.enableDust || entity.dustTrailTime > this.time) return;
    const animation = entity.player.legs.animationNumber & ~ANIMATION_TOGGLE_BIT;
    if (animation !== PlayerAnimation.LEGS_LANDB && animation !== PlayerAnimation.LEGS_LAND) return;
    entity.dustTrailTime = (entity.dustTrailTime + 40) | 0;
    if (entity.dustTrailTime < this.time) entity.dustTrailTime = this.time;
    const origin = entity.currentState.pos.base;
    const trace = this.host.trace(origin, add3(origin, vec3(0, 0, -64)), { min: ZERO, max: ZERO }, entity.currentState.number, MASK_PLAYERSOLID);
    if (!(trace.surfaceFlags & 0x40000)) return;
    this.host.effects.smokePuff({ origin: add3(origin, vec3(0, 0, -16)), velocity: vec3(0, 0, -30), radius: 24,
      color: vec4(0.8, 0.8, 0.7, 0.33), duration: 500, startTime: this.time, fadeInTime: 0, flags: 0, shader: media.dustPuffShader });
  }
  private trailItem(entity: ClientEntity, model: SceneModel): void {
    const angles = vec3(0, entity.lerpAngles.y, 0), axis = qvmAnglesToAxis(angles), item = createModelEntity(model);
    item.origin = add3(add3(entity.lerpOrigin, scale3(axis[0], -16)), vec3(0, 0, 16));
    item.axis = qvmAnglesToAxis(vec3(0, angles.y + 90, 0)); this.host.addEntity(item);
  }
  private flag(entity: ClientEntity, skin: SceneSkin | null, torso: RefModelEntity, options: PlayerPresentationSettings): void {
    const pole = createModelEntity(this.host.media.flagPoleModel), flag = createModelEntity(this.host.media.flagFlapModel);
    pole.lightingOrigin = { ...torso.lightingOrigin }; pole.shadowPlane = torso.shadowPlane; pole.renderFlags = torso.renderFlags;
    positionEntityOnTag(pole, torso, torso.model, "tag_flag"); this.host.addEntity(pole);
    flag.customSkin = skin; flag.lightingOrigin = { ...torso.lightingOrigin }; flag.shadowPlane = torso.shadowPlane; flag.renderFlags = torso.renderFlags;
    const legs = entity.currentState.legsAnim & ~ANIMATION_TOGGLE_BIT;
    const idle = legs === PlayerAnimation.LEGS_IDLE || legs === PlayerAnimation.LEGS_IDLECR;
    const walk = legs === PlayerAnimation.LEGS_WALK || legs === PlayerAnimation.LEGS_WALKCR;
    if (!idle) {
      const direction = normalize3(add3(entity.currentState.pos.delta, vec3(0, 0, 100)));
      if (Math.abs(dot3(pole.axis[2], direction)) < f(0.9)) {
        const angle = f(Math.acos(Math.max(-1, Math.min(1, dot3(pole.axis[0], direction)))));
        const degrees = f(f(angle * 180) / f(Math.PI));
        let yaw = dot3(pole.axis[1], direction) < 0 ? f(360 - degrees) : degrees;
        if (yaw < 0) yaw = f(yaw + 360); if (yaw > 360) yaw = f(yaw - 360);
        const swing = swingAngles({ destination: yaw, swingTolerance: 25, clampTolerance: 90, speed: 0.15,
          frameTimeMs: this.host.state.frameTime, angle: entity.player.flag.yawAngle, swinging: entity.player.flag.yawing });
        entity.player.flag.yawAngle = swing.angle; entity.player.flag.yawing = swing.swinging;
      }
    }
    runLerpFrame(this.host.clients.clientInfo(entity.currentState.clientNum), entity.player.flag,
      { timeMs: this.time, newAnimation: idle || walk ? PlayerAnimation.FLAG_STAND : PlayerAnimation.FLAG_RUN, speedScale: 1, noPlayerAnimations: options.animationSpeed === 0 },
      options.debugAnimation ? message => this.host.print(message) : null);
    flag.oldFrame = entity.player.flag.oldFrame; flag.frame = entity.player.flag.frame; flag.backLerp = entity.player.flag.backLerp;
    flag.axis = qvmAnglesToAxis(vec3(0, entity.player.flag.yawAngle, 0));
    positionRotatedEntityOnTag(flag, pole, pole.model, "tag_flag"); this.host.addEntity(flag);
  }
  private powerups(entity: ClientEntity, torso: RefModelEntity, ci: ClientInfo, options: PlayerPresentationSettings): void {
    const state = entity.currentState, media = this.host.media;
    if (!state.powerups) return;
    const light = (color: Vec3): void => this.host.addLight({ origin: entity.lerpOrigin, radius: 200 + (this.host.random.rand() & 31), color });
    if (powered(state, Powerup.PW_QUAD)) light(vec3(0.2, 0.2, 1));
    if (powered(state, Powerup.PW_FLIGHT)) this.host.addLoopingSound(state.number, entity.lerpOrigin, ZERO, media.flightSound);
    const flags: readonly (readonly [Powerup, SceneModel, SceneSkin | null, Vec3])[] = [
      [Powerup.PW_REDFLAG, media.redFlagModel, media.redFlagFlapSkin, vec3(1, 0.2, 0.2)],
      [Powerup.PW_BLUEFLAG, media.blueFlagModel, media.blueFlagFlapSkin, vec3(0.2, 0.2, 1)],
      [Powerup.PW_NEUTRALFLAG, media.neutralFlagModel, media.neutralFlagFlapSkin, vec3(1, 1, 1)]];
    for (const [powerup, model, skin, color] of flags) if (powered(state, powerup)) {
      if (ci.newAnims) this.flag(entity, skin, torso, options); else this.trailItem(entity, model);
      light(color);
    }
    if (powered(state, Powerup.PW_HASTE)) this.hasteTrail(entity);
  }
  private tokens(entity: ClientEntity, ci: ClientInfo, renderFlags: number, media: MissionPlayerMedia): void {
    const tokens = Math.min(entity.currentState.generic1, 10);
    const trail = this.host.state.skullTrails[entity.currentState.number];
    if (trail === undefined) {
      // Corpses have non-client entity numbers. Omit source's out-of-bounds zero write.
      if (tokens === 0) return;
      throw new RangeError(`No skull trail for entity ${entity.currentState.number}`);
    }
    if (!tokens) { trail.numPositions = 0; return; }
    for (let i = 0; i < tokens - trail.numPositions; i++) {
      for (let j = trail.numPositions; j > 0; j--) trail.positions[j] = { ...at(trail.positions, j - 1) };
      trail.positions[0] = { ...entity.lerpOrigin };
    }
    trail.numPositions = tokens;
    let origin = entity.lerpOrigin;
    for (let i = 0; i < trail.numPositions; i++) {
      const delta = sub3(at(trail.positions, i), origin);
      if (length3(delta) > 30) trail.positions[i] = add3(origin, scale3(normalize3(delta), 30));
      origin = at(trail.positions, i);
    }
    const skull = createModelEntity(ci.team === Team.TEAM_BLUE ? media.redCubeModel : media.blueCubeModel);
    skull.renderFlags = renderFlags; origin = entity.lerpOrigin;
    for (let i = 0; i < trail.numPositions; i++) {
      const position = at(trail.positions, i), delta = sub3(origin, position), forward = normalize3(vec3(delta.x, delta.y, 0)), up = vec3(0, 0, 1);
      skull.axis = [forward, cross3(forward, up), up];
      const angle = sphereAngle((this.time + 500 * 10 - 500 * i) | 0, 16);
      skull.origin = add3(position, vec3(0, 0, f(f(Math.sin(angle)) * 10)));
      this.host.addEntity(skull); origin = position;
    }
  }
  private kamikaze(entity: ClientEntity, torso: RefModelEntity, media: MissionPlayerMedia): void {
    const skull = createModelEntity(); skull.lightingOrigin = { ...entity.lerpOrigin }; skull.shadowPlane = torso.shadowPlane; skull.renderFlags = torso.renderFlags;
    const pair = (flipTrail = false): void => {
      skull.model = media.kamikazeHeadModel; this.host.addEntity(skull);
      if (flipTrail) skull.axis = [skull.axis[0], scale3(skull.axis[1], -1), skull.axis[2]];
      skull.model = media.kamikazeHeadTrail; this.host.addEntity(skull);
    };
    const orbitAxis = (direction: Vec3): void => {
      const side = normalize3(vec3(direction.x, direction.y, 0)), up = vec3(0, 0, 1);
      skull.axis = [cross3(side, up), side, up];
    };
    if (entity.currentState.eFlags & DEAD) {
      let angle = sphereAngle(this.time, 7);
      if (angle > f(Math.PI * 2)) angle = f(angle - f(f(Math.PI) * 2));
      const x = f(f(Math.sin(angle)) * 20), y = f(f(Math.cos(angle)) * 20);
      angle = sphereAngle(this.time, 4);
      const direction = vec3(x, y, f(15 + f(f(Math.sin(angle)) * 8)));
      skull.origin = add3(torso.origin, direction); orbitAxis(direction); pair(); return;
    }
    let angle = sphereAngle(this.time, 4);
    let direction = vec3(f(f(Math.cos(angle)) * 20), f(f(Math.sin(angle)) * 20), f(f(Math.cos(angle)) * 20));
    skull.origin = add3(torso.origin, direction);
    let yaw = f(f(f(angle * 180) / f(Math.PI)) + 90);
    if (yaw > 360) yaw = f(yaw - 360);
    skull.axis = qvmAnglesToAxis(vec3(f(f(Math.sin(angle)) * 30), yaw, 0)); pair(true);
    angle = f(sphereAngle(this.time, 4) + f(Math.PI));
    if (angle > f(Math.PI * 2)) angle = f(angle - f(f(Math.PI) * 2));
    direction = vec3(f(f(Math.sin(angle)) * 20), f(f(Math.cos(angle)) * 20), f(f(Math.cos(angle)) * 20));
    skull.origin = add3(torso.origin, direction);
    yaw = f(360 - f(f(angle * 180) / f(Math.PI))); if (yaw > 360) yaw = f(yaw - 360);
    skull.axis = qvmAnglesToAxis(vec3(f(f(Math.cos(f(angle - f(0.5 * Math.PI)))) * 30), yaw, 0)); pair();
    angle = f(sphereAngle(this.time, 3) + f(0.5 * Math.PI));
    if (angle > f(Math.PI * 2)) angle = f(angle - f(f(Math.PI) * 2));
    direction = vec3(f(f(Math.sin(angle)) * 20), f(f(Math.cos(angle)) * 20), 0);
    skull.origin = add3(torso.origin, direction); orbitAxis(direction); pair();
  }
  private missionPowerups(entity: ClientEntity, ci: ClientInfo, torso: RefModelEntity, media: MissionPlayerMedia): void {
    if (entity.currentState.eFlags & KAMIKAZE) this.kamikaze(entity, torso, media);
    const attachments: readonly (readonly [Powerup, SceneModel])[] = [[Powerup.PW_GUARD, media.guardPowerupModel], [Powerup.PW_SCOUT, media.scoutPowerupModel],
      [Powerup.PW_DOUBLER, media.doublerPowerupModel], [Powerup.PW_AMMOREGEN, media.ammoRegenPowerupModel]];
    for (const [powerup, model] of attachments) if (powered(entity.currentState, powerup)) {
      const attachment = cloneModel(torso); attachment.model = model; attachment.frame = 0; attachment.oldFrame = 0; attachment.customSkin = null;
      this.host.addEntity(attachment);
    }
    const invulnerable = powered(entity.currentState, Powerup.PW_INVULNERABILITY);
    if (invulnerable) { if (!ci.invulnerabilityStartTime) ci.invulnerabilityStartTime = this.time; ci.invulnerabilityStopTime = this.time; }
    else ci.invulnerabilityStartTime = 0;
    const sinceStart = (this.time - ci.invulnerabilityStartTime) | 0, sinceStop = (this.time - ci.invulnerabilityStopTime) | 0;
    if (invulnerable || sinceStop < 250) {
      const shell = cloneModel(torso); shell.model = media.invulnerabilityPowerupModel; shell.customSkin = null;
      shell.renderFlags &= ~RF_THIRD_PERSON; shell.origin = { ...entity.lerpOrigin };
      const scale = sinceStart < 250 ? f(f(sinceStart) / 250) : sinceStop < 250 ? f(f((250 - sinceStop) | 0) / 250) : 1;
      shell.axis = [vec3(scale, 0, 0), vec3(0, scale, 0), vec3(0, 0, scale)]; this.host.addEntity(shell);
    }
    const elapsed = (this.time - ci.medkitUsageTime) | 0;
    if (ci.medkitUsageTime && elapsed < 500) {
      const medkit = cloneModel(torso); medkit.model = media.medkitUsageModel; medkit.customSkin = null; medkit.renderFlags &= ~RF_THIRD_PERSON;
      medkit.axis = qvmAnglesToAxis(ZERO); medkit.origin = add3(entity.lerpOrigin, vec3(0, 0, f(-24 + f(f(f(elapsed) * 80) / 500))));
      const c = elapsed > 400 ? Math.trunc(f(255 - f(f(f((elapsed - 1000) | 0) * 255) / 100))) & 255 : 255;
      medkit.shaderRGBA = vec4(c, c, c, c); this.host.addEntity(medkit);
    }
  }
  player(entity: ClientEntity): void {
    const clientNum = entity.currentState.clientNum;
    if (clientNum < 0 || clientNum >= 64) throw new CommonError("drop", "Bad clientNum on player entity");
    const ci = this.host.clients.clientInfo(clientNum);
    if (!ci.infoValid) return;
    const options = this.host.settings();
    let renderFlags = 0;
    if (entity.currentState.number === this.snapshot().clientNum) {
      if (!this.host.state.renderingThirdPerson) renderFlags = RF_THIRD_PERSON;
      else if (options.cameraMode) return;
    }
    const legs = createModelEntity(), torso = createModelEntity(), head = createModelEntity();
    const pose = calculatePlayerPose(entity.player, { entity: entity.currentState, animationConfig: ci, lerpAngles: entity.lerpAngles,
      timeMs: this.time, frameTimeMs: this.host.state.frameTime, swingSpeed: options.swingSpeed });
    legs.axis = pose.legs; torso.axis = pose.torso; head.axis = pose.head;
    this.animation(entity, ci, legs, torso, options);
    this.sprites(entity, ci, options);
    const shadow = this.shadow(entity, options); this.splash(entity, options);
    if (options.shadows === 3 && shadow.visible) renderFlags |= RF_SHADOW_PLANE;
    renderFlags |= RF_LIGHTING_ORIGIN;
    if (this.host.product === "missionpack" && options.gameType === GameType.GT_HARVESTER) this.tokens(entity, ci, renderFlags, this.host.missionMedia);
    legs.model = ci.legsModel; legs.customSkin = ci.legsSkin; legs.origin = { ...entity.lerpOrigin };
    legs.lightingOrigin = { ...entity.lerpOrigin }; legs.shadowPlane = shadow.plane; legs.renderFlags = renderFlags; legs.oldOrigin = { ...legs.origin };
    this.addRefEntityWithPowerups(legs, entity.currentState, ci.team);
    if (legs.model.kind === "default" || ci.torsoModel.kind === "default") return;
    torso.model = ci.torsoModel; torso.customSkin = ci.torsoSkin; torso.lightingOrigin = { ...entity.lerpOrigin };
    positionRotatedEntityOnTag(torso, legs, ci.legsModel, "tag_torso"); torso.shadowPlane = shadow.plane; torso.renderFlags = renderFlags;
    this.addRefEntityWithPowerups(torso, entity.currentState, ci.team);
    if (this.host.product === "missionpack") this.missionPowerups(entity, ci, torso, this.host.missionMedia);
    if (ci.headModel.kind === "default") return;
    head.model = ci.headModel; head.customSkin = ci.headSkin; head.lightingOrigin = { ...entity.lerpOrigin };
    positionRotatedEntityOnTag(head, torso, ci.torsoModel, "tag_head"); head.shadowPlane = shadow.plane; head.renderFlags = renderFlags;
    this.addRefEntityWithPowerups(head, entity.currentState, ci.team);
    if (this.host.product === "missionpack") { this.breath(entity, head, options, this.host.missionMedia); this.dust(entity, options, this.host.missionMedia); }
    this.host.addPlayerWeapon(torso, null, entity, ci.team);
    this.powerups(entity, torso, ci, options);
  }
}
function modelSkin(value: string): readonly [string, string] {
  const path = qpath(value), slash = path.indexOf("/");
  return slash < 0 ? [path, "default"] : [path.slice(0, slash), path.slice(slash + 1)];
}
function copyModel(from: ClientInfo, to: ClientInfo): void {
  to.headOffset = { ...from.headOffset }; to.footsteps = from.footsteps; to.gender = from.gender;
  to.legsModel = from.legsModel; to.legsSkin = from.legsSkin;
  to.torsoModel = from.torsoModel; to.torsoSkin = from.torsoSkin;
  to.headModel = from.headModel; to.headSkin = from.headSkin;
  to.modelIcon = from.modelIcon; to.newAnims = from.newAnims;
  to.setAnimations(from.animations);
  to.sounds = [...from.sounds];
  // CG_CopyClientInfoModel deliberately does not copy fixedlegs/fixedtorso.
}
interface ClientFile { readonly kind: "found" | "missing"; readonly path: string }
class SupersededClientLoad extends Error {}

export class ClientInfoStore {
  private readonly requests = Array.from({ length: 64 }, () => 0);
  private readonly animationParser = new CommonParseState();
  private lifecycle = 0;
  constructor(readonly host: ClientInfoHost, private readonly slots: readonly ClientInfo[]) {
    if (slots.length !== 64 || new Set(slots).size !== 64) throw new RangeError("ClientInfoStore requires 64 distinct canonical client slots");
  }
  clientInfo(index: number): ClientInfo { return at(this.slots, index); }
  /** Invalidate pending I/O without making the next lifecycle wait for it. */
  reset(): void {
    this.lifecycle++;
    for (const slot of this.slots) slot.copyFrom(new ClientInfo());
  }
  customSound(index: number, name: string): PcmSound | null {
    if (!name.startsWith("*")) return this.host.sound(name, false);
    const slot = this.clientInfo(index < 0 || index >= 64 ? 0 : index);
    const soundIndex = CUSTOM_SOUND_NAMES.indexOf(name);
    if (soundIndex < 0) throw new CommonError("drop", `Unknown custom sound: ${name}`);
    return at(slot.sounds, soundIndex);
  }
  private team(ci: ClientInfo, settings: ClientInfoSettings): string {
    return settings.gameType >= GameType.GT_TEAM ? ci.team === Team.TEAM_BLUE ? "blue" : "red" : "default";
  }
  private filename(length: number, format: string, args: readonly GameFormatArgument[], check: () => void): string {
    const filename = gameFormat(format, args);
    if (filename.length >= length) {
      this.host.print(gameFormat("Com_sprintf: overflow of %i in %i\n", [filename.length, length]));
      check();
    }
    return filename.slice(0, length - 1);
  }
  private async exists(path: string, check: () => void): Promise<boolean> {
    if (!this.host.assets.has(path)) return false;
    const bytes = await this.host.assets.read(path);
    check();
    return bytes.length > 0;
  }
  private async findModel(ci: ClientInfo, settings: ClientInfoSettings, teamName: string, model: string, skin: string, base: string, ext: string, check: () => void): Promise<ClientFile> {
    const team = this.team(ci, settings);
    let filename = "";
    for (const folder of ["", "characters/"]) for (const prefix of teamName ? [teamName, ""] : [""]) {
      filename = this.filename(64, "models/players/%s%s/%s%s_%s_%s.%s", [folder, model, prefix, base, skin, team, ext], check);
      let found = await this.exists(filename, check);
      check();
      if (found) return { kind: "found", path: filename };
      filename = this.filename(64, "models/players/%s%s/%s%s_%s.%s", [folder, model, prefix, base, settings.gameType >= GameType.GT_TEAM ? team : skin, ext], check);
      found = await this.exists(filename, check);
      check();
      if (found) return { kind: "found", path: filename };
    }
    return { kind: "missing", path: filename };
  }
  private async findHead(ci: ClientInfo, settings: ClientInfoSettings, teamName: string, model: string, skin: string, base: string, ext: string, length: number, check: () => void): Promise<ClientFile> {
    const team = this.team(ci, settings), name = model.startsWith("*") ? model.slice(1) : model;
    let filename = "";
    for (const folder of model.startsWith("*") ? ["heads/"] : ["", "heads/"]) for (const prefix of teamName ? [teamName, ""] : [""]) {
      filename = this.filename(length, "models/players/%s%s/%s/%s%s_%s.%s", [folder, name, skin, prefix, base, team, ext], check);
      let found = await this.exists(filename, check);
      check();
      if (found) return { kind: "found", path: filename };
      filename = this.filename(length, "models/players/%s%s/%s%s_%s.%s", [folder, name, prefix, base, settings.gameType >= GameType.GT_TEAM ? team : skin, ext], check);
      found = await this.exists(filename, check);
      check();
      if (found) return { kind: "found", path: filename };
    }
    return { kind: "missing", path: filename };
  }
  private async skin(ci: ClientInfo, settings: ClientInfoSettings, team: string, model: string, skin: string, head: string, headSkin: string, check: () => void): Promise<boolean> {
    const lower = await this.findModel(ci, settings, team, model, skin, "lower", "skin", check);
    check();
    if (lower.kind === "found") {
      const handle = await this.host.resources.registerSkin(lower.path);
      check(); ci.legsSkin = handle;
    }
    if (ci.legsSkin === null) this.host.print(`Leg skin load failure: ${lower.path}\n`);
    const upper = await this.findModel(ci, settings, team, model, skin, "upper", "skin", check);
    check();
    if (upper.kind === "found") {
      const handle = await this.host.resources.registerSkin(upper.path);
      check(); ci.torsoSkin = handle;
    }
    if (ci.torsoSkin === null) this.host.print(`Torso skin load failure: ${upper.path}\n`);
    const face = await this.findHead(ci, settings, team, head, headSkin, "head", "skin", 64, check);
    check();
    if (face.kind === "found") {
      const handle = await this.host.resources.registerSkin(face.path);
      check(); ci.headSkin = handle;
    }
    if (ci.headSkin === null) this.host.print(`Head skin load failure: ${face.path}\n`);
    return ci.legsSkin !== null && ci.torsoSkin !== null && ci.headSkin !== null;
  }
  private async animation(ci: ClientInfo, path: string, check: () => void): Promise<boolean> {
    if (!this.host.assets.has(path)) return false;
    const bytes = await this.host.assets.read(path);
    check();
    if (bytes.length === 0) return false;
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    try {
      parsePlayerAnimationConfig(text, path, { target: ci, parser: this.animationParser,
        print: message => { this.host.print(message); check(); } });
      return true;
    } catch (error) {
      if (!(error instanceof PlayerAnimationParseError)) throw error;
      return false;
    }
  }
  private async model(ci: ClientInfo, settings: ClientInfoSettings, model: string, skin: string, headModel: string, headSkin: string, team: string, check: () => void): Promise<boolean> {
    const head = headModel || model;
    let path = this.filename(128, "models/players/%s/lower.md3", [model], check);
    let handle = await this.host.resources.registerModel(path);
    check(); ci.legsModel = handle;
    if (ci.legsModel.kind === "default") {
      path = this.filename(128, "models/players/characters/%s/lower.md3", [model], check);
      handle = await this.host.resources.registerModel(path);
      check(); ci.legsModel = handle;
    }
    if (ci.legsModel.kind === "default") { this.host.print(gameFormat("Failed to load model file %s\n", [path])); return false; }
    path = this.filename(128, "models/players/%s/upper.md3", [model], check);
    handle = await this.host.resources.registerModel(path);
    check(); ci.torsoModel = handle;
    if (ci.torsoModel.kind === "default") {
      path = this.filename(128, "models/players/characters/%s/upper.md3", [model], check);
      handle = await this.host.resources.registerModel(path);
      check(); ci.torsoModel = handle;
    }
    if (ci.torsoModel.kind === "default") { this.host.print(gameFormat("Failed to load model file %s\n", [path])); return false; }
    path = head.startsWith("*") ? this.filename(128, "models/players/heads/%s/%s.md3", [headModel.slice(1), headModel.slice(1)], check)
      : this.filename(128, "models/players/%s/head.md3", [head], check);
    handle = await this.host.resources.registerModel(path);
    check(); ci.headModel = handle;
    if (ci.headModel.kind === "default" && !head.startsWith("*")) {
      path = this.filename(128, "models/players/heads/%s/%s.md3", [headModel, headModel], check);
      handle = await this.host.resources.registerModel(path);
      check(); ci.headModel = handle;
    }
    if (ci.headModel.kind === "default") { this.host.print(gameFormat("Failed to load model file %s\n", [path])); return false; }
    let loadedSkin = await this.skin(ci, settings, team, model, skin, head, headSkin, check);
    check();
    if (!loadedSkin) {
      if (!team) { this.host.print(`Failed to load skin file: ${model} : ${skin}, ${head} : ${headSkin}\n`); return false; }
      this.host.print(`Failed to load skin file: ${team} : ${model} : ${skin}, ${head} : ${headSkin}\n`);
      const fallbackTeam = this.filename(128, "%s/", [ci.team === Team.TEAM_BLUE ? "Pagans" : "Stroggs"], check);
      loadedSkin = await this.skin(ci, settings, fallbackTeam, model, skin, head, headSkin, check);
      check();
      if (!loadedSkin) {
        this.host.print(`Failed to load skin file: ${fallbackTeam} : ${model} : ${skin}, ${head} : ${headSkin}\n`); return false;
      }
    }
    path = this.filename(128, "models/players/%s/animation.cfg", [model], check);
    let animated = await this.animation(ci, path, check);
    check();
    if (!animated) {
      path = this.filename(128, "models/players/characters/%s/animation.cfg", [model], check);
      animated = await this.animation(ci, path, check);
      check();
      if (!animated) { this.host.print(gameFormat("Failed to load animation file %s\n", [path])); return false; }
    }
    let icon = await this.findHead(ci, settings, team, head, headSkin, "icon", "skin", 128, check);
    check();
    if (icon.kind === "missing") {
      icon = await this.findHead(ci, settings, team, head, headSkin, "icon", "tga", 128, check);
      check();
    }
    if (icon.kind === "found") {
      const shader = await this.host.registerShaderNoMip(icon.path);
      check(); ci.modelIcon = shader;
    }
    return ci.modelIcon !== null;
  }
  private async load(ci: ClientInfo, settings: ClientInfoSettings, check: () => void): Promise<void> {
    const teamModel = this.host.state.product === "missionpack" ? "james" : "sarge";
    const teamHead = this.host.state.product === "missionpack" ? "*james" : "sarge";
    let team = this.host.state.product === "missionpack" && settings.gameType >= GameType.GT_TEAM ? qpath(ci.team === Team.TEAM_BLUE ? settings.blueTeamName : settings.redTeamName) : "";
    if (team) team += "/";
    const loaded = await this.model(ci, settings, ci.modelName, ci.skinName, ci.headModelName, ci.headSkinName, team, check);
    check();
    if (!loaded) {
      if (settings.buildScript) throw new CommonError("drop", `CG_RegisterClientModelname( ${ci.modelName}, ${ci.skinName}, ${ci.headModelName}, ${ci.headSkinName} ${team} ) failed`);
      if (settings.gameType >= GameType.GT_TEAM) {
        team = ci.team === Team.TEAM_BLUE ? "Pagans" : "Stroggs";
        const fallbackLoaded = await this.model(ci, settings, teamModel, ci.skinName, teamHead, ci.skinName, team, check);
        check();
        if (!fallbackLoaded) throw new CommonError("drop", `DEFAULT_TEAM_MODEL / skin (${teamModel}/${ci.skinName}) failed to register`);
      } else {
        const fallbackLoaded = await this.model(ci, settings, "sarge", "default", "sarge", "default", team, check);
        check();
        if (!fallbackLoaded) throw new CommonError("drop", "DEFAULT_MODEL (sarge) failed to register");
      }
    }
    ci.newAnims = lerpModelTag(ci.torsoModel, "tag_flag", 0, 0, 1) !== null;
    const fallback = settings.gameType >= GameType.GT_TEAM ? teamModel : "sarge";
    const sounds: (PcmSound | null)[] = Array.from({ length: 32 }, () => null);
    for (let i = 0; i < CUSTOM_SOUND_NAMES.length; i++) {
      const name = at(CUSTOM_SOUND_NAMES, i).slice(1);
      sounds[i] = loaded ? await this.host.registerSound(`sound/player/${ci.modelName}/${name}`, false) : null;
      check();
      if (sounds[i] === null) {
        sounds[i] = await this.host.registerSound(`sound/player/${fallback}/${name}`, false);
        check();
      }
    }
    ci.sounds = sounds; ci.deferred = false;
  }
  private reuse(ci: ClientInfo, settings: ClientInfoSettings): boolean {
    for (let i = 0; i < settings.maxClients; i++) {
      const match = this.clientInfo(i);
      if (match.infoValid && !match.deferred && same(ci.modelName, match.modelName) && same(ci.skinName, match.skinName)
        && same(ci.headModelName, match.headModelName) && same(ci.headSkinName, match.headSkinName)
        && same(ci.blueTeam, match.blueTeam) && same(ci.redTeam, match.redTeam)
        && (settings.gameType < GameType.GT_TEAM || ci.team === match.team)) {
        ci.deferred = false; copyModel(match, ci); return true;
      }
    }
    return false;
  }
  private async defer(ci: ClientInfo, settings: ClientInfoSettings, check: () => void): Promise<void> {
    const candidates = this.slots.slice(0, settings.maxClients);
    if (candidates.some(match => match.infoValid && !match.deferred && same(ci.skinName, match.skinName)
      && same(ci.modelName, match.modelName) && (settings.gameType < GameType.GT_TEAM || ci.team === match.team))) {
      await this.load(ci, settings, check); return;
    }
    const match = candidates.find(candidate => candidate.infoValid && (settings.gameType < GameType.GT_TEAM
      || !candidate.deferred && same(ci.skinName, candidate.skinName) && ci.team === candidate.team));
    if (match !== undefined) { ci.deferred = true; copyModel(match, ci); return; }
    if (settings.gameType < GameType.GT_TEAM) this.host.print("CG_SetDeferredClientInfo: no valid clients!\n");
    await this.load(ci, settings, check);
  }
  async newClientInfo(index: number, configstring: string): Promise<void> {
    const slot = this.clientInfo(index), request = at(this.requests, index) + 1, lifecycle = this.lifecycle;
    this.requests[index] = request;
    const check = (): void => {
      if (lifecycle !== this.lifecycle || at(this.requests, index) !== request) throw new SupersededClientLoad();
    };
    const next = new ClientInfo();
    if (!configstring || configstring.charCodeAt(0) === 0) { slot.copyFrom(next); return; }
    const settings = this.host.settings();
    const value = (key: string): string => infoValueForKey(configstring, key);
    next.name = qpath(value("n")); next.color1 = color(value("c1")); next.color2 = color(value("c2"));
    next.botSkill = integer(value("skill")); next.handicap = integer(value("hc")); next.wins = integer(value("w")); next.losses = integer(value("l"));
    const team = integer(value("t"));
    if (team !== Team.TEAM_FREE && team !== Team.TEAM_RED && team !== Team.TEAM_BLUE && team !== Team.TEAM_SPECTATOR) throw new RangeError(`Invalid player team ${team}`);
    next.team = team; next.teamTask = integer(value("tt")); next.teamLeader = integer(value("tl")) !== 0;
    next.redTeam = value("g_redteam").slice(0, 31); next.blueTeam = value("g_blueteam").slice(0, 31);
    const forced = this.host.state.product === "missionpack" ? "james" : "sarge";
    [next.modelName, next.skinName] = modelSkin(settings.forceModel ? settings.gameType >= GameType.GT_TEAM ? forced : settings.model : value("model"));
    [next.headModelName, next.headSkinName] = modelSkin(settings.forceModel ? settings.gameType >= GameType.GT_TEAM ? forced : settings.headModel : value("hmodel"));
    if (settings.forceModel && settings.gameType >= GameType.GT_TEAM) {
      const model = value("model"), head = value("hmodel");
      if (model.includes("/")) next.skinName = qpath(model.slice(model.indexOf("/") + 1));
      if (head.includes("/")) next.headSkinName = qpath(head.slice(head.indexOf("/") + 1));
    }
    try {
      if (!this.reuse(next, settings)) {
        const forceDefer = this.host.memoryRemaining() < 4000000;
        if (forceDefer || settings.deferPlayers && !settings.buildScript && !settings.loading) {
          await this.defer(next, settings, check);
          check();
          if (forceDefer) { this.host.print("Memory is low.  Using deferred model.\n"); next.deferred = false; }
        } else await this.load(next, settings, check);
      }
    } catch (error) {
      if (!(error instanceof SupersededClientLoad)) throw error;
      return;
    }
    if (lifecycle === this.lifecycle && at(this.requests, index) === request) { next.infoValid = true; slot.copyFrom(next); }
  }
  async loadDeferredPlayers(resetPlayerEntity: (entity: ClientEntity) => void): Promise<void> {
    const lifecycle = this.lifecycle, settings = this.host.settings();
    for (let i = 0; i < settings.maxClients && lifecycle === this.lifecycle; i++) {
      const slot = this.clientInfo(i);
      if (!slot.infoValid || !slot.deferred) continue;
      if (this.host.memoryRemaining() < 4000000) { this.host.print("Memory is low.  Using deferred model.\n"); slot.deferred = false; continue; }
      const request = at(this.requests, i) + 1; this.requests[i] = request;
      const check = (): void => {
        if (lifecycle !== this.lifecycle || at(this.requests, i) !== request) throw new SupersededClientLoad();
      };
      try {
        await this.load(slot, settings, check);
      } catch (error) {
        if (!(error instanceof SupersededClientLoad)) throw error;
        continue;
      }
      if (lifecycle !== this.lifecycle || at(this.requests, i) !== request) continue;
      for (let number = 0; number < 1024; number++) {
        const entity = this.host.state.entityAt(number);
        if (entity.currentState.clientNum === i && entity.currentState.eType === EntityType.ET_PLAYER) resetPlayerEntity(entity);
      }
    }
  }
}
