import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import type { BspMap } from "../src/assets/bsp.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import type { StartSoundOptions } from "../src/audio/mixer.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { ClientEffects } from "../src/cgame/effects.ts";
import type { EffectMedia } from "../src/cgame/effects.ts";
import { LocalEntityFlags, LocalEntityPool, LocalEntitySystem, MAX_LOCAL_ENTITIES } from "../src/cgame/local-entities.ts";
import type { LocalEntity, LocalEntityHost, LocalEntityMedia, SpriteLocalEntity } from "../src/cgame/local-entities.ts";
import { ImpactMarkSystem } from "../src/cgame/marks.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { BspMarkProjector } from "../src/render/marks.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { createModelEntity, createSpriteEntity, DEFAULT_MODEL, RF_LIGHTING_ORIGIN } from "../src/render/ref-entity.ts";
import type { RefEntity, SceneModel } from "../src/render/ref-entity.ts";
import type { Product } from "../src/shared/definitions.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { markGeometry } from "./marks-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const far = vec3(1000, 1000, 1000);
const sound: PcmSound = { sampleRate: 22050, channels: 1, samples: new Int16Array(2000).fill(20000), frameCount: 2000, loopStart: null };
test("allocation is constructible before effects, collision, audio or renderer services", () => {
  const pool = new LocalEntityPool("baseq3"), first = pool.allocate("fragment", createModelEntity());
  expect(pool.activeCount).toBe(1); expect(pool.activeEntities()).toEqual([first]);
  expect(first.startTime).toBe(0); expect(first.endTime).toBe(0); expect(first.pos.type).toBe(TrajectoryType.TR_STATIONARY);
  expect(() => pool.allocate("kamikaze", createModelEntity())).toThrow("missionpack");
  expect(pool.activeEntities()).toEqual([first]);
  pool.initialize();
  const replacement = pool.allocate("fragment", createModelEntity());
  expect(replacement).not.toBe(first); expect(pool.isActive(first)).toBe(false); expect(pool.isActive(replacement)).toBe(true);
});
test("source zero bounce and kamikaze handles reach the real sound bank and PCM mixer", async () => {
  const bytes = new Uint8Array(48), wav = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] satisfies readonly (readonly [number, string])[]) {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
  }
  wav.setUint32(4, 40, true); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, 22050, true); wav.setUint32(28, 44100, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
  wav.setUint32(40, 4, true); wav.setInt16(44, -123, true); wav.setInt16(46, 456, true);
  const warnings: string[] = [];
  const assets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ has: name => name === "sound/feedback/hit.wav", list: () => [],
    read: () => Promise.resolve(bytes), readSync: () => bytes,
    readFileLength: name => name === "sound/feedback/hit.wav" ? bytes.byteLength : -1,
    readFileOptional: async name => name === "sound/feedback/hit.wav" ? bytes : undefined,
    readFileOptionalSync: name => name === "sound/feedback/hit.wav" ? bytes : undefined });
  const bank = new ClientSoundBank(assets, { debugPrint: text => { warnings.push(text); }, print: text => warnings.push(text) });
  await bank.beginRegistration();
  const missing = await bank.registerSound("sound/missing.wav", false);
  expect(missing).toBeNull(); expect(warnings).toHaveLength(1);
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product, true), host = f.locals.host, calls: { sound: PcmSound | null; options: StartSoundOptions }[] = [];
    f.audio.setEffectsVolume(1);
    const audio: LocalEntityHost["audio"] = { startSound(handle, options) {
      calls.push({ sound: handle, options });
      const pcm = bank.resolveForPlayback(handle);
      if (pcm === null) throw new Error("Fixture bank lost its real zero-handle sound");
      f.audio.startSound(pcm, options);
    } };
    const media: LocalEntityMedia = { ...host.media, gibBounceSounds: [missing, missing, missing] };
    const locals = new LocalEntitySystem(f.effects, host.product === "baseq3" ? { ...host, audio, media }
      : { ...host, audio, media: { ...host.media, ...media, kamikazeExplodeSound: missing, kamikazeImplodeSound: missing } });
    const fragment = f.pool.allocate("fragment", createModelEntity());
    fragment.endTime = 2000; fragment.leBounceSoundType = "blood"; fragment.bounceFactor = 0.6;
    fragment.refEntity.origin = vec3(0, 0, 10);
    fragment.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, 10), delta: vec3(0, 0, -100) };
    f.random.reset(0);
    locals.collectEntities({ time: 200, frameTime: 200, viewOrigin: far });
    expect(calls).toEqual([{ sound: null, options: { entity: 1022, channel: 0, origin: { kind: "fixed", position: fragment.pos.base }, volume: 127 } }]);
    expect(f.audio.mix(2).some(sample => sample !== 0)).toBe(true);
    if (product === "missionpack") {
      f.pool.initialize(); f.effects.kamikazeEffect(vec3(0, 0, 0));
      f.soundClock.milliseconds = 201;
      locals.collectEntities({ time: 1, frameTime: 1, viewOrigin: far });
      expect(f.audio.mix(2)).toEqual(new Int16Array([-61, -61, 225, 225]));
      f.soundClock.milliseconds = 2200;
      locals.collectEntities({ time: 2000, frameTime: 1999, viewOrigin: far });
      expect(f.audio.mix(2)).toEqual(new Int16Array([-61, -61, 225, 225]));
      locals.collectEntities({ time: 2100, frameTime: 100, viewOrigin: far });
      expect(calls.slice(1)).toEqual(Array.from({ length: 2 }, () => ({ sound: null, options: { entity: 0, channel: 0, origin: { kind: "local" }, volume: 127 } })));
    }
  }
});
function fixture(product: Product = "baseq3", floor = false, contents = 1,
  registeredModels: { shockwave: SceneModel; boom: SceneModel; juiced: SceneModel } = { shockwave: DEFAULT_MODEL, boom: DEFAULT_MODEL, juiced: DEFAULT_MODEL }) {
  const geometry = markGeometry(), bounds = { min: vec3(-4096, -4096, -1000), max: vec3(4096, 4096, 1000) };
  const planes = [{ normal: vec3(1, 0, 0), distance: 4096 }, { normal: vec3(-1, 0, 0), distance: 4096 },
    { normal: vec3(0, 1, 0), distance: 4096 }, { normal: vec3(0, -1, 0), distance: 4096 },
    { normal: vec3(0, 0, 1), distance: 0 }, { normal: vec3(0, 0, -1), distance: 1000 }];
  const map: BspMap = { ...geometry.map, planes, shaders: [{ name: "solid", contentFlags: contents, surfaceFlags: 0 }],
    nodes: [{ plane: 4, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 1, firstBrush: 0, brushCount: floor ? 1 : 0 }],
    models: [{ bounds, firstSurface: 0, surfaceCount: 1, firstBrush: 0, brushCount: floor ? 1 : 0 }],
    leafBrushes: [0], brushes: [{ firstSide: 0, sideCount: 6, shader: 0 }], brushSides: planes.map((_, plane) => ({ plane, shader: 0 })) };
  const soundClock = { milliseconds: 0 };
  const state = new ClientGameState(product, 0, 0), random = new GameRandom(42), audio = new AudioMixer(22050, () => soundClock.milliseconds);
  const collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const unavailable = (): never => { throw new Error("Prediction movement services are outside this local-entity fixture"); };
  const prediction = new PredictionRuntime(state, collision, { commands: new ClientCommandHistory(), settings: unavailable,
    setPmoveMsec: unavailable, transitionPlayerState: unavailable, warn: unavailable });
  const marks = new ImpactMarkSystem(new BspMarkProjector({ ...geometry, map }), { clock: () => state.time, enabled: () => true, energyShader: () => null });
  const media: LocalEntityMedia = { bloodTrailShader: { name: "999" }, bloodMarkShader: { name: "blood" }, burnMarkShader: { name: "burn" },
    gibBounceSounds: [sound, sound, sound], numberShaders: [{ name: "100" }, { name: "101" }, { name: "102" }, { name: "103" },
      { name: "104" }, { name: "105" }, { name: "106" }, { name: "107" }, { name: "108" }, { name: "109" }, { name: "110" }] };
  const localAudio: LocalEntityHost["audio"] = { startSound(pcm, options) {
    if (pcm === null) throw new Error("Fixture media unexpectedly returned source sound handle zero");
    audio.startSound(pcm, options);
  } };
  const services = { prediction, collision, audio: localAudio, marks, random, clientNum: 0 };
  const host: LocalEntityHost = product === "baseq3" ? { ...services, product, media } : { ...services, product,
    media: { ...media, kamikazeShockWave: registeredModels.shockwave, kamikazeExplodeSound: sound, kamikazeImplodeSound: sound } };
  const pool = new LocalEntityPool(product);
  const effectMedia: EffectMedia = { waterBubbleShader: null, smokePuffRageProShader: null, bloodExplosionShader: null,
    teleportEffectModel: DEFAULT_MODEL, gibSkull: DEFAULT_MODEL, gibBrain: DEFAULT_MODEL, gibAbdomen: DEFAULT_MODEL,
    gibArm: DEFAULT_MODEL, gibChest: DEFAULT_MODEL, gibFist: DEFAULT_MODEL, gibFoot: DEFAULT_MODEL, gibForearm: DEFAULT_MODEL,
    gibIntestine: DEFAULT_MODEL, gibLeg: DEFAULT_MODEL, smoke2: DEFAULT_MODEL,
    variant: product === "baseq3" ? { product, teleportEffectShader: null } : { product, media: {
      lightningShader: null, kamikazeEffectModel: registeredModels.boom, dishFlashModel: DEFAULT_MODEL, rocketExplosionShader: null,
      obeliskHitSounds: [sound, sound, sound], invulnerabilityImpactModel: DEFAULT_MODEL,
      invulnerabilityImpactSounds: [sound, sound, sound], invulnerabilityJuicedModel: registeredModels.juiced, invulnerabilityJuicedSound: sound } } };
  const effects: ClientEffects = new ClientEffects(state, pool, effectMedia, { noProjectileTrail: false, blood: true, gibs: true, scorePlum: true, hardware: "generic" },
    { randomInteger: () => random.rand(), startSound: (origin, entity, channel, pcm) => {
      if (pcm !== null) audio.startSound(pcm, { entity, channel, origin: { kind: "fixed", position: origin }, volume: 127 });
    } });
  const locals = new LocalEntitySystem(effects, host);
  function frame(time: number, frameTime = 16) { state.time = time; state.frameTime = frameTime; return locals.collectEntities({ time, frameTime, viewOrigin: far }); }
  return { pool, locals, state, random, audio, soundClock, marks, collision, prediction, effects, frame };
}
function fill(entity: LocalEntity, shader: number): void {
  entity.startTime = 1000; entity.endTime = 3000; entity.lifeRate = Math.fround(1 / 2000); entity.radius = 17;
  entity.color = vec4(0.2, 0.4, 0.7, 0.8);
  entity.pos = { type: TrajectoryType.TR_LINEAR, time: 1000, duration: 0, base: vec3(1, 2, 3), delta: vec3(5, -4, 7) };
  const re = entity.refEntity;
  if (re.kind === "portal-surface") throw new Error("Fixture requires shaded ref entity");
  re.customShader = { name: String(shader) }; re.shaderRGBA = vec4(51, 102, 178, 255); re.origin = vec3(1, 2, 3);
  if (re.kind === "sprite") re.radius = 17;
}
test("source zero shaders still allocate blood trails, submit score digits and project both bounce marks", () => {
  for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
    const f = fixture(product), host = f.locals.host;
    const media: LocalEntityMedia = { ...host.media, bloodTrailShader: null, bloodMarkShader: null, burnMarkShader: null,
      numberShaders: [null, null, null, null, null, null, null, null, null, null, null] };
    const locals = new LocalEntitySystem(f.effects, host.product === "baseq3" ? { ...host, media }
      : { ...host, media: { ...host.media, ...media } });
    const fragment = f.pool.allocate("fragment", createModelEntity());
    fragment.endTime = 4000; fragment.refEntity.origin = vec3(100, 0, 100); fragment.leBounceSoundType = "blood";
    fragment.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(100, 0, 100), delta: vec3(100, 0, 0) };
    locals.collectEntities({ time: 150, frameTime: 150, viewOrigin: far });
    const trail = f.pool.activeEntities()[0];
    expect(trail?.leType).toBe("fall-scale-fade");
    if (trail?.refEntity.kind !== "sprite") throw new Error("Missing source-zero blood trail");
    expect(trail.refEntity.customShader).toBeNull();
    f.effects.scorePlum(0, vec3(0, 0, 100), -12);
    const sprites = locals.collectEntities({ time: 150, frameTime: 0, viewOrigin: far }).entities.filter(entity => entity.kind === "sprite");
    expect(sprites).toHaveLength(4); expect(sprites.every(entity => entity.customShader === null)).toBe(true);
    for (const mark of ["blood", "burn"] satisfies readonly ("blood" | "burn")[]) {
      const impact = fixture(product, true), impactHost = impact.locals.host;
      const processor = new LocalEntitySystem(impact.effects, impactHost.product === "baseq3"
        ? { ...impactHost, media: { ...impactHost.media, bloodMarkShader: null, burnMarkShader: null } }
        : { ...impactHost, media: { ...impactHost.media, bloodMarkShader: null, burnMarkShader: null } });
      const gib = impact.pool.allocate("fragment", createModelEntity());
      gib.endTime = 2000; gib.leMarkType = mark; gib.refEntity.origin = vec3(0, 0, 10);
      gib.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, 10), delta: vec3(0, 0, -100) };
      processor.collectEntities({ time: 200, frameTime: 200, viewOrigin: far });
      const polys = impact.marks.addMarks();
      expect(polys.length).toBeGreaterThan(0); expect(polys.every(poly => poly.shader === null)).toBe(true);
      expect(String(gib.leMarkType)).toBe("none");
    }
  }
});
function bits(entity: RefEntity): number[] {
  if (entity.kind === "portal-surface") throw new Error("Fixture requires shaded ref entity");
  return [Number(entity.customShader?.name), float32ToBits(entity.origin.x) | 0, float32ToBits(entity.origin.y) | 0,
    float32ToBits(entity.origin.z) | 0, float32ToBits(entity.kind === "model" ? 0 : entity.radius) | 0,
    entity.shaderRGBA.x, entity.shaderRGBA.y, entity.shaderRGBA.z, entity.shaderRGBA.w, entity.kind === "model" ? float32ToBits(entity.axis[0].x) | 0 : 0];
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) describe(`${product} source local entities`, () => {
  test("reached renderer calls publish each explosion light before the next local entity", () => {
    const f = fixture(product), first = f.pool.allocate("explosion", createModelEntity()), second = f.pool.allocate("fade-rgb", createModelEntity());
    fill(first, 1); fill(second, 2); first.light = 137; first.lightColor = vec3(0.1, 0.4, 0.8);
    const calls: string[] = [];
    f.locals.addEntities({ time: 1500, frameTime: 16, viewOrigin: far }, {
      addRefEntity: entity => { if (entity.kind === "portal-surface") throw new Error("Expected shaded effect"); calls.push(`entity:${entity.customShader?.name}`); },
      addLight: light => { calls.push(`light:${light.radius}`); },
    });
    expect(calls).toEqual(["entity:1", "light:137", "entity:2"]);
    calls.length = 0; second.refEntity.shaderRGBA = vec4(0, 0, 0, 0);
    expect(() => f.locals.addEntities({ time: 1600, frameTime: 100, viewOrigin: far }, {
      addRefEntity: entity => { if (entity.kind === "portal-surface") throw new Error("Expected shaded effect"); calls.push(`entity:${entity.customShader?.name}`); },
      addLight: light => { calls.push(`light:${light.radius}`); throw new Error("light admission failed"); },
    })).toThrow("light admission failed");
    expect(calls).toEqual(["entity:1", "light:137"]);
    expect(second.refEntity.shaderRGBA).toEqual(vec4(0, 0, 0, 0));
  });
  test("renderer rejection preserves reached fragment writes and skips sink restoration and blood tails", () => {
    const f = fixture(product), fragment = f.pool.allocate("fragment", createModelEntity());
    fragment.endTime = 1000; fragment.refEntity.origin = vec3(0, 0, 100);
    const reject = { addRefEntity: (): never => { throw new Error("entity admission failed"); }, addLight: (): never => { throw new Error("Unexpected fragment light"); } };
    expect(() => f.locals.addEntities({ time: 500, frameTime: 16, viewOrigin: far }, reject)).toThrow("entity admission failed");
    expect(fragment.refEntity.origin.z).toBe(92);
    expect(fragment.refEntity.lightingOrigin.z).toBe(100);
    expect(fragment.refEntity.renderFlags & RF_LIGHTING_ORIGIN).toBe(RF_LIGHTING_ORIGIN);
    f.pool.initialize();
    const blood = f.effects.launchGib(vec3(0, 0, 100), vec3(100, 0, 0), DEFAULT_MODEL);
    expect(() => f.locals.addEntities({ time: 250, frameTime: 250, viewOrigin: far }, reject)).toThrow("entity admission failed");
    expect(blood.refEntity.origin).toEqual(vec3(25, 0, 75));
    expect(f.pool.activeEntities()).toEqual([blood]);
  });
  test("fixed pool evicts oldest, reuses freed slots, rejects expired records and resets independently", () => {
    const f = fixture(product), records = Array.from({ length: MAX_LOCAL_ENTITIES }, (_, index) => {
      const entity = f.pool.allocate("explosion", createSpriteEntity()); fill(entity, index); return entity;
    });
    const first = records[0], second = records[1]; if (first === undefined || second === undefined) throw new Error("Missing fixture records");
    const replacement = f.pool.allocate("explosion", createSpriteEntity()); fill(replacement, 512);
    expect(f.pool.activeCount).toBe(512); expect(f.pool.isActive(first)).toBe(false); expect(f.pool.isActive(second)).toBe(true);
    const active = f.pool.activeEntities(); expect(active[0]).toBe(replacement); expect(active[511]).toBe(second);
    expect(Object.isFrozen(active)).toBe(true); expect(active).not.toBe(f.pool.activeEntities());
    replacement.light = 9; expect(active[0]?.light).toBe(9);
    expect(() => f.pool.free(first)).toThrow("not active");
    const order = f.frame(1500).entities.map(entity => entity.kind === "sprite" ? entity.customShader?.name : null);
    expect(order).toEqual(Array.from({ length: 512 }, (_, index) => String(index + 1)));
    f.pool.free(second); expect(() => f.pool.free(second)).toThrow("not active");
    expect(active.length).toBe(512); expect(f.pool.activeEntities().length).toBe(511);
    const other = fixture(product); expect(other.pool.activeCount).toBe(0);
    f.pool.initialize(); expect(f.pool.isActive(replacement)).toBe(false); expect(f.pool.activeCount).toBe(0);
    expect(() => other.pool.free(replacement)).toThrow("not active");
  });
  test("original cg_localents QVM integer-bit fixtures cover fade, motion, sprite explosion and signed score digits", () => {
    const f = fixture(product);
    for (const [type, shader] of [["move-scale-fade", 1], ["fall-scale-fade", 2], ["scale-fade", 3]] satisfies readonly (readonly [SpriteLocalEntity["leType"], number])[]) {
      fill(f.pool.allocate(type, createSpriteEntity()), shader);
    }
    fill(f.pool.allocate("fade-rgb", createSpriteEntity()), 4);
    const explosion = f.pool.allocate("sprite-explosion", createSpriteEntity()); fill(explosion, 5); explosion.light = 137; explosion.lightColor = vec3(0.1, 0.4, 0.8);
    const score = f.pool.allocate("score-plum", createSpriteEntity()); fill(score, 6); score.radius = -123;
    const scene = f.frame(1610, 110);
    // Untouched cg_localents.c + cg_effects.c compiled with original lcc/q3asm, interpreted by stock1.32b.
    expect(scene.entities.map(bits)).toEqual([
      [1, 1082235290, -1092532304, 1088988119, 1095955906, 51, 102, 178, 141, 0],
      [2, 1065353216, 1073741824, 1063088296, 1101626081, 51, 102, 178, 141, 0],
      [3, 1065353216, 1073741824, 1077936128, 1095955906, 51, 102, 178, 141, 0],
      [4, 1065353216, 1073741824, 1077936128, 1099431936, 35, 70, 124, 141, 0],
      [5, 1065353216, 1073741824, 1077936128, 1110130033, 255, 255, 255, 58, 0],
      [110, -1056902863, 1093736030, 1110310910, 1082130432, 255, 17, 17, 255, 0],
      [101, -1050974192, 1099289144, 1110310910, 1082130432, 255, 17, 17, 255, 0],
      [102, -1046810761, 1102256450, 1110310910, 1082130432, 255, 17, 17, 255, 0],
      [103, -1043846426, 1105223756, 1110310910, 1082130432, 255, 17, 17, 255, 0],
    ]);
    expect(scene.dynamicLights.map(light => [light.radius, light.color.x, light.color.y, light.color.z].map(float32ToBits)))
      .toEqual([[1124663296, 1036831949, 1053609165, 1061997773]]);
    expect(explosion.refEntity.radius).toBe(17); expect(explosion.refEntity.shaderRGBA.w).toBe(255);
    const before = scene.entities.map(bits); f.frame(1700); expect(scene.entities.map(bits)).toEqual(before);
  });
  test("source saturation self-eviction rereads the reused slot and follows the reused cached-next slot", () => {
    const f = fixture(product), fragment = f.pool.allocate("fragment", createModelEntity()); fill(fragment, 700); fragment.endTime = 4000;
    fragment.refEntity.origin = vec3(100, 0, 100);
    fragment.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(100, 0, 100), delta: vec3(100, 0, 0) };
    fragment.leBounceSoundType = "blood";
    for (let index = 0; index < 511; index++) { const item = f.pool.allocate("explosion", createSpriteEntity()); fill(item, index); item.endTime = 4000; }
    const scene = f.frame(300, 300);
    expect(f.pool.activeCount).toBe(512); expect(f.pool.isActive(fragment)).toBe(false);
    expect(scene.entities.map(entity => [entity.kind, ...bits(entity).slice(0, 4)])).toEqual([
      ["model", 700, 1124204544, 0, 1120403456], ["sprite", 999, 1122369536, 0, 1121189888],
    ]);
    expect(scene.entities).toHaveLength(2);
  });
  test("real collision bounces, leaves a projected mark, emits PCM and sinks using a copied lighting origin", () => {
    const f = fixture(product, true), entity = f.pool.allocate("fragment", createModelEntity());
    entity.startTime = 0; entity.endTime = 2000; entity.bounceFactor = 0.6; entity.leMarkType = "blood"; entity.leBounceSoundType = "blood";
    entity.refEntity.origin = vec3(0, 0, 10); entity.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, 10), delta: vec3(0, 0, -100) };
    const impact = f.frame(200, 200);
    expect(entity.pos.base.z).toBeCloseTo(0.125, 6); expect(entity.refEntity.origin.z).toBe(10);
    expect(entity.pos.delta.z).toBe(Math.fround(60)); expect(String(entity.leMarkType)).toBe("none"); expect(String(entity.leBounceSoundType)).toBe("none");
    expect(f.marks.activeMarkCount).toBeGreaterThan(0); expect(f.marks.addMarks().length).toBeGreaterThan(0); expect(impact.entities).toHaveLength(1);
    expect(f.audio.mix(100).some(sample => sample !== 0)).toBe(true);
    entity.pos = { ...entity.pos, type: TrajectoryType.TR_STATIONARY }; entity.refEntity.origin = vec3(0, 0, 10);
    const sinking = f.frame(1500).entities[0]; if (sinking?.kind !== "model") throw new Error("Expected sinking model");
    expect(sinking.origin.z).toBe(2); expect(sinking.lightingOrigin.z).toBe(10); expect(sinking.renderFlags & RF_LIGHTING_ORIGIN).toBe(RF_LIGHTING_ORIGIN);
    expect(entity.refEntity.origin.z).toBe(10); expect(f.frame(2000).entities).toEqual([]); expect(f.pool.activeCount).toBe(0);
  });
  test("fade-in, no-scale flag, near-view removal and future-start sprite clamp retain source boundaries", () => {
    const f = fixture(product), puff = f.effects.smokePuff({ origin: vec3(50, 0, 0), velocity: vec3(0, 0, 0), radius: 20,
      color: vec4(1, 1, 1, 0.5), duration: 1000, startTime: 1000, fadeInTime: 1200, flags: LocalEntityFlags.PUFF_DONT_SCALE, shader: null });
    const scene = f.frame(1100), sprite = scene.entities[0]; if (sprite?.kind !== "sprite") throw new Error("Expected puff");
    expect(sprite.radius).toBe(20); expect(sprite.shaderRGBA.w).toBe(63);
    expect(f.locals.collectEntities({ time: 1100, frameTime: 16, viewOrigin: vec3(50, 0, 0) }).entities).toEqual([]); expect(f.pool.isActive(puff)).toBe(false);
    const explosion = f.pool.allocate("sprite-explosion", createSpriteEntity()); explosion.startTime = 2000; explosion.endTime = 3000;
    const future = f.frame(1000).entities[0]; if (future?.kind !== "sprite") throw new Error("Expected explosion");
    expect(future.radius).toBe(30); expect(future.shaderRGBA.w).toBe(84);
  });
  test("all-solid fragments settle without a plane, and nodrop removes them before bounce effects", () => {
    for (const contents of [1, 1 | 0x80000000]) {
      const f = fixture(product, true, contents), entity = f.pool.allocate("fragment", createModelEntity());
      entity.endTime = 2000; entity.bounceFactor = 0.5; entity.refEntity.origin = vec3(0, 0, -10);
      entity.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, -10), delta: vec3(0, 0, -100) };
      const scene = f.frame(100, 100);
      if (contents === 1) {
        expect(scene.entities).toHaveLength(1); expect(entity.pos.type).toBe(TrajectoryType.TR_STATIONARY);
        expect(entity.pos.delta).toEqual(vec3(0, 0, -50)); expect(entity.pos.base).toEqual(vec3(0, 0, -10));
      } else { expect(scene.entities).toHaveLength(0); expect(f.pool.isActive(entity)).toBe(false); }
    }
  });
  test("solid-only fragment traces ignore players, include brush movers and update angular tumble", () => {
    const f = fixture(product, true), cent = f.state.entityAt(5);
    cent.currentState.number = 5; cent.currentState.solid = 10 | (10 << 8) | (42 << 16); cent.lerpOrigin = vec3(30, 0, 100);
    f.state.solidEntities.push(cent);
    const entity = f.pool.allocate("fragment", createModelEntity()); entity.endTime = 2000; entity.bounceFactor = 0.5;
    entity.refEntity.origin = vec3(0, 0, 100); entity.leFlags = LocalEntityFlags.TUMBLE;
    entity.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, 100), delta: vec3(100, 0, 0) };
    entity.angles = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, 0), delta: vec3(0, 90, 0) };
    f.frame(100, 100); expect(entity.refEntity.origin.x).toBe(10); expect(entity.refEntity.axis[0].y).toBeCloseTo(Math.sin(Math.PI / 20), 6);
    f.frame(250, 150); expect(entity.refEntity.origin.x).toBe(25); expect(entity.pos.delta.x).toBe(100);
    cent.currentState.solid = 0xffffff; cent.currentState.modelindex = 0; cent.lerpAngles = vec3(-90, 0, 0);
    cent.currentState.pos = { ...cent.currentState.pos, base: vec3(30, 0, 0) };
    f.frame(350, 100); expect(entity.pos.delta.x).toBe(-50); expect(entity.pos.base.x).toBeCloseTo(29.875, 5);
    expect(entity.refEntity.origin.x).toBe(25);
  });
  test("fragment tumble publishes captured QVM angle bits", () => {
    const f = fixture(product), entity = f.pool.allocate("fragment", createModelEntity());
    entity.endTime = 2000; entity.leFlags = LocalEntityFlags.TUMBLE;
    entity.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 0, 100), delta: vec3(0, 0, 0) };
    entity.angles = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: vec3(0, 8.26171875, 0), delta: vec3(0, 0, 0) };
    const ref = f.frame(100, 100).entities[0];
    if (ref?.kind !== "model") throw new Error("Missing tumbling fragment");
    // Independent q_math QVM captures retained in tests/qvm-math.test.ts.
    expect(ref.axis.map(axis => [float32ToBits(axis.x), float32ToBits(axis.y), float32ToBits(axis.z)])).toEqual([
      [0x3f7d57de, 0x3e1324ca, 0x80000000], [0xbe1324ca, 0x3f7d57de, 0], [0, 0, 0x3f800000],
    ]);
  });
});

test("missionpack kamikaze phases, one-shot sounds and juiced expiry run real effect allocations", () => {
  const f = fixture("missionpack"); f.state.time = 0;
  const effect = f.effects.kamikazeEffect(vec3(100, 0, 100));
  expect(f.frame(0).entities).toHaveLength(0);
  expect(f.frame(1).entities).toHaveLength(1); expect(f.audio.mix(100).some(value => value !== 0)).toBe(true);
  expect(f.frame(1000).entities).toHaveLength(2); expect(f.frame(2000).entities).toHaveLength(1);
  const second = f.frame(2100); expect(second.entities).toHaveLength(2); expect(second.dynamicLights).toHaveLength(1);
  expect(f.frame(3000).entities).toHaveLength(0);
  f.pool.initialize(); f.state.time = 0; f.effects.invulnerabilityJuiced(vec3(0, 0, 100));
  const stretched = f.frame(4000).entities[0]; if (stretched?.kind !== "model") throw new Error("Expected juiced model");
  expect(stretched.axis[0].x).toBe(Math.fround(1.15)); expect(stretched.axis[2].z).toBe(Math.fround(0.85));
  expect(f.frame(5001).entities).toHaveLength(0); expect(f.pool.activeCount).toBe(11);
  expect(f.frame(5010).entities.length).toBeGreaterThan(0);
  expect(effect.leFlags).toBe(LocalEntityFlags.SOUND1 | LocalEntityFlags.SOUND2);
});
test("missionpack local effects reach prior draws before sound failure and interleave the second shockwave after its light", () => {
  const f = fixture("missionpack"), first = f.pool.allocate("explosion", createModelEntity());
  first.endTime = 3000; first.refEntity.customShader = { name: "first" };
  const kamikaze = f.effects.kamikazeEffect(vec3(0, 0, 0)); kamikaze.refEntity.customShader = { name: "kamikaze" };
  const calls: string[] = [], host = f.locals.host;
  const failing = new LocalEntitySystem(f.effects, { ...host, audio: { startSound: () => { calls.push("sound"); throw new Error("sound admission failed"); } } });
  const scene = {
    addRefEntity: (entity: RefEntity): void => { if (entity.kind === "portal-surface") throw new Error("Expected shaded effect"); calls.push(entity.customShader?.name ?? "shockwave"); },
    addLight: (): void => { calls.push("light"); },
  };
  expect(() => failing.addEntities({ time: 2100, frameTime: 100, viewOrigin: far }, scene)).toThrow("sound admission failed");
  expect(calls).toEqual(["first", "sound"]);
  expect(kamikaze.leFlags & LocalEntityFlags.SOUND2).toBe(0);
  calls.length = 0;
  const observed = new LocalEntitySystem(f.effects, { ...host, audio: { startSound: (sound, options) => { calls.push("sound"); host.audio.startSound(sound, options); } } });
  observed.addEntities({ time: 2100, frameTime: 100, viewOrigin: far }, scene);
  expect(calls).toEqual(["first", "sound", "kamikaze", "light", "shockwave"]);
  expect(kamikaze.leFlags & LocalEntityFlags.SOUND2).toBe(LocalEntityFlags.SOUND2);
});

test("missionpack original QVM shockwave/explosion phase scales and seeded second-shockwave axis agree exactly", () => {
  const f = fixture("missionpack"); f.state.time = 0; f.effects.kamikazeEffect(vec3(100, 0, 100));
  const rows = [1, 1000, 2000, 2100, 2750, 3000].map(time => {
    const scene = f.frame(time);
    return { time, entities: scene.entities.map(entity => {
      if (entity.kind !== "model") throw new Error("Kamikaze requires model submissions");
      return [entity.shaderRGBA.w, float32ToBits(entity.axis[0].x) | 0];
    }), lights: scene.dynamicLights.map(light => [float32ToBits(light.radius), float32ToBits(light.color.z)]) };
  });
  expect(rows).toEqual([
    { time: 1, entities: [[255, 1005961872]], lights: [] },
    { time: 1000, entities: [[255, 1089470464], [170, 1082729619]], lights: [[1138116901, 1054567863]] },
    { time: 2000, entities: [[85, 1092616192]], lights: [[1148846080, 1065353216]] },
    { time: 2100, entities: [[76, 1086324737], [255, -1089326133]], lights: [[1142292480, 1058642330]] },
    { time: 2750, entities: [[127, -1064759154]], lights: [] },
    { time: 3000, entities: [], lights: [] },
  ]);
});

test.skipIf(process.env["Q3_DATA"] === undefined)("retail Team Arena local kamikaze and juiced models render through common CPU/GL batches", async () => {
  const dataPath = process.env["Q3_DATA"]; if (dataPath === undefined) throw new Error("Q3_DATA required");
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "missionpack" });
  const images = new RendererImageCatalog();
  const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Team Arena local entities", width: 320, height: 240, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const settings = createRendererSettings();
  gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(320, 240, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1000 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  let commands: RenderCommandBuffer | null = null;
  try {
    const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
    const models = { shockwave: await resources.registerModel("models/weaphits/kamwave.md3"), boom: await resources.registerModel("models/weaphits/kamboom2.md3"),
      juiced: await resources.registerModel("models/powerups/shield/juicer.md3") };
    const f = fixture("missionpack", false, 1, models); f.effects.kamikazeEffect(vec3(0, 0, 0)); f.effects.invulnerabilityJuiced(vec3(0, 400, 0));
    const camera = vec3(2000, 0, 100), scene = f.locals.collectEntities({ time: 1000, frameTime: 16, viewOrigin: camera });
    expect(scene.entities).toHaveLength(3);
    const refdef = createRefdef();
    refdef.width = 320; refdef.height = 240; refdef.fovX = 90; refdef.fovY = Math.atan(240 / 320) * 360 / Math.PI;
    refdef.viewOrigin = camera; refdef.viewAxis = anglesToAxis(vec3(0, 180, 0)); refdef.time = 1000; refdef.renderFlags = RDF_NOWORLDMODEL;
    commands.addView({ viewport: { x: 0, y: 0, width: 320, height: 240 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
    commands.addPreparedViews(resources.prepareFrame({ refdef, entities: scene.entities, dynamicLights: scene.dynamicLights }));
    commands.submit();
    const batches = recording.trace().flatMap(view => view.batches);
    expect(batches.length).toBeGreaterThan(0);
    expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    if (gl !== null) {
      const pixels = gl.readPixels(); let error = 0;
      for (const [index, value] of pixels.entries()) {
        const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing CPU channel"); error += Math.abs(value - expected);
      }
      expect(error / pixels.length).toBeLessThan(1);
    }
  } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
}, 30000);
