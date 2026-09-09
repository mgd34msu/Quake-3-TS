import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { decodeWav } from "../src/assets/wav.ts";
import { ClientGameState } from "../src/cgame/state.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientWeaponMediaRegistry, ClientWeaponSelection, ClientWeaponRuntime, ImpactSound } from "../src/cgame/weapons.ts";
import type { ClientWeaponHost, WeaponPresentationMedia, WeaponPresentationSettings } from "../src/cgame/weapons.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { ClientEffects } from "../src/cgame/effects.ts";
import type { EffectMedia } from "../src/cgame/effects.ts";
import { LocalEntityPool, LocalEntitySystem } from "../src/cgame/local-entities.ts";
import type { LocalEntity, LocalEntityHost, LocalEntityMedia } from "../src/cgame/local-entities.ts";
import { ClientInfo } from "../src/cgame/client-info.ts";
import { positionRotatedEntityOnTag } from "../src/cgame/entities.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ImpactMarkSystem } from "../src/cgame/marks.ts";
import { ParticleSystem, loadParticleAnimations } from "../src/cgame/particles.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { CommonError } from "../src/core/common-error.ts";
import { vec3, vec4 } from "../src/core/math.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { bitsToFloat32, float32ToBits } from "../src/core/numeric.ts";
import { qvmAnglesToAxis } from "../src/core/qvm-math.ts";
import { BspMarkProjector } from "../src/render/marks.ts";
import { DEFAULT_MODEL, copyRefEntity, copyRefPoly, createModelEntity } from "../src/render/ref-entity.ts";
import type { RefEntity, RefPoly } from "../src/render/ref-entity.ts";
import type { MovementTrace } from "../src/shared/movement.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRefdef } from "../src/render/refdef.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { ItemType, Powerup, Team, Weapon, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { MoveFlags, createPlayerState } from "../src/shared/player-state.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];
const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
function missingAsset(path: string): never { throw new Error(`Missing fixture asset ${path}`); }

interface WeaponRendererOwner { readonly target: RenderTarget; readonly cinematics: EngineCinematics; commands: RenderCommandBuffer | null; readonly window: SdlWindow | null }
const rendererOwners: WeaponRendererOwner[] = [];
afterEach(() => {
  for (const owner of rendererOwners.splice(0)) {
    try { owner.commands?.close("discard"); owner.target.close(); }
    finally { owner.cinematics.dispose(); owner.window?.close(); }
  }
});

async function fixture(product: Product, missingHands = false, paired = false) {
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
  const images = new RendererImageCatalog();
  const window = paired ? SdlWindow.open({ title: "Cgame retail weapons", width: 160, height: 120, backend: "gl", hidden: true }) : null;
  const gl = window === null ? null : new GlRenderer(window, images);
  const rendererSettings = createRendererSettings();
  gl?.initializeDefaultState(rendererSettings.maxActiveTextures !== 0, () => {
    if (!images.setTextureMode(rendererSettings.textureMode.value)) rendererSettings.warnBadTextureMode();
  });
  const cpu = new SoftwareRenderer(160, 120, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
  const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
  const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1016 };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
  const owner: WeaponRendererOwner = { target, cinematics, commands: null, window };
  rendererOwners.push(owner);
  const resources = await RendererResources.create(assets, { kind: "unaccounted" }, rendererSettings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
  const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: rendererSettings.runtime });
  owner.commands = commands;
  const registrations: string[] = [];
  const registry = new ClientWeaponMediaRegistry(product, { ...resources,
    registerModel: path => missingHands && path !== null && path.endsWith("_hand.md3") ? Promise.resolve(DEFAULT_MODEL) : resources.registerModel(path),
  }, {
    async registerSound(path) { registrations.push(path); return decodeWav(await assets.read(path), path); },
  });
  const state = new ClientGameState(product, 0, 0);
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
    areaMask: new Uint8Array(), playerState: createPlayerState(product), entities: [] };
  state.time = 1000;
  return { assets, images, gl, cpu, recording, target, builtins, mixer, clock, cinematics, rendererSettings, commands,
    resources, registry, registrations, state, runtime: new ClientWeaponSelection(state) };
}

describe("source client weapon media registration", () => {
  test("failed real shader registration completes source weapon registration with zero handles", async () => {
    const missingAssets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ has: () => false, list: () => [],
      read: async (path): Promise<Uint8Array> => missingAsset(path), readSync: missingAsset,
      readFileLength: () => -1, readFileOptional: async () => undefined, readFileOptionalSync: () => undefined });
    for (const product of products) {
      const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images), recording = new BatchRecordingBackend(cpu);
      const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1000 };
      const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: text => { soundDebugMessages.push(text); return undefined; }, print: () => undefined, files: { kind: "diagnostic-bytes", reader: missingAssets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
        console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
      const owner: WeaponRendererOwner = { target, cinematics, commands: null, window: null };
      rendererOwners.push(owner);
      const settings = createRendererSettings();
      const resources = await RendererResources.create(missingAssets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics }), calls: string[] = [];
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
      owner.commands = commands;
      const soundDebugMessages: string[] = [];
      const bank = new ClientSoundBank(missingAssets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => undefined });
      await bank.beginRegistration();
      const registry = new ClientWeaponMediaRegistry(product, { ...resources,
        registerShader: name => { calls.push(name); return resources.registerShader(name); },
      }, bank);
      expect(() => registry.requireWeapon(Weapon.WP_ROCKET_LAUNCHER)).toThrow("finish registration");
      await registry.registerWeapon(Weapon.WP_ROCKET_LAUNCHER);
      const weapon = registry.requireWeapon(Weapon.WP_ROCKET_LAUNCHER);
      expect(weapon.weaponIcon).toBeNull(); expect(weapon.ammoIcon).toBeNull();
      expect(registry.effects.rocketExplosionShader).toBeNull();
      const itemIndex = itemList(product).findIndex(item => item.type === ItemType.IT_WEAPON && item.tag === Weapon.WP_ROCKET_LAUNCHER);
      expect(registry.items[itemIndex]?.icon).toBeNull();
      expect(calls).toEqual(["icons/iconw_rocket", "icons/iconw_rocket", "icons/iconw_rocket", "rocketExplosion"]);
      await registry.registerWeapon(Weapon.WP_ROCKET_LAUNCHER);
      expect(calls.length).toBe(4);
      expect(weapon.weaponModel).toBe(DEFAULT_MODEL);
      for (const number of [-1, itemList(product).length]) {
        const invalid = new ClientWeaponMediaRegistry(product, resources, bank), items = [...invalid.items];
        const work = invalid.registerItemVisuals(number);
        await expect(work).rejects.toBeInstanceOf(CommonError);
        await expect(work).rejects.toMatchObject({ code: "drop", message: `CG_RegisterItemVisuals: itemNum ${number} out of range [0-${items.length - 1}]` });
        expect(invalid.items).toEqual(items);
      }
      const invalid = new ClientWeaponMediaRegistry(product, resources, bank);
      const missing = invalid.registerWeapon(15);
      await expect(missing).rejects.toBeInstanceOf(CommonError);
      await expect(missing).rejects.toMatchObject({ code: "drop", message: "Couldn't find weapon 15" });
      expect(() => invalid.weapon(16)).toThrow(RangeError);
    }
  });
  for (const product of products) {
    test(`${product} all retail weapon and item records share renderer-owned resources`, async () => {
      const { resources, registry, registrations } = await fixture(product);
      const items = itemList(product);
      await Promise.all(items.map((_, index) => registry.registerItemVisuals(index)));
      for (const item of items) {
        if (item.type !== ItemType.IT_WEAPON) continue;
        const weapon = registry.weapon(item.tag);
        expect(weapon.item).toBe(item);
        const path = item.worldModels[0];
        if (path === null) throw new Error("Retail weapon requires model");
        expect(weapon.weaponModel).toBe(await resources.registerModel(path));
        expect(weapon.handsModel.kind).toBe("md3");
        expect(weapon.weaponIcon).toBe(weapon.ammoIcon);
      }
      const before = registrations.length;
      await Promise.all([registry.registerWeapon(Weapon.WP_MACHINEGUN), registry.registerWeapon(Weapon.WP_MACHINEGUN)]);
      expect(registrations.length).toBe(before);
      const rocket = registry.weapon(Weapon.WP_ROCKET_LAUNCHER);
      expect([rocket.missileDlight, rocket.trailTime, rocket.trailRadius, rocket.missileTrail]).toEqual([200, 2000, 64, "rocket"]);
      expect(registry.weapon(Weapon.WP_SHOTGUN).barrelModel).toBeNull();
      expect(registry.weapon(Weapon.WP_MACHINEGUN).flashSounds.every(sound => sound !== null)).toBe(true);
      expect(registry.weapon(Weapon.WP_GRAPPLING_HOOK).flashSounds).toEqual([null, null, null, null]);
      if (product === "missionpack") {
        expect(registry.weapon(Weapon.WP_CHAINGUN).loopFireSound).toBe(true);
        expect(registry.weapon(Weapon.WP_NAILGUN).missileSound).toBeNull();
        expect(registry.weapon(Weapon.WP_NAILGUN).trailTime).toBe(250);
      }
    });
    test(`${product} selection preserves follow, empty ammo and gauntlet source distinctions`, async () => {
      const { state, runtime } = await fixture(product);
      const snap = state.snap;
      if (snap === null) throw new Error("Missing test snapshot");
      const ps = snap.playerState;
      ps.stats.set(statSchema(product).weapons, (1 << Weapon.WP_GAUNTLET) | (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_ROCKET_LAUNCHER));
      ps.ammo.set(Weapon.WP_GAUNTLET, -1); ps.ammo.set(Weapon.WP_MACHINEGUN, 10); ps.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 0);
      state.weaponSelect = Weapon.WP_MACHINEGUN;
      runtime.nextWeapon(); expect(state.weaponSelect).toBe(Weapon.WP_MACHINEGUN);
      runtime.previousWeapon(); expect(state.weaponSelect).toBe(Weapon.WP_MACHINEGUN);
      runtime.selectWeapon(Weapon.WP_ROCKET_LAUNCHER); expect(state.weaponSelect).toBe(Weapon.WP_ROCKET_LAUNCHER);
      runtime.outOfAmmoChange(); expect(state.weaponSelect).toBe(Weapon.WP_MACHINEGUN);
      ps.ammo.set(Weapon.WP_MACHINEGUN, 0); runtime.outOfAmmoChange(); expect(state.weaponSelect).toBe(Weapon.WP_GAUNTLET);
      ps.pmFlags |= MoveFlags.FOLLOW; state.time = 2000;
      runtime.selectWeapon(Weapon.WP_MACHINEGUN); runtime.nextWeapon(); runtime.previousWeapon();
      expect(state.weaponSelect).toBe(Weapon.WP_GAUNTLET); expect(state.weaponSelectTime).toBe(1000);
      state.snap = null; runtime.nextWeapon(); runtime.previousWeapon(); runtime.selectWeapon(Weapon.WP_MACHINEGUN);
      expect(state.weaponSelectTime).toBe(1000);
    });
  }
  test("source invalid weapon and item registrations reject instead of silently creating media", async () => {
    const { registry } = await fixture("baseq3");
    expect(() => registry.requireWeapon(Weapon.WP_MACHINEGUN)).toThrow("finish registration");
    await registry.registerWeapon(Weapon.WP_NONE);
    expect(registry.weapon(0).item).toBeNull();
    await expect(registry.registerWeapon(Weapon.WP_NAILGUN)).rejects.toThrow("Couldn't find weapon");
    const other = await fixture("baseq3");
    await expect(other.registry.registerItemVisuals(-1)).rejects.toThrow();
  });
});

const zero = vec3(0, 0, 0);
const testSound: PcmSound = { sampleRate: 22050, channels: 1, samples: new Int16Array([12000, -12000, 12000]), frameCount: 3, loopStart: null };
function emptyMap(): BspMap {
  const bounds = { min: vec3(-10000, -10000, -10000), max: vec3(10000, 10000, 10000) };
  return { entities: "", entityRecords: [], shaders: [], planes: [{ normal: vec3(1, 0, 0), distance: 0 }], nodes: [{ plane: 0, children: [-1, -1], bounds }],
    leaves: [{ cluster: 0, area: 0, bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }], leafSurfaces: [], leafBrushes: [], models: [{ bounds, firstSurface: 0, surfaceCount: 0, firstBrush: 0, brushCount: 0 }],
    brushes: [], brushSides: [], vertices: [], indices: [], fogs: [], surfaces: [], lightmaps: [], lightGrid: [], visibility: null };
}
function unavailable(): never { throw new Error("Unexpected service outside this weapon fixture"); }
class ObservedPrediction extends PredictionRuntime {
  readonly endpoints: Vec3[] = [];
  water = false;
  noImpact = false;
  override pointContents(point: Vec3, skip: number): number { return this.water ? 32 : super.pointContents(point, skip); }
  override trace(start: Vec3, end: Vec3, bounds: Bounds, skip: number, mask: number): MovementTrace {
    this.endpoints.push({ ...end }); const result = super.trace(start, end, bounds, skip, mask);
    return this.noImpact ? { ...result, surfaceFlags: result.surfaceFlags | 16 } : result;
  }
}
async function runtimeFixture(product: Product = "baseq3", missingHands = false, retailWorld = false) {
  const base = await fixture(product, missingHands, retailWorld && process.env["QUAKE_GL_TEST"] === "1"), { state, resources, registry } = base;
  await Promise.all(itemList(product).filter(item => item.type === ItemType.IT_WEAPON).map(item => registry.registerWeapon(item.tag)));
  const settings: { -readonly [K in keyof WeaponPresentationSettings]: WeaponPresentationSettings[K] } = {
    brassTime: 2500, railTrailTime: 400, oldRail: false, noProjectileTrail: false, oldPlasma: false, oldRocket: true, trueLightning: 0,
    drawGun: true, fov: 90, gunX: 0, gunY: 0, gunZ: 0, gunFrame: 1, tracerLength: 160, tracerWidth: 1, tracerChance: 1, hardware: "generic",
  };
  const world = retailWorld ? await resources.loadWorld("q3dm1") : null;
  const random = new GameRandom(1), audio = new AudioMixer(22050, () => 0), map = world === null ? emptyMap() : parseBsp(await base.assets.read("maps/q3dm1.bsp")), collision = new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" });
  const prediction = new ObservedPrediction(state, collision, { commands: new ClientCommandHistory(), settings: unavailable, setPmoveMsec: unavailable, transitionPlayerState: unavailable, warn: unavailable });
  const media: WeaponPresentationMedia = {
    models: { machinegunBrass: await resources.registerModel("models/weapons2/shells/m_shell.md3"), shotgunBrass: await resources.registerModel("models/weapons2/shells/s_shell.md3"),
      dishFlash: await resources.registerModel("models/weaphits/boom01.md3"), ringFlash: await resources.registerModel("models/weaphits/ring02.md3"), bulletFlash: await resources.registerModel("models/weaphits/bullet.md3") },
    shaders: { smokePuff: await resources.registerShader("smokePuff"), nailPuff: await resources.registerShader("nailPuff"), shotgunSmokePuff: await resources.registerShader("shotgunSmokePuff"),
      invis: await resources.registerShader("invis"), battleWeapon: await resources.registerShader("battleSuitWeapon"), quadWeapon: await resources.registerShader("quadWeapon"),
      select: await resources.registerShader("gfx/2d/select"), noammo: await resources.registerShader("icons/noammo"), holeMark: await resources.registerShader("gfx/damage/hole_lg_mrk"),
      burnMark: await resources.registerShader("gfx/damage/burn_med_mrk"), energyMark: await resources.registerShader("gfx/damage/plasma_mrk"), bulletMark: await resources.registerShader("gfx/damage/bullet_mrk"), tracer: await resources.registerShader("gfx/misc/tracer") },
    sounds: { quad: testSound, nailHitFlesh: { ...testSound }, nailHitMetal: { ...testSound }, nailHit: { ...testSound }, proxExplosion: { ...testSound },
      rocketExplosion: { ...testSound }, plasmaExplosion: { ...testSound }, chaingunHitFlesh: { ...testSound }, chaingunHitMetal: { ...testSound }, chaingunHit: { ...testSound },
      ricochet1: { ...testSound }, ricochet2: { ...testSound }, ricochet3: { ...testSound }, tracer: { ...testSound } },
  };
  const marks = new ImpactMarkSystem(new BspMarkProjector(world === null ? { map, surfaces: [] } : world.markGeometry), { clock: () => state.time, enabled: () => true, energyShader: () => media.shaders.energyMark });
  const localMedia: LocalEntityMedia = { bloodTrailShader: { name: "bloodTrail" }, bloodMarkShader: { name: "bloodMark" }, burnMarkShader: { name: "burnMark" },
    gibBounceSounds: [testSound, testSound, testSound], numberShaders: [{ name: "0" }, { name: "1" }, { name: "2" }, { name: "3" }, { name: "4" }, { name: "5" }, { name: "6" }, { name: "7" }, { name: "8" }, { name: "9" }, { name: "minus" }] };
  const localAudio: LocalEntityHost["audio"] = { startSound(pcm, options) {
    if (pcm === null) throw new Error("Fixture media unexpectedly returned source sound handle zero");
    audio.startSound(pcm, options);
  } };
  const services = { prediction, collision, audio: localAudio, clientNum: 0, random, marks };
  const localHost: LocalEntityHost = product === "baseq3" ? { ...services, product, media: localMedia }
    : { ...services, product, media: { ...localMedia, kamikazeShockWave: DEFAULT_MODEL, kamikazeExplodeSound: testSound, kamikazeImplodeSound: testSound } };
  const pool = new LocalEntityPool(product);
  const effectMedia: EffectMedia = { waterBubbleShader: await resources.registerShader("waterBubble"), smokePuffRageProShader: await resources.registerShader("smokePuffRagePro"), bloodExplosionShader: await resources.registerShader("bloodExplosion"),
    teleportEffectModel: DEFAULT_MODEL, gibSkull: DEFAULT_MODEL, gibBrain: DEFAULT_MODEL, gibAbdomen: DEFAULT_MODEL, gibArm: DEFAULT_MODEL, gibChest: DEFAULT_MODEL,
    gibFist: DEFAULT_MODEL, gibFoot: DEFAULT_MODEL, gibForearm: DEFAULT_MODEL, gibIntestine: DEFAULT_MODEL, gibLeg: DEFAULT_MODEL, smoke2: DEFAULT_MODEL,
    variant: product === "baseq3" ? { product, teleportEffectShader: null } : { product, media: { lightningShader: registry.effects.lightningShader, kamikazeEffectModel: DEFAULT_MODEL,
      dishFlashModel: media.models.dishFlash, rocketExplosionShader: registry.effects.rocketExplosionShader, obeliskHitSounds: [testSound, testSound, testSound],
      invulnerabilityImpactModel: DEFAULT_MODEL, invulnerabilityImpactSounds: [testSound, testSound, testSound], invulnerabilityJuicedModel: DEFAULT_MODEL, invulnerabilityJuicedSound: testSound } },
  };
  const sounds: { readonly channel: number; readonly sound: PcmSound | null }[] = [], refs: RefEntity[] = [], polys: RefPoly[] = [], lights: number[] = [], drawCalls: string[] = [];
  const startSound: ClientWeaponHost["startSound"] = (origin, entity, channel, sound) => {
    sounds.push({ channel, sound });
    if (sound !== null) audio.startSound(sound, { entity, channel, volume: 127, origin: origin === null ? { kind: "entity", entity } : { kind: "fixed", position: origin } });
  };
  const effects = new ClientEffects(state, pool, effectMedia, { noProjectileTrail: false, blood: true, gibs: true, scorePlum: true, hardware: "generic" }, { randomInteger: () => random.rand(), startSound });
  const locals = new LocalEntitySystem(effects, localHost);
  const particles = new ParticleSystem(state, { animations: await loadParticleAnimations(resources), media: { tracerShader: { name: "tracer" }, smokePuffShader: { name: "smokePuff" }, waterBubbleShader: { name: "waterBubble" } }, prediction, random, hardwareType: "generic", configString: unavailable, print: unavailable });
  const ci = new ClientInfo(); ci.color1 = vec3(0.2, 0.4, 0.8); ci.color2 = vec3(0.1, 0.3, 0.9);
  const windSound = { ...testSound };
  const host: ClientWeaponHost = { prediction, random, localEntities: pool, effects, particles, marks, media, settings: () => settings, clientInfo: () => ci,
    sound: (path, compressed) => { expect(path).toBe("sound/weapons/vulcan/wvulwind.wav"); expect(compressed).toBe(false); return windSound; },
    startSound, addLoopSound: (_entity, _origin, _velocity, sound) => { sounds.push({ channel: -1, sound }); },
    addRefEntity: ref => refs.push(copyRefEntity(ref)), addPoly: poly => polys.push(copyRefPoly(poly)), addLight: light => lights.push(light.radius),
    drawing: { fadeColor: () => vec4(1, 1, 1, 1), setColor: color => drawCalls.push(color === null ? "clear" : "color"), drawPic: (x, y, w, h, shader) => drawCalls.push(`${x},${y},${w},${h}:${shader?.name}`),
      drawStringLength: text => text.length, drawBigStringColor: (x, y, text) => drawCalls.push(`${x},${y}:${text}`) },
  };
  return { ...base, world, marks, settings, random, audio, prediction, media, pool, locals, effects, particles, ci, sounds, windSound, refs, polys, lights, drawCalls, runtime: new ClientWeaponRuntime(state, registry, host) };
}
function bits(vector: Vec3): number[] { return [float32ToBits(vector.x) | 0, float32ToBits(vector.y) | 0, float32ToBits(vector.z) | 0]; }

describe("actual cg_weapons QVM constructor and event fixtures", () => {
  test("source firing bounds drop before flash and sound writes for both products", async () => {
    for (const product of products) {
      const f = await runtimeFixture(product), cent = f.state.entityAt(0);
      cent.muzzleFlashTime = 37;
      cent.currentState.weapon = Weapon.WP_NONE;
      f.runtime.fireWeapon(cent);
      expect(cent.muzzleFlashTime).toBe(37);
      cent.currentState.weapon = product === "baseq3" ? 11 : 14;
      let failure: unknown;
      try { f.runtime.fireWeapon(cent); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CommonError);
      expect(failure).toMatchObject({ code: "drop", message: "CG_FireWeapon: ent->weapon >= WP_NUM_WEAPONS" });
      expect(cent.muzzleFlashTime).toBe(37);
      expect(f.sounds).toHaveLength(0);
      expect(f.pool.activeCount).toBe(0);
      cent.currentState.weapon = -1;
      expect(() => f.runtime.fireWeapon(cent)).toThrow(RangeError);
    }
  });
  // Untouched cg_weapons.c + cg_effects.c, q3lcc bytecode, original vm_game 1 interpreter.
  // Fixture /tmp/quake3-cg-weapons-reference-EJwrco, seed1, time1000, angles17/33/11.
  test("machinegun dry/water brass and shotgun shells preserve RNG ordering and QVM fields", async () => {
    const f = await runtimeFixture(), cent = f.state.entityAt(0);
    cent.lerpOrigin = vec3(1.8, -2.8, 3.8); cent.lerpAngles = vec3(17, 33, 11);
    cent.currentState.weapon = Weapon.WP_MACHINEGUN;
    const expected = [[1117120246, -1030349083, 1116718814], [1089460208, -1058000529, 1088817917]];
    for (let i = 0; i < 2; i++) {
      f.pool.initialize(); f.random.reset(1); f.prediction.water = i === 1; f.runtime.fireWeapon(cent);
      const le = f.pool.activeEntities()[0]; if (le === undefined) throw new Error("Missing brass");
      expect([le.startTime, le.endTime, le.pos.time, le.leFlags]).toEqual([1000, 3550, 990, 2]);
      expect(bits(le.pos.base)).toEqual([1100186108, -1073167194, 1102714385]);
      const delta = expected[i]; if (delta === undefined) throw new Error("Missing brass reference");
      expect(bits(le.pos.delta)).toEqual(delta); expect(bits(le.angles.base)).toEqual([1100480512, 1103101952, 1103626240]);
      expect(le.leBounceSoundType).toBe("brass");
    }
    f.pool.initialize(); f.random.reset(1); f.prediction.water = false; cent.currentState.weapon = Weapon.WP_SHOTGUN; f.runtime.fireWeapon(cent);
    const shells = [...f.pool.activeEntities()].reverse();
    expect(shells.map(le => le.endTime)).toEqual([8606, 9092]);
    expect(shells.map(le => bits(le.pos.delta))).toEqual([[1082369208, 1108022960, 1114771424], [1124836588, 1098957499, 1118435938]]);
  });
  test("plasma constructor keeps source zero lifetime rate and does not advance trailTime", async () => {
    const f = await runtimeFixture(), cent = f.state.entityAt(0);
    cent.lerpAngles = vec3(17, 33, 11); cent.currentState.weapon = Weapon.WP_PLASMAGUN;
    cent.currentState.pos = { type: TrajectoryType.TR_LINEAR, time: 900, duration: 0, base: vec3(1, 2, 3), delta: vec3(40, -70, 90) };
    f.runtime.missileTrail("plasma", cent, f.registry.weapon(Weapon.WP_PLASMAGUN));
    const le = f.pool.activeEntities()[0]; if (le === undefined) throw new Error("Missing plasma");
    expect(bits(le.pos.base)).toEqual([1086990790, -1072657783, 1096451536]);
    expect(bits(le.pos.delta)).toEqual([1121815789, 1127350902, 1119599456]);
    expect(bits(le.angles.base)).toEqual([1105723392, 1104150528, 1100480512]);
    expect(bits(le.color)).toEqual([1039516304, 1039516304, 1045220557]);
    expect(le.lifeRate).toBe(0); expect(cent.trailTime).toBe(0);
    f.settings.oldPlasma = true; f.runtime.missileTrail("plasma", cent, f.registry.weapon(Weapon.WP_PLASMAGUN)); expect(f.pool.activeCount).toBe(1);
  });
  test("rail spiral matches all original QVM positions and preserves mutable source start", async () => {
    const f = await runtimeFixture(), start = { x: 1, y: 2, z: 3 };
    f.runtime.railTrail(0, start, vec3(50, 30, 20)); expect(start.z).toBe(-1);
    const records = [...f.pool.activeEntities()].reverse();
    expect(records.map(le => le.endTime)).toEqual([1400, 1600, 1605, 1610, 1615, 1620, 1625, 1630]);
    expect(records.slice(1).map(le => bits(le.pos.base))).toEqual([
      [1100210946, 1094704863, 1074689672], [1104083094, 1099845025, 1086197855], [1107611224, 1102767554, 1092697889],
      [1109543771, 1105515387, 1097400538], [1111511513, 1107673698, 1100623952], [1113534399, 1108829633, 1103134979], [1115625730, 1109881225, 1105604837],
    ]);
    const core = records[0]; if (core === undefined) throw new Error("Missing core");
    expect(core.refEntity.kind).toBe("rail-core"); expect(core.color).toEqual(vec4(0.15, 0.3, 0.6, 1));
    f.pool.initialize(); f.settings.oldRail = true; const oldStart = { x: 1, y: 2, z: 3 }; f.runtime.railTrail(0, oldStart, vec3(50, 30, 20));
    expect(f.pool.activeCount).toBe(1); expect(f.pool.activeEntities()[0]?.refEntity.origin.z).toBe(-9); expect(oldStart.z).toBe(-1);
  });
  test("shotgun eleven traces and tracer quad match untouched QVM exact nonaxis endpoints", async () => {
    const f = await runtimeFixture(), es = new EntityState();
    es.pos = { ...es.pos, base: vec3(1.8, -2.8, 3.8) }; es.origin2 = vec3(12.7, 31.1, -4.3); es.eventParm = 1;
    f.prediction.noImpact = true; f.runtime.shotgunFire(es);
    expect(f.prediction.endpoints.map(bits)).toEqual([
      [1195336326,1206421229,-959485360], [1192859757,1206991397,-961351384], [1195674402,1206339409,-959115279],
      [1194630990,1206609082,-960753562], [1194170590,1206794564,-963400020], [1193321001,1206964564,-963299688],
      [1193237218,1207066813,-966835762], [1193298515,1206889355,-960991025], [1194165848,1206960030,-971628062],
      [1192777932,1207159689,-966783687], [1196852026,1206464822,-976340512],
    ]);
    f.random.reset(1); f.state.refdef.viewAxis = qvmAnglesToAxis(vec3(17, 33, 11)); f.runtime.tracer(es.pos.base, vec3(512, 128, 64));
    expect(f.polys[0]?.vertices.map(vertex => bits(vertex.position))).toEqual([
      [1132228794,1115231927,1107824239], [1132263348,1114839803,1107504843], [1120270080,1101685934,1097467466], [1120200972,1102470182,1098745048],
    ]);
  });
  test("rocket trail tick alignment, stationary suppression and water bubbles use actual pool", async () => {
    const f = await runtimeFixture(), cent = f.state.entityAt(0), weapon = f.registry.weapon(Weapon.WP_ROCKET_LAUNCHER);
    cent.trailTime = 875; cent.currentState.pos = { type: TrajectoryType.TR_LINEAR, time: 0, duration: 0, base: zero, delta: vec3(100, 0, 0) };
    f.runtime.missileTrail("rocket", cent, weapon);
    expect([...f.pool.activeEntities()].reverse().map(le => [le.startTime, le.endTime, le.leType])).toEqual([[900, 2900, "scale-fade"], [950, 2950, "scale-fade"], [1000, 3000, "scale-fade"]]);
    expect(cent.trailTime).toBe(1000);
    f.pool.initialize(); cent.currentState.pos = { ...cent.currentState.pos, type: TrajectoryType.TR_STATIONARY }; f.state.time = 1100;
    f.runtime.missileTrail("grenade", cent, weapon); expect(cent.trailTime).toBe(1100); expect(f.pool.activeCount).toBe(0);
    cent.currentState.pos = { ...cent.currentState.pos, type: TrajectoryType.TR_LINEAR }; f.prediction.water = true; f.state.time = 1300;
    f.runtime.missileTrail("rocket", cent, weapon); expect(f.pool.activeCount).toBeGreaterThan(0);
    expect(f.pool.activeEntities().every(le => le.leType === "move-scale-fade")).toBe(true);
    f.settings.noProjectileTrail = true; f.state.time = 1400; f.runtime.missileTrail("rocket", cent, weapon); expect(cent.trailTime).toBe(1300);
  });
  test("continuous lightning suppresses sound but updates flash; world and view effects are not doubled", async () => {
    const f = await runtimeFixture(), cent = f.state.entityAt(0); cent.currentState.weapon = Weapon.WP_LIGHTNING; cent.currentState.powerups = 1 << Powerup.PW_QUAD;
    cent.player.lightningFiring = 1; f.runtime.fireWeapon(cent); expect(cent.muzzleFlashTime).toBe(1000); expect(f.sounds.length).toBe(0);
    cent.player.lightningFiring = 0; f.runtime.fireWeapon(cent); expect(f.sounds.map(s => s.channel)).toEqual([4, 2]);
    cent.currentState.eFlags = 256;
    const parent = createModelEntity(f.registry.weapon(Weapon.WP_LIGHTNING).handsModel); parent.axis = qvmAnglesToAxis(zero);
    f.runtime.addPlayerWeapon(parent, null, cent, Team.TEAM_FREE); expect(f.lights.length).toBe(0); expect(cent.player.lightningFiring).toBe(1);
    f.runtime.addPlayerWeapon(parent, f.state.predictedPlayerState, cent, Team.TEAM_FREE); expect(f.lights.length).toBe(1);
    expect(f.refs.filter(ref => ref.kind === "lightning").length).toBe(1);
  });
  test("mission chaingun impact preserves source ricochet override, zero shader and real explosion", async () => {
    const f = await runtimeFixture("missionpack");
    f.runtime.missileHitWall(Weapon.WP_CHAINGUN, 0, zero, vec3(0, 0, 1), ImpactSound.FLESH);
    expect(f.sounds[0]?.sound).toBe(f.media.sounds.ricochet2);
    const le = f.pool.activeEntities()[0]; if (le === undefined || le.refEntity.kind === "portal-surface") throw new Error("Missing explosion"); expect(le.refEntity.customShader).toBeNull();
    f.pool.initialize(); f.settings.oldRocket = false; f.runtime.missileHitWall(Weapon.WP_ROCKET_LAUNCHER, 0, zero, vec3(0, 0, 1), ImpactSound.DEFAULT);
    expect(f.particles.activeCount).toBe(1); expect(f.pool.activeEntities()[0]?.light).toBe(300);
  });
  test("base game routes mission-only impact weapon numbers through its lightning default", async () => {
    for (const weapon of [Weapon.WP_NAILGUN, Weapon.WP_PROX_LAUNCHER, Weapon.WP_CHAINGUN]) {
      const f = await runtimeFixture("baseq3"), expected = new GameRandom(1);
      const choice = expected.rand() & 3;
      expected.random();
      f.runtime.missileHitWall(weapon, 0, zero, vec3(0, 0, 1), ImpactSound.FLESH);
      expect(f.pool.activeCount).toBe(0);
      expect(f.sounds).toEqual([{ channel: 0, sound: f.registry.effects.lightningHitSounds[choice < 2 ? 1 : choice === 2 ? 0 : 2] }]);
      expect(f.random.rand()).toBe(expected.rand());
    }
  });
  test("view bob and landing match QVM and missing hand tags retain renderer identity fallback", async () => {
    const f = await runtimeFixture("baseq3", true), state = f.state;
    state.xyspeed = Math.fround(113.37); state.bobCycle = 1; state.bobFracSin = Math.fround(0.77); state.landTime = 925; state.landChange = Math.fround(-11.7);
    state.refdef.viewOrigin = vec3(1, 2, 30); state.refdefViewAngles = vec3(17, 33, 11); state.refdef.viewAxis = qvmAnglesToAxis(state.refdefViewAngles);
    state.predictedPlayerState.weapon = Weapon.WP_MACHINEGUN; state.predictedPlayerEntity.currentState.weapon = Weapon.WP_MACHINEGUN;
    f.runtime.addViewWeapon(state.predictedPlayerState);
    const gun = f.refs[0]; if (gun === undefined || gun.kind !== "model") throw new Error("Missing view model");
    expect(bits(gun.origin)).toEqual([1065353216, 1073741824, 1105480909]);
    const angles = vec3(bitsToFloat32(1100337401), bitsToFloat32(1107667876), bitsToFloat32(1094560345));
    expect(gun.axis.map(bits)).toEqual(qvmAnglesToAxis(angles).map(bits));
    expect(gun.renderFlags).toBe(13);
    state.renderingThirdPerson = true; const count = f.refs.length; f.runtime.addViewWeapon(state.predictedPlayerState); expect(f.refs.length).toBe(count);
  });
  test("barrel spin and coast source transition fields match original QVM", async () => {
    const f = await runtimeFixture(), cent = f.state.entityAt(0);
    cent.currentState.weapon = Weapon.WP_MACHINEGUN;
    const parent = createModelEntity(), expected = [[1138819072,1119092736,1148846080], [1143757209,1119092736,1148846080], [1151408537,1129368464,1158791168], [1142615526,1129368464,1158791168]];
    parent.axis = qvmAnglesToAxis(zero);
    for (let i = 0; i < 4; i++) {
      f.refs.length = 0; f.state.time = 1000 + i * 666; cent.currentState.eFlags = i < 2 ? 256 : 0;
      f.runtime.addPlayerWeapon(parent, null, cent, Team.TEAM_FREE);
      const golden = expected[i]; if (golden === undefined) throw new Error("Missing spin reference");
      expect([float32ToBits(cent.player.barrelAngle), float32ToBits(cent.player.barrelTime)]).toEqual(golden.slice(1));
      const barrel = f.refs[1]; if (barrel === undefined || barrel.kind !== "model") throw new Error("Missing barrel");
      const angleBits = golden[0]; if (angleBits === undefined) throw new Error("Missing angle bits");
      const gun = f.refs[0]; if (gun === undefined || gun.kind !== "model") throw new Error("Missing gun");
      const expectedBarrel = createModelEntity(barrel.model); expectedBarrel.axis = qvmAnglesToAxis(vec3(0, 0, bitsToFloat32(angleBits)));
      positionRotatedEntityOnTag(expectedBarrel, gun, gun.model, "tag_barrel");
      expect(barrel.axis.map(bits)).toEqual(expectedBarrel.axis.map(bits));
    }
  });
  test("barrel transition uses QVM AngleMod multiplication before CVFI", async () => {
    const f = await runtimeFixture(), cent = f.state.entityAt(0);
    cent.currentState.weapon = Weapon.WP_MACHINEGUN; cent.currentState.eFlags = 0;
    cent.player.barrelTime = 1000; cent.player.barrelAngle = bitsToFloat32(1127974903); cent.player.barrelSpinning = true;
    const parent = createModelEntity(); parent.axis = qvmAnglesToAxis(zero);
    f.runtime.addPlayerWeapon(parent, null, cent, Team.TEAM_FREE);
    expect(float32ToBits(cent.player.barrelAngle)).toBe(1127974904);
  });
  test("all explosion families preserve sprite/model choice, duration and light", async () => {
    const f = await runtimeFixture("missionpack");
    const cases: readonly (readonly [Weapon, LocalEntity["leType"], number, number])[] = [
      [Weapon.WP_GRENADE_LAUNCHER, "sprite-explosion", 600, 300], [Weapon.WP_ROCKET_LAUNCHER, "sprite-explosion", 1000, 300],
      [Weapon.WP_PROX_LAUNCHER, "sprite-explosion", 600, 300], [Weapon.WP_BFG, "sprite-explosion", 600, 0],
      [Weapon.WP_RAILGUN, "explosion", 600, 0], [Weapon.WP_PLASMAGUN, "explosion", 600, 0],
      [Weapon.WP_MACHINEGUN, "explosion", 600, 0], [Weapon.WP_SHOTGUN, "explosion", 600, 0],
    ];
    for (const [weapon, type, duration, light] of cases) {
      f.pool.initialize(); f.runtime.missileHitWall(weapon, 0, zero, vec3(0, 0, 1), ImpactSound.DEFAULT);
      const le = f.pool.activeEntities()[0]; if (le === undefined) throw new Error("Missing explosion");
      expect([le.leType, le.endTime - le.startTime, le.light]).toEqual([type, duration, light]);
      if (weapon === Weapon.WP_RAILGUN) expect(le.color).toEqual(vec4(0.2, 0.4, 0.8, 0));
    }
    f.pool.initialize(); f.runtime.missileHitPlayer(Weapon.WP_PLASMAGUN, zero, vec3(0, 0, 1), 0); expect(f.pool.activeCount).toBe(1);
    f.pool.initialize(); f.runtime.missileHitPlayer(Weapon.WP_ROCKET_LAUNCHER, zero, vec3(0, 0, 1), 0); expect(f.pool.activeCount).toBe(2);
  });
  test("mission nail smoke, chaingun wind-down and grapple distance guards reach real services", async () => {
    const f = await runtimeFixture("missionpack"), cent = f.state.entityAt(0);
    cent.currentState.weapon = Weapon.WP_NAILGUN; f.runtime.fireWeapon(cent);
    expect(f.pool.activeEntities()[0]?.leType).toBe("scale-fade");
    expect(f.pool.activeEntities()[0]?.endTime).toBe(1700);
    f.settings.brassTime = 0; f.runtime.fireWeapon(cent); expect(f.pool.activeCount).toBe(1);
    cent.currentState.weapon = Weapon.WP_CHAINGUN; cent.currentState.eFlags = 256;
    const parent = createModelEntity(); parent.axis = qvmAnglesToAxis(zero); f.runtime.addPlayerWeapon(parent, null, cent, Team.TEAM_FREE);
    cent.currentState.eFlags = 0; f.state.time = 1010; f.runtime.addPlayerWeapon(parent, null, cent, Team.TEAM_FREE);
    expect(f.sounds.at(-1)?.sound).toBe(f.windSound);
    const hook = f.state.entityAt(70); hook.currentState.otherEntityNum = 0;
    hook.currentState.pos = { ...hook.currentState.pos, base: vec3(0, 0, 30) }; f.refs.length = 0;
    f.runtime.grappleTrail(hook, f.registry.weapon(Weapon.WP_GRAPPLING_HOOK)); expect(f.refs.length).toBe(0); expect(hook.trailTime).toBe(1010);
    hook.currentState.pos = { ...hook.currentState.pos, base: vec3(100, 0, 20) };
    f.registry.effects.lightningShader = await f.resources.registerShader("missing/weapon-lightning-shader");
    f.runtime.grappleTrail(hook, f.registry.weapon(Weapon.WP_GRAPPLING_HOOK)); expect(f.refs[0]?.kind).toBe("lightning"); expect(f.refs[0]?.origin).toEqual(vec3(0, 0, 20));
    const beam = f.refs[0];
    if (beam === undefined || beam.kind !== "lightning") throw new Error("Missing source grapple submission");
    expect(beam.customShader).toBeNull();
  });
  test("weapon selection HUD dispatch preserves icon-marker-cross ordering and pickup clearing", async () => {
    const f = await runtimeFixture(), snap = f.state.snap; if (snap === null) throw new Error("Missing snapshot");
    f.state.predictedPlayerState.health = 100; f.state.weaponSelect = Weapon.WP_MACHINEGUN; f.state.weaponSelectTime = 950; f.state.itemPickupTime = 123;
    snap.playerState.stats.set(statSchema("baseq3").weapons, (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_ROCKET_LAUNCHER));
    snap.playerState.ammo.set(Weapon.WP_MACHINEGUN, 10); snap.playerState.ammo.set(Weapon.WP_ROCKET_LAUNCHER, 0);
    f.runtime.drawWeaponSelect(); expect(f.state.itemPickupTime).toBe(0);
    expect(f.drawCalls).toEqual(["color", "280,380,32,32:icons/iconw_machinegun", "276,376,40,40:gfx/2d/select", "320,380,32,32:icons/iconw_rocket", "320,380,32,32:icons/noammo", "240,358:Machinegun", "clear"]);
    f.state.predictedPlayerState.health = 0; f.runtime.drawWeaponSelect(); expect(f.drawCalls.length).toBe(7);
  });
});

for (const product of products) test(`${product} retail view weapon and real BSP shotgun effects submit to both backends`, async () => {
  const f = await runtimeFixture(product, false, true), world = f.world;
  if (world === null) throw new Error("Missing retail world");
  const camera = world.initialCamera(), state = f.state;
  state.refdef.viewOrigin = camera.origin; state.refdefViewAngles = camera.angles; state.refdef.viewAxis = qvmAnglesToAxis(camera.angles);
  state.predictedPlayerState.weapon = Weapon.WP_MACHINEGUN; state.predictedPlayerEntity.currentState.weapon = Weapon.WP_MACHINEGUN;
  state.predictedPlayerEntity.muzzleFlashTime = 1000;
  f.runtime.addViewWeapon(state.predictedPlayerState);
  expect(f.refs.some(ref => ref.kind === "model" && ref.model.path.includes("machinegun.md3"))).toBe(true);
  const shotgun = new EntityState(); shotgun.pos = { ...shotgun.pos, base: camera.origin }; shotgun.origin2 = state.refdef.viewAxis[0]; shotgun.eventParm = 17;
  f.runtime.shotgunFire(shotgun); expect(f.prediction.endpoints.length).toBe(11); expect(f.pool.activeCount).toBeGreaterThan(0);
  const local = f.locals.collectEntities({ time: 1016, frameTime: 16, viewOrigin: camera.origin });
  const refdef = createRefdef();
  refdef.width = 160; refdef.height = 120; refdef.fovX = 90; refdef.fovY = Math.atan(120 / 160) * 360 / Math.PI;
  refdef.viewOrigin = camera.origin; refdef.viewAxis = qvmAnglesToAxis(camera.angles); refdef.time = 1016;
  const frame = { refdef }, { cpu, gl, commands, recording } = f;
  commands.addView({ viewport: { x: 0, y: 0, width: 160, height: 120 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
  commands.addPreparedViews(world.prepareFrame(frame));
  commands.submit();
  const withoutWeapon = cpu.pixels.slice();
  f.resources.tess.endFrame();
  const firstViewCount = recording.trace().length;
  commands.addView({ viewport: { x: 0, y: 0, width: 160, height: 120 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
  commands.addPreparedViews(world.prepareFrame({ ...frame, entities: [...f.refs, ...local.entities], dynamicLights: local.dynamicLights, polys: f.marks.addMarks() }));
  commands.submit();
  expect(recording.trace().slice(firstViewCount).flatMap(view => view.batches).length).toBeGreaterThan(0);
  expect(cpu.pixels.some((value, index) => value !== withoutWeapon[index])).toBe(true);
  if (gl !== null) {
    const pixels = gl.readPixels(); let error = 0;
    for (const [index, value] of pixels.entries()) { const expected = cpu.pixels[index]; if (expected === undefined) throw new Error("Missing CPU pixel"); error += Math.abs(value - expected); }
    expect(error / pixels.length).toBeLessThan(1);
  }
});
