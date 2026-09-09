// Class spawn and trigger handlers translated from id Software's game/g_mover.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { add3, addPointToBounds, dot3, length3, scale3, sub3, vec3, vectorToAngles } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { Team } from "../shared/definitions.ts";
import { TrajectoryType } from "../shared/trajectory.ts";
import { teleportPlayer } from "./misc.ts";
import type { MoverRuntime } from "./mover.ts";
import type { SpawnHandler, SpawnVariables } from "./spawn.ts";
import { GameFlags, MoverState } from "./state.ts";
import type { GameEntity } from "./state.ts";
import { findEntity, moveDirection, useTargets } from "./utilities.ts";

export interface MoverSpawnHost {
  readonly movers: MoverRuntime;
  gravity(): number;
  /** SV_SetBrushModel: validate *index, publish CM bounds/inline model/contents=-1, then link. */
  setBrushModel(entity: GameEntity, name: string | null): void;
  remapShader(oldName: string, newName: string, timeSeconds: number): void;
  warn(message: string): void;
}

const f32 = Math.fround;
const FRAMETIME = 100;
const CONTENTS_TRIGGER = 0x40000000;
function floatInt(value: number): number {
  return value >= -2147483648 && value < 2147483648 ? Math.trunc(value) + 0 : -2147483648;
}
function component(value: Vec3, axis: number): number {
  switch (axis) { case 0: return value.x; case 1: return value.y; case 2: return value.z;
    default: throw new Error("Door trigger axis is not a source vector index"); }
}
function withComponent(value: Vec3, axis: number, amount: number): Vec3 {
  switch (axis) { case 0: return vec3(amount, value.y, value.z); case 1: return vec3(value.x, amount, value.z);
    case 2: return vec3(value.x, value.y, amount); default: throw new Error("Door trigger axis is not a source vector index"); }
}

/** Callbacks retain only their owning services; their self argument is the stable pool slot. */
export class MoverSpawnRuntime {
  private readonly doorTriggerTouch = (entity: GameEntity, other: GameEntity): void => { this.doorTouch(entity, other); };

  constructor(readonly host: MoverSpawnHost) {}

  isDoorTrigger(entity: GameEntity): boolean { return entity.touch === this.doorTriggerTouch; }

  private get core(): MoverRuntime { return this.host.movers; }
  private get time(): number { return this.core.host.combat.time; }
  private owned(entity: GameEntity): void {
    if (this.core.host.combat.entities.get(entity.slot) !== entity) throw new Error("Mover spawn entity belongs to another pool");
  }
  private bounds(entity: GameEntity): Bounds {
    return { min: entity.r.absmin, max: entity.r.absmax };
  }
  private parent(entity: GameEntity): GameEntity {
    if (entity.parent === null) throw new Error("Mover trigger has no parent");
    return entity.parent;
  }
  private setDirection(entity: GameEntity): void {
    const result = moveDirection(entity.s.angles);
    entity.s.angles = result.angles; entity.movedir = result.direction;
  }
  private doorTouch(entity: GameEntity, other: GameEntity): void {
    const parent = this.parent(entity);
    if (other.client !== null && other.client.sess.sessionTeam === Team.TEAM_SPECTATOR) {
      if (parent.moverState === MoverState.ONE_TO_TWO || parent.moverState === MoverState.POS2) return;
      const axis = entity.count, bounds = this.bounds(entity);
      const min = component(bounds.min, axis), max = component(bounds.max, axis), position = component(other.s.origin, axis);
      const towardMin = Math.abs(f32(position - max)) < Math.abs(f32(position - min));
      const direction = withComponent(vec3(0, 0, 0), axis, towardMin ? -1 : 1);
      const center = scale3(add3(bounds.min, bounds.max), 0.5);
      const origin = withComponent(center, axis, towardMin ? f32(min - 10) : f32(max + 10));
      teleportPlayer(this.core.host, other, origin, vectorToAngles(direction));
    } else if (parent.moverState !== MoverState.ONE_TO_TWO) this.core.useBinary(parent, entity, other);
  }
  private spawnDoorTrigger(entity: GameEntity): void {
    for (let part: GameEntity | null = entity; part !== null; part = part.teamchain) part.takedamage = true;
    let bounds = this.bounds(entity);
    for (let part = entity.teamchain; part !== null; part = part.teamchain) {
      const other = this.bounds(part);
      bounds = addPointToBounds(addPointToBounds(bounds, other.min), other.max);
    }
    const size = sub3(bounds.max, bounds.min);
    let axis = 0;
    for (let index = 1; index < 3; index++) if (component(size, index) < component(size, axis)) axis = index;
    const trigger = this.core.host.combat.entities.spawn(); trigger.classname = "door_trigger";
    trigger.r.mins = withComponent(bounds.min, axis, component(bounds.min, axis) - 120);
    trigger.r.maxs = withComponent(bounds.max, axis, component(bounds.max, axis) + 120);
    trigger.parent = entity; trigger.r.contents = CONTENTS_TRIGGER; trigger.count = axis;
    trigger.touch = this.doorTriggerTouch;
    this.core.host.world.link(trigger);
    this.core.matchTeam(entity, entity.moverState, this.time);
  }
  door(entity: GameEntity, variables: SpawnVariables): void {
    const config = this.core.host.config;
    entity.sound1to2 = entity.sound2to1 = config.soundIndex("sound/movers/doors/dr1_strt.wav");
    entity.soundPos1 = entity.soundPos2 = config.soundIndex("sound/movers/doors/dr1_end.wav");
    entity.blocked = (self, other) => { this.core.blockedDoor(self, other); };
    if (entity.speed === 0) entity.speed = 400;
    if (entity.wait === 0) entity.wait = 2;
    entity.wait = f32(entity.wait * 1000);
    const lip = variables.float("lip", "8").value; entity.damage = variables.int("dmg", "2").value;
    entity.pos1 = { ...entity.s.origin };
    this.host.setBrushModel(entity, entity.model); this.setDirection(entity);
    const absolute = vec3(Math.abs(entity.movedir.x), Math.abs(entity.movedir.y), Math.abs(entity.movedir.z));
    const distance = f32(dot3(absolute, sub3(entity.r.maxs, entity.r.mins)) - lip);
    entity.pos2 = add3(entity.pos1, scale3(entity.movedir, distance));
    if ((entity.spawnflags & 1) !== 0) { entity.pos1 = entity.pos2; entity.pos2 = { ...entity.s.origin }; }
    this.core.initializeBinary(entity, variables);
    entity.nextthink = (this.time + FRAMETIME) | 0;
    if ((entity.flags & GameFlags.TEAMSLAVE) === 0) {
      const health = variables.int("health", "0").value;
      if (health !== 0) entity.takedamage = true;
      entity.think = entity.targetname !== null || health !== 0
        ? self => { this.core.matchTeam(self, self.moverState, this.time); }
        : self => { this.spawnDoorTrigger(self); };
    }
  }
  private spawnPlatTrigger(entity: GameEntity): void {
    const trigger = this.core.host.combat.entities.spawn(); trigger.classname = "plat_trigger";
    trigger.touch = (self, other) => {
      const parent = this.parent(self);
      if (other.client !== null && parent.moverState === MoverState.POS1) this.core.useBinary(parent, self, other);
    };
    trigger.r.contents = CONTENTS_TRIGGER; trigger.parent = entity;
    let min = add3(add3(entity.pos1, entity.r.mins), vec3(33, 33, 0));
    let max = add3(add3(entity.pos1, entity.r.maxs), vec3(-33, -33, 8));
    for (const axis of [0, 1]) {
      if (component(max, axis) > component(min, axis)) continue;
      const center = f32(component(entity.pos1, axis) + f32(f32(component(entity.r.mins, axis) + component(entity.r.maxs, axis)) * 0.5));
      min = withComponent(min, axis, center); max = withComponent(max, axis, center + 1);
    }
    trigger.r.mins = min; trigger.r.maxs = max; this.core.host.world.link(trigger);
  }
  plat(entity: GameEntity, variables: SpawnVariables): void {
    const config = this.core.host.config;
    entity.sound1to2 = entity.sound2to1 = config.soundIndex("sound/movers/plats/pt1_strt.wav");
    entity.soundPos1 = entity.soundPos2 = config.soundIndex("sound/movers/plats/pt1_end.wav");
    entity.s.angles = vec3(0, 0, 0);
    entity.speed = variables.float("speed", "200").value; entity.damage = variables.int("dmg", "2").value;
    entity.wait = 1000;
    const lip = variables.float("lip", "8").value;
    this.host.setBrushModel(entity, entity.model);
    const height = variables.float("height", "0");
    const distance = height.present ? height.value : f32(f32(entity.r.maxs.z - entity.r.mins.z) - lip);
    entity.pos2 = { ...entity.s.origin }; entity.pos1 = vec3(entity.pos2.x, entity.pos2.y, entity.pos2.z - distance);
    this.core.initializeBinary(entity, variables);
    entity.touch = (self, other) => {
      if (other.client !== null && other.client.ps.health > 0 && self.moverState === MoverState.POS2) self.nextthink = (this.time + 1000) | 0;
    };
    entity.blocked = (self, other) => { this.core.blockedDoor(self, other); }; entity.parent = entity;
    if (entity.targetname === null) this.spawnPlatTrigger(entity);
  }
  button(entity: GameEntity, variables: SpawnVariables): void {
    entity.sound1to2 = this.core.host.config.soundIndex("sound/movers/switches/butn2.wav");
    if (entity.speed === 0) entity.speed = 40;
    if (entity.wait === 0) entity.wait = 1;
    entity.wait = f32(entity.wait * 1000); entity.pos1 = { ...entity.s.origin };
    this.host.setBrushModel(entity, entity.model); this.setDirection(entity);
    const absolute = vec3(Math.abs(entity.movedir.x), Math.abs(entity.movedir.y), Math.abs(entity.movedir.z));
    const distance = f32(dot3(absolute, sub3(entity.r.maxs, entity.r.mins)) - variables.float("lip", "4").value);
    entity.pos2 = add3(entity.pos1, scale3(entity.movedir, distance));
    if (entity.health !== 0) entity.takedamage = true;
    else entity.touch = (self, other) => {
      if (other.client !== null && self.moverState === MoverState.POS1) this.core.useBinary(self, other, other);
    };
    this.core.initializeBinary(entity, variables);
  }
  private reachedTrain(entity: GameEntity): void {
    const next = entity.nextTrain;
    if (next === null || next.nextTrain === null) return;
    useTargets({ pool: this.core.host.combat.entities, time: this.time,
      warn: message => { this.host.warn(message); },
      remapShader: (oldName, newName, time) => { this.host.remapShader(oldName, newName, time); } }, next, null);
    const destination = next.nextTrain;
    if (destination === null) throw new Error("Train path was removed during target dispatch");
    entity.nextTrain = destination; entity.pos1 = { ...next.s.origin }; entity.pos2 = { ...destination.s.origin };
    const speed = Math.max(1, next.speed !== 0 ? next.speed : entity.speed);
    const duration = floatInt(f32(f32(length3(sub3(entity.pos2, entity.pos1)) * 1000) / speed));
    entity.s.pos = { ...entity.s.pos, duration }; entity.s.loopSound = next.soundLoop;
    this.core.setState(entity, MoverState.ONE_TO_TWO, this.time);
    if (next.wait !== 0) {
      entity.nextthink = floatInt(f32(f32(this.time) + f32(next.wait * 1000)));
      entity.think = self => { self.s.pos = { ...self.s.pos, time: this.time, type: TrajectoryType.TR_LINEAR_STOP }; };
      entity.s.pos = { ...entity.s.pos, type: TrajectoryType.TR_STATIONARY };
    }
  }
  private setupTrain(entity: GameEntity): void {
    const pool = this.core.host.combat.entities;
    const start = findEntity(pool, null, "targetname", entity.target); entity.nextTrain = start;
    if (start === null) { this.host.warn(`func_train at ${pool.utilities.vtos(entity.r.absmin).readString()} with an unfound target\n`); return; }
    const visited = new Set<GameEntity>();
    let path = start;
    do {
      if (visited.has(path)) throw new Error("Train path cycle does not return to its first corner");
      visited.add(path);
      if (path.target === null) { this.host.warn(`Train corner at ${pool.utilities.vtos(path.s.origin).readString()} without a target\n`); return; }
      let next: GameEntity | null = null;
      do {
        next = findEntity(pool, next, "targetname", path.target);
        if (next === null) { this.host.warn(`Train corner at ${pool.utilities.vtos(path.s.origin).readString()} without a target path_corner\n`); return; }
      } while (next.classname !== "path_corner");
      path.nextTrain = next; path = next;
    } while (path !== start);
    this.reachedTrain(entity);
  }
  pathCorner(entity: GameEntity): void {
    if (entity.targetname !== null) return;
    this.host.warn(`path_corner with no targetname at ${this.core.host.combat.entities.utilities.vtos(entity.s.origin).readString()}\n`);
    this.core.host.combat.entities.free(entity);
  }
  train(entity: GameEntity, variables: SpawnVariables): void {
    entity.s.angles = vec3(0, 0, 0);
    if ((entity.spawnflags & 4) !== 0) entity.damage = 0; else if (entity.damage === 0) entity.damage = 2;
    if (entity.speed === 0) entity.speed = 100;
    if (entity.target === null) {
      this.host.warn(`func_train without a target at ${this.core.host.combat.entities.utilities.vtos(entity.r.absmin).readString()}\n`); this.core.host.combat.entities.free(entity); return;
    }
    this.host.setBrushModel(entity, entity.model); this.core.initializeBinary(entity, variables);
    entity.reached = self => { this.reachedTrain(self); };
    entity.nextthink = (this.time + FRAMETIME) | 0; entity.think = self => { this.setupTrain(self); };
  }
  static(entity: GameEntity, variables: SpawnVariables): void {
    this.host.setBrushModel(entity, entity.model); this.core.initializeBinary(entity, variables);
    entity.s.pos = { ...entity.s.pos, base: { ...entity.s.origin } }; entity.r.currentOrigin = { ...entity.s.origin };
  }
  rotating(entity: GameEntity, variables: SpawnVariables): void {
    if (entity.speed === 0) entity.speed = 100;
    const axis = (entity.spawnflags & 4) !== 0 ? 2 : (entity.spawnflags & 8) !== 0 ? 0 : 1;
    entity.s.apos = { ...entity.s.apos, type: TrajectoryType.TR_LINEAR, delta: withComponent(entity.s.apos.delta, axis, entity.speed) };
    if (entity.damage === 0) entity.damage = 2;
    this.host.setBrushModel(entity, entity.model); this.core.initializeBinary(entity, variables);
    entity.s.pos = { ...entity.s.pos, base: { ...entity.s.origin } }; entity.r.currentOrigin = { ...entity.s.pos.base };
    entity.r.currentAngles = { ...entity.s.apos.base }; this.core.host.world.link(entity);
  }
  bobbing(entity: GameEntity, variables: SpawnVariables): void {
    entity.speed = variables.float("speed", "4").value; entity.damage = variables.int("dmg", "2").value;
    const height = variables.float("height", "32").value, phase = variables.float("phase", "0").value;
    this.host.setBrushModel(entity, entity.model); this.core.initializeBinary(entity, variables);
    entity.r.currentOrigin = { ...entity.s.origin };
    const duration = floatInt(f32(entity.speed * 1000)), axis = (entity.spawnflags & 1) !== 0 ? 0 : (entity.spawnflags & 2) !== 0 ? 1 : 2;
    entity.s.pos = { ...entity.s.pos, base: { ...entity.s.origin }, duration, time: floatInt(f32(f32(duration) * phase)),
      type: TrajectoryType.TR_SINE, delta: withComponent(entity.s.pos.delta, axis, height) };
  }
  pendulum(entity: GameEntity, variables: SpawnVariables): void {
    const speed = variables.float("speed", "30").value, phase = variables.float("phase", "0").value;
    entity.damage = variables.int("dmg", "2").value; this.host.setBrushModel(entity, entity.model);
    const length = Math.max(8, Math.abs(entity.r.mins.z));
    const frequency = f32(f32(1 / f32(f32(Math.PI) * 2)) * f32(Math.sqrt(f32(this.host.gravity() / f32(3 * length)))));
    const duration = floatInt(f32(1000 / frequency)); entity.s.pos = { ...entity.s.pos, duration };
    this.core.initializeBinary(entity, variables);
    entity.s.pos = { ...entity.s.pos, base: { ...entity.s.origin } }; entity.r.currentOrigin = { ...entity.s.origin };
    entity.s.apos = { ...entity.s.apos, base: { ...entity.s.angles }, duration, time: floatInt(f32(f32(duration) * phase)),
      type: TrajectoryType.TR_SINE, delta: withComponent(entity.s.apos.delta, 2, speed) };
  }
  handler(method: SpawnHandler): SpawnHandler {
    return (entity, variables) => { this.owned(entity); method(entity, variables); };
  }
  handlers(): ReadonlyMap<string, SpawnHandler> {
    const runtime = this;
    return new Map<string, SpawnHandler>([
      ["func_door", runtime.handler((entity, variables) => { runtime.door(entity, variables); })],
      ["func_plat", runtime.handler((entity, variables) => { runtime.plat(entity, variables); })],
      ["func_button", runtime.handler((entity, variables) => { runtime.button(entity, variables); })],
      ["func_train", runtime.handler((entity, variables) => { runtime.train(entity, variables); })],
      ["path_corner", runtime.handler(entity => { runtime.pathCorner(entity); })],
      ["func_static", runtime.handler((entity, variables) => { runtime.static(entity, variables); })],
      ["func_rotating", runtime.handler((entity, variables) => { runtime.rotating(entity, variables); })],
      ["func_bobbing", runtime.handler((entity, variables) => { runtime.bobbing(entity, variables); })],
      ["func_pendulum", runtime.handler((entity, variables) => { runtime.pendulum(entity, variables); })],
    ]);
  }
}

export function createMoverSpawnHandlers(host: MoverSpawnHost): ReadonlyMap<string, SpawnHandler> {
  return new MoverSpawnRuntime(host).handlers();
}
