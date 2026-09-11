// Port of id Software's sv_main.c queries/heartbeat, sv_client.c authorization and sv_ccmds.c bans.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CvarFlag } from "../core/cvar.ts";
import { runCalls } from "../core/call-steps.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import type { LinuxNativeRandom } from "../core/native-random.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { MASTER_SERVER_PORT, NETWORK_DEFAULTS } from "../core/network-defaults.ts";
import type { Ipv4Address } from "../platform/network.ts";
import { decodeConnectionless, encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../protocol/connectionless.ts";
import { PersistentIndex } from "../shared/definitions.ts";
import type { ServerClientLifecycleRuntime } from "./client-lifecycle.ts";
import type { ServerPacketAddress } from "./net-channel.ts";
import type { ServerNetworkControlState } from "./network-control.ts";
import { ServerClientPhase } from "./state.ts";
import type { ServerAddress, ServerChallenge, ServerClient, ServerStaticState } from "./state.ts";

export interface ServerConnectionlessHost {
  readonly cvars: CvarRegistry;
  readonly random: LinuxNativeRandom;
  currentLifecycle(): ServerClientLifecycleRuntime;
  sendPacket(to: ServerPacketAddress, packet: Uint8Array): void;
  isLanAddress(address: ServerAddress): boolean;
  resolveAddress(hostname: string, port: number): Promise<Ipv4Address | null>;
  remoteCommand(from: ServerPacketAddress, packet: Uint8Array, decoded: ConnectionlessPacket): Promise<void>;
  print(text: string): void;
  debugPrint(text: string): void;
}

function owned(address: ServerPacketAddress): ServerPacketAddress {
  return address.kind === "loopback" ? { kind: "loopback" } : { kind: "ipv4", host: [...address.host], port: address.port };
}
function sameBase(a: ServerPacketAddress, b: ServerAddress | null): boolean {
  if (b === null || a.kind !== b.kind) return false;
  return a.kind === "loopback" || b.kind === "ipv4" && a.host.every((value, index) => value === b.host[index]);
}
function sameAddress(a: ServerPacketAddress, b: ServerAddress | null): boolean {
  return sameBase(a, b) && (a.kind === "loopback" || b?.kind === "ipv4" && a.port === b.port);
}
function addressString(address: ServerPacketAddress): string {
  return address.kind === "loopback" ? "loopback" : `${address.host.join(".")}:${address.port}`;
}
function sourceString(input: string): string {
  const nul = input.indexOf("\0"), text = nul < 0 ? input : input.slice(0, nul);
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 255) throw new RangeError("Server connectionless text requires Latin-1 source bytes");
  return text;
}
function argument(packet: ConnectionlessPacket, index: number): string {
  const value = packet.arguments[index];
  return value === undefined ? "" : value; // Cmd_Argv returns an empty C string for absent arguments.
}
function clearChallenge(challenge: ServerChallenge): void {
  challenge.address = null; challenge.challenge = 0; challenge.time = 0;
  challenge.pingTime = 0; challenge.firstTime = 0; challenge.connected = false;
}

/** The engine must await each operation before advancing server time or dispatching another packet. */
export class ServerConnectionlessRuntime {
  constructor(readonly control: ServerNetworkControlState, readonly host: ServerConnectionlessHost) {}
  private currentLifecycle(): ServerClientLifecycleRuntime {
    const lifecycle = this.host.currentLifecycle();
    if (this.host.cvars !== lifecycle.host.cvars) throw new Error("Connectionless and current client lifecycle must share engine cvars");
    return lifecycle;
  }
  private cvar(name: string) {
    const value = this.host.cvars.get(name);
    if (value === undefined) throw new Error(`Connectionless server requires registered cvar ${name}`);
    return value;
  }
  private variableValue(name: string): number {
    const value = this.host.cvars.get(name);
    return value === undefined ? 0 : Math.fround(value.numericValue); // Cvar_VariableValue's source not-found result.
  }
  private variableString(name: string): string {
    const value = this.host.cvars.get(name);
    return value === undefined ? "" : sourceString(value.value);
  }
  private async resolve(hostname: string, port: number): Promise<Ipv4Address | null> {
    this.control.assertCurrentOperation();
    const address = await this.host.resolveAddress(hostname, port);
    this.control.assertCurrentOperation();
    if (address === null) return null;
    if (address.host.length !== 4 || address.host.some(value => !Number.isInteger(value) || value < 0 || value > 255)
      || !Number.isInteger(address.port) || address.port < 0 || address.port > 65535) throw new RangeError("Resolver returned an invalid source IPv4 address");
    if (address.host.every(value => value === 255)) return null; // NET_StringToAdr rejects INADDR_NONE.
    return { kind: "ipv4", host: [...address.host], port: address.port };
  }
  private async resolveAuthorizeAddress(state: ServerStaticState): Promise<boolean> {
    this.host.print(`Resolving ${NETWORK_DEFAULTS.authorizeServer}\n`);
    const address = await this.resolve(NETWORK_DEFAULTS.authorizeServer, NETWORK_DEFAULTS.authorizePort);
    this.control.assertCurrentOperation();
    if (address === null) { state.authorizeAddress = { kind: "failed" }; this.host.print("Couldn't resolve address\n"); return false; }
    state.authorizeAddress = { kind: "resolved", address: { kind: "ipv4", host: [...address.host], port: NETWORK_DEFAULTS.authorizePort } };
    this.host.print(`${NETWORK_DEFAULTS.authorizeServer} resolved to ${addressString(state.authorizeAddress.address)}\n`);
    return true;
  }
  async banUser(client: ServerClient): Promise<void> {
    await this.control.runBan(async () => {
      const state = this.currentLifecycle().staticState;
      if (state.authorizeAddress.kind === "unresolved" || state.authorizeAddress.kind === "resolved" && state.authorizeAddress.address.host[0] === 0) {
        if (!await this.resolveAuthorizeAddress(state)) return;
      }
      if (state.authorizeAddress.kind === "failed") return;
      if (state.authorizeAddress.kind !== "resolved") throw new Error("Authorization address was not resolved");
      const address = client.connection.address;
      const ip = address.kind === "ipv4" ? address.host : client.retainedBotAddressIp;
      this.reply(state.authorizeAddress.address, `banUser ${ip.join(".")}`);
      this.host.print(`${client.name} was banned from coming back\n`);
    });
  }
  private formatted(text: string, size: number): string {
    const value = sourceString(text);
    if (value.length >= size) this.host.print(`Com_sprintf: overflow of ${value.length} in ${size}\n`);
    return value.slice(0, size - 1);
  }
  private infoSet(input: string, key: string, value: string): string {
    return infoSetValueForKey(input, key, value, text => { this.host.print(text); });
  }
  private reply(address: ServerAddress | null, text: string): void {
    this.control.assertCurrentOperation();
    if (address === null || address.kind === "bot") throw new Error("Source connectionless reply has no packet address");
    // Original NET_OutOfBandPrint uses unbounded vsprintf; the codec explicitly rejects its buffer overflow.
    this.host.sendPacket(owned(address), encodeConnectionlessText(text));
  }
  private client(state: ServerStaticState, index: number) {
    const client = state.clients[index];
    if (!Number.isInteger(index) || index < 0 || client === undefined) throw new RangeError("Source connectionless client index is outside allocated slots");
    return client;
  }
  private status(lifecycle: ServerClientLifecycleRuntime, from: ServerPacketAddress, packet: ConnectionlessPacket): void {
    if (this.variableValue("g_gametype") === 2) return;
    let info = "";
    this.host.cvars.visit(CvarFlag.ServerInfo, cvar => {
      if (cvar.nameString === null || cvar.currentString === null) throw new RangeError("Undefined native NULL status cvar string");
      info = this.infoSet(info, cvar.nameString.value, cvar.currentString.value);
    });
    info = this.infoSet(info, "challenge", argument(packet, 0));
    if (this.variableValue("fs_restrict") !== 0) info = this.infoSet(info, "sv_keywords", this.formatted(`demo ${infoValueForKey(info, "sv_keywords", 1024)}`, 1024));
    let players = "";
    for (let index = 0; index < this.cvar("sv_maxclients").integerValue; index++) {
      const client = this.client(lifecycle.staticState, index);
      if (client.phase < ServerClientPhase.Connected) continue;
      const game = lifecycle.world.game;
      if (game === null) throw new Error("Status query requires actual game player states");
      const playerState = game.data.copyPlayerState(index);
      const row = this.formatted(`${playerState.persistant.get(PersistentIndex.PERS_SCORE)} ${client.ping} "${client.name}"\n`, 1024);
      if (players.length + row.length >= 16384) break;
      players += row;
    }
    this.reply(from, `statusResponse\n${info}\n${players}`);
  }
  private info(state: ServerStaticState, from: ServerPacketAddress, packet: ConnectionlessPacket): void {
    if (this.variableValue("g_gametype") === 2 || this.variableValue("ui_singlePlayerActive") !== 0) return;
    let count = 0;
    for (let index = this.cvar("sv_privateClients").integerValue; index < this.cvar("sv_maxclients").integerValue; index++) {
      if (this.client(state, index).phase >= ServerClientPhase.Connected) count++;
    }
    let info = "";
    info = this.infoSet(info, "challenge", argument(packet, 0));
    info = this.infoSet(info, "protocol", "68");
    info = this.infoSet(info, "hostname", this.cvar("sv_hostname").value);
    info = this.infoSet(info, "mapname", this.cvar("mapname").value);
    info = this.infoSet(info, "clients", String(count));
    info = this.infoSet(info, "sv_maxclients", String((this.cvar("sv_maxclients").integerValue - this.cvar("sv_privateClients").integerValue) | 0));
    info = this.infoSet(info, "gametype", String(this.cvar("g_gametype").integerValue));
    info = this.infoSet(info, "pure", String(this.cvar("sv_pure").integerValue));
    if (this.cvar("sv_minPing").integerValue !== 0) info = this.infoSet(info, "minPing", String(this.cvar("sv_minPing").integerValue));
    if (this.cvar("sv_maxPing").integerValue !== 0) info = this.infoSet(info, "maxPing", String(this.cvar("sv_maxPing").integerValue));
    const game = this.variableString("fs_game");
    if (game.length !== 0) info = this.infoSet(info, "game", game);
    this.reply(from, `infoResponse\n${info}`);
  }
  private async getChallenge(state: ServerStaticState, from: ServerPacketAddress): Promise<void> {
    if (this.variableValue("g_gametype") === 2 || this.variableValue("ui_singlePlayerActive") !== 0) return;
    let oldest = 0, oldestTime = 0x7fffffff, found: ServerChallenge | undefined;
    for (const [index, challenge] of state.challenges.entries()) {
      if (!challenge.connected && sameAddress(from, challenge.address)) { found = challenge; break; }
      if (challenge.time < oldestTime) { oldestTime = challenge.time; oldest = index; }
    }
    if (found === undefined) {
      found = state.challenges[oldest];
      if (found === undefined) throw new Error("Server challenge table is empty");
      found.challenge = (this.host.random.next() << 16) ^ this.host.random.next() ^ state.time;
      found.address = owned(from); found.firstTime = state.time; found.time = state.time; found.connected = false;
    }
    if (this.host.isLanAddress(from)) { found.pingTime = state.time; this.reply(from, `challengeResponse ${found.challenge}`); return; }
    if (state.authorizeAddress.kind === "unresolved" || state.authorizeAddress.kind === "resolved" && state.authorizeAddress.address.host[0] === 0) {
      if (!await this.resolveAuthorizeAddress(state)) return;
    }
    if (((state.time - found.firstTime) | 0) > 5000) {
      this.host.debugPrint("authorize server timed out\n"); found.pingTime = state.time;
      this.reply(found.address, `challengeResponse ${found.challenge}`); return;
    }
    if (state.authorizeAddress.kind !== "failed") {
      if (from.kind !== "ipv4") throw new Error("LAN classifier rejected a loopback challenge address");
      this.host.debugPrint(`sending getIpAuthorize for ${addressString(from)}\n`);
      const fs = this.host.cvars.register("fs_game", "", CvarFlag.Init | CvarFlag.SystemInfo);
      const game = sourceString(fs.value).length === 0 ? "baseq3" : sourceString(fs.value);
      if (game.length >= 1024) throw new RangeError("Authorization game name exceeds source buffer");
      if (state.authorizeAddress.kind !== "resolved") throw new Error("Authorization address was not resolved");
      this.reply(state.authorizeAddress.address, `getIpAuthorize ${found.challenge} ${from.host.join(".")} ${game} 0 ${this.cvar("sv_strictAuth").value}`);
    }
  }
  private authorize(state: ServerStaticState, from: ServerPacketAddress, packet: ConnectionlessPacket): void {
    if (state.authorizeAddress.kind !== "resolved" || !sameBase(from, state.authorizeAddress.address)) { this.host.print("SV_AuthorizeIpPacket: not from authorize server\n"); return; }
    const number = nativeAtoi(argument(packet, 0)), challenge = state.challenges.find(value => value.challenge === number);
    if (challenge === undefined) { this.host.print("SV_AuthorizeIpPacket: challenge not found\n"); return; }
    challenge.pingTime = state.time;
    const result = argument(packet, 1).toLowerCase(), reason = argument(packet, 2);
    if (result === "demo") {
      if (this.variableValue("fs_restrict") !== 0) { this.reply(challenge.address, `challengeResponse ${challenge.challenge}`); return; }
      this.reply(challenge.address, "print\nServer is not a demo server\n"); clearChallenge(challenge); return;
    }
    if (result === "accept") { this.reply(challenge.address, `challengeResponse ${challenge.challenge}`); return; }
    if (`print\n${reason}\n`.length >= 1024) throw new RangeError("Authorization reason exceeds source buffer");
    this.reply(challenge.address, `print\n${reason}\n`); clearChallenge(challenge);
  }
  async process(from: ServerPacketAddress, input: Uint8Array): Promise<void> {
    await this.control.runConnectionless(async () => {
      const lifecycle = this.currentLifecycle();
      const address = owned(from), raw = new Uint8Array(input), packet = decodeConnectionless(raw, "server");
      this.host.debugPrint(`SV packet ${addressString(address)} : ${packet.command}\n`);
      this.control.assertCurrentOperation();
      switch (packet.command.toLowerCase()) {
        case "getstatus": this.status(lifecycle, address, packet); break;
        case "getinfo": this.info(lifecycle.staticState, address, packet); break;
        case "getchallenge": await this.getChallenge(lifecycle.staticState, address); break;
        case "connect": await runCalls(lifecycle.directConnect(address, argument(packet, 0))); break;
        case "ipauthorize": this.authorize(lifecycle.staticState, address, packet); break;
        case "rcon": await this.host.remoteCommand(address, raw, packet); break;
        case "disconnect": break;
        default: this.host.debugPrint(`bad connectionless packet from ${addressString(address)}:\n${packet.line}\n`); break;
      }
    });
  }

  async masterHeartbeat(): Promise<void> {
    await this.control.runHeartbeat(async () => {
      const state = this.currentLifecycle().staticState;
      if (this.cvar("dedicated").integerValue !== 2 || state.time < state.nextHeartbeatTime) return;
      state.nextHeartbeatTime = (state.time + 300000) | 0;
      for (let index = 0; index < this.control.masterAddresses.length; index++) {
        const key = `sv_master${index + 1}`, master = this.cvar(key);
        let name = sourceString(master.value);
        if (name.length === 0) continue;
        if (master.modified) {
          this.host.cvars.clearModified(key);
          this.host.print(`Resolving ${name}\n`);
          name = sourceString(this.cvar(key).value);
          let address: ServerPacketAddress | null;
          if (name === "localhost") address = { kind: "loopback" };
          else {
            const base = name.slice(0, 1023), colon = base.indexOf(":"), hostname = colon < 0 ? base : base.slice(0, colon);
            const port = colon < 0 ? 27960 : nativeAtoi(base.slice(colon + 1)) & 65535;
            address = await this.resolve(hostname, port);
          }
          if (address === null) {
            this.control.masterAddresses[index] = null;
            this.host.print(`Couldn't resolve address: ${sourceString(this.cvar(key).value)}\n`);
            this.host.cvars.set(key, "", true); this.host.cvars.clearModified(key); continue;
          }
          name = sourceString(this.cvar(key).value);
          // Pinned source uses strstr(":", name), not strstr(name, ":").
          if (address.kind === "ipv4") address = { kind: "ipv4", host: [...address.host], port: ":".includes(name) ? address.port : MASTER_SERVER_PORT };
          this.control.masterAddresses[index] = owned(address);
          const resolved = address.kind === "ipv4" ? addressString(address) : `0.0.0.0:${MASTER_SERVER_PORT}`;
          this.host.print(`${name} resolved to ${resolved}\n`);
        }
        const address = this.control.masterAddresses[index];
        if (address === undefined || address === null) throw new Error("Nonempty master cvar has no resolved source address");
        this.host.print(`Sending heartbeat to ${sourceString(this.cvar(key).value)}\n`);
        this.reply(address, "heartbeat QuakeArena-1\n");
      }
    });
  }
}
