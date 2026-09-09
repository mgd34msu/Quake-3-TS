// Start Server, Server Options and Bot Select from id Software q3_ui/ui_startserver.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { CommonParseCursor } from "../../core/common-parse.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_BLINK, UI_CENTER, UI_LEFT, UI_PULSE, UI_RIGHT, UI_SMALLFONT } from "../../render/font.ts";
import { clampCvar, drawChar, drawHandle, drawString, fillRect } from "./draw.ts";
import { MenuField } from "./field.ts";
import { addItem, drawBitmap, popMenu, pushMenu } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag, menuParent } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuFieldItem, MenuProportional, MenuRadio, MenuSpin, MenuText } from "./state.ts";

const BACK = "menu/art/back_0", BACK1 = "menu/art/back_1", NEXT = "menu/art/next_0", NEXT1 = "menu/art/next_1";
const FRAMEL = "menu/art/frame2_l", FRAMER = "menu/art/frame1_r", SELECT = "menu/art/maps_select", SELECTED = "menu/art/maps_selected";
const FIGHT = "menu/art/fight_0", FIGHT1 = "menu/art/fight_1", UNKNOWN = "menu/art/unknownmap";
const ARROWS = "menu/art/gs_arrows_0", LEFT = "menu/art/gs_arrows_l", RIGHT = "menu/art/gs_arrows_r";
const ACCEPT = "menu/art/accept_0", ACCEPT1 = "menu/art/accept_1", BOT_SELECT = "menu/art/opponents_select", BOT_SELECTED = "menu/art/opponents_selected";
const GAME_TYPES = ["Free For All", "Team Deathmatch", "Tournament", "Capture the Flag"], REMAP = [0, 3, 1, 4], REMAP2 = [0, 2, 0, 1, 3];
const DEDICATED = ["No", "LAN", "Internet"], PLAYER_TYPES = ["Open", "Bot", "----"], TEAMS = ["Blue", "Red"];
const SKILLS = ["I Can Win", "Bring It On", "Hurt Me Plenty", "Hardcore", "Nightmare!"];
// q3_ui/ui_servers2.c punkbuster_items supplies only the original display choices.
const PUNKBUSTER = ["Disabled", "Enabled"];
const ORANGE = { x: 1, y: Math.fround(.43), z: 0, w: 1 };
const PULSE_LEFT = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus, PULSE_RIGHT = MenuFlag.RightJustify | MenuFlag.PulseIfFocus;
const PULSE_SMALL = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
enum Id { Gametype = 10, Pictures = 11, Prev = 15, NextPage = 16, StartBack = 17, StartNext = 18, PlayerType = 20, MaxClients = 21, Dedicated = 22, Go = 23, Back = 24 }

function bitmap(): MenuBitmap { return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null, width: 0, height: 0, focuscolor: null }; }
function spin(): MenuSpin { return { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0, top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 }; }
function text(): MenuText { return { kind: "text", common: new MenuCommon(), text: null, style: 0, color: COLORS.black }; }
function banner(): MenuBanner { return { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.black }; }
function field(): MenuFieldItem { return { kind: "field", common: new MenuCommon(), field: new MenuField() }; }
function radio(): MenuRadio { return { kind: "radio", common: new MenuCommon(), curvalue: 0 }; }
type OwnedItem = MenuBanner | MenuText | MenuProportional | MenuBitmap | MenuSpin | MenuFieldItem | MenuRadio;
function resetMenu(menu: BaseMenu): void {
  menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
  menu.draw = null; menu.key = null; menu.wrapAround = false; menu.fullscreen = false; menu.showlogo = false;
}
function resetItem(item: OwnedItem): void {
  Object.assign(item.common, new MenuCommon());
  switch (item.kind) {
    case "bitmap": item.focuspic = null; item.errorpic = null; item.shader = null; item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null; return;
    case "spin": item.oldvalue = 0; item.curvalue = 0; item.numitems = 0; item.top = 0; item.itemnames = []; item.width = 0; item.height = 0; item.columns = 0; item.separation = 0; return;
    case "text": case "banner": case "proportional": item.text = null; item.style = 0; item.color = COLORS.black; return;
    case "radio": item.curvalue = 0; return;
    case "field": item.field.reset(); return;
  }
}
function setBitmap(item: MenuBitmap, x: number, y: number, width: number, height: number, flags: number, name: string | null = null, focus: string | null = null): void {
  item.common.x = x; item.common.y = y; item.common.flags = flags; item.common.name = name;
  item.width = width; item.height = height; item.focuspic = focus;
}
function setSpin(item: MenuSpin, x: number, y: number, name: string | null, names: readonly string[], flags: number): void {
  item.common.x = x; item.common.y = y; item.common.name = name; item.common.flags = flags; item.itemnames = names;
}
function setBanner(item: MenuBanner, name: string): void { item.common.x = 320; item.common.y = 16; item.text = name; item.style = UI_CENTER; item.color = COLORS.white; }
function upper(value: string): string { return sourceCommandText(value).replace(/[a-z]/g, byte => String.fromCharCode(byte.charCodeAt(0) - 32)); }
function clean(value: string): string {
  const bytes = sourceCommandText(value); let result = "";
  for (let i = 0; i < bytes.length; i++) {
    if (bytes.charAt(i) === "^" && i + 1 < bytes.length && bytes.charAt(i + 1) !== "^") i++;
    else if (bytes.charCodeAt(i) >= 32 && bytes.charCodeAt(i) <= 126) result += bytes.charAt(i);
  }
  return result;
}
function compareNames(first: string, second: string): number {
  for (let index = 0; ; index++) {
    let a = index < first.length ? first.charCodeAt(index) : 0, b = index < second.length ? second.charCodeAt(index) : 0;
    if (a >= 128) a -= 256; if (b >= 128) b -= 256;
    if (a !== b) { if (a >= 97 && a <= 122) a -= 32; if (b >= 97 && b <= 122) b -= 32; if (a !== b) return a < b ? -1 : 1; }
    if (a === 0) return 0;
  }
}

/* Number-array translation of game/bg_lib.c qsort.
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
function sortBots(values: number[], count: number, compare: (first: number, second: number) => number): void {
  const cmp = (a: number, b: number): number => compare(itemAt(values, a), itemAt(values, b));
  const swap = (a: number, b: number): void => { const value = itemAt(values, a); values[a] = itemAt(values, b); values[b] = value; };
  const swapRange = (a: number, b: number, length: number): void => { for (let n = 0; n < length; n++) swap(a + n, b + n); };
  const median = (a: number, b: number, c: number): number => cmp(a, b) < 0 ? cmp(b, c) < 0 ? b : cmp(a, c) < 0 ? c : a : cmp(b, c) > 0 ? b : cmp(a, c) < 0 ? a : c;
  const insertion = (start: number, length: number): void => {
    for (let mid = start + 1; mid < start + length; mid++) for (let left = mid; left > start && cmp(left - 1, left) > 0; left--) swap(left, left - 1);
  };
  function sort(start: number, length: number): void {
    while (true) {
      if (length < 7) { insertion(start, length); return; }
      let mid = start + Math.trunc(length / 2);
      if (length > 7) {
        let left = start, end = start + length - 1;
        if (length > 40) {
          const distance = Math.trunc(length / 8);
          left = median(left, left + distance, left + 2 * distance); mid = median(mid - distance, mid, mid + distance);
          end = median(end - 2 * distance, end - distance, end);
        }
        mid = median(left, mid, end);
      }
      swap(start, mid); let a = start + 1, b = a, c = start + length - 1, d = c, swapped = false;
      while (true) {
        while (b <= c) { const result = cmp(b, start); if (result > 0) break; if (result === 0) { swapped = true; swap(a, b); a++; } b++; }
        while (b <= c) { const result = cmp(c, start); if (result < 0) break; if (result === 0) { swapped = true; swap(c, d); d--; } c--; }
        if (b > c) break;
        swap(b, c); swapped = true; b++; c--;
      }
      if (!swapped) { insertion(start, length); return; }
      const end = start + length;
      let range = Math.min(a - start, b - a); swapRange(start, b - range, range);
      range = Math.min(d - c, end - d - 1); swapRange(b, end - range, range);
      if (b - a > 1) sort(start, b - a);
      range = d - c; if (range <= 1) return; start = end - range; length = range;
    }
  }
  sort(0, count);
}

class StartRecord {
  readonly menu = new BaseMenu(); readonly banner = banner(); readonly framel = bitmap(); readonly framer = bitmap(); readonly gametype = spin();
  readonly mappics = Array.from({ length: 4 }, bitmap); readonly mapbuttons = Array.from({ length: 4 }, bitmap);
  readonly arrows = bitmap(); readonly prevpage = bitmap(); readonly nextpage = bitmap(); readonly back = bitmap(); readonly next = bitmap();
  readonly mapname: MenuProportional = { kind: "proportional", common: new MenuCommon(), text: null, style: 0, color: COLORS.black };
  readonly itemNull = bitmap(); readonly maplist = new Array<string>(64).fill(""); readonly mapGamebits = new Array<number>(64).fill(0);
  multiplayer = false; currentmap = 0; nummaps = 0; page = 0; maxpages = 0;
  reset(): void {
    resetMenu(this.menu);
    for (const item of [this.banner, this.framel, this.framer, this.gametype, ...this.mappics, ...this.mapbuttons, this.arrows, this.prevpage, this.nextpage, this.back, this.next, this.mapname, this.itemNull]) resetItem(item);
    this.maplist.fill(""); this.mapGamebits.fill(0); this.multiplayer = false; this.currentmap = 0; this.nummaps = 0; this.page = 0; this.maxpages = 0;
  }
}
class OptionsRecord {
  readonly menu = new BaseMenu(); readonly banner = banner(); readonly mappic = bitmap(); readonly picframe = bitmap();
  readonly dedicated = spin(); readonly timelimit = field(); readonly fraglimit = field(); readonly flaglimit = field(); readonly friendlyfire = radio();
  readonly hostname = field(); readonly pure = radio(); readonly botSkill = spin(); readonly player0 = text();
  readonly playerType = Array.from({ length: 12 }, spin); readonly playerName = Array.from({ length: 12 }, text); readonly playerTeam = Array.from({ length: 12 }, spin);
  readonly go = bitmap(); readonly next = bitmap(); readonly back = bitmap(); readonly punkbuster = spin();
  readonly names = new Array<string>(12).fill(""); multiplayer = false; gametype = 0; mapname = ""; newBot = false; newBotIndex = 0; newBotName = "";
  writeName(n: number, name: string): void {
    itemAt(this.names, n); this.names[n] = sourceCommandText(name).slice(0, 15);
    const item = itemAt(this.playerName, n); if (item.text !== null) item.text = itemAt(this.names, n);
  }
  reset(): void {
    resetMenu(this.menu);
    for (const item of [this.banner, this.mappic, this.picframe, this.dedicated, this.timelimit, this.fraglimit, this.flaglimit, this.friendlyfire, this.hostname, this.pure, this.botSkill, this.player0,
      ...this.playerType, ...this.playerName, ...this.playerTeam, this.go, this.next, this.back, this.punkbuster]) resetItem(item);
    this.names.fill(""); this.multiplayer = false; this.gametype = 0; this.mapname = ""; this.newBot = false; this.newBotIndex = 0; this.newBotName = "";
  }
}
class BotRecord {
  readonly menu = new BaseMenu(); readonly banner = banner(); readonly pics = Array.from({ length: 16 }, bitmap);
  readonly buttons = Array.from({ length: 16 }, bitmap); readonly picnames = Array.from({ length: 16 }, text);
  readonly arrows = bitmap(); readonly left = bitmap(); readonly right = bitmap(); readonly go = bitmap(); readonly back = bitmap();
  readonly sorted = new Array<number>(1024).fill(0); readonly icons = new Array<string>(16).fill(""); readonly names = new Array<string>(16).fill("");
  numBots = 0; page = 0; numpages = 0; selected = 0;
  writeIcon(n: number, icon: string): void {
    itemAt(this.icons, n); this.icons[n] = sourceCommandText(icon).slice(0, 63);
    const pic = itemAt(this.pics, n); if (pic.common.name !== null) pic.common.name = itemAt(this.icons, n);
  }
  writeName(n: number, name: string): void { itemAt(this.names, n); this.names[n] = name; const item = itemAt(this.picnames, n); if (item.text !== null) item.text = name; }
  reset(): void {
    resetMenu(this.menu);
    for (const item of [this.banner, ...this.pics, ...this.buttons, ...this.picnames, this.arrows, this.left, this.right, this.go, this.back]) resetItem(item);
    this.sorted.fill(0); this.icons.fill(""); this.names.fill(""); this.numBots = 0; this.page = 0; this.numpages = 0; this.selected = 0;
  }
}

export class BaseStartServerMenu {
  private readonly start = new StartRecord(); private readonly options = new OptionsRecord(); private readonly bots = new BotRecord();
  private mapNameBuffer = "";
  constructor(readonly state: BaseUiState, private readonly gameInfo: BaseUiGameInfo) {}
  get menu(): BaseMenu { return this.start.menu; }
  private value(name: string): number { this.state.assertActive(); return this.state.services.cvars.registry.get(name)?.numericValue ?? 0; }
  private string(name: string): string { this.state.assertActive(); return sourceCommandText(this.state.services.cvars.registry.get(name)?.value ?? "").slice(0, 1023); }
  private set(name: string, value: string): void { this.state.assertActive(); this.state.services.cvars.registry.set(name, value, true); }
  private setValue(name: string, value: number): void {
    value = Math.fround(value); const integer = qvmFloatToInt(value);
    if (value === integer) { this.set(name, String(integer)); return; }
    const scaled = Math.abs(value) * 1_000_000, lower = Math.floor(scaled), fraction = scaled - lower;
    const rounded = fraction > .5 || (fraction === .5 && lower % 2 !== 0) ? lower + 1 : lower;
    this.set(name, `${value < 0 ? "-" : ""}${Math.trunc(rounded / 1_000_000)}.${String(rounded % 1_000_000).padStart(6, "0")}`);
  }
  private append(text: string): void { this.state.assertActive(); this.state.services.consoleCommands.append(text); }
  private async register(name: string) {
    this.state.assertActive(); const shader = await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive(); return shader;
  }
  private async cacheNames(names: readonly string[]): Promise<void> { this.state.assertActive(); for (const name of names) { await this.register(name); this.state.assertActive(); } }
  private gameBits(value: string): number {
    const cursor = new CommonParseCursor(value); let bits = 0;
    while (true) {
      const token = this.state.sourceParser.parse(cursor, false); if (token.length === 0) return bits;
      for (const [name, bit] of [["ffa", 0], ["tourney", 1], ["single", 2], ["team", 3], ["ctf", 4]] satisfies [string, number][])
        if (compareNames(token, name) === 0) { bits |= 1 << bit; break; }
    }
  }
  private writeMap(index: number, info: string): void {
    const r = this.start;
    itemAt(r.maplist, index); r.maplist[index] = upper(infoValueForKey(info, "map").slice(0, 15));
    r.mapGamebits[index] = this.gameBits(infoValueForKey(info, "type"));
  }
  async cache(): Promise<void> {
    await this.cacheNames([BACK, BACK1, NEXT, NEXT1, FRAMEL, FRAMER, SELECT, SELECTED, UNKNOWN, ARROWS, LEFT, RIGHT]); this.state.assertActive();
    const precache = qvmFloatToInt(this.value("com_buildscript")), r = this.start;
    r.nummaps = this.gameInfo.getNumArenas();
    for (let i = 0; i < r.nummaps; i++) {
      this.writeMap(i, this.gameInfo.getArenaInfoByNumber(i) ?? "");
      if (precache !== 0) { await this.register(`levelshots/${itemAt(r.maplist, i)}`); this.state.assertActive(); }
    }
    r.maxpages = Math.trunc((r.nummaps + 3) / 4);
  }
  async cacheServerOptions(): Promise<void> { await this.cacheNames([BACK, BACK1, FIGHT, FIGHT1, SELECT, UNKNOWN]); this.state.assertActive(); }
  async cacheBotSelect(): Promise<void> { await this.cacheNames([BACK, BACK1, ACCEPT, ACCEPT1, BOT_SELECT, BOT_SELECTED, ARROWS, LEFT, RIGHT]); this.state.assertActive(); }

  private updateMaps(): void {
    const r = this.start, top = r.page * 4;
    for (let i = 0; i < 4; i++) {
      const pic = itemAt(r.mappics, i), button = itemAt(r.mapbuttons, i);
      pic.common.flags &= ~MenuFlag.Highlight; pic.shader = null;
      if (top + i < r.nummaps) { pic.common.name = `levelshots/${itemAt(r.maplist, top + i)}`; button.common.flags |= MenuFlag.PulseIfFocus; button.common.flags &= ~MenuFlag.Inactive; }
      else { pic.common.name = null; button.common.flags &= ~MenuFlag.PulseIfFocus; button.common.flags |= MenuFlag.Inactive; }
    }
    if (r.nummaps === 0) { r.next.common.flags |= MenuFlag.Inactive; r.mapname.text = "NO MAPS FOUND"; }
    else {
      r.next.common.flags &= ~MenuFlag.Inactive; const i = r.currentmap - top;
      if (i >= 0 && i < 4) { itemAt(r.mappics, i).common.flags |= MenuFlag.Highlight; itemAt(r.mapbuttons, i).common.flags &= ~MenuFlag.PulseIfFocus; }
      r.mapname.text = itemAt(r.maplist, r.currentmap);
    }
    r.mapname.text = upper(r.mapname.text); this.mapNameBuffer = r.mapname.text;
  }
  private readonly gametypeEvent: MenuCallback = async (_item, event) => {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return;
    const r = this.start, count = this.gameInfo.getNumArenas(); r.nummaps = 0;
    const type = itemAt(REMAP, r.gametype.curvalue); let match = 1 << type; if (type === 0) match |= 1 << 2;
    for (let n = 0; n < count; n++) {
      const info = this.gameInfo.getArenaInfoByNumber(n) ?? "", bits = this.gameBits(infoValueForKey(info, "type"));
      if ((bits & match) === 0) continue;
      itemAt(r.maplist, r.nummaps); r.maplist[r.nummaps] = upper(infoValueForKey(info, "map").slice(0, 15));
      r.mapGamebits[r.nummaps] = bits; r.nummaps++;
    }
    r.maxpages = Math.trunc((r.nummaps + 3) / 4); r.page = 0; r.currentmap = 0; this.updateMaps();
  };
  private readonly mapEvent: MenuCallback = async (item, event) => {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return;
    this.start.currentmap = this.start.page * 4 + item.common.id - Id.Pictures; this.updateMaps();
  };
  private readonly startEvent: MenuCallback = async (item, event) => {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return; const r = this.start;
    switch (item.common.id) {
      case Id.Prev: if (r.page > 0) { r.page--; this.updateMaps(); } return;
      case Id.NextPage: if (r.page < r.maxpages - 1) { r.page++; this.updateMaps(); } return;
      case Id.StartNext: this.setValue("g_gameType", itemAt(REMAP, r.gametype.curvalue)); await this.showOptions(r.multiplayer); this.state.assertActive(); return;
      case Id.StartBack: await popMenu(this.state); this.state.assertActive(); return;
    }
  };
  private async drawMap(item: BaseMenuItem): Promise<void> {
    this.state.assertActive(); if (item.kind !== "bitmap") throw new TypeError("StartServer_LevelshotDraw requires a bitmap");
    const c = item.common; if (c.name === null) return;
    if (item.shader === null) { item.shader = await this.register(c.name); if (item.shader === null && item.errorpic !== null) item.shader = await this.register(item.errorpic); }
    if (item.focuspic !== null && item.focusshader === null) item.focusshader = await this.register(item.focuspic);
    if (item.shader !== null) drawHandle(this.state, c.x, c.y, item.width, item.height, item.shader);
    fillRect(this.state, c.x, c.y + item.height, item.width, 28, COLORS.black);
    drawString(this.state, c.x + Math.trunc(item.width / 2), c.y + item.height + 4,
      itemAt(this.start.maplist, this.start.page * 4 + c.id - Id.Pictures), UI_CENTER | UI_SMALLFONT, ORANGE);
    if ((c.flags & MenuFlag.Highlight) !== 0) drawHandle(this.state, c.x, c.y, item.width, item.height + 28, item.focusshader);
  }
  async show(multiplayer: boolean): Promise<void> {
    this.state.assertActive(); const r = this.start; r.reset(); await this.cache(); this.state.assertActive();
    r.menu.wrapAround = true; r.menu.fullscreen = true; setBanner(r.banner, "GAME SERVER");
    setBitmap(r.framel, 0, 78, 256, 329, MenuFlag.Inactive, FRAMEL); setBitmap(r.framer, 376, 76, 256, 334, MenuFlag.Inactive, FRAMER);
    setSpin(r.gametype, 296, 368, "Game Type:", GAME_TYPES, PULSE_SMALL); r.gametype.common.id = Id.Gametype; r.gametype.common.callback = this.gametypeEvent;
    for (let i = 0; i < 4; i++) {
      const x = i % 2 * 136 + 188, y = Math.trunc(i / 2) * 136 + 96, pic = itemAt(r.mappics, i), button = itemAt(r.mapbuttons, i);
      setBitmap(pic, x, y, 128, 96, MenuFlag.LeftJustify | MenuFlag.Inactive, null, SELECTED);
      pic.common.id = Id.Pictures + i; pic.errorpic = UNKNOWN; pic.common.ownerdraw = item => this.drawMap(item);
      setBitmap(button, x - 30, y - 32, 256, 248, PULSE_LEFT | MenuFlag.NoDefaultInit, null, SELECT);
      button.common.id = Id.Pictures + i; button.common.callback = this.mapEvent;
      button.common.left = x; button.common.top = y; button.common.right = x + 128; button.common.bottom = y + 128;
    }
    setBitmap(r.arrows, 260, 400, 128, 32, MenuFlag.Inactive, ARROWS);
    setBitmap(r.prevpage, 260, 400, 64, 32, PULSE_LEFT, null, LEFT); setBitmap(r.nextpage, 321, 400, 64, 32, PULSE_LEFT, null, RIGHT);
    setBitmap(r.back, 0, 416, 128, 64, PULSE_LEFT, BACK, BACK1); setBitmap(r.next, 640, 416, 128, 64, PULSE_RIGHT, NEXT, NEXT1);
    for (const [item, id] of [[r.prevpage, Id.Prev], [r.nextpage, Id.NextPage], [r.back, Id.StartBack], [r.next, Id.StartNext]] satisfies [MenuBitmap, Id][]) { item.common.id = id; item.common.callback = this.startEvent; }
    r.mapname.common.flags = MenuFlag.CenterJustify | MenuFlag.Inactive; r.mapname.common.x = 320; r.mapname.common.y = 440;
    r.mapname.text = this.mapNameBuffer; r.mapname.style = UI_CENTER; r.mapname.color = COLORS.normal;
    setBitmap(r.itemNull, 0, 0, 640, 480, MenuFlag.LeftJustify | MenuFlag.MouseOnly | MenuFlag.Silent);
    for (const item of [r.banner, r.framel, r.framer, r.gametype]) addItem(this.state, r.menu, item);
    for (let i = 0; i < 4; i++) { addItem(this.state, r.menu, itemAt(r.mappics, i)); addItem(this.state, r.menu, itemAt(r.mapbuttons, i)); }
    for (const item of [r.arrows, r.prevpage, r.nextpage, r.back, r.next, r.mapname, r.itemNull]) addItem(this.state, r.menu, item);
    await this.gametypeEvent(r.gametype, MenuEvent.Activated); this.state.assertActive(); r.multiplayer = multiplayer;
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }

  private initPlayers(): void {
    const r = this.options; for (const type of r.playerType) type.curvalue = r.multiplayer ? 0 : 1;
    if (r.multiplayer && r.gametype < 3) for (let n = 8; n < 12; n++) itemAt(r.playerType, n).curvalue = 2;
    if (r.dedicated.curvalue === 0) {
      itemAt(r.playerType, 0).common.flags |= MenuFlag.Inactive; itemAt(r.playerType, 0).curvalue = 0;
      r.writeName(0, clean(this.string("name").slice(0, 15)));
    }
    if (r.gametype >= 3) for (let n = 0; n < 12; n++) itemAt(r.playerTeam, n).curvalue = n < 6 ? 0 : 1;
    else for (const team of r.playerTeam) team.common.flags |= MenuFlag.Inactive | MenuFlag.Hidden;
  }
  private setPlayers(): void {
    const r = this.options; let start: number;
    if (r.dedicated.curvalue === 0) { r.player0.text = "Human"; itemAt(r.playerName, 0).common.flags &= ~MenuFlag.Hidden; start = 1; }
    else { r.player0.text = "Open"; start = 0; }
    for (let n = start; n < 12; n++) {
      const name = itemAt(r.playerName, n);
      if (itemAt(r.playerType, n).curvalue === 1) name.common.flags &= ~(MenuFlag.Inactive | MenuFlag.Hidden);
      else name.common.flags |= MenuFlag.Inactive | MenuFlag.Hidden;
    }
    if (r.gametype < 3) return;
    for (let n = start; n < 12; n++) {
      const team = itemAt(r.playerTeam, n);
      if (itemAt(r.playerType, n).curvalue === 2) team.common.flags |= MenuFlag.Inactive | MenuFlag.Hidden;
      else team.common.flags &= ~(MenuFlag.Inactive | MenuFlag.Hidden);
    }
  }
  private initBotNames(): void {
    const r = this.options;
    if (r.gametype >= 3) {
      r.writeName(1, "grunt"); r.writeName(2, "major");
      if (r.gametype === 3) r.writeName(3, "visor"); else itemAt(r.playerType, 3).curvalue = 2;
      itemAt(r.playerType, 4).curvalue = 2; itemAt(r.playerType, 5).curvalue = 2;
      r.writeName(6, "sarge"); r.writeName(7, "grunt"); r.writeName(8, "major");
      if (r.gametype === 3) r.writeName(9, "visor"); else itemAt(r.playerType, 9).curvalue = 2;
      itemAt(r.playerType, 10).curvalue = 2; itemAt(r.playerType, 11).curvalue = 2; return;
    }
    let count = 1;
    const bots = infoValueForKey(this.gameInfo.getArenaInfoByMap(r.mapname) ?? "", "bots").slice(0, 1023); let p = 0;
    while (p < bots.length && count < 12) {
      while (p < bots.length && bots.charAt(p) === " ") p++;
      const start = p; while (p < bots.length && bots.charAt(p) !== " ") p++;
      const bot = bots.slice(start, p); if (p < bots.length) p++;
      r.writeName(count, infoValueForKey(this.gameInfo.getBotInfoByName(bot) ?? "", "name")); count++;
    }
    for (let n = count; n < 12; n++) r.writeName(n, "--------");
    for (; count < 8; count++) itemAt(r.playerType, count).curvalue = 0;
    for (; count < 12; count++) if (itemAt(r.playerType, count).curvalue === 1) itemAt(r.playerType, count).curvalue = 2;
  }
  private setOptions(): void {
    const r = this.options;
    const limit = (item: MenuFieldItem, name: string, max: number): void => item.field.setText(String(qvmFloatToInt(clampCvar(0, max, this.value(name)))).slice(0, 3));
    switch (r.gametype) {
      case 1: limit(r.fraglimit, "ui_tourney_fraglimit", 999); limit(r.timelimit, "ui_tourney_timelimit", 999); break;
      case 3: limit(r.fraglimit, "ui_team_fraglimit", 999); limit(r.timelimit, "ui_team_timelimit", 999); r.friendlyfire.curvalue = qvmFloatToInt(clampCvar(0, 1, this.value("ui_team_friendly"))); break;
      case 4: limit(r.flaglimit, "ui_ctf_capturelimit", 100); limit(r.timelimit, "ui_ctf_timelimit", 999); r.friendlyfire.curvalue = qvmFloatToInt(clampCvar(0, 1, this.value("ui_ctf_friendly"))); break;
      default: limit(r.fraglimit, "ui_ffa_fraglimit", 999); limit(r.timelimit, "ui_ffa_timelimit", 999); break;
    }
    r.hostname.field.setText(this.string("sv_hostname").slice(0, 255)); r.pure.curvalue = qvmFloatToInt(clampCvar(0, 1, this.value("sv_pure")));
    r.mappic.common.name = `levelshots/${itemAt(this.start.maplist, this.start.currentmap)}`;
    const mapname = this.start.mapname.text; if (mapname === null) throw new Error("Undefined native Start Server map name");
    if (mapname.length >= 32) throw new RangeError("Server Options map name exceeds 32-byte source buffer");
    r.mapname = upper(mapname); this.initPlayers(); this.setPlayers(); this.initBotNames(); this.setPlayers();
  }
  private startServer(): void {
    const r = this.options, timelimit = gameAtoi(r.timelimit.field.text), fraglimit = gameAtoi(r.fraglimit.field.text), flaglimit = gameAtoi(r.flaglimit.field.text);
    const dedicated = r.dedicated.curvalue, friendlyfire = r.friendlyfire.curvalue, pure = r.pure.curvalue, skill = (r.botSkill.curvalue + 1) | 0;
    let maxclients = 0;
    for (let n = 0; n < 12; n++) {
      const type = itemAt(r.playerType, n).curvalue;
      if (type === 2 || (type === 1 && itemAt(r.names, n).length === 0)) continue; maxclients++;
    }
    const prefix = r.gametype === 1 ? "ui_tourney" : r.gametype === 3 ? "ui_team" : r.gametype === 4 ? "ui_ctf" : "ui_ffa";
    this.setValue(`${prefix}_fraglimit`, fraglimit); this.setValue(`${prefix}_timelimit`, timelimit);
    if (r.gametype === 3 || r.gametype === 4) this.setValue(`${prefix}_friendlt`, friendlyfire);
    this.setValue("sv_maxclients", clampCvar(0, 12, maxclients)); this.setValue("dedicated", clampCvar(0, 2, dedicated));
    this.setValue("timelimit", clampCvar(0, timelimit, timelimit)); this.setValue("fraglimit", clampCvar(0, fraglimit, fraglimit)); this.setValue("capturelimit", clampCvar(0, flaglimit, flaglimit));
    this.setValue("g_friendlyfire", friendlyfire); this.setValue("sv_pure", pure); this.set("sv_hostname", r.hostname.field.text); this.setValue("sv_punkbuster", r.punkbuster.curvalue);
    this.append(`wait ; wait ; map ${itemAt(this.start.maplist, this.start.currentmap)}\n`); this.append("wait 3\n");
    for (let n = 1; n < 12; n++) {
      const name = itemAt(r.names, n); if (itemAt(r.playerType, n).curvalue !== 1 || name.length === 0 || name.charAt(0) === "-") continue;
      this.append((r.gametype >= 3 ? `addbot ${name} ${skill} ${itemAt(TEAMS, itemAt(r.playerTeam, n).curvalue)}\n` : `addbot ${name} ${skill}\n`).slice(0, 63));
    }
    if (dedicated === 0 && r.gametype >= 3) this.append(`wait 5; team ${itemAt(TEAMS, itemAt(r.playerTeam, 0).curvalue)}\n`);
  }
  private readonly optionsEvent: MenuCallback = async (item, event) => {
    this.state.assertActive();
    switch (item.common.id) {
      case Id.PlayerType: if (event === MenuEvent.Activated) this.setPlayers(); return;
      case Id.MaxClients: case Id.Dedicated: this.setPlayers(); return;
      case Id.Go: if (event === MenuEvent.Activated) this.startServer(); return;
      case Id.Back: if (event === MenuEvent.Activated) { await popMenu(this.state); this.state.assertActive(); } return;
    }
  };
  private readonly playerEvent: MenuCallback = async (item, event) => {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return; this.options.newBotIndex = item.common.id;
    await this.showBots(itemAt(this.options.names, item.common.id)); this.state.assertActive();
  };
  private async statusBar(): Promise<void> { this.state.assertActive(); drawString(this.state, 320, 440, "0 = NO LIMIT", UI_CENTER | UI_SMALLFONT, COLORS.white); }
  private async drawOptionsMap(item: BaseMenuItem): Promise<void> {
    this.state.assertActive(); const r = this.options;
    if (r.newBot) { r.writeName(r.newBotIndex, r.newBotName); r.newBot = false; }
    if (item.kind !== "bitmap") throw new TypeError("ServerOptions_LevelshotDraw requires a bitmap");
    await drawBitmap(this.state, item); this.state.assertActive(); const c = item.common;
    fillRect(this.state, c.x, c.y + item.height, item.width, 40, COLORS.black);
    drawString(this.state, c.x + Math.trunc(item.width / 2), c.y + item.height + 4, r.mapname, UI_CENTER | UI_SMALLFONT, ORANGE);
    drawString(this.state, c.x + Math.trunc(item.width / 2), c.y + item.height + 20, itemAt(GAME_TYPES, itemAt(REMAP2, r.gametype)), UI_CENTER | UI_SMALLFONT, ORANGE);
  }
  private async drawPlayer(item: BaseMenuItem): Promise<void> {
    this.state.assertActive(); if (item.kind !== "text") throw new TypeError("PlayerName_Draw requires a text item");
    const c = item.common, focus = menuParent(item).cursor === c.menuPosition; let color = COLORS.normal, style = UI_SMALLFONT;
    if ((c.flags & MenuFlag.Grayed) !== 0) color = COLORS.disabled;
    else if (focus) { color = COLORS.highlight; style |= UI_PULSE; }
    else if ((c.flags & MenuFlag.Blink) !== 0) { color = COLORS.highlight; style |= UI_BLINK; }
    if (focus) { fillRect(this.state, c.left, c.top, c.right - c.left + 1, c.bottom - c.top + 1, COLORS.listbar); drawChar(this.state, c.x, c.y, 13, UI_CENTER | UI_BLINK | UI_SMALLFONT, color); }
    drawString(this.state, c.x - 8, c.y, c.name, style | UI_RIGHT, color); drawString(this.state, c.x + 8, c.y, item.text, style | UI_LEFT, color);
  }
  private async showOptions(multiplayer: boolean): Promise<void> {
    this.state.assertActive(); const r = this.options; r.reset(); r.multiplayer = multiplayer;
    r.gametype = qvmFloatToInt(clampCvar(0, 5, this.value("g_gameType"))); r.punkbuster.curvalue = qvmFloatToInt(clampCvar(0, 1, this.value("sv_punkbuster")));
    await this.cacheServerOptions(); this.state.assertActive(); r.menu.wrapAround = true; r.menu.fullscreen = true; setBanner(r.banner, "GAME SERVER");
    setBitmap(r.mappic, 352, 80, 160, 120, MenuFlag.LeftJustify | MenuFlag.Inactive); r.mappic.errorpic = UNKNOWN; r.mappic.common.ownerdraw = item => this.drawOptionsMap(item);
    setBitmap(r.picframe, 314, 40, 320, 320, MenuFlag.LeftJustify | MenuFlag.Inactive | MenuFlag.Highlight, null, SELECT);
    const limitField = (item: MenuFieldItem, name: string, y: number): void => {
      item.common.name = name; item.common.flags = MenuFlag.NumbersOnly | PULSE_SMALL; item.common.x = 456; item.common.y = y;
      item.common.statusbar = () => this.statusBar(); item.field.widthInChars = 3; item.field.maxchars = 3;
    };
    limitField(r.gametype === 4 ? r.flaglimit : r.fraglimit, r.gametype === 4 ? "Capture Limit:" : "Frag Limit:", 272);
    let y = 290; limitField(r.timelimit, "Time Limit:", y);
    if (r.gametype >= 3) { y += 18; r.friendlyfire.common.flags = PULSE_SMALL; r.friendlyfire.common.x = 456; r.friendlyfire.common.y = y; r.friendlyfire.common.name = "Friendly Fire:"; }
    y += 18; r.pure.common.flags = PULSE_SMALL; r.pure.common.x = 456; r.pure.common.y = y; r.pure.common.name = "Pure Server:";
    if (multiplayer) {
      y += 18; setSpin(r.dedicated, 456, y, "Dedicated:", DEDICATED, PULSE_SMALL); r.dedicated.common.id = Id.Dedicated; r.dedicated.common.callback = this.optionsEvent;
      y += 18; r.hostname.common.name = "Hostname:"; r.hostname.common.flags = MenuFlag.SmallFont; r.hostname.common.x = 456; r.hostname.common.y = y; r.hostname.field.widthInChars = 18; r.hostname.field.maxchars = 64;
    }
    y += 18; setSpin(r.punkbuster, 456, y, "Punkbuster:", PUNKBUSTER, PULSE_SMALL);
    setSpin(r.botSkill, 144, 80, "Bot Skill:  ", SKILLS, PULSE_SMALL); r.botSkill.curvalue = 1;
    r.player0.common.flags = MenuFlag.SmallFont; r.player0.common.x = 40; r.player0.common.y = 112; r.player0.color = ORANGE; r.player0.style = UI_LEFT | UI_SMALLFONT;
    for (let n = 0; n < 12; n++) {
      y = 112 + n * 20; const type = itemAt(r.playerType, n), name = itemAt(r.playerName, n), team = itemAt(r.playerTeam, n);
      setSpin(type, 32, y, null, PLAYER_TYPES, MenuFlag.SmallFont); type.common.id = Id.PlayerType; type.common.callback = this.optionsEvent;
      name.common.flags = MenuFlag.SmallFont; name.common.x = 96; name.common.y = y; name.common.callback = this.playerEvent; name.common.id = n; name.common.ownerdraw = item => this.drawPlayer(item);
      name.color = ORANGE; name.style = UI_SMALLFONT; name.text = itemAt(r.names, n); name.common.top = y; name.common.bottom = y + 16; name.common.left = 88; name.common.right = 224;
      setSpin(team, 240, y, null, TEAMS, MenuFlag.SmallFont);
    }
    setBitmap(r.back, 0, 416, 128, 64, PULSE_LEFT, BACK, BACK1);
    setBitmap(r.next, 640, 344, 128, 64, PULSE_RIGHT | MenuFlag.Inactive | MenuFlag.Grayed | MenuFlag.Hidden, NEXT, NEXT1); r.next.common.statusbar = () => this.statusBar();
    setBitmap(r.go, 640, 416, 128, 64, PULSE_RIGHT, FIGHT, FIGHT1);
    for (const [item, id] of [[r.back, Id.Back], [r.next, Id.StartNext], [r.go, Id.Go]] satisfies [MenuBitmap, Id][]) { item.common.id = id; item.common.callback = this.optionsEvent; }
    for (const item of [r.banner, r.mappic, r.picframe, r.botSkill, r.player0]) addItem(this.state, r.menu, item);
    for (let n = 0; n < 12; n++) { if (n !== 0) addItem(this.state, r.menu, itemAt(r.playerType, n)); addItem(this.state, r.menu, itemAt(r.playerName, n)); if (r.gametype >= 3) addItem(this.state, r.menu, itemAt(r.playerTeam, n)); }
    addItem(this.state, r.menu, r.gametype === 4 ? r.flaglimit : r.fraglimit); addItem(this.state, r.menu, r.timelimit);
    if (r.gametype >= 3) addItem(this.state, r.menu, r.friendlyfire); addItem(this.state, r.menu, r.pure);
    if (multiplayer) { addItem(this.state, r.menu, r.dedicated); addItem(this.state, r.menu, r.hostname); }
    for (const item of [r.back, r.next, r.go, r.punkbuster]) addItem(this.state, r.menu, item);
    this.setOptions(); await pushMenu(this.state, r.menu); this.state.assertActive();
  }

  private alreadySelected(name: string): boolean {
    const r = this.options;
    for (let n = 1; n < 12; n++) {
      if (itemAt(r.playerType, n).curvalue !== 1) continue;
      if (r.gametype >= 3 && itemAt(r.playerTeam, n).curvalue !== itemAt(r.playerTeam, r.newBotIndex).curvalue) continue;
      if (compareNames(name, itemAt(r.names, n)) === 0) return true;
    }
    return false;
  }
  private async playerIcon(modelAndSkin: string, n: number): Promise<void> {
    const value = modelAndSkin.slice(0, 63), slash = value.lastIndexOf("/"), model = slash < 0 ? value : value.slice(0, slash), skin = slash < 0 ? "default" : value.slice(slash + 1);
    const requested = `models/players/${model}/icon_${skin}.tga`;
    if (requested.length >= 64) { this.state.services.print(`Com_sprintf: overflow of ${requested.length} in 64\n`); this.state.assertActive(); }
    this.bots.writeIcon(n, requested);
    if (await this.register(itemAt(this.bots.icons, n)) === null && compareNames(skin, "default") !== 0) {
      const fallback = `models/players/${model}/icon_default.tga`;
      if (fallback.length >= 64) { this.state.services.print(`Com_sprintf: overflow of ${fallback.length} in 64\n`); this.state.assertActive(); }
      this.bots.writeIcon(n, fallback);
    }
  }
  private async updateBots(): Promise<void> {
    const r = this.bots;
    for (let i = 0, j = r.page * 16; i < 16; i++, j++) {
      const pic = itemAt(r.pics, i), button = itemAt(r.buttons, i);
      if (j < r.numBots) {
        const info = this.gameInfo.getBotInfoByNumber(itemAt(r.sorted, j)) ?? "";
        await this.playerIcon(infoValueForKey(info, "model"), i); this.state.assertActive();
        r.writeName(i, clean(infoValueForKey(info, "name").slice(0, 15))); pic.common.name = itemAt(r.icons, i);
        itemAt(r.picnames, i).color = this.alreadySelected(itemAt(r.names, i)) ? COLORS.red : ORANGE; button.common.flags &= ~MenuFlag.Inactive;
      } else { pic.common.name = null; button.common.flags |= MenuFlag.Inactive; r.writeName(i, ""); }
      pic.common.flags &= ~MenuFlag.Highlight; pic.shader = null; button.common.flags |= MenuFlag.PulseIfFocus;
    }
    const selected = r.selected % 16; itemAt(r.pics, selected).common.flags |= MenuFlag.Highlight; itemAt(r.buttons, selected).common.flags &= ~MenuFlag.PulseIfFocus;
    if (r.numpages > 1 && r.page > 0) r.left.common.flags &= ~MenuFlag.Inactive; else r.left.common.flags |= MenuFlag.Inactive;
    if (r.numpages > 1 && r.page < r.numpages - 1) r.right.common.flags &= ~MenuFlag.Inactive; else r.right.common.flags |= MenuFlag.Inactive;
  }
  private readonly botEvent: MenuCallback = async (item, event) => {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return; const r = this.bots;
    for (let n = 0; n < 16; n++) { itemAt(r.pics, n).common.flags &= ~MenuFlag.Highlight; itemAt(r.buttons, n).common.flags |= MenuFlag.PulseIfFocus; }
    itemAt(r.pics, item.common.id).common.flags |= MenuFlag.Highlight; itemAt(r.buttons, item.common.id).common.flags &= ~MenuFlag.PulseIfFocus; r.selected = r.page * 16 + item.common.id;
  };
  private async pageBots(direction: number, event: MenuEvent): Promise<void> {
    this.state.assertActive(); if (event !== MenuEvent.Activated) return; const r = this.bots;
    if ((direction < 0 && r.page > 0) || (direction > 0 && r.page < r.numpages - 1)) { r.page += direction; r.selected = r.page * 16; await this.updateBots(); this.state.assertActive(); }
  }
  private async showBots(bot: string): Promise<void> {
    this.state.assertActive(); const r = this.bots; r.reset(); r.menu.wrapAround = true; r.menu.fullscreen = true;
    await this.cacheBotSelect(); this.state.assertActive(); setBanner(r.banner, "SELECT BOT");
    for (let n = 0; n < 16; n++) {
      const x = 180 + n % 4 * 70, y = 80 + Math.trunc(n / 4) * 86, pic = itemAt(r.pics, n), button = itemAt(r.buttons, n), name = itemAt(r.picnames, n);
      setBitmap(pic, x, y, 64, 64, MenuFlag.LeftJustify | MenuFlag.Inactive, itemAt(r.icons, n), BOT_SELECTED); pic.focuscolor = COLORS.red;
      setBitmap(button, x - 16, y - 16, 128, 128, PULSE_LEFT | MenuFlag.NoDefaultInit, null, BOT_SELECT); button.common.callback = this.botEvent; button.common.id = n;
      button.common.left = x; button.common.top = y; button.common.right = x + 64; button.common.bottom = y + 64; button.focuscolor = COLORS.red;
      name.common.flags = MenuFlag.SmallFont; name.common.x = x + 32; name.common.y = y + 64; name.text = itemAt(r.names, n); name.color = ORANGE; name.style = UI_CENTER | UI_SMALLFONT;
    }
    setBitmap(r.arrows, 260, 440, 128, 32, MenuFlag.Inactive, ARROWS); setBitmap(r.left, 260, 440, 64, 32, PULSE_LEFT, null, LEFT); setBitmap(r.right, 321, 440, 64, 32, PULSE_LEFT, null, RIGHT);
    r.left.common.callback = (_item, event) => this.pageBots(-1, event); r.right.common.callback = (_item, event) => this.pageBots(1, event);
    setBitmap(r.back, 0, 416, 128, 64, PULSE_LEFT, BACK, BACK1); setBitmap(r.go, 640, 416, 128, 64, PULSE_RIGHT, ACCEPT, ACCEPT1);
    r.back.common.callback = async (_item, event) => { this.state.assertActive(); if (event === MenuEvent.Activated) { await popMenu(this.state); this.state.assertActive(); } };
    r.go.common.callback = async (_item, event) => {
      this.state.assertActive(); if (event !== MenuEvent.Activated) return;
      await popMenu(this.state); this.state.assertActive(); this.options.newBot = true; this.options.newBotName = itemAt(r.names, r.selected % 16).slice(0, 15);
    };
    addItem(this.state, r.menu, r.banner);
    for (let n = 0; n < 16; n++) { addItem(this.state, r.menu, itemAt(r.pics, n)); addItem(this.state, r.menu, itemAt(r.buttons, n)); addItem(this.state, r.menu, itemAt(r.picnames, n)); }
    for (const item of [r.arrows, r.left, r.right, r.back, r.go]) addItem(this.state, r.menu, item);
    r.page = 0; r.numBots = this.gameInfo.getNumBots(); r.numpages = Math.trunc(r.numBots / 16); if (r.numBots % 16 !== 0) r.numpages++;
    for (let n = 0; n < r.numBots; n++) { itemAt(r.sorted, n); r.sorted[n] = n; }
    sortBots(r.sorted, r.numBots, (a, b) => {
      const first = this.gameInfo.getBotInfoByNumber(a), second = this.gameInfo.getBotInfoByNumber(b);
      return compareNames(infoValueForKey(first ?? "", "name"), infoValueForKey(second ?? "", "name"));
    });
    let found = 0;
    for (; found < r.numBots; found++) if (compareNames(bot, infoValueForKey(this.gameInfo.getBotInfoByNumber(found) ?? "", "name")) === 0) break;
    r.selected = 0;
    if (found < r.numBots) for (let n = 0; n < r.numBots; n++) if (itemAt(r.sorted, n) === found) { r.selected = n; break; }
    r.page = Math.trunc(r.selected / 16); await this.updateBots(); this.state.assertActive(); await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
