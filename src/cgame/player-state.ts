// Player-state transitions from id Software's code/cgame/cg_playerstate.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../assets/wav.ts";
import { dot3, length3, sub3, vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import type { SceneShader } from "../render/ref-entity.ts";
import { GameType, MoveType, PersistentIndex as P, Powerup, Team, Weapon, statSchema, weaponCount } from "../shared/definitions.ts";
import type { SourcePlayerState } from "../shared/player-state.ts";
import type { ClientEventRuntime } from "./events.ts";
import type { ClientGameState, ClientGameStaticState } from "./state.ts";

const f32 = Math.fround;
const LOCAL_SOUND = 6, ANNOUNCER = 7;
export type PlayerStateSound = "noAmmoSound" | "hitSound" | "hitTeamSound" | "captureAwardSound" | "impressiveSound"
  | "excellentSound" | "humiliationSound" | "defendSound" | "assistSound" | "deniedSound" | "holyShitSound"
  | "youHaveFlagSound" | "takenLeadSound" | "tiedLeadSound" | "lostLeadSound" | "suddenDeathSound"
  | "oneMinuteSound" | "fiveMinuteSound" | "oneFragSound" | "twoFragSound" | "threeFragSound";
export type MissionPlayerStateSound = "hitSoundHighArmor" | "hitSoundLowArmor" | "firstImpressiveSound" | "firstExcellentSound" | "firstHumiliationSound";
export type RewardMedal = "medalCapture" | "medalImpressive" | "medalExcellent" | "medalGauntlet" | "medalDefend" | "medalAssist";

interface TransitionServices {
  readonly staticState: ClientGameStaticState;
  readonly events: Pick<ClientEventRuntime, "entityEvent" | "painEvent">;
  readonly sounds: Readonly<Record<PlayerStateSound, PcmSound | null>>;
  readonly medals: Readonly<Record<RewardMedal, SceneShader | null>>;
  readonly showMiss: boolean;
  startLocalSound(sound: PcmSound | null, channel: number): void;
  addBufferedSound(sound: PcmSound | null): void;
  print(message: string): void;
}
export type PlayerStateHost = TransitionServices & (
  | { readonly product: "baseq3" }
  | { readonly product: "missionpack"; readonly missionSounds: Readonly<Record<MissionPlayerStateSound, PcmSound | null>> }
);

export class PlayerStateRuntime {
  constructor(readonly state: ClientGameState, readonly host: PlayerStateHost) {
    if (state.product !== host.product || state.product !== host.staticState.product) throw new Error("Player-state transition product mismatch");
  }
  private snapshot() {
    const snapshot = this.state.snap;
    if (snapshot === null) throw new Error("Player-state transition requires cg.snap");
    return snapshot;
  }
  private local(key: PlayerStateSound, channel: number): void { this.host.startLocalSound(this.host.sounds[key], channel); }
  private buffered(key: PlayerStateSound): void { this.host.addBufferedSound(this.host.sounds[key]); }

  checkAmmo(): void {
    const ps = this.snapshot().playerState, weapons = ps.stats.get(statSchema(ps.product).weapons);
    let total = 0;
    for (let weapon = Weapon.WP_MACHINEGUN; weapon < weaponCount(ps.product); weapon++) {
      if ((weapons & (1 << weapon)) === 0) continue;
      const slow = weapon === Weapon.WP_ROCKET_LAUNCHER || weapon === Weapon.WP_GRENADE_LAUNCHER
        || weapon === Weapon.WP_RAILGUN || weapon === Weapon.WP_SHOTGUN || (ps.product === "missionpack" && weapon === Weapon.WP_PROX_LAUNCHER);
      total = (total + Math.imul(ps.ammo.get(weapon), slow ? 1000 : 200)) | 0;
      if (total >= 5000) { this.state.lowAmmoWarning = 0; return; }
    }
    const previous = this.state.lowAmmoWarning;
    this.state.lowAmmoWarning = total === 0 ? 2 : 1;
    if (this.state.lowAmmoWarning !== previous) this.local("noAmmoSound", LOCAL_SOUND);
  }

  damageFeedback(yawByte: number, pitchByte: number, damage: number): void {
    const state = this.state, snapshot = this.snapshot(), health = snapshot.playerState.health;
    state.attackerTime = state.time;
    const scale = health < 40 ? 1 : f32(40 / f32(health));
    let kick = f32(f32(damage) * scale);
    if (kick < 5) kick = 5;
    if (kick > 10) kick = 10;
    if (yawByte === 255 && pitchByte === 255) {
      state.damageX = 0; state.damageY = 0; state.damageRoll = 0; state.damagePitch = -kick;
    } else {
      const pitch = f32(f32(f32(pitchByte) / 255) * 360), yaw = f32(f32(f32(yawByte) / 255) * 360);
      const direction = sub3(vec3(0, 0, 0), qvmAngleVectors(vec3(pitch, yaw, 0)).forward);
      let front = dot3(direction, state.refdef.viewAxis[0]);
      const left = dot3(direction, state.refdef.viewAxis[1]), up = dot3(direction, state.refdef.viewAxis[2]);
      let distance = length3(vec3(front, left, 0));
      if (distance < f32(0.1)) distance = f32(0.1);
      state.damageRoll = f32(kick * left);
      state.damagePitch = f32(-kick * front);
      if (front <= f32(0.1)) front = f32(0.1);
      state.damageX = f32(-left / front); state.damageY = f32(up / distance);
    }
    if (state.damageX > 1) state.damageX = 1;
    if (state.damageX < -1) state.damageX = -1;
    if (state.damageY > 1) state.damageY = 1;
    if (state.damageY < -1) state.damageY = -1;
    if (kick > 10) kick = 10;
    state.damageValue = kick;
    state.damageKickEndTime = f32((state.time + 500) | 0);
    state.damageTime = f32(snapshot.serverTime);
  }

  respawn(): void {
    this.state.thisFrameTeleport = true;
    this.state.weaponSelectTime = this.state.time;
    this.state.weaponSelect = this.snapshot().playerState.weapon;
  }

  async checkPlayerstateEvents(current: SourcePlayerState, previous: SourcePlayerState): Promise<void> {
    if (current.externalEvent !== 0 && current.externalEvent !== previous.externalEvent) {
      const entity = this.state.entityAt(current.clientNum);
      entity.currentState.event = current.externalEvent; entity.currentState.eventParm = current.externalEventParm;
      await this.host.events.entityEvent(entity, entity.lerpOrigin);
    }
    const entity = this.state.predictedPlayerEntity;
    for (let index = (current.eventSequence - 2) | 0; index < current.eventSequence; index++) {
      if (index >= previous.eventSequence || (index > ((previous.eventSequence - 2) | 0)
        && current.events.get(index & 1) !== previous.events.get(index & 1))) {
        const event = current.events.get(index & 1);
        entity.currentState.event = event; entity.currentState.eventParm = current.eventParms.get(index & 1);
        await this.host.events.entityEvent(entity, entity.lerpOrigin);
        this.state.predictableEvents.set(index & 15, event);
        this.state.eventSequence = (this.state.eventSequence + 1) | 0;
      }
    }
  }

  async checkChangedPredictableEvents(ps: SourcePlayerState): Promise<void> {
    const entity = this.state.predictedPlayerEntity;
    for (let index = (ps.eventSequence - 2) | 0; index < ps.eventSequence; index++) {
      if (index >= this.state.eventSequence) continue;
      if (index > ((this.state.eventSequence - 16) | 0) && ps.events.get(index & 1) !== this.state.predictableEvents.get(index & 15)) {
        const event = ps.events.get(index & 1);
        entity.currentState.event = event; entity.currentState.eventParm = ps.eventParms.get(index & 1);
        await this.host.events.entityEvent(entity, entity.lerpOrigin);
        this.state.predictableEvents.set(index & 15, event);
        if (this.host.showMiss) this.host.print("WARNING: changed predicted event\n");
      }
    }
  }

  private pushReward(sound: PcmSound | null, shader: SceneShader | null, count: number): void {
    if (this.state.rewardStack < 9) {
      this.state.rewardStack = (this.state.rewardStack + 1) | 0;
      const reward = this.state.rewards[this.state.rewardStack];
      if (reward === undefined) throw new RangeError("Invalid source reward stack index");
      reward.sound = sound; reward.shader = shader; reward.count = count;
    }
  }

  checkLocalSounds(ps: SourcePlayerState, previous: SourcePlayerState): void {
    if (ps.persistant.get(P.PERS_TEAM) !== previous.persistant.get(P.PERS_TEAM)) return;
    const host = this.host, state = this.state, cgs = host.staticState;
    if (ps.persistant.get(P.PERS_HITS) > previous.persistant.get(P.PERS_HITS)) {
      const armor = ps.persistant.get(P.PERS_ATTACKEE_ARMOR) & 255, health = ps.persistant.get(P.PERS_ATTACKEE_ARMOR) >> 8;
      if (host.product === "missionpack" && armor > 50) host.startLocalSound(host.missionSounds.hitSoundHighArmor, LOCAL_SOUND);
      else if (host.product === "missionpack" && (armor !== 0 || health > 100)) host.startLocalSound(host.missionSounds.hitSoundLowArmor, LOCAL_SOUND);
      else this.local("hitSound", LOCAL_SOUND);
    } else if (ps.persistant.get(P.PERS_HITS) < previous.persistant.get(P.PERS_HITS)) this.local("hitTeamSound", LOCAL_SOUND);
    if (ps.health < ((previous.health - 1) | 0) && ps.health > 0) host.events.painEvent(state.predictedPlayerEntity, ps.health);
    if (state.intermissionStarted) return;
    let rewarded = false;
    const changed = (index: P): boolean => ps.persistant.get(index) !== previous.persistant.get(index);
    const award = (sound: PcmSound | null, medal: RewardMedal, index: P): void => {
      this.pushReward(sound, host.medals[medal], ps.persistant.get(index)); rewarded = true;
    };
    if (changed(P.PERS_CAPTURES)) award(host.sounds.captureAwardSound, "medalCapture", P.PERS_CAPTURES);
    if (changed(P.PERS_IMPRESSIVE_COUNT)) award(host.product === "missionpack" && ps.persistant.get(P.PERS_IMPRESSIVE_COUNT) === 1
      ? host.missionSounds.firstImpressiveSound : host.sounds.impressiveSound, "medalImpressive", P.PERS_IMPRESSIVE_COUNT);
    if (changed(P.PERS_EXCELLENT_COUNT)) award(host.product === "missionpack" && ps.persistant.get(P.PERS_EXCELLENT_COUNT) === 1
      ? host.missionSounds.firstExcellentSound : host.sounds.excellentSound, "medalExcellent", P.PERS_EXCELLENT_COUNT);
    if (changed(P.PERS_GAUNTLET_FRAG_COUNT)) award(host.product === "missionpack" && previous.persistant.get(P.PERS_GAUNTLET_FRAG_COUNT) === 1
      ? host.missionSounds.firstHumiliationSound : host.sounds.humiliationSound, "medalGauntlet", P.PERS_GAUNTLET_FRAG_COUNT);
    if (changed(P.PERS_DEFEND_COUNT)) award(host.sounds.defendSound, "medalDefend", P.PERS_DEFEND_COUNT);
    if (changed(P.PERS_ASSIST_COUNT)) award(host.sounds.assistSound, "medalAssist", P.PERS_ASSIST_COUNT);
    if (changed(P.PERS_PLAYEREVENTS)) {
      const changedBits = ps.persistant.get(P.PERS_PLAYEREVENTS) ^ previous.persistant.get(P.PERS_PLAYEREVENTS);
      if ((changedBits & 1) !== 0) this.local("deniedSound", ANNOUNCER);
      else if ((changedBits & 2) !== 0) this.local("humiliationSound", ANNOUNCER);
      else if ((changedBits & 4) !== 0) this.local("holyShitSound", ANNOUNCER);
      rewarded = true;
    }
    if (cgs.gameType >= GameType.GT_TEAM && [Powerup.PW_REDFLAG, Powerup.PW_BLUEFLAG, Powerup.PW_NEUTRALFLAG]
      .some(powerup => ps.powerups.get(powerup) !== previous.powerups.get(powerup) && ps.powerups.get(powerup) !== 0)) this.local("youHaveFlagSound", ANNOUNCER);
    if (!rewarded && state.warmup === 0 && changed(P.PERS_RANK) && cgs.gameType < GameType.GT_TEAM) {
      const rank = ps.persistant.get(P.PERS_RANK);
      if (rank === 0) this.buffered("takenLeadSound");
      else if (rank === 0x4000) this.buffered("tiedLeadSound");
      else if ((previous.persistant.get(P.PERS_RANK) & ~0x4000) === 0) this.buffered("lostLeadSound");
    }
    if (cgs.timelimit > 0) {
      const msec = (state.time - cgs.levelStartTime) | 0;
      if ((state.timelimitWarnings & 4) === 0 && msec > Math.imul((Math.imul(cgs.timelimit, 60) + 2) | 0, 1000)) {
        state.timelimitWarnings |= 7; this.local("suddenDeathSound", ANNOUNCER);
      } else if ((state.timelimitWarnings & 2) === 0 && msec > Math.imul(Math.imul((cgs.timelimit - 1) | 0, 60), 1000)) {
        state.timelimitWarnings |= 3; this.local("oneMinuteSound", ANNOUNCER);
      } else if (cgs.timelimit > 5 && (state.timelimitWarnings & 1) === 0 && msec > Math.imul(Math.imul((cgs.timelimit - 5) | 0, 60), 1000)) {
        state.timelimitWarnings |= 1; this.local("fiveMinuteSound", ANNOUNCER);
      }
    }
    if (cgs.fraglimit > 0 && cgs.gameType < GameType.GT_CTF) {
      if ((state.fraglimitWarnings & 4) === 0 && cgs.scores1 === ((cgs.fraglimit - 1) | 0)) {
        state.fraglimitWarnings |= 7; this.buffered("oneFragSound");
      } else if (cgs.fraglimit > 2 && (state.fraglimitWarnings & 2) === 0 && cgs.scores1 === ((cgs.fraglimit - 2) | 0)) {
        state.fraglimitWarnings |= 3; this.buffered("twoFragSound");
      } else if (cgs.fraglimit > 3 && (state.fraglimitWarnings & 1) === 0 && cgs.scores1 === ((cgs.fraglimit - 3) | 0)) {
        state.fraglimitWarnings |= 1; this.buffered("threeFragSound");
      }
    }
  }

  async transitionPlayerState(current: SourcePlayerState, previous: SourcePlayerState): Promise<void> {
    if (current.clientNum !== previous.clientNum) {
      this.state.thisFrameTeleport = true;
      Object.assign(previous, current.copy());
    }
    if (current.damageEvent !== previous.damageEvent && current.damageCount !== 0) this.damageFeedback(current.damageYaw, current.damagePitch, current.damageCount);
    if (current.persistant.get(P.PERS_SPAWN_COUNT) !== previous.persistant.get(P.PERS_SPAWN_COUNT)) this.respawn();
    if (this.state.mapRestart) { this.respawn(); this.state.mapRestart = false; }
    if (this.snapshot().playerState.pmType !== MoveType.PM_INTERMISSION && current.persistant.get(P.PERS_TEAM) !== Team.TEAM_SPECTATOR) this.checkLocalSounds(current, previous);
    this.checkAmmo();
    await this.checkPlayerstateEvents(current, previous);
    if (current.viewheight !== previous.viewheight) {
      this.state.duckChange = f32((current.viewheight - previous.viewheight) | 0);
      this.state.duckTime = this.state.time;
    }
  }
}
