// Client prediction from id Software's code/cgame/cg_predict.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { createBoxModel } from "../collision/model.ts";
import type { CollisionWorld, TraceQuery } from "../collision/world.ts";
import { add3, length3, scale3, sub3, vec3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import { EntityEvent, EntityType, GameType, ItemType, MoveType, PersistentIndex, Powerup, Team, Weapon, statSchema } from "../shared/definitions.ts";
import { canItemBeGrabbed, itemAt, playerTouchesItem } from "../shared/items.ts";
import type { PlayerInventory } from "../shared/items.ts";
import { touchJumpPad } from "../shared/jump-pad.ts";
import { movePlayer, updateViewAngles } from "../shared/movement.ts";
import type { MovementTrace } from "../shared/movement.ts";
import { ENTITYNUM_NONE, ENTITYNUM_WORLD, MoveFlags } from "../shared/player-state.ts";
import type { PredictableEventDebug, SourcePlayerState, UserCommand } from "../shared/player-state.ts";
import { evaluateTrajectory } from "../shared/trajectory.ts";
import { adjustPositionForMover } from "./entities.ts";
import type { ClientEntity, ClientGameState } from "./state.ts";

const f32 = Math.fround;
const SOLID_BMODEL = 0xffffff;
const CONTENTS_BODY = 0x2000000;
const MASK_PLAYERSOLID = 1 | 0x10000 | CONTENTS_BODY;

function emptyCommand(): UserCommand {
  return { serverTime: 0, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_NONE, forwardmove: 0, rightmove: 0, upmove: 0 };
}
function copyCommand(command: UserCommand): UserCommand { return { ...command, angles: { ...command.angles } }; }

export interface CommandSource {
  readonly currentNumber: number;
  read(number: number): UserCommand | null;
}

/** CL_GetUserCmd's zero-initialized, owned CMD_BACKUP ring survives map_restart. */
export class ClientCommandHistory implements CommandSource {
  private readonly commands = Array.from({ length: 64 }, emptyCommand);
  private number = 0;
  get currentNumber(): number { return this.number; }
  append(command: UserCommand): number {
    this.number = (this.number + 1) | 0;
    this.commands[this.number & 63] = copyCommand(command);
    return this.number;
  }
  read(number: number): UserCommand | null {
    if (!Number.isInteger(number)) throw new RangeError("Invalid user command number");
    if (number > this.number) throw new Error(`CL_GetUserCmd: ${number} >= ${this.number}`);
    if (number <= ((this.number - 64) | 0)) return null;
    const command = this.commands[number & 63];
    if (command === undefined) throw new Error("Missing command ring slot");
    return copyCommand(command);
  }
}

export interface PredictionSettings {
  readonly gameType: GameType;
  readonly dmFlags: number;
  readonly demoPlayback: boolean;
  readonly noPredict: boolean;
  readonly synchronousClients: boolean;
  readonly predictItems: boolean;
  readonly pmoveFixed: boolean;
  readonly pmoveMsec: number;
  readonly errorDecayInteger: number;
  readonly errorDecayValue: number;
  readonly showMiss: number;
}
export interface PredictionHost {
  readonly eventDebug?: PredictableEventDebug;
  readonly commands: CommandSource;
  settings(): PredictionSettings;
  setPmoveMsec(value: number): void;
  transitionPlayerState(current: SourcePlayerState, previous: SourcePlayerState): Promise<void>;
  warn(message: string): void;
}

function inventory(ps: SourcePlayerState): PlayerInventory {
  const team = ps.persistant.get(PersistentIndex.PERS_TEAM);
  const schema = statSchema(ps.product);
  const common = { health: ps.health, armor: ps.stats.get(schema.armor), maxHealth: ps.stats.get(schema.maxHealth),
    holdableItem: ps.stats.get(schema.holdableItem), team,
    ammo: (weapon: Weapon) => ps.ammo.get(weapon), powerup: (powerup: Powerup) => ps.powerups.get(powerup) };
  if (ps.product === "baseq3") return { ...common, product: "baseq3" };
  if (schema.product !== "missionpack") throw new Error("Missionpack prediction requires its stat schema");
  return { ...common, product: "missionpack", persistentPowerupIndex: ps.stats.get(schema.persistentPowerup) };
}

function interpolateVector(a: Vec3, b: Vec3, fraction: number): Vec3 {
  return vec3(f32(a.x + f32(fraction * f32(b.x - a.x))), f32(a.y + f32(fraction * f32(b.y - a.y))),
    f32(a.z + f32(fraction * f32(b.z - a.z))));
}
function lerpAngle(from: number, to: number, fraction: number): number {
  if (f32(to - from) > 180) to = f32(to - 360);
  if (f32(to - from) < -180) to = f32(to + 360);
  return f32(from + f32(fraction * f32(to - from)));
}

export class PredictionRuntime {
  private command = emptyCommand();
  constructor(readonly state: ClientGameState, readonly collision: CollisionWorld, readonly host: PredictionHost) {}

  trace(start: Vec3, end: Vec3, bounds: Bounds, skipNumber: number, mask: number): MovementTrace {
    const query: TraceQuery = { start, end, shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, mask };
    const worldTrace = this.collision.trace(query);
    let result: MovementTrace = { ...worldTrace, entityNum: worldTrace.fraction !== 1 ? ENTITYNUM_WORLD : ENTITYNUM_NONE };
    for (const cent of this.state.solidEntities) {
      const entity = cent.currentState;
      if (entity.number === skipNumber) continue;
      const x = entity.solid & 255, zd = (entity.solid >> 8) & 255, zu = ((entity.solid >> 16) & 255) - 32;
      const trace = entity.solid === SOLID_BMODEL
        ? this.collision.transformedTrace({ ...query, modelIndex: entity.modelindex }, evaluateTrajectory(entity.pos, this.state.physicsTime), cent.lerpAngles)
        : createBoxModel({ min: vec3(-x, -x, -zd), max: vec3(x, x, zu) }, this.collision.counters).transformedTrace(query, cent.lerpOrigin, vec3(0, 0, 0));
      if (trace.solidity === "all-solid" || trace.fraction < result.fraction) result = { ...trace, entityNum: entity.number };
      else if (trace.solidity !== "clear" && result.solidity !== "all-solid") result = { ...result, solidity: "start-solid" };
      if (result.solidity === "all-solid") return result;
    }
    return result;
  }

  pointContents(point: Vec3, passEntity: number): number {
    let contents = this.collision.pointContents(point);
    for (const cent of this.state.solidEntities) {
      const entity = cent.currentState;
      if (entity.number === passEntity || entity.solid !== SOLID_BMODEL || entity.modelindex === 0) continue;
      contents |= this.collision.transformedPointContents(point, entity.modelindex, entity.origin, entity.angles);
    }
    return contents;
  }

  interpolatePlayerState(grabAngles: boolean): void {
    const previous = this.state.snap;
    if (previous === null) throw new Error("CG_InterpolatePlayerState requires cg.snap");
    const out = previous.playerState.copy();
    this.state.predictedPlayerState = out;
    if (grabAngles) updateViewAngles(out, this.requiredCommand(this.host.commands.currentNumber));
    const next = this.state.nextSnap;
    if (this.state.nextFrameTeleport || next === null || next.serverTime <= previous.serverTime) return;
    const fraction = f32(f32((this.state.time - previous.serverTime) | 0) / f32((next.serverTime - previous.serverTime) | 0));
    const a = previous.playerState, b = next.playerState;
    const cycle = b.bobCycle < a.bobCycle ? (b.bobCycle + 256) | 0 : b.bobCycle;
    out.bobCycle = qvmFloatToInt(f32(f32(a.bobCycle) + f32(fraction * f32((cycle - a.bobCycle) | 0))));
    out.origin = interpolateVector(a.origin, b.origin, fraction);
    out.velocity = interpolateVector(a.velocity, b.velocity, fraction);
    if (!grabAngles) out.viewangles = vec3(lerpAngle(a.viewangles.x, b.viewangles.x, fraction),
      lerpAngle(a.viewangles.y, b.viewangles.y, fraction), lerpAngle(a.viewangles.z, b.viewangles.z, fraction));
  }

  touchItem(cent: ClientEntity, settings: PredictionSettings): void {
    const ps = this.state.predictedPlayerState, entity = cent.currentState;
    if (!settings.predictItems || !playerTouchesItem(ps.origin, entity.pos, this.state.time) || cent.miscTime === this.state.time) return;
    if (!canItemBeGrabbed(settings.gameType, { modelIndex: entity.modelindex, modelIndex2: entity.modelindex2, generic1: entity.generic1 }, inventory(ps))) return;
    const item = itemAt(this.state.product, entity.modelindex);
    if (this.state.product === "missionpack" && settings.gameType === GameType.GT_1FCTF && item.tag !== Powerup.PW_NEUTRALFLAG) return;
    if (settings.gameType === GameType.GT_CTF || (this.state.product === "missionpack" && settings.gameType === GameType.GT_HARVESTER)) {
      const team = ps.persistant.get(PersistentIndex.PERS_TEAM);
      if ((team === Team.TEAM_RED && item.tag === Powerup.PW_REDFLAG) || (team === Team.TEAM_BLUE && item.tag === Powerup.PW_BLUEFLAG)) return;
    }
    ps.addEvent(EntityEvent.EV_ITEM_PICKUP, entity.modelindex);
    entity.eFlags |= 0x80;
    cent.miscTime = this.state.time;
    if (item.type === ItemType.IT_WEAPON) {
      const slot = statSchema(ps.product).weapons;
      ps.stats.set(slot, ps.stats.get(slot) | (1 << item.tag));
      if (ps.ammo.get(item.tag) === 0) ps.ammo.set(item.tag, 1);
    }
  }

  touchTriggerPrediction(bounds: Bounds, settings: PredictionSettings): void {
    const ps = this.state.predictedPlayerState;
    if (ps.health <= 0) return;
    const spectator = ps.pmType === MoveType.PM_SPECTATOR;
    if (ps.pmType !== MoveType.PM_NORMAL && !spectator) return;
    for (const cent of this.state.triggerEntities) {
      const entity = cent.currentState;
      if (entity.eType === EntityType.ET_ITEM && !spectator) { this.touchItem(cent, settings); continue; }
      if (entity.solid !== SOLID_BMODEL || entity.modelindex === 0) continue;
      const trace = this.collision.trace({ start: ps.origin, end: ps.origin,
        shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, modelIndex: entity.modelindex, mask: -1 });
      if (trace.solidity === "clear") continue;
      if (entity.eType === EntityType.ET_TELEPORT_TRIGGER) this.state.hyperspace = true;
      else if (entity.eType === EntityType.ET_PUSH_TRIGGER) touchJumpPad(ps, entity);
    }
    if (ps.jumppadFrame !== ps.pmoveFramecount) { ps.jumppadFrame = 0; ps.jumppadEnt = 0; }
  }

  private requiredCommand(number: number): UserCommand {
    const command = this.host.commands.read(number);
    if (command === null) throw new Error("Prediction command source violated its CMD_BACKUP window");
    return command;
  }

  async predictPlayerState(): Promise<void> {
    const state = this.state, snapshot = state.snap, settings = this.host.settings();
    if (snapshot === null) throw new Error("CG_PredictPlayerState requires cg.snap");
    state.hyperspace = false;
    if (!state.validPPS) { state.validPPS = true; state.predictedPlayerState = snapshot.playerState.copy(); }
    if (settings.demoPlayback || (snapshot.playerState.pmFlags & MoveFlags.FOLLOW) !== 0) { this.interpolatePlayerState(false); return; }
    if (settings.noPredict || settings.synchronousClients) { this.interpolatePlayerState(true); return; }
    let mask = MASK_PLAYERSOLID;
    if (state.predictedPlayerState.pmType === MoveType.PM_DEAD || snapshot.playerState.persistant.get(PersistentIndex.PERS_TEAM) === Team.TEAM_SPECTATOR) mask &= ~CONTENTS_BODY;
    const old = state.predictedPlayerState.copy(), current = this.host.commands.currentNumber;
    const oldest = this.requiredCommand((current - 63) | 0);
    if (oldest.serverTime > snapshot.playerState.commandTime && oldest.serverTime < state.time) {
      if (settings.showMiss !== 0) this.host.warn("exceeded PACKET_BACKUP on commands\n");
      return;
    }
    const latest = this.requiredCommand(current);
    const selected = state.nextSnap !== null && !state.nextFrameTeleport && !state.thisFrameTeleport ? state.nextSnap : snapshot;
    state.predictedPlayerState = selected.playerState.copy();
    state.predictedPlayerState.setEventDebug(this.host.eventDebug ?? null);
    state.physicsTime = selected.serverTime;
    const ps = state.predictedPlayerState;
    if (settings.pmoveMsec < 8) this.host.setPmoveMsec(8);
    else if (settings.pmoveMsec > 33) this.host.setPmoveMsec(33);
    let moved = false;
    for (let number = (current - 63) | 0; number <= current; number++) {
      const command = this.host.commands.read(number);
      if (command !== null) this.command = copyCommand(command);
      if (settings.pmoveFixed) updateViewAngles(ps, this.command);
      if (this.command.serverTime <= ps.commandTime || this.command.serverTime > latest.serverTime) continue;
      if (ps.commandTime === old.commandTime) {
        if (state.thisFrameTeleport) {
          state.predictedError = vec3(0, 0, 0);
          if (settings.showMiss !== 0) this.host.warn("PredictionTeleport\n");
          state.thisFrameTeleport = false;
        } else {
          const adjusted = adjustPositionForMover(state, ps.origin, ps.groundEntityNum, state.physicsTime, state.oldTime);
          const delta = sub3(old.origin, adjusted), length = f32(length3(delta));
          if (settings.showMiss !== 0 && (old.origin.x !== adjusted.x || old.origin.y !== adjusted.y || old.origin.z !== adjusted.z)) this.host.warn("prediction error\n");
          if (length > f32(0.1)) {
            if (settings.showMiss !== 0) this.host.warn(`Prediction miss: ${length.toFixed(6)}\n`);
            if (settings.errorDecayInteger !== 0) {
              const elapsed = (state.time - state.predictedErrorTime) | 0;
              let fraction = f32(f32(f32(settings.errorDecayValue) - f32(elapsed)) / f32(settings.errorDecayValue));
              if (fraction < 0) fraction = 0;
              if (fraction > 0 && settings.showMiss !== 0) this.host.warn(`Double prediction decay: ${fraction.toFixed(6)}\n`);
              state.predictedError = scale3(state.predictedError, fraction);
            } else state.predictedError = vec3(0, 0, 0);
            state.predictedError = add3(delta, state.predictedError);
            state.predictedErrorTime = state.oldTime;
          }
        }
      }
      if (settings.pmoveFixed) this.command.serverTime = Math.imul(Math.trunc(((this.command.serverTime + settings.pmoveMsec - 1) | 0) / settings.pmoveMsec), settings.pmoveMsec);
      const result = movePlayer(ps, this.command, { trace: (start, end, bounds, skip, contents) => this.trace(start, end, bounds, skip, contents),
        pointContents: (point, pass) => this.pointContents(point, pass), traceMask: mask, fixedMsec: settings.pmoveFixed ? settings.pmoveMsec : null,
        noFootsteps: (settings.dmFlags & 32) !== 0, gauntletHit: false });
      moved = true;
      this.touchTriggerPrediction(result.bounds, settings);
    }
    if (settings.showMiss > 1) this.host.warn(`[${this.command.serverTime} : ${state.time}] `);
    if (!moved) { if (settings.showMiss !== 0) this.host.warn("not moved\n"); return; }
    ps.origin = adjustPositionForMover(state, ps.origin, ps.groundEntityNum, state.physicsTime, state.time);
    if (settings.showMiss !== 0 && ps.eventSequence > ((old.eventSequence + 2) | 0)) this.host.warn("WARNING: dropped event\n");
    await this.host.transitionPlayerState(ps, old);
    if (settings.showMiss !== 0 && state.eventSequence > ps.eventSequence) {
      this.host.warn("WARNING: double event\n");
      state.eventSequence = ps.eventSequence;
    }
  }
}

export function buildSolidList(state: ClientGameState): void {
  state.solidEntities.length = 0;
  state.triggerEntities.length = 0;
  const snapshot = state.nextSnap !== null && !state.nextFrameTeleport && !state.thisFrameTeleport ? state.nextSnap : state.snap;
  if (snapshot === null) throw new Error("CG_BuildSolidList requires a snapshot");
  for (const entry of snapshot.entities) {
    const entity = state.entityAt(entry.number);
    const type = entity.currentState.eType;
    if (type === EntityType.ET_ITEM || type === EntityType.ET_PUSH_TRIGGER || type === EntityType.ET_TELEPORT_TRIGGER) {
      state.triggerEntities.push(entity);
    } else if (entity.nextState.solid !== 0) state.solidEntities.push(entity);
  }
}
