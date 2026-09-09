// Arena Servers from id Software code/q3_ui/ui_servers2.c. GPL-2.0-or-later.
import type { CommandBuffer } from "../../core/commands.ts";
import { infoSetValueForKey, infoValueForKey } from "../../core/info-string.ts";
import { KeyCode } from "../../core/key-codes.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { ServerBrowserSource } from "../../engine/server-browser.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_INVERSE, UI_SMALLFONT } from "../../render/font.ts";
import type { BaseConfirmMenu } from "./confirm.ts";
import { clampCvar } from "./draw.ts";
import { addItem, defaultKey, drawMenu, menuItemAtCursor, popMenu, pushMenu, scrollKey } from "./framework.ts";
import type { BaseSpecifyServerMenu } from "./specify-server.ts";
import type { BaseStartServerMenu } from "./start-server.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag, menuSound, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuRadio, MenuScroll, MenuSound, MenuSpin, MenuText } from "./state.ts";

const ART = "menu/art/", UNKNOWN = `${ART}unknownmap`;
const WORLD = "Visit www.quake3world.com - News, Community, Events, Files";
const GAMES = ["DM ", "1v1", "SP ", "Team DM", "CTF", "One Flag CTF", "OverLoad", "Harvester", "Rocket Arena 3", "Q3F", "Urban Terror", "OSP", "???"];
const NETS = ["???", "UDP", "IPX"];
const PULSE = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
enum Id { Master = 10, GameType, Sort, Full, Empty, List, Up, Down, Back, Refresh, Specify, Create, Connect, Remove, Punkbuster }

class ServerNode {
  address = ""; hostname = ""; mapname = ""; clients = 0; maxclients = 0; ping = 0;
  gametype = 0; gamename = ""; nettype = 0; minPing = 0; maxPing = 0; punkbuster = 0;
}

/* Server-record translation of game/bg_lib.c qsort.
 * Copyright (c) 1992, 1993 The Regents of the University of California.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. All advertising materials mentioning features or use of this software
 *    must display the following acknowledgement: This product includes software
 *    developed by the University of California, Berkeley and its contributors.
 * 4. Neither the name of the University nor the names of its contributors may
 *    be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE REGENTS AND CONTRIBUTORS ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE REGENTS OR CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function sortServerNodes(values: readonly ServerNode[], count: number, compareNodes: (first: ServerNode, second: ServerNode) => number): void {
  const cmp = (a: number, b: number): number => compareNodes(itemAt(values, a), itemAt(values, b));
  const swap = (a: number, b: number): void => {
    const first = itemAt(values, a), second = itemAt(values, b), saved = { ...first };
    Object.assign(first, second); Object.assign(second, saved);
  };
  const swapRange = (a: number, b: number, length: number): void => { for (let i = 0; i < length; i++) swap(a + i, b + i); };
  const median = (a: number, b: number, c: number): number => cmp(a, b) < 0
    ? cmp(b, c) < 0 ? b : cmp(a, c) < 0 ? c : a
    : cmp(b, c) > 0 ? b : cmp(a, c) < 0 ? a : c;
  const insertion = (start: number, length: number): void => {
    for (let mid = start + 1; mid < start + length; mid++) {
      for (let left = mid; left > start && cmp(left - 1, left) > 0; left--) swap(left, left - 1);
    }
  };
  function sort(start: number, length: number): void {
    while (true) {
      if (length < 7) { insertion(start, length); return; }
      let mid = start + Math.trunc(length / 2);
      if (length > 7) {
        let left = start, end = start + length - 1;
        if (length > 40) {
          const distance = Math.trunc(length / 8);
          left = median(left, left + distance, left + 2 * distance);
          mid = median(mid - distance, mid, mid + distance);
          end = median(end - 2 * distance, end - distance, end);
        }
        mid = median(left, mid, end);
      }
      swap(start, mid);
      let a = start + 1, b = a, c = start + length - 1, d = c, swapped = false;
      while (true) {
        while (b <= c) {
          const result = cmp(b, start); if (result > 0) break;
          if (result === 0) { swapped = true; swap(a, b); a++; } b++;
        }
        while (b <= c) {
          const result = cmp(c, start); if (result < 0) break;
          if (result === 0) { swapped = true; swap(c, d); d--; } c--;
        }
        if (b > c) break;
        swap(b, c); swapped = true; b++; c--;
      }
      if (!swapped) { insertion(start, length); return; }
      const end = start + length;
      let range = Math.min(a - start, b - a); swapRange(start, b - range, range);
      range = Math.min(d - c, end - d - 1); swapRange(b, end - range, range);
      if (b - a > 1) sort(start, b - a);
      range = d - c;
      if (range <= 1) return;
      start = end - range; length = range;
    }
  }
  sort(0, count);
}

class ServerList {
  readonly nodes: ServerNode[];
  count = 0;
  constructor(readonly capacity: number) { this.nodes = Array.from({ length: capacity }, () => new ServerNode()); }
  clear(): void { for (const node of this.nodes) Object.assign(node, new ServerNode()); this.count = 0; }
  clearForRefresh(): void {
    // Q3_VM: table_t is 68 chars + a 4-byte pointer; servernode_t is 152 bytes.
    // The source mistakenly uses sizeof(table_t), including a partial final node.
    let remaining = this.capacity * 72;
    for (const node of this.nodes) {
      if (remaining <= 0) break;
      const bytes = new Uint8Array(152), view = new DataView(bytes.buffer);
      writeString(bytes, 0, 64, node.address); writeString(bytes, 64, 25, node.hostname); writeString(bytes, 89, 16, node.mapname);
      writeString(bytes, 124, 12, node.gamename);
      const numbers = [node.clients, node.maxclients, node.ping, node.gametype, node.nettype, node.minPing, node.maxPing, node.punkbuster];
      const offsets = [108, 112, 116, 120, 136, 140, 144, 148];
      for (const [index, offset] of offsets.entries()) view.setInt32(offset, itemAt(numbers, index), true);
      bytes.fill(0, 0, Math.min(remaining, 152)); remaining -= 152;
      node.address = readString(bytes, 0, 64); node.hostname = readString(bytes, 64, 25); node.mapname = readString(bytes, 89, 16);
      node.gamename = readString(bytes, 124, 12);
      node.clients = view.getInt32(108, true); node.maxclients = view.getInt32(112, true); node.ping = view.getInt32(116, true);
      node.gametype = view.getInt32(120, true); node.nettype = view.getInt32(136, true); node.minPing = view.getInt32(140, true);
      node.maxPing = view.getInt32(144, true); node.punkbuster = view.getInt32(148, true);
    }
  }
}
function writeString(bytes: Uint8Array, offset: number, capacity: number, value: string): void {
  const text = sourceCommandText(value).slice(0, capacity - 1);
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  bytes[offset + text.length] = 0;
}
function readString(bytes: Uint8Array, offset: number, capacity: number): string {
  let result = "";
  for (let i = offset; i < offset + capacity; i++) { const byte = itemAt(bytes, i); if (byte === 0) return result; result += String.fromCharCode(byte); }
  throw new RangeError("Undefined native Arena Servers unterminated string");
}
function compare(a: string, b: string): number {
  const fold = (value: string): string => value.replace(/[a-z]/g, char => char.toUpperCase());
  a = fold(a); b = fold(b); return a < b ? -1 : a > b ? 1 : 0;
}
function cleanUpper(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i), next = text.charAt(i + 1), code = text.charCodeAt(i);
    if (ch === "^" && next !== "" && next !== "^") i++;
    else if (code >= 32 && code <= 126) result += ch;
  }
  return result.toUpperCase();
}
function bitmap(): MenuBitmap { return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null, width: 0, height: 0, focuscolor: null }; }
function spin(): MenuSpin { return { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0, top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 }; }
function radio(): MenuRadio { return { kind: "radio", common: new MenuCommon(), curvalue: 0 }; }
function text(): MenuText { return { kind: "text", common: new MenuCommon(), text: null, style: 0, color: COLORS.black }; }
class ArenaRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.black };
  readonly master = spin(); readonly gametype = spin(); readonly sort = spin(); readonly full = radio(); readonly empty = radio();
  readonly list: MenuScroll = { ...spin(), kind: "scroll" };
  readonly picture = bitmap(); readonly arrows = bitmap(); readonly up = bitmap(); readonly down = bitmap();
  readonly status = text(); readonly statusbar = text(); readonly remove = bitmap(); readonly back = bitmap();
  readonly refresh = bitmap(); readonly specify = bitmap(); readonly create = bitmap(); readonly go = bitmap();
  readonly punkbuster = spin(); readonly pblogo = bitmap();
  readonly items: BaseMenuItem[] = [this.banner, this.master, this.gametype, this.sort, this.full, this.empty, this.picture, this.list,
    this.status, this.statusbar, this.arrows, this.up, this.down, this.remove, this.back, this.specify, this.refresh, this.create, this.go, this.punkbuster, this.pblogo];
  readonly rows: { text: string; node: ServerNode | null }[] = Array.from({ length: 128 }, () => ({ text: "", node: null }));
  readonly names = Array.from({ length: 128 }, () => "");
  readonly pings = Array.from({ length: 32 }, () => ({ address: "", start: 0 }));
  readonly favorites = new Uint8Array(16 * 64);
  favoriteCount = 0; queried = 0; currentPing = 0; refreshing = false; nextPing = 0; refreshTime = 0;
  reset(): void {
    Object.assign(this.menu, new BaseMenu());
    for (const item of this.items) {
      Object.assign(item.common, new MenuCommon());
      switch (item.kind) {
        case "bitmap": Object.assign(item, bitmap(), { common: item.common }); break;
        case "spin": case "scroll": Object.assign(item, spin(), { common: item.common, kind: item.kind }); break;
        case "radio": item.curvalue = 0; break;
        case "text": case "banner": item.text = null; item.style = 0; item.color = COLORS.black; break;
      }
    }
    for (const row of this.rows) { row.text = ""; row.node = null; }
    this.names.fill(""); for (const ping of this.pings) { ping.address = ""; ping.start = 0; }
    this.favorites.fill(0); this.favoriteCount = 0; this.queried = 0; this.currentPing = 0; this.refreshing = false; this.nextPing = 0; this.refreshTime = 0;
  }
}

export class BaseArenaServersMenu {
  private readonly record = new ArenaRecord();
  private readonly local = new ServerList(128); private readonly global = new ServerList(128);
  private readonly mplayer = new ServerList(128); private readonly favorites = new ServerList(16);
  private servers = this.local;
  private source = -1; private game = 0; private sort = 0; private showEmpty = 0; private showFull = 0;
  private readonly callback: MenuCallback = (item, event) => this.event(item, event);
  constructor(readonly state: BaseUiState, private readonly browser: ServerBrowser, private readonly commands: CommandBuffer,
    private readonly startServer: BaseStartServerMenu, private readonly specify: BaseSpecifyServerMenu, private readonly confirm: BaseConfirmMenu) {
    if (commands !== state.services.consoleCommands || startServer.state !== state || specify.state !== state || confirm.state !== state)
      throw new Error("Arena Servers requires the actual shared command buffer and UI state");
  }
  get menu(): BaseMenu { return this.record.menu; }
  private value(name: string): number { this.state.assertActive(); return this.state.services.cvars.registry.get(name)?.numericValue ?? 0; }
  private string(name: string, size: number): string { this.state.assertActive(); return sourceCommandText(this.state.services.cvars.registry.get(name)?.value ?? "").slice(0, size - 1); }
  private set(name: string, value: string): void { this.state.assertActive(); this.state.services.cvars.registry.set(name, value, true); this.state.assertActive(); }
  private print(text: string): void { this.state.services.print(text); this.state.assertActive(); }
  private maximumPing(): number { return Math.max(100, qvmFloatToInt(this.value("cl_maxPing"))); }
  private format(value: string, size: number): string { if (value.length >= size) this.print(`Com_sprintf: overflow of ${value.length} in ${size}\n`); return value.slice(0, size - 1); }
  private sortServers(): void {
    sortServerNodes(this.servers.nodes, this.servers.count, (a, b) => {
      switch (this.sort) {
        case 0: return compare(a.hostname, b.hostname);
        case 1: return compare(a.mapname, b.mapname);
        case 2: return Math.sign(Math.max(0, Math.fround(nativeInt(b.maxclients - b.clients))) - Math.max(0, Math.fround(nativeInt(a.maxclients - a.clients))));
        case 3: return a.gametype < b.gametype ? -1 : a.gametype > b.gametype ? 1 : 0;
        case 4: return a.ping < b.ping ? -1 : a.ping > b.ping ? 1 : compare(a.hostname, b.hostname);
        default: return 0;
      }
    });
  }
  private updatePicture(): void {
    const r = this.record;
    if (r.list.numitems === 0) r.picture.common.name = null;
    else { const node = itemAt(r.rows, r.list.curvalue).node; if (node === null) throw new Error("Undefined native Arena Servers row pointer"); r.picture.common.name = this.format(`levelshots/${node.mapname}.tga`, 64); }
    r.picture.shader = null;
  }
  private updateMenu(): void {
    const r = this.record, controls = [r.master, r.gametype, r.sort, r.empty, r.full, r.list, r.refresh, r.go, r.punkbuster];
    const world = this.source === ServerBrowserSource.Global || this.source === ServerBrowserSource.Mplayer ? WORLD : "";
    if (r.queried > 0) {
      if (r.refreshing && r.currentPing <= r.queried) { r.status.text = this.format(`${r.currentPing} of ${r.queried} Arena Servers.`, 64); r.statusbar.text = "Press SPACE to stop"; this.sortServers(); }
      else { for (const control of controls) control.common.flags &= ~MenuFlag.Grayed; r.statusbar.text = world; }
    } else {
      if (r.refreshing) { r.status.text = "Scanning For Servers."; r.statusbar.text = "Press SPACE to stop"; for (const control of controls) control.common.flags |= MenuFlag.Grayed; }
      else {
        r.status.text = r.queried < 0 ? "No Response From Master Server." : "No Servers Found."; r.statusbar.text = world;
        for (const control of controls) control.common.flags &= ~MenuFlag.Grayed;
        r.list.common.flags |= MenuFlag.Grayed; r.go.common.flags |= MenuFlag.Grayed;
      }
      r.list.numitems = 0; r.list.curvalue = 0; r.list.top = 0; this.updatePicture(); return;
    }
    let count = 0;
    for (let i = 0; i < this.servers.count; i++) {
      const node = itemAt(this.servers.nodes, i), row = itemAt(r.rows, count); row.node = node;
      if ((!this.showEmpty && node.clients === 0) || (!this.showFull && node.clients === node.maxclients)) continue;
      if (this.game !== 0 && node.gametype !== itemAt([0, 0, 3, 1, 4], this.game)) continue;
      const color = node.ping < node.minPing || (node.maxPing !== 0 && node.ping > node.maxPing) ? "^4" : node.ping < 200 ? "^2" : node.ping < 400 ? "^3" : "^1";
      row.text = this.format(`${node.hostname.slice(0, 20).padEnd(20)} ${node.mapname.slice(0, 12).padEnd(12)} ${String(node.clients).padStart(2)}/${String(node.maxclients).padStart(2)} ${node.gamename.slice(0, 8).padEnd(8)} ${itemAt(NETS, node.nettype).padStart(3)} ${color}${String(node.ping).padStart(3)} ^3${node.punkbuster ? "Yes" : "No"}`, 68);
      r.names[count] = row.text; count++;
    }
    r.list.numitems = count; r.list.curvalue = 0; r.list.top = 0; this.updatePicture();
  }
  private insert(address: string, info: string, ping: number): void {
    if (ping >= this.maximumPing() && this.source !== ServerBrowserSource.Favorites) return;
    const list = this.servers, index = list.count >= list.capacity ? list.count - 1 : list.count++;
    const node = itemAt(list.nodes, index), value = (key: string): string => infoValueForKey(info, key);
    node.address = address.slice(0, 63); node.hostname = cleanUpper(value("hostname").slice(0, 21)); node.mapname = cleanUpper(value("mapname").slice(0, 15));
    node.clients = gameAtoi(value("clients")); node.maxclients = gameAtoi(value("sv_maxclients")); node.ping = ping;
    node.minPing = gameAtoi(value("minPing")); node.maxPing = gameAtoi(value("maxPing")); node.punkbuster = gameAtoi(value("punkbuster"));
    node.nettype = gameAtoi(value("nettype")); node.gametype = gameAtoi(value("gametype")); if (node.gametype < 0) node.gametype = 0; else if (node.gametype > 11) node.gametype = 12;
    node.gamename = (value("game") || itemAt(GAMES, node.gametype)).slice(0, 11);
  }
  private favoriteAddress(index: number): string { if (index < 0 || index >= 16) throw new RangeError("Undefined native favorite address index"); return readString(this.record.favorites, index * 64, 64); }
  private insertFavorites(): void {
    const info = infoSetValueForKey("", "hostname", "No Response", text => this.print(text));
    for (let i = 0; i < this.record.favoriteCount; i++) {
      const address = this.favoriteAddress(i);
      if (!this.favorites.nodes.slice(0, this.favorites.count).some(node => compare(node.address, address) === 0)) this.insert(address, info, this.maximumPing());
    }
  }
  private loadFavorites(): void {
    const old = this.favorites.nodes.map(node => ({ ...node })), count = this.favorites.count; this.favorites.clear(); let found = false;
    for (let i = 0; i < 16; i++) {
      const address = this.string(`server${i + 1}`, 64); if (address === "" || address.charAt(0) < "0" || address.charAt(0) > "9") continue;
      writeString(this.record.favorites, this.favorites.count * 64, 64, address);
      const previous = old.slice(0, count).find(node => compare(node.address, address) === 0), node = itemAt(this.favorites.nodes, this.favorites.count);
      if (previous !== undefined) { Object.assign(node, previous); found = true; }
      else { node.address = address; node.ping = this.maximumPing(); }
      this.favorites.count++;
    }
    this.record.favoriteCount = this.favorites.count; if (!found) this.favorites.count = 0;
  }
  private removeFavorite(): void {
    const r = this.record; if (r.list.numitems === 0) return;
    const node = itemAt(r.rows, r.list.curvalue).node; if (node === null) throw new Error("Undefined native favorite row pointer");
    for (let i = 0; i < r.favoriteCount; i++) if (compare(node.address, this.favoriteAddress(i)) === 0) {
      // Source sizeof(MAX_ADDRESSLENGTH) is sizeof(int), not the address width.
      r.favorites.copyWithin(i * 64, (i + 1) * 64, (i + 1) * 64 + (r.favoriteCount - i - 1) * 4); r.favoriteCount--; break;
    }
    for (let i = 0; i < this.favorites.count; i++) if (itemAt(this.favorites.nodes, i) === node) {
      for (let j = i; j + 1 < this.favorites.count; j++) Object.assign(itemAt(this.favorites.nodes, j), itemAt(this.favorites.nodes, j + 1));
      this.favorites.count--; break;
    }
    r.queried = r.favoriteCount; r.currentPing = r.favoriteCount;
  }
  private stopRefresh(): void {
    const r = this.record; if (!r.refreshing) return; r.refreshing = false;
    if (this.source === ServerBrowserSource.Favorites) this.insertFavorites();
    if (r.queried >= 0) { r.currentPing = this.servers.count; r.queried = this.servers.count; }
    this.sortServers(); this.updateMenu();
  }
  private async doRefresh(): Promise<void> {
    const r = this.record;
    if (this.state.realtime < r.refreshTime && this.source !== ServerBrowserSource.Favorites) {
      if (this.source === ServerBrowserSource.Local && this.browser.getServerCount(this.source) === 0) return;
      if (this.browser.getServerCount(this.source) < 0) return;
    }
    if (this.state.realtime < r.nextPing) return; r.nextPing = nativeInt(this.state.realtime + 10);
    const maximum = this.maximumPing();
    for (let i = 0; i < 32; i++) {
      const result = this.browser.getPing(i, 64); if (result.address === "") continue;
      const pending = r.pings.find(ping => compare(ping.address, result.address) === 0);
      if (pending !== undefined) {
        let time = result.time;
        if (time === 0) { time = nativeInt(this.state.realtime - pending.start); if (time < maximum) continue; }
        let info = ""; if (time > maximum) time = maximum; else info = this.browser.getPingInfo(i, 1024);
        this.insert(result.address, info, time); pending.address = "";
      }
      this.browser.clearPing(i);
    }
    r.queried = this.source === ServerBrowserSource.Favorites ? r.favoriteCount : this.browser.getServerCount(this.source);
    for (let i = 0; i < 32 && r.currentPing < r.queried; i++) {
      if (this.browser.getPingQueueCount() >= 32) break;
      const pending = r.pings.find(ping => ping.address === ""); if (pending === undefined) break;
      const address = this.source === ServerBrowserSource.Favorites ? this.favoriteAddress(r.currentPing) : this.browser.getServerAddressString(this.source, r.currentPing, 64);
      pending.address = address; pending.start = this.state.realtime;
      await this.commands.executeNowAsync(`ping ${address}\n`); this.state.assertActive(); r.currentPing++;
    }
    if (this.browser.getPingQueueCount() === 0) { this.stopRefresh(); return; }
    this.updateMenu();
  }
  private startRefresh(): void {
    const r = this.record; this.servers.clearForRefresh();
    for (let i = 0; i < 32; i++) { itemAt(r.pings, i).address = ""; this.browser.clearPing(i); }
    r.refreshing = true; r.currentPing = 0; r.nextPing = 0; this.servers.count = 0; r.queried = 0; r.refreshTime = nativeInt(this.state.realtime + 5000); this.updateMenu();
    if (this.source === ServerBrowserSource.Local) this.commands.append("localservers\n");
    else if (this.source === ServerBrowserSource.Global || this.source === ServerBrowserSource.Mplayer) {
      let args = ["", " ffa", " team", " tourney", " ctf"][r.gametype.curvalue] ?? ""; if (this.showEmpty) args += " empty"; if (this.showFull) args += " full";
      const protocol = this.string("debug_protocol", 32) || String(qvmFloatToInt(this.value("protocol")));
      this.commands.append(`globalservers ${this.source === ServerBrowserSource.Global ? 0 : 1} ${protocol}${args}\n`);
    }
  }
  private save(): void { for (let i = 0; i < 16; i++) this.set(`server${i + 1}`, i < this.record.favoriteCount ? this.favoriteAddress(i) : ""); }
  private setType(source: number): void {
    if (this.source === source) return; this.source = source;
    switch (source) { case ServerBrowserSource.Global: this.servers = this.global; break; case ServerBrowserSource.Mplayer: this.servers = this.mplayer; break; case ServerBrowserSource.Favorites: this.servers = this.favorites; break; default: this.servers = this.local; break; }
    if (source === ServerBrowserSource.Favorites) this.record.remove.common.flags &= ~(MenuFlag.Hidden | MenuFlag.Inactive);
    else this.record.remove.common.flags |= MenuFlag.Hidden | MenuFlag.Inactive;
    if (this.servers.count === 0) this.startRefresh(); else { this.record.currentPing = this.servers.count; this.record.queried = this.servers.count; this.updateMenu(); }
    this.record.status.text = "hit refresh to update";
  }
  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive(); if (event !== MenuEvent.Activated && item.common.id !== Id.List) return;
    const r = this.record;
    switch (item.common.id) {
      case Id.Master: { const value = r.master.curvalue >= 1 ? r.master.curvalue + 1 : r.master.curvalue; this.set("ui_browserMaster", String(value)); this.setType(value); break; }
      case Id.GameType: this.set("ui_browserGameType", String(r.gametype.curvalue)); this.game = r.gametype.curvalue; this.updateMenu(); break;
      case Id.Sort: this.set("ui_browserSortKey", String(r.sort.curvalue)); if (this.sort !== r.sort.curvalue) { this.sort = r.sort.curvalue; this.sortServers(); } this.updateMenu(); break;
      case Id.Full: this.set("ui_browserShowFull", String(r.full.curvalue)); this.showFull = r.full.curvalue; this.updateMenu(); break;
      case Id.Empty: this.set("ui_browserShowEmpty", String(r.empty.curvalue)); this.showEmpty = r.empty.curvalue; this.updateMenu(); break;
      case Id.List: if (event === MenuEvent.GotFocus) this.updatePicture(); break;
      case Id.Up: await scrollKey(this.state, r.list, KeyCode.Up); this.state.assertActive(); break;
      case Id.Down: await scrollKey(this.state, r.list, KeyCode.Down); this.state.assertActive(); break;
      case Id.Back: this.stopRefresh(); this.save(); await popMenu(this.state); this.state.assertActive(); break;
      case Id.Refresh: this.startRefresh(); break;
      case Id.Specify: await this.specify.show(); this.state.assertActive(); break;
      case Id.Create: await this.startServer.show(true); this.state.assertActive(); break;
      case Id.Connect: { const node = itemAt(r.rows, r.list.curvalue).node; if (node !== null) this.commands.append(`connect ${node.address}\n`); break; }
      case Id.Remove: this.removeFavorite(); this.updateMenu(); break;
      case Id.Punkbuster: {
        const enable = r.punkbuster.curvalue !== 0;
        await this.confirm.show(enable ? "Enable Punkbuster?" : "Disable Punkbuster?", null, async result => {
          this.state.assertActive();
          // cl_ui.c UI_SET_PBCLSTATUS returns 0 without changing engine state.
          if (result && !enable) { await this.confirm.message(["PunkBuster will be", "disabled the next time", "Quake III Arena", "is started."]); this.state.assertActive(); }
          r.punkbuster.curvalue = qvmFloatToInt(clampCvar(0, 1, this.value("cl_punkbuster")));
        }, UI_CENTER | UI_INVERSE | UI_SMALLFONT); this.state.assertActive(); break;
      }
    }
  }
  private async key(key: number): Promise<MenuSound> {
    this.state.assertActive(); const r = this.record;
    if (key === KeyCode.Space && r.refreshing) { this.stopRefresh(); return menuSound(this.state.media.move); }
    if ((key === KeyCode.Delete || key === KeyCode.KeypadDelete) && this.source === ServerBrowserSource.Favorites && menuItemAtCursor(r.menu) === r.list) {
      this.removeFavorite(); this.updateMenu(); return menuSound(this.state.media.move);
    }
    if (key === KeyCode.Mouse2 || key === KeyCode.Escape) { this.stopRefresh(); this.save(); }
    const sound = await defaultKey(this.state, r.menu, key); this.state.assertActive(); return sound;
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of ["back_0", "back_1", "create_0", "create_1", "specify_0", "specify_1", "refresh_0", "refresh_1", "fight_0", "fight_1", "arrows_vert_0", "arrows_vert_top", "arrows_vert_bot", "unknownmap", "pblogo"]) {
      await this.state.services.resources.registerShaderNoMip(`${ART}${name}`); this.state.assertActive();
    }
  }
  async show(): Promise<void> {
    this.state.assertActive(); const r = this.record; r.reset(); await this.cache(); this.state.assertActive();
    r.menu.fullscreen = true; r.menu.wrapAround = true;
    r.menu.draw = async () => { this.state.assertActive(); if (r.refreshing) { await this.doRefresh(); this.state.assertActive(); } await drawMenu(this.state, r.menu); this.state.assertActive(); };
    r.menu.key = key => this.key(key);
    r.banner.common.flags = MenuFlag.CenterJustify; r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "ARENA SERVERS"; r.banner.style = UI_CENTER; r.banner.color = COLORS.white;
    const setupControl = (item: MenuSpin | MenuRadio, id: Id, name: string, x: number, y: number): void => { Object.assign(item.common, { id, name, x, y, flags: MenuFlag.PulseIfFocus | MenuFlag.SmallFont, callback: this.callback }); };
    setupControl(r.master, Id.Master, "Servers:", 320, 80); r.master.itemnames = ["Local", "Internet", "Favorites"];
    setupControl(r.gametype, Id.GameType, "Game Type:", 320, 96); r.gametype.itemnames = ["All", "Free For All", "Team Deathmatch", "Tournament", "Capture the Flag"];
    setupControl(r.sort, Id.Sort, "Sort By:", 320, 112); r.sort.itemnames = ["Server Name", "Map Name", "Open Player Spots", "Game Type", "Ping Time"];
    setupControl(r.full, Id.Full, "Show Full:", 320, 128); setupControl(r.empty, Id.Empty, "Show Empty:", 320, 144);
    Object.assign(r.list.common, { id: Id.List, x: 72, y: 192, flags: MenuFlag.HighlightIfFocus, callback: this.callback }); r.list.width = 68; r.list.height = 11; r.list.itemnames = r.names;
    const setupBitmap = (item: MenuBitmap, id: number, x: number, y: number, width: number, height: number, name: string | null, focus: string | null, flags: number): void => {
      Object.assign(item.common, { id, x, y, name: name === null ? null : `${ART}${name}`, flags, callback: this.callback }); item.width = width; item.height = height; item.focuspic = focus === null ? null : `${ART}${focus}`;
    };
    setupBitmap(r.picture, 0, 72, 80, 128, 96, null, null, MenuFlag.LeftJustify | MenuFlag.Inactive); r.picture.common.callback = null; r.picture.errorpic = UNKNOWN;
    setupBitmap(r.arrows, 0, 560, 192, 64, 128, "arrows_vert_0", null, MenuFlag.LeftJustify | MenuFlag.Inactive);
    setupBitmap(r.up, Id.Up, 560, 192, 64, 64, null, "arrows_vert_top", PULSE | MenuFlag.MouseOnly);
    setupBitmap(r.down, Id.Down, 560, 256, 64, 64, null, "arrows_vert_bot", PULSE | MenuFlag.MouseOnly);
    r.status.common.x = 320; r.status.common.y = 376; r.status.style = UI_CENTER | UI_SMALLFONT; r.status.color = COLORS.menuText;
    r.statusbar.common.x = 320; r.statusbar.common.y = 392; r.statusbar.style = UI_CENTER | UI_SMALLFONT; r.statusbar.color = COLORS.normal; r.statusbar.text = "";
    setupBitmap(r.remove, Id.Remove, 450, 86, 96, 48, "delete_0", "delete_1", PULSE);
    setupBitmap(r.back, Id.Back, 0, 416, 128, 64, "back_0", "back_1", PULSE);
    setupBitmap(r.specify, Id.Specify, 128, 416, 128, 64, "specify_0", "specify_1", PULSE);
    setupBitmap(r.refresh, Id.Refresh, 256, 416, 128, 64, "refresh_0", "refresh_1", PULSE);
    setupBitmap(r.create, Id.Create, 384, 416, 128, 64, "create_0", "create_1", PULSE);
    setupBitmap(r.go, Id.Connect, 640, 416, 128, 64, "fight_0", "fight_1", MenuFlag.RightJustify | MenuFlag.PulseIfFocus);
    setupControl(r.punkbuster, Id.Punkbuster, "Punkbuster:", 512, 144); r.punkbuster.itemnames = ["Disabled", "Enabled"];
    setupBitmap(r.pblogo, 0, 526, 176, 32, 16, "pblogo", null, MenuFlag.LeftJustify | MenuFlag.Inactive); r.pblogo.common.callback = null; r.pblogo.errorpic = UNKNOWN;
    for (const item of r.items) addItem(this.state, r.menu, item);
    this.loadFavorites();
    const setting = (name: string, max: number): number => qvmFloatToInt(clampCvar(0, max, this.state.services.cvars.get(name).integerValue));
    const source = setting("ui_browserMaster", 3); r.master.curvalue = source >= 1 ? source - 1 : source;
    this.game = r.gametype.curvalue = setting("ui_browserGameType", 4); this.sort = r.sort.curvalue = setting("ui_browserSortKey", 4);
    this.showFull = r.full.curvalue = setting("ui_browserShowFull", 1); this.showEmpty = r.empty.curvalue = setting("ui_browserShowEmpty", 1);
    r.punkbuster.curvalue = qvmFloatToInt(clampCvar(0, 1, this.value("cl_punkbuster")));
    this.source = -1; this.setType(source); this.state.services.cvars.registry.register("debug_protocol", "", 0); this.state.assertActive();
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
