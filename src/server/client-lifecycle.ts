// Port of id Software's sv_client.c connection, userinfo, gamestate and drop paths.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CvarRegistry } from "../core/cvar.ts";
import { CommonError } from "../core/common-error.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import { MAX_MESSAGE_LENGTH, MessageWriter } from "../protocol/message.ts";
import { Netchannel } from "../protocol/netchan.ts";
import { freeServerBotClient } from "./bot-adapter.ts";
import { ServerOpcode } from "../protocol/server-message.ts";
import type { CallSteps } from "../core/call-steps.ts";
import { writeDeltaEntity } from "../protocol/state-delta.ts";
import { ServerEntityFlags } from "../shared/entity-shared.ts";
import { EntityStateRecord } from "../shared/entity-state.ts";
import { addServerCommand } from "./configstrings.ts";
import type { ServerDownloadRuntime } from "./downloads.ts";
import type { ServerPacketAddress } from "./net-channel.ts";
import type { ServerSnapshotSendRuntime } from "./snapshot-send.ts";
import { ServerClient, ServerClientPhase } from "./state.ts";
import type { ServerAddress, ServerStaticState, ServerWorldState } from "./state.ts";

export interface ServerClientLifecycleHost {
  readonly cvars: Pick<CvarRegistry, "get">;
  readonly downloads: ServerDownloadRuntime;
  readonly sender: ServerSnapshotSendRuntime;
  print(text: string): void;
  debugPrint(text: string): void;
  sendPacket(to: ServerPacketAddress, payload: Uint8Array): void;
  isLanAddress(address: ServerAddress): boolean;
}

function sourceString(value: string): string {
  const nul = value.indexOf("\0"), text = nul < 0 ? value : value.slice(0, nul);
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 255) throw new RangeError("Server userinfo requires source byte characters");
  }
  return text;
}
function sameBase(a: ServerAddress, b: ServerAddress): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ipv4") return b.kind === "ipv4" && a.host.every((octet, index) => octet === b.host[index]);
  return a.kind === "loopback";
}
function sameAddress(a: ServerAddress, b: ServerAddress | null): boolean {
  return b !== null && sameBase(a, b) && (a.kind !== "ipv4" || (b.kind === "ipv4" && a.port === b.port));
}
function addressString(address: ServerAddress): string {
  if (address.kind === "loopback") return "loopback";
  if (address.kind === "bot") return "bot";
  return `${address.host.join(".")}:${address.port}`;
}
function ownedAddress(address: ServerPacketAddress): ServerPacketAddress {
  return address.kind === "loopback" ? { kind: "loopback" } : { kind: "ipv4", host: [...address.host], port: address.port };
}

/** Admission consumes existing challenges; challenge creation and pure verification have separate owners. */
export class ServerClientLifecycleRuntime {
  constructor(readonly world: ServerWorldState, readonly staticState: ServerStaticState, readonly host: ServerClientLifecycleHost) {
    if (host.sender.snapshots.world !== world || host.sender.snapshots.staticState !== staticState || host.downloads.staticState !== staticState) {
      throw new Error("Client lifecycle, downloads and snapshot sender must share server state");
    }
  }
  private cvar(name: string) {
    const value = this.host.cvars.get(name);
    if (value === undefined) throw new Error(`Client lifecycle requires registered cvar ${name}`);
    return value;
  }
  private client(slot: number): ServerClient {
    const client = this.staticState.clients[slot];
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.cvar("sv_maxclients").integerValue || client === undefined) {
      throw new RangeError(`SV_SetUserinfo: bad index ${slot}`);
    }
    return client;
  }
  private connection(client: ServerClient) {
    if (this.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
    if (client.connection.kind !== "initialized") throw new Error("Server client channel is uninitialized");
    return client.connection;
  }
  private game() {
    if (this.world.game === null) throw new Error("Client lifecycle requires the current game runtime");
    return this.world.game;
  }
  private infoSet(info: string, key: string, value: string): string {
    return infoSetValueForKey(info, key, value, text => { this.host.print(text); });
  }
  private reply(address: ServerPacketAddress, text: string): void {
    this.host.sendPacket(ownedAddress(address), encodeConnectionlessText(text));
  }
  private matches(client: ServerClient, address: ServerPacketAddress, qport: number): boolean {
    const connection = client.connection;
    return connection.kind === "initialized" && sameBase(address, connection.address) && (connection.netchan.qport === qport ||
      (address.kind === "ipv4" && connection.address.kind === "ipv4" && address.port === connection.address.port) ||
      address.kind === "loopback");
  }
  *sendServerCommand(slot: number, text: string): CallSteps {
    yield* this.command(slot === -1 ? null : this.client(slot), text);
  }

  private *command(client: ServerClient | null, text: string): CallSteps {
    const message = sourceString(text).slice(0, 16383);
    const host = { print: (value: string) => { this.host.print(value); }, dropClient: (value: ServerClient, reason: string) => this.dropClient(value, reason) };
    if (client !== null) { yield* addServerCommand(client, message, host); return; }
    if (this.cvar("dedicated").integerValue && message.startsWith("print")) {
      let expanded = "";
      for (const character of message) { if (expanded.length >= 1021) break; expanded += character === "\n" ? "\\n" : character; }
      this.host.print(`broadcast: ${expanded}\n`);
    }
    for (let slot = 0; slot < this.cvar("sv_maxclients").integerValue; slot++) {
      const target = this.client(slot);
      if (target.phase >= ServerClientPhase.Primed) yield* addServerCommand(target, message, host);
    }
  }

  setUserinfo(slot: number, value: string | null): void {
    if (slot < 0 || slot >= this.cvar("sv_maxclients").integerValue) {
      throw new CommonError("drop", `SV_SetUserinfo: bad index ${slot}\n`);
    }
    const client = this.client(slot), text = sourceString(value === null ? "" : value);
    client.userinfo = text.slice(0, 1023);
    client.name = infoValueForKey(text, "name").slice(0, 31);
  }

  userinfoChanged(client: ServerClient): void {
    const address = this.connection(client).address;
    client.name = infoValueForKey(client.userinfo, "name").slice(0, 31);
    if (this.host.isLanAddress(address) && this.cvar("dedicated").integerValue !== 2 && this.cvar("sv_lanForceRate").integerValue === 1) client.rate = 99999;
    else {
      const rate = infoValueForKey(client.userinfo, "rate");
      client.rate = rate ? Math.max(1000, Math.min(90000, nativeAtoi(rate))) : 3000;
    }
    const handicap = infoValueForKey(client.userinfo, "handicap"), handicapNumber = nativeAtoi(handicap);
    if (handicap && (handicapNumber <= 0 || handicapNumber > 100 || handicap.length > 4)) client.userinfo = this.infoSet(client.userinfo, "handicap", "100");
    const snaps = infoValueForKey(client.userinfo, "snaps");
    client.snapshotMsec = snaps ? Math.trunc(1000 / Math.max(1, Math.min(30, nativeAtoi(snaps)))) : 50;
    if (!infoValueForKey(client.userinfo, "ip")) client.userinfo = this.infoSet(client.userinfo, "ip", address.kind === "loopback" ? "localhost" : addressString(address));
  }

  *directConnect(from: ServerPacketAddress, input: string): CallSteps {
    this.host.debugPrint("SVC_DirectConnect ()\n");
    let userinfo = sourceString(input).slice(0, 1023);
    const version = nativeAtoi(infoValueForKey(userinfo, "protocol"));
    if (version !== 68) {
      this.reply(from, "print\nServer uses protocol version 68.\n");
      this.host.debugPrint(`    rejected connect from version ${version}\n`); return;
    }
    const challengeNumber = nativeAtoi(infoValueForKey(userinfo, "challenge")), qport = nativeAtoi(infoValueForKey(userinfo, "qport"));
    // Boundary hardening: source accepts int32 qport values that can never match a 16-bit packet qport.
    if (qport < 0 || qport > 65535) { this.reply(from, "print\nInvalid qport.\n"); return; }
    for (let slot = 0; slot < this.cvar("sv_maxclients").integerValue; slot++) {
      const client = this.client(slot);
      if (client.phase === ServerClientPhase.Free || !this.matches(client, from, qport)) continue;
      if (((this.staticState.time - client.lastConnectTime) | 0) < Math.imul(this.cvar("sv_reconnectlimit").integerValue, 1000)) {
        this.host.debugPrint(`${addressString(from)}:reconnect rejected : too soon\n`); return;
      }
      break;
    }
    if (from.kind !== "loopback") {
      const index = this.staticState.challenges.findIndex(value => sameAddress(from, value.address) && value.challenge === challengeNumber);
      const challenge = this.staticState.challenges[index];
      if (challenge === undefined) { this.reply(from, "print\nNo or bad challenge for address.\n"); return; }
      userinfo = this.infoSet(userinfo, "ip", addressString(from));
      const ping = (this.staticState.time - challenge.pingTime) | 0;
      this.host.print(`Client ${index} connecting with ${ping} challenge ping\n`);
      challenge.connected = true;
      if (!this.host.isLanAddress(from)) {
        if (Math.fround(this.cvar("sv_minPing").numericValue) !== 0 && Math.fround(ping) < Math.fround(this.cvar("sv_minPing").numericValue)) {
          this.reply(from, "print\nServer is for high pings only\n");
          this.host.debugPrint(`Client ${index} rejected on a too low ping\n`);
          challenge.address = { kind: "ipv4", host: [...from.host], port: 0 }; return;
        }
        if (Math.fround(this.cvar("sv_maxPing").numericValue) !== 0 && Math.fround(ping) > Math.fround(this.cvar("sv_maxPing").numericValue)) {
          this.reply(from, "print\nServer is for low pings only\n");
          this.host.debugPrint(`Client ${index} rejected on a too high ping\n`); return;
        }
      }
    } else userinfo = this.infoSet(userinfo, "ip", "localhost");
    let selected: ServerClient | null = null;
    for (let slot = 0; slot < this.cvar("sv_maxclients").integerValue; slot++) {
      const client = this.client(slot);
      if (client.phase !== ServerClientPhase.Free && this.matches(client, from, qport)) {
        this.host.print(`${addressString(from)}:reconnect\n`); selected = client; break;
      }
    }
    if (selected === null) {
      const start = infoValueForKey(userinfo, "password") === this.cvar("sv_privatePassword").value ? 0 : this.cvar("sv_privateClients").integerValue;
      for (let slot = start; slot < this.cvar("sv_maxclients").integerValue; slot++) {
        const client = this.client(slot);
        if (client.phase === ServerClientPhase.Free) { selected = client; break; }
      }
      if (selected === null) {
        if (from.kind !== "loopback") { this.reply(from, "print\nServer is full.\n"); this.host.debugPrint("Rejected a connection.\n"); return; }
        let count = 0;
        for (let slot = start; slot < this.cvar("sv_maxclients").integerValue; slot++) {
          const connection = this.client(slot).connection;
          if (connection.address.kind === "bot") count++;
        }
        if (count < this.cvar("sv_maxclients").integerValue - start) throw new CommonError("fatal", "server is full on local connect\n");
        yield* this.dropClient(this.client(this.cvar("sv_maxclients").integerValue - 1), "only bots on server");
        selected = this.client(this.cvar("sv_maxclients").integerValue - 1);
      }
    }
    // Resource-safety correction: the C record overwrite leaks an in-progress reconnect download.
    this.host.downloads.close(selected);
    Object.assign(selected, new ServerClient(this.staticState.product, selected.slot));
    selected.gameEntity = this.game().data.entity(selected.slot);
    selected.challenge = challengeNumber;
    selected.connection = { kind: "initialized", phase: ServerClientPhase.Free, address: ownedAddress(from), netchan: new Netchannel("server", qport) };
    selected.userinfo = userinfo.slice(0, 1023);
    const denied = yield* this.game().calls.clientConnect(selected.slot, true, false);
    if (denied !== null) {
      this.reply(from, `print\n${typeof denied === "string" ? denied : denied()}\n`);
      this.host.debugPrint(`Game rejected a connection: ${typeof denied === "string" ? denied : denied()}.\n`); return;
    }
    this.userinfoChanged(selected);
    this.reply(from, "connectResponse");
    this.host.debugPrint(`Going from CS_FREE to CS_CONNECTED for ${selected.name}\n`);
    this.connection(selected).phase = ServerClientPhase.Connected;
    selected.nextSnapshotTime = this.staticState.time; selected.lastPacketTime = this.staticState.time; selected.lastConnectTime = this.staticState.time;
    selected.gamestateMessageNum = -1;
    let count = 0;
    for (let slot = 0; slot < this.cvar("sv_maxclients").integerValue; slot++) if (this.client(slot).phase >= ServerClientPhase.Connected) count++;
    if (count === 1 || count === this.cvar("sv_maxclients").integerValue) this.staticState.nextHeartbeatTime = -9999999;
  }

  private dropReason(reason: string | (() => string)): string {
    return sourceString(typeof reason === "string" ? reason : reason());
  }

  *dropClient(client: ServerClient, reason: string | (() => string)): CallSteps {
    if (this.staticState.clients[client.slot] !== client) throw new Error("Client does not belong to this server");
    if (client.phase === ServerClientPhase.Zombie) return;
    const entity = this.world.gameEntity(client);
    if (entity === null || !(entity.r.svFlags & ServerEntityFlags.BOT)) {
      for (const challenge of this.staticState.challenges) {
        if (sameAddress(client.connection.address, challenge.address)) { challenge.connected = false; break; }
      }
    }
    this.host.downloads.close(client);
    yield* this.command(null, `print "${client.name}^7 ${this.dropReason(reason)}\n"`);
    this.host.debugPrint(`Going to CS_ZOMBIE for ${client.name}\n`);
    client.connection.phase = ServerClientPhase.Zombie;
    if (client.download.file !== null) { client.download.file.close(); client.download.file = null; }
    yield* this.game().calls.clientDisconnect(client.slot);
    yield* this.command(client, `disconnect "${this.dropReason(reason)}"`);
    if (client.connection.address.kind === "bot") {
      freeServerBotClient(this.world, this.staticState, this.cvar("sv_maxclients").integerValue, client.slot);
    }
    this.setUserinfo(client.slot, "");
    for (let slot = 0; slot < this.cvar("sv_maxclients").integerValue; slot++) if (this.client(slot).phase >= ServerClientPhase.Connected) return;
    this.staticState.nextHeartbeatTime = -9999999;
  }

  sendClientGameState(client: ServerClient): void {
    this.connection(client);
    this.host.debugPrint(`SV_SendClientGameState() for ${client.name}\n`);
    this.host.debugPrint(`Going from CS_CONNECTED to CS_PRIMED for ${client.name}\n`);
    this.connection(client).phase = ServerClientPhase.Primed; client.pureAuthentic = false; client.gotCP = false;
    client.gamestateMessageNum = this.connection(client).netchan.outgoingSequence;
    const writer = new MessageWriter("bitstream", MAX_MESSAGE_LENGTH, this.host.sender.channel.sourceState);
    writer.writeLong(client.lastClientCommand);
    for (const command of client.reliable.pending()) {
      writer.writeByte(ServerOpcode.Command); writer.writeLong(command.sequence); writer.writeString(command.text);
    }
    client.reliableSent = client.reliable.sequence;
    writer.writeByte(ServerOpcode.Gamestate); writer.writeLong(client.reliable.sequence);
    for (let index = 0; index < 1024; index++) {
      const text = this.world.configstrings.get(index);
      if (!text) continue;
      writer.writeByte(ServerOpcode.Configstring); writer.writeShort(index); writer.writeBigString(text);
    }
    const zero = new EntityStateRecord<number>(0);
    for (const baseline of this.world.baselines) {
      if (!baseline.number) continue;
      writer.writeByte(ServerOpcode.Baseline); writeDeltaEntity(writer, zero, baseline, true);
    }
    writer.writeByte(ServerOpcode.Eof); writer.writeLong(client.slot); writer.writeLong(this.world.checksumFeed);
    // Unlike SV_SendClientSnapshot, this source path sends even a partially overflowed message.
    this.host.sender.sendMessageToClient(client, writer);
  }
}
