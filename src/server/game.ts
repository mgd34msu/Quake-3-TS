// Typed server calls and shared data from id Software's server/sv_game.c and game/g_public.h.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CallSteps } from "../core/call-steps.ts";
import type { GameRuntime } from "../game/runtime.ts";
import type { Product } from "../shared/definitions.ts";
import type { SharedEntity } from "../shared/entity-shared.ts";
import type { SourcePlayerState, UserCommand } from "../shared/player-state.ts";

export interface ServerGameData {
  readonly numEntities: number;
  entity(number: number): SharedEntity;
  copyPlayerState(client: number): SourcePlayerState;
  setPlayerPing(client: number, ping: number): void;
}

export type ServerGameDenial = string | (() => string);

export interface ServerGameCalls {
  clientConnect(client: number, firstTime: boolean, isBot: boolean): CallSteps<ServerGameDenial | null>;
  clientBegin(client: number): CallSteps;
  clientDisconnect(client: number): CallSteps;
  clientUserinfoChanged(client: number): CallSteps;
  clientCommand(client: number, argv: readonly string[]): CallSteps;
  clientThink(client: number, command: UserCommand): CallSteps;
  runFrame(time: number): CallSteps;
  botFrame(time: number): CallSteps;
  consoleCommand(argv: readonly string[]): CallSteps<boolean>;
  shutdown(restart: boolean): CallSteps;
}

export interface ServerGame {
  readonly product: Product;
  readonly data: ServerGameData;
  readonly calls: ServerGameCalls;
  disposeResources(): void;
}

/** The published runtime retains its identity and runs every direct call synchronously. */
export function directGameCalls(runtime: Pick<GameRuntime, keyof ServerGameCalls>): ServerGameCalls {
  return {
    *clientConnect(client, firstTime, isBot): CallSteps<string | null> { return runtime.clientConnect(client, firstTime, isBot); },
    *clientBegin(client): CallSteps { runtime.clientBegin(client); },
    *clientDisconnect(client): CallSteps { runtime.clientDisconnect(client); },
    *clientUserinfoChanged(client): CallSteps { runtime.clientUserinfoChanged(client); },
    *clientCommand(client, argv): CallSteps { runtime.clientCommand(client, argv); },
    *clientThink(client, command): CallSteps { runtime.clientThink(client, command); },
    *runFrame(time): CallSteps { runtime.runFrame(time); },
    *botFrame(time): CallSteps { runtime.botFrame(time); },
    *consoleCommand(argv): CallSteps<boolean> { return runtime.consoleCommand(argv); },
    *shutdown(restart): CallSteps { runtime.shutdown(restart); },
  };
}
