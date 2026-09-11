// Server lists, ping requests and LAN_* accessors from id Software's cl_main.c,
// cl_ui.c and client.h. Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { CommandContext } from "../core/commands.ts";
import { CommonError } from "../core/common-error.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import { infoSetValueForKey, infoValueForKey } from "../core/info-string.ts";
import { nativeAtoi } from "../core/native-numeric.ts";
import { MASTER_SERVER_PORT, NETWORK_DEFAULTS } from "../core/network-defaults.ts";
import { sourceCommandText } from "../core/text.ts";
import type { Ipv4Address } from "../platform/network.ts";
import type { UnixIo } from "../platform/unix-io.ts";
import { encodeConnectionlessText } from "../protocol/connectionless.ts";
import type { ConnectionlessPacket } from "../protocol/connectionless.ts";
import type { LoopbackTransport } from "../protocol/loopback.ts";
import type { ClientConnectionState, ClientPacketAddress, ClientStaticState } from "./client-state.ts";
import type { CommonEvents } from "./common-events.ts";
import type { CommonFileState } from "../assets/filesystem-state.ts";

export enum ServerBrowserSource { Local = 0, Mplayer = 1, Global = 2, Favorites = 3 }

export interface ServerBrowserOptions {
  readonly clientStatic: ClientStaticState;
  readonly cvars: CvarRegistry;
  readonly io: UnixIo;
  readonly loopback: LoopbackTransport;
  print(text: string): void;
  assertCurrentOperation(): void;
}

// Linux little-endian ABI profile: 4-byte enum/int/qboolean, 2-byte ushort.
// netadr_t is 20 bytes: type@0, ip@4, ipx@8, network-order port@18.
// serverInfo_t adds three 32-byte strings and nine ints, with no padding: 152 bytes.
const SERVER_RECORD_BYTES = 152;
const SERVER_CACHE_BYTES = (4096 + 128 + 128) * SERVER_RECORD_BYTES;

/** Actual source storage retains unused address bytes and bytes beyond a cleared name. */
class ServerRecord {
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  /** Q_stricmp reads signed source bytes only as reached, even across an unterminated name field. */
  compareText(other: ServerRecord, offset: 20 | 52): number {
    for (let index = offset; ; index++) {
      let left = this.view.getInt8(index), right = other.view.getInt8(index);
      if (left !== right) {
        if (left >= 97 && left <= 122) left -= 32;
        if (right >= 97 && right <= 122) right -= 32;
        if (left !== right) return left < right ? -1 : 1;
      }
      if (left === 0) return 0;
    }
  }
  get address(): ClientPacketAddress | null {
    const type = this.view.getInt32(0, true);
    if (type === 0) return null;
    if (type === 2) return { kind: "loopback" };
    if (type !== 4) throw new Error(`Cached server address type ${type} is unsupported by this client transport`);
    return { kind: "ipv4", host: [this.view.getUint8(4), this.view.getUint8(5), this.view.getUint8(6), this.view.getUint8(7)],
      port: this.view.getUint16(18, false) };
  }
  matchesAddress(address: ClientPacketAddress): boolean {
    // NET_CompareAdr rejects unequal types before interpreting either address payload.
    if (this.view.getInt32(0, true) !== (address.kind === "loopback" ? 2 : 4)) return false;
    if (address.kind === "loopback") return true;
    return address.host.every((octet, index) => octet === this.view.getUint8(4 + index))
      && address.port === this.view.getUint16(18, false);
  }
  set address(value: ClientPacketAddress | null) {
    // Typed address assignments have no native stack IPX bytes; use zero for those bytes.
    this.bytes.fill(0, 0, 20);
    if (value !== null) this.initializeAddress(value);
  }
  initializeAddress(value: ClientPacketAddress): void {
    if (value.kind === "loopback") { this.bytes.fill(0, 0, 20); this.view.setInt32(0, 2, true); return; }
    this.view.setInt32(0, 4, true);
    this.bytes.set(value.host, 4); this.view.setUint16(18, value.port, false);
  }
  private text(offset: number): string {
    let result = "";
    for (let index = offset; index < offset + 32; index++) {
      const byte = this.view.getUint8(index);
      if (byte === 0) return result;
      result += String.fromCharCode(byte);
    }
    throw new Error("Cached server string is not terminated within its source field");
  }
  private setText(offset: number, input: string): void {
    const text = sourceCommandText(input).slice(0, 31);
    this.bytes.fill(0, offset, offset + 32);
    for (let index = 0; index < text.length; index++) this.bytes[offset + index] = text.charCodeAt(index);
  }
  clearNames(): void { this.bytes[20] = 0; this.bytes[52] = 0; this.bytes[84] = 0; }
  copyFrom(source: ServerRecord): void { this.bytes.set(source.bytes); }
  clearPreservingVisibility(): void {
    const visible = this.view.getInt32(144, true);
    this.bytes.fill(0); this.view.setInt32(144, visible, true);
  }
  get hostName(): string { return this.text(20); }
  set hostName(value: string) { this.setText(20, value); }
  get mapName(): string { return this.text(52); }
  set mapName(value: string) { this.setText(52, value); }
  get game(): string { return this.text(84); }
  set game(value: string) { this.setText(84, value); }
  get netType(): number { return this.view.getInt32(116, true); }
  set netType(value: number) { this.view.setInt32(116, value, true); }
  get gameType(): number { return this.view.getInt32(120, true); }
  set gameType(value: number) { this.view.setInt32(120, value, true); }
  get clients(): number { return this.view.getInt32(124, true); }
  set clients(value: number) { this.view.setInt32(124, value, true); }
  get maxClients(): number { return this.view.getInt32(128, true); }
  set maxClients(value: number) { this.view.setInt32(128, value, true); }
  get minPing(): number { return this.view.getInt32(132, true); }
  set minPing(value: number) { this.view.setInt32(132, value, true); }
  get maxPing(): number { return this.view.getInt32(136, true); }
  set maxPing(value: number) { this.view.setInt32(136, value, true); }
  get ping(): number { return this.view.getInt32(140, true); }
  set ping(value: number) { this.view.setInt32(140, value, true); }
  get visibleValue(): number { return this.view.getInt32(144, true); }
  set visibleValue(value: number) { this.view.setInt32(144, value, true); }
  get visible(): boolean { return this.visibleValue !== 0; }
  set visible(value: boolean) { this.visibleValue = value ? 1 : 0; }
  get punkbuster(): number { return this.view.getInt32(148, true); }
  set punkbuster(value: number) { this.view.setInt32(148, value, true); }
}

class ServerList {
  readonly countBytes = new Uint8Array(4);
  private readonly countView = new DataView(this.countBytes.buffer);
  readonly bytes: Uint8Array;
  readonly records: ServerRecord[];
  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity * SERVER_RECORD_BYTES);
    this.records = Array.from({ length: capacity }, (_, index) =>
      new ServerRecord(this.bytes.subarray(index * SERVER_RECORD_BYTES, (index + 1) * SERVER_RECORD_BYTES)));
  }
  get count(): number { return this.countView.getInt32(0, true); }
  set count(value: number) { this.countView.setInt32(0, value, true); }
}
interface PingRecord { address: ClientPacketAddress | null; start: number; time: number; info: string }
interface ServerStatusRecord {
  address: ClientPacketAddress | null;
  string: string;
  time: number;
  startTime: number;
  pending: boolean;
  print: boolean;
  retrieved: boolean;
}
export interface ServerPing { readonly address: string; readonly time: number }

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (!Number.isInteger(index) || value === undefined) throw new RangeError(`Server browser source index ${index} outside ${values.length}`);
  return value;
}
function clockInt32(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Undefined native server browser clock arithmetic");
  return value;
}
function copyAddress(address: ClientPacketAddress): ClientPacketAddress {
  if (address.kind === "loopback") return Object.freeze({ kind: "loopback" });
  const [a, b, c, d] = address.host;
  return Object.freeze({ kind: "ipv4", host: Object.freeze([a, b, c, d] satisfies typeof address.host), port: address.port });
}
function hasPort(address: ClientPacketAddress | null): boolean { return address !== null && address.kind === "ipv4" && address.port !== 0; }
function sameAddress(first: ClientPacketAddress, second: ClientPacketAddress | null): boolean {
  if (second === null || first.kind !== second.kind) return false;
  if (first.kind === "loopback") return true;
  return second.kind === "ipv4" && first.port === second.port && first.host.every((octet, index) => octet === second.host[index]);
}
function addressText(address: ClientPacketAddress | null): string {
  if (address === null) return "bot";
  return address.kind === "loopback" ? "loopback" : `${address.host.join(".")}:${address.port}`;
}
function copyString(text: string, bufferLength: number): string {
  if (!Number.isInteger(bufferLength) || bufferLength < -2147483648 || bufferLength > 2147483647) throw new RangeError("Q_strncpyz requires a source int destination size");
  if (bufferLength < 1) throw new CommonError("fatal", "Q_strncpyz: destsize < 1");
  return text.slice(0, bufferLength - 1);
}
function readString(bytes: Uint8Array, start: number): { readonly text: string; readonly next: number } {
  let text = "", next = start;
  while (text.length < 1023) {
    const byte = bytes[next++];
    if (byte === undefined || byte === 0) break;
    text += String.fromCharCode(byte === 37 || byte > 127 ? 46 : byte);
  }
  return { text, next };
}

/** MSG_ReadStringLine preserves high bytes, unlike MSG_ReadString above. */
function readStatusLine(bytes: Uint8Array, start: number): { readonly text: string; readonly next: number } {
  let text = "", next = start;
  while (text.length < 1023) {
    const byte = bytes[next++];
    if (byte === undefined || byte === 0 || byte === 10) break;
    text += String.fromCharCode(byte === 37 ? 46 : byte);
  }
  return { text, next };
}

/** Client-static lists, cache, pings and status requests. The engine owns polling. */
export class ServerBrowser {
  private readonly local = new ServerList(128);
  private readonly mplayer = new ServerList(128);
  private readonly global = new ServerList(4096);
  private readonly favorites = new ServerList(128);
  private readonly overflow: Ipv4Address[] = [];
  private readonly pings: PingRecord[] = Array.from({ length: 32 }, () => ({ address: null, start: 0, time: 0, info: "" }));
  private readonly statuses: ServerStatusRecord[] = Array.from({ length: 16 }, () => ({
    address: null, string: "", time: 0, startTime: 0, pending: false, print: false, retrieved: false,
  }));
  private pingUpdateSource: ServerBrowserSource = ServerBrowserSource.Local;
  private masterNum = 0;

  constructor(readonly options: ServerBrowserOptions) {}

  loadCachedServers(files: CommonFileState): void {
    this.entry();
    this.global.count = 0; this.mplayer.count = 0; this.favorites.count = 0; this.overflow.length = 0;
    const opened = files.server.openRead("servercache.dat"); this.entry();
    // The source skips closing a successfully opened empty file; common retains its handle.
    if (opened === null || opened.length === 0) return;
    for (const list of [this.global, this.mplayer, this.favorites]) {
      files.current.readInto(opened.file, list.countBytes); this.entry();
    }
    const sizeBytes = new Uint8Array(4);
    const copied = files.current.readInto(opened.file, sizeBytes); this.entry();
    if (copied !== 4) throw new Error("Short server cache header leaves the source local size uninitialized");
    if (new DataView(sizeBytes.buffer).getInt32(0, true) === SERVER_CACHE_BYTES) {
      for (const list of [this.global, this.mplayer, this.favorites]) {
        files.current.readInto(opened.file, list.bytes); this.entry();
      }
    } else {
      this.global.count = 0; this.mplayer.count = 0; this.favorites.count = 0; this.overflow.length = 0;
    }
    files.current.closeFile(opened.file); this.entry();
  }

  saveServersToCache(files: CommonFileState): void {
    this.entry();
    const file = files.server.openWrite("servercache.dat"); this.entry();
    if (file === null) { files.server.closeZeroHandle(); this.entry(); return; }
    for (const list of [this.global, this.mplayer, this.favorites]) { file.writeBytes(list.countBytes); this.entry(); }
    const size = new Uint8Array(4); new DataView(size.buffer).setInt32(0, SERVER_CACHE_BYTES, true);
    file.writeBytes(size); this.entry();
    for (const list of [this.global, this.mplayer, this.favorites]) { file.writeBytes(list.bytes); this.entry(); }
    file.close(); this.entry();
  }

  getServerCount(source: ServerBrowserSource): number { this.entry(); return this.list(source)?.count ?? 0; }
  getServerAddressString(source: ServerBrowserSource, index: number, bufferLength: number,
    writeAddress?: (address: string) => undefined): string {
    this.entry();
    const record = this.record(source, index);
    if (record === null) return "";
    const address = addressText(record.address);
    writeAddress?.(address);
    return copyString(address, bufferLength);
  }
  getServerInfo(source: ServerBrowserSource, index: number, bufferLength: number,
    writeInfo?: (info: string) => undefined): string {
    this.entry();
    const server = this.record(source, index);
    if (server === null) return "";
    let info = "";
    const set = (key: string, value: string): void => {
      info = infoSetValueForKey(info, key, value, text => { this.print(text); });
    };
    set("hostname", server.hostName);
    set("mapname", server.mapName);
    set("clients", String(server.clients));
    set("sv_maxclients", String(server.maxClients));
    set("ping", String(server.ping));
    set("minping", String(server.minPing));
    set("maxping", String(server.maxPing));
    set("game", server.game);
    set("gametype", String(server.gameType));
    set("nettype", String(server.netType));
    set("addr", addressText(server.address));
    set("punkbuster", String(server.punkbuster));
    writeInfo?.(info);
    return copyString(info, bufferLength);
  }
  getServerPing(source: ServerBrowserSource, index: number): number { this.entry(); return this.record(source, index)?.ping ?? -1; }
  compareServers(source: ServerBrowserSource, sortKey: number, sortDir: number, first: number, second: number): number {
    this.entry();
    const left = this.record(source, first), right = this.record(source, second);
    if (left === null || right === null) return 0;
    let result = 0;
    switch (sortKey) {
      case 0: result = left.compareText(right, 20); break;
      case 1: result = left.compareText(right, 52); break;
      case 2: result = left.clients < right.clients ? -1 : left.clients > right.clients ? 1 : 0; break;
      case 3: result = left.gameType < right.gameType ? -1 : left.gameType > right.gameType ? 1 : 0; break;
      case 4: result = left.ping < right.ping ? -1 : left.ping > right.ping ? 1 : 0; break;
    }
    return sortDir === 0 ? result : result < 0 ? 1 : result > 0 ? -1 : 0;
  }
  resetPings(source: ServerBrowserSource): void {
    this.entry();
    const list = this.list(source);
    if (list !== null) for (const record of list.records) record.ping = -1;
  }
  markServerVisible(source: ServerBrowserSource, index: number, visible: boolean): void {
    this.markServerVisibleValue(source, index, visible ? 1 : 0);
  }
  markServerVisibleValue(source: ServerBrowserSource, index: number, visible: number): void {
    this.entry();
    if (index === -1) {
      const list = this.list(source);
      if (list !== null) for (const record of list.records) record.visibleValue = visible;
    } else {
      const record = this.record(source, index);
      if (record !== null) record.visibleValue = visible;
    }
  }
  serverIsVisible(source: ServerBrowserSource, index: number): boolean { return this.serverVisibilityValue(source, index) !== 0; }
  serverVisibilityValue(source: ServerBrowserSource, index: number): number { this.entry(); return this.record(source, index)?.visibleValue ?? 0; }

  async addServer(source: ServerBrowserSource, name: string | (() => string), address: string | (() => string)): Promise<-1 | 0 | 1> {
    this.entry();
    const list = this.list(source);
    if (list === null || list.count >= list.records.length) return -1;
    const resolved = await this.resolveAddress(typeof address === "string" ? address : address());
    this.entry();
    if (resolved === null) throw new Error("LAN_AddServer: failed resolution leaves an undefined native address");
    for (let index = 0; index < list.count; index++) if (at(list.records, index).matchesAddress(resolved)) return 0;
    const record = at(list.records, list.count);
    record.address = resolved;
    record.hostName = copyString(sourceCommandText(typeof name === "string" ? name : name()), 32);
    record.visible = true;
    list.count++;
    return 1;
  }
  async removeServer(source: ServerBrowserSource, address: string | (() => string)): Promise<void> {
    this.entry();
    const list = this.list(source);
    if (list === null) return;
    const resolved = await this.resolveAddress(typeof address === "string" ? address : address());
    this.entry();
    if (resolved === null) throw new Error("LAN_RemoveServer: failed resolution leaves an undefined native address");
    for (let index = 0; index < list.count; index++) {
      if (!at(list.records, index).matchesAddress(resolved)) continue;
      for (let next = index; next < list.count - 1; next++) at(list.records, next).copyFrom(at(list.records, next + 1));
      list.count--;
      break; // The last row remains intact, and accessors are bounded by capacity, not count.
    }
  }

  getPingQueueCount(): number { this.entry(); return this.pings.filter(ping => hasPort(ping.address)).length; }
  clearPing(index: number): void {
    this.entry();
    if (!Number.isInteger(index) || index < 0 || index >= 32) return;
    this.clearPingPort(at(this.pings, index));
  }
  getPing(index: number, bufferLength: number, writeAddress?: (address: string | null) => undefined): ServerPing {
    this.entry();
    const ping = at(this.pings, index);
    if (!hasPort(ping.address)) { writeAddress?.(null); return { address: "", time: 0 }; }
    const text = addressText(ping.address);
    writeAddress?.(text);
    const address = copyString(text, bufferLength);
    let time = ping.time;
    if (time === 0) {
      time = clockInt32(this.options.clientStatic.realtime - ping.start);
      const maxPing = this.options.cvars.get("cl_maxPing");
      if (time < Math.max(100, maxPing === undefined ? 0 : maxPing.integerValue)) time = 0; // Absent Cvar_VariableIntegerValue is zero.
    }
    this.setInfoByAddress(ping.address, ping.info, ping.time);
    return { address, time };
  }
  getPingInfo(index: number, bufferLength: number): string {
    return this.sourcePingInfo(index, bufferLength) ?? "";
  }
  updateServerInfo(index: number): void {
    this.entry();
    const ping = at(this.pings, index);
    if (!hasPort(ping.address)) return;
    this.setInfoByAddress(ping.address, ping.info, ping.time);
  }
  sourcePingInfo(index: number, bufferLength: number, writeInfo?: (info: string) => undefined): string | null {
    this.entry();
    const ping = at(this.pings, index);
    if (!hasPort(ping.address)) return null;
    writeInfo?.(ping.info);
    return copyString(ping.info, bufferLength);
  }

  localServers(): void {
    this.entry();
    this.print("Scanning for servers on the local network...\n");
    this.local.count = 0;
    this.pingUpdateSource = ServerBrowserSource.Local;
    for (const record of this.local.records) record.clearPreservingVisibility();
    const bytes = encodeConnectionlessText("getinfo xxx");
    for (let attempt = 0; attempt < 2; attempt++) for (let offset = 0; offset < 4; offset++) {
      this.send("client", { kind: "ipv4", host: [255, 255, 255, 255], port: 27960 + offset }, bytes);
      // Unix's unopened ipx_socket discards the paired NA_BROADCAST_IPX send after NET_SendPacket's trace.
      this.traceSend(bytes);
    }
  }

  async globalServersCommand(context: CommandContext): Promise<void> {
    this.entry(); context.assertActive();
    if (context.argv.length < 3) { this.print("usage: globalservers <master# 0-1> <protocol> [keywords]\n"); return; }
    this.masterNum = nativeAtoi(at(context.argv, 1));
    this.print("Requesting servers from the master...\n");
    const mplayer = this.masterNum === 1;
    const address = await this.options.io.resolveAddress(NETWORK_DEFAULTS.masterServer, MASTER_SERVER_PORT);
    this.entry(); context.assertActive();
    if (address === null) throw new Error("CL_GlobalServers_f: failed master resolution leaves an undefined native address");
    if (mplayer) { this.mplayer.count = -1; this.pingUpdateSource = ServerBrowserSource.Mplayer; }
    else { this.global.count = -1; this.pingUpdateSource = ServerBrowserSource.Global; }
    let command = `getservers ${at(context.argv, 2)}`;
    for (const keyword of context.argv.slice(3)) command += ` ${keyword}`;
    const restrict = this.options.cvars.get("fs_restrict");
    if (restrict !== undefined && Math.fround(restrict.numericValue) !== 0) command += " demo";
    if (command.length >= 1024) throw new RangeError("CL_GlobalServers_f would overflow its source command buffer");
    if (command.replace(/%%/g, "").includes("%")) throw new RangeError("CL_GlobalServers_f has undefined native variadic formatting in its command");
    this.send("server", { ...address, port: MASTER_SERVER_PORT }, encodeConnectionlessText(command.replace(/%%/g, "%")));
  }

  async pingCommand(context: CommandContext): Promise<void> {
    this.entry(); context.assertActive();
    if (context.argv.length !== 2) { this.print("usage: ping [server]\n"); return; }
    const address = await this.resolveAddress(at(context.argv, 1));
    this.entry(); context.assertActive();
    if (address === null) return;
    const ping = this.freePing();
    ping.address = address;
    ping.start = this.options.clientStatic.realtime;
    ping.time = 0; // Reusing a slot intentionally retains its old info string.
    this.setInfoByAddress(address, null, 0);
    this.send("client", address, encodeConnectionlessText("getinfo xxx"));
  }

  private getServerStatus(address: ClientPacketAddress): ServerStatusRecord {
    for (const status of this.statuses) if (sameAddress(address, status.address)) return status;
    for (const status of this.statuses) if (status.retrieved) return status;
    let oldest = at(this.statuses, 0);
    for (const status of this.statuses) if (status.startTime < oldest.startTime) oldest = status;
    // The source counter fallback is unreachable with its fixed nonempty 16-slot array.
    return oldest;
  }

  /** CL_ServerStatus/LAN_GetServerStatus: null address resets all, null size resets one. */
  async serverStatus(serverAddress: string | null, bufferLength: number | null, clock: Pick<CommonEvents, "milliseconds">,
    writeStatus?: (text: string) => undefined): Promise<string | null> {
    this.entry();
    if (serverAddress === null) {
      for (const status of this.statuses) {
        if (status.address?.kind === "ipv4") status.address = { ...status.address, port: 0 };
        status.retrieved = true;
      }
      return null;
    }
    const to = await this.resolveAddress(serverAddress);
    this.entry();
    if (to === null) return null;
    const status = this.getServerStatus(to);
    if (bufferLength === null) { status.retrieved = true; return null; }
    if (sameAddress(to, status.address)) {
      if (!status.pending) {
        writeStatus?.(status.string);
        const result = copyString(status.string, bufferLength);
        status.retrieved = true; status.startTime = 0;
        return result;
      }
      const resend = this.options.cvars.get("cl_serverStatusResendTime");
      if (resend === undefined) throw new Error("Server status requires the CL_Init resend cvar");
      const now = this.statusMilliseconds(clock);
      if (status.startTime < clockInt32(now - resend.integerValue)) {
        status.print = false; status.pending = true; status.retrieved = false; status.time = 0;
        status.startTime = this.statusMilliseconds(clock);
        this.send("client", to, encodeConnectionlessText("getstatus"));
      }
    } else if (status.retrieved) {
      status.address = to; status.print = false; status.pending = true; status.retrieved = false;
      status.startTime = this.statusMilliseconds(clock); status.time = 0;
      this.send("client", to, encodeConnectionlessText("getstatus"));
    }
    return null;
  }

  /** CL_ServerStatus_f uses cls.servername for its no-address form, not the netchannel address. */
  async serverStatusCommand(context: CommandContext, connection: Pick<ClientConnectionState, "demoPlaying">): Promise<void> {
    this.entry(); context.assertActive();
    let server: string;
    if (context.argv.length !== 2) {
      if (this.options.clientStatic.phase !== "active" || connection.demoPlaying) {
        this.print("Not connected to a server.\n"); this.print("Usage: serverstatus [server]\n"); return;
      }
      server = this.options.clientStatic.servername;
    } else server = at(context.argv, 1);
    const to = await this.resolveAddress(server);
    this.entry(); context.assertActive();
    if (to === null) return;
    this.send("client", to, encodeConnectionlessText("getstatus"));
    const status = this.getServerStatus(to);
    status.address = to; status.print = true; status.pending = true;
  }

  /** Receives bytes following the connectionless command line; it never polls sockets. */
  serverStatusResponse(from: ClientPacketAddress, payload: Uint8Array, clock: Pick<CommonEvents, "milliseconds">): void {
    this.entry();
    const status = this.statuses.find(record => sameAddress(from, record.address));
    if (status === undefined) return;
    let line = readStatusLine(payload, 0);
    status.string = this.statusFormat(line.text, 8192);
    if (status.print) {
      this.print("Server settings:\n");
      let cursor = 0;
      while (cursor < line.text.length) {
        for (let part = 0; part < 2 && cursor < line.text.length; part++) {
          if (line.text.charAt(cursor) === "\\") cursor++;
          let info = "";
          while (cursor < line.text.length) {
            info += line.text.charAt(cursor);
            if (info.length >= 1023) break;
            cursor++;
            if (line.text.charAt(cursor) === "\\") break;
          }
          this.print(part === 0 ? info.padEnd(24, " ") : `${info}\n`);
        }
      }
    }
    this.appendStatus(status, "\\");
    if (status.print) { this.print("\nPlayers:\n"); this.print("num: score: ping: name:\n"); }
    for (let index = 0; ; index++) {
      line = readStatusLine(payload, line.next);
      if (line.text === "") break;
      this.appendStatus(status, `\\${line.text}`);
      if (status.print) {
        const scoreMatch = /^[\t\n\v\f\r ]*[+-]?\d+/.exec(line.text);
        const score = scoreMatch === null ? 0 : nativeAtoi(scoreMatch[0]);
        const pingMatch = scoreMatch === null ? null : /^[\t\n\v\f\r ]*[+-]?\d+/.exec(line.text.slice(scoreMatch[0].length));
        const ping = pingMatch === null ? 0 : nativeAtoi(pingMatch[0]);
        const first = line.text.indexOf(" "), second = first < 0 ? -1 : line.text.indexOf(" ", first + 1);
        const name = second < 0 ? "unknown" : line.text.slice(second + 1);
        this.print(`${String(index).padEnd(2, " ")}   ${String(score).padEnd(3, " ")}    ${String(ping).padEnd(3, " ")}   ${name}\n`);
      }
    }
    this.appendStatus(status, "\\");
    status.time = this.statusMilliseconds(clock); status.address = copyAddress(from); status.pending = false;
    if (status.print) status.retrieved = true;
  }

  private statusMilliseconds(clock: Pick<CommonEvents, "milliseconds">): number {
    const value = clockInt32(clock.milliseconds()); this.entry(); return value;
  }
  private statusFormat(text: string, size: number): string {
    if (text.length >= size) this.print(`Com_sprintf: overflow of ${text.length} in ${size}\n`);
    return copyString(text, size);
  }
  private appendStatus(status: ServerStatusRecord, text: string): void {
    const start = status.string.length, suffix = this.statusFormat(text, 8192 - start);
    status.string = status.string.slice(0, start) + suffix;
  }

  updateVisiblePings(source: ServerBrowserSource): boolean {
    this.entry();
    const list = this.list(source);
    if (list === null) return false;
    this.pingUpdateSource = source;
    let slots = this.getPingQueueCount(), status = false;
    if (slots < 32) for (let index = 0; index < list.count; index++) {
      const server = at(list.records, index);
      if (!server.visible) continue;
      if (server.ping === -1) {
        if (slots >= 32) break;
        const address = server.address;
        if (address !== null && this.pings.some(ping => hasPort(ping.address) && sameAddress(address, ping.address))) continue;
        status = true;
        const ping = this.pings.find(row => !hasPort(row.address));
        if (ping === undefined) throw new RangeError("CL_UpdateVisiblePings_f exhausted its source ping slots");
        ping.address = address; ping.start = this.options.clientStatic.realtime; ping.time = 0;
        this.send("client", address, encodeConnectionlessText("getinfo xxx"));
        slots++;
      } else if (server.ping === 0 && source === ServerBrowserSource.Global && this.overflow.length > 0) {
        const address = this.overflow.pop();
        if (address === undefined) throw new Error("Missing overflow server address");
        this.initServer(server, address);
      }
    }
    if (slots !== 0) status = true;
    for (let index = 0; index < 32; index++) {
      if (!hasPort(at(this.pings, index).address)) continue;
      if (this.getPing(index, 1024).time !== 0) { this.clearPing(index); status = true; }
    }
    return status;
  }

  /** Dispatch admission's returned connectionless packet with its original datagram. No polling or duplicate packet clock. */
  handleConnectionless(from: ClientPacketAddress, packet: ConnectionlessPacket, rawDatagram: Uint8Array): boolean {
    this.entry();
    if (packet.command.toLowerCase() === "inforesponse") { this.serverInfoPacket(from, packet.payload); return true; }
    if (packet.command.startsWith("getserversResponse")) { this.serversResponsePacket(rawDatagram); return true; }
    return false;
  }

  private serverInfoPacket(from: ClientPacketAddress, payload: Uint8Array): void {
    const info = readString(payload, 0);
    if (nativeAtoi(infoValueForKey(info.text, "protocol")) !== 68) {
      this.debugPrint(`Different protocol info packet: ${info.text}\n`); return;
    }
    for (const ping of this.pings) if (hasPort(ping.address) && ping.time === 0 && sameAddress(from, ping.address)) {
      ping.time = clockInt32(this.options.clientStatic.realtime - ping.start + 1);
      this.debugPrint(`ping time ${ping.time}ms from ${addressText(from)}\n`);
      ping.info = info.text;
      ping.info = infoSetValueForKey(ping.info, "nettype", from.kind === "ipv4" ? "1" : "0", text => { this.print(text); });
      this.setInfoByAddress(from, info.text, ping.time);
      return;
    }
    if (this.pingUpdateSource !== ServerBrowserSource.Local) return;
    let index = 0;
    while (index < 128) {
      const server = at(this.local.records, index);
      if (!hasPort(server.address)) break;
      if (server.matchesAddress(from)) return;
      index++;
    }
    if (index === 128) { this.debugPrint("MAX_OTHER_SERVERS hit, dropping infoResponse\n"); return; }
    this.local.count = index + 1;
    const server = at(this.local.records, index);
    server.address = from;
    this.initServer(server, from);
    server.netType = from.kind === "ipv4" ? 4 : 2; // netadrtype_t, not UI's nettype value.
    server.punkbuster = 0;
    const extra = readString(payload, info.next).text;
    if (extra.length === 1023 && !extra.endsWith("\n")) throw new RangeError("CL_ServerInfoPacket would overflow its source announcement buffer");
    if (extra.length > 0) this.print(`${addressText(from)}: ${extra.endsWith("\n") ? extra : `${extra}\n`}`);
  }

  private serversResponsePacket(bytes: Uint8Array): void {
    this.print("CL_ServersResponsePacket\n");
    if (this.global.count === -1) { this.global.count = 0; this.overflow.length = 0; }
    if (this.mplayer.count === -1) this.mplayer.count = 0;
    const addresses: Ipv4Address[] = [];
    let cursor = 0;
    while (cursor + 1 < bytes.length) {
      while (cursor < bytes.length) if (bytes[cursor++] === 92) break;
      if (cursor >= bytes.length - 6) break;
      const a = at(bytes, cursor++), b = at(bytes, cursor++), c = at(bytes, cursor++), d = at(bytes, cursor++);
      const port = at(bytes, cursor++) * 256 + at(bytes, cursor++);
      if (bytes[cursor] !== 92) break;
      this.debugPrint(`server: ${addresses.length} ip: ${a}.${b}.${c}.${d}:${((port & 255) << 8) | (port >>> 8)}\n`);
      addresses.push({ kind: "ipv4", host: [a, b, c, d], port });
      if (addresses.length === 256) break;
      if (at(bytes, cursor + 1) === 69 && at(bytes, cursor + 2) === 79 && at(bytes, cursor + 3) === 84) break;
    }
    const list = this.masterNum === 0 ? this.global : this.mplayer;
    let count = list.count, index = 0;
    while (index < addresses.length && count < list.records.length) this.initServer(at(list.records, count++), at(addresses, index++));
    if (this.masterNum === 0 && this.overflow.length < 4096) while (index < addresses.length && count >= 4096) {
      if (this.overflow.length === 4096) throw new RangeError("CL_ServersResponsePacket would overrun its source overflow-address array");
      this.overflow.push(at(addresses, index++));
    }
    list.count = count;
    this.print(`${addresses.length} servers parsed (total ${count + (this.masterNum === 0 ? this.overflow.length : 0)})\n`);
  }

  private initServer(server: ServerRecord, address: ClientPacketAddress): void {
    server.initializeAddress(address); server.clients = 0; server.clearNames();
    server.maxClients = 0; server.maxPing = 0; server.minPing = 0; server.ping = -1;
    server.gameType = 0; server.netType = 0;
    // CL_InitServerInfo preserves visible and punkbuster from the prior row.
  }
  private setInfoByAddress(address: ClientPacketAddress | null, info: string | null, ping: number): void {
    if (address === null) return;
    for (const list of [this.local, this.mplayer, this.global, this.favorites]) for (const server of list.records) {
      if (!server.matchesAddress(address)) continue;
      if (info !== null) {
        server.clients = nativeAtoi(infoValueForKey(info, "clients"));
        server.hostName = copyString(infoValueForKey(info, "hostname"), 32);
        server.mapName = copyString(infoValueForKey(info, "mapname"), 32);
        server.maxClients = nativeAtoi(infoValueForKey(info, "sv_maxclients"));
        server.game = copyString(infoValueForKey(info, "game"), 32);
        server.gameType = nativeAtoi(infoValueForKey(info, "gametype"));
        server.netType = nativeAtoi(infoValueForKey(info, "nettype"));
        server.minPing = nativeAtoi(infoValueForKey(info, "minping"));
        server.maxPing = nativeAtoi(infoValueForKey(info, "maxping"));
        server.punkbuster = nativeAtoi(infoValueForKey(info, "punkbuster"));
      }
      server.ping = ping;
    }
  }
  private freePing(): PingRecord {
    const now = this.options.clientStatic.realtime;
    for (const ping of this.pings) {
      if (hasPort(ping.address) && (ping.time === 0 ? clockInt32(now - ping.start) < 500 : ping.time < 500)) continue;
      this.clearPingPort(ping); return ping;
    }
    let best = at(this.pings, 0), oldest = -2147483648;
    for (const ping of this.pings) {
      const age = clockInt32(now - ping.start);
      if (age > oldest) { oldest = age; best = ping; }
    }
    return best;
  }
  private clearPingPort(ping: PingRecord): void {
    if (ping.address !== null && ping.address.kind === "ipv4") ping.address = { ...ping.address, port: 0 };
  }
  private async resolveAddress(input: string): Promise<ClientPacketAddress | null> {
    const text = sourceCommandText(input);
    if (text === "localhost") return { kind: "loopback" };
    const base = text.slice(0, 1023), separator = base.indexOf(":");
    const host = separator < 0 ? base : base.slice(0, separator);
    const port = separator < 0 ? 27960 : nativeAtoi(base.slice(separator + 1)) & 65535;
    const resolved = await this.options.io.resolveAddress(host, port === 0 ? 27960 : port);
    this.entry();
    if (resolved === null || resolved.host.every(octet => octet === 255)) return null;
    return copyAddress({ ...resolved, port });
  }
  private list(source: ServerBrowserSource): ServerList | null {
    switch (source) {
      case ServerBrowserSource.Local: return this.local;
      case ServerBrowserSource.Mplayer: return this.mplayer;
      case ServerBrowserSource.Global: return this.global;
      case ServerBrowserSource.Favorites: return this.favorites;
      default: return null;
    }
  }
  private record(source: ServerBrowserSource, index: number): ServerRecord | null {
    const list = this.list(source);
    return list === null || !Number.isInteger(index) ? null : list.records[index] ?? null;
  }
  private send(endpoint: "client" | "server", address: ClientPacketAddress | null, bytes: Uint8Array): void {
    this.traceSend(bytes);
    if (address === null) return;
    if (address.kind === "loopback") this.options.loopback.send(endpoint, bytes);
    else {
      const udp = this.options.io.udp;
      if (udp !== null) {
        let queued: boolean;
        try { queued = udp.send(address, bytes); }
        catch (error) {
          // Actual Bun/Linux send(...,0,...) reports the source sendto EINVAL. Keep other failures opaque.
          if (address.port === 0 && error instanceof Error && "code" in error && error.code === "EINVAL"
            && "errno" in error && error.errno === -22 && "syscall" in error && error.syscall === "send") {
            this.print(`NET_SendPacket ERROR: Invalid argument to ${addressText(address)}\n`);
            return;
          }
          throw error;
        }
        if (!queued) this.debugPrint("Sys_SendPacket: UDP socket could not queue packet\n");
      }
    }
    this.entry();
  }
  private traceSend(bytes: Uint8Array): void {
    const show = this.options.cvars.get("showpackets");
    if (show !== undefined && show.integerValue !== 0) this.print(`send packet ${String(bytes.length).padStart(4, " ")}\n`);
  }
  private entry(): void { this.options.assertCurrentOperation(); }
  private print(text: string): void { this.options.print(text); this.entry(); }
  private debugPrint(text: string): void {
    const developer = this.options.cvars.get("developer");
    if (developer !== undefined && developer.integerValue !== 0) this.print(text);
  }
}
