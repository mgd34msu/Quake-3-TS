/*
 * Navigation and activation translated from id Software's game/ai_dmq3.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { AasRuntimeMap } from "../botlib/aas-runtime.ts";
import type { BotGoal } from "../botlib/goals.ts";
import { BotMoveFlag, BotMoveResult, BotMoveResultFlag, BotMoveResultType, BotMoveType } from "../botlib/movement-state.ts";
import { AlternativeRouteType, RouteStopEvent, TravelFlags } from "../botlib/routing.ts";
import type { AlternativeGoal } from "../botlib/routing.ts";
import { presenceTypeBounds } from "../botlib/spatial.ts";
import { CvarFlag } from "../core/cvar.ts";
import { infoValueForKey } from "../core/info-string.ts";
import { add3, cross3, dot3, length3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmAngleMod, qvmAngleVectors } from "../core/qvm-math.ts";
import { EntityType, GameType, Team, Weapon } from "../shared/definitions.ts";
import { ENTITYNUM_NONE, MoveFlags } from "../shared/player-state.ts";
import type { GameAiContext } from "./ai-context.ts";
import { botAITrace, botEntityInfo, entityIsDead, inFieldOfVision, vectorToAngles } from "./ai-combat.ts";
import { BotCharacteristic, BotFlag, MAX_ACTIVATEAREAS, MAX_WAYPOINTS } from "./ai-definitions.ts";
import { aiEnterSeekActivateEntity } from "./ai-decision.ts";
import { botSameTeam, clientName } from "./ai-orders.ts";
import { BotActivateGoal, BotGoalState, BotWaypoint } from "./ai-state.ts";
import type { BotState } from "./ai-state.ts";
import { gameFormat } from "./format.ts";
import { gameAtoi } from "./numeric.ts";
import { MAX_CLIENTS } from "./state.ts";

const f = Math.fround;
const CONTENTS_SOLID = 1;
const CONTENTS_LAVA = 8;
const CONTENTS_SLIME = 16;
const CONTENTS_TRIGGER = 0x40000000;
const MASK_SHOT = CONTENTS_SOLID | 0x02000000 | 0x04000000;
const AREA_CONTENTS_MOVER = 1024;
const MAX_ALT_ROUTE_GOALS = 32;
const axes: readonly (keyof Vec3)[] = ["x", "y", "z"];

/** ai_dmq3.c's globals have the game AI lifetime, including retained goal cells. */
export class GameAiDeathmatchState {
  gametype = 0;
  maxclients = 0;
  lastTeleportOrigin = vec3(0, 0, 0);
  lastTeleportTime = 0;
  maxBspModelIndex = 0;
  readonly ctfRedFlag = new BotGoalState();
  readonly ctfBlueFlag = new BotGoalState();
  readonly ctfNeutralFlag = new BotGoalState();
  readonly redObelisk = new BotGoalState();
  readonly blueObelisk = new BotGoalState();
  readonly neutralObelisk = new BotGoalState();
  alternateRoutesSetup = false;
  redAlternateGoals: readonly AlternativeGoal[] = [];
  blueAlternateGoals: readonly AlternativeGoal[] = [];
  readonly waypoints: readonly BotWaypoint[] = Array.from({ length: MAX_WAYPOINTS }, () => new BotWaypoint());
  freeWaypoints: BotWaypoint | null = null;
}

function map(context: GameAiContext): AasRuntimeMap {
  const phase = context.library.aas.phase;
  if (phase.kind !== "loaded" && phase.kind !== "ready") throw new Error("Bot navigation requires loaded AAS spatial data");
  return phase.map;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Bot navigation source index ${index} outside ${values.length} cells`);
  return value;
}

function copyVector(target: Vec3, source: Vec3): void { Object.assign(target, source); }
function sameVector(first: Vec3, second: Vec3): boolean { return first.x === second.x && first.y === second.y && first.z === second.z; }
function sameName(first: string, second: string): boolean {
  for (let index = 0;; index++) {
    let left = index < first.length ? first.charCodeAt(index) : 0;
    let right = index < second.length ? second.charCodeAt(index) : 0;
    if (left >= 97 && left <= 122) left -= 32;
    if (right >= 97 && right <= 122) right -= 32;
    if (left !== right) return false;
    if (left === 0) return true;
  }
}
function multiplyAdd(origin: Vec3, scale: number, direction: Vec3): Vec3 { return add3(origin, scale3(direction, scale)); }
function crandom(context: GameAiContext): number { return context.game.random.crandom(); }
function reachable(context: GameAiContext, area: number): boolean { return at(map(context).world.areaSettings, area).reachableAreaCount !== 0; }

function bspValue(context: GameAiContext, entity: number, key: string, size = 128): string | null {
  const output = new Uint8Array(size);
  if (!context.library.aas.bspEntities.value(entity, key, output)) return null;
  let text = "";
  for (const byte of output) { if (byte === 0) break; text += String.fromCharCode(byte); }
  return text;
}

function warning(context: GameAiContext, text: string): void { context.game.options.engine.print(`^3Warning: ${text}`); }
function error(context: GameAiContext, text: string): void { context.game.options.engine.print(`^1Error: ${text}`); }
function travelTime(context: GameAiContext, state: BotState, goal: BotGoal): number {
  return map(context).routing.areaTravelTimeToGoal({ area: state.areaNum, origin: state.origin, goalArea: goal.area, travelFlags: state.tfl });
}

export function botPointAreaNum(context: GameAiContext, origin: Vec3): number {
  const area = context.library.aas.pointArea(origin);
  if (area !== 0) return area;
  const phase = context.library.aas.phase;
  if (phase.kind === "unloaded") return 0;
  const crossings = map(context).spatial.traceAreas(origin, vec3(origin.x, origin.y, origin.z + 10), 10);
  const first = crossings[0];
  return first === undefined ? 0 : first.area;
}

export function botSetupForMovement(context: GameAiContext, state: BotState): void {
  const player = state.curPs;
  let flags = 0;
  if (player.groundEntityNum !== ENTITYNUM_NONE) flags |= BotMoveFlag.ONGROUND;
  if ((player.pmFlags & MoveFlags.TIME_KNOCKBACK) !== 0 && player.pmTime > 0) flags |= BotMoveFlag.TELEPORTED;
  if ((player.pmFlags & MoveFlags.TIME_WATERJUMP) !== 0 && player.pmTime > 0) flags |= BotMoveFlag.WATERJUMP;
  if (state.walker > 0.5) flags |= BotMoveFlag.WALK;
  context.library.moveStates.initialize(state.ms, {
    origin: player.origin, velocity: player.velocity, viewOffset: vec3(0, 0, player.viewheight),
    entityNum: state.entityNum, client: state.client, thinkTime: state.thinkTime,
    presenceType: (player.pmFlags & MoveFlags.DUCKED) !== 0 ? 4 : 2,
    viewAngles: state.viewangles, orMoveFlags: flags,
  });
}

export function botCreateWayPoint(context: GameAiContext, name: string, origin: Vec3, area: number): BotWaypoint | null {
  const waypoint = context.deathmatch.freeWaypoints;
  if (waypoint === null) { warning(context, "BotCreateWayPoint: Out of waypoints\n"); return null; }
  context.deathmatch.freeWaypoints = waypoint.next;
  waypoint.name = name.split("\0", 1).join("").slice(0, 31);
  copyVector(waypoint.goal.origin, origin);
  copyVector(waypoint.goal.mins, vec3(-8, -8, -8));
  copyVector(waypoint.goal.maxs, vec3(8, 8, 8));
  waypoint.goal.area = area;
  waypoint.next = null;
  waypoint.prev = null;
  return waypoint;
}

export function botFindWayPoint(waypoints: BotWaypoint | null, name: string): BotWaypoint | null {
  for (let waypoint = waypoints; waypoint !== null; waypoint = waypoint.next) {
    if (sameName(waypoint.name, name)) return waypoint;
  }
  return null;
}

export function botFreeWaypoints(context: GameAiContext, first: BotWaypoint | null): void {
  let waypoint = first;
  while (waypoint !== null) {
    const next = waypoint.next;
    waypoint.next = context.deathmatch.freeWaypoints;
    context.deathmatch.freeWaypoints = waypoint;
    waypoint = next;
  }
}

export function botInitWaypoints(context: GameAiContext): void {
  context.deathmatch.freeWaypoints = null;
  for (const waypoint of context.deathmatch.waypoints) {
    waypoint.next = context.deathmatch.freeWaypoints;
    context.deathmatch.freeWaypoints = waypoint;
  }
}

export function botRoamGoal(context: GameAiContext, state: BotState): Vec3 {
  let bestOrigin = vec3(0, 0, 0);
  for (let attempt = 0; attempt < 10; attempt++) {
    bestOrigin = vec3(state.origin.x, state.origin.y, state.origin.z);
    const random = context.random();
    if (random > 0.25) {
      const sign = context.random() < 0.5 ? -1 : 1;
      bestOrigin = vec3(bestOrigin.x + sign * f(f(800 * context.random()) + 100), bestOrigin.y, bestOrigin.z);
    }
    if (random < 0.75) {
      const sign = context.random() < 0.5 ? -1 : 1;
      bestOrigin = vec3(bestOrigin.x, bestOrigin.y + sign * f(f(800 * context.random()) + 100), bestOrigin.z);
    }
    bestOrigin = vec3(bestOrigin.x, bestOrigin.y, bestOrigin.z + f(96 * crandom(context)));
    const trace = botAITrace(context, state.origin, bestOrigin, state.entityNum, CONTENTS_SOLID);
    const direction = sub3(trace.end, state.origin), distance = length3(direction);
    if (distance > 200) {
      bestOrigin = multiplyAdd(state.origin, f(f(distance * trace.fraction) - 40), normalize3(direction));
      const below = vec3(bestOrigin.x, bestOrigin.y, bestOrigin.z - 800);
      const floor = botAITrace(context, bestOrigin, below, state.entityNum, CONTENTS_SOLID);
      if (floor.solidity === "clear") {
        const contents = context.game.world.pointContents(vec3(floor.end.x, floor.end.y, floor.end.z + 1), state.entityNum);
        if ((contents & (CONTENTS_LAVA | CONTENTS_SLIME)) === 0) return bestOrigin;
      }
    }
  }
  return bestOrigin;
}

export function botAttackMove(context: GameAiContext, state: BotState, travelFlags: number): BotMoveResult {
  const result = new BotMoveResult();
  if (state.attackChaseTime > context.time) {
    const goal = new BotGoalState();
    goal.entity = state.enemy;
    goal.area = state.lastEnemyAreaNum;
    copyVector(goal.origin, state.lastEnemyOrigin);
    goal.mins = vec3(-8, -8, -8);
    goal.maxs = vec3(8, 8, 8);
    botSetupForMovement(context, state);
    context.library.movement.moveToGoal(result, state.ms, goal, travelFlags);
    return result;
  }
  const characters = context.library.characters;
  const skill = characters.boundedFloat(state.character, BotCharacteristic.ATTACK_SKILL, 0, 1);
  const jumper = characters.boundedFloat(state.character, BotCharacteristic.JUMPER, 0, 1);
  const croucher = characters.boundedFloat(state.character, BotCharacteristic.CROUCHER, 0, 1);
  if (skill < f(0.2)) return result;
  botSetupForMovement(context, state);
  const enemy = botEntityInfo(context, state.enemy);
  const toward = sub3(enemy.origin, state.origin), distance = length3(toward), forward = normalize3(toward), backward = scale3(forward, -1);
  let moveType: BotMoveType = BotMoveType.WALK;
  if (state.attackCrouchTime < f(context.time - 1)) {
    if (context.random() < jumper) moveType = BotMoveType.JUMP;
    else if (state.attackCrouchTime < f(context.time - 1) && context.random() < croucher) state.attackCrouchTime = f(context.time + f(croucher * 5));
  }
  if (state.attackCrouchTime > context.time) moveType = BotMoveType.CROUCH;
  if (moveType === BotMoveType.JUMP) {
    if (state.attackJumpTime > context.time) moveType = BotMoveType.WALK;
    else state.attackJumpTime = f(context.time + 1);
  }
  const attackDistance = state.curPs.weapon === Weapon.WP_GAUNTLET ? 0 : 140;
  const attackRange = state.curPs.weapon === Weapon.WP_GAUNTLET ? 0 : 40;
  if (skill <= f(0.4)) {
    if (distance > attackDistance + attackRange && context.library.movement.moveInDirection(state.ms, forward, 400, moveType)) return result;
    if (distance < attackDistance - attackRange && context.library.movement.moveInDirection(state.ms, backward, 400, moveType)) return result;
    return result;
  }
  state.attackStrafeTime = f(state.attackStrafeTime + state.thinkTime);
  let changeTime = f(f(0.4) + f(f(1 - skill) * f(0.2)));
  if (skill > f(0.7)) changeTime = f(changeTime + f(crandom(context) * f(0.2)));
  if (state.attackStrafeTime > changeTime && context.random() > f(0.935)) {
    state.flags ^= BotFlag.STRAFERIGHT;
    state.attackStrafeTime = 0;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const horizontal = normalize3(vec3(forward.x, forward.y, 0));
    let sideward = cross3(horizontal, vec3(0, 0, 1));
    if ((state.flags & BotFlag.STRAFERIGHT) !== 0) sideward = scale3(sideward, -1);
    if (context.random() > f(0.9)) sideward = add3(sideward, backward);
    else if (distance > attackDistance + attackRange) sideward = add3(sideward, forward);
    else if (distance < attackDistance - attackRange) sideward = add3(sideward, backward);
    if (context.library.movement.moveInDirection(state.ms, sideward, 400, moveType)) return result;
    state.flags ^= BotFlag.STRAFERIGHT;
    state.attackStrafeTime = 0;
  }
  return result;
}

export function botSetMovedir(angles: Vec3, movedir: Vec3): void {
  copyVector(movedir, sameVector(angles, vec3(0, -1, 0)) ? vec3(0, 0, 1)
    : sameVector(angles, vec3(0, -2, 0)) ? vec3(0, 0, -1) : qvmAngleVectors(angles).forward);
}

export function botModelMinsMaxs(context: GameAiContext, modelIndex: number, entityType: number, contents: number, mins: Vec3 | null, maxs: Vec3 | null): number {
  for (let index = 0; index < context.game.pool.numEntities; index++) {
    const entity = context.game.pool.at(index);
    if (!entity.inuse || (entityType !== 0 && entity.s.eType !== entityType) || (contents !== 0 && entity.r.contents !== contents)) continue;
    if (entity.s.modelindex !== modelIndex) continue;
    if (mins !== null) copyVector(mins, add3(entity.r.currentOrigin, entity.r.mins));
    if (maxs !== null) copyVector(maxs, add3(entity.r.currentOrigin, entity.r.maxs));
    return index;
  }
  if (mins !== null) copyVector(mins, vec3(0, 0, 0));
  if (maxs !== null) copyVector(maxs, vec3(0, 0, 0));
  return 0;
}

function activationEntity(goal: BotGoalState, entity: number): void { goal.entity = entity; goal.number = 0; goal.flags = 0; }
function standAndShoot(state: BotState, activation: BotActivateGoal, entity: number): void {
  activationEntity(activation.goal, entity);
  copyVector(activation.goal.origin, state.origin);
  activation.goal.area = state.areaNum;
  activation.goal.mins = vec3(-8, -8, -8);
  activation.goal.maxs = vec3(8, 8, 8);
}

export function botFuncButtonActivateGoal(context: GameAiContext, state: BotState, bspEntity: number, activation: BotActivateGoal): boolean {
  activation.shoot = false;
  copyVector(activation.target, vec3(0, 0, 0));
  const model = bspValue(context, bspEntity, "model");
  if (model === null || model.length === 0) return false;
  const modelIndex = gameAtoi(model.slice(1));
  if (modelIndex === 0) return false;
  const mins = vec3(0, 0, 0), maxs = vec3(0, 0, 0);
  const entity = botModelMinsMaxs(context, modelIndex, EntityType.ET_MOVER, 0, mins, maxs);
  context.library.aas.bspEntities.float(bspEntity, "lip");
  const angle = context.library.aas.bspEntities.float(bspEntity, "angle").value;
  const direction = vec3(0, 0, 0);
  botSetMovedir(vec3(0, angle, 0), direction);
  const size = sub3(maxs, mins), origin = scale3(add3(mins, maxs), 0.5);
  let distance = dot3(vec3(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)), size);
  distance = f(distance * 0.5);
  const health = context.library.aas.bspEntities.float(bspEntity, "health").value;
  if (health !== 0) {
    const target = multiplyAdd(origin, -distance, direction);
    copyVector(activation.target, target);
    activation.shoot = true;
    const trace = botAITrace(context, state.eye, target, state.entityNum, MASK_SHOT);
    if (trace.fraction >= 1 || trace.entityNum === entity) { standAndShoot(state, activation, entity); return true; }
  }
  const bounds = presenceTypeBounds(4);
  for (const axis of axes) distance = f(distance + f(Math.abs(direction[axis]) * Math.abs(direction[axis] < 0 ? bounds.max[axis] : bounds.min[axis])));
  const goalOrigin = multiplyAdd(origin, -distance, direction);
  const start = vec3(goalOrigin.x, goalOrigin.y, goalOrigin.z + 24);
  const crossings = map(context).spatial.traceAreas(start, vec3(start.x, start.y, start.z - (health !== 0 ? 512 : 100)), 10);
  if (health !== 0) {
    for (let index = crossings.length - 1; index >= 0; index--) {
      const crossing = at(crossings, index);
      if (!reachable(context, crossing.area)) continue;
      copyVector(activation.goal.origin, crossing.point);
      activation.goal.area = crossing.area;
      activation.goal.mins = vec3(8, 8, 8);
      activation.goal.maxs = vec3(-8, -8, -8);
      expandButtonGoal(activation.goal, direction);
      activationEntity(activation.goal, entity);
      return true;
    }
  } else {
    for (const crossing of crossings) {
      if (!reachable(context, crossing.area)) continue;
      copyVector(activation.goal.origin, origin);
      activation.goal.area = crossing.area;
      activation.goal.mins = sub3(mins, origin);
      activation.goal.maxs = sub3(maxs, origin);
      expandButtonGoal(activation.goal, direction);
      activationEntity(activation.goal, entity);
      return true;
    }
  }
  return false;
}

function expandButtonGoal(goal: BotGoalState, direction: Vec3): void {
  goal.mins = vec3(goal.mins.x + (direction.x < 0 ? 0 : Math.abs(direction.x)),
    goal.mins.y + (direction.y < 0 ? 0 : Math.abs(direction.y)), goal.mins.z + (direction.z < 0 ? 0 : Math.abs(direction.z)));
  goal.maxs = vec3(goal.maxs.x + (direction.x < 0 ? Math.abs(direction.x) : 0),
    goal.maxs.y + (direction.y < 0 ? Math.abs(direction.y) : 0), goal.maxs.z + (direction.z < 0 ? Math.abs(direction.z) : 0));
}

export function botFuncDoorActivateGoal(context: GameAiContext, state: BotState, bspEntity: number, activation: BotActivateGoal): boolean {
  const model = bspValue(context, bspEntity, "model", 1024);
  if (model === null || model.length === 0) return false;
  const modelIndex = gameAtoi(model.slice(1));
  if (modelIndex === 0) return false;
  const mins = vec3(0, 0, 0), maxs = vec3(0, 0, 0);
  const entity = botModelMinsMaxs(context, modelIndex, EntityType.ET_MOVER, 0, mins, maxs);
  copyVector(activation.target, scale3(add3(mins, maxs), 0.5));
  activation.shoot = true;
  standAndShoot(state, activation, entity);
  return true;
}

export function botTriggerMultipleActivateGoal(context: GameAiContext, _state: BotState, bspEntity: number, activation: BotActivateGoal): boolean {
  activation.shoot = false;
  copyVector(activation.target, vec3(0, 0, 0));
  const model = bspValue(context, bspEntity, "model");
  if (model === null || model.length === 0) return false;
  const modelIndex = gameAtoi(model.slice(1));
  if (modelIndex === 0) return false;
  const mins = vec3(0, 0, 0), maxs = vec3(0, 0, 0);
  const entity = botModelMinsMaxs(context, modelIndex, 0, CONTENTS_TRIGGER, mins, maxs);
  const origin = scale3(add3(mins, maxs), 0.5), start = vec3(origin.x, origin.y, origin.z + 24);
  for (const crossing of map(context).spatial.traceAreas(start, vec3(start.x, start.y, start.z - 100), 10)) {
    if (!reachable(context, crossing.area)) continue;
    copyVector(activation.goal.origin, origin);
    activation.goal.area = crossing.area;
    activation.goal.mins = sub3(mins, origin);
    activation.goal.maxs = sub3(maxs, origin);
    activationEntity(activation.goal, entity);
    return true;
  }
  return false;
}

export function botEnableActivateGoalAreas(context: GameAiContext, activation: BotActivateGoal, enable: boolean): void {
  if (activation.areasDisabled === !enable) return;
  for (let index = 0; index < activation.numAreas; index++) map(context).routing.setAreaEnabled(at(activation.areas, index), enable);
  activation.areasDisabled = !enable;
}

export function botPopFromActivateGoalStack(context: GameAiContext, state: BotState): boolean {
  const activation = state.activateStack;
  if (activation === null) return false;
  botEnableActivateGoalAreas(context, activation, true);
  activation.inuse = false;
  activation.justUsedTime = context.time;
  state.activateStack = activation.next;
  return true;
}

export function botPushOntoActivateGoalStack(context: GameAiContext, state: BotState, activation: BotActivateGoal): boolean {
  let best: BotActivateGoal | null = null, bestTime = f(context.time + 9999);
  for (const candidate of state.activateGoalHeap) {
    if (!candidate.inuse && candidate.justUsedTime < bestTime) { bestTime = candidate.justUsedTime; best = candidate; }
  }
  if (best === null) return false;
  best.copyFrom(activation);
  best.inuse = true;
  best.next = state.activateStack;
  state.activateStack = best;
  return true;
}

export function botClearActivateGoalStack(context: GameAiContext, state: BotState): void {
  while (state.activateStack !== null) botPopFromActivateGoalStack(context, state);
}

export function botIsGoingToActivateEntity(context: GameAiContext, state: BotState, entity: number): boolean {
  for (let activation = state.activateStack; activation !== null; activation = activation.next) {
    if (activation.time < context.time) continue;
    if (activation.goal.entity === entity) return true;
  }
  for (const activation of state.activateGoalHeap) {
    if (!activation.inuse && activation.goal.entity === entity && activation.justUsedTime > f(context.time - 2)) return true;
  }
  return false;
}

export function botMapScripts(context: GameAiContext, state: BotState): void {
  const info = context.game.options.cvars.infoString(CvarFlag.ServerInfo, 1024);
  const mapName = infoValueForKey(info, "mapname").slice(0, 127);
  if (sameName(mapName, "q3tourney6")) {
    state.tfl &= ~TravelFlags.FUNCBOB;
    const belowCrusher = (origin: Vec3): boolean => origin.x > 700 && origin.x < 964
      && origin.y > 204 && origin.y < 468 && origin.z < 672;
    if (belowCrusher(state.origin)) return;
    let shootButton = false;
    for (let client = 0; client < context.maxClients && client < MAX_CLIENTS; client++) {
      if (client === state.client) continue;
      const entity = botEntityInfo(context, client);
      if (!entity.valid || entityIsDead(context, entity) || entity.number === state.entityNum) continue;
      if (belowCrusher(entity.origin)) {
        if (botSameTeam(context, state, client)) { shootButton = false; break; }
        shootButton = true;
      }
    }
    if (shootButton) {
      state.flags |= BotFlag.IDEALVIEWSET;
      state.idealViewangles = vectorToAngles(sub3(vec3(304, 352, 920), state.eye));
      const accuracy = context.library.characters.boundedFloat(state.character, BotCharacteristic.AIM_ACCURACY, 0, 1);
      const pitch = qvmAngleMod(f(state.idealViewangles.x + f(f(8 * crandom(context)) * f(1 - accuracy))));
      const yaw = qvmAngleMod(f(state.idealViewangles.y + f(f(8 * crandom(context)) * f(1 - accuracy))));
      state.idealViewangles = vec3(pitch, yaw, state.idealViewangles.z);
      if (inFieldOfVision(state.viewangles, 20, state.idealViewangles)) context.library.actions.attack(state.client);
    }
  } else if (sameName(mapName, "mpq3tourney6")) state.tfl &= ~TravelFlags.FUNCBOB;
}

/** Returns the BSP entity; the output goal stores the corresponding game entity. */
export function botGetActivateGoal(context: GameAiContext, state: BotState, entityNum: number, activation: BotActivateGoal): number {
  activation.clear();
  const entity = botEntityInfo(context, entityNum), bsp = context.library.aas.bspEntities;
  let model = `*${entity.modelIndex}`;
  let entityIndex = bsp.nextEntity(0);
  for (; entityIndex !== 0; entityIndex = bsp.nextEntity(entityIndex)) {
    if (bspValue(context, entityIndex, "model") === model) break;
  }
  if (entityIndex === 0) { error(context, `BotGetActivateGoal: no entity found with model ${model}\n`); return 0; }
  const classname = bspValue(context, entityIndex, "classname");
  if (classname === "func_door") {
    const health = bsp.float(entityIndex, "health");
    if (health.found && health.value !== 0) { botFuncDoorActivateGoal(context, state, entityIndex, activation); return entityIndex; }
    if ((bsp.int(entityIndex, "spawnflags").value & 1) !== 0) return 0;
    const origin = bsp.vector(entityIndex, "origin").value;
    if (!sameVector(origin, entity.origin)) return 0;
    const doorModel = bspValue(context, entityIndex, "model", 1024);
    model = doorModel === null ? "" : doorModel;
    if (model.length !== 0) {
      const modelIndex = gameAtoi(model.slice(1));
      if (modelIndex !== 0) {
        const mins = vec3(0, 0, 0), maxs = vec3(0, 0, 0);
        botModelMinsMaxs(context, modelIndex, EntityType.ET_MOVER, 0, mins, maxs);
        const areas = map(context).spatial.bboxAreas({ min: mins, max: maxs }).slice(0, MAX_ACTIVATEAREAS * 2);
        for (const requireReachability of [true, false]) {
          for (const area of areas) {
            if (activation.numAreas >= MAX_ACTIVATEAREAS) break;
            if (reachable(context, area) !== requireReachability) continue;
            if ((at(map(context).world.areaSettings, area).contents & AREA_CONTENTS_MOVER) !== 0) activation.areas[activation.numAreas++] = area;
          }
        }
      }
    }
  }
  if (classname === "func_button") return 0;
  const targetName = bspValue(context, entityIndex, "targetname");
  if (targetName === null) {
    if (context.cvar("bot_developer").integerValue !== 0) error(context, `BotGetActivateGoal: entity with model "${model}" has no targetname\n`);
    return 0;
  }
  const targets: string[] = [targetName], nextEntities: number[] = [bsp.nextEntity(0)];
  for (let depth = 0; depth >= 0 && depth < 10;) {
    const wanted = at(targets, depth);
    let activator = at(nextEntities, depth);
    for (; activator !== 0; activator = bsp.nextEntity(activator)) {
      if (bspValue(context, activator, "target") === wanted) { nextEntities[depth] = bsp.nextEntity(activator); break; }
    }
    if (activator === 0) {
      if (context.cvar("bot_developer").integerValue !== 0) error(context, `BotGetActivateGoal: no entity with target "${wanted}"\n`);
      depth--;
      continue;
    }
    const activatorClass = bspValue(context, activator, "classname");
    if (activatorClass === null) {
      if (context.cvar("bot_developer").integerValue !== 0) error(context, `BotGetActivateGoal: entity with target "${wanted}" has no classname\n`);
      continue;
    }
    if (activatorClass === "func_button" || activatorClass === "trigger_multiple") {
      const success = activatorClass === "func_button"
        ? botFuncButtonActivateGoal(context, state, activator, activation)
        : botTriggerMultipleActivateGoal(context, state, activator, activation);
      if (!success) continue;
      const current = state.activateStack;
      if (current !== null && current.inuse && current.goal.entity === activation.goal.entity
        && current.time > context.time && current.startTime < f(context.time - 2)) continue;
      if (reachable(context, state.areaNum)) {
        botEnableActivateGoalAreas(context, activation, false);
        const time = travelTime(context, state, activation.goal);
        if (time === 0) continue;
        activation.time = f(f(context.time + f(f(time) * f(0.01))) + 5);
      }
      return activator;
    }
    if (activatorClass === "func_timer") continue;
    if (activatorClass === "target_relay" || activatorClass === "target_delay") {
      const target = bspValue(context, activator, "targetname");
      if (target !== null) {
        if (depth + 1 >= 10) throw new RangeError("BotGetActivateGoal activation chain exceeds the source ten-level target allocation");
        targets[++depth] = target;
        nextEntities[depth] = bsp.nextEntity(0);
      }
    }
  }
  return 0;
}

export function botGoForActivateGoal(context: GameAiContext, state: BotState, activation: BotActivateGoal): boolean {
  activation.inuse = true;
  if (activation.time === 0) activation.time = f(context.time + 10);
  activation.startTime = context.time;
  copyVector(activation.origin, botEntityInfo(context, activation.goal.entity).origin);
  if (botPushOntoActivateGoalStack(context, state, activation)) {
    aiEnterSeekActivateEntity(context, state, "BotGoForActivateGoal");
    return true;
  }
  botEnableActivateGoalAreas(context, activation, true);
  return false;
}

export function botPrintActivateGoalInfo(context: GameAiContext, state: BotState, activation: BotActivateGoal, bspEntity: number): void {
  const name = clientName(context, state.client, 36), classname = bspValue(context, bspEntity, "classname");
  const origin = activation.goal.origin;
  const format = activation.shoot
    ? "%s: I have to shoot at a %s from %1.1f %1.1f %1.1f in area %d\n"
    : "%s: I have to activate a %s at %1.1f %1.1f %1.1f in area %d\n";
  context.library.actions.say(state.client, gameFormat(format, [name, classname === null ? "" : classname,
    origin.x, origin.y, origin.z, activation.goal.area], 128));
}

export function botRandomMove(context: GameAiContext, state: BotState, result: BotMoveResult): void {
  const direction = qvmAngleVectors(vec3(0, context.random() * 360, 0)).forward;
  context.library.movement.moveInDirection(state.ms, direction, 400, BotMoveType.WALK);
  result.failure = false;
  copyVector(result.moveDirection, direction);
}

export function botAIBlocked(context: GameAiContext, state: BotState, result: BotMoveResult, activate: boolean): void {
  if (!result.blocked) { state.notBlockedTime = context.time; return; }
  if (result.type === BotMoveResultType.INSOLIDAREA) { botRandomMove(context, state, result); return; }
  const entity = botEntityInfo(context, result.blockEntity);
  if (activate && entity.modelIndex > 0 && entity.modelIndex <= context.deathmatch.maxBspModelIndex) {
    const activation = new BotActivateGoal();
    const bspEntity = botGetActivateGoal(context, state, entity.number, activation);
    if (bspEntity !== 0) {
      if (state.activateStack !== null && !state.activateStack.inuse) state.activateStack = null;
      if (!botIsGoingToActivateEntity(context, state, activation.goal.entity)) botGoForActivateGoal(context, state, activation);
      if ((result.flags & BotMoveResultFlag.ONTOPOFOBSTACLE) === 0 && reachable(context, state.areaNum)) return;
    } else botEnableActivateGoalAreas(context, activation, true);
  }
  const horizontal = vec3(result.moveDirection.x, result.moveDirection.y, 0);
  let direction = normalize3(horizontal);
  if (length3(horizontal) < f(0.1)) direction = qvmAngleVectors(vec3(0, 360 * context.random(), 0)).forward;
  let sideward = cross3(direction, vec3(0, 0, 1));
  if ((state.flags & BotFlag.AVOIDRIGHT) !== 0) sideward = scale3(sideward, -1);
  if (!context.library.movement.moveInDirection(state.ms, sideward, 400, BotMoveType.WALK)) {
    state.flags ^= BotFlag.AVOIDRIGHT;
    sideward = sub3(sideward, direction);
    context.library.movement.moveInDirection(state.ms, sideward, 400, BotMoveType.WALK);
  }
  if (state.notBlockedTime < f(context.time - f(0.4))) {
    if (state.aiNode === "seek-nbg") state.nbgTime = 0;
    else if (state.aiNode === "seek-ltg") state.ltgTime = 0;
  }
}

export function botAIPredictObstacles(context: GameAiContext, state: BotState, goal: BotGoal): boolean {
  if (context.cvar("bot_predictobstacles").integerValue === 0) return false;
  if (state.predictObstaclesGoalAreaNum === goal.area && state.predictObstaclesTime > f(context.time - 6)) return false;
  state.predictObstaclesGoalAreaNum = goal.area;
  state.predictObstaclesTime = context.time;
  const route = map(context).routing.predictRoute({ area: state.areaNum, origin: state.origin,
    goalArea: goal.area, travelFlags: state.tfl, maximumAreas: 100, maximumTime: 1000,
    stopEvent: RouteStopEvent.USE_TRAVEL_TYPE | RouteStopEvent.ENTER_CONTENTS,
    stopContents: AREA_CONTENTS_MOVER, stopTravelFlags: TravelFlags.BRIDGE, stopArea: 0 });
  if ((route.stopEvent & RouteStopEvent.ENTER_CONTENTS) !== 0 && (route.endContents & AREA_CONTENTS_MOVER) !== 0) {
    const model = (route.endContents & 0xff000000) >> 24;
    if (model !== 0) {
      const entity = botModelMinsMaxs(context, model, EntityType.ET_MOVER, 0, null, null);
      if (entity !== 0) {
        const activation = new BotActivateGoal();
        if (botGetActivateGoal(context, state, entity, activation) !== 0) {
          if (state.activateStack !== null && !state.activateStack.inuse) state.activateStack = null;
          if (!botIsGoingToActivateEntity(context, state, activation.goal.entity)) {
            botGoForActivateGoal(context, state, activation);
            return true;
          }
          botEnableActivateGoalAreas(context, activation, true);
        }
      }
    }
  }
  return false;
}

export function botAlternateRoute(context: GameAiContext, state: BotState, goal: BotGoalState): BotGoal {
  if (state.altRouteGoal.area !== 0) {
    if (state.reachedAltRouteGoalTime !== 0) return goal;
    const time = travelTime(context, state, state.altRouteGoal);
    if (time !== 0 && time < 20) state.reachedAltRouteGoalTime = context.time;
    goal.copyFrom(state.altRouteGoal);
    return state.altRouteGoal;
  }
  return goal;
}

export function botGetAlternateRouteGoal(context: GameAiContext, state: BotState, base: number): boolean {
  const goals = base === Team.TEAM_RED ? context.deathmatch.redAlternateGoals : context.deathmatch.blueAlternateGoals;
  if (goals.length === 0) return false;
  let index = Math.trunc(f(context.random() * goals.length));
  if (index >= goals.length) index = goals.length - 1;
  const alternate = at(goals, index), goal = state.altRouteGoal;
  goal.area = alternate.area;
  copyVector(goal.origin, alternate.origin);
  goal.mins = vec3(-8, -8, -8);
  goal.maxs = vec3(8, 8, 8);
  goal.entity = 0;
  goal.itemInfo = 0;
  goal.number = 0;
  goal.flags = 0;
  state.reachedAltRouteGoalTime = 0;
  return true;
}

function levelGoal(context: GameAiContext, name: string, goal: BotGoalState, missing: string): void {
  const item = context.library.goals.getLevelItemGoal(-1, name, goal);
  if (item === null) warning(context, missing);
  else goal.copyFrom(item);
}

export function botSetupAlternativeRouteGoals(context: GameAiContext): void {
  const globals = context.deathmatch;
  if (globals.alternateRoutesSetup) return;
  if (context.game.options.product === "missionpack") {
    let neutral: BotGoalState | null = null, red = globals.ctfRedFlag, blue = globals.ctfBlueFlag;
    if (context.gameType === GameType.GT_CTF) {
      levelGoal(context, "Neutral Flag", globals.ctfNeutralFlag, "no alt routes without Neutral Flag\n");
      if (globals.ctfNeutralFlag.area !== 0) neutral = globals.ctfNeutralFlag;
    } else if (context.gameType === GameType.GT_1FCTF) neutral = globals.ctfNeutralFlag;
    else if (context.gameType === GameType.GT_OBELISK || context.gameType === GameType.GT_HARVESTER) {
      if (context.gameType === GameType.GT_OBELISK) levelGoal(context, "Neutral Obelisk", globals.neutralObelisk, "Harvester without neutral obelisk\n");
      neutral = globals.neutralObelisk;
      red = globals.redObelisk;
      blue = globals.blueObelisk;
    }
    if (neutral !== null) {
      const routing = map(context).routing;
      globals.redAlternateGoals = routing.alternativeRouteGoals({ start: neutral.origin, startArea: neutral.area,
        goal: red.origin, goalArea: red.area, travelFlags: TravelFlags.DEFAULT, maximumGoals: MAX_ALT_ROUTE_GOALS,
        type: AlternativeRouteType.CLUSTER_PORTALS | AlternativeRouteType.VIEW_PORTALS });
      globals.blueAlternateGoals = routing.alternativeRouteGoals({ start: neutral.origin, startArea: neutral.area,
        goal: blue.origin, goalArea: blue.area, travelFlags: TravelFlags.DEFAULT, maximumGoals: MAX_ALT_ROUTE_GOALS,
        type: AlternativeRouteType.CLUSTER_PORTALS | AlternativeRouteType.VIEW_PORTALS });
    }
  }
  globals.alternateRoutesSetup = true;
}

export function botSetEntityNumForGoalWithModel(context: GameAiContext, goal: BotGoalState, entityType: number, modelName: string): void {
  const model = context.game.config.modelIndex(modelName);
  for (let index = 0; index < context.game.pool.numEntities; index++) {
    const entity = context.game.pool.at(index);
    if (!entity.inuse || (entityType !== 0 && entity.s.eType !== entityType) || entity.s.modelindex !== model) continue;
    const direction = sub3(goal.origin, entity.s.origin);
    if (dot3(direction, direction) < 100) { goal.entity = index; return; }
  }
}

export function botSetEntityNumForGoal(context: GameAiContext, goal: BotGoalState, classname: string): void {
  for (let index = 0; index < context.game.pool.numEntities; index++) {
    const entity = context.game.pool.at(index);
    if (!entity.inuse) continue;
    if (entity.classname !== null && sameName(entity.classname, classname)) continue;
    const direction = sub3(goal.origin, entity.s.origin);
    if (dot3(direction, direction) < 100) { goal.entity = index; return; }
  }
}

export function botGoalForBSPEntity(context: GameAiContext, classname: string, goal: BotGoalState): boolean {
  goal.clear();
  const bsp = context.library.aas.bspEntities;
  for (let entity = bsp.nextEntity(0); entity !== 0; entity = bsp.nextEntity(entity)) {
    if (bspValue(context, entity, "classname", 1024) !== classname) continue;
    const origin = bsp.vector(entity, "origin");
    if (!origin.found) return false;
    copyVector(goal.origin, origin.value);
    const start = vec3(origin.value.x, origin.value.y, origin.value.z - 32), end = vec3(origin.value.x, origin.value.y, origin.value.z + 32);
    const crossing = map(context).spatial.traceAreas(start, end, 10)[0];
    if (crossing === undefined) return false;
    goal.area = crossing.area;
    return true;
  }
  return false;
}

export function botSetupDeathmatchAI(context: GameAiContext): void {
  const globals = context.deathmatch;
  const gameType = context.game.options.cvars.get("g_gametype"), maxClients = context.game.options.cvars.get("sv_maxclients");
  // Cvar_VariableIntegerValue returns zero for a name absent from the registry.
  globals.gametype = gameType === undefined ? 0 : gameType.integerValue;
  globals.maxclients = maxClients === undefined ? 0 : maxClients.integerValue;
  context.registerCvar("bot_rocketjump", "1");
  context.registerCvar("bot_grapple", "0");
  context.registerCvar("bot_fastchat", "0");
  context.registerCvar("bot_nochat", "0");
  context.registerCvar("bot_testrchat", "0");
  context.registerCvar("bot_challenge", "0");
  context.registerCvar("bot_predictobstacles", "1");
  context.registerCvar("g_spSkill", "2");
  if (globals.gametype === GameType.GT_CTF) {
    levelGoal(context, "Red Flag", globals.ctfRedFlag, "CTF without Red Flag\n");
    levelGoal(context, "Blue Flag", globals.ctfBlueFlag, "CTF without Blue Flag\n");
  } else if (context.game.options.product === "missionpack") {
    if (globals.gametype === GameType.GT_1FCTF) {
      levelGoal(context, "Neutral Flag", globals.ctfNeutralFlag, "One Flag CTF without Neutral Flag\n");
      levelGoal(context, "Red Flag", globals.ctfRedFlag, "CTF without Red Flag\n");
      levelGoal(context, "Blue Flag", globals.ctfBlueFlag, "CTF without Blue Flag\n");
    } else if (globals.gametype === GameType.GT_OBELISK || globals.gametype === GameType.GT_HARVESTER) {
      const mode = globals.gametype === GameType.GT_OBELISK ? "Obelisk" : "Harvester";
      levelGoal(context, "Red Obelisk", globals.redObelisk, `${mode} without red obelisk\n`);
      botSetEntityNumForGoal(context, globals.redObelisk, "team_redobelisk");
      levelGoal(context, "Blue Obelisk", globals.blueObelisk, `${mode} without blue obelisk\n`);
      botSetEntityNumForGoal(context, globals.blueObelisk, "team_blueobelisk");
      if (globals.gametype === GameType.GT_HARVESTER) {
        levelGoal(context, "Neutral Obelisk", globals.neutralObelisk, "Harvester without neutral obelisk\n");
        botSetEntityNumForGoal(context, globals.neutralObelisk, "team_neutralobelisk");
      }
    }
  }
  globals.maxBspModelIndex = 0;
  const bsp = context.library.aas.bspEntities;
  for (let entity = bsp.nextEntity(0); entity !== 0; entity = bsp.nextEntity(entity)) {
    const model = bspValue(context, entity, "model");
    if (model === null || model.charAt(0) !== "*") continue;
    const index = gameAtoi(model.slice(1));
    if (index > globals.maxBspModelIndex) globals.maxBspModelIndex = index;
  }
  botInitWaypoints(context);
}

export function botShutdownDeathmatchAI(context: GameAiContext): void { context.deathmatch.alternateRoutesSetup = false; }
