// Add Bots from id Software q3_ui/ui_addbots.c and q_shared.c. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_LEFT, UI_SMALLFONT } from "../../render/font.ts";
import { clampCvar, drawBanner, drawNamed } from "./draw.ts";
import { addItem, drawMenu, popMenu, pushMenu } from "./framework.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBitmap, MenuCallback, MenuProportional, MenuSpin } from "./state.ts";

const BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const GO = "menu/art/accept_0", GO_FOCUS = "menu/art/accept_1", BACKGROUND = "menu/art/addbotframe";
const ARROWS = "menu/art/arrows_vert_0", UP = "menu/art/arrows_vert_top", DOWN = "menu/art/arrows_vert_bot";
const SKILLS = ["I Can Win", "Bring It On", "Hurt Me Plenty", "Hardcore", "Nightmare!"];
const FREE_TEAM = ["Free"], TEAMS = ["Red", "Blue"];
enum Id { Back = 10, Go = 11, Up = 13, Down = 14, Skill = 15, Team = 16, Bot = 20 }

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function spin(): MenuSpin {
  return { kind: "spin", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0, top: 0,
    itemnames: [], width: 0, height: 0, columns: 0, separation: 0 };
}
function compareNames(first: string, second: string): number {
  for (let index = 0; ; index++) {
    let a = index < first.length ? first.charCodeAt(index) : 0;
    let b = index < second.length ? second.charCodeAt(index) : 0;
    if (a >= 128) a -= 256;
    if (b >= 128) b -= 256;
    if (a !== b) {
      if (a >= 97 && a <= 122) a -= 32;
      if (b >= 97 && b <= 122) b -= 32;
      if (a !== b) return a < b ? -1 : 1;
    }
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
  const cmp = (first: number, second: number): number => compare(itemAt(values, first), itemAt(values, second));
  const swap = (first: number, second: number): void => {
    const value = itemAt(values, first); values[first] = itemAt(values, second); values[second] = value;
  };
  const swapRange = (first: number, second: number, length: number): void => {
    for (let index = 0; index < length; index++) swap(first + index, second + index);
  };
  const median = (a: number, b: number, c: number): number => cmp(a, b) < 0
    ? cmp(b, c) < 0 ? b : cmp(a, c) < 0 ? c : a
    : cmp(b, c) > 0 ? b : cmp(a, c) < 0 ? a : c;
  const insertion = (start: number, length: number): void => {
    for (let mid = start + 1; mid < start + length; mid++)
      for (let left = mid; left > start && cmp(left - 1, left) > 0; left--) swap(left, left - 1);
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

class AddBotsRecord {
  readonly menu = new BaseMenu();
  readonly arrows = bitmap();
  readonly up = bitmap();
  readonly down = bitmap();
  readonly bots: MenuProportional[] = Array.from({ length: 7 }, () => ({
    kind: "proportional", common: new MenuCommon(), text: null, style: 0, color: COLORS.black,
  }));
  readonly skill = spin();
  readonly team = spin();
  readonly go = bitmap();
  readonly back = bitmap();
  readonly sortedBotNums = new Array<number>(1024).fill(0);
  readonly botnames = new Array<string>(7).fill("");
  numBots = 0;
  delay = 0;
  baseBotNum = 0;
  selectedBotNum = 0;

  reset(): void {
    const menu = this.menu;
    menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
    menu.draw = null; menu.key = null; menu.wrapAround = false; menu.fullscreen = false; menu.showlogo = false;
    for (const item of [this.arrows, this.up, this.down, this.go, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    for (const bot of this.bots) {
      Object.assign(bot.common, new MenuCommon()); bot.text = null; bot.style = 0; bot.color = COLORS.black;
    }
    for (const item of [this.skill, this.team]) {
      Object.assign(item.common, new MenuCommon()); item.oldvalue = 0; item.curvalue = 0; item.numitems = 0;
      item.top = 0; item.itemnames = []; item.width = 0; item.height = 0; item.columns = 0; item.separation = 0;
    }
    this.sortedBotNums.fill(0); this.botnames.fill("");
    this.numBots = 0; this.delay = 0; this.baseBotNum = 0; this.selectedBotNum = 0;
  }
}

export class BaseAddBotsMenu {
  private readonly record = new AddBotsRecord();
  private readonly eventCallback: MenuCallback = (item, event) => this.event(item, event);
  private readonly drawCallback = () => this.draw();
  constructor(readonly state: BaseUiState, private readonly gameInfo: BaseUiGameInfo) {}
  get menu(): BaseMenu { return this.record.menu; }

  private async event(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const r = this.record;
    switch (item.common.id) {
      case Id.Back: await popMenu(this.state); this.state.assertActive(); return;
      case Id.Go: {
        const team = itemAt(r.team.itemnames, r.team.curvalue), skill = (r.skill.curvalue + 1) | 0;
        this.state.services.consoleCommands.append(`addbot ${itemAt(r.botnames, r.selectedBotNum)} ${skill} ${team} ${r.delay}\n`);
        r.delay = (r.delay + 1500) | 0;
        return;
      }
      case Id.Up:
        if (r.baseBotNum > 0) { r.baseBotNum--; this.setBotNames(); }
        return;
      case Id.Down:
        if (r.baseBotNum + 7 < r.numBots) { r.baseBotNum++; this.setBotNames(); }
        return;
      default:
        itemAt(r.bots, r.selectedBotNum).color = COLORS.normal;
        r.selectedBotNum = item.common.id - Id.Bot;
        itemAt(r.bots, r.selectedBotNum).color = COLORS.white;
    }
  }

  private setBotNames(): void {
    const r = this.record;
    for (let n = 0; n < 7; n++) {
      const info = this.gameInfo.getBotInfoByNumber(itemAt(r.sortedBotNums, r.baseBotNum + n));
      const name = sourceCommandText(infoValueForKey(info ?? "", "name").slice(0, 31));
      r.botnames[n] = name;
      const bot = itemAt(r.bots, n);
      if (bot.text !== null) bot.text = name;
    }
  }

  private async draw(): Promise<void> {
    this.state.assertActive();
    drawBanner(this.state, 320, 16, "ADD BOTS", UI_CENTER, COLORS.white);
    await drawNamed(this.state, 87, 74, 466, 332, BACKGROUND); this.state.assertActive();
    await drawMenu(this.state, this.record.menu); this.state.assertActive();
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [BACK, BACK_FOCUS, GO, GO_FOCUS, BACKGROUND, ARROWS, UP, DOWN]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }

  async show(client: Pick<EngineClientSession, "getGameState">): Promise<void> {
    this.state.assertActive();
    const strings = client.getGameState(); this.state.assertActive();
    const info = sourceCommandText(itemAt(strings, 0).slice(0, 1023));
    const gametype = gameAtoi(infoValueForKey(info, "g_gametype")), r = this.record;
    r.reset(); r.menu.draw = this.drawCallback; r.menu.wrapAround = true; r.delay = 1000;
    await this.cache(); this.state.assertActive();
    r.numBots = this.gameInfo.getNumBots();
    const count = r.numBots < 7 ? r.numBots : 7;
    r.arrows.common.name = ARROWS; r.arrows.common.flags = MenuFlag.Inactive;
    r.arrows.common.x = 200; r.arrows.common.y = 128; r.arrows.width = 64; r.arrows.height = 128;
    for (const [item, id, y, focus] of [
      [r.up, Id.Up, 128, UP], [r.down, Id.Down, 192, DOWN],
    ] satisfies [MenuBitmap, Id, number, string][]) {
      item.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus; item.common.id = id;
      item.common.x = 200; item.common.y = y; item.common.callback = this.eventCallback;
      item.width = 64; item.height = 64; item.focuspic = focus;
    }
    let y = 120;
    for (let n = 0; n < count; n++, y += 20) {
      const bot = itemAt(r.bots, n);
      bot.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus; bot.common.id = Id.Bot + n;
      bot.common.x = 264; bot.common.y = y; bot.common.callback = this.eventCallback;
      bot.text = itemAt(r.botnames, n); bot.color = COLORS.normal; bot.style = UI_LEFT | UI_SMALLFONT;
    }
    y += 12;
    r.skill.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
    r.skill.common.x = 320; r.skill.common.y = y; r.skill.common.name = "Skill:"; r.skill.common.id = Id.Skill;
    r.skill.itemnames = SKILLS;
    const skill = qvmFloatToInt(this.state.services.cvars.registry.get("g_spSkill")?.numericValue ?? 0);
    r.skill.curvalue = qvmFloatToInt(clampCvar(0, 4, (skill - 1) | 0));
    y += 16;
    r.team.common.flags = MenuFlag.PulseIfFocus | MenuFlag.SmallFont;
    r.team.common.x = 320; r.team.common.y = y; r.team.common.name = "Team: "; r.team.common.id = Id.Team;
    if (gametype >= 3) r.team.itemnames = TEAMS;
    else { r.team.itemnames = FREE_TEAM; r.team.common.flags = MenuFlag.Grayed; }
    for (const [item, id, x, name, focus] of [
      [r.go, Id.Go, 320, GO, GO_FOCUS], [r.back, Id.Back, 192, BACK, BACK_FOCUS],
    ] satisfies [MenuBitmap, Id, number, string, string][]) {
      item.common.name = name; item.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
      item.common.id = id; item.common.callback = this.eventCallback; item.common.x = x; item.common.y = 320;
      item.width = 128; item.height = 64; item.focuspic = focus;
    }
    r.baseBotNum = 0; r.selectedBotNum = 0; itemAt(r.bots, 0).color = COLORS.white;
    for (let n = 0; n < r.numBots; n++) {
      itemAt(r.sortedBotNums, n); r.sortedBotNums[n] = n;
    }
    sortBots(r.sortedBotNums, r.numBots, (a, b) => {
      const first = this.gameInfo.getBotInfoByNumber(a), second = this.gameInfo.getBotInfoByNumber(b);
      return compareNames(infoValueForKey(first ?? "", "name"), infoValueForKey(second ?? "", "name"));
    });
    this.setBotNames();
    for (const item of [r.arrows, r.up, r.down]) addItem(this.state, r.menu, item);
    for (let n = 0; n < count; n++) addItem(this.state, r.menu, itemAt(r.bots, n));
    for (const item of [r.skill, r.team, r.go, r.back]) addItem(this.state, r.menu, item);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
