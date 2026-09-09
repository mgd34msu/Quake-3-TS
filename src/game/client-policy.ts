// Ported from id Software's code/game/g_active.c: SpectatorThink,
// SpectatorClientEndFrame, ClientInactivityTimer and ClientIntermissionThink.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.

import type { ServerWorld } from "../server/world.ts";
import { MoveType, Team } from "../shared/definitions.ts";
import { movePlayer } from "../shared/movement.ts";
import type { MovementDiagnostics } from "../shared/movement.ts";
import { CommandButtons, MoveFlags } from "../shared/player-state.ts";
import type { UserCommand } from "../shared/player-state.ts";
import type { EntityPool } from "./entities.ts";
import { ConnectionState, SpectatorState } from "./state.ts";
import type { GameClient, GameEntity } from "./state.ts";

export interface ClientPolicyContext {
  readonly movementDiagnostics: MovementDiagnostics;
  readonly pool: EntityPool;
  readonly world: ServerWorld;
  readonly time: number;
  readonly inactivitySeconds: number;
  readonly follow1: number;
  readonly follow2: number;
  touchTriggers(entity: GameEntity): void;
  followCycle(entity: GameEntity, direction: 1 | -1): void;
  clientBegin(clientNum: number): void;
  dropClient(clientNum: number, reason: string): void;
  sendServerCommand(clientNum: number, text: string): void;
}

const MASK_SPECTATOR = 1 | 0x10000;
const VOTE_FLAGS = 0x4000 | 0x80000;
const EF_TALK = 0x1000;
const EF_FIRING = 0x100;

function clientOf(entity: GameEntity): GameClient {
  if (entity.client === null) throw new Error("Client policy requires a client entity");
  return entity.client;
}

function clientNumber(context: ClientPolicyContext, client: GameClient): number {
  const number = context.pool.clients.indexOf(client);
  if (number === -1) throw new Error("Client policy received a client outside its entity pool");
  return number;
}

export function spectatorThink(context: ClientPolicyContext, entity: GameEntity, command: UserCommand): void {
  const client = clientOf(entity);
  if (client.sess.spectatorState !== SpectatorState.FOLLOW) {
    client.ps.pmType = MoveType.PM_SPECTATOR;
    client.ps.speed = 400;
    const movementCommand: UserCommand = { ...command, angles: { ...command.angles } };
    movePlayer(client.ps, movementCommand, {
      diagnostics: { state: context.movementDiagnostics, level: 0 },
      trace: (start, end, bounds, passEntityNum, mask) => context.world.trace({ start, end,
        shape: { kind: "box", mins: bounds.min, maxs: bounds.max }, passEntityNum, mask }),
      pointContents: (point, passEntityNum) => context.world.pointContents(point, passEntityNum),
      traceMask: MASK_SPECTATOR, fixedMsec: null, noFootsteps: false, gauntletHit: false,
    });
    entity.s.origin = { ...client.ps.origin };
    context.touchTriggers(entity);
    context.world.unlink(entity.s.number);
  }
  client.oldButtons = client.buttons;
  client.buttons = command.buttons;
  if ((client.buttons & CommandButtons.ATTACK) !== 0 && (client.oldButtons & CommandButtons.ATTACK) === 0) {
    context.followCycle(entity, 1);
  }
}

export function spectatorClientEndFrame(context: ClientPolicyContext, entity: GameEntity): void {
  const client = clientOf(entity);
  if (client.sess.spectatorState === SpectatorState.FOLLOW) {
    let number = client.sess.spectatorClient;
    if (number === -1) number = context.follow1;
    else if (number === -2) number = context.follow2;
    if (number >= 0) {
      const followed = context.pool.clientAt(number);
      if (followed.pers.connected === ConnectionState.CONNECTED && followed.sess.sessionTeam !== Team.TEAM_SPECTATOR) {
        const flags = (followed.ps.eFlags & ~VOTE_FLAGS) | (client.ps.eFlags & VOTE_FLAGS);
        client.ps.copyFrom(followed.ps);
        client.ps.pmFlags |= MoveFlags.FOLLOW;
        client.ps.eFlags = flags;
        return;
      }
      if (client.sess.spectatorClient >= 0) {
        client.sess.spectatorState = SpectatorState.FREE;
        context.clientBegin(clientNumber(context, client));
      }
    }
  }
  const current = clientOf(entity);
  if (current.sess.spectatorState === SpectatorState.SCOREBOARD) current.ps.pmFlags |= MoveFlags.SCOREBOARD;
  else current.ps.pmFlags &= ~MoveFlags.SCOREBOARD;
}

export function clientInactivityTimer(context: ClientPolicyContext, client: GameClient): boolean {
  const command = client.pers.cmd;
  if (context.inactivitySeconds === 0) {
    client.inactivityTime = (context.time + 60000) | 0;
    client.inactivityWarning = false;
  } else if (command.forwardmove !== 0 || command.rightmove !== 0 || command.upmove !== 0 ||
    (command.buttons & CommandButtons.ATTACK) !== 0) {
    client.inactivityTime = (context.time + Math.imul(context.inactivitySeconds, 1000)) | 0;
    client.inactivityWarning = false;
  } else if (!client.pers.localClient) {
    if (context.time > client.inactivityTime) {
      context.dropClient(clientNumber(context, client), "Dropped due to inactivity");
      return false;
    }
    if (context.time > ((client.inactivityTime - 10000) | 0) && !client.inactivityWarning) {
      client.inactivityWarning = true;
      context.sendServerCommand(clientNumber(context, client), "cp \"Ten seconds until inactivity drop!\n\"");
    }
  }
  return true;
}

export function clientIntermissionThink(client: GameClient): void {
  client.ps.eFlags &= ~(EF_TALK | EF_FIRING);
  client.oldButtons = client.buttons;
  client.buttons = client.pers.cmd.buttons;
  if ((client.buttons & (CommandButtons.ATTACK | CommandButtons.USE_HOLDABLE) & (client.oldButtons ^ client.buttons)) !== 0) {
    client.readyToExit = true;
  }
}
