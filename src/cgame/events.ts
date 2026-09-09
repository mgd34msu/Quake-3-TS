// Entity events from id Software's code/cgame/cg_event.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PlayerFootsteps } from "../assets/animation.ts";
import type { PcmSound } from "../assets/wav.ts";
import { CommonError } from "../core/common-error.ts";
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { gameFormat } from "../game/format.ts";
import type { GameRandom } from "../game/numeric.ts";
import type { SceneShader } from "../render/ref-entity.ts";
import { EntityEvent, EntityType, EV_EVENT_BITS, GameType, Holdable, ItemType, PersistentIndex, Powerup, Team, Weapon } from "../shared/definitions.ts";
import { byteToDirection } from "../shared/direction-byte.ts";
import type { EntityState } from "../shared/entity-state.ts";
import { findItemForHoldable, itemAt, itemList } from "../shared/items.ts";
import { evaluateTrajectory } from "../shared/trajectory.ts";
import type { PacketEntityPresenter } from "./entities.ts";
import type { ClientEffects } from "./effects.ts";
import type { ClientInfo } from "./client-info.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";
import { ImpactSound } from "./weapons.ts";
import type { ClientWeaponRuntime } from "./weapons.ts";

const f = Math.fround;
const AUTO = 0, VOICE = 3, ITEM = 4, BODY = 5, ANNOUNCER = 7;
// Shipped CG_UseItem/CG_Obituary fold SCREEN_HEIGHT * 0.30 differently.
// Base cgame.qvm passes 143; missionpack passes 144. Native C alone misses this.
const CENTER_Y = { baseq3: 143, missionpack: 144 };

export type ClientEventSound = "useNothingSound" | "medkitSound" | "landSound" | "jumpPadSound"
  | "watrInSound" | "watrOutSound" | "watrUnSound" | "n_healthSound" | "selectSound"
  | "teleInSound" | "teleOutSound" | "respawnSound" | "hgrenb1aSound" | "hgrenb2aSound"
  | "captureYourTeamSound" | "captureOpponentSound" | "returnYourTeamSound" | "returnOpponentSound"
  | "blueFlagReturnedSound" | "redFlagReturnedSound" | "enemyTookYourFlagSound" | "yourTeamTookEnemyFlagSound"
  | "yourBaseIsUnderAttackSound" | "redScoredSound" | "blueScoredSound" | "redLeadsSound" | "blueLeadsSound"
  | "teamsTiedSound" | "quadSound" | "protectSound" | "regenSound" | "gibSound";
export type MissionEventSound = "useInvulnerabilitySound" | "scoutSound" | "guardSound" | "doublerSound" | "ammoregenSound"
  | "wstbimplSound" | "wstbimpmSound" | "wstbimpdSound" | "wstbactvSound" | "yourTeamTookTheFlagSound"
  | "enemyTookTheFlagSound" | "kamikazeFarSound";

export interface ClientEventMedia {
  readonly sounds: Readonly<Record<ClientEventSound, PcmSound | null>>;
  readonly footsteps: Readonly<Record<PlayerFootsteps | "metal" | "splash", readonly [PcmSound | null, PcmSound | null, PcmSound | null, PcmSound | null]>>;
  readonly gameSounds: readonly (PcmSound | null)[];
  readonly smokePuffShader: SceneShader | null;
}

export interface ClientEventOptions {
  readonly gameType: GameType;
  readonly debugEvents: boolean;
  readonly footsteps: boolean;
  readonly autoswitch: boolean;
  readonly demoPlayback: boolean;
  readonly noPredict: boolean;
  readonly synchronousClients: boolean;
  readonly singlePlayerActive: boolean;
  readonly cameraOrbit: boolean;
}

interface EventServices {
  readonly media: ClientEventMedia;
  readonly options: ClientEventOptions;
  /** Independent cgame VM RNG, shared by this client's presentation subsystems only. */
  readonly random: Pick<GameRandom, "rand">;
  readonly entities: Pick<PacketEntityPresenter, "setEntitySoundPosition" | "beam">;
  readonly weapons: Pick<ClientWeaponRuntime, "outOfAmmoChange" | "fireWeapon" | "missileHitPlayer" | "missileHitWall" | "railTrail" | "bullet" | "shotgunFire">;
  readonly effects: Pick<ClientEffects, "smokePuff" | "spawnEffect" | "gibPlayer" | "scorePlum">;
  clientInfo(number: number): Pick<ClientInfo, "gender" | "footsteps" | "team" | "medkitUsageTime">;
  /** Live CS_PLAYERS n-value, as source byte-valued text; null denotes no configstring. */
  playerName(number: number): string | null;
  soundConfigString(index: number): string;
  customSound(clientNum: number, name: string): PcmSound | null;
  registerSound(path: string | null, compressed: boolean): PcmSound | null;
  startSound(origin: Vec3 | null, entityNum: number, channel: number, sound: PcmSound | null): void;
  stopLoopingSound(entityNum: number): void;
  addBufferedSound(sound: PcmSound | null): void;
  print(message: string): void;
  centerPrint(message: string, y: number, charWidth: number): void;
}

export type ClientEventHost = EventServices & (
  | { readonly product: "baseq3" }
  | { readonly product: "missionpack"; readonly missionSounds: Readonly<Record<MissionEventSound, PcmSound | null>>;
    readonly missionEffects: Pick<ClientEffects, "kamikazeEffect" | "obeliskExplode" | "obeliskPain" | "invulnerabilityImpact" | "invulnerabilityJuiced" | "lightningBoltBeam">;
    startLocalSound(sound: PcmSound | null, channel: number): void;
    /** Full-buffer playback awaits response-head registration before the event returns. */
    voiceChatLocal(mode: number, voiceOnly: boolean, clientNum: number, color: number, command: string): Promise<void> }
);

export function placeString(rank: number): string {
  rank |= 0;
  const tied = (rank & 0x4000) !== 0;
  rank &= ~0x4000;
  let place: string;
  if (rank === 1) place = "^41st^7";
  else if (rank === 2) place = "^12nd^7";
  else if (rank === 3) place = "^33rd^7";
  else {
    const suffix = rank === 11 || rank === 12 || rank === 13 ? "th" : rank % 10 === 1 ? "st" : rank % 10 === 2 ? "nd" : rank % 10 === 3 ? "rd" : "th";
    place = gameFormat(`%i${suffix}`, [rank]);
  }
  return gameFormat("%s%s", [tied ? "Tied for " : "", place],64);
}

export class ClientEventRuntime {
  constructor(readonly state: ClientGameState, readonly host: ClientEventHost) {
    if (state.product !== host.product) throw new Error("Event host product differs from cgame state");
  }

  private snapshot() {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("CG event requires cg.snap");
    return snapshot;
  }

  private sound(entity: ClientEntity, channel: number, key: ClientEventSound): void {
    this.host.startSound(null,entity.currentState.number,channel,this.host.media.sounds[key]);
  }

  private custom(entity: ClientEntity, channel: number, name: string): void {
    this.host.startSound(null,entity.currentState.number,channel,this.host.customSound(entity.currentState.number,name));
  }

  painEvent(entity: ClientEntity, health: number): void {
    if (((this.state.time - entity.player.painTime) | 0) < 500) return;
    const level = health < 25 ? 25 : health < 50 ? 50 : health < 75 ? 75 : 100;
    this.custom(entity,VOICE,`*pain${level}_1.wav`);
    entity.player.painTime = this.state.time;
    entity.player.painDirection = !entity.player.painDirection;
  }

  private itemPickup(index: number): void {
    const state = this.state;
    state.itemPickup = index; state.itemPickupTime = state.time; state.itemPickupBlendTime = state.time;
    const item = itemAt(state.product,index);
    if (item.type === ItemType.IT_WEAPON && this.host.options.autoswitch && item.tag !== Weapon.WP_MACHINEGUN) {
      state.weaponSelectTime = state.time; state.weaponSelect = item.tag;
    }
  }

  private useItem(entity: ClientEntity): void {
    const es = entity.currentState;
    let item = (es.event & ~EV_EVENT_BITS) - EntityEvent.EV_USE_ITEM0;
    if (item < 0 || item > Holdable.HI_NUM_HOLDABLE) item = 0;
    if (es.number === this.snapshot().playerState.clientNum) {
      const text = item === 0 ? "No item to use" : `Use ${findItemForHoldable(this.state.product,item).pickupName}`;
      this.host.centerPrint(text,CENTER_Y[this.state.product],16);
    }
    if (item === Holdable.HI_TELEPORTER) return;
    if (item === Holdable.HI_MEDKIT) {
      if (es.clientNum >= 0 && es.clientNum < 64) this.host.clientInfo(es.clientNum).medkitUsageTime = this.state.time;
      this.sound(entity,BODY,"medkitSound"); return;
    }
    if (this.host.product === "missionpack") {
      if (item === Holdable.HI_KAMIKAZE || item === Holdable.HI_PORTAL) return;
      if (item === Holdable.HI_INVULNERABILITY) {
        this.host.startSound(null,es.number,BODY,this.host.missionSounds.useInvulnerabilitySound); return;
      }
    }
    this.sound(entity,BODY,"useNothingSound");
  }

  private obituary(es: EntityState): void {
    const target = es.otherEntityNum, mod = es.eventParm;
    let attacker = es.otherEntityNum2;
    if (target < 0 || target >= 64) throw new CommonError("drop", "CG_Obituary: target out of range");
    const info = this.host.clientInfo(target);
    let attackerName: string | null;
    if (attacker < 0 || attacker >= 64) { attacker = 1022; attackerName = null; }
    else attackerName = this.host.playerName(attacker);
    const name = this.host.playerName(target);
    if (name === null) return;
    const targetName = name.slice(0,29) + "^7";
    let message: string | null = null;
    switch (mod) {
      case 20: message = "suicides"; break;
      case 19: message = "cratered"; break;
      case 17: message = "was squished"; break;
      case 14: message = "sank like a rock"; break;
      case 15: message = "melted"; break;
      case 16: message = "does a back flip into the lava"; break;
      case 21: message = "saw the light"; break;
      case 22: message = "was in the wrong place"; break;
    }
    if (attacker === target) {
      const self = info.gender === "female" ? "herself" : info.gender === "neuter" ? "itself" : "himself";
      const possessive = info.gender === "female" ? "her" : info.gender === "neuter" ? "its" : "his";
      if (this.state.product === "missionpack" && mod === 26) message = "goes out with a bang";
      else if (mod === 5) message = `tripped on ${possessive} own grenade`;
      else if (mod === 7) message = `blew ${self} up`;
      else if (mod === 9) message = `melted ${self}`;
      else if (mod === 13) message = "should have used a smaller gun";
      else if (this.state.product === "missionpack" && mod === 25) message = `found ${info.gender === "neuter" ? "it's" : possessive} prox mine`;
      else message = `killed ${self}`;
    }
    if (message !== null) { this.host.print(`${targetName} ${message}.\n`); return; }
    const ps = this.snapshot().playerState;
    if (attacker === ps.clientNum) {
      let text = `You fragged ${targetName}`;
      if (this.host.options.gameType < GameType.GT_TEAM) text += gameFormat("\n%s place with %i", [placeString((ps.persistant.get(PersistentIndex.PERS_RANK)+1)|0),ps.persistant.get(PersistentIndex.PERS_SCORE)]);
      if (this.state.product !== "missionpack" || !(this.host.options.singlePlayerActive && this.host.options.cameraOrbit)) this.host.centerPrint(text,CENTER_Y[this.state.product],16);
    }
    if (attackerName === null) { attacker = 1022; attackerName = "noname"; }
    else {
      attackerName = attackerName.slice(0,29) + "^7";
      if (target === this.snapshot().playerState.clientNum) this.state.killerName = attackerName;
    }
    let suffix = "";
    if (attacker !== 1022) {
      switch (mod) {
        case 2: message = "was pummeled by"; break;
        case 3: message = "was machinegunned by"; break;
        case 1: message = "was gunned down by"; break;
        case 4: message = "ate"; suffix = "'s grenade"; break;
        case 5: message = "was shredded by"; suffix = "'s shrapnel"; break;
        case 6: message = "ate"; suffix = "'s rocket"; break;
        case 7: message = "almost dodged"; suffix = "'s rocket"; break;
        case 8: case 9: message = "was melted by"; suffix = "'s plasmagun"; break;
        case 10: message = "was railed by"; break;
        case 11: message = "was electrocuted by"; break;
        case 12: case 13: message = "was blasted by"; suffix = "'s BFG"; break;
        case 18: message = "tried to invade"; suffix = "'s personal space"; break;
        default:
          if (mod === (this.state.product === "missionpack" ? 28 : 23)) message = "was caught by";
          else if (this.state.product === "missionpack" && mod === 23) message = "was nailed by";
          else if (this.state.product === "missionpack" && mod === 24) { message = "got lead poisoning from"; suffix = "'s Chaingun"; }
          else if (this.state.product === "missionpack" && mod === 25) { message = "was too close to"; suffix = "'s Prox Mine"; }
          else if (this.state.product === "missionpack" && mod === 26) { message = "falls to"; suffix = "'s Kamikaze blast"; }
          else if (this.state.product === "missionpack" && mod === 27) message = "was juiced by";
          else message = "was killed by";
      }
      this.host.print(`${targetName} ${message} ${attackerName}${suffix}\n`); return;
    }
    this.host.print(`${targetName} died.\n`);
  }

  private teamSound(event: number): void {
    const host = this.host, sounds = host.media.sounds;
    const team = (): Team => host.clientInfo(this.state.clientNum).team;
    const buffered = (key: ClientEventSound): void => { host.addBufferedSound(sounds[key]); };
    switch (event) {
      case 0: case 1: buffered(team() === (event === 0 ? Team.TEAM_RED : Team.TEAM_BLUE) ? "captureYourTeamSound" : "captureOpponentSound"); break;
      case 2: case 3:
        buffered(team() === (event === 2 ? Team.TEAM_RED : Team.TEAM_BLUE) ? "returnYourTeamSound" : "returnOpponentSound");
        buffered(event === 2 ? "blueFlagReturnedSound" : "redFlagReturnedSound"); break;
      case 4: case 5: {
        const ps = this.snapshot().playerState;
        if (ps.powerups.get(event === 4 ? Powerup.PW_BLUEFLAG : Powerup.PW_REDFLAG) || ps.powerups.get(Powerup.PW_NEUTRALFLAG)) break;
        const threatened = event === 4 ? Team.TEAM_BLUE : Team.TEAM_RED, localTeam = team();
        if (localTeam !== Team.TEAM_RED && localTeam !== Team.TEAM_BLUE) break;
        if (host.product === "missionpack" && host.options.gameType === GameType.GT_1FCTF) host.addBufferedSound(host.missionSounds[localTeam === threatened ? "yourTeamTookTheFlagSound" : "enemyTookTheFlagSound"]);
        else buffered(localTeam === threatened ? "enemyTookYourFlagSound" : "yourTeamTookEnemyFlagSound");
        break;
      }
      case 6: case 7: if (team() === (event === 6 ? Team.TEAM_RED : Team.TEAM_BLUE)) buffered("yourBaseIsUnderAttackSound"); break;
      case 8: buffered("redScoredSound"); break;
      case 9: buffered("blueScoredSound"); break;
      case 10: buffered("redLeadsSound"); break;
      case 11: buffered("blueLeadsSound"); break;
      case 12: buffered("teamsTiedSound"); break;
      case 13: if (host.product === "missionpack") host.startLocalSound(host.missionSounds.kamikazeFarSound,ANNOUNCER); break;
    }
  }

  async entityEvent(entity: ClientEntity, position: Vec3): Promise<void> {
    const es = entity.currentState, event = es.event & ~EV_EVENT_BITS, state = this.state, host = this.host;
    if (host.options.debugEvents) host.print(gameFormat("ent:%3i  event:%3i ",[es.number,event]));
    const debug = (name: string): void => { if (host.options.debugEvents) host.print(name + "\n"); };
    if (event === 0) { debug("ZEROEVENT"); return; }
    const clientNum = es.clientNum < 0 || es.clientNum >= 64 ? 0 : es.clientNum;
    const info = host.clientInfo(clientNum);
    const missionOnly = (event >= EntityEvent.EV_PROXIMITY_MINE_STICK && event <= EntityEvent.EV_LIGHTNINGBOLT) || event >= EntityEvent.EV_TAUNT_YES;
    const known = EntityEvent[event];
    if (known === undefined || event === EntityEvent.EV_USE_ITEM15 || event === EntityEvent.EV_BULLET || (missionOnly && host.product === "baseq3")) {
      debug("UNKNOWN"); throw new CommonError("drop", `Unknown event: ${event}`);
    }
    debug(event >= EntityEvent.EV_STEP_4 && event <= EntityEvent.EV_STEP_16 ? "EV_STEP" : event >= EntityEvent.EV_DEATH1 && event <= EntityEvent.EV_DEATH3 ? "EV_DEATHx" : known);
    if (event >= EntityEvent.EV_USE_ITEM0 && event <= EntityEvent.EV_USE_ITEM14) { this.useItem(entity); return; }
    switch (event) {
      case EntityEvent.EV_FOOTSTEP: case EntityEvent.EV_FOOTSTEP_METAL: case EntityEvent.EV_FOOTSPLASH: case EntityEvent.EV_FOOTWADE: case EntityEvent.EV_SWIM:
        if (host.options.footsteps) {
          const kind = event === EntityEvent.EV_FOOTSTEP ? info.footsteps : event === EntityEvent.EV_FOOTSTEP_METAL ? "metal" : "splash";
          const sound = host.media.footsteps[kind][host.random.rand() & 3];
          if (sound === undefined) throw new Error("Invalid footstep sound index");
          host.startSound(null,es.number,BODY,sound);
        }
        break;
      case EntityEvent.EV_FALL_SHORT: case EntityEvent.EV_FALL_MEDIUM: case EntityEvent.EV_FALL_FAR:
        if (event === EntityEvent.EV_FALL_SHORT) this.sound(entity,AUTO,"landSound");
        else this.custom(entity,event === EntityEvent.EV_FALL_MEDIUM ? VOICE : AUTO,event === EntityEvent.EV_FALL_MEDIUM ? "*pain100_1.wav" : "*fall1.wav");
        if (event === EntityEvent.EV_FALL_FAR) entity.player.painTime = state.time;
        if (clientNum === state.predictedPlayerState.clientNum) { state.landChange = -8 * (event - EntityEvent.EV_FALL_SHORT + 1); state.landTime = state.time; }
        break;
      case EntityEvent.EV_STEP_4: case EntityEvent.EV_STEP_8: case EntityEvent.EV_STEP_12: case EntityEvent.EV_STEP_16: {
        if (clientNum !== state.predictedPlayerState.clientNum) break;
        if (host.options.demoPlayback || (this.snapshot().playerState.pmFlags & 4096) || host.options.noPredict || host.options.synchronousClients) break;
        const delta = (state.time - state.stepTime) | 0;
        const oldStep = delta < 200 ? f(f(state.stepChange * f((200 - delta)|0))/200) : 0;
        state.stepChange = Math.min(32,f(oldStep + 4 * (event - EntityEvent.EV_STEP_4 + 1))); state.stepTime = state.time; break;
      }
      case EntityEvent.EV_JUMP_PAD:
        host.effects.smokePuff({origin:entity.lerpOrigin,velocity:vec3(0,0,1),radius:32,color:{x:1,y:1,z:1,w:f(0.33)},duration:1000,startTime:state.time,fadeInTime:0,flags:1,shader:host.media.smokePuffShader});
        host.startSound(entity.lerpOrigin,-1,VOICE,host.media.sounds.jumpPadSound);
        this.custom(entity,VOICE,"*jump1.wav"); break;
      case EntityEvent.EV_JUMP: this.custom(entity,VOICE,"*jump1.wav"); break;
      case EntityEvent.EV_TAUNT: this.custom(entity,VOICE,"*taunt.wav"); break;
      case EntityEvent.EV_TAUNT_YES: case EntityEvent.EV_TAUNT_NO: case EntityEvent.EV_TAUNT_FOLLOWME: case EntityEvent.EV_TAUNT_GETFLAG: case EntityEvent.EV_TAUNT_GUARDBASE: case EntityEvent.EV_TAUNT_PATROL:
        if (host.product === "missionpack") await host.voiceChatLocal(1,false,es.number,53,event === EntityEvent.EV_TAUNT_YES ? "yes" : event === EntityEvent.EV_TAUNT_NO ? "no" : event === EntityEvent.EV_TAUNT_FOLLOWME ? "followme" : event === EntityEvent.EV_TAUNT_GETFLAG ? "ongetflag" : event === EntityEvent.EV_TAUNT_GUARDBASE ? "ondefense" : "onpatrol");
        break;
      case EntityEvent.EV_WATER_TOUCH: this.sound(entity,AUTO,"watrInSound"); break;
      case EntityEvent.EV_WATER_LEAVE: this.sound(entity,AUTO,"watrOutSound"); break;
      case EntityEvent.EV_WATER_UNDER: this.sound(entity,AUTO,"watrUnSound"); break;
      case EntityEvent.EV_WATER_CLEAR: this.custom(entity,AUTO,"*gasp.wav"); break;
      case EntityEvent.EV_ITEM_PICKUP: case EntityEvent.EV_GLOBAL_ITEM_PICKUP: {
        const index = es.eventParm;
        if (index < 1 || index >= itemList(state.product).length) break;
        const item = itemAt(state.product,index);
        if (event === EntityEvent.EV_GLOBAL_ITEM_PICKUP) {
          if (item.pickupSound !== null) host.startSound(null,this.snapshot().playerState.clientNum,AUTO,host.registerSound(item.pickupSound,false));
        } else if (item.type === ItemType.IT_POWERUP || item.type === ItemType.IT_TEAM) this.sound(entity,AUTO,"n_healthSound");
        else if (item.type === ItemType.IT_PERSISTANT_POWERUP) {
          if (host.product === "missionpack") {
            const sound = item.tag === Powerup.PW_SCOUT ? host.missionSounds.scoutSound : item.tag === Powerup.PW_GUARD ? host.missionSounds.guardSound : item.tag === Powerup.PW_DOUBLER ? host.missionSounds.doublerSound : item.tag === Powerup.PW_AMMOREGEN ? host.missionSounds.ammoregenSound : undefined;
            if (sound !== undefined) host.startSound(null,es.number,AUTO,sound);
          }
        } else host.startSound(null,es.number,AUTO,host.registerSound(item.pickupSound,false));
        if (es.number === this.snapshot().playerState.clientNum) this.itemPickup(index);
        break;
      }
      case EntityEvent.EV_NOAMMO: if (es.number === this.snapshot().playerState.clientNum) host.weapons.outOfAmmoChange(); break;
      case EntityEvent.EV_CHANGE_WEAPON: this.sound(entity,AUTO,"selectSound"); break;
      case EntityEvent.EV_FIRE_WEAPON: host.weapons.fireWeapon(entity); break;
      case EntityEvent.EV_PLAYER_TELEPORT_IN: case EntityEvent.EV_PLAYER_TELEPORT_OUT:
        this.sound(entity,AUTO,event === EntityEvent.EV_PLAYER_TELEPORT_IN ? "teleInSound" : "teleOutSound"); host.effects.spawnEffect(position); break;
      case EntityEvent.EV_ITEM_POP: this.sound(entity,AUTO,"respawnSound"); break;
      case EntityEvent.EV_ITEM_RESPAWN: entity.miscTime = state.time; this.sound(entity,AUTO,"respawnSound"); break;
      case EntityEvent.EV_GRENADE_BOUNCE: this.sound(entity,AUTO,(host.random.rand() & 1) ? "hgrenb1aSound" : "hgrenb2aSound"); break;
      case EntityEvent.EV_PROXIMITY_MINE_STICK:
        if (host.product === "missionpack") host.startSound(null,es.number,AUTO,host.missionSounds[(es.eventParm & 64) ? "wstbimplSound" : (es.eventParm & 4096) ? "wstbimpmSound" : "wstbimpdSound"]); break;
      case EntityEvent.EV_PROXIMITY_MINE_TRIGGER: if (host.product === "missionpack") host.startSound(null,es.number,AUTO,host.missionSounds.wstbactvSound); break;
      case EntityEvent.EV_KAMIKAZE: if (host.product === "missionpack") host.missionEffects.kamikazeEffect(entity.lerpOrigin); break;
      case EntityEvent.EV_OBELISKEXPLODE: if (host.product === "missionpack") host.missionEffects.obeliskExplode(entity.lerpOrigin); break;
      case EntityEvent.EV_OBELISKPAIN: if (host.product === "missionpack") host.missionEffects.obeliskPain(entity.lerpOrigin); break;
      case EntityEvent.EV_INVUL_IMPACT: if (host.product === "missionpack") host.missionEffects.invulnerabilityImpact(entity.lerpOrigin,es.angles); break;
      case EntityEvent.EV_JUICED: if (host.product === "missionpack") host.missionEffects.invulnerabilityJuiced(entity.lerpOrigin); break;
      case EntityEvent.EV_LIGHTNINGBOLT: if (host.product === "missionpack") host.missionEffects.lightningBoltBeam(es.origin2,es.pos.base); break;
      case EntityEvent.EV_SCOREPLUM: host.effects.scorePlum(es.otherEntityNum,entity.lerpOrigin,es.time); break;
      case EntityEvent.EV_MISSILE_HIT: host.weapons.missileHitPlayer(es.weapon,position,byteToDirection(es.eventParm),es.otherEntityNum); break;
      case EntityEvent.EV_MISSILE_MISS: case EntityEvent.EV_MISSILE_MISS_METAL:
        host.weapons.missileHitWall(es.weapon,0,position,byteToDirection(es.eventParm),event === EntityEvent.EV_MISSILE_MISS ? ImpactSound.DEFAULT : ImpactSound.METAL); break;
      case EntityEvent.EV_RAILTRAIL:
        es.weapon = Weapon.WP_RAILGUN; host.weapons.railTrail(clientNum,es.origin2,es.pos.base);
        if (es.eventParm !== 255) host.weapons.missileHitWall(es.weapon,es.clientNum,position,byteToDirection(es.eventParm),ImpactSound.DEFAULT); break;
      case EntityEvent.EV_BULLET_HIT_WALL: host.weapons.bullet(es.pos.base,es.otherEntityNum,{ kind:"wall",normal:byteToDirection(es.eventParm) }); break;
      case EntityEvent.EV_BULLET_HIT_FLESH: host.weapons.bullet(es.pos.base,es.otherEntityNum,{ kind:"flesh",entityNum:es.eventParm }); break;
      case EntityEvent.EV_SHOTGUN: host.weapons.shotgunFire(es); break;
      case EntityEvent.EV_GENERAL_SOUND: case EntityEvent.EV_GLOBAL_SOUND: {
        const sound = host.media.gameSounds[es.eventParm];
        if (sound === undefined) throw new RangeError(`Unregistered game sound index ${es.eventParm}`);
        host.startSound(null,event === EntityEvent.EV_GENERAL_SOUND ? es.number : this.snapshot().playerState.clientNum,event === EntityEvent.EV_GENERAL_SOUND ? VOICE : AUTO,sound === null ? host.customSound(es.number,host.soundConfigString(es.eventParm)) : sound);
        break;
      }
      case EntityEvent.EV_GLOBAL_TEAM_SOUND: this.teamSound(es.eventParm); break;
      case EntityEvent.EV_PAIN: if (es.number !== this.snapshot().playerState.clientNum) this.painEvent(entity,es.eventParm); break;
      case EntityEvent.EV_DEATH1: case EntityEvent.EV_DEATH2: case EntityEvent.EV_DEATH3: this.custom(entity,VOICE,`*death${event-EntityEvent.EV_DEATH1+1}.wav`); break;
      case EntityEvent.EV_OBITUARY: this.obituary(es); break;
      case EntityEvent.EV_POWERUP_QUAD: case EntityEvent.EV_POWERUP_BATTLESUIT: case EntityEvent.EV_POWERUP_REGEN:
        if (es.number === this.snapshot().playerState.clientNum) { state.powerupActive = event === EntityEvent.EV_POWERUP_QUAD ? Powerup.PW_QUAD : event === EntityEvent.EV_POWERUP_BATTLESUIT ? Powerup.PW_BATTLESUIT : Powerup.PW_REGEN; state.powerupTime = state.time; }
        this.sound(entity,ITEM,event === EntityEvent.EV_POWERUP_QUAD ? "quadSound" : event === EntityEvent.EV_POWERUP_BATTLESUIT ? "protectSound" : "regenSound"); break;
      case EntityEvent.EV_GIB_PLAYER: if (!(es.eFlags & 512)) this.sound(entity,BODY,"gibSound"); host.effects.gibPlayer(entity.lerpOrigin); break;
      case EntityEvent.EV_STOPLOOPINGSOUND: host.stopLoopingSound(es.number); es.loopSound = 0; break;
      case EntityEvent.EV_DEBUG_LINE: host.entities.beam(entity); break;
    }
  }

  async checkEvents(entity: ClientEntity): Promise<void> {
    const es = entity.currentState;
    if (es.eType > EntityType.ET_EVENTS) {
      if (entity.previousEvent !== 0) return;
      if (es.eFlags & 16) es.number = es.otherEntityNum;
      entity.previousEvent = 1;
      es.event = (es.eType - EntityType.ET_EVENTS)|0;
    } else {
      if (es.event === entity.previousEvent) return;
      entity.previousEvent = es.event;
      if ((es.event & ~EV_EVENT_BITS) === 0) return;
    }
    entity.lerpOrigin = evaluateTrajectory(es.pos,this.snapshot().serverTime);
    this.host.entities.setEntitySoundPosition(entity);
    await this.entityEvent(entity,entity.lerpOrigin);
  }
}
