// Registration from id Software's code/cgame/cg_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import { vec3 } from "../core/math.ts";
import { modelBounds } from "../render/model-bounds.ts";
import type { Vec3 } from "../core/math.ts";
import { DEFAULT_MODEL } from "../render/ref-entity.ts";
import type { SceneModel, SceneShader, SceneSkin } from "../render/ref-entity.ts";
import { createRefdef } from "../render/refdef.ts";
import type { RendererResources, WorldScene } from "../render/world.ts";
import { GameType, MAX_ITEMS } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { itemAt, itemList } from "../shared/items.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";
import type { ClientInfoStore } from "./players.ts";
import type { ClientServerCommandRuntime } from "./server-commands.ts";
import { ClientWeaponMediaRegistry } from "./weapons.ts";
import { loadParticleAnimations } from "./particles.ts";
import type { ParticleAnimations } from "./particles.ts";
import type { ClientSoundBank } from "./sound-bank.ts";
import type { PacketEntityMedia } from "./entities.ts";
import type { PlayerMedia, MissionPlayerMedia } from "./players.ts";
import type { ClientEventMedia } from "./events.ts";
import type { EffectMedia } from "./effects.ts";
import type { LocalEntityMedia, MissionLocalEntityMedia } from "./local-entities.ts";
import type { ParticleMedia } from "./particles.ts";
import type { WeaponPresentationMedia } from "./weapons.ts";

export class ClientMediaSounds {
  oneMinuteSound: PcmSound | null = null;
  fiveMinuteSound: PcmSound | null = null;
  suddenDeathSound: PcmSound | null = null;
  oneFragSound: PcmSound | null = null;
  twoFragSound: PcmSound | null = null;
  threeFragSound: PcmSound | null = null;
  count3Sound: PcmSound | null = null;
  count2Sound: PcmSound | null = null;
  count1Sound: PcmSound | null = null;
  countFightSound: PcmSound | null = null;
  countPrepareSound: PcmSound | null = null;
  countPrepareTeamSound: PcmSound | null = null;
  captureAwardSound: PcmSound | null = null;
  redLeadsSound: PcmSound | null = null;
  blueLeadsSound: PcmSound | null = null;
  teamsTiedSound: PcmSound | null = null;
  hitTeamSound: PcmSound | null = null;
  redScoredSound: PcmSound | null = null;
  blueScoredSound: PcmSound | null = null;
  captureYourTeamSound: PcmSound | null = null;
  captureOpponentSound: PcmSound | null = null;
  returnYourTeamSound: PcmSound | null = null;
  returnOpponentSound: PcmSound | null = null;
  takenYourTeamSound: PcmSound | null = null;
  takenOpponentSound: PcmSound | null = null;
  redFlagReturnedSound: PcmSound | null = null;
  blueFlagReturnedSound: PcmSound | null = null;
  enemyTookYourFlagSound: PcmSound | null = null;
  yourTeamTookEnemyFlagSound: PcmSound | null = null;
  neutralFlagReturnedSound: PcmSound | null = null;
  yourTeamTookTheFlagSound: PcmSound | null = null;
  enemyTookTheFlagSound: PcmSound | null = null;
  youHaveFlagSound: PcmSound | null = null;
  holyShitSound: PcmSound | null = null;
  yourBaseIsUnderAttackSound: PcmSound | null = null;
  tracerSound: PcmSound | null = null;
  selectSound: PcmSound | null = null;
  wearOffSound: PcmSound | null = null;
  useNothingSound: PcmSound | null = null;
  gibSound: PcmSound | null = null;
  gibBounce1Sound: PcmSound | null = null;
  gibBounce2Sound: PcmSound | null = null;
  gibBounce3Sound: PcmSound | null = null;
  useInvulnerabilitySound: PcmSound | null = null;
  invulnerabilityImpactSound1: PcmSound | null = null;
  invulnerabilityImpactSound2: PcmSound | null = null;
  invulnerabilityImpactSound3: PcmSound | null = null;
  invulnerabilityJuicedSound: PcmSound | null = null;
  obeliskHitSound1: PcmSound | null = null;
  obeliskHitSound2: PcmSound | null = null;
  obeliskHitSound3: PcmSound | null = null;
  obeliskRespawnSound: PcmSound | null = null;
  ammoregenSound: PcmSound | null = null;
  doublerSound: PcmSound | null = null;
  guardSound: PcmSound | null = null;
  scoutSound: PcmSound | null = null;
  teleInSound: PcmSound | null = null;
  teleOutSound: PcmSound | null = null;
  respawnSound: PcmSound | null = null;
  noAmmoSound: PcmSound | null = null;
  talkSound: PcmSound | null = null;
  landSound: PcmSound | null = null;
  hitSound: PcmSound | null = null;
  hitSoundHighArmor: PcmSound | null = null;
  hitSoundLowArmor: PcmSound | null = null;
  impressiveSound: PcmSound | null = null;
  excellentSound: PcmSound | null = null;
  deniedSound: PcmSound | null = null;
  humiliationSound: PcmSound | null = null;
  assistSound: PcmSound | null = null;
  defendSound: PcmSound | null = null;
  firstImpressiveSound: PcmSound | null = null;
  firstExcellentSound: PcmSound | null = null;
  firstHumiliationSound: PcmSound | null = null;
  takenLeadSound: PcmSound | null = null;
  tiedLeadSound: PcmSound | null = null;
  lostLeadSound: PcmSound | null = null;
  voteNow: PcmSound | null = null;
  votePassed: PcmSound | null = null;
  voteFailed: PcmSound | null = null;
  watrInSound: PcmSound | null = null;
  watrOutSound: PcmSound | null = null;
  watrUnSound: PcmSound | null = null;
  jumpPadSound: PcmSound | null = null;
  flightSound: PcmSound | null = null;
  medkitSound: PcmSound | null = null;
  quadSound: PcmSound | null = null;
  sfx_ric1: PcmSound | null = null;
  sfx_ric2: PcmSound | null = null;
  sfx_ric3: PcmSound | null = null;
  sfx_railg: PcmSound | null = null;
  sfx_rockexp: PcmSound | null = null;
  sfx_plasmaexp: PcmSound | null = null;
  sfx_proxexp: PcmSound | null = null;
  sfx_nghit: PcmSound | null = null;
  sfx_nghitflesh: PcmSound | null = null;
  sfx_nghitmetal: PcmSound | null = null;
  sfx_chghit: PcmSound | null = null;
  sfx_chghitflesh: PcmSound | null = null;
  sfx_chghitmetal: PcmSound | null = null;
  weaponHoverSound: PcmSound | null = null;
  kamikazeExplodeSound: PcmSound | null = null;
  kamikazeImplodeSound: PcmSound | null = null;
  kamikazeFarSound: PcmSound | null = null;
  winnerSound: PcmSound | null = null;
  loserSound: PcmSound | null = null;
  youSuckSound: PcmSound | null = null;
  wstbimplSound: PcmSound | null = null;
  wstbimpmSound: PcmSound | null = null;
  wstbimpdSound: PcmSound | null = null;
  wstbactvSound: PcmSound | null = null;
  regenSound: PcmSound | null = null;
  protectSound: PcmSound | null = null;
  n_healthSound: PcmSound | null = null;
  hgrenb1aSound: PcmSound | null = null;
  hgrenb2aSound: PcmSound | null = null;
}
export class ClientMediaGraphics {
  charsetShader: SceneShader | null = null;
  whiteShader: SceneShader | null = null;
  charsetProp: SceneShader | null = null;
  charsetPropGlow: SceneShader | null = null;
  charsetPropB: SceneShader | null = null;
  readonly numberShaders: [SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null, null, null, null, null, null, null, null, null];
  readonly botSkillShaders: [SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null, null, null];
  viewBloodShader: SceneShader | null = null;
  deferShader: SceneShader | null = null;
  scoreboardName: SceneShader | null = null;
  scoreboardPing: SceneShader | null = null;
  scoreboardScore: SceneShader | null = null;
  scoreboardTime: SceneShader | null = null;
  smokePuffShader: SceneShader | null = null;
  smokePuffRageProShader: SceneShader | null = null;
  shotgunSmokePuffShader: SceneShader | null = null;
  nailPuffShader: SceneShader | null = null;
  blueProxMine: SceneModel = DEFAULT_MODEL;
  plasmaBallShader: SceneShader | null = null;
  bloodTrailShader: SceneShader | null = null;
  lagometerShader: SceneShader | null = null;
  connectionShader: SceneShader | null = null;
  waterBubbleShader: SceneShader | null = null;
  tracerShader: SceneShader | null = null;
  selectShader: SceneShader | null = null;
  readonly crosshairShader: [SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null, null, null, null, null, null, null, null];
  backTileShader: SceneShader | null = null;
  noammoShader: SceneShader | null = null;
  quadShader: SceneShader | null = null;
  quadWeaponShader: SceneShader | null = null;
  battleSuitShader: SceneShader | null = null;
  battleWeaponShader: SceneShader | null = null;
  invisShader: SceneShader | null = null;
  regenShader: SceneShader | null = null;
  hastePuffShader: SceneShader | null = null;
  redCubeModel: SceneModel = DEFAULT_MODEL;
  blueCubeModel: SceneModel = DEFAULT_MODEL;
  redCubeIcon: SceneShader | null = null;
  blueCubeIcon: SceneShader | null = null;
  redFlagModel: SceneModel = DEFAULT_MODEL;
  blueFlagModel: SceneModel = DEFAULT_MODEL;
  readonly redFlagShader: [SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null];
  readonly blueFlagShader: [SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null];
  flagPoleModel: SceneModel = DEFAULT_MODEL;
  flagFlapModel: SceneModel = DEFAULT_MODEL;
  redFlagFlapSkin: SceneSkin | null = null;
  blueFlagFlapSkin: SceneSkin | null = null;
  neutralFlagFlapSkin: SceneSkin | null = null;
  redFlagBaseModel: SceneModel = DEFAULT_MODEL;
  blueFlagBaseModel: SceneModel = DEFAULT_MODEL;
  neutralFlagBaseModel: SceneModel = DEFAULT_MODEL;
  neutralFlagModel: SceneModel = DEFAULT_MODEL;
  readonly flagShader: [SceneShader | null, SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null, null];
  overloadBaseModel: SceneModel = DEFAULT_MODEL;
  overloadTargetModel: SceneModel = DEFAULT_MODEL;
  overloadLightsModel: SceneModel = DEFAULT_MODEL;
  overloadEnergyModel: SceneModel = DEFAULT_MODEL;
  harvesterModel: SceneModel = DEFAULT_MODEL;
  harvesterRedSkin: SceneSkin | null = null;
  harvesterBlueSkin: SceneSkin | null = null;
  harvesterNeutralModel: SceneModel = DEFAULT_MODEL;
  redKamikazeShader: SceneShader | null = null;
  dustPuffShader: SceneShader | null = null;
  friendShader: SceneShader | null = null;
  redQuadShader: SceneShader | null = null;
  teamStatusBar: SceneShader | null = null;
  blueKamikazeShader: SceneShader | null = null;
  armorModel: SceneModel = DEFAULT_MODEL;
  armorIcon: SceneShader | null = null;
  machinegunBrassModel: SceneModel = DEFAULT_MODEL;
  shotgunBrassModel: SceneModel = DEFAULT_MODEL;
  gibAbdomen: SceneModel = DEFAULT_MODEL;
  gibArm: SceneModel = DEFAULT_MODEL;
  gibChest: SceneModel = DEFAULT_MODEL;
  gibFist: SceneModel = DEFAULT_MODEL;
  gibFoot: SceneModel = DEFAULT_MODEL;
  gibForearm: SceneModel = DEFAULT_MODEL;
  gibIntestine: SceneModel = DEFAULT_MODEL;
  gibLeg: SceneModel = DEFAULT_MODEL;
  gibSkull: SceneModel = DEFAULT_MODEL;
  gibBrain: SceneModel = DEFAULT_MODEL;
  smoke2: SceneModel = DEFAULT_MODEL;
  balloonShader: SceneShader | null = null;
  bloodExplosionShader: SceneShader | null = null;
  bulletFlashModel: SceneModel = DEFAULT_MODEL;
  ringFlashModel: SceneModel = DEFAULT_MODEL;
  dishFlashModel: SceneModel = DEFAULT_MODEL;
  teleportEffectModel: SceneModel = DEFAULT_MODEL;
  teleportEffectShader: SceneShader | null = null;
  kamikazeEffectModel: SceneModel = DEFAULT_MODEL;
  kamikazeShockWave: SceneModel = DEFAULT_MODEL;
  kamikazeHeadModel: SceneModel = DEFAULT_MODEL;
  kamikazeHeadTrail: SceneModel = DEFAULT_MODEL;
  guardPowerupModel: SceneModel = DEFAULT_MODEL;
  scoutPowerupModel: SceneModel = DEFAULT_MODEL;
  doublerPowerupModel: SceneModel = DEFAULT_MODEL;
  ammoRegenPowerupModel: SceneModel = DEFAULT_MODEL;
  invulnerabilityImpactModel: SceneModel = DEFAULT_MODEL;
  invulnerabilityJuicedModel: SceneModel = DEFAULT_MODEL;
  medkitUsageModel: SceneModel = DEFAULT_MODEL;
  heartShader: SceneShader | null = null;
  invulnerabilityPowerupModel: SceneModel = DEFAULT_MODEL;
  medalImpressive: SceneShader | null = null;
  medalExcellent: SceneShader | null = null;
  medalGauntlet: SceneShader | null = null;
  medalDefend: SceneShader | null = null;
  medalAssist: SceneShader | null = null;
  medalCapture: SceneShader | null = null;
  bulletMarkShader: SceneShader | null = null;
  burnMarkShader: SceneShader | null = null;
  holeMarkShader: SceneShader | null = null;
  energyMarkShader: SceneShader | null = null;
  shadowMarkShader: SceneShader | null = null;
  wakeMarkShader: SceneShader | null = null;
  bloodMarkShader: SceneShader | null = null;
  patrolShader: SceneShader | null = null;
  assaultShader: SceneShader | null = null;
  campShader: SceneShader | null = null;
  followShader: SceneShader | null = null;
  defendShader: SceneShader | null = null;
  teamLeaderShader: SceneShader | null = null;
  retrieveShader: SceneShader | null = null;
  escortShader: SceneShader | null = null;
  cursor: SceneShader | null = null;
  sizeCursor: SceneShader | null = null;
  selectCursor: SceneShader | null = null;
  readonly flagShaders: [SceneShader | null, SceneShader | null, SceneShader | null] = [null, null, null];
}
export interface ClientMediaSettings { readonly buildScript: boolean }
export interface ClientMediaHost {
  readonly state: ClientGameState;
  readonly staticState: ClientGameStaticState;
  readonly clients: Pick<ClientInfoStore, "newClientInfo" | "clientInfo">;
  readonly commands: Pick<ClientServerCommandRuntime, "loadVoiceChats" | "buildSpectatorString">;
  /** The cgame-owned configstring snapshot, not a fresh engine gamestate. */
  configString(index: number): string;
  /** Cached VM cvars; buildScript is cg_buildScript registered as com_buildScript. */
  settings(): ClientMediaSettings;
  loadingString(text: string): Promise<void>;
  loadingItem(index: number): Promise<void>;
  loadingClient(index: number): Promise<void>;
  clearScene(): void;
}
export interface RegisteredClientGraphics { readonly world: WorldScene; readonly particleAnimations: ParticleAnimations }
type Footsteps = "normal" | "boot" | "flesh" | "mech" | "energy" | "splash" | "metal";
type FootstepSounds = [PcmSound | null, PcmSound | null, PcmSound | null, PcmSound | null];

/** Map-lifetime cgs.media; renderer handles and engine-lifetime PCM remain externally owned. */
export class ClientMedia {
  readonly sounds = new ClientMediaSounds();
  readonly graphics = new ClientMediaGraphics();
  readonly weaponRegistry: ClientWeaponMediaRegistry;
  readonly footsteps: Record<Footsteps, FootstepSounds> = {
    normal: [null, null, null, null], boot: [null, null, null, null], flesh: [null, null, null, null], mech: [null, null, null, null],
    energy: [null, null, null, null], splash: [null, null, null, null], metal: [null, null, null, null],
  };
  readonly inlineModels: { readonly model: SceneModel; readonly midpoint: Vec3 }[] = [{ model: DEFAULT_MODEL, midpoint: vec3(0, 0, 0) }];
  constructor(readonly product: Product, readonly staticState: ClientGameStaticState, readonly resources: RendererResources, readonly soundBank: ClientSoundBank) {
    if (product !== staticState.product) throw new Error("Client media product differs from cgs");
    this.weaponRegistry = new ClientWeaponMediaRegistry(product, resources, soundBank);
  }

  get events(): ClientEventMedia {
    return { sounds: this.sounds, footsteps: this.footsteps, gameSounds: this.staticState.gameSounds, smokePuffShader: this.graphics.smokePuffShader };
  }
  get players(): PlayerMedia { return { ...this.graphics, flightSound: this.sounds.flightSound }; }
  get missionPlayers(): MissionPlayerMedia {
    if (this.product !== "missionpack") throw new Error("Mission player media requested in baseq3");
    return this.graphics;
  }
  get packet(): PacketEntityMedia {
    const g = this.graphics, s = this.sounds;
    return {
      gameModels: this.staticState.gameModels, gameSounds: this.staticState.gameSounds, inlineModels: this.inlineModels,
      items: this.weaponRegistry.items, weapons: this.weaponRegistry.weapons, plasmaBallShader: g.plasmaBallShader,
      redFlagBaseModel: g.redFlagBaseModel, blueFlagBaseModel: g.blueFlagBaseModel, neutralFlagBaseModel: g.neutralFlagBaseModel,
      variant: this.product === "baseq3" ? { product: "baseq3" } : {
        product: "missionpack", media: {
          ...g, weaponHoverSound: s.weaponHoverSound, obeliskRespawnSound: s.obeliskRespawnSound,
        }
      },
    };
  }
  get effects(): EffectMedia {
    const g = this.graphics, s = this.sounds, weaponEffects = this.weaponRegistry.effects;
    return {
      ...g, variant: this.product === "baseq3" ? { product: "baseq3", teleportEffectShader: g.teleportEffectShader }
        : {
          product: "missionpack", media: {
            ...g,
            get lightningShader() { return weaponEffects.lightningShader; },
            get rocketExplosionShader() { return weaponEffects.rocketExplosionShader; },
            obeliskHitSounds: [s.obeliskHitSound1, s.obeliskHitSound2, s.obeliskHitSound3],
            invulnerabilityImpactSounds: [s.invulnerabilityImpactSound1, s.invulnerabilityImpactSound2, s.invulnerabilityImpactSound3],
            invulnerabilityJuicedSound: s.invulnerabilityJuicedSound,
          }
        },
    };
  }
  get particles(): ParticleMedia {
    return {
      tracerShader: this.graphics.tracerShader, smokePuffShader: this.graphics.smokePuffShader,
      waterBubbleShader: this.graphics.waterBubbleShader
    };
  }
  get localEntities(): { readonly product: "baseq3"; readonly media: LocalEntityMedia } | { readonly product: "missionpack"; readonly media: MissionLocalEntityMedia } {
    const g = this.graphics, s = this.sounds, n = g.numberShaders;
    const media: LocalEntityMedia = {
      bloodTrailShader: g.bloodTrailShader, bloodMarkShader: g.bloodMarkShader, burnMarkShader: g.burnMarkShader,
      numberShaders: n,
      gibBounceSounds: [s.gibBounce1Sound, s.gibBounce2Sound, s.gibBounce3Sound],
    };
    return this.product === "baseq3" ? { product: "baseq3", media } : {
      product: "missionpack", media: {
        ...media, kamikazeShockWave: g.kamikazeShockWave, kamikazeExplodeSound: s.kamikazeExplodeSound, kamikazeImplodeSound: s.kamikazeImplodeSound,
      }
    };
  }
  get weapons(): WeaponPresentationMedia {
    const g = this.graphics, s = this.sounds;
    return {
      models: { machinegunBrass: g.machinegunBrassModel, shotgunBrass: g.shotgunBrassModel, dishFlash: g.dishFlashModel, ringFlash: g.ringFlashModel, bulletFlash: g.bulletFlashModel },
      shaders: {
        smokePuff: g.smokePuffShader, nailPuff: g.nailPuffShader, shotgunSmokePuff: g.shotgunSmokePuffShader, invis: g.invisShader,
        battleWeapon: g.battleWeaponShader, quadWeapon: g.quadWeaponShader, select: g.selectShader, noammo: g.noammoShader,
        holeMark: g.holeMarkShader, burnMark: g.burnMarkShader, energyMark: g.energyMarkShader, bulletMark: g.bulletMarkShader, tracer: g.tracerShader
      },
      sounds: {
        quad: s.quadSound, nailHitFlesh: s.sfx_nghitflesh, nailHitMetal: s.sfx_nghitmetal, nailHit: s.sfx_nghit, proxExplosion: s.sfx_proxexp,
        rocketExplosion: s.sfx_rockexp, plasmaExplosion: s.sfx_plasmaexp, chaingunHitFlesh: s.sfx_chghitflesh, chaingunHitMetal: s.sfx_chghitmetal,
        chaingunHit: s.sfx_chghit, ricochet1: s.sfx_ric1, ricochet2: s.sfx_ric2, ricochet3: s.sfx_ric3, tracer: s.tracerSound
      },
    };
  }
}

function validate(media: ClientMedia, host: ClientMediaHost): void {
  if (media.staticState !== host.staticState || media.product !== host.state.product) throw new Error("Client media registration requires its canonical cgame state");
}

function itemBits(host: ClientMediaHost): string {
  const bits = host.configString(27);
  if (bits.length > MAX_ITEMS) throw new RangeError("CS_ITEMS exceeds source MAX_ITEMS precache buffer");
  return bits;
}

export async function registerItemSounds(media: ClientMedia, number: number): Promise<void> {
  const item = itemAt(media.product, number);
  if (item.pickupSound !== null) await media.soundBank.registerSound(item.pickupSound, false);
  let offset = 0;
  while (offset < item.sounds.length) {
    const start = offset;
    while (offset < item.sounds.length && item.sounds[offset] !== " ") offset++;
    const len = offset - start;
    if (len >= 64 || len < 5) throw new Error(`PrecacheItem: ${item.className} has bad precache string`);
    const name = item.sounds.slice(start, offset);
    if (offset < item.sounds.length) offset++;
    if (name.slice(-3) === "wav") await media.soundBank.registerSound(name, false);
  }
}

/** CG_Init prepares these five handles before cvars, commands or any screen updates. */
export async function registerClientLoadingGraphics(media: ClientMedia): Promise<void> {
  media.graphics.charsetShader = await media.resources.registerShader("gfx/2d/bigchars");
  media.graphics.whiteShader = await media.resources.registerShader("white");
  media.graphics.charsetProp = await media.resources.registerShaderNoMip("menu/art/font1_prop.tga");
  media.graphics.charsetPropGlow = await media.resources.registerShaderNoMip("menu/art/font1_prop_glo.tga");
  media.graphics.charsetPropB = await media.resources.registerShaderNoMip("menu/art/font2_prop.tga");
}

export async function registerClientSounds(media: ClientMedia, host: ClientMediaHost): Promise<void> {
  validate(media, host);
  const mission = media.product === "missionpack", gameType = media.staticState.gameType;
  if (mission) {
    await host.commands.loadVoiceChats();
  }
  media.sounds.oneMinuteSound = await media.soundBank.registerSound("sound/feedback/1_minute.wav", true);
  media.sounds.fiveMinuteSound = await media.soundBank.registerSound("sound/feedback/5_minute.wav", true);
  media.sounds.suddenDeathSound = await media.soundBank.registerSound("sound/feedback/sudden_death.wav", true);
  media.sounds.oneFragSound = await media.soundBank.registerSound("sound/feedback/1_frag.wav", true);
  media.sounds.twoFragSound = await media.soundBank.registerSound("sound/feedback/2_frags.wav", true);
  media.sounds.threeFragSound = await media.soundBank.registerSound("sound/feedback/3_frags.wav", true);
  media.sounds.count3Sound = await media.soundBank.registerSound("sound/feedback/three.wav", true);
  media.sounds.count2Sound = await media.soundBank.registerSound("sound/feedback/two.wav", true);
  media.sounds.count1Sound = await media.soundBank.registerSound("sound/feedback/one.wav", true);
  media.sounds.countFightSound = await media.soundBank.registerSound("sound/feedback/fight.wav", true);
  media.sounds.countPrepareSound = await media.soundBank.registerSound("sound/feedback/prepare.wav", true);
  if (mission) {
    media.sounds.countPrepareTeamSound = await media.soundBank.registerSound("sound/feedback/prepare_team.wav", true);
  }
  if (gameType >= GameType.GT_TEAM || host.settings().buildScript) {
    media.sounds.captureAwardSound = await media.soundBank.registerSound("sound/teamplay/flagcapture_yourteam.wav", true);
    media.sounds.redLeadsSound = await media.soundBank.registerSound("sound/feedback/redleads.wav", true);
    media.sounds.blueLeadsSound = await media.soundBank.registerSound("sound/feedback/blueleads.wav", true);
    media.sounds.teamsTiedSound = await media.soundBank.registerSound("sound/feedback/teamstied.wav", true);
    media.sounds.hitTeamSound = await media.soundBank.registerSound("sound/feedback/hit_teammate.wav", true);
    media.sounds.redScoredSound = await media.soundBank.registerSound("sound/teamplay/voc_red_scores.wav", true);
    media.sounds.blueScoredSound = await media.soundBank.registerSound("sound/teamplay/voc_blue_scores.wav", true);
    media.sounds.captureYourTeamSound = await media.soundBank.registerSound("sound/teamplay/flagcapture_yourteam.wav", true);
    media.sounds.captureOpponentSound = await media.soundBank.registerSound("sound/teamplay/flagcapture_opponent.wav", true);
    media.sounds.returnYourTeamSound = await media.soundBank.registerSound("sound/teamplay/flagreturn_yourteam.wav", true);
    media.sounds.returnOpponentSound = await media.soundBank.registerSound("sound/teamplay/flagreturn_opponent.wav", true);
    media.sounds.takenYourTeamSound = await media.soundBank.registerSound("sound/teamplay/flagtaken_yourteam.wav", true);
    media.sounds.takenOpponentSound = await media.soundBank.registerSound("sound/teamplay/flagtaken_opponent.wav", true);
    if (gameType === GameType.GT_CTF || host.settings().buildScript) {
      media.sounds.redFlagReturnedSound = await media.soundBank.registerSound("sound/teamplay/voc_red_returned.wav", true);
      media.sounds.blueFlagReturnedSound = await media.soundBank.registerSound("sound/teamplay/voc_blue_returned.wav", true);
      media.sounds.enemyTookYourFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_enemy_flag.wav", true);
      media.sounds.yourTeamTookEnemyFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_team_flag.wav", true);
    }
    if (mission) {
      if (gameType === GameType.GT_1FCTF || host.settings().buildScript) {
        media.sounds.neutralFlagReturnedSound = await media.soundBank.registerSound("sound/teamplay/flagreturn_opponent.wav", true);
        media.sounds.yourTeamTookTheFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_team_1flag.wav", true);
        media.sounds.enemyTookTheFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_enemy_1flag.wav", true);
      }
      if (gameType === GameType.GT_1FCTF || gameType === GameType.GT_CTF || host.settings().buildScript) {
        media.sounds.youHaveFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_you_flag.wav", true);
        media.sounds.holyShitSound = await media.soundBank.registerSound("sound/feedback/voc_holyshit.wav", true);
      }
      if (gameType === GameType.GT_OBELISK || host.settings().buildScript) {
        media.sounds.yourBaseIsUnderAttackSound = await media.soundBank.registerSound("sound/teamplay/voc_base_attack.wav", true);
      }
    } else {
      media.sounds.youHaveFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_you_flag.wav", true);
      media.sounds.holyShitSound = await media.soundBank.registerSound("sound/feedback/voc_holyshit.wav", true);
      media.sounds.neutralFlagReturnedSound = await media.soundBank.registerSound("sound/teamplay/flagreturn_opponent.wav", true);
      media.sounds.yourTeamTookTheFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_team_1flag.wav", true);
      media.sounds.enemyTookTheFlagSound = await media.soundBank.registerSound("sound/teamplay/voc_enemy_1flag.wav", true);
    }
  }
  media.sounds.tracerSound = await media.soundBank.registerSound("sound/weapons/machinegun/buletby1.wav", false);
  media.sounds.selectSound = await media.soundBank.registerSound("sound/weapons/change.wav", false);
  media.sounds.wearOffSound = await media.soundBank.registerSound("sound/items/wearoff.wav", false);
  media.sounds.useNothingSound = await media.soundBank.registerSound("sound/items/use_nothing.wav", false);
  media.sounds.gibSound = await media.soundBank.registerSound("sound/player/gibsplt1.wav", false);
  media.sounds.gibBounce1Sound = await media.soundBank.registerSound("sound/player/gibimp1.wav", false);
  media.sounds.gibBounce2Sound = await media.soundBank.registerSound("sound/player/gibimp2.wav", false);
  media.sounds.gibBounce3Sound = await media.soundBank.registerSound("sound/player/gibimp3.wav", false);
  if (mission) {
    media.sounds.useInvulnerabilitySound = await media.soundBank.registerSound("sound/items/invul_activate.wav", false);
    media.sounds.invulnerabilityImpactSound1 = await media.soundBank.registerSound("sound/items/invul_impact_01.wav", false);
    media.sounds.invulnerabilityImpactSound2 = await media.soundBank.registerSound("sound/items/invul_impact_02.wav", false);
    media.sounds.invulnerabilityImpactSound3 = await media.soundBank.registerSound("sound/items/invul_impact_03.wav", false);
    media.sounds.invulnerabilityJuicedSound = await media.soundBank.registerSound("sound/items/invul_juiced.wav", false);
    media.sounds.obeliskHitSound1 = await media.soundBank.registerSound("sound/items/obelisk_hit_01.wav", false);
    media.sounds.obeliskHitSound2 = await media.soundBank.registerSound("sound/items/obelisk_hit_02.wav", false);
    media.sounds.obeliskHitSound3 = await media.soundBank.registerSound("sound/items/obelisk_hit_03.wav", false);
    media.sounds.obeliskRespawnSound = await media.soundBank.registerSound("sound/items/obelisk_respawn.wav", false);
    media.sounds.ammoregenSound = await media.soundBank.registerSound("sound/items/cl_ammoregen.wav", false);
    media.sounds.doublerSound = await media.soundBank.registerSound("sound/items/cl_doubler.wav", false);
    media.sounds.guardSound = await media.soundBank.registerSound("sound/items/cl_guard.wav", false);
    media.sounds.scoutSound = await media.soundBank.registerSound("sound/items/cl_scout.wav", false);
  }
  media.sounds.teleInSound = await media.soundBank.registerSound("sound/world/telein.wav", false);
  media.sounds.teleOutSound = await media.soundBank.registerSound("sound/world/teleout.wav", false);
  media.sounds.respawnSound = await media.soundBank.registerSound("sound/items/respawn1.wav", false);
  media.sounds.noAmmoSound = await media.soundBank.registerSound("sound/weapons/noammo.wav", false);
  media.sounds.talkSound = await media.soundBank.registerSound("sound/player/talk.wav", false);
  media.sounds.landSound = await media.soundBank.registerSound("sound/player/land1.wav", false);
  media.sounds.hitSound = await media.soundBank.registerSound("sound/feedback/hit.wav", false);
  if (mission) {
    media.sounds.hitSoundHighArmor = await media.soundBank.registerSound("sound/feedback/hithi.wav", false);
    media.sounds.hitSoundLowArmor = await media.soundBank.registerSound("sound/feedback/hitlo.wav", false);
  }
  media.sounds.impressiveSound = await media.soundBank.registerSound("sound/feedback/impressive.wav", true);
  media.sounds.excellentSound = await media.soundBank.registerSound("sound/feedback/excellent.wav", true);
  media.sounds.deniedSound = await media.soundBank.registerSound("sound/feedback/denied.wav", true);
  media.sounds.humiliationSound = await media.soundBank.registerSound("sound/feedback/humiliation.wav", true);
  media.sounds.assistSound = await media.soundBank.registerSound("sound/feedback/assist.wav", true);
  media.sounds.defendSound = await media.soundBank.registerSound("sound/feedback/defense.wav", true);
  if (mission) {
    media.sounds.firstImpressiveSound = await media.soundBank.registerSound("sound/feedback/first_impressive.wav", true);
    media.sounds.firstExcellentSound = await media.soundBank.registerSound("sound/feedback/first_excellent.wav", true);
    media.sounds.firstHumiliationSound = await media.soundBank.registerSound("sound/feedback/first_gauntlet.wav", true);
  }
  media.sounds.takenLeadSound = await media.soundBank.registerSound("sound/feedback/takenlead.wav", true);
  media.sounds.tiedLeadSound = await media.soundBank.registerSound("sound/feedback/tiedlead.wav", true);
  media.sounds.lostLeadSound = await media.soundBank.registerSound("sound/feedback/lostlead.wav", true);
  if (mission) {
    media.sounds.voteNow = await media.soundBank.registerSound("sound/feedback/vote_now.wav", true);
    media.sounds.votePassed = await media.soundBank.registerSound("sound/feedback/vote_passed.wav", true);
    media.sounds.voteFailed = await media.soundBank.registerSound("sound/feedback/vote_failed.wav", true);
  }
  media.sounds.watrInSound = await media.soundBank.registerSound("sound/player/watr_in.wav", false);
  media.sounds.watrOutSound = await media.soundBank.registerSound("sound/player/watr_out.wav", false);
  media.sounds.watrUnSound = await media.soundBank.registerSound("sound/player/watr_un.wav", false);
  media.sounds.jumpPadSound = await media.soundBank.registerSound("sound/world/jumppad.wav", false);

  const footstepPaths: readonly (readonly [Footsteps, string])[] = [
    ["normal", "step"], ["boot", "boot"], ["flesh", "flesh"], ["mech", "mech"], ["energy", "energy"], ["splash", "splash"], ["metal", "clank"],
  ];
  for (let i = 0; i < 4; i++) for (const [footstep, name] of footstepPaths) {
    media.footsteps[footstep][i] = await media.soundBank.registerSound(`sound/player/footsteps/${name}${i + 1}.wav`, false);
  }

  // Source copies CS_ITEMS, but its sound filtering condition is commented out.
  itemBits(host);
  for (let i = 1; i < itemList(media.product).length; i++) {
    await registerItemSounds(media, i);
  }
  for (let i = 1; i < 256; i++) {
    const soundName = host.configString(288 + i);
    if (soundName.length === 0) {
      break;
    }
    if (soundName[0] === '*') {
      continue;
    }
    media.staticState.gameSounds[i] = await media.soundBank.registerSound(soundName, false);
  }

  media.sounds.flightSound = await media.soundBank.registerSound("sound/items/flight.wav", false);
  media.sounds.medkitSound = await media.soundBank.registerSound("sound/items/use_medkit.wav", false);
  media.sounds.quadSound = await media.soundBank.registerSound("sound/items/damage3.wav", false);
  media.sounds.sfx_ric1 = await media.soundBank.registerSound("sound/weapons/machinegun/ric1.wav", false);
  media.sounds.sfx_ric2 = await media.soundBank.registerSound("sound/weapons/machinegun/ric2.wav", false);
  media.sounds.sfx_ric3 = await media.soundBank.registerSound("sound/weapons/machinegun/ric3.wav", false);
  media.sounds.sfx_railg = await media.soundBank.registerSound("sound/weapons/railgun/railgf1a.wav", false);
  media.sounds.sfx_rockexp = await media.soundBank.registerSound("sound/weapons/rocket/rocklx1a.wav", false);
  media.sounds.sfx_plasmaexp = await media.soundBank.registerSound("sound/weapons/plasma/plasmx1a.wav", false);
  if (mission) {
    media.sounds.sfx_proxexp = await media.soundBank.registerSound("sound/weapons/proxmine/wstbexpl.wav", false);
    media.sounds.sfx_nghit = await media.soundBank.registerSound("sound/weapons/nailgun/wnalimpd.wav", false);
    media.sounds.sfx_nghitflesh = await media.soundBank.registerSound("sound/weapons/nailgun/wnalimpl.wav", false);
    media.sounds.sfx_nghitmetal = await media.soundBank.registerSound("sound/weapons/nailgun/wnalimpm.wav", false);
    media.sounds.sfx_chghit = await media.soundBank.registerSound("sound/weapons/vulcan/wvulimpd.wav", false);
    media.sounds.sfx_chghitflesh = await media.soundBank.registerSound("sound/weapons/vulcan/wvulimpl.wav", false);
    media.sounds.sfx_chghitmetal = await media.soundBank.registerSound("sound/weapons/vulcan/wvulimpm.wav", false);
    media.sounds.weaponHoverSound = await media.soundBank.registerSound("sound/weapons/weapon_hover.wav", false);
    media.sounds.kamikazeExplodeSound = await media.soundBank.registerSound("sound/items/kam_explode.wav", false);
    media.sounds.kamikazeImplodeSound = await media.soundBank.registerSound("sound/items/kam_implode.wav", false);
    media.sounds.kamikazeFarSound = await media.soundBank.registerSound("sound/items/kam_explode_far.wav", false);
    media.sounds.winnerSound = await media.soundBank.registerSound("sound/feedback/voc_youwin.wav", false);
    media.sounds.loserSound = await media.soundBank.registerSound("sound/feedback/voc_youlose.wav", false);
    media.sounds.youSuckSound = await media.soundBank.registerSound("sound/misc/yousuck.wav", false);
    media.sounds.wstbimplSound = await media.soundBank.registerSound("sound/weapons/proxmine/wstbimpl.wav", false);
    media.sounds.wstbimpmSound = await media.soundBank.registerSound("sound/weapons/proxmine/wstbimpm.wav", false);
    media.sounds.wstbimpdSound = await media.soundBank.registerSound("sound/weapons/proxmine/wstbimpd.wav", false);
    media.sounds.wstbactvSound = await media.soundBank.registerSound("sound/weapons/proxmine/wstbactv.wav", false);
  }
  media.sounds.regenSound = await media.soundBank.registerSound("sound/items/regen.wav", false);
  media.sounds.protectSound = await media.soundBank.registerSound("sound/items/protect3.wav", false);
  media.sounds.n_healthSound = await media.soundBank.registerSound("sound/items/n_health.wav", false);
  media.sounds.hgrenb1aSound = await media.soundBank.registerSound("sound/weapons/grenade/hgrenb1a.wav", false);
  media.sounds.hgrenb2aSound = await media.soundBank.registerSound("sound/weapons/grenade/hgrenb2a.wav", false);
  if (mission) {
    await media.soundBank.registerSound("sound/player/james/death1.wav", false);
    await media.soundBank.registerSound("sound/player/james/death2.wav", false);
    await media.soundBank.registerSound("sound/player/james/death3.wav", false);
    await media.soundBank.registerSound("sound/player/james/jump1.wav", false);
    await media.soundBank.registerSound("sound/player/james/pain25_1.wav", false);
    await media.soundBank.registerSound("sound/player/james/pain75_1.wav", false);
    await media.soundBank.registerSound("sound/player/james/pain100_1.wav", false);
    await media.soundBank.registerSound("sound/player/james/falling1.wav", false);
    await media.soundBank.registerSound("sound/player/james/gasp.wav", false);
    await media.soundBank.registerSound("sound/player/james/drown.wav", false);
    await media.soundBank.registerSound("sound/player/james/fall1.wav", false);
    await media.soundBank.registerSound("sound/player/james/taunt.wav", false);
    await media.soundBank.registerSound("sound/player/janet/death1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/death2.wav", false);
    await media.soundBank.registerSound("sound/player/janet/death3.wav", false);
    await media.soundBank.registerSound("sound/player/janet/jump1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/pain25_1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/pain75_1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/pain100_1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/falling1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/gasp.wav", false);
    await media.soundBank.registerSound("sound/player/janet/drown.wav", false);
    await media.soundBank.registerSound("sound/player/janet/fall1.wav", false);
    await media.soundBank.registerSound("sound/player/janet/taunt.wav", false);
  }
}


/** CG_Init calls this once on its fresh media/weapon/item storage, not on map_restart. */
export async function registerClientGraphics(media: ClientMedia, host: ClientMediaHost): Promise<RegisteredClientGraphics> {
  validate(media, host);
  const mission = media.product === "missionpack", gameType = media.staticState.gameType;
  const resources = media.resources;
  host.state.refdef = createRefdef();
  host.clearScene();
  await host.loadingString(media.staticState.mapname);
  const world = await resources.loadWorld(media.staticState.mapname);

  await host.loadingString("game media");

  const numberNames = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "minus"];
  for (const [i, name] of numberNames.entries()) media.graphics.numberShaders[i] = await resources.registerShader(`gfx/2d/numbers/${name}_32b`);
  media.graphics.botSkillShaders[0] = await resources.registerShader("menu/art/skill1.tga");
  media.graphics.botSkillShaders[1] = await resources.registerShader("menu/art/skill2.tga");
  media.graphics.botSkillShaders[2] = await resources.registerShader("menu/art/skill3.tga");
  media.graphics.botSkillShaders[3] = await resources.registerShader("menu/art/skill4.tga");
  media.graphics.botSkillShaders[4] = await resources.registerShader("menu/art/skill5.tga");
  media.graphics.viewBloodShader = await resources.registerShader("viewBloodBlend");
  media.graphics.deferShader = await resources.registerShaderNoMip("gfx/2d/defer.tga");
  media.graphics.scoreboardName = await resources.registerShaderNoMip("menu/tab/name.tga");
  media.graphics.scoreboardPing = await resources.registerShaderNoMip("menu/tab/ping.tga");
  media.graphics.scoreboardScore = await resources.registerShaderNoMip("menu/tab/score.tga");
  media.graphics.scoreboardTime = await resources.registerShaderNoMip("menu/tab/time.tga");
  media.graphics.smokePuffShader = await resources.registerShader("smokePuff");
  media.graphics.smokePuffRageProShader = await resources.registerShader("smokePuffRagePro");
  media.graphics.shotgunSmokePuffShader = await resources.registerShader("shotgunSmokePuff");
  if (mission) {
    media.graphics.nailPuffShader = await resources.registerShader("nailtrail");
    media.graphics.blueProxMine = await resources.registerModel("models/weaphits/proxmineb.md3");
  }
  media.graphics.plasmaBallShader = await resources.registerShader("sprites/plasma1");
  media.graphics.bloodTrailShader = await resources.registerShader("bloodTrail");
  media.graphics.lagometerShader = await resources.registerShader("lagometer");
  media.graphics.connectionShader = await resources.registerShader("disconnected");
  media.graphics.waterBubbleShader = await resources.registerShader("waterBubble");
  media.graphics.tracerShader = await resources.registerShader("gfx/misc/tracer");
  media.graphics.selectShader = await resources.registerShader("gfx/2d/select");

  for (let i = 0; i < 10; i++) media.graphics.crosshairShader[i] = await resources.registerShader(`gfx/2d/crosshair${String.fromCharCode(97 + i)}`);
  media.graphics.backTileShader = await resources.registerShader("gfx/2d/backtile");
  media.graphics.noammoShader = await resources.registerShader("icons/noammo");

  media.graphics.quadShader = await resources.registerShader("powerups/quad");
  media.graphics.quadWeaponShader = await resources.registerShader("powerups/quadWeapon");
  media.graphics.battleSuitShader = await resources.registerShader("powerups/battleSuit");
  media.graphics.battleWeaponShader = await resources.registerShader("powerups/battleWeapon");
  media.graphics.invisShader = await resources.registerShader("powerups/invisibility");
  media.graphics.regenShader = await resources.registerShader("powerups/regen");
  media.graphics.hastePuffShader = await resources.registerShader("hasteSmokePuff");
  if (gameType === GameType.GT_CTF || mission && (gameType === GameType.GT_1FCTF || gameType === GameType.GT_HARVESTER) || host.settings().buildScript) {
    media.graphics.redCubeModel = await resources.registerModel("models/powerups/orb/r_orb.md3");
    media.graphics.blueCubeModel = await resources.registerModel("models/powerups/orb/b_orb.md3");
    media.graphics.redCubeIcon = await resources.registerShader("icons/skull_red");
    media.graphics.blueCubeIcon = await resources.registerShader("icons/skull_blue");
  }
  if (gameType === GameType.GT_CTF || mission && (gameType === GameType.GT_1FCTF || gameType === GameType.GT_HARVESTER) || host.settings().buildScript) {
    media.graphics.redFlagModel = await resources.registerModel("models/flags/r_flag.md3");
    media.graphics.blueFlagModel = await resources.registerModel("models/flags/b_flag.md3");
    media.graphics.redFlagShader[0] = await resources.registerShaderNoMip("icons/iconf_red1");
    media.graphics.redFlagShader[1] = await resources.registerShaderNoMip("icons/iconf_red2");
    media.graphics.redFlagShader[2] = await resources.registerShaderNoMip("icons/iconf_red3");
    media.graphics.blueFlagShader[0] = await resources.registerShaderNoMip("icons/iconf_blu1");
    media.graphics.blueFlagShader[1] = await resources.registerShaderNoMip("icons/iconf_blu2");
    media.graphics.blueFlagShader[2] = await resources.registerShaderNoMip("icons/iconf_blu3");
    if (mission) {
      media.graphics.flagPoleModel = await resources.registerModel("models/flag2/flagpole.md3");
      media.graphics.flagFlapModel = await resources.registerModel("models/flag2/flagflap3.md3");
      media.graphics.redFlagFlapSkin = await resources.registerSkin("models/flag2/red.skin");
      media.graphics.blueFlagFlapSkin = await resources.registerSkin("models/flag2/blue.skin");
      media.graphics.neutralFlagFlapSkin = await resources.registerSkin("models/flag2/white.skin");
      media.graphics.redFlagBaseModel = await resources.registerModel("models/mapobjects/flagbase/red_base.md3");
      media.graphics.blueFlagBaseModel = await resources.registerModel("models/mapobjects/flagbase/blue_base.md3");
      media.graphics.neutralFlagBaseModel = await resources.registerModel("models/mapobjects/flagbase/ntrl_base.md3");
    }
  }
  if (mission) {
    if (gameType === GameType.GT_1FCTF || host.settings().buildScript) {
      media.graphics.neutralFlagModel = await resources.registerModel("models/flags/n_flag.md3");
      media.graphics.flagShader[0] = await resources.registerShaderNoMip("icons/iconf_neutral1");
      media.graphics.flagShader[1] = await resources.registerShaderNoMip("icons/iconf_red2");
      media.graphics.flagShader[2] = await resources.registerShaderNoMip("icons/iconf_blu2");
      media.graphics.flagShader[3] = await resources.registerShaderNoMip("icons/iconf_neutral3");
    }
    if (gameType === GameType.GT_OBELISK || host.settings().buildScript) {
      media.graphics.overloadBaseModel = await resources.registerModel("models/powerups/overload_base.md3");
      media.graphics.overloadTargetModel = await resources.registerModel("models/powerups/overload_target.md3");
      media.graphics.overloadLightsModel = await resources.registerModel("models/powerups/overload_lights.md3");
      media.graphics.overloadEnergyModel = await resources.registerModel("models/powerups/overload_energy.md3");
    }
    if (gameType === GameType.GT_HARVESTER || host.settings().buildScript) {
      media.graphics.harvesterModel = await resources.registerModel("models/powerups/harvester/harvester.md3");
      media.graphics.harvesterRedSkin = await resources.registerSkin("models/powerups/harvester/red.skin");
      media.graphics.harvesterBlueSkin = await resources.registerSkin("models/powerups/harvester/blue.skin");
      media.graphics.harvesterNeutralModel = await resources.registerModel("models/powerups/obelisk/obelisk.md3");
    }
    media.graphics.redKamikazeShader = await resources.registerShader("models/weaphits/kamikred");
    media.graphics.dustPuffShader = await resources.registerShader("hasteSmokePuff");
  }
  if (gameType >= GameType.GT_TEAM || host.settings().buildScript) {
    media.graphics.friendShader = await resources.registerShader("sprites/foe");
    media.graphics.redQuadShader = await resources.registerShader("powerups/blueflag");
    media.graphics.teamStatusBar = await resources.registerShader("gfx/2d/colorbar.tga");
    if (mission) {
      media.graphics.blueKamikazeShader = await resources.registerShader("models/weaphits/kamikblu");
    }
  }
  media.graphics.armorModel = await resources.registerModel("models/powerups/armor/armor_yel.md3");
  media.graphics.armorIcon = await resources.registerShaderNoMip("icons/iconr_yellow");
  media.graphics.machinegunBrassModel = await resources.registerModel("models/weapons2/shells/m_shell.md3");
  media.graphics.shotgunBrassModel = await resources.registerModel("models/weapons2/shells/s_shell.md3");
  media.graphics.gibAbdomen = await resources.registerModel("models/gibs/abdomen.md3");
  media.graphics.gibArm = await resources.registerModel("models/gibs/arm.md3");
  media.graphics.gibChest = await resources.registerModel("models/gibs/chest.md3");
  media.graphics.gibFist = await resources.registerModel("models/gibs/fist.md3");
  media.graphics.gibFoot = await resources.registerModel("models/gibs/foot.md3");
  media.graphics.gibForearm = await resources.registerModel("models/gibs/forearm.md3");
  media.graphics.gibIntestine = await resources.registerModel("models/gibs/intestine.md3");
  media.graphics.gibLeg = await resources.registerModel("models/gibs/leg.md3");
  media.graphics.gibSkull = await resources.registerModel("models/gibs/skull.md3");
  media.graphics.gibBrain = await resources.registerModel("models/gibs/brain.md3");
  media.graphics.smoke2 = await resources.registerModel("models/weapons2/shells/s_shell.md3");
  media.graphics.balloonShader = await resources.registerShader("sprites/balloon3");
  media.graphics.bloodExplosionShader = await resources.registerShader("bloodExplosion");
  media.graphics.bulletFlashModel = await resources.registerModel("models/weaphits/bullet.md3");
  media.graphics.ringFlashModel = await resources.registerModel("models/weaphits/ring02.md3");
  media.graphics.dishFlashModel = await resources.registerModel("models/weaphits/boom01.md3");
  if (mission) {
    media.graphics.teleportEffectModel = await resources.registerModel("models/powerups/pop.md3");
  } else {
    media.graphics.teleportEffectModel = await resources.registerModel("models/misc/telep.md3");
    media.graphics.teleportEffectShader = await resources.registerShader("teleportEffect");
  }
  if (mission) {
    media.graphics.kamikazeEffectModel = await resources.registerModel("models/weaphits/kamboom2.md3");
    media.graphics.kamikazeShockWave = await resources.registerModel("models/weaphits/kamwave.md3");
    media.graphics.kamikazeHeadModel = await resources.registerModel("models/powerups/kamikazi.md3");
    media.graphics.kamikazeHeadTrail = await resources.registerModel("models/powerups/trailtest.md3");
    media.graphics.guardPowerupModel = await resources.registerModel("models/powerups/guard_player.md3");
    media.graphics.scoutPowerupModel = await resources.registerModel("models/powerups/scout_player.md3");
    media.graphics.doublerPowerupModel = await resources.registerModel("models/powerups/doubler_player.md3");
    media.graphics.ammoRegenPowerupModel = await resources.registerModel("models/powerups/ammo_player.md3");
    media.graphics.invulnerabilityImpactModel = await resources.registerModel("models/powerups/shield/impact.md3");
    media.graphics.invulnerabilityJuicedModel = await resources.registerModel("models/powerups/shield/juicer.md3");
    media.graphics.medkitUsageModel = await resources.registerModel("models/powerups/regen.md3");
    media.graphics.heartShader = await resources.registerShaderNoMip("ui/assets/statusbar/selectedhealth.tga");
  }
  media.graphics.invulnerabilityPowerupModel = await resources.registerModel("models/powerups/shield/shield.md3");
  media.graphics.medalImpressive = await resources.registerShaderNoMip("medal_impressive");
  media.graphics.medalExcellent = await resources.registerShaderNoMip("medal_excellent");
  media.graphics.medalGauntlet = await resources.registerShaderNoMip("medal_gauntlet");
  media.graphics.medalDefend = await resources.registerShaderNoMip("medal_defend");
  media.graphics.medalAssist = await resources.registerShaderNoMip("medal_assist");
  media.graphics.medalCapture = await resources.registerShaderNoMip("medal_capture");



  const items = itemBits(host);
  for (let i = 1; i < itemList(media.product).length; i++) {
    if (items[i] === '1' || host.settings().buildScript) {
      await host.loadingItem(i);
      await media.weaponRegistry.registerItemVisuals(i);
    }
  }

  media.graphics.bulletMarkShader = await resources.registerShader("gfx/damage/bullet_mrk");
  media.graphics.burnMarkShader = await resources.registerShader("gfx/damage/burn_med_mrk");
  media.graphics.holeMarkShader = await resources.registerShader("gfx/damage/hole_lg_mrk");
  media.graphics.energyMarkShader = await resources.registerShader("gfx/damage/plasma_mrk");
  media.graphics.shadowMarkShader = await resources.registerShader("markShadow");
  media.graphics.wakeMarkShader = await resources.registerShader("wake");
  media.graphics.bloodMarkShader = await resources.registerShader("bloodMark");

  for (let i = 1; i < world.map.models.length; i++) {
    const model = await resources.registerModel(`*${i}`);
    const bounds = modelBounds(model);
    const f = Math.fround;
    const midpoint = (min: number, max: number): number => f(min + f(f(0.5) * f(max - min)));
    media.inlineModels.push({ model, midpoint: vec3(midpoint(bounds.min.x, bounds.max.x), midpoint(bounds.min.y, bounds.max.y), midpoint(bounds.min.z, bounds.max.z)) });
  }

  for (let i = 1; i < 256; i++) {
    const modelName = host.configString(32 + i);
    if (modelName.length === 0) {
      break;
    }
    media.staticState.gameModels[i] = await resources.registerModel(modelName);
  }
  if (mission) {
    media.graphics.patrolShader = await resources.registerShaderNoMip("ui/assets/statusbar/patrol.tga");
    media.graphics.assaultShader = await resources.registerShaderNoMip("ui/assets/statusbar/assault.tga");
    media.graphics.campShader = await resources.registerShaderNoMip("ui/assets/statusbar/camp.tga");
    media.graphics.followShader = await resources.registerShaderNoMip("ui/assets/statusbar/follow.tga");
    media.graphics.defendShader = await resources.registerShaderNoMip("ui/assets/statusbar/defend.tga");
    media.graphics.teamLeaderShader = await resources.registerShaderNoMip("ui/assets/statusbar/team_leader.tga");
    media.graphics.retrieveShader = await resources.registerShaderNoMip("ui/assets/statusbar/retrieve.tga");
    media.graphics.escortShader = await resources.registerShaderNoMip("ui/assets/statusbar/escort.tga");
    media.graphics.cursor = await resources.registerShaderNoMip("menu/art/3_cursor2");
    media.graphics.sizeCursor = await resources.registerShaderNoMip("ui/assets/sizecursor.tga");
    media.graphics.selectCursor = await resources.registerShaderNoMip("ui/assets/selectcursor.tga");
    media.graphics.flagShaders[0] = await resources.registerShaderNoMip("ui/assets/statusbar/flag_in_base.tga");
    media.graphics.flagShaders[1] = await resources.registerShaderNoMip("ui/assets/statusbar/flag_capture.tga");
    media.graphics.flagShaders[2] = await resources.registerShaderNoMip("ui/assets/statusbar/flag_missing.tga");
    await resources.registerModel("models/players/james/lower.md3");
    await resources.registerModel("models/players/james/upper.md3");
    await resources.registerModel("models/players/heads/james/james.md3");
    await resources.registerModel("models/players/janet/lower.md3");
    await resources.registerModel("models/players/janet/upper.md3");
    await resources.registerModel("models/players/heads/janet/janet.md3");
  }
  return { world, particleAnimations: await loadParticleAnimations(resources) };
}
export async function registerClients(media: ClientMedia, host: ClientMediaHost): Promise<void> {
  validate(media, host);
  await host.loadingClient(host.state.clientNum);
  await host.clients.newClientInfo(host.state.clientNum, host.configString(544 + host.state.clientNum));
  for (let i = 0; i < 64; i++) {
    if (i === host.state.clientNum) continue;
    const info = host.configString(544 + i);
    if (info.length === 0) continue;
    await host.loadingClient(i);
    await host.clients.newClientInfo(i, info);
  }
  host.commands.buildSpectatorString();
}
