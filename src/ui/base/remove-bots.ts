// Remove Bots from id Software q3_ui/ui_removebots.c and q_shared.c. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_LEFT, UI_SMALLFONT } from "../../render/font.ts";
import { addItem, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, itemAt, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional } from "./state.ts";

const BACKGROUND = "menu/art/addbotframe", BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const DELETE = "menu/art/delete_0", DELETE_FOCUS = "menu/art/delete_1";
const ARROWS = "menu/art/arrows_vert_0", UP = "menu/art/arrows_vert_top", DOWN = "menu/art/arrows_vert_bot";
enum Id { Up = 10, Down = 11, Delete = 12, Back = 13, Bot = 20 }

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null,
    focusshader: null, width: 0, height: 0, focuscolor: null };
}
function botName(info: string): string {
  const copied = infoValueForKey(info, "n").slice(0, 31);
  let result = "";
  for (let n = 0; n < copied.length; n++) {
    const code = copied.charCodeAt(n), next = copied.charAt(n + 1);
    if (code === 94 && next !== "" && next !== "^") n++;
    else if (code >= 32 && code <= 126) result += copied.charAt(n);
  }
  return result;
}
class RemoveBotsRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, style: 0, color: COLORS.black };
  readonly background = bitmap();
  readonly arrows = bitmap();
  readonly up = bitmap();
  readonly down = bitmap();
  readonly bots: MenuProportional[] = Array.from({ length: 7 }, () => ({
    kind: "proportional", common: new MenuCommon(), text: null, style: 0, color: COLORS.black,
  }));
  readonly delete = bitmap();
  readonly back = bitmap();
  readonly names = new Array<string>(7).fill("");
  readonly clientNumbers = new Array<number>(1024).fill(0);
  numBots = 0;
  baseBot = 0;
  selectedBot = 0;

  reset(): void {
    const menu = this.menu;
    menu.cursor = 0; menu.cursorPrev = 0; menu.itemCount = 0; menu.items.length = 0;
    menu.draw = null; menu.key = null; menu.fullscreen = false; menu.wrapAround = false; menu.showlogo = false;
    for (const item of [this.banner, ...this.bots]) {
      Object.assign(item.common, new MenuCommon()); item.text = null; item.style = 0; item.color = COLORS.black;
    }
    for (const item of [this.background, this.arrows, this.up, this.down, this.delete, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null;
      item.shader = null; item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    this.names.fill(""); this.clientNumbers.fill(0); this.numBots = 0; this.baseBot = 0; this.selectedBot = 0;
  }
}

export class BaseRemoveBotsMenu {
  private readonly record = new RemoveBotsRecord();
  private readonly botEvent: MenuCallback = async (item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const r = this.record;
    itemAt(r.bots, r.selectedBot).color = COLORS.normal;
    r.selectedBot = item.common.id - Id.Bot;
    itemAt(r.bots, r.selectedBot).color = COLORS.white;
  };
  private readonly deleteEvent: MenuCallback = async (_item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    const r = this.record, client = itemAt(r.clientNumbers, r.baseBot + r.selectedBot);
    this.state.services.consoleCommands.append(`clientkick ${client}\n`);
  };
  private readonly backEvent: MenuCallback = async (_item, event) => {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
  };
  constructor(readonly state: BaseUiState) {}
  get menu(): BaseMenu { return this.record.menu; }

  private configString(client: Pick<EngineClientSession, "getGameState">, index: number, previous: string): string {
    // CL_GetConfigString leaves the caller's buffer untouched for an invalid index.
    if (index < 0 || index >= 1024) return previous;
    const strings = client.getGameState(); this.state.assertActive();
    return sourceCommandText(itemAt(strings, index).slice(0, 1023));
  }
  private getBots(client: Pick<EngineClientSession, "getGameState">): void {
    const r = this.record;
    let info = this.configString(client, 0, "");
    const count = gameAtoi(infoValueForKey(info, "sv_maxclients"));
    r.numBots = 0;
    for (let n = 0; n < count; n++) {
      info = this.configString(client, 544 + n, info);
      if (gameAtoi(infoValueForKey(info, "skill")) === 0) continue;
      itemAt(r.clientNumbers, r.numBots);
      r.clientNumbers[r.numBots] = n; r.numBots++;
    }
  }
  private setBotNames(client: Pick<EngineClientSession, "getGameState">): void {
    const r = this.record;
    let info: string | null = null;
    for (let n = 0; n < 7 && r.baseBot + n < r.numBots; n++) {
      const index = 544 + itemAt(r.clientNumbers, r.baseBot + n);
      if (info === null && (index < 0 || index >= 1024))
        throw new RangeError("Remove Bots reached uninitialized configstring storage");
      info = this.configString(client, index, info === null ? "" : info);
      const name = botName(info); r.names[n] = name;
      const item = itemAt(r.bots, n);
      if (item.text !== null) item.text = name;
    }
  }
  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [BACKGROUND, BACK, BACK_FOCUS, DELETE, DELETE_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }
  async show(client: Pick<EngineClientSession, "getGameState">): Promise<void> {
    this.state.assertActive();
    const r = this.record; r.reset(); r.menu.fullscreen = false; r.menu.wrapAround = true;
    await this.cache(); this.state.assertActive();
    this.getBots(client); this.setBotNames(client);
    const upEvent: MenuCallback = async (_item, event) => {
      this.state.assertActive();
      if (event !== MenuEvent.Activated) return;
      if (r.baseBot > 0) { r.baseBot--; this.setBotNames(client); }
    };
    const downEvent: MenuCallback = async (_item, event) => {
      this.state.assertActive();
      if (event !== MenuEvent.Activated) return;
      if (r.baseBot + 7 < r.numBots) { r.baseBot++; this.setBotNames(client); }
    };
    const count = Math.min(r.numBots, 7);
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "REMOVE BOTS";
    r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.background.common.name = BACKGROUND; r.background.common.flags = MenuFlag.Inactive;
    r.background.common.x = 87; r.background.common.y = 74; r.background.width = 466; r.background.height = 332;
    r.arrows.common.name = ARROWS; r.arrows.common.flags = MenuFlag.Inactive;
    r.arrows.common.x = 200; r.arrows.common.y = 128; r.arrows.width = 64; r.arrows.height = 128;
    for (const [item, id, x, y, width, name, focus, callback] of [
      [r.up, Id.Up, 200, 128, 64, null, UP, upEvent],
      [r.down, Id.Down, 200, 192, 64, null, DOWN, downEvent],
      [r.delete, Id.Delete, 320, 320, 128, DELETE, DELETE_FOCUS, this.deleteEvent],
      [r.back, Id.Back, 192, 320, 128, BACK, BACK_FOCUS, this.backEvent],
    ] satisfies [MenuBitmap, Id, number, number, number, string | null, string, MenuCallback][]) {
      item.common.name = name; item.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
      item.common.id = id; item.common.callback = callback; item.common.x = x; item.common.y = y;
      item.width = width; item.height = 64; item.focuspic = focus;
    }
    for (let n = 0; n < count; n++) {
      const item = itemAt(r.bots, n);
      item.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus;
      item.common.id = Id.Bot + n; item.common.x = 264; item.common.y = 120 + 20 * n; item.common.callback = this.botEvent;
      item.text = itemAt(r.names, n); item.color = COLORS.normal; item.style = UI_LEFT | UI_SMALLFONT;
    }
    for (const item of [r.background, r.banner, r.arrows, r.up, r.down]) addItem(this.state, r.menu, item);
    for (let n = 0; n < count; n++) addItem(this.state, r.menu, itemAt(r.bots, n));
    addItem(this.state, r.menu, r.delete); addItem(this.state, r.menu, r.back);
    r.baseBot = 0; r.selectedBot = 0; itemAt(r.bots, 0).color = COLORS.white;
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }
}
