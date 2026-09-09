// Source clientInfo_t from id Software's code/cgame/cg_local.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { Animation, AnimationCell, PlayerAnimationTarget, PlayerFootsteps, PlayerGender } from "../assets/animation.ts";
import type { PcmSound } from "../assets/wav.ts";
import { vec3 } from "../core/math.ts";
import { DEFAULT_MODEL } from "../render/ref-entity.ts";
import type { SceneModel, SceneSkin, SceneShader } from "../render/ref-entity.ts";
import { Team } from "../shared/definitions.ts";
import { PlayerAnimation } from "../shared/player-state.ts";

function zeroAnimation(): AnimationCell {
  return { firstFrame: 0, numFrames: 0, loopFrames: 0, frameLerp: 0, initialLerp: 0, reversed: false, flipflop: false };
}

/** One stable cgs.clientinfo slot. A configstring publication replaces its values, not its identity. */
export class ClientInfo implements PlayerAnimationTarget {
  infoValid = false;
  name = "";
  team = Team.TEAM_FREE;
  botSkill = 0;
  color1 = vec3(0, 0, 0);
  color2 = vec3(0, 0, 0);
  score = 0;
  location = 0;
  health = 0;
  armor = 0;
  curWeapon = 0;
  handicap = 0;
  wins = 0;
  losses = 0;
  teamTask = 0;
  teamLeader = false;
  powerups = 0;
  medkitUsageTime = 0;
  invulnerabilityStartTime = 0;
  invulnerabilityStopTime = 0;
  breathPuffTime = 0;
  modelName = "";
  skinName = "";
  headModelName = "";
  headSkinName = "";
  redTeam = "";
  blueTeam = "";
  deferred = false;
  newAnims = false;
  fixedLegs = false;
  fixedTorso = false;
  headOffset = vec3(0, 0, 0);
  footsteps: PlayerFootsteps = "normal";
  gender: PlayerGender = "male";
  legsModel: SceneModel = DEFAULT_MODEL;
  torsoModel: SceneModel = DEFAULT_MODEL;
  headModel: SceneModel = DEFAULT_MODEL;
  legsSkin: SceneSkin | null = null;
  torsoSkin: SceneSkin | null = null;
  headSkin: SceneSkin | null = null;
  modelIcon: SceneShader | null = null;
  readonly animations: readonly AnimationCell[] = Array.from({ length: PlayerAnimation.FLAG_STAND2RUN + 1 }, zeroAnimation);
  sounds: readonly (PcmSound | null)[] = Array.from({ length: 32 }, () => null);

  /** Source animation pointers keep addressing these cells after a value copy. */
  setAnimations(animations: readonly (Animation | null)[]): void {
    if (animations.length !== this.animations.length) throw new RangeError("Client animation table has the wrong length");
    for (let index = 0; index < animations.length; index++) {
      const source = animations[index], target = this.animations[index];
      if (source === null && index === PlayerAnimation.TORSO_NEGATIVE + 1) continue;
      if (source === undefined || source === null || target === undefined) throw new RangeError(`Missing client animation cell ${index}`);
      Object.assign(target, source);
    }
  }

  copyFrom(source: ClientInfo): this {
    const { animations, ...fields } = source;
    Object.assign(this, fields);
    this.setAnimations(animations);
    return this;
  }
}
