/*
 * UI_Get/SortServerStatusInfo, UI_BuildServerStatus, UI_BuildFindPlayerList,
 * stristr and FEEDER_FINDPLAYER selection from code/ui/ui_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
 */
import { CommonError } from "../../core/common-error.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { CommonEvents } from "../../engine/common-events.ts";
import type { ServerBrowser } from "../../engine/server-browser.ts";
import { gameFormat } from "../../game/format.ts";
import type { GameFormatArgument } from "../../game/format.ts";
import type { UiRuntime } from "../runtime.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { TeamArenaServerBrowser } from "./server-browser.ts";

type StatusCell = string | { readonly bytes: Uint8Array; readonly offset: number } | null;
type StatusLine = [StatusCell, StatusCell, StatusCell, StatusCell];
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Team Arena status access outside ${values.length}-entry source storage at ${index}`);
  return value;
}
function byteString(bytes: Uint8Array, offset: number): string {
  let text = "";
  for (let index = offset; ; index++) {
    const byte = at(bytes, index);
    if (byte === 0) return text;
    text += String.fromCharCode(byte);
  }
}
function cellText(cell: StatusCell): string | null {
  return typeof cell === "string" || cell === null ? cell : byteString(cell.bytes, cell.offset);
}
function copy(bytes: Uint8Array, offset: number, input: string, size: number): void {
  if (size < 1) throw new CommonError("drop", "Q_strncpyz: destsize < 1"); // UI_ERROR maps the shared fatal call to ERR_DROP.
  const text = sourceCommandText(input).slice(0, size - 1);
  for (let i = 0; i < text.length; i++) { at(bytes, offset + i); bytes[offset + i] = text.charCodeAt(i); }
  at(bytes, offset + text.length); bytes[offset + text.length] = 0;
}
function fold(text: string): string { return text.replace(/[a-z]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 32)); }
function clean(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const byte = text.charCodeAt(i), next = text.charAt(i + 1);
    if (byte === 94 && next !== "" && next !== "^") i++;
    else if (byte >= 32 && byte <= 126) result += text.charAt(i);
  }
  return result;
}
function intTime(value: number): void {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new RangeError("Team Arena status requires int32 UI realTime");
}

/** Cells retain source pointers, so delimiter writes and resets remain visible through old rows. */
export class TeamArenaServerStatusInfo {
  readonly address = new Uint8Array(64);
  readonly text = new Uint8Array(1024);
  readonly pings = new Uint8Array(192);
  readonly lines: readonly StatusLine[] = Array.from({ length: 128 }, () => [null, null, null, null]);
  numLines = 0;

  column(row: number, column: number): string | null { return cellText(at(at(this.lines, row), column)); }
  reset(): void {
    this.address.fill(0); this.text.fill(0); this.pings.fill(0); this.numLines = 0;
    for (const row of this.lines) row.fill(null);
  }
}

export interface TeamArenaPendingServer {
  adrstr: string; name: string; startTime: number; serverNum: number; valid: boolean;
}
export interface TeamArenaServerStatusServices {
  readonly browser: ServerBrowser;
  readonly cvars: TeamArenaUiCvars;
  readonly display: TeamArenaServerBrowser;
  readonly runtime: UiRuntime;
  readonly clock: CommonEvents;
  readonly print: (text: string) => void;
  readonly assertActive: () => void;
}

const STATUS_CVARS: readonly (readonly [string, string])[] = [
  ["sv_hostname", "Name"], ["Address", ""], ["gamename", "Game name"], ["g_gametype", "Game type"],
  ["mapname", "Map"], ["version", ""], ["protocol", ""], ["timelimit", ""], ["fraglimit", ""],
];

/** Status and find-player requests share the engine's sixteen request slots. Await one UI operation at a time. */
export class TeamArenaServerStatus {
  readonly serverStatusInfo = new TeamArenaServerStatusInfo();
  private readonly statusAddress = new Uint8Array(64);
  nextServerStatusRefresh = 0;
  readonly pendingServerStatus = { num: 0, server: Array.from({ length: 16 }, (): TeamArenaPendingServer =>
    ({ adrstr: "", name: "", startTime: 0, serverNum: 0, valid: false })) };
  findPlayerName = "";
  readonly foundPlayerServerAddresses: string[] = Array.from({ length: 16 }, () => "");
  readonly foundPlayerServerNames: string[] = Array.from({ length: 16 }, () => "");
  currentFoundPlayerServer = 0;
  numFoundPlayerServers = 0;
  nextFindPlayerRefresh = 0;
  private numFound = 0;
  private numTimeOuts = 0;

  constructor(private readonly services: TeamArenaServerStatusServices) {}

  get serverStatusAddress(): string { return byteString(this.statusAddress, 0); }
  set serverStatusAddress(value: string) { copy(this.statusAddress, 0, value, 64); }

  private format(format: string, args: readonly GameFormatArgument[], size: number): string {
    const text = gameFormat(format, args);
    if (text.length >= size) {
      this.services.print(gameFormat("Com_sprintf: overflow of %i in %i\n", [text.length, size]));
      this.services.assertActive();
    }
    if (size < 1) throw new CommonError("drop", "Q_strncpyz: destsize < 1");
    return text.slice(0, size - 1);
  }
  private summary(format: string, args: readonly GameFormatArgument[]): void {
    const index = this.numFoundPlayerServers - 1;
    at(this.foundPlayerServerNames, index);
    this.foundPlayerServerNames[index] = this.format(format, args, 64);
  }
  private timeout(): number {
    const value = this.services.cvars.get("ui_serverStatusTimeOut").integerValue;
    this.services.assertActive(); return value;
  }
  private async selectStatusFeeder(): Promise<void> {
    await this.services.runtime.setFeederSelection(13, 0);
    this.services.assertActive();
  }

  private sortInfo(info: TeamArenaServerStatusInfo): void {
    let index = 0;
    for (const [name, alternate] of STATUS_CVARS) {
      for (let j = 0; j < info.numLines; j++) {
        const score = info.column(j, 1);
        if (score === null || score.length > 0) continue;
        const key = info.column(j, 0);
        if (key === null || fold(name) !== fold(key)) continue;
        const first = at(info.lines, index), second = at(info.lines, j), keyCell = first[0], valueCell = first[3];
        first[0] = second[0]; first[3] = second[3]; second[0] = keyCell; second[3] = valueCell;
        if (alternate.length > 0) first[0] = alternate;
        index++;
      }
    }
  }

  private parseInfo(address: string, info: TeamArenaServerStatusInfo): void {
    copy(info.address, 0, address, 64);
    const first = at(info.lines, 0);
    first[0] = "Address"; first[1] = ""; first[2] = ""; first[3] = { bytes: info.address, offset: 0 };
    info.numLines = 1;
    const find = (offset: number, byte: number): number | null => {
      for (let i = offset; ; i++) { const value = at(info.text, i); if (value === byte) return i; if (value === 0) return null; }
    };
    let p: number | null = 0;
    while (p !== null && at(info.text, p) !== 0) {
      p = find(p, 92); if (p === null) break;
      info.text[p++] = 0;
      if (at(info.text, p) === 92) break;
      const row = at(info.lines, info.numLines);
      row[0] = { bytes: info.text, offset: p }; row[1] = ""; row[2] = "";
      p = find(p, 92); if (p === null) break;
      info.text[p++] = 0; row[3] = { bytes: info.text, offset: p };
      info.numLines++;
      if (info.numLines >= 128) break;
    }
    if (info.numLines < 125) {
      at(info.lines, info.numLines++).fill("");
      const header = at(info.lines, info.numLines++);
      header[0] = "num"; header[1] = "score"; header[2] = "ping"; header[3] = "name";
      let i = 0, len = 0;
      while (p !== null && at(info.text, p) !== 0) {
        if (at(info.text, p) === 92) info.text[p++] = 0;
        const score = p;
        p = find(p, 32); if (p === null) break;
        info.text[p++] = 0; const ping = p;
        p = find(p, 32); if (p === null) break;
        info.text[p++] = 0; const name = p;
        const number = this.format("%d", [i], 192 - len);
        copy(info.pings, len, number, 192 - len);
        const row = at(info.lines, info.numLines);
        row[0] = { bytes: info.pings, offset: len };
        len += byteString(info.pings, len).length + 1;
        row[1] = { bytes: info.text, offset: score }; row[2] = { bytes: info.text, offset: ping }; row[3] = { bytes: info.text, offset: name };
        info.numLines++;
        if (info.numLines >= 128) break;
        p = find(p, 92); if (p === null) break;
        info.text[p++] = 0; i++;
      }
    }
    this.sortInfo(info);
  }

  async getServerStatusInfo(address: string | null, info: TeamArenaServerStatusInfo | null): Promise<boolean> {
    const services = this.services;
    services.assertActive();
    if (info === null) {
      await services.browser.serverStatus(address, null, services.clock); services.assertActive(); return false;
    }
    info.reset();
    const text = await services.browser.serverStatus(address, 1024, services.clock);
    services.assertActive();
    if (text === null) return false;
    copy(info.text, 0, text, 1024);
    if (address === null) throw new RangeError("UI_GetServerStatusInfo reached a null source address copy");
    this.parseInfo(address, info);
    return true;
  }

  async buildServerStatus(force: boolean, realTime: number): Promise<void> {
    const services = this.services;
    services.assertActive(); intTime(realTime);
    if (this.nextFindPlayerRefresh !== 0) return;
    if (!force) {
      if (this.nextServerStatusRefresh === 0 || this.nextServerStatusRefresh > realTime) return;
    } else {
      await this.selectStatusFeeder(); this.serverStatusInfo.numLines = 0;
      await this.getServerStatusInfo(null, null);
    }
    if (services.display.currentServer < 0 || services.display.currentServer > services.display.numDisplayServers || services.display.numDisplayServers === 0) return;
    if (await this.getServerStatusInfo(this.serverStatusAddress, this.serverStatusInfo)) {
      this.nextServerStatusRefresh = 0;
      await this.getServerStatusInfo(this.serverStatusAddress, null);
    } else this.nextServerStatusRefresh = (realTime + 500) | 0;
  }

  async selectFoundPlayer(index: number, realTime: number): Promise<void> {
    this.services.assertActive(); intTime(realTime);
    this.currentFoundPlayerServer = index;
    if (index < this.numFoundPlayerServers - 1) {
      this.serverStatusAddress = at(this.foundPlayerServerAddresses, this.currentFoundPlayerServer);
      await this.selectStatusFeeder(); await this.buildServerStatus(true, realTime);
    }
  }

  async buildFindPlayerList(force: boolean, realTime: number): Promise<void> {
    const services = this.services, pending = this.pendingServerStatus, info = new TeamArenaServerStatusInfo();
    services.assertActive(); intTime(realTime);
    if (!force) {
      if (this.nextFindPlayerRefresh === 0 || this.nextFindPlayerRefresh > realTime) return;
    } else {
      pending.num = 0;
      for (const row of pending.server) { row.adrstr = ""; row.name = ""; row.startTime = 0; row.serverNum = 0; row.valid = false; }
      this.numFoundPlayerServers = 0; this.currentFoundPlayerServer = 0;
      const name = sourceCommandText(services.cvars.registry.get("ui_findPlayer")?.value ?? "").slice(0, 1023);
      services.assertActive(); this.findPlayerName = clean(name);
      if (this.findPlayerName.length === 0) { this.nextFindPlayerRefresh = 0; return; }
      let resend = (Math.trunc(this.timeout() / 2) - 10) | 0;
      if (resend < 50) resend = 50;
      services.cvars.registry.set("cl_serverStatusResendTime", gameFormat("%d", [resend]), true); services.assertActive();
      await this.getServerStatusInfo(null, null);
      this.numFoundPlayerServers = 1; this.summary("searching %d...", [pending.num]);
      this.numFound = 0; this.numTimeOuts = (this.numTimeOuts + 1) | 0;
    }
    for (const row of pending.server) {
      if (row.valid && await this.getServerStatusInfo(row.adrstr, info)) {
        this.numFound = (this.numFound + 1) | 0;
        for (let j = 0; j < info.numLines; j++) {
          const ping = info.column(j, 2);
          if (ping === null || ping.length === 0) continue;
          const original = info.column(j, 3);
          if (original === null) throw new RangeError("Find-player name copy reached a null source pointer");
          const name = clean(original.slice(0, 33));
          // stristr never tests an empty haystack; findPlayerName is nonempty after the force path.
          if (name.length > 0 && fold(name).includes(fold(this.findPlayerName))) {
            if (this.numFoundPlayerServers < 15) {
              const index = this.numFoundPlayerServers - 1;
              at(this.foundPlayerServerAddresses, index); at(this.foundPlayerServerNames, index);
              this.foundPlayerServerAddresses[index] = sourceCommandText(row.adrstr).slice(0, 63);
              this.foundPlayerServerNames[index] = sourceCommandText(row.name).slice(0, 63);
              this.numFoundPlayerServers++;
            } else pending.num = services.display.numDisplayServers;
          }
        }
        this.summary("searching %d/%d...", [pending.num, this.numFound]); row.valid = false;
      }
      if (!row.valid || row.startTime < ((realTime - this.timeout()) | 0)) {
        if (row.valid) this.numTimeOuts = (this.numTimeOuts + 1) | 0;
        await this.getServerStatusInfo(row.adrstr, null); row.valid = false;
        if (pending.num < services.display.numDisplayServers) {
          row.startTime = realTime;
          let source = services.cvars.get("ui_netSource").integerValue; services.assertActive();
          row.adrstr = services.browser.getServerAddressString(source, at(services.display.displayServers, pending.num), 64); services.assertActive();
          source = services.cvars.get("ui_netSource").integerValue; services.assertActive();
          const text = services.browser.getServerInfo(source, at(services.display.displayServers, pending.num), 1024); services.assertActive();
          row.name = infoValueForKey(text, "hostname").slice(0, 63); row.valid = true; pending.num++;
          this.summary("searching %d/%d...", [pending.num, this.numFound]);
        }
      }
    }
    if (pending.server.some(row => row.valid)) this.nextFindPlayerRefresh = (realTime + 25) | 0;
    else {
      if (this.numFoundPlayerServers === 0) this.summary("no servers found", []);
      else this.summary("%d server%s found with player %s", [this.numFoundPlayerServers - 1, this.numFoundPlayerServers === 2 ? "" : "s", this.findPlayerName]);
      this.nextFindPlayerRefresh = 0;
      await this.selectFoundPlayer(this.currentFoundPlayerServer, realTime);
    }
  }
}
