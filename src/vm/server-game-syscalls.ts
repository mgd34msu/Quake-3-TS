/* Server game traps from id Software's code/server/sv_game.c and game/g_public.h.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
import type { CollisionWorld } from "../collision/world.ts";
import { runCalls } from "../core/call-steps.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { CommonError } from "../core/common-error.ts";
import { CvarFlag } from "../core/cvar.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { vec3 } from "../core/math.ts";
import type { Vec3 } from "../core/math.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import type { ServerBotAdapter } from "../server/bot-adapter.ts";
import type { BotDebugPolygons } from "../server/bot-debug.ts";
import type { ServerClientLifecycleRuntime } from "../server/client-lifecycle.ts";
import { SERVER_MAX_CONFIGSTRINGS } from "../server/configstrings.ts";
import type { ServerClient, ServerStaticState, ServerWorldState } from "../server/state.ts";
import type { ServerWorld } from "../server/world.ts";
import type { QvmGameData } from "./game-data.ts";
import type { QvmMemory } from "./memory.ts";
import { QVM_TRACE_BYTES, writeQvmTrace } from "./trace-record.ts";
import { QVM_USER_COMMAND_BYTES, writeQvmUserCommand } from "./user-command.ts";

export interface QvmServerGameServices {
  readonly data: QvmGameData;
  readonly world: ServerWorldState;
  readonly staticState: ServerStaticState;
  readonly spatial: ServerWorld;
  readonly collision: CollisionWorld;
  readonly lifecycle: ServerClientLifecycleRuntime;
  readonly cvars: CvarRegistry;
  readonly bots: ServerBotAdapter;
  readonly debugPolygons: BotDebugPolygons;
  entityToken(): { readonly token: string; readonly ended: boolean };
}

function complete(steps: CallSteps): number | Promise<number> {
  const result = runCalls(steps);
  return result instanceof Promise ? result.then(() => 0) : 0;
}

/** Resolve the VM pointer once; dereference each component only when its owner reads it. */
function vector(memory: QvmMemory, word: number, offset = 0): Vec3 {
  const pointer = memory.pointer(word);
  const component = (displacement: number): number => {
    if (pointer === null) throw new RangeError("Game vector requires a nonnull source pointer");
    return new DataView(pointer.buffer, pointer.byteOffset, pointer.byteLength).getFloat32(offset + displacement, true);
  };
  return { get x() { return component(0); }, get y() { return component(4); }, get z() { return component(8); } };
}

function maximumClients(services: QvmServerGameServices): number {
  const cvar = services.cvars.get("sv_maxclients");
  if (cvar === undefined) throw new Error("Server game traps require registered sv_maxclients");
  return cvar.integerValue;
}

function client(services: QvmServerGameServices, number: number, operation: string): ServerClient {
  if (number < 0 || number >= maximumClients(services)) {
    const message = operation === "SV_GetUserinfo" || operation === "SV_SetUserinfo"
      ? `${operation}: bad index ${number}\n` : `${operation}: bad clientNum:${number}`;
    throw new CommonError("drop", message);
  }
  const result = services.staticState.clients[number];
  if (result === undefined) throw new RangeError("Game trap client has no canonical server storage");
  return result;
}

function capacity(size: number, operation: string): void {
  if (size < 1) throw new CommonError("drop", `${operation}: bufferSize == ${size}`);
}

/** Null leaves common, filesystem, botlib and other-role calls to their existing owners. */
export function qvmServerGameSyscall(role: "game" | "cgame" | "ui", words: DataView,
  memory: QvmMemory, services: QvmServerGameServices): number | Promise<number> | null {
  if (role !== "game") return null;
  const trap = words.getInt32(0, true);
  const word = (index: number): number => words.getInt32(index * 4, true);
  switch (trap) {
    case 15:
      services.data.locate(word(1), word(2), word(3), word(4), word(5));
      return 0;
    case 16: {
      const number = word(1), reason = word(2);
      if (number < 0 || number >= maximumClients(services)) return 0;
      const target = client(services, number, "SV_GameDropClient");
      return complete(services.lifecycle.dropClient(target, () => memory.readString(reason)));
    }
    case 17: {
      const number = word(1), text = word(2);
      if (number !== -1 && (number < 0 || number >= maximumClients(services))) return 0;
      return complete(services.lifecycle.sendServerCommand(number, memory.readString(text)));
    }
    case 18: {
      const index = word(1), text = word(2);
      if (index < 0 || index >= SERVER_MAX_CONFIGSTRINGS) throw new CommonError("drop", `SV_SetConfigstring: bad index ${index}\n`);
      return complete(services.world.configstrings.setCalls(index, text === 0 ? null : memory.readString(text)));
    }
    case 19: {
      const index = word(1), output = word(2), size = word(3);
      capacity(size, "SV_GetConfigstring");
      if (index < 0 || index >= SERVER_MAX_CONFIGSTRINGS) throw new CommonError("drop", `SV_GetConfigstring: bad index ${index}\n`);
      const text = services.world.configstrings.get(index);
      memory.writeString(output, text, size);
      return 0;
    }
    case 20: {
      const number = word(1), output = word(2), size = word(3);
      capacity(size, "SV_GetUserinfo");
      const target = client(services, number, "SV_GetUserinfo");
      memory.writeString(output, target.userinfo, size);
      return 0;
    }
    case 21: {
      const number = word(1), text = word(2);
      client(services, number, "SV_SetUserinfo");
      services.lifecycle.setUserinfo(number, text === 0 ? null : memory.readString(text));
      return 0;
    }
    case 22: {
      const output = word(1), size = word(2);
      capacity(size, "SV_GetServerinfo");
      memory.writeString(output, services.cvars.infoString(CvarFlag.ServerInfo), size);
      return 0;
    }
    case 23: {
      const entityWord = word(1), nameWord = word(2);
      if (nameWord === 0) throw new CommonError("drop", "SV_SetBrushModel: NULL");
      const name = memory.readString(nameWord);
      if (!name.startsWith("*")) throw new CommonError("drop", `SV_SetBrushModel: ${name} isn't a brush model`);
      const entity = services.data.entityFromPointer(entityWord);
      entity.s.modelindex = nativeAtoi(name.slice(1));
      if (entity.s.modelindex < 0 || entity.s.modelindex >= services.collision.modelCount) {
        throw new CommonError("drop", "CM_InlineModel: bad number");
      }
      const bounds = services.collision.modelBounds(entity.s.modelindex);
      entity.r.mins = bounds.min;
      entity.r.maxs = bounds.max;
      entity.r.model = { kind: "inline", index: entity.s.modelindex };
      entity.r.contents = -1;
      services.spatial.link(entity);
      return 0;
    }
    case 24:
    case 43: {
      const output = word(1), startWord = word(2), minsWord = word(3), maxsWord = word(4);
      const endWord = word(5), passEntityNum = word(6), mask = word(7);
      const result = services.spatial.traceSource({ start: vector(memory, startWord), end: vector(memory, endWord),
        shape: { kind: trap === 43 ? "capsule" : "box", mins: minsWord === 0 ? vec3(0, 0, 0) : vector(memory, minsWord),
          maxs: maxsWord === 0 ? vec3(0, 0, 0) : vector(memory, maxsWord) }, passEntityNum, mask });
      writeQvmTrace(memory.view(output, QVM_TRACE_BYTES), result);
      return 0;
    }
    case 25: return services.spatial.pointContents(vector(memory, word(1)), word(2));
    case 26:
    case 27: {
      const first = vector(memory, word(1)), second = vector(memory, word(2)), collision = services.collision;
      const firstLeaf = collision.pointLeafnum(first), firstCluster = collision.leafCluster(firstLeaf), firstArea = collision.leafArea(firstLeaf);
      const mask = collision.clusterPVS(firstCluster);
      const secondLeaf = collision.pointLeafnum(second), secondCluster = collision.leafCluster(secondLeaf), secondArea = collision.leafArea(secondLeaf);
      if ((mask.byteAt(secondCluster >> 3) & (1 << (secondCluster & 7))) === 0) return 0;
      return trap === 27 ? 1 : Number(collision.areasConnected(firstArea, secondArea));
    }
    case 28: services.spatial.adjustAreaPortalState(services.data.entityFromPointer(word(1)), word(2) !== 0); return 0;
    case 29: return Number(services.collision.areasConnected(word(1), word(2)));
    case 30: services.spatial.link(services.data.entityFromPointer(word(1))); return 0;
    case 31: services.spatial.unlinkEntity(services.data.entityFromPointer(word(1))); return 0;
    case 32: {
      const min = vector(memory, word(1)), max = vector(memory, word(2)), output = memory.pointer(word(3)), count = word(4);
      return services.spatial.areaEntitiesInto({ min, max }, count, (number: number, index: number) => {
        if (output === null) throw new RangeError("Area entity output requires a nonnull source pointer");
        new DataView(output.buffer, output.byteOffset, output.byteLength).setInt32(index * 4, number, true);
        return undefined;
      });
    }
    case 33:
    case 44: return Number(services.spatial.entityContact({ min: vector(memory, word(1)), max: vector(memory, word(2)) },
      services.data.entityFromPointer(word(3)), trap === 44 ? "capsule" : "box"));
    case 34: return services.bots.allocateClient();
    case 35: services.bots.freeClient(word(1)); return 0;
    case 36: {
      const number = word(1), output = word(2), target = client(services, number, "SV_GetUsercmd");
      writeQvmUserCommand(memory.view(output, QVM_USER_COMMAND_BYTES), target.lastUsercmd);
      return 0;
    }
    case 37: {
      const output = word(1), size = word(2), result = services.entityToken();
      memory.writeString(output, result.token, size);
      return Number(!result.ended || result.token.length !== 0);
    }
    case 39: {
      const color = word(1), count = word(2), points = word(3);
      // The real polygon allocator publishes metadata before consuming these lazy points.
      return services.debugPolygons.create(color, count, Array.from({ length: 128 }, (_, index) => vector(memory, points, index * 12)));
    }
    case 40: services.debugPolygons.delete(word(1)); return 0;
    default: return null;
  }
}
