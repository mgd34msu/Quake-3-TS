// Team Orders from id Software q3_ui/ui_teamorders.c and Q_CleanStr in q_shared.c. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { KeyCode } from "../../core/key-codes.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { UI_CENTER, UI_LEFT, UI_PULSE, UI_SMALLFONT } from "../../render/font.ts";
import { cursorInRect, drawProportional } from "./draw.ts";
import { addItem, defaultKey, menuItemAtCursor, popMenu, pushMenu } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag, itemAt, menuParent, menuSound, nativeInt } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuItemDraw, MenuScroll, MenuSound } from "./state.ts";

type TeamOrdersClient = Pick<EngineClientSession, "getGameState" | "readSnapshotClientNumber">;
const FRAME = "menu/art/addbotframe", BACK = "menu/art/back_0", BACK_FOCUS = "menu/art/back_1";
const CTF_ORDERS = ["I Am the Leader", "Defend the Base", "Follow Me", "Get Enemy Flag", "Camp Here", "Report", "I Relinquish Command"];
const CTF_MESSAGES = ["i am the leader", "%s defend the base", "%s follow me", "%s get enemy flag", "%s camp here", "%s report", "i stop being the leader"];
const TEAM_ORDERS = ["I Am the Leader", "Follow Me", "Roam", "Camp Here", "Report", "I Relinquish Command"];
const TEAM_MESSAGES = ["i am the leader", "%s follow me", "%s roam", "%s camp here", "%s report", "i stop being the leader"];
enum ListId { Bots = 10, CtfOrders = 11, TeamOrders = 12 }

function bitmap(): MenuBitmap {
  return { kind: "bitmap", common: new MenuCommon(), focuspic: null, errorpic: null, shader: null, focusshader: null,
    width: 0, height: 0, focuscolor: null };
}
function cleanName(name: string): string {
  const copied = sourceCommandText(name.slice(0, 15));
  let clean = "";
  for (let index = 0; index < copied.length; index++) {
    const code = copied.charCodeAt(index), next = copied.charAt(index + 1);
    if (code === 94 && next !== "" && next !== "^") index++;
    else if (code >= 0x20 && code <= 0x7e) clean += copied.charAt(index);
  }
  return clean;
}
class TeamOrdersRecord {
  readonly menu = new BaseMenu();
  readonly banner: MenuBanner = { kind: "banner", common: new MenuCommon(), text: null, color: COLORS.white, style: 0 };
  readonly frame = bitmap();
  readonly list: MenuScroll = { kind: "scroll", common: new MenuCommon(), oldvalue: 0, curvalue: 0, numitems: 0,
    top: 0, itemnames: [], width: 0, height: 0, columns: 0, separation: 0 };
  readonly back = bitmap();
  readonly botNames: string[] = new Array<string>(9).fill("");
  gametype = 0;
  numBots = 0;
  selectedBot = 0;

  reset(): void {
    this.menu.cursor = 0; this.menu.cursorPrev = 0; this.menu.itemCount = 0; this.menu.items.length = 0;
    this.menu.draw = null; this.menu.key = null; this.menu.wrapAround = false; this.menu.fullscreen = false; this.menu.showlogo = false;
    Object.assign(this.banner.common, new MenuCommon()); this.banner.text = null; this.banner.color = COLORS.white; this.banner.style = 0;
    for (const item of [this.frame, this.back]) {
      Object.assign(item.common, new MenuCommon()); item.focuspic = null; item.errorpic = null; item.shader = null;
      item.focusshader = null; item.width = 0; item.height = 0; item.focuscolor = null;
    }
    const list = this.list; Object.assign(list.common, new MenuCommon());
    list.oldvalue = 0; list.curvalue = 0; list.numitems = 0; list.top = 0; list.itemnames = [];
    list.width = 0; list.height = 0; list.columns = 0; list.separation = 0;
    this.botNames.fill(""); this.gametype = 0; this.numBots = 0; this.selectedBot = 0;
  }
}

export class BaseTeamOrdersMenu {
  private readonly record = new TeamOrdersRecord();
  private readonly listCallback: MenuCallback = (item, event) => this.listEvent(item, event);
  private readonly backCallback: MenuCallback = (_item, event) => this.backEvent(event);
  private readonly listDrawCallback: MenuItemDraw = item => this.listDraw(item);
  private readonly keyCallback = (key: number) => this.key(key);
  constructor(readonly state: BaseUiState) {}
  get menu(): BaseMenu { return this.record.menu; }

  private configString(client: TeamOrdersClient, index: number, previous: string): string {
    if (index < 0 || index >= 1024) return previous;
    const strings = client.getGameState(); this.state.assertActive();
    return sourceCommandText(itemAt(strings, index).slice(0, 1023));
  }

  private async backEvent(event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    await popMenu(this.state); this.state.assertActive();
  }

  private setList(id: number): void {
    const r = this.record, list = r.list;
    list.common.id = id;
    switch (id) {
      case ListId.CtfOrders: list.numitems = 7; list.itemnames = CTF_ORDERS; break;
      case ListId.TeamOrders: list.numitems = 6; list.itemnames = TEAM_ORDERS; break;
      default: list.numitems = r.numBots; list.itemnames = r.botNames; break;
    }
    list.common.bottom = list.common.top + list.numitems * 27;
  }

  private async key(key: number): Promise<MenuSound> {
    this.state.assertActive();
    const r = this.record, list = r.list;
    if (menuItemAtCursor(r.menu) !== list) return await defaultKey(this.state, r.menu, key);
    switch (key) {
      case KeyCode.Mouse1: {
        const c = list.common;
        if (cursorInRect(this.state, c.left, c.top, c.right - c.left, c.bottom - c.top)) {
          list.oldvalue = list.curvalue; list.curvalue = nativeInt((this.state.cursorY - c.top) / 27);
          if (c.callback !== null) {
            await c.callback(list, MenuEvent.Activated); this.state.assertActive();
            return menuSound(this.state.media.move);
          }
        }
        return this.state.media.nullSound;
      }
      case KeyCode.Up:
      case KeyCode.KeypadUp:
        list.oldvalue = list.curvalue; list.curvalue = list.curvalue === 0 ? list.numitems - 1 : list.curvalue - 1;
        return menuSound(this.state.media.move);
      case KeyCode.Down:
      case KeyCode.KeypadDown:
        list.oldvalue = list.curvalue; list.curvalue = list.curvalue === list.numitems - 1 ? 0 : list.curvalue + 1;
        return menuSound(this.state.media.move);
      default: return await defaultKey(this.state, r.menu, key);
    }
  }

  private async listDraw(item: BaseMenuItem): Promise<void> {
    this.state.assertActive();
    if (item.kind !== "scroll") throw new RangeError("Undefined native Team Orders list draw");
    const focused = menuParent(item).cursor === item.common.menuPosition;
    for (let index = 0, y = item.common.y; index < item.numitems; index++, y += 27) {
      const selected = index === item.curvalue;
      drawProportional(this.state, 320, y, itemAt(item.itemnames, index), UI_LEFT | UI_SMALLFONT | UI_CENTER | (selected && focused ? UI_PULSE : 0),
        selected ? COLORS.highlight : COLORS.normal);
    }
  }

  private async listEvent(item: BaseMenuItem, event: MenuEvent): Promise<void> {
    this.state.assertActive();
    if (event !== MenuEvent.Activated) return;
    if (item.kind !== "scroll") throw new RangeError("Undefined native Team Orders list event");
    const r = this.record, selection = item.curvalue;
    if (item.common.id === ListId.Bots) {
      r.selectedBot = selection; this.setList(r.gametype === 4 ? ListId.CtfOrders : ListId.TeamOrders); return;
    }
    const format = (item.common.id === ListId.CtfOrders ? CTF_MESSAGES : TEAM_MESSAGES)[selection];
    if (format === undefined) throw new RangeError(`Undefined native Team Orders message format ${selection}`);
    const message = format.includes("%s") ? format.replace("%s", () => itemAt(r.botNames, r.selectedBot)) : format;
    this.state.services.consoleCommands.append(`say_team "${message}"\n`);
    await popMenu(this.state); this.state.assertActive();
  }

  private buildBotList(client: TeamOrdersClient): void {
    const r = this.record; r.list.itemnames = r.botNames;
    const clientNumber = client.readSnapshotClientNumber(); this.state.assertActive();
    r.botNames[0] = "Everyone"; r.numBots = 1;
    let info = this.configString(client, 0, "");
    const players = gameAtoi(infoValueForKey(info, "sv_maxclients"));
    r.gametype = gameAtoi(infoValueForKey(info, "g_gametype"));
    for (let n = 0; n < players && r.numBots < 9; n++) {
      info = this.configString(client, 544 + n, info);
      // Source resets playerTeam to numeric TEAM_SPECTATOR on every iteration.
      if (n === clientNumber) { infoValueForKey(info, "t"); continue; }
      if (gameAtoi(infoValueForKey(info, "skill")) === 0) continue;
      if (infoValueForKey(info, "t").charCodeAt(0) !== 3) continue;
      r.botNames[r.numBots] = cleanName(infoValueForKey(info, "n")); r.numBots++;
    }
  }

  async cache(): Promise<void> {
    this.state.assertActive();
    for (const name of [FRAME, BACK, BACK_FOCUS]) {
      await this.state.services.resources.registerShaderNoMip(name); this.state.assertActive();
    }
  }

  async show(client: TeamOrdersClient): Promise<void> {
    this.state.assertActive();
    await this.cache(); this.state.assertActive();
    const r = this.record; r.reset(); r.menu.key = this.keyCallback;
    this.buildBotList(client);
    r.banner.common.x = 320; r.banner.common.y = 16; r.banner.text = "TEAM ORDERS"; r.banner.color = COLORS.white; r.banner.style = UI_CENTER;
    r.frame.common.flags = MenuFlag.Inactive; r.frame.common.name = FRAME;
    r.frame.common.x = 87; r.frame.common.y = 74; r.frame.width = 466; r.frame.height = 332;
    r.list.common.flags = MenuFlag.PulseIfFocus; r.list.common.ownerdraw = this.listDrawCallback; r.list.common.callback = this.listCallback;
    r.list.common.x = 256; r.list.common.y = 120;
    r.back.common.name = BACK; r.back.common.flags = MenuFlag.LeftJustify | MenuFlag.PulseIfFocus; r.back.common.callback = this.backCallback;
    r.back.common.x = 0; r.back.common.y = 416; r.back.width = 128; r.back.height = 64; r.back.focuspic = BACK_FOCUS;
    for (const item of [r.banner, r.frame, r.list, r.back]) addItem(this.state, r.menu, item);
    r.list.common.left = 220; r.list.common.top = r.list.common.y; r.list.common.right = 420; this.setList(ListId.Bots);
    await pushMenu(this.state, r.menu); this.state.assertActive();
  }

  async showFromCommand(client: TeamOrdersClient): Promise<void> {
    this.state.assertActive();
    let info = this.configString(client, 0, "");
    this.record.gametype = gameAtoi(infoValueForKey(info, "g_gametype"));
    if (this.record.gametype < 3) return;
    const clientNumber = client.readSnapshotClientNumber(); this.state.assertActive();
    info = this.configString(client, 544 + clientNumber, info);
    if (gameAtoi(infoValueForKey(info, "t")) === 3) return;
    await this.show(client); this.state.assertActive();
  }
}
