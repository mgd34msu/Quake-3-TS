/*
 * Deathmatch decision network translated from id Software's game/ai_dmnet.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { BotActionFlag } from "../botlib/actions.ts";
import { GoalFlags, touchingGoal } from "../botlib/goals.ts";
import type { BotGoal } from "../botlib/goals.ts";
import { BotMoveResult, BotMoveResultFlag, BotMoveType } from "../botlib/movement-state.ts";
import { TravelFlags } from "../botlib/routing.ts";
import { dot3, length3, normalize3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmAngleVectors } from "../core/qvm-math.ts";
import { GameType, PersistentIndex, Team, Weapon } from "../shared/definitions.ts";
import { EntityState } from "../shared/entity-state.ts";
import { BotCharacteristic, BotFlag, BotInventory, BotLongTermGoal, BotPatrolFlag, MAX_NODESWITCHES } from "./ai-definitions.ts";
import type { GameAiContext } from "./ai-context.ts";
import { BotGoalState } from "./ai-state.ts";
import type { BotState } from "./ai-state.ts";
import { MAX_CLIENTS } from "./state.ts";
import { gameFormat } from "./format.ts";
import { botAITrace, botAimAtEnemy, botBattleUseItems, botCanAndWantsToRocketJump, botCheckAttack,
  botChooseWeapon, botEntityInfo, botEntityVisible, botFeelingBad, botFindEnemy,
  botHasPersistantPowerupAndWeapon, botInLavaOrSlime, botIntermission, botIsDead, botIsObserver,
  botUpdateBattleInventory, botWantsToChase, botWantsToRetreat, entityIsDead, entityIsInvisible,
  entityIsShooting, inFieldOfVision, vectorToAngles, botWantsToCamp } from "./ai-combat.ts";
import { botAIPredictObstacles, botAIBlocked, botAlternateRoute, botAttackMove,
  botClearActivateGoalStack, botMapScripts, botPointAreaNum, botPopFromActivateGoalStack,
  botRoamGoal, botSetupForMovement } from "./ai-navigation.ts";
import { bot1FCTFCarryingFlag, botCTFCarryingFlag, botGoHarvest, botHarvesterCarryingCubes,
  botTeam, botTeamGoals, clientName, easyClientName } from "./ai-orders.ts";
import { botInitialChat, botChatDeath, botChatEndLevel, botChatEnemySuicide, botChatHitNoDeath,
  botChatHitNoKill, botChatHitTalking, botChatKill, botChatRandom, botChatStartLevel, botChatTime } from "./ai-chat.ts";
import { botVoiceChatOnly } from "./ai-team.ts";

const f = Math.fround;
const AIR_GOAL = 128;
const SOLID = 1, PLAYERCLIP = 0x10000, LIQUID = 8 | 16 | 32;
const MASK_SHOT = SOLID | 0x2000000 | 0x4000000;
const CHAT_TEAM = 1, CHAT_TELL = 2;
const MOVEMENT_VIEW = BotMoveResultFlag.MOVEMENTVIEWSET | BotMoveResultFlag.MOVEMENTVIEW | BotMoveResultFlag.SWIMVIEW;

function inventory(state: BotState, index: BotInventory): number {
  const value = state.inventory[index];
  if (value === undefined) throw new RangeError(`Missing bot inventory cell ${index}`);
  return value;
}

function areaReachability(context: GameAiContext, area: number): number {
  const settings = context.library.movementRouting.spatial.world.areaSettings[area];
  if (settings === undefined) throw new RangeError(`Missing bot area ${area}`);
  return settings.reachableAreaCount;
}

function travelTime(context: GameAiContext, state: BotState, goal: BotGoal, flags: number): number {
  return context.library.movementRouting.routing.areaTravelTimeToGoal({ area: state.areaNum,
    origin: state.origin, goalArea: goal.area, travelFlags: flags });
}

function swimming(context: GameAiContext, state: BotState): boolean {
  return context.library.movementRouting.spatial.movement.swimming(state.origin);
}

function halfRoll(state: BotState): void {
  state.idealViewangles = vec3(state.idealViewangles.x, state.idealViewangles.y, state.idealViewangles.z * 0.5);
}

function lookAt(state: BotState, target: Vec3): void {
  state.idealViewangles = vectorToAngles(sub3(target, state.origin));
}

function movementViewTarget(context: GameAiContext, state: BotState, goal: BotGoal): Vec3 | null {
  const target = { value: vec3(0, 0, 0) };
  return context.library.movementRouting.movementViewTarget(state.ms, goal, state.tfl, 300, target) ? target.value : null;
}

function setTravelFlags(context: GameAiContext, state: BotState, rocketJump: boolean): void {
  state.tfl = TravelFlags.DEFAULT;
  if (context.cvar("bot_grapple").integerValue !== 0) state.tfl |= TravelFlags.GRAPPLEHOOK;
  if (botInLavaOrSlime(context, state)) state.tfl |= TravelFlags.LAVA | TravelFlags.SLIME;
  if (rocketJump && botCanAndWantsToRocketJump(context, state)) state.tfl |= TravelFlags.ROCKETJUMP;
}

/** BotResetNodeSwitches uses per-game scratch, shared by the current source AI call. */
export function botResetNodeSwitches(context: GameAiContext): void { context.nodeSwitches.length = 0; }

export function botRecordNodeSwitch(context: GameAiContext, state: BotState, node: string, detail: string, reason: string): void {
  context.nodeSwitches.push(gameFormat("%s at %2.1f entered %s: %s from %s\n",
    [clientName(context, state.client), context.time, node, detail, reason], 144));
}

export function botDumpNodeSwitches(context: GameAiContext, state: BotState): void {
  context.game.options.engine.print(gameFormat("%s at %1.1f switched more than %d AI nodes\n",
    [clientName(context, state.client), context.time, MAX_NODESWITCHES]));
  for (const line of context.nodeSwitches) context.game.options.engine.print(line);
  context.game.options.engine.print("^1Fatal: ");
}

export function botGetAirGoal(context: GameAiContext, state: BotState, goal: BotGoalState): boolean {
  const bounds = { min: vec3(-15, -15, -2), max: vec3(15, 15, 2) };
  const above = vec3(state.origin.x, state.origin.y, state.origin.z + 1000);
  const ceiling = botAITrace(context, state.origin, above, state.entityNum, SOLID | PLAYERCLIP, bounds);
  const surface = botAITrace(context, ceiling.end, state.origin, state.entityNum, LIQUID, bounds);
  if (surface.fraction > 0) {
    const area = botPointAreaNum(context, surface.end);
    if (area !== 0) {
      goal.origin = vec3(surface.end.x, surface.end.y, surface.end.z - 2);
      goal.area = area;
      goal.mins = vec3(-15, -15, -1); goal.maxs = vec3(15, 15, 1);
      goal.flags = AIR_GOAL; goal.number = 0; goal.itemInfo = 0; goal.entity = 0;
      return true;
    }
  }
  return false;
}

export function botGoForAir(context: GameAiContext, state: BotState, flags: number, longTermGoal: BotGoal | null, range: number): boolean {
  if (state.lastAirTime < f(context.time - 6)) {
    const goal = new BotGoalState();
    if (botGetAirGoal(context, state, goal)) {
      context.library.goals.pushGoal(state.gs, goal);
      return true;
    }
    while (context.library.goals.chooseNBGItem(state.gs, state.origin, state.inventory, flags, longTermGoal, range)) {
      const nearby = context.library.goals.getTopGoal(state.gs);
      if (nearby === null) throw new Error("Selected nearby item has no goal stack entry");
      if ((context.library.movementRouting.spatial.host.pointContents(nearby.origin) & LIQUID) === 0) return true;
      context.library.goals.popGoal(state.gs);
    }
    context.library.goals.resetAvoidGoals(state.gs);
  }
  return false;
}

export function botNearbyGoal(context: GameAiContext, state: BotState, flags: number, longTermGoal: BotGoal | null, range: number): boolean {
  if (botGoForAir(context, state, flags, longTermGoal, range)) return true;
  if (botCTFCarryingFlag(context, state) && travelTime(context, state, state.teamGoal, TravelFlags.DEFAULT) < 300) range = 50;
  return context.library.goals.chooseNBGItem(state.gs, state.origin, state.inventory, flags, longTermGoal, range);
}

export function botReachedGoal(context: GameAiContext, state: BotState, goal: BotGoal): boolean {
  if ((goal.flags & GoalFlags.Item) !== 0) {
    if (touchingGoal(state.origin, goal)) {
      if ((goal.flags & GoalFlags.Dropped) === 0) context.library.goals.setAvoidGoalTime(state.gs, goal.number, -1);
      return true;
    }
    if (context.library.goals.itemGoalInVisButNotVisible(state.entityNum, state.eye, state.viewangles, goal)) return true;
    if (state.areaNum === goal.area && state.origin.x > f(goal.origin.x + goal.mins.x)
      && state.origin.x < f(goal.origin.x + goal.maxs.x) && state.origin.y > f(goal.origin.y + goal.mins.y)
      && state.origin.y < f(goal.origin.y + goal.maxs.y) && !swimming(context, state)) return true;
  } else if ((goal.flags & AIR_GOAL) !== 0) {
    if (touchingGoal(state.origin, goal) || state.lastAirTime > f(context.time - 1)) return true;
  } else if (touchingGoal(state.origin, goal)) return true;
  return false;
}

export function botGetItemLongTermGoal(context: GameAiContext, state: BotState, flags: number, goal: BotGoalState): boolean {
  const top = context.library.goals.getTopGoal(state.gs);
  if (top === null) state.ltgTime = 0;
  else {
    goal.copyFrom(top);
    if (botReachedGoal(context, state, goal)) { botChooseWeapon(context, state); state.ltgTime = 0; }
  }
  if (state.ltgTime < context.time) {
    context.library.goals.popGoal(state.gs);
    if (context.library.goals.chooseLTGItem(state.gs, state.origin, state.inventory, flags)) state.ltgTime = f(context.time + 20);
    else { context.library.goals.resetAvoidGoals(state.gs); context.library.moveStates.resetAvoidReach(state.ms); }
    const next = context.library.goals.getTopGoal(state.gs);
    if (next === null) return false;
    goal.copyFrom(next);
  }
  return true;
}

export function botSelectActivateWeapon(context: GameAiContext, state: BotState): number {
  if (inventory(state, BotInventory.MACHINEGUN) > 0 && inventory(state, BotInventory.BULLETS) > 0) return Weapon.WP_MACHINEGUN;
  if (inventory(state, BotInventory.SHOTGUN) > 0 && inventory(state, BotInventory.SHELLS) > 0) return Weapon.WP_SHOTGUN;
  if (inventory(state, BotInventory.PLASMAGUN) > 0 && inventory(state, BotInventory.CELLS) > 0) return Weapon.WP_PLASMAGUN;
  if (inventory(state, BotInventory.LIGHTNING) > 0 && inventory(state, BotInventory.LIGHTNINGAMMO) > 0) return Weapon.WP_LIGHTNING;
  if (context.game.options.product === "missionpack") {
    if (inventory(state, BotInventory.CHAINGUN) > 0 && inventory(state, BotInventory.BELT) > 0) return Weapon.WP_CHAINGUN;
    if (inventory(state, BotInventory.NAILGUN) > 0 && inventory(state, BotInventory.NAILS) > 0) return Weapon.WP_NAILGUN;
  }
  if (inventory(state, BotInventory.RAILGUN) > 0 && inventory(state, BotInventory.SLUGS) > 0) return Weapon.WP_RAILGUN;
  if (inventory(state, BotInventory.ROCKETLAUNCHER) > 0 && inventory(state, BotInventory.ROCKETS) > 0) return Weapon.WP_ROCKET_LAUNCHER;
  if (inventory(state, BotInventory.BFG10K) > 0 && inventory(state, BotInventory.BFGAMMO) > 0) return Weapon.WP_BFG;
  return -1;
}

export function aiEnterIntermission(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "intermission", "", reason);
  context.resetState(state);
  if (botChatEndLevel(context, state)) context.library.chat.enterChat(state.cs, 0, state.chatTo);
  state.aiNode = "intermission";
}

export function aiNodeIntermission(context: GameAiContext, state: BotState): boolean {
  if (!botIntermission(context, state)) {
    if (botChatStartLevel(context, state)) state.standTime = f(context.time + botChatTime(context, state));
    else state.standTime = f(context.time + 2);
    aiEnterStand(context, state, "intermission: chat");
  }
  return true;
}

export function aiEnterObserver(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "observer", "", reason);
  context.resetState(state);
  state.aiNode = "observer";
}

export function aiNodeObserver(context: GameAiContext, state: BotState): boolean {
  if (!botIsObserver(context, state)) aiEnterStand(context, state, "observer: left observer");
  return true;
}

export function aiEnterStand(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "stand", "", reason);
  state.standFindEnemyTime = f(context.time + 1);
  state.aiNode = "stand";
}

export function aiNodeStand(context: GameAiContext, state: BotState): boolean {
  if (state.lastFrameHealth > inventory(state, BotInventory.HEALTH) && botChatHitTalking(context, state)) {
    state.standFindEnemyTime = f(f(context.time + botChatTime(context, state)) + f(0.1));
    state.standTime = f(f(context.time + botChatTime(context, state)) + f(0.1));
  }
  if (state.standFindEnemyTime < context.time) {
    if (botFindEnemy(context, state, -1)) { aiEnterBattleFight(context, state, "stand: found enemy"); return false; }
    state.standFindEnemyTime = f(context.time + 1);
  }
  context.library.actions.talk(state.client);
  if (state.standTime < context.time) {
    context.library.chat.enterChat(state.cs, 0, state.chatTo);
    aiEnterSeekLtg(context, state, "stand: time out");
    return false;
  }
  return true;
}

export function aiEnterRespawn(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "respawn", "", reason);
  context.library.moveStates.reset(state.ms);
  context.library.goals.resetGoalState(state.gs);
  context.library.goals.resetAvoidGoals(state.gs);
  context.library.moveStates.resetAvoidReach(state.ms);
  if (botChatDeath(context, state)) {
    state.respawnTime = f(context.time + botChatTime(context, state));
    state.respawnChatTime = context.time;
  } else { state.respawnTime = f(f(context.time + 1) + context.random()); state.respawnChatTime = 0; }
  state.respawnWait = false;
  state.aiNode = "respawn";
}

export function aiNodeRespawn(context: GameAiContext, state: BotState): boolean {
  if (state.respawnWait) {
    if (!botIsDead(context, state)) aiEnterSeekLtg(context, state, "respawn: respawned");
    else context.library.actions.respawn(state.client);
  } else if (state.respawnTime < context.time) {
    state.respawnWait = true;
    context.library.actions.respawn(state.client);
    if (state.respawnChatTime !== 0) {
      context.library.chat.enterChat(state.cs, 0, state.chatTo);
      state.enemy = -1;
    }
  }
  if (state.respawnChatTime !== 0 && state.respawnChatTime < f(context.time - 0.5)) context.library.actions.talk(state.client);
  return true;
}

export function aiEnterSeekActivateEntity(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "activate entity", "", reason);
  state.aiNode = "seek-activate-entity";
}

export function aiEnterSeekNbg(context: GameAiContext, state: BotState, reason: string): void {
  const goal = context.library.goals.getTopGoal(state.gs);
  botRecordNodeSwitch(context, state, "seek NBG", goal === null ? "no goal" : context.library.goals.goalName(goal.number).slice(0, 143), reason);
  state.aiNode = "seek-nbg";
}

export function aiEnterSeekLtg(context: GameAiContext, state: BotState, reason: string): void {
  const goal = context.library.goals.getTopGoal(state.gs);
  botRecordNodeSwitch(context, state, "seek LTG", goal === null ? "no goal" : context.library.goals.goalName(goal.number).slice(0, 143), reason);
  state.aiNode = "seek-ltg";
}

export function aiEnterBattleFight(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "battle fight", "", reason);
  context.library.moveStates.resetLastAvoidReach(state.ms);
  state.aiNode = "battle-fight";
}

export function aiEnterBattleSuicidalFight(context: GameAiContext, state: BotState, reason: string): void {
  aiEnterBattleFight(context, state, reason);
  state.flags |= BotFlag.FIGHTSUICIDAL;
}

export function aiEnterBattleChase(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "battle chase", "", reason);
  state.chaseTime = context.time;
  state.aiNode = "battle-chase";
}

export function aiEnterBattleRetreat(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "battle retreat", "", reason);
  state.aiNode = "battle-retreat";
}

export function aiEnterBattleNbg(context: GameAiContext, state: BotState, reason: string): void {
  botRecordNodeSwitch(context, state, "battle NBG", "", reason);
  state.aiNode = "battle-nbg";
}

function checkLifecycle(context: GameAiContext, state: BotState, node: string, clearActivation = false): boolean {
  if (botIsObserver(context, state)) {
    if (clearActivation) botClearActivateGoalStack(context, state);
    aiEnterObserver(context, state, `${node === "activate entity" ? "active entity" : node}: observer`); return true;
  }
  if (botIntermission(context, state)) {
    if (clearActivation) botClearActivateGoalStack(context, state);
    aiEnterIntermission(context, state, `${node}: ${node === "seek nbg" ? "intermision" : "intermission"}`); return true;
  }
  if (botIsDead(context, state)) {
    if (clearActivation) botClearActivateGoalStack(context, state);
    aiEnterRespawn(context, state, `${node}: bot dead`); return true;
  }
  return false;
}

function teamChat(context: GameAiContext, state: BotState, type: string, voice: string): void {
  botInitialChat(context, state, type);
  context.library.chat.enterChat(state.cs, 0, CHAT_TEAM);
  botVoiceChatOnly(context, state, -1, voice);
  state.teamMessageTime = 0;
}

function acknowledge(context: GameAiContext, state: BotState, type: string, variable: string): void {
  botInitialChat(context, state, type, variable);
  context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL);
  botVoiceChatOnly(context, state, state.decisionmaker, "yes");
  context.library.actions.action(state.client, BotActionFlag.AFFIRMATIVE);
  state.teamMessageTime = 0;
}

function updateCompanionGoal(context: GameAiContext, goal: BotGoalState, companion: number, origin: Vec3): void {
  const area = botPointAreaNum(context, origin);
  if (area !== 0 && areaReachability(context, area) !== 0) {
    goal.entity = companion; goal.area = area; goal.origin = vec3(origin.x, origin.y, origin.z);
    goal.mins = vec3(-8, -8, -8); goal.maxs = vec3(8, 8, 8);
  }
}

function selectTeamBase(context: GameAiContext, state: BotState, goal: BotGoalState, enemy: boolean, obelisk: boolean): boolean {
  const team = botTeam(context, state);
  if (team !== Team.TEAM_RED && team !== Team.TEAM_BLUE) return false;
  const red = (team === Team.TEAM_RED) !== enemy;
  goal.copyFrom(obelisk ? (red ? context.deathmatch.redObelisk : context.deathmatch.blueObelisk)
    : (red ? context.deathmatch.ctfRedFlag : context.deathmatch.ctfBlueFlag));
  return true;
}

function wantsCrouch(context: GameAiContext, state: BotState): void {
  if (state.attackCrouchTime < f(context.time - 5)) {
    const croucher = context.library.characters.boundedFloat(state.character, BotCharacteristic.CROUCHER, 0, 1);
    if (context.random() < f(state.thinkTime * croucher)) state.attackCrouchTime = f(f(context.time + 5) + f(croucher * 15));
  }
}

export function botGetLongTermGoal(context: GameAiContext, state: BotState, flags: number, retreat: boolean, goal: BotGoalState): boolean {
  if (state.ltgType === BotLongTermGoal.TEAMHELP && !retreat) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) acknowledge(context, state, "help_start", easyClientName(context, state.teammate));
    if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
    if (state.teammateVisibleTime < f(context.time - 10)) state.ltgType = BotLongTermGoal.NONE;
    const info = botEntityInfo(context, state.teammate);
    if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.teammate) !== 0) {
      const direction = sub3(info.origin, state.origin);
      if (dot3(direction, direction) < 100 * 100) { context.library.moveStates.resetAvoidReach(state.ms); return false; }
    } else state.teammateVisibleTime = context.time;
    if (info.valid) updateCompanionGoal(context, state.teamGoal, state.teammate, info.origin);
    goal.copyFrom(state.teamGoal);
    return true;
  }
  if (state.ltgType === BotLongTermGoal.TEAMACCOMPANY && !retreat) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) acknowledge(context, state, "accompany_start", easyClientName(context, state.teammate));
    if (state.teamGoalTime < context.time) {
      botInitialChat(context, state, "accompany_stop", easyClientName(context, state.teammate));
      context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL);
      state.ltgType = BotLongTermGoal.NONE;
    }
    const info = botEntityInfo(context, state.teammate);
    if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.teammate) !== 0) {
      state.teammateVisibleTime = context.time;
      const direction = sub3(info.origin, state.origin);
      if (dot3(direction, direction) < f(state.formationDist * state.formationDist)) {
        const self = botEntityInfo(context, state.entityNum);
        if (f(self.origin.z + self.maxs.z) > f(info.origin.z + info.mins.z)
          && f(self.origin.x + self.maxs.x) > f(f(info.origin.x + info.mins.x) - 4)
          && f(self.origin.x + self.mins.x) < f(f(info.origin.x + info.maxs.x) + 4)
          && f(self.origin.y + self.maxs.y) > f(f(info.origin.y + info.mins.y) - 4)
          && f(self.origin.y + self.mins.y) < f(f(info.origin.y + info.maxs.y) + 4)
          && f(self.origin.z + self.maxs.z) > f(f(info.origin.z + info.mins.z) - 4)
          && f(self.origin.z + self.mins.z) < f(f(info.origin.z + info.maxs.z) + 4)) {
          const forward = qvmAngleVectors(info.angles).forward;
          const horizontal = normalize3(vec3(forward.x, forward.y, 0));
          const away = normalize3(sub3(state.origin, info.origin));
          if (dot3(horizontal, away) > f(0.7)) {
            botSetupForMovement(context, state);
            context.library.movement.moveInDirection(state.ms, away, 400, BotMoveType.WALK);
          }
        }
        wantsCrouch(context, state);
        if (swimming(context, state)) state.attackCrouchTime = f(context.time - 1);
        if (state.arriveTime < f(context.time - 2)) {
          if (state.arriveTime === 0) {
            context.library.actions.gesture(state.client);
            botInitialChat(context, state, "accompany_arrive", easyClientName(context, state.teammate));
            context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL);
            state.arriveTime = context.time;
          } else if (state.attackCrouchTime > context.time) context.library.actions.crouch(state.client);
          else if (context.random() < f(state.thinkTime * f(0.05))) context.library.actions.gesture(state.client);
        }
        if (state.arriveTime > f(context.time - 2)) { lookAt(state, info.origin); halfRoll(state); }
        else if (context.random() < f(state.thinkTime * f(0.8))) { lookAt(state, botRoamGoal(context, state)); halfRoll(state); }
        if (botGoForAir(context, state, state.tfl, state.teamGoal, 400)) {
          context.library.moveStates.resetLastAvoidReach(state.ms);
          state.nbgTime = f(context.time + 8);
          aiEnterSeekNbg(context, state, "BotLongTermGoal: go for air");
          return false;
        }
        context.library.moveStates.resetAvoidReach(state.ms);
        return false;
      }
    }
    if (info.valid) updateCompanionGoal(context, state.teamGoal, state.teammate, info.origin);
    goal.copyFrom(state.teamGoal);
    if (state.teammateVisibleTime < f(context.time - 60)) {
      botInitialChat(context, state, "accompany_cannotfind", easyClientName(context, state.teammate));
      context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL);
      state.ltgType = BotLongTermGoal.NONE;
      state.teammateVisibleTime = context.time;
    }
    return true;
  }
  if (state.ltgType === BotLongTermGoal.DEFENDKEYAREA && travelTime(context, state, state.teamGoal, TravelFlags.DEFAULT) > state.defendAwayRange) state.defendAwayTime = 0;
  if (state.ltgType === BotLongTermGoal.DEFENDKEYAREA && !retreat && state.defendAwayTime < context.time) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) {
      botInitialChat(context, state, "defend_start", context.library.goals.goalName(state.teamGoal.number));
      context.library.chat.enterChat(state.cs, 0, CHAT_TEAM);
      botVoiceChatOnly(context, state, -1, "ondefense"); state.teamMessageTime = 0;
    }
    goal.copyFrom(state.teamGoal);
    if (state.teamGoalTime < context.time) {
      botInitialChat(context, state, "defend_stop", context.library.goals.goalName(state.teamGoal.number));
      context.library.chat.enterChat(state.cs, 0, CHAT_TEAM); state.ltgType = BotLongTermGoal.NONE;
    }
    const direction = sub3(goal.origin, state.origin);
    if (dot3(direction, direction) < 70 * 70) {
      context.library.moveStates.resetAvoidReach(state.ms);
      state.defendAwayTime = f(f(context.time + 3) + f(3 * context.random()));
      state.defendAwayRange = botHasPersistantPowerupAndWeapon(context, state) ? 100 : 350;
    }
    return true;
  }
  if (state.ltgType === BotLongTermGoal.KILL && !retreat) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) {
      botInitialChat(context, state, "kill_start", easyClientName(context, state.teamGoal.entity));
      context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL); state.teamMessageTime = 0;
    }
    if (state.lastKilledPlayer === state.teamGoal.entity) {
      botInitialChat(context, state, "kill_done", easyClientName(context, state.teamGoal.entity));
      context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL);
      state.lastKilledPlayer = -1; state.ltgType = BotLongTermGoal.NONE;
    }
    if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
    return botGetItemLongTermGoal(context, state, flags, goal);
  }
  if (state.ltgType === BotLongTermGoal.GETITEM && !retreat) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) acknowledge(context, state, "getitem_start", context.library.goals.goalName(state.teamGoal.number));
    goal.copyFrom(state.teamGoal);
    if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
    if (context.library.goals.itemGoalInVisButNotVisible(state.entityNum, state.eye, state.viewangles, goal)) {
      botInitialChat(context, state, "getitem_notthere", context.library.goals.goalName(state.teamGoal.number));
      context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL); state.ltgType = BotLongTermGoal.NONE;
    } else if (botReachedGoal(context, state, goal)) {
      botInitialChat(context, state, "getitem_gotit", context.library.goals.goalName(state.teamGoal.number));
      context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL); state.ltgType = BotLongTermGoal.NONE;
    }
    return true;
  }
  if ((state.ltgType === BotLongTermGoal.CAMP || state.ltgType === BotLongTermGoal.CAMPORDER) && !retreat) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) {
      if (state.ltgType === BotLongTermGoal.CAMPORDER) acknowledge(context, state, "camp_start", easyClientName(context, state.teammate));
      state.teamMessageTime = 0;
    }
    goal.copyFrom(state.teamGoal);
    if (state.teamGoalTime < context.time) {
      if (state.ltgType === BotLongTermGoal.CAMPORDER) {
        botInitialChat(context, state, "camp_stop"); context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL);
      }
      state.ltgType = BotLongTermGoal.NONE;
    }
    const direction = sub3(goal.origin, state.origin);
    if (dot3(direction, direction) < 60 * 60) {
      if (state.arriveTime === 0) {
        if (state.ltgType === BotLongTermGoal.CAMPORDER) {
          botInitialChat(context, state, "camp_arrive", easyClientName(context, state.teammate));
          context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL);
          botVoiceChatOnly(context, state, state.decisionmaker, "inposition");
        }
        state.arriveTime = context.time;
      }
      if (context.random() < f(state.thinkTime * f(0.8))) { lookAt(state, botRoamGoal(context, state)); halfRoll(state); }
      wantsCrouch(context, state);
      if (state.attackCrouchTime > context.time) context.library.actions.crouch(state.client);
      if (swimming(context, state)) state.attackCrouchTime = f(context.time - 1);
      if ((context.game.world.pointContents(state.eye, state.entityNum) & LIQUID) !== 0) {
        if (state.ltgType === BotLongTermGoal.CAMPORDER) {
          botInitialChat(context, state, "camp_stop"); context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL);
          if (state.lastGoalLtgType === BotLongTermGoal.CAMPORDER) state.lastGoalLtgType = BotLongTermGoal.NONE;
        }
        state.ltgType = BotLongTermGoal.NONE;
      }
      context.library.moveStates.resetAvoidReach(state.ms);
      return false;
    }
    return true;
  }
  if (state.ltgType === BotLongTermGoal.PATROL && !retreat) {
    if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) {
      let route = "";
      for (let point = state.patrolPoints; point !== null; point = point.next) route += point.name + (point.next === null ? "" : " to ");
      acknowledge(context, state, "patrol_start", route);
    }
    const current = state.currentPatrolPoint;
    if (current === null) { state.ltgType = BotLongTermGoal.NONE; return false; }
    if (touchingGoal(state.origin, current.goal)) {
      if ((state.patrolFlags & BotPatrolFlag.BACK) !== 0) {
        if (current.prev !== null) state.currentPatrolPoint = current.prev;
        else { state.currentPatrolPoint = current.next; state.patrolFlags &= ~BotPatrolFlag.BACK; }
      } else if (current.next !== null) state.currentPatrolPoint = current.next;
      else { state.currentPatrolPoint = current.prev; state.patrolFlags |= BotPatrolFlag.BACK; }
    }
    if (state.teamGoalTime < context.time) {
      botInitialChat(context, state, "patrol_stop"); context.library.chat.enterChat(state.cs, state.decisionmaker, CHAT_TELL);
      state.ltgType = BotLongTermGoal.NONE;
    }
    if (state.currentPatrolPoint === null) { state.ltgType = BotLongTermGoal.NONE; return false; }
    goal.copyFrom(state.currentPatrolPoint.goal);
    return true;
  }
  if (context.gameType === GameType.GT_CTF) {
    if (state.ltgType === BotLongTermGoal.GETFLAG) {
      if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "captureflag_start", "ongetflag");
      if (!selectTeamBase(context, state, goal, true, false)) { state.ltgType = BotLongTermGoal.NONE; return false; }
      if (touchingGoal(state.origin, goal)) {
        switch (botTeam(context, state)) { case Team.TEAM_RED: state.blueFlagStatus = 1; break; case Team.TEAM_BLUE: state.redFlagStatus = 1; break; }
        state.ltgType = BotLongTermGoal.NONE;
      }
      if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
      botAlternateRoute(context, state, goal);
      return true;
    }
    if (state.ltgType === BotLongTermGoal.RUSHBASE && state.rushBaseAwayTime < context.time) {
      if (!selectTeamBase(context, state, goal, false, false)) { state.ltgType = BotLongTermGoal.NONE; return false; }
      if (!botCTFCarryingFlag(context, state)) state.ltgType = BotLongTermGoal.NONE;
      if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
      if (touchingGoal(state.origin, goal)) {
        if (botCTFCarryingFlag(context, state)) {
          context.library.moveStates.resetAvoidReach(state.ms);
          state.rushBaseAwayTime = f(f(context.time + 5) + f(10 * context.random()));
        } else state.ltgType = BotLongTermGoal.NONE;
      }
      botAlternateRoute(context, state, goal);
      return true;
    }
    if (state.ltgType === BotLongTermGoal.RETURNFLAG) {
      if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "returnflag_start", "onreturnflag");
      if (!selectTeamBase(context, state, goal, true, false)) { state.ltgType = BotLongTermGoal.NONE; return false; }
      if (touchingGoal(state.origin, goal)) state.ltgType = BotLongTermGoal.NONE;
      if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
      botAlternateRoute(context, state, goal);
      return true;
    }
  } else if (context.game.options.product === "missionpack") {
    if (context.gameType === GameType.GT_1FCTF) {
      if (state.ltgType === BotLongTermGoal.GETFLAG) {
        if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "captureflag_start", "ongetflag");
        goal.copyFrom(context.deathmatch.ctfNeutralFlag);
        if (touchingGoal(state.origin, goal)) state.ltgType = BotLongTermGoal.NONE;
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        return true;
      }
      if (state.ltgType === BotLongTermGoal.RUSHBASE) {
        if (!selectTeamBase(context, state, goal, true, false)) { state.ltgType = BotLongTermGoal.NONE; return false; }
        if (!bot1FCTFCarryingFlag(context, state)) state.ltgType = BotLongTermGoal.NONE;
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        if (touchingGoal(state.origin, goal)) state.ltgType = BotLongTermGoal.NONE;
        botAlternateRoute(context, state, goal);
        return true;
      }
      if (state.ltgType === BotLongTermGoal.ATTACKENEMYBASE && state.attackAwayTime < context.time) {
        if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "attackenemybase_start", "onoffense");
        if (!selectTeamBase(context, state, goal, true, false)) { state.ltgType = BotLongTermGoal.NONE; return false; }
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        if (touchingGoal(state.origin, goal)) state.attackAwayTime = f(f(context.time + 2) + f(5 * context.random()));
        return true;
      }
      if (state.ltgType === BotLongTermGoal.RETURNFLAG) {
        if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "returnflag_start", "onreturnflag");
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        return botGetItemLongTermGoal(context, state, flags, goal);
      }
    } else if (context.gameType === GameType.GT_OBELISK) {
      if (state.ltgType === BotLongTermGoal.ATTACKENEMYBASE && state.attackAwayTime < context.time) {
        if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "attackenemybase_start", "onoffense");
        if (!selectTeamBase(context, state, goal, true, true)) { state.ltgType = BotLongTermGoal.NONE; return false; }
        if (botFeelingBad(context, state) > 50) return botGetItemLongTermGoal(context, state, flags, goal);
        if (touchingGoal(state.origin, goal)) state.attackAwayTime = f(f(context.time + 3) + f(5 * context.random()));
        const direction = sub3(state.origin, goal.origin);
        if (dot3(direction, direction) < 60 * 60) state.attackAwayTime = f(f(context.time + 3) + f(5 * context.random()));
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        botAlternateRoute(context, state, goal);
        return true;
      }
    } else if (context.gameType === GameType.GT_HARVESTER) {
      if (state.ltgType === BotLongTermGoal.RUSHBASE) {
        if (!selectTeamBase(context, state, goal, true, true)) { botGoHarvest(context, state); return false; }
        if (!botHarvesterCarryingCubes(context, state)) { botGoHarvest(context, state); return false; }
        if (state.teamGoalTime < context.time) { botGoHarvest(context, state); return false; }
        if (touchingGoal(state.origin, goal)) { botGoHarvest(context, state); return false; }
        botAlternateRoute(context, state, goal);
        return true;
      }
      if (state.ltgType === BotLongTermGoal.ATTACKENEMYBASE && state.attackAwayTime < context.time) {
        if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "attackenemybase_start", "onoffense");
        if (!selectTeamBase(context, state, goal, true, true)) { state.ltgType = BotLongTermGoal.NONE; return false; }
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        if (touchingGoal(state.origin, goal)) state.attackAwayTime = f(f(context.time + 2) + f(5 * context.random()));
        return true;
      }
      if (state.ltgType === BotLongTermGoal.HARVEST && state.harvestAwayTime < context.time) {
        if (state.teamMessageTime !== 0 && state.teamMessageTime < context.time) teamChat(context, state, "harvest_start", "onoffense");
        goal.copyFrom(context.deathmatch.neutralObelisk);
        if (state.teamGoalTime < context.time) state.ltgType = BotLongTermGoal.NONE;
        if (touchingGoal(state.origin, goal)) state.harvestAwayTime = f(f(context.time + 4) + f(3 * context.random()));
        return true;
      }
    }
  }
  return botGetItemLongTermGoal(context, state, flags, goal);
}

export function botLongTermGoal(context: GameAiContext, state: BotState, flags: number, retreat: boolean, goal: BotGoalState): boolean {
  if (state.leadTime > 0 && !retreat) {
    if (state.leadTime < context.time) {
      botInitialChat(context, state, "lead_stop", easyClientName(context, state.leadTeammate));
      context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL); state.leadTime = 0;
      return botGetLongTermGoal(context, state, flags, retreat, goal);
    }
    if (state.leadMessageTime < 0 && -state.leadMessageTime < context.time) {
      botInitialChat(context, state, "followme", easyClientName(context, state.leadTeammate));
      context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL); state.leadMessageTime = context.time;
    }
    const info = botEntityInfo(context, state.leadTeammate);
    if (info.valid) updateCompanionGoal(context, state.leadTeamGoal, state.leadTeammate, info.origin);
    if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.leadTeammate) !== 0) state.leadVisibleTime = context.time;
    if (state.leadVisibleTime < f(context.time - 1)) state.leadBackupTime = f(context.time + 2);
    const direction = sub3(state.origin, state.leadTeamGoal.origin), distanceSquared = dot3(direction, direction);
    if (state.leadBackupTime > context.time) {
      if (state.leadMessageTime < f(context.time - 20)) {
        botInitialChat(context, state, "followme", easyClientName(context, state.leadTeammate));
        context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL); state.leadMessageTime = context.time;
      }
      if (distanceSquared < 100 * 100) state.leadBackupTime = 0;
      goal.copyFrom(state.leadTeamGoal);
      return true;
    } else if (distanceSquared > 500 * 500) {
      if (state.leadMessageTime < f(context.time - 20)) {
        botInitialChat(context, state, "followme", easyClientName(context, state.leadTeammate));
        context.library.chat.enterChat(state.cs, state.teammate, CHAT_TELL); state.leadMessageTime = context.time;
      }
      lookAt(state, info.origin); halfRoll(state);
      return false;
    }
  }
  return botGetLongTermGoal(context, state, flags, retreat, goal);
}

export function botClearPath(context: GameAiContext, state: BotState, result: BotMoveResult): void {
  const movementAim = BotMoveResultFlag.MOVEMENTVIEW | BotMoveResultFlag.MOVEMENTWEAPON;
  if (state.kamikazeBody !== 0 && (result.flags & movementAim) === 0) {
    const body = context.getEntityState(state.kamikazeBody) ?? new EntityState();
    const target = vec3(body.pos.base.x, body.pos.base.y, body.pos.base.z + 8);
    result.idealViewAngles = vectorToAngles(sub3(target, state.eye));
    result.weapon = botSelectActivateWeapon(context, state);
    if (result.weapon === -1) result.weapon = 0;
    if (result.weapon !== 0) {
      result.flags |= movementAim;
      if (state.curPs.weapon === result.weapon && inFieldOfVision(state.viewangles, 20, result.idealViewAngles)) {
        const trace = botAITrace(context, state.eye, target, state.entityNum, MASK_SHOT);
        if (trace.fraction >= 1 || trace.entityNum === body.number) context.library.actions.attack(state.client);
      }
    }
  }
  if ((result.flags & BotMoveResultFlag.BLOCKEDBYAVOIDSPOT) !== 0) state.blockedByAvoidSpotTime = f(context.time + 5);
  if (state.blockedByAvoidSpotTime > context.time && (result.flags & movementAim) === 0) {
    let bestDistance = 300, bestMine = -1;
    for (let index = 0; index < state.numProxMines; index++) {
      const entityNum = state.proxMines[index];
      if (entityNum === undefined) throw new RangeError(`Missing proximity mine slot ${index}`);
      const mine = context.getEntityState(entityNum) ?? new EntityState();
      const distance = length3(sub3(mine.pos.base, state.origin));
      if (distance < bestDistance) { bestDistance = distance; bestMine = index; }
    }
    if (bestMine !== -1) {
      const entityNum = state.proxMines[bestMine];
      if (entityNum === undefined) throw new RangeError(`Missing proximity mine slot ${bestMine}`);
      const mine = context.getEntityState(entityNum) ?? new EntityState();
      const target = vec3(mine.pos.base.x, mine.pos.base.y, mine.pos.base.z + 2);
      result.idealViewAngles = vectorToAngles(sub3(target, state.eye));
      if (inventory(state, BotInventory.PLASMAGUN) > 0 && inventory(state, BotInventory.CELLS) > 0) result.weapon = Weapon.WP_PLASMAGUN;
      else if (inventory(state, BotInventory.ROCKETLAUNCHER) > 0 && inventory(state, BotInventory.ROCKETS) > 0) result.weapon = Weapon.WP_ROCKET_LAUNCHER;
      else if (inventory(state, BotInventory.BFG10K) > 0 && inventory(state, BotInventory.BFGAMMO) > 0) result.weapon = Weapon.WP_BFG;
      else result.weapon = 0;
      if (result.weapon !== 0) {
        result.flags |= movementAim;
        if (state.curPs.weapon === result.weapon && inFieldOfVision(state.viewangles, 20, result.idealViewAngles)) {
          const trace = botAITrace(context, state.eye, target, state.entityNum, MASK_SHOT);
          if (trace.fraction >= 1 || trace.entityNum === mine.number) context.library.actions.attack(state.client);
        }
      }
    }
  }
}

export function aiNodeSeekActivateEntity(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "activate entity", true)) return false;
  setTravelFlags(context, state, false);
  botMapScripts(context, state);
  state.enemy = -1;
  let activation = state.activateStack;
  if (activation === null) {
    botClearActivateGoalStack(context, state);
    aiEnterSeekNbg(context, state, "activate entity: no goal");
    return false;
  }
  const goal = activation.goal;
  let targetVisible = false;
  if (activation.shoot) {
    const trace = botAITrace(context, state.eye, activation.target, state.entityNum, MASK_SHOT);
    if (trace.fraction >= 1 || trace.entityNum === goal.entity) {
      targetVisible = true;
      if (state.curPs.weapon === activation.weapon
        && inFieldOfVision(state.viewangles, 20, vectorToAngles(sub3(activation.target, state.eye)))) context.library.actions.attack(state.client);
    }
  }
  const result = new BotMoveResult();
  if (targetVisible) {
    const info = botEntityInfo(context, goal.entity);
    if (activation.origin.x !== info.origin.x || activation.origin.y !== info.origin.y || activation.origin.z !== info.origin.z) activation.time = 0;
    if (activation.time < context.time) {
      botPopFromActivateGoalStack(context, state);
      if (state.activateStack !== null) { state.activateStack.time = f(context.time + 10); return false; }
      aiEnterSeekNbg(context, state, "activate entity: time out");
      return false;
    }
  } else {
    if (!activation.shoot && touchingGoal(state.origin, goal)) activation.time = 0;
    if (activation.time < context.time) {
      botPopFromActivateGoalStack(context, state);
      if (state.activateStack !== null) { state.activateStack.time = f(context.time + 10); return false; }
      aiEnterSeekNbg(context, state, "activate entity: activated");
      return false;
    }
    if (botAIPredictObstacles(context, state, goal)) return false;
    botSetupForMovement(context, state);
    context.library.movement.moveToGoal(result, state.ms, goal, state.tfl);
    if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); activation.time = 0; }
    botAIBlocked(context, state, result, true);
  }
  botClearPath(context, state, result);
  // BotAIBlocked may push an activation; the source rereads the stack here.
  activation = state.activateStack;
  if (activation === null) throw new Error("Activation movement cleared the source activation stack");
  if (activation.shoot) {
    if ((result.flags & BotMoveResultFlag.MOVEMENTVIEW) === 0) {
      result.idealViewAngles = vectorToAngles(sub3(activation.target, state.eye)); result.flags |= BotMoveResultFlag.MOVEMENTVIEW;
    }
    if ((result.flags & BotMoveResultFlag.MOVEMENTWEAPON) === 0) {
      result.flags |= BotMoveResultFlag.MOVEMENTWEAPON;
      activation.weapon = botSelectActivateWeapon(context, state);
      if (activation.weapon === -1) activation.weapon = 0;
      result.weapon = activation.weapon;
    }
  }
  if ((result.flags & MOVEMENT_VIEW) !== 0) state.idealViewangles = vec3(result.idealViewAngles.x, result.idealViewAngles.y, result.idealViewAngles.z);
  else if ((result.flags & BotMoveResultFlag.WAITING) !== 0) {
    if (context.random() < f(state.thinkTime * f(0.8))) { lookAt(state, botRoamGoal(context, state)); halfRoll(state); }
  } else if ((state.flags & BotFlag.IDEALVIEWSET) === 0) {
    const target = movementViewTarget(context, state, goal);
    if (target !== null) lookAt(state, target);
    else state.idealViewangles = vectorToAngles(result.moveDirection);
    halfRoll(state);
  }
  if ((result.flags & BotMoveResultFlag.MOVEMENTWEAPON) !== 0) state.weaponNum = result.weapon;
  if (botFindEnemy(context, state, -1)) {
    if (botWantsToRetreat(context, state)) aiEnterBattleNbg(context, state, "activate entity: found enemy");
    else {
      context.library.moveStates.resetLastAvoidReach(state.ms); context.library.goals.emptyGoalStack(state.gs);
      aiEnterBattleFight(context, state, "activate entity: found enemy");
    }
    botClearActivateGoalStack(context, state);
  }
  return true;
}

export function aiNodeSeekNbg(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "seek nbg")) return false;
  setTravelFlags(context, state, true);
  botMapScripts(context, state);
  state.enemy = -1;
  const goal = new BotGoalState(), top = context.library.goals.getTopGoal(state.gs);
  if (top === null) state.nbgTime = 0;
  else {
    goal.copyFrom(top);
    if (botReachedGoal(context, state, goal)) { botChooseWeapon(context, state); state.nbgTime = 0; }
  }
  if (state.nbgTime < context.time) {
    context.library.goals.popGoal(state.gs);
    state.checkTime = f(context.time + f(0.05));
    aiEnterSeekLtg(context, state, "seek nbg: time out");
    return false;
  }
  if (botAIPredictObstacles(context, state, goal)) return false;
  botSetupForMovement(context, state);
  const result = new BotMoveResult();
  context.library.movement.moveToGoal(result, state.ms, goal, state.tfl);
  if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); state.nbgTime = 0; }
  botAIBlocked(context, state, result, true);
  botClearPath(context, state, result);
  if ((result.flags & MOVEMENT_VIEW) !== 0) state.idealViewangles = vec3(result.idealViewAngles.x, result.idealViewAngles.y, result.idealViewAngles.z);
  else if ((result.flags & BotMoveResultFlag.WAITING) !== 0) {
    if (context.random() < f(state.thinkTime * f(0.8))) { lookAt(state, botRoamGoal(context, state)); halfRoll(state); }
  } else if ((state.flags & BotFlag.IDEALVIEWSET) === 0) {
    const next = context.library.goals.getSecondGoal(state.gs) ?? context.library.goals.getTopGoal(state.gs);
    if (next !== null) goal.copyFrom(next);
    const target = movementViewTarget(context, state, goal);
    if (target !== null) lookAt(state, target);
    else state.idealViewangles = vectorToAngles(result.moveDirection);
    halfRoll(state);
  }
  if ((result.flags & BotMoveResultFlag.MOVEMENTWEAPON) !== 0) state.weaponNum = result.weapon;
  if (botFindEnemy(context, state, -1)) {
    if (botWantsToRetreat(context, state)) aiEnterBattleNbg(context, state, "seek nbg: found enemy");
    else {
      context.library.moveStates.resetLastAvoidReach(state.ms); context.library.goals.emptyGoalStack(state.gs);
      aiEnterBattleFight(context, state, "seek nbg: found enemy");
    }
  }
  return true;
}

function objectiveNearbyRange(context: GameAiContext, state: BotState, range: number): number {
  if (context.gameType === GameType.GT_CTF) {
    if (botCTFCarryingFlag(context, state)) return 50;
  } else if (state.product === "missionpack") {
    if (context.gameType === GameType.GT_1FCTF && bot1FCTFCarryingFlag(context, state)) return 50;
    if (context.gameType === GameType.GT_HARVESTER && botHarvesterCarryingCubes(context, state)) return 80;
  }
  return range;
}

export function aiNodeSeekLtg(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "seek ltg")) return false;
  if (botChatRandom(context, state)) {
    state.standTime = f(context.time + botChatTime(context, state)); aiEnterStand(context, state, "seek ltg: random chat"); return false;
  }
  setTravelFlags(context, state, true);
  botMapScripts(context, state);
  state.enemy = -1;
  if (state.killedEnemyTime > f(context.time - 2) && context.random() < state.thinkTime) context.library.actions.gesture(state.client);
  if (botFindEnemy(context, state, -1)) {
    if (botWantsToRetreat(context, state)) { aiEnterBattleRetreat(context, state, "seek ltg: found enemy"); return false; }
    context.library.moveStates.resetLastAvoidReach(state.ms); context.library.goals.emptyGoalStack(state.gs);
    aiEnterBattleFight(context, state, "seek ltg: found enemy"); return false;
  }
  botTeamGoals(context, state, false);
  const goal = new BotGoalState();
  if (!botLongTermGoal(context, state, state.tfl, false, goal)) return true;
  if (state.checkTime < context.time) {
    state.checkTime = f(context.time + 0.5);
    botWantsToCamp(context, state);
    const range = objectiveNearbyRange(context, state, state.ltgType === BotLongTermGoal.DEFENDKEYAREA ? 400 : 150);
    if (botNearbyGoal(context, state, state.tfl, goal, range)) {
      context.library.moveStates.resetLastAvoidReach(state.ms);
      state.nbgTime = f(f(context.time + 4) + f(range * f(0.01)));
      aiEnterSeekNbg(context, state, "ltg seek: nbg"); return false;
    }
  }
  if (botAIPredictObstacles(context, state, goal)) return false;
  botSetupForMovement(context, state);
  const result = new BotMoveResult();
  context.library.movement.moveToGoal(result, state.ms, goal, state.tfl);
  if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); state.ltgTime = 0; }
  botAIBlocked(context, state, result, true);
  botClearPath(context, state, result);
  if ((result.flags & MOVEMENT_VIEW) !== 0) state.idealViewangles = vec3(result.idealViewAngles.x, result.idealViewAngles.y, result.idealViewAngles.z);
  else if ((result.flags & BotMoveResultFlag.WAITING) !== 0) {
    if (context.random() < f(state.thinkTime * f(0.8))) { lookAt(state, botRoamGoal(context, state)); halfRoll(state); }
  } else if ((state.flags & BotFlag.IDEALVIEWSET) === 0) {
    const target = movementViewTarget(context, state, goal);
    if (target !== null) lookAt(state, target);
    else if (dot3(result.moveDirection, result.moveDirection) !== 0) state.idealViewangles = vectorToAngles(result.moveDirection);
    else if (context.random() < f(state.thinkTime * f(0.8))) { lookAt(state, botRoamGoal(context, state)); halfRoll(state); }
    halfRoll(state);
  }
  if ((result.flags & BotMoveResultFlag.MOVEMENTWEAPON) !== 0) state.weaponNum = result.weapon;
  return true;
}

function rememberEnemyPosition(context: GameAiContext, state: BotState, origin: Vec3): void {
  let target = vec3(origin.x, origin.y, origin.z);
  if (state.enemy >= MAX_CLIENTS && state.product === "missionpack"
    && (state.enemy === context.deathmatch.redObelisk.entity || state.enemy === context.deathmatch.blueObelisk.entity)) target = vec3(target.x, target.y, target.z + 16);
  const area = botPointAreaNum(context, target);
  if (area !== 0 && areaReachability(context, area) !== 0) { state.lastEnemyOrigin = target; state.lastEnemyAreaNum = area; }
}

export function aiNodeBattleFight(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "battle fight")) return false;
  botFindEnemy(context, state, state.enemy);
  if (state.enemy < 0) { aiEnterSeekLtg(context, state, "battle fight: no enemy"); return false; }
  const info = botEntityInfo(context, state.enemy);
  if (state.enemyDeathTime !== 0) {
    if (state.enemyDeathTime < f(context.time - 1)) {
      state.enemyDeathTime = 0;
      if (state.enemySuicide) botChatEnemySuicide(context, state);
      if (state.lastKilledPlayer === state.enemy && botChatKill(context, state)) {
        state.standTime = f(context.time + botChatTime(context, state)); aiEnterStand(context, state, "battle fight: enemy dead");
      } else { state.ltgTime = 0; aiEnterSeekLtg(context, state, "battle fight: enemy dead"); }
      return false;
    }
  } else if (entityIsDead(context, info)) state.enemyDeathTime = context.time;
  if (entityIsInvisible(context, info) && !entityIsShooting(info) && context.random() < f(0.2)) {
    aiEnterSeekLtg(context, state, "battle fight: invisible"); return false;
  }
  rememberEnemyPosition(context, state, info.origin);
  botUpdateBattleInventory(context, state, state.enemy);
  if (state.lastFrameHealth > inventory(state, BotInventory.HEALTH) && botChatHitNoDeath(context, state)) {
    state.standTime = f(context.time + botChatTime(context, state));
    aiEnterStand(context, state, "battle fight: chat health decreased"); return false;
  }
  const hits = state.curPs.persistant.get(PersistentIndex.PERS_HITS);
  if (hits > state.lastHitCount && botChatHitNoKill(context, state)) {
    state.standTime = f(context.time + botChatTime(context, state));
    aiEnterStand(context, state, "battle fight: chat hit someone"); return false;
  }
  if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.enemy) === 0) {
    if (botWantsToChase(context, state)) aiEnterBattleChase(context, state, "battle fight: enemy out of sight");
    else aiEnterSeekLtg(context, state, "battle fight: enemy out of sight");
    return false;
  }
  botBattleUseItems(context, state);
  setTravelFlags(context, state, true);
  botChooseWeapon(context, state);
  const result = botAttackMove(context, state, state.tfl);
  if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); state.ltgTime = 0; }
  botAIBlocked(context, state, result, false);
  botAimAtEnemy(context, state);
  botCheckAttack(context, state);
  if ((state.flags & BotFlag.FIGHTSUICIDAL) === 0 && botWantsToRetreat(context, state)) {
    aiEnterBattleRetreat(context, state, "battle fight: wants to retreat"); return true;
  }
  return true;
}

export function aiNodeBattleChase(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "battle chase")) return false;
  if (state.enemy < 0) { aiEnterSeekLtg(context, state, "battle chase: no enemy"); return false; }
  if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.enemy) !== 0) {
    aiEnterBattleFight(context, state, "battle chase"); return false;
  }
  if (botFindEnemy(context, state, -1)) { aiEnterBattleFight(context, state, "battle chase: better enemy"); return false; }
  if (state.lastEnemyAreaNum === 0) { aiEnterSeekLtg(context, state, "battle chase: no enemy area"); return false; }
  setTravelFlags(context, state, true);
  botMapScripts(context, state);
  const goal = new BotGoalState();
  goal.entity = state.enemy; goal.area = state.lastEnemyAreaNum;
  goal.origin = vec3(state.lastEnemyOrigin.x, state.lastEnemyOrigin.y, state.lastEnemyOrigin.z);
  goal.mins = vec3(-8, -8, -8); goal.maxs = vec3(8, 8, 8);
  if (touchingGoal(state.origin, goal)) state.chaseTime = 0;
  if (state.chaseTime === 0 || state.chaseTime < f(context.time - 10)) {
    aiEnterSeekLtg(context, state, "battle chase: time out"); return false;
  }
  if (state.checkTime < context.time) {
    state.checkTime = f(context.time + 1);
    const range = 150;
    if (botNearbyGoal(context, state, state.tfl, goal, range)) {
      state.nbgTime = f(f(context.time + f(f(0.1) * range)) + 1);
      context.library.moveStates.resetLastAvoidReach(state.ms);
      aiEnterBattleNbg(context, state, "battle chase: nbg"); return false;
    }
  }
  botUpdateBattleInventory(context, state, state.enemy);
  botSetupForMovement(context, state);
  const result = new BotMoveResult();
  context.library.movement.moveToGoal(result, state.ms, goal, state.tfl);
  if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); state.ltgTime = 0; }
  botAIBlocked(context, state, result, false);
  if ((result.flags & MOVEMENT_VIEW) !== 0) state.idealViewangles = vec3(result.idealViewAngles.x, result.idealViewAngles.y, result.idealViewAngles.z);
  else if ((state.flags & BotFlag.IDEALVIEWSET) === 0) {
    if (state.chaseTime > f(context.time - 2)) botAimAtEnemy(context, state);
    else {
      const target = movementViewTarget(context, state, goal);
      if (target !== null) lookAt(state, target);
      else state.idealViewangles = vectorToAngles(result.moveDirection);
    }
    halfRoll(state);
  }
  if ((result.flags & BotMoveResultFlag.MOVEMENTWEAPON) !== 0) state.weaponNum = result.weapon;
  if (state.areaNum === state.lastEnemyAreaNum) state.chaseTime = 0;
  if (botWantsToRetreat(context, state)) { aiEnterBattleRetreat(context, state, "battle chase: wants to retreat"); return true; }
  return true;
}

function retreatView(context: GameAiContext, state: BotState, goal: BotGoalState, result: BotMoveResult): void {
  if ((result.flags & (BotMoveResultFlag.MOVEMENTVIEW | BotMoveResultFlag.SWIMVIEW)) !== 0) state.idealViewangles = vec3(result.idealViewAngles.x, result.idealViewAngles.y, result.idealViewAngles.z);
  else if ((result.flags & BotMoveResultFlag.MOVEMENTVIEWSET) === 0 && (state.flags & BotFlag.IDEALVIEWSET) === 0) {
    const skill = context.library.characters.boundedFloat(state.character, BotCharacteristic.ATTACK_SKILL, 0, 1);
    if (skill > f(0.3)) botAimAtEnemy(context, state);
    else {
      const target = movementViewTarget(context, state, goal);
      if (target !== null) lookAt(state, target);
      else state.idealViewangles = vectorToAngles(result.moveDirection);
      halfRoll(state);
    }
  }
  if ((result.flags & BotMoveResultFlag.MOVEMENTWEAPON) !== 0) state.weaponNum = result.weapon;
}

export function aiNodeBattleRetreat(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "battle retreat")) return false;
  if (state.enemy < 0) { aiEnterSeekLtg(context, state, "battle retreat: no enemy"); return false; }
  const info = botEntityInfo(context, state.enemy);
  if (entityIsDead(context, info)) { aiEnterSeekLtg(context, state, "battle retreat: enemy dead"); return false; }
  botFindEnemy(context, state, state.enemy);
  setTravelFlags(context, state, false);
  botMapScripts(context, state);
  botUpdateBattleInventory(context, state, state.enemy);
  if (botWantsToChase(context, state)) {
    context.library.goals.emptyGoalStack(state.gs);
    aiEnterBattleChase(context, state, "battle retreat: wants to chase"); return false;
  }
  if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.enemy) !== 0) {
    state.enemyVisibleTime = context.time;
    rememberEnemyPosition(context, state, info.origin);
  }
  if (state.enemyVisibleTime < f(context.time - 4)) { aiEnterSeekLtg(context, state, "battle retreat: lost enemy"); return false; }
  else if (state.enemyVisibleTime < context.time && botFindEnemy(context, state, -1)) {
    aiEnterBattleFight(context, state, "battle retreat: another enemy"); return false;
  }
  botTeamGoals(context, state, true);
  botBattleUseItems(context, state);
  const goal = new BotGoalState();
  if (!botLongTermGoal(context, state, state.tfl, true, goal)) {
    aiEnterBattleSuicidalFight(context, state, "battle retreat: no way out"); return false;
  }
  if (state.checkTime < context.time) {
    state.checkTime = f(context.time + 1);
    const range = objectiveNearbyRange(context, state, 150);
    if (botNearbyGoal(context, state, state.tfl, goal, range)) {
      context.library.moveStates.resetLastAvoidReach(state.ms);
      state.nbgTime = f(f(context.time + f(range / 100)) + 1);
      aiEnterBattleNbg(context, state, "battle retreat: nbg"); return false;
    }
  }
  botSetupForMovement(context, state);
  const result = new BotMoveResult();
  context.library.movement.moveToGoal(result, state.ms, goal, state.tfl);
  if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); state.ltgTime = 0; }
  botAIBlocked(context, state, result, false);
  botChooseWeapon(context, state);
  retreatView(context, state, goal, result);
  botCheckAttack(context, state);
  return true;
}

export function aiNodeBattleNbg(context: GameAiContext, state: BotState): boolean {
  if (checkLifecycle(context, state, "battle nbg")) return false;
  if (state.enemy < 0) { aiEnterSeekNbg(context, state, "battle nbg: no enemy"); return false; }
  const info = botEntityInfo(context, state.enemy);
  if (entityIsDead(context, info)) { aiEnterSeekNbg(context, state, "battle nbg: enemy dead"); return false; }
  setTravelFlags(context, state, true);
  botMapScripts(context, state);
  if (botEntityVisible(context, state.entityNum, state.eye, state.viewangles, 360, state.enemy) !== 0) {
    state.enemyVisibleTime = context.time;
    rememberEnemyPosition(context, state, info.origin);
  }
  const goal = new BotGoalState(), top = context.library.goals.getTopGoal(state.gs);
  if (top === null) state.nbgTime = 0;
  else { goal.copyFrom(top); if (botReachedGoal(context, state, goal)) state.nbgTime = 0; }
  if (state.nbgTime < context.time) {
    context.library.goals.popGoal(state.gs);
    if (context.library.goals.getTopGoal(state.gs) !== null) aiEnterBattleRetreat(context, state, "battle nbg: time out");
    else aiEnterBattleFight(context, state, "battle nbg: time out");
    return false;
  }
  botSetupForMovement(context, state);
  const result = new BotMoveResult();
  context.library.movement.moveToGoal(result, state.ms, goal, state.tfl);
  if (result.failure) { context.library.moveStates.resetAvoidReach(state.ms); state.nbgTime = 0; }
  botAIBlocked(context, state, result, false);
  botUpdateBattleInventory(context, state, state.enemy);
  botChooseWeapon(context, state);
  retreatView(context, state, goal, result);
  botCheckAttack(context, state);
  return true;
}

/** Source ainode function-pointer dispatch; false runs the next node in the same think. */
export function runAiNode(context: GameAiContext, state: BotState): boolean {
  switch (state.aiNode) {
    case "intermission": return aiNodeIntermission(context, state);
    case "observer": return aiNodeObserver(context, state);
    case "stand": return aiNodeStand(context, state);
    case "respawn": return aiNodeRespawn(context, state);
    case "seek-activate-entity": return aiNodeSeekActivateEntity(context, state);
    case "seek-nbg": return aiNodeSeekNbg(context, state);
    case "seek-ltg": return aiNodeSeekLtg(context, state);
    case "battle-fight": return aiNodeBattleFight(context, state);
    case "battle-chase": return aiNodeBattleChase(context, state);
    case "battle-retreat": return aiNodeBattleRetreat(context, state);
    case "battle-nbg": return aiNodeBattleNbg(context, state);
    case null: throw new Error("BotDeathmatchAI must enter an AI node before dispatch");
  }
}
