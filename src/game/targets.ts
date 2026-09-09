// Ported from id Software's code/game/g_target.c and the target_push section
// of g_trigger.c. Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, normalize3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityEvent, EntityType, MoveType, Powerup, Team } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { MovementTrace } from "../shared/slide-move.ts";
import { damage, DamageFlags } from "./combat.ts";
import type { CombatContext } from "./combat.ts";
import type { EntityPool } from "./entities.ts";
import { setOrigin } from "./entities.ts";
import { gameFormat } from "./format.ts";
import { touchItem } from "./item-lifecycle.ts";
import type { ItemLifecycleContext } from "./item-lifecycle.ts";
import { teleportPlayer } from "./misc.ts";
import type { GameRandom } from "./numeric.ts";
import type { SpawnHandler, SpawnVariables } from "./spawn.ts";
import type { GameEntity } from "./state.ts";
import { aimAtTarget } from "./triggers.ts";
import { findEntity, moveDirection, pickTarget, teamCommand, useTargets } from "./utilities.ts";

const CS_LOCATIONS = 608;
const MASK_TARGET_LASER = 0x1 | 0x2000000 | 0x4000000;
const MOD_TELEFRAG = 18;
const MOD_TARGET_LASER = 21;

export class TargetLocationState {
  linked = false;
  head: GameEntity | null = null;

  reset(): void {
    this.linked = false;
    this.head = null;
  }
}

export interface TargetRuntime {
  readonly entities: EntityPool;
  readonly world: ServerWorld;
  readonly itemLifecycle: ItemLifecycleContext;
  readonly random: Pick<GameRandom, "rand" | "crandom">;
  readonly locations: TargetLocationState;
  combat(): CombatContext;
  gravity(): number;
  soundIndex(path: string): number;
  addScore(player: GameEntity, origin: Vec3, points: number): void;
  returnFlag(team: Team): void;
  sendServerCommand(clientNum: number, command: string): void;
  remapShader(oldName: string, newName: string, timeSeconds: number): void;
  setConfigstring(index: number, value: string): void;
  warn(message: string): void;
}

function gameTime(runtime: TargetRuntime): number {
  const time = runtime.entities.options.time();
  if (!Number.isInteger(time) || time < -2_147_483_648 || time > 2_147_483_647) {
    throw new RangeError("Target runtime time must be a signed 32-bit millisecond value");
  }
  return time;
}

function requireOwned(runtime: TargetRuntime, entity: GameEntity): void {
  if (runtime.entities.get(entity.slot) !== entity) {
    throw new Error("Target entity does not belong to its entity pool or was replaced");
  }
}

function combatContext(runtime: TargetRuntime): CombatContext {
  const combat = runtime.combat();
  if (combat.entities !== runtime.entities || combat.world !== runtime.world) {
    throw new Error("Target combat context does not match its entity pool and world");
  }
  if (combat.time !== gameTime(runtime)) throw new Error("Target combat context contains stale game time");
  return combat;
}

function requireActivator(runtime: TargetRuntime, activator: GameEntity | null): GameEntity {
  if (activator === null) throw new Error("Target handler requires an activator");
  requireOwned(runtime, activator);
  return activator;
}

function dispatchTargets(runtime: TargetRuntime, entity: GameEntity, activator: GameEntity | null): void {
  useTargets({ pool: runtime.entities, time: gameTime(runtime),
    remapShader: (oldName, newName, timeSeconds) => { runtime.remapShader(oldName, newName, timeSeconds); },
    warn: message => { runtime.warn(message); } }, entity, activator);
}

function zeroTrace(): MovementTrace {
  return { fraction: 0, end: vec3(0, 0, 0), solidity: "clear", contact: { kind: "none" },
    contents: 0, surfaceFlags: 0, entityNum: 0 };
}

function useTargetGive(entity: GameEntity, _other: GameEntity | null, activatorValue: GameEntity | null,
  runtime: TargetRuntime): void {
  const activator = requireActivator(runtime, activatorValue);
  if (activator.client === null || entity.target === null) return;
  let target: GameEntity | null = null;
  while ((target = findEntity(runtime.entities, target, "targetname", entity.target)) !== null) {
    if (target.item === null) continue;
    touchItem(target, activator, zeroTrace(), runtime.itemLifecycle);
    target.nextthink = 0;
    runtime.entities.options.unlink(target);
  }
}

function spawnTargetGive(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.use = (self, other, activator) => { useTargetGive(self, other, activator, runtime); };
}

function useTargetRemovePowerups(_entity: GameEntity, _other: GameEntity | null,
  activatorValue: GameEntity | null, runtime: TargetRuntime): void {
  const activator = requireActivator(runtime, activatorValue);
  const client = activator.client;
  if (client === null) return;
  const powerups = client.ps.powerups;
  if (powerups.get(Powerup.PW_REDFLAG) !== 0) runtime.returnFlag(Team.TEAM_RED);
  else if (powerups.get(Powerup.PW_BLUEFLAG) !== 0) runtime.returnFlag(Team.TEAM_BLUE);
  else if (powerups.get(Powerup.PW_NEUTRALFLAG) !== 0) runtime.returnFlag(Team.TEAM_FREE);
  for (let index = 0; index < powerups.length; index++) powerups.set(index, 0);
}

function spawnTargetRemovePowerups(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.use = (self, other, activator) => { useTargetRemovePowerups(self, other, activator, runtime); };
}

function targetCrandom(runtime: TargetRuntime): number {
  const value = runtime.random.crandom();
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new RangeError("Game crandom() must return a value within [-1, 1]");
  }
  return Math.fround(value);
}

function sourceFloatSchedule(time: number, seconds: number): number {
  const milliseconds = Math.fround(Math.fround(seconds) * 1_000);
  return qvmFloatToInt(Math.fround(Math.fround(time) + milliseconds));
}

function thinkTargetDelay(entity: GameEntity, runtime: TargetRuntime): void {
  dispatchTargets(runtime, entity, entity.activator);
}

function useTargetDelay(entity: GameEntity, _other: GameEntity | null, activator: GameEntity | null,
  runtime: TargetRuntime): void {
  const variance = Math.fround(Math.fround(entity.random) * targetCrandom(runtime));
  const seconds = Math.fround(Math.fround(entity.wait) + variance);
  entity.nextthink = sourceFloatSchedule(gameTime(runtime), seconds);
  entity.think = self => { thinkTargetDelay(self, runtime); };
  entity.activator = activator;
}

function spawnTargetDelay(entity: GameEntity, variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  const delay = variables.float("delay", "0");
  entity.wait = delay.present ? delay.value : variables.float("wait", "1").value;
  if (entity.wait === 0) entity.wait = 1;
  entity.use = (self, other, activator) => { useTargetDelay(self, other, activator, runtime); };
}

function useTargetScore(entity: GameEntity, _other: GameEntity | null, activatorValue: GameEntity | null,
  runtime: TargetRuntime): void {
  runtime.addScore(requireActivator(runtime, activatorValue), entity.r.currentOrigin, entity.count);
}

function spawnTargetScore(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  if (entity.count === 0) entity.count = 1;
  entity.use = (self, other, activator) => { useTargetScore(self, other, activator, runtime); };
}

function centerPrint(message: string | null): string {
  return gameFormat("cp \"%s\"", [message]);
}

function useTargetPrint(entity: GameEntity, _other: GameEntity | null, activatorValue: GameEntity | null,
  runtime: TargetRuntime): void {
  const activator = requireActivator(runtime, activatorValue);
  const command = centerPrint(entity.message);
  if (activator.client !== null && (entity.spawnflags & 4) !== 0) {
    runtime.sendServerCommand(activator.slot, command);
    return;
  }
  if ((entity.spawnflags & 3) !== 0) {
    const send = (clientNum: number, value: string): void => { runtime.sendServerCommand(clientNum, value); };
    if ((entity.spawnflags & 1) !== 0) teamCommand(runtime.entities, Team.TEAM_RED, command, send);
    if ((entity.spawnflags & 2) !== 0) teamCommand(runtime.entities, Team.TEAM_BLUE, command, send);
    return;
  }
  runtime.sendServerCommand(-1, command);
}

function spawnTargetPrint(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.use = (self, other, activator) => { useTargetPrint(self, other, activator, runtime); };
}

function speakerSoundPath(noise: string): string {
  return noise.includes(".wav") ? gameFormat("%s", [noise], 64) : gameFormat("%s.wav", [noise], 64);
}

function useTargetSpeaker(entity: GameEntity, _other: GameEntity | null, activator: GameEntity | null,
  runtime: TargetRuntime): void {
  if ((entity.spawnflags & 3) !== 0) {
    entity.s.loopSound = entity.s.loopSound !== 0 ? 0 : entity.noiseIndex;
    return;
  }
  if ((entity.spawnflags & 8) !== 0) {
    runtime.entities.addEvent(requireActivator(runtime, activator), EntityEvent.EV_GENERAL_SOUND, entity.noiseIndex);
  } else if ((entity.spawnflags & 4) !== 0) {
    runtime.entities.addEvent(entity, EntityEvent.EV_GLOBAL_SOUND, entity.noiseIndex);
  } else runtime.entities.addEvent(entity, EntityEvent.EV_GENERAL_SOUND, entity.noiseIndex);
}

function spawnTargetSpeaker(entity: GameEntity, variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.wait = variables.float("wait", "0").value;
  entity.random = variables.float("random", "0").value;
  const noise = variables.string("noise", "NOSOUND");
  if (!noise.present) {
    throw new Error(gameFormat("target_speaker without a noise key at %s", [runtime.entities.utilities.vtos(entity.s.origin).readString()]));
  }
  if (noise.value.charAt(0) === "*") entity.spawnflags |= 8;
  entity.noiseIndex = runtime.soundIndex(speakerSoundPath(noise.value));
  entity.s.eType = EntityType.ET_SPEAKER;
  entity.s.eventParm = entity.noiseIndex;
  entity.s.frame = qvmFloatToInt(Math.fround(entity.wait * 10));
  entity.s.clientNum = qvmFloatToInt(Math.fround(entity.random * 10));
  if ((entity.spawnflags & 1) !== 0) entity.s.loopSound = entity.noiseIndex;
  entity.use = (self, other, activator) => { useTargetSpeaker(self, other, activator, runtime); };
  if ((entity.spawnflags & 4) !== 0) entity.r.svFlags |= ServerEntityFlags.BROADCAST;
  entity.s.pos = { ...entity.s.pos, base: vec3(entity.s.origin.x, entity.s.origin.y, entity.s.origin.z) };
  runtime.entities.options.link(entity);
}

function targetSound(entity: GameEntity, soundIndex: number, runtime: TargetRuntime): void {
  const sound = runtime.entities.tempEntity(entity.r.currentOrigin, EntityEvent.EV_GENERAL_SOUND);
  sound.s.eventParm = soundIndex;
}

function useTargetPush(entity: GameEntity, _other: GameEntity | null, activatorValue: GameEntity | null,
  runtime: TargetRuntime): void {
  const activator = requireActivator(runtime, activatorValue);
  const client = activator.client;
  if (client === null || client.ps.pmType !== MoveType.PM_NORMAL ||
    client.ps.powerups.get(Powerup.PW_FLIGHT) !== 0) return;
  client.ps.velocity = vec3(entity.s.origin2.x, entity.s.origin2.y, entity.s.origin2.z);
  const time = gameTime(runtime);
  if (activator.flySoundDebounceTime < time) {
    activator.flySoundDebounceTime = (time + 1_500) | 0;
    targetSound(activator, entity.noiseIndex, runtime);
  }
}

function spawnTargetPush(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  if (entity.speed === 0) entity.speed = 1_000;
  const moved = moveDirectionForTarget(entity);
  entity.s.origin2 = scale3(moved, entity.speed);
  entity.noiseIndex = runtime.soundIndex((entity.spawnflags & 1) !== 0
    ? "sound/world/jumppad.wav" : "sound/misc/windfly.wav");
  if (entity.target !== null) {
    entity.r.absmin = { ...entity.s.origin };
    entity.r.absmax = { ...entity.s.origin };
    entity.nextthink = (gameTime(runtime) + 100) | 0;
    entity.think = self => {
      const origin = scale3(add3(self.r.absmin, self.r.absmax), 0.5);
      aimAtTarget({ pool: runtime.entities, randomInt: () => runtime.random.rand(),
        gravity: () => runtime.gravity(), warn: message => { runtime.warn(message); } }, self, origin);
    };
  }
  entity.use = (self, other, activator) => { useTargetPush(self, other, activator, runtime); };
}

function moveDirectionForTarget(entity: GameEntity): Vec3 {
  const moved = moveDirection(entity.s.angles);
  entity.s.angles = moved.angles;
  return moved.direction;
}

function laserThink(entity: GameEntity, runtime: TargetRuntime): void {
  if (entity.enemy !== null) {
    const enemy = entity.enemy;
    const point = add3(add3(enemy.s.origin, scale3(enemy.r.mins, 0.5)), scale3(enemy.r.maxs, 0.5));
    entity.movedir = normalize3(sub3(point, entity.s.origin));
  }
  const end = add3(entity.s.origin, scale3(entity.movedir, 2_048));
  const trace = runtime.world.trace({ start: entity.s.origin, end, shape: { kind: "point" },
    passEntityNum: entity.slot, mask: MASK_TARGET_LASER });
  if (trace.entityNum !== 0) {
    damage(combatContext(runtime), runtime.entities.at(trace.entityNum), entity, entity.activator,
      entity.movedir, trace.end, entity.damage, DamageFlags.NO_KNOCKBACK, MOD_TARGET_LASER);
  }
  entity.s.origin2 = vec3(trace.end.x, trace.end.y, trace.end.z);
  runtime.entities.options.link(entity);
  entity.nextthink = (gameTime(runtime) + 100) | 0;
}

function laserOn(entity: GameEntity, runtime: TargetRuntime): void {
  if (entity.activator === null) entity.activator = entity;
  laserThink(entity, runtime);
}

function laserOff(entity: GameEntity, runtime: TargetRuntime): void {
  runtime.entities.options.unlink(entity);
  entity.nextthink = 0;
}

function useTargetLaser(entity: GameEntity, _other: GameEntity | null, activator: GameEntity | null,
  runtime: TargetRuntime): void {
  entity.activator = activator;
  if (entity.nextthink > 0) laserOff(entity, runtime);
  else laserOn(entity, runtime);
}

function startTargetLaser(entity: GameEntity, runtime: TargetRuntime): void {
  entity.s.eType = EntityType.ET_BEAM;
  if (entity.target !== null) {
    const target = findEntity(runtime.entities, null, "targetname", entity.target);
    if (target === null) {
      runtime.warn(gameFormat("%s at %s: %s is a bad target\n",
        [entity.classname, runtime.entities.utilities.vtos(entity.s.origin).readString(), entity.target]));
    }
    entity.enemy = target;
  } else entity.movedir = moveDirectionForTarget(entity);
  entity.use = (self, other, activator) => { useTargetLaser(self, other, activator, runtime); };
  entity.think = self => { laserThink(self, runtime); };
  if (entity.damage === 0) entity.damage = 1;
  if ((entity.spawnflags & 1) !== 0) laserOn(entity, runtime);
  else laserOff(entity, runtime);
}

function spawnTargetLaser(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.think = self => { startTargetLaser(self, runtime); };
  entity.nextthink = (gameTime(runtime) + 100) | 0;
}

function useTargetTeleporter(entity: GameEntity, _other: GameEntity | null, activatorValue: GameEntity | null,
  runtime: TargetRuntime): void {
  const activator = requireActivator(runtime, activatorValue);
  if (activator.client === null) return;
  const destination = pickTargetForRuntime(runtime, entity.target);
  if (destination === null) {
    runtime.warn("Couldn't find teleporter destination\n");
    return;
  }
  teleportPlayer({ combat: combatContext(runtime), world: runtime.world }, activator,
    destination.s.origin, destination.s.angles);
}

function spawnTargetTeleporter(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  if (entity.targetname === null) {
    runtime.warn(gameFormat("untargeted %s at %s\n", [entity.classname, runtime.entities.utilities.vtos(entity.s.origin).readString()]));
  }
  entity.use = (self, other, activator) => { useTargetTeleporter(self, other, activator, runtime); };
}

function useTargetKill(_entity: GameEntity, _other: GameEntity | null, activatorValue: GameEntity | null,
  runtime: TargetRuntime): void {
  damage(combatContext(runtime), requireActivator(runtime, activatorValue), null, null, null, null,
    100_000, DamageFlags.NO_PROTECTION, MOD_TELEFRAG);
}

function spawnTargetKill(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.use = (self, other, activator) => { useTargetKill(self, other, activator, runtime); };
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function linkTargetLocations(runtime: TargetRuntime): void {
  const state = runtime.locations;
  if (state.linked) return;
  state.linked = true;
  state.head = null;
  runtime.setConfigstring(CS_LOCATIONS, "unknown");
  let number = 1;
  for (let index = 0; index < runtime.entities.numEntities; index++) {
    const entity = runtime.entities.at(index);
    if (entity.classname === null || asciiFold(entity.classname) !== "target_location") continue;
    entity.health = number;
    runtime.setConfigstring(CS_LOCATIONS + number, entity.message ?? "");
    number++;
    entity.nextTrain = state.head;
    state.head = entity;
  }
}

function spawnTargetLocation(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.think = () => { linkTargetLocations(runtime); };
  entity.nextthink = (gameTime(runtime) + 200) | 0;
  setOrigin(entity, entity.s.origin);
}

function useTargetRelay(entity: GameEntity, _other: GameEntity | null, activator: GameEntity | null,
  runtime: TargetRuntime): void {
  if ((entity.spawnflags & 3) !== 0 && activator === null) {
    throw new Error("Team-filtered target_relay requires an activator");
  }
  if (activator !== null) requireOwned(runtime, activator);
  if ((entity.spawnflags & 1) !== 0 && activator !== null && activator.client !== null &&
    activator.client.sess.sessionTeam !== Team.TEAM_RED) return;
  if ((entity.spawnflags & 2) !== 0 && activator !== null && activator.client !== null &&
    activator.client.sess.sessionTeam !== Team.TEAM_BLUE) return;
  if ((entity.spawnflags & 4) !== 0) {
    const selected = pickTargetForRuntime(runtime, entity.target);
    selected?.use?.(selected, entity, activator);
    return;
  }
  dispatchTargets(runtime, entity, activator);
}

function pickTargetForRuntime(runtime: TargetRuntime, targetName: string | null): GameEntity | null {
  return pickTarget({ pool: runtime.entities, randomInt: () => runtime.random.rand(),
    warn: message => { runtime.warn(message); } }, targetName);
}

function spawnTargetRelay(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  entity.use = (self, other, activator) => { useTargetRelay(self, other, activator, runtime); };
}

function spawnTargetPosition(entity: GameEntity, _variables: SpawnVariables, runtime: TargetRuntime): void {
  requireOwned(runtime, entity);
  setOrigin(entity, entity.s.origin);
}

/** Spawn table entries for the concrete target entities implemented in this module. */
export function targetSpawnHandlers(runtime: TargetRuntime): ReadonlyMap<string, SpawnHandler> {
  if (runtime.itemLifecycle.entities !== runtime.entities || runtime.itemLifecycle.world !== runtime.world) {
    throw new Error("Target item lifecycle context does not match its entity pool and world");
  }
  return new Map<string, SpawnHandler>([
    ["target_give", (entity, variables) => { spawnTargetGive(entity, variables, runtime); }],
    ["target_remove_powerups", (entity, variables) => { spawnTargetRemovePowerups(entity, variables, runtime); }],
    ["target_delay", (entity, variables) => { spawnTargetDelay(entity, variables, runtime); }],
    ["target_score", (entity, variables) => { spawnTargetScore(entity, variables, runtime); }],
    ["target_print", (entity, variables) => { spawnTargetPrint(entity, variables, runtime); }],
    ["target_speaker", (entity, variables) => { spawnTargetSpeaker(entity, variables, runtime); }],
    ["target_laser", (entity, variables) => { spawnTargetLaser(entity, variables, runtime); }],
    ["target_teleporter", (entity, variables) => { spawnTargetTeleporter(entity, variables, runtime); }],
    ["target_relay", (entity, variables) => { spawnTargetRelay(entity, variables, runtime); }],
    ["target_position", (entity, variables) => { spawnTargetPosition(entity, variables, runtime); }],
    ["target_push", (entity, variables) => { spawnTargetPush(entity, variables, runtime); }],
    ["target_kill", (entity, variables) => { spawnTargetKill(entity, variables, runtime); }],
    ["target_location", (entity, variables) => { spawnTargetLocation(entity, variables, runtime); }],
  ]);
}
