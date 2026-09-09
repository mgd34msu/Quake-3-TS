// Port of id Software's SV_SetConfigstring/SV_GetConfigstring and SV_AddServerCommand.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { ConfigStringStore } from "../game/utilities.ts";
import { finishCalls } from "../core/call-steps.ts";
import { CommonError } from "../core/common-error.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { ServerClient, ServerStaticState, ServerWorldState } from "./state.ts";

export const SERVER_MAX_CONFIGSTRINGS = 1024;
const CS_SERVERINFO = 0;
const CS_PRIMED = 3;
const MAX_CHUNK_SIZE = 1000;

export interface ServerConfigStringHost {
  print(text: string): void;
  dropClient(client: ServerClient, reason: string): CallSteps;
}

function sourceString(value: string | null): string {
  if (value === null) return "";
  const nul = value.indexOf("\0");
  const text = nul < 0 ? value : value.slice(0, nul);
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("Server configstrings require source byte characters");
  }
  return text;
}

/** Direct SV_AddServerCommand. The overflow callback may append disconnect commands reentrantly. */
export function* addServerCommand(client: ServerClient, text: string, host: ServerConfigStringHost): CallSteps {
  const command = sourceString(text);
  const result = client.reliable.add(command);
  if (result.kind === "queued") return;
  host.print("===== pending server commands =====\n");
  let sequence = client.reliable.acknowledge + 1;
  for (; sequence <= client.reliable.sequence; sequence++) {
    host.print(`cmd ${String(sequence).padStart(5)}: ${client.reliable.lookupMasked(sequence)}\n`);
  }
  host.print(`cmd ${String(sequence).padStart(5)}: ${command}\n`);
  yield* host.dropClient(client, "Server command overflow");
}

export class ServerConfigStrings implements ConfigStringStore {
  private readonly values: string[] = Array.from({ length: SERVER_MAX_CONFIGSTRINGS }, () => "");

  constructor(private readonly world: ServerWorldState, private readonly staticState: ServerStaticState,
    private readonly host: ServerConfigStringHost) {}

  get(index: number): string {
    const value = this.values[index];
    if (!Number.isInteger(index) || value === undefined) throw new CommonError("drop", `SV_GetConfigstring: bad index ${index}\n`);
    return value;
  }

  /** Buffer-sized engine trap read; the returned string excludes the terminating NUL. */
  getBuffer(index: number, bufferSize: number): string {
    if (!Number.isInteger(bufferSize) || bufferSize < 1) throw new CommonError("drop", `SV_GetConfigstring: bufferSize == ${bufferSize}`);
    return this.get(index).slice(0, bufferSize - 1);
  }

  set(index: number, value: string | null): void {
    finishCalls(this.setCalls(index, value));
  }

  *setCalls(index: number, value: string | null): CallSteps {
    if (!Number.isInteger(index) || index < 0 || index >= SERVER_MAX_CONFIGSTRINGS) throw new CommonError("drop", `SV_SetConfigstring: bad index ${index}\n`);
    const text = sourceString(value);
    if (this.values[index] === text) return;
    this.values[index] = text;
    if (this.world.state !== "game" && !this.world.restarting) return;
    for (const client of this.staticState.clients) {
      if (client.phase < CS_PRIMED) continue;
      if (index === CS_SERVERINFO) {
        const entity = this.world.gameEntity(client);
        if (entity !== null && (entity.r.svFlags & ServerEntityFlags.NOSERVERINFO) !== 0) continue;
      }
      if (text.length >= MAX_CHUNK_SIZE) {
        let sent = 0;
        let remaining = text.length;
        while (remaining > 0) {
          const command = sent === 0 ? "bcs0" : remaining < MAX_CHUNK_SIZE ? "bcs2" : "bcs1";
          const chunk = text.slice(sent, sent + MAX_CHUNK_SIZE - 1);
          yield* addServerCommand(client, `${command} ${index} "${chunk}"\n`, this.host);
          sent += MAX_CHUNK_SIZE - 1;
          remaining -= MAX_CHUNK_SIZE - 1;
        }
      } else {
        yield* addServerCommand(client, `cs ${index} "${text}"\n`, this.host);
      }
    }
  }
}
