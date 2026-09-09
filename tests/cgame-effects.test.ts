import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { ClientEffects } from "../src/cgame/effects.ts";
import type { EffectImports, EffectMedia, EffectOptions, SmokePuffOptions } from "../src/cgame/effects.ts";
import { LocalEntityPool, LocalEntitySystem } from "../src/cgame/local-entities.ts";
import type { LocalEntityHost, LocalEntityMedia } from "../src/cgame/local-entities.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import type { RefEntity, SceneModel } from "../src/render/ref-entity.ts";
import { SourceSceneEntities } from "../src/render/scene-entities.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const zero = vec3(0, 0, 0), white = vec4(1, 1, 1, 1), viewOrigin = vec3(200, 0, 0);
const sound: PcmSound = { sampleRate: 22050, channels: 1, samples: new Int16Array([12000, -12000, 12000, -12000]), frameCount: 4, loopStart: null };
function model(path: string): SceneModel { return { kind: "md3", path, md3: [{ name: path, flags: 0, skinCount: 0, frames: [], tags: [], surfaces: [] }, null, null], numLods: 1, md4: null }; }
function effectMedia(product: Product): EffectMedia {
  return { waterBubbleShader: { name: "waterBubble" }, smokePuffRageProShader: { name: "smokePuffRagePro" }, bloodExplosionShader: { name: "bloodExplosion" }, teleportEffectModel: model("teleport"),
    gibSkull: model("skull"), gibBrain: model("brain"), gibAbdomen: model("abdomen"), gibArm: model("arm"), gibChest: model("chest"), gibFist: model("fist"), gibFoot: model("foot"), gibForearm: model("forearm"), gibIntestine: model("intestine"), gibLeg: model("leg"), smoke2: model("shell"),
    variant: product === "baseq3" ? { product, teleportEffectShader: { name: "teleportEffect" } } : { product, media: {
      lightningShader: { name: "lightningBoltNew" }, kamikazeEffectModel: model("kamikaze"), dishFlashModel: model("dishFlash"), rocketExplosionShader: { name: "rocketExplosion" }, obeliskHitSounds: [sound, { ...sound }, { ...sound }],
      invulnerabilityImpactModel: model("impact"), invulnerabilityImpactSounds: [sound, { ...sound }, { ...sound }], invulnerabilityJuicedModel: model("juiced"), invulnerabilityJuicedSound: sound,
    } },
  };
}
function emptyMap(): BspMap {
  const bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
  return { entities: "", entityRecords: [], shaders: [], planes: [{ normal: vec3(1, 0, 0), distance: 0 }], nodes: [{ plane: 0, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function unavailable(): never { throw new Error("This constructor fixture does not invoke prediction settings or mark projection"); }
class TestRandom {
  calls = 0;
  value = 0;
  sequence: readonly number[] = [];
  rand(): number {
    const index = this.calls++;
    if (this.sequence.length === 0) return this.value;
    const value = this.sequence[index]; if (value === undefined) throw new Error("RNG fixture exhausted"); return value;
  }
  random(): number { return Math.fround(this.rand() / 32767); }
}
function fixture(product: Product = "baseq3", registeredMedia = effectMedia(product)) {
  const state = new ClientGameState(product, 0, 0); state.time = 1000;
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState: createPlayerState(product), entities: [] };
  const options: { -readonly [Key in keyof EffectOptions]: EffectOptions[Key] } = { noProjectileTrail: false, blood: true, gibs: true, scorePlum: true, hardware: "generic" };
  const random = new TestRandom(), audio = new AudioMixer(22050, () => 0), collision = new CollisionWorld(emptyMap(), { kind: "unaccounted" }, { kind: "disabled" });
  const prediction = new PredictionRuntime(state, collision, { commands: new ClientCommandHistory(), settings: unavailable, setPmoveMsec: unavailable, transitionPlayerState: unavailable, warn: unavailable });
  const localMedia: LocalEntityMedia = { bloodTrailShader: { name: "bloodTrail" }, bloodMarkShader: { name: "bloodMark" }, burnMarkShader: { name: "burnMark" }, gibBounceSounds: [sound, sound, sound],
    numberShaders: [{ name: "0" }, { name: "1" }, { name: "2" }, { name: "3" }, { name: "4" }, { name: "5" }, { name: "6" }, { name: "7" }, { name: "8" }, { name: "9" }, { name: "minus" }] };
  const localAudio: LocalEntityHost["audio"] = { startSound(pcm, options) {
    if (pcm === null) throw new Error("Fixture media unexpectedly returned source sound handle zero");
    audio.startSound(pcm, options);
  } };
  const services = { prediction, collision, audio: localAudio, clientNum: 0, random, marks: { impactMark: unavailable } };
  const host: LocalEntityHost = product === "baseq3" ? { ...services, product, media: localMedia } : { ...services, product, media: { ...localMedia, kamikazeShockWave: model("shockwave"), kamikazeExplodeSound: sound, kamikazeImplodeSound: sound } };
  const pool = new LocalEntityPool(product);
  const sounds: { readonly origin: Vec3; readonly entity: number; readonly channel: number; readonly sound: PcmSound | null }[] = [];
  const imports: EffectImports = { randomInteger: () => random.rand(), startSound(origin, entity, channel, pcm) {
    sounds.push({ origin, entity, channel, sound: pcm });
    if (pcm !== null) audio.startSound(pcm, { entity, channel, origin: { kind: "fixed", position: origin }, volume: 127 });
  } };
  const effects = new ClientEffects(state, pool, registeredMedia, options, imports);
  const locals = new LocalEntitySystem(effects, host);
  return { state, options, random, audio, collision, pool, locals, effects, media: registeredMedia, sounds };
}
function smoke(overrides: Partial<SmokePuffOptions> = {}): SmokePuffOptions { return { origin: zero, velocity: vec3(10, 0, 0), radius: 20, color: vec4(0.5, 0.25, 1, 0.5), duration: 1000, startTime: 1000, fadeInTime: 0, flags: 0, shader: { name: "smokePuff" }, ...overrides }; }
function entityAt(entities: readonly RefEntity[], index: number): RefEntity { const ref = entities[index]; if (ref === undefined) throw new Error(`Missing effect ${index}`); return ref; }

describe("cg_effects constructors in the real local entity pool", () => {
  test("construction shares one pool and rejects cross-product composition", () => {
    const base = fixture(), mission = fixture("missionpack");
    expect(base.effects.pool).toBe(base.pool); expect(base.locals.pool).toBe(base.pool); expect(base.locals.effects).toBe(base.effects);
    expect(() => new LocalEntitySystem(base.effects, mission.locals.host)).toThrow("product");
    expect(() => new ClientEffects(base.state, mission.pool, base.media, base.options, { randomInteger: unavailable, startSound: unavailable })).toThrow("product");
    expect(() => new ClientEffects(base.state, base.pool, mission.media, base.options, { randomInteger: unavailable, startSound: unavailable })).toThrow("product");
    const puff = base.effects.smokePuff(smoke());
    expect(mission.pool.isActive(puff)).toBe(false); expect(base.pool.activeCount).toBe(1); expect(mission.pool.activeCount).toBe(0);
  });
  test("pool reset expires records without resetting source effect statics", () => {
    const f = fixture(), first = f.effects.smokePuff(smoke());
    f.effects.scorePlum(0, vec3(0, 0, 100), 1);
    f.pool.initialize();
    expect(f.pool.isActive(first)).toBe(false); expect(f.pool.activeCount).toBe(0);
    expect(f.effects.smokePuff(smoke()).refEntity.rotation).toBe(159.169921875);
    f.effects.scorePlum(0, vec3(0, 0, 110), 1);
    expect(f.pool.activeEntities()[0]?.pos.base.z).toBe(90);
    const fresh = fixture();
    expect(fresh.effects.smokePuff(smoke()).refEntity.rotation).toBe(313.4783935546875);
    fresh.effects.scorePlum(0, vec3(0, 0, 110), 1);
    expect(fresh.pool.activeEntities()[0]?.pos.base.z).toBe(110);
  });
  test("smoke uses independent seed, source byte channels and real trajectory/fade playback", () => {
    const { effects, pool, locals, random } = fixture();
    const first = effects.smokePuff(smoke()), second = effects.smokePuff(smoke());
    expect(first.refEntity.rotation).toBe(313.4783935546875); expect(second.refEntity.rotation).toBe(159.169921875); expect(random.calls).toBe(0);
    expect(first.refEntity.shaderRGBA).toEqual(vec4(127, 63, 255, 255)); expect(first.lifeRate).toBe(Math.fround(0.001)); expect(pool.isActive(first)).toBe(true);
    const scene = locals.collectEntities({ time: 1500, frameTime: 16, viewOrigin }), ref = entityAt(scene.entities, 0);
    if (ref.kind !== "sprite") throw new Error("Expected smoke sprite");
    expect(ref.origin).toEqual(vec3(5, 0, 0)); expect(ref.radius).toBe(18); expect(ref.shaderRGBA.w).toBe(63);
    locals.collectEntities({ time: 2000, frameTime: 16, viewOrigin }); expect(pool.activeCount).toBe(0);
    expect(fixture().effects.smokePuff(smoke()).refEntity.rotation).toBe(first.refEntity.rotation);
  });
  test("fade-in and optimized type transitions use the same owned record", () => {
    const { effects, pool, locals } = fixture(), le = effects.smokePuff(smoke({ fadeInTime: 1250 }));
    expect(le.lifeRate).toBe(Math.fround(1 / 750));
    const scene = locals.collectEntities({ time: 1125, frameTime: 16, viewOrigin });
    const ref = entityAt(scene.entities, 0); if (ref.kind !== "sprite") throw new Error("Expected smoke"); expect(ref.shaderRGBA.w).toBe(63);
    le.leType = "scale-fade"; expect(pool.isActive(le)).toBe(true);
    expect(locals.collectEntities({ time: 1250, frameTime: 16, viewOrigin }).entities.length).toBe(1);
  });
  test("ragepro replaces shader and RGB while keeping local fade color", () => {
    const base = fixture(), effects = new ClientEffects(base.state, base.pool, base.media, { ...base.options, hardware: "ragepro" }, { randomInteger: () => 0, startSound: unavailable });
    const le = effects.smokePuff(smoke()); expect(le.refEntity.customShader).toBe(base.media.smokePuffRageProShader);
    expect(le.refEntity.shaderRGBA).toEqual(vec4(255, 255, 255, 255)); expect(le.color).toEqual(vec4(0.5, 0.25, 1, 0.5));
  });
  test("fractional bubble spacing advances an integer counter separately from positions", () => {
    const { effects, pool, locals, random } = fixture(); effects.bubbleTrail(zero, vec3(3, 0, 0), 1.5);
    expect(pool.activeCount).toBe(3); expect(random.calls).toBe(13);
    const initial = locals.collectEntities({ time: 1000, frameTime: 0, viewOrigin }).entities;
    expect(initial.map(ref => ref.origin.x)).toEqual([0, 1.5, 3]);
    const later = locals.collectEntities({ time: 1100, frameTime: 100, viewOrigin }).entities;
    expect(entityAt(later, 0).origin).toEqual(vec3(-0.5, -0.5, Math.fround(0.1)));
    const ref = entityAt(later, 0); if (ref.kind !== "sprite") throw new Error("Expected bubble"); expect(ref.radius).toBe(3);
  });
  test("trail disable consumes no RNG and invalid spacing fails before allocation", () => {
    const f = fixture(); f.options.noProjectileTrail = true; f.effects.bubbleTrail(zero, vec3(3, 0, 0), 1); expect(f.random.calls).toBe(0); expect(f.pool.activeCount).toBe(0);
    f.options.noProjectileTrail = false; expect(() => f.effects.bubbleTrail(zero, viewOrigin, 0.5)).toThrow("spacing"); expect(f.pool.activeCount).toBe(0);
  });
  test("sprite explosions skew time and offset origin then grow and emit real light", () => {
    const { effects, locals, random } = fixture(); random.value = 63;
    const le = effects.makeExplosion({ origin: zero, direction: vec3(0, 0, 1), model: DEFAULT_MODEL, shader: { name: "rocketExplosion" }, duration: 600, sprite: true });
    le.light = 300; le.lightColor = vec3(1, 0.75, 0);
    expect(le.startTime).toBe(937); expect(le.endTime).toBe(1537); expect(le.refEntity.origin).toEqual(vec3(0, 0, 16)); expect(random.calls).toBe(2);
    const scene = locals.collectEntities({ time: 1237, frameTime: 16, viewOrigin }), ref = entityAt(scene.entities, 0);
    if (ref.kind !== "sprite") throw new Error("Expected explosion sprite"); expect(ref.radius).toBe(51); expect(ref.rotation).toBe(63); expect(ref.shaderRGBA.w).toBe(42);
    expect(scene.dynamicLights[0]?.radius).toBe(300);
    expect(() => effects.makeExplosion({ origin: zero, direction: zero, model: DEFAULT_MODEL, shader: null, duration: 0, sprite: false })).toThrow("msec");
  });
  test("sprite explosions and score plums retain source fields in renderer allocation", () => {
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = fixture(product), explosionModel = model("explosion");
      const renderer = new SourceSceneEntities(undefined, { model: value => value === DEFAULT_MODEL ? 0 : 7, skin: () => 0, shader: () => 0 });
      f.effects.makeExplosion({ origin: vec3(1, 2, 3), direction: vec3(0, 0, 1), model: explosionModel, shader: null, duration: 600, sprite: true });
      f.effects.scorePlum(0, vec3(0, 0, 30), 1);
      f.locals.addEntities({ time: 1000, frameTime: 0, viewOrigin }, { addRefEntity: entity => { renderer.addRefEntity(entity); }, addLight: unavailable });
      const scene = renderer.sceneRange(), explosion = scene.entity(0).entity, plum = scene.entity(1).entity;
      expect(scene.length).toBe(2);
      expect(explosion.kind).toBe("sprite"); expect(explosion.model).toBe(explosionModel);
      expect(explosion.origin).toEqual(vec3(1, 2, 19)); expect(explosion.oldOrigin).toEqual(vec3(1, 2, 19));
      expect(plum.kind).toBe("sprite");
      expect(plum.axis.map(axis => [float32ToBits(axis.x), float32ToBits(axis.y), float32ToBits(axis.z)])).toEqual([
        [0x3f800000, 0, 0x80000000], [0, 0x3f800000, 0], [0, 0, 0x3f800000],
      ]);
    }
  });
  test("explosion allocation precedes its orientation random draw", () => {
    for (const sprite of [false, true]) {
      const f = fixture(); let calls = 0;
      const effects = new ClientEffects(f.state, f.pool, f.media, f.options, { startSound: unavailable, randomInteger: () => {
        if (++calls === 2) throw new Error("orientation random failed");
        return 0;
      } });
      expect(() => effects.makeExplosion({ origin: zero, direction: vec3(0, 0, 1), model: DEFAULT_MODEL, shader: null, duration: 600, sprite })).toThrow("orientation random failed");
      expect(f.pool.activeCount).toBe(1);
      expect(f.pool.activeEntities()[0]?.leType).toBe(sprite ? "sprite-explosion" : "explosion");
      expect(f.pool.activeEntities()[0]?.startTime).toBe(0);
    }
  });
  test("model explosions clear axis without direction and preserve directed rotation", () => {
    const { effects, random } = fixture(); random.value = 90;
    const plain = effects.makeExplosion({ origin: vec3(1, 2, 3), direction: null, model: DEFAULT_MODEL, shader: null, duration: 500, sprite: false });
    if (plain.refEntity.kind !== "model") throw new Error("Expected model"); expect(plain.refEntity.axis).toEqual([vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)]); expect(random.calls).toBe(1);
    const directed = effects.makeExplosion({ origin: zero, direction: vec3(0, 0, 1), model: DEFAULT_MODEL, shader: null, duration: 500, sprite: false });
    if (directed.refEntity.kind !== "model") throw new Error("Expected model"); expect(directed.refEntity.axis[0]).toEqual(vec3(0, 0, 1)); expect(directed.refEntity.axis[1].y).toBeCloseTo(1); expect(random.calls).toBe(3);
  });
  test("directed explosion rotations retain QVM DEG2RAD stores for every random angle", () => {
    const { effects, random } = fixture(), f = Math.fround;
    for (let angle = 1; angle < 360; angle++) {
      random.value = angle;
      const explosion = effects.makeExplosion({ origin: zero, direction: vec3(0, 0, 1), model: DEFAULT_MODEL, shader: null, duration: 500, sprite: false });
      if (explosion.refEntity.kind !== "model") throw new Error("Expected model explosion");
      // q_math.c DEG2RAD emits MULF4 by float32 PI, then DIVF4 by 180.
      const radians = f(f(angle * f(Math.PI)) / 180), side = explosion.refEntity.axis[1];
      expect([float32ToBits(side.x), float32ToBits(side.y)]).toEqual([float32ToBits(f(Math.cos(radians))), float32ToBits(f(Math.sin(radians)))]);
    }
  });
  test("blood respects cvar and snapshot client third-person suppression", () => {
    const f = fixture(); f.effects.bleed(zero, 0);
    const ref = entityAt(f.locals.collectEntities({ time: 1000, frameTime: 0, viewOrigin }).entities, 0); if (ref.kind !== "sprite") throw new Error("Expected blood");
    expect(ref.renderFlags).toBe(2); expect(ref.radius).toBe(24); expect(ref.customShader).toBe(f.media.bloodExplosionShader);
    f.options.blood = false; f.effects.bleed(zero, 1); expect(f.pool.activeCount).toBe(1);
  });
  test("gibs-disabled still launches one head, while blood-disabled launches nothing", () => {
    const f = fixture(); f.options.gibs = false; f.effects.gibPlayer(zero); expect(f.pool.activeCount).toBe(1); expect(f.random.calls).toBe(5);
    const ref = entityAt(f.locals.collectEntities({ time: 1000, frameTime: 0, viewOrigin }).entities, 0); if (ref.kind !== "model") throw new Error("Expected gib"); expect(ref.model.path).toBe("brain");
    f.options.blood = false; f.effects.gibPlayer(zero); expect(f.pool.activeCount).toBe(1); expect(f.random.calls).toBe(5);
  });
  test("full gib order and fragment physics are source backed", () => {
    const f = fixture(); f.effects.gibPlayer(zero); expect(f.pool.activeCount).toBe(10); expect(f.random.calls).toBe(41);
    const scene = f.locals.collectEntities({ time: 1000, frameTime: 0, viewOrigin });
    expect(scene.entities.map(ref => ref.kind === "model" ? ref.model.path : ref.kind)).toEqual(["brain", "abdomen", "arm", "chest", "fist", "foot", "forearm", "intestine", "leg", "leg"]);
    const le = f.effects.launchGib(zero, vec3(10, 20, 30), DEFAULT_MODEL); expect(le.pos.type).toBe(TrajectoryType.TR_GRAVITY); expect(le.bounceFactor).toBe(Math.fround(0.6)); expect(le.leMarkType).toBe("blood"); expect(le.endTime).toBe(6000);
  });
  test("gib RNG consumption order controls velocity, head choice and inclusive lifetime endpoint", () => {
    const f = fixture(); f.options.gibs = false; f.random.sequence = [0, 32767, 16384, 1, 32767];
    f.effects.gibPlayer(zero); expect(f.random.calls).toBe(5);
    const ref = entityAt(f.locals.collectEntities({ time: 1100, frameTime: 0, viewOrigin }).entities, 0);
    if (ref.kind !== "model") throw new Error("Expected gib"); expect(ref.model.path).toBe("skull");
    expect(ref.origin.x).toBe(-25); expect(ref.origin.y).toBe(25); expect(ref.origin.z).toBeCloseTo(21.000764, 5);
    f.random.sequence = []; f.random.value = 32767;
    expect(f.effects.launchGib(zero, zero, DEFAULT_MODEL).endTime).toBe(9000);
    expect(f.effects.launchExplode(zero, zero, DEFAULT_MODEL).endTime).toBe(17000);
  });
  test("big explode creates five brass fragments independently of the gibs option", () => {
    const f = fixture(); f.options.gibs = false; f.effects.bigExplode(zero); expect(f.pool.activeCount).toBe(5); expect(f.random.calls).toBe(20);
    const le = f.effects.launchExplode(zero, zero, DEFAULT_MODEL); expect(le.bounceFactor).toBe(Math.fround(0.1)); expect(le.leBounceSoundType).toBe("brass"); expect(le.leMarkType).toBe("none"); expect(le.endTime).toBe(11000);
  });
  test("score plums gate predicted client and preserve initial and repeated Z avoidance", () => {
    const f = fixture(); f.effects.scorePlum(1, zero, 1); expect(f.pool.activeCount).toBe(0);
    f.effects.scorePlum(0, zero, 1); f.effects.scorePlum(0, vec3(0, 0, 30), 1); f.effects.scorePlum(0, vec3(0, 0, 40), 1);
    const refs = f.locals.collectEntities({ time: 1000, frameTime: 0, viewOrigin }).entities; expect(refs.map(ref => ref.origin.z)).toEqual([-10, 40, 30]);
  });
  test("spawn effects preserve base versus mission origin and shader choice", () => {
    const base = fixture(), mission = fixture("missionpack");
    const a = base.effects.spawnEffect(zero), b = mission.effects.spawnEffect(zero);
    expect(a.refEntity.origin.z).toBe(-24); expect(b.refEntity.origin.z).toBe(16); expect(a.refEntity.customShader?.name).toBe("teleportEffect"); expect(b.refEntity.customShader).toBeNull();
    expect(a.endTime).toBe(1500); expect(b.lifeRate).toBe(Math.fround(0.002));
  });
});

describe("missionpack effect constructors", () => {
  test("shield impact and juiced axes preserve captured QVM angle bits", () => {
    const { effects } = fixture("missionpack");
    const axisBits = (axis: readonly Vec3[]) => axis.map(vector => [float32ToBits(vector.x), float32ToBits(vector.y), float32ToBits(vector.z)]);
    // Independent q_math QVM captures retained in tests/qvm-math.test.ts.
    expect(axisBits(effects.invulnerabilityImpact(zero, vec3(0, 8.26171875, 0)).refEntity.axis)).toEqual([
      [0x3f7d57de, 0x3e1324ca, 0x80000000], [0xbe1324ca, 0x3f7d57de, 0], [0, 0, 0x3f800000],
    ]);
    expect(axisBits(effects.invulnerabilityJuiced(zero).refEntity.axis)).toEqual([
      [0x3f800000, 0, 0x80000000], [0, 0x3f800000, 0], [0, 0, 0x3f800000],
    ]);
  });
  test("lightning is a real canonical lightning record, not a beam substitute", () => {
    const f = fixture("missionpack"), le = f.effects.lightningBoltBeam(zero, vec3(10, 20, 30));
    expect(le.refEntity.kind).toBe("lightning"); expect(le.endTime).toBe(1050); expect(f.locals.collectEntities({ time: 1049, frameTime: 0, viewOrigin }).entities.length).toBe(1);
    expect(f.locals.collectEntities({ time: 1050, frameTime: 1, viewOrigin }).entities.length).toBe(0);
    expect(() => fixture().effects.lightningBoltBeam(zero, zero)).toThrow("Missionpack");
  });
  test("kamikaze, obelisk and shield constructors feed real local playback and mixer", () => {
    const f = fixture("missionpack"), kami = f.effects.kamikazeEffect(zero); expect(kami.endTime).toBe(4000); expect(kami.refEntity.model.path).toBe("kamikaze");
    f.pool.free(kami); f.effects.obeliskExplode(zero);
    const explosion = f.locals.collectEntities({ time: 1000, frameTime: 0, viewOrigin }); expect(entityAt(explosion.entities, 0).origin.z).toBe(64); expect(explosion.dynamicLights[0]?.color).toEqual(vec3(1, 0.75, 0));
    f.random.value = 2; const impact = f.effects.invulnerabilityImpact(zero, vec3(0, 90, 0)); expect(impact.refEntity.axis[0].y).toBe(1); expect(impact.endTime).toBe(2000);
    const mission = f.media.variant; if (mission.product !== "missionpack") throw new Error("Expected mission media"); expect(f.sounds[0]?.sound).toBe(mission.media.invulnerabilityImpactSounds[1]);
    f.random.value = 3; f.effects.obeliskPain(zero); expect(f.sounds[1]?.sound).toBe(mission.media.obeliskHitSounds[2]);
    const juiced = f.effects.invulnerabilityJuiced(zero); expect(juiced.endTime).toBe(11000); expect(f.sounds[2]?.entity).toBe(1023); expect(f.sounds[2]?.channel).toBe(5);
    expect(f.audio.mix(4).some(sample => sample !== 0)).toBe(true);
  });
});

const dataPath = process.env["Q3_DATA"];
test.skipIf(dataPath === undefined)("retail missing effect shaders retain source zero and render the global default through CPU and GL", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const images = new RendererImageCatalog();
    const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Source-zero cgame effects", width: 160, height: 120, backend: "gl", hidden: true }) : null;
    const gl = window === null ? null : new GlRenderer(window, images);
    const settings = createRendererSettings();
    gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const cpu = new SoftwareRenderer(160, 120, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
    const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
    const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1100 };
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
    let commands: RenderCommandBuffer | null = null;
    try {
      const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
      commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
      const missing = await resources.registerShader("gfx/__missing_cgame_effect_fixture__");
      expect(missing).toBeNull(); expect(await resources.registerShaderNoMip("gfx/__missing_cgame_effect_fixture__")).toBeNull();
      const f = fixture(product);
      f.effects.smokePuff(smoke({ origin: vec3(0, -25, 0), velocity: zero, radius: 20, color: white, shader: missing }));
      f.effects.makeExplosion({ origin: vec3(0, 25, 0), direction: vec3(0, 0, 1), model: DEFAULT_MODEL, shader: missing, duration: 600, sprite: true });
      const camera = vec3(100, 0, 0), scene = f.locals.collectEntities({ time: 1100, frameTime: 16, viewOrigin: camera });
      expect(scene.entities).toHaveLength(2);
      expect(scene.entities.every(entity => entity.kind === "sprite" && entity.customShader === null)).toBe(true);
      const refdef = createRefdef();
      refdef.width = 160; refdef.height = 120; refdef.fovX = 90; refdef.fovY = Math.atan(120 / 160) * 360 / Math.PI;
      refdef.viewOrigin = camera; refdef.viewAxis = anglesToAxis(vec3(0, 180, 0)); refdef.time = 1100; refdef.renderFlags = RDF_NOWORLDMODEL;
      commands.addView({ viewport: { x: 0, y: 0, width: 160, height: 120 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
      commands.addPreparedViews(resources.prepareFrame({ refdef, entities: scene.entities }));
      commands.submit();
      const batches = recording.trace().flatMap(view => view.batches);
      const defaultPicture = resources.picture(missing), defaultTexture = defaultPicture.material.image;
      expect(defaultTexture).not.toBeNull(); expect(batches).toHaveLength(2);
      expect(batches.every(batch => batch.texture.kind === "bind-image" && batch.texture.image === defaultTexture)).toBe(true);
      expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 0).length).toBeGreaterThan(100);
      if (gl !== null) {
        const pixels = gl.readPixels(); let error = 0;
        for (const [index, value] of pixels.entries()) {
          const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing CPU pixel"); error += Math.abs(value - expected);
        }
        expect(error / pixels.length).toBeLessThan(1);
      }
    } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
  }
});
test.skipIf(dataPath === undefined)("retail smoke and explosion playback produces real CPU and OpenGL frames", async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Retail cgame effects", width: 320, height: 240, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(320, 240, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1250 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  let commands: RenderCommandBuffer | null = null;
  try {
    const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    const smokeShader = await resources.registerShader("smokePuff"), explosionShader = await resources.registerShader("rocketExplosion"), explosionModel = await resources.registerModel("models/weaphits/boom01.md3");
    const f = fixture();
    f.effects.smokePuff(smoke({ origin: vec3(0, -20, 0), velocity: vec3(0, 0, 10), radius: 30, color: white, shader: smokeShader }));
    f.effects.makeExplosion({ origin: vec3(0, 25, 0), direction: vec3(0, 0, 1), model: explosionModel, shader: explosionShader, duration: 600, sprite: true });
    const camera = vec3(100, 0, 0), scene = f.locals.collectEntities({ time: 1250, frameTime: 16, viewOrigin: camera });
    const refdef = createRefdef();
    refdef.width = 320; refdef.height = 240; refdef.fovX = 90; refdef.fovY = Math.atan(240 / 320) * 360 / Math.PI;
    refdef.viewOrigin = camera; refdef.viewAxis = anglesToAxis(vec3(0, 180, 0)); refdef.time = 1250; refdef.renderFlags = RDF_NOWORLDMODEL;
    commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
    commands.addPreparedViews(resources.prepareFrame({ refdef, entities: scene.entities, dynamicLights: scene.dynamicLights }));
    commands.submit();
    const batches = recording.trace().flatMap(view => view.batches);
    expect(batches.length).toBeGreaterThan(0);
    expect(cpu.pixels.filter((value, index) => index % 4 !== 3 && value > 0).length).toBeGreaterThan(100);
    if (gl !== null) {
      const pixels = gl.readPixels(); let error = 0;
      for (const [index, value] of pixels.entries()) { const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing CPU pixel"); error += Math.abs(value - expected); }
      expect(error / pixels.length).toBeLessThan(1);
      const capture = process.env["QUAKE_EFFECT_CAPTURE"]; if (capture !== undefined) { await Bun.write(`${capture}.cpu.rgba`, cpu.pixels); await Bun.write(`${capture}.gl.rgba`, pixels); }
    }
  } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
});
