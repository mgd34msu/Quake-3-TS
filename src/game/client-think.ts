// Ported from id Software's code/game/g_active.c authoritative command path.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import { add3, sub3, vec3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import type { ServerWorld } from "../server/world.ts";
import { EntityType, MoveType, Powerup, Team, Weapon, statSchema } from "../shared/definitions.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { itemAt, playerTouchesItem } from "../shared/items.ts";
import { movePlayer } from "../shared/movement.ts";
import type { MovementDiagnostics } from "../shared/movement.ts";
import { CommandButtons, MoveFlags } from "../shared/player-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import type { MovementTrace } from "../shared/slide-move.ts";
import { playerStateToEntityState, playerStateToEntityStateExtraPolate } from "../shared/snapshot-state.ts";
import { clientTimerActions, sendPendingPredictableEvents } from "./client-effects.ts";
import type { ClientEffectsContext } from "./client-effects.ts";
import type { EntityPool } from "./entities.ts";
import { ConnectionState, GameFlags, MAX_CLIENTS, MAX_GENTITIES, SpectatorState } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";

const MASK_PLAYERSOLID = 1 | 0x10000 | 0x2000000;
const CONTENTS_BODY = 0x2000000;
const CONTENTS_BOTCLIP = 0x400000;
const CONTENTS_TRIGGER = 0x40000000;
const EF_FIRING = 0x100;
const REWARD_FLAGS = 0x8 | 0x40 | 0x800 | 0x8000 | 0x10000 | 0x20000;

export interface ClientThinkFrame {
  readonly time: number;
  readonly intermissionTime: number;
  readonly intermissionQueued: number;
}

export interface ClientThinkSettings {
  readonly debugMove: number;
  readonly synchronousClients: boolean;
  readonly pmoveFixed: boolean;
  readonly pmoveMsec: number;
  readonly gravity: number;
  readonly speed: number;
  readonly dmflags: number;
  readonly smoothClients: boolean;
  readonly forceRespawnSeconds: number;
  readonly singlePlayer: boolean;
}

/** Required external rules are supplied by their game modules, never default no-ops. */
export interface ClientThinkHost {
  readonly movementDiagnostics: MovementDiagnostics;
  readonly pool: EntityPool;
  readonly world: ServerWorld;
  readonly effects: Pick<ClientEffectsContext, "combat">;
  frame(): ClientThinkFrame;
  settings(): ClientThinkSettings;
  setPmoveMsec(milliseconds: number): void;
  intermissionThink(client: GameClient): void;
  spectatorThink(entity: GameEntity, command: UserCommand): void;
  checkInactivity(client: GameClient): boolean;
  freeHook(hook: GameEntity): void;
  checkGauntletAttack(entity: GameEntity): boolean;
  clientEvents(entity: GameEntity, oldEventSequence: number): void;
  respawn(entity: GameEntity): void;
  appendConsoleCommand(command: string): void;
  isDoorTrigger(entity: GameEntity): boolean;
  botTestAas(origin: Vec3): void;
}

function clientFor(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("ClientThink requires a game client");
  return entity.client;
}

function emptyTouchTrace(): MovementTrace {
  return { fraction: 0, end: vec3(0, 0, 0), solidity: "clear", contact: { kind: "none" },
    contents: 0, surfaceFlags: 0, entityNum: 0 };
}

function overlap(first: Bounds, second: Bounds): boolean {
  return first.min.x <= second.max.x && first.min.y <= second.max.y && first.min.z <= second.max.z &&
    first.max.x >= second.min.x && first.max.y >= second.min.y && first.max.z >= second.min.z;
}

export class ClientThinkRuntime {
  constructor(readonly host: ClientThinkHost) {}

  /** ClientThink receives a command now, but bots/synchronous clients move on G_RunClient. */
  clientThink(clientNum: number, command: UserCommand): void {
    const entity = this.host.pool.at(clientNum);
    const client = clientFor(entity);
    client.pers.cmd = { ...command, angles: { ...command.angles } };
    client.lastCmdTime = this.host.frame().time;
    if (!(entity.r.svFlags & ServerEntityFlags.BOT) && !this.host.settings().synchronousClients) this.clientThinkReal(entity);
  }

  runClient(entity: GameEntity): void {
    if (!(entity.r.svFlags & ServerEntityFlags.BOT) && !this.host.settings().synchronousClients) return;
    clientFor(entity).pers.cmd.serverTime = this.host.frame().time;
    this.clientThinkReal(entity);
  }

  clientImpacts(entity: GameEntity, contacts: readonly number[]): void {
    const trace = emptyTouchTrace();
    const seen = new Set<number>();
    for (const number of contacts) {
      if (seen.has(number)) continue;
      seen.add(number);
      const other = this.host.pool.at(number);
      if ((entity.r.svFlags & ServerEntityFlags.BOT) && entity.touch !== null) entity.touch(entity, other, trace);
      if (other.touch !== null) other.touch(other, entity, trace);
    }
  }

  touchTriggers(entity: GameEntity): void {
    const client = entity.client;
    if (client === null || client.ps.health <= 0) return;
    const ps = client.ps;
    const range = vec3(40, 40, 52);
    const touches = this.host.world.areaEntities({ min: sub3(ps.origin, range), max: add3(ps.origin, range) }, MAX_GENTITIES);
    const bounds = { min: add3(ps.origin, entity.r.mins), max: add3(ps.origin, entity.r.maxs) };
    for (const number of touches) {
      const hit = this.host.pool.at(number);
      if (hit.touch === null && entity.touch === null) continue;
      if (!(hit.r.contents & CONTENTS_TRIGGER)) continue;
      if (client.sess.sessionTeam === Team.TEAM_SPECTATOR && hit.s.eType !== EntityType.ET_TELEPORT_TRIGGER &&
        !this.host.isDoorTrigger(hit)) continue;
      if (hit.s.eType === EntityType.ET_ITEM) {
        if (!playerTouchesItem(ps.origin, hit.s.pos, this.host.frame().time)) continue;
      } else if (!this.host.world.entityContact(bounds, hit)) continue;
      const trace = emptyTouchTrace();
      if (hit.touch !== null) hit.touch(hit, entity, trace);
      if ((entity.r.svFlags & ServerEntityFlags.BOT) && entity.touch !== null) entity.touch(entity, hit, trace);
    }
    if (ps.jumppadFrame !== ps.pmoveFramecount) { ps.jumppadFrame = 0; ps.jumppadEnt = 0; }
  }

  private stuckInOtherClient(entity: GameEntity): boolean {
    const sourceZeroBounds: Bounds = { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
    // Source absmin/absmax are memset-zero before an entity has ever been linked.
    const bounds = this.host.world.linkState(entity.slot)?.absbounds ?? sourceZeroBounds;
    for (let index = 0; index < MAX_CLIENTS; index++) {
      const other = this.host.pool.at(index);
      if (other === entity || !other.inuse || other.client === null || other.health <= 0) continue;
      if (overlap(bounds, this.host.world.linkState(index)?.absbounds ?? sourceZeroBounds)) return true;
    }
    return false;
  }

  clientThinkReal(entity: GameEntity): void {
    const client = clientFor(entity);
    if (client.pers.connected !== ConnectionState.CONNECTED) return;
    const frame = this.host.frame();
    const settings = { ...this.host.settings() };
    const command = client.pers.cmd;
    if (command.serverTime > ((frame.time + 200) | 0)) command.serverTime = (frame.time + 200) | 0;
    if (command.serverTime < ((frame.time - 1000) | 0)) command.serverTime = (frame.time - 1000) | 0;
    let msec = (command.serverTime - client.ps.commandTime) | 0;
    if (msec < 1 && client.sess.spectatorState !== SpectatorState.FOLLOW) return;
    if (msec > 200) msec = 200;
    if (settings.pmoveMsec < 8) this.host.setPmoveMsec(8);
    else if (settings.pmoveMsec > 33) this.host.setPmoveMsec(33);
    const fixed = settings.pmoveFixed || client.pers.pmoveFixed;
    // trap_Cvar_Set does not refresh the cached vmCvar value in this invocation.
    if (fixed) {
      if (!Number.isInteger(settings.pmoveMsec) || settings.pmoveMsec <= 0) throw new RangeError("Fixed pmove needs a positive cached pmove_msec");
      command.serverTime = Math.imul(Math.trunc(((command.serverTime + settings.pmoveMsec - 1) | 0) / settings.pmoveMsec), settings.pmoveMsec);
    }
    if (frame.intermissionTime !== 0) { this.host.intermissionThink(client); return; }
    if (client.sess.sessionTeam === Team.TEAM_SPECTATOR) {
      if (client.sess.spectatorState !== SpectatorState.SCOREBOARD) this.host.spectatorThink(entity, command);
      return;
    }
    if (!this.host.checkInactivity(client)) return;
    const ps = client.ps;
    if (frame.time > client.rewardTime) ps.eFlags &= ~REWARD_FLAGS;
    ps.pmType = client.noclip ? MoveType.PM_NOCLIP : ps.health <= 0 ? MoveType.PM_DEAD : MoveType.PM_NORMAL;
    ps.gravity = Math.trunc(Math.fround(settings.gravity)) | 0;
    ps.speed = Math.trunc(Math.fround(settings.speed)) | 0;
    const schema = statSchema(ps.product);
    if (schema.product === "missionpack" && itemAt(ps.product, ps.stats.get(schema.persistentPowerup)).tag === Powerup.PW_SCOUT) {
      ps.speed = Math.trunc(Math.fround(Math.fround(ps.speed) * Math.fround(1.5))) | 0;
    } else if (ps.powerups.get(Powerup.PW_HASTE)) ps.speed = Math.trunc(Math.fround(Math.fround(ps.speed) * Math.fround(1.3))) | 0;
    if (ps.weapon === Weapon.WP_GRAPPLING_HOOK && client.hook !== null && !(command.buttons & CommandButtons.ATTACK)) {
      this.host.freeHook(client.hook);
    }
    const oldEventSequence = ps.eventSequence;
    const gauntletHit = ps.weapon === Weapon.WP_GAUNTLET && !(command.buttons & CommandButtons.TALK) &&
      (command.buttons & CommandButtons.ATTACK) !== 0 && ps.weaponTime <= 0 ? this.host.checkGauntletAttack(entity) : false;
    if (entity.flags & GameFlags.FORCE_GESTURE) {
      entity.flags &= ~GameFlags.FORCE_GESTURE;
      command.buttons |= CommandButtons.GESTURE;
    }
    if (ps.product === "missionpack" && ps.powerups.get(Powerup.PW_INVULNERABILITY) && !(ps.pmFlags & MoveFlags.INVULEXPAND)) {
      const oldMins = entity.r.mins;
      const oldMaxs = entity.r.maxs;
      entity.r.mins = vec3(-42, -42, -42);
      entity.r.maxs = vec3(42, 42, 42);
      this.host.world.link(entity);
      if (!this.stuckInOtherClient(entity)) ps.pmFlags |= MoveFlags.INVULEXPAND;
      entity.r.mins = oldMins;
      entity.r.maxs = oldMaxs;
      this.host.world.link(entity);
    }
    const traceMask = ps.pmType === MoveType.PM_DEAD ? MASK_PLAYERSOLID & ~CONTENTS_BODY :
      entity.r.svFlags & ServerEntityFlags.BOT ? MASK_PLAYERSOLID | CONTENTS_BOTCLIP : MASK_PLAYERSOLID;
    client.oldOrigin = { ...ps.origin };
    const movementCommand: UserCommand = { ...command, angles: { ...command.angles } };
    if (ps.product === "missionpack" && frame.intermissionQueued !== 0 && settings.singlePlayer) {
      const elapsed = (frame.time - frame.intermissionQueued) | 0;
      if (elapsed >= 1000) {
        movementCommand.buttons = 0;
        movementCommand.forwardmove = 0;
        movementCommand.rightmove = 0;
        movementCommand.upmove = 0;
        if (elapsed >= 2000 && elapsed <= 2500) this.host.appendConsoleCommand("centerview\n");
        ps.pmType = MoveType.PM_SPINTERMISSION;
      }
    }
    const movement = movePlayer(ps, movementCommand, {
      diagnostics: { state: this.host.movementDiagnostics, level: settings.debugMove },
      trace: (start, end, bounds, passEntityNum, mask) => this.host.world.trace({ start, end,
        shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, passEntityNum, mask }),
      pointContents: (point, passEntityNum) => this.host.world.pointContents(point, passEntityNum),
      traceMask, fixedMsec: fixed ? settings.pmoveMsec : null, gauntletHit,
      noFootsteps: (settings.dmflags & 32) !== 0,
    });
    if (ps.eventSequence !== oldEventSequence) entity.eventTime = frame.time;
    if (settings.smoothClients) playerStateToEntityStateExtraPolate(ps, entity.s, ps.commandTime, true);
    else playerStateToEntityState(ps, entity.s, true);
    sendPendingPredictableEvents(this.host.effects, ps);
    if (!(ps.eFlags & EF_FIRING)) client.fireHeld = false;
    entity.r.currentOrigin = { ...entity.s.pos.base };
    entity.r.mins = { ...movement.bounds.min };
    entity.r.maxs = { ...movement.bounds.max };
    entity.waterlevel = movement.waterlevel;
    entity.watertype = movement.watertype;
    this.host.clientEvents(entity, oldEventSequence);
    this.host.world.link(entity);
    if (!client.noclip) this.touchTriggers(entity);
    entity.r.currentOrigin = { ...ps.origin };
    this.host.botTestAas(entity.r.currentOrigin);
    this.clientImpacts(entity, movement.contacts);
    if (ps.eventSequence !== oldEventSequence) entity.eventTime = frame.time;
    client.oldButtons = client.buttons;
    client.buttons = command.buttons;
    client.latchedButtons |= client.buttons & ~client.oldButtons;
    if (ps.health <= 0) {
      if (frame.time > client.respawnTime) {
        if (settings.forceRespawnSeconds > 0 && ((frame.time - client.respawnTime) | 0) > Math.imul(settings.forceRespawnSeconds, 1000)) {
          this.host.respawn(entity);
          return;
        }
        if (command.buttons & (CommandButtons.ATTACK | CommandButtons.USE_HOLDABLE)) this.host.respawn(entity);
      }
      return;
    }
    clientTimerActions(this.host.effects, entity, msec);
  }
}
