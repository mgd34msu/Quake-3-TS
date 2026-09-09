// Port of id Software's server/sv_bot.c and sv_game.c bot imports.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { BspMap } from "../assets/bsp.ts";
import type { AasMapSpatialHost } from "../botlib/aas-runtime.ts";
import type { AasBspTrace } from "../botlib/spatial.ts";
import type { CollisionWorld } from "../collision/world.ts";
import { CommonError } from "../core/common-error.ts";
import type { CallSteps } from "../core/call-steps.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { radiusFromBounds, vec3 } from "../core/math.ts";
import type { Bounds, Vec3 } from "../core/math.ts";
import type { ServerGame } from "./game.ts";
import { Netchannel } from "../protocol/netchan.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import type { UserCommand } from "../shared/player-state.ts";
import type { ServerClientCommandRuntime } from "./client-commands.ts";
import { ServerClientPhase, SERVER_PACKET_BACKUP } from "./state.ts";
import type { ServerClient, ServerStaticState, ServerWorldState } from "./state.ts";
import type { ServerWorld } from "./world.ts";

/** These are the existing server map owners, borrowed without copying their state. */
export interface ServerBotMap {
  readonly map: Pick<BspMap, "entities">;
  readonly collision: CollisionWorld;
  readonly spatial: ServerWorld;
  readonly world: ServerWorldState;
  readonly statics: ServerStaticState;
  readonly clientCommands: ServerClientCommandRuntime;
}

/** SV_BotFreeClient is shared by the trap adapter and ordinary SV_DropClient. */
export function freeServerBotClient(world: ServerWorldState, statics: ServerStaticState, maximum: number, number: number): void {
  if (!Number.isInteger(number) || number < 0 || number >= maximum) {
    throw new CommonError("drop", `SV_BotFreeClient: bad clientNum: ${number}`);
  }
  const client = statics.clients[number];
  if (client === undefined) throw new RangeError("Bot free client has no canonical server storage");
  client.connection.phase = ServerClientPhase.Free;
  client.name = "";
  const entity = world.gameEntity(client);
  if (entity !== null) entity.r.svFlags &= ~ServerEntityFlags.BOT;
}

export class ServerBotAdapter implements AasMapSpatialHost {
  constructor(readonly map: ServerBotMap, private readonly cvars: CvarRegistry,
    private readonly output: (text: string) => void) {}

  private maxClients(): number {
    const variable = this.cvars.get("sv_maxclients");
    if (variable === undefined) throw new Error("Bot server requires sv_maxclients");
    return variable.integerValue;
  }
  private client(number: number): ServerClient {
    const client = this.map.statics.clients[number];
    if (!Number.isInteger(number) || number < 0 || client === undefined) throw new RangeError(`Bot client slot ${number} has no server storage`);
    return client;
  }
  private game(): ServerGame {
    const game = this.map.world.game;
    if (game === null) throw new Error("Bot server imports require the map's published game");
    return game;
  }

  allocateClient(): number {
    const maximum = this.maxClients();
    for (let number = 0; number < maximum; number++) {
      const client = this.client(number);
      if (client.phase !== ServerClientPhase.Free) continue;
      client.gameEntity = this.game().data.entity(number);
      client.gameEntity.s.number = number;
      const connection = client.connection;
      if (connection.kind === "uninitialized") {
        client.connection = { kind: "initialized", phase: ServerClientPhase.Active,
          address: { kind: "bot" }, netchan: Netchannel.sourceZero() };
      } else {
        connection.phase = ServerClientPhase.Active;
        if (connection.address.kind === "ipv4") client.retainedBotAddressIp = [...connection.address.host];
        connection.address = { kind: "bot" };
      }
      client.lastPacketTime = this.map.statics.time;
      client.rate = 16384;
      return number;
    }
    return -1;
  }

  freeClient(number: number): void {
    freeServerBotClient(this.map.world, this.map.statics, this.maxClients(), number);
  }

  *clientCommand(number: number, text: string): CallSteps {
    yield* this.map.clientCommands.executeClientCommand(this.client(number), text, true);
  }
  *userCommand(number: number, command: UserCommand | (() => UserCommand)): CallSteps {
    const client = this.client(number);
    yield* this.map.clientCommands.clientThink(client, typeof command === "function" ? command() : command);
  }

  /** An empty consumed ring slot still advances acknowledgement and ends this drain. */
  getConsoleMessage(number: number, size = 1024): string | null {
    const client = this.client(number);
    client.lastPacketTime = this.map.statics.time;
    if (client.reliable.acknowledge === client.reliable.sequence) return null;
    client.reliable.assignAcknowledgement((client.reliable.acknowledge + 1) | 0);
    const text = client.reliable.lookupMasked(client.reliable.acknowledge);
    if (text.length === 0) return null;
    if (!Number.isInteger(size) || size < 1) throw new CommonError("fatal", "Q_strncpyz: destsize < 1");
    return text.slice(0, size - 1);
  }

  getSnapshotEntity(number: number, sequence: number): number {
    if (!Number.isInteger(sequence) || sequence < -0x80000000 || sequence > 0x7fffffff) {
      throw new RangeError("Bot snapshot sequence must be a signed source integer");
    }
    const client = this.client(number), connection = client.connection;
    const outgoingSequence = connection.kind === "uninitialized" ? 0 : connection.netchan.outgoingSequence;
    const frame = client.frames[outgoingSequence & (SERVER_PACKET_BACKUP - 1)];
    if (frame === undefined) throw new Error("Bot snapshot frame is missing");
    if (sequence < 0 || sequence >= frame.numEntities) return -1;
    const entity = this.map.statics.snapshotEntities.get((frame.firstEntity + sequence) % this.map.statics.numSnapshotEntities);
    return entity.number;
  }

  print(text: string): void { this.output(text); }
  trace(start: Vec3, end: Vec3, bounds: Bounds | null, passEntity: number, mask: number): AasBspTrace {
    const result = this.map.spatial.trace({ start, end, passEntityNum: passEntity, mask,
      shape: bounds === null ? { kind: "point" } : { kind: "box", mins: bounds.min, maxs: bounds.max } });
    return { ...result, contents: 0 };
  }
  entityTrace(entityNum: number, start: Vec3, end: Vec3, bounds: Bounds, mask: number): AasBspTrace {
    const result = this.map.spatial.traceEntity(entityNum,
      { start, end, mask, shape: { kind: "box", mins: bounds.min, maxs: bounds.max } });
    return { ...result, contents: 0 };
  }
  pointContents(point: Vec3): number { return this.map.spatial.pointContents(point, -1); }
  inPVS(first: Vec3, second: Vec3): boolean {
    const collision = this.map.collision;
    const firstLeaf = collision.pointLeafnum(first), firstArea = collision.leafArea(firstLeaf);
    const mask = collision.clusterPVS(collision.leafCluster(firstLeaf));
    const secondLeaf = collision.pointLeafnum(second), cluster = collision.leafCluster(secondLeaf);
    const secondArea = collision.leafArea(secondLeaf), byte = mask.byteAt(cluster >> 3);
    if ((byte & (1 << (cluster & 7))) === 0) return false;
    return collision.areasConnected(firstArea, secondArea);
  }
  bspEntityData(): string { return this.map.map.entities; }
  modelBounds(modelIndex: number, angles: Vec3): { readonly bounds: Bounds; readonly origin: Vec3 } {
    let bounds = this.map.collision.modelBounds(modelIndex);
    if (angles.x !== 0 || angles.y !== 0 || angles.z !== 0) {
      const radius = radiusFromBounds(bounds);
      bounds = { min: vec3(-radius, -radius, -radius), max: vec3(radius, radius, radius) };
    }
    return { bounds, origin: vec3(0, 0, 0) };
  }
}
