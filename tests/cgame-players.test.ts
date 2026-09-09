import { HunkArena } from "../src/core/hunk.ts";
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { parsePlayerAnimationConfig } from "../src/assets/animation.ts";
import { decodeWav } from "../src/assets/wav.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { ClientEffects } from "../src/cgame/effects.ts";
import { LocalEntityPool, LocalEntitySystem } from "../src/cgame/local-entities.ts";
import type { LocalEntityHost, LocalEntityMedia } from "../src/cgame/local-entities.ts";
import { ClientInfoStore, PlayerPresenter } from "../src/cgame/players.ts";
import { ClientInfo } from "../src/cgame/client-info.ts";
import { swingAngles } from "../src/cgame/player-pose.ts";
import { createLerpFrame, runLerpFrame } from "../src/cgame/animation.ts";
import type { ClientInfoSettings, PlayerMedia, MissionPlayerMedia, PlayerPresentationSettings, PlayerPresentationHost } from "../src/cgame/players.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ImpactMarkSystem } from "../src/cgame/marks.ts";
import { BspMarkProjector } from "../src/render/marks.ts";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { copyRefEntity, copyRefPoly, createModelEntity, DEFAULT_MODEL, RF_LIGHTING_ORIGIN, RF_THIRD_PERSON, RF_SHADOW_PLANE } from "../src/render/ref-entity.ts";
import type { RefEntity, RefPoly } from "../src/render/ref-entity.ts";
import type { SceneModel } from "../src/render/ref-entity.ts";
import type { DynamicLight } from "../src/render/lighting.ts";
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
import { EntityType, GameType, Powerup, Team } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { createPlayerState, PlayerAnimation } from "../src/shared/player-state.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
// Original q3lcc/q3asm, untouched cg_players.c/q_math.c/bg_misc.c, vm_game=1
// on linuxq3ded. External fixture supplies identity model tags and captures render traps.
// /tmp/quake3-players-reference-8UjmNM/{fixture.c,build.sh,run.sh}; CG_ACOS cases excluded
// because this game-host VM lacks the cgame-only syscall. These are actual QVM results.
const qvmRows: readonly { readonly name: string; readonly values: readonly number[] }[] = [
  { name: "pose", values: [0, 1, 150, 0, 0, 1067450368, 3223322624, 1103167488, 1065046460, 1042937791, 3183400763, 3190641132, 1065104311, 3169335159, 1035100054, 1026725509, 1065273446, 0, 0, 0, 0, 128, 0] },
  { name: "pose", values: [1, 2, 110, 0, 0, 1067450368, 3223322624, 1103167488, 1064493989, 1050736341, 3170822768, 3197850995, 1064249000, 1044399837, 1035234950, 3190604582, 1065046527, 0, 0, 0, 0, 128, 0] },
  { name: "pose", values: [2, 3, 0, 0, 0, 1067450368, 3223322624, 1103167488, 3200648336, 1063986001, 3181933356, 3210582229, 3200835782, 3198109819, 3198341953, 3175691174, 1064460858, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [0, 1, 150, 0, 0, 1067450368, 3223322624, 1103167488, 1065046460, 1042937791, 3183400763, 3190641132, 1065104311, 3169335159, 1035100054, 1026725509, 1065273446, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [1, 2, 110, 0, 0, 1067450368, 3223322624, 1103167488, 1064493989, 1050736341, 3170822768, 3197850995, 1064249000, 1044399837, 1035234950, 3190604582, 1065046527, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [2, 10, 0, 0, 0, 1101580684, 3231622643, 1110435014, 1039869793, 1065191599, 1032040315, 3212709702, 1039903924, 0, 3154212324, 3179458551, 1065318498, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [3, 11, 0, 0, 0, 1101580684, 3231622643, 1110435014, 1039869793, 1065191599, 1032040315, 1065226054, 3187387572, 2147483648, 3154212324, 3179458551, 1065318498, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [4, 10, 0, 0, 0, 1080904705, 3249719691, 1082710484, 3212675246, 3187353489, 3179523989, 1039903973, 3212709701, 0, 3179458577, 3154212375, 1065318498, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [5, 11, 0, 0, 0, 1080904705, 3249719691, 1082710484, 3212675246, 3187353489, 3179523989, 1039903973, 3212709701, 0, 3179458577, 3154212375, 1065318498, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [6, 10, 0, 0, 0, 3232055596, 3249245282, 1103167488, 3211950647, 1050948643, 0, 3198432291, 3211950647, 0, 0, 0, 1065353216, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [7, 11, 0, 0, 0, 3232055596, 3249245282, 1103167488, 3211950647, 1050948643, 0, 3198432291, 3211950647, 0, 0, 0, 1065353216, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [8, 12, 0, 0, 0, 1067450368, 3223322624, 1103167488, 1064493989, 1050736341, 3170822768, 3197850995, 1064249000, 1044399837, 1035234950, 3190604582, 1065046527, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [9, 13, 110, 0, 0, 1067450368, 3223322624, 1103167488, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 0] },
  { name: "mission", values: [10, 14, 110, 0, 0, 1067450368, 3223322624, 1116749824, 1065353216, 0, 2147483648, 0, 1065353216, 0, 0, 0, 1065353216, 121, 121, 121, 121, 128, 0] },
  { name: "mission", values: [11, 3, 0, 0, 0, 1067450368, 3223322624, 1103167488, 3200648336, 1063986001, 3181933356, 3210582229, 3200835782, 3198109819, 3198341953, 3175691174, 1064460858, 0, 0, 0, 0, 128, 0] },
  { name: "dead", values: [0, 1, 150, 0, 0, 1067450368, 3223322624, 1103167488, 1063859879, 1053635584, 3183952501, 3201197519, 1063929408, 3147591766, 1035103808, 1026717485, 1065273426, 0, 0, 0, 0, 128, 0] },
  { name: "dead", values: [1, 2, 110, 0, 0, 1067450368, 3223322624, 1103167488, 1063924507, 1053704670, 3169093404, 3200839318, 1063729915, 1043448962, 1036178562, 3189205812, 1065091839, 0, 0, 0, 0, 128, 0] },
  { name: "dead", values: [2, 10, 0, 0, 0, 3233272633, 3249137010, 1108906318, 3211777413, 1051922274, 0, 3199405922, 3211777413, 0, 0, 0, 1065353216, 0, 0, 0, 0, 128, 0] },
  { name: "dead", values: [3, 11, 0, 0, 0, 3233272633, 3249137010, 1108906318, 3211777413, 1051922274, 0, 3199405922, 3211777413, 0, 0, 0, 1065353216, 0, 0, 0, 0, 128, 0] },
  { name: "dead", values: [4, 3, 0, 0, 0, 1067450368, 3223322624, 1103167488, 3200694548, 1063948643, 3184169596, 3210612657, 3201074691, 3197625011, 3198117460, 3169868624, 1064511829, 0, 0, 0, 0, 128, 0] },
  { name: "pose_fixed", values: [0, 1, 150, 0, 0, 1067450368, 3223322624, 1103167488, 1064509968, 1050691420, 2147483648, 3198175068, 1064509968, 0, 0, 0, 1065353216, 0, 0, 0, 0, 128, 0] },
  { name: "pose_fixed", values: [1, 2, 110, 0, 0, 1067450368, 3223322624, 1103167488, 1064509968, 1050691420, 0, 3198015488, 1064267895, 1043452116, 1029613611, 3190350050, 1065098332, 0, 0, 0, 0, 128, 0] },
  { name: "pose_fixed", values: [2, 3, 0, 0, 0, 1067450368, 3223322624, 1103167488, 3200450765, 1063942370, 3187785876, 3210346694, 3201121426, 3199007186, 3199758210, 3165266856, 1064223001, 0, 0, 0, 0, 128, 0] },
];
function unavailable(): never { throw new Error("Unexpected fixture service"); }
function at<T>(items: readonly T[], index: number): T { const item = items[index]; if (item === undefined) throw new Error(`Missing fixture ${index}`); return item; }
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface PlayerResources { readonly assets: VirtualFileSystem; readonly resources: RendererResources }
const presentationWorlds = new WeakMap<RendererResources, ReturnType<RendererResources["loadWorld"]>>();
const caches = new Map<Product, Promise<PlayerResources & { readonly target: RenderTarget; readonly cinematics: EngineCinematics; readonly commands: RenderCommandBuffer }>>();
afterAll(async () => {
  for (const pending of caches.values()) {
    const owner = await pending;
    owner.commands.close("discard"); owner.target.close(); owner.cinematics.dispose();
  }
  caches.clear();
});
function retail(product: Product) {
  const cached = caches.get(product); if (cached !== undefined) return cached;
  const next = (async () => {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images), recording = new BatchRecordingBackend(cpu);
    const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1000 };
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    try {
      const settings = createRendererSettings();
      const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
      const commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
      return { assets, images, cpu, recording, target, builtins, mixer, clock, cinematics, settings, resources, commands };
    } catch (error: unknown) {
      try { target.close(); } finally { cinematics.dispose(); }
      throw error;
    }
  })();
  caches.set(product, next); return next;
}
async function fixture(product: Product = "baseq3", registration: PlayerResources | null = null) {
  const { assets, resources } = registration ?? await retail(product), state = new ClientGameState(product, 0, 0);
  state.time = 1000; state.frameTime = 16;
  state.snap = { messageNumber: 1, serverTime: 1000, deltaNumber: -1, flags: 0, serverCommandNumber: 0, parseEntitiesNumber: 0,
    areaMask: new Uint8Array(), playerState: createPlayerState(product), entities: [] };
  const settings: Mutable<ClientInfoSettings> = { gameType: GameType.GT_FFA, maxClients: 64, forceModel: false, model: "sarge/default", headModel: "sarge/default",
    redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: false, loading: true };
  const logs: string[] = [], resets: number[] = [], registrations: string[] = [], sounds = new Map<string, PcmSound | null>();
  const policy = { memory: 10000000 };
  const store = new ClientInfoStore({ state, assets, resources, settings: () => settings, memoryRemaining: () => policy.memory,
    registerShaderNoMip: name => resources.registerShaderNoMip(name),
    async registerSound(name) {
      registrations.push(name);
      const pcm = assets.has(name) ? decodeWav(await assets.read(name), name) : null; sounds.set(name, pcm); return pcm;
    },
    sound(name) { if (!sounds.has(name)) throw new Error(`Sound not preloaded: ${name}`); return sounds.get(name) ?? null; },
    print: message => logs.push(message) }, new ClientGameStaticState(product).clientInfo);
  return { assets, resources, state, settings, policy, logs, resets, registrations, store };
}
function config(model = "sarge/default", head = "sarge/default", team = Team.TEAM_FREE, name = "Player"): string {
  return `\\n\\${name}\\t\\${team}\\model\\${model}\\hmodel\\${head}\\c1\\4\\c2\\3\\hc\\100`;
}
async function media(resources: RendererResources): Promise<PlayerMedia> {
  const shader = (name: string) => resources.registerShader(name), model = (path: string) => resources.registerModel(path);
  return { connectionShader: await shader("disconnected"), balloonShader: await shader("sprites/balloon3"),
    medalImpressive: await resources.registerShaderNoMip("medal_impressive"), medalExcellent: await resources.registerShaderNoMip("medal_excellent"),
    medalGauntlet: await resources.registerShaderNoMip("medal_gauntlet"), medalDefend: await resources.registerShaderNoMip("medal_defend"),
    medalAssist: await resources.registerShaderNoMip("medal_assist"), medalCapture: await resources.registerShaderNoMip("medal_capture"),
    friendShader: await shader("sprites/foe"), shadowMarkShader: await shader("markShadow"), wakeMarkShader: await shader("wake"),
    invisShader: await shader("powerups/invisibility"), quadShader: await shader("powerups/quad"), redQuadShader: await shader("powerups/blueflag"),
    regenShader: await shader("powerups/regen"), battleSuitShader: await shader("powerups/battleSuit"), hastePuffShader: await shader("hasteSmokePuff"),
    flightSound: null, redFlagModel: await model("models/flags/r_flag.md3"), blueFlagModel: await model("models/flags/b_flag.md3"), neutralFlagModel: await model("models/flags/n_flag.md3"),
    flagPoleModel: await model("models/flag2/flagpole.md3"), flagFlapModel: await model("models/flag2/flagflap3.md3"),
    redFlagFlapSkin: await resources.registerSkin("models/flag2/red.skin"), blueFlagFlapSkin: await resources.registerSkin("models/flag2/blue.skin"), neutralFlagFlapSkin: await resources.registerSkin("models/flag2/white.skin") };
}
async function missionMedia(resources: RendererResources): Promise<MissionPlayerMedia> {
  const model = (name: string) => resources.registerModel(`models/powerups/${name}.md3`);
  return { redCubeModel: await model("orb/r_orb"), blueCubeModel: await model("orb/b_orb"), kamikazeHeadModel: await model("kamikazi"), kamikazeHeadTrail: await model("trailtest"),
    guardPowerupModel: await model("guard_player"), scoutPowerupModel: await model("scout_player"), doublerPowerupModel: await model("doubler_player"), ammoRegenPowerupModel: await model("ammo_player"),
    invulnerabilityPowerupModel: await model("shield/shield"), medkitUsageModel: await model("regen"), shotgunSmokePuffShader: await resources.registerShader("shotgunSmokePuff"), dustPuffShader: await resources.registerShader("hasteSmokePuff") };
}
async function presentation(product: Product = "baseq3", registration: PlayerResources | null = null) {
  const setup = await fixture(product, registration); await setup.store.newClientInfo(1, config());
  let pendingWorld = presentationWorlds.get(setup.resources);
  if (pendingWorld === undefined) {
    pendingWorld = setup.resources.loadWorld("q3dm1");
    presentationWorlds.set(setup.resources, pendingWorld);
  }
  const world = await pendingWorld, collisionMap = parseBsp(await setup.assets.read("maps/q3dm1.bsp"));
  const collision = new CollisionWorld(collisionMap, { kind: "unaccounted" }, { kind: "disabled" });
  const entities: RefEntity[] = [], polys: RefPoly[] = [], lights: DynamicLight[] = [], weapons: number[] = [];
  const options: Mutable<PlayerPresentationSettings> = { gameType: GameType.GT_FFA, cameraMode: false, noPlayerAnimations: false,
    animationSpeed: 1, swingSpeed: 0.3, drawFriend: true, shadows: 0, enableBreath: false, enableDust: false, debugPosition: false, debugAnimation: false };
  const marks = new ImpactMarkSystem(new BspMarkProjector(world.markGeometry), { clock: () => setup.state.time, enabled: () => true, energyShader: () => null });
  const shader = await setup.resources.registerShader("white"), pcm = decodeWav(await setup.assets.read("sound/items/flight.wav"));
  const random = new GameRandom(1), audio = new AudioMixer(22050, () => 0);
  const pool = new LocalEntityPool(product);
  const effects = new ClientEffects(setup.state, pool, { waterBubbleShader: shader, smokePuffRageProShader: shader, bloodExplosionShader: shader,
    teleportEffectModel: DEFAULT_MODEL, gibSkull: DEFAULT_MODEL, gibBrain: DEFAULT_MODEL, gibAbdomen: DEFAULT_MODEL, gibArm: DEFAULT_MODEL,
    gibChest: DEFAULT_MODEL, gibFist: DEFAULT_MODEL, gibFoot: DEFAULT_MODEL, gibForearm: DEFAULT_MODEL, gibIntestine: DEFAULT_MODEL,
    gibLeg: DEFAULT_MODEL, smoke2: DEFAULT_MODEL, variant: product === "baseq3" ? { product, teleportEffectShader: shader }
      : { product, media: { lightningShader: shader, kamikazeEffectModel: DEFAULT_MODEL, dishFlashModel: DEFAULT_MODEL, rocketExplosionShader: shader,
        obeliskHitSounds: [pcm, pcm, pcm], invulnerabilityImpactModel: DEFAULT_MODEL, invulnerabilityImpactSounds: [pcm, pcm, pcm],
        invulnerabilityJuicedModel: DEFAULT_MODEL, invulnerabilityJuicedSound: pcm } } },
    { noProjectileTrail: false, blood: true, gibs: true, scorePlum: true, hardware: "generic" }, { randomInteger: () => random.rand(), startSound: unavailable });
  const localMedia: LocalEntityMedia = { bloodTrailShader: shader, bloodMarkShader: shader, burnMarkShader: shader,
    numberShaders: [shader, shader, shader, shader, shader, shader, shader, shader, shader, shader, shader], gibBounceSounds: [pcm, pcm, pcm] };
  const localAudio: LocalEntityHost["audio"] = { startSound(sound, options) {
    if (sound === null) throw new Error("Fixture media unexpectedly returned source sound handle zero");
    audio.startSound(sound, options);
  } };
  const localServices = { collision, audio: localAudio, clientNum: 0, random, marks,
    prediction: { trace: (start: Parameters<PlayerPresentationHost["trace"]>[0], end: Parameters<PlayerPresentationHost["trace"]>[1], bounds: Parameters<PlayerPresentationHost["trace"]>[2], skip: number, mask: number) =>
      ({ ...collision.trace({ start, end, shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }), entityNum: skip }) } };
  const localHost: LocalEntityHost = product === "baseq3" ? { ...localServices, product, media: localMedia }
    : { ...localServices, product, media: { ...localMedia, kamikazeShockWave: await setup.resources.registerModel("models/weaphits/kamwave.md3"),
      kamikazeExplodeSound: decodeWav(await setup.assets.read("sound/items/kam_explode.wav")),
      kamikazeImplodeSound: decodeWav(await setup.assets.read("sound/items/kam_implode.wav")) } };
  const locals = new LocalEntitySystem(effects, localHost);
  const services = { state: setup.state, media: await media(setup.resources), clients: setup.store, collision, marks, random: new GameRandom(1),
    effects, settings: () => options,
    trace: (start: Parameters<PlayerPresentationHost["trace"]>[0], end: Parameters<PlayerPresentationHost["trace"]>[1], bounds: Parameters<PlayerPresentationHost["trace"]>[2], _skip: number, mask: number) => collision.trace({ start, end, shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }),
    addEntity: (entity: RefEntity) => entities.push(copyRefEntity(entity)), addLight: (light: DynamicLight) => lights.push(light), addPoly: (poly: RefPoly) => polys.push(copyRefPoly(poly)),
    lightForPoint(point: Parameters<PlayerPresentationHost["lightForPoint"]>[0]) { const light = world.lightForPoint(point); if (light === null) throw new Error("Retail point lacks light grid"); return light; },
    addLoopingSound: unavailable, addPlayerWeapon: (_parent: Parameters<PlayerPresentationHost["addPlayerWeapon"]>[0], _ps: Parameters<PlayerPresentationHost["addPlayerWeapon"]>[1], entity: Parameters<PlayerPresentationHost["addPlayerWeapon"]>[2]) => weapons.push(entity.currentState.number), print: (message: string) => setup.logs.push(message) };
  const host: PlayerPresentationHost = product === "baseq3" ? { ...services, product } : { ...services, product, missionMedia: await missionMedia(setup.resources) };
  const presenter = new PlayerPresenter(host), entity = setup.state.entityAt(1);
  entity.currentState.eType = EntityType.ET_PLAYER; entity.currentState.clientNum = 1; entity.currentState.number = 1;
  entity.currentState.legsAnim = PlayerAnimation.LEGS_IDLE; entity.currentState.torsoAnim = PlayerAnimation.TORSO_STAND;
  entity.lerpOrigin = vec3(0, 0, 24); entity.currentState.pos = { ...entity.currentState.pos, base: entity.lerpOrigin };
  return { ...setup, host, world, collisionMap, collision, entities, polys, lights, weapons, options, presenter, entity, pool, locals };
}

describe("source player client-info loading", () => {
  test("pure client info retains first case-insensitive fields and source byte bounds", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const state = new ClientGameState(product, 0, 0), slots = new ClientGameStaticState(product).clientInfo;
      const settings: ClientInfoSettings = { gameType: GameType.GT_FFA, maxClients: 64, forceModel: false,
        model: "sarge/default", headModel: "sarge/default", redTeamName: "Stroggs", blueTeamName: "Pagans",
        deferPlayers: false, buildScript: false, loading: true };
      const store = new ClientInfoStore({ state, settings: () => settings, memoryRemaining: unavailable,
        assets: { has: unavailable, read: unavailable, list: unavailable },
        resources: { registerModel: unavailable, registerSkin: unavailable },
        registerShaderNoMip: unavailable, registerSound: unavailable, sound: unavailable, print: unavailable,
      }, slots);
      const loaded = store.clientInfo(0);
      loaded.infoValid = true; loaded.modelName = "sarge"; loaded.skinName = "default";
      loaded.headModelName = "sarge"; loaded.headSkinName = "default";
      const modelFields = "\\model\\sarge/default\\hmodel\\sarge/default";
      const highBytePrefix = `\\n\\\u00e9Player${modelFields}\\padding\\`;
      const cases = [
        { text: `\\n\\first\\n\\second${modelFields}`, name: "first" },
        { text: `\\N\\upper\\n\\second${modelFields}`, name: "upper" },
        { text: `\\n\\${modelFields}\\n\\second`, name: "" },
        { text: `${highBytePrefix}${"\u00e9".repeat(8191 - highBytePrefix.length)}`, name: "\u00e9Player" },
        { text: `\\n\\before${modelFields}\0\\n\\after${"x".repeat(8192)}`, name: "before" },
      ];
      for (const entry of cases) {
        await store.newClientInfo(1, entry.text);
        const info = store.clientInfo(1);
        expect(info.name).toBe(entry.name);
        expect(info.infoValid).toBe(true);
        expect(info.modelName).toBe("sarge");
        expect(info.headModelName).toBe("sarge");
        expect(info.handicap).toBe(0);
        expect(info.team).toBe(Team.TEAM_FREE);
      }
      await store.newClientInfo(1, "\\N\\fields\\MODEL\\sarge/default\\model\\absent/default\\HMODEL\\sarge/default\\hmodel\\absent/default\\HC\\75\\hc\\1\\T\\2\\t\\0\\SKILL\\4\\W\\7\\L\\3\\TT\\5\\TL\\1\\C1\\4\\C2\\3");
      const published = store.clientInfo(1);
      expect(published).toMatchObject({ name: "fields", handicap: 75, team: Team.TEAM_BLUE, botSkill: 4,
        wins: 7, losses: 3, teamTask: 5, teamLeader: true, color1: vec3(1, 0, 0), color2: vec3(0, 1, 1) });
      const oversize = store.newClientInfo(1, "x".repeat(8192));
      await expect(oversize).rejects.toBeInstanceOf(CommonError);
      await expect(oversize).rejects.toMatchObject({ code: "drop", message: "Info_ValueForKey: oversize infostring" });
      expect(store.clientInfo(1)).toBe(published);
      expect(published.name).toBe("fields");
      await store.newClientInfo(1, "\0\\n\\departed");
      expect(store.clientInfo(1)).toBe(published);
      expect(published.infoValid).toBe(false);
      expect(published.name).toBe("");
    }
  });
  test("pure custom sound and failed client models use source recoverable drops", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const mode of ["build", "team", "default"]) {
        const state = new ClientGameState(product, 0, 0), slots = new ClientGameStaticState(product).clientInfo;
        const calls: string[] = [];
        const settings: ClientInfoSettings = { gameType: mode === "default" ? GameType.GT_FFA : GameType.GT_TEAM,
          maxClients: 64, forceModel: false, model: "sarge/default", headModel: "sarge/default",
          redTeamName: "Stroggs", blueTeamName: "Pagans", deferPlayers: false, buildScript: mode === "build", loading: true };
        const store = new ClientInfoStore({ state, settings: () => settings, memoryRemaining: () => 10000000,
          assets: { has: unavailable, read: unavailable, list: unavailable },
          resources: { async registerModel(path) { calls.push(`model:${path}`); return DEFAULT_MODEL; }, registerSkin: unavailable },
          registerShaderNoMip: unavailable, registerSound: unavailable, sound: unavailable, print: text => calls.push(`print:${text}`),
        }, slots);
        for (const index of [-1, 64]) {
          expect(store.customSound(index, "*jump1.wav")).toBeNull();
          let failure: unknown;
          try { store.customSound(index, "*unknown.wav"); } catch (error) { failure = error; }
          expect(failure).toBeInstanceOf(CommonError);
          expect(failure).toMatchObject({ code: "drop", message: "Unknown custom sound: *unknown.wav" });
        }
        const slot = store.clientInfo(1);
        slot.name = "retained";
        const work = store.newClientInfo(1, config("absent/red", "absent/red", Team.TEAM_RED));
        const fallback = mode === "team" && product === "missionpack" ? "james" : "sarge";
        const message = mode === "build"
          ? `CG_RegisterClientModelname( absent, red, absent, red ${product === "missionpack" ? "Stroggs/" : ""} ) failed`
          : mode === "team" ? `DEFAULT_TEAM_MODEL / skin (${fallback}/red) failed to register` : "DEFAULT_MODEL (sarge) failed to register";
        await expect(work).rejects.toBeInstanceOf(CommonError);
        await expect(work).rejects.toMatchObject({ code: "drop", message });
        const initialCalls = ["model:models/players/absent/lower.md3", "model:models/players/characters/absent/lower.md3",
          "print:Failed to load model file models/players/characters/absent/lower.md3\n"];
        expect(calls).toEqual(mode === "build" ? initialCalls : [...initialCalls,
          `model:models/players/${fallback}/lower.md3`, `model:models/players/characters/${fallback}/lower.md3`,
          `print:Failed to load model file models/players/characters/${fallback}/lower.md3\n`]);
        expect(store.clientInfo(1)).toBe(slot);
        expect(slot.name).toBe("retained");
        expect(slot.infoValid).toBe(false);
      }
    }
  });
  test("pure client icon lookup retains source bounds and partial deferred animation writes", async () => {
    const state = new ClientGameState("missionpack", 0, 0), slots = new ClientGameStaticState("missionpack").clientInfo;
    const headSkin = "portrait_abcdefghijklmnop", root = "models/players/sarge/", team = "LongTeam/";
    const iconPath = `${root}${headSkin}/${team}icon_red.tga`, probes: string[] = [], icons: string[] = [], calls: string[] = [];
    let observePrint = (_message: string): void => {};
    const bytes = new Map<string, Uint8Array>([
      [`${root}${team}lower_red.skin`, Uint8Array.of(1)],
      [`${root}${team}upper_red.skin`, Uint8Array.of(1)],
      [`${root}${team}head_red.skin`, Uint8Array.of(1)],
      [`${root}animation.cfg`, new TextEncoder().encode("0 8 8 20\n".repeat(31))],
      [iconPath, Uint8Array.of(1)],
    ]);
    const settings: ClientInfoSettings = { gameType: GameType.GT_TEAM, maxClients: 64, forceModel: false,
      model: "sarge/default", headModel: "sarge/default", redTeamName: "LongTeam", blueTeamName: "Pagans",
      deferPlayers: false, buildScript: true, loading: true };
    const store = new ClientInfoStore({ state, settings: () => settings, memoryRemaining: () => 10000000,
      assets: {
        has(path) { probes.push(path); calls.push(`has:${path}`); return bytes.has(path); },
        async read(path) { const value = bytes.get(path); if (value === undefined) throw new Error(`Missing fixture path ${path}`); return value; },
        list: () => [...bytes.keys()],
      },
      resources: {
        async registerModel(path) {
          if (path === null) throw new Error("Authored player fixture requires a model path");
          return { kind: "md3", path, md3: [null, null, null], numLods: 0, md4: null };
        },
        async registerSkin(path) { return { path, surfaces: [] }; },
      },
      async registerShaderNoMip(path) { icons.push(path); return { name: path }; },
      registerSound: async () => null, sound: unavailable, print(message) { calls.push(`print:${message}`); observePrint(message); },
    }, slots);
    const slot = store.clientInfo(1), cells = slot.animations, held = cells[0];
    if (held === undefined) throw new Error("Missing client animation fixture");
    const userInfo = config("sarge/default", `sarge/${headSkin}`, Team.TEAM_RED);
    await store.newClientInfo(1, userInfo);
    expect(iconPath.length).toBeGreaterThan(63);
    const headPath = `${root}${headSkin}/${team}head_red.skin`;
    expect(probes).toContain(headPath.slice(0, 63));
    const headProbe = calls.indexOf(`has:${headPath.slice(0, 63)}`);
    expect(calls[headProbe - 1]).toBe(`print:Com_sprintf: overflow of ${headPath.length} in 64\n`);
    expect(probes).toContain(iconPath);
    expect(icons).toEqual([iconPath]);
    expect(store.clientInfo(1).modelIcon?.name).toBe(iconPath);
    expect(store.clientInfo(1).headSkin?.path).toBe(`${root}${team}head_red.skin`);
    expect(slot.animations).toBe(cells);
    expect(slot.animations[0]).toBe(held);
    expect(held.frameLerp).toBe(50);
    await store.newClientInfo(2, userInfo);
    const reused = store.clientInfo(2).animations[0];
    expect(reused).toEqual(held);
    expect(reused).not.toBe(held);
    expect(icons).toEqual([iconPath]);
    slot.setAnimations(slot.animations.map((animation, index) => index === PlayerAnimation.FLAG_RUN ? { ...animation, flipflop: true } : animation));
    const flag = slot.animations[PlayerAnimation.FLAG_RUN];
    slot.deferred = true;
    await store.loadDeferredPlayers(unavailable);
    expect(slot.animations[PlayerAnimation.FLAG_RUN]).toBe(flag);
    expect(flag?.flipflop).toBe(true);
    bytes.set(`${root}animation.cfg`, new TextEncoder().encode("41 -7 3"));
    slot.deferred = true;
    observePrint = message => {
      if (message !== `Error parsing animation file: ${root}animation.cfg`) return;
      expect(slot.animations[0]).toBe(held);
      expect(held).toEqual({ firstFrame: 41, numFrames: 7, loopFrames: 3,
        frameLerp: 50, initialLerp: 50, reversed: true, flipflop: false });
      expect(slot.deferred).toBe(true);
    };
    await expect(store.loadDeferredPlayers(unavailable)).rejects.toThrow("CG_RegisterClientModelname");
    expect(calls).toContain(`print:Error parsing animation file: ${root}animation.cfg`);
    expect(held.firstFrame).toBe(41);
    expect(flag?.flipflop).toBe(true);
    await store.newClientInfo(1, "");
    expect(slot.animations[0]).toBe(held);
    expect(held.frameLerp).toBe(0);
    expect(reused?.frameLerp).toBe(50);
    store.reset();
    expect(store.clientInfo(2).animations[0]).toBe(reused);
    expect(reused?.frameLerp).toBe(0);
  });

  test("pure deferred load cancellation guards every asynchronous media boundary", async () => {
    for (const phase of ["model", "exists", "skin", "animation", "icon", "sound"]) for (const cancellation of ["slot", "lifecycle"]) {
      const state = new ClientGameState("baseq3", 0, 0), slots = new ClientGameStaticState("baseq3").clientInfo;
      const arrived: { resolve: (() => void) | null } = { resolve: null }, released: { resolve: (() => void) | null } = { resolve: null };
      const ready = new Promise<void>(resolve => { arrived.resolve = resolve; }), pending = new Promise<void>(resolve => { released.resolve = resolve; });
      let blocked = false;
      const calls: string[] = [];
      const pause = async (operation: string): Promise<void> => {
        calls.push(operation);
        if (operation !== phase || blocked) return;
        blocked = true;
        if (arrived.resolve === null) throw new Error("Missing arrival resolver");
        arrived.resolve();
        await pending;
      };
      const settings: ClientInfoSettings = { gameType: GameType.GT_FFA, maxClients: 2, forceModel: false,
        model: "sarge/default", headModel: "sarge/default", redTeamName: "Stroggs", blueTeamName: "Pagans",
        deferPlayers: false, buildScript: true, loading: true };
      const store = new ClientInfoStore({ state, settings: () => settings, memoryRemaining: () => 10000000,
        assets: { has: () => true, list: () => [], async read(path) {
          await pause(path.endsWith("animation.cfg") ? "animation" : "exists");
          return path.endsWith("animation.cfg") ? new TextEncoder().encode("0 8 8 20\n".repeat(31)) : Uint8Array.of(1);
        } },
        resources: {
          async registerModel(path) {
            if (path === null) throw new Error("Authored player fixture requires a model path");
            await pause("model"); return { kind: "md3", path, md3: [null, null, null], numLods: 0, md4: null };
          },
          async registerSkin(path) { await pause("skin"); return { path, surfaces: [] }; },
        },
        async registerShaderNoMip(path) { await pause("icon"); return { name: path }; },
        async registerSound() { await pause("sound"); return null; }, sound: unavailable, print: unavailable,
      }, slots);
      const slot = store.clientInfo(1), held = slot.animations[0];
      slot.infoValid = true; slot.deferred = true;
      slot.modelName = "sarge"; slot.headModelName = "sarge"; slot.skinName = "default"; slot.headSkinName = "default";
      const loading = store.loadDeferredPlayers(unavailable);
      await ready;
      if (cancellation === "lifecycle") store.reset();
      else await store.newClientInfo(1, "");
      const count = calls.length;
      if (released.resolve === null) throw new Error("Missing release resolver");
      released.resolve();
      await loading;
      expect(calls).toHaveLength(count);
      expect(slot.infoValid).toBe(false);
      expect(slot.deferred).toBe(false);
      expect(slot.legsModel.kind).toBe("default");
      expect(slot.headSkin).toBeNull();
      expect(slot.modelIcon).toBeNull();
      expect(slot.animations[0]).toBe(held);
      expect(held?.frameLerp).toBe(0);
    }
  });

  test("pure head model overflow prints before the bounded registration and propagates diagnostic stops", async () => {
    for (const size of [51, 62]) for (const stopped of [false, true]) {
      const name = "h".repeat(size), fullPath = `models/players/heads/${name}/${name}.md3`;
      const path = fullPath.slice(0, 127), calls: string[] = [], stop = new Error("stop at filename diagnostic");
      const settings: ClientInfoSettings = { gameType: GameType.GT_FFA, maxClients: 2, forceModel: false,
        model: "sarge/default", headModel: "sarge/default", redTeamName: "Stroggs", blueTeamName: "Pagans",
        deferPlayers: false, buildScript: true, loading: true };
      const store = new ClientInfoStore({ state: new ClientGameState("baseq3", 0, 0), settings: () => settings,
        memoryRemaining: () => 10000000, assets: { has: unavailable, read: unavailable, list: unavailable },
        resources: {
          async registerModel(filename): Promise<SceneModel> {
            if (filename === null) throw new Error("Authored player fixture requires a model path");
            calls.push(`model:${filename}`);
            return filename.startsWith("models/players/heads/") ? DEFAULT_MODEL
              : { kind: "md3", path: filename, md3: [null, null, null], numLods: 0, md4: null };
          }, registerSkin: unavailable,
        },
        registerShaderNoMip: unavailable, registerSound: unavailable, sound: unavailable,
        print(message) { calls.push(`print:${message}`); if (stopped) throw stop; },
      }, new ClientGameStaticState("baseq3").clientInfo);
      await expect(store.newClientInfo(1, config("sarge/default", `*${name}`)))
        .rejects.toThrow(stopped ? stop : "CG_RegisterClientModelname");
      const expected = ["model:models/players/sarge/lower.md3", "model:models/players/sarge/upper.md3",
        `print:Com_sprintf: overflow of ${fullPath.length} in 128\n`];
      if (!stopped) expected.push(`model:${path}`, `print:Failed to load model file ${path}\n`);
      expect(calls).toEqual(expected);
    }
  });

  test("retail base and Team Arena models, skins, sounds and tag animations", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const a = await fixture(product), model = product === "baseq3" ? "sarge/default" : "james/default", head = product === "baseq3" ? model : "*james/default";
      const slot = a.store.clientInfo(1); await a.store.newClientInfo(1, config(model, head));
      expect(a.store.clientInfo(1)).toBe(slot); expect(slot.infoValid).toBe(true); expect(slot.legsModel.kind).toBe("md3");
      expect(slot.legsSkin).not.toBeNull(); expect(slot.headSkin).not.toBeNull(); expect(slot.modelIcon).not.toBeNull();
      expect(slot.color1).toEqual(vec3(1, 0, 0)); expect(slot.color2).toEqual(vec3(0, 1, 1));
      expect(slot.animations).toHaveLength(37); expect(slot.sounds.slice(0, 13).every(sound => sound !== null)).toBe(true);
      expect(slot.newAnims).toBe(product === "missionpack"); expect(a.resets).toEqual([]);
      expect(a.store.customSound(1, "*jump1.wav")).toBe(at(slot.sounds, 3));
      expect(() => a.store.customSound(1, "*unknown.wav")).toThrow("Unknown custom sound");
    }
  });
  test("fallback retains requested names, uses fallback sounds, and strict build script rejects", async () => {
    const a = await fixture(); await a.store.newClientInfo(1, config("missing/bogus", "missing/bogus"));
    const ci = a.store.clientInfo(1); expect(ci.modelName).toBe("missing"); expect(ci.legsModel.path).toBe("models/players/sarge/lower.md3");
    expect(a.registrations.every(name => name.startsWith("sound/player/sarge/"))).toBe(true);
    a.settings.buildScript = true; await expect(a.store.newClientInfo(2, config("absent/default"))).rejects.toThrow("CG_RegisterClientModelname");
    expect(a.store.clientInfo(2).infoValid).toBe(false);
  });
  test("missing skin diagnostics retain the final source filename before default fallback", async () => {
    const a = await fixture(); await a.store.newClientInfo(1, config("sarge/missing_skin", "sarge/missing_skin"));
    expect(a.logs).toContain("Leg skin load failure: models/players/characters/sarge/lower_missing_skin.skin\n");
    expect(a.logs).toContain("Torso skin load failure: models/players/characters/sarge/upper_missing_skin.skin\n");
    expect(a.logs).toContain("Head skin load failure: models/players/heads/sarge/head_missing_skin.skin\n");
    expect(a.store.clientInfo(1).infoValid).toBe(true);
  });
  test("copy reuse does not copy fixedleg flags; deferred model respects team and source low-memory permanence", async () => {
    const a = await fixture(); await a.store.newClientInfo(1, config()); a.store.clientInfo(1).fixedLegs = true;
    const registrations = a.registrations.length; await a.store.newClientInfo(2, config());
    expect(a.registrations.length).toBe(registrations); expect(a.store.clientInfo(2).fixedLegs).toBe(false);
    expect(a.store.clientInfo(2).animations).not.toBe(a.store.clientInfo(1).animations);
    a.settings.deferPlayers = true; a.settings.loading = false;
    await a.store.newClientInfo(3, config("visor/default", "visor/default"));
    expect(a.store.clientInfo(3).deferred).toBe(true); expect(a.store.clientInfo(3).legsModel).toBe(a.store.clientInfo(1).legsModel);
    const body = a.state.entityAt(100); body.currentState.eType = EntityType.ET_PLAYER; body.currentState.clientNum = 3; body.currentState.number = 100;
    await a.store.loadDeferredPlayers(entity => a.resets.push(entity.currentState.number)); expect(a.store.clientInfo(3).deferred).toBe(false); expect(a.store.clientInfo(3).legsModel.path).toContain("visor"); expect(a.resets).toEqual([100]);
    a.policy.memory = 3999999; await a.store.newClientInfo(4, config("anarki/default", "anarki/default"));
    expect(a.store.clientInfo(4).deferred).toBe(false); expect(a.store.clientInfo(4).legsModel).toBe(a.store.clientInfo(1).legsModel);
    expect(a.logs).toContain("Memory is low.  Using deferred model.\n");
  });
  test("team force-model keeps requested skin and selects product-specific default", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const a = await fixture(product); a.settings.gameType = GameType.GT_TEAM; a.settings.forceModel = true;
      await a.store.newClientInfo(1, config("visor/default", "visor/default", Team.TEAM_BLUE));
      const ci = a.store.clientInfo(1); expect(ci.modelName).toBe(product === "baseq3" ? "sarge" : "james"); expect(ci.skinName).toBe("default");
      expect(ci.legsSkin?.path).toContain("blue.skin");
    }
  });
  test("deferred resets use each stable published slot before the next client begins loading", async () => {
    const a = await presentation(), order: string[] = [];
    const slots = Array.from({ length: 64 }, (_, index) => a.store.clientInfo(index));
    const store = new ClientInfoStore({ ...a.store.host, resources: {
      registerSkin: path => a.resources.registerSkin(path),
      registerModel(path) {
        if (path === "models/players/visor/lower.md3") order.push("load:3");
        if (path === "models/players/anarki/lower.md3") order.push("load:4");
        return a.resources.registerModel(path);
      },
    } }, slots);
    a.settings.loading = false; a.settings.deferPlayers = true;
    await store.newClientInfo(3, config("visor/default", "visor/default"));
    await store.newClientInfo(4, config("anarki/default", "anarki/default"));
    const first = store.clientInfo(3), second = store.clientInfo(4);
    for (const number of [3, 4, 100]) {
      const entity = a.state.entityAt(number); entity.currentState.number = number;
      entity.currentState.clientNum = number === 100 ? 3 : number; entity.currentState.eType = EntityType.ET_PLAYER;
    }
    await store.loadDeferredPlayers(entity => {
      const clientNum = entity.currentState.clientNum;
      expect(store.clientInfo(clientNum)).toBe(clientNum === 3 ? first : second);
      expect(store.clientInfo(clientNum).deferred).toBe(false);
      if (clientNum === 3) expect(second.deferred).toBe(true);
      order.push(`reset:${entity.currentState.number}`);
      a.presenter.resetPlayerEntity(entity);
    });
    expect(order).toEqual(["load:3", "reset:3", "reset:100", "load:4", "reset:4"]);
    expect(a.state.entityAt(100).errorTime).toBe(-99999);
  });
  test("superseded and previous-lifecycle deferred loads cannot publish or reset entities", async () => {
    for (const cancellation of ["slot", "lifecycle"]) {
      const a = await fixture(), released: { done: (() => void) | null } = { done: null };
      const pending = new Promise<void>(resolve => { released.done = resolve; }); let block = true;
      const store = new ClientInfoStore({ ...a.store.host, resources: {
        registerSkin: path => a.resources.registerSkin(path),
        async registerModel(path) {
          if (block && path === "models/players/visor/lower.md3") { block = false; await pending; }
          return a.resources.registerModel(path);
        },
      } }, new ClientGameStaticState("baseq3").clientInfo);
      await store.newClientInfo(1, config()); a.settings.loading = false; a.settings.deferPlayers = true;
      await store.newClientInfo(3, config("visor/default", "visor/default"));
      const entity = a.state.entityAt(100); entity.currentState.eType = EntityType.ET_PLAYER; entity.currentState.clientNum = 3;
      const old = store.loadDeferredPlayers(value => a.resets.push(value.currentState.number));
      if (cancellation === "lifecycle") store.reset();
      a.settings.loading = true;
      await store.newClientInfo(3, config("sarge/default", "sarge/default", Team.TEAM_FREE, "fresh"));
      const published = store.clientInfo(3).legsModel;
      if (released.done === null) throw new Error("Missing deferred I/O release"); released.done(); await old;
      expect(a.resets).toEqual([]); expect(store.clientInfo(3).name).toBe("fresh"); expect(store.clientInfo(3).legsModel).toBe(published);
    }
  });
  test("low-memory deferred completion preserves copied media without invoking reset", async () => {
    const a = await fixture(); await a.store.newClientInfo(1, config());
    a.settings.loading = false; a.settings.deferPlayers = true;
    await a.store.newClientInfo(3, config("visor/default", "visor/default"));
    const slot = a.store.clientInfo(3), model = slot.legsModel;
    a.policy.memory = 3999999;
    await a.store.loadDeferredPlayers(unavailable);
    expect(slot.deferred).toBe(false); expect(slot.legsModel).toBe(model);
    expect(a.logs).toContain("Memory is low.  Using deferred model.\n");
  });
  test("stale loads cannot overwrite slot reuse or block fresh lifecycle I/O", async () => {
    const a = await fixture(); const released: { done: (() => void) | null } = { done: null };
    const pending = new Promise<void>(resolve => { released.done = resolve; });
    let wait = true;
    const store = new ClientInfoStore({ ...a.store.host, resources: { ...a.resources,
      async registerModel(path) { if (wait) { wait = false; await pending; } return a.resources.registerModel(path); } } }, new ClientGameStaticState("baseq3").clientInfo);
    const old = store.newClientInfo(1, config("sarge/default", "sarge/default", Team.TEAM_FREE, "old"));
    store.reset(); await store.newClientInfo(1, config("visor/default", "visor/default", Team.TEAM_FREE, "fresh"));
    expect(store.clientInfo(1).name).toBe("fresh");
    if (released.done === null) throw new Error("Missing I/O release"); released.done(); await old;
    expect(store.clientInfo(1).name).toBe("fresh");
    await store.newClientInfo(1, ""); expect(store.clientInfo(1)).toEqual(new ClientInfo());
  });
  test("a newer same-slot config publishes atomically and invalidates older blocked media", async () => {
    const a = await fixture(); const released: { done: (() => void) | null } = { done: null };
    const pending = new Promise<void>(resolve => { released.done = resolve; }); let wait = true;
    const store = new ClientInfoStore({ ...a.store.host, resources: { ...a.resources,
      async registerModel(path) { if (wait) { wait = false; await pending; } return a.resources.registerModel(path); } } }, new ClientGameStaticState("baseq3").clientInfo);
    const old = store.newClientInfo(1, config("sarge/default", "sarge/default", Team.TEAM_FREE, "old"));
    expect(store.clientInfo(1).infoValid).toBe(false); expect(store.clientInfo(1).legsModel).toBe(DEFAULT_MODEL);
    await store.newClientInfo(1, config("visor/default", "visor/default", Team.TEAM_FREE, "new"));
    const selected = store.clientInfo(1).legsModel;
    if (released.done === null) throw new Error("Missing I/O release"); released.done(); await old;
    expect(store.clientInfo(1).name).toBe("new"); expect(store.clientInfo(1).legsModel).toBe(selected);
  });
});

describe("source player presentation", () => {
  test("original QVM pose and Team Arena attachment render-trap bit fixtures", async () => {
    for (const name of ["pose", "mission", "dead", "dead_invalid", "pose_fixed"]) {
      const a = await presentation("missionpack"), ci = a.store.clientInfo(1), base = ci.legsModel;
      if (base.kind !== "md3" || a.host.product !== "missionpack") throw new Error("Missing oracle model");
      const baseMd3 = base.md3[0];
      if (baseMd3 === null) throw new Error("Missing oracle base MD3");
      const model = (id: number): SceneModel => ({ kind: "md3", path: String(id), md3: [{
        name: baseMd3.name, flags: baseMd3.flags, skinCount: baseMd3.skinCount,
        frames: baseMd3.frames, tags: baseMd3.tags.map(() => []), surfaces: baseMd3.surfaces,
      }, null, null], numLods: 1, md4: null });
      ci.legsModel = model(1); ci.torsoModel = model(2); ci.headModel = model(3);
      ci.setAnimations(Array.from({ length: 37 }, (_, index) => ({ firstFrame: index * 10, numFrames: 8, loopFrames: 8, frameLerp: 66, initialLerp: 66, reversed: false, flipflop: false })));
      ci.fixedLegs = name === "pose_fixed"; ci.fixedTorso = name === "pose_fixed";
      const host: PlayerPresentationHost = { ...a.host, missionMedia: { ...a.host.missionMedia, kamikazeHeadModel: model(10), kamikazeHeadTrail: model(11),
        guardPowerupModel: model(12), invulnerabilityPowerupModel: model(13), medkitUsageModel: model(14) } };
      a.entity.lerpOrigin = vec3(1.25, -2.5, 24.125); a.entity.lerpAngles = vec3(17.25, 112.75, -9.125);
      a.entity.currentState.pos = { ...a.entity.currentState.pos, delta: vec3(100, 50, -30) }; a.entity.currentState.angles2 = vec3(0, 7, 0);
      a.entity.currentState.legsAnim = PlayerAnimation.LEGS_RUN; a.entity.player.painTime = 900; a.entity.player.painDirection = true;
      if (name === "mission") { a.entity.currentState.eFlags = 0x200; a.entity.currentState.powerups = (1 << Powerup.PW_GUARD) | (1 << Powerup.PW_INVULNERABILITY); ci.medkitUsageTime = 550; }
      if (name === "dead" || name === "dead_invalid") a.entity.currentState.eFlags = 0x201;
      if (name === "dead_invalid") a.entity.currentState.angles2 = vec3(0, 777, 0);
      new PlayerPresenter(host).player(a.entity);
      const bits = (value: number): number => { const buffer = new ArrayBuffer(4), view = new DataView(buffer); view.setFloat32(0, value, true); return view.getUint32(0, true); };
      const actual: readonly (readonly number[])[] = a.entities.map((entity, index) => {
        if (entity.kind !== "model") throw new Error("Unexpected oracle sprite");
        return [index, Number(entity.model.path), entity.frame, entity.oldFrame, bits(entity.backLerp), bits(entity.origin.x), bits(entity.origin.y), bits(entity.origin.z),
          ...entity.axis.flatMap(axis => [bits(axis.x), bits(axis.y), bits(axis.z)]), entity.shaderRGBA.x, entity.shaderRGBA.y, entity.shaderRGBA.z, entity.shaderRGBA.w, entity.renderFlags, 0];
      });
      // The original dead_invalid run is byte-identical to dead: source never reads its movement direction.
      expect(actual).toEqual(qvmRows.filter(row => row.name === (name === "dead_invalid" ? "dead" : name)).map(row => row.values));
    }
  });
  test("original QVM swing preserves MULF4 before the angle16 integer conversion", () => {
    const result = swingAngles({ destination: 187.53111267089844, swingTolerance: 0, clampTolerance: 90, speed: 0,
      frameTimeMs: 16, angle: 187.53111267089844, swinging: true });
    expect(result.angle).toBe(187.5311279296875); // Original SWING 0x433b87f8.
  });
  test("original QVM animation parser and signed-clock overflow fixtures", () => {
    const config = parsePlayerAnimationConfig("0 8 8 30.303031\n".repeat(31));
    expect(at(config.animations, 0)?.frameLerp).toBe(33); // Original PARSE 33.
    const ci = new ClientInfo();
    ci.setAnimations(Array.from({ length: 37 }, (_, index) => ({ firstFrame: index * 10, numFrames: 8, loopFrames: 8, frameLerp: 66, initialLerp: 66, reversed: false, flipflop: false })));
    const frame = createLerpFrame(); frame.frameTime = 2147483600;
    runLerpFrame(ci, frame, { timeMs: 2147483601, newAnimation: PlayerAnimation.LEGS_RUN, speedScale: 1, noPlayerAnimations: false });
    expect([frame.frame, frame.oldFrame, frame.frameTime, frame.oldFrameTime, frame.backLerp, frame.animationNumber, frame.animationTime])
      .toEqual([150, 0, 2147483601, 2147483600, 0, 15, -2147483630]);
    const haste = createLerpFrame(); haste.animationNumber = PlayerAnimation.LEGS_RUN; haste.animationTime = -2000000000;
    haste.currentAnimation = { firstFrame: 150, numFrames: 8, loopFrames: 8, frameLerp: 1, initialLerp: 66, reversed: false, flipflop: false };
    ci.setAnimations(ci.animations.map((animation, index) => index === PlayerAnimation.LEGS_RUN ? haste.currentAnimation : animation));
    runLerpFrame(ci, haste, { timeMs: 1, newAnimation: PlayerAnimation.LEGS_RUN, speedScale: 1.5, noPlayerAnimations: false });
    expect(haste.frame).toBe(-2147483498); // Original ANIMATION_SPEED: QVM CVFI overflow.
  });
  test("original QVM active animation observes model reload without restarting interpolation", () => {
    const ci = new ClientInfo(); ci.setAnimations(Array.from({ length: 37 }, (_, index) => ({ firstFrame: index * 10, numFrames: 8, loopFrames: 8, frameLerp: 66, initialLerp: 66, reversed: false, flipflop: false })));
    const frame = createLerpFrame();
    runLerpFrame(ci, frame, { timeMs: 1000, newAnimation: PlayerAnimation.LEGS_RUN, speedScale: 1, noPlayerAnimations: false });
    ci.setAnimations(ci.animations.map(animation => ({ ...animation, firstFrame: 1000, frameLerp: 40 })));
    runLerpFrame(ci, frame, { timeMs: 1010, newAnimation: PlayerAnimation.LEGS_RUN, speedScale: 1, noPlayerAnimations: false });
    expect([frame.frame, frame.oldFrame, frame.frameTime, frame.oldFrameTime, frame.backLerp, frame.animationTime]).toEqual([1000, 150, 1040, 1000, 0.75, 66]);
  });
  test("retail tagged body is submitted in source order with independent animation state", async () => {
    const a = await presentation(); a.presenter.player(a.entity);
    expect(a.entities.map(entity => entity.kind === "model" ? entity.model.path : entity.kind)).toEqual([
      "models/players/sarge/lower.md3", "models/players/sarge/upper.md3", "models/players/sarge/head.md3"]);
    expect(a.weapons).toEqual([1]);
    for (const entity of a.entities) expect(entity.renderFlags).toBe(RF_LIGHTING_ORIGIN);
    const legs = at(a.entities, 0), head = at(a.entities, 2); if (legs.kind !== "model" || head.kind !== "model") throw new Error("Missing body model");
    expect(head.origin.z).toBeGreaterThan(legs.origin.z); expect(legs.shaderRGBA).toEqual(vec4(0, 0, 0, 0));
    a.entity.player.flag.frame = 9; a.presenter.resetPlayerEntity(a.entity);
    expect(a.entity.player.legs.currentAnimation).toBeNull(); expect(a.entity.player.legs.frameTime).toBe(0); expect(a.entity.player.flag.frame).toBe(9); expect(a.entity.errorTime).toBe(-99999);
  });
  test("original QVM animation and reset diagnostics preserve the source float-as-integer printf", async () => {
    const a = await presentation(); a.options.debugAnimation = true; a.options.debugPosition = true;
    a.entity.currentState.legsAnim = PlayerAnimation.LEGS_RUN;
    a.entity.currentState.apos = { ...a.entity.currentState.apos, base: vec3(17.25, 187.53111267089844, 0) };
    a.presenter.resetPlayerEntity(a.entity);
    expect(a.logs.slice(-3)).toEqual(["Anim: 15\n", "Anim: 11\n", "1 ResetPlayerEntity yaw=1127974903\n"]);
  });
  test("first-person mirrors, camera hiding, connection priority and disconnected corpses", async () => {
    const a = await presentation(); a.entity.currentState.number = 0; a.entity.currentState.eFlags = 0x2000 | 0x1000 | 0x8000;
    a.presenter.player(a.entity); expect(a.entities).toHaveLength(4); const sprite = at(a.entities, 0); if (sprite.kind !== "sprite") throw new Error("Expected connection sprite"); expect(sprite.customShader).toEqual(a.host.media.connectionShader);
    expect(at(a.entities, 0).renderFlags).toBe(RF_THIRD_PERSON); expect(at(a.entities, 1).renderFlags).toBe(RF_THIRD_PERSON | RF_LIGHTING_ORIGIN);
    a.entities.length = 0; a.state.renderingThirdPerson = true; a.options.cameraMode = true; a.presenter.player(a.entity); expect(a.entities).toEqual([]);
    a.state.renderingThirdPerson = false; a.store.clientInfo(1).infoValid = false; a.presenter.player(a.entity); expect(a.entities).toEqual([]);
    for (const clientNum of [-1, 64]) {
      a.entity.currentState.clientNum = clientNum;
      let failure: unknown;
      try { a.presenter.player(a.entity); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CommonError);
      expect(failure).toMatchObject({ code: "drop", message: "Bad clientNum on player entity" });
      expect(a.entities).toEqual([]);
    }
  });
  test("powerup shader mutation and layer ordering match source including regen tenths", async () => {
    const a = await presentation(), entity = createModelEntity(); a.state.time = 1100;
    a.entity.currentState.powerups = (1 << Powerup.PW_QUAD) | (1 << Powerup.PW_REGEN) | (1 << Powerup.PW_BATTLESUIT);
    a.presenter.addRefEntityWithPowerups(entity, a.entity.currentState, Team.TEAM_RED);
    expect(a.entities.map(item => item.kind === "model" ? item.customShader : null)).toEqual([null, a.host.media.redQuadShader, a.host.media.regenShader, a.host.media.battleSuitShader]);
    expect(entity.customShader).toBe(a.host.media.battleSuitShader);
    a.entities.length = 0; a.entity.currentState.powerups |= 1 << Powerup.PW_INVIS;
    a.presenter.addRefEntityWithPowerups(entity, a.entity.currentState, Team.TEAM_BLUE); expect(a.entities).toHaveLength(1); expect(entity.customShader).toBe(a.host.media.invisShader);
  });
  test("haste and Team Arena breath create and play real timed local entities", async () => {
    const a = await presentation("missionpack"); a.options.enableBreath = true;
    a.entity.currentState.legsAnim = PlayerAnimation.LEGS_RUN; a.entity.currentState.powerups = 1 << Powerup.PW_HASTE;
    a.presenter.player(a.entity); expect(a.pool.activeCount).toBe(2); expect(a.store.clientInfo(1).breathPuffTime).toBe(3000); expect(a.entity.trailTime).toBe(1000);
    a.state.time = 1050; a.presenter.player(a.entity); expect(a.pool.activeCount).toBe(3); expect(a.entity.trailTime).toBe(1100);
    a.state.time = 1075; a.presenter.player(a.entity); expect(a.pool.activeCount).toBe(3);
    const scene = a.locals.collectEntities({ time: 1100, frameTime: 25, viewOrigin: vec3(200, 0, 100) });
    expect(scene.entities).toHaveLength(3); expect(scene.entities.every(entity => entity.kind === "sprite")).toBe(true);
  });
  test("retail player shadow uses actual BSP clipping and temporary mark projection", async () => {
    const a = await presentation(); a.options.shadows = 1;
    a.entity.lerpOrigin = a.world.initialCamera().origin; a.presenter.player(a.entity);
    expect(a.polys.length).toBeGreaterThan(0); expect(a.polys.every(poly => poly.shader === a.host.media.shadowMarkShader)).toBe(true);
    const legs = a.entities.find(entity => entity.kind === "model"); if (legs?.kind !== "model") throw new Error("Missing shadowed player");
    expect(legs.shadowPlane).toBeLessThan(a.entity.lerpOrigin.z);
    a.polys.length = 0; a.entity.currentState.powerups = 1 << Powerup.PW_INVIS; a.presenter.player(a.entity); expect(a.polys).toEqual([]);
  });
  test("water splash uses the actual BSP surface intersection and four source vertices", async () => {
    const a = await presentation(), origin = a.world.initialCamera().origin;
    const floor = a.collision.trace({ start: origin, end: vec3(origin.x, origin.y, origin.z - 128), shape: { kind: "point" }, mask: 1 });
    expect(floor.fraction).toBeLessThan(1);
    const water = new CollisionWorld({ ...a.collisionMap, shaders: a.collisionMap.shaders.map(shader => ({ ...shader, contentFlags: shader.contentFlags & 1 ? 32 : shader.contentFlags })) }, { kind: "unaccounted" }, { kind: "disabled" });
    a.entity.lerpOrigin = vec3(origin.x, origin.y, floor.end.z + 16); a.options.shadows = 1;
    const presenter = new PlayerPresenter({ ...a.host, collision: water }); presenter.player(a.entity);
    const wake = a.polys.find(poly => poly.shader === a.host.media.wakeMarkShader);
    if (wake === undefined) throw new Error("Missing water wake");
    expect(wake.vertices).toHaveLength(4); expect(wake.vertices.map(vertex => vertex.texCoord)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }]);
    expect(at(wake.vertices, 0).position.x).toBe(origin.x - 32); expect(at(wake.vertices, 2).position.y).toBe(origin.y + 32);
    expect(wake.vertices.every(vertex => vertex.color.w === 255)).toBe(true);
    a.polys.length = 0; a.options.shadows = 0; presenter.player(a.entity); expect(a.polys).toEqual([]);
  });
  test("all carried flags use retail tag attachments or old-model trailing geometry", async () => {
    const a = await presentation("missionpack"); await a.store.newClientInfo(1, config("james/default", "*james/default"));
    a.entity.currentState.legsAnim = PlayerAnimation.LEGS_RUN;
    a.entity.currentState.pos = { ...a.entity.currentState.pos, delta: vec3(100, 0, 0) };
    a.entity.currentState.powerups = (1 << Powerup.PW_REDFLAG) | (1 << Powerup.PW_BLUEFLAG) | (1 << Powerup.PW_NEUTRALFLAG);
    a.presenter.player(a.entity); expect(a.entities).toHaveLength(9); expect(a.lights.map(light => light.color)).toEqual([vec3(1, 0.2, 0.2), vec3(0.2, 0.2, 1), vec3(1, 1, 1)]);
    const flaps = a.entities.filter(entity => entity.kind === "model" && entity.model === a.host.media.flagFlapModel);
    expect(flaps).toHaveLength(3); expect(a.entity.player.flag.animationNumber).toBe(PlayerAnimation.FLAG_RUN);
    expect(a.entity.player.flag.yawAngle).toBeGreaterThanOrEqual(0); expect(a.entity.player.flag.yawAngle).toBeLessThan(360);
    a.store.clientInfo(1).newAnims = false; a.entities.length = 0; a.lights.length = 0; a.presenter.player(a.entity);
    expect(a.entities).toHaveLength(6); const trail = at(a.entities, 3);
    if (trail.kind !== "model") throw new Error("Missing trailing flag"); expect(trail.origin).toEqual(vec3(-16, 0, 40));
  });
  test("Team Arena dust checks actual retail brush contact surface flags", async () => {
    const a = await presentation("missionpack"); a.options.enableDust = true;
    const dustWorld = new CollisionWorld({ ...a.collisionMap, shaders: a.collisionMap.shaders.map(shader => ({ ...shader, surfaceFlags: shader.surfaceFlags | 0x40000 })) }, { kind: "unaccounted" }, { kind: "disabled" });
    const presenter = new PlayerPresenter({ ...a.host,
      trace(start, end, bounds, _skip, mask) { return dustWorld.trace({ start, end, shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, mask }); } });
    a.entity.lerpOrigin = a.world.initialCamera().origin; a.entity.currentState.pos = { ...a.entity.currentState.pos, base: a.entity.lerpOrigin };
    a.entity.currentState.legsAnim = PlayerAnimation.LEGS_LAND; presenter.player(a.entity); expect(a.pool.activeCount).toBe(1); expect(a.entity.dustTrailTime).toBe(1000);
    const scene = a.locals.collectEntities({ time: 1100, frameTime: 16, viewOrigin: vec3(10000, 0, 0) });
    const smoke = at(scene.entities, 0); if (smoke.kind !== "sprite") throw new Error("Missing dust puff");
    expect(smoke.origin.z).toBe(a.entity.lerpOrigin.z - 19);
  });
  test("vertex lighting uses source truncation, saturation and unsigned byte conversion", async () => {
    const a = await presentation();
    const presenter = new PlayerPresenter({ ...a.host, lightForPoint: () => ({ ambientLight: vec3(10.9, 20.9, 30.9), directedLight: vec3(100, 1000, 50), lightDir: vec3(1, 0, 0) }) });
    const vertex = { position: vec3(1, 2, 3), texCoord: { x: 0, y: 0 }, color: vec4(0, 0, 0, 0) };
    expect(presenter.lightVerts(vec3(0.5, 0, 0), [vertex])).toBe(true); expect(vertex.color).toEqual(vec4(60, 255, 55, 255));
    presenter.lightVerts(vec3(-1, 0, 0), [vertex]); expect(vertex.color).toEqual(vec4(10, 20, 30, 255));
  });
  test("Team Arena skulls, persistent shells, medkit wrap, invulnerability fade and token trail", async () => {
    const a = await presentation("missionpack"); a.entity.currentState.eFlags = 0x200;
    a.entity.currentState.powerups = (1 << Powerup.PW_GUARD) | (1 << Powerup.PW_SCOUT) | (1 << Powerup.PW_DOUBLER) | (1 << Powerup.PW_AMMOREGEN) | (1 << Powerup.PW_INVULNERABILITY);
    a.store.clientInfo(1).medkitUsageTime = 550; a.options.gameType = GameType.GT_HARVESTER; a.entity.currentState.generic1 = 3;
    a.presenter.player(a.entity);
    expect(a.entities).toHaveLength(19); expect(at(a.state.skullTrails, 1).numPositions).toBe(3);
    const models = a.entities.filter(entity => entity.kind === "model"), medkit = models.find(entity => entity.model.path === "models/powerups/regen.md3");
    if (medkit === undefined) throw new Error("Missing medkit");
    expect(medkit.shaderRGBA).toEqual(vec4(121, 121, 121, 121)); expect(medkit.origin.z).toBe(72);
    expect(models.filter(entity => entity.model.path === "models/powerups/kamikazi.md3")).toHaveLength(3);
    a.entities.length = 0; a.state.time = 1250; a.presenter.player(a.entity);
    const shield = a.entities.find(entity => entity.kind === "model" && entity.model.path === "models/powerups/shield/shield.md3");
    if (shield?.kind !== "model") throw new Error("Missing shield"); expect(shield.axis[0].x).toBe(1);
    a.entity.currentState.powerups = 0; a.entity.currentState.eFlags = 1; a.entity.currentState.generic1 = 0; a.state.time = 1375; a.entities.length = 0; a.presenter.player(a.entity);
    const fading = a.entities.find(entity => entity.kind === "model" && entity.model.path === "models/powerups/shield/shield.md3");
    if (fading?.kind !== "model") throw new Error("Missing fading shield"); expect(fading.axis[0].x).toBe(0.5);
    expect(at(a.state.skullTrails, 1).numPositions).toBe(0);
  });
  test("Harvester zero-token corpses render without corrupting unrelated client skull trails", async () => {
    const a = await presentation("missionpack"); a.options.gameType = GameType.GT_HARVESTER;
    const trail = at(a.state.skullTrails, 1); trail.numPositions = 2; trail.positions[0] = vec3(1, 2, 3);
    a.entity.currentState.number = 100; a.entity.currentState.eFlags = 1; a.entity.currentState.generic1 = 0;
    a.presenter.player(a.entity); expect(a.entities).toHaveLength(3); expect(trail.numPositions).toBe(2); expect(trail.positions[0]).toEqual(vec3(1, 2, 3));
    a.entity.currentState.generic1 = 1; expect(() => a.presenter.player(a.entity)).toThrow("skull trail");
  });
  test("retail player renders through actual CPU and optional OpenGL scenes", async () => {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
    const cvars = new CvarRegistry(), registered = new RegisteredRendererCvars(cvars, "linux");
    const images = new RendererImageCatalog();
    const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "cg_players retail", width: 128, height: 128, backend: "gl", hidden: true }) : null;
    const gl = window === null ? null : new GlRenderer(window, images);
    const settings = new SourceRendererSettings(registered, { textureUnits: 2, textureEnvAdd: true });
    gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
      if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
    });
    const cpu = new SoftwareRenderer(128, 128, images, gl?.subpixelBits), recording = new BatchRecordingBackend(cpu);
    const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
    const builtins = new BuiltinImages(images, identityImageUploadProfile), mixer = new AudioMixer(22050, () => 0), clock = { milliseconds: () => 1000 };
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => mixer }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
      console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
    let commands: RenderCommandBuffer | null = null;
    try {
      const resources = await RendererResources.create(assets, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
      commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
      const a = await presentation("baseq3", { assets, resources }), refdef = createRefdef();
      refdef.width = 128; refdef.height = 128; refdef.fovX = 90; refdef.fovY = 90;
      refdef.viewOrigin = vec3(100, 0, 36); refdef.viewAxis = anglesToAxis(vec3(0, 180, 0));
      refdef.time = 1000; refdef.renderFlags = RDF_NOWORLDMODEL;
      a.entity.lerpOrigin = vec3(0, 0, 0); a.presenter.player(a.entity);
      commands.addView({ viewport: { x: 0, y: 0, width: 128, height: 128 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
      commands.addPreparedViews(resources.prepareFrame({ refdef, entities: a.entities }));
      commands.submit();
      expect(recording.trace().slice(1).length).toBeGreaterThan(0);
      expect(recording.trace().flatMap(view => view.batches).length).toBeGreaterThan(0);
      expect(cpu.pixels.some((value, index) => index % 4 !== 3 && value > 20)).toBe(true);
      if (gl !== null) expect(gl.readPixels().some((value, index) => index % 4 !== 3 && value > 20)).toBe(true);
      cvars.set("cg_shadows", "3"); a.options.shadows = 3; a.entity.currentState.number = 0;
      a.entity.lerpOrigin = a.world.initialCamera().origin; a.entities.length = 0; a.presenter.player(a.entity);
      const models = a.entities.filter(entity => entity.kind === "model");
      expect(models).toHaveLength(3);
      expect(models.every(entity => (entity.renderFlags & (RF_THIRD_PERSON | RF_SHADOW_PLANE)) === (RF_THIRD_PERSON | RF_SHADOW_PLANE))).toBe(true);
      expect(models.every(entity => entity.shadowPlane < entity.lightingOrigin.z)).toBe(true);
      refdef.renderFlags = 0;
      refdef.viewOrigin = vec3(a.entity.lerpOrigin.x + 100, a.entity.lerpOrigin.y, a.entity.lerpOrigin.z + 90);
      refdef.viewAxis = anglesToAxis(vec3(35, 180, 0));
      commands.addPreparedViews(a.world.prepareFrame({ refdef })); commands.submit();
      const before = new Uint8Array(cpu.pixels), beforeGl = gl?.readPixels();
      const viewCount = recording.trace().length;
      commands.addPreparedViews(a.world.prepareFrame({ refdef, entities: a.entities })); commands.submit();
      const shadowBatches = recording.trace().slice(viewCount).flatMap(view => view.batches).filter(batch => batch.state.polygonOffset !== undefined
        && batch.vertices.every(vertex => vertex.color.x === 0 && vertex.color.y === 0 && vertex.color.z === 0));
      expect(shadowBatches.length).toBeGreaterThan(0);
      expect(cpu.pixels).not.toEqual(before);
      if (gl !== null) expect(gl.readPixels()).not.toEqual(beforeGl);
    } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
  });
});
