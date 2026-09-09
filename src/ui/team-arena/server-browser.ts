/*
 * Team Arena display-list sorting/building and refresh from code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import type { CommandBuffer } from "../../core/commands.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { ServerBrowserSource } from "../../engine/server-browser.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import { gameFormat } from "../../game/format.ts";
import { gameAtoi } from "../../game/numeric.ts";
import type { LocalCalendar } from "../../platform/system-clock.ts";
import type { SceneShader } from "../../render/ref-entity.ts";
import type { UiRuntime } from "../runtime.ts";
import type { TeamArenaUiCvars, TeamArenaUiCvarSymbol } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";

export interface TeamArenaServerBrowserServices {
  readonly browser: ServerBrowser;
  readonly cvars: TeamArenaUiCvars;
  readonly gameInfo: TeamArenaGameInfo;
  readonly runtime: UiRuntime;
  readonly commands: CommandBuffer;
  readonly calendar: LocalCalendar;
  readonly print: (text: string) => void;
  readonly assertActive: () => void;
}

const FILTERS = ["", "", "missionpack", "arena", "alliance20", "wfa", "osp"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FEEDER_SERVERS = 2;

function intTime(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Team Arena refresh requires int32 UI realTime");
}
function word(values: Int32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Team Arena display read outside ${values.length}-entry source array at ${index}`);
  return value;
}

/* Integer specialization of game/bg_lib.c qsort.
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
function sortPrefix(values: Int32Array, count: number, compare: (first: number, second: number) => number): void {
  const cmp = (a: number, b: number): number => compare(word(values, a), word(values, b));
  const swap = (a: number, b: number): void => { const first = word(values, a); values[a] = word(values, b); values[b] = first; };
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
        while (b <= c) { const result = cmp(b, start); if (result > 0) break;
          if (result === 0) { swapped = true; swap(a, b); a++; } b++; }
        while (b <= c) { const result = cmp(c, start); if (result < 0) break;
          if (result === 0) { swapped = true; swap(c, d); d--; } c--; }
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

/** UI-owned indexes into the engine's live lists; callers serialize and await UI operations. */
export class TeamArenaServerBrowser {
  readonly displayServers = new Int32Array(2048);
  numDisplayServers = 0;
  numPlayersOnServers = 0;
  sortKey = 0;
  sortDir = 0;
  currentServer = 0;
  currentServerPreview: SceneShader | null = null;
  currentServerCinematic = 0;
  refreshActive = false;
  refreshtime = 0;
  nextDisplayRefresh = 0;
  nextSortTime = 0;
  motd = "";
  motdLen = 0;
  motdWidth = 0;
  motdPaintX = 0;
  motdPaintX2 = 0;
  motdOffset = 0;
  motdTime = 0;
  // ui_serverFilterType is a zero-initialized vmCvar_t absent from the source cvar table.
  serverFilterType = 0;
  private numInvisible = 0;

  constructor(private readonly services: TeamArenaServerBrowserServices) {}

  private integer(name: TeamArenaUiCvarSymbol): number {
    const value = this.services.cvars.get(name).integerValue;
    this.services.assertActive();
    return value;
  }
  private source(): ServerBrowserSource { return this.integer("ui_netSource"); }
  private text(name: string): string {
    const value = sourceCommandText(this.services.cvars.registry.get(name)?.value ?? "").slice(0, 1023);
    this.services.assertActive();
    return value;
  }
  private value(name: string): number {
    const value = this.services.cvars.registry.get(name)?.numericValue ?? 0;
    this.services.assertActive();
    return qvmFloatToInt(value);
  }
  private mark(index: number, visible: boolean): void {
    this.services.browser.markServerVisible(this.source(), index, visible);
    this.services.assertActive();
  }
  private count(): number {
    const count = this.services.browser.getServerCount(this.source());
    this.services.assertActive();
    return count;
  }
  private compare(first: number, second: number): number {
    const result = this.services.browser.compareServers(this.source(), this.sortKey, this.sortDir, first, second);
    this.services.assertActive();
    return result;
  }
  private write(index: number, value: number): void {
    if (index < 0 || index >= 2048 || !Number.isInteger(index)) throw new RangeError(`Team Arena display write outside 2048-entry source array at ${index}`);
    this.displayServers[index] = value;
  }

  insert(num: number, position: number): void {
    this.services.assertActive();
    if (position < 0 || position > this.numDisplayServers) return;
    this.numDisplayServers++;
    // Source writes the extra retained tail at the incremented count, not count - 1.
    for (let i = this.numDisplayServers; i > position; i--) this.write(i, word(this.displayServers, i - 1));
    this.write(position, num);
  }
  remove(num: number): void {
    this.services.assertActive();
    for (let i = 0; i < this.numDisplayServers; i++) {
      if (word(this.displayServers, i) !== num) continue;
      this.numDisplayServers--;
      for (let j = i; j < this.numDisplayServers; j++) this.write(j, word(this.displayServers, j + 1));
      return;
    }
  }
  binaryInsert(num: number): void {
    this.services.assertActive();
    let length = this.numDisplayServers, mid = length, offset = 0, result = 0;
    while (mid > 0) {
      mid = length >> 1;
      result = this.compare(num, word(this.displayServers, offset + mid));
      if (result === 0) { this.insert(num, offset + mid); return; }
      if (result === 1) { offset += mid; length -= mid; }
      else length -= mid;
    }
    if (result === 1) offset++;
    this.insert(num, offset);
  }
  sort(column: number, force: boolean): void {
    this.services.assertActive();
    if (!force && this.sortKey === column) return;
    this.sortKey = column;
    sortPrefix(this.displayServers, this.numDisplayServers, (a, b) => this.compare(a, b));
  }

  async buildDisplayList(force: number, realTime: number): Promise<void> {
    const services = this.services;
    services.assertActive(); intTime(realTime);
    if (!(force !== 0 || realTime > this.nextDisplayRefresh)) return;
    if (force === 2) force = 0;
    this.motd = this.text("cl_motdString");
    if (this.motd.length === 0) this.motd = "Welcome to Team Arena!";
    if (this.motd.length !== this.motdLen) { this.motdLen = this.motd.length; this.motdWidth = -1; }
    if (force !== 0) {
      this.numInvisible = 0; this.numDisplayServers = 0; this.numPlayersOnServers = 0;
      await services.runtime.setFeederSelection(FEEDER_SERVERS, 0);
      services.assertActive();
      this.mark(-1, true);
    }
    const count = this.count();
    if (count === -1 || (this.source() === ServerBrowserSource.Local && count === 0)) {
      this.numDisplayServers = 0; this.numPlayersOnServers = 0;
      this.nextDisplayRefresh = (realTime + 500) | 0;
      return;
    }
    for (let i = 0; i < count; i++) {
      const visible = services.browser.serverIsVisible(this.source(), i);
      services.assertActive();
      if (!visible) continue;
      const ping = services.browser.getServerPing(this.source(), i);
      services.assertActive();
      if (ping <= 0 && this.source() !== ServerBrowserSource.Favorites) continue;
      const info = services.browser.getServerInfo(this.source(), i, 1024);
      services.assertActive();
      const clients = gameAtoi(infoValueForKey(info, "clients"));
      this.numPlayersOnServers = (this.numPlayersOnServers + clients) | 0;
      if (this.integer("ui_browserShowEmpty") === 0 && clients === 0) { this.mark(i, false); continue; }
      if (this.integer("ui_browserShowFull") === 0 && clients === gameAtoi(infoValueForKey(info, "sv_maxclients"))) {
        this.mark(i, false); continue;
      }
      if (infoSlot(services.gameInfo.joinGameTypes, this.integer("ui_joinGameType")).gtEnum !== -1) {
        const game = gameAtoi(infoValueForKey(info, "gametype"));
        if (game !== infoSlot(services.gameInfo.joinGameTypes, this.integer("ui_joinGameType")).gtEnum) { this.mark(i, false); continue; }
      }
      if (this.serverFilterType > 0) {
        const basedir = infoSlot(FILTERS, this.serverFilterType);
        const fold = (text: string): string => text.replace(/[a-z]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 32));
        if (fold(infoValueForKey(info, "game")) !== fold(basedir)) { this.mark(i, false); continue; }
      }
      if (this.source() === ServerBrowserSource.Favorites) this.remove(i);
      this.binaryInsert(i);
      if (ping > 0) { this.mark(i, false); this.numInvisible = (this.numInvisible + 1) | 0; }
    }
    this.refreshtime = realTime;
  }

  updatePendingPings(realTime: number): void {
    this.services.assertActive(); intTime(realTime);
    this.services.browser.resetPings(this.source()); this.services.assertActive();
    this.refreshActive = true; this.refreshtime = (realTime + 1000) | 0;
  }
  stopRefresh(): void {
    const services = this.services;
    services.assertActive();
    if (!this.refreshActive) return;
    this.refreshActive = false;
    services.print(gameFormat("%d servers listed in browser with %d players.\n", [this.numDisplayServers, this.numPlayersOnServers]));
    services.assertActive();
    const count = this.count(), missing = (count - this.numDisplayServers) | 0;
    if (missing > 0) {
      services.print(gameFormat("%d servers not listed due to packet loss or pings higher than %d\n", [missing, this.value("cl_maxPing")]));
      services.assertActive();
    }
  }
  async doRefresh(realTime: number): Promise<void> {
    const services = this.services;
    services.assertActive(); intTime(realTime);
    if (!this.refreshActive) return;
    let wait = false;
    if (this.source() !== ServerBrowserSource.Favorites) {
      if (this.source() === ServerBrowserSource.Local) wait = this.count() === 0;
      else wait = this.count() < 0;
    }
    if (realTime < this.refreshtime && wait) return;
    const updating = services.browser.updateVisiblePings(this.source());
    services.assertActive();
    if (updating) this.refreshtime = (realTime + 1000) | 0;
    else if (!wait) { await this.buildDisplayList(2, realTime); services.assertActive(); this.stopRefresh(); }
    await this.buildDisplayList(0, realTime); services.assertActive();
  }
  async startRefresh(full: boolean, realTime: number): Promise<void> {
    const services = this.services;
    services.assertActive(); intTime(realTime);
    const q = services.calendar.localCalendar();
    services.assertActive();
    const name = gameFormat("ui_lastServerRefresh_%i", [this.source()]);
    services.cvars.registry.set(name, gameFormat("%s-%i, %i at %i:%i", [infoSlot(MONTHS, q.month), q.day, (1900 + q.year) | 0, q.hour, q.minute]), true);
    services.assertActive();
    if (!full) { this.updatePendingPings(realTime); return; }
    this.refreshActive = true; this.nextDisplayRefresh = (realTime + 1000) | 0;
    this.numDisplayServers = 0; this.numPlayersOnServers = 0;
    this.mark(-1, true);
    services.browser.resetPings(this.source()); services.assertActive();
    if (this.source() === ServerBrowserSource.Local) {
      await services.commands.executeNowAsync("localservers\n"); services.assertActive();
      this.refreshtime = (realTime + 1000) | 0;
      return;
    }
    this.refreshtime = (realTime + 5000) | 0;
    if (this.source() === ServerBrowserSource.Global || this.source() === ServerBrowserSource.Mplayer) {
      const master = this.source() === ServerBrowserSource.Global ? 0 : 1, protocol = this.text("debug_protocol");
      const command = protocol.length > 0 ? gameFormat("globalservers %d %s full empty\n", [master, protocol])
        : gameFormat("globalservers %d %d full empty\n", [master, this.value("protocol")]);
      await services.commands.executeNowAsync(command); services.assertActive();
    }
  }
}
