// Ported from id Software's game/ai_dmq3.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import type { AasEntityInfo } from "../botlib/entity.ts";
import type { BotGoal } from "../botlib/goals.ts";
import type { WeaponInfo } from "../botlib/weapons.ts";
import { DAMAGE_TYPE_RADIAL, WEAPON_FIRE_RELEASED } from "../botlib/weapons.ts";
import { TravelFlags } from "../botlib/routing.ts";
import { BotAvoidSpotType } from "../botlib/movement-state.ts";
import { ChatGender, unifyWhiteSpaces } from "../botlib/chat.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { add3, dot3, length3, normalize3, scale3, sub3, vec3, vectorToAngles } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { qvmAngleMod, qvmAngleVectors } from "../core/qvm-math.ts";
import { EntityEvent, EntityType, EV_EVENT_BITS, GameType, MoveType, PersistentIndex, Powerup, Team, Weapon, WeaponState, statSchema } from "../shared/definitions.ts";
import { EntityState } from "../shared/entity-state.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../shared/player-state.ts";
import type { ServerTraceResult } from "../server/world.ts";
import type { GameAiContext } from "./ai-context.ts";
import { BotCharacteristic, BotFlag, BotInventory, BotLongTermGoal, BotModelIndex, BotTeamTaskPreference, MAX_NODESWITCHES, MAX_PROXMINES } from "./ai-definitions.ts";
import { BotGoalState } from "./ai-state.ts";
import type { BotState } from "./ai-state.ts";
import { bot1FCTFCarryingFlag, botCTFCarryingFlag, botHarvesterCarryingCubes, botSameTeam, botTeam,
  botTeamFlagCarrierVisible, botEnemyFlagCarrierVisible, botTeamCubeCarrierVisible, botEnemyCubeCarrierVisible,
  botVisibleTeamMatesAndEnemies, clientFromName, clientName, botSynonymContext, teamPlayIsOn } from "./ai-orders.ts";
import { botTeamAI, botVoiceChat } from "./ai-team.ts";
import { botTeamLeader } from "./ai-main.ts";
import { botSetupAlternativeRouteGoals } from "./ai-navigation.ts";
import { botChatEnterGame, botChatTime, botValidChatPosition } from "./ai-chat.ts";
import { botMatchMessage } from "./ai-command.ts";
import { aiEnterSeekLtg, aiEnterStand, botDumpNodeSwitches, botResetNodeSwitches, runAiNode } from "./ai-decision.ts";
import { gameAtoi } from "./numeric.ts";
import { gameFormat } from "./format.ts";
import { GlobalTeamSound } from "./team.ts";

const f = Math.fround;
const SOLID = 1, LAVA = 8, SLIME = 16, WATER = 32, FOG = 64, PLAYERCLIP = 0x10000;
const LIQUID = LAVA | SLIME | WATER, MASK_SHOT = SOLID | 0x2000000 | 0x4000000;
const EF_TELEPORT_BIT = 4, EF_KAMIKAZE = 0x200, EF_FIRING = 0x100, EF_TALK = 0x1000;

export { vectorToAngles } from "../core/math.ts";

export function botInventoryValue(state: BotState, index: number): number {
  const value = state.inventory[index];
  if (value === undefined) throw new RangeError(`Bot inventory index ${index} outside its allocation`);
  return value;
}

function characteristic(context: GameAiContext, state: BotState, index: BotCharacteristic): number {
  return context.library.characters.boundedFloat(state.character, index, 0, 1);
}

export function botAITrace(context: GameAiContext, start: Vec3, end: Vec3, passEntity: number,
  mask: number, bounds: Bounds | null = null): ServerTraceResult {
  const trace = context.game.world.trace({ start, end, passEntityNum: passEntity, mask,
    shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } });
  // ai_main.c clears bsp_trace_t.contents after copying the engine trace.
  return { ...trace, contents: 0 };
}

export function botEntityInfo(context: GameAiContext, entity: number): AasEntityInfo {
  return context.library.aas.entities.info(entity);
}

export function entityIsDead(context: GameAiContext, info: AasEntityInfo): boolean {
  if (info.number < 0 || info.number >= 64) return false;
  const client = context.game.pool.at(info.number).client;
  return client !== null && client.ps.pmType !== MoveType.PM_NORMAL;
}

export function entityCarriesFlag(context: GameAiContext, info: AasEntityInfo): boolean {
  return (info.powerups & ((1 << Powerup.PW_REDFLAG) | (1 << Powerup.PW_BLUEFLAG)
    | (context.game.options.product === "missionpack" ? 1 << Powerup.PW_NEUTRALFLAG : 0))) !== 0;
}

export function entityIsInvisible(context: GameAiContext, info: AasEntityInfo): boolean {
  return !entityCarriesFlag(context, info) && (info.powerups & (1 << Powerup.PW_INVIS)) !== 0;
}

export function entityIsShooting(info: AasEntityInfo): boolean { return (info.flags & EF_FIRING) !== 0; }
export function entityIsChatting(info: AasEntityInfo): boolean { return (info.flags & EF_TALK) !== 0; }
export function entityHasQuad(info: AasEntityInfo): boolean { return (info.powerups & (1 << Powerup.PW_QUAD)) !== 0; }
export function entityHasKamikaze(info: AasEntityInfo): boolean { return (info.flags & EF_KAMIKAZE) !== 0; }
export function entityCarriesCubes(context: GameAiContext, info: AasEntityInfo): boolean {
  return context.deathmatch.gametype === GameType.GT_HARVESTER && context.game.pool.at(info.number).s.generic1 > 0;
}

export function botChooseWeapon(context: GameAiContext, state: BotState): void {
  if (state.curPs.weaponState !== WeaponState.WEAPON_RAISING && state.curPs.weaponState !== WeaponState.WEAPON_DROPPING) {
    const weapon = context.library.weapons.chooseBestFightWeapon(state.ws, state.inventory);
    if (state.weaponNum !== weapon) state.weaponChangeTime = context.time;
    state.weaponNum = weapon;
  }
  context.library.actions.selectWeapon(state.client, state.weaponNum);
}

export function botCheckItemPickup(context: GameAiContext, state: BotState, oldInventory: readonly number[]): void {
  if (state.product !== "missionpack" || context.deathmatch.gametype <= GameType.GT_TEAM) return;
  const picked = (index: BotInventory): boolean => {
    const previous = oldInventory[index];
    if (previous === undefined) throw new RangeError(`Missing old bot inventory slot ${index}`);
    return previous === 0 && botInventoryValue(state, index) >= 1;
  };
  let offense: boolean | null = null;
  if (picked(BotInventory.KAMIKAZE) || picked(BotInventory.INVULNERABILITY)) offense = true;
  if (botInventoryValue(state, BotInventory.KAMIKAZE) === 0 && botInventoryValue(state, BotInventory.INVULNERABILITY) === 0) {
    if (picked(BotInventory.SCOUT)) offense = true;
    if (picked(BotInventory.GUARD)) offense = true;
    if (picked(BotInventory.DOUBLER)) offense = false;
    if (picked(BotInventory.AMMOREGEN)) offense = false;
  }
  if (offense === null) return;
  const leader = clientFromName(context, state.teamLeader);
  const flagsAtBase = (context.deathmatch.gametype !== GameType.GT_CTF || state.redFlagStatus === 0 && state.blueFlagStatus === 0)
    && (context.deathmatch.gametype !== GameType.GT_1FCTF || state.neutralFlagStatus === 0);
  if (offense) {
    if ((state.teamTaskPreference & BotTeamTaskPreference.ATTACKER) === 0) {
      if (botTeamLeader(context, state)) botVoiceChat(context, state, leader, "wantonoffense");
      else if (context.cvar("g_spSkill").integerValue <= 3) {
        if (state.ltgType !== BotLongTermGoal.GETFLAG && state.ltgType !== BotLongTermGoal.ATTACKENEMYBASE
          && state.ltgType !== BotLongTermGoal.HARVEST && flagsAtBase) botVoiceChat(context, state, leader, "wantonoffense");
        state.teamTaskPreference |= BotTeamTaskPreference.ATTACKER;
      }
    }
    state.teamTaskPreference &= ~BotTeamTaskPreference.DEFENDER;
  } else {
    if ((state.teamTaskPreference & BotTeamTaskPreference.DEFENDER) === 0) {
      if (botTeamLeader(context, state)) botVoiceChat(context, state, -1, "wantondefense");
      else if (context.cvar("g_spSkill").integerValue <= 3 && state.ltgType !== BotLongTermGoal.DEFENDKEYAREA && flagsAtBase) {
        botVoiceChat(context, state, -1, "wantondefense");
      }
      state.teamTaskPreference |= BotTeamTaskPreference.DEFENDER;
    }
    state.teamTaskPreference &= ~BotTeamTaskPreference.ATTACKER;
  }
}

const weaponInventory: readonly (readonly [BotInventory, Weapon])[] = [
  [BotInventory.GAUNTLET, Weapon.WP_GAUNTLET], [BotInventory.SHOTGUN, Weapon.WP_SHOTGUN],
  [BotInventory.MACHINEGUN, Weapon.WP_MACHINEGUN], [BotInventory.GRENADELAUNCHER, Weapon.WP_GRENADE_LAUNCHER],
  [BotInventory.ROCKETLAUNCHER, Weapon.WP_ROCKET_LAUNCHER], [BotInventory.LIGHTNING, Weapon.WP_LIGHTNING],
  [BotInventory.RAILGUN, Weapon.WP_RAILGUN], [BotInventory.PLASMAGUN, Weapon.WP_PLASMAGUN],
  [BotInventory.BFG10K, Weapon.WP_BFG], [BotInventory.GRAPPLINGHOOK, Weapon.WP_GRAPPLING_HOOK],
  [BotInventory.NAILGUN, Weapon.WP_NAILGUN], [BotInventory.PROXLAUNCHER, Weapon.WP_PROX_LAUNCHER],
  [BotInventory.CHAINGUN, Weapon.WP_CHAINGUN],
];
const ammoInventory: readonly (readonly [BotInventory, Weapon])[] = [
  [BotInventory.SHELLS, Weapon.WP_SHOTGUN], [BotInventory.BULLETS, Weapon.WP_MACHINEGUN],
  [BotInventory.GRENADES, Weapon.WP_GRENADE_LAUNCHER], [BotInventory.CELLS, Weapon.WP_PLASMAGUN],
  [BotInventory.LIGHTNINGAMMO, Weapon.WP_LIGHTNING], [BotInventory.ROCKETS, Weapon.WP_ROCKET_LAUNCHER],
  [BotInventory.SLUGS, Weapon.WP_RAILGUN], [BotInventory.BFGAMMO, Weapon.WP_BFG],
  [BotInventory.NAILS, Weapon.WP_NAILGUN], [BotInventory.MINES, Weapon.WP_PROX_LAUNCHER],
  [BotInventory.BELT, Weapon.WP_CHAINGUN],
];
const holdableInventory: readonly (readonly [BotInventory, BotModelIndex])[] = [
  [BotInventory.TELEPORTER, BotModelIndex.TELEPORTER], [BotInventory.MEDKIT, BotModelIndex.MEDKIT],
  [BotInventory.KAMIKAZE, BotModelIndex.KAMIKAZE], [BotInventory.PORTAL, BotModelIndex.PORTAL],
  [BotInventory.INVULNERABILITY, BotModelIndex.INVULNERABILITY],
];
const powerupInventory: readonly (readonly [BotInventory, Powerup])[] = [
  [BotInventory.QUAD, Powerup.PW_QUAD], [BotInventory.ENVIRONMENTSUIT, Powerup.PW_BATTLESUIT],
  [BotInventory.HASTE, Powerup.PW_HASTE], [BotInventory.INVISIBILITY, Powerup.PW_INVIS],
  [BotInventory.REGEN, Powerup.PW_REGEN], [BotInventory.FLIGHT, Powerup.PW_FLIGHT],
  [BotInventory.REDFLAG, Powerup.PW_REDFLAG], [BotInventory.BLUEFLAG, Powerup.PW_BLUEFLAG],
  [BotInventory.NEUTRALFLAG, Powerup.PW_NEUTRALFLAG],
];
const persistentInventory: readonly (readonly [BotInventory, BotModelIndex])[] = [
  [BotInventory.SCOUT, BotModelIndex.SCOUT], [BotInventory.GUARD, BotModelIndex.GUARD],
  [BotInventory.DOUBLER, BotModelIndex.DOUBLER], [BotInventory.AMMOREGEN, BotModelIndex.AMMOREGEN],
];

export function botUpdateInventory(context: GameAiContext, state: BotState): void {
  const oldInventory = state.inventory.slice(), ps = state.curPs, schema = statSchema(state.product);
  state.inventory[BotInventory.ARMOR] = ps.stats.get(schema.armor);
  const weapons = ps.stats.get(schema.weapons);
  for (const [index, weapon] of weaponInventory) {
    if (state.product === "baseq3" && weapon > Weapon.WP_GRAPPLING_HOOK) continue;
    state.inventory[index] = Number((weapons & (1 << weapon)) !== 0);
  }
  for (const [index, weapon] of ammoInventory) {
    if (state.product === "baseq3" && weapon > Weapon.WP_GRAPPLING_HOOK) continue;
    state.inventory[index] = ps.ammo.get(weapon);
  }
  state.inventory[BotInventory.HEALTH] = ps.stats.get(schema.health);
  for (const [index, model] of holdableInventory) {
    if (state.product === "baseq3" && index > BotInventory.MEDKIT) continue;
    state.inventory[index] = Number(ps.stats.get(schema.holdableItem) === model);
  }
  for (const [index, powerup] of powerupInventory) {
    if (state.product === "baseq3" && powerup === Powerup.PW_NEUTRALFLAG) continue;
    state.inventory[index] = Number(ps.powerups.get(powerup) !== 0);
  }
  if (schema.product === "missionpack") {
    for (const [index, model] of persistentInventory) state.inventory[index] = Number(ps.stats.get(schema.persistentPowerup) === model);
    const red = botTeam(context, state) === Team.TEAM_RED;
    state.inventory[BotInventory.REDCUBE] = red ? ps.generic1 : 0;
    state.inventory[BotInventory.BLUECUBE] = red ? 0 : ps.generic1;
  }
  botCheckItemPickup(context, state, oldInventory);
}

export function botUpdateBattleInventory(context: GameAiContext, state: BotState, enemy: number): void {
  const direction = sub3(botEntityInfo(context, enemy).origin, state.origin);
  state.inventory[BotInventory.ENEMY_HEIGHT] = qvmFloatToInt(direction.z);
  state.inventory[BotInventory.ENEMY_HORIZONTAL_DIST] = qvmFloatToInt(length3(vec3(direction.x, direction.y, 0)));
}

function carryingObjective(context: GameAiContext, state: BotState): boolean {
  return Boolean(botCTFCarryingFlag(context, state)) || state.product === "missionpack"
    && (Boolean(bot1FCTFCarryingFlag(context, state)) || Boolean(botHarvesterCarryingCubes(context, state)));
}

function carrierWithin(context: GameAiContext, state: BotState, entity: number, distance: number): boolean {
  if (entity < 0) return false;
  const direction = sub3(botEntityInfo(context, entity).origin, state.origin);
  return dot3(direction, direction) < f(distance * distance);
}

function goalVisibleWithin(context: GameAiContext, state: BotState, goal: BotGoalState, distance: number): boolean {
  const target = add3(goal.origin, vec3(0, 0, 1)), direction = sub3(state.origin, target);
  if (dot3(direction, direction) >= f(distance * distance)) return false;
  const trace = botAITrace(context, state.eye, target, state.client, SOLID);
  return trace.fraction >= 1 || trace.entityNum === goal.entity;
}

export function botUseKamikaze(context: GameAiContext, state: BotState): void {
  if (botInventoryValue(state, BotInventory.KAMIKAZE) <= 0 || state.kamikazeTime > context.time) return;
  state.kamikazeTime = f(context.time + f(0.2));
  const mode = context.deathmatch.gametype;
  if (mode === GameType.GT_CTF || mode === GameType.GT_1FCTF) {
    if (carryingObjective(context, state)) return;
    if (carrierWithin(context, state, botTeamFlagCarrierVisible(context, state), 1024)) return;
    if (carrierWithin(context, state, botEnemyFlagCarrierVisible(context, state), 1024)) {
      context.library.actions.use(state.client); return;
    }
  } else if (mode === GameType.GT_OBELISK) {
    const goal = botTeam(context, state) === Team.TEAM_RED ? context.deathmatch.blueObelisk : context.deathmatch.redObelisk;
    if (goalVisibleWithin(context, state, goal, f(1024 * f(0.9)))) { context.library.actions.use(state.client); return; }
  } else if (mode === GameType.GT_HARVESTER) {
    if (botHarvesterCarryingCubes(context, state)) return;
    if (carrierWithin(context, state, botTeamCubeCarrierVisible(context, state), 1024)) return;
    if (carrierWithin(context, state, botEnemyCubeCarrierVisible(context, state), 1024)) {
      context.library.actions.use(state.client); return;
    }
  }
  const visible = botVisibleTeamMatesAndEnemies(context, state, 1024);
  if (visible.enemies > 2 && visible.enemies > visible.teammates + 1) context.library.actions.use(state.client);
}

export function botUseInvulnerability(context: GameAiContext, state: BotState): void {
  if (botInventoryValue(state, BotInventory.INVULNERABILITY) <= 0 || state.invulnerabilityTime > context.time) return;
  state.invulnerabilityTime = f(context.time + f(0.2));
  const mode = context.deathmatch.gametype, red = botTeam(context, state) === Team.TEAM_RED;
  if (mode === GameType.GT_CTF || mode === GameType.GT_1FCTF) {
    if (carryingObjective(context, state) || botEnemyFlagCarrierVisible(context, state) >= 0) return;
    if (goalVisibleWithin(context, state, red ? context.deathmatch.ctfBlueFlag : context.deathmatch.ctfRedFlag, 200)) context.library.actions.use(state.client);
  } else if (mode === GameType.GT_OBELISK) {
    if (goalVisibleWithin(context, state, red ? context.deathmatch.blueObelisk : context.deathmatch.redObelisk, 300)) context.library.actions.use(state.client);
  } else if (mode === GameType.GT_HARVESTER) {
    if (botHarvesterCarryingCubes(context, state) || botEnemyCubeCarrierVisible(context, state) >= 0) return;
    if (goalVisibleWithin(context, state, red ? context.deathmatch.blueObelisk : context.deathmatch.redObelisk, 200)) context.library.actions.use(state.client);
  }
}

export function botBattleUseItems(context: GameAiContext, state: BotState): void {
  if (botInventoryValue(state, BotInventory.HEALTH) < 40 && botInventoryValue(state, BotInventory.TELEPORTER) > 0
    && !carryingObjective(context, state)) context.library.actions.use(state.client);
  if (botInventoryValue(state, BotInventory.HEALTH) < 60 && botInventoryValue(state, BotInventory.MEDKIT) > 0) context.library.actions.use(state.client);
  if (state.product === "missionpack") { botUseKamikaze(context, state); botUseInvulnerability(context, state); }
}

export function botSetTeleportTime(context: GameAiContext, state: BotState): void {
  if (((state.curPs.eFlags ^ state.lastEFlags) & EF_TELEPORT_BIT) !== 0) state.teleportTime = context.time;
  state.lastEFlags = state.curPs.eFlags;
}
export function botIsDead(_context: GameAiContext, state: BotState): boolean { return state.curPs.pmType === MoveType.PM_DEAD; }
export function botIsObserver(context: GameAiContext, state: BotState): boolean {
  if (state.curPs.pmType === MoveType.PM_SPECTATOR) return true;
  return gameAtoi(infoValueForKey(context.game.options.configstrings.get(544 + state.client).slice(0, 1023), "t")) === Team.TEAM_SPECTATOR;
}
export function botIntermission(context: GameAiContext, state: BotState): boolean {
  return context.game.level.intermissionTime !== 0 || state.curPs.pmType === MoveType.PM_FREEZE || state.curPs.pmType === MoveType.PM_INTERMISSION;
}
export function botInLavaOrSlime(context: GameAiContext, state: BotState): boolean {
  return (context.game.world.pointContents(add3(state.origin, vec3(0, 0, -23)), -1) & (LAVA | SLIME)) !== 0;
}

export function botAggression(_context: GameAiContext, state: BotState): number {
  const inventory = (index: BotInventory) => botInventoryValue(state, index);
  if (inventory(BotInventory.QUAD) !== 0 && (state.weaponNum !== Weapon.WP_GAUNTLET || inventory(BotInventory.ENEMY_HORIZONTAL_DIST) < 80)) return 70;
  if (inventory(BotInventory.ENEMY_HEIGHT) > 200 || inventory(BotInventory.HEALTH) < 60) return 0;
  if (inventory(BotInventory.HEALTH) < 80 && inventory(BotInventory.ARMOR) < 40) return 0;
  for (const [weapon, ammo, minimum, aggression] of [
    [BotInventory.BFG10K, BotInventory.BFGAMMO, 7, 100], [BotInventory.RAILGUN, BotInventory.SLUGS, 5, 95],
    [BotInventory.LIGHTNING, BotInventory.LIGHTNINGAMMO, 50, 90], [BotInventory.ROCKETLAUNCHER, BotInventory.ROCKETS, 5, 90],
    [BotInventory.PLASMAGUN, BotInventory.CELLS, 40, 85], [BotInventory.GRENADELAUNCHER, BotInventory.GRENADES, 10, 80],
    [BotInventory.SHOTGUN, BotInventory.SHELLS, 10, 50],
  ] satisfies readonly (readonly [BotInventory, BotInventory, number, number])[]) {
    if (inventory(weapon) > 0 && inventory(ammo) > minimum) return aggression;
  }
  return 0;
}

export function botFeelingBad(_context: GameAiContext, state: BotState): number {
  if (state.weaponNum === Weapon.WP_GAUNTLET || botInventoryValue(state, BotInventory.HEALTH) < 40) return 100;
  if (state.weaponNum === Weapon.WP_MACHINEGUN) return 90;
  if (botInventoryValue(state, BotInventory.HEALTH) < 60) return 80;
  return 0;
}

export function botWantsToRetreat(context: GameAiContext, state: BotState): boolean {
  if (carryingObjective(context, state)) return true;
  if (state.product === "missionpack" && context.deathmatch.gametype === GameType.GT_OBELISK) {
    if (state.ltgType === BotLongTermGoal.ATTACKENEMYBASE && (state.enemy !== context.deathmatch.redObelisk.entity
      || state.enemy !== context.deathmatch.blueObelisk.entity)) return true;
    return botFeelingBad(context, state) > 50;
  }
  if (state.enemy >= 0 && entityCarriesFlag(context, botEntityInfo(context, state.enemy))) return false;
  return state.ltgType === BotLongTermGoal.GETFLAG || botAggression(context, state) < 50;
}

export function botWantsToChase(context: GameAiContext, state: BotState): boolean {
  if (carryingObjective(context, state)) return false;
  const mode = context.deathmatch.gametype;
  if ((mode === GameType.GT_CTF || state.product === "missionpack" && mode === GameType.GT_1FCTF)
    && entityCarriesFlag(context, botEntityInfo(context, state.enemy))) return true;
  if (state.product === "missionpack" && mode === GameType.GT_OBELISK && state.ltgType === BotLongTermGoal.ATTACKENEMYBASE
    && (state.enemy !== context.deathmatch.redObelisk.entity || state.enemy !== context.deathmatch.blueObelisk.entity)) return false;
  return state.ltgType !== BotLongTermGoal.GETFLAG && botAggression(context, state) > 50;
}

export function botWantsToHelp(_context: GameAiContext, _state: BotState): boolean { return true; }
export function botCanAndWantsToRocketJump(context: GameAiContext, state: BotState): boolean {
  if (context.cvar("bot_rocketjump").integerValue === 0) return false;
  if (botInventoryValue(state, BotInventory.ROCKETLAUNCHER) <= 0 || botInventoryValue(state, BotInventory.ROCKETS) < 3) return false;
  if (botInventoryValue(state, BotInventory.QUAD) !== 0 || botInventoryValue(state, BotInventory.HEALTH) < 60) return false;
  if (botInventoryValue(state, BotInventory.HEALTH) < 90 && botInventoryValue(state, BotInventory.ARMOR) < 40) return false;
  return characteristic(context, state, BotCharacteristic.WEAPONJUMPING) >= 0.5;
}

export function botHasPersistantPowerupAndWeapon(_context: GameAiContext, state: BotState): boolean {
  if (state.product === "missionpack" && persistentInventory.every(([index]) => botInventoryValue(state, index) === 0)) return false;
  if (botInventoryValue(state, BotInventory.HEALTH) < 60) return false;
  if (botInventoryValue(state, BotInventory.HEALTH) < 80 && botInventoryValue(state, BotInventory.ARMOR) < 40) return false;
  return ([
    [BotInventory.BFG10K, BotInventory.BFGAMMO, 7], [BotInventory.RAILGUN, BotInventory.SLUGS, 5],
    [BotInventory.LIGHTNING, BotInventory.LIGHTNINGAMMO, 50], [BotInventory.ROCKETLAUNCHER, BotInventory.ROCKETS, 5],
    [BotInventory.NAILGUN, BotInventory.NAILS, 5], [BotInventory.PROXLAUNCHER, BotInventory.MINES, 5],
    [BotInventory.CHAINGUN, BotInventory.BELT, 40], [BotInventory.PLASMAGUN, BotInventory.CELLS, 20],
  ] satisfies readonly (readonly [BotInventory, BotInventory, number])[])
    .some(([weapon, ammo, minimum]) => botInventoryValue(state, weapon) > 0 && botInventoryValue(state, ammo) > minimum);
}

export function botGoCamp(context: GameAiContext, state: BotState, goal: BotGoal): void {
  state.decisionmaker = state.client;
  state.teamMessageTime = 0;
  state.ltgType = BotLongTermGoal.CAMP;
  state.teamGoal.copyFrom(goal);
  const camper = characteristic(context, state, BotCharacteristic.CAMPER);
  state.teamGoalTime = camper > f(0.99) ? f(context.time + 99999)
    : f(f(f(context.time + 120) + f(180 * camper)) + f(context.game.random.random() * 15));
  state.campTime = context.time;
  state.teammate = 0;
  state.arriveTime = 1;
}

export function botWantsToCamp(context: GameAiContext, state: BotState): boolean {
  const camper = characteristic(context, state, BotCharacteristic.CAMPER);
  if (camper < f(0.1)) return false;
  if ([BotLongTermGoal.TEAMHELP, BotLongTermGoal.TEAMACCOMPANY, BotLongTermGoal.DEFENDKEYAREA, BotLongTermGoal.GETFLAG,
    BotLongTermGoal.RUSHBASE, BotLongTermGoal.CAMP, BotLongTermGoal.CAMPORDER, BotLongTermGoal.PATROL].includes(state.ltgType)) return false;
  if (state.campTime > f(f(context.time - 60) + f(300 * f(1 - camper)))) return false;
  if (context.game.random.random() > camper) { state.campTime = context.time; return false; }
  if (botAggression(context, state) < 50) return false;
  // The original indexes inventory[INVENTORY_ROCKETS < 10], which selects slot zero.
  if ((botInventoryValue(state, BotInventory.ROCKETLAUNCHER) <= 0 || botInventoryValue(state, 0) !== 0)
    && (botInventoryValue(state, BotInventory.RAILGUN) <= 0 || botInventoryValue(state, BotInventory.SLUGS) < 10)
    && (botInventoryValue(state, BotInventory.BFG10K) <= 0 || botInventoryValue(state, BotInventory.BFGAMMO) < 10)) return false;
  const phase = context.library.aas.phase;
  if (phase.kind !== "ready") return false;
  let bestTime = 99999;
  const bestGoal = new BotGoalState();
  for (let spot = context.library.goals.getNextCampSpotGoal(0); spot !== null; spot = context.library.goals.getNextCampSpotGoal(spot.next)) {
    const time = phase.map.routing.areaTravelTimeToGoal({ area: state.areaNum, origin: state.origin, goalArea: spot.goal.area, travelFlags: TravelFlags.DEFAULT });
    if (time !== 0 && time < bestTime) { bestTime = time; bestGoal.copyFrom(spot.goal); }
  }
  if (bestTime > 150) return false;
  botGoCamp(context, state, bestGoal);
  state.ordered = false;
  return true;
}

export function botDontAvoid(context: GameAiContext, state: BotState, itemName: string): void {
  for (let goal = context.library.goals.getLevelItemGoal(-1, itemName); goal !== null; goal = context.library.goals.getLevelItemGoal(goal.number, itemName)) {
    context.library.goals.removeFromAvoidGoals(state.gs, goal.number);
  }
}
export function botGoForPowerups(context: GameAiContext, state: BotState): void {
  for (const name of ["Quad Damage", "Regeneration", "Battle Suit", "Speed", "Invisibility"]) botDontAvoid(context, state, name);
  state.ltgTime = 0;
}

export function inFieldOfVision(viewangles: Vec3, fov: number, angles: Vec3): boolean {
  for (const axis of ["x", "y"] satisfies readonly (keyof Vec3)[]) {
    const angle = qvmAngleMod(viewangles[axis]), target = qvmAngleMod(angles[axis]);
    Object.assign(angles, { [axis]: target });
    let difference = f(target - angle);
    if (target > angle) { if (difference > 180) difference = f(difference - 360); }
    else if (difference < -180) difference = f(difference + 360);
    if (difference > f(fov * 0.5) || difference < f(-fov * 0.5)) return false;
  }
  return true;
}

export function botEntityVisible(context: GameAiContext, viewer: number, eye: Vec3, viewangles: Vec3, fov: number, entity: number): number {
  const info = botEntityInfo(context, entity);
  let middle = add3(info.origin, scale3(add3(info.mins, info.maxs), 0.5));
  if (!inFieldOfVision(viewangles, fov, vectorToAngles(sub3(middle, eye)))) return 0;
  const contents = context.game.world.pointContents(eye, -1), inFog = (contents & FOG) !== 0, inWater = (contents & LIQUID) !== 0;
  let bestVisibility = 0;
  for (let i = 0; i < 3; i++) {
    let mask = SOLID | PLAYERCLIP, pass = viewer, hit = entity, start = eye, end = middle;
    if ((context.game.world.pointContents(middle, -1) & LIQUID) !== 0) mask |= LIQUID;
    if (inWater) {
      if ((mask & LIQUID) === 0) { pass = entity; hit = viewer; start = middle; end = eye; }
      mask ^= LIQUID;
    }
    let trace = botAITrace(context, start, end, pass, mask), waterFactor = 1;
    if ((trace.contents & LIQUID) !== 0) {
      mask &= ~LIQUID;
      trace = botAITrace(context, trace.end, end, pass, mask);
      waterFactor = 0.5;
    }
    if (trace.fraction >= 1 || trace.entityNum === hit) {
      const otherInFog = (context.game.world.pointContents(middle, -1) & FOG) !== 0;
      let fogDistanceSquared = 0;
      if (inFog && otherInFog) {
        const direction = sub3(trace.end, eye); fogDistanceSquared = dot3(direction, direction);
      } else if (inFog) {
        trace = botAITrace(context, trace.end, eye, viewer, FOG);
        const direction = sub3(eye, trace.end); fogDistanceSquared = dot3(direction, direction);
      } else if (otherInFog) {
        end = trace.end;
        trace = botAITrace(context, eye, end, viewer, FOG);
        const direction = sub3(end, trace.end); fogDistanceSquared = dot3(direction, direction);
      }
      const visibility = f(f(1 / Math.max(1, f(fogDistanceSquared * f(0.001)))) * waterFactor);
      if (visibility > bestVisibility) bestVisibility = visibility;
      if (bestVisibility >= f(0.95)) return bestVisibility;
    }
    if (i === 0) middle = add3(middle, vec3(0, 0, info.mins.z));
    else if (i === 1) middle = add3(middle, vec3(0, 0, f(info.maxs.z - info.mins.z)));
  }
  return bestVisibility;
}

export function botFindEnemy(context: GameAiContext, state: BotState, currentEnemy: number): boolean {
  const alertness = characteristic(context, state, BotCharacteristic.ALERTNESS), easyFragger = characteristic(context, state, BotCharacteristic.EASY_FRAGGER);
  const healthDecreased = state.lastHealth > botInventoryValue(state, BotInventory.HEALTH);
  state.lastHealth = botInventoryValue(state, BotInventory.HEALTH);
  let currentDistance = 0;
  if (currentEnemy >= 0) {
    const info = botEntityInfo(context, currentEnemy);
    if (entityCarriesFlag(context, info)) return false;
    const direction = sub3(info.origin, state.origin); currentDistance = dot3(direction, direction);
  }
  if (state.product === "missionpack" && context.deathmatch.gametype === GameType.GT_OBELISK) {
    const goal = botTeam(context, state) === Team.TEAM_RED ? context.deathmatch.blueObelisk : context.deathmatch.redObelisk;
    const trace = botAITrace(context, state.eye, add3(goal.origin, vec3(0, 0, 1)), state.client, SOLID);
    if (trace.fraction >= 1 || trace.entityNum === goal.entity) {
      if (goal.entity === state.enemy) return false;
      state.enemy = goal.entity; state.enemySightTime = context.time; state.enemySuicide = false;
      state.enemyDeathTime = 0; state.enemyVisibleTime = context.time;
      return true;
    }
  }
  for (let client = 0; client < context.deathmatch.maxclients && client < 64; client++) {
    if (client === state.client || client === currentEnemy) continue;
    const info = botEntityInfo(context, client);
    if (!info.valid || entityIsDead(context, info) || info.number === state.entityNum) continue;
    if (entityIsInvisible(context, info) && !entityIsShooting(info)) continue;
    if (easyFragger < 0.5 && entityIsChatting(info)) continue;
    if (context.deathmatch.lastTeleportTime > f(context.time - 3)) {
      const direction = sub3(info.origin, context.deathmatch.lastTeleportOrigin);
      if (dot3(direction, direction) < 70 * 70) continue;
    }
    const direction = sub3(info.origin, state.origin), distance = dot3(direction, direction);
    if (!entityCarriesFlag(context, info) && currentEnemy >= 0 && distance > currentDistance) continue;
    const alertRange = f(900 + f(alertness * 4000));
    if (distance > f(alertRange * alertRange) || botSameTeam(context, state, client)) continue;
    const fov = currentEnemy < 0 && (healthDecreased || entityIsShooting(info)) ? 360 : f(180 - f(90 - f(Math.min(810 * 810, distance) / (810 * 9))));
    if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, fov, client) <= 0) continue;
    if (currentEnemy < 0 && distance > 100 * 100 && !healthDecreased && !entityIsShooting(info)
      && !inFieldOfVision(info.angles, 90, vectorToAngles(sub3(state.origin, info.origin)))) {
      botUpdateBattleInventory(context, state, client);
      if (botWantsToRetreat(context, state)) continue;
    }
    state.enemy = info.number;
    state.enemySightTime = currentEnemy >= 0 ? f(context.time - 2) : context.time;
    state.enemySuicide = false; state.enemyDeathTime = 0; state.enemyVisibleTime = context.time;
    return true;
  }
  return false;
}

function weaponInfo(context: GameAiContext, state: BotState): WeaponInfo {
  const info = context.library.weapons.getWeaponInfo(state.ws, state.weaponNum);
  if (info === undefined) throw new Error(`Bot weapon ${state.weaponNum} has no loaded weapon information`);
  return info;
}

export function botAimAtEnemy(context: GameAiContext, state: BotState): void {
  if (state.enemy < 0) return;
  let info = botEntityInfo(context, state.enemy);
  if (state.enemy >= 64) {
    const target = state.product === "missionpack" && (state.enemy === context.deathmatch.redObelisk.entity || state.enemy === context.deathmatch.blueObelisk.entity)
      ? add3(info.origin, vec3(0, 0, 32)) : info.origin;
    Object.assign(state.idealViewangles, vectorToAngles(sub3(target, state.eye)));
    Object.assign(state.aimTarget, target);
    return;
  }
  let aimSkill = characteristic(context, state, BotCharacteristic.AIM_SKILL), aimAccuracy = characteristic(context, state, BotCharacteristic.AIM_ACCURACY);
  if (aimSkill > f(0.95)) {
    const reactionTime = f(0.5 * characteristic(context, state, BotCharacteristic.REACTIONTIME));
    if (state.enemySightTime > f(context.time - reactionTime) || state.teleportTime > f(context.time - reactionTime)) return;
  }
  const weapon = weaponInfo(context, state);
  const accuracyIndex = weapon.number === Weapon.WP_MACHINEGUN ? BotCharacteristic.AIM_ACCURACY_MACHINEGUN
    : weapon.number === Weapon.WP_SHOTGUN ? BotCharacteristic.AIM_ACCURACY_SHOTGUN
    : weapon.number === Weapon.WP_GRENADE_LAUNCHER ? BotCharacteristic.AIM_ACCURACY_GRENADELAUNCHER
    : weapon.number === Weapon.WP_ROCKET_LAUNCHER ? BotCharacteristic.AIM_ACCURACY_ROCKETLAUNCHER
    : weapon.number === Weapon.WP_LIGHTNING ? BotCharacteristic.AIM_ACCURACY_LIGHTNING
    : weapon.number === Weapon.WP_RAILGUN ? BotCharacteristic.AIM_ACCURACY_RAILGUN
    : weapon.number === Weapon.WP_PLASMAGUN ? BotCharacteristic.AIM_ACCURACY_PLASMAGUN
    : weapon.number === Weapon.WP_BFG ? BotCharacteristic.AIM_ACCURACY_BFG10K : null;
  if (accuracyIndex !== null) aimAccuracy = characteristic(context, state, accuracyIndex);
  const skillIndex = weapon.number === Weapon.WP_GRENADE_LAUNCHER ? BotCharacteristic.AIM_SKILL_GRENADELAUNCHER
    : weapon.number === Weapon.WP_ROCKET_LAUNCHER ? BotCharacteristic.AIM_SKILL_ROCKETLAUNCHER
    : weapon.number === Weapon.WP_PLASMAGUN ? BotCharacteristic.AIM_SKILL_PLASMAGUN
    : weapon.number === Weapon.WP_BFG ? BotCharacteristic.AIM_SKILL_BFG10K : null;
  if (skillIndex !== null) aimSkill = characteristic(context, state, skillIndex);
  if (aimAccuracy <= 0) aimAccuracy = f(0.0001);
  info = botEntityInfo(context, state.enemy);
  if (entityIsInvisible(context, info) && context.game.random.random() > f(0.1)) aimAccuracy = f(aimAccuracy * f(0.4));
  const velocity = scale3(sub3(info.origin, info.lastVisibleOrigin), f(1 / info.updateInterval));
  if (state.enemyPositionTime < context.time) {
    state.enemyPositionTime = f(context.time + 0.5);
    Object.assign(state.enemyVelocity, velocity);
    Object.assign(state.enemyOrigin, info.origin);
  }
  const movement = sub3(info.origin, state.enemyOrigin);
  if (aimSkill < f(0.9) && dot3(movement, movement) > 48 * 48 && dot3(state.enemyVelocity, velocity) < 0) aimAccuracy = f(aimAccuracy * f(0.7));
  // The source stores the float visibility result in an int before testing it.
  const visible = qvmFloatToInt(botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.enemy)) !== 0;
  let bestOrigin: Vec3;
  if (visible) {
    bestOrigin = add3(info.origin, vec3(0, 0, 8));
    const start = add3(add3(state.origin, vec3(0, 0, state.curPs.viewheight)), vec3(0, 0, weapon.offset.z));
    let trace = botAITrace(context, start, bestOrigin, state.entityNum, MASK_SHOT, { min: vec3(-4, -4, -4), max: vec3(4, 4, 4) });
    if (trace.fraction <= 1 && trace.entityNum !== info.number) bestOrigin = add3(bestOrigin, vec3(0, 0, 16));
    if (weapon.speed !== 0) {
      const distance = length3(sub3(bestOrigin, state.origin));
      if (!(distance > 100 && dot3(movement, movement) < 32 * 32)) {
        if (aimSkill > f(0.8) && state.curPs.weaponState === WeaponState.WEAPON_READY) {
          const predicted = context.library.movementRouting.spatial.movement.predictClientMovement({
            entityNum: state.enemy, origin: add3(info.origin, vec3(0, 0, 1)), presence: 4, onGround: false,
            velocity, commandMove: vec3(0, 0, 0), commandFrames: 0,
            maxFrames: qvmFloatToInt(f(f(length3(sub3(info.origin, state.origin)) * 10) / weapon.speed)),
            frameTime: f(0.1), stopEvents: 0, stopArea: 0, visualize: false,
          });
          bestOrigin = predicted.move.end;
        } else if (aimSkill > f(0.4)) {
          const displacement = sub3(info.origin, info.lastVisibleOrigin), horizontal = vec3(displacement.x, displacement.y, 0);
          const speed = f(length3(horizontal) / info.updateInterval);
          bestOrigin = add3(info.origin, scale3(normalize3(horizontal), f(f(length3(sub3(info.origin, state.origin)) / weapon.speed) * speed)));
        }
      }
    }
    if (aimSkill > f(0.6) && (weapon.projectileInfo.damageType & DAMAGE_TYPE_RADIAL) !== 0 && info.origin.z < f(state.origin.z + 16)) {
      trace = botAITrace(context, info.origin, add3(info.origin, vec3(0, 0, -64)), info.number, MASK_SHOT);
      const groundTarget = vec3(bestOrigin.x, bestOrigin.y, trace.solidity !== "clear" ? info.origin.z - 16 : trace.end.z - 8);
      trace = botAITrace(context, start, groundTarget, state.entityNum, MASK_SHOT);
      const groundDelta = sub3(trace.end, groundTarget), selfDelta = sub3(trace.end, start);
      if (Math.abs(f(trace.end.z - groundTarget.z)) < 50 && dot3(groundDelta, groundDelta) < 60 * 60 && dot3(selfDelta, selfDelta) > 100 * 100) {
        trace = botAITrace(context, add3(trace.end, vec3(0, 0, 1)), info.origin, info.number, MASK_SHOT);
        if (trace.fraction >= 1) bestOrigin = groundTarget;
      }
    }
    bestOrigin = vec3(bestOrigin.x + f(f(20 * context.game.random.crandom()) * f(1 - aimAccuracy)),
      bestOrigin.y + f(f(20 * context.game.random.crandom()) * f(1 - aimAccuracy)), bestOrigin.z + f(f(10 * context.game.random.crandom()) * f(1 - aimAccuracy)));
  } else {
    bestOrigin = add3(state.lastEnemyOrigin, vec3(0, 0, 8));
    if (aimSkill > 0.5 && (weapon.number === Weapon.WP_BFG || weapon.number === Weapon.WP_ROCKET_LAUNCHER || weapon.number === Weapon.WP_GRENADE_LAUNCHER)) {
      const goal = new BotGoalState(); goal.entity = state.client; goal.area = state.areaNum;
      Object.assign(goal.origin, state.eye);
      goal.mins = vec3(-8, -8, -8); goal.maxs = vec3(8, 8, 8);
      const target = { value: vec3(0, 0, 0) };
      if (context.library.movementRouting.predictVisiblePosition(state.lastEnemyOrigin, state.lastEnemyAreaNum, goal, TravelFlags.DEFAULT, target)) {
        const direction = sub3(target.value, state.eye);
        if (dot3(direction, direction) > 80 * 80) bestOrigin = add3(target.value, vec3(0, 0, -20));
      }
      aimAccuracy = 1;
    }
  }
  Object.assign(state.aimTarget, visible ? botAITrace(context, state.eye, bestOrigin, state.entityNum, MASK_SHOT).end : bestOrigin);
  let direction = sub3(bestOrigin, state.eye);
  if (weapon.number === Weapon.WP_MACHINEGUN || weapon.number === Weapon.WP_SHOTGUN || weapon.number === Weapon.WP_LIGHTNING || weapon.number === Weapon.WP_RAILGUN) {
    aimAccuracy = f(aimAccuracy * f(f(0.6) + f(f(Math.min(length3(direction), 150) / 150) * f(0.4))));
  }
  if (aimAccuracy < f(0.8)) {
    direction = normalize3(direction);
    direction = vec3(direction.x + f(f(f(0.3) * context.game.random.crandom()) * f(1 - aimAccuracy)),
      direction.y + f(f(f(0.3) * context.game.random.crandom()) * f(1 - aimAccuracy)), direction.z + f(f(f(0.3) * context.game.random.crandom()) * f(1 - aimAccuracy)));
  }
  const angles = vectorToAngles(direction);
  Object.assign(state.idealViewangles, vec3(qvmAngleMod(f(angles.x + f(f(f(6 * weapon.verticalSpread) * context.game.random.crandom()) * f(1 - aimAccuracy)))),
    qvmAngleMod(f(angles.y + f(f(f(6 * weapon.horizontalSpread) * context.game.random.crandom()) * f(1 - aimAccuracy)))), angles.z));
  if (context.cvar("bot_challenge").integerValue !== 0 && aimAccuracy > f(0.9) && state.enemySightTime < f(context.time - 1)) {
    if (state.idealViewangles.x > 180) Object.assign(state.idealViewangles, { x: f(state.idealViewangles.x - 360) });
    Object.assign(state.viewangles, state.idealViewangles);
    context.library.actions.view(state.client, state.viewangles);
  }
}

export function botCheckAttack(context: GameAiContext, state: BotState): void {
  const attackEntity = state.enemy, info = botEntityInfo(context, attackEntity);
  if (attackEntity >= 64 && state.product === "missionpack"
    && (info.number === context.deathmatch.redObelisk.entity || info.number === context.deathmatch.blueObelisk.entity)
    && context.game.pool.at(info.number).activator?.s.frame === 2) return;
  const reactionTime = characteristic(context, state, BotCharacteristic.REACTIONTIME);
  if (state.enemySightTime > f(context.time - reactionTime) || state.teleportTime > f(context.time - reactionTime)) return;
  if (state.weaponChangeTime > f(context.time - f(0.1)) || state.fireThrottleWaitTime > context.time) return;
  const throttle = characteristic(context, state, BotCharacteristic.FIRETHROTTLE);
  if (state.fireThrottleShootTime < context.time) {
    if (context.game.random.random() > throttle) { state.fireThrottleWaitTime = f(context.time + throttle); state.fireThrottleShootTime = 0; }
    else { state.fireThrottleShootTime = f(f(context.time + 1) - throttle); state.fireThrottleWaitTime = 0; }
  }
  const direction = sub3(state.aimTarget, state.eye), distance = dot3(direction, direction);
  if (state.weaponNum === Weapon.WP_GAUNTLET && distance > 60 * 60) return;
  if (!inFieldOfVision(state.viewangles, distance < 100 * 100 ? 120 : 50, vectorToAngles(direction))) return;
  const sightTrace = botAITrace(context, state.eye, state.aimTarget, state.client, SOLID | PLAYERCLIP);
  if (sightTrace.fraction < 1 && sightTrace.entityNum !== attackEntity) return;
  const weapon = weaponInfo(context, state), axes = qvmAngleVectors(state.viewangles);
  let start = add3(state.origin, vec3(0, 0, state.curPs.viewheight));
  start = vec3(start.x + f(f(axes.forward.x * weapon.offset.x) + f(axes.right.x * weapon.offset.y)),
    start.y + f(f(axes.forward.y * weapon.offset.x) + f(axes.right.y * weapon.offset.y)),
    start.z + f(f(f(axes.forward.z * weapon.offset.x) + f(axes.right.z * weapon.offset.y)) + weapon.offset.z));
  const end = add3(start, scale3(axes.forward, 1000));
  start = add3(start, scale3(axes.forward, -12));
  const trace = botAITrace(context, start, end, state.entityNum, MASK_SHOT, { min: vec3(-8, -8, -8), max: vec3(8, 8, 8) });
  if (trace.entityNum > 0 && trace.entityNum <= 64 && trace.entityNum !== attackEntity && botSameTeam(context, state, trace.entityNum)) return;
  if ((trace.entityNum !== attackEntity || attackEntity >= 64) && (weapon.projectileInfo.damageType & DAMAGE_TYPE_RADIAL) !== 0) {
    if (f(trace.fraction * 1000) < weapon.projectileInfo.radius && f(f(weapon.projectileInfo.damage - f(f(0.5 * trace.fraction) * 1000)) * 0.5) > 0) return;
  }
  if ((weapon.flags & WEAPON_FIRE_RELEASED) === 0 || (state.flags & BotFlag.ATTACKED) !== 0) context.library.actions.attack(state.client);
  state.flags ^= BotFlag.ATTACKED;
}

export function botCheckConsoleMessages(context: GameAiContext, state: BotState): void {
  const library = context.library.chat, botName = clientName(context, state.client);
  for (let message = library.nextConsoleMessage(state.cs); message !== null; message = library.nextConsoleMessage(state.cs)) {
    if (library.numConsoleMessages(state.cs) < 10 && message.type === 1 && message.time > f(context.time - f(1 + context.game.random.random()))) break;
    let offset = 0;
    if (message.type === 1) {
      const match = library.findMatch(message.message, 128);
      if (match !== null && match.variables[2].kind === "present") offset = match.variables[2].offset;
    }
    const synonymContext = botSynonymContext(context, state);
    const text = message.message.slice(0, offset) + library.replaceSynonyms(unifyWhiteSpaces(message.message.slice(offset)), synonymContext);
    if (!botMatchMessage(context, state, text) && message.type === 1 && context.cvar("bot_nochat").integerValue === 0) {
      const match = library.findMatch(text, 128);
      if (match === null || (match.subtype & 32768) !== 0) { library.removeConsoleMessage(state.cs, message.handle); continue; }
      const netName = library.matchVariable(match, 0, 36), body = unifyWhiteSpaces(library.matchVariable(match, 2));
      if (state.client === clientFromName(context, netName)) { library.removeConsoleMessage(state.cs, message.handle); continue; }
      context.cvar("bot_testrchat").update();
      if (context.cvar("bot_testrchat").integerValue !== 0) {
        context.library.variables.set("bot_testrchat", "1");
        const replied = library.replyChat(state.cs, body, synonymContext, 16, [null, null, null, null, null, null, botName, netName]);
        context.game.options.engine.print(replied ? "------------------------\n" : "**** no valid reply ****\n");
      } else if (state.aiNode !== "stand" && botValidChatPosition(context, state) && !teamPlayIsOn(context)) {
        const replyChance = characteristic(context, state, BotCharacteristic.CHAT_REPLY);
        if (context.game.random.random() < f(1.5 / ((context.numBots + 1) | 0)) && context.game.random.random() < replyChance
          && library.replyChat(state.cs, body, synonymContext, 16, [null, null, null, null, null, null, botName, netName])) {
          library.removeConsoleMessage(state.cs, message.handle);
          state.standTime = f(context.time + botChatTime(context, state));
          aiEnterStand(context, state, "BotCheckConsoleMessages: reply chat");
          break;
        }
      }
    }
    library.removeConsoleMessage(state.cs, message.handle);
  }
}

export function botCheckForGrenades(context: GameAiContext, state: BotState, entity: EntityState): void {
  if (entity.eType === EntityType.ET_MISSILE && entity.weapon === Weapon.WP_GRENADE_LAUNCHER) {
    context.library.moveStates.addAvoidSpot(state.ms, entity.pos.base, 160, BotAvoidSpotType.ALWAYS);
  }
}

export function botCheckForProxMines(context: GameAiContext, state: BotState, entity: EntityState): void {
  if (entity.eType !== EntityType.ET_MISSILE || entity.weapon !== Weapon.WP_PROX_LAUNCHER || entity.generic1 === botTeam(context, state)) return;
  if (!(botInventoryValue(state, BotInventory.PLASMAGUN) > 0 && botInventoryValue(state, BotInventory.CELLS) > 0)
    && !(botInventoryValue(state, BotInventory.ROCKETLAUNCHER) > 0 && botInventoryValue(state, BotInventory.ROCKETS) > 0)
    && !(botInventoryValue(state, BotInventory.BFG10K) > 0 && botInventoryValue(state, BotInventory.BFGAMMO) > 0)) return;
  context.library.moveStates.addAvoidSpot(state.ms, entity.pos.base, 160, BotAvoidSpotType.ALWAYS);
  if (state.numProxMines >= MAX_PROXMINES) return;
  state.proxMines[state.numProxMines++] = entity.number;
}

export function botCheckForKamikazeBody(_context: GameAiContext, state: BotState, entity: EntityState): void {
  if ((entity.eFlags & EF_KAMIKAZE) !== 0 && (entity.eFlags & 1) !== 0) state.kamikazeBody = entity.number;
}

export function botCheckEvents(context: GameAiContext, state: BotState, entity: EntityState): void {
  const lastTime = state.entityEventTime[entity.number];
  if (lastTime === undefined) throw new RangeError(`Bot event entity ${entity.number} outside its allocation`);
  const currentTime = context.game.pool.at(entity.number).eventTime;
  if (lastTime === currentTime) return;
  state.entityEventTime[entity.number] = currentTime;
  const event = (entity.eType > EntityType.ET_EVENTS ? entity.eType - EntityType.ET_EVENTS : entity.event) & ~EV_EVENT_BITS;
  switch (event) {
    case EntityEvent.EV_OBITUARY: {
      const target = entity.otherEntityNum, attacker = entity.otherEntityNum2, mod = entity.eventParm;
      if (target === state.client) {
        state.botDeathType = mod; state.lastKilledBy = attacker;
        state.botSuicide = target === attacker || target === ENTITYNUM_NONE || target === ENTITYNUM_WORLD;
        state.numDeaths = (state.numDeaths + 1) | 0;
      } else if (attacker === state.client) {
        state.enemyDeathType = mod; state.lastKilledPlayer = target; state.killedEnemyTime = context.time;
        state.numKills = (state.numKills + 1) | 0;
      } else if (attacker === state.enemy && target === attacker) state.enemySuicide = true;
      if (state.product === "missionpack" && context.deathmatch.gametype === GameType.GT_1FCTF
        && (botEntityInfo(context, target).powerups & (1 << Powerup.PW_NEUTRALFLAG)) !== 0 && !botSameTeam(context, state, target)) {
        state.neutralFlagStatus = 3; state.flagStatusChanged = true;
      }
      break;
    }
    case EntityEvent.EV_GLOBAL_SOUND: {
      if (entity.eventParm < 0 || entity.eventParm > 256) {
        context.game.options.engine.print(`EV_GLOBAL_SOUND: eventParm (${entity.eventParm}) out of range\n`); break;
      }
      const sound = context.game.options.configstrings.get(288 + entity.eventParm).slice(0, 127);
      if (state.product === "missionpack" && sound === "sound/items/kamikazerespawn.wav") botDontAvoid(context, state, "Kamikaze");
      else if (sound === "sound/items/poweruprespawn.wav") botGoForPowerups(context, state);
      break;
    }
    case EntityEvent.EV_GLOBAL_TEAM_SOUND: {
      if (context.deathmatch.gametype === GameType.GT_CTF) {
        switch (entity.eventParm) {
          case GlobalTeamSound.RED_CAPTURE: case GlobalTeamSound.BLUE_CAPTURE:
            state.blueFlagStatus = 0; state.redFlagStatus = 0; state.flagStatusChanged = true; break;
          case GlobalTeamSound.RED_RETURN: state.blueFlagStatus = 0; state.flagStatusChanged = true; break;
          case GlobalTeamSound.BLUE_RETURN: state.redFlagStatus = 0; state.flagStatusChanged = true; break;
          case GlobalTeamSound.RED_TAKEN: state.blueFlagStatus = 1; state.flagStatusChanged = true; break;
          case GlobalTeamSound.BLUE_TAKEN: state.redFlagStatus = 1; state.flagStatusChanged = true; break;
        }
      } else if (state.product === "missionpack" && context.deathmatch.gametype === GameType.GT_1FCTF) {
        switch (entity.eventParm) {
          case GlobalTeamSound.RED_CAPTURE: case GlobalTeamSound.BLUE_CAPTURE:
          case GlobalTeamSound.RED_RETURN: case GlobalTeamSound.BLUE_RETURN:
            state.neutralFlagStatus = 0; state.flagStatusChanged = true; break;
          case GlobalTeamSound.RED_TAKEN:
            state.neutralFlagStatus = botTeam(context, state) === Team.TEAM_RED ? 2 : 1; state.flagStatusChanged = true; break;
          case GlobalTeamSound.BLUE_TAKEN:
            state.neutralFlagStatus = botTeam(context, state) === Team.TEAM_BLUE ? 2 : 1; state.flagStatusChanged = true; break;
        }
      }
      break;
    }
    case EntityEvent.EV_PLAYER_TELEPORT_IN:
      Object.assign(context.deathmatch.lastTeleportOrigin, entity.origin);
      context.deathmatch.lastTeleportTime = context.time;
      break;
    case EntityEvent.EV_GENERAL_SOUND:
      if (entity.number === state.client) {
        if (entity.eventParm < 0 || entity.eventParm > 256) {
          context.game.options.engine.print(`EV_GENERAL_SOUND: eventParm (${entity.eventParm}) out of range\n`); break;
        }
        const sound = context.game.options.configstrings.get(288 + entity.eventParm).slice(0, 127);
        if (sound === "*falling1.wav" && botInventoryValue(state, BotInventory.TELEPORTER) > 0) context.library.actions.use(state.client);
      }
      break;
  }
}

export function botCheckSnapshot(context: GameAiContext, state: BotState): void {
  context.library.moveStates.addAvoidSpot(state.ms, vec3(0, 0, 0), 0, BotAvoidSpotType.CLEAR);
  state.kamikazeBody = 0; state.numProxMines = 0;
  let sequence = 0;
  while (true) {
    const snapshot = context.getSnapshotEntity(state.client, sequence);
    if (snapshot.nextSequence === -1) break;
    sequence = snapshot.nextSequence;
    botCheckEvents(context, state, snapshot.state);
    botCheckForGrenades(context, state, snapshot.state);
    if (state.product === "missionpack") {
      botCheckForProxMines(context, state, snapshot.state);
      botCheckForKamikazeBody(context, state, snapshot.state);
    }
  }
  const player = context.getEntityState(state.client) ?? new EntityState();
  player.event = state.curPs.externalEvent;
  player.eventParm = state.curPs.externalEventParm;
  botCheckEvents(context, state, player);
}

export function botCheckAir(context: GameAiContext, state: BotState): void {
  if (botInventoryValue(state, BotInventory.ENVIRONMENTSUIT) <= 0 && (context.game.world.pointContents(state.eye, -1) & LIQUID) !== 0) return;
  state.lastAirTime = context.time;
}

export function botDeathmatchAI(context: GameAiContext, state: BotState, _thinkTime: number): void {
  if (state.setupCount > 0) {
    state.setupCount--;
    if (state.setupCount > 0) return;
    const gender = context.library.characters.string(state.character, BotCharacteristic.GENDER).slice(0, 143), engine = context.game.options.engine;
    const userinfo = infoSetValueForKey(engine.getUserinfo(state.client).slice(0, 1023), "sex", gender, text => engine.print(text));
    engine.setUserinfo(state.client, userinfo);
    if (!state.mapRestart && context.game.gameType !== GameType.GT_TOURNAMENT) context.library.actions.command(state.client, `team ${state.settings.team}`.slice(0, 143));
    context.library.chat.setGender(state.cs, gender.startsWith("m") ? ChatGender.Male : gender.startsWith("f") ? ChatGender.Female : ChatGender.Genderless);
    context.library.chat.setName(state.cs, clientName(context, state.client, 144), state.client);
    state.lastFrameHealth = botInventoryValue(state, BotInventory.HEALTH);
    state.lastHitCount = state.curPs.persistant.get(PersistentIndex.PERS_HITS);
    state.setupCount = 0;
    botSetupAlternativeRouteGoals(context);
  }
  state.flags &= ~BotFlag.IDEALVIEWSET;
  if (!botIntermission(context, state)) {
    botSetTeleportTime(context, state);
    botUpdateInventory(context, state);
    botCheckSnapshot(context, state);
    botCheckAir(context, state);
  }
  botCheckConsoleMessages(context, state);
  if (!botIntermission(context, state) && !botIsObserver(context, state)) botTeamAI(context, state);
  if (state.aiNode === null) aiEnterSeekLtg(context, state, "BotDeathmatchAI: no ai node");
  if (!state.enterGameChat && state.enterGameTime > f(context.time - 8)) {
    if (botChatEnterGame(context, state)) {
      state.standTime = f(context.time + botChatTime(context, state));
      aiEnterStand(context, state, "BotDeathmatchAI: chat enter game");
    }
    state.enterGameChat = true;
  }
  botResetNodeSwitches(context);
  let switches = 0;
  for (; switches < MAX_NODESWITCHES; switches++) if (runAiNode(context, state)) break;
  if (!state.inuse) return;
  if (switches >= MAX_NODESWITCHES) {
    context.library.goals.dumpGoalStack(state.gs);
    context.library.goals.dumpAvoidGoals(state.gs);
    botDumpNodeSwitches(context, state);
    context.game.options.engine.print(gameFormat("^1Error: %s at %1.1f switched more than %d AI nodes\n",
      [clientName(context, state.client, 144), context.time, MAX_NODESWITCHES]));
  }
  state.lastFrameHealth = botInventoryValue(state, BotInventory.HEALTH);
  state.lastHitCount = state.curPs.persistant.get(PersistentIndex.PERS_HITS);
}
