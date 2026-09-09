// Port of id Software's server/server.h records and sv_init.c allocation sizes.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { vec3 } from "../core/math.ts";
import type { ServerDownloadFile } from "../assets/download-file.ts";
import type { SharedEntity } from "../shared/entity-shared.ts";
import type { ServerGame } from "./game.ts";
import type { Ipv4Address, Ipv4Host } from "../platform/network.ts";
import type { LoopbackAddress } from "../protocol/loopback.ts";
import type { Netchannel } from "../protocol/netchan.ts";
import { ServerReliableCommands } from "../protocol/reliable.ts";
import { Weapon } from "../shared/definitions.ts";
import type { Product } from "../shared/definitions.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import type { HunkAccountingProfile } from "../render/hunk-accounting.ts";
import { ServerSnapshotEntities } from "./snapshot-entities.ts";
import { PlayerStateRecord } from "../shared/player-state.ts";
import type { SourcePlayerState, UserCommand } from "../shared/player-state.ts";
import { ServerConfigStrings } from "./configstrings.ts";
import type { ServerConfigStringHost } from "./configstrings.ts";

export const SERVER_PACKET_BACKUP = 32;
export const SERVER_MAX_ENTITIES = 1024;
export const SERVER_MAX_AREA_BYTES = 32;
export const SERVER_MAX_CHALLENGES = 1024;
export const SERVER_DOWNLOAD_WINDOW = 8;

export type ServerAddress = Ipv4Address | LoopbackAddress | { readonly kind: "bot" };
export type ServerAuthorizeAddress =
  | { readonly kind: "unresolved" }
  | { readonly kind: "failed" }
  | { readonly kind: "resolved"; readonly address: Ipv4Address };
export enum ServerClientPhase { Free = 0, Zombie = 1, Connected = 2, Primed = 3, Active = 4 }

/** Source-zero slots have a bot address and may become Zombie before acquiring a channel. */
export type ServerConnection =
  | { readonly kind: "uninitialized"; phase: ServerClientPhase.Free | ServerClientPhase.Zombie; readonly address: { readonly kind: "bot" } }
  | { readonly kind: "initialized"; phase: ServerClientPhase; address: ServerAddress; readonly netchan: Netchannel };

export class ServerClientFrame {
  areaBytes = 0;
  readonly areaBits = new Uint8Array(SERVER_MAX_AREA_BYTES);
  playerState: SourcePlayerState;
  firstEntity = 0;
  numEntities = 0;
  messageSent = 0;
  messageAcked = 0;
  messageSize = 0;

  constructor(product: Product) { this.playerState = new PlayerStateRecord<number, number, number>(product, 0, 0, 0); }
}

/** Download bookkeeping only. Opening/reading/closing files belongs to the download owner. */
export class ServerDownload {
  file: ServerDownloadFile | null = null;
  name = "";
  size = 0;
  count = 0;
  clientBlock = 0;
  currentBlock = 0;
  xmitBlock = 0;
  readonly blocks: (Uint8Array | null)[] = Array.from({ length: SERVER_DOWNLOAD_WINDOW }, () => null);
  readonly blockSizes = new Int32Array(SERVER_DOWNLOAD_WINDOW);
  eof = false;
  sendTime = 0;
}

/** One source client_t slot, distinct from GameClient and never owning its entity. */
export class ServerClient {
  connection: ServerConnection = { kind: "uninitialized", phase: ServerClientPhase.Free, address: { kind: "bot" } };
  retainedBotAddressIp: Ipv4Host = [0, 0, 0, 0];
  userinfo = "";
  readonly reliable = new ServerReliableCommands();
  reliableSent = 0;
  messageAcknowledge = 0;
  gamestateMessageNum = 0;
  challenge = 0;
  lastUsercmd: UserCommand = { serverTime: 0, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_NONE,
    forwardmove: 0, rightmove: 0, upmove: 0 };
  lastMessageNum = 0;
  lastClientCommand = 0;
  lastClientCommandString = "";
  gameEntity: SharedEntity | null = null;
  name = "";
  readonly download = new ServerDownload();
  deltaMessage = 0;
  nextReliableTime = 0;
  lastPacketTime = 0;
  lastConnectTime = 0;
  nextSnapshotTime = 0;
  rateDelayed = false;
  timeoutCount = 0;
  readonly frames: readonly ServerClientFrame[];
  ping = 0;
  rate = 0;
  snapshotMsec = 0;
  pureAuthentic = false;
  gotCP = false;
  readonly queuedMessages: Uint8Array[] = [];

  constructor(readonly product: Product, readonly slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= 64) throw new RangeError("Server client slot must be in 0..63");
    this.frames = Array.from({ length: SERVER_PACKET_BACKUP }, () => new ServerClientFrame(product));
  }

  get phase(): ServerClientPhase { return this.connection.phase; }
}

export class ServerChallenge {
  address: ServerAddress | null = null;
  challenge = 0;
  time = 0;
  pingTime = 0;
  firstTime = 0;
  connected = false;
}

export interface ServerStaticOptions {
  readonly product: Product;
  readonly maxClients: number;
  readonly dedicated: boolean;
}

/** SV_Startup/SV_ChangeMaxClients use 64 here, not MAX_PACKET_ENTITIES. */
export function createSnapshotEntityStorage(maxClients: number, dedicated: boolean): ServerSnapshotEntities {
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 64) throw new RangeError("Server maxClients must be in 1..64");
  return new ServerSnapshotEntities(maxClients * (dedicated ? SERVER_PACKET_BACKUP : 4) * 64, { kind: "unaccounted" });
}

/** Allocates owned records only; does not perform SV_Startup or load a map. */
export class ServerStaticState {
  readonly product: Product;
  initialized = false;
  time = 0;
  snapFlagServerBit = 0;
  clients: readonly ServerClient[];
  snapshotEntities: ServerSnapshotEntities;
  snapshotFrames: 4 | typeof SERVER_PACKET_BACKUP;
  nextSnapshotEntities = 0;
  nextHeartbeatTime = 0;
  readonly challenges = Array.from({ length: SERVER_MAX_CHALLENGES }, () => new ServerChallenge());
  authorizeAddress: ServerAuthorizeAddress = { kind: "unresolved" };

  constructor(options: ServerStaticOptions) {
    this.product = options.product;
    this.snapshotFrames = options.dedicated ? SERVER_PACKET_BACKUP : 4;
    this.snapshotEntities = createSnapshotEntityStorage(options.maxClients, options.dedicated);
    this.clients = Array.from({ length: options.maxClients }, (_, slot) => new ServerClient(options.product, slot));
  }

  get numSnapshotEntities(): number { return this.snapshotEntities.length; }

  resetSnapshotEntities(profile: HunkAccountingProfile = { kind: "unaccounted" }): void {
    this.snapshotEntities = new ServerSnapshotEntities(this.clients.length * this.snapshotFrames * 64, profile);
    this.nextSnapshotEntities = 0;
  }

  resizeSnapshotEntities(dedicated: boolean): void {
    this.snapshotFrames = dedicated ? SERVER_PACKET_BACKUP : 4;
    this.resetSnapshotEntities();
  }
}

/** A fresh map record; constructing it neither shuts down nor restarts an existing game. */
export class ServerWorldState {
  readonly product: Product;
  state: "dead" | "loading" | "game" = "dead";
  restarting = false;
  serverId = 0;
  restartedServerId = 0;
  checksumFeed = 0;
  checksumFeedServerId = 0;
  snapshotCounter = 0;
  timeResidual = 0;
  nextFrameTime = 0;
  restartTime = 0;
  game: ServerGame | null = null;
  readonly baselines = Array.from({ length: SERVER_MAX_ENTITIES }, () => new EntityStateRecord<number>(0));
  readonly entitySnapshotCounters = new Int32Array(SERVER_MAX_ENTITIES);
  readonly configstrings: ServerConfigStrings;

  constructor(private readonly staticState: ServerStaticState, host: ServerConfigStringHost) {
    this.product = staticState.product;
    this.configstrings = new ServerConfigStrings(this, staticState, host);
  }

  gameEntity(client: ServerClient): SharedEntity | null {
    if (this.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
    return client.gameEntity;
  }
}
